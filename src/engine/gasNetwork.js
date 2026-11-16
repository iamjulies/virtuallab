import { CONSTANTS, ethanolVaporPressureBar, waterBoilingPointK, waterVaporPressureBar } from '../data/constants.js';
import {
  ALL_GAS_IDS,
  createZeroGasMap,
  getGasRelativeAirDensity,
  NON_STEAM_GAS_IDS,
  SPECIES,
} from '../data/species.js';
import { APPARATUS, getCondenserPorts, getSyringeGeometry } from '../data/apparatus.js';
import { computeLiquidVolumeL, computeSolidVolumeMl, solutionFreezingPointK } from './equilibrium.js';

export const NON_STEAM_GASES = NON_STEAM_GAS_IDS;
export const ALL_GASES = ALL_GAS_IDS;
const createEmptyGasMap = createZeroGasMap;

export function getSyringeNozzlePos(syringe) {
  const { nozzleX, nozzleY } = getSyringeGeometry(syringe);
  return {
    x: nozzleX,
    y: nozzleY,
  };
}

/**
 * Compute parabolic discharge water stream trajectory from a Gas Syringe's Luer-Lock nozzle
 * under workbench gravity, testing exact entry into any open vessel's mouth below it.
 */
export function computeSyringeDischargeArc(
  syringe,
  items = [],
  benchFloorY = 482,
  gravityPxS2 = CONSTANTS.GRAVITY_PX_S2 || 1800
) {
  const { nozzleX, nozzleY, dischargeVx } = getSyringeGeometry(syringe);
  const vx0 = dischargeVx; // Gentle horizontal stream velocity out of Luer tip (left or right when flipped)
  const vy0 = 14;
  const dtStep = 0.004;
  const points = [{ x: nozzleX, y: nozzleY }];

  let hitTargetVessel = null;
  let blockedByStopper = false;
  let hitX = nozzleX;
  let hitY = Math.min(benchFloorY, nozzleY);

  let prevX = nozzleX;
  let prevY = nozzleY;

  for (let i = 1; i <= 320; i++) {
    const t = i * dtStep;
    const px = nozzleX + vx0 * t;
    const py = nozzleY + vy0 * t + 0.5 * gravityPxS2 * t * t;

    // Test crossing any unbroken vessel rim / mouth horizontally aligned underneath stream
    for (const dst of items) {
      if (dst.kind !== 'vessel' || dst.isShattered) continue;
      const dSpec = APPARATUS[dst.typeId];
      if (!dSpec) continue;
      const rimY = dst.y - dSpec.height / 2 + 2;
      const mouthHalfW = Math.max(9, (dSpec.neckRadius || dSpec.width * 0.42) - 2);

      if (prevY <= rimY + 2 && py >= rimY - 2 && Math.abs(px - dst.x) <= mouthHalfW) {
        if (!dst.isStoppered) {
          hitTargetVessel = dst;
          hitX = px;
          hitY = rimY;
          points.push({ x: px, y: rimY });
          return { nozzleX, nozzleY, points, hitTargetVessel, hitX, hitY, blockedByStopper: false };
        }
        blockedByStopper = true;
      }
    }

    if (py >= benchFloorY) {
      hitX = px;
      hitY = benchFloorY;
      points.push({ x: px, y: benchFloorY });
      break;
    }

    if (i % 2 === 0) {
      points.push({ x: px, y: py });
    }
    prevX = px;
    prevY = py;
  }

  return { nozzleX, nozzleY, points, hitTargetVessel, hitX, hitY, blockedByStopper };
}

export function cubicBezierPoint(t, p0, p1, p2, p3) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/**
 * Measure exact geometric rubber tubing length along its live cubic Bezier path
 * (1.15 px/mm calibrated to ISO glassware scale) with fixed inner bore diameter (6.0 mm)
 * to compute exact liquid hold-up volume capacity in mL (cm^3).
 */
export function computeTubingGeometry(vessel, target) {
  const vSpec = APPARATUS[vessel.typeId] || APPARATUS.erlenmeyer_250;
  const tSpec = APPARATUS[target.typeId] || APPARATUS.gas_syringe;
  const condPorts = target.kind === 'condenser' ? getCondenserPorts(target) : null;
  const syrNozzle = target.kind === 'gas_syringe' ? getSyringeGeometry(target) : null;
  const p0 = vessel.isInverted
    ? { x: vessel.x, y: vessel.y + vSpec.height / 2 + 8 }
    : { x: vessel.x, y: vessel.y - vSpec.height / 2 - 8 };
  const p3 =
    target.kind === 'gas_syringe'
      ? { x: syrNozzle.nozzleX, y: syrNozzle.nozzleY }
      : target.kind === 'condenser'
      ? condPorts.inlet
      : target.isInverted
      ? { x: target.x, y: target.y + tSpec.height / 2 - 4 }
      : { x: target.x, y: target.y - tSpec.height / 2 + (target.isStoppered ? -8 : 12) };

  const archTopY = vessel.isInverted ? Math.max(p0.y, p3.y) + 34 : Math.min(p0.y, p3.y) - 66;
  const p1 = { x: p0.x, y: archTopY };
  const p2 =
    target.kind === 'gas_syringe'
      ? { x: (p0.x + p3.x) * 0.5, y: Math.min(p0.y, p3.y) - 45 }
      : target.kind === 'condenser'
      ? { x: p3.x - condPorts.dir * 28, y: p3.y - 34 }
      : target.isInverted
      ? { x: p3.x - 16, y: p3.y + 38 }
      : { x: p3.x, y: archTopY };

  const steps = 28;
  const points = [];
  let arcLengthPx = 0;
  let prev = cubicBezierPoint(0, p0, p1, p2, p3);
  points.push(prev);
  for (let i = 1; i <= steps; i++) {
    const pt = cubicBezierPoint(i / steps, p0, p1, p2, p3);
    arcLengthPx += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    points.push(pt);
    prev = pt;
  }

  const pxPerCm = (CONSTANTS.PX_PER_MM || 1.15) * 10;
  const arcLengthCm = Math.max(5.0, arcLengthPx / pxPerCm);
  const innerDiameterMm = CONSTANTS.TUBING_INNER_DIAMETER_MM || 6.0;
  const radiusCm = innerDiameterMm / 20; // mm -> cm radius
  const crossSectionCm2 = Math.PI * radiusCm * radiusCm;
  const capacityMl = arcLengthCm * crossSectionCm2;

  return {
    p0,
    p1,
    p2,
    p3,
    points,
    arcLengthPx,
    arcLengthCm,
    innerDiameterMm,
    crossSectionCm2,
    capacityMl,
  };
}

