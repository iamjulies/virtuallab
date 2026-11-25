import { APPARATUS } from '../data/apparatus.js';
import { SPECIES } from '../data/species.js';
import {
  VLAB_SCOPES,
  exportScopedVlabFile,
  readVlabFile,
  saveToLocalStorage,
} from '../storage/workspaceStorage.js';
import { soundEngine } from '../audio/soundEngine.js';

const NON_ORGANIC_CARBON_IDS = new Set([
  'CO_g', 'CO2_g', 'CO3_2_aq', 'HCO3_aq', 'H2CO3_aq', 'C_s',
  'CaCO3_s', 'Na2CO3_s', 'K2CO3_s', 'MgCO3_s', 'BaCO3_s', 'FeCO3_s',
  'CaC2_s', 'Na2C2_s', 'Fe3C_s', 'SiC_s', 'Al4C3_s', 'MgC2_s', 'Mg2C3_s', 'KC8_s',
]);

const METAL_ELEMENTS = new Set([
  'Li', 'Na', 'K', 'Mg', 'Ca', 'Ba', 'Al', 'Zn', 'Fe', 'Ni', 'Cu', 'Ag', 'Pt', 'Au', 'Cr', 'Mn', 'Pb', 'Sn',
]);

function isOrganicSpecies(id) {
  if (!id || NON_ORGANIC_CARBON_IDS.has(id)) return false;
  const sp = SPECIES[id];
  if (!sp) return false;
  if (sp.isPolymer || sp.isFat || sp.isSoapIon || sp.isSoapSolid) return true;
  if (Array.isArray(sp.functionalGroups) && sp.functionalGroups.length > 0) return true;
  if (sp.liquidGroup === 'light_organic' || sp.liquidGroup === 'heavy_organic' || sp.liquidGroup === 'miscible_organic') return true;
  if ((sp.combustionCO2 || 0) > 0) return true;
  const atoms = sp.atoms;
  if (atoms && (atoms.C || 0) > 0 && (atoms.H || 0) > 0) return true;
  return /^(CH[234]|C\d+H|HCHO|HCOO|NH2CH2)/.test(id);
}

function isPureMetalSpecies(id) {
  const sp = SPECIES[id];
  const base = String(id || '').replace(/_s$/, '');
  if (sp && sp.phase === 's' && (sp.isMetal || sp.isDenseMetal)) return true;
  if (!sp) return METAL_ELEMENTS.has(base);
  if (sp.phase !== 's') return false;
  if (METAL_ELEMENTS.has(base)) return true;
  const keys = sp.atoms ? Object.keys(sp.atoms) : [];
  return keys.length === 1 && METAL_ELEMENTS.has(keys[0]);
}

function isOxideSpecies(id) {
  if (!id || isOrganicSpecies(id)) return false;
  const sp = SPECIES[id];
  if (!sp || sp.phase !== 's') return false;
  if (sp.atoms) {
    const keys = Object.keys(sp.atoms);
    return keys.length === 2 && keys.includes('O') && !keys.includes('H');
  }
  const base = id.replace(/_s$/, '');
  // Match inorganic binary oxides like CuO, Fe2O3, Fe3O4, SiO2, MnO2, Al2O3, CaO, MgO, Cr2O3, P2O5
  return /^[A-Z][a-z]?\d*O\d*$/.test(base) && !base.startsWith('O');
}

function isBaseSpecies(id) {
  if (id === 'OH_aq' || id === 'NH3_aq') return true;
  const sp = SPECIES[id];
  if (!sp || sp.phase !== 's') return false;
  return /OH\d*_s$/.test(id);
}

/**
 * Property-driven classification of any workbench/storage item into:
 * 'apparatus' | 'acid' | 'base' | 'oxide' | 'salt' | 'metal' | 'organic' | 'gas'
 */
