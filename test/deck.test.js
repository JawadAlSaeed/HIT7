const test = require('node:test');
const assert = require('node:assert');

const {
  DECK_MODES,
  DEFAULT_DECK_MODE,
  NUMBER_CARD_COUNT,
  createDeck,
  deckSize,
  isDeckMode,
  reshuffleFromDiscard
} = require('../lib/deck');

const DECK_SIZE = deckSize(DEFAULT_DECK_MODE);

// How many copies of each card a full deck holds. Anything more than this in play at
// once means a card has been duplicated.
const expectedCounts = () => {
  const counts = new Map();
  for (const card of createDeck()) {
    counts.set(card, (counts.get(card) || 0) + 1);
  }
  return counts;
};

const countCards = cards => {
  const counts = new Map();
  for (const card of cards) counts.set(card, (counts.get(card) || 0) + 1);
  return counts;
};

test('a fresh deck is 108 cards', () => {
  assert.strictEqual(createDeck().length, 108);
  assert.strictEqual(DECK_SIZE, 108);
});

test('normal is the 94-card Flip 7 deck, extreme is 108', () => {
  assert.strictEqual(createDeck('normal').length, 94);
  assert.strictEqual(createDeck('extreme').length, 108);
  assert.strictEqual(deckSize('normal'), 94);
  assert.strictEqual(deckSize('extreme'), 108);
});

test('both modes hold the same 79 number cards', () => {
  for (const mode of Object.keys(DECK_MODES)) {
    const numbers = createDeck(mode).filter(card => typeof card === 'number');
    assert.strictEqual(numbers.length, NUMBER_CARD_COUNT, `${mode} numbers`);
  }
});

test('normal leaves out every card that reaches across the table', () => {
  const normal = createDeck('normal');
  for (const card of ['RC', 'ST', 'Swap', 'Select', '2-', '4-', '6-', '8-', '10-', '2÷']) {
    assert.ok(!normal.includes(card), `normal should not contain ${card}`);
  }
  // The ones it keeps, it keeps in full.
  for (const card of ['Freeze', 'D3', 'SC', '2x', '10+']) {
    assert.ok(normal.includes(card), `normal should contain ${card}`);
  }
});

test('extreme is normal plus the extra cards, nothing removed', () => {
  const countCardsIn = mode => countCards(createDeck(mode));
  const normal = countCardsIn('normal');
  const extreme = countCardsIn('extreme');

  for (const [card, count] of normal) {
    assert.ok(extreme.get(card) >= count, `extreme dropped ${card}`);
  }
});

test('an unknown deck mode falls back instead of throwing', () => {
  assert.strictEqual(isDeckMode('nonsense'), false);
  assert.strictEqual(createDeck('nonsense').length, deckSize(DEFAULT_DECK_MODE));
  assert.strictEqual(createDeck(undefined).length, deckSize(DEFAULT_DECK_MODE));
});

test('a fresh deck holds one 0, one 1, two 2s ... twelve 12s', () => {
  const counts = countCards(createDeck());
  assert.strictEqual(counts.get(0), 1);
  for (let number = 1; number <= 12; number++) {
    assert.strictEqual(counts.get(number), number, `expected ${number} copies of ${number}`);
  }
});

test('shuffling does not change what is in the deck', () => {
  const a = countCards(createDeck());
  const b = countCards(createDeck());
  assert.strictEqual(a.size, b.size);
  for (const [card, count] of a) assert.strictEqual(b.get(card), count);
});

test('reshuffle takes the discard pile and nothing else', () => {
  const game = { deck: [], discardPile: [3, 3, 'Freeze', 7] };

  assert.strictEqual(reshuffleFromDiscard(game), true);
  assert.strictEqual(game.deck.length, 4);
  assert.deepStrictEqual(countCards(game.deck), countCards([3, 3, 'Freeze', 7]));
  assert.deepStrictEqual(game.discardPile, []);
});

test('reshuffle reports failure when there is nothing to reshuffle', () => {
  const game = { deck: [], discardPile: [] };
  assert.strictEqual(reshuffleFromDiscard(game), false);
  assert.deepStrictEqual(game.deck, []);
});

test('reshuffle never mints a card that is sitting in a hand', () => {
  // A round in progress: some cards drawn into hands, the rest discarded, draw pile dry.
  const deck = createDeck();
  const hands = [deck.splice(0, 7), deck.splice(0, 7), deck.splice(0, 5)];
  const game = { deck: [], discardPile: deck };

  assert.strictEqual(reshuffleFromDiscard(game), true);

  const inPlay = countCards([...game.deck, ...hands.flat()]);
  const limits = expectedCounts();
  for (const [card, count] of inPlay) {
    assert.ok(
      count <= limits.get(card),
      `${card} appears ${count} times but the deck only holds ${limits.get(card)}`
    );
  }
  // Nothing vanished either: hands plus pile is still the whole deck.
  assert.strictEqual(game.deck.length + hands.flat().length, DECK_SIZE);
});

test('repeated reshuffles inside a round still cannot duplicate a card', () => {
  const deck = createDeck();
  const hand = deck.splice(0, 6);
  const game = { deck, discardPile: [] };
  const limits = expectedCounts();

  // Drain the pile into the discards and reshuffle, over and over.
  for (let round = 0; round < 5; round++) {
    while (game.deck.length > 0) game.discardPile.push(game.deck.pop());
    assert.strictEqual(reshuffleFromDiscard(game), true);

    const inPlay = countCards([...game.deck, ...hand]);
    for (const [card, count] of inPlay) {
      assert.ok(count <= limits.get(card), `${card} duplicated on pass ${round}`);
    }
  }
});
