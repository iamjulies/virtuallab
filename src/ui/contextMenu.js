import { APPARATUS } from '../data/apparatus.js';
import { SPECIES, STARTER_REAGENTS } from '../data/species.js';
import { kelvinToCelsius } from '../data/constants.js';
import { buildVlabFilename, VLAB_SCOPES } from '../storage/workspaceStorage.js';

export const STICKY_NOTE_COLORS = [
  { id: 'yellow', hex: '#fef08a', labelVi: 'Vàng pastel', labelEn: 'Pastel Yellow' },
  { id: 'pink', hex: '#fbcfe8', labelVi: 'Hồng nhạt', labelEn: 'Soft Pink' },
  { id: 'sky', hex: '#bae6fd', labelVi: 'Xanh dương', labelEn: 'Sky Blue' },
  { id: 'mint', hex: '#bbf7d0', labelVi: 'Xanh bạc hà', labelEn: 'Mint Green' },
  { id: 'lavender', hex: '#e9d5ff', labelVi: 'Tím oải hương', labelEn: 'Lavender' },
];

export class FloatingContextUI {
  constructor() {
    this.menuEl = null;
    this.dialogEl = null;
    this._outsideBound = false;
    this._activeDialogKeyHandler = null;
    this._ensureElements();
  }

  _ensureElements() {
    if (!this.menuEl) {
      let m = document.getElementById('chemlab-context-menu');
      if (!m) {
        m = document.createElement('div');
        m.id = 'chemlab-context-menu';
        m.className = 'chemlab-context-menu hidden';
        document.body.appendChild(m);
      }
      this.menuEl = m;
    }
    if (!this.dialogEl) {
      let d = document.getElementById('chemlab-quick-dialog');
      if (!d) {
        d = document.createElement('div');
        d.id = 'chemlab-quick-dialog';
        d.className = 'storage-modal-backdrop hidden';
        document.body.appendChild(d);
      }
      this.dialogEl = d;
    }
    if (!this._outsideBound) {
      this._outsideBound = true;
      window.addEventListener(
        'pointerdown',
        (e) => {
          if (this.menuEl && !this.menuEl.classList.contains('hidden')) {
            if (!(e.target instanceof Node) || !this.menuEl.contains(e.target)) {
              this.closeMenu();
            }
          }
        },
        { capture: true }
      );
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.closeMenu();
      });
      window.addEventListener('blur', () => this.closeMenu());
    }
  }

  isMenuOpen() {
    return Boolean(this.menuEl && !this.menuEl.classList.contains('hidden'));
  }

  isDialogOpen() {
    return Boolean(this.dialogEl && !this.dialogEl.classList.contains('hidden'));
  }

  closeMenu() {
    if (this.menuEl) {
      this.menuEl.classList.add('hidden');
      this.menuEl.style.display = 'none';
      this.menuEl.innerHTML = '';
    }
  }

  closeDialog() {
    if (this.dialogEl) this.dialogEl.classList.add('hidden');
    if (this._activeDialogKeyHandler) {
      window.removeEventListener('keydown', this._activeDialogKeyHandler);
      this._activeDialogKeyHandler = null;
    }
  }

  /**
   * Show floating right-click menu at (clientX, clientY), clamped cleanly inside viewport bounds.
   * items: Array<{ label, shortcut?, disabled?, danger?, separator?, submenu?, onClick? }>
   */
  showMenu(clientX, clientY, items = []) {
    if (!this.menuEl) return;
    this.menuEl.innerHTML = '';
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'chemlab-ctx-sep';
        this.menuEl.appendChild(sep);
        continue;
      }
      if (Array.isArray(item.submenu) && item.submenu.length > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'chemlab-ctx-item-wrap';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chemlab-ctx-item';
        btn.innerHTML = `<span>${item.label}</span><span class="chemlab-ctx-kbd">▸</span>`;
        const sub = document.createElement('div');
        sub.className = 'chemlab-ctx-submenu';
        for (const subItem of item.submenu) {
          const sb = document.createElement('button');
          sb.type = 'button';
          sb.className = 'chemlab-ctx-item';
          sb.textContent = subItem.label;
          sb.disabled = Boolean(subItem.disabled);
          sb.addEventListener('click', () => {
            this.closeMenu();
            subItem.onClick?.();
          });
          sub.appendChild(sb);
        }
        wrap.appendChild(btn);
        wrap.appendChild(sub);
        this.menuEl.appendChild(wrap);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `chemlab-ctx-item${item.danger ? ' danger' : ''}`;
      btn.disabled = Boolean(item.disabled);
      btn.innerHTML = `<span>${item.label}</span>${
        item.shortcut ? `<span class="chemlab-ctx-kbd">${item.shortcut}</span>` : ''
      }`;
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        this.closeMenu();
        item.onClick?.();
      });
      this.menuEl.appendChild(btn);
    }

    this.menuEl.style.display = '';
    this.menuEl.classList.remove('hidden');
    this.menuEl.style.left = `${clientX}px`;
    this.menuEl.style.top = `${clientY}px`;
    // Clamp inside viewport cleanly after layout
    const rect = this.menuEl.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 10);
    const maxY = Math.max(8, window.innerHeight - rect.height - 10);
    this.menuEl.style.left = `${Math.max(8, Math.min(maxX, clientX))}px`;
    this.menuEl.style.top = `${Math.max(8, Math.min(maxY, clientY))}px`;
  }

  /**
   * Show `Thông tin*` datasheet modal for an Apparatus instance, Shelf Apparatus spec, or Reagent card.
   */
  showInfoModal({ kind, item, typeId, reagentId }, t, langCode) {
    if (!this.dialogEl) return;
    this.closeDialog();
    const isEn = langCode === 'en';
    let title = '';
    let badge = '';
    let rows = [];

    if (kind === 'reagent') {
      const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
      const sp = reg ? SPECIES[reg.speciesId] : null;
      title = reg ? t(reg.i18nKey) : reagentId;
      badge = sp?.formula || reg?.formula || '';
      rows = [
        [isEn ? 'IUPAC Name' : 'Tên IUPAC', sp?.name || title],
        [isEn ? 'Formula / Species ID' : 'Công thức / Mã', `${badge} (${reg?.speciesId || ''})`],
        [isEn ? 'Physical Phase' : 'Trạng thái', reg?.kind === 'liquid' ? (isEn ? 'Liquid / Solution' : 'Lỏng / Dung dịch') : (isEn ? 'Solid' : 'Rắn')],
        [isEn ? 'Molar Mass' : 'Khối lượng mol', sp?.molarMass ? `${sp.molarMass.toFixed(3)} g/mol` : '—'],
        [isEn ? 'Density' : 'Khối lượng riêng', sp?.density ? `${sp.density} g/cm³` : '—'],
        [isEn ? 'Melting Point' : 'Điểm nóng chảy', sp?.meltTempK ? `${(sp.meltTempK - 273.15).toFixed(1)} °C (${sp.meltTempK.toFixed(1)} K)` : sp?.noMelt ? (isEn ? 'Decomposes before melting' : 'Phân hủy trước khi chảy') : '—'],
        [isEn ? 'Boiling / Decomp Point' : 'Điểm sôi / Nhiệt phân', sp?.boilTempK ? `${(sp.boilTempK - 273.15).toFixed(1)} °C` : sp?.decompTempK ? `Decomp ${(sp.decompTempK - 273.15).toFixed(1)} °C` : '—'],
        [isEn ? 'Molarity (stock)' : 'Nồng độ chuẩn', reg?.molarity ? `${reg.molarity} M` : 'Pure / Solid'],
        [isEn ? 'Description' : 'Mô tả hóa chất', reg ? t(reg.descKey) : '—'],
      ];
    } else {
      const resolvedId = item?.typeId || typeId;
      const spec = APPARATUS[resolvedId] || {};
      title = spec.i18nKey ? `${t(spec.i18nKey)}${item?.label ? ` ${item.label}` : ''}` : resolvedId;
      badge = spec.isoStandard || spec.kind || resolvedId;
      rows = [
        [isEn ? 'Material Spec' : 'Vật liệu chế tạo', spec.materialSpec || 'Borosilicate / Lab Grade'],
        [isEn ? 'ISO / Standard' : 'Tiêu chuẩn', spec.isoStandard || '—'],
        [isEn ? 'Dimensions (Ø × H)' : 'Kích thước (Ø × H)', spec.diameterMm ? `${spec.diameterMm} mm × ${spec.heightMm || '—'} mm` : '—'],
        [isEn ? 'Nominal Capacity' : 'Dung tích định mức', spec.maxVolumeMl ? `${spec.maxVolumeMl} mL` : '—'],
        [isEn ? 'Tare Mass' : 'Khối lượng vỏ', Number.isFinite(spec.tareMassG) ? `${spec.tareMassG.toFixed(1)} g` : '—'],
        [isEn ? 'Max Thermal Tolerance' : 'Giới hạn chịu nhiệt', spec.maxThermalStressK ? `~${Math.round(spec.maxThermalStressK - 273.15)} °C` : '—'],
        [isEn ? 'Gauge Pressure Rating' : 'Áp suất giới hạn', spec.popOverpressureBar ? `+${spec.popOverpressureBar} bar (pop)` : spec.lidPopOverpressureBar ? `+${spec.lidPopOverpressureBar} bar (lid pop)` : (isEn ? 'Open / Atmospheric' : 'Hệ hở / Khí quyển')],
      ];
      if (item && item.kind === 'vessel') {
        const tempC = kelvinToCelsius(item.tempK ?? 298.15).toFixed(1);
        const contents = Object.entries(item.moles || {})
          .filter(([, n]) => Number(n) > 1e-10)
          .map(([id, n]) => `${SPECIES[id]?.formula || id}: ${(Number(n) * 1000).toFixed(2)} mmol`)
          .join(', ');
        rows.push([isEn ? 'Current Temp' : 'Nhiệt độ hiện tại', `${tempC} °C`]);
        rows.push([isEn ? 'Contents' : 'Hóa chất hiện có', contents || (isEn ? 'Empty' : 'Rỗng')]);
        if (item.stickyLabel?.text) {
          rows.push([isEn ? 'Sticky Label' : 'Nhãn dán ghi chú', item.stickyLabel.text]);
        }
      }
    }

    this.dialogEl.innerHTML = `
      <div class="storage-modal-card" style="max-width:480px">
        <div class="storage-modal-header">
          <div>
            <h2 class="text-sm sm:text-base font-bold">${title}</h2>
            <p class="text-[11px] font-mono text-muted">${badge}</p>
          </div>
          <button type="button" id="dlg-close" class="w-8 h-8 rounded-lg border border-theme bg-surface text-muted hover:text-main flex items-center justify-center text-sm font-bold">✕</button>
        </div>
        <div class="storage-modal-body">
          <div class="info-datasheet-grid">
            ${rows
              .map(
                ([k, v]) => `
              <div class="info-datasheet-row">
                <span class="text-xs text-muted">${k}</span>
                <span class="text-xs font-semibold text-main text-right">${v}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      </div>
    `;
    this.dialogEl.classList.remove('hidden');
    this.dialogEl.querySelector('#dlg-close')?.addEventListener('click', () => this.closeDialog());
    this.dialogEl.onclick = (e) => {
      if (e.target === this.dialogEl) this.closeDialog();
    };
  }

  /**
   * Show Sticky Label editor modal for a vessel.
   */
  showStickyLabelDialog(vessel, t, langCode, onSave) {
    if (!this.dialogEl || !vessel) return;
    this.closeDialog();
    const curText = vessel.stickyLabel?.text || '';
    let selectedBg = vessel.stickyLabel?.bgColor || STICKY_NOTE_COLORS[0].hex;
    const isEn = langCode === 'en';

    this.dialogEl.innerHTML = `
      <div class="storage-modal-card" style="max-width:410px">
        <div class="storage-modal-header">
          <h2 class="text-sm sm:text-base font-bold">🏷️ ${t('stickyLabelTitle')} (${vessel.label})</h2>
          <button type="button" id="dlg-close" class="w-8 h-8 rounded-lg border border-theme bg-surface text-muted hover:text-main flex items-center justify-center text-sm font-bold">✕</button>
        </div>
        <div class="storage-modal-body">
          <input id="sticky-label-input" type="text" maxlength="30" value="${curText.replace(/"/g, '&quot;')}"
            placeholder="${t('stickyLabelPlaceholder')}" class="storage-input" />
          <div class="flex items-center justify-between text-[11px] text-muted">
            <span>${isEn ? 'Paper note color (max 30 chars):' : 'Màu giấy ghi chú (tối đa 30 ký tự):'}</span>
            <span id="sticky-char-count">${curText.length}/30</span>
          </div>
          <div class="flex items-center gap-2">
            ${STICKY_NOTE_COLORS.map(
              (c) => `
              <button type="button" data-note-col="${c.hex}" title="${isEn ? c.labelEn : c.labelVi}"
                class="sticky-color-dot ${selectedBg === c.hex ? 'active' : ''}"
                style="background:${c.hex}"></button>
            `
            ).join('')}
          </div>
          <div class="flex items-center gap-2 pt-2">
            <button type="button" id="sticky-save-btn" class="storage-btn storage-btn-primary flex-1">${isEn ? 'Save Label' : 'Lưu nhãn dán'}</button>
            <button type="button" id="sticky-clear-btn" class="storage-btn storage-btn-danger">${t('stickyLabelClear')}</button>
          </div>
        </div>
      </div>
    `;
    this.dialogEl.classList.remove('hidden');
    const inp = this.dialogEl.querySelector('#sticky-label-input');
    const cnt = this.dialogEl.querySelector('#sticky-char-count');
    inp?.focus();
    inp?.select();
    inp?.addEventListener('input', () => {
      if (cnt) cnt.textContent = `${inp.value.length}/30`;
    });
    this.dialogEl.querySelectorAll('[data-note-col]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedBg = btn.dataset.noteCol;
        this.dialogEl.querySelectorAll('[data-note-col]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
    const commit = () => {
      const text = (inp?.value || '').trim().slice(0, 30);
      this.closeDialog();
      onSave(text ? { text, bgColor: selectedBg } : null);
    };
    this.dialogEl.querySelector('#sticky-save-btn')?.addEventListener('click', commit);
    this.dialogEl.querySelector('#sticky-clear-btn')?.addEventListener('click', () => {
      this.closeDialog();
      onSave(null);
    });
    inp?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
    });
    this.dialogEl.querySelector('#dlg-close')?.addEventListener('click', () => this.closeDialog());
    this.dialogEl.onclick = (e) => {
      if (e.target === this.dialogEl) this.closeDialog();
    };
  }

  /**
   * Show Custom Export Name prompt with live Vietnamese accent-stripped filename preview.
   */
  showExportNameDialog(defaultName, t, langCode, onConfirm) {
    if (!this.dialogEl) return;
    this.closeDialog();
    const initialName = defaultName || (langCode === 'en' ? 'lab-bench' : 'ban-thi-nghiem');
    this.dialogEl.innerHTML = `
      <div class="storage-modal-card" style="max-width:440px">
        <div class="storage-modal-header">
          <h2 class="text-sm sm:text-base font-bold">📤 ${t('exportNamePromptTitle')}</h2>
          <button type="button" id="dlg-close" class="w-8 h-8 rounded-lg border border-theme bg-surface text-muted hover:text-main flex items-center justify-center text-sm font-bold">✕</button>
        </div>
        <div class="storage-modal-body">
          <label class="text-xs text-muted">${t('exportNamePromptLabel')}</label>
          <input id="export-vlab-name-input" type="text" maxlength="60" value="${initialName.replace(/"/g, '&quot;')}" class="storage-input" />
          <div class="p-2.5 rounded-lg border border-theme bg-surface-alt flex flex-col gap-1">
            <span class="text-[11px] text-muted">${t('exportNamePreviewLabel')}</span>
            <code id="export-vlab-preview" class="text-xs font-mono font-bold text-sky-400 break-all"></code>
          </div>
          <div class="flex items-center gap-2 pt-1">
            <button type="button" id="export-vlab-confirm" class="storage-btn storage-btn-primary flex-1">📤 ${t('ctxExportVlab')}</button>
            <button type="button" id="export-vlab-cancel" class="storage-btn">${t('btnClose')}</button>
          </div>
        </div>
      </div>
    `;
    this.dialogEl.classList.remove('hidden');
    const inp = this.dialogEl.querySelector('#export-vlab-name-input');
    const prev = this.dialogEl.querySelector('#export-vlab-preview');
    const updatePreview = () => {
      if (prev) prev.textContent = buildVlabFilename(VLAB_SCOPES.SINGLE_BENCH, inp?.value || '', langCode);
    };
    updatePreview();
    inp?.focus();
    inp?.select();
    inp?.addEventListener('input', updatePreview);
    const submit = () => {
      const val = inp?.value || initialName;
      this.closeDialog();
      onConfirm(val);
    };
    inp?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    this.dialogEl.querySelector('#export-vlab-confirm')?.addEventListener('click', submit);
    this.dialogEl.querySelector('#export-vlab-cancel')?.addEventListener('click', () => this.closeDialog());
    this.dialogEl.querySelector('#dlg-close')?.addEventListener('click', () => this.closeDialog());
    this.dialogEl.onclick = (e) => {
      if (e.target === this.dialogEl) this.closeDialog();
    };
  }

  /**
   * Show Overwrite Bench chooser when 10/10 labs are already open on single-bench import.
   */
  showOverwriteBenchChooser(labs, getLabTitle, t, onPickIndex) {
    if (!this.dialogEl) return;
    this.closeDialog();
    this.dialogEl.innerHTML = `
      <div class="storage-modal-card" style="max-width:440px">
        <div class="storage-modal-header">
          <h2 class="text-sm sm:text-base font-bold">⚠️ ${t('overwriteTabTitle')}</h2>
          <button type="button" id="dlg-close" class="w-8 h-8 rounded-lg border border-theme bg-surface text-muted hover:text-main flex items-center justify-center text-sm font-bold">✕</button>
        </div>
        <div class="storage-modal-body">
          <div class="flex flex-col gap-1.5">
            ${labs
              .map(
                (lab, idx) => `
              <button type="button" data-ow-idx="${idx}" class="storage-btn" style="justify-content:space-between;width:100%">
                <span>🧪 ${getLabTitle(lab)}</span>
                <span class="text-[11px] font-mono text-muted">${lab.sim.items.length} items</span>
              </button>
            `
              )
              .join('')}
          </div>
          <button type="button" id="dlg-cancel" class="storage-btn storage-btn-danger">${t('btnClose')}</button>
        </div>
      </div>
    `;
    this.dialogEl.classList.remove('hidden');
    this.dialogEl.querySelectorAll('[data-ow-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.owIdx);
        this.closeDialog();
        onPickIndex(idx);
      });
    });
    this.dialogEl.querySelector('#dlg-cancel')?.addEventListener('click', () => this.closeDialog());
    this.dialogEl.querySelector('#dlg-close')?.addEventListener('click', () => this.closeDialog());
  }

  /**
   * Fast keyboard-friendly confirmation modal (`Enter` confirms, `Esc` cancels).
   */
  showConfirmDialog({ title, desc, confirmLabel, cancelLabel, danger = true }, onConfirm) {
    if (!this.dialogEl) return;
    this.closeDialog();
    this.dialogEl.innerHTML = `
      <div class="storage-modal-card" style="max-width:420px">
        <div class="storage-modal-header">
          <h2 class="text-sm sm:text-base font-bold">⚠️ ${title}</h2>
          <button type="button" id="dlg-close" class="w-8 h-8 rounded-lg border border-theme bg-surface text-muted hover:text-main flex items-center justify-center text-sm font-bold">✕</button>
        </div>
        <div class="storage-modal-body">
          <p class="text-xs text-muted leading-relaxed">${desc}</p>
          <div class="flex items-center gap-2 pt-1">
            <button type="button" id="dlg-confirm" class="storage-btn ${danger ? 'storage-btn-danger' : 'storage-btn-primary'} flex-1">${confirmLabel}</button>
            <button type="button" id="dlg-cancel" class="storage-btn">${cancelLabel}</button>
          </div>
        </div>
      </div>
    `;
    this.dialogEl.classList.remove('hidden');
    const accept = () => {
      this.closeDialog();
      onConfirm?.();
    };
    this.dialogEl.querySelector('#dlg-confirm')?.addEventListener('click', accept);
    this.dialogEl.querySelector('#dlg-cancel')?.addEventListener('click', () => this.closeDialog());
    this.dialogEl.querySelector('#dlg-close')?.addEventListener('click', () => this.closeDialog());
    this._activeDialogKeyHandler = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        accept();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeDialog();
      }
    };
    window.addEventListener('keydown', this._activeDialogKeyHandler);
  }
}