export function classifyStorageItemFilter(itemOrEntry) {
  const src = itemOrEntry?.snapshot || itemOrEntry;
  if (!src) return 'apparatus';
  const moles = src.moles || {};
  const speciesIds = Object.entries(moles)
    .filter(([, n]) => Number(n) > 1e-12)
    .map(([id]) => id);
  const gasList = [
    ...Object.entries(src.gasMoles || {}).filter(([, n]) => Number(n) > 1e-10).map(([g]) => g),
    ...Object.entries(src.headspaceGasMoles || {}).filter(([g, n]) => g !== 'H2O_g' && Number(n) > 1e-10).map(([g]) => g),
  ];
  const hasGasMoles = gasList.length > 0;
  const hasChem =
    speciesIds.length > 0 ||
    hasGasMoles ||
    (src.volumeMl || 0) > 0 ||
    (src.condensedWaterMol || 0) > 1e-6 ||
    (src.condensedEtOHMol || 0) > 1e-6 ||
    (src.frozenWaterMol || 0) > 1e-6;

  if (!hasChem) return 'apparatus';

  const allIds = Array.from(new Set([...speciesIds, ...gasList]));
  if (allIds.some((id) => isOrganicSpecies(id))) {
    // Organic carboxylic acids can also show under organic cleanly
    return 'organic';
  }
  if (
    allIds.includes('H_aq') ||
    allIds.includes('H2CO3_aq') ||
    allIds.some((id) => /^(HCl|HNO3|H2SO4|H3PO4|HIO3)/.test(id))
  ) {
    return 'acid';
  }
  if (allIds.some((id) => isBaseSpecies(id))) {
    return 'base';
  }
  if (allIds.some((id) => isPureMetalSpecies(id))) {
    return 'metal';
  }
  if (allIds.some((id) => isOxideSpecies(id))) {
    return 'oxide';
  }
  if (hasGasMoles || allIds.some((id) => SPECIES[id]?.phase === 'g')) {
    return 'gas';
  }
  return 'salt';
}

export function itemMatchesStorageSearch(item, searchQuery = '', filterGroup = 'all', t = (k) => k) {
  if (!item) return false;
  if (filterGroup && filterGroup !== 'all') {
    if (classifyStorageItemFilter(item) !== filterGroup) return false;
  }
  const q = String(searchQuery || '').trim().toLowerCase();
  if (!q) return true;
  const spec = APPARATUS[item.typeId] || {};
  const appName = (spec.i18nKey ? t(spec.i18nKey) : item.typeId || '').toLowerCase();
  const labelTxt = `${item.label || ''} ${item.stickyLabel?.text || ''}`.toLowerCase();
  const chemKeys = [
    ...Object.keys(item.moles || {}).filter((k) => (item.moles[k] || 0) > 1e-12),
    ...Object.keys(item.gasMoles || {}).filter((k) => (item.gasMoles[k] || 0) > 1e-10),
    ...Object.keys(item.headspaceGasMoles || {}).filter((k) => k !== 'H2O_g' && (item.headspaceGasMoles[k] || 0) > 1e-10),
  ];
  const chemTxt = chemKeys
    .map((id) => `${id} ${SPECIES[id]?.formula || ''} ${SPECIES[id]?.name || ''}`)
    .join(' ')
    .toLowerCase();
  return appName.includes(q) || labelTxt.includes(q) || chemTxt.includes(q);
}

export class StorageCabinetModal {
  constructor(labManager, getTranslator, getLang, callbacks = {}) {
    this.labManager = labManager;
    this.getTranslator = getTranslator;
    this.getLang = getLang;
    this.callbacks = callbacks; // { onNotify, onRefresh, onOpenChange, onApplyStorageHighlight }
    this.isOpen = false;
    this.searchQuery = '';
    this.filterGroup = 'all';
    this.rootEl = null;
    this._ensureRoot();
  }

  _ensureRoot() {
    let el = document.getElementById('storage-locker-root');
    if (!el) {
      el = document.createElement('div');
      el.id = 'storage-locker-root';
      el.className = 'storage-locker-root hidden';
      document.querySelector('.workbench-canvas-wrap')?.appendChild(el);
    }
    this.rootEl = el;
  }

  get currentPage() {
    return (this.labManager?.activeStorageIndex ?? 0) + 1;
  }

  setPage(pageNum) {
    const total = Math.max(1, this.labManager?.storageLabs?.length || 1);
    const clamped = Math.max(1, Math.min(total, Math.round(Number(pageNum) || 1)));
    this.labManager?.switchStoragePage?.(clamped - 1);
    this.callbacks.onRefresh?.();
    this.render();
  }

  _syncHighlight() {
    const t = this.getTranslator();
    const hasFilter = this.filterGroup !== 'all' || this.searchQuery.trim().length > 0;
    const pred = hasFilter
      ? (it) => itemMatchesStorageSearch(it, this.searchQuery, this.filterGroup, t)
      : null;
    this.callbacks.onApplyStorageHighlight?.(pred, hasFilter && this.isOpen);
  }

