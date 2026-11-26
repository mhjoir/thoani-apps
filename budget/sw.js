/* دفتر البنزين: تشغيل بدون اتصال. غيّر رقم النسخة عند كل تحديث للملفات. */
var CACHE = "budget-v1", PRE = "budget-";
var SHELL = ["./", "index.html", "standalone.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-180.png"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){
    return c.addAll(SHELL.map(function(u){ return new Request(u, {cache:"reload"}); }));
  }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE && k.indexOf(PRE) === 0; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener("fetch", function(e){
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  /* الشبكة أولاً مع تجاوز ذاكرة المتصفح حتى تصل التحديثات فوراً، ثم النسخة المخزنة عند انقطاع الاتصال */
  e.respondWith(
    fetch(e.request.url, {cache:"no-cache", credentials:"same-origin"}).then(function(res){
      if (res.ok){ var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, copy); }); }
      return res;
    }).catch(function(){
      return caches.match(e.request).then(function(hit){ return hit || caches.match("index.html"); });
    })
  );
});
