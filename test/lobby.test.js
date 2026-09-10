// The lobby: who may sit down, how bot seats are filled, and what the host alone can do.
//
// lib/seats.js holds the rules; these check the handlers actually apply them. A rule
// that is right in a unit test and never called is still a hole.

const test = require('node:test');
const assert = require('node:assert');

const { startServer, openLobby, startGame } = require('./helpers/harness');
const { MAX_PLAYERS, MAX_BOTS } = require('../lib/rules');

const seat = (state, name) => state.players.find(p => p.name === name);

test('a game needs a name of at least three characters', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const ada = await server.client('Ada');

  const refused = ada.once('error');
  ada.emit('create-game', 'ab');
  assert.match(await refused, /at least 3/i);

  const trimmed = ada.once('error');
  ada.emit('create-game', '   x   ');
  assert.match(await trimmed, /at least 3/i, 'and spaces do not count towards it');
});

test('two people cannot share a name, however they type it', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId } = await openLobby(server, ['Ada']);
  const impostor = await server.client('ada');

  const refused = impostor.once('error');
  impostor.emit('join-game', gameId, '  ADA  ');
  assert.match(await refused, /already called/i);
});

test('a game that does not exist cannot be joined', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const ada = await server.client('Ada');
  const refused = ada.once('error');
  ada.emit('join-game', 'ZZZZZ', 'Ada');
  assert.match(await refused, /not found/i);
});

test('the table fills up and then refuses', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const names = Array.from({ length: MAX_PLAYERS }, (_, i) => `Player${i + 1}`);
  const { gameId } = await openLobby(server, names);

  const latecomer = await server.client('Latecomer');
  const refused = latecomer.once('error');
  latecomer.emit('join-game', gameId, 'Latecomer');
  assert.match(await refused, /full/i);
});

// Bots are seats, not a mode, so asking for them adds players to the table.
test('bot seats appear, spread across personalities, and go again', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await openLobby(server, ['Ada']);

  const withBots = ada.waitForState(
    state => state.players.length === 4,
    { what: 'three bot seats' }
  );
  ada.emit('update-settings', gameId, { botCount: 3 });
  const state = await withBots;

  const bots = state.players.filter(p => p.isBot);
  assert.strictEqual(bots.length, 3);
  assert.strictEqual(
    new Set(bots.map(b => b.name)).size, 3,
    'no two bots share a name'
  );
  assert.strictEqual(
    new Set(bots.map(b => b.bot.personality)).size, 3,
    'and they are three different personalities, not three of one'
  );
  // A bot must never be handed anything a client could rejoin with.
  assert.ok(bots.every(b => b.token === undefined), 'no bot carries a token');

  const fewer = ada.waitForState(
    state => state.players.filter(p => p.isBot).length === 1,
    { what: 'one bot seat' }
  );
  ada.emit('update-settings', gameId, { botCount: 1 });
  await fewer;
});

// Only once the table is actually full. Before that a newcomer just takes one of the
// empty seats, which is why this fills the table to MAX_PLAYERS first.
test('people take the seats bots were sitting in', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const people = Array.from(
    { length: MAX_PLAYERS - MAX_BOTS },
    (_, i) => `Person${i + 1}`
  );
  const { gameId, host: ada } = await openLobby(server, people);

  const filled = ada.waitForState(
    state => state.players.length === MAX_PLAYERS,
    { what: 'a full table' }
  );
  ada.emit('update-settings', gameId, { botCount: MAX_BOTS });
  await filled;

  // A person arriving must be able to sit down, which means a bot has to get up.
  // Deliberately not a name from lib/bot.js's lists - "Zed" is a Reckless bot, and
  // clashing with one is a different rule being tested elsewhere.
  const quinn = await server.client('Quinn');

  // Registered before the join is sent. Ada's broadcast goes out in the same tick as
  // Quinn's acknowledgement, so listening only afterwards misses it.
  const seated = ada.waitForState(
    state => state.players.some(p => p.name === 'Quinn'),
    { what: 'Quinn to be seated' }
  );
  const joined = quinn.once('game-joined');
  quinn.emit('join-game', gameId, 'Quinn');
  await joined;
  const state = await seated;

  assert.strictEqual(state.players.length, MAX_PLAYERS, 'the table did not grow');
  assert.strictEqual(
    state.players.filter(p => p.isBot).length,
    MAX_BOTS - 1,
    'a bot gave up its seat'
  );
  assert.strictEqual(
    state.settings.botCount,
    MAX_BOTS - 1,
    'and the setting agrees with the table'
  );
});

