// Bots playing, against a real server.
//
// A bot has no connection, but every rule in registerHandlers is written against a
// socket - so a bot seat gets a puppet one, and a scheduler fires its moves into the
// same handlers a person's clicks go to. That is the part worth testing: not whether
// the bot plays *well* (lib/bot.js is unit-tested for that), but that the loop moves
// the table on, and that it never moves it when it should not.

const test = require('node:test');
const assert = require('node:assert');

const { startServer, openLobby } = require('./helpers/harness');

const seat = (state, name) => state.players.find(p => p.name === name);
const botIn = state => state.players.find(p => p.isBot);

// A bot move takes 600-3200ms of deliberate thinking time, so anything waiting on one
// has to allow for a few of them.
const BOT_WAIT = 15000;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A lobby with bots, started. Returns the dealt state so seat order is known.
const gameWithBots = async (server, botCount, settings) => {
  const { gameId, host } = await openLobby(server, ['Ada']);

  const seated = host.waitForState(
    state => state.players.filter(p => p.isBot).length === botCount,
    { what: `${botCount} bot seats` }
  );
  host.emit('update-settings', gameId, { botCount, ...settings });
  await seated;

  const started = host.once('game-started');
  host.emit('start-game', gameId);
  const state = await started;

  return { gameId, host, state };
};

test('a bot plays its own turn, with nobody telling it to', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, state } = await gameWithBots(server, 1);
  const bot = botIn(state);

  // Six unique numbers already down, and the seventh waiting on top. Whatever the bot
  // decides - draw it or stand on what it has - its round ends in one move, so this
  // does not sit through a whole hand of thinking time.
  await ada.setHand(gameId, bot.id, { regularCards: [1, 2, 3, 4, 5, 6] });
  await ada.stackDeck(gameId, [7, 11, 12, 10, 9, 8]);

  // Ada stands, handing the turn over.
  const handedOver = ada.waitForState(
    state => state.players[state.currentPlayer].isBot,
    { what: 'the turn to reach the bot' }
  );
  ada.emit('stand', gameId);
  await handedOver;

  const played = await ada.waitForState(
    state => botIn(state).status !== 'active',
    { what: 'the bot to finish its turn', timeout: BOT_WAIT }
  );

  const it = botIn(played);
  assert.ok(['stood', 'busted'].includes(it.status), `bot ended on ${it.status}`);
  assert.ok(it.roundScore > 0 || it.status === 'busted', 'and it has a score to show');
});

// The scheduler only ever acts for the seat whose turn it is. A bot that moved on
// somebody else's turn would be drawing cards out of another player's hand.
test('a bot does nothing while it is somebody else turn', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const { gameId, host: ada, state } = await gameWithBots(server, 1);
  const bot = botIn(state);

  assert.strictEqual(state.players[state.currentPlayer].name, 'Ada', 'Ada is up first');

  const moves = [];
  ada.on('game-update', s => moves.push(botIn(s)));

  // Comfortably longer than a bot's slowest deliberation.
  await pause(4000);

  assert.ok(
    moves.every(b => b.regularCards.length === 0 && b.specialCards.length === 0),
    'the bot never touched a card while it was not its turn'
  );
  assert.ok(moves.every(b => b.status === 'active'), 'and never stood or busted');
});