export function computeCondenserOutletGeometry(cond, receiver) {
  const rSpec = APPARATUS[receiver.typeId] || APPARATUS.beaker_250;
  const { outlet, dir } = getCondenserPorts(cond);
  const p0 = outlet;
  const p3 = { x: receiver.x, y: receiver.y - rSpec.height / 2 + 8 };
  const midX = 0.5 * (p0.x + p3.x);
  const p1 = { x: p0.x + dir * 22, y: p0.y + 18 };
  const p2 = { x: midX + (p3.x - midX) * 0.4, y: p3.y - 34 };
  const points = [];
  for (let i = 0; i <= 20; i++) {
    points.push(cubicBezierPoint(i / 20, p0, p1, p2, p3));
  }
  return { p0, p1, p2, p3, points };
}

export function computeSyringeHeatCapacityJK(syringe) {
  let cpTotal = 34.0; // Borosilicate syringe barrel & glass plunger thermal mass
  cpTotal += (syringe.condensedWaterMol || 0) * CONSTANTS.CP_H2O_J_MOL_K;
  cpTotal += (syringe.condensedEtOHMol || 0) * (SPECIES.C2H5OH_l?.cp || 112.3);
  cpTotal += (syringe.frozenWaterMol || 0) * CONSTANTS.CP_ICE_J_MOL_K;
  for (const [spId, n] of Object.entries(syringe.overflowMoles || {})) {
    if (n > 0 && SPECIES[spId]?.cp) {
      cpTotal += n * SPECIES[spId].cp;
    }
  }
  for (const g of ALL_GASES) {
    const n = syringe.gasMoles[g] || 0;
    if (n > 0 && SPECIES[g]?.cp) {
      cpTotal += n * SPECIES[g].cp;
    }
  }
  return Math.max(24.0, cpTotal);
}

/**
 * Compute syringe collected gas volume (mL) using Ideal Gas Law: V = nRT / P
 * at the syringe barrel's actual live gas temperature (fallback to ambient env).
 */
export function computeSyringeGasVolumeMl(syringe, env) {
  let totalMol = 0;
  for (const g of ALL_GASES) {
    totalMol += syringe.gasMoles[g] || 0;
  }
  if (totalMol <= 1e-12) return 0;

  const gasTempK = Math.max(200, syringe.tempK ?? env.tempK);
  const volL = (totalMol * CONSTANTS.R_L_BAR_MOL_K * gasTempK) / Math.max(0.05, env.pressureBar);
  return volL * 1000;
}

/**
 * Compute unified aqueous moles map combining condensed H2O(l)/C2H5OH(l) and overflowed solution inside Gas Syringe.
 */
export function buildCombinedSyringeLiquidMoles(syringe) {
  const moles = { ...(syringe?.overflowMoles || {}) };
  if ((syringe?.condensedWaterMol || 0) > 1e-12) {
    moles.H2O_l = (moles.H2O_l || 0) + syringe.condensedWaterMol;
  }
  if ((syringe?.condensedEtOHMol || 0) > 1e-12) {
    moles.C2H5OH_l = (moles.C2H5OH_l || 0) + syringe.condensedEtOHMol;
  }
  return moles;
}

/**
 * Compute total condensed + frozen moles inside Gas Syringe (for accurate balance weighing).
 */
export function buildCombinedSyringeTotalMoles(syringe) {
  const moles = buildCombinedSyringeLiquidMoles(syringe);
  if ((syringe?.frozenWaterMol || 0) > 1e-12) {
    moles.H2O_s = (moles.H2O_s || 0) + syringe.frozenWaterMol;
  }
  return moles;
}

/**
 * Compute frozen solid/ice volume inside Gas Syringe barrel (mL).
 */
export function computeSyringeFrozenVolumeMl(syringe) {
  const iceMl = ((syringe?.frozenWaterMol || 0) * SPECIES.H2O_s.molarMass) / CONSTANTS.ICE_DENSITY_G_ML;
  const ovSolidMl = computeSolidVolumeMl(syringe?.overflowMoles || {});
  return iceMl + ovSolidMl;
}

/**
 * Compute liquid water + ethanol condensate + overflowed solution volume inside Gas Syringe barrel (mL).
 */
export function computeSyringeLiquidVolumeMl(syringe, env) {
  const syrT = syringe.tempK ?? env.tempK;
  const condMl = ((syringe.condensedWaterMol || 0) * SPECIES.H2O_l.molarMass) / 0.997;
  const condEtMl = ((syringe.condensedEtOHMol || 0) * SPECIES.C2H5OH_l.molarMass) / SPECIES.C2H5OH_l.density;
  const overflowMl = computeLiquidVolumeL(syringe.overflowMoles || {}, syrT) * 1000;
  return condMl + condEtMl + overflowMl;
}

export function computeSyringeTotalVolumeMl(syringe, env) {
  return (
    computeSyringeGasVolumeMl(syringe, env) +
    computeSyringeLiquidVolumeMl(syringe, env) +
    computeSyringeFrozenVolumeMl(syringe)
  );
}

/**
 * Advance thermal exchange, Antoine/ice saturation condensation/sublimation, and freeze/melt inside a Gas Syringe.
 */
