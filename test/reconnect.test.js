// Coming back: reconnects, held seats, and who is in charge while somebody is away.
//
// This is where the bugs bite hardest, because a phone kills its websocket every time
// you switch apps - so every one of these paths runs constantly in a real game, and a
// mistake here loses somebody their seat rather than just their turn.

const test = require('node:test');
const assert = require('node:assert');

const { startServer, startGame, openLobby } = require('./helpers/harness');

const seat = (state, name) => state.players.find(p => p.name === name);

// Long enough that these tests never race the grace period, short enough that the
// "gone" cases do not sit around waiting for it.
const FAST_GRACE = { PAUSE_GRACE_MS: '400' };

test('a token gets you back into your own seat after a refresh', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [zed], tokens } = await startGame(
    server, ['Ada', 'Zed']
  );

  // Ada plays a card, so the seat has something in it worth coming back to. The deck
  // is stacked with a plain number on purpose: drawing a targeting card off a real
  // shuffle would open a popup, and a popup restored on reconnect can legitimately
  // discard the card it was holding. That path has its own test below; this one is
  // about the hand surviving.
  await ada.stackDeck(gameId, [9, 11, 12, 10, 8, 6, 4]);
  const drawn = ada.waitForState(
    state => seat(state, 'Ada').regularCards.includes(9),
    { what: 'Ada to draw the 9' }
  );
  ada.emit('flip-card', gameId);
  const before = await drawn;
  const hand = seat(before, 'Ada');

  // The tab closes.
  await ada.close();
  await zed.waitForState(
    state => seat(state, 'Ada').connected === false,
    { what: 'the server to notice Ada left' }
  );

  // A new page, the same token.
  const adaAgain = await server.client('Ada-again');
  const rejoined = adaAgain.once('rejoined');
  adaAgain.emit('rejoin-game', gameId, tokens.Ada);
  const { game, token } = await rejoined;

  const back = seat(game, 'Ada');
  assert.strictEqual(back.connected, true);
  assert.deepStrictEqual(back.regularCards, hand.regularCards, 'the hand is still hers');
  assert.deepStrictEqual(back.specialCards, hand.specialCards);
  assert.strictEqual(back.totalScore, hand.totalScore);
  assert.strictEqual(typeof token, 'string', 'and she is handed a token to come back with');
  assert.strictEqual(game.players.length, 2, 'no ghost seat was left behind');
});

test('a token for a game you are not in is refused, not honoured', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId } = await startGame(server, ['Ada', 'Zed']);

  const stranger = await server.client('Stranger');

  const noGame = stranger.once('rejoin-failed');
  stranger.emit('rejoin-game', 'ZZZZZ', 'anything');
  assert.match(await noGame, /no longer exists/i);

  const noSeat = stranger.once('rejoin-failed');
  stranger.emit('rejoin-game', gameId, 'not-a-real-token');
  assert.match(await noSeat, /no longer in that game/i);
});

// Bots are created with token null. An empty token must never match one, or any client
// sending nothing would be handed a bot's seat and its turn.
test('an empty token never lands you in a bot seat', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await openLobby(server, ['Ada']);
  const withBot = ada.waitForState(state => state.players.length === 2, { what: 'a bot seat' });
  ada.emit('update-settings', gameId, { botCount: 1 });
  await withBot;

  const chancer = await server.client('Chancer');
  for (const token of [null, '', undefined]) {
    const refused = chancer.once('rejoin-failed');
    chancer.emit('rejoin-game', gameId, token);
    assert.match(await refused, /no longer in that game/i, `token ${String(token)}`);
  }
});

// A name and a code are all it takes: the same form covers joining and coming back, so
// somebody who lost their token can still reclaim their seat by typing their name.
test('a seat left mid-game is reclaimed by typing your name', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [zed] } = await startGame(server, ['Ada', 'Zed']);

  await zed.close();
  await ada.waitForState(
    state => seat(state, 'Zed').connected === false,
    { what: 'the server to notice Zed left' }
  );

  const zedAgain = await server.client('Zed-again');
  const rejoined = zedAgain.once('rejoined');
  // Sloppy capitalisation on purpose: somebody retyping from memory should not be
  // locked out of their own seat by it.
  zedAgain.emit('join-game', gameId, '  zED  ');
  const { game } = await rejoined;

  assert.strictEqual(seat(game, 'Zed').connected, true);
  assert.strictEqual(game.players.length, 2, 'the seat was taken back, not added to');
});

// Whoever held the old token may still have it open on another device.
test('reclaiming by name rotates the token, so the old one stops working', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [zed], tokens } = await startGame(
    server, ['Ada', 'Zed']
  );

  await zed.close();
  await ada.waitForState(state => seat(state, 'Zed').connected === false, { what: 'Zed gone' });

  const zedAgain = await server.client('Zed-again');
  const rejoined = zedAgain.once('rejoined');
  zedAgain.emit('join-game', gameId, 'Zed');
  const { token } = await rejoined;

  assert.notStrictEqual(token, tokens.Zed, 'a fresh token was issued');

  const oldDevice = await server.client('Zed-old-device');
  const refused = oldDevice.once('rejoin-failed');
  oldDevice.emit('rejoin-game', gameId, tokens.Zed);
  assert.match(await refused, /no longer in that game/i);
});

