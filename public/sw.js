/*
 * Navilite service worker: app-shell caching only, and deliberately narrow.
 *
 * What it will NOT cache, and why:
 *   - anything under /rest/ (or carrying a Range header). /rest/stream is served in byte
 *     ranges and caching a music body is the shortest path to a broken player. Offline
 *     caching of the library is explicitly out of v1 (DECISIONS.md).
 *   - any same-origin JSON or API-shaped response. An earlier version of this file cached
 *     every same-origin GET, which silently served stale data for non-`/rest` API paths.
 *   Only app-shell assets are cached: scripts, styles, images, fonts and the manifest,
 *   which are content-hashed by the build or versioned by SHELL_CACHE.
 *
 * __BUILD_ID__ is replaced at build time (see vite.config.ts).
 */
const BUILD_ID = '__BUILD_ID__';
const SHELL_CACHE = 'navilite-shell-' + BUILD_ID;
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './favicon.svg',
];

const CACHEABLE_DESTINATIONS = new Set(['script', 'style', 'image', 'font', 'manifest']);
const SHELL_PATHS = new Set(['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/favicon.svg']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/rest/') || url.pathname.startsWith('/rest/')) return;
  if (request.headers.has('range')) return;
  // Audio and video are always streamed, never stored.
  if (request.destination === 'audio' || request.destination === 'video') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html').then((hit) => hit ?? Response.error())));
    return;
  }

  const isShellAsset = SHELL_PATHS.has(url.pathname) || CACHEABLE_DESTINATIONS.has(request.destination);
  if (!isShellAsset) return; // let the network answer, untouched

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
