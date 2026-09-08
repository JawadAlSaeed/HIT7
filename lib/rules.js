// The rules, on their own.
//
// Pulled out of server.js for the same reason lib/deck.js was: these are the decisions
// that decide who wins, and every one of them used to be reachable only by standing up
// a socket server and playing a real game. Nothing in here knows about sockets, rooms,
// sounds or the history log - it takes a game and a player, changes them, and says what
// happened. server.js is what turns "what happened" into an emit and a log entry.
//
// The split is deliberate: `game` is only ever read for `players`, `deck`,
// `discardPile` and `currentPlayer`, so a test can hand these functions a four-line
// object instead of a live game.

const { isSwappableSpecial } = require('./deck');

// A hand is full at 7 numbers. Special cards do not count towards it - they are
// modifiers on the numbers, not part of the set being collected.
const MAX_REGULAR_CARDS = 7;
const MAX_PLAYERS = 6;
const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 20;
const SEVEN_CARD_BONUS = 15;

// The score a game runs to, and the choices a host may set it to. A fixed list rather
// than a free number: it is one tap on a phone, and there is nothing to validate beyond
// membership.
const DEFAULT_WINNING_SCORE = 200;
const WIN_SCORE_OPTIONS = [100, 150, 200, 300];

// Every non-number card the deck can contain, used to validate anything a client
// claims to have picked out of the deck.
const SPECIAL_CARD_TYPES = [
  '2+', '4+', '6+', '8+', '10+',
  '2-', '4-', '6-', '8-', '10-',
  '2÷', '2x',
  'SC', 'Freeze', 'D3', 'RC', 'ST', 'Swap', 'Select'
];

// Cards that open a popup and stay in hand until the holder picks a target. The pick
// has to survive a reconnect, so the server remembers which one is outstanding rather
// than trusting the popup to still be on someone's screen.
const TARGETING_CARDS = ['D3', 'Freeze', 'RC', 'ST', 'Swap', 'Select'];

const isValidCard = card =>
  (typeof card === 'number' && Number.isInteger(card) && card >= 0 && card <= 12) ||
  SPECIAL_CARD_TYPES.includes(card);

const sanitizeName = name =>
  typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH) : '';

// A hand can legitimately hold two copies of the same special card, because Steal and
// Swap move them between players. Playing one card must only ever discard that one.
const removeOneCard = (cards, card) => {
  const index = cards.indexOf(card);
  if (index === -1) return false;
  cards.splice(index, 1);
  return true;
};

const countSwappableCards = player =>
  player.regularCards.length + player.specialCards.filter(isSwappableSpecial).length;

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

// What a hand is worth right now.
//
// (sum of the distinct numbers + the plus cards - the minus cards) x 2x / 2÷, then the
// flat +15 for a full set of seven. The bonus lands after the modifiers on purpose, so
// it is worth the same 15 points however the rest of the hand scores.
//
// The numbers are de-duplicated even though a duplicate normally busts you, because a
// Second Chance leaves the hand holding one for the instant before it is cleaned up.
const scoreHand = (regularCards, specialCards) => {
  const uniqueRegularCards = [...new Set(regularCards)];
  const base = uniqueRegularCards.reduce((a, b) => a + b, 0);
  const add = specialCards
    .filter(c => c.endsWith('+'))
    .reduce((a, c) => a + parseInt(c), 0);
  const minus = specialCards
    .filter(c => c.endsWith('-'))
    .reduce((a, c) => a + parseInt(c), 0);

  const divide = specialCards.includes('2÷') ? 2 : 1;
  const multiplier = specialCards.includes('2x') ? 2 : 1;

  let score = (base + add - minus) * multiplier;
  if (divide > 1) score = Math.round(score / divide);

  if (uniqueRegularCards.length === MAX_REGULAR_CARDS) score += SEVEN_CARD_BONUS;

  // A hand can be dragged below zero by the minus cards. It is never worth negative
  // points - the worst a round can do to you is nothing.
  return Math.max(0, score);
};

