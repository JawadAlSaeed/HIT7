// What only the host can do: end the game, take everyone back to the lobby, start a
// rematch, and deal with somebody who has dropped.
//
// All five of these rewrite the table for everybody at it, so the guard on each one is
// the whole story: without it, any client that knows the game code can end a round
// other people are in the middle of.

const test = require('node:test');
const assert = require('node:assert');

const { startServer, startGame, openLobby } = require('./helpers/harness');

const FILLER = [11, 12, 10, 9, 8, 6, 4, 2, 1];
const seat = (state, name) => state.players.find(p => p.name === name);

// Long enough for anything an ignored event was going to cause to have happened.
const settle = () => new Promise(resolve => setTimeout(resolve, 500));

// ---------------------------------------------------------------- ending early

test('the host can end the game where it stands, and whoever is ahead wins', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await startGame(server, ['Ada', 'Quinn']);

  await ada.setHand(gameId, ada.id, { totalScore: 40 });
  await ada.setHand(gameId, quinn.id, { totalScore: 90 });

  const over = quinn.once('game-over');
  ada.emit('end-game', gameId);
  const { winner, players } = await over;

  assert.strictEqual(winner.name, 'Quinn', 'the player who was ahead took it');
  assert.ok(!('token' in winner), 'and no seat token went out with the result');
  assert.strictEqual(
    players.find(p => p.name === 'Quinn').status, 'winner',
    'the end screen marks them as the winner'
  );
});

test('a player who is not the host cannot end the game', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await startGame(server, ['Ada', 'Quinn']);

  quinn.emit('end-game', gameId);

  // Ada plays on, which she could not do if Quinn had ended it.
  await ada.stackDeck(gameId, [3, ...FILLER]);
  const drawn = ada.waitForState(
    state => seat(state, 'Ada').regularCards.includes(3),
    { what: 'Ada to keep playing' }
  );
  ada.emit('flip-card', gameId);
  const state = await drawn;

  assert.strictEqual(state.status, 'playing', 'the game is still running');
});

// ---------------------------------------------------------------- back to the lobby

test('return-to-lobby clears the game but keeps everybody in their seat', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await startGame(server, ['Ada', 'Quinn']);

  await ada.setHand(gameId, ada.id, {
    regularCards: [3, 9], specialCards: ['2x'], totalScore: 120
  });

  const back = quinn.once('returned-to-lobby');
  ada.emit('return-to-lobby', gameId);
  const state = await back;

  assert.strictEqual(state.status, 'lobby');
  assert.strictEqual(state.roundNumber, 1, 'the round counter went back to one');
  assert.strictEqual(state.players.length, 2, 'nobody had to rejoin');

  const her = seat(state, 'Ada');
  assert.deepStrictEqual(her.regularCards, [], 'hands are cleared');
  assert.strictEqual(her.totalScore, 0, 'and so are the scores');
  // 'waiting' rather than 'active': only startNewRound makes players active, and a
  // lobby of active players would draw a board with no cards on it.
  assert.strictEqual(her.status, 'waiting');
});

// This is the whole reason return-to-lobby replaced the old Reset button: nothing could
// change these mid-game before without everybody rejoining.
test('the deck and target score can be changed after returning to the lobby', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await startGame(server, ['Ada', 'Quinn']);

  const back = ada.once('returned-to-lobby');
  ada.emit('return-to-lobby', gameId);
  await back;

  const changed = ada.waitForState(
    state => state.settings.deckMode === 'normal' && state.settings.winningScore === 100,
    { what: 'the new settings' }
  );
  ada.emit('update-settings', gameId, { deckMode: 'normal', winningScore: 100 });
  const state = await changed;

  assert.strictEqual(state.deck.length, 94, 'and the pile really is the normal deck');
});

test('a player who is not the host cannot send everybody back to the lobby', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await startGame(server, ['Ada', 'Quinn']);

  quinn.emit('return-to-lobby', gameId);

  await ada.stackDeck(gameId, [3, ...FILLER]);
  const drawn = ada.waitForState(
    state => seat(state, 'Ada').regularCards.includes(3),
    { what: 'Ada to keep playing' }
  );
  ada.emit('flip-card', gameId);
  assert.strictEqual((await drawn).status, 'playing');
});

