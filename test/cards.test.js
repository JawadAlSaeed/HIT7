// Remove Card and Steal, played against a real server.
//
// Both take a card index that a client chose, and both used to be the place where an
// index bug quietly took the wrong card - or a card that was not there at all. The
// rules are in lib/rules.js; these check the handlers apply them, and that the cards
// actually end up where they should.

const test = require('node:test');
const assert = require('node:assert');

const { startServer, startGame } = require('./helpers/harness');

const FILLER = [11, 12, 10, 9, 8, 6, 4, 2, 1];
const seat = (state, name) => state.players.find(p => p.name === name);

// ---------------------------------------------------------------- Remove Card

test('Remove Card takes the card it was aimed at, and only that one', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  await alice.setHand(gameId, bob.id, { regularCards: [3, 9, 5], specialCards: ['2x'] });
  await alice.stackDeck(gameId, ['RC', ...FILLER]);

  const popup = alice.once('select-remove-card-target');
  alice.emit('flip-card', gameId);
  await popup;

  const removed = alice.waitForState(
    state => seat(state, 'Bob').regularCards.length === 2,
    { what: 'a card to leave Bob' }
  );
  alice.emit('remove-card', gameId, bob.id, 1, false); // the 9
  const state = await removed;

  const bobby = seat(state, 'Bob');
  assert.deepStrictEqual(bobby.regularCards, [3, 5], 'the middle card went, the others stayed');
  assert.deepStrictEqual(bobby.specialCards, ['2x'], 'the special hand was not touched');
  assert.strictEqual(bobby.roundScore, (3 + 5) * 2, 'and the score was recomputed');

  assert.ok(state.discardPile.includes(9), 'the removed card went to the discard pile');
  assert.ok(state.discardPile.includes('RC'), 'and so did the RC that did it');
  assert.ok(!seat(state, 'Alice').specialCards.includes('RC'), 'which is no longer in hand');
});

// When a player aims RC at their own hand, discarding the RC first would shift every
// index after it - so the chosen card has to come out first.
test('Remove Card aimed at your own hand takes the card you picked', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice } = await startGame(server, ['Alice', 'Bob']);

  // The RC will be drawn and pushed onto the end of specialCards, so it sits after 2x.
  await alice.setHand(gameId, alice.id, { regularCards: [4], specialCards: ['2x'] });
  await alice.stackDeck(gameId, ['RC', ...FILLER]);

  const popup = alice.once('select-remove-card-target');
  alice.emit('flip-card', gameId);
  await popup;

  const removed = alice.waitForState(
    state => !seat(state, 'Alice').specialCards.includes('2x'),
    { what: 'the 2x to go' }
  );
  alice.emit('remove-card', gameId, alice.id, 0, true); // the 2x, at index 0
  const state = await removed;

  const her = seat(state, 'Alice');
  assert.deepStrictEqual(her.specialCards, [], 'the 2x went, and the RC was spent');
  assert.deepStrictEqual(her.regularCards, [4], 'her numbers are untouched');
});

test('Remove Card refuses a nonsense index rather than taking undefined', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  await alice.setHand(gameId, bob.id, { regularCards: [3], specialCards: [] });
  await alice.stackDeck(gameId, ['RC', ...FILLER]);

  const popup = alice.once('select-remove-card-target');
  alice.emit('flip-card', gameId);
  await popup;

  for (const index of [5, -1, 'x']) {
    const refused = alice.once('error');
    alice.emit('remove-card', gameId, bob.id, index, false);
    assert.match(await refused, /invalid card index/i, `index ${String(index)}`);
  }

  // Nothing was spent on the way: the RC is still in hand and still works.
  const landed = alice.waitForState(
    state => seat(state, 'Bob').regularCards.length === 0,
    { what: 'a legal removal to land' }
  );
  alice.emit('remove-card', gameId, bob.id, 0, false);
  const state = await landed;

  assert.ok(state.discardPile.includes(3), 'and it took the card, not undefined');
  assert.ok(
    !state.discardPile.includes(undefined),
    'nothing that does not exist reached the discard pile'
  );
});

test('a Remove Card cannot remove a Remove Card', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  await alice.setHand(gameId, bob.id, { regularCards: [], specialCards: ['RC', '2x'] });
  await alice.stackDeck(gameId, ['RC', ...FILLER]);

  const popup = alice.once('select-remove-card-target');
  alice.emit('flip-card', gameId);
  await popup;

  const refused = alice.once('error');
  alice.emit('remove-card', gameId, bob.id, 0, true);
  assert.match(await refused, /cannot remove a Remove Card/i);
});

// A hand holding nothing but an RC is not a target, or the card is spent taking one of
// its own kind - so with nobody else to aim at, the card is discarded and the turn moves.
test('an RC with nowhere to go is discarded and the turn moves on', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  // Nobody has anything removable: Bob's hand is empty, and Alice will hold only the RC.
  await alice.setHand(gameId, alice.id, { regularCards: [], specialCards: [] });
  await alice.setHand(gameId, bob.id, { regularCards: [], specialCards: [] });
  await alice.stackDeck(gameId, ['RC', ...FILLER]);

  const refused = alice.once('error');
  const moved = alice.waitForState(
    state => state.players[state.currentPlayer].name === 'Bob',
    { what: 'the turn to move to Bob' }
  );
  alice.emit('flip-card', gameId);

  assert.match(await refused, /no cards to remove/i);
  const state = await moved;

  assert.ok(state.discardPile.includes('RC'), 'the unplayable card was discarded');
  assert.ok(!seat(state, 'Alice').specialCards.includes('RC'));
});

