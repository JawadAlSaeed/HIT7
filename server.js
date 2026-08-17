const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Configuration
const createIoServer = (server) => {
  return new Server(server, {
    cors: {
      origin: [
        'https://hit7.click',
        'http://localhost:3000'
      ],
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling']
  });
};

// Middleware
// Build allowed connect-src list (include ws/wss for production)
const allowedConnect = ["'self'"];
if (process.env.PRODUCTION_URL) {
  allowedConnect.push(process.env.PRODUCTION_URL);
  // Allow websocket origin for production URL (replace http(s) with ws(s))
  try {
    const wsUrl = process.env.PRODUCTION_URL.replace(/^http/, 'ws');
    allowedConnect.push(wsUrl);
  } catch (e) {
    // ignore
  }
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
const WINNING_SCORE = 200;
const MAX_REGULAR_CARDS = 7;
const MAX_PLAYERS = 6;
const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 20;
const SEVEN_CARD_BONUS = 15;
const MAX_HISTORY_ENTRIES = 200;

// Every non-number card the deck can contain, used to validate anything a client
// claims to have picked out of the deck.
const SPECIAL_CARD_TYPES = [
  '2+', '4+', '6+', '8+', '10+',
  '2-', '4-', '6-', '8-', '10-',
  '2÷', '2x',
  'SC', 'Freeze', 'D3', 'RC', 'ST', 'Swap', 'Select'
];

// Helper functions
const createDeck = () => {
  const deck = [];
  
  // Zero card (1 card)
  deck.push(0);
  
  // Regular cards (1-12) = 78 cards
  for (let number = 1; number <= 12; number++) {
    for (let i = 0; i < number; i++) {
      deck.push(number); // Add missing line to actually push the cards to the deck
    }
  }

  // Special cards = 29 cards (total 108 cards)
  const specialCards = [
    '2+', '4+', '6+', '8+', '10+',      // 5 adder cards
    '2-', '4-', '6-', '8-', '10-',      // 5 minus cards
    '2÷',                               // 1 divide card
    '2x',                               // 1 multiplier card
    'SC', 'SC', 'SC',                   // 3 second chance cards
    'Freeze', 'Freeze', 'Freeze',       // 3 freeze cards
    'D3', 'D3', 'D3',                   // 3 draw three cards
    'RC', 'RC', 'RC',                   // 3 remove card cards
    'ST', 'ST',                         // 2 steal card cards
    'Swap', 'Swap',                     // 2 swap cards
    'Select'                            // 1 select card
  ];
  deck.push(...specialCards);
  
  // Verify deck size
  if (deck.length !== 108) {
    console.error(`Invalid deck size: ${deck.length}. Expected 108 cards.`);
  }
  
  return shuffle(deck);
};

const shuffle = array => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

const isValidCard = card =>
  (typeof card === 'number' && Number.isInteger(card) && card >= 0 && card <= 12) ||
  SPECIAL_CARD_TYPES.includes(card);

const sanitizeName = name =>
  typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH) : '';

// Clients render the remaining-pile display straight from the deck, so they need to
// know what is left in it - but never the draw order. Sorting the copy that goes out
// over a broadcast keeps that display working while hiding the next card.
const sortDeckForDisplay = deck => [...deck].sort((a, b) => {
  const aIsNumber = typeof a === 'number';
  const bIsNumber = typeof b === 'number';
  if (aIsNumber && bIsNumber) return a - b;
  if (aIsNumber) return -1;
  if (bIsNumber) return 1;
  return String(a).localeCompare(String(b));
});

// A token is a player's proof of identity when they come back, so nothing sent to a
// client may carry anyone else's - it would let any player claim any seat. Target lists
// and round summaries go out as whole player objects too, so they all come through here.
const publicPlayers = players => players.map(({ token, ...player }) => player);

// roundStartDeck is the pre-round deck kept for round restarts. Sending it would hand
// out the draw order in the exact order the deck sorting below exists to hide.
const publicGame = game => {
  const { roundStartDeck, ...rest } = game;
  return {
    ...rest,
    deck: sortDeckForDisplay(game.deck),
    players: publicPlayers(game.players)
  };
};

// A hand can legitimately hold two copies of the same special card, because Steal and
// Swap move them between players. Playing one card must only ever discard that one.
const removeOneCard = (cards, card) => {
  const index = cards.indexOf(card);
  if (index === -1) return false;
  cards.splice(index, 1);
  return true;
};

const isCurrentTurn = (game, socketId) =>
  game.players[game.currentPlayer] && game.players[game.currentPlayer].id === socketId;

// Swap only moves cards that score points. Targeting cards (Freeze, D3, RC, ST,
// Swap, Select) are played the moment they are drawn, so a hand has no way to use
// one that arrives later.
const isSwappableSpecial = card =>
  card === 'SC' || card === '2x' || card === '2÷' ||
  card.endsWith('+') || card.endsWith('-');

const countSwappableCards = player =>
  player.regularCards.length + player.specialCards.filter(isSwappableSpecial).length;

// Cards that open a popup and stay in hand until the holder picks a target. The pick
// has to survive a reconnect, so the server remembers which one is outstanding rather
// than trusting the popup to still be on someone's screen.
const TARGETING_CARDS = ['D3', 'Freeze', 'RC', 'ST', 'Swap', 'Select'];

// Socket ids change on every reconnect, so anything that has to outlive a dropped
// connection is keyed by token instead.
const findByToken = (game, token) =>
  typeof token === 'string' && token
    ? game.players.find(p => p.token === token)
    : undefined;

// A round cannot be played on with someone missing: their hand, their banked score and
// possibly the current turn are all still on the table. Everyone waits instead.
const isPaused = game =>
  game.status === 'playing' && game.players.some(p => !p.connected);

// hostId is a socket id because that is what clients compare against, so it has to be
// re-derived whenever connections change. The original host gets their powers back when
// they return; until then the first connected player stands in, so there is always
// somebody able to kick a player who is never coming back.
const syncHost = game => {
  const original = findByToken(game, game.hostToken);
  const acting = (original && original.connected)
    ? original
    : game.players.find(p => p.connected);
  if (acting) game.hostId = acting.id;
};

// Every broadcast has to leave hostId pointing at a live socket, so the two always
// happen together.
const broadcastGame = (io, game) => {
  syncHost(game);
  io.to(game.id).emit('game-update', publicGame(game));
};

// Taken whenever a round begins so a restart can put the deck back exactly as it was,
// rather than reshuffling and changing what everyone has been counting.
const snapshotRoundDeck = game => {
  game.roundStartDeck = [...game.deck];
};

// Players are no longer removed when they drop, so a game everyone has walked away from
// has nobody left to clean it up and would sit in the map for the life of the process.
const ABANDON_GRACE_MS = 10 * 60 * 1000;
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
    if (!game || game.players.some(p => p.connected)) return; // Somebody came back
    games.delete(gameId);
    console.log(`Removed abandoned game ${gameId}`);
  }, ABANDON_GRACE_MS);
  // Ten minutes of pending timer over a dead game would otherwise hold the process open.
  if (typeof timer.unref === 'function') timer.unref();
  abandonTimers.set(gameId, timer);
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
const handleSocketConnection = (io) => {
  io.on('connection', socket => {
    console.log(`New connection: ${socket.id}`);

    // Use the module-level BASE_URL (calculated at startup) instead of hardcoding here

    // Update game creation to include full URL
    socket.on('create-game', playerName => {
      const name = sanitizeName(playerName);
      if (name.length < MIN_NAME_LENGTH) {
        return socket.emit('error', `Name must be at least ${MIN_NAME_LENGTH} characters!`);
      }

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
      const newGame = {
        id: gameId,
        url: gameUrl,
        hostId: socket.id,
        // Tracked by token as well, so a host who refreshes gets their powers back
        // instead of losing them to whoever happened to be standing in.
        hostToken: host.token,
        players: [host],
        deck: createDeck(),
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
      if (name.length < MIN_NAME_LENGTH) {
        return socket.emit('error', `Name must be at least ${MIN_NAME_LENGTH} characters!`);
      }

      // Joining is lobby-only: a player added mid-round would sit at 'waiting' forever,
      // since only startNewRound flips players back to 'active'.
      if (game.status !== 'lobby') {
        return socket.emit('error', 'That game has already started!');
      }

      if (game.players.length >= MAX_PLAYERS) {
        return socket.emit('error', `Game is full (${MAX_PLAYERS} players max)!`);
      }

      if (game.players.some(p => p.id === socket.id)) {
        return socket.emit('error', 'You are already in this game!');
      }

      const player = createPlayer(socket.id, name);
      game.players.push(player);
      socket.join(gameId);
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

    // What a landing-page game code can lead to. The client needs this to tell apart
    // "join this lobby", "take back a seat you lost" and "there is nothing for you here".
    socket.on('request-game-info', gameId => {
      const id = typeof gameId === 'string' ? gameId.trim().toUpperCase() : '';
      const game = games.get(id);

      if (!game) return socket.emit('game-info', { gameId: id, found: false });

      socket.emit('game-info', {
        gameId: id,
        found: true,
        status: game.status,
        playerCount: game.players.length,
        maxPlayers: MAX_PLAYERS,
        canJoin: game.status === 'lobby' && game.players.length < MAX_PLAYERS,
        // Only seats nobody is sitting in. A connected player's seat is never on offer.
        reclaimable: game.status === 'playing'
          ? game.players.filter(p => !p.connected).map(p => ({ id: p.id, name: p.name }))
          : []
      });
    });

    // Taking back a seat without a token: the route for a closed tab, a dead battery, or
    // a different device. Holding the game code is the credential, which is the same bar
    // as joining in the first place - so the seat must genuinely be empty.
    socket.on('reclaim-seat', (gameId, seatId) => {
      const game = games.get(gameId);
      if (!game) return socket.emit('error', 'That game no longer exists.');

      if (game.status !== 'playing') {
        return socket.emit('error', 'That game is not in progress.');
      }

      const player = game.players.find(p => p.id === seatId);
      if (!player) return socket.emit('error', 'That seat is no longer in the game.');

      if (player.connected) {
        return socket.emit('error', `${player.name} is already back in the game.`);
      }

      // Whoever held the old token may still have it on a device that is not this one,
      // so it stops working the moment someone reclaims the seat here.
      attachToSeat(game, player, socket, io, { rotateToken: true });
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
          // Create a new full deck for the popup only
          const fullDeck = createDeck();
          
          // Pop the Select card from the current deck
          game.deck.pop();
          
          // Track the last card drawn
          game.lastCardDrawn = 'Select';
          logHistory(game, { player: player.name, action: 'draw', cards: ['Select'] });

          player.specialCards.push('Select');

          handleSelectCard(game, player, socket, io, [], fullDeck);

          updatePlayerScore(player);
          checkGameStatus(game, io);
          broadcastGame(io, game);

          // No need for further processing - we'll handle the card selection in the select-card-choice event
          return;
        }
      }
      
      // Regular empty deck handling
      if (game.deck.length === 0) {
        console.log('Reshuffling deck...');
        game.deck = createDeck();
        game.discardPile = [];
        logHistory(game, { action: 'reshuffle' });
        console.log(`Deck reshuffled. New size: ${game.deck.length}`);
      }

      const card = game.deck.pop();

      // Track the last card drawn
      game.lastCardDrawn = card;
      logHistory(game, { player: player.name, action: 'draw', cards: [card] });

      // Send game update to all clients to refresh deck count immediately
      broadcastGame(io, game);

      // Continue with regular card handling
      // Handle number cards
      if (typeof card === 'number') {
          handleNumberCard(game, player, card, io);
          game.discardPile.push(card);
          
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
      logHistory(game, { player: player.name, action: 'stand' });
      io.to(gameId).emit('play-sound', 'standSound'); // Broadcast stand sound
      advanceTurn(game);
      checkGameStatus(game, io);
      broadcastGame(io, game);
    });

    // Update reset-game event handling
    socket.on('reset-game', gameId => {
      const game = games.get(gameId);
      if (!game) return;
      // The acting host may be a stand-in while the original is away.
      syncHost(game);
      if (socket.id === game.hostId) {
        // Reset the game state but keep players
        const resetGame = {
          ...game,
          deck: createDeck(),
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
        resetGame.players = resetGame.players.map(player => ({
          ...player,
          regularCards: [],
          specialCards: [],
          status: 'active',
          roundScore: 0,
          totalScore: 0,
          bustedCard: null,
          drawThreeRemaining: 0,
          pendingSpecialCard: null,
          pendingTarget: null
        }));

        // Update the game in the map
        games.set(gameId, resetGame);
        snapshotRoundDeck(resetGame);
        logHistory(resetGame, { action: 'round-start' });

        // Notify all players about the reset
        syncHost(resetGame);
        io.to(gameId).emit('game-reset-with-players', publicGame(resetGame));
      }
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

      // Only ever aimed at someone who has actually dropped. This is not a way to
      // remove a player who is sitting there playing.
      if (game.players[index].connected) {
        return socket.emit('error', 'You can only remove a disconnected player.');
      }

      const removed = removePlayerAt(game, index);
      logHistory(game, { player: removed.name, action: 'kicked' });

      if (game.players.length === 0) {
        cancelAbandonTimer(gameId);
        games.delete(gameId);
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
      logHistory(game, { player: player.name, action: 'draw-three', target: target.name });

      // Set current player to target
      game.currentPlayer = game.players.findIndex(p => p.id === target.id);

      // Update game state
      broadcastGame(io, game);
    });

    // Add rematch handling
    socket.on('request-rematch', (gameId) => {
      const game = games.get(gameId);
      if (!game) return;

      // Reset the game state but keep players
      const rematchGame = {
          ...game,
          deck: createDeck(),
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
          pendingTarget: null
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
      
      // Check if target is in active status - only allow removing cards from active players
      if (target.status !== 'active') {
        socket.emit('error', 'You can only remove cards from active players.');
        return;
      }
      
      // Validate card index bounds
      const cardArray = isSpecial ? target.specialCards : target.regularCards;
      if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= cardArray.length) {
        socket.emit('error', 'Invalid card index.');
        return;
      }

      // Disallow removing the remove-card (RC) itself
      if (isSpecial && target.specialCards[cardIndex] === 'RC') {
        socket.emit('error', 'You cannot remove a Remove Card.');
        return;
      }

      // Take the chosen card out first: when a player aims RC at their own hand,
      // discarding the RC first would shift every index after it.
      const removedCard = cardArray.splice(cardIndex, 1)[0];
      game.discardPile.push(removedCard);

      // Remove RC from player's special cards
      player.pendingTarget = null;
      removeOneCard(player.specialCards, 'RC');
      game.discardPile.push('RC');
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

      if (target.id === player.id) {
        socket.emit('error', 'You cannot steal from yourself.');
        return;
      }

      if (target.status === 'busted') {
        socket.emit('error', 'You cannot steal from busted players.');
        return;
      }

      const cardArray = isSpecial ? target.specialCards : target.regularCards;
      if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= cardArray.length) {
        socket.emit('error', 'Invalid card index.');
        return;
      }

      const stolenCard = cardArray.splice(cardIndex, 1)[0];

      // Consume Steal Card
      player.pendingTarget = null;
      removeOneCard(player.specialCards, 'ST');
      game.discardPile.push('ST');

      // Logged before the card is applied, so a bust from the stolen number reads
      // as the next entry rather than jumping ahead of the steal that caused it.
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

      // Logged before the duplicate check below, so a bust caused by the swap reads
      // as a consequence of it.
      logHistory(game, {
        player: player.name,
        action: 'swap',
        cards: [card1Value, card2Value],
        target: player1.name,
        target2: player2.name
      });

      const findDuplicateValue = (regularCards) => {
        const seen = new Set();
        for (const value of regularCards) {
          if (seen.has(value)) {
            return value;
          }
          seen.add(value);
        }
        return null;
      };

      const resolveSwapDuplicate = (targetPlayer, swappedValue) => {
        const duplicateValue = findDuplicateValue(targetPlayer.regularCards);
        if (duplicateValue === null) return;

        const scIndex = targetPlayer.specialCards.indexOf('SC');
        if (scIndex > -1) {
          targetPlayer.specialCards.splice(scIndex, 1);
          game.discardPile.push('SC');
          logHistory(game, {
            player: targetPlayer.name,
            action: 'second-chance',
            cards: [duplicateValue]
          });
          io.to(game.id).emit('play-sound', 'secondChanceSound');

          if (typeof swappedValue === 'number') {
            const removeIndex = targetPlayer.regularCards.findIndex(v => v === swappedValue);
            if (removeIndex !== -1) {
              targetPlayer.regularCards.splice(removeIndex, 1);
            }
          }
          return;
        }

        targetPlayer.status = 'busted';
        targetPlayer.bustedCard = duplicateValue;
        targetPlayer.roundScore = 0;
        logHistory(game, {
          player: targetPlayer.name,
          action: 'bust',
          cards: [duplicateValue]
        });
        io.to(game.id).emit('play-sound', 'bustCardSound');
      };

      // Check for duplicates when a number was placed into regularCards
      if (typeof card2Value === 'number') {
        resolveSwapDuplicate(player1, card2Value);
      }
      if (typeof card1Value === 'number') {
        resolveSwapDuplicate(player2, card1Value);
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
      } else if (game.deck.length === 0) {
        // Select was the last card in the deck, so the popup offered a fresh one
        const newDeck = createDeck();
        removeOneCard(newDeck, selectedCard);
        game.deck = newDeck;
      } else {
        // The card is not available - the deck the popup was built from is still intact,
        // so this can only be a client asking for a card the deck does not hold.
        return socket.emit('error', 'That card is no longer in the deck.');
      }

      // The Select has been spent. Anything below that needs a target of its own sets
      // pendingTarget again.
      player.pendingTarget = null;
      removeOneCard(player.specialCards, 'Select');

      // Track the last card drawn (selected)
      game.lastCardDrawn = selectedCard;
      logHistory(game, { player: player.name, action: 'select', cards: [selectedCard] });
      console.log('Last card drawn (via Select) set to:', selectedCard);
      // Process the selected card
      if (typeof selectedCard === 'number') {
        handleNumberCard(game, player, selectedCard, io);
        game.discardPile.push(selectedCard);
        
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
          logHistory(game, { player: player.name, action: 'disconnected' });

          if (!game.players.some(p => p.connected)) scheduleAbandonTimer(gameId);

          broadcastGame(io, game);
          return;
        }

        // In the lobby or once the game is finished there is nothing to hold onto, so
        // the seat is freed exactly as it always was.
        const removed = removePlayerAt(game, index);

        if (game.players.length === 0) {
          cancelAbandonTimer(gameId);
          games.delete(gameId);
          return;
        }

        logHistory(game, { player: removed.name, action: 'left' });
        broadcastGame(io, game);
      });
    });
  });
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
  pendingTarget: null  // Targeting card awaiting a pick, re-sent on reconnect
});

