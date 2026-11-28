const SHORTCUTS_STORAGE_KEY = 'chemlab_custom_shortcuts_v1';

export const DEFAULT_SHORTCUTS = [
  { id: 'empty_item', defaultCombo: 'Q', labelKey: 'scEmptyItem', group: 'lab' },
  { id: 'cycle_optics', defaultCombo: 'E', labelKey: 'scCycleOptics', group: 'lab' },
  { id: 'toggle_cabinet', defaultCombo: 'B', labelKey: 'scToggleCabinet', group: 'lab' },
  { id: 'toggle_uv', defaultCombo: 'L', labelKey: 'scToggleUv', group: 'lab' },
  { id: 'toggle_atmosphere', defaultCombo: 'A', labelKey: 'scToggleAtm', group: 'lab' },
  { id: 'theme_key', defaultCombo: 'Z', labelKey: 'scThemeKey', group: 'lab' },
  { id: 'hold_presets', defaultCombo: 'F', labelKey: 'scHoldPresets', group: 'lab' },
  { id: 'new_bench', defaultCombo: 'N', labelKey: 'scNewBench', group: 'lab' },
  { id: 'toggle_sound', defaultCombo: 'M', labelKey: 'scToggleSound', group: 'lab' },
  { id: 'toggle_lang', defaultCombo: 'K', labelKey: 'scToggleLang', group: 'lab' },
  { id: 'temp_up', defaultCombo: 'T', labelKey: 'scTempUp', group: 'lab' },
  { id: 'temp_down', defaultCombo: 'Y', labelKey: 'scTempDown', group: 'lab' },
  { id: 'press_up', defaultCombo: 'G', labelKey: 'scPressUp', group: 'lab' },
  { id: 'press_down', defaultCombo: 'H', labelKey: 'scPressDown', group: 'lab' },
  { id: 'speed_up', defaultCombo: 'W', labelKey: 'scSpeedUp', group: 'lab' },
  { id: 'speed_down', defaultCombo: 'S', labelKey: 'scSpeedDown', group: 'lab' },
  { id: 'reset_bench', defaultCombo: 'R', labelKey: 'scResetBench', group: 'lab' },
  { id: 'toggle_pause', defaultCombo: 'Space', labelKey: 'scTogglePause', group: 'lab' },
  { id: 'export_vlab', defaultCombo: 'Ctrl+E', labelKey: 'scExportVlab', group: 'edit' },
  { id: 'import_vlab', defaultCombo: 'Shift+E', labelKey: 'scImportVlab', group: 'edit' },
  { id: 'undo', defaultCombo: 'Ctrl+Z', labelKey: 'scUndo', group: 'edit' },
  { id: 'redo', defaultCombo: 'Ctrl+Shift+Z', labelKey: 'scRedo', group: 'edit' },
  { id: 'select_all', defaultCombo: 'Ctrl+A', labelKey: 'scSelectAll', group: 'edit' },
  { id: 'copy', defaultCombo: 'Ctrl+C', labelKey: 'scCopy', group: 'edit' },
  { id: 'cut', defaultCombo: 'Ctrl+X', labelKey: 'scCut', group: 'edit' },
  { id: 'paste', defaultCombo: 'Ctrl+V', labelKey: 'scPaste', group: 'edit' },
  { id: 'save', defaultCombo: 'Ctrl+S', labelKey: 'scSave', group: 'edit' },
];

export const BUILTIN_SHORTCUT_ROWS = [
  { combo: '1 – 9, 0', labelKey: 'scSwitchBench' },
  { combo: 'F2', labelKey: 'scRenameTab' },
  { combo: 'Del / Backspace', labelKey: 'scDeleteSel' },
  { combo: 'Esc', labelKey: 'scCloseOverlay' },
];

