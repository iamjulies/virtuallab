const SHORTCUTS_STORAGE_KEY = 'chemlab_custom_shortcuts_v1';

export const DEFAULT_SHORTCUTS = [
  { id: 'empty_item', defaultCombo: 'Q', labelKey: 'scEmptyItem' },
  { id: 'cycle_optics', defaultCombo: 'E', labelKey: 'scCycleOptics' },
  { id: 'toggle_cabinet', defaultCombo: 'B', labelKey: 'scToggleCabinet' },
  { id: 'toggle_uv', defaultCombo: 'L', labelKey: 'scToggleUv' },
  { id: 'toggle_atmosphere', defaultCombo: 'A', labelKey: 'scToggleAtm' },
  { id: 'theme_key', defaultCombo: 'Z', labelKey: 'scThemeKey' },
  { id: 'hold_presets', defaultCombo: 'F', labelKey: 'scHoldPresets' },
  { id: 'new_bench', defaultCombo: 'N', labelKey: 'scNewBench' },
  { id: 'toggle_sound', defaultCombo: 'M', labelKey: 'scToggleSound' },
  { id: 'toggle_lang', defaultCombo: 'K', labelKey: 'scToggleLang' },
  { id: 'temp_up', defaultCombo: 'T', labelKey: 'scTempUp' },
  { id: 'temp_down', defaultCombo: 'Y', labelKey: 'scTempDown' },
  { id: 'press_up', defaultCombo: 'G', labelKey: 'scPressUp' },
  { id: 'press_down', defaultCombo: 'H', labelKey: 'scPressDown' },
  { id: 'speed_up', defaultCombo: 'W', labelKey: 'scSpeedUp' },
  { id: 'speed_down', defaultCombo: 'S', labelKey: 'scSpeedDown' },
  { id: 'reset_bench', defaultCombo: 'R', labelKey: 'scResetBench' },
  { id: 'toggle_pause', defaultCombo: 'Space', labelKey: 'scTogglePause' },
  { id: 'export_vlab', defaultCombo: 'Ctrl+E', labelKey: 'scExportVlab' },
  { id: 'import_vlab', defaultCombo: 'Shift+E', labelKey: 'scImportVlab' },
  { id: 'undo', defaultCombo: 'Ctrl+Z', labelKey: 'scUndo' },
  { id: 'redo', defaultCombo: 'Ctrl+Shift+Z', labelKey: 'scRedo' },
  { id: 'select_all', defaultCombo: 'Ctrl+A', labelKey: 'scSelectAll' },
  { id: 'copy', defaultCombo: 'Ctrl+C', labelKey: 'scCopy' },
  { id: 'cut', defaultCombo: 'Ctrl+X', labelKey: 'scCut' },
  { id: 'paste', defaultCombo: 'Ctrl+V', labelKey: 'scPaste' },
  { id: 'save', defaultCombo: 'Ctrl+S', labelKey: 'scSave' },
];

export const BUILTIN_SHORTCUT_ROWS = [
  { combo: '1 – 9, 0', labelKey: 'scSwitchBench' },
  { combo: 'F2', labelKey: 'scRenameTab' },
  { combo: 'Del / Backspace', labelKey: 'scDeleteSel' },
  { combo: 'Esc', labelKey: 'scCloseOverlay' },
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

  render() {
    if (!this.rootEl || !this.isOpen) return;
    const t = this.getTranslator();
    const bindings = this.getBindings();

    const rowsHtml = DEFAULT_SHORTCUTS.map((sc) => {
      const combo = bindings[sc.id] || sc.defaultCombo;
      const isCap = this.capturingId === sc.id;
      return `
        <tr class="border-b border-theme/50 last:border-0">
          <td class="py-1.5 pr-2 text-xs text-main">${t(sc.labelKey)}</td>
          <td class="py-1.5 px-2 text-center">
            <kbd class="px-2 py-0.5 rounded border border-theme bg-surface text-xs font-mono font-bold text-accent">${isCap ? '...' : combo}</kbd>
          </td>
          <td class="py-1.5 pl-2 text-right">
            <button type="button" class="sc-rebind-btn px-2 py-0.5 rounded border text-[11px] font-semibold ${
              isCap
                ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                : 'border-theme bg-surface hover:border-accent text-main'
            }" data-sc-id="${sc.id}">
              ${isCap ? t('shortcutsListeningBtn') : t('shortcutsBtnRebind')}
            </button>
          </td>
        </tr>`;
    }).join('');

    const builtInHtml = BUILTIN_SHORTCUT_ROWS.map(
      (b) => `
      <div class="flex items-center justify-between gap-2 py-1 text-[11px]">
        <span class="text-muted">${t(b.labelKey)}</span>
        <kbd class="px-1.5 py-0.5 rounded border border-theme bg-surface font-mono font-semibold text-muted">${b.combo}</kbd>
      </div>`
    ).join('');

    this.rootEl.innerHTML = `
      <div class="storage-modal-card" style="max-width:660px;max-height:86vh;display:flex;flex-direction:column;">
        <div class="flex items-center justify-between gap-2 pb-2.5 border-b border-theme">
          <div>
            <h2 class="text-sm font-bold">⌨️ ${t('shortcutsModalTitle')}</h2>
            <p class="text-[11px] text-muted mt-0.5">${t('shortcutsModalSubtitle')}</p>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" id="sc-reset-defaults" class="px-2.5 py-1 rounded-lg border border-theme bg-surface-alt text-xs font-semibold hover:border-accent">${t('shortcutsBtnReset')}</button>
            <button type="button" id="sc-modal-close" class="px-2.5 py-1 rounded-lg border border-theme bg-surface-alt text-xs font-bold hover:border-accent">✕</button>
          </div>
        </div>

        ${
          this.errorMsg
            ? `<div id="sc-conflict-error" class="mt-2 px-3 py-2 rounded-lg border border-red-500/50 bg-red-500/15 text-red-300 text-xs font-semibold">⚠️ ${this.errorMsg}</div>`
            : this.capturingId
            ? `<div class="mt-2 px-3 py-2 rounded-lg border border-amber-500/50 bg-amber-500/15 text-amber-300 text-xs font-semibold">🎹 ${t('shortcutsListeningPrompt')}</div>`
            : ''
        }

        <div class="overflow-y-auto mt-2 pr-1 flex-1">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-muted border-b border-theme text-left">
                <th class="pb-1.5 font-semibold">${t('shortcutsColAction')}</th>
                <th class="pb-1.5 font-semibold text-center">${t('shortcutsColKey')}</th>
                <th class="pb-1.5 font-semibold text-right">${t('shortcutsColEdit')}</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>

          <div class="mt-3 p-2.5 rounded-xl border border-theme bg-surface-alt">
            <div class="text-[11px] font-bold uppercase tracking-wider text-muted mb-1">${t('shortcutsBuiltInHeader')}</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">${builtInHtml}</div>
          </div>
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
    this.rootEl.querySelectorAll('.sc-rebind-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.scId;
        this.capturingId = this.capturingId === id ? null : id;
        this.errorMsg = '';
        this.render();
      });
    });
  }
}
