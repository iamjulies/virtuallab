import { I18N } from './data/i18n.js';
import { APPARATUS } from './data/apparatus.js';
import { STARTER_REAGENTS } from './data/species.js';
import { LabManager } from './engine/labManager.js';
import { LabWorkbenchCanvas, BENCH_FLOOR_Y } from './canvas/workbench.js';
import { EnvironmentBar } from './ui/environmentBar.js';
import { ShelfPanel } from './ui/shelfPanel.js';
import { InspectorPanel } from './ui/inspectorPanel.js';
import { DosingModal } from './ui/dosingModal.js';
import { ComparisonPanel } from './ui/comparisonPanel.js';
import { soundEngine } from './audio/soundEngine.js';
import {
  serializeWorkspace,
  deserializeWorkspace,
  serializeActiveBench,
  importBenchIntoNewTab,
  overwriteBenchAtIndex,
  saveToLocalStorage,
  loadFromLocalStorage,
  resetAllBenches,
  exportWorkspaceToFile,
  exportScopedVlabFile,
  readVlabFile,
  importWorkspaceFromFile,
  VLAB_SCOPES,
  cloudSync,
  initWorkspacePersistence,
} from './storage/workspaceStorage.js';
import { WorkspaceStorageModal } from './ui/workspaceStorageModal.js';
import { StorageCabinetModal } from './ui/storageCabinetModal.js';
import {
  ShortcutsModal,
  loadCustomShortcuts,
  normalizeKeyCombo,
} from './ui/shortcutsModal.js';
import { FloatingContextUI } from './ui/contextMenu.js';

const STORAGE_LANG_KEY = 'virlab_lang';
const STORAGE_THEME_KEY = 'virlab_theme';
const STORAGE_DEVICE_KEY = 'virlab_device';

const appState = {
  lang: localStorage.getItem(STORAGE_LANG_KEY) || 'vi',
  theme: localStorage.getItem(STORAGE_THEME_KEY) || 'dark',
  deviceMode: localStorage.getItem(STORAGE_DEVICE_KEY) || 'auto',
  soundEnabled: soundEngine.isEnabled(),
  cabinetCount: 0,
  viewingStorage: false,
  mobileTab: 'bench', // 'shelf' | 'bench' | 'inspector'
};

