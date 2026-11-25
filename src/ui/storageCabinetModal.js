import { APPARATUS } from '../data/apparatus.js';
import { SPECIES } from '../data/species.js';
import { kelvinToCelsius } from '../data/constants.js';
import {
  beginCanvasLabelFrame,
  flushCanvasLabelFrame,
  renderBurner,
  renderGasSyringe,
  renderPipette,
  renderRetortStand,
  renderScale,
  renderVessel,
} from '../canvas/vesselRenderer.js';
import {
  renderBurette,
  renderDcPowerAndWires,
  renderDiffusionTube,
  renderElectrodeRod,
  renderFilterFunnel,
  renderFlameLoop,
  renderIceBath,
  renderIndicatorStrip,
  renderIronSpoon,
  renderLiebigCondenser,
  renderPhenCotton,
  renderRubberStopper,
  renderSaltBridge,
  renderSeparatoryFunnel,
  renderSplint,
  renderStirBar,
  renderBoilingChips,
  renderThermometer,
  renderVoltAmmeterAndWires,
  renderWashBottle,
} from '../canvas/toolRenderer.js';
import {
  VLAB_SCOPES,
  exportScopedVlabFile,
  readVlabFile,
  saveToLocalStorage,
} from '../storage/workspaceStorage.js';
import { soundEngine } from '../audio/soundEngine.js';

const CABINET_PAGE_SIZE = 12; // 6 x 2 equal locker cubbies

function classifyEntryFilter(entry) {
  const spList = entry?.speciesIds || [];
  const hasGasMoles =
    Object.values(entry?.snapshot?.gasMoles || {}).some((n) => Number(n) > 1e-9) ||
    Object.entries(entry?.snapshot?.headspaceGasMoles || {}).some(([g, n]) => g !== 'H2O_g' && Number(n) > 1e-9);
  if (!entry?.hasChemicals && !hasGasMoles) return 'apparatus';
  if (spList.includes('H_aq') || spList.includes('H2CO3_aq') || spList.some((id) => /^HCl|^HNO3|^H2SO4/.test(id))) {
    return 'acid';
  }
  if (spList.includes('OH_aq') || spList.includes('NH3_aq') || spList.includes('NaOH_s') || spList.includes('KOH_s') || spList.includes('BaOH2_s') || spList.includes('CaOH2_s') || spList.includes('MgOH2_s') || spList.includes('AlOH3_s')) {
    return 'base';
  }
  if (spList.some((id) => ['Na_s', 'K_s', 'Zn_s', 'Mg_s', 'Fe_s', 'Al_s', 'Cu_s', 'Ag_s'].includes(id))) {
    return 'metal';
  }
  if (hasGasMoles || spList.some((id) => id.endsWith('_g'))) {
    return 'gas';
  }
  return 'salt';
}

