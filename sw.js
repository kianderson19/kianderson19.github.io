/* Cache only this release's static content. Statistics and external APIs stay outside this cache. */
const CACHE='johap-static-da46864c1d5e7e8f';
const staticPath=/\/(assets|icons|maps|guide|ocr|fonts|recognition)\/|\/theme-init\.js$|\.(png|jpe?g|svg|webp|woff2)$/;
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys()) if(key.startsWith('johap-static-') && key!==CACHE) await caches.delete(key);
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET' || url.origin!==self.location.origin || (!staticPath.test(url.pathname) && request.mode!=='navigate')) return;
  event.respondWith((async()=>{
    let cache;try{cache=await caches.open(CACHE);}catch{return fetch(request);}
    const key=request.mode==='navigate'?url.origin+url.pathname:request;
    const saved=await cache.match(key);
    if(saved && request.mode!=='navigate' && request.cache!=='reload' && request.cache!=='no-cache') return saved;
    const controller=new AbortController();
    const timer=request.mode==='navigate'?setTimeout(()=>controller.abort(),4000):undefined;
    try {
      const response=await fetch(request,request.mode==='navigate'?{signal:controller.signal}:undefined);
      if(response.ok) {
        try { await cache.put(key,response.clone()); } catch { /* Storage pressure must not break the online app. */ }
        return response;
      }
      if(saved) return saved;
      return response;
    } catch(error) { if(saved) return saved;throw error; }
    finally { if(timer!==undefined) clearTimeout(timer); }
  })());
});
