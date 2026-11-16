import { CONSTANTS, waterBoilingPointK } from '../data/constants.js';
import { SPECIES, STARTER_REAGENTS } from '../data/species.js';
import { APPARATUS } from '../data/apparatus.js';
import {
  computeContentsMassG,
  computeLiquidVolumeL,
  computePH,
  computePhenolphthaleinBleachEq,
  computeSolidVolumeMl,
  computeSolutionVisuals,
} from './equilibrium.js';
import { enforceDryPhaseBoundary, stepVesselChemistry } from './chemistry.js';
import { computeHeatCapacityJK, computeSteamOpacity, stepVesselThermodynamics } from './thermodynamics.js';
import {
  ALL_GASES,
  NON_STEAM_GASES,
  buildCombinedSyringeLiquidMoles,
  computeSyringeDischargeArc,
  computeSyringeGasVolumeMl,
  computeSyringeHeatCapacityJK,
  computeSyringeLiquidVolumeMl,
  computeSyringeTotalVolumeMl,
  computeTubingGeometry,
  getSyringeNozzlePos,
  stepSyringeThermodynamics,
  stepVesselGasAndPressure,
} from './gasNetwork.js';

const SIM_BENCH_FLOOR_Y = 482;

function createEmptyGasMap() {
  const obj = {};
  for (const g of ALL_GASES) obj[g] = 0;
  return obj;
}

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
    this.activePourStream = null; // { fromX, fromY, toX, toY, color, timer }
    this.activeReagentTransfer = null; // { reagentId, vesselId, isSolid, startMs, durationMs, dose, color, speciesId, fine }
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
    };

    if (spec.kind === 'vessel') {
      Object.assign(base, {
        moles: {},
        particleCounts: {},
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
      });
    } else if (spec.kind === 'scale') {
      Object.assign(base, {
        tareG: 0,
        measuredG: 0,
      });
    } else if (spec.kind === 'burner') {
      Object.assign(base, {
        flameLevel: 0, // 0=off, 1=low, 2=med, 3=high
        powerW: 0,     // 0..650 W continuous burner power
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
    // Clean up connections referencing removed apparatus
    for (const other of this.items) {
      if (other.connectedSyringeId === id || other.connectedTargetId === id) {
        this.disconnectSyringe(other.id);
      }
      if (other.connectedFromId === id) {
        other.connectedFromId = null;
      }
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
    if (item.kind !== 'vessel' && item.kind !== 'gas_syringe') return false;
    const standTop = stand.y - APPARATUS.retort_stand.height / 2;
    const spec = APPARATUS[item.typeId];
    item.clampedToId = stand.id;
    item.restingOnId = null;
    item.vy = 0;
    item.fallStartY = null;
    item.y = Math.max(standTop + 18, Math.min(SIM_BENCH_FLOOR_Y - spec.height / 2 - 6, item.y));
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

  setupPreset(presetName) {
    this.items = [];
    this.logs = [];
    this.timeSec = 0;
    this.nextId = 1;

    if (presetName === 'gas_collect') {
      const flask = this.createApparatus('erlenmeyer_250', 290, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      const stand = this.createApparatus('retort_stand', 685, SIM_BENCH_FLOOR_Y - APPARATUS.retort_stand.height / 2 + 2);
      const syringe = this.createApparatus('gas_syringe', 625, 325);
      this.attachToStand(syringe.id, stand.id);
      const burner = this.createApparatus('burner', 135, SIM_BENCH_FLOOR_Y - APPARATUS.burner.height / 2 + 2);
      this.connectSyringe(flask.id, syringe.id);
      this.selectedId = flask.id;
    } else {
      // Default clean bench: Scale + ISO Beaker + Burner + ISO Erlenmeyer
      const scale = this.createApparatus('scale', 220, SIM_BENCH_FLOOR_Y - APPARATUS.scale.height / 2 + 2);
      const beaker = this.createApparatus('beaker_250', 220, SIM_BENCH_FLOOR_Y - APPARATUS.scale.height - APPARATUS.beaker_250.height / 2 + 2);
      const burner = this.createApparatus('burner', 560, SIM_BENCH_FLOOR_Y - APPARATUS.burner.height / 2 + 2);
      const flask = this.createApparatus('erlenmeyer_250', 760, SIM_BENCH_FLOOR_Y - APPARATUS.erlenmeyer_250.height / 2 + 2);
      this.updateSupportAttachments();
      this.selectedId = beaker.id;
    }
    this.emitChange();
  }

  getSupportSurfaceForItem(item) {
    const spec = APPARATUS[item.typeId];
    const floorCenterY = SIM_BENCH_FLOOR_Y - spec.height / 2 + 2;
    let bestCenterY = floorCenterY;
    let bestSupport = null;

    if (item.kind === 'scale' || item.kind === 'burner' || item.kind === 'stand') {
      return { centerY: floorCenterY, support: null };
    }

    const itemBottom = item.y + spec.height / 2;
    for (const sup of this.items) {
      if (sup.id === item.id) continue;
      if (sup.kind !== 'scale' && sup.kind !== 'burner') continue;
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
      if (support && Math.abs(it.y - centerY) <= 18) {
        it.restingOnId = support.id;
        it.y = centerY;
        if (Math.abs(it.x - support.x) < 28) it.x = support.x;
        it.vy = 0;
        it.fallStartY = null;
      } else if (!support && Math.abs(it.y - centerY) <= 10) {
        it.y = centerY;
        it.vy = 0;
        it.fallStartY = null;
      } else if (prevSupId && !support && !it.isDragging) {
        // Support beneath was moved away -> begin real freefall
        it.fallStartY = it.fallStartY ?? it.y;
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
        if (it.kind === 'vessel') {
          loadG += (spec.tareMassG || 0) + computeContentsMassG(it.moles);
        } else if (it.kind === 'gas_syringe') {
          const syrMoles = buildCombinedSyringeLiquidMoles(it);
          loadG += 185.0 + computeContentsMassG(syrMoles);
        } else if (it.kind === 'pipette') {
          loadG += 18.0 + computeContentsMassG(it.moles || {});
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
    const otherVessels = this.items.filter(
      (it) =>
        it.kind === 'vessel' &&
        it.id !== vesselId &&
        !it.isShattered &&
        it.connectedTargetId !== vesselId &&
        it.connectedSyringeId !== vesselId
    );
    return [...syringes, ...otherVessels];
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
        fromX: syr.x - (APPARATUS.gas_syringe.width / 2 - 2),
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
    if (!v || v.kind !== 'vessel' || v.isShattered) return;
    v.stirTimer = 3.0;
    // Re-suspend precipitates when stirred
    for (const key of Object.keys(v.precipitateSettle)) {
      v.precipitateSettle[key] = Math.min(v.precipitateSettle[key], 0.15);
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
    this.recomputeScaleReadings();
    this.emitChange();
  }

  /**
   * Add a pure reagent from the shelf into a vessel with exact mass (g) or volume (mL).
   */
  addReagentToVessel(vesselId, reagentId, amount, options = {}) {
    const v = this.getItem(vesselId);
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
    if (!v || v.kind !== 'vessel' || !reg || v.isShattered) return false;

    const amt = Math.max(0, Number(amount) || 0);
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
    this.emitChange();
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
   * Pour solution from source vessel into target vessel.
   */
  pourBetweenVessels(sourceId, targetId, volumeMl, includePrecipitate = true) {
    const src = this.getItem(sourceId);
    const dst = this.getItem(targetId);
    if (!src || !dst || src.id === dst.id || src.isShattered || dst.isShattered) return 0;

    const srcLiqL = computeLiquidVolumeL(src.moles, src.tempK);
    const srcLiqMl = srcLiqL * 1000;
    if (srcLiqMl <= 0.01) return 0;

    const actualMl = Math.min(srcLiqMl, Math.max(0, volumeMl));
    const frac = Math.min(1, actualMl / srcLiqMl);
    if (frac <= 0) return 0;

    const cDstBefore = computeHeatCapacityJK(dst);
    const oldDstPhen = dst.moles.Phenolphthalein_aq || 0;
    const oldDstBleach = dst.phenBleachFrac || 0;
    let movedPhen = 0;
    let cMoved = 0;

    for (const [spId, n] of Object.entries(src.moles)) {
      if (n <= 0) continue;
      const sp = SPECIES[spId];
      if (!sp) continue;

      const isTransferable =
        sp.phase === 'l' ||
        sp.phase === 'aq' ||
        (includePrecipitate && sp.isPrecipitate && sp.id !== 'Cu_s' && sp.id !== 'Ag_s');

      if (!isTransferable) continue;

      const moveMol = n * frac;
      if (spId === 'Phenolphthalein_aq') movedPhen = moveMol;
      src.moles[spId] = n - moveMol;
      if (src.moles[spId] < 1e-13) delete src.moles[spId];
      dst.moles[spId] = (dst.moles[spId] || 0) + moveMol;
      cMoved += moveMol * Math.max(0, sp.cp || 0);

      if (sp.isPrecipitate) {
        dst.precipitateSettle[spId] = 0.05; // Newly poured precipitate swirls
      }
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
    this.activePourStream = {
      fromX: src.x,
      fromY: src.y - 40,
      toX: dst.x,
      toY: dst.y - dstSpec.height * 0.25,
      color: computeSolutionVisuals(
        src.moles,
        srcLiqL,
        computePH(src.moles, srcLiqL, src.tempK),
        APPARATUS[src.typeId].opticalPathCm,
        src.phenBleachFrac,
        src.phenIrrevFrac || 0
      ).css,
      timer: 0.25,
    };

    this.checkOverflow(dst);
    this.recomputeScaleReadings();
    this.emitChange();
    return actualMl;
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
      pip.drawFromX = syr.x - (APPARATUS.gas_syringe.width / 2 - 4);
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
    this.disconnectSyringe(vessel.id);
    vessel.moles = {};
    vessel.headspaceGasMoles = {};
    vessel.precipitateSettle = {};
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
    syringe.isDischarging = false;
    syringe.autoDischargeTimer = 0;
    syringe.dischargeLiquidRateMlS = 0;
    syringe.gasMoles = createEmptyGasMap();
    syringe.condensedWaterMol = 0;
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

    const shatterThreshold = spec.fragilityDropPx || 195;
    if (dropDistPx >= shatterThreshold) {
      if (item.kind === 'vessel' && !item.isShattered) {
        this.shatterVessel(item, 'alertDropShatter', 'shatter');
      } else if (item.kind === 'gas_syringe' && !item.isBroken) {
        this.shatterSyringe(item, 'alertSyringeDropShatter');
      } else if (item.kind === 'pipette' && !item.isBroken) {
        this.breakPipetteOnDrop(item);
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

    // 2. Step vertical gravitational fall (process support bases before items resting on them)
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

      if (item.clampedToId) {
        const stand = this.getItem(item.clampedToId);
        if (stand && stand.kind === 'stand') {
          item.vy = 0;
          item.fallStartY = null;
          item.restingOnId = null;
          continue;
        }
        item.clampedToId = null;
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
      item.restingOnId = null;
      item.vy = (item.vy || 0) + gPx * dt;
      item.y += item.vy * dt;

      if (item.y >= centerY) {
        const dropDist = Math.max(0, centerY - (item.fallStartY ?? centerY));
        const impactVy = item.vy;
        item.y = centerY;
        item.vy = 0;
        item.fallStartY = null;
        item.restingOnId = support ? support.id : null;
        if (support && Math.abs(item.x - support.x) < 28) {
          item.x = support.x;
        }
        this.handleLandingImpact(item, dropDist, impactVy, support);
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
        for (let s = 0; s < numSteps; s++) {
          stepVesselThermodynamics(v, dt, this.environment, 0, 0);
        }
        continue;
      }

      // Continuous gravity spillover above physical brim
      this.stepVesselOverflow(v, scaledDt);

      // Check burner power & flame level if resting on an active burner
      let burnerPowerW = 0;
      let burnerFlameLevel = 0;
      if (v.restingOnId) {
        const sup = this.getItem(v.restingOnId);
        if (sup && sup.kind === 'burner') {
          const bSpec = APPARATUS.burner;
          burnerFlameLevel = sup.flameLevel || 0;
          burnerPowerW = sup.powerW ?? bSpec.powerLevelsW[Math.round(burnerFlameLevel)] ?? 0;
        }
      }

      let frameGasH2 = 0;
      let frameGasO2 = 0;
      let frameGasHCl = 0;
      let frameGasCl2 = 0;
      let frameGasC2H5Cl = 0;
      let frameGasNH3 = 0;
      let frameGasNO2 = 0;
      let frameGasNO = 0;
      let frameSteam = 0;
      let frameBoiling = false;
      let frameSteamOpacity = 0;
      let frameNaEvent = null;
      const frameActiveMap = new Map();

      for (let s = 0; s < numSteps; s++) {
        const chemRes = stepVesselChemistry(v, dt);
        const thermRes = stepVesselThermodynamics(
          v,
          dt,
          this.environment,
          chemRes.reactionHeatJ,
          burnerPowerW,
          burnerFlameLevel
        );
        const dryRes = enforceDryPhaseBoundary(v);

        const combinedGas = {
          H2_g: chemRes.gasProduced.H2_g || 0,
          O2_g: chemRes.gasProduced.O2_g || 0,
          HCl_g:
            (chemRes.gasProduced.HCl_g || 0) +
            (thermRes.hclProducedMol || 0) +
            (dryRes.gasProduced.HCl_g || 0),
          Cl2_g: chemRes.gasProduced.Cl2_g || 0,
          HNO3_g: (chemRes.gasProduced.HNO3_g || 0) + (dryRes.gasProduced.HNO3_g || 0),
          C2H5Cl_g: chemRes.gasProduced.C2H5Cl_g || 0,
          NH3_g: (chemRes.gasProduced.NH3_g || 0) + (dryRes.gasProduced.NH3_g || 0),
          NO2_g: chemRes.gasProduced.NO2_g || 0,
          NO_g: chemRes.gasProduced.NO_g || 0,
          H2O_g: (chemRes.gasProduced.H2O_g || 0) + (dryRes.gasProduced.H2O_g || 0),
        };

        const gasEvents = stepVesselGasAndPressure(
          v,
          combinedGas,
          thermRes.steamProducedMol,
          this.environment,
          getApp
        );

        frameGasH2 += combinedGas.H2_g;
        frameGasO2 += combinedGas.O2_g;
        frameGasHCl += combinedGas.HCl_g;
        frameGasCl2 += combinedGas.Cl2_g;
        frameGasC2H5Cl += combinedGas.C2H5Cl_g;
        frameGasNH3 += combinedGas.NH3_g;
        frameGasNO2 += combinedGas.NO2_g;
        frameGasNO += combinedGas.NO_g;
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

      // Advance reversible phenolphthalein carbinol fading & high-temp irreversible C-C cleavage
      if ((v.moles.Phenolphthalein_aq || 0) > 1e-12) {
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
        if (frameGasNH3 > 1e-6) {
          v.phenCottonLevel = Math.min(1.0, (v.phenCottonLevel || 0) + realDeltaSec * 2.2);
        } else if (frameGasHCl > 1e-6) {
          v.phenCottonLevel = Math.max(0, (v.phenCottonLevel || 0) - realDeltaSec * 2.5);
        } else {
          v.phenCottonLevel = Math.max(0, (v.phenCottonLevel || 0) - realDeltaSec * 0.04);
        }
      } else if (!v.hasPhenCotton) {
        v.phenCottonLevel = 0;
      }

      // Beilstein green copper flame test when vessel over lit burner holds Cu(s) + organohalide/halide gas
      if (v.restingOnId && burnerPowerW > 0) {
        const sup = this.getItem(v.restingOnId);
        const hasCuMetal =
          (v.moles.Cu_s || 0) > 1e-6 ||
          (v.moles.Cu3Zn_alpha_s || 0) > 1e-6 ||
          (v.moles.Cu3Zn_gamma_s || 0) > 1e-6;
        const hasHalogenPlume = frameGasC2H5Cl > 1e-7 || frameGasHCl > 1e-6 || frameGasCl2 > 1e-7 || (v.recentHalogenGasTimer || 0) > 0;
        if (sup && sup.kind === 'burner' && hasCuMetal && hasHalogenPlume) {
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

      v.activeReactions = Array.from(frameActiveMap.values());

      // Two-temperature coupled Sodium Coulomb explosion / ignition shatter
      if (!v.isShattered && frameNaEvent === 'explosion') {
        const alertKey = v.naHazardFlag ? 'alertNaHazardExplosion' : 'alertNaExplosion';
        this.shatterVessel(v, alertKey, 'explosion');
        continue;
      }

      // Boiling alert
      if (frameBoiling && !v.wasBoiling) {
        this.addLog({ type: 'alert', key: 'alertBoiling', vesselLabel: v.label });
      }
      v.wasBoiling = frameBoiling;

      // Update precipitate settling & Sodium skitter physics for renderer
      for (const [spId, n] of Object.entries(v.moles)) {
        const sp = SPECIES[spId];
        if (sp && sp.isPrecipitate && n > 1e-8) {
          const prev = v.precipitateSettle[spId] ?? 0.0;
          // Precipitates settle downward gradually unless stirred or vigorously bubbling
          const agitation = v.stirTimer > 0 || frameGasH2 > 1e-5 ? -0.35 : 0.14;
          v.precipitateSettle[spId] = Math.max(0.05, Math.min(1.0, prev + agitation * realDeltaSec));
        }
      }
      for (const spId of Object.keys(v.precipitateSettle)) {
        if (!v.moles[spId] || v.moles[spId] < 1e-9) {
          delete v.precipitateSettle[spId];
        }
      }

      // Sodium motion on meniscus (wide surface skitters freely; narrow surface pins against glass wall)
      const naActive = frameActiveMap.has('na_water') || frameActiveMap.has('na_acid') || frameActiveMap.has('na_ethanol');
      const isDehydrating = frameActiveMap.has('dehydrate_cuso4_5h2o');
      if (naActive && (v.moles.Na_s || 0) > 1e-7) {
        if (v.naPinned) {
          // Wall-pinned Sodium clings violently near glass wall edge
          const pinTarget = v.naPosRatio >= 0.5 ? 0.88 : 0.12;
          v.naPosRatio += (pinTarget - v.naPosRatio) * Math.min(1, realDeltaSec * 8);
        } else {
          v.naVisualPhase += realDeltaSec * 8.5;
          v.naPosRatio += v.naVel * realDeltaSec * (0.8 + Math.sin(v.naVisualPhase) * 0.6);
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
      const rateH2 = frameGasH2 * invDt;
      const rateO2 = frameGasO2 * invDt;
      const rateHCl = frameGasHCl * invDt;
      const rateCl2 = frameGasCl2 * invDt;
      const rateC2H5Cl = frameGasC2H5Cl * invDt;
      const rateNH3 = frameGasNH3 * invDt;
      const rateNO2 = frameGasNO2 * invDt;
      const rateNO = frameGasNO * invDt;
      const rateSteam = frameSteam * invDt;
      const totalGasRate = rateH2 + rateO2 + rateHCl + rateCl2 + rateC2H5Cl + rateNH3 + rateNO2 + rateNO + rateSteam;

      const curSteamOpacity =
        frameBoiling
          ? 1.0
          : isDehydrating
          ? Math.max(0.65, computeSteamOpacity(v.tempK, this.environment.tempK, CONSTANTS.RELATIVE_HUMIDITY))
          : Math.max(frameSteamOpacity, computeSteamOpacity(v.tempK, this.environment.tempK, CONSTANTS.RELATIVE_HUMIDITY));
      const steamVisible = (rateSteam > 3e-5 && curSteamOpacity > 0.04) || frameBoiling || isDehydrating;

      const labels = [];
      if (rateC2H5Cl > 2e-5) labels.push('C₂H₅Cl');
      if (rateNH3 > 2e-5) labels.push('NH₃');
      if (rateNO2 > 1.5e-5) labels.push('NO₂');
      if (rateNO > 2e-5) labels.push('NO');
      if (rateH2 > 2e-5) labels.push('H₂');
      if (rateO2 > 2e-5) labels.push('O₂');
      if (rateCl2 > 2e-5) labels.push('Cl₂');
      if (rateHCl > 2e-5) labels.push('HCl(g)');
      if (steamVisible) labels.push('H₂O(g)');
      const formulaSummary = labels.slice(0, 2).join(' + ');

      if ((rateSteam > 4e-5 && curSteamOpacity > 0.12) || frameBoiling || (v.headspaceGasMoles?.H2O_g || 0) > 1e-5) {
        const targetCond = Math.min(1, 0.25 + curSteamOpacity * 0.65);
        v.wallCondenseLevel = Math.min(1, (v.wallCondenseLevel || 0) + (targetCond - (v.wallCondenseLevel || 0)) * Math.min(1, realDeltaSec * 2.5));
      } else {
        v.wallCondenseLevel = Math.max(0, (v.wallCondenseLevel || 0) - realDeltaSec * 0.14);
      }

      const visibleOutRate =
        rateH2 + rateO2 + rateHCl + rateCl2 + rateC2H5Cl + rateNH3 + rateNO2 + rateNO + (steamVisible ? rateSteam : 0);
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

      // Emit visual particle request
      if (this.visualHooks.onParticlesNeeded) {
        this.visualHooks.onParticlesNeeded(v, {
          gasRateH2: rateH2,
          gasRateO2: rateO2,
          gasRateHCl: rateHCl,
          gasRateCl2: rateCl2,
          gasRateC2H5Cl: rateC2H5Cl,
          gasRateNH3: rateNH3,
          gasRateNO2: rateNO2,
          gasRateNO: rateNO,
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
            (frameActiveMap.get('na_ethanol')?.rateMolS || 0),
        });
      }

      this.recordHistorySnapshot(v, false);
    }

    // Advance thermal exchange, Antoine condensation, gravity discharge & overflow inside all Gas Syringes
    for (const item of this.items) {
      if (item.kind !== 'gas_syringe' || item.isBroken) continue;
      for (let s = 0; s < numSteps; s++) {
        stepSyringeThermodynamics(item, dt, this.environment);
      }
      if ((item.inflowLiquidTimer || 0) > 0) {
        item.inflowLiquidTimer = Math.max(0, item.inflowLiquidTimer - realDeltaSec);
        if (item.inflowLiquidTimer === 0) item.inflowLiquidRateMlS = 0;
      }
      this.stepSyringeDischarge(item, scaledDt);
      this.stepSyringeOverflow(item, scaledDt);
      // Check Beilstein flame test when Gas Syringe directs C2H5Cl / HCl / Cl2 onto a lit burner
      if ((item.isDischarging || (item.autoDischargeTimer || 0) > 0) &&
          ((item.gasMoles?.C2H5Cl_g || 0) > 1e-7 || (item.gasMoles?.HCl_g || 0) > 1e-7 || (item.gasMoles?.Cl2_g || 0) > 1e-7)) {
        const nozzle = getSyringeNozzlePos(item);
        const hasAnyCuOnBench = this.items.some(
          (v) => v.kind === 'vessel' && !v.isShattered &&
            ((v.moles?.Cu_s || 0) > 1e-6 || (v.moles?.Cu3Zn_alpha_s || 0) > 1e-6 || (v.moles?.Cu3Zn_gamma_s || 0) > 1e-6)
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

    this.recomputeScaleReadings();
  }
}

export { computeSyringeGasVolumeMl };