// ---------------------------------------------------------------- rematch

test('the host starts a rematch from the end screen', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await startGame(server, ['Ada', 'Quinn']);

  await ada.setHand(gameId, ada.id, { totalScore: 150 });
  const over = ada.once('game-over');
  ada.emit('end-game', gameId);
  await over;

  const again = quinn.once('rematch-started');
  ada.emit('request-rematch', gameId);
  const state = await again;

  assert.strictEqual(state.status, 'playing');
  assert.strictEqual(state.roundNumber, 1);
  assert.ok(state.players.every(p => p.totalScore === 0), 'scores start again');
  assert.ok(state.players.every(p => p.status === 'active'));
  assert.ok(state.players.every(p => p.stats.cardsDrawn === 0), 'and so do the stats');
});

// This was a real hole: request-rematch was the one host action with no guard at all,
// so anybody who knew the game code could wipe the table's scores in mid-round.
test('a rematch cannot be started in the middle of a game', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await startGame(server, ['Ada', 'Quinn']);
  await ada.setHand(gameId, ada.id, { totalScore: 120 });

  // Even the host cannot: there is no end screen to press it from.
  ada.emit('request-rematch', gameId);

  await ada.stackDeck(gameId, [3, ...FILLER]);
  const drawn = ada.waitForState(
    state => seat(state, 'Ada').regularCards.includes(3),
    { what: 'Ada to keep playing' }
  );
  ada.emit('flip-card', gameId);
  const state = await drawn;

  assert.strictEqual(state.roundNumber, 1);
  assert.strictEqual(seat(state, 'Ada').totalScore, 120, 'the banked score survived');
});

test('a player who is not the host cannot start a rematch', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await startGame(server, ['Ada', 'Quinn']);

  await ada.setHand(gameId, quinn.id, { totalScore: 150 });
  const over = ada.once('game-over');
  ada.emit('end-game', gameId);
  await over;

  // Counted rather than awaited, so a rematch that should not have happened cannot
  // hide behind the host's one afterwards.
  let rematches = 0;
  ada.on('rematch-started', () => { rematches += 1; });

  quinn.emit('request-rematch', gameId);
  await settle();
  assert.strictEqual(rematches, 0, "Quinn's attempt did nothing");

  // And the host's still works, so the guard is not simply refusing everybody.
  ada.emit('request-rematch', gameId);
  await settle();
  assert.strictEqual(rematches, 1, "the host's did");
});

// ---------------------------------------------------------------- somebody dropped

test('the host removes a player who has gone, and the round restarts', async t => {
  const server = await startServer({ env: { PAUSE_GRACE_MS: '400' } });
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn, milo] } = await startGame(
    server, ['Ada', 'Quinn', 'Milo-the-human']
  );

  await ada.setHand(gameId, ada.id, { regularCards: [3, 9], totalScore: 40 });

  const quinnId = quinn.id;
  await quinn.close();
  await ada.waitForState(
    state => seat(state, 'Quinn').away === true,
    { what: 'Quinn to count as away', timeout: 10000 }
  );

  // A seat keeps its id after a disconnect, so the socket id Quinn had is still the
  // right one to name.
  const restarted = ada.once('round-restarted', { timeout: 10000 });
  ada.emit('kick-player', gameId, quinnId);
  const state = await restarted;

  assert.strictEqual(state.players.length, 2, 'the seat is gone');
  assert.ok(!state.players.some(p => p.name === 'Quinn'));
  assert.strictEqual(state.status, 'playing', 'and the round starts over');
  assert.deepStrictEqual(seat(state, 'Ada').regularCards, [], 'hands are dealt again');
  assert.strictEqual(seat(state, 'Ada').totalScore, 40, 'but banked scores survive');
});

// Not a way to remove somebody who is sitting there playing.
test('a player who is still connected cannot be removed', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await startGame(server, ['Ada', 'Quinn']);

  const refused = ada.once('error');
  ada.emit('kick-player', gameId, quinn.id);
  assert.match(await refused, /only remove a disconnected player/i);
});

