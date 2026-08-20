// How a bot decides what to do.
//
// Pure, like lib/deck.js: given a snapshot of a game and whose turn it is, return the
// move. No sockets, no timers, no io, and no reaching into the live game object. That
// is what makes the personalities tunable without standing up a server, and what lets
// test/bot.test.js hammer thousands of positions.
//
// Randomness is injected rather than reached for, so a test can pin it.
//
// TWO RULES THIS FILE LIVES BY
//
// 1. It never looks at the shuffled draw pile. A bot works out its odds from the deck
//    *composition* for the mode (how many 7s a 108-card deck holds) minus what it can
//    legitimately see on the table. That is exactly what a human counting cards can
//    know. The one exception is Select, where the popup genuinely shows the holder the
//    whole pile - there, reading it is fair play, so view.deck is only ever consulted
//    for that one decision.
//
// 2. It is not trying to win. A bot that always plays the odds stands on exactly the
//    right number every time and reads as a machine within two rounds. Every
//    personality carries a mistakeChance that flips its own conclusion, and a
//    per-round jitter so the same bot never plays two rounds identically.

const { DECK_MODES, deckMode, isSwappableSpecial } = require('./deck');

const MAX_REGULAR_CARDS = 7;
const DEFAULT_WINNING_SCORE = 200;

// A Second Chance is one free mistake, so a hand holding one is worth pushing much
// further than the raw odds say. Not zero: it only covers the first duplicate.
const SECOND_CHANCE_RELIEF = 0.35;

// How far from its own threshold a decision has to be before a bot is sure about it.
// Anything closer comes back with a low confidence, which server.js turns into a
// longer pause - the bot hesitates where a person would.
const CLOSE_CALL = 0.25;

const MIN_THINK_MS = 600;
const MAX_THINK_MS = 3200;

// ---------------------------------------------------------------------------
// Personalities
//
// Deliberately just numbers. Tuning a bot should be editing one of these rows, never
// editing the logic below.
//
//   risk          how much bust chance it will accept before banking
//   catchUp       extra risk taken when it is behind
//   greed         how hard it chases the seven-card bonus
//   mistakeChance odds of doing the opposite of what it just worked out
//   jitter        how much its threshold drifts from round to round
//   speed/spread  thinking time in ms
//   selfFreeze    odds of freezing itself to lock in a good hand
//   selfD3        odds of pointing a Draw Three at itself
//   mirrors       risk tracks how deep the rest of the table is playing
// ---------------------------------------------------------------------------

const PERSONALITIES = {
  cautious: {
    key: 'cautious',
    label: 'Cautious',
    // Banks early and rarely busts. The one you are glad is not sitting on your left.
    names: ['Nina', 'Opal', 'Wren', 'Dara', 'Hale', 'Fen'],
    risk: 0.22, catchUp: 0.12, greed: 0.20,
    mistakeChance: 0.05, jitter: 0.06,
    speed: 1500, speedSpread: 1300,
    selfFreeze: 0.45, selfD3: 0.05
  },
  reckless: {
    key: 'reckless',
    label: 'Reckless',
    // Chases the seven-card bonus off a cliff. Busts a lot, wins loudly.
    names: ['Zed', 'Kit', 'Rook', 'Blaze', 'Nix', 'Ash'],
    risk: 0.55, catchUp: 0.10, greed: 0.90,
    mistakeChance: 0.16, jitter: 0.10,
    speed: 700, speedSpread: 700,
    selfFreeze: 0.05, selfD3: 0.35
  },
  streaky: {
    key: 'streaky',
    label: 'Streaky',
    // Plays it safe while ahead and goes all in the moment it falls behind.
    names: ['Rae', 'Juno', 'Pax', 'Sable', 'Wilder', 'Cass'],
    risk: 0.35, catchUp: 0.22, greed: 0.55,
    mistakeChance: 0.11, jitter: 0.12,
    speed: 1100, speedSpread: 1100,
    selfFreeze: 0.20, selfD3: 0.20
  },
  copycat: {
    key: 'copycat',
    label: 'Copycat',
    // Reads the room and matches it, which is a fine instinct and a terrible plan.
    names: ['Milo', 'Echo', 'Vale', 'Bex', 'Sunny', 'Ori'],
    risk: 0.33, catchUp: 0.14, greed: 0.50,
    mistakeChance: 0.20, jitter: 0.09,
    speed: 1300, speedSpread: 1800,
    selfFreeze: 0.15, selfD3: 0.15,
    mirrors: true
  }
};

