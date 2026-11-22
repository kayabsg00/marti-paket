const C = 'odak-v1';
const F = ['./', './index.html', './app.css', './app.js', './tips.js', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(F)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('odak-') && k !== C).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  if (!(u.pathname.includes('/odak/') || u.pathname.endsWith('/odak'))) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) {
        const copy = r.clone();
        caches.open(C).then(c => c.put(e.request, copy));
      }
      return r;
    }).catch(() => caches.match(e.request).then(m => {
      if (m) return m;
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      return new Response('', {status: 504, statusText: 'offline'});
    }))
  );
});
