// Service worker: makes the app open without signal, and shows push notifications.
// - App files and the park map are pre-cached per VERSION (bump it on every deploy that changes public/ files,
//   so all files switch together); pages are network-first, other files come from the cache and refresh behind.
// - /api/* is never cached here: app.js keeps its own last copies (localStorage, IndexedDB for tickets).
// - Cloudflare Access: a redirect to the login page is passed through untouched and never cached.
const VERSION = 'pretpark-v2';
const SHELL = [
  '/', '/style.css', '/app.js', '/logic.js', '/data.js', '/route.js', '/family.js', '/idb.js', '/tickets.js',
  '/park.json', '/icon.svg', '/apple-touch-icon.png', '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // one by one: a single failure (e.g. logged out) must not break the install
    await Promise.all(SHELL.map(async (u) => {
      try { const r = await fetch(u, { redirect: 'manual', cache: 'no-cache' }); if (r.ok && r.type === 'basic') await c.put(u, r); } catch { /* next time */ }
    }));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== VERSION && k !== 'pretpark-fonts') await caches.delete(k);
  await self.clients.claim();
})()));

const okToCache = (r) => r && r.ok && r.type === 'basic' && !r.redirected;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open('pretpark-fonts').then(async (c) => {
      const hit = await c.match(req); if (hit) return hit;
      const r = await fetch(req); if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r;
    }).catch(() => Response.error()));
    return;
  }
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (okToCache(r)) (await caches.open(VERSION)).put('/', r.clone());
        return r;
      } catch {
        return (await caches.match('/', { ignoreSearch: true })) || Response.error();
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((r) => { if (okToCache(r)) c.put(req, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || Response.error();
  })());
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Pretpark', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Pretpark', {
    body: d.body || '', tag: d.tag || 'pretpark', renotify: true, icon: '/apple-touch-icon.png', badge: '/apple-touch-icon.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.focus(); if ('navigate' in c && url !== c.url) c.navigate(url).catch(() => {}); return; } }
    return self.clients.openWindow(url);
  })());
});