const PERSONALITY_KEYS = Object.keys(PERSONALITIES);
const DEFAULT_PERSONALITY = 'streaky';

const personality = key => PERSONALITIES[key] || PERSONALITIES[DEFAULT_PERSONALITY];
const personalityOf = seat => personality(seat && seat.bot && seat.bot.personality);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Roughly what a card is worth to whoever is holding it. Used to decide which card to
// remove, steal or swap. Not a scoring function - updatePlayerScore owns that - just an
// ordering good enough to prefer taking a 2x over taking a 3.
const SPECIAL_VALUE = {
  '2x': 22, 'SC': 14,
  '10+': 10, '8+': 8, '6+': 6, '4+': 4, '2+': 2,
  '2÷': -14, '10-': -10, '8-': -8, '6-': -6, '4-': -4, '2-': -2,
  // A targeting card only pays out on the turn it is drawn. One that arrives in a hand
  // by any other route can never be played, so it is worth almost nothing to hold.
  'D3': 2, 'Freeze': 2, 'RC': 2, 'ST': 2, 'Swap': 2, 'Select': 2
};

const cardValue = card =>
  typeof card === 'number' ? card : (SPECIAL_VALUE[card] !== undefined ? SPECIAL_VALUE[card] : 0);

// What a card is worth to somebody about to receive it, which is not the same thing:
// a number they already hold busts them.
const receiveValue = (card, receiver) => {
  if (typeof card !== 'number') return cardValue(card);
  if (!receiver.regularCards.includes(card)) return card;
  return receiver.specialCards.includes('SC') ? -5 : -60;
};

const pickRandom = (list, rng) => list[Math.floor(rng() * list.length) % list.length];

const best = (list, score) => list.reduce(
  (winner, item) => (score(item) > score(winner) ? item : winner),
  list[0]
);

// Deterministic 0..1 from a string, so a bot's per-round drift is stable inside a round
// and different in the next one without anything having to be stored anywhere.
const hash01 = text => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
};

const roundJitter = (seat, view, traits) =>
  (hash01(`${traits.key}|${seat.id}|${view.roundNumber || 0}`) - 0.5) * 2 * traits.jitter;

// How many of each card a full deck for this mode holds. Built from lib/deck.js so a
// change to the deck cannot silently leave the bots counting the old one.
const deckComposition = mode => {
  const counts = new Map([[0, 1]]);
  for (let n = 1; n <= 12; n++) counts.set(n, n);
  for (const card of DECK_MODES[deckMode(mode)].specials) {
    counts.set(card, (counts.get(card) || 0) + 1);
  }
  return counts;
};

// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

// The chance the next card busts this seat, counted the way a person at the table
// could count it: everything still unaccounted for, given every hand that is face up.
// Never the draw pile itself.
const estimateBustChance = (view, seat) => {
  const seen = new Map();
  const note = card => seen.set(card, (seen.get(card) || 0) + 1);
  for (const player of view.players) {
    player.regularCards.forEach(note);
    player.specialCards.forEach(note);
  }

  const held = new Set(seat.regularCards);
  let unseen = 0;
  let busting = 0;

  for (const [card, total] of deckComposition(view.deckMode)) {
    const left = Math.max(0, total - (seen.get(card) || 0));
    unseen += left;
    if (held.has(card)) busting += left;
  }

  return unseen === 0 ? 0 : busting / unseen;
};

