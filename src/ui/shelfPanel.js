import { APPARATUS, APPARATUS_CATEGORIES, APPARATUS_ORDER } from '../data/apparatus.js';
import { REAGENT_CATEGORIES, STARTER_REAGENTS, getReagentGhsHazards } from '../data/species.js';
import { drawReagentBottle } from '../canvas/reagentRenderer.js';
import { getMissionById, isApparatusAllowedInMission, isReagentAllowedInMission } from '../data/missions.js';

function apparatusSvg(typeId) {
  switch (typeId) {
    case 'beaker_250':
    case 'beaker_tall_250':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 10l3 2.5v14.5a3 3 0 003 3h14a3 3 0 003-3V12l2-2"/><path d="M12 16h5M12 21h7M12 26h5" opacity="0.6"/></svg>`;
    case 'beaker_1000':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8l3 2.5v16.5a3 3 0 003 3h18a3 3 0 003-3V10.5l3-2.5"/><path d="M10 14h6M10 19h8M10 24h6" opacity="0.6"/><text x="22" y="25" text-anchor="middle" font-size="6.5" fill="currentColor" stroke="none" font-weight="bold">1L</text></svg>`;
    case 'erlenmeyer_250':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 6h10M14.5 6v6.5l-7 13.5a3 3 0 002.6 4h15.8a3 3 0 002.6-4l-7-13.5V6"/><path d="M12 23h12" opacity="0.5"/></svg>`;
    case 'erlenmeyer_1000':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 5h10M14.5 5v6l-9 15.5a3 3 0 002.6 4h19.8a3 3 0 002.6-4l-9-15.5V5"/><path d="M10 24h16" opacity="0.45"/><text x="18" y="21" text-anchor="middle" font-size="6.5" fill="currentColor" stroke="none" font-weight="bold">1L</text></svg>`;
    case 'round_flask_250':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 5h8M15 5v7.5a8.5 8.5 0 106 0V5"/><path d="M12 29.5h12" stroke="#d97706" stroke-width="2" stroke-linecap="round"/></svg>`;
    case 'round_flask_1000':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.5 4h7M15.5 4v5.5a10.2 10.2 0 105 0V4"/><path d="M11 30.5h14" stroke="#d97706" stroke-width="2.2" stroke-linecap="round"/><text x="18" y="21.5" text-anchor="middle" font-size="6.2" fill="currentColor" stroke="none" font-weight="bold">1L</text></svg>`;
    case 'test_tube_50':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 6h10M14 6v19a4 4 0 008 0V6"/><path d="M15 18h6" opacity="0.5"/></svg>`;
    case 'cylinder_100':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 5h8v22h-8z"/><path d="M9 30h18"/><path d="M16 11h4M16 16h3M16 21h4" opacity="0.6"/></svg>`;
    case 'scale':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="18" width="24" height="11" rx="2"/><path d="M9 14h18M18 14v4"/><rect x="10" y="21" width="16" height="5" rx="1" opacity="0.65"/></svg>`;
    case 'burner':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 15h20M11 15l-3 15M25 15l3 15"/><rect x="13" y="23" width="10" height="7" rx="2"/><path d="M18 16c-2 2.5-2.5 4.5 0 6 2.5-1.5 2-3.5 0-6z" fill="#f97316" stroke="none"/></svg>`;
    case 'gas_syringe':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="13" width="16" height="10" rx="1"/><path d="M3 18h4M20 14v8M20 18h11M31 14v8"/></svg>`;
    case 'pipette_10':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 9a3 3 0 016 0v3h-6V9z" fill="currentColor" opacity="0.35"/><path d="M15 12h6l-1.2 14-1.8 5-1.8-5L15 12z"/><path d="M16 16h2.5M16.2 20h2" opacity="0.65"/></svg>`;
    case 'retort_stand':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="28" width="24" height="3" rx="1"/><path d="M23 28V6M23 14h-9"/><circle cx="11" cy="14" r="3"/></svg>`;
    case 'filter_funnel':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 9h22l-9 11v10l-4-2V20z"/><path d="M11 9l7 8 7-8" opacity="0.55"/></svg>`;
    case 'separatory_funnel':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M15 4h6v3l-1 1h-4l-1-1V4z" fill="currentColor" opacity="0.3"/><path d="M15 8h6l5 7a8.5 8.5 0 01-6 8.5v7.5l-2 2-2-2v-7.5A8.5 8.5 0 0110 15l5-7z"/><path d="M10.5 16h15" stroke="#38bdf8" stroke-width="1.4"/><path d="M13 26h10" stroke="#0ea5e9" stroke-width="2" stroke-linecap="round"/></svg>`;
    case 'wash_bottle':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="11" y="14" width="14" height="16" rx="3"/><path d="M14 14v-3h8v3M18 11c0-5-5-6-10-4"/><path d="M13 22h10" opacity="0.55"/></svg>`;
    case 'porcelain_dish':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 16c0 8 5 12 12 12s12-4 12-12H6z"/><path d="M9 19c3 3 15 3 18 0" opacity="0.5"/></svg>`;
    case 'water_trough':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="13" width="26" height="15" rx="2"/><path d="M7 20c3-1 5 1 8 0s5-1 8 0 4-1 6 0" stroke="#38bdf8"/></svg>`;
    case 'liebig_condenser':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 16l28 4"/><rect x="9" y="11" width="18" height="10" rx="2" transform="rotate(8 18 16)"/><path d="M14 8v4M22 23v4" opacity="0.65"/></svg>`;
    case 'burette_50':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 5h6v18l-2 7h-2l-2-7z"/><path d="M12 24h12" stroke="#38bdf8"/><path d="M16 10h3M16 14h4M16 18h3" opacity="0.6"/></svg>`;
    case 'splint':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 24l18-10" stroke="#d97706" stroke-width="3" stroke-linecap="round"/><path d="M9 21c-2 2-1.5 4.5.5 5s3.5-1.5 2-4.5z" fill="#f97316" stroke="none"/></svg>`;
    case 'flame_loop':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="24" r="3"/><path d="M11.5 22.5L22 14"/><path d="M22 14l7-5" stroke="#38bdf8" stroke-width="3.2" stroke-linecap="round"/></svg>`;
    case 'litmus_paper':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none"><rect x="7" y="13" width="10" height="10" rx="1" fill="#ef4444"/><rect x="17" y="13" width="12" height="10" rx="1" fill="#8b5cf6" stroke="currentColor" stroke-width="1.2"/></svg>`;
    case 'ph_strip':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none"><rect x="6" y="13" width="6" height="10" fill="#22c55e"/><rect x="12" y="13" width="6" height="10" fill="#eab308"/><rect x="18" y="13" width="6" height="10" fill="#f97316"/><rect x="24" y="13" width="6" height="10" fill="#3b82f6"/></svg>`;
    case 'mortar_pestle':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 17c0 7 4.5 11 11 11s11-4 11-11H7z"/><path d="M19 18l7-10" stroke-width="3" stroke-linecap="round"/></svg>`;
    case 'stir_bar':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="14" width="20" height="8" rx="4" fill="currentColor" opacity="0.25"/><path d="M13 11c3-2 7-2 10 0M13 25c3 2 7 2 10 0" opacity="0.6"/></svg>`;
    case 'boiling_chips':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="8,24 12,17 18,19 16,26" fill="currentColor" opacity="0.45"/><polygon points="17,22 21,15 27,18 25,25" fill="currentColor" opacity="0.3"/><polygon points="12,15 16,10 21,12 18,17" fill="currentColor" opacity="0.55"/><circle cx="15" cy="7" r="1.1" fill="#38bdf8" stroke="none"/><circle cx="21" cy="8.5" r="1.1" fill="#38bdf8" stroke="none"/></svg>`;
    case 'dc_power':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="9" width="24" height="18" rx="3"/><rect x="10" y="13" width="16" height="6" rx="1" fill="#059669" opacity="0.55"/><circle cx="12" cy="23" r="1.8" fill="#ef4444" stroke="none"/><circle cx="24" cy="23" r="1.8" fill="currentColor" stroke="none"/></svg>`;
    case 'volt_ammeter':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="8" width="22" height="20" rx="3" stroke="#f59e0b"/><rect x="10" y="11" width="16" height="7" rx="1" fill="#10b981" opacity="0.5"/><text x="18" y="24" text-anchor="middle" font-size="6.5" fill="currentColor" stroke="none" font-weight="bold">V·A</text></svg>`;
    case 'diffusion_tube':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="14" width="28" height="8" rx="3"/><line x1="21" y1="14" x2="21" y2="22" stroke="#f8fafc" stroke-width="2"/><path d="M11 22v4M25 22v4" opacity="0.65"/></svg>`;
    case 'electrode_rod':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="15" y="9" width="6" height="21" rx="1" fill="currentColor" opacity="0.3"/><rect x="13" y="6" width="10" height="4" rx="1" fill="#ef4444" stroke="none"/></svg>`;
    case 'salt_bridge':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M9 28V14a9 9 0 0118 0v14"/></svg>`;
    case 'bunsen_burner':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 30h18M15 30v-5h6v5M16 25V14h4v11"/><path d="M7 30l4-18h14l4 18M9 12h18" opacity="0.72"/><circle cx="18" cy="22" r="1.4" fill="currentColor"/><path d="M18 4c-2.5 3.5-3 6.5 0 9 3-2.5 2.5-5.5 0-9z" fill="#38bdf8" stroke="none"/></svg>`;
    case 'crucible_porcelain':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 14h16l-2.5 14h-11z"/><path d="M9 11h18"/><circle cx="18" cy="8.5" r="2"/></svg>`;
    case 'quartz_tube':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="14" width="28" height="8" rx="2"/><rect x="13" y="15.5" width="10" height="5" fill="currentColor" opacity="0.25" stroke="none"/><path d="M4 18h2M30 18h2" stroke-width="2.2"/></svg>`;
    case 'quartz_u_tube':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 7v13a9 9 0 0018 0V7"/><path d="M13 7v13a5 5 0 0010 0V7"/><path d="M8 7h6M22 7h6" stroke-width="2"/></svg>`;
    case 'rubber_stopper':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11h18l-2.8 15H11.8L9 11z" fill="currentColor" opacity="0.35"/><path d="M9 11h18l-2.8 15H11.8L9 11z"/><circle cx="18" cy="11" r="2.2" fill="#f59e0b" stroke="none"/></svg>`;
    case 'phen_cotton':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 23a4 4 0 01-.5-7.8 5 5 0 019.2-2.2 4.5 4.5 0 017.8 3.2A4 4 0 0125 23H10z" fill="#f472b6" opacity="0.45"/><path d="M10 23a4 4 0 01-.5-7.8 5 5 0 019.2-2.2 4.5 4.5 0 017.8 3.2A4 4 0 0125 23H10z"/></svg>`;
    case 'iron_spoon':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="18" cy="6.5" r="2.5"/><path d="M18 9v15"/><path d="M12.5 24a5.5 5.5 0 0011 0H12.5z" fill="currentColor" opacity="0.3"/></svg>`;
    case 'thermometer':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="14.5" y="4" width="7" height="21" rx="3.5"/><circle cx="18" cy="27" r="4.2" fill="#e11d48" stroke="currentColor" stroke-width="1.4"/><line x1="18" y1="11" x2="18" y2="25" stroke="#e11d48" stroke-width="2.2"/><path d="M18 8h2M18 12h2M18 16h2M18 20h2" opacity="0.65"/></svg>`;
    case 'ph_conductometer':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="7" y="4" width="22" height="14" rx="3" fill="currentColor" opacity="0.16"/><rect x="10" y="7" width="16" height="8" rx="1.5" fill="#064e3b" stroke="none"/><path d="M18 18v12" stroke-width="2.4"/><circle cx="18" cy="31" r="2.6" fill="#0ea5e9" stroke="none"/></svg>`;
    case 'colorimeter':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="6" y="4" width="24" height="14" rx="3" fill="currentColor" opacity="0.16"/><rect x="9" y="7" width="18" height="8" rx="1.5" fill="#0f172a" stroke="none"/><path d="M18 18v8M13 26h10v6H13z"/><line x1="14" y1="29" x2="22" y2="29" stroke="#22c55e" stroke-width="2"/></svg>`;
    case 'tlc_plate':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="11" y="4" width="14" height="28" rx="1.5" fill="rgba(248,250,252,0.72)"/><line x1="12" y1="26" x2="24" y2="26" stroke-width="1"/><line x1="12" y1="10" x2="24" y2="10" stroke="#0ea5e9" stroke-dasharray="2 2"/><circle cx="16" cy="14" r="1.8" fill="#a855f7" stroke="none"/><circle cx="20" cy="20" r="1.8" fill="#38bdf8" stroke="none"/></svg>`;
    case 'ice_bath':
      return `<svg viewBox="0 0 36 36" class="w-7 h-7 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="13" width="28" height="16" rx="3" fill="rgba(56,189,248,0.22)"/><path d="M3 13h30" stroke-width="2.2"/><rect x="8" y="17" width="6" height="5" rx="1" fill="rgba(255,255,255,0.65)"/><path d="M22 25h6" stroke="#f97316" stroke-width="2"/><path d="M13 6v4M11 8h4" stroke="#38bdf8" stroke-width="1.4"/><path d="M23 5c-1.5 2 1.5 3 0 5" stroke="#f97316" stroke-width="1.4"/></svg>`;
    default:
      return '';
  }
}

