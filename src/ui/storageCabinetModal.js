import { APPARATUS } from '../data/apparatus.js';
import { SPECIES, REAGENT_CATEGORIES } from '../data/species.js';
import { kelvinToCelsius } from '../data/constants.js';
import {
  VLAB_SCOPES,
  exportScopedVlabFile,
  readVlabFile,
  saveToLocalStorage,
} from '../storage/workspaceStorage.js';
import { soundEngine } from '../audio/soundEngine.js';

function classifyEntryFilter(entry) {
  if (!entry?.hasChemicals) return 'apparatus';
  const spList = entry.speciesIds || [];
  if (spList.includes('H_aq') || spList.includes('H2CO3_aq') || spList.some((id) => /^HCl|^HNO3|^H2SO4/.test(id))) {
    return 'acid';
  }
  if (spList.includes('OH_aq') || spList.includes('NH3_aq') || spList.includes('NaOH_s') || spList.includes('BaOH2_s') || spList.includes('CaOH2_s')) {
    return 'base';
  }
  if (spList.some((id) => ['Na_s', 'Zn_s', 'Fe_s', 'Cu_s', 'Ag_s'].includes(id))) {
    return 'metal';
  }
  return 'salt';
}

export class StorageCabinetModal {
  constructor(labManager, getTranslator, getLang, callbacks = {}) {
    this.labManager = labManager;
    this.getTranslator = getTranslator;
    this.getLang = getLang;
    this.callbacks = callbacks; // { onNotify, onRefresh }
    this.isOpen = false;
    this.searchQuery = '';
    this.filterGroup = 'all';
    this.rootEl = null;
    this._ensureRoot();
  }

  _ensureRoot() {
    let el = document.getElementById('storage-cabinet-modal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'storage-cabinet-modal';
      el.className = 'storage-modal-backdrop hidden';
      document.body.appendChild(el);
    }
    this.rootEl = el;
  }

  open() {
    this.isOpen = true;
    this.rootEl.classList.remove('hidden');
    this.render();
    setTimeout(() => this.rootEl?.querySelector('#cabinet-search-input')?.focus(), 40);
  }

