/**
 * Simulation Gravity, Support, Overflow, Shatter, Thermal & Main Tick Physics (Refactor 81).
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
import { updateMissionTelemetryOnStep } from './missionEvaluator.js';
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

import { SIM_BENCH_FLOOR_Y, STORAGE_SHELF_Y_LEVELS } from './simSnapshot.js';
import { getVesselBrimVolumeMl, moveFluidFraction, extractSyringeLiquidFraction } from './simTransfer.js';

const createEmptyGasMap = createZeroGasMap;

/**
 * Resolve floor support Y (normal lab bench floor vs 3-tier physical storage cabinet shelves).
 */
function getCabinetShelfFloorY(sim, item, halfExtY) {
  if (!sim?.isStorageCabinet) return SIM_BENCH_FLOOR_Y - halfExtY + 2;
  const bottomY = (item?.y ?? 0) + halfExtY;
  for (const shelfY of STORAGE_SHELF_Y_LEVELS) {
    if (bottomY <= shelfY + 18) {
      return shelfY - halfExtY + 2;
    }
  }
  return SIM_BENCH_FLOOR_Y - halfExtY + 2;
}

export function getSupportSurfaceForItemImpl(sim, item) {
    const spec = APPARATUS[item.typeId];
    const halfExtY = getItemRotatedHalfExtentY(spec, item);
    const floorCenterY = getCabinetShelfFloorY(sim, item, halfExtY);
    let bestCenterY = floorCenterY;
    let bestSupport = null;

    if (item.kind === 'spoon') {
      const { x: bowlX } = getProbeTipPos(item);
      for (const sup of sim.items) {
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
        const hostV = sim.getItem(item.attachedToId);
        if (hostV && !hostV.isShattered) {
          const slot = sim.getMouthSlotCoords(hostV, item.attachedSide || 'main');
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
    for (const sup of sim.items) {
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
        const candY = sup.y + getSepFunnelMountY(supSpec, spec);
        if (dx <= 28 && (alreadyOnSup || item.y <= rimTop + 40) && candY < bestCenterY) {
          bestCenterY = candY;
          bestSupport = sup;
        }
      }
    }
    return { centerY: bestCenterY, support: bestSupport };
}

export function updateSupportAttachmentsImpl(sim) {
    if (sim._updatingSupports) return;
    sim._updatingSupports = true;
    try {
      for (const it of [...sim.items]) {
      if (
        it.kind === 'scale' ||
        it.kind === 'burner' ||
        it.kind === 'stand'
      )
        continue;
      if (it.dockedVesselId || it.inVesselId || it.mountedOverElectrodeId) {
        syncDockedToolPositions(sim);
        continue;
      }
      if (it.clampedToId) {
        const stand = sim.getItem(it.clampedToId);
        if (stand && stand.kind === 'stand') {
          it.restingOnId = null;
          continue;
        }
        it.clampedToId = null;
      }

      const prevSupId = it.restingOnId;
      it.restingOnId = null;
      if (it.kind === 'vessel') it.submergedInBathId = null;
      const { centerY, support } = sim.getSupportSurfaceForItem(it);
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
              sim.ensureAttachedStopper(support.id, 'main', 'dual_hole');
            }
            syncDockedToolPositions(sim);
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
      sim.recomputeScaleReadings();
    } finally {
      sim._updatingSupports = false;
    }
}

export function recomputeScaleReadingsImpl(sim) {
    if (!sim.items.some((it) => it.kind === 'scale')) return;
    for (const sc of sim.items) {
      if (sc.kind !== 'scale') continue;
      let loadG = 0;
      for (const it of sim.items) {
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

export function checkOverflowImpl(sim, vessel) {
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
      const target = targetId ? sim.getItem(targetId) : null;
      if (!target) {
        // Hard rubber stopper without tubing: hydraulic excess pops the stopper!
        sim.popStopper(vessel, 'alertHydroOverflowPop', {
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
      sim.addLog({
        type: 'alert',
        key: 'alertOverflow',
        vesselLabel: `${spec.id} ${vessel.label}`,
      });
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('overflow', vessel, { liquidColor: visCss });
      }
    }
}

export function stepVesselOverflowImpl(sim, vessel, dt) {
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
      const target = targetId ? sim.getItem(targetId) : null;

      // Case 2: Hard stopper without tubing -> hydraulic pop when volume exceeds brim
      if (!target) {
        if (totalMl > brimMl + 0.12 && liqMl > 0.05) {
          sim.popStopper(vessel, 'alertHydroOverflowPop', { hydraulic: true });
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
            sim.addLog({ type: 'alert', key: 'alertTubeLiquidTransfer', vesselLabel: `${spec.id} ${vessel.label} → ${tSpec.id} ${target.label}` });
          }
          sim.checkOverflow(target);
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
            (cSyrBefore * (target.tempK ?? sim.environment.tempK) +
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

export function stepSyringeOverflowImpl(sim, syringe, dt) {
    if (!syringe || syringe.isBroken) return;
    const syrSpec = APPARATUS[syringe.typeId];
    const totalVolMl = computeSyringeTotalVolumeMl(syringe, sim.environment);
    const liqVolMl = computeSyringeLiquidVolumeMl(syringe, sim.environment);

    if (totalVolMl <= syrSpec.maxVolumeMl + 0.05 || liqVolMl <= 0.02) {
      syringe.overflowOutRateMlS = 0;
      syringe.wasOverflowing = false;
      return;
    }

    const excessMl = totalVolMl - syrSpec.maxVolumeMl;
    const drainMl = Math.min(liqVolMl, excessMl, (36 + excessMl * 4.5) * dt);
    const ovL = computeLiquidVolumeL(syringe.overflowMoles || {}, syringe.tempK ?? sim.environment.tempK);
    const ovMl = ovL * 1000;

    let spillColor = 'rgba(186, 230, 253, 0.85)';
    if (ovMl > 0.01) {
      const vis = computeSolutionVisuals(
        syringe.overflowMoles,
        ovL,
        computePH(syringe.overflowMoles, ovL, syringe.tempK ?? sim.environment.tempK),
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
      sim.addLog({ type: 'alert', key: 'alertSyringeOverflow', vesselLabel: syringe.label });
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('syringe_overflow', syringe, { liquidColor: spillColor });
      }
    }
}

export function shatterVesselImpl(sim, vessel, logKey, alertKind) {
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
    for (const it of sim.items) {
      if ((it.kind === 'rubber_stopper' || it.kind === 'phen_cotton') && it.attachedToId === vessel.id) {
        it.attachedToId = null;
        it.attachedSide = null;
        it.fallStartY = it.y;
      }
    }
    sim.disconnectSyringe(vessel.id);
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
    vessel.internalPressureBar = sim.environment.pressureBar;

    sim.addLog({ type: 'alert', key: logKey, vesselLabel: vessel.label });
    sim.recordHistorySnapshot(vessel, true);
    if (sim.visualHooks.onAlert) {
      sim.visualHooks.onAlert(alertKind, vessel, burstMeta);
    }
}

export function shatterSyringeImpl(sim, syringe, logKey = 'alertSyringeOverpressureShatter') {
    if (!syringe || syringe.isBroken) return;
    const sSpec = APPARATUS[syringe.typeId] || APPARATUS.gas_syringe;
    const syrT = syringe.tempK ?? sim.environment.tempK;
    const liqMl = computeSyringeLiquidVolumeMl(syringe, sim.environment);
    const combMoles = buildCombinedSyringeLiquidMoles(syringe);
    const combL = computeLiquidVolumeL(combMoles, syrT);
    const vis = combL > 1e-7
      ? computeSolutionVisuals(combMoles, combL, computePH(combMoles, combL, syrT), 2.5, syringe.overflowBleachFrac || 0)
      : null;

    if (syringe.connectedFromId) {
      sim.disconnectSyringe(syringe.connectedFromId);
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
    syringe.internalPressureBar = sim.environment.pressureBar;
    syringe.spilledPuddleColor = vis ? vis.css : null;

    sim.addLog({ type: 'alert', key: logKey, vesselLabel: syringe.label });
    if (sim.visualHooks.onAlert) {
      sim.visualHooks.onAlert('shatter', syringe, {
        hadLiquid: liqMl > 0.02,
        liquidColor: vis ? vis.css : null,
        liquidMl: liqMl,
        vesselWidth: sSpec.width * 0.72,
        vesselHeight: sSpec.height,
      });
    }
}

export function popSyringePlungerImpl(sim, vessel, syringe) {
    if (!syringe || syringe.isBroken) return;
    const syrT = syringe.tempK ?? sim.environment.tempK;
    const liqMl = computeSyringeLiquidVolumeMl(syringe, sim.environment);
    const combMoles = buildCombinedSyringeLiquidMoles(syringe);
    const combL = computeLiquidVolumeL(combMoles, syrT);
    const vis = combL > 1e-7
      ? computeSolutionVisuals(combMoles, combL, computePH(combMoles, combL, syrT), 2.5, syringe.overflowBleachFrac || 0)
      : null;

    if (vessel) {
      vessel.isStoppered = false;
      sim.disconnectSyringe(vessel.id);
      for (const g of ALL_GASES) {
        vessel.escapedGasMoles[g] = (vessel.escapedGasMoles[g] || 0) + (vessel.headspaceGasMoles[g] || 0);
        vessel.headspaceGasMoles[g] = 0;
      }
      vessel.sealedAirMoles = null;
      vessel.internalPressureBar = sim.environment.pressureBar;
    }
    syringe.gasMoles = createEmptyGasMap();
    syringe.condensedWaterMol = 0;
    syringe.condensedEtOHMol = 0;
    syringe.frozenWaterMol = 0;
    syringe.nh4clSmokeTimer = 0;
    syringe.overflowMoles = {};
    syringe.overflowBleachFrac = 0;
    syringe.internalPressureBar = sim.environment.pressureBar;

    sim.addLog({ type: 'alert', key: 'alertSyringePlungerPop', vesselLabel: syringe.label });
    if (sim.visualHooks.onAlert) {
      sim.visualHooks.onAlert('syringe_plunger_pop', syringe, {
        hadLiquid: liqMl > 0.05,
        liquidColor: vis ? vis.css : null,
        liquidMl: liqMl,
      });
    }
}

export function breakPipetteOnDropImpl(sim, pip) {
    if (!pip || pip.isBroken) return;
    const hadLiq = (pip.volumeMl || 0) > 0.02;
    const color = pip.liquidColor || 'rgba(186, 230, 253, 0.85)';
    pip.isBroken = true;
    pip.volumeMl = 0;
    pip.moles = {};
    pip.sourceLabel = '';
    pip.liquidColor = null;
    sim.addLog({ type: 'alert', key: 'alertPipetteBreak', vesselLabel: pip.label });
    if (sim.visualHooks.onAlert) {
      sim.visualHooks.onAlert('shatter', pip, {
        hadLiquid: hadLiq,
        liquidColor: color,
        liquidMl: 8,
        vesselWidth: 28,
        vesselHeight: 90,
      });
    }
}

export function breakToolOnDropImpl(sim, item) {
    if (!item || item.isBroken) return;
    const spec = APPARATUS[item.typeId] || {};
    let hadLiq = false;
    let liqMl = 0;
    let liqCol = 'rgba(186, 230, 253, 0.85)';
    if (item.moles) {
      const l = computeLiquidVolumeL(item.moles, item.tempK || sim.environment.tempK);
      liqMl = l * 1000;
      hadLiq = liqMl > 0.05;
      if (hadLiq) {
        liqCol = computeSolutionVisuals(item.moles, l, computePH(item.moles, l, item.tempK || sim.environment.tempK), 2.5, item.phenBleachFrac || 0).css;
      }
      item.moles = {};
      if (item.particleCounts) item.particleCounts = {};
      if (item.precipitateSettle) item.precipitateSettle = {};
    }
    if (item.kind === 'condenser') {
      if (item.connectedFromId) sim.disconnectSyringe(item.connectedFromId);
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
    if (item.kind === 'filter_funnel' || item.kind === 'separatory_funnel') {
      item.mountedOnVesselId = null;
      item.isFiltering = false;
      item.valveOpen = false;
      item.activeDrop = false;
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
    sim.addLog({ type: 'alert', key: 'alertToolBreak', vesselLabel: item.label });
    if (sim.visualHooks.onAlert) {
      sim.visualHooks.onAlert('shatter', item, {
        hadLiquid: hadLiq,
        liquidColor: liqCol,
        liquidMl: liqMl,
        vesselWidth: spec.width || 48,
        vesselHeight: spec.height || 90,
      });
    }
}

export function handleLandingImpactImpl(sim, item, dropDistPx, impactVy, support) {
    if (!item || item.isDragging) return;
    const spec = APPARATUS[item.typeId];
    if (!spec) return;

    // Inside Frozen Storage Shelf: zero shattering & zero drop-spill accidents
    if (sim?.isStorageCabinet) {
      if (dropDistPx >= 95) {
        item.landingTiltVel = (Math.random() < 0.5 ? -1 : 1) * 1.1;
      }
      return;
    }

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
        sim.shatterVessel(item, 'alertDropShatter', 'shatter');
      } else if (item.kind === 'gas_syringe' && !item.isBroken) {
        sim.shatterSyringe(item, 'alertSyringeDropShatter');
      } else if (item.kind === 'pipette' && !item.isBroken) {
        sim.breakPipetteOnDrop(item);
      } else if (
        !item.isBroken &&
        (item.kind === 'burette' ||
          item.kind === 'condenser' ||
          item.kind === 'salt_bridge' ||
          item.kind === 'filter_funnel' ||
          item.kind === 'separatory_funnel' ||
          item.kind === 'diffusion_tube' ||
          item.kind === 'bath')
      ) {
        sim.breakToolOnDrop(item);
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
          sim.addLog({ type: 'alert', key: 'alertDropSpill', vesselLabel: `${spec.id} ${item.label}` });
          if (sim.visualHooks.onAlert) {
            sim.visualHooks.onAlert('drop_spill', item, {
              liquidColor: vis.css,
              liquidMl: liqMl * spillFrac,
              vesselWidth: spec.width,
              vesselHeight: spec.height,
            });
          }
        } else if (item.isStoppered && dropDistPx >= 145 && liqMl > spec.maxVolumeMl * 0.85) {
          sim.popStopper(item, 'alertHydroOverflowPop', { hydraulic: true });
        }
      } else if (item.kind === 'gas_syringe' && !item.isBroken) {
        const syrLiqMl = computeSyringeLiquidVolumeMl(item, sim.environment);
        if (syrLiqMl > 0.2) {
          const syrT = item.tempK ?? sim.environment.tempK;
          const combMoles = buildCombinedSyringeLiquidMoles(item);
          const combL = computeLiquidVolumeL(combMoles, syrT);
          const vis = combL > 1e-8
            ? computeSolutionVisuals(combMoles, combL, computePH(combMoles, combL, syrT), 2.5, item.overflowBleachFrac || 0)
            : { css: 'rgba(186, 230, 253, 0.85)' };
          extractSyringeLiquidFraction(item, 0.28, null);
          item.spilledPuddleColor = vis.css;
          if (sim.visualHooks.onAlert) {
            sim.visualHooks.onAlert('drop_spill', item, {
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
        if (sim.visualHooks.onAlert) {
          sim.visualHooks.onAlert('drop_spill', item, {
            liquidColor: col,
            liquidMl: lostMl,
            vesselWidth: 26,
            vesselHeight: spec.height,
          });
        }
      }
    }
}

export function stepGravityPhysicsImpl(sim, dt, realDeltaSec) {
    const gPx = CONSTANTS.GRAVITY_PX_S2 || 1800;

    // 1. Update rotational impact wobble recovery cleanly even when resting
    for (const item of sim.items) {
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
      ...sim.items.filter((it) => it.kind === 'scale' || it.kind === 'burner' || it.kind === 'stand'),
      ...sim.items.filter((it) => it.kind !== 'scale' && it.kind !== 'burner' && it.kind !== 'stand'),
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
        const stand = sim.getItem(item.clampedToId);
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

      const { centerY, support } = sim.getSupportSurfaceForItem(item);
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
        sim.handleLandingImpact(item, landDropDist, landVy, support);
      }

      // Keep any vessel/syringe clamped to a falling Retort Stand moving locked to the stand rod!
      if (item.kind === 'stand') {
        const dyStand = item.y - prevY;
        for (const child of sim.items) {
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
            sim.handleLandingImpact(child, landDropDist * 0.9, landVy, item);
          }
        }
      }
    }
}

export function getBurnerHeatingSourceImpl(sim, vessel) {
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
      const sup = sim.getItem(vessel.restingOnId);
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
    for (const b of sim.items) {
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
    for (const spl of sim.items) {
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

export function condenseEscapedVaporInCryoImpl(sim) {
    if (sim.environment.tempK >= CONSTANTS.T_FREEZE_WATER_K) return;
    for (const v of sim.items) {
      if (v.kind !== 'vessel' || v.isShattered || !v.escapedGasMoles) continue;
      const nH2O = v.escapedGasMoles.H2O_g || 0;
      if (nH2O > 0) {
        v.escapedFrostH2OMol = (v.escapedFrostH2OMol || 0) + nH2O;
        v.escapedGasMoles.H2O_g = 0;
      }
    }
}

export function stepInvertedGravitySpillImpl(sim, v, dt) {
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
    const dst = sim.items.find((other) => {
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
      sim.checkOverflow(dst);
    } else {
      v.spilledPuddleColor = vis.css;
      if (!v._gravSpillLogged && (liqMl > 0.5 || hasSolids)) {
        v._gravSpillLogged = true;
        sim.addLog({ type: 'alert', key: 'alertGravitySpill', vesselLabel: v.label });
        if (sim.visualHooks.onAlert) {
          sim.visualHooks.onAlert('drop_spill', v, { liquidColor: vis.css, spilledMl: Math.min(40, Math.max(5, liqMl)) });
        }
      }
    }
}

export function stepAmmoniaFountainSuctionImpl(sim, v, dt) {
    v.fountainFlowMlS = 0;
    v.fountainFlowColor = null;
    if (!v || v.kind !== 'vessel' || v.isShattered || !v.isStoppered || !v.connectedTargetId) return;
    const target = sim.getItem(v.connectedTargetId);
    if (!target || target.kind !== 'vessel' || target.isShattered) return;

    const dpVac = sim.environment.pressureBar - (v.internalPressureBar ?? sim.environment.pressureBar);
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
        sim.addLog(
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
        if (sim.visualHooks.onAlert) {
          sim.visualHooks.onAlert('ammonia_fountain', v, { liquidColor: fountainVis.css });
        }
      }
    }
}

export function getBathCoolingSourceImpl(sim, vessel) {
    if (!vessel || vessel.kind !== 'vessel' || vessel.isShattered) return null;
    if (vessel.restingOnId) {
      const sup = sim.getItem(vessel.restingOnId);
      if (sup && sup.kind === 'bath' && !sup.isBroken) {
        const bSpec = APPARATUS[sup.typeId] || APPARATUS.ice_bath;
        const tBath = sup.bathTempK ?? (sup.bathMode === 'ice_salt' ? 263.15 : 273.15);
        return { bath: sup, tempK: tBath, coolingK: bSpec.coolingK || 0.56 };
      }
    }
    const vSpec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
    for (const sup of sim.items) {
      if (sup.kind !== 'bath' || sup.isBroken) continue;
      if (Math.abs(vessel.x - sup.x) <= 56 && vessel.y + vSpec.height / 2 >= sup.y - 10 && vessel.y <= sup.y + 42) {
        const bSpec = APPARATUS[sup.typeId] || APPARATUS.ice_bath;
        const tBath = sup.bathTempK ?? (sup.bathMode === 'ice_salt' ? 263.15 : 273.15);
        return { bath: sup, tempK: tBath, coolingK: bSpec.coolingK || 0.56 };
      }
    }
    return null;
}

export function stepGasFlameInteractionsImpl(sim, v, rateMap, dt) {
    if (!v || v.kind !== 'vessel' || v.isShattered || v.isStoppered) return;
    const h2Flow = (rateMap?.H2_g || 0) + ((v.tiltDeg || 0) >= 12 ? (v.headspaceGasMoles?.H2_g || 0) * 1.5 : 0);
    if (h2Flow <= 2.5e-5) return;
    if (sim.timeSec - (v._seenH2Flash ?? -99) < 3.5) return;

    const vSpec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
    const rad = ((v.tiltDeg || 0) * Math.PI) / 180;
    const dir = v.tiltDir < 0 ? -1 : 1;
    const spoutX = v.x + dir * Math.sin(rad) * (vSpec.height * 0.48 + 8);
    const spoutY = v.y - Math.cos(rad) * (vSpec.height * 0.48);
    for (const flm of sim.items) {
      const isLitBurner = flm.kind === 'burner' && (flm.powerW || 0) > 0;
      const isLitSplint = flm.kind === 'splint' && (flm.mode === 'burning' || flm.mode === 'glowing');
      if (!isLitBurner && !isLitSplint) continue;
      const fx = isLitSplint ? getProbeTipPos(flm).x : flm.x;
      const fy = isLitSplint ? getProbeTipPos(flm).y : flm.y - 26;
      const distTop = Math.hypot(v.x - fx, (v.y - vSpec.height / 2) - fy);
      const distSpout = Math.hypot(spoutX - fx, spoutY - fy);
      const dist = Math.min(distTop, distSpout);
      if (dist <= 135 && v.restingOnId !== flm.id) {
        v._seenH2Flash = sim.timeSec;
        if (v.headspaceGasMoles?.H2_g) v.headspaceGasMoles.H2_g *= 0.2;
        sim.visualHooks.onAlert?.('oxyhydrogen_detonation', { x: (spoutX + fx) * 0.5, y: (spoutY + fy) * 0.5 }, { blastScale: 0.75 });
        sim.addLog({ type: 'alert', key: 'alertGasFlashIgnition', vesselLabel: v.label });
        break;
      }
    }
}

export function stepSimulationImpl(sim, realDeltaSec, options = {}) {
    // Always animate visual pipette suction & dispense timers smoothly even while paused
    for (const item of sim.items) {
      if (item.kind !== 'pipette') continue;
      if (item.drawAnimTimer > 0) {
        item.drawAnimTimer = Math.max(0, item.drawAnimTimer - realDeltaSec);
      }
      if (item.dispenseAnimTimer > 0) {
        item.dispenseAnimTimer = Math.max(0, item.dispenseAnimTimer - realDeltaSec);
      }
    }

    if (sim.environment.paused) return;

    // Storage Shelf mode: keep real shelf gravity, clamps, mouth tools & scales live while completely freezing chemistry, thermal exchange, evaporation & spills
    if (sim.isStorageCabinet) {
      const frozenDt = Math.min(0.25, realDeltaSec * (sim.environment?.speed || 1));
      sim.stepGravityPhysics(frozenDt, realDeltaSec);
      sim.syncAttachedMouthTools();
      sim.recomputeScaleReadings?.();
      return;
    }

    sim.condenseEscapedVaporInCryo();

    const scaledDt = Math.min(0.25, realDeltaSec * sim.environment.speed);
    sim._lastStepDt = scaledDt;
    sim.timeSec += scaledDt;

    if (sim.activePourStream) {
      sim.activePourStream.timer -= realDeltaSec;
      if (sim.activePourStream.timer <= 0) sim.activePourStream = null;
    }
    if (sim.activeReagentTransfer) {
      const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - sim.activeReagentTransfer.startMs;
      if (elapsedMs >= sim.activeReagentTransfer.durationMs) {
        sim.activeReagentTransfer = null;
      }
    }
    for (const b of sim.items) {
      if (b.kind === 'burner' && (b.beilsteinTimer || 0) > 0) {
        b.beilsteinTimer = Math.max(0, b.beilsteinTimer - realDeltaSec);
      }
    }

    // Advance progressive reagent/vessel pour jobs synchronized with animations
    sim.stepTimedTransfers();

    // Sub-step for numerical accuracy & smooth fast ionic kinetics
    let numSteps = Math.max(1, Math.ceil(scaledDt / CONSTANTS.SUBSTEP_MAX_DT));
    if (options?.isBackground && options?.maxSubsteps > 0) {
      numSteps = Math.min(numSteps, options.maxSubsteps);
    }
    const dt = scaledDt / numSteps;

    // Advance rigid-body workbench gravity & landing impact physics, keeping mouth stoppers/cotton synced to wobble
    sim.stepGravityPhysics(scaledDt, realDeltaSec);
    sim.syncAttachedMouthTools();

    const getApp = (id) => sim.getItem(id);
    const curEnvSig = `${(sim.environment.tempK || CONSTANTS.T_STD_K).toFixed(2)}|${(sim.environment.pressureBar || 1).toFixed(3)}|${sim.environment.uvLight ? 1 : 0}|${sim.environment.atmosphereMode || 'air'}`;

    // Identify vessels with active transfers, funnels, burettes, circuits, or powered electrodes to prevent false sleep
    const activeWakeIds = new Set();
    for (const job of sim.timedTransfers || []) {
      if (job.sourceId) activeWakeIds.add(job.sourceId);
      if (job.targetId) activeWakeIds.add(job.targetId);
    }
    for (const it of sim.items) {
      if (it.kind === 'filter_funnel' || it.kind === 'separatory_funnel' || it.kind === 'burette') {
        if (it.filtrateTargetId) activeWakeIds.add(it.filtrateTargetId);
        if (it.mountedOnVesselId) activeWakeIds.add(it.mountedOnVesselId);
        if (it.targetVesselId) activeWakeIds.add(it.targetVesselId);
      } else if (it.kind === 'power_supply' && it.powerOn && (it.voltage || 0) > 0) {
        for (const elId of [it.posElectrodeId, it.negElectrodeId]) {
          const el = elId ? getApp(elId) : null;
          if (el?.dockedVesselId) activeWakeIds.add(el.dockedVesselId);
        }
      } else if (it.kind === 'electrode' && it.dockedVesselId) {
        activeWakeIds.add(it.dockedVesselId);
      } else if (it.kind === 'salt_bridge' && !it.isBroken) {
        if (it.vesselAId) activeWakeIds.add(it.vesselAId);
        if (it.vesselBId) activeWakeIds.add(it.vesselBId);
      } else if (it.kind === 'wash_bottle' && it.isSpraying) {
        if (it.squirtTargetId) activeWakeIds.add(it.squirtTargetId);
      }
    }
    let anyVesselActiveStep = false;

    for (const v of sim.items) {
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
          stepVesselThermodynamics(v, dt, sim.environment, 0, 0);
        }
        continue;
      }

      v.troughOverfillRate = 0;

      // Gravity spill from open inverted vessels held in air (not submerged inside water trough)
      sim.stepInvertedGravitySpill(v, scaledDt);

      // Atmospheric pressure Ammonia Fountain suction when stoppered connected flask is under vacuum
      sim.stepAmmoniaFountainSuction(v, scaledDt);

      // Buoyant retention / gravitational sinking of gases in unstoppered open vessels (relAirDensity)
      stepOpenGasBuoyancy(v, sim.environment, scaledDt);

      // Continuous gravity spillover above physical brim
      sim.stepVesselOverflow(v, scaledDt);

      // Clear expired live gas tubing hover telemetry
      if (v._liveTubeFlow && (!v.connectedTargetId || Date.now() - v._liveTubeFlow.updatedAt > 350)) {
        v._liveTubeFlow = null;
      }

      // 2D cross-section wheel-tilt pouring & invisible gas cascading onto flames
      sim.stepVesselTiltPouring(v, scaledDt);

      // Check burner power & flame level (resting directly on burner / clay triangle OR clamped/held over flame plume)
      const heatSrc = sim.getBurnerHeatingSource(v);
      const bathSrc = sim.getBathCoolingSource(v);
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
        sim.shatterVessel(v, 'alertThermalShock', 'thermal_shock');
        continue;
      }
      if ((v._lastExothermicTimer || 0) > 0) {
        v._lastExothermicTimer = Math.max(0, v._lastExothermicTimer - scaledDt);
        if (v._lastExothermicTimer === 0) v.lastExothermicJ = 0;
      }
      const burnerPowerW = heatSrc?.powerW || 0;
      const burnerFlameLevel = heatSrc?.flameLevel || 0;
      const burnerFlameTempK = heatSrc?.flameTempK || null;

      // Smart Quiescent Sleep: skip chemistry/thermo work on idle ambient vessels while auto-waking on any trigger/input
      const curMoleSig = sim._computeVesselMoleSig(v);
      const hasAmbientGap = Math.abs((v.tempK || CONSTANTS.T_STD_K) - sim.environment.tempK) > 0.15;
      const hasUnsettledPrecip = v.precipitateSettle && Object.keys(v.precipitateSettle).some((sk) => (v.moles[sk] || 0) > 0 && (v.precipitateSettle[sk] ?? 1) < 0.995);
      const hasAirExposedReactive =
        !v.isStoppered &&
        (sim.environment.atmosphereMode || 'air') === 'air' &&
        (((v.moles.Na_s || 0) > 0 && (v.naTarnishFrac || 0) < 0.99) ||
          ((v.moles.K_s || 0) > 0 && (v.kTarnishFrac || 0) < 0.99) ||
          ((v.moles.NaOH_s || 0) > 0 && (v.naohDeliquesceFrac || 0) < 0.99));
      const hasVolatileEquilib =
        ((v.moles.I2_s || 0) > 0 && (!v.isStoppered || (v.headspaceGasMoles?.I2_g || 0) < 5e-5)) ||
        ((v.moles.Br2_l || 0) > 0 && (!v.isStoppered || (v.headspaceGasMoles?.Br2_g || 0) < 2e-3));
      const mustWakeContinuously =
        burnerPowerW > 0 ||
        Boolean(bathSrc) ||
        hasAmbientGap ||
        hasUnsettledPrecip ||
        hasAirExposedReactive ||
        hasVolatileEquilib ||
        Boolean(v.isSupersaturated && v.crystallizeTriggered) ||
        Boolean(v.connectedTargetId || v.connectedFromId || v.connectedSyringeId || v.isInverted) ||
        Math.abs(v.tiltDeg || 0) > 0.5 ||
        Math.abs(v.tiltAngle || 0) > 0.01 ||
        (v.stirTimer || 0) > 0.005 ||
        (v.stirAgitation || 0) > 0.005 ||
        (v.stirIntensity || 0) > 0.005 ||
        (v.suspensionLevel || 0) > 0.005 ||
        Boolean(v.hasStirBar && (v.magStirRpm || 0) > 0) ||
        (v.soapFoamMl || 0) > 0.05 ||
        (v.pickeringFoamMl || 0) > 0.05 ||
        Boolean(v.wasBoiling) ||
        (v.wallCondenseLevel || 0) > 0.01 ||
        (v.frostOpacity || 0) > 0.01 ||
        (v.bumpingSurgeFrac || 0) > 0.01 ||
        (v.gasOutBannerTimer || 0) > 0.01 ||
        (v.tubeLiquidFlowTimer || 0) > 0.01 ||
        (v.escapedFrostH2OMol || 0) > 0 ||
        (v.overflowRateMlS || 0) > 0.05 ||
        activeWakeIds.has(v.id);
      const wokeByDiff = v._qEnvSig !== curEnvSig || v._qMoleSig !== curMoleSig;
      const mustStayAwake = mustWakeContinuously || wokeByDiff;

      if (v._quiescent && !mustStayAwake) {
        v.activeReactions = [];
        continue;
      }
      if (v._quiescent) {
        v._quiescent = false;
        v._quietTicks = 0;
      }
      const preChemActivitySig = sim._computeChemActivitySig(v);
      anyVesselActiveStep = true;
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
      const pBeforeStepBar = v.internalPressureBar ?? sim.environment.pressureBar;
      const frameActiveMap = new Map();

      // Safety Check: Heating unpurged H2 + O2 mixture inside vessel over open flame triggers oxyhydrogen pop
      if (
        sim.environment.atmosphereMode === 'air' &&
        burnerPowerW > 0 &&
        v.tempK >= 425 &&
        (v.headspaceGasMoles?.H2_g || 0) > 2.5e-5 &&
        ((v.airO2PurgeFrac ?? 1.0) > 0.14 || (v.headspaceGasMoles?.O2_g || 0) > 2.5e-5) &&
        (sim.timeSec - (v.seenReactions.unpurged_h2_pop ?? -99)) > 4.0
      ) {
        v.seenReactions.unpurged_h2_pop = sim.timeSec;
        v.headspaceGasMoles.H2_g *= 0.15;
        v.airO2PurgeFrac = 0.06;
        v.tempK = Math.min(720, v.tempK + 35);
        sim.addLog({
          type: 'alert',
          key: 'alertUnpurgedH2O2',
          vesselLabel: v.label,
        });
        if (sim.visualHooks.onAlert) {
          sim.visualHooks.onAlert('unpurged_h2', v, { liquidColor: '#f59e0b' });
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
            if ((sim.timeSec - (v.seenReactions.solvent_ignition ?? -99)) > 4.5) {
              v.seenReactions.solvent_ignition = sim.timeSec;
              sim.addLog({
                type: 'alert',
                key: 'alertSolventIgnition',
                vesselLabel: v.label,
              });
              if (sim.visualHooks.onAlert) {
                sim.visualHooks.onAlert('solvent_ignition', v, { liquidColor: '#f97316' });
              }
            }
            break;
          }
        }
      }

      const hasAlkaliOrFlash =
        (v.moles.Na_s || 0) > 1e-7 ||
        (v.moles.K_s || 0) > 1e-7 ||
        (v.naDryBurnTimer || 0) > 0.01 ||
        (v.kDryBurnTimer || 0) > 0.01 ||
        Boolean(v.naIgnited || v.kIgnited) ||
        (v.znCombustionTimer || 0) > 0 ||
        (v.mgCombustionTimer || 0) > 0 ||
        (v.alCombustionTimer || 0) > 0 ||
        (v.feSparkBurning || 0) > 0;
      const hasSteepRateOrTemp =
        (v.lastTotalRateMolS || 0) > 0.04 ||
        Math.abs(v._lastStepDeltaTK || 0) > 3.5 ||
        burnerPowerW > 120;
      const adaptiveFactor = hasAlkaliOrFlash || hasSteepRateOrTemp ? 4 : 1;
      const subDt = dt / adaptiveFactor;
      const tempBeforeSubLoop = v.tempK || CONSTANTS.T_STD_K;
      v.lastAdaptiveSubsteps = adaptiveFactor;

      for (let baseStep = 0; baseStep < numSteps; baseStep++) {
        const combinedGas = createZeroGasMap();
        let combinedSteam = 0;

        for (let sub = 0; sub < adaptiveFactor; sub++) {
          const chemRes = stepVesselChemistry(v, subDt, {
            uvLight: sim.environment.uvLight,
            environment: sim.environment,
            heatSrc,
          });
          frameRxnHeatJ += Number.isFinite(chemRes.reactionHeatJ) ? chemRes.reactionHeatJ : 0;
          const thermRes = stepVesselThermodynamics(
            v,
            subDt,
            sim.environment,
            chemRes.reactionHeatJ,
            burnerPowerW,
            burnerFlameLevel,
            burnerFlameTempK,
            bathSrc
          );
          frameFreezeMeltMol += (thermRes.freezeMeltRateMolS || 0) * subDt;
          if (Number.isFinite(thermRes.freezePointK)) {
            lastFreezePointK = thermRes.freezePointK;
          }
          const dryRes = enforceDryPhaseBoundary(v);

          for (const gId of ALL_GAS_IDS) {
            combinedGas[gId] += (chemRes.gasProduced[gId] || 0) + (dryRes.gasProduced[gId] || 0);
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
          combinedSteam += thermRes.steamProducedMol || 0;
          if (thermRes.isBoiling) frameBoiling = true;
          if ((thermRes.steamOpacity || 0) > frameSteamOpacity) {
            frameSteamOpacity = thermRes.steamOpacity;
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
            const prevHold = v._rxnHoldMap[rxn.id];
            const smoothRate = prevHold ? prevHold.emaRateMolS * 0.68 + (rxn.rateMolS || 0) * 0.32 : (rxn.rateMolS || 0);
            v._rxnHoldMap[rxn.id] = {
              rxn: { ...rxn, rateMolS: smoothRate },
              emaRateMolS: smoothRate,
              lastActiveTime: sim.timeSec,
              firstSeenTime: prevHold ? prevHold.firstSeenTime : sim.timeSec,
            };
            const lastSeen = v.seenReactions[rxn.id] ?? -99;
            if (sim.timeSec - lastSeen > 14.0) {
              const curLiqL = computeLiquidVolumeL(v.moles, v.tempK);
              const curPh = computePH(v.moles, curLiqL, v.tempK);
              const curPBar = v.internalPressureBar ?? sim.environment.pressureBar;
              const dH_kJ = rxn.dH !== undefined ? (rxn.dH * Math.max(1e-5, rxn.dXi || 0.001)) / 1000 : -frameRxnHeatJ / 1000;
              sim.addLog({
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
            v.seenReactions[rxn.id] = sim.timeSec;
          }
        }

        const gasEvents = stepVesselGasAndPressure(
          v,
          combinedGas,
          combinedSteam,
          sim.environment,
          getApp
        );

        for (const gId of ALL_GAS_IDS) {
          if (gId !== 'H2O_g') frameGas[gId] += combinedGas[gId];
        }
        frameSteam += combinedGas.H2O_g + combinedSteam;
        if (v._mn2o7HazardPending) {
          v._mn2o7HazardPending = false;
          if ((sim.timeSec - (v.seenReactions.mn2o7_hazard ?? -99)) > 4.5) {
            v.seenReactions.mn2o7_hazard = sim.timeSec;
            sim.addLog({
              type: 'alert',
              key: 'alertMn2O7Hazard',
              vesselLabel: v.label,
            });
            if (sim.visualHooks.onAlert) {
              sim.visualHooks.onAlert('oxyhydrogen_detonation', { x: v.x, y: v.y }, { blastScale: 0.65 });
            }
          }
        }
        for (const [pendingProp, seenKey, logType, logKey, cooldown] of [
          ['_soapConcAlkaliAlertPending', 'soap_conc_alkali', 'alert', 'alertSoapConcAlkaliPassivate', 6.0],
          ['_soapEarlyBrineAlertPending', 'soap_early_brine', 'alert', 'alertSoapEarlyBrine', 6.0],
          ['_soapScorchAlertPending', 'soap_scorch', 'alert', 'alertSoapScorch', 6.0],
          ['_esterOverheatAlertPending', 'ester_overheat', 'alert', 'alertEsterOverheat', 6.0],
          ['_soapCompleteAlertPending', 'soap_complete', 'info', 'alertSoapComplete', 12.0],
        ]) {
          if (v[pendingProp]) {
            v[pendingProp] = false;
            if ((sim.timeSec - (v.seenReactions[seenKey] ?? -99)) > cooldown) {
              v.seenReactions[seenKey] = sim.timeSec;
              sim.addLog({ type: logType, key: logKey, vesselLabel: v.label });
            }
          }
        }

        for (const ev of gasEvents) {
          if (ev.type === 'stopper_pop') {
            sim.popStopper(v, ev.implosion ? 'alertOverpressurePop' : 'alertOverpressurePop');
          } else if (ev.type === 'crucible_lid_pop') {
            sim.playFx?.('pop');
            sim.addLog({
              type: 'alert',
              key: 'alertCrucibleLidPop',
              vesselLabel: v.label,
            });
          } else if (ev.type === 'shatter') {
            sim.shatterVessel(
              v,
              ev.implosion ? 'alertVacuumImplosion' : 'alertOverpressureShatter',
              'shatter'
            );
            break;
          } else if (ev.type === 'syringe_shatter') {
            const badSyr = sim.getItem(ev.syringeId);
            if (badSyr) sim.shatterSyringe(badSyr, 'alertSyringeOverpressureShatter');
          } else if (ev.type === 'syringe_plunger_pop') {
            const badSyr = sim.getItem(ev.syringeId);
            if (badSyr) sim.popSyringePlunger(v, badSyr);
          }
        }
        if (v.isShattered) break;
      }
      v._lastStepDeltaTK = (v.tempK || tempBeforeSubLoop) - tempBeforeSubLoop;

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
          sim.addLog({ type: 'info', key: 'alertSilverMirrorFormed', vesselLabel: v.label });
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
          sim.addLog({ type: 'info', key: 'alertSilverMirrorCleaned', vesselLabel: v.label });
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
        : sim.environment.pressureBar;
      v.pickeringFoamMl = Number.isFinite(v.pickeringFoamMl || 0) ? Math.max(0, v.pickeringFoamMl || 0) : 0;
      v.soapFoamMl = Number.isFinite(v.soapFoamMl || 0) ? Math.max(0, Math.min(200, v.soapFoamMl || 0)) : 0;
      v.soapScorchFrac = Number.isFinite(v.soapScorchFrac || 0) ? Math.max(0, Math.min(1, v.soapScorchFrac || 0)) : 0;
      v.esterOverheatFrac = Number.isFinite(v.esterOverheatFrac || 0) ? Math.max(0, Math.min(1, v.esterOverheatFrac || 0)) : 0;
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
          sim.shatterVessel(v, 'alertGlassSoftenMelt', 'shatter');
          continue;
        }
      } else {
        v.softenGlowFrac = Math.max(0, Math.min(0.45, (v.tempK - 760) / 420));
        if (specV.breakable !== false && v.tempK >= (specV.maxThermalStressK || 783)) {
          sim.shatterVessel(v, 'alertThermalShock', 'thermal_shock');
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
          const catchV = sim.items.find(
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
              if (prevIrrev < 0.25 && v.phenIrrevFrac >= 0.25 && (sim.timeSec - (v.seenReactions.phen_cc_cleavage ?? -99)) > 6.0) {
                v.seenReactions.phen_cc_cleavage = sim.timeSec;
                sim.addLog({
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
                if (prevIrrevOx < 0.35 && v.phenIrrevFrac >= 0.35 && (sim.timeSec - (v.seenReactions.phen_h2o2_bleach ?? -99)) > 6.0) {
                  v.seenReactions.phen_h2o2_bleach = sim.timeSec;
                  sim.addLog({
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
        const desTgt = sim.getItem(v.connectedTargetId);
        if (desTgt && desTgt.kind === 'vessel' && !desTgt.isShattered && desTgt.moles && (desTgt.moles.NaOH_s || 0) > 1e-4 && (desTgt.moles.H2O_l || 0) < 0.08) {
          const dDry = Math.min(v.moles.CuSO4_5H2O_s, 0.008 * scaledDt);
          if (dDry > 1e-11) {
            v.moles.CuSO4_5H2O_s -= dDry;
            if (v.moles.CuSO4_5H2O_s < 1e-13) delete v.moles.CuSO4_5H2O_s;
            v.moles.CuSO4_s = (v.moles.CuSO4_s || 0) + dDry;
            desTgt.moles.H2O_l = (desTgt.moles.H2O_l || 0) + 5 * dDry;
            if ((sim.timeSec - (v.seenReactions.desiccant_dehydrate ?? -99)) > 8.0) {
              v.seenReactions.desiccant_dehydrate = sim.timeSec;
              sim.addLog({
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
          if ((sim.timeSec - (v.seenReactions.beilstein_test ?? -99)) > 5.0) {
            v.seenReactions.beilstein_test = sim.timeSec;
            sim.addLog({
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

      if (sim.environment.tempK >= CONSTANTS.T_FREEZE_WATER_K && (v.escapedFrostH2OMol || 0) > 0) {
        const dSubl = Math.min(v.escapedFrostH2OMol, 0.02 * scaledDt);
        v.escapedFrostH2OMol -= dSubl;
        if (v.escapedFrostH2OMol < 1e-9) v.escapedFrostH2OMol = 0;
        v.escapedGasMoles.H2O_g = (v.escapedGasMoles.H2O_g || 0) + dSubl;
      }

      // Assemble jitter-free debounced active reactions list (holds brief pauses up to 1.25s without flickering)
      if (!v._rxnHoldMap || typeof v._rxnHoldMap.entries === 'function') v._rxnHoldMap = {};
      const dispRxns = [];
      for (const [id, entry] of Object.entries(v._rxnHoldMap)) {
        const ageSec = sim.timeSec - entry.lastActiveTime;
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
        (sim.timeSec - (v.seenReactions.zn_burn_o2_alert ?? -99)) > 5.0 &&
        getVesselEffectiveO2Bar(v, sim.environment) >= 0.45
      ) {
        v.seenReactions.zn_burn_o2_alert = sim.timeSec;
        sim.addLog({ type: 'alert', key: 'alertZnCombustionO2', vesselLabel: v.label });
        if (sim.visualHooks.onAlert) {
          sim.visualHooks.onAlert('zn_burn_o2', v, {});
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
          if (sim.visualHooks.onAlert) {
            sim.visualHooks.onAlert('o2_relight', { x: v.x, y: v.y - 12 }, { vesselId: v.id });
          }
        } else {
          const alertKey = hazardHit ? 'alertNaHazardExplosion' : 'alertNaExplosion';
          sim.shatterVessel(v, alertKey, 'explosion');
          continue;
        }
      }

      v.wasBoiling = frameBoiling;

      // Prompt 71: Boiling bumping suppression via porous Boiling Chips (đá bọt) or active magnetic stirring
      const hasAntiBump = Boolean(v.hasBoilingChips) || (Boolean(v.hasStirBar) && (v.magStirRpm || 0) > 0);
      const isOrganicOrTestTube =
        v.typeId === 'test_tube_50' ||
        (v.moles.H2SO4_l || 0) > 1e-4 ||
        (v.moles.C2H5OH_l || 0) > 1e-3 ||
        (v.moles.CH3COOH_l || 0) > 1e-3 ||
        (v.moles.CH3COOC2H5_l || 0) > 1e-3 ||
        (v.moles.C5H11OH_l || 0) > 1e-3;
      if (!v.isFrozenSolid && !v.isShattered && frameBoiling && burnerPowerW > 0 && !hasAntiBump && (isOrganicOrTestTube || (v.stirTimer || 0) > 0.25)) {
        v.bumpingSurgeFrac = Math.min(1, (v.bumpingSurgeFrac || 0) + 0.35 * realDeltaSec);
        if (Math.random() < Math.min(0.45, 0.25 * realDeltaSec * 5) || v.bumpingSurgeFrac > 0.35) {
          applySurfaceImpulse(v, 0.72, (Math.random() - 0.5) * 0.28);
          if ((sim.timeSec - (v.seenReactions.boiling_bumping ?? -99)) > 8.0) {
            v.seenReactions.boiling_bumping = sim.timeSec;
            sim.addLog({ type: 'alert', key: 'alertBoilingBumping', vesselLabel: v.label });
          }
        }
      } else {
        v.bumpingSurgeFrac = Math.max(0, (v.bumpingSurgeFrac || 0) - 1.5 * realDeltaSec);
      }

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
          ? Math.max(0.65, computeSteamOpacity(v.tempK, sim.environment.tempK, CONSTANTS.RELATIVE_HUMIDITY))
          : Math.max(frameSteamOpacity, computeSteamOpacity(v.tempK, sim.environment.tempK, CONSTANTS.RELATIVE_HUMIDITY));
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
      const envSubzeroK = Math.max(0, CONSTANTS.T_FREEZE_WATER_K - sim.environment.tempK);
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
      sim.stepGasFlameInteractions(v, rateMap, scaledDt);
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
          if (v._lastLoggedPhenState && v._lastLoggedPhenState !== phenStateNow && (sim.timeSec - (v._lastPhenLogSec ?? -99)) > 1.5) {
            v._lastPhenLogSec = sim.timeSec;
            sim.addLog({
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
        atmosphereMode: sim.environment.atmosphereMode || 'air',
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
      if (sim.visualHooks.onParticlesNeeded) {
        sim.visualHooks.onParticlesNeeded(v, visMetrics);
      }

      sim.recordHistorySnapshot(v, false);

      const postMoleSig = sim._computeVesselMoleSig(v);
      const postChemActivitySig = sim._computeChemActivitySig(v);
      v._qMoleSig = postMoleSig;
      v._qEnvSig = curEnvSig;

      const isEmptyVessel = Object.keys(v.moles).length === 0 && Object.keys(v.headspaceGasMoles || {}).length === 0;
      const isCalmState =
        !mustWakeContinuously &&
        preChemActivitySig === postChemActivitySig &&
        frameActiveMap.size === 0 &&
        (v.lastTotalRateMolS || 0) < 1e-11 &&
        Math.abs(v._lastStepDeltaTK || 0) < 0.02 &&
        Math.abs((v.waveAmp || 0)) < 0.02 &&
        Math.abs((v.waveVel || 0)) < 0.02 &&
        Object.keys(v._rxnHoldMap || {}).length === 0;
      if (isCalmState || isEmptyVessel) {
        if (isCalmState) {
          v._quietTicks = (v._quietTicks || 0) + 1;
          if (v._quietTicks >= (isEmptyVessel ? 2 : 3)) {
            v._quiescent = true;
          }
        }
      } else {
        v._quietTicks = 0;
      }
    }
    if (anyVesselActiveStep) {
      sim._dirtySeq = (sim._dirtySeq || 0) + 1;
    }

    // Step wheel-tilt pouring & falling spills for filter funnels & spoons, plus expire electrode tube telemetry
    const nowFlowMs = Date.now();
    for (const tool of sim.items) {
      if ((tool.kind === 'filter_funnel' || tool.kind === 'spoon') && !tool.isBroken) {
        sim.stepVesselTiltPouring(tool, scaledDt);
      } else if (tool.kind === 'electrode' && tool._liveTubeFlow && (!tool.gasTargetId || nowFlowMs - tool._liveTubeFlow.updatedAt > 450)) {
        tool._liveTubeFlow = null;
      }
    }

    // Gas-phase NH3(g) + HCl(g) -> NH4Cl(s) dense white smoke between adjacent open vessels
    sim.lastWhiteSmokePairs = [];
    const openVessels = sim.items.filter((v) => v.kind === 'vessel' && !v.isShattered && !v.isStoppered);
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
          sim.lastWhiteSmokePairs.push({ aId: a.id, bId: b.id, x: mx, y: my, intensity });
          a.nh4clFrostLevel = Math.min(1.0, (a.nh4clFrostLevel || 0) + 0.03 * realDeltaSec);
          b.nh4clFrostLevel = Math.min(1.0, (b.nh4clFrostLevel || 0) + 0.03 * realDeltaSec);
          if (sim.visualHooks.onAlert) {
            sim.visualHooks.onAlert('nh3_hcl_smoke', { x: mx, y: my }, { intensity });
          }
          const smokeKey = `smoke_${Math.min(a.id, b.id)}_${Math.max(a.id, b.id)}`;
          sim._seenSmokeLog = sim._seenSmokeLog || {};
          if (sim.timeSec - (sim._seenSmokeLog[smokeKey] ?? -99) > 10.0) {
            sim._seenSmokeLog[smokeKey] = sim.timeSec;
            sim.addLog({
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
    for (const item of sim.items) {
      if (item.kind !== 'gas_syringe' || item.isBroken) continue;
      item.lastNH4ClRxnFlag = false;
      for (let s = 0; s < numSteps; s++) {
        stepSyringeThermodynamics(item, dt, sim.environment);
      }
      if ((item.nh4clSmokeTimer || 0) > 0) {
        item.nh4clSmokeTimer = Math.max(0, item.nh4clSmokeTimer - realDeltaSec);
      }
      if (item.lastNH4ClRxnFlag) {
        sim._seenSyrNH4Cl = sim._seenSyrNH4Cl || {};
        if (sim.timeSec - (sim._seenSyrNH4Cl[item.id] ?? -99) > 6.0) {
          sim._seenSyrNH4Cl[item.id] = sim.timeSec;
          sim.addLog({
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
      const syrT = item.tempK ?? sim.environment.tempK;
      const envSubzeroSyr = Math.max(0, CONSTANTS.T_FREEZE_WATER_K - sim.environment.tempK);
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
      sim.stepSyringeDischarge(item, scaledDt);
      sim.stepSyringeOverflow(item, scaledDt);
      // Check Beilstein flame test when Gas Syringe directs any halogen vapor onto a lit burner
      const hasSyrHalogen = Object.entries(item.gasMoles || {}).some(
        ([id, n]) => n > 1e-7 && SPECIES[id]?.isHalogenVapor
      );
      if ((item.isDischarging || (item.autoDischargeTimer || 0) > 0) && hasSyrHalogen) {
        const nozzle = getSyringeNozzlePos(item);
        const hasAnyCuOnBench = sim.items.some(
          (v) =>
            v.kind === 'vessel' &&
            !v.isShattered &&
            Object.entries(v.moles || {}).some(([id, n]) => n > 1e-6 && SPECIES[id]?.isCopperMetal)
        );
        if (hasAnyCuOnBench) {
          for (const b of sim.items) {
            if (b.kind === 'burner' && (b.powerW || 0) > 0 && Math.abs(nozzle.x - b.x) <= 125 && nozzle.y <= b.y + 40) {
              b.beilsteinTimer = 2.0;
            }
          }
        }
      }
      if (sim.visualHooks.onParticlesNeeded && ((item.inflowLiquidTimer || 0) > 0 || (item.overflowOutRateMlS || 0) > 0.5)) {
        sim.visualHooks.onParticlesNeeded(item, {
          inflowLiquidRateMlS: item.inflowLiquidRateMlS || 0,
          inflowLiquidColor: item.inflowLiquidColor || null,
          overflowOutRateMlS: item.overflowOutRateMlS || 0,
          overflowOutColor: item.overflowOutColor || null,
        });
      }
    }

    sim.stepSpoonAnimations(realDeltaSec);
    stepApparatusTools(sim, scaledDt, realDeltaSec);
    sim.syncAttachedMouthTools();
    stepElectrochemistry(sim, scaledDt);

    if (sim.visualHooks.onParticlesNeeded) {
      for (const item of sim.items) {
        if (item.kind === 'filter_funnel' && item.isFiltering) {
          sim.visualHooks.onParticlesNeeded(item, { rateMlS: item.filtrateRateMlS, color: item.filtrateColor });
        } else if (item.kind === 'separatory_funnel' && item.activeDrop) {
          sim.visualHooks.onParticlesNeeded(item, { rateMlS: item.drainRateMlS, color: item.drainColor });
        } else if (item.kind === 'burette' && item.streamingNow) {
          sim.visualHooks.onParticlesNeeded(item, { rateMlS: item.valveRateMlS, color: item.streamColor });
        } else if (item.kind === 'condenser' && item.activeDrop) {
          sim.visualHooks.onParticlesNeeded(item, { rateMlS: item.distillRateMlS, color: item.lastCondColor });
        } else if (item.kind === 'electrode' && item.gasBubbleType && (item.gasBubbleRate || 0) > 1e-7) {
          sim.visualHooks.onParticlesNeeded(item, { gasId: item.gasBubbleType, rateMolS: item.gasBubbleRate });
        } else if (item.kind === 'vessel' && (item.troughOverfillRate || 0) > 1e-4) {
          sim.visualHooks.onParticlesNeeded(item, { troughOverfillRate: item.troughOverfillRate, troughOverfillX: item.troughOverfillX });
        } else if (item.kind === 'wash_bottle' && ((item.squirtTimer || 0) > 0 || item.isSpraying) && item.squirtArc) {
          sim.visualHooks.onParticlesNeeded(item, { squirtArc: item.squirtArc, activeSpray: true });
        }
      }
    }

    sim.recomputeScaleReadings();
    updateMissionTelemetryOnStep(sim);
}

