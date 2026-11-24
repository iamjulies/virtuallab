/**
 * Main Simulation Engine Orchestrator (Refactor 81).
 * Modular helpers live in ./simSnapshot.js, ./simTransfer.js, ./simPhysics.js
 */
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
  getSepFunnelMountY,
  getStandGeometry,
  getSyringeGeometry,
  getVesselEndPorts,
} from '../data/apparatus.js';
import { getInnerPolygonPx, getVesselHoldVolumeMl } from '../data/vesselGeometry.js';
import { applyPresetScenario } from '../data/presets.js';
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

import { SIM_BENCH_FLOOR_Y, exportPositionSnapshotForSim, exportSnapshotForSim, restoreSnapshotForSim, computeVesselMoleSigForVessel, computeChemActivitySigForVessel, recordHistorySnapshotForVessel } from './simSnapshot.js';
import { getVesselBrimVolumeMl, moveFluidFraction, extractSyringeLiquidFraction, spoonScoopFromVesselImpl, spoonPourIntoVesselImpl, rinseSpoonImpl, stepSpoonAnimationsImpl, deliverSyringeSliceToVesselImpl, pumpSyringeToVesselImpl, stepSyringeDischargeImpl, addReagentToVesselImpl, stepTimedTransfersInnerImpl, pourBetweenVesselsImpl, transferSolidsToVesselImpl, buretteDispenseDropImpl, washBottleSquirtImpl, pipetteDrawFromVesselImpl, pipetteDrawFromSyringeImpl, pipetteDrawFromReagentImpl, pipetteDispenseToVesselImpl, stepVesselTiltPouringImpl } from './simTransfer.js';
import { getSupportSurfaceForItemImpl, updateSupportAttachmentsImpl, recomputeScaleReadingsImpl, checkOverflowImpl, stepVesselOverflowImpl, stepSyringeOverflowImpl, shatterVesselImpl, shatterSyringeImpl, popSyringePlungerImpl, breakPipetteOnDropImpl, breakToolOnDropImpl, handleLandingImpactImpl, stepGravityPhysicsImpl, getBurnerHeatingSourceImpl, condenseEscapedVaporInCryoImpl, stepInvertedGravitySpillImpl, stepAmmoniaFountainSuctionImpl, getBathCoolingSourceImpl, stepGasFlameInteractionsImpl, stepSimulationImpl } from './simPhysics.js';
export { SIM_BENCH_FLOOR_Y };
const createEmptyGasMap = createZeroGasMap;

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
    this._dirtySeq = 1;
  }

  withUndoSuppressed(fn) {
    this._suppressUndo = (this._suppressUndo || 0) + 1;
    try {
      return fn();
    } finally {
      this._suppressUndo = Math.max(0, (this._suppressUndo || 1) - 1);
    }
  }

  exportPositionSnapshot() { return exportPositionSnapshotForSim(this); }

  exportSnapshot() { return exportSnapshotForSim(this); }

  restoreSnapshot(snap) { return restoreSnapshotForSim(this, snap); }

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
    this._dirtySeq = (this._dirtySeq || 0) + 1;
    for (const fn of this.listeners) fn(this);
  }

  wakeVessel(v) {
    if (!v) return;
    v._quiescent = false;
    v._quietTicks = 0;
  }

  _computeVesselMoleSig(v) { return computeVesselMoleSigForVessel(this, v); }

  _computeChemActivitySig(v) { return computeChemActivitySigForVessel(this, v); }

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
        hasBoilingChips: false,
        bumpingSurgeFrac: 0,
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
        valveRateMlS: 3.5,
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
    } else if (spec.kind === 'stir_bar' || spec.kind === 'boiling_chips') {
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
    } else if (spec.kind === 'ph_conductometer') {
      Object.assign(base, {
        contactVesselId: null,
        contactLabel: '',
        measuredPH: null,
        measuredConductivity: null,
        history: [],
        tiltAngle: 0,
      });
    } else if (spec.kind === 'colorimeter') {
      Object.assign(base, {
        contactVesselId: null,
        contactLabel: '',
        spectroMode: 'uvvis_kinetics',
        irSubtractWater: true,
        wavelengthNm: 525,
        measuredAbsorbance: 0,
        measuredTransmittance: 100,
        measuredLambdaMax: 525,
        measuredSpectrumMaxA: 0,
        history: [],
        tiltAngle: 0,
      });
    } else if (spec.kind === 'tlc_plate') {
      Object.assign(base, {
        contactVesselId: null,
        contactLabel: '',
        solventFront: 0,
        eluentStrength: 0.35,
        spots: [],
        isDeveloping: false,
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
    if (item.kind === 'boiling_chips' && item.inVesselId) {
      const host = this.getItem(item.inVesselId);
      if (host) {
        host.hasBoilingChips = this.items.some((i) => i.kind === 'boiling_chips' && i.id !== item.id && i.inVesselId === host.id);
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
      item.hasBoilingChips = false;
      item.bumpingSurgeFrac = 0;
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
    applyPresetScenario(this, presetName, SIM_BENCH_FLOOR_Y);
  }

  getSupportSurfaceForItem(item) { return getSupportSurfaceForItemImpl(this, item); }

  /**
   * Automatically snap items gently touching scales or burners below them,
   * and detach supports that were slid away from underneath an item.
   */
  updateSupportAttachments() { return updateSupportAttachmentsImpl(this); }

  recomputeScaleReadings() { return recomputeScaleReadingsImpl(this); }

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

  spoonScoopFromVessel(spoonId, vesselId, maxGrams = 1.6) { return spoonScoopFromVesselImpl(this, spoonId, vesselId, maxGrams); }

  spoonPourIntoVessel(spoonId, vesselId) { return spoonPourIntoVesselImpl(this, spoonId, vesselId); }

  rinseSpoon(spoonId) { return rinseSpoonImpl(this, spoonId); }

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

  stepSpoonAnimations(dt) { return stepSpoonAnimationsImpl(this, dt); }

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
  _deliverSyringeSliceToVessel(syr, dst, liqMoveFrac, gasMoveFrac, syrT, dtApprox = 0.05) { return deliverSyringeSliceToVesselImpl(this, syr, dst, liqMoveFrac, gasMoveFrac, syrT, dtApprox); }

  pumpSyringeToVessel(syringeId, targetVesselId, targetVolMl = null) { return pumpSyringeToVesselImpl(this, syringeId, targetVesselId, targetVolMl); }

  stepSyringeDischarge(syringe, dt) { return stepSyringeDischargeImpl(this, syringe, dt); }

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
    this.wakeVessel(v);
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
    v.hasBoilingChips = false;
    v.bumpingSurgeFrac = 0;
    v.soapFoamMl = 0;
    v.soapScorchFrac = 0;
    v.soapScorched = false;
    v.soapConcPassivated = false;
    v.soapEarlySalted = false;
    v.soapSaltedOutCake = false;
    v.saponificationComplete = false;
    v.esterOverheatFrac = 0;
    v.esterPurified = false;
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
  addReagentToVessel(vesselId, reagentId, amount, options = {}) { return addReagentToVesselImpl(this, vesselId, reagentId, amount, options); }

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

  _stepTimedTransfersInner(nowMsOverride = null) { return stepTimedTransfersInnerImpl(this, nowMsOverride); }

  /**
   * Pour solution from source vessel into target vessel using physical Decantation (default)
   * or Shake-Before-Pour mechanics driven by vessel shape, solid buoyancy, and suspension state.
   */
  pourBetweenVessels(sourceId, targetId, volumeMl, shakeBeforePour = false, streamOpts = {}) { return pourBetweenVesselsImpl(this, sourceId, targetId, volumeMl, shakeBeforePour, streamOpts); }

  /**
   * Expose mathematical & conservation invariant validation for a vessel.
   */
  getVesselInvariants(vesselId) {
    return validateVesselInvariants(this.getItem(vesselId));
  }

  /**
   * Transfer solid residue/powder cleanly between containers (e.g. Filter Funnel paper or Mortar & Pestle -> Vessel).
   */
  transferSolidsToVessel(sourceId, targetId, fraction = 1.0) { return transferSolidsToVesselImpl(this, sourceId, targetId, fraction); }

  grindMortar(mortarId) {
    return grindMortarSolids(this, mortarId);
  }

  setBuretteValveRate(buretteId, rateMlS) {
    const b = this.getItem(buretteId);
    if (!b || b.kind !== 'burette') return;
    b.valveRateMlS = Math.max(0, Math.min(10.0, Number(rateMlS) || 0));
    this.emitChange();
  }

  buretteDispenseDrop(buretteId, dropMl = 0.05) { return buretteDispenseDropImpl(this, buretteId, dropMl); }

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

  washBottleSquirt(bottleId, targetId = null, volMl = 5.0) { return washBottleSquirtImpl(this, bottleId, targetId, volMl); }

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

  insertBoilingChipsIntoVessel(chipId, vesselId) {
    const chips = this.getItem(chipId);
    const v = this.getItem(vesselId);
    if (!chips || chips.kind !== 'boiling_chips' || !v || v.kind !== 'vessel' || v.isShattered || v.isStoppered) return false;
    if (chips.inVesselId && chips.inVesselId !== v.id) {
      this.removeBoilingChipsFromVessel(chips.id);
    }
    chips.inVesselId = v.id;
    v.hasBoilingChips = true;
    v.bumpingSurgeFrac = 0;
    syncDockedToolPositions(this);
    this.recomputeScaleReadings();
    this.emitChange();
    return true;
  }

  removeBoilingChipsFromVessel(chipId) {
    const chips = this.getItem(chipId);
    if (!chips || chips.kind !== 'boiling_chips') return false;
    if (chips.inVesselId) {
      const v = this.getItem(chips.inVesselId);
      if (v) {
        const stillHas = this.items.some((i) => i.kind === 'boiling_chips' && i.id !== chips.id && i.inVesselId === v.id);
        v.hasBoilingChips = stillHas;
      }
      chips.inVesselId = null;
      chips.y = Math.min(SIM_BENCH_FLOOR_Y - 8, chips.y);
      chips.x = Math.min(920, chips.x + 56);
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
   * Pipette operations: draw up to 10 mL from any open liquid container (vessel, funnel, burette, reagent),
   * preserving full liquid-liquid/aqueous mixtures, or dispense into any open container.
   */
  pipetteDrawFromVessel(vesselId, drawMl = 10.0, targetPipette = null) { return pipetteDrawFromVesselImpl(this, vesselId, drawMl, targetPipette); }

  pipetteDrawFromSyringe(syringeId, drawMl = 10.0, targetPipette = null) { return pipetteDrawFromSyringeImpl(this, syringeId, drawMl, targetPipette); }

  pipetteDrawFromReagent(reagentId, drawMl = 2.0) { return pipetteDrawFromReagentImpl(this, reagentId, drawMl); }

  pipetteDispenseToVessel(vesselId, dropMl = 0.05, sourcePipette = null) { return pipetteDispenseToVesselImpl(this, vesselId, dropMl, sourcePipette); }

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

  checkOverflow(vessel) { return checkOverflowImpl(this, vessel); }

  /**
   * Handle excess liquid past physical vessel brim depending on stopper boundary:
   * - Open: gradual waterfall spill over rim
   * - Hard stopper (no tube): pops stopper off via hydraulic pressure, then spills
   * - Stopper + rubber tubing: fills calibrated tube volume (length * fixed Ø6mm bore) first,
   *   then streams into the connected vessel or Gas Syringe barrel.
   */
  stepVesselOverflow(vessel, dt) { return stepVesselOverflowImpl(this, vessel, dt); }

  /**
   * Drain excess liquid from a maxed-out 250 mL Gas Syringe with rear collar spray.
   */
  stepSyringeOverflow(syringe, dt) { return stepSyringeOverflowImpl(this, syringe, dt); }

  recordHistorySnapshot(vessel, force = false) { return recordHistorySnapshotForVessel(this, vessel, force); }

  /**
   * Shatter a vessel from overpressure or thermal/H2 explosion and spill all contents.
   */
  shatterVessel(vessel, logKey, alertKind) { return shatterVesselImpl(this, vessel, logKey, alertKind); }

  shatterSyringe(syringe, logKey = 'alertSyringeOverpressureShatter') { return shatterSyringeImpl(this, syringe, logKey); }

  popSyringePlunger(vessel, syringe) { return popSyringePlungerImpl(this, vessel, syringe); }

  breakPipetteOnDrop(pip) { return breakPipetteOnDropImpl(this, pip); }

  breakToolOnDrop(item) { return breakToolOnDropImpl(this, item); }

  handleLandingImpact(item, dropDistPx, impactVy, support) { return handleLandingImpactImpl(this, item, dropDistPx, impactVy, support); }

  stepGravityPhysics(dt, realDeltaSec) { return stepGravityPhysicsImpl(this, dt, realDeltaSec); }

  /**
   * Determine active Alcohol Burner OR Bunsen Burner heating source for a vessel:
   * - Direct contact on tripod (`vessel.restingOnId`) delivers 100% wattage (and oxidizing cone focus on Bunsen)
   * - Clamped or held vessels positioned over a lit burner's flame plume receive geometric convective coupling
   */
  getBurnerHeatingSource(vessel) { return getBurnerHeatingSourceImpl(this, vessel); }

  /**
   * Condense/freeze ambient escaped H2O(g) into surface frost whenever ambient T < 273.15 K.
   */
  condenseEscapedVaporInCryo() { return condenseEscapedVaporInCryoImpl(this); }

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
  stepInvertedGravitySpill(v, dt) { return stepInvertedGravitySpillImpl(this, v, dt); }

  /**
   * Phenomenon #2: Vacuum suction through tubing when stoppered flask pressure < ambient pressure
   * (e.g., Ammonia Fountain when NH3(g) dissolves rapidly into trace water).
   */
  stepAmmoniaFountainSuction(v, dt) { return stepAmmoniaFountainSuctionImpl(this, v, dt); }

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
    const clampedFrac = Math.max(0.005, Math.min(1.0, Number(flowFrac) || 0.35));
    f.valveFlowFrac = clampedFrac;
    f.valveRateMlS = Math.max(0.05, Math.min(10.0, +(clampedFrac * 10.0).toFixed(2)));
    this.emitChange();
    return true;
  }

  setSeparatoryValveRateMlS(funnelId, rateMlS = 3.5) {
    const f = this.getItem(funnelId);
    if (!f || f.kind !== 'separatory_funnel' || f.isBroken) return false;
    const clampedRate = Math.max(0.05, Math.min(10.0, Number(rateMlS) || 3.5));
    f.valveRateMlS = +clampedRate.toFixed(2);
    f.valveFlowFrac = +(clampedRate / 10.0).toFixed(4);
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
    const liqL = computeLiquidVolumeL(f.moles, f.tempK);
    const liqMl = liqL * 1000;
    if (liqMl <= 0.05) return false;

    const uncappedSpill = f.isStoppered === false;
    if (uncappedSpill) {
      const spillFrac = 0.35;
      const spillMl = liqMl * spillFrac;
      const visCss = computeSolutionVisuals(
        f.moles,
        Math.max(1e-5, liqL),
        computePH(f.moles, liqL, f.tempK),
        3.0,
        f.phenBleachFrac || 0,
        f.phenIrrevFrac || 0
      ).css;
      for (const [spId, n] of Object.entries(f.moles || {})) {
        if (n <= 0) continue;
        const rem = n * (1 - spillFrac);
        if (rem < 1e-13) delete f.moles[spId];
        else f.moles[spId] = rem;
      }
      f.spillAnimTimer = 1.45;
      f.spillColor = visCss;
      this.addLog({
        type: 'alert',
        key: 'alertSepFunnelUncappedSpill',
        vesselLabel: f.label,
      });
      if (this.visualHooks.onAlert) {
        this.visualHooks.onAlert('sep_spill', f, {
          liquidColor: visCss,
          spillMl,
        });
      }
    }

    f.emulsionTimer = 2.6;
    f.stirTimer = Math.max(f.stirTimer || 0, 2.6);
    stepVesselChemistry(f, 0.25, { environment: this.environment });
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
    this.recomputeScaleReadings();
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
    syncDockedToolPositions(this);
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

  getBathCoolingSource(vessel) { return getBathCoolingSourceImpl(this, vessel); }

  stepVesselTiltPouring(v, dt) { return stepVesselTiltPouringImpl(this, v, dt); }

  stepGasFlameInteractions(v, rateMap, dt) { return stepGasFlameInteractionsImpl(this, v, rateMap, dt); }

  /**
   * Main simulation tick called by animation loop (realDeltaSec).
   */
  step(realDeltaSec, options = {}) { return stepSimulationImpl(this, realDeltaSec, options); }
}

export { computeSyringeGasVolumeMl };
