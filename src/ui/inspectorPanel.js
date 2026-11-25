/**
 * Inspector Panel Orchestrator (Refactor 81).
 * Rendering helpers, vessel/tool cards & charts live in ./inspector/*.js
 */
import { APPARATUS, getStandGeometry } from '../data/apparatus.js';
import { CONSTANTS, formatNumber, kelvinToCelsius } from '../data/constants.js';
import { GAS_DISPLAY_META, isSolidMoltenAtTemp, SPECIES } from '../data/species.js';
import { computeLiquidVolumeL, computePH, computeVesselAroma } from '../engine/equilibrium.js';
import { COLORIMETER_WAVELENGTHS, stepAnalyticalInstruments } from '../engine/analyticalTools.js';
import { computeCaOOptimizationScore } from '../engine/chemistry.js';
import { soundEngine } from '../audio/soundEngine.js';
import { downloadCompositionXlsx } from '../storage/xlsxExport.js';
import {
  exportSpectrometerAsset,
  exportAnalyticalProbeAsset,
  exportVesselMoleChartAsset,
  exportTlcPlateAsset,
} from '../storage/reportExport.js';
import {
  SPECTRO_CHART_PAD,
  hasDisplayableSpeciesAmount,
  syncPrecisionControlLive,
  renderInspectorLogsAndCrossLabHtml,
  buildTelemetryCsvForItem,
} from './inspector/inspectorUtils.js';
import { renderToolOrEmptyBenchHtml, updateToolLiveNumbers } from './inspector/toolInspectors.js';
import { renderVesselInspectorHtml, updateVesselLiveNumbers } from './inspector/vesselInspector.js';
import {
  drawAnalyticalChartView,
  drawSpectroscopyScanChart,
  drawVesselMoleChart,
} from './inspector/inspectorCharts.js';

