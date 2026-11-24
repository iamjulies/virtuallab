/**
 * Workbench Pointer, Touch, Drag/Drop, Wheel & Pour Input Controller (Refactor 81).
 */
import {
  APPARATUS,
  clampItemToStandY,
  getCondenserPorts,
  getItemRotatedHalfExtentY,
  getProbeTipPos,
  getSepFunnelMountY,
  getStandGeometry,
  getSyringeGeometry,
  getTubeDestTipPos,
  getVesselEndPorts,
  getVesselTubingPort,
} from '../data/apparatus.js';
import { CONSTANTS } from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { computeLiquidVolumeL, computePH, computeSolutionVisuals } from '../engine/equilibrium.js';
import {
  buildRigidTubePoints,
  computeCondenserOutletGeometry,
  computeSyringeDischargeArc,
  computeSyringeLiquidVolumeMl,
  computeTubingGeometry,
} from '../engine/gasNetwork.js';
import {
  checkFlameLoopInteractions,
  checkIndicatorStripInteractions,
  checkSplintInteractions,
  checkThermometerInteractions,
  computeWashBottleStreamArc,
  syncDockedToolPositions,
} from '../engine/apparatusTools.js';
import { stepAnalyticalInstruments } from '../engine/analyticalTools.js';
import { renderActiveReagentTransfer } from './reagentRenderer.js';
import { soundEngine } from '../audio/soundEngine.js';
import { FluidGasOverlay } from './fluidGasOverlay.js';
import {
  beginCanvasLabelFrame,
  flushCanvasLabelFrame,
  formatCanvasText,
  renderBurner,
  renderGasSyringe,
  renderPipette,
  renderRetortClampJaw,
  renderRetortStand,
  renderScale,
  renderTubingConnections,
  renderVessel,
  setCurrentLabelItemId,
} from './vesselRenderer.js';
import {
  renderBurette,
  renderDcPowerAndWires,
  renderDiffusionTube,
  renderElectrodeCollectorTubes,
  renderElectrodeRod,
  renderFilterFunnel,
  renderFlameLoop,
  renderIceBath,
  renderIndicatorStrip,
  renderIronSpoon,
  renderLiebigCondenser,
  renderPhenCotton,
  renderPhConductometer,
  renderColorimeter,
  renderTlcPlate,
  renderRubberStopper,
  renderSaltBridge,
  renderSeparatoryFunnel,
  renderSplint,
  renderStirBar,
  renderBoilingChips,
  renderThermometer,
  renderVoltAmmeterAndWires,
  renderWashBottle,
} from './toolRenderer.js';


export const BENCH_LOGICAL_W = 1000;
export const BENCH_LOGICAL_H = 560;
export const BENCH_FLOOR_Y = 482;

