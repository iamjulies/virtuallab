import {
  CONSTANTS,
  computeEthanolWaterVLE,
  solutionBoilingPointK,
  waterVaporPressureBar,
  waterVaporPressureMmHg,
} from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { APPARATUS } from '../data/apparatus.js';
import {
  calcEffectiveSoluteMoles,
  computeLiquidVolumeL,
  computeSolidVolumeMl,
  solutionFreezingPointK,
} from './equilibrium.js';

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
  isStirred = false,
  activityCoeffOverride = null
) {
  if (!species || !species.boilTempK || !species.dHVapJ || moleFraction <= 0 || areaCm2 <= 0) {
    return 0;
  }
  const R = CONSTANTS.R_J_MOL_K;
  const P_atm = 101325;
  const T = Math.max(200, tempK);
  const P_sat = P_atm * Math.exp((species.dHVapJ / R) * (1 / species.boilTempK - 1 / T));
  const gamma = activityCoeffOverride ?? species.activityCoeff ?? 1.0;
  const P_surface = moleFraction * gamma * P_sat;
  if (P_surface <= pAmbientPa) return 0;

  // Gilliland diffusivity scaling in lab air (M_air = 28.97 g/mol)
  const diffFactor = Math.pow(Math.sqrt(1 / species.molarMass + 1 / 28.97), 2 / 3);
  const stirBoost = isStirred ? 1.85 : 1.0;
  const k_mass = 5.4e-6 * stirBoost * diffFactor;
  return k_mass * areaCm2 * ((P_surface - pAmbientPa) / (R * T));
}

/**
 * Optical water-vapor mist visibility [0..1] determined by mixing dew-point condensation
 * above surface: 0 when T_solution <= T_room + 15 K (at 60% RH), thin wisps above, dense plume near boiling.
 */
