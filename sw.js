/* Service worker: makes the game installable and playable offline.
   NETWORK FIRST, cache as the fallback. A cache-first worker would keep
   serving yesterday's game.js after every deploy, which is exactly the kind
   of "I fixed it but nothing changed" confusion this project does not need.
   Bump CACHE when the precache list changes. */
const CACHE = 'fc27-v1';
const PRECACHE = [
  './',
  './index.html',
  './css/styles.css',
  './js/game.js',
  './manifest.webmanifest',
  './icon.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(PRECACHE.map(u => c.add(u))))   // a failed CDN fetch must not block install
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      // keep a fresh copy of anything we successfully fetched
      if(res && (res.ok || res.type === 'opaque')){
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
