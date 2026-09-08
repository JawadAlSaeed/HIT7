const test = require('node:test');
const assert = require('node:assert');

const {
  MAX_REGULAR_CARDS,
  SEVEN_CARD_BONUS,
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
  removeCardRefusal,
  stealCardRefusal,
  isRoundOver,
  allBusted,
  bankRoundScores,
  decideRoundEnd,
  discardAllHands,
  resetPlayersForRound
} = require('../lib/rules');

// A seat, with only the fields the rules actually read.
const player = (overrides = {}) => ({
  id: 'p1',
  name: 'Ada',
  regularCards: [],
  specialCards: [],
  status: 'active',
  roundScore: 0,
  totalScore: 0,
  bustedCard: null,
  drawThreeRemaining: 0,
  pendingSpecialCard: null,
  pendingTarget: null,
  ...overrides
});

// A table. `deck` is only here because discardAllHands and applyNumberCard push to the
// discard pile - nothing in lib/rules.js ever draws.
const table = (players, overrides = {}) => ({
  id: 'GAME1',
  players,
  deck: [],
  discardPile: [],
  currentPlayer: 0,
  status: 'playing',
  ...overrides
});

// ---------------------------------------------------------------- scoring

test('a hand is the sum of its numbers', () => {
  assert.strictEqual(scoreHand([3, 5, 9], []), 17);
});

test('plus cards add and minus cards subtract', () => {
  assert.strictEqual(scoreHand([10], ['4+', '2+']), 16);
  assert.strictEqual(scoreHand([10], ['4-']), 6);
  assert.strictEqual(scoreHand([10], ['10+', '6-']), 14);
});

// The order used to be arguable. It is not: the modifiers apply to the whole hand.
test('2x doubles the hand after the plus and minus cards', () => {
  assert.strictEqual(scoreHand([10], ['4+', '2x']), 28);
  assert.strictEqual(scoreHand([10], ['4-', '2x']), 12);
});

test('2÷ halves and rounds', () => {
  assert.strictEqual(scoreHand([10, 5], ['2÷']), 8); // 15 / 2 = 7.5, rounded up
  assert.strictEqual(scoreHand([10], ['2÷']), 5);
});

test('a hand dragged below zero is worth nothing, never negative', () => {
  assert.strictEqual(scoreHand([2], ['10-']), 0);
  assert.strictEqual(scoreHand([2], ['10-', '2x']), 0);
});

test('a full seven is worth a flat 15 on top, whatever the modifiers did', () => {
  const seven = [1, 2, 3, 4, 5, 6, 7]; // 28
  assert.strictEqual(scoreHand(seven, []), 28 + SEVEN_CARD_BONUS);
  assert.strictEqual(scoreHand(seven, ['2x']), 56 + SEVEN_CARD_BONUS);
  // Not doubled with the rest: the bonus is the same 15 either way.
  assert.notStrictEqual(scoreHand(seven, ['2x']), (28 + SEVEN_CARD_BONUS) * 2);
});

test('six cards and a special is not a seven', () => {
  const six = [1, 2, 3, 4, 5, 6];
  assert.strictEqual(scoreHand(six, ['2+']), 23);
  assert.strictEqual(six.length + 1, MAX_REGULAR_CARDS);
});

test('a busted player scores nothing, cards still in hand', () => {
  const busted = player({ regularCards: [12, 12], status: 'busted', roundScore: 99 });
  updatePlayerScore(busted);
  assert.strictEqual(busted.roundScore, 0);
  assert.strictEqual(busted.regularCards.length, 2, 'the hand is kept for the summary');
});

// ---------------------------------------------------------------- drawing a number

test('a new number joins the hand', () => {
  const p = player({ regularCards: [3] });
  const game = table([p]);
  assert.strictEqual(applyNumberCard(game, p, 7).outcome, 'added');
  assert.deepStrictEqual(p.regularCards, [3, 7]);
  assert.deepStrictEqual(game.discardPile, [], 'a card that joined a hand is not discarded');
});

test('a duplicate busts you', () => {
  const p = player({ regularCards: [7] });
  const game = table([p]);
  assert.strictEqual(applyNumberCard(game, p, 7).outcome, 'bust');
  assert.strictEqual(p.status, 'busted');
  assert.strictEqual(p.bustedCard, 7);
  assert.strictEqual(p.roundScore, 0);
  assert.deepStrictEqual(p.regularCards, [7], 'the duplicate never joins the hand');
  assert.deepStrictEqual(game.discardPile, [7], 'it goes to the discard pile instead');
});