// hostToken names the original host by token, so rotating one has to carry the other or
// the host silently loses their powers for the rest of the game.
test('a host who comes back by name is still the host', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [zed] } = await startGame(server, ['Ada', 'Zed']);

  await ada.close();
  const away = await zed.waitForState(
    state => seat(state, 'Ada').connected === false,
    { what: 'Ada gone' }
  );
  assert.strictEqual(away.hostId, seat(away, 'Zed').id, 'Zed stands in meanwhile');

  const adaAgain = await server.client('Ada-again');
  const rejoined = adaAgain.once('rejoined');
  adaAgain.emit('join-game', gameId, 'Ada');
  const { game } = await rejoined;

  assert.strictEqual(game.hostId, seat(game, 'Ada').id, 'and gives it straight back');
});

test('the host powers pass to a person, never to a bot', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await openLobby(server, ['Ada']);

  const withBots = ada.waitForState(state => state.players.length === 3, { what: 'two bots' });
  ada.emit('update-settings', gameId, { botCount: 2 });
  await withBots;

  const quinn = await server.client('Quinn');
  const seated = ada.waitForState(
    state => state.players.some(p => p.name === 'Quinn'),
    { what: 'Quinn seated' }
  );
  const joined = quinn.once('game-joined');
  quinn.emit('join-game', gameId, 'Quinn');
  await joined;
  await seated;

  const started = ada.once('game-started');
  ada.emit('start-game', gameId);
  await started;

  await ada.close();
  const state = await quinn.waitForState(
    state => seat(state, 'Ada').connected === false,
    { what: 'Ada gone' }
  );

  const acting = state.players.find(p => p.id === state.hostId);
  assert.strictEqual(acting.name, 'Quinn');
  assert.ok(!acting.isBot, 'a bot never stands in as host');
});

// A blip is not an absence. Nothing should stop for a socket that is already coming
// back, or glancing at a message would halt the round for everybody.
test('a short blip does not pause the table', async t => {
  const server = await startServer({ env: { PAUSE_GRACE_MS: '30000' } });
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [zed], tokens } = await startGame(
    server, ['Ada', 'Zed']
  );

  await zed.close();
  await ada.waitForState(state => seat(state, 'Zed').connected === false, { what: 'Zed gone' });

  // Inside the grace period, Zed is not "away" and the round carries on: Ada can still
  // flip a card.
  const drawn = ada.waitForState(
    state => state.lastCardDrawn !== null,
    { what: 'Ada to keep playing' }
  );
  ada.emit('flip-card', gameId);
  const state = await drawn;

  assert.strictEqual(seat(state, 'Zed').away, false, 'a blip is not an absence');
});

test('once the grace period runs out, the table waits', async t => {
  const server = await startServer({ env: FAST_GRACE });
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [zed] } = await startGame(server, ['Ada', 'Zed']);

  await zed.close();

  const state = await ada.waitForState(
    state => seat(state, 'Zed').away === true,
    { what: 'Zed to count as away', timeout: 10000 }
  );

  const before = state.lastCardDrawn;
  ada.emit('flip-card', gameId);

  // Zed comes back, and that is the next thing that moves - not Ada's ignored flip.
  const zedAgain = await server.client('Zed-again');
  const rejoined = zedAgain.once('rejoined');
  zedAgain.emit('join-game', gameId, 'Zed');
  const { game } = await rejoined;

  assert.strictEqual(game.lastCardDrawn, before, 'the paused flip drew nothing');
  assert.strictEqual(seat(game, 'Zed').away, false, 'and the table is running again');
});

// The popup died with the old page, and the round cannot continue until it is answered.
test('a target popup is put back when its owner reconnects', async t => {
  const server = await startServer({ env: { PAUSE_GRACE_MS: '30000' } });
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [zed], tokens } = await startGame(
    server, ['Ada', 'Zed']
  );
  await ada.stackDeck(gameId, ['Freeze', 7, 5, 11, 12, 10, 9]);

  const popup = ada.once('select-freeze-target');
  ada.emit('flip-card', gameId);
  await popup;

  // Ada's page goes away while the popup is open.
  await ada.close();
  await zed.waitForState(state => seat(state, 'Ada').connected === false, { what: 'Ada gone' });

  const adaAgain = await server.client('Ada-again');
  const restored = adaAgain.once('select-freeze-target');
  adaAgain.emit('rejoin-game', gameId, tokens.Ada);
  const targets = await restored;

  assert.deepStrictEqual(
    targets[1].map(p => p.name).sort(), ['Ada', 'Zed'],
    'the same choice is offered again'
  );

  // And it still works: the round can carry on.
  const frozen = adaAgain.waitForState(
    state => seat(state, 'Zed').status === 'stood',
    { what: 'Zed to be frozen' }
  );
  const zedId = targets[1].find(p => p.name === 'Zed').id;
  adaAgain.emit('freeze-player', gameId, zedId);
  await frozen;
});

// In the lobby the seat is held too - on a shorter clock than a round, but held. Losing
// your place because you looked at a message while waiting for people is miserable.
test('a lobby seat is held, and your name gets it back', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await openLobby(server, ['Ada', 'Quinn']);

  await quinn.close();
  const state = await ada.waitForState(
    state => seat(state, 'Quinn').connected === false,
    { what: 'Quinn to drop' }
  );
  assert.strictEqual(state.players.length, 2, 'the seat is still there');

  const quinnAgain = await server.client('Quinn-again');
  const rejoined = quinnAgain.once('rejoined');
  quinnAgain.emit('join-game', gameId, 'Quinn');
  const { game } = await rejoined;

  assert.strictEqual(game.players.length, 2, 'and it is the same seat, not a new one');
  assert.strictEqual(seat(game, 'Quinn').connected, true);
});