function shelfMotifSvg(motif) {
  switch (motif) {
    case 'grape':
      return `<g transform="translate(15,15)">
        <path d="M5 1c1.5-1.5 3.5-1 4 0" stroke="#16a34a" stroke-width="1.3" fill="none"/>
        <circle cx="3.5" cy="4.5" r="2" fill="#7c3aed"/><circle cx="7" cy="4.5" r="2" fill="#8b5cf6"/>
        <circle cx="5.2" cy="7.5" r="2" fill="#6d28d9"/><circle cx="8.5" cy="7.5" r="2" fill="#7c3aed"/>
        <circle cx="6.8" cy="10.4" r="1.9" fill="#5b21b6"/>
      </g>`;
    case 'honey':
      return `<g transform="translate(16,15)">
        <path d="M2 3h8v5a4 4 0 01-8 0V3z" fill="#f59e0b" stroke="#b45309" stroke-width="0.9"/>
        <ellipse cx="6" cy="3" rx="4" ry="1.4" fill="#fde047" stroke="#b45309" stroke-width="0.8"/>
        <path d="M8 7v4.5a1 1 0 002 0V7z" fill="#fbbf24"/>
      </g>`;
    case 'sugarcane':
      return `<g transform="translate(17,13)">
        <path d="M2 16l6-13M5 17l5.5-11" stroke="#16a34a" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M3.2 12l2.2 1M5 8.5l2.2 1M6.8 5l2.2 1" stroke="#bbf7d0" stroke-width="1"/>
        <path d="M7.5 3c2-1.5 4-1 5 1" stroke="#22c55e" stroke-width="1.3" fill="none"/>
      </g>`;
    case 'benzene_ring':
      return `<g transform="translate(13,17)">
        <polygon points="5,0 9.5,2.5 9.5,7.5 5,10 0.5,7.5 0.5,2.5" fill="none" stroke="#fbbf24" stroke-width="1.25"/>
        <circle cx="5" cy="5" r="2.2" fill="none" stroke="#fde68a" stroke-width="1"/>
      </g>`;
    case 'alcohol_flame':
      return `<path d="M18 17c-2.2 2.4-2.5 4.8 0 6.5 2.5-1.7 2.2-4.1 0-6.5z" fill="#38bdf8" stroke="#e0f2fe" stroke-width="0.6"/>`;
    case 'glacial_ice':
      return `<polygon points="18,16 21,19 18,23 15,19" fill="#fda4af" stroke="#ffe4e6" stroke-width="0.8"/>`;
    case 'skull_toxic':
      return `<circle cx="18" cy="19.5" r="2.6" fill="none" stroke="#7dd3fc" stroke-width="1.2"/>`;
    case 'triol_drop':
      return `<path d="M18 16c-2 2.5-2.8 4.4 0 6 2.8-1.6 2-3.5 0-6z" fill="#2dd4bf" stroke="#ccfbf1" stroke-width="0.7"/>`;
    case 'oil_drop':
      return `<path d="M18 15c-2.8 3.2-3.6 5.8 0 7.6 3.6-1.8 2.8-4.4 0-7.6z" fill="#facc15" stroke="#fef08a" stroke-width="0.8"/>`;
    case 'amino':
      return `<polygon points="18,16 22,19.5 18,23 14,19.5" fill="rgba(216,180,254,0.85)" stroke="#a855f7" stroke-width="0.9"/>`;
    default:
      return '';
  }
}

