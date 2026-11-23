// Service worker de Kairos : app-shell en cache-first versionné, stale-while-revalidate pour le reste,
// repli hors-ligne sur index.html. Chemins relatifs (le site est servi sous /kairos/ sur GitHub Pages).
// Liste des fichiers à pré-cacher : `precache.json` ({ version, assets }) s'il est présent (l'orchestrateur
// peut le régénérer), sinon FALLBACK_ASSETS ci-dessous. Incrémente VERSION à chaque livraison.
const VERSION = 'kairos-v1';
const CACHE = `${VERSION}-shell`;

const FALLBACK_ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'css/views-today.css', 'css/views-plan.css', 'css/views-lab.css', 'css/views-sleep.css', 'css/views-travel.css', 'css/views-insights.css', 'css/views-settings.css', 'css/views-science.css',
  'icons/icon.svg', 'icons/icon-maskable.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'js/store.js',
  'js/core/time.js', 'js/core/chrono.js', 'js/core/caffeine.js', 'js/core/sleep.js', 'js/core/jetlag.js', 'js/core/model.js', 'js/core/scheduler.js', 'js/core/personalize.js',
  'js/core/nlp-fr.js', 'js/core/ics.js', 'js/core/crypto.js', 'js/core/demo.js', 'js/core/insights.js',
  'js/ui/app.js', 'js/ui/dom.js', 'js/ui/charts.js', 'js/ui/modal.js', 'js/ui/toast.js', 'js/ui/palette.js',
  'js/ui/views/today.js', 'js/ui/views/plan.js', 'js/ui/views/lab.js', 'js/ui/views/sleep.js', 'js/ui/views/travel.js', 'js/ui/views/insights.js', 'js/ui/views/settings.js', 'js/ui/views/science.js',
];

async function listAssets() {
  try {
    const r = await fetch('precache.json', { cache: 'no-cache' });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.assets) && j.assets.length) return j.assets; }
  } catch { /* hors-ligne ou absent : liste intégrée */ }
  return FALLBACK_ASSETS;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const assets = await listAssets();
    // allSettled : un fichier absent (vue pas encore livrée, par exemple) ne bloque pas l'installation
    await Promise.allSettled(assets.map((a) => cache.add(new Request(a, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('kairos-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigation : coquille d'abord (cache-first), mise à jour en arrière-plan, repli hors-ligne.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('index.html')) || (await cache.match('./'));
      const refresh = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      if (cached) { event.waitUntil(refresh); return cached; }
      return (await refresh) || new Response('<!doctype html><meta charset="utf-8"><title>Hors-ligne</title><body style="font:16px system-ui;background:#060910;color:#f0ebdd;display:grid;place-items:center;height:100vh;margin:0"><p>Kairos est hors-ligne et n\'a pas encore été mis en cache.</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    })());
    return;
  }

  // Assets : stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => { if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; }).catch(() => null);
    if (cached) { event.waitUntil(network); return cached; }
    return (await network) || new Response('', { status: 504, statusText: 'Hors-ligne' });
  })());
});
