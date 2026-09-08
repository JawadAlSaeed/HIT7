// The five paths the audit called out as hardest to reason about, played for real.
//
// Each of these is a sequence across several socket handlers, not a function that can
// be called with arguments - so these run a real server.js on a free port and drive it
// with real socket.io clients. The deck is stacked so the sequences happen every time
// instead of once in a thousand shuffles. See test/helpers/harness.js.

const test = require('node:test');
const assert = require('node:assert');

const { startServer, startGame } = require('./helpers/harness');

// Filler that is safe to draw: plain numbers nobody in these tests already holds.
const FILLER = [11, 12, 10, 9, 8, 6, 4, 2, 1];

const seat = (state, name) => state.players.find(p => p.name === name);

// ------------------------------------------------ 1. a Draw Three that draws a target

test('a targeting card drawn mid Draw Three waits until the three are done', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  // Alice draws D3, aims it at herself, and the three draws hand her a Freeze in the
  // middle. The Freeze must not fire there - it has to wait for the run to finish.
  await alice.stackDeck(gameId, ['D3', 3, 'Freeze', 5, ...FILLER]);

  const drawThreePopup = alice.once('select-draw-three-target');
  alice.emit('flip-card', gameId);
  await drawThreePopup;

  const aimed = alice.waitForState(
    state => seat(state, 'Alice').drawThreeRemaining === 3,
    { what: 'Alice to be on three draws' }
  );
  alice.emit('draw-three-select', gameId, alice.id);
  await aimed;

  // First draw of the three: an ordinary number.
  const afterFirst = alice.waitForState(
    state => seat(state, 'Alice').drawThreeRemaining === 2,
    { what: 'two draws left' }
  );
  alice.emit('flip-card', gameId);
  await afterFirst;

  // Second: the Freeze. It joins the hand and is held, not played.
  const afterFreeze = alice.waitForState(
    state => seat(state, 'Alice').drawThreeRemaining === 1,
    { what: 'one draw left' }
  );
  alice.emit('flip-card', gameId);
  const heldState = await afterFreeze;

  const holding = seat(heldState, 'Alice');
  assert.ok(holding.specialCards.includes('Freeze'), 'the Freeze is in her hand');
  assert.strictEqual(holding.pendingSpecialCard, 'Freeze', 'and is queued, not fired');
  assert.strictEqual(bob.socket.connected, true);
  assert.strictEqual(
    seat(heldState, 'Bob').status, 'active',
    'Bob is not frozen halfway through somebody else move'
  );

  // Third and last draw: now the Freeze fires and asks for a target.
  const freezePopup = alice.once('select-freeze-target');
  alice.emit('flip-card', gameId);
  const targets = await freezePopup;

  assert.ok(Array.isArray(targets[1]), 'the popup carries a target list');
  assert.deepStrictEqual(
    targets[1].map(p => p.name).sort(), ['Alice', 'Bob'],
    'both players are still freezable'
  );

  // And the aimed Freeze does what it says.
  const frozen = alice.waitForState(
    state => seat(state, 'Bob').status === 'stood',
    { what: 'Bob to be frozen' }
  );
  alice.emit('freeze-player', gameId, bob.id);
  const finalState = await frozen;

  assert.ok(
    !seat(finalState, 'Alice').specialCards.includes('Freeze'),
    'the Freeze is spent'
  );
  assert.strictEqual(seat(finalState, 'Alice').drawThreeRemaining, 0);
});

// A held targeting card owns the turn. This is the rule that stops ignoring the popup
// and flipping again being worth free cards.
test('a pending target holds the turn - flipping again does nothing', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);
  await alice.stackDeck(gameId, ['Freeze', 7, 5, ...FILLER]);

  const popup = alice.once('select-freeze-target');
  alice.emit('flip-card', gameId);
  await popup;

  await alice.waitForState(
    state => seat(state, 'Alice').pendingTarget === 'Freeze',
    { what: 'the Freeze to be pending' }
  );

  // Flip twice more, then do something that definitely broadcasts, and check nothing
  // moved in between.
  alice.emit('flip-card', gameId);
  alice.emit('flip-card', gameId);

  const after = alice.waitForState(
    state => seat(state, 'Bob').status === 'stood',
    { what: 'Bob to be frozen' }
  );
  alice.emit('freeze-player', gameId, bob.id);
  const state = await after;

  assert.deepStrictEqual(
    seat(state, 'Alice').regularCards, [],
    'the ignored flips drew nothing'
  );
});