// The score lives on the player because everything that can change a hand has to be
// able to refresh it, and there is no single moment when scoring happens.
const updatePlayerScore = player => {
  // A bust scores nothing, and the cards stay in hand for the round summary.
  if (player.status === 'busted') {
    player.roundScore = 0;
    return player;
  }
  player.roundScore = scoreHand(player.regularCards, player.specialCards);
  return player;
};

// Playing a number card. Returns what happened rather than announcing it, so the
// history entry, the sound and the stat all stay in server.js where the io is.
//
//   'second-chance' - it was a duplicate, and an SC ate it
//   'bust'          - it was a duplicate, and nothing saved them
//   'seven'         - it completed a set of 7, which stands the player
//   'added'         - it just went into the hand
//
// `game` is only read for its discardPile.
const applyNumberCard = (game, player, card) => {
  // 0 is a number card like any other: a second one is still a duplicate.
  if (player.regularCards.includes(card)) {
    // A duplicate never joins the hand, so this is the one path where the card leaves
    // play. Anything that does join a hand must NOT be discarded here - it is still on
    // the table, and the next reshuffle has to be able to tell the difference.
    game.discardPile.push(card);

    if (removeOneCard(player.specialCards, 'SC')) {
      game.discardPile.push('SC');
      return { outcome: 'second-chance', card };
    }

    player.status = 'busted';
    player.bustedCard = card;
    player.roundScore = 0;
    return { outcome: 'bust', card };
  }

  player.regularCards.push(card);

  // A full set of 7 ends that player's round. The +15 bonus is part of the round score
  // (see scoreHand) so it is banked with the rest at round end.
  if (player.regularCards.length === MAX_REGULAR_CARDS) {
    player.status = 'stood';
    updatePlayerScore(player);
    return { outcome: 'seven', card };
  }

  return { outcome: 'added', card };
};

// The first value that appears twice, or null. Used after a Swap, where a card can
// arrive in a hand that already holds its twin.
const findDuplicateValue = regularCards => {
  const seen = new Set();
  for (const value of regularCards) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
};

// A Swap can hand somebody a number they already hold, which is a bust exactly as if
// they had drawn it. Same shape of answer as applyNumberCard: 'second-chance', 'bust',
// or 'none' when the swap was harmless.
//
// The one difference from drawing it: an SC here removes the card that just arrived,
// not the one already in the hand, so the hand is left the way it was before the swap.
const resolveSwapDuplicate = (game, targetPlayer, swappedValue) => {
  const duplicateValue = findDuplicateValue(targetPlayer.regularCards);
  if (duplicateValue === null) return { outcome: 'none', card: null };

  if (removeOneCard(targetPlayer.specialCards, 'SC')) {
    game.discardPile.push('SC');

    if (typeof swappedValue === 'number') {
      const removeIndex = targetPlayer.regularCards.findIndex(v => v === swappedValue);
      if (removeIndex !== -1) {
        targetPlayer.regularCards.splice(removeIndex, 1);
        game.discardPile.push(swappedValue);
      }
    }
    return { outcome: 'second-chance', card: duplicateValue };
  }

  targetPlayer.status = 'busted';
  targetPlayer.bustedCard = duplicateValue;
  targetPlayer.roundScore = 0;
  return { outcome: 'bust', card: duplicateValue };
};

// Whose turn is next. Skips anybody who is not active, and stays put rather than
// looping forever if nobody is - the round is over in that case and checkGameStatus is
// about to say so.
const advanceTurn = game => {
  let nextPlayer = game.currentPlayer;
  let attempts = 0;
  const playerCount = game.players.length;

  do {
    nextPlayer = (nextPlayer + 1) % playerCount;
    attempts++;
    if (attempts >= playerCount) {
      nextPlayer = game.currentPlayer;
      break;
    }
  } while (game.players[nextPlayer].status !== 'active');

  game.currentPlayer = nextPlayer;
  return game.currentPlayer;
};

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

