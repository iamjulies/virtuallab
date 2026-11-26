/**
 * Shared Inspector Formatters, Helpers & Log/CSV Builders (Refactor 81).
 */
import { APPARATUS, getStandGeometry } from '../../data/apparatus.js';
import { CONSTANTS, formatNumber, kelvinToCelsius } from '../../data/constants.js';
import { GAS_DISPLAY_META, isSolidMoltenAtTemp, SPECIES, STARTER_REAGENTS } from '../../data/species.js';
import { ELECTRODE_MATERIALS, computeVesselRedoxAndCellMetrics } from '../../engine/electrochemistry.js';
import {
  computeAtmospherePartialPressures,
  computeBenchTelemetry,
  computeContentsMassG,
  computeLiquidSpeciesTableData,
  computeLiquidVolumeL,
  computePH,
  computePhaseStratification,
  computeSolidVolumeMl,
  computeSolutionVisuals,
  computeVesselAroma,
  computeVesselElectrochemicalMetrics,
  estimateVesselEsterificationMetrics,
} from '../../engine/equilibrium.js';
import {
  computeSyringeDischargeArc,
  computeSyringeFrozenVolumeMl,
  computeSyringeGasVolumeMl,
  computeSyringeLiquidVolumeMl,
  computeSyringeTotalVolumeMl,
  computeTubingGeometry,
} from '../../engine/gasNetwork.js';
import { computeWashBottleStreamArc } from '../../engine/apparatusTools.js';
import {
  COLORIMETER_WAVELENGTHS,
  computeIrSpectrum,
  computeUvVisSpectrum,
  stepAnalyticalInstruments,
} from '../../engine/analyticalTools.js';
import { computeCaOOptimizationScore } from '../../engine/chemistry.js';
import { renderExportActionsBarHtml } from '../../storage/reportExport.js';

export const SPECTRO_CHART_PAD = { L: 24, R: 8, T: 12, B: 22 };

export function renderFlipButtonHtml(item, t) {
  if (!APPARATUS[item.typeId]?.flippable) return '';
  return `<button type="button" id="ins-flip-x" class="px-2 py-1 rounded-lg border ${
    item.flippedX ? 'border-accent bg-accent/15 text-accent font-semibold' : 'border-theme bg-surface text-main'
  } text-xs hover:border-accent" title="${t(item.flippedX ? 'flipDirRight' : 'flipDirLeft')}">${t('actionFlipHorizontal')}</button>`;
}

export const CHART_PALETTE = [
  '#38bdf8',
  '#f472b6',
  '#fbbf24',
  '#34d399',
  '#a78bfa',
  '#fb7185',
  '#f97316',
];

export function sumAllGasMoles(gasMap = {}) {
  let tot = 0;
  for (const g of GAS_DISPLAY_META) tot += gasMap[g.id] || 0;
  return tot;
}

export function formatGasSummaryHtml(gasMap = {}, escapedFrostMol = 0, t = null) {
  const parts = [];
  for (const g of GAS_DISPLAY_META) {
    const val = gasMap[g.id] || 0;
    if (g.always || val > 1e-6) {
      parts.push(`<span class="whitespace-nowrap">${g.label}: ${(val * 1000).toFixed(2)} mmol</span>`);
    }
  }
  if (escapedFrostMol > 1e-6) {
    const frostLabel = t ? t('frostEscapedTag') : 'Frost';
    parts.push(`<span class="whitespace-nowrap text-sky-400">❄️ ${frostLabel}: ${(escapedFrostMol * 1000).toFixed(2)} mmol H₂O(s)</span>`);
  }
  return parts.join('<span class="text-muted px-1">·</span>');
}

export function computeVesselPressureMetrics(item, spec, env) {
  const pEnv = Math.max(0.05, env?.pressureBar || CONSTANTS.P_STD_BAR);
  const localPBar = item.internalPressureBar ?? pEnv;
  const deltaPBar = localPBar - pEnv;
  const isClosed = Boolean(item.isStoppered || (spec?.hasLid && item.lidState === 'closed'));
  const maxDeltaPBar =
    isClosed && !item.connectedTargetId && !item.connectedSyringeId && spec?.popOverpressureBar
      ? spec.popOverpressureBar
      : spec?.shatterOverpressureBar || 0.9;
  const limitRatio = maxDeltaPBar > 1e-6 ? Math.max(0, deltaPBar / maxDeltaPBar) : 0;
  return { localPBar, deltaPBar, maxDeltaPBar, limitPct: Math.min(100, limitRatio * 100), rawRatio: limitRatio };
}

export function hasDisplayableSpeciesAmount(spId, n) {
  if (!Number.isFinite(n) || n <= 0) return false;
  const sp = SPECIES[spId];
  if (!sp) return false;
  if (n >= 5e-7) return true;
  return n * (sp.molarMass || 0) >= 5e-4;
}

export function formatSimTimestamp(sec) {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const mins = Math.floor(s / 60);
  const rem = s - mins * 60;
  const mStr = String(mins).padStart(2, '0');
  const sStr = rem.toFixed(1).padStart(4, '0');
  return `[${mStr}:${sStr}s]`;
}