// A newcomer takes an empty chair when there is one - no bot has to move.
test('an empty seat is taken before a bot is asked to move', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await openLobby(server, ['Ada']);

  const filled = ada.waitForState(
    state => state.players.length === MAX_BOTS + 1,
    { what: 'every bot seat taken' }
  );
  ada.emit('update-settings', gameId, { botCount: MAX_BOTS });
  await filled;

  const quinn = await server.client('Quinn');
  const seated = ada.waitForState(
    state => state.players.some(p => p.name === 'Quinn'),
    { what: 'Quinn to be seated' }
  );
  const joined = quinn.once('game-joined');
  quinn.emit('join-game', gameId, 'Quinn');
  await joined;
  const state = await seated;

  assert.strictEqual(state.players.length, MAX_BOTS + 2, 'the table grew by one');
  assert.strictEqual(
    state.players.filter(p => p.isBot).length,
    MAX_BOTS,
    'every bot kept its seat'
  );
});

// Bots stop at MAX_BOTS however many seats the table has, so there is always room for
// people - a host can never turn the game into a bot demo.
test('a host cannot ask for more bots than the cap', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await openLobby(server, ['Ada']);

  const clamped = ada.waitForState(
    state => state.settings.botCount === MAX_BOTS,
    { what: 'the bot count to be clamped' }
  );
  ada.emit('update-settings', gameId, { botCount: 99 });
  const state = await clamped;

  assert.strictEqual(state.players.length, MAX_BOTS + 1);
  assert.ok(state.players.some(p => !p.isBot), 'there is still a person at the table');
});

test('only the host changes the settings', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [zed] } = await openLobby(server, ['Ada', 'Zed']);

  // Zed asks for a different target score. Nothing should move.
  zed.emit('update-settings', gameId, { winningScore: 300 });

  // Then Ada asks for one, which does. If Zed's had worked, this would arrive as 300
  // before ever being asked for.
  const changed = ada.waitForState(
    state => state.settings.winningScore === 100,
    { what: "Ada's setting to land" }
  );
  ada.emit('update-settings', gameId, { winningScore: 100 });
  const state = await changed;

  assert.strictEqual(state.settings.winningScore, 100);
});

test('nonsense settings are ignored rather than refused', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await openLobby(server, ['Ada']);

  const settled = ada.waitForState(
    state => state.settings.deckMode === 'normal',
    { what: 'the deck to change' }
  );
  ada.emit('update-settings', gameId, {
    winningScore: 12345,      // not one of the four
    deckMode: 'normal',       // this one is real
    botCount: 'lots'          // not a number
  });
  const state = await settled;

  assert.strictEqual(state.settings.winningScore, 200, 'kept the old target score');
  assert.strictEqual(state.settings.botCount, 0, 'kept the old bot count');
  assert.strictEqual(state.deck.length, 94, 'and the pile really is the normal deck');
});

test('a game does not start with one player, and only the host starts it', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await openLobby(server, ['Ada']);

  // Alone. Nothing happens.
  ada.emit('start-game', gameId);

  const zed = await server.client('Zed');
  const joined = zed.once('game-joined');
  zed.emit('join-game', gameId, 'Zed');
  await joined;

  // Two players now, but Zed is not the host.
  zed.emit('start-game', gameId);

  const started = ada.once('game-started');
  ada.emit('start-game', gameId);
  const state = await started;

  assert.strictEqual(state.status, 'playing');
  assert.strictEqual(state.roundNumber, 1, 'started once, not three times');
  assert.ok(state.players.every(p => p.status === 'active'));
});

// Once cards are on the table the deck and the target score are part of the game
// everybody agreed to play.
test('settings are locked once the game is under way', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await startGame(server, ['Ada', 'Zed']);

  ada.emit('update-settings', gameId, { winningScore: 100, deckMode: 'normal' });

  // Something that definitely broadcasts, so there is a state to look at afterwards.
  const state = await (async () => {
    const wait = ada.waitForState(s => s.lastCardDrawn !== null, { what: 'a card to be drawn' });
    ada.emit('flip-card', gameId);
    return wait;
  })();

  assert.strictEqual(state.settings.winningScore, 200, 'the target score did not move');
  assert.strictEqual(state.settings.deckMode, 'extreme', 'and neither did the deck');
});