export function handleCanvasWheelImpl(wb, pt, deltaY, shiftKey = false) {
    const heldItem = wb.dragState ? wb.sim.getItem(wb.dragState.itemId) : null;
    const hit = heldItem || wb.hitTestItem(pt.x, pt.y);
    if (!hit) {
      if (!wb.dragState) wb.resetWheelTiltedVessel(null);
      return false;
    }
    if (!wb.dragState && wb._wheelTiltVesselId && wb._wheelTiltVesselId !== hit.id) {
      wb.resetWheelTiltedVessel(hit.id);
    }

    const clamp = (lo, hi, val) => Math.max(lo, Math.min(hi, val));
    const stepDiscrete = (key, dy, cb) => {
      if (wb._wheelAccum.key !== key) wb._wheelAccum = { key, sum: 0 };
      wb._wheelAccum.sum += dy;
      if (Math.abs(wb._wheelAccum.sum) < 80) return true;
      const dir = wb._wheelAccum.sum > 0 ? 1 : -1;
      wb._wheelAccum.sum = 0;
      cb(dir);
      return true;
    };

    if (hit.kind === 'bath') {
      return stepDiscrete(`bath:${hit.id}`, deltaY, (dir) => {
        soundEngine.playUiClick();
        const steps = APPARATUS.ice_bath?.bathTempSteps || [-20, -10, 0, 10, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200];
        const curC = hit.bathTargetC ?? (hit.bathMode === 'ice_salt' ? -10 : 0);
        let idx = steps.indexOf(curC);
        if (idx < 0) {
          idx = steps.reduce((best, v, i) => (Math.abs(v - curC) < Math.abs(steps[best] - curC) ? i : best), 0);
        }
        // Scroll up (deltaY < 0, dir < 0) increases temperature; scroll down decreases
        const nextIdx = Math.max(0, Math.min(steps.length - 1, idx + (dir < 0 ? 1 : -1)));
        wb.sim.setBathTargetTempC(hit.id, steps[nextIdx]);
      });
    }

    if (hit.kind === 'electrode') {
      return stepDiscrete(`el:${hit.id}`, deltaY, (dir) => {
        const order = ['C', 'Cu', 'Zn'];
        const curIdx = Math.max(0, order.indexOf(hit.material));
        const nextMat = order[(curIdx + (dir > 0 ? 1 : order.length - 1)) % order.length];
        soundEngine.playUiClick();
        wb.sim.setElectrodeMaterial(hit.id, nextMat);
      });
    }

    if (hit.kind === 'volt_ammeter') {
      return stepDiscrete(`vm:${hit.id}`, deltaY, (dir) => {
        const modes = ['voltmeter', 'ammeter', 'short'];
        const curIdx = Math.max(0, modes.indexOf(hit.mode));
        const nextMode = modes[(curIdx + (dir > 0 ? 1 : modes.length - 1)) % modes.length];
        soundEngine.playUiClick();
        wb.sim.setVoltAmmeterState(hit.id, { mode: nextMode });
      });
    }

    if (hit.kind === 'stir_bar') {
      if (!hit.inVesselId) return false;
      const host = wb.sim.getItem(hit.inVesselId);
      const curRpm = host?.magStirRpm || 0;
      const nextRpm = clamp(0, 1200, curRpm + (deltaY < 0 ? 100 : -100));
      wb.sim.toggleMagneticStir(hit.inVesselId, nextRpm);
      return true;
    }

    if (hit.kind === 'dc_power') {
      if (shiftKey) {
        const curR = hit.rheostatOhm ?? 2.0;
        const nextR = Math.round(clamp(0.5, 25, curR + (deltaY < 0 ? 0.5 : -0.5)) * 2) / 2;
        wb.sim.setDcPowerState(hit.id, { rheostatOhm: nextR });
      } else {
        const curV = hit.voltageV ?? 6;
        const nextV = Math.round(clamp(0, 12, curV + (deltaY < 0 ? 0.5 : -0.5)) * 2) / 2;
        wb.sim.setDcPowerState(hit.id, { voltageV: nextV });
      }
      return true;
    }

    if (hit.kind === 'stand') {
      if (shiftKey) {
        return stepDiscrete(`stand-flip:${hit.id}`, deltaY, () => {
          soundEngine.playUiClick();
          wb.sim.flipItemLR(hit.id);
        });
      }
      const curExt = hit.extendPx || 0;
      const nextExt = clamp(0, 200, Math.round(curExt + (deltaY < 0 ? 10 : -10)));
      wb.sim.setStandExtension(hit.id, nextExt);
      return true;
    }

    if (hit.kind === 'wash_bottle') {
      if (shiftKey) {
        return stepDiscrete(`wb-flip:${hit.id}`, deltaY, () => {
          soundEngine.playUiClick();
          wb.sim.flipItemLR(hit.id);
        });
      }
      const nextAng = clamp(-45, 45, Math.round((hit.sprayAngleDeg || 0) + (deltaY > 0 ? 5 : -5)));
      wb.sim.setWashBottleAngle(hit.id, nextAng);
      return true;
    }

    if (hit.kind === 'condenser') {
      if (shiftKey) {
        return stepDiscrete(`cond-water:${hit.id}`, deltaY, () => {
          soundEngine.playUiClick();
          hit.waterFlowOn = !hit.waterFlowOn;
          wb.sim.emitChange();
        });
      }
      const nextRot = clamp(-45, 45, Math.round((hit.rotationDeg || 0) + (deltaY > 0 ? 5 : -5)));
      wb.sim.setCondenserRotation(hit.id, nextRot);
      // Keep rotated Liebig condenser above bench floor cleanly
      const cSpec = APPARATUS[hit.typeId] || APPARATUS.liebig_condenser;
      const maxCY = BENCH_FLOOR_Y - getItemRotatedHalfExtentY(cSpec, hit) + 2;
      if (hit.y > maxCY) {
        hit.y = maxCY;
        wb.sim.emitChange();
      }
      return true;
    }

    if (hit.kind === 'burette') {
      const curRate = hit.valveRateMlS || 0;
      const nextRate = Math.round(clamp(0, 5.0, curRate + (deltaY > 0 ? 0.25 : -0.25)) * 100) / 100;
      wb.sim.setBuretteValveRate(hit.id, nextRate);
      return true;
    }

    if (hit.kind === 'splint') {
      return stepDiscrete(`splint-mode:${hit.id}`, deltaY, (dir) => {
        const order = ['unlit', 'glowing', 'burning'];
        const curIdx = Math.max(0, order.indexOf(hit.mode || 'unlit'));
        hit.mode = order[(curIdx + (dir > 0 ? 1 : order.length - 1)) % order.length];
        soundEngine.playUiClick();
        wb.sim.emitChange();
      });
    }

    if (hit.kind === 'indicator_strip') {
      return stepDiscrete(`strip:${hit.id}:${shiftKey ? 's' : 'n'}`, deltaY, () => {
        soundEngine.playUiClick();
        if (shiftKey) {
          // Swap for fresh indicator strip
          hit.sampledPH = null;
          hit.tipColor = hit.stripKind === 'universal' ? '#eab308' : '#8b5cf6';
          hit.isBleached = false;
          hit.sampledFrom = '';
          wb.sim.emitChange();
        } else {
          wb.sim.flipItemLR(hit.id);
        }
      });
    }

    if (hit.kind === 'phen_cotton') {
      return stepDiscrete(`cotton-refresh:${hit.id}`, deltaY, () => {
        soundEngine.playUiClick();
        hit.pinkLevel = 0;
        hit.dampness = 0.85;
        if (hit.attachedToId) {
          const hv = wb.sim.getItem(hit.attachedToId);
          if (hv) {
            if (hit.attachedSide === 'left') hv.phenCottonLeftLevel = 0;
            else if (hit.attachedSide === 'right') hv.phenCottonRightLevel = 0;
            else hv.phenCottonLevel = 0;
          }
        }
        wb.sim.emitChange();
      });
    }

    if (hit.kind === 'rubber_stopper') {
      return stepDiscrete(`stopper-mode:${hit.id}`, deltaY, (dir) => {
        soundEngine.playUiClick();
        const order = ['holed', 'dual_hole', 'solid'];
        const curIdx = Math.max(0, order.indexOf(hit.stopperMode || 'holed'));
        const nextMode = order[(curIdx + (dir > 0 ? 1 : order.length - 1)) % order.length];
        wb.sim.setStopperMode(hit.id, nextMode);
      });
    }

    if (hit.kind === 'burner') {
      if (hit.typeId === 'bunsen_burner' && shiftKey) {
        return stepDiscrete(`bunsen-air:${hit.id}`, deltaY, () => {
          soundEngine.playFlameWhoosh(!hit.airHoleOpen);
          wb.sim.toggleBurnerAirHole(hit.id);
        });
      }
      const bSpec = APPARATUS[hit.typeId] || APPARATUS.burner;
      const airOpen = hit.typeId === 'bunsen_burner' ? hit.airHoleOpen !== false : true;
      const maxW = hit.typeId === 'bunsen_burner' && !airOpen ? (bSpec.yellowPowerLevelsW?.[3] || 820) : (bSpec.maxPowerW || 650);
      const nextW = clamp(0, maxW, Math.round((hit.powerW ?? 0) + (deltaY < 0 ? 40 : -40)));
      wb.sim.setBurnerPower(hit.id, nextW);
      return true;
    }

    if (hit.kind === 'pipette') {
      if (shiftKey) {
        return stepDiscrete(`pip-dose:${hit.id}`, deltaY, (dir) => {
          const steps = [0.05, 0.25, 0.5, 1.0, 2.0, 5.0];
          let bestIdx = 0;
          let bestDiff = Infinity;
          steps.forEach((v, i) => {
            const d = Math.abs(v - (hit.dropDoseMl || 1.0));
            if (d < bestDiff) { bestDiff = d; bestIdx = i; }
          });
          const nextDose = steps[clamp(0, steps.length - 1, bestIdx + (dir < 0 ? 1 : -1))];
          soundEngine.playUiClick();
          wb.sim.setPipetteDropDose(hit.id, nextDose);
        });
      }
      const now = performance.now();
      if (now - wb._pipetteWheelTs < 150) return true;
      wb._pipetteWheelTs = now;
      const doseMl = hit.dropDoseMl || 1.0;
      const spec = APPARATUS[hit.typeId] || APPARATUS.pipette_10;
      const tgt = wb.findVesselAt(hit.x, hit.y + spec.height / 2 + 24, hit.id, true);
      const syrTgt = !tgt ? wb.findSyringeAt(hit.x, hit.y + spec.height / 2 + 24) : null;
      const validPipContainer =
        tgt &&
        !tgt.isShattered &&
        !tgt.isBroken &&
        (tgt.kind === 'vessel' || tgt.kind === 'separatory_funnel' || tgt.kind === 'filter_funnel' || tgt.kind === 'burette') &&
        (tgt.kind === 'burette' ? true : !tgt.isStoppered);
      if (validPipContainer) {
        if (deltaY > 0) {
          if ((hit.volumeMl || 0) > 0.005) {
            soundEngine.playDropPlink(0.95);
            wb.sim.pipetteDispenseToVessel(tgt.id, doseMl, hit);
          }
        } else {
          soundEngine.playDropPlink(0.85);
          wb.sim.pipetteDrawFromVessel(tgt.id, doseMl, hit);
        }
      } else if (deltaY < 0 && syrTgt && !syrTgt.isBroken) {
        soundEngine.playDropPlink(0.85);
        wb.sim.pipetteDrawFromSyringe(syrTgt.id, doseMl, hit);
      }
      return true;
    }

    if (hit.kind === 'gas_syringe') {
      if (shiftKey) {
        return stepDiscrete(`syr-flip:${hit.id}`, deltaY, () => {
          soundEngine.playUiClick();
          wb.sim.flipItemLR(hit.id);
        });
      }
      if (deltaY > 0) {
        const arc = computeSyringeDischargeArc(hit, wb.sim.items, BENCH_FLOOR_Y, CONSTANTS.GRAVITY_PX_S2 || 1800);
        if (arc?.hitTargetVessel) {
          wb.sim.pumpSyringeToVessel(hit.id, arc.hitTargetVessel.id, 5.0);
        } else if (!hit.connectedFromId) {
          hit.autoDischargeTimer = 0.22;
          wb.sim.setSyringeDischarge(hit.id, true, 'both');
        }
      } else {
        wb.sim.setSyringeDischarge(hit.id, false);
        hit.autoDischargeTimer = 0;
        hit.wheelRetractMl = Math.min(100, (hit.wheelRetractMl || 0) + 5);
        wb.sim.emitChange();
      }
      return true;
    }

    if (hit.kind === 'vessel' || hit.kind === 'filter_funnel' || hit.kind === 'separatory_funnel' || hit.kind === 'spoon') {
      if (hit.kind === 'separatory_funnel' && shiftKey) {
        return stepDiscrete(`sep-valve:${hit.id}`, deltaY, () => {
          soundEngine.playUiClick();
          wb.sim.toggleSeparatoryValve(hit.id);
        });
      }
      const spec = APPARATUS[hit.typeId] || {};
      const isHeld = wb.dragState?.itemId === hit.id;
      if (hit.kind === 'vessel' && spec.hasLid && shiftKey && !isHeld) {
        return stepDiscrete(`lid:${hit.id}`, deltaY, () => {
          soundEngine.playGlassClink(hit.typeId, 0.7);
          wb.sim.cycleCrucibleLid(hit.id);
        });
      }
      if (hit.kind === 'vessel' && spec.isMortar && shiftKey && !isHeld) {
        return stepDiscrete(`mortar:${hit.id}`, deltaY, () => {
          soundEngine.playMortarGrind();
          wb.sim.grindMortar(hit.id);
        });
      }
      // Forward scroll (deltaY > 0) -> tilt RIGHT (+), reverse scroll (deltaY < 0) -> tilt LEFT (-)
      const deltaDeg = (deltaY > 0 ? 1 : -1) * Math.min(14, Math.max(5, Math.abs(deltaY) * 0.09));
      const curSigned = (hit.tiltDir < 0 ? -1 : 1) * (hit.tiltDeg || 0);
      const nextSigned = clamp(-180, 180, curSigned + deltaDeg);
      const nextAbs = Math.abs(nextSigned);
      const nextDir = nextSigned < 0 ? -1 : 1;
      wb.sim.setVesselTiltDeg(hit.id, nextAbs, nextDir);
      // Keep rotated horizontal quartz tubes cleanly above the bench floor
      if (spec.isHorizontalTube) {
        const maxQY = BENCH_FLOOR_Y - getItemRotatedHalfExtentY(spec, hit) + 2;
        if (hit.y > maxQY) hit.y = maxQY;
      }
      wb._wheelTiltVesselId = nextAbs > 0 && !spec.isHorizontalTube ? hit.id : null;
      return true;
    }

    return false;
}

export function setExternalDropPreviewImpl(wb, clientX, clientY, payloadType, payloadId) {
    if (!payloadType) {
      wb._externalDragActive = false;
      wb._canvasRect = null;
      wb.dropTargetVesselId = null;
      return;
    }
    wb._externalDragActive = true;
    const rect = wb._getCanvasRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      wb.dropTargetVesselId = null;
      return;
    }
    const pt = wb.clientToLogical(clientX, clientY);
    if (payloadType === 'reagent') {
      const tgt = wb.findVesselAt(pt.x, pt.y, null, true);
      wb.dropTargetVesselId = tgt ? tgt.id : null;
    } else if (payloadId === 'pipette_10' || payloadId === 'stir_bar' || payloadId === 'boiling_chips' || payloadId === 'electrode_rod' || payloadId === 'filter_funnel' || payloadId === 'separatory_funnel') {
      const tgt = wb.findVesselAt(pt.x, pt.y, null, false);
      const tSpec = tgt ? APPARATUS[tgt.typeId] : null;
      const valid = tgt && (payloadId !== 'electrode_rod' || !tSpec?.isHorizontalTube);
      wb.dropTargetVesselId = valid ? tgt.id : null;
    } else if (payloadId === 'rubber_stopper') {
      const mTgt = wb.findMouthTargetAt(pt.x, pt.y, 'stopper');
      wb.dropTargetVesselId = mTgt ? mTgt.vessel.id : null;
    } else if (payloadId === 'phen_cotton') {
      const mTgt = wb.findMouthTargetAt(pt.x, pt.y, 'cotton');
      wb.dropTargetVesselId = mTgt ? mTgt.vessel.id : null;
    } else {
      wb.dropTargetVesselId = null;
    }
}