let shortcutTarget = 'canvas'; // 'canvas' | 'tab'
let renamingTabIndex = -1;
let lastRPressMs = 0;
const contextUI = new FloatingContextUI();

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
const compareBtnEl = document.getElementById('btn-compare-mode');
const compareRootEl = document.getElementById('comparison-panel-root');
const resetBtnEl = document.getElementById('btn-reset-bench');
const zoomLoupeBtnEl = document.getElementById('btn-zoom-loupe');
const zoomControlsEl = document.getElementById('canvas-zoom-controls');
const zoomOutBtnEl = document.getElementById('btn-zoom-out');
const zoomInBtnEl = document.getElementById('btn-zoom-in');
const zoomResetBtnEl = document.getElementById('btn-zoom-reset');
const zoomBadgeEl = document.getElementById('zoom-level-badge');
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
    const spd = activeLab.sim.environment.paused ? 0 : activeLab.sim.environment.speed;
    activeLab.particles.emitForVessel(vessel, metrics, lastFrameDt * spd);
  },
  onAlert: (_idx, type, vessel, meta) => {
    handleVisualAlert(type, vessel, meta);
  },
  onReagentDispense: (_v, reg, amt) => {
    if (reg?.kind === 'solid') {
      soundEngine.playGranuleCascade(Math.min(12, Math.max(4, Math.round(amt * 3))));
    } else if (amt <= 0.25) {
      soundEngine.playDropPlink();
    } else {
      soundEngine.playUiClick();
    }
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

let lastPetalCelebrateMs = 0;
function ensureLabSubscribed(lab) {
  if (!lab || subscribedSims.has(lab.sim)) return;
  subscribedSims.add(lab.sim);
  let lastLogCount = lab.sim.logs?.length || 0;
  lab.sim.subscribe(() => {
    const curCount = lab.sim.logs?.length || 0;
    if (curCount > lastLogCount && lab.sim === sim && appState.theme === 'petal') {
      const topLog = lab.sim.logs[0];
      const now = Date.now();
      if (topLog && (topLog.type === 'reaction' || topLog.key === 'alertSilverMirrorFormed') && now - lastPetalCelebrateMs > 5500) {
        lastPetalCelebrateMs = now;
        particles.spawnCelebrationPetals?.(16);
      }
    }
    lastLogCount = curCount;
    if (lab.sim === sim) refreshChrome();
    workspacePersistence?.triggerDebouncedSave();
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
  if ((burstType === 'shatter' || burstType === 'explosion') && appState.theme === 'sos') {
    particles.emitSosShatterWave(vessel.x, Math.min(BENCH_FLOOR_Y, vessel.y));
  }
  soundEngine.playAlertSound(type);
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
  } else if (type === 'crucible_lid_pop') {
    workbench.triggerShake(3.2, 0.16);
    showToast(`⚠️ ${t('alertCrucibleLidPop')}`);
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
  } else if (type === 'co2_extinguish') {
    showToast(t('alertCo2Extinguish'));
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
    onPick: (picked, pt) => {
      if (prevMobileTab && prevMobileTab !== 'bench') {
        setMobileTab(prevMobileTab);
      }
      opts.onPick?.(picked, pt);
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

const dosingModal = new DosingModal(
  modalEl,
  sim,
  getTranslator,
  (opts) => startBenchPick(opts),
  (targetId) => {
    const v = sim.getItem(targetId);
    if (!v || !workbench) return null;
    const sp = APPARATUS[v.typeId] || { width: 80, height: 110 };
    const tl = workbench.logicalToClient(v.x - sp.width / 2, v.y - sp.height / 2);
    const br = workbench.logicalToClient(v.x + sp.width / 2, v.y + sp.height / 2);
    return {
      left: tl.x,
      top: tl.y,
      width: Math.max(40, br.x - tl.x),
      height: Math.max(40, br.y - tl.y),
      centerX: (tl.x + br.x) * 0.5,
      centerY: (tl.y + br.y) * 0.5,
    };
  }
);

let dropZoneRectCache = null;

function clearDropZoneRectCache() {
  dropZoneRectCache = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', clearDropZoneRectCache, { passive: true });
  window.addEventListener('scroll', clearDropZoneRectCache, { passive: true, capture: true });
}

function getDropZoneRects() {
  if (dropZoneRectCache) return dropZoneRectCache;
  const tabZones = [];
  if (labTabsEl) {
    const storBtn = labTabsEl.querySelector('[data-storage-tab]');
    if (storBtn) {
      const r = storBtn.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) {
        tabZones.push({ btn: storBtn, idx: -1, storageTab: true, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
    }
    labTabsEl.querySelectorAll('.lab-tab-btn').forEach((btn) => {
      if (btn.dataset.labIndex === undefined) return;
      const idx = Number(btn.dataset.labIndex);
      if (idx === labManager.activeIndex || idx < 0 || idx >= labManager.labs.length) return;
      const r = btn.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) {
        tabZones.push({ btn, idx, storageTab: false, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
    });
  }

  const discardZones = [];
  const pushDiscard = (el, padLeft = 0, padRight = 0, padTop = 0, padBottom = 0, edgeMode = 'box') => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 10 || r.height <= 10) return;
    discardZones.push({ el, left: r.left - padLeft, right: r.right + padRight, top: r.top - padTop, bottom: r.bottom + padBottom, edgeMode });
  };
  pushDiscard(document.getElementById('panel-shelf'), 0, 12, 12, 12, 'left');
  pushDiscard(document.getElementById('panel-inspector'), 12, 0, 12, 12, 'right');
  pushDiscard(document.querySelector('.mobile-tab-btn[data-tab="shelf"]'));
  pushDiscard(document.querySelector('.mobile-tab-btn[data-tab="inspector"]'));

  dropZoneRectCache = { tabZones, discardZones };
  return dropZoneRectCache;
}

function findDropLabTab(clientX, clientY) {
  if (!labTabsEl || (!clientX && !clientY)) return null;
  const { tabZones } = getDropZoneRects();
  for (const tz of tabZones) {
    if (clientX >= tz.left && clientX <= tz.right && clientY >= tz.top && clientY <= tz.bottom) {
      return tz.storageTab ? { btn: tz.btn, idx: -1, storageTab: true } : { btn: tz.btn, idx: tz.idx };
    }
  }
  return null;
}

function clearLabDropHighlights(invalidateCache = false) {
  if (invalidateCache) dropZoneRectCache = null;
  labTabsEl?.querySelectorAll('.lab-tab-drop-target').forEach((el) => {
    el.classList.remove('lab-tab-drop-target');
  });
  document.getElementById('panel-shelf')?.classList.remove('shelf-discard-target');
  document.getElementById('panel-inspector')?.classList.remove('shelf-discard-target');
  document.querySelector('.mobile-tab-btn[data-tab="shelf"]')?.classList.remove('shelf-discard-target');
  document.querySelector('.mobile-tab-btn[data-tab="inspector"]')?.classList.remove('shelf-discard-target');
}

function isOverShelfDiscardZone(clientX, clientY) {
  if (!clientX && !clientY) return null;
  const { discardZones } = getDropZoneRects();
  for (const dz of discardZones) {
    if (dz.edgeMode === 'left') {
      if (clientX <= dz.right && clientY >= dz.top && clientY <= dz.bottom) return dz.el;
    } else if (dz.edgeMode === 'right') {
      if (clientX >= dz.left && clientY >= dz.top && clientY <= dz.bottom) return dz.el;
    } else if (clientX >= dz.left && clientX <= dz.right && clientY >= dz.top && clientY <= dz.bottom) {
      return dz.el;
    }
  }
  return null;
}

let lastSelectedKind = null;
workbench = new LabWorkbenchCanvas(canvasEl, sim, particles, {
  onSelect: (selectedItem) => {
    shortcutTarget = 'canvas';
    contextUI.closeMenu();
    const prevKind = lastSelectedKind;
    lastSelectedKind = selectedItem?.kind || null;
    inspectorPanel.update(appState.lang);
    if (selectedItem?.kind === 'pipette' || prevKind === 'pipette') {
      shelfPanel.render(getTranslator());
    }
  },
  onContextMenu: (clientX, clientY, logicalPt, hitItem) => {
    shortcutTarget = 'canvas';
    openCanvasContextMenu(clientX, clientY, logicalPt, hitItem);
  },
  onRequestDosing: (reagentId, vesselId) => {
    dosingModal.openReagent(reagentId, vesselId);
  },
  onExternalTabDragHover: (clientX, clientY, item) => {
    clearLabDropHighlights(!item);
    if (!item) return;
    const shelfHit = isOverShelfDiscardZone(clientX, clientY);
    if (shelfHit) {
      shelfHit.classList.add('shelf-discard-target');
      return;
    }
    const hit = findDropLabTab(clientX, clientY);
    if (hit) hit.btn.classList.add('lab-tab-drop-target');
  },
  onDropToLabTab: (clientX, clientY, item, dragItems = null) => {
    clearLabDropHighlights(true);
    const shelfHit = item ? isOverShelfDiscardZone(clientX, clientY) : null;
    if (shelfHit) {
      const toRemove = Array.isArray(dragItems) && dragItems.length > 0 ? dragItems : [item];
      let removedCount = 0;
      for (const rem of toRemove) {
        if (rem && sim.getItem(rem.id)) {
          sim.removeApparatus(rem.id);
          removedCount++;
        }
      }
      if (removedCount > 0) {
        const t = getTranslator();
        showToast(t('toastDiscardedShelf').replace('{count}', String(removedCount)));
        refreshChrome();
      }
      return true;
    }
    const hit = item ? findDropLabTab(clientX, clientY) : null;
    if (!hit) return false;
    if (hit.storageTab) {
      storeSelectedToCabinet(item.id);
      return true;
    }
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
  onZoomChange: (zState) => {
    syncZoomHud(zState);
  },
});

let comparisonPanel = null;

function syncCompareButton() {
  if (!compareBtnEl || !comparisonPanel) return;
  const t = getTranslator();
  const count = Array.isArray(sim?.compareVesselIds) ? sim.compareVesselIds.length : 0;
  compareBtnEl.textContent = count > 0 ? `${t('btnCompareMode')} (${count})` : t('btnCompareMode');
  compareBtnEl.classList.toggle('bg-accent', comparisonPanel.isOpen);
  compareBtnEl.classList.toggle('text-white', comparisonPanel.isOpen);
  compareBtnEl.classList.toggle('border-accent', comparisonPanel.isOpen);
}

function syncZoomHud(zState) {
  if (!zState) return;
  const t = getTranslator();
  const active = Boolean(zState.zoomMode || zState.zoomScale > 1.02);
  if (zoomLoupeBtnEl) {
    zoomLoupeBtnEl.classList.toggle('active', Boolean(zState.zoomMode));
    zoomLoupeBtnEl.title = t('btnZoomLoupeTitle');
  }
  if (zoomControlsEl) {
    zoomControlsEl.classList.toggle('hidden', !active);
  }
  if (zoomBadgeEl) {
    zoomBadgeEl.textContent = `${zState.zoomScale.toFixed(1)}×`;
  }
}

comparisonPanel = new ComparisonPanel(compareRootEl, sim, getTranslator, {
  onClose: () => {
    syncCompareButton();
    setTimeout(() => workbench.resize(), 20);
  },
});

function applyThemeChoice(nextTheme = null) {
  const order = ['dark', 'light', 'olivia', 'petal', 'ctrl', 'sos'];
  const target = order.includes(nextTheme)
    ? nextTheme
    : order[(order.indexOf(appState.theme) + 1) % order.length];
  appState.theme = target;
  localStorage.setItem(STORAGE_THEME_KEY, appState.theme);
  soundEngine.playUiClick();
  applyThemeAndDevice();
  refreshChrome(true);
  if (target === 'petal') {
    particles.spawnCelebrationPetals?.(14);
  }
  return target;
}

const THEME_OPTIONS = [
  { id: 'dark', icon: '🌙', key: 'themeDark' },
  { id: 'light', icon: '☀️', key: 'themeLight' },
  { id: 'olivia', icon: '🩷', key: 'themeOlivia' },
  { id: 'petal', icon: '🥀', key: 'themePetal' },
  { id: 'ctrl', icon: '📓', key: 'themeCtrl' },
  { id: 'sos', icon: '🌊', key: 'themeSos' },
];

let quickHoldMode = null;
let zHoldTimer = null;
let zHeldPopupShown = false;

function hideQuickHoldPopup() {
  if (zHoldTimer) {
    clearTimeout(zHoldTimer);
    zHoldTimer = null;
  }
  quickHoldMode = null;
  document.getElementById('chemlab-quick-hold-overlay')?.remove();
}

function showQuickHoldPopup(mode) {
  hideQuickHoldPopup();
  const t = getTranslator();
  quickHoldMode = mode;
  const wrap = document.createElement('div');
  wrap.id = 'chemlab-quick-hold-overlay';
  wrap.className = 'quick-hold-overlay';
  wrap.dataset.mode = mode;

  let title = '';
  let buttonsHtml = '';
  if (mode === 'theme') {
    title = t('quickThemesTitle');
    buttonsHtml = THEME_OPTIONS.map(
      (th) => `<button type="button" class="quick-hold-btn ${appState.theme === th.id ? 'active' : ''}" data-pick-theme="${th.id}">
        <span>${th.icon}</span><span class="truncate">${t(th.key)}</span>
      </button>`
    ).join('');
  } else {
    title = t('quickPresetsHoldTitle');
    const selOpts = Array.from(document.querySelectorAll('#preset-select option')).filter((o) => o.value);
    buttonsHtml = selOpts
      .map(
        (opt) => `<button type="button" class="quick-hold-btn" data-pick-preset="${opt.value}">
          <span class="truncate">${opt.textContent}</span>
        </button>`
      )
      .join('');
  }

  wrap.innerHTML = `
    <div class="quick-hold-card">
      <div class="flex items-center justify-between gap-2 pb-2 border-b border-theme">
        <div class="text-xs font-bold text-accent">${title}</div>
        <span class="text-[11px] font-mono text-muted">ESC</span>
      </div>
      <div class="quick-hold-grid">${buttonsHtml}</div>
    </div>
  `;

  wrap.addEventListener('click', (ev) => {
    const themeBtn = ev.target.closest?.('[data-pick-theme]');
    if (themeBtn) {
      applyThemeChoice(themeBtn.dataset.pickTheme);
      hideQuickHoldPopup();
      return;
    }
    const presetBtn = ev.target.closest?.('[data-pick-preset]');
    if (presetBtn) {
      const pName = presetBtn.dataset.pickPreset;
      hideQuickHoldPopup();
      particles.clear();
      soundEngine.playGlassClink('beaker_250', 0.7);
      sim.setupPreset(pName);
      if (pName === 'compare_rate_factors' || pName === 'compare_corrosion') {
        comparisonPanel?.setOpen(true);
      } else if (pName === 'clean') {
        comparisonPanel?.setOpen(false);
      }
      refreshChrome(true);
      setTimeout(() => workbench.resize(), 25);
      return;
    }
    if (ev.target === wrap) hideQuickHoldPopup();
  });

  document.body.appendChild(wrap);
}

const envBar = new EnvironmentBar(headerEl, sim, appState, {
  onLangChange: () => {
    appState.lang = appState.lang === 'vi' ? 'en' : 'vi';
    localStorage.setItem(STORAGE_LANG_KEY, appState.lang);
    refreshChrome(true);
  },
  onThemeChange: (nextTheme = null) => {
    applyThemeChoice(nextTheme);
  },
  onOpticsChange: (mode) => {
    soundEngine.playUiClick();
    sim.setOpticsMode?.(mode);
    refreshChrome();
  },
  onSoundToggle: () => {
    appState.soundEnabled = soundEngine.toggleEnabled();
    refreshChrome(true);
  },
  onOpenStorage: () => {
    soundEngine.playUiClick();
    storageModal.open();
  },
  onOpenCabinet: () => {
    soundEngine.playUiClick();
    if (cabinetModal.isOpen) cabinetModal.close();
    else cabinetModal.open();
    if (isMobileViewActive()) setMobileTab('bench');
  },
  onOpenShortcuts: () => {
    soundEngine.playUiClick();
    if (shortcutsModal.isOpen) shortcutsModal.close();
    else shortcutsModal.open();
  },
  onDeviceChange: (mode) => {
    appState.deviceMode = mode;
    localStorage.setItem(STORAGE_DEVICE_KEY, mode);
    soundEngine.playUiClick();
    applyThemeAndDevice();
    setTimeout(() => workbench.resize(), 40);
  },
  onPreset: (presetName) => {
    particles.clear();
    soundEngine.playGlassClink('beaker_250', 0.7);
    sim.setupPreset(presetName);
    if (presetName === 'compare_rate_factors' || presetName === 'compare_corrosion') {
      comparisonPanel?.setOpen(true);
    } else if (presetName === 'clean') {
      comparisonPanel?.setOpen(false);
    }
    refreshChrome(true);
    setTimeout(() => workbench.resize(), 25);
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
    soundEngine.playGlassClink(typeId, 0.85);
    if (isMobileViewActive()) {
      setMobileTab('bench');
    }
    refreshChrome();
  },
  onSelectReagent: (reagentId) => {
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
    if (!reg) return;
    const isSolidReg = reg.kind === 'solid';
    const validKind = (it) =>
      it &&
      !it.isShattered &&
      !it.isBroken &&
      (it.kind === 'vessel' ||
        it.kind === 'filter_funnel' ||
        it.kind === 'separatory_funnel' ||
        (it.kind === 'burette' && !isSolidReg) ||
        (it.kind === 'spoon' && isSolidReg));
    const candidates = sim.items.filter(validKind);
    if (candidates.length === 0) {
      // Auto-create a beaker so user isn't stuck
      const created = sim.createApparatus('beaker_250', 480, BENCH_FLOOR_Y - 70);
      dosingModal.openReagent(reagentId, created.id);
      return;
    }
    const t = getTranslator();
    startBenchPick({
      candidateIds: candidates.map((c) => c.id),
      promptText: `${t(reg.i18nKey)} (${reg.formula}) — ${t('pickBenchPrompt')}`,
      onPick: (picked) => {
        dosingModal.openReagent(reagentId, picked.id);
      },
    });
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
      const dropped = workbench.dropFromShelf(clampedX, clampedY, kind, id);
      if (isMobileViewActive()) setMobileTab('bench');
      if (dropped && kind !== 'apparatus') refreshChrome();
    } else {
      workbench.setExternalDropPreview(0, 0, null, null);
    }
  },
  onContextMenu: (clientX, clientY, payload) => {
    shortcutTarget = 'canvas';
    openShelfContextMenu(clientX, clientY, payload);
  },
});

const inspectorPanel = new InspectorPanel(inspectorEl, sim, getTranslator, {
  onEditStickyLabel: (vessel) => openStickyLabelEditor(vessel),
  onStoreToCabinet: (itemId) => storeSelectedToCabinet(itemId),
  onOpenTransfer: (sourceId) => {
    const others = sim.items.filter(
      (i) =>
        i.id !== sourceId &&
        !i.isShattered &&
        !i.isBroken &&
        (i.kind === 'vessel' || i.kind === 'filter_funnel' || i.kind === 'separatory_funnel' || i.kind === 'burette')
    );
    if (others.length === 0) return;
    const t = getTranslator();
    startBenchPick({
      candidateIds: others.map((o) => o.id),
      promptText: `${t('actionPourTo')} — ${t('pickBenchPrompt')}`,
      onPick: (picked) => dosingModal.openTransfer(sourceId, picked.id),
    });
  },
  onOpenSolidTransfer: (sourceId) => {
    const vessels = sim.items.filter((i) => i.id !== sourceId && i.kind === 'vessel' && !i.isShattered);
    if (vessels.length === 0) return;
    const t = getTranslator();
    startBenchPick({
      candidateIds: vessels.map((v) => v.id),
      promptText: `${t('actionPourTo')} — ${t('pickBenchPrompt')}`,
      onPick: (picked) => dosingModal.openSolidTransfer(sourceId, picked.id),
    });
  },
  onOpenTubeTarget: (sourceId) => dosingModal.openTubeTarget(sourceId),
  onOpenSyringeTransfer: (syringeId) => dosingModal.openSyringeTransfer(syringeId),
  onStartBenchPick: (opts) => startBenchPick(opts),
  onOpenCompare: () => {
    comparisonPanel?.setOpen(true);
    comparisonPanel?.render(true);
    syncCompareButton();
    setTimeout(() => workbench.resize(), 20);
  },
  onNotify: (msg) => showToast(msg),
  onShowReactionInfo: (rxn) => {
    if (!rxn) return;
    document.getElementById('chemlab-rxn-info-modal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'chemlab-rxn-info-modal';
    wrap.className = 'storage-modal-backdrop';
    const rxnWikiQ = encodeURIComponent((rxn.nameStr || rxn.equation || 'chemical reaction').replace(/[→⇌()↑↓·]/g, ' ').trim());
    wrap.innerHTML = `
      <div class="storage-modal-card" style="max-width:460px;">
        <div class="flex items-center justify-between gap-2 pb-2 border-b border-theme">
          <h2 class="text-sm font-bold">${rxn.title || 'Reaction Info'}</h2>
          <button type="button" id="rxn-modal-close" class="px-2 py-0.5 rounded border border-theme text-xs">✕</button>
        </div>
        <div class="flex flex-col gap-2 py-2 text-xs">
          <div class="p-2 rounded-lg bg-surface-alt border border-theme font-mono font-bold text-accent">${rxn.equation || ''}</div>
          <div class="font-semibold">${rxn.nameStr || ''}</div>
          ${rxn.rateMolS ? `<div class="text-muted font-mono">${getTranslator()('rxnRateLabel')}: ${(rxn.rateMolS * 1000).toFixed(3)} mmol/s</div>` : ''}
          ${rxn.descStr ? `<p class="text-muted leading-relaxed">${rxn.descStr}</p>` : ''}
          <div class="pt-1 flex items-center gap-2">
            <a href="https://en.wikipedia.org/w/index.php?search=${rxnWikiQ}" target="_blank" rel="noopener noreferrer" class="storage-btn text-xs" style="text-decoration:none;">🌐 Wikipedia ↗</a>
          </div>
        </div>
      </div>
    `;
    wrap.addEventListener('click', (ev) => {
      if (ev.target === wrap || ev.target.id === 'rxn-modal-close') wrap.remove();
    });
    document.body.appendChild(wrap);
  },
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
  const isDark = appState.theme === 'dark' || appState.theme === 'petal' || appState.theme === 'sos';
  particles.setTheme(isDark);
  workbench.setTheme?.(isDark, appState.theme);
  workbench.setSim(sim, particles);
  envBar.setSim(sim);
  shelfPanel.setSim(sim);
  inspectorPanel.setSim(sim);
  dosingModal.setSim(sim);
  comparisonPanel?.setSim(sim);
}

function getLabTitle(lab, t = getTranslator()) {
  if (!lab) return `${t('labTabPrefix')} 1`;
  return lab.customName && lab.customName.trim() ? lab.customName.trim() : `${t('labTabPrefix')} ${lab.number}`;
}

function startRenameLabTab(idx) {
  if (idx < 0 || idx >= labManager.labs.length) return;
  renamingTabIndex = idx;
  shortcutTarget = 'tab';
  lastLabTabSig = '';
  renderLabTabs(getTranslator());
  const inp = labTabsEl?.querySelector('.lab-tab-rename-input');
  if (inp) {
    inp.focus();
    inp.select();
  }
}

function promptExportSingleBench(targetIndex = labManager.activeIndex) {
  const prevIdx = labManager.activeIndex;
  if (targetIndex !== prevIdx && targetIndex >= 0 && targetIndex < labManager.labs.length) {
    labManager.switchLab(targetIndex);
  }
  const t = getTranslator();
  const activeLab = labManager.getActiveLab();
  const defName = activeLab?.customName || `ban-${activeLab?.number || 1}`;
  contextUI.showExportNameDialog(defName, t, appState.lang, (customName) => {
    const fname = exportScopedVlabFile(VLAB_SCOPES.SINGLE_BENCH, labManager, {
      customName,
      langCode: appState.lang,
    });
    if (fname) {
      soundEngine.playUiClick();
      showToast(`📤 ${t('toastExportedVlab')} (${fname})`);
    }
  });
}

async function handleImportVlabFile(file) {
  const t = getTranslator();
  const { scope, data } = await readVlabFile(file);
  if (scope === VLAB_SCOPES.STORAGE_CABINET) {
    const added = labManager.mergeStorageCabinet(data.storageCabinet || []);
    saveToLocalStorage(labManager);
    soundEngine.playUiClick();
    refreshChrome(true);
    showToast(`📥 ${t('toastImportedVlab')} (+${added})`);
    return;
  }
  if (scope === VLAB_SCOPES.FULL_LAB) {
    contextUI.showConfirmDialog(
      {
        title: t('confirmFullLabTitle'),
        desc: t('confirmFullLabDesc'),
        confirmLabel: t('ctxPaste'),
        cancelLabel: t('btnClose'),
        danger: true,
      },
      () => {
        deserializeWorkspace(labManager, data);
        for (const lb of labManager.labs) ensureLabSubscribed(lb);
        saveToLocalStorage(labManager);
        soundEngine.playGlassClink('beaker_250', 0.85);
        syncActiveLabRefs();
        refreshChrome(true);
        showToast(`📥 ${t('toastImportedVlab')}`);
      }
    );
    return;
  }
  const res = importBenchIntoNewTab(labManager, data, { allowOverwriteChooser: true });
  if (res?.needsOverwriteChooser) {
    contextUI.showOverwriteBenchChooser(
      labManager.labs,
      (lb) => getLabTitle(lb, t),
      t,
      (pickedIdx) => {
        overwriteBenchAtIndex(labManager, pickedIdx, res.benchPayload);
        for (const lb of labManager.labs) ensureLabSubscribed(lb);
        soundEngine.playGlassClink('beaker_250', 0.85);
        syncActiveLabRefs();
        refreshChrome(true);
        showToast(`📥 ${t('toastImportedVlab')}`);
      }
    );
    return;
  }
  if (res?.ok) {
    for (const lb of labManager.labs) ensureLabSubscribed(lb);
    soundEngine.playGlassClink('beaker_250', 0.85);
    syncActiveLabRefs();
    refreshChrome(true);
    showToast(`📥 ${t('toastImportedVlab')}`);
  }
}

function openStickyLabelEditor(vessel) {
  if (!vessel) return;
  const t = getTranslator();
  contextUI.showStickyLabelDialog(vessel, t, appState.lang, (stickyLabel) => {
    sim.recordUndo?.();
    if (stickyLabel && stickyLabel.text) {
      vessel.stickyLabel = stickyLabel;
    } else {
      delete vessel.stickyLabel;
    }
    sim.emitChange();
    refreshChrome(true);
    showToast(t('stickyLabelSavedToast'));
  });
}

function storeSelectedToCabinet(itemId) {
  if (!itemId) return;
  const t = getTranslator();
  const entry = labManager.storeItemToCabinet(itemId, sim);
  if (entry) {
    saveToLocalStorage(labManager);
    soundEngine.playUiClick();
    refreshChrome(true);
    showToast(t('cabinetStoredToast'));
  }
}

function emptyVesselContents(vessel) {
  if (!vessel) return;
  sim.recordUndo?.();
  if (vessel.kind === 'vessel') {
    sim.rinseVessel(vessel.id);
  } else if (vessel.kind === 'pipette') {
    vessel.volumeMl = 0;
    vessel.moles = {};
    sim.emitChange();
  } else if (vessel.kind === 'spoon') {
    sim.rinseSpoon(vessel.id);
  }
  soundEngine.playWaterRinse();
  refreshChrome(true);
}

function getPasteTargetOpts() {
  const pt = workbench?.pointerLogical;
  if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
    return { targetX: pt.x, targetY: pt.y };
  }
  return {};
}

function runUndoAction() {
  const t = getTranslator();
  const ok = labManager.undo(sim);
  if (ok) {
    soundEngine.playUndoWhoosh();
    workbench.setSelection(Array.from(sim.selectedIds || []), sim.selectedId);
    showToast(t('toastUndoSuccess'));
    refreshChrome(true);
  } else {
    showToast(t('toastUndoEmpty'));
  }
}

function runSelectAllAction() {
  soundEngine.playUiClick();
  const allIds = sim.items.map((it) => it.id);
  sim.selectedIds = new Set(allIds);
  sim.selectedId = allIds[allIds.length - 1] || null;
  sim.emitChange();
  refreshChrome();
}

function runCopyAction() {
  const t = getTranslator();
  if (shortcutTarget === 'tab') {
    if (labManager.copyLab(labManager.activeIndex)) {
      soundEngine.playUiClick();
      showToast(`📋 ${getLabTitle(labManager.getActiveLab(), t)}`);
    }
    return true;
  }
  const ids = sim.selectedIds?.size > 0 ? sim.selectedIds : sim.selectedId ? [sim.selectedId] : [];
  const count = labManager.copyItems(ids, sim);
  if (count > 0) {
    soundEngine.playUiClick();
    showToast(t('toastCopiedApparatus').replace('{count}', String(count)));
    return true;
  }
  return false;
}

function runCutAction() {
  const t = getTranslator();
  if (shortcutTarget === 'tab') {
    if (labManager.cutLab(labManager.activeIndex)) {
      soundEngine.playTrashCrumple();
      for (const lb of labManager.labs) ensureLabSubscribed(lb);
      syncActiveLabRefs();
      refreshChrome(true);
    }
    return true;
  }
  const ids = sim.selectedIds?.size > 0 ? sim.selectedIds : sim.selectedId ? [sim.selectedId] : [];
  const count = labManager.cutItems(ids, sim);
  if (count > 0) {
    soundEngine.playTrashCrumple();
    workbench.setSelection([], null);
    showToast(t('toastCutApparatus').replace('{count}', String(count)));
    refreshChrome(true);
    return true;
  }
  return false;
}

function runPasteAction(includeChemicals = true, cursorPt = null) {
  const t = getTranslator();
  if (shortcutTarget === 'tab' && includeChemicals) {
    const res = labManager.pasteLab();
    if (res.ok) {
      ensureLabSubscribed(res.lab);
      soundEngine.playGlassClink('beaker_250', 0.75);
      syncActiveLabRefs();
      refreshChrome(true);
      return true;
    }
    if (res.reason === 'max_labs') {
      showToast(`⚠️ ${t('labMaxLimit')}`);
    }
    return false;
  }
  const opts = cursorPt && Number.isFinite(cursorPt.x)
    ? { includeChemicals, targetX: cursorPt.x, targetY: cursorPt.y }
    : { includeChemicals, ...getPasteTargetOpts() };
  const pasted = labManager.pasteItems(sim, opts);
  if (pasted.length > 0) {
    soundEngine.playGlassClink(pasted[0]?.typeId || 'beaker_250', 0.75);
    showToast(t(includeChemicals ? 'toastPastedApparatus' : 'toastPastedEmptyApparatus').replace('{count}', String(pasted.length)));
    refreshChrome();
    return true;
  }
  return false;
}

function confirmResetAllBenches() {
  const t = getTranslator();
  contextUI.showConfirmDialog(
    {
      title: t('confirmResetAllTitle'),
      desc: t('confirmResetAllDesc'),
      confirmLabel: `${t('storageBtnResetAll')} (Enter)`,
      cancelLabel: `${t('btnClose')} (Esc)`,
      danger: true,
    },
    () => {
      soundEngine.playTrashCrumple();
      resetAllBenches(labManager);
      for (const lb of labManager.labs) ensureLabSubscribed(lb);
      syncActiveLabRefs();
      refreshChrome(true);
      showToast(`🔄 ${t('toastResetAllBenches')}`);
    }
  );
}

function openCanvasContextMenu(clientX, clientY, logicalPt, hitItem) {
  const t = getTranslator();
  const hasClipboard = Array.isArray(labManager.clipboard) && labManager.clipboard.length > 0;
  const hasUndo = Array.isArray(sim.undoStack) && sim.undoStack.length > 0;
  if (!hitItem) {
    contextUI.showMenu(clientX, clientY, [
      { label: t('ctxPaste'), shortcut: 'Ctrl+V', disabled: !hasClipboard, onClick: () => runPasteAction(true, logicalPt) },
      { label: t('ctxPasteEmpty'), shortcut: 'Ctrl+Shift+V', disabled: !hasClipboard, onClick: () => runPasteAction(false, logicalPt) },
      { separator: true },
      { label: t('ctxSelectAll'), shortcut: 'Ctrl+A', disabled: sim.items.length === 0, onClick: () => runSelectAllAction() },
      { label: t('ctxUndo'), shortcut: 'Ctrl+Z', disabled: !hasUndo, onClick: () => runUndoAction() },
    ]);
    return;
  }

  const moveSubmenu = labManager.labs
    .map((lb, idx) =>
      idx === labManager.activeIndex
        ? null
        : {
            label: getLabTitle(lb, t),
            onClick: () => {
              const moved = labManager.moveItemBetweenLabs(hitItem.id, labManager.activeIndex, idx);
              if (moved) {
                showToast(`📤 ${t('labMovedToast').replace('{lab}', getLabTitle(moved.dstLab, t))}`);
              }
            },
          }
    )
    .filter(Boolean);

  contextUI.showMenu(clientX, clientY, [
    { label: t('ctxCopy'), shortcut: 'Ctrl+C', onClick: () => runCopyAction() },
    { label: t('ctxCut'), shortcut: 'Ctrl+X', onClick: () => runCutAction() },
    { label: t('ctxPaste'), shortcut: 'Ctrl+V', disabled: !hasClipboard, onClick: () => runPasteAction(true, logicalPt) },
    { label: t('ctxPasteEmpty'), shortcut: 'Ctrl+Shift+V', disabled: !hasClipboard, onClick: () => runPasteAction(false, logicalPt) },
    { label: t('ctxSelectAll'), shortcut: 'Ctrl+A', onClick: () => runSelectAllAction() },
    { label: t('ctxUndo'), shortcut: 'Ctrl+Z', disabled: !hasUndo, onClick: () => runUndoAction() },
    { separator: true },
    {
      label: t('ctxEmptyVessel'),
      disabled: !(hitItem.kind === 'vessel' || hitItem.kind === 'pipette' || hitItem.kind === 'spoon'),
      onClick: () => emptyVesselContents(hitItem),
    },
    ...(moveSubmenu.length > 0 ? [{ label: t('ctxMoveToBench'), submenu: moveSubmenu }] : []),
    ...(hitItem.kind === 'vessel' ? [{ label: t('ctxStickyLabel'), onClick: () => openStickyLabelEditor(hitItem) }] : []),
    ...(APPARATUS[hitItem.typeId]?.flippable || APPARATUS[hitItem.typeId]?.hasTwoEnds
      ? [{ label: t('ctxFlipLR'), onClick: () => { soundEngine.playUiClick(); sim.flipItemLR(hitItem.id); } }]
      : []),
    ...(APPARATUS[hitItem.typeId]?.invertible
      ? [{ label: t('ctxInvertVessel'), onClick: () => { soundEngine.playUiClick(); sim.toggleVesselInverted(hitItem.id); } }]
      : []),
    { label: t('ctxStoreCabinet'), onClick: () => storeSelectedToCabinet(hitItem.id) },
    { separator: true },
    {
      label: t('ctxInfo'),
      onClick: () => contextUI.showInfoModal({ kind: 'item', item: hitItem }, t, appState.lang),
    },
  ]);
}

function openShelfContextMenu(clientX, clientY, payload) {
  const t = getTranslator();
  const hasUndo = Array.isArray(sim.undoStack) && sim.undoStack.length > 0;
  if (payload.kind === 'shelf_apparatus') {
    contextUI.showMenu(clientX, clientY, [
      {
        label: t('ctxCopy'),
        shortcut: 'Ctrl+C',
        onClick: () => {
          labManager.clipboard = [{ typeId: payload.typeId, dx: 0, dy: 0, anchorX: 420, anchorY: 360 }];
          labManager.pasteSequence = 0;
          soundEngine.playUiClick();
          showToast(t('toastCopiedApparatus').replace('{count}', '1'));
        },
      },
      { label: t('ctxUndo'), shortcut: 'Ctrl+Z', disabled: !hasUndo, onClick: () => runUndoAction() },
      { separator: true },
      {
        label: t('ctxInfo'),
        onClick: () => contextUI.showInfoModal({ kind: 'shelf_apparatus', typeId: payload.typeId }, t, appState.lang),
      },
    ]);
  } else if (payload.kind === 'shelf_reagent') {
    contextUI.showMenu(clientX, clientY, [
      { label: t('ctxUndo'), shortcut: 'Ctrl+Z', disabled: !hasUndo, onClick: () => runUndoAction() },
      { separator: true },
      {
        label: t('ctxInfo'),
        onClick: () => contextUI.showInfoModal({ kind: 'reagent', reagentId: payload.reagentId }, t, appState.lang),
      },
    ]);
  }
}

function openTabContextMenu(clientX, clientY, idx) {
  const t = getTranslator();
  const canDelete = labManager.labs.length > 1;
  const hasTabClip = Boolean(labManager.tabClipboard);
  shortcutTarget = 'tab';
  if (idx !== labManager.activeIndex) {
    labManager.switchLab(idx);
  }
  contextUI.showMenu(clientX, clientY, [
    { label: t('ctxExportVlab'), shortcut: 'Ctrl+E', onClick: () => promptExportSingleBench(idx) },
    { separator: true },
    {
      label: t('ctxCopy'),
      shortcut: 'Ctrl+C',
      onClick: () => {
        labManager.copyLab(idx);
        soundEngine.playUiClick();
        showToast(`📋 ${getLabTitle(labManager.labs[idx], t)}`);
      },
    },
    {
      label: t('ctxCut'),
      shortcut: 'Ctrl+X',
      onClick: () => {
        labManager.cutLab(idx);
        soundEngine.playTrashCrumple();
        for (const lb of labManager.labs) ensureLabSubscribed(lb);
        syncActiveLabRefs();
        refreshChrome(true);
      },
    },
    {
      label: t('ctxPaste'),
      shortcut: 'Ctrl+V',
      disabled: !hasTabClip,
      onClick: () => {
        shortcutTarget = 'tab';
        runPasteAction(true);
      },
    },
    { label: t('ctxRenameTab'), shortcut: 'F2', onClick: () => startRenameLabTab(idx) },
    { separator: true },
    {
      label: t('ctxDeleteTab'),
      shortcut: 'Del',
      danger: true,
      disabled: !canDelete,
      onClick: () => labManager.removeLab(idx),
    },
  ]);
}

let lastLabTabSig = '';
let labTabsDelegated = false;

function ensureLabTabsDelegation() {
  if (labTabsDelegated || !labTabsEl) return;
  labTabsDelegated = true;

  labTabsEl.addEventListener('click', async (e) => {
    const t = getTranslator();
    const closeEl = e.target.closest?.('[data-close-lab]');
    if (closeEl) {
      e.stopPropagation();
      labManager.removeLab(Number(closeEl.dataset.closeLab));
      return;
    }
    const storBtn = e.target.closest?.('[data-storage-tab]');
    if (storBtn) {
      soundEngine.playUiClick();
      cabinetModal.open();
      if (isMobileViewActive()) setMobileTab('bench');
      return;
    }
    const tabBtn = e.target.closest?.('.lab-tab-btn[data-lab-index]');
    if (tabBtn) {
      if (renamingTabIndex >= 0) return;
      const idx = Number(tabBtn.dataset.labIndex);
      shortcutTarget = 'tab';
      if (cabinetModal.isOpen) cabinetModal.close();
      labManager.switchLab(idx);
      workspacePersistence?.triggerDebouncedSave();
      if (cloudSync.user && cloudSync.dirtySinceCloudSave) {
        cloudSync.saveWorkspaceToCloud(labManager).catch(() => {});
      }
      return;
    }
    if (e.target.closest?.('#btn-add-lab')) {
      if (cabinetModal.isOpen) cabinetModal.close();
      const res = labManager.addLab('starter');
      if (!res.ok) {
        showToast(`⚠️ ${t('labMaxLimit')}`);
      } else {
        ensureLabSubscribed(res.lab);
      }
      return;
    }
    if (e.target.closest?.('#btn-export-vlab-bar')) {
      soundEngine.playUiClick();
      promptExportSingleBench(labManager.activeIndex);
      return;
    }
    if (e.target.closest?.('#btn-import-vlab-bar')) {
      soundEngine.playUiClick();
      labTabsEl.querySelector('#input-import-vlab-bar')?.click();
      return;
    }
    if (e.target.closest?.('#btn-cloud-save-bar')) {
      soundEngine.playUiClick();
      saveToLocalStorage(labManager);
      storageModal.setLastAutoSaveTime(Date.now());
      if (!cloudSync.user) {
        storageModal.open('login');
        showToast(`🔑 ${t('toastCloudCredentialsHint')}`);
        return;
      }
      try {
        await cloudSync.saveWorkspaceToCloud(labManager);
        showToast(`☁️ ${t('toastCloudSaved')}`);
      } catch (err) {
        if (err?.message === 'CLOUD_PERMISSION_DENIED' || err?.code === 'permission-denied') {
          storageModal.open('auth');
          storageModal._renderPermissionError?.(t);
          showToast(`⚠️ ${t('toastCloudPermissionErr')}`);
        } else {
          showToast(`⚠️ ${err.message || t('toastCloudError')}`);
        }
      }
      return;
    }
    if (e.target.closest?.('#btn-share-code-bar')) {
      soundEngine.playUiClick();
      storageModal.open('share');
      return;
    }
    if (e.target.closest?.('#btn-auth-open')) {
      soundEngine.playUiClick();
      storageModal.open('auth');
      return;
    }
    if (e.target.closest?.('#btn-reset-all-bar')) {
      confirmResetAllBenches();
    }
  });

  labTabsEl.addEventListener('dblclick', (e) => {
    const tabBtn = e.target.closest?.('.lab-tab-btn[data-lab-index]');
    if (!tabBtn) return;
    e.stopPropagation();
    startRenameLabTab(Number(tabBtn.dataset.labIndex));
  });

  labTabsEl.addEventListener('contextmenu', (e) => {
    const tabBtn = e.target.closest?.('.lab-tab-btn[data-lab-index]');
    if (!tabBtn) return;
    e.preventDefault();
    e.stopPropagation();
    openTabContextMenu(e.clientX, e.clientY, Number(tabBtn.dataset.labIndex));
  });

  labTabsEl.addEventListener('change', async (e) => {
    if (e.target?.id !== 'input-import-vlab-bar') return;
    const t = getTranslator();
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await handleImportVlabFile(file);
    } catch (err) {
      showToast(`⚠️ ${t('toastImportFailed')}: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });
}

function renderLabTabs(t) {
  if (!labTabsEl) return;
  ensureLabTabsDelegation();
  const userEmail = cloudSync.user?.email || '';
  const cabLen = Array.isArray(labManager?.storageCabinet) ? labManager.storageCabinet.length : 0;
  const sig = `${appState.lang}|${userEmail}|${shortcutTarget}|${renamingTabIndex}|${appState.viewingStorage ? 1 : 0}|${cabLen}|${labManager.activeIndex}|${labManager.labs
    .map((lb) => `${lb.id}:${lb.customName || ''}:${lb.sim.items.length}:${lb.sim.environment.atmosphereMode}:${(lb.unreadAlerts || 0) > 0 ? 1 : 0}`)
    .join(',')}`;
  if (sig === lastLabTabSig) return;
  lastLabTabSig = sig;

  const canClose = labManager.labs.length > 1;
  const atMax = labManager.labs.length >= labManager.maxLabs;
  const storageTabHtml = `<button type="button" id="btn-tab-storage" data-storage-tab="true" class="lab-tab-btn storage-tab-btn ${appState.viewingStorage ? 'active' : ''}" title="${t('cabinetBtnTip')}">
    🗄️ <span>${t('cabinetBtnLabel')}</span>
    <span class="text-[10px] opacity-85 font-mono">(${cabLen})</span>
  </button>`;
  const tabsHtml = labManager.labs
    .map((lb, idx) => {
      const isActive = !appState.viewingStorage && idx === labManager.activeIndex;
      const atmIcon = lb.sim.environment.atmosphereMode === 'inert' ? '🛡️' : '🌬️';
      const dotHtml = !isActive && (lb.unreadAlerts || 0) > 0
        ? `<span class="w-2 h-2 rounded-full bg-amber-400" title="${lb.unreadAlerts}"></span>`
        : '';
      const closeBtn = canClose
        ? `<span class="lab-tab-close" data-close-lab="${idx}" title="${t('labCloseTip')}">×</span>`
        : '';
      const isRenaming = idx === renamingTabIndex;
      const titleHtml = isRenaming
        ? `<input type="text" class="lab-tab-rename-input" value="${getLabTitle(lb, t).replace(/"/g, '&quot;')}" maxlength="40" />`
        : `<span>${atmIcon} ${getLabTitle(lb, t)}</span>`;
      return `<button type="button" class="lab-tab-btn ${isActive ? 'active' : ''}" data-lab-index="${idx}" title="${t('labDropMoveHint')}">
        ${titleHtml}
        <span class="text-[10px] opacity-80 font-mono">(${lb.sim.items.length})</span>
        ${dotHtml}
        ${closeBtn}
      </button>`;
    })
    .join('');

  labTabsEl.innerHTML = `
    ${storageTabHtml}
    ${tabsHtml}
    <button type="button" id="btn-add-lab" class="lab-add-btn" ${atMax ? 'disabled' : ''} title="${atMax ? t('labMaxLimit') : ''}">
      ${t('labAddBtn')} (${labManager.labs.length}/${labManager.maxLabs})
    </button>

    <!-- Prominent 3-Layer Persistence, .vlab Export/Import & Cloud Auth Toolbar -->
    <div class="lab-persistence-group">
      <button type="button" id="btn-export-vlab-bar" class="lab-persist-btn vlab-btn" title="${t('storageBtnExportVlab')}">
        📤 ${t('barExportVlabBtn')}
      </button>
      <button type="button" id="btn-import-vlab-bar" class="lab-persist-btn vlab-btn" title="${t('storageBtnImportVlab')}">
        📥 ${t('barImportVlabBtn')}
      </button>
      <input type="file" id="input-import-vlab-bar" accept=".vlab,.json,application/json" class="hidden" />
      <button type="button" id="btn-cloud-save-bar" class="lab-persist-btn cloud-btn" title="${t('storageBtnCloudSave')}">
        ☁️ ${t('barCloudSaveBtn')}
      </button>
      <button type="button" id="btn-share-code-bar" class="lab-persist-btn cloud-btn" title="${t('storageShareTitle')}">
        🔗 ${t('barShareCodeBtn')}
      </button>
      <button type="button" id="btn-auth-open" class="lab-persist-btn auth-btn ${userEmail ? 'signed-in' : ''}" title="${t('storageLayer3Title')}">
        ${userEmail ? `🟢 ${userEmail}` : `👤 ${t('barAuthBtn')}`}
      </button>
      <button type="button" id="btn-reset-all-bar" class="lab-persist-btn reset-all-btn" title="${t('storageBtnResetAll')}">
        🔄 ${t('barResetAllBtn')}
      </button>
    </div>
  `;

  if (renamingTabIndex >= 0) {
    const renInp = labTabsEl.querySelector('.lab-tab-rename-input');
    const commitRename = (save) => {
      const targetIdx = renamingTabIndex;
      renamingTabIndex = -1;
      if (save && renInp) {
        labManager.renameLab(targetIdx, renInp.value);
        saveToLocalStorage(labManager);
      } else {
        lastLabTabSig = '';
        renderLabTabs(t);
      }
    };
    renInp?.addEventListener('click', (e) => e.stopPropagation());
    renInp?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commitRename(true);
      else if (e.key === 'Escape') commitRename(false);
    });
    renInp?.addEventListener('blur', () => commitRename(true));
  }
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
  const isDark = appState.theme === 'dark' || appState.theme === 'petal' || appState.theme === 'sos';
  document.documentElement.setAttribute('data-theme', appState.theme);
  rootWrap.setAttribute('data-device', appState.deviceMode);
  workbench.setTheme(isDark, appState.theme);
  particles.setTheme(isDark);
  inspectorPanel.setTheme(isDark);
}

let lastEnvBarSig = '';
function refreshChrome(forceInspector = false) {
  const t = getTranslator();
  appState.cabinetCount = Array.isArray(labManager?.storageCabinet) ? labManager.storageCabinet.length : 0;
  workbench.setLang(appState.lang);
  const env = sim.environment || {};
  const envSig = `${appState.lang}|${appState.theme}|${appState.deviceMode}|${appState.soundEnabled ? 1 : 0}|${appState.cloudSignedIn ? 1 : 0}|${appState.cabinetCount}|${Math.round((env.tempK || 298.15) * 10)}|${Math.round((env.pressureBar || 1) * 100)}|${env.speed}|${env.paused ? 1 : 0}|${env.uvLight ? 1 : 0}|${env.atmosphereMode}|${env.opticsMode || 'normal'}`;
  if (forceInspector || envSig !== lastEnvBarSig) {
    lastEnvBarSig = envSig;
    envBar.render(t);
  }
  renderLabTabs(t);
  shelfPanel.render(t);
  inspectorPanel.update(appState.lang, forceInspector);
  comparisonPanel?.render(forceInspector);
  if (cabinetModal?.isOpen) cabinetModal.render();
  syncCompareButton();
  syncZoomHud(workbench.getZoomState());

  if (benchHintEl) benchHintEl.textContent = t('pourBetweenHint');
  if (resetBtnEl) resetBtnEl.textContent = `↺ ${t('resetBench')}`;

  document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
    const tab = btn.dataset.tab;
    btn.textContent =
      tab === 'shelf' ? t('tabShelf') : tab === 'bench' ? t('tabBench') : t('tabInspector');
  });
}

// Wire mobile tabs & bench reset & compare & zoom loupe
document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMobileTab(btn.dataset.tab));
});