// currentPlayer is an index rather than an id, so splicing the array silently moves the
// turn to somebody else unless it is re-pinned to whoever actually held it.
const removePlayerAt = (game, index) => {
  const hadTurn = game.currentPlayer === index;
  const currentPlayerId = game.players[game.currentPlayer]
    ? game.players[game.currentPlayer].id
    : null;

  const [removed] = game.players.splice(index, 1);
  if (game.players.length === 0) return removed;

  if (hadTurn) {
    game.currentPlayer = index % game.players.length;
    if (game.status === 'playing' &&
        game.players[game.currentPlayer].status !== 'active') {
      advanceTurn(game);
    }
  } else {
    const currentIndex = game.players.findIndex(p => p.id === currentPlayerId);
    game.currentPlayer = currentIndex === -1 ? 0 : currentIndex;
  }

  return removed;
};

const advanceTurn = game => {
  let nextPlayer = game.currentPlayer;
  let attempts = 0;
  const playerCount = game.players.length;
  
  do {
    nextPlayer = (nextPlayer + 1) % playerCount;
    attempts++;
    
    // If we've checked all players and found no active ones, break
    if (attempts >= playerCount) {
      nextPlayer = game.currentPlayer; // Keep current player if no active players found
      break;
    }
  } while (game.players[nextPlayer].status !== 'active');
  
  game.currentPlayer = nextPlayer;
};