export function dropFromShelfImpl(wb, clientX, clientY, payloadType, payloadId) {
    const pt = wb.clientToLogical(clientX, clientY);
    wb._externalDragActive = false;
    wb._canvasRect = null;
    if (payloadType === 'apparatus' && payloadId) {
      const spec = APPARATUS[payloadId];
      if (!spec) {
        wb.dropTargetVesselId = null;
        return null;
      }
      const hoverVessel = wb.findVesselAt(pt.x, pt.y, null, payloadId === 'pipette_10');
      const hoverSyr = payloadId === 'pipette_10' && !hoverVessel ? wb.findSyringeAt(pt.x, pt.y) : null;
      const clampedX = Math.max(60, Math.min(BENCH_LOGICAL_W - 60, pt.x));
      const clampedY = Math.min(BENCH_FLOOR_Y - (spec.height || 80) / 2 + 2, Math.max(65, pt.y));
      wb.sim.recordUndo?.();
      const created = wb.sim.createApparatus(payloadId, clampedX, clampedY, { silentUndo: true });

      if (created) {
        if (created.kind === 'rubber_stopper') {
          const mTgt = wb.findMouthTargetAt(pt.x, pt.y, 'stopper');
          if (mTgt) {
            wb.sim.attachRubberStopper(created.id, mTgt.vessel.id, mTgt.side);
          } else {
            created.fallStartY = created.y;
          }
        } else if (created.kind === 'phen_cotton') {
          const mTgt = wb.findMouthTargetAt(pt.x, pt.y, 'cotton');
          if (mTgt) {
            wb.sim.attachPhenCotton(created.id, mTgt.vessel.id, mTgt.side);
          } else {
            created.fallStartY = created.y;
          }
        } else if (created.kind === 'stir_bar' && hoverVessel && !hoverVessel.isStoppered) {
          wb.sim.insertStirBarIntoVessel(created.id, hoverVessel.id, 800);
        } else if (created.kind === 'boiling_chips' && hoverVessel && !hoverVessel.isStoppered) {
          wb.sim.insertBoilingChipsIntoVessel(created.id, hoverVessel.id);
        } else if (created.kind === 'electrode' && hoverVessel) {
          const hvSpec = APPARATUS[hoverVessel.typeId];
          const side = clampedX >= hoverVessel.x ? 'right' : 'left';
          if (!hvSpec?.isHorizontalTube) {
            created.dockedVesselId = hoverVessel.id;
            created.dockSide = side;
            syncDockedToolPositions(wb.sim);
          } else {
            created.fallStartY = created.y;
          }
        } else if (created.kind === 'filter_funnel' && hoverVessel && !hoverVessel.isStoppered) {
          created.mountedOnVesselId = hoverVessel.id;
          syncDockedToolPositions(wb.sim);
        } else if (created.kind === 'separatory_funnel' && hoverVessel && !hoverVessel.isInverted) {
          wb.sim.mountSeparatoryFunnel(created.id, hoverVessel.id);
        } else if (spec.supportsClamp) {
          const nearStand = wb.findStandNear(created);
          const clampFloorLimit = BENCH_FLOOR_Y - (created.kind === 'burette' ? spec.height / 2 + 6 : (spec.height || 80) / 2 + 12);
          if (nearStand && created.y <= clampFloorLimit) {
            if (created.kind === 'burette' || created.kind === 'filter_funnel' || created.kind === 'separatory_funnel' || created.kind === 'condenser') {
              created.x = nearStand.x + 8;
            }
            wb.sim.attachToStand(created.id, nearStand.id);
          } else {
            created.fallStartY = created.y;
          }
        } else {
          created.fallStartY = created.y;
        }
      }

      if (created && hoverVessel && payloadId === 'pipette_10' && !hoverVessel.isShattered && !hoverVessel.isBroken && (hoverVessel.kind === 'burette' || !hoverVessel.isStoppered) && hoverVessel.kind !== 'spoon') {
        const drew = wb.sim.pipetteDrawFromVessel(hoverVessel.id, created.capacityMl || 10.0, created);
        if (drew > 0) {
          const hSpec = APPARATUS[hoverVessel.typeId];
          const parkRightX = hoverVessel.x + hSpec.width / 2 + 26;
          const parkLeftX = hoverVessel.x - hSpec.width / 2 - 26;
          created.x = parkRightX <= BENCH_LOGICAL_W - 45 ? parkRightX : Math.max(45, parkLeftX);
          created.y = BENCH_FLOOR_Y - spec.height / 2 + 2;
          created.fallStartY = null;
        }
      } else if (created && hoverSyr && payloadId === 'pipette_10' && !hoverSyr.isBroken) {
        const drew = wb.sim.pipetteDrawFromSyringe(hoverSyr.id, created.capacityMl || 10.0, created);
        if (drew > 0) {
          const syrG = getSyringeGeometry(hoverSyr);
          created.x = Math.max(45, Math.min(BENCH_LOGICAL_W - 45, syrG.nozzleX - syrG.barrelDir * 24));
          created.y = BENCH_FLOOR_Y - spec.height / 2 + 2;
          created.fallStartY = null;
        }
      }
      if (created && wb.callbacks.onSelect) wb.callbacks.onSelect(created);
      wb.sim.updateSupportAttachments();
      wb.sim.emitChange();
      wb.dropTargetVesselId = null;
      return created;
    }

    if (payloadType === 'reagent' && payloadId) {
      if (payloadId === 'nh3_25' || payloadId === 'hcl_37') {
        const diffTube = wb.sim.items.find(
          (t) => t.kind === 'diffusion_tube' && !t.isBroken && Math.abs(pt.x - t.x) <= 145 && Math.abs(pt.y - t.y) <= 48
        );
        if (diffTube) {
          wb.sim.dropDiffusionReagent(
            diffTube.id,
            pt.x < diffTube.x ? 'left' : 'right',
            payloadId === 'nh3_25' ? 'NH3_g' : 'HCl_g'
          );
          wb.sim.selectedId = diffTube.id;
          wb.dropTargetVesselId = null;
          return diffTube;
        }
      }
      let target = wb.findVesselAt(pt.x, pt.y, null, true);
      if (!target) {
        // Snap gracefully to nearest open container within 105 px if dropped right next to it
        let bestD = 105;
        for (const it of wb.sim.items) {
          if ((it.kind === 'vessel' || it.kind === 'filter_funnel' || it.kind === 'separatory_funnel' || it.kind === 'burette' || it.kind === 'spoon') && !it.isShattered && !it.isBroken) {
            const d = Math.hypot(it.x - pt.x, it.y - pt.y);
            if (d < bestD) {
              bestD = d;
              target = it;
            }
          }
        }
      }
      if (!target) {
        // Auto-place a 250 mL Beaker at drop spot if bench has no nearby/existing vessel so reagent drops always succeed
        const existing = wb.sim.items.find((i) => i.kind === 'vessel' && !i.isShattered);
        target = existing || wb.sim.createApparatus('beaker_250', Math.max(80, Math.min(BENCH_LOGICAL_W - 80, pt.x)), BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      }
      if (target && wb.callbacks.onRequestDosing) {
        wb.sim.selectedId = target.id;
        wb.callbacks.onRequestDosing(payloadId, target.id);
      }
      wb.dropTargetVesselId = null;
      return target;
    }

    wb.dropTargetVesselId = null;
    return null;
}

export function bindWorkbenchEventsImpl(wb) {
    wb.ro = new ResizeObserver(() => wb.resize());
    if (wb.canvas.parentElement) wb.ro.observe(wb.canvas.parentElement);
    window.addEventListener('scroll', () => {
      wb._canvasRect = null;
    }, { passive: true, capture: true });

    // Unified pointer events for Mouse + Touch + Pen
    wb.canvas.addEventListener('pointerdown', (e) => {
      wb._canvasRect = wb.canvas.getBoundingClientRect();
      const pt = wb.clientToLogical(e.clientX, e.clientY);

      if (wb.pickState) {
        const picked = wb.hitTestItem(pt.x, pt.y, null, (it) => wb.pickState.candidateIds.has(it.id));
        if (picked) {
          const onPick = wb.pickState.onPick;
          wb.pickState = null;
          wb.hoverItemId = null;
          wb.canvas.style.cursor = 'default';
          wb.callbacks.onPickStateChange?.(null);
          onPick?.(picked, pt);
        }
        return;
      }

      // 0A. Check Retort Stand top finial cap handle for telescopic rod extension
      const standTip = wb.findStandTipAt(pt.x, pt.y);
      if (standTip) {
        wb.sim.recordUndo?.();
        wb.setSelection([standTip.id], standTip.id);
        wb.standResizeState = {
          standId: standTip.id,
          startY: pt.y,
          startExtendPx: standTip.extendPx || 0,
        };
        wb.canvas.style.cursor = 'ns-resize';
        wb._trySetPointerCapture(e.pointerId);
        soundEngine.playClampClick();
        if (wb.callbacks.onSelect) wb.callbacks.onSelect(standTip);
        return;
      }

      // 0B. Check draggable submerged tubing tip handle inside upright receiving vessel
      const tubeTipHit = wb.findTubeTipHandleAt(pt.x, pt.y);
      if (tubeTipHit) {
        wb.setSelection([tubeTipHit.srcVessel.id], tubeTipHit.srcVessel.id);
        wb.tubeTipDragState = {
          srcVesselId: tubeTipHit.srcVessel.id,
          dstVesselId: tubeTipHit.dstVessel.id,
        };
        wb.canvas.style.cursor = 'ns-resize';
        wb._trySetPointerCapture(e.pointerId);
        if (wb.callbacks.onSelect) wb.callbacks.onSelect(tubeTipHit.srcVessel);
        return;
      }

      // 0. Check direct tubing port handles on Liebig Condenser (Inlet Left / Outlet Right)
      const portHit = wb.findCondenserPortAt(pt.x, pt.y);
      if (portHit) {
        wb.setSelection([portHit.cond.id], portHit.cond.id);
        wb.portDragState = {
          condId: portHit.cond.id,
          port: portHit.port,
          side: portHit.side || null,
          startX: portHit.origin.x,
          startY: portHit.origin.y,
          x: pt.x,
          y: pt.y,
          moved: false,
        };
        wb._trySetPointerCapture(e.pointerId);
        if (wb.callbacks.onSelect) wb.callbacks.onSelect(portHit.cond);
        return;
      }

      const hit = wb.hitTestItem(pt.x, pt.y);
      wb.hoverItemId = hit ? hit.id : null;
      const isCtrl = Boolean(e.ctrlKey || e.metaKey);

      // In Magnifier Loupe mode at 1x, clicking zooms straight to 2.8x onto the inspected detail
      if (wb.zoomMode && wb.zoomScale <= 1.02) {
        if (hit) {
          wb.setSelection([hit.id], hit.id);
          if (wb.callbacks.onSelect) wb.callbacks.onSelect(hit);
        }
        wb.setZoomView(2.8, pt.x, pt.y);
        return;
      }

      if (isCtrl && !hit) {
        // Ctrl+Drag on empty canvas starts Marquee Multi-Select Rectangle
        wb.marqueeState = {
          startX: pt.x,
          startY: pt.y,
          x: pt.x,
          y: pt.y,
          baseSet: new Set(wb.getSelectedIdSet()),
        };
        wb._trySetPointerCapture(e.pointerId);
        return;
      }

      if (hit) {
        const curSel = wb.getSelectedIdSet();
        if (isCtrl) {
          if (curSel.has(hit.id)) {
            curSel.delete(hit.id);
            const rem = Array.from(curSel);
            wb.setSelection(rem, rem[rem.length - 1] || null);
            if (wb.callbacks.onSelect) wb.callbacks.onSelect(wb.sim.getItem(wb.sim.selectedId));
            return;
          }
          curSel.add(hit.id);
          wb.setSelection(curSel, hit.id);
        } else if (!curSel.has(hit.id) || curSel.size <= 1) {
          wb.setSelection([hit.id], hit.id);
        } else {
          // Clicking inside existing multi-selection keeps group intact so drag moves all selected items together
          wb.sim.selectedId = hit.id;
        }
        const activeGroupIds = Array.from(wb.getSelectedIdSet());
        const activeIdSet = new Set(activeGroupIds);
        const groupMembers = activeGroupIds
          .map((gid) => wb.sim.getItem(gid))
          .filter(Boolean)
          .map((g) => ({ item: g, startX: g.x, startY: g.y }));
        for (const member of groupMembers) {
          const g = member.item;
          g.isDragging = true;
          g.vy = 0;
          g.fallStartY = g.y;
          g.restingOnId = null;
          if (g.kind === 'spoon') {
            g.spoonAnim = null;
            g.tiltAngle = 0;
          }
          if (g.kind === 'electrode' && (!g.dockedVesselId || !activeIdSet.has(g.dockedVesselId))) {
            g.dockedVesselId = null;
          }
          if ((g.kind === 'filter_funnel' || g.kind === 'separatory_funnel') && g.id !== hit.id && (!g.mountedOnVesselId || !activeIdSet.has(g.mountedOnVesselId))) {
            g.mountedOnVesselId = null;
          }
        }
        const wasMountedId = (hit.kind === 'filter_funnel' || hit.kind === 'separatory_funnel') ? hit.mountedOnVesselId : null;
        if (hit.kind === 'filter_funnel' || hit.kind === 'separatory_funnel') hit.mountedOnVesselId = null;
        if (hit.kind === 'wash_bottle' && (hit.waterMl || 0) > 0.1) {
          hit.isSpraying = true;
        }
        const preDragSnap = wb.sim.exportPositionSnapshot ? wb.sim.exportPositionSnapshot() : null;
        // Bring dragged item to front visually unless it's a support base (scale/burner/stand)
        if (
          hit.kind === 'vessel' ||
          hit.kind === 'pipette' ||
          hit.kind === 'gas_syringe' ||
          hit.kind === 'filter_funnel' ||
          hit.kind === 'separatory_funnel' ||
          hit.kind === 'wash_bottle' ||
          hit.kind === 'burette' ||
          hit.kind === 'condenser' ||
          hit.kind === 'rubber_stopper' ||
          hit.kind === 'phen_cotton' ||
          hit.kind === 'splint' ||
          hit.kind === 'flame_loop' ||
          hit.kind === 'indicator_strip' ||
          hit.kind === 'spoon' ||
          hit.kind === 'stir_bar' ||
          hit.kind === 'electrode' ||
          hit.kind === 'thermometer'
        ) {
          wb.sim.items = wb.sim.items.filter((i) => i.id !== hit.id);
          wb.sim.items.push(hit);
        }
        wb.dragState = {
          itemId: hit.id,
          offsetX: pt.x - hit.x,
          offsetY: pt.y - hit.y,
          prevX: hit.x,
          prevY: hit.y,
          startX: hit.x,
          startY: hit.y,
          preDragSnap,
          undoRecorded: false,
          fullUndoRecorded: false,
          unmountHoldoffId: wasMountedId,
          pourTargetId: null,
          pipetteTargetId: null,
          clampStandId: hit.clampedToId || null,
          targetTilt: 0,
          pourAlignFactor: 1.0,
          pouredMl: 0,
          groupMembers,
        };
        if (hit.kind === 'wash_bottle' && hit.isSpraying) {
          wb._upgradeDragToFullUndo();
        }
        wb._trySetPointerCapture(e.pointerId);
        soundEngine.playGlassClink(hit.typeId, 0.55);
        if (wb.callbacks.onSelect) wb.callbacks.onSelect(hit);
      } else if (wb.zoomScale > 1.02) {
        wb.panDragState = {
          startClientX: e.clientX,
          startClientY: e.clientY,
          startCenterX: wb.zoomCenterX,
          startCenterY: wb.zoomCenterY,
        };
        wb.canvas.style.cursor = 'grabbing';
        wb._trySetPointerCapture(e.pointerId);
      } else {
        wb.setSelection([], null);
        if (wb.callbacks.onSelect) wb.callbacks.onSelect(null);
      }
    });

    wb.canvas.addEventListener('dblclick', (e) => {
      const pt = wb.clientToLogical(e.clientX, e.clientY);
      const hit = wb.hitTestItem(pt.x, pt.y);
      if (hit && hit.kind === 'electrode') {
        const order = ['C', 'Cu', 'Zn'];
        const nextMat = order[(order.indexOf(hit.material) + 1) % order.length];
        soundEngine.playUiClick();
        wb.sim.setElectrodeMaterial(hit.id, nextMat);
      } else if (hit && hit.kind === 'vessel' && APPARATUS[hit.typeId]?.hasLid) {
        soundEngine.playGlassClink(hit.typeId, 0.7);
        wb.sim.cycleCrucibleLid(hit.id);
      } else if (hit && hit.kind === 'rubber_stopper') {
        soundEngine.playStopperPop(hit.stopperMode === 'solid');
        const order = ['holed', 'dual_hole', 'solid'];
        const nextMode = order[(order.indexOf(hit.stopperMode || 'holed') + 1) % order.length];
        wb.sim.setStopperMode(hit.id, nextMode);
      } else if (hit && hit.typeId === 'bunsen_burner') {
        soundEngine.playFlameWhoosh(!hit.airHoleOpen);
        wb.sim.toggleBurnerAirHole(hit.id);
      } else if (hit && hit.kind === 'vessel' && hit.hasStirBar) {
        soundEngine.playUiClick();
        wb.sim.toggleMagneticStir(hit.id);
      } else if (hit && hit.kind === 'stir_bar' && hit.inVesselId) {
        soundEngine.playUiClick();
        wb.sim.toggleMagneticStir(hit.inVesselId);
      } else if (!hit && wb.zoomScale > 1.02) {
        wb.resetZoom();
      }
    });

    wb.canvas.addEventListener('pointerleave', () => {
      wb.pointerLogical = null;
      wb.hoveredTubeInfo = null;
      wb.resetWheelTiltedVessel(null);
      if (!wb.dragState && !wb.portDragState && !wb.panDragState) {
        wb.hoverItemId = null;
        wb._canvasRect = null;
      }
    });

    wb.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (wb.pickState) return;
      const pt = wb.clientToLogical(e.clientX, e.clientY);
      wb.pointerLogical = { x: pt.x, y: pt.y };
      const hitItem = wb.hitTestItem(pt.x, pt.y);
      if (hitItem && !wb.sim.selectedIds?.has(hitItem.id)) {
        wb.setSelection(new Set([hitItem.id]), hitItem.id);
      }
      wb.callbacks.onContextMenu?.(e.clientX, e.clientY, pt, hitItem);
    });

    const runPointerMove = (clientX, clientY) => {
      const pt = wb.clientToLogical(clientX, clientY);
      wb.pointerLogical = { x: pt.x, y: pt.y };
      if (wb.panDragState) {
        const dxPx = clientX - wb.panDragState.startClientX;
        const dyPx = clientY - wb.panDragState.startClientY;
        const dxWorld = dxPx / (wb.viewScale * wb.zoomScale);
        const dyWorld = dyPx / (wb.viewScale * wb.zoomScale);
        wb.setZoomView(
          wb.zoomScale,
          wb.panDragState.startCenterX - dxWorld,
          wb.panDragState.startCenterY - dyWorld
        );
        wb.canvas.style.cursor = 'grabbing';
        return;
      }
      if (wb.standResizeState) {
        const dy = wb.standResizeState.startY - pt.y;
        const nextExt = Math.max(0, Math.min(200, Math.round(wb.standResizeState.startExtendPx + dy)));
        wb.sim.setStandExtension(wb.standResizeState.standId, nextExt);
        wb.canvas.style.cursor = 'ns-resize';
        return;
      }
      if (wb.tubeTipDragState) {
        const dstV = wb.sim.getItem(wb.tubeTipDragState.dstVesselId);
        const dstSpec = dstV ? APPARATUS[dstV.typeId] : null;
        if (dstV && dstSpec) {
          if (dstV.isInverted) {
            const botMouthY = dstV.y + dstSpec.height / 2 - 2;
            const topDomeY = dstV.y - dstSpec.height / 2 + 10;
            const ratio = Math.max(0, Math.min(1, (botMouthY - pt.y) / Math.max(12, botMouthY - topDomeY)));
            wb.sim.setTubeSubmersionRatio(wb.tubeTipDragState.srcVesselId, ratio);
          } else {
            const topY = dstV.y - dstSpec.height / 2 + 6;
            const botY = dstV.y + dstSpec.height / 2 - 14;
            const ratio = Math.max(0, Math.min(1, (pt.y - topY) / Math.max(12, botY - topY)));
            wb.sim.setTubeSubmersionRatio(wb.tubeTipDragState.srcVesselId, ratio);
          }
        }
        wb.canvas.style.cursor = 'ns-resize';
        return;
      }
      if (wb.pickState) {
        const candHover = wb.hitTestItem(pt.x, pt.y, null, (it) => wb.pickState.candidateIds.has(it.id));
        wb.hoverItemId = candHover ? candHover.id : null;
        wb.canvas.style.cursor = candHover ? 'pointer' : 'crosshair';
        return;
      }
      if (wb.portDragState) {
        wb.portDragState.x = pt.x;
        wb.portDragState.y = pt.y;
        if (Math.hypot(pt.x - wb.portDragState.startX, pt.y - wb.portDragState.startY) > 6) {
          wb.portDragState.moved = true;
        }
        const pd = wb.portDragState;
        const vTgt = wb.findVesselAt(pt.x, pt.y, pd.condId, false);
        const syrTgt = wb.findSyringeAt(pt.x, pt.y);
        if (pd.port === 'stopper') {
          wb.dropTargetVesselId = syrTgt ? syrTgt.id : vTgt ? vTgt.id : null;
        } else if (pd.port === 'nozzle') {
          wb.dropTargetVesselId = vTgt && APPARATUS[vTgt.typeId]?.stopperable ? vTgt.id : null;
        } else {
          wb.dropTargetVesselId = vTgt ? vTgt.id : null;
        }
        wb.canvas.style.cursor = 'crosshair';
        return;
      }

      if (wb.marqueeState) {
        wb.marqueeState.x = pt.x;
        wb.marqueeState.y = pt.y;
        const minX = Math.min(wb.marqueeState.startX, pt.x);
        const maxX = Math.max(wb.marqueeState.startX, pt.x);
        const minY = Math.min(wb.marqueeState.startY, pt.y);
        const maxY = Math.max(wb.marqueeState.startY, pt.y);
        const picked = new Set(wb.marqueeState.baseSet || []);
        for (const it of wb.sim.items) {
          const sp = APPARATUS[it.typeId] || { width: 48, height: 48 };
          const hw = sp.width / 2;
          const hh = (it.renderHeight || sp.height) / 2;
          if (it.x + hw >= minX && it.x - hw <= maxX && it.y + hh >= minY && it.y - hh <= maxY) {
            picked.add(it.id);
          }
        }
        wb.setSelection(picked);
        wb.canvas.style.cursor = 'crosshair';
        return;
      }
      if (!wb.dragState) {
        wb.hoveredTubeInfo = wb.findTubeHoverAt(pt.x, pt.y);
        const tubeTipHover = wb.findTubeTipHandleAt(pt.x, pt.y);
        if (tubeTipHover) {
          wb.hoverItemId = tubeTipHover.srcVessel.id;
          wb.canvas.style.cursor = 'ns-resize';
          return;
        }
        const standTipHover = wb.findStandTipAt(pt.x, pt.y);
        if (standTipHover) {
          wb.hoverItemId = standTipHover.id;
          wb.canvas.style.cursor = 'ns-resize';
          return;
        }
        const portHover = wb.findCondenserPortAt(pt.x, pt.y);
        if (portHover) {
          wb.hoverItemId = portHover.cond.id;
          wb.canvas.style.cursor = wb.zoomMode && wb.zoomScale <= 1.02 ? 'zoom-in' : 'crosshair';
          return;
        }
        const hit = wb.hitTestItem(pt.x, pt.y);
        wb.hoverItemId = hit ? hit.id : null;
        if (!hit || hit.id !== wb._wheelTiltVesselId) {
          wb.resetWheelTiltedVessel(null);
        }
        if (wb.zoomMode && wb.zoomScale <= 1.02) {
          wb.canvas.style.cursor = 'zoom-in';
        } else if (wb.zoomScale > 1.02) {
          wb.canvas.style.cursor = hit ? 'grab' : 'grab';
        } else {
          wb.canvas.style.cursor = hit ? 'grab' : 'default';
        }
        return;
      }

      wb.canvas.style.cursor = 'grabbing';
      const item = wb.sim.getItem(wb.dragState.itemId);
      if (!item) return;

      if (
        !wb.dragState.undoRecorded &&
        wb.dragState.preDragSnap &&
        Math.hypot(pt.x - wb.dragState.offsetX - wb.dragState.startX, pt.y - wb.dragState.offsetY - wb.dragState.startY) > 3
      ) {
        wb.dragState.undoRecorded = true;
        wb.sim.pushUndoSnapshot?.(wb.dragState.preDragSnap);
      }

      // Once user actually drags a docked stir bar (>6 px), undock it cleanly so simple clicks still inspect without ejecting!
      if (
        (item.kind === 'stir_bar' || item.kind === 'boiling_chips') &&
        item.inVesselId &&
        Math.hypot(pt.x - wb.dragState.offsetX - wb.dragState.startX, pt.y - wb.dragState.offsetY - wb.dragState.startY) > 6
      ) {
        const prevV = wb.sim.getItem(item.inVesselId);
        if (prevV) {
          if (item.kind === 'stir_bar') {
            prevV.hasStirBar = false;
            prevV.magStirRpm = 0;
          } else {
            prevV.hasBoilingChips = wb.sim.items.some((i) => i.kind === 'boiling_chips' && i.id !== item.id && i.inVesselId === prevV.id);
          }
        }
        item.inVesselId = null;
      }

      const spec = APPARATUS[item.typeId];
      const minStandY = item.kind === 'stand' ? spec.height / 2 + 24 : 65;
      const halfExtY = getItemRotatedHalfExtentY(spec, item);
      const nextX = Math.max(60, Math.min(BENCH_LOGICAL_W - 60, pt.x - wb.dragState.offsetX));
      const nextY = Math.max(minStandY, Math.min(BENCH_FLOOR_Y - halfExtY + 4, pt.y - wb.dragState.offsetY));
      const dxMove = nextX - item.x;
      const dyMove = nextY - item.y;
      item.x = nextX;
      item.y = nextY;
      item.vy = 0;
      item.fallStartY = item.y;

      // Move all multi-selected peers along with dragged item when dragging a multi-selection
      if (wb.dragState.groupMembers && wb.dragState.groupMembers.length > 1) {
        const activeIdSet = new Set(wb.dragState.groupMembers.map((m) => m.item?.id).filter(Boolean));
        for (const member of wb.dragState.groupMembers) {
          const peer = member.item;
          if (!peer || peer.id === item.id) continue;
          peer.isDragging = true;
          peer.vy = 0;
          peer.restingOnId = null;
          if (peer.clampedToId && activeIdSet.has(peer.clampedToId)) {
            peer.fallStartY = null;
            continue;
          }
          if (peer.dockedVesselId && activeIdSet.has(peer.dockedVesselId)) {
            peer.fallStartY = null;
            continue;
          }
          if (peer.mountedOnVesselId && activeIdSet.has(peer.mountedOnVesselId)) {
            peer.fallStartY = null;
            continue;
          }
          if (peer.attachedToId && activeIdSet.has(peer.attachedToId)) {
            peer.fallStartY = null;
            continue;
          }
          const pSpec = APPARATUS[peer.typeId] || { height: 60 };
          const pHalfY = getItemRotatedHalfExtentY(pSpec, peer);
          peer.x = Math.max(40, Math.min(BENCH_LOGICAL_W - 40, peer.x + dxMove));
          peer.y = Math.max(45, Math.min(BENCH_FLOOR_Y - pHalfY + 4, peer.y + dyMove));
          peer.fallStartY = peer.y;
          if (peer.kind === 'stand') {
            for (const child of wb.sim.items) {
              if (child.clampedToId !== peer.id || child.id === item.id) continue;
              const cSpec = APPARATUS[child.typeId];
              child.x = Math.max(50, Math.min(BENCH_LOGICAL_W - 50, child.x + dxMove));
              child.y = clampItemToStandY(cSpec, peer, BENCH_FLOOR_Y, child.y + dyMove, 4);
              child.vy = 0;
              child.fallStartY = null;
            }
          }
        }
      }

      // Detach Rubber Stopper or Phen Cotton when pulled away from its vessel mouth (>16px)
      if ((item.kind === 'rubber_stopper' || item.kind === 'phen_cotton') && item.attachedToId) {
        if (Math.hypot(nextX - wb.dragState.startX, nextY - wb.dragState.startY) > 16) {
          if (item.kind === 'rubber_stopper') wb.sim.detachRubberStopper(item.id, { keepPos: true });
          else wb.sim.detachPhenCotton(item.id);
        }
      }
      if (
        item.kind === 'vessel' &&
        item.mountedOverElectrodeId &&
        Math.hypot(nextX - wb.dragState.startX, nextY - wb.dragState.startY) > 12
      ) {
        item.mountedOverElectrodeId = null;
      }

      // Move clamped items rigidly along with stand when dragging a Retort Stand
      if (item.kind === 'stand') {
        for (const child of wb.sim.items) {
          if (child.clampedToId !== item.id) continue;
          if (child.isShattered || child.isBroken) {
            child.clampedToId = null;
            child.fallStartY = child.y;
            continue;
          }
          const cSpec = APPARATUS[child.typeId];
          child.x = Math.max(50, Math.min(BENCH_LOGICAL_W - 50, child.x + dxMove));
          child.y = clampItemToStandY(cSpec, item, BENCH_FLOOR_Y, child.y + dyMove, 4);
          child.vy = 0;
          child.fallStartY = null;
        }
      }

      // Check Retort Stand clamp snap/release for clamp-capable apparatus (including burette, condenser, funnel)
      if (spec?.supportsClamp) {
        if (item.isShattered || item.isBroken) {
          wb.dragState.clampStandId = null;
          item.clampedToId = null;
        } else {
          const stand = wb.findStandNear(item);
          const clampFloorLimit = BENCH_FLOOR_Y - (item.kind === 'burette' ? spec.height / 2 + 6 : spec.height / 2 + 12);
          if (stand && item.y <= clampFloorLimit) {
            wb.dragState.clampStandId = stand.id;
            item.clampedToId = stand.id;
            if (item.kind === 'burette' || item.kind === 'condenser' || item.kind === 'filter_funnel' || item.kind === 'separatory_funnel') {
              const snapX = getStandGeometry(stand).clampTargetX(item.kind);
              if (Math.abs(item.x - snapX) < 32) item.x = snapX;
            }
          } else {
            wb.dragState.clampStandId = null;
            item.clampedToId = null;
          }
        }
      }

      // Live interactions while dragging Splint, Flame Loop, Indicator Strip, Wash Bottle, Stir Bar, Electrode, Filter Funnel
      if (item.kind === 'splint') {
        checkSplintInteractions(wb.sim, item);
      } else if (item.kind === 'flame_loop') {
        checkFlameLoopInteractions(wb.sim, item);
      } else if (item.kind === 'indicator_strip') {
        checkIndicatorStripInteractions(wb.sim, item);
      } else if (item.kind === 'thermometer') {
        checkThermometerInteractions(wb.sim, item, 0.08);
      } else if (item.kind === 'ph_conductometer' || item.kind === 'colorimeter' || item.kind === 'tlc_plate') {
        stepAnalyticalInstruments(wb.sim, item, 0.08);
      } else if (item.kind === 'wash_bottle') {
        const arc = computeWashBottleStreamArc(item, wb.sim.items, BENCH_FLOOR_Y, CONSTANTS.GRAVITY_PX_S2 || 1800);
        wb.dropTargetVesselId = arc.hitTarget ? arc.hitTarget.id : null;
      } else if (item.kind === 'stir_bar' || item.kind === 'boiling_chips' || item.kind === 'electrode' || item.kind === 'filter_funnel') {
        const tgt = wb.findVesselAt(item.x, item.y + 18, item.id, false);
        wb.dropTargetVesselId = tgt && !tgt.isStoppered ? tgt.id : null;
      } else if (item.kind === 'separatory_funnel') {
        const tgt = wb.findVesselAt(item.x, item.y + 82, item.id, false);
        wb.dropTargetVesselId = tgt && !tgt.isInverted ? tgt.id : null;
      } else if (item.kind === 'rubber_stopper' && !item.attachedToId) {
        const mTgt = wb.findMouthTargetAt(item.x, item.y, 'stopper');
        wb.dropTargetVesselId = mTgt ? mTgt.vessel.id : null;
      } else if (item.kind === 'phen_cotton' && !item.attachedToId) {
        const mTgt = wb.findMouthTargetAt(item.x, item.y, 'cotton');
        wb.dropTargetVesselId = mTgt ? mTgt.vessel.id : null;
      } else if (item.kind === 'spoon') {
        const tip = getProbeTipPos(item);
        const tgt = wb.findVesselAt(tip.x, tip.y + 10, null, false);
        const spoonMol = Object.values(item.moles || {}).reduce((s, n) => s + (n > 0 ? n : 0), 0);
        if (tgt && !tgt.isShattered && !tgt.isStoppered) {
          const tSpec = APPARATUS[tgt.typeId] || APPARATUS.beaker_250;
          const rimY = tgt.y - tSpec.height / 2;
          const tgtHasSolid = Object.entries(tgt.moles || {}).some(([k, n]) => SPECIES[k]?.phase === 's' && n > 1e-8);
          const tgtHasLiq = computeLiquidVolumeL(tgt.moles, tgt.tempK) > 1e-5;
          const isInGasJarBody = (tgt.headspaceGasMoles?.O2_g || 0) > 8e-5 && !tgtHasLiq && tip.y > rimY + 14;
          if (spoonMol > 1e-8 && !isInGasJarBody) {
            wb.dragState.spoonAction = 'pour';
            wb.dragState.spoonTargetId = tgt.id;
            wb.dropTargetVesselId = tgt.id;
            if ((item.tiltDeg || 0) <= 0.1) item.tiltAngle = item.x >= tgt.x ? -0.35 : 0.35;
            item.hoveredActionLabel = wb.langCode === 'vi' ? '🥄 Thả để đổ vào bình' : '🥄 Release to dump';
          } else if (spoonMol <= 1e-8 && tgtHasSolid) {
            wb.dragState.spoonAction = 'scoop';
            wb.dragState.spoonTargetId = tgt.id;
            wb.dropTargetVesselId = tgt.id;
            if ((item.tiltDeg || 0) <= 0.1) item.tiltAngle = 0;
            item.hoveredActionLabel = wb.langCode === 'vi' ? '🥄 Thả để múc chất rắn' : '🥄 Release to scoop';
          } else {
            wb.dragState.spoonAction = null;
            wb.dragState.spoonTargetId = null;
            wb.dropTargetVesselId = null;
            if ((item.tiltDeg || 0) <= 0.1) item.tiltAngle = 0;
            item.hoveredActionLabel = null;
          }
        } else {
          wb.dragState.spoonAction = null;
          wb.dragState.spoonTargetId = null;
          wb.dropTargetVesselId = null;
          if ((item.tiltDeg || 0) <= 0.1) item.tiltAngle = 0;
          item.hoveredActionLabel = null;
        }
      }

      // Disabled automatic proximity drag-pour: user aims vessel/funnel and scrolls wheel to tilt & pour cleanly
      if ((item.kind === 'vessel' || item.kind === 'filter_funnel') && !item.isStoppered && !item.isShattered) {
        wb.dragState.pourTargetId = null;
        wb.dragState.targetTilt = 0;
        if (item.kind !== 'filter_funnel') wb.dropTargetVesselId = null;
      } else if (item.kind === 'pipette' && !item.isBroken) {
        const tgt = wb.findVesselAt(item.x, item.y + spec.height * 0.28, item.id, true);
        const syrTgt = !tgt ? wb.findSyringeAt(item.x, item.y + spec.height * 0.28) : null;
        const validPipTgt =
          tgt &&
          !tgt.isShattered &&
          !tgt.isBroken &&
          (tgt.kind === 'vessel' || tgt.kind === 'separatory_funnel' || tgt.kind === 'filter_funnel' || tgt.kind === 'burette') &&
          (tgt.kind === 'burette' ? true : !tgt.isStoppered);
        if (validPipTgt) {
          wb.dragState.pipetteTargetId = tgt.id;
          wb.dropTargetVesselId = tgt.id;
          item.tiltAngle = -0.14;
          const hasVol = (item.volumeMl || 0) > 0.05;
          item.hoveredActionLabel = hasVol
            ? wb.langCode === 'vi'
              ? `💧 Thả nhỏ (${(item.dropDoseMl || 1).toFixed(2)} mL)`
              : `💧 Drop (${(item.dropDoseMl || 1).toFixed(2)} mL)`
            : wb.langCode === 'vi'
            ? '🧪 Thả hút (≤10 mL)'
            : '🧪 Drop to draw (≤10 mL)';
        } else if (syrTgt && (item.volumeMl || 0) <= 0.05 && computeSyringeLiquidVolumeMl(syrTgt, wb.sim.environment) > 0.02) {
          wb.dragState.pipetteTargetId = syrTgt.id;
          wb.dropTargetVesselId = syrTgt.id;
          item.tiltAngle = -0.14;
          item.hoveredActionLabel =
            wb.langCode === 'vi' ? '🧪 Hút từ Syringe (≤10 mL)' : '🧪 Draw from Syringe';
        } else {
          wb.dragState.pipetteTargetId = null;
          wb.dropTargetVesselId = null;
          item.tiltAngle = 0;
          item.hoveredActionLabel = null;
        }
      }

      const rect = wb._getCanvasRect();
      const isOutsideCanvas =
        clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
      if (isOutsideCanvas) {
        wb._extHoverWasOutside = true;
        const dragItemsList = wb.dragState?.groupMembers?.length > 1
          ? wb.dragState.groupMembers.map((m) => m.item).filter(Boolean)
          : [item];
        wb.callbacks.onExternalTabDragHover?.(clientX, clientY, item, dragItemsList);
      } else if (wb._extHoverWasOutside) {
        wb._extHoverWasOutside = false;
        wb.callbacks.onExternalTabDragHover?.(0, 0, null, null);
      }
      wb.sim.recomputeScaleReadings();
    };

    wb.canvas.addEventListener('pointermove', (e) => {
      wb._pendingPointerMove = { clientX: e.clientX, clientY: e.clientY };
      if (!wb._moveRafId) {
        // Leading-edge execution once per frame, coalescing extra high-Hz moves to the next rAF
        const pm = wb._pendingPointerMove;
        wb._pendingPointerMove = null;
        runPointerMove(pm.clientX, pm.clientY);
        wb._moveRafId = requestAnimationFrame(() => {
          wb._moveRafId = 0;
          const queued = wb._pendingPointerMove;
          wb._pendingPointerMove = null;
          if (queued) runPointerMove(queued.clientX, queued.clientY);
        });
      }
    });

    const endDrag = (e) => {
      if (wb._moveRafId) {
        cancelAnimationFrame(wb._moveRafId);
        wb._moveRafId = 0;
      }
      const queuedMove = wb._pendingPointerMove;
      wb._pendingPointerMove = null;
      if (
        queuedMove &&
        (wb.dragState || wb.marqueeState || wb.panDragState || wb.portDragState || wb.standResizeState || wb.tubeTipDragState)
      ) {
        runPointerMove(queuedMove.clientX, queuedMove.clientY);
      }
      wb._canvasRect = null;
      if (wb._extHoverWasOutside) {
        wb._extHoverWasOutside = false;
        wb.callbacks.onExternalTabDragHover?.(0, 0, null, null);
      }
      if (wb.standResizeState) {
        wb.standResizeState = null;
        wb.canvas.style.cursor = 'default';
        if (e?.pointerId != null && wb.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            wb.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        wb.sim.emitChange();
        return;
      }
      if (wb.tubeTipDragState) {
        wb.tubeTipDragState = null;
        wb.canvas.style.cursor = 'default';
        if (e?.pointerId != null && wb.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            wb.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        wb.sim.emitChange();
        return;
      }
      if (wb.marqueeState) {
        wb.marqueeState = null;
        wb.canvas.style.cursor = 'default';
        if (e?.pointerId != null && wb.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            wb.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        wb.callbacks.onSelect?.(wb.sim.getItem(wb.sim.selectedId));
        return;
      }
      if (wb.panDragState) {
        wb.panDragState = null;
        wb.canvas.style.cursor = wb.zoomScale > 1.02 ? 'grab' : wb.zoomMode ? 'zoom-in' : 'default';
        if (e?.pointerId != null && wb.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            wb.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        return;
      }
      if (wb.portDragState) {
        const pd = wb.portDragState;
        wb.portDragState = null;
        wb.dropTargetVesselId = null;
        wb.canvas.style.cursor = 'default';
        const src = wb.sim.getItem(pd.condId);
        const vTgt = wb.findVesselAt(pd.x, pd.y, pd.condId, false);
        const syrTgt = wb.findSyringeAt(pd.x, pd.y);
        if (src) {
          if (src.kind === 'condenser') {
            if (vTgt && !vTgt.isShattered) {
              if (pd.port === 'inlet') {
                wb.sim.connectTube(vTgt.id, src.id);
              } else if (pd.port === 'outlet') {
                wb.sim.connectCondenserOutlet(src.id, vTgt.id);
              }
            } else if (!pd.moved) {
              if (pd.port === 'inlet' && src.connectedFromId) {
                wb.sim.disconnectSyringe(src.connectedFromId);
              } else if (pd.port === 'outlet' && src.outletTargetId) {
                wb.sim.connectCondenserOutlet(src.id, null);
              }
            }
          } else if (src.kind === 'gas_syringe' && !src.isBroken) {
            if (pd.moved && vTgt && !vTgt.isShattered && APPARATUS[vTgt.typeId]?.stopperable) {
              wb.sim.connectTube(vTgt.id, src.id);
            } else if (!pd.moved && src.connectedFromId) {
              wb.sim.disconnectSyringe(src.connectedFromId);
            }
          } else if (src.kind === 'vessel' && !src.isShattered) {
            const condTgt = wb.sim.items.find(
              (c) => c.kind === 'condenser' && !c.isBroken && Math.hypot(pd.x - c.x, pd.y - c.y) <= 85
            );
            if (pd.moved) {
              const tSpec = vTgt ? APPARATUS[vTgt.typeId] : null;
              const tgtSide = tSpec?.hasTwoEnds && vTgt ? (pd.x < vTgt.x ? 'left' : 'right') : null;
              if (syrTgt && !syrTgt.isBroken) {
                wb.sim.connectTube(src.id, syrTgt.id, { side: pd.side });
              } else if (condTgt) {
                wb.sim.connectTube(src.id, condTgt.id, { side: pd.side });
              } else if (vTgt && !vTgt.isShattered && vTgt.id !== src.id) {
                wb.sim.connectTube(src.id, vTgt.id, { side: pd.side, targetSide: tgtSide });
              }
            } else if (src.connectedTargetId || src.connectedSyringeId) {
              wb.sim.disconnectSyringe(src.id);
            }
          }
        }
        if (e?.pointerId != null && wb.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            wb.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        wb.sim.emitChange();
        return;
      }

      if (!wb.dragState) return;
      let didStateChange = false;
      try {
        const item = wb.sim.getItem(wb.dragState.itemId);
        const pipTargetId = wb.dragState.pipetteTargetId;
        const dragDist = item ? Math.hypot(item.x - wb.dragState.startX, item.y - wb.dragState.startY) : 0;
        didStateChange = Boolean(
          wb.dragState.undoRecorded ||
          wb.dragState.fullUndoRecorded ||
          (wb.dragState.pouredMl || 0) > 0 ||
          dragDist > 1
        );
        const dropItemsList = wb.dragState.groupMembers?.length > 1
          ? wb.dragState.groupMembers.map((m) => m.item).filter(Boolean)
          : item ? [item] : [];
        if (item && wb.callbacks.onDropToLabTab?.(e.clientX, e.clientY, item, dropItemsList)) {
          didStateChange = true;
          for (const member of wb.dragState.groupMembers || []) {
            if (member.item) member.item.isDragging = false;
          }
          item.isDragging = false;
          if (item.tiltAngle !== undefined) item.tiltAngle = 0;
          return;
        }
        for (const member of wb.dragState.groupMembers || []) {
          const mItem = member.item;
          if (!mItem || mItem.id === item?.id) continue;
          mItem.isDragging = false;
          mItem.vy = 0;
          mItem.fallStartY =
            mItem.clampedToId || mItem.dockedVesselId || mItem.inVesselId || mItem.mountedOnVesselId || mItem.attachedToId
              ? null
              : mItem.y;
        }
        if (item) {
          item.isDragging = false;
          if (item.kind === 'rubber_stopper' && !item.attachedToId) {
            const mTgt = wb.findMouthTargetAt(item.x, item.y, 'stopper');
            if (mTgt) {
              wb._upgradeDragToFullUndo();
              wb.sim.attachRubberStopper(item.id, mTgt.vessel.id, mTgt.side);
              didStateChange = true;
            }
          } else if (item.kind === 'phen_cotton' && !item.attachedToId) {
            const mTgt = wb.findMouthTargetAt(item.x, item.y, 'cotton');
            if (mTgt) {
              wb._upgradeDragToFullUndo();
              wb.sim.attachPhenCotton(item.id, mTgt.vessel.id, mTgt.side);
              didStateChange = true;
            }
          } else if (item.kind === 'stir_bar') {
            const tgt = wb.findVesselAt(item.x, item.y + 10, null, false);
            if (tgt && !tgt.isStoppered) {
              wb._upgradeDragToFullUndo();
              wb.sim.insertStirBarIntoVessel(item.id, tgt.id, 800);
              didStateChange = true;
            }
          } else if (item.kind === 'boiling_chips') {
            const tgt = wb.findVesselAt(item.x, item.y + 10, null, false);
            if (tgt && !tgt.isStoppered) {
              wb._upgradeDragToFullUndo();
              wb.sim.insertBoilingChipsIntoVessel(item.id, tgt.id);
              didStateChange = true;
            }
          } else if (item.kind === 'electrode') {
            const tgt = wb.findVesselAt(item.x, item.y + 10, null, false);
            const tSpec = tgt ? APPARATUS[tgt.typeId] : null;
            const side = tgt && item.x >= tgt.x ? 'right' : 'left';
            if (tgt && !tSpec?.isHorizontalTube) {
              item.dockedVesselId = tgt.id;
              item.dockSide = side;
              syncDockedToolPositions(wb.sim);
              didStateChange = true;
            }
          } else if (item.kind === 'filter_funnel' && !wb.dragState.pourTargetId) {
            const dragMoved = Math.hypot(item.x - wb.dragState.startX, item.y - wb.dragState.startY);
            const tgt = wb.findVesselAt(item.x, item.y + 38, null, false);
            if (tgt && !tgt.isStoppered && Math.abs(item.x - tgt.x) <= 28) {
              // Remount if clicked in place or dropped onto a rim deliberately
              if (dragMoved <= 6 || tgt.id !== wb.dragState.unmountHoldoffId || Math.abs(item.y - (tgt.y - APPARATUS[tgt.typeId].height / 2)) <= 30) {
                item.mountedOnVesselId = tgt.id;
                syncDockedToolPositions(wb.sim);
                if (wb.dragState.unmountHoldoffId !== tgt.id) didStateChange = true;
              }
            }
          } else if (item.kind === 'separatory_funnel' && !wb.dragState.pourTargetId) {
            const dragMoved = Math.hypot(item.x - wb.dragState.startX, item.y - wb.dragState.startY);
            const tgt = wb.findVesselAt(item.x, item.y + 82, item.id, false);
            if (tgt && !tgt.isInverted && Math.abs(item.x - tgt.x) <= 30) {
              const mountY = tgt.y + getSepFunnelMountY(APPARATUS[tgt.typeId], APPARATUS.separatory_funnel);
              if (dragMoved <= 6 || tgt.id !== wb.dragState.unmountHoldoffId || Math.abs(item.y - mountY) <= 56) {
                wb.sim.mountSeparatoryFunnel(item.id, tgt.id);
                if (wb.dragState.unmountHoldoffId !== tgt.id) didStateChange = true;
              }
            }
          }
          if (wb.dragState.unmountHoldoffId && !item.mountedOnVesselId) {
            didStateChange = true;
          }
          item.fallStartY =
            item.clampedToId || item.dockedVesselId || item.inVesselId || item.mountedOnVesselId || item.attachedToId
              ? null
              : item.y;
          item.vy = 0;
          if (wb.dragState.undoRecorded) {
            if (item.clampedToId) soundEngine.playClampClick();
            else if (item.attachedToId && item.kind === 'rubber_stopper') soundEngine.playStopperPop(false);
            else soundEngine.playGlassClink(item.typeId, 0.72);
          }
        }
        if (item && (item.kind === 'vessel' || item.kind === 'filter_funnel' || item.kind === 'separatory_funnel' || item.kind === 'pipette' || item.kind === 'spoon')) {
          if (!APPARATUS[item.typeId]?.isHorizontalTube) {
            item.tiltAngle = 0;
            item.tiltDeg = 0;
            item.tiltDir = 1;
          }
        }
        wb.resetWheelTiltedVessel(null);
        if (item && item.kind === 'wash_bottle') {
          item.isSpraying = false;
          item.manualSprayHold = false;
          item.squirtTimer = 0;
        }
        if (item && item.kind === 'spoon') {
          item.hoveredActionLabel = null;
          const spAct = wb.dragState.spoonAction;
          const spTgtId = wb.dragState.spoonTargetId;
          if (spTgtId && spAct === 'pour') {
            wb._upgradeDragToFullUndo();
            wb.sim.spoonPourIntoVessel(item.id, spTgtId);
            didStateChange = true;
          } else if (spTgtId && spAct === 'scoop') {
            wb._upgradeDragToFullUndo();
            wb.sim.spoonScoopFromVessel(item.id, spTgtId);
            didStateChange = true;
          }
        }
        if (item && item.kind === 'pipette' && !item.isBroken) {
          item.hoveredActionLabel = null;
          if (pipTargetId) {
            const tgt = wb.sim.getItem(pipTargetId);
            const isValidPip =
              tgt &&
              !tgt.isShattered &&
              !tgt.isBroken &&
              (tgt.kind === 'vessel' || tgt.kind === 'separatory_funnel' || tgt.kind === 'filter_funnel' || tgt.kind === 'burette') &&
              (tgt.kind === 'burette' ? true : !tgt.isStoppered);
            if (isValidPip) {
              wb._upgradeDragToFullUndo();
              soundEngine.playDropPlink(0.95);
              if ((item.volumeMl || 0) <= 0.05) {
                wb.sim.pipetteDrawFromVessel(tgt.id, item.capacityMl || 10.0, item);
              } else {
                wb.sim.pipetteDispenseToVessel(tgt.id, item.dropDoseMl || 1.0, item);
              }
              didStateChange = true;
              const tSpec = APPARATUS[tgt.typeId];
              const pSpec = APPARATUS[item.typeId];
              const parkRightX = tgt.x + tSpec.width / 2 + 26;
              const parkLeftX = tgt.x - tSpec.width / 2 - 26;
              item.x = parkRightX <= BENCH_LOGICAL_W - 45 ? parkRightX : Math.max(45, parkLeftX);
              item.y = BENCH_FLOOR_Y - pSpec.height / 2 + 2;
              item.fallStartY = null;
            } else if (tgt && tgt.kind === 'gas_syringe' && !tgt.isBroken && (item.volumeMl || 0) <= 0.05) {
              wb._upgradeDragToFullUndo();
              wb.sim.pipetteDrawFromSyringe(tgt.id, item.capacityMl || 10.0, item);
              didStateChange = true;
              const pSpec = APPARATUS[item.typeId];
              const syrG = getSyringeGeometry(tgt);
              item.x = Math.max(45, Math.min(BENCH_LOGICAL_W - 45, syrG.nozzleX - syrG.barrelDir * 24));
              item.y = BENCH_FLOOR_Y - pSpec.height / 2 + 2;
              item.fallStartY = null;
            }
          }
        }
      } finally {
        wb.dragState = null;
        wb.dropTargetVesselId = null;
        wb.canvas.style.cursor = 'default';
        if (e?.pointerId != null && wb.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            wb.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        if (didStateChange) {
          wb.sim.updateSupportAttachments();
          wb.sim.emitChange();
        }
      }
    };

    wb.canvas.addEventListener('pointerup', endDrag);
    wb.canvas.addEventListener('pointercancel', endDrag);
    wb.canvas.addEventListener('lostpointercapture', endDrag);
    window.addEventListener('blur', endDrag);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (wb.pickState) {
          wb.cancelItemPick();
        } else if (wb.zoomMode || wb.zoomScale > 1.02) {
          wb.toggleZoomMode(false);
        }
      }
    });

    wb.canvas.addEventListener(
      'wheel',
      (e) => {
        const pt = wb.clientToLogical(e.clientX, e.clientY);
        if (e.ctrlKey && !e.metaKey) {
          const heldItem = wb.dragState ? wb.sim.getItem(wb.dragState.itemId) : null;
          const hit = heldItem || wb.hitTestItem(pt.x, pt.y);
          const hSpec = hit ? APPARATUS[hit.typeId] : null;
          if (hit && (hSpec?.invertible || hSpec?.flippable)) {
            e.preventDefault();
            if (wb._wheelAccum.key !== `ctrl-flip:${hit.id}`) wb._wheelAccum = { key: `ctrl-flip:${hit.id}`, sum: 0 };
            wb._wheelAccum.sum += e.deltaY;
            if (Math.abs(wb._wheelAccum.sum) >= 60) {
              wb._wheelAccum.sum = 0;
              soundEngine.playUiClick();
              if (hSpec.invertible) {
                wb.sim.toggleVesselInverted(hit.id);
              } else {
                wb.sim.flipItemLR(hit.id);
              }
            }
            return;
          }
        }
        if (!wb.zoomMode && wb.zoomScale <= 1.01 && !e.ctrlKey && !e.metaKey) {
          if (wb.handleCanvasWheel(pt, e.deltaY, Boolean(e.shiftKey))) {
            e.preventDefault();
          }
          return;
        }
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        const nextScale = Math.max(1.0, Math.min(4.2, wb.zoomScale * factor));
        const rect = wb.canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const baseX = (cx - wb.viewOffsetX) / wb.viewScale;
        const baseY = (cy - wb.viewOffsetY) / wb.viewScale;
        const nextCx = pt.x - (baseX - BENCH_LOGICAL_W * 0.5) / nextScale;
        const nextCy = pt.y - (baseY - BENCH_LOGICAL_H * 0.5) / nextScale;
        if (nextScale > 1.01 && !wb.zoomMode) wb.zoomMode = true;
        wb.setZoomView(nextScale, nextCx, nextCy);
      },
      { passive: false }
    );

    // HTML5 Drag & Drop from Shelf onto Bench (always accept dropEffect copy; zero 'none' blocks)
    wb.canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const pt = wb.clientToLogical(e.clientX, e.clientY);
      const v = wb.findVesselAt(pt.x, pt.y, null, true);
      wb.dropTargetVesselId = v ? v.id : null;
    });

    wb.canvas.addEventListener('dragleave', () => {
      wb.dropTargetVesselId = null;
    });

    wb.canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      const dt = e.dataTransfer;
      let reagentId = dt?.getData('text/reagent-id') || '';
      let apparatusId = dt?.getData('text/apparatus-id') || '';
      if (!reagentId && !apparatusId) {
        const plain = dt?.getData('text/plain') || '';
        if (plain.startsWith('reagent:')) reagentId = plain.slice(8);
        else if (plain.startsWith('apparatus:')) apparatusId = plain.slice(10);
      }
      if (apparatusId) {
        wb.dropFromShelf(e.clientX, e.clientY, 'apparatus', apparatusId);
      } else if (reagentId) {
        wb.dropFromShelf(e.clientX, e.clientY, 'reagent', reagentId);
      } else {
        wb.dropTargetVesselId = null;
      }
    });
}

