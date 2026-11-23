'use strict';

var CACHE = 'eds-antalya-v4';
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

function isAppCode(url, isNav) {
  if (isNav) return true;
  return /\.(?:html|js|css)$/i.test(url.pathname);
}

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
  var isNav = req.mode === 'navigate';
  if (isAppCode(url, isNav)) event.respondWith(networkFirst(req, isNav));
  else event.respondWith(cacheFirst(req));
});

async function networkFirst(req, isNav) {
  var cache = await caches.open(CACHE);
  try {
    var res = await fetch(req, { cache: 'no-cache' });
    if (res && res.ok) {
      var key = isNav ? new URL('./index.html', self.location).href : req;
      cache.put(key, res.clone());
    }
    return res;
  } catch (e) {
    var hit = await cache.match(req, { ignoreSearch: isNav });
    if (hit) return hit;
    if (isNav) {
      var fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('Çevrimdışı', {
      status: 503,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
  }
}

async function cacheFirst(req) {
  var cache = await caches.open(CACHE);
  var hit = await cache.match(req);
  var update = fetch(req).then(function (res) {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(function () { return null; });
  if (hit) {
    update.catch(function () {});
    return hit;
  }
  var res = await update;
  if (res) return res;
  return new Response('Çevrimdışı', {
    status: 503,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }
  });
}
