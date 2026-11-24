// Immutable, versioned app shell; no auth, API responses or private data in CacheStorage.
const CACHE='wlf-pwa-2.6.7-bin-__CACHE_HASH__',ASSETS=__PRECACHE__;
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(asset=>new Request(asset,{cache:'reload'}))))));
self.addEventListener('message',event=>{if(event.data==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('wlf-pwa-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||!ASSETS.some(a=>new URL(a,self.registration.scope).pathname===url.pathname))return;
 event.respondWith(caches.open(CACHE).then(async cache=>{const hit=await cache.match(event.request);return hit||fetch(event.request);}));});
// v2.5.0 push notifications: show the message; a tap opens (or focuses) the app.
self.addEventListener('push',event=>{let d={};try{d=event.data?event.data.json():{};}catch(e){d={body:event.data?event.data.text():''};}
 event.waitUntil(self.registration.showNotification(d.title||'WLF Electrical Solution',{body:d.body||'',tag:d.tag||'wlf',icon:'icon-192.png',badge:'icon-192.png',data:{url:new URL(d.url||'./',self.registration.scope).href}}));});
self.addEventListener('notificationclick',event=>{event.notification.close();const target=(event.notification.data&&event.notification.data.url)||self.registration.scope;
 event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{const open=list.find(c=>c.url.startsWith(self.registration.scope));if(open){open.postMessage({type:'wlf-open',url:target});return open.focus();}return self.clients.openWindow(target);}));});
