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
    activeLab.particles.emitForVessel(vessel, metrics, lastFrameDt * activeLab.sim.environment.speed);
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
  document.getElementById('panel-shelf')?.classList.remove('shelf-discard-target');
  document.querySelector('.mobile-tab-btn[data-tab="shelf"]')?.classList.remove('shelf-discard-target');
}

function isOverShelfDiscardZone(clientX, clientY) {
  if (!clientX && !clientY) return false;
  const panelEl = document.getElementById('panel-shelf');
  if (panelEl) {
    const r = panelEl.getBoundingClientRect();
    if (r.width > 10 && r.height > 10 && clientX <= r.right + 12 && clientY >= r.top - 12 && clientY <= r.bottom + 12) {
      return panelEl;
    }
  }
  const mobShelfBtn = document.querySelector('.mobile-tab-btn[data-tab="shelf"]');
  if (mobShelfBtn) {
    const r = mobShelfBtn.getBoundingClientRect();
    if (r.width > 10 && r.height > 10 && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return mobShelfBtn;
    }
  }
  return null;
}

workbench = new LabWorkbenchCanvas(canvasEl, sim, particles, {
  onSelect: () => {
    shortcutTarget = 'canvas';
    contextUI.closeMenu();
    refreshChrome();
  },
  onContextMenu: (clientX, clientY, logicalPt, hitItem) => {
    shortcutTarget = 'canvas';
    openCanvasContextMenu(clientX, clientY, logicalPt, hitItem);
  },
  onRequestDosing: (reagentId, vesselId) => {
    dosingModal.openReagent(reagentId, vesselId);
  },
  onExternalTabDragHover: (clientX, clientY, item) => {
    clearLabDropHighlights();
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
    clearLabDropHighlights();
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

const envBar = new EnvironmentBar(headerEl, sim, appState, {
  onLangChange: () => {
    appState.lang = appState.lang === 'vi' ? 'en' : 'vi';
    localStorage.setItem(STORAGE_LANG_KEY, appState.lang);
    refreshChrome(true);
  },
  onThemeChange: (nextTheme = null) => {
    const order = ['dark', 'light', 'olivia', 'petal'];
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
    cabinetModal.open();
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
      workbench.dropFromShelf(clampedX, clampedY, kind, id);
      if (isMobileViewActive()) setMobileTab('bench');
      refreshChrome();
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
        (i.kind === 'vessel' || i.kind === 'filter_funnel' || i.kind === 'burette')
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
  const isDark = appState.theme === 'dark' || appState.theme === 'petal';
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
function renderLabTabs(t) {
  if (!labTabsEl) return;
  const userEmail = cloudSync.user?.email || '';
  const sig = `${appState.lang}|${userEmail}|${shortcutTarget}|${renamingTabIndex}|${labManager.activeIndex}|${labManager.labs
    .map((lb) => `${lb.id}:${lb.customName || ''}:${lb.sim.items.length}:${lb.sim.environment.atmosphereMode}:${lb.unreadAlerts || 0}`)
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

  labTabsEl.querySelectorAll('.lab-tab-btn').forEach((btn) => {
    const idx = Number(btn.dataset.labIndex);
    btn.addEventListener('click', (e) => {
      if (renamingTabIndex >= 0) return;
      const closeEl = e.target.closest?.('[data-close-lab]');
      if (closeEl) {
        e.stopPropagation();
        labManager.removeLab(Number(closeEl.dataset.closeLab));
        return;
      }
      shortcutTarget = 'tab';
      labManager.switchLab(idx);
      workspacePersistence?.triggerDebouncedSave();
      if (cloudSync.user && cloudSync.dirtySinceCloudSave) {
        cloudSync.saveWorkspaceToCloud(labManager).catch(() => {});
      }
    });
    btn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRenameLabTab(idx);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTabContextMenu(e.clientX, e.clientY, idx);
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

  // Wire direct Export .vlab button with custom filename popup
  labTabsEl.querySelector('#btn-export-vlab-bar')?.addEventListener('click', () => {
    soundEngine.playUiClick();
    promptExportSingleBench(labManager.activeIndex);
  });

  // Wire direct Import .vlab / .json button
  const barFileInput = labTabsEl.querySelector('#input-import-vlab-bar');
  labTabsEl.querySelector('#btn-import-vlab-bar')?.addEventListener('click', () => {
    soundEngine.playUiClick();
    barFileInput?.click();
  });
  barFileInput?.addEventListener('change', async (e) => {
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

  // Wire direct Cloud Save button
  labTabsEl.querySelector('#btn-cloud-save-bar')?.addEventListener('click', async () => {
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
  });

  // Wire Share Code button
  labTabsEl.querySelector('#btn-share-code-bar')?.addEventListener('click', () => {
    soundEngine.playUiClick();
    storageModal.open('share');
  });

  // Wire Login / Register modal button
  labTabsEl.querySelector('#btn-auth-open')?.addEventListener('click', () => {
    soundEngine.playUiClick();
    storageModal.open('auth');
  });

  // Wire Reset All Benches button
  labTabsEl.querySelector('#btn-reset-all-bar')?.addEventListener('click', () => {
    confirmResetAllBenches();
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
  const isDark = appState.theme === 'dark' || appState.theme === 'petal';
  document.documentElement.setAttribute('data-theme', appState.theme);
  rootWrap.setAttribute('data-device', appState.deviceMode);
  workbench.setTheme(isDark, appState.theme);
  particles.setTheme(isDark);
  inspectorPanel.setTheme(isDark);
}

function refreshChrome(forceInspector = false) {
  const t = getTranslator();
  appState.cabinetCount = Array.isArray(labManager?.storageCabinet) ? labManager.storageCabinet.length : 0;
  workbench.setLang(appState.lang);
  envBar.render(t);
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

// Global Keyboard Shortcuts (guarded cleanly against inputs & modifiers)
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) {
    return;
  }

  if (e.key === 'Escape') {
    contextUI.closeMenu();
    contextUI.closeDialog();
    cabinetModal?.close();
    storageModal?.close();
    dosingModal?.close();
    workbench?.cancelItemPick();
    return;
  }

  const anyModalOpen =
    (modalEl && !modalEl.classList.contains('hidden')) ||
    cabinetModal?.isOpen ||
    storageModal?.isOpen ||
    contextUI.isDialogOpen();

  // Single-key shortcuts (MUST NOT fire with Ctrl/Meta/Alt pressed!)
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
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

    if (e.code === 'Space') {
      e.preventDefault();
      sim.environment.paused = !sim.environment.paused;
      sim.emitChange();
      soundEngine.playUiClick();
      const t = getTranslator();
      showToast(sim.environment.paused ? `⏸ ${t('pause')}` : `▶ ${t('resume')}`);
      return;
    }

    const low = (e.key || '').toLowerCase();
    if (low === 'w') {
      e.preventDefault();
      const cycleW = [1, 2, 4, 0.5];
      const idx = cycleW.indexOf(sim.environment.speed);
      sim.environment.speed = cycleW[(idx + 1) % cycleW.length];
      sim.emitChange();
      soundEngine.playUiClick();
      showToast(`⏩ ${getTranslator()('simSpeed')}: ${sim.environment.speed}x`);
      return;
    }
    if (low === 's') {
      e.preventDefault();
      const cycleS = [1, 0.5, 4, 2];
      const idx = cycleS.indexOf(sim.environment.speed);
      sim.environment.speed = cycleS[(idx + 1) % cycleS.length];
      sim.emitChange();
      soundEngine.playUiClick();
      showToast(`⏪ ${getTranslator()('simSpeed')}: ${sim.environment.speed}x`);
      return;
    }
    if (low === 'r') {
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
        showToast(getTranslator()('benchCleanedToast'));
      }
      return;
    }
    return;
  }

  if (!(e.ctrlKey || e.metaKey)) return;
  const key = (e.key || '').toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault();
    runUndoAction();
  } else if (key === 'a') {
    e.preventDefault();
    shortcutTarget = 'canvas';
    runSelectAllAction();
  } else if (key === 'c') {
    if (runCopyAction()) e.preventDefault();
  } else if (key === 'x') {
    if (runCutAction()) e.preventDefault();
  } else if (key === 'v') {
    const includeChemicals = !e.shiftKey;
    if (runPasteAction(includeChemicals)) e.preventDefault();
  } else if (key === 'e') {
    e.preventDefault();
    promptExportSingleBench(labManager.activeIndex);
  } else if (key === 's') {
    e.preventDefault();
    soundEngine.playUiClick();
    const t = getTranslator();
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
});

const storageModal = new WorkspaceStorageModal(labManager, getTranslator, {
  onNotify: (msg) => showToast(msg),
  onShowReactionInfo: (rxn) => {
    if (!rxn) return;
    document.getElementById('chemlab-rxn-info-modal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'chemlab-rxn-info-modal';
    wrap.className = 'storage-modal-backdrop';
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
    contextUI,
  };
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
  soundEngine.stepContinuous(sim, dt);
  workbench.render(nowMs / 1000);

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
      .register('./sw.js')
      .then((reg) => {
        reg.update().catch(() => {});
      })
      .catch(() => {
        // Ignore registration error in restricted preview contexts
      });
  });
}
