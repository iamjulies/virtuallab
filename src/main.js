import { I18N } from './data/i18n.js';
import { APPARATUS } from './data/apparatus.js';
import { LabManager } from './engine/labManager.js';
import { LabWorkbenchCanvas, BENCH_FLOOR_Y } from './canvas/workbench.js';
import { EnvironmentBar } from './ui/environmentBar.js';
import { ShelfPanel } from './ui/shelfPanel.js';
import { InspectorPanel } from './ui/inspectorPanel.js';
import { DosingModal } from './ui/dosingModal.js';

const STORAGE_LANG_KEY = 'virlab_lang';
const STORAGE_THEME_KEY = 'virlab_theme';
const STORAGE_DEVICE_KEY = 'virlab_device';

const appState = {
  lang: localStorage.getItem(STORAGE_LANG_KEY) || 'vi',
  theme: localStorage.getItem(STORAGE_THEME_KEY) || 'dark',
  deviceMode: localStorage.getItem(STORAGE_DEVICE_KEY) || 'auto',
  mobileTab: 'bench', // 'shelf' | 'bench' | 'inspector'
};

function getTranslator() {
  const dict = I18N[appState.lang] || I18N.vi;
  return (key) => dict[key] ?? key;
}

const rootWrap = document.getElementById('device-frame-wrap');
const headerEl = document.getElementById('env-bar');
const labTabsEl = document.getElementById('lab-tabs-bar');
const shelfEl = document.getElementById('shelf-panel');
const inspectorEl = document.getElementById('inspector-panel');
const modalEl = document.getElementById('dosing-modal-root');
const canvasEl = document.getElementById('workbench-canvas');
const benchHintEl = document.getElementById('bench-hint-text');
const resetBtnEl = document.getElementById('btn-reset-bench');
const toastEl = document.getElementById('toast-banner');
const benchPickBannerEl = document.getElementById('bench-pick-banner');
const benchPickTextEl = document.getElementById('bench-pick-text');
const benchPickCancelEl = document.getElementById('bench-pick-cancel');

let toastTimer = null;
function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 3400);
}

let workbench = null;
let lastFrameDt = 1 / 60;
const subscribedSims = new WeakSet();

const labManager = new LabManager({
  onActiveParticlesNeeded: (vessel, metrics) => {
    const activeLab = labManager.getActiveLab();
    activeLab.particles.emitForVessel(vessel, metrics, lastFrameDt * activeLab.sim.environment.speed);
  },
  onAlert: (_idx, type, vessel, meta) => {
    handleVisualAlert(type, vessel, meta);
  },
  onBackgroundAlert: () => {
    renderLabTabs(getTranslator());
  },
  onChange: () => {
    syncActiveLabRefs();
    refreshChrome(true);
  },
});

let sim = labManager.getActiveSim();
let particles = labManager.getActiveParticles();

function ensureLabSubscribed(lab) {
  if (!lab || subscribedSims.has(lab.sim)) return;
  subscribedSims.add(lab.sim);
  lab.sim.subscribe(() => {
    if (lab.sim === sim) refreshChrome();
  });
}
ensureLabSubscribed(labManager.getActiveLab());