export class InspectorPanel {
  constructor(container, sim, getLang, callbacks) {
    this.container = container;
    this.sim = sim;
    this.getLang = getLang;
    this.callbacks = callbacks; // { onOpenTransfer, onNotify }
    this.lastStructureSig = '';
    this.lastLangCode = 'vi';
    this.isDark = true;
    this.logMode = 'student'; // 'student' | 'expert'
    this.sectionOpen = { thermo: true, phases: true, electro: true };
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
    const itemCount = this.sim.items.length;
    if (!item) return `none|${atmMode}|${labSig}|${itemCount}|${this.logMode}|${langCode}|${logLen}`;

    if (item.kind === 'vessel') {
      const spKeys = Object.keys(item.moles)
        .filter((k) => hasDisplayableSpeciesAmount(k, item.moles[k]))
        .sort()
        .join(',');
      const rxnKeys = item.activeReactions.map((r) => r.id).join(',');
      const hasFrost = (item.escapedFrostH2OMol || 0) > 1e-6 ? 1 : 0;
      const purgedFlag = (item.headspaceGasMoles?.H2_g || 0) > 1e-5 || (item.moles.CuO_s || 0) > 1e-7
        ? ((item.airO2PurgeFrac ?? 1) <= 0.14 ? 'P' : 'U')
        : 'N';
      const airFlags = `${(item.naTarnishFrac || 0) > 0.25 ? 1 : 0}${(item.kTarnishFrac || 0) > 0.25 ? 1 : 0}${(item.naohDeliquesceFrac || 0) > 0.15 ? 1 : 0}${(item.caCo3FilmFrac || 0) > 0.25 ? 1 : 0}${item.fePassivated ? 1 : 0}${item.alPassivated ? 1 : 0}${item.caso4Passivated ? 1 : 0}${(item.znCombustionTimer || 0) > 0.05 ? 1 : 0}${(item.mgCombustionTimer || 0) > 0.05 ? 1 : 0}${(item.alCombustionTimer || 0) > 0.05 ? 1 : 0}${purgedFlag}`;
      const aromaInfo = computeVesselAroma(item);
      const aromaKey = aromaInfo ? aromaInfo.kind : 'none';
      const phenFlags = `${item.isSupersaturated ? 1 : 0}${(item.znPassivationFrac || 0) > 0.35 ? 1 : 0}${(item.pickeringFoamMl || 0) > 0.5 ? 1 : 0}${(item.langmuirCoverage || 0) > 0.55 ? 1 : 0}${(item.soapFoamMl || 0) > 0.5 ? 1 : 0}${item.hasBoilingChips ? 1 : 0}${item.soapSoftPotassiumGel ? 1 : 0}${item.soapSaltedOutCake ? 1 : 0}${aromaKey}`;
      const cmpFlag = Array.isArray(this.sim.compareVesselIds) && this.sim.compareVesselIds.includes(item.id) ? 1 : 0;
      const softenFlag = (item.softenGlowFrac || 0) > 0.1 || (item.softenSagFrac || 0) > 0.05 ? 1 : 0;
      const sootFlag = (item.sootLevel || 0) > 0.05 ? 1 : 0;
      const mirrorFlag = (item.silverMirrorLevel || 0) > 0.04 ? 1 : 0;
      const resFlag = ((item.wallResidueMap?.CuO_s || 0) > 0.05 || (item.wallResidueMap?.BaSO4_s || 0) > 0.05) ? 1 : 0;
      const escSig = GAS_DISPLAY_META.filter((g) => (item.escapedGasMoles?.[g.id] || 0) > 1e-7).map((g) => g.id).join(',');
      const hasElec = this.sim.items.some(
        (x) =>
          (x.kind === 'electrode' && x.dockedVesselId === item.id) ||
          (x.kind === 'salt_bridge' && !x.isBroken && (x.vesselAId === item.id || x.vesselBId === item.id))
      )
        ? 1
        : 0;
      const caoScore = computeCaOOptimizationScore(item);
      const caoSig = caoScore
        ? `${caoScore.points}:${caoScore.groundFine ? 1 : 0}${caoScore.ventedWhileHeating ? 1 : 0}${caoScore.roaringBlueZone ? 1 : 0}${caoScore.cooledProtected ? 1 : 0}`
        : 'n';
      return `v|${item.hideComposition ? 1 : 0}|${item.blindLabel || ''}|${atmMode}|${labSig}|${airFlags}|${item.id}|${item.isStoppered}|${item.lidState || 'open'}|${cmpFlag}|${softenFlag}|${sootFlag}|${mirrorFlag}|${resFlag}|${escSig}|${hasElec}|${caoSig}|${item.isInverted ? 1 : 0}|${item.hasStirBar ? 1 : 0}|${item.magStirRpm || 0}|${item.isFrozenSolid ? 1 : 0}|${hasFrost}|${phenFlags}|${item.connectedTargetId || item.connectedSyringeId}|${item.isShattered}|${item.clampedToId}|${standCount}|${spKeys}|${rxnKeys}|${this.logMode}|${langCode}|${logLen}`;
    }
    if (item.kind === 'bath') {
      const nestedCnt = this.sim.items.filter((i) => i.submergedInBathId === item.id).length;
      return `bath|${item.id}|${item.isBroken ? 1 : 0}|${item.bathTargetC ?? 0}|${item.bathMode || 'ice'}|${nestedCnt}|${langCode}|${logLen}`;
    }
    if (item.kind === 'thermometer') {
      return `therm|${item.id}|${item.isBroken ? 1 : 0}|${item.contactKind || ''}|${item.contactLabel || ''}|${langCode}|${logLen}`;
    }

    if (item.kind === 'burner') {
      return `b|${item.id}|${item.typeId}|${item.airHoleOpen !== false ? 1 : 0}|${langCode}|${logLen}`;
    }
    if (item.kind === 'pipette') {
      const spKeys = Object.keys(item.moles || {}).filter((k) => hasDisplayableSpeciesAmount(k, item.moles[k])).sort().join(',');
      return `p|${item.hideComposition ? 1 : 0}|${item.blindLabel || ''}|${item.id}|${item.isBroken}|${spKeys}|${langCode}|${logLen}`;
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
      const spKeys = Object.keys(item.moles || {}).filter((k) => hasDisplayableSpeciesAmount(k, item.moles[k])).sort().join(',');
      return `${item.kind}|${item.id}|${item.isBroken ? 1 : 0}|${item.clampedToId}|${item.isFiltering ? 1 : 0}|${item.uvMaskHalf ? 1 : 0}|${spKeys}|${this.logMode}|${langCode}|${logLen}`;
    }
    if (item.kind === 'separatory_funnel') {
      const spKeys = Object.keys(item.moles || {}).filter((k) => hasDisplayableSpeciesAmount(k, item.moles[k])).sort().join(',');
      const vCnt = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isInverted).length;
      return `sep|${item.id}|${item.isBroken ? 1 : 0}|${item.clampedToId || ''}|${item.mountedOnVesselId || ''}|${item.valveOpen ? 1 : 0}|${item.isStoppered !== false ? 1 : 0}|${item.stopAtInterface !== false ? 1 : 0}|${(item.emulsionTimer || 0) > 0.2 ? 1 : 0}|${vCnt}|${spKeys}|${this.logMode}|${langCode}|${logLen}`;
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
      return `el|${item.id}|${item.material}|${item.dockedVesselId || ''}|${item.polarityLabel || ''}|${item.platedMaterial || ''}|${item.platedQuality || ''}|${hasAg}|${item.cathodicProtectedActive ? 1 : 0}|${item.passivatedActive ? 1 : 0}|${item.galvanicDominantActive ? 1 : 0}|${item.gasTargetId || ''}|${mountedTube?.id || ''}|${colCnt}|${langCode}|${logLen}`;
    }
    if (item.kind === 'splint') {
      return `sp|${item.id}|${item.flippedX ? 1 : 0}|${item.mode}|${langCode}|${logLen}`;
    }
    if (item.kind === 'condenser') {
      const vCnt = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered).length;
      return `co|${item.id}|${item.flippedX ? 1 : 0}|${item.isBroken ? 1 : 0}|${item.waterFlowOn ? 1 : 0}|${item.refluxMode ? 1 : 0}|${item.refluxVesselId || ''}|${item.clampedToId}|${item.connectedFromId || ''}|${item.outletTargetId || ''}|${vCnt}|${langCode}|${logLen}`;
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
    if (item.kind === 'boiling_chips') {
      const vCnt = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isStoppered).length;
      return `bchip|${item.id}|${item.inVesselId || ''}|${vCnt}|${langCode}|${logLen}`;
    }
    if (item.kind === 'salt_bridge') {
      return `sbr|${item.id}|${item.isBroken ? 1 : 0}|${item.electrolyteId || 'KNO3'}|${item.fouledWarningKey || ''}|${item.vesselAId || ''}|${item.vesselBId || ''}|${langCode}|${logLen}`;
    }
    if (item.kind === 'spoon') {
      const spEntries = Object.entries(item.moles || {}).filter(([k, n]) => hasDisplayableSpeciesAmount(k, n));
      const spKeys = spEntries.map(([k]) => `${k}:${item.groundPowderMap?.[k] ? 1 : 0}`).sort().join(',');
      const vCnt = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered).length;
      return `spn|${item.id}|${item.flippedX ? 1 : 0}|${spKeys}|${vCnt}|${this.logMode}|${langCode}|${logLen}`;
    }
    if (item.kind === 'bath') {
      return `bath|${item.id}|${item.isBroken ? 1 : 0}|${item.bathMode || 'ice'}|${langCode}|${logLen}`;
    }
    if (item.kind === 'colorimeter') {
      return `col|${item.id}|${item.spectroMode || 'uvvis_kinetics'}|${item.irSubtractWater !== false ? 1 : 0}|${item.wavelengthNm || 525}|${item.contactVesselId || ''}|${item.clampedToId || ''}|${standCount}|${langCode}|${logLen}`;
    }
    if (item.kind === 'ph_conductometer') {
      return `phc|${item.id}|${item.clampedToId || ''}|${standCount}|${langCode}|${logLen}`;
    }
    if (item.kind === 'tlc_plate') {
      const spIds = (item.spots || []).map((s) => s.id).join(',');
      return `tlc|${item.id}|${item.clampedToId || ''}|${spIds}|${standCount}|${langCode}|${logLen}`;
    }
    return `other|${item.id}|${langCode}|${logLen}`;
  }

  update(langCode, force = false) {
    if (langCode) this.lastLangCode = langCode;
    const activeLang = this.lastLangCode || 'vi';
    const t = this.getLang();
    const sig = this.getStructureSignature(t, activeLang);
    if (force || sig !== this.lastStructureSig) {
      this.lastStructureSig = sig;
      this.renderFull(t, activeLang);
    } else {
      this.updateLiveNumbers(t);
    }
    this.drawChart();
  }

  renderFull(t, langCode) {
    const item = this.sim.getItem(this.sim.selectedId);
    const topSection =
      item && item.kind === 'vessel'
        ? renderVesselInspectorHtml(this, item, t, langCode)
        : renderToolOrEmptyBenchHtml(this, item, t, langCode);
    const logsAndCrossLabHtml = renderInspectorLogsAndCrossLabHtml(this, item, langCode, t);
    this.container.innerHTML = `<div class="flex flex-col gap-3">${topSection}${logsAndCrossLabHtml}</div>`;
    this.bindInspectorEvents(item, t);
  }

  buildTelemetryCsv(item) {
    return buildTelemetryCsvForItem(this.sim, item);
  }

  bindInspectorEvents(item, t) {
    this.container.querySelectorAll('details[data-ins-sec]').forEach((det) => {
      det.addEventListener('toggle', () => {
        const key = det.dataset.insSec;
        if (key) this.sectionOpen[key] = det.open;
      });
    });

    this.container.querySelector('#btn-log-student')?.addEventListener('click', () => {
      this.logMode = 'student';
      this.update(document.documentElement.lang || 'vi', true);
    });
    this.container.querySelector('#btn-log-expert')?.addEventListener('click', () => {
      this.logMode = 'expert';
      this.update(document.documentElement.lang || 'vi', true);
    });
    this.container.querySelector('#btn-export-csv')?.addEventListener('click', () => {
      const csv = this.buildTelemetryCsv(item);
      const filename = `chemlab_${item?.label?.replace(/[^a-zA-Z0-9_-]/g, '') || 'bench'}_${Date.now()}.csv`;
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.callbacks.onNotify?.(t('logCsvExportedToast').replace('{filename}', filename));
    });
    this.container.querySelector('#btn-copy-data')?.addEventListener('click', async () => {
      const csv = this.buildTelemetryCsv(item);
      try {
        await navigator.clipboard?.writeText(csv);
        this.callbacks.onNotify?.(t('logCopiedToast'));
      } catch {
        this.callbacks.onNotify?.(t('logCopiedToast'));
      }
    });

    if (!item) return;

    this.container.querySelectorAll('.exp-act-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const prefix = btn.dataset.expPrefix;
        const fmt = btn.dataset.expFmt || 'png';
        const labsMeta = this.callbacks.getLabsMeta?.();
        const activeLab = labsMeta?.labs?.[labsMeta.activeIndex];
        const labTitle = activeLab?.customName || `Lab ${activeLab?.number || 1}`;
        const lang = this.lastLangCode || 'vi';
        if (prefix === 'mole' && item.kind === 'vessel') {
          exportVesselMoleChartAsset({ format: fmt, vessel: item, t, lang, labName: labTitle });
        } else if (prefix === 'probe' && item.kind === 'ph_conductometer') {
          exportAnalyticalProbeAsset({ format: fmt, item, t, lang, labName: labTitle });
        } else if (prefix === 'spectro' && item.kind === 'colorimeter') {
          if ((item.spectroMode || 'uvvis_kinetics') === 'uvvis_kinetics') {
            exportAnalyticalProbeAsset({ format: fmt, item, t, lang, labName: labTitle });
          } else {
            const contactV = item.contactVesselId ? this.sim.getItem(item.contactVesselId) : null;
            exportSpectrometerAsset({ format: fmt, item, vessel: contactV, t, lang, labName: labTitle });
          }
        } else if (prefix === 'tlc' && item.kind === 'tlc_plate') {
          exportTlcPlateAsset({ format: fmt, plate: item, uvLight: Boolean(this.sim.environment?.uvLight), t, lang, labName: labTitle });
        }
      });
    });

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
    } else if (item.kind === 'bath') {
      this.container.querySelectorAll('.bath-step-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          soundEngine.playUiClick();
          this.sim.setBathTargetTempC(item.id, Number(btn.dataset.tempc));
        });
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
      const syncPipLive = (dose) =>
        syncPrecisionControlLive(this.container, {
          sliderId: 'ins-pip-dose-slider',
          readoutId: 'live-pip-dose',
          btnClass: 'pip-dose-btn',
          dataAttr: 'dose',
          activeVal: dose,
          valueText: `${dose.toFixed(2)} mL`,
          sliderValue: dose,
        });
      this.container.querySelector('#ins-pip-dose-slider')?.addEventListener('input', (e) => {
        const val = Number(e.target.value);
        this.sim.setPipetteDropDose(item.id, val);
        syncPipLive(item.dropDoseMl || val);
      });
      this.container.querySelectorAll('.pip-dose-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const val = Number(btn.dataset.dose);
          this.sim.setPipetteDropDose(item.id, val);
          syncPipLive(item.dropDoseMl || val);
        });
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
        const vessels = this.sim.items.filter((i) => !i.isShattered && !i.isBroken && (i.kind === 'vessel' || i.kind === 'filter_funnel' || i.kind === 'separatory_funnel' || i.kind === 'burette'));
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
      this.container.querySelector('#ins-sticky-label')?.addEventListener('click', () => {
        this.callbacks.onEditStickyLabel?.(item);
      });
      this.container.querySelector('#ins-store-cabinet')?.addEventListener('click', () => {
        this.callbacks.onStoreToCabinet?.(item.id);
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
      this.container.querySelector('#ins-v-sb-slider')?.addEventListener('input', (e) => {
        this.sim.toggleMagneticStir(item.id, Number(e.target.value));
      });
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
      this.container.querySelector('#ins-tube-depth-slider')?.addEventListener('input', (e) => {
        this.sim.setTubeSubmersionRatio(item.id, Number(e.target.value) / 100);
      });
      this.container.querySelector('#btn-export-xlsx')?.addEventListener('click', () => {
        const liqL = computeLiquidVolumeL(item.moles, item.tempK);
        const ph = item.isFrozenSolid ? null : computePH(item.moles, liqL, item.tempK);
        const labsMeta = this.callbacks.getLabsMeta?.();
        const activeLab = labsMeta?.labs?.[labsMeta.activeIndex];
        const labTitle = activeLab?.customName || `Lab ${activeLab?.number || 1}`;
        const rowsData = Object.entries(item.moles || {})
          .filter(([spId, n]) => hasDisplayableSpeciesAmount(spId, n))
          .sort((a, b) => b[1] - a[1])
          .map(([spId, n]) => {
            const sp = SPECIES[spId];
            const isMolten = isSolidMoltenAtTemp(sp, item.tempK, item.moles);
            const isFrozenSolidSp = spId === 'H2O_s' || (Boolean(item.isFrozenSolid) && sp.phase === 's');
            const concLabel = isMolten
              ? t('moltenStateTag')
              : isFrozenSolidSp
              ? t('frozenSolidTag')
              : sp.phase === 'aq' && liqL > 1e-6
              ? `${(n / liqL).toFixed(3)} M`
              : sp.phase;
            return {
              id: spId,
              formula: sp?.formula || spId,
              phase: sp?.phase || '',
              mol: n,
              massG: n * (sp?.molarMass || 0),
              concLabel,
            };
          });
        const res = downloadCompositionXlsx({
          labName: labTitle,
          vesselLabel: item.label,
          tempK: item.tempK,
          ph,
          pressureBar: item.internalPressureBar,
          rowsData,
        });
        this.callbacks.onNotify?.(t('exportXlsxSuccess').replace('{filename}', res.filename));
      });
      this.container.querySelectorAll('.rxn-card-item').forEach((card) => {
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const r = item.activeReactions?.[Number(card.dataset.ridx)];
          if (!r) return;
          document.getElementById('rxn-ctx-popover')?.remove();
          const menu = document.createElement('div');
          menu.id = 'rxn-ctx-popover';
          menu.className = 'chemlab-context-menu';
          menu.style.left = `${Math.min(window.innerWidth - 180, e.clientX)}px`;
          menu.style.top = `${Math.min(window.innerHeight - 60, e.clientY)}px`;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'chemlab-ctx-item';
          btn.innerHTML = `<span>ℹ️ ${t('rxnCtxInfo')}</span>`;
          btn.addEventListener('click', () => {
            menu.remove();
            const langCode = document.documentElement.lang || 'vi';
            const title = t('rxnInfoTitle');
            const nameStr = langCode === 'en' ? (r.nameEn || r.nameVi) : (r.nameVi || r.nameEn);
            const descStr = langCode === 'en' ? (r.descEn || r.descVi || '') : (r.descVi || r.descEn || '');
            this.callbacks.onShowReactionInfo?.({ ...r, title, nameStr, descStr });
          });
          menu.appendChild(btn);
          document.body.appendChild(menu);
          const closeMenu = (ev) => {
            if (ev && ev.target instanceof Node && menu.contains(ev.target)) return;
            menu.remove();
            window.removeEventListener('pointerdown', closeMenu, { capture: true });
            window.removeEventListener('keydown', onEsc);
          };
          const onEsc = (ev) => {
            if (ev.key === 'Escape') closeMenu();
          };
          window.addEventListener('pointerdown', closeMenu, { capture: true });
          window.addEventListener('keydown', onEsc);
        });
      });
    } else if (item.kind === 'filter_funnel' || item.kind === 'separatory_funnel' || item.kind === 'condenser' || item.kind === 'burette') {
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
      this.container.querySelector('#ins-cond-reflux')?.addEventListener('click', () => {
        soundEngine.playClampClick();
        this.sim.toggleCondenserReflux(item.id);
      });
      this.container.querySelector('#ins-sep-stopper')?.addEventListener('click', () => {
        soundEngine.playStopperPop(item.isStoppered !== false);
        this.sim.toggleSeparatoryStopper(item.id);
      });
      this.container.querySelector('#ins-sep-valve')?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.sim.toggleSeparatoryValve(item.id);
      });
      const syncSepLive = (rateMlS) =>
        syncPrecisionControlLive(this.container, {
          sliderId: 'ins-sep-flow-slider',
          readoutId: 'live-sep-rate',
          btnClass: 'sep-rate-btn',
          dataAttr: 'rate',
          activeVal: rateMlS,
          valueText: `${rateMlS.toFixed(2)} mL/s`,
          sliderValue: rateMlS,
        });
      this.container.querySelector('#ins-sep-flow-slider')?.addEventListener('input', (e) => {
        const val = Number(e.target.value);
        this.sim.setSeparatoryValveRateMlS(item.id, val);
        syncSepLive(item.valveRateMlS ?? val);
      });
      this.container.querySelectorAll('.sep-rate-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const val = Number(btn.dataset.rate);
          this.sim.setSeparatoryValveRateMlS(item.id, val);
          syncSepLive(item.valveRateMlS ?? val);
        });
      });
      this.container.querySelector('#ins-sep-auto-stop')?.addEventListener('change', (e) => {
        item.stopAtInterface = Boolean(e.target.checked);
        this.sim.emitChange();
      });
      this.container.querySelector('#ins-sep-shake')?.addEventListener('click', () => {
        soundEngine.playStirSwirl();
        this.sim.shakeSeparatoryFunnel(item.id);
      });
      this.container.querySelector('#ins-sep-mount-pick')?.addEventListener('click', () => {
        const vs = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isInverted);
        if (vs.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: vs.map((v) => v.id),
          promptText: `${t('sepMountLabel')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.mountSeparatoryFunnel(item.id, picked.id),
        });
      });
      this.container.querySelector('#ins-sep-unmount')?.addEventListener('click', () => {
        this.sim.mountSeparatoryFunnel(item.id, null);
      });
      this.container.querySelector('#ins-sep-fill')?.addEventListener('click', () => {
        const regId = this.container.querySelector('#sep-fill-sel')?.value;
        if (regId) {
          this.sim.addReagentToVessel(item.id, regId, 25, { silentAnim: true });
          this.sim.emitChange();
        }
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
        const dsts = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && i.id !== item.connectedFromId);
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
      this.container.querySelector('#ins-tube-depth-slider')?.addEventListener('input', (e) => {
        this.sim.setTubeSubmersionRatio(item.id, Number(e.target.value) / 100);
      });
      const closedWord = this.lastLangCode === 'en' ? 'Closed' : 'Đóng';
      const syncBurLive = (rateMlS) =>
        syncPrecisionControlLive(this.container, {
          sliderId: 'ins-bur-rate-slider',
          readoutId: 'live-bur-rate',
          btnClass: 'bur-rate-btn',
          dataAttr: 'rate',
          activeVal: rateMlS,
          valueText: rateMlS <= 0.001 ? `0.00 mL/s (${closedWord})` : `${rateMlS.toFixed(2)} mL/s`,
          sliderValue: Math.max(0.05, rateMlS || 0.05),
        });
      this.container.querySelector('#ins-bur-rate-slider')?.addEventListener('input', (e) => {
        const val = Number(e.target.value);
        this.sim.setBuretteValveRate(item.id, val);
        syncBurLive(item.valveRateMlS ?? val);
      });
      this.container.querySelectorAll('.bur-rate-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const val = Number(btn.dataset.rate);
          this.sim.setBuretteValveRate(item.id, val);
          syncBurLive(item.valveRateMlS ?? val);
        });
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
    } else if (item.kind === 'ph_conductometer' || item.kind === 'colorimeter' || item.kind === 'tlc_plate') {
      const bindProbeClamp = () => {
        this.container.querySelector('#ins-toggle-clamp')?.addEventListener('click', () => {
          soundEngine.playClampClick();
          if (item.clampedToId) {
            this.sim.detachFromStand(item.id);
          } else {
            const stands = this.sim.items.filter((i) => i.kind === 'stand');
            if (stands.length > 0) {
              const nearest = stands.reduce((best, s) =>
                Math.abs(s.x - item.x) < Math.abs(best.x - item.x) ? s : best
              );
              if (Math.abs(item.x - nearest.x) > 125) {
                item.x = getStandGeometry(nearest).clampTargetX(item.kind);
              }
              this.sim.attachToStand(item.id, nearest.id);
            }
          }
        });
      };
      bindProbeClamp();
      if (item.kind === 'ph_conductometer') {
        this.drawAnalyticalChart(item);
        this.container.querySelector('#ins-phc-reset')?.addEventListener('click', () => {
          item.history = [];
          this.sim.emitChange();
        });
      } else if (item.kind === 'colorimeter') {
        this._spectroHoverFrac = null;
        this.drawAnalyticalChart(item);
        this.container.querySelectorAll('.col-mode-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            item.spectroMode = btn.dataset.specMode || 'uvvis_kinetics';
            this._spectroHoverFrac = null;
            stepAnalyticalInstruments(this.sim, item, 0.05);
            this.sim.emitChange();
          });
        });
        this.container.querySelector('#ins-col-ir-sub')?.addEventListener('click', () => {
          item.irSubtractWater = !(item.irSubtractWater !== false);
          this.sim.emitChange();
        });
        this.container.querySelectorAll('.col-wl-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            item.wavelengthNm = Number(btn.dataset.wl) || 525;
            item.history = [];
            stepAnalyticalInstruments(this.sim, item, 0.05);
            this.sim.emitChange();
          });
        });
        this.container.querySelector('#ins-col-reset')?.addEventListener('click', () => {
          item.history = [];
          this.sim.emitChange();
        });
        const specCanvas = this.container.querySelector('#analytical-chart');
        if (specCanvas) {
          const onHoverMove = (ev) => {
            const rect = specCanvas.getBoundingClientRect();
            if (!rect.width) return;
            const canvasX = ((ev.clientX - rect.left) / rect.width) * specCanvas.width;
            const plotW = Math.max(20, specCanvas.width - SPECTRO_CHART_PAD.L - SPECTRO_CHART_PAD.R);
            const frac = Math.max(0, Math.min(1, (canvasX - SPECTRO_CHART_PAD.L) / plotW));
            this._spectroHoverFrac = frac;
            this.drawAnalyticalChart(item);
          };
          specCanvas.addEventListener('pointermove', onHoverMove);
          specCanvas.addEventListener('mousemove', onHoverMove);
          specCanvas.addEventListener('mouseleave', () => {
            this._spectroHoverFrac = null;
            this.drawAnalyticalChart(item);
          });
        }
      } else if (item.kind === 'tlc_plate') {
        this.container.querySelector('#ins-tlc-reset')?.addEventListener('click', () => {
          item.solventFront = 0;
          item.spots = [];
          this.sim.emitChange();
        });
      }
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
      this.container.querySelector('#ins-el-she-ph2')?.addEventListener('input', (e) => {
        this.sim.setElectrodeShePressure(item.id, Number(e.target.value));
      });
      this.container.querySelector('#ins-el-refresh')?.addEventListener('click', () => {
        soundEngine.playUiClick();
        this.sim.refreshElectrodeRod(item.id);
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
      this.container.querySelector('#ins-tube-depth-slider')?.addEventListener('input', (e) => {
        this.sim.setTubeSubmersionRatio(item.id, Number(e.target.value) / 100);
      });
    } else if (item.kind === 'stir_bar') {
      this.container.querySelector('#ins-sb-rpm-slider')?.addEventListener('input', (e) => {
        if (item.inVesselId) this.sim.toggleMagneticStir(item.inVesselId, Number(e.target.value));
      });
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
    } else if (item.kind === 'boiling_chips') {
      this.container.querySelector('#ins-bc-pick-insert')?.addEventListener('click', () => {
        const vs = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered && !i.isStoppered);
        if (vs.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: vs.map((v) => v.id),
          promptText: `${t('boilingChipsInsert')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.insertBoilingChipsIntoVessel(item.id, picked.id),
        });
      });
      this.container.querySelector('#ins-bc-remove')?.addEventListener('click', () => {
        this.sim.removeBoilingChipsFromVessel(item.id);
      });
    } else if (item.kind === 'salt_bridge') {
      this.container.querySelectorAll('.sb-elec-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          soundEngine.playUiClick();
          this.sim.setSaltBridgeElectrolyte(item.id, btn.dataset.sbElec);
        });
      });
      this.container.querySelector('#ins-sb-fill-vessel')?.addEventListener('click', () => {
        const vs = this.sim.items.filter(
          (v) => v.kind === 'vessel' && !v.isShattered && Object.entries(v.moles || {}).some(([id, n]) => n > 1e-6 && SPECIES[id]?.phase === 'aq')
        );
        if (vs.length === 0) return;
        this.callbacks.onStartBenchPick?.({
          candidateIds: vs.map((v) => v.id),
          promptText: `${t('saltBridgeFillFromVesselBtn')} — ${t('pickBenchPrompt')}`,
          onPick: (picked) => this.sim.fillSaltBridgeFromVessel(item.id, picked.id),
        });
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
      this.container.querySelector('#ins-stopper-dual')?.addEventListener('click', () => {
        this.sim.setStopperMode(item.id, 'dual_hole');
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
    if (item && item.kind === 'vessel') {
      updateVesselLiveNumbers(this, item, t);
    } else {
      updateToolLiveNumbers(this, item, t);
    }
  }

  drawAnalyticalChart(item) {
    drawAnalyticalChartView(this, item);
  }

  _drawSpectroscopyScanChart(canvas, ctx, item) {
    drawSpectroscopyScanChart(this, canvas, ctx, item);
  }

  drawChart() {
    const item = this.sim.getItem(this.sim.selectedId);
    if (item?.hideComposition) return;
    drawVesselMoleChart(this);
  }
}
