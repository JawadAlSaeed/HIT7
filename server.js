const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const cors = require('cors');
const {
  createDeck,
  reshuffleFromDiscard: reshuffleDeck,
  isDeckMode,
  isSwappableSpecial,
  DEFAULT_DECK_MODE
} = require('./lib/deck');
const {
  PERSONALITY_KEYS,
  personality: botPersonality,
  decideMove: decideBotMove,
  thinkDelay: botThinkDelay
} = require('./lib/bot');
const {
  DEFAULT_PAUSE_GRACE_MS,
  isMissing: playerIsMissing,
  isGamePaused
} = require('./lib/presence');
// The rules themselves. Everything that decides who wins lives in here, so it can be
// tested without standing up a socket server. See lib/rules.js.
const {
  MAX_REGULAR_CARDS,
  MAX_PLAYERS,
  MAX_NAME_LENGTH,
  DEFAULT_WINNING_SCORE,
  WIN_SCORE_OPTIONS,
  TARGETING_CARDS,
  isValidCard,
  sanitizeName,
  removeOneCard,
  countSwappableCards,
  sortDeckForDisplay,
  updatePlayerScore,
  applyNumberCard,
  resolveSwapDuplicate,
  advanceTurn,
  removePlayerAt,
  eligibleTargets,
  removeCardRefusal,
  stealCardRefusal,
  isRoundOver,
  allBusted: everyoneBusted,
  bankRoundScores,
  decideRoundEnd,
  discardAllHands,
  resetPlayersForRound
} = require('./lib/rules');
// Seats, and who is allowed to sit in one. See lib/seats.js.
const {
  isBot,
  humansIn,
  findByToken,
  namesMatch,
  findDisconnectedSeatByName,
  actingHost,
  lobbyJoinRefusal,
  nameRefusal,
  wantedBotCount,
  pickBotName
} = require('./lib/seats');
require('dotenv').config();

const app = express();

// Origins allowed to talk to this server. Heroku serves the app from a
// *.herokuapp.com hostname that is not known ahead of time.
const allowedOrigins = ['https://hit7.click', 'http://localhost:3000'];
if (process.env.PRODUCTION_URL) allowedOrigins.push(process.env.PRODUCTION_URL);

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // same-origin or non-browser client
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).hostname.endsWith('.herokuapp.com');
  } catch (e) {
    return false;
  }
};

const createIoServer = (server) => {
  return new Server(server, {
    cors: {
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling']
  });
};

// Middleware
// Build allowed connect-src list (include ws/wss so Socket.IO can upgrade)
const allowedConnect = ["'self'", 'wss:'];
if (process.env.PRODUCTION_URL) {
  allowedConnect.push(process.env.PRODUCTION_URL);
  allowedConnect.push(process.env.PRODUCTION_URL.replace(/^http/, 'ws'));
} else {
  allowedConnect.push('http://localhost:3000', 'ws://localhost:3000');
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: allowedConnect
    }
  }
}));
app.use(cors());
app.use(express.static('public'));

// Game state
const games = new Map();
// The rest of the limits - hand size, table size, name length, the target score and
// what a host may set it to - live in lib/rules.js and are imported above.
const MAX_HISTORY_ENTRIES = 200;

// Everything the host picks in the lobby. Kept in one object so a rematch and a reset
// carry the choices over by spreading the game, without either having to list them.
const createSettings = () => ({
  deckMode: DEFAULT_DECK_MODE,
  winningScore: DEFAULT_WINNING_SCORE,
  // Bots are seats, not a mode. This is only ever the number the host asked for;
  // syncBotSeats is what makes game.players actually agree with it.
  botCount: 0
});

// Settings arrive from a client, so nothing here trusts them: anything unrecognised
// falls back to the current value rather than being rejected, because a host fumbling
// a setting should not be an error they have to read and dismiss.
const sanitizeSettings = (current, incoming) => {
  const settings = { ...createSettings(), ...current };
  if (!incoming || typeof incoming !== 'object') return settings;

  if (isDeckMode(incoming.deckMode)) settings.deckMode = incoming.deckMode;
  if (WIN_SCORE_OPTIONS.includes(incoming.winningScore)) {
    settings.winningScore = incoming.winningScore;
  }
  // A table has to have room for at least one person, so a host can never fill every
  // seat with bots. The real ceiling also depends on how many humans are already
  // sitting down, which only syncBotSeats can see.
  if (Number.isInteger(incoming.botCount)) {
    settings.botCount = Math.min(MAX_PLAYERS - 1, Math.max(0, incoming.botCount));
  }
  return settings;
};

// Games created before a setting existed, and any game object that has been through a
// spread, still have to answer these.
const settingsOf = game => ({ ...createSettings(), ...game.settings });
const deckModeOf = game => settingsOf(game).deckMode;
const winningScoreOf = game => settingsOf(game).winningScore;
const botCountOf = game => settingsOf(game).botCount;
// A whole turn's worth of thinking. Past this the table is stuck waiting on somebody
// who has walked away, so the server resolves the turn for them.
// Overridable so the timeout can be exercised without sitting through two minutes.
const TURN_LIMIT_MS = Number(process.env.TURN_LIMIT_MS) || 120 * 1000;
// How long the round summary stays up before the scores are banked and the next round
// is dealt. Overridable for the same reason as the two above: a test should not have to
// sit through it.
const ROUND_SUMMARY_MS = Number(process.env.ROUND_SUMMARY_MS) || 5000;
// Nothing a client can spam corrupts a game - every handler re-checks whose turn it is -
// but one tab holding down an action should not make the server do that checking
// thousands of times a second.
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_EVENTS = 30;

// Counted for the whole game rather than the round, so the end-of-game screen reads as
// a record of how somebody played rather than how their last hand went. A round reset
// deliberately leaves these alone; only a rematch clears them.
const freshStats = () => ({
  cardsDrawn: 0,
  busts: 0,
  timeouts: 0,
  stands: 0,
  bestRound: 0,
  sevens: 0,
  secondChances: 0,
  powerPlays: 0,
  timesTargeted: 0
});

const bump = (player, key, by = 1) => {
  if (!player.stats) player.stats = freshStats();
  player.stats[key] += by;
};

// Helper functions
// Wraps the pure reshuffle so the rest of the server keeps getting a history entry
// without lib/deck.js needing to know the log exists.
const reshuffleFromDiscard = game => {
  if (!reshuffleDeck(game)) return false;
  logHistory(game, { action: 'reshuffle' });
  console.log(`Deck reshuffled from discards. New size: ${game.deck.length}`);
  return true;
};

// The rule itself lives in lib/presence.js, where it can be tested against a clock this
// file cannot hand it. Overridable so the behaviour can be watched without sitting
// through the wait, exactly as TURN_LIMIT_MS is.
const PAUSE_GRACE_MS = Number(process.env.PAUSE_GRACE_MS) || DEFAULT_PAUSE_GRACE_MS;

// The difference between "their connection blipped" and "they are not there". Only the
// second one stops the game.
const isMissing = (player, now = Date.now()) =>
  playerIsMissing(player, { now, graceMs: PAUSE_GRACE_MS });

// A token is a player's proof of identity when they come back, so nothing sent to a
// client may carry anyone else's - it would let any player claim any seat. Target lists
// and round summaries go out as whole player objects too, so they all come through here.
// `away` rides along because the grace period is the server's to judge: a client working
// it out from `connected` would put the popup up in the gap the grace exists to cover.
const publicPlayers = players => players.map(({ token, ...player }) => ({
  ...player,
  away: isMissing(player)
}));

// roundStartDeck is the pre-round deck kept for round restarts. Sending it would hand
// out the draw order in the exact order the deck sorting below exists to hide.
const publicGame = game => {
  // The clock is deliberately not sent: the turn limit is a backstop against an absent
  // player, not a countdown to play against.
  const {
    roundStartDeck, roundStartDiscard, turnDeadline, turnStateKey, botClock,
    awaySignature, ...rest
  } = game;
  return {
    ...rest,
    deck: sortDeckForDisplay(game.deck),
    players: publicPlayers(game.players)
  };
};

const isCurrentTurn = (game, socketId) =>
  game.players[game.currentPlayer] && game.players[game.currentPlayer].id === socketId;

// Everyone waits when somebody is missing - but not for a socket that dropped two
// seconds ago and is already coming back. See lib/presence.js.
const isPaused = game => isGamePaused(game, { graceMs: PAUSE_GRACE_MS });

// hostId is a socket id because that is what clients compare against, so it has to be
// re-derived whenever connections change. Who should hold it is actingHost, in
// lib/seats.js; this is the assignment.
const syncHost = game => {
  const acting = actingHost(game);
  if (acting) game.hostId = acting.id;
};

// Every broadcast has to leave hostId pointing at a live socket, so the two always
// happen together.
const broadcastGame = (io, game) => {
  syncHost(game);
  io.to(game.id).emit('game-update', publicGame(game));
};

// Identifies the turn currently on the clock. It deliberately changes on more than the
// seat: a new round, a target popup opening, and each card still owed from a Draw Three
// all count as the turn moving on, and each earns a fresh 120 seconds.
const turnStateKey = game => {
  const player = game.players[game.currentPlayer];
  if (!player || player.status !== 'active') return null;
  return [
    game.roundEpoch || 0,
    game.currentPlayer,
    player.drawThreeRemaining || 0,
    player.pendingTarget || '-'
  ].join('|');
};

// Started and restarted from the one-second sweeper rather than from every place that
// changes a turn, so no code path can forget to wind the clock.
const refreshTurnDeadline = game => {
  const key = (game.status === 'playing' && !game.roundEnding && !isPaused(game))
    ? turnStateKey(game)
    : null;

  if (!key) {
    // A paused game clears the key as well as the deadline, so whoever is on the clock
    // gets the full time again once everybody is back rather than the remains of it.
    game.turnStateKey = null;
    game.turnDeadline = null;
    return;
  }

  if (key !== game.turnStateKey) {
    game.turnStateKey = key;
    game.turnDeadline = Date.now() + TURN_LIMIT_MS;
  }
};

