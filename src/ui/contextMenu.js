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

    let extLinks = [];
    const REAGENT_REF_META = {
      h2o: { spId: 'H2O_l', formula: 'H₂O', iupac: 'Oxidane / Water', cas: '7732-18-5', mm: '18.015 g/mol', density: '0.997 g/cm³ (25 °C)', melt: '0.0 °C (273.15 K)', boil: '100.0 °C (373.15 K)', conc: 'Pure (55.34 M)', wiki: 'Water', pubchem: '962' },
      na: { spId: 'Na_s', formula: 'Na', iupac: 'Sodium', cas: '7440-23-5', mm: '22.990 g/mol', density: '0.968 g/cm³', melt: '97.8 °C (370.9 K)', boil: '882.9 °C (1156 K)', conc: 'Pure Metal (s)', wiki: 'Sodium', pubchem: '5360545' },
      zn: { spId: 'Zn_s', formula: 'Zn', iupac: 'Zinc', cas: '7440-66-6', mm: '65.380 g/mol', density: '7.140 g/cm³', melt: '419.5 °C (692.7 K)', boil: '907.0 °C (1180 K)', conc: 'Pure Metal (s)', wiki: 'Zinc', pubchem: '23994' },
      cuso4_5h2o: { spId: 'CuSO4_5H2O_s', formula: 'CuSO₄·5H₂O', iupac: 'Copper(II) sulfate pentahydrate', cas: '7758-99-8', mm: '249.685 g/mol', density: '2.286 g/cm³', melt: '110 °C (-4 H₂O) / 150 °C (anhyd.)', boil: 'Decomp > 650 °C', conc: 'Pure Hydrate Solid', wiki: 'Copper(II)_sulfate', pubchem: '24463' },
      agno3: { spId: 'AgNO3_s', formula: 'AgNO₃', iupac: 'Silver nitrate', cas: '7761-88-8', mm: '169.873 g/mol', density: '4.350 g/cm³', melt: '209.7 °C (482.8 K)', boil: 'Decomp ~440 °C', conc: 'Pure Crystalline Solid', wiki: 'Silver_nitrate', pubchem: '24470' },
      naoh: { spId: 'NaOH_s', formula: 'NaOH', iupac: 'Sodium hydroxide', cas: '1310-73-2', mm: '39.997 g/mol', density: '2.130 g/cm³', melt: '323.0 °C (596.2 K)', boil: '1388.0 °C (1661 K)', conc: 'Pure Pellets (s)', wiki: 'Sodium_hydroxide', pubchem: '14798' },
      hcl_37: { spId: 'H_aq', formula: 'HCl(aq)', iupac: 'Hydrochloric acid', cas: '7647-01-0', mm: '36.461 g/mol (HCl)', density: '1.188 g/cm³ (37% aq)', melt: '-27.3 °C', boil: '~48 °C (outgasses HCl) / 108.6 °C azeotrope', conc: '37% w/w (~12.06 M)', wiki: 'Hydrochloric_acid', pubchem: '313' },
      nh3_25: { spId: 'NH3_aq', formula: 'NH₃(aq)', iupac: 'Azane / Ammonia solution', cas: '1336-21-6', mm: '17.031 g/mol (NH₃)', density: '0.907 g/cm³ (25% aq)', melt: '-58.0 °C', boil: '~37.7 °C (evolves NH₃(g))', conc: '25% w/w (~13.31 M)', wiki: 'Ammonia_solution', pubchem: '222' },
      h2o2_30: { spId: 'H2O2_aq', formula: 'H₂O₂(aq)', iupac: 'Hydrogen peroxide', cas: '7722-84-1', mm: '34.015 g/mol (H₂O₂)', density: '1.110 g/cm³ (30% aq)', melt: '-25.7 °C', boil: '106.2 °C (decomp risk)', conc: '30% w/w (~9.79 M)', wiki: 'Hydrogen_peroxide', pubchem: '784' },
      phen: { spId: 'Phenolphthalein_aq', formula: 'C₂₀H₁₄O₄', iupac: 'Phenolphthalein (1% in EtOH/H₂O)', cas: '77-09-8', mm: '318.328 g/mol', density: '0.850 g/cm³ (solution)', melt: '~-90 °C (soln) / 262.5 °C (pure)', boil: '~80 °C (EtOH/H₂O)', conc: '1% w/v (~0.027 M)', wiki: 'Phenolphthalein', pubchem: '4764' },
      caco3: { spId: 'CaCO3_s', formula: 'CaCO₃', iupac: 'Calcium carbonate', cas: '471-34-1', mm: '100.087 g/mol', density: '2.711 g/cm³', melt: '825 °C (dec. / calcines)', boil: '899 °C (CaCO₃ → CaO + CO₂↑)', conc: 'Pure Mineral Solid', wiki: 'Calcium_carbonate', pubchem: '10112' },
      hno3_68: { spId: 'NO3_aq', formula: 'HNO₃(aq)', iupac: 'Nitric acid', cas: '7697-37-2', mm: '63.013 g/mol (HNO₃)', density: '1.405 g/cm³ (68% aq)', melt: '-38.0 °C', boil: '120.5 °C (68% azeotrope)', conc: '68% w/w (~15.17 M)', wiki: 'Nitric_acid', pubchem: '944' },
      fe: { spId: 'Fe_s', formula: 'Fe', iupac: 'Iron', cas: '7439-89-6', mm: '55.845 g/mol', density: '7.874 g/cm³', melt: '1538.0 °C (1811 K)', boil: '2862.0 °C (3135 K)', conc: 'Pure Metal (s)', wiki: 'Iron', pubchem: '23925' },
      bacl2_2h2o: { spId: 'BaCl2_2H2O_s', formula: 'BaCl₂·2H₂O', iupac: 'Barium chloride dihydrate', cas: '10326-27-9', mm: '244.264 g/mol', density: '3.097 g/cm³', melt: '113 °C (-2 H₂O) / 962 °C (anhyd.)', boil: '1560.0 °C (1833 K)', conc: 'Pure Hydrate Solid', wiki: 'Barium_chloride', pubchem: '25204' },
      nacl: { spId: 'NaCl_s', formula: 'NaCl', iupac: 'Sodium chloride', cas: '7647-14-5', mm: '58.443 g/mol', density: '2.165 g/cm³', melt: '801.0 °C (1074 K)', boil: '1465.0 °C (1738 K)', conc: 'Pure Ionic Solid', wiki: 'Sodium_chloride', pubchem: '5234' },
    };

    if (kind === 'reagent') {
      const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
      const ref = REAGENT_REF_META[reagentId] || {};
      const sp = reg ? SPECIES[reg.speciesId || ref.spId] : null;
      title = reg ? t(reg.i18nKey) : reagentId;
      badge = sp?.formula || ref.formula || reg?.formula || '';
      const spKey = reg?.speciesId || ref.spId || reagentId;
      const molarMassStr = ref.mm || (sp?.molarMass ? `${sp.molarMass.toFixed(3)} g/mol` : '—');
      const densityStr = ref.density || (sp?.density ? `${sp.density} g/cm³` : reg?.densityGPerMl ? `${reg.densityGPerMl} g/cm³` : '—');
      const meltStr = ref.melt || (sp?.meltTempK ? `${(sp.meltTempK - 273.15).toFixed(1)} °C (${sp.meltTempK.toFixed(1)} K)` : sp?.noMelt ? (isEn ? 'Decomposes before melting' : 'Phân hủy trước khi chảy') : '—');
      const boilStr = ref.boil || (sp?.boilTempK ? `${(sp.boilTempK - 273.15).toFixed(1)} °C` : sp?.decompTempK ? `Decomp ${(sp.decompTempK - 273.15).toFixed(1)} °C` : '—');
      const concStr = ref.conc || (reg?.molarity ? `${reg.molarity} M` : reg?.molarityLabel || 'Pure / Solid');
      rows = [
        [isEn ? 'IUPAC Name' : 'Tên IUPAC', ref.iupac || sp?.name || title],
        [isEn ? 'Formula / Species ID' : 'Công thức / Mã', `${badge} (${spKey})`],
        ['CAS Registry No.', ref.cas || '—'],
        [isEn ? 'Physical Phase' : 'Trạng thái', reg?.kind === 'liquid' ? (isEn ? 'Liquid / Solution' : 'Lỏng / Dung dịch') : (isEn ? 'Solid' : 'Rắn')],
        [isEn ? 'Molar Mass' : 'Khối lượng mol', molarMassStr],
        [isEn ? 'Density' : 'Khối lượng riêng', densityStr],
        [isEn ? 'Melting Point' : 'Điểm nóng chảy', meltStr],
        [isEn ? 'Boiling / Decomp Point' : 'Điểm sôi / Nhiệt phân', boilStr],
        [isEn ? 'Molarity / Purity' : 'Nồng độ chuẩn', concStr],
        [isEn ? 'Description' : 'Mô tả hóa chất', reg ? t(reg.descKey) : '—'],
      ];
      if (ref.wiki) extLinks.push({ label: '🌐 Wikipedia ↗', href: `https://en.wikipedia.org/wiki/${ref.wiki}` });
      if (ref.pubchem) extLinks.push({ label: '🔬 PubChem ↗', href: `https://pubchem.ncbi.nlm.nih.gov/compound/${ref.pubchem}` });
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
      const appWikiQ = encodeURIComponent(String(title).replace(/#\d+/g, '').replace(/\(.*?\)/g, '').trim() + ' laboratory equipment');
      extLinks.push({ label: '🌐 Wikipedia ↗', href: `https://en.wikipedia.org/w/index.php?search=${appWikiQ}` });
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
          ${
            extLinks.length > 0
              ? `<div class="flex flex-wrap items-center gap-2 pt-2">${extLinks
                  .map(
                    (lnk) =>
                      `<a href="${lnk.href}" target="_blank" rel="noopener noreferrer" class="storage-btn text-xs" style="text-decoration:none;">${lnk.label}</a>`
                  )
                  .join('')}</div>`
              : ''
          }
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
