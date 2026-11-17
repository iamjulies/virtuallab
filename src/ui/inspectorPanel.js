import { APPARATUS, getStandGeometry } from '../data/apparatus.js';
import { CONSTANTS, kelvinToCelsius } from '../data/constants.js';
import { GAS_DISPLAY_META, isSolidMoltenAtTemp, SPECIES, STARTER_REAGENTS } from '../data/species.js';
import { ELECTRODE_MATERIALS } from '../engine/electrochemistry.js';
import {
  computeContentsMassG,
  computeLiquidVolumeL,
  computePH,
} from '../engine/equilibrium.js';
import {
  computeSyringeDischargeArc,
  computeSyringeFrozenVolumeMl,
  computeSyringeGasVolumeMl,
  computeSyringeLiquidVolumeMl,
  computeSyringeTotalVolumeMl,
  computeTubingGeometry,
} from '../engine/gasNetwork.js';
import { computeWashBottleStreamArc } from '../engine/apparatusTools.js';
import { computeCaOOptimizationScore } from '../engine/chemistry.js';
import { soundEngine } from '../audio/soundEngine.js';

function renderFlipButtonHtml(item, t) {
  if (!APPARATUS[item.typeId]?.flippable) return '';
  return `<button type="button" id="ins-flip-x" class="px-2 py-1 rounded-lg border ${
    item.flippedX ? 'border-accent bg-accent/15 text-accent font-semibold' : 'border-theme bg-surface text-main'
  } text-xs hover:border-accent" title="${t(item.flippedX ? 'flipDirRight' : 'flipDirLeft')}">${t('actionFlipHorizontal')}</button>`;
}

const CHART_PALETTE = [
  '#38bdf8',
  '#f472b6',
  '#fbbf24',
  '#34d399',
  '#a78bfa',
  '#fb7185',
  '#f97316',
];

function sumAllGasMoles(gasMap = {}) {
  let tot = 0;
  for (const g of GAS_DISPLAY_META) tot += gasMap[g.id] || 0;
  return tot;
}

