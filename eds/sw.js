'use strict';

var CACHE = 'eds-antalya-v1';
var ASSETS = [
  './',
  './index.html',
  './app.js',
  './logic.js',
  './style.css',
  './eds.geojson',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './vendor/leaflet.js',
  './vendor/leaflet.css'
];

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(function (url) {
      return cache.add(url).catch(function () {});
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (k) {
      return k.indexOf('eds-') === 0 && k !== CACHE;
    }).map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async function () {
    var cache = await caches.open(CACHE);
    var isNav = req.mode === 'navigate';
    var hit = await cache.match(req, { ignoreSearch: isNav });
    var update = fetch(req).then(function (res) {
      if (res && res.ok) {
        var key = isNav ? new URL('./index.html', self.location).href : req;
        cache.put(key, res.clone());
      }
      return res;
    }).catch(function () { return null; });
    if (hit) {
      update.catch(function () {});
      return hit;
    }
    var res = await update;
    if (res) return res;
    if (isNav) {
      var fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('Çevrimdışı', {
      status: 503,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
  })());
});