// The bust chance this seat is willing to sit through before it banks.
const standThreshold = (view, seat, traits) => {
  const winningScore = view.winningScore || DEFAULT_WINNING_SCORE;
  const maxCards = view.maxRegularCards || MAX_REGULAR_CARDS;

  // Standing wins the game outright. Nothing on the next card beats that, so the
  // threshold drops to zero - which still flips a free card when nothing can bust it.
  if (seat.totalScore + seat.roundScore >= winningScore) return 0;

  let threshold = traits.risk + roundJitter(seat, view, traits);

  // Losing makes people brave.
  const leader = Math.max(...view.players.map(p => p.totalScore));
  if (leader - seat.totalScore > winningScore * 0.25) threshold += traits.catchUp;

  // Two cards off a full set, the +15 starts to look worth a bad card.
  const held = seat.regularCards.length;
  if (held === maxCards - 2) threshold += 0.08 * traits.greed;
  if (held === maxCards - 1) threshold += 0.20 * traits.greed;

  // A hand worth protecting is worth protecting.
  if (seat.roundScore >= 30) threshold -= 0.08;
  if (seat.roundScore >= 50) threshold -= 0.08;

  // The copycat has no plan of its own beyond keeping up with the room.
  if (traits.mirrors) {
    const others = view.players.filter(p => p.id !== seat.id && p.status !== 'waiting');
    if (others.length) {
      const average = others.reduce((sum, p) => sum + p.regularCards.length, 0) / others.length;
      threshold += (average - held) * 0.04;
    }
  }

  return clamp(threshold, 0.03, 0.9);
};

// ---------------------------------------------------------------------------
// Flip or stand
// ---------------------------------------------------------------------------

const decideFlipOrStand = (view, seat, traits, rng) => {
  const maxCards = view.maxRegularCards || MAX_REGULAR_CARDS;

  // Mid Draw Three the server refuses a stand, so there is only one legal move.
  if (seat.drawThreeRemaining > 0) return { type: 'flip', confidence: 1 };

  // An empty hand cannot bust and banks nothing.
  if (seat.regularCards.length === 0) return { type: 'flip', confidence: 1 };

  // A full hand should already have been stood by the server; never sit on it.
  if (seat.regularCards.length >= maxCards) return { type: 'stand', confidence: 1 };

  const raw = estimateBustChance(view, seat);
  const bustChance = seat.specialCards.includes('SC') ? raw * SECOND_CHANCE_RELIEF : raw;
  const threshold = standThreshold(view, seat, traits);

  let stand = bustChance > threshold;
  const confidence = clamp(Math.abs(bustChance - threshold) / CLOSE_CALL, 0, 1);

  // The blunder. This is the whole reason the bots are worth playing against.
  if (rng() < traits.mistakeChance) stand = !stand;

  return { type: stand ? 'stand' : 'flip', confidence };
};

// ---------------------------------------------------------------------------
// Targeting
//
// Every list below mirrors the filter the matching handler in server.js applies. If one
// drifts, the server rejects the move, the bot stalls, and server.js falls back to its
// failsafe - so a drift costs a wasted turn rather than a broken game, but keep them
// in step anyway.
// ---------------------------------------------------------------------------

const SKIP = { type: 'skip', confidence: 1 };

// How much a bot cares about hurting a given opponent. Somebody close to the target
// score is worth spending a card on; somebody on nothing is not.
const rivalWeight = (player, view) =>
  0.3 + clamp(player.totalScore / (view.winningScore || DEFAULT_WINNING_SCORE), 0, 1) * 0.7;

const decideFreeze = (view, seat, traits, rng) => {
  const targets = view.players.filter(p => p.status === 'active');
  if (targets.length === 0) return SKIP;

  const opponents = targets.filter(p => p.id !== seat.id);
  const canHitSelf = targets.some(p => p.id === seat.id);

  // Freezing yourself to bank a good hand you were about to lose is a real move, not a
  // bot losing track of who it is.
  if (canHitSelf && seat.roundScore >= 20 && estimateBustChance(view, seat) > 0.3 &&
      rng() < traits.selfFreeze) {
    return { type: 'freeze', targetId: seat.id, confidence: 0.5 };
  }

  if (opponents.length === 0) return { type: 'freeze', targetId: seat.id, confidence: 1 };

  const pick = rng() < traits.mistakeChance
    ? pickRandom(opponents, rng)
    : best(opponents, p => p.roundScore * rivalWeight(p, view));

  return { type: 'freeze', targetId: pick.id, confidence: 0.8 };
};