test('a bot is set in the lobby, not kicked', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada } = await openLobby(server, ['Ada']);
  const withBot = ada.waitForState(state => state.players.length === 2, { what: 'a bot' });
  ada.emit('update-settings', gameId, { botCount: 1 });
  const lobby = await withBot;

  const refused = ada.once('error');
  ada.emit('kick-player', gameId, lobby.players.find(p => p.isBot).id);
  assert.match(await refused, /set in the lobby/i);
});

test('a player who is not the host cannot remove anybody', async t => {
  const server = await startServer({ env: { PAUSE_GRACE_MS: '400' } });
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn, milo] } = await startGame(
    server, ['Ada', 'Quinn', 'Milo-the-human']
  );

  const quinnId = quinn.id;
  await quinn.close();
  await milo.waitForState(
    state => seat(state, 'Quinn').away === true,
    { what: 'Quinn away', timeout: 10000 }
  );

  milo.emit('kick-player', gameId, quinnId);

  // Ada removes them instead, which is what actually works.
  const restarted = ada.once('round-restarted', { timeout: 10000 });
  ada.emit('kick-player', gameId, quinnId);
  const state = await restarted;

  assert.strictEqual(state.players.length, 2, 'removed once, by the host');
});

// ---------------------------------------------------------------- handing over a seat

// The seat does not move, because currentPlayer is an index: everything belonging to
// the round stays with it, and only the identity changes.
test('a dropped seat handed to a bot keeps its hand, score and place', async t => {
  const server = await startServer({ env: { PAUSE_GRACE_MS: '400' } });
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn], state: dealt } = await startGame(
    server, ['Ada', 'Quinn']
  );

  await ada.setHand(gameId, quinn.id, {
    regularCards: [3, 9], specialCards: ['2x'], totalScore: 55
  });

  // Seat order is fixed once the game starts, and the seat is what this test is about:
  // botifySeat must swap the identity without moving the chair.
  const quinnIndex = dealt.players.findIndex(p => p.name === 'Quinn');
  const quinnId = quinn.id;

  await quinn.close();
  await ada.waitForState(
    state => seat(state, 'Quinn').away === true,
    { what: 'Quinn away', timeout: 10000 }
  );

  const handedOver = ada.waitForState(
    state => state.players[quinnIndex].isBot,
    { what: 'the seat to become a bot', timeout: 10000 }
  );
  ada.emit('replace-with-bot', gameId, quinnId);
  const state = await handedOver;

  const taken = state.players[quinnIndex];
  assert.strictEqual(taken.isBot, true);
  assert.deepStrictEqual(taken.regularCards, [3, 9], 'the hand stayed on the table');
  assert.deepStrictEqual(taken.specialCards, ['2x']);
  assert.strictEqual(taken.totalScore, 55, 'and so did the banked score');
  assert.strictEqual(state.players.length, 2, 'the seat did not move or multiply');
  assert.strictEqual(taken.token, undefined, 'and it carries no token');
});

// Nulling the token is what stops the person who dropped reclaiming a seat that is now
// being played for them.
test('the person who dropped cannot take back a seat a bot is playing', async t => {
  const server = await startServer({ env: { PAUSE_GRACE_MS: '400' } });
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn], tokens } = await startGame(
    server, ['Ada', 'Quinn']
  );

  const quinnId = quinn.id;
  await quinn.close();
  await ada.waitForState(
    state => seat(state, 'Quinn').away === true,
    { what: 'Quinn away', timeout: 10000 }
  );

  const handedOver = ada.waitForState(
    state => state.players.some(p => p.isBot),
    { what: 'the seat to become a bot', timeout: 10000 }
  );
  ada.emit('replace-with-bot', gameId, quinnId);
  await handedOver;

  const quinnAgain = await server.client('Quinn-again');
  const refused = quinnAgain.once('rejoin-failed');
  quinnAgain.emit('rejoin-game', gameId, tokens.Quinn);
  assert.match(await refused, /no longer in that game/i);
});

test('a connected player cannot be handed to a bot', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, guests: [quinn] } = await startGame(server, ['Ada', 'Quinn']);

  const refused = ada.once('error');
  ada.emit('replace-with-bot', gameId, quinn.id);
  assert.match(await refused, /only hand over a disconnected player/i);
});
