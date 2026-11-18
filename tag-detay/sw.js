const C='tagdetay-v1';
const DIR='/tag-detay/';
const F=['./','./index.html','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(x=>x.startsWith('tagdetay-')&&x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.origin!==self.location.origin)return;
  if(!(u.pathname.includes(DIR)||u.pathname.endsWith('/tag-detay')))return;
  e.respondWith(fetch(e.request).then(r=>{
    if(r.ok&&e.request.method==='GET'){const cl=r.clone();caches.open(C).then(c=>c.put(e.request,cl))}
    return r;
  }).catch(()=>caches.match(e.request)));
});
