/**
 * Simulation Snapshot, History & Reactivity Signature Helpers (Refactor 81).
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


export const SIM_BENCH_FLOOR_Y = 482;

export function exportPositionSnapshotForSim(sim) {
    return {
      type: 'positions',
      items: sim.items.map((it) => ({
        id: it.id,
        x: it.x,
        y: it.y,
        restingOnId: it.restingOnId ?? null,
        clampedToId: it.clampedToId ?? null,
        dockedVesselId: it.dockedVesselId ?? null,
        dockSide: it.dockSide ?? null,
        mountedOnVesselId: it.mountedOnVesselId ?? null,
        inVesselId: it.inVesselId ?? null,
        attachedToId: it.attachedToId ?? null,
        attachedSide: it.attachedSide ?? null,
        fallStartY: it.fallStartY ?? null,
        tiltAngle: it.tiltAngle ?? 0,
        tiltDeg: it.tiltDeg ?? 0,
        tiltDir: it.tiltDir ?? 1,
      })),
    };
}

export function exportSnapshotForSim(sim) {
    const cleanItems = sim.items.map((it) => {
      const copy = JSON.parse(JSON.stringify(it));
      if (Array.isArray(copy.history) && copy.history.length > 8) {
        copy.history = copy.history.slice(-8);
      }
      return copy;
    });
    return {
      timeSec: sim.timeSec,
      nextId: sim.nextId,
      environment: { ...sim.environment },
      items: cleanItems,
      selectedId: sim.selectedId,
      selectedIds: Array.from(sim.selectedIds || []),
      compareVesselIds: Array.isArray(sim.compareVesselIds) ? [...sim.compareVesselIds] : [],
      pipette: JSON.parse(JSON.stringify(sim.pipette)),
      logs: JSON.parse(JSON.stringify(sim.logs.slice(0, 12))),
      missionState: sim.missionState ? JSON.parse(JSON.stringify(sim.missionState)) : null,
      missionTelemetry: sim.missionTelemetry ? JSON.parse(JSON.stringify(sim.missionTelemetry)) : null,
    };
}

export function restoreSnapshotForSim(sim, snap) {
    if (!snap) return false;
    if (snap.type === 'positions') {
      for (const saved of snap.items || []) {
        const it = sim.getItem(saved.id);
        if (!it) continue;
        it.x = saved.x;
        it.y = saved.y;
        it.vy = 0;
        it.isDragging = false;
        it.restingOnId = saved.restingOnId;
        it.clampedToId = saved.clampedToId;
        it.dockedVesselId = saved.dockedVesselId;
        if (saved.dockSide !== undefined) it.dockSide = saved.dockSide;
        it.mountedOnVesselId = saved.mountedOnVesselId;
        it.inVesselId = saved.inVesselId;
        it.attachedToId = saved.attachedToId;
        if (saved.attachedSide !== undefined) it.attachedSide = saved.attachedSide;
        it.fallStartY = saved.fallStartY;
        it.tiltAngle = saved.tiltAngle;
        it.tiltDeg = saved.tiltDeg;
        it.tiltDir = saved.tiltDir;
      }
      sim.activePourStream = null;
      sim.updateSupportAttachments();
      sim.recomputeScaleReadings();
      sim.emitChange();
      return true;
    }
    sim.timeSec = snap.timeSec ?? 0;
    sim.nextId = snap.nextId ?? 1;
    if (snap.environment) {
      sim.environment = JSON.parse(JSON.stringify(snap.environment));
    }
    sim.items = Array.isArray(snap.items) ? JSON.parse(JSON.stringify(snap.items)) : [];
    for (const it of sim.items) {
      it.isDragging = false;
      it.tiltAngle = 0;
      it.hoveredActionLabel = null;
    }
    sim.selectedId = snap.selectedId || null;
    sim.selectedIds = new Set(Array.isArray(snap.selectedIds) ? snap.selectedIds : sim.selectedId ? [sim.selectedId] : []);
    sim.compareVesselIds = Array.isArray(snap.compareVesselIds) ? [...snap.compareVesselIds] : [];
    if (snap.pipette) {
      sim.pipette = JSON.parse(JSON.stringify(snap.pipette));
    }
    if (Array.isArray(snap.logs)) {
      sim.logs = JSON.parse(JSON.stringify(snap.logs));
    }
    if ('missionState' in snap) {
      sim.missionState = snap.missionState ? JSON.parse(JSON.stringify(snap.missionState)) : null;
    }
    if ('missionTelemetry' in snap && snap.missionTelemetry) {
      sim.missionTelemetry = JSON.parse(JSON.stringify(snap.missionTelemetry));
    }
    sim.activePourStream = null;
    sim.activeReagentTransfer = null;
    sim.timedTransfers = [];
    sim.updateSupportAttachments();
    sim.recomputeScaleReadings();
    sim.emitChange();
    return true;
}

export function computeVesselMoleSigForVessel(sim, v) {
    if (!v) return '';
    let mCnt = 0;
    let mSum = 0;
    for (const k in v.moles) {
      const val = v.moles[k];
      if (val > 0) {
        mCnt++;
        mSum += val;
      }
    }
    let gCnt = 0;
    let gSum = 0;
    if (v.headspaceGasMoles) {
      for (const k in v.headspaceGasMoles) {
        const val = v.headspaceGasMoles[k];
        if (val > 0) {
          gCnt++;
          gSum += val;
        }
      }
    }
    return `${mCnt}:${mSum.toFixed(7)}|${gCnt}:${gSum.toFixed(7)}|${v.isStoppered ? 1 : 0}|${v.lidState || ''}|${v.hasStirBar ? 1 : 0}:${v.magStirRpm || 0}`;
}

export function computeChemActivitySigForVessel(sim, v) {
    if (!v) return '';
    let w = 0;
    for (const k in v.moles) {
      if (k === 'H2O_l') continue;
      const val = v.moles[k];
      if (val > 0) {
        const len = k.length;
        w += val * (len * 13 + k.charCodeAt(0) + k.charCodeAt(len - 1) * 7);
      }
    }
    return `${w.toFixed(6)}|${(v.naTarnishFrac || 0).toFixed(4)}|${(v.kTarnishFrac || 0).toFixed(4)}|${(v.naohDeliquesceFrac || 0).toFixed(4)}`;
}

export function recordHistorySnapshotForVessel(sim, vessel, force = false) {
    if (!vessel || !Array.isArray(vessel.history) || vessel.kind !== 'vessel') return;
    const last = vessel.history[vessel.history.length - 1];
    if (!force && last && sim.timeSec - last.t < 0.25) return;

    // Record key tracked species moles (mmol) for live chart
    const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
    const ph = computePH(vessel.moles, liqL, vessel.tempK);
    const snap = {};
    for (const [spId, n] of Object.entries(vessel.moles)) {
      if (n > 1e-7) snap[spId] = n;
    }
    // Track total permanent/acidic gases generated (escaped + syringe + headspace)
    const syr = vessel.connectedSyringeId ? sim.getItem(vessel.connectedSyringeId) : null;
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
      t: sim.timeSec,
      moles: snap,
      tempK: vessel.tempK,
      ph,
      pressureBar: vessel.internalPressureBar ?? sim.environment.pressureBar,
      liqL,
      rateMolS: vessel.lastTotalRateMolS || 0,
      cumGasMol: vessel.cumulativeGasMol || 0,
      solidMassG,
    });
    if (vessel.history.length > 140) {
      vessel.history.shift();
    }
}