// Resolving a run-down clock as a bust is the one outcome that cannot be played for:
// standing would bank points for doing nothing, and skipping would make stalling free.
const bustOnTimeout = (game, io) => {
  const player = game.players[game.currentPlayer];
  if (!player || player.status !== 'active') return;

  // A card waiting on a target it will never get goes to the discard pile, exactly as
  // it would if there had been no valid target to aim it at.
  const pending = player.pendingTarget;
  if (pending && removeOneCard(player.specialCards, pending)) {
    game.discardPile.push(pending);
  }

  player.status = 'busted';
  player.bustedCard = null;
  player.roundScore = 0;
  player.drawThreeRemaining = 0;
  player.pendingSpecialCard = null;
  player.pendingTarget = null;

  bump(player, 'busts');
  bump(player, 'timeouts');
  logHistory(game, { player: player.name, action: 'timeout' });
  io.to(game.id).emit('turn-timeout', { playerId: player.id, playerName: player.name });
  io.to(game.id).emit('play-sound', 'bustSound');

  advanceTurn(game);
  checkGameStatus(game, io);
  broadcastGame(io, game);
};

// Taken whenever a round begins so a restart can put both piles back exactly as they
// were, rather than reshuffling and changing what everyone has been counting. The
// discards matter as much as the draw pile now: they are what the next reshuffle is
// made of, so a restart that dropped them would quietly delete cards from the game.
const snapshotRoundDeck = game => {
  game.roundStartDeck = [...game.deck];
  game.roundStartDiscard = [...game.discardPile];
};

// Players are no longer removed when they drop, so a game everyone has walked away from
// has nobody left to clean it up and would sit in the map for the life of the process.
// Overridable so a bots-only table can be watched getting collected without sitting
// through ten minutes, exactly as TURN_LIMIT_MS is.
const ABANDON_GRACE_MS = Number(process.env.ABANDON_GRACE_MS) || 10 * 60 * 1000;
const abandonTimers = new Map();

const cancelAbandonTimer = gameId => {
  const timer = abandonTimers.get(gameId);
  if (timer) {
    clearTimeout(timer);
    abandonTimers.delete(gameId);
  }
};

const scheduleAbandonTimer = gameId => {
  cancelAbandonTimer(gameId);
  const timer = setTimeout(() => {
    abandonTimers.delete(gameId);
    const game = games.get(gameId);
    // Bots do not count as somebody coming back. A table with nothing but bots left
    // sitting at it has no one to clean it up, and would otherwise stay in the map for
    // the life of the process.
    if (!game || game.players.some(p => p.connected && !isBot(p))) return;
    releaseBotSockets(game);
    games.delete(gameId);
    console.log(`Removed abandoned game ${gameId}`);
  }, ABANDON_GRACE_MS);
  // Ten minutes of pending timer over a dead game would otherwise hold the process open.
  if (typeof timer.unref === 'function') timer.unref();
  abandonTimers.set(gameId, timer);
};

// A lobby seat used to be freed the instant the socket dropped, which on a phone is the
// instant you switch apps. You came back to a game you were no longer in, holding a token
// for a seat that no longer existed - and if you were the only human in the lobby, the
// game had been deleted out from under you. The seat is held now, exactly as it is
// mid-round, just not forever: somebody who closed the tab for good would otherwise sit
// in the lobby taking up a place nobody can use.
const LOBBY_HOLD_MS = Number(process.env.LOBBY_HOLD_MS) || 3 * 60 * 1000;
const lobbyHoldTimers = new Map();

// Keyed by token rather than socket id, because the whole point is to outlive the socket.
const lobbyHoldKey = (gameId, token) => `${gameId}:${token}`;

const cancelLobbyHold = (gameId, token) => {
  if (!token) return;
  const key = lobbyHoldKey(gameId, token);
  const timer = lobbyHoldTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    lobbyHoldTimers.delete(key);
  }
};

const scheduleLobbyRelease = (io, gameId, token) => {
  // Bots have no token and are never held: their seats are a lobby setting, not people.
  if (!token) return;
  cancelLobbyHold(gameId, token);

  const timer = setTimeout(() => {
    lobbyHoldTimers.delete(lobbyHoldKey(gameId, token));
    const game = games.get(gameId);
    if (!game) return;

    const index = game.players.findIndex(p => p.token && p.token === token);
    if (index === -1) return;

    // They came back, or the game started around them. Either way the seat is theirs and
    // the mid-round rules have it from here.
    if (game.players[index].connected || game.status === 'playing') return;

    const removed = removePlayerAt(game, index);

    if (humansIn(game).length === 0) {
      cancelAbandonTimer(gameId);
      releaseBotSockets(game);
      games.delete(gameId);
      return;
    }

    syncBotSeats(game);
    logHistory(game, { player: removed.name, action: 'left' });
    broadcastGame(io, game);
  }, LOBBY_HOLD_MS);

  if (typeof timer.unref === 'function') timer.unref();
  lobbyHoldTimers.set(lobbyHoldKey(gameId, token), timer);
};

// The action log lives on the game object, so it rides along on every game-update
// broadcast. Clients never have to reconstruct it from events they missed while a
// popup was covering the board, and a late joiner sees the same log as everyone else.
// Only the raw facts are stored - the client owns the wording and the card colours.
const logHistory = (game, entry) => {
  if (!Array.isArray(game.history)) game.history = [];
  game.historySeq = (game.historySeq || 0) + 1;
  game.history.push({
    id: game.historySeq,
    round: game.roundNumber,
    player: null,
    cards: [],
    target: null,
    target2: null,
    ...entry
  });
  // A long game would otherwise grow the log without bound and it is broadcast in full.
  if (game.history.length > MAX_HISTORY_ENTRIES) {
    game.history.splice(0, game.history.length - MAX_HISTORY_ENTRIES);
  }
};

