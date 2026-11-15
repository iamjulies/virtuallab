import {
  CONSTANTS,
  waterBoilingPointK,
  waterVaporPressureBar,
} from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { APPARATUS } from '../data/apparatus.js';

/**
 * Compute total heat capacity C_total (J/K) of vessel + contents.
 */
export function computeHeatCapacityJK(vessel) {
  const spec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
  let cpTotal = spec.glassHeatCapacityJK || 80.0;

  for (const [id, n] of Object.entries(vessel.moles)) {
    if (n <= 0) continue;
    const sp = SPECIES[id];
    if (sp && typeof sp.cp === 'number') {
      cpTotal += n * sp.cp;
    }
  }
  return Math.max(spec.glassHeatCapacityJK * 0.7, cpTotal);
}

/**
 * Advance vessel thermal state, surface evaporation, and boiling over dt seconds.
 * Returns { steamProducedMol, isBoiling, boilingPointK }
 */
export function stepVesselThermodynamics(vessel, dt, env, reactionHeatJ, burnerPowerW) {
  const spec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
  const cTotal = computeHeatCapacityJK(vessel);

  // Ambient heat exchange (Newton cooling/warming)
  const hLoss = spec.heatLossCoeffWK || 0.35;
  const ambientExchangeJ = -hLoss * (vessel.tempK - env.tempK) * dt;

  // Gentle sub-boiling surface evaporation (faster when hot & open)
  let steamProducedMol = 0;
  let evapCoolingJ = 0;
  const nWater = vessel.moles.H2O_l || 0;

  const effectivePressureBar =
    vessel.isStoppered && !vessel.connectedSyringeId
      ? Math.max(env.pressureBar, vessel.internalPressureBar || env.pressureBar)
      : env.pressureBar;

  const boilingPointK = waterBoilingPointK(effectivePressureBar);

  if (nWater > 1e-7 && !vessel.isStoppered) {
    const pSat = waterVaporPressureBar(vessel.tempK);
    // Subtle realistic evaporation scaled to surface radius
    const evapRateMolS = Math.max(0, (pSat / Math.max(0.1, env.pressureBar)) * 0.00025);
    const subBoilEvap = Math.min(nWater, evapRateMolS * dt);
    if (subBoilEvap > 1e-12) {
      vessel.moles.H2O_l -= subBoilEvap;
      if (vessel.moles.H2O_l < 1e-12) delete vessel.moles.H2O_l;
      steamProducedMol += subBoilEvap;
      evapCoolingJ = -subBoilEvap * CONSTANTS.DELTA_H_VAP_WATER_J;
    }
  }

  // Update temperature
  const netHeatJ = reactionHeatJ + burnerPowerW * dt + ambientExchangeJ + evapCoolingJ;
  let newTempK = vessel.tempK + netHeatJ / cTotal;
  newTempK = Math.max(220, Math.min(1100, newTempK));

  // Boiling clamp when liquid water remains
  let isBoiling = false;
  const remainingWater = vessel.moles.H2O_l || 0;
  if (remainingWater > 1e-7 && newTempK >= boilingPointK) {
    isBoiling = true;
    const excessJ = (newTempK - boilingPointK) * cTotal;
    const boilMol = Math.min(remainingWater, excessJ / CONSTANTS.DELTA_H_VAP_WATER_J);
    if (boilMol > 1e-12) {
      vessel.moles.H2O_l -= boilMol;
      if (vessel.moles.H2O_l < 1e-12) delete vessel.moles.H2O_l;
      steamProducedMol += boilMol;
      const usedJ = boilMol * CONSTANTS.DELTA_H_VAP_WATER_J;
      const leftoverJ = Math.max(0, excessJ - usedJ);
      newTempK = boilingPointK + leftoverJ / cTotal;
    } else {
      newTempK = boilingPointK;
    }
  }

  vessel.tempK = newTempK;

  return {
    steamProducedMol,
    isBoiling,
    boilingPointK,
  };
}