// Who a targeting card may legally be aimed at. Every one of these is a rule about who
// the card would actually do something to - a Freeze on somebody already stood does
// nothing, a Remove Card on an empty hand has nothing to take - and a card with no
// legal target is discarded unplayed rather than parking the turn on nobody.
//
// Returns an array. Empty means "discard it, the turn is skipped"; for Swap it means
// the same thing, because Swap needs two sides and there are not two.
const eligibleTargets = (card, game, player) => {
  switch (card) {
    // Room for cards, or the three draws have nowhere to go.
    case 'D3':
      return game.players.filter(p =>
        p.status === 'active' && p.regularCards.length < MAX_REGULAR_CARDS);

    // Anybody still playing, including yourself.
    case 'Freeze':
      return game.players.filter(p => p.status === 'active');

    // An RC in an otherwise empty hand is not removable, or the card would be spent
    // taking itself.
    case 'RC':
      return game.players.filter(p =>
        p.status === 'active' &&
        (p.regularCards.length > 0 || p.specialCards.some(c => c !== 'RC')));

    // Stealing from yourself is not a move, and a busted hand is out of play.
    case 'ST':
      return game.players.filter(p =>
        p.status !== 'busted' &&
        p.id !== player.id &&
        (p.regularCards.length > 0 || p.specialCards.length > 0));

    // Swap is the odd one: the popup shows everybody, but it is only playable at all
    // when two different players have something worth trading.
    case 'Swap':
      return game.players.filter(p =>
        p.status !== 'busted' && countSwappableCards(p) > 0).length >= 2
        ? [...game.players]
        : [];

    default:
      return [];
  }
};

// The round is over when nobody can act - everyone has stood, busted or been frozen.
const isRoundOver = players => players.every(p => p.status !== 'active');

const allBusted = players => players.every(p => p.status === 'busted');

// Round scores become totals here, and only here. Nothing else adds to totalScore,
// which is why a round restart can simply throw the round away.
const bankRoundScores = players => {
  players.forEach(player => {
    if (player.status === 'busted') return;
    player.totalScore += player.roundScore;
    if (player.stats) {
      player.stats.bestRound = Math.max(player.stats.bestRound, player.roundScore);
    }
  });
  return players;
};

// Whether that was the last round, and who took it.
//
// A wipeout - everybody busting in the same round - can never end the game, because
// nobody scored and so nobody can have crossed the line. It always deals again.
//
// A tie at or above the target goes to whoever sits higher up the table. That is
// arbitrary, but it has to be somebody, and the alternative is a game that refuses to
// end.
const decideRoundEnd = (players, winningScore) => {
  if (allBusted(players)) return { allBusted: true, winner: null };

  const survivors = players.filter(p => p.status !== 'busted');
  const highestScore = Math.max(...survivors.map(p => p.totalScore));
  const leaders = survivors.filter(p => p.totalScore === highestScore);

  return {
    allBusted: false,
    winner: highestScore >= winningScore ? leaders[0] : null
  };
};

// Sweeps the table into the discard pile at the end of a round. Deliberately separate
// from resetPlayersForRound, because a round restart throws its hands away rather than
// discarding them - those cards go back into the pile the restart is rewinding to.
const discardAllHands = game => {
  game.players.forEach(player => {
    game.discardPile.push(...player.regularCards, ...player.specialCards);
  });
  return game;
};

// Everything a round begins with, shared by a fresh round and a replayed one. Total
// scores and stats are deliberately untouched: they belong to the game, not the round.
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
  return players;
};

module.exports = {
  MAX_REGULAR_CARDS,
  MAX_PLAYERS,
  MIN_NAME_LENGTH,
  MAX_NAME_LENGTH,
  SEVEN_CARD_BONUS,
  DEFAULT_WINNING_SCORE,
  WIN_SCORE_OPTIONS,
  SPECIAL_CARD_TYPES,
  TARGETING_CARDS,
  isValidCard,
  sanitizeName,
  removeOneCard,
  countSwappableCards,
  sortDeckForDisplay,
  scoreHand,
  updatePlayerScore,
  applyNumberCard,
  findDuplicateValue,
  resolveSwapDuplicate,
  advanceTurn,
  removePlayerAt,
  eligibleTargets,
  isRoundOver,
  allBusted,
  bankRoundScores,
  decideRoundEnd,
  discardAllHands,
  resetPlayersForRound
};