export function stepSyringeThermodynamics(syringe, dt, env) {
  if (!syringe || syringe.kind !== 'gas_syringe' || syringe.isBroken) return;
  if (syringe.tempK == null) syringe.tempK = env.tempK;

  const cTotal = computeSyringeHeatCapacityJK(syringe);
  const isCryoCool = env.tempK < CONSTANTS.T_FREEZE_WATER_K && syringe.tempK > env.tempK;
  const isCryoThaw =
    syringe.tempK < CONSTANTS.T_FREEZE_WATER_K &&
    env.tempK >= CONSTANTS.T_FREEZE_WATER_K &&
    syringe.tempK < env.tempK;
  const hLossWK = isCryoCool ? 8.5 : isCryoThaw ? 6.0 : 0.65;
  const ambientCoolingJ = -hLossWK * (syringe.tempK - env.tempK) * dt;

  let nPerm = 0;
  for (const g of NON_STEAM_GASES) {
    if (!SPECIES[g]?.isCondensableVapor) {
      nPerm += syringe.gasMoles[g] || 0;
    }
  }

  let reactionHeatJ = 0;
  // Gas-phase salt deposition inside Gas Syringe: NH3(g) + HCl(g) -> NH4Cl(s) (or NH4+ + Cl- if wet)
  const nSyrNH3 = syringe.gasMoles.NH3_g || 0;
  const nSyrHCl = syringe.gasMoles.HCl_g || 0;
  if (nSyrNH3 > 1e-9 && nSyrHCl > 1e-9 && syringe.tempK < 610) {
    const dSal = Math.min(nSyrNH3, nSyrHCl) * Math.min(1, 14.0 * dt);
    if (dSal > 1e-12) {
      syringe.gasMoles.NH3_g = Math.max(0, nSyrNH3 - dSal);
      syringe.gasMoles.HCl_g = Math.max(0, nSyrHCl - dSal);
      if (syringe.gasMoles.NH3_g < 1e-13) syringe.gasMoles.NH3_g = 0;
      if (syringe.gasMoles.HCl_g < 1e-13) syringe.gasMoles.HCl_g = 0;
      if (!syringe.overflowMoles) syringe.overflowMoles = {};
      const hasSyrWater = (syringe.condensedWaterMol || 0) + (syringe.overflowMoles.H2O_l || 0) > 2e-4;
      if (hasSyrWater) {
        syringe.overflowMoles.NH4_aq = (syringe.overflowMoles.NH4_aq || 0) + dSal;
        syringe.overflowMoles.Cl_aq = (syringe.overflowMoles.Cl_aq || 0) + dSal;
      } else {
        syringe.overflowMoles.NH4Cl_s = (syringe.overflowMoles.NH4Cl_s || 0) + dSal;
      }
      reactionHeatJ += dSal * 176000;
      syringe.nh4clSmokeTimer = 2.4;
      syringe.lastNH4ClRxnFlag = true;
    }
  }

  const nVapor = syringe.gasMoles.H2O_g || 0;
  const nCond = syringe.condensedWaterMol || 0;
  const nFrozen = syringe.frozenWaterMol || 0;
  const nEtVapor = syringe.gasMoles.C2H5OH_g || 0;
  const nCondEt = syringe.condensedEtOHMol || 0;

  const pExtBar = Math.max(0.05, env.pressureBar);
  const tBoilK = waterBoilingPointK(pExtBar);
  const tBoilEtK = SPECIES.C2H5OH_l?.boilTempK || 351.44;
  const pSatBar = waterVaporPressureBar(syringe.tempK);
  const pSatEtBar = ethanolVaporPressureBar(syringe.tempK);
  const isAboveBoil = pSatBar >= pExtBar * 0.999 || syringe.tempK >= tBoilK;
  const isAboveBoilEt = pSatEtBar >= pExtBar * 0.995 || syringe.tempK >= tBoilEtK;
  const nVaporEq = isAboveBoil ? Infinity : nPerm * (pSatBar / Math.max(1e-6, pExtBar - pSatBar));
  const nEtEq = isAboveBoilEt ? Infinity : nPerm * (pSatEtBar / Math.max(1e-6, pExtBar - pSatEtBar));

  let latentHeatJ = 0;
  let condenseRate = 0;

  // Reversible condensation & re-evaporation of Ethanol vapor C2H5OH(g) <-> condensedEtOHMol
  if (nEtVapor > 1e-9 && nEtVapor > nEtEq && !isAboveBoilEt) {
    const ex = nEtVapor - nEtEq;
    const dCondE = Math.min(ex, ex * Math.min(1, (0.65 + 2.5 * Math.max(0.05, 1 - pSatEtBar / pExtBar)) * dt));
    if (dCondE > 1e-13) {
      syringe.gasMoles.C2H5OH_g = Math.max(0, nEtVapor - dCondE);
      if (syringe.gasMoles.C2H5OH_g < 1e-13) syringe.gasMoles.C2H5OH_g = 0;
      syringe.condensedEtOHMol = nCondEt + dCondE;
      latentHeatJ += dCondE * SPECIES.C2H5OH_l.dHVapJ;
      condenseRate += dCondE / Math.max(1e-5, dt);
    }
  } else if (nCondEt > 1e-9 && (isAboveBoilEt || nEtVapor < nEtEq * 0.99)) {
    let dEvapE = 0;
    if (isAboveBoilEt) {
      const excessHeatJ = Math.max(0, (syringe.tempK - tBoilEtK) * cTotal + ambientCoolingJ);
      dEvapE = Math.min(nCondEt, excessHeatJ / SPECIES.C2H5OH_l.dHVapJ);
    } else {
      const defE = Math.max(0, nEtEq - nEtVapor);
      dEvapE = Math.min(nCondEt, defE, defE * Math.min(1, 0.45 * dt));
    }
    if (dEvapE > 1e-13) {
      syringe.condensedEtOHMol = Math.max(0, nCondEt - dEvapE);
      if (syringe.condensedEtOHMol < 1e-13) syringe.condensedEtOHMol = 0;
      syringe.gasMoles.C2H5OH_g = nEtVapor + dEvapE;
      latentHeatJ -= dEvapE * SPECIES.C2H5OH_l.dHVapJ;
    }
  }

  if (nVapor > 1e-9 && nVapor > nVaporEq) {
    // Supersaturated water vapor condenses (or freezes/deposits directly below 0 C)
    const excessVapor = nVapor - nVaporEq;
    const subcoolFrac = Math.max(0.08, 1 - pSatBar / pExtBar);
    const kCond = 0.55 + 2.8 * subcoolFrac;
    const dCond = Math.min(excessVapor, excessVapor * Math.min(1, kCond * dt));
    if (dCond > 1e-13) {
      syringe.gasMoles.H2O_g = Math.max(0, nVapor - dCond);
      if (syringe.gasMoles.H2O_g < 1e-13) syringe.gasMoles.H2O_g = 0;
      if (syringe.tempK < CONSTANTS.T_FREEZE_WATER_K) {
        syringe.frozenWaterMol = nFrozen + dCond;
        latentHeatJ += dCond * (CONSTANTS.DELTA_H_VAP_WATER_J + CONSTANTS.DELTA_H_FUS_WATER_J);
      } else {
        syringe.condensedWaterMol = nCond + dCond;
        latentHeatJ += dCond * CONSTANTS.DELTA_H_VAP_WATER_J;
      }
      condenseRate += dCond / Math.max(1e-5, dt);
    }
  } else if (nCond > 1e-9 && (isAboveBoil || nVapor < nVaporEq * 0.99)) {
    // Condensed liquid droplets re-evaporate if dry gas mixes in or barrel rises to boiling point
    let dEvap = 0;
    if (isAboveBoil) {
      const excessHeatJ = Math.max(0, (syringe.tempK - tBoilK) * cTotal + ambientCoolingJ);
      dEvap = Math.min(nCond, excessHeatJ / CONSTANTS.DELTA_H_VAP_WATER_J);
    } else {
      const deficit = Math.max(0, nVaporEq - nVapor);
      dEvap = Math.min(nCond, deficit, deficit * Math.min(1, 0.35 * dt));
    }
    if (dEvap > 1e-13) {
      syringe.condensedWaterMol = Math.max(0, nCond - dEvap);
      if (syringe.condensedWaterMol < 1e-13) syringe.condensedWaterMol = 0;
      syringe.gasMoles.H2O_g = nVapor + dEvap;
      latentHeatJ -= dEvap * CONSTANTS.DELTA_H_VAP_WATER_J;
    }
  }

  let newTempK = syringe.tempK + (ambientCoolingJ + latentHeatJ + reactionHeatJ) / cTotal;
  const activeCondCeilingK = nVapor > 1e-9 ? tBoilK : nEtVapor > 1e-9 ? tBoilEtK : tBoilK;
  if (latentHeatJ > 0 && newTempK > activeCondCeilingK) {
    newTempK = Math.max(syringe.tempK, Math.min(newTempK, activeCondCeilingK));
  }
  newTempK = Math.max(200, Math.min(600, newTempK));

  // Freeze / melt condensed pure water inside syringe barrel
  const curCond = syringe.condensedWaterMol || 0;
  const curFrozen = syringe.frozenWaterMol || 0;
  if (newTempK < CONSTANTS.T_FREEZE_WATER_K && curCond > 1e-12) {
    const defJ = cTotal * (CONSTANTS.T_FREEZE_WATER_K - newTempK);
    const dFreeze = Math.min(curCond, defJ / CONSTANTS.DELTA_H_FUS_WATER_J);
    if (dFreeze > 1e-12) {
      syringe.condensedWaterMol = Math.max(0, curCond - dFreeze);
      if (syringe.condensedWaterMol < 1e-12) syringe.condensedWaterMol = 0;
      syringe.frozenWaterMol = curFrozen + dFreeze;
      newTempK += (dFreeze * CONSTANTS.DELTA_H_FUS_WATER_J) / cTotal;
    }
  } else if (newTempK > CONSTANTS.T_FREEZE_WATER_K && curFrozen > 1e-12) {
    const excJ = cTotal * (newTempK - CONSTANTS.T_FREEZE_WATER_K);
    const dMelt = Math.min(curFrozen, excJ / CONSTANTS.DELTA_H_FUS_WATER_J);
    if (dMelt > 1e-12) {
      syringe.frozenWaterMol = Math.max(0, curFrozen - dMelt);
      if (syringe.frozenWaterMol < 1e-12) syringe.frozenWaterMol = 0;
      syringe.condensedWaterMol = (syringe.condensedWaterMol || 0) + dMelt;
      newTempK -= (dMelt * CONSTANTS.DELTA_H_FUS_WATER_J) / cTotal;
    }
  }

  // Freeze / melt overflowed aqueous solution inside syringe barrel if any
  const ov = syringe.overflowMoles;
  if (ov && ((ov.H2O_l || 0) > 1e-12 || (ov.H2O_s || 0) > 1e-12)) {
    const ovWater = ov.H2O_l || 0;
    const ovIce = ov.H2O_s || 0;
    const tOvFreeze = solutionFreezingPointK(ov, ovWater < 1e-4 && ovIce > 0);
    if (newTempK < tOvFreeze && ovWater > 1e-12) {
      const dF = Math.min(ovWater, (cTotal * (tOvFreeze - newTempK)) / CONSTANTS.DELTA_H_FUS_WATER_J);
      if (dF > 1e-12) {
        ov.H2O_l = Math.max(0, ovWater - dF);
        if (ov.H2O_l < 1e-12) delete ov.H2O_l;
        ov.H2O_s = ovIce + dF;
        newTempK += (dF * CONSTANTS.DELTA_H_FUS_WATER_J) / cTotal;
      }
    } else if (newTempK > tOvFreeze && ovIce > 1e-12) {
      const dM = Math.min(ovIce, (cTotal * (newTempK - tOvFreeze)) / CONSTANTS.DELTA_H_FUS_WATER_J);
      if (dM > 1e-12) {
        ov.H2O_s = Math.max(0, ovIce - dM);
        if (ov.H2O_s < 1e-12) delete ov.H2O_s;
        ov.H2O_l = ovWater + dM;
        newTempK -= (dM * CONSTANTS.DELTA_H_FUS_WATER_J) / cTotal;
      }
    }
  }

  syringe.tempK = Math.max(200, Math.min(600, newTempK));
  syringe.lastCondenseRateMolS = condenseRate;

  // Track internal syringe pressure when piston hits 250 mL mechanical collar stop
  const gasMl = computeSyringeGasVolumeMl(syringe, env);
  const liqMl = computeSyringeLiquidVolumeMl(syringe, env);
  const frozenMl = computeSyringeFrozenVolumeMl(syringe);
  const syrSpec = APPARATUS[syringe.typeId] || APPARATUS.gas_syringe;
  const maxGasCapMl = Math.max(2.0, syrSpec.maxVolumeMl - liqMl - frozenMl);
  if (gasMl > maxGasCapMl) {
    syringe.internalPressureBar = pExtBar * (gasMl / maxGasCapMl);
  } else {
    syringe.internalPressureBar = pExtBar;
  }
}