// This one was a real bug: handleNumberCard skipped the duplicate check for 0, so a
// second 0 was free.
test('a second 0 busts you like any other duplicate', () => {
  const p = player({ regularCards: [0] });
  const game = table([p]);
  assert.strictEqual(applyNumberCard(game, p, 0).outcome, 'bust');
  assert.strictEqual(p.status, 'busted');
});

test('a Second Chance eats the duplicate instead', () => {
  const p = player({ regularCards: [7], specialCards: ['SC'] });
  const game = table([p]);
  assert.strictEqual(applyNumberCard(game, p, 7).outcome, 'second-chance');
  assert.strictEqual(p.status, 'active');
  assert.deepStrictEqual(p.specialCards, [], 'the SC is spent');
  assert.deepStrictEqual(game.discardPile, [7, 'SC'], 'both leave play');
});

test('a Second Chance is spent one at a time', () => {
  const p = player({ regularCards: [7], specialCards: ['SC', 'SC'] });
  const game = table([p]);
  applyNumberCard(game, p, 7);
  assert.deepStrictEqual(p.specialCards, ['SC'], 'the other one survives');
});

test('the seventh number stands you and banks the bonus', () => {
  const p = player({ regularCards: [1, 2, 3, 4, 5, 6] });
  const game = table([p]);
  assert.strictEqual(applyNumberCard(game, p, 7).outcome, 'seven');
  assert.strictEqual(p.status, 'stood');
  assert.strictEqual(p.roundScore, 28 + SEVEN_CARD_BONUS);
});

// ---------------------------------------------------------------- swap duplicates

test('findDuplicateValue finds the second copy, or nothing', () => {
  assert.strictEqual(findDuplicateValue([1, 2, 3]), null);
  assert.strictEqual(findDuplicateValue([1, 2, 1]), 1);
  assert.strictEqual(findDuplicateValue([0, 0]), 0);
});

test('a swap that hands you a number you hold busts you', () => {
  const p = player({ regularCards: [5, 5] }); // 5 has just arrived by Swap
  const game = table([p]);
  const { outcome, card } = resolveSwapDuplicate(game, p, 5);
  assert.strictEqual(outcome, 'bust');
  assert.strictEqual(card, 5);
  assert.strictEqual(p.status, 'busted');
});

// The audit called this one out as hard to reason about: a Second Chance consumed by a
// duplicate that arrived through a Swap rather than a draw.
test('a Second Chance survives a swapped duplicate and puts the hand back', () => {
  const p = player({ regularCards: [5, 5], specialCards: ['SC'] });
  const game = table([p]);
  const { outcome } = resolveSwapDuplicate(game, p, 5);

  assert.strictEqual(outcome, 'second-chance');
  assert.strictEqual(p.status, 'active');
  assert.deepStrictEqual(p.specialCards, [], 'the SC is spent');
  // The card that arrived is the one removed, so the hand is exactly what it was.
  assert.deepStrictEqual(p.regularCards, [5]);
  assert.deepStrictEqual(game.discardPile, ['SC', 5]);
});

test('a harmless swap changes nothing', () => {
  const p = player({ regularCards: [5, 9], specialCards: ['SC'] });
  const game = table([p]);
  assert.strictEqual(resolveSwapDuplicate(game, p, 9).outcome, 'none');
  assert.deepStrictEqual(p.specialCards, ['SC'], 'the SC is not touched');
  assert.strictEqual(p.status, 'active');
});

// ---------------------------------------------------------------- turn order

test('the turn moves to the next active player', () => {
  const game = table([player({ id: 'a' }), player({ id: 'b' }), player({ id: 'c' })]);
  assert.strictEqual(advanceTurn(game), 1);
  assert.strictEqual(advanceTurn(game), 2);
  assert.strictEqual(advanceTurn(game), 0, 'and wraps around');
});

test('the turn skips anybody who is out', () => {
  const game = table([
    player({ id: 'a' }),
    player({ id: 'b', status: 'busted' }),
    player({ id: 'c', status: 'stood' }),
    player({ id: 'd' })
  ]);
  assert.strictEqual(advanceTurn(game), 3);
});

// Without the attempt counter this is an infinite loop, which on a server is not a bug
// you find by playing - it is one that takes the process down.
test('the turn stays put when nobody is active', () => {
  const game = table([
    player({ id: 'a', status: 'stood' }),
    player({ id: 'b', status: 'busted' })
  ], { currentPlayer: 0 });
  assert.strictEqual(advanceTurn(game), 0);
});