test('a game already under way cannot be joined by a stranger', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId } = await startGame(server, ['Ada', 'Zed']);

  const latecomer = await server.client('Nobody');
  const refused = latecomer.once('error');
  latecomer.emit('join-game', gameId, 'Nobody');
  assert.match(await refused, /already under way|no seat/i);

  const state = await latecomer.waitForState(() => true, { what: 'any broadcast' })
    .catch(() => null);
  assert.strictEqual(state, null, 'and they are not in the room to hear anything');
});

// ---------------------------------------------------------------- clearing a seat

// A game code goes round a group chat, and whoever it reaches can sit down. Before the
// deal there is no round to lose by removing them, so the host is not stuck with them.
test('the host removes a player who is sitting in the lobby', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await openLobby(server, ['Ada', 'Quinn']);

  const told = quinn.once('removed-from-game');
  const shorter = ada.waitForState(state => state.players.length === 1, { what: 'Quinn gone' });

  ada.emit('kick-player', gameId, quinn.id);

  assert.match(await told, /removed you/i, 'the player is told, not just dropped');
  const lobby = await shorter;
  assert.ok(!lobby.players.some(p => p.name === 'Quinn'), 'and the seat is gone');
});

// Their seat no longer exists, so the token that pointed at it is worth nothing.
test('a removed player cannot use their token to walk back in', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn], tokens } =
    await openLobby(server, ['Ada', 'Quinn']);

  const told = quinn.once('removed-from-game');
  ada.emit('kick-player', gameId, quinn.id);
  await told;

  const refused = quinn.once('rejoin-failed');
  quinn.emit('rejoin-game', gameId, tokens.Quinn);
  assert.match(await refused, /no longer in that game/i);
});

test('the host cannot remove themselves, and a guest cannot remove anybody', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await openLobby(server, ['Ada', 'Quinn']);

  const refusedSelf = ada.once('error');
  ada.emit('kick-player', gameId, ada.id);
  assert.match(await refusedSelf, /cannot remove themselves/i);

  // A non-host is ignored rather than refused, so there is no event to await. The host
  // changing a setting is a round trip that does answer, and by the time it lands the
  // ignored kicks have long since been handled.
  quinn.emit('kick-player', gameId, ada.id);

  const settled = ada.waitForState(
    state => state.settings.winningScore === 100, { what: 'the target score' }
  );
  ada.emit('update-settings', gameId, { winningScore: 100 });
  const state = await settled;

  assert.strictEqual(state.players.length, 2, 'both seats still there');
  assert.ok(state.players.some(p => p.name === 'Ada'), 'including the host');
});

// ---------------------------------------------------------------- leaving the lobby

// Tapping "Create Game" when you meant "Join" used to be a one-way door.
test('the host cancels the lobby and everybody is sent back', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await openLobby(server, ['Ada', 'Quinn']);

  const guestTold = quinn.once('game-cancelled');
  const hostTold = ada.once('left-lobby');
  ada.emit('leave-lobby', gameId);

  assert.match(await guestTold, /cancelled/i);
  await hostTold;

  // The game is gone, not just emptied: the code stops working for everyone.
  const stranger = await server.client('Milo-the-human');
  const refused = stranger.once('error');
  stranger.emit('join-game', gameId, 'Milo-the-human');
  assert.match(await refused, /not found/i);
});

test('a guest leaves the lobby and the game carries on without them', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await openLobby(server, ['Ada', 'Quinn']);

  const left = quinn.once('left-lobby');
  const shorter = ada.waitForState(state => state.players.length === 1, { what: 'Quinn gone' });

  quinn.emit('leave-lobby', gameId);
  await left;

  const lobby = await shorter;
  assert.ok(!lobby.players.some(p => p.name === 'Quinn'));
  assert.strictEqual(lobby.status, 'lobby', 'and the lobby is still open');
  assert.ok(lobby.players.some(p => p.name === 'Ada'), 'with the host still in it');
});

// Once cards are dealt this door is shut: walking out mid-round is what the dropped-player
// handling is for, and it keeps the seat rather than deleting the game under everyone.
test('leaving does nothing once the game has started', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, tokens } = await startGame(server, ['Ada', 'Quinn']);

  ada.emit('leave-lobby', gameId);

  // Nothing is emitted back, so the proof is a round trip that does answer: the host's
  // own token still finds the seat it was supposed to have lost.
  const back = ada.once('rejoined');
  ada.emit('rejoin-game', gameId, tokens.Ada);
  const { game } = await back;

  assert.strictEqual(game.players.length, 2, 'nobody left the table');
  assert.strictEqual(game.status, 'playing');
});