const handleNumberCard = (game, player, card, io) => {
  // 0 is a number card like any other: a second one is still a duplicate.
  if (player.regularCards.includes(card)) {
    const scIndex = player.specialCards.indexOf('SC');
    if (scIndex > -1) {
      player.specialCards.splice(scIndex, 1);
      game.discardPile.push('SC');
      logHistory(game, { player: player.name, action: 'second-chance', cards: [card] });
      io.to(game.id).emit('play-sound', 'secondChanceSound');
    } else {
      player.status = 'busted';
      player.bustedCard = card;
      player.roundScore = 0;
      logHistory(game, { player: player.name, action: 'bust', cards: [card] });
      io.to(game.id).emit('play-sound', 'bustCardSound');
    }
    return;
  }

  player.regularCards.push(card);
  // A full set of 7 ends that player's round. The +15 bonus is part of the round
  // score (see updatePlayerScore) so it is banked with the rest at round end.
  if (player.regularCards.length === MAX_REGULAR_CARDS) {
    player.status = 'stood';
    updatePlayerScore(player);
    logHistory(game, { player: player.name, action: 'seven-bonus' });
  }
};

const updatePlayerScore = player => {
  // A bust scores nothing, and the cards stay in hand for the round summary.
  if (player.status === 'busted') {
    player.roundScore = 0;
    return;
  }

  const uniqueRegularCards = [...new Set(player.regularCards)];
  const base = uniqueRegularCards.reduce((a, b) => a + b, 0);
  const add = player.specialCards
    .filter(c => c.endsWith('+'))
    .reduce((a, c) => a + parseInt(c), 0);
  const minus = player.specialCards
    .filter(c => c.endsWith('-'))
    .reduce((a, c) => a + parseInt(c), 0);

  // Handle divide card (2÷)
  let divide = 1;
  if (player.specialCards.includes('2÷')) {
    divide = 2;
  }

  // Handle multiplier (2x)
  let multiplier = 1;
  if (player.specialCards.includes('2x'))
    multiplier *= 2;

  // Calculate: (base + add - minus) * multiplier / divide
  let score = (base + add - minus) * multiplier;
  if (divide > 1) {
    score = Math.round(score / divide);
  }

  // Flat bonus for a full set of 7, applied after the modifiers so it is worth the
  // same 15 points however the rest of the hand scores.
  if (uniqueRegularCards.length === MAX_REGULAR_CARDS) {
    score += SEVEN_CARD_BONUS;
  }

  // Keep score at 0 if it's already 0
  player.roundScore = Math.max(0, score);
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

  if (card === 'D3') {
    // Allow targeting any active player (including self) with room for cards
    const targets = game.players.filter(p =>
      p.status === 'active' && // Only active players
      p.regularCards.length < MAX_REGULAR_CARDS // Must have room for cards
    );

    if (targets.length > 0) {
      awaitTarget('select-draw-three-target', targets);
    } else {
      discardUnplayable('No one can draw three cards. Turn skipped.');
    }
  }
  else if (card === 'Freeze') {
    // Allow targeting any active player (including self)
    const targets = game.players.filter(p =>
      p.status === 'active'
    );
    if (targets.length > 0) {
      awaitTarget('select-freeze-target', targets);
    } else {
      discardUnplayable('No one left to freeze. Turn skipped.');
    }
  }
  else if (card === 'RC') {
    const hasRemovableCard = p =>
      p.regularCards.length > 0 || p.specialCards.some(c => c !== 'RC');
    const targets = game.players.filter(p =>
      p.status === 'active' &&
      hasRemovableCard(p)
    );

    if (targets.length > 0) {
      awaitTarget('select-remove-card-target', targets);
    } else {
      discardUnplayable('No cards to remove. Turn skipped.');
    }
  }
  else if (card === 'ST') {
    const targets = game.players.filter(p =>
      p.status !== 'busted' &&
      p.id !== player.id &&
      (p.regularCards.length > 0 || p.specialCards.length > 0)
    );

    if (targets.length > 0) {
      awaitTarget('select-steal-card-target', targets);
    } else {
      discardUnplayable('No cards to steal. Turn skipped.');
    }
  }
  else if (card === 'Swap') {
    // Check if there are at least 2 players with swappable cards
    const playersWithCards = game.players.filter(p =>
      p.status !== 'busted' && countSwappableCards(p) > 0
    );

    if (playersWithCards.length >= 2) {
      // Emit game-update so clients see Swap in special cards before popup shows
      broadcastGame(io, game);
      awaitTarget('select-swap-cards', game.players);
    } else {
      discardUnplayable('Not enough players with cards to swap. Turn skipped.');
    }
  }
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
  game.discardPile.push('Select');
};

