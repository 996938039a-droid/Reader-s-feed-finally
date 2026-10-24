// Makes the app open instantly and work offline. Article text and highlights are kept by the app
// itself (IndexedDB); this file only keeps the app's own files and article images.
const VERSION = 'rl-v1';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest', '/css/app.css',
  '/js/main.js', '/js/api.js', '/js/store.js', '/js/sync.js', '/js/util.js', '/js/ui.js', '/js/shell.js',
  '/js/library.js', '/js/reader.js', '/js/highlight.js', '/js/highlights-page.js', '/js/settings.js',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
];
const IMAGES = 'rl-images';
const MAX_IMAGES = 200;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== IMAGES) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_IMAGES))) await cache.delete(k);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The API and the setup tools always go to the network.
  if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/') || url.pathname === '/setup.html')) return;

  // Pages: network first so updates arrive, cached app shell if offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }

  // The app's own files: cached copy first, refreshed in the background.
  if (url.origin === location.origin) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      const fresh = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || fresh;
    }));
    return;
  }

  // Article images from other sites: keep so they show offline.
  if (req.destination === 'image') {
    e.respondWith(caches.open(IMAGES).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); trim(c); }
        return r;
      } catch { return hit || Response.error(); }
    }));
  }
});
