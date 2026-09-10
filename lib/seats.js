// Who is sitting where, and who is allowed to sit down.
//
// The third file pulled out of server.js after lib/rules.js, and for the same reason:
// these decisions used to be reachable only by opening six browser tabs and closing
// them in the right order. Seats, unlike cards, are mostly about *identity* - which
// person a socket belongs to, whose seat is being held open, who is in charge while the
// host is away - and identity bugs are the ones that let somebody take a seat that is
// not theirs.
//
// Nothing here knows about sockets or rooms. It reads a game and answers a question.

const { MAX_PLAYERS, MAX_BOTS, MIN_NAME_LENGTH } = require('./rules');

// A bot is an ordinary player in game.players, with a hand, a score and a turn. Two
// things mark it: `isBot`, and a null token. The null token is load-bearing - see
// findByToken.
const isBot = player => Boolean(player && player.isBot);

// "Is anybody actually here." Bots are marked connected so that a bot seat does not
// pause the table forever, which means `connected` alone stopped meaning "a person",
// and everywhere that meant a person has to say so.
const humansIn = game => game.players.filter(p => !isBot(p));

const connectedHumans = game => game.players.filter(p => p.connected && !isBot(p));

// Socket ids change on every reconnect, so anything that has to outlive a dropped
// connection is keyed by token instead.
//
// The empty-string and null guards are what stop a bot seat being claimable: bots are
// created with `token: null`, so a client sending no token must never match one.
const findByToken = (game, token) =>
  typeof token === 'string' && token
    ? game.players.find(p => p.token === token)
    : undefined;

// Forgiving on purpose: somebody retyping their name from memory should not be locked
// out of their own seat by capitalisation or a stray space.
const namesMatch = (a, b) =>
  String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// The seat a returning player is asking for. Only ever one nobody is sitting in - a
// connected player's seat can never be taken from them.
const findDisconnectedSeatByName = (game, name) =>
  game.players.find(p => !p.connected && namesMatch(p.name, name));

// Who holds the host powers right now.
//
// hostId is a socket id, because that is what clients compare against, so it has to be
// re-derived whenever connections change. The original host gets their powers back the
// moment they return; until then the first connected person stands in, so there is
// always somebody able to kick a player who is never coming back.
//
// Never a bot. A bot would never kick the player everyone is waiting on, and a table
// would look hosted when there is nobody there at all.
const actingHost = (game) => {
  const original = findByToken(game, game.hostToken);
  if (original && original.connected) return original;
  return game.players.find(p => p.connected && !isBot(p));
};

// Why this person may not sit down, or null if they may.
//
// Only the lobby case: taking back a seat that is being held for you is decided before
// any of this, because retyping your own name would otherwise be refused as a clash
// with yourself and there would be no way back into your own game.
const lobbyJoinRefusal = (game, name, socketId) => {
  // Counted in people, not seats. A bot seat is not a full table - syncBotSeats gives
  // one up the moment somebody real arrives, which is what "people take priority over
  // bots" has always meant. Counting every seat here refused a friend from a game whose
  // host had filled the spare chairs with bots, which is exactly backwards.
  if (humansIn(game).length >= MAX_PLAYERS) {
    return `Game is full (${MAX_PLAYERS} players max)!`;
  }
  if (game.players.some(p => p.id === socketId)) {
    return 'You are already in this game!';
  }
  // Names are how a returning player proves which seat is theirs, so two players
  // sharing one would make that ambiguous - and two identical names on the board are
  // confusing regardless.
  if (game.players.some(p => namesMatch(p.name, name))) {
    return `Somebody in this game is already called "${name}".`;
  }
  return null;
};

const nameRefusal = name =>
  (typeof name === 'string' && name.length >= MIN_NAME_LENGTH)
    ? null
    : `Name must be at least ${MIN_NAME_LENGTH} characters!`;

// How many bot seats the table should actually have.
//
// The setting is what the host asked for; this is what the table has room for. People
// take priority over bots, so every human already sitting down costs a bot seat.
//
// The "never more than MAX_BOTS" rule is enforced one step earlier too, when the
// setting is sanitized, because that ceiling is about what a host may ask for. It is
// repeated here so a stored setting from before the cap existed cannot slip past.
const wantedBotCount = (asked, humans) => Math.min(
  Math.max(0, Number.isInteger(asked) ? asked : 0),
  MAX_BOTS,
  Math.max(0, MAX_PLAYERS - humans)
);

// The first name from this personality's list that nobody at the table is using, or a
// numbered fallback. Two bots of the same personality would otherwise share a name, and
// names are how the rest of the server tells seats apart.
const pickBotName = (traits, takenNames, seatNumber) => {
  const taken = new Set(takenNames.map(n => String(n).trim().toLowerCase()));
  return traits.names.find(n => !taken.has(n.toLowerCase()))
    || `${traits.label} ${seatNumber}`;
};

module.exports = {
  isBot,
  humansIn,
  connectedHumans,
  findByToken,
  namesMatch,
  findDisconnectedSeatByName,
  actingHost,
  lobbyJoinRefusal,
  nameRefusal,
  wantedBotCount,
  pickBotName
};