// Game logic
//
// The whole rule book, registered against one socket. This was the body of
// io.on('connection', ...) and has not otherwise changed; it was lifted out so a bot
// seat can be handed the same registrations against a puppet socket (createBotSocket
// below) rather than a real connection. A bot therefore runs this exact code, and there
// is no second copy of the rules for bots to drift away from.
const registerHandlers = (io) => socket => {
    console.log(`New connection: ${socket.id}`);

    // Dropped rather than rejected: a legitimate client never reaches this rate, so
    // there is nobody to report an error to.
    socket.use((packet, next) => {
      const now = Date.now();
      if (!socket.data.rateWindowStart || now - socket.data.rateWindowStart >= RATE_LIMIT_WINDOW_MS) {
        socket.data.rateWindowStart = now;
        socket.data.rateCount = 0;
      }
      socket.data.rateCount = (socket.data.rateCount || 0) + 1;
      if (socket.data.rateCount > RATE_LIMIT_MAX_EVENTS) return;
      next();
    });

    // Use the module-level BASE_URL (calculated at startup) instead of hardcoding here

    // Update game creation to include full URL
    socket.on('create-game', playerName => {
      const name = sanitizeName(playerName);
      const tooShort = nameRefusal(name);
      if (tooShort) return socket.emit('error', tooShort);

      // Leave any existing game room first
      if (socket.rooms) {
        [...socket.rooms].forEach(room => {
          if (room !== socket.id) {
            socket.leave(room);
          }
        });
      }

      const gameId = uuidv4().substr(0, 5).toUpperCase();
      const gameUrl = `${BASE_URL}/join/${gameId}`;
      const host = createPlayer(socket.id, name);
      const settings = createSettings();
      const newGame = {
        settings,
        id: gameId,
        url: gameUrl,
        hostId: socket.id,
        // Tracked by token as well, so a host who refreshes gets their powers back
        // instead of losing them to whoever happened to be standing in.
        hostToken: host.token,
        players: [host],
        deck: createDeck(settings.deckMode),
        discardPile: [],
        currentPlayer: 0,
        status: 'lobby',
        roundNumber: 1,
        lastCardDrawn: null,
        roundEnding: false,
        roundEpoch: 0,
        history: [],
        historySeq: 0
      };

      games.set(gameId, newGame);
      socket.join(gameId);
      socket.emit('game-created', { gameId, gameUrl, token: host.token });
    });

    socket.on('join-game', (gameId, playerName) => {
      const game = games.get(gameId);
      if (!game) return socket.emit('error', `Game ${gameId} not found!`);

      const name = sanitizeName(playerName);
      const tooShort = nameRefusal(name);
      if (tooShort) return socket.emit('error', tooShort);

      if (game.status === 'finished') {
        return socket.emit('error', 'That game has already finished.');
      }

      // A name and a code are all it takes to come back to a seat you left, so the same
      // form covers joining and rejoining. A player added to a round in progress would
      // otherwise sit at 'waiting' forever, since only startNewRound makes players active.
      if (game.status !== 'lobby') {
        const seat = findDisconnectedSeatByName(game, name);
        if (seat) {
          // Whoever held the old token may still have it on another device, so it stops
          // working the moment the seat is taken back here.
          return attachToSeat(game, seat, socket, io, { rotateToken: true });
        }

        const waiting = game.players.filter(p => !p.connected).map(p => p.name);
        return socket.emit('error', waiting.length
          ? `No seat here for "${name}". Waiting on: ${waiting.join(', ')}. Type that name exactly to take the seat back.`
          : 'That game is already under way and nobody has dropped out, so there is no seat free.');
      }

      // The lobby holds a dropped player's seat now instead of freeing it, so their name
      // is still in the list when they come back. Checked before the full-lobby and
      // duplicate-name rules below, or retyping their own name would be refused as a
      // clash with themselves and there would be no way back into their own game.
      const heldSeat = findDisconnectedSeatByName(game, name);
      if (heldSeat) {
        // Whoever held the old token may still have it on another device, so it stops
        // working the moment the seat is taken back here.
        return attachToSeat(game, heldSeat, socket, io, { rotateToken: true });
      }

      // Full table, already seated, name already taken. See lib/seats.js.
      const refusal = lobbyJoinRefusal(game, name, socket.id);
      if (refusal) return socket.emit('error', refusal);

      const player = createPlayer(socket.id, name);
      game.players.push(player);
      socket.join(gameId);
      // People take priority over bots, so the count is re-clamped to whatever is left.
      syncBotSeats(game);
      broadcastGame(io, game);
      socket.emit('game-joined', { gameId, token: player.token });
    });

    // Sent by a client that still holds a token for this game - a refresh, or a
    // connection that dropped and came back.
    socket.on('rejoin-game', (gameId, token) => {
      const game = games.get(gameId);
      if (!game) return socket.emit('rejoin-failed', 'That game no longer exists.');

      const player = findByToken(game, token);
      if (!player) return socket.emit('rejoin-failed', 'You are no longer in that game.');

      attachToSeat(game, player, socket, io);
    });

    // Lobby only. Once cards are on the table the deck and the target score are part of
    // the game everybody agreed to play, and changing either mid-game would rewrite it.
    socket.on('update-settings', (gameId, incoming) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'lobby') return;
      syncHost(game);
      if (socket.id !== game.hostId) return;

      const previous = settingsOf(game);
      game.settings = sanitizeSettings(previous, incoming);

      // The lobby shows the deck size, so the pile has to actually be that deck.
      if (game.settings.deckMode !== previous.deckMode) {
        game.deck = createDeck(game.settings.deckMode);
      }

      // Bots are seats, so asking for a different number of them adds or removes
      // players. This also clamps the setting back down to what the table has room for.
      syncBotSeats(game);

      broadcastGame(io, game);
    });

    socket.on('start-game', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'lobby' || socket.id !== game.hostId) return;
      if (game.players.length < 2) return;

      game.status = 'playing';
      game.players.forEach(p => p.status = 'active');
      snapshotRoundDeck(game);
      logHistory(game, { action: 'round-start' });
      syncHost(game);
      io.to(gameId).emit('game-started', publicGame(game));
    });

    // Update the flip-card event handler to handle Select as the last card
    socket.on('flip-card', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      const player = game.players[game.currentPlayer];
      if (player.id !== socket.id || player.status !== 'active') return;

      // A targeting card that has not been aimed yet still owns the turn. Without this,
      // ignoring the popup and flipping again is worth free extra cards.
      if (player.pendingTarget) return;

      // Handle deck replenishment - Special handling for the last card being Select
      if (game.deck.length === 1) {
        const lastCard = game.deck[0];
        
        // If the last card is Select, we need special handling
        if (lastCard === 'Select') {
          // Pop the Select card from the current deck
          game.deck.pop();

          // Taking it empties the draw pile, so the choices have to come from the
          // reshuffled discards - the cards that genuinely still exist.
          reshuffleFromDiscard(game);

          // Track the last card drawn
          game.lastCardDrawn = 'Select';
          logHistory(game, { player: player.name, action: 'draw', cards: ['Select'] });

          player.specialCards.push('Select');

          handleSelectCard(game, player, socket, io);

          updatePlayerScore(player);
          checkGameStatus(game, io);
          broadcastGame(io, game);

          // No need for further processing - we'll handle the card selection in the select-card-choice event
          return;
        }
      }
      
      // Regular empty deck handling
      if (game.deck.length === 0 && !reshuffleFromDiscard(game)) {
        // Draw pile and discards are both empty, so every remaining card is in
        // somebody's hand. There is nothing to draw and the turn has to end.
        player.status = 'stood';
        player.drawThreeRemaining = 0;
        player.pendingSpecialCard = null;
        logHistory(game, { player: player.name, action: 'deck-empty' });
        advanceTurn(game);
        updatePlayerScore(player);
        checkGameStatus(game, io);
        broadcastGame(io, game);
        return;
      }

      const card = game.deck.pop();
      bump(player, 'cardsDrawn');

      // Track the last card drawn
      game.lastCardDrawn = card;
      logHistory(game, { player: player.name, action: 'draw', cards: [card] });

      // Send game update to all clients to refresh deck count immediately
      broadcastGame(io, game);

      // Continue with regular card handling
      // Handle number cards
      if (typeof card === 'number') {
          handleNumberCard(game, player, card, io);

          if (player.status === 'busted') {
              player.drawThreeRemaining = 0;
              player.pendingSpecialCard = null; // Clear any pending special cards
              advanceTurn(game);
          }
          else if (player.regularCards.length >= MAX_REGULAR_CARDS) { // Changed: Only count regular cards
              player.status = 'stood';
              player.drawThreeRemaining = 0;
              player.pendingSpecialCard = null; // Clear any pending special cards
              advanceTurn(game);
          } 
          else if (player.drawThreeRemaining > 0) {
              player.drawThreeRemaining--;
              if (player.drawThreeRemaining === 0 && player.pendingSpecialCard) {
                // Handle pending special card after D3 sequence completes
                handlePendingSpecialCard(game, player, socket, io);
              } else if (player.drawThreeRemaining === 0) {
                advanceTurn(game);
              }
          }
          else {
              advanceTurn(game);
          }
      }
      // Handle special cards - don't add to discard pile until they're used
      else if (card === 'D3' || card === 'Freeze' || card === 'RC' || card === 'ST' || card === 'Swap') {
        if (player.drawThreeRemaining > 0) {
          // Add the special card to hand and continue with D3 sequence
          player.specialCards.push(card);
          player.pendingSpecialCard = card;
          player.drawThreeRemaining--;
          if (player.drawThreeRemaining === 0) {
            handlePendingSpecialCard(game, player, socket, io);
          }
        } else {
          player.specialCards.push(card);
          handleSpecialCard(game, player, card, socket, io);
        }
      }
      // Handle Select Card
      else if (card === 'Select') {
        player.specialCards.push(card);
        if (player.drawThreeRemaining > 0) {
          // Store the special card as pending and continue with D3 sequence
          player.pendingSpecialCard = card;
          player.drawThreeRemaining--;
          if (player.drawThreeRemaining === 0) {
            handlePendingSpecialCard(game, player, socket, io);
          }
        } else {
          // Emit game-update so clients see Select in special cards before popup shows
          broadcastGame(io, game);
          handleSelectCard(game, player, socket, io);
        }
      }
      // Handle other special cards
      else {
        player.specialCards.push(card);
        if (player.drawThreeRemaining > 0) {
          player.drawThreeRemaining--;
          if (player.drawThreeRemaining === 0) {
            advanceTurn(game);
          }
        } else {
          advanceTurn(game);
        }
      }
  
      updatePlayerScore(player);
      checkGameStatus(game, io);
      broadcastGame(io, game);
    });

    socket.on('stand', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      const player = game.players[game.currentPlayer];
      if (player.id !== socket.id || player.status !== 'active' || player.drawThreeRemaining > 0) return;
      if (player.pendingTarget) return;

      player.status = 'stood';
      bump(player, 'stands');
      logHistory(game, { player: player.name, action: 'stand' });
      io.to(gameId).emit('play-sound', 'standSound'); // Broadcast stand sound
      advanceTurn(game);
      checkGameStatus(game, io);
      broadcastGame(io, game);
    });

    // Called it a day. Ends the game where it stands and shows the normal end screen,
    // so a table that has run out of time still gets a winner, the highlights and the
    // rematch button rather than just evaporating.
    //
    // Whoever is ahead wins. A draw goes to the player already sitting higher up the
    // table, which is arbitrary but has to be somebody - and the alternative, refusing
    // to end a tied game, is worse than a coin toss nobody notices.
    socket.on('end-game', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      // The acting host may be a stand-in while the original is away.
      syncHost(game);
      if (socket.id !== game.hostId) return;

      const leader = game.players.reduce(
        (best, player) => (player.totalScore > best.totalScore ? player : best),
        game.players[0]
      );
      if (!leader) return;

      logHistory(game, { player: leader.name, action: 'ended-early' });
      endGame(game, leader, io);
      broadcastGame(io, game);
    });

    // The other way out, and the one that was missing entirely: back to the waiting room
    // with the scores wiped, where the deck, the target score and the number of bots can
    // all be changed before starting again. Until now the only way to play a different
    // deck was to abandon the game and make a new one, and everybody had to rejoin.
    socket.on('return-to-lobby', gameId => {
      const game = games.get(gameId);
      if (!game || game.status === 'lobby') return;

      syncHost(game);
      if (socket.id !== game.hostId) return;

      game.status = 'lobby';
      game.deck = createDeck(deckModeOf(game));
      game.discardPile = [];
      game.currentPlayer = 0;
      game.roundNumber = 1;
      game.lastCardDrawn = null;
      game.roundEnding = false;
      // Bumped so any round-end timeout still pending from the game being left behind
      // cannot score into the lobby it is coming back to.
      game.roundEpoch = (game.roundEpoch || 0) + 1;
      game.history = [];
      game.historySeq = 0;
      game.turnStateKey = null;
      game.turnDeadline = null;

      // 'waiting' rather than 'active': only startNewRound makes players active, and a
      // lobby that already had everyone active would show a board with no cards on it.
      game.players.forEach(player => {
        player.regularCards = [];
        player.specialCards = [];
        player.status = 'waiting';
        player.roundScore = 0;
        player.totalScore = 0;
        player.bustedCard = null;
        player.drawThreeRemaining = 0;
        player.pendingSpecialCard = null;
        player.pendingTarget = null;
        player.stats = freshStats();
      });

      // The bot seats are a lobby setting again, so they are reconciled the same way any
      // other settings change reconciles them.
      syncBotSeats(game);

      syncHost(game);
      io.to(gameId).emit('returned-to-lobby', publicGame(game));
      broadcastGame(io, game);
    });

    // Host-only escape hatch for a player who is not coming back. The round they
    // abandoned is replayed from the top rather than resumed, because their hand and
    // their turn were part of it.
    socket.on('kick-player', (gameId, targetId) => {
      const game = games.get(gameId);
      if (!game) return;

      syncHost(game);
      if (socket.id !== game.hostId) return;

      const index = game.players.findIndex(p => p.id === targetId);
      if (index === -1) return;

      // A bot is never stuck and never coming back, so there is nothing here to rescue
      // the table from. The number of them is a lobby setting, like the deck.
      if (isBot(game.players[index])) {
        return socket.emit('error', 'Bots are set in the lobby, not kicked.');
      }

      // Once cards are on the table this is only ever aimed at someone who has actually
      // dropped: removing a player mid-round throws the round away, so it is not a way
      // to remove somebody who is sitting there playing. In the lobby there is no round
      // to lose and no cards to redeal, so the host can clear any seat - which is the
      // only way to get rid of somebody who walked in off a shared link.
      if (game.status !== 'lobby' && game.players[index].connected) {
        return socket.emit('error', 'You can only remove a disconnected player.');
      }

      // The host is the one holding the button. Leaving is a different door: see
      // 'leave-lobby', which closes the table rather than leaving it hostless.
      if (game.players[index].id === game.hostId) {
        return socket.emit('error', 'The host cannot remove themselves.');
      }

      const wasPlaying = game.status === 'playing';
      cancelLobbyHold(gameId, game.players[index].token);
      const removed = removePlayerAt(game, index);
      logHistory(game, { player: removed.name, action: 'kicked' });

      // A player kicked while still sitting there has a socket listening, so they get
      // told rather than left staring at a lobby that has quietly stopped updating.
      // Their token is dead too - the seat is gone, so rejoin-game has nothing to find.
      const removedSocket = io.sockets.sockets.get(removed.id);
      if (removedSocket) {
        removedSocket.leave(gameId);
        removedSocket.emit('removed-from-game', 'The host removed you from the game.');
      }

      if (game.players.length === 0) {
        cancelAbandonTimer(gameId);
        games.delete(gameId);
        return;
      }

      // Held lobby seats made this reachable before a game has started, where there is
      // no round to end and none to restart - just a shorter waiting list.
      if (!wasPlaying) {
        syncBotSeats(game);
        broadcastGame(io, game);
        return;
      }

      // Nobody left to play against, so the last player standing takes it.
      if (game.players.length < 2) {
        syncHost(game);
        endGame(game, game.players[0], io);
        broadcastGame(io, game);
        return;
      }

      restartRound(game, io);
    });

    // Creating a game used to be a one-way door. Tapping "Create Game" when you meant
    // "Join" left you sitting in a waiting room of one with no way out but a reload, and
    // the lobby you abandoned stayed in the map until the abandon timer got to it.
    //
    // For a guest this is just standing up from the seat. For the host it closes the
    // table, because a lobby whose host has gone is a game nobody can start.
    socket.on('leave-lobby', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'lobby') return;

      syncHost(game);

      const index = game.players.findIndex(p => p.id === socket.id);
      if (index === -1) return;

      if (socket.id === game.hostId) {
        // Sent before the room is emptied, or there is nobody left in it to hear.
        // Everybody but the host, who does not need telling what they just did - they
        // get the same plain trip back to the start screen a guest leaving gets.
        socket.to(gameId).emit('game-cancelled', 'The host cancelled this game.');
        socket.emit('left-lobby');
        io.in(gameId).socketsLeave(gameId);

        game.players.forEach(p => cancelLobbyHold(gameId, p.token));
        cancelAbandonTimer(gameId);
        releaseBotSockets(game);
        games.delete(gameId);
        return;
      }

      cancelLobbyHold(gameId, game.players[index].token);
      const removed = removePlayerAt(game, index);
      socket.leave(gameId);
      socket.emit('left-lobby');

      // Bots are seats, not players, so a table of nothing but bots is an empty table.
      if (humansIn(game).length === 0) {
        cancelAbandonTimer(gameId);
        releaseBotSockets(game);
        games.delete(gameId);
        return;
      }

      // People take priority over bots, so a freed seat may be worth a bot again.
      syncBotSeats(game);
      logHistory(game, { player: removed.name, action: 'left' });
      broadcastGame(io, game);
    });

    // The third answer to somebody dropping, and usually the right one. Waiting keeps
    // the round but stalls it; removing them frees the table but throws the round away.
    // Handing the seat to a bot does neither - the cards, the score and the turn all
    // stay exactly where they are and play carries straight on.
    socket.on('replace-with-bot', (gameId, targetId) => {
      const game = games.get(gameId);
      if (!game) return;

      syncHost(game);
      if (socket.id !== game.hostId) return;

      const index = game.players.findIndex(p => p.id === targetId);
      if (index === -1) return;

      const player = game.players[index];
      if (isBot(player)) {
        return socket.emit('error', 'That seat is already a bot.');
      }

      // Only ever aimed at someone who has actually dropped. This is not a way to hand
      // somebody's hand to a bot while they are sitting there playing it.
      if (player.connected) {
        return socket.emit('error', 'You can only hand over a disconnected player.');
      }

      const bot = botifySeat(game, index);
      logHistory(game, { player: bot.name, action: 'botified' });

      // Nobody is missing any more, so isPaused goes false and the round picks up from
      // wherever it stopped - including a turn that was half-taken.
      broadcastGame(io, game);
    });

    socket.on('freeze-player', (gameId, targetId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      // Targeting cards are always played on the holder's own turn, so anything
      // arriving out of turn is a client that is not playing by the rules.
      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      const target = game.players.find(p => p.id === targetId);

      if (!player || !target || !player.specialCards.includes('Freeze')) return;
      if (target.status !== 'active') {
        return socket.emit('error', 'You can only freeze active players.');
      }

      player.pendingTarget = null;
      removeOneCard(player.specialCards, 'Freeze');
      // Force the target to stand for the rest of the round
      target.status = 'stood';
      // Add Freeze to discard only when used
      game.discardPile.push('Freeze');
      bump(player, 'powerPlays');
      if (target.id !== player.id) bump(target, 'timesTargeted');
      logHistory(game, { player: player.name, action: 'freeze', target: target.name });

      advanceTurn(game);
      checkGameStatus(game, io);
      broadcastGame(io, game);
    });

    socket.on('draw-three-select', (gameId, targetId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      const target = game.players.find(p => p.id === targetId);

      if (!player || !target || !player.specialCards.includes('D3')) return;

      // The turn is handed to the target, so they have to be able to take it -
      // otherwise the round stalls on a player who can never flip a card.
      if (target.status !== 'active' || target.regularCards.length >= MAX_REGULAR_CARDS) {
        return socket.emit('error', 'That player cannot draw three cards.');
      }

      player.pendingTarget = null;
      // Remove D3 from player's special cards
      removeOneCard(player.specialCards, 'D3');

      // Add D3 to discard pile
      game.discardPile.push('D3');

      // Set draw three remaining on target
      target.drawThreeRemaining = 3;
      bump(player, 'powerPlays');
      if (target.id !== player.id) bump(target, 'timesTargeted');
      logHistory(game, { player: player.name, action: 'draw-three', target: target.name });

      // Set current player to target
      game.currentPlayer = game.players.findIndex(p => p.id === target.id);

      // Update game state
      broadcastGame(io, game);
    });

    // Add rematch handling
    // Only from the end screen, and only from the host - the same two guards every
    // other host action carries. Without them this was a way for anybody who knew the
    // game code to wipe the table's scores back to zero in the middle of a round, which
    // is not something the client has ever offered but was not the client's to enforce.
    socket.on('request-rematch', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'finished') return;

      // The acting host may be a stand-in while the original is away.
      syncHost(game);
      if (socket.id !== game.hostId) return;

      // Reset the game state but keep players
      const rematchGame = {
          ...game,
          deck: createDeck(deckModeOf(game)),
          discardPile: [],
          currentPlayer: 0,
          status: 'playing',
          roundNumber: 1,
          lastCardDrawn: null,
          roundEnding: false,
          roundEpoch: (game.roundEpoch || 0) + 1,
          history: [],
          historySeq: 0
      };

      // Reset all players
      rematchGame.players = rematchGame.players.map(player => ({
          ...player,
          regularCards: [],
          specialCards: [],
          status: 'active',
          roundScore: 0,
          totalScore: 0,
          bustedCard: null,
          drawThreeRemaining: 0,
          pendingSpecialCard: null,
          pendingTarget: null,
          stats: freshStats()
      }));

      // Update the game in the map
      games.set(gameId, rematchGame);
      snapshotRoundDeck(rematchGame);
      logHistory(rematchGame, { action: 'round-start' });

      // Notify all players about the rematch
      syncHost(rematchGame);
      io.to(gameId).emit('rematch-started', publicGame(rematchGame));
      broadcastGame(io, rematchGame);
    });

    // Add this with other socket events in handleSocketConnection
    socket.on('remove-card', (gameId, targetPlayerId, cardIndex, isSpecial) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      const target = game.players.find(p => p.id === targetPlayerId);
      
      // Check if both player and target exist and player has RC card
      if (!player || !target || !player.specialCards.includes('RC')) return;
      
      // Active target, an index that exists, and never an RC. See lib/rules.js.
      const refusal = removeCardRefusal(target, cardIndex, isSpecial);
      if (refusal) return socket.emit('error', refusal);

      const cardArray = isSpecial ? target.specialCards : target.regularCards;

      // Take the chosen card out first: when a player aims RC at their own hand,
      // discarding the RC first would shift every index after it.
      const removedCard = cardArray.splice(cardIndex, 1)[0];
      game.discardPile.push(removedCard);

      // Remove RC from player's special cards
      player.pendingTarget = null;
      removeOneCard(player.specialCards, 'RC');
      game.discardPile.push('RC');
      bump(player, 'powerPlays');
      if (target.id !== player.id) bump(target, 'timesTargeted');
      logHistory(game, {
        player: player.name,
        action: 'remove',
        cards: [removedCard],
        target: target.name
      });

      // Recalculate target's score after card removal
      updatePlayerScore(target);

      advanceTurn(game);
      checkGameStatus(game, io);
      broadcastGame(io, game);
    });

    socket.on('steal-card', (gameId, targetPlayerId, cardIndex, isSpecial) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      const target = game.players.find(p => p.id === targetPlayerId);

      if (!player || !target || !player.specialCards.includes('ST')) return;

      // Never yourself, never a busted hand, and an index that exists. See lib/rules.js.
      const refusal = stealCardRefusal(player, target, cardIndex, isSpecial);
      if (refusal) return socket.emit('error', refusal);

      const cardArray = isSpecial ? target.specialCards : target.regularCards;
      const stolenCard = cardArray.splice(cardIndex, 1)[0];

      // Consume Steal Card
      player.pendingTarget = null;
      removeOneCard(player.specialCards, 'ST');
      game.discardPile.push('ST');

      // Logged before the card is applied, so a bust from the stolen number reads
      // as the next entry rather than jumping ahead of the steal that caused it.
      bump(player, 'powerPlays');
      bump(target, 'timesTargeted');
      logHistory(game, {
        player: player.name,
        action: 'steal',
        cards: [stolenCard],
        target: target.name
      });

      if (isSpecial) {
        player.specialCards.push(stolenCard);
      } else {
        // Stealing a number you already hold can still bust you.
        handleNumberCard(game, player, stolenCard, io);
      }

      updatePlayerScore(player);
      updatePlayerScore(target);
      advanceTurn(game);
      checkGameStatus(game, io);
      broadcastGame(io, game);
    });

    socket.on('swap-cards', (gameId, card1Data, card2Data) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || !player.specialCards.includes('Swap')) return;

      if (!card1Data || !card2Data) {
        socket.emit('error', 'Invalid card selection.');
        return;
      }

      const player1 = game.players.find(p => p.id === card1Data.playerId);
      const player2 = game.players.find(p => p.id === card2Data.playerId);

      if (!player1 || !player2) {
        socket.emit('error', 'Invalid players selected.');
        return;
      }

      if (player1.id === player2.id) {
        socket.emit('error', 'Must swap cards from different players.');
        return;
      }

      if (player1.status === 'busted' || player2.status === 'busted') {
        socket.emit('error', 'Cannot swap cards with busted players.');
        return;
      }

      // Get the card arrays
      const array1 = card1Data.isSpecial ? player1.specialCards : player1.regularCards;
      const array2 = card2Data.isSpecial ? player2.specialCards : player2.regularCards;

      if (!Number.isInteger(card1Data.index) || !Number.isInteger(card2Data.index) ||
          card1Data.index < 0 || card1Data.index >= array1.length ||
          card2Data.index < 0 || card2Data.index >= array2.length) {
        socket.emit('error', 'Invalid card selection.');
        return;
      }

      // Extract both card values
      const card1Value = array1[card1Data.index];
      const card2Value = array2[card2Data.index];

      // Only point-scoring specials can change hands - the targeting cards would
      // otherwise land in a hand with no way left to play them.
      if ((card1Data.isSpecial && !isSwappableSpecial(card1Value)) ||
          (card2Data.isSpecial && !isSwappableSpecial(card2Value))) {
        socket.emit('error', 'That card cannot be swapped.');
        return;
      }

      // Remove both cards from their original arrays before the Swap card is
      // discarded, so the indices still line up when the swapper trades one of
      // their own special cards.
      array1.splice(card1Data.index, 1);
      array2.splice(card2Data.index, 1);

      // Consume Swap Card
      player.pendingTarget = null;
      removeOneCard(player.specialCards, 'Swap');
      game.discardPile.push('Swap');

      // Place each card into the correct array on the receiving player
      // Numbers go to regularCards, strings go to specialCards
      if (typeof card2Value === 'number') {
        player1.regularCards.push(card2Value);
      } else {
        player1.specialCards.push(card2Value);
      }

      if (typeof card1Value === 'number') {
        player2.regularCards.push(card1Value);
      } else {
        player2.specialCards.push(card1Value);
      }

      bump(player, 'powerPlays');
      [player1, player2].forEach(side => {
        if (side.id !== player.id) bump(side, 'timesTargeted');
      });

      // Logged before the duplicate check below, so a bust caused by the swap reads
      // as a consequence of it.
      logHistory(game, {
        player: player.name,
        action: 'swap',
        cards: [card1Value, card2Value],
        target: player1.name,
        target2: player2.name
      });

      // The rule is resolveSwapDuplicate in lib/rules.js; this announces what it did.
      const announceSwapDuplicate = (targetPlayer, swappedValue) => {
        const { outcome, card } = resolveSwapDuplicate(game, targetPlayer, swappedValue);
        if (outcome === 'none') return;

        const action = outcome === 'second-chance' ? 'second-chance' : 'bust';
        const sound = outcome === 'second-chance' ? 'secondChanceSound' : 'bustCardSound';
        logHistory(game, { player: targetPlayer.name, action, cards: [card] });
        io.to(game.id).emit('play-sound', sound);
      };

      // Check for duplicates when a number was placed into regularCards
      if (typeof card2Value === 'number') {
        announceSwapDuplicate(player1, card2Value);
      }
      if (typeof card1Value === 'number') {
        announceSwapDuplicate(player2, card1Value);
      }

      // Update scores and check for busts
      updatePlayerScore(player1);
      updatePlayerScore(player2);

      // Notify all players about the swap
      io.to(gameId).emit('swap-notification', {
        swapper: player.name,
        player1: player1.name,
        card1: card1Value,
        player2: player2.name,
        card2: card2Value
      });

      advanceTurn(game);
      checkGameStatus(game, io);
      broadcastGame(io, game);
    });

    // Update the select-card-from-pile event handling for better deck management
    socket.on('select-card-choice', (gameId, selectedCard) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;
      
      const player = game.players[game.currentPlayer];
      if (player.id !== socket.id || player.status !== 'active') return;

      // Only a player actually holding a Select card may pick out of the deck.
      if (!player.specialCards.includes('Select')) return;

      if (!isValidCard(selectedCard)) {
        return socket.emit('error', 'That is not a valid card.');
      }

      // Find and remove the selected card from the deck (with safety checks)
      const cardIndex = game.deck.findIndex(card => card === selectedCard);

      if (cardIndex !== -1) {
        // Card found in the regular deck
        game.deck.splice(cardIndex, 1);
      } else {
        // The popup is always built from the real draw pile now, so a card missing from
        // it is a client asking for something that does not exist.
        return socket.emit('error', 'That card is no longer in the deck.');
      }

      // The Select has been spent. Anything below that needs a target of its own sets
      // pendingTarget again.
      player.pendingTarget = null;
      removeOneCard(player.specialCards, 'Select');
      game.discardPile.push('Select');

      // Track the last card drawn (selected)
      bump(player, 'cardsDrawn');
      game.lastCardDrawn = selectedCard;
      logHistory(game, { player: player.name, action: 'select', cards: [selectedCard] });
      console.log('Last card drawn (via Select) set to:', selectedCard);
      // Process the selected card
      if (typeof selectedCard === 'number') {
        handleNumberCard(game, player, selectedCard, io);

        if (player.status === 'busted') {
          player.drawThreeRemaining = 0;
          player.pendingSpecialCard = null;
          advanceTurn(game);
        }
        else if (player.regularCards.length >= MAX_REGULAR_CARDS) {
          player.status = 'stood';
          player.drawThreeRemaining = 0;
          player.pendingSpecialCard = null;
          advanceTurn(game);
        }
        else {
          advanceTurn(game);
        }
      }
      else if (TARGETING_CARDS.includes(selectedCard) && selectedCard !== 'Select') {
        // For special cards that need targeting, add to hand but don't advance turn yet.
        // The client requests targets immediately; recording it here means the turn
        // cannot move on without a pick, and the popup survives a reconnect.
        player.specialCards.push(selectedCard);
        player.pendingTarget = selectedCard;
      }
      else if (selectedCard === 'Select') {
        // Picking another Select just hands them a fresh choice
        player.specialCards.push(selectedCard);
        handleSelectCard(game, player, socket, io);
      }
      else {
        // For other special cards, add to player's hand
        player.specialCards.push(selectedCard);
        advanceTurn(game);
      }

      updatePlayerScore(player);
      checkGameStatus(game, io);

      // Always emit game update to refresh the deck display
      broadcastGame(io, game);
    });

    // Inside handleSocketConnection function, add these new event handlers
    socket.on('request-draw-three-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active' || !player.specialCards.includes('D3')) return;

      // Find valid targets (active players with room for cards)
      const targets = game.players.filter(p => 
        p.status === 'active' && // Only active players
        p.regularCards.length < MAX_REGULAR_CARDS // Must have room for cards
      );
      
      if (targets.length > 0) {
        player.pendingTarget = 'D3';
        socket.emit('select-draw-three-target', game.id, publicPlayers(targets));
      }
    });
    
    socket.on('request-freeze-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active' || !player.specialCards.includes('Freeze')) return;

      // Find valid targets (active players)
      const targets = game.players.filter(p => p.status === 'active');
      
      if (targets.length > 0) {
        player.pendingTarget = 'Freeze';
        socket.emit('select-freeze-target', game.id, publicPlayers(targets));
      }
    });
    
    socket.on('request-remove-card-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active' || !player.specialCards.includes('RC')) return;

      const hasRemovableCard = p =>
        p.regularCards.length > 0 || p.specialCards.some(c => c !== 'RC');

      // Only allow targets that are active and have at least one removable card
      const targets = game.players.filter(p => 
        p.status === 'active' &&
        hasRemovableCard(p)
      );

      if (targets.length === 0) {
        // No valid targets: discard RC and skip turn
        player.pendingTarget = null;
        removeOneCard(player.specialCards, 'RC');
        game.discardPile.push('RC');
        logHistory(game, { player: player.name, action: 'discard', cards: ['RC'] });
        socket.emit('error', 'No cards to remove. Turn skipped.');
        advanceTurn(game);
        checkGameStatus(game, io);
        broadcastGame(io, game);
        return;
      }

      player.pendingTarget = 'RC';
      socket.emit('select-remove-card-target', game.id, publicPlayers(targets));
    });

    socket.on('request-steal-card-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active' || !player.specialCards.includes('ST')) return;

      const targets = game.players.filter(p =>
        p.status !== 'busted' &&
        p.id !== player.id &&
        (p.regularCards.length > 0 || p.specialCards.length > 0)
      );

      if (targets.length === 0) {
        player.pendingTarget = null;
        removeOneCard(player.specialCards, 'ST');
        game.discardPile.push('ST');
        logHistory(game, { player: player.name, action: 'discard', cards: ['ST'] });
        socket.emit('error', 'No cards to steal. Turn skipped.');
        advanceTurn(game);
        checkGameStatus(game, io);
        broadcastGame(io, game);
        return;
      }

      player.pendingTarget = 'ST';
      socket.emit('select-steal-card-target', game.id, publicPlayers(targets));
    });

    socket.on('request-swap-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing' || isPaused(game)) return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active' || !player.specialCards.includes('Swap')) return;

      const playersWithCards = game.players.filter(p =>
        p.status !== 'busted' && countSwappableCards(p) > 0
      );

      if (playersWithCards.length >= 2) {
        player.pendingTarget = 'Swap';
        socket.emit('select-swap-cards', game.id, publicPlayers(game.players));
      } else {
        player.pendingTarget = null;
        removeOneCard(player.specialCards, 'Swap');
        game.discardPile.push('Swap');
        logHistory(game, { player: player.name, action: 'discard', cards: ['Swap'] });
        socket.emit('error', 'Not enough players with cards to swap. Turn skipped.');
        advanceTurn(game);
        checkGameStatus(game, io);
        broadcastGame(io, game);
      }
    });
    
    // Inside handleSocketConnection function, add these socket events
    socket.on('play-sound', (gameId, soundId) => {
      // Broadcast sound to all players in the game except sender
      socket.to(gameId).emit('play-sound', soundId);
    });

    // Test hooks. Registered only when HIT7_TEST_HOOKS=1 is in the environment, which
    // nothing but test/helpers/harness.js ever sets - a deployed server never has it,
    // so these events do not exist in production and there is nothing to abuse.
    //
    // They exist because the paths worth testing most are the ones a shuffled deck
    // almost never deals: a Draw Three that itself draws a targeting card, a Select as
    // the very last card in the pile. Playing until they turn up is not a test, it is a
    // coin toss. Stacking the deck makes them ordinary.
    if (process.env.HIT7_TEST_HOOKS === '1') {
      // Cards are given in the order they will be drawn. The deck is drawn from the end
      // with pop(), so it is stored reversed.
      socket.on('__test-stack-deck', (gameId, cards, discardPile) => {
        const game = games.get(gameId);
        if (!game || !Array.isArray(cards)) return;
        game.deck = [...cards].reverse();
        if (Array.isArray(discardPile)) game.discardPile = [...discardPile];
        // The round snapshot is what a restart rewinds to, so it has to move with it.
        snapshotRoundDeck(game);
        broadcastGame(io, game);
        socket.emit('__test-ready', game.deck.length);
      });

      // Deals a hand directly, so a test can start from the position it cares about
      // rather than the twenty draws it would take to reach it.
      socket.on('__test-set-hand', (gameId, playerId, hand) => {
        const game = games.get(gameId);
        const player = game && game.players.find(p => p.id === playerId);
        if (!player || !hand) return;
        if (Array.isArray(hand.regularCards)) player.regularCards = [...hand.regularCards];
        if (Array.isArray(hand.specialCards)) player.specialCards = [...hand.specialCards];
        if (typeof hand.totalScore === 'number') player.totalScore = hand.totalScore;
        updatePlayerScore(player);
        broadcastGame(io, game);
        socket.emit('__test-ready', player.regularCards.length);
      });
    }

    socket.on('disconnect', () => {
      console.log(`Disconnected: ${socket.id}`);

      games.forEach((game, gameId) => {
        const index = game.players.findIndex(p => p.id === socket.id);
        if (index === -1) return;

        const player = game.players[index];

        // Mid-round the seat is held open: their hand, their banked total and possibly
        // the current turn are all still part of the round, and none of it can be
        // fairly unpicked. Everyone waits instead, and the host can kick them out if
        // they never come back.
        if (game.status === 'playing') {
          player.connected = false;
          player.disconnectedAt = Date.now();
          // Not logged here: the one-second sweeper logs it if and when the grace period
          // runs out, so a two-second blip leaves no trace in the action log.

          // Bots are marked connected, so this has to ask for a person specifically -
          // otherwise a table of bots nobody is watching never gets collected.
          if (!game.players.some(p => p.connected && !isBot(p))) scheduleAbandonTimer(gameId);

          broadcastGame(io, game);
          return;
        }

        // In the lobby and on the end screen the seat is held too, just on a shorter
        // clock than a round: there is no hand to protect, but there is a place in a
        // game that people are standing around waiting to start. See scheduleLobbyRelease.
        player.connected = false;
        player.disconnectedAt = Date.now();
        scheduleLobbyRelease(io, gameId, player.token);

        // Bots do not keep a table alive, and neither does a held seat on its own. A
        // lobby whose only human walked away is collected on the usual abandon clock
        // rather than the instant their socket dropped.
        if (!game.players.some(p => p.connected && !isBot(p))) scheduleAbandonTimer(gameId);

        broadcastGame(io, game);
      });
    });
};