// ---------------------------------------------------------------- Steal

test('a stolen special card changes hands', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  await alice.setHand(gameId, alice.id, { regularCards: [4], specialCards: [] });
  await alice.setHand(gameId, bob.id, { regularCards: [9], specialCards: ['2x'] });
  await alice.stackDeck(gameId, ['ST', ...FILLER]);

  const popup = alice.once('select-steal-card-target');
  alice.emit('flip-card', gameId);
  await popup;

  const stolen = alice.waitForState(
    state => seat(state, 'Alice').specialCards.includes('2x'),
    { what: 'the 2x to change hands' }
  );
  alice.emit('steal-card', gameId, bob.id, 0, true);
  const state = await stolen;

  assert.deepStrictEqual(seat(state, 'Bob').specialCards, [], 'Bob lost it');
  assert.strictEqual(seat(state, 'Alice').roundScore, 8, 'and it scores for Alice now');
  assert.strictEqual(seat(state, 'Bob').roundScore, 9, 'Bob is rescored too');
  assert.ok(state.discardPile.includes('ST'), 'the ST was spent');
});

// Stealing a number you already hold can still bust you - the stolen card goes through
// exactly the same rule as a drawn one.
test('stealing a number you already hold busts you', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  await alice.setHand(gameId, alice.id, { regularCards: [5, 7], specialCards: [] });
  await alice.setHand(gameId, bob.id, { regularCards: [5], specialCards: [] });
  await alice.stackDeck(gameId, ['ST', ...FILLER]);

  const popup = alice.once('select-steal-card-target');
  alice.emit('flip-card', gameId);
  await popup;

  const busted = alice.waitForState(
    state => seat(state, 'Alice').status === 'busted',
    { what: 'Alice to bust on her own steal' }
  );
  alice.emit('steal-card', gameId, bob.id, 0, false); // Bob's 5, which she already has
  const state = await busted;

  assert.strictEqual(seat(state, 'Alice').bustedCard, 5);
  assert.strictEqual(seat(state, 'Alice').roundScore, 0);
  assert.deepStrictEqual(seat(state, 'Bob').regularCards, [], 'Bob still lost the card');
});

test('a Second Chance saves you from a stolen duplicate', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  await alice.setHand(gameId, alice.id, { regularCards: [5, 7], specialCards: ['SC'] });
  await alice.setHand(gameId, bob.id, { regularCards: [5], specialCards: [] });
  await alice.stackDeck(gameId, ['ST', ...FILLER]);

  const popup = alice.once('select-steal-card-target');
  alice.emit('flip-card', gameId);
  await popup;

  const saved = alice.waitForState(
    state => !seat(state, 'Alice').specialCards.includes('SC'),
    { what: 'the Second Chance to be spent' }
  );
  alice.emit('steal-card', gameId, bob.id, 0, false);
  const state = await saved;

  const her = seat(state, 'Alice');
  assert.strictEqual(her.status, 'active', 'she survived it');
  assert.deepStrictEqual(her.regularCards, [5, 7], 'and the duplicate never joined her hand');
});

test('Steal refuses your own hand and an index that is not there', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  await alice.setHand(gameId, alice.id, { regularCards: [4], specialCards: [] });
  await alice.setHand(gameId, bob.id, { regularCards: [9], specialCards: [] });
  await alice.stackDeck(gameId, ['ST', ...FILLER]);

  const popup = alice.once('select-steal-card-target');
  alice.emit('flip-card', gameId);
  await popup;

  const ownHand = alice.once('error');
  alice.emit('steal-card', gameId, alice.id, 0, false);
  assert.match(await ownHand, /from yourself/i);

  const badIndex = alice.once('error');
  alice.emit('steal-card', gameId, bob.id, 3, false);
  assert.match(await badIndex, /invalid card index/i);

  // The ST is still in hand, unspent, and the turn has not moved - so a legal steal
  // still works after both refusals.
  const landed = alice.waitForState(
    state => seat(state, 'Alice').regularCards.includes(9),
    { what: 'a legal steal to land' }
  );
  alice.emit('steal-card', gameId, bob.id, 0, false);
  const state = await landed;

  assert.deepStrictEqual(seat(state, 'Alice').regularCards, [4, 9]);
  assert.deepStrictEqual(seat(state, 'Bob').regularCards, []);
});

// Only the player whose turn it is may play a targeting card. Anything else arriving is
// a client not playing by the rules.
test('a targeting card cannot be played out of turn', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  // Bob holds an ST, but it is Alice's turn.
  await alice.setHand(gameId, bob.id, { regularCards: [9], specialCards: ['ST'] });
  await alice.setHand(gameId, alice.id, { regularCards: [4], specialCards: [] });

  bob.emit('steal-card', gameId, alice.id, 0, false);

  // Alice plays normally, and the state that comes back shows Bob's steal never happened.
  await alice.stackDeck(gameId, [3, ...FILLER]);
  const drawn = alice.waitForState(
    state => seat(state, 'Alice').regularCards.includes(3),
    { what: 'Alice to draw' }
  );
  alice.emit('flip-card', gameId);
  const state = await drawn;

  assert.deepStrictEqual(seat(state, 'Alice').regularCards, [4, 3], 'Alice kept her 4');
  assert.ok(seat(state, 'Bob').specialCards.includes('ST'), 'and Bob still holds the ST');
});
