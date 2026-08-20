const test = require('node:test');
const assert = require('node:assert');

const {
  PERSONALITIES,
  PERSONALITY_KEYS,
  MIN_THINK_MS,
  MAX_THINK_MS,
  deckComposition,
  estimateBustChance,
  decideMove,
  thinkDelay
} = require('../lib/bot');

const { DECK_MODES, isSwappableSpecial, createDeck } = require('../lib/deck');

const MAX_REGULAR_CARDS = 7;
const DECK_MODE_KEYS = Object.keys(DECK_MODES);
const TARGETING_CARDS = ['Freeze', 'D3', 'RC', 'ST', 'Swap', 'Select'];

// ---------------------------------------------------------------------------
// A seeded generator, so a failure is a failure you can run again.
// ---------------------------------------------------------------------------

const rngFrom = seed => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};

const pick = (list, rng) => list[Math.floor(rng() * list.length) % list.length];

// ---------------------------------------------------------------------------
// The server's rules, restated. Every check below is the one the matching handler
// in server.js applies. If a move passes here it will not be refused there.
// ---------------------------------------------------------------------------

const findPlayer = (view, id) => view.players.find(p => p.id === id);

const indexInRange = (player, index, isSpecial) => {
  const array = isSpecial ? player.specialCards : player.regularCards;
  return Number.isInteger(index) && index >= 0 && index < array.length;
};

// Whether the card the bot is holding has any legal play at all. 'skip' is only an
// acceptable answer when this says no.
const hasLegalTarget = (view, seat, card) => {
  const players = view.players;
  if (card === 'Freeze') return players.some(p => p.status === 'active');
  if (card === 'D3') {
    return players.some(p => p.status === 'active' && p.regularCards.length < MAX_REGULAR_CARDS);
  }
  if (card === 'RC') {
    return players.some(p => p.status === 'active' &&
      (p.regularCards.length > 0 || p.specialCards.some(c => c !== 'RC')));
  }
  if (card === 'ST') {
    return players.some(p => p.status !== 'busted' && p.id !== seat.id &&
      (p.regularCards.length > 0 || p.specialCards.length > 0));
  }
  if (card === 'Swap') {
    const withCards = players.filter(p => p.status !== 'busted' &&
      (p.regularCards.length + p.specialCards.filter(isSwappableSpecial).length) > 0);
    return withCards.length >= 2;
  }
  if (card === 'Select') return (view.deck || []).length > 0;
  return false;
};

