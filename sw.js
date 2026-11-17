const CACHE_NAME = 'virlab-beta-v3-build-9';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/main.css',
  './assets/icon.svg',
  './src/main.js',
  './src/audio/soundEngine.js',
  './src/storage/workspaceStorage.js',
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
  './src/engine/electrochemistry.js',
  './src/engine/apparatusTools.js',
  './src/engine/labManager.js',
  './src/engine/simulation.js',
  './src/canvas/particles.js',
  './src/canvas/chemicalVisuals.js',
  './src/canvas/reagentRenderer.js',
  './src/canvas/vesselRenderer.js',
  './src/canvas/toolRenderer.js',
  './src/canvas/workbench.js',
  './src/ui/shelfPanel.js',
  './src/ui/dosingModal.js',
  './src/ui/inspectorPanel.js',
  './src/ui/environmentBar.js',
  './src/ui/comparisonPanel.js',
  './src/ui/workspaceStorageModal.js',
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
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
