// Service worker: keeps the app shell available offline and shows push notifications.
// App files are fetched fresh when online (so updates show up right away) and from cache when not.
const CACHE = 'pick-shell-v5';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest', '/css/styles.css',
  '/js/app.js', '/js/api.js', '/js/ui.js', '/js/scanner.js', '/js/upc.js', '/js/barcode.js', '/js/notes.js',
  '/js/views/trucks.js', '/js/views/pick.js', '/js/views/review.js', '/js/views/orders.js',
  '/js/views/items.js', '/js/views/users.js', '/js/views/reports.js', '/js/views/settings.js', '/js/views/rates.js', '/js/views/floor.js', '/js/views/imports.js',
  '/vendor/zxing/zxing-reader.js', '/vendor/zxing/zxing_reader.wasm',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('/'))));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Pick Sheets', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Pick Sheets', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins[0];
    if (win) { win.postMessage({ url }); return win.focus(); }
    return self.clients.openWindow(url);
  }));
});