function handleVisualAlert(type, vessel, meta) {
  const t = getTranslator();
  const burstType =
    type === 'thermal_shock'
      ? 'shatter'
      : type === 'solvent_ignition' || type === 'zn_burn_o2'
      ? 'o2_flare'
      : type === 'unpurged_h2'
      ? 'h2_pop'
      : type;
  particles.emitBurst(burstType, vessel.x, vessel.y, meta);
  if (type === 'explosion') {
    workbench.triggerShake(13, 0.45);
    const latest = sim.logs[0];
    showToast(`💥 ${t(latest?.key || 'alertNaExplosion')}`);
  } else if (type === 'shatter') {
    workbench.triggerShake(8, 0.34);
    const latest = sim.logs[0];
    const msgKey = latest?.key || 'alertOverpressureShatter';
    showToast(`💥 ${t(msgKey)}`);
  } else if (type === 'thermal_shock') {
    workbench.triggerShake(9.5, 0.38);
    showToast(`💥 ${t('alertThermalShock')}`);
  } else if (type === 'solvent_ignition') {
    workbench.triggerShake(4.8, 0.22);
    showToast(`🔥 ${t('alertSolventIgnition')}`);
  } else if (type === 'unpurged_h2') {
    workbench.triggerShake(6.5, 0.26);
    showToast(t('alertUnpurgedH2O2'));
  } else if (type === 'zn_burn_o2') {
    workbench.triggerShake(4.0, 0.2);
    showToast(t('alertZnCombustionO2'));
  } else if (type === 'drop_spill') {
    workbench.triggerShake(4.2, 0.20);
    showToast(`💧 ${t('alertDropSpill')}`);
  } else if (type === 'syringe_plunger_pop') {
    workbench.triggerShake(6.0, 0.26);
    showToast(`⚠️ ${t('alertSyringePlungerPop')}`);
  } else if (type === 'pop') {
    workbench.triggerShake(5.5, 0.24);
    showToast(`⚠️ ${meta?.hydraulic ? t('alertHydroOverflowPop') : t('alertOverpressurePop')}`);
  } else if (type === 'overflow') {
    showToast(`💧 ${t('alertOverflow')}`);
  } else if (type === 'syringe_overflow') {
    showToast(`💧 ${t('alertSyringeOverflow')}`);
  } else if (type === 'h2_pop') {
    showToast(`💥 ${t('alertH2Pop')}`);
  } else if (type === 'oxyhydrogen_detonation') {
    workbench.triggerShake(10 * Math.min(2.2, meta?.blastScale || 1.1), 0.38);
    showToast(`💥 ${t('alertOxyhydrogenDetonation')}`);
  } else if (type === 'ammonia_fountain') {
    showToast(`⛲ ${t('alertAmmoniaFountain')}`);
  } else if (type === 'o2_relight') {
    showToast(`🔥 ${t('alertO2Relight')}`);
  } else if (type === 'o2_flare') {
    showToast(`🔥 ${t('alertO2Flare')}`);
  } else if (type === 'cl2_extinguish') {
    showToast(`🌫️ ${t('alertCl2Extinguish')}`);
  }
}
function startBenchPick(opts = {}) {
  if (!workbench) return;
  const prevMobileTab = isMobileViewActive() ? appState.mobileTab : null;
  if (prevMobileTab && prevMobileTab !== 'bench') {
    setMobileTab('bench');
  }
  workbench.startItemPick({
    candidateIds: opts.candidateIds || [],
    promptText: opts.promptText || getTranslator()('pickBenchPrompt'),
    onPick: (picked) => {
      if (prevMobileTab && prevMobileTab !== 'bench') {
        setMobileTab(prevMobileTab);
      }
      opts.onPick?.(picked);
      refreshChrome(true);
    },
    onCancel: () => {
      if (prevMobileTab && prevMobileTab !== 'bench') {
        setMobileTab(prevMobileTab);
      }
      opts.onCancel?.();
    },
  });
}

benchPickCancelEl?.addEventListener('click', () => {
  workbench?.cancelItemPick();
});

const dosingModal = new DosingModal(modalEl, sim, getTranslator, (opts) => startBenchPick(opts));

function findDropLabTab(clientX, clientY) {
  if (!labTabsEl || (!clientX && !clientY)) return null;
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const btn = el.closest?.('.lab-tab-btn');
    if (btn && btn.dataset.labIndex !== undefined) {
      const idx = Number(btn.dataset.labIndex);
      if (idx !== labManager.activeIndex && idx >= 0 && idx < labManager.labs.length) {
        return { btn, idx };
      }
    }
  }
  return null;
}

function clearLabDropHighlights() {
  labTabsEl?.querySelectorAll('.lab-tab-drop-target').forEach((el) => {
    el.classList.remove('lab-tab-drop-target');
  });
}