const handleSocketConnection = (io) => {
  io.on('connection', registerHandlers(io));
};

// Helper functions
const createPlayer = (id, name) => ({
  id,
  // Stable across reconnects, unlike id. Never leaves the server except to its owner.
  token: uuidv4(),
  connected: true,
  disconnectedAt: null,
  name,
  regularCards: [],
  specialCards: [],
  status: 'waiting',
  roundScore: 0,
  totalScore: 0,
  bustedCard: null,
  drawThreeRemaining: 0,  // Track how many more cards player must draw
  pendingSpecialCard: null,  // Track pending special cards during D3 sequences
  pendingTarget: null,  // Targeting card awaiting a pick, re-sent on reconnect
  stats: freshStats()
});

// ---------------------------------------------------------------------------
// Bot seats
//
// A bot is an ordinary player in game.players. It has a hand, a score, stats and a
// turn, and every rule that applies to a person applies to it, because it goes through
// the same handlers. The only things that know a bot is a bot are: the places that mean
// "is a person still here" (syncHost, the abandon timer, the lobby cleanup), the
// scheduler at the bottom of this section, and the badge the client draws.
//
// Bots are marked connected. That is deliberate, and it is the reason isPaused did not
// have to change: an unconnected seat pauses the whole table forever. The cost is that
// "somebody is connected" stops meaning "somebody is here", which is why the places
// that relied on it now ask for a human specifically.
// ---------------------------------------------------------------------------

