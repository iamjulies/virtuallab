import { CONSTANTS, waterBoilingPointK } from '../data/constants.js';
import { REACTIONS } from '../data/reactions.js';
import {
  ALL_GAS_IDS,
  createZeroGasMap,
  isSolidMoltenAtTemp,
  SPECIES,
  STARTER_REAGENTS,
} from '../data/species.js';
import {
  APPARATUS,
  clampItemToStandY,
  getItemRotatedHalfExtentY,
  getProbeTipPos,
  getStandGeometry,
  getSyringeGeometry,
  getVesselEndPorts,
} from '../data/apparatus.js';
import { getInnerPolygonPx, getVesselHoldVolumeMl } from '../data/vesselGeometry.js';
import {
  calcSolidPourDischargeRate,
  calcSolidTransferRatio,
  computeContentsMassG,
  computeEthanolWaterExcessEnthalpyJ,
  computeLiquidVolumeL,
  computePH,
  computePhaseStratification,
  computePhenolphthaleinBleachEq,
  computeSolidSuspensionFactor,
  computeSolidVolumeMl,
  computeSolutionVisuals,
} from './equilibrium.js';
import {
  enforceDryPhaseBoundary,
  getVesselEffectiveO2Bar,
  stepVesselChemistry,
  validateVesselInvariants,
} from './chemistry.js';
import { ELECTRODE_MATERIALS, stepElectrochemistry } from './electrochemistry.js';
import {
  computeWashBottleStreamArc,
  grindMortarSolids,
  stepApparatusTools,
  syncDockedToolPositions,
} from './apparatusTools.js';
import { computeHeatCapacityJK, computeSteamOpacity, stepVesselThermodynamics } from './thermodynamics.js';
import { injectLocalPlume, stepLiquidConcField } from './liquidField.js';
import {
  applySurfaceImpulse,
  computeLiquidViscosityFactor,
  stepVesselSolidBodies,
  stepVesselSurfaceWaves,
} from './liquidSurfacePhysics.js';
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
  isTubeTipSubmerged,
  routeGasPacketToTarget,
  stepOpenGasBuoyancy,
  stepSyringeThermodynamics,
  stepVesselGasAndPressure,
} from './gasNetwork.js';