const decideDrawThree = (view, seat, traits, rng) => {
  const maxCards = view.maxRegularCards || MAX_REGULAR_CARDS;
  const targets = view.players.filter(
    p => p.status === 'active' && p.regularCards.length < maxCards
  );
  if (targets.length === 0) return SKIP;

  const opponents = targets.filter(p => p.id !== seat.id);
  const canHitSelf = targets.some(p => p.id === seat.id);

  // Three free cards when you are two off a seven is greedy rather than broken.
  if (canHitSelf && seat.regularCards.length >= maxCards - 3 && rng() < traits.selfD3) {
    return { type: 'draw-three', targetId: seat.id, confidence: 0.5 };
  }

  if (opponents.length === 0) return { type: 'draw-three', targetId: seat.id, confidence: 1 };

  const pick = rng() < traits.mistakeChance
    ? pickRandom(opponents, rng)
    // A full hand is a hand with the most ways left to draw a duplicate.
    : best(opponents, p => p.regularCards.length * 3 + p.roundScore * 0.1);

  return { type: 'draw-three', targetId: pick.id, confidence: 0.8 };
};

// Every card on the table, as {playerId, index, isSpecial, card}. `include` filters
// which special cards count, because Swap and Remove disagree about that.
const cardsOf = (player, include = () => true) => [
  ...player.regularCards.map((card, index) => ({
    playerId: player.id, index, isSpecial: false, card
  })),
  ...player.specialCards
    .map((card, index) => ({ playerId: player.id, index, isSpecial: true, card }))
    .filter(entry => include(entry.card))
];

const decideRemoveCard = (view, seat, traits, rng) => {
  // A Remove Card cannot remove a Remove Card, so a hand holding only those is no target.
  const removable = p => p.regularCards.length > 0 || p.specialCards.some(c => c !== 'RC');
  const targets = view.players.filter(p => p.status === 'active' && removable(p));
  if (targets.length === 0) return SKIP;

  const candidates = [];
  for (const target of targets) {
    const mine = target.id === seat.id;
    for (const entry of cardsOf(target, card => card !== 'RC')) {
      candidates.push({
        ...entry,
        // On somebody else, take away their best. On yourself, take away your worst -
        // which is the only reason to ever aim this at your own hand.
        gain: mine ? -cardValue(entry.card) : cardValue(entry.card) * rivalWeight(target, view)
      });
    }
  }
  if (candidates.length === 0) return SKIP;

  const pick = rng() < traits.mistakeChance
    ? pickRandom(candidates, rng)
    : best(candidates, c => c.gain);

  return {
    type: 'remove-card',
    targetId: pick.playerId,
    cardIndex: pick.index,
    isSpecial: pick.isSpecial,
    confidence: 0.7
  };
};

const decideStealCard = (view, seat, traits, rng) => {
  const targets = view.players.filter(
    p => p.status !== 'busted' && p.id !== seat.id &&
      (p.regularCards.length > 0 || p.specialCards.length > 0)
  );
  if (targets.length === 0) return SKIP;

  const candidates = [];
  for (const target of targets) {
    for (const entry of cardsOf(target)) {
      candidates.push({
        ...entry,
        // A stolen number lands in your hand and can bust you, which receiveValue knows.
        gain: receiveValue(entry.card, seat) + cardValue(entry.card) * rivalWeight(target, view) * 0.5
      });
    }
  }
  if (candidates.length === 0) return SKIP;

  const pick = rng() < traits.mistakeChance
    ? pickRandom(candidates, rng)
    : best(candidates, c => c.gain);

  return {
    type: 'steal-card',
    targetId: pick.playerId,
    cardIndex: pick.index,
    isSpecial: pick.isSpecial,
    confidence: 0.7
  };
};

const decideSwap = (view, seat, traits, rng) => {
  const eligible = view.players
    .filter(p => p.status !== 'busted')
    .map(p => ({ player: p, entries: cardsOf(p, isSwappableSpecial) }))
    .filter(p => p.entries.length > 0);

  // The server wants two different players who each have something to give.
  if (eligible.length < 2) return SKIP;

  // What one side of the trade is worth from this seat's point of view: good for me
  // counts in full, good for a rival counts against me in proportion to their threat.
  const sideScore = (side, lost, gained) => {
    const delta = receiveValue(gained, side) - cardValue(lost);
    return side.id === seat.id ? delta : -delta * rivalWeight(side, view);
  };

  const pairs = [];
  for (let a = 0; a < eligible.length; a++) {
    for (let b = a + 1; b < eligible.length; b++) {
      for (const first of eligible[a].entries) {
        for (const second of eligible[b].entries) {
          pairs.push({
            card1: { playerId: first.playerId, index: first.index, isSpecial: first.isSpecial },
            card2: { playerId: second.playerId, index: second.index, isSpecial: second.isSpecial },
            gain:
              sideScore(eligible[a].player, first.card, second.card) +
              sideScore(eligible[b].player, second.card, first.card)
          });
        }
      }
    }
  }
  if (pairs.length === 0) return SKIP;

  const pick = rng() < traits.mistakeChance
    ? pickRandom(pairs, rng)
    : best(pairs, p => p.gain);

  return { type: 'swap-cards', card1: pick.card1, card2: pick.card2, confidence: 0.6 };
};