function formatGasSummaryHtml(gasMap = {}, escapedFrostMol = 0, t = null) {
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

function getSyringeCondenseInfo(syr, env, t) {
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

export class InspectorPanel {
  constructor(container, sim, getLang, callbacks) {
    this.container = container;
    this.sim = sim;
    this.getLang = getLang;
    this.callbacks = callbacks; // { onOpenTransfer, onNotify }
    this.lastStructureSig = '';
    this.isDark = true;
  }

  setTheme(isDark) {
    this.isDark = isDark;
  }

  setSim(sim) {
    this.sim = sim;
    this.lastStructureSig = '';
  }

  getStructureSignature(t, langCode) {
    const item = this.sim.getItem(this.sim.selectedId);
    const logLen = this.sim.logs.length;
    const standCount = this.sim.items.filter((i) => i.kind === 'stand').length;
    const labsInfo = this.callbacks.getLabsMeta?.();
    const labSig = labsInfo ? `${labsInfo.labs.length}:${labsInfo.activeIndex}` : '';
    const atmMode = this.sim.environment?.atmosphereMode || 'air';
    if (!item) return `none|${atmMode}|${labSig}|${langCode}|${logLen}`;

    if (item.kind === 'vessel') {
      const spKeys = Object.keys(item.moles)
        .filter((k) => item.moles[k] > 1e-10)
        .sort()
        .join(',');
      const rxnKeys = item.activeReactions.map((r) => r.id).join(',');
      const hasFrost = (item.escapedFrostH2OMol || 0) > 1e-6 ? 1 : 0;
      const purgedFlag = (item.headspaceGasMoles?.H2_g || 0) > 1e-5 || (item.moles.CuO_s || 0) > 1e-7
        ? ((item.airO2PurgeFrac ?? 1) <= 0.14 ? 'P' : 'U')
        : 'N';
      const airFlags = `${(item.naTarnishFrac || 0) > 0.25 ? 1 : 0}${(item.naohDeliquesceFrac || 0) > 0.15 ? 1 : 0}${(item.caCo3FilmFrac || 0) > 0.25 ? 1 : 0}${item.fePassivated ? 1 : 0}${(item.znCombustionTimer || 0) > 0.05 ? 1 : 0}${purgedFlag}`;
      const phenFlags = `${item.isSupersaturated ? 1 : 0}${(item.znPassivationFrac || 0) > 0.35 ? 1 : 0}${(item.pickeringFoamMl || 0) > 0.5 ? 1 : 0}${(item.langmuirCoverage || 0) > 0.55 ? 1 : 0}`;
      const cmpFlag = Array.isArray(this.sim.compareVesselIds) && this.sim.compareVesselIds.includes(item.id) ? 1 : 0;
      const softenFlag = (item.softenGlowFrac || 0) > 0.1 || (item.softenSagFrac || 0) > 0.05 ? 1 : 0;
      const caoScore = computeCaOOptimizationScore(item);
      const caoSig = caoScore
        ? `${caoScore.points}:${caoScore.groundFine ? 1 : 0}${caoScore.ventedWhileHeating ? 1 : 0}${caoScore.roaringBlueZone ? 1 : 0}${caoScore.cooledProtected ? 1 : 0}`
        : 'n';
      return `v|${atmMode}|${labSig}|${airFlags}|${item.id}|${item.isStoppered}|${item.lidState || 'open'}|${cmpFlag}|${softenFlag}|${caoSig}|${item.isInverted ? 1 : 0}|${item.hasStirBar ? 1 : 0}|${item.magStirRpm || 0}|${item.isFrozenSolid ? 1 : 0}|${hasFrost}|${phenFlags}|${item.connectedTargetId || item.connectedSyringeId}|${item.isShattered}|${item.clampedToId}|${standCount}|${spKeys}|${rxnKeys}|${langCode}|${logLen}`;
    }
    if (item.kind === 'burner') {
      return `b|${item.id}|${item.typeId}|${item.airHoleOpen !== false ? 1 : 0}|${langCode}|${logLen}`;
    }
    if (item.kind === 'pipette') {
      return `p|${item.id}|${item.isBroken}|${Math.round((item.dropDoseMl || 1) * 100)}|${langCode}|${logLen}`;
    }
    if (item.kind === 'scale') {
      return `s|${item.id}|${Math.abs(item.tareG) > 0.001}|${langCode}|${logLen}`;
    }
    if (item.kind === 'stand') {
      const children = this.sim.items.filter((i) => i.clampedToId === item.id).map((i) => i.id).join(',');
      return `st|${item.id}|${item.flippedX ? 1 : 0}|${children}|${langCode}|${logLen}`;
    }
    if (item.kind === 'gas_syringe') {
      const hasIce = (item.frozenWaterMol || 0) > 1e-5 ? 1 : 0;
      return `g|${item.id}|${item.flippedX ? 1 : 0}|${hasIce}|${item.connectedFromId}|${item.clampedToId}|${standCount}|${item.isBroken}|${langCode}|${logLen}`;
    }
    if (item.kind === 'wash_bottle') {
      return `wb|${item.id}|${item.flippedX ? 1 : 0}|${item.isSpraying ? 1 : 0}|${langCode}|${logLen}`;
    }
    if (item.kind === 'filter_funnel' || item.kind === 'burette') {
      const spKeys = Object.keys(item.moles || {}).filter((k) => item.moles[k] > 1e-10).sort().join(',');
      return `${item.kind}|${item.id}|${item.isBroken ? 1 : 0}|${item.clampedToId}|${item.valveRateMlS || 0}|${item.isFiltering ? 1 : 0}|${item.uvMaskHalf ? 1 : 0}|${spKeys}|${langCode}|${logLen}`;
    }
    if (item.kind === 'rubber_stopper') {
      return `rb|${item.id}|${item.stopperMode || 'holed'}|${item.attachedToId || ''}|${item.attachedSide || ''}|${langCode}|${logLen}`;
    }
    if (item.kind === 'phen_cotton') {
      return `pc|${item.id}|${item.attachedToId || ''}|${item.attachedSide || ''}|${Math.round((item.dampness ?? 0.85) * 100)}|${langCode}|${logLen}`;
    }
    if (item.kind === 'dc_power') {
      return `dc|${item.id}|${item.powerOn ? 1 : 0}|${item.circuitMode}|${item.posElectrodeId || ''}|${item.negElectrodeId || ''}|${Math.round((item.rheostatOhm ?? 2) * 10)}|${langCode}|${logLen}`;
    }
    if (item.kind === 'volt_ammeter') {
      const elCnt = this.sim.items.filter((i) => i.kind === 'electrode' && i.dockedVesselId).length;
      return `vm|${item.id}|${item.mode}|${item.circuitMode}|${item.posElectrodeId || ''}|${item.negElectrodeId || ''}|${item.cathodicProtectedActive ? 1 : 0}|${elCnt}|${langCode}|${logLen}`;
    }
    if (item.kind === 'diffusion_tube') {
      return `dtube|${item.id}|${item.leftGasId || ''}|${item.rightGasId || ''}|${(item.ringGrowth || 0) > 0.05 ? 1 : 0}|${item.isBroken ? 1 : 0}|${langCode}|${logLen}`;
    }
    if (item.kind === 'electrode') {
      const mountedTube = this.sim.items.find((i) => i.mountedOverElectrodeId === item.id);
      const colCnt = this.sim.items.filter((i) => !i.isBroken && !i.isShattered && (i.kind === 'gas_syringe' || i.kind === 'vessel')).length;
      const hasAg = (item.platedAgMol || 0) > 1e-7 ? 1 : 0;
      return `el|${item.id}|${item.material}|${item.dockedVesselId || ''}|${item.polarityLabel || ''}|${item.platedMaterial || ''}|${item.platedQuality || ''}|${hasAg}|${item.cathodicProtectedActive ? 1 : 0}|${item.gasTargetId || ''}|${mountedTube?.id || ''}|${colCnt}|${langCode}|${logLen}`;
    }
    if (item.kind === 'splint') {
      return `sp|${item.id}|${item.flippedX ? 1 : 0}|${item.mode}|${langCode}|${logLen}`;
    }
    if (item.kind === 'condenser') {
      const vCnt = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered).length;
      return `co|${item.id}|${item.flippedX ? 1 : 0}|${item.isBroken ? 1 : 0}|${item.waterFlowOn ? 1 : 0}|${item.clampedToId}|${item.connectedFromId || ''}|${item.outletTargetId || ''}|${vCnt}|${langCode}|${logLen}`;
    }
    if (item.kind === 'flame_loop') {
      return `fl|${item.id}|${item.flippedX ? 1 : 0}|${item.sampledIon || ''}|${langCode}|${logLen}`;
    }
    if (item.kind === 'indicator_strip') {
      return `ind|${item.id}|${item.flippedX ? 1 : 0}|${item.stripKind}|${item.sampledPH ?? 'null'}|${item.tipColor}|${item.isBleached ? 1 : 0}|${langCode}|${logLen}`;
    }
    if (item.kind === 'stir_bar') {
      const host = item.inVesselId ? this.sim.getItem(item.inVesselId) : null;
      const vCnt = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isStoppered).length;
      return `sb_bar|${item.id}|${item.inVesselId || ''}|${host?.magStirRpm || 0}|${vCnt}|${langCode}|${logLen}`;
    }
    if (item.kind === 'salt_bridge') {
      return `sbr|${item.id}|${item.isBroken ? 1 : 0}|${item.vesselAId || ''}|${item.vesselBId || ''}|${langCode}|${logLen}`;
    }
    if (item.kind === 'tongs') {
      const sampleFlag = item.heldSample ? `${item.heldSample.speciesId}:${item.heldSample.moles > 1e-8 ? 1 : 0}` : 'none';
      const vCnt = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered).length;
      return `tg|${item.id}|${item.grippedVesselId || ''}|${sampleFlag}|${vCnt}|${langCode}|${logLen}`;
    }
    if (item.kind === 'spoon') {
      const spKeys = Object.keys(item.moles || {})
        .filter((k) => item.moles[k] > 1e-10)
        .sort()
        .join(',');
      const vCnt = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered).length;
      return `spn|${item.id}|${item.flippedX ? 1 : 0}|${spKeys}|${vCnt}|${langCode}|${logLen}`;
    }
    return `other|${item.id}|${langCode}|${logLen}`;
  }

  update(langCode, force = false) {
    const t = this.getLang();
    const sig = this.getStructureSignature(t, langCode);
    if (force || sig !== this.lastStructureSig) {
      this.lastStructureSig = sig;
      this.renderFull(t, langCode);
    } else {
      this.updateLiveNumbers(t);
    }
    this.drawChart();
  }

  renderFull(t, langCode) {
    const item = this.sim.getItem(this.sim.selectedId);
    let topSection = '';

    if (!item) {
      topSection = `
        <div class="p-4 rounded-xl border border-theme bg-surface-alt text-center">
          <div class="text-sm font-semibold">${t('noSelection')}</div>
          <p class="text-xs text-muted mt-1 leading-relaxed">${t('selectVesselTip')}</p>
        </div>
      `;
    } else if (item.kind === 'scale') {
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <span class="text-sm font-bold">${t('eq_scale')} ${item.label}</span>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          <div class="p-3 rounded-lg bg-slate-950 text-emerald-400 font-mono text-2xl font-bold text-right" id="live-scale-readout">
            ${(item.measuredG || 0).toFixed(2)} g
          </div>
          <div class="grid grid-cols-2 gap-2">
            <button type="button" id="ins-tare" class="py-1.5 rounded-lg bg-accent text-white text-xs font-semibold">${t('actionTare')}</button>
            <button type="button" id="ins-clear-tare" class="py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium">${t('actionClearTare')}</button>
          </div>
        </div>
      `;
    } else if (item.kind === 'burner') {
      const bSpec = APPARATUS[item.typeId] || APPARATUS.burner;
      const isBunsen = item.typeId === 'bunsen_burner';
      const airOpen = isBunsen ? item.airHoleOpen !== false : true;
      const powerTbl = isBunsen && !airOpen ? bSpec.yellowPowerLevelsW : bSpec.powerLevelsW;
      const maxPowerW = isBunsen && !airOpen ? (bSpec.yellowPowerLevelsW[3] || 820) : (bSpec.maxPowerW || 650);
      const powerW = item.powerW ?? (powerTbl[item.flameLevel || 0] || 0);
      const levels = [
        { lvl: 0, label: t('burnerOff'), w: powerTbl[0] ?? 0 },
        { lvl: 1, label: t('burnerLow'), w: powerTbl[1] ?? 160 },
        { lvl: 2, label: t('burnerMed'), w: powerTbl[2] ?? 360 },
        { lvl: 3, label: t('burnerHigh'), w: powerTbl[3] ?? maxPowerW },
      ];
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-bold">🔥 ${t(bSpec.i18nKey || 'eq_burner')} ${item.label}</div>
              ${bSpec.isoStandard ? `<div class="text-[11px] text-muted">${bSpec.isoStandard}</div>` : ''}
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          ${
            isBunsen
              ? `<div class="flex items-center justify-between gap-2 p-2 rounded-lg border border-theme bg-surface">
                   <span class="text-xs text-muted">${t('bunsenAirCollarLabel')}</span>
                   <button type="button" id="ins-bunsen-air-toggle" class="px-2.5 py-1 rounded-lg border text-xs font-semibold ${
                     airOpen
                       ? 'border-sky-500/60 bg-sky-500/15 text-sky-400'
                       : 'border-amber-500/60 bg-amber-500/15 text-amber-400'
                   }">${airOpen ? t('bunsenAirOpenBtn') : t('bunsenAirClosedBtn')}</button>
                 </div>`
              : ''
          }
          <div class="flex items-center justify-between text-xs text-muted">
            <span>${t('burnerPower')}</span>
            <strong class="text-sm font-mono ${isBunsen && airOpen ? 'text-sky-400' : 'text-orange-400'}" id="live-burner-power">${Math.round(powerW)} W</strong>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-[11px] text-muted">${t('burnerSliderLabel')}</label>
            <input type="range" id="burner-power-slider" min="0" max="${maxPowerW}" step="5" value="${Math.round(powerW)}" class="w-full accent-orange-500 cursor-pointer" />
            <div class="flex justify-between text-[10px] font-mono text-muted">
              <span>${levels[0].w} W</span><span>${levels[1].w} W</span><span>${levels[2].w} W</span><span>${levels[3].w} W</span>
            </div>
          </div>
          <div class="grid grid-cols-4 gap-1.5">
            ${levels
              .map(
                (l) => `
              <button type="button" data-flame="${l.lvl}" data-w="${l.w}" class="flame-btn py-1.5 rounded-lg text-[11px] font-semibold border ${
                Math.round(powerW) === l.w
                  ? 'border-orange-500 bg-orange-500/20 text-orange-400'
                  : 'border-theme bg-surface text-muted'
              }">${l.label}</button>
            `
              )
              .join('')}
          </div>
        </div>
      `;
    } else if (item.kind === 'pipette') {
      const pipSpec = APPARATUS.pipette_10;
      const pipVol = item.volumeMl || 0;
      const dropDose = item.dropDoseMl || 1.0;
      const doses = [
        { val: 0.05, label: '0.05 mL (1g)' },
        { val: 0.5, label: '0.50 mL' },
        { val: 1.0, label: '1.00 mL' },
        { val: 10.0, label: t('pipetteFullDose') },
      ];
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-bold">🧪 ${t('eq_pipette_10')} ${item.label}</div>
              <div class="text-[11px] text-muted">${pipSpec.materialSpec} · ${pipSpec.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <div class="text-xs text-muted">${t('pipetteVolumeLabel')}</div>
              <div class="text-base font-bold font-mono text-accent" id="live-pip-vol">${pipVol.toFixed(2)} / 10.00 mL</div>
            </div>
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <div class="text-xs text-muted">${t('pipetteSourceLabel')}</div>
              <div class="text-xs font-semibold truncate mt-0.5" id="live-pip-src">${item.sourceLabel || '—'}</div>
            </div>
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="text-xs text-muted">${t('pipetteDropDoseLabel')}</div>
            <div class="grid grid-cols-4 gap-1.5">
              ${doses
                .map(
                  (d) => `
                <button type="button" data-dose="${d.val}" class="pip-dose-btn py-1.5 px-1 rounded-lg text-[11px] font-semibold border ${
                  Math.abs(dropDose - d.val) < 0.01
                    ? 'border-accent bg-accent/15 text-main'
                    : 'border-theme bg-surface text-muted'
                }">${d.label}</button>
              `
                )
                .join('')}
            </div>
          </div>
          <p class="text-[11px] text-muted leading-relaxed">${t('pipetteBenchHint')}</p>
          <button type="button" id="ins-clear-pipette" class="py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('pipetteClear')}</button>
        </div>
      `;
    } else if (item.kind === 'stand') {
      const stSpec = APPARATUS.retort_stand;
      const clampedItems = this.sim.items.filter((i) => i.clampedToId === item.id);
      const extPx = Math.round(item.extendPx || 0);
      const extMm = Math.round(extPx / 1.15);
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🗜️ ${t('standTitle')} ${item.label}</div>
              <div class="text-[11px] text-muted">${stSpec.materialSpec} · ${stSpec.isoStandard}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
            </div>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface flex flex-col gap-1.5">
            <div class="flex items-center justify-between text-xs">
              <span class="text-muted">${t('standExtendLabel')}</span>
              <strong class="font-mono text-amber-400" id="live-stand-ext">${stSpec.heightMm + extMm} mm (+${extMm} mm)</strong>
            </div>
            <input id="stand-extend-slider" type="range" min="0" max="200" step="2" value="${extPx}" class="w-full accent-amber-500 cursor-pointer" />
            <p class="text-[10px] text-muted">${t('standExtendHint')}</p>
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="text-xs font-medium text-muted">${t('standClampedList')}</div>
            ${
              clampedItems.length === 0
                ? `<p class="text-xs text-muted leading-relaxed">${t('standNoClamped')}</p>`
                : clampedItems
                    .map(
                      (c) => `
                  <div class="flex items-center justify-between p-2 rounded-lg border border-theme bg-surface text-xs">
                    <span class="font-semibold">${t(APPARATUS[c.typeId].i18nKey)} ${c.label}</span>
                    <button type="button" class="stand-detach-btn px-2 py-0.5 rounded border border-theme text-[11px] text-amber-400 hover:bg-amber-500/10" data-cid="${c.id}">${t('actionUnclampStand')}</button>
                  </div>`
                    )
                    .join('')
            }
          </div>
        </div>
      `;
    } else if (item.kind === 'gas_syringe') {
      const syrSpec = APPARATUS.gas_syringe;
      const volMl = computeSyringeTotalVolumeMl(item, this.sim.environment);
      const totalGasMol = sumAllGasMoles(item.gasMoles);
      const condInfo = getSyringeCondenseInfo(item, this.sim.environment, t);
      const stands = this.sim.items.filter((i) => i.kind === 'stand');
      const arc = !item.isBroken
        ? computeSyringeDischargeArc(item, this.sim.items, 482, 1800)
        : null;
      const catchLabel = arc?.hitTargetVessel
        ? `🎯 ${t(APPARATUS[arc.hitTargetVessel.typeId].i18nKey)} ${arc.hitTargetVessel.label}`
        : t('syringeCatchMiss');
      const pBar = item.internalPressureBar ?? this.sim.environment.pressureBar;
      const overPBar = pBar - this.sim.environment.pressureBar;

      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_gas_syringe')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
              <div class="text-[11px] text-muted">${syrSpec.materialSpec} · ${syrSpec.isoStandard}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <div class="text-xs text-muted">${t('syringeVolLabel')}</div>
              <div class="text-base font-bold font-mono" id="live-syr-vol">${volMl.toFixed(2)} mL</div>
            </div>
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <div class="text-xs text-muted">${t('syringeTotalGasLabel')}</div>
              <div class="text-base font-bold font-mono" id="live-syr-mol">${(totalGasMol * 1000).toFixed(2)} mmol</div>
            </div>
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <div class="text-xs text-muted">${t('syringeGasTempLabel')}</div>
              <div class="text-sm font-bold font-mono" id="live-syr-temp">${condInfo.syrTempK.toFixed(1)} K (${condInfo.syrTempC.toFixed(1)}°C)</div>
            </div>
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <div class="text-xs text-muted">${t('syringeCondenseLabel')}</div>
              <div class="text-sm font-bold font-mono text-sky-400" id="live-syr-cond">${condInfo.totalFluidMl.toFixed(2)} mL</div>
            </div>
          </div>
          <div class="p-2 rounded-lg border border-theme bg-surface text-[11px] flex items-center justify-between gap-2">
            <span class="text-muted">${t('syringePressureNote')}</span>
            <strong class="font-mono ${overPBar >= 0.35 ? 'text-red-400' : 'text-main'}" id="live-syr-press">${pBar.toFixed(2)} bar (ΔP ${overPBar >= 0 ? '+' : ''}${overPBar.toFixed(2)} / +${(syrSpec.shatterOverpressureBar || 1.05).toFixed(2)} bar)</strong>
          </div>
          <div class="px-2.5 py-1.5 rounded-lg border border-sky-500/35 bg-sky-500/10 text-xs font-medium" id="live-syr-cond-state">
            ${condInfo.condenseState}
          </div>
          <div class="text-xs text-muted flex flex-wrap gap-x-2 gap-y-0.5" id="live-syr-breakdown">
            ${formatGasSummaryHtml(item.gasMoles)}
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('shatteredEmptyMsg')}</p>${
                  item.clampedToId
                    ? `<button type="button" id="ins-toggle-clamp" class="mt-1 py-1.5 px-2.5 rounded-lg border border-amber-500/50 bg-amber-500/10 text-xs font-medium text-amber-300 hover:bg-amber-500/20">${t('actionUnclampStand')}</button>`
                    : ''
                }`
              : `
            <div class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-[11px] flex items-center justify-between gap-2">
              <span class="text-muted">${t('syringeCatchHint')}</span>
              <span class="font-semibold truncate" id="live-syr-catch">${catchLabel}</span>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <button type="button" id="ins-syringe-hold-push" class="py-1.5 px-2 rounded-lg bg-sky-600 text-white text-xs font-semibold hover:bg-sky-500 select-none">💨 ${t('syringeHoldPush')}</button>
              <button type="button" id="ins-syringe-pump" class="py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">💉 ${t('syringePumpTo')}</button>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <button type="button" id="ins-vent-syringe" class="flex-1 py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('syringeReleaseGas')}</button>
              ${
                stands.length > 0
                  ? `<button type="button" id="ins-toggle-clamp" class="py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${
                      item.clampedToId ? t('actionUnclampStand') : t('actionClampStand')
                    }</button>`
                  : ''
              }
            </div>`
          }
        </div>
      `;
    } else if (item.kind === 'filter_funnel') {
      const fSpec = APPARATUS.filter_funnel;
      const stands = this.sim.items.filter((i) => i.kind === 'stand');
      const solids = Object.entries(item.moles || {}).filter(([id, n]) => n > 1e-8 && SPECIES[id]?.phase === 's');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_filter_funnel')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
              <div class="text-[11px] text-muted">${fSpec.materialSpec} · ${fSpec.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('alertToolBreak')}</p>`
              : `<div class="p-2.5 rounded-lg border border-theme bg-surface text-xs">
                  <div class="text-muted mb-1 font-medium">${langCode === 'en' ? 'Filter Paper Residue (Retained (s)):' : 'Bã rắn trên giấy lọc ((s)):'}</div>
                  ${
                    solids.length === 0
                      ? `<div class="text-muted">${langCode === 'en' ? '— Empty filter paper —' : '— Giấy lọc đang sạch —'}</div>`
                      : solids
                          .map(([id, n]) => `<div class="font-mono flex justify-between"><span>${SPECIES[id]?.formula || id}</span><span>${(n * 1000).toFixed(2)} mmol</span></div>`)
                          .join('')
                  }
                </div>
                <div class="flex flex-wrap gap-1.5">
                  ${solids.length > 0 ? `<button type="button" id="ins-solid-xfer" class="px-2.5 py-1.5 rounded-lg bg-accent text-white text-xs font-semibold hover:opacity-90">${t('actionTransferSolid')}</button>` : ''}
                  ${((item.moles?.AgCl_s || 0) > 1e-7 || (item.moles?.Ag_s || 0) > 1e-7) ? `<button type="button" id="ins-funnel-mask" class="px-2.5 py-1.5 rounded-lg border ${item.uvMaskHalf ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-theme bg-surface'} text-xs font-medium hover:border-accent">${item.uvMaskHalf ? t('actionUvUnmask') : t('actionUvMaskHalf')}</button>` : ''}
                  ${stands.length > 0 ? `<button type="button" id="ins-toggle-clamp" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${item.clampedToId ? t('actionUnclampStand') : t('actionClampStand')}</button>` : ''}
                </div>`
          }
        </div>
      `;
    } else if (item.kind === 'wash_bottle') {
      const wbArc = computeWashBottleStreamArc(item, this.sim.items, 482, CONSTANTS.GRAVITY_PX_S2 || 1800);
      const wbCatchLabel = wbArc?.hitTarget
        ? `🎯 ${t(APPARATUS[wbArc.hitTarget.typeId].i18nKey)} ${wbArc.hitTarget.label}`
        : t('syringeCatchMiss');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_wash_bottle')} ${item.label}</div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
            </div>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface flex justify-between items-center">
            <span class="text-xs text-muted">H₂O(l)</span>
            <strong class="text-sm font-mono text-sky-400" id="live-wb-vol">${(item.waterMl || 0).toFixed(1)} / 250 mL</strong>
          </div>
          <div class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-[11px] flex items-center justify-between gap-2">
            <span class="text-muted">${t('syringeCatchHint')}</span>
            <span class="font-semibold truncate" id="live-wb-catch">${wbCatchLabel}</span>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <button type="button" id="ins-wb-squirt" class="py-1.5 px-2 rounded-lg bg-sky-600 text-white text-xs font-semibold hover:bg-sky-500">${t('actionSquirtWash')}</button>
            <button type="button" id="ins-wb-spray-toggle" class="py-1.5 px-2 rounded-lg border ${item.isSpraying ? 'border-sky-500 bg-sky-500/20 text-sky-400 font-semibold' : 'border-theme bg-surface text-main font-medium'} text-xs hover:border-accent">${t(item.isSpraying ? 'actionSprayContinuousStop' : 'actionSprayContinuousStart')}</button>
          </div>
          <button type="button" id="ins-wb-refill" class="py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('actionRefillWash')}</button>
          <p class="text-[11px] text-muted leading-snug">${t('washBottleAimHint')}</p>
        </div>
      `;
    } else if (item.kind === 'condenser') {
      const stands = this.sim.items.filter((i) => i.kind === 'stand');
      const inletSrcs = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && APPARATUS[i.typeId]?.stopperable);
      const outletDsts = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isStoppered && i.id !== item.connectedFromId);
      const curInlet = item.connectedFromId ? this.sim.getItem(item.connectedFromId) : null;
      const curOutlet = item.outletTargetId ? this.sim.getItem(item.outletTargetId) : null;
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_liebig_condenser')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
            </div>
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('alertToolBreak')}</p>`
              : `<div class="p-2.5 rounded-lg border border-theme bg-surface flex justify-between items-center text-xs">
                  <span class="text-muted">${langCode === 'en' ? 'Distillate Condensed:' : 'Dịch chưng cất thu được:'}</span>
                  <strong class="font-mono text-sky-400" id="live-cond-ml">${(item.totalCondensedMl || 0).toFixed(2)} mL</strong>
                </div>
                <div class="flex flex-col gap-2 pt-1 border-t border-theme/50 text-xs">
                  <div class="flex flex-col gap-1">
                    <span class="text-muted">${t('condInletLabel')}</span>
                    <div class="flex items-center gap-1.5">
                      <div class="flex-1 px-2 py-1 rounded border border-theme bg-surface text-xs truncate">
                        ${curInlet ? `${t(APPARATUS[curInlet.typeId].i18nKey)} ${curInlet.label}` : '—'}
                      </div>
                      <button type="button" id="ins-cond-in-pick" ${inletSrcs.length === 0 ? 'disabled' : ''} class="px-2 py-1 rounded bg-amber-600 text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">${t('btnPickOnBench')}</button>
                      ${
                        item.connectedFromId
                          ? `<button type="button" id="ins-cond-in-dis" class="px-2 py-1 rounded border border-red-500/40 bg-red-500/10 text-red-400 text-xs">${t('condDisconnect')}</button>`
                          : ''
                      }
                    </div>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="text-muted">${t('condOutletLabel')}</span>
                    <div class="flex items-center gap-1.5">
                      <div class="flex-1 px-2 py-1 rounded border border-theme bg-surface text-xs truncate">
                        ${curOutlet ? `${t(APPARATUS[curOutlet.typeId].i18nKey)} ${curOutlet.label}` : '—'}
                      </div>
                      <button type="button" id="ins-cond-out-pick" ${outletDsts.length === 0 ? 'disabled' : ''} class="px-2 py-1 rounded bg-sky-600 text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">${t('btnPickOnBench')}</button>
                      ${
                        item.outletTargetId
                          ? `<button type="button" id="ins-cond-out-dis" class="px-2 py-1 rounded border border-red-500/40 bg-red-500/10 text-red-400 text-xs">${t('condDisconnect')}</button>`
                          : ''
                      }
                    </div>
                  </div>
                  <p class="text-[11px] text-muted leading-snug">${t('condDragHint')}</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button type="button" id="ins-cond-water" class="flex-1 py-1.5 px-2.5 rounded-lg border ${item.waterFlowOn ? 'border-sky-500/40 bg-sky-500/15 text-sky-400' : 'border-theme bg-surface text-muted'} text-xs font-semibold">${t('actionToggleWaterFlow')} ${item.waterFlowOn ? (langCode === 'en' ? 'ON' : 'BẬT') : (langCode === 'en' ? 'OFF' : 'TẮT')}</button>
                  ${stands.length > 0 ? `<button type="button" id="ins-toggle-clamp" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${item.clampedToId ? t('actionUnclampStand') : t('actionClampStand')}</button>` : ''}
                </div>`
          }
        </div>
      `;
    } else if (item.kind === 'burette') {
      const liqMl = computeLiquidVolumeL(item.moles, item.tempK) * 1000;
      const stands = this.sim.items.filter((i) => i.kind === 'stand');
      const liqReagents = STARTER_REAGENTS.filter((r) => r.kind === 'liquid');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_burette_50')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('alertToolBreak')}</p>`
              : `<div class="grid grid-cols-2 gap-2">
                  <div class="p-2.5 rounded-lg border border-theme bg-surface">
                    <div class="text-xs text-muted">${t('metricVol')}</div>
                    <div class="text-sm font-bold font-mono" id="live-bur-vol">${liqMl.toFixed(2)} / 50.0 mL</div>
                  </div>
                  <div class="p-2.5 rounded-lg border border-theme bg-surface">
                    <div class="text-xs text-muted">${langCode === 'en' ? 'Dispensed (ΔV)' : 'Đã nhỏ (ΔV)'}</div>
                    <div class="text-sm font-bold font-mono text-emerald-400" id="live-bur-disp">${(item.dispensedMl || 0).toFixed(2)} mL</div>
                  </div>
                </div>
                <div class="flex flex-col gap-1.5">
                  <span class="text-xs text-muted font-medium">${t('buretteValveLabel')}</span>
                  <div class="grid grid-cols-4 gap-1.5">
                    ${[0, 0.15, 0.8, 3.0]
                      .map(
                        (r) => `<button type="button" class="bur-rate-btn py-1.5 rounded border text-xs font-mono ${
                          Math.abs((item.valveRateMlS || 0) - r) < 0.05 ? 'border-accent bg-accent/15 font-bold text-accent' : 'border-theme bg-surface text-muted'
                        }" data-rate="${r}">${r === 0 ? (langCode === 'en' ? 'Closed' : 'Đóng') : `${r}`}</button>`
                      )
                      .join('')}
                  </div>
                  <button type="button" id="ins-bur-drop" class="py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-500">${t('buretteAddDrop')}</button>
                </div>
                <div class="flex flex-col gap-1.5 pt-1 border-t border-theme/50">
                  <span class="text-[11px] text-muted">${t('buretteFillTitle')}</span>
                  <div class="flex gap-1.5">
                    <select id="bur-fill-sel" class="flex-1 px-2 py-1 rounded border border-theme bg-surface text-xs">
                      ${liqReagents.map((r) => `<option value="${r.id}">${t(r.i18nKey)}</option>`).join('')}
                    </select>
                    <button type="button" id="ins-bur-fill" class="px-2.5 py-1 rounded bg-accent text-white text-xs font-semibold">+25 mL</button>
                  </div>
                </div>
                ${stands.length > 0 ? `<button type="button" id="ins-toggle-clamp" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${item.clampedToId ? t('actionUnclampStand') : t('actionClampStand')}</button>` : ''}`
          }
        </div>
      `;
    } else if (item.kind === 'splint') {
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_splint')} ${item.label}</div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
            </div>
          </div>
          <div class="text-xs text-muted">${t('splintModeLabel')}</div>
          <div class="grid grid-cols-3 gap-1.5">
            ${[
              ['burning', langCode === 'en' ? '🔥 Burning' : '🔥 Đang cháy'],
              ['glowing', langCode === 'en' ? '🔴 Glowing' : '🔴 Tàn hồng'],
              ['unlit', langCode === 'en' ? 'Unlit' : 'Chưa đốt'],
            ]
              .map(
                ([m, lbl]) => `<button type="button" class="splint-mode-btn py-1.5 rounded-lg border text-xs font-semibold ${
                  item.mode === m ? 'border-orange-500 bg-orange-500/20 text-orange-400' : 'border-theme bg-surface text-muted'
                }" data-mode="${m}">${lbl}</button>`
              )
              .join('')}
          </div>
        </div>
      `;
    } else if (item.kind === 'flame_loop') {
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_flame_loop')} ${item.label}</div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
            </div>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs font-mono flex justify-between">
            <span class="text-muted">${langCode === 'en' ? 'Adsorbed Ion:' : 'Ion hấp phụ:'}</span>
            <strong>${item.sampledIon || (langCode === 'en' ? 'Clean (NiCr)' : 'Sạch (NiCr)')}</strong>
          </div>
          <button type="button" id="ins-loop-wash" class="py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('actionWashLoop')}</button>
        </div>
      `;
    } else if (item.kind === 'indicator_strip') {
      const isLitmus = item.stripKind === 'litmus';
      const readStr = item.isBleached
        ? t('litmusBleached')
        : item.sampledPH == null
        ? (langCode === 'en' ? 'Untouched' : 'Chưa nhúng')
        : isLitmus
        ? `${item.sampledPH < 5.2 ? t('litmusRedAcid') : item.sampledPH > 8.2 ? t('litmusBlueBase') : t('litmusPurpleNeutral')} (${item.sampledFrom})`
        : `pH ≈ ${item.sampledPH.toFixed(1)} (${item.sampledFrom})`;
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t(isLitmus ? 'eq_litmus_paper' : 'eq_ph_strip')} ${item.label}</div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
            </div>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface flex items-center justify-between text-xs">
            <span class="text-muted">${langCode === 'en' ? 'Reading:' : 'Kết quả:'}</span>
            <span class="flex items-center gap-2 font-mono font-bold">
              <span class="inline-block w-4 h-4 rounded border border-theme" style="background:${item.tipColor}"></span>
              ${readStr}
            </span>
          </div>
          <button type="button" id="ins-strip-reset" class="py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('actionResetStrip')}</button>
        </div>
      `;
    } else if (item.kind === 'dc_power') {
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_dc_power')} ${item.label}</div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          <div class="p-3 rounded-lg border border-theme bg-slate-950 font-mono text-center">
            <div class="text-lg font-bold text-emerald-400" id="live-dc-readout">${(item.measuredV || 0).toFixed(2)} V · ${(item.measuredCurrentA || 0).toFixed(2)} A</div>
            <div class="text-[11px] text-amber-400" id="live-dc-j">${t('dcCurrentDensityLabel')}: ${(item.currentDensityADm2 || 0).toFixed(1)} A/dm²</div>
            <div class="text-[11px] text-sky-400 uppercase" id="live-dc-mode">${item.circuitMode || 'idle'}</div>
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="flex justify-between text-xs">
              <span class="text-muted">${t('dcVoltageLabel')}</span>
              <strong class="font-mono">${(item.voltageV ?? 6).toFixed(1)} V</strong>
            </div>
            <input id="dc-voltage-slider" type="range" min="0" max="12" step="0.5" value="${item.voltageV ?? 6}" class="w-full accent-blue-500" />
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="flex justify-between text-xs">
              <span class="text-muted">${t('dcRheostatLabel')}</span>
              <strong class="font-mono" id="live-dc-rheo">${(item.rheostatOhm ?? 2.0).toFixed(1)} Ω</strong>
            </div>
            <input id="dc-rheostat-slider" type="range" min="0.5" max="25" step="0.5" value="${item.rheostatOhm ?? 2.0}" class="w-full accent-amber-500" />
          </div>
          <div class="grid grid-cols-2 gap-1.5">
            <button type="button" id="ins-dc-toggle" class="py-2 rounded-lg text-xs font-bold text-white transition ${
              item.powerOn ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-sky-600 hover:bg-sky-500'
            }">${item.powerOn ? t('dcPowerOn') : t('dcPowerOff')}</button>
            <button type="button" id="ins-dc-swap" class="py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-semibold hover:bg-amber-500/20">${t('dcSwapPolarity')}</button>
          </div>
        </div>
      `;
    } else if (item.kind === 'volt_ammeter') {
      const dockedEls = this.sim.items.filter((i) => i.kind === 'electrode');
      const posEl = item.posElectrodeId ? this.sim.getItem(item.posElectrodeId) : null;
      const negEl = item.negElectrodeId ? this.sim.getItem(item.negElectrodeId) : null;
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_volt_ammeter')} ${item.label}</div>
              <div class="text-[11px] text-muted">${APPARATUS.volt_ammeter.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          <div class="p-3 rounded-lg border border-theme bg-slate-950 font-mono text-center">
            <div class="text-xl font-bold text-emerald-400" id="live-vm-readout">${(item.measuredV || 0).toFixed(3)} V · ${(item.measuredCurrentA || 0).toFixed(3)} A</div>
            <div class="text-[11px] text-sky-400 uppercase" id="live-vm-mode">${item.circuitMode || 'idle'}</div>
          </div>
          ${item.cathodicProtectedActive ? `<div class="p-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs font-semibold text-center">${t('dmmCathProtBadge')}</div>` : ''}
          <div class="text-xs text-muted">${t('dmmModeLabel')}</div>
          <div class="flex flex-col gap-1.5">
            ${['voltmeter', 'ammeter', 'short'].map((m) => `<button type="button" class="vm-mode-btn py-1.5 px-2.5 rounded-lg border text-xs font-semibold text-left ${item.mode === m ? 'border-accent bg-accent/15 text-accent' : 'border-theme bg-surface text-muted'}" data-mode="${m}">${t(m === 'voltmeter' ? 'dmmModeVolt' : m === 'ammeter' ? 'dmmModeAmp' : 'dmmModeShort')}</button>`).join('')}
          </div>
          ${dockedEls.length >= 2 ? `<div class="grid grid-cols-2 gap-1.5 text-xs pt-1 border-t border-theme/50">
            <div class="flex flex-col gap-1"><span class="text-red-400 font-semibold">+ Lead (Red)</span>
              <button type="button" id="ins-vm-pos-pick" class="px-2 py-1 rounded border border-red-500/40 bg-surface text-left font-mono hover:border-red-400 truncate" title="${t('btnPickOnBench')}">🎯 ${posEl ? `${posEl.label} (${posEl.material})` : t('btnPickOnBench')}</button>
            </div>
            <div class="flex flex-col gap-1"><span class="text-slate-400 font-semibold">− COM (Black)</span>
              <button type="button" id="ins-vm-neg-pick" class="px-2 py-1 rounded border border-theme bg-surface text-left font-mono hover:border-accent truncate" title="${t('btnPickOnBench')}">🎯 ${negEl ? `${negEl.label} (${negEl.material})` : t('btnPickOnBench')}</button>
            </div>
          </div>` : `<p class="text-[11px] text-muted">${t('dmmWiringHint')}</p>`}
        </div>
      `;
    } else if (item.kind === 'diffusion_tube') {
      const ringPct = item.ringPosFrac != null ? `${(item.ringPosFrac * 100).toFixed(1)} cm (${(item.ringPosFrac * 100).toFixed(1)}%)` : '—';
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_diffusion_tube')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
              <div class="text-[11px] text-muted">${APPARATUS.diffusion_tube.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs flex flex-col gap-1 font-mono" id="live-diff-stats">
            <div class="flex justify-between"><span>Left (0 cm):</span><strong>${item.leftGasId || 'Empty'} (${((item.leftFront || 0) * 100).toFixed(0)}%)</strong></div>
            <div class="flex justify-between"><span>Right (100 cm):</span><strong>${item.rightGasId || 'Empty'} (${((item.rightFront ?? 1) * 100).toFixed(0)}%)</strong></div>
            <div class="flex justify-between text-emerald-400"><span>${t('diffRingPosLabel')}</span><strong id="live-diff-ring">${ringPct}</strong></div>
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('alertToolBreak')}</p>`
              : `<div class="grid grid-cols-2 gap-1.5">
                  <button type="button" id="diff-left-nh3" class="py-1.5 px-2 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-400 text-xs font-semibold hover:opacity-90">${t('diffDropLeftNH3')}</button>
                  <button type="button" id="diff-right-hcl" class="py-1.5 px-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-semibold hover:opacity-90">${t('diffDropRightHCl')}</button>
                  <button type="button" id="diff-left-hcl" class="py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('diffDropLeftHCl')}</button>
                  <button type="button" id="diff-right-nh3" class="py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('diffDropRightNH3')}</button>
                </div>
                <button type="button" id="diff-clear" class="py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('diffClearTube')}</button>`
          }
          <p class="text-[11px] text-muted leading-relaxed">${t('diffHint')}</p>
        </div>
      `;
    } else if (item.kind === 'electrode') {
      const collectorTarget = item.gasTargetId ? this.sim.getItem(item.gasTargetId) : null;
      const mountedTube = this.sim.items.find((i) => i.mountedOverElectrodeId === item.id);
      const collectorCandidates = this.sim.items.filter(
        (i) => !i.isBroken && !i.isShattered && (i.kind === 'gas_syringe' || (i.kind === 'vessel' && i.id !== item.dockedVesselId))
      );
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_electrode_rod')} ${item.label}</div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          <div class="text-xs text-muted">${t('electrodeMatLabel')}</div>
          <div class="grid grid-cols-3 gap-1.5">
            ${Object.values(ELECTRODE_MATERIALS)
              .map(
                (m) => `<button type="button" class="el-mat-btn py-1.5 px-2 rounded-lg border text-xs font-semibold ${
                  item.material === m.id ? 'border-accent bg-accent/15 text-accent' : 'border-theme bg-surface text-muted hover:border-accent'
                }" data-mat="${m.id}">${m.id}</button>`
              )
              .join('')}
          </div>
          <div class="text-[11px] text-muted">${(ELECTRODE_MATERIALS[item.material]?.[langCode === 'en' ? 'nameEn' : 'nameVi']) || item.material}</div>
          ${item.polarityLabel ? `<div class="p-2 rounded border border-theme bg-surface text-xs font-mono text-center">${item.polarityLabel}</div>` : ''}
          ${item.platedMaterial === 'Cu' && (item.platedCuMol || 0) > 1e-7 ? `<div class="p-2 rounded border border-amber-500/40 bg-amber-500/10 text-xs flex items-center justify-between gap-2"><span>${t(item.platedQuality === 'burned' ? 'platedCuBurned' : 'platedCuSmooth')} (${((item.platedCuMol || 0) * 63.546 * 1000).toFixed(1)} mg)</span><button type="button" id="ins-el-strip" class="px-2 py-0.5 rounded border border-theme bg-surface text-[11px]">${t('actionClearElectrodes')}</button></div>` : ''}
          ${item.platedMaterial === 'Ag' && (item.platedAgMol || 0) > 1e-7 ? `<div class="p-2 rounded border border-slate-400/50 bg-slate-500/10 text-xs flex items-center justify-between gap-2"><span>${t('platedAgDendrite')} (${((item.platedAgMol || 0) * 107.87 * 1000).toFixed(1)} mg)</span><button type="button" id="ins-el-strip" class="px-2 py-0.5 rounded border border-theme bg-surface text-[11px]">${t('actionClearElectrodes')}</button></div>` : ''}
          ${item.cathodicProtectedActive ? `<div class="p-2 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs font-semibold text-center">${t('dmmCathProtBadge')}</div>` : ''}
          ${item.dockedVesselId ? `
            <div class="pt-2 border-t border-theme/50 flex flex-col gap-1.5 text-xs">
              <div class="text-muted font-medium">${t('elCollectorLabel')} ${
                collectorTarget
                  ? `<span class="text-emerald-400 font-semibold">${t(APPARATUS[collectorTarget.typeId]?.i18nKey || 'eq_gas_syringe')} ${collectorTarget.label}</span>`
                  : mountedTube
                  ? `<span class="text-sky-400 font-semibold">${t(APPARATUS[mountedTube.typeId]?.i18nKey || 'eq_test_tube_50')} ${mountedTube.label}</span>`
                  : '—'
              }</div>
              <div class="grid grid-cols-2 gap-1.5">
                <button type="button" id="ins-el-mount-tube" class="py-1.5 px-2 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-400 font-semibold text-xs hover:bg-sky-500/20">${t('elCollectMountTube')}</button>
                <button type="button" id="ins-el-pick-collector" ${collectorCandidates.length === 0 ? 'disabled' : ''} class="py-1.5 px-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 font-semibold text-xs hover:bg-emerald-500/20 disabled:opacity-40">${t('elCollectPickTarget')}</button>
              </div>
              ${item.gasTargetId || mountedTube ? `<button type="button" id="ins-el-clear-collector" class="py-1 px-2 rounded border border-red-500/40 bg-red-500/10 text-red-400 text-xs">${t('elCollectDetach')}</button>` : ''}
            </div>
          ` : ''}
        </div>
      `;
    } else if (item.kind === 'stir_bar') {
      const spc = APPARATUS.stir_bar;
      const hostV = item.inVesselId ? this.sim.getItem(item.inVesselId) : null;
      const openVessels = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isStoppered);
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t(spc.i18nKey)} ${item.label}</div>
              <div class="text-[11px] text-muted">${spc.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          ${
            hostV
              ? `<div class="p-2.5 rounded-lg border border-theme bg-surface flex flex-col gap-2 text-xs">
                  <div class="flex justify-between">
                    <span class="text-muted">${t('targetVessel')}</span>
                    <strong class="font-mono">${t(APPARATUS[hostV.typeId].i18nKey)} ${hostV.label}</strong>
                  </div>
                  <span class="text-muted">${t('magStirLabel')}</span>
                  <div class="grid grid-cols-4 gap-1.5">
                    ${[0, 400, 800, 1200]
                      .map(
                        (rpm) => `<button type="button" class="sb-rpm-btn py-1 rounded border text-[11px] font-mono ${
                          (hostV.magStirRpm || 0) === rpm ? 'border-accent bg-accent/15 font-bold text-accent' : 'border-theme bg-surface-alt text-muted'
                        }" data-rpm="${rpm}">${rpm === 0 ? 'OFF' : `${rpm}`}</button>`
                      )
                      .join('')}
                  </div>
                  <button type="button" id="ins-sb-remove" class="py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-medium hover:border-accent">${t('stirBarRemove')}</button>
                </div>`
              : `<div class="flex flex-col gap-2 text-xs">
                  <p class="text-muted leading-snug">${t('stirBarHint')}</p>
                  ${
                    openVessels.length > 0
                      ? `<button type="button" id="ins-sb-pick-insert" class="w-full py-1.5 px-2.5 rounded-lg bg-accent text-white text-xs font-semibold hover:opacity-90">${t('stirBarInsert')} · ${t('btnPickOnBench')}</button>`
                      : ''
                  }
                </div>`
          }
        </div>
      `;
    } else if (item.kind === 'salt_bridge') {
      const spc = APPARATUS.salt_bridge;
      const vA = item.vesselAId ? this.sim.getItem(item.vesselAId) : null;
      const vB = item.vesselBId ? this.sim.getItem(item.vesselBId) : null;
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t(spc.i18nKey)} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
              <div class="text-[11px] text-muted">${spc.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('alertToolBreak')}</p>`
              : `<div class="p-2.5 rounded-lg border border-theme bg-surface text-xs">
                  ${
                    vA && vB
                      ? `<div class="font-mono font-bold text-emerald-400">⚡ ${vA.label} ↔ ${vB.label}${(item.activeCurrentA || 0) > 1e-4 ? ` (${item.activeCurrentA.toFixed(2)} A)` : ''}</div>`
                      : `<p class="text-muted">${t('saltBridgeHint')}</p>`
                  }
                </div>`
          }
        </div>
      `;
    } else if (item.kind === 'tongs') {
      const tgSpec = APPARATUS.crucible_tongs;
      const gv = item.grippedVesselId ? this.sim.getItem(item.grippedVesselId) : null;
      const sample = item.heldSample && item.heldSample.moles > 1e-8 ? item.heldSample : null;
      const heldSummary = gv
        ? `${t(APPARATUS[gv.typeId]?.i18nKey || 'eq_crucible_porcelain')} ${gv.label}`
        : sample
        ? `${SPECIES[sample.speciesId]?.formula || sample.speciesId} (${(sample.moles * 1000).toFixed(2)} mmol · ${kelvinToCelsius(sample.tempK || 298.15).toFixed(0)}°C)`
        : t('tongsEmpty');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-bold">🥢 ${t('eq_crucible_tongs')} ${item.label}</div>
              <div class="text-[11px] text-muted">${tgSpec.materialSpec} · ${tgSpec.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs flex items-center justify-between gap-2">
            <span class="text-muted">${t('tongsHoldingLabel')}</span>
            <span class="font-mono font-semibold text-main">${heldSummary}</span>
          </div>
          <div class="flex flex-col gap-1.5">
            <button type="button" id="ins-tongs-sample" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent text-left">${t('tongsGripSampleBtn')}</button>
            ${
              sample
                ? `<button type="button" id="ins-tongs-drop-sample" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent text-left">${t('tongsDropSampleBtn')}</button>`
                : ''
            }
            <button type="button" id="ins-tongs-grip" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent text-left">${t('tongsGripCrucibleBtn')}</button>
            ${
              gv
                ? `<button type="button" id="ins-tongs-release-crucible" class="py-1.5 px-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-semibold hover:bg-amber-500/20 text-left">${t('tongsReleaseCrucibleBtn')}</button>`
                : ''
            }
            ${
              gv && sample
                ? `<button type="button" id="ins-tongs-release" class="py-1.5 px-2.5 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-xs font-semibold hover:bg-red-500/20 text-left">${t('tongsReleaseBtn')}</button>`
                : ''
            }
          </div>
          <p class="text-[11px] text-muted leading-relaxed">${t('tongsHint')}</p>
        </div>
      `;
    } else if (item.kind === 'spoon') {
      const spSpec = APPARATUS.iron_spoon;
      const entries = Object.entries(item.moles || {}).filter(([, n]) => n > 1e-10);
      const summary =
        entries.length > 0
          ? entries
              .map(([k, n]) => `${SPECIES[k]?.formula || k}: ${(n * (SPECIES[k]?.molarMass || 0)).toFixed(2)} g`)
              .join(' · ')
          : t('spoonEmpty');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🥄 ${t('eq_iron_spoon')} ${item.label}</div>
              <div class="text-[11px] text-muted">${spSpec.materialSpec} · ${spSpec.isoStandard}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs">
              <div class="text-muted">${t('metricTemp')}</div>
              <div class="font-mono font-bold text-sm mt-0.5" id="live-spoon-temp">${(item.tempK || 298.15).toFixed(1)} K (${kelvinToCelsius(item.tempK || 298.15).toFixed(1)}°C)</div>
            </div>
            <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs">
              <div class="text-muted">${t('spoonContentsLabel')}</div>
              <div class="font-mono font-semibold text-xs mt-0.5 truncate" id="live-spoon-contents">${summary}</div>
            </div>
          </div>
          <div class="flex flex-col gap-1.5">
            <button type="button" id="ins-spoon-scoop" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent text-left">${t('spoonScoopBtn')}</button>
            <button type="button" id="ins-spoon-pour" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent text-left">${t('spoonPourBtn')}</button>
            ${
              entries.length > 0
                ? `<button type="button" id="ins-spoon-rinse" class="py-1.5 px-2.5 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-xs font-semibold hover:bg-red-500/20 text-left">${t('spoonCleanBtn')}</button>`
                : ''
            }
          </div>
          <p class="text-[11px] text-muted leading-relaxed">${t('spoonHint')}</p>
        </div>
      `;
    } else if (item.kind === 'rubber_stopper') {
      const hostV = item.attachedToId ? this.sim.getItem(item.attachedToId) : null;
      const isHoled = (item.stopperMode || 'holed') !== 'solid';
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🔌 ${t('eq_rubber_stopper')} ${item.label}</div>
              <div class="text-[11px] text-muted">${APPARATUS.rubber_stopper.materialSpec}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs flex flex-col gap-1.5">
            <span class="text-muted">${t('stopperModeLabel')}</span>
            <div class="grid grid-cols-2 gap-1.5">
              <button type="button" id="ins-stopper-holed" class="py-1.5 px-2 rounded-lg border text-xs font-semibold ${
                isHoled ? 'border-amber-500 bg-amber-500/15 text-amber-400' : 'border-theme bg-surface-alt text-muted'
              }">${t('stopperModeHoled')}</button>
              <button type="button" id="ins-stopper-solid" class="py-1.5 px-2 rounded-lg border text-xs font-semibold ${
                !isHoled ? 'border-sky-500 bg-sky-500/15 text-sky-400' : 'border-theme bg-surface-alt text-muted'
              }">${t('stopperModeSolid')}</button>
            </div>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs flex items-center justify-between gap-2">
            <span class="text-muted">${
              hostV
                ? `${t('stopperStatusMounted')} <strong>${hostV.label}</strong>${item.attachedSide && item.attachedSide !== 'main' ? ` (${item.attachedSide})` : ''}`
                : t('stopperStatusLoose')
            }</span>
            ${
              hostV
                ? `<button type="button" id="ins-stopper-unplug" class="px-2.5 py-1 rounded-lg border border-amber-500/50 bg-amber-500/10 text-amber-400 font-semibold">${t('stopperUnplugBtn')}</button>`
                : `<button type="button" id="ins-stopper-attach" class="px-2.5 py-1 rounded-lg border border-theme bg-surface-alt font-medium hover:border-accent">${t('stopperAttachBtn')}</button>`
            }
          </div>
          <p class="text-[11px] text-muted leading-relaxed">${t('stopperHint')}</p>
        </div>
      `;
    } else if (item.kind === 'phen_cotton') {
      const hostV = item.attachedToId ? this.sim.getItem(item.attachedToId) : null;
      const pinkPct = Math.round(Math.max(0, Math.min(1, item.pinkLevel || 0)) * 100);
      const dampPct = Math.round(Math.max(20, Math.min(100, (item.dampness ?? 0.85) * 100)));
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🌸 ${t('eq_phen_cotton')} ${item.label}</div>
              <div class="text-[11px] text-muted">${APPARATUS.phen_cotton.materialSpec}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs flex flex-col gap-2">
            <div class="flex justify-between items-center">
              <span class="text-muted">${t('cottonPinknessLabel')}</span>
              <strong id="live-cotton-pink" class="font-mono ${pinkPct > 25 ? 'text-pink-400' : 'text-main'}">${pinkPct}%</strong>
            </div>
            <label class="flex flex-col gap-1">
              <span class="flex justify-between text-muted"><span>${t('cottonDampnessLabel')}</span><strong class="font-mono">${dampPct}%</strong></span>
              <input type="range" id="ins-cotton-damp" min="20" max="100" step="5" value="${dampPct}" class="w-full accent-pink-500" />
            </label>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" id="ins-cotton-reset" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('cottonResetBtn')}</button>
            ${
              hostV
                ? `<button type="button" id="ins-cotton-detach" class="px-2.5 py-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 text-amber-400 text-xs font-semibold">${t('cottonDetachBtn')}</button>`
                : `<button type="button" id="ins-cotton-attach" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('cottonAttachBtn')}</button>`
            }
          </div>
          <p class="text-[11px] text-muted leading-relaxed">${t('cottonHint')}</p>
        </div>
      `;
    } else if (item.kind === 'vessel') {
      const spec = APPARATUS[item.typeId];
      const liqL = computeLiquidVolumeL(item.moles, item.tempK);
      const liqMl = liqL * 1000;
      const iceMl = ((item.moles.H2O_s || 0) * SPECIES.H2O_s.molarMass) / CONSTANTS.ICE_DENSITY_G_ML;
      const ph = item.isFrozenSolid ? null : computePH(item.moles, liqL, item.tempK);
      const contentsG = computeContentsMassG(item.moles);
      const grossG = spec.tareMassG + contentsG;
      const connTargetId = item.connectedTargetId || item.connectedSyringeId;
      const connTarget = connTargetId ? this.sim.getItem(connTargetId) : null;
      const baseStateLabel = item.isShattered
        ? t('stateShattered')
        : connTarget
        ? t('stateConnected')
        : item.isStoppered
        ? t('stateClosed')
        : t('stateOpen');
      const stateLabel = item.isFrozenSolid && !item.isShattered ? `${baseStateLabel} · ${t('stateFrozen')}` : baseStateLabel;
      const volDisplayStr =
        iceMl > 0.05 && liqMl <= 0.05
          ? `❄️ ${iceMl.toFixed(2)} / ${spec.maxVolumeMl} mL`
          : iceMl > 0.05
          ? `${liqMl.toFixed(1)} + ❄️${iceMl.toFixed(1)} / ${spec.maxVolumeMl} mL`
          : `${liqMl.toFixed(2)} / ${spec.maxVolumeMl} mL`;

      const activeSpecies = Object.entries(item.moles)
        .filter(([, n]) => n > 1e-10)
        .sort((a, b) => b[1] - a[1]);

      const syr = connTarget && connTarget.kind === 'gas_syringe' ? connTarget : null;
      const syrVol = syr ? computeSyringeTotalVolumeMl(syr, this.sim.environment) : 0;
      const syrCondInfo = syr ? getSyringeCondenseInfo(syr, this.sim.environment, t) : null;
      const tubeGeom = connTarget ? computeTubingGeometry(item, connTarget) : null;
      const tubeVolMl = connTarget ? computeLiquidVolumeL(item.tubeMoles || {}, item.tubeTempK || item.tempK) * 1000 : 0;
      const stands = this.sim.items.filter((i) => i.kind === 'stand');
      const popStr = spec.popOverpressureBar ? `+${spec.popOverpressureBar.toFixed(2)} / ` : '';
      const shatterStr = spec.shatterOverpressureBar ? `+${spec.shatterOverpressureBar.toFixed(2)} bar` : '0 bar';

      topSection = `
        <!-- Vessel Header & Actions -->
        <div class="p-3 rounded-xl border border-theme bg-surface-alt flex flex-col gap-2.5">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t(spec.i18nKey)} ${item.label}</div>
              ${spec.isoStandard ? `<div class="text-[11px] text-muted">${spec.materialSpec} · ${spec.isoStandard}</div>` : ''}
              <div class="text-xs text-muted" id="live-state-label">${stateLabel}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          ${item.isSupersaturated && !item.isShattered ? `<div class="p-2 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-400 text-xs"><div class="font-semibold">${t('badgeSupersaturated')} (S=${(item.supersatRatio || 1).toFixed(2)}×)</div><div class="text-[11px] opacity-85">${t('supersatHint')}</div></div>` : ''}
          ${(item.znPassivationFrac || 0) > 0.35 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-medium">${t('badgeZnPassivated')} (${Math.round((item.znPassivationFrac || 0) * 100)}%)</div>` : ''}
          ${(item.pickeringFoamMl || 0) > 0.5 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-pink-500/40 bg-pink-500/10 text-pink-400 text-xs font-medium">${t('badgePickeringFoam')}: +${(item.pickeringFoamMl || 0).toFixed(1)} mL</div>` : ''}
          ${(item.langmuirCoverage || 0) > 0.55 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs font-medium">${t('badgeLangmuirSat')} (θ=${Math.round((item.langmuirCoverage || 0) * 100)}%, n≈${(item.langmuirOrder ?? 0).toFixed(2)})</div>` : ''}
          ${(item.naTarnishFrac || 0) > 0.25 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-slate-500/40 bg-slate-500/10 text-muted text-xs font-medium">${t('badgeAirTarnished')}</div>` : ''}
          ${(item.naohDeliquesceFrac || 0) > 0.15 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-400 text-xs font-medium">${t('badgeNaohDeliquesced')}</div>` : ''}
          ${(item.caCo3FilmFrac || 0) > 0.25 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-slate-400/40 bg-slate-500/10 text-main text-xs font-medium">${t('badgeCaCo3Film')}</div>` : ''}
          ${item.fePassivated && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-medium">${t('badgeFePassivated')}</div>` : ''}
          ${(item.znCombustionTimer || 0) > 0.05 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-amber-400/60 bg-amber-400/15 text-amber-300 text-xs font-semibold">${t('badgeZnBurnO2')}</div>` : ''}
          ${(item.softenGlowFrac || 0) > 0.1 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-red-500/50 bg-red-500/15 text-red-300 text-xs font-semibold">${t('borosilicateSoftenWarn')}</div>` : ''}
          ${(() => {
            const cao = !item.isShattered ? computeCaOOptimizationScore(item) : null;
            if (!cao) return '';
            const row = (ok, key) =>
              `<div class="flex items-start gap-1.5 text-[11px] ${ok ? 'text-emerald-400' : 'text-muted'}"><span>${ok ? '✅' : '⬜'}</span><span>${t(key)}</span></div>`;
            return `
              <div class="p-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 flex flex-col gap-1.5">
                <div class="flex items-center justify-between gap-2 text-xs font-bold">
                  <span>${t('caoRubricTitle')}</span>
                  <span class="font-mono text-amber-300"><span id="live-cao-yield">${cao.yieldPct.toFixed(0)}</span>% · ${cao.points}/${cao.maxPoints}</span>
                </div>
                ${row(cao.groundFine, 'caoCriterionGround')}
                ${row(cao.ventedWhileHeating, 'caoCriterionVented')}
                ${row(cao.roaringBlueZone, 'caoCriterionBlueFlame')}
                ${row(cao.cooledProtected, 'caoCriterionProtected')}
              </div>`;
          })()}
          ${
            ((item.headspaceGasMoles?.H2_g || 0) > 1e-5 || (item.moles.CuO_s || 0) > 1e-7) && !item.isShattered
              ? this.sim.environment?.atmosphereMode === 'inert' || (item.airO2PurgeFrac ?? 1) <= 0.14
                ? `<div class="p-1.5 px-2.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs font-medium">${t('badgePurgedH2')}</div>`
                : `<div class="p-1.5 px-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-medium">${t('badgeUnpurgedAir')}</div>`
              : ''
          }

          ${
            item.isShattered
              ? item.clampedToId
                ? `<div class="flex flex-wrap gap-1.5"><button type="button" id="ins-toggle-clamp" class="px-2.5 py-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 text-xs font-medium text-amber-300 hover:bg-amber-500/20">${t('actionUnclampStand')}</button></div>`
                : ''
              : `<div class="flex flex-wrap gap-1.5">
            <button type="button" id="ins-pour" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('actionPourTo')}</button>
            <button type="button" id="ins-stir" ${item.isFrozenSolid ? 'disabled' : ''} title="${t('actionStirTip')}" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent disabled:opacity-40">${t('actionStir')}</button>
            ${
              spec.hasLid
                ? `<button type="button" id="ins-crucible-lid" class="px-2.5 py-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 text-xs font-semibold hover:border-accent">${
                    t('crucibleLidLabel')
                  } ${
                    item.lidState === 'closed'
                      ? t('crucibleLidClosed')
                      : item.lidState === 'ajar'
                      ? t('crucibleLidAjar')
                      : t('crucibleLidOpen')
                  }</button>`
                : ''
            }
            <button type="button" id="ins-toggle-compare" class="px-2.5 py-1.5 rounded-lg border ${
              Array.isArray(this.sim.compareVesselIds) && this.sim.compareVesselIds.includes(item.id)
                ? 'border-sky-500 bg-sky-500/20 text-sky-400 font-semibold'
                : 'border-theme bg-surface'
            } text-xs font-medium hover:border-accent">${
              Array.isArray(this.sim.compareVesselIds) && this.sim.compareVesselIds.includes(item.id)
                ? t('actionCompareVesselRemove')
                : t('actionCompareVesselAdd')
            }</button>
            ${
              spec.stopperable
                ? `<button type="button" id="ins-tube" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${
                    connTarget ? t('actionDisconnectTube') : t('actionConnectSyringe')
                  }</button>`
                : ''
            }
            ${
              spec.invertible && !item.isStoppered
                ? `<button type="button" id="ins-invert" class="px-2.5 py-1.5 rounded-lg border ${
                    item.isInverted ? 'border-sky-500/60 bg-sky-500/15 text-sky-400' : 'border-theme bg-surface'
                  } text-xs font-medium hover:border-accent">${
                    item.isInverted ? t('actionUprightTube') : t('actionInvertTube')
                  }</button>`
                : ''
            }
            ${
              ((item.headspaceGasMoles?.NH3_g || 0) > 1e-6 || (item.headspaceGasMoles?.HCl_g || 0) > 1e-6) && connTarget && connTarget.kind === 'vessel'
                ? `<button type="button" id="ins-fountain-primer" class="px-2.5 py-1.5 rounded-lg bg-pink-600 text-white text-xs font-semibold hover:bg-pink-500">${t('actionTriggerFountain')}</button>`
                : ''
            }
            ${
              spec.isMortar
                ? `<button type="button" id="ins-grind" class="px-2.5 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-semibold hover:opacity-90">${t('actionGrindMortar')}</button>
                   <button type="button" id="ins-solid-xfer" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('actionTransferSolid')}</button>`
                : ''
            }
            ${
              stands.length > 0
                ? `<button type="button" id="ins-toggle-clamp" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${
                    item.clampedToId ? t('actionUnclampStand') : t('actionClampStand')
                  }</button>`
                : ''
            }
            <button type="button" id="ins-rinse" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium text-muted hover:text-main">${t('actionRinse')}</button>
          </div>
          ${
            item.hasStirBar
              ? `<div class="pt-2 border-t border-theme/50 flex flex-wrap items-center justify-between gap-1.5">
                  <span class="text-[11px] text-muted">${t('magStirLabel')}</span>
                  <div class="flex gap-1">
                    ${[0, 400, 800, 1200]
                      .map(
                        (rpm) => `<button type="button" class="mag-rpm-btn px-2 py-0.5 rounded border text-[11px] font-mono ${
                          (item.magStirRpm || 0) === rpm ? 'border-accent bg-accent/15 font-semibold text-accent' : 'border-theme bg-surface text-muted'
                        }" data-rpm="${rpm}">${rpm === 0 ? 'OFF' : `${rpm}`}</button>`
                      )
                      .join('')}
                  </div>
                </div>`
              : ''
          }
          <div class="text-[10px] font-mono text-muted">${t('pressureLimitNote')} ${popStr}${shatterStr}</div>`
          }
        </div>

        <!-- Telemetry Grid -->
        <div class="grid grid-cols-2 gap-2">
          <div class="p-2.5 rounded-lg border border-theme bg-surface-alt">
            <div class="text-xs text-muted">${t('metricPH')}</div>
            <div class="text-sm font-bold font-mono" id="live-ph">${item.isFrozenSolid ? '— ❄️' : ph === null ? '—' : ph.toFixed(2)}</div>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface-alt">
            <div class="text-xs text-muted">${t('metricTemp')}</div>
            <div class="text-sm font-bold font-mono" id="live-temp">${item.tempK.toFixed(1)} K (${kelvinToCelsius(item.tempK).toFixed(1)}°C)</div>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface-alt">
            <div class="text-xs text-muted">${t('metricVol')}</div>
            <div class="text-sm font-bold font-mono" id="live-vol">${volDisplayStr}</div>
            <div class="text-[11px] text-muted font-mono" id="live-brim">${t('brimLabel')}: ~${(
        spec.geometry ? spec.geometry.maxVolumeMl * 0.96 : spec.maxVolumeMl
      ).toFixed(0)} mL</div>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface-alt">
            <div class="text-xs text-muted">${t('metricMass')} / P</div>
            <div class="text-sm font-bold font-mono" id="live-mass">${contentsG.toFixed(2)} g · ${item.internalPressureBar.toFixed(2)} bar</div>
            <div class="text-[11px] text-muted font-mono" id="live-mass-gross">${t('grossMassNote')}: ${grossG.toFixed(2)} g (${t('tarePrefix')} ${spec.tareMassG.toFixed(0)}g)</div>
          </div>
        </div>

        ${
          tubeGeom
            ? `<div class="px-3 py-1.5 rounded-lg border border-sky-500/35 bg-sky-500/10 text-[11px] flex items-center justify-between gap-2">
                <span class="text-muted">${t('tubeStatsNote')} · ${connTarget.label}</span>
                <strong class="font-mono text-sky-400" id="live-tube-stats">${tubeGeom.arcLengthCm.toFixed(1)} cm · ${Math.min(tubeVolMl, tubeGeom.capacityMl).toFixed(2)}/${tubeGeom.capacityMl.toFixed(2)} mL</strong>
              </div>`
            : ''
        }
        ${
          syr
            ? `<div class="px-3 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs flex flex-col gap-0.5">
                <div class="flex justify-between gap-2">
                  <span>${t('gasCollectedNote')}</span>
                  <strong class="font-mono" id="live-collected-gas">${syrVol.toFixed(2)} mL · ${syrCondInfo.syrTempC.toFixed(1)}°C</strong>
                </div>
                <div class="text-[11px] text-sky-400 font-mono" id="live-collected-cond">${
                  syrCondInfo.totalFluidMl > 0.0005 || syrCondInfo.isCondensing
                    ? `${syrCondInfo.frozenMol > syrCondInfo.condensedMol ? '❄️' : '💧'} ${t(syrCondInfo.frozenMol > syrCondInfo.condensedMol ? 'syringeFrozenShort' : 'gasCondensedShort')}: ${syrCondInfo.totalFluidMl.toFixed(2)} mL ${syrCondInfo.condSpec}`
                    : ''
                }</div>
              </div>`
            : connTarget
            ? `<div class="px-3 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs flex justify-between gap-2">
                <span>${t('tubeHoldNote')}</span>
                <strong class="font-mono">${t(APPARATUS[connTarget.typeId].i18nKey)} ${connTarget.label}</strong>
              </div>`
            : `<div class="px-3 py-2 rounded-lg border border-theme bg-surface-alt text-xs flex flex-col gap-1">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-muted">${t('gasEscapedNote')}</span>
                  <span class="font-mono text-[11px] text-amber-400" id="live-escaped-gas-temp">${
                    item.lastGasOutTempK
                      ? `${t('gasOutTempTag')} ${kelvinToCelsius(item.lastGasOutTempK).toFixed(1)}°C`
                      : ''
                  }</span>
                </div>
                <div class="font-mono text-main flex flex-wrap gap-x-2 gap-y-0.5" id="live-escaped-gas">${formatGasSummaryHtml(item.escapedGasMoles, item.escapedFrostH2OMol || 0, t)}</div>
              </div>`
        }
        ${(() => {
          const headGases = Object.entries(item.headspaceGasMoles || {}).filter(([g, n]) => g !== 'H2O_g' && (n || 0) > 1e-6);
          if (headGases.length === 0) return '';
          const rows = headGases
            .map(([gId, n]) => {
              const sp = SPECIES[gId];
              const dAir = (sp?.relAirDensity ?? (sp?.molarMass ? sp.molarMass / 28.97 : 1.0)).toFixed(2);
              return `<span class="whitespace-nowrap">${sp?.formula || gId}: ${(n * 1000).toFixed(2)} mmol (d=${dAir})</span>`;
            })
            .join('<span class="text-muted px-1">·</span>');
          return `<div class="px-3 py-2 rounded-lg border border-sky-500/40 bg-sky-500/10 text-xs flex flex-col gap-1">
            <span class="text-sky-400 font-semibold">${t('collectedGasHeadspaceLabel')}</span>
            <div class="font-mono text-main flex flex-wrap gap-x-1" id="live-headspace-gas">${rows}</div>
          </div>`;
        })()}

        <!-- Species Breakdown Table -->
        <div class="rounded-xl border border-theme bg-surface-alt p-3">
          <h3 class="text-xs font-bold uppercase tracking-wider text-muted mb-2">${t('speciesTableTitle')}</h3>
          ${
            activeSpecies.length === 0
              ? `<p class="text-xs text-muted">${item.isShattered ? t('shatteredEmptyMsg') : t('emptyVesselMsg')}</p>`
              : `
              <div class="overflow-x-auto max-h-44 overflow-y-auto">
                <table class="w-full text-xs">
                  <thead>
                    <tr class="text-muted border-b border-theme text-left">
                      <th class="pb-1 font-medium">${t('colSpecies')}</th>
                      <th class="pb-1 font-medium text-right">${t('colMoles')}</th>
                      <th class="pb-1 font-medium text-right">${t('colMass')}</th>
                      <th class="pb-1 font-medium text-right">${t('colConc')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${activeSpecies
                      .map(([spId, n]) => {
                        const sp = SPECIES[spId];
                        const mass = n * sp.molarMass;
                        const isMolten = isSolidMoltenAtTemp(sp, item.tempK, item.moles);
                        const conc = isMolten
                          ? t('moltenStateTag')
                          : sp.phase === 'aq' && liqL > 1e-6
                          ? `${(n / liqL).toFixed(3)} M`
                          : sp.phase;
                        const thermalTitle =
                          sp.phase === 's'
                            ? [
                                sp.meltTempK && !sp.noMelt ? `T_nc: ${kelvinToCelsius(sp.meltTempK).toFixed(0)}°C` : null,
                                sp.boilTempK ? `T_s: ${kelvinToCelsius(sp.boilTempK).toFixed(0)}°C` : null,
                                sp.decompTempK ? `T_dec: ${kelvinToCelsius(sp.decompTempK).toFixed(0)}°C` : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')
                            : '';
                        const molStr = n >= 0.01 ? `${n.toFixed(4)}` : `${(n * 1000).toFixed(3)}m`;
                        return `
                          <tr class="border-b border-theme/50 last:border-0" title="${thermalTitle}">
                            <td class="py-1 font-semibold">${sp.formula}${isMolten ? ' 🔥' : ''}</td>
                            <td class="py-1 text-right font-mono" id="sp-mol-${spId}">${molStr}</td>
                            <td class="py-1 text-right font-mono" id="sp-mass-${spId}">${mass.toFixed(3)}g</td>
                            <td class="py-1 text-right font-mono ${isMolten ? 'text-orange-400 font-semibold' : 'text-muted'}" id="sp-conc-${spId}">${conc}</td>
                          </tr>
                        `;
                      })
                      .join('')}
                  </tbody>
                </table>
              </div>
              `
          }
        </div>

        <!-- Real-Time Moles vs Time Chart -->
        <div class="rounded-xl border border-theme bg-surface-alt p-3">
          <div class="flex items-center justify-between mb-1.5">
            <h3 class="text-xs font-bold uppercase tracking-wider text-muted">${t('liveChartTitle')}</h3>
          </div>
          <canvas id="vessel-mole-chart" width="320" height="115" class="w-full h-[115px] rounded-lg bg-surface border border-theme"></canvas>
          <div id="chart-legend" class="flex flex-wrap gap-2 mt-1.5 text-xs"></div>
        </div>

        <!-- Active Reactions -->
        <div class="rounded-xl border border-theme bg-surface-alt p-3">
          <h3 class="text-xs font-bold uppercase tracking-wider text-muted mb-1.5">${t('activeReactionsTitle')}</h3>
          <div id="active-rxn-box" class="space-y-1.5">
            ${
              item.activeReactions.length === 0
                ? `<p class="text-xs text-muted">${t('noActiveReaction')}</p>`
                : item.activeReactions
                    .map(
                      (r) => `
                  <div class="p-2 rounded-lg border border-theme bg-surface">
                    <div class="text-xs font-mono font-bold text-accent">${r.equation}</div>
                    <div class="flex justify-between text-xs text-muted mt-0.5">
                      <span>${langCode === 'vi' ? r.nameVi : r.nameEn}</span>
                      <span class="font-mono">${(r.rateMolS * 1000).toFixed(2)} mmol/s</span>
                    </div>
                  </div>
                `
                    )
                    .join('')
            }
          </div>
        </div>
      `;
    }

    // Reaction Log at bottom
    const logsHtml = `
      <div class="rounded-xl border border-theme bg-surface-alt p-3">
        <h3 class="text-xs font-bold uppercase tracking-wider text-muted mb-2">${t('reactionLogTitle')}</h3>
        <div class="space-y-1.5 max-h-48 overflow-y-auto pr-1">
          ${
            this.sim.logs.length === 0
              ? `<p class="text-xs text-muted">—</p>`
              : this.sim.logs
                  .map((log) => {
                    if (log.type === 'alert') {
                      return `<div class="p-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs">
                        <span class="font-mono text-muted">[${log.timeSec.toFixed(1)}s]</span> ⚠️ ${t(log.key)}
                      </div>`;
                    }
                    if (log.type === 'info') {
                      return `<div class="p-2 rounded-lg border border-sky-500/40 bg-sky-500/10 text-xs leading-relaxed">
                        ${t(log.key)}
                      </div>`;
                    }
                    return `<div class="p-2 rounded-lg border border-theme bg-surface text-xs">
                      <div class="flex items-center justify-between gap-1">
                        <span class="font-mono font-bold text-accent">${log.equation}</span>
                        <span class="font-mono text-muted">${log.vesselLabel} · ${log.timeSec.toFixed(1)}s</span>
                      </div>
                      <p class="text-muted mt-0.5">${langCode === 'vi' ? log.descVi : log.descEn}</p>
                    </div>`;
                  })
                  .join('')
          }
        </div>
      </div>
    `;

    const labsMeta = this.callbacks.getLabsMeta?.();
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

    this.container.innerHTML = `<div class="flex flex-col gap-3">${topSection}${crossLabHtml}${logsHtml}</div>`;
    this.bindInspectorEvents(item, t);
  }

  bindInspectorEvents(item, t) {
    if (!item) return;

    this.container.querySelector('#ins-move-lab-btn')?.addEventListener('click', () => {
      const sel = this.container.querySelector('#ins-move-lab-select');
      const targetIdx = sel ? Number(sel.value) : -1;
      if (targetIdx >= 0) {
        this.callbacks.onMoveToLab?.(item.id, targetIdx);
      }
    });

    this.container.querySelector('#ins-delete')?.addEventListener('click', () => {
      soundEngine.playTrashCrumple();
      this.sim.removeApparatus(item.id);
    });
    this.container.querySelector('#ins-flip-x')?.addEventListener('click', () => {
      soundEngine.playGlassClink(item.typeId, 0.65);
      this.sim.toggleItemFlipX(item.id);
    });

    if (item.kind === 'scale') {
      this.container.querySelector('#ins-tare')?.addEventListener('click', () => {
        soundEngine.playTareBeep();
        this.sim.tareScale(item.id);
      });
      this.container.querySelector('#ins-clear-tare')?.addEventListener('click', () => {
        soundEngine.playTareBeep();
        this.sim.clearTare(item.id);
      });
    } else if (item.kind === 'burner') {
      this.container.querySelector('#ins-bunsen-air-toggle')?.addEventListener('click', () => {
        soundEngine.playFlameWhoosh(!item.airHoleOpen);
        this.sim.toggleBurnerAirHole(item.id);
      });
      this.container.querySelector('#burner-power-slider')?.addEventListener('input', (e) => {
        this.sim.setBurnerPower(item.id, Number(e.target.value));
      });
      this.container.querySelectorAll('.flame-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const fl = Number(btn.dataset.flame);
          if (fl > 0) soundEngine.playFlameWhoosh(item.typeId === 'bunsen_burner' && item.airHoleOpen !== false);
          else soundEngine.playUiClick();
          this.sim.setBurnerFlame(item.id, fl);
        });
      });
    } else if (item.kind === 'pipette') {
      this.container.querySelectorAll('.pip-dose-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.sim.setPipetteDropDose(item.id, Number(btn.dataset.dose)));
      });
      this.container.querySelector('#ins-clear-pipette')?.addEventListener('click', () => this.sim.clearPipette(item.id));
    } else if (item.kind === 'stand') {
      this.container.querySelector('#stand-extend-slider')?.addEventListener('input', (e) => {
        this.sim.setStandExtension(item.id, Number(e.target.value));
      });
      this.container.querySelectorAll('.stand-detach-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          soundEngine.playClampClick();
          this.sim.detachFromStand(btn.dataset.cid);
        });
      });
    } else if (item.kind === 'gas_syringe') {
      this.container.querySelector('#ins-vent-syringe')?.addEventListener('click', () => this.sim.ventSyringe(item.id));
      const holdBtn = this.container.querySelector('#ins-syringe-hold-push');
      if (holdBtn) {
        holdBtn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.sim.setSyringeDischarge(item.id, true);
        });
        const stopPush = () => this.sim.setSyringeDischarge(item.id, false);
        holdBtn.addEventListener('pointerup', stopPush);
        holdBtn.addEventListener('pointerleave', stopPush);
        holdBtn.addEventListener('pointercancel', stopPush);
      }
      this.container.querySelector('#ins-syringe-pump')?.addEventListener('click', () => {
        const vessels = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered);
        if (vessels.length === 0) {
          this.callbacks.onNotify?.(t('alertTransferNeedSecond'));
          return;
        }
        this.callbacks.onOpenSyringeTransfer?.(item.id);
      });
      this.container.querySelector('#ins-toggle-clamp')?.addEventListener('click', () => {
        if (item.clampedToId) {
          this.sim.detachFromStand(item.id);
        } else {
          const st = this.sim.items.find((i) => i.kind === 'stand');
          if (st) {
            item.x = getStandGeometry(st).clampTargetX(item.kind);
            item.y = Math.min(item.y, 330);
            this.sim.attachToStand(item.id, st.id);
          }
        }
      });
    } else if (item.kind === 'vessel') {
      this.container.querySelector('#ins-pour')?.addEventListener('click', () => {
        const vessels = this.sim.items.filter((i) => !i.isShattered && !i.isBroken && (i.kind === 'vessel' || i.kind === 'filter_funnel' || i.kind === 'burette'));
        if (vessels.length < 2) {
          this.callbacks.onNotify?.(t('alertTransferNeedSecond'));
          return;
        }
        this.callbacks.onOpenTransfer?.(item.id);
      });
      this.container.querySelector('#ins-stir')?.addEventListener('click', () => {
        soundEngine.playStirSwirl();
        this.sim.stirVessel(item.id);
      });
      this.container.querySelector('#ins-rinse')?.addEventListener('click', () => {
        soundEngine.playWaterRinse();
        this.sim.rinseVessel(item.id);
      });
      this.container.querySelector('#ins-crucible-lid')?.addEventListener('click', () => {
        soundEngine.playGlassClink(item.typeId, 0.7);
        this.sim.cycleCrucibleLid(item.id);
      });
      this.container.querySelector('#ins-toggle-compare')?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.sim.toggleCompareVessel(item.id);
        this.callbacks.onOpenCompare?.();
      });
      this.container.querySelector('#ins-invert')?.addEventListener('click', () => {
        soundEngine.playGlassClink(item.typeId, 0.75);
        this.sim.toggleVesselInverted(item.id);
      });
      this.container.querySelector('#ins-fountain-primer')?.addEventListener('click', () => {
        soundEngine.playDropPlink(0.9, 1.2);
        this.sim.injectFountainPrimer(item.id);
      });
      this.container.querySelector('#ins-grind')?.addEventListener('click', () => {
        soundEngine.playMortarGrind();
        this.sim.grindMortar(item.id);
      });
      this.container.querySelector('#ins-solid-xfer')?.addEventListener('click', () => this.callbacks.onOpenSolidTransfer?.(item.id));
      this.container.querySelectorAll('.mag-rpm-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          soundEngine.playUiClick();
          this.sim.toggleMagneticStir(item.id, Number(btn.dataset.rpm));
        });
      });
      this.container.querySelector('#ins-toggle-clamp')?.addEventListener('click', () => {
        soundEngine.playClampClick();
        if (item.clampedToId) {
          this.sim.detachFromStand(item.id);
        } else {
          const st = this.sim.items.find((i) => i.kind === 'stand');
          if (st) {
            item.x = getStandGeometry(st).clampTargetX(item.kind);
            item.y = Math.min(item.y, 340);
            this.sim.attachToStand(item.id, st.id);
          }
        }
      });
      this.container.querySelector('#ins-tube')?.addEventListener('click', () => {
        if (item.connectedTargetId || item.connectedSyringeId) {
          soundEngine.playTubeSnap(false);
          this.sim.disconnectSyringe(item.id);
        } else {
          const targets = this.sim.getTubeTargetsForVessel(item.id);
          if (targets.length === 0) {
            this.callbacks.onNotify?.(t('alertConnectNeedSyringe'));
          } else if (targets.length === 1) {
            soundEngine.playTubeSnap(true);
            this.sim.connectTube(item.id, targets[0].id);
          } else {
            this.callbacks.onOpenTubeTarget?.(item.id);
          }
        }
      });
    } else if (item.kind === 'filter_funnel' || item.kind === 'condenser' || item.kind === 'burette') {
      this.container.querySelector('#ins-toggle-clamp')?.addEventListener('click', () => {
        if (item.clampedToId) {
          this.sim.detachFromStand(item.id);
        } else {
          const st = this.sim.items.find((i) => i.kind === 'stand');
          if (st) {
            item.x = getStandGeometry(st).clampTargetX(item.kind);
            item.y = Math.min(item.y, 320);
            this.sim.attachToStand(item.id, st.id);
          }
        }
      });
      this.container.querySelector('#ins-solid-xfer')?.addEventListener('click', () => this.callbacks.onOpenSolidTransfer?.(item.id));
      this.container.querySelector('#ins-funnel-mask')?.addEventListener('click', () => this.sim.toggleFunnelUvMask(item.id));
      this.container.querySelector('#ins-cond-water')?.addEventListener('click', () => {
        item.waterFlowOn = !item.waterFlowOn;
        this.sim.emitChange();
      });
      this.container.querySelector('#ins-cond-in-pick')?.addEventListener('click', () => {
        const srcs = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && APPARATUS[i.typeId]?.stopperable);
        if (srcs.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: srcs.map((s) => s.id),
          promptText: `${t('condInletLabel')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.connectTube(picked.id, item.id),
        });
      });
      this.container.querySelector('#ins-cond-in-dis')?.addEventListener('click', () => {
        if (item.connectedFromId) this.sim.disconnectSyringe(item.connectedFromId);
      });
      this.container.querySelector('#ins-cond-out-pick')?.addEventListener('click', () => {
        const dsts = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isStoppered && i.id !== item.connectedFromId);
        if (dsts.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: dsts.map((d) => d.id),
          promptText: `${t('condOutletLabel')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.connectCondenserOutlet(item.id, picked.id),
        });
      });
      this.container.querySelector('#ins-cond-out-dis')?.addEventListener('click', () => {
        this.sim.connectCondenserOutlet(item.id, null);
      });
      this.container.querySelectorAll('.bur-rate-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.sim.setBuretteValveRate(item.id, Number(btn.dataset.rate)));
      });
      this.container.querySelector('#ins-bur-drop')?.addEventListener('click', () => this.sim.buretteDispenseDrop(item.id, 0.05));
      this.container.querySelector('#ins-bur-fill')?.addEventListener('click', () => {
        const regId = this.container.querySelector('#bur-fill-sel')?.value;
        if (regId) {
          this.sim.addReagentToVessel(item.id, regId, 25, { silentAnim: true });
          this.sim.emitChange();
        }
      });
    } else if (item.kind === 'wash_bottle') {
      this.container.querySelector('#ins-wb-squirt')?.addEventListener('click', () => this.sim.washBottleSquirt(item.id, null, 5.0));
      this.container.querySelector('#ins-wb-spray-toggle')?.addEventListener('click', () => this.sim.toggleWashBottleSpray(item.id));
      this.container.querySelector('#ins-wb-refill')?.addEventListener('click', () => {
        item.waterMl = 250;
        this.sim.recomputeScaleReadings();
        this.sim.emitChange();
      });
    } else if (item.kind === 'splint') {
      this.container.querySelectorAll('.splint-mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          item.mode = btn.dataset.mode;
          this.sim.emitChange();
        });
      });
    } else if (item.kind === 'flame_loop') {
      this.container.querySelector('#ins-loop-wash')?.addEventListener('click', () => {
        item.sampledIon = null;
        item.sampledColor = null;
        item.sampleLabel = '';
        this.sim.emitChange();
      });
    } else if (item.kind === 'indicator_strip') {
      this.container.querySelector('#ins-strip-reset')?.addEventListener('click', () => {
        item.sampledPH = null;
        item.isBleached = false;
        item.sampledFrom = '';
        item.tipColor = item.stripKind === 'universal' ? '#eab308' : '#8b5cf6';
        this.sim.emitChange();
      });
    } else if (item.kind === 'dc_power') {
      this.container.querySelector('#dc-voltage-slider')?.addEventListener('input', (e) => {
        this.sim.setDcPowerState(item.id, { voltageV: Number(e.target.value) });
      });
      this.container.querySelector('#dc-rheostat-slider')?.addEventListener('input', (e) => {
        this.sim.setDcPowerState(item.id, { rheostatOhm: Number(e.target.value) });
      });
      this.container.querySelector('#ins-dc-toggle')?.addEventListener('click', () => {
        this.sim.setDcPowerState(item.id, { powerOn: !item.powerOn });
      });
      this.container.querySelector('#ins-dc-swap')?.addEventListener('click', () => {
        this.sim.swapDcPolarity(item.id);
      });
    } else if (item.kind === 'volt_ammeter') {
      this.container.querySelectorAll('.vm-mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.sim.setVoltAmmeterState(item.id, { mode: btn.dataset.mode }));
      });
      this.container.querySelector('#ins-vm-pos-pick')?.addEventListener('click', () => {
        const els = this.sim.items.filter((i) => i.kind === 'electrode' && i.id !== item.negElectrodeId);
        if (els.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: els.map((e) => e.id),
          promptText: `+ Lead (Red) — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.setVoltAmmeterState(item.id, { posElectrodeId: picked.id }),
        });
      });
      this.container.querySelector('#ins-vm-neg-pick')?.addEventListener('click', () => {
        const els = this.sim.items.filter((i) => i.kind === 'electrode' && i.id !== item.posElectrodeId);
        if (els.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: els.map((e) => e.id),
          promptText: `− COM (Black) — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.setVoltAmmeterState(item.id, { negElectrodeId: picked.id }),
        });
      });
    } else if (item.kind === 'diffusion_tube') {
      this.container.querySelector('#diff-left-nh3')?.addEventListener('click', () => this.sim.dropDiffusionReagent(item.id, 'left', 'NH3_g'));
      this.container.querySelector('#diff-left-hcl')?.addEventListener('click', () => this.sim.dropDiffusionReagent(item.id, 'left', 'HCl_g'));
      this.container.querySelector('#diff-right-nh3')?.addEventListener('click', () => this.sim.dropDiffusionReagent(item.id, 'right', 'NH3_g'));
      this.container.querySelector('#diff-right-hcl')?.addEventListener('click', () => this.sim.dropDiffusionReagent(item.id, 'right', 'HCl_g'));
      this.container.querySelector('#diff-clear')?.addEventListener('click', () => this.sim.clearDiffusionTube(item.id));
    } else if (item.kind === 'electrode') {
      this.container.querySelectorAll('.el-mat-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.sim.setElectrodeMaterial(item.id, btn.dataset.mat));
      });
      this.container.querySelector('#ins-el-strip')?.addEventListener('click', () => this.sim.clearElectrodePlating(item.id));
      this.container.querySelector('#ins-el-mount-tube')?.addEventListener('click', () => {
        this.sim.mountCollectorTubeOverElectrode(item.id);
      });
      this.container.querySelector('#ins-el-pick-collector')?.addEventListener('click', () => {
        const cands = this.sim.items.filter(
          (i) => !i.isBroken && !i.isShattered && (i.kind === 'gas_syringe' || (i.kind === 'vessel' && i.id !== item.dockedVesselId))
        );
        if (cands.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: cands.map((c) => c.id),
          promptText: `${t('elCollectPickTarget')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.connectElectrodeCollector(item.id, picked.id),
        });
      });
      this.container.querySelector('#ins-el-clear-collector')?.addEventListener('click', () => {
        this.sim.connectElectrodeCollector(item.id, null);
        const mountedTube = this.sim.items.find((i) => i.mountedOverElectrodeId === item.id);
        if (mountedTube) {
          mountedTube.mountedOverElectrodeId = null;
          this.sim.emitChange();
        }
      });
    } else if (item.kind === 'stir_bar') {
      this.container.querySelectorAll('.sb-rpm-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (item.inVesselId) this.sim.toggleMagneticStir(item.inVesselId, Number(btn.dataset.rpm));
        });
      });
      this.container.querySelector('#ins-sb-pick-insert')?.addEventListener('click', () => {
        const vs = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isStoppered);
        if (vs.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: vs.map((v) => v.id),
          promptText: `${t('stirBarInsert')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.insertStirBarIntoVessel(item.id, picked.id, 800),
        });
      });
      this.container.querySelector('#ins-sb-remove')?.addEventListener('click', () => {
        this.sim.removeStirBarFromVessel(item.id);
      });
    } else if (item.kind === 'tongs') {
      this.container.querySelector('#ins-tongs-sample')?.addEventListener('click', () => {
        const candidates = this.sim.items.filter(
          (v) =>
            v.kind === 'vessel' &&
            !v.isShattered &&
            !v.isStoppered &&
            ((v.moles?.Zn_s || 0) > 1e-6 || (v.moles?.Na_s || 0) > 1e-6 || (v.moles?.Cu_s || 0) > 1e-6)
        );
        if (candidates.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: candidates.map((v) => v.id),
          promptText: `${t('tongsGripSampleBtn')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.tongsPickSampleFromVessel(item.id, picked.id),
        });
      });
      this.container.querySelector('#ins-tongs-drop-sample')?.addEventListener('click', () => {
        const candidates = this.sim.items.filter((v) => v.kind === 'vessel' && !v.isShattered && !v.isStoppered);
        if (candidates.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: candidates.map((v) => v.id),
          promptText: `${t('tongsDropSampleBtn')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.tongsDropSampleIntoVessel(item.id, picked.id),
        });
      });
      this.container.querySelector('#ins-tongs-grip')?.addEventListener('click', () => {
        const candidates = this.sim.items.filter(
          (v) => v.kind === 'vessel' && !v.isShattered && (v.typeId === 'crucible_porcelain' || v.typeId === 'porcelain_dish')
        );
        if (candidates.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: candidates.map((v) => v.id),
          promptText: `${t('tongsGripCrucibleBtn')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.tongsGripVessel(item.id, picked.id),
        });
      });
      this.container.querySelector('#ins-tongs-release-crucible')?.addEventListener('click', () => {
        this.sim.tongsReleaseCrucible(item.id);
      });
      this.container.querySelector('#ins-tongs-release')?.addEventListener('click', () => {
        this.sim.tongsReleaseAll(item.id);
      });
    } else if (item.kind === 'spoon') {
      this.container.querySelector('#ins-spoon-scoop')?.addEventListener('click', () => {
        const candidates = this.sim.items.filter(
          (v) =>
            v.kind === 'vessel' &&
            !v.isShattered &&
            !v.isStoppered &&
            Object.entries(v.moles || {}).some(([k, n]) => SPECIES[k]?.phase === 's' && n > 1e-8)
        );
        if (candidates.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: candidates.map((v) => v.id),
          promptText: `${t('spoonScoopBtn')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => {
            if (!this.sim.startSpoonAction(item.id, 'scoop', picked.id)) {
              this.sim.spoonScoopFromVessel(item.id, picked.id);
            }
          },
        });
      });
      this.container.querySelector('#ins-spoon-pour')?.addEventListener('click', () => {
        const candidates = this.sim.items.filter((v) => v.kind === 'vessel' && !v.isShattered && !v.isStoppered);
        if (candidates.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: candidates.map((v) => v.id),
          promptText: `${t('spoonPourBtn')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => {
            if (!this.sim.startSpoonAction(item.id, 'pour', picked.id)) {
              this.sim.spoonPourIntoVessel(item.id, picked.id);
            }
          },
        });
      });
      this.container.querySelector('#ins-spoon-rinse')?.addEventListener('click', () => {
        this.sim.rinseSpoon(item.id);
      });
    } else if (item.kind === 'rubber_stopper') {
      this.container.querySelector('#ins-stopper-holed')?.addEventListener('click', () => {
        this.sim.setStopperMode(item.id, 'holed');
      });
      this.container.querySelector('#ins-stopper-solid')?.addEventListener('click', () => {
        this.sim.setStopperMode(item.id, 'solid');
      });
      this.container.querySelector('#ins-stopper-unplug')?.addEventListener('click', () => {
        this.sim.detachRubberStopper(item.id);
      });
      this.container.querySelector('#ins-stopper-attach')?.addEventListener('click', () => {
        const candidates = this.sim.items.filter((v) => {
          if (v.kind !== 'vessel' || v.isShattered) return false;
          const vSpec = APPARATUS[v.typeId];
          if (!vSpec?.stopperable) return false;
          return vSpec.hasTwoEnds ? !v.leftStoppered || !v.rightStoppered : !v.isStoppered;
        });
        if (candidates.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: candidates.map((v) => v.id),
          promptText: `${t('stopperAttachBtn')} — ${t('pickBenchPrompt')}`,
          onPick: (picked, clickPt) => {
            const pSpec = APPARATUS[picked.typeId];
            let side = 'main';
            if (pSpec?.hasTwoEnds) {
              if (!picked.leftStoppered && picked.rightStoppered) side = 'left';
              else if (!picked.rightStoppered && picked.leftStoppered) side = 'right';
              else side = clickPt && clickPt.x < picked.x ? 'left' : 'right';
            }
            this.sim.attachRubberStopper(item.id, picked.id, side);
          },
        });
      });
    } else if (item.kind === 'phen_cotton') {
      this.container.querySelector('#ins-cotton-damp')?.addEventListener('input', (e) => {
        item.dampness = Math.max(0.2, Math.min(1.0, Number(e.target.value) / 100));
        this.sim.emitChange();
      });
      this.container.querySelector('#ins-cotton-reset')?.addEventListener('click', () => {
        item.pinkLevel = 0;
        item.dampness = 0.85;
        if (item.attachedToId) {
          const v = this.sim.getItem(item.attachedToId);
          if (v) {
            if (item.attachedSide === 'left') v.phenCottonLeftLevel = 0;
            else if (item.attachedSide === 'right') v.phenCottonRightLevel = 0;
            else v.phenCottonLevel = 0;
          }
        }
        this.sim.emitChange();
      });
      this.container.querySelector('#ins-cotton-detach')?.addEventListener('click', () => {
        this.sim.detachPhenCotton(item.id);
      });
      this.container.querySelector('#ins-cotton-attach')?.addEventListener('click', () => {
        const candidates = this.sim.items.filter((v) => {
          if (v.kind !== 'vessel' || v.isShattered) return false;
          const vSpec = APPARATUS[v.typeId];
          return vSpec?.hasTwoEnds ? !v.leftStoppered || !v.rightStoppered : !v.isStoppered;
        });
        if (candidates.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: candidates.map((v) => v.id),
          promptText: `${t('cottonAttachBtn')} — ${t('pickBenchPrompt')}`,
          onPick: (picked, clickPt) => {
            const pSpec = APPARATUS[picked.typeId];
            let side = 'main';
            if (pSpec?.hasTwoEnds) {
              if (!picked.leftStoppered && picked.rightStoppered) side = 'left';
              else if (!picked.rightStoppered && picked.leftStoppered) side = 'right';
              else side = clickPt && clickPt.x < picked.x ? 'left' : 'right';
            }
            this.sim.attachPhenCotton(item.id, picked.id, side);
          },
        });
      });
    }
  }

  updateLiveNumbers(t) {
    const item = this.sim.getItem(this.sim.selectedId);
    if (!item) return;

    if (item.kind === 'rubber_stopper') return;
    if (item.kind === 'phen_cotton') {
      const pEl = this.container.querySelector('#live-cotton-pink');
      if (pEl) pEl.textContent = `${Math.round(Math.max(0, Math.min(1, item.pinkLevel || 0)) * 100)}%`;
      return;
    }
    if (item.kind === 'dc_power') {
      const rEl = this.container.querySelector('#live-dc-readout');
      const mEl = this.container.querySelector('#live-dc-mode');
      const jEl = this.container.querySelector('#live-dc-j');
      const rheoEl = this.container.querySelector('#live-dc-rheo');
      if (rEl) rEl.textContent = `${(item.measuredV || 0).toFixed(2)} V · ${(item.measuredCurrentA || 0).toFixed(2)} A`;
      if (mEl) mEl.textContent = item.circuitMode || 'idle';
      if (jEl) jEl.textContent = `${t('dcCurrentDensityLabel')}: ${(item.currentDensityADm2 || 0).toFixed(1)} A/dm²`;
      if (rheoEl) rheoEl.textContent = `${(item.rheostatOhm ?? 2.0).toFixed(1)} Ω`;
      return;
    }
    if (item.kind === 'volt_ammeter') {
      const rEl = this.container.querySelector('#live-vm-readout');
      const mEl = this.container.querySelector('#live-vm-mode');
      if (rEl) rEl.textContent = `${(item.measuredV || 0).toFixed(3)} V · ${(item.measuredCurrentA || 0).toFixed(3)} A`;
      if (mEl) mEl.textContent = item.circuitMode || 'idle';
      return;
    }
    if (item.kind === 'diffusion_tube') {
      const statsEl = this.container.querySelector('#live-diff-stats');
      if (statsEl) {
        const ringPct = item.ringPosFrac != null ? `${(item.ringPosFrac * 100).toFixed(1)} cm (${(item.ringPosFrac * 100).toFixed(1)}%)` : '—';
        statsEl.innerHTML = `<div class="flex justify-between"><span>Left (0 cm):</span><strong>${item.leftGasId || 'Empty'} (${((item.leftFront || 0) * 100).toFixed(0)}%)</strong></div><div class="flex justify-between"><span>Right (100 cm):</span><strong>${item.rightGasId || 'Empty'} (${((item.rightFront ?? 1) * 100).toFixed(0)}%)</strong></div><div class="flex justify-between text-emerald-400"><span>${t('diffRingPosLabel')}</span><strong id="live-diff-ring">${ringPct}</strong></div>`;
      }
      return;
    }
    if (item.kind === 'burette') {
      const liqMl = computeLiquidVolumeL(item.moles, item.tempK) * 1000;
      const vEl = this.container.querySelector('#live-bur-vol');
      const dEl = this.container.querySelector('#live-bur-disp');
      if (vEl) vEl.textContent = `${liqMl.toFixed(2)} / 50.0 mL`;
      if (dEl) dEl.textContent = `${(item.dispensedMl || 0).toFixed(2)} mL`;
      return;
    }
    if (item.kind === 'wash_bottle') {
      const wEl = this.container.querySelector('#live-wb-vol');
      if (wEl) wEl.textContent = `${(item.waterMl || 0).toFixed(1)} / 250 mL`;
      return;
    }

    if (item.kind === 'spoon') {
      const tEl = this.container.querySelector('#live-spoon-temp');
      const cEl = this.container.querySelector('#live-spoon-contents');
      if (tEl) {
        tEl.textContent = `${(item.tempK || 298.15).toFixed(1)} K (${kelvinToCelsius(item.tempK || 298.15).toFixed(1)}°C)`;
      }
      if (cEl) {
        const entries = Object.entries(item.moles || {}).filter(([, n]) => n > 1e-10);
        cEl.textContent =
          entries.length > 0
            ? entries
                .map(([k, n]) => `${SPECIES[k]?.formula || k}: ${(n * (SPECIES[k]?.molarMass || 0)).toFixed(2)} g`)
                .join(' · ')
            : t('spoonEmpty');
      }
      return;
    }
    if (item.kind === 'condenser') {
      const cEl = this.container.querySelector('#live-cond-ml');
      if (cEl) cEl.textContent = `${(item.totalCondensedMl || 0).toFixed(2)} mL`;
      return;
    }

    if (item.kind === 'scale') {
      const el = this.container.querySelector('#live-scale-readout');
      if (el) el.textContent = `${(item.measuredG || 0).toFixed(2)} g`;
      return;
    }

    if (item.kind === 'burner') {
      const bSpec = APPARATUS[item.typeId] || APPARATUS.burner;
      const isBunsen = item.typeId === 'bunsen_burner';
      const airOpen = isBunsen ? item.airHoleOpen !== false : true;
      const tbl = isBunsen && !airOpen ? bSpec.yellowPowerLevelsW : bSpec.powerLevelsW;
      const powerW = Math.round(item.powerW ?? (tbl[item.flameLevel || 0] || 0));
      const pEl = this.container.querySelector('#live-burner-power');
      const sEl = this.container.querySelector('#burner-power-slider');
      if (pEl) pEl.textContent = `${powerW} W`;
      if (sEl && Number(sEl.value) !== powerW) sEl.value = String(powerW);
      this.container.querySelectorAll('.flame-btn').forEach((btn) => {
        const isMatch = powerW === Number(btn.dataset.w);
        btn.className = `flame-btn py-1.5 rounded-lg text-[11px] font-semibold border ${
          isMatch ? 'border-orange-500 bg-orange-500/20 text-orange-400' : 'border-theme bg-surface text-muted'
        }`;
      });
      return;
    }

    if (item.kind === 'pipette') {
      const vEl = this.container.querySelector('#live-pip-vol');
      const sEl = this.container.querySelector('#live-pip-src');
      if (vEl) vEl.textContent = `${(item.volumeMl || 0).toFixed(2)} / 10.00 mL`;
      if (sEl) sEl.textContent = item.sourceLabel || '—';
      return;
    }

    if (item.kind === 'wash_bottle') {
      const volEl = this.container.querySelector('#live-wb-vol');
      const catchEl = this.container.querySelector('#live-wb-catch');
      if (volEl) volEl.textContent = `${(item.waterMl || 0).toFixed(1)} / 250 mL`;
      if (catchEl) {
        const wbArc = computeWashBottleStreamArc(item, this.sim.items, 482, CONSTANTS.GRAVITY_PX_S2 || 1800);
        catchEl.textContent = wbArc?.hitTarget
          ? `🎯 ${t(APPARATUS[wbArc.hitTarget.typeId].i18nKey)} ${wbArc.hitTarget.label}`
          : t('syringeCatchMiss');
      }
      return;
    }

    if (item.kind === 'gas_syringe') {
      const volMl = computeSyringeTotalVolumeMl(item, this.sim.environment);
      const totalGasMol = sumAllGasMoles(item.gasMoles);
      const condInfo = getSyringeCondenseInfo(item, this.sim.environment, t);
      const syrSpec = APPARATUS.gas_syringe;
      const pBar = item.internalPressureBar ?? this.sim.environment.pressureBar;
      const overPBar = pBar - this.sim.environment.pressureBar;
      const arc = !item.isBroken
        ? computeSyringeDischargeArc(item, this.sim.items, 482, 1800)
        : null;
      const vEl = this.container.querySelector('#live-syr-vol');
      const mEl = this.container.querySelector('#live-syr-mol');
      const tEl = this.container.querySelector('#live-syr-temp');
      const cEl = this.container.querySelector('#live-syr-cond');
      const sEl = this.container.querySelector('#live-syr-cond-state');
      const bEl = this.container.querySelector('#live-syr-breakdown');
      const pEl = this.container.querySelector('#live-syr-press');
      const catchEl = this.container.querySelector('#live-syr-catch');
      if (vEl) vEl.textContent = `${volMl.toFixed(2)} mL`;
      if (mEl) mEl.textContent = `${(totalGasMol * 1000).toFixed(2)} mmol`;
      if (tEl) tEl.textContent = `${condInfo.syrTempK.toFixed(1)} K (${condInfo.syrTempC.toFixed(1)}°C)`;
      if (cEl) cEl.textContent = `${condInfo.totalFluidMl.toFixed(2)} mL`;
      if (sEl) sEl.textContent = condInfo.condenseState;
      if (bEl) bEl.innerHTML = formatGasSummaryHtml(item.gasMoles);
      if (pEl) {
        pEl.textContent = `${pBar.toFixed(2)} bar (ΔP ${overPBar >= 0 ? '+' : ''}${overPBar.toFixed(2)} / +${(syrSpec.shatterOverpressureBar || 1.05).toFixed(2)} bar)`;
      }
      if (catchEl && arc) {
        catchEl.textContent = arc.hitTargetVessel
          ? `🎯 ${t(APPARATUS[arc.hitTargetVessel.typeId].i18nKey)} ${arc.hitTargetVessel.label}`
          : t('syringeCatchMiss');
      }
      return;
    }

    if (item.kind !== 'vessel') return;

    const spec = APPARATUS[item.typeId];
    const liqL = computeLiquidVolumeL(item.moles, item.tempK);
    const liqMl = liqL * 1000;
    const iceMl = ((item.moles.H2O_s || 0) * SPECIES.H2O_s.molarMass) / CONSTANTS.ICE_DENSITY_G_ML;
    const ph = item.isFrozenSolid ? null : computePH(item.moles, liqL, item.tempK);
    const contentsG = computeContentsMassG(item.moles);
    const grossG = spec.tareMassG + contentsG;

    const phEl = this.container.querySelector('#live-ph');
    const caoYieldEl = this.container.querySelector('#live-cao-yield');
    if (caoYieldEl) {
      const cao = computeCaOOptimizationScore(item);
      if (cao) caoYieldEl.textContent = cao.yieldPct.toFixed(0);
    }
    const tempEl = this.container.querySelector('#live-temp');
    const volEl = this.container.querySelector('#live-vol');
    const massEl = this.container.querySelector('#live-mass');
    const massGrossEl = this.container.querySelector('#live-mass-gross');
    if (phEl) phEl.textContent = item.isFrozenSolid ? '— ❄️' : ph === null ? '—' : ph.toFixed(2);
    if (tempEl) tempEl.textContent = `${item.tempK.toFixed(1)} K (${kelvinToCelsius(item.tempK).toFixed(1)}°C)`;
    if (volEl) {
      volEl.textContent =
        iceMl > 0.05 && liqMl <= 0.05
          ? `❄️ ${iceMl.toFixed(2)} / ${spec.maxVolumeMl} mL`
          : iceMl > 0.05
          ? `${liqMl.toFixed(1)} + ❄️${iceMl.toFixed(1)} / ${spec.maxVolumeMl} mL`
          : `${liqMl.toFixed(2)} / ${spec.maxVolumeMl} mL`;
    }
    if (massEl) massEl.textContent = `${contentsG.toFixed(2)} g · ${item.internalPressureBar.toFixed(2)} bar`;
    if (massGrossEl) massGrossEl.textContent = `${t('grossMassNote')}: ${grossG.toFixed(2)} g (${t('tarePrefix')} ${spec.tareMassG.toFixed(0)}g)`;

    const escEl = this.container.querySelector('#live-escaped-gas');
    if (escEl) {
      escEl.innerHTML = formatGasSummaryHtml(item.escapedGasMoles, item.escapedFrostH2OMol || 0, t);
    }
    const escTempEl = this.container.querySelector('#live-escaped-gas-temp');
    if (escTempEl) {
      escTempEl.textContent = item.lastGasOutTempK
        ? `${t('gasOutTempTag')} ${kelvinToCelsius(item.lastGasOutTempK).toFixed(1)}°C`
        : '';
    }

    const tubeEl = this.container.querySelector('#live-tube-stats');
    const tid = item.connectedTargetId || item.connectedSyringeId;
    if (tubeEl && tid) {
      const target = this.sim.getItem(tid);
      if (target) {
        const g = computeTubingGeometry(item, target);
        const tMl = computeLiquidVolumeL(item.tubeMoles || {}, item.tubeTempK || item.tempK) * 1000;
        tubeEl.textContent = `${g.arcLengthCm.toFixed(1)} cm · ${Math.min(tMl, g.capacityMl).toFixed(2)}/${g.capacityMl.toFixed(2)} mL`;
      }
    }

    const colEl = this.container.querySelector('#live-collected-gas');
    const colCondEl = this.container.querySelector('#live-collected-cond');
    if (colEl && item.connectedSyringeId) {
      const syr = this.sim.getItem(item.connectedSyringeId);
      if (syr) {
        const syrCondInfo = getSyringeCondenseInfo(syr, this.sim.environment, t);
        colEl.textContent = `${computeSyringeTotalVolumeMl(syr, this.sim.environment).toFixed(2)} mL · ${syrCondInfo.syrTempC.toFixed(1)}°C`;
        if (colCondEl) {
          colCondEl.textContent =
            syrCondInfo.totalFluidMl > 0.0005 || syrCondInfo.isCondensing
              ? `${syrCondInfo.frozenMol > syrCondInfo.condensedMol ? '❄️' : '💧'} ${t(syrCondInfo.frozenMol > syrCondInfo.condensedMol ? 'syringeFrozenShort' : 'gasCondensedShort')}: ${syrCondInfo.totalFluidMl.toFixed(2)} mL ${syrCondInfo.condSpec}`
              : '';
        }
      }
    }

    for (const [spId, n] of Object.entries(item.moles)) {
      const sp = SPECIES[spId];
      if (!sp) continue;
      const molEl = this.container.querySelector(`#sp-mol-${spId}`);
      const mEl = this.container.querySelector(`#sp-mass-${spId}`);
      const cEl = this.container.querySelector(`#sp-conc-${spId}`);
      if (molEl) molEl.textContent = n >= 0.01 ? `${n.toFixed(4)}` : `${(n * 1000).toFixed(3)}m`;
      if (mEl) mEl.textContent = `${(n * sp.molarMass).toFixed(3)}g`;
      if (cEl) {
        const isMolten = isSolidMoltenAtTemp(sp, item.tempK, item.moles);
        cEl.textContent = isMolten
          ? t('moltenStateTag')
          : sp.phase === 'aq' && liqL > 1e-6
          ? `${(n / liqL).toFixed(3)} M`
          : sp.phase;
      }
    }
  }

  drawChart() {
    const canvas = this.container.querySelector('#vessel-mole-chart');
    const legendEl = this.container.querySelector('#chart-legend');
    const item = this.sim.getItem(this.sim.selectedId);
    if (!canvas || !item || item.kind !== 'vessel') return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const hist = item.history;
    if (!hist || hist.length < 2) {
      ctx.fillStyle = this.isDark ? '#64748b' : '#94a3b8';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('n(t)', w / 2, h / 2 + 4);
      if (legendEl) legendEl.innerHTML = '';
      return;
    }

    // Pick top reactive / non-water species present in history
    const totals = {};
    for (const pt of hist) {
      for (const [k, v] of Object.entries(pt.moles)) {
        if (k === 'H2O_l') continue;
        totals[k] = Math.max(totals[k] || 0, v);
      }
    }
    const keys = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k]) => k);

    if (keys.length === 0) {
      if (legendEl) legendEl.innerHTML = '';
      return;
    }

    const tMin = hist[0].t;
    const tMax = Math.max(tMin + 1, hist[hist.length - 1].t);
    let maxMol = 1e-5;
    for (const k of keys) maxMol = Math.max(maxMol, totals[k]);

    // Grid lines
    ctx.strokeStyle = this.isDark ? 'rgba(148,163,184,0.12)' : 'rgba(15,23,42,0.08)';
    ctx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      const gy = (h * g) / 4;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    const padX = 8;
    const padY = 10;
    keys.forEach((k, idx) => {
      const col = CHART_PALETTE[idx % CHART_PALETTE.length];
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      hist.forEach((pt, pIdx) => {
        const val = pt.moles[k] || 0;
        const px = padX + ((pt.t - tMin) / (tMax - tMin)) * (w - padX * 2);
        const py = h - padY - (val / maxMol) * (h - padY * 2);
        if (pIdx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    });

    if (legendEl) {
      const gasLabels = {
        H2_g_total: 'H₂↑',
        HCl_g_total: 'HCl↑',
        Cl2_g_total: 'Cl₂↑',
        NO2_g_total: 'NO₂↑',
        NO_g_total: 'NO↑',
        N2O_g_total: 'N₂O↑',
        N2_g_total: 'N₂↑',
      };
      legendEl.innerHTML = keys
        .map((k, idx) => {
          const label = gasLabels[k] || SPECIES[k]?.formula || k;
          const col = CHART_PALETTE[idx % CHART_PALETTE.length];
          return `<span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full inline-block" style="background:${col}"></span><span>${label}</span></span>`;
        })
        .join('');
    }
  }
}
