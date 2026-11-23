const C = "dur-bekci-v1";
const DIR = "/dur/";
const F = ["./", "./index.html", "./app.css", "./app.js", "./logic.js", "./manifest.json", "./icon.svg", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(C).then((c) => c.addAll(F)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((x) => x.startsWith("dur-bekci-") && x !== C).map((x) => caches.delete(x)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  if (!(u.pathname.includes(DIR) || /\/dur\/?$/.test(u.pathname))) return;
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const cl = r.clone();
          caches.open(C).then((c) => c.put(e.request, cl));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
