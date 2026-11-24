/**
 * Reaction Vessel Inspector Renderer & Live Updater (Refactor 81).
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
  formatGasSummaryHtml,
  computeVesselPressureMetrics,
  hasDisplayableSpeciesAmount,
  formatChemEquation,
  buildVesselGasCompositionHtml,
  buildEscapedGasVerticalHtml,
  buildLiquidRowsHtml,
  buildSolidRowsHtml,
  getSyringeCondenseInfo,
} from './inspectorUtils.js';

export function renderVesselInspectorHtml(panel, item, t, langCode = panel.lastLangCode || 'vi') {
  let topSection = '';
      const spec = APPARATUS[item.typeId];
      const liqL = computeLiquidVolumeL(item.moles, item.tempK);
      const liqMl = liqL * 1000;
      const iceMl = ((item.moles.H2O_s || 0) * SPECIES.H2O_s.molarMass) / CONSTANTS.ICE_DENSITY_G_ML;
      const ph = item.isFrozenSolid ? null : computePH(item.moles, liqL, item.tempK);
      const contentsG = computeContentsMassG(item.moles);
      const grossG = spec.tareMassG + contentsG;
      const connTargetId = item.connectedTargetId || item.connectedSyringeId;
      const connTarget = connTargetId ? panel.sim.getItem(connTargetId) : null;
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
      const syrVol = syr ? computeSyringeTotalVolumeMl(syr, panel.sim.environment) : 0;
      const syrCondInfo = syr ? getSyringeCondenseInfo(syr, panel.sim.environment, t) : null;
      const tubeGeom = connTarget ? computeTubingGeometry(item, connTarget) : null;
      const tubeVolMl = connTarget ? computeLiquidVolumeL(item.tubeMoles || {}, item.tubeTempK || item.tempK) * 1000 : 0;
      const stands = panel.sim.items.filter((i) => i.kind === 'stand');
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
          ${(item.soapFoamMl || 0) > 0.5 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-slate-300/60 bg-slate-100/15 text-main text-xs font-medium">${t('badgeSoapFoam')}: +${(item.soapFoamMl || 0).toFixed(1)} mL</div>` : ''}
          ${item.soapSaltedOutCake && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-amber-200/60 bg-amber-100/15 text-main text-xs font-semibold">${t('badgeSoapSaltedCake')}</div>` : ''}
          ${item.soapConcPassivated && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-amber-500/50 bg-amber-500/15 text-amber-400 text-xs font-medium">${t('badgeSoapConcPassivated')}</div>` : ''}
          ${item.soapEarlySalted && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-orange-500/50 bg-orange-500/15 text-orange-400 text-xs font-medium">${t('badgeSoapEarlyBrine')}</div>` : ''}
          ${item.soapScorched && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-red-500/50 bg-red-500/15 text-red-400 text-xs font-medium">${t('badgeSoapScorched')}</div>` : ''}
          ${item.saponificationComplete && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-emerald-500/50 bg-emerald-500/15 text-emerald-400 text-xs font-semibold">${t('badgeSoapDone')}</div>` : ''}
          ${(item.esterOverheatFrac || 0) > 0.12 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-amber-500/50 bg-amber-500/15 text-amber-400 text-xs font-medium">${t('badgeEsterOverheated')}</div>` : ''}
          ${item.esterPurified && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-emerald-500/50 bg-emerald-500/15 text-emerald-400 text-xs font-medium">${t('badgeEsterPurified')}</div>` : ''}
          ${item.hasBoilingChips && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-slate-400/50 bg-slate-500/10 text-main text-xs font-medium">${t('badgeBoilingChips')}</div>` : ''}
          ${item.soapSoftPotassiumGel && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-sky-400/50 bg-sky-400/10 text-sky-300 text-xs font-medium">${t('badgeSoapSoftKoh')}</div>` : ''}
          ${(() => {
            const aroma = !item.isShattered ? computeVesselAroma(item) : null;
            return aroma ? `<div class="p-1.5 px-2.5 rounded-lg border ${aroma.tone} text-xs font-medium"><span class="opacity-80">${t('aromaTitle')}:</span> ${t(aroma.key)}</div>` : '';
          })()}
          ${(item.langmuirCoverage || 0) > 0.55 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs font-medium">${t('badgeLangmuirSat')} (θ=${Math.round((item.langmuirCoverage || 0) * 100)}%, n≈${(item.langmuirOrder ?? 0).toFixed(2)})</div>` : ''}
          ${(item.naTarnishFrac || 0) > 0.25 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-slate-500/40 bg-slate-500/10 text-muted text-xs font-medium">${t('badgeAirTarnished')}</div>` : ''}
          ${(item.kTarnishFrac || 0) > 0.25 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-purple-500/40 bg-purple-500/10 text-purple-300 text-xs font-medium">${t('badgeAirTarnishedK')}</div>` : ''}
          ${(item.naohDeliquesceFrac || 0) > 0.15 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-400 text-xs font-medium">${t('badgeNaohDeliquesced')}</div>` : ''}
          ${(item.caCo3FilmFrac || 0) > 0.25 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-slate-400/40 bg-slate-500/10 text-main text-xs font-medium">${t('badgeCaCo3Film')}</div>` : ''}
          ${item.fePassivated && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-medium">${t('badgeFePassivated')}</div>` : ''}
          ${item.alPassivated && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-sky-400/40 bg-sky-400/10 text-sky-300 text-xs font-medium">${t('badgeAlPassivated')}</div>` : ''}
          ${item.caso4Passivated && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-slate-400/50 bg-slate-400/10 text-main text-xs font-medium">${t('badgeCaSO4Passivated')}</div>` : ''}
          ${(item.znCombustionTimer || 0) > 0.05 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-amber-400/60 bg-amber-400/15 text-amber-300 text-xs font-semibold">${t('badgeZnBurnO2')}</div>` : ''}
          ${(item.mgCombustionTimer || 0) > 0.05 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-sky-300/70 bg-slate-100/20 text-main text-xs font-semibold">${t('badgeMgBurnFlash')}</div>` : ''}
          ${(item.softenGlowFrac || 0) > 0.1 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-red-500/50 bg-red-500/15 text-red-300 text-xs font-semibold">${t('borosilicateSoftenWarn')}</div>` : ''}
          ${(item.silverMirrorLevel || 0) > 0.04 && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-slate-300/60 bg-slate-200/15 text-main text-xs font-semibold">${t('wallMemorySilverTag')} (${Math.round((item.silverMirrorLevel || 0) * 100)}%)</div>` : ''}
          ${((item.wallResidueMap?.CuO_s || 0) > 0.05 || (item.wallResidueMap?.BaSO4_s || 0) > 0.05) && !item.isShattered ? `<div class="p-1.5 px-2.5 rounded-lg border border-slate-500/50 bg-slate-500/15 text-muted text-xs font-medium">${t('wallMemoryResidueTag')}</div>` : ''}
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
              ? panel.sim.environment?.atmosphereMode === 'inert' || (item.airO2PurgeFrac ?? 1) <= 0.14
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
              Array.isArray(panel.sim.compareVesselIds) && panel.sim.compareVesselIds.includes(item.id)
                ? 'border-sky-500 bg-sky-500/20 text-sky-400 font-semibold'
                : 'border-theme bg-surface'
            } text-xs font-medium hover:border-accent">${
              Array.isArray(panel.sim.compareVesselIds) && panel.sim.compareVesselIds.includes(item.id)
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
              spec.invertible
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
            <button type="button" id="ins-sticky-label" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs font-medium hover:border-accent">${t('stickyLabelBtn')}</button>
            <button type="button" id="ins-store-cabinet" class="px-2.5 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-semibold hover:opacity-90">${t('ctxStoreCabinet')}</button>
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

        <!-- Group 1: Thermodynamics & Instantaneous Physics -->
        ${(() => {
          const pm = computeVesselPressureMetrics(item, spec, panel.sim.environment);
          const barCol = pm.rawRatio >= 0.85 ? '#D62839' : pm.rawRatio >= 0.6 ? '#f59e0b' : '#38bdf8';
          const dSign = pm.deltaPBar >= 0 ? '+' : '';
          const themeCur = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : 'dark';
          const warnPrefix = themeCur === 'petal' ? `${t('themeWarningSignsTitle')} · ` : '';
          const liqTabData = computeLiquidSpeciesTableData(item.moles, item.tempK);
          const solidRowsStr = buildSolidRowsHtml(item, t);
          const electroMetrics = computeVesselElectrochemicalMetrics(item, ph, liqL);
          const redoxMetrics = computeVesselRedoxAndCellMetrics(item, panel.sim.items, liqL, ph);
          const qRelKJ = (item.cumulativeReactionHeatJ || 0) / 1000;
          const dTdt = item.lastTempRateCS || 0;
          const dTdtSign = dTdt > 0.005 ? '+' : '';
          const pAtm = pm.localPBar * 0.986923;
          const vRate = liqL > 1e-5 ? (item.lastTotalRateMolS || 0) / liqL : 0;
          const convStr = item.conversionYieldPct !== null && item.conversionYieldPct !== undefined ? `${item.conversionYieldPct.toFixed(1)}%` : '—';
          const open1 = panel.sectionOpen?.thermo !== false ? 'open' : '';
          const open2 = panel.sectionOpen?.phases !== false ? 'open' : '';
          const open3 = panel.sectionOpen?.electro !== false ? 'open' : '';
          return `
        <details class="rounded-xl border border-theme bg-surface-alt group" data-ins-sec="thermo" ${open1}>
          <summary class="px-3 py-2.5 cursor-pointer select-none flex items-center justify-between gap-2 text-[13px] font-bold uppercase tracking-wide text-muted hover:text-main">
            <span>🌡️ ${t('groupThermoPhysics')}</span>
            <span class="text-[11px] font-mono text-sky-400 shrink-0 whitespace-nowrap" id="live-sum-tp">${formatNumber(kelvinToCelsius(item.tempK), 1)}°C · ${pm.localPBar.toFixed(2)} bar</span>
          </summary>
          <div class="px-3 pb-3 flex flex-col gap-2 border-t border-theme/40 pt-2">
            <div class="p-2.5 rounded-lg border border-theme bg-surface flex items-center justify-between gap-2">
              <div class="min-w-0">
                <div class="text-xs font-semibold text-muted">${t('metricTemp')} &amp; ΔT/Δt</div>
                <div class="text-sm font-bold font-mono mt-0.5" id="live-temp">${formatNumber(item.tempK, 1)} K (${formatNumber(kelvinToCelsius(item.tempK), 1)}°C)</div>
              </div>
              <div class="text-[11px] font-mono shrink-0 whitespace-nowrap ${Math.abs(dTdt) > 0.05 ? (dTdt > 0 ? 'text-orange-400' : 'text-sky-400') : 'text-muted'}" id="live-dtemp">${dTdtSign}${dTdt.toFixed(2)} °C/s</div>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="p-2.5 rounded-lg border border-theme bg-surface">
                <div class="text-xs font-semibold text-muted">${t('metricHeatQ')}</div>
                <div class="text-sm font-bold font-mono mt-0.5 ${qRelKJ > 0.005 ? 'text-orange-400' : qRelKJ < -0.005 ? 'text-sky-400' : ''}" id="live-cum-heat">Q = ${qRelKJ.toFixed(2)} kJ</div>
              </div>
              <div class="p-2.5 rounded-lg border border-theme bg-surface">
                <div class="text-xs font-semibold text-muted">${t('metricEnthalpyRxn')}</div>
                <div class="text-sm font-bold font-mono mt-0.5" id="live-cum-dh">ΔH<sub>rxn</sub> ≈ ${(-qRelKJ).toFixed(2)} kJ</div>
              </div>
              <div class="p-2.5 rounded-lg border border-theme bg-surface">
                <div class="text-xs font-semibold text-muted">${t('metricLiquidVol')}</div>
                <div class="text-sm font-bold font-mono mt-0.5" id="live-vol">${volDisplayStr}</div>
                <div class="text-[11px] text-muted font-mono mt-0.5" id="live-brim">${t('brimLabel')}: ~${formatNumber(spec.geometry ? spec.geometry.maxVolumeMl * 0.96 : spec.maxVolumeMl, 0)} mL</div>
              </div>
              <div class="p-2.5 rounded-lg border border-theme bg-surface">
                <div class="text-xs font-semibold text-muted">${t('metricMixDensity')}</div>
                <div class="text-sm font-bold font-mono mt-0.5 text-sky-400" id="live-mix-density">ρ = ${liqTabData.mixDensity > 0 ? liqTabData.mixDensity.toFixed(3) : '—'} g/mL</div>
              </div>
              <div class="p-2.5 rounded-lg border border-theme bg-surface">
                <div class="text-xs font-semibold text-muted">${t('metricNetMassTitle')}</div>
                <div class="text-sm font-bold font-mono mt-0.5" id="live-mass">${formatNumber(contentsG, 2)} g</div>
              </div>
              <div class="p-2.5 rounded-lg border border-theme bg-surface">
                <div class="text-xs font-semibold text-muted">${t('metricGrossMassTitle')}</div>
                <div class="text-sm font-bold font-mono mt-0.5" id="live-mass-gross">${formatNumber(grossG, 2)} g</div>
                <div class="text-[11px] text-muted font-mono mt-0.5" id="live-mass-tare">${t('tarePrefix')} ${formatNumber(spec.tareMassG, 0)}g</div>
              </div>
            </div>
            <div class="p-2.5 rounded-lg border border-theme bg-surface flex flex-col gap-2 press-card-warning">
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <div class="text-xs font-semibold text-muted">${warnPrefix}${t('metricLocalPressureTitle')}</div>
                  <div class="text-sm font-bold font-mono mt-0.5" id="live-press-local">${pm.localPBar.toFixed(2)} bar</div>
                  <div class="text-[11px] text-muted font-mono" id="live-press-atm">(${pAtm.toFixed(2)} atm)</div>
                </div>
                <div>
                  <div class="text-xs font-semibold text-muted">${t('metricOverpressureLimitTitle')}</div>
                  <div class="text-sm font-bold font-mono mt-0.5 ${pm.rawRatio >= 0.85 ? 'text-red-400' : ''}" id="live-press-limit">${dSign}${pm.deltaPBar.toFixed(2)} / +${pm.maxDeltaPBar.toFixed(2)} bar</div>
                </div>
              </div>
              <div class="w-full h-1.5 rounded-full bg-surface-alt overflow-hidden border border-theme/50">
                <div id="live-press-bar" class="h-full transition-all duration-150" style="width:${pm.limitPct.toFixed(1)}%;background-color:${barCol};"></div>
              </div>
            </div>
            ${
              tubeGeom
                ? `<div class="px-2.5 py-1.5 rounded-lg border border-sky-500/35 bg-sky-500/10 text-[11px] flex flex-col gap-1.5">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-xs font-semibold text-muted">${t('tubeStatsNote')} · ${connTarget.label}</span>
                      <strong class="font-mono text-sky-400" id="live-tube-stats">${tubeGeom.arcLengthCm.toFixed(1)} cm · ${Math.min(tubeVolMl, tubeGeom.capacityMl).toFixed(2)}/${tubeGeom.capacityMl.toFixed(2)} mL</strong>
                    </div>
                    ${
                      connTarget.kind === 'vessel'
                        ? `<label class="flex flex-col gap-1 border-t border-sky-500/20 pt-1">
                             <div class="flex justify-between text-[11px]">
                               <span class="text-xs font-semibold text-muted">${t('tubeDepthLabel')}</span>
                               <strong class="font-mono text-sky-300" id="live-tube-depth-pct">${Math.round((item.tubeSubmersionRatio ?? 0.72) * 100)}%</strong>
                             </div>
                             <input type="range" id="ins-tube-depth-slider" min="0" max="100" step="2" value="${Math.round((item.tubeSubmersionRatio ?? 0.72) * 100)}" class="w-full accent-sky-500 cursor-pointer" />
                           </label>`
                        : ''
                    }
                  </div>`
                : ''
            }
            ${
              (item.sootLevel || 0) > 0.05
                ? `<div class="px-2.5 py-1.5 rounded-lg border border-slate-500/50 bg-slate-800/40 text-xs flex items-center justify-between">
                     <span class="text-xs font-semibold text-slate-300">🖤 ${t('sootLevelLabel')}</span>
                     <strong class="text-sm font-bold font-mono text-amber-300" id="live-soot-pct">${Math.round((item.sootLevel || 0) * 100)}%</strong>
                   </div>`
                : ''
            }
            ${
              syr
                ? `<div class="px-2.5 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs flex flex-col gap-0.5">
                    <div class="flex justify-between gap-2">
                      <span class="text-xs font-semibold text-muted">${t('gasCollectedNote')}</span>
                      <strong class="text-sm font-bold font-mono" id="live-collected-gas">${syrVol.toFixed(2)} mL · ${syrCondInfo.syrTempC.toFixed(1)}°C</strong>
                    </div>
                    <div class="text-[11px] text-sky-400 font-mono" id="live-collected-cond">${
                      syrCondInfo.totalFluidMl > 0.0005 || syrCondInfo.isCondensing
                        ? `${syrCondInfo.frozenMol > syrCondInfo.condensedMol ? '❄️' : '💧'} ${t(syrCondInfo.frozenMol > syrCondInfo.condensedMol ? 'syringeFrozenShort' : 'gasCondensedShort')}: ${syrCondInfo.totalFluidMl.toFixed(2)} mL ${syrCondInfo.condSpec}`
                        : ''
                    }</div>
                  </div>`
                : connTarget
                ? `<div class="px-2.5 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs flex justify-between gap-2">
                    <span class="text-xs font-semibold text-muted">${t('tubeHoldNote')}</span>
                    <strong class="font-mono">${t(APPARATUS[connTarget.typeId].i18nKey)} ${connTarget.label}</strong>
                  </div>`
                : ''
            }
          </div>
        </details>

        <!-- Group 2: Phase Composition & Concentrations (Gas, Liquid, Solid) -->
        <details class="rounded-xl border border-theme bg-surface-alt group" data-ins-sec="phases" ${open2}>
          <summary class="px-3 py-2.5 cursor-pointer select-none flex items-center justify-between gap-2 text-[13px] font-bold uppercase tracking-wide text-muted hover:text-main">
            <span>⚗️ ${t('groupPhaseComposition')}</span>
            <span class="text-[11px] font-mono text-muted shrink-0 whitespace-nowrap">${liqTabData.rows.length}L · ${Object.keys(item.moles || {}).filter((k) => SPECIES[k]?.phase === 's' && hasDisplayableSpeciesAmount(k, item.moles[k])).length}S</span>
          </summary>
          <div class="px-3 pb-3 flex flex-col gap-2.5 border-t border-theme/40 pt-2">
            <!-- Gas & Vapor -->
            <div class="p-2.5 rounded-lg border border-theme bg-surface text-xs flex flex-col gap-1.5">
              <div class="flex items-center justify-between gap-2">
                <h4 class="text-xs font-semibold text-muted">${t('gasEscapedNote')}</h4>
                <span class="font-mono text-[11px] text-amber-400 shrink-0 whitespace-nowrap" id="live-escaped-gas-temp">${
                  item.lastGasOutTempK ? `${t('gasOutTempTag')} ${kelvinToCelsius(item.lastGasOutTempK).toFixed(1)}°C` : ''
                }</span>
              </div>
              <div id="live-escaped-gas">${buildEscapedGasVerticalHtml(item, panel.sim.environment, t)}</div>
            </div>
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <h4 class="text-xs font-semibold text-muted mb-1.5">${t('gasTableTitle')}</h4>
              <div id="gas-comp-box">${buildVesselGasCompositionHtml(item, spec, panel.sim.environment, liqL, t)}</div>
            </div>

            <!-- Separate Liquid & Solution Table -->
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <div class="flex items-center justify-between gap-2 mb-1.5">
                <h4 class="text-xs font-semibold text-muted">${t('liquidTableTitle')}</h4>
                <button type="button" id="btn-export-xlsx" title="${t('exportXlsxBtn')}" class="px-2 py-0.5 rounded border border-theme bg-surface-alt text-[10.5px] font-semibold hover:border-accent shrink-0">📥 ${t('exportXlsxBtn')}</button>
              </div>
              <div id="sp-liq-box">
                ${
                  liqTabData.rows.length === 0
                    ? `<p class="text-[11px] text-muted">${item.isShattered ? t('shatteredEmptyMsg') : t('emptyLiquidMsg')}</p>`
                    : `<div class="overflow-x-auto max-h-44 overflow-y-auto">
                        <table class="w-full text-[11px]">
                          <thead>
                            <tr class="text-[11px] text-muted border-b border-theme text-left">
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

            <!-- Separate Solid & Precipitate Table -->
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <h4 class="text-xs font-semibold text-muted mb-1.5">${t('solidTableTitle')}</h4>
              <div id="sp-sol-box">
                ${
                  !solidRowsStr
                    ? `<p class="text-[11px] text-muted">${t('emptySolidMsg')}</p>`
                    : `<div class="overflow-x-auto max-h-40 overflow-y-auto">
                        <table class="w-full text-xs">
                          <thead>
                            <tr class="text-[11px] text-muted border-b border-theme text-left">
                              <th class="pb-1 font-medium">${t('colSpecies')}</th>
                              <th class="pb-1 font-medium text-right">${t('colMoles')}</th>
                              <th class="pb-1 font-medium text-right">${t('colMass')}</th>
                            </tr>
                          </thead>
                          <tbody id="sp-sol-body">${solidRowsStr}</tbody>
                        </table>
                      </div>`
                }
              </div>
            </div>
          </div>
        </details>

        <!-- Group 3: Electrolytes, Kinetics & Electrochemistry -->
        <details class="rounded-xl border border-theme bg-surface-alt group" data-ins-sec="electro" ${open3}>
          <summary class="px-3 py-2.5 cursor-pointer select-none flex items-center justify-between gap-2 text-[13px] font-bold uppercase tracking-wide text-muted hover:text-main">
            <span>⚡ ${t('groupElectroKinetics')}</span>
            <span class="text-[11px] font-mono text-emerald-400 shrink-0 whitespace-nowrap" id="live-sum-ph">pH ${item.isFrozenSolid ? '—' : ph === null ? '—' : ph.toFixed(2)}</span>
          </summary>
          <div class="px-3 pb-3 flex flex-col gap-2.5 border-t border-theme/40 pt-2">
            <div class="p-2.5 rounded-lg border border-theme bg-surface flex items-center justify-between gap-2">
              <span class="text-xs font-semibold text-muted">${t('metricPH')}</span>
              <div class="text-sm font-bold font-mono" id="live-ph">${item.isFrozenSolid ? '— ❄️' : ph === null ? '—' : ph.toFixed(2)}</div>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="p-2.5 rounded-lg border border-theme bg-surface">
                <div class="text-xs font-semibold text-muted">${t('metricIonicStrength')}</div>
                <div class="text-sm font-bold font-mono mt-0.5" id="live-ionic-str">I = ${electroMetrics.ionicStrengthM.toFixed(3)} M</div>
              </div>
              <div class="p-2.5 rounded-lg border border-theme bg-surface">
                <div class="text-xs font-semibold text-muted">${t('metricConductivity')}</div>
                <div class="text-sm font-bold font-mono mt-0.5 text-sky-400" id="live-cond-sigma">σ = ${electroMetrics.conductivityMSCm.toFixed(2)} mS/cm</div>
              </div>
              <div class="p-2.5 rounded-lg border border-theme bg-surface">
                <div class="text-xs font-semibold text-muted">${t('metricRxnRate')}</div>
                <div class="text-sm font-bold font-mono text-accent mt-0.5" id="live-rxn-rate">${vRate > 0 ? `${vRate.toFixed(4)} mol/L·s` : `${((item.lastTotalRateMolS || 0) * 1000).toFixed(2)} mmol/s`}</div>
              </div>
              <div class="p-2.5 rounded-lg border border-theme bg-surface">
                <div class="text-xs font-semibold text-muted">${t('metricConversionYield')}</div>
                <div class="text-sm font-bold font-mono text-emerald-400 mt-0.5" id="live-conv-yield">H = ${convStr}</div>
              </div>
            </div>
            ${(() => {
              const estM = estimateVesselEsterificationMetrics(item, liqL);
              if (!estM) return '';
              return `<div class="p-2 rounded-lg border border-sky-500/35 bg-sky-500/10 text-[11px] flex items-center justify-between gap-2 font-mono" id="live-ester-eq">
                <span class="text-muted">Ester (Kc=${estM.Kc.toFixed(2)})</span>
                <span><strong class="text-sky-400">H_lt = ${estM.yieldEqPct.toFixed(1)}%</strong> · H_tt = ${estM.yieldActualPct.toFixed(1)}%</span>
              </div>`;
            })()}
            ${
              redoxMetrics.hasElectroLink
                ? `<div class="p-2.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs flex flex-col gap-1" id="live-redox-card">
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-semibold text-muted">${t('metricRedoxEh')}</span>
                      <strong class="text-sm font-bold font-mono text-emerald-400" id="live-eh-mv">${redoxMetrics.ehMv !== null ? `${redoxMetrics.ehMv >= 0 ? '+' : ''}${redoxMetrics.ehMv.toFixed(1)} mV` : '—'}</strong>
                    </div>
                    ${
                      redoxMetrics.ePinV !== null
                        ? `<div class="flex items-center justify-between text-[11px]">
                             <span class="text-muted">${t('metricCellEmf')}${redoxMetrics.cellPairLabel ? ` (${redoxMetrics.cellPairLabel})` : ''}</span>
                             <strong class="text-sm font-bold font-mono text-amber-300" id="live-epin-v">${redoxMetrics.ePinV.toFixed(3)} V</strong>
                           </div>`
                        : ''
                    }
                  </div>`
                : ''
            }
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <div class="flex items-center justify-between mb-1.5">
                <h4 class="text-xs font-semibold text-muted">${t('liveChartTitle')}</h4>
              </div>
              <canvas id="vessel-mole-chart" width="320" height="115" class="w-full h-[115px] rounded-lg bg-surface-alt border border-theme"></canvas>
              <div id="chart-legend" class="flex flex-wrap gap-2 mt-1.5 text-[11px]"></div>
              ${renderExportActionsBarHtml({ idPrefix: 'mole', label: t('exportImageCsvLabel') })}
            </div>
            <div class="p-2.5 rounded-lg border border-theme bg-surface">
              <h4 class="text-xs font-semibold text-muted mb-1.5">${t('activeReactionsTitle')}</h4>
              <div id="active-rxn-box" class="space-y-1.5">
                ${
                  item.activeReactions.length === 0
                    ? `<p class="text-[11px] text-muted">${t('noActiveReaction')}</p>`
                    : item.activeReactions
                        .map(
                          (r, rIdx) => `
                      <div class="rxn-card-item px-2.5 py-2 rounded-lg border border-theme bg-surface-alt flex items-center justify-between gap-2 cursor-context-menu" data-ridx="${rIdx}">
                        <span class="text-xs font-mono font-bold text-accent truncate">${r.equation}</span>
                        <span class="text-[11px] font-mono text-muted shrink-0">${(r.rateMolS * 1000).toFixed(2)} mmol/s</span>
                      </div>
                    `
                        )
                        .join('')
                }
              </div>
            </div>
          </div>
        </details>`;
        })()}
      `;
  return topSection;
}

export function updateVesselLiveNumbers(panel, item, t) {

    const spec = APPARATUS[item.typeId];
    const liqL = computeLiquidVolumeL(item.moles, item.tempK);
    const liqMl = liqL * 1000;
    const iceMl = ((item.moles.H2O_s || 0) * SPECIES.H2O_s.molarMass) / CONSTANTS.ICE_DENSITY_G_ML;
    const ph = item.isFrozenSolid ? null : computePH(item.moles, liqL, item.tempK);
    const contentsG = computeContentsMassG(item.moles);
    const grossG = spec.tareMassG + contentsG;

    const phEl = panel.container.querySelector('#live-ph');
    const sumPhEl = panel.container.querySelector('#live-sum-ph');
    const sumTpEl = panel.container.querySelector('#live-sum-tp');
    const caoYieldEl = panel.container.querySelector('#live-cao-yield');
    if (caoYieldEl) {
      const cao = computeCaOOptimizationScore(item);
      if (cao) caoYieldEl.textContent = cao.yieldPct.toFixed(0);
    }
    const tempEl = panel.container.querySelector('#live-temp');
    const volEl = panel.container.querySelector('#live-vol');
    const massEl = panel.container.querySelector('#live-mass');
    const massGrossEl = panel.container.querySelector('#live-mass-gross');
    if (phEl) phEl.textContent = item.isFrozenSolid ? '— ❄️' : ph === null ? '—' : ph.toFixed(2);
    if (sumPhEl) sumPhEl.textContent = `pH ${item.isFrozenSolid ? '—' : ph === null ? '—' : ph.toFixed(2)}`;
    if (tempEl) tempEl.textContent = `${formatNumber(item.tempK, 1)} K (${formatNumber(kelvinToCelsius(item.tempK), 1)}°C)`;
    if (volEl) {
      volEl.textContent =
        iceMl > 0.05 && liqMl <= 0.05
          ? `❄️ ${formatNumber(iceMl, 2)} / ${formatNumber(spec.maxVolumeMl, 0)} mL`
          : iceMl > 0.05
          ? `${formatNumber(liqMl, 1)} + ❄️${formatNumber(iceMl, 1)} / ${formatNumber(spec.maxVolumeMl, 0)} mL`
          : `${formatNumber(liqMl, 2)} / ${formatNumber(spec.maxVolumeMl, 0)} mL`;
    }
    if (massEl) massEl.textContent = `${formatNumber(contentsG, 2)} g`;
    if (massGrossEl) massGrossEl.textContent = `${formatNumber(grossG, 2)} g`;

    const pm = computeVesselPressureMetrics(item, spec, panel.sim.environment);
    if (sumTpEl) sumTpEl.textContent = `${formatNumber(kelvinToCelsius(item.tempK), 1)}°C · ${pm.localPBar.toFixed(2)} bar`;
    const pLocEl = panel.container.querySelector('#live-press-local');
    const pAtmEl = panel.container.querySelector('#live-press-atm');
    const pLimEl = panel.container.querySelector('#live-press-limit');
    const pBarEl = panel.container.querySelector('#live-press-bar');
    if (pLocEl) pLocEl.textContent = `${pm.localPBar.toFixed(2)} bar`;
    if (pAtmEl) pAtmEl.textContent = `(${(pm.localPBar * 0.986923).toFixed(2)} atm)`;
    if (pLimEl) pLimEl.textContent = `${pm.deltaPBar >= 0 ? '+' : ''}${pm.deltaPBar.toFixed(2)} / +${pm.maxDeltaPBar.toFixed(2)} bar`;
    if (pBarEl) {
      pBarEl.style.width = `${pm.limitPct.toFixed(1)}%`;
      pBarEl.style.backgroundColor = pm.rawRatio >= 0.85 ? '#D62839' : pm.rawRatio >= 0.6 ? '#f59e0b' : '#38bdf8';
    }

    const dTdt = item.lastTempRateCS || 0;
    const dTempEl = panel.container.querySelector('#live-dtemp');
    if (dTempEl) {
      dTempEl.textContent = `${dTdt > 0.005 ? '+' : ''}${dTdt.toFixed(2)} °C/s`;
      dTempEl.className = `text-[11px] font-mono shrink-0 whitespace-nowrap ${Math.abs(dTdt) > 0.05 ? (dTdt > 0 ? 'text-orange-400' : 'text-sky-400') : 'text-muted'}`;
    }
    const qRelKJ = (item.cumulativeReactionHeatJ || 0) / 1000;
    const qEl = panel.container.querySelector('#live-cum-heat');
    const dhEl = panel.container.querySelector('#live-cum-dh');
    if (qEl) {
      qEl.textContent = `Q = ${qRelKJ.toFixed(2)} kJ`;
      qEl.className = `text-sm font-bold font-mono mt-0.5 ${qRelKJ > 0.005 ? 'text-orange-400' : qRelKJ < -0.005 ? 'text-sky-400' : ''}`;
    }
    if (dhEl) dhEl.innerHTML = `ΔH<sub>rxn</sub> ≈ ${(-qRelKJ).toFixed(2)} kJ`;

    const liqTabData = computeLiquidSpeciesTableData(item.moles, item.tempK);
    const rhoEl = panel.container.querySelector('#live-mix-density');
    if (rhoEl) rhoEl.textContent = `ρ = ${liqTabData.mixDensity > 0 ? liqTabData.mixDensity.toFixed(3) : '—'} g/mL`;

    const electroMetrics = computeVesselElectrochemicalMetrics(item, ph, liqL);
    const ionEl = panel.container.querySelector('#live-ionic-str');
    const sigEl = panel.container.querySelector('#live-cond-sigma');
    if (ionEl) ionEl.textContent = `I = ${electroMetrics.ionicStrengthM.toFixed(3)} M`;
    if (sigEl) sigEl.textContent = `σ = ${electroMetrics.conductivityMSCm.toFixed(2)} mS/cm`;
    const rateEl = panel.container.querySelector('#live-rxn-rate');
    if (rateEl) {
      const vRate = liqL > 1e-5 ? (item.lastTotalRateMolS || 0) / liqL : 0;
      rateEl.textContent = vRate > 0 ? `${vRate.toFixed(4)} mol/L·s` : `${((item.lastTotalRateMolS || 0) * 1000).toFixed(2)} mmol/s`;
    }
    const convEl = panel.container.querySelector('#live-conv-yield');
    if (convEl) {
      convEl.textContent = `H = ${item.conversionYieldPct !== null && item.conversionYieldPct !== undefined ? `${item.conversionYieldPct.toFixed(1)}%` : '—'}`;
    }
    const esterEl = panel.container.querySelector('#live-ester-eq');
    if (esterEl) {
      const estM = estimateVesselEsterificationMetrics(item, liqL);
      if (estM) {
        esterEl.innerHTML = `<span class="text-muted">Ester (Kc=${estM.Kc.toFixed(2)})</span><span><strong class="text-sky-400">H_lt = ${estM.yieldEqPct.toFixed(1)}%</strong> · H_tt = ${estM.yieldActualPct.toFixed(1)}%</span>`;
      }
    }
    const ehEl = panel.container.querySelector('#live-eh-mv');
    if (ehEl) {
      const redoxMetrics = computeVesselRedoxAndCellMetrics(item, panel.sim.items, liqL, ph);
      ehEl.textContent = redoxMetrics.ehMv !== null ? `${redoxMetrics.ehMv >= 0 ? '+' : ''}${redoxMetrics.ehMv.toFixed(1)} mV` : '—';
      const epEl = panel.container.querySelector('#live-epin-v');
      if (epEl && redoxMetrics.ePinV !== null) epEl.textContent = `${redoxMetrics.ePinV.toFixed(3)} V`;
    }

    const escEl = panel.container.querySelector('#live-escaped-gas');
    if (escEl) {
      escEl.innerHTML = buildEscapedGasVerticalHtml(item, panel.sim.environment, t);
    }
    const escTempEl = panel.container.querySelector('#live-escaped-gas-temp');
    if (escTempEl) {
      escTempEl.textContent = item.lastGasOutTempK
        ? `${t('gasOutTempTag')} ${kelvinToCelsius(item.lastGasOutTempK).toFixed(1)}°C`
        : '';
    }

    const tubeEl = panel.container.querySelector('#live-tube-stats');
    const tid = item.connectedTargetId || item.connectedSyringeId;
    if (tubeEl && tid) {
      const target = panel.sim.getItem(tid);
      if (target) {
        const g = computeTubingGeometry(item, target);
        const tMl = computeLiquidVolumeL(item.tubeMoles || {}, item.tubeTempK || item.tempK) * 1000;
        tubeEl.textContent = `${g.arcLengthCm.toFixed(1)} cm · ${Math.min(tMl, g.capacityMl).toFixed(2)}/${g.capacityMl.toFixed(2)} mL`;
      }
    }
    const depthPctEl = panel.container.querySelector('#live-tube-depth-pct');
    const depthSlider = panel.container.querySelector('#ins-tube-depth-slider');
    if (depthPctEl) depthPctEl.textContent = `${Math.round((item.tubeSubmersionRatio ?? 0.72) * 100)}%`;
    if (depthSlider && document.activeElement !== depthSlider) depthSlider.value = String(Math.round((item.tubeSubmersionRatio ?? 0.72) * 100));
    const sootPctEl = panel.container.querySelector('#live-soot-pct');
    if (sootPctEl) sootPctEl.textContent = `${Math.round((item.sootLevel || 0) * 100)}%`;

    const colEl = panel.container.querySelector('#live-collected-gas');
    const colCondEl = panel.container.querySelector('#live-collected-cond');
    if (colEl && item.connectedSyringeId) {
      const syr = panel.sim.getItem(item.connectedSyringeId);
      if (syr) {
        const syrCondInfo = getSyringeCondenseInfo(syr, panel.sim.environment, t);
        colEl.textContent = `${computeSyringeTotalVolumeMl(syr, panel.sim.environment).toFixed(2)} mL · ${syrCondInfo.syrTempC.toFixed(1)}°C`;
        if (colCondEl) {
          colCondEl.textContent =
            syrCondInfo.totalFluidMl > 0.0005 || syrCondInfo.isCondensing
              ? `${syrCondInfo.frozenMol > syrCondInfo.condensedMol ? '❄️' : '💧'} ${t(syrCondInfo.frozenMol > syrCondInfo.condensedMol ? 'syringeFrozenShort' : 'gasCondensedShort')}: ${syrCondInfo.totalFluidMl.toFixed(2)} mL ${syrCondInfo.condSpec}`
              : '';
        }
      }
    }

    const gasCompEl = panel.container.querySelector('#gas-comp-box');
    if (gasCompEl) {
      gasCompEl.innerHTML = buildVesselGasCompositionHtml(item, spec, panel.sim.environment, liqL, t);
    }

    const liqBodyEl = panel.container.querySelector('#sp-liq-body');
    if (liqBodyEl) {
      liqBodyEl.innerHTML = buildLiquidRowsHtml(liqTabData);
    }
    const solBodyEl = panel.container.querySelector('#sp-sol-body');
    if (solBodyEl) {
      solBodyEl.innerHTML = buildSolidRowsHtml(item, t);
    }
}