  close() {
    this.isOpen = false;
    this.rootEl.classList.add('hidden');
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  render() {
    if (!this.rootEl) return;
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

    const filters = [
      { id: 'all', label: t('cabinetFilterAll') },
      { id: 'acid', label: t('cabinetFilterAcid') },
      { id: 'base', label: t('cabinetFilterBase') },
      { id: 'salt', label: t('cabinetFilterSalt') },
      { id: 'metal', label: t('cabinetFilterMetal') },
      { id: 'apparatus', label: t('cabinetFilterApparatus') },
    ];

    this.rootEl.innerHTML = `
      <div class="storage-modal-card cabinet-modal-card">
        <div class="storage-modal-header">
          <div class="flex items-center gap-2.5">
            <span class="text-lg">🗄️</span>
            <div>
              <div class="flex items-center gap-2">
                <h2 class="text-sm sm:text-base font-bold leading-tight">${t('cabinetTitle')}</h2>
                <span class="cabinet-count-pill">${entries.length} · ∞</span>
              </div>
              <p class="text-[11px] text-muted">${t('cabinetSubtitle')}</p>
            </div>
          </div>
          <button type="button" id="btn-cabinet-close" class="w-8 h-8 rounded-lg border border-theme bg-surface text-muted hover:text-main flex items-center justify-center text-sm font-bold">✕</button>
        </div>

        <div class="storage-modal-body">
          <!-- Controls Row: Search + Deposit + .vlab Import/Export -->
          <div class="flex flex-wrap items-center gap-2">
            <input id="cabinet-search-input" type="text" value="${this.searchQuery.replace(/"/g, '&quot;')}"
              placeholder="${t('cabinetSearchPlaceholder')}"
              class="storage-input flex-1" style="min-width:190px" />
            ${
              selectedItem
                ? `<button type="button" id="btn-cabinet-deposit-sel" class="storage-btn storage-btn-amber">📥 ${t('cabinetDepositSelected')}</button>`
                : ''
            }
            <button type="button" id="btn-cabinet-export" class="storage-btn storage-btn-primary">📤 ${t('cabinetExportBtn')}</button>
            <button type="button" id="btn-cabinet-import" class="storage-btn">📥 ${t('cabinetImportBtn')}</button>
            <input type="file" id="input-cabinet-import" accept=".vlab,.json,application/json" class="hidden" />
          </div>

          <!-- Filter Pills -->
          <div class="flex flex-wrap items-center gap-1.5">
            ${filters
              .map(
                (f) => `<button type="button" data-cab-filter="${f.id}" class="cabinet-filter-pill ${
                  this.filterGroup === f.id ? 'active' : ''
                }">${f.label}</button>`
              )
              .join('')}
          </div>

          <!-- Items List -->
          <div class="cabinet-grid">
            ${
              filtered.length === 0
                ? `<div class="cabinet-empty-box">${t('cabinetEmpty')}</div>`
                : filtered
                    .map((entry) => {
                      const spec = APPARATUS[entry.apparatusId] || {};
                      const appTitle = spec.i18nKey ? t(spec.i18nKey) : entry.apparatusId;
                      const tempC = kelvinToCelsius(entry.tempK ?? 298.15).toFixed(1);
                      const molesEntries = Object.entries(entry.snapshot?.moles || {})
                        .filter(([, n]) => Number(n) > 1e-10)
                        .sort((a, b) => Number(b[1]) - Number(a[1]))
                        .slice(0, 5);
                      const gasEntries = Object.entries(entry.snapshot?.headspaceGasMoles || {})
                        .filter(([g, n]) => g !== 'H2O_g' && Number(n) > 1e-9)
                        .slice(0, 3);
                      const chemSummary = [
                        ...molesEntries.map(([spId, n]) => `${SPECIES[spId]?.formula || spId}: ${(Number(n) * 1000).toFixed(1)} mmol`),
                        ...gasEntries.map(([gId, n]) => `💨 ${SPECIES[gId]?.formula || gId}: ${(Number(n) * 1000).toFixed(1)} mmol`),
                      ].join(' · ');
                      const stickyHtml = entry.stickyLabel?.text
                        ? `<span class="cabinet-sticky-badge" style="background:${entry.stickyLabel.bgColor || '#fef08a'}">${entry.stickyLabel.text}</span>`
                        : '';
                      const savedDateStr = new Date(entry.storedAt || Date.now()).toLocaleString(
                        langCode === 'vi' ? 'vi-VN' : 'en-US'
                      );
                      return `
                        <div class="cabinet-item-card" data-entry-id="${entry.id}">
                          <div class="flex items-start justify-between gap-2">
                            <div class="flex flex-col gap-1 min-w-0">
                              <div class="flex flex-wrap items-center gap-1.5">
                                <span class="text-xs font-bold text-main">${appTitle}</span>
                                ${stickyHtml}
                              </div>
                              <span class="text-[11px] font-mono text-muted">❄️ Frozen · ${tempC} °C · ${savedDateStr}</span>
                            </div>
                          </div>
                          <div class="text-[11px] text-muted leading-snug break-words">
                            ${chemSummary || (langCode === 'en' ? 'Empty clean apparatus' : 'Dụng cụ sạch chưa có hóa chất')}
                          </div>
                          <div class="flex flex-wrap items-center gap-1.5 pt-1">
                            <button type="button" data-cab-move="${entry.id}" class="storage-btn storage-btn-primary text-xs">${t('cabinetMoveToBench')}</button>
                            <button type="button" data-cab-clone="${entry.id}" class="storage-btn text-xs">${t('cabinetCloneToBench')}</button>
                            <button type="button" data-cab-del="${entry.id}" class="storage-btn storage-btn-danger text-xs" style="margin-left:auto">${t('cabinetDeleteEntry')}</button>
                          </div>
                        </div>
                      `;
                    })
                    .join('')
            }
          </div>
        </div>
      </div>
    `;

    this._bindEvents();
  }

  _bindEvents() {
    const t = this.getTranslator();
    const langCode = this.getLang();

    this.rootEl.querySelector('#btn-cabinet-close')?.addEventListener('click', () => this.close());
    this.rootEl.onclick = (e) => {
      if (e.target === this.rootEl) this.close();
    };

    const searchInput = this.rootEl.querySelector('#cabinet-search-input');
    searchInput?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value || '';
      const pos = e.target.selectionStart;
      this.render();
      const nxt = this.rootEl?.querySelector('#cabinet-search-input');
      if (nxt) {
        nxt.focus();
        if (typeof pos === 'number') nxt.setSelectionRange(pos, pos);
      }
    });

    this.rootEl.querySelectorAll('[data-cab-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.filterGroup = btn.dataset.cabFilter || 'all';
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