export const WHEEL_TOOL_ROWS = [
  { combo: 'Scroll', labelKey: 'scWheelVessel' },
  { combo: 'Scroll', labelKey: 'scWheelPipette' },
  { combo: 'Scroll / Shift', labelKey: 'scWheelBurner' },
  { combo: 'Scroll', labelKey: 'scWheelBurette' },
  { combo: 'Scroll / Shift', labelKey: 'scWheelStirBar' },
  { combo: 'Scroll', labelKey: 'scWheelSaltBridge' },
  { combo: 'Scroll / Ctrl / Shift', labelKey: 'scWheelElectrophoresis' },
  { combo: 'Scroll', labelKey: 'scWheelIceBath' },
  { combo: 'Scroll / Shift / Ctrl', labelKey: 'scWheelDcPower' },
  { combo: 'Scroll / Shift', labelKey: 'scWheelOtherTools' },
];

// Reserved shortcuts across Chrome, Edge, Firefox & Safari that web apps must NEVER collide with
export const BROWSER_RESERVED_COMBOS = new Set([
  'Ctrl+T',
  'Ctrl+W',
  'Ctrl+N',
  'Ctrl+Shift+T',
  'Ctrl+Shift+N',
  'Ctrl+Shift+W',
  'Ctrl+Tab',
  'Ctrl+Shift+Tab',
  'Ctrl+PageUp',
  'Ctrl+PageDown',
  'Ctrl+F4',
  'Ctrl+1',
  'Ctrl+2',
  'Ctrl+3',
  'Ctrl+4',
  'Ctrl+5',
  'Ctrl+6',
  'Ctrl+7',
  'Ctrl+8',
  'Ctrl+9',
  'Ctrl+0',
  'Ctrl+Equal',
  'Ctrl+Minus',
  'Ctrl+L',
  'Ctrl+D',
  'Ctrl+H',
  'Ctrl+J',
  'Ctrl+K',
  'Ctrl+F',
  'Ctrl+G',
  'Ctrl+Shift+G',
  'Ctrl+R',
  'Ctrl+Shift+R',
  'Ctrl+P',
  'Ctrl+Shift+P',
  'Ctrl+O',
  'Ctrl+U',
  'Ctrl+M',
  'Ctrl+Shift+Delete',
  'Ctrl+Shift+O',
  'Ctrl+Shift+B',
  'Ctrl+Shift+I',
  'Ctrl+Shift+J',
  'Ctrl+Shift+C',
  'Ctrl+Shift+M',
  'Alt+Left',
  'Alt+Right',
  'Alt+Home',
  'Alt+D',
  'Alt+F4',
  'F1',
  'F3',
  'F5',
  'F6',
  'F7',
  'F11',
  'F12',
  'Tab',
  'Shift+Tab',
]);

const FIXED_ENGINE_KEYS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Escape', 'Delete', 'Backspace', 'F2']);

export function normalizeBaseKey(e) {
  if (!e) return '';
  const code = e.code || '';
  const raw = e.key || '';
  if (raw === 'Control' || raw === 'Shift' || raw === 'Alt' || raw === 'Meta' || raw === 'Dead' || raw === 'Unidentified') {
    return '';
  }
  if (code === 'Space' || raw === ' ') return 'Space';
  if (/^Key([A-Z])$/.test(code)) return code.slice(3);
  if (/^Digit([0-9])$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/i.test(raw)) return raw.toUpperCase();
  if (code === 'Equal' || raw === '=' || raw === '+') return 'Equal';
  if (code === 'Minus' || raw === '-') return 'Minus';
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Backslash') return '\\';
  if (code === 'Semicolon') return ';';
  if (code === 'Quote') return "'";
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  if (code === 'Backquote') return '`';
  if (raw.startsWith('Arrow')) return raw.slice(5);
  if (raw.length === 1) return raw.toUpperCase();
  return raw;
}

export function normalizeKeyCombo(e) {
  const base = normalizeBaseKey(e);
  if (!base) return '';
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(base);
  return parts.join('+');
}