/**
 * Deliver generated gases directly to a connected target (Gas Syringe, Liebig Condenser, Inverted Trough Vessel, or Open Vessel).
 * Shared cleanly by both flask tubing and direct electrolysis electrode gas collectors.
 */
export function routeGasPacketToTarget(
  sourceVessel,
  target,
  produced,
  totalSteam,
  env,
  getApparatusById,
  preferInvertedDirect = false
) {
  const srcT = sourceVessel?.tempK ?? env.tempK;
  let totalPerm = 0;
  for (const g of NON_STEAM_GASES) totalPerm += produced[g] || 0;

  if (target && target.kind === 'gas_syringe' && !target.isBroken) {
    const syringeSpec = APPARATUS[target.typeId];
    const currentVolMl = computeSyringeTotalVolumeMl(target, env);

    if (currentVolMl < syringeSpec.maxVolumeMl * 0.995) {
      if (target.tempK == null) target.tempK = env.tempK;

      let incomingHeatCapJK = 0;
      for (const g of NON_STEAM_GASES) {
        if ((produced[g] || 0) > 0) {
          target.gasMoles[g] = (target.gasMoles[g] || 0) + produced[g];
          incomingHeatCapJK += produced[g] * (SPECIES[g]?.cp || 30);
        }
      }
      if (totalSteam > 0) {
        target.gasMoles.H2O_g = (target.gasMoles.H2O_g || 0) + totalSteam;
        incomingHeatCapJK += totalSteam * (SPECIES.H2O_g?.cp || 33.58);
      }

      if (totalPerm + totalSteam > 1e-11) {
        target.inflowTempK = srcT;
        const cSyr = computeSyringeHeatCapacityJK(target);
        const dT = (incomingHeatCapJK * (srcT - target.tempK)) / cSyr;
        target.tempK = Math.max(200, Math.min(600, target.tempK + dT));
      }

      if (sourceVessel) sourceVessel.internalPressureBar = env.pressureBar;
      target.internalPressureBar = env.pressureBar;
      return { handled: true, maxedSyringe: null };
    }
    return { handled: false, maxedSyringe: target };
  }

  if (target && target.kind === 'vessel' && target.isInverted && !target.isShattered) {
    target.headspaceGasMoles = target.headspaceGasMoles || createEmptyGasMap();
    const trough = target.submergedInTroughId ? getApparatusById(target.submergedInTroughId) : sourceVessel || null;
    const targetSpec = APPARATUS[target.typeId] || APPARATUS.test_tube_50;
    const tgtT = target.tempK || env.tempK;
    let newPermMol = 0;

    for (const g of NON_STEAM_GASES) {
      if ((produced[g] || 0) > 0) {
        if (!preferInvertedDirect && (g === 'HCl_g' || g === 'NH3_g') && (target.moles.H2O_l || 0) > 0.02) {
          const dSol = produced[g];
          if (g === 'HCl_g') {
            target.moles.H_aq = (target.moles.H_aq || 0) + dSol;
            target.moles.Cl_aq = (target.moles.Cl_aq || 0) + dSol;
          } else {
            target.moles.NH3_aq = (target.moles.NH3_aq || 0) + dSol;
          }
        } else {
          target.headspaceGasMoles[g] = (target.headspaceGasMoles[g] || 0) + produced[g];
          newPermMol += produced[g];
        }
      }
    }
    if (totalSteam > 0 && target.tempK < waterBoilingPointK(env.pressureBar)) {
      target.moles.H2O_l = (target.moles.H2O_l || 0) + totalSteam;
    }

    const curSolMl = computeSolidVolumeMl(target.moles);
    if (newPermMol > 0) {
      target.gasDisplacedRate = (target.gasDisplacedRate || 0) + newPermMol / 0.02;
      if (trough && trough.id !== target.id) {
        const dispL = (newPermMol * CONSTANTS.R_L_BAR_MOL_K * tgtT) / Math.max(0.1, env.pressureBar);
        const dispMol = (dispL * 1000 * 0.997) / SPECIES.H2O_l.molarMass;
        const actualOut = Math.min(Math.max(0, (target.moles.H2O_l || 0) - 0.015), dispMol);
        if (actualOut > 0) {
          target.moles.H2O_l -= actualOut;
          if (target.moles.H2O_l < 1e-12) delete target.moles.H2O_l;
          trough.moles.H2O_l = (trough.moles.H2O_l || 0) + actualOut;
        }
      }
    }

    const maxCapL = Math.max(
      0.015,
      (targetSpec.maxVolumeMl - Math.min(targetSpec.maxVolumeMl * 0.5, curSolMl + (trough ? 1.5 : 0))) / 1000
    );
    const maxHeadMol = (env.pressureBar * maxCapL) / (CONSTANTS.R_L_BAR_MOL_K * tgtT);
    let headSum = 0;
    for (const g of NON_STEAM_GASES) headSum += target.headspaceGasMoles[g] || 0;
    if (headSum > maxHeadMol) {
      const keepFrac = maxHeadMol / headSum;
      let overflowed = 0;
      for (const g of NON_STEAM_GASES) {
        const curG = target.headspaceGasMoles[g] || 0;
        if (curG <= 0) continue;
        const ex = curG * (1 - keepFrac);
        target.headspaceGasMoles[g] = curG * keepFrac;
        overflowed += ex;
        if (trough && trough.id !== target.id) {
          trough.escapedGasMoles[g] = (trough.escapedGasMoles[g] || 0) + ex;
          trough.lastGasRateMap = trough.lastGasRateMap || createEmptyGasMap();
          trough.lastGasRateMap[g] = (trough.lastGasRateMap[g] || 0) + ex * 35;
        } else {
          target.escapedGasMoles[g] = (target.escapedGasMoles[g] || 0) + ex;
        }
      }
      if (trough && trough.id !== target.id && overflowed > 1e-8) {
        trough.troughOverfillRate = overflowed * 40;
        trough.troughOverfillX = target.x;
      }
    }
    if (sourceVessel) sourceVessel.internalPressureBar = env.pressureBar;
    return { handled: true, maxedSyringe: null };
  }
  return { handled: false, maxedSyringe: null };
}