compareBtnEl?.addEventListener('click', () => {
  comparisonPanel?.toggleOpen();
  syncCompareButton();
  setTimeout(() => workbench.resize(), 20);
});

zoomLoupeBtnEl?.addEventListener('click', () => {
  workbench.toggleZoomMode();
});

zoomInBtnEl?.addEventListener('click', () => {
  const s = workbench.getZoomState();
  workbench.setZoomView(s.zoomScale * 1.35, s.zoomCenterX, s.zoomCenterY);
});

zoomOutBtnEl?.addEventListener('click', () => {
  const s = workbench.getZoomState();
  workbench.setZoomView(s.zoomScale / 1.35, s.zoomCenterX, s.zoomCenterY);
});

zoomResetBtnEl?.addEventListener('click', () => {
  workbench.resetZoom();
});

resetBtnEl?.addEventListener('click', () => {
  particles.clear();
  comparisonPanel?.setOpen(false);
  sim.setupPreset('clean');
  refreshChrome(true);
});

// Customizable Keyboard Shortcuts Registry & Modal
let shortcutBindings = loadCustomShortcuts();
const shortcutsModal = new ShortcutsModal(getTranslator, () => shortcutBindings, {
  onUpdateBindings: (next) => {
    shortcutBindings = next;
  },
  onNotify: (msg) => showToast(msg),
});

