import {
  CONSTANTS,
  solutionBoilingPointK,
  waterMoleFraction,
  waterVaporPressureMmHg,
} from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { APPARATUS } from '../data/apparatus.js';
import { computeLiquidVolumeL, computeSolidVolumeMl } from './equilibrium.js';

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
  const maxW = APPARATUS.burner.maxPowerW || 650;
  const frac = Math.max(0.02, Math.min(1, burnerPowerW / maxW));
  const tFlame =
    flameLevel > 0 && Number.isInteger(flameLevel) && APPARATUS.burner.effectiveFlameK?.[flameLevel]
      ? APPARATUS.burner.effectiveFlameK[flameLevel]
      : 335.0 + 361.0 * Math.pow(frac, 0.54);
  const captureScale = Math.min(1.0, (spec.heatLossCoeffWK || 0.45) / 0.42);
  const tStart = 350.0;
  if (vesselTempK <= tStart) return burnerPowerW * captureScale;
  const drivingFrac = Math.max(0, (tFlame - vesselTempK) / Math.max(20, tFlame - tStart));
  return burnerPowerW * captureScale * drivingFrac;
}

/**
 * Universal Clausius-Clapeyron + Stefan-Maxwell + Gilliland air-diffusion evaporation model (mol/s).
 * Uses only molarMass, boilTempK & dHVapJ per liquid species in SPECIES database.
 */
export function calcEvaporationRateMol(
  species,
  moleFraction,
  tempK,
  areaCm2,
  pAmbientPa = 0,
  isStirred = false
) {
  if (!species || !species.boilTempK || !species.dHVapJ || moleFraction <= 0 || areaCm2 <= 0) {
    return 0;
  }
  const R = CONSTANTS.R_J_MOL_K;
  const P_atm = 101325;
  const T = Math.max(200, tempK);
  const P_sat = P_atm * Math.exp((species.dHVapJ / R) * (1 / species.boilTempK - 1 / T));
  const P_surface = moleFraction * (species.activityCoeff || 1.0) * P_sat;
  if (P_surface <= pAmbientPa) return 0;

  // Gilliland diffusivity scaling in lab air (M_air = 28.97 g/mol)
  const diffFactor = Math.pow(Math.sqrt(1 / species.molarMass + 1 / 28.97), 2 / 3);
  const stirBoost = isStirred ? 1.85 : 1.0;
  const k_mass = 5.4e-6 * stirBoost * diffFactor;
  return k_mass * areaCm2 * ((P_surface - pAmbientPa) / (R * T));
}

/**
 * Optical water-vapor mist visibility [0..1] determined by mixing dew-point condensation
 * above surface: 0 at 25 C in 60% RH room air, thin wisps at 45-55 C, dense plume near boiling.
 */
export function computeSteamOpacity(waterTempK, envTempK = CONSTANTS.T_STD_K, rh = CONSTANTS.RELATIVE_HUMIDITY) {
  const tWaterC = waterTempK - CONSTANTS.KELVIN_OFFSET;
  const tRoomC = envTempK - CONSTANTS.KELVIN_OFFSET;
  const raw = (tWaterC - (tRoomC + 22 - 15 * rh)) / 45;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Advance vessel thermal state, surface evaporation/HCl fuming, and azeotropic boiling over dt.
 * Returns { steamProducedMol, hclProducedMol, isBoiling, boilingPointK, steamOpacity }
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

  // Regime 1: Universal sub-boiling evaporation (Clausius-Clapeyron + Stefan-Maxwell + Gilliland)
  // Open vessels evaporate gently at any T; syringe-connected vessels vent expanding warm vapor once T >= 80 C.
  const canSubBoilVent = !vessel.isStoppered || (vessel.connectedSyringeId && vessel.tempK >= 353.15);
  const nEthanol = vessel.moles.C2H5OH_l || 0;
  if ((nWater > 1e-7 || nEthanol > 1e-7) && canSubBoilVent && vessel.tempK < boilingPointK) {
    const xH2O = waterMoleFraction(vessel.moles);
    const volMl =
      computeLiquidVolumeL(vessel.moles, vessel.tempK) * 1000 +
      computeSolidVolumeMl(vessel.moles);
    const areaCm2 = spec.geometry
      ? Math.max(0.2, spec.geometry.getLiquidState(volMl).surfaceAreaCm2)
      : spec.surfaceAreaCm2 || 20.0;
    const tubingScale = vessel.isStoppered && vessel.connectedSyringeId ? 0.55 : 1.0;
    const effAreaCm2 = areaCm2 * tubingScale;
    const isStirred = (vessel.stirTimer || 0) > 0;

    // 1a) Water sub-boiling evaporation (against ambient 60% RH water vapor pressure)
    const pAmbH2OPa =
      CONSTANTS.RELATIVE_HUMIDITY *
      101325 *
      Math.exp((SPECIES.H2O_l.dHVapJ / CONSTANTS.R_J_MOL_K) * (1 / SPECIES.H2O_l.boilTempK - 1 / env.tempK));
    const evapH2OMolS =
      nWater > 1e-7
        ? calcEvaporationRateMol(SPECIES.H2O_l, xH2O, vessel.tempK, effAreaCm2, pAmbH2OPa, isStirred)
        : 0;
    const subBoilEvap = Math.min(nWater, evapH2OMolS * dt);

    // 1b) Volatile ethanol co-evaporation (e.g. from 1% phenolphthalein solution)
    const solTotal = Math.max(1e-9, nWater + nEthanol);
    const xEtOH = nEthanol / solTotal;
    const evapEtOHMolS =
      nEthanol > 1e-7
        ? calcEvaporationRateMol(SPECIES.C2H5OH_l, xEtOH, vessel.tempK, effAreaCm2, 0, isStirred)
        : 0;
    const subBoilEtOH = Math.min(nEthanol, evapEtOHMolS * dt);

    const nH = vessel.moles.H_aq || 0;
    const nCl = vessel.moles.Cl_aq || 0;
    const nHCl = Math.min(nH, nCl);
    const rVap = computeHClVaporRatio(nHCl, nWater);

    let subBoilHCl = 0;
    if (nHCl > 1e-12) {
      const mHCl = nHCl * CONSTANTS.M_HCL;
      const mH2O = nWater * CONSTANTS.M_H2O;
      const wHCl = mHCl / Math.max(1e-9, mHCl + mH2O);
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
    if (subBoilEtOH > 1e-12) {
      vessel.moles.C2H5OH_l -= subBoilEtOH;
      if (vessel.moles.C2H5OH_l < 1e-12) delete vessel.moles.C2H5OH_l;
      evapCoolingJ -= subBoilEtOH * SPECIES.C2H5OH_l.dHVapJ;
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
  const steamOpacity = (vessel.moles.H2O_l || 0) > 1e-7
    ? computeSteamOpacity(newTempK, env.tempK, CONSTANTS.RELATIVE_HUMIDITY)
    : 0;

  return {
    steamProducedMol,
    hclProducedMol,
    isBoiling,
    boilingPointK,
    steamOpacity,
  };
}