/**
 * Route generated gases from a vessel according to its boundary state:
 * - Open: escapes to room (mass lost)
 * - Connected to Gas syringe: permanent gases & steam flow into syringe (V = nRT/P)
 * - Stoppered closed: accumulates in headspace, building pressure P_in -> pop/shatter
 */
export function stepVesselGasAndPressure(
  vessel,
  gasProduced,
  steamProducedMol,
  env,
  getApparatusById
) {
  const spec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
  const events = [];

  const produced = {};
  let totalPerm = 0;
  for (const g of NON_STEAM_GASES) {
    produced[g] = gasProduced[g] || 0;
    totalPerm += produced[g];
  }
  const totalSteam = (gasProduced.H2O_g || 0) + (steamProducedMol || 0);

  const ventToRoom = () => {
    vessel._stepGasOutMol = (vessel._stepGasOutMol || 0) + totalPerm + totalSteam;
    for (const g of NON_STEAM_GASES) {
      if (produced[g] > 0) {
        vessel.escapedGasMoles[g] = (vessel.escapedGasMoles[g] || 0) + produced[g];
      }
    }
    if (totalSteam > 0) {
      if (env.tempK < CONSTANTS.T_FREEZE_WATER_K) {
        // Subzero room air immediately condenses/freezes escaping steam as frost rather than free H2O(g)
        vessel.escapedFrostH2OMol = (vessel.escapedFrostH2OMol || 0) + totalSteam;
      } else {
        vessel.escapedGasMoles.H2O_g = (vessel.escapedGasMoles.H2O_g || 0) + totalSteam;
      }
    }
    vessel.internalPressureBar = env.pressureBar;
  };

  if (vessel.isShattered || !vessel.isStoppered) {
    ventToRoom();
    return events;
  }

  // Compute vessel headspace in Liters
  const liqMl = computeLiquidVolumeL(vessel.moles, vessel.tempK) * 1000;
  const solMl = computeSolidVolumeMl(vessel.moles);
  const headspaceL = Math.max(0.015, (spec.maxVolumeMl - Math.min(spec.maxVolumeMl * 0.94, liqMl + solMl)) / 1000);

  // Connected to another apparatus (Gas Syringe OR receiving Vessel) via rubber tubing
  let maxedSyringe = null;
  const targetId = vessel.connectedTargetId || vessel.connectedSyringeId;
  if (targetId) {
    const target = getApparatusById(targetId);
    if (target && (target.kind === 'gas_syringe' || (target.kind === 'vessel' && target.isInverted))) {
      const routed = routeGasPacketToTarget(vessel, target, produced, totalSteam, env, getApparatusById);
      if (routed.handled) return events;
      if (routed.maxedSyringe) maxedSyringe = routed.maxedSyringe;
    } else if (target && target.kind === 'condenser' && !target.isBroken) {
      target.vaporInMoles = target.vaporInMoles || createEmptyGasMap();
      for (const g of NON_STEAM_GASES) {
        if (produced[g] > 0) {
          target.vaporInMoles[g] = (target.vaporInMoles[g] || 0) + produced[g];
        }
      }
      if (totalSteam > 0) {
        target.vaporInMoles.H2O_g = (target.vaporInMoles.H2O_g || 0) + totalSteam;
      }
      vessel.internalPressureBar = env.pressureBar;
      return events;
    } else if (target && target.kind === 'vessel' && !target.isShattered && !target.isStoppered) {
      // Condense steam, scrub HCl(g) onto dry CuSO4(s) or water, dissolve NH3(g) into water, vent permanent gases
      let heatAddedJ = 0;
      let addedCapJK = 0;
      if (totalSteam > 0) {
        if ((target.moles.NaOH_s || 0) > 1e-4 && target.tempK < 395) {
          // Strongly hygroscopic solid NaOH desiccates incoming water vapor exothermic (~41 kJ/mol)
          target.moles.H2O_l = (target.moles.H2O_l || 0) + totalSteam;
          heatAddedJ += totalSteam * CONSTANTS.DELTA_H_VAP_WATER_J;
          addedCapJK += totalSteam * CONSTANTS.CP_H2O_J_MOL_K;
        } else if (target.tempK < waterBoilingPointK(env.pressureBar)) {
          target.moles.H2O_l = (target.moles.H2O_l || 0) + totalSteam;
          heatAddedJ += totalSteam * CONSTANTS.DELTA_H_VAP_WATER_J;
          addedCapJK += totalSteam * CONSTANTS.CP_H2O_J_MOL_K;
        } else {
          target.escapedGasMoles.H2O_g = (target.escapedGasMoles.H2O_g || 0) + totalSteam;
        }
      }
      let remHCl = produced.HCl_g || 0;
      if (remHCl > 0 && (target.moles.CuSO4_s || 0) > 1e-8 && (target.moles.H2O_l || 0) < 0.025 && target.tempK < 410) {
        // Chemisorption: CuSO4(s, white) + 2 HCl(g) -> CuSO4·2HCl(s, golden brown)
        const dAdduct = Math.min(target.moles.CuSO4_s, remHCl / 2);
        if (dAdduct > 1e-13) {
          target.moles.CuSO4_s -= dAdduct;
          if (target.moles.CuSO4_s < 1e-13) delete target.moles.CuSO4_s;
          target.moles.CuSO4_2HCl_s = (target.moles.CuSO4_2HCl_s || 0) + dAdduct;
          remHCl -= 2 * dAdduct;
          heatAddedJ += dAdduct * 68000;
        }
      }
      if (remHCl > 0 && (target.moles.H2O_l || 0) > 1e-4) {
        target.moles.H_aq = (target.moles.H_aq || 0) + remHCl;
        target.moles.Cl_aq = (target.moles.Cl_aq || 0) + remHCl;
        heatAddedJ += remHCl * CONSTANTS.DELTA_H_VAP_HCL_AQ_J;
      } else if (remHCl > 0) {
        target.escapedGasMoles.HCl_g = (target.escapedGasMoles.HCl_g || 0) + remHCl;
      }
      if ((produced.NH3_g || 0) > 0 && (target.moles.H2O_l || 0) > 1e-4) {
        const dNH3 = produced.NH3_g;
        target.moles.NH3_aq = (target.moles.NH3_aq || 0) + dNH3;
        heatAddedJ += dNH3 * 35400;
      } else if ((produced.NH3_g || 0) > 0) {
        target.escapedGasMoles.NH3_g = (target.escapedGasMoles.NH3_g || 0) + produced.NH3_g;
      }
      if ((produced.C2H5Cl_g || 0) > 0 && target.restingOnId) {
        target.recentHalogenGasTimer = 1.6;
      }
      if ((produced.C2H5OH_g || 0) > 0) {
        const dEt = produced.C2H5OH_g;
        if (target.tempK < SPECIES.C2H5OH_l.boilTempK) {
          target.moles.C2H5OH_l = (target.moles.C2H5OH_l || 0) + dEt;
          heatAddedJ += dEt * SPECIES.C2H5OH_l.dHVapJ;
          addedCapJK += dEt * SPECIES.C2H5OH_l.cp;
        } else {
          target.escapedGasMoles.C2H5OH_g = (target.escapedGasMoles.C2H5OH_g || 0) + dEt;
        }
      }
      target.headspaceGasMoles = target.headspaceGasMoles || createEmptyGasMap();
      for (const g of NON_STEAM_GASES) {
        if (g !== 'HCl_g' && g !== 'NH3_g' && g !== 'C2H5OH_g' && produced[g] > 0) {
          target.headspaceGasMoles[g] = (target.headspaceGasMoles[g] || 0) + produced[g];
          target.gasFlushInMol = (target.gasFlushInMol || 0) + produced[g];
        }
      }
      if (heatAddedJ > 0) {
        const tSpec = APPARATUS[target.typeId] || APPARATUS.beaker_250;
        let cTarget = tSpec.glassHeatCapacityJK || 80.0;
        for (const [id, n] of Object.entries(target.moles)) {
          if (n > 0 && SPECIES[id]?.cp) cTarget += n * SPECIES[id].cp;
        }
        target.tempK = Math.min(waterBoilingPointK(env.pressureBar), target.tempK + heatAddedJ / Math.max(40, cTarget + addedCapJK));
      }
      // If forward gas/steam is actively pushing downstream and no internal Ammonia/HCl fountain dissolution is occurring, stay at atmospheric pressure
      const hasFountainSoluble =
        ((vessel.headspaceGasMoles?.NH3_g || 0) > 1e-7 || (vessel.headspaceGasMoles?.HCl_g || 0) > 1e-7) &&
        (vessel.moles.H2O_l || 0) > 1e-4;
      if (!hasFountainSoluble && (vessel.internalPressureBar ?? env.pressureBar) >= env.pressureBar - 0.02) {
        vessel.internalPressureBar = env.pressureBar;
        return events;
      }
    }
  }

  // Stoppered closed (or syringe bottomed out) -> gas accumulates in headspace
  if (vessel.sealedAirMoles === null || vessel.sealedAirMoles === undefined) {
    const nHead1Bar = (env.pressureBar * headspaceL) / (CONSTANTS.R_L_BAR_MOL_K * vessel.tempK);
    let preCollectedGas = 0;
    for (const g of NON_STEAM_GASES) {
      preCollectedGas += vessel.headspaceGasMoles[g] || 0;
    }
    // Pre-collected gases (e.g. NH3(g) or H2(g) displaced air before stoppering) reduce initial trapped air
    vessel.sealedAirMoles = Math.max(nHead1Bar * 0.04, nHead1Bar - preCollectedGas);
    vessel.sealedAirO2Moles =
      (env?.atmosphereMode || 'air') === 'air'
        ? vessel.sealedAirMoles * CONSTANTS.AIR_O2_FRAC * (vessel.airO2PurgeFrac ?? 1.0)
        : 0;
  }

  let extraGasMol = 0;
  for (const g of NON_STEAM_GASES) {
    vessel.headspaceGasMoles[g] = (vessel.headspaceGasMoles[g] || 0) + produced[g];
  }

  // Rapid Ammonia / HCl gas absorption into liquid water inside stoppered flask (drives Ammonia Fountain vacuum!)
  const nWaterIn = vessel.moles.H2O_l || 0;
  if (nWaterIn > 1e-4) {
    const liqVolL = Math.max(1e-5, computeLiquidVolumeL(vessel.moles, vessel.tempK));
    const headNH3 = vessel.headspaceGasMoles.NH3_g || 0;
    if (headNH3 > 1e-9) {
      const cNH3Now = (vessel.moles.NH3_aq || 0) / liqVolL;
      const roomCap = Math.max(0, 18.0 - cNH3Now) * liqVolL;
      const dDissNH3 = Math.min(headNH3, roomCap, headNH3 * 0.72 + 0.002);
      if (dDissNH3 > 1e-11) {
        vessel.headspaceGasMoles.NH3_g = Math.max(0, headNH3 - dDissNH3);
        vessel.moles.NH3_aq = (vessel.moles.NH3_aq || 0) + dDissNH3;
      }
    }
    const headHCl = vessel.headspaceGasMoles.HCl_g || 0;
    if (headHCl > 1e-9) {
      const cClNow = (vessel.moles.Cl_aq || 0) / liqVolL;
      const roomCapH = Math.max(0, 12.5 - cClNow) * liqVolL;
      const dDissHCl = Math.min(headHCl, roomCapH, headHCl * 0.72 + 0.002);
      if (dDissHCl > 1e-11) {
        vessel.headspaceGasMoles.HCl_g = Math.max(0, headHCl - dDissHCl);
        vessel.moles.H_aq = (vessel.moles.H_aq || 0) + dDissHCl;
        vessel.moles.Cl_aq = (vessel.moles.Cl_aq || 0) + dDissHCl;
      }
    }
  }

  for (const g of NON_STEAM_GASES) {
    extraGasMol += vessel.headspaceGasMoles[g] || 0;
  }
  vessel.headspaceGasMoles.H2O_g = (vessel.headspaceGasMoles.H2O_g || 0) + totalSteam;

  // Condense/deposit excess headspace steam when a sealed vessel cools below dew/frost point
  const headSteam = vessel.headspaceGasMoles.H2O_g || 0;
  if (headSteam > 1e-8 && vessel.tempK < waterBoilingPointK(env.pressureBar)) {
    const pHeadSteam = (headSteam * CONSTANTS.R_L_BAR_MOL_K * vessel.tempK) / headspaceL;
    const pSatV = waterVaporPressureBar(vessel.tempK);
    if (pHeadSteam > pSatV * 1.02) {
      const nSteamEq = (pSatV * headspaceL) / (CONSTANTS.R_L_BAR_MOL_K * vessel.tempK);
      const relaxRate = vessel.tempK < CONSTANTS.T_FREEZE_WATER_K ? 0.35 : 0.08;
      const dCond = Math.min(headSteam - nSteamEq, (headSteam - nSteamEq) * relaxRate);
      if (dCond > 1e-12) {
        vessel.headspaceGasMoles.H2O_g = Math.max(0, headSteam - dCond);
        if (vessel.tempK < CONSTANTS.T_FREEZE_WATER_K) {
          vessel.moles.H2O_s = (vessel.moles.H2O_s || 0) + dCond;
        } else {
          vessel.moles.H2O_l = (vessel.moles.H2O_l || 0) + dCond;
        }
      }
    }
  }

  extraGasMol += vessel.headspaceGasMoles.H2O_g || 0;

  const safeTempK = Number.isFinite(vessel.tempK) ? Math.max(150, Math.min(1400, vessel.tempK)) : CONSTANTS.T_STD_K;
  const effectiveVolL = Math.max(0.008, maxedSyringe ? headspaceL + 0.25 : headspaceL);
  const partialAirAndGas = maxedSyringe
    ? env.pressureBar + (extraGasMol * CONSTANTS.R_L_BAR_MOL_K * safeTempK) / effectiveVolL
    : (((vessel.sealedAirMoles || 0) + extraGasMol) * CONSTANTS.R_L_BAR_MOL_K * safeTempK) / effectiveVolL;
  const hasWater = (vessel.moles.H2O_l || 0) > 1e-6;
  const vaporContribution = !maxedSyringe && hasWater ? Math.max(0, waterVaporPressureBar(safeTempK) - 0.03) : 0;

  const rawPressureBar = partialAirAndGas + vaporContribution;
  vessel.internalPressureBar = Number.isFinite(rawPressureBar)
    ? Math.max(0.02, Math.min(35.0, rawPressureBar))
    : env.pressureBar;
  if (maxedSyringe) {
    maxedSyringe.internalPressureBar = vessel.internalPressureBar;
  }

  // Real-world gauge differential pressure checks (Borosilicate 3.3 flat base vs rounded tube, wet vs dry rubber bung, 250 mL glass syringe 2.05 bar limit)
  const overpressureBar = vessel.internalPressureBar - env.pressureBar;
  const underpressureBar = env.pressureBar - vessel.internalPressureBar;
  const isNeckWet = liqMl + solMl > spec.maxVolumeMl * 0.85 || (vessel.wallCondenseLevel || 0) > 0.35;
  const effPopDeltaBar = spec.popOverpressureBar
    ? isNeckWet
      ? Math.min(spec.popOverpressureBar, 0.14)
      : spec.popOverpressureBar
    : null;
  const shatterDeltaBar = spec.shatterOverpressureBar ?? (spec.shatterPressureBar ? spec.shatterPressureBar - 1.0 : null);

  if (maxedSyringe) {
    const syrSpec = APPARATUS[maxedSyringe.typeId] || APPARATUS.gas_syringe;
    if (syrSpec.shatterOverpressureBar && overpressureBar >= syrSpec.shatterOverpressureBar) {
      events.push({ type: 'syringe_shatter', vesselId: vessel.id, syringeId: maxedSyringe.id });
      return events;
    }
    if (
      syrSpec.plungerPopOverpressureBar &&
      overpressureBar >= syrSpec.plungerPopOverpressureBar &&
      (!effPopDeltaBar || effPopDeltaBar > syrSpec.plungerPopOverpressureBar)
    ) {
      events.push({ type: 'syringe_plunger_pop', vesselId: vessel.id, syringeId: maxedSyringe.id });
      return events;
    }
  }

  const connectedTarget = vessel.connectedTargetId ? getApparatusById(vessel.connectedTargetId) : null;
  const hasLiquidSuctionRelief = Boolean(
    connectedTarget && connectedTarget.kind === 'vessel' && !connectedTarget.isShattered && (connectedTarget.moles?.H2O_l || 0) > 1e-4
  );

  if (
    (shatterDeltaBar && overpressureBar >= shatterDeltaBar) ||
    (!hasLiquidSuctionRelief && spec.implosionUnderpressureBar && underpressureBar >= spec.implosionUnderpressureBar)
  ) {
    vessel.isShattered = true;
    vessel.isStoppered = false;
    vessel.connectedSyringeId = null;
    vessel.connectedTargetId = null;
    events.push({ type: 'shatter', vesselId: vessel.id, implosion: underpressureBar >= (spec.implosionUnderpressureBar || 99) });
  } else if (effPopDeltaBar && overpressureBar >= effPopDeltaBar) {
    vessel.isStoppered = false;
    vessel.connectedSyringeId = null;
    vessel.connectedTargetId = null;
    for (const g of ALL_GASES) {
      vessel.escapedGasMoles[g] = (vessel.escapedGasMoles[g] || 0) + (vessel.headspaceGasMoles[g] || 0);
      vessel.headspaceGasMoles[g] = 0;
    }
    vessel.sealedAirMoles = null;
    vessel.internalPressureBar = env.pressureBar;
    events.push({ type: 'stopper_pop', vesselId: vessel.id });
  }

  return events;
}