export function tickInteractivePourImpl(wb, realDeltaSec) {
    if (!wb.dragState) return;
    const src = wb.sim.getItem(wb.dragState.itemId);
    if (!src) return;

    // Smoothly track user's wheel tilt angle while holding tool/vessel (condenser uses rotationDeg independently)
    if (src.kind === 'vessel' || src.kind === 'filter_funnel' || src.kind === 'spoon') {
      const targetTilt =
        wb.dragState.pourTargetId
          ? wb.dragState.targetTilt || 0
          : (src.tiltDir < 0 ? -1 : 1) * (((src.tiltDeg || 0) * Math.PI) / 180);
      if (src.kind !== 'spoon' || (src.tiltDeg || 0) > 0.1 || !wb.dragState.spoonAction) {
        src.tiltAngle = targetTilt;
      }
    }

    if (!wb.dragState.pourTargetId) return;
    const dst = wb.sim.getItem(wb.dragState.pourTargetId);
    if (!dst) return;

    const absTilt = Math.abs(src.tiltAngle || 0);
    if (absTilt <= 0.10) return;

    const srcSpec = APPARATUS[src.typeId] || APPARATUS.beaker_250;
    const srcLiqMl = computeLiquidVolumeL(src.moles, src.tempK) * 1000;
    const hasDrySolids =
      srcSpec.isMortar &&
      srcLiqMl <= 0.05 &&
      Object.values(src.moles || {}).some((n) => n > 1e-8);
    if (srcLiqMl <= 0.02 && !hasDrySolids) return;
    if (hasDrySolids && dst.kind === 'vessel') {
      wb._upgradeDragToFullUndo();
      wb.sim.transferSolidsToVessel(src.id, dst.id, 1.0);
      wb.dragState.pourTargetId = null;
      return;
    }

    // Steady realistic gravity flow calibrated to neck width, tilt progression & smooth low-volume tail
    const isNarrowNeck =
      srcSpec.shape === 'erlenmeyer' || srcSpec.shape === 'round_flask' || srcSpec.shape === 'test_tube' || srcSpec.shape === 'cylinder';
    const baseMaxRateMlS = isNarrowNeck ? 8.5 : 12.0;
    const tiltFrac = Math.pow(Math.min(1, (absTilt - 0.10) / 0.46), 1.35);
    const tailFactor = srcLiqMl < 5.0 ? Math.max(0.18, srcLiqMl / 5.0) : 1.0;
    const alignFactor = wb.dragState.pourAlignFactor ?? 1.0;
    const flowRateMlS = baseMaxRateMlS * tiltFrac * tailFactor * alignFactor;

    // Physical hand-tilted decanting: settled dense solids remain behind unless previously stirred
    wb._upgradeDragToFullUndo();
    const poured = wb.sim.pourBetweenVessels(src.id, dst.id, flowRateMlS * realDeltaSec, false, { silentUndo: true });
    if (poured > 0) {
      wb.dragState.pouredMl += poured;
      const srcLiqL = computeLiquidVolumeL(src.moles, src.tempK);
      const color = computeSolutionVisuals(
        src.moles,
        srcLiqL,
        computePH(src.moles, srcLiqL, src.tempK),
        srcSpec.opticalPathCm || 6.5,
        src.phenBleachFrac,
        src.phenIrrevFrac || 0
      ).css;
      const dstSpec = APPARATUS[dst.typeId] || APPARATUS.beaker_250;
      const tiltDir = (src.tiltAngle || 0) < 0 ? -1 : 1;
      const lipSpan = Math.min(28, (srcSpec.neckRadius || srcSpec.width * 0.35) * 0.85);
      wb.sim.activePourStream = {
        fromX: src.x + tiltDir * lipSpan,
        fromY: src.y - srcSpec.height * 0.34,
        toX: dst.x,
        toY: dst.y - dstSpec.height * 0.25,
        color,
        rateMlS: flowRateMlS,
        timer: 0.12,
        pouredMl: wb.dragState.pouredMl,
      };
    }
}

