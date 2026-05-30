// HALCYON — minimal service worker for the app shell.
//
// Strategy: network-first with cache fallback. For an actively developed app
// served on the LAN, cache-first surprises users by holding stale code across
// reloads even after the new version is on disk. Network-first means every
// reload sees the latest server response when the server is reachable, and
// the cache only kicks in for true offline scenarios.
//
// /api and /ws bypass the worker entirely so the live signaling path stays
// untouched.

const CACHE_NAME = 'halcyon-v2';
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
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Refresh the cache opportunistically with each successful fetch.
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
