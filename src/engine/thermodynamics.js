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
  computePhaseStratification,
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

function computeHNO3VaporRatio(nHNO3, nWater) {
  if (nHNO3 <= 1e-12 || nWater <= 1e-12) return 0;
  const mHNO3 = nHNO3 * CONSTANTS.M_HNO3;
  const mH2O = nWater * CONSTANTS.M_H2O;
  const wHNO3 = mHNO3 / (mHNO3 + mH2O);
  const wAz = CONSTANTS.HNO3_AZEOTROPE_WT_FRAC;
  const rAz = (wAz / CONSTANTS.M_HNO3) / ((1 - wAz) / CONSTANTS.M_H2O);
  if (wHNO3 >= wAz) {
    return rAz * (1 + 6.5 * (wHNO3 - wAz));
  }
  return rAz * Math.pow(wHNO3 / wAz, 1.85);
}

/**
 * Compute realistic Newton-convection burner heating rate (W) that tapers as vessel
 * temperature approaches the spirit-lamp plume limit (~170 / 228 / 280 C dry steady state).
 */
function computeEffectiveBurnerPowerW(spec, vesselTempK, burnerPowerW, flameLevel, flameTempOverrideK = null) {
  if (burnerPowerW <= 0) return 0;
  const isBunsenHeat = Boolean(flameTempOverrideK && flameTempOverrideK >= 850);
  const maxW = isBunsenHeat ? (APPARATUS.bunsen_burner?.maxPowerW || 1550) : (APPARATUS.burner.maxPowerW || 650);
  const frac = Math.max(0.02, Math.min(1, burnerPowerW / maxW));
  const tFlame =
    flameTempOverrideK && Number.isFinite(flameTempOverrideK)
      ? flameTempOverrideK
      : flameLevel > 0 && Number.isInteger(flameLevel) && APPARATUS.burner.effectiveFlameK?.[flameLevel]
      ? APPARATUS.burner.effectiveFlameK[flameLevel]
      : 335.0 + 361.0 * Math.pow(frac, 0.54);
  const captureScale = isBunsenHeat
    ? Math.min(1.0, Math.max(0.88, (spec.heatLossCoeffWK || 0.45) / 0.35))
    : Math.min(1.0, (spec.heatLossCoeffWK || 0.45) / 0.42);
  const tStart = 350.0;
  if (vesselTempK <= tStart) return burnerPowerW * captureScale;
  const drivingFrac = Math.max(0, (tFlame - vesselTempK) / Math.max(20, tFlame - tStart));
  const taper = isBunsenHeat ? Math.pow(drivingFrac, 0.52) : drivingFrac;
  return burnerPowerW * captureScale * taper;
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

  // Gilliland diffusivity scaling in quiet lab air (M_air = 28.97 g/mol) with convective thermal plume above 35 C
  const diffFactor = Math.pow(Math.sqrt(1 / species.molarMass + 1 / 28.97), 2 / 3);
  const stirBoost = isStirred ? 1.85 : 1.0;
  const thermalPlumeBoost = 1.0 + 18.0 * Math.pow(Math.max(0, (T - 308.15) / 60.0), 1.6);
  const k_mass = 1.6e-7 * stirBoost * diffFactor * thermalPlumeBoost;
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
  if (!Number.isFinite(T)) T = CONSTANTS.T_STD_K;
  T = Math.max(155, Math.min(1950, T));

  if (liquidWaterMol <= 1e-12 && iceMol <= 1e-12) {
    vessel.isFrozenSolid = (moles.C2H5OH_l || 0) > 1e-7 && T < 159.05;
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
    iceMol > 1e-7 && liquidWaterMol <= Math.max(0.05, ((vessel.moles.Na_s || 0) + (vessel.moles.K_s || 0)) * 6.0)
      ? T_freeze_bulk
      : T_freeze_inst;
  const heatCapacity = Math.max(heatCapacityJK ?? computeHeatCapacityJK(vessel), 20.0);

  // Protect only the localized thin melt pocket right under an actively hot Alkali metal droplet (Na / K) on ice
  const nNa = moles.Na_s || 0;
  const nK = moles.K_s || 0;
  const protectedMeltMol =
    (nNa > 1e-8 && (vessel.naTempK ?? T) > Tf_pure) || (nK > 1e-8 && (vessel.kTempK ?? T) > Tf_pure)
      ? Math.min(liquidWaterMol, Math.max(0.012, (nNa + nK * 1.3) * 6.0))
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
  flameLevel = 0,
  flameTempOverrideK = null,
  bathSrc = null
) {
  const spec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
  const cTotal = Math.max(15.0, computeHeatCapacityJK(vessel));
  if (!Number.isFinite(vessel.tempK)) vessel.tempK = env.tempK || CONSTANTS.T_STD_K;

  // Convective + Stefan-Boltzmann radiative heat loss to ambient room
  const baseHLoss = spec.heatLossCoeffWK || 0.35;
  const lidLossScale =
    vessel.lidState === 'closed' ? 0.52 : vessel.lidState === 'ajar' ? 0.74 : 1.0;
  const effectiveBurnerW = computeEffectiveBurnerPowerW(
    spec,
    vessel.tempK,
    burnerPowerW,
    flameLevel,
    flameTempOverrideK
  );
  const isCryoCool =
    effectiveBurnerW <= 0 && env.tempK < CONSTANTS.T_FREEZE_WATER_K && vessel.tempK > env.tempK;
  const isCryoThaw =
    effectiveBurnerW <= 0 &&
    vessel.tempK < CONSTANTS.T_FREEZE_WATER_K &&
    env.tempK >= CONSTANTS.T_FREEZE_WATER_K &&
    vessel.tempK < env.tempK;
  const isBunsenRad = Boolean(flameTempOverrideK && flameTempOverrideK >= 850 && burnerPowerW > 600);
  const flameShieldScale = isBunsenRad && flameTempOverrideK >= 1650 ? 0.28 : 1.0;
  const hLoss = (isCryoCool ? baseHLoss * 75.0 : isCryoThaw ? baseHLoss * 40.0 : baseHLoss * flameShieldScale) * lidLossScale;
  const bunsenRadFactor =
    isBunsenRad && flameTempOverrideK >= 1650 ? 0.04e-9 : isBunsenRad ? 0.36e-9 : 4.0e-9;
  const radCoeff = baseHLoss * lidLossScale * bunsenRadFactor;
  const tEnv = Math.max(150, env.tempK);
  const tCurClamped = Math.max(150, Math.min(1950, vessel.tempK));
  const bathCoolingJ = bathSrc
    ? -cTotal * (bathSrc.coolingK || 0.28) * (tCurClamped - bathSrc.tempK) * dt
    : 0;
  const ambientExchangeJ =
    (-hLoss * (tCurClamped - env.tempK) -
      radCoeff * (Math.pow(tCurClamped, 4) - Math.pow(tEnv, 4))) *
      dt +
    bathCoolingJ;

  // Sub-boiling surface evaporation & concentrated HCl(g) / HNO3(g) / NH3(g) outgassing
  let steamProducedMol = 0;
  let ethanolProducedMol = 0;
  let hclProducedMol = 0;
  let hno3ProducedMol = 0;
  let nh3ProducedMol = 0;
  let br2ProducedMol = 0;
  let i2ProducedMol = 0;
  let evapCoolingJ = 0;
  const nWater = vessel.moles.H2O_l || 0;
  const nEthanol = vessel.moles.C2H5OH_l || 0;
  const nAmmonia = vessel.moles.NH3_aq || 0;
  const nPureHNO3 = vessel.moles.HNO3_l || 0;
  const nBr2Liq = vessel.moles.Br2_l || 0;
  const nI2Solid = vessel.moles.I2_s || 0;

  const hasOpenTube = !!(vessel.connectedTargetId || vessel.connectedSyringeId);
  const effectivePressureBar =
    vessel.isStoppered && !hasOpenTube
      ? Math.max(env.pressureBar, vessel.internalPressureBar || env.pressureBar)
      : env.pressureBar;

  const boilingPointK = solutionBoilingPointK(vessel.moles, effectivePressureBar);

  // Regime 1: Universal sub-boiling evaporation (Clausius-Clapeyron + Margules activity + Stefan-Maxwell + Gilliland)
  // Open vessels evaporate gently at any T; tube-connected vessels vent expanding warm vapor once T >= 80 C
  // (or T >= 40 C when volatile Ethanol is present), while fuming HCl/NH3 outgas continuously through open tubes.
  const canSubBoilVent = !vessel.isStoppered || (hasOpenTube && vessel.tempK >= 351.0);
  const canEtOHVent = !vessel.isStoppered || (hasOpenTube && nEthanol > 1e-7 && vessel.tempK >= 313.15);
  const canVentFumingHCl = !vessel.isStoppered || hasOpenTube;
  const strat = computePhaseStratification(vessel.moles, vessel.tempK, spec, computeSolidVolumeMl(vessel.moles));
  const effTopAreaCm2 = strat.topAreaCm2 * (vessel.isStoppered && hasOpenTube ? 0.55 : 1.0);
  const aqCapFactor = strat.hasLightCover ? 0.06 : 1.0;

  if ((nWater > 1e-7 || nEthanol > 1e-7 || nAmmonia > 1e-8 || nPureHNO3 > 1e-7 || nBr2Liq > 1e-8 || nI2Solid > 1e-8 || strat.lightOrganicMl > 0.05) && (canSubBoilVent || canEtOHVent || canVentFumingHCl) && vessel.tempK < boilingPointK) {
    const vle = computeEthanolWaterVLE(vessel.moles, vessel.tempK, false);
    const volMl = strat.totalLiqMl + computeSolidVolumeMl(vessel.moles);
    const areaCm2 = effTopAreaCm2;
    const effAreaCm2 = areaCm2 * aqCapFactor;
    const isStirred = (vessel.stirTimer || 0) > 0;

    // 1a) Water sub-boiling evaporation (scaled by light organic cover if stratified)
    const pAmbH2OPa = CONSTANTS.RELATIVE_HUMIDITY * waterVaporPressureBar(env.tempK) * 100000;
    const evapH2OMolS =
      nWater > 1e-7 && (canSubBoilVent || canEtOHVent) && !vessel.isFrozenSolid
        ? calcEvaporationRateMol(SPECIES.H2O_l, vle.xW0 * vle.fIon, vessel.tempK, effAreaCm2, pAmbH2OPa, isStirred, vle.gammaW)
        : 0;
    const subBoilEvap = Math.min(nWater, evapH2OMolS * dt);

    // 1b) Volatile ethanol evaporation (Margules positive azeotrope gamma_E boosts trace & blend volatility)
    const evapEtOHMolS =
      nEthanol > 1e-7 && (canSubBoilVent || canEtOHVent)
        ? calcEvaporationRateMol(SPECIES.C2H5OH_l, vle.xE0 * vle.fIon, vessel.tempK, effAreaCm2, 0, isStirred, vle.gammaE)
        : 0;
    const subBoilEtOH = Math.min(nEthanol, evapEtOHMolS * dt);

    // 1c) Exposed top immiscible organic liquid evaporation (for beta_v3 solvents: Hexane/Ether/etc.)
    if (!vessel.isStoppered && strat.topLayerKey === 'organic_light') {
      for (const [id, nOrg] of Object.entries(vessel.moles)) {
        const sp = SPECIES[id];
        if (!sp || sp.phase !== 'l' || sp.liquidGroup !== 'organic_light' || !sp.boilTempK || !sp.dHVapJ || nOrg <= 1e-9) continue;
        const evOrgRate = calcEvaporationRateMol(sp, 1.0, vessel.tempK, areaCm2, 0, isStirred, 1.0);
        const dEvOrg = Math.min(nOrg, evOrgRate * dt);
        if (dEvOrg > 1e-12) {
          vessel.moles[id] = nOrg - dEvOrg;
          if (vessel.moles[id] < 1e-12) delete vessel.moles[id];
          evapCoolingJ -= dEvOrg * sp.dHVapJ;
          const vapId = sp.vaporSpeciesId;
          if (vapId) {
            vessel.escapedGasMoles[vapId] = (vessel.escapedGasMoles[vapId] || 0) + dEvOrg;
          }
        }
      }
    }

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

    const nNO3 = vessel.moles.NO3_aq || 0;
    const nHNO3Aq = Math.min(nH, nNO3);
    const rVapHNO3 = computeHNO3VaporRatio(nHNO3Aq, nWater);
    let subBoilHNO3 = 0;
    if (!vessel.isFrozenSolid && nWater > 1e-7 && nHNO3Aq > 1e-12) {
      const mHNO3 = nHNO3Aq * CONSTANTS.M_HNO3;
      const mH2O = nWater * CONSTANTS.M_H2O;
      const wHNO3 = mHNO3 / Math.max(1e-9, mHNO3 + mH2O);
      // Concentrated HNO3 (>= 48% w/w, esp. 68% fuming in humid air) emits HNO3(g) acid mist
      const fumeExcessHNO3 = Math.max(0, wHNO3 - 0.48);
      const fumeMolHNO3 =
        fumeExcessHNO3 > 0
          ? 0.00018 * (fumeExcessHNO3 / 0.20) * Math.exp(0.036 * (vessel.tempK - CONSTANTS.T_STD_K)) * dt
          : 0;
      subBoilHNO3 = Math.min(nHNO3Aq, subBoilEvap * rVapHNO3 + fumeMolHNO3);
      if (subBoilEvap >= nWater * 0.9999) {
        subBoilHNO3 = nHNO3Aq;
      }
    }

    // Pure anhydrous HNO3(l) fuming & surface evaporation (m.p. -42 °C, b.p. 83 °C)
    let subBoilPureHNO3 = 0;
    if (nPureHNO3 > 1e-7 && vessel.tempK >= CONSTANTS.T_FREEZE_PURE_HNO3_K && (canSubBoilVent || canVentFumingHCl)) {
      const evapPureMolS = calcEvaporationRateMol(
        SPECIES.HNO3_l || { molarMass: CONSTANTS.M_HNO3, boilTempK: CONSTANTS.T_BOIL_PURE_HNO3_K, dHVapJ: CONSTANTS.DELTA_H_VAP_HNO3_J },
        1.0,
        vessel.tempK,
        effAreaCm2,
        0,
        isStirred,
        1.0
      );
      subBoilPureHNO3 = Math.min(nPureHNO3, Math.max(evapPureMolS, 1.4e-4 * Math.exp(0.03 * (vessel.tempK - CONSTANTS.T_STD_K))) * dt);
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
    if (subBoilHNO3 > 1e-12) {
      vessel.moles.H_aq = Math.max(0, (vessel.moles.H_aq || 0) - subBoilHNO3);
      vessel.moles.NO3_aq = Math.max(0, (vessel.moles.NO3_aq || 0) - subBoilHNO3);
      if (vessel.moles.H_aq < 1e-13) delete vessel.moles.H_aq;
      if (vessel.moles.NO3_aq < 1e-13) delete vessel.moles.NO3_aq;
      hno3ProducedMol += subBoilHNO3;
      evapCoolingJ -= subBoilHNO3 * CONSTANTS.DELTA_H_VAP_HNO3_AQ_J;
    }
    if (subBoilPureHNO3 > 1e-12) {
      vessel.moles.HNO3_l = Math.max(0, nPureHNO3 - subBoilPureHNO3);
      if (vessel.moles.HNO3_l < 1e-13) delete vessel.moles.HNO3_l;
      hno3ProducedMol += subBoilPureHNO3;
      evapCoolingJ -= subBoilPureHNO3 * CONSTANTS.DELTA_H_VAP_HNO3_J;
    }

    // 1d) Group 4 volatile reactant outgassing: NH3(aq) -> NH3(g)
    // Henry's Law constant increases sharply above ~50 °C (dH_sol ~ -34 kJ/mol), enabling thermal Phenolphthalein fading
    if (!vessel.isFrozenSolid && nWater > 1e-7 && nAmmonia > 1e-12) {
      const liqVolL = Math.max(1e-5, volMl / 1000);
      const cNH3 = nAmmonia / liqVolL;
      const roomLossMolS =
        2.4e-5 *
        (effAreaCm2 / 4.0) *
        Math.pow(cNH3 / 10.0, 1.25) *
        Math.exp(0.052 * Math.max(-20, Math.min(25, vessel.tempK - CONSTANTS.T_STD_K))) *
        (isStirred ? 1.75 : 1.0);
      const excessHotK = Math.max(0, vessel.tempK - 323.15);
      const thermalStripRateS =
        excessHotK > 0
          ? 0.055 *
            (effAreaCm2 / 8.0) *
            Math.exp(0.068 * Math.min(55, excessHotK)) *
            (isStirred ? 1.85 : 1.0)
          : 0;
      const outgasNH3MolS = roomLossMolS + nAmmonia * thermalStripRateS;
      let subBoilNH3 = Math.min(
        nAmmonia,
        outgasNH3MolS * dt + subBoilEvap * (nAmmonia / Math.max(1e-6, nWater)) * 3.5
      );
      if (subBoilEvap >= nWater * 0.9999) {
        subBoilNH3 = nAmmonia;
      }
      if (subBoilNH3 > 1e-13) {
        vessel.moles.NH3_aq = Math.max(0, nAmmonia - subBoilNH3);
        if (vessel.moles.NH3_aq < 1e-14) delete vessel.moles.NH3_aq;
        nh3ProducedMol += subBoilNH3;
        evapCoolingJ -= subBoilNH3 * 23350;
      }
    }

    // 1e) Volatile Bromine (Br2_l, vp 23.3 kPa @ 20 C, bp 58.8 C) & sub-boiling Br2(aq) fuming
    if (nBr2Liq > 1e-9 && vessel.tempK >= 265.95 && (!vessel.isStoppered || hasOpenTube)) {
      const brSp = SPECIES.Br2_l;
      const evapBr2MolS = calcEvaporationRateMol(brSp, 1.0, vessel.tempK, areaCm2, 0, isStirred, 1.0);
      const coverScale = nWater > 1e-4 && strat.topLayerKey !== 'organic_heavy' ? 0.16 : 1.0;
      const roomFumeFloor = 4.2e-5 * Math.exp(0.055 * Math.min(45, vessel.tempK - 293.15));
      const subBoilBr2 = Math.min(nBr2Liq, Math.max(evapBr2MolS, roomFumeFloor) * coverScale * dt);
      if (subBoilBr2 > 1e-12) {
        vessel.moles.Br2_l = Math.max(0, nBr2Liq - subBoilBr2);
        if (vessel.moles.Br2_l < 1e-13) delete vessel.moles.Br2_l;
        br2ProducedMol += subBoilBr2;
        evapCoolingJ -= subBoilBr2 * brSp.dHVapJ;
      }
    }
    const nBr2Aq = vessel.moles.Br2_aq || 0;
    if (!vessel.isFrozenSolid && nBr2Aq > 1e-7 && nWater > 1e-4 && vessel.tempK >= 285.15 && (!vessel.isStoppered || hasOpenTube)) {
      const rateAqBr2 = nBr2Aq * 0.008 * Math.exp(0.048 * Math.min(55, vessel.tempK - 293.15));
      const dBr2Aq = Math.min(nBr2Aq, rateAqBr2 * dt);
      if (dBr2Aq > 1e-12) {
        vessel.moles.Br2_aq = Math.max(0, nBr2Aq - dBr2Aq);
        if (vessel.moles.Br2_aq < 1e-13) delete vessel.moles.Br2_aq;
        br2ProducedMol += dBr2Aq;
        evapCoolingJ -= dBr2Aq * 31000;
      }
    }

    // 1f) Iodine direct sublimation I2(s) -> I2(g) (trace @ 20 C, brisk 50–114 C below mp 113.7 C)
    if (nI2Solid > 1e-9 && vessel.tempK >= 290.15 && (!vessel.isStoppered || hasOpenTube) && (nWater < 0.06 || vessel.tempK >= 338.15)) {
      const pSubBar = 0.00041 * Math.exp((62400 / CONSTANTS.R_J_MOL_K) * (1 / 298.15 - 1 / Math.min(480, vessel.tempK)));
      const thermalDrive = vessel.tempK >= 323.15 ? 1.0 : 0.14;
      const evapI2MolS = (effAreaCm2 / 12.0) * 0.028 * pSubBar * thermalDrive * (isStirred ? 1.35 : 1.0);
      const sublI2 = Math.min(nI2Solid, evapI2MolS * dt);
      if (sublI2 > 1e-12) {
        vessel.moles.I2_s = Math.max(0, nI2Solid - sublI2);
        if (vessel.moles.I2_s < 1e-13) delete vessel.moles.I2_s;
        i2ProducedMol += sublI2;
        evapCoolingJ -= sublI2 * 62400;
      }
    }
  }

  // Update temperature with strict finite clamping across deep-cryo (155 K) to Bunsen peak (1950 K)
  // Localized flame-cone heating of dry/empty vessels concentrates energy into the lower heated wall zone
  const isDryFocusedBunsen =
    flameTempOverrideK &&
    flameTempOverrideK >= 850 &&
    effectiveBurnerW > 200 &&
    (vessel.moles.H2O_l || 0) + (vessel.moles.C2H5OH_l || 0) + (vessel.moles.HNO3_l || 0) + (vessel.moles.H2SO4_l || 0) < 0.004;
  const effHeatCapJK = isDryFocusedBunsen ? Math.max(16.0, cTotal * 0.28) : cTotal;
  const rawHeatJ = reactionHeatJ + effectiveBurnerW * dt + ambientExchangeJ + evapCoolingJ;
  const netHeatJ = Number.isFinite(rawHeatJ) ? rawHeatJ : 0;
  let newTempK = tCurClamped + netHeatJ / effHeatCapJK;
  if (!Number.isFinite(newTempK)) newTempK = tCurClamped;
  newTempK = Math.max(155, Math.min(1950, newTempK));

  // Regime 2: Co-distillation boiling clamp for Water + Ethanol + Nitric acid (pure HNO3 at 83 C) + Bromine (58.8 C!)
  let isBoiling = false;
  const remainingWater = vessel.moles.H2O_l || 0;
  const remainingEtOH = vessel.moles.C2H5OH_l || 0;
  const remainingPureHNO3 = vessel.moles.HNO3_l || 0;
  const remainingBr2 = vessel.moles.Br2_l || 0;
  const pureBr2BpK = 1 / (1 / 331.95 - (CONSTANTS.R_J_MOL_K / 29960) * Math.log(Math.max(0.05, effectivePressureBar) / CONSTANTS.P_STD_BAR));
  if (remainingBr2 > 1e-7 && newTempK >= pureBr2BpK && remainingWater > 1e-7) {
    // Immiscible heavy Br2 boils vigorously around 58.8 C under aqueous layer first
    const excessBr2J = (newTempK - pureBr2BpK) * cTotal;
    const boilBr2 = Math.min(remainingBr2, excessBr2J / 29960);
    if (boilBr2 > 1e-12) {
      vessel.moles.Br2_l = Math.max(0, remainingBr2 - boilBr2);
      if (vessel.moles.Br2_l < 1e-13) delete vessel.moles.Br2_l;
      br2ProducedMol += boilBr2;
      newTempK = Math.max(pureBr2BpK, newTempK - (boilBr2 * 29960) / cTotal);
      isBoiling = true;
    }
  }
  const remBr2After = vessel.moles.Br2_l || 0;
  if (remainingWater <= 1e-7 && remainingEtOH <= 1e-7 && remainingPureHNO3 <= 1e-7 && remBr2After > 1e-7 && newTempK >= boilingPointK) {
    isBoiling = true;
    const excessJ = (newTempK - boilingPointK) * cTotal;
    const boilBr2 = Math.min(remBr2After, excessJ / 29960);
    if (boilBr2 > 1e-12) {
      vessel.moles.Br2_l = Math.max(0, remBr2After - boilBr2);
      if (vessel.moles.Br2_l < 1e-13) delete vessel.moles.Br2_l;
      br2ProducedMol += boilBr2;
    }
    const leftoverJ = Math.max(0, excessJ - boilBr2 * 29960);
    newTempK = boilingPointK + leftoverJ / cTotal;
  } else if (remainingWater <= 1e-7 && remainingEtOH <= 1e-7 && remainingPureHNO3 > 1e-7 && newTempK >= boilingPointK) {
    isBoiling = true;
    const excessJ = (newTempK - boilingPointK) * cTotal;
    const boilPureHNO3 = Math.min(remainingPureHNO3, excessJ / CONSTANTS.DELTA_H_VAP_HNO3_J);
    if (boilPureHNO3 > 1e-12) {
      vessel.moles.HNO3_l = Math.max(0, remainingPureHNO3 - boilPureHNO3);
      if (vessel.moles.HNO3_l < 1e-13) delete vessel.moles.HNO3_l;
      hno3ProducedMol += boilPureHNO3;
    }
    const leftoverJ = Math.max(0, excessJ - boilPureHNO3 * CONSTANTS.DELTA_H_VAP_HNO3_J);
    newTempK = boilingPointK + leftoverJ / cTotal;
  } else if ((remainingWater > 1e-7 || remainingEtOH > 1e-7) && newTempK >= boilingPointK) {
    isBoiling = true;
    const excessJ = (newTempK - boilingPointK) * cTotal;
    const nH = vessel.moles.H_aq || 0;
    const nCl = vessel.moles.Cl_aq || 0;
    const nHCl = Math.min(nH, nCl);
    const nHNO3Aq = Math.min(nH, vessel.moles.NO3_aq || 0);
    const rVap = computeHClVaporRatio(nHCl, remainingWater);
    const rVapHNO3 = computeHNO3VaporRatio(nHNO3Aq, remainingWater);
    const vleBoil = computeEthanolWaterVLE(vessel.moles, boilingPointK, true);
    const yE = remainingEtOH > 1e-7 ? (remainingWater > 1e-7 ? vleBoil.yE : 1.0) : 0;
    const yW = 1 - yE;

    const effWaterHeat =
      CONSTANTS.DELTA_H_VAP_WATER_J +
      rVap * CONSTANTS.DELTA_H_VAP_HCL_AQ_J +
      rVapHNO3 * CONSTANTS.DELTA_H_VAP_HNO3_AQ_J;
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
    const boilHNO3 =
      nHNO3Aq > 1e-12
        ? remainingWater - boilMol <= 1e-7
          ? nHNO3Aq
          : Math.min(nHNO3Aq, boilMol * rVapHNO3)
        : 0;

    if (boilMol > 1e-12 || boilHCl > 1e-12 || boilHNO3 > 1e-12 || boilEtOH > 1e-12) {
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
      if (boilHNO3 > 1e-12) {
        vessel.moles.H_aq = Math.max(0, (vessel.moles.H_aq || 0) - boilHNO3);
        vessel.moles.NO3_aq = Math.max(0, (vessel.moles.NO3_aq || 0) - boilHNO3);
        if (vessel.moles.H_aq < 1e-13) delete vessel.moles.H_aq;
        if (vessel.moles.NO3_aq < 1e-13) delete vessel.moles.NO3_aq;
        hno3ProducedMol += boilHNO3;
      }
      const nNH3Now = vessel.moles.NH3_aq || 0;
      if (nNH3Now > 1e-14) {
        const boilNH3 =
          remainingWater - boilMol <= 1e-7
            ? nNH3Now
            : Math.min(
                nNH3Now,
                (nNH3Now / Math.max(1e-6, remainingWater)) * boilMol * 18.0 + nNH3Now * Math.min(0.85, 0.35 * dt)
              );
        if (boilNH3 > 1e-14) {
          vessel.moles.NH3_aq = Math.max(0, nNH3Now - boilNH3);
          if (vessel.moles.NH3_aq < 1e-14) delete vessel.moles.NH3_aq;
          nh3ProducedMol += boilNH3;
        }
      }

      const actualUsedJ =
        boilMol * CONSTANTS.DELTA_H_VAP_WATER_J +
        boilEtOH * SPECIES.C2H5OH_l.dHVapJ +
        boilHCl * CONSTANTS.DELTA_H_VAP_HCL_AQ_J +
        boilHNO3 * CONSTANTS.DELTA_H_VAP_HNO3_AQ_J;
      const leftoverJ = Math.max(0, excessJ - actualUsedJ);
      newTempK = boilingPointK + leftoverJ / cTotal;
    } else {
      newTempK = boilingPointK;
    }
  }

  // Sealed / dry high-temp I2(s) sublimation even when flask is warm/stoppered without bulk water
  const remI2Now = vessel.moles.I2_s || 0;
  if (remI2Now > 1e-9 && newTempK >= 323.15 && (vessel.moles.H2O_l || 0) < 0.06 && vessel.isStoppered && !hasOpenTube) {
    const hVolL = Math.max(0.01, (spec.maxVolumeMl || 250) * 0.0007);
    const pSubBar = 0.00041 * Math.exp((62400 / CONSTANTS.R_J_MOL_K) * (1 / 298.15 - 1 / Math.min(480, newTempK)));
    const nEqHead = (pSubBar * hVolL) / (CONSTANTS.R_L_BAR_MOL_K * newTempK);
    const curHeadI2 = vessel.headspaceGasMoles?.I2_g || 0;
    if (nEqHead > curHeadI2 + 1e-8) {
      const subSealed = Math.min(remI2Now, (nEqHead - curHeadI2) * Math.min(1, 1.5 * dt));
      if (subSealed > 1e-12) {
        vessel.moles.I2_s = Math.max(0, remI2Now - subSealed);
        if (vessel.moles.I2_s < 1e-13) delete vessel.moles.I2_s;
        i2ProducedMol += subSealed;
        newTempK = Math.max(250, newTempK - (subSealed * 62400) / cTotal);
      }
    }
  }

  // Regime 3: Freezing / melting solid-liquid phase clamp with cryoscopy & latent heat
  const phaseRes = updateFreezeMeltPhase(vessel, dt, newTempK, cTotal);
  newTempK = phaseRes.updatedTempK;

  vessel.tempK = newTempK;
  const hasAnyLiquid =
    (vessel.moles.H2O_l || 0) > 1e-7 ||
    (vessel.moles.C2H5OH_l || 0) > 1e-7 ||
    (vessel.moles.HNO3_l || 0) > 1e-7 ||
    (vessel.moles.H2SO4_l || 0) > 1e-7 ||
    (vessel.moles.Br2_l || 0) > 1e-7;
  const steamOpacity =
    hasAnyLiquid && !vessel.isFrozenSolid
      ? computeSteamOpacity(newTempK, env.tempK, CONSTANTS.RELATIVE_HUMIDITY)
      : 0;

  return {
    steamProducedMol,
    ethanolProducedMol,
    hclProducedMol,
    hno3ProducedMol,
    nh3ProducedMol,
    br2ProducedMol,
    i2ProducedMol,
    isBoiling,
    boilingPointK,
    steamOpacity,
    freezeMeltRateMolS: phaseRes.freezeMeltRateMolS,
    freezePointK: phaseRes.freezePointK,
  };
}