function findActionByCombo(combo) {
  if (!combo) return null;
  for (const [actionId, bound] of Object.entries(shortcutBindings)) {
    if (bound === combo) return actionId;
  }
  return null;
}

function getBaseKeyOfAction(actionId) {
  const combo = shortcutBindings[actionId] || '';
  const parts = combo.split('+');
  return parts[parts.length - 1] || '';
}

window.addEventListener('blur', () => {
  zHeldPopupShown = false;
  hideQuickHoldPopup();
});

window.addEventListener('keyup', (e) => {
  if (shortcutsModal?.isOpen && shortcutsModal?.capturingId) return;
  const combo = normalizeKeyCombo(e);
  const baseKey = combo ? combo.split('+').pop() : '';
  const themeBase = getBaseKeyOfAction('theme_key');
  const presetBase = getBaseKeyOfAction('hold_presets');

  if (baseKey && baseKey === themeBase && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (zHoldTimer) {
      clearTimeout(zHoldTimer);
      zHoldTimer = null;
    }
    if (zHeldPopupShown || quickHoldMode === 'theme') {
      zHeldPopupShown = false;
      hideQuickHoldPopup();
    } else if (!e.shiftKey) {
      const next = applyThemeChoice();
      const thObj = THEME_OPTIONS.find((x) => x.id === next);
      showToast(`🎨 ${thObj ? getTranslator()(thObj.key) : next}`);
    }
  } else if (baseKey && baseKey === presetBase && quickHoldMode === 'preset') {
    hideQuickHoldPopup();
  }
});