export const SIM_BENCH_FLOOR_Y = 482;
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
      atmosphereMode: 'air',        // 'air' (78% N2, 21% O2, 60% RH) | 'inert' (dry N2/Ar glovebox)
      opticsMode: 'normal',         // 'normal' | 'aerodynamics' | 'thermal'
    };
    this.items = [];
    this.selectedId = null;
    this.selectedIds = new Set();
    this.compareVesselIds = [];
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
    this.undoStack = [];
    this.maxUndo = 10;
    this._suppressUndo = 0;
  }

  withUndoSuppressed(fn) {
    this._suppressUndo = (this._suppressUndo || 0) + 1;
    try {
      return fn();
    } finally {
      this._suppressUndo = Math.max(0, (this._suppressUndo || 1) - 1);
    }
  }

  exportSnapshot() {
    const cleanItems = this.items.map((it) => {
      const copy = JSON.parse(JSON.stringify(it));
      if (Array.isArray(copy.history) && copy.history.length > 8) {
        copy.history = copy.history.slice(-8);
      }
      return copy;
    });
    return {
      timeSec: this.timeSec,
      nextId: this.nextId,
      environment: { ...this.environment },
      items: cleanItems,
      selectedId: this.selectedId,
      selectedIds: Array.from(this.selectedIds || []),
      compareVesselIds: Array.isArray(this.compareVesselIds) ? [...this.compareVesselIds] : [],
      pipette: JSON.parse(JSON.stringify(this.pipette)),
      logs: JSON.parse(JSON.stringify(this.logs.slice(0, 12))),
    };
  }

  restoreSnapshot(snap) {
    if (!snap) return false;
    this.timeSec = snap.timeSec ?? 0;
    this.nextId = snap.nextId ?? 1;
    if (snap.environment) {
      this.environment = JSON.parse(JSON.stringify(snap.environment));
    }
    this.items = Array.isArray(snap.items) ? JSON.parse(JSON.stringify(snap.items)) : [];
    for (const it of this.items) {
      it.isDragging = false;
      it.tiltAngle = 0;
      it.hoveredActionLabel = null;
    }
    this.selectedId = snap.selectedId || null;
    this.selectedIds = new Set(Array.isArray(snap.selectedIds) ? snap.selectedIds : this.selectedId ? [this.selectedId] : []);
    this.compareVesselIds = Array.isArray(snap.compareVesselIds) ? [...snap.compareVesselIds] : [];
    if (snap.pipette) {
      this.pipette = JSON.parse(JSON.stringify(snap.pipette));
    }
    if (Array.isArray(snap.logs)) {
      this.logs = JSON.parse(JSON.stringify(snap.logs));
    }
    this.activePourStream = null;
    this.activeReagentTransfer = null;
    this.timedTransfers = [];
    this.updateSupportAttachments();
    this.recomputeScaleReadings();
    this.emitChange();
    return true;
  }

  pushUndoSnapshot(snap) {
    if (!snap || this._suppressUndo > 0) return false;
    if (!Array.isArray(this.undoStack)) this.undoStack = [];
    this.undoStack.push(snap);
    const limit = this.maxUndo || 10;
    while (this.undoStack.length > limit) {
      this.undoStack.shift();
    }
    return true;
  }

  recordUndo() {
    if (this._suppressUndo > 0) return false;
    return this.pushUndoSnapshot(this.exportSnapshot());
  }

  undo() {
    if (!Array.isArray(this.undoStack) || this.undoStack.length === 0) return false;
    const snap = this.undoStack.pop();
    return this.restoreSnapshot(snap);
  }

  deleteSelectedItems() {
    const rawIds =
      this.selectedIds && this.selectedIds.size > 0
        ? Array.from(this.selectedIds)
        : this.selectedId
        ? [this.selectedId]
        : [];
    const validIds = rawIds.filter((id) => Boolean(this.getItem(id)));
    if (validIds.length === 0) return 0;
    this.recordUndo();
    this.withUndoSuppressed(() => {
      for (const id of validIds) {
        this.removeApparatus(id);
      }
    });
    this.selectedIds.clear();
    this.selectedId = null;
    this.emitChange();
    return validIds.length;
  }

  /**
   * Empty all chemicals, liquids, solids, and trapped/escaped gases from a vessel, spoon,
   * pipette, or gas syringe without deleting or moving the apparatus itself.
   */
  emptyApparatus(itemId) {
    const it = this.getItem(itemId);
    if (!it) return false;
    const drainable = it.kind === 'vessel' || it.kind === 'spoon' || it.kind === 'pipette' || it.kind === 'gas_syringe';
    if (!drainable) return false;
    this.recordUndo();
    it.moles = {};
    if (it.kind === 'vessel') {
      it.headspaceGasMoles = createEmptyGasMap();
      it.escapedGasMoles = createEmptyGasMap();
      it.lastGasRateMap = createEmptyGasMap();
      it.overflowMoles = {};
      it.groundPowderMap = {};
      it.precipitateSettle = {};
      it._solidBodies = [];
      it._surfaceWave = null;
      it.volumeMl = 0;
      it.condensedWaterMol = 0;
      it.condensedEtOHMol = 0;
      it.frozenWaterMol = 0;
      it.escapedFrostH2OMol = 0;
      it.wallCondenseLevel = 0;
      it.caCo3FilmFrac = 0;
      it.silverMirrorLevel = 0;
      it.silverMirrorFrac = 0;
      it.sulfurO2Flame = 0;
      it.gardenActive = false;
      it.gardenGrowth = 0;
      it.suspensionLevel = 0;
      it.phenBleachFrac = 0;
      it.phenIrrevFrac = 0;
      it.naDryBurnTimer = 0;
      it.kDryBurnTimer = 0;
      it.feSparkBurning = 0;
      it.znCombustionTimer = 0;
      it.cumulativeReactionHeatJ = 0;
      it.lastTempRateCS = 0;
      it._reactionExtentMap = {};
      it.conversionYieldPct = null;
      it._lastLoggedPhenState = null;
      it.pressureAtm = this.environment?.pressureBar || CONSTANTS.P_STD_BAR;
      it.tempK = this.environment?.tempK || CONSTANTS.T_STD_K;
    } else if (it.kind === 'spoon' || it.kind === 'pipette') {
      it.volumeMl = 0;
      it.tempK = this.environment?.tempK || CONSTANTS.T_STD_K;
    } else if (it.kind === 'gas_syringe') {
      it.gasMoles = createEmptyGasMap();
      it.liquidMoles = {};
      it.pistonPositionMl = 0;
      it.tempK = this.environment?.tempK || CONSTANTS.T_STD_K;
    }
    this.emitChange();
    return true;
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

  createApparatus(typeId, x = 280, y = 380, options = {}) {
    const spec = APPARATUS[typeId];
    if (!spec) return null;
    if (!options?.silentUndo) this.recordUndo();
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
        stopperMode: 'holed',
        leftStoppered: false,
        rightStoppered: false,
        connectedPortSide: null,
        incomingPortSide: null,
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
        sealedAirO2Moles: null,
        airO2PurgeFrac: this.environment.atmosphereMode === 'air' ? 1.0 : 0.0,
        naTarnishFrac: 0,
        kTarnishFrac: 0,
        naohAirExposeSec: 0,
        naohDeliquesceFrac: 0,
        znCombustionTimer: 0,
        mgCombustionTimer: 0,
        alCombustionTimer: 0,
        znFlameColor: null,
        naDryBurnTimer: 0,
        kDryBurnTimer: 0,
        lidState: spec.hasLid ? 'open' : null,
        softenGlowFrac: 0,
        softenSagFrac: 0,
        isMoltenMelted: false,
        calcinationStats: null,
        lastTotalRateMolS: 0,
        cumulativeGasMol: 0,
        headspaceGasMoles: createEmptyGasMap(),
        escapedGasMoles: createEmptyGasMap(),
        isShattered: false,
        stirTimer: 0,
        tiltAngle: 0,
        tiltDeg: 0,
        tiltDir: 1,
        sootLevel: 0,
        silverMirrorLevel: 0,
        wallResidueMap: {},
        nh4clFrostLevel: 0,
        _recentHotTempK: 298.15,
        tubeSubmersionRatio: 0.72,
        submergedInBathId: null,
        tiltPourRateMlS: 0,
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
        leftHasPhenCotton: false,
        rightHasPhenCotton: false,
        phenCottonLeftLevel: 0,
        phenCottonRightLevel: 0,
        horizontalSpillRateMlS: 0,
        horizontalSpillLeft: false,
        horizontalSpillRight: false,
        horizontalSpillColor: null,
        recentHalogenGasTimer: 0,
        naHazardFlag: false,
        kHazardFlag: false,
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
        kVisualPhase: Math.random() * 6.28,
        kPosRatio: 0.5,
        kVel: 1.18,
        kTempK: null,
        kPinned: false,
        kIgnited: false,
        localKH2Mol: 0,
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
        mountedOverElectrodeId: null,
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
        base.moles.H2O_l = (800 * 0.997) / CONSTANTS.M_H2O;
      }
    } else if (spec.kind === 'bath') {
      Object.assign(base, {
        bathMode: 'ice', // 'ice' (0 C) | 'ice_salt' (-10 C) | temperature tier
        bathTargetC: 0,
        bathTempK: spec.bathTempIceK || 273.15,
      });
    } else if (spec.kind === 'scale') {
      Object.assign(base, {
        tareG: 0,
        measuredG: 0,
      });
    } else if (spec.kind === 'burner') {
      Object.assign(base, {
        flameLevel: 0, // 0=off, 1=low, 2=med, 3=high
        powerW: 0,
        airHoleOpen: spec.burnerType === 'bunsen' ? true : undefined,
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
    } else if (spec.kind === 'separatory_funnel') {
      Object.assign(base, {
        moles: {},
        particleCounts: {},
        precipitateSettle: {},
        tempK: this.environment.tempK,
        phenBleachFrac: 0,
        phenIrrevFrac: 0,
        isStoppered: false,
        mountedOnVesselId: null,
        valveOpen: false,
        valveFlowFrac: 0.35,
        stopAtInterface: true,
        emulsionTimer: 0,
        activeDrop: false,
        drainRateMlS: 0,
        drainTargetId: null,
        drainColor: null,
        activeLayerKey: null,
        dispensedMl: 0,
        liquidStratification: null,
        isBroken: false,
      });
    } else if (spec.kind === 'wash_bottle') {
      Object.assign(base, {
        waterMl: 250,
        sprayAngleDeg: 0,
        isSpraying: false,
        manualSprayHold: false,
        sprayTargetId: null,
        squirtTimer: 0,
        squirtArc: null,
        isBroken: false,
      });
    } else if (spec.kind === 'condenser') {
      Object.assign(base, {
        waterFlowOn: true,
        refluxMode: false,
        refluxVesselId: null,
        rotationDeg: 0,
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
        gasTargetId: null,
        recentGasMol: 0,
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
        extendPx: 0,
      });
    } else if (spec.kind === 'spoon') {
      Object.assign(base, {
        moles: {},
        particleCounts: {},
        groundPowderMap: {},
        tempK: this.environment.tempK,
        tiltAngle: 0,
        burnTimer: 0,
        flameColor: null,
        activeReactions: [],
        seenReactions: {},
        hoveredActionLabel: null,
      });
    } else if (spec.kind === 'rubber_stopper') {
      Object.assign(base, {
        stopperMode: 'holed', // 'holed' (1-hole bore for tubing) | 'solid' (solid airtight bung)
        attachedToId: null,
        attachedSide: null, // 'main' | 'left' | 'right'
      });
    } else if (spec.kind === 'phen_cotton') {
      Object.assign(base, {
        attachedToId: null,
        attachedSide: null, // 'main' | 'left' | 'right'
        pinkLevel: 0,
        dampness: 0.85,
      });
    } else if (spec.kind === 'thermometer') {
      Object.assign(base, {
        measuredTempK: this.environment.tempK,
        tempK: this.environment.tempK,
        contactKind: 'ambient',
        contactLabel: '',
        tiltAngle: 0,
      });
    }

    this.items.push(base);
    if (base.kind === 'wash_bottle') {
      base.squirtArc = computeWashBottleStreamArc(base, this.items, SIM_BENCH_FLOOR_Y, CONSTANTS.GRAVITY_PX_S2 || 1800);
      base.sprayTargetId = base.squirtArc.hitTarget ? base.squirtArc.hitTarget.id : null;
    }
    this.selectedId = id;
    this.selectedIds = new Set([id]);
    this.updateSupportAttachments();
    this.emitChange();
    return base;
  }

  /**
   * Detach an apparatus from every tubing, clamp, dock, stir-bar, and wiring link cleanly.
   * Reused both by removeApparatus and cross-bench moveBetweenLabs.
   */
  detachItemRelations(item) {
    if (!item) return;
    const id = item.id;
    if (item.kind === 'vessel' && (item.connectedTargetId || item.connectedSyringeId)) {
      this.disconnectSyringe(id);
    }
    if (item.kind === 'stir_bar' && item.inVesselId) {
      const host = this.getItem(item.inVesselId);
      if (host) {
        host.hasStirBar = false;
        host.magStirRpm = 0;
      }
      item.inVesselId = null;
    }
    if (item.kind === 'electrode') {
      item.dockedVesselId = null;
      item.renderHeight = null;
      item.immersedHeightPx = null;
      item.immersedFrac = undefined;
      item.gasTargetId = null;
    }
    if (item.kind === 'filter_funnel' || item.kind === 'separatory_funnel') {
      item.mountedOnVesselId = null;
    }
    if (item.kind === 'condenser') {
      item.refluxVesselId = null;
    }
    if (item.kind === 'salt_bridge') {
      item.vesselAId = null;
      item.vesselBId = null;
    }
    if (item.kind === 'dc_power' || item.kind === 'volt_ammeter') {
      item.posElectrodeId = null;
      item.negElectrodeId = null;
    }
    if (item.kind === 'rubber_stopper' && item.attachedToId) {
      this.detachRubberStopper(item.id, { keepPos: true });
    }
    if (item.kind === 'phen_cotton' && item.attachedToId) {
      this.detachPhenCotton(item.id);
    }
    item.clampedToId = null;
    item.restingOnId = null;

    for (const other of this.items) {
      if (other.id === id) continue;
      if (other.kind === 'rubber_stopper' && other.attachedToId === id) {
        this.detachRubberStopper(other.id, { keepPos: true });
      }
      if (other.kind === 'phen_cotton' && other.attachedToId === id) {
        this.detachPhenCotton(other.id);
      }
      if (other.connectedSyringeId === id || other.connectedTargetId === id) {
        this.disconnectSyringe(other.id);
      }
      if (other.connectedFromId === id) other.connectedFromId = null;
      if (other.outletTargetId === id) other.outletTargetId = null;
      if (other.dockedVesselId === id) {
        other.dockedVesselId = null;
        other.renderHeight = null;
        other.immersedHeightPx = null;
        other.immersedFrac = undefined;
      }
      if (other.inVesselId === id) other.inVesselId = null;
      if (other.mountedOnVesselId === id) other.mountedOnVesselId = null;
      if (other.gasTargetId === id) other.gasTargetId = null;
      if (other.mountedOverElectrodeId === id) other.mountedOverElectrodeId = null;
      if (other.posElectrodeId === id) other.posElectrodeId = null;
      if (other.negElectrodeId === id) other.negElectrodeId = null;
      if (other.vesselAId === id) other.vesselAId = null;
      if (other.vesselBId === id) other.vesselBId = null;
      if (other.restingOnId === id) {
        other.restingOnId = null;
        if (!other.clampedToId) other.fallStartY = other.y;
      }
      if (other.clampedToId === id) {
        other.clampedToId = null;
        other.fallStartY = other.y;
      }
    }
    if (item.kind === 'vessel') {
      item.hasStirBar = false;
      item.magStirRpm = 0;
      item.mountedOverElectrodeId = null;
      item.submergedInTroughId = null;
    }
  }

  removeApparatus(id) {
    const item = this.getItem(id);
    if (!item) return;
    this.recordUndo();
    this.detachItemRelations(item);
    this.items = this.items.filter((it) => it.id !== id);
    if (Array.isArray(this.compareVesselIds)) {
      this.compareVesselIds = this.compareVesselIds.filter((cid) => cid !== id);
    }
    if (this.selectedIds) this.selectedIds.delete(id);
    if (this.selectedId === id) {
      const firstRem = this.selectedIds && this.selectedIds.size > 0 ? Array.from(this.selectedIds)[0] : null;
      this.selectedId = firstRem || this.items[0]?.id || null;
      if (this.selectedId && this.selectedIds && this.selectedIds.size === 0) {
        this.selectedIds.add(this.selectedId);
      }
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

  setStandExtension(standId, extendPx) {
    const stand = this.getItem(standId);
    if (!stand || stand.kind !== 'stand') return false;
    stand.extendPx = Math.max(0, Math.min(200, Math.round(Number(extendPx) || 0)));
    for (const child of this.items) {
      if (child.clampedToId === stand.id) {
        const cSpec = APPARATUS[child.typeId];
        if (cSpec) {
          child.y = clampItemToStandY(cSpec, stand, SIM_BENCH_FLOOR_Y, child.y, 6);
        }
      }
    }
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
    if (this.items.length > 0) this.recordUndo();
    this._suppressUndo = (this._suppressUndo || 0) + 1;
    try {
      this._setupPresetInner(presetName);
    } finally {
      this._suppressUndo = Math.max(0, (this._suppressUndo || 1) - 1);
    }
  }

  _setupPresetInner(presetName) {
    this.items = [];
    this.compareVesselIds = [];
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
      const elA = this.createApparatus('electrode_rod', beaker.x - 24, beaker.y - 16);
      elA.material = 'C';
      elA.dockedVesselId = beaker.id;
      elA.dockSide = 'left';
      const elB = this.createApparatus('electrode_rod', beaker.x + 24, beaker.y - 16);
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
    } else if (presetName === 'cuo_h2_reduction') {
      // Textbook CuO + H2 reduction: diluted ~5.5M HCl + mossy Zn granules (steady 25s H2 stream) -> rubber tube -> clamped test tube containing black CuO(s) over alcohol burner
      const flask = this.createApparatus('erlenmeyer_250', 220, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      this.addReagentToVessel(flask.id, 'h2o', 40, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(flask.id, 'hcl_37', 30, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(flask.id, 'zn', 12.0, { fine: false, silentAnim: true, silentEmit: true });
      flask.particleCounts.Zn_s = 2; // Large mossy Zinc chunks give sustained H2 stream over ~25s!
      flask.tempK = this.environment.tempK;
      flask.isStoppered = true;

      const burner = this.createApparatus('burner', 530, SIM_BENCH_FLOOR_Y - APPARATUS.burner.height / 2 + 2);
      this.setBurnerFlame(burner.id, 0);
      const stand = this.createApparatus('retort_stand', 585, SIM_BENCH_FLOOR_Y - APPARATUS.retort_stand.height / 2 + 2);
      const tube = this.createApparatus('test_tube_50', 530, 326);
      tube.moles = { CuO_s: 0.04 };
      tube.particleCounts = { CuO_s: 260 };
      this.attachToStand(tube.id, stand.id);
      this.connectTube(flask.id, tube.id);
      this.addLog({ type: 'info', key: 'guideCuoH2', vesselLabel: tube.label });
      this.selectedId = burner.id;
    } else if (presetName === 'zn_burn_o2') {
      // Textbook O2 prep (H2O2 + CuO catalyst) -> O2 jar + Zn porcelain dish over burner
      const flaskA = this.createApparatus('erlenmeyer_250', 200, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      flaskA.moles = { CuO_s: 0.02 };
      this.addReagentToVessel(flaskA.id, 'h2o2_30', 35, { silentAnim: true, silentEmit: true });
      flaskA.isStoppered = true;
      const flaskO2 = this.createApparatus('erlenmeyer_250', 430, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      flaskO2.headspaceGasMoles.O2_g = 0.008;
      flaskO2.moles = { Zn_s: 0.03 };
      flaskO2.particleCounts = { Zn_s: 12 };
      this.connectTube(flaskA.id, flaskO2.id);
      const burner = this.createApparatus('burner', 690, SIM_BENCH_FLOOR_Y - APPARATUS.burner.height / 2 + 2);
      this.setBurnerFlame(burner.id, 3);
      const dish = this.createApparatus('porcelain_dish', 690, burner.y - APPARATUS.burner.height / 2 + 10 - APPARATUS.porcelain_dish.height / 2);
      this.addReagentToVessel(dish.id, 'zn', 2.0, { fine: true, silentAnim: true, silentEmit: true });
      this.createApparatus('splint', 820, SIM_BENCH_FLOOR_Y - 12);
      this.addLog({ type: 'info', key: 'guideZnBurnO2', vesselLabel: flaskO2.label });
      this.selectedId = flaskO2.id;
    } else if (presetName === 'air_tarnish_deliquesce') {
      const dish = this.createApparatus('porcelain_dish', 290, SIM_BENCH_FLOOR_Y - APPARATUS.porcelain_dish.height / 2 + 2);
      this.addReagentToVessel(dish.id, 'na', 1.2, { silentAnim: true, silentEmit: true });
      const beaker = this.createApparatus('beaker_250', 550, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      this.addReagentToVessel(beaker.id, 'naoh', 4.5, { silentAnim: true, silentEmit: true });
      this.addLog({ type: 'info', key: 'guideAirTarnish', vesselLabel: dish.label });
      this.selectedId = dish.id;
    } else if (presetName === 'na_water_phen') {
      const beaker = this.createApparatus('beaker_250', 360, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      this.addReagentToVessel(beaker.id, 'h2o', 90, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(beaker.id, 'phen', 2, { silentAnim: true, silentEmit: true });
      const dish = this.createApparatus('porcelain_dish', 580, SIM_BENCH_FLOOR_Y - APPARATUS.porcelain_dish.height / 2 + 2);
      this.addReagentToVessel(dish.id, 'na', 0.45, { silentAnim: true, silentEmit: true });
      this.selectedId = beaker.id;
    } else if (presetName === 'copper_hydroxide_series') {
      this.createApparatus('scale', 210, SIM_BENCH_FLOOR_Y - APPARATUS.scale.height / 2 + 2);
      const beaker = this.createApparatus('beaker_250', 210, SIM_BENCH_FLOOR_Y - APPARATUS.scale.height - APPARATUS.beaker_250.height / 2 + 2);
      this.addReagentToVessel(beaker.id, 'h2o', 60, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(beaker.id, 'cuso4_5h2o', 6.0, { silentAnim: true, silentEmit: true });
      this.createApparatus('burner', 530, SIM_BENCH_FLOOR_Y - APPARATUS.burner.height / 2 + 2);
      this.createApparatus('erlenmeyer_250', 720, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      this.selectedId = beaker.id;
    } else if (presetName === 'amphoteric_zn_cu') {
      const bZn = this.createApparatus('beaker_250', 270, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      bZn.moles = { H2O_l: 3.5, ZnOH2_s: 0.03 };
      const bCu = this.createApparatus('beaker_250', 510, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      bCu.moles = { H2O_l: 3.5, CuOH2_s: 0.03 };
      this.createApparatus('burner', 740, SIM_BENCH_FLOOR_Y - APPARATUS.burner.height / 2 + 2);
      this.selectedId = bZn.id;
    } else if (presetName === 'cu_ammine_complex') {
      const bCu = this.createApparatus('beaker_250', 340, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      this.addReagentToVessel(bCu.id, 'h2o', 45, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bCu.id, 'cuso4_5h2o', 2.5, { silentAnim: true, silentEmit: true });
      bCu.moles.CuOH2_s = 0.008;
      delete bCu.moles.Cu2_aq;
      const beakerNh3 = this.createApparatus('beaker_250', 580, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      this.addReagentToVessel(beakerNh3.id, 'nh3_25', 25, { silentAnim: true, silentEmit: true });
      this.addLog({ type: 'info', key: 'guideCuAmmine', vesselLabel: bCu.label });
      this.selectedId = bCu.id;
    } else if (presetName === 'compare_rate_factors') {
      const bCoarse = this.createApparatus('erlenmeyer_250', 200, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      bCoarse.label = '#A (Đá vôi cục)';
      this.addReagentToVessel(bCoarse.id, 'h2o', 45, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bCoarse.id, 'hcl_37', 12, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bCoarse.id, 'caco3', 5.0, { fine: false, silentAnim: true, silentEmit: true });
      bCoarse.particleCounts.CaCO3_s = 3;

      const bFine = this.createApparatus('erlenmeyer_250', 440, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      bFine.label = '#B (Bột mịn CaCO₃)';
      this.addReagentToVessel(bFine.id, 'h2o', 45, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bFine.id, 'hcl_37', 12, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bFine.id, 'caco3', 5.0, { fine: true, silentAnim: true, silentEmit: true });
      bFine.particleCounts.CaCO3_s = 800;
      bFine.groundPowderMap.CaCO3_s = true;

      const bHot = this.createApparatus('erlenmeyer_250', 680, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      bHot.label = '#C (Đặc + Nóng 55°C)';
      this.addReagentToVessel(bHot.id, 'h2o', 25, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bHot.id, 'hcl_37', 30, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bHot.id, 'caco3', 5.0, { fine: false, silentAnim: true, silentEmit: true });
      bHot.particleCounts.CaCO3_s = 3;
      bHot.tempK = 328.15;

      this.compareVesselIds = [bCoarse.id, bFine.id, bHot.id];
      this.selectedId = bFine.id;
    } else if (presetName === 'compare_corrosion') {
      const bChem = this.createApparatus('beaker_250', 185, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      bChem.label = '#A (Ăn mòn hóa học Zn+HCl)';
      this.addReagentToVessel(bChem.id, 'h2o', 55, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bChem.id, 'hcl_37', 18, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bChem.id, 'zn', 2.5, { fine: false, silentAnim: true, silentEmit: true });

      const bElec = this.createApparatus('beaker_250', 415, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      bElec.label = '#B (Pin điện hóa Zn–Cu)';
      this.addReagentToVessel(bElec.id, 'h2o', 55, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bElec.id, 'hcl_37', 18, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bElec.id, 'zn', 2.5, { fine: false, silentAnim: true, silentEmit: true });
      bElec.moles.Cu_s = 0.008;

      const elZn = this.createApparatus('electrode_rod', 395, 390);
      elZn.material = 'Zn';
      elZn.dockedVesselId = bElec.id;
      elZn.dockSide = 'left';
      const elCu = this.createApparatus('electrode_rod', 435, 390);
      elCu.material = 'Cu';
      elCu.dockedVesselId = bElec.id;
      elCu.dockSide = 'right';
      const vm = this.createApparatus('volt_ammeter', 585, SIM_BENCH_FLOOR_Y - APPARATUS.volt_ammeter.height / 2 + 2);
      vm.mode = 'ammeter';
      vm.posElectrodeId = elCu.id;
      vm.negElectrodeId = elZn.id;
      syncDockedToolPositions(this);

      const bPass = this.createApparatus('beaker_250', 790, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      bPass.label = '#C (Cu nguyên chất trong HCl)';
      this.addReagentToVessel(bPass.id, 'h2o', 55, { silentAnim: true, silentEmit: true });
      this.addReagentToVessel(bPass.id, 'hcl_37', 18, { silentAnim: true, silentEmit: true });
      bPass.moles.Cu_s = 0.03;

      this.compareVesselIds = [bChem.id, bElec.id, bPass.id];
      this.selectedId = bElec.id;
    } else if (presetName === 'caco3_calcination_limewater') {
      const bnCruc = this.createApparatus('bunsen_burner', 200, SIM_BENCH_FLOOR_Y - APPARATUS.bunsen_burner.height / 2 + 2);
      bnCruc.airHoleOpen = true;
      this.setBurnerFlame(bnCruc.id, 3);
      const cruc = this.createApparatus(
        'crucible_porcelain',
        200,
        bnCruc.y - APPARATUS.bunsen_burner.height / 2 + 10 - APPARATUS.crucible_porcelain.height / 2 + 12
      );
      this.addReagentToVessel(cruc.id, 'caco3', 3.0, { fine: true, silentAnim: true, silentEmit: true });
      cruc.particleCounts.CaCO3_s = 800;
      cruc.groundPowderMap.CaCO3_s = true;
      cruc.lidState = 'ajar';

      const bnQuartz = this.createApparatus('bunsen_burner', 530, SIM_BENCH_FLOOR_Y - APPARATUS.bunsen_burner.height / 2 + 2);
      bnQuartz.airHoleOpen = true;
      this.setBurnerFlame(bnQuartz.id, 3);
      const stand = this.createApparatus('retort_stand', 595, SIM_BENCH_FLOOR_Y - APPARATUS.retort_stand.height / 2 + 2);
      const qTube = this.createApparatus('quartz_tube', 530, 386);
      this.addReagentToVessel(qTube.id, 'caco3', 3.0, { fine: true, silentAnim: true, silentEmit: true });
      qTube.particleCounts.CaCO3_s = 800;
      qTube.groundPowderMap.CaCO3_s = true;
      this.attachToStand(qTube.id, stand.id);
      qTube.y = 386;

      const limeBeaker = this.createApparatus('beaker_250', 775, SIM_BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      limeBeaker.label = '#Nước vôi trong';
      this.addReagentToVessel(limeBeaker.id, 'h2o', 70, { silentAnim: true, silentEmit: true });
      limeBeaker.moles.Ca2_aq = 0.0016;
      limeBeaker.moles.OH_aq = 0.0032;
      this.connectTube(qTube.id, limeBeaker.id);
      this.addLog({ type: 'info', key: 'guideCaco3Calcination', vesselLabel: cruc.label });
      this.selectedId = cruc.id;
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
    const halfExtY = getItemRotatedHalfExtentY(spec, item);
    const floorCenterY = SIM_BENCH_FLOOR_Y - halfExtY + 2;
    let bestCenterY = floorCenterY;
    let bestSupport = null;

    if (item.kind === 'spoon') {
      const { x: bowlX } = getProbeTipPos(item);
      for (const sup of this.items) {
        if (sup.kind !== 'burner') continue;
        const supSpec = APPARATUS[sup.typeId] || APPARATUS.burner;
        const flameSeatY = sup.y - supSpec.height / 2 - 58;
        if (Math.abs(bowlX - sup.x) <= 44 && (item.restingOnId === sup.id || item.y <= sup.y - 6)) {
          return { centerY: flameSeatY, support: sup };
        }
      }
      return { centerY: floorCenterY, support: null };
    }

    if (item.kind === 'rubber_stopper' || item.kind === 'phen_cotton') {
      if (item.attachedToId) {
        const hostV = this.getItem(item.attachedToId);
        if (hostV && !hostV.isShattered) {
          const slot = this.getMouthSlotCoords(hostV, item.attachedSide || 'main');
          return { centerY: slot ? slot.y : item.y, support: hostV };
        }
      }
      return { centerY: floorCenterY, support: null };
    }

    if (
      item.kind === 'scale' ||
      item.kind === 'burner' ||
      item.kind === 'stand' ||
      item.kind === 'splint' ||
      item.kind === 'flame_loop' ||
      item.kind === 'indicator_strip' ||
      item.kind === 'thermometer' ||
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
      } else if (sup.kind === 'bath' && item.kind === 'vessel' && spec.shape !== 'trough') {
        const bathBasinBottom = sup.y + supSpec.height / 2 - 12;
        const candY = bathBasinBottom - spec.height / 2;
        if (dx <= 54 && (alreadyOnSup || itemBottom <= bathBasinBottom + 24) && candY < bestCenterY) {
          bestCenterY = candY;
          bestSupport = sup;
        }
      } else if (sup.kind === 'burner' && spec.heatable && item.kind === 'vessel') {
        const bnTop = sup.y - supSpec.height / 2 + 10;
        const nestSink = supSpec.hasIntegratedTripod && spec.shape === 'crucible' ? 10 : 0;
        const candY = bnTop - spec.height / 2 + nestSink;
        if (dx <= 46 && (alreadyOnSup || itemBottom <= bnTop + 65) && candY < bestCenterY) {
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
      } else if (item.kind === 'separatory_funnel' && sup.kind === 'vessel' && !sup.isShattered && !sup.isInverted) {
        const rimTop = sup.y - supSpec.height / 2;
        const candY = rimTop - spec.height * 0.56;
        if (dx <= 28 && (alreadyOnSup || item.y <= rimTop + 14) && candY < bestCenterY) {
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
    if (this._updatingSupports) return;
    this._updatingSupports = true;
    try {
      for (const it of [...this.items]) {
      if (
        it.kind === 'scale' ||
        it.kind === 'burner' ||
        it.kind === 'stand'
      )
        continue;
      if (it.dockedVesselId || it.inVesselId || it.mountedOverElectrodeId) {
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
      if (it.kind === 'vessel') it.submergedInBathId = null;
      const { centerY, support } = this.getSupportSurfaceForItem(it);
      const snapTolY = it.kind === 'spoon' ? 34 : 22;
      if (support && Math.abs(it.y - centerY) <= snapTolY) {
        it.restingOnId = support.id;
        if (it.kind === 'vessel' && support.kind === 'bath') {
          it.submergedInBathId = support.id;
        }
        it.y = centerY;
        if (it.kind === 'spoon') {
          const dir = it.flippedX ? 1 : -1;
          if (Math.abs(it.x + dir * 2 - support.x) < 28) it.x = support.x - dir * 2;
        } else if (Math.abs(it.x - support.x) < 28) {
          it.x = support.x;
        }
        it.vy = 0;
        it.fallStartY = null;
        if ((it.kind === 'filter_funnel' || it.kind === 'separatory_funnel') && support.kind === 'vessel') {
          it.mountedOnVesselId = support.id;
          if (it.kind === 'separatory_funnel') {
            const supSpec = APPARATUS[support.typeId];
            if (supSpec?.stopperable && !supSpec.hasTwoEnds && (!support.isStoppered || support.stopperMode !== 'dual_hole')) {
              this.ensureAttachedStopper(support.id, 'main', 'dual_hole');
            }
            syncDockedToolPositions(this);
          }
        }
      } else if (!support && Math.abs(it.y - centerY) <= 10) {
        it.y = centerY;
        it.vy = 0;
        it.fallStartY = null;
        if (it.kind === 'filter_funnel' || it.kind === 'separatory_funnel') it.mountedOnVesselId = null;
      } else if (prevSupId && !support && !it.isDragging) {
        // Support beneath was moved away -> begin real freefall
        it.fallStartY = it.fallStartY ?? it.y;
        if (it.kind === 'filter_funnel' || it.kind === 'separatory_funnel') it.mountedOnVesselId = null;
      }
      }
      this.recomputeScaleReadings();
    } finally {
      this._updatingSupports = false;
    }
  }

  recomputeScaleReadings() {
    for (const sc of this.items) {
      if (sc.kind !== 'scale') continue;
      let loadG = 0;
      for (const it of this.items) {
        if (it.restingOnId !== sc.id) continue;
        const spec = APPARATUS[it.typeId];
        if (it.kind === 'vessel' || it.kind === 'filter_funnel' || it.kind === 'separatory_funnel' || it.kind === 'burette') {
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
    const bSpec = APPARATUS[b.typeId] || APPARATUS.burner;
    const lvl = Math.max(0, Math.min(3, level));
    b.flameLevel = lvl;
    const tbl =
      b.typeId === 'bunsen_burner' && b.airHoleOpen === false
        ? bSpec.yellowPowerLevelsW
        : bSpec.powerLevelsW;
    b.powerW = tbl[lvl] ?? 0;
    this.emitChange();
  }

  toggleBurnerAirHole(burnerId) {
    const b = this.getItem(burnerId);
    if (!b || b.kind !== 'burner' || b.typeId !== 'bunsen_burner') return false;
    b.airHoleOpen = b.airHoleOpen === false;
    const lvl = Math.round(b.flameLevel || 0);
    if (lvl > 0) {
      const bSpec = APPARATUS.bunsen_burner;
      const tbl = b.airHoleOpen ? bSpec.powerLevelsW : bSpec.yellowPowerLevelsW;
      b.powerW = tbl[lvl] ?? b.powerW;
    }
    this.emitChange();
    return true;
  }

  setBurnerPower(burnerId, watts) {
    const b = this.getItem(burnerId);
    if (!b || b.kind !== 'burner') return;
    const bSpec = APPARATUS[b.typeId] || APPARATUS.burner;
    const maxW =
      b.typeId === 'bunsen_burner' && b.airHoleOpen === false
        ? (bSpec.yellowPowerLevelsW[3] || 820)
        : (bSpec.maxPowerW || 650);
    const w = Math.max(0, Math.min(maxW, Math.round(Number(watts) || 0)));
    b.powerW = w;
    if (w <= 0) {
      b.flameLevel = 0;
    } else {
      const tbl =
        b.typeId === 'bunsen_burner' && b.airHoleOpen === false
          ? bSpec.yellowPowerLevelsW
          : bSpec.powerLevelsW;
      if (w === tbl[1]) b.flameLevel = 1;
      else if (w === tbl[2]) b.flameLevel = 2;
      else if (w === tbl[3]) b.flameLevel = 3;
      else b.flameLevel = (w / maxW) * 3;
    }
    this.emitChange();
  }

  cycleCrucibleLid(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || !APPARATUS[v.typeId]?.hasLid) return false;
    const order = ['open', 'ajar', 'closed'];
    const idx = order.indexOf(v.lidState || 'open');
    const nextState = order[(idx + 1) % order.length];
    v.lidState = nextState;
    if (nextState !== 'closed') {
      v.sealedAirMoles = null;
      v.sealedAirO2Moles = null;
      v.internalPressureBar = this.environment.pressureBar;
    } else {
      v.sealedAirMoles = null;
      v.sealedAirO2Moles = null;
    }
    this.emitChange();
    return true;
  }

  toggleCompareVessel(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel') return false;
    const idx = this.compareVesselIds.indexOf(vesselId);
    if (idx >= 0) {
      this.compareVesselIds.splice(idx, 1);
    } else {
      if (this.compareVesselIds.length >= 3) {
        this.compareVesselIds.shift();
      }
      this.compareVesselIds.push(vesselId);
    }
    this.emitChange();
    return true;
  }

  spoonScoopFromVessel(spoonId, vesselId, maxGrams = 1.6) {
    const spoon = this.getItem(spoonId);
    const v = this.getItem(vesselId);
    if (!spoon || spoon.kind !== 'spoon' || !v || v.kind !== 'vessel' || v.isShattered) return false;
    const SPOON_MAX_VOL_ML = APPARATUS.iron_spoon?.maxVolumeMl || 2.8;
    const curSpoonBulkMl = computeSolidVolumeMl(spoon.moles || {}) * 1.25;
    const remVolMl = Math.max(0, SPOON_MAX_VOL_ML - curSpoonBulkMl);
    if (remVolMl <= 0.02) return false;
    const priorityOrder = ['Zn_s', 'Mg_s', 'Al_s', 'Na_s', 'K_s', 'S_s', 'I2_s', 'KMnO4_s', 'MnO2_s', 'K2MnO4_s', 'K3MnO4_s', 'K2MnO3_s', 'Mn2O3_s', 'Mn3O4_s', 'CaCO3_s', 'CuO_s', 'CuSO4_5H2O_s', 'Fe_s', 'Cu_s', 'CaO_s'];
    const allSolidKeys = [
      ...priorityOrder.filter((k) => (v.moles?.[k] || 0) > 1e-8),
      ...Object.keys(v.moles || {}).filter(
        (k) => !priorityOrder.includes(k) && SPECIES[k]?.phase === 's' && (v.moles[k] || 0) > 1e-8
      ),
    ];
    if (allSolidKeys.length === 0) return false;

    const spId = allSolidKeys[0];
    const sp = SPECIES[spId];
    const availMol = v.moles[spId] || 0;
    const capByVolG = (remVolMl / 1.25) * (sp?.density || 2.2);
    const takeG = Math.min(maxGrams, capByVolG);
    const takeMol = Math.min(availMol, takeG / Math.max(10, sp?.molarMass || 60));
    if (takeMol <= 1e-9) return false;

    v.moles[spId] = availMol - takeMol;
    if (v.moles[spId] < 1e-12) delete v.moles[spId];
    spoon.moles = spoon.moles || {};
    spoon.moles[spId] = (spoon.moles[spId] || 0) + takeMol;
    spoon.particleCounts = spoon.particleCounts || {};
    spoon.particleCounts[spId] = Math.max(spoon.particleCounts[spId] || 0, v.particleCounts?.[spId] || 12);
    if (v.groundPowderMap?.[spId]) {
      spoon.groundPowderMap = spoon.groundPowderMap || {};
      spoon.groundPowderMap[spId] = true;
    }
    if (v.flattenedMetalMap?.[spId]) {
      spoon.flattenedMetalMap = spoon.flattenedMetalMap || {};
      spoon.flattenedMetalMap[spId] = true;
    }
    spoon.tempK = v.tempK || this.environment.tempK;
    this.recomputeScaleReadings();
    this.emitChange();
    return true;
  }

  spoonPourIntoVessel(spoonId, vesselId) {
    const spoon = this.getItem(spoonId);
    const v = this.getItem(vesselId);
    if (!spoon || spoon.kind !== 'spoon' || !v || v.kind !== 'vessel' || v.isShattered || v.isStoppered) return false;
    const entries = Object.entries(spoon.moles || {}).filter(([, n]) => n > 1e-10);
    if (entries.length === 0) return false;

    const cVessel = Math.max(18, computeHeatCapacityJK(v));
    let cSpoon = 0;
    for (const [spId, n] of entries) {
      const sp = SPECIES[spId];
      cSpoon += n * (sp?.cp || 35);
      v.moles[spId] = (v.moles[spId] || 0) + n;
      v.particleCounts = v.particleCounts || {};
      v.particleCounts[spId] = Math.max(v.particleCounts[spId] || 0, spoon.particleCounts?.[spId] || 12);
      if (spoon.groundPowderMap?.[spId]) {
        v.groundPowderMap = v.groundPowderMap || {};
        v.groundPowderMap[spId] = true;
      }
      if (spId === 'Na_s' && (spoon.tempK || 298) > 370) {
        v.naTempK = Math.max(v.naTempK || v.tempK, spoon.tempK);
      }
      if (spId === 'K_s' && (spoon.tempK || 298) > 335) {
        v.kTempK = Math.max(v.kTempK || v.tempK, spoon.tempK);
      }
    }
    if (cSpoon > 0) {
      const tMix = (cVessel * v.tempK + cSpoon * (spoon.tempK || this.environment.tempK)) / (cVessel + cSpoon);
      v.tempK = Math.max(155, Math.min(1950, tMix));
    }
    spoon.moles = {};
    spoon.particleCounts = {};
    spoon.groundPowderMap = {};
    spoon.burnTimer = 0;
    spoon.flameColor = null;
    this.recomputeScaleReadings();
    this.recordHistorySnapshot(v, true);
    this.emitChange();
    return true;
  }

  rinseSpoon(spoonId) {
    const spoon = this.getItem(spoonId);
    if (!spoon || spoon.kind !== 'spoon') return false;
    spoon.spoonAnim = null;
    spoon.tiltAngle = 0;
    spoon.moles = {};
    spoon.particleCounts = {};
    spoon.groundPowderMap = {};
    spoon.burnTimer = 0;
    spoon.flameColor = null;
    spoon.tempK = this.environment.tempK;
    this.emitChange();
    return true;
  }

  startSpoonAction(spoonId, action, vesselId, targetG = 1.5) {
    const spoon = this.getItem(spoonId);
    const v = this.getItem(vesselId);
    if (!spoon || spoon.kind !== 'spoon' || !v || v.kind !== 'vessel' || v.isShattered || v.isStoppered) {
      return false;
    }
    if (action === 'scoop') {
      const hasSolids = Object.entries(v.moles || {}).some(([k, n]) => SPECIES[k]?.phase === 's' && n > 1e-8);
      if (!hasSolids) return false;
    } else if (action === 'pour') {
      const hasSpoonSolids = Object.values(spoon.moles || {}).some((n) => n > 1e-9);
      if (!hasSpoonSolids) return false;
    } else {
      return false;
    }
    spoon.restingOnId = null;
    spoon.vy = 0;
    spoon.spoonAnim = {
      action,
      vesselId: v.id,
      targetG,
      phase: 0,
      duration: 0.72,
      startX: spoon.x,
      startY: spoon.y,
      transferred: false,
    };
    this.emitChange();
    return true;
  }

  stepSpoonAnimations(dt) {
    if (!dt || dt <= 0) return;
    const smoothstep = (u) => {
      const c = Math.max(0, Math.min(1, u));
      return c * c * (3 - 2 * c);
    };
    for (const spoon of this.items) {
      if (spoon.kind !== 'spoon' || !spoon.spoonAnim || spoon.isDragging) continue;
      const anim = spoon.spoonAnim;
      const v = this.getItem(anim.vesselId);
      if (!v || v.isShattered || v.isStoppered) {
        spoon.spoonAnim = null;
        spoon.tiltAngle = 0;
        spoon.fallStartY = spoon.y;
        continue;
      }
      const vSpec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
      const spoonDir = v.x >= anim.startX ? 1 : -1;
      spoon.flippedX = spoonDir > 0;
      const hoverX = v.x - spoonDir * 2;
      const hoverTopY = v.y - vSpec.height / 2 - 58;
      const scoopDipY = Math.min(v.y + 4, hoverTopY + 34);

      anim.phase = Math.min(1.0, anim.phase + dt / (anim.duration || 0.72));
      const p = anim.phase;

      if (p < 0.36) {
        const u = smoothstep(p / 0.36);
        spoon.x = anim.startX + (hoverX - anim.startX) * u;
        spoon.y = anim.startY + (hoverTopY - anim.startY) * u;
        spoon.tiltAngle = 0;
      } else if (p < 0.72) {
        const uAct = (p - 0.36) / 0.36;
        spoon.x = hoverX;
        if (anim.action === 'scoop') {
          const dip = Math.sin(uAct * Math.PI);
          spoon.y = hoverTopY + (scoopDipY - hoverTopY) * dip;
          spoon.tiltAngle = spoonDir * -0.28 * dip;
        } else {
          const pourCurve = Math.sin(uAct * Math.PI);
          spoon.y = hoverTopY - 2;
          spoon.tiltAngle = spoonDir * 0.52 * pourCurve;
        }
        if (p >= 0.52 && !anim.transferred) {
          anim.transferred = true;
          const solidKeys = Object.entries(
            anim.action === 'scoop' ? v.moles || {} : spoon.moles || {}
          )
            .filter(([k, n]) => SPECIES[k]?.phase === 's' && n > 1e-9)
            .sort((a, b) => b[1] - a[1]);
          const spCol = solidKeys[0] ? SPECIES[solidKeys[0][0]]?.color : '#e2e8f0';
          if (anim.action === 'scoop') {
            this.spoonScoopFromVessel(spoon.id, v.id, anim.targetG);
            this.visualHooks.onAlert?.('spoon_scoop', v, { color: spCol, x: v.x, y: v.y });
          } else {
            this.spoonPourIntoVessel(spoon.id, v.id);
            this.visualHooks.onAlert?.('spoon_pour', v, {
              color: spCol,
              fromX: v.x,
              fromY: hoverTopY + 8,
              toY: v.y,
            });
          }
        }
      } else {
        const uBack = smoothstep((p - 0.72) / 0.28);
        spoon.x = hoverX + (anim.startX - hoverX) * uBack;
        spoon.y = hoverTopY + (anim.startY - hoverTopY) * uBack;
        spoon.tiltAngle = 0;
      }

      spoon.vy = 0;
      spoon.restingOnId = null;
      if (p >= 1.0) {
        spoon.spoonAnim = null;
        spoon.tiltAngle = 0;
        spoon.fallStartY = spoon.y;
        this.updateSupportAttachments();
        this.emitChange();
      }
    }
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
    vessel.leftStoppered = false;
    vessel.rightStoppered = false;
    if (prevTargetId) {
      this.disconnectSyringe(vessel.id);
    }
    for (const it of this.items) {
      if (it.kind === 'rubber_stopper' && it.attachedToId === vessel.id) {
        it.attachedToId = null;
        it.attachedSide = null;
        it.vy = -170;
        it.fallStartY = it.y;
      }
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

  getMouthSlotCoords(vessel, side = 'main') {
    if (!vessel || vessel.kind !== 'vessel') return null;
    const spec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
    const effTilt = (vessel.tiltAngle || 0) + (vessel.landingTilt || 0);
    if (spec.hasTwoEnds) {
      const ends = getVesselEndPorts(vessel);
      const s = side === 'left' || side === 'right' ? side : 'right';
      const p = ends?.[s];
      return p ? { x: p.mouthX, y: p.mouthY, side: s, tiltRad: effTilt } : null;
    }
    const rawY = vessel.isInverted ? vessel.y + spec.height / 2 - 1 : vessel.y - spec.height / 2 + 1;
    const cos = Math.cos(effTilt);
    const sin = Math.sin(effTilt);
    const dx = 0;
    const dy = rawY - vessel.y;
    return {
      x: vessel.x + dx * cos - dy * sin,
      y: vessel.y + dx * sin + dy * cos,
      side: 'main',
      tiltRad: effTilt,
    };
  }

  syncAttachedMouthTools() {
    for (const it of this.items) {
      if (it.kind === 'vessel') {
        it._physStopperMain = false;
        it._physStopperLeft = false;
        it._physStopperRight = false;
        it._physCottonMain = false;
        it._physCottonLeft = false;
        it._physCottonRight = false;
      }
    }
    for (const it of this.items) {
      if ((it.kind !== 'rubber_stopper' && it.kind !== 'phen_cotton') || !it.attachedToId) {
        if (it.kind === 'rubber_stopper' || it.kind === 'phen_cotton') {
          it._attachOrient = 'top';
          it._tiltRad = 0;
        }
        continue;
      }
      const v = this.getItem(it.attachedToId);
      if (!v || v.isShattered) {
        it.attachedToId = null;
        it.attachedSide = null;
        it._attachOrient = 'top';
        it._tiltRad = 0;
        it.fallStartY = it.y;
        continue;
      }
      const vSpec = APPARATUS[v.typeId];
      const side = it.attachedSide || 'main';
      if (it.kind === 'rubber_stopper') {
        if (side === 'left') v._physStopperLeft = true;
        else if (side === 'right') v._physStopperRight = true;
        else v._physStopperMain = true;
      } else {
        if (side === 'left') v._physCottonLeft = true;
        else if (side === 'right') v._physCottonRight = true;
        else v._physCottonMain = true;
      }
      it._attachOrient = vSpec?.isHorizontalTube ? side : v.isInverted ? 'bottom' : 'top';
      const slot = this.getMouthSlotCoords(v, side);
      if (slot) {
        it.x = slot.x;
        it.y = slot.y;
        it._tiltRad = slot.tiltRad || 0;
        it.vy = 0;
        it.restingOnId = null;
      }
    }
  }

  attachRubberStopper(stopperId, vesselId, side = 'main') {
    const st = this.getItem(stopperId);
    const v = this.getItem(vesselId);
    if (!st || st.kind !== 'rubber_stopper' || !v || v.kind !== 'vessel' || v.isShattered) return false;
    const spec = APPARATUS[v.typeId];
    if (!spec?.stopperable) return false;

    const chosenSide = spec.hasTwoEnds ? (side === 'left' || side === 'right' ? side : 'right') : 'main';
    if (st.attachedToId && (st.attachedToId !== v.id || st.attachedSide !== chosenSide)) {
      this.detachRubberStopper(st.id, { keepPos: true, silent: true });
    }

    for (const other of this.items) {
      if (other.id === st.id) continue;
      if (other.kind === 'rubber_stopper' && other.attachedToId === v.id && (other.attachedSide || 'main') === chosenSide) {
        this.detachRubberStopper(other.id, { keepPos: true, silent: true });
      } else if (other.kind === 'phen_cotton' && other.attachedToId === v.id && (other.attachedSide || 'main') === chosenSide) {
        this.detachPhenCotton(other.id, { silent: true });
      }
    }

    st.attachedToId = v.id;
    st.attachedSide = chosenSide;
    st.restingOnId = null;
    st.vy = 0;

    if (spec.hasTwoEnds) {
      if (chosenSide === 'left') {
        v.leftStoppered = true;
        v.leftHasPhenCotton = false;
        v.phenCottonLeftLevel = 0;
      } else {
        v.rightStoppered = true;
        v.rightHasPhenCotton = false;
        v.phenCottonRightLevel = 0;
      }
      v.isStoppered = Boolean(v.leftStoppered && v.rightStoppered);
    } else {
      v.isStoppered = true;
      v.hasPhenCotton = false;
      v.phenCottonLevel = 0;
    }
    v.stopperMode = st.stopperMode || 'holed';
    v.overflowRateMlS = 0;
    v.wasOverflowing = false;
    v.sealedAirMoles = null;
    this.syncAttachedMouthTools();
    this.checkOverflow(v);
    this.emitChange();
    return true;
  }

  detachRubberStopper(stopperId, opts = {}) {
    const st = this.getItem(stopperId);
    if (!st || st.kind !== 'rubber_stopper' || !st.attachedToId) return false;
    const v = this.getItem(st.attachedToId);
    const oldSide = st.attachedSide || 'main';
    st.attachedToId = null;
    st.attachedSide = null;
    if (!opts.keepPos && v) {
      const slot = this.getMouthSlotCoords(v, oldSide);
      if (slot) {
        st.x = slot.x;
        st.y = slot.y - 26;
      }
    }
    st.fallStartY = st.y;
    if (v && !v.isShattered) {
      const spec = APPARATUS[v.typeId];
      if (spec?.hasTwoEnds) {
        if (oldSide === 'left') v.leftStoppered = false;
        else v.rightStoppered = false;
        v.isStoppered = Boolean(v.leftStoppered && v.rightStoppered);
        if ((v.connectedTargetId || v.connectedSyringeId) && (v.connectedPortSide || (v.flippedX ? 'left' : 'right')) === oldSide) {
          this.disconnectSyringe(v.id);
        }
      } else {
        v.isStoppered = false;
        this.disconnectSyringe(v.id);
      }
      if (!v.isStoppered) {
        // Equalize ONLY excess gauge overpressure on unstoppering; keep ~1 atm gas in headspace for realistic density diffusion!
        const pEnv = this.environment.pressureBar || CONSTANTS.P_STD_BAR;
        const pIn = v.internalPressureBar || pEnv;
        const releaseFrac = pIn > pEnv + 0.005 ? Math.min(1, (pIn - pEnv) / pIn) : 0;
        if (releaseFrac > 0) {
          for (const g of ALL_GASES) {
            const cur = v.headspaceGasMoles[g] || 0;
            if (cur > 0) {
              const ex = cur * releaseFrac;
              v.escapedGasMoles[g] = (v.escapedGasMoles[g] || 0) + ex;
              v.headspaceGasMoles[g] = cur - ex;
            }
          }
        }
        v.sealedAirMoles = null;
        v.internalPressureBar = pEnv;
      }
    }
    if (!opts.silent) this.emitChange();
    return true;
  }

  setStopperMode(stopperId, mode) {
    const st = this.getItem(stopperId);
    if (!st || st.kind !== 'rubber_stopper') return false;
    const normMode = mode === 'solid' ? 'solid' : mode === 'dual_hole' ? 'dual_hole' : 'holed';
    st.stopperMode = normMode;
    if (st.attachedToId) {
      const v = this.getItem(st.attachedToId);
      if (v) {
        const oldSide = st.attachedSide || 'main';
        const spec = APPARATUS[v.typeId];
        const hasSep = this.items.some((f) => f.kind === 'separatory_funnel' && !f.isBroken && f.mountedOnVesselId === v.id);
        if (st.stopperMode === 'solid') {
          if (!spec?.hasTwoEnds || (v.connectedPortSide || (v.flippedX ? 'left' : 'right')) === oldSide) {
            this.disconnectSyringe(v.id);
          }
          if (!spec?.hasTwoEnds && hasSep) {
            for (const f of this.items) {
              if (f.kind === 'separatory_funnel' && f.mountedOnVesselId === v.id) {
                f.mountedOnVesselId = null;
                f.restingOnId = null;
              }
            }
          }
        } else if (st.stopperMode === 'holed' && !spec?.hasTwoEnds && hasSep) {
          // 1-hole stopper only has 1 bore (occupied by funnel stem) -> disconnect tubing unless switched to dual_hole
          this.disconnectSyringe(v.id);
        }
        v.stopperMode = st.stopperMode;
      }
    }
    syncDockedToolPositions(this);
    this.emitChange();
    return true;
  }

  attachPhenCotton(cottonId, vesselId, side = 'main') {
    const ct = this.getItem(cottonId);
    const v = this.getItem(vesselId);
    if (!ct || ct.kind !== 'phen_cotton' || !v || v.kind !== 'vessel' || v.isShattered) return false;
    const spec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
    const chosenSide = spec.hasTwoEnds ? (side === 'left' || side === 'right' ? side : 'right') : 'main';
    const isBlockedByStopper = spec.hasTwoEnds
      ? (chosenSide === 'left' ? v.leftStoppered : v.rightStoppered)
      : v.isStoppered;
    if (isBlockedByStopper) return false;

    if (ct.attachedToId && (ct.attachedToId !== v.id || ct.attachedSide !== chosenSide)) {
      this.detachPhenCotton(ct.id, { silent: true });
    }
    for (const other of this.items) {
      if (other.id !== ct.id && other.kind === 'phen_cotton' && other.attachedToId === v.id && (other.attachedSide || 'main') === chosenSide) {
        this.detachPhenCotton(other.id, { silent: true });
      }
    }

    ct.attachedToId = v.id;
    ct.attachedSide = chosenSide;
    ct.restingOnId = null;
    ct.vy = 0;
    if (spec.hasTwoEnds) {
      if (chosenSide === 'left') {
        v.leftHasPhenCotton = true;
        v.phenCottonLeftLevel = ct.pinkLevel || 0;
      } else {
        v.rightHasPhenCotton = true;
        v.phenCottonRightLevel = ct.pinkLevel || 0;
      }
    } else {
      v.hasPhenCotton = true;
      v.phenCottonLevel = ct.pinkLevel || 0;
    }
    this.syncAttachedMouthTools();
    this.emitChange();
    return true;
  }

  detachPhenCotton(cottonId, opts = {}) {
    const ct = this.getItem(cottonId);
    if (!ct || ct.kind !== 'phen_cotton' || !ct.attachedToId) return false;
    const v = this.getItem(ct.attachedToId);
    const oldSide = ct.attachedSide || 'main';
    ct.attachedToId = null;
    ct.attachedSide = null;
    ct.fallStartY = ct.y;
    if (v) {
      const spec = APPARATUS[v.typeId];
      if (spec?.hasTwoEnds) {
        if (oldSide === 'left') {
          v.leftHasPhenCotton = false;
          v.phenCottonLeftLevel = 0;
        } else {
          v.rightHasPhenCotton = false;
          v.phenCottonRightLevel = 0;
        }
      } else {
        v.hasPhenCotton = false;
        v.phenCottonLevel = 0;
      }
    }
    if (!opts.silent) this.emitChange();
    return true;
  }

  ensureAttachedStopper(vesselId, side = 'main', mode = 'holed') {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered) return null;
    const spec = APPARATUS[v.typeId];
    if (!spec?.stopperable) return null;
    const chosenSide = spec.hasTwoEnds ? (side === 'left' || side === 'right' ? side : 'right') : 'main';
    let st = this.items.find(
      (it) => it.kind === 'rubber_stopper' && it.attachedToId === v.id && (it.attachedSide || 'main') === chosenSide
    );
    const normMode = mode === 'solid' ? 'solid' : mode === 'dual_hole' ? 'dual_hole' : 'holed';
    if (!st) {
      const slot = this.getMouthSlotCoords(v, chosenSide) || { x: v.x, y: v.y - 40 };
      st = this.createApparatus('rubber_stopper', slot.x, slot.y, { silent: true });
      st.stopperMode = normMode;
      this.attachRubberStopper(st.id, v.id, chosenSide);
    } else if (mode && st.stopperMode !== normMode) {
      st.stopperMode = normMode;
      v.stopperMode = st.stopperMode;
    }
    return st;
  }

  toggleStopper(vesselId, side = null) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered) return false;
    const spec = APPARATUS[v.typeId];
    if (!spec.stopperable) return false;

    if (spec.hasTwoEnds && (side === 'left' || side === 'right')) {
      const flag = side === 'left' ? 'leftStoppered' : 'rightStoppered';
      if (v[flag]) {
        v[flag] = false;
        if ((v.connectedPortSide || (v.flippedX ? 'left' : 'right')) === side) {
          this.disconnectSyringe(v.id);
        }
        for (const it of this.items) {
          if (it.kind === 'rubber_stopper' && it.attachedToId === v.id && (it.attachedSide || 'right') === side) {
            this.detachRubberStopper(it.id, { silent: true });
          }
        }
      } else {
        this.ensureAttachedStopper(v.id, side, 'solid');
      }
      v.isStoppered = Boolean(v.leftStoppered && v.rightStoppered);
      this.emitChange();
      return true;
    }

    if (v.isStoppered) {
      this.disconnectSyringe(v.id);
      const attached = this.items.filter((it) => it.kind === 'rubber_stopper' && it.attachedToId === v.id);
      if (attached.length > 0) {
        for (const st of attached) this.detachRubberStopper(st.id, { silent: true });
      } else {
        v.isStoppered = false;
        v.leftStoppered = false;
        v.rightStoppered = false;
        v.sealedAirMoles = null;
        v.internalPressureBar = this.environment.pressureBar;
      }
    } else {
      if (spec.hasTwoEnds) {
        this.ensureAttachedStopper(v.id, 'left', 'solid');
        this.ensureAttachedStopper(v.id, 'right', 'solid');
      } else {
        this.ensureAttachedStopper(v.id, 'main', 'solid');
      }
    }
    this.emitChange();
    return true;
  }

  connectTube(vesselId, targetId = null, opts = {}) {
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

    if (spec.hasTwoEnds) {
      const inSide = v.connectedFromId ? v.incomingPortSide || (v.flippedX ? 'right' : 'left') : null;
      const side =
        opts.side ||
        v.connectedPortSide ||
        (inSide ? (inSide === 'left' ? 'right' : 'left') : v.flippedX ? 'left' : 'right');
      v.connectedPortSide = side;
      this.ensureAttachedStopper(v.id, side, 'holed');
      // When invoked without explicit side (e.g. preset workflow) and not part of an active flow-through train, seal opposite end so gas drives downstream cleanly
      if (!opts.side && !v.connectedFromId && !v.leftStoppered && side === 'right') {
        this.ensureAttachedStopper(v.id, 'left', 'solid');
      }
      if (!opts.side && !v.connectedFromId && !v.rightStoppered && side === 'left') {
        this.ensureAttachedStopper(v.id, 'right', 'solid');
      }
      v.isStoppered = Boolean(v.leftStoppered && v.rightStoppered);
    } else {
      // Unified single stopper system: preserve dual_hole (or auto-upgrade when a separatory funnel is mounted)
      const hasMountedSep = this.items.some((f) => f.kind === 'separatory_funnel' && !f.isBroken && f.mountedOnVesselId === v.id);
      const targetStopperMode = hasMountedSep || v.stopperMode === 'dual_hole' ? 'dual_hole' : 'holed';
      this.ensureAttachedStopper(v.id, 'main', targetStopperMode);
    }
    v.overflowRateMlS = 0;
    v.wasOverflowing = false;
    v.connectedTargetId = target.id;
    v.connectedSyringeId = target.kind === 'gas_syringe' ? target.id : null;
    if (APPARATUS[target.typeId]?.hasTwoEnds) {
      target.incomingPortSide = opts.targetSide || target.incomingPortSide || (target.flippedX ? 'right' : 'left');
    }
    target.connectedFromId = v.id;

    // Only vent pressurized excess into syringe on initial connection (do not suck quiescent gas prematurely)
    if (target.kind === 'gas_syringe' && (v.internalPressureBar || this.environment.pressureBar) > this.environment.pressureBar + 0.005) {
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
        target.incomingPortSide = null;
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
    // Do NOT disconnect intact tubing when pushing plunger! Connected syringe pumps gradually through the tube.
    syr.isDischarging = !!active;
    syr.dischargeMode = mode || 'both';
    if (!active) {
      syr.dischargeLiquidRateMlS = 0;
    }
    this.emitChange();
    return true;
  }

  /**
   * Shared delivery helper: transfer fractional liquid and gas from Gas Syringe into a receiving Vessel's moles & headspaceGasMoles.
   */
  _deliverSyringeSliceToVessel(syr, dst, liqMoveFrac, gasMoveFrac, syrT, dtApprox = 0.05) {
    let movedLiqColor = 'rgba(186, 230, 253, 0.85)';
    if (liqMoveFrac > 1e-6) {
      const combMoles = buildCombinedSyringeLiquidMoles(syr);
      const combL = computeLiquidVolumeL(combMoles, syrT);
      if (combL > 1e-8) {
        movedLiqColor = computeSolutionVisuals(combMoles, combL, computePH(combMoles, combL, syrT), 2.5, syr.overflowBleachFrac || 0).css;
      }
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
    }

    if (gasMoveFrac > 1e-6) {
      let heatAddedJ = 0;
      let addedCapJK = 0;
      dst.headspaceGasMoles = dst.headspaceGasMoles || createEmptyGasMap();
      const steamMol = (syr.gasMoles.H2O_g || 0) * gasMoveFrac;
      if (steamMol > 1e-10) {
        syr.gasMoles.H2O_g = Math.max(0, (syr.gasMoles.H2O_g || 0) - steamMol);
        if (dst.tempK < waterBoilingPointK(this.environment.pressureBar)) {
          dst.moles.H2O_l = (dst.moles.H2O_l || 0) + steamMol;
          heatAddedJ += steamMol * CONSTANTS.DELTA_H_VAP_WATER_J;
          addedCapJK += steamMol * CONSTANTS.CP_H2O_J_MOL_K;
        } else {
          dst.headspaceGasMoles.H2O_g = (dst.headspaceGasMoles.H2O_g || 0) + steamMol;
        }
      }
      const etMol = (syr.gasMoles.C2H5OH_g || 0) * gasMoveFrac;
      if (etMol > 1e-10) {
        syr.gasMoles.C2H5OH_g = Math.max(0, (syr.gasMoles.C2H5OH_g || 0) - etMol);
        if (dst.tempK < SPECIES.C2H5OH_l.boilTempK) {
          dst.moles.C2H5OH_l = (dst.moles.C2H5OH_l || 0) + etMol;
          heatAddedJ += etMol * SPECIES.C2H5OH_l.dHVapJ;
          addedCapJK += etMol * SPECIES.C2H5OH_l.cp;
        } else {
          dst.headspaceGasMoles.C2H5OH_g = (dst.headspaceGasMoles.C2H5OH_g || 0) + etMol;
        }
      }
      const hclMol = (syr.gasMoles.HCl_g || 0) * gasMoveFrac;
      if (hclMol > 1e-10) {
        syr.gasMoles.HCl_g = Math.max(0, (syr.gasMoles.HCl_g || 0) - hclMol);
        if ((dst.moles.CuSO4_s || 0) > 1e-8 && (dst.moles.H2O_l || 0) < 1e-3 && dst.tempK < 405) {
          const dAdd = Math.min(dst.moles.CuSO4_s, hclMol / 2);
          dst.moles.CuSO4_s -= dAdd;
          if (dst.moles.CuSO4_s < 1e-13) delete dst.moles.CuSO4_s;
          dst.moles.CuSO4_2HCl_s = (dst.moles.CuSO4_2HCl_s || 0) + dAdd;
          heatAddedJ += dAdd * 68000;
          const rem = hclMol - 2 * dAdd;
          if (rem > 1e-12) dst.headspaceGasMoles.HCl_g = (dst.headspaceGasMoles.HCl_g || 0) + rem;
        } else if ((dst.moles.H2O_l || 0) > 1e-4) {
          dst.moles.H_aq = (dst.moles.H_aq || 0) + hclMol;
          dst.moles.Cl_aq = (dst.moles.Cl_aq || 0) + hclMol;
          heatAddedJ += hclMol * CONSTANTS.DELTA_H_VAP_HCL_AQ_J;
        } else {
          dst.headspaceGasMoles.HCl_g = (dst.headspaceGasMoles.HCl_g || 0) + hclMol;
        }
        dst.gasFlushInMol = (dst.gasFlushInMol || 0) + hclMol;
      }
      const nh3Mol = (syr.gasMoles.NH3_g || 0) * gasMoveFrac;
      if (nh3Mol > 1e-10) {
        syr.gasMoles.NH3_g = Math.max(0, (syr.gasMoles.NH3_g || 0) - nh3Mol);
        if ((dst.moles.H2O_l || 0) > 1e-4) {
          dst.moles.NH3_aq = (dst.moles.NH3_aq || 0) + nh3Mol;
          heatAddedJ += nh3Mol * 35400;
        } else {
          dst.headspaceGasMoles.NH3_g = (dst.headspaceGasMoles.NH3_g || 0) + nh3Mol;
        }
        if (dst.hasPhenCotton) dst.phenCottonLevel = 1.0;
        dst.gasFlushInMol = (dst.gasFlushInMol || 0) + nh3Mol;
      }
      if ((syr.gasMoles.C2H5Cl_g || 0) * gasMoveFrac > 1e-9 && dst.restingOnId) {
        dst.recentHalogenGasTimer = 1.8;
      }
      let pushedNonSteamMol = 0;
      const compList = [];
      for (const g of NON_STEAM_GASES) {
        if (g === 'HCl_g' || g === 'NH3_g') continue;
        const m = (syr.gasMoles[g] || 0) * gasMoveFrac;
        if (m > 1e-10) {
          syr.gasMoles[g] = Math.max(0, (syr.gasMoles[g] || 0) - m);
          dst.headspaceGasMoles[g] = (dst.headspaceGasMoles[g] || 0) + m;
          dst.gasFlushInMol = (dst.gasFlushInMol || 0) + m;
          pushedNonSteamMol += m;
          compList.push({ id: g, formula: SPECIES[g]?.formula || g, mol: m });
        }
      }
      if (pushedNonSteamMol > 1e-10) {
        if ((dst.moles.H2O_l || 0) > 1e-4) {
          dst._tubeBubbleGasMol = (dst._tubeBubbleGasMol || 0) + pushedNonSteamMol;
        }
        compList.sort((a, b) => b.mol - a.mol);
        const volMlS = (((pushedNonSteamMol * CONSTANTS.R_L_BAR_MOL_K * syrT) / Math.max(0.2, this.environment.pressureBar)) * 1000) / Math.max(0.01, dtApprox);
        dst._liveTubeFlow = {
          composition: compList.slice(0, 3).map((c) => ({ ...c, pct: Math.round((c.mol / pushedNonSteamMol) * 100) })),
          rateMlS: Number.isFinite(volMlS) ? volMlS : 0,
          totalMlS: Number.isFinite(volMlS) ? volMlS : 0,
          tempC: syrT - 273.15,
          updatedAt: Date.now(),
        };
      }
      if (heatAddedJ > 0) {
        const cDst = computeHeatCapacityJK(dst);
        dst.tempK = Math.min(waterBoilingPointK(this.environment.pressureBar), dst.tempK + heatAddedJ / Math.max(30, cDst + addedCapJK));
      }
    }
    this.checkOverflow(dst);
    return movedLiqColor;
  }

  pumpSyringeToVessel(syringeId, targetVesselId, targetVolMl = null) {
    const syr = this.getItem(syringeId);
    const dst = this.getItem(targetVesselId);
    if (!syr || syr.kind !== 'gas_syringe' || syr.isBroken) return 0;
    if (!dst || dst.kind !== 'vessel' || dst.isShattered) return 0;
    // Keep tubing intact if pumping into the already connected vessel! Only detach if targeting a separate flask manually.
    if (syr.connectedFromId && syr.connectedFromId !== dst.id) this.disconnectSyringe(syr.connectedFromId);

    const syrT = syr.tempK ?? this.environment.tempK;
    const liqMl = computeSyringeLiquidVolumeMl(syr, this.environment);
    const gasMl = computeSyringeGasVolumeMl(syr, this.environment);
    const totMl = liqMl + gasMl;
    if (totMl <= 0.005) return 0;

    const reqMl = targetVolMl == null ? totMl : Math.min(totMl, Math.max(0, Number(targetVolMl) || 0));
    let transferredMl = 0;
    let liqMoveFrac = 0;
    let gasMoveFrac = 0;

    if (liqMl > 0.005) {
      liqMoveFrac = targetVolMl == null ? 1.0 : Math.min(1, reqMl / liqMl);
      transferredMl += liqMl * liqMoveFrac;
    }
    if (gasMl > 0.01 && (targetVolMl == null || transferredMl < reqMl)) {
      gasMoveFrac = targetVolMl == null ? 1.0 : Math.min(1, (reqMl - transferredMl) / gasMl);
      transferredMl += gasMl * gasMoveFrac;
    }

    const visCss = this._deliverSyringeSliceToVessel(syr, dst, liqMoveFrac, gasMoveFrac, syrT, 0.25);
    if (liqMoveFrac > 0 && syr.connectedFromId !== dst.id) {
      this.activePourStream = {
        fromX: getSyringeGeometry(syr).nozzleX,
        fromY: syr.y,
        toX: dst.x,
        toY: dst.y - APPARATUS[dst.typeId].height * 0.28,
        color: visCss,
        timer: 0.35,
        pouredMl: liqMl * liqMoveFrac,
      };
    }
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
    const connectedDst = syringe.connectedFromId ? this.getItem(syringe.connectedFromId) : null;
    if (connectedDst && connectedDst.kind === 'vessel' && !connectedDst.isShattered) {
      // Gradual controlled pumping through connected tubing (~18..55 mL/s) straight into receiving vessel headspace/solution!
      syringe.dischargeArc = null;
      const rateMlS = isAuto
        ? Math.max(14, totalMl / Math.max(0.45, syringe.autoDischargeTimer + dt))
        : Math.max(15, Math.min(55, 16 + totalMl * 0.22));
      const pushTotalMl = Math.min(totalMl, rateMlS * dt);
      let pushLiqMl = 0;
      let pushGasMl = 0;
      if (liqMl > 0.002) {
        pushLiqMl = Math.min(liqMl, pushTotalMl * (gasMl <= 0.05 ? 1.0 : 0.65));
        pushGasMl = Math.min(gasMl, Math.max(0, pushTotalMl - pushLiqMl));
      } else {
        pushGasMl = Math.min(gasMl, pushTotalMl);
      }
      const fracLiq = liqMl > 1e-5 ? Math.min(1, pushLiqMl / liqMl) : 0;
      const fracGas = gasMl > 1e-5 ? Math.min(1, pushGasMl / gasMl) : 0;
      const movedColor = this._deliverSyringeSliceToVessel(syringe, connectedDst, fracLiq, fracGas, syrT, dt);
      syringe.dischargeLiquidRateMlS = pushLiqMl > 1e-4 ? pushLiqMl / Math.max(1e-4, dt) : 0;
      syringe.dischargeColor = movedColor;
      return;
    }

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
    if (v.isSupersaturated) {
      v.crystallizeTriggered = true;
    }
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
    v.leftStoppered = false;
    v.rightStoppered = false;
    v.connectedPortSide = null;
    v.leftHasPhenCotton = false;
    v.rightHasPhenCotton = false;
    v.phenCottonLeftLevel = 0;
    v.phenCottonRightLevel = 0;
    v.horizontalSpillRateMlS = 0;
    v.horizontalSpillLeft = false;
    v.horizontalSpillRight = false;
    v.horizontalSpillColor = null;
    for (const it of this.items) {
      if ((it.kind === 'rubber_stopper' || it.kind === 'phen_cotton') && it.attachedToId === v.id) {
        it.attachedToId = null;
        it.attachedSide = null;
        it.fallStartY = it.y;
      }
    }
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
    v.znPassivationFrac = 0;
    v.isSupersaturated = false;
    v.crystallizeTriggered = false;
    v.pickeringFoamMl = 0;
    v.pickeringOverflowActive = false;
    v.naWakeTrail = [];
    v.kWakeTrail = [];
    v.phenBleachFrac = 0;
    v.phenIrrevFrac = 0;
    v.gardenActive = false;
    v.gardenGrowth = 0;
    v.hasPhenCotton = false;
    v.phenCottonLevel = 0;
    v.recentHalogenGasTimer = 0;
    v.naHazardFlag = false;
    v.kHazardFlag = false;
    v.overflowRateMlS = 0;
    v.overflowColor = null;
    v.wasOverflowing = false;
    v.spilledPuddleColor = null;
    v.naTempK = null;
    v.naPinned = false;
    v.naIgnited = false;
    v.localH2Mol = 0;
    v.kTempK = null;
    v.kPinned = false;
    v.kIgnited = false;
    v.localKH2Mol = 0;
    v.mgCombustionTimer = 0;
    v.alCombustionTimer = 0;
    v.kDryBurnTimer = 0;
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
    v.sootLevel = 0;
    v.nh4clFrostLevel = 0;
    v.wallResidueMap = {};
    v._concField = null;
    if ((v.silverMirrorLevel || 0) > 0.08) {
      // Tollens silver mirror cannot be washed away with pure water; only HNO3 dissolves it!
      this.addLog({ type: 'alert', key: 'alertSilverMirrorNeedsHNO3', vesselLabel: v.label });
    }
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
      v.kind === 'vessel' ||
      v.kind === 'filter_funnel' ||
      v.kind === 'separatory_funnel' ||
      (v.kind === 'burette' && reg.kind === 'liquid') ||
      (v.kind === 'spoon' && (reg.kind === 'solid' || reg.kind === 'liquid'));
    if (!isContainer) return false;

    let amt = Math.max(0, Number(amount) || 0);
    if (v.kind === 'burette' || v.kind === 'separatory_funnel') {
      const capMl = v.kind === 'burette' ? 50.0 : APPARATUS.separatory_funnel?.maxVolumeMl || 100.0;
      const curMl = computeLiquidVolumeL(v.moles, v.tempK) * 1000;
      amt = Math.min(amt, Math.max(0, capMl - curMl));
    } else if (v.kind === 'spoon') {
      const SPOON_MAX_VOL_ML = APPARATUS.iron_spoon?.maxVolumeMl || 2.8;
      if (reg.kind === 'liquid') {
        const curLiqMl = computeLiquidVolumeL(v.moles, v.tempK) * 1000;
        const curSolBulkMl = computeSolidVolumeMl(v.moles) * 1.25;
        amt = Math.min(amt, Math.max(0, SPOON_MAX_VOL_ML - curLiqMl - curSolBulkMl));
      } else if (reg.kind === 'solid') {
        const sp = SPECIES[reg.speciesId];
        const curSolBulkMl = computeSolidVolumeMl(v.moles) * 1.25;
        const curLiqMl = computeLiquidVolumeL(v.moles, v.tempK) * 1000;
        const remVolMl = Math.max(0, SPOON_MAX_VOL_ML - curSolBulkMl - curLiqMl);
        const maxFitG = (remVolMl / 1.25) * (sp?.density || 2.2);
        if (maxFitG <= 0.005) {
          if (!options?.silentEmit) {
            this.addLog({ type: 'alert', key: 'alertOverflow', vesselLabel: v.label });
          }
          return false;
        }
        if (amt > maxFitG) {
          amt = maxFitG;
          if (!options?.silentEmit) {
            this.addLog({ type: 'alert', key: 'alertOverflow', vesselLabel: v.label });
          }
        }
      }
    }
    if (amt <= 0) return false;
    if (!options?.silentUndo && !options?.silentEmit) this.recordUndo();

    // Thermal capacity & ethanol-water excess enthalpy baseline before addition
    const cOld = computeHeatCapacityJK(v);
    const tOld = v.tempK;
    const hMixBefore = computeEthanolWaterExcessEnthalpyJ(v.moles.H2O_l || 0, v.moles.C2H5OH_l || 0, tOld);
    const liqBeforeMl = computeLiquidVolumeL(v.moles, tOld) * 1000;
    const coldSplashShock =
      reg.kind === 'liquid' &&
      (APPARATUS[v.typeId]?.maxThermalStressK || 783) < 1100 &&
      tOld >= 463.15 &&
      this.environment.tempK <= 305 &&
      liqBeforeMl < 18 &&
      amt >= 5;

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
      } else if (reg.id === 'h2o' && (v.moles.H2SO4_l || 0) >= 0.04) {
        if (amt >= 1.5) {
          this.addLog({ type: 'alert', key: 'alertWaterIntoConcAcid', vesselLabel: v.label });
          dilutionHeatJ += Math.min(8500, amt * 360);
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
      const hMixAfter = computeEthanolWaterExcessEnthalpyJ(v.moles.H2O_l || 0, v.moles.C2H5OH_l || 0, tOld);
      dilutionHeatJ += Math.max(0, hMixBefore - hMixAfter);
      if (reg.perMl.Phenolphthalein_aq) {
        const newPhen = v.moles.Phenolphthalein_aq || 0;
        // Fresh indicator starts intact & unbleached (In^2-)
        v.phenBleachFrac = newPhen > 1e-14 ? (oldPhen * oldBleach) / newPhen : 0;
        v.phenIrrevFrac = newPhen > 1e-14 ? (oldPhen * (v.phenIrrevFrac || 0)) / newPhen : 0;
      }
    } else if (reg.kind === 'solid') {
      if (reg.impurityMassFractions) {
        for (const [spId, frac] of Object.entries(reg.impurityMassFractions)) {
          const spSub = SPECIES[spId];
          if (!spSub || frac <= 0) continue;
          const mSub = amt * frac;
          const nSub = mSub / spSub.molarMass;
          v.moles[spId] = (v.moles[spId] || 0) + nSub;
          addedHeatCap += nSub * (spSub.cp || 30);
        }
      } else {
        const sp = SPECIES[reg.speciesId];
        const addMol = amt / sp.molarMass;
        v.moles[reg.speciesId] = (v.moles[reg.speciesId] || 0) + addMol;
        addedHeatCap += addMol * (sp.cp || 30);
      }

      const particleCount = options.fine
        ? (reg.id === 'caco3' ? 400 : (reg.id === 'na' || reg.id === 'k') ? 48 : 180)
        : reg.id === 'na' || reg.id === 'k'
        ? 1
        : reg.id === 'fe'
        ? Math.min(42, Math.max(2, Math.round(amt / 4.0)))
        : reg.id === 'caco3'
        ? Math.min(18, Math.max(2, Math.round(amt * 1.2)))
        : reg.id === 'kmno4'
        ? Math.min(28, Math.max(4, Math.round(amt * 3)))
        : 6;
      v.particleCounts[reg.speciesId] =
        (v.particleCounts[reg.speciesId] || 0) + particleCount;
      if (options.fine) {
        v.groundPowderMap = v.groundPowderMap || {};
        v.groundPowderMap[reg.speciesId] = true;
        if (v.flattenedMetalMap?.[reg.speciesId]) delete v.flattenedMetalMap[reg.speciesId];
      }
    }

    // Mix thermal energy with reagent starting at ambient T_env
    const tAdd = this.environment.tempK;
    if (cOld + addedHeatCap > 0) {
      const nextT = (cOld * tOld + addedHeatCap * tAdd + dilutionHeatJ) / (cOld + addedHeatCap);
      v.tempK = Number.isFinite(nextT) ? Math.max(155, Math.min(1950, nextT)) : tOld;
    }
    if (dilutionHeatJ > 35) {
      v._lastExothermicTimer = 1.6;
      v.lastExothermicJ = dilutionHeatJ;
    }
    if ((reg.id === 'naoh' || reg.id === 'nh3_25') && (v.moles.Phenolphthalein_aq || 0) > 1e-8) {
      injectLocalPlume(v, 'pink', 0.5 + (Math.random() - 0.5) * 0.14, 0.14, 0.95);
    } else if (reg.id === 'cuso4_5h2o' && (v.moles.H2O_l || 0) > 1e-3) {
      injectLocalPlume(v, 'copper', 0.5 + (Math.random() - 0.5) * 0.14, 0.86, 0.9);
    }
    if (coldSplashShock && v.kind === 'vessel') {
      this.shatterVessel(v, 'alertThermalShock', 'thermal_shock');
      if (!options.silentEmit) this.emitChange();
      return true;
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

    if (v.kind === 'vessel' || v.kind === 'filter_funnel' || v.kind === 'separatory_funnel') {
      this.checkOverflow(v);
      v.liquidStratification = computePhaseStratification(
        v.moles,
        v.tempK,
        APPARATUS[v.typeId] || APPARATUS.beaker_250,
        computeSolidVolumeMl(v.moles)
      );
    }
    this.recomputeScaleReadings();
    if (v.kind === 'vessel') {
      this.recordHistorySnapshot(v, true);
    }
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
    this.recordUndo();
    if (this.environment.paused || options.instant || reg.kind === 'solid' || amt <= 0.25) {
      return this.addReagentToVessel(vesselId, reagentId, amt, { ...options, silentUndo: true });
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
    this.recordUndo();
    if (this.environment.paused || amt <= 0.25) {
      return this.pourBetweenVessels(sourceId, targetId, amt, shakeBeforePour, { silentUndo: true });
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
    return this.withUndoSuppressed(() => this._stepTimedTransfersInner(nowMsOverride));
  }

  _stepTimedTransfersInner(nowMsOverride = null) {
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
          const remLiqMl = computeLiquidVolumeL(src.moles, src.tempK) * 1000;
          if (job.totalMl >= (job.initialSrcMl || job.totalMl) - 0.1 && remLiqMl > 1e-4 && remLiqMl <= 1.2) {
            this.pourBetweenVessels(src.id, dst.id, remLiqMl + 0.2, job.shakeBeforePour, {
              rateMlS,
              pouredMlTotal: job.movedMl + remLiqMl,
              silentEmit: false,
            });
          }
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
    let dst = this.getItem(targetId);
    if (!src || !dst || src.id === dst.id || src.isShattered || dst.isShattered || src.isBroken || dst.isBroken) return 0;
    // Redirect pouring into a mounted Filter Funnel sitting inside target vessel's mouth
    if (dst.kind === 'vessel' && src.kind !== 'filter_funnel') {
      const mountedFunnel = this.items.find(
        (f) => f.kind === 'filter_funnel' && !f.isBroken && (f.mountedOnVesselId === dst.id || f.restingOnId === dst.id)
      );
      if (mountedFunnel && mountedFunnel.id !== src.id) {
        dst = mountedFunnel;
        targetId = mountedFunnel.id;
      }
    }
    const dstValid = dst.kind === 'vessel' || dst.kind === 'filter_funnel' || dst.kind === 'separatory_funnel' || dst.kind === 'burette';
    if (!dstValid) return 0;
    if (!streamOpts?.silentUndo && !streamOpts?.pouredMlTotal) this.recordUndo();

    const srcLiqL = computeLiquidVolumeL(src.moles, src.tempK);
    const srcLiqMl = srcLiqL * 1000;
    let moltenMl = 0;
    for (const [id, n] of Object.entries(src.moles)) {
      const spM = SPECIES[id];
      if (n > 1e-7 && isSolidMoltenAtTemp(spM, src.tempK, src.moles) && spM.density > 0) {
        moltenMl += (n * spM.molarMass) / spM.density;
      }
    }
    const effPourableMl = srcLiqMl + moltenMl;
    const srcSpec = APPARATUS[src.typeId] || APPARATUS.beaker_250;
    if (effPourableMl <= 0.01) {
      // Allow dry pouring solids cleanly from Mortar & Pestle or Filter Funnel paper into another vessel
      if ((srcSpec.isMortar || src.kind === 'filter_funnel') && dst.kind === 'vessel') {
        const moved = this.withUndoSuppressed(() => this.transferSolidsToVessel(sourceId, targetId, 1.0));
        return moved > 0 ? 1 : 0;
      }
      return 0;
    }

    let actualMl = Math.min(effPourableMl, Math.max(0, volumeMl));
    if (dst.kind === 'burette' || dst.kind === 'separatory_funnel') {
      const dstCapMl = dst.kind === 'burette' ? 50.0 : APPARATUS.separatory_funnel?.maxVolumeMl || 100.0;
      const dstLiqMl = computeLiquidVolumeL(dst.moles, dst.tempK) * 1000;
      actualMl = Math.min(actualMl, Math.max(0, dstCapMl - dstLiqMl));
      if (actualMl <= 1e-4) return 0;
    }
    const frac = actualMl >= effPourableMl - 0.05 ? 1.0 : Math.min(1, actualMl / effPourableMl);
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
    const dstTempBefore = dst.tempK;
    const dstLiqBeforeMl = computeLiquidVolumeL(dst.moles, dstTempBefore) * 1000;
    const hMixDstBefore = computeEthanolWaterExcessEnthalpyJ(dst.moles.H2O_l || 0, dst.moles.C2H5OH_l || 0, dstTempBefore);
    const hMixSrcBefore = computeEthanolWaterExcessEnthalpyJ(src.moles.H2O_l || 0, src.moles.C2H5OH_l || 0, src.tempK);
    const oldDstPhen = dst.moles.Phenolphthalein_aq || 0;
    const oldDstBleach = dst.phenBleachFrac || 0;
    let movedPhen = 0;
    let cMoved = 0;
    let movedNaMol = 0;
    let movedKMol = 0;

    for (const [spId, n] of Object.entries(src.moles)) {
      if (n <= 0) continue;
      const sp = SPECIES[spId];
      if (!sp) continue;

      let moveRatio = 0;
      if (sp.phase === 'l' || sp.phase === 'aq' || isSolidMoltenAtTemp(sp, src.tempK, src.moles)) {
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
              hasLiquid: srcLiqMl > 0.05,
            });
      }

      if (moveRatio <= 1e-12) continue;

      const moveMol = n * moveRatio;
      if (spId === 'Phenolphthalein_aq') movedPhen = moveMol;
      if (spId === 'Na_s') movedNaMol = moveMol;
      if (spId === 'K_s') movedKMol = moveMol;
      src.moles[spId] = n - moveMol;
      if (src.moles[spId] < 1e-13) delete src.moles[spId];
      // Quenching hot molten Sulfur (>= 260 C) into cold water forms rubbery Plastic Sulfur!
      const isPlasticQuench =
        spId === 'S_s' &&
        src.tempK >= 533.15 &&
        (dst.moles.H2O_l || 0) >= 0.05 &&
        (dst.tempK || CONSTANTS.T_STD_K) < 335.0;
      const dstSpId = isPlasticQuench ? 'S_plastic_s' : spId;
      dst.moles[dstSpId] = (dst.moles[dstSpId] || 0) + moveMol;
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
    if (movedKMol > 0 && src.kTempK != null) {
      dst.kTempK = dst.kTempK != null ? (dst.kTempK + src.kTempK) * 0.5 : src.kTempK;
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

    const hMixDstAfter = computeEthanolWaterExcessEnthalpyJ(dst.moles.H2O_l || 0, dst.moles.C2H5OH_l || 0, dstTempBefore);
    const mixHeatJ = Math.max(0, hMixDstBefore + frac * hMixSrcBefore - hMixDstAfter);
    if (
      dst.kind === 'vessel' &&
      (dst.moles.H2SO4_l || 0) >= 0.05 &&
      actualMl >= 3.0 &&
      (src.moles.H2O_l || 0) * frac > (src.moles.H2SO4_l || 0) * frac * 4.0 + 0.1
    ) {
      this.addLog({ type: 'alert', key: 'alertWaterIntoConcAcid', vesselLabel: dst.label });
    }
    if (cDstBefore + cMoved > 0) {
      const nextT = (cDstBefore * dstTempBefore + cMoved * src.tempK + mixHeatJ) / (cDstBefore + cMoved);
      dst.tempK = Number.isFinite(nextT) ? Math.max(155, Math.min(1350, nextT)) : dstTempBefore;
    }
    if (
      dst.kind === 'vessel' &&
      (APPARATUS[dst.typeId]?.maxThermalStressK || 783) < 1100 &&
      dstTempBefore >= 463.15 &&
      src.tempK <= 305 &&
      dstLiqBeforeMl < 18 &&
      actualMl >= 5
    ) {
      this.shatterVessel(dst, 'alertThermalShock', 'thermal_shock');
      return actualMl;
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
    dst.liquidStratification = computePhaseStratification(
      dst.moles,
      dst.tempK,
      APPARATUS[dst.typeId] || APPARATUS.beaker_250,
      computeSolidVolumeMl(dst.moles)
    );
    this.recomputeScaleReadings();
    if (!streamOpts.silentEmit) this.emitChange();
    return actualMl;
  }

  /**
   * Expose mathematical & conservation invariant validation for a vessel.
   */
  getVesselInvariants(vesselId) {
    return validateVesselInvariants(this.getItem(vesselId));
  }

  /**
   * Transfer solid residue/powder cleanly between containers (e.g. Filter Funnel paper or Mortar & Pestle -> Vessel).
   */
  transferSolidsToVessel(sourceId, targetId, fraction = 1.0) {
    const src = this.getItem(sourceId);
    const dst = this.getItem(targetId);
    if (!src || !dst || src.isShattered || dst.isShattered || dst.kind !== 'vessel') return 0;
    this.recordUndo();
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
    const vis = computeSolutionVisuals(b.moles, liqL, computePH(b.moles, liqL, b.tempK), 2.0, b.phenBleachFrac || 0, b.phenIrrevFrac || 0);
    const tSpec = target ? APPARATUS[target.typeId] : null;
    const stopY = target && tSpec ? target.y - tSpec.height * 0.22 : SIM_BENCH_FLOOR_Y;
    if (this.visualHooks.onAlert) {
      this.visualHooks.onAlert('burette_drop', b, {
        tipX: b.x,
        tipY,
        stopY,
        catchX: target ? target.x : null,
        color: vis.css || 'rgba(186, 230, 253, 0.92)',
        actualMl,
      });
    }
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
      wb.manualSprayHold = false;
      this.emitChange();
      return false;
    }
    wb.isSpraying = next;
    wb.manualSprayHold = next;
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
    if (v.isInverted && !v.isStoppered) {
      const mouthY = v.y + spec.height / 2;
      // Pull working water column ONLY when the unstoppered inverted mouth sits submerged inside a wet water trough
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
    } else if (!v.isInverted) {
      v.submergedInTroughId = null;
      v.gravitySpillRateMlS = 0;
    }
    this.syncAttachedMouthTools();
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
    if (!dst || dst.kind !== 'vessel' || dst.isShattered) return false;
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

  swapDcPolarity(supplyId) {
    const s = this.getItem(supplyId);
    if (!s || s.kind !== 'dc_power') return;
    const prevPos = s.posElectrodeId;
    s.posElectrodeId = s.negElectrodeId;
    s.negElectrodeId = prevPos;
    // Update polarity labels on swapped electrodes immediately
    const newPos = this.getItem(s.posElectrodeId);
    const newNeg = this.getItem(s.negElectrodeId);
    if (newPos) newPos.polarityLabel = '+ Anode';
    if (newNeg) newNeg.polarityLabel = '- Cathode';
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
    el.platedAgMol = 0;
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

  connectElectrodeCollector(electrodeId, targetId = null) {
    const el = this.getItem(electrodeId);
    if (!el || el.kind !== 'electrode') return false;
    el.gasTargetId = targetId || null;
    this.emitChange();
    return true;
  }

  mountCollectorTubeOverElectrode(electrodeId) {
    const el = this.getItem(electrodeId);
    if (!el || el.kind !== 'electrode' || !el.dockedVesselId) return null;
    const parent = this.getItem(el.dockedVesselId);
    if (!parent || parent.isShattered) return null;
    const pSpec = APPARATUS[parent.typeId];
    const tSpec = APPARATUS.test_tube_50;
    const existing = this.items.find((i) => i.kind === 'vessel' && i.mountedOverElectrodeId === el.id && !i.isShattered);
    if (existing) {
      el.gasTargetId = existing.id;
      this.emitChange();
      return existing;
    }
    const tube = this.createApparatus(
      'test_tube_50',
      el.x,
      parent.y - pSpec.height / 2 - tSpec.height * 0.28
    );
    tube.isInverted = true;
    tube.mountedOverElectrodeId = el.id;
    tube.submergedInTroughId = parent.id;
    tube.fallStartY = null;
    // Fill inverted collecting tube with deionized water so evolving bubbles visibly displace water down
    tube.moles.H2O_l = (35 * 0.997) / CONSTANTS.M_H2O;
    el.gasTargetId = tube.id;
    syncDockedToolPositions(this);
    this.emitChange();
    return tube;
  }

  emitElectrolysisGas(v, gasId, mol, electrodeX = null, electrodeItem = null) {
    if (!v || mol <= 0) return;
    if (electrodeItem) {
      electrodeItem.recentGasMol = Math.min(2e-4, (electrodeItem.recentGasMol || 0) + mol);
    }
    const vSpec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
    const packet = { [gasId]: mol };

    // 1. Direct attached collector on the electrode (Gas Syringe or mounted/targeted inverted or stoppered vessel)
    if (electrodeItem?.gasTargetId) {
      const col = this.getItem(electrodeItem.gasTargetId);
      if (col && !col.isShattered && !col.isBroken) {
        const dtLive = Math.max(1e-3, this._lastStepDt || 0.05);
        const rateMlS =
          ((mol / dtLive) * CONSTANTS.R_L_BAR_MOL_K * Math.max(200, v.tempK || 298.15)) /
          Math.max(0.05, this.environment.pressureBar || 1.0) *
          1000;
        const fName = SPECIES[gasId]?.formula || gasId;
        const prevUpdated = electrodeItem._liveTubeFlow?.updatedAt || 0;
        const nowMs = Date.now();
        if (nowMs - prevUpdated > 120) {
          electrodeItem._liveTubeFlow = {
            composition: [{ formula: fName, pct: 100 }],
            rateMlS,
            totalMlS: rateMlS,
            tempC: (v.tempK || this.environment.tempK || 298.15) - 273.15,
            updatedAt: nowMs,
          };
        } else if (electrodeItem._liveTubeFlow) {
          electrodeItem._liveTubeFlow.rateMlS = electrodeItem._liveTubeFlow.rateMlS * 0.65 + rateMlS * 0.35;
          electrodeItem._liveTubeFlow.totalMlS = electrodeItem._liveTubeFlow.rateMlS;
          electrodeItem._liveTubeFlow.updatedAt = nowMs;
        }
        const routed = routeGasPacketToTarget(
          v,
          col,
          packet,
          0,
          this.environment,
          (id) => this.getItem(id),
          true
        );
        if (routed.handled) return;
      } else {
        electrodeItem.gasTargetId = null;
        electrodeItem._liveTubeFlow = null;
      }
    }

    // 2. Overhead inverted test tube / graduated cylinder held directly above that electrode
    if (!v.isStoppered && !v.isInverted) {
      const targetX = electrodeX ?? v.x;
      const vTop = v.y - vSpec.height / 2;
      const vBot = v.y + vSpec.height / 2;
      const candidates = this.items
        .filter((inv) => {
          if (inv.kind !== 'vessel' || !inv.isInverted || inv.isShattered || inv.isStoppered) return false;
          const iSpec = APPARATUS[inv.typeId];
          const iMouthY = inv.y + iSpec.height / 2;
          return Math.abs(inv.x - targetX) <= 36 && iMouthY >= vTop - 44 && iMouthY <= vBot + 16;
        })
        .sort((a, b) => Math.abs(a.x - targetX) - Math.abs(b.x - targetX));
      if (candidates.length > 0) {
        const routed = routeGasPacketToTarget(
          v,
          candidates[0],
          packet,
          0,
          this.environment,
          (id) => this.getItem(id),
          true
        );
        if (routed.handled) return;
      }
    }

    const anyStoppered = Boolean(v.isStoppered || (vSpec.hasTwoEnds && (v.leftStoppered || v.rightStoppered)));
    if (anyStoppered && (v.connectedTargetId || v.connectedSyringeId)) {
      stepVesselGasAndPressure(v, packet, 0, this.environment, (id) => this.getItem(id));
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
    if (((pip.moles?.OH_aq || 0) > 1e-7 || (pip.moles?.NH3_aq || 0) > 1e-7) && (dst.moles.Phenolphthalein_aq || 0) > 1e-8) {
      injectLocalPlume(dst, 'pink', 0.5 + (Math.random() - 0.5) * 0.14, 0.12, 0.95);
    } else if ((pip.moles?.Cu2_aq || 0) > 1e-6) {
      injectLocalPlume(dst, 'copper', 0.5 + (Math.random() - 0.5) * 0.14, 0.14, 0.65);
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
    const solPackedMl = solMl * 1.25;
    const totalMl = liqMl + solMl;
    const isSolidOver = liqMl <= 0.05 && solPackedMl > brimMl + 0.05;

    if ((totalMl <= brimMl + 0.05 || liqMl <= 0.05) && !isSolidOver) return;

    const excessMl = isSolidOver ? solPackedMl - brimMl : totalMl - brimMl;
    let visCss = 'rgba(203, 213, 225, 0.88)';
    if (liqMl > 0.05) {
      visCss = computeSolutionVisuals(
        vessel.moles,
        liqL,
        computePH(vessel.moles, liqL, vessel.tempK),
        spec.opticalPathCm,
        vessel.phenBleachFrac
      ).css;
    } else {
      const domSol = Object.entries(vessel.moles || {}).find(([k, n]) => n > 1e-8 && SPECIES[k]?.phase === 's');
      if (domSol) visCss = SPECIES[domSol[0]]?.color || visCss;
    }

    if (vessel.isStoppered) {
      vessel.overflowRateMlS = 0;
      const targetId = vessel.connectedTargetId || vessel.connectedSyringeId;
      const target = targetId ? this.getItem(targetId) : null;
      if (!target) {
        // Hard rubber stopper without tubing: hydraulic excess pops the stopper!
        this.popStopper(vessel, 'alertHydroOverflowPop', {
          hydraulic: true,
          liquidColor: visCss,
        });
        vessel.overflowRateMlS = 36 + excessMl * 4.2;
        vessel.overflowColor = visCss;
        vessel.spilledPuddleColor = visCss;
      }
      return;
    }

    vessel.overflowRateMlS = 36 + excessMl * 4.2;
    vessel.overflowColor = visCss;
    vessel.spilledPuddleColor = visCss;
    if (!vessel.wasOverflowing) {
      vessel.wasOverflowing = true;
      this.addLog({
        type: 'alert',
        key: 'alertOverflow',
        vesselLabel: `${spec.id} ${vessel.label}`,
      });
      if (this.visualHooks.onAlert) {
        this.visualHooks.onAlert('overflow', vessel, { liquidColor: visCss });
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

    // Case 1: Open vessel rim overflow waterfall (liquid OR excess bulk solid pile past brim)
    const solPackedMl = solMl * 1.25;
    if (liqMl <= 0.02 && solPackedMl > brimMl + 0.05) {
      const excessSolMl = solPackedMl - brimMl;
      const rateMlS = 36 + excessSolMl * 4.2;
      const drainMl = Math.min(solPackedMl, excessSolMl, rateMlS * dt);
      const fracSol = Math.min(1, drainMl / Math.max(1e-6, solPackedMl));
      let domSolCol = '#cbd5e1';
      let maxSolM = 0;
      for (const [spId, n] of Object.entries({ ...vessel.moles })) {
        const sp = SPECIES[spId];
        if (!sp || sp.phase !== 's' || n <= 0) continue;
        if (n > maxSolM) {
          maxSolM = n;
          domSolCol = sp.color || domSolCol;
        }
        const rem = n * (1 - fracSol);
        if (rem < 1e-12) delete vessel.moles[spId];
        else vessel.moles[spId] = rem;
      }
      vessel.overflowRateMlS = drainMl / Math.max(1e-4, dt);
      vessel.overflowColor = domSolCol;
      vessel.spilledPuddleColor = domSolCol;
      return;
    }

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
      ['O2_g', 'O2_g_total'],
      ['CO2_g', 'CO2_g_total'],
      ['HCl_g', 'HCl_g_total'],
      ['Cl2_g', 'Cl2_g_total'],
      ['NO2_g', 'NO2_g_total'],
      ['NO_g', 'NO_g_total'],
      ['N2O_g', 'N2O_g_total'],
      ['N2_g', 'N2_g_total'],
    ]) {
      const tot =
        (vessel.escapedGasMoles[gId] || 0) +
        (vessel.headspaceGasMoles[gId] || 0) +
        (syr?.gasMoles[gId] || 0);
      if (tot > 1e-7) snap[snapKey] = tot;
    }

    let solidMassG = 0;
    for (const [spId, n] of Object.entries(vessel.moles)) {
      if (n > 1e-9 && SPECIES[spId]?.phase === 's') {
        solidMassG += n * (SPECIES[spId].molarMass || 0);
      }
    }

    vessel.history.push({
      t: this.timeSec,
      moles: snap,
      tempK: vessel.tempK,
      ph,
      pressureBar: vessel.internalPressureBar ?? this.environment.pressureBar,
      liqL,
      rateMolS: vessel.lastTotalRateMolS || 0,
      cumGasMol: vessel.cumulativeGasMol || 0,
      solidMassG,
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
    vessel.leftStoppered = false;
    vessel.rightStoppered = false;
    vessel.leftHasPhenCotton = false;
    vessel.rightHasPhenCotton = false;
    vessel.phenCottonLeftLevel = 0;
    vessel.phenCottonRightLevel = 0;
    vessel.horizontalSpillRateMlS = 0;
    vessel.clampedToId = null;
    vessel.fallStartY = vessel.y;
    for (const it of this.items) {
      if ((it.kind === 'rubber_stopper' || it.kind === 'phen_cotton') && it.attachedToId === vessel.id) {
        it.attachedToId = null;
        it.attachedSide = null;
        it.fallStartY = it.y;
      }
    }
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
    if (item.kind === 'diffusion_tube') {
      item.leftGasId = null;
      item.rightGasId = null;
      item.leftFront = 0;
      item.rightFront = 1;
      item.ringPosFrac = null;
      item.ringGrowth = 0;
      item.nh4clMoles = 0;
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
        (item.kind === 'burette' ||
          item.kind === 'condenser' ||
          item.kind === 'salt_bridge' ||
          item.kind === 'filter_funnel' ||
          item.kind === 'diffusion_tube' ||
          item.kind === 'bath')
      ) {
        this.breakToolOnDrop(item);
      }
      return;
    }

    if (item.kind === 'vessel' && dropDistPx >= 18 && item.isSupersaturated) {
      item.crystallizeTriggered = true;
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
      if (item.isDragging || item.spoonAnim) {
        item.vy = 0;
        item.fallStartY = item.y;
        continue;
      }

      if (item.dockedVesselId || item.inVesselId || item.mountedOnVesselId || item.mountedOverElectrodeId) {
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
   * Determine active Alcohol Burner OR Bunsen Burner heating source for a vessel:
   * - Direct contact on tripod (`vessel.restingOnId`) delivers 100% wattage (and oxidizing cone focus on Bunsen)
   * - Clamped or held vessels positioned over a lit burner's flame plume receive geometric convective coupling
   */
  getBurnerHeatingSource(vessel) {
    if (!vessel || vessel.kind !== 'vessel' || vessel.isShattered) return null;
    const vSpec = APPARATUS[vessel.typeId];
    if (!vSpec?.heatable) return null;

    const getBurnerSpecParams = (b) => {
      const bSpec = APPARATUS[b.typeId] || APPARATUS.burner;
      const isBunsen = b.typeId === 'bunsen_burner';
      const fl = b.flameLevel || 0;
      const roundFl = Math.round(fl);
      const airOpen = b.airHoleOpen !== false;
      const powerTbl = isBunsen && !airOpen ? bSpec.yellowPowerLevelsW : bSpec.powerLevelsW;
      const flameTbl = isBunsen && !airOpen ? bSpec.yellowFlameK : bSpec.effectiveFlameK;
      const rawW = b.powerW ?? powerTbl[roundFl] ?? 0;
      const flameTempK = isBunsen ? (flameTbl[roundFl] || (airOpen ? 1623.15 : 1073.15)) : (flameTbl[roundFl] || null);
      return { bSpec, isBunsen, airOpen, fl, rawW, flameTempK };
    };

    if (vessel.restingOnId) {
      const sup = this.getItem(vessel.restingOnId);
      if (sup && sup.kind === 'burner') {
        const p = getBurnerSpecParams(sup);
        const focusedTempK =
          p.isBunsen && p.airOpen && p.flameTempK
            ? Math.min(1833.15, p.flameTempK + 60) // Integrated tripod gauze positions vessel at hottest oxidizing blue cone (~1560 °C)
            : p.flameTempK;
        return { burner: sup, flameLevel: p.fl, powerW: p.rawW, flameTempK: focusedTempK };
      }
    }

    // Check spatial proximity above any lit burner (supports Retort Stand clamped Quartz Tube / flasks)
    let best = null;
    const vBot = vessel.y + vSpec.height / 2;
    const horizMax = Math.max(46, 36 + vSpec.width * 0.25);
    for (const b of this.items) {
      if (b.kind !== 'burner') continue;
      const p = getBurnerSpecParams(b);
      if (p.rawW <= 0) continue;

      const dx = Math.abs(vessel.x - b.x);
      if (dx > horizMax) continue;

      const bnTop = b.y - p.bSpec.height / 2 + 10;
      const flameBaseY = b.y + p.bSpec.height / 2 - (p.isBunsen ? 66 : 46);
      if (vBot > flameBaseY + 18) continue;

      const horizFrac = dx <= 38 ? 1.0 : Math.max(0, 1 - (dx - 38) / Math.max(10, horizMax - 38));
      const powerFrac = Math.min(1, p.rawW / (p.bSpec.maxPowerW || 650));
      const maxPlumeAbove = (p.isBunsen ? 105 : 72) + 68 * powerFrac;

      let vertFrac = 0;
      if (vBot >= bnTop - 20) {
        vertFrac = 1.0;
      } else {
        const gapAbove = (bnTop - 20) - vBot;
        if (gapAbove < maxPlumeAbove) {
          vertFrac = Math.pow(1 - gapAbove / maxPlumeAbove, 1.35);
        }
      }

      const effW = p.rawW * horizFrac * vertFrac;
      if (effW > 1 && (!best || effW > best.powerW)) {
        best = {
          burner: b,
          flameLevel: p.fl * horizFrac * vertFrac,
          powerW: effW,
          flameTempK: p.flameTempK,
        };
      }
    }

    // Lit or glowing wooden splint acts as a gentle mini handheld heater
    for (const spl of this.items) {
      if (spl.kind !== 'splint' || (spl.mode !== 'burning' && spl.mode !== 'glowing')) continue;
      const tip = getProbeTipPos(spl);
      const dx = Math.abs(tip.x - vessel.x);
      if (dx > Math.max(24, vSpec.width * 0.44)) continue;
      if (tip.y < vessel.y - vSpec.height * 0.25 || tip.y > vBot + 36) continue;
      const prox = 1 - (dx / Math.max(26, vSpec.width * 0.46)) * 0.45;
      const splintW = (spl.mode === 'burning' ? 28 : 12) * prox;
      if (!best || splintW > best.powerW) {
        best = {
          burner: spl,
          flameLevel: spl.mode === 'burning' ? 0.4 : 0.2,
          powerW: splintW,
          flameTempK: spl.mode === 'burning' ? 953.15 : 793.15,
        };
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

  setOpticsMode(mode) {
    const valid = mode === 'aerodynamics' || mode === 'thermal' ? mode : 'normal';
    this.environment.opticsMode = valid;
    this.emitChange();
  }

  /**
   * Toggle global lab atmosphere between Standard Air (20.95% O2, 60% RH)
   * and Pure Dry Inert Glovebox (100% N2/Ar, 0% O2, 0% RH).
   */
  setAtmosphereMode(mode) {
    const nextMode = mode === 'inert' ? 'inert' : 'air';
    this.environment.atmosphereMode = nextMode;
    for (const v of this.items) {
      if (v.kind !== 'vessel') continue;
      if (nextMode === 'inert') {
        v.airO2PurgeFrac = 0;
        v.naohAirExposeSec = 0;
      } else if (!v.isStoppered) {
        v.airO2PurgeFrac = 1.0;
      }
    }
    this.emitChange();
  }

  /**
   * Pour liquid and loose solids downward under gravity whenever an open inverted vessel is held in air
   * (unstoppered and not submerged inside a pneumatic water trough).
   */
  stepInvertedGravitySpill(v, dt) {
    v.gravitySpillRateMlS = 0;
    v.gravitySpillColor = null;
    if (!v || v.kind !== 'vessel' || v.isShattered || !v.isInverted || v.isStoppered || (APPARATUS[v.typeId]?.hasLid && v.lidState === 'closed') || v.submergedInTroughId || v.mountedOverElectrodeId) {
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
    if (dpVac <= 0.025 || tLiqMl <= 0.05 || !isTubeTipSubmerged(v, target)) return;

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
      if (!v.isShattered) {
        const hadNH3Vacuum = (v.moles.NH3_aq || 0) > 1e-4 && (v.headspaceGasMoles?.NH3_g || 0) <= 1e-5;
        this.addLog(
          hadNH3Vacuum
            ? {
                type: 'reaction',
                equation: 'NH₃(g) + H₂O(l) ⇌ NH₃(aq) (P_bình ≪ P_kq ⇒ Phun trào chân không!)',
                nameVi: 'Thí nghiệm Phun nước Ammonia (Chân không áp suất khí quyển)',
                nameEn: 'Ammonia Vacuum Fountain (atmospheric pressure surge)',
                descVi: 'NH₃ hòa tan mãnh liệt vào nước (~700 L khí / 1 L nước) làm áp suất bình tụt sâu, hút mạnh nước chỉ thị phun trào thành tia.',
                descEn: 'Ultra-high Ammonia solubility collapses internal pressure, forcing indicator water violently up the fountain tube.',
                vesselLabel: `${target.label} ⟹ ${v.label}`,
              }
            : {
                type: 'alert',
                key: 'alertTubeSuckBack',
                vesselLabel: `${target.label} ⟹ ${v.label}`,
              }
        );
        if (this.visualHooks.onAlert) {
          this.visualHooks.onAlert('ammonia_fountain', v, { liquidColor: fountainVis.css });
        }
      }
    }
  }

  setBathMode(bathId, mode = 'ice') {
    const b = this.getItem(bathId);
    if (!b || b.kind !== 'bath') return false;
    const spec = APPARATUS[b.typeId] || APPARATUS.ice_bath;
    if (mode === 'ice_salt') {
      return this.setBathTargetTempC(bathId, -10);
    }
    if (mode === 'ice') {
      return this.setBathTargetTempC(bathId, 0);
    }
    b.bathMode = String(mode);
    b.bathTempK = b.bathMode === 'ice_salt' ? spec.bathTempSaltK || 263.15 : spec.bathTempIceK || 273.15;
    this.emitChange();
    return true;
  }

  setBathTargetTempC(bathId, tempC) {
    const b = this.getItem(bathId);
    if (!b || b.kind !== 'bath' || b.isBroken) return false;
    const spec = APPARATUS[b.typeId] || APPARATUS.ice_bath;
    const minC = spec.minTempC ?? -20;
    const maxC = spec.maxTempC ?? 200;
    const c = Math.max(minC, Math.min(maxC, Math.round(Number(tempC) || 0)));
    b.bathTargetC = c;
    b.bathTempK = c + CONSTANTS.KELVIN_OFFSET;
    b.bathMode =
      c <= -15
        ? 'cryo_20'
        : c <= -5
          ? 'ice_salt'
          : c <= 5
            ? 'ice'
            : c <= 25
              ? 'cool_water'
              : c <= 65
                ? 'warm_water'
                : c <= 105
                  ? 'hot_water'
                  : c <= 155
                    ? 'silicone_oil_mid'
                    : 'silicone_oil_high';
    this.emitChange();
    return true;
  }

  toggleCondenserReflux(condenserId, vesselId = null) {
    const cond = this.getItem(condenserId);
    if (!cond || cond.kind !== 'condenser' || cond.isBroken) return false;
    const nextMode = !cond.refluxMode;
    cond.refluxMode = nextMode;
    if (nextMode) {
      let host = vesselId ? this.getItem(vesselId) : null;
      if (!host && cond.connectedFromId) host = this.getItem(cond.connectedFromId);
      if (!host) {
        host = this.items.find(
          (i) => i.kind === 'vessel' && !i.isShattered && !i.isInverted && Math.abs(i.x - cond.x) <= 75
        );
      }
      if (host && host.kind === 'vessel' && !host.isShattered) {
        cond.refluxVesselId = host.id;
        cond.connectedFromId = host.id;
        host.connectedTargetId = cond.id;
        host.isStoppered = true;
        this.connectTube(host.id, cond.id);
      }
      syncDockedToolPositions(this);
    } else {
      cond.refluxVesselId = null;
      const cSpec = APPARATUS.liebig_condenser;
      cond.y = Math.min(SIM_BENCH_FLOOR_Y - getItemRotatedHalfExtentY(cSpec, cond), cond.y + 38);
    }
    this.emitChange();
    return true;
  }

  toggleSeparatoryValve(funnelId, open = null) {
    const f = this.getItem(funnelId);
    if (!f || f.kind !== 'separatory_funnel' || f.isBroken) return false;
    f.valveOpen = open === null ? !f.valveOpen : Boolean(open);
    this.emitChange();
    return f.valveOpen;
  }

  setSeparatoryValveFlow(funnelId, flowFrac = 0.35) {
    const f = this.getItem(funnelId);
    if (!f || f.kind !== 'separatory_funnel' || f.isBroken) return false;
    f.valveFlowFrac = Math.max(0.05, Math.min(1.0, Number(flowFrac) || 0.35));
    this.emitChange();
    return true;
  }

  toggleSeparatoryStopper(funnelId, stoppered = null) {
    const f = this.getItem(funnelId);
    if (!f || f.kind !== 'separatory_funnel' || f.isBroken) return false;
    f.isStoppered = stoppered === null ? !f.isStoppered : Boolean(stoppered);
    this.emitChange();
    return f.isStoppered;
  }

  shakeSeparatoryFunnel(funnelId) {
    const f = this.getItem(funnelId);
    if (!f || f.kind !== 'separatory_funnel' || f.isBroken) return false;
    const liqMl = computeLiquidVolumeL(f.moles, f.tempK) * 1000;
    if (liqMl <= 0.05) return false;
    f.emulsionTimer = 2.6;
    f.stirTimer = Math.max(f.stirTimer || 0, 2.6);
    stepVesselChemistry(f, 0.25, this.environment, { timeSec: this.timeSec });
    f.liquidStratification = computePhaseStratification(
      f.moles,
      f.tempK,
      APPARATUS.separatory_funnel,
      computeSolidVolumeMl(f.moles)
    );
    this.addLog({
      type: 'info',
      key: 'logSepFunnelShake',
      vesselLabel: f.label,
    });
    this.emitChange();
    return true;
  }

  mountSeparatoryFunnel(funnelId, vesselId = null) {
    const f = this.getItem(funnelId);
    if (!f || f.kind !== 'separatory_funnel' || f.isBroken) return false;
    if (!vesselId) {
      f.mountedOnVesselId = null;
      syncDockedToolPositions(this);
      this.emitChange();
      return true;
    }
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered || v.isInverted) return false;
    f.mountedOnVesselId = v.id;
    f.clampedToId = null;
    const vSpec = APPARATUS[v.typeId];
    if (vSpec?.stopperable && !vSpec.hasTwoEnds) {
      this.ensureAttachedStopper(v.id, 'main', 'dual_hole');
    }
    syncDockedToolPositions(this);
    this.recomputeScaleReadings();
    this.emitChange();
    return true;
  }

  setBunsenAirHole(burnerId, open) {
    const b = this.getItem(burnerId);
    if (!b || b.typeId !== 'bunsen_burner') return false;
    b.airHoleOpen = Boolean(open);
    const bSpec = APPARATUS.bunsen_burner;
    const fl = Math.round(b.flameLevel || 0);
    const tbl = b.airHoleOpen ? bSpec.powerLevelsW : bSpec.yellowPowerLevelsW;
    b.powerW = tbl[fl] || 0;
    this.emitChange();
    return true;
  }

  setVesselTiltDeg(vesselId, deg, dir = 1) {
    const v = this.getItem(vesselId);
    if (
      !v ||
      (v.kind !== 'vessel' && v.kind !== 'filter_funnel' && v.kind !== 'separatory_funnel' && v.kind !== 'spoon') ||
      v.isShattered ||
      v.isBroken
    ) {
      return false;
    }
    const rawDeg = Number(deg) || 0;
    const resolvedDir = rawDeg < 0 ? -1 : dir < 0 ? -1 : 1;
    const clamped = Math.max(0, Math.min(180, Math.abs(rawDeg)));
    v.tiltDeg = clamped;
    v.tiltDir = resolvedDir;
    v.tiltAngle = v.tiltDir * ((clamped * Math.PI) / 180);
    if (clamped <= 0.1) v.tiltPourRateMlS = 0;
    this.emitChange();
    return true;
  }

  setTubeSubmersionRatio(sourceId, ratio) {
    const it = this.getItem(sourceId);
    if (!it || (it.kind !== 'vessel' && it.kind !== 'condenser' && it.kind !== 'electrode')) return false;
    it.tubeSubmersionRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
    this.emitChange();
    return true;
  }

  setCondenserRotation(condenserId, deg) {
    const c = this.getItem(condenserId);
    if (!c || c.kind !== 'condenser') return false;
    c.rotationDeg = Math.max(-45, Math.min(45, Number(deg) || 0));
    this.emitChange();
    return true;
  }

  flipItemLR(itemId) {
    const it = this.getItem(itemId);
    if (!it) return false;
    const spec = APPARATUS[it.typeId];
    if (!spec?.flippable && !spec?.hasTwoEnds) return false;
    it.flippedX = !it.flippedX;
    if (it.kind === 'wash_bottle') {
      it.squirtArc = computeWashBottleStreamArc(it, this.items, SIM_BENCH_FLOOR_Y, CONSTANTS.GRAVITY_PX_S2 || 1800);
      it.sprayTargetId = it.squirtArc.hitTarget ? it.squirtArc.hitTarget.id : null;
    }
    this.updateSupportAttachments();
    this.emitChange();
    return true;
  }

  setWashBottleAngle(wbId, deg) {
    const wb = this.getItem(wbId);
    if (!wb || wb.kind !== 'wash_bottle') return false;
    wb.sprayAngleDeg = Math.max(-45, Math.min(45, Number(deg) || 0));
    this.emitChange();
    return true;
  }

  getBathCoolingSource(vessel) {
    if (!vessel || vessel.kind !== 'vessel' || vessel.isShattered) return null;
    if (vessel.restingOnId) {
      const sup = this.getItem(vessel.restingOnId);
      if (sup && sup.kind === 'bath' && !sup.isBroken) {
        const bSpec = APPARATUS[sup.typeId] || APPARATUS.ice_bath;
        const tBath = sup.bathTempK ?? (sup.bathMode === 'ice_salt' ? 263.15 : 273.15);
        return { bath: sup, tempK: tBath, coolingK: bSpec.coolingK || 0.56 };
      }
    }
    const vSpec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
    for (const sup of this.items) {
      if (sup.kind !== 'bath' || sup.isBroken) continue;
      if (Math.abs(vessel.x - sup.x) <= 56 && vessel.y + vSpec.height / 2 >= sup.y - 10 && vessel.y <= sup.y + 42) {
        const bSpec = APPARATUS[sup.typeId] || APPARATUS.ice_bath;
        const tBath = sup.bathTempK ?? (sup.bathMode === 'ice_salt' ? 263.15 : 273.15);
        return { bath: sup, tempK: tBath, coolingK: bSpec.coolingK || 0.56 };
      }
    }
    return null;
  }

  stepVesselTiltPouring(v, dt) {
    v.tiltPourRateMlS = 0;
    const spec = v ? APPARATUS[v.typeId] || APPARATUS.beaker_250 : null;
    if (
      !v ||
      (v.kind !== 'vessel' && v.kind !== 'filter_funnel' && v.kind !== 'separatory_funnel' && v.kind !== 'spoon') ||
      v.isShattered ||
      v.isBroken ||
      v.isStoppered ||
      (spec?.hasLid && v.lidState === 'closed') ||
      (v.tiltDeg || 0) <= 0.5
    ) {
      return;
    }
    const dir = v.tiltDir < 0 ? -1 : 1;
    const effTilt = dir * (((v.tiltDeg || 0) * Math.PI) / 180) + (v.landingTilt || 0);
    const { vertices } = getInnerPolygonPx(spec);
    const lipLocal = dir < 0 ? vertices[0] : vertices[vertices.length - 1];
    const cosL = Math.cos(effTilt);
    const sinL = Math.sin(effTilt);
    const spoutX = v.x + lipLocal.x * cosL - lipLocal.y * sinL;
    const spoutY = v.y + lipLocal.x * sinL + lipLocal.y * cosL;
    const pourX = spoutX;
    let dst = null;
    let bestScore = Infinity;
    for (const cand of this.items) {
      const cSpec = APPARATUS[cand.typeId] || APPARATUS.beaker_250;
      if (
        cand.id === v.id ||
        (cand.kind !== 'vessel' && cand.kind !== 'filter_funnel') ||
        cand.isShattered ||
        cand.isBroken ||
        cand.isStoppered ||
        (cSpec.hasLid && cand.lidState === 'closed') ||
        cand.isInverted
      ) {
        continue;
      }
      const dx = Math.abs(cand.x - pourX);
      if (dx <= Math.max(48, cSpec.width * 0.55) && cand.y >= v.y - 28) {
        const score = dx - (cand.kind === 'filter_funnel' ? 28 : 0);
        if (score < bestScore) {
          bestScore = score;
          dst = cand;
        }
      }
    }
    if (dst && dst.kind === 'vessel' && v.kind !== 'filter_funnel') {
      const mf = this.items.find(
        (f) => f.kind === 'filter_funnel' && !f.isBroken && (f.mountedOnVesselId === dst.id || f.restingOnId === dst.id)
      );
      if (mf && mf.id !== v.id) dst = mf;
    }
    const dstSpec = dst ? APPARATUS[dst.typeId] || APPARATUS.beaker_250 : null;

    let liqOutFrac = 0;
    let curLiqMlNow = 0;
    let liquidDensityPour = 1.0;
    let vHoldMl = 0;

    if (v.kind !== 'spoon') {
      vHoldMl = v.kind === 'filter_funnel' ? Math.max(0, 55 * Math.max(0, 1 - v.tiltDeg / 75)) : getVesselHoldVolumeMl(spec, v.tiltDeg);
      const curLiqL = computeLiquidVolumeL(v.moles, v.tempK);
      const curLiqMl = curLiqL * 1000;
      curLiqMlNow = curLiqMl;
      if (curLiqMl > 0.05) {
        liquidDensityPour = Math.max(0.65, Math.min(3.15, computeContentsMassG(v.moles) / Math.max(0.05, curLiqMl)));
      }
      if (curLiqMl > vHoldMl + 0.02) {
        const visc = computeLiquidViscosityFactor(v);
        const excessMl = curLiqMl - vHoldMl;
        const dMl = Math.min(excessMl, (Math.max(1.2, excessMl * 3.2) / Math.pow(visc, 0.42)) * dt);
        const frac = Math.min(1, dMl / curLiqMl);
        liqOutFrac = frac;
        const visColor = computeSolutionVisuals(
          v.moles,
          curLiqL,
          computePH(v.moles, curLiqL, v.tempK),
          spec.opticalPathCm || 4.0,
          v.phenBleachFrac || 0,
          v.phenIrrevFrac || 0
        ).css;
        if (dst) {
          if (v.kind === 'vessel' && (dst.kind === 'vessel' || dst.kind === 'filter_funnel')) {
            // Tilt pouring liquid only carries dissolved ions/liquids here; solids follow hydrodynamic + gravity solid step below
            for (const [spId, n] of Object.entries({ ...v.moles })) {
              const sp = SPECIES[spId];
              if (!sp) continue;
              if (sp.phase === 'l' || sp.phase === 'aq' || isSolidMoltenAtTemp(sp, v.tempK, v.moles)) {
                const mv = n * frac;
                const rem = n - mv;
                if (rem < 1e-12) delete v.moles[spId];
                else v.moles[spId] = rem;
                dst.moles[spId] = (dst.moles[spId] || 0) + mv;
              }
            }
            if (dst.kind === 'vessel') {
              applySurfaceImpulse(dst, 0.5 + (Math.random() - 0.5) * 0.14, -Math.min(0.85, 0.15 + (dMl / Math.max(1e-3, dt)) * 0.01));
            }
          } else {
            for (const [spId, n] of Object.entries({ ...v.moles })) {
              const sp = SPECIES[spId];
              if (!sp || (sp.phase !== 'l' && sp.phase !== 'aq')) continue;
              const mv = n * frac;
              const rem = n - mv;
              if (rem < 1e-12) delete v.moles[spId];
              else v.moles[spId] = rem;
              dst.moles[spId] = (dst.moles[spId] || 0) + mv;
            }
          }
          this.activePourStream = {
            fromX: spoutX,
            fromY: spoutY,
            toX: dst.x,
            toY: dst.y - (dstSpec?.height || 90) * 0.25,
            color: visColor || 'rgba(186, 230, 253, 0.85)',
            rateMlS: dMl / Math.max(1e-4, dt),
            timer: 0.14,
            pouredMl: 0,
          };
        } else {
          for (const [spId, n] of Object.entries({ ...v.moles })) {
            const sp = SPECIES[spId];
            if (sp && (sp.phase === 'l' || sp.phase === 'aq')) {
              const rem = n * (1 - frac);
              if (rem < 1e-12) delete v.moles[spId];
              else v.moles[spId] = rem;
            }
          }
          v.spilledPuddleColor = visColor;
        }
        v.tiltPourRateMlS = dMl / Math.max(1e-4, dt);
        const nowMs = Date.now();
        if (nowMs - (v._lastTiltDropMs || 0) >= 48) {
          v._lastTiltDropMs = nowMs;
          this.visualHooks.onAlert?.('tilt_spill', v, {
            fromX: spoutX,
            fromY: spoutY,
            lipDir: dir,
            tiltDeg: v.tiltDeg || 0,
            excessMl,
            viscosity: visc,
            toY: dst ? dst.y - (dstSpec?.height || 90) * 0.25 : SIM_BENCH_FLOOR_Y,
            catchX: dst ? dst.x : null,
            liquidColor: visColor || 'rgba(186, 230, 253, 0.88)',
            rateMlS: v.tiltPourRateMlS,
          });
        }
      }
    }

    // Realistic solid & mixture pouring: depends on vessel geometry/neck, fill height vs tilted hold volume, tilt angle, buoyancy & suspension
    const solidEntries = Object.entries(v.moles || {}).filter(([spId, n]) => n > 1e-8 && SPECIES[spId]?.phase === 's');
    if (solidEntries.length > 0 && (v.tiltDeg || 0) > 12) {
      const curSolidMl = computeSolidVolumeMl(v.moles);
      const totalContentsMl = curLiqMlNow + curSolidMl;
      let movedAnySolid = false;
      let domColor = '#e2e8f0';
      let bestN = 0;
      for (const [spId, n] of solidEntries) {
        const sp = SPECIES[spId];
        if (!sp || isSolidMoltenAtTemp(sp, v.tempK, v.moles)) continue;
        const susp = computeSolidSuspensionFactor(v, spId, sp);
        const pInfo = calcSolidPourDischargeRate({
          spec,
          kind: v.kind,
          spId,
          sp,
          tiltDeg: v.tiltDeg || 0,
          liquidFlowFrac: liqOutFrac,
          liquidDensity: liquidDensityPour,
          hasLiquid: curLiqMlNow > 0.05,
          suspensionFactor: susp,
          isPowder: Boolean(v.groundPowderMap?.[spId] || sp.isPrecipitate),
          holdVolumeMl: v.kind !== 'spoon' ? vHoldMl : null,
          totalContentsMl: v.kind !== 'spoon' ? totalContentsMl : null,
        });
        const dumpFrac = Math.min(1, pInfo.entrainedStep + pInfo.ratePerSec * dt);
        if (dumpFrac <= 1e-6) continue;
        movedAnySolid = true;
        if (n > bestN) {
          bestN = n;
          domColor = sp.color || '#e2e8f0';
        }
        const mv = n * dumpFrac;
        if (n - mv < 1e-9) {
          delete v.moles[spId];
          if (v.particleCounts) delete v.particleCounts[spId];
        } else {
          v.moles[spId] = n - mv;
        }
        if (dst && dst.kind !== 'burette') {
          dst.moles[spId] = (dst.moles[spId] || 0) + mv;
          dst.particleCounts = dst.particleCounts || {};
          dst.particleCounts[spId] = (dst.particleCounts[spId] || 0) + Math.max(1, Math.round(mv * 1200));
          if (sp.isPrecipitate) {
            dst.precipitateSettle = dst.precipitateSettle || {};
            dst.precipitateSettle[spId] = 0.05;
          }
        }
      }
      if (movedAnySolid) {
        const nowMs = Date.now();
        if (nowMs - (v._lastTiltSolidMs || 0) >= 80) {
          v._lastTiltSolidMs = nowMs;
          this.visualHooks.onAlert?.('tilt_solid_spill', v, {
            fromX: v.kind === 'spoon' ? getProbeTipPos(v).x : spoutX,
            fromY: v.kind === 'spoon' ? getProbeTipPos(v).y : spoutY,
            toY: dst ? dst.y - (dstSpec?.height || 90) * 0.2 : SIM_BENCH_FLOOR_Y,
            catchX: dst ? dst.x : null,
            color: domColor,
          });
        }
      }
    }

    // Gas pouring at tilt >= 15 deg: dense gases (CO2/Cl2) cascade downward onto lit splints; light H2 pours upward onto flames
    if (v.tiltDeg >= 15) {
      const head = v.headspaceGasMoles || {};
      const denseGas = (head.CO2_g || 0) + (head.Cl2_g || 0);
      if (denseGas > 1e-5) {
        const dBleed = Math.min(denseGas, Math.max(5e-5, denseGas * 1.8 * dt));
        if (head.CO2_g > 0) head.CO2_g = Math.max(0, head.CO2_g - dBleed * (head.CO2_g / denseGas));
        if (head.Cl2_g > 0) head.Cl2_g = Math.max(0, head.Cl2_g - dBleed * (head.Cl2_g / denseGas));
        for (const spl of this.items) {
          if (spl.kind !== 'splint' || (spl.mode !== 'burning' && spl.mode !== 'glowing')) continue;
          const tip = getProbeTipPos(spl);
          if (Math.abs(tip.x - pourX) <= 72 && tip.y >= v.y - 24 && tip.y <= v.y + 195) {
            spl.mode = 'unlit';
            spl.cooldownTimer = 0.4;
            this.visualHooks.onAlert?.('co2_extinguish', spl, {});
            if (this.timeSec - (spl._seenCo2Ext ?? -99) > 3.5) {
              spl._seenCo2Ext = this.timeSec;
              this.addLog({ type: 'alert', key: 'alertGasExtinguishedSplint', vesselLabel: `${v.label} → ${spl.label}` });
            }
          }
        }
      }
    }
  }

  stepGasFlameInteractions(v, rateMap, dt) {
    if (!v || v.kind !== 'vessel' || v.isShattered || v.isStoppered) return;
    const h2Flow = (rateMap?.H2_g || 0) + ((v.tiltDeg || 0) >= 12 ? (v.headspaceGasMoles?.H2_g || 0) * 1.5 : 0);
    if (h2Flow <= 2.5e-5) return;
    if (this.timeSec - (v._seenH2Flash ?? -99) < 3.5) return;

    const vSpec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
    const rad = ((v.tiltDeg || 0) * Math.PI) / 180;
    const dir = v.tiltDir < 0 ? -1 : 1;
    const spoutX = v.x + dir * Math.sin(rad) * (vSpec.height * 0.48 + 8);
    const spoutY = v.y - Math.cos(rad) * (vSpec.height * 0.48);
    for (const flm of this.items) {
      const isLitBurner = flm.kind === 'burner' && (flm.powerW || 0) > 0;
      const isLitSplint = flm.kind === 'splint' && (flm.mode === 'burning' || flm.mode === 'glowing');
      if (!isLitBurner && !isLitSplint) continue;
      const fx = isLitSplint ? getProbeTipPos(flm).x : flm.x;
      const fy = isLitSplint ? getProbeTipPos(flm).y : flm.y - 26;
      const distTop = Math.hypot(v.x - fx, (v.y - vSpec.height / 2) - fy);
      const distSpout = Math.hypot(spoutX - fx, spoutY - fy);
      const dist = Math.min(distTop, distSpout);
      if (dist <= 135 && v.restingOnId !== flm.id) {
        v._seenH2Flash = this.timeSec;
        if (v.headspaceGasMoles?.H2_g) v.headspaceGasMoles.H2_g *= 0.2;
        this.visualHooks.onAlert?.('oxyhydrogen_detonation', { x: (spoutX + fx) * 0.5, y: (spoutY + fy) * 0.5 }, { blastScale: 0.75 });
        this.addLog({ type: 'alert', key: 'alertGasFlashIgnition', vesselLabel: v.label });
        break;
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
    this._lastStepDt = scaledDt;
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

    // Advance rigid-body workbench gravity & landing impact physics, keeping mouth stoppers/cotton synced to wobble
    this.stepGravityPhysics(scaledDt, realDeltaSec);
    this.syncAttachedMouthTools();

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

      // Clear expired live gas tubing hover telemetry
      if (v._liveTubeFlow && (!v.connectedTargetId || Date.now() - v._liveTubeFlow.updatedAt > 350)) {
        v._liveTubeFlow = null;
      }

      // 2D cross-section wheel-tilt pouring & invisible gas cascading onto flames
      this.stepVesselTiltPouring(v, scaledDt);

      // Check burner power & flame level (resting directly on burner / clay triangle OR clamped/held over flame plume)
      const heatSrc = this.getBurnerHeatingSource(v);
      const bathSrc = this.getBathCoolingSource(v);
      v.submergedInBathId = bathSrc?.bath?.id || null;
      v._recentHotTempK = Math.max(v.tempK, (v._recentHotTempK || v.tempK) - (v._recentHotTempK > v.tempK ? 10 * scaledDt : 0));
      if (
        bathSrc &&
        bathSrc.tempK <= 278.15 &&
        v._recentHotTempK >= 623.15 &&
        !APPARATUS[v.typeId]?.materialSpec?.includes('Quartz') &&
        !APPARATUS[v.typeId]?.isPorcelain &&
        APPARATUS[v.typeId]?.shape !== 'crucible'
      ) {
        this.shatterVessel(v, 'alertThermalShock', 'thermal_shock');
        continue;
      }
      if ((v._lastExothermicTimer || 0) > 0) {
        v._lastExothermicTimer = Math.max(0, v._lastExothermicTimer - scaledDt);
        if (v._lastExothermicTimer === 0) v.lastExothermicJ = 0;
      }
      const burnerPowerW = heatSrc?.powerW || 0;
      const burnerFlameLevel = heatSrc?.flameLevel || 0;
      const burnerFlameTempK = heatSrc?.flameTempK || null;
      v._bunsenHeated = Boolean(heatSrc?.burner?.typeId === 'bunsen_burner' && burnerPowerW > 0);
      if (v._bunsenHeated && heatSrc.burner.airHoleOpen === false) {
        v.sootLevel = Math.min(1.0, (v.sootLevel || 0) + 0.095 * scaledDt);
      } else if (
        v._bunsenHeated &&
        heatSrc.burner.airHoleOpen !== false &&
        (v.tempK >= 430 || (heatSrc.flameTempK || 0) >= 1100) &&
        (v.sootLevel || 0) > 0
      ) {
        v.sootLevel = Math.max(0, (v.sootLevel || 0) - 0.16 * scaledDt);
      }

      const frameGas = createZeroGasMap();
      let frameSteam = 0;
      let frameFreezeMeltMol = 0;
      let lastFreezePointK = v.freezePointK ?? CONSTANTS.T_FREEZE_WATER_K;
      let frameBoiling = false;
      let frameSteamOpacity = 0;
      let frameNaEvent = null;
      let frameKEvent = null;
      let frameRxnHeatJ = 0;
      const tempBeforeStepK = v.tempK;
      const phBeforeStep = computePH(v.moles, computeLiquidVolumeL(v.moles, v.tempK), v.tempK);
      const pBeforeStepBar = v.internalPressureBar ?? this.environment.pressureBar;
      const frameActiveMap = new Map();

      // Safety Check: Heating unpurged H2 + O2 mixture inside vessel over open flame triggers oxyhydrogen pop
      if (
        this.environment.atmosphereMode === 'air' &&
        burnerPowerW > 0 &&
        v.tempK >= 425 &&
        (v.headspaceGasMoles?.H2_g || 0) > 2.5e-5 &&
        ((v.airO2PurgeFrac ?? 1.0) > 0.14 || (v.headspaceGasMoles?.O2_g || 0) > 2.5e-5) &&
        (this.timeSec - (v.seenReactions.unpurged_h2_pop ?? -99)) > 4.0
      ) {
        v.seenReactions.unpurged_h2_pop = this.timeSec;
        v.headspaceGasMoles.H2_g *= 0.15;
        v.airO2PurgeFrac = 0.06;
        v.tempK = Math.min(720, v.tempK + 35);
        this.addLog({
          type: 'alert',
          key: 'alertUnpurgedH2O2',
          vesselLabel: v.label,
        });
        if (this.visualHooks.onAlert) {
          this.visualHooks.onAlert('unpurged_h2', v, { liquidColor: '#f59e0b' });
        }
      }

      // Data-driven flammable volatile solvent auto-ignition check prior to latent boiling clamp
      if (!v.isStoppered && !v.isFrozenSolid) {
        for (const [spId, n] of Object.entries(v.moles)) {
          const sp = SPECIES[spId];
          if (!sp || sp.phase !== 'l' || !sp.autoIgnitionTempK || n <= 1e-4) continue;
          if (v.tempK >= sp.autoIgnitionTempK) {
            const nBurn = Math.min(n, Math.max(0.001, n * 0.14 * Math.min(1, scaledDt * 4)));
            v.moles[spId] = n - nBurn;
            if (v.moles[spId] < 1e-12) delete v.moles[spId];
            v.escapedGasMoles.H2O_g = (v.escapedGasMoles.H2O_g || 0) + (sp.combustionH2O || 3) * nBurn;
            v.escapedGasMoles.CO2_g = (v.escapedGasMoles.CO2_g || 0) + (sp.combustionCO2 || 2) * nBurn;
            const ignHeatJ = Math.min(9000, nBurn * (sp.combustionHeatJ || 1367000) * 0.18);
            const cNow = Math.max(25, computeHeatCapacityJK(v));
            v.tempK = Math.min(1350, v.tempK + ignHeatJ / cNow);
            if ((this.timeSec - (v.seenReactions.solvent_ignition ?? -99)) > 4.5) {
              v.seenReactions.solvent_ignition = this.timeSec;
              this.addLog({
                type: 'alert',
                key: 'alertSolventIgnition',
                vesselLabel: v.label,
              });
              if (this.visualHooks.onAlert) {
                this.visualHooks.onAlert('solvent_ignition', v, { liquidColor: '#f97316' });
              }
            }
            break;
          }
        }
      }

      for (let s = 0; s < numSteps; s++) {
        const chemRes = stepVesselChemistry(v, dt, {
          uvLight: this.environment.uvLight,
          environment: this.environment,
          heatSrc,
        });
        frameRxnHeatJ += Number.isFinite(chemRes.reactionHeatJ) ? chemRes.reactionHeatJ : 0;
        const thermRes = stepVesselThermodynamics(
          v,
          dt,
          this.environment,
          chemRes.reactionHeatJ,
          burnerPowerW,
          burnerFlameLevel,
          burnerFlameTempK,
          bathSrc
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
        combinedGas.HNO3_g += thermRes.hno3ProducedMol || 0;
        combinedGas.NH3_g += thermRes.nh3ProducedMol || 0;
        combinedGas.C2H5OH_g += thermRes.ethanolProducedMol || 0;
        combinedGas.Br2_g += thermRes.br2ProducedMol || 0;
        combinedGas.I2_g += thermRes.i2ProducedMol || 0;
        combinedGas.S_g += thermRes.sProducedMol || 0;
        if (thermRes.metalVaporsProduced) {
          for (const [mG, mVal] of Object.entries(thermRes.metalVaporsProduced)) {
            if (mVal > 0) combinedGas[mG] = (combinedGas[mG] || 0) + mVal;
          }
        }
        if (thermRes.extraVaporsProduced) {
          for (const [vG, vVal] of Object.entries(thermRes.extraVaporsProduced)) {
            if (vVal > 0) combinedGas[vG] = (combinedGas[vG] || 0) + vVal;
          }
        }

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
        if (v._mn2o7HazardPending) {
          v._mn2o7HazardPending = false;
          if ((this.timeSec - (v.seenReactions.mn2o7_hazard ?? -99)) > 4.5) {
            v.seenReactions.mn2o7_hazard = this.timeSec;
            this.addLog({
              type: 'alert',
              key: 'alertMn2O7Hazard',
              vesselLabel: v.label,
            });
            if (this.visualHooks.onAlert) {
              this.visualHooks.onAlert('oxyhydrogen_detonation', { x: v.x, y: v.y }, { blastScale: 0.65 });
            }
          }
        }
        if (chemRes.naEvent === 'explosion' || (chemRes.naEvent === 'ignition_flame' && frameNaEvent !== 'explosion') || (!frameNaEvent && chemRes.naEvent)) {
          frameNaEvent = chemRes.naEvent;
        }
        if (chemRes.kEvent === 'explosion' || (chemRes.kEvent === 'ignition_flame' && frameKEvent !== 'explosion') || (!frameKEvent && chemRes.kEvent)) {
          frameKEvent = chemRes.kEvent;
        }

        v._reactionExtentMap = v._reactionExtentMap || {};
        if (!v._rxnHoldMap || typeof v._rxnHoldMap.entries === 'function') v._rxnHoldMap = {};
        for (const rxn of chemRes.activeReactions) {
          v._reactionExtentMap[rxn.id] = (v._reactionExtentMap[rxn.id] || 0) + (rxn.dXi || 0);
          const prev = frameActiveMap.get(rxn.id);
          if (!prev) {
            frameActiveMap.set(rxn.id, { ...rxn });
          } else {
            prev.dXi += rxn.dXi;
            prev.rateMolS = rxn.rateMolS;
          }

          // Smooth anti-flicker display buffer + anti-spam 14s cyclical log gate
          const prevHold = v._rxnHoldMap[rxn.id];
          const smoothRate = prevHold ? prevHold.emaRateMolS * 0.68 + (rxn.rateMolS || 0) * 0.32 : (rxn.rateMolS || 0);
          v._rxnHoldMap[rxn.id] = {
            rxn: { ...rxn, rateMolS: smoothRate },
            emaRateMolS: smoothRate,
            lastActiveTime: this.timeSec,
            firstSeenTime: prevHold ? prevHold.firstSeenTime : this.timeSec,
          };

          const lastSeen = v.seenReactions[rxn.id] ?? -99;
          if (this.timeSec - lastSeen > 14.0) {
            const curLiqL = computeLiquidVolumeL(v.moles, v.tempK);
            const curPh = computePH(v.moles, curLiqL, v.tempK);
            const curPBar = v.internalPressureBar ?? this.environment.pressureBar;
            const dH_kJ = rxn.dH !== undefined ? (rxn.dH * Math.max(1e-5, rxn.dXi || 0.001)) / 1000 : -frameRxnHeatJ / 1000;
            this.addLog({
              type: 'reaction',
              rxnId: rxn.id,
              equation: rxn.equation,
              ionicEq: rxn.ionicEquation || '',
              nameVi: rxn.nameVi,
              nameEn: rxn.nameEn,
              descVi: rxn.descVi,
              descEn: rxn.descEn,
              vesselLabel: v.label,
              rateMolS: rxn.rateMolS || 0,
              dXi: rxn.dXi || 0,
              dH_kJ,
              phNow: curPh,
              phDelta: phBeforeStep !== null && curPh !== null ? curPh - phBeforeStep : null,
              pBar: curPBar,
              deltaPBar: curPBar - pBeforeStepBar,
              tempC: v.tempK - 273.15,
            });
          }
          v.seenReactions[rxn.id] = this.timeSec;
        }

        for (const ev of gasEvents) {
          if (ev.type === 'stopper_pop') {
            this.popStopper(v, ev.implosion ? 'alertOverpressurePop' : 'alertOverpressurePop');
          } else if (ev.type === 'crucible_lid_pop') {
            this.playFx?.('pop');
            this.addLog({
              type: 'alert',
              key: 'alertCrucibleLidPop',
              vesselLabel: v.label,
            });
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

      // Glassware Surface Memory: Tollens Silver Mirror, stubborn CuO/BaSO4 crusts, HNO3 silver stripping & 2D liquid plume diffusion
      const formedSilverMirror =
        frameActiveMap.has('tollens_h2o2_alk') ||
        frameActiveMap.has('tollens_h2o2_neut') ||
        ((v.moles.Ag_s || 0) > 1e-4 && ((v.moles.NH3_aq || 0) > 1e-3 || frameActiveMap.has('cu_agno3') || frameActiveMap.has('zn_agno3')));
      if (formedSilverMirror && (v.silverMirrorLevel || 0) < 1.0) {
        const prevMir = v.silverMirrorLevel || 0;
        v.silverMirrorLevel = Math.min(1.0, prevMir + 0.14 * scaledDt);
        if (prevMir < 0.08 && v.silverMirrorLevel >= 0.08 && !v.seenReactions._silverMirrorLogged) {
          v.seenReactions._silverMirrorLogged = true;
          this.addLog({ type: 'info', key: 'alertSilverMirrorFormed', vesselLabel: v.label });
        }
      }
      const hasAcidNitrate = (v.moles.HNO3_l || 0) > 1e-4 || ((v.moles.H_aq || 0) > 1e-4 && (v.moles.NO3_aq || 0) > 1e-4);
      if ((v.silverMirrorLevel || 0) > 0.005 && hasAcidNitrate) {
        const dMirror = Math.min(v.silverMirrorLevel, 0.35 * scaledDt);
        v.silverMirrorLevel = Math.max(0, v.silverMirrorLevel - dMirror);
        if (v.moles.HNO3_l > 0) v.moles.HNO3_l = Math.max(0, v.moles.HNO3_l - dMirror * 0.004);
        else {
          v.moles.H_aq = Math.max(0, (v.moles.H_aq || 0) - dMirror * 0.004);
          v.moles.NO3_aq = Math.max(0, (v.moles.NO3_aq || 0) - dMirror * 0.002);
        }
        v.moles.Ag_aq = (v.moles.Ag_aq || 0) + dMirror * 0.002;
        if (v.silverMirrorLevel <= 0.005) {
          v.silverMirrorLevel = 0;
          this.addLog({ type: 'info', key: 'alertSilverMirrorCleaned', vesselLabel: v.label });
        }
      }
      v.wallResidueMap = v.wallResidueMap || {};
      if ((v.moles.CuO_s || 0) > 5e-4) v.wallResidueMap.CuO_s = Math.min(1, (v.wallResidueMap.CuO_s || 0) + 0.08 * scaledDt);
      if ((v.moles.BaSO4_s || 0) > 5e-4) v.wallResidueMap.BaSO4_s = Math.min(1, (v.wallResidueMap.BaSO4_s || 0) + 0.08 * scaledDt);

      if ((v.moles.CuSO4_5H2O_s || 0) > 1e-5 && (v.moles.H2O_l || 0) > 1e-3 && Math.random() < 0.35) {
        injectLocalPlume(v, 'copper', 0.5 + (Math.random() - 0.5) * 0.16, 0.88, 0.38);
      }
      stepLiquidConcField(v, scaledDt);
      {
        const dtSafe = Math.max(1e-3, scaledDt);
        const vxNow = (v.x - (v._lastSimX ?? v.x)) / dtSafe;
        const hAccel = (vxNow - (v._lastSimVx ?? vxNow)) / dtSafe;
        const angVel = ((v.tiltAngle || 0) - (v._lastSimTilt ?? (v.tiltAngle || 0))) / dtSafe;
        v._lastSimX = v.x;
        v._lastSimVx = vxNow;
        v._lastSimTilt = v.tiltAngle || 0;
        const curLiqLPhys = computeLiquidVolumeL(v.moles, v.tempK);
        if (curLiqLPhys > 2e-4 && !v.isFrozenSolid) {
          if (v.wasBoiling || (v.gasOutTotalRate || 0) > 5e-4) {
            applySurfaceImpulse(v, 0.2 + Math.random() * 0.6, (Math.random() - 0.5) * 0.22);
          }
          stepVesselSurfaceWaves(v, scaledDt, hAccel, angVel);
        }
        const spSpec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
        const maxVolMl = spSpec.maxVolumeMl || 250;
        const curLiqMl = curLiqLPhys * 1000;
        const surfFrac = Math.max(0, Math.min(0.96, curLiqMl / maxVolMl));
        const liqDens = (v.moles.H2SO4_l || 0) > 0.05 ? 1.84 : (v.moles.Br2_l || 0) > 0.01 ? 3.1 : 1.0 + Math.min(0.45, ((v.moles.Na_aq || 0) + (v.moles.Cl_aq || 0)) * 0.04);
        stepVesselSolidBodies(v, curLiqLPhys > 2e-4, surfFrac, liqDens, scaledDt);
      }
      for (const r of frameActiveMap.values()) {
        if ((r.dH || 0) < -5000 || (r.nameEn || '').toLowerCase().includes('neutral') || (r.nameEn || '').toLowerCase().includes('sodium')) {
          v._lastExothermicTimer = 1.4;
          v.lastExothermicJ = Math.max(v.lastExothermicJ || 0, Math.abs(r.dH || 0) * Math.max(1e-4, r.dXi || 0.001));
        }
      }

      // Post-step finite mathematical stabilizer across all conserved vessel state fields
      v.tempK = Number.isFinite(v.tempK) ? Math.max(155, Math.min(1950, v.tempK)) : CONSTANTS.T_STD_K;
      v.internalPressureBar = Number.isFinite(v.internalPressureBar)
        ? Math.max(0.02, Math.min(35.0, v.internalPressureBar))
        : this.environment.pressureBar;
      v.pickeringFoamMl = Number.isFinite(v.pickeringFoamMl || 0) ? Math.max(0, v.pickeringFoamMl || 0) : 0;
      for (const [spId, val] of Object.entries(v.moles)) {
        if (!Number.isFinite(val) || val < 0) delete v.moles[spId];
      }
      for (const mapKey of ['headspaceGasMoles', 'escapedGasMoles']) {
        if (!v[mapKey]) continue;
        for (const [gId, val] of Object.entries(v[mapKey])) {
          if (!Number.isFinite(val) || val < 0) v[mapKey][gId] = 0;
        }
      }

      // Borosilicate 3.3 softening -> red-orange glow -> bottom sag -> melt-through under Bunsen (>= 820 °C) vs brittle thermal stress limit
      const specV = APPARATUS[v.typeId] || APPARATUS.beaker_250;
      const isBorosilicate = specV.materialSpec === 'Borosilicate 3.3';
      if (isBorosilicate && (v._bunsenHeated || (v.softenSagFrac || 0) > 0.02)) {
        v.softenGlowFrac = Math.max(0, Math.min(1, (v.tempK - 840) / 280));
        const sagStartK = CONSTANTS.BOROSILICATE_SOFTEN_K - 40; // Begins subtle viscous softening at ~780 C
        if (v.tempK >= sagStartK) {
          const sagRate = 0.45 + Math.min(1.4, (v.tempK - sagStartK) / 95);
          v.softenSagFrac = Math.min(1.0, (v.softenSagFrac || 0) + sagRate * scaledDt);
        } else {
          v.softenSagFrac = Math.max(0, (v.softenSagFrac || 0) - 0.15 * scaledDt);
        }
        if ((v.softenSagFrac || 0) >= 0.96 || (v.tempK >= CONSTANTS.BOROSILICATE_MELT_FAIL_K && (v.softenSagFrac || 0) >= 0.45)) {
          v.isMoltenMelted = true;
          this.shatterVessel(v, 'alertGlassSoftenMelt', 'shatter');
          continue;
        }
      } else {
        v.softenGlowFrac = Math.max(0, Math.min(0.45, (v.tempK - 760) / 420));
        if (specV.breakable !== false && v.tempK >= (specV.maxThermalStressK || 783)) {
          this.shatterVessel(v, 'alertThermalShock', 'thermal_shock');
          continue;
        }
      }

      // Open horizontal quartz tube loses liquids out open end(s) immediately by gravity (solids stay inside!)
      const inTubeSideH = v.connectedFromId ? v.incomingPortSide || (v.flippedX ? 'right' : 'left') : null;
      const outTubeSideH = v.connectedTargetId || v.connectedSyringeId ? v.connectedPortSide || (v.flippedX ? 'left' : 'right') : null;
      const leftOpenH = !v.leftStoppered && inTubeSideH !== 'left' && outTubeSideH !== 'left';
      const rightOpenH = !v.rightStoppered && inTubeSideH !== 'right' && outTubeSideH !== 'right';
      if (specV.isHorizontalTube && (leftOpenH || rightOpenH)) {
        const drainL = computeLiquidVolumeL(v.moles, v.tempK);
        const drainMl = drainL * 1000;
        if (drainMl > 0.05) {
          const drainFrac = Math.min(1, scaledDt * 6.5);
          const visD = computeSolutionVisuals(
            v.moles,
            drainL,
            computePH(v.moles, drainL, v.tempK),
            specV.opticalPathCm,
            v.phenBleachFrac,
            v.phenIrrevFrac || 0
          );
          const leftOpen = leftOpenH;
          const rightOpen = rightOpenH;
          const drainedMoles = {};
          for (const [spId, n] of Object.entries(v.moles)) {
            const sp = SPECIES[spId];
            if (n > 1e-12 && (spId === 'H2O_l' || spId === 'C2H5OH_l' || spId === 'CH3COOH_l' || sp?.phase === 'aq' || sp?.phase === 'l')) {
              const dM = drainFrac >= 0.999 ? n : n * drainFrac;
              drainedMoles[spId] = dM;
              v.moles[spId] = n - dM;
              if (v.moles[spId] < 1e-12) delete v.moles[spId];
            }
          }
          const ends = getVesselEndPorts(v);
          const catchV = this.items.find(
            (o) =>
              o.id !== v.id &&
              o.kind === 'vessel' &&
              !o.isShattered &&
              !o.isStoppered &&
              !o.isInverted &&
              o.y > v.y &&
              ((leftOpen && Math.abs(o.x - ends.left.mouthX) <= 38) ||
                (rightOpen && Math.abs(o.x - ends.right.mouthX) <= 38))
          );
          if (catchV) {
            for (const [spId, dM] of Object.entries(drainedMoles)) {
              catchV.moles[spId] = (catchV.moles[spId] || 0) + dM;
            }
          } else {
            v.spilledPuddleColor = visD.css;
          }
          v.horizontalSpillRateMlS = (drainMl * drainFrac) / Math.max(1e-4, scaledDt);
          v.horizontalSpillLeft = leftOpen;
          v.horizontalSpillRight = rightOpen;
          v.horizontalSpillColor = visD.css;
        } else {
          v.horizontalSpillRateMlS = 0;
        }
      } else {
        v.horizontalSpillRateMlS = 0;
      }

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
          frameGas.Br2_g > 1e-7 ||
          frameGas.I2_g > 1e-7 ||
          frameGas.HBr_g > 1e-6 ||
          frameGas.HI_g > 1e-6 ||
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

      // Assemble jitter-free debounced active reactions list (holds brief pauses up to 1.25s without flickering)
      if (!v._rxnHoldMap || typeof v._rxnHoldMap.entries === 'function') v._rxnHoldMap = {};
      const dispRxns = [];
      for (const [id, entry] of Object.entries(v._rxnHoldMap)) {
        const ageSec = this.timeSec - entry.lastActiveTime;
        if (ageSec > 1.25) {
          delete v._rxnHoldMap[id];
          continue;
        }
        const decayedRate = frameActiveMap.has(id) ? entry.emaRateMolS : entry.emaRateMolS * Math.exp(-2.4 * Math.max(0, ageSec));
        dispRxns.push({ ...entry.rxn, rateMolS: decayedRate, _firstSeen: entry.firstSeenTime });
      }
      dispRxns.sort((a, b) => (a._firstSeen - b._firstSeen) || String(a.id).localeCompare(String(b.id)));
      v.activeReactions = dispRxns;

      // Dazzling Zinc combustion notification in concentrated O2 / hot air
      if (
        frameActiveMap.has('zn_o2_burn') &&
        (this.timeSec - (v.seenReactions.zn_burn_o2_alert ?? -99)) > 5.0 &&
        getVesselEffectiveO2Bar(v, this.environment) >= 0.45
      ) {
        v.seenReactions.zn_burn_o2_alert = this.timeSec;
        this.addLog({ type: 'alert', key: 'alertZnCombustionO2', vesselLabel: v.label });
        if (this.visualHooks.onAlert) {
          this.visualHooks.onAlert('zn_burn_o2', v, {});
        }
      }

      // Two-temperature coupled Sodium / Potassium explosion / ignition shatter
      if (!v.isShattered && (frameNaEvent === 'explosion' || frameKEvent === 'explosion')) {
        const isKBlast = frameKEvent === 'explosion';
        const hazardHit = isKBlast ? v.kHazardFlag : v.naHazardFlag;
        const maxStress = APPARATUS[v.typeId]?.maxThermalStressK || 550;
        if (maxStress >= 1000 && !hazardHit) {
          if (isKBlast) v.kTempK = Math.min(v.kTempK || 620, 650);
          else v.naTempK = Math.min(v.naTempK || 720, 740);
          if (this.visualHooks.onAlert) {
            this.visualHooks.onAlert('o2_relight', { x: v.x, y: v.y - 12 }, { vesselId: v.id });
          }
        } else {
          const alertKey = hazardHit ? 'alertNaHazardExplosion' : 'alertNaExplosion';
          this.shatterVessel(v, alertKey, 'explosion');
          continue;
        }
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

      // Alkali metal (Na / K) motion on meniscus (K skitters ~1.35x faster than Na!)
      const naActive =
        frameActiveMap.has('na_water') ||
        frameActiveMap.has('na_acid') ||
        frameActiveMap.has('na_ethanol') ||
        frameActiveMap.has('na_ice');
      const kActive =
        frameActiveMap.has('k_water') ||
        frameActiveMap.has('k_acid') ||
        frameActiveMap.has('k_ethanol') ||
        frameActiveMap.has('k_ice');
      const isDehydrating = frameActiveMap.has('dehydrate_cuso4_5h2o') || frameActiveMap.has('dehydrate_bacl2_2h2o');
      const stepAlkaliSkitter = (active, spId, posKey, velKey, phaseKey, pinKey, mult) => {
        if (!active || (v.moles[spId] || 0) <= 1e-7) return;
        const motionScale = ((v.moles.H2O_l || 0) > 5e-4 ? 1.0 : 0.25) * mult;
        if (v[pinKey]) {
          const pinTarget = (v[posKey] ?? 0.5) >= 0.5 ? 0.88 : 0.12;
          v[posKey] += (pinTarget - (v[posKey] ?? 0.5)) * Math.min(1, realDeltaSec * 8 * motionScale);
        } else {
          v[phaseKey] = (v[phaseKey] || 0) + realDeltaSec * 8.5 * motionScale;
          v[posKey] = (v[posKey] ?? 0.5) + (v[velKey] || 0.9) * realDeltaSec * (0.8 + Math.sin(v[phaseKey]) * 0.6) * motionScale;
          if (v[posKey] > 0.84) {
            v[posKey] = 0.84;
            v[velKey] = -Math.abs(v[velKey] || 0.9);
          } else if (v[posKey] < 0.16) {
            v[posKey] = 0.16;
            v[velKey] = Math.abs(v[velKey] || 0.9);
          }
        }
      };
      stepAlkaliSkitter(naActive, 'Na_s', 'naPosRatio', 'naVel', 'naVisualPhase', 'naPinned', 1.0);
      stepAlkaliSkitter(kActive, 'K_s', 'kPosRatio', 'kVel', 'kVisualPhase', 'kPinned', 1.35);

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

      const labelOrder = ['C2H5Cl_g', 'NH3_g', 'NO2_g', 'NO_g', 'N2O_g', 'N2_g', 'H2_g', 'O2_g', 'Cl2_g', 'HCl_g', 'C2H5OH_g'];
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
        ((rateSteam > 4e-5 && curSteamOpacity > 0.12) ||
          frameBoiling ||
          (v.headspaceGasMoles?.H2O_g || 0) > 1e-5 ||
          (v._cuoReductionCondenseTimer || 0) > 0)
      ) {
        const baseCond = (v._cuoReductionCondenseTimer || 0) > 0 ? 0.52 : 0.25;
        const targetCond = Math.min(1, baseCond + curSteamOpacity * 0.65);
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
      this.stepGasFlameInteractions(v, rateMap, scaledDt);
      v.lastTotalRateMolS = Array.from(frameActiveMap.values()).reduce((s, r) => s + (r.rateMolS || 0), 0);
      v.cumulativeReactionHeatJ = (v.cumulativeReactionHeatJ || 0) + frameRxnHeatJ;
      if (scaledDt > 1e-4) {
        const instTempRate = (v.tempK - tempBeforeStepK) / scaledDt;
        const tAlpha = Math.min(1, Math.max(0.05, realDeltaSec * 3.0));
        v.lastTempRateCS = (v.lastTempRateCS || 0) * (1 - tAlpha) + instTempRate * tAlpha;
      }
      if (frameActiveMap.size > 0) {
        v._hadActiveRxnPrev = true;
        v._lastRxnPeakRateMolS = Math.max(v._lastRxnPeakRateMolS || 0, v.lastTotalRateMolS);
        let bestPct = null;
        for (const r of frameActiveMap.values()) {
          const cumXi = v._reactionExtentMap?.[r.id] || r.dXi || 0;
          const rDef = REACTIONS.find((rx) => rx.id === r.id);
          if (rDef?.reactants && cumXi > 1e-8) {
            let remXi = Infinity;
            for (const [spId, st] of Object.entries(rDef.reactants)) {
              if (st > 0) remXi = Math.min(remXi, (v.moles[spId] || 0) / st);
            }
            if (Number.isFinite(remXi)) {
              const pct = Math.min(99.9, Math.max(0, (cumXi / Math.max(1e-9, cumXi + remXi)) * 100));
              bestPct = bestPct === null ? pct : Math.max(bestPct, pct);
            }
          }
        }
        if (bestPct === null && (v._lastRxnPeakRateMolS || 0) > 1e-8) {
          bestPct = Math.max(1, Math.min(99.5, (1 - v.lastTotalRateMolS / v._lastRxnPeakRateMolS) * 100));
        }
        if (bestPct !== null) v.conversionYieldPct = bestPct;
      } else if (v._hadActiveRxnPrev) {
        v._hadActiveRxnPrev = false;
        v._lastRxnPeakRateMolS = 0;
        v.conversionYieldPct = 100;
      }
      if ((v.moles.Phenolphthalein_aq || 0) > 1e-8) {
        const liqPhNow = computeLiquidVolumeL(v.moles, v.tempK);
        const phIndNow = liqPhNow > 1e-6 ? computePH(v.moles, liqPhNow, v.tempK) : null;
        if (phIndNow !== null) {
          const phenStateNow = phIndNow >= 8.2 ? 'pink' : 'colorless';
          if (v._lastLoggedPhenState && v._lastLoggedPhenState !== phenStateNow && (this.timeSec - (v._lastPhenLogSec ?? -99)) > 1.5) {
            v._lastPhenLogSec = this.timeSec;
            this.addLog({
              type: 'alert',
              key: phenStateNow === 'pink' ? 'logIndicatorPink' : 'logIndicatorColorless',
              vesselLabel: v.label,
              phNow: phIndNow,
            });
          }
          v._lastLoggedPhenState = phenStateNow;
        }
      } else {
        v._lastLoggedPhenState = null;
      }
      for (const gId of ALL_GAS_IDS) {
        if (gId !== 'H2O_g') v.cumulativeGasMol = (v.cumulativeGasMol || 0) + (frameGas[gId] || 0);
      }
      const tubeBubbleRate = (v._tubeBubbleGasMol || 0) * invDt;
      v._tubeBubbleGasMol = 0;

      // Emit visual particle request & snapshot metrics so paused visuals keep animating cleanly
      const visMetrics = {
        gasRates: rateMap,
        gasRateH2: rateMap.H2_g,
        gasRateO2: rateMap.O2_g,
        gasRateCO2: (rateMap.CO2_g || 0) + tubeBubbleRate,
        gasRateHCl: rateMap.HCl_g,
        gasRateHNO3: rateMap.HNO3_g,
        gasRateCl2: rateMap.Cl2_g,
        gasRateC2H5Cl: rateMap.C2H5Cl_g,
        gasRateNH3: rateMap.NH3_g,
        gasRateNO2: rateMap.NO2_g,
        gasRateSO3: rateMap.SO3_g,
        gasRateNO: rateMap.NO_g,
        atmosphereMode: this.environment.atmosphereMode || 'air',
        steamRate: rateSteam,
        steamOpacity: curSteamOpacity,
        overflowRateMlS: v.overflowRateMlS || 0,
        overflowColor: v.overflowColor || null,
        horizontalSpillRateMlS: v.horizontalSpillRateMlS || 0,
        horizontalSpillLeft: !!v.horizontalSpillLeft,
        horizontalSpillRight: !!v.horizontalSpillRight,
        horizontalSpillColor: v.horizontalSpillColor || null,
        isBoiling: frameBoiling,
        isDehydrating,
        naActive,
        naIgnited: !!v.naIgnited || (v.naDryBurnTimer || 0) > 0.05,
        naTempK: v.naTempK,
        naRate:
          (frameActiveMap.get('na_water')?.rateMolS || 0) +
          (frameActiveMap.get('na_acid')?.rateMolS || 0) +
          (frameActiveMap.get('na_ethanol')?.rateMolS || 0) +
          (frameActiveMap.get('na_ice')?.rateMolS || 0),
        kActive,
        kIgnited: !!v.kIgnited || (v.kDryBurnTimer || 0) > 0.05,
        kTempK: v.kTempK,
        kRate:
          (frameActiveMap.get('k_water')?.rateMolS || 0) +
          (frameActiveMap.get('k_acid')?.rateMolS || 0) +
          (frameActiveMap.get('k_ethanol')?.rateMolS || 0) +
          (frameActiveMap.get('k_ice')?.rateMolS || 0),
        znBurning: (v.znCombustionTimer || 0) > 0.05,
        mgBurning: (v.mgCombustionTimer || 0) > 0.05,
        alBurning: (v.alCombustionTimer || 0) > 0.05,
        naDryBurning: (v.naDryBurnTimer || 0) > 0.05,
        kDryBurning: (v.kDryBurnTimer || 0) > 0.05,
      };
      v._lastVisualMetrics = visMetrics;
      if (this.visualHooks.onParticlesNeeded) {
        this.visualHooks.onParticlesNeeded(v, visMetrics);
      }

      this.recordHistorySnapshot(v, false);
    }

    // Step wheel-tilt pouring & falling spills for filter funnels & spoons, plus expire electrode tube telemetry
    const nowFlowMs = Date.now();
    for (const tool of this.items) {
      if ((tool.kind === 'filter_funnel' || tool.kind === 'spoon') && !tool.isBroken) {
        this.stepVesselTiltPouring(tool, scaledDt);
      } else if (tool.kind === 'electrode' && tool._liveTubeFlow && (!tool.gasTargetId || nowFlowMs - tool._liveTubeFlow.updatedAt > 450)) {
        tool._liveTubeFlow = null;
      }
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
          a.nh4clFrostLevel = Math.min(1.0, (a.nh4clFrostLevel || 0) + 0.03 * realDeltaSec);
          b.nh4clFrostLevel = Math.min(1.0, (b.nh4clFrostLevel || 0) + 0.03 * realDeltaSec);
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

    this.stepSpoonAnimations(realDeltaSec);
    stepApparatusTools(this, scaledDt, realDeltaSec);
    this.syncAttachedMouthTools();
    stepElectrochemistry(this, scaledDt);

    if (this.visualHooks.onParticlesNeeded) {
      for (const item of this.items) {
        if (item.kind === 'filter_funnel' && item.isFiltering) {
          this.visualHooks.onParticlesNeeded(item, { rateMlS: item.filtrateRateMlS, color: item.filtrateColor });
        } else if (item.kind === 'separatory_funnel' && item.activeDrop) {
          this.visualHooks.onParticlesNeeded(item, { rateMlS: item.drainRateMlS, color: item.drainColor });
        } else if (item.kind === 'burette' && item.streamingNow) {
          this.visualHooks.onParticlesNeeded(item, { rateMlS: item.valveRateMlS, color: item.streamColor });
        } else if (item.kind === 'condenser' && item.activeDrop) {
          this.visualHooks.onParticlesNeeded(item, { rateMlS: item.distillRateMlS, color: item.lastCondColor });
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