const assertLegal = (view, move, label) => {
  const seat = view.players[view.currentPlayer];
  const where = `${label} [${move.type}]`;

  assert.ok(move && typeof move.type === 'string', `${label}: no move returned`);
  assert.ok(typeof move.confidence === 'number' &&
    move.confidence >= 0 && move.confidence <= 1, `${where}: bad confidence`);

  if (move.type === 'skip') {
    // Giving up is only allowed when the rules genuinely leave nothing to do.
    if (seat.pendingTarget && seat.specialCards.includes(seat.pendingTarget)) {
      assert.ok(!hasLegalTarget(view, seat, seat.pendingTarget),
        `${where}: skipped a ${seat.pendingTarget} that had a legal target`);
    }
    return;
  }

  // A card waiting on a target owns the turn: nothing else may be played.
  if (seat.pendingTarget) {
    assert.ok(!['flip', 'stand'].includes(move.type),
      `${where}: played past a pending ${seat.pendingTarget}`);
  }

  if (move.type === 'flip') {
    assert.strictEqual(seat.status, 'active', `${where}: not active`);
    assert.ok(!seat.pendingTarget, `${where}: pending target`);
    return;
  }

  if (move.type === 'stand') {
    assert.strictEqual(seat.status, 'active', `${where}: not active`);
    assert.ok(!seat.pendingTarget, `${where}: pending target`);
    // The server refuses a stand mid Draw Three.
    assert.strictEqual(seat.drawThreeRemaining, 0, `${where}: mid draw-three`);
    return;
  }

  if (move.type === 'freeze') {
    const target = findPlayer(view, move.targetId);
    assert.ok(target, `${where}: unknown target`);
    assert.ok(seat.specialCards.includes('Freeze'), `${where}: no Freeze in hand`);
    assert.strictEqual(target.status, 'active', `${where}: target not active`);
    return;
  }

  if (move.type === 'draw-three') {
    const target = findPlayer(view, move.targetId);
    assert.ok(target, `${where}: unknown target`);
    assert.ok(seat.specialCards.includes('D3'), `${where}: no D3 in hand`);
    assert.strictEqual(target.status, 'active', `${where}: target not active`);
    assert.ok(target.regularCards.length < MAX_REGULAR_CARDS, `${where}: target full`);
    return;
  }

  if (move.type === 'remove-card') {
    const target = findPlayer(view, move.targetId);
    assert.ok(target, `${where}: unknown target`);
    assert.ok(seat.specialCards.includes('RC'), `${where}: no RC in hand`);
    assert.strictEqual(target.status, 'active', `${where}: target not active`);
    assert.ok(indexInRange(target, move.cardIndex, move.isSpecial), `${where}: index out of range`);
    if (move.isSpecial) {
      assert.notStrictEqual(target.specialCards[move.cardIndex], 'RC',
        `${where}: tried to remove a Remove Card`);
    }
    return;
  }

  if (move.type === 'steal-card') {
    const target = findPlayer(view, move.targetId);
    assert.ok(target, `${where}: unknown target`);
    assert.ok(seat.specialCards.includes('ST'), `${where}: no ST in hand`);
    assert.notStrictEqual(target.id, seat.id, `${where}: stole from itself`);
    assert.notStrictEqual(target.status, 'busted', `${where}: stole from a busted player`);
    assert.ok(indexInRange(target, move.cardIndex, move.isSpecial), `${where}: index out of range`);
    return;
  }

  if (move.type === 'swap-cards') {
    assert.ok(seat.specialCards.includes('Swap'), `${where}: no Swap in hand`);
    const one = findPlayer(view, move.card1.playerId);
    const two = findPlayer(view, move.card2.playerId);
    assert.ok(one && two, `${where}: unknown player in swap`);
    assert.notStrictEqual(one.id, two.id, `${where}: swapped a hand with itself`);
    assert.notStrictEqual(one.status, 'busted', `${where}: swapped with a busted player`);
    assert.notStrictEqual(two.status, 'busted', `${where}: swapped with a busted player`);
    [[one, move.card1], [two, move.card2]].forEach(([player, choice]) => {
      assert.ok(indexInRange(player, choice.index, choice.isSpecial),
        `${where}: swap index out of range`);
      if (choice.isSpecial) {
        assert.ok(isSwappableSpecial(player.specialCards[choice.index]),
          `${where}: swapped an unswappable ${player.specialCards[choice.index]}`);
      }
    });
    return;
  }

  if (move.type === 'select-card') {
    assert.ok(seat.specialCards.includes('Select'), `${where}: no Select in hand`);
    assert.ok(view.deck.includes(move.card),
      `${where}: picked ${move.card}, which is not in the pile`);
    return;
  }

  assert.fail(`${where}: unknown move type`);
};

// ---------------------------------------------------------------------------
// State generator
// ---------------------------------------------------------------------------

const STATUSES = ['active', 'stood', 'busted'];

const randomHand = (rng, deckMode) => {
  const specials = DECK_MODES[deckMode].specials;
  const regularCards = [];
  const wanted = Math.floor(rng() * (MAX_REGULAR_CARDS + 1));
  while (regularCards.length < wanted) {
    const card = Math.floor(rng() * 13);
    if (!regularCards.includes(card)) regularCards.push(card);
  }
  const specialCards = [];
  const specialCount = Math.floor(rng() * 4);
  for (let i = 0; i < specialCount; i++) specialCards.push(pick(specials, rng));
  return { regularCards, specialCards };
};

