/* Vector Plane service worker
   - App shell: precached, served network-first (revalidated), cache when offline.
   - Libraries (pdf.js, JSZip, jsPDF) and fonts: cached on first use so import
     and export keep working offline.
   Bump VERSION whenever shell files change. */

const VERSION = 'vp-2026-11-04c';
const SHELL = `${VERSION}-shell`;
const RUNTIME = 'vp-runtime-v1';

const SHELL_FILES = [
  './', './index.html', './studio.html', './guide.html', './css/app.css', './css/studio.css',
  './js/app.js', './js/studio.js', './js/geometry.js', './js/render.js', './js/store.js',
  './manifest.webmanifest', './studio.webmanifest', './icons/favicon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './icons/maskable-512.png', './icons/apple-touch-icon.png',
  './icons/studio-favicon.svg', './icons/studio-192.png', './icons/studio-512.png', './icons/studio-maskable-512.png', './icons/studio-apple-touch.png',
];
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES);
    // Libraries are best-effort: a CDN hiccup must not block installing the app.
    const rt = await caches.open(RUNTIME);
    await Promise.all(LIBS.map(async (url) => {
      try { if (!(await rt.match(url))) { const r = await fetch(url, { mode: 'cors' }); if (r.ok) await rt.put(url, r); } } catch (e) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.endsWith('-shell') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

const isRuntimeCacheable = (url) =>
  url.hostname === 'cdnjs.cloudflare.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Navigations: network first so updates land quickly, shell when offline.
    if (req.mode === 'navigate') {
      event.respondWith((async () => {
        try {
          const fresh = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
          if (fresh.ok) { const c = await caches.open(SHELL); c.put(req, fresh.clone()); }
          return fresh;
        } catch (e) {
          const c = await caches.open(SHELL);
          return (await c.match(req, { ignoreSearch: true })) || (await c.match('./index.html')) || Response.error();
        }
      })());
      return;
    }
    // Static files: network first (so ES modules never mix versions), cache when
    // offline or when the network is slower than 3 s.
    event.respondWith((async () => {
      const c = await caches.open(SHELL);
      const net = fetch(req, { cache: 'no-cache' }).then((r) => { if (r.ok) c.put(req, r.clone()); return r; });
      const timeout = new Promise((res) => setTimeout(res, 3000, null));
      try {
        const r = await Promise.race([net, timeout]);
        if (r) return r;
      } catch (e) {}
      return (await c.match(req, { ignoreSearch: true })) || net.catch(() => Response.error());
    })());
    return;
  }

  if (isRuntimeCacheable(url)) {
    event.respondWith((async () => {
      const c = await caches.open(RUNTIME);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok || r.type === 'opaque') c.put(req, r.clone());
        return r;
      } catch (e) { return Response.error(); }
    })());
  }
});