window.addEventListener('keydown', (e) => {
  if (shortcutsModal?.isOpen && shortcutsModal?.capturingId) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) {
    return;
  }

  if (e.key === 'Escape') {
    zHeldPopupShown = false;
    hideQuickHoldPopup();
    shortcutsModal?.close();
    contextUI.closeMenu();
    contextUI.closeDialog();
    cabinetModal?.close();
    storageModal?.close();
    dosingModal?.close();
    workbench?.cancelItemPick();
    return;
  }

  const combo = normalizeKeyCombo(e);
  const action = findActionByCombo(combo);
  const anyModalOpen =
    (modalEl && !modalEl.classList.contains('hidden')) ||
    cabinetModal?.isOpen ||
    storageModal?.isOpen ||
    shortcutsModal?.isOpen ||
    contextUI.isDialogOpen();

  // Cabinet toggle shortcut works even while Cabinet Modal itself is open
  if (action === 'toggle_cabinet' && !e.repeat) {
    const otherOpen =
      (modalEl && !modalEl.classList.contains('hidden')) ||
      storageModal?.isOpen ||
      shortcutsModal?.isOpen ||
      contextUI.isDialogOpen();
    if (!otherOpen) {
      e.preventDefault();
      soundEngine.playUiClick();
      if (cabinetModal.isOpen) cabinetModal.close();
      else cabinetModal.open();
      if (isMobileViewActive()) setMobileTab('bench');
      return;
    }
  }

  // Built-in fixed keys (F2 rename tab, Del/Backspace delete, 1..9/0 switch bench)
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    if (e.key === 'F2' && shortcutTarget === 'tab' && !anyModalOpen) {
      e.preventDefault();
      startRenameLabTab(labManager.activeIndex);
      return;
    }

    if ((e.key === 'Backspace' || e.key === 'Delete') && !anyModalOpen) {
      if (shortcutTarget === 'tab') {
        if (labManager.labs.length > 1) {
          e.preventDefault();
          labManager.removeLab(labManager.activeIndex);
          soundEngine.playTrashCrumple();
        }
        return;
      }
      const deletedCount = sim.deleteSelectedItems ? sim.deleteSelectedItems() : 0;
      if (deletedCount > 0) {
        e.preventDefault();
        soundEngine.playTrashCrumple();
        workbench.setSelection([], null);
        const t = getTranslator();
        showToast(t('toastDeletedApparatus').replace('{count}', String(deletedCount)));
        refreshChrome();
      }
      return;
    }

    if (anyModalOpen) return;

    // 1..9 & 0 -> Switch to Lab Bench #1..#10 (no-op if tab index does not exist)
    if (/^[0-9]$/.test(e.key) && !e.repeat) {
      const idx = e.key === '0' ? 9 : Number(e.key) - 1;
      if (idx >= 0 && idx < labManager.labs.length) {
        e.preventDefault();
        soundEngine.playUiClick();
        labManager.switchLab(idx);
        refreshChrome(true);
      }
      return;
    }
  }

  if (anyModalOpen || !action) return;

  const t = getTranslator();
  if (action === 'toggle_pause') {
    e.preventDefault();
    sim.environment.paused = !sim.environment.paused;
    sim.emitChange();
    soundEngine.playUiClick();
    showToast(sim.environment.paused ? `⏸ ${t('pause')}` : `▶ ${t('resume')}`);
  } else if (action === 'empty_item' && !e.repeat) {
    const heldId = workbench?.dragState?.itemId || null;
    const targetIds = heldId
      ? [heldId]
      : sim.selectedIds && sim.selectedIds.size > 0
      ? Array.from(sim.selectedIds)
      : sim.selectedId
      ? [sim.selectedId]
      : [];
    const emptiedLabels = [];
    for (const id of targetIds) {
      const it = sim.getItem(id);
      if (it && sim.emptyApparatus?.(id)) {
        emptiedLabels.push(it.label || it.typeId);
      }
    }
    if (emptiedLabels.length > 0) {
      e.preventDefault();
      soundEngine.playWaterRinse();
      showToast(`🧼 ${t('toastEmptiedApparatus').replace('{label}', emptiedLabels.join(', '))}`);
      refreshChrome();
    }
  } else if (action === 'cycle_optics' && !e.repeat) {
    e.preventDefault();
    const modes = ['normal', 'aerodynamics', 'thermal'];
    const cur = sim.environment.opticsMode || 'normal';
    const next = modes[(modes.indexOf(cur) + 1) % modes.length];
    sim.setOpticsMode?.(next);
    soundEngine.playUiClick();
    const labelKey = next === 'aerodynamics' ? 'opticsAero' : next === 'thermal' ? 'opticsThermal' : 'opticsNormal';
    showToast(`👁️ ${t(labelKey)}`);
    refreshChrome();
  } else if (action === 'toggle_uv' && !e.repeat) {
    e.preventDefault();
    sim.setUvLight(!sim.environment.uvLight);
    soundEngine.playUiClick();
    showToast(sim.environment.uvLight ? t('envUvBright') : `💡 ${t('envUvRoom')}`);
    refreshChrome();
  } else if (action === 'toggle_atmosphere' && !e.repeat) {
    e.preventDefault();
    const next = sim.environment.atmosphereMode === 'inert' ? 'air' : 'inert';
    sim.setAtmosphereMode(next);
    soundEngine.playUiClick();
    showToast(next === 'inert' ? `🛡️ ${t('envAtmInert')}` : `🌬️ ${t('envAtmAir')}`);
    refreshChrome();
  } else if (action === 'theme_key' && !e.repeat) {
    e.preventDefault();
    zHeldPopupShown = false;
    if (zHoldTimer) clearTimeout(zHoldTimer);
    zHoldTimer = setTimeout(() => {
      zHoldTimer = null;
      zHeldPopupShown = true;
      showQuickHoldPopup('theme');
    }, 220);
  } else if (action === 'hold_presets' && !e.repeat) {
    e.preventDefault();
    showQuickHoldPopup('preset');
  } else if (action === 'new_bench' && !e.repeat) {
    e.preventDefault();
    const res = labManager.addLab('starter');
    soundEngine.playUiClick();
    if (!res.ok) {
      showToast(`⚠️ ${t('labMaxLimit')}`);
    } else {
      ensureLabSubscribed(res.lab);
      refreshChrome(true);
    }
  } else if (action === 'toggle_sound' && !e.repeat) {
    e.preventDefault();
    appState.soundEnabled = soundEngine.toggleEnabled();
    refreshChrome(true);
    showToast(appState.soundEnabled ? `🔊 ${t('soundOn')}` : `🔇 ${t('soundMuted')}`);
  } else if (action === 'toggle_lang' && !e.repeat) {
    e.preventDefault();
    appState.lang = appState.lang === 'vi' ? 'en' : 'vi';
    localStorage.setItem(STORAGE_LANG_KEY, appState.lang);
    soundEngine.playUiClick();
    refreshChrome(true);
    showToast(appState.lang === 'vi' ? '🇻🇳 Tiếng Việt' : '🇬🇧 English');
  } else if (action === 'temp_up' || action === 'temp_down') {
    e.preventDefault();
    const curT = sim.environment.tempK || 298.15;
    sim.setAmbientTempK(curT + (action === 'temp_up' ? 1 : -1));
    refreshChrome();
    showToast(`🌡️ ${(sim.environment.tempK || 298.15).toFixed(2)} K (${(sim.environment.tempK - 273.15).toFixed(1)}°C)`);
  } else if (action === 'press_up' || action === 'press_down') {
    e.preventDefault();
    const curP = sim.environment.pressureBar || 1.0;
    const nextP = Math.max(0.2, Math.min(4.0, Math.round((curP + (action === 'press_up' ? 0.1 : -0.1)) * 100) / 100));
    sim.environment.pressureBar = nextP;
    sim.emitChange();
    refreshChrome();
    showToast(`⏱️ ${nextP.toFixed(2)} bar`);
  } else if (action === 'speed_up' || action === 'speed_down') {
    e.preventDefault();
    const cycle = action === 'speed_up' ? [1, 2, 4, 0.5] : [1, 0.5, 4, 2];
    const idx = cycle.indexOf(sim.environment.speed);
    sim.environment.speed = cycle[(idx + 1) % cycle.length];
    sim.emitChange();
    soundEngine.playUiClick();
    showToast(`${action === 'speed_up' ? '⏩' : '⏪'} ${t('simSpeed')}: ${sim.environment.speed}x`);
  } else if (action === 'reset_bench' && !e.repeat) {
    e.preventDefault();
    const now = performance.now();
    if (now - lastRPressMs < 350) {
      lastRPressMs = 0;
      confirmResetAllBenches();
    } else {
      lastRPressMs = now;
      particles.clear();
      comparisonPanel?.setOpen(false);
      labManager.clearBench(sim);
      soundEngine.playWaterRinse();
      showToast(t('benchCleanedToast'));
    }
  } else if (action === 'export_vlab' && !e.repeat) {
    e.preventDefault();
    promptExportSingleBench(labManager.activeIndex);
  } else if (action === 'import_vlab' && !e.repeat) {
    e.preventDefault();
    soundEngine.playUiClick();
    labTabsEl?.querySelector('#input-import-vlab-bar')?.click();
  } else if (action === 'undo') {
    e.preventDefault();
    runUndoAction();
  } else if (action === 'select_all') {
    e.preventDefault();
    shortcutTarget = 'canvas';
    runSelectAllAction();
  } else if (action === 'copy') {
    if (runCopyAction()) e.preventDefault();
  } else if (action === 'cut') {
    if (runCutAction()) e.preventDefault();
  } else if (action === 'paste') {
    const includeChemicals = !e.shiftKey;
    if (runPasteAction(includeChemicals)) e.preventDefault();
  } else if (action === 'save') {
    e.preventDefault();
    soundEngine.playUiClick();
    saveToLocalStorage(labManager);
    storageModal.setLastAutoSaveTime(Date.now());
    if (cloudSync.user) {
      cloudSync
        .saveWorkspaceToCloud(labManager)
        .then(() => showToast(`☁️ ${t('toastCloudSaved')}`))
        .catch((err) => {
          if (err?.message === 'CLOUD_PERMISSION_DENIED' || err?.code === 'permission-denied') {
            showToast(`⚠️ ${t('toastCloudPermissionErr')}`);
          } else {
            showToast(`💾 ${t('toastLocalSaved')}`);
          }
        });
    } else {
      showToast(`💾 ${t('toastLocalSaved')}`);
    }
  }
});

