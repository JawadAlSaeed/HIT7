const test = require('node:test');
const assert = require('node:assert');

const {
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
} = require('../lib/seats');

const { MAX_PLAYERS, MAX_BOTS } = require('../lib/rules');

const person = (name, overrides = {}) => ({
  id: `socket:${name}`,
  token: `token:${name}`,
  name,
  connected: true,
  ...overrides
});

const bot = (name, overrides = {}) => ({
  id: `bot:${name}`,
  // The load-bearing part: a bot never has a token.
  token: null,
  name,
  connected: true,
  isBot: true,
  ...overrides
});

const table = (players, hostToken) => ({ players, hostToken });

// ---------------------------------------------------------------- who is a person

test('a bot is a bot, and everything else is not', () => {
  assert.strictEqual(isBot(bot('Nina')), true);
  assert.strictEqual(isBot(person('Ada')), false);
  assert.strictEqual(isBot(null), false);
  assert.strictEqual(isBot(undefined), false);
});

// Bots are marked connected so a bot seat does not pause the table forever, which is
// why "connected" stopped meaning "a person is here" and these two exist.
test('humans and connected humans are counted apart from bots', () => {
  const game = table([
    person('Ada'),
    bot('Nina'),
    person('Zed', { connected: false })
  ]);

  assert.deepStrictEqual(humansIn(game).map(p => p.name), ['Ada', 'Zed']);
  assert.deepStrictEqual(connectedHumans(game).map(p => p.name), ['Ada']);
});

// ---------------------------------------------------------------- identity

test('a token finds its seat', () => {
  const ada = person('Ada');
  const game = table([ada, person('Zed')]);
  assert.strictEqual(findByToken(game, 'token:Ada'), ada);
  assert.strictEqual(findByToken(game, 'token:Nobody'), undefined);
});

// A bot seat has token null. If an empty or missing token matched, any client sending
// nothing would be handed a bot's seat - and with it, its turn.
test('no token never matches a seat, especially not a bot one', () => {
  const game = table([bot('Nina'), person('Ada')]);
  for (const token of [null, undefined, '', 0, false, {}]) {
    assert.strictEqual(findByToken(game, token), undefined, `${String(token)} must not match`);
  }
});

test('names match past capitals and stray spaces', () => {
  assert.strictEqual(namesMatch('Ada', 'ada'), true);
  assert.strictEqual(namesMatch('  Ada ', 'ADA'), true);
  assert.strictEqual(namesMatch('Ada', 'Adam'), false);
});

test('only a seat nobody is sitting in can be claimed back by name', () => {
  const away = person('Ada', { connected: false });
  const game = table([person('Zed'), away]);

  assert.strictEqual(findDisconnectedSeatByName(game, 'ada'), away);
  // Zed is connected, so Zed's seat is not available to anybody typing "Zed".
  assert.strictEqual(findDisconnectedSeatByName(game, 'Zed'), undefined);
});

// ---------------------------------------------------------------- who is in charge

test('the original host holds the powers while they are connected', () => {
  const ada = person('Ada');
  const game = table([ada, person('Zed')], 'token:Ada');
  assert.strictEqual(actingHost(game), ada);
});

test('somebody stands in while the host is away, and hands it back on return', () => {
  const ada = person('Ada', { connected: false });
  const zed = person('Zed');
  const game = table([ada, zed], 'token:Ada');

  assert.strictEqual(actingHost(game), zed, 'Zed stands in');

  ada.connected = true;
  assert.strictEqual(actingHost(game), ada, 'and gives it straight back');
});

// A bot would never kick the player everyone is waiting on, and a table would look
// hosted when there is nobody there at all.
test('a bot never stands in as host', () => {
  const game = table([
    person('Ada', { connected: false }),
    bot('Nina'),
    person('Zed')
  ], 'token:Ada');

  assert.strictEqual(actingHost(game).name, 'Zed');
});

test('a table of nothing but bots has no host at all', () => {
  const game = table([bot('Nina'), bot('Zad')], 'token:Ada');
  assert.strictEqual(actingHost(game), undefined);
});

// ---------------------------------------------------------------- sitting down

test('a table full of people refuses everybody', () => {
  const players = Array.from({ length: MAX_PLAYERS }, (_, i) => person(`P${i}`));
  const refusal = lobbyJoinRefusal(table(players), 'Ada', 'socket:new');
  assert.match(refusal, /full/i);
});

