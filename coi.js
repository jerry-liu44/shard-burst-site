// Cross-origin isolation for a static host that cannot send headers (GitHub Pages).
//
// Rive's audio processors (the procedural tracks, rive/audio/) only run on a page served with
// Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp, as
// rive.to and web/serve.py send. Loaded as a page script, this registers itself as a service
// worker and reloads once; as the service worker, it adds those headers to every response.
// Where the page is already isolated (rive.to, serve.py) it does nothing.
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
    e.respondWith(fetch(req).then((res) => {
      if (res.status === 0) return res;      // opaque: nothing to add
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }));
  });
} else if (window.crossOriginIsolated) {
  try { sessionStorage.removeItem('coi.reloaded'); } catch (e) {}
} else if (window.isSecureContext && 'serviceWorker' in navigator) {
  const reloadOnce = () => {
    try {
      if (sessionStorage.getItem('coi.reloaded')) return;    // never loop
      sessionStorage.setItem('coi.reloaded', '1');
    } catch (e) { return; }
    location.reload();
  };
  navigator.serviceWorker.register(document.currentScript.src).then((reg) => {
    if (reg.active && !navigator.serviceWorker.controller) reloadOnce();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'activated') reloadOnce(); });
    });
    if (reg.active && navigator.serviceWorker.controller) reloadOnce();
  }).catch((e) => console.warn('coi: no service worker, procedural tracks off', e));
}