// Builds a position the bot could actually be handed. `force` pins the bot's own
// pendingTarget so every branch can be reached deliberately rather than by luck.
const randomView = (rng, { force = null, deckMode = null, seats = null } = {}) => {
  const mode = deckMode || pick(DECK_MODE_KEYS, rng);
  const count = seats || 2 + Math.floor(rng() * 5);
  const players = [];

  for (let i = 0; i < count; i++) {
    const hand = randomHand(rng, mode);
    players.push({
      id: i === 0 ? `bot:${i}` : `sock${i}`,
      name: `P${i}`,
      isBot: i === 0,
      bot: i === 0 ? { personality: pick(PERSONALITY_KEYS, rng) } : undefined,
      connected: true,
      status: i === 0 ? 'active' : pick(STATUSES, rng),
      regularCards: hand.regularCards,
      specialCards: hand.specialCards,
      roundScore: Math.floor(rng() * 60),
      totalScore: Math.floor(rng() * 210),
      drawThreeRemaining: rng() < 0.15 ? 1 + Math.floor(rng() * 3) : 0,
      pendingTarget: null
    });
  }

  const seat = players[0];
  if (force) {
    // The server only ever sets pendingTarget for a card that is actually in the hand.
    seat.specialCards.push(force);
    seat.pendingTarget = force;
    seat.drawThreeRemaining = 0;
  }

  return {
    players,
    currentPlayer: 0,
    deckMode: mode,
    winningScore: pick([100, 150, 200, 300], rng),
    maxRegularCards: MAX_REGULAR_CARDS,
    roundNumber: 1 + Math.floor(rng() * 12),
    deck: createDeck(mode)
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('every personality is a complete set of knobs', () => {
  for (const key of PERSONALITY_KEYS) {
    const traits = PERSONALITIES[key];
    assert.strictEqual(traits.key, key, `${key}: key does not match`);
    for (const knob of ['risk', 'catchUp', 'greed', 'mistakeChance', 'jitter',
                        'speed', 'speedSpread', 'selfFreeze', 'selfD3']) {
      assert.strictEqual(typeof traits[knob], 'number', `${key}: ${knob} missing`);
    }
    assert.ok(traits.names.length >= MAX_REGULAR_CARDS - 1, `${key}: too few names`);
    // Every bot has to be capable of a bad decision, or none of this is worth it.
    assert.ok(traits.mistakeChance > 0, `${key}: never makes a mistake`);
  }
});

test('a bot picks a legal move in every state, on both decks', () => {
  const rng = rngFrom(20260820);
  for (const deckMode of DECK_MODE_KEYS) {
    for (let i = 0; i < 4000; i++) {
      const view = randomView(rng, { deckMode });
      const move = decideMove(view, { rng });
      assertLegal(view, move, `${deckMode} fuzz #${i}`);
    }
  }
});

test('a bot handles every pendingTarget, on both decks', () => {
  const rng = rngFrom(7);
  for (const deckMode of DECK_MODE_KEYS) {
    for (const card of TARGETING_CARDS) {
      let acted = 0;
      for (let i = 0; i < 600; i++) {
        const view = randomView(rng, { force: card, deckMode });
        const move = decideMove(view, { rng });
        assertLegal(view, move, `${deckMode} ${card} #${i}`);
        if (move.type !== 'skip') acted++;
      }
      // Skipping is legal, but a card that never gets played means a dead branch.
      assert.ok(acted > 0, `${deckMode}: ${card} was never actually played`);
    }
  }
});

test('a bot never plays a targeting card it is not holding', () => {
  const rng = rngFrom(99);
  for (const card of TARGETING_CARDS) {
    const view = randomView(rng, { force: card });
    // Take the card straight back out of the hand, exactly as a Remove Card would.
    view.players[0].specialCards = view.players[0].specialCards.filter(c => c !== card);
    const move = decideMove(view, { rng });
    assert.strictEqual(move.type, 'skip', `${card}: played a card it does not hold`);
  }
});

test('a bot always returns something, so a turn can never stall', () => {
  const rng = rngFrom(1234);
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const force = rng() < 0.5 ? pick(TARGETING_CARDS, rng) : null;
    const view = randomView(rng, { force });
    const move = decideMove(view, { rng });
    assert.ok(move && move.type, `#${i}: nothing returned`);
    seen.add(move.type);
  }
  // Nothing is allowed to be unreachable.
  for (const type of ['flip', 'stand', 'freeze', 'draw-three',
                      'remove-card', 'steal-card', 'swap-cards', 'select-card']) {
    assert.ok(seen.has(type), `${type} never came up`);
  }
});

test('a bot mid draw-three flips, because standing is refused', () => {
  const rng = rngFrom(55);
  for (let i = 0; i < 400; i++) {
    const view = randomView(rng);
    view.players[0].pendingTarget = null;
    view.players[0].drawThreeRemaining = 1 + Math.floor(rng() * 3);
    // A hand at the cap is stood by the server before this can come up.
    view.players[0].regularCards = [1, 2, 3];
    const move = decideMove(view, { rng });
    assert.strictEqual(move.type, 'flip', `#${i}: tried to stand mid draw-three`);
  }
});

test('a bot with nothing in hand always flips: it cannot bust and banks nothing', () => {
  const rng = rngFrom(42);
  for (let i = 0; i < 300; i++) {
    const view = randomView(rng);
    view.players[0].pendingTarget = null;
    view.players[0].drawThreeRemaining = 0;
    view.players[0].regularCards = [];
    assert.strictEqual(decideMove(view, { rng }).type, 'flip', `#${i}`);
  }
});

test('a broken or empty position is skipped, never crashed on', () => {
  for (const view of [null, undefined, {}, { players: [] },
                      { players: [], currentPlayer: 3 }]) {
    assert.strictEqual(decideMove(view).type, 'skip');
  }
  // A pendingTarget nothing knows how to play is discarded rather than sat on.
  const odd = {
    players: [{
      id: 'bot:x', status: 'active', regularCards: [], specialCards: ['???'],
      roundScore: 0, totalScore: 0, drawThreeRemaining: 0, pendingTarget: '???',
      bot: { personality: 'cautious' }
    }],
    currentPlayer: 0, deckMode: 'extreme', deck: []
  };
  assert.strictEqual(decideMove(odd).type, 'skip');
});

// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

test('the deck composition matches the deck it is counting', () => {
  for (const mode of DECK_MODE_KEYS) {
    const real = createDeck(mode);
    const counted = new Map();
    for (const card of real) counted.set(card, (counted.get(card) || 0) + 1);

    const composition = deckComposition(mode);
    assert.strictEqual(composition.size, counted.size, `${mode}: different card types`);
    for (const [card, total] of composition) {
      assert.strictEqual(total, counted.get(card), `${mode}: wrong count for ${card}`);
    }
  }
});

test('bust odds run from impossible to certain, and never leave 0..1', () => {
  const empty = seat => ({
    players: [seat], currentPlayer: 0, deckMode: 'extreme', roundNumber: 1
  });

  const holdsNothing = {
    id: 'bot:1', status: 'active', regularCards: [], specialCards: [],
    roundScore: 0, totalScore: 0, drawThreeRemaining: 0, pendingTarget: null
  };
  assert.strictEqual(estimateBustChance(empty(holdsNothing), holdsNothing), 0);

  // Holding a 12 is the single most dangerous card to hold: twelve of them exist, and
  // eleven are still out there.
  const holdsTwelve = { ...holdsNothing, regularCards: [12] };
  const holdsOne = { ...holdsNothing, regularCards: [1] };
  assert.ok(estimateBustChance(empty(holdsTwelve), holdsTwelve) >
            estimateBustChance(empty(holdsOne), holdsOne),
            'a 12 should be scarier to hold than a 1');

  const rng = rngFrom(8);
  for (let i = 0; i < 1500; i++) {
    const view = randomView(rng);
    const odds = estimateBustChance(view, view.players[0]);
    assert.ok(odds >= 0 && odds <= 1, `#${i}: odds were ${odds}`);
  }
});

test('bust odds are read from the deck mode, not from the pile', () => {
  const seat = {
    id: 'bot:1', status: 'active', regularCards: [3], specialCards: [],
    roundScore: 0, totalScore: 0, drawThreeRemaining: 0, pendingTarget: null
  };
  const base = { players: [seat], currentPlayer: 0, roundNumber: 1 };

  // A normal deck is smaller with the same numbers, so the same hand is riskier in it.
  const normal = estimateBustChance({ ...base, deckMode: 'normal' }, seat);
  const extreme = estimateBustChance({ ...base, deckMode: 'extreme' }, seat);
  assert.ok(normal > extreme, 'the smaller deck should read as riskier');

  // Handing it a stacked pile must change nothing: the pile is not something a bot
  // is allowed to see.
  const stacked = estimateBustChance(
    { ...base, deckMode: 'extreme', deck: [3, 3, 3, 3, 3, 3] }, seat);
  assert.strictEqual(stacked, extreme, 'the bot read the draw pile');
});

test('an unknown deck mode falls back rather than throwing', () => {
  const rng = rngFrom(3);
  const view = randomView(rng);
  view.deckMode = 'nonsense';
  assert.doesNotThrow(() => decideMove(view, { rng }));
});

// ---------------------------------------------------------------------------
// Personality
// ---------------------------------------------------------------------------

// Six hands running from almost safe to genuinely dicey. Everything else about the
// table is pinned - two empty-handed opponents, level scores, one deck, one round - so
// that the personality is the only thing that can move the answer. Randomised
// positions were tried first and they work, but the spread washes out: a personality
// difference is a difference in where the line sits, and that only shows up clearly
// when the position either side of the line is held still.
const RISK_LADDER = [
  [1, 2, 3],                  // ~3% chance the next card busts
  [4, 7, 9],                  // ~16%
  [9, 11, 12],                // ~28%
  [10, 11, 12],               // ~29%
  [8, 10, 11, 12],            // ~36%
  [7, 9, 10, 11, 12]          // ~43%
];

const fixedTable = (personalityKey, hand) => ({
  players: [
    {
      id: 'bot:steady', name: 'Bot', isBot: true, connected: true, status: 'active',
      bot: { personality: personalityKey },
      regularCards: [...hand], specialCards: [],
      roundScore: 10, totalScore: 0, drawThreeRemaining: 0, pendingTarget: null
    },
    {
      id: 'sock1', name: 'A', connected: true, status: 'active',
      regularCards: [], specialCards: [],
      roundScore: 0, totalScore: 0, drawThreeRemaining: 0, pendingTarget: null
    },
    {
      id: 'sock2', name: 'B', connected: true, status: 'active',
      regularCards: [], specialCards: [],
      roundScore: 0, totalScore: 0, drawThreeRemaining: 0, pendingTarget: null
    }
  ],
  currentPlayer: 0,
  deckMode: 'extreme',
  winningScore: 200,
  maxRegularCards: MAX_REGULAR_CARDS,
  roundNumber: 4,
  deck: []
});

// Run often enough that the mistake roll averages out rather than deciding the result.
const standRate = (personalityKey, seed) => {
  const rng = rngFrom(seed);
  let stands = 0;
  let plays = 0;
  for (let i = 0; i < 300; i++) {
    for (const hand of RISK_LADDER) {
      plays++;
      if (decideMove(fixedTable(personalityKey, hand), { rng }).type === 'stand') stands++;
    }
  }
  return stands / plays;
};

test('the cautious one banks far more often than the reckless one', () => {
  const cautious = standRate('cautious', 500);
  const reckless = standRate('reckless', 500);
  assert.ok(cautious > reckless + 0.25,
    `cautious stood ${cautious}, reckless stood ${reckless} - not different enough`);
});

test('every personality sits somewhere different on the same ladder of hands', () => {
  const rates = PERSONALITY_KEYS.map(key => [key, standRate(key, 900)]);
  const values = rates.map(([, rate]) => rate);
  const spread = Math.max(...values) - Math.min(...values);
  assert.ok(spread > 0.25,
    `all four play too alike: ${rates.map(([k, r]) => `${k} ${r.toFixed(2)}`).join(', ')}`);

  // And none of them is a brick wall in either direction, which would be its own
  // kind of obvious.
  for (const [key, rate] of rates) {
    assert.ok(rate > 0.01 && rate < 0.99, `${key} always does the same thing (${rate})`);
  }
});

test('a bot standing on a win does not flip again for fun', () => {
  const rng = rngFrom(11);
  let stood = 0;
  for (let i = 0; i < 200; i++) {
    const view = randomView(rng, { seats: 3 });
    const seat = view.players[0];
    seat.pendingTarget = null;
    seat.drawThreeRemaining = 0;
    seat.regularCards = [5, 8];      // real odds of busting
    seat.specialCards = [];
    view.winningScore = 200;
    seat.totalScore = 190;
    seat.roundScore = 40;            // standing wins outright
    seat.bot = { personality: 'cautious' };
    if (decideMove(view, { rng }).type === 'stand') stood++;
  }
  // Only the blunder roll should ever push it off a win.
  assert.ok(stood >= 180, `stood on a winning hand only ${stood}/200 times`);
});

test('the same bot does not play identical rounds', () => {
  // Everything is held still except the round number, which is the only thing the
  // per-round drift is built from.
  const thresholds = new Set();
  for (let round = 1; round <= 12; round++) {
    const rng = rngFrom(1);
    const view = {
      players: [{
        id: 'bot:steady', status: 'active',
        regularCards: [2, 5, 9], specialCards: [],
        roundScore: 16, totalScore: 40, drawThreeRemaining: 0, pendingTarget: null,
        bot: { personality: 'streaky' }
      }],
      currentPlayer: 0, deckMode: 'extreme', winningScore: 200,
      maxRegularCards: MAX_REGULAR_CARDS, roundNumber: round, deck: []
    };
    // No mistake roll wanted here; the drift is what is being measured.
    const { standThreshold, personality } = require('../lib/bot');
    thresholds.add(standThreshold(view, view.players[0], personality('streaky')).toFixed(4));
  }
  assert.ok(thresholds.size >= 8, `only ${thresholds.size} distinct thresholds in 12 rounds`);
});

test('a mistake-free bot and a blundering one reach different conclusions', () => {
  // Same position, same rng stream, the mistake roll is the only variable.
  const build = personalityKey => ({
    players: [{
      id: 'bot:1', status: 'active',
      regularCards: [1, 2, 3, 4, 5], specialCards: [],
      roundScore: 15, totalScore: 0, drawThreeRemaining: 0, pendingTarget: null,
      bot: { personality: personalityKey }
    }],
    currentPlayer: 0, deckMode: 'extreme', winningScore: 200,
    maxRegularCards: MAX_REGULAR_CARDS, roundNumber: 3, deck: []
  });

  const disagreements = PERSONALITY_KEYS.map(key => {
    const rng = rngFrom(2024);
    const moves = new Set();
    for (let i = 0; i < 200; i++) moves.add(decideMove(build(key), { rng }).type);
    return moves.size;
  });
  assert.ok(disagreements.some(size => size > 1),
    'no personality ever changed its mind about an identical position');
});

// ---------------------------------------------------------------------------
// Thinking time
// ---------------------------------------------------------------------------

test('thinking time always lands well inside the 120 second turn limit', () => {
  const rng = rngFrom(6);
  for (const key of [...PERSONALITY_KEYS, 'nonsense', undefined]) {
    for (let i = 0; i < 500; i++) {
      const ms = thinkDelay(key, rng(), rng);
      assert.ok(Number.isFinite(ms), `${key}: not a number`);
      assert.ok(ms >= MIN_THINK_MS && ms <= MAX_THINK_MS, `${key}: ${ms}ms out of range`);
    }
  }
  // The whole point of the bound: a bot must never be the reason a turn times out.
  assert.ok(MAX_THINK_MS < 120 * 1000 / 10, 'thinking time is too close to the turn limit');
});

test('a close call takes longer to decide than an obvious one', () => {
  const steady = () => 0.5;
  for (const key of PERSONALITY_KEYS) {
    assert.ok(thinkDelay(key, 0, steady) > thinkDelay(key, 1, steady),
      `${key} did not hesitate over a close call`);
  }
});