// Binds a live socket to a seat that already exists. Both ways back into a game - the
// stored token and reclaiming from the landing page - come through here, so a reconnect
// behaves identically however it was triggered.
const attachToSeat = (game, player, socket, io, { rotateToken = false } = {}) => {
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
  player.id = socket.id;
  player.connected = true;
  player.disconnectedAt = null;
  socket.join(game.id);

  cancelAbandonTimer(game.id);

  if (previousId !== socket.id) {
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
    // Not handleSelectCard: that also puts the Select into the discard pile, which
    // already happened when the popup was first opened.
    const deckIsEmpty = game.deck.length === 0;
    socket.emit(
      'select-card-from-pile',
      game.id,
      deckIsEmpty ? [] : sortDeckForDisplay(game.deck),
      deckIsEmpty ? sortDeckForDisplay(createDeck()) : null
    );
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
  const activePlayers = game.players.filter(p => p.status === 'active');
  const allBusted = game.players.every(p => p.status === 'busted');

  if (activePlayers.length === 0) {
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

      // Update total scores for non-busted players
      game.players.forEach(player => {
        if (player.status !== 'busted') {
          player.totalScore += player.roundScore;
        }
      });

      if (allBusted) {
        startNewRound(game, io);
      } else {
        // Find highest scoring player among non-busted players
        const nonBustedPlayers = game.players.filter(p => p.status !== 'busted');
        const highestScore = Math.max(...nonBustedPlayers.map(p => p.totalScore));
        const winners = nonBustedPlayers.filter(p => p.totalScore === highestScore);

        // End game if any winner is at the winning score, otherwise start new round
        if (highestScore >= WINNING_SCORE) {
          // In case of a tie, winner is the one who reached it first
          endGame(game, winners[0], io);
        } else {
          startNewRound(game, io);
        }
      }

      syncHost(game);
      io.to(game.id).emit('new-round', publicGame(game));
    }, 5000);
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

// Everything a round begins with, shared by a fresh round and a replayed one.
const resetPlayersForRound = players => {
  players.forEach(player => {
    player.regularCards = [];
    player.specialCards = [];
    player.status = 'active';
    player.roundScore = 0;
    player.bustedCard = null;
    player.drawThreeRemaining = 0;
    player.pendingSpecialCard = null;
    player.pendingTarget = null;
  });
};

const startNewRound = (game, io) => {
  game.roundNumber++;
  game.roundEpoch = (game.roundEpoch || 0) + 1;
  logHistory(game, { action: 'round-start' });

  // Don't reset deck - it persists across rounds and reshuffles when empty during gameplay
  // Only reset discard pile
  game.discardPile = [];

  // Reset player states, but keep total scores, lastCardDrawn, and deck
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

  game.deck = Array.isArray(game.roundStartDeck) ? [...game.roundStartDeck] : createDeck();
  game.discardPile = [];
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
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Base URL: ${BASE_URL}`);
});

// Cleanup empty games every minute
setInterval(() => {
  games.forEach((game, id) => {
    if (game.players.length === 0) games.delete(id);
  });
}, 60000);