/**
 * Empty-Bench & Tool/Apparatus Inspector Renderers & Live Updaters (Refactor 81).
 */
import { APPARATUS, getStandGeometry } from '../../data/apparatus.js';
import { CONSTANTS, formatNumber, kelvinToCelsius } from '../../data/constants.js';
import { GAS_DISPLAY_META, isSolidMoltenAtTemp, SPECIES, STARTER_REAGENTS } from '../../data/species.js';
import {
  ELECTRODE_MATERIALS,
  SALT_BRIDGE_ELECTROLYTES,
  ensureElectrodeMetalMoles,
  ensureSaltBridgeMoles,
  computeVesselRedoxAndCellMetrics,
} from '../../engine/electrochemistry.js';
import {
  computeAtmospherePartialPressures,
  computeBenchTelemetry,
  computeContentsMassG,
  computeLiquidSpeciesTableData,
  computeLiquidVolumeL,
  computePH,
  computePhaseStratification,
  computeSolidVolumeMl,
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
import {
  renderFlipButtonHtml,
  renderActionGridHtml,
  buildSyringeGasCompositionHtml,
  sumAllGasMoles,
  formatGasSummaryHtml,
  hasDisplayableSpeciesAmount,
  buildContainerLiquidTableCardHtml,
  updateLiveLiquidContainerSection,
  getSyringeCondenseInfo,
  PIPETTE_QUICK_DOSES,
  SEP_QUICK_RATES,
  BURETTE_QUICK_RATES,
  renderPrecisionControlHtml,
  syncPrecisionControlLive,
  renderTlcSpotsListHtml,
} from './inspectorUtils.js';

export function renderToolOrEmptyBenchHtml(panel, item, t, langCode = panel.lastLangCode || 'vi') {
  let topSection = '';
    if (!item) {
      const bt = computeBenchTelemetry(panel.sim);
      const atm = computeAtmospherePartialPressures(panel.sim.environment);
      const labsMeta = panel.callbacks.getLabsMeta?.();
      const activeLab = labsMeta?.labs?.[labsMeta.activeIndex];
      const labBadge = activeLab?.customName || `${t('labTabPrefix')} ${activeLab?.number || 1}`;
      const roomTempK = panel.sim.environment?.tempK ?? CONSTANTS.T_STD_K;
      const roomTempC = kelvinToCelsius(roomTempK);
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3" id="bench-telemetry-panel">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold flex items-center gap-1.5">📊 ${t('benchTelemetryTitle')}</div>
              <div class="text-[11px] text-muted">${t('benchNoVesselsHint')}</div>
            </div>
            <span class="px-2 py-0.5 rounded-md border border-accent/40 bg-accent/15 text-accent text-[11px] font-bold shrink-0">${labBadge}</span>
          </div>

          <div class="p-2.5 rounded-lg border border-theme bg-surface flex flex-col gap-1">
            <div class="flex items-center justify-between text-xs">
              <span class="text-muted">${t('benchTotalMassLabel')}</span>
              <strong class="font-mono text-sm text-emerald-400" id="live-bench-mass">${formatNumber(bt.totalBenchMassG, 2)} g</strong>
            </div>
            <div class="grid grid-cols-3 gap-1 text-[10.5px] font-mono text-muted pt-1 border-t border-theme/40">
              <span title="${t('benchChemMassLabel')}">🧪 <strong class="text-main" id="live-bench-chem">${formatNumber(bt.totalChemMassG, 2)}g</strong></span>
              <span title="${t('benchTareMassLabel')}">⚖️ <strong class="text-main" id="live-bench-tare">${formatNumber(bt.totalTareMassG, 1)}g</strong></span>
              <span title="${t('benchEscapedGasMassLabel')}">💨 <strong class="text-sky-400" id="live-bench-escaped">${formatNumber(bt.totalEscapedGasMassG, 3)}g</strong></span>
            </div>
          </div>

          <div class="p-2.5 rounded-lg border border-theme bg-surface flex flex-col gap-1.5 text-xs">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-muted">${t('benchAtmTitle')}</span>
              <span class="font-mono text-[11px] font-bold text-sky-400" id="live-bench-atm-tp">${roomTempC.toFixed(1)}°C · ${atm.pTotalBar.toFixed(2)} bar</span>
            </div>
            <div class="grid grid-cols-2 gap-1.5 text-[11px] font-mono">
              <div class="px-2 py-1 rounded bg-surface-alt border border-theme/60 flex justify-between">
                <span class="text-muted">P(N₂)</span><strong id="live-bench-pn2">${atm.pN2Bar.toFixed(3)} bar</strong>
              </div>
              <div class="px-2 py-1 rounded bg-surface-alt border border-theme/60 flex justify-between">
                <span class="text-muted">P(O₂)</span><strong id="live-bench-po2">${atm.pO2Bar.toFixed(3)} bar</strong>
              </div>
              <div class="px-2 py-1 rounded bg-surface-alt border border-theme/60 flex justify-between">
                <span class="text-muted">P(CO₂)</span><strong id="live-bench-pco2">${(atm.pCO2Bar * 1000).toFixed(2)} mbar</strong>
              </div>
              <div class="px-2 py-1 rounded bg-surface-alt border border-theme/60 flex justify-between">
                <span class="text-muted">RH</span><strong class="text-sky-400" id="live-bench-rh">${atm.rhPct.toFixed(0)}%</strong>
              </div>
            </div>
          </div>

          <div class="p-2.5 rounded-lg border border-theme bg-surface flex flex-col gap-1.5 text-xs">
            <div class="font-semibold text-muted">${t('benchActivityTitle')}</div>
            <div class="grid grid-cols-2 gap-1.5 text-[11px]">
              <div class="px-2 py-1 rounded bg-surface-alt border border-theme/60 flex justify-between">
                <span class="text-muted">${t('benchActiveRxnsLabel')}</span>
                <strong class="font-mono text-accent" id="live-bench-rxns">${bt.activeReactionCount}</strong>
              </div>
              <div class="px-2 py-1 rounded bg-surface-alt border border-theme/60 flex justify-between">
                <span class="text-muted">${t('benchHeatingVesselsLabel')}</span>
                <strong class="font-mono text-amber-400" id="live-bench-heating">${bt.heatingVesselCount} / ${bt.boilingVesselCount}</strong>
              </div>
              <div class="px-2 py-1 rounded bg-surface-alt border border-theme/60 flex justify-between">
                <span class="text-muted">${t('benchOverpressureVesselsLabel')}</span>
                <strong class="font-mono ${bt.overpressureVesselCount > 0 ? 'text-red-400' : ''}" id="live-bench-overp">${bt.overpressureVesselCount}</strong>
              </div>
              <div class="px-2 py-1 rounded bg-surface-alt border border-theme/60 flex justify-between">
                <span class="text-muted">${t('benchVesselCountLabel')}</span>
                <strong class="font-mono" id="live-bench-counts">${bt.vesselCount} + ${bt.toolCount}</strong>
              </div>
            </div>
          </div>
        </div>
      `;
    } else if (item.kind === 'bath') {
      const steps = APPARATUS.ice_bath?.bathTempSteps || [-20, -10, 0, 10, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200];
      const bathC = item.bathTargetC ?? (item.bathMode === 'ice_salt' ? -10 : 0);
      const mediumKey =
        bathC <= -15
          ? 'bathMediumCryo'
          : bathC <= -5
            ? 'bathMediumIceSalt'
            : bathC <= 5
              ? 'bathMediumIce'
              : bathC <= 25
                ? 'bathMediumCoolWater'
                : bathC <= 65
                  ? 'bathMediumWarmWater'
                  : bathC <= 105
                    ? 'bathMediumHotWater'
                    : bathC <= 155
                      ? 'bathMediumSiliconeOil'
                      : 'bathMediumHighOil';
      const tempTextCls = bathC <= 0 ? 'text-sky-400' : bathC <= 50 ? 'text-emerald-400' : bathC <= 105 ? 'text-amber-400' : 'text-orange-400';
      const nestedVessels = panel.sim.items.filter((i) => i.kind === 'vessel' && i.submergedInBathId === item.id && !i.isShattered);
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${bathC > 25 ? '🔥' : '🧊'} ${t('eq_ice_bath')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
              <div class="text-[11px] text-muted">${APPARATUS.ice_bath?.materialSpec || ''}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('alertToolBreak')}</p>`
              : `<div class="p-2.5 rounded-lg border border-theme bg-surface flex items-center justify-between gap-2.5">
            <img src="./assets/baths/bath_${steps.reduce((b, v) => (Math.abs(v - bathC) < Math.abs(b - bathC) ? v : b), steps[0])}.svg" alt="${bathC}°C" class="w-16 h-9 object-contain shrink-0 rounded" />
            <div class="flex-1 min-w-0 text-right">
              <div class="text-[11px] text-muted truncate">${t(mediumKey)}</div>
              <strong class="font-mono text-sm ${tempTextCls}">${(bathC + 273.15).toFixed(1)} K (${bathC}°C)</strong>
            </div>
          </div>
          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-muted font-medium">${t('bathModeLabel')}</span>
            <div class="grid grid-cols-6 gap-1">
              ${steps
                .map((tc) => {
                  const isAct = tc === bathC;
                  const activeCls =
                    tc <= 0
                      ? 'border-sky-500 bg-sky-500/20 text-sky-300 font-bold'
                      : tc <= 40
                        ? 'border-teal-500 bg-teal-500/20 text-teal-300 font-bold'
                        : tc <= 100
                          ? 'border-amber-500 bg-amber-500/20 text-amber-300 font-bold'
                          : 'border-orange-500 bg-orange-500/20 text-orange-300 font-bold';
                  return `<button type="button" class="bath-step-btn py-1 px-0.5 rounded border text-[10.5px] font-mono ${
                    isAct ? activeCls : 'border-theme bg-surface text-muted hover:border-accent'
                  }" data-tempc="${tc}">${tc}°</button>`;
                })
                .join('')}
            </div>
          </div>
          <p class="text-[11px] text-muted leading-relaxed">${t('bathHint')}</p>
          ${
            nestedVessels.length > 0
              ? `<div class="text-xs text-sky-300 font-mono" id="live-bath-nested">📥 ${nestedVessels.map((v) => `${v.label} (${kelvinToCelsius(v.tempK).toFixed(1)}°C)`).join(', ')}</div>`
              : ''
          }`
          }
        </div>
      `;
    } else if (item.kind === 'scale') {
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <span class="text-sm font-bold">${t('eq_scale')} ${item.label}</span>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
      const isEn = langCode === 'en';
      const levels = [
        { lvl: 0, label: t('burnerOff'), w: powerTbl[0] ?? 0 },
        { lvl: 1, label: `${isEn ? 'Low' : 'Nhỏ'} (${powerTbl[1] ?? 160}W)`, w: powerTbl[1] ?? 160 },
        { lvl: 2, label: `${isEn ? 'Med' : 'Vừa'} (${powerTbl[2] ?? 360}W)`, w: powerTbl[2] ?? 360 },
        { lvl: 3, label: `${isEn ? 'High' : 'Mạnh'} (${powerTbl[3] ?? maxPowerW}W)`, w: powerTbl[3] ?? maxPowerW },
      ];
      const sliderRangeLbl = isEn
        ? `Continuous power (0–${maxPowerW} W):`
        : `Điều chỉnh công suất (0–${maxPowerW} W):`;
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-bold">🔥 ${t(bSpec.i18nKey || 'eq_burner')} ${item.label}</div>
              ${bSpec.isoStandard ? `<div class="text-[11px] text-muted">${bSpec.isoStandard}</div>` : ''}
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
            <strong class="text-sm font-mono ${isBunsen && airOpen ? 'text-sky-400' : 'text-orange-400'}" id="live-burner-power">${formatNumber(powerW, 0)} W</strong>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-[11px] text-muted">${sliderRangeLbl}</label>
            <input type="range" id="burner-power-slider" min="0" max="${maxPowerW}" step="5" value="${Math.round(powerW)}" class="w-full accent-orange-500 cursor-pointer" />
            <div class="flex justify-between text-[10px] font-mono text-muted">
              <span>${levels[0].w} W</span><span>${levels[1].w} W</span><span>${levels[2].w} W</span><span>${levels[3].w} W</span>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-1.5 pt-0.5">
            ${levels
              .map(
                (l) => `
              <button type="button" data-flame="${l.lvl}" data-w="${l.w}" class="flame-btn w-full py-1.5 px-2 rounded-lg text-[11px] font-semibold border flex items-center justify-center text-center ${
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
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🧪 ${t('eq_pipette_10')} ${item.label}</div>
              <div class="text-[11px] text-muted">${pipSpec.materialSpec} · ${pipSpec.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <div class="text-xs font-semibold text-muted">${t('pipetteVolumeLabel')}</div>
              <div class="text-sm font-bold font-mono text-accent mt-0.5" id="live-pip-vol">${pipVol.toFixed(2)} / 10.00 mL</div>
            </div>
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <div class="text-xs font-semibold text-muted">${t('pipetteSourceLabel')}</div>
              <div class="text-sm font-bold font-mono truncate mt-0.5" id="live-pip-src">${item.hideComposition ? (item.blindLabel || '?') : (item.sourceLabel || '—')}</div>
            </div>
          </div>
          ${renderPrecisionControlHtml({
            sliderId: 'ins-pip-dose-slider',
            readoutId: 'live-pip-dose',
            btnClass: 'pip-dose-btn',
            dataAttr: 'dose',
            labelText: t('pipetteDropDoseLabel'),
            valueText: `${dropDose.toFixed(2)} mL`,
            sliderValue: dropDose.toFixed(2),
            activeVal: dropDose,
            presets: PIPETTE_QUICK_DOSES,
            unitLabel: 'mL',
          })}
          <p class="text-[11px] text-muted leading-relaxed">${t('pipetteBenchHint')}</p>
          ${item.isBroken ? '' : buildContainerLiquidTableCardHtml(item, t, item.tempK ?? panel.sim.environment.tempK)}
          <button type="button" id="ins-clear-pipette" class="py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('pipetteClear')}</button>
        </div>
      `;
    } else if (item.kind === 'stand') {
      const stSpec = APPARATUS.retort_stand;
      const clampedItems = panel.sim.items.filter((i) => i.clampedToId === item.id);
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
              <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
      const volMl = computeSyringeTotalVolumeMl(item, panel.sim.environment);
      const totalGasMol = sumAllGasMoles(item.gasMoles);
      const condInfo = getSyringeCondenseInfo(item, panel.sim.environment, t);
      const stands = panel.sim.items.filter((i) => i.kind === 'stand');
      const arc = !item.isBroken
        ? computeSyringeDischargeArc(item, panel.sim.items, 482, 1800)
        : null;
      const catchLabel = arc?.hitTargetVessel
        ? `🎯 ${t(APPARATUS[arc.hitTargetVessel.typeId].i18nKey)} ${arc.hitTargetVessel.label}`
        : t('syringeCatchMiss');
      const pBar = item.internalPressureBar ?? panel.sim.environment.pressureBar;
      const overPBar = pBar - panel.sim.environment.pressureBar;

      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_gas_syringe')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
              <div class="text-[11px] text-muted">${syrSpec.materialSpec} · ${syrSpec.isoStandard}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
          <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs" id="live-syr-breakdown">
            ${buildSyringeGasCompositionHtml(item, syrSpec, panel.sim.environment, t, condInfo)}
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('shatteredEmptyMsg')}</p>${
                  item.clampedToId
                    ? renderActionGridHtml([
                        `<button type="button" id="ins-toggle-clamp" title="${t('actionUnclampStand')}" class="w-full py-1.5 px-2 rounded-lg border border-amber-500/50 bg-amber-500/10 text-xs font-medium text-amber-300 hover:bg-amber-500/20 flex items-center justify-center gap-1.5 text-center">${t('btnUnclampShort')}</button>`,
                      ])
                    : ''
                }`
              : `
            <div class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-[11px] flex items-center justify-between gap-2">
              <span class="text-muted">${t('syringeCatchHint')}</span>
              <span class="font-semibold truncate" id="live-syr-catch">${catchLabel}</span>
            </div>
            ${renderActionGridHtml([
              `<button type="button" id="ins-syringe-hold-push" class="w-full py-1.5 px-2 rounded-lg bg-sky-600 text-white text-xs font-semibold hover:bg-sky-500 select-none flex items-center justify-center gap-1.5 text-center">💨 ${t('syringeHoldPush')}</button>`,
              `<button type="button" id="ins-syringe-pump" class="w-full py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">💉 ${t('syringePumpTo')}</button>`,
              `<button type="button" id="ins-vent-syringe" class="w-full py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">${t('syringeReleaseGas')}</button>`,
              stands.length > 0
                ? `<button type="button" id="ins-toggle-clamp" title="${t(item.clampedToId ? 'actionUnclampStand' : 'actionClampStand')}" class="w-full py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">${t(item.clampedToId ? 'btnUnclampShort' : 'btnClampShort')}</button>`
                : '',
            ])}`
          }
        </div>
      `;
    } else if (item.kind === 'filter_funnel') {
      const fSpec = APPARATUS.filter_funnel;
      const stands = panel.sim.items.filter((i) => i.kind === 'stand');
      const solids = Object.entries(item.moles || {}).filter(([id, n]) => n > 1e-8 && SPECIES[id]?.phase === 's');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_filter_funnel')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
              <div class="text-[11px] text-muted">${fSpec.materialSpec} · ${fSpec.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
                ${renderActionGridHtml([
                  solids.length > 0
                    ? `<button type="button" id="ins-solid-xfer" title="${t('actionTransferSolid')}" class="w-full px-2 py-1.5 rounded-lg bg-accent text-white text-xs font-semibold hover:opacity-90 flex items-center justify-center gap-1.5 text-center">${t('btnSolidXferShort')}</button>`
                    : '',
                  ((item.moles?.AgCl_s || 0) > 1e-7 || (item.moles?.Ag_s || 0) > 1e-7)
                    ? `<button type="button" id="ins-funnel-mask" class="w-full px-2 py-1.5 rounded-lg border ${item.uvMaskHalf ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-theme bg-surface'} text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">${item.uvMaskHalf ? t('actionUvUnmask') : t('actionUvMaskHalf')}</button>`
                    : '',
                  stands.length > 0
                    ? `<button type="button" id="ins-toggle-clamp" title="${t(item.clampedToId ? 'actionUnclampStand' : 'actionClampStand')}" class="w-full px-2 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">${t(item.clampedToId ? 'btnUnclampShort' : 'btnClampShort')}</button>`
                    : '',
                ])}`
          }
        </div>
      `;
    } else if (item.kind === 'wash_bottle') {
      const wbArc = computeWashBottleStreamArc(item, panel.sim.items, 482, CONSTANTS.GRAVITY_PX_S2 || 1800);
      const wbCatchLabel = wbArc?.hitTarget
        ? `🎯 ${t(APPARATUS[wbArc.hitTarget.typeId].i18nKey)} ${wbArc.hitTarget.label}`
        : t('syringeCatchMiss');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_wash_bottle')} ${item.label}</div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
      const stands = panel.sim.items.filter((i) => i.kind === 'stand');
      const inletSrcs = panel.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && APPARATUS[i.typeId]?.stopperable);
      const outletDsts = panel.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && i.id !== item.connectedFromId);
      const curInlet = item.connectedFromId ? panel.sim.getItem(item.connectedFromId) : null;
      const curOutlet = item.outletTargetId ? panel.sim.getItem(item.outletTargetId) : null;
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_liebig_condenser')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
                  ${
                    curOutlet && curOutlet.kind === 'vessel' && !curOutlet.isInverted
                      ? `<label class="flex flex-col gap-1 pt-1">
                           <div class="flex justify-between text-[11px]">
                             <span class="text-muted">${t('tubeDepthLabel')}</span>
                             <strong class="font-mono text-sky-300" id="live-tube-depth-pct">${Math.round((item.tubeSubmersionRatio ?? 0.72) * 100)}%</strong>
                           </div>
                           <input type="range" id="ins-tube-depth-slider" min="0" max="100" step="2" value="${Math.round((item.tubeSubmersionRatio ?? 0.72) * 100)}" class="w-full accent-sky-500 cursor-pointer" />
                         </label>`
                      : ''
                  }
                  <p class="text-[11px] text-muted leading-snug">${t('condDragHint')}</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button type="button" id="ins-cond-water" class="flex-1 py-1.5 px-2.5 rounded-lg border ${item.waterFlowOn ? 'border-sky-500/40 bg-sky-500/15 text-sky-400' : 'border-theme bg-surface text-muted'} text-xs font-semibold">${t('actionToggleWaterFlow')} ${item.waterFlowOn ? (langCode === 'en' ? 'ON' : 'BẬT') : (langCode === 'en' ? 'OFF' : 'TẮT')}</button>
                  <button type="button" id="ins-cond-reflux" class="flex-1 py-1.5 px-2.5 rounded-lg border ${item.refluxMode ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-400' : 'border-theme bg-surface text-muted'} text-xs font-semibold">${item.refluxMode ? t('condRefluxActive') : t('condRefluxToggle')}</button>
                  ${stands.length > 0 ? `<button type="button" id="ins-toggle-clamp" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${item.clampedToId ? t('actionUnclampStand') : t('actionClampStand')}</button>` : ''}
                </div>
                <p class="text-[11px] text-muted leading-snug">${t('condRefluxHint')}</p>`
          }
        </div>
      `;
    } else if (item.kind === 'burette') {
      const liqMl = computeLiquidVolumeL(item.moles, item.tempK) * 1000;
      const stands = panel.sim.items.filter((i) => i.kind === 'stand');
      const liqReagents = STARTER_REAGENTS.filter((r) => r.kind === 'liquid');
      const currentRate = item.valveRateMlS || 0;
      const closedWord = langCode === 'en' ? 'Closed' : 'Đóng';
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_burette_50')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('alertToolBreak')}</p>`
              : `<div class="grid grid-cols-2 gap-2">
                  <div class="p-2.5 rounded-lg border border-theme bg-surface">
                    <div class="text-xs font-semibold text-muted">${t('metricLiquidVol')}</div>
                    <div class="text-sm font-bold font-mono mt-0.5" id="live-bur-vol">${liqMl.toFixed(2)} / 50.0 mL</div>
                  </div>
                  <div class="p-2.5 rounded-lg border border-theme bg-surface">
                    <div class="text-xs font-semibold text-muted">${langCode === 'en' ? 'Dispensed (ΔV)' : 'Đã nhỏ (ΔV)'}</div>
                    <div class="text-sm font-bold font-mono text-emerald-400 mt-0.5" id="live-bur-disp">${(item.dispensedMl || 0).toFixed(2)} mL</div>
                  </div>
                </div>
                <div class="flex flex-col gap-2">
                  ${renderPrecisionControlHtml({
                    sliderId: 'ins-bur-rate-slider',
                    readoutId: 'live-bur-rate',
                    btnClass: 'bur-rate-btn',
                    dataAttr: 'rate',
                    labelText: t('buretteValveLabel'),
                    valueText: currentRate <= 0.001 ? `0.00 mL/s (${closedWord})` : `${currentRate.toFixed(2)} mL/s`,
                    sliderValue: Math.max(0.05, currentRate || 0.05).toFixed(2),
                    activeVal: currentRate,
                    presets: BURETTE_QUICK_RATES,
                    closedLabel: closedWord,
                  })}
                  <button type="button" id="ins-bur-drop" class="py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-500">${t('buretteAddDrop')}</button>
                </div>
                <div class="flex flex-col gap-1.5 pt-1 border-t border-theme/50">
                  <span class="text-xs font-semibold text-muted">${t('buretteFillTitle')}</span>
                  <div class="flex gap-1.5">
                    <select id="bur-fill-sel" class="flex-1 px-2 py-1 rounded border border-theme bg-surface text-xs">
                      ${liqReagents.map((r) => `<option value="${r.id}">${t(r.i18nKey)}</option>`).join('')}
                    </select>
                    <button type="button" id="ins-bur-fill" class="px-2.5 py-1 rounded bg-accent text-white text-xs font-semibold">+25 mL</button>
                  </div>
                </div>
                ${buildContainerLiquidTableCardHtml(item, t, item.tempK ?? panel.sim.environment.tempK)}
                ${stands.length > 0 ? `<button type="button" id="ins-toggle-clamp" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${item.clampedToId ? t('actionUnclampStand') : t('actionClampStand')}</button>` : ''}
              `
          }
        </div>
      `;
    } else if (item.kind === 'separatory_funnel') {
      const sfSpec = APPARATUS.separatory_funnel;
      const stands = panel.sim.items.filter((i) => i.kind === 'stand');
      const vessels = panel.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isInverted);
      const mountedV = item.mountedOnVesselId ? panel.sim.getItem(item.mountedOnVesselId) : null;
      const liqReagents = STARTER_REAGENTS.filter((r) => r.kind === 'liquid');
      const solMl = computeSolidVolumeMl(item.moles);
      const strat = item.liquidStratification || computePhaseStratification(item.moles, item.tempK, sfSpec, solMl);
      const liqMl = strat?.totalLiqMl || 0;
      const isEmulsion = (item.emulsionTimer || 0) > 0.2 && (strat?.layers?.length || 0) >= 1;
      const rateMlS = Number.isFinite(item.valveRateMlS) ? item.valveRateMlS : (item.valveFlowFrac ?? 0.35) * 10.0;
      const layerLabel = (pk) =>
        pk === 'organic_heavy' ? t('sepLayerHeavy') : pk === 'organic_light' ? t('sepLayerLight') : t('sepLayerAq');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_separatory_funnel')} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
              <div class="text-[11px] text-muted">${sfSpec?.isoStandard || ''}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('alertToolBreak')}</p>`
              : `<div class="grid grid-cols-2 gap-2">
                  <div class="p-2.5 rounded-lg border border-theme bg-surface">
                    <div class="text-xs font-semibold text-muted">${t('metricLiquidVol')}</div>
                    <div class="text-sm font-bold font-mono mt-0.5" id="live-sep-vol">${liqMl.toFixed(2)} / 100.0 mL</div>
                  </div>
                  <div class="p-2.5 rounded-lg border border-theme bg-surface">
                    <div class="text-xs font-semibold text-muted">${langCode === 'en' ? 'Dispensed (ΔV)' : 'Đã xả / nhỏ (ΔV)'}</div>
                    <div class="text-sm font-bold font-mono text-emerald-400 mt-0.5" id="live-sep-disp">${(item.dispensedMl || 0).toFixed(2)} mL</div>
                  </div>
                </div>
                <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs flex flex-col gap-1">
                  <div class="text-xs font-semibold text-muted">${t('sepPhasesTitle')}</div>
                  ${
                    liqMl <= 0.02
                      ? `<div class="text-[11px] text-muted">—</div>`
                      : isEmulsion
                        ? `<div class="text-amber-400 font-medium animate-pulse">${t('sepEmulsionSettling')}</div>`
                        : [...(strat?.layers || [])]
                            .reverse()
                            .map(
                              (l) => `<div class="flex justify-between font-mono">
                                <span>${layerLabel(l.phaseKey)}</span>
                                <strong class="text-sky-400">${l.volMl.toFixed(2)} mL</strong>
                              </div>`
                            )
                            .join('')
                  }
                </div>
                <div class="grid grid-cols-2 gap-1.5">
                  <button type="button" id="ins-sep-stopper" class="py-1.5 px-2 rounded-lg border text-xs font-semibold ${
                    item.isStoppered !== false ? 'border-amber-500/40 bg-amber-500/15 text-amber-300' : 'border-theme bg-surface text-main'
                  }">${item.isStoppered !== false ? `🔒 ${t('sepStopperClosed')}` : `🔓 ${t('sepStopperOpen')}`}</button>
                  <button type="button" id="ins-sep-valve" class="py-1.5 px-2 rounded-lg border text-xs font-semibold ${
                    item.valveOpen ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-theme bg-surface text-muted'
                  }">${item.valveOpen ? t('sepValveOpen') : t('sepValveClosed')}</button>
                </div>
                ${renderPrecisionControlHtml({
                  sliderId: 'ins-sep-flow-slider',
                  readoutId: 'live-sep-rate',
                  btnClass: 'sep-rate-btn',
                  dataAttr: 'rate',
                  labelText: t('sepFlowRateLabel'),
                  valueText: `${rateMlS.toFixed(2)} mL/s`,
                  sliderValue: rateMlS.toFixed(2),
                  activeVal: rateMlS,
                  presets: SEP_QUICK_RATES,
                })}
                <label class="flex items-center gap-2 text-xs text-muted cursor-pointer select-none">
                  <input type="checkbox" id="ins-sep-auto-stop" ${item.stopAtInterface !== false ? 'checked' : ''} class="accent-sky-500" />
                  <span>${t('sepAutoInterface')}</span>
                </label>
                <button type="button" id="ins-sep-shake" ${liqMl <= 0.05 ? 'disabled' : ''} class="py-1.5 px-2.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-500 disabled:opacity-40">${t('sepShakeBtn')}</button>
                <div class="flex flex-col gap-1 pt-1 border-t border-theme/50 text-xs">
                  <span class="text-xs font-semibold text-muted">${t('sepMountLabel')}</span>
                  <div class="flex items-center gap-1.5">
                    <div class="flex-1 px-2 py-1 rounded border border-theme bg-surface truncate">
                      ${mountedV ? `${t(APPARATUS[mountedV.typeId].i18nKey)} ${mountedV.label}` : '—'}
                    </div>
                    <button type="button" id="ins-sep-mount-pick" ${vessels.length === 0 ? 'disabled' : ''} class="px-2 py-1 rounded bg-amber-600 text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">${t('sepMountPick')}</button>
                    ${mountedV ? `<button type="button" id="ins-sep-unmount" class="px-2 py-1 rounded border border-red-500/40 bg-red-500/10 text-red-400 text-xs">${t('sepMountUnmount')}</button>` : ''}
                  </div>
                </div>
                <div class="flex flex-col gap-1.5 pt-1 border-t border-theme/50">
                  <span class="text-xs font-semibold text-muted">${t('sepFillTitle')}</span>
                  <div class="flex gap-1.5">
                    <select id="sep-fill-sel" class="flex-1 px-2 py-1 rounded border border-theme bg-surface text-xs">
                      ${liqReagents.map((r) => `<option value="${r.id}">${t(r.i18nKey)}</option>`).join('')}
                    </select>
                    <button type="button" id="ins-sep-fill" class="px-2.5 py-1 rounded bg-accent text-white text-xs font-semibold">+25 mL</button>
                  </div>
                </div>
                ${buildContainerLiquidTableCardHtml(item, t, item.tempK ?? panel.sim.environment.tempK)}
                ${stands.length > 0 ? `<button type="button" id="ins-toggle-clamp" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${item.clampedToId ? t('actionUnclampStand') : t('actionClampStand')}</button>` : ''}
                <p class="text-[11px] text-muted leading-snug">${t('sepDropHint')}</p>`
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
              <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
              <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
              <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
    } else if (item.kind === 'ph_conductometer') {
      const phTxt = item.measuredPH != null ? item.measuredPH.toFixed(2) : '—';
      const ecTxt = item.measuredConductivity != null ? `${item.measuredConductivity.toFixed(2)} mS/cm` : '—';
      const stands = panel.sim.items.filter((i) => i.kind === 'stand');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_ph_conductometer')} ${item.label}</div>
              <div class="text-[11px] text-muted">${APPARATUS.ph_conductometer.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          <div class="grid grid-cols-2 gap-2 p-2.5 rounded-lg border border-theme bg-slate-950 font-mono text-center">
            <div><div class="text-[10px] text-slate-400">pH</div><div class="text-lg font-bold text-emerald-400" id="live-phc-ph">${phTxt}</div></div>
            <div><div class="text-[10px] text-slate-400">${langCode === 'en' ? 'Conductivity' : 'Độ dẫn σ'}</div><div class="text-sm font-bold text-sky-400 mt-1" id="live-phc-ec">${ecTxt}</div></div>
          </div>
          <div class="p-2 rounded-lg border border-theme bg-surface">
            <div class="text-[11px] text-muted mb-1 flex justify-between">
              <span>${langCode === 'en' ? 'Titration / Time Curve' : 'Đường chuẩn độ pH / σ'}</span>
              <span class="font-mono" id="live-phc-pts">${(item.history || []).length} pts</span>
            </div>
            <canvas id="analytical-chart" width="270" height="104" class="w-full h-24 rounded border border-theme/50"></canvas>
            ${renderExportActionsBarHtml({ idPrefix: 'probe', label: t('exportImageCsvLabel') })}
          </div>
          ${renderActionGridHtml([
            stands.length > 0 || item.clampedToId
              ? `<button type="button" id="ins-toggle-clamp" title="${t(item.clampedToId ? 'actionUnclampStand' : 'actionClampStand')}" class="w-full py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">${t(item.clampedToId ? 'btnUnclampShort' : 'btnClampShort')}</button>`
              : '',
            `<button type="button" id="ins-phc-reset" title="${t('actionResetCurve')}" class="w-full py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">${t('actionResetCurve')}</button>`,
          ])}
        </div>
      `;
    } else if (item.kind === 'colorimeter') {
      const mode = item.spectroMode || 'uvvis_kinetics';
      const wl = item.wavelengthNm || 525;
      const aVal = item.measuredAbsorbance ?? 0;
      const tVal = item.measuredTransmittance ?? 100;
      const irSub = item.irSubtractWater !== false;
      const contactV = item.contactVesselId ? panel.sim.getItem(item.contactVesselId) : null;
      const uvSpec = mode === 'uvvis_spectrum' ? computeUvVisSpectrum(contactV) : null;
      const irSpec = mode === 'ir_spectrum' ? computeIrSpectrum(contactV, { subtractWater: irSub }) : null;
      const stands = panel.sim.items.filter((i) => i.kind === 'stand');
      const readoutHtml =
        mode === 'uvvis_spectrum'
          ? `
          <div class="grid grid-cols-2 gap-2 p-2.5 rounded-lg border border-theme bg-slate-950 font-mono text-center">
            <div><div class="text-[10px] text-slate-400">λ<sub>max</sub> (UV–Vis)</div><div class="text-lg font-bold text-sky-400" id="live-col-lmax">${uvSpec && uvSpec.maxA > 0.01 ? `${uvSpec.lambdaMaxNm} nm` : '—'}</div></div>
            <div><div class="text-[10px] text-slate-400">A<sub>max</sub></div><div class="text-lg font-bold text-amber-400" id="live-col-amax">${uvSpec ? uvSpec.maxA.toFixed(3) : '0.000'}</div></div>
          </div>`
          : mode === 'ir_spectrum'
          ? `
          <div class="flex items-center justify-between gap-2 p-2 rounded-lg border border-theme bg-surface text-xs">
            <span class="font-mono text-[11px] text-muted">4000 → 400 cm⁻¹ (%T)</span>
            <button type="button" id="ins-col-ir-sub" class="px-2 py-1 rounded border text-[11px] font-medium ${
              irSub ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400 font-semibold' : 'border-theme bg-surface text-muted'
            }">${t('specIrSubtractH2O')}</button>
          </div>`
          : `
          <div class="grid grid-cols-2 gap-2 p-2.5 rounded-lg border border-theme bg-slate-950 font-mono text-center">
            <div><div class="text-[10px] text-slate-400">Absorbance (A)</div><div class="text-lg font-bold text-amber-400" id="live-col-abs">${aVal.toFixed(3)}</div></div>
            <div><div class="text-[10px] text-slate-400">Transmittance</div><div class="text-sm font-bold text-emerald-400 mt-1" id="live-col-trans">${tVal.toFixed(1)}% T</div></div>
          </div>
          <div class="grid grid-cols-5 gap-1">
            ${COLORIMETER_WAVELENGTHS.map(
              (w) => `<button type="button" class="col-wl-btn py-1.5 rounded border text-[11px] font-mono ${
                wl === w ? 'border-sky-500 bg-sky-500/20 text-sky-400 font-bold' : 'border-theme bg-surface text-muted'
              }" data-wl="${w}">${w}</button>`
            ).join('')}
          </div>`;

      const chartH = mode === 'uvvis_kinetics' ? 112 : 168;
      const chartTitle =
        mode === 'ir_spectrum'
          ? 'ATR FT-IR (4000 → 400 cm⁻¹)'
          : mode === 'uvvis_spectrum'
          ? 'UV–Vis Scan (220–750 nm)'
          : langCode === 'en'
          ? 'Beer–Lambert Kinetics A(t)'
          : 'Động học quang A(t)';
      const chartRight = mode === 'ir_spectrum' ? (contactV ? contactV.label || 'Sample' : '—') : mode === 'uvvis_spectrum' ? 'A(λ)' : `${wl} nm`;

      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-2.5">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_colorimeter')} ${item.label}</div>
              <div class="text-[11px] text-muted">${APPARATUS.colorimeter.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          <div class="grid grid-cols-3 gap-1 p-1 rounded-lg border border-theme bg-surface text-[11px]">
            ${[
              ['uvvis_kinetics', t('specModeKinetics')],
              ['uvvis_spectrum', t('specModeUvVis')],
              ['ir_spectrum', t('specModeIr')],
            ]
              .map(
                ([mId, mLabel]) => `<button type="button" class="col-mode-btn py-1 px-1.5 rounded font-medium transition-colors ${
                  mode === mId
                    ? mId === 'ir_spectrum'
                      ? 'bg-orange-500/20 text-orange-400 border border-orange-500/50 font-bold'
                      : 'bg-sky-500/20 text-sky-400 border border-sky-500/50 font-bold'
                    : 'text-muted hover:text-main'
                }" data-spec-mode="${mId}">${mLabel}</button>`
              )
              .join('')}
          </div>
          ${readoutHtml}
          <div class="p-2 rounded-lg border border-theme bg-surface flex flex-col gap-1.5">
            <div class="text-[11px] text-muted flex justify-between items-center gap-1">
              <span>${chartTitle}</span>
              <span class="font-mono text-[10px]" id="live-col-wl">${chartRight}</span>
            </div>
            <canvas id="analytical-chart" width="290" height="${chartH}" class="w-full rounded border border-theme/50 cursor-crosshair" style="height:${chartH}px"></canvas>
            ${
              mode !== 'uvvis_kinetics'
                ? `<div class="text-[10px] font-mono text-muted min-h-[16px] truncate" id="live-col-hover">${contactV ? t('specHoverHint') : t('specNoVessel')}</div>
                   <div class="flex flex-wrap gap-1 text-[10px]" id="live-col-peaks"></div>`
                : ''
            }
            ${renderExportActionsBarHtml({ idPrefix: 'spectro', label: t('exportImageCsvLabel') })}
          </div>
          ${renderActionGridHtml([
            stands.length > 0 || item.clampedToId
              ? `<button type="button" id="ins-toggle-clamp" title="${t(item.clampedToId ? 'actionUnclampStand' : 'actionClampStand')}" class="w-full py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">${t(item.clampedToId ? 'btnUnclampShort' : 'btnClampShort')}</button>`
              : '',
            mode === 'uvvis_kinetics'
              ? `<button type="button" id="ins-col-reset" title="${t('actionResetCurve')}" class="w-full py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">${t('actionResetCurve')}</button>`
              : '',
          ])}
        </div>
      `;
    } else if (item.kind === 'tlc_plate') {
      const spots = item.spots || [];
      const sfPct = ((item.solventFront || 0) * 100).toFixed(0);
      const stands = panel.sim.items.filter((i) => i.kind === 'stand');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_tlc_plate')} ${item.label}</div>
              <div class="text-[11px] text-muted">${APPARATUS.tlc_plate.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface flex items-center justify-between">
            <span class="text-xs font-semibold text-muted">${langCode === 'en' ? 'Solvent front' : 'Mặt dung môi'}</span>
            <strong class="text-sm font-bold font-mono" id="live-tlc-sf">${sfPct}%</strong>
          </div>
          <div class="flex flex-col gap-1 max-h-40 overflow-y-auto text-xs" id="live-tlc-spots">
            ${renderTlcSpotsListHtml(spots, langCode === 'en' ? 'Dip TLC plate into an organic mixture to separate spots' : 'Nhúng bản mỏng vào cốc chứa chất hữu cơ để chạy sắc ký')}
          </div>
          ${renderExportActionsBarHtml({ idPrefix: 'tlc', label: t('exportImageCsvLabel') })}
          ${renderActionGridHtml([
            stands.length > 0 || item.clampedToId
              ? `<button type="button" id="ins-toggle-clamp" title="${t(item.clampedToId ? 'actionUnclampStand' : 'actionClampStand')}" class="w-full py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">${t(item.clampedToId ? 'btnUnclampShort' : 'btnClampShort')}</button>`
              : '',
            `<button type="button" id="ins-tlc-reset" title="${t('actionWashTlcPlate')}" class="w-full py-1.5 px-2 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent flex items-center justify-center gap-1.5 text-center">${t('actionWashTlcPlate')}</button>`,
          ])}
        </div>
      `;
    } else if (item.kind === 'dc_power') {
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_dc_power')} ${item.label}</div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
      const dockedEls = panel.sim.items.filter((i) => i.kind === 'electrode');
      const posEl = item.posElectrodeId ? panel.sim.getItem(item.posElectrodeId) : null;
      const negEl = item.negElectrodeId ? panel.sim.getItem(item.negElectrodeId) : null;
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t('eq_volt_ammeter')} ${item.label}</div>
              <div class="text-[11px] text-muted">${APPARATUS.volt_ammeter.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
      const collectorTarget = item.gasTargetId ? panel.sim.getItem(item.gasTargetId) : null;
      const mountedTube = panel.sim.items.find((i) => i.mountedOverElectrodeId === item.id);
      const collectorCandidates = panel.sim.items.filter(
        (i) => !i.isBroken && !i.isShattered && (i.kind === 'gas_syringe' || (i.kind === 'vessel' && i.id !== item.dockedVesselId))
      );
      const matMeta = ELECTRODE_MATERIALS[item.material] || ELECTRODE_MATERIALS.C;
      const rodMol = ensureElectrodeMetalMoles(item);
      const rodSpec = matMeta.solidId ? SPECIES[matMeta.solidId] : null;
      const rodMassG = rodSpec ? rodMol * (rodSpec.molarMass || 0) : 0;
      const isShe = item.material === 'SHE';
      const pH2Bar = Math.max(0.1, Math.min(5.0, item.shePressureBar ?? 1.0));
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-bold">${t('eq_electrode_rod')} ${item.label}</div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          <div class="text-xs text-muted">${t('electrodeMatLabel')}</div>
          <div class="grid grid-cols-4 gap-1.5">
            ${Object.values(ELECTRODE_MATERIALS)
              .map(
                (m) => `<button type="button" title="${m[langCode === 'en' ? 'nameEn' : 'nameVi']}${m.e0 != null ? ` (E°=${m.e0 >= 0 ? '+' : ''}${m.e0.toFixed(2)} V)` : ''}" class="el-mat-btn py-1.5 px-1 rounded-lg border text-xs font-semibold flex flex-col items-center justify-center leading-tight ${
                  item.material === m.id ? 'border-accent bg-accent/15 text-accent' : 'border-theme bg-surface text-muted hover:border-accent'
                }" data-mat="${m.id}"><span>${m.id}</span>${m.e0 != null ? `<span class="text-[9.5px] font-mono opacity-80">${m.e0 >= 0 ? '+' : ''}${m.e0.toFixed(2)}V</span>` : ''}</button>`
              )
              .join('')}
          </div>
          <div class="text-[11px] text-muted">${(matMeta[langCode === 'en' ? 'nameEn' : 'nameVi']) || item.material}${matMeta.e0 != null ? ` · E° = ${matMeta.e0 >= 0 ? '+' : ''}${matMeta.e0.toFixed(3)} V` : ''}</div>
          ${
            isShe
              ? `<div class="p-2.5 rounded-lg border border-sky-500/35 bg-sky-500/10 flex flex-col gap-1.5 text-xs">
                   <div class="flex items-center justify-between">
                     <span class="text-muted">${t('shePressureLabel')}</span>
                     <strong class="font-mono text-sky-400" id="live-el-she-ph2">${pH2Bar.toFixed(2)} bar</strong>
                   </div>
                   <input type="range" id="ins-el-she-ph2" min="0.10" max="5.00" step="0.05" value="${pH2Bar.toFixed(2)}" class="w-full accent-sky-500 cursor-pointer" />
                 </div>`
              : ''
          }
          ${
            matMeta.solidId
              ? `<div class="p-2 rounded-lg border border-theme bg-surface flex items-center justify-between gap-2 text-xs">
                   <div class="flex flex-col">
                     <span class="text-[10.5px] text-muted">${t('elMetalMassLabel')}</span>
                     <strong class="font-mono" id="live-el-metal">${(rodMol * 1000).toFixed(2)} mmol (${rodMassG.toFixed(2)} g)</strong>
                   </div>
                   <button type="button" id="ins-el-refresh" class="px-2 py-1 rounded-lg border border-theme bg-surface-alt text-[11px] font-medium hover:border-accent whitespace-nowrap shrink-0">${t('elRefreshRodBtn')}</button>
                 </div>`
              : ''
          }
          ${item.polarityLabel ? `<div class="p-2 rounded border border-theme bg-surface text-xs font-mono text-center">${item.polarityLabel}</div>` : ''}
          ${item.passivatedActive ? `<div class="p-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-semibold text-center">${t('elPassivatedBadge')}</div>` : ''}
          ${item.galvanicDominantActive ? `<div class="p-2 rounded border border-sky-500/40 bg-sky-500/10 text-sky-400 text-xs font-semibold text-center">${t('elGalvanicDominantBadge')}</div>` : ''}
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
              ${collectorTarget && collectorTarget.mountedOverElectrodeId !== item.id ? `<div class="text-[11px] text-sky-400 font-medium">${t('elCollectorHoodActive')}</div>` : ''}
              ${renderActionGridHtml([
                `<button type="button" id="ins-el-mount-tube" title="${t('elCollectMountTube')}" class="w-full py-1.5 px-2 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-400 font-semibold text-xs hover:bg-sky-500/20 flex items-center justify-center gap-1.5 text-center">${t('btnCollectMountShort')}</button>`,
                `<button type="button" id="ins-el-pick-collector" title="${t('elCollectPickTarget')}" ${collectorCandidates.length === 0 ? 'disabled' : ''} class="w-full py-1.5 px-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 font-semibold text-xs hover:bg-emerald-500/20 disabled:opacity-40 flex items-center justify-center gap-1.5 text-center">${t('btnCollectTubeShort')}</button>`,
                item.gasTargetId || mountedTube ? `<button type="button" id="ins-el-clear-collector" class="w-full py-1.5 px-2 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-xs flex items-center justify-center gap-1.5 text-center">${t('elCollectDetach')}</button>` : '',
              ])}
              ${
                collectorTarget && collectorTarget.kind === 'vessel' && !collectorTarget.isInverted
                  ? `<label class="flex flex-col gap-1 pt-1">
                       <div class="flex justify-between text-[11px]">
                         <span class="text-muted">${t('tubeDepthLabel')}</span>
                         <strong class="font-mono text-sky-300" id="live-tube-depth-pct">${Math.round((item.tubeSubmersionRatio ?? 0.72) * 100)}%</strong>
                       </div>
                       <input type="range" id="ins-tube-depth-slider" min="0" max="100" step="2" value="${Math.round((item.tubeSubmersionRatio ?? 0.72) * 100)}" class="w-full accent-sky-500 cursor-pointer" />
                     </label>`
                  : ''
              }
            </div>
          ` : ''}
        </div>
      `;
    } else if (item.kind === 'stir_bar') {
      const spc = APPARATUS.stir_bar;
      const hostV = item.inVesselId ? panel.sim.getItem(item.inVesselId) : null;
      const openVessels = panel.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isStoppered);
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t(spc.i18nKey)} ${item.label}</div>
              <div class="text-[11px] text-muted">${spc.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          ${
            hostV
              ? `<div class="p-2.5 rounded-lg border border-theme bg-surface flex flex-col gap-2 text-xs">
                  <div class="flex justify-between">
                    <span class="text-muted">${t('targetVessel')}</span>
                    <strong class="font-mono">${t(APPARATUS[hostV.typeId].i18nKey)} ${hostV.label}</strong>
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-muted">${t('magStirLabel')}</span>
                    <strong class="font-mono text-accent" id="live-sb-rpm">${Math.round(hostV.magStirRpm || 0)} ${t('sbRpmReadoutSuffix')}</strong>
                  </div>
                  <input type="range" id="ins-sb-rpm-slider" min="0" max="1200" step="100" value="${Math.round(hostV.magStirRpm || 0)}" class="w-full accent-sky-500 cursor-pointer" />
                  <div class="grid grid-cols-4 gap-1.5">
                    ${[0, 400, 800, 1200]
                      .map(
                        (rpm) => `<button type="button" class="sb-rpm-btn py-1 rounded border text-[11px] font-mono ${
                          Math.round(hostV.magStirRpm || 0) === rpm ? 'border-accent bg-accent/15 font-bold text-accent' : 'border-theme bg-surface-alt text-muted'
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
    } else if (item.kind === 'boiling_chips') {
      const spc = APPARATUS.boiling_chips;
      const hostV = item.inVesselId ? panel.sim.getItem(item.inVesselId) : null;
      const openVessels = panel.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isStoppered);
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🪨 ${t(spc.i18nKey)} ${item.label}</div>
              <div class="text-[11px] text-muted">${spc.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          ${
            hostV
              ? `<div class="p-2.5 rounded-lg border border-theme bg-surface flex flex-col gap-2 text-xs">
                  <div class="flex justify-between">
                    <span class="text-muted">${t('targetVessel')}</span>
                    <strong class="font-mono">${t(APPARATUS[hostV.typeId].i18nKey)} ${hostV.label}</strong>
                  </div>
                  <div class="text-[11px] text-emerald-400">${t('badgeBoilingChips')}</div>
                  <button type="button" id="ins-bc-remove" class="py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-medium hover:border-accent">${t('boilingChipsRemove')}</button>
                </div>`
              : `<div class="flex flex-col gap-2 text-xs">
                  <p class="text-muted leading-snug">${t('boilingChipsHint')}</p>
                  ${
                    openVessels.length > 0
                      ? `<button type="button" id="ins-bc-pick-insert" class="w-full py-1.5 px-2.5 rounded-lg bg-accent text-white text-xs font-semibold hover:opacity-90">${t('boilingChipsInsert')} · ${t('btnPickOnBench')}</button>`
                      : ''
                  }
                </div>`
          }
        </div>
      `;
    } else if (item.kind === 'salt_bridge') {
      const spc = APPARATUS.salt_bridge;
      const vA = item.vesselAId ? panel.sim.getItem(item.vesselAId) : null;
      const vB = item.vesselBId ? panel.sim.getItem(item.vesselBId) : null;
      const sbMoles = ensureSaltBridgeMoles(item);
      const elecId = item.electrolyteId || 'KNO3';
      const aqVessels = panel.sim.items.filter((v) => v.kind === 'vessel' && !v.isShattered && Object.entries(v.moles || {}).some(([id, n]) => n > 1e-6 && SPECIES[id]?.phase === 'aq'));
      const ionRows = Object.entries(sbMoles)
        .filter(([, n]) => n > 1e-7)
        .map(([id, n]) => `<div class="flex justify-between font-mono text-[11px]"><span>${SPECIES[id]?.formula || id}</span><span>${(n * 1000).toFixed(2)} mmol</span></div>`)
        .join('');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">${t(spc.i18nKey)} ${item.label}${item.isBroken ? ' · 💥' : ''}</div>
              <div class="text-[11px] text-muted">${spc.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          ${
            item.isBroken
              ? `<p class="text-xs text-red-400 font-medium">${t('alertToolBreak')}</p>`
              : `<div class="p-2.5 rounded-lg border border-theme bg-surface text-xs" id="live-sb-link">
                   ${
                     vA && vB
                       ? `<div class="font-mono font-bold text-emerald-400">⚡ ${vA.label} ↔ ${vB.label}${(item.activeCurrentA || 0) > 1e-4 ? ` (${item.activeCurrentA.toFixed(2)} A)` : ''}</div>`
                       : `<p class="text-muted">${t('saltBridgeHint')}</p>`
                   }
                 </div>
                 <div class="p-2.5 rounded-lg border border-theme bg-surface flex flex-col gap-1.5 text-xs">
                   <span class="text-muted font-medium">${t('saltBridgeElectrolyteLabel')}</span>
                   <div class="grid grid-cols-3 gap-1">
                     ${Object.values(SALT_BRIDGE_ELECTROLYTES)
                       .map(
                         (eOpt) => `<button type="button" class="sb-elec-btn py-1 px-1.5 rounded border text-[11px] font-mono font-semibold ${
                           elecId === eOpt.id ? 'border-accent bg-accent/15 text-accent' : 'border-theme bg-surface-alt text-muted hover:border-accent'
                         }" data-sb-elec="${eOpt.id}">${eOpt.formula}</button>`
                       )
                       .join('')}
                   </div>
                   ${
                     aqVessels.length > 0
                       ? `<button type="button" id="ins-sb-fill-vessel" class="mt-0.5 py-1 px-2 rounded-lg border border-theme bg-surface-alt text-[11px] font-medium hover:border-accent">${t('saltBridgeFillFromVesselBtn')}</button>`
                       : ''
                   }
                   <div class="pt-1 border-t border-theme/50 flex flex-col gap-0.5" id="live-sb-ions">${ionRows || '<span class="text-muted">—</span>'}</div>
                 </div>
                 ${
                   item.fouledWarningKey
                     ? `<div class="p-2.5 rounded-lg border border-amber-500/50 bg-amber-500/10 text-amber-300 text-[11px] leading-snug" id="live-sb-warn">${t(item.fouledWarningKey)}</div>`
                     : `<div id="live-sb-warn"></div>`
                 }`
          }
        </div>
      `;
    } else if (item.kind === 'spoon') {
      const spSpec = APPARATUS.iron_spoon;
      const entries = Object.entries(item.moles || {}).filter(([spId, n]) => hasDisplayableSpeciesAmount(spId, n));
      const maxBowlMl = spSpec.maxVolumeMl || 2.8;
      let bowlBulkMl = 0;
      for (const [k, n] of entries) {
        const sp = SPECIES[k];
        if (sp?.phase === 's' && sp.density) {
          bowlBulkMl += ((n * sp.molarMass) / sp.density) * 1.25;
        }
      }
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🥄 ${t('eq_iron_spoon')} ${item.label}</div>
              <div class="text-[11px] text-muted">${spSpec.materialSpec} · ${spSpec.isoStandard}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${renderFlipButtonHtml(item, t)}
              <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs">
              <div class="text-muted">${t('metricTemp')}</div>
              <div class="font-mono font-bold text-sm mt-0.5" id="live-spoon-temp">${(item.tempK || 298.15).toFixed(1)} K (${kelvinToCelsius(item.tempK || 298.15).toFixed(1)}°C)</div>
            </div>
            <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs">
              <div class="text-muted">${t('metricVolume')}</div>
              <div class="font-mono font-bold text-sm mt-0.5" id="live-spoon-vol">${bowlBulkMl.toFixed(2)} / ${maxBowlMl.toFixed(1)} mL</div>
            </div>
          </div>
          <div class="rounded-lg border border-theme bg-surface p-2.5">
            <div class="text-xs font-semibold text-muted mb-1.5">${t('spoonContentsLabel')}</div>
            ${
              entries.length === 0
                ? `<p class="text-xs text-muted">${t('spoonEmpty')}</p>`
                : `
                <table class="w-full text-xs">
                  <thead>
                    <tr class="text-muted border-b border-theme">
                      <th class="text-left pb-1 font-medium">${t('colSpecies')}</th>
                      <th class="text-right pb-1 font-medium">${t('colMoles')}</th>
                      <th class="text-right pb-1 font-medium">${t('colMass')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${entries
                      .map(([spId, n]) => {
                        const sp = SPECIES[spId];
                        if (!sp) return '';
                        const massG = n * sp.molarMass;
                        const molStr = n >= 0.01 ? `${n.toFixed(4)}` : `${(n * 1000).toFixed(3)}m`;
                        return `
                          <tr class="border-b border-theme/50 last:border-0" id="live-spoon-row-${spId}">
                            <td class="py-1 font-semibold">${sp.formula}</td>
                            <td class="py-1 text-right font-mono" id="live-spoon-mol-${spId}">${molStr}</td>
                            <td class="py-1 text-right font-mono" id="live-spoon-mass-${spId}">${massG.toFixed(3)}g</td>
                          </tr>
                        `;
                      })
                      .join('')}
                  </tbody>
                </table>
                `
            }
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
      const hostV = item.attachedToId ? panel.sim.getItem(item.attachedToId) : null;
      const stMode = item.stopperMode || 'holed';
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🔌 ${t('eq_rubber_stopper')} ${item.label}</div>
              <div class="text-[11px] text-muted">${APPARATUS.rubber_stopper.materialSpec}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs flex flex-col gap-1.5">
            <span class="text-muted">${t('stopperModeLabel')}</span>
            <div class="grid grid-cols-1 gap-1.5">
              <button type="button" id="ins-stopper-holed" class="py-1.5 px-2 rounded-lg border text-xs font-semibold text-left ${
                stMode === 'holed' ? 'border-amber-500 bg-amber-500/15 text-amber-400' : 'border-theme bg-surface-alt text-muted'
              }">${t('stopperModeHoled')}</button>
              <button type="button" id="ins-stopper-dual" class="py-1.5 px-2 rounded-lg border text-xs font-semibold text-left ${
                stMode === 'dual_hole' ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400' : 'border-theme bg-surface-alt text-muted'
              }">${t('stopperModeDualHole')}</button>
              <button type="button" id="ins-stopper-solid" class="py-1.5 px-2 rounded-lg border text-xs font-semibold text-left ${
                stMode === 'solid' ? 'border-sky-500 bg-sky-500/15 text-sky-400' : 'border-theme bg-surface-alt text-muted'
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
      const hostV = item.attachedToId ? panel.sim.getItem(item.attachedToId) : null;
      const pinkPct = Math.round(Math.max(0, Math.min(1, item.pinkLevel || 0)) * 100);
      const dampPct = Math.round(Math.max(20, Math.min(100, (item.dampness ?? 0.85) * 100)));
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🌸 ${t('eq_phen_cotton')} ${item.label}</div>
              <div class="text-[11px] text-muted">${APPARATUS.phen_cotton.materialSpec}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
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
    } else if (item.kind === 'thermometer') {
      const mTempK = Number.isFinite(item.measuredTempK) ? item.measuredTempK : item.tempK ?? 298.15;
      const mTempC = mTempK - 273.15;
      const contactStr = item.contactLabel
        ? `${item.contactLabel}`
        : t('thermAmbient');
      topSection = `
        <div class="p-3.5 rounded-xl border border-theme bg-surface-alt flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-sm font-bold">🌡️ ${t('eq_thermometer')} ${item.label}</div>
              <div class="text-[11px] text-muted">${APPARATUS.thermometer.isoStandard}</div>
            </div>
            <button type="button" id="ins-delete" title="${t('actionDelete')}" class="px-2 py-1 rounded text-xs text-red-400 border border-theme hover:bg-red-500/10 whitespace-nowrap shrink-0">${t('btnDeleteShort')}</button>
          </div>
          <div class="p-3 rounded-lg border border-theme bg-surface flex flex-col gap-2 text-xs">
            <div class="flex items-center justify-between">
              <span class="text-muted">${t('thermReadingLabel')}</span>
              <strong id="live-therm-reading" class="text-base font-mono ${mTempC >= 80 ? 'text-orange-400' : mTempC <= 5 ? 'text-sky-400' : 'text-emerald-400'}">${mTempC.toFixed(1)} °C (${mTempK.toFixed(2)} K)</strong>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-muted">${t('thermTargetLabel')}</span>
              <span id="live-therm-contact" class="font-semibold">${contactStr}</span>
            </div>
          </div>
          <p class="text-[11px] text-muted leading-relaxed">${t('eq_thermometer_desc')}</p>
        </div>
      `;
  }
  return topSection;
}

export function updateToolLiveNumbers(panel, item, t) {
    if (!item) {
      const bt = computeBenchTelemetry(panel.sim);
      const atm = computeAtmospherePartialPressures(panel.sim.environment);
      const roomTempC = kelvinToCelsius(panel.sim.environment?.tempK ?? CONSTANTS.T_STD_K);
      const setTxt = (sel, txt) => {
        const el = panel.container.querySelector(sel);
        if (el) el.textContent = txt;
      };
      setTxt('#live-bench-mass', `${formatNumber(bt.totalBenchMassG, 2)} g`);
      setTxt('#live-bench-chem', `${formatNumber(bt.totalChemMassG, 2)}g`);
      setTxt('#live-bench-tare', `${formatNumber(bt.totalTareMassG, 1)}g`);
      setTxt('#live-bench-escaped', `${formatNumber(bt.totalEscapedGasMassG, 3)}g`);
      setTxt('#live-bench-atm-tp', `${roomTempC.toFixed(1)}°C · ${atm.pTotalBar.toFixed(2)} bar`);
      setTxt('#live-bench-pn2', `${atm.pN2Bar.toFixed(3)} bar`);
      setTxt('#live-bench-po2', `${atm.pO2Bar.toFixed(3)} bar`);
      setTxt('#live-bench-pco2', `${(atm.pCO2Bar * 1000).toFixed(2)} mbar`);
      setTxt('#live-bench-rh', `${atm.rhPct.toFixed(0)}%`);
      setTxt('#live-bench-rxns', String(bt.activeReactionCount));
      setTxt('#live-bench-heating', `${bt.heatingVesselCount} / ${bt.boilingVesselCount}`);
      setTxt('#live-bench-overp', String(bt.overpressureVesselCount));
      setTxt('#live-bench-counts', `${bt.vesselCount} + ${bt.toolCount}`);
      return;
    }

    if (item.kind === 'rubber_stopper') return;
    if (item.kind === 'phen_cotton') {
      const pEl = panel.container.querySelector('#live-cotton-pink');
      if (pEl) pEl.textContent = `${Math.round(Math.max(0, Math.min(1, item.pinkLevel || 0)) * 100)}%`;
      return;
    }
    if (item.kind === 'dc_power') {
      const rEl = panel.container.querySelector('#live-dc-readout');
      const mEl = panel.container.querySelector('#live-dc-mode');
      const jEl = panel.container.querySelector('#live-dc-j');
      const rheoEl = panel.container.querySelector('#live-dc-rheo');
      if (rEl) rEl.textContent = `${(item.measuredV || 0).toFixed(2)} V · ${(item.measuredCurrentA || 0).toFixed(2)} A`;
      if (mEl) mEl.textContent = item.circuitMode || 'idle';
      if (jEl) jEl.textContent = `${t('dcCurrentDensityLabel')}: ${(item.currentDensityADm2 || 0).toFixed(1)} A/dm²`;
      if (rheoEl) rheoEl.textContent = `${(item.rheostatOhm ?? 2.0).toFixed(1)} Ω`;
      return;
    }
    if (item.kind === 'volt_ammeter') {
      const rEl = panel.container.querySelector('#live-vm-readout');
      const mEl = panel.container.querySelector('#live-vm-mode');
      if (rEl) rEl.textContent = `${(item.measuredV || 0).toFixed(3)} V · ${(item.measuredCurrentA || 0).toFixed(3)} A`;
      if (mEl) mEl.textContent = item.circuitMode || 'idle';
      return;
    }
    if (item.kind === 'diffusion_tube') {
      const statsEl = panel.container.querySelector('#live-diff-stats');
      if (statsEl) {
        const ringPct = item.ringPosFrac != null ? `${(item.ringPosFrac * 100).toFixed(1)} cm (${(item.ringPosFrac * 100).toFixed(1)}%)` : '—';
        statsEl.innerHTML = `<div class="flex justify-between"><span>Left (0 cm):</span><strong>${item.leftGasId || 'Empty'} (${((item.leftFront || 0) * 100).toFixed(0)}%)</strong></div><div class="flex justify-between"><span>Right (100 cm):</span><strong>${item.rightGasId || 'Empty'} (${((item.rightFront ?? 1) * 100).toFixed(0)}%)</strong></div><div class="flex justify-between text-emerald-400"><span>${t('diffRingPosLabel')}</span><strong id="live-diff-ring">${ringPct}</strong></div>`;
      }
      return;
    }
    if (item.kind === 'burette') {
      const liqMl = computeLiquidVolumeL(item.moles, item.tempK) * 1000;
      const vEl = panel.container.querySelector('#live-bur-vol');
      const dEl = panel.container.querySelector('#live-bur-disp');
      const currentRate = item.valveRateMlS || 0;
      const closedWord = panel.lastLangCode === 'en' ? 'Closed' : 'Đóng';
      if (vEl) vEl.textContent = `${liqMl.toFixed(2)} / 50.0 mL`;
      if (dEl) dEl.textContent = `${(item.dispensedMl || 0).toFixed(2)} mL`;
      syncPrecisionControlLive(panel.container, {
        sliderId: 'ins-bur-rate-slider',
        readoutId: 'live-bur-rate',
        btnClass: 'bur-rate-btn',
        dataAttr: 'rate',
        activeVal: currentRate,
        valueText: currentRate <= 0.001 ? `0.00 mL/s (${closedWord})` : `${currentRate.toFixed(2)} mL/s`,
        sliderValue: Math.max(0.05, currentRate || 0.05),
      });
      updateLiveLiquidContainerSection(panel.container, item, panel.sim.environment.tempK);
      return;
    }
    if (item.kind === 'bath') {
      const nEl = panel.container.querySelector('#live-bath-nested');
      if (nEl) {
        const nestedVessels = panel.sim.items.filter((i) => i.kind === 'vessel' && i.submergedInBathId === item.id && !i.isShattered);
        nEl.textContent = nestedVessels.length > 0
          ? `📥 ${nestedVessels.map((v) => `${v.label} (${kelvinToCelsius(v.tempK).toFixed(1)}°C)`).join(', ')}`
          : '';
      }
      return;
    }

    if (item.kind === 'condenser') {
      const cEl = panel.container.querySelector('#live-cond-ml');
      if (cEl) cEl.textContent = `${(item.totalCondensedMl || 0).toFixed(2)} mL`;
      return;
    }

    if (item.kind === 'separatory_funnel') {
      const vEl = panel.container.querySelector('#live-sep-vol');
      const dEl = panel.container.querySelector('#live-sep-disp');
      const liqMl = computeLiquidVolumeL(item.moles, item.tempK) * 1000;
      const rateMlS = Number.isFinite(item.valveRateMlS) ? item.valveRateMlS : (item.valveFlowFrac ?? 0.35) * 10.0;
      if (vEl) vEl.textContent = `${liqMl.toFixed(2)} / 100.0 mL`;
      if (dEl) dEl.textContent = `${(item.dispensedMl || 0).toFixed(2)} mL`;
      syncPrecisionControlLive(panel.container, {
        sliderId: 'ins-sep-flow-slider',
        readoutId: 'live-sep-rate',
        btnClass: 'sep-rate-btn',
        dataAttr: 'rate',
        activeVal: rateMlS,
        valueText: `${rateMlS.toFixed(2)} mL/s`,
        sliderValue: rateMlS,
      });
      updateLiveLiquidContainerSection(panel.container, item, panel.sim.environment.tempK);
      return;
    }

    if (item.kind === 'wash_bottle') {
      const wEl = panel.container.querySelector('#live-wb-vol');
      if (wEl) wEl.textContent = `${(item.waterMl || 0).toFixed(1)} / 250 mL`;
      return;
    }

    if (item.kind === 'spoon') {
      const tEl = panel.container.querySelector('#live-spoon-temp');
      const vEl = panel.container.querySelector('#live-spoon-vol');
      if (tEl) {
        tEl.textContent = `${(item.tempK || 298.15).toFixed(1)} K (${kelvinToCelsius(item.tempK || 298.15).toFixed(1)}°C)`;
      }
      const maxBowlMl = APPARATUS.iron_spoon?.maxVolumeMl || 2.8;
      let bowlBulkMl = 0;
      let needsSpoonRebuild = false;
      panel.container.querySelectorAll('[id^="live-spoon-row-"]').forEach((rowEl) => {
        const sid = rowEl.id.replace('live-spoon-row-', '');
        if (!hasDisplayableSpeciesAmount(sid, item.moles?.[sid])) needsSpoonRebuild = true;
      });
      for (const [spId, n] of Object.entries(item.moles || {})) {
        if (!hasDisplayableSpeciesAmount(spId, n)) continue;
        const sp = SPECIES[spId];
        if (sp?.phase === 's' && sp.density) {
          bowlBulkMl += ((n * sp.molarMass) / sp.density) * 1.25;
        }
        const mEl = panel.container.querySelector(`#live-spoon-mol-${spId}`);
        const gEl = panel.container.querySelector(`#live-spoon-mass-${spId}`);
        if (!mEl) needsSpoonRebuild = true;
        if (mEl) mEl.textContent = n >= 0.01 ? `${n.toFixed(4)}` : `${(n * 1000).toFixed(3)}m`;
        if (gEl && sp) gEl.textContent = `${(n * sp.molarMass).toFixed(3)}g`;
      }
      if (vEl) {
        vEl.textContent = `${bowlBulkMl.toFixed(2)} / ${maxBowlMl.toFixed(1)} mL`;
      }
      if (needsSpoonRebuild) {
        panel.lastStructureSig = '';
      }
      return;
    }
    if (item.kind === 'condenser') {
      const cEl = panel.container.querySelector('#live-cond-ml');
      if (cEl) cEl.textContent = `${(item.totalCondensedMl || 0).toFixed(2)} mL`;
      return;
    }

    if (item.kind === 'scale') {
      const el = panel.container.querySelector('#live-scale-readout');
      if (el) el.textContent = `${(item.measuredG || 0).toFixed(2)} g`;
      return;
    }

    if (item.kind === 'thermometer') {
      const tEl = panel.container.querySelector('#live-therm-reading');
      const cEl = panel.container.querySelector('#live-therm-contact');
      const mTempK = Number.isFinite(item.measuredTempK) ? item.measuredTempK : item.tempK ?? 298.15;
      const mTempC = mTempK - 273.15;
      if (tEl) tEl.textContent = `${mTempC.toFixed(1)} °C (${mTempK.toFixed(2)} K)`;
      if (cEl) cEl.textContent = item.contactLabel || t('thermAmbient');
      return;
    }

    if (item.kind === 'burner') {
      const bSpec = APPARATUS[item.typeId] || APPARATUS.burner;
      const isBunsen = item.typeId === 'bunsen_burner';
      const airOpen = isBunsen ? item.airHoleOpen !== false : true;
      const tbl = isBunsen && !airOpen ? bSpec.yellowPowerLevelsW : bSpec.powerLevelsW;
      const powerW = Math.round(item.powerW ?? (tbl[item.flameLevel || 0] || 0));
      const pEl = panel.container.querySelector('#live-burner-power');
      const sEl = panel.container.querySelector('#burner-power-slider');
      if (pEl) pEl.textContent = `${formatNumber(powerW, 0)} W`;
      if (sEl && Number(sEl.value) !== powerW) sEl.value = String(powerW);
      panel.container.querySelectorAll('.flame-btn').forEach((btn) => {
        const isMatch = powerW === Number(btn.dataset.w);
        btn.className = `flame-btn py-1.5 rounded-lg text-[11px] font-semibold border ${
          isMatch ? 'border-orange-500 bg-orange-500/20 text-orange-400' : 'border-theme bg-surface text-muted'
        }`;
      });
      return;
    }

    if (item.kind === 'pipette') {
      const vEl = panel.container.querySelector('#live-pip-vol');
      const sEl = panel.container.querySelector('#live-pip-src');
      const dropDose = item.dropDoseMl || 1.0;
      if (vEl) vEl.textContent = `${(item.volumeMl || 0).toFixed(2)} / 10.00 mL`;
      if (sEl) sEl.textContent = item.hideComposition ? (item.blindLabel || '?') : (item.sourceLabel || '—');
      syncPrecisionControlLive(panel.container, {
        sliderId: 'ins-pip-dose-slider',
        readoutId: 'live-pip-dose',
        btnClass: 'pip-dose-btn',
        dataAttr: 'dose',
        activeVal: dropDose,
        valueText: `${dropDose.toFixed(2)} mL`,
        sliderValue: dropDose,
      });
      updateLiveLiquidContainerSection(panel.container, item, panel.sim.environment.tempK);
      return;
    }

    if (item.kind === 'wash_bottle') {
      const volEl = panel.container.querySelector('#live-wb-vol');
      const catchEl = panel.container.querySelector('#live-wb-catch');
      if (volEl) volEl.textContent = `${(item.waterMl || 0).toFixed(1)} / 250 mL`;
      if (catchEl) {
        const wbArc = computeWashBottleStreamArc(item, panel.sim.items, 482, CONSTANTS.GRAVITY_PX_S2 || 1800);
        catchEl.textContent = wbArc?.hitTarget
          ? `🎯 ${t(APPARATUS[wbArc.hitTarget.typeId].i18nKey)} ${wbArc.hitTarget.label}`
          : t('syringeCatchMiss');
      }
      return;
    }

    if (item.kind === 'ph_conductometer') {
      const phEl = panel.container.querySelector('#live-phc-ph');
      const ecEl = panel.container.querySelector('#live-phc-ec');
      const ptsEl = panel.container.querySelector('#live-phc-pts');
      if (phEl) phEl.textContent = item.measuredPH != null ? item.measuredPH.toFixed(2) : '—';
      if (ecEl) ecEl.textContent = item.measuredConductivity != null ? `${item.measuredConductivity.toFixed(2)} mS/cm` : '—';
      if (ptsEl) ptsEl.textContent = `${(item.history || []).length} pts`;
      panel.drawAnalyticalChart(item);
      return;
    }

    if (item.kind === 'colorimeter') {
      const mode = item.spectroMode || 'uvvis_kinetics';
      if (mode === 'uvvis_kinetics') {
        const aEl = panel.container.querySelector('#live-col-abs');
        const tEl = panel.container.querySelector('#live-col-trans');
        const wlEl = panel.container.querySelector('#live-col-wl');
        if (aEl) aEl.textContent = (item.measuredAbsorbance ?? 0).toFixed(3);
        if (tEl) tEl.textContent = `${(item.measuredTransmittance ?? 100).toFixed(1)}% T`;
        if (wlEl) wlEl.textContent = `${item.wavelengthNm || 525} nm`;
      } else if (mode === 'uvvis_spectrum') {
        const contactV = item.contactVesselId ? panel.sim.getItem(item.contactVesselId) : null;
        const uvSpec = computeUvVisSpectrum(contactV);
        const lEl = panel.container.querySelector('#live-col-lmax');
        const aEl = panel.container.querySelector('#live-col-amax');
        if (lEl) lEl.textContent = uvSpec.maxA > 0.01 ? `${uvSpec.lambdaMaxNm} nm` : '—';
        if (aEl) aEl.textContent = uvSpec.maxA.toFixed(3);
      }
      panel.drawAnalyticalChart(item);
      return;
    }

    if (item.kind === 'tlc_plate') {
      const sfEl = panel.container.querySelector('#live-tlc-sf');
      const spotsEl = panel.container.querySelector('#live-tlc-spots');
      if (sfEl) sfEl.textContent = `${((item.solventFront || 0) * 100).toFixed(0)}%`;
      if (spotsEl && (item.spots || []).length > 0) {
        spotsEl.innerHTML = renderTlcSpotsListHtml(item.spots || []);
      }
      return;
    }

    if (item.kind === 'electrode') {
      const mEl = panel.container.querySelector('#live-el-metal');
      const sEl = panel.container.querySelector('#live-el-she-ph2');
      const matMeta = ELECTRODE_MATERIALS[item.material] || ELECTRODE_MATERIALS.C;
      if (mEl && matMeta.solidId) {
        const rodMol = ensureElectrodeMetalMoles(item);
        const massG = rodMol * (SPECIES[matMeta.solidId]?.molarMass || 0);
        mEl.textContent = `${(rodMol * 1000).toFixed(2)} mmol (${massG.toFixed(2)} g)`;
      }
      if (sEl) sEl.textContent = `${Math.max(0.1, Math.min(5.0, item.shePressureBar ?? 1.0)).toFixed(2)} bar`;
      return;
    }

    if (item.kind === 'salt_bridge') {
      const ionsEl = panel.container.querySelector('#live-sb-ions');
      const warnEl = panel.container.querySelector('#live-sb-warn');
      if (ionsEl) {
        const sbMoles = ensureSaltBridgeMoles(item);
        const ionRows = Object.entries(sbMoles)
          .filter(([, n]) => n > 1e-7)
          .map(([id, n]) => `<div class="flex justify-between font-mono text-[11px]"><span>${SPECIES[id]?.formula || id}</span><span>${(n * 1000).toFixed(2)} mmol</span></div>`)
          .join('');
        ionsEl.innerHTML = ionRows || '<span class="text-muted">—</span>';
      }
      if (warnEl) {
        if (item.fouledWarningKey) {
          warnEl.className = 'p-2.5 rounded-lg border border-amber-500/50 bg-amber-500/10 text-amber-300 text-[11px] leading-snug';
          warnEl.textContent = t(item.fouledWarningKey);
        } else {
          warnEl.className = '';
          warnEl.textContent = '';
        }
      }
      return;
    }

    if (item.kind === 'stir_bar') {
      const hostV = item.inVesselId ? panel.sim.getItem(item.inVesselId) : null;
      const rpmVal = Math.round(hostV?.magStirRpm || 0);
      const rEl = panel.container.querySelector('#live-sb-rpm');
      const sEl = panel.container.querySelector('#ins-sb-rpm-slider');
      if (rEl) rEl.textContent = `${rpmVal} ${t('sbRpmReadoutSuffix')}`;
      if (sEl && document.activeElement !== sEl) sEl.value = String(rpmVal);
      panel.container.querySelectorAll('.sb-rpm-btn').forEach((btn) => {
        const bRpm = Number(btn.dataset.rpm);
        const active = bRpm === rpmVal;
        btn.classList.toggle('border-accent', active);
        btn.classList.toggle('bg-accent/15', active);
        btn.classList.toggle('font-bold', active);
        btn.classList.toggle('text-accent', active);
        btn.classList.toggle('border-theme', !active);
        btn.classList.toggle('bg-surface-alt', !active);
        btn.classList.toggle('text-muted', !active);
      });
      return;
    }

    if (item.kind === 'gas_syringe') {
      const volMl = computeSyringeTotalVolumeMl(item, panel.sim.environment);
      const totalGasMol = sumAllGasMoles(item.gasMoles);
      const condInfo = getSyringeCondenseInfo(item, panel.sim.environment, t);
      const syrSpec = APPARATUS.gas_syringe;
      const pBar = item.internalPressureBar ?? panel.sim.environment.pressureBar;
      const overPBar = pBar - panel.sim.environment.pressureBar;
      const arc = !item.isBroken
        ? computeSyringeDischargeArc(item, panel.sim.items, 482, 1800)
        : null;
      const vEl = panel.container.querySelector('#live-syr-vol');
      const mEl = panel.container.querySelector('#live-syr-mol');
      const tEl = panel.container.querySelector('#live-syr-temp');
      const cEl = panel.container.querySelector('#live-syr-cond');
      const sEl = panel.container.querySelector('#live-syr-cond-state');
      const bEl = panel.container.querySelector('#live-syr-breakdown');
      const pEl = panel.container.querySelector('#live-syr-press');
      const catchEl = panel.container.querySelector('#live-syr-catch');
      if (vEl) vEl.textContent = `${volMl.toFixed(2)} mL`;
      if (mEl) mEl.textContent = `${(totalGasMol * 1000).toFixed(2)} mmol`;
      if (tEl) tEl.textContent = `${condInfo.syrTempK.toFixed(1)} K (${condInfo.syrTempC.toFixed(1)}°C)`;
      if (cEl) cEl.textContent = `${condInfo.totalFluidMl.toFixed(2)} mL`;
      if (sEl) sEl.textContent = condInfo.condenseState;
      if (bEl) {
        const prevScroll = bEl.querySelector('#syr-gas-scroll')?.scrollTop || 0;
        bEl.innerHTML = buildSyringeGasCompositionHtml(item, syrSpec, panel.sim.environment, t, condInfo);
        const sc = bEl.querySelector('#syr-gas-scroll');
        if (sc && prevScroll > 0) sc.scrollTop = prevScroll;
      }
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
}
