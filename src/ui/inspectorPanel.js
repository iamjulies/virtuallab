import { APPARATUS } from '../data/apparatus.js';
import { kelvinToCelsius } from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import {
  computeContentsMassG,
  computeLiquidVolumeL,
  computePH,
} from '../engine/equilibrium.js';
import {
  computeSyringeDischargeArc,
  computeSyringeGasVolumeMl,
  computeSyringeLiquidVolumeMl,
  computeSyringeTotalVolumeMl,
  computeTubingGeometry,
} from '../engine/gasNetwork.js';

const CHART_PALETTE = [
  '#38bdf8',
  '#f472b6',
  '#fbbf24',
  '#34d399',
  '#a78bfa',
  '#fb7185',
  '#f97316',
];

const GAS_DISPLAY_META = [
  { id: 'H2_g', label: 'H₂', always: true },
  { id: 'O2_g', label: 'O₂', always: true },
  { id: 'HCl_g', label: 'HCl', always: false },
  { id: 'Cl2_g', label: 'Cl₂', always: false },
  { id: 'HNO3_g', label: 'HNO₃', always: false },
  { id: 'H2O_g', label: 'H₂O(g)', always: false },
];

function sumAllGasMoles(gasMap = {}) {
  let tot = 0;
  for (const g of GAS_DISPLAY_META) tot += gasMap[g.id] || 0;
  return tot;
}

function formatGasSummaryHtml(gasMap = {}) {
  const parts = [];
  for (const g of GAS_DISPLAY_META) {
    const val = gasMap[g.id] || 0;
    if (g.always || val > 1e-6) {
      parts.push(`<span class="whitespace-nowrap">${g.label}: ${(val * 1000).toFixed(2)} mmol</span>`);
    }
  }
  return parts.join('<span class="text-muted px-1">·</span>');
}