function reagentIconSvg(reg) {
  const style = reg.bottleStyle || {};
  const capCol = style.shelfCapColor || style.capColor || '#334155';
  const fillCol = style.shelfFill || 'rgba(148,163,184,0.18)';
  const strokeCol = style.shelfStroke || '#64748b';
  const motifSvg = shelfMotifSvg(style.bottleMotif);

  if (style.vesselForm === 'rice_sack') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0 pointer-events-none">
      <path d="M13 5l5 2 5-2-2 5h-6z" fill="#d97706" stroke="#92400e" stroke-width="1.2"/>
      <path d="M12 10h12c3.5 4 5 11 4 19a3 3 0 01-3 3H11a3 3 0 01-3-3c-1-8 .5-15 4-19z" fill="#fde68a" stroke="#b45309" stroke-width="1.4"/>
      <line x1="12.5" y1="10.5" x2="23.5" y2="10.5" stroke="#92400e" stroke-width="1.8"/>
      <ellipse cx="18" cy="21" rx="6" ry="5.5" fill="#fffbeb" stroke="#d97706" stroke-width="0.9"/>
      <ellipse cx="16.5" cy="20" rx="2.2" ry="1.1" transform="rotate(-25 16.5 20)" fill="#ffffff" stroke="#94a3b8" stroke-width="0.6"/>
      <ellipse cx="20" cy="22" rx="2.2" ry="1.1" transform="rotate(20 20 22)" fill="#ffffff" stroke="#94a3b8" stroke-width="0.6"/>
    </svg>`;
  }

  if (style.vesselForm === 'cotton_plant') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0 pointer-events-none">
      <path d="M18 32V16M18 24l-6-4M18 21l6-4" stroke="#15803d" stroke-width="2.1" stroke-linecap="round" fill="none"/>
      <path d="M14 28c2 1 6 1 8 0" stroke="#166534" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="11" cy="18" r="3.6" fill="#ffffff" stroke="#94a3b8" stroke-width="1"/>
      <circle cx="13.5" cy="15.8" r="2.8" fill="#ffffff" stroke="#cbd5e1" stroke-width="0.8"/>
      <circle cx="25" cy="16" r="3.6" fill="#ffffff" stroke="#94a3b8" stroke-width="1"/>
      <circle cx="22.5" cy="13.8" r="2.8" fill="#ffffff" stroke="#cbd5e1" stroke-width="0.8"/>
      <circle cx="18" cy="11" r="4.2" fill="#ffffff" stroke="#94a3b8" stroke-width="1.1"/>
      <circle cx="15.5" cy="8.8" r="3.1" fill="#ffffff" stroke="#cbd5e1" stroke-width="0.8"/>
      <circle cx="20.6" cy="9.2" r="2.9" fill="#ffffff" stroke="#cbd5e1" stroke-width="0.8"/>
      <path d="M14.5 14l3.5 1.8 3.5-1.8" stroke="#65a30d" stroke-width="1.4" fill="none"/>
    </svg>`;
  }

  if (style.vesselForm === 'chicken_egg') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0 pointer-events-none">
      <defs>
        <radialGradient id="eggG" cx="38%" cy="32%" r="68%">
          <stop offset="0%" stop-color="#fffbeb"/>
          <stop offset="55%" stop-color="#fde68a"/>
          <stop offset="100%" stop-color="#d97706"/>
        </radialGradient>
      </defs>
      <path d="M18 4.5c5.8 0 10.2 9.5 10.2 16.5A10.2 10.2 0 0118 31.5 10.2 10.2 0 017.8 21C7.8 14 12.2 4.5 18 4.5z" fill="url(#eggG)" stroke="#b45309" stroke-width="1.4"/>
      <ellipse cx="14.5" cy="12" rx="2.1" ry="4" transform="rotate(-18 14.5 12)" fill="rgba(255,255,255,0.6)"/>
    </svg>`;
  }

  if (style.vesselForm === 'dropper') {
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0 pointer-events-none">
      <rect x="10.5" y="13" width="15" height="18" rx="3" fill="${fillCol}" stroke="${strokeCol}" stroke-width="1.5"/>
      <path d="M14.5 13V9h7v4" stroke="#475569" stroke-width="1.4" fill="#334155"/>
      <path d="M15.5 9V5a2.5 2.5 0 015 0v4" fill="${capCol}"/>
      <rect x="12.5" y="20" width="11" height="9" rx="1" fill="${style.shelfLiquidFill || 'rgba(244,114,182,0.38)'}"/>
      <line x1="18" y1="13" x2="18" y2="27" stroke="#ffffff" stroke-width="1" opacity="0.6"/>
    </svg>`;
  }

  if (reg.kind === 'liquid') {
    const liqCol = style.shelfLiquidFill || 'rgba(56,189,248,0.48)';
    const liqY = style.isFuming ? 19 : 17;
    const liqH = 30 - liqY;
    const fumeSvg = style.isFuming
      ? `<path d="M14 2c2 1 1 3 0 4M20 2c2 1 1 3 0 4" stroke="#cbd5e1" stroke-width="1.2" fill="none"/>`
      : '';
    return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0 pointer-events-none">
      <path d="M13 6h10v4l4 5v15a2 2 0 01-2 2H11a2 2 0 01-2-2V15l4-5V6z" fill="${fillCol}" stroke="${strokeCol}" stroke-width="1.5"/>
      <rect x="12.5" y="3" width="11" height="4" rx="1" fill="${capCol}"/>
      <rect x="11" y="${liqY}" width="14" height="${liqH}" fill="${liqCol}"/>
      ${fumeSvg}
      ${motifSvg}
    </svg>`;
  }

  const contentsKind = style.contentsKind || 'pellets';
  let contentsSvg = '';
  if (contentsKind === 'oil_blocks') {
    contentsSvg = `
      <rect x="9" y="14" width="18" height="16" rx="2" fill="rgba(234, 179, 8, 0.34)"/>
      <rect x="12" y="19" width="8" height="8" rx="0.8" fill="#e2e8f0" stroke="#64748b" stroke-width="0.9"/>
      <rect x="20" y="21" width="5" height="6" rx="0.6" fill="#cbd5e1" stroke="#64748b" stroke-width="0.8"/>`;
  } else if (contentsKind === 'blue_crystals' || contentsKind === 'purple_crystals') {
    const isPurple = contentsKind === 'purple_crystals';
    contentsSvg = `
      <polygon points="10,29 14,19 20,23 18,30" fill="${style.solidColor || (isPurple ? '#4c1d95' : '#0284c7')}" stroke="${isPurple ? '#c084fc' : '#bae6fd'}" stroke-width="0.9"/>
      <polygon points="18,30 22,20 27,26 24,30" fill="${isPurple ? '#2e1065' : '#0369a1'}" stroke="${isPurple ? '#c084fc' : '#bae6fd'}" stroke-width="0.9"/>
      <polygon points="15,21 19,16 22,21" fill="${isPurple ? '#7e22ce' : '#38bdf8'}" stroke="${isPurple ? '#e9d5ff' : '#e0f2fe'}" stroke-width="0.7"/>`;
  } else if (contentsKind === 'granules') {
    contentsSvg = `
      <polygon points="10,29 13,21 18,24 16,29" fill="${style.solidColor || '#94a3b8'}" stroke="#e2e8f0" stroke-width="0.8"/>
      <polygon points="17,29 21,20 26,24 23,29" fill="#cbd5e1" stroke="#475569" stroke-width="0.8"/>`;
  } else if (contentsKind === 'white_crystals') {
    contentsSvg = `
      <rect x="11" y="14" width="14" height="6" rx="1" fill="rgba(248, 250, 252, 0.88)"/>
      <rect x="12" y="23" width="5" height="5" fill="${style.solidColor || 'rgba(248, 250, 252, 0.72)'}" stroke="#cbd5e1" stroke-width="0.6"/>
      <rect x="19" y="24" width="5" height="4" fill="${style.solidColor || 'rgba(226, 232, 240, 0.72)'}" stroke="#cbd5e1" stroke-width="0.6"/>`;
  } else {
    contentsSvg = `
      <circle cx="13" cy="27" r="2.6" fill="${style.solidColor || '#ffffff'}" stroke="#94a3b8" stroke-width="0.7"/>
      <circle cx="19" cy="27.5" r="2.6" fill="${style.solidColor || '#ffffff'}" stroke="#94a3b8" stroke-width="0.7"/>
      <circle cx="23" cy="24" r="2.3" fill="${style.solidColor || '#ffffff'}" stroke="#94a3b8" stroke-width="0.7"/>
      <circle cx="16" cy="22.5" r="2.4" fill="${style.solidColor || '#ffffff'}" stroke="#94a3b8" stroke-width="0.7"/>`;
  }

  const jarX = style.glassMaterial === 'amber' ? 8 : 7;
  const jarW = style.glassMaterial === 'amber' ? 20 : 22;
  const capX = style.glassMaterial === 'amber' ? 11 : 10;
  const capW = style.glassMaterial === 'amber' ? 14 : 16;

  return `<svg viewBox="0 0 36 36" class="w-8 h-8 shrink-0 pointer-events-none">
    <rect x="${jarX}" y="9" width="${jarW}" height="23" rx="3.5" fill="${fillCol}" stroke="${strokeCol}" stroke-width="1.5"/>
    <rect x="${capX}" y="4.5" width="${capW}" height="4.5" rx="1.2" fill="${capCol}"/>
    ${contentsSvg}
    ${motifSvg}
  </svg>`;
}

export class ShelfPanel {
  constructor(container, sim, getLang, callbacks) {
    this.container = container;
    this.sim = sim;
    this.getLang = getLang;
    this.callbacks = callbacks; // { onAddApparatus, onSelectReagent, onExternalDragMove, onExternalDrop }
    this.activeCategory = 'all';
    this.activeReagentCategory = 'all';
    this.onlyAllowed = false;
    this.lastShelfSig = '';
    this._dragSession = null;
    this._boundPointer = false;
    this._bindGlobalPointerHandlers();
  }

  _buildFloatingGhost(kind, id, t) {
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost-card';
    if (kind === 'reagent') {
      const reg = STARTER_REAGENTS.find((r) => r.id === id);
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 240;
      canvas.style.cssText = 'width:80px;height:120px;display:block;';
      // Pre-bake soft drop-shadow once at drag start (avoids expensive per-frame CSS filter: drop-shadow)
      const tmp = document.createElement('canvas');
      tmp.width = 160;
      tmp.height = 240;
      const tCtx = tmp.getContext('2d');
      tCtx.scale(2, 2);
      drawReagentBottle(tCtx, reg, 40, 62, 0.82, { tiltRad: -0.18, uncapped: true, isDark: true });
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.36)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 7;
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
      ghost.appendChild(canvas);
    } else {
      const spec = APPARATUS[id];
      ghost.innerHTML = `<div class="px-2.5 py-1.5 rounded-xl border border-accent bg-surface text-main text-xs font-semibold flex items-center gap-1.5 shadow-2xl">${apparatusSvg(id)}<span>${t(spec?.i18nKey || id)}</span></div>`;
    }
    document.body.appendChild(ghost);
    return ghost;
  }

  _applyDragPosition(ds, clientX, clientY) {
    if (!ds) return;
    if (ds.ghostEl) {
      ds.ghostEl.style.transform = `translate3d(${clientX}px, ${clientY}px, 0) translate(-50%, -62%)`;
    }
    this.callbacks.onExternalDragMove?.(clientX, clientY, ds.kind, ds.id);
  }

  _bindGlobalPointerHandlers() {
    if (this._boundPointer || typeof window === 'undefined') return;
    this._boundPointer = true;

    const cleanup = () => {
      const ds = this._dragSession;
      if (!ds) return;
      if (ds._moveRafId) {
        cancelAnimationFrame(ds._moveRafId);
        ds._moveRafId = 0;
      }
      ds._pendingMove = null;
      if (ds.ghostEl) ds.ghostEl.remove();
      this.container?.classList.remove('shelf-dragging-active');
      this._dragSession = null;
      this.callbacks.onExternalDragMove?.(0, 0, null, null);
    };

    window.addEventListener('pointermove', (e) => {
      const ds = this._dragSession;
      if (!ds) return;
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (!ds.moved) {
        const thresh = ds.pointerType === 'mouse' ? 6 : 12;
        if (Math.hypot(dx, dy) < thresh) return;
        if (ds.pointerType !== 'mouse' && Math.abs(dy) > Math.abs(dx) * 1.15) {
          // Preserve vertical touch scrolling inside shelf list
          this._dragSession = null;
          return;
        }
        ds.moved = true;
        this.container?.classList.add('shelf-dragging-active');
        ds.ghostEl = this._buildFloatingGhost(ds.kind, ds.id, this.getLang());
      }
      if (!ds._moveRafId) {
        this._applyDragPosition(ds, e.clientX, e.clientY);
        ds._moveRafId = requestAnimationFrame(() => {
          ds._moveRafId = 0;
          const pending = ds._pendingMove;
          ds._pendingMove = null;
          if (pending && this._dragSession === ds) {
            this._applyDragPosition(ds, pending.x, pending.y);
          }
        });
      } else {
        ds._pendingMove = { x: e.clientX, y: e.clientY };
      }
    });

    window.addEventListener('pointerup', (e) => {
      const ds = this._dragSession;
      if (!ds) return;
      const { kind, id, moved } = ds;
      cleanup();
      this._lastPointerUpMs = Date.now();
      if (!moved) {
        if (kind === 'apparatus') this.callbacks.onAddApparatus?.(id);
        else if (kind === 'reagent') this.callbacks.onSelectReagent?.(id);
      } else {
        this.callbacks.onExternalDrop?.(e.clientX, e.clientY, kind, id);
      }
    });

    window.addEventListener('pointercancel', cleanup);
    window.addEventListener('blur', cleanup);
  }

  setSim(sim) {
    this.sim = sim;
    this.lastShelfSig = '';
  }

  getShelfSignature(t) {
    const ms = this.sim?.missionState;
    const missionSig = ms?.active ? `${ms.missionId}:${ms.mode}:${this.onlyAllowed ? 1 : 0}` : 'free';
    return `${t('equipmentTitle')}|${this.activeCategory}|${this.activeReagentCategory}|${missionSig}`;
  }

  render(t, force = false) {
    if (this._dragSession?.moved) return;
    const sig = this.getShelfSignature(t);
    if (!force && sig === this.lastShelfSig) return;
    this.lastShelfSig = sig;

    const activeMission = this.sim?.missionState?.active
      ? (getMissionById(this.sim.missionState.missionId) || this.sim.missionState)
      : null;
    const hideLocked = Boolean(activeMission && this.onlyAllowed);
    const baseApparatus =
      this.activeCategory === 'all'
        ? APPARATUS_ORDER
        : APPARATUS_ORDER.filter((id) => APPARATUS[id]?.category === this.activeCategory);
    const filteredApparatus = hideLocked
      ? baseApparatus.filter((id) => isApparatusAllowedInMission(activeMission, id))
      : baseApparatus;
    const baseReagents =
      this.activeReagentCategory === 'all'
        ? STARTER_REAGENTS
        : STARTER_REAGENTS.filter((r) => r.category === this.activeReagentCategory);
    const filteredReagents = hideLocked
      ? baseReagents.filter((r) => isReagentAllowedInMission(activeMission, r.id))
      : baseReagents;

    this.container.innerHTML = `
      <div class="flex flex-col gap-3">
        ${
          activeMission
            ? `<div class="p-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-300 font-medium flex items-center justify-between gap-2">
                <span class="min-w-0 leading-snug">🎯 ${t('missionShelfScoped')}</span>
                <button
                  type="button"
                  id="btn-shelf-allowed-only"
                  aria-pressed="${this.onlyAllowed ? 'true' : 'false'}"
                  class="shrink-0 px-2 py-0.5 rounded-full border text-[10.5px] font-semibold transition cursor-pointer ${
                    this.onlyAllowed
                      ? 'border-accent bg-accent/20 text-accent shadow-sm'
                      : 'border-theme bg-surface text-main hover:border-accent'
                  }"
                >${this.onlyAllowed ? '✓ ' : ''}${t('missionAllowedOnlyBtn')}</button>
              </div>`
            : ''
        }
        <!-- Apparatus Section -->
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <h2 class="text-xs font-bold uppercase tracking-wider text-muted">${t('equipmentTitle')}</h2>
          </div>
          <div class="flex flex-wrap gap-1 mb-2" id="shelf-cat-tabs">
            ${APPARATUS_CATEGORIES.map((cat) => {
              const active = this.activeCategory === cat.id;
              return `<button type="button" data-cat-id="${cat.id}" class="shelf-cat-btn px-2 py-0.5 rounded-full text-[11px] font-medium border transition ${
                active ? 'border-accent bg-accent/15 text-accent font-semibold' : 'border-theme bg-surface-alt text-muted hover:text-main'
              }">${t(cat.i18nKey)}</button>`;
            }).join('')}
          </div>
          <div class="grid grid-cols-2 gap-1.5" id="shelf-apparatus-grid">
            ${filteredApparatus
              .map((id) => {
                const spec = APPARATUS[id];
                const allowed = !activeMission || isApparatusAllowedInMission(activeMission, id);
                return `
                  <div
                    role="button"
                    tabindex="0"
                    data-apparatus-id="${id}"
                    ${allowed ? '' : 'data-locked="1" aria-disabled="true"'}
                    class="apparatus-card flex items-center gap-1.5 p-1.5 rounded-lg border border-theme bg-surface-alt transition text-left select-none ${
                      allowed ? 'hover:border-accent cursor-grab active:cursor-grabbing' : 'opacity-40 cursor-not-allowed'
                    }"
                    title="${allowed ? t(spec.i18nKey) : t('missionLockedShelfTip')}"
                  >
                    <span class="text-accent shrink-0 pointer-events-none">${apparatusSvg(id)}</span>
                    <span class="text-xs font-medium leading-tight line-clamp-2 pointer-events-none flex-1">${t(spec.i18nKey)}</span>
                    ${allowed ? '' : '<span class="text-[10px] shrink-0 pointer-events-none">🔒</span>'}
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>

        <!-- Pure Reagents Section -->
        <div class="flex flex-col">
          <div class="mb-1.5">
            <h2 class="text-xs font-bold uppercase tracking-wider text-muted">${t('reagentsTitle')}</h2>
            <p class="text-xs text-muted mt-0.5">${t('pureFormNote')}</p>
          </div>
          <div class="flex flex-wrap gap-1 mb-2" id="shelf-reg-cats">
            ${REAGENT_CATEGORIES.map((cat) => {
              const active = this.activeReagentCategory === cat.id;
              return `<button type="button" data-reg-cat="${cat.id}" class="reg-cat-btn px-2 py-0.5 rounded-full text-[11px] font-medium border transition ${
                active ? 'border-accent bg-accent/15 text-accent font-semibold' : 'border-theme bg-surface-alt text-muted hover:text-main'
              }">${t(cat.i18nKey)}</button>`;
            }).join('')}
          </div>
          <div class="space-y-1.5" id="shelf-reagents-list">
            ${filteredReagents.map((reg) => {
              const hazards = getReagentGhsHazards(reg);
              const ghsMap = { flammable: '🔥', corrosive: '☣️', toxic: '☠️', oxidizer: '⚡' };
              const ghsKeyMap = { flammable: 'ghsFlammable', corrosive: 'ghsCorrosive', toxic: 'ghsToxic', oxidizer: 'ghsOxidizer' };
              const hazardBadges = hazards.map((h) => ghsMap[h] || '').join('');
              const hazardTip = hazards.length ? `GHS: ${hazards.map((h) => t(ghsKeyMap[h] || h)).join(', ')}` : '';
              const allowed = !activeMission || isReagentAllowedInMission(activeMission, reg.id);
              return `
              <div
                role="button"
                tabindex="0"
                data-reagent-id="${reg.id}"
                ${allowed ? '' : 'data-locked="1" aria-disabled="true"'}
                title="${allowed ? hazardTip : t('missionLockedShelfTip')}"
                class="reagent-card w-full flex items-center justify-between gap-2 p-1.5 rounded-lg border border-theme bg-surface-alt transition text-left select-none ${
                  allowed ? 'hover:border-accent cursor-grab active:cursor-grabbing' : 'opacity-40 cursor-not-allowed'
                }"
              >
                <div class="flex items-center gap-2 min-w-0 pointer-events-none">
                  ${reagentIconSvg(reg)}
                  <div class="min-w-0">
                    <div class="text-xs font-semibold truncate">${t(reg.i18nKey)}${hazardBadges ? ` <span class="text-[10px]">${hazardBadges}</span>` : ''}</div>
                    <div class="text-xs text-muted truncate">${t(reg.descKey)}</div>
                  </div>
                </div>
                <span class="text-xs px-1.5 py-0.5 rounded bg-surface border border-theme text-muted shrink-0 pointer-events-none">
                  ${allowed ? (reg.kind === 'solid' ? 'g' : 'mL') : '🔒'}
                </span>
              </div>
            `;
            }).join('')}
          </div>
        </div>
      </div>
    `;

    this.container.querySelector('#btn-shelf-allowed-only')?.addEventListener('click', () => {
      this.onlyAllowed = !this.onlyAllowed;
      this.render(this.getLang(), true);
    });

    // Category filter buttons (Apparatus + Reagents)
    this.container.querySelectorAll('.shelf-cat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeCategory = btn.dataset.catId;
        this.render(this.getLang(), true);
      });
    });
    this.container.querySelectorAll('.reg-cat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeReagentCategory = btn.dataset.regCat;
        this.render(this.getLang(), true);
      });
    });

    // Unified Pointer Drag + Click for Apparatus Cards (fixes native HTML5 button drag failures & works on touch/mouse/webview)
    this.container.querySelectorAll('.apparatus-card').forEach((el) => {
      const id = el.dataset.apparatusId;
      const isLocked = el.dataset.locked === '1';
      el.addEventListener('pointerdown', (e) => {
        if (isLocked) return;
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        this._dragSession = {
          kind: 'apparatus',
          id,
          startX: e.clientX,
          startY: e.clientY,
          pointerType: e.pointerType || 'mouse',
          moved: false,
          ghostEl: null,
        };
      });
      el.addEventListener('click', () => {
        if (isLocked) {
          this.callbacks.onLockedAttempt?.();
          return;
        }
        if (this._lastPointerUpMs && Date.now() - this._lastPointerUpMs < 180) return;
        this.callbacks.onAddApparatus?.(id);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (isLocked) {
            this.callbacks.onLockedAttempt?.();
            return;
          }
          this.callbacks.onAddApparatus?.(id);
        }
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (isLocked) return;
        this.callbacks.onContextMenu?.(e.clientX, e.clientY, { kind: 'shelf_apparatus', typeId: id });
      });
    });

    // Unified Pointer Drag + Click for Reagent Cards
    this.container.querySelectorAll('.reagent-card').forEach((el) => {
      const id = el.dataset.reagentId;
      const isLocked = el.dataset.locked === '1';
      el.addEventListener('pointerdown', (e) => {
        if (isLocked) return;
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        this._dragSession = {
          kind: 'reagent',
          id,
          startX: e.clientX,
          startY: e.clientY,
          pointerType: e.pointerType || 'mouse',
          moved: false,
          ghostEl: null,
        };
      });
      el.addEventListener('click', () => {
        if (isLocked) {
          this.callbacks.onLockedAttempt?.();
          return;
        }
        if (this._lastPointerUpMs && Date.now() - this._lastPointerUpMs < 180) return;
        this.callbacks.onSelectReagent?.(id);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (isLocked) {
            this.callbacks.onLockedAttempt?.();
            return;
          }
          this.callbacks.onSelectReagent?.(id);
        }
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (isLocked) return;
        this.callbacks.onContextMenu?.(e.clientX, e.clientY, { kind: 'shelf_reagent', reagentId: id });
      });
    });

  }
}
