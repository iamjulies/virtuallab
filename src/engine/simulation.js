import { CONSTANTS, waterBoilingPointK } from '../data/constants.js';
import {
  ALL_GAS_IDS,
  createZeroGasMap,
  SPECIES,
  STARTER_REAGENTS,
} from '../data/species.js';
import { APPARATUS, clampItemToStandY, getStandGeometry, getSyringeGeometry } from '../data/apparatus.js';
import {
  calcSolidTransferRatio,
  computeContentsMassG,
  computeLiquidVolumeL,
  computePH,
  computePhenolphthaleinBleachEq,
  computeSolidSuspensionFactor,
  computeSolidVolumeMl,
  computeSolutionVisuals,
} from './equilibrium.js';
import { enforceDryPhaseBoundary, stepVesselChemistry } from './chemistry.js';
import { ELECTRODE_MATERIALS, stepElectrochemistry } from './electrochemistry.js';
import {
  computeWashBottleStreamArc,
  grindMortarSolids,
  stepApparatusTools,
  syncDockedToolPositions,
} from './apparatusTools.js';
import { computeHeatCapacityJK, computeSteamOpacity, stepVesselThermodynamics } from './thermodynamics.js';
import {
  ALL_GASES,
  NON_STEAM_GASES,
  buildCombinedSyringeLiquidMoles,
  buildCombinedSyringeTotalMoles,
  computeSyringeDischargeArc,
  computeSyringeFrozenVolumeMl,
  computeSyringeGasVolumeMl,
  computeSyringeHeatCapacityJK,
  computeSyringeLiquidVolumeMl,
  computeSyringeTotalVolumeMl,
  computeTubingGeometry,
  getSyringeNozzlePos,
  stepOpenGasBuoyancy,
  stepSyringeThermodynamics,
  stepVesselGasAndPressure,
} from './gasNetwork.js';

const SIM_BENCH_FLOOR_Y = 482;
const createEmptyGasMap = createZeroGasMap;

function getVesselBrimVolumeMl(spec) {
  return spec.geometry ? spec.geometry.maxVolumeMl * 0.96 : spec.maxVolumeMl * 1.15;
}

/**
 * Shared stoichiometric fraction transfer of liquid/aqueous species (and optionally suspended precipitate).
 */
function moveFluidFraction(srcMoles, srcSettleMap, fracRemove, dstMoles = null, includeSuspendedPpt = true) {
  let movedHeatCapJK = 0;
  let movedPhenMol = 0;
  for (const [spId, n] of Object.entries(srcMoles)) {
    if (n <= 0) continue;
    const sp = SPECIES[spId];
    if (!sp) continue;
    const isLiquid = sp.phase === 'l' || sp.phase === 'aq';
    const isSuspended = includeSuspendedPpt && sp.isPrecipitate && (srcSettleMap?.[spId] ?? 0.5) < 0.7;
    if (!isLiquid && !isSuspended) continue;

    const factor = isSuspended && srcSettleMap ? 0.25 : 1.0;
    const moveMol = n * Math.min(1, fracRemove * factor);
    if (moveMol <= 0) continue;
    srcMoles[spId] = n - moveMol;
    if (srcMoles[spId] < 1e-13) delete srcMoles[spId];
    if (dstMoles) {
      dstMoles[spId] = (dstMoles[spId] || 0) + moveMol;
    }
    if (spId === 'Phenolphthalein_aq') movedPhenMol += moveMol;
    movedHeatCapJK += moveMol * Math.max(0, sp.cp || 0);
  }
  return { movedHeatCapJK, movedPhenMol };
}

/**
 * Shared stoichiometric fraction transfer from a Gas Syringe's liquid reservoir (condensed H2O + overflowed solution).
 */
function extractSyringeLiquidFraction(syringe, frac, dstMoles = null) {
  const f = Math.max(0, Math.min(1, frac));
  if (f <= 0) return { movedHeatCapJK: 0, movedPhenMol: 0 };

  let movedHeatCapJK = 0;
  let movedPhenMol = 0;

  if ((syringe.condensedWaterMol || 0) > 1e-12) {
    const moveW = syringe.condensedWaterMol * f;
    syringe.condensedWaterMol = Math.max(0, syringe.condensedWaterMol - moveW);
    if (syringe.condensedWaterMol < 1e-13) syringe.condensedWaterMol = 0;
    if (dstMoles) {
      dstMoles.H2O_l = (dstMoles.H2O_l || 0) + moveW;
    }
    movedHeatCapJK += moveW * CONSTANTS.CP_H2O_J_MOL_K;
  }

  if ((syringe.condensedEtOHMol || 0) > 1e-12) {
    const moveE = syringe.condensedEtOHMol * f;
    syringe.condensedEtOHMol = Math.max(0, syringe.condensedEtOHMol - moveE);
    if (syringe.condensedEtOHMol < 1e-13) syringe.condensedEtOHMol = 0;
    if (dstMoles) {
      dstMoles.C2H5OH_l = (dstMoles.C2H5OH_l || 0) + moveE;
    }
    movedHeatCapJK += moveE * (SPECIES.C2H5OH_l?.cp || 112.3);
  }

  if (syringe.overflowMoles) {
    const res = moveFluidFraction(syringe.overflowMoles, null, f, dstMoles, true);
    movedHeatCapJK += res.movedHeatCapJK;
    movedPhenMol += res.movedPhenMol;
  }
  return { movedHeatCapJK, movedPhenMol };
}

