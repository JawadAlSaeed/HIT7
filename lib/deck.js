// The deck, on its own.
//
// Pulled out of server.js so the one rule that is easy to get wrong - a card must never
// exist twice at the same time - can be tested without standing up a socket server.
// Nothing in here knows about players, sockets or the history log.

const DECK_SIZE = 108;

const SPECIAL_CARDS = [
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

const shuffle = array => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

// One 0, one 1, two 2s ... twelve 12s, plus the specials.
const createDeck = () => {
  const deck = [0];

  for (let number = 1; number <= 12; number++) {
    for (let i = 0; i < number; i++) deck.push(number);
  }

  deck.push(...SPECIAL_CARDS);

  if (deck.length !== DECK_SIZE) {
    console.error(`Invalid deck size: ${deck.length}. Expected ${DECK_SIZE} cards.`);
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

module.exports = { DECK_SIZE, SPECIAL_CARDS, shuffle, createDeck, reshuffleFromDiscard };