  _jumpToFirstMatchingPage() {
    if (!this.labManager?.storageLabs?.length) return;
    const t = this.getTranslator();
    const hasFilter = this.filterGroup !== 'all' || this.searchQuery.trim().length > 0;
    if (!hasFilter) return;
    const curPg = this.labManager.storageLabs[this.labManager.activeStorageIndex];
    const curHasMatch = (curPg?.sim?.items || []).some((it) => itemMatchesStorageSearch(it, this.searchQuery, this.filterGroup, t));
    if (curHasMatch) return;
    const foundIdx = this.labManager.storageLabs.findIndex((pg) =>
      (pg?.sim?.items || []).some((it) => itemMatchesStorageSearch(it, this.searchQuery, this.filterGroup, t))
    );
    if (foundIdx >= 0 && foundIdx !== this.labManager.activeStorageIndex) {
      this.labManager.switchStoragePage(foundIdx);
      this.callbacks.onRefresh?.();
    }
  }

  open() {
    this._ensureRoot();
    this.isOpen = true;
    this.labManager?.setViewingStorage?.(true);
    this.rootEl?.classList.remove('hidden');
    this.callbacks.onOpenChange?.(true);
    this.render();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.labManager?.setViewingStorage?.(false);
    this.rootEl?.classList.add('hidden');
    this.callbacks.onApplyStorageHighlight?.(null, false);
    this.callbacks.onOpenChange?.(false);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  render() {
    this._ensureRoot();
    if (!this.rootEl || !this.isOpen) return;
    const t = this.getTranslator();
    const langCode = this.getLang();
    const pages = this.labManager?.storageLabs || [];
    const totalPages = Math.max(1, pages.length);
    const curIdx = Math.max(0, Math.min(totalPages - 1, this.labManager?.activeStorageIndex || 0));
    const curPage = curIdx + 1;
    const curSim = pages[curIdx]?.sim;
    const curItemCount = curSim?.items?.length || 0;
    const totalStored = this.labManager?.getTotalStorageItemCount?.() ?? 0;

    const matchCountCur = curSim
      ? (curSim.items || []).filter((it) => itemMatchesStorageSearch(it, this.searchQuery, this.filterGroup, t)).length
      : 0;
    const hasFilter = this.filterGroup !== 'all' || this.searchQuery.trim().length > 0;

    const filters = [
      { id: 'all', label: t('cabinetFilterAll') },
      { id: 'acid', label: t('cabinetFilterAcid') },
      { id: 'base', label: t('cabinetFilterBase') },
      { id: 'oxide', label: t('cabinetFilterOxide') },
      { id: 'salt', label: t('cabinetFilterSalt') },
      { id: 'metal', label: t('cabinetFilterMetal') },
      { id: 'organic', label: t('cabinetFilterOrganic') },
      { id: 'gas', label: t('cabinetFilterGas') },
      { id: 'apparatus', label: t('cabinetFilterApparatus') },
    ];

    this.rootEl.innerHTML = `
      <div class="storage-locker-topbar">
        <div class="storage-page-badge" id="cab-page-badge">
          <button type="button" id="btn-cab-prev-page" class="cab-mini-nav" ${curPage <= 1 ? 'disabled' : ''} title="${t('storagePrevShelfTip')}">◀</button>
          <span>${t('storageShelfLabel')}</span>
          <input id="cab-page-input" type="number" min="1" max="${totalPages}" value="${curPage}" />
          <span>/ ${totalPages}</span>
          <button type="button" id="btn-cab-next-page" class="cab-mini-nav" ${curPage >= totalPages ? 'disabled' : ''} title="${t('storageNextShelfTip')}">▶</button>
          <button type="button" id="btn-cab-add-page" class="cab-mini-add" title="${t('storageAddShelfBtn')}">+</button>
          ${
            totalPages > 1 && curItemCount === 0
              ? `<button type="button" id="btn-cab-del-page" class="cab-mini-del" title="${t('storageDelEmptyShelfTip')}">×</button>`
              : ''
          }
        </div>
        <span class="storage-frozen-pill" title="${t('storageFrozenHint')}">❄️ ${t('storageFrozenPill')} (${totalStored})</span>
        <div class="flex flex-wrap items-center gap-1">
          ${filters
            .map(
              (f) => `<button type="button" data-cab-filter="${f.id}" class="cabinet-filter-pill ${
                this.filterGroup === f.id ? 'active' : ''
              }">${f.label}</button>`
            )
            .join('')}
        </div>
        <button type="button" id="btn-cab-back-lab" class="ml-auto storage-btn storage-btn-primary text-xs py-1 px-2.5 shrink-0">↩️ ${t('storageBackToLabBtn')}</button>
      </div>

      <div class="storage-locker-bottombar">
        <div class="storage-locker-controls">
          <input id="cabinet-search-input" type="text" value="${this.searchQuery.replace(/"/g, '&quot;')}"
            placeholder="${t('cabinetSearchPlaceholder')}"
            class="storage-input" />
          ${
            hasFilter
              ? `<span class="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 shrink-0">${matchCountCur}/${curItemCount}</span>`
              : ''
          }
          <button type="button" id="btn-cabinet-export" class="storage-btn storage-btn-primary text-xs shrink-0">📤 ${t('cabinetExportBtn')}</button>
          <button type="button" id="btn-cabinet-import" class="storage-btn text-xs shrink-0">📥 ${t('cabinetImportBtn')}</button>
          <input type="file" id="input-cabinet-import" accept=".vlab,.json,application/json" class="hidden" />
        </div>
      </div>
    `;

    this._syncHighlight();
    this._bindEvents(langCode);
  }

  _bindEvents(langCode) {
    const t = this.getTranslator();

    const pageInput = this.rootEl.querySelector('#cab-page-input');
    pageInput?.addEventListener('change', (e) => this.setPage(e.target.value));
    pageInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.setPage(pageInput.value);
    });
    this.rootEl.querySelector('#btn-cab-prev-page')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      this.setPage(this.currentPage - 1);
    });
    this.rootEl.querySelector('#btn-cab-next-page')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      this.setPage(this.currentPage + 1);
    });
    this.rootEl.querySelector('#btn-cab-add-page')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      this.labManager?.addStoragePage?.();
      saveToLocalStorage(this.labManager);
      this.callbacks.onRefresh?.();
      this.render();
      this.callbacks.onNotify?.(`🗄️ ${t('storageAddedShelfToast').replace('{n}', String(this.currentPage))}`);
    });
    this.rootEl.querySelector('#btn-cab-del-page')?.addEventListener('click', () => {
      if (this.labManager?.removeEmptyStoragePage?.()) {
        soundEngine.playTrashCrumple();
        saveToLocalStorage(this.labManager);
        this.callbacks.onRefresh?.();
        this.render();
      }
    });
    this.rootEl.querySelector('#btn-cab-back-lab')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      this.close();
    });

    const searchInput = this.rootEl.querySelector('#cabinet-search-input');
    searchInput?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value || '';
      const pos = e.target.selectionStart;
      this._jumpToFirstMatchingPage();
      this.render();
      const nxt = this.rootEl?.querySelector('#cabinet-search-input');
      if (nxt) {
        nxt.focus();
        if (typeof pos === 'number') nxt.setSelectionRange(pos, pos);
      }
    });
    searchInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        this._jumpToFirstMatchingPage();
        this.render();
      }
    });

    this.rootEl.querySelectorAll('[data-cab-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.filterGroup = btn.dataset.cabFilter || 'all';
        this._jumpToFirstMatchingPage();
        this.render();
      });
    });

    this.rootEl.querySelector('#btn-cabinet-export')?.addEventListener('click', () => {
      const fname = exportScopedVlabFile(VLAB_SCOPES.STORAGE_CABINET, this.labManager, { langCode });
      if (fname) {
        soundEngine.playUiClick();
        this.callbacks.onNotify?.(`📤 ${t('toastExportedVlab')} (${fname})`);
      }
    });

    const impInput = this.rootEl.querySelector('#input-cabinet-import');
    this.rootEl.querySelector('#btn-cabinet-import')?.addEventListener('click', () => {
      impInput?.click();
    });
    impInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const { scope, data } = await readVlabFile(file);
        const list = Array.isArray(data?.storageCabinet) ? data.storageCabinet : [];
        if (scope === VLAB_SCOPES.STORAGE_CABINET || list.length > 0) {
          const added = this.labManager.mergeStorageCabinet(list);
          saveToLocalStorage(this.labManager);
          soundEngine.playUiClick();
          this.render();
          this.callbacks.onRefresh?.();
          this.callbacks.onNotify?.(`📥 ${t('toastImportedVlab')} (+${added})`);
        } else {
          this.callbacks.onNotify?.(`⚠️ ${t('toastImportFailed')}`);
        }
      } catch (err) {
        this.callbacks.onNotify?.(`⚠️ ${t('toastImportFailed')}: ${err.message}`);
      } finally {
        e.target.value = '';
      }
    });
  }
}
