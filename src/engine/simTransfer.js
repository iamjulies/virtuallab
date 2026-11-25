/**
 * Chemical Transfer, Pouring, Pipette, Burette & Syringe Delivery Helpers (Refactor 81).
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
import { getActiveMissionPolicy, isReagentAllowedInMission } from '../data/missions.js';
import { applyPresetScenario } from '../data/presets.js';
import { ensureMissionTelemetry } from './missionEvaluator.js';
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

import { SIM_BENCH_FLOOR_Y } from './simSnapshot.js';

const createEmptyGasMap = createZeroGasMap;

export function getVesselBrimVolumeMl(spec) {
  return spec.geometry ? spec.geometry.maxVolumeMl * 0.96 : spec.maxVolumeMl * 1.15;
}

/**
 * Shared stoichiometric fraction transfer of liquid/aqueous species (and optionally suspended precipitate).
 */
export function moveFluidFraction(srcMoles, srcSettleMap, fracRemove, dstMoles = null, includeSuspendedPpt = true) {
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
export function extractSyringeLiquidFraction(syringe, frac, dstMoles = null) {
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


export function spoonScoopFromVesselImpl(sim, spoonId, vesselId, maxGrams = 1.6) {
    const spoon = sim.getItem(spoonId);
    const v = sim.getItem(vesselId);
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
    spoon.tempK = v.tempK || sim.environment.tempK;
    sim.recomputeScaleReadings();
    sim.emitChange();
    return true;
}

export function spoonPourIntoVesselImpl(sim, spoonId, vesselId) {
    const spoon = sim.getItem(spoonId);
    const v = sim.getItem(vesselId);
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
      const tMix = (cVessel * v.tempK + cSpoon * (spoon.tempK || sim.environment.tempK)) / (cVessel + cSpoon);
      v.tempK = Math.max(155, Math.min(1950, tMix));
    }
    spoon.moles = {};
    spoon.particleCounts = {};
    spoon.groundPowderMap = {};
    spoon.burnTimer = 0;
    spoon.flameColor = null;
    sim.recomputeScaleReadings();
    sim.recordHistorySnapshot(v, true);
    sim.emitChange();
    return true;
}

export function rinseSpoonImpl(sim, spoonId) {
    const spoon = sim.getItem(spoonId);
    if (!spoon || spoon.kind !== 'spoon') return false;
    spoon.spoonAnim = null;
    spoon.tiltAngle = 0;
    spoon.moles = {};
    spoon.particleCounts = {};
    spoon.groundPowderMap = {};
    spoon.burnTimer = 0;
    spoon.flameColor = null;
    spoon.tempK = sim.environment.tempK;
    sim.emitChange();
    return true;
}

export function stepSpoonAnimationsImpl(sim, dt) {
    if (!dt || dt <= 0) return;
    const smoothstep = (u) => {
      const c = Math.max(0, Math.min(1, u));
      return c * c * (3 - 2 * c);
    };
    for (const spoon of sim.items) {
      if (spoon.kind !== 'spoon' || !spoon.spoonAnim || spoon.isDragging) continue;
      const anim = spoon.spoonAnim;
      const v = sim.getItem(anim.vesselId);
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
            sim.spoonScoopFromVessel(spoon.id, v.id, anim.targetG);
            sim.visualHooks.onAlert?.('spoon_scoop', v, { color: spCol, x: v.x, y: v.y });
          } else {
            sim.spoonPourIntoVessel(spoon.id, v.id);
            sim.visualHooks.onAlert?.('spoon_pour', v, {
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
        sim.updateSupportAttachments();
        sim.emitChange();
      }
    }
}

export function deliverSyringeSliceToVesselImpl(sim, syr, dst, liqMoveFrac, gasMoveFrac, syrT, dtApprox = 0.05) {
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
        if (dst.tempK < waterBoilingPointK(sim.environment.pressureBar)) {
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
        const volMlS = (((pushedNonSteamMol * CONSTANTS.R_L_BAR_MOL_K * syrT) / Math.max(0.2, sim.environment.pressureBar)) * 1000) / Math.max(0.01, dtApprox);
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
        dst.tempK = Math.min(waterBoilingPointK(sim.environment.pressureBar), dst.tempK + heatAddedJ / Math.max(30, cDst + addedCapJK));
      }
    }
    sim.checkOverflow(dst);
    return movedLiqColor;
}

export function pumpSyringeToVesselImpl(sim, syringeId, targetVesselId, targetVolMl = null) {
    const syr = sim.getItem(syringeId);
    const dst = sim.getItem(targetVesselId);
    if (!syr || syr.kind !== 'gas_syringe' || syr.isBroken) return 0;
    if (!dst || dst.kind !== 'vessel' || dst.isShattered) return 0;
    // Keep tubing intact if pumping into the already connected vessel! Only detach if targeting a separate flask manually.
    if (syr.connectedFromId && syr.connectedFromId !== dst.id) sim.disconnectSyringe(syr.connectedFromId);

    const syrT = syr.tempK ?? sim.environment.tempK;
    const liqMl = computeSyringeLiquidVolumeMl(syr, sim.environment);
    const gasMl = computeSyringeGasVolumeMl(syr, sim.environment);
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

    const visCss = sim._deliverSyringeSliceToVessel(syr, dst, liqMoveFrac, gasMoveFrac, syrT, 0.25);
    if (liqMoveFrac > 0 && syr.connectedFromId !== dst.id) {
      sim.activePourStream = {
        fromX: getSyringeGeometry(syr).nozzleX,
        fromY: syr.y,
        toX: dst.x,
        toY: dst.y - APPARATUS[dst.typeId].height * 0.28,
        color: visCss,
        timer: 0.35,
        pouredMl: liqMl * liqMoveFrac,
      };
    }
    sim.recomputeScaleReadings();
    sim.emitChange();
    return transferredMl;
}

export function stepSyringeDischargeImpl(sim, syringe, dt) {
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

    const liqMl = computeSyringeLiquidVolumeMl(syringe, sim.environment);
    const gasMl = computeSyringeGasVolumeMl(syringe, sim.environment);
    const totalMl = liqMl + gasMl;
    if (totalMl <= 0.002) {
      syringe.isDischarging = false;
      syringe.autoDischargeTimer = 0;
      syringe.dischargeLiquidRateMlS = 0;
      syringe.dischargeArc = null;
      return;
    }

    const syrT = syringe.tempK ?? sim.environment.tempK;
    const connectedDst = syringe.connectedFromId ? sim.getItem(syringe.connectedFromId) : null;
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
      const movedColor = sim._deliverSyringeSliceToVessel(syringe, connectedDst, fracLiq, fracGas, syrT, dt);
      syringe.dischargeLiquidRateMlS = pushLiqMl > 1e-4 ? pushLiqMl / Math.max(1e-4, dt) : 0;
      syringe.dischargeColor = movedColor;
      return;
    }

    const arc = computeSyringeDischargeArc(
      syringe,
      sim.items,
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
        sim.checkOverflow(catchDst);
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

    if (sim.visualHooks.onParticlesNeeded && (pushLiqMl > 1e-4 || pushGasMl > 1e-4)) {
      sim.visualHooks.onParticlesNeeded(syringe, {
        dischargeLiquidRateMlS: syringe.dischargeLiquidRateMlS || 0,
        dischargeColor: liqColor,
        dischargeArc: arc,
        dischargeGasRates: gasRates,
        gasTempK: syrT,
      });
    }
}

export function addReagentToVesselImpl(sim, vesselId, reagentId, amount, options = {}) {
    const v = sim.getItem(vesselId);
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
    if (!v || !reg || v.isShattered || v.isBroken) return false;
    if (!options?.bypassMissionLock && sim.missionState?.active) {
      const policy = getActiveMissionPolicy(sim);
      if (policy && !isReagentAllowedInMission(policy, reg.id)) {
        if (!options?.silentEmit) {
          sim.addLog({ type: 'alert', key: 'missionLockedShelfTip' });
          sim.emitChange();
        }
        return false;
      }
    }
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
            sim.addLog({ type: 'alert', key: 'alertOverflow', vesselLabel: v.label });
          }
          return false;
        }
        if (amt > maxFitG) {
          amt = maxFitG;
          if (!options?.silentEmit) {
            sim.addLog({ type: 'alert', key: 'alertOverflow', vesselLabel: v.label });
          }
        }
      }
    }
    if (amt <= 0) return false;
    if (sim.missionState?.active && v.hideComposition && reg.id !== 'phen' && reg.id !== 'h2o') {
      const tel = ensureMissionTelemetry(sim);
      if (!tel.contaminatedBlindIds.includes(v.id)) tel.contaminatedBlindIds.push(v.id);
    }
    if (!options?.silentUndo && !options?.silentEmit) sim.recordUndo();

    // Thermal capacity & ethanol-water excess enthalpy baseline before addition
    const cOld = computeHeatCapacityJK(v);
    const tOld = v.tempK;
    const hMixBefore = computeEthanolWaterExcessEnthalpyJ(v.moles.H2O_l || 0, v.moles.C2H5OH_l || 0, tOld);
    const liqBeforeMl = computeLiquidVolumeL(v.moles, tOld) * 1000;
    const coldSplashShock =
      reg.kind === 'liquid' &&
      (APPARATUS[v.typeId]?.maxThermalStressK || 783) < 1100 &&
      tOld >= 463.15 &&
      sim.environment.tempK <= 305 &&
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
      } else if (
        (v.moles.H2SO4_l || 0) >= 0.04 &&
        (v.moles.H2O_l || 0) < (v.moles.H2SO4_l || 0) * 2.5 &&
        amt >= 1.5
      ) {
        if (reg.id === 'h2o') {
          sim.addLog({ type: 'alert', key: 'alertWaterIntoConcAcid', vesselLabel: v.label });
          dilutionHeatJ += Math.min(8500, amt * 360);
          v.stirTimer = Math.max(v.stirTimer || 0, 1.4);
          applySurfaceImpulse(v, 0.9, 0.35);
        } else if (
          reg.id === 'etoh' ||
          reg.id === 'c2h5oh' ||
          reg.id === 'ch3oh' ||
          reg.id === 'ch3cooh' ||
          (reg.perMl?.C2H5OH_l || 0) * amt >= 0.01 ||
          (reg.perMl?.CH3OH_l || 0) * amt >= 0.01 ||
          (reg.perMl?.CH3COOH_l || 0) * amt >= 0.01 ||
          (reg.perMl?.H2O_l || 0) * amt >= 1.5
        ) {
          sim.addLog({ type: 'alert', key: 'alertEsterConcAcidPour', vesselLabel: v.label });
          dilutionHeatJ += Math.min(6200, amt * 240);
          v.stirTimer = Math.max(v.stirTimer || 0, 1.4);
          applySurfaceImpulse(v, 0.8, 0.3);
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
      if (options.fine && reg.id !== 'albumin') {
        v.groundPowderMap = v.groundPowderMap || {};
        v.groundPowderMap[reg.speciesId] = true;
        if (v.flattenedMetalMap?.[reg.speciesId]) delete v.flattenedMetalMap[reg.speciesId];
      }
    }

    // Mix thermal energy with reagent starting at ambient T_env
    const tAdd = sim.environment.tempK;
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
      sim.shatterVessel(v, 'alertThermalShock', 'thermal_shock');
      if (!options.silentEmit) sim.emitChange();
      return true;
    }

    if (!options.silentAnim) {
      const isSolid = reg.kind === 'solid';
      const dur = isSolid ? 1050 : amt <= 0.25 ? 650 : 1100;
      sim.activeReagentTransfer = {
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
      if (sim.visualHooks.onReagentDispense) {
        sim.visualHooks.onReagentDispense(v, reg, amt, options);
      }
    }

    if (v.kind === 'vessel' || v.kind === 'filter_funnel' || v.kind === 'separatory_funnel') {
      sim.checkOverflow(v);
      v.liquidStratification = computePhaseStratification(
        v.moles,
        v.tempK,
        APPARATUS[v.typeId] || APPARATUS.beaker_250,
        computeSolidVolumeMl(v.moles)
      );
    }
    sim.recomputeScaleReadings();
    if (v.kind === 'vessel') {
      sim.recordHistorySnapshot(v, true);
    }
    if (!options.silentEmit) sim.emitChange();
    return true;
}