test('removing a seat keeps the turn on whoever actually had it', () => {
  const game = table([
    player({ id: 'a' }),
    player({ id: 'b' }),
    player({ id: 'c' })
  ], { currentPlayer: 2 });

  removePlayerAt(game, 0); // somebody before the current player leaves
  assert.strictEqual(game.players[game.currentPlayer].id, 'c');
});

test('removing the player whose turn it is passes the turn on', () => {
  const game = table([
    player({ id: 'a' }),
    player({ id: 'b' }),
    player({ id: 'c' })
  ], { currentPlayer: 1 });

  removePlayerAt(game, 1);
  assert.strictEqual(game.players[game.currentPlayer].id, 'c');
});

test('removing the last seat in the list wraps the turn to the front', () => {
  const game = table([
    player({ id: 'a' }),
    player({ id: 'b' })
  ], { currentPlayer: 1 });

  removePlayerAt(game, 1);
  assert.strictEqual(game.players[game.currentPlayer].id, 'a');
});

// ---------------------------------------------------------------- targeting

test('Draw Three cannot be aimed at a full hand', () => {
  const full = player({ id: 'b', regularCards: [1, 2, 3, 4, 5, 6, 7] });
  const me = player({ id: 'a' });
  const game = table([me, full]);
  assert.deepStrictEqual(eligibleTargets('D3', game, me).map(p => p.id), ['a']);
});

test('Freeze can be aimed at anybody still playing, including yourself', () => {
  const me = player({ id: 'a' });
  const game = table([me, player({ id: 'b', status: 'stood' }), player({ id: 'c' })]);
  assert.deepStrictEqual(eligibleTargets('Freeze', game, me).map(p => p.id), ['a', 'c']);
});

// Otherwise the card is spent taking itself, which is not a move.
test('Remove Card skips a hand holding nothing but an RC', () => {
  const me = player({ id: 'a', specialCards: ['RC'] });
  const game = table([me, player({ id: 'b', specialCards: ['RC'] })]);
  assert.deepStrictEqual(eligibleTargets('RC', game, me), []);
});

test('Remove Card can take a different special from an otherwise empty hand', () => {
  const me = player({ id: 'a', specialCards: ['RC'] });
  const game = table([me, player({ id: 'b', specialCards: ['2x'] })]);
  assert.deepStrictEqual(eligibleTargets('RC', game, me).map(p => p.id), ['b']);
});

test('Steal never targets yourself or an empty hand', () => {
  const me = player({ id: 'a', regularCards: [4] });
  const game = table([
    me,
    player({ id: 'b' }),
    player({ id: 'c', regularCards: [9] }),
    player({ id: 'd', regularCards: [2], status: 'busted' })
  ]);
  assert.deepStrictEqual(eligibleTargets('ST', game, me).map(p => p.id), ['c']);
});

test('Swap needs two sides with something worth trading', () => {
  const me = player({ id: 'a', regularCards: [4], specialCards: ['Swap'] });
  const empty = player({ id: 'b' });
  assert.deepStrictEqual(eligibleTargets('Swap', table([me, empty]), me), []);

  const other = player({ id: 'c', regularCards: [9] });
  assert.strictEqual(eligibleTargets('Swap', table([me, empty, other]), me).length, 3);
});

// The targeting cards cannot be traded, so a hand holding only those has nothing to
// swap even though specialCards is not empty.
test('a hand of nothing but targeting cards has nothing to swap', () => {
  const me = player({ id: 'a', regularCards: [4], specialCards: ['Swap'] });
  const targetsOnly = player({ id: 'b', specialCards: ['Freeze', 'D3'] });
  assert.strictEqual(countSwappableCards(targetsOnly), 0);
  assert.deepStrictEqual(eligibleTargets('Swap', table([me, targetsOnly]), me), []);
});

// -------------------------------------------------- Remove Card and Steal validation

// Card indices come from a client, so every one of these is a rule about a number
// somebody else chose. An index past the end takes `undefined` and puts a card that
// does not exist into the discard pile.
test('Remove Card only reaches into an active hand', () => {
  const stood = player({ id: 'b', regularCards: [4], status: 'stood' });
  assert.match(removeCardRefusal(stood, 0, false), /only remove cards from active/i);

  const busted = player({ id: 'c', regularCards: [4], status: 'busted' });
  assert.match(removeCardRefusal(busted, 0, false), /only remove cards from active/i);

  const active = player({ id: 'd', regularCards: [4] });
  assert.strictEqual(removeCardRefusal(active, 0, false), null);
});