export function formatChemEquation(eqText) {
  const escapeHtml = (str) =>
    String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const src = String(eqText ?? '');
  const parts = [];
  let lastIdx = 0;
  const rx = /(—|⇌|⇄)\(([^)]+)\)(→)?/g;
  for (const m of src.matchAll(rx)) {
    const [full, kind, rawCond, arrowAfter] = m;
    if (kind === '—' && arrowAfter !== '→') continue;
    parts.push(escapeHtml(src.slice(lastIdx, m.index)));
    const [rawTop = '', rawBottom = ''] = rawCond.split(';').map((s) => s.trim());
    const revCls = kind === '—' ? '' : ' chem-arrow--rev';
    parts.push(
      `<span class="chem-arrow${revCls}"><span class="chem-arrow__top">${escapeHtml(rawTop)}</span><span class="chem-arrow__line"></span>${rawBottom ? `<span class="chem-arrow__bottom">${escapeHtml(rawBottom)}</span>` : ''}</span>`
    );
    lastIdx = m.index + full.length;
  }
  parts.push(escapeHtml(src.slice(lastIdx)));
  return parts.join('');
}

export function getGasRelAirDensity(spId) {
  const sp = SPECIES[spId];
  if (typeof sp?.relAirDensity === 'number') return sp.relAirDensity;
  if (sp?.molarMass) return sp.molarMass / 28.97;
  return 1.0;
}