export function getDefaultShortcutMap() {
  const out = {};
  for (const sc of DEFAULT_SHORTCUTS) out[sc.id] = sc.defaultCombo;
  return out;
}

export function loadCustomShortcuts() {
  const def = getDefaultShortcutMap();
  try {
    const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return def;
    const merged = { ...def };
    const seen = new Set();
    for (const sc of DEFAULT_SHORTCUTS) {
      const cand = typeof parsed[sc.id] === 'string' ? parsed[sc.id].trim() : '';
      if (cand && !BROWSER_RESERVED_COMBOS.has(cand) && !FIXED_ENGINE_KEYS.has(cand) && !seen.has(cand)) {
        merged[sc.id] = cand;
        seen.add(cand);
      } else if (!seen.has(sc.defaultCombo)) {
        merged[sc.id] = sc.defaultCombo;
        seen.add(sc.defaultCombo);
      }
    }
    return merged;
  } catch {
    return def;
  }
}

export function saveCustomShortcuts(bindings) {
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // ignore storage quota errors
  }
}

export function resetCustomShortcuts() {
  const def = getDefaultShortcutMap();
  saveCustomShortcuts(def);
  return def;
}

export function validateShortcutRebind(actionId, combo, currentBindings, t) {
  if (!combo) {
    return { ok: false, reason: t('shortcutsErrInvalid') };
  }
  if (FIXED_ENGINE_KEYS.has(combo)) {
    return { ok: false, reason: t('shortcutsErrReservedFixed').replace('{combo}', combo) };
  }
  if (BROWSER_RESERVED_COMBOS.has(combo)) {
    return { ok: false, reason: t('shortcutsErrBrowser').replace('{combo}', combo) };
  }
  for (const sc of DEFAULT_SHORTCUTS) {
    if (sc.id === actionId) continue;
    if ((currentBindings[sc.id] || sc.defaultCombo) === combo) {
      return {
        ok: false,
        conflictId: sc.id,
        reason: t('shortcutsErrDuplicate').replace('{combo}', combo).replace('{action}', t(sc.labelKey)),
      };
    }
  }
  return { ok: true };
}

export class ShortcutsModal {
  constructor(getTranslator, getBindings, callbacks = {}) {
    this.getTranslator = getTranslator;
    this.getBindings = getBindings;
    this.callbacks = callbacks; // { onUpdateBindings, onNotify }
    this.isOpen = false;
    this.capturingId = null;
    this.errorMsg = '';
    this.searchQuery = '';
    this.activeFilter = 'all';
    this.rootEl = null;
    this._onCaptureKeyDown = this._onCaptureKeyDown.bind(this);
  }

  _ensureRoot() {
    if (this.rootEl) return;
    const el = document.createElement('div');
    el.id = 'chemlab-shortcuts-modal';
    el.className = 'storage-modal-backdrop hidden';
    el.addEventListener('click', (e) => {
      if (e.target === el) this.close();
    });
    document.body.appendChild(el);
    this.rootEl = el;
  }

  open() {
    this._ensureRoot();
    this.isOpen = true;
    this.capturingId = null;
    this.errorMsg = '';
    this.searchQuery = '';
    this.activeFilter = 'all';
    this.rootEl.classList.remove('hidden');
    window.addEventListener('keydown', this._onCaptureKeyDown, true);
    this.render();
  }

  close() {
    this.isOpen = false;
    this.capturingId = null;
    this.errorMsg = '';
    this.rootEl?.classList.add('hidden');
    window.removeEventListener('keydown', this._onCaptureKeyDown, true);
  }