const createBot = (game, personalityKey) => {
  const traits = botPersonality(personalityKey);
  const name = pickBotName(traits, game.players.map(p => p.name), game.players.length + 1);

  return {
    ...createPlayer(`bot:${uuidv4()}`, name),
    // No token, ever. findByToken only matches a non-empty string, so there is no way
    // for any client to rejoin into a bot's seat or to be handed its identity.
    token: null,
    isBot: true,
    bot: { personality: traits.key, label: traits.label },
    connected: true
  };
};

// Turns a seat that has dropped into a bot without moving it.
//
// The index has to stay where it is - currentPlayer is an index, not an id - and
// everything that belongs to the round stays with it: the cards on the table, the
// banked score, the stats, and a target popup that was left open mid-turn. Only the
// identity changes, so from the table's point of view the same player carries on, just
// not under their own steam.
const botifySeat = (game, index) => {
  const player = game.players[index];
  // Spread across the personalities the same way a lobby full of bots is.
  const botsSoFar = game.players.filter(isBot).length;
  const traits = botPersonality(PERSONALITY_KEYS[botsSoFar % PERSONALITY_KEYS.length]);

  const bot = {
    ...player,
    // A fresh id: the old one is a socket that has gone, and the puppet socket is keyed
    // by whatever this is.
    id: `bot:${uuidv4()}`,
    // No token, ever - the same rule createBot follows. findByToken only matches a
    // non-empty string, so nulling it is what stops the person who dropped rejoining
    // into a seat that is now being played for them.
    token: null,
    isBot: true,
    bot: { personality: traits.key, label: traits.label },
    connected: true,
    disconnectedAt: null
  };

  game.players[index] = bot;

  // botCount is what a rematch rebuilds the table from, so it has to agree with the
  // table it is describing.
  game.settings = {
    ...settingsOf(game),
    botCount: Math.min(MAX_PLAYERS - 1, game.players.filter(isBot).length)
  };

  return bot;
};