workbench = new LabWorkbenchCanvas(canvasEl, sim, particles, {
  onSelect: () => {
    refreshChrome();
  },
  onRequestDosing: (reagentId, vesselId) => {
    dosingModal.openReagent(reagentId, vesselId);
  },
  onExternalTabDragHover: (clientX, clientY, item) => {
    clearLabDropHighlights();
    if (!item) return;
    const hit = findDropLabTab(clientX, clientY);
    if (hit) hit.btn.classList.add('lab-tab-drop-target');
  },
  onDropToLabTab: (clientX, clientY, item) => {
    clearLabDropHighlights();
    const hit = item ? findDropLabTab(clientX, clientY) : null;
    if (!hit) return false;
    const moved = labManager.moveItemBetweenLabs(item.id, labManager.activeIndex, hit.idx);
    if (moved) {
      const t = getTranslator();
      showToast(`📤 ${t('labMovedToast').replace('{lab}', `${t('labTabPrefix')} ${moved.dstLab.number}`)}`);
      return true;
    }
    return false;
  },
  onPickStateChange: (pickSt) => {
    if (!benchPickBannerEl) return;
    if (pickSt) {
      const t = getTranslator();
      if (benchPickTextEl) benchPickTextEl.textContent = pickSt.promptText || t('pickBenchPrompt');
      if (benchPickCancelEl) benchPickCancelEl.textContent = t('pickBenchCancel');
      benchPickBannerEl.classList.remove('hidden');
    } else {
      benchPickBannerEl.classList.add('hidden');
    }
  },
});

const envBar = new EnvironmentBar(headerEl, sim, appState, {
  onLangChange: () => {
    appState.lang = appState.lang === 'vi' ? 'en' : 'vi';
    localStorage.setItem(STORAGE_LANG_KEY, appState.lang);
    refreshChrome(true);
  },
  onThemeChange: () => {
    appState.theme = appState.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_THEME_KEY, appState.theme);
    applyThemeAndDevice();
    refreshChrome(true);
  },
  onDeviceChange: (mode) => {
    appState.deviceMode = mode;
    localStorage.setItem(STORAGE_DEVICE_KEY, mode);
    applyThemeAndDevice();
    setTimeout(() => workbench.resize(), 40);
  },
  onPreset: (presetName) => {
    particles.clear();
    sim.setupPreset(presetName);
    refreshChrome(true);
  },
});

const shelfPanel = new ShelfPanel(shelfEl, sim, getTranslator, {
  onAddApparatus: (typeId) => {
    const spec = APPARATUS[typeId];
    // Stagger X cleanly across bench
    const count = sim.items.length;
    const x = 140 + ((count * 125) % 740);
    const y = BENCH_FLOOR_Y - spec.height / 2 + 2;
    sim.createApparatus(typeId, x, y);
    if (isMobileViewActive()) {
      setMobileTab('bench');
    }
    refreshChrome();
  },
  onSelectReagent: (reagentId) => {
    const sel = sim.getItem(sim.selectedId);
    const validKind = (it) =>
      it &&
      !it.isShattered &&
      !it.isBroken &&
      (it.kind === 'vessel' || it.kind === 'filter_funnel' || it.kind === 'burette');
    let target = validKind(sel) ? sel : null;
    if (!target) {
      target = sim.items.find((i) => validKind(i)) || null;
    }
    if (!target) {
      // Auto-create a beaker so user isn't stuck
      target = sim.createApparatus('beaker_250', 480, BENCH_FLOOR_Y - 70);
    }
    dosingModal.openReagent(reagentId, target.id);
  },
  onExternalDragMove: (clientX, clientY, kind, id) => {
    workbench.setExternalDropPreview(clientX, clientY, kind, id);
  },
  onExternalDrop: (clientX, clientY, kind, id) => {
    const rect = canvasEl.getBoundingClientRect();
    const pad = 24;
    if (
      clientX >= rect.left - pad &&
      clientX <= rect.right + pad &&
      clientY >= rect.top - pad &&
      clientY <= rect.bottom + pad
    ) {
      const clampedX = Math.max(rect.left + 2, Math.min(rect.right - 2, clientX));
      const clampedY = Math.max(rect.top + 2, Math.min(rect.bottom - 2, clientY));
      workbench.dropFromShelf(clampedX, clampedY, kind, id);
      if (isMobileViewActive()) setMobileTab('bench');
      refreshChrome();
    } else {
      workbench.setExternalDropPreview(0, 0, null, null);
    }
  },
});