  _onCaptureKeyDown(e) {
    if (!this.isOpen || !this.capturingId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      this.capturingId = null;
      this.errorMsg = '';
      this.render();
      return;
    }
    const combo = normalizeKeyCombo(e);
    if (!combo) return;
    const t = this.getTranslator();
    const cur = this.getBindings();
    const res = validateShortcutRebind(this.capturingId, combo, cur, t);
    if (!res.ok) {
      this.errorMsg = res.reason;
      this.render();
      return;
    }
    const next = { ...cur, [this.capturingId]: combo };
    saveCustomShortcuts(next);
    this.callbacks.onUpdateBindings?.(next);
    this.callbacks.onNotify?.(`⌨️ ${t('shortcutsSavedToast').replace('{combo}', combo)}`);
    this.capturingId = null;
    this.errorMsg = '';
    this.render();
  }

  _renderShortcutRowHtml(sc, bindings, t) {
    const combo = bindings[sc.id] || sc.defaultCombo;
    const isModified = combo !== sc.defaultCombo;
    const isCap = this.capturingId === sc.id;
    return `
      <tr class="border-b border-theme/40 last:border-b-0">
        <td class="py-2 pr-3 text-xs text-main">${t(sc.labelKey)}</td>
        <td class="py-2 px-2">
          <div class="flex flex-wrap items-center gap-1.5 justify-center">
            <kbd class="sc-kbd ${isModified ? 'sc-kbd--modified' : ''}">${isCap ? '...' : combo}</kbd>
            ${
              isModified
                ? `<span class="inline-flex items-center gap-1 text-[10.5px] text-muted whitespace-nowrap">
                     <span class="px-1.5 py-0.5 rounded bg-accent/15 text-accent font-semibold">${t('shortcutsModifiedTag')}</span>
                     <span>${t('shortcutsDefaultPrefix')}</span>
                     <kbd class="sc-kbd sc-kbd--default">${sc.defaultCombo}</kbd>
                   </span>`
                : ''
            }
          </div>
        </td>
        <td class="py-2 pl-2 text-right whitespace-nowrap">
          <div class="inline-flex items-center gap-1 justify-end">
            ${
              isModified
                ? `<button type="button" class="sc-row-reset-btn px-2 py-1 rounded border border-theme bg-surface hover:border-accent text-[11px] font-bold text-main" data-sc-id="${sc.id}" title="${t('shortcutsBtnResetRow')}">↺</button>`
                : ''
            }
            <button type="button" class="sc-rebind-btn px-2.5 py-1 rounded border text-[11px] font-semibold ${
              isCap
                ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                : 'border-theme bg-surface hover:border-accent text-main'
            }" data-sc-id="${sc.id}">
              ${isCap ? t('shortcutsListeningBtn') : t('shortcutsBtnRebind')}
            </button>
          </div>
        </td>
      </tr>`;
  }