/**
 * Simulate buoyant retention vs diffusive/gravitational escape of gases in unstoppered open vessels
 * using each gas's air-relative molar mass density (M_gas / 28.97).
 */
export function stepOpenGasBuoyancy(vessel, env, dt) {
  if (!vessel || vessel.isShattered) return;

  // Track ambient air O2 flushing vs slow room diffusion inside vessel headspace
  const atmMode = env?.atmosphereMode || 'air';
  if (atmMode === 'inert') {
    vessel.airO2PurgeFrac = 0;
    vessel.gasFlushInMol = 0;
  } else {
    const flushMol = (vessel.gasFlushInMol || 0) + (vessel._stepGasOutMol || 0);
    vessel.gasFlushInMol = 0;
    vessel._stepGasOutMol = 0;
    if (flushMol > 1e-8) {
      const purgeK = Math.min(3.5, (flushMol / Math.max(1e-4, dt)) * 1150);
      vessel.airO2PurgeFrac = Math.max(0, (vessel.airO2PurgeFrac ?? 1.0) * Math.exp(-purgeK * dt));
    } else if (!vessel.isStoppered) {
      // Passive air diffusion gently restores ~21% O2 when gas flow ceases in open air
      const prevF = vessel.airO2PurgeFrac ?? 1.0;
      vessel.airO2PurgeFrac = Math.min(1.0, prevF + (1.0 - prevF) * (1 - Math.exp(-0.12 * dt)));
    }
  }

  if (vessel.isStoppered || (vessel.isInverted && vessel.submergedInTroughId)) {
    return;
  }
  const head = vessel.headspaceGasMoles;
  if (!head) return;

  // Condense water droplets on upper cool mouth when H2O(g) evolves gently from CuO + H2 reduction
  if (vessel._cuoReductionCondenseTimer > 0) {
    vessel._cuoReductionCondenseTimer = Math.max(0, vessel._cuoReductionCondenseTimer - dt);
    vessel.wallCondenseLevel = Math.min(1.0, (vessel.wallCondenseLevel || 0) + 0.55 * dt);
  }

  for (const gId of ALL_GASES) {
    const n = head[gId] || 0;
    if (n <= 1e-10) {
      if (head[gId]) head[gId] = 0;
      continue;
    }
    const relD = getGasRelativeAirDensity(gId);
    let leakRateS = 0;
    if (vessel.isInverted) {
      // Inverted in open air (not in water trough): light gases (H2, NH3) float upward inside the inverted dome;
      // heavy gases (Cl2, NO2, O2, HCl) pour downward out of the mouth
      leakRateS = relD < 0.96 ? 0.032 * Math.sqrt(relD) : 0.35 + 1.35 * (relD - 0.95);
    } else {
      // Upright open vessel: light gases shoot upward quickly; heavy gases linger in the bottom trough
      leakRateS = relD < 0.96 ? 1.05 + 1.4 * (1 - relD) : 0.14 / Math.max(0.55, relD);
    }
    const lost = n * (1 - Math.exp(-leakRateS * dt));
    if (lost > 1e-12) {
      head[gId] = Math.max(0, n - lost);
      if (head[gId] < 1e-12) head[gId] = 0;
      vessel.escapedGasMoles[gId] = (vessel.escapedGasMoles[gId] || 0) + lost;
      vessel.lastGasRateMap = vessel.lastGasRateMap || createEmptyGasMap();
      vessel.lastGasRateMap[gId] = (vessel.lastGasRateMap[gId] || 0) + lost / Math.max(1e-4, dt);
    }
  }
}
