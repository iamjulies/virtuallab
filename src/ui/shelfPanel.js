import { APPARATUS, APPARATUS_ORDER } from '../data/apparatus.js';
import { STARTER_REAGENTS } from '../data/species.js';

function apparatusSvg(typeId) {
  switch (typeId) {
    case 'beaker_250':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 10l3 2.5v14.5a3 3 0 003 3h14a3 3 0 003-3V12l2-2"/><path d="M12 16h5M12 21h7M12 26h5" opacity="0.6"/></svg>`;
    case 'beaker_tall_250':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6l3 2.5v18.5a3 3 0 003 3h8a3 3 0 003-3V8.5l2-2.5"/><path d="M14 13h4M14 18h6M14 23h4" opacity="0.6"/></svg>`;
    case 'erlenmeyer_250':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 6h10M14.5 6v6.5l-7 13.5a3 3 0 002.6 4h15.8a3 3 0 002.6-4l-7-13.5V6"/><path d="M12 23h12" opacity="0.5"/></svg>`;
    case 'test_tube_50':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 6h10M14 6v19a4 4 0 008 0V6"/><path d="M15 18h6" opacity="0.5"/></svg>`;
    case 'cylinder_100':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 5h8v22h-8z"/><path d="M9 30h18"/><path d="M16 11h4M16 16h3M16 21h4" opacity="0.6"/></svg>`;
    case 'scale':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="18" width="24" height="11" rx="2"/><path d="M9 14h18M18 14v4"/><rect x="10" y="21" width="16" height="5" rx="1" opacity="0.65"/></svg>`;
    case 'burner':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 15h20M11 15l-3 15M25 15l3 15"/><rect x="13" y="23" width="10" height="7" rx="2"/><path d="M18 16c-2 2.5-2.5 4.5 0 6 2.5-1.5 2-3.5 0-6z" fill="#f97316" stroke="none"/></svg>`;
    case 'gas_syringe':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="13" width="16" height="10" rx="1"/><path d="M3 18h4M20 14v8M20 18h11M31 14v8"/></svg>`;
    case 'pipette_10':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 9a3 3 0 016 0v3h-6V9z" fill="currentColor" opacity="0.35"/><path d="M15 12h6l-1.2 14-1.8 5-1.8-5L15 12z"/><path d="M16 16h2.5M16.2 20h2" opacity="0.65"/></svg>`;
    default:
      return '';
  }
}

