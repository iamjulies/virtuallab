const CACHE_NAME = 'virlab-beta-v5-build-32';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/main.css',
  './assets/icon.svg',
  './assets/baths/bath_-10.svg',
  './assets/baths/bath_-20.svg',
  './assets/baths/bath_0.svg',
  './assets/baths/bath_10.svg',
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
  './assets/baths/bath_20.svg',
  './assets/baths/bath_200.svg',
  './assets/baths/bath_25.svg',
  './assets/baths/bath_30.svg',
  './assets/baths/bath_40.svg',
  './assets/baths/bath_50.svg',
  './assets/baths/bath_60.svg',
  './assets/baths/bath_70.svg',
  './assets/baths/bath_80.svg',
  './assets/baths/bath_90.svg',
  './src/audio/soundEngine.js',
  './src/canvas/chemicalVisuals.js',
  './src/canvas/equipmentRenderer.js',
  './src/canvas/fluidGasOverlay.js',
  './src/canvas/particles.js',
  './src/canvas/reagentRenderer.js',
  './src/canvas/toolRenderer.js',
  './src/canvas/vesselRenderer.js',
  './src/canvas/workbench.js',
  './src/canvas/workbenchInput.js',
  './src/data/apparatus.js',
  './src/data/constants.js',
  './src/data/i18n.js',
  './src/data/i18n_en.js',
  './src/data/i18n_vi.js',
  './src/data/inorganic/atomicWeights.js',
  './src/data/inorganic/ions.js',
  './src/data/inorganic/solids_gases.js',
  './src/data/missions.js',
  './src/data/organic/hydrocarbons.js',
  './src/data/organic/nitrogen_bio.js',
  './src/data/organic/oxygen_compounds.js',
  './src/data/presets.js',
  './src/data/reactions.js',
  './src/data/reactions/acid_base_ionic.js',
  './src/data/reactions/dissolution.js',
  './src/data/reactions/halogen_sulfur_redox.js',
  './src/data/reactions/metals_oxides.js',
  './src/data/reactions/thermal_h2so4.js',
  './src/data/reagents.js',
  './src/data/species.js',
  './src/data/vesselGeometry.js',
  './src/engine/analyticalTools.js',
  './src/engine/apparatusTools.js',
  './src/engine/chemistry.js',
  './src/engine/chemistryHelpers.js',
  './src/engine/electrochemistry.js',
  './src/engine/equilibrium.js',
  './src/engine/examProctor.js',
  './src/engine/gasNetwork.js',
  './src/engine/inorganicSolvers.js',
  './src/engine/labManager.js',
  './src/engine/liquidField.js',
  './src/engine/liquidSurfacePhysics.js',
  './src/engine/missionEvaluator.js',
  './src/engine/organicEngine.js',
  './src/engine/organicLegacySolver.js',
  './src/engine/simPhysics.js',
  './src/engine/simSnapshot.js',
  './src/engine/simTransfer.js',
  './src/engine/simulation.js',
  './src/engine/solvers/inorganic/carbon_carbide.js',
  './src/engine/solvers/inorganic/halogen_alkali.js',
  './src/engine/solvers/inorganic/phosphorus_nitrogen_ammine.js',
  './src/engine/solvers/inorganic/sulfur.js',
  './src/engine/solvers/organic/alcohols_acids_carbonyl.js',
  './src/engine/solvers/organic/arenes_phenol.js',
  './src/engine/solvers/organic/esters_lipids.js',
  './src/engine/solvers/organic/hydrocarbons_polymers.js',
  './src/engine/thermodynamics.js',
  './src/main.js',
  './src/storage/reportExport.js',
  './src/storage/workspaceStorage.js',
  './src/storage/xlsxExport.js',
  './src/ui/comparisonPanel.js',
  './src/ui/contextMenu.js',
  './src/ui/dosingModal.js',
  './src/ui/environmentBar.js',
  './src/ui/inspector/inspectorCharts.js',
  './src/ui/inspector/inspectorUtils.js',
  './src/ui/inspector/toolInspectors.js',
  './src/ui/inspector/vesselInspector.js',
  './src/ui/inspectorPanel.js',
  './src/ui/missionPanel.js',
  './src/ui/shelfPanel.js',
  './src/ui/shortcutsModal.js',
  './src/ui/storageCabinetModal.js',
  './src/ui/teacherBuilderModal.js',
  './src/ui/workspaceStorageModal.js',
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
