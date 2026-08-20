// The deck, on its own.
//
// Pulled out of server.js so the one rule that is easy to get wrong - a card must never
// exist twice at the same time - can be tested without standing up a socket server.
// Nothing in here knows about players, sockets or the history log.

// One 0, one 1, two 2s ... twelve 12s.
const NUMBER_CARD_COUNT = 79;

// Every deck holds the same numbers. The mode only decides which specials ride along.
//
// "Normal" is the Flip 7 deck this game grew out of: the cards that only ever affect
// their own hand, plus Freeze and Draw Three. "Extreme" adds the ones that reach across
// the table and take something off somebody else.
const NORMAL_SPECIALS = [
  '2+', '4+', '6+', '8+', '10+',      // 5 adder cards
  '2x',                               // 1 multiplier card
  'SC', 'SC', 'SC',                   // 3 second chance cards
  'Freeze', 'Freeze', 'Freeze',       // 3 freeze cards
  'D3', 'D3', 'D3'                    // 3 draw three cards
];

const EXTREME_ONLY_SPECIALS = [
  '2-', '4-', '6-', '8-', '10-',      // 5 minus cards
  '2÷',                               // 1 divide card
  'RC', 'RC', 'RC',                   // 3 remove card cards
  'ST', 'ST',                         // 2 steal card cards
  'Swap', 'Swap',                     // 2 swap cards
  'Select'                            // 1 select card
];

const DECK_MODES = {
  normal: {
    id: 'normal',
    label: 'Normal',
    blurb: 'The Flip 7 deck. Numbers, Freeze, Draw Three, Second Chance and the plus cards.',
    specials: NORMAL_SPECIALS
  },
  extreme: {
    id: 'extreme',
    label: 'Extreme',
    blurb: 'Everything. Adds Remove, Steal, Swap, Select, the minus cards and Halve.',
    specials: [...NORMAL_SPECIALS, ...EXTREME_ONLY_SPECIALS]
  }
};

const DEFAULT_DECK_MODE = 'extreme';

const isDeckMode = mode => Object.prototype.hasOwnProperty.call(DECK_MODES, mode);

// Falls back rather than throwing: an unknown mode should cost a player the deck they
// asked for, never the game they are in the middle of.
const deckMode = mode => (isDeckMode(mode) ? mode : DEFAULT_DECK_MODE);

const deckSize = mode => NUMBER_CARD_COUNT + DECK_MODES[deckMode(mode)].specials.length;

// Swap only moves cards that score points. The targeting cards (Freeze, D3, RC, ST,
// Swap, Select) are played the moment they are drawn, so a hand has no way to use one
// that arrives later. Lives here rather than in server.js because it is a fact about
// the cards, and lib/bot.js has to agree with the server about it exactly.
const isSwappableSpecial = card =>
  card === 'SC' || card === '2x' || card === '2÷' ||
  card.endsWith('+') || card.endsWith('-');

const shuffle = array => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

const createDeck = (mode = DEFAULT_DECK_MODE) => {
  const deck = [0];

  for (let number = 1; number <= 12; number++) {
    for (let i = 0; i < number; i++) deck.push(number);
  }

  deck.push(...DECK_MODES[deckMode(mode)].specials);

  const expected = deckSize(mode);
  if (deck.length !== expected) {
    console.error(`Invalid deck size: ${deck.length}. Expected ${expected} cards.`);
  }

  return shuffle(deck);
};

// A real deck: when the draw pile runs out the discards are shuffled and become the new
// draw pile. Cards sitting in players' hands are not in the discard pile, so they stay
// out - which is exactly what stops the same card existing twice inside one round.
// Returns false when the discards are empty too and there is nothing to reshuffle.
const reshuffleFromDiscard = game => {
  if (!Array.isArray(game.discardPile) || game.discardPile.length === 0) return false;
  game.deck = shuffle([...game.discardPile]);
  game.discardPile = [];
  return true;
};

module.exports = {
  NUMBER_CARD_COUNT,
  DECK_MODES,
  DEFAULT_DECK_MODE,
  isDeckMode,
  deckMode,
  deckSize,
  isSwappableSpecial,
  shuffle,
  createDeck,
  reshuffleFromDiscard
};