function reagentIconSvg(reg) {
  if (reg.id === 'na') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0">
      <rect x="8" y="9" width="20" height="22" rx="3" fill="rgba(250, 204, 21, 0.2)" stroke="#ca8a04" stroke-width="1.5"/>
      <rect x="11" y="5" width="14" height="4" rx="1" fill="#475569"/>
      <rect x="10" y="13" width="16" height="16" rx="2" fill="rgba(253, 224, 71, 0.25)"/>
      <polygon points="14,19 21,18 22,25 15,26" fill="#cbd5e1" stroke="#64748b" stroke-width="1"/>
    </svg>`;
  }
  if (reg.id === 'cuso4_5h2o') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0">
      <rect x="8" y="9" width="20" height="22" rx="3" fill="rgba(14,165,233,0.12)" stroke="#64748b" stroke-width="1.5"/>
      <rect x="11" y="5" width="14" height="4" rx="1" fill="#334155"/>
      <polygon points="12,28 15,20 20,23 18,29" fill="#0284c7" stroke="#7dd3fc" stroke-width="0.8"/>
      <polygon points="19,29 22,21 26,26 24,29" fill="#0369a1" stroke="#7dd3fc" stroke-width="0.8"/>
    </svg>`;
  }
  if (reg.id === 'agno3') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0">
      <rect x="9" y="9" width="18" height="22" rx="3" fill="rgba(146, 64, 14, 0.45)" stroke="#92400e" stroke-width="1.5"/>
      <rect x="12" y="5" width="12" height="4" rx="1" fill="#1e293b"/>
      <rect x="13" y="23" width="4" height="4" fill="#f8fafc"/>
      <rect x="18" y="24" width="4" height="3" fill="#e2e8f0"/>
    </svg>`;
  }
  if (reg.id === 'naoh') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0">
      <rect x="8" y="9" width="20" height="22" rx="3" fill="rgba(226,232,240,0.14)" stroke="#64748b" stroke-width="1.5"/>
      <rect x="11" y="5" width="14" height="4" rx="1" fill="#475569"/>
      <circle cx="14" cy="26" r="2.5" fill="#f8fafc" stroke="#94a3b8" stroke-width="0.7"/>
      <circle cx="20" cy="26.5" r="2.5" fill="#f8fafc" stroke="#94a3b8" stroke-width="0.7"/>
      <circle cx="17" cy="22" r="2.3" fill="#ffffff" stroke="#94a3b8" stroke-width="0.7"/>
    </svg>`;
  }
  if (reg.id === 'zn') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0">
      <rect x="8" y="9" width="20" height="22" rx="3" fill="rgba(148,163,184,0.12)" stroke="#64748b" stroke-width="1.5"/>
      <rect x="11" y="5" width="14" height="4" rx="1" fill="#334155"/>
      <polygon points="12,28 14,22 18,24 17,28" fill="#94a3b8" stroke="#475569" stroke-width="0.8"/>
      <polygon points="19,28 21,21 25,24 23,28" fill="#cbd5e1" stroke="#475569" stroke-width="0.8"/>
    </svg>`;
  }
  if (reg.id === 'phen') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0">
      <rect x="11" y="13" width="14" height="17" rx="3" fill="rgba(244,114,182,0.18)" stroke="#64748b" stroke-width="1.5"/>
      <path d="M15 13V9h6v4" stroke="#64748b" stroke-width="1.4" fill="none"/>
      <path d="M16 9V5a2 2 0 014 0v4" fill="#ec4899"/>
      <rect x="13" y="20" width="10" height="8" rx="1" fill="rgba(244,114,182,0.35)"/>
    </svg>`;
  }
  if (reg.id === 'hcl_37') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0">
      <path d="M13 5h10v5l4 5v14a2 2 0 01-2 2H11a2 2 0 01-2-2V15l4-5V5z" fill="rgba(226,232,240,0.15)" stroke="#ef4444" stroke-width="1.5"/>
      <rect x="11" y="19" width="14" height="10" fill="rgba(226,232,240,0.35)"/>
      <path d="M14 2c2 1 1 3 0 4M20 2c2 1 1 3 0 4" stroke="#94a3b8" stroke-width="1.2" fill="none"/>
    </svg>`;
  }
  // H2O
  return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0">
    <path d="M13 5h10v5l4 5v14a2 2 0 01-2 2H11a2 2 0 01-2-2V15l4-5V5z" fill="rgba(56,189,248,0.15)" stroke="#38bdf8" stroke-width="1.5"/>
    <rect x="11" y="17" width="14" height="12" fill="rgba(56,189,248,0.45)"/>
  </svg>`;
}

export class ShelfPanel {
  constructor(container, sim, getLang, callbacks) {
    this.container = container;
    this.sim = sim;
    this.getLang = getLang;
    this.callbacks = callbacks; // { onAddApparatus, onSelectReagent }
  }