const cabinetModal = new StorageCabinetModal(labManager, getTranslator, () => appState.lang, {
  onNotify: (msg) => showToast(msg),
  onShowReactionInfo: (rxn) => {
    if (!rxn) return;
    document.getElementById('chemlab-rxn-info-modal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'chemlab-rxn-info-modal';
    wrap.className = 'storage-modal-backdrop';
    const rxnWikiQ = encodeURIComponent((rxn.nameStr || rxn.equation || 'chemical reaction').replace(/[→⇌()↑↓·]/g, ' ').trim());
    wrap.innerHTML = `
      <div class="storage-modal-card" style="max-width:460px;">
        <div class="flex items-center justify-between gap-2 pb-2 border-b border-theme">
          <h2 class="text-sm font-bold">${rxn.title || 'Reaction Info'}</h2>
          <button type="button" id="rxn-modal-close" class="px-2 py-0.5 rounded border border-theme text-xs">✕</button>
        </div>
        <div class="flex flex-col gap-2 py-2 text-xs">
          <div class="p-2 rounded-lg bg-surface-alt border border-theme font-mono font-bold text-accent">${rxn.equation || ''}</div>
          <div class="font-semibold">${rxn.nameStr || ''}</div>
          ${rxn.rateMolS ? `<div class="text-muted font-mono">${getTranslator()('rxnRateLabel')}: ${(rxn.rateMolS * 1000).toFixed(3)} mmol/s</div>` : ''}
          ${rxn.descStr ? `<p class="text-muted leading-relaxed">${rxn.descStr}</p>` : ''}
          <div class="pt-1 flex items-center gap-2">
            <a href="https://en.wikipedia.org/w/index.php?search=${rxnWikiQ}" target="_blank" rel="noopener noreferrer" class="storage-btn text-xs" style="text-decoration:none;">🌐 Wikipedia ↗</a>
          </div>
        </div>
      </div>
    `;
    wrap.addEventListener('click', (ev) => {
      if (ev.target === wrap || ev.target.id === 'rxn-modal-close') wrap.remove();
    });
    document.body.appendChild(wrap);
  },
  onRefresh: () => {
    syncActiveLabRefs();
    refreshChrome(true);
  },
  onOpenChange: (isOpen) => {
    appState.viewingStorage = Boolean(isOpen);
    document.getElementById('bench-top-toolbar')?.classList.toggle('hidden', appState.viewingStorage);
    document.getElementById('canvas-zoom-hud')?.classList.toggle('hidden', appState.viewingStorage);
    renderLabTabs(getTranslator());
    if (!isOpen) setTimeout(() => workbench.resize(), 20);
  },
  onCubbyContextMenu: (clientX, clientY, entry) => {
    const t = getTranslator();
    const takeSubmenu = labManager.labs.map((lb, idx) => ({
      label: getLabTitle(lb, t),
      onClick: () => {
        const moved = labManager.withdrawFromCabinet(entry.id, { mode: 'move', simOverride: lb.sim });
        if (moved) {
          saveToLocalStorage(labManager);
          soundEngine.playGlassClink(moved.typeId, 0.8);
          labManager.switchLab(idx);
          cabinetModal.close();
          syncActiveLabRefs();
          refreshChrome(true);
          showToast(`📤 ${t('cabinetWithdrawnToast')}`);
        }
      },
    }));
    const cloneSubmenu = labManager.labs.map((lb, idx) => ({
      label: getLabTitle(lb, t),
      onClick: () => {
        const cloned = labManager.withdrawFromCabinet(entry.id, { mode: 'clone', simOverride: lb.sim });
        if (cloned) {
          saveToLocalStorage(labManager);
          soundEngine.playGlassClink(cloned.typeId, 0.8);
          labManager.switchLab(idx);
          cabinetModal.close();
          syncActiveLabRefs();
          refreshChrome(true);
          showToast(`🧬 ${t('cabinetWithdrawnToast')}`);
        }
      },
    }));
    contextUI.showMenu(clientX, clientY, [
      { label: t('ctxCabTakeToLab'), submenu: takeSubmenu },
      { label: t('ctxCabCloneToLab'), submenu: cloneSubmenu },
      { separator: true },
      {
        label: t('ctxCabDelete'),
        danger: true,
        onClick: () => {
          labManager.removeFromCabinet(entry.id);
          saveToLocalStorage(labManager);
          soundEngine.playTrashCrumple();
          cabinetModal.render();
          refreshChrome(true);
        },
      },
    ]);
  },
});

const storageModal = new WorkspaceStorageModal(labManager, getTranslator, {
  onNotify: (msg) => showToast(msg),
  onShowReactionInfo: (rxn) => {
    if (!rxn) return;
    document.getElementById('chemlab-rxn-info-modal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'chemlab-rxn-info-modal';
    wrap.className = 'storage-modal-backdrop';
    const rxnWikiQ = encodeURIComponent((rxn.nameStr || rxn.equation || 'chemical reaction').replace(/[→⇌()↑↓·]/g, ' ').trim());
    wrap.innerHTML = `
      <div class="storage-modal-card" style="max-width:460px;">
        <div class="flex items-center justify-between gap-2 pb-2 border-b border-theme">
          <h2 class="text-sm font-bold">${rxn.title || 'Reaction Info'}</h2>
          <button type="button" id="rxn-modal-close" class="px-2 py-0.5 rounded border border-theme text-xs">✕</button>
        </div>
        <div class="flex flex-col gap-2 py-2 text-xs">
          <div class="p-2 rounded-lg bg-surface-alt border border-theme font-mono font-bold text-accent">${rxn.equation || ''}</div>
          <div class="font-semibold">${rxn.nameStr || ''}</div>
          ${rxn.rateMolS ? `<div class="text-muted font-mono">${getTranslator()('rxnRateLabel')}: ${(rxn.rateMolS * 1000).toFixed(3)} mmol/s</div>` : ''}
          ${rxn.descStr ? `<p class="text-muted leading-relaxed">${rxn.descStr}</p>` : ''}
          <div class="pt-1 flex items-center gap-2">
            <a href="https://en.wikipedia.org/w/index.php?search=${rxnWikiQ}" target="_blank" rel="noopener noreferrer" class="storage-btn text-xs" style="text-decoration:none;">🌐 Wikipedia ↗</a>
          </div>
        </div>
      </div>
    `;
    wrap.addEventListener('click', (ev) => {
      if (ev.target === wrap || ev.target.id === 'rxn-modal-close') wrap.remove();
    });
    document.body.appendChild(wrap);
  },
  onRefresh: () => {
    for (const lb of labManager.labs) ensureLabSubscribed(lb);
    syncActiveLabRefs();
    refreshChrome(true);
  },
  onAuthChange: (user) => {
    appState.cloudSignedIn = Boolean(user);
    refreshChrome(false);
  },
  onRequestExportSingleBench: () => promptExportSingleBench(labManager.activeIndex),
  onImportVlabFile: (file) => handleImportVlabFile(file),
});

const workspacePersistence = initWorkspacePersistence(labManager, {
  onAutoSaved: (ts) => storageModal.setLastAutoSaveTime(ts),
  shouldDefer: () => Boolean(workbench?.dragState || shelfPanel?._dragSession?.moved),
});

// Restore auto-saved workspace from Browser LocalStorage if present
if (loadFromLocalStorage(labManager)) {
  for (const lb of labManager.labs) ensureLabSubscribed(lb);
  syncActiveLabRefs();
}

// Expose LabManager, Workbench, SoundEngine & Storage hooks for automation / diagnostics
if (typeof window !== 'undefined') {
  window.__LAB_MANAGER__ = labManager;
  window.__WORKBENCH__ = workbench;
  window.__SOUND_ENGINE__ = soundEngine;
  window.__WORKSPACE_STORAGE__ = {
    serializeWorkspace,
    deserializeWorkspace,
    serializeActiveBench,
    importBenchIntoNewTab,
    saveToLocalStorage,
    loadFromLocalStorage,
    resetAllBenches,
    exportWorkspaceToFile,
    importWorkspaceFromFile,
    cloudSync,
    storageModal,
    cabinetModal,
    shortcutsModal,
    contextUI,
  };
}

// Initial boot
applyThemeAndDevice();
setMobileTab('bench');
refreshChrome(true);

// 60 FPS Animation & Physics Loop (active lab 60 FPS, background labs ~15 Hz batched)
let prevMs = performance.now();
let renderClockSec = prevMs / 1000;
let uiSyncAccum = 0;

function frame(nowMs) {
  const dt = Math.min(0.05, Math.max(0.001, (nowMs - prevMs) / 1000));
  prevMs = nowMs;
  lastFrameDt = dt;

  if (!sim.environment.paused) {
    renderClockSec += dt;
  }

  workbench.tickInteractivePour(dt);
  labManager.stepAllLabs(dt, () => renderLabTabs(getTranslator()));
  soundEngine.stepContinuous(sim, dt);
  workbench.render(renderClockSec);

  // Sync live telemetry numbers at ~15 Hz so UI is snappy without over-rendering
  uiSyncAccum += dt;
  if (uiSyncAccum >= 0.066) {
    uiSyncAccum = 0;
    inspectorPanel.update(appState.lang, false);
    comparisonPanel?.updateLiveData();
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Register PWA Service Worker if supported (works on localhost & GitHub Pages HTTPS)
if ('serviceWorker' in navigator) {
  let refreshingSw = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshingSw) return;
    refreshingSw = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update().catch(() => {});
      })
      .catch(() => {
        // Ignore registration error in restricted preview contexts
      });
  });
}