// The setting says how many bots there should be; this is what makes game.players
// agree. Reconciling rather than storing the count twice means a rematch, a reset or a
// player leaving can never leave the two out of step.
const syncBotSeats = game => {
  if (game.status !== 'lobby') return;

  // People take priority over bots, so the count is re-clamped to whatever is left.
  const wanted = wantedBotCount(botCountOf(game), humansIn(game).length);
  game.settings = { ...settingsOf(game), botCount: wanted };

  const bots = game.players.filter(isBot);

  // Newest out first, so turning the number down takes back the seat last added.
  while (bots.length > wanted) {
    const doomed = bots.pop();
    const index = game.players.indexOf(doomed);
    if (index !== -1) game.players.splice(index, 1);
    botSockets.delete(doomed.id);
  }

  // Spread across the personalities rather than four of the same one, so a table of
  // bots plays like four different people.
  while (bots.length < wanted) {
    const bot = createBot(game, PERSONALITY_KEYS[bots.length % PERSONALITY_KEYS.length]);
    game.players.push(bot);
    bots.push(bot);
  }
};

// A bot has no connection, but every rule in registerHandlers is written against a
// socket. So a bot seat gets one of these: exactly enough of the shape for those
// handlers to run untouched, and nothing else.
//
// The one thing it must never do is act on an emit. handleSpecialCard emits the target
// popup from inside the flip-card handler, so answering there would re-enter a handler
// that has not finished - half-applied state, and an advanceTurn inside an advanceTurn.
// Every emit is therefore swallowed. The server has already recorded pendingTarget by
// that point, and the scheduler picks it up on a later tick.
const botSockets = new Map();