// The one decision that may read the draw pile: a Select genuinely shows its holder the
// whole pile, so this is the same information a human gets from the popup.
const decideSelect = (view, seat, traits, rng) => {
  const choices = [...new Set(view.deck || [])];
  if (choices.length === 0) return SKIP;

  const maxCards = view.maxRegularCards || MAX_REGULAR_CARDS;
  const oneOffSeven = seat.regularCards.length === maxCards - 1;

  const worth = card => {
    let value = receiveValue(card, seat);
    // A doubler is only as good as the hand it doubles.
    if (card === '2x') value = Math.max(6, seat.roundScore);
    if (typeof card === 'number' && value > 0) {
      if (oneOffSeven) value += 15;              // completing the set pays the bonus
      value += traits.greed * card * 0.3;        // the greedy ones just want the big one
    }
    return value;
  };

  const pick = rng() < traits.mistakeChance
    ? pickRandom(choices, rng)
    : best(choices, worth);

  return { type: 'select-card', card: pick, confidence: 0.7 };
};

const TARGET_DECIDERS = {
  Freeze: decideFreeze,
  D3: decideDrawThree,
  RC: decideRemoveCard,
  ST: decideStealCard,
  Swap: decideSwap,
  Select: decideSelect
};

// ---------------------------------------------------------------------------
// The one thing server.js calls
// ---------------------------------------------------------------------------

// view is a plain snapshot:
//   { players, currentPlayer, deckMode, deck, winningScore, maxRegularCards, roundNumber }
// Returns a move whose shape lines up with the socket event that performs it, plus a
// confidence server.js turns into a thinking pause. Always returns something: 'skip'
// means "there is nothing legal here", which server.js resolves by discarding the card.
const decideMove = (view, { rng = Math.random } = {}) => {
  if (!view || !Array.isArray(view.players)) return SKIP;

  const seat = view.players[view.currentPlayer];
  if (!seat) return SKIP;

  const traits = personalityOf(seat);

  // A card waiting on a target owns the turn until it gets one.
  if (seat.pendingTarget) {
    const decide = TARGET_DECIDERS[seat.pendingTarget];
    // An unknown pendingTarget is a card this file has not been taught. Skipping
    // discards it, which costs a turn and never wedges the table.
    if (!decide) return SKIP;
    // The holder must still actually have the card; the server checks the same thing.
    if (!seat.specialCards.includes(seat.pendingTarget)) return SKIP;
    return decide(view, seat, traits, rng);
  }

  if (seat.status !== 'active') return SKIP;

  return decideFlipOrStand(view, seat, traits, rng);
};

// How long to sit there before doing it. Lives here because it is pure and worth
// testing; server.js owns the actual timer.
const thinkDelay = (personalityKey, confidence = 1, rng = Math.random) => {
  const traits = personality(personalityKey);
  // A close call takes longer, so a bot hesitates in the same places a person would.
  const hesitation = (1 - clamp(confidence, 0, 1)) * 900;
  const ms = traits.speed + rng() * traits.speedSpread + hesitation;
  return Math.round(clamp(ms, MIN_THINK_MS, MAX_THINK_MS));
};

module.exports = {
  PERSONALITIES,
  PERSONALITY_KEYS,
  DEFAULT_PERSONALITY,
  MIN_THINK_MS,
  MAX_THINK_MS,
  personality,
  personalityOf,
  deckComposition,
  estimateBustChance,
  standThreshold,
  cardValue,
  receiveValue,
  decideMove,
  thinkDelay
};
