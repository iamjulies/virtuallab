const CACHE_NAME = 'virlab-beta-v1-build-17';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/main.css',
  './assets/icon.svg',
  './src/main.js',
  './src/data/constants.js',
  './src/data/vesselGeometry.js',
  './src/data/i18n.js',
  './src/data/species.js',
  './src/data/reactions.js',
  './src/data/apparatus.js',
  './src/engine/equilibrium.js',
  './src/engine/chemistry.js',
  './src/engine/thermodynamics.js',
  './src/engine/gasNetwork.js',
  './src/engine/simulation.js',
  './src/canvas/particles.js',
  './src/canvas/chemicalVisuals.js',
  './src/canvas/reagentRenderer.js',
  './src/canvas/vesselRenderer.js',
  './src/canvas/workbench.js',
  './src/ui/shelfPanel.js',
  './src/ui/dosingModal.js',
  './src/ui/inspectorPanel.js',
  './src/ui/environmentBar.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
