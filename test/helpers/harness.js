// A real server, a real socket, a stacked deck.
//
// The rules that live in lib/ can be tested by calling a function. The ones worth
// testing most cannot: a Draw Three that itself draws a targeting card, a Select as the
// last card in the pile, a turn timing out with a popup open. Those are sequences of
// socket events across several handlers, and the only honest way to test them is to
// play them against the real server.
//
// So this starts server.js as a child process on a free port, connects socket.io
// clients to it, and gives them a stacked deck through the HIT7_TEST_HOOKS events. The
// deck is the only thing faked; everything else is the server everybody plays on.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { io: connect } = require('socket.io-client');

const ROOT = path.join(__dirname, '..', '..');

// Nothing here should ever hang a test run. A missed event fails with the event it was
// waiting for rather than a timeout with no name on it.
//
// Generous on purpose. node --test runs the files concurrently, so eight servers can be
// starting at once on one machine and a round trip that normally takes milliseconds can
// take seconds under that load. A tight limit here does not catch anything a loose one
// misses - a genuinely missed event never arrives - it only turns a busy machine into a
// failing build.
const DEFAULT_WAIT_MS = 15000;

const startServer = async ({ env = {} } = {}) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Any free port. The server prints the one it actually bound.
      PORT: '0',
      HIT7_TEST_HOOKS: '1',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logs = [];
  child.stderr.on('data', chunk => logs.push(String(chunk)));

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not start in ${DEFAULT_WAIT_MS}ms:\n${logs.join('')}`)),
      DEFAULT_WAIT_MS
    );

    let buffered = '';
    child.stdout.on('data', chunk => {
      buffered += String(chunk);
      logs.push(String(chunk));
      const match = buffered.match(/Server running on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });

    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${logs.join('')}`));
    });
  });

  const sockets = [];

  const client = async name => {
    const socket = connect(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true
    });
    sockets.push(socket);
    await once(socket, 'connect');
    return wrap(socket, name);
  };

  const stop = async () => {
    sockets.forEach(socket => socket.close());
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
  };

  return { port, client, stop, logs };
};

// Waits for one event, and gives up loudly rather than silently.
const once = (socket, event, { timeout = DEFAULT_WAIT_MS, where = '' } = {}) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"${where ? ` (${where})` : ''}`));
    }, timeout);

    const handler = (...args) => {
      clearTimeout(timer);
      resolve(args.length > 1 ? args : args[0]);
    };
    socket.once(event, handler);
  });

// Waits for the first game-update whose state satisfies `predicate`. Most assertions
// here are "once the dust has settled, the table looks like this", and the dust settles
// over several broadcasts.
const waitForState = (socket, predicate, { timeout = DEFAULT_WAIT_MS, what = 'state' } = {}) =>
  new Promise((resolve, reject) => {
    let last = null;
    const timer = setTimeout(() => {
      socket.off('game-update', handler);
      reject(new Error(`timed out waiting for ${what}. Last seen:\n${JSON.stringify(last, null, 2)}`));
    }, timeout);

    const handler = state => {
      last = state;
      let matched = false;
      try {
        matched = predicate(state);
      } catch {
        matched = false;
      }
      if (!matched) return;
      clearTimeout(timer);
      socket.off('game-update', handler);
      resolve(state);
    };

    socket.on('game-update', handler);
  });

const wrap = (socket, name) => ({
  socket,
  name,
  get id() { return socket.id; },
  emit: (...args) => socket.emit(...args),
  once: (event, options) => once(socket, event, { where: name, ...options }),
  on: (event, handler) => socket.on(event, handler),
  waitForState: (predicate, options) => waitForState(socket, predicate, options),

  // Drops the connection the way closing a tab does, and waits until it is really gone
  // rather than racing the server's disconnect handler.
  close: async () => {
    if (!socket.connected) return;
    const gone = new Promise(resolve => socket.once('disconnect', resolve));
    socket.close();
    await gone;
  },

  // The deck is drawn from the top, so `cards` is simply the order they come out in.
  stackDeck: async (gameId, cards, discardPile) => {
    const ready = once(socket, '__test-ready', { where: `${name} stackDeck` });
    socket.emit('__test-stack-deck', gameId, cards, discardPile);
    return ready;
  },

  setHand: async (gameId, playerId, hand) => {
    const ready = once(socket, '__test-ready', { where: `${name} setHand` });
    socket.emit('__test-set-hand', gameId, playerId, hand);
    return ready;
  }
});

// The whole opening ceremony: a host, some guests, and a game under way. Returns the
// clients in seat order, which is also turn order for round 1.
const startGame = async (server, names, settings) => {
  const [hostName, ...guestNames] = names;

  const host = await server.client(hostName);
  const createdWait = host.once('game-created');
  host.emit('create-game', hostName);
  const created = await createdWait;
  const gameId = created.gameId;

  // A token is a seat's proof of identity, and the only way back into it after a
  // refresh, so the reconnect tests need them kept.
  const tokens = { [hostName]: created.token };

  const guests = [];
  for (const guestName of guestNames) {
    const guest = await server.client(guestName);
    const joined = guest.once('game-joined');
    guest.emit('join-game', gameId, guestName);
    tokens[guestName] = (await joined).token;
    guests.push(guest);
  }

  if (settings) {
    const updated = host.waitForState(
      state => Object.entries(settings).every(([key, value]) => state.settings[key] === value),
      { what: `settings ${JSON.stringify(settings)}` }
    );
    host.emit('update-settings', gameId, settings);
    await updated;
  }

  const started = host.once('game-started');
  host.emit('start-game', gameId);
  const state = await started;

  return { gameId, host, guests, players: [host, ...guests], state, tokens };
};

// A lobby, without starting the game. The lobby tests need the table but not the deal.
const openLobby = async (server, names) => {
  const [hostName, ...guestNames] = names;

  const host = await server.client(hostName);
  const createdWait = host.once('game-created');
  host.emit('create-game', hostName);
  const created = await createdWait;
  const gameId = created.gameId;

  const tokens = { [hostName]: created.token };
  const guests = [];

  for (const guestName of guestNames) {
    const guest = await server.client(guestName);
    const joined = guest.once('game-joined');
    guest.emit('join-game', gameId, guestName);
    tokens[guestName] = (await joined).token;
    guests.push(guest);
  }

  return { gameId, host, guests, players: [host, ...guests], tokens };
};

module.exports = { startServer, startGame, openLobby, once, waitForState };
