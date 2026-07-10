// sw.js — service worker: cache the app shell so the exporter installs as a PWA and works
// offline. Cache-first for the shell (all static, no API), network fallback for the rest.
// Bump CACHE on every release so a new deploy invalidates the old shell.
const CACHE = 'stems-v0.4.0';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/stem-lib.js',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request)
          .then((resp) => {
            if (resp.ok && resp.type === 'basic') {
              const copy = resp.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return resp;
          })
          .catch(() => caches.match('./index.html')),
    ),
  );
});