const inspectorPanel = new InspectorPanel(inspectorEl, sim, getTranslator, {
  onOpenTransfer: (sourceId) => dosingModal.openTransfer(sourceId),
  onOpenSolidTransfer: (sourceId) => dosingModal.openSolidTransfer(sourceId),
  onOpenTubeTarget: (sourceId) => dosingModal.openTubeTarget(sourceId),
  onOpenSyringeTransfer: (syringeId) => dosingModal.openSyringeTransfer(syringeId),
  onStartBenchPick: (opts) => startBenchPick(opts),
  onNotify: (msg) => showToast(msg),
  getLabsMeta: () => ({ labs: labManager.labs, activeIndex: labManager.activeIndex }),
  onMoveToLab: (itemId, dstIdx) => {
    const moved = labManager.moveItemBetweenLabs(itemId, labManager.activeIndex, dstIdx);
    if (moved) {
      const t = getTranslator();
      showToast(`📤 ${t('labMovedToast').replace('{lab}', `${t('labTabPrefix')} ${moved.dstLab.number}`)}`);
    }
  },
});

function syncActiveLabRefs() {
  const activeLab = labManager.getActiveLab();
  ensureLabSubscribed(activeLab);
  sim = activeLab.sim;
  particles = activeLab.particles;
  const isDark = appState.theme === 'dark';
  particles.setTheme(isDark);
  workbench.setSim(sim, particles);
  envBar.setSim(sim);
  shelfPanel.setSim(sim);
  inspectorPanel.setSim(sim);
  dosingModal.setSim(sim);
}

let lastLabTabSig = '';
function renderLabTabs(t) {
  if (!labTabsEl) return;
  const sig = `${appState.lang}|${labManager.activeIndex}|${labManager.labs
    .map((lb) => `${lb.id}:${lb.sim.items.length}:${lb.sim.environment.atmosphereMode}:${lb.unreadAlerts || 0}`)
    .join(',')}`;
  if (sig === lastLabTabSig) return;
  lastLabTabSig = sig;

  const canClose = labManager.labs.length > 1;
  const atMax = labManager.labs.length >= labManager.maxLabs;
  const tabsHtml = labManager.labs
    .map((lb, idx) => {
      const isActive = idx === labManager.activeIndex;
      const atmIcon = lb.sim.environment.atmosphereMode === 'inert' ? '🛡️' : '🌬️';
      const dotHtml = !isActive && (lb.unreadAlerts || 0) > 0
        ? `<span class="w-2 h-2 rounded-full bg-amber-400" title="${lb.unreadAlerts}"></span>`
        : '';
      const closeBtn = canClose
        ? `<span class="lab-tab-close" data-close-lab="${idx}" title="${t('labCloseTip')}">×</span>`
        : '';
      return `<button type="button" class="lab-tab-btn ${isActive ? 'active' : ''}" data-lab-index="${idx}" title="${t('labDropMoveHint')}">
        <span>${atmIcon} ${t('labTabPrefix')} ${lb.number}</span>
        <span class="text-[10px] opacity-80 font-mono">(${lb.sim.items.length})</span>
        ${dotHtml}
        ${closeBtn}
      </button>`;
    })
    .join('');

  labTabsEl.innerHTML = `
    ${tabsHtml}
    <button type="button" id="btn-add-lab" class="lab-add-btn" ${atMax ? 'disabled' : ''} title="${atMax ? t('labMaxLimit') : ''}">
      ${t('labAddBtn')} (${labManager.labs.length}/${labManager.maxLabs})
    </button>
  `;

  labTabsEl.querySelectorAll('.lab-tab-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const closeEl = e.target.closest?.('[data-close-lab]');
      if (closeEl) {
        e.stopPropagation();
        labManager.removeLab(Number(closeEl.dataset.closeLab));
        return;
      }
      labManager.switchLab(Number(btn.dataset.labIndex));
    });
  });

  labTabsEl.querySelector('#btn-add-lab')?.addEventListener('click', () => {
    const res = labManager.addLab('starter');
    if (!res.ok) {
      showToast(`⚠️ ${t('labMaxLimit')}`);
    } else {
      ensureLabSubscribed(res.lab);
    }
  });
}

