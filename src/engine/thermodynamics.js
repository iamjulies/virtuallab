import {
  CONSTANTS,
  solutionBoilingPointK,
  waterMoleFraction,
  waterVaporPressureMmHg,
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
 * Compute HCl(aq) vapor molar ratio (mol HCl per mol H2O) along the HCl-H2O
 * azeotropic curve (20.24% w/w azeotrope => ~0.1254 mol HCl / mol H2O).
 */
function computeHClVaporRatio(nHCl, nWater) {
  if (nHCl <= 1e-12 || nWater <= 1e-12) return 0;
  const mHCl = nHCl * CONSTANTS.M_HCL;
  const mH2O = nWater * CONSTANTS.M_H2O;
  const wHCl = mHCl / (mHCl + mH2O);
  const wAz = CONSTANTS.HCL_AZEOTROPE_WT_FRAC;
  const rAz = (wAz / CONSTANTS.M_HCL) / ((1 - wAz) / CONSTANTS.M_H2O);
  if (wHCl >= wAz) {
    return rAz * (1 + 7.5 * (wHCl - wAz));
  }
  return rAz * Math.pow(wHCl / wAz, 1.35);
}

/**
 * Compute realistic Newton-convection burner heating rate (W) that tapers as vessel
 * temperature approaches the spirit-lamp plume limit (~170 / 228 / 280 C dry steady state).
 */
function computeEffectiveBurnerPowerW(spec, vesselTempK, burnerPowerW, flameLevel) {
  if (burnerPowerW <= 0) return 0;
  const tFlame =
    flameLevel > 0
      ? APPARATUS.burner.effectiveFlameK?.[flameLevel] || 696.0
      : 696.0;
  const captureScale = Math.min(1.0, (spec.heatLossCoeffWK || 0.45) / 0.42);
  const tStart = 350.0;
  if (vesselTempK <= tStart) return burnerPowerW * captureScale;
  const drivingFrac = Math.max(0, (tFlame - vesselTempK) / Math.max(20, tFlame - tStart));
  return burnerPowerW * captureScale * drivingFrac;
}

/**
 * Advance vessel thermal state, surface evaporation/HCl fuming, and azeotropic boiling over dt.
 * Returns { steamProducedMol, hclProducedMol, isBoiling, boilingPointK }
 */
export function stepVesselThermodynamics(
  vessel,
  dt,
  env,
  reactionHeatJ,
  burnerPowerW,
  flameLevel = 0
) {
  const spec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
  const cTotal = computeHeatCapacityJK(vessel);

  // Convective + Stefan-Boltzmann radiative heat loss to ambient room
  const hLoss = spec.heatLossCoeffWK || 0.35;
  const radCoeff = hLoss * 4.0e-9;
  const tEnv = Math.max(200, env.tempK);
  const ambientExchangeJ =
    (-hLoss * (vessel.tempK - env.tempK) -
      radCoeff * (Math.pow(vessel.tempK, 4) - Math.pow(tEnv, 4))) *
    dt;

  const effectiveBurnerW = computeEffectiveBurnerPowerW(
    spec,
    vessel.tempK,
    burnerPowerW,
    flameLevel
  );

  // Sub-boiling surface evaporation & concentrated HCl(g) fuming
  let steamProducedMol = 0;
  let hclProducedMol = 0;
  let evapCoolingJ = 0;
  const nWater = vessel.moles.H2O_l || 0;

  const effectivePressureBar =
    vessel.isStoppered && !vessel.connectedSyringeId
      ? Math.max(env.pressureBar, vessel.internalPressureBar || env.pressureBar)
      : env.pressureBar;

  const boilingPointK = solutionBoilingPointK(vessel.moles, effectivePressureBar);

  // Regime 1: Sub-boiling surface evaporation (Dalton + Raoult + Antoine)
  // dm_evap/dt = km * A_surface * max(0, x_H2O * P_sat(T) - RH * P_sat(T_room))
  if (nWater > 1e-7 && !vessel.isStoppered && vessel.tempK < boilingPointK) {
    const xH2O = waterMoleFraction(vessel.moles);
    const pSurfMmHg = xH2O * waterVaporPressureMmHg(vessel.tempK);
    const pAmbMmHg = CONSTANTS.RELATIVE_HUMIDITY * waterVaporPressureMmHg(env.tempK);
    const deltaPMmHg = Math.max(0, pSurfMmHg - pAmbMmHg);
    const areaCm2 = spec.surfaceAreaCm2 || 20.0;
    const km = 2.4e-6 * (vessel.stirTimer > 0 ? 2.0 : 1.0); // g / (cm^2 * s * mmHg)
    const evapMolS = (km * areaCm2 * deltaPMmHg) / CONSTANTS.M_H2O;
    const subBoilEvap = Math.min(nWater, evapMolS * dt);

    const nH = vessel.moles.H_aq || 0;
    const nCl = vessel.moles.Cl_aq || 0;
    const nHCl = Math.min(nH, nCl);
    const rVap = computeHClVaporRatio(nHCl, nWater);

    let subBoilHCl = 0;
    if (nHCl > 1e-12) {
      const mHCl = nHCl * CONSTANTS.M_HCL;
      const mH2O = nWater * CONSTANTS.M_H2O;
      const wHCl = mHCl / (mHCl + mH2O);
      // Direct HCl outgassing above the 20.24% azeotrope ("fuming slightly" at room temp)
      const fumeExcess = Math.max(0, wHCl - CONSTANTS.HCL_AZEOTROPE_WT_FRAC - 0.01);
      const fumeMol =
        fumeExcess > 0
          ? 0.0002 * (fumeExcess / 0.16) * Math.exp(0.038 * (vessel.tempK - CONSTANTS.T_STD_K)) * dt
          : 0;
      subBoilHCl = Math.min(nHCl, subBoilEvap * rVap + fumeMol);
      if (subBoilEvap >= nWater * 0.9999) {
        subBoilHCl = nHCl;
      }
    }

    if (subBoilEvap > 1e-12) {
      vessel.moles.H2O_l -= subBoilEvap;
      if (vessel.moles.H2O_l < 1e-12) delete vessel.moles.H2O_l;
      steamProducedMol += subBoilEvap;
      evapCoolingJ -= subBoilEvap * CONSTANTS.DELTA_H_VAP_WATER_J;
    }
    if (subBoilHCl > 1e-12) {
      vessel.moles.H_aq = Math.max(0, (vessel.moles.H_aq || 0) - subBoilHCl);
      vessel.moles.Cl_aq = Math.max(0, (vessel.moles.Cl_aq || 0) - subBoilHCl);
      if (vessel.moles.H_aq < 1e-13) delete vessel.moles.H_aq;
      if (vessel.moles.Cl_aq < 1e-13) delete vessel.moles.Cl_aq;
      hclProducedMol += subBoilHCl;
      evapCoolingJ -= subBoilHCl * CONSTANTS.DELTA_H_VAP_HCL_AQ_J;
    }
  }

  // Update temperature
  const netHeatJ = reactionHeatJ + effectiveBurnerW * dt + ambientExchangeJ + evapCoolingJ;
  let newTempK = vessel.tempK + netHeatJ / cTotal;
  newTempK = Math.max(220, Math.min(1100, newTempK));

  // Boiling clamp when aqueous solvent remains
  let isBoiling = false;
  const remainingWater = vessel.moles.H2O_l || 0;
  if (remainingWater > 1e-7 && newTempK >= boilingPointK) {
    isBoiling = true;
    const excessJ = (newTempK - boilingPointK) * cTotal;
    const nH = vessel.moles.H_aq || 0;
    const nCl = vessel.moles.Cl_aq || 0;
    const nHCl = Math.min(nH, nCl);
    const rVap = computeHClVaporRatio(nHCl, remainingWater);
    const effDeltaH =
      CONSTANTS.DELTA_H_VAP_WATER_J + rVap * CONSTANTS.DELTA_H_VAP_HCL_AQ_J;

    const boilMol = Math.min(remainingWater, excessJ / effDeltaH);
    const boilHCl =
      nHCl > 1e-12
        ? remainingWater - boilMol <= 1e-7
          ? nHCl
          : Math.min(nHCl, boilMol * rVap)
        : 0;

    if (boilMol > 1e-12 || boilHCl > 1e-12) {
      vessel.moles.H2O_l = Math.max(0, remainingWater - boilMol);
      if (vessel.moles.H2O_l < 1e-12) delete vessel.moles.H2O_l;
      steamProducedMol += boilMol;

      if (boilHCl > 1e-12) {
        vessel.moles.H_aq = Math.max(0, (vessel.moles.H_aq || 0) - boilHCl);
        vessel.moles.Cl_aq = Math.max(0, (vessel.moles.Cl_aq || 0) - boilHCl);
        if (vessel.moles.H_aq < 1e-13) delete vessel.moles.H_aq;
        if (vessel.moles.Cl_aq < 1e-13) delete vessel.moles.Cl_aq;
        hclProducedMol += boilHCl;
      }

      const usedJ =
        boilMol * CONSTANTS.DELTA_H_VAP_WATER_J +
        boilHCl * CONSTANTS.DELTA_H_VAP_HCL_AQ_J;
      const leftoverJ = Math.max(0, excessJ - usedJ);
      newTempK = boilingPointK + leftoverJ / cTotal;
    } else {
      newTempK = boilingPointK;
    }
  }

  vessel.tempK = newTempK;

  return {
    steamProducedMol,
    hclProducedMol,
    isBoiling,
    boilingPointK,
  };
}
