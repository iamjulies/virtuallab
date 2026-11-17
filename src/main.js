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
  saveToLocalStorage,
  loadFromLocalStorage,
  resetAllBenches,
  exportWorkspaceToFile,
  importWorkspaceFromFile,
  cloudSync,
  initWorkspacePersistence,
} from './storage/workspaceStorage.js';
import { WorkspaceStorageModal } from './ui/workspaceStorageModal.js';

const STORAGE_LANG_KEY = 'virlab_lang';
const STORAGE_THEME_KEY = 'virlab_theme';
const STORAGE_DEVICE_KEY = 'virlab_device';

const appState = {
  lang: localStorage.getItem(STORAGE_LANG_KEY) || 'vi',
  theme: localStorage.getItem(STORAGE_THEME_KEY) || 'dark',
  deviceMode: localStorage.getItem(STORAGE_DEVICE_KEY) || 'auto',
  soundEnabled: soundEngine.isEnabled(),
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

function ensureLabSubscribed(lab) {
  if (!lab || subscribedSims.has(lab.sim)) return;
  subscribedSims.add(lab.sim);
  lab.sim.subscribe(() => {
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
    refreshChrome();
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
  onThemeChange: () => {
    appState.theme = appState.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_THEME_KEY, appState.theme);
    soundEngine.playUiClick();
    applyThemeAndDevice();
    refreshChrome(true);
  },
  onSoundToggle: () => {
    appState.soundEnabled = soundEngine.toggleEnabled();
    refreshChrome(true);
  },
  onOpenStorage: () => {
    soundEngine.playUiClick();
    storageModal.open();
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
});

const inspectorPanel = new InspectorPanel(inspectorEl, sim, getTranslator, {
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
  comparisonPanel?.setSim(sim);
}

let lastLabTabSig = '';
function renderLabTabs(t) {
  if (!labTabsEl) return;
  const userEmail = cloudSync.user?.email || '';
  const sig = `${appState.lang}|${userEmail}|${labManager.activeIndex}|${labManager.labs
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

  labTabsEl.querySelectorAll('.lab-tab-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const closeEl = e.target.closest?.('[data-close-lab]');
      if (closeEl) {
        e.stopPropagation();
        labManager.removeLab(Number(closeEl.dataset.closeLab));
        return;
      }
      labManager.switchLab(Number(btn.dataset.labIndex));
      workspacePersistence?.triggerDebouncedSave();
      if (cloudSync.user && cloudSync.dirtySinceCloudSave) {
        cloudSync.saveWorkspaceToCloud(labManager).catch(() => {});
      }
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

  // Wire direct Export .vlab button
  labTabsEl.querySelector('#btn-export-vlab-bar')?.addEventListener('click', () => {
    soundEngine.playUiClick();
    exportWorkspaceToFile(labManager);
    showToast(`📤 ${t('toastExportedVlab')}`);
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
      await importWorkspaceFromFile(file, labManager);
      soundEngine.playGlassClink('beaker_250', 0.8);
      for (const lb of labManager.labs) ensureLabSubscribed(lb);
      syncActiveLabRefs();
      refreshChrome(true);
      showToast(`📥 ${t('toastImportedVlab')}`);
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
      showToast(`⚠️ ${err.message || t('toastCloudError')}`);
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
    soundEngine.playTrashCrumple();
    resetAllBenches(labManager);
    for (const lb of labManager.labs) ensureLabSubscribed(lb);
    syncActiveLabRefs();
    refreshChrome(true);
    showToast(`🔄 ${t('toastResetAllBenches')}`);
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
  comparisonPanel?.render(forceInspector);
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

// Keyboard shortcuts: Backspace/Delete (Delete selected), Ctrl+Z (Undo up to 10 actions), Ctrl+A (Select All), Ctrl+C (Copy), Ctrl+V (Paste)
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) {
    return;
  }
  const modalVisible = modalEl && !modalEl.classList.contains('hidden');
  if ((e.key === 'Backspace' || e.key === 'Delete') && !modalVisible && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = (e.key || '').toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault();
    const ok = labManager.undo(sim);
    const t = getTranslator();
    if (ok) {
      soundEngine.playUndoWhoosh();
      workbench.setSelection(Array.from(sim.selectedIds || []), sim.selectedId);
      showToast(t('toastUndoSuccess'));
      refreshChrome(true);
    } else {
      showToast(t('toastUndoEmpty'));
    }
  } else if (key === 'a') {
    e.preventDefault();
    soundEngine.playUiClick();
    const allIds = sim.items.map((it) => it.id);
    sim.selectedIds = new Set(allIds);
    sim.selectedId = allIds[allIds.length - 1] || null;
    sim.emitChange();
    refreshChrome();
  } else if (key === 'c') {
    const count = labManager.copyItems(sim.selectedIds?.size > 0 ? sim.selectedIds : sim.selectedId ? [sim.selectedId] : [], sim);
    if (count > 0) {
      e.preventDefault();
      soundEngine.playUiClick();
      const t = getTranslator();
      showToast(t('toastCopiedApparatus').replace('{count}', String(count)));
    }
  } else if (key === 'v') {
    const pasted = labManager.pasteItems(sim);
    if (pasted.length > 0) {
      e.preventDefault();
      soundEngine.playGlassClink(pasted[0]?.typeId || 'beaker_250', 0.75);
      const t = getTranslator();
      showToast(t('toastPastedApparatus').replace('{count}', String(pasted.length)));
      refreshChrome();
    }
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
        .catch(() => showToast(`💾 ${t('toastLocalSaved')}`));
    } else {
      showToast(`💾 ${t('toastLocalSaved')}`);
    }
  }
});

const storageModal = new WorkspaceStorageModal(labManager, getTranslator, {
  onNotify: (msg) => showToast(msg),
  onRefresh: () => {
    for (const lb of labManager.labs) ensureLabSubscribed(lb);
    syncActiveLabRefs();
    refreshChrome(true);
  },
  onAuthChange: (user) => {
    appState.cloudSignedIn = Boolean(user);
    refreshChrome(false);
  },
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