export function stepTimedTransfersInnerImpl(sim, nowMsOverride = null) {
    const nowMs = nowMsOverride ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const remaining = [];
    let anyCompleted = false;

    for (const job of sim.timedTransfers) {
      const p = Math.max(0, Math.min(1, (nowMs - job.startMs) / Math.max(1, job.durationMs)));
      if (job.kind === 'reagent') {
        const dst = sim.getItem(job.vesselId);
        if (!dst || dst.isShattered) continue;
        // Pour flows smoothly inside [0.12 .. 0.90] matching glass-rod pouring animation window
        const frac = p <= 0.12 ? 0 : p >= 0.90 ? 1 : (p - 0.12) / 0.78;
        const targetAdded = job.totalAmt * frac;
        const delta = targetAdded - job.addedAmt;
        if (delta > 1e-5) {
          sim.addReagentToVessel(job.vesselId, job.reagentId, delta, {
            silentAnim: true,
            silentEmit: p < 0.999,
          });
          job.addedAmt += delta;
        }
        if (p < 0.999) remaining.push(job);
        else anyCompleted = true;
      } else if (job.kind === 'vessel') {
        const src = sim.getItem(job.sourceId);
        const dst = sim.getItem(job.targetId);
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
          const moved = sim.pourBetweenVessels(src.id, dst.id, delta, job.shakeBeforePour, {
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
            sim.pourBetweenVessels(src.id, dst.id, remLiqMl + 0.2, job.shakeBeforePour, {
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
    sim.timedTransfers = remaining;
    if (anyCompleted) sim.emitChange();
}

export function pourBetweenVesselsImpl(sim, sourceId, targetId, volumeMl, shakeBeforePour = false, streamOpts = {}) {
    const src = sim.getItem(sourceId);
    let dst = sim.getItem(targetId);
    if (!src || !dst || src.id === dst.id || src.isShattered || dst.isShattered || src.isBroken || dst.isBroken) return 0;
    // Redirect pouring into a mounted Filter Funnel sitting inside target vessel's mouth
    if (dst.kind === 'vessel' && src.kind !== 'filter_funnel') {
      const mountedFunnel = sim.items.find(
        (f) => f.kind === 'filter_funnel' && !f.isBroken && (f.mountedOnVesselId === dst.id || f.restingOnId === dst.id)
      );
      if (mountedFunnel && mountedFunnel.id !== src.id) {
        dst = mountedFunnel;
        targetId = mountedFunnel.id;
      }
    }
    const dstValid = dst.kind === 'vessel' || dst.kind === 'filter_funnel' || dst.kind === 'separatory_funnel' || dst.kind === 'burette';
    if (!dstValid) return 0;
    if (!streamOpts?.silentUndo && !streamOpts?.pouredMlTotal) sim.recordUndo();

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
        const moved = sim.withUndoSuppressed(() => sim.transferSolidsToVessel(sourceId, targetId, 1.0));
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

    if (sim.missionState?.active) {
      const tel = ensureMissionTelemetry(sim);
      const blindIds = sim.missionState.setupData?.blindVesselIds || [];
      if (blindIds.includes(dst.id) && src.id !== dst.id) {
        if (!tel.contaminatedBlindIds.includes(dst.id)) tel.contaminatedBlindIds.push(dst.id);
      } else if (src.hideComposition && dst.kind === 'vessel') {
        const sLbl = src.blindLabel || src.label || '?';
        if (dstLiqBeforeMl <= 0.05) {
          dst.hideComposition = true;
          dst.blindLabel = sLbl;
        } else if (dst.hideComposition) {
          const curLbl = dst.blindLabel || dst.label || '?';
          if (!curLbl.includes(sLbl)) dst.blindLabel = `${curLbl} + ${sLbl}`.slice(0, 18);
        }
        tel.usedPipetteTransfer = true;
        if (!tel.sampledBlindLabels.includes(sLbl)) tel.sampledBlindLabels.push(sLbl);
      }
    }

    const hMixDstAfter = computeEthanolWaterExcessEnthalpyJ(dst.moles.H2O_l || 0, dst.moles.C2H5OH_l || 0, dstTempBefore);
    const mixHeatJ = Math.max(0, hMixDstBefore + frac * hMixSrcBefore - hMixDstAfter);
    if (
      dst.kind === 'vessel' &&
      (dst.moles.H2SO4_l || 0) >= 0.05 &&
      (dst.moles.H2O_l || 0) < (dst.moles.H2SO4_l || 0) * 2.5 &&
      actualMl >= 3.0
    ) {
      if ((src.moles.H2O_l || 0) * frac > (src.moles.H2SO4_l || 0) * frac * 4.0 + 0.1) {
        sim.addLog({ type: 'alert', key: 'alertWaterIntoConcAcid', vesselLabel: dst.label });
      } else if (
        ((src.moles.C2H5OH_l || 0) + (src.moles.CH3OH_l || 0) + (src.moles.CH3COOH_l || 0)) * frac >
        (src.moles.H2SO4_l || 0) * frac * 2.0 + 0.03
      ) {
        sim.addLog({ type: 'alert', key: 'alertEsterConcAcidPour', vesselLabel: dst.label });
      }
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
      sim.shatterVessel(dst, 'alertThermalShock', 'thermal_shock');
      return actualMl;
    }

    // Trigger subtle pour stream visual
    const dstSpec = APPARATUS[dst.typeId];
    if (!streamOpts.silentStream) {
      sim.activePourStream = {
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

    if (dst.kind === 'vessel') sim.checkOverflow(dst);
    dst.liquidStratification = computePhaseStratification(
      dst.moles,
      dst.tempK,
      APPARATUS[dst.typeId] || APPARATUS.beaker_250,
      computeSolidVolumeMl(dst.moles)
    );
    sim.recomputeScaleReadings();
    if (!streamOpts.silentEmit) sim.emitChange();
    return actualMl;
}

export function transferSolidsToVesselImpl(sim, sourceId, targetId, fraction = 1.0) {
    const src = sim.getItem(sourceId);
    const dst = sim.getItem(targetId);
    if (!src || !dst || src.isShattered || dst.isShattered || dst.kind !== 'vessel') return 0;
    sim.recordUndo();
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
    sim.recomputeScaleReadings();
    if (totalMol > 0) sim.emitChange();
    return totalMol;
}

export function buretteDispenseDropImpl(sim, buretteId, dropMl = 0.05) {
    const b = sim.getItem(buretteId);
    if (!b || b.kind !== 'burette') return 0;
    const liqL = computeLiquidVolumeL(b.moles, b.tempK);
    const liqMl = liqL * 1000;
    const actualMl = Math.min(liqMl, dropMl);
    if (actualMl <= 1e-5) return 0;
    const frac = Math.min(1, actualMl / liqMl);
    const tipY = b.y + (APPARATUS.burette_50?.height || 204) / 2;
    let target = null;
    let bestY = Infinity;
    for (const v of sim.items) {
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
    if (target) {
      target.buretteDeliveredMl = (target.buretteDeliveredMl || 0) + actualMl;
    }
    if (sim.missionState?.active) {
      const tel = ensureMissionTelemetry(sim);
      tel.usedBuretteDrops = (tel.usedBuretteDrops || 0) + 1;
    }
    const vis = computeSolutionVisuals(b.moles, liqL, computePH(b.moles, liqL, b.tempK), 2.0, b.phenBleachFrac || 0, b.phenIrrevFrac || 0);
    const tSpec = target ? APPARATUS[target.typeId] : null;
    const stopY = target && tSpec ? target.y - tSpec.height * 0.22 : SIM_BENCH_FLOOR_Y;
    if (sim.visualHooks.onAlert) {
      sim.visualHooks.onAlert('burette_drop', b, {
        tipX: b.x,
        tipY,
        stopY,
        catchX: target ? target.x : null,
        color: vis.css || 'rgba(186, 230, 253, 0.92)',
        actualMl,
      });
    }
    sim.recomputeScaleReadings();
    sim.emitChange();
    return actualMl;
}

export function washBottleSquirtImpl(sim, bottleId, targetId = null, volMl = 5.0) {
    const wb = sim.getItem(bottleId);
    if (!wb || wb.kind !== 'wash_bottle' || (wb.waterMl || 0) <= 0.1) return 0;
    const actual = Math.min(wb.waterMl, volMl);
    const arc = computeWashBottleStreamArc(wb, sim.items, SIM_BENCH_FLOOR_Y, CONSTANTS.GRAVITY_PX_S2 || 1800);
    const explicitTgt = targetId ? sim.getItem(targetId) : null;
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
    sim.recomputeScaleReadings();
    sim.emitChange();
    return actual;
}

export function pipetteDrawFromVesselImpl(sim, vesselId, drawMl = 10.0, targetPipette = null) {
    const src = sim.getItem(vesselId);
    const pip = targetPipette || sim.pipette;
    const isValidSrc =
      src &&
      (src.kind === 'vessel' || src.kind === 'separatory_funnel' || src.kind === 'filter_funnel' || src.kind === 'burette') &&
      !src.isShattered &&
      !src.isBroken &&
      (src.kind === 'burette' ? true : !src.isStoppered);
    if (!isValidSrc || !pip || pip.isBroken) return 0;
    const cap = pip.capacityMl || 10.0;
    const availRoom = cap - (pip.volumeMl || 0);
    if (availRoom <= 0.01) return 0;

    const srcLiqL = computeLiquidVolumeL(src.moles, src.tempK);
    const srcLiqMl = srcLiqL * 1000;
    if (srcLiqMl <= 0.01) return 0;

    const srcSpec = APPARATUS[src.typeId] || APPARATUS.beaker_250;
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
    const pipLiqL = computeLiquidVolumeL(pip.moles, pip.tempK);
    pip.volumeMl = Math.min(cap, Math.max(oldVol + actual, pipLiqL * 1000));
    const vis = computeSolutionVisuals(
      pip.moles,
      Math.max(1e-5, pipLiqL),
      computePH(pip.moles, pipLiqL, pip.tempK),
      1.6,
      pip.phenBleachFrac,
      pip.phenIrrevFrac || 0
    );
    pip.liquidStratification = computePhaseStratification(pip.moles, pip.tempK, APPARATUS.pipette_10, 0);
    pip.sourceLabel = oldVol > 0.05 ? `${pip.sourceLabel || ''} + ${src.label}`.slice(0, 28) : `${srcSpec.id} ${src.label}`;
    pip.liquidColor = vis.css;
    if (src.hideComposition) {
      const sLbl = src.blindLabel || src.label || '?';
      pip.hideComposition = oldVol <= 0.05 ? true : Boolean(pip.hideComposition);
      pip.blindLabel = oldVol > 0.05 && pip.blindLabel ? `${pip.blindLabel}+${sLbl}`.slice(0, 18) : sLbl;
      pip.sourceLabel = pip.blindLabel;
      if (sim.missionState?.active) {
        const tel = ensureMissionTelemetry(sim);
        tel.usedPipetteTransfer = true;
        if (!tel.sampledBlindLabels.includes(sLbl)) tel.sampledBlindLabels.push(sLbl);
      }
    } else if (oldVol <= 0.05) {
      pip.hideComposition = false;
      pip.blindLabel = null;
    }
    if (src.kind === 'separatory_funnel' || src.kind === 'burette') {
      src.liquidStratification = computePhaseStratification(src.moles, src.tempK, srcSpec, computeSolidVolumeMl(src.moles));
    }

    if (pip.kind === 'pipette') {
      pip.drawAnimTimer = 0.68;
      pip.drawAnimColor = vis.css;
      pip.drawFromX = src.x;
      pip.drawFromY = src.y - srcSpec.height * 0.15;
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('pipette_suck', src, {
          pipette: pip,
          color: vis.css,
          liquidMl: actual,
        });
      }
    }

    sim.recomputeScaleReadings();
    sim.emitChange();
    return actual;
}

export function pipetteDrawFromSyringeImpl(sim, syringeId, drawMl = 10.0, targetPipette = null) {
    const syr = sim.getItem(syringeId);
    const pip = targetPipette || sim.pipette;
    if (!syr || syr.kind !== 'gas_syringe' || syr.isBroken || !pip || pip.isBroken) return 0;
    const cap = pip.capacityMl || 10.0;
    const availRoom = cap - (pip.volumeMl || 0);
    if (availRoom <= 0.01) return 0;

    const syrT = syr.tempK ?? sim.environment.tempK;
    const syrLiqMl = computeSyringeLiquidVolumeMl(syr, sim.environment);
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
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('pipette_suck', { x: pip.drawFromX, y: pip.drawFromY }, {
          pipette: pip,
          color: vis.css,
          liquidMl: actual,
        });
      }
    }

    sim.recomputeScaleReadings();
    sim.emitChange();
    return actual;
}

export function pipetteDrawFromReagentImpl(sim, reagentId, drawMl = 2.0) {
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId && r.kind === 'liquid');
    if (!reg) return 0;

    // Create or reuse an unemptied/available Pipette 10 mL directly on the bench
    let pip = sim.items.find((it) => it.kind === 'pipette' && (it.capacityMl - (it.volumeMl || 0)) > 0.05);
    if (!pip) {
      const pipSpec = APPARATUS.pipette_10;
      pip = sim.createApparatus('pipette_10', 460, 482 - pipSpec.height / 2 + 2);
    }

    const availRoom = pip.capacityMl - (pip.volumeMl || 0);
    const actual = Math.min(availRoom, drawMl);
    if (actual <= 0.01) return 0;

    for (const [spId, molPerMl] of Object.entries(reg.perMl)) {
      pip.moles[spId] = (pip.moles[spId] || 0) + molPerMl * actual;
    }
    const oldVol = pip.volumeMl || 0;
    pip.volumeMl = oldVol + actual;
    pip.tempK = sim.environment.tempK;
    pip.sourceLabel = oldVol > 0.05 ? `${pip.sourceLabel || ''} + ${reg.formula}`.slice(0, 28) : reg.formula;
    const pipLiqL = computeLiquidVolumeL(pip.moles, pip.tempK);
    pip.liquidColor = computeSolutionVisuals(pip.moles, Math.max(1e-5, pipLiqL), computePH(pip.moles, pipLiqL, pip.tempK), 1.6, pip.phenBleachFrac || 0, pip.phenIrrevFrac || 0).css;
    pip.liquidStratification = computePhaseStratification(pip.moles, pip.tempK, APPARATUS.pipette_10, 0);
    pip.drawAnimTimer = 0.55;
    pip.drawAnimColor = pip.liquidColor;
    sim.selectedId = pip.id;
    sim.emitChange();
    return actual;
}

export function pipetteDispenseToVesselImpl(sim, vesselId, dropMl = 0.05, sourcePipette = null) {
    const dst = sim.getItem(vesselId);
    const pip = sourcePipette || sim.pipette;
    const isValidDst =
      dst &&
      (dst.kind === 'vessel' || dst.kind === 'separatory_funnel' || dst.kind === 'filter_funnel' || dst.kind === 'burette') &&
      !dst.isShattered &&
      !dst.isBroken &&
      (dst.kind === 'burette' ? true : !dst.isStoppered);
    if (!isValidDst || !pip || pip.isBroken) return 0;
    if ((pip.volumeMl || 0) <= 1e-5) return 0;

    const dstSpec = APPARATUS[dst.typeId] || APPARATUS.beaker_250;
    let maxHeadroom = pip.volumeMl;
    if (dst.kind === 'burette' || dst.kind === 'separatory_funnel') {
      const capMl = dst.kind === 'burette' ? 50.0 : APPARATUS.separatory_funnel?.maxVolumeMl || 100.0;
      const curDstMl = computeLiquidVolumeL(dst.moles, dst.tempK) * 1000;
      maxHeadroom = Math.max(0, capMl - curDstMl);
    }
    const actual = Math.min(pip.volumeMl, maxHeadroom, Math.max(0.05, dropMl));
    if (actual <= 1e-5) return 0;
    const frac = actual / pip.volumeMl;
    const pipColor = pip.liquidColor || 'rgba(186, 230, 253, 0.85)';

    const cOld = computeHeatCapacityJK(dst);
    const dstEmptyBefore = computeLiquidVolumeL(dst.moles, dst.tempK) * 1000 <= 0.05 && Object.keys(dst.moles || {}).every((k) => (dst.moles[k] || 0) <= 1e-8);
    if (sim.missionState?.active) {
      const tel = ensureMissionTelemetry(sim);
      const blindIds = sim.missionState.setupData?.blindVesselIds || [];
      if (blindIds.includes(dst.id)) {
        if (!tel.contaminatedBlindIds.includes(dst.id)) tel.contaminatedBlindIds.push(dst.id);
      } else if (pip.hideComposition && dst.kind === 'vessel') {
        const pLbl = pip.blindLabel || '?';
        if (dstEmptyBefore) {
          dst.hideComposition = true;
          dst.blindLabel = pLbl;
        } else if (dst.hideComposition) {
          const curLbl = dst.blindLabel || dst.label || '?';
          if (!curLbl.includes(pLbl)) dst.blindLabel = `${curLbl} + ${pLbl}`.slice(0, 18);
        }
        tel.usedPipetteTransfer = true;
      }
    }
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
      dst.tempK = (cOld * dst.tempK + cAdd * (pip.tempK || sim.environment.tempK)) / (cOld + cAdd);
    }
    if (dst.kind === 'vessel') {
      if (((pip.moles?.OH_aq || 0) > 1e-7 || (pip.moles?.NH3_aq || 0) > 1e-7) && (dst.moles.Phenolphthalein_aq || 0) > 1e-8) {
        injectLocalPlume(dst, 'pink', 0.5 + (Math.random() - 0.5) * 0.14, 0.12, 0.95);
      } else if ((pip.moles?.Cu2_aq || 0) > 1e-6) {
        injectLocalPlume(dst, 'copper', 0.5 + (Math.random() - 0.5) * 0.14, 0.14, 0.65);
      }
    } else if (dst.kind === 'separatory_funnel' || dst.kind === 'burette') {
      stepVesselChemistry(dst, 0.04, { environment: sim.environment });
      dst.liquidStratification = computePhaseStratification(dst.moles, dst.tempK, dstSpec, computeSolidVolumeMl(dst.moles));
    }

    pip.volumeMl = Math.max(0, pip.volumeMl - actual);
    if (pip.volumeMl < 1e-4) {
      pip.volumeMl = 0;
      pip.moles = {};
      pip.phenBleachFrac = 0;
      pip.phenIrrevFrac = 0;
      pip.sourceLabel = '';
      pip.liquidColor = null;
      pip.liquidStratification = null;
      pip.hideComposition = false;
      pip.blindLabel = null;
    } else {
      const remL = computeLiquidVolumeL(pip.moles, pip.tempK);
      pip.liquidColor = computeSolutionVisuals(pip.moles, Math.max(1e-5, remL), computePH(pip.moles, remL, pip.tempK), 1.6, pip.phenBleachFrac || 0, pip.phenIrrevFrac || 0).css;
      pip.liquidStratification = computePhaseStratification(pip.moles, pip.tempK, APPARATUS.pipette_10, 0);
    }

    if (pip.kind === 'pipette') {
      pip.dispenseAnimTimer = 0.48;
      pip.dispenseAnimColor = pipColor;
      pip.dispenseToX = dst.x;
      pip.dispenseToY = dst.kind === 'separatory_funnel' || dst.kind === 'burette' ? dst.y - dstSpec.height * 0.42 : dst.y - dstSpec.height * 0.12;
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('pipette_drop', dst, {
          pipette: pip,
          color: pipColor,
          liquidMl: actual,
        });
      }
    }

    if (dst.kind === 'vessel') sim.checkOverflow(dst);
    sim.recomputeScaleReadings();
    sim.emitChange();
    return actual;
}

export function stepVesselTiltPouringImpl(sim, v, dt) {
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
    for (const cand of sim.items) {
      const cSpec = APPARATUS[cand.typeId] || APPARATUS.beaker_250;
      const isCandClosed =
        cand.kind === 'burette'
          ? false
          : cand.kind === 'separatory_funnel'
          ? Boolean(cand.isStoppered)
          : Boolean(cand.isStoppered);
      if (
        cand.id === v.id ||
        (cand.kind !== 'vessel' && cand.kind !== 'filter_funnel' && cand.kind !== 'separatory_funnel' && cand.kind !== 'burette') ||
        cand.isShattered ||
        cand.isBroken ||
        isCandClosed ||
        (cSpec.hasLid && cand.lidState === 'closed') ||
        cand.isInverted
      ) {
        continue;
      }
      const dx = Math.abs(cand.x - pourX);
      const candTopY = cand.y - (cSpec.height || 90) * 0.5;
      const candBotY = cand.y + (cSpec.height || 90) * 0.5;
      const inVertRange =
        cand.kind === 'separatory_funnel' || cand.kind === 'burette'
          ? candBotY >= spoutY - 36 && candTopY <= spoutY + 95
          : cand.y >= v.y - 28;
      if (dx <= Math.max(48, cSpec.width * 0.55) && inVertRange) {
        const score = dx - (cand.kind === 'filter_funnel' || cand.kind === 'separatory_funnel' || cand.kind === 'burette' ? 28 : 0);
        if (score < bestScore) {
          bestScore = score;
          dst = cand;
        }
      }
    }
    if (dst && dst.kind === 'vessel' && v.kind !== 'filter_funnel') {
      const mf = sim.items.find(
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
        let dMl = Math.min(excessMl, (Math.max(1.2, excessMl * 3.2) / Math.pow(visc, 0.42)) * dt);
        if (dst && (dst.kind === 'burette' || dst.kind === 'separatory_funnel')) {
          const dstCapMl = dst.kind === 'burette' ? 50.0 : APPARATUS.separatory_funnel?.maxVolumeMl || 100.0;
          const dstCurMl = computeLiquidVolumeL(dst.moles, dst.tempK) * 1000;
          dMl = Math.min(dMl, Math.max(0, dstCapMl - dstCurMl));
        }
        const frac = curLiqMl > 1e-6 ? Math.min(1, dMl / curLiqMl) : 0;
        liqOutFrac = frac;
        const visColor = computeSolutionVisuals(
          v.moles,
          curLiqL,
          computePH(v.moles, curLiqL, v.tempK),
          spec.opticalPathCm || 4.0,
          v.phenBleachFrac || 0,
          v.phenIrrevFrac || 0
        ).css;
        if (dst && frac > 1e-9) {
          const cDstBefore = computeHeatCapacityJK(dst);
          const oldDstPhen = dst.moles.Phenolphthalein_aq || 0;
          const oldDstBleach = dst.phenBleachFrac || 0;
          const oldDstIrrev = dst.phenIrrevFrac || 0;
          let movedPhen = 0;
          let cMoved = 0;
          if (v.kind === 'vessel' && (dst.kind === 'vessel' || dst.kind === 'filter_funnel' || dst.kind === 'separatory_funnel' || dst.kind === 'burette')) {
            // Tilt pouring liquid carries liquids/dissolved ions/immiscible organics into vessels, funnels & burettes
            for (const [spId, n] of Object.entries({ ...v.moles })) {
              const sp = SPECIES[spId];
              if (!sp) continue;
              if (sp.phase === 'l' || sp.phase === 'aq' || isSolidMoltenAtTemp(sp, v.tempK, v.moles)) {
                const mv = n * frac;
                if (spId === 'Phenolphthalein_aq') movedPhen = mv;
                const rem = n - mv;
                if (rem < 1e-12) delete v.moles[spId];
                else v.moles[spId] = rem;
                dst.moles[spId] = (dst.moles[spId] || 0) + mv;
                cMoved += mv * Math.max(0, sp.cp || 0);
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
              if (spId === 'Phenolphthalein_aq') movedPhen = mv;
              const rem = n - mv;
              if (rem < 1e-12) delete v.moles[spId];
              else v.moles[spId] = rem;
              dst.moles[spId] = (dst.moles[spId] || 0) + mv;
              cMoved += mv * Math.max(0, sp.cp || 0);
            }
          }
          if (movedPhen > 0) {
            const totP = oldDstPhen + movedPhen;
            dst.phenBleachFrac = totP > 1e-14 ? (oldDstPhen * oldDstBleach + movedPhen * (v.phenBleachFrac || 0)) / totP : 0;
            dst.phenIrrevFrac = totP > 1e-14 ? (oldDstPhen * oldDstIrrev + movedPhen * (v.phenIrrevFrac || 0)) / totP : 0;
          }
          if (cDstBefore + cMoved > 0) {
            dst.tempK = (cDstBefore * dst.tempK + cMoved * v.tempK) / (cDstBefore + cMoved);
          }
          if (dst.kind === 'separatory_funnel' || dst.kind === 'burette') {
            dst.liquidStratification = computePhaseStratification(dst.moles, dst.tempK, dstSpec, computeSolidVolumeMl(dst.moles));
          }
          sim.activePourStream = {
            fromX: spoutX,
            fromY: spoutY,
            toX: dst.x,
            toY: dst.kind === 'separatory_funnel' || dst.kind === 'burette' ? dst.y - (dstSpec?.height || 180) * 0.44 : dst.y - (dstSpec?.height || 90) * 0.25,
            color: visColor || 'rgba(186, 230, 253, 0.85)',
            rateMlS: dMl / Math.max(1e-4, dt),
            timer: 0.14,
            pouredMl: 0,
          };
        } else if (!dst) {
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
          sim.visualHooks.onAlert?.('tilt_spill', v, {
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
          sim.visualHooks.onAlert?.('tilt_solid_spill', v, {
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
        for (const spl of sim.items) {
          if (spl.kind !== 'splint' || (spl.mode !== 'burning' && spl.mode !== 'glowing')) continue;
          const tip = getProbeTipPos(spl);
          if (Math.abs(tip.x - pourX) <= 72 && tip.y >= v.y - 24 && tip.y <= v.y + 195) {
            spl.mode = 'unlit';
            spl.cooldownTimer = 0.4;
            sim.visualHooks.onAlert?.('co2_extinguish', spl, {});
            if (sim.timeSec - (spl._seenCo2Ext ?? -99) > 3.5) {
              spl._seenCo2Ext = sim.timeSec;
              sim.addLog({ type: 'alert', key: 'alertGasExtinguishedSplint', vesselLabel: `${v.label} → ${spl.label}` });
            }
          }
        }
      }
    }
}

