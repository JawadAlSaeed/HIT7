const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_PAUSE_GRACE_MS,
  isMissing,
  isGamePaused
} = require('../lib/presence');

// A fixed clock, so none of this depends on how long the test itself takes to run.
const NOW = 1_700_000_000_000;
const GRACE = 20_000;
const at = ms => ({ now: NOW, graceMs: ms === undefined ? GRACE : ms });

const player = (overrides = {}) => ({
  name: 'Ada',
  connected: true,
  disconnectedAt: null,
  ...overrides
});

const game = (players, status = 'playing') => ({ status, players });

// The whole point of the module: a phone that dropped its socket a moment ago is a
// player who is still there, not one who has left.
test('somebody who just dropped is not missing yet', () => {
  const away = player({ connected: false, disconnectedAt: NOW - 3_000 });
  assert.equal(isMissing(away, at()), false);
});

test('somebody gone longer than the grace period is missing', () => {
  const away = player({ connected: false, disconnectedAt: NOW - 25_000 });
  assert.equal(isMissing(away, at()), true);
});

// The boundary is inclusive, so the state cannot sit in a gap between the two answers.
test('the grace period ends exactly on the boundary', () => {
  const away = player({ connected: false, disconnectedAt: NOW - GRACE });
  assert.equal(isMissing(away, at()), true);

  const barely = player({ connected: false, disconnectedAt: NOW - (GRACE - 1) });
  assert.equal(isMissing(barely, at()), false);
});

test('a connected player is never missing, however old the stamp', () => {
  const here = player({ connected: true, disconnectedAt: NOW - 10 * 60 * 1000 });
  assert.equal(isMissing(here, at()), false);
});

// Failing this way round is deliberate: a seat that could never count as missing would be
// a game nobody could ever un-stick.
test('a disconnected player with no stamp counts as gone immediately', () => {
  const away = player({ connected: false, disconnectedAt: null });
  assert.equal(isMissing(away, at()), true);
});

test('the grace period is configurable and defaults to a sane one', () => {
  const away = player({ connected: false, disconnectedAt: NOW - 30_000 });
  assert.equal(isMissing(away, { now: NOW, graceMs: 60_000 }), false);
  assert.equal(isMissing(away, { now: NOW, graceMs: 10_000 }), true);
  assert.ok(DEFAULT_PAUSE_GRACE_MS >= 5_000 && DEFAULT_PAUSE_GRACE_MS <= 60_000);
});

// This is the bug the whole change is about: one person glancing at a message used to
// stop the table for everybody.
test('a blip does not pause the table, a real absence does', () => {
  const blipping = player({ name: 'Bo', connected: false, disconnectedAt: NOW - 4_000 });
  const table = game([player(), blipping]);

  assert.equal(isGamePaused(table, at()), false);

  blipping.disconnectedAt = NOW - 21_000;
  assert.equal(isGamePaused(table, at()), true);
});

// Bots are marked connected, and that is what stops a table of them pausing itself.
test('bots never pause a game', () => {
  const bot = player({ name: 'Bot', isBot: true, connected: true });
  assert.equal(isGamePaused(game([player(), bot]), at()), false);
});

// A lobby seat is held rather than freed now, so a disconnected player sits in the list
// with a round that has not started. Nothing there can be paused.
test('only a game in progress can be paused', () => {
  const away = player({ connected: false, disconnectedAt: NOW - 60_000 });

  assert.equal(isGamePaused(game([player(), away], 'lobby'), at()), false);
  assert.equal(isGamePaused(game([player(), away], 'finished'), at()), false);
  assert.equal(isGamePaused(game([player(), away], 'playing'), at()), true);
});

test('a table with nobody missing is never paused', () => {
  assert.equal(isGamePaused(game([player(), player({ name: 'Bo' })]), at()), false);
});