// ------------------------------------------------ 2. Select as the last card

test('a Select drawn as the last card picks from the reshuffled discards', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  // One card left, and it is the Select. Taking it empties the draw pile, so the
  // choices have to come from the discards - the cards that genuinely still exist.
  const discards = [4, 9, '2x', 6];
  await alice.stackDeck(gameId, ['Select'], discards);

  const popup = alice.once('select-card-from-pile');
  alice.emit('flip-card', gameId);
  const [, offered] = await popup;

  assert.deepStrictEqual(
    [...offered].sort(), [...discards].sort(),
    'the choices are exactly the discards, nothing invented'
  );

  const chosen = alice.waitForState(
    state => seat(state, 'Alice').regularCards.includes(9),
    { what: 'Alice to take the 9' }
  );
  alice.emit('select-card-choice', gameId, 9);
  const state = await chosen;

  const ada = seat(state, 'Alice');
  assert.ok(!ada.specialCards.includes('Select'), 'the Select is spent');
  assert.strictEqual(ada.pendingTarget, null, 'and the turn is free to move');
  assert.strictEqual(state.players[state.currentPlayer].name, 'Bob', 'the turn moved on');

  // The invariant the whole real-deck rework exists to protect: the 9 is now in a hand,
  // so it must not also be sitting in the pile.
  const inPlay = [...state.deck, ...state.discardPile];
  assert.strictEqual(
    inPlay.filter(c => c === 9).length, 0,
    'the card that was taken is not still in the pile'
  );
  assert.strictEqual(bob.socket.connected, true);
});

test('a Select cannot be used to take a card that does not exist', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice } = await startGame(server, ['Alice', 'Bob']);
  await alice.stackDeck(gameId, ['Select'], [4, 9]);

  const popup = alice.once('select-card-from-pile');
  alice.emit('flip-card', gameId);
  await popup;

  const refused = alice.once('error');
  alice.emit('select-card-choice', gameId, 11); // not in the pile
  assert.match(await refused, /no longer in the deck/i);

  const stillRefused = alice.once('error');
  alice.emit('select-card-choice', gameId, 'nonsense'); // not a card at all
  assert.match(await stillRefused, /not a valid card/i);
});

// ------------------------------------------------ 3. Second Chance eaten by a Swap

test('a Second Chance saves a player from a duplicate arriving by Swap', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  // Bob already holds a 5 and a Second Chance. Alice is about to swap her 5 onto him.
  await alice.setHand(gameId, alice.id, { regularCards: [5, 7], specialCards: [] });
  await alice.setHand(gameId, bob.id, { regularCards: [5, 9], specialCards: ['SC'] });
  await alice.stackDeck(gameId, ['Swap', ...FILLER]);

  const popup = alice.once('select-swap-cards');
  alice.emit('flip-card', gameId);
  await popup;

  const swapped = alice.waitForState(
    state => seat(state, 'Alice').regularCards.includes(9),
    { what: 'the swap to land' }
  );
  alice.emit(
    'swap-cards', gameId,
    { playerId: alice.id, index: 0, isSpecial: false }, // Alice's 5
    { playerId: bob.id, index: 1, isSpecial: false }    // Bob's 9
  );
  const state = await swapped;

  const bobby = seat(state, 'Bob');
  assert.strictEqual(bobby.status, 'active', 'the Second Chance saved him');
  assert.ok(!bobby.specialCards.includes('SC'), 'and was spent doing it');
  assert.deepStrictEqual(
    bobby.regularCards, [5],
    'the card that arrived is the one taken back off him'
  );
});