export function buildVesselGasCompositionHtml(item, spec, env, liqL, t) {
  const headMap = item.headspaceGasMoles || {};
  const activeGases = Object.entries(headMap)
    .filter(([gId, n]) => hasDisplayableSpeciesAmount(gId, n) && SPECIES[gId]?.phase === 'g')
    .sort((a, b) => (b[1] || 0) - (a[1] || 0));
  if (activeGases.length === 0) {
    return `<p class="text-xs text-muted">${t('emptyGasMsg')}</p>`;
  }
  const pm = computeVesselPressureMetrics(item, spec, env);
  const T_K = Math.max(120, item.tempK || env?.tempK || CONSTANTS.T_STD_K);
  const pLocal = Math.max(0.1, pm.localPBar || env?.pressureBar || CONSTANTS.P_STD_BAR);
  const vMolarMl = ((CONSTANTS.R_L_BAR_MOL_K * T_K) / pLocal) * 1000;
  const rows = activeGases
    .map(([gId, n]) => {
      const sp = SPECIES[gId];
      const mmol = n * 1000;
      const volMl = n * vMolarMl;
      const dAir = getGasRelAirDensity(gId);
      return `
        <tr class="border-b border-theme/50 last:border-0">
          <td class="py-1 font-semibold">${sp?.formula || gId}</td>
          <td class="py-1 text-right font-mono">${formatNumber(mmol, 3)}</td>
          <td class="py-1 text-right font-mono text-sky-400">${formatNumber(volMl, 2)}</td>
          <td class="py-1 text-right font-mono text-muted">${dAir.toFixed(2)}</td>
        </tr>`;
    })
    .join('');
  return `
    <div class="overflow-x-auto max-h-40 overflow-y-auto">
      <table class="w-full text-xs">
        <thead>
          <tr class="text-muted border-b border-theme text-left">
            <th class="pb-1 font-medium">${t('colSpecies')}</th>
            <th class="pb-1 font-medium text-right">${t('colGasMmol')}</th>
            <th class="pb-1 font-medium text-right">${t('colGasVolMl')}</th>
            <th class="pb-1 font-medium text-right">${t('colAirDensity')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export function renderActionGridHtml(buttons = []) {
  const clean = buttons.filter((b) => typeof b === 'string' && b.trim().length > 0);
  if (clean.length === 0) return '';
  return `<div class="grid grid-cols-2 gap-1.5 pt-0.5 pb-0.5">${clean
    .map(
      (btn, idx) =>
        `<div class="${clean.length % 2 === 1 && idx === clean.length - 1 ? 'col-span-2 flex' : 'flex'}">${btn}</div>`
    )
    .join('')}</div>`;
}

export function buildSyringeGasCompositionHtml(syr, syrSpec, env, t, condInfo = null) {
  const gasMap = syr?.gasMoles || {};
  const activeGases = Object.entries(gasMap)
    .filter(([gId, n]) => hasDisplayableSpeciesAmount(gId, n) && SPECIES[gId]?.phase === 'g')
    .sort((a, b) => (b[1] || 0) - (a[1] || 0));

  const cond = condInfo || getSyringeCondenseInfo(syr, env, t);
  const T_K = Math.max(120, cond?.syrTempK || syr?.tempK || env?.tempK || CONSTANTS.T_STD_K);
  const pLocal = Math.max(0.05, syr?.internalPressureBar ?? env?.pressureBar ?? CONSTANTS.P_STD_BAR);
  const vMolarMl = ((CONSTANTS.R_L_BAR_MOL_K * T_K) / pLocal) * 1000;
  const totalGasMol = activeGases.reduce((acc, [, n]) => acc + (n || 0), 0);

  // Collect condensed (l) & frozen (s) species preserving full mole conservation
  const condensedRows = [];
  const pushCond = (spId, nMol, phaseTag, customVolMl = null) => {
    if (!(nMol > 1e-9)) return;
    const sp = SPECIES[spId];
    const formula = sp?.formula || spId;
    const volMl =
      customVolMl != null
        ? customVolMl
        : sp?.density && sp?.molarMass
        ? (nMol * sp.molarMass) / sp.density
        : 0;
    condensedRows.push({ spId, formula, nMol, phaseTag, volMl });
  };
  const usedCondIds = new Set();
  if ((syr?.condensedWaterMol || 0) > 1e-9) {
    usedCondIds.add('H2O_l');
    pushCond('H2O_l', syr.condensedWaterMol, 'l', (syr.condensedWaterMol * SPECIES.H2O_l.molarMass) / 0.997);
  }
  if ((syr?.condensedEtOHMol || 0) > 1e-9) {
    usedCondIds.add('C2H5OH_l');
    pushCond('C2H5OH_l', syr.condensedEtOHMol, 'l');
  }
  for (const [spId, n] of Object.entries(syr?.condensedFluidMoles || {})) {
    if (!usedCondIds.has(spId)) pushCond(spId, n, 'l');
  }
  if ((syr?.frozenWaterMol || 0) > 1e-9) {
    pushCond('H2O_s', syr.frozenWaterMol, 's', (syr.frozenWaterMol * SPECIES.H2O_s.molarMass) / CONSTANTS.ICE_DENSITY_G_ML);
  }
  for (const [spId, n] of Object.entries(syr?.frozenMoles || {})) {
    if (spId !== 'H2O_s') pushCond(spId, n, 's');
  }
  for (const [spId, n] of Object.entries(syr?.overflowMoles || {})) {
    if (n > 1e-9) {
      const sp = SPECIES[spId];
      pushCond(spId, n, sp?.phase || 'l');
    }
  }

  if (activeGases.length === 0 && condensedRows.length === 0) {
    return `<p class="text-xs text-muted">${t('syrEmptyGasMsg')}</p>`;
  }

  const gasRowsHtml = activeGases
    .map(([gId, n]) => {
      const sp = SPECIES[gId];
      const mmol = n * 1000;
      const volMl = n * vMolarMl;
      const sharePct = totalGasMol > 1e-12 ? (n / totalGasMol) * 100 : 0;
      const dAir = getGasRelAirDensity(gId);
      return `
        <tr class="border-b border-theme/50 last:border-0">
          <td class="py-1 pr-1 font-semibold">${sp?.formula || gId}</td>
          <td class="py-1 px-1 text-right font-mono">${formatNumber(mmol, 2)}</td>
          <td class="py-1 px-1 text-right font-mono text-sky-400">${formatNumber(volMl, 2)}</td>
          <td class="py-1 px-1 text-right font-mono text-emerald-400">${sharePct.toFixed(1)}%</td>
          <td class="py-1 pl-1 text-right font-mono text-muted">${dAir.toFixed(2)}</td>
        </tr>`;
    })
    .join('');

  const condensedHtml =
    condensedRows.length > 0
      ? `<div class="mt-2 pt-1.5 border-t border-theme/60">
           <div class="text-[10.5px] font-semibold text-muted mb-1">${t('syrCondensedGroupTitle')}</div>
           <div class="flex flex-col gap-0.5 text-[11px] font-mono">
             ${condensedRows
               .map(
                 (c) => `<div class="flex items-center justify-between gap-2">
                   <span class="font-semibold">${c.formula} <span class="text-muted">(${c.phaseTag})</span></span>
                   <span>${formatNumber(c.nMol * 1000, 2)} mmol · <strong class="text-sky-400">${c.volMl.toFixed(2)} mL</strong></span>
                 </div>`
               )
               .join('')}
           </div>
         </div>`
      : '';

  return `
    <div class="text-[11px] font-semibold text-muted mb-1">${t('syrGasTableTitle')}</div>
    ${
      activeGases.length > 0
        ? `<div class="overflow-x-auto max-h-40 overflow-y-auto" id="syr-gas-scroll">
             <table class="w-full text-[11px]">
               <thead>
                 <tr class="text-muted border-b border-theme text-left">
                   <th class="pb-1 pr-1 font-medium">${t('colSpecies')}</th>
                   <th class="pb-1 px-1 font-medium text-right">mmol</th>
                   <th class="pb-1 px-1 font-medium text-right">mL</th>
                   <th class="pb-1 px-1 font-medium text-right">${t('colGasSharePct')}</th>
                   <th class="pb-1 pl-1 font-medium text-right">d/KK</th>
                 </tr>
               </thead>
               <tbody>${gasRowsHtml}</tbody>
             </table>
           </div>`
        : ''
    }
    ${condensedHtml}`;
}

export function buildEscapedGasVerticalHtml(item, env, t) {
  const tempK = Math.max(150, item.lastGasOutTempK ?? item.tempK ?? env?.tempK ?? 298.15);
  const pBar = Math.max(0.05, env?.pressureBar || CONSTANTS.P_STD_BAR);
  const rateMap = item.lastGasRateMap || {};
  const escapedMap = item.escapedGasMoles || {};
  const activeRows = [];

  for (const g of GAS_DISPLAY_META) {
    const mol = escapedMap[g.id] || 0;
    const volMl = ((mol * CONSTANTS.R_L_BAR_MOL_K * tempK) / pBar) * 1000;
    const rateMolS = rateMap[g.id] || 0;
    if (volMl <= 0.005 && rateMolS <= 1e-7) continue; // Only show gases physically present or evolving
    const rateMmolS = rateMolS * 1000;
    const rateMlS = ((rateMolS * CONSTANTS.R_L_BAR_MOL_K * tempK) / pBar) * 1000;
    const dAir = getGasRelAirDensity(g.id);
    activeRows.push(`
      <tr class="border-b border-theme/40 last:border-0">
        <td class="py-1 font-semibold align-top">${g.label}</td>
        <td class="py-1 text-right font-mono align-top">${(mol * 1000).toFixed(2)} mmol</td>
        <td class="py-1 text-right font-mono text-sky-400 align-top">${volMl >= 10 ? volMl.toFixed(1) : volMl.toFixed(2)} mL</td>
        <td class="py-1 text-right font-mono text-muted leading-tight align-top">
          <div>${rateMmolS.toFixed(2)} mmol/s</div>
          <div class="text-[10px] opacity-85">${rateMlS.toFixed(1)} mL/s</div>
        </td>
        <td class="py-1 text-right font-mono text-muted align-top">${dAir.toFixed(2)}</td>
      </tr>
    `);
  }
  if ((item.escapedFrostH2OMol || 0) > 1e-6) {
    const fm = item.escapedFrostH2OMol;
    activeRows.push(`
      <tr class="border-b border-theme/40 last:border-0 text-sky-400">
        <td class="py-1 font-semibold">❄️ H₂O(s)</td>
        <td class="py-1 text-right font-mono">${(fm * 1000).toFixed(2)} mmol</td>
        <td class="py-1 text-right font-mono">—</td>
        <td class="py-1 text-right font-mono">${t('frostEscapedTag')}</td>
        <td class="py-1 text-right font-mono">—</td>
      </tr>
    `);
  }
  if (activeRows.length === 0) {
    return `<p class="text-[11px] text-muted">—</p>`;
  }
  return `
    <div class="overflow-x-auto">
      <table class="w-full text-[11px]">
        <thead>
          <tr class="text-muted border-b border-theme text-left">
            <th class="pb-1 font-medium">${t('escapedColGas')}</th>
            <th class="pb-1 font-medium text-right">${t('escapedColMol')}</th>
            <th class="pb-1 font-medium text-right">${t('escapedColVol')}</th>
            <th class="pb-1 font-medium text-right">${t('escapedColRate')}</th>
            <th class="pb-1 font-medium text-right">${t('colAirDensity')}</th>
          </tr>
        </thead>
        <tbody>${activeRows.join('')}</tbody>
      </table>
    </div>
  `;
}

export function buildLiquidRowsHtml(liqData) {
  return liqData.rows
    .map(({ spId, sp, mol, massG, volMl, cM, cPct, layerGroup }) => {
      const molStr = mol >= 0.01 ? `${formatNumber(mol, 4)}` : `${formatNumber(mol * 1000, 3)}m`;
      const layerBadge =
        layerGroup === 'organic_heavy'
          ? ' <span class="text-[10px] text-amber-400">↓</span>'
          : layerGroup === 'organic_light'
          ? ' <span class="text-[10px] text-sky-400">↑</span>'
          : '';
      const volStr = volMl !== null ? `${formatNumber(volMl, 2)} mL` : '—';
      const cmStr = cM > 0.0005 ? `${cM.toFixed(cM >= 10 ? 1 : 2)} M` : '—';
      const pctStr = cPct > 0.005 ? `${cPct.toFixed(1)}%` : '<0.01%';
      return `
        <tr class="border-b border-theme/50 last:border-0" id="sp-liq-row-${spId}">
          <td class="py-1 font-semibold">${sp.formula}${layerBadge}</td>
          <td class="py-1 text-right font-mono" id="sp-mol-${spId}">${molStr}</td>
          <td class="py-1 text-right font-mono" id="sp-mass-${spId}">${formatNumber(massG, 3)}g</td>
          <td class="py-1 text-right font-mono text-sky-400" id="sp-vol-${spId}">${volStr}</td>
          <td class="py-1 text-right font-mono leading-tight" id="sp-conc-${spId}">
            <div>${cmStr}</div>
            <div class="text-[10px] text-muted">${pctStr}</div>
          </td>
        </tr>
      `;
    })
    .join('');
}

export function buildBlindObservationCardHtml(item, t) {
  const liqL = computeLiquidVolumeL(item.moles || {}, item.tempK || CONSTANTS.T_STD_K);
  const ph = liqL > 1e-6 ? computePH(item.moles || {}, liqL, item.tempK || CONSTANTS.T_STD_K) : null;
  const vis = liqL > 1e-6
    ? computeSolutionVisuals(item.moles || {}, liqL, ph ?? 7, 2.0, item.phenBleachFrac || 0, item.phenIrrevFrac || 0)
    : null;
  const hasSolids = Object.entries(item.moles || {}).some(([id, n]) => n > 1e-7 && SPECIES[id]?.phase === 's');
  const hasBubbles = (item.gasOutBannerTimer || 0) > 0.05 || (item.lastTotalRateMolS || 0) > 1e-5;
  const hasPinkPhen = (item.moles?.Phenolphthalein_aq || 0) > 1e-9 && ph !== null && ph >= 8.2 && (item.phenBleachFrac || 0) < 0.7;
  const aroma = !item.isShattered ? computeVesselAroma(item) : null;

  const liqDesc = liqL <= 1e-5
    ? t('blindObsDry')
    : hasPinkPhen
    ? t('blindObsPinkSol')
    : vis?.opacity > 0.28
    ? t('blindObsColoredSol')
    : t('blindObsClearSol');
  const solDesc = hasSolids ? t('blindObsHasPrecip') : t('blindObsNoPrecip');
  const gasDesc = hasBubbles ? t('blindObsHasBubbles') : t('blindObsNoBubbles');

  return `
    <div id="blind-obs-card" class="p-3 rounded-lg border border-amber-500/45 bg-amber-500/10 flex flex-col gap-1.5 text-xs">
      <div class="flex items-center justify-between gap-2">
        <span class="font-bold text-amber-300">🕵️ ${t('blindUnknownTitle')}</span>
        <span class="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface border border-theme">${item.blindLabel || item.label}</span>
      </div>
      <div class="grid grid-cols-1 gap-1 text-[11.5px]">
        <div>• <strong>${t('blindObsLiquid')}:</strong> ${liqDesc}</div>
        <div>• <strong>${t('blindObsSolid')}:</strong> ${solDesc}</div>
        <div>• <strong>${t('blindObsGas')}:</strong> ${gasDesc}</div>
        ${aroma ? `<div>• <strong>${t('aromaTitle')}:</strong> ${t(aroma.key)}</div>` : ''}
      </div>
      <div class="text-[11px] text-muted pt-1 border-t border-amber-500/25">${t('blindAnalyzeHint')}</div>
    </div>
  `;
}

export function renderXlsxSectionBtnHtml(section, t, tipKey = 'exportXlsxBtn') {
  return `<button type="button" data-xlsx-sec="${section}" title="${t(tipKey)}" class="px-1.5 py-0.5 rounded border border-theme bg-surface-alt text-[10px] font-semibold hover:border-accent shrink-0 whitespace-nowrap">📥 ${t('exportXlsxBtn')}</button>`;
}

export function buildContainerLiquidTableCardHtml(item, t, tempK, hideQuant = false) {
  if (item.hideComposition || hideQuant) {
    return buildBlindObservationCardHtml(item, t);
  }
  const liqTabData = computeLiquidSpeciesTableData(item.moles || {}, tempK);
  const rhoTxt = liqTabData.mixDensity > 0 ? `ρ=${liqTabData.mixDensity.toFixed(3)} g/mL` : '';
  return `
    <div class="p-2.5 rounded-lg border border-theme bg-surface flex flex-col gap-1.5">
      <div class="flex items-center justify-between gap-2">
        <h4 class="text-xs font-semibold text-muted">${t('liquidTableTitle')}</h4>
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-[11px] font-mono text-sky-400 shrink-0 whitespace-nowrap" id="live-mix-density">${rhoTxt ? rhoTxt.replace('ρ=', 'ρ = ') : ''}</span>
          ${renderXlsxSectionBtnHtml('liquid', t, 'exportXlsxLiquidTip')}
        </div>
      </div>
      <div id="sp-liq-box">
        ${
          liqTabData.rows.length === 0
            ? `<p class="text-xs text-muted">${item.isBroken ? t('alertToolBreak') : t('emptyLiquidMsg')}</p>`
            : `<div class="overflow-x-auto max-h-40 overflow-y-auto">
                <table class="w-full text-[11px]">
                  <thead>
                    <tr class="text-muted border-b border-theme text-left">
                      <th class="pb-1 font-medium">${t('colSpecies')}</th>
                      <th class="pb-1 font-medium text-right">${t('colMoles')}</th>
                      <th class="pb-1 font-medium text-right">${t('colMass')}</th>
                      <th class="pb-1 font-medium text-right">${t('colVolumeMl')}</th>
                      <th class="pb-1 font-medium text-right">${t('colConc')}</th>
                    </tr>
                  </thead>
                  <tbody id="sp-liq-body">${buildLiquidRowsHtml(liqTabData)}</tbody>
                </table>
              </div>`
        }
      </div>
    </div>
  `;
}

export function updateLiveLiquidContainerSection(container, item, envTempK) {
  if (item?.hideComposition) return;
  const liqTabData = computeLiquidSpeciesTableData(item.moles || {}, item.tempK ?? envTempK);
  const rhoEl = container.querySelector('#live-mix-density');
  if (rhoEl) rhoEl.textContent = liqTabData.mixDensity > 0 ? `ρ=${liqTabData.mixDensity.toFixed(3)} g/mL` : '';
  const bodyEl = container.querySelector('#sp-liq-body');
  if (bodyEl) bodyEl.innerHTML = buildLiquidRowsHtml(liqTabData);
}

export function buildSolidRowsHtml(item, t) {
  const entries = Object.entries(item.moles || {})
    .filter(([spId, n]) => SPECIES[spId]?.phase === 's' && hasDisplayableSpeciesAmount(spId, n))
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '';
  return entries
    .map(([spId, n]) => {
      const sp = SPECIES[spId];
      const massG = n * sp.molarMass;
      const isMolten = isSolidMoltenAtTemp(sp, item.tempK, item.moles);
      const isFrozen = spId === 'H2O_s' || spId === 'CH3COOH_s' || spId === 'Br2_s' || Boolean(item.isFrozenSolid);
      const stateTagHtml = isMolten
        ? ` <span id="sp-conc-${spId}" class="text-[10.5px] font-mono text-orange-400 font-semibold">${t('moltenStateTag')}</span>`
        : isFrozen
        ? ` <span id="sp-conc-${spId}" class="text-[10.5px] font-mono text-sky-400 font-semibold">${t('frozenSolidTag')}</span>`
        : '';
      const thermalTitle = [
        sp.meltTempK && !sp.noMelt ? `T_nc: ${kelvinToCelsius(sp.meltTempK).toFixed(0)}°C` : null,
        sp.boilTempK ? `T_s: ${kelvinToCelsius(sp.boilTempK).toFixed(0)}°C` : null,
        sp.decompTempK ? `T_dec: ${kelvinToCelsius(sp.decompTempK).toFixed(0)}°C` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const molStr = n >= 0.01 ? `${formatNumber(n, 4)}` : `${formatNumber(n * 1000, 3)}m`;
      return `
        <tr class="border-b border-theme/50 last:border-0" id="sp-sol-row-${spId}" title="${thermalTitle}">
          <td class="py-1 font-semibold">${sp.formula}${stateTagHtml}</td>
          <td class="py-1 text-right font-mono" id="sp-mol-${spId}">${molStr}</td>
          <td class="py-1 text-right font-mono" id="sp-mass-${spId}">${formatNumber(massG, 3)}g</td>
        </tr>
      `;
    })
    .join('');
}

export function getSyringeCondenseInfo(syr, env, t) {
  const syrTempK = syr.tempK ?? env.tempK;
  const syrTempC = kelvinToCelsius(syrTempK);
  const condensedWaterMol = syr.condensedWaterMol || 0;
  const condensedEtOHMol = syr.condensedEtOHMol || 0;
  const condensedMol = condensedWaterMol + condensedEtOHMol;
  const frozenMol = syr.frozenWaterMol || 0;
  const condensedWaterMl = (condensedWaterMol * SPECIES.H2O_l.molarMass) / 0.997;
  const condensedEtOHMl = (condensedEtOHMol * SPECIES.C2H5OH_l.molarMass) / SPECIES.C2H5OH_l.density;
  const condensedMl = condensedWaterMl + condensedEtOHMl;
  const frozenMl = computeSyringeFrozenVolumeMl(syr);
  const overflowMl = computeLiquidVolumeL(syr.overflowMoles || {}, syrTempK) * 1000;
  const totalLiqMl = condensedMl + overflowMl;
  const totalFluidMl = totalLiqMl + frozenMl;
  const hasSteam = (syr.gasMoles?.H2O_g || 0) > 1e-6 || (syr.gasMoles?.C2H5OH_g || 0) > 1e-6;
  const isCondensing = (syr.lastCondenseRateMolS || 0) > 1e-6;
  const condSpec =
    condensedWaterMl > 0.0005 && condensedEtOHMl > 0.0005
      ? 'H₂O + C₂H₅OH'
      : condensedEtOHMl > 0.0005
      ? 'C₂H₅OH(l)'
      : 'H₂O(l)';
  const nh4clMol = syr.overflowMoles?.NH4Cl_s || 0;
  let condenseState =
    (syr.overflowOutRateMlS || 0) > 0.5
      ? `⚠️ ${t('alertSyringeOverflow')}`
      : isCondensing
      ? `💧 ${t('syringeCondenseActive')}`
      : frozenMol > 1e-5 && condensedMol <= 1e-5
      ? `❄️ ${t('syringeCondenseFrozen')}`
      : overflowMl > 0.05
      ? `💧 ${t('syringeLiquidOverflowLabel')}: ${overflowMl.toFixed(2)} mL`
      : condensedMol > 1e-5 || frozenMol > 1e-5
      ? `${frozenMol > condensedMol ? '❄️' : '💧'} ${t('syringeCondenseDone')} (${condSpec})`
      : hasSteam
      ? `♨️ ${t('syringeHotSteam')}`
      : t('syringeDryGas');
  if (nh4clMol > 1e-6) {
    condenseState += ` · 🧂 ${(nh4clMol * 1000).toFixed(2)} mmol NH₄Cl(s)`;
  }
  return {
    syrTempK,
    syrTempC,
    condensedMol,
    condensedWaterMl,
    condensedEtOHMl,
    condSpec,
    frozenMol,
    condensedMl,
    frozenMl,
    overflowMl,
    totalLiqMl,
    totalFluidMl,
    isCondensing,
    condenseState,
  };
}

export const PIPETTE_QUICK_DOSES = [0.05, 0.1, 0.5, 1, 2, 5, 10];
export const SEP_QUICK_RATES = [0.05, 0.1, 0.5, 1, 2, 5, 10];
export const BURETTE_QUICK_RATES = [0, 0.05, 0.1, 0.5, 1, 2, 5, 10];

export function renderPrecisionControlHtml({
  sliderId,
  readoutId,
  btnClass,
  dataAttr,
  labelText,
  valueText,
  sliderValue,
  min = 0.05,
  max = 10,
  step = 0.05,
  activeVal,
  presets,
  closedLabel = '0',
  unitLabel = '',
}) {
  const isZeroClose = (val) => val === 0;
  const gridCls = presets.length >= 8 ? 'grid grid-cols-4 gap-1' : 'flex flex-wrap gap-1';
  const btnFlexCls = presets.length >= 8 ? '' : 'flex-1 min-w-[40px]';
  return `
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold text-muted">${labelText}</span>
        <strong class="text-sm font-bold font-mono text-sky-400 shrink-0 whitespace-nowrap" id="${readoutId}">${valueText}</strong>
      </div>
      <input type="range" id="${sliderId}" min="${min}" max="${max}" step="${step}" value="${sliderValue}" class="w-full accent-sky-500 cursor-pointer" />
      <div class="${gridCls}">
        ${presets
          .map((p) => {
            const isActive = Math.abs(activeVal - p) < 0.01;
            const btnText = isZeroClose(p) ? `${closedLabel} (0)` : p === 10 && unitLabel ? `${p} ${unitLabel}` : `${p}`;
            return `<button type="button" class="${btnClass} ${btnFlexCls} py-1 px-1 rounded border text-[11px] font-mono ${
              isActive ? 'border-accent bg-accent/15 font-bold text-accent' : 'border-theme bg-surface text-muted hover:text-main'
            }" data-${dataAttr}="${p}">${btnText}</button>`;
          })
          .join('')}
      </div>
    </div>
  `;
}

export function syncPrecisionControlLive(container, { sliderId, readoutId, btnClass, dataAttr, activeVal, valueText, sliderValue }) {
  const readoutEl = container.querySelector(`#${readoutId}`);
  const sliderEl = container.querySelector(`#${sliderId}`);
  if (readoutEl) readoutEl.textContent = valueText;
  if (sliderEl && document.activeElement !== sliderEl && Math.abs(Number(sliderEl.value) - sliderValue) > 0.005) {
    sliderEl.value = sliderValue.toFixed(2);
  }
  container.querySelectorAll(`.${btnClass}`).forEach((btn) => {
    const p = Number(btn.dataset[dataAttr]);
    const isActive = Math.abs(activeVal - p) < 0.01;
    btn.classList.toggle('border-accent', isActive);
    btn.classList.toggle('bg-accent/15', isActive);
    btn.classList.toggle('font-bold', isActive);
    btn.classList.toggle('text-accent', isActive);
    btn.classList.toggle('border-theme', !isActive);
    btn.classList.toggle('bg-surface', !isActive);
    btn.classList.toggle('text-muted', !isActive);
  });
}