test('Remove Card refuses an index that is not there', () => {
  const target = player({ regularCards: [4, 9], specialCards: ['2x'] });
  for (const index of [-1, 2, 1.5, '0', null, undefined, NaN]) {
    assert.match(
      removeCardRefusal(target, index, false), /invalid card index/i,
      `${String(index)} should be refused`
    );
  }
  assert.strictEqual(removeCardRefusal(target, 1, false), null);
  // The special and regular hands are indexed separately.
  assert.strictEqual(removeCardRefusal(target, 0, true), null);
  assert.match(removeCardRefusal(target, 1, true), /invalid card index/i);
});

// Otherwise the card is spent taking one of its own kind, which is not a move.
test('a Remove Card cannot remove a Remove Card', () => {
  const target = player({ specialCards: ['RC', '2x'] });
  assert.match(removeCardRefusal(target, 0, true), /cannot remove a Remove Card/i);
  assert.strictEqual(removeCardRefusal(target, 1, true), null);
});

test('Steal never reaches your own hand', () => {
  const me = player({ id: 'a', regularCards: [4] });
  assert.match(stealCardRefusal(me, me, 0, false), /from yourself/i);
});

// Unlike Remove Card, a stood player is fair game - their cards still score.
test('Steal takes from a stood hand but never a busted one', () => {
  const me = player({ id: 'a' });
  const stood = player({ id: 'b', regularCards: [9], status: 'stood' });
  const busted = player({ id: 'c', regularCards: [9], status: 'busted' });

  assert.strictEqual(stealCardRefusal(me, stood, 0, false), null);
  assert.match(stealCardRefusal(me, busted, 0, false), /busted/i);
});

test('Steal refuses an index that is not there', () => {
  const me = player({ id: 'a' });
  const target = player({ id: 'b', regularCards: [9], specialCards: [] });

  for (const index of [-1, 1, 'x', null]) {
    assert.match(stealCardRefusal(me, target, index, false), /invalid card index/i);
  }
  // An empty special hand has no index at all, not even 0.
  assert.match(stealCardRefusal(me, target, 0, true), /invalid card index/i);
  assert.strictEqual(stealCardRefusal(me, target, 0, false), null);
});

// ---------------------------------------------------------------- end of round

test('the round is over once nobody is active', () => {
  assert.strictEqual(isRoundOver([player(), player({ status: 'stood' })]), false);
  assert.strictEqual(isRoundOver([player({ status: 'stood' }), player({ status: 'busted' })]), true);
});

test('only busted players everywhere is a wipeout', () => {
  assert.strictEqual(allBusted([player({ status: 'busted' }), player({ status: 'stood' })]), false);
  assert.strictEqual(allBusted([player({ status: 'busted' }), player({ status: 'busted' })]), true);
});

test('banking adds the round to the total, and skips the busted', () => {
  const winner = player({ id: 'a', roundScore: 22, totalScore: 100 });
  const bust = player({ id: 'b', roundScore: 0, totalScore: 40, status: 'busted' });
  bankRoundScores([winner, bust]);
  assert.strictEqual(winner.totalScore, 122);
  assert.strictEqual(bust.totalScore, 40);
});

test('banking records a best round when stats are being kept', () => {
  const p = player({ roundScore: 30, totalScore: 0, stats: { bestRound: 12 } });
  bankRoundScores([p]);
  assert.strictEqual(p.stats.bestRound, 30);
  p.roundScore = 5;
  bankRoundScores([p]);
  assert.strictEqual(p.stats.bestRound, 30, 'a worse round does not lower it');
});

test('under the target, the game plays on', () => {
  const result = decideRoundEnd([
    player({ id: 'a', totalScore: 150, status: 'stood' }),
    player({ id: 'b', totalScore: 90, status: 'stood' })
  ], 200);
  assert.deepStrictEqual(result, { allBusted: false, winner: null });
});

test('crossing the target ends the game', () => {
  const ahead = player({ id: 'a', totalScore: 205, status: 'stood' });
  const result = decideRoundEnd([ahead, player({ id: 'b', totalScore: 90, status: 'stood' })], 200);
  assert.strictEqual(result.winner, ahead);
});

test('a tie at the target goes to the higher seat', () => {
  const first = player({ id: 'a', totalScore: 210, status: 'stood' });
  const second = player({ id: 'b', totalScore: 210, status: 'stood' });
  assert.strictEqual(decideRoundEnd([first, second], 200).winner, first);
});

