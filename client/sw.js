// Offline shell for the installed app. It stores only the static page files; anything under /api/ and
// every non-GET request goes straight to the network, so no mail, session or user data is ever cached.
const CACHE = 'tu-mail-shell-v7';
const SHELL = [
  '/', '/index.html', '/mail.html', '/manifest.webmanifest',
  '/css/login.css', '/css/main.css', '/css/dashboard.css', '/css/mobile.css', '/css/mail.css', '/css/mail-compose.css',
  '/css/mail-cards.css', '/css/features.css', '/css/standalone.css', '/css/a11y.css', '/css/modern.css', '/css/print.css',
  '/js/i18n.js', '/js/i18n-de.js', '/js/brand.js', '/js/pwa.js', '/js/ui-prefs.js', '/js/a11y.js', '/js/shortcuts.js',
  '/js/login.js', '/js/auth.js', '/js/mail-app.js', '/js/mail-cache.js', '/js/mail-thread.js', '/js/mail-preview.js',
  '/js/mail-organize.js', '/js/mail-recovery.js', '/js/mail-compose.js', '/js/mail-signature.js', '/js/mail-tools.js',
  '/js/mail-search.js', '/js/safety.js', '/js/undo-send.js', '/js/message-tools.js', '/js/notify.js',
  '/assets/tu-logo.svg', '/assets/icon.svg', '/assets/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Alerts from the server (services/push.js) arrive here even when no page is open. If the person is looking at
// the app there is nothing to announce, so nothing is shown.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch (e) { /* an empty ping */ }
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (pages.some((p) => p.visibilityState === 'visible' && p.focused)) return;
    await self.registration.showNotification(String(data.title || 'New mail').slice(0, 120), {
      body: String(data.body || '').slice(0, 300), tag: 'tu-mail-new', renotify: true, icon: '/assets/icon-192.png',
      data: { url: typeof data.url === 'string' && data.url.startsWith('/mail.html') ? data.url : '/mail.html' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/mail.html';
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const page of pages) {
      if (!('focus' in page)) continue;
      await page.focus();
      if ('navigate' in page) { try { await page.navigate(url); } catch (e) { /* stays where it is */ } }
      return;
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/metrics') return;
  // Network first so a new release is picked up immediately; the cache is only the offline fallback.
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))),
  );
});