export function renderTlcSpotsListHtml(spots, emptyText = '') {
  if (!spots || spots.length === 0) {
    return `<div class="text-[11px] text-muted italic">${emptyText}</div>`;
  }
  return spots
    .map(
      (sp) => `<div class="flex items-center justify-between p-1.5 rounded border border-theme/60 bg-surface">
        <span class="flex items-center gap-1.5 truncate"><span class="w-2.5 h-2.5 rounded-full inline-block shrink-0" style="background:${sp.color}"></span><strong class="font-mono text-xs">${sp.formula}</strong>${sp.uvActive ? ' <span class="text-[10px] font-semibold text-emerald-400">UV</span>' : ''}</span>
        <span class="font-mono text-xs font-bold text-sky-400 shrink-0">R<sub>f</sub>=${sp.rf.toFixed(2)}</span>
      </div>`
    )
    .join('');
}

export function renderInspectorLogsAndCrossLabHtml(panel, item, langCode, t) {
  const { sim, logMode, callbacks } = panel;
  const hideRxnLogs = Boolean(sim.missionState?.active && (item?.hideComposition || sim.items.some((x) => x.hideComposition)));
    const logsHtml = `
      <div class="rounded-xl border border-theme bg-surface-alt p-3">
        <div class="flex flex-wrap items-center justify-between gap-1.5 mb-2">
          <h3 class="text-[13px] font-bold uppercase tracking-wide text-muted">${t('reactionLogTitle')}</h3>
          <div class="flex items-center gap-1">
            <div class="inline-flex rounded-md border border-theme bg-surface overflow-hidden text-[10.5px]">
              <button type="button" id="btn-log-student" class="px-2 py-0.5 font-semibold ${logMode !== 'expert' ? 'bg-accent text-white' : 'text-muted hover:text-main'}">${t('logModeStudent')}</button>
              <button type="button" id="btn-log-expert" class="px-2 py-0.5 font-semibold ${logMode === 'expert' ? 'bg-accent text-white' : 'text-muted hover:text-main'}">${t('logModeExpert')}</button>
            </div>
            <button type="button" id="btn-export-csv" class="px-1.5 py-0.5 rounded border border-theme bg-surface text-[10.5px] font-semibold hover:border-accent" title="${t('logExportCsv')}">📥 ${t('logExportCsv')}</button>
            <button type="button" id="btn-copy-data" class="px-1.5 py-0.5 rounded border border-theme bg-surface text-[10.5px] font-semibold hover:border-accent" title="${t('logCopyData')}">📋</button>
          </div>
        </div>
        <div class="space-y-1.5 max-h-52 overflow-y-auto pr-1">
          ${
            sim.logs.length === 0
              ? `<p class="text-xs text-muted">—</p>`
              : sim.logs
                  .map((log) => {
                    const ts = formatSimTimestamp(log.timeSec);
                    if (log.type === 'alert') {
                      return `<div class="p-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs">
                        <span class="font-mono text-muted">${ts}</span> ${log.vesselLabel ? `<strong class="font-mono">${log.vesselLabel}</strong> · ` : ''}⚠️ ${t(log.key)}
                      </div>`;
                    }
                    if (log.type === 'info') {
                      const themeCur = document.documentElement.getAttribute('data-theme');
                      const cureHead = themeCur === 'olivia' ? `<div class="font-bold text-[10.5px] mb-0.5">🩹 ${t('themeCureTitle')}</div>` : '';
                      return `<div class="olivia-cure-card p-2 rounded-lg border border-sky-500/40 bg-sky-500/10 text-xs leading-relaxed">
                        ${cureHead}<span class="font-mono text-muted mr-1">${ts}</span>${t(log.key)}
                      </div>`;
                    }
                    if (hideRxnLogs) {
                      return `<div class="p-2 rounded-lg border border-amber-500/30 bg-surface text-xs">
                        <div class="flex items-center justify-between text-[11px] font-mono text-muted mb-0.5">
                          <span>${log.vesselLabel || '?'} · ${ts}</span>
                          <span>🔒</span>
                        </div>
                        <p class="text-muted">${t('blindHiddenLogMsg')}</p>
                      </div>`;
                    }
                    if (logMode === 'expert') {
                      const dHStr = Number.isFinite(log.dH_kJ) ? `${log.dH_kJ >= 0 ? '+' : ''}${log.dH_kJ.toFixed(3)} kJ` : '—';
                      const rateStr = Number.isFinite(log.rateMolS) ? `${(log.rateMolS * 1000).toFixed(2)} mmol/s` : '—';
                      const phStr = Number.isFinite(log.phNow) ? log.phNow.toFixed(2) : '—';
                      const dPStr = Number.isFinite(log.deltaPBar) ? `${log.deltaPBar >= 0 ? '+' : ''}${log.deltaPBar.toFixed(3)} bar` : '0.000 bar';
                      return `<div class="p-2 rounded-lg border border-theme bg-surface text-xs">
                        <div class="flex items-center justify-between text-[11px] font-mono text-muted mb-1">
                          <span>${log.vesselLabel || '—'} · ${ts}</span>
                        </div>
                        <div class="chem-eq-line font-mono font-bold text-accent">${formatChemEquation(log.equation)}</div>
                        <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10.5px] font-mono text-muted">
                          <span>ΔH: <strong class="text-main">${dHStr}</strong></span>
                          <span>v: <strong class="text-sky-400">${rateStr}</strong></span>
                          <span>pH: <strong class="text-main">${phStr}</strong></span>
                          <span>ΔP: <strong class="text-main">${dPStr}</strong></span>
                        </div>
                      </div>`;
                    }
                    return `<div class="p-2 rounded-lg border border-theme bg-surface text-xs">
                      <div class="flex items-center justify-between text-[11px] font-mono text-muted mb-1">
                        <span>${log.vesselLabel || '—'} · ${ts}</span>
                      </div>
                      <div class="chem-eq-line font-mono font-bold text-accent">${formatChemEquation(log.equation)}</div>
                      ${log.ionicEq ? `<div class="font-mono text-[10.5px] text-sky-400 mb-1">${formatChemEquation(log.ionicEq)}</div>` : ''}
                      <p class="text-muted leading-relaxed">${langCode === 'vi' ? log.descVi : log.descEn}</p>
                    </div>`;
                  })
                  .join('')
          }
        </div>
      </div>
    `;

    const labsMeta = callbacks.getLabsMeta?.();
    const crossLabHtml =
      item && labsMeta && labsMeta.labs.length > 1
        ? `<div class="p-2.5 rounded-xl border border-theme bg-surface-alt flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-muted">📤 ${t('actionMoveToLab')}</span>
            <div class="flex items-center gap-1.5">
              <select id="ins-move-lab-select" class="px-2 py-1 rounded-lg border border-theme bg-surface text-xs font-semibold">
                ${labsMeta.labs
                  .map((lb, idx) =>
                    idx === labsMeta.activeIndex
                      ? ''
                      : `<option value="${idx}">${t('labTabPrefix')} ${lb.number}</option>`
                  )
                  .join('')}
              </select>
              <button type="button" id="ins-move-lab-btn" class="px-2.5 py-1 rounded-lg bg-accent text-white text-xs font-semibold hover:opacity-90">${t('actionMoveToLabBtn')}</button>
            </div>
          </div>`
        : '';

  return `${crossLabHtml}${logsHtml}`;
}

