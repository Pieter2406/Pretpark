// Service worker: the app opens instantly and without signal, and shows push notifications.
// - All app files are pre-cached together per VERSION (scripts/stamp-sw.mjs sets it from a hash of public/ on
//   every `npm run deploy`), and served only from that set, so a page never mixes old and new files.
// - Pages come from the cache too (instant start on weak park data); ?fresh=… forces the network, used to log in again.
// - A new version installs in the background; the app shows "Nieuwe versie · Herladen".
// - /api/* is never cached here: app.js keeps its own last copies (localStorage, IndexedDB).
// LAZY: a hash of vendor/ + img/ (set by scripts/stamp-sw.mjs): a new pdf.js, reader or ride photo reaches every phone
const LAZY = 'pretpark-lazy-940f4763f6';
const VERSION = 'pretpark-1abaca074598';
const SHELL = [
  '/', '/style.css', '/app.js', '/logic.js', '/data.js', '/route.js', '/family.js', '/idb.js', '/tickets.js',
  '/park.json', '/icon.svg', '/apple-touch-icon.png', '/manifest.webmanifest', '/photos.js', '/fun.js', '/activity.js', '/compat.js', '/shows.js', '/wrapdata.js', '/wrapped.js', '/exif.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    const ok = await Promise.all(SHELL.map(async (u) => {
      try { const r = await fetch(u, { redirect: 'manual', cache: 'no-cache' }); if (r.ok && r.type === 'basic') { await c.put(u, r); return true; } } catch { /* below */ }
      return false;
    }));
    // a half-filled set would mix versions: only take over when every file arrived (e.g. not while logged out)
    if (ok.every(Boolean)) self.skipWaiting(); else { await caches.delete(VERSION); throw new Error('incomplete'); }
  })());
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== VERSION && k !== 'pretpark-fonts' && k !== LAZY) await caches.delete(k);
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
    if (url.searchParams.has('fresh')) return; // log in again: straight to the network (Cloudflare Access)
    e.respondWith((async () => (await caches.match('/', { cacheName: VERSION })) || fetch(req))());
    return;
  }
  const path = url.pathname;
  if (SHELL.includes(path)) {
    e.respondWith((async () => (await caches.match(path, { cacheName: VERSION })) || fetch(req))());
    return;
  }
  // lazy files (ticket reader libraries, ride photos): cache after first use
  if (path.startsWith('/vendor/') || path.startsWith('/img/')) {
    e.respondWith(caches.open(LAZY).then(async (c) => {
      const hit = await c.match(req); if (hit) return hit;
      const r = await fetch(req); if (okToCache(r)) c.put(req, r.clone()); return r;
    }));
  }
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
    // an open app is only focused and told what to show (no reload: that would lose what's on screen)
    for (const c of all) { if ('focus' in c) { await c.focus(); c.postMessage({ type: 'open', url }); return; } }
    return self.clients.openWindow(url);
  })());
});