export class LabSimulation {
  constructor() {
    this.timeSec = 0;
    this.nextId = 1;
    this.environment = {
      tempK: CONSTANTS.T_STD_K,     // 298.15 K
      pressureBar: CONSTANTS.P_STD_BAR, // 1.00 bar
      speed: 1.0,
      paused: false,
      uvLight: false,
    };
    this.items = [];
    this.selectedId = null;
    this.logs = [];
    this.pipette = {
      capacityMl: 10.0,
      volumeMl: 0,
      moles: {},
      tempK: CONSTANTS.T_STD_K,
      sourceLabel: '',
    };
    this.activePourStream = null; // { fromX, fromY, toX, toY, color, timer, rateMlS, pouredMl }
    this.activeReagentTransfer = null; // { reagentId, vesselId, isSolid, startMs, durationMs, dose, color, speciesId, fine }
    this.timedTransfers = []; // Timed progressive reagent / vessel pouring jobs
    this.listeners = new Set();
    this.sampleAccum = 0;
    this.visualHooks = {
      onParticlesNeeded: null,
      onAlert: null,
      onReagentDispense: null,
    };
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emitChange() {
    for (const fn of this.listeners) fn(this);
  }

  addLog(entry) {
    this.logs.unshift({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timeSec: this.timeSec,
      ...entry,
    });
    if (this.logs.length > 60) this.logs.length = 60;
  }

  getItem(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  createApparatus(typeId, x = 280, y = 380) {
    const spec = APPARATUS[typeId];
    if (!spec) return null;
    const id = `${typeId}_${this.nextId++}`;
    const base = {
      id,
      typeId,
      kind: spec.kind,
      label: `#${this.nextId - 1}`,
      x,
      y,
      vy: 0,
      isDragging: false,
      fallStartY: y,
      landingTilt: 0,
      landingTiltVel: 0,
      restingOnId: null,
      clampedToId: null,
      flippedX: false,
    };

    if (spec.kind === 'vessel') {
      Object.assign(base, {
        moles: {},
        particleCounts: {},
        groundPowderMap: {},
        flattenedMetalMap: {},
        tempK: this.environment.tempK,
        internalPressureBar: this.environment.pressureBar,
        isStoppered: false,
        connectedSyringeId: null,
        connectedTargetId: null,
        tubeMoles: {},
        tubeTempK: this.environment.tempK,
        tubePhenBleachFrac: 0,
        tubeLiquidFlowRateMlS: 0,
        tubeLiquidFlowTimer: 0,
        tubeLiquidSpillRateMlS: 0,
        tubeLiquidSpillColor: null,
        tubeColor: null,
        sealedAirMoles: null,
        headspaceGasMoles: createEmptyGasMap(),
        escapedGasMoles: createEmptyGasMap(),
        isShattered: false,
        stirTimer: 0,
        tiltAngle: 0,
        activeReactions: [],
        seenReactions: {},
        history: [], // [{ t, moles: {...}, tempK, ph }]
        precipitateSettle: {}, // speciesId -> 0..1 settled fraction
        suspensionLevel: 0,    // 0..1 overall colloid suspension (1.0 on stir, decays to 0 over ~13s)
        phenBleachFrac: 0, // 0..1 fraction converted to colorless carbinol In(OH)^3-
        phenIrrevFrac: 0,  // 0..1 fraction irreversibly C-C cleaved at >4.5 M OH- & high heat
        gardenActive: false,
        gardenGrowth: 0,
        hasPhenCotton: false,
        phenCottonLevel: 0,
        recentHalogenGasTimer: 0,
        naHazardFlag: false,
        overflowRateMlS: 0,
        overflowColor: null,
        wasOverflowing: false,
        spilledPuddleColor: null,
        naVisualPhase: Math.random() * 6.28,
        naPosRatio: 0.5,
        naVel: 0.9,
        naTempK: null,
        naPinned: false,
        naIgnited: false,
        localH2Mol: 0,
        wasBoiling: false,
        lastGasOutTempK: null,
        lastGasOutFormula: '',
        gasOutBannerTimer: 0,
        gasOutBoiling: false,
        gasOutSteam: false,
        tubeFlowRateMolS: 0,
        tubeFlowTempK: null,
        tubeFlowFormula: '',
        tubeFlowBannerTimer: 0,
        wallCondenseLevel: 0,
        isFrozenSolid: false,
        frostOpacity: 0,
        freezePointK: CONSTANTS.T_FREEZE_WATER_K,
        lastFreezeMeltRateMolS: 0,
        escapedFrostH2OMol: 0,
        isInverted: false,
        submergedInTroughId: null,
        hasStirBar: false,
        magStirRpm: 0,
        stirBarPhase: 0,
        grindAnimTimer: 0,
        gasDisplacedRate: 0,
        silverMirrorFrac: 0,
        fountainFlowMlS: 0,
        fountainFlowColor: null,
        gravitySpillRateMlS: 0,
        gravitySpillColor: null,
        troughOverfillRate: 0,
      });
      if (typeId === 'water_trough') {
        base.moles.H2O_l = (650 * 0.997) / CONSTANTS.M_H2O;
      }
    } else if (spec.kind === 'scale') {
      Object.assign(base, {
        tareG: 0,
        measuredG: 0,
      });
    } else if (spec.kind === 'burner') {
      Object.assign(base, {
        flameLevel: 0, // 0=off, 1=low, 2=med, 3=high
        powerW: 0,     // 0..650 W continuous burner power
        flameTestTimer: 0,
        flameTestColor: null,
        flameTestIon: null,
      });
    } else if (spec.kind === 'filter_funnel') {
      Object.assign(base, {
        moles: {},
        particleCounts: {},
        precipitateSettle: {},
        tempK: this.environment.tempK,
        phenBleachFrac: 0,
        phenIrrevFrac: 0,
        mountedOnVesselId: null,
        isFiltering: false,
        filtrateRateMlS: 0,
        filtrateTargetId: null,
        filtrateColor: null,
        uvMaskHalf: false,
        uvDarkFrac: 0,
        isBroken: false,
      });
    } else if (spec.kind === 'wash_bottle') {
      Object.assign(base, {
        waterMl: 250,
        isSpraying: false,
        sprayTargetId: null,
        squirtTimer: 0,
        squirtArc: null,
        isBroken: false,
      });
    } else if (spec.kind === 'condenser') {
      Object.assign(base, {
        waterFlowOn: true,
        connectedFromId: null,
        outletTargetId: null,
        vaporInMoles: createEmptyGasMap(),
        distillRateMlS: 0,
        totalCondensedMl: 0,
        activeDrop: false,
        isBroken: false,
      });
    } else if (spec.kind === 'burette') {
      Object.assign(base, {
        moles: {},
        particleCounts: {},
        precipitateSettle: {},
        tempK: this.environment.tempK,
        phenBleachFrac: 0,
        phenIrrevFrac: 0,
        valveRateMlS: 0,
        dispensedMl: 0,
        streamingNow: false,
        activeTargetId: null,
        streamColor: null,
        isBroken: false,
      });
    } else if (spec.kind === 'splint') {
      Object.assign(base, {
        mode: 'burning',
        cooldownTimer: 0,
        o2FlareTimer: 0,
        lastTestEvent: null,
        lastEventTimer: 0,
      });
    } else if (spec.kind === 'flame_loop') {
      Object.assign(base, {
        sampledIon: null,
        sampledColor: null,
        sampleLabel: '',
        logCooldown: 0,
      });
    } else if (spec.kind === 'indicator_strip') {
      Object.assign(base, {
        stripKind: spec.stripKind || 'litmus',
        sampledPH: null,
        tipColor: spec.stripKind === 'universal' ? '#eab308' : '#8b5cf6',
        isBleached: false,
        sampledFrom: '',
      });
    } else if (spec.kind === 'stir_bar') {
      Object.assign(base, {
        inVesselId: null,
      });
    } else if (spec.kind === 'dc_power') {
      Object.assign(base, {
        voltageV: 6.0,
        rheostatOhm: 2.0,
        powerOn: false,
        measuredV: 0,
        measuredCurrentA: 0,
        currentDensityADm2: 0,
        circuitMode: 'idle',
        posElectrodeId: null,
        negElectrodeId: null,
      });
    } else if (spec.kind === 'volt_ammeter') {
      Object.assign(base, {
        mode: 'voltmeter', // 'voltmeter' | 'ammeter' | 'short'
        measuredV: 0,
        measuredCurrentA: 0,
        circuitMode: 'idle',
        posElectrodeId: null,
        negElectrodeId: null,
        cathodicProtectedActive: false,
      });
    } else if (spec.kind === 'diffusion_tube') {
      Object.assign(base, {
        leftGasId: null,
        rightGasId: null,
        leftFront: 0,
        rightFront: 1,
        ringPosFrac: null,
        ringGrowth: 0,
        isBroken: false,
      });
    } else if (spec.kind === 'electrode') {
      const idx = this.items.filter((i) => i.kind === 'electrode').length;
      Object.assign(base, {
        material: 'C',
        dockedVesselId: null,
        dockSide: idx % 2 === 0 ? 'left' : 'right',
        polarityLabel: '',
        gasBubbleType: null,
        gasBubbleRate: 0,
      });
    } else if (spec.kind === 'salt_bridge') {
      Object.assign(base, {
        vesselAId: null,
        vesselBId: null,
        isBroken: false,
      });
    } else if (spec.kind === 'pipette') {
      Object.assign(base, {
        capacityMl: spec.maxVolumeMl || 10.0,
        volumeMl: 0,
        moles: {},
        tempK: this.environment.tempK,
        phenBleachFrac: 0,
        sourceLabel: '',
        liquidColor: null,
        dropDoseMl: 1.0,
        drawAnimTimer: 0,
        drawAnimColor: null,
        drawFromX: x,
        drawFromY: y,
        dispenseAnimTimer: 0,
        dispenseAnimColor: null,
        dispenseToX: x,
        dispenseToY: y,
        isBroken: false,
      });
    } else if (spec.kind === 'gas_syringe') {
      Object.assign(base, {
        gasMoles: createEmptyGasMap(),
        condensedWaterMol: 0,
        condensedEtOHMol: 0,
        frozenWaterMol: 0,
        nh4clSmokeTimer: 0,
        lastNH4ClRxnFlag: false,
        frostOpacity: this.environment.tempK < CONSTANTS.T_FREEZE_WATER_K ? 0.35 : 0,
        overflowMoles: {},
        overflowBleachFrac: 0,
        tempK: this.environment.tempK,
        inflowTempK: this.environment.tempK,
        internalPressureBar: this.environment.pressureBar,
        lastCondenseRateMolS: 0,
        inflowLiquidRateMlS: 0,
        inflowLiquidTimer: 0,
        inflowLiquidColor: null,
        overflowOutRateMlS: 0,
        overflowOutColor: null,
        wasOverflowing: false,
        connectedFromId: null,
        isDischarging: false,
        autoDischargeTimer: 0,
        dischargeRateMlS: 0,
        dischargeLiquidRateMlS: 0,
        dischargeColor: null,
        dischargeArc: null,
        spilledPuddleColor: null,
        isBroken: false,
      });
    } else if (spec.kind === 'stand') {
      Object.assign(base, {
        clampY: y - 45,
      });
    }

    this.items.push(base);
    this.selectedId = id;
    this.updateSupportAttachments();
    this.emitChange();
    return base;
  }

  removeApparatus(id) {
    const item = this.getItem(id);
    if (!item) return;
    if (item.kind === 'vessel' && (item.connectedTargetId || item.connectedSyringeId)) {
      this.disconnectSyringe(item.id);
    }
    if (item.kind === 'stir_bar' && item.inVesselId) {
      const host = this.getItem(item.inVesselId);
      if (host) {
        host.hasStirBar = false;
        host.magStirRpm = 0;
      }
    }
    // Clean up connections referencing removed apparatus
    for (const other of this.items) {
      if (other.connectedSyringeId === id || other.connectedTargetId === id) {
        this.disconnectSyringe(other.id);
      }
      if (other.connectedFromId === id) {
        other.connectedFromId = null;
      }
      if (other.outletTargetId === id) {
        other.outletTargetId = null;
      }
      if (other.dockedVesselId === id) {
        other.dockedVesselId = null;
      }
      if (other.inVesselId === id) {
        other.inVesselId = null;
      }
      if (other.mountedOnVesselId === id) {
        other.mountedOnVesselId = null;
      }
      if (other.posElectrodeId === id) other.posElectrodeId = null;
      if (other.negElectrodeId === id) other.negElectrodeId = null;
      if (other.restingOnId === id) {
        other.restingOnId = null;
        if (!other.clampedToId) other.fallStartY = other.y;
      }
      if (other.clampedToId === id) {
        other.clampedToId = null;
        other.fallStartY = other.y;
      }
    }
    this.items = this.items.filter((it) => it.id !== id);
    if (this.selectedId === id) {
      this.selectedId = this.items[0]?.id || null;
    }
    this.updateSupportAttachments();
    this.emitChange();
  }

  attachToStand(itemId, standId) {
    const item = this.getItem(itemId);
    const stand = this.getItem(standId);
    if (!item || !stand || stand.kind !== 'stand') return false;
    const spec = APPARATUS[item.typeId];
    if (!spec?.supportsClamp) return false;
    if (item.isShattered || item.isBroken) return false;
    item.clampedToId = stand.id;
    item.restingOnId = null;
    item.vy = 0;
    item.fallStartY = null;
    item.y = clampItemToStandY(spec, stand, SIM_BENCH_FLOOR_Y, item.y, 6);
    this.recomputeScaleReadings();
    this.emitChange();
    return true;
  }

  detachFromStand(itemId) {
    const item = this.getItem(itemId);
    if (!item || !item.clampedToId) return false;
    item.clampedToId = null;
    item.fallStartY = item.y;
    this.emitChange();
    return true;
  }

  toggleItemFlipX(itemId) {
    const item = this.getItem(itemId);
    if (!item || !APPARATUS[item.typeId]?.flippable) return false;
    item.flippedX = !item.flippedX;
    if (item.kind === 'stand') {
      const { armDir, rodX } = getStandGeometry(item);
      for (const child of this.items) {
        if (child.clampedToId !== item.id) continue;
        const d = child.kind === 'gas_syringe' ? 45 : 28;
        child.x = Math.max(50, Math.min(910, rodX + armDir * d));
      }
    }
    this.emitChange();
    return true;
  }

  setupPreset(presetName) {
    this.items = [];
    this.logs = [];
    this.timedTransfers = [];
    this.activePourStream = null;
    this.activeReagentTransfer = null;
    this.timeSec = 0;
    this.nextId = 1;

    if (presetName === 'clean') {
      // Truly empty workbench (0 items)
      this.selectedId = null;
      this.emitChange();
      return;
    }

    if (presetName === 'gas_collect') {
      const flask = this.createApparatus('erlenmeyer_250', 290, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      const stand = this.createApparatus('retort_stand', 685, SIM_BENCH_FLOOR_Y - APPARATUS.retort_stand.height / 2 + 2);
      const syringe = this.createApparatus('gas_syringe', 625, 325);
      this.attachToStand(syringe.id, stand.id);
      this.createApparatus('burner', 135, SIM_BENCH_FLOOR_Y - APPARATUS.burner.height / 2 + 2);
      this.connectSyringe(flask.id, syringe.id);
      this.selectedId = flask.id;
    } else if (presetName === 'trough_collect') {
      const flask = this.createApparatus('erlenmeyer_250', 220, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      const trough = this.createApparatus('water_trough', 540, SIM_BENCH_FLOOR_Y - APPARATUS.water_trough.height / 2 + 2);
      const tube = this.createApparatus('test_tube_50', trough.x, trough.y - 68);
      this.toggleVesselInverted(tube.id);
      tube.submergedInTroughId = trough.id;
      this.connectTube(flask.id, tube.id);
      this.selectedId = flask.id;
    } else if (presetName === 'titration') {
      const stand = this.createApparatus('retort_stand', 360, SIM_BENCH_FLOOR_Y - APPARATUS.retort_stand.height / 2 + 2);
      const burette = this.createApparatus('burette_50', 300, 235);
      this.attachToStand(burette.id, stand.id);
      const flask = this.createApparatus('erlenmeyer_250', 300, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      const stirBar = this.createApparatus('stir_bar', 490, SIM_BENCH_FLOOR_Y - 8);
      this.insertStirBarIntoVessel(stirBar.id, flask.id, 600);
      this.createApparatus('litmus_paper', 540, SIM_BENCH_FLOOR_Y - 12);
      this.selectedId = burette.id;
    } else if (presetName === 'filtration') {
      const beaker = this.createApparatus('beaker_250', 340, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      const funnel = this.createApparatus('filter_funnel', 340, beaker.y - APPARATUS.beaker_250.height / 2 - APPARATUS.filter_funnel.height * 0.18);
      funnel.mountedOnVesselId = beaker.id;
      this.createApparatus('wash_bottle', 450, SIM_BENCH_FLOOR_Y - APPARATUS.wash_bottle.height / 2 + 2);
      this.createApparatus('beaker_tall_250', 180, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_tall_250.height / 2 + 2);
      this.selectedId = funnel.id;
    } else if (presetName === 'daniell_cell') {
      const bLeft = this.createApparatus('beaker_250', 270, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      const bRight = this.createApparatus('beaker_250', 410, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      const bridge = this.createApparatus('salt_bridge', 340, bLeft.y - 36);
      bridge.vesselAId = bLeft.id;
      bridge.vesselBId = bRight.id;
      const elZn = this.createApparatus('electrode_rod', bLeft.x - 16, bLeft.y - 16);
      elZn.material = 'Zn';
      elZn.dockedVesselId = bLeft.id;
      elZn.dockSide = 'left';
      const elCu = this.createApparatus('electrode_rod', bRight.x + 16, bRight.y - 16);
      elCu.material = 'Cu';
      elCu.dockedVesselId = bRight.id;
      elCu.dockSide = 'right';
      const dmm = this.createApparatus('volt_ammeter', 620, SIM_BENCH_FLOOR_Y - APPARATUS.volt_ammeter.height / 2 + 2);
      dmm.posElectrodeId = elCu.id;
      dmm.negElectrodeId = elZn.id;
      this.selectedId = dmm.id;
    } else if (presetName === 'electrolysis') {
      const beaker = this.createApparatus('beaker_250', 300, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      const elA = this.createApparatus('electrode_rod', beaker.x - 18, beaker.y - 16);
      elA.material = 'C';
      elA.dockedVesselId = beaker.id;
      elA.dockSide = 'left';
      const elB = this.createApparatus('electrode_rod', beaker.x + 18, beaker.y - 16);
      elB.material = 'C';
      elB.dockedVesselId = beaker.id;
      elB.dockSide = 'right';
      const dc = this.createApparatus('dc_power', 520, SIM_BENCH_FLOOR_Y - APPARATUS.dc_power.height / 2 + 2);
      dc.posElectrodeId = elA.id;
      dc.negElectrodeId = elB.id;
      this.createApparatus('splint', 690, SIM_BENCH_FLOOR_Y - 12);
      this.selectedId = dc.id;
    } else if (presetName === 'distillation') {
      const burner = this.createApparatus('burner', 220, SIM_BENCH_FLOOR_Y - APPARATUS.burner.height / 2 + 2);
      const flask = this.createApparatus('erlenmeyer_250', 220, burner.y - APPARATUS.burner.height / 2 + 10 - APPARATUS.erlenmeyer_250.height / 2);
      const stand = this.createApparatus('retort_stand', 500, SIM_BENCH_FLOOR_Y - APPARATUS.retort_stand.height / 2 + 2);
      const cond = this.createApparatus('liebig_condenser', 450, 250);
      this.attachToStand(cond.id, stand.id);
      const recv = this.createApparatus('beaker_250', 610, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      this.connectTube(flask.id, cond.id);
      this.connectCondenserOutlet(cond.id, recv.id);
      this.selectedId = flask.id;
    } else if (presetName === 'ammonia_fountain') {
      const flask = this.createApparatus('erlenmeyer_250', 220, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      const burner = this.createApparatus('burner', 220, SIM_BENCH_FLOOR_Y - APPARATUS.burner.height / 2 + 2);
      flask.y = burner.y - APPARATUS.burner.height / 2 + 10 - APPARATUS.erlenmeyer_250.height / 2;
      const stand = this.createApparatus('retort_stand', 520, SIM_BENCH_FLOOR_Y - APPARATUS.retort_stand.height / 2 + 2);
      const fountainFlask = this.createApparatus('erlenmeyer_250', 460, 210);
      this.toggleVesselInverted(fountainFlask.id);
      this.attachToStand(fountainFlask.id, stand.id);
      const waterBeaker = this.createApparatus('beaker_250', 460, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      this.connectTube(flask.id, fountainFlask.id);
      this.selectedId = waterBeaker.id;
    } else if (presetName === 'graham_diffusion') {
      const tube = this.createApparatus('diffusion_tube', 430, SIM_BENCH_FLOOR_Y - APPARATUS.diffusion_tube.height / 2 + 2);
      this.selectedId = tube.id;
    } else {
      // 'starter' default bench: Scale + Beaker 250 mL + Burner + Erlenmeyer 250 mL
      this.createApparatus('scale', 220, SIM_BENCH_FLOOR_Y - APPARATUS.scale.height / 2 + 2);
      const beaker = this.createApparatus('beaker_250', 220, SIM_BENCH_FLOOR_Y - APPARATUS.scale.height - APPARATUS.beaker_250.height / 2 + 2);
      this.createApparatus('burner', 560, SIM_BENCH_FLOOR_Y - APPARATUS.burner.height / 2 + 2);
      this.createApparatus('erlenmeyer_250', 760, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      this.selectedId = beaker.id;
    }
    this.updateSupportAttachments();
    this.emitChange();
  }

  getSupportSurfaceForItem(item) {
    const spec = APPARATUS[item.typeId];
    const floorCenterY = SIM_BENCH_FLOOR_Y - spec.height / 2 + 2;
    let bestCenterY = floorCenterY;
    let bestSupport = null;

    if (
      item.kind === 'scale' ||
      item.kind === 'burner' ||
      item.kind === 'stand' ||
      item.kind === 'splint' ||
      item.kind === 'flame_loop' ||
      item.kind === 'indicator_strip' ||
      item.kind === 'salt_bridge'
    ) {
      return { centerY: floorCenterY, support: null };
    }

    const itemBottom = item.y + spec.height / 2;
    for (const sup of this.items) {
      if (sup.id === item.id) continue;
      const supSpec = APPARATUS[sup.typeId];
      const dx = Math.abs(item.x - sup.x);
      const alreadyOnSup = item.restingOnId === sup.id;

      if (sup.kind === 'scale') {
        const scTop = sup.y - supSpec.height / 2 + 2;
        const candY = scTop - spec.height / 2;
        const panHalf = (supSpec.panWidth || 128) * 0.5 + 4;
        if (dx <= panHalf && (alreadyOnSup || itemBottom <= scTop + 16) && candY < bestCenterY) {
          bestCenterY = candY;
          bestSupport = sup;
        }
      } else if (sup.kind === 'burner' && spec.heatable && item.kind === 'vessel') {
        const bnTop = sup.y - supSpec.height / 2 + 10;
        const candY = bnTop - spec.height / 2;
        if (dx <= 46 && (alreadyOnSup || itemBottom <= bnTop + 16) && candY < bestCenterY) {
          bestCenterY = candY;
          bestSupport = sup;
        }
      } else if (item.kind === 'filter_funnel' && sup.kind === 'vessel' && !sup.isShattered && !sup.isStoppered && !sup.isInverted) {
        const rimTop = sup.y - supSpec.height / 2;
        const candY = rimTop - spec.height * 0.18;
        if (dx <= 26 && (alreadyOnSup || item.y <= rimTop + 12) && candY < bestCenterY) {
          bestCenterY = candY;
          bestSupport = sup;
        }
      }
    }
    return { centerY: bestCenterY, support: bestSupport };
  }

  /**
   * Automatically snap items gently touching scales or burners below them,
   * and detach supports that were slid away from underneath an item.
   */
  updateSupportAttachments() {
    for (const it of this.items) {
      if (it.kind === 'scale' || it.kind === 'burner' || it.kind === 'stand') continue;
      if (it.dockedVesselId || it.inVesselId) {
        syncDockedToolPositions(this);
        continue;
      }
      if (it.clampedToId) {
        const stand = this.getItem(it.clampedToId);
        if (stand && stand.kind === 'stand') {
          it.restingOnId = null;
          continue;
        }
        it.clampedToId = null;
      }

      const prevSupId = it.restingOnId;
      it.restingOnId = null;
      const { centerY, support } = this.getSupportSurfaceForItem(it);
      if (support && Math.abs(it.y - centerY) <= 22) {
        it.restingOnId = support.id;
        it.y = centerY;
        if (Math.abs(it.x - support.x) < 28) it.x = support.x;
        it.vy = 0;
        it.fallStartY = null;
        if (it.kind === 'filter_funnel' && support.kind === 'vessel') {
          it.mountedOnVesselId = support.id;
        }
      } else if (!support && Math.abs(it.y - centerY) <= 10) {
        it.y = centerY;
        it.vy = 0;
        it.fallStartY = null;
        if (it.kind === 'filter_funnel') it.mountedOnVesselId = null;
      } else if (prevSupId && !support && !it.isDragging) {
        // Support beneath was moved away -> begin real freefall
        it.fallStartY = it.fallStartY ?? it.y;
        if (it.kind === 'filter_funnel') it.mountedOnVesselId = null;
      }
    }
    this.recomputeScaleReadings();
  }

  recomputeScaleReadings() {
    for (const sc of this.items) {
      if (sc.kind !== 'scale') continue;
      let loadG = 0;
      for (const it of this.items) {
        if (it.restingOnId !== sc.id) continue;
        const spec = APPARATUS[it.typeId];
        if (it.kind === 'vessel' || it.kind === 'filter_funnel' || it.kind === 'burette') {
          loadG += (spec.tareMassG || 0) + computeContentsMassG(it.moles || {});
        } else if (it.kind === 'gas_syringe') {
          const syrMoles = buildCombinedSyringeTotalMoles(it);
          loadG += 185.0 + computeContentsMassG(syrMoles);
        } else if (it.kind === 'pipette') {
          loadG += 18.0 + computeContentsMassG(it.moles || {});
        } else if (it.kind === 'wash_bottle') {
          loadG += (spec.tareMassG || 42) + (it.waterMl || 0) * 0.997;
        }
      }
      sc.measuredG = loadG - sc.tareG;
    }
  }

  tareScale(scaleId) {
    const sc = this.getItem(scaleId);
    if (!sc || sc.kind !== 'scale') return;
    let rawG = 0;
    for (const v of this.items) {
      if (v.kind === 'vessel' && v.restingOnId === sc.id) {
        const spec = APPARATUS[v.typeId];
        rawG += spec.tareMassG + computeContentsMassG(v.moles);
      }
    }
    sc.tareG = rawG;
    this.recomputeScaleReadings();
    this.emitChange();
  }

  clearTare(scaleId) {
    const sc = this.getItem(scaleId);
    if (!sc || sc.kind !== 'scale') return;
    sc.tareG = 0;
    this.recomputeScaleReadings();
    this.emitChange();
  }

  setBurnerFlame(burnerId, level) {
    const b = this.getItem(burnerId);
    if (!b || b.kind !== 'burner') return;
    const lvl = Math.max(0, Math.min(3, level));
    b.flameLevel = lvl;
    b.powerW = APPARATUS.burner.powerLevelsW[lvl] ?? 0;
    this.emitChange();
  }

  setBurnerPower(burnerId, watts) {
    const b = this.getItem(burnerId);
    if (!b || b.kind !== 'burner') return;
    const maxW = APPARATUS.burner.maxPowerW || 650;
    const w = Math.max(0, Math.min(maxW, Math.round(Number(watts) || 0)));
    b.powerW = w;
    if (w <= 0) {
      b.flameLevel = 0;
    } else if (w === 160) {
      b.flameLevel = 1;
    } else if (w === 360) {
      b.flameLevel = 2;
    } else if (w === 650) {
      b.flameLevel = 3;
    } else {
      b.flameLevel = (w / maxW) * 3;
    }
    this.emitChange();
  }

  getTubeTargetsForVessel(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel') return [];
    const syringes = this.items.filter((it) => it.kind === 'gas_syringe' && !it.isBroken);
    const condensers = this.items.filter((it) => it.kind === 'condenser' && !it.isBroken);
    const otherVessels = this.items.filter(
      (it) =>
        it.kind === 'vessel' &&
        it.id !== vesselId &&
        !it.isShattered &&
        it.connectedTargetId !== vesselId &&
        it.connectedSyringeId !== vesselId
    );
    return [...syringes, ...condensers, ...otherVessels];
  }

  popStopper(vessel, logKey = 'alertOverpressurePop', meta = {}) {
    const spec = APPARATUS[vessel.typeId] || APPARATUS.erlenmeyer_250;
    const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
    const hadLiquid = liqL > 1e-6;
    const vis = hadLiquid
      ? computeSolutionVisuals(
          vessel.moles,
          liqL,
          computePH(vessel.moles, liqL, vessel.tempK),
          spec.opticalPathCm,
          vessel.phenBleachFrac,
          vessel.phenIrrevFrac || 0
        )
      : null;

    const prevTargetId = vessel.connectedTargetId || vessel.connectedSyringeId;
    vessel.isStoppered = false;
    if (prevTargetId) {
      this.disconnectSyringe(vessel.id);
    }
    for (const g of ALL_GASES) {
      vessel.escapedGasMoles[g] = (vessel.escapedGasMoles[g] || 0) + (vessel.headspaceGasMoles[g] || 0);
      vessel.headspaceGasMoles[g] = 0;
    }
    vessel.sealedAirMoles = null;
    vessel.internalPressureBar = this.environment.pressureBar;

    this.addLog({ type: 'alert', key: logKey, vesselLabel: vessel.label });
    if (this.visualHooks.onAlert) {
      this.visualHooks.onAlert('pop', vessel, {
        hadLiquid,
        liquidColor: meta.liquidColor || (vis ? vis.css : null),
        neckRadius: spec.neckRadius || 18,
        vesselHeight: spec.height,
        hydraulic: !!meta.hydraulic,
      });
    }
  }

  toggleStopper(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered) return false;
    const spec = APPARATUS[v.typeId];
    if (!spec.stopperable) return false;

    if (v.isStoppered) {
      v.isStoppered = false;
      this.disconnectSyringe(v.id);
      for (const g of ALL_GASES) {
        v.escapedGasMoles[g] = (v.escapedGasMoles[g] || 0) + (v.headspaceGasMoles[g] || 0);
        v.headspaceGasMoles[g] = 0;
      }
      v.sealedAirMoles = null;
      v.internalPressureBar = this.environment.pressureBar;
    } else {
      v.isStoppered = true;
      v.overflowRateMlS = 0;
      v.wasOverflowing = false;
      v.sealedAirMoles = null;
      this.checkOverflow(v);
    }
    this.emitChange();
    return true;
  }

  connectTube(vesselId, targetId = null) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered) return { ok: false, reason: 'invalid' };
    const spec = APPARATUS[v.typeId];
    if (!spec.stopperable) return { ok: false, reason: 'not_stopperable' };

    const targets = this.getTubeTargetsForVessel(vesselId);
    let target = targetId ? targets.find((t) => t.id === targetId) : null;
    if (!target) {
      target =
        targets.find((it) => it.kind === 'gas_syringe' && !it.connectedFromId) ||
        targets.find((it) => it.kind === 'gas_syringe') ||
        targets.find((it) => it.kind === 'vessel' && !it.connectedFromId) ||
        targets[0];
    }
    if (!target) return { ok: false, reason: 'no_target' };

    // Disconnect previous source feeding into target if any
    if (target.connectedFromId && target.connectedFromId !== v.id) {
      const prev = this.getItem(target.connectedFromId);
      if (prev) this.disconnectSyringe(prev.id);
    }
    if (v.connectedTargetId && v.connectedTargetId !== target.id) {
      this.disconnectSyringe(v.id);
    }

    v.isStoppered = true;
    v.overflowRateMlS = 0;
    v.wasOverflowing = false;
    v.connectedTargetId = target.id;
    v.connectedSyringeId = target.kind === 'gas_syringe' ? target.id : null;
    target.connectedFromId = v.id;

    // Vent non-steam headspace equilibrium into syringe
    if (target.kind === 'gas_syringe') {
      for (const g of NON_STEAM_GASES) {
        if (v.headspaceGasMoles[g] > 0) {
          target.gasMoles[g] = (target.gasMoles[g] || 0) + v.headspaceGasMoles[g];
          v.headspaceGasMoles[g] = 0;
        }
      }
    }
    v.internalPressureBar = this.environment.pressureBar;
    this.checkOverflow(v);
    this.emitChange();
    return { ok: true, targetId: target.id };
  }

  connectSyringe(vesselId, syringeId = null) {
    const targets = this.getTubeTargetsForVessel(vesselId);
    const syr = syringeId
      ? targets.find((t) => t.id === syringeId && t.kind === 'gas_syringe')
      : targets.find((it) => it.kind === 'gas_syringe' && !it.connectedFromId) ||
        targets.find((it) => it.kind === 'gas_syringe');
    if (!syr) return { ok: false, reason: 'no_syringe' };
    return this.connectTube(vesselId, syr.id);
  }

  disconnectSyringe(vesselId) {
    const v = this.getItem(vesselId);
    if (!v) return;
    const tid = v.connectedTargetId || v.connectedSyringeId;
    if (tid) {
      const target = this.getItem(tid);
      if (target && target.connectedFromId === v.id) {
        target.connectedFromId = null;
      }
      // Any liquid trapped in disconnected rubber tubing drains out visually
      const tubeVolMl = computeLiquidVolumeL(v.tubeMoles || {}, v.tubeTempK || v.tempK) * 1000;
      if (tubeVolMl > 0.05 && this.visualHooks.onAlert && target) {
        const tubeGeom = computeTubingGeometry(v, target);
        const midPt = tubeGeom.points[Math.floor(tubeGeom.points.length * 0.5)] || { x: v.x, y: v.y - 60 };
        this.visualHooks.onAlert('tube_drip', v, {
          x: midPt.x,
          y: midPt.y,
          liquidMl: tubeVolMl,
          liquidColor: v.tubeColor || 'rgba(186, 230, 253, 0.85)',
        });
      }
      v.connectedSyringeId = null;
      v.connectedTargetId = null;
    }
    v.tubeMoles = {};
    v.tubePhenBleachFrac = 0;
    v.tubeLiquidFlowRateMlS = 0;
    v.tubeLiquidFlowTimer = 0;
    v.tubeLiquidSpillRateMlS = 0;
    v.tubeLiquidSpillColor = null;
    v.tubeColor = null;
    this.emitChange();
  }

  ventSyringe(syringeId, immediate = false) {
    const syr = this.getItem(syringeId);
    if (!syr || syr.kind !== 'gas_syringe' || syr.isBroken) return false;
    if (syr.connectedFromId) {
      this.disconnectSyringe(syr.connectedFromId);
    }
    if (immediate) {
      syr.gasMoles = createEmptyGasMap();
      syr.condensedWaterMol = 0;
      syr.condensedEtOHMol = 0;
      syr.frozenWaterMol = 0;
      syr.nh4clSmokeTimer = 0;
      syr.overflowMoles = {};
      syr.overflowBleachFrac = 0;
      syr.lastCondenseRateMolS = 0;
      syr.inflowLiquidRateMlS = 0;
      syr.inflowLiquidTimer = 0;
      syr.inflowLiquidColor = null;
      syr.overflowOutRateMlS = 0;
      syr.overflowOutColor = null;
      syr.wasOverflowing = false;
      syr.isDischarging = false;
      syr.autoDischargeTimer = 0;
      syr.dischargeLiquidRateMlS = 0;
      syr.dischargeArc = null;
      this.emitChange();
      return true;
    }

    const totMl = computeSyringeTotalVolumeMl(syr, this.environment);
    if (totMl <= 0.005) return false;
    syr.autoDischargeTimer = Math.max(0.55, Math.min(2.2, totMl / 55.0 + 0.45));
    this.emitChange();
    return true;
  }

  setSyringeDischarge(syringeId, active, mode = 'both') {
    const syr = this.getItem(syringeId);
    if (!syr || syr.kind !== 'gas_syringe' || syr.isBroken) return false;
    if (active && syr.connectedFromId) {
      this.disconnectSyringe(syr.connectedFromId);
    }
    syr.isDischarging = !!active;
    syr.dischargeMode = mode || 'both';
    if (!active) {
      syr.dischargeLiquidRateMlS = 0;
    }
    this.emitChange();
    return true;
  }

  pumpSyringeToVessel(syringeId, targetVesselId, targetVolMl = null) {
    const syr = this.getItem(syringeId);
    const dst = this.getItem(targetVesselId);
    if (!syr || syr.kind !== 'gas_syringe' || syr.isBroken) return 0;
    if (!dst || dst.kind !== 'vessel' || dst.isShattered) return 0;
    if (syr.connectedFromId) this.disconnectSyringe(syr.connectedFromId);

    const syrT = syr.tempK ?? this.environment.tempK;
    const liqMl = computeSyringeLiquidVolumeMl(syr, this.environment);
    const gasMl = computeSyringeGasVolumeMl(syr, this.environment);
    const totMl = liqMl + gasMl;
    if (totMl <= 0.005) return 0;

    const reqMl = targetVolMl == null ? totMl : Math.min(totMl, Math.max(0, Number(targetVolMl) || 0));
    const fracTotal = Math.min(1, reqMl / totMl);
    let transferredMl = 0;

    // 1. Transfer stoichiometric aqueous liquid + solutes first
    if (liqMl > 0.005) {
      const liqMoveFrac = targetVolMl == null ? 1.0 : Math.min(1, reqMl / liqMl);
      const combMoles = buildCombinedSyringeLiquidMoles(syr);
      const combL = computeLiquidVolumeL(combMoles, syrT);
      const vis = combL > 1e-8
        ? computeSolutionVisuals(combMoles, combL, computePH(combMoles, combL, syrT), 2.5, syr.overflowBleachFrac || 0)
        : null;
      const cDstOld = computeHeatCapacityJK(dst);
      const oldDstPhen = dst.moles.Phenolphthalein_aq || 0;
      const oldDstBleach = dst.phenBleachFrac || 0;

      const { movedHeatCapJK, movedPhenMol } = extractSyringeLiquidFraction(syr, liqMoveFrac, dst.moles);
      if (movedPhenMol > 0) {
        const totP = oldDstPhen + movedPhenMol;
        dst.phenBleachFrac =
          totP > 1e-14 ? (oldDstPhen * oldDstBleach + movedPhenMol * (syr.overflowBleachFrac || 0)) / totP : 0;
      }
      if (cDstOld + movedHeatCapJK > 0) {
        dst.tempK = (cDstOld * dst.tempK + movedHeatCapJK * syrT) / (cDstOld + movedHeatCapJK);
      }
      transferredMl += liqMl * liqMoveFrac;
      this.activePourStream = {
        fromX: getSyringeGeometry(syr).nozzleX,
        fromY: syr.y,
        toX: dst.x,
        toY: dst.y - APPARATUS[dst.typeId].height * 0.28,
        color: vis ? vis.css : 'rgba(186, 230, 253, 0.85)',
        timer: 0.35,
        pouredMl: liqMl * liqMoveFrac,
      };
    }

    // 2. Inject gas fraction: steam condenses & soluble HCl(g) dissolves into dst water; insoluble gases bubble out
    if (gasMl > 0.01 && (targetVolMl == null || transferredMl < reqMl)) {
      const remGasFrac = targetVolMl == null ? 1.0 : Math.min(1, (reqMl - transferredMl) / gasMl);
      let heatAddedJ = 0;
      let addedCapJK = 0;
      const steamMol = (syr.gasMoles.H2O_g || 0) * remGasFrac;
      if (steamMol > 1e-10) {
        syr.gasMoles.H2O_g = Math.max(0, (syr.gasMoles.H2O_g || 0) - steamMol);
        if (dst.tempK < waterBoilingPointK(this.environment.pressureBar)) {
          dst.moles.H2O_l = (dst.moles.H2O_l || 0) + steamMol;
          heatAddedJ += steamMol * CONSTANTS.DELTA_H_VAP_WATER_J;
          addedCapJK += steamMol * CONSTANTS.CP_H2O_J_MOL_K;
        } else {
          dst.escapedGasMoles.H2O_g = (dst.escapedGasMoles.H2O_g || 0) + steamMol;
        }
      }
      const etMol = (syr.gasMoles.C2H5OH_g || 0) * remGasFrac;
      if (etMol > 1e-10) {
        syr.gasMoles.C2H5OH_g = Math.max(0, (syr.gasMoles.C2H5OH_g || 0) - etMol);
        if (dst.tempK < SPECIES.C2H5OH_l.boilTempK) {
          dst.moles.C2H5OH_l = (dst.moles.C2H5OH_l || 0) + etMol;
          heatAddedJ += etMol * SPECIES.C2H5OH_l.dHVapJ;
          addedCapJK += etMol * SPECIES.C2H5OH_l.cp;
        } else {
          dst.escapedGasMoles.C2H5OH_g = (dst.escapedGasMoles.C2H5OH_g || 0) + etMol;
        }
      }
      const hclMol = (syr.gasMoles.HCl_g || 0) * remGasFrac;
      if (hclMol > 1e-10) {
        syr.gasMoles.HCl_g = Math.max(0, (syr.gasMoles.HCl_g || 0) - hclMol);
        if ((dst.moles.CuSO4_s || 0) > 1e-8 && (dst.moles.H2O_l || 0) < 1e-3 && dst.tempK < 405) {
          const dAdd = Math.min(dst.moles.CuSO4_s, hclMol / 2);
          dst.moles.CuSO4_s -= dAdd;
          if (dst.moles.CuSO4_s < 1e-13) delete dst.moles.CuSO4_s;
          dst.moles.CuSO4_2HCl_s = (dst.moles.CuSO4_2HCl_s || 0) + dAdd;
          heatAddedJ += dAdd * 68000;
          const rem = hclMol - 2 * dAdd;
          if (rem > 1e-12) dst.escapedGasMoles.HCl_g = (dst.escapedGasMoles.HCl_g || 0) + rem;
        } else if ((dst.moles.H2O_l || 0) > 1e-4) {
          dst.moles.H_aq = (dst.moles.H_aq || 0) + hclMol;
          dst.moles.Cl_aq = (dst.moles.Cl_aq || 0) + hclMol;
          heatAddedJ += hclMol * CONSTANTS.DELTA_H_VAP_HCL_AQ_J;
        } else {
          dst.escapedGasMoles.HCl_g = (dst.escapedGasMoles.HCl_g || 0) + hclMol;
        }
      }
      const nh3Mol = (syr.gasMoles.NH3_g || 0) * remGasFrac;
      if (nh3Mol > 1e-10) {
        syr.gasMoles.NH3_g = Math.max(0, (syr.gasMoles.NH3_g || 0) - nh3Mol);
        if ((dst.moles.H2O_l || 0) > 1e-4) {
          dst.moles.NH3_aq = (dst.moles.NH3_aq || 0) + nh3Mol;
          heatAddedJ += nh3Mol * 35400;
        } else {
          dst.escapedGasMoles.NH3_g = (dst.escapedGasMoles.NH3_g || 0) + nh3Mol;
        }
        if (dst.hasPhenCotton) dst.phenCottonLevel = 1.0;
      }
      if ((syr.gasMoles.C2H5Cl_g || 0) * remGasFrac > 1e-9 && dst.restingOnId) {
        dst.recentHalogenGasTimer = 1.8;
      }
      for (const g of NON_STEAM_GASES) {
        if (g === 'HCl_g' || g === 'NH3_g') continue;
        const m = (syr.gasMoles[g] || 0) * remGasFrac;
        if (m > 1e-10) {
          syr.gasMoles[g] = Math.max(0, (syr.gasMoles[g] || 0) - m);
          dst.escapedGasMoles[g] = (dst.escapedGasMoles[g] || 0) + m;
        }
      }
      if (heatAddedJ > 0) {
        const cDst = computeHeatCapacityJK(dst);
        dst.tempK = Math.min(waterBoilingPointK(this.environment.pressureBar), dst.tempK + heatAddedJ / Math.max(30, cDst + addedCapJK));
      }
      transferredMl += gasMl * remGasFrac;
    }

    this.checkOverflow(dst);
    this.recomputeScaleReadings();
    this.emitChange();
    return transferredMl;
  }

  stepSyringeDischarge(syringe, dt) {
    if (!syringe || syringe.isBroken) return;
    const isAuto = (syringe.autoDischargeTimer || 0) > 0;
    const isActive = syringe.isDischarging || isAuto;
    if (!isActive) {
      syringe.dischargeLiquidRateMlS = 0;
      syringe.dischargeArc = null;
      return;
    }
    if (isAuto) {
      syringe.autoDischargeTimer = Math.max(0, syringe.autoDischargeTimer - dt);
    }

    const liqMl = computeSyringeLiquidVolumeMl(syringe, this.environment);
    const gasMl = computeSyringeGasVolumeMl(syringe, this.environment);
    const totalMl = liqMl + gasMl;
    if (totalMl <= 0.002) {
      syringe.isDischarging = false;
      syringe.autoDischargeTimer = 0;
      syringe.dischargeLiquidRateMlS = 0;
      syringe.dischargeArc = null;
      return;
    }

    const syrT = syringe.tempK ?? this.environment.tempK;
    const arc = computeSyringeDischargeArc(
      syringe,
      this.items,
      SIM_BENCH_FLOOR_Y,
      CONSTANTS.GRAVITY_PX_S2 || 1800
    );
    syringe.dischargeArc = arc;

    // Rate scales so both 1 mL condensate and 200 mL gas finish smoothly in ~0.6..2.2s
    const rateMlS = isAuto
      ? Math.max(14, totalMl / Math.max(0.25, syringe.autoDischargeTimer + dt))
      : Math.max(18, Math.min(115, 22 + totalMl * 0.45));
    const pushTotalMl = Math.min(totalMl, rateMlS * dt);

    let pushLiqMl = 0;
    let pushGasMl = 0;
    if (liqMl > 0.002) {
      pushLiqMl = Math.min(liqMl, pushTotalMl * (liqMl / totalMl > 0.08 ? 0.85 : 0.35 + (gasMl < 1 ? 0.65 : 0)));
      if (gasMl <= 0.05) pushLiqMl = Math.min(liqMl, pushTotalMl);
      pushGasMl = Math.min(gasMl, Math.max(0, pushTotalMl - pushLiqMl));
    } else {
      pushGasMl = Math.min(gasMl, pushTotalMl);
    }

    let liqColor = 'rgba(186, 230, 253, 0.86)';
    if (pushLiqMl > 1e-4 && liqMl > 1e-5) {
      const combMoles = buildCombinedSyringeLiquidMoles(syringe);
      const combL = computeLiquidVolumeL(combMoles, syrT);
      if (combL > 1e-8) {
        liqColor = computeSolutionVisuals(
          combMoles,
          combL,
          computePH(combMoles, combL, syrT),
          2.5,
          syringe.overflowBleachFrac || 0
        ).css;
      }
      const fracLiq = Math.min(1, pushLiqMl / liqMl);
      const catchDst = arc.hitTargetVessel;
      if (catchDst && !catchDst.isShattered && !catchDst.isStoppered) {
        const cOld = computeHeatCapacityJK(catchDst);
        const oldPhen = catchDst.moles.Phenolphthalein_aq || 0;
        const oldBleach = catchDst.phenBleachFrac || 0;
        const { movedHeatCapJK, movedPhenMol } = extractSyringeLiquidFraction(syringe, fracLiq, catchDst.moles);
        if (movedPhenMol > 0) {
          const totP = oldPhen + movedPhenMol;
          catchDst.phenBleachFrac =
            totP > 1e-14 ? (oldPhen * oldBleach + movedPhenMol * (syringe.overflowBleachFrac || 0)) / totP : 0;
        }
        if (cOld + movedHeatCapJK > 0) {
          catchDst.tempK = (cOld * catchDst.tempK + movedHeatCapJK * syrT) / (cOld + movedHeatCapJK);
        }
        this.checkOverflow(catchDst);
      } else {
        extractSyringeLiquidFraction(syringe, fracLiq, null);
        syringe.spilledPuddleColor = liqColor;
      }
      syringe.dischargeLiquidRateMlS = pushLiqMl / Math.max(1e-4, dt);
      syringe.dischargeColor = liqColor;
    } else {
      syringe.dischargeLiquidRateMlS = 0;
    }

    const gasRates = {};
    if (pushGasMl > 1e-4 && gasMl > 1e-5) {
      const fracGas = Math.min(1, pushGasMl / gasMl);
      for (const g of ALL_GASES) {
        const n = syringe.gasMoles[g] || 0;
        if (n <= 1e-12) continue;
        const dm = n * fracGas;
        syringe.gasMoles[g] = Math.max(0, n - dm);
        if (syringe.gasMoles[g] < 1e-12) syringe.gasMoles[g] = 0;
        gasRates[g] = dm / Math.max(1e-4, dt);
      }
    }

    if (this.visualHooks.onParticlesNeeded && (pushLiqMl > 1e-4 || pushGasMl > 1e-4)) {
      this.visualHooks.onParticlesNeeded(syringe, {
        dischargeLiquidRateMlS: syringe.dischargeLiquidRateMlS || 0,
        dischargeColor: liqColor,
        dischargeArc: arc,
        dischargeGasRates: gasRates,
        gasTempK: syrT,
      });
    }
  }

  stirVessel(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered || v.isFrozenSolid) return;
    v.stirTimer = 3.0;
    v.suspensionLevel = 1.0;
    // Re-suspend precipitates when stirred (decays back toward 0 over ~13s of standing still)
    for (const key of Object.keys(v.precipitateSettle)) {
      v.precipitateSettle[key] = 0.0;
    }
    this.emitChange();
  }

  rinseVessel(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel') return;
    v.moles = {};
    v.particleCounts = {};
    v.tempK = this.environment.tempK;
    v.internalPressureBar = this.environment.pressureBar;
    v.isStoppered = false;
    this.disconnectSyringe(v.id);
    v.sealedAirMoles = null;
    v.headspaceGasMoles = createEmptyGasMap();
    v.escapedGasMoles = createEmptyGasMap();
    v.isShattered = false;
    v.activeReactions = [];
    v.seenReactions = {};
    v.history = [];
    v.precipitateSettle = {};
    v.suspensionLevel = 0;
    v.phenBleachFrac = 0;
    v.phenIrrevFrac = 0;
    v.gardenActive = false;
    v.gardenGrowth = 0;
    v.hasPhenCotton = false;
    v.phenCottonLevel = 0;
    v.recentHalogenGasTimer = 0;
    v.naHazardFlag = false;
    v.overflowRateMlS = 0;
    v.overflowColor = null;
    v.wasOverflowing = false;
    v.spilledPuddleColor = null;
    v.naTempK = null;
    v.naPinned = false;
    v.naIgnited = false;
    v.localH2Mol = 0;
    v.wasBoiling = false;
    v.lastGasOutTempK = null;
    v.lastGasOutFormula = '';
    v.gasOutBannerTimer = 0;
    v.gasOutBoiling = false;
    v.gasOutSteam = false;
    v.tubeFlowRateMolS = 0;
    v.tubeFlowTempK = null;
    v.tubeFlowFormula = '';
    v.tubeFlowBannerTimer = 0;
    v.wallCondenseLevel = 0;
    v.isFrozenSolid = false;
    v.frostOpacity = 0;
    v.freezePointK = CONSTANTS.T_FREEZE_WATER_K;
    v.lastFreezeMeltRateMolS = 0;
    v.escapedFrostH2OMol = 0;
    this.recomputeScaleReadings();
    this.emitChange();
  }

  /**
   * Add a pure reagent from the shelf into a vessel with exact mass (g) or volume (mL).
   */
  addReagentToVessel(vesselId, reagentId, amount, options = {}) {
    const v = this.getItem(vesselId);
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
    if (!v || !reg || v.isShattered || v.isBroken) return false;
    const isContainer =
      v.kind === 'vessel' || v.kind === 'filter_funnel' || (v.kind === 'burette' && reg.kind === 'liquid');
    if (!isContainer) return false;

    let amt = Math.max(0, Number(amount) || 0);
    if (v.kind === 'burette') {
      const curMl = computeLiquidVolumeL(v.moles, v.tempK) * 1000;
      amt = Math.min(amt, Math.max(0, 50.0 - curMl));
    }
    if (amt <= 0) return false;

    // Thermal capacity before addition
    const cOld = computeHeatCapacityJK(v);
    const tOld = v.tempK;

    let addedHeatCap = 0;
    let dilutionHeatJ = 0;

    if (reg.kind === 'liquid') {
      const oldPhen = v.moles.Phenolphthalein_aq || 0;
      const oldBleach = v.phenBleachFrac || 0;
      // Check HCl heat of dilution before adding (diluting from ~12 M downwards is exothermic)
      if (reg.id === 'hcl_37') {
        const nH2OExisting = v.moles.H2O_l || 0;
        const nHAdded = reg.perMl.H_aq * amt;
        if (nH2OExisting > 0.05) {
          // Approx enthalpy of dilution from 37% (~3.5:1 H2O:HCl) toward dilute: up to ~18 kJ/mol HCl
          const dilutionExtent = Math.min(1, nH2OExisting / (nHAdded * 20 + 0.1));
          dilutionHeatJ += 17500 * nHAdded * dilutionExtent;
        }
      } else if (reg.id === 'nh3_25') {
        const nH2OExisting = v.moles.H2O_l || 0;
        const nNH3Added = reg.perMl.NH3_aq * amt;
        if (nH2OExisting > 0.05) {
          const dilutionExtent = Math.min(1, nH2OExisting / (nNH3Added * 16 + 0.1));
          dilutionHeatJ += 3400 * nNH3Added * dilutionExtent;
        }
      } else if (reg.id === 'h2o' && (v.moles.H_aq || 0) > 0.05) {
        const liqL = computeLiquidVolumeL(v.moles, v.tempK);
        const cH = (v.moles.H_aq || 0) / Math.max(1e-4, liqL);
        if (cH > 3.0) {
          dilutionHeatJ += Math.min(3500, 1200 * (cH - 3.0) * (amt / 50));
        }
      }

      for (const [spId, molPerMl] of Object.entries(reg.perMl)) {
        const addMol = molPerMl * amt;
        v.moles[spId] = (v.moles[spId] || 0) + addMol;
        const sp = SPECIES[spId];
        if (sp) addedHeatCap += addMol * Math.max(0, sp.cp || 0);
      }
      if (reg.perMl.Phenolphthalein_aq) {
        const newPhen = v.moles.Phenolphthalein_aq || 0;
        // Fresh indicator starts intact & unbleached (In^2-)
        v.phenBleachFrac = newPhen > 1e-14 ? (oldPhen * oldBleach) / newPhen : 0;
        v.phenIrrevFrac = newPhen > 1e-14 ? (oldPhen * (v.phenIrrevFrac || 0)) / newPhen : 0;
      }
    } else if (reg.kind === 'solid') {
      const sp = SPECIES[reg.speciesId];
      const addMol = amt / sp.molarMass;
      v.moles[reg.speciesId] = (v.moles[reg.speciesId] || 0) + addMol;
      addedHeatCap += addMol * (sp.cp || 30);

      const particleCount = options.fine ? 30 : reg.id === 'na' ? 1 : 6;
      v.particleCounts[reg.speciesId] =
        (v.particleCounts[reg.speciesId] || 0) + particleCount;
    }

    // Mix thermal energy with reagent starting at ambient T_env
    const tAdd = this.environment.tempK;
    if (cOld + addedHeatCap > 0) {
      v.tempK = (cOld * tOld + addedHeatCap * tAdd + dilutionHeatJ) / (cOld + addedHeatCap);
    }

    if (!options.silentAnim) {
      const isSolid = reg.kind === 'solid';
      const dur = isSolid ? 1050 : amt <= 0.25 ? 650 : 1100;
      this.activeReagentTransfer = {
        reagentId,
        vesselId: v.id,
        isSolid,
        startMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
        durationMs: dur,
        dose: amt,
        color: reg.swatch,
        speciesId: reg.speciesId || null,
        fine: !!options.fine,
      };
      if (this.visualHooks.onReagentDispense) {
        this.visualHooks.onReagentDispense(v, reg, amt, options);
      }
    }

    this.checkOverflow(v);
    this.recomputeScaleReadings();
    this.recordHistorySnapshot(v, true);
    if (!options.silentEmit) this.emitChange();
    return true;
  }

  togglePhenCotton(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered) return false;
    v.hasPhenCotton = !v.hasPhenCotton;
    v.phenCottonLevel = 0;
    this.emitChange();
    return v.hasPhenCotton;
  }

  /**
   * Queue a progressive continuous pour from a starter liquid reagent matching bottle/rod animation.
   * Falls back to synchronous addition when paused, solid, or micro-drop <= 0.25 mL.
   */
  startTimedReagentPour(vesselId, reagentId, amount, options = {}) {
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
    const v = this.getItem(vesselId);
    const amt = Math.max(0, Number(amount) || 0);
    if (!v || !reg || amt <= 0) return false;
    if (this.environment.paused || options.instant || reg.kind === 'solid' || amt <= 0.25) {
      return this.addReagentToVessel(vesselId, reagentId, amt, options);
    }

    const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const durationMs = Math.max(780, Math.min(3400, Math.round(520 + amt * 24)));
    this.activeReagentTransfer = {
      reagentId,
      vesselId: v.id,
      isSolid: false,
      startMs,
      durationMs,
      dose: amt,
      color: reg.swatch,
      speciesId: null,
      fine: false,
    };
    this.timedTransfers.push({
      kind: 'reagent',
      vesselId: v.id,
      reagentId,
      totalAmt: amt,
      addedAmt: 0,
      startMs,
      durationMs,
    });
    if (this.visualHooks.onReagentDispense) {
      this.visualHooks.onReagentDispense(v, reg, amt, options);
    }
    this.emitChange();
    return true;
  }

  /**
   * Queue a smooth flow-rate-controlled pour from source vessel to target vessel via modal.
   */
  startTimedVesselPour(sourceId, targetId, amount, shakeBeforePour = false) {
    const src = this.getItem(sourceId);
    const dst = this.getItem(targetId);
    const amt = Math.max(0, Number(amount) || 0);
    if (!src || !dst || amt <= 0) return 0;
    if (this.environment.paused || amt <= 0.25) {
      return this.pourBetweenVessels(sourceId, targetId, amt, shakeBeforePour);
    }

    const durationMs = Math.max(680, Math.min(2800, Math.round(480 + amt * 22)));
    const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.timedTransfers.push({
      kind: 'vessel',
      sourceId: src.id,
      targetId: dst.id,
      totalMl: amt,
      movedMl: 0,
      shakeBeforePour,
      startMs,
      durationMs,
    });
    this.emitChange();
    return amt;
  }

  stepTimedTransfers(nowMsOverride = null) {
    if (!this.timedTransfers || this.timedTransfers.length === 0) return;
    const nowMs = nowMsOverride ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const remaining = [];
    let anyCompleted = false;

    for (const job of this.timedTransfers) {
      const p = Math.max(0, Math.min(1, (nowMs - job.startMs) / Math.max(1, job.durationMs)));
      if (job.kind === 'reagent') {
        const dst = this.getItem(job.vesselId);
        if (!dst || dst.isShattered) continue;
        // Pour flows smoothly inside [0.12 .. 0.90] matching glass-rod pouring animation window
        const frac = p <= 0.12 ? 0 : p >= 0.90 ? 1 : (p - 0.12) / 0.78;
        const targetAdded = job.totalAmt * frac;
        const delta = targetAdded - job.addedAmt;
        if (delta > 1e-5) {
          this.addReagentToVessel(job.vesselId, job.reagentId, delta, {
            silentAnim: true,
            silentEmit: p < 0.999,
          });
          job.addedAmt += delta;
        }
        if (p < 0.999) remaining.push(job);
        else anyCompleted = true;
      } else if (job.kind === 'vessel') {
        const src = this.getItem(job.sourceId);
        const dst = this.getItem(job.targetId);
        if (!src || !dst || src.isShattered || dst.isShattered) {
          if (src) src.tiltAngle = 0;
          continue;
        }
        const dir = src.x >= dst.x ? -1 : 1;
        const tiltEnv = p < 0.12 ? p / 0.12 : p > 0.88 ? (1 - p) / 0.12 : 1;
        src.tiltAngle = dir * 0.48 * Math.max(0, Math.min(1, tiltEnv));
        const srcSpec = APPARATUS[src.typeId] || APPARATUS.beaker_250;
        const dstSpec = APPARATUS[dst.typeId] || APPARATUS.beaker_250;
        const lipSpan = Math.min(28, (srcSpec.neckRadius || srcSpec.width * 0.35) * 0.85);

        const targetMoved = job.totalMl * p;
        const delta = targetMoved - job.movedMl;
        const rateMlS = (job.totalMl / job.durationMs) * 1000;
        if (delta > 1e-4) {
          const moved = this.pourBetweenVessels(src.id, dst.id, delta, job.shakeBeforePour, {
            rateMlS,
            pouredMlTotal: job.movedMl + delta,
            fromX: src.x + dir * lipSpan,
            fromY: src.y - srcSpec.height * 0.34,
            toY: dst.y - dstSpec.height * 0.25,
            silentEmit: p < 0.999,
          });
          job.movedMl += moved;
          if (moved <= 1e-6) {
            src.tiltAngle = 0;
            continue;
          }
        }
        if (p < 0.999) {
          remaining.push(job);
        } else {
          src.tiltAngle = 0;
          anyCompleted = true;
        }
      }
    }
    this.timedTransfers = remaining;
    if (anyCompleted) this.emitChange();
  }

  /**
   * Pour solution from source vessel into target vessel using physical Decantation (default)
   * or Shake-Before-Pour mechanics driven by vessel shape, solid buoyancy, and suspension state.
   */
  pourBetweenVessels(sourceId, targetId, volumeMl, shakeBeforePour = false, streamOpts = {}) {
    const src = this.getItem(sourceId);
    const dst = this.getItem(targetId);
    if (!src || !dst || src.id === dst.id || src.isShattered || dst.isShattered || src.isBroken || dst.isBroken) return 0;
    const dstValid = dst.kind === 'vessel' || dst.kind === 'filter_funnel' || dst.kind === 'burette';
    if (!dstValid) return 0;

    const srcLiqL = computeLiquidVolumeL(src.moles, src.tempK);
    const srcLiqMl = srcLiqL * 1000;
    const srcSpec = APPARATUS[src.typeId] || APPARATUS.beaker_250;
    if (srcLiqMl <= 0.01) {
      // Allow dry pouring solids cleanly from Mortar & Pestle or Filter Funnel paper into another vessel
      if ((srcSpec.isMortar || src.kind === 'filter_funnel') && dst.kind === 'vessel') {
        const moved = this.transferSolidsToVessel(sourceId, targetId, 1.0);
        return moved > 0 ? 1 : 0;
      }
      return 0;
    }

    let actualMl = Math.min(srcLiqMl, Math.max(0, volumeMl));
    if (dst.kind === 'burette') {
      const dstLiqMl = computeLiquidVolumeL(dst.moles, dst.tempK) * 1000;
      actualMl = Math.min(actualMl, Math.max(0, 50.0 - dstLiqMl));
      if (actualMl <= 1e-4) return 0;
    }
    const frac = Math.min(1, actualMl / srcLiqMl);
    if (frac <= 0) return 0;

    // Effective density of the liquid phase (g/cm3)
    let liqMassG = 0;
    for (const [id, n] of Object.entries(src.moles)) {
      if (n <= 0) continue;
      const sp = SPECIES[id];
      if (sp && (sp.phase === 'l' || sp.phase === 'aq')) {
        liqMassG += n * sp.molarMass;
      }
    }
    const liquidDensity = Math.max(0.65, Math.min(1.6, liqMassG / Math.max(0.01, srcLiqMl)));
    const vesselType = srcSpec.shape || 'beaker';

    const cDstBefore = computeHeatCapacityJK(dst);
    const oldDstPhen = dst.moles.Phenolphthalein_aq || 0;
    const oldDstBleach = dst.phenBleachFrac || 0;
    let movedPhen = 0;
    let cMoved = 0;
    let movedNaMol = 0;

    for (const [spId, n] of Object.entries(src.moles)) {
      if (n <= 0) continue;
      const sp = SPECIES[spId];
      if (!sp) continue;

      let moveRatio = 0;
      if (sp.phase === 'l' || sp.phase === 'aq') {
        moveRatio = frac;
      } else if (sp.phase === 's' && dst.kind !== 'burette') {
        moveRatio = srcSpec.isMortar
          ? frac
          : calcSolidTransferRatio({
              pourFraction: frac,
              solidDensity: sp.density || 2.5,
              liquidDensity,
              vesselType,
              suspensionFactor: computeSolidSuspensionFactor(src, spId, sp),
              shakeBeforePour,
            });
      }

      if (moveRatio <= 1e-12) continue;

      const moveMol = n * moveRatio;
      if (spId === 'Phenolphthalein_aq') movedPhen = moveMol;
      if (spId === 'Na_s') movedNaMol = moveMol;
      src.moles[spId] = n - moveMol;
      if (src.moles[spId] < 1e-13) delete src.moles[spId];
      dst.moles[spId] = (dst.moles[spId] || 0) + moveMol;
      cMoved += moveMol * Math.max(0, sp.cp || 0);

      if (sp.phase === 's') {
        const srcPCount = src.particleCounts?.[spId] || 6;
        if (!dst.particleCounts) dst.particleCounts = {};
        dst.particleCounts[spId] = (dst.particleCounts[spId] || 0) + Math.max(1, Math.round(srcPCount * moveRatio));
        if (sp.isPrecipitate) {
          if (!dst.precipitateSettle) dst.precipitateSettle = {};
          dst.precipitateSettle[spId] = 0.05; // Poured precipitate swirls freshly in receiving vessel
        }
      }
    }

    if (movedNaMol > 0 && src.naTempK != null) {
      dst.naTempK = dst.naTempK != null ? (dst.naTempK + src.naTempK) * 0.5 : src.naTempK;
    }

    if (movedPhen > 0) {
      const totalPhen = oldDstPhen + movedPhen;
      dst.phenBleachFrac =
        totalPhen > 1e-14 ? (oldDstPhen * oldDstBleach + movedPhen * (src.phenBleachFrac || 0)) / totalPhen : 0;
      dst.phenIrrevFrac =
        totalPhen > 1e-14
          ? (oldDstPhen * (dst.phenIrrevFrac || 0) + movedPhen * (src.phenIrrevFrac || 0)) / totalPhen
          : 0;
    }

    if (cDstBefore + cMoved > 0) {
      dst.tempK = (cDstBefore * dst.tempK + cMoved * src.tempK) / (cDstBefore + cMoved);
    }

    // Trigger subtle pour stream visual
    const dstSpec = APPARATUS[dst.typeId];
    if (!streamOpts.silentStream) {
      this.activePourStream = {
        fromX: streamOpts.fromX ?? src.x,
        fromY: streamOpts.fromY ?? src.y - 40,
        toX: dst.x,
        toY: streamOpts.toY ?? dst.y - dstSpec.height * 0.25,
        color: computeSolutionVisuals(
          src.moles,
          srcLiqL,
          computePH(src.moles, srcLiqL, src.tempK),
          APPARATUS[src.typeId].opticalPathCm,
          src.phenBleachFrac,
          src.phenIrrevFrac || 0
        ).css,
        rateMlS: streamOpts.rateMlS ?? Math.min(18, Math.max(4, actualMl * 2.5)),
        pouredMl: streamOpts.pouredMlTotal ?? 0,
        timer: 0.25,
      };
    }

    if (dst.kind === 'vessel') this.checkOverflow(dst);
    this.recomputeScaleReadings();
    if (!streamOpts.silentEmit) this.emitChange();
    return actualMl;
  }

  /**
   * Transfer solid residue/powder cleanly between containers (e.g. Filter Funnel paper or Mortar & Pestle -> Vessel).
   */
  transferSolidsToVessel(sourceId, targetId, fraction = 1.0) {
    const src = this.getItem(sourceId);
    const dst = this.getItem(targetId);
    if (!src || !dst || src.isShattered || dst.isShattered || dst.kind !== 'vessel') return 0;
    const frac = Math.max(0, Math.min(1, fraction));
    let totalMol = 0;
    for (const [spId, n] of Object.entries(src.moles || {})) {
      const sp = SPECIES[spId];
      if (!sp || sp.phase !== 's' || n <= 1e-12) continue;
      const d = n * frac;
      src.moles[spId] = n - d;
      if (src.moles[spId] < 1e-13) delete src.moles[spId];
      dst.moles[spId] = (dst.moles[spId] || 0) + d;
      const srcCnt = src.particleCounts?.[spId] || 6;
      const mvCnt = Math.max(1, Math.round(srcCnt * frac));
      dst.particleCounts[spId] = (dst.particleCounts[spId] || 0) + mvCnt;
      if (src.groundPowderMap?.[spId]) {
        dst.groundPowderMap = dst.groundPowderMap || {};
        dst.groundPowderMap[spId] = true;
      }
      if (src.flattenedMetalMap?.[spId]) {
        dst.flattenedMetalMap = dst.flattenedMetalMap || {};
        dst.flattenedMetalMap[spId] = true;
      }
      if (frac >= 0.99) {
        delete src.particleCounts[spId];
        if (src.groundPowderMap) delete src.groundPowderMap[spId];
        if (src.flattenedMetalMap) delete src.flattenedMetalMap[spId];
      } else if (src.particleCounts) {
        src.particleCounts[spId] = Math.max(1, srcCnt - mvCnt);
      }
      if (sp.isPrecipitate) dst.precipitateSettle[spId] = 0.05;
      totalMol += d;
    }
    this.recomputeScaleReadings();
    if (totalMol > 0) this.emitChange();
    return totalMol;
  }

  grindMortar(mortarId) {
    return grindMortarSolids(this, mortarId);
  }

  setBuretteValveRate(buretteId, rateMlS) {
    const b = this.getItem(buretteId);
    if (!b || b.kind !== 'burette') return;
    b.valveRateMlS = Math.max(0, Math.min(5.0, Number(rateMlS) || 0));
    this.emitChange();
  }

  buretteDispenseDrop(buretteId, dropMl = 0.05) {
    const b = this.getItem(buretteId);
    if (!b || b.kind !== 'burette') return 0;
    const liqL = computeLiquidVolumeL(b.moles, b.tempK);
    const liqMl = liqL * 1000;
    const actualMl = Math.min(liqMl, dropMl);
    if (actualMl <= 1e-5) return 0;
    const frac = Math.min(1, actualMl / liqMl);
    const tipY = b.y + (APPARATUS.burette_50?.height || 204) / 2;
    let target = null;
    let bestY = Infinity;
    for (const v of this.items) {
      if ((v.kind === 'vessel' || v.kind === 'filter_funnel') && !v.isShattered && !v.isStoppered) {
        const sp = APPARATUS[v.typeId];
        if (Math.abs(v.x - b.x) <= 50 && v.y > b.y && v.y < bestY) {
          bestY = v.y;
          target = v;
        }
      }
    }
    for (const [spId, n] of Object.entries(b.moles)) {
      const sp = SPECIES[spId];
      if (!sp || (sp.phase !== 'l' && sp.phase !== 'aq')) continue;
      const d = n * frac;
      b.moles[spId] = n - d;
      if (b.moles[spId] < 1e-13) delete b.moles[spId];
      if (target) target.moles[spId] = (target.moles[spId] || 0) + d;
    }
    b.dispensedMl = (b.dispensedMl || 0) + actualMl;
    this.recomputeScaleReadings();
    this.emitChange();
    return actualMl;
  }

  toggleWashBottleSpray(bottleId, active = null) {
    const wb = this.getItem(bottleId);
    if (!wb || wb.kind !== 'wash_bottle') return false;
    const next = active === null ? !wb.isSpraying : Boolean(active);
    if (next && (wb.waterMl || 0) <= 0.1) {
      wb.isSpraying = false;
      this.emitChange();
      return false;
    }
    wb.isSpraying = next;
    if (next) {
      const arc = computeWashBottleStreamArc(wb, this.items, SIM_BENCH_FLOOR_Y, CONSTANTS.GRAVITY_PX_S2 || 1800);
      wb.squirtArc = arc;
      wb.squirtTimer = 0.25;
      wb.sprayTargetId = arc.hitTarget ? arc.hitTarget.id : null;
    }
    this.emitChange();
    return wb.isSpraying;
  }

  washBottleSquirt(bottleId, targetId = null, volMl = 5.0) {
    const wb = this.getItem(bottleId);
    if (!wb || wb.kind !== 'wash_bottle' || (wb.waterMl || 0) <= 0.1) return 0;
    const actual = Math.min(wb.waterMl, volMl);
    const arc = computeWashBottleStreamArc(wb, this.items, SIM_BENCH_FLOOR_Y, CONSTANTS.GRAVITY_PX_S2 || 1800);
    const explicitTgt = targetId ? this.getItem(targetId) : null;
    const tgt = explicitTgt && !explicitTgt.isShattered && !explicitTgt.isBroken ? explicitTgt : arc.hitTarget;
    wb.waterMl -= actual;

    let visualArc = arc;
    if (explicitTgt && tgt && (!arc.hitTarget || arc.hitTarget.id !== tgt.id)) {
      const tSpec = APPARATUS[tgt.typeId] || {};
      const dstX = tgt.x;
      const dstY =
        tgt.kind === 'filter_funnel'
          ? tgt.y - tSpec.height / 2 + 4
          : tgt.y - (tSpec.height || 80) / 2 + 4;
      const pts = [];
      const peakY = Math.min(arc.spoutY, dstY) - 44;
      const ctrlX = (arc.spoutX + dstX) * 0.5;
      for (let k = 0; k <= 18; k++) {
        const u = k / 18;
        const omt = 1 - u;
        pts.push({
          x: omt * omt * arc.spoutX + 2 * omt * u * ctrlX + u * u * dstX,
          y: omt * omt * arc.spoutY + 2 * omt * u * peakY + u * u * dstY,
        });
      }
      visualArc = { ...arc, points: pts, hitTarget: tgt, hitX: dstX, hitY: dstY };
    }

    wb.squirtArc = visualArc;
    wb.squirtTimer = 0.55;
    wb.sprayTargetId = tgt ? tgt.id : null;

    if (tgt && (tgt.kind === 'vessel' || tgt.kind === 'filter_funnel') && !tgt.isStoppered && !tgt.isInverted) {
      tgt.moles.H2O_l = (tgt.moles.H2O_l || 0) + (actual * 0.997) / CONSTANTS.M_H2O;
    }
    this.recomputeScaleReadings();
    this.emitChange();
    return actual;
  }

  toggleVesselInverted(vesselId) {
    const v = this.getItem(vesselId);
    const spec = v ? APPARATUS[v.typeId] : null;
    if (!v || !spec?.invertible || v.isShattered) return false;
    v.isInverted = !v.isInverted;
    if (v.isInverted) {
      v.isStoppered = false;
      const mouthY = v.y + spec.height / 2;
      // Pull working water column ONLY when the inverted mouth sits submerged inside a wet water trough
      const trough = this.items.find((t) => {
        if (t.typeId !== 'water_trough' || t.isShattered || (t.moles.H2O_l || 0) <= 2.0) return false;
        const tSpec = APPARATUS.water_trough;
        const trTop = t.y - tSpec.height / 2;
        const trBot = t.y + tSpec.height / 2;
        return Math.abs(t.x - v.x) <= 78 && mouthY >= trTop - 16 && mouthY <= trBot + 12;
      });
      const curMl = computeLiquidVolumeL(v.moles, v.tempK) * 1000;
      const targetMl = spec.maxVolumeMl * 0.85;
      if (trough && curMl < targetMl) {
        const pullMol = Math.min(trough.moles.H2O_l - 1.0, ((targetMl - curMl) * 0.997) / CONSTANTS.M_H2O);
        if (pullMol > 0) {
          trough.moles.H2O_l -= pullMol;
          v.moles.H2O_l = (v.moles.H2O_l || 0) + pullMol;
        }
        v.submergedInTroughId = trough.id;
      } else {
        v.submergedInTroughId = null;
      }
    } else {
      v.submergedInTroughId = null;
      v.gravitySpillRateMlS = 0;
    }
    this.emitChange();
    return true;
  }

  toggleMagneticStir(vesselId, rpm = null) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || !v.hasStirBar) return;
    if (rpm !== null) {
      v.magStirRpm = Math.max(0, Math.min(1200, Number(rpm) || 0));
    } else {
      v.magStirRpm = (v.magStirRpm || 0) > 0 ? 0 : 700;
    }
    this.emitChange();
  }

  insertStirBarIntoVessel(stirBarId, vesselId, rpm = 800) {
    const bar = this.getItem(stirBarId);
    const v = this.getItem(vesselId);
    if (!bar || bar.kind !== 'stir_bar' || !v || v.kind !== 'vessel' || v.isShattered || v.isStoppered) return false;
    if (bar.inVesselId && bar.inVesselId !== v.id) {
      this.removeStirBarFromVessel(bar.id);
    }
    bar.inVesselId = v.id;
    v.hasStirBar = true;
    if (!v.magStirRpm && rpm > 0) v.magStirRpm = rpm;
    syncDockedToolPositions(this);
    this.recomputeScaleReadings();
    this.emitChange();
    return true;
  }

  removeStirBarFromVessel(stirBarId) {
    const bar = this.getItem(stirBarId);
    if (!bar || bar.kind !== 'stir_bar') return false;
    if (bar.inVesselId) {
      const v = this.getItem(bar.inVesselId);
      if (v) {
        const stillHas = this.items.some((i) => i.kind === 'stir_bar' && i.id !== bar.id && i.inVesselId === v.id);
        v.hasStirBar = stillHas;
        if (!stillHas) v.magStirRpm = 0;
      }
      bar.inVesselId = null;
      bar.y = Math.min(SIM_BENCH_FLOOR_Y - 8, bar.y);
      bar.x = Math.min(920, bar.x + 56);
    }
    this.recomputeScaleReadings();
    this.emitChange();
    return true;
  }

  connectCondenserOutlet(condenserId, vesselId = null) {
    const cond = this.getItem(condenserId);
    if (!cond || cond.kind !== 'condenser' || cond.isBroken) return false;
    if (!vesselId) {
      cond.outletTargetId = null;
      this.emitChange();
      return true;
    }
    const dst = this.getItem(vesselId);
    if (!dst || dst.kind !== 'vessel' || dst.isShattered || dst.isStoppered) return false;
    cond.outletTargetId = dst.id;
    this.emitChange();
    return true;
  }

  setElectrodeMaterial(electrodeId, mat) {
    const el = this.getItem(electrodeId);
    if (!el || el.kind !== 'electrode' || !ELECTRODE_MATERIALS[mat]) return;
    el.material = mat;
    this.emitChange();
  }

  setDcPowerState(supplyId, patch = {}) {
    const s = this.getItem(supplyId);
    if (!s || s.kind !== 'dc_power') return;
    if (patch.voltageV !== undefined) s.voltageV = Math.max(0, Math.min(12, Number(patch.voltageV) || 0));
    if (patch.rheostatOhm !== undefined) s.rheostatOhm = Math.max(0.2, Math.min(25, Number(patch.rheostatOhm) || 2.0));
    if (patch.powerOn !== undefined) s.powerOn = Boolean(patch.powerOn);
    this.emitChange();
  }

  setVoltAmmeterState(meterId, patch = {}) {
    const m = this.getItem(meterId);
    if (!m || m.kind !== 'volt_ammeter') return;
    if (patch.mode !== undefined && ['voltmeter', 'ammeter', 'short'].includes(patch.mode)) {
      m.mode = patch.mode;
    }
    if (patch.posElectrodeId !== undefined) m.posElectrodeId = patch.posElectrodeId;
    if (patch.negElectrodeId !== undefined) m.negElectrodeId = patch.negElectrodeId;
    this.emitChange();
  }

  clearElectrodePlating(electrodeId) {
    const el = this.getItem(electrodeId);
    if (!el || el.kind !== 'electrode') return;
    el.platedMaterial = null;
    el.platedQuality = null;
    el.platedCuMol = 0;
    this.emitChange();
  }

  toggleFunnelUvMask(funnelId) {
    const f = this.getItem(funnelId);
    if (!f || f.kind !== 'filter_funnel') return;
    f.uvMaskHalf = !f.uvMaskHalf;
    this.emitChange();
  }

  dropDiffusionReagent(tubeId, side, gasId) {
    const t = this.getItem(tubeId);
    if (!t || t.kind !== 'diffusion_tube' || t.isBroken) return false;
    if (gasId !== 'NH3_g' && gasId !== 'HCl_g') return false;
    if (side === 'left') {
      t.leftGasId = gasId;
      t.leftFront = 0;
    } else if (side === 'right') {
      t.rightGasId = gasId;
      t.rightFront = 1;
    }
    t.ringGrowth = 0;
    t.ringPosFrac = null;
    t._ringLogged = false;
    this.emitChange();
    return true;
  }

  clearDiffusionTube(tubeId) {
    const t = this.getItem(tubeId);
    if (!t || t.kind !== 'diffusion_tube') return;
    t.leftGasId = null;
    t.rightGasId = null;
    t.leftFront = 0;
    t.rightFront = 1;
    t.ringPosFrac = null;
    t.ringGrowth = 0;
    t._ringLogged = false;
    this.emitChange();
  }

  /**
   * Inject tiny capillary water primer drop (~0.15 mL) from connected receiver vessel into Ammonia/HCl-filled flask
   * to initiate the rapid vacuum fountain suction.
   */
  injectFountainPrimer(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered) return false;
    const headNH3 = v.headspaceGasMoles?.NH3_g || 0;
    const headHCl = v.headspaceGasMoles?.HCl_g || 0;
    if (headNH3 <= 1e-6 && headHCl <= 1e-6) return false;
    const target = v.connectedTargetId ? this.getItem(v.connectedTargetId) : null;
    let primerW = 0.01;
    if (target && target.kind === 'vessel' && (target.moles?.H2O_l || 0) > 0.02) {
      const pull = Math.min(0.015, target.moles.H2O_l * 0.05);
      target.moles.H2O_l -= pull;
      primerW = pull;
    }
    v.moles.H2O_l = (v.moles.H2O_l || 0) + primerW;
    if (!v.isStoppered && target) {
      v.isStoppered = true;
    }
    stepVesselGasAndPressure(v, createZeroGasMap(), 0, this.environment, (id) => this.getItem(id));
    this.emitChange();
    return true;
  }

  emitElectrolysisGas(v, gasId, mol, electrodeX = null) {
    if (!v || mol <= 0) return;
    const vSpec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
    // Phenomenon #6: Collect rising bubbles directly into any open inverted test tube / cylinder held over the electrode(s)
    if (!v.isStoppered && !v.isInverted) {
      const targetX = electrodeX ?? v.x;
      const vTop = v.y - vSpec.height / 2;
      const vBot = v.y + vSpec.height / 2;
      const overheadInv = this.items.find((inv) => {
        if (inv.kind !== 'vessel' || !inv.isInverted || inv.isShattered || inv.isStoppered) return false;
        const iSpec = APPARATUS[inv.typeId];
        const iMouthY = inv.y + iSpec.height / 2;
        return Math.abs(inv.x - targetX) <= Math.max(44, vSpec.width * 0.45) && iMouthY >= vTop - 22 && iMouthY <= vBot + 12;
      });
      if (overheadInv) {
        const dummy = createEmptyGasMap();
        dummy[gasId] = mol;
        overheadInv.headspaceGasMoles = overheadInv.headspaceGasMoles || createEmptyGasMap();
        overheadInv.headspaceGasMoles[gasId] = (overheadInv.headspaceGasMoles[gasId] || 0) + mol;
        // Displace water down into parent vessel up to capacity
        const dispL = (mol * CONSTANTS.R_L_BAR_MOL_K * (overheadInv.tempK || v.tempK)) / Math.max(0.1, this.environment.pressureBar);
        const dispMol = (dispL * 1000 * 0.997) / CONSTANTS.M_H2O;
        const outW = Math.min(Math.max(0, (overheadInv.moles.H2O_l || 0) - 0.01), dispMol);
        if (outW > 0) {
          overheadInv.moles.H2O_l -= outW;
          if (overheadInv.moles.H2O_l < 1e-12) delete overheadInv.moles.H2O_l;
          v.moles.H2O_l = (v.moles.H2O_l || 0) + outW;
        }
        overheadInv.gasDisplacedRate = (overheadInv.gasDisplacedRate || 0) + mol / 0.02;
        return;
      }
    }
    if (v.isStoppered && (v.connectedTargetId || v.connectedSyringeId)) {
      const dummyGas = createEmptyGasMap();
      dummyGas[gasId] = mol;
      stepVesselGasAndPressure(v, dummyGas, 0, this.environment, (id) => this.getItem(id));
    } else if (v.isStoppered) {
      v.headspaceGasMoles[gasId] = (v.headspaceGasMoles[gasId] || 0) + mol;
    } else {
      v.escapedGasMoles[gasId] = (v.escapedGasMoles[gasId] || 0) + mol;
    }
    v.lastGasRateMap = v.lastGasRateMap || createEmptyGasMap();
    v.lastGasRateMap[gasId] = (v.lastGasRateMap[gasId] || 0) + mol * 12;
  }

  /**
   * Pipette operations: draw up to 10 mL from vessel or reagent, or dispense dropwise to a vessel.
   */
  pipetteDrawFromVessel(vesselId, drawMl = 10.0, targetPipette = null) {
    const src = this.getItem(vesselId);
    const pip = targetPipette || this.pipette;
    if (!src || src.kind !== 'vessel' || src.isShattered || !pip || pip.isBroken) return 0;
    const cap = pip.capacityMl || 10.0;
    const availRoom = cap - (pip.volumeMl || 0);
    if (availRoom <= 0.01) return 0;

    const srcLiqL = computeLiquidVolumeL(src.moles, src.tempK);
    const srcLiqMl = srcLiqL * 1000;
    if (srcLiqMl <= 0.01) return 0;

    const srcSpec = APPARATUS[src.typeId];
    const vis = computeSolutionVisuals(
      src.moles,
      srcLiqL,
      computePH(src.moles, srcLiqL, src.tempK),
      srcSpec.opticalPathCm,
      src.phenBleachFrac,
      src.phenIrrevFrac || 0
    );
    const actual = Math.min(availRoom, srcLiqMl, drawMl);
    const frac = actual / srcLiqMl;
    const oldVol = pip.volumeMl || 0;
    const oldPhen = pip.moles.Phenolphthalein_aq || 0;
    const oldBleach = pip.phenBleachFrac || 0;
    let movedPhen = 0;

    for (const [spId, n] of Object.entries(src.moles)) {
      const sp = SPECIES[spId];
      if (!sp || (sp.phase !== 'l' && sp.phase !== 'aq')) continue;
      const move = n * frac;
      if (spId === 'Phenolphthalein_aq') movedPhen = move;
      src.moles[spId] = n - move;
      if (src.moles[spId] < 1e-13) delete src.moles[spId];
      pip.moles[spId] = (pip.moles[spId] || 0) + move;
    }

    if (movedPhen > 0) {
      const totP = oldPhen + movedPhen;
      pip.phenBleachFrac = totP > 1e-14 ? (oldPhen * oldBleach + movedPhen * (src.phenBleachFrac || 0)) / totP : 0;
      pip.phenIrrevFrac = totP > 1e-14 ? (oldPhen * (pip.phenIrrevFrac || 0) + movedPhen * (src.phenIrrevFrac || 0)) / totP : 0;
    }
    pip.tempK = oldVol + actual > 0 ? (oldVol * (pip.tempK || src.tempK) + actual * src.tempK) / (oldVol + actual) : src.tempK;
    pip.volumeMl = oldVol + actual;
    pip.sourceLabel = `${srcSpec.id} ${src.label}`;
    pip.liquidColor = vis.css;

    if (pip.kind === 'pipette') {
      pip.drawAnimTimer = 0.68;
      pip.drawAnimColor = vis.css;
      pip.drawFromX = src.x;
      pip.drawFromY = src.y - srcSpec.height * 0.15;
      if (this.visualHooks.onAlert) {
        this.visualHooks.onAlert('pipette_suck', src, {
          pipette: pip,
          color: vis.css,
          liquidMl: actual,
        });
      }
    }

    this.recomputeScaleReadings();
    this.emitChange();
    return actual;
  }

  pipetteDrawFromSyringe(syringeId, drawMl = 10.0, targetPipette = null) {
    const syr = this.getItem(syringeId);
    const pip = targetPipette || this.pipette;
    if (!syr || syr.kind !== 'gas_syringe' || syr.isBroken || !pip || pip.isBroken) return 0;
    const cap = pip.capacityMl || 10.0;
    const availRoom = cap - (pip.volumeMl || 0);
    if (availRoom <= 0.01) return 0;

    const syrT = syr.tempK ?? this.environment.tempK;
    const syrLiqMl = computeSyringeLiquidVolumeMl(syr, this.environment);
    if (syrLiqMl <= 0.01) return 0;

    const combMoles = buildCombinedSyringeLiquidMoles(syr);
    const combL = computeLiquidVolumeL(combMoles, syrT);
    const vis = combL > 1e-8
      ? computeSolutionVisuals(combMoles, combL, computePH(combMoles, combL, syrT), 2.5, syr.overflowBleachFrac || 0)
      : { css: 'rgba(186, 230, 253, 0.85)' };

    const actual = Math.min(availRoom, syrLiqMl, drawMl);
    const frac = Math.min(1, actual / syrLiqMl);
    const oldVol = pip.volumeMl || 0;
    const oldPhen = pip.moles.Phenolphthalein_aq || 0;
    const oldBleach = pip.phenBleachFrac || 0;

    const { movedPhenMol } = extractSyringeLiquidFraction(syr, frac, pip.moles);
    if (movedPhenMol > 0) {
      const totP = oldPhen + movedPhenMol;
      pip.phenBleachFrac =
        totP > 1e-14 ? (oldPhen * oldBleach + movedPhenMol * (syr.overflowBleachFrac || 0)) / totP : 0;
    }
    pip.tempK = oldVol + actual > 0 ? (oldVol * (pip.tempK || syrT) + actual * syrT) / (oldVol + actual) : syrT;
    pip.volumeMl = oldVol + actual;
    pip.sourceLabel = `syringe ${syr.label}`;
    pip.liquidColor = vis.css;

    if (pip.kind === 'pipette') {
      pip.drawAnimTimer = 0.68;
      pip.drawAnimColor = vis.css;
      pip.drawFromX = getSyringeGeometry(syr).nozzleX;
      pip.drawFromY = syr.y;
      if (this.visualHooks.onAlert) {
        this.visualHooks.onAlert('pipette_suck', { x: pip.drawFromX, y: pip.drawFromY }, {
          pipette: pip,
          color: vis.css,
          liquidMl: actual,
        });
      }
    }

    this.recomputeScaleReadings();
    this.emitChange();
    return actual;
  }

  pipetteDrawFromReagent(reagentId, drawMl = 2.0) {
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId && r.kind === 'liquid');
    if (!reg) return 0;

    // Create or reuse an unemptied/available Pipette 10 mL directly on the bench
    let pip = this.items.find((it) => it.kind === 'pipette' && (it.capacityMl - (it.volumeMl || 0)) > 0.05);
    if (!pip) {
      const pipSpec = APPARATUS.pipette_10;
      pip = this.createApparatus('pipette_10', 460, 482 - pipSpec.height / 2 + 2);
    }

    const availRoom = pip.capacityMl - (pip.volumeMl || 0);
    const actual = Math.min(availRoom, drawMl);
    if (actual <= 0.01) return 0;

    for (const [spId, molPerMl] of Object.entries(reg.perMl)) {
      pip.moles[spId] = (pip.moles[spId] || 0) + molPerMl * actual;
    }
    pip.volumeMl = (pip.volumeMl || 0) + actual;
    pip.tempK = this.environment.tempK;
    pip.sourceLabel = reg.formula;
    pip.liquidColor = reg.id === 'phen' ? 'rgba(244, 114, 182, 0.45)' : 'rgba(186, 230, 253, 0.72)';
    pip.drawAnimTimer = 0.55;
    pip.drawAnimColor = pip.liquidColor;
    this.selectedId = pip.id;
    this.emitChange();
    return actual;
  }

  pipetteDispenseToVessel(vesselId, dropMl = 0.05, sourcePipette = null) {
    const dst = this.getItem(vesselId);
    const pip = sourcePipette || this.pipette;
    if (!dst || dst.kind !== 'vessel' || dst.isShattered || !pip || pip.isBroken) return 0;
    if ((pip.volumeMl || 0) <= 1e-5) return 0;

    const dstSpec = APPARATUS[dst.typeId];
    const actual = Math.min(pip.volumeMl, Math.max(0.05, dropMl));
    const frac = actual / pip.volumeMl;
    const pipColor = pip.liquidColor || 'rgba(186, 230, 253, 0.85)';

    const cOld = computeHeatCapacityJK(dst);
    const oldDstPhen = dst.moles.Phenolphthalein_aq || 0;
    const oldDstBleach = dst.phenBleachFrac || 0;
    let movedPhen = 0;
    let cAdd = 0;

    for (const [spId, n] of Object.entries(pip.moles)) {
      const move = n * frac;
      if (spId === 'Phenolphthalein_aq') movedPhen = move;
      pip.moles[spId] = n - move;
      if (pip.moles[spId] < 1e-14) delete pip.moles[spId];
      dst.moles[spId] = (dst.moles[spId] || 0) + move;
      const sp = SPECIES[spId];
      if (sp) cAdd += move * Math.max(0, sp.cp || 0);
    }

    if (movedPhen > 0) {
      const totalPhen = oldDstPhen + movedPhen;
      dst.phenBleachFrac =
        totalPhen > 1e-14 ? (oldDstPhen * oldDstBleach + movedPhen * (pip.phenBleachFrac || 0)) / totalPhen : 0;
      dst.phenIrrevFrac =
        totalPhen > 1e-14
          ? (oldDstPhen * (dst.phenIrrevFrac || 0) + movedPhen * (pip.phenIrrevFrac || 0)) / totalPhen
          : 0;
    }

    if (cOld + cAdd > 0) {
      dst.tempK = (cOld * dst.tempK + cAdd * (pip.tempK || this.environment.tempK)) / (cOld + cAdd);
    }

    pip.volumeMl = Math.max(0, pip.volumeMl - actual);
    if (pip.volumeMl < 1e-4) {
      pip.volumeMl = 0;
      pip.moles = {};
      pip.phenBleachFrac = 0;
      pip.phenIrrevFrac = 0;
      pip.sourceLabel = '';
      pip.liquidColor = null;
    }

    if (pip.kind === 'pipette') {
      pip.dispenseAnimTimer = 0.48;
      pip.dispenseAnimColor = pipColor;
      pip.dispenseToX = dst.x;
      pip.dispenseToY = dst.y - dstSpec.height * 0.12;
      if (this.visualHooks.onAlert) {
        this.visualHooks.onAlert('pipette_drop', dst, {
          pipette: pip,
          color: pipColor,
          liquidMl: actual,
        });
      }
    }

    this.checkOverflow(dst);
    this.recomputeScaleReadings();
    this.emitChange();
    return actual;
  }

  clearPipette(pipetteId = null) {
    const pip = pipetteId ? this.getItem(pipetteId) : this.pipette;
    if (!pip) return;
    pip.volumeMl = 0;
    pip.moles = {};
    pip.phenBleachFrac = 0;
    pip.sourceLabel = '';
    pip.liquidColor = null;
    pip.drawAnimTimer = 0;
    pip.dispenseAnimTimer = 0;
    this.emitChange();
  }

  setPipetteDropDose(pipetteId, doseMl) {
    const pip = this.getItem(pipetteId);
    if (!pip || pip.kind !== 'pipette') return;
    pip.dropDoseMl = Math.max(0.05, Math.min(10.0, Number(doseMl) || 1.0));
    this.emitChange();
  }

  checkOverflow(vessel) {
    if (!vessel || vessel.isShattered) return;
    const spec = APPARATUS[vessel.typeId];
    const brimMl = getVesselBrimVolumeMl(spec);
    const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
    const liqMl = liqL * 1000;
    const solMl = computeSolidVolumeMl(vessel.moles);
    const totalMl = liqMl + solMl;

    if (totalMl <= brimMl + 0.05 || liqMl <= 0.05) return;

    const excessMl = totalMl - brimMl;
    const vis = computeSolutionVisuals(
      vessel.moles,
      liqL,
      computePH(vessel.moles, liqL, vessel.tempK),
      spec.opticalPathCm,
      vessel.phenBleachFrac
    );

    if (vessel.isStoppered) {
      vessel.overflowRateMlS = 0;
      const targetId = vessel.connectedTargetId || vessel.connectedSyringeId;
      const target = targetId ? this.getItem(targetId) : null;
      if (!target) {
        // Hard rubber stopper without tubing: hydraulic excess pops the stopper!
        this.popStopper(vessel, 'alertHydroOverflowPop', {
          hydraulic: true,
          liquidColor: vis.css,
        });
        vessel.overflowRateMlS = 36 + excessMl * 4.2;
        vessel.overflowColor = vis.css;
        vessel.spilledPuddleColor = vis.css;
      }
      return;
    }

    vessel.overflowRateMlS = 36 + excessMl * 4.2;
    vessel.overflowColor = vis.css;
    vessel.spilledPuddleColor = vis.css;
    if (!vessel.wasOverflowing) {
      vessel.wasOverflowing = true;
      this.addLog({
        type: 'alert',
        key: 'alertOverflow',
        vesselLabel: `${spec.id} ${vessel.label}`,
      });
      if (this.visualHooks.onAlert) {
        this.visualHooks.onAlert('overflow', vessel, { liquidColor: vis.css });
      }
    }
  }

  /**
   * Handle excess liquid past physical vessel brim depending on stopper boundary:
   * - Open: gradual waterfall spill over rim
   * - Hard stopper (no tube): pops stopper off via hydraulic pressure, then spills
   * - Stopper + rubber tubing: fills calibrated tube volume (length * fixed Ø6mm bore) first,
   *   then streams into the connected vessel or Gas Syringe barrel.
   */
  stepVesselOverflow(vessel, dt) {
    if (vessel.isShattered) return;
    const spec = APPARATUS[vessel.typeId];
    const brimMl = getVesselBrimVolumeMl(spec);
    const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
    const liqMl = liqL * 1000;
    const solMl = computeSolidVolumeMl(vessel.moles);
    const totalMl = liqMl + solMl;

    vessel.tubeLiquidSpillRateMlS = 0;
    vessel.tubeLiquidSpillColor = null;

    if (vessel.isStoppered) {
      vessel.overflowRateMlS = 0;
      vessel.wasOverflowing = false;
      const targetId = vessel.connectedTargetId || vessel.connectedSyringeId;
      const target = targetId ? this.getItem(targetId) : null;

      // Case 2: Hard stopper without tubing -> hydraulic pop when volume exceeds brim
      if (!target) {
        if (totalMl > brimMl + 0.12 && liqMl > 0.05) {
          this.popStopper(vessel, 'alertHydroOverflowPop', { hydraulic: true });
        }
        return;
      }

      // Case 3: Stopper with tubing -> push excess into vessel.tubeMoles, then into target
      let pushedMlThisFrame = 0;
      if (totalMl > brimMl + 0.02 && liqMl > 0.02) {
        const excessMl = totalMl - brimMl;
        const rateMlS = 40 + excessMl * 4.5;
        const pushMl = Math.min(liqMl, excessMl, rateMlS * dt);
        const fracRemove = Math.min(1, pushMl / liqMl);
        const oldTubeCap = computeHeatCapacityJK({ typeId: vessel.typeId, moles: vessel.tubeMoles || {} }) - (spec.glassHeatCapacityJK || 80);
        const oldTubePhen = vessel.tubeMoles?.Phenolphthalein_aq || 0;
        const { movedHeatCapJK, movedPhenMol } = moveFluidFraction(
          vessel.moles,
          vessel.precipitateSettle,
          fracRemove,
          vessel.tubeMoles,
          true
        );
        const totalCap = Math.max(1e-6, oldTubeCap + movedHeatCapJK);
        vessel.tubeTempK =
          (Math.max(0, oldTubeCap) * (vessel.tubeTempK || vessel.tempK) + movedHeatCapJK * vessel.tempK) / totalCap;
        if (movedPhenMol > 0) {
          const totP = oldTubePhen + movedPhenMol;
          vessel.tubePhenBleachFrac =
            totP > 1e-14 ? (oldTubePhen * (vessel.tubePhenBleachFrac || 0) + movedPhenMol * (vessel.phenBleachFrac || 0)) / totP : 0;
        }
        pushedMlThisFrame = pushMl;
      }

      const tubeLiqL = computeLiquidVolumeL(vessel.tubeMoles || {}, vessel.tubeTempK || vessel.tempK);
      const tubeVolMl = tubeLiqL * 1000;
      if (tubeVolMl > 0.005) {
        const tVis = computeSolutionVisuals(
          vessel.tubeMoles,
          tubeLiqL,
          computePH(vessel.tubeMoles, tubeLiqL, vessel.tubeTempK || vessel.tempK),
          0.6, // 6 mm tube optical path
          vessel.tubePhenBleachFrac || 0
        );
        vessel.tubeColor = tVis.css;
      } else {
        vessel.tubeColor = null;
      }

      if (pushedMlThisFrame > 1e-4) {
        vessel.tubeLiquidFlowRateMlS = pushedMlThisFrame / Math.max(1e-4, dt);
        vessel.tubeLiquidFlowTimer = 0.45;
      } else {
        vessel.tubeLiquidFlowRateMlS = 0;
      }

      const tubeGeom = computeTubingGeometry(vessel, target);
      if (tubeVolMl > tubeGeom.capacityMl + 0.01) {
        const spillMl = tubeVolMl - tubeGeom.capacityMl;
        const fracSpill = Math.min(1, spillMl / tubeVolMl);

        if (target.kind === 'vessel' && !target.isShattered) {
          const tSpec = APPARATUS[target.typeId];
          const cDstBefore = computeHeatCapacityJK(target);
          const oldDstPhen = target.moles.Phenolphthalein_aq || 0;
          const oldDstBleach = target.phenBleachFrac || 0;
          const { movedHeatCapJK, movedPhenMol } = moveFluidFraction(
            vessel.tubeMoles,
            null,
            fracSpill,
            target.moles,
            true
          );
          if (cDstBefore + movedHeatCapJK > 0) {
            target.tempK =
              (cDstBefore * target.tempK + movedHeatCapJK * (vessel.tubeTempK || vessel.tempK)) /
              (cDstBefore + movedHeatCapJK);
          }
          if (movedPhenMol > 0) {
            const totP = oldDstPhen + movedPhenMol;
            target.phenBleachFrac =
              totP > 1e-14 ? (oldDstPhen * oldDstBleach + movedPhenMol * (vessel.tubePhenBleachFrac || 0)) / totP : 0;
          }
          vessel.tubeLiquidSpillRateMlS = spillMl / Math.max(1e-4, dt);
          vessel.tubeLiquidSpillColor = vessel.tubeColor;
          vessel.tubeLiquidFlowTimer = 0.55;
          if (!target.wasTubeReceiving) {
            target.wasTubeReceiving = true;
            this.addLog({ type: 'alert', key: 'alertTubeLiquidTransfer', vesselLabel: `${spec.id} ${vessel.label} → ${tSpec.id} ${target.label}` });
          }
          this.checkOverflow(target);
        } else if (target.kind === 'gas_syringe' && !target.isBroken) {
          if (!target.overflowMoles) target.overflowMoles = {};
          const cSyrBefore = computeSyringeHeatCapacityJK(target);
          const oldSyrPhen = target.overflowMoles.Phenolphthalein_aq || 0;
          const oldSyrBleach = target.overflowBleachFrac || 0;
          const { movedHeatCapJK, movedPhenMol } = moveFluidFraction(
            vessel.tubeMoles,
            null,
            fracSpill,
            target.overflowMoles,
            true
          );
          target.tempK =
            (cSyrBefore * (target.tempK ?? this.environment.tempK) +
              movedHeatCapJK * (vessel.tubeTempK || vessel.tempK)) /
            Math.max(1e-4, cSyrBefore + movedHeatCapJK);
          if (movedPhenMol > 0) {
            const totP = oldSyrPhen + movedPhenMol;
            target.overflowBleachFrac =
              totP > 1e-14 ? (oldSyrPhen * oldSyrBleach + movedPhenMol * (vessel.tubePhenBleachFrac || 0)) / totP : 0;
          }
          target.inflowLiquidRateMlS = spillMl / Math.max(1e-4, dt);
          target.inflowLiquidTimer = 0.5;
          target.inflowLiquidColor = vessel.tubeColor;
          vessel.tubeLiquidSpillRateMlS = target.inflowLiquidRateMlS;
          vessel.tubeLiquidSpillColor = vessel.tubeColor;
          vessel.tubeLiquidFlowTimer = 0.55;
        }
      }
      return;
    }

    // Case 1: Open vessel rim overflow waterfall
    if (totalMl <= brimMl + 0.02 || liqMl <= 0.02) {
      vessel.overflowRateMlS = 0;
      vessel.wasOverflowing = false;
      return;
    }

    const excessMl = totalMl - brimMl;
    const rateMlS = 36 + excessMl * 4.2;
    const drainMl = Math.min(liqMl, excessMl, rateMlS * dt);
    const fracRemove = Math.min(1, drainMl / liqMl);

    const vis = computeSolutionVisuals(
      vessel.moles,
      liqL,
      computePH(vessel.moles, liqL, vessel.tempK),
      spec.opticalPathCm,
      vessel.phenBleachFrac
    );
    vessel.overflowRateMlS = drainMl / Math.max(1e-4, dt);
    vessel.overflowColor = vis.css;
    vessel.spilledPuddleColor = vis.css;

    moveFluidFraction(vessel.moles, vessel.precipitateSettle, fracRemove, null, true);
  }

  /**
   * Drain excess liquid from a maxed-out 250 mL Gas Syringe with rear collar spray.
   */
  stepSyringeOverflow(syringe, dt) {
    if (!syringe || syringe.isBroken) return;
    const syrSpec = APPARATUS[syringe.typeId];
    const totalVolMl = computeSyringeTotalVolumeMl(syringe, this.environment);
    const liqVolMl = computeSyringeLiquidVolumeMl(syringe, this.environment);

    if (totalVolMl <= syrSpec.maxVolumeMl + 0.05 || liqVolMl <= 0.02) {
      syringe.overflowOutRateMlS = 0;
      syringe.wasOverflowing = false;
      return;
    }

    const excessMl = totalVolMl - syrSpec.maxVolumeMl;
    const drainMl = Math.min(liqVolMl, excessMl, (36 + excessMl * 4.5) * dt);
    const ovL = computeLiquidVolumeL(syringe.overflowMoles || {}, syringe.tempK ?? this.environment.tempK);
    const ovMl = ovL * 1000;

    let spillColor = 'rgba(186, 230, 253, 0.85)';
    if (ovMl > 0.01) {
      const vis = computeSolutionVisuals(
        syringe.overflowMoles,
        ovL,
        computePH(syringe.overflowMoles, ovL, syringe.tempK ?? this.environment.tempK),
        2.5,
        syringe.overflowBleachFrac || 0
      );
      spillColor = vis.css;
      const takeFromOv = Math.min(ovMl, drainMl);
      moveFluidFraction(syringe.overflowMoles, null, Math.min(1, takeFromOv / ovMl), null, true);
      const leftover = drainMl - takeFromOv;
      if (leftover > 1e-4 && (syringe.condensedWaterMol || 0) > 0) {
        const dropMol = (leftover * 0.997) / SPECIES.H2O_l.molarMass;
        syringe.condensedWaterMol = Math.max(0, syringe.condensedWaterMol - dropMol);
      }
    } else if ((syringe.condensedWaterMol || 0) > 0) {
      const dropMol = (drainMl * 0.997) / SPECIES.H2O_l.molarMass;
      syringe.condensedWaterMol = Math.max(0, syringe.condensedWaterMol - dropMol);
    }

    syringe.overflowOutRateMlS = drainMl / Math.max(1e-4, dt);
    syringe.overflowOutColor = spillColor;
    if (!syringe.wasOverflowing) {
      syringe.wasOverflowing = true;
      this.addLog({ type: 'alert', key: 'alertSyringeOverflow', vesselLabel: syringe.label });
      if (this.visualHooks.onAlert) {
        this.visualHooks.onAlert('syringe_overflow', syringe, { liquidColor: spillColor });
      }
    }
  }

  recordHistorySnapshot(vessel, force = false) {
    if (!vessel || !Array.isArray(vessel.history) || vessel.kind !== 'vessel') return;
    const last = vessel.history[vessel.history.length - 1];
    if (!force && last && this.timeSec - last.t < 0.25) return;

    // Record key tracked species moles (mmol) for live chart
    const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
    const ph = computePH(vessel.moles, liqL, vessel.tempK);
    const snap = {};
    for (const [spId, n] of Object.entries(vessel.moles)) {
      if (n > 1e-7) snap[spId] = n;
    }
    // Track total permanent/acidic gases generated (escaped + syringe + headspace)
    const syr = vessel.connectedSyringeId ? this.getItem(vessel.connectedSyringeId) : null;
    for (const [gId, snapKey] of [
      ['H2_g', 'H2_g_total'],
      ['HCl_g', 'HCl_g_total'],
      ['Cl2_g', 'Cl2_g_total'],
    ]) {
      const tot =
        (vessel.escapedGasMoles[gId] || 0) +
        (vessel.headspaceGasMoles[gId] || 0) +
        (syr?.gasMoles[gId] || 0);
      if (tot > 1e-7) snap[snapKey] = tot;
    }

    vessel.history.push({
      t: this.timeSec,
      moles: snap,
      tempK: vessel.tempK,
      ph,
    });
    if (vessel.history.length > 140) {
      vessel.history.shift();
    }
  }

  /**
   * Shatter a vessel from overpressure or thermal/H2 explosion and spill all contents.
   */
  shatterVessel(vessel, logKey, alertKind) {
    const spec = APPARATUS[vessel.typeId];
    const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
    const hadLiquid = liqL > 1e-6;
    const vis = hadLiquid
      ? computeSolutionVisuals(
          vessel.moles,
          liqL,
          computePH(vessel.moles, liqL, vessel.tempK),
          spec.opticalPathCm,
          vessel.phenBleachFrac,
          vessel.phenIrrevFrac || 0
        )
      : null;
    const burstMeta = {
      hadLiquid,
      liquidColor: vis ? vis.css : null,
      liquidMl: liqL * 1000,
      vesselWidth: spec.width,
      vesselHeight: spec.height,
    };

    for (const [gId, n] of Object.entries(vessel.headspaceGasMoles || {})) {
      if (n > 0) {
        vessel.escapedGasMoles[gId] = (vessel.escapedGasMoles[gId] || 0) + n;
      }
    }

    vessel.isShattered = true;
    vessel.isStoppered = false;
    vessel.clampedToId = null;
    vessel.fallStartY = vessel.y;
    this.disconnectSyringe(vessel.id);
    vessel.moles = {};
    vessel.headspaceGasMoles = {};
    vessel.precipitateSettle = {};
    vessel.suspensionLevel = 0;
    vessel.phenBleachFrac = 0;
    vessel.phenIrrevFrac = 0;
    vessel.gardenActive = false;
    vessel.gardenGrowth = 0;
    vessel.hasPhenCotton = false;
    vessel.phenCottonLevel = 0;
    vessel.naHazardFlag = false;
    vessel.overflowRateMlS = 0;
    vessel.overflowColor = null;
    vessel.wasOverflowing = false;
    vessel.spilledPuddleColor = vis ? vis.css : null;
    vessel.activeReactions = [];
    vessel.wasBoiling = false;
    vessel.gasOutBannerTimer = 0;
    vessel.tubeFlowBannerTimer = 0;
    vessel.wallCondenseLevel = 0;
    vessel.internalPressureBar = this.environment.pressureBar;

    this.addLog({ type: 'alert', key: logKey, vesselLabel: vessel.label });
    this.recordHistorySnapshot(vessel, true);
    if (this.visualHooks.onAlert) {
      this.visualHooks.onAlert(alertKind, vessel, burstMeta);
    }
  }

  shatterSyringe(syringe, logKey = 'alertSyringeOverpressureShatter') {
    if (!syringe || syringe.isBroken) return;
    const sSpec = APPARATUS[syringe.typeId] || APPARATUS.gas_syringe;
    const syrT = syringe.tempK ?? this.environment.tempK;
    const liqMl = computeSyringeLiquidVolumeMl(syringe, this.environment);
    const combMoles = buildCombinedSyringeLiquidMoles(syringe);
    const combL = computeLiquidVolumeL(combMoles, syrT);
    const vis = combL > 1e-7
      ? computeSolutionVisuals(combMoles, combL, computePH(combMoles, combL, syrT), 2.5, syringe.overflowBleachFrac || 0)
      : null;

    if (syringe.connectedFromId) {
      this.disconnectSyringe(syringe.connectedFromId);
    }
    syringe.isBroken = true;
    syringe.clampedToId = null;
    syringe.fallStartY = syringe.y;
    syringe.isDischarging = false;
    syringe.autoDischargeTimer = 0;
    syringe.dischargeLiquidRateMlS = 0;
    syringe.gasMoles = createEmptyGasMap();
    syringe.condensedWaterMol = 0;
    syringe.condensedEtOHMol = 0;
    syringe.frozenWaterMol = 0;
    syringe.nh4clSmokeTimer = 0;
    syringe.overflowMoles = {};
    syringe.overflowBleachFrac = 0;
    syringe.internalPressureBar = this.environment.pressureBar;
    syringe.spilledPuddleColor = vis ? vis.css : null;

    this.addLog({ type: 'alert', key: logKey, vesselLabel: syringe.label });
    if (this.visualHooks.onAlert) {
      this.visualHooks.onAlert('shatter', syringe, {
        hadLiquid: liqMl > 0.02,
        liquidColor: vis ? vis.css : null,
        liquidMl: liqMl,
        vesselWidth: sSpec.width * 0.72,
        vesselHeight: sSpec.height,
      });
    }
  }

  popSyringePlunger(vessel, syringe) {
    if (!syringe || syringe.isBroken) return;
    const syrT = syringe.tempK ?? this.environment.tempK;
    const liqMl = computeSyringeLiquidVolumeMl(syringe, this.environment);
    const combMoles = buildCombinedSyringeLiquidMoles(syringe);
    const combL = computeLiquidVolumeL(combMoles, syrT);
    const vis = combL > 1e-7
      ? computeSolutionVisuals(combMoles, combL, computePH(combMoles, combL, syrT), 2.5, syringe.overflowBleachFrac || 0)
      : null;

    if (vessel) {
      vessel.isStoppered = false;
      this.disconnectSyringe(vessel.id);
      for (const g of ALL_GASES) {
        vessel.escapedGasMoles[g] = (vessel.escapedGasMoles[g] || 0) + (vessel.headspaceGasMoles[g] || 0);
        vessel.headspaceGasMoles[g] = 0;
      }
      vessel.sealedAirMoles = null;
      vessel.internalPressureBar = this.environment.pressureBar;
    }
    syringe.gasMoles = createEmptyGasMap();
    syringe.condensedWaterMol = 0;
    syringe.condensedEtOHMol = 0;
    syringe.frozenWaterMol = 0;
    syringe.nh4clSmokeTimer = 0;
    syringe.overflowMoles = {};
    syringe.overflowBleachFrac = 0;
    syringe.internalPressureBar = this.environment.pressureBar;

    this.addLog({ type: 'alert', key: 'alertSyringePlungerPop', vesselLabel: syringe.label });
    if (this.visualHooks.onAlert) {
      this.visualHooks.onAlert('syringe_plunger_pop', syringe, {
        hadLiquid: liqMl > 0.05,
        liquidColor: vis ? vis.css : null,
        liquidMl: liqMl,
      });
    }
  }

  breakPipetteOnDrop(pip) {
    if (!pip || pip.isBroken) return;
    const hadLiq = (pip.volumeMl || 0) > 0.02;
    const color = pip.liquidColor || 'rgba(186, 230, 253, 0.85)';
    pip.isBroken = true;
    pip.volumeMl = 0;
    pip.moles = {};
    pip.sourceLabel = '';
    pip.liquidColor = null;
    this.addLog({ type: 'alert', key: 'alertPipetteBreak', vesselLabel: pip.label });
    if (this.visualHooks.onAlert) {
      this.visualHooks.onAlert('shatter', pip, {
        hadLiquid: hadLiq,
        liquidColor: color,
        liquidMl: 8,
        vesselWidth: 28,
        vesselHeight: 90,
      });
    }
  }

  breakToolOnDrop(item) {
    if (!item || item.isBroken) return;
    const spec = APPARATUS[item.typeId] || {};
    let hadLiq = false;
    let liqMl = 0;
    let liqCol = 'rgba(186, 230, 253, 0.85)';
    if (item.moles) {
      const l = computeLiquidVolumeL(item.moles, item.tempK || this.environment.tempK);
      liqMl = l * 1000;
      hadLiq = liqMl > 0.05;
      if (hadLiq) {
        liqCol = computeSolutionVisuals(item.moles, l, computePH(item.moles, l, item.tempK || this.environment.tempK), 2.5, item.phenBleachFrac || 0).css;
      }
      item.moles = {};
      if (item.particleCounts) item.particleCounts = {};
      if (item.precipitateSettle) item.precipitateSettle = {};
    }
    if (item.kind === 'condenser') {
      if (item.connectedFromId) this.disconnectSyringe(item.connectedFromId);
      item.outletTargetId = null;
      item.waterFlowOn = false;
      item.activeDrop = false;
    }
    if (item.kind === 'salt_bridge') {
      item.vesselAId = null;
      item.vesselBId = null;
      item.activeCurrentA = 0;
    }
    if (item.kind === 'burette') {
      item.valveRateMlS = 0;
      item.streamingNow = false;
    }
    if (item.kind === 'filter_funnel') {
      item.mountedOnVesselId = null;
      item.isFiltering = false;
    }
    item.clampedToId = null;
    item.restingOnId = null;
    item.isBroken = true;
    item.spilledPuddleColor = hadLiq ? liqCol : null;
    this.addLog({ type: 'alert', key: 'alertToolBreak', vesselLabel: item.label });
    if (this.visualHooks.onAlert) {
      this.visualHooks.onAlert('shatter', item, {
        hadLiquid: hadLiq,
        liquidColor: liqCol,
        liquidMl: liqMl,
        vesselWidth: spec.width || 48,
        vesselHeight: spec.height || 90,
      });
    }
  }

  handleLandingImpact(item, dropDistPx, impactVy, support) {
    if (!item || item.isDragging) return;
    const spec = APPARATUS[item.typeId];
    if (!spec) return;

    // Supports (scales/burners/stands) thud & damp without shattering
    if (item.kind === 'scale' || item.kind === 'burner' || item.kind === 'stand') {
      if (dropDistPx >= 95) {
        item.landingTiltVel = (Math.random() < 0.5 ? -1 : 1) * 1.4;
      }
      return;
    }

    const canBreak = spec.breakable !== false && spec.fragilityDropPx !== Infinity;
    const shatterThreshold = spec.fragilityDropPx || 195;
    if (canBreak && dropDistPx >= shatterThreshold) {
      if (item.kind === 'vessel' && !item.isShattered) {
        this.shatterVessel(item, 'alertDropShatter', 'shatter');
      } else if (item.kind === 'gas_syringe' && !item.isBroken) {
        this.shatterSyringe(item, 'alertSyringeDropShatter');
      } else if (item.kind === 'pipette' && !item.isBroken) {
        this.breakPipetteOnDrop(item);
      } else if (
        !item.isBroken &&
        (item.kind === 'burette' || item.kind === 'condenser' || item.kind === 'salt_bridge' || item.kind === 'filter_funnel')
      ) {
        this.breakToolOnDrop(item);
      }
      return;
    }

    // Medium drop (112 .. shatterThreshold px): rock violently & slosh-spill open liquid
    if (dropDistPx >= 112) {
      const sign = Math.random() < 0.5 ? -1 : 1;
      item.landingTiltVel = sign * Math.min(5.2, 2.0 + (dropDistPx - 112) * 0.032);

      if (item.kind === 'vessel' && !item.isShattered) {
        const liqL = computeLiquidVolumeL(item.moles, item.tempK);
        const liqMl = liqL * 1000;
        if (!item.isStoppered && liqMl > 0.2) {
          const fillFrac = Math.min(1, liqMl / Math.max(1, spec.maxVolumeMl));
          const spillFrac = Math.min(0.65, 0.14 + (dropDistPx - 112) * 0.0028 + fillFrac * 0.25);
          const vis = computeSolutionVisuals(
            item.moles,
            liqL,
            computePH(item.moles, liqL, item.tempK),
            spec.opticalPathCm,
            item.phenBleachFrac
          );
          moveFluidFraction(item.moles, item.precipitateSettle, spillFrac, null, true);
          item.spilledPuddleColor = vis.css;
          this.addLog({ type: 'alert', key: 'alertDropSpill', vesselLabel: `${spec.id} ${item.label}` });
          if (this.visualHooks.onAlert) {
            this.visualHooks.onAlert('drop_spill', item, {
              liquidColor: vis.css,
              liquidMl: liqMl * spillFrac,
              vesselWidth: spec.width,
              vesselHeight: spec.height,
            });
          }
        } else if (item.isStoppered && dropDistPx >= 145 && liqMl > spec.maxVolumeMl * 0.85) {
          this.popStopper(item, 'alertHydroOverflowPop', { hydraulic: true });
        }
      } else if (item.kind === 'gas_syringe' && !item.isBroken) {
        const syrLiqMl = computeSyringeLiquidVolumeMl(item, this.environment);
        if (syrLiqMl > 0.2) {
          const syrT = item.tempK ?? this.environment.tempK;
          const combMoles = buildCombinedSyringeLiquidMoles(item);
          const combL = computeLiquidVolumeL(combMoles, syrT);
          const vis = combL > 1e-8
            ? computeSolutionVisuals(combMoles, combL, computePH(combMoles, combL, syrT), 2.5, item.overflowBleachFrac || 0)
            : { css: 'rgba(186, 230, 253, 0.85)' };
          extractSyringeLiquidFraction(item, 0.28, null);
          item.spilledPuddleColor = vis.css;
          if (this.visualHooks.onAlert) {
            this.visualHooks.onAlert('drop_spill', item, {
              liquidColor: vis.css,
              liquidMl: syrLiqMl * 0.28,
              vesselWidth: spec.width * 0.5,
              vesselHeight: spec.height,
            });
          }
        }
      } else if (item.kind === 'pipette' && !item.isBroken && (item.volumeMl || 0) > 0.05) {
        const col = item.liquidColor || 'rgba(186, 230, 253, 0.85)';
        const lostMl = (item.volumeMl || 0) * 0.65;
        for (const [k, n] of Object.entries(item.moles)) {
          item.moles[k] = n * 0.35;
        }
        item.volumeMl = (item.volumeMl || 0) * 0.35;
        if (this.visualHooks.onAlert) {
          this.visualHooks.onAlert('drop_spill', item, {
            liquidColor: col,
            liquidMl: lostMl,
            vesselWidth: 26,
            vesselHeight: spec.height,
          });
        }
      }
    }
  }

  stepGravityPhysics(dt, realDeltaSec) {
    const gPx = CONSTANTS.GRAVITY_PX_S2 || 1800;

    // 1. Update rotational impact wobble recovery cleanly even when resting
    for (const item of this.items) {
      if (Math.abs(item.landingTilt || 0) > 1e-4 || Math.abs(item.landingTiltVel || 0) > 1e-4) {
        const kSpring = 115;
        const cDamp = 9.5;
        const acc = -kSpring * (item.landingTilt || 0) - cDamp * (item.landingTiltVel || 0);
        item.landingTiltVel = (item.landingTiltVel || 0) + acc * realDeltaSec;
        item.landingTilt = (item.landingTilt || 0) + item.landingTiltVel * realDeltaSec;
        if (Math.abs(item.landingTilt) < 0.002 && Math.abs(item.landingTiltVel) < 0.02) {
          item.landingTilt = 0;
          item.landingTiltVel = 0;
        }
      }
    }

    // 2. Step vertical gravitational fall (process support bases before items resting/clamped on them)
    const gravityOrder = [
      ...this.items.filter((it) => it.kind === 'scale' || it.kind === 'burner' || it.kind === 'stand'),
      ...this.items.filter((it) => it.kind !== 'scale' && it.kind !== 'burner' && it.kind !== 'stand'),
    ];
    for (const item of gravityOrder) {
      if (item.isDragging) {
        item.vy = 0;
        item.fallStartY = item.y;
        continue;
      }

      if (item.dockedVesselId || item.inVesselId || item.mountedOnVesselId) {
        continue;
      }

      if (item.clampedToId) {
        const stand = this.getItem(item.clampedToId);
        // Shattered/broken glassware cannot stay suspended in a clamp — release to fall naturally
        if (stand && stand.kind === 'stand' && !item.isShattered && !item.isBroken) {
          item.vy = 0;
          item.fallStartY = null;
          item.restingOnId = null;
          item.y = clampItemToStandY(APPARATUS[item.typeId], stand, SIM_BENCH_FLOOR_Y, item.y, 4);
          continue;
        }
        item.clampedToId = null;
        item.fallStartY = item.fallStartY ?? item.y;
      }

      const { centerY, support } = this.getSupportSurfaceForItem(item);
      if (support && item.restingOnId === support.id) {
        // Keep items already seated on a scale/burner riding smoothly if the support itself settles
        item.y = centerY;
        item.vy = support.vy || 0;
        item.fallStartY = null;
        continue;
      }

      const isFloating = item.y < centerY - 1.5;

      if (!isFloating && (item.vy || 0) <= 0) {
        item.y = centerY;
        item.restingOnId = support ? support.id : null;
        item.fallStartY = null;
        item.vy = 0;
        continue;
      }

      // Item is airborne -> apply downward acceleration
      if (item.fallStartY == null) {
        item.fallStartY = item.y;
      }
      const prevY = item.y;
      item.restingOnId = null;
      item.vy = (item.vy || 0) + gPx * dt;
      item.y += item.vy * dt;

      let didLand = false;
      let landDropDist = 0;
      let landVy = item.vy;
      if (item.y >= centerY) {
        didLand = true;
        landDropDist = Math.max(0, centerY - (item.fallStartY ?? centerY));
        item.y = centerY;
        item.vy = 0;
        item.fallStartY = null;
        item.restingOnId = support ? support.id : null;
        if (support && Math.abs(item.x - support.x) < 28) {
          item.x = support.x;
        }
        this.handleLandingImpact(item, landDropDist, landVy, support);
      }

      // Keep any vessel/syringe clamped to a falling Retort Stand moving locked to the stand rod!
      if (item.kind === 'stand') {
        const dyStand = item.y - prevY;
        for (const child of this.items) {
          if (child.clampedToId !== item.id) continue;
          if (child.isShattered || child.isBroken) {
            child.clampedToId = null;
            child.fallStartY = child.y;
            continue;
          }
          if (!child.isDragging && Math.abs(dyStand) > 1e-6) {
            child.y = clampItemToStandY(APPARATUS[child.typeId], item, SIM_BENCH_FLOOR_Y, child.y + dyStand, 4);
          }
          if (didLand && landDropDist >= 112) {
            this.handleLandingImpact(child, landDropDist * 0.9, landVy, item);
          }
        }
      }
    }
  }

  /**
   * Determine active Alcohol Burner heating source for a vessel:
   * - Direct contact (`vessel.restingOnId`) delivers 100% wattage
   * - Clamped or held vessels positioned over a lit burner's flame plume/tripod receive geometric convective coupling
   */
  getBurnerHeatingSource(vessel) {
    if (!vessel || vessel.kind !== 'vessel' || vessel.isShattered) return null;
    const vSpec = APPARATUS[vessel.typeId];
    if (!vSpec?.heatable) return null;
    const bSpec = APPARATUS.burner;

    if (vessel.restingOnId) {
      const sup = this.getItem(vessel.restingOnId);
      if (sup && sup.kind === 'burner') {
        const fl = sup.flameLevel || 0;
        const pw = sup.powerW ?? bSpec.powerLevelsW[Math.round(fl)] ?? 0;
        return { burner: sup, flameLevel: fl, powerW: pw };
      }
    }

    // Check spatial proximity above any lit burner (supports Retort Stand clamped flasks/test tubes)
    let best = null;
    const vBot = vessel.y + vSpec.height / 2;
    const horizMax = Math.max(46, 36 + vSpec.width * 0.25);
    for (const b of this.items) {
      if (b.kind !== 'burner') continue;
      const fl = b.flameLevel || 0;
      const rawW = b.powerW ?? bSpec.powerLevelsW[Math.round(fl)] ?? 0;
      if (rawW <= 0) continue;

      const dx = Math.abs(vessel.x - b.x);
      if (dx > horizMax) continue;

      const bnTop = b.y - bSpec.height / 2 + 10; // Gauze support level
      const flameBaseY = b.y + bSpec.height / 2 - 46; // Wick collar top
      if (vBot > flameBaseY + 14) continue; // Vessel sits below burner base reservoir

      const horizFrac = dx <= 34 ? 1.0 : Math.max(0, 1 - (dx - 34) / Math.max(10, horizMax - 34));
      const powerFrac = Math.min(1, rawW / (bSpec.maxPowerW || 650));
      const maxPlumeAbove = 72 + 68 * powerFrac;

      let vertFrac = 0;
      if (vBot >= bnTop - 16) {
        // Vessel sits directly on or just inside tripod flame zone
        vertFrac = 1.0;
      } else {
        const gapAbove = (bnTop - 16) - vBot;
        if (gapAbove < maxPlumeAbove) {
          vertFrac = Math.pow(1 - gapAbove / maxPlumeAbove, 1.35);
        }
      }

      const effW = rawW * horizFrac * vertFrac;
      if (effW > 1 && (!best || effW > best.powerW)) {
        best = { burner: b, flameLevel: fl * horizFrac * vertFrac, powerW: effW };
      }
    }
    return best;
  }

  /**
   * Condense/freeze ambient escaped H2O(g) into surface frost whenever ambient T < 273.15 K.
   */
  condenseEscapedVaporInCryo() {
    if (this.environment.tempK >= CONSTANTS.T_FREEZE_WATER_K) return;
    for (const v of this.items) {
      if (v.kind !== 'vessel' || v.isShattered || !v.escapedGasMoles) continue;
      const nH2O = v.escapedGasMoles.H2O_g || 0;
      if (nH2O > 0) {
        v.escapedFrostH2OMol = (v.escapedFrostH2OMol || 0) + nH2O;
        v.escapedGasMoles.H2O_g = 0;
      }
    }
  }

  /**
   * Update ambient laboratory temperature (K) and immediately deposit cold escaped steam into frost.
   */
  setAmbientTempK(tempK) {
    const val = Math.max(200, Math.min(450, Number(tempK) || CONSTANTS.T_STD_K));
    this.environment.tempK = val;
    this.condenseEscapedVaporInCryo();
    this.emitChange();
  }

  setUvLight(on) {
    this.environment.uvLight = Boolean(on);
    this.emitChange();
  }

  /**
   * Pour liquid and loose solids downward under gravity whenever an open inverted vessel is held in air
   * (unstoppered and not submerged inside a pneumatic water trough).
   */
  stepInvertedGravitySpill(v, dt) {
    v.gravitySpillRateMlS = 0;
    v.gravitySpillColor = null;
    if (!v || v.kind !== 'vessel' || v.isShattered || !v.isInverted || v.isStoppered || v.submergedInTroughId) {
      return;
    }
    const spec = APPARATUS[v.typeId];
    const liqL = computeLiquidVolumeL(v.moles, v.tempK);
    const liqMl = liqL * 1000;
    let hasSolids = false;
    for (const [id, n] of Object.entries(v.moles || {})) {
      if (n > 1e-8 && SPECIES[id]?.phase === 's') {
        hasSolids = true;
        break;
      }
    }
    if (liqMl <= 0.02 && !hasSolids) return;

    const mouthY = v.y + spec.height / 2;
    const dst = this.items.find((other) => {
      if (other.id === v.id || other.kind !== 'vessel' || other.isShattered || other.isStoppered || other.isInverted) {
        return false;
      }
      const oSpec = APPARATUS[other.typeId];
      const oRimY = other.y - oSpec.height / 2;
      const halfMouth = Math.max(22, oSpec.neckRadius || oSpec.width * 0.42);
      return Math.abs(other.x - v.x) <= halfMouth + 14 && oRimY >= mouthY - 22 && oRimY - mouthY <= 280;
    });

    const vis =
      liqL > 1e-6
        ? computeSolutionVisuals(v.moles, liqL, computePH(v.moles, liqL, v.tempK), spec.opticalPathCm, v.phenBleachFrac, v.phenIrrevFrac || 0)
        : { css: 'rgba(186, 230, 253, 0.85)' };

    const spillRateMlS = Math.max(60, liqMl * 4.0);
    const drainFrac = liqMl > 0.02 ? Math.min(1, (spillRateMlS * dt) / Math.max(0.05, liqMl)) : 1.0;

    v.gravitySpillRateMlS = liqMl > 0.02 ? spillRateMlS : 12;
    v.gravitySpillColor = vis.css;

    const cMovedBase = dst ? computeHeatCapacityJK(dst) : 0;
    let cMoved = 0;
    for (const [spId, n] of Object.entries(v.moles)) {
      if (n <= 0) continue;
      const sp = SPECIES[spId];
      if (!sp) continue;
      const dm = drainFrac >= 0.999 ? n : n * drainFrac;
      v.moles[spId] = n - dm;
      if (v.moles[spId] < 1e-12) delete v.moles[spId];
      if (dst) {
        dst.moles[spId] = (dst.moles[spId] || 0) + dm;
        cMoved += dm * Math.max(0, sp.cp || 0);
      }
    }

    if (dst) {
      if (cMovedBase + cMoved > 0) {
        dst.tempK = (cMovedBase * dst.tempK + cMoved * v.tempK) / (cMovedBase + cMoved);
      }
      this.checkOverflow(dst);
    } else {
      v.spilledPuddleColor = vis.css;
      if (!v._gravSpillLogged && (liqMl > 0.5 || hasSolids)) {
        v._gravSpillLogged = true;
        this.addLog({ type: 'alert', key: 'alertGravitySpill', vesselLabel: v.label });
        if (this.visualHooks.onAlert) {
          this.visualHooks.onAlert('drop_spill', v, { liquidColor: vis.css, spilledMl: Math.min(40, Math.max(5, liqMl)) });
        }
      }
    }
  }

  /**
   * Phenomenon #2: Vacuum suction through tubing when stoppered flask pressure < ambient pressure
   * (e.g., Ammonia Fountain when NH3(g) dissolves rapidly into trace water).
   */
  stepAmmoniaFountainSuction(v, dt) {
    v.fountainFlowMlS = 0;
    v.fountainFlowColor = null;
    if (!v || v.kind !== 'vessel' || v.isShattered || !v.isStoppered || !v.connectedTargetId) return;
    const target = this.getItem(v.connectedTargetId);
    if (!target || target.kind !== 'vessel' || target.isShattered) return;

    const dpVac = this.environment.pressureBar - (v.internalPressureBar ?? this.environment.pressureBar);
    const tLiqL = computeLiquidVolumeL(target.moles, target.tempK);
    const tLiqMl = tLiqL * 1000;
    if (dpVac <= 0.045 || tLiqMl <= 0.05) return;

    const spec = APPARATUS[v.typeId];
    const vLiqMl = computeLiquidVolumeL(v.moles, v.tempK) * 1000;
    const roomMl = Math.max(0, spec.maxVolumeMl * 0.92 - vLiqMl);
    if (roomMl <= 0.5) return;

    const rateMlS = Math.min(46.0, 42.0 * Math.sqrt(dpVac));
    const pullMl = Math.min(tLiqMl - 0.02, roomMl, rateMlS * dt);
    if (pullMl <= 1e-4) return;
    const frac = Math.min(1, pullMl / tLiqMl);

    const oldPhen = v.moles.Phenolphthalein_aq || 0;
    const { movedPhenMol } = moveFluidFraction(target.moles, target.precipitateSettle, frac, v.moles, false);
    if (movedPhenMol > 0) {
      const totP = oldPhen + movedPhenMol;
      v.phenBleachFrac = totP > 1e-14 ? (oldPhen * (v.phenBleachFrac || 0) + movedPhenMol * (target.phenBleachFrac || 0)) / totP : 0;
    }

    const vLiqAfterL = computeLiquidVolumeL(v.moles, v.tempK);
    const fountainVis = computeSolutionVisuals(
      v.moles,
      Math.max(1e-4, vLiqAfterL),
      computePH(v.moles, Math.max(1e-4, vLiqAfterL), v.tempK),
      spec.opticalPathCm,
      v.phenBleachFrac,
      v.phenIrrevFrac || 0
    );
    v.fountainFlowMlS = pullMl / Math.max(1e-4, dt);
    v.fountainFlowColor = fountainVis.css;
    if (!v._fountainLogged) {
      v._fountainLogged = true;
      this.addLog({
        type: 'reaction',
        equation: 'NH₃(g) + H₂O(l) ⇌ NH₃(aq) (P_bình ≪ P_kq ⇒ Phun trào chân không!)',
        nameVi: 'Thí nghiệm Phun nước Ammonia (Chân không áp suất khí quyển)',
        nameEn: 'Ammonia Vacuum Fountain (atmospheric pressure surge)',
        descVi: 'NH₃ hòa tan mãnh liệt vào nước (~700 L khí / 1 L nước) làm áp suất bình tụt sâu, hút mạnh nước chỉ thị phun trào thành tia.',
        descEn: 'Ultra-high Ammonia solubility collapses internal pressure, forcing indicator water violently up the fountain tube.',
        vesselLabel: `${target.label} ⟹ ${v.label}`,
      });
      if (this.visualHooks.onAlert) {
        this.visualHooks.onAlert('ammonia_fountain', v, { liquidColor: fountainVis.css });
      }
    }
  }

  /**
   * Main simulation tick called by animation loop (realDeltaSec).
   */
  step(realDeltaSec) {
    // Always animate visual pipette suction & dispense timers smoothly even while paused
    for (const item of this.items) {
      if (item.kind !== 'pipette') continue;
      if (item.drawAnimTimer > 0) {
        item.drawAnimTimer = Math.max(0, item.drawAnimTimer - realDeltaSec);
      }
      if (item.dispenseAnimTimer > 0) {
        item.dispenseAnimTimer = Math.max(0, item.dispenseAnimTimer - realDeltaSec);
      }
    }

    if (this.environment.paused) return;

    this.condenseEscapedVaporInCryo();

    const scaledDt = Math.min(0.25, realDeltaSec * this.environment.speed);
    this.timeSec += scaledDt;

    if (this.activePourStream) {
      this.activePourStream.timer -= realDeltaSec;
      if (this.activePourStream.timer <= 0) this.activePourStream = null;
    }
    if (this.activeReagentTransfer) {
      const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.activeReagentTransfer.startMs;
      if (elapsedMs >= this.activeReagentTransfer.durationMs) {
        this.activeReagentTransfer = null;
      }
    }
    for (const b of this.items) {
      if (b.kind === 'burner' && (b.beilsteinTimer || 0) > 0) {
        b.beilsteinTimer = Math.max(0, b.beilsteinTimer - realDeltaSec);
      }
    }

    // Advance progressive reagent/vessel pour jobs synchronized with animations
    this.stepTimedTransfers();

    // Sub-step for numerical accuracy & smooth fast ionic kinetics
    const numSteps = Math.max(1, Math.ceil(scaledDt / CONSTANTS.SUBSTEP_MAX_DT));
    const dt = scaledDt / numSteps;

    // Advance rigid-body workbench gravity & landing impact physics
    this.stepGravityPhysics(scaledDt, realDeltaSec);

    const getApp = (id) => this.getItem(id);

    for (const v of this.items) {
      if (v.kind !== 'vessel') continue;

      if (v.stirTimer > 0) {
        v.stirTimer = Math.max(0, v.stirTimer - realDeltaSec);
      }

      if (v.isShattered) {
        v.activeReactions = [];
        v.overflowRateMlS = 0;
        v.fountainFlowMlS = 0;
        v.gravitySpillRateMlS = 0;
        for (let s = 0; s < numSteps; s++) {
          stepVesselThermodynamics(v, dt, this.environment, 0, 0);
        }
        continue;
      }

      v.troughOverfillRate = 0;

      // Gravity spill from open inverted vessels held in air (not submerged inside water trough)
      this.stepInvertedGravitySpill(v, scaledDt);

      // Atmospheric pressure Ammonia Fountain suction when stoppered connected flask is under vacuum
      this.stepAmmoniaFountainSuction(v, scaledDt);

      // Buoyant retention / gravitational sinking of gases in unstoppered open vessels (relAirDensity)
      stepOpenGasBuoyancy(v, this.environment, scaledDt);

      // Continuous gravity spillover above physical brim
      this.stepVesselOverflow(v, scaledDt);

      // Check burner power & flame level (resting directly on burner OR clamped/held over flame plume)
      const heatSrc = this.getBurnerHeatingSource(v);
      const burnerPowerW = heatSrc?.powerW || 0;
      const burnerFlameLevel = heatSrc?.flameLevel || 0;

      const frameGas = createZeroGasMap();
      let frameSteam = 0;
      let frameFreezeMeltMol = 0;
      let lastFreezePointK = v.freezePointK ?? CONSTANTS.T_FREEZE_WATER_K;
      let frameBoiling = false;
      let frameSteamOpacity = 0;
      let frameNaEvent = null;
      const frameActiveMap = new Map();

      for (let s = 0; s < numSteps; s++) {
        const chemRes = stepVesselChemistry(v, dt, { uvLight: this.environment.uvLight });
        const thermRes = stepVesselThermodynamics(
          v,
          dt,
          this.environment,
          chemRes.reactionHeatJ,
          burnerPowerW,
          burnerFlameLevel
        );
        frameFreezeMeltMol += (thermRes.freezeMeltRateMolS || 0) * dt;
        if (Number.isFinite(thermRes.freezePointK)) {
          lastFreezePointK = thermRes.freezePointK;
        }
        const dryRes = enforceDryPhaseBoundary(v);

        const combinedGas = createZeroGasMap();
        for (const gId of ALL_GAS_IDS) {
          combinedGas[gId] = (chemRes.gasProduced[gId] || 0) + (dryRes.gasProduced[gId] || 0);
        }
        combinedGas.HCl_g += thermRes.hclProducedMol || 0;
        combinedGas.NH3_g += thermRes.nh3ProducedMol || 0;
        combinedGas.C2H5OH_g += thermRes.ethanolProducedMol || 0;

        const gasEvents = stepVesselGasAndPressure(
          v,
          combinedGas,
          thermRes.steamProducedMol,
          this.environment,
          getApp
        );

        for (const gId of ALL_GAS_IDS) {
          if (gId !== 'H2O_g') frameGas[gId] += combinedGas[gId];
        }
        frameSteam += combinedGas.H2O_g + (thermRes.steamProducedMol || 0);
        if (thermRes.isBoiling) frameBoiling = true;
        if ((thermRes.steamOpacity || 0) > frameSteamOpacity) {
          frameSteamOpacity = thermRes.steamOpacity;
        }
        if (chemRes.naEvent === 'explosion' || (chemRes.naEvent === 'ignition_flame' && frameNaEvent !== 'explosion') || (!frameNaEvent && chemRes.naEvent)) {
          frameNaEvent = chemRes.naEvent;
        }

        for (const rxn of chemRes.activeReactions) {
          const prev = frameActiveMap.get(rxn.id);
          if (!prev) {
            frameActiveMap.set(rxn.id, { ...rxn });
          } else {
            prev.dXi += rxn.dXi;
            prev.rateMolS = rxn.rateMolS;
          }

          // Log first occurrence or re-trigger after pause
          const lastSeen = v.seenReactions[rxn.id] ?? -99;
          if (this.timeSec - lastSeen > 4.0) {
            this.addLog({
              type: 'reaction',
              equation: rxn.equation,
              nameVi: rxn.nameVi,
              nameEn: rxn.nameEn,
              descVi: rxn.descVi,
              descEn: rxn.descEn,
              vesselLabel: v.label,
            });
          }
          v.seenReactions[rxn.id] = this.timeSec;
        }

        for (const ev of gasEvents) {
          if (ev.type === 'stopper_pop') {
            this.popStopper(v, ev.implosion ? 'alertOverpressurePop' : 'alertOverpressurePop');
          } else if (ev.type === 'shatter') {
            this.shatterVessel(
              v,
              ev.implosion ? 'alertVacuumImplosion' : 'alertOverpressureShatter',
              'shatter'
            );
            break;
          } else if (ev.type === 'syringe_shatter') {
            const badSyr = this.getItem(ev.syringeId);
            if (badSyr) this.shatterSyringe(badSyr, 'alertSyringeOverpressureShatter');
          } else if (ev.type === 'syringe_plunger_pop') {
            const badSyr = this.getItem(ev.syringeId);
            if (badSyr) this.popSyringePlunger(v, badSyr);
          }
        }
        if (v.isShattered) break;
      }

      if (v.isShattered) continue;

      // Advance reversible phenolphthalein carbinol fading & high-temp irreversible C-C cleavage (locked while frozen solid)
      if ((v.moles.Phenolphthalein_aq || 0) > 1e-12) {
        if (!v.isFrozenSolid) {
          const liqL = computeLiquidVolumeL(v.moles, v.tempK);
          if (liqL > 1e-7) {
            const cOH = (v.moles.OH_aq || 0) / liqL;
            const cEthoxide = (v.moles.C2H5O_aq || 0) / liqL;
            const cH = (v.moles.H_aq || 0) / liqL;
            const eqBleach = computePhenolphthaleinBleachEq(cOH, cEthoxide);
            const curBleach = v.phenBleachFrac || 0;
            const tempFactor = Math.exp(Math.max(-1.5, Math.min(1.5, 0.025 * (v.tempK - CONSTANTS.T_STD_K))));
            const rate =
              curBleach < eqBleach
                ? 0.28 * Math.max(0.2, cOH + 2.2 * cEthoxide) * tempFactor
                : (0.55 + Math.min(3.0, cH * 1.5)) * tempFactor;
            v.phenBleachFrac = eqBleach + (curBleach - eqBleach) * Math.exp(-rate * scaledDt);

            // Irreversible Friedel-Crafts-reverse C-C cleavage in hot super-concentrated alkali (>=4.5 M OH-, >=65 °C)
            if (cOH >= 4.5 && v.tempK >= 338.15) {
              const kCleav =
                0.015 *
                Math.min(4.0, (cOH - 4.0) * 0.5) *
                Math.exp(Math.max(-2.0, Math.min(3.0, 0.045 * (v.tempK - 340.0))));
              const prevIrrev = v.phenIrrevFrac || 0;
              v.phenIrrevFrac = Math.min(1.0, prevIrrev + (1 - prevIrrev) * (1 - Math.exp(-kCleav * scaledDt)));
              if (prevIrrev < 0.25 && v.phenIrrevFrac >= 0.25 && (this.timeSec - (v.seenReactions.phen_cc_cleavage ?? -99)) > 6.0) {
                v.seenReactions.phen_cc_cleavage = this.timeSec;
                this.addLog({
                  type: 'reaction',
                  equation: 'In(OH)³⁻ (đỏ/không màu) —(NaOH đặc, t°)→ Phenol + 2-(4-hydroxybenzoyl)benzoate',
                  nameVi: 'Cắt mạch C–C bất thuận nghịch Phenolphthalein',
                  nameEn: 'Irreversible C–C cleavage of Phenolphthalein',
                  descVi: 'Kiềm siêu đặc nóng phá vỡ khung triphenylmethane; pha loãng hay thêm acid màu hồng vĩnh viễn không quay lại.',
                  descEn: 'Hot super-concentrated OH⁻ destroys the triphenylmethane skeleton; pink never recovers.',
                  vesselLabel: v.label,
                });
              }
            }

            // Irreversible alkaline peroxide quinonoid cleavage of Phenolphthalein (H2O2 + OH-/NH3)
            const cH2O2 = (v.moles.H2O2_aq || 0) / liqL;
            if (cH2O2 >= 0.05) {
              const phNow = computePH(v.moles, liqL, v.tempK) ?? 7.0;
              if (phNow >= 8.3) {
                const kBleachOx =
                  0.28 *
                  Math.min(4.0, cH2O2 * 0.45) *
                  Math.min(3.0, Math.pow(10, Math.min(2, phNow - 9.0))) *
                  tempFactor;
                const prevIrrevOx = v.phenIrrevFrac || 0;
                v.phenIrrevFrac = Math.min(1.0, prevIrrevOx + (1 - prevIrrevOx) * (1 - Math.exp(-kBleachOx * scaledDt)));
                if (prevIrrevOx < 0.35 && v.phenIrrevFrac >= 0.35 && (this.timeSec - (v.seenReactions.phen_h2o2_bleach ?? -99)) > 6.0) {
                  v.seenReactions.phen_h2o2_bleach = this.timeSec;
                  this.addLog({
                    type: 'reaction',
                    equation: 'Phenolphthalein (In²⁻ hồng) + H₂O₂ —(OH⁻/NH₃)→ Sản phẩm oxi hóa không màu',
                    nameVi: 'H₂O₂ kiềm tẩy màu bất thuận nghịch Phenolphthalein',
                    nameEn: 'Irreversible alkaline H₂O₂ bleaching of Phenolphthalein',
                    descVi: 'Trong môi trường kiềm, H₂O₂ oxi hóa cắt vòng quinonoid làm phai mất màu hồng chỉ thị vĩnh viễn.',
                    descEn: 'In alkaline solution, Hydrogen peroxide oxidatively cleaves the pink quinonoid dianion permanently.',
                    vesselLabel: v.label,
                  });
                }
              }
            }
          }
        }
      } else {
        v.phenBleachFrac = 0;
        v.phenIrrevFrac = 0;
      }

      // Ambient closed-system desiccant transfer (CuSO4·5H2O connected via tube to dry NaOH(s))
      if (v.isStoppered && v.connectedTargetId && (v.moles.CuSO4_5H2O_s || 0) > 1e-6 && (v.moles.H2O_l || 0) < 1e-4) {
        const desTgt = this.getItem(v.connectedTargetId);
        if (desTgt && desTgt.kind === 'vessel' && !desTgt.isShattered && desTgt.moles && (desTgt.moles.NaOH_s || 0) > 1e-4 && (desTgt.moles.H2O_l || 0) < 0.08) {
          const dDry = Math.min(v.moles.CuSO4_5H2O_s, 0.008 * scaledDt);
          if (dDry > 1e-11) {
            v.moles.CuSO4_5H2O_s -= dDry;
            if (v.moles.CuSO4_5H2O_s < 1e-13) delete v.moles.CuSO4_5H2O_s;
            v.moles.CuSO4_s = (v.moles.CuSO4_s || 0) + dDry;
            desTgt.moles.H2O_l = (desTgt.moles.H2O_l || 0) + 5 * dDry;
            if ((this.timeSec - (v.seenReactions.desiccant_dehydrate ?? -99)) > 8.0) {
              v.seenReactions.desiccant_dehydrate = this.timeSec;
              this.addLog({
                type: 'reaction',
                equation: 'CuSO₄·5H₂O(s) —(NaOH khan hút ẩm)→ CuSO₄(s) + 5H₂O',
                nameVi: 'Làm khan CuSO₄·5H₂O qua tác nhân hút ẩm NaOH rắn',
                nameEn: 'Desiccation of CuSO₄·5H₂O over hygroscopic NaOH(s)',
                descVi: 'NaOH rắn hút ẩm mạnh làm giảm áp suất hơi nước, tách dần nước kết tinh thành bột CuSO₄ trắng khan.',
                descEn: 'Hygroscopic NaOH draws out crystallization water, leaving white anhydrous CuSO₄.',
                vesselLabel: v.label,
              });
            }
          }
        }
      }

      // Phenolphthalein cotton plug response to escaping NH3(g) / HCl(g)
      if ((v.recentHalogenGasTimer || 0) > 0) {
        v.recentHalogenGasTimer = Math.max(0, v.recentHalogenGasTimer - realDeltaSec);
      }
      if (v.hasPhenCotton && !v.isStoppered) {
        if (frameGas.NH3_g > 1e-6) {
          v.phenCottonLevel = Math.min(1.0, (v.phenCottonLevel || 0) + realDeltaSec * 2.2);
        } else if (frameGas.HCl_g > 1e-6) {
          v.phenCottonLevel = Math.max(0, (v.phenCottonLevel || 0) - realDeltaSec * 2.5);
        } else {
          v.phenCottonLevel = Math.max(0, (v.phenCottonLevel || 0) - realDeltaSec * 0.04);
        }
      } else if (!v.hasPhenCotton) {
        v.phenCottonLevel = 0;
      }

      // Beilstein green copper flame test when vessel over lit burner holds any Cu metal/alloy + halogen vapor
      if (heatSrc?.burner && burnerPowerW > 0) {
        const sup = heatSrc.burner;
        const hasCuMetal = Object.entries(v.moles).some(([id, n]) => n > 1e-6 && SPECIES[id]?.isCopperMetal);
        const hasHalogenPlume =
          (v.recentHalogenGasTimer || 0) > 0 ||
          frameGas.C2H5Cl_g > 1e-7 ||
          frameGas.Cl2_g > 1e-7 ||
          frameGas.HCl_g > 1e-6;
        if (sup && hasCuMetal && hasHalogenPlume) {
          sup.beilsteinTimer = 2.0;
          if ((this.timeSec - (v.seenReactions.beilstein_test ?? -99)) > 5.0) {
            v.seenReactions.beilstein_test = this.timeSec;
            this.addLog({
              type: 'reaction',
              equation: 'C₂H₅Cl(g) + Cu(s) —(lửa)→ hơi CuCl₂* (ngọn lửa xanh lục Beilstein)',
              nameVi: 'Thử nghiệm Beilstein: Ngọn lửa nhuốm màu xanh lục',
              nameEn: 'Beilstein flame test: Emerald green CuCl₂ emission',
              descVi: 'Khí dẫn xuất halogen tiếp xúc đồng kim loại trên ngọn lửa tạo hơi CuCl₂ kích thích phát ánh sáng xanh lục đặc trưng.',
              descEn: 'Halogenated vapor contacting hot Copper on the flame emits characteristic Beilstein emerald-green light.',
              vesselLabel: v.label,
            });
          }
        }
      }

      v.freezePointK = lastFreezePointK;
      const netFreezeRate = frameFreezeMeltMol / Math.max(1e-4, scaledDt);
      v.lastFreezeMeltRateMolS = netFreezeRate;
      if (netFreezeRate > 1e-4 && !frameActiveMap.has('water_freeze')) {
        frameActiveMap.set('water_freeze', {
          id: 'water_freeze',
          equation: 'H₂O(l) → H₂O(s) (đông đặc, ΔH_fus = -6.01 kJ/mol)',
          nameVi: 'Đóng băng nước tạo tinh thể băng H₂O(s)',
          nameEn: 'Freezing of liquid water into crystalline ice H₂O(s)',
          descVi: 'Nhiệt độ hạ xuống dưới điểm đóng băng khiến pha lỏng kết tinh thành băng rắn, giữ nhiệt độ tại plateau T_f.',
          descEn: 'Liquid water freezes into solid ice below T_f, holding temperature on the freezing plateau.',
          rateMolS: netFreezeRate,
          vigorousGas: false,
          dXi: frameFreezeMeltMol,
        });
      } else if (netFreezeRate < -1e-4 && !frameActiveMap.has('water_melt')) {
        frameActiveMap.set('water_melt', {
          id: 'water_melt',
          equation: 'H₂O(s) → H₂O(l) (nóng chảy, ΔH_fus = +6.01 kJ/mol)',
          nameVi: 'Nóng chảy băng H₂O(s) thành nước lỏng',
          nameEn: 'Melting of crystalline ice H₂O(s) into liquid water',
          descVi: 'Thu ẩn nhiệt nóng chảy để chuyển tinh thể băng thành pha lỏng, giữ nhiệt độ tại plateau T_melt.',
          descEn: 'Absorbs latent heat of fusion to melt solid ice back into liquid water at T_melt.',
          rateMolS: Math.abs(netFreezeRate),
          vigorousGas: false,
          dXi: Math.abs(frameFreezeMeltMol),
        });
      }

      if (this.environment.tempK >= CONSTANTS.T_FREEZE_WATER_K && (v.escapedFrostH2OMol || 0) > 0) {
        const dSubl = Math.min(v.escapedFrostH2OMol, 0.02 * scaledDt);
        v.escapedFrostH2OMol -= dSubl;
        if (v.escapedFrostH2OMol < 1e-9) v.escapedFrostH2OMol = 0;
        v.escapedGasMoles.H2O_g = (v.escapedGasMoles.H2O_g || 0) + dSubl;
      }

      v.activeReactions = Array.from(frameActiveMap.values());

      // Two-temperature coupled Sodium Coulomb explosion / ignition shatter
      if (!v.isShattered && frameNaEvent === 'explosion') {
        const maxStress = APPARATUS[v.typeId]?.maxThermalStressK || 550;
        if (maxStress >= 1000 && !v.naHazardFlag) {
          v.naTempK = Math.min(v.naTempK || 720, 740);
          if (this.visualHooks.onAlert) {
            this.visualHooks.onAlert('o2_relight', { x: v.x, y: v.y - 12 }, { vesselId: v.id });
          }
        } else {
          const alertKey = v.naHazardFlag ? 'alertNaHazardExplosion' : 'alertNaExplosion';
          this.shatterVessel(v, alertKey, 'explosion');
          continue;
        }
      }

      // Boiling alert
      if (frameBoiling && !v.wasBoiling) {
        this.addLog({ type: 'alert', key: 'alertBoiling', vesselLabel: v.label });
      }
      v.wasBoiling = frameBoiling;

      // Update precipitate settling (~12-15s undisturbed rest) & suspension decay (locked in frozen matrix)
      const vigAgitation = !v.isFrozenSolid && (v.stirTimer > 0 || frameGas.H2_g > 1e-5 || frameBoiling);
      if (!v.isFrozenSolid) {
        if (vigAgitation) {
          v.suspensionLevel = Math.min(1.0, (v.suspensionLevel || 0) + 0.65 * realDeltaSec);
        } else {
          v.suspensionLevel = Math.max(0, (v.suspensionLevel || 0) - 0.078 * realDeltaSec);
        }
        for (const [spId, n] of Object.entries(v.moles)) {
          const sp = SPECIES[spId];
          if (sp && sp.isPrecipitate && n > 1e-8) {
            const prev = v.precipitateSettle[spId] ?? 0.0;
            // Precipitates settle gradually over ~12.5s unless stirred, boiling, or vigorously bubbling
            const isDenseMetal = Boolean(sp.isDenseMetal);
            const settleSpeed = vigAgitation ? (isDenseMetal ? -0.25 : -0.45) : (isDenseMetal ? 0.55 : 0.08);
            v.precipitateSettle[spId] = Math.max(0.0, Math.min(1.0, prev + settleSpeed * realDeltaSec));
          }
        }
      }
      for (const spId of Object.keys(v.precipitateSettle)) {
        if (!v.moles[spId] || v.moles[spId] < 1e-9) {
          delete v.precipitateSettle[spId];
        }
      }

      // Sodium motion on meniscus (wide surface skitters freely; narrow surface pins against glass wall; muted on bare ice)
      const naActive =
        frameActiveMap.has('na_water') ||
        frameActiveMap.has('na_acid') ||
        frameActiveMap.has('na_ethanol') ||
        frameActiveMap.has('na_ice');
      const isDehydrating = frameActiveMap.has('dehydrate_cuso4_5h2o');
      if (naActive && (v.moles.Na_s || 0) > 1e-7) {
        const naMotionScale = (v.moles.H2O_l || 0) > 5e-4 ? 1.0 : 0.2;
        if (v.naPinned) {
          // Wall-pinned Sodium clings violently near glass wall edge
          const pinTarget = v.naPosRatio >= 0.5 ? 0.88 : 0.12;
          v.naPosRatio += (pinTarget - v.naPosRatio) * Math.min(1, realDeltaSec * 8 * naMotionScale);
        } else {
          v.naVisualPhase += realDeltaSec * 8.5 * naMotionScale;
          v.naPosRatio += v.naVel * realDeltaSec * (0.8 + Math.sin(v.naVisualPhase) * 0.6) * naMotionScale;
          if (v.naPosRatio > 0.84) {
            v.naPosRatio = 0.84;
            v.naVel = -Math.abs(v.naVel);
          } else if (v.naPosRatio < 0.16) {
            v.naPosRatio = 0.16;
            v.naVel = Math.abs(v.naVel);
          }
        }
      }

      // Compute evolving gas/steam telemetry & optically-accurate fog/condensation state
      const invDt = 1 / Math.max(1e-4, scaledDt);
      const rateMap = createZeroGasMap();
      let totalGasRate = 0;
      let visibleNonSteamRate = 0;
      for (const gId of ALL_GAS_IDS) {
        if (gId === 'H2O_g') continue;
        const r = (frameGas[gId] || 0) * invDt;
        rateMap[gId] = r;
        totalGasRate += r;
        if (gId !== 'HNO3_g') visibleNonSteamRate += r;
      }
      const rateSteam = frameSteam * invDt;
      rateMap.H2O_g = rateSteam;
      totalGasRate += rateSteam;

      const curSteamOpacity =
        v.isFrozenSolid && !isDehydrating
          ? 0
          : frameBoiling
          ? 1.0
          : isDehydrating
          ? Math.max(0.65, computeSteamOpacity(v.tempK, this.environment.tempK, CONSTANTS.RELATIVE_HUMIDITY))
          : Math.max(frameSteamOpacity, computeSteamOpacity(v.tempK, this.environment.tempK, CONSTANTS.RELATIVE_HUMIDITY));
      const steamVisible =
        !v.isFrozenSolid &&
        ((rateSteam > 3e-5 && curSteamOpacity > 0.04) || (frameBoiling && rateSteam > 1e-6) || isDehydrating);

      const labelOrder = ['C2H5Cl_g', 'NH3_g', 'NO2_g', 'NO_g', 'H2_g', 'O2_g', 'Cl2_g', 'HCl_g', 'C2H5OH_g'];
      const extraLabelIds = ALL_GAS_IDS.filter(
        (id) => id !== 'H2O_g' && id !== 'HNO3_g' && !labelOrder.includes(id)
      );
      const labels = [];
      for (const gId of [...labelOrder, ...extraLabelIds]) {
        const sp = SPECIES[gId];
        const thresh = sp?.bannerThresholdMolS ?? 2e-5;
        if ((rateMap[gId] || 0) > thresh) {
          labels.push(sp?.formula || gId);
        }
      }
      if (steamVisible) labels.push('H₂O(g)');
      const formulaSummary = labels.slice(0, 2).join(' + ');

      if (
        v.tempK >= CONSTANTS.T_FREEZE_WATER_K &&
        ((rateSteam > 4e-5 && curSteamOpacity > 0.12) || frameBoiling || (v.headspaceGasMoles?.H2O_g || 0) > 1e-5)
      ) {
        const targetCond = Math.min(1, 0.25 + curSteamOpacity * 0.65);
        v.wallCondenseLevel = Math.min(1, (v.wallCondenseLevel || 0) + (targetCond - (v.wallCondenseLevel || 0)) * Math.min(1, realDeltaSec * 2.5));
      } else {
        const decayRate = v.tempK < CONSTANTS.T_FREEZE_WATER_K ? 0.45 : 0.14;
        v.wallCondenseLevel = Math.max(0, (v.wallCondenseLevel || 0) - realDeltaSec * decayRate);
      }

      const tempSubzeroK = Math.max(0, CONSTANTS.T_FREEZE_WATER_K - v.tempK);
      const envSubzeroK = Math.max(0, CONSTANTS.T_FREEZE_WATER_K - this.environment.tempK);
      let targetFrost = 0;
      if (v.tempK < CONSTANTS.T_FREEZE_WATER_K + 1.5 && (tempSubzeroK > 0.3 || envSubzeroK > 1.0)) {
        const vesselFrost = Math.min(0.85, (tempSubzeroK / 22) * 0.72 + ((v.moles.H2O_s || 0) > 1e-4 ? 0.25 : 0));
        const ambientFrost = Math.min(0.55, envSubzeroK / 40);
        targetFrost = Math.min(1.0, Math.max(vesselFrost, ambientFrost));
      }
      const frostRate = targetFrost > (v.frostOpacity || 0) ? 1.8 : 0.65;
      v.frostOpacity = Math.max(
        0,
        Math.min(1, (v.frostOpacity || 0) + (targetFrost - (v.frostOpacity || 0)) * Math.min(1, realDeltaSec * frostRate))
      );

      const visibleOutRate = visibleNonSteamRate + (steamVisible ? rateSteam : 0);
      if ((visibleOutRate > 3.5e-5 || frameBoiling || isDehydrating) && formulaSummary) {
        if (!v.isStoppered) {
          v.lastGasOutTempK = v.tempK;
          v.lastGasOutFormula = formulaSummary;
          v.gasOutBoiling = frameBoiling;
          v.gasOutSteam = steamVisible;
          v.gasOutBannerTimer = 1.8;
          v.tubeFlowBannerTimer = Math.max(0, (v.tubeFlowBannerTimer || 0) - realDeltaSec);
        } else if (v.connectedSyringeId) {
          v.tubeFlowRateMolS = totalGasRate;
          v.tubeFlowTempK = v.tempK;
          v.tubeFlowFormula = formulaSummary;
          v.tubeFlowBannerTimer = 1.6;
          v.gasOutBannerTimer = Math.max(0, (v.gasOutBannerTimer || 0) - realDeltaSec);
        } else {
          v.gasOutBannerTimer = Math.max(0, (v.gasOutBannerTimer || 0) - realDeltaSec);
          v.tubeFlowBannerTimer = Math.max(0, (v.tubeFlowBannerTimer || 0) - realDeltaSec);
        }
      } else {
        v.gasOutBannerTimer = Math.max(0, (v.gasOutBannerTimer || 0) - realDeltaSec);
        v.tubeFlowBannerTimer = Math.max(0, (v.tubeFlowBannerTimer || 0) - realDeltaSec);
        if (v.tubeFlowBannerTimer === 0) v.tubeFlowRateMolS = 0;
      }

      // Decay visual timers for tube liquid flow
      if ((v.tubeLiquidFlowTimer || 0) > 0 && v.tubeLiquidFlowRateMlS <= 1e-4) {
        v.tubeLiquidFlowTimer = Math.max(0, v.tubeLiquidFlowTimer - realDeltaSec);
      }

      v.lastGasRateMap = rateMap;

      // Emit visual particle request
      if (this.visualHooks.onParticlesNeeded) {
        this.visualHooks.onParticlesNeeded(v, {
          gasRates: rateMap,
          gasRateH2: rateMap.H2_g,
          gasRateO2: rateMap.O2_g,
          gasRateHCl: rateMap.HCl_g,
          gasRateCl2: rateMap.Cl2_g,
          gasRateC2H5Cl: rateMap.C2H5Cl_g,
          gasRateNH3: rateMap.NH3_g,
          gasRateNO2: rateMap.NO2_g,
          gasRateNO: rateMap.NO_g,
          steamRate: rateSteam,
          steamOpacity: curSteamOpacity,
          overflowRateMlS: v.overflowRateMlS || 0,
          overflowColor: v.overflowColor || null,
          isBoiling: frameBoiling,
          isDehydrating,
          naActive,
          naIgnited: !!v.naIgnited,
          naTempK: v.naTempK,
          naRate:
            (frameActiveMap.get('na_water')?.rateMolS || 0) +
            (frameActiveMap.get('na_acid')?.rateMolS || 0) +
            (frameActiveMap.get('na_ethanol')?.rateMolS || 0) +
            (frameActiveMap.get('na_ice')?.rateMolS || 0),
        });
      }

      this.recordHistorySnapshot(v, false);
    }

    // Gas-phase NH3(g) + HCl(g) -> NH4Cl(s) dense white smoke between adjacent open vessels
    this.lastWhiteSmokePairs = [];
    const openVessels = this.items.filter((v) => v.kind === 'vessel' && !v.isShattered && !v.isStoppered);
    for (let i = 0; i < openVessels.length; i++) {
      for (let j = i + 1; j < openVessels.length; j++) {
        const a = openVessels[i];
        const b = openVessels[j];
        const hclA = a.lastGasRateMap?.HCl_g || 0;
        const nh3A = a.lastGasRateMap?.NH3_g || 0;
        const hclB = b.lastGasRateMap?.HCl_g || 0;
        const nh3B = b.lastGasRateMap?.NH3_g || 0;
        const crossPair = (hclA > 8e-6 && nh3B > 8e-6) || (hclB > 8e-6 && nh3A > 8e-6);
        if (!crossPair) continue;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist <= 220) {
          const hclRate = Math.max(hclA, hclB);
          const nh3Rate = Math.max(nh3A, nh3B);
          const mx = 0.5 * (a.x + b.x);
          const my = Math.min(a.y, b.y) - 42;
          const intensity = Math.min(1.6, Math.sqrt(hclRate * nh3Rate) * 2800 + 0.35);
          this.lastWhiteSmokePairs.push({ aId: a.id, bId: b.id, x: mx, y: my, intensity });
          if (this.visualHooks.onAlert) {
            this.visualHooks.onAlert('nh3_hcl_smoke', { x: mx, y: my }, { intensity });
          }
          const smokeKey = `smoke_${Math.min(a.id, b.id)}_${Math.max(a.id, b.id)}`;
          this._seenSmokeLog = this._seenSmokeLog || {};
          if (this.timeSec - (this._seenSmokeLog[smokeKey] ?? -99) > 10.0) {
            this._seenSmokeLog[smokeKey] = this.timeSec;
            this.addLog({
              type: 'reaction',
              equation: 'NH₃(g) + HCl(g) → NH₄Cl(s) (khói trắng)',
              nameVi: 'Khói trắng Ammonium chloride giữa hai bình HCl và NH₃',
              nameEn: 'White Ammonium chloride smoke between adjacent HCl & NH₃ vessels',
              descVi: 'Hơi HCl(g) gặp hơi NH₃(g) trên không trung tạo ngay đám khói trắng tinh thể NH₄Cl(s).',
              descEn: 'Escaping HCl(g) and NH₃(g) react in the air forming dense white NH₄Cl(s) aerosol smoke.',
              vesselLabel: `${a.label} ↔ ${b.label}`,
            });
          }
        }
      }
    }

    // Advance thermal exchange, Antoine condensation, gravity discharge & overflow inside all Gas Syringes
    for (const item of this.items) {
      if (item.kind !== 'gas_syringe' || item.isBroken) continue;
      item.lastNH4ClRxnFlag = false;
      for (let s = 0; s < numSteps; s++) {
        stepSyringeThermodynamics(item, dt, this.environment);
      }
      if ((item.nh4clSmokeTimer || 0) > 0) {
        item.nh4clSmokeTimer = Math.max(0, item.nh4clSmokeTimer - realDeltaSec);
      }
      if (item.lastNH4ClRxnFlag) {
        this._seenSyrNH4Cl = this._seenSyrNH4Cl || {};
        if (this.timeSec - (this._seenSyrNH4Cl[item.id] ?? -99) > 6.0) {
          this._seenSyrNH4Cl[item.id] = this.timeSec;
          this.addLog({
            type: 'reaction',
            equation: 'NH₃(g) + HCl(g) → NH₄Cl(s) (kết tinh trắng)',
            nameVi: 'Khí NH₃ gặp HCl(g) trong Gas Syringe tạo muối trắng NH₄Cl(s)',
            nameEn: 'NH₃(g) + HCl(g) combine inside Gas Syringe to deposit white NH₄Cl(s)',
            descVi: 'Hai khí acid–base trung hòa ngay trong xilanh tạo tinh thể bụi trắng NH₄Cl(s), làm giảm mạnh thể tích khí.',
            descEn: 'Acid-base gas neutralization consumes both gases in the barrel, precipitating white NH₄Cl(s) powder and contracting volume.',
            vesselLabel: item.label,
          });
        }
      }
      const syrT = item.tempK ?? this.environment.tempK;
      const envSubzeroSyr = Math.max(0, CONSTANTS.T_FREEZE_WATER_K - this.environment.tempK);
      let targetSyrFrost = 0;
      if (syrT < CONSTANTS.T_FREEZE_WATER_K + 1.5 && (syrT < CONSTANTS.T_FREEZE_WATER_K - 0.3 || envSubzeroSyr > 1.0)) {
        const syrCold = Math.max(0, CONSTANTS.T_FREEZE_WATER_K - syrT);
        targetSyrFrost = Math.min(
          1.0,
          Math.max(
            Math.min(0.85, (syrCold / 22) * 0.72 + ((item.frozenWaterMol || 0) > 1e-5 ? 0.25 : 0)),
            Math.min(0.55, envSubzeroSyr / 40)
          )
        );
      }
      const syrFrostRate = targetSyrFrost > (item.frostOpacity || 0) ? 1.8 : 0.65;
      item.frostOpacity = Math.max(
        0,
        Math.min(1, (item.frostOpacity || 0) + (targetSyrFrost - (item.frostOpacity || 0)) * Math.min(1, realDeltaSec * syrFrostRate))
      );
      if ((item.inflowLiquidTimer || 0) > 0) {
        item.inflowLiquidTimer = Math.max(0, item.inflowLiquidTimer - realDeltaSec);
        if (item.inflowLiquidTimer === 0) item.inflowLiquidRateMlS = 0;
      }
      this.stepSyringeDischarge(item, scaledDt);
      this.stepSyringeOverflow(item, scaledDt);
      // Check Beilstein flame test when Gas Syringe directs any halogen vapor onto a lit burner
      const hasSyrHalogen = Object.entries(item.gasMoles || {}).some(
        ([id, n]) => n > 1e-7 && SPECIES[id]?.isHalogenVapor
      );
      if ((item.isDischarging || (item.autoDischargeTimer || 0) > 0) && hasSyrHalogen) {
        const nozzle = getSyringeNozzlePos(item);
        const hasAnyCuOnBench = this.items.some(
          (v) =>
            v.kind === 'vessel' &&
            !v.isShattered &&
            Object.entries(v.moles || {}).some(([id, n]) => n > 1e-6 && SPECIES[id]?.isCopperMetal)
        );
        if (hasAnyCuOnBench) {
          for (const b of this.items) {
            if (b.kind === 'burner' && (b.powerW || 0) > 0 && Math.abs(nozzle.x - b.x) <= 125 && nozzle.y <= b.y + 40) {
              b.beilsteinTimer = 2.0;
            }
          }
        }
      }
      if (this.visualHooks.onParticlesNeeded && ((item.inflowLiquidTimer || 0) > 0 || (item.overflowOutRateMlS || 0) > 0.5)) {
        this.visualHooks.onParticlesNeeded(item, {
          inflowLiquidRateMlS: item.inflowLiquidRateMlS || 0,
          inflowLiquidColor: item.inflowLiquidColor || null,
          overflowOutRateMlS: item.overflowOutRateMlS || 0,
          overflowOutColor: item.overflowOutColor || null,
        });
      }
    }

    stepApparatusTools(this, scaledDt, realDeltaSec);
    stepElectrochemistry(this, scaledDt);

    if (this.visualHooks.onParticlesNeeded) {
      for (const item of this.items) {
        if (item.kind === 'filter_funnel' && item.isFiltering) {
          this.visualHooks.onParticlesNeeded(item, { rateMlS: item.filtrateRateMlS, color: item.filtrateColor });
        } else if (item.kind === 'burette' && item.streamingNow) {
          this.visualHooks.onParticlesNeeded(item, { rateMlS: item.valveRateMlS, color: item.streamColor });
        } else if (item.kind === 'condenser' && item.activeDrop) {
          this.visualHooks.onParticlesNeeded(item, { rateMlS: item.distillRateMlS });
        } else if (item.kind === 'electrode' && item.gasBubbleType && (item.gasBubbleRate || 0) > 1e-7) {
          this.visualHooks.onParticlesNeeded(item, { gasId: item.gasBubbleType, rateMolS: item.gasBubbleRate });
        } else if (item.kind === 'vessel' && (item.troughOverfillRate || 0) > 1e-4) {
          this.visualHooks.onParticlesNeeded(item, { troughOverfillRate: item.troughOverfillRate, troughOverfillX: item.troughOverfillX });
        } else if (item.kind === 'wash_bottle' && ((item.squirtTimer || 0) > 0 || item.isSpraying) && item.squirtArc) {
          this.visualHooks.onParticlesNeeded(item, { squirtArc: item.squirtArc, activeSpray: true });
        }
      }
    }

    this.recomputeScaleReadings();
  }
}

export { computeSyringeGasVolumeMl };