test('without a Second Chance, a Swap duplicate busts', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);

  await alice.setHand(gameId, alice.id, { regularCards: [5, 7], specialCards: [] });
  await alice.setHand(gameId, bob.id, { regularCards: [5, 9], specialCards: [] });
  await alice.stackDeck(gameId, ['Swap', ...FILLER]);

  const popup = alice.once('select-swap-cards');
  alice.emit('flip-card', gameId);
  await popup;

  const swapped = alice.waitForState(
    state => seat(state, 'Bob').status === 'busted',
    { what: 'Bob to bust on the swapped duplicate' }
  );
  alice.emit(
    'swap-cards', gameId,
    { playerId: alice.id, index: 0, isSpecial: false },
    { playerId: bob.id, index: 1, isSpecial: false }
  );
  const state = await swapped;

  assert.strictEqual(seat(state, 'Bob').bustedCard, 5);
  assert.strictEqual(seat(state, 'Bob').roundScore, 0);
});

// ------------------------------------------------ 4. everybody busts

test('everybody busting deals again and banks nothing', async t => {
  // Long enough to see the summary go out, short enough not to sit through it.
  const server = await startServer({ env: { ROUND_SUMMARY_MS: '500' } });
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(
    server, ['Alice', 'Bob']
  );

  await alice.setHand(gameId, alice.id, { regularCards: [4], totalScore: 180 });
  await alice.setHand(gameId, bob.id, { regularCards: [6], totalScore: 190 });
  // Both draw the card they are already holding.
  await alice.stackDeck(gameId, [4, 6, ...FILLER]);

  const summary = alice.once('round-summary', { timeout: 10000 });
  const newRound = alice.once('new-round', { timeout: 15000 });

  alice.emit('flip-card', gameId);
  await alice.waitForState(
    state => seat(state, 'Alice').status === 'busted',
    { what: 'Alice to bust' }
  );
  bob.emit('flip-card', gameId);

  const payload = await summary;
  assert.strictEqual(payload.allBusted, true, 'the summary says it was a wipeout');
  assert.ok(payload.players.every(p => p.status === 'busted'));

  const state = await newRound;

  // Both were within one round of 200 and neither may have been carried over it by a
  // round they lost. Nobody scored, so nobody can have won.
  assert.strictEqual(state.status, 'playing', 'the game did not end');
  assert.strictEqual(seat(state, 'Alice').totalScore, 180);
  assert.strictEqual(seat(state, 'Bob').totalScore, 190);
  assert.strictEqual(state.roundNumber, 2, 'and a fresh round was dealt');
  assert.ok(state.players.every(p => p.status === 'active'));
  assert.ok(state.players.every(p => p.regularCards.length === 0));
});

// ------------------------------------------------ 5. the clock runs out on a popup

test('a turn that times out with a popup open busts, and discards the card', async t => {
  // A two-second turn instead of two minutes. The sweeper checks once a second.
  const server = await startServer({ env: { TURN_LIMIT_MS: '2000' } });
  t.after(() => server.stop());

  const { gameId, host: alice, guests: [bob] } = await startGame(server, ['Alice', 'Bob']);
  await alice.stackDeck(gameId, ['Freeze', 7, 5, ...FILLER]);

  // Alice draws a Freeze, opens the target popup, and then walks away from it.
  const popup = alice.once('select-freeze-target');
  alice.emit('flip-card', gameId);
  await popup;

  const timedOut = await alice.once('turn-timeout', { timeout: 10000 });
  assert.strictEqual(timedOut.playerName, 'Alice');

  const state = await alice.waitForState(
    state => seat(state, 'Alice').status === 'busted',
    { what: 'Alice to be busted by the clock', timeout: 10000 }
  );

  const ada = seat(state, 'Alice');
  assert.strictEqual(ada.pendingTarget, null, 'the popup is not left hanging');
  assert.ok(!ada.specialCards.includes('Freeze'), 'the card she never aimed is gone');
  assert.ok(state.discardPile.includes('Freeze'), 'and went to the discard pile');
  assert.strictEqual(ada.roundScore, 0);

  assert.strictEqual(
    state.players[state.currentPlayer].name, 'Bob',
    'and the table carries on without her'
  );
  assert.strictEqual(seat(state, 'Bob').status, 'active');
});
