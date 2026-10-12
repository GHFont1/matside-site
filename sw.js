/* Offline shell: pages and scripts come from the network when it answers, and from this cache when the gym
   connection is down, so a tablet can reopen Matside offline. Tournament data is never cached here
   (the app keeps its own offline queue). */
const CACHE = 'matside-v1';
const SHELL = ['./', './index.html', './t/', './t/index.html', './vendor/supabase.js', './vendor/qrcode.js', './config.js', './sbdb.js', './boot.js', './icon.svg', './manifest.webmanifest'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())) });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())) });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const same = u.origin === location.origin, fonts = /fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (!same && !fonts) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(same ? new Request(u.origin + u.pathname) : e.request, copy)) }
    return r;
  }).catch(() => caches.match(same ? u.origin + u.pathname : e.request).then(r => r || caches.match(e.request, { ignoreSearch: true }))));
});
