// Who is actually gone, and when the table has to stop for them.
//
// Pulled out of server.js because it is a rule about time, and a rule about time is the
// kind that is easy to get subtly wrong and impossible to notice by playing. Nothing in
// here knows about sockets, rooms or the history log.
//
// The problem it exists to solve: a phone kills the websocket within a couple of seconds
// of switching to another app. Without a grace period, glancing at a message is
// indistinguishable from walking away from the table, so the game stopped dead for
// everybody every time anybody looked at a notification.

// Long enough to cover reading a message and coming back, short enough that a table is
// not left guessing when somebody has genuinely gone.
const DEFAULT_PAUSE_GRACE_MS = 20 * 1000;

// A dropped connection is not the same thing as an absent player. This is the second one.
//
// `disconnectedAt` missing on a disconnected player means the drop was never stamped -
// state left over from an older shape rather than a fresh one - so it counts as gone
// immediately. Failing that way round is the safe one: the alternative would be a seat
// that never counts as missing and a game nobody can ever un-stick.
const isMissing = (player, { now = Date.now(), graceMs = DEFAULT_PAUSE_GRACE_MS } = {}) => {
  if (!player || player.connected) return false;
  if (!player.disconnectedAt) return true;
  return now - player.disconnectedAt >= graceMs;
};

// A round cannot be played on with someone missing: their hand, their banked score and
// possibly the current turn are all still on the table, and none of it can be fairly
// unpicked. Everyone waits instead.
//
// Only ever true of a game in progress. A lobby has nothing to hold open, and a finished
// game has nothing left to play.
const isGamePaused = (game, options) =>
  Boolean(game) &&
  game.status === 'playing' &&
  game.players.some(player => isMissing(player, options));

module.exports = {
  DEFAULT_PAUSE_GRACE_MS,
  isMissing,
  isGamePaused
};