const createBotSocket = (io, botId) => {
  const handlers = new Map();

  const socket = {
    id: botId,
    data: {},
    rooms: new Set(),
    on: (event, handler) => { handlers.set(event, handler); },
    // Rate limiting exists for a tab holding a key down. A bot acts once every second
    // or two, so there is nothing here to limit.
    use: () => {},
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => {} }),
    emit: (event, ...args) => {
      // Worth seeing in the log: it means the bot picked a move the rules refused, and
      // the scheduler is about to retry or fall back.
      if (event === 'error') console.log(`Bot ${botId} was told: ${args[0]}`);
    },
    // The only way anything ever reaches those handlers.
    fire: (event, ...args) => {
      const handler = handlers.get(event);
      if (handler) handler(...args);
    }
  };

  registerHandlers(io)(socket);
  return socket;
};

const botSocketFor = (io, botId) => {
  let socket = botSockets.get(botId);
  if (!socket) {
    socket = createBotSocket(io, botId);
    botSockets.set(botId, socket);
  }
  return socket;
};

const releaseBotSockets = game => {
  game.players.filter(isBot).forEach(p => botSockets.delete(p.id));
};

// ---------------------------------------------------------------------------
// Bot turns
//
// Driven from one interval rather than a timer per turn, so no code path can leave a
// stale timer behind or fire one twice. turnStateKey already changes on everything that
// counts as the turn moving on - the seat, the round, each card still owed from a Draw
// Three, and a target popup opening - so it doubles as "this is a new decision to make".
// ---------------------------------------------------------------------------

const BOT_TICK_MS = 250;
// How long before a move the rules refused is tried again.
const BOT_RETRY_MS = 700;
// A bot the rules keep refusing would otherwise sit there until the 120 second turn
// timer busted it. Well before that, it plays something guaranteed legal instead.
const BOT_STUCK_MS = 5000;

// Everything lib/bot.js is allowed to see. game.deck is in here because a Select
// genuinely shows its holder the whole pile; lib/bot.js reads it for that one decision
// and for nothing else.
const botView = game => ({
  players: game.players,
  currentPlayer: game.currentPlayer,
  deckMode: deckModeOf(game),
  winningScore: winningScoreOf(game),
  maxRegularCards: MAX_REGULAR_CARDS,
  roundNumber: game.roundNumber,
  deck: game.deck
});

// Each move lib/bot.js can return, and the socket event that performs it. gameId is
// prepended by the caller, because every one of these handlers takes it first.
const BOT_MOVE_EVENTS = {
  flip: () => ['flip-card'],
  stand: () => ['stand'],
  freeze: move => ['freeze-player', move.targetId],
  'draw-three': move => ['draw-three-select', move.targetId],
  'remove-card': move => ['remove-card', move.targetId, move.cardIndex, move.isSpecial],
  'steal-card': move => ['steal-card', move.targetId, move.cardIndex, move.isSpecial],
  'swap-cards': move => ['swap-cards', move.card1, move.card2],
  'select-card': move => ['select-card-choice', move.card]
};

// Last resort for a bot the rules will not let move - a state lib/bot.js has no answer
// for, or one where it keeps picking something that gets refused. Puts the table back
// into a position somebody can play from rather than leaving it to time out, and
// deliberately takes the dullest legal option rather than a scoring one.
const botFailSafe = (game, bot, io) => {
  logHistory(game, { player: bot.name, action: 'bot-skip' });
  console.log(`Bot ${bot.name} could not move; falling back.`);

  // A card waiting on a target it is never going to get goes to the discard pile,
  // exactly as handleSpecialCard does when there is no valid target to aim it at.
  const pending = bot.pendingTarget;
  if (pending) {
    bot.pendingTarget = null;
    if (removeOneCard(bot.specialCards, pending)) game.discardPile.push(pending);
  }

  bot.pendingSpecialCard = null;
  bot.drawThreeRemaining = 0;
  if (bot.status === 'active') bot.status = 'stood';

  advanceTurn(game);
  checkGameStatus(game, io);
  broadcastGame(io, game);
};

const runBotTurns = io => {
  const now = Date.now();

  games.forEach(game => {

    // The same conditions refreshTurnDeadline uses. A paused table, a round being
    // scored and a finished game are all times when nobody may act, bots included.
    if (game.status !== 'playing' || game.roundEnding || isPaused(game)) {
      game.botClock = null;
      return;
    }

    const seat = game.players[game.currentPlayer];
    const key = turnStateKey(game);
    if (!isBot(seat) || !key) {
      game.botClock = null;
      return;
    }

    // A new decision earns a fresh pause, sized by how close a call it is - so a bot
    // hesitates in the places a person would. The same key coming round again means the
    // last move changed nothing, and the stuck clock keeps running.
    if (!game.botClock || game.botClock.key !== key) {
      const preview = decideBotMove(botView(game));
      game.botClock = {
        key,
        since: now,
        actAt: now + botThinkDelay(seat.bot && seat.bot.personality, preview.confidence)
      };
      return;
    }

    const clock = game.botClock;
    if (now < clock.actAt) return;

    if (now - clock.since > BOT_STUCK_MS) {
      game.botClock = null;
      return botFailSafe(game, seat, io);
    }

    // Decided again at the moment of acting rather than reusing the one that sized the
    // pause, so a move the rules refused gets a genuinely different try next time.
    const move = decideBotMove(botView(game));
    const toEvent = BOT_MOVE_EVENTS[move.type];

    // 'skip', or a move type this file has not been taught: nothing legal here.
    if (!toEvent) {
      game.botClock = null;
      return botFailSafe(game, seat, io);
    }

    // Set before firing, so a refused move waits rather than spinning.
    clock.actAt = now + BOT_RETRY_MS;

    const [event, ...args] = toEvent(move);
    botSocketFor(io, seat.id).fire(event, game.id, ...args);
  });
};

// The rule is applyNumberCard in lib/rules.js; this is the announcement of it. Keeping
// the two apart is what lets every duplicate/bust/seven case be tested without a socket.
const handleNumberCard = (game, player, card, io) => {
  const { outcome } = applyNumberCard(game, player, card);

  if (outcome === 'second-chance') {
    bump(player, 'secondChances');
    logHistory(game, { player: player.name, action: 'second-chance', cards: [card] });
    io.to(game.id).emit('play-sound', 'secondChanceSound');
  } else if (outcome === 'bust') {
    bump(player, 'busts');
    logHistory(game, { player: player.name, action: 'bust', cards: [card] });
    io.to(game.id).emit('play-sound', 'bustCardSound');
  } else if (outcome === 'seven') {
    bump(player, 'sevens');
    logHistory(game, { player: player.name, action: 'seven-bonus' });
  }
};

// Add these new helper functions
const handlePendingSpecialCard = (game, player, socket, io) => {
  const card = player.pendingSpecialCard;
  player.pendingSpecialCard = null; // Clear the pending card
  if (card === 'Select') {
    handleSelectCard(game, player, socket, io);
    return;
  }
  handleSpecialCard(game, player, card, socket, io);
};

// The card is already in the player's hand by the time this runs - it is either
// discarded unused (no legal target) or held until the player picks one. Holding it
// records pendingTarget, which is what keeps the turn from moving on without a pick and
// what lets the popup be rebuilt if the holder's page goes away.
const handleSpecialCard = (game, player, card, socket, io) => {
  const discardUnplayable = message => {
    player.pendingTarget = null;
    removeOneCard(player.specialCards, card);
    game.discardPile.push(card);
    logHistory(game, { player: player.name, action: 'discard', cards: [card] });
    if (message) socket.emit('error', message);
    advanceTurn(game);
    checkGameStatus(game, io);
    broadcastGame(io, game);
  };

  // Target lists go out as whole player objects, so they need the same scrubbing a
  // broadcast gets - otherwise the popup hands every reconnect token to one player.
  const awaitTarget = (event, targets) => {
    player.pendingTarget = card;
    socket.emit(event, game.id, publicPlayers(targets));
  };

  // Who the card may legally be aimed at is a rule, and it lives in lib/rules.js. All
  // that is left here is which popup to open and what to say when there is nobody.
  const POPUPS = {
    D3: ['select-draw-three-target', 'No one can draw three cards. Turn skipped.'],
    Freeze: ['select-freeze-target', 'No one left to freeze. Turn skipped.'],
    RC: ['select-remove-card-target', 'No cards to remove. Turn skipped.'],
    ST: ['select-steal-card-target', 'No cards to steal. Turn skipped.'],
    Swap: ['select-swap-cards', 'Not enough players with cards to swap. Turn skipped.']
  };

  const popup = POPUPS[card];
  if (!popup) return;

  const [event, noTargetMessage] = popup;
  const targets = eligibleTargets(card, game, player);

  if (targets.length === 0) {
    discardUnplayable(noTargetMessage);
    return;
  }

  // Emit game-update so clients see Swap in special cards before the popup shows.
  if (card === 'Swap') broadcastGame(io, game);
  awaitTarget(event, targets);
};

