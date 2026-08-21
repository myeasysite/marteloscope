/* Marteloscope service worker — offline app shell + map tile cache */
const APP_CACHE = 'mtls-app-v3';
const TILE_CACHE = 'mtls-tiles-v1';

const APP_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './vendor/leaflet.css',
  './vendor/leaflet.js',
  './vendor/tailwind.js',
  './vendor/lucide.js',
  './icons/icon.svg'
];

const TILE_HOSTS = ['tile.openstreetmap.org', 'arcgisonline.com'];
const isTile = url => TILE_HOSTS.some(h => url.hostname.endsWith(h));

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE)
      // individual adds so one 404 cannot abort the whole install
      .then(cache => Promise.all(APP_ASSETS.map(a => cache.add(a).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== APP_CACHE && k !== TILE_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Map tiles: cache first, then network (so a saved area works with no signal)
  if (isTile(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(cache =>
        cache.match(req).then(hit => hit || fetch(req).then(res => {
          if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
          return res;
        }).catch(() => hit || Response.error()))
      )
    );
    return;
  }

  // App shell: cache first with background refresh
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && res.ok) caches.open(APP_CACHE).then(c => c.put(req, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});

// Page asks to pre-cache a list of tile URLs for offline field work
self.addEventListener('message', event => {
  const data = event.data || {};

  if (data.type === 'CACHE_TILES' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(TILE_CACHE);
      let done = 0, failed = 0;
      const queue = data.urls.slice();
      const worker = async () => {
        while (queue.length) {
          const u = queue.shift();
          try {
            const hit = await cache.match(u);
            if (hit) { done++; continue; }
            let res = await fetch(u, { mode: 'cors' }).catch(() => null);
            if (!res || !res.ok) res = await fetch(u, { mode: 'no-cors' }).catch(() => null);
            if (res && (res.ok || res.type === 'opaque')) { await cache.put(u, res.clone()); done++; }
            else failed++;
          } catch (e) { failed++; }
          if ((done + failed) % 20 === 0) post({ type: 'TILE_PROGRESS', done, failed, total: data.urls.length });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      post({ type: 'TILE_DONE', done, failed, total: data.urls.length });
    })());
  }

  if (data.type === 'CLEAR_TILES') {
    event.waitUntil(caches.delete(TILE_CACHE).then(() => post({ type: 'TILES_CLEARED' })));
  }

  if (data.type === 'TILE_STATS') {
    event.waitUntil(
      caches.open(TILE_CACHE)
        .then(c => c.keys())
        .then(keys => post({ type: 'TILE_STATS', count: keys.length }))
    );
  }
});

function post(msg) {
  self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage(msg)));
}