  render(t) {
    const pipettes = this.sim.items.filter((i) => i.kind === 'pipette');

    this.container.innerHTML = `
      <div class="flex flex-col gap-3">
        <!-- Apparatus Section -->
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <h2 class="text-xs font-bold uppercase tracking-wider text-muted">${t('equipmentTitle')}</h2>
          </div>
          <div class="grid grid-cols-2 gap-1.5" id="shelf-apparatus-grid">
            ${APPARATUS_ORDER.map((id) => {
              const spec = APPARATUS[id];
              return `
                <button
                  type="button"
                  draggable="true"
                  data-apparatus-id="${id}"
                  class="apparatus-card flex items-center gap-1.5 p-1.5 rounded-lg border border-theme bg-surface-alt hover:border-accent transition text-left cursor-grab active:cursor-grabbing"
                  title="${t(spec.i18nKey)}"
                >
                  <span class="text-accent shrink-0">${apparatusSvg(id)}</span>
                  <span class="text-xs font-medium leading-tight line-clamp-2">${t(spec.i18nKey)}</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Pure Reagents Section -->
        <div class="flex flex-col">
          <div class="mb-1.5">
            <h2 class="text-xs font-bold uppercase tracking-wider text-muted">${t('reagentsTitle')}</h2>
            <p class="text-xs text-muted mt-0.5">${t('pureFormNote')}</p>
          </div>
          <div class="space-y-1.5" id="shelf-reagents-list">
            ${STARTER_REAGENTS.map((reg) => `
              <button
                type="button"
                draggable="true"
                data-reagent-id="${reg.id}"
                class="reagent-card w-full flex items-center justify-between gap-2 p-1.5 rounded-lg border border-theme bg-surface-alt hover:border-accent transition text-left cursor-grab active:cursor-grabbing"
              >
                <div class="flex items-center gap-2 min-w-0">
                  ${reagentIconSvg(reg)}
                  <div class="min-w-0">
                    <div class="text-xs font-semibold truncate">${t(reg.i18nKey)}</div>
                    <div class="text-xs text-muted truncate">${t(reg.descKey)}</div>
                  </div>
                </div>
                <span class="text-xs px-1.5 py-0.5 rounded bg-surface border border-theme text-muted shrink-0">
                  ${reg.kind === 'solid' ? 'g' : 'mL'}
                </span>
              </button>
            `).join('')}
          </div>
        </div>

        <!-- Pipette 10 mL Bench Drag & Drop Tool Guide -->
        <div class="p-2.5 rounded-lg border border-theme bg-surface-alt flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold">🧪 ${t('pipetteTool')}</span>
            <button type="button" id="btn-add-pipette" class="px-2 py-0.5 rounded border border-theme bg-surface text-[11px] font-medium hover:border-accent">+ Bench</button>
          </div>
          <p class="text-[11px] text-muted leading-relaxed">${t('pipetteEmpty')}</p>
          ${
            pipettes.length > 0
              ? `<div class="flex flex-wrap gap-1 pt-1 border-t border-theme/50">
                  ${pipettes
                    .map(
                      (p) => `<button type="button" class="bench-pip-select px-2 py-0.5 rounded border ${
                        this.sim.selectedId === p.id ? 'border-accent bg-accent/15 font-semibold' : 'border-theme bg-surface text-muted'
                      } text-[11px] font-mono" data-pip-id="${p.id}">🧪 ${p.label}: ${(p.volumeMl || 0).toFixed(1)}mL</button>`
                    )
                    .join('')}
                </div>`
              : ''
          }
        </div>
      </div>
    `;

    // Bind apparatus drag & click
    this.container.querySelectorAll('.apparatus-card').forEach((el) => {
      const id = el.dataset.apparatusId;
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/apparatus-id', id);
      });
      el.addEventListener('click', () => {
        if (this.callbacks.onAddApparatus) this.callbacks.onAddApparatus(id);
      });
    });

    // Bind reagent drag & click
    this.container.querySelectorAll('.reagent-card').forEach((el) => {
      const id = el.dataset.reagentId;
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/reagent-id', id);
      });
      el.addEventListener('click', () => {
        if (this.callbacks.onSelectReagent) this.callbacks.onSelectReagent(id);
      });
    });

    // Quick add/select bench pipette
    this.container.querySelector('#btn-add-pipette')?.addEventListener('click', () => {
      if (this.callbacks.onAddApparatus) this.callbacks.onAddApparatus('pipette_10');
    });
    this.container.querySelectorAll('.bench-pip-select').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.sim.selectedId = btn.dataset.pipId;
        this.sim.emitChange();
      });
    });
  }
}
