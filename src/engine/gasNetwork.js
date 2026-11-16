import { CONSTANTS, waterBoilingPointK, waterVaporPressureBar } from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { APPARATUS } from '../data/apparatus.js';
import { computeLiquidVolumeL, computeSolidVolumeMl } from './equilibrium.js';

export const NON_STEAM_GASES = ['H2_g', 'O2_g', 'HCl_g', 'Cl2_g', 'HNO3_g'];
export const ALL_GASES = [...NON_STEAM_GASES, 'H2O_g'];

export function computeSyringeHeatCapacityJK(syringe) {
  let cpTotal = 34.0; // Borosilicate syringe barrel & glass plunger thermal mass
  cpTotal += (syringe.condensedWaterMol || 0) * CONSTANTS.CP_H2O_J_MOL_K;
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

  // Connected to a Gas Syringe via rubber tubing
  if (vessel.connectedSyringeId) {
    const syringe = getApparatusById(vessel.connectedSyringeId);
    if (syringe && !syringe.isBroken) {
      const syringeSpec = APPARATUS[syringe.typeId];
      const currentVolMl = computeSyringeGasVolumeMl(syringe, env);

      if (currentVolMl < syringeSpec.maxVolumeMl * 0.995) {
        if (syringe.tempK == null) syringe.tempK = env.tempK;

        let incomingHeatCapJK = 0;
        for (const g of NON_STEAM_GASES) {
          if (produced[g] > 0) {
            syringe.gasMoles[g] = (syringe.gasMoles[g] || 0) + produced[g];
            incomingHeatCapJK += produced[g] * (SPECIES[g]?.cp || 30);
          }
        }
        if (totalSteam > 0) {
          syringe.gasMoles.H2O_g = (syringe.gasMoles.H2O_g || 0) + totalSteam;
          incomingHeatCapJK += totalSteam * (SPECIES.H2O_g?.cp || 33.58);
        }

        if (totalPerm + totalSteam > 1e-11) {
          syringe.inflowTempK = vessel.tempK;
          const cSyr = computeSyringeHeatCapacityJK(syringe);
          const dT = (incomingHeatCapJK * (vessel.tempK - syringe.tempK)) / cSyr;
          syringe.tempK = Math.max(220, Math.min(600, syringe.tempK + dT));
        }

        vessel.internalPressureBar = env.pressureBar;
        return events;
      }
      // Syringe maxed out -> remaining gas pressurizes vessel!
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
    events.push({ type: 'shatter', vesselId: vessel.id });
  } else if (spec.popPressureBar && vessel.internalPressureBar >= spec.popPressureBar) {
    vessel.isStoppered = false;
    vessel.connectedSyringeId = null;
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