// isPaused covers bots as well as people: a table stopped for somebody who has gone
// must not carry on playing itself around them.
test('a bot does not play while the table is waiting for somebody', async t => {
  const server = await startServer({ env: { PAUSE_GRACE_MS: '400' } });
  t.after(() => server.stop());

  const { gameId, host: ada } = await openLobby(server, ['Ada']);

  const seated = ada.waitForState(
    state => state.players.filter(p => p.isBot).length === 1,
    { what: 'a bot seat' }
  );
  ada.emit('update-settings', gameId, { botCount: 1 });
  await seated;

  // A second person, so that somebody is left to watch when Ada goes.
  const quinn = await server.client('Quinn');
  const joined = quinn.once('game-joined');
  quinn.emit('join-game', gameId, 'Quinn');
  await joined;

  const started = quinn.once('game-started');
  ada.emit('start-game', gameId);
  await started;

  // Hand the turn on, then have Ada disappear. Deliberately no assumption about
  // whether the bot got a move in before the pause landed - it has up to 3.2 seconds
  // of thinking time and the grace period is shorter than that, so it sometimes does.
  ada.emit('stand', gameId);
  await ada.close();

  // The snapshot is taken at the moment the table actually stops, so whatever happened
  // before that is baked in and only what happens *during* the pause is measured.
  const paused = await quinn.waitForState(
    state => seat(state, 'Ada').away === true,
    { what: 'Ada to count as away', timeout: 10000 }
  );
  const before = botIn(paused);

  const moves = [];
  quinn.on('game-update', s => moves.push(botIn(s)));
  await pause(4000);

  assert.ok(
    moves.every(b =>
      b.status === before.status &&
      b.regularCards.length === before.regularCards.length &&
      b.specialCards.length === before.specialCards.length),
    'the bot waited with everybody else rather than playing on around them'
  );

  // And the table really does start again when Ada comes back.
  const adaAgain = await server.client('Ada-again');
  const rejoined = adaAgain.once('rejoined');
  adaAgain.emit('join-game', gameId, 'Ada');
  const { game } = await rejoined;

  assert.ok(game.players.every(p => p.away === false), 'nobody is missing any more');
});

// The seat does not move, so the turn does not either - and the bot has to pick up a
// turn that was half-taken.
test('a seat handed to a bot mid-turn carries on playing it', async t => {
  const server = await startServer({ env: { PAUSE_GRACE_MS: '400' } });
  t.after(() => server.stop());

  const { gameId, host: ada } = await openLobby(server, ['Ada']);

  const quinn = await server.client('Quinn');
  const joined = quinn.once('game-joined');
  quinn.emit('join-game', gameId, 'Quinn');
  await joined;

  const started = ada.once('game-started');
  ada.emit('start-game', gameId);
  const dealt = await started;

  const quinnIndex = dealt.players.findIndex(p => p.name === 'Quinn');
  const quinnId = quinn.id;

  // Quinn's hand is one card off a full seven, so the seat resolves in one move
  // whichever way the bot decides.
  await ada.setHand(gameId, quinnId, { regularCards: [1, 2, 3, 4, 5, 6] });
  await ada.stackDeck(gameId, [7, 11, 12, 10, 9, 8]);

  // Hand the turn to Quinn, then Quinn vanishes holding it.
  const quinnsTurn = ada.waitForState(
    state => state.players[state.currentPlayer].name === 'Quinn',
    { what: "Quinn's turn" }
  );
  ada.emit('stand', gameId);
  await quinnsTurn;

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
  const swapped = await handedOver;

  assert.strictEqual(
    swapped.currentPlayer, quinnIndex,
    'the turn stayed on the seat, because the seat stayed where it was'
  );

  // Nobody is missing any more, so the round picks up and the bot finishes the turn.
  const finished = await ada.waitForState(
    state => state.players[quinnIndex].status !== 'active',
    { what: 'the bot to finish the turn it inherited', timeout: BOT_WAIT }
  );
  assert.ok(['stood', 'busted'].includes(finished.players[quinnIndex].status));
});

// The end of the loop: no human input at all after the first stand, and the round has
// to reach its own end rather than sitting on a bot that never moves.
test('a table of bots finishes a round on its own', async t => {
  const server = await startServer({ env: { ROUND_SUMMARY_MS: '500' } });
  t.after(() => server.stop());

  const { gameId, host: ada, state } = await gameWithBots(server, 2, { winningScore: 100 });
  const bots = state.players.filter(p => p.isBot);
  assert.strictEqual(bots.length, 2);

  // Both bots one card from a full hand, so the round is short however they play it.
  for (const bot of bots) {
    await ada.setHand(gameId, bot.id, { regularCards: [1, 2, 3, 4, 5, 6] });
  }
  await ada.stackDeck(gameId, [7, 8, 11, 12, 10, 9, 4, 2, 1]);

  const nextRound = ada.once('new-round', { timeout: 30000 });
  ada.emit('stand', gameId);

  const fresh = await nextRound;
  assert.strictEqual(fresh.roundNumber, 2, 'the round ended and the next was dealt');
  assert.ok(
    fresh.players.some(p => p.isBot && p.totalScore > 0),
    'and at least one bot banked something, so they really did play'
  );
});
