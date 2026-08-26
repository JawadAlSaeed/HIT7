// Service worker.
//
// This is here to make HIT7 installable and to make it open instantly. It is NOT here
// to make it playable offline: this is a real-time multiplayer game, and without the
// server there is no game. Nothing below tries to fake a working board.
//
// Two rules keep it out of the way of the game itself.
//
//   1. /socket.io/ is never touched. That is the live connection, and a cache sitting
//      in front of it would be a cache sitting in front of every move anybody makes.
//
//   2. Anything that decides how the game behaves - the page, the script, the
//      stylesheet - is fetched from the network first and only falls back to the cache
//      when the network is genuinely not there. A deploy always wins, so nobody ends up
//      stuck on an old client playing to different rules from everyone else at the
//      table. Pictures and sounds, which do not change the rules, go the other way
//      round because they are the slow part of a first load.

const VERSION = 'v2';
const SHELL_CACHE = `hit7-shell-${VERSION}`;
const ASSET_CACHE = `hit7-assets-${VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];

// Deliberately small and certain: install fails outright if a single one of these is
// missing, so the long tail of images and audio is left to fill itself in as the game
// asks for it.
//
// socket.io.js is on this list and it is the reason the list is worth reading twice.
// The server serves that file, so without it cached the page comes back from the cache
// with no `io` to call - client.js dies on its first line and the lobby renders as a
// set of buttons that do nothing at all. The library is a static file and safe to keep;
// what must never be kept is the connection underneath it, which is every other path
// beginning /socket.io/.
const SOCKET_IO_CLIENT = '/socket.io/socket.io.js';
const SHELL = ['/', '/index.html', '/client.js', '/style.css', SOCKET_IO_CLIENT];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(name => !CURRENT_CACHES.includes(name)).map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// The server answers anything it does not recognise with index.html, so a request for a
// file that is not there comes back as a perfectly good 200 full of HTML. Storing that
// under an asset's name would poison it for as long as the cache lives.
const isStorable = response =>
  response &&
  response.ok &&
  response.type === 'basic' &&
  !(response.headers.get('content-type') || '').includes('text/html');

const networkFirst = async (request, { shellFallback = false } = {}) => {
  const cache = await caches.open(SHELL_CACHE);

  try {
    const response = await fetch(request);
    // HTML is expected here, so isStorable is the wrong test for this half.
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Only a page navigation can sensibly be answered with the page. Handing index.html
    // back for a missing script is how you get a blank screen and no clue why.
    if (shellFallback) {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    throw error;
  }
};

const cacheFirst = async request => {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (isStorable(response)) cache.put(request, response.clone());
  return response;
};

// Everything that decides how a turn plays out.
const isShell = (request, url) =>
  request.mode === 'navigate' ||
  url.pathname.endsWith('.js') ||
  url.pathname.endsWith('.css') ||
  url.pathname.endsWith('.webmanifest');

self.addEventListener('fetch', event => {
  const { request } = event;

  // A POST is somebody doing something, not somebody reading something.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Google Fonts and anything else off-origin: left alone. An opaque response tells us
  // nothing about whether it worked, so caching it is guesswork.
  if (url.origin !== self.location.origin) return;

  // The live connection. Never. The client library sitting at one path underneath it is
  // the single exception, and it is handled as an ordinary script below.
  if (url.pathname.startsWith('/socket.io/') && url.pathname !== SOCKET_IO_CLIENT) return;

  // Registering this file through itself is a good way to get stuck on an old one.
  if (url.pathname === '/sw.js') return;

  event.respondWith(
    isShell(request, url)
      ? networkFirst(request, { shellFallback: request.mode === 'navigate' })
      : cacheFirst(request)
  );
});
