// HALCYON — minimal service worker for the app shell.
// Pre-caches the static assets at install so the UI loads instantly on cold
// start, even when the LAN signaling server takes a moment to respond. The
// API and WebSocket path are excluded from the cache: they must always hit
// the live server.

const CACHE_NAME = 'halcyon-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/icons.js',
  '/sounds.js',
  '/recorder.js',
  '/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
});