function drawCubbyThumbnail(canvas, entry) {
  if (!canvas || !entry?.snapshot) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cw = canvas.width;
  const ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  const clone = JSON.parse(JSON.stringify(entry.snapshot));
  clone.x = 0;
  clone.y = 0;
  clone.tiltAngle = 0;
  clone.tiltDeg = 0;
  clone.landingTilt = 0;
  const spec = APPARATUS[clone.typeId] || { width: 72, height: 96 };
  const scale = Math.min((cw - 14) / Math.max(30, spec.width || 72), (ch - 10) / Math.max(30, spec.height || 96), 1.0);
  const themeName = document.documentElement.getAttribute('data-theme') || 'dark';
  const isDark = themeName === 'dark' || themeName === 'petal' || themeName === 'sos' || themeName === 'guts' || themeName === 'anti';

  ctx.save();
  ctx.translate(cw * 0.5, ch * 0.52);
  ctx.scale(scale, scale);
  beginCanvasLabelFrame(new Set([clone.id || '__cab']), false);
  try {
    if (clone.kind === 'vessel') {
      renderVessel(ctx, clone, { isSelected: false, isDropTarget: false, isDark, themeName, timeNow: 0, langCode: 'vi' });
    } else if (clone.kind === 'gas_syringe') renderGasSyringe(ctx, clone, false, isDark, { tempK: clone.tempK || 298.15, pressureBar: 1.0 }, 'vi', 0);
    else if (clone.kind === 'pipette') renderPipette(ctx, clone, false, isDark, 'vi', 0);
    else if (clone.kind === 'filter_funnel') renderFilterFunnel(ctx, clone, false, false, isDark, 'vi', 0);
    else if (clone.kind === 'separatory_funnel') renderSeparatoryFunnel(ctx, clone, false, false, isDark, 'vi', 0);
    else if (clone.kind === 'burette') renderBurette(ctx, clone, false, false, isDark, 0);
    else if (clone.kind === 'condenser') renderLiebigCondenser(ctx, clone, false, isDark, 0, 'vi');
    else if (clone.kind === 'spoon') renderIronSpoon(ctx, clone, false, isDark, 0);
    else if (clone.kind === 'thermometer') renderThermometer(ctx, clone, false, isDark, 'vi');
    else if (clone.kind === 'bath') renderIceBath(ctx, clone, false, isDark, 0, 'vi');
    else if (clone.kind === 'burner') renderBurner(ctx, clone, false, false, isDark, 0);
    else if (clone.kind === 'stand') renderRetortStand(ctx, clone, false, isDark);
    else if (clone.kind === 'scale') renderScale(ctx, clone, false, isDark);
    else if (clone.kind === 'wash_bottle') renderWashBottle(ctx, clone, false, isDark, 'vi', 0);
    else if (clone.kind === 'splint') renderSplint(ctx, clone, false, isDark, 0);
    else if (clone.kind === 'flame_loop') renderFlameLoop(ctx, clone, false, isDark, 0);
    else if (clone.kind === 'indicator_strip') renderIndicatorStrip(ctx, clone, false, isDark, 'vi');
    else if (clone.kind === 'stir_bar') renderStirBar(ctx, clone, false, isDark);
    else if (clone.kind === 'boiling_chips') renderBoilingChips(ctx, clone, false, isDark);
    else if (clone.kind === 'electrode') renderElectrodeRod(ctx, clone, false, isDark, 0);
    else if (clone.kind === 'salt_bridge') renderSaltBridge(ctx, clone, [clone], false, isDark, 0, 'vi');
    else if (clone.kind === 'rubber_stopper') renderRubberStopper(ctx, clone, false, isDark, null);
    else if (clone.kind === 'phen_cotton') renderPhenCotton(ctx, clone, false, isDark);
    else if (clone.kind === 'dc_power') renderDcPowerAndWires(ctx, [clone], null, isDark);
    else if (clone.kind === 'volt_ammeter') renderVoltAmmeterAndWires(ctx, [clone], null, isDark);
    else if (clone.kind === 'diffusion_tube') renderDiffusionTube(ctx, clone, false, false, isDark, 'vi');
  } catch {}
  flushCanvasLabelFrame(ctx);
  ctx.restore();
}

