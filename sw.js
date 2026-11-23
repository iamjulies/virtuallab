const CACHE_NAME = 'virlab-beta-v5-build-17';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/main.css',
  './assets/icon.svg',
  './assets/baths/bath_-20.svg',
  './assets/baths/bath_-10.svg',
  './assets/baths/bath_0.svg',
  './assets/baths/bath_10.svg',
  './assets/baths/bath_20.svg',
  './assets/baths/bath_25.svg',
  './assets/baths/bath_30.svg',
  './assets/baths/bath_40.svg',
  './assets/baths/bath_50.svg',
  './assets/baths/bath_60.svg',
  './assets/baths/bath_70.svg',
  './assets/baths/bath_80.svg',
  './assets/baths/bath_90.svg',
  './assets/baths/bath_100.svg',
  './assets/baths/bath_110.svg',
  './assets/baths/bath_120.svg',
  './assets/baths/bath_130.svg',
  './assets/baths/bath_140.svg',
  './assets/baths/bath_150.svg',
  './assets/baths/bath_160.svg',
  './assets/baths/bath_170.svg',
  './assets/baths/bath_180.svg',
  './assets/baths/bath_190.svg',
  './assets/baths/bath_200.svg',
  './src/main.js',
  './src/audio/soundEngine.js',
  './src/storage/workspaceStorage.js',
  './src/storage/xlsxExport.js',
  './src/data/constants.js',
  './src/data/vesselGeometry.js',
  './src/data/i18n.js',
  './src/data/species.js',
  './src/data/organic/hydrocarbons.js',
  './src/data/organic/oxygen_compounds.js',
  './src/data/organic/nitrogen_bio.js',
  './src/data/reactions.js',
  './src/data/apparatus.js',
  './src/data/presets.js',
  './src/engine/equilibrium.js',
  './src/engine/chemistryHelpers.js',
  './src/engine/inorganicSolvers.js',
  './src/engine/organicLegacySolver.js',
  './src/engine/chemistry.js',
  './src/engine/organicEngine.js',
  './src/engine/thermodynamics.js',
  './src/engine/gasNetwork.js',
  './src/engine/electrochemistry.js',
  './src/engine/apparatusTools.js',
  './src/engine/analyticalTools.js',
  './src/engine/liquidField.js',
  './src/engine/liquidSurfacePhysics.js',
  './src/engine/labManager.js',
  './src/engine/simulation.js',
  './src/canvas/particles.js',
  './src/canvas/chemicalVisuals.js',
  './src/canvas/reagentRenderer.js',
  './src/canvas/vesselRenderer.js',
  './src/canvas/toolRenderer.js',
  './src/canvas/fluidGasOverlay.js',
  './src/canvas/workbench.js',
  './src/ui/shelfPanel.js',
  './src/ui/dosingModal.js',
  './src/ui/inspectorPanel.js',
  './src/ui/environmentBar.js',
  './src/ui/comparisonPanel.js',
  './src/ui/workspaceStorageModal.js',
  './src/ui/storageCabinetModal.js',
  './src/ui/shortcutsModal.js',
  './src/ui/contextMenu.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))
    )
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
  const reqUrl = new URL(event.request.url);
  const fetchPromise =
    reqUrl.origin === self.location.origin
      ? fetch(event.request.url, { cache: 'no-cache' })
      : fetch(event.request);
  event.respondWith(
    fetchPromise
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
