import { CONSTANTS, waterBoilingPointK, waterVaporPressureBar } from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { APPARATUS } from '../data/apparatus.js';
import { computeLiquidVolumeL, computeSolidVolumeMl } from './equilibrium.js';

export const NON_STEAM_GASES = ['H2_g', 'O2_g', 'HCl_g', 'Cl2_g', 'HNO3_g'];
export const ALL_GASES = [...NON_STEAM_GASES, 'H2O_g'];

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
  const p0 = { x: vessel.x, y: vessel.y - vSpec.height / 2 - 8 };
  const p3 =
    target.kind === 'gas_syringe'
      ? { x: target.x - tSpec.width / 2 + 2, y: target.y }
      : { x: target.x, y: target.y - tSpec.height / 2 + (target.isStoppered ? -8 : 12) };

  const archTopY = Math.min(p0.y, p3.y) - 66;
  const p1 = { x: p0.x, y: archTopY };
  const p2 =
    target.kind === 'gas_syringe'
      ? { x: (p0.x + p3.x) * 0.5, y: Math.min(p0.y, p3.y) - 45 }
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

export function computeSyringeHeatCapacityJK(syringe) {
  let cpTotal = 34.0; // Borosilicate syringe barrel & glass plunger thermal mass
  cpTotal += (syringe.condensedWaterMol || 0) * CONSTANTS.CP_H2O_J_MOL_K;
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
 * Compute liquid water + overflowed solution volume inside Gas Syringe barrel (mL).
 */
export function computeSyringeLiquidVolumeMl(syringe, env) {
  const syrT = syringe.tempK ?? env.tempK;
  const condMl = ((syringe.condensedWaterMol || 0) * SPECIES.H2O_l.molarMass) / 0.997;
  const overflowMl = computeLiquidVolumeL(syringe.overflowMoles || {}, syrT) * 1000;
  return condMl + overflowMl;
}

export function computeSyringeTotalVolumeMl(syringe, env) {
  return computeSyringeGasVolumeMl(syringe, env) + computeSyringeLiquidVolumeMl(syringe, env);
}

/**
 * Advance thermal exchange and Antoine saturation condensation/re-evaporation inside a Gas Syringe.
 */
export function stepSyringeThermodynamics(syringe, dt, env) {
  if (!syringe || syringe.kind !== 'gas_syringe' || syringe.isBroken) return;
  if (syringe.tempK == null) syringe.tempK = env.tempK;

  const cTotal = computeSyringeHeatCapacityJK(syringe);
  const hLossWK = 0.65;
  const ambientCoolingJ = -hLossWK * (syringe.tempK - env.tempK) * dt;

  let nPerm = 0;
  for (const g of NON_STEAM_GASES) {
    nPerm += syringe.gasMoles[g] || 0;
  }
  const nVapor = syringe.gasMoles.H2O_g || 0;
  const nCond = syringe.condensedWaterMol || 0;

  const pExtBar = Math.max(0.05, env.pressureBar);
  const tBoilK = waterBoilingPointK(pExtBar);
  const pSatBar = waterVaporPressureBar(syringe.tempK);
  const isAboveBoil = pSatBar >= pExtBar * 0.999 || syringe.tempK >= tBoilK;
  const nVaporEq = isAboveBoil ? Infinity : nPerm * (pSatBar / Math.max(1e-6, pExtBar - pSatBar));

  let latentHeatJ = 0;
  let condenseRate = 0;

  if (nVapor > 1e-9 && nVapor > nVaporEq) {
    // Supersaturated water vapor condenses into H2O(l) droplets, releasing ΔH_vap to the syringe barrel
    const excessVapor = nVapor - nVaporEq;
    const subcoolFrac = Math.max(0.08, 1 - pSatBar / pExtBar);
    const kCond = 0.55 + 2.8 * subcoolFrac;
    const dCond = Math.min(excessVapor, excessVapor * Math.min(1, kCond * dt));
    if (dCond > 1e-13) {
      syringe.gasMoles.H2O_g = Math.max(0, nVapor - dCond);
      if (syringe.gasMoles.H2O_g < 1e-13) syringe.gasMoles.H2O_g = 0;
      syringe.condensedWaterMol = nCond + dCond;
      latentHeatJ = dCond * CONSTANTS.DELTA_H_VAP_WATER_J;
      condenseRate = dCond / Math.max(1e-5, dt);
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
      latentHeatJ = -dEvap * CONSTANTS.DELTA_H_VAP_WATER_J;
    }
  }

  let newTempK = syringe.tempK + (ambientCoolingJ + latentHeatJ) / cTotal;
  if (latentHeatJ > 0 && newTempK > tBoilK) {
    // Condensation latent heat alone cannot warm barrel above steam's dew/boiling temperature
    newTempK = Math.max(syringe.tempK, Math.min(newTempK, tBoilK));
  }
  syringe.tempK = Math.max(220, Math.min(600, newTempK));
  syringe.lastCondenseRateMolS = condenseRate;
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
    for (const g of NON_STEAM_GASES) {
      if (produced[g] > 0) {
        vessel.escapedGasMoles[g] = (vessel.escapedGasMoles[g] || 0) + produced[g];
      }
    }
    if (totalSteam > 0) {
      vessel.escapedGasMoles.H2O_g = (vessel.escapedGasMoles.H2O_g || 0) + totalSteam;
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
  const targetId = vessel.connectedTargetId || vessel.connectedSyringeId;
  if (targetId) {
    const target = getApparatusById(targetId);
    if (target && target.kind === 'gas_syringe' && !target.isBroken) {
      const syringeSpec = APPARATUS[target.typeId];
      const currentVolMl = computeSyringeTotalVolumeMl(target, env);

      if (currentVolMl < syringeSpec.maxVolumeMl * 0.995) {
        if (target.tempK == null) target.tempK = env.tempK;

        let incomingHeatCapJK = 0;
        for (const g of NON_STEAM_GASES) {
          if (produced[g] > 0) {
            target.gasMoles[g] = (target.gasMoles[g] || 0) + produced[g];
            incomingHeatCapJK += produced[g] * (SPECIES[g]?.cp || 30);
          }
        }
        if (totalSteam > 0) {
          target.gasMoles.H2O_g = (target.gasMoles.H2O_g || 0) + totalSteam;
          incomingHeatCapJK += totalSteam * (SPECIES.H2O_g?.cp || 33.58);
        }

        if (totalPerm + totalSteam > 1e-11) {
          target.inflowTempK = vessel.tempK;
          const cSyr = computeSyringeHeatCapacityJK(target);
          const dT = (incomingHeatCapJK * (vessel.tempK - target.tempK)) / cSyr;
          target.tempK = Math.max(220, Math.min(600, target.tempK + dT));
        }

        vessel.internalPressureBar = env.pressureBar;
        return events;
      }
      // Syringe maxed out -> remaining gas pressurizes vessel!
    } else if (target && target.kind === 'vessel' && !target.isShattered && !target.isStoppered) {
      // Condense steam & dissolve soluble acid gases into open receiving vessel; vent permanent gases
      let heatAddedJ = 0;
      let addedCapJK = 0;
      if (totalSteam > 0) {
        if (target.tempK < waterBoilingPointK(env.pressureBar)) {
          target.moles.H2O_l = (target.moles.H2O_l || 0) + totalSteam;
          heatAddedJ += totalSteam * CONSTANTS.DELTA_H_VAP_WATER_J;
          addedCapJK += totalSteam * CONSTANTS.CP_H2O_J_MOL_K;
        } else {
          target.escapedGasMoles.H2O_g = (target.escapedGasMoles.H2O_g || 0) + totalSteam;
        }
      }
      if ((produced.HCl_g || 0) > 0 && (target.moles.H2O_l || 0) > 1e-4) {
        const dHCl = produced.HCl_g;
        target.moles.H_aq = (target.moles.H_aq || 0) + dHCl;
        target.moles.Cl_aq = (target.moles.Cl_aq || 0) + dHCl;
        heatAddedJ += dHCl * CONSTANTS.DELTA_H_VAP_HCL_AQ_J;
      } else if ((produced.HCl_g || 0) > 0) {
        target.escapedGasMoles.HCl_g = (target.escapedGasMoles.HCl_g || 0) + produced.HCl_g;
      }
      for (const g of NON_STEAM_GASES) {
        if (g !== 'HCl_g' && produced[g] > 0) {
          target.escapedGasMoles[g] = (target.escapedGasMoles[g] || 0) + produced[g];
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
      vessel.internalPressureBar = env.pressureBar;
      return events;
    }
  }

  // Stoppered closed (or syringe bottomed out) -> gas accumulates in headspace
  if (vessel.sealedAirMoles === null || vessel.sealedAirMoles === undefined) {
    vessel.sealedAirMoles = (env.pressureBar * headspaceL) / (CONSTANTS.R_L_BAR_MOL_K * vessel.tempK);
  }

  let extraGasMol = 0;
  for (const g of NON_STEAM_GASES) {
    vessel.headspaceGasMoles[g] = (vessel.headspaceGasMoles[g] || 0) + produced[g];
    extraGasMol += vessel.headspaceGasMoles[g] || 0;
  }
  vessel.headspaceGasMoles.H2O_g = (vessel.headspaceGasMoles.H2O_g || 0) + totalSteam;

  // Condense excess headspace steam back to droplets when a sealed vessel cools below dew point
  const headSteam = vessel.headspaceGasMoles.H2O_g || 0;
  if (headSteam > 1e-8 && vessel.tempK < waterBoilingPointK(env.pressureBar)) {
    const pHeadSteam = (headSteam * CONSTANTS.R_L_BAR_MOL_K * vessel.tempK) / headspaceL;
    const pSatV = waterVaporPressureBar(vessel.tempK);
    if (pHeadSteam > pSatV * 1.02) {
      const nSteamEq = (pSatV * headspaceL) / (CONSTANTS.R_L_BAR_MOL_K * vessel.tempK);
      const dCond = Math.min(headSteam - nSteamEq, (headSteam - nSteamEq) * 0.08);
      if (dCond > 1e-12) {
        vessel.headspaceGasMoles.H2O_g = Math.max(0, headSteam - dCond);
        vessel.moles.H2O_l = (vessel.moles.H2O_l || 0) + dCond;
      }
    }
  }

  extraGasMol += vessel.headspaceGasMoles.H2O_g || 0;

  const partialAirAndGas =
    ((vessel.sealedAirMoles + extraGasMol) * CONSTANTS.R_L_BAR_MOL_K * vessel.tempK) / headspaceL;
  const hasWater = (vessel.moles.H2O_l || 0) > 1e-6;
  const vaporContribution = hasWater ? Math.max(0, waterVaporPressureBar(vessel.tempK) - 0.03) : 0;

  vessel.internalPressureBar = partialAirAndGas + vaporContribution;

  // Check overpressure thresholds
  if (spec.shatterPressureBar && vessel.internalPressureBar >= spec.shatterPressureBar) {
    vessel.isShattered = true;
    vessel.isStoppered = false;
    vessel.connectedSyringeId = null;
    vessel.connectedTargetId = null;
    events.push({ type: 'shatter', vesselId: vessel.id });
  } else if (spec.popPressureBar && vessel.internalPressureBar >= spec.popPressureBar) {
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