  _buildBodyHtml(t, bindings) {
    const q = (this.searchQuery || '').trim().toLowerCase();
    const matchesSearch = (label, combo, defCombo = '') => {
      if (!q) return true;
      return `${label} ${combo} ${defCombo}`.toLowerCase().includes(q);
    };
    const showRebindable = this.activeFilter !== 'builtin';
    const showBuiltin = this.activeFilter === 'all' || this.activeFilter === 'builtin';

    const sections = [
      { id: 'lab', title: t('shortcutsFilterLab') },
      { id: 'edit', title: t('shortcutsFilterEdit') },
    ];
    let rebindHtml = '';
    if (showRebindable) {
      for (const sec of sections) {
        if (this.activeFilter !== 'all' && this.activeFilter !== sec.id) continue;
        const items = DEFAULT_SHORTCUTS.filter((sc) => {
          if (sc.group !== sec.id) return false;
          const combo = bindings[sc.id] || sc.defaultCombo;
          return matchesSearch(t(sc.labelKey), combo, sc.defaultCombo);
        });
        if (items.length === 0) continue;
        rebindHtml += `
          <div class="rounded-xl border border-theme bg-surface-alt/70 overflow-hidden">
            <div class="px-3 py-2 border-b border-theme text-[11px] font-bold uppercase tracking-wider text-muted flex items-center justify-between">
              <span>${sec.title}</span>
              <span class="font-mono text-[10px]">(${items.length})</span>
            </div>
            <div class="px-3 overflow-x-auto">
              <table class="w-full text-xs border-collapse">
                <thead>
                  <tr class="text-muted border-b border-theme text-left">
                    <th class="py-1.5 font-semibold">${t('shortcutsColAction')}</th>
                    <th class="py-1.5 font-semibold text-center">${t('shortcutsColKey')}</th>
                    <th class="py-1.5 font-semibold text-right">${t('shortcutsColEdit')}</th>
                  </tr>
                </thead>
                <tbody>${items.map((sc) => this._renderShortcutRowHtml(sc, bindings, t)).join('')}</tbody>
              </table>
            </div>
          </div>`;
      }
    }

    let builtinHtml = '';
    if (showBuiltin) {
      const fixedItems = BUILTIN_SHORTCUT_ROWS.filter((b) => matchesSearch(t(b.labelKey), b.combo));
      const wheelItems = WHEEL_TOOL_ROWS.filter((w) => matchesSearch(t(w.labelKey), w.combo));
      if (fixedItems.length > 0 || wheelItems.length > 0) {
        builtinHtml = `
          <div class="rounded-xl border border-theme bg-surface-alt/70 p-3 flex flex-col gap-3">
            ${
              fixedItems.length > 0
                ? `<div>
                    <div class="text-[11px] font-bold uppercase tracking-wider text-muted mb-2">${t('shortcutsBuiltInHeader')}</div>
                    <div class="sc-wheel-grid">
                      ${fixedItems
                        .map(
                          (b) => `
                        <div class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border border-theme/60 bg-surface text-[11.5px]">
                          <span class="text-main leading-snug">${t(b.labelKey)}</span>
                          <kbd class="sc-kbd shrink-0">${b.combo}</kbd>
                        </div>`
                        )
                        .join('')}
                    </div>
                  </div>`
                : ''
            }
            ${
              wheelItems.length > 0
                ? `<div>
                    <div class="text-[11px] font-bold uppercase tracking-wider text-muted mb-2">🖱️ ${t('shortcutsWheelHeader')}</div>
                    <div class="sc-wheel-grid">
                      ${wheelItems
                        .map(
                          (w) => `
                        <div class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border border-theme/60 bg-surface text-[11.5px]">
                          <span class="text-main leading-snug">${t(w.labelKey)}</span>
                          <kbd class="sc-kbd shrink-0">${w.combo}</kbd>
                        </div>`
                        )
                        .join('')}
                    </div>
                  </div>`
                : ''
            }
          </div>`;
      }
    }

    if (!rebindHtml && !builtinHtml) {
      return `<div class="p-6 text-center text-xs text-muted border border-dashed border-theme rounded-xl">${t('shortcutsNoMatches')}</div>`;
    }
    return rebindHtml + builtinHtml;
  }