export function computeSteamOpacity(waterTempK, envTempK = CONSTANTS.T_STD_K, rh = CONSTANTS.RELATIVE_HUMIDITY) {
  const tWaterC = waterTempK - CONSTANTS.KELVIN_OFFSET;
  const tRoomC = envTempK - CONSTANTS.KELVIN_OFFSET;
  const raw = (tWaterC - (tRoomC + 24 - 15 * rh)) / 32;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Advance solid-liquid water freezing / melting phase transition (H2O(l) <-> H2O(s))
 * with Raoult cryoscopy freezing-point depression and latent heat clamping (6010 J/mol).
 * Returns { updatedTempK, freezeMeltRateMolS, freezePointK }
 */
export function updateFreezeMeltPhase(vessel, dt, candidateTempK = null, heatCapacityJK = null) {
  const Tf_pure = CONSTANTS.T_FREEZE_WATER_K;
  const Kf = CONSTANTS.CRYOSCOPY_KF_WATER;
  const dH_fus = CONSTANTS.DELTA_H_FUS_WATER_J;
  const moles = vessel.moles;

  const liquidWaterMol = moles.H2O_l || 0;
  const iceMol = moles.H2O_s || 0;
  let T = candidateTempK ?? vessel.tempK;

  if (liquidWaterMol <= 1e-12 && iceMol <= 1e-12) {
    vessel.isFrozenSolid = false;
    vessel.freezePointK = solutionFreezingPointK(moles);
    vessel.lastFreezeMeltRateMolS = 0;
    return { updatedTempK: T, freezeMeltRateMolS: 0, freezePointK: vessel.freezePointK };
  }

  const effectiveSoluteMol = calcEffectiveSoluteMoles(moles);
  const T_freeze_bulk = solutionFreezingPointK(moles, true);
  const T_freeze_inst = solutionFreezingPointK(moles, liquidWaterMol < 1e-4 && iceMol > 0);
  const T_eutectic_complete = Math.max(CONSTANTS.EUTECTIC_FLOOR_K, Math.min(258.0, T_freeze_bulk - 14.0));
  const belowEutecticComplete = T_freeze_bulk > CONSTANTS.EUTECTIC_FLOOR_K + 2.0 && T <= T_eutectic_complete;
  const T_freeze = belowEutecticComplete ? Math.max(T_freeze_inst, T_eutectic_complete) : T_freeze_inst;
  const T_melt =
    iceMol > 1e-7 && liquidWaterMol <= Math.max(0.05, (vessel.moles.Na_s || 0) * 6.0)
      ? T_freeze_bulk
      : T_freeze_inst;
  const heatCapacity = Math.max(heatCapacityJK ?? computeHeatCapacityJK(vessel), 20.0);

  // Protect only the localized thin melt pocket right under an actively hot Sodium droplet on ice
  const nNa = moles.Na_s || 0;
  const protectedMeltMol =
    nNa > 1e-8 && (vessel.naTempK ?? T) > Tf_pure
      ? Math.min(liquidWaterMol, Math.max(0.012, nNa * 6.0))
      : 0;
  const freezableWaterMol = Math.max(0, liquidWaterMol - protectedMeltMol);

  let netFreezeMol = 0;

  if (T < T_freeze && freezableWaterMol > 1e-12) {
    const deficitEnergyJ = heatCapacity * (T_freeze - T);
    let molToFreeze = Math.min(freezableWaterMol, deficitEnergyJ / dH_fus);

    if (!belowEutecticComplete && effectiveSoluteMol > 1e-9 && T < Tf_pure - 1e-4 && T_freeze_inst > CONSTANTS.EUTECTIC_FLOOR_K) {
      const mH2OKgPerMol = CONSTANTS.M_H2O / 1000;
      const nWEq = (Kf * effectiveSoluteMol) / (Math.max(1e-4, Tf_pure - T) * mH2OKgPerMol);
      if (liquidWaterMol > nWEq) {
        molToFreeze = Math.min(molToFreeze, Math.max(0, liquidWaterMol - nWEq));
      }
    }

    if (molToFreeze > 1e-12) {
      moles.H2O_l = Math.max(0, liquidWaterMol - molToFreeze);
      if (moles.H2O_l < 1e-12) delete moles.H2O_l;
      moles.H2O_s = iceMol + molToFreeze;
      T += (molToFreeze * dH_fus) / heatCapacity;
      netFreezeMol = molToFreeze;
    }
  } else if (T > T_melt && iceMol > 1e-12) {
    const excessEnergyJ = heatCapacity * (T - T_melt);
    const molToMelt = Math.min(iceMol, excessEnergyJ / dH_fus);
    if (molToMelt > 1e-12) {
      moles.H2O_s = Math.max(0, iceMol - molToMelt);
      if (moles.H2O_s < 1e-12) delete moles.H2O_s;
      moles.H2O_l = liquidWaterMol + molToMelt;
      T -= (molToMelt * dH_fus) / heatCapacity;
      netFreezeMol = -molToMelt;
    }
  }

  const remWater = moles.H2O_l || 0;
  const remIce = moles.H2O_s || 0;
  vessel.isFrozenSolid = remWater < 1e-4 && remIce > 1e-7;
  vessel.freezePointK = solutionFreezingPointK(moles, vessel.isFrozenSolid);
  vessel.lastFreezeMeltRateMolS = netFreezeMol / Math.max(1e-5, dt);
  if (candidateTempK === null) {
    vessel.tempK = T;
  }

  return {
    updatedTempK: T,
    freezeMeltRateMolS: vessel.lastFreezeMeltRateMolS,
    freezePointK: vessel.freezePointK,
  };
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
  const baseHLoss = spec.heatLossCoeffWK || 0.35;
  const effectiveBurnerW = computeEffectiveBurnerPowerW(
    spec,
    vessel.tempK,
    burnerPowerW,
    flameLevel
  );
  const isCryoCool =
    effectiveBurnerW <= 0 && env.tempK < CONSTANTS.T_FREEZE_WATER_K && vessel.tempK > env.tempK;
  const isCryoThaw =
    effectiveBurnerW <= 0 &&
    vessel.tempK < CONSTANTS.T_FREEZE_WATER_K &&
    env.tempK >= CONSTANTS.T_FREEZE_WATER_K &&
    vessel.tempK < env.tempK;
  const hLoss = isCryoCool ? baseHLoss * 75.0 : isCryoThaw ? baseHLoss * 40.0 : baseHLoss;
  const radCoeff = baseHLoss * 4.0e-9;
  const tEnv = Math.max(180, env.tempK);
  const ambientExchangeJ =
    (-hLoss * (vessel.tempK - env.tempK) -
      radCoeff * (Math.pow(vessel.tempK, 4) - Math.pow(tEnv, 4))) *
    dt;

  // Sub-boiling surface evaporation & concentrated HCl(g) / NH3(g) outgassing
  let steamProducedMol = 0;
  let ethanolProducedMol = 0;
  let hclProducedMol = 0;
  let nh3ProducedMol = 0;
  let evapCoolingJ = 0;
  const nWater = vessel.moles.H2O_l || 0;
  const nEthanol = vessel.moles.C2H5OH_l || 0;
  const nAmmonia = vessel.moles.NH3_aq || 0;

  const hasOpenTube = !!(vessel.connectedTargetId || vessel.connectedSyringeId);
  const effectivePressureBar =
    vessel.isStoppered && !hasOpenTube
      ? Math.max(env.pressureBar, vessel.internalPressureBar || env.pressureBar)
      : env.pressureBar;

  const boilingPointK = solutionBoilingPointK(vessel.moles, effectivePressureBar);

  // Regime 1: Universal sub-boiling evaporation (Clausius-Clapeyron + Margules activity + Stefan-Maxwell + Gilliland)
  // Open vessels evaporate gently at any T; tube-connected vessels vent expanding warm vapor once T >= 80 C,
  // and fuming conc. HCl (>21.2%) continuously outgasses dry HCl(g) through an open delivery tube.
  const canSubBoilVent = !vessel.isStoppered || (hasOpenTube && vessel.tempK >= 351.0);
  const canVentFumingHCl = !vessel.isStoppered || hasOpenTube;
  if ((nWater > 1e-7 || nEthanol > 1e-7 || nAmmonia > 1e-8) && (canSubBoilVent || canVentFumingHCl) && vessel.tempK < boilingPointK) {
    const vle = computeEthanolWaterVLE(vessel.moles, vessel.tempK, false);
    const volMl =
      computeLiquidVolumeL(vessel.moles, vessel.tempK) * 1000 +
      computeSolidVolumeMl(vessel.moles);
    const areaCm2 = spec.geometry
      ? Math.max(0.2, spec.geometry.getLiquidState(volMl).surfaceAreaCm2)
      : spec.surfaceAreaCm2 || 20.0;
    const tubingScale = vessel.isStoppered && hasOpenTube ? 0.55 : 1.0;
    const effAreaCm2 = areaCm2 * tubingScale;
    const isStirred = (vessel.stirTimer || 0) > 0;

    // 1a) Water sub-boiling evaporation (against ambient 60% RH water/ice vapor pressure)
    const pAmbH2OPa = CONSTANTS.RELATIVE_HUMIDITY * waterVaporPressureBar(env.tempK) * 100000;
    const evapH2OMolS =
      nWater > 1e-7 && canSubBoilVent && !vessel.isFrozenSolid
        ? calcEvaporationRateMol(SPECIES.H2O_l, vle.xW0 * vle.fIon, vessel.tempK, effAreaCm2, pAmbH2OPa, isStirred, vle.gammaW)
        : 0;
    const subBoilEvap = Math.min(nWater, evapH2OMolS * dt);

    // 1b) Volatile ethanol evaporation (Margules positive azeotrope gamma_E boosts trace & blend volatility)
    const evapEtOHMolS =
      nEthanol > 1e-7 && canSubBoilVent
        ? calcEvaporationRateMol(SPECIES.C2H5OH_l, vle.xE0 * vle.fIon, vessel.tempK, effAreaCm2, 0, isStirred, vle.gammaE)
        : 0;
    const subBoilEtOH = Math.min(nEthanol, evapEtOHMolS * dt);

    const nH = vessel.moles.H_aq || 0;
    const nCl = vessel.moles.Cl_aq || 0;
    const nHCl = Math.min(nH, nCl);
    const rVap = computeHClVaporRatio(nHCl, nWater);

    let subBoilHCl = 0;
    if (!vessel.isFrozenSolid && nWater > 1e-7 && nHCl > 1e-12) {
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
      ethanolProducedMol += subBoilEtOH;
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

    // 1d) Group 4 volatile reactant outgassing: NH3(aq) -> NH3(g)
    if (!vessel.isFrozenSolid && nWater > 1e-7 && nAmmonia > 1e-10) {
      const liqVolL = Math.max(1e-5, volMl / 1000);
      const cNH3 = nAmmonia / liqVolL;
      const outgasNH3MolS =
        2.4e-5 *
        (effAreaCm2 / 4.0) *
        Math.pow(cNH3 / 10.0, 1.25) *
        Math.exp(0.052 * Math.max(-20, vessel.tempK - CONSTANTS.T_STD_K)) *
        (isStirred ? 1.75 : 1.0);
      let subBoilNH3 = Math.min(
        nAmmonia,
        outgasNH3MolS * dt + subBoilEvap * (nAmmonia / Math.max(1e-6, nWater)) * 3.0
      );
      if (subBoilEvap >= nWater * 0.9999) {
        subBoilNH3 = nAmmonia;
      }
      if (subBoilNH3 > 1e-12) {
        vessel.moles.NH3_aq = Math.max(0, nAmmonia - subBoilNH3);
        if (vessel.moles.NH3_aq < 1e-13) delete vessel.moles.NH3_aq;
        nh3ProducedMol += subBoilNH3;
        evapCoolingJ -= subBoilNH3 * 23350;
      }
    }
  }

  // Update temperature
  const netHeatJ = reactionHeatJ + effectiveBurnerW * dt + ambientExchangeJ + evapCoolingJ;
  let newTempK = vessel.tempK + netHeatJ / cTotal;
  newTempK = Math.max(200, Math.min(1100, newTempK));

  // Regime 2: Co-distillation boiling clamp for Water + Ethanol (including pure EtOH at 78.3 C!)
  let isBoiling = false;
  const remainingWater = vessel.moles.H2O_l || 0;
  const remainingEtOH = vessel.moles.C2H5OH_l || 0;
  if ((remainingWater > 1e-7 || remainingEtOH > 1e-7) && newTempK >= boilingPointK) {
    isBoiling = true;
    const excessJ = (newTempK - boilingPointK) * cTotal;
    const nH = vessel.moles.H_aq || 0;
    const nCl = vessel.moles.Cl_aq || 0;
    const nHCl = Math.min(nH, nCl);
    const rVap = computeHClVaporRatio(nHCl, remainingWater);
    const vleBoil = computeEthanolWaterVLE(vessel.moles, boilingPointK, true);
    const yE = remainingEtOH > 1e-7 ? (remainingWater > 1e-7 ? vleBoil.yE : 1.0) : 0;
    const yW = 1 - yE;

    const effWaterHeat = CONSTANTS.DELTA_H_VAP_WATER_J + rVap * CONSTANTS.DELTA_H_VAP_HCL_AQ_J;
    const effDeltaH = Math.max(1000, yE * SPECIES.C2H5OH_l.dHVapJ + yW * effWaterHeat);
    const boilTot = excessJ / effDeltaH;

    let boilEtOH = Math.min(remainingEtOH, boilTot * yE);
    let boilMol = Math.min(remainingWater, boilTot * yW);
    // If one solvent is exhausted inside the step, spend remaining energy cleanly on the other if applicable
    let usedJ = boilEtOH * SPECIES.C2H5OH_l.dHVapJ + boilMol * effWaterHeat;
    if (usedJ < excessJ - 1e-6) {
      const remJ = excessJ - usedJ;
      if (boilMol >= remainingWater - 1e-12 && boilEtOH < remainingEtOH) {
        const extraE = Math.min(remainingEtOH - boilEtOH, remJ / SPECIES.C2H5OH_l.dHVapJ);
        boilEtOH += extraE;
        usedJ += extraE * SPECIES.C2H5OH_l.dHVapJ;
      } else if (boilEtOH >= remainingEtOH - 1e-12 && boilMol < remainingWater) {
        const extraW = Math.min(remainingWater - boilMol, remJ / effWaterHeat);
        boilMol += extraW;
        usedJ += extraW * effWaterHeat;
      }
    }

    const boilHCl =
      nHCl > 1e-12
        ? remainingWater - boilMol <= 1e-7
          ? nHCl
          : Math.min(nHCl, boilMol * rVap)
        : 0;

    if (boilMol > 1e-12 || boilHCl > 1e-12 || boilEtOH > 1e-12) {
      if (boilMol > 1e-12) {
        vessel.moles.H2O_l = Math.max(0, remainingWater - boilMol);
        if (vessel.moles.H2O_l < 1e-12) delete vessel.moles.H2O_l;
        steamProducedMol += boilMol;
      }
      if (boilEtOH > 1e-12) {
        vessel.moles.C2H5OH_l = Math.max(0, remainingEtOH - boilEtOH);
        if (vessel.moles.C2H5OH_l < 1e-12) delete vessel.moles.C2H5OH_l;
        ethanolProducedMol += boilEtOH;
      }
      if (boilHCl > 1e-12) {
        vessel.moles.H_aq = Math.max(0, (vessel.moles.H_aq || 0) - boilHCl);
        vessel.moles.Cl_aq = Math.max(0, (vessel.moles.Cl_aq || 0) - boilHCl);
        if (vessel.moles.H_aq < 1e-13) delete vessel.moles.H_aq;
        if (vessel.moles.Cl_aq < 1e-13) delete vessel.moles.Cl_aq;
        hclProducedMol += boilHCl;
      }
      const nNH3Now = vessel.moles.NH3_aq || 0;
      if (nNH3Now > 1e-12) {
        const boilNH3 =
          remainingWater - boilMol <= 1e-7
            ? nNH3Now
            : Math.min(nNH3Now, (nNH3Now / Math.max(1e-6, remainingWater)) * boilMol * 6.5);
        if (boilNH3 > 1e-12) {
          vessel.moles.NH3_aq = Math.max(0, nNH3Now - boilNH3);
          if (vessel.moles.NH3_aq < 1e-13) delete vessel.moles.NH3_aq;
          nh3ProducedMol += boilNH3;
        }
      }

      const actualUsedJ =
        boilMol * CONSTANTS.DELTA_H_VAP_WATER_J +
        boilEtOH * SPECIES.C2H5OH_l.dHVapJ +
        boilHCl * CONSTANTS.DELTA_H_VAP_HCL_AQ_J;
      const leftoverJ = Math.max(0, excessJ - actualUsedJ);
      newTempK = boilingPointK + leftoverJ / cTotal;
    } else {
      newTempK = boilingPointK;
    }
  }

  // Regime 3: Freezing / melting solid-liquid phase clamp with cryoscopy & latent heat
  const phaseRes = updateFreezeMeltPhase(vessel, dt, newTempK, cTotal);
  newTempK = phaseRes.updatedTempK;

  vessel.tempK = newTempK;
  const hasAnyLiquid = (vessel.moles.H2O_l || 0) > 1e-7 || (vessel.moles.C2H5OH_l || 0) > 1e-7;
  const steamOpacity =
    hasAnyLiquid && !vessel.isFrozenSolid
      ? computeSteamOpacity(newTempK, env.tempK, CONSTANTS.RELATIVE_HUMIDITY)
      : 0;

  return {
    steamProducedMol,
    ethanolProducedMol,
    hclProducedMol,
    nh3ProducedMol,
    isBoiling,
    boilingPointK,
    steamOpacity,
    freezeMeltRateMolS: phaseRes.freezeMeltRateMolS,
    freezePointK: phaseRes.freezePointK,
  };
}