function isMobileViewActive() {
  return appState.deviceMode === 'mobile' || (appState.deviceMode === 'auto' && window.innerWidth <= 820);
}

function setMobileTab(tab) {
  appState.mobileTab = tab;
  document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.className = active
      ? 'mobile-tab-btn py-1.5 rounded-lg text-xs font-semibold bg-accent text-white'
      : 'mobile-tab-btn py-1.5 rounded-lg text-xs font-medium bg-surface-alt text-muted';
  });
  document.getElementById('panel-shelf').classList.toggle('active-mobile-tab', tab === 'shelf');
  document.getElementById('panel-bench').classList.toggle('active-mobile-tab', tab === 'bench');
  document.getElementById('panel-inspector').classList.toggle('active-mobile-tab', tab === 'inspector');
  if (tab === 'bench') {
    setTimeout(() => workbench.resize(), 30);
  }
}

function applyThemeAndDevice() {
  const isDark = appState.theme === 'dark';
  document.documentElement.setAttribute('data-theme', appState.theme);
  rootWrap.setAttribute('data-device', appState.deviceMode);
  workbench.setTheme(isDark);
  particles.setTheme(isDark);
  inspectorPanel.setTheme(isDark);
}

function refreshChrome(forceInspector = false) {
  const t = getTranslator();
  workbench.setLang(appState.lang);
  envBar.render(t);
  renderLabTabs(t);
  shelfPanel.render(t);
  inspectorPanel.update(appState.lang, forceInspector);

  if (benchHintEl) benchHintEl.textContent = t('pourBetweenHint');
  if (resetBtnEl) resetBtnEl.textContent = `↺ ${t('resetBench')}`;

  document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
    const tab = btn.dataset.tab;
    btn.textContent =
      tab === 'shelf' ? t('tabShelf') : tab === 'bench' ? t('tabBench') : t('tabInspector');
  });
}

// Wire mobile tabs & bench reset
document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMobileTab(btn.dataset.tab));
});

resetBtnEl?.addEventListener('click', () => {
  particles.clear();
  sim.setupPreset('clean');
  refreshChrome(true);
});

// Expose LabManager hook for automation / diagnostics
if (typeof window !== 'undefined') {
  window.__LAB_MANAGER__ = labManager;
}

// Initial boot
applyThemeAndDevice();
setMobileTab('bench');
refreshChrome(true);

// 60 FPS Animation & Physics Loop (active lab 60 FPS, background labs ~15 Hz batched)
let prevMs = performance.now();
let uiSyncAccum = 0;

function frame(nowMs) {
  const dt = Math.min(0.05, Math.max(0.001, (nowMs - prevMs) / 1000));
  prevMs = nowMs;
  lastFrameDt = dt;

  workbench.tickInteractivePour(dt);
  labManager.stepAllLabs(dt, () => renderLabTabs(getTranslator()));
  workbench.render(nowMs / 1000);

  // Sync live telemetry numbers at ~15 Hz so UI is snappy without over-rendering
  uiSyncAccum += dt;
  if (uiSyncAccum >= 0.066) {
    uiSyncAccum = 0;
    inspectorPanel.update(appState.lang, false);
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Register PWA Service Worker if supported (works on localhost & GitHub Pages HTTPS)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Ignore registration error in restricted preview contexts
    });
  });
}
