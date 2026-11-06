// Service worker: only for push notifications (no offline caching; the app needs live data anyway).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