const handleSelectCard = (game, player, socket, io, deckForPopup = null, fullDeck = null) => {
  const popupDeck = Array.isArray(deckForPopup) ? deckForPopup : game.deck;
  player.pendingTarget = 'Select';
  // Sorted, so the popup does not double as a look at the draw order.
  socket.emit(
    'select-card-from-pile',
    game.id,
    sortDeckForDisplay(popupDeck),
    fullDeck ? sortDeckForDisplay(fullDeck) : fullDeck
  );
};

// Binds a live socket to a seat that already exists. Both ways back into a game - the
// stored token and reclaiming from the landing page - come through here, so a reconnect
// behaves identically however it was triggered.
const attachToSeat = (game, player, socket, io, { rotateToken = false } = {}) => {
  // Before the rotation below, or the timer would be left keyed to a token nobody holds
  // any more and would free this seat out from under the person now sitting in it.
  cancelLobbyHold(game.id, player.token);

  if (rotateToken) {
    const wasOriginalHost = game.hostToken === player.token;
    player.token = uuidv4();
    // hostToken names the original host by token, so rotating one has to carry the other
    // or the host would silently lose their powers for the rest of the game.
    if (wasOriginalHost) game.hostToken = player.token;
  }

  // Two live sockets on one seat would both be able to act. The newest wins: on a dropped
  // connection the server may not have noticed the old socket is gone yet.
  const previousId = player.id;
  // Read before the flags below clear it. Only somebody the table was actually waiting on
  // is worth announcing - a blip inside the grace period was never announced as leaving.
  const wasMissing = isMissing(player);
  player.id = socket.id;
  player.connected = true;
  player.disconnectedAt = null;
  socket.join(game.id);

  cancelAbandonTimer(game.id);

  if (wasMissing && previousId !== socket.id) {
    logHistory(game, { player: player.name, action: 'reconnected' });
  }

  syncHost(game);
  socket.emit('rejoined', { game: publicGame(game), token: player.token });
  broadcastGame(io, game);

  // The popup this player was looking at died with their old page, and the round cannot
  // continue until they pick, so it has to be put back.
  if (player.pendingTarget && isCurrentTurn(game, socket.id) && !isPaused(game)) {
    resendPendingTarget(game, player, socket, io);
  }
};

// Puts back the popup a reconnecting player was looking at. The choices are recomputed
// rather than remembered, because hands and statuses may have moved on while they were
// away - and if nothing is playable any more, the card is discarded, which is the right
// outcome either way.
const resendPendingTarget = (game, player, socket, io) => {
  const card = player.pendingTarget;
  if (!card) return;

  if (card === 'Select') {
    // Rebuilt rather than remembered: the pile may have reshuffled while they were away.
    if (game.deck.length === 0) reshuffleFromDiscard(game);
    socket.emit('select-card-from-pile', game.id, sortDeckForDisplay(game.deck), null);
    return;
  }

  handleSpecialCard(game, player, card, socket, io);
};

// Game status checking and round management functions
const checkGameStatus = (game, io) => {
  // Several actions end a round and then have their caller check again, so the
  // scoring below must only ever be scheduled once per round.
  if (game.roundEnding) return;

  // Check if round should end (all players are either busted, stood, or frozen)
  const allBusted = everyoneBusted(game.players);

  if (isRoundOver(game.players)) {
    game.roundEnding = true;
    logHistory(game, { action: 'round-end' });

    io.to(game.id).emit('round-summary', {
      players: publicPlayers(game.players),
      allBusted: allBusted
    });

    const epoch = game.roundEpoch;

    setTimeout(() => {
      // The game can be reset, rematched or abandoned while the summary is showing,
      // and reset/rematch replace the object this closure captured.
      if (games.get(game.id) !== game) return;
      // A restart replays the round in place, so the object is the same one but these
      // scores belong to a round that no longer happened.
      if (game.roundEpoch !== epoch) return;
      game.roundEnding = false;

      // bestRound is kept alongside the total, so every seat needs its stats object
      // before the scores are banked.
      game.players.forEach(player => {
        if (!player.stats) player.stats = freshStats();
      });
      bankRoundScores(game.players);

      const { winner } = decideRoundEnd(game.players, winningScoreOf(game));
      if (winner) {
        endGame(game, winner, io);
      } else {
        startNewRound(game, io);
      }

      syncHost(game);
      io.to(game.id).emit('new-round', publicGame(game));
    }, ROUND_SUMMARY_MS);
  }
};

const endGame = (game, winner, io) => {
  game.status = 'finished';
  logHistory(game, { player: winner.name, action: 'game-over' });
  const { token, ...publicWinner } = winner;
  io.to(game.id).emit('game-over', {
    players: publicPlayers(game.players).map(p => ({
      ...p,
      status: p.id === winner.id ? 'winner' : p.status
    })),
    winner: publicWinner
  });
};

const startNewRound = (game, io) => {
  game.roundNumber++;
  game.roundEpoch = (game.roundEpoch || 0) + 1;
  logHistory(game, { action: 'round-start' });

  // One deck lasts the whole game. A new round does not deal a new one - the hands that
  // were on the table go onto the discard pile, where they wait for the next time the
  // draw pile actually runs out. That is the only moment anything is shuffled, and at
  // that moment whatever is in a hand is not in the pile being shuffled, which is what
  // stops a card existing twice. See reshuffleFromDiscard.
  discardAllHands(game);

  // Reset player states, but keep total scores and lastCardDrawn
  resetPlayersForRound(game.players);

  // Set starting player based on round number (cycling through players)
  game.currentPlayer = (game.roundNumber - 1) % game.players.length;
  game.status = 'playing'; // Ensure game status is set to playing
  snapshotRoundDeck(game);

  // Immediately emit game update to ensure clients get the new state
  broadcastGame(io, game);
};

// Replays the current round from the top. Banked totals survive untouched because
// roundScore is only added to totalScore when a round ends, so a restart simply throws
// away progress made in the round that was abandoned. The deck is put back the way it
// was when the round began rather than reshuffled, so what everyone has been counting
// still holds.
const restartRound = (game, io) => {
  // Any round-summary timer still pending belongs to the round being thrown away.
  game.roundEpoch = (game.roundEpoch || 0) + 1;
  game.roundEnding = false;

  game.deck = Array.isArray(game.roundStartDeck)
    ? [...game.roundStartDeck]
    : createDeck(deckModeOf(game));
  game.discardPile = Array.isArray(game.roundStartDiscard)
    ? [...game.roundStartDiscard]
    : [];
  game.lastCardDrawn = null;
  snapshotRoundDeck(game);

  resetPlayersForRound(game.players);

  game.status = 'playing';
  game.currentPlayer = (game.roundNumber - 1) % game.players.length;

  logHistory(game, { action: 'round-restart' });
  syncHost(game);
  io.to(game.id).emit('round-restarted', publicGame(game));
  broadcastGame(io, game);
};

// Move this BEFORE the catch-all route above
app.get('/join/:gameId', (req, res) => {
  const gameId = req.params.gameId;
  const game = games.get(gameId);
  
  if (!game) {
    res.redirect('/?error=game-not-found');
    return;
  }
  
  res.sendFile(__dirname + '/public/index.html');
});

// Update route handling to serve index.html for all routes
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Initialize Express app and create HTTP server
const server = http.createServer(app);

// Update port configuration for production
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.NODE_ENV === 'production' 
  ? 'https://hit7.click'
  : `http://localhost:${PORT}`;

// Initialize Socket.IO with the server
const io = createIoServer(server);

// Handle socket connections
handleSocketConnection(io);

// Start server
server.on('error', err => {
  console.error('Server error:', err);
  process.exit(1);
});

server.listen(PORT, () => {
  // The port actually bound, not the one asked for: PORT=0 means "any free port", which
  // is how the test harness starts a server without fighting a dev server for 3000.
  console.log(`Server running on port ${server.address().port}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Base URL: ${BASE_URL}`);
});

// Cleanup empty games every minute
setInterval(() => {
  games.forEach((game, id) => {
    if (game.players.length === 0) games.delete(id);
  });

  // A puppet socket outlives nothing. Anything whose seat has gone is dropped, so a
  // long-running process does not accumulate one per bot ever created.
  const live = new Set();
  games.forEach(game => game.players.forEach(p => {
    if (isBot(p)) live.add(p.id);
  }));
  [...botSockets.keys()].forEach(id => {
    if (!live.has(id)) botSockets.delete(id);
  });
}, 60000);

// One clock for every game. Re-deriving the deadline here each second rather than
// setting a timer at each turn change means no handler can leave a stale timer behind
// or forget to start one.
setInterval(() => {
  const now = Date.now();
  games.forEach(game => {
    // Somebody crossing from "blipped" to "gone" is a change nothing else broadcasts:
    // it happens on the clock rather than on a socket event, so without this the table
    // would stay unpaused on every screen while the server had already stopped it.
    const previous = game.awaySignature ? game.awaySignature.split(',') : [];
    const missing = game.players.filter(p => isMissing(p, now));
    const signature = missing.map(p => p.id).join(',');

    if (signature !== (game.awaySignature || '')) {
      // Logged here rather than on the socket event, so a flaky phone that drops and
      // recovers inside the grace period does not fill the action log with noise about
      // a pause that never happened.
      missing
        .filter(p => !previous.includes(p.id))
        .forEach(p => logHistory(game, { player: p.name, action: 'disconnected' }));

      game.awaySignature = signature;
      broadcastGame(io, game);
    }

    refreshTurnDeadline(game);
    if (game.turnDeadline && now >= game.turnDeadline) {
      game.turnDeadline = null;
      bustOnTimeout(game, io);
    }
  });
}, 1000);

// Bot turns run on their own faster clock, so a thinking pause can be a decent
// fraction of a second rather than rounded to the nearest one.
setInterval(() => runBotTurns(io), BOT_TICK_MS);
