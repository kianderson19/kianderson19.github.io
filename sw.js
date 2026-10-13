/* Cache only this release's static content. Statistics and external APIs stay outside this cache. */
const CACHE='johap-static-f2bcb9b5c4a7c847';
const staticPath=/\/(assets|icons|maps|guide|ocr|fonts)\/|\/theme-init\.js$|\.(png|jpe?g|svg|webp|woff2)$/;
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys()) if(key.startsWith('johap-static-') && key!==CACHE) await caches.delete(key);
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET' || url.origin!==self.location.origin || (!staticPath.test(url.pathname) && request.mode!=='navigate')) return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const key=request.mode==='navigate'?url.origin+url.pathname:request;
    const saved=await cache.match(key);
    if(saved && request.mode!=='navigate') return saved;
    try {
      const response=await fetch(request,request.mode==='navigate'?{signal:AbortSignal.timeout(4000)}:undefined);
      if(response.ok) {
        try { await cache.put(key,response.clone()); } catch { /* Storage pressure must not break the online app. */ }
        return response;
      }
      if(saved) return saved;
      return response;
    } catch(error) { if(saved) return saved;throw error; }
  })());
});