function getSyringeCondenseInfo(syr, env, t) {
  const syrTempK = syr.tempK ?? env.tempK;
  const syrTempC = kelvinToCelsius(syrTempK);
  const condensedMol = syr.condensedWaterMol || 0;
  const condensedMl = (condensedMol * SPECIES.H2O_l.molarMass) / 0.997;
  const overflowMl = computeLiquidVolumeL(syr.overflowMoles || {}, syrTempK) * 1000;
  const totalLiqMl = condensedMl + overflowMl;
  const hasSteam = (syr.gasMoles?.H2O_g || 0) > 1e-6;
  const isCondensing = (syr.lastCondenseRateMolS || 0) > 1e-6;
  const condenseState =
    (syr.overflowOutRateMlS || 0) > 0.5
      ? `⚠️ ${t('alertSyringeOverflow')}`
      : isCondensing
      ? `💧 ${t('syringeCondenseActive')}`
      : overflowMl > 0.05
      ? `💧 ${t('syringeLiquidOverflowLabel')}: ${overflowMl.toFixed(2)} mL`
      : condensedMol > 1e-5
      ? `💧 ${t('syringeCondenseDone')}`
      : hasSteam
      ? `♨️ ${t('syringeHotSteam')}`
      : t('syringeDryGas');
  return { syrTempK, syrTempC, condensedMol, condensedMl, overflowMl, totalLiqMl, isCondensing, condenseState };
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

  getStructureSignature(t, langCode) {
    const item = this.sim.getItem(this.sim.selectedId);
    const logLen = this.sim.logs.length;
    const standCount = this.sim.items.filter((i) => i.kind === 'stand').length;
    if (!item) return `none|${langCode}|${logLen}`;

    if (item.kind === 'vessel') {
      const spKeys = Object.keys(item.moles)
        .filter((k) => item.moles[k] > 1e-10)
        .sort()
        .join(',');
      const rxnKeys = item.activeReactions.map((r) => r.id).join(',');
      return `v|${item.id}|${item.isStoppered}|${item.connectedTargetId || item.connectedSyringeId}|${item.isShattered}|${item.clampedToId}|${standCount}|${spKeys}|${rxnKeys}|${langCode}|${logLen}`;
    }
    if (item.kind === 'burner') {
      return `b|${item.id}|${langCode}|${logLen}`;
    }
    if (item.kind === 'pipette') {
      return `p|${item.id}|${item.isBroken}|${Math.round((item.dropDoseMl || 1) * 100)}|${langCode}|${logLen}`;
    }
    if (item.kind === 'scale') {
      return `s|${item.id}|${Math.abs(item.tareG) > 0.001}|${langCode}|${logLen}`;
    }
    if (item.kind === 'stand') {
      const children = this.sim.items.filter((i) => i.clampedToId === item.id).map((i) => i.id).join(',');
      return `st|${item.id}|${children}|${langCode}|${logLen}`;
    }
    if (item.kind === 'gas_syringe') {
      return `g|${item.id}|${item.connectedFromId}|${item.clampedToId}|${standCount}|${item.isBroken}|${langCode}|${logLen}`;
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
      const powerW = item.powerW ?? (APPARATUS.burner.powerLevelsW[item.flameLevel || 0] || 0);
      const levels = [
        { lvl: 0, label: t('burnerOff'), w: 0 },
        { lvl: 1, label: t('burnerLow'), w: 160 },
        { lvl: 2, label: t('burnerMed'), w: 360 },
        { lvl: 3, label: t('burnerHigh'), w: 650 },
      ];
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <span class="text-sm font-bold">🔥 ${t('eq_burner')} ${item.label}</span>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
          </div>
          <div class="flex items-center justify-between text-xs text-muted">
            <span>${t('burnerPower')}</span>
            <strong class="text-sm font-mono text-orange-400" id="live-burner-power">${Math.round(powerW)} W</strong>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-[11px] text-muted">${t('burnerSliderLabel')}</label>
            <input type="range" id="burner-power-slider" min="0" max="650" step="5" value="${Math.round(powerW)}" class="w-full accent-orange-500 cursor-pointer" />
            <div class="flex justify-between text-[10px] font-mono text-muted">
              <span>0 W</span><span>160 W</span><span>360 W</span><span>650 W</span>
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
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🗜️ ${t('standTitle')} ${item.label}</div>
              <div class="text-[11px] text-muted">${stSpec.materialSpec} · ${stSpec.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
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
            <button type="button" id="ins-delete" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10">${t('actionDelete')}</button>
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
              <div class="text-sm font-bold font-mono text-sky-400" id="live-syr-cond">${condInfo.totalLiqMl.toFixed(2)} mL</div>
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
              ? `<p class="text-xs text-red-400 font-medium">${t('shatteredEmptyMsg')}</p>`
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
    } else if (item.kind === 'vessel') {
      const spec = APPARATUS[item.typeId];
      const liqL = computeLiquidVolumeL(item.moles, item.tempK);
      const ph = computePH(item.moles, liqL, item.tempK);
      const contentsG = computeContentsMassG(item.moles);
      const grossG = spec.tareMassG + contentsG;
      const connTargetId = item.connectedTargetId || item.connectedSyringeId;
      const connTarget = connTargetId ? this.sim.getItem(connTargetId) : null;
      const stateLabel = item.isShattered
        ? t('stateShattered')
        : connTarget
        ? t('stateConnected')
        : item.isStoppered
        ? t('stateClosed')
        : t('stateOpen');

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

          ${
            item.isShattered
              ? ''
              : `<div class="flex flex-wrap gap-1.5">
            <button type="button" id="ins-pour" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('actionPourTo')}</button>
            <button type="button" id="ins-stir" title="${t('actionStirTip')}" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('actionStir')}</button>
            ${
              spec.stopperable
                ? `<button type="button" id="ins-stopper" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${
                    item.isStoppered ? t('actionUnstopper') : t('actionStopper')
                  }</button>`
                : ''
            }
            ${
              spec.stopperable
                ? `<button type="button" id="ins-tube" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${
                    connTarget ? t('actionDisconnectTube') : t('actionConnectSyringe')
                  }</button>`
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
          <div class="text-[10px] font-mono text-muted">${t('pressureLimitNote')} ${popStr}${shatterStr}</div>`
          }
        </div>

        <!-- Telemetry Grid -->
        <div class="grid grid-cols-2 gap-2">
          <div class="p-2.5 rounded-lg border border-theme bg-surface-alt">
            <div class="text-xs text-muted">${t('metricPH')}</div>
            <div class="text-sm font-bold font-mono" id="live-ph">${ph === null ? '—' : ph.toFixed(2)}</div>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface-alt">
            <div class="text-xs text-muted">${t('metricTemp')}</div>
            <div class="text-sm font-bold font-mono" id="live-temp">${item.tempK.toFixed(1)} K (${kelvinToCelsius(item.tempK).toFixed(1)}°C)</div>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface-alt">
            <div class="text-xs text-muted">${t('metricVol')}</div>
            <div class="text-sm font-bold font-mono" id="live-vol">${(liqL * 1000).toFixed(2)} / ${spec.maxVolumeMl} mL</div>
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
                  syrCondInfo.totalLiqMl > 0.0005 || syrCondInfo.isCondensing
                    ? `💧 ${t('gasCondensedShort')}: ${syrCondInfo.totalLiqMl.toFixed(2)} mL H₂O`
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
                <div class="font-mono text-main flex flex-wrap gap-x-2 gap-y-0.5" id="live-escaped-gas">${formatGasSummaryHtml(item.escapedGasMoles)}</div>
              </div>`
        }

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
                        const conc = sp.phase === 'aq' && liqL > 1e-6 ? `${(n / liqL).toFixed(3)} M` : sp.phase;
                        const molStr = n >= 0.01 ? `${n.toFixed(4)}` : `${(n * 1000).toFixed(3)}m`;
                        return `
                          <tr class="border-b border-theme/50 last:border-0">
                            <td class="py-1 font-semibold">${sp.formula}</td>
                            <td class="py-1 text-right font-mono" id="sp-mol-${spId}">${molStr}</td>
                            <td class="py-1 text-right font-mono" id="sp-mass-${spId}">${mass.toFixed(3)}g</td>
                            <td class="py-1 text-right font-mono text-muted" id="sp-conc-${spId}">${conc}</td>
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

    this.container.innerHTML = `<div class="flex flex-col gap-3">${topSection}${logsHtml}</div>`;
    this.bindInspectorEvents(item, t);
  }

  bindInspectorEvents(item, t) {
    if (!item) return;

    this.container.querySelector('#ins-delete')?.addEventListener('click', () => {
      this.sim.removeApparatus(item.id);
    });

    if (item.kind === 'scale') {
      this.container.querySelector('#ins-tare')?.addEventListener('click', () => this.sim.tareScale(item.id));
      this.container.querySelector('#ins-clear-tare')?.addEventListener('click', () => this.sim.clearTare(item.id));
    } else if (item.kind === 'burner') {
      this.container.querySelector('#burner-power-slider')?.addEventListener('input', (e) => {
        this.sim.setBurnerPower(item.id, Number(e.target.value));
      });
      this.container.querySelectorAll('.flame-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.sim.setBurnerFlame(item.id, Number(btn.dataset.flame)));
      });
    } else if (item.kind === 'pipette') {
      this.container.querySelectorAll('.pip-dose-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.sim.setPipetteDropDose(item.id, Number(btn.dataset.dose)));
      });
      this.container.querySelector('#ins-clear-pipette')?.addEventListener('click', () => this.sim.clearPipette(item.id));
    } else if (item.kind === 'stand') {
      this.container.querySelectorAll('.stand-detach-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.sim.detachFromStand(btn.dataset.cid));
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
            item.x = st.x - 45;
            item.y = Math.min(item.y, 330);
            this.sim.attachToStand(item.id, st.id);
          }
        }
      });
    } else if (item.kind === 'vessel') {
      this.container.querySelector('#ins-pour')?.addEventListener('click', () => {
        const vessels = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered);
        if (vessels.length < 2) {
          this.callbacks.onNotify?.(t('alertTransferNeedSecond'));
          return;
        }
        this.callbacks.onOpenTransfer?.(item.id);
      });
      this.container.querySelector('#ins-stir')?.addEventListener('click', () => this.sim.stirVessel(item.id));
      this.container.querySelector('#ins-rinse')?.addEventListener('click', () => this.sim.rinseVessel(item.id));
      this.container.querySelector('#ins-stopper')?.addEventListener('click', () => this.sim.toggleStopper(item.id));
      this.container.querySelector('#ins-toggle-clamp')?.addEventListener('click', () => {
        if (item.clampedToId) {
          this.sim.detachFromStand(item.id);
        } else {
          const st = this.sim.items.find((i) => i.kind === 'stand');
          if (st) {
            item.x = st.x - 28;
            item.y = Math.min(item.y, 340);
            this.sim.attachToStand(item.id, st.id);
          }
        }
      });
      this.container.querySelector('#ins-tube')?.addEventListener('click', () => {
        if (item.connectedTargetId || item.connectedSyringeId) {
          this.sim.disconnectSyringe(item.id);
        } else {
          const targets = this.sim.getTubeTargetsForVessel(item.id);
          if (targets.length === 0) {
            this.callbacks.onNotify?.(t('alertConnectNeedSyringe'));
          } else if (targets.length === 1) {
            this.sim.connectTube(item.id, targets[0].id);
          } else {
            this.callbacks.onOpenTubeTarget?.(item.id);
          }
        }
      });
    }
  }

  updateLiveNumbers(t) {
    const item = this.sim.getItem(this.sim.selectedId);
    if (!item) return;

    if (item.kind === 'scale') {
      const el = this.container.querySelector('#live-scale-readout');
      if (el) el.textContent = `${(item.measuredG || 0).toFixed(2)} g`;
      return;
    }

    if (item.kind === 'burner') {
      const powerW = Math.round(item.powerW ?? (APPARATUS.burner.powerLevelsW[item.flameLevel || 0] || 0));
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
      if (cEl) cEl.textContent = `${condInfo.totalLiqMl.toFixed(2)} mL`;
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
    const ph = computePH(item.moles, liqL, item.tempK);
    const contentsG = computeContentsMassG(item.moles);
    const grossG = spec.tareMassG + contentsG;

    const phEl = this.container.querySelector('#live-ph');
    const tempEl = this.container.querySelector('#live-temp');
    const volEl = this.container.querySelector('#live-vol');
    const massEl = this.container.querySelector('#live-mass');
    const massGrossEl = this.container.querySelector('#live-mass-gross');
    if (phEl) phEl.textContent = ph === null ? '—' : ph.toFixed(2);
    if (tempEl) tempEl.textContent = `${item.tempK.toFixed(1)} K (${kelvinToCelsius(item.tempK).toFixed(1)}°C)`;
    if (volEl) volEl.textContent = `${(liqL * 1000).toFixed(2)} / ${spec.maxVolumeMl} mL`;
    if (massEl) massEl.textContent = `${contentsG.toFixed(2)} g · ${item.internalPressureBar.toFixed(2)} bar`;
    if (massGrossEl) massGrossEl.textContent = `${t('grossMassNote')}: ${grossG.toFixed(2)} g (${t('tarePrefix')} ${spec.tareMassG.toFixed(0)}g)`;

    const escEl = this.container.querySelector('#live-escaped-gas');
    if (escEl) {
      escEl.innerHTML = formatGasSummaryHtml(item.escapedGasMoles);
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
            syrCondInfo.totalLiqMl > 0.0005 || syrCondInfo.isCondensing
              ? `💧 ${t('gasCondensedShort')}: ${syrCondInfo.totalLiqMl.toFixed(2)} mL H₂O`
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
      if (cEl) cEl.textContent = sp.phase === 'aq' && liqL > 1e-6 ? `${(n / liqL).toFixed(3)} M` : sp.phase;
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