export function buildTelemetryCsvForItem(sim, item) {
    if (item && item.kind === 'vessel') {
      const hist = Array.isArray(item.history) ? item.history : [];
      const topIds = Object.keys(item.moles || {})
        .filter((k) => k !== 'H2O_l' && hasDisplayableSpeciesAmount(k, item.moles[k]))
        .slice(0, 6);
      const header = ['t_s', 'T_C', 'pH', 'P_bar', 'rate_mmol_s', ...topIds.map((id) => `${id}_M`)].join(',');
      if (hist.length === 0) {
        const liqL = computeLiquidVolumeL(item.moles, item.tempK);
        const ph = item.isFrozenSolid ? '' : computePH(item.moles, liqL, item.tempK)?.toFixed(2) ?? '';
        const pBar = (item.internalPressureBar ?? sim.environment?.pressureBar ?? 1).toFixed(4);
        const cmVals = topIds.map((id) => (liqL > 1e-6 ? ((item.moles[id] || 0) / liqL).toFixed(4) : '0.0000'));
        return `${header}\n${sim.timeSec.toFixed(2)},${kelvinToCelsius(item.tempK).toFixed(2)},${ph},${pBar},${((item.lastTotalRateMolS || 0) * 1000).toFixed(3)},${cmVals.join(',')}`;
      }
      const rows = hist.map((pt) => {
        const tC = kelvinToCelsius(pt.tempK ?? item.tempK).toFixed(2);
        const phS = pt.ph !== null && pt.ph !== undefined ? Number(pt.ph).toFixed(2) : '';
        const pS = Number.isFinite(pt.pressureBar) ? pt.pressureBar.toFixed(4) : '';
        const rS = ((pt.rateMolS || 0) * 1000).toFixed(3);
        const vL = pt.liqL ?? computeLiquidVolumeL(pt.moles || {}, pt.tempK);
        const cmVals = topIds.map((id) => (vL > 1e-6 ? (((pt.moles || {})[id] || 0) / vL).toFixed(4) : '0.0000'));
        return `${pt.t.toFixed(2)},${tC},${phS},${pS},${rS},${cmVals.join(',')}`;
      });
      return `${header}\n${rows.join('\n')}`;
    }
    const bt = computeBenchTelemetry(sim);
    const atm = computeAtmospherePartialPressures(sim.environment);
    const header = 'time_s,bench_mass_g,chem_mass_g,escaped_gas_g,p_total_bar,p_o2_bar,rh_pct,event';
    const baseRow = `${sim.timeSec.toFixed(2)},${bt.totalBenchMassG.toFixed(3)},${bt.totalChemMassG.toFixed(3)},${bt.totalEscapedGasMassG.toFixed(4)},${atm.pTotalBar.toFixed(3)},${atm.pO2Bar.toFixed(3)},${atm.rhPct.toFixed(1)},BENCH_SNAPSHOT`;
    const logRows = (sim.logs || []).slice(0, 30).map((lg) => {
      const msg = (lg.equation || lg.key || '').replace(/"/g, "'");
      return `${(lg.timeSec || 0).toFixed(2)},,,,,,,\"${msg}\"`;
    });
    return `${header}\n${baseRow}${logRows.length ? '\n' + logRows.join('\n') : ''}`;
  }