export class StorageCabinetModal {
  constructor(labManager, getTranslator, getLang, callbacks = {}) {
    this.labManager = labManager;
    this.getTranslator = getTranslator;
    this.getLang = getLang;
    this.callbacks = callbacks; // { onNotify, onRefresh, onOpenChange }
    this.isOpen = false;
    this.searchQuery = '';
    this.filterGroup = 'all';
    this.currentPage = 1;
    this.rootEl = null;
    this._wheelBound = false;
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
    if (el && !this._wheelBound) {
      this._wheelBound = true;
      // Wheel anywhere over the Storage Locker changes pages (disabling stored vessel tilt wheeling)
      el.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (Math.abs(e.deltaY) < 4) return;
          const next = this.currentPage + (e.deltaY > 0 ? 1 : -1);
          this.setPage(next);
        },
        { passive: false }
      );
    }
  }

  setPage(pageNum) {
    const total = this._lastTotalPages || 1;
    const clamped = Math.max(1, Math.min(total, Math.round(Number(pageNum) || 1)));
    if (clamped !== this.currentPage) {
      this.currentPage = clamped;
      this.render();
    }
  }

  open() {
    this._ensureRoot();
    this.isOpen = true;
    this.rootEl?.classList.remove('hidden');
    this.render();
    this.callbacks.onOpenChange?.(true);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.rootEl?.classList.add('hidden');
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
    const entries = Array.isArray(this.labManager?.storageCabinet) ? this.labManager.storageCabinet : [];
    const sim = this.labManager?.getActiveSim?.();
    const selectedItem = sim?.getSelectedItem?.();

    const q = this.searchQuery.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (this.filterGroup !== 'all' && classifyEntryFilter(entry) !== this.filterGroup) {
        return false;
      }
      if (!q) return true;
      const spec = APPARATUS[entry.apparatusId] || {};
      const appName = (spec.i18nKey ? t(spec.i18nKey) : entry.apparatusId).toLowerCase();
      const sticky = (entry.stickyLabel?.text || '').toLowerCase();
      const spText = (entry.speciesIds || [])
        .map((id) => `${id} ${SPECIES[id]?.formula || ''} ${SPECIES[id]?.name || ''}`)
        .join(' ')
        .toLowerCase();
      return appName.includes(q) || sticky.includes(q) || spText.includes(q);
    });

    const totalPages = Math.max(1, Math.ceil(filtered.length / CABINET_PAGE_SIZE));
    this._lastTotalPages = totalPages;
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    if (this.currentPage < 1) this.currentPage = 1;
    const startIdx = (this.currentPage - 1) * CABINET_PAGE_SIZE;
    const pageSlice = filtered.slice(startIdx, startIdx + CABINET_PAGE_SIZE);

    const filters = [
      { id: 'all', label: t('cabinetFilterAll') },
      { id: 'acid', label: t('cabinetFilterAcid') },
      { id: 'base', label: t('cabinetFilterBase') },
      { id: 'salt', label: t('cabinetFilterSalt') },
      { id: 'metal', label: t('cabinetFilterMetal') },
      { id: 'gas', label: t('cabinetFilterGas') },
      { id: 'apparatus', label: t('cabinetFilterApparatus') },
    ];

    const slotsHtml = [];
    for (let i = 0; i < CABINET_PAGE_SIZE; i++) {
      const entry = pageSlice[i];
      if (!entry) {
        slotsHtml.push(`<div class="storage-cubby opacity-70"></div>`);
        continue;
      }
      const spec = APPARATUS[entry.apparatusId] || {};
      const appTitle = spec.i18nKey ? t(spec.i18nKey) : entry.apparatusId;
      const tempC = kelvinToCelsius(entry.tempK ?? 298.15).toFixed(0);
      const stickyTxt = entry.stickyLabel?.text ? ` · ${entry.stickyLabel.text}` : '';
      const molesEntries = [
        ...Object.entries(entry.snapshot?.moles || {}),
        ...Object.entries(entry.snapshot?.gasMoles || {}),
        ...Object.entries(entry.snapshot?.headspaceGasMoles || {}).filter(([g]) => g !== 'H2O_g'),
      ]
        .filter(([, n]) => Number(n) > 1e-10)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 2);
      const chemLine = molesEntries.map(([spId]) => SPECIES[spId]?.formula || spId).join(', ');
      slotsHtml.push(`
        <div class="storage-cubby" data-entry-id="${entry.id}" title="${appTitle}${stickyTxt} (${tempC}°C)">
          <div class="storage-cubby-preview">
            <canvas class="cab-thumb-canvas" width="124" height="92" data-entry-id="${entry.id}"></canvas>
          </div>
          <div class="storage-cubby-meta">${chemLine ? `${chemLine} · ` : ''}${appTitle}${stickyTxt}</div>
          <div class="storage-cubby-actions">
            <button type="button" data-cab-move="${entry.id}" class="storage-cubby-btn primary" title="${t('cabinetMoveToBench')}">${langCode === 'en' ? 'Take' : 'Lấy'}</button>
            <button type="button" data-cab-clone="${entry.id}" class="storage-cubby-btn" title="${t('cabinetCloneToBench')}">+</button>
            <button type="button" data-cab-del="${entry.id}" class="storage-cubby-btn danger" title="${t('cabinetDeleteEntry')}">×</button>
          </div>
        </div>
      `);
    }

    this.rootEl.innerHTML = `
      <div class="storage-locker-topbar">
        <div class="storage-page-badge" id="cab-page-badge">
          <span>${langCode === 'en' ? 'page:' : 'trang:'}</span>
          <input id="cab-page-input" type="number" min="1" max="${totalPages}" value="${this.currentPage}" />
          <span>/ ${totalPages}</span>
        </div>
        <div class="flex flex-wrap items-center gap-1">
          ${filters
            .map(
              (f) => `<button type="button" data-cab-filter="${f.id}" class="cabinet-filter-pill ${
                this.filterGroup === f.id ? 'active' : ''
              }">${f.label}</button>`
            )
            .join('')}
        </div>
        ${
          selectedItem
            ? `<button type="button" id="btn-cabinet-deposit-sel" class="ml-auto storage-btn storage-btn-amber text-xs py-1 px-2.5">📥 ${t('cabinetDepositSelected')}</button>`
            : ''
        }
      </div>

      <div class="storage-locker-grid">${slotsHtml.join('')}</div>

      <div class="storage-locker-bottombar">
        <button type="button" id="btn-cab-prev-page" class="storage-nav-arrow" ${this.currentPage <= 1 ? 'disabled' : ''}>←</button>
        <div class="storage-locker-controls">
          <input id="cabinet-search-input" type="text" value="${this.searchQuery.replace(/"/g, '&quot;')}"
            placeholder="${t('cabinetSearchPlaceholder')}"
            class="storage-input" />
          <button type="button" id="btn-cabinet-export" class="storage-btn storage-btn-primary text-xs shrink-0">📤 ${t('cabinetExportBtn')}</button>
          <button type="button" id="btn-cabinet-import" class="storage-btn text-xs shrink-0">📥 ${t('cabinetImportBtn')}</button>
          <input type="file" id="input-cabinet-import" accept=".vlab,.json,application/json" class="hidden" />
        </div>
        <button type="button" id="btn-cab-next-page" class="storage-nav-arrow" ${this.currentPage >= totalPages ? 'disabled' : ''}>→</button>
      </div>
    `;

    // Render crisp scaled thumbnails inside each cubby canvas
    this.rootEl.querySelectorAll('.cab-thumb-canvas').forEach((cvs) => {
      const entry = pageSlice.find((e) => e.id === cvs.dataset.entryId);
      if (entry) drawCubbyThumbnail(cvs, entry);
    });

    this._bindEvents();
  }

  _bindEvents() {
    const t = this.getTranslator();
    const langCode = this.getLang();

    const pageInput = this.rootEl.querySelector('#cab-page-input');
    pageInput?.addEventListener('change', (e) => this.setPage(e.target.value));
    pageInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.setPage(pageInput.value);
    });
    this.rootEl.querySelector('#btn-cab-prev-page')?.addEventListener('click', () => this.setPage(this.currentPage - 1));
    this.rootEl.querySelector('#btn-cab-next-page')?.addEventListener('click', () => this.setPage(this.currentPage + 1));

    const searchInput = this.rootEl.querySelector('#cabinet-search-input');
    searchInput?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value || '';
      this.currentPage = 1;
      const pos = e.target.selectionStart;
      this.render();
      const nxt = this.rootEl?.querySelector('#cabinet-search-input');
      if (nxt) {
        nxt.focus();
        if (typeof pos === 'number') nxt.setSelectionRange(pos, pos);
      }
    });
    searchInput?.addEventListener('keydown', (e) => e.stopPropagation());

    this.rootEl.querySelectorAll('[data-cab-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.filterGroup = btn.dataset.cabFilter || 'all';
        this.currentPage = 1;
        this.render();
      });
    });

    this.rootEl.querySelector('#btn-cabinet-deposit-sel')?.addEventListener('click', () => {
      const sim = this.labManager?.getActiveSim?.();
      const sel = sim?.getSelectedItem?.();
      if (!sel) return;
      this.labManager.storeItemToCabinet(sel.id, sim);
      saveToLocalStorage(this.labManager);
      soundEngine.playUiClick();
      this.render();
      this.callbacks.onRefresh?.();
      this.callbacks.onNotify?.(t('cabinetStoredToast'));
    });

    this.rootEl.querySelectorAll('[data-cab-move]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = this.labManager.withdrawFromCabinet(btn.dataset.cabMove, { mode: 'move' });
        if (item) {
          saveToLocalStorage(this.labManager);
          soundEngine.playGlassClink(item.typeId, 0.8);
          this.render();
          this.callbacks.onRefresh?.();
          this.callbacks.onNotify?.(t('cabinetWithdrawnToast'));
        }
      });
    });

    this.rootEl.querySelectorAll('[data-cab-clone]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = this.labManager.withdrawFromCabinet(btn.dataset.cabClone, { mode: 'clone' });
        if (item) {
          saveToLocalStorage(this.labManager);
          soundEngine.playGlassClink(item.typeId, 0.8);
          this.render();
          this.callbacks.onRefresh?.();
          this.callbacks.onNotify?.(t('cabinetWithdrawnToast'));
        }
      });
    });

    this.rootEl.querySelectorAll('[data-cab-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.labManager.removeFromCabinet(btn.dataset.cabDel);
        saveToLocalStorage(this.labManager);
        soundEngine.playTrashCrumple();
        this.render();
        this.callbacks.onRefresh?.();
      });
    });

    this.rootEl.querySelectorAll('.storage-cubby[data-entry-id]').forEach((cubby) => {
      cubby.addEventListener('contextmenu', (e) => {
        if (!this.callbacks.onCubbyContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        const entries = Array.isArray(this.labManager?.storageCabinet) ? this.labManager.storageCabinet : [];
        const entry = entries.find((item) => item.id === cubby.dataset.entryId);
        if (entry) this.callbacks.onCubbyContextMenu(e.clientX, e.clientY, entry);
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