  _bindBodyListeners(t) {
    this.rootEl?.querySelectorAll('.sc-rebind-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.scId;
        this.capturingId = this.capturingId === id ? null : id;
        this.errorMsg = '';
        this.render();
      });
    });
    this.rootEl?.querySelectorAll('.sc-row-reset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.scId;
        const sc = DEFAULT_SHORTCUTS.find((s) => s.id === id);
        if (!sc) return;
        const cur = this.getBindings();
        const res = validateShortcutRebind(id, sc.defaultCombo, cur, t);
        if (!res.ok) {
          this.errorMsg = res.reason;
          this.render();
          return;
        }
        const next = { ...cur, [id]: sc.defaultCombo };
        saveCustomShortcuts(next);
        this.callbacks.onUpdateBindings?.(next);
        this.callbacks.onNotify?.(`↺ ${t('shortcutsSavedToast').replace('{combo}', sc.defaultCombo)}`);
        this.capturingId = null;
        this.errorMsg = '';
        this.render();
      });
    });
  }

  _updateBodyOnly() {
    if (!this.rootEl) return;
    const t = this.getTranslator();
    const bindings = this.getBindings();
    const bodyEl = this.rootEl.querySelector('#shortcuts-modal-body');
    if (bodyEl) {
      bodyEl.innerHTML = this._buildBodyHtml(t, bindings);
      this._bindBodyListeners(t);
    }
  }

  render() {
    if (!this.rootEl || !this.isOpen) return;
    const t = this.getTranslator();
    const bindings = this.getBindings();
    const filters = [
      { id: 'all', label: t('shortcutsFilterAll') },
      { id: 'lab', label: t('shortcutsFilterLab') },
      { id: 'edit', label: t('shortcutsFilterEdit') },
      { id: 'builtin', label: t('shortcutsFilterBuiltin') },
    ];

    this.rootEl.innerHTML = `
      <div class="shortcuts-modal-card">
        <div class="shortcuts-modal-header">
          <div class="min-w-0">
            <h2 class="text-sm font-bold flex items-center gap-1.5">⌨️ ${t('shortcutsModalTitle')}</h2>
            <p class="text-[11px] text-muted mt-0.5 leading-snug">${t('shortcutsModalSubtitle')}</p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" id="sc-reset-defaults" class="px-2.5 py-1 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent text-main whitespace-nowrap">${t('shortcutsBtnReset')}</button>
            <button type="button" id="sc-modal-close" class="px-2.5 py-1 rounded-lg border border-theme bg-surface text-xs font-bold hover:border-accent text-main">✕</button>
          </div>
        </div>

        <div class="shortcuts-toolbar">
          <div class="flex flex-wrap items-center gap-2">
            <input
              type="search"
              id="sc-search-input"
              value="${String(this.searchQuery || '').replace(/"/g, '&quot;')}"
              placeholder="🔍 ${t('shortcutsSearchPlaceholder')}"
              class="flex-1 min-w-[180px] px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs text-main focus:outline-none focus:border-accent"
            />
            <div class="flex flex-wrap items-center gap-1.5" id="sc-filter-bar">
              ${filters
                .map(
                  (f) => `<button type="button" class="sc-cat-pill ${this.activeFilter === f.id ? 'is-active' : ''}" data-sc-filter="${f.id}">${f.label}</button>`
                )
                .join('')}
            </div>
          </div>
          ${
            this.errorMsg
              ? `<div id="sc-conflict-error" class="px-3 py-2 rounded-lg border border-red-500/50 bg-red-500/15 text-red-400 text-xs font-semibold">⚠️ ${this.errorMsg}</div>`
              : this.capturingId
              ? `<div class="px-3 py-2 rounded-lg border border-amber-500/50 bg-amber-500/15 text-amber-400 text-xs font-semibold">🎹 ${t('shortcutsListeningPrompt')}</div>`
              : ''
          }
        </div>

        <div class="shortcuts-body" id="shortcuts-modal-body">
          ${this._buildBodyHtml(t, bindings)}
        </div>
      </div>
    `;

    this.rootEl.querySelector('#sc-modal-close')?.addEventListener('click', () => this.close());
    this.rootEl.querySelector('#sc-reset-defaults')?.addEventListener('click', () => {
      const def = resetCustomShortcuts();
      this.capturingId = null;
      this.errorMsg = '';
      this.callbacks.onUpdateBindings?.(def);
      this.callbacks.onNotify?.(`🔄 ${t('shortcutsResetDone')}`);
      this.render();
    });
    this.rootEl.querySelector('#sc-search-input')?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value || '';
      this._updateBodyOnly();
    });
    this.rootEl.querySelectorAll('.sc-cat-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeFilter = btn.dataset.scFilter || 'all';
        this.render();
      });
    });
    this._bindBodyListeners(t);
  }
}