// A player who busted this round can be ahead on totals and still must not win on it.
test('a busted player cannot win the round that busted them', () => {
  const busted = player({ id: 'a', totalScore: 300, status: 'busted' });
  const other = player({ id: 'b', totalScore: 50, status: 'stood' });
  assert.strictEqual(decideRoundEnd([busted, other], 200).winner, null);
});

// Everybody busting is one of the paths the audit flagged: nobody scored, so nobody can
// have crossed the line, and the only right answer is to deal again.
test('everybody busting always deals again, whatever the totals say', () => {
  const result = decideRoundEnd([
    player({ id: 'a', totalScore: 400, status: 'busted' }),
    player({ id: 'b', totalScore: 380, status: 'busted' })
  ], 200);
  assert.deepStrictEqual(result, { allBusted: true, winner: null });
});

test('a wipeout banks nothing', () => {
  const a = player({ id: 'a', roundScore: 40, totalScore: 100, status: 'busted' });
  const b = player({ id: 'b', roundScore: 30, totalScore: 90, status: 'busted' });
  bankRoundScores([a, b]);
  assert.strictEqual(a.totalScore, 100);
  assert.strictEqual(b.totalScore, 90);
});

// ---------------------------------------------------------------- resetting

test('the whole table goes to the discard pile at round end', () => {
  const game = table([
    player({ id: 'a', regularCards: [3, 4], specialCards: ['2x'] }),
    player({ id: 'b', regularCards: [9], specialCards: [] })
  ], { discardPile: ['SC'] });

  discardAllHands(game);
  assert.deepStrictEqual(game.discardPile.sort(), ['2x', 3, 4, 9, 'SC'].sort());
});

test('a reset clears the round but never the game', () => {
  const p = player({
    regularCards: [1, 2],
    specialCards: ['2x'],
    status: 'busted',
    roundScore: 0,
    totalScore: 140,
    bustedCard: 2,
    drawThreeRemaining: 2,
    pendingSpecialCard: 'Freeze',
    pendingTarget: 'Freeze',
    stats: { bestRound: 55 }
  });

  resetPlayersForRound([p]);

  assert.deepStrictEqual(p.regularCards, []);
  assert.deepStrictEqual(p.specialCards, []);
  assert.strictEqual(p.status, 'active');
  assert.strictEqual(p.bustedCard, null);
  assert.strictEqual(p.drawThreeRemaining, 0);
  assert.strictEqual(p.pendingSpecialCard, null);
  assert.strictEqual(p.pendingTarget, null);
  // The two things a round must never touch.
  assert.strictEqual(p.totalScore, 140);
  assert.strictEqual(p.stats.bestRound, 55);
});

// ---------------------------------------------------------------- odds and ends

// This was a real bug: filter(c => c !== card) discarded every copy of a card when a
// player played one, and Steal and Swap can genuinely put two copies in one hand.
test('playing a card discards that one copy, not all of them', () => {
  const cards = ['Freeze', '2x', 'Freeze'];
  assert.strictEqual(removeOneCard(cards, 'Freeze'), true);
  assert.deepStrictEqual(cards, ['2x', 'Freeze']);
  assert.strictEqual(removeOneCard(cards, 'ST'), false, 'and says so when it is not there');
});

test('only cards that exist are valid', () => {
  for (const card of [0, 12, 'SC', '2÷', 'Select']) {
    assert.strictEqual(isValidCard(card), true, `${card} should be valid`);
  }
  for (const card of [13, -1, 1.5, '99+', 'nonsense', null, undefined]) {
    assert.strictEqual(isValidCard(card), false, `${card} should not be valid`);
  }
});

test('names are trimmed, collapsed and capped', () => {
  assert.strictEqual(sanitizeName('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.strictEqual(sanitizeName('x'.repeat(50)).length, 20);
  assert.strictEqual(sanitizeName(null), '');
  assert.strictEqual(sanitizeName(42), '');
});

// The display order is the one thing standing between a curious player and the next
// card, so it must never be the draw order.
test('the deck goes out sorted, numbers first', () => {
  const sorted = sortDeckForDisplay(['Freeze', 9, '2x', 0, 'D3', 3]);
  assert.deepStrictEqual(sorted, [0, 3, 9, '2x', 'D3', 'Freeze']);
});

test('sorting for display does not disturb the real deck', () => {
  const deck = ['Freeze', 9, 3];
  sortDeckForDisplay(deck);
  assert.deepStrictEqual(deck, ['Freeze', 9, 3]);
});