// This was a real bug: a host who filled the spare chairs with bots and then shared the
// link had locked their friends out. Seats were counted, so a bot counted the same as a
// person - even though syncBotSeats gives a bot seat up the moment somebody real
// arrives. Counted in people now.
test('a table full of bots still has room for a person', () => {
  const players = [person('Ada'), ...Array.from(
    { length: MAX_PLAYERS - 1 },
    (_, i) => bot(`Bot${i}`)
  )];
  assert.strictEqual(players.length, MAX_PLAYERS, 'every seat is taken');
  assert.strictEqual(lobbyJoinRefusal(table(players), 'Zed', 'socket:new'), null);
});

test('bots do not shield a table that is already full of people', () => {
  const players = [
    ...Array.from({ length: MAX_PLAYERS }, (_, i) => person(`P${i}`)),
    bot('Nina')
  ];
  assert.match(lobbyJoinRefusal(table(players), 'Zed', 'socket:new'), /full/i);
});

test('you cannot join a game you are already in', () => {
  const game = table([person('Ada')]);
  assert.match(lobbyJoinRefusal(game, 'Zed', 'socket:Ada'), /already in this game/i);
});

// Names are how a returning player proves which seat is theirs, so two people sharing
// one would make that ambiguous.
test('two people cannot share a name, however they type it', () => {
  const game = table([person('Ada')]);
  assert.match(lobbyJoinRefusal(game, 'ada', 'socket:new'), /already called/i);
  assert.match(lobbyJoinRefusal(game, '  ADA  ', 'socket:new'), /already called/i);
});

test('a bot name is taken like anybody else', () => {
  const game = table([person('Ada'), bot('Nina')]);
  assert.match(lobbyJoinRefusal(game, 'Nina', 'socket:new'), /already called/i);
});

test('an ordinary join is refused for nothing', () => {
  const game = table([person('Ada')]);
  assert.strictEqual(lobbyJoinRefusal(game, 'Zed', 'socket:new'), null);
});

test('a name has to be long enough', () => {
  assert.match(nameRefusal('ab'), /at least 3/);
  assert.match(nameRefusal(''), /at least 3/);
  assert.match(nameRefusal(null), /at least 3/);
  assert.strictEqual(nameRefusal('Ada'), null);
});

// ---------------------------------------------------------------- bot seats

test('people take priority over bots for the seats that are left', () => {
  assert.strictEqual(wantedBotCount(MAX_BOTS, 1), MAX_BOTS, 'one human, every bot seat');
  assert.strictEqual(
    wantedBotCount(MAX_BOTS, MAX_PLAYERS - 2),
    2,
    'two seats left over leaves room for two bots'
  );
  assert.strictEqual(
    wantedBotCount(MAX_BOTS, MAX_PLAYERS),
    0,
    'a full table of people takes none'
  );
});

// The table holds MAX_PLAYERS but bots stop at MAX_BOTS, so a mostly empty table still
// does not fill itself with bots.
test('bots never outgrow their own cap however empty the table is', () => {
  assert.strictEqual(wantedBotCount(99, 1), MAX_BOTS);
  assert.strictEqual(wantedBotCount(MAX_PLAYERS, 1), MAX_BOTS);
});

test('a nonsense bot count is treated as none rather than thrown at', () => {
  for (const asked of [-4, 1.5, NaN, null, undefined, 'three']) {
    assert.strictEqual(wantedBotCount(asked, 1), 0, `${String(asked)} should be 0`);
  }
});

test('asking for fewer bots than there is room for is honoured', () => {
  assert.strictEqual(wantedBotCount(2, 1), 2);
  assert.strictEqual(wantedBotCount(0, 1), 0);
});

test('a bot takes the first name of its kind that is free', () => {
  const traits = { key: 'cautious', label: 'Cautious', names: ['Nina', 'Omar', 'Ruth'] };
  assert.strictEqual(pickBotName(traits, ['Ada'], 2), 'Nina');
  assert.strictEqual(pickBotName(traits, ['Ada', 'nina'], 3), 'Omar');
  assert.strictEqual(pickBotName(traits, ['Nina', 'Omar', 'Ruth'], 4), 'Cautious 4');
});

// Names are how the rest of the server tells seats apart, so two bots of one
// personality must never end up sharing one.
test('two bots of the same personality get different names', () => {
  const traits = { key: 'reckless', label: 'Reckless', names: ['Zad', 'Kim'] };
  const first = pickBotName(traits, ['Ada'], 2);
  const second = pickBotName(traits, ['Ada', first], 3);
  assert.notStrictEqual(first, second);
});
