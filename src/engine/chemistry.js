import { calcCaCO3EqPressureAtm, CONSTANTS } from '../data/constants.js';
import { APPARATUS } from '../data/apparatus.js';
import { createZeroGasMap, SPECIES } from '../data/species.js';
import { REACTIONS } from '../data/reactions.js';
import {
  computeAqueousVolumeL,
  computeLiquidVolumeL,
  computePH,
  computePhaseStratification,
  computeSolidVolumeMl,
} from './equilibrium.js';

/**
 * Arrhenius factor relative to 298.15 K: exp((-Ea / R) * (1/T - 1/298.15)).
 */
function arrheniusFactor(eaJ, tempK) {
  const T = Math.max(200, Math.min(2200, tempK));
  const expo = (-eaJ / CONSTANTS.R_J_MOL_K) * (1 / T - 1 / CONSTANTS.T_STD_K);
  return Math.exp(Math.max(-40, Math.min(25, expo)));
}

/**
 * Physical Sodium auto-ignition threshold (K) depending on particle dispersion & humidity:
 * - Fine dispersed dust/vapor: ~20-25 C (296 K)
 * - Small droplets/cut pieces in moist room air: ~115-125 C (393 K)
 * - Quiescent large pooled mass with surface oxide crust / dry air: ~200-320 C (515 K)
 */
export function getNaIgnitionTempK(vessel, env = null) {
  const pCnt = vessel?.particleCounts?.Na_s ?? 1;
  if (pCnt >= 120) return 296.15;
  const massG = (vessel?.moles?.Na_s || 0) * SPECIES.Na_s.molarMass;
  if (pCnt <= 1 && massG >= 1.5 && (vessel?.naTarnishFrac || 0) > 0.2) {
    return 523.15; // 250 C quiescent pooled Na with oxide crust
  }
  return env?.atmosphereMode === 'inert' ? 560.0 : 393.15; // 120 C in humid bench air
}

/**
 * Physical Potassium auto-ignition threshold (K): lower melting point (63.5 C) and faster oxidation than Na.
 */
export function getKIgnitionTempK(vessel, env = null) {
  const pCnt = vessel?.particleCounts?.K_s ?? 1;
  if (pCnt >= 120) return 290.15;
  const massG = (vessel?.moles?.K_s || 0) * SPECIES.K_s.molarMass;
  if (pCnt <= 1 && massG >= 2.0 && (vessel?.kTarnishFrac || 0) > 0.25) {
    return 433.15; // 160 C crusted bulk Potassium
  }
  return env?.atmosphereMode === 'inert' ? 520.0 : 345.0; // ~72 C in humid bench air
}

/**
 * Physical Zinc auto-ignition threshold (K) depending on particle dispersion & O2 environment:
 * - Pure / enriched O2 gas chamber: ~342 C (615 K)
 * - Fine Zinc powder in standard Air (1 atm): ~460-500 C (753 K)
 * - Bulk solid Zinc protected by ZnO layer in standard Air: requires bp ~907 C (1180 K)
 */
export function getZnIgnitionTempK(vessel, env = null, options = null) {
  const headO2 = vessel?.headspaceGasMoles?.O2_g || 0;
  if (headO2 > 1.2e-4) return 615.0;
  if (vessel?.kind === 'spoon' && options?.spoonInFlame) return 665.0;
  const pCnt = vessel?.particleCounts?.Zn_s ?? 6;
  const isPowder = Boolean(vessel?.groundPowderMap?.Zn_s) || pCnt >= 60;
  return isPowder ? 753.15 : 1180.15;
}

/**
 * Evaluate 4-point optimization rubric & CaO conversion score for limestone calcination.
 */
export function computeCaOOptimizationScore(vessel) {
  const stats = vessel?.calcinationStats;
  if (!stats && (vessel?.moles?.CaCO3_s || 0) <= 1e-8 && (vessel?.moles?.CaO_s || 0) <= 1e-8) {
    return null;
  }
  const nCaCO3 = vessel?.moles?.CaCO3_s || 0;
  const nCaO = vessel?.moles?.CaO_s || 0;
  const nTotCa = Math.max(1e-9, stats?.peakCaMol || nCaCO3 + nCaO);
  const yieldPct = Math.min(100, (nCaO / nTotCa) * 100);
  const groundFine = Boolean(
    stats?.groundFine || vessel?.groundPowderMap?.CaCO3_s || (vessel?.particleCounts?.CaCO3_s || 0) >= 60
  );
  const ventedWhileHeating = Boolean(stats?.ventedWhileHeating ?? vessel?.lidState !== 'closed');
  const roaringBlueZone = Boolean(stats?.roaringBlueZone);
  const cooledProtected = Boolean(
    stats?.cooledProtected ?? (vessel?.lidState === 'closed' || (vessel?.tempK || 298) >= 720)
  );
  const pts = [groundFine, ventedWhileHeating, roaringBlueZone, cooledProtected].filter(Boolean).length;
  return {
    yieldPct,
    points: pts,
    maxPoints: 4,
    groundFine,
    ventedWhileHeating,
    roaringBlueZone,
    cooledProtected,
  };
}

/**
 * Bulk aqueous ion/diffusion mobility factor [0..1].
 * Drops to 0 when water is completely frozen solid (or >=90% solid ice matrix),
 * locking bulk aqueous dissolution, ionic, neutralization & Zn/Cu redox reactions.
 */
function computeIceMobilityFactor(vessel) {
  if (vessel.isFrozenSolid) return 0;
  const nWater = vessel.moles.H2O_l || 0;
  const nIce = vessel.moles.H2O_s || 0;
  if (nIce <= 1e-7) return 1.0;
  if (nWater < 1e-4) return 0;
  const iceFrac = nIce / (nWater + nIce);
  if (iceFrac >= 0.90) return 0;
  return Math.pow(Math.max(0, 1 - iceFrac), 2.0);
}

/**
 * Compute effective kinetic rate constant coupling Arrhenius activation with
 * Nernst diffusion boundary-layer resistance (1/k_eff = 1/k_chem + 1/k_diff)
 * for heterogeneous solid-liquid reactions.
 */
export function getEffectiveRateConstant(rxn, tempK, isStirred = false, overrideKBase = null) {
  const kBase = overrideKBase ?? rxn.k298 ?? rxn.kRelax298 ?? 0;
  const kChem = kBase * arrheniusFactor(rxn.eaJ ?? 0, tempK);
  if (!rxn.isHeterogeneous) {
    return kChem;
  }
  const kDiffBase = isStirred ? (rxn.kDiffStir ?? 12.0) : (rxn.kDiffStill ?? 1.8);
  const kDiff = kDiffBase * arrheniusFactor(rxn.eaDiffJ ?? 15000, tempK);
  return (kChem * kDiff) / Math.max(1e-12, kChem + kDiff);
}

/**
 * Surface area (m^2) of a solid phase based on moles and particle count.
 */
export function computeSolidSurfaceAreaM2(speciesId, moles, particleCount = 4) {
  if (moles <= 1e-12) return 0;
  const sp = SPECIES[speciesId];
  if (!sp || !sp.density) return 0;
  const N = Math.max(1, particleCount);
  const totalVolM3 = (moles * sp.molarMass) / (sp.density * 1e6); // cm^3 -> m^3
  const volPerParticle = totalVolM3 / N;
  const radius = Math.cbrt((3 * volPerParticle) / (4 * Math.PI));
  return N * 4 * Math.PI * radius * radius;
}

/**
 * Compute exposed reactant moles in either condensed phase (vessel.moles) or gas headspace / room air.
 */
function getReactantAvailableMol(vessel, spId, env) {
  const sp = SPECIES[spId];
  if (!sp || sp.phase !== 'g') {
    return Math.max(0, vessel.moles?.[spId] || 0);
  }
  const headVal = Math.max(0, vessel.headspaceGasMoles?.[spId] || 0);
  const atmMode = env?.atmosphereMode || 'air';
  if (spId === 'N2_g') {
    if (atmMode === 'air' && !vessel.isStoppered && !vessel.isInverted && vessel.lidState !== 'closed') {
      const purgeFrac = vessel.airO2PurgeFrac ?? 1.0;
      return purgeFrac > 0.08 ? headVal + 20.0 : headVal;
    }
    return headVal;
  }
  if (spId === 'H2O_g') {
    return headVal + ((vessel.tempK || 298) > 373.65 ? (vessel.moles.H2O_l || 0) : 0);
  }
  if (spId !== 'O2_g') return headVal;

  if (atmMode === 'inert') return headVal;
  if (vessel.isStoppered || vessel.lidState === 'closed') {
    return headVal + Math.max(0, vessel.sealedAirO2Moles ?? 0);
  }
  if (vessel.isInverted && vessel.submergedInTroughId) {
    return headVal + Math.max(0, vessel.trappedAirO2Moles ?? 0);
  }
  // Open bench vessel in Standard Air: freely replenished room O2 if not flushed away by gas stream
  const purgeFrac = vessel.airO2PurgeFrac ?? 1.0;
  return purgeFrac > 0.08 ? headVal + 10.0 : headVal;
}

/**
 * Effective O2 partial pressure (bar) inside a vessel combining pure O2 headspace + ambient air.
 */
export function getVesselEffectiveO2Bar(vessel, env) {
  const headO2 = Math.max(0, vessel.headspaceGasMoles?.O2_g || 0);
  let pO2 = 0;
  if (headO2 > 1e-8) {
    // Approximate O2 partial contribution from headspace accumulation inside standard flask (~0.02..0.25 L)
    pO2 += Math.min(2.2, headO2 * 180.0);
  }
  if ((env?.atmosphereMode || 'air') === 'air') {
    const pEnv = env?.pressureBar || CONSTANTS.P_STD_BAR;
    const purgeFrac = vessel.airO2PurgeFrac ?? 1.0;
    const isClosedLid = vessel.lidState === 'closed';
    if (!vessel.isStoppered && !vessel.isInverted && !isClosedLid) {
      pO2 += CONSTANTS.AIR_O2_FRAC * pEnv * purgeFrac;
    } else if ((vessel.sealedAirO2Moles || 0) > 1e-7) {
      pO2 += CONSTANTS.AIR_O2_FRAC * pEnv * Math.min(1, (vessel.sealedAirO2Moles || 0) / 0.0015);
    }
  }
  return Math.max(0, Math.min(3.0, pO2));
}

/**
 * Compute raw reaction velocity v_r (mol of reaction extent / s) at current state.
 */
function computeReactionRate(rxn, vessel, liquidVolL, options = {}) {
  const moles = vessel.moles;
  const T = vessel.tempK;
  const stirBoost = vessel.stirTimer > 0 ? 3.2 : 1.0;
  const env = options.environment;

  // Check reactant availability across condensed + gas reservoirs
  for (const spId of Object.keys(rxn.reactants)) {
    if (getReactantAvailableMol(vessel, spId, env) <= 1e-12) return 0;
  }

  // Ensure aqueous environment exists for non-dry reactions
  const hasWater = (moles.H2O_l || 0) > 1e-7 && liquidVolL > 1e-6;
  const iceMob = computeIceMobilityFactor(vessel);

  if (rxn.type === 'dissolution') {
    if (!hasWater || iceMob <= 0) return 0;
    if (computeSulfuricAcidState(moles).w >= 0.75) return 0;
    const nSolid = moles[rxn.solidId] || 0;
    const waterMassKg = (moles.H2O_l * SPECIES.H2O_l.molarMass) / 1000;
    const etohMassKg = ((moles.C2H5OH_l || 0) * SPECIES.C2H5OH_l.molarMass) / 1000;
    const effectiveSolventKg = waterMassKg + (rxn.etohRelSolubility || 0) * etohMassKg;
    let saltingMult = 1.0;
    let gardenSlow = 1.0;
    if (rxn.solidId === 'CuSO4_5H2O_s' || rxn.solidId === 'CuSO4_s') {
      if (computeSulfuricAcidState(moles).w >= 0.72) return 0;
      const totalSolvKg = waterMassKg + etohMassKg;
      const etohWtFrac = totalSolvKg > 1e-9 ? etohMassKg / totalSolvKg : 0;
      if (etohWtFrac > 0.05) {
        saltingMult = Math.exp(-4.8 * etohWtFrac);
      }
      if (vessel.gardenActive && !vessel.stirTimer) {
        gardenSlow = 0.08;
      }
    } else if (rxn.solidId === 'NaOH_s' && vessel.gardenActive && !vessel.stirTimer) {
      gardenSlow = 0.15;
    }
    const sol298 = rxn.solubilityMolPerKg298 ?? rxn.solubilityLimitMolKg ?? 3.0;
    const solCoeff = rxn.solubilityTempCoeff ?? 0.01;
    const sTemp =
      sol298 *
      saltingMult *
      Math.exp(solCoeff * (T - CONSTANTS.T_STD_K));
    const maxSoluble = sTemp * effectiveSolventKg;
    const currentIon = moles[rxn.ionCheckId] || 0;
    if (rxn.solidId === 'NaHCO3_s') {
      const mNa = (moles.Na_aq || 0) / Math.max(1e-8, effectiveSolventKg);
      const mHco3 = (moles.HCO3_aq || 0) / Math.max(1e-8, effectiveSolventKg);
      const kspNaHCO3 = sTemp * sTemp;
      if (mNa * mHco3 >= kspNaHCO3 * 0.998 || currentIon >= maxSoluble * 0.999) return 0;
    } else if (currentIon >= maxSoluble * 0.999) {
      return 0;
    }

    const undersaturation =
      rxn.solidId === 'NaHCO3_s'
        ? Math.max(
            0,
            Math.min(
              1 - currentIon / Math.max(1e-12, maxSoluble),
              1 - ((moles.Na_aq || 0) * (moles.HCO3_aq || 0)) / Math.max(1e-12, Math.pow(Math.max(1e-8, effectiveSolventKg) * sTemp, 2))
            )
          )
        : Math.max(0, 1 - currentIon / Math.max(1e-12, maxSoluble));
    const pCount = vessel.particleCounts?.[rxn.solidId] ?? 12;
    const area = computeSolidSurfaceAreaM2(rxn.solidId, nSolid, pCount);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T);
    return k * area * undersaturation * stirBoost * gardenSlow * iceMob * 80;
  }

  if (rxn.type === 'ionic_fast') {
    if (!hasWater || iceMob <= 0) return 0;
    if (rxn.id === 'dissolve_cuso4_2hcl' && liquidVolL < 0.0004) return 0;
    const ohConc = (moles.OH_aq || 0) / liquidVolL;
    if (rxn.maxOhConc !== undefined) {
      if (ohConc > rxn.maxOhConc) return 0;
    }
    // Strict Ksp fractional precipitation competition: Ksp(Cu(OH)2)=2.2e-20 << Ksp(Zn(OH)2)=3.0e-17
    if (rxn.id === 'precipitate_cuoh2' || rxn.id === 'precipitate_znoh2') {
      const cH = (moles.H_aq || 0) / liquidVolL;
      const cCu = (moles.Cu2_aq || 0) / liquidVolL;
      const phEq = options.phNow ?? 7.0;
      if (cH > 0.015 && (moles.OH_aq || 0) < (moles.H_aq || 0) * 0.98) return 0;
      if (rxn.id === 'precipitate_cuoh2') {
        if (phEq < 4.2 && ohConc < 5e-5) return 0;
      } else {
        if (cCu > 1.5e-4 && (moles.OH_aq || 0) < 2.1 * (moles.Cu2_aq || 0)) return 0;
        if (phEq < 6.05 && ohConc < 2e-4) return 0;
      }
    }
    // Limiting reactant extent in moles
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    if (minExtent <= 1e-12 || !Number.isFinite(minExtent)) return 0;

    // Homogeneous ionic reactions are activation/collision controlled -> unaffected by stirring
    const kRelax = getEffectiveRateConstant(rxn, T, false);
    return minExtent * kRelax * iceMob;
  }

  if (rxn.type === 'amphoteric_base' || rxn.type === 'amphoteric_oxide_base') {
    if (!hasWater || iceMob <= 0) return 0;
    const ohConc = (moles.OH_aq || 0) / liquidVolL;
    if (ohConc < rxn.minOhConc) return 0;
    const solidId = rxn.solidId || 'ZnOH2_s';
    const nSolid = moles[solidId] || 0;
    const excessFactor = Math.min(4.0, (ohConc - rxn.minOhConc) * 1.6);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T) * stirBoost;
    return Math.min(nSolid, (moles.OH_aq || 0) / 2) * k * excessFactor * iceMob;
  }

  if (rxn.type === 'acid_dissolve_precipitate') {
    if (!hasWater || iceMob <= 0) return 0;
    const hConc = (moles.H_aq || 0) / liquidVolL;
    if (hConc < 1e-5) return 0;
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T) * stirBoost;
    return minExtent * k * Math.min(2.5, 0.35 + hConc) * iceMob;
  }

  if (rxn.type === 'heterogeneous_ice') {
    const solidId = rxn.solidId || 'Na_s';
    const nMet = moles[solidId] || 0;
    const nIce = moles.H2O_s || 0;
    if (nMet <= 1e-12 || nIce <= 1e-6) return 0;
    const tMet = solidId === 'K_s' ? (vessel.kTempK ?? T) : (vessel.naTempK ?? T);
    const pCount = vessel.particleCounts?.[solidId] ?? 1;
    const area = computeSolidSurfaceAreaM2(solidId, nMet, pCount);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, tMet);
    return k * area;
  }

  if (rxn.type === 'heterogeneous_metal') {
    if (!hasWater) return 0;
    const nSolid = moles[rxn.solidId] || 0;
    const pCount = vessel.particleCounts?.[rxn.solidId] ?? (rxn.solidId === 'Na_s' ? 1 : 6);
    const area = computeSolidSurfaceAreaM2(rxn.solidId, nSolid, pCount);

    if (rxn.solidId === 'Na_s') {
      if (rxn.aqueousId === 'H_aq' && hasNitrateOxidizingEnv(moles, liquidVolL)) return 0;
      if (hasNitrateOxidizingEnv(moles, liquidVolL) && (moles.H_aq || 0) > 1e-3) return 0;
      const tNa = vessel.naTempK ?? T;
      const spec = APPARATUS[vessel.typeId];
      const totMl = liquidVolL * 1000 + computeSolidVolumeMl(moles);
      const areaSurfCm2 = spec?.geometry
        ? Math.max(0.5, spec.geometry.getLiquidState(totMl).surfaceAreaCm2)
        : spec?.surfaceAreaCm2 || 25.0;
      const nW = moles.H2O_l || 0;
      const nE = moles.C2H5OH_l || 0;
      const xEtOH = nE / Math.max(1e-9, nW + nE);
      // Ethanol strongly moderates Sodium reactivity compared to pure water
      const etohTame = xEtOH > 0.12 ? Math.max(0.16, 1 - 1.15 * xEtOH) : 1.0;
      const isMolten = tNa >= (SPECIES.Na_s.meltTempK || 370.95) && xEtOH < 0.35;
      const wallPinned = areaSurfCm2 < 15.0;
      const gammaCoulomb = isMolten ? (wallPinned ? 3.2 : 1.25) : 1.0;
      const k = rxn.k298 * arrheniusFactor(rxn.eaJ, tNa) * gammaCoulomb * etohTame;

      if (rxn.useWaterContact) {
        const strat = options.strat;
        if (strat && strat.lightOrganicMl > 0.2 && strat.aqueousMl <= 0.05) {
          // Pure light nonpolar oil/alkane completely shields submerged Na from moisture!
          return 0;
        }
        const oilCoverDamp = strat?.hasLightCover ? 0.26 : 1.0;
        const waterFrac = Math.min(1.0, (moles.H2O_l || 0) / 0.1);
        return k * area * waterFrac * oilCoverDamp;
      }
      if (iceMob <= 0) return 0;
      const aqConc = (moles[rxn.aqueousId] || 0) / liquidVolL;
      if (rxn.minAqConc && aqConc < rxn.minAqConc) return 0;
      const concFactor = Math.pow(Math.min(14.0, aqConc), 1.05);
      return k * area * concFactor * (vessel.stirTimer > 0 ? 2.4 : 1.0) * iceMob * 3.5;
    }

    if (iceMob <= 0) return 0;
    if (rxn.aqueousId === 'H_aq' && hasNitrateOxidizingEnv(moles, liquidVolL)) return 0;
    const k = getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0);
    const aqConc = (moles[rxn.aqueousId] || 0) / liquidVolL;
    if (rxn.minAqConc && aqConc < rxn.minAqConc) return 0;

    // Effective kinetic order with mild saturation at very high acid molarity
    const concFactor = Math.pow(Math.min(14.0, aqConc), 1.05);
    // Phenomenon #10: Galvanic micro-cells (Cu trace deposited on Zn lowers H2 overpotential eta -> sharp acceleration)
    let microCellBoost = 1.0;
    if (rxn.id === 'zn_acid' && (moles.Cu_s || 0) > 1e-7 && (moles.Zn_s || 0) > 1e-7) {
      const cuRatio = (moles.Cu_s || 0) / Math.max(1e-5, moles.Zn_s);
      microCellBoost = 1.0 + Math.min(4.8, 3.6 * Math.sqrt(cuRatio * 20));
    }
    let passFactor = 1.0;
    if (rxn.id === 'zn_acid' || rxn.id === 'zn_base') {
      const passiv = vessel.znPassivationFrac || 0;
      passFactor = Math.max(0.002, 1.0 - 0.998 * passiv);
      if (rxn.id === 'zn_base') {
        // Passive Zn(OH)2 layer resists weak alkali until pH > ~12.4 ([OH-] >= 0.025 M -> zincate [Zn(OH)4]2-)
        passFactor *= aqConc < 0.02 ? 0.02 : Math.min(1.0, (aqConc - 0.015) / 0.08);
      }
    }
    // Series diffusion ceiling (via getEffectiveRateConstant) handles still vs stirred boundary layer
    return k * area * concFactor * microCellBoost * passFactor * (rxn.isHeterogeneous ? 1.0 : (vessel.stirTimer > 0 ? 2.6 : 1.0)) * iceMob * 3.5;
  }

  if (rxn.type === 'thermal_decomposition') {
    if (rxn.requiresDry && ((hasWater && (moles.H2O_l || 0) > 1e-4) || (moles.H2O_s || 0) > 1e-4)) return 0;
    const pEffBar = Math.min(vessel.internalPressureBar ?? CONSTANTS.P_STD_BAR, env?.pressureBar ?? CONSTANTS.P_STD_BAR);
    const isVacuum = pEffBar <= 0.25;
    if (rxn.requiresVacuum && !isVacuum) return 0;
    const baseMinK = rxn.id === 'na2o_inert_disprop' && isVacuum ? 973.15 : rxn.minTempK;
    const effMinTempK = Math.max(250, baseMinK - (isVacuum ? (rxn.vacuumTempShiftK || 0) : 0));
    if (T < effMinTempK) return 0;
    if (rxn.maxTempK && T >= rxn.maxTempK) return 0;
    if (rxn.requiresInertOrVacuum && env?.atmosphereMode !== 'inert' && !isVacuum && getVesselEffectiveO2Bar(vessel, env) > 0.03) return 0;
    if (rxn.id === 'na2o_inert_disprop' && env?.atmosphereMode !== 'inert' && !isVacuum) return 0;
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    const vacMult = isVacuum && rxn.vacuumRateMult ? rxn.vacuumRateMult : 1.0;
    const k = rxn.kAtThreshold * vacMult * arrheniusFactor(rxn.eaJ, T - effMinTempK + CONSTANTS.T_STD_K);
    return minExtent * k;
  }

  if (rxn.type === 'solid_state') {
    if ((moles.H2O_l || 0) >= 0.01 || (moles.H2O_s || 0) >= 0.01 || (moles.C2H5OH_l || 0) >= 0.01) return 0;
    const nNa = moles.Na_s || 0;
    const area = computeSolidSurfaceAreaM2('Na_s', nNa, vessel.particleCounts?.Na_s ?? 1);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T);
    const naohMol = moles.NaOH_s || 0;
    return k * Math.max(1e-5, area) * Math.min(3.5, 0.4 + naohMol * 18) * stirBoost * 4.5;
  }

  if (rxn.type === 'heterogeneous_rapid') {
    if (!hasWater || iceMob <= 0) return 0;
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    return minExtent * rxn.kRelax298 * arrheniusFactor(rxn.eaJ, T) * iceMob;
  }

  if (rxn.type === 'lucas_sn2') {
    if (!hasWater || iceMob <= 0 || T < rxn.minTempK) return 0;
    const cZn = (moles.Zn2_aq || 0) / liquidVolL;
    const cCl = (moles.Cl_aq || 0) / liquidVolL;
    const cH = (moles.H_aq || 0) / liquidVolL;
    if (cZn < rxn.minZnConc || cCl < rxn.minClConc || cH < rxn.minHConc) return 0;
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T);
    const catBoost = Math.min(3.5, cZn / rxn.minZnConc) * Math.min(2.5, cCl / rxn.minClConc);
    return (moles.C2H5OH_l || 0) * k * catBoost * iceMob;
  }

  if (rxn.type === 'na_alcohol') {
    if (liquidVolL <= 1e-6 || (moles.C2H5OH_l || 0) <= 1e-6) return 0;
    const solidId = rxn.solidId || 'Na_s';
    const nAlcMet = moles[solidId] || 0;
    const pCount = vessel.particleCounts?.[solidId] ?? 1;
    const area = computeSolidSurfaceAreaM2(solidId, nAlcMet, pCount);
    const nW = moles.H2O_l || 0;
    const nE = moles.C2H5OH_l || 0;
    const xEtOH = nE / Math.max(1e-9, nW + nE);
    const tAlc = solidId === 'K_s' ? (vessel.kTempK ?? T) : (vessel.naTempK ?? T);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, tAlc);
    return k * area * (0.6 + 2.6 * xEtOH);
  }

  if (rxn.type === 'alkali_water') {
    if (!hasWater || iceMob <= 0) return 0;
    const strat = options.strat;
    if (strat && strat.lightOrganicMl > 0.2 && strat.aqueousMl <= 0.05) {
      // Mineral oil / nonpolar solvent shields alkali metal from ambient trace moisture
      return 0;
    }
    const solidId = rxn.solidId || 'K_s';
    const nMet = moles[solidId] || 0;
    if (nMet <= 1e-10) return 0;
    if (rxn.id === 'k_acid' && (moles.H_aq || 0) / liquidVolL < 0.01) return 0;
    if (rxn.id === 'k_water' && hasNitrateOxidizingEnv(moles, liquidVolL) && (moles.H_aq || 0) > 1e-3) return 0;
    const area = computeSolidSurfaceAreaM2(solidId, nMet, vessel.particleCounts?.[solidId] ?? 1);
    const waterScale = Math.min(1.0, (moles.H2O_l || 0) / 0.08);
    const tK = vessel.kTempK ?? T;
    const spec = APPARATUS[vessel.typeId];
    const totMl = liquidVolL * 1000 + computeSolidVolumeMl(moles);
    const areaSurfCm2 = spec?.geometry ? Math.max(0.5, spec.geometry.getLiquidState(totMl).surfaceAreaCm2) : spec?.surfaceAreaCm2 || 25.0;
    const isMoltenK = tK >= (SPECIES.K_s.meltTempK || 336.65);
    const gammaCoulombK = isMoltenK ? (areaSurfCm2 < 15.0 ? 3.4 : 1.45) : 1.0;
    const oilCoverDamp = strat?.hasLightCover ? 0.24 : 1.0;
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ || 9500, tK) * gammaCoulombK * oilCoverDamp;
    const acidBoost = rxn.id === 'k_acid' ? Math.min(6.0, 1.0 + (moles.H_aq || 0) / liquidVolL) : 1.0;
    return k * Math.max(1e-5, area) * waterScale * acidBoost * iceMob * 14.0;
  }

  if (rxn.type === 'mg_water_rxn') {
    if (!hasWater || iceMob <= 0) return 0;
    const nMg = moles.Mg_s || 0;
    if (nMg <= 1e-10 || (moles.H_aq || 0) > 0.01) return 0;
    // Above 100.5 °C steam combustion (mg_steam_burn) takes over completely
    if (T > 373.65) return 0;
    const area = computeSolidSurfaceAreaM2('Mg_s', nMg, vessel.particleCounts?.Mg_s ?? 6);
    // < 80 °C (353.15 K): passivated by Mg(OH)2 film -> negligible rate; 80–100 °C: brisk bubbling
    if (T < 353.15) {
      return rxn.k298 * arrheniusFactor(rxn.eaJ || 42000, T) * Math.max(1e-5, area) * 0.002 * iceMob;
    }
    const hotFactor = 4.2 + Math.min(4.0, (T - 353.15) * 0.22);
    return rxn.k298 * arrheniusFactor(rxn.eaJ || 42000, T) * Math.max(1e-5, area) * hotFactor * stirBoost * iceMob * 9.0;
  }

  if (rxn.type === 'mg_steam_rxn') {
    if (T <= (rxn.minTempK || 373.65)) return 0;
    const nMg = moles.Mg_s || 0;
    const nSteam = (vessel.headspaceGasMoles?.H2O_g || 0) + (moles.H2O_l || 0);
    if (nMg <= 1e-10 || nSteam <= 1e-9) return 0;
    const area = computeSolidSurfaceAreaM2('Mg_s', nMg, vessel.particleCounts?.Mg_s ?? 6);
    const k = (rxn.kAtThreshold || 0.42) * arrheniusFactor(rxn.eaJ || 36000, T - 373.65 + CONSTANTS.T_STD_K);
    return Math.min(nMg * 0.9, nSteam * 0.9, k * Math.max(1e-4, area) * 14.0);
  }

  if (rxn.type === 'al_alkali') {
    if (!hasWater || iceMob <= 0) return 0;
    const nAl = moles.Al_s || 0;
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    if (nAl <= 1e-10 || cOH < 0.02) return 0;
    const area = computeSolidSurfaceAreaM2('Al_s', nAl, vessel.particleCounts?.Al_s ?? 6);
    return rxn.k298 * arrheniusFactor(rxn.eaJ || 24000, T) * Math.max(1e-5, area) * Math.min(8.0, cOH * 3.5) * stirBoost * iceMob * 10.0;
  }

  if (rxn.type === 'alkali_dissolve_amphoteric') {
    if (!hasWater || iceMob <= 0) return 0;
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    if (cOH < 0.02) return 0;
    let minExt = Infinity;
    for (const [spId, st] of Object.entries(rxn.reactants)) {
      minExt = Math.min(minExt, (moles[spId] || 0) / st);
    }
    if (minExt <= 1e-11) return 0;
    return minExt * rxn.k298 * arrheniusFactor(rxn.eaJ || 18000, T) * Math.min(5.0, cOH * 2.0) * stirBoost * iceMob;
  }

  if (rxn.type === 'thermite_solid_state') {
    if (T < (rxn.minTempK || 823.15)) return 0;
    const nAl = moles.Al_s || 0;
    const nFeOx = moles.Fe2O3_s || 0;
    if (nAl <= 1e-10 || nFeOx <= 1e-10) return 0;
    const ext = Math.min(nAl / 2, nFeOx);
    return ext * rxn.k298 * arrheniusFactor(rxn.eaJ || 45000, T - 823.15 + CONSTANTS.T_STD_K);
  }

  if (rxn.type === 'metal_co2_burn' || rxn.type === 'metal_n2_burn') {
    if (T < (rxn.minTempK || 873.15)) return 0;
    const nMg = moles.Mg_s || 0;
    const nGas = getReactantAvailableMol(vessel, rxn.gasId, env);
    if (nMg <= 1e-10 || nGas <= 1e-10) return 0;
    const area = computeSolidSurfaceAreaM2('Mg_s', nMg, vessel.particleCounts?.Mg_s ?? 6);
    const k = (rxn.kAtThreshold || 0.6) * arrheniusFactor(rxn.eaJ || 45000, T - (rxn.minTempK || 873.15) + CONSTANTS.T_STD_K);
    return Math.min(nMg / (rxn.reactants.Mg_s || 2), nGas, k * Math.max(1e-4, area) * 14.0);
  }

  if (rxn.type === 'potassium_combustion_gas') {
    const nK = moles.K_s || 0;
    if (nK <= 1e-10) return 0;
    const pO2 = getVesselEffectiveO2Bar(vessel, options.environment);
    if (pO2 <= 0.02) return 0;
    if ((moles.H2O_l || 0) > 0.01 && (vessel.tempK || 298) < 350) return 0;
    const tEff = Math.max(vessel.kTempK || 0, T);
    const ignK = getKIgnitionTempK(vessel, options.environment);
    if (tEff < ignK && (vessel.headspaceGasMoles?.O2_g || 0) <= 1e-4) return 0;
    const area = computeSolidSurfaceAreaM2('K_s', nK, vessel.particleCounts?.K_s ?? 1);
    const o2Drive = Math.min(4.5, pO2 / CONSTANTS.AIR_O2_FRAC);
    const k = 1.9 * arrheniusFactor(rxn.eaJ || 18000, tEff);
    return Math.min(nK * 0.9, k * Math.max(1e-4, area) * o2Drive * 24.0);
  }

  if (rxn.type === 'alkoxide_hydrolysis') {
    if (!hasWater || iceMob <= 0) return 0;
    const nW = moles.H2O_l || 0;
    const nE = moles.C2H5OH_l || 0;
    const nEtho = moles.C2H5O_aq || 0;
    const nTotBase = (moles.OH_aq || 0) + nEtho;
    if (nEtho <= 1e-10 || nTotBase <= 1e-10) return 0;
    const xEtOH = nE / Math.max(1e-9, nW + nE);
    const maxEthoKeepFrac = Math.min(0.65, 1.35 * xEtOH);
    const excessEtho = nEtho - nTotBase * maxEthoKeepFrac;
    if (excessEtho <= 1e-11) return 0;
    return Math.min(excessEtho, nW) * rxn.kRelax298 * arrheniusFactor(rxn.eaJ, T) * iceMob;
  }

  if (rxn.type === 'cu_comprop_complex' || rxn.type === 'cu_comprop_free') {
    if (!hasWater || iceMob <= 0 || T < rxn.minTempK) return 0;
    const cCl = (moles.Cl_aq || 0) / liquidVolL;
    if (cCl < rxn.minClConc) return 0;
    const area = computeSolidSurfaceAreaM2('Cu_s', moles.Cu_s || 0, vessel.particleCounts?.Cu_s ?? 8);
    const cuSrc = rxn.type === 'cu_comprop_complex' ? moles.CuCl4_2_aq || 0 : moles.Cu2_aq || 0;
    const cCuSrc = cuSrc / liquidVolL;
    return rxn.k298 * arrheniusFactor(rxn.eaJ, T) * area * Math.min(3.0, cCuSrc * 4.0) * stirBoost * iceMob * 4.0;
  }

  if (rxn.type === 'brass_plating') {
    if (!hasWater || iceMob <= 0 || T < rxn.minTempK) return 0;
    if ((moles.ZnOH4_2_aq || 0) < 1e-5) return 0;
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    if (cOH < rxn.minOhConc) return 0;
    const areaCu = computeSolidSurfaceAreaM2('Cu_s', moles.Cu_s || 0, 8);
    const cZincate = (moles.ZnOH4_2_aq || 0) / liquidVolL;
    return rxn.k298 * arrheniusFactor(rxn.eaJ, T) * Math.max(1e-5, areaCu) * Math.min(3.5, 0.8 + cZincate * 8) * iceMob * 18.0;
  }

  if (rxn.type === 'alkali_nitrate_red') {
    if (!hasWater || iceMob <= 0) return 0;
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    const cNO3 = (moles.NO3_aq || 0) / liquidVolL;
    if (cOH < rxn.minOhConc || cNO3 < 0.005) return 0;
    const area = computeSolidSurfaceAreaM2('Zn_s', moles.Zn_s || 0, vessel.particleCounts?.Zn_s ?? 8);
    const kEff = getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0);
    const stirFactor = rxn.isHeterogeneous ? 1.0 : stirBoost;
    return kEff * area * Math.min(4.0, cNO3 * 3.0) * Math.min(3.0, cOH / 2.5) * stirFactor * iceMob * 8.0;
  }

  if (rxn.type === 'peroxide_decomp_cat') {
    if (!hasWater || iceMob <= 0) return 0;
    const cH2O2 = (moles.H2O2_aq || 0) / liquidVolL;
    const cH = (moles.H_aq || 0) / liquidVolL;
    const nCuCat =
      (moles.Cu2_aq || 0) +
      (moles.CuNH3_4_2_aq || 0) +
      0.35 * (moles.CuOH2_s || 0) +
      0.35 * (moles.CuO_s || 0) +
      0.5 * (moles.CuCl4_2_aq || 0);
    if (nCuCat <= 1e-8 || cH2O2 <= 1e-5) return 0;
    const cCuCat = nCuCat / liquidVolL;
    // Free H+ stabilizes H2O2 against Cu(II)-aqua disproportionation; neutral/ammoniacal Cu(II) catalyzes vigorously
    const acidSuppress = cH > 0.25 ? 0.04 : 1.0;
    const k = getEffectiveRateConstant(rxn, T);
    return (moles.H2O2_aq / 2) * k * acidSuppress * Math.min(3.5, cCuCat * 12.0) * Math.min(2.0, 0.4 + cH2O2 * 0.2) * iceMob;
  }

  if (rxn.type === 'peroxide_decomp_metal') {
    if (!hasWater || iceMob <= 0) return 0;
    const nSolid = moles[rxn.solidId] || 0;
    const cH2O2 = (moles.H2O2_aq || 0) / liquidVolL;
    if (nSolid <= 1e-9 || cH2O2 <= 1e-5) return 0;
    const minMirrorPCount = (vessel.silverMirrorFrac || 0) > 0.02 ? 900 : 8;
    const pCnt = Math.max(vessel.particleCounts?.[rxn.solidId] ?? 8, minMirrorPCount);
    const area = computeSolidSurfaceAreaM2(rxn.solidId, nSolid, pCnt);
    const k = getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0);
    const autoBoost = (vessel.silverMirrorFrac || 0) > 0.02 ? 1.85 : 1.0;
    return Math.min(moles.H2O2_aq / 2, k * area * Math.min(4.0, cH2O2 * 0.6) * autoBoost * 24.0) * iceMob;
  }

  if (rxn.type === 'peroxide_decomp_langmuir') {
    if (!hasWater || iceMob <= 0) return 0;
    const nCat = moles[rxn.solidId] || 0;
    const cH2O2 = (moles.H2O2_aq || 0) / liquidVolL;
    if (nCat <= 1e-10 || cH2O2 <= 1e-5) return 0;
    // Langmuir-Hinshelwood adsorption isotherm: theta = (K_L * C) / (1 + K_L * C)
    // At high [H2O2] (30% ~ 9.8 M): theta -> 1 (strict zero-order constant rate ~ S_cat);
    // At low [H2O2]: theta ~ K_L * C (shifts smoothly to 1st-order decay).
    const K_L = rxn.kLangmuir || 1.85;
    const theta = (K_L * cH2O2) / (1 + K_L * cH2O2);
    vessel.langmuirCoverage = theta;
    vessel.langmuirOrder = 1 - theta;
    // Effective exposed catalyst area scales linearly with fine precipitated Ag2O / MnO2 mass/particle count
    const catArea = Math.min(0.24, nCat * (rxn.solidId === 'MnO2_s' ? 28.0 : 18.0));
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T) * (vessel.stirTimer > 0 ? 1.18 : 1.0);
    return Math.min(moles.H2O2_aq / 2, k * catArea * theta * 1.45) * iceMob;
  }

  if (rxn.type === 'peroxide_decomp_base') {
    if (!hasWater || iceMob <= 0) return 0;
    const cH2O2 = (moles.H2O2_aq || 0) / liquidVolL;
    if (cH2O2 <= 1e-5) return 0;
    const cBase = ((moles.OH_aq || 0) + 0.15 * (moles.NH3_aq || 0)) / liquidVolL;
    const kThermal = getEffectiveRateConstant(rxn, T);
    const kBase =
      cBase > 1e-3
        ? (rxn.kBase298 || 0.025) * arrheniusFactor(rxn.eaBaseJ || 42000, T) * Math.min(4.0, cBase * 1.5)
        : 0;
    return (moles.H2O2_aq / 2) * (kThermal + kBase) * iceMob;
  }

  if (rxn.type === 'peroxide_metal_ox') {
    if (!hasWater || iceMob <= 0) return 0;
    // Phenomenon #10: Sacrificial Cathodic Protection — metallic Zn in direct contact or electrically coupled protects Cu from HCl + H2O2 corrosion!
    if (rxn.solidId === 'Cu_s' && ((moles.Zn_s || 0) > 1e-6 || vessel.cathodicProtectedByZn)) {
      return 0;
    }
    const cH2O2 = (moles.H2O2_aq || 0) / liquidVolL;
    const cH = (moles.H_aq || 0) / liquidVolL;
    const cCl = rxn.reactants.Cl_aq ? (moles.Cl_aq || 0) / liquidVolL : 1.0;
    if (cH2O2 < 0.02 || cH < 0.05 || cCl < 0.05) return 0;
    const area = computeSolidSurfaceAreaM2(rxn.solidId, moles[rxn.solidId] || 0, vessel.particleCounts?.[rxn.solidId] ?? 8);
    const k = getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0);
    const drive =
      Math.min(3.5, cH2O2 * 0.45) *
      Math.min(2.5, cH * 0.45) *
      (rxn.reactants.Cl_aq ? Math.min(2.0, cCl * 0.4) : 1.0);
    return k * area * drive * iceMob * 3.5;
  }

  if (rxn.type === 'tollens_h2o2' || rxn.type === 'tollens_h2o2_neut') {
    if (!hasWater || iceMob <= 0) return 0;
    const nAgAmm = moles.AgNH3_2_aq || 0;
    const nPerox = moles.H2O2_aq || 0;
    const nOH = moles.OH_aq || 0;
    if (rxn.type === 'tollens_h2o2' && nOH < 1e-5) return 0;
    if (rxn.type === 'tollens_h2o2_neut' && nOH >= 1e-5) return 0;
    if (nAgAmm < 1e-9 || nPerox < 1e-9) return 0;
    const cAgAmm = nAgAmm / liquidVolL;
    const cPerox = nPerox / liquidVolL;
    const minExt = Math.min(nAgAmm / 2, nPerox, rxn.type === 'tollens_h2o2' ? nOH / 2 : Infinity);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T);
    return Math.min(minExt * 4.5, k * minExt * Math.min(3.5, 0.4 + cPerox * 0.6) * Math.min(2.5, 0.5 + cAgAmm * 2.0)) * iceMob;
  }

  if (rxn.type === 'peroxide_ammoniacal_cu') {
    if (!hasWater || iceMob <= 0) return 0;
    const nCu = moles.Cu_s || 0;
    const cNH3 = (moles.NH3_aq || 0) / liquidVolL;
    const cH2O2 = (moles.H2O2_aq || 0) / liquidVolL;
    if (nCu < 1e-9 || cNH3 < 0.05 || cH2O2 < 0.02) return 0;
    const area = computeSolidSurfaceAreaM2('Cu_s', nCu, vessel.particleCounts?.Cu_s ?? 12);
    const k = getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0);
    return k * area * Math.min(4.0, cNH3 * 0.5) * Math.min(3.5, cH2O2 * 0.5) * iceMob * 4.2;
  }

  if (rxn.type === 'photochemical_agcl') {
    const nAgCl = moles.AgCl_s || 0;
    if (nAgCl < 1e-9) return 0;
    const uvDrive = options.uvLight || vessel.uvExposureActive ? 1.0 : 0;
    if (uvDrive <= 0) return 0;
    return nAgCl * 0.5 * rxn.k298 * uvDrive;
  }

  if (rxn.type === 'moist_solid_redox') {
    if (vessel.isFrozenSolid) return 0;
    const nW = moles.H2O_l || 0;
    const initiated = nW >= 5e-4 || ((moles.ZnNO3_2_s || 0) > 1e-4 && T >= 325.0);
    // Completely bone dry -> inert; tiny drop (>= 0.01 mL) initiates self-propagating molten-salt solid redox!
    if (!initiated || nW > 0.18) return 0;
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    return minExtent * rxn.k298 * arrheniusFactor(rxn.eaJ, T);
  }

  if (rxn.type === 'aqua_regia_metal') {
    if (!hasWater || iceMob <= 0) return 0;
    const cH = (moles.H_aq || 0) / liquidVolL;
    const cCl = (moles.Cl_aq || 0) / liquidVolL;
    const cNO3 = (moles.NO3_aq || 0) / liquidVolL;
    if (cH < 4.0 || cCl < 4.0 || cNO3 < 0.20) return 0;
    const solidId = rxn.reactants.Cu_s ? 'Cu_s' : 'Ag_s';
    const area = computeSolidSurfaceAreaM2(solidId, moles[solidId] || 0, 8);
    const oxDrive = Math.min(4.0, (cH / 5.0) * (cCl / 5.0) * (cNO3 / 0.3));
    return rxn.k298 * arrheniusFactor(rxn.eaJ, T) * Math.max(1e-5, area) * oxDrive * stirBoost * iceMob * 12.0;
  }

  if (rxn.type === 'autocatalytic') {
    if (!hasWater || iceMob <= 0) return 0;
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    if (minExtent <= 1e-12 || !Number.isFinite(minExtent)) return 0;
    const catId = rxn.autocatProductId;
    const catConc = catId ? (moles[catId] || 0) / Math.max(1e-5, liquidVolL) : 0;
    const uncat = rxn.autocatUncatFrac ?? 0.012;
    const catTerm = Math.pow(Math.max(0, catConc), rxn.autocatOrder ?? 1.0) * (rxn.autocatBoost ?? 28.0);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ ?? 30000, T);
    return Math.min(minExtent * 15, minExtent * k * (uncat + catTerm) * stirBoost * iceMob);
  }

  if (rxn.type === 'gas_solid_reduction') {
    if (T < (rxn.minTempK || 423)) return 0;
    const solidId = rxn.solidId || 'CuO_s';
    const gasId = rxn.gasId || 'H2_g';
    const nSolid = moles[solidId] || 0;
    const nGas = vessel.headspaceGasMoles?.[gasId] || 0;
    if (nSolid <= 1e-10 || nGas <= 1e-10) return 0;
    const gasDrive = Math.min(3.2, Math.max(0.15, nGas / 0.0003));
    const k = (rxn.kAtThreshold || 0.65) * arrheniusFactor(rxn.eaJ || 48000, T - (rxn.minTempK || 423) + CONSTANTS.T_STD_K);
    return Math.min(nSolid * 0.85, nGas * 6.0, Math.min(nSolid, nGas * 14.0) * k * gasDrive);
  }

  if (rxn.type === 'metal_combustion_gas') {
    const solidId = rxn.solidId || 'Zn_s';
    const pCount = vessel.particleCounts?.[solidId] ?? 6;
    const isFineMetal = Boolean(vessel.groundPowderMap?.[solidId]) || pCount >= 20;
    const isFineAl =
      solidId === 'Al_s' &&
      !vessel.flattenedMetalMap?.Al_s &&
      (Boolean(vessel.groundPowderMap?.Al_s) || pCount >= 120);
    const pO2 = getVesselEffectiveO2Bar(vessel, options.environment);
    const inEnrichedO2 = (vessel.headspaceGasMoles?.O2_g || 0) > 1e-4 || pO2 > 0.35;
    // Al foil (or ductile hammered foil in mortar) does NOT burn in ordinary air!
    if (solidId === 'Al_s' && !isFineAl && !inEnrichedO2) return 0;
    const minTK =
      solidId === 'Zn_s'
        ? getZnIgnitionTempK(vessel, options.environment, options)
        : solidId === 'Fe_s'
        ? (isFineMetal ? 610 : rxn.minTempK || 760)
        : solidId === 'Al_s'
        ? (isFineAl ? 823.15 : 1073.15)
        : (rxn.minTempK || 585);
    if (T < minTK) return 0;
    // Fe_s in ordinary air is governed by fe_air_combustion (powder spark combustion vs nail protective 3-layer scale);
    // fe_o2_burn activates specifically in pure/enriched O2 (>0.35 bar or headspace O2 > 1e-4)
    if (solidId === 'Fe_s' && !inEnrichedO2) return 0;
    if (pO2 <= 0.015) return 0;
    const nSolid = moles[solidId] || 0;
    if (nSolid <= 1e-10) return 0;
    const area = computeSolidSurfaceAreaM2(solidId, nSolid, pCount);
    const o2Drive = Math.min(4.8, pO2 / CONSTANTS.AIR_O2_FRAC);
    const k = (rxn.kAtThreshold || 0.65) * arrheniusFactor(rxn.eaJ || 48000, T - minTK + CONSTANTS.T_STD_K);
    const stoichS = rxn.reactants?.[solidId] || 1;
    return Math.min((nSolid / stoichS) * 0.9, k * Math.max(1e-4, area) * o2Drive * (24.0 / stoichS));
  }

  if (rxn.type === 'fe_air_combustion') {
    const nFe = moles.Fe_s || 0;
    if (nFe <= 1e-10) return 0;
    const pCount = vessel.particleCounts?.Fe_s ?? 4;
    const isFineFe = Boolean(vessel.groundPowderMap?.Fe_s) || pCount >= 18;
    if (rxn.fineOnly && !isFineFe) return 0;
    if (rxn.bulkOnly && isFineFe) return 0;
    if (T < (rxn.minTempK || 773.15)) return 0;
    if (rxn.maxTempK && T >= rxn.maxTempK) return 0;
    const pO2 = getVesselEffectiveO2Bar(vessel, options.environment);
    // If inside enriched O2 vessel, let fe_o2_burn drive pure O2 spark combustion
    if ((vessel.headspaceGasMoles?.O2_g || 0) > 1e-4 || pO2 > 0.35 || pO2 <= 0.015) return 0;
    const area = computeSolidSurfaceAreaM2('Fe_s', nFe, isFineFe ? Math.max(240, pCount) : pCount);
    const o2Drive = Math.min(1.6, pO2 / CONSTANTS.AIR_O2_FRAC);
    const k = (rxn.kAtThreshold || 0.05) * arrheniusFactor(rxn.eaJ || 46000, T - (rxn.minTempK || 773.15) + CONSTANTS.T_STD_K);
    const stoichS = rxn.reactants?.Fe_s || 3;
    // Bulk iron nail builds a protective oxide scale that severely slows further oxidation (parabolic passivation)
    const oxideMol = (moles.FeO_s || 0) + (moles.Fe3O4_s || 0) * 2 + (moles.Fe2O3_s || 0) * 1.5;
    const scaleDamp = rxn.bulkOnly ? Math.max(0.08, 1.0 - (oxideMol / Math.max(1e-6, oxideMol + nFe)) * 1.4) : 1.0;
    return Math.min((nFe / stoichS) * 0.85, k * Math.max(1e-4, area) * o2Drive * scaleDamp * (18.0 / stoichS));
  }

  if (rxn.type === 'sodium_combustion_gas') {
    // Auto-ignition dry or above water meniscus once Na reaches size- & humidity-dependent threshold
    const nNa = moles.Na_s || 0;
    if (nNa <= 1e-10) return 0;
    const pO2 = getVesselEffectiveO2Bar(vessel, options.environment);
    if (pO2 <= 0.02) return 0;
    if ((moles.H2O_l || 0) > 0.01 && (vessel.tempK || 298) < 385) return 0;
    const tEff = Math.max(vessel.naTempK || 0, T);
    const ignK = getNaIgnitionTempK(vessel, options.environment);
    if (tEff < ignK) return 0;
    const pCount = vessel.particleCounts?.Na_s ?? 1;
    const area = computeSolidSurfaceAreaM2('Na_s', nNa, pCount);
    const o2Drive = Math.min(4.5, pO2 / CONSTANTS.AIR_O2_FRAC);
    const k = 1.65 * arrheniusFactor(rxn.eaJ || 22000, tEff - ignK + CONSTANTS.T_STD_K);
    return Math.min(nNa * 0.9, k * Math.max(1e-4, area) * o2Drive * 28.0);
  }

  if (rxn.type === 'calcination_eq') {
    const nCaCO3 = moles.CaCO3_s || 0;
    if (nCaCO3 <= 1e-10) return 0;
    const pEq = calcCaCO3EqPressureAtm(T);
    const spec = APPARATUS[vessel.typeId];
    const headL = Math.max(0.015, ((spec?.maxVolumeMl || 60) - computeSolidVolumeMl(moles)) / 1000);
    const nHeadCO2 = vessel.headspaceGasMoles?.CO2_g || 0;
    const pLocalFromGas =
      vessel.isStoppered && !vessel.connectedTargetId && !vessel.connectedSyringeId
        ? (nHeadCO2 * CONSTANTS.R_ATM_L_MOL_K * T) / headL
        : vessel.lidState === 'closed'
        ? (nHeadCO2 * CONSTANTS.R_ATM_L_MOL_K * T) / headL + 0.35
        : vessel.lidState === 'ajar'
        ? 0.018
        : 0.0004;
    const pCO2 = Math.max(CONSTANTS.AIR_CO2_FRAC || 0.0004, pLocalFromGas);
    if (pEq <= pCO2) {
      vessel.calcinationEqPAtm = pEq;
      vessel.calcinationLocalCO2Atm = pCO2;
      vessel.calcinationLeChatelier = 0;
      return 0;
    }
    const leChat = Math.max(0, 1.0 - pCO2 / pEq);
    const pCount = vessel.particleCounts?.CaCO3_s ?? 6;
    const isFine = Boolean(vessel.groundPowderMap?.CaCO3_s) || pCount >= 60;
    const area = computeSolidSurfaceAreaM2('CaCO3_s', nCaCO3, isFine ? Math.max(pCount, 400) : pCount);
    const nCaO = moles.CaO_s || 0;
    const shellFrac = nCaO / Math.max(1e-9, nCaO + nCaCO3);
    // Coarse unground limestone develops an insulating porous CaO shell slowing core CO2 escape
    const coreDiffFactor = isFine ? 1.0 : Math.max(0.14, 1.0 - 0.84 * shellFrac);
    const k0 = 4.2e6; // Calibrated to reach ~95-99% conversion cleanly within 8-14s at 1200-1450 C Bunsen zone
    const kArr = k0 * Math.exp(-rxn.eaJ / (CONSTANTS.R_J_MOL_K * Math.max(250, T)));
    vessel.calcinationEqPAtm = pEq;
    vessel.calcinationLocalCO2Atm = pCO2;
    vessel.calcinationLeChatelier = leChat;
    return Math.min(nCaCO3 * 0.9, kArr * Math.max(1e-4, area) * leChat * coreDiffFactor);
  }

  if (rxn.type === 'slaking_hydration') {
    if (!hasWater || iceMob <= 0) return 0;
    const nCaO = moles.CaO_s || 0;
    const nW = moles.H2O_l || 0;
    if (nCaO <= 1e-10 || nW <= 1e-10) return 0;
    const area = computeSolidSurfaceAreaM2('CaO_s', nCaO, vessel.particleCounts?.CaO_s ?? 120);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T) * stirBoost * iceMob;
    return Math.min(nCaO, nW, k * Math.max(1e-4, area) * 42.0);
  }

  if (rxn.type === 'dissolve_solid') {
    if (!hasWater || iceMob <= 0) return 0;
    if (computeSulfuricAcidState(moles).w >= 0.75) return 0;
    const nSolid = moles[rxn.solidId] || 0;
    if (nSolid <= 1e-10 || (moles.H2O_l || 0) < 0.02) return 0;
    const area = computeSolidSurfaceAreaM2(rxn.solidId, nSolid, vessel.particleCounts?.[rxn.solidId] ?? 12);
    return rxn.k298 * arrheniusFactor(rxn.eaJ || 8000, T) * Math.max(1e-5, area) * stirBoost * iceMob * 40.0;
  }

  if (rxn.type === 'heterogeneous_acid_salt') {
    if (!hasWater || iceMob <= 0) return 0;
    const nSolid = moles[rxn.solidId] || 0;
    const cH = (moles[rxn.aqueousId] || 0) / liquidVolL;
    if (nSolid <= 1e-10 || cH < 1e-4) return 0;
    const pCount = vessel.particleCounts?.[rxn.solidId] ?? 6;
    const area = computeSolidSurfaceAreaM2(rxn.solidId, nSolid, pCount);
    const k = getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0);
    // CaSO4 crust passivation on coarse CaCO3 in sulfate-bearing media (does not halt ground powder or HCl)
    let sulfatePassivMult = 1.0;
    if (rxn.solidId === 'CaCO3_s') {
      const nSO4Tot = (moles.SO4_2_aq || 0) + (moles.HSO4_aq || 0) + (moles.CaSO4_s || 0);
      const isFineCaCO3 = Boolean(vessel.groundPowderMap?.CaCO3_s) || pCount >= 36;
      if (nSO4Tot > 1e-4 && ((moles.CaSO4_s || 0) > 2e-5 || (moles.SO4_2_aq || 0) / liquidVolL > 0.15)) {
        const coatRatio = Math.min(1, ((moles.CaSO4_s || 0) * 18.0) / Math.max(0.01, nSolid));
        sulfatePassivMult = isFineCaCO3 ? Math.max(0.35, 1 - 0.55 * coatRatio) : Math.max(0.015, 1 - 0.96 * coatRatio);
        vessel.caso4Passivated = !isFineCaCO3 && (moles.CaSO4_s || 0) > 2e-5 && sulfatePassivMult < 0.65;
      } else {
        vessel.caso4Passivated = false;
      }
    }
    return Math.min(nSolid, (moles[rxn.aqueousId] || 0) / 2, k * Math.max(1e-5, area) * Math.min(12.0, cH) * 6.5 * iceMob * sulfatePassivMult);
  }

  if (rxn.type === 'excess_co2_bicarb') {
    if (!hasWater || iceMob <= 0) return 0;
    const nCaCO3 = moles.CaCO3_s || 0;
    const nH2CO3 = moles.H2CO3_aq || 0;
    if (nCaCO3 <= 1e-10 || nH2CO3 <= 1e-7) return 0;
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    if (cOH > 0.0025) return 0;
    const cAcid = nH2CO3 / liquidVolL;
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T) * stirBoost * iceMob;
    return Math.min(nCaCO3, nH2CO3) * k * Math.min(4.0, 0.35 + cAcid * 18.0);
  }

  if (rxn.type === 'bicarb_thermal_reprecip') {
    if (!hasWater || iceMob <= 0 || T < (rxn.minTempK || 333.15)) return 0;
    const nCa = moles.Ca2_aq || 0;
    const nHCO3 = moles.HCO3_aq || 0;
    if (nCa <= 1e-10 || nHCO3 < 2e-10) return 0;
    const minExt = Math.min(nCa, nHCO3 / 2);
    const k = rxn.kAtThreshold * arrheniusFactor(rxn.eaJ, T - (rxn.minTempK || 333.15) + CONSTANTS.T_STD_K);
    return minExt * k;
  }

  if (rxn.type === 'sparing_salt_ppt') {
    if (!hasWater || iceMob <= 0) return 0;
    const cCa = (moles.Ca2_aq || 0) / liquidVolL;
    const cSO4 = (moles.SO4_2_aq || 0) / liquidVolL;
    if (cCa * cSO4 <= (rxn.kspThreshold || 0.00025)) return 0;
    const excessExt = Math.min(moles.Ca2_aq || 0, moles.SO4_2_aq || 0) * 0.85;
    return excessExt * getEffectiveRateConstant(rxn, T, false) * iceMob;
  }

  if (rxn.type === 'sparing_salt_ppt_ag2so4') {
    if (!hasWater || iceMob <= 0) return 0;
    const cAg = (moles.Ag_aq || 0) / liquidVolL;
    const cSO4 = (moles.SO4_2_aq || 0) / liquidVolL;
    if (cAg * cAg * cSO4 <= (rxn.kspThreshold || 1.4e-5)) return 0;
    const excessExt = Math.min((moles.Ag_aq || 0) / 2, moles.SO4_2_aq || 0) * 0.72;
    return excessExt * getEffectiveRateConstant(rxn, T, false) * iceMob;
  }

  if (rxn.type === 'metal_halogen_gas') {
    if (T < (rxn.minTempK || 345)) return 0;
    const solidId = rxn.solidId || 'Cu_s';
    const gasId = rxn.gasId || 'Cl2_g';
    const nSolid = moles[solidId] || 0;
    const nGas = vessel.headspaceGasMoles?.[gasId] || 0;
    if (nSolid <= 1e-10 || nGas <= 1e-10) return 0;
    const area = computeSolidSurfaceAreaM2(solidId, nSolid, vessel.particleCounts?.[solidId] ?? 12);
    const k = (rxn.kAtThreshold || 0.8) * arrheniusFactor(rxn.eaJ || 25000, T - (rxn.minTempK || 345) + CONSTANTS.T_STD_K);
    return Math.min(nSolid, nGas * 2, k * Math.max(1e-4, area) * Math.min(3.5, nGas / 0.0005) * 16.0);
  }

  if (rxn.type === 'gas_solid_carbonate_o2') {
    const nPerox = moles.Na2O2_s || 0;
    const nCo2 = vessel.headspaceGasMoles?.CO2_g || 0;
    if (nPerox <= 1e-10 || nCo2 <= 1e-10) return 0;
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ || 18000, T);
    return Math.min(nPerox / 2, nCo2 / 2) * k * Math.min(4.0, nCo2 / 0.0005);
  }

  if (rxn.type === 'photochemical_h2_cl2') {
    const nH2 = vessel.headspaceGasMoles?.H2_g || 0;
    const nCl2 = vessel.headspaceGasMoles?.Cl2_g || 0;
    if (nH2 <= 1e-10 || nCl2 <= 1e-10) return 0;
    const active = Boolean(options.uvLight) || T >= 523.15;
    if (!active) return 0;
    return Math.min(nH2, nCl2) * (rxn.k298 || 3.8);
  }

  if (rxn.type === 'acid_dissolve_solid') {
    if (!hasWater || iceMob <= 0) return 0;
    const nSolid = moles[rxn.solidId] || 0;
    const stoichH = rxn.reactants?.H_aq || 2;
    const cH = (moles.H_aq || 0) / liquidVolL;
    if (nSolid <= 1e-10 || cH < 1e-4) return 0;
    const pCount = vessel.particleCounts?.[rxn.solidId] ?? 24;
    const area = computeSolidSurfaceAreaM2(rxn.solidId, nSolid, pCount);
    const k = getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0);
    return Math.min(nSolid, (moles.H_aq || 0) / stoichH, k * Math.max(1e-5, area) * Math.min(8.0, cH) * 5.0 * iceMob);
  }

  if (rxn.type === 'hno3_hydrate') {
    if ((moles.HNO3_l || 0) <= 1e-10 || (moles.H2O_l || 0) < 0.01 || iceMob <= 0) return 0;
    return moles.HNO3_l * 14.0 * iceMob;
  }

  if (rxn.type === 'hno3_photothermal') {
    const uvOn = Boolean(options.uvLight);
    if (rxn.isPure) {
      const nPure = moles.HNO3_l || 0;
      if (nPure <= 1e-9) return 0;
      if (!uvOn && T < (rxn.minTempK || 313.15)) return 0;
      const thermalDrive = T >= (rxn.minTempK || 313.15) ? arrheniusFactor(rxn.eaJ || 32000, T - 313.15 + 298.15) : 0;
      const uvDrive = uvOn ? 1.45 : 0;
      return (nPure / 4) * (rxn.k298 || 0.14) * (thermalDrive + uvDrive);
    }
    if (!hasWater || iceMob <= 0) return 0;
    const nAcid = Math.min(moles.H_aq || 0, moles.NO3_aq || 0);
    if (nAcid <= 1e-7) return 0;
    const mHNO3 = nAcid * CONSTANTS.M_HNO3;
    const mWater = (moles.H2O_l || 0) * CONSTANTS.M_H2O;
    const wHNO3 = mHNO3 / Math.max(1e-9, mHNO3 + mWater);
    if (wHNO3 < 0.32) return 0;
    if (!uvOn && T < (rxn.minTempK || 323.15)) return 0;
    const concScale = Math.min(2.4, Math.pow((wHNO3 - 0.25) / 0.43, 1.35));
    const thermalDrive = T >= (rxn.minTempK || 323.15) ? arrheniusFactor(rxn.eaJ || 36000, T - 323.15 + 298.15) : 0;
    const uvDrive = uvOn ? 1.35 : 0;
    return (nAcid / 4) * (rxn.k298 || 0.085) * concScale * (thermalDrive + uvDrive) * iceMob;
  }

  if (rxn.type === 'h2so4_hydrate') {
    const nH2SO4L = moles.H2SO4_l || 0;
    const nW = moles.H2O_l || 0;
    if (nH2SO4L <= 1e-10 || nW <= 1e-6 || iceMob <= 0) return 0;
    // Stay molecular when bulk mass fraction w >= 0.78; hydrate vigorously into ions + heat below 78% w/w
    if (computeSulfuricAcidState(moles).w >= 0.78) return 0;
    return nH2SO4L * 16.0 * iceMob;
  }

  if (rxn.type === 'h2so4_concentrate') {
    const sulf = computeSulfuricAcidState(moles);
    if (sulf.w < 0.78 || sulf.nAcidEq <= 1e-9) return 0;
    const totalCl = (moles.Cl_aq || 0) + 4 * (moles.CuCl4_2_aq || 0) + 2 * (moles.AgCl2_aq || 0) + 3 * (moles.AgCl3_2_aq || 0);
    const nFreeH = Math.max(0, (moles.H_aq || 0) - totalCl - (moles.NO3_aq || 0));
    let ext = Infinity;
    for (const [spId, st] of Object.entries(rxn.reactants)) {
      const avail = spId === 'H_aq' ? nFreeH : (moles[spId] || 0);
      ext = Math.min(ext, avail / st);
    }
    if (ext <= 1e-11 || !Number.isFinite(ext)) return 0;
    return ext * rxn.k298 * arrheniusFactor(rxn.eaJ || 8000, T);
  }

  if (rxn.type === 'h2so4_boil_fume') {
    if (T < (rxn.minTempK || 573.15)) return 0;
    const nH2SO4L = moles.H2SO4_l || 0;
    if (nH2SO4L <= 1e-8) return 0;
    return nH2SO4L * (rxn.kAtThreshold || 0.14) * arrheniusFactor(rxn.eaJ || 48000, T - (rxn.minTempK || 573.15) + CONSTANTS.T_STD_K);
  }

  if (rxn.type === 'h2so4_nacl_hcl') {
    const sulf = computeSulfuricAcidState(moles);
    if (sulf.w < 0.65) return 0;
    const nNaCl = moles.NaCl_s || 0;
    const nAcidL = moles.H2SO4_l || 0;
    if (nNaCl <= 1e-10 || nAcidL <= 1e-10) return 0;
    const area = computeSolidSurfaceAreaM2('NaCl_s', nNaCl, vessel.particleCounts?.NaCl_s ?? 12);
    const tierMult = sulf.tier === 'conc_98' ? 1.65 : 0.75;
    return rxn.k298 * arrheniusFactor(rxn.eaJ || 26000, T) * Math.max(1e-4, area) * tierMult * 22.0;
  }

  if (rxn.type === 'h2so4_nahso4_nacl') {
    if (T < (rxn.minTempK || 450.15)) return 0;
    const nNaCl = moles.NaCl_s || 0;
    const nNaHSO4 = moles.NaHSO4_s || 0;
    if (nNaCl <= 1e-10 || nNaHSO4 <= 1e-10) return 0;
    return Math.min(nNaCl, nNaHSO4) * rxn.k298 * arrheniusFactor(rxn.eaJ || 34000, T - 450.15 + CONSTANTS.T_STD_K);
  }

  if (rxn.type === 'h2so4_conc_salt' || rxn.type === 'h2so4_conc_base') {
    const nAcidL = moles.H2SO4_l || 0;
    if (nAcidL <= 1e-10) return 0;
    let minExt = nAcidL;
    for (const [spId, st] of Object.entries(rxn.reactants)) {
      minExt = Math.min(minExt, (moles[spId] || 0) / st);
    }
    if (minExt <= 1e-11) return 0;
    // CaCO3 in conc H2SO4 forms an insulating CaSO4 shell on coarse pieces
    let coatMult = 1.0;
    if (rxn.solidId === 'CaCO3_s') {
      const isFine = Boolean(vessel.groundPowderMap?.CaCO3_s) || (vessel.particleCounts?.CaCO3_s ?? 6) >= 36;
      const coatRatio = Math.min(1, ((moles.CaSO4_s || 0) * 18.0) / Math.max(0.01, moles.CaCO3_s || 0.01));
      coatMult = isFine ? Math.max(0.3, 1 - 0.6 * coatRatio) : Math.max(0.02, 1 - 0.94 * coatRatio);
    }
    return minExt * rxn.k298 * arrheniusFactor(rxn.eaJ || 18000, T) * coatMult;
  }

  if (rxn.type === 'h2so4_dehydrate_cuso4') {
    const sulf = computeSulfuricAcidState(moles);
    if (sulf.w < 0.80 || (moles.CuSO4_5H2O_s || 0) <= 1e-10) return 0;
    const tierBoost = sulf.tier === 'conc_98' ? 1.5 : 0.7;
    return (moles.CuSO4_5H2O_s || 0) * rxn.k298 * arrheniusFactor(rxn.eaJ || 18000, T) * tierBoost;
  }

  if (rxn.type === 'h2so4_peroxide') {
    const sulf = computeSulfuricAcidState(moles);
    if (sulf.w < 0.55 || (moles.H2O2_aq || 0) <= 1e-9) return 0;
    if (sulf.w < 0.78 && T < 313.15) return 0;
    const concBoost = sulf.w >= 0.85 ? 2.2 : 1.0;
    return ((moles.H2O2_aq || 0) / 2) * rxn.k298 * arrheniusFactor(rxn.eaJ || 26000, T) * concBoost;
  }

  // --- Manganese Redox & Disproportionation Kinetics ---
  if (rxn.type === 'mn_redox_h2o2_acid' || rxn.type === 'mn_redox_h2o2_neutral') {
    if (!hasWater || iceMob <= 0) return 0;
    const cMnO4 = (moles.MnO4_aq || 0) / liquidVolL;
    const cH2O2 = (moles.H2O2_aq || 0) / liquidVolL;
    const cH = (moles.H_aq || 0) / liquidVolL;
    if (cMnO4 <= 1e-7 || cH2O2 <= 1e-6) return 0;
    if (rxn.type === 'mn_redox_h2o2_acid') {
      if (cH < 0.01) return 0;
      const ext = Math.min((moles.MnO4_aq || 0) / 2, (moles.H2O2_aq || 0) / 5, (moles.H_aq || 0) / 6);
      return ext * getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0) * Math.min(2.5, 0.5 + cH * 0.5) * iceMob;
    }
    if (cH >= 0.01) return 0;
    const ext = Math.min((moles.MnO4_aq || 0) / 2, (moles.H2O2_aq || 0) / 3);
    return ext * getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0) * iceMob;
  }

  if (rxn.type === 'mn_hcl_cl2' || rxn.type === 'mn_solid_hcl_cl2') {
    if (!hasWater || iceMob <= 0) return 0;
    const cH = (moles.H_aq || 0) / liquidVolL;
    const cCl = (moles.Cl_aq || 0) / liquidVolL;
    if (cH < 1.2 || cCl < 1.2) return 0;
    const concDrive = Math.min(3.5, Math.pow(Math.min(cH, cCl) / 4.0, 1.4));
    const mnSrc = rxn.type === 'mn_hcl_cl2' ? (moles.MnO4_aq || 0) : (moles.KMnO4_s || 0);
    if (mnSrc <= 1e-9) return 0;
    const ext = Math.min(mnSrc / 2, (moles.H_aq || 0) / 16, (moles.Cl_aq || 0) / 10);
    return ext * getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0) * concDrive * iceMob;
  }

  if (rxn.type === 'kmno4_conc_h2so4') {
    const sulf = computeSulfuricAcidState(moles);
    if (sulf.w < 0.72 || (moles.H2SO4_l || 0) <= 1e-6 || (moles.KMnO4_s || 0) <= 1e-9) return 0;
    const ext = Math.min((moles.KMnO4_s || 0) / 2, (moles.H2SO4_l || 0) / 2);
    return ext * rxn.k298 * arrheniusFactor(rxn.eaJ || 18000, T);
  }

  if (rxn.type === 'mn2o7_decomp') {
    const nMn2O7 = moles.Mn2O7_l || 0;
    if (nMn2O7 <= 1e-10) return 0;
    return (nMn2O7 / 2) * rxn.k298 * arrheniusFactor(rxn.eaJ || 12000, T);
  }

  if (rxn.type === 'kmno4_alkali_hot') {
    if (!hasWater || iceMob <= 0 || T < 333.15) return 0;
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    if (cOH < 3.0 || (moles.MnO4_aq || 0) <= 1e-8) return 0;
    const ext = Math.min((moles.MnO4_aq || 0) / 4, (moles.OH_aq || 0) / 4);
    return ext * rxn.k298 * arrheniusFactor(rxn.eaJ || 36000, T) * Math.min(3.0, cOH / 4.0) * iceMob;
  }

  if (rxn.type === 'mn_fe2_acid') {
    if (!hasWater || iceMob <= 0) return 0;
    const cH = (moles.H_aq || 0) / liquidVolL;
    if (cH < 0.005 || (moles.MnO4_aq || 0) <= 1e-9 || (moles.Fe2_aq || 0) <= 1e-9) return 0;
    const ext = Math.min(moles.MnO4_aq || 0, (moles.Fe2_aq || 0) / 5, (moles.H_aq || 0) / 8);
    return ext * getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0) * iceMob;
  }

  if (rxn.type === 'k2mno4_disprop_acid' || rxn.type === 'k2mno4_disprop_neutral') {
    if (!hasWater || iceMob <= 0) return 0;
    const nMnO42 = moles.MnO4_2_aq || 0;
    if (nMnO42 <= 1e-9) return 0;
    const cH = (moles.H_aq || 0) / liquidVolL;
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    if (rxn.type === 'k2mno4_disprop_acid') {
      if (cH < 1e-4) return 0;
      const ext = Math.min(nMnO42 / 3, (moles.H_aq || 0) / 4);
      return ext * getEffectiveRateConstant(rxn, T, false) * iceMob;
    }
    if (cH >= 1e-4 || cOH >= 0.08) return 0;
    const stabDamp = Math.max(0.05, 1 - cOH / 0.08);
    return Math.min(nMnO42 / 3, (moles.H2O_l || 0) / 2) * rxn.k298 * arrheniusFactor(rxn.eaJ || 24000, T) * stabDamp * iceMob;
  }

  if (rxn.type === 'mno2_hcl_hot') {
    if (!hasWater || iceMob <= 0 || T < (rxn.minTempK || 318.15)) return 0;
    const nMnO2 = moles.MnO2_s || 0;
    const cH = (moles.H_aq || 0) / liquidVolL;
    const cCl = (moles.Cl_aq || 0) / liquidVolL;
    if (nMnO2 <= 1e-9 || cH < 2.2 || cCl < 2.2) return 0;
    const area = computeSolidSurfaceAreaM2('MnO2_s', nMnO2, vessel.particleCounts?.MnO2_s ?? 400);
    const k = (rxn.kAtThreshold || 2.2) * arrheniusFactor(rxn.eaJ || 34000, T - 318.15 + CONSTANTS.T_STD_K);
    return Math.min(nMnO2, (moles.H_aq || 0) / 4, (moles.Cl_aq || 0) / 2, k * Math.max(1e-4, area) * Math.min(5.0, (Math.min(cH, cCl) - 1.5) * 0.65) * 42.0) * iceMob;
  }

  if (rxn.type === 'mno2_reductant_acid') {
    if (!hasWater || iceMob <= 0) return 0;
    const nMnO2 = moles.MnO2_s || 0;
    const cH = (moles.H_aq || 0) / liquidVolL;
    if (nMnO2 <= 1e-9 || cH < 0.02) return 0;
    let minExt = Math.min(nMnO2, (moles.H_aq || 0) / (rxn.reactants.H_aq || 2));
    if (rxn.reactants.H2O2_aq) minExt = Math.min(minExt, moles.H2O2_aq || 0);
    if (rxn.reactants.Fe2_aq) minExt = Math.min(minExt, (moles.Fe2_aq || 0) / 2);
    if (minExt <= 1e-10) return 0;
    return minExt * getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0) * Math.min(2.5, cH * 0.8) * iceMob;
  }

  if (rxn.type === 'metal_h2so4_redox') {
    // Unified Sulfuric Acid Concentration-Tier Metal Solver runs in stepMetalSulfuricSolver()
    return 0;
  }

  if (rxn.type === 'metal_nonox_acid') {
    if (!hasWater || iceMob <= 0) return 0;
    if (hasNitrateOxidizingEnv(moles, liquidVolL)) return 0;
    const sulf = computeSulfuricAcidState(moles);
    const solidId = rxn.solidId || 'Fe_s';
    if (sulf.tier === 'conc' || sulf.tier === 'conc_98') {
      return 0; // Handled cleanly by stepMetalSulfuricSolver (Fe passivated cold / SO2 hot; Zn -> SO2)
    }
    const midBlend = sulf.tier === 'mid' ? Math.max(0.12, 1 - (sulf.w - 0.20) / 0.45) : 1.0;
    const nSolid = moles[solidId] || 0;
    const nH = moles.H_aq || 0;
    if (nSolid <= 1e-10 || nH <= 1e-10) return 0;
    const cH = nH / liquidVolL;
    if (cH < 0.015) return 0;
    const pCount = vessel.particleCounts?.[solidId] ?? 4;
    const isFine = Boolean(vessel.groundPowderMap?.[solidId]) || pCount >= 18;
    const area = computeSolidSurfaceAreaM2(solidId, nSolid, isFine ? Math.max(pCount, 65) : pCount);
    const fineBoost = isFine ? 2.4 : 1.0;
    const kEff = getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0);
    return kEff * area * fineBoost * Math.min(8.0, cH) * 2.8 * iceMob * midBlend;
  }

  if (rxn.type === 'metal_hno3_redox') {
    // Unified 4-step Nitrate Redox Solver runs once per vessel in stepMetalNitrateSolver()
    return 0;
  }

  if (rxn.type === 'metal_displacement') {
    if (!hasWater || iceMob <= 0) return 0;
    const solidId = rxn.solidId || 'Fe_s';
    const aqId = rxn.aqueousId || 'Cu2_aq';
    const nSolid = moles[solidId] || 0;
    const nAq = moles[aqId] || 0;
    if (nSolid <= 1e-10 || nAq <= 1e-10) return 0;
    if (solidId === 'Fe_s' && (moles.NO3_aq || 0) / liquidVolL >= 8.5 && T < 318.15) return 0;
    const cAq = nAq / liquidVolL;
    const pCount = vessel.particleCounts?.[solidId] ?? 4;
    const isFine = Boolean(vessel.groundPowderMap?.[solidId]) || pCount >= 18;
    const area = computeSolidSurfaceAreaM2(solidId, nSolid, isFine ? Math.max(pCount, 60) : pCount);
    const fineBoost = isFine ? 2.2 : 1.0;
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ || 25000, T);
    return k * area * fineBoost * Math.min(4.5, cAq * 4.0) * stirBoost * iceMob * 32.0;
  }

  if (rxn.type === 'moist_precipitate_air_ox') {
    if (!hasWater || iceMob <= 0) return 0;
    const nFeOH2 = moles.FeOH2_s || 0;
    if (nFeOH2 <= 1e-10) return 0;
    const pO2 = getVesselEffectiveO2Bar(vessel, options.environment);
    if (pO2 <= 0.015) return 0;
    const o2Drive = Math.min(3.5, pO2 / CONSTANTS.AIR_O2_FRAC);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ || 22000, T);
    return (nFeOH2 / 4) * k * o2Drive * (vessel.stirTimer > 0 ? 2.4 : 1.0) * iceMob;
  }

  return 0;
}

/**
 * Crystallization of dissolved salts when solution becomes supersaturated
 * (e.g., during boiling/evaporation, ethanol salting-out, or cryo-cooling).
 */
function applySupersaturationCrystallization(vessel, dt, activeReactions = null) {
  const moles = vessel.moles;
  const nH2O = moles.H2O_l || 0;
  const iceMob = computeIceMobilityFactor(vessel);
  if (nH2O <= 1e-7 || vessel.isFrozenSolid || iceMob <= 0) return 0;

  const waterMassKg = (nH2O * SPECIES.H2O_l.molarMass) / 1000;
  const etohMassKg = ((moles.C2H5OH_l || 0) * SPECIES.C2H5OH_l.molarMass) / 1000;
  const T = vessel.tempK;

  let heatJ = 0;

  // 1. CuSO4 crystallization (lowest solubility ~1.43 -> 0.89 mol/kg at 0 C):
  // Forms pentahydrate CuSO4·5H2O below 110 C, anhydrous white CuSO4 above 110 C; salted out by Ethanol.
  // Models metastable supersaturation zone (1.03 < S < 2.45): stays liquid until seeded, stirred, or mechanically shocked!
  const nCuPair = Math.min(moles.Cu2_aq || 0, moles.SO4_2_aq || 0);
  vessel.isSupersaturated = false;
  vessel.supersatRatio = 1.0;
  if (nCuPair > 1e-11) {
    const totalSolvKg = waterMassKg + etohMassKg;
    const etohWtFrac = totalSolvKg > 1e-9 ? etohMassKg / totalSolvKg : 0;
    const saltingFactor = etohWtFrac > 0.05 ? Math.exp(-4.8 * etohWtFrac) : 1.0;
    const maxSolCu =
      waterMassKg > 1e-8
        ? 1.43 * saltingFactor * Math.exp(0.019 * (T - CONSTANTS.T_STD_K)) * waterMassKg
        : 0;
    const satRatio = maxSolCu > 1e-11 ? nCuPair / maxSolCu : 999;
    vessel.supersatRatio = satRatio;
    if (nCuPair > maxSolCu) {
      const hasSeed = (moles.CuSO4_5H2O_s || 0) > 1e-7 || (moles.CuSO4_s || 0) > 1e-7;
      const isDisturbed = (vessel.stirTimer || 0) > 0 || (vessel.magStirRpm || 0) > 0 || Boolean(vessel.crystallizeTriggered);
      const exceedsLabileLimit = satRatio >= 2.02 || etohWtFrac > 0.05 || waterMassKg < 0.01 || T >= 383.15;
      const canNucleate = hasSeed || isDisturbed || exceedsLabileLimit;
      if (!canNucleate) {
        vessel.isSupersaturated = satRatio > 1.04;
      } else {
        const excess = nCuPair - maxSolCu;
        const rateScale = (hasSeed || isDisturbed ? 12.0 : waterMassKg < 0.01 ? 10.0 : 5.0) * iceMob;
        let dXi = Math.min(excess, excess * Math.min(1, rateScale * dt));
        if (T < 383.15) {
          dXi = Math.min(dXi, (moles.H2O_l || 0) / 5.001);
          if (dXi > 1e-12) {
            moles.Cu2_aq -= dXi;
            moles.SO4_2_aq -= dXi;
            moles.H2O_l -= 5 * dXi;
            if (moles.Cu2_aq < 1e-13) delete moles.Cu2_aq;
            if (moles.SO4_2_aq < 1e-13) delete moles.SO4_2_aq;
            if (moles.H2O_l < 1e-13) delete moles.H2O_l;
            moles.CuSO4_5H2O_s = (moles.CuSO4_5H2O_s || 0) + dXi;
            heatJ += 11700 * dXi;
            if (activeReactions && dXi / Math.max(1e-4, dt) > 1e-4) {
              activeReactions.push({
                id: 'crystallize_cuso4_5h2o',
                equation: 'Cu²⁺(aq) + SO₄²⁻(aq) + 5H₂O(l) → CuSO₄·5H₂O(s)↓ + Q',
                nameVi: 'Kết tinh tỏa nhiệt Copper(II) sulfate pentahydrate',
                nameEn: 'Exothermic crystallization of Copper(II) sulfate pentahydrate',
                descVi: 'Dung dịch quá bão hòa khi có mầm tinh thể hoặc khuấy kích thích kết tinh ồ ạt tỏa nhiệt.',
                descEn: 'Triggered supersaturated solution rapidly precipitates blue CuSO₄·5H₂O crystals while releasing heat of crystallization.',
                rateMolS: dXi / Math.max(1e-4, dt),
                vigorousGas: false,
                dXi,
              });
            }
          }
        } else if (dXi > 1e-12) {
          moles.Cu2_aq -= dXi;
          moles.SO4_2_aq -= dXi;
          if (moles.Cu2_aq < 1e-13) delete moles.Cu2_aq;
          if (moles.SO4_2_aq < 1e-13) delete moles.SO4_2_aq;
          moles.CuSO4_s = (moles.CuSO4_s || 0) + dXi;
          heatJ += -66500 * dXi;
        }
      }
    } else {
      vessel.crystallizeTriggered = false;
    }
  } else {
    vessel.crystallizeTriggered = false;
  }

  // 2. Remaining soluble salts ordered from least soluble to most soluble
  const crystallizePairs = [
    { cat: 'Ca2_aq', cCat: 1, an: 'OH_aq', cAn: 2, solid: 'CaOH2_s', formula: 'Ca(OH)₂', sol298: 0.0235, coeff: -0.0075, etohRel: 0.01, crystHeatJ: 16200 },
    { cat: 'Ba2_aq', cCat: 1, an: 'OH_aq', cAn: 2, solid: 'BaOH2_s', formula: 'Ba(OH)₂', sol298: 0.24, coeff: 0.028, etohRel: 0.01, crystHeatJ: 51800 },
    { cat: 'Ba2_aq', cCat: 1, an: 'NO3_aq', cAn: 2, solid: 'BaNO3_2_s', formula: 'Ba(NO₃)₂', sol298: 0.39, coeff: 0.022, etohRel: 0.01, crystHeatJ: -40200 },
    { cat: 'Ba2_aq', cCat: 1, an: 'Cl_aq', cAn: 2, solid: 'BaCl2_s', formula: 'BaCl₂', sol298: 1.79, coeff: 0.011, etohRel: 0.01, crystHeatJ: -8800 },
    { cat: 'Fe2_aq', cCat: 1, an: 'SO4_2_aq', cAn: 1, solid: 'FeSO4_s', formula: 'FeSO₄', sol298: 1.9, coeff: 0.015, etohRel: 0.02, crystHeatJ: 8000 },
    { cat: 'Fe3_aq', cCat: 1, an: 'NO3_aq', cAn: 3, solid: 'FeNO3_3_s', formula: 'Fe(NO₃)₃', sol298: 3.5, coeff: 0.018, etohRel: 0.04, crystHeatJ: 8000 },
    { cat: 'Fe2_aq', cCat: 1, an: 'NO3_aq', cAn: 2, solid: 'FeNO3_2_s', formula: 'Fe(NO₃)₂', sol298: 3.8, coeff: 0.016, etohRel: 0.04, crystHeatJ: 8000 },
    { cat: 'Fe2_aq', cCat: 1, an: 'Cl_aq', cAn: 2, solid: 'FeCl2_s', formula: 'FeCl₂', sol298: 5.1, coeff: 0.012, etohRel: 0.25, crystHeatJ: 8000 },
    { cat: 'Fe3_aq', cCat: 1, an: 'Cl_aq', cAn: 3, solid: 'FeCl3_s', formula: 'FeCl₃', sol298: 5.6, coeff: 0.014, etohRel: 0.30, crystHeatJ: 8000 },
    { cat: 'K_aq', cCat: 1, an: 'HCO3_aq', cAn: 1, solid: 'KHCO3_s', formula: 'KHCO₃', sol298: 3.3, coeff: 0.015, etohRel: 0.01, crystHeatJ: -21000 },
    { cat: 'K_aq', cCat: 1, an: 'HSO4_aq', cAn: 1, solid: 'KHSO4_s', formula: 'KHSO₄', sol298: 3.6, coeff: 0.024, etohRel: 0.01, crystHeatJ: -4500 },
    { cat: 'K_aq', cCat: 2, an: 'SO4_2_aq', cAn: 1, solid: 'K2SO4_s', formula: 'K₂SO₄', sol298: 0.69, coeff: 0.012, etohRel: 0.01, crystHeatJ: -23800 },
    { cat: 'K_aq', cCat: 1, an: 'NO3_aq', cAn: 1, solid: 'KNO3_s', formula: 'KNO₃', sol298: 3.75, coeff: 0.029, etohRel: 0.02, crystHeatJ: -34900 },
    { cat: 'K_aq', cCat: 1, an: 'Cl_aq', cAn: 1, solid: 'KCl_s', formula: 'KCl', sol298: 4.8, coeff: 0.008, etohRel: 0.01, crystHeatJ: -17200 },
    { cat: 'K_aq', cCat: 2, an: 'CO3_2_aq', cAn: 1, solid: 'K2CO3_s', formula: 'K₂CO₃', sol298: 8.1, coeff: 0.006, etohRel: 0.01, crystHeatJ: 30900 },
    { cat: 'K_aq', cCat: 1, an: 'OH_aq', cAn: 1, solid: 'KOH_s', formula: 'KOH', sol298: 21.5, coeff: 0.020, etohRel: 0.14, crystHeatJ: 57600 },
    { cat: 'K_aq', cCat: 1, an: 'MnO4_aq', cAn: 1, solid: 'KMnO4_s', formula: 'KMnO₄', sol298: 0.475, coeff: 0.032, etohRel: 0.02, crystHeatJ: -43600 },
    { cat: 'K_aq', cCat: 2, an: 'Cr2O7_2_aq', cAn: 1, solid: 'K2Cr2O7_s', formula: 'K₂Cr₂O₇', sol298: 0.495, coeff: 0.026, etohRel: 0.002, crystHeatJ: -67000 },
    { cat: 'K_aq', cCat: 2, an: 'CrO4_2_aq', cAn: 1, solid: 'K2CrO4_s', formula: 'K₂CrO₄', sol298: 3.3, coeff: 0.005, etohRel: 0.005, crystHeatJ: -18000 },
    { cat: 'Na_aq', cCat: 2, an: 'Cr2O7_2_aq', cAn: 1, solid: 'Na2Cr2O7_s', formula: 'Na₂Cr₂O₇', sol298: 6.9, coeff: 0.012, etohRel: 0.02, crystHeatJ: -24000 },
    { cat: 'Na_aq', cCat: 2, an: 'CrO4_2_aq', cAn: 1, solid: 'Na2CrO4_s', formula: 'Na₂CrO₄', sol298: 5.2, coeff: 0.008, etohRel: 0.01, crystHeatJ: -15000 },
    { cat: 'K_aq', cCat: 2, an: 'MnO4_2_aq', cAn: 1, solid: 'K2MnO4_s', formula: 'K₂MnO₄', sol298: 1.85, coeff: 0.015, etohRel: 0.01, crystHeatJ: -18000 },
    { cat: 'K_aq', cCat: 1, an: 'IO3_aq', cAn: 1, solid: 'KIO3_s', formula: 'KIO₃', sol298: 0.38, coeff: 0.024, etohRel: 0.01, crystHeatJ: -27700 },
    { cat: 'K_aq', cCat: 1, an: 'BrO3_aq', cAn: 1, solid: 'KBrO3_s', formula: 'KBrO₃', sol298: 0.42, coeff: 0.032, etohRel: 0.01, crystHeatJ: -41100 },
    { cat: 'K_aq', cCat: 1, an: 'ClO3_aq', cAn: 1, solid: 'KClO3_s', formula: 'KClO₃', sol298: 0.60, coeff: 0.045, etohRel: 0.01, crystHeatJ: -41400 },
    { cat: 'Na_aq', cCat: 1, an: 'BrO3_aq', cAn: 1, solid: 'NaBrO3_s', formula: 'NaBrO₃', sol298: 2.4, coeff: 0.028, etohRel: 0.01, crystHeatJ: -26900 },
    { cat: 'K_aq', cCat: 1, an: 'Br_aq', cAn: 1, solid: 'KBr_s', formula: 'KBr', sol298: 5.65, coeff: 0.018, etohRel: 0.02, crystHeatJ: -19900 },
    { cat: 'K_aq', cCat: 1, an: 'I_aq', cAn: 1, solid: 'KI_s', formula: 'KI', sol298: 8.95, coeff: 0.0059, etohRel: 0.015, crystHeatJ: -20300 },
    { cat: 'Na_aq', cCat: 1, an: 'Br_aq', cAn: 1, solid: 'NaBr_s', formula: 'NaBr', sol298: 8.8, coeff: 0.015, etohRel: 0.02, crystHeatJ: 600 },
    { cat: 'Na_aq', cCat: 1, an: 'I_aq', cAn: 1, solid: 'NaI_s', formula: 'NaI', sol298: 11.9, coeff: 0.022, etohRel: 0.05, crystHeatJ: 7500 },
    { cat: 'Mn2_aq', cCat: 1, an: 'Cl_aq', cAn: 2, solid: 'MnCl2_s', formula: 'MnCl₂', sol298: 6.1, coeff: 0.012, etohRel: 0.15, crystHeatJ: 67000 },
    { cat: 'Mn2_aq', cCat: 1, an: 'SO4_2_aq', cAn: 1, solid: 'MnSO4_s', formula: 'MnSO₄', sol298: 4.1, coeff: 0.002, etohRel: 0.01, crystHeatJ: 58000 },
    { cat: 'Mg2_aq', cCat: 1, an: 'SO4_2_aq', cAn: 1, solid: 'MgSO4_s', formula: 'MgSO₄', sol298: 2.95, coeff: 0.012, etohRel: 0.02, crystHeatJ: 12000 },
    { cat: 'Mg2_aq', cCat: 1, an: 'Cl_aq', cAn: 2, solid: 'MgCl2_s', formula: 'MgCl₂', sol298: 5.7, coeff: 0.009, etohRel: 0.15, crystHeatJ: 15500 },
    { cat: 'Mg2_aq', cCat: 1, an: 'NO3_aq', cAn: 2, solid: 'MgNO3_2_s', formula: 'Mg(NO₃)₂', sol298: 4.8, coeff: 0.014, etohRel: 0.05, crystHeatJ: 6000 },
    { cat: 'Al3_aq', cCat: 2, an: 'SO4_2_aq', cAn: 3, solid: 'Al2SO4_3_s', formula: 'Al₂(SO₄)₃', sol298: 1.1, coeff: 0.016, etohRel: 0.01, crystHeatJ: 18000 },
    { cat: 'Al3_aq', cCat: 1, an: 'Cl_aq', cAn: 3, solid: 'AlCl3_s', formula: 'AlCl₃', sol298: 3.4, coeff: 0.009, etohRel: 0.15, crystHeatJ: 32500 },
    { cat: 'Al3_aq', cCat: 1, an: 'NO3_aq', cAn: 3, solid: 'AlNO3_3_s', formula: 'Al(NO₃)₃', sol298: 3.1, coeff: 0.015, etohRel: 0.05, crystHeatJ: 10000 },
    { cat: 'Na_aq', cCat: 1, an: 'HCO3_aq', cAn: 1, solid: 'NaHCO3_s', formula: 'NaHCO₃', sol298: 1.15, coeff: 0.016, etohRel: 0.01, crystHeatJ: -17500, useKsp: true },
    { cat: 'Na_aq', cCat: 1, an: 'HSO4_aq', cAn: 1, solid: 'NaHSO4_s', formula: 'NaHSO₄', sol298: 2.38, coeff: 0.025, etohRel: 0.02, crystHeatJ: 2400 },
    { cat: 'Na_aq', cCat: 2, an: 'SO4_2_aq', cAn: 1, solid: 'Na2SO4_s', formula: 'Na₂SO₄', sol298: 1.98, coeff: 0.032, etohRel: 0.02, crystHeatJ: 8000 },
    { cat: 'Na_aq', cCat: 2, an: 'CO3_2_aq', cAn: 1, solid: 'Na2CO3_s', formula: 'Na₂CO₃', sol298: 2.9, coeff: 0.015, etohRel: 0.01, crystHeatJ: 26700 },
    { cat: 'Zn2_aq', cCat: 1, an: 'SO4_2_aq', cAn: 1, solid: 'ZnSO4_s', formula: 'ZnSO₄', sol298: 3.57, coeff: 0.012, etohRel: 0.02, crystHeatJ: 8000 },
    { cat: 'Cu2_aq', cCat: 1, an: 'Cl_aq', cAn: 2, solid: 'CuCl2_s', formula: 'CuCl₂', sol298: 5.6, coeff: 0.010, etohRel: 0.35, crystHeatJ: 8000 },
    { cat: 'NH4_aq', cCat: 1, an: 'HSO4_aq', cAn: 1, solid: 'NH4HSO4_s', formula: 'NH₄HSO₄', sol298: 5.2, coeff: 0.018, etohRel: 0.02, crystHeatJ: 1800 },
    { cat: 'NH4_aq', cCat: 2, an: 'SO4_2_aq', cAn: 1, solid: 'NH4_2_SO4_s', formula: '(NH₄)₂SO₄', sol298: 5.7, coeff: 0.008, etohRel: 0.01, crystHeatJ: 6600 },
    { cat: 'Na_aq', cCat: 1, an: 'Cl_aq', cAn: 1, solid: 'NaCl_s', formula: 'NaCl', sol298: 6.15, coeff: 0.0014, etohRel: 0.01, crystHeatJ: 3900 },
    { cat: 'Ca2_aq', cCat: 1, an: 'Cl_aq', cAn: 2, solid: 'CaCl2_s', formula: 'CaCl₂', sol298: 7.3, coeff: 0.014, etohRel: 0.18, crystHeatJ: -81300 },
    { cat: 'NH4_aq', cCat: 1, an: 'Cl_aq', cAn: 1, solid: 'NH4Cl_s', formula: 'NH₄Cl', sol298: 7.4, coeff: 0.018, etohRel: 0.02, crystHeatJ: 14800 },
    { cat: 'Ca2_aq', cCat: 1, an: 'NO3_aq', cAn: 2, solid: 'CaNO3_2_s', formula: 'Ca(NO₃)₂', sol298: 8.6, coeff: 0.016, etohRel: 0.05, crystHeatJ: 19200 },
    { cat: 'Zn2_aq', cCat: 1, an: 'NO3_aq', cAn: 2, solid: 'ZnNO3_2_s', formula: 'Zn(NO₃)₂', sol298: 9.8, coeff: 0.015, etohRel: 0.05, crystHeatJ: 8000 },
    { cat: 'Na_aq', cCat: 1, an: 'NO3_aq', cAn: 1, solid: 'NaNO3_s', formula: 'NaNO₃', sol298: 10.8, coeff: 0.014, etohRel: 0.03, crystHeatJ: 20500 },
    { cat: 'Ag_aq', cCat: 1, an: 'NO3_aq', cAn: 1, solid: 'AgNO3_s', formula: 'AgNO₃', sol298: 15.0, coeff: 0.022, etohRel: 0.05, crystHeatJ: 22600 },
    { cat: 'NH4_aq', cCat: 1, an: 'NO3_aq', cAn: 1, solid: 'NH4NO3_s', formula: 'NH₄NO₃', sol298: 23.0, coeff: 0.028, etohRel: 0.04, crystHeatJ: 25700 },
    { cat: 'Na_aq', cCat: 1, an: 'OH_aq', cAn: 1, solid: 'NaOH_s', formula: 'NaOH', sol298: 27.5, coeff: 0.032, etohRel: 0.12, crystHeatJ: -8000 },
    { cat: 'Zn2_aq', cCat: 1, an: 'Cl_aq', cAn: 2, solid: 'ZnCl2_s', formula: 'ZnCl₂', sol298: 31.7, coeff: 0.008, etohRel: 0.25, crystHeatJ: -8000 },
  ];

  const curWaterKg = ((moles.H2O_l || 0) * SPECIES.H2O_l.molarMass) / 1000;
  for (const pair of crystallizePairs) {
    // Do not strand free H+ + SO4^2- by precipitating volatile HCl/HNO3 anions with Cu2+/Zn2+
    if ((pair.an === 'Cl_aq' || pair.an === 'NO3_aq') && (moles.H_aq || 0) > 1e-6 && (moles.SO4_2_aq || 0) > 1e-6) {
      continue;
    }
    // Prefer bisulfate crystallization (NaHSO4 / KHSO4 / NH4HSO4) over neutral sulfate while acid HSO4- predominates
    if (
      pair.an === 'SO4_2_aq' &&
      (pair.cat === 'Na_aq' || pair.cat === 'K_aq' || pair.cat === 'NH4_aq') &&
      (moles.HSO4_aq || 0) > (moles.SO4_2_aq || 0) * 0.6
    ) {
      continue;
    }
    const nPair = Math.min((moles[pair.cat] || 0) / pair.cCat, (moles[pair.an] || 0) / pair.cAn);
    if (nPair <= 1e-11) continue;
    const effectiveSolventKg = curWaterKg + (pair.etohRel || 0) * etohMassKg;
    const sTemp = pair.sol298 * Math.exp(pair.coeff * (T - CONSTANTS.T_STD_K));
    let excess = 0;
    if (pair.useKsp && effectiveSolventKg > 1e-8 && pair.cCat === 1 && pair.cAn === 1) {
      const mCat = (moles[pair.cat] || 0) / effectiveSolventKg;
      const mAn = (moles[pair.an] || 0) / effectiveSolventKg;
      const ksp = sTemp * sTemp;
      if (mCat * mAn > ksp) {
        const sumM = mCat + mAn;
        const disc = Math.max(0, sumM * sumM - 4 * (mCat * mAn - ksp));
        const dMolKg = Math.min(nPair / effectiveSolventKg, (sumM - Math.sqrt(disc)) / 2);
        excess = Math.max(0, dMolKg * effectiveSolventKg);
      }
    } else {
      const maxSol = effectiveSolventKg > 1e-8 ? sTemp * effectiveSolventKg : 0;
      if (nPair > maxSol) excess = nPair - maxSol;
    }
    if (excess > 0) {
      const rateScale = (curWaterKg < 0.01 ? 8.0 : 2.5) * iceMob;
      const dXi = Math.min(excess, excess * Math.min(1, rateScale * dt));
      if (dXi > 1e-12) {
        moles[pair.cat] -= pair.cCat * dXi;
        moles[pair.an] -= pair.cAn * dXi;
        if (moles[pair.cat] < 1e-13) delete moles[pair.cat];
        if (moles[pair.an] < 1e-13) delete moles[pair.an];
        moles[pair.solid] = (moles[pair.solid] || 0) + dXi;
        heatJ += pair.crystHeatJ * dXi;
        if (activeReactions && dXi / Math.max(1e-4, dt) > 1e-4) {
          activeReactions.push({
            id: `crystallize_${pair.solid}`,
            equation: `${SPECIES[pair.cat].formula} + ${SPECIES[pair.an].formula} → ${pair.formula}(s)↓`,
            nameVi: `Kết tinh ${SPECIES[pair.solid]?.name || pair.formula}`,
            nameEn: `Crystallization of ${SPECIES[pair.solid]?.name || pair.formula}`,
            descVi: `Muối ${pair.formula} vượt độ tan khi hạ nhiệt độ nên kết tinh ngược thành pha rắn.`,
            descEn: `${pair.formula} exceeds cold solubility and crystallizes back into solid phase.`,
            rateMolS: dXi / Math.max(1e-4, dt),
            vigorousGas: false,
            dXi,
          });
        }
      }
    }
  }

  return heatJ;
}

/**
 * Apply a single equilibrium extent dXi across stoichiometries, trim <1e-13 dust,
 * record active reaction metadata when visible, and return enthalpy (J).
 */
function applyEquilibriumShift({
  moles,
  dXi,
  deltas,
  heatPerMolJ,
  dt,
  activeReactions,
  buildMeta,
  logThresholdRate = 1e-4,
}) {
  if (Math.abs(dXi) <= 1e-13) return 0;
  for (const [spId, coeff] of Object.entries(deltas)) {
    const next = (moles[spId] || 0) + coeff * dXi;
    if (next < 1e-13) {
      delete moles[spId];
    } else {
      moles[spId] = next;
    }
  }
  const rateMolS = Math.abs(dXi) / Math.max(1e-4, dt);
  if (rateMolS > logThresholdRate && buildMeta) {
    activeReactions.push({
      ...buildMeta(dXi),
      rateMolS,
      vigorousGas: false,
      dXi: Math.abs(dXi),
    });
  }
  return heatPerMolJ * dXi;
}

/**
 * Amphoteric dissolution & dilution-reprecipitation of Cu(OH)2 and Ag2O in super-concentrated alkali (> 7 M OH-).
 */
function stepAmphotericHydroxideEquilibria(vessel, liquidVolL, dt, activeReactions) {
  if (liquidVolL <= 1e-6) return 0;
  const moles = vessel.moles;
  const cOH = (moles.OH_aq || 0) / liquidVolL;
  let heatJ = 0;

  // 1. Cu(OH)2(s) + 2OH- <-> [Cu(OH)4]2- (deep royal blue-violet)
  const nCuS = moles.CuOH2_s || 0;
  const nCuC = moles.CuOH4_2_aq || 0;
  const nCuTot = nCuS + nCuC;
  if (nCuTot > 1e-11) {
    const eqFrac = cOH > 1.0 ? Math.min(0.95, 1 / (1 + Math.pow(6.2 / cOH, 4.0))) : 0;
    const targetComp = nCuTot * eqFrac;
    let dXi = (targetComp - nCuC) * Math.min(1, 18.0 * dt);
    dXi = dXi > 0 ? Math.min(dXi, nCuS, (moles.OH_aq || 0) / 2) : Math.max(dXi, -nCuC);

    heatJ += applyEquilibriumShift({
      moles,
      dXi,
      deltas: { CuOH2_s: -1, OH_aq: -2, CuOH4_2_aq: 1 },
      heatPerMolJ: -15000,
      dt,
      activeReactions,
      buildMeta: () => ({
        id: 'amphoteric_cuoh2',
        equation: 'Cu(OH)₂(s) + 2OH⁻(đặc) ⇌ [Cu(OH)₄]²⁻(aq)',
        nameVi: 'Lưỡng tính Cu(OH)₂ tạo phức xanh thẫm [Cu(OH)₄]²⁻',
        nameEn: 'Amphoteric dissolution of Cu(OH)₂ in super-concentrated alkali',
        descVi: 'Trong kiềm siêu đặc (>8 M), Cu(OH)₂ tan thành phức [Cu(OH)₄]²⁻ xanh tím thẫm; pha loãng lại tách kết tủa.',
        descEn: 'In >8 M NaOH, Cu(OH)₂ dissolves into deep royal-blue [Cu(OH)₄]²⁻ and reprecipitates on dilution.',
      }),
    });
  }

  // 2. Ag2O(s) + 2OH- + H2O <-> 2[Ag(OH)2]- (colorless complex in >8 M NaOH)
  const nAg2O = moles.Ag2O_s || 0;
  const nAgC = moles.AgOH2_aq || 0;
  const nAgTot = 2 * nAg2O + nAgC;
  if (nAgTot > 1e-11) {
    const eqFrac = cOH > 1.5 ? Math.min(0.86, 0.86 / (1 + Math.pow(6.6 / cOH, 4.0))) : 0;
    const targetAgC = nAgTot * eqFrac;
    let dAg = (targetAgC - nAgC) * Math.min(1, 18.0 * dt);
    dAg = dAg > 0 ? Math.min(dAg, 2 * nAg2O, moles.OH_aq || 0, 2 * (moles.H2O_l || 0)) : Math.max(dAg, -nAgC);

    heatJ += applyEquilibriumShift({
      moles,
      dXi: dAg,
      deltas: { Ag2O_s: -0.5, OH_aq: -1, H2O_l: -0.5, AgOH2_aq: 1 },
      heatPerMolJ: -12000,
      dt,
      activeReactions,
      buildMeta: () => ({
        id: 'amphoteric_ag2o',
        equation: 'Ag₂O(s) + 2OH⁻(đặc) + H₂O ⇌ 2[Ag(OH)₂]⁻(aq)',
        nameVi: 'Lưỡng tính Ag₂O tan một phần trong kiềm siêu đặc',
        nameEn: 'Amphoteric dissolution of Ag₂O in super-concentrated NaOH',
        descVi: 'Ag₂O tan một phần trong NaOH siêu đặc tạo [Ag(OH)₂]⁻ không màu và tách ra khi pha loãng.',
        descEn: 'Ag₂O partially dissolves as colorless [Ag(OH)₂]⁻ in >8 M OH⁻ and reprecipitates on dilution.',
      }),
    });
  }

  return heatJ;
}

/**
 * Reversible chloro complexes: AgCl + Cl- <-> [AgCl2]- (dissolves in conc. HCl, snows back on dilution)
 * and CuCl + Cl- <-> [CuCl2]- (precipitates white CuCl on dilution below ~2.2 M Cl-).
 */
function stepChloroSilverAndCuprousEquilibria(vessel, liquidVolL, dt, activeReactions) {
  if (liquidVolL <= 1e-6) return 0;
  const moles = vessel.moles;
  const cCl = (moles.Cl_aq || 0) / liquidVolL;
  let heatJ = 0;

  // 1. AgCl(s) + Cl- <-> [AgCl2]- (significant only when [Cl-] > 3.8 M!)
  const nAgCl = moles.AgCl_s || 0;
  const nAgComp = moles.AgCl2_aq || 0;
  if (nAgCl + nAgComp > 1e-11) {
    const maxSolConc = cCl > 3.8 ? 0.16 * Math.pow((cCl - 3.8) / 7.5, 2.2) : 0;
    const targetComp = Math.min(nAgCl + nAgComp, maxSolConc * liquidVolL);
    let dXi = (targetComp - nAgComp) * Math.min(1, 20.0 * dt);
    dXi = dXi > 0 ? Math.min(dXi, nAgCl, moles.Cl_aq || 0) : Math.max(dXi, -nAgComp);

    heatJ += applyEquilibriumShift({
      moles,
      dXi,
      deltas: { AgCl_s: -1, Cl_aq: -1, AgCl2_aq: 1 },
      heatPerMolJ: -18000,
      dt,
      activeReactions,
      logThresholdRate: 5e-5,
      buildMeta: (shift) => ({
        id: 'agcl_chloro_complex',
        equation: 'AgCl(s) + Cl⁻(đặc) ⇌ [AgCl₂]⁻(aq)',
        nameVi: shift > 0 ? 'Hòa tan AgCl trong HCl đậm đặc' : 'Tái kết tủa AgCl khi pha loãng',
        nameEn: shift > 0 ? 'AgCl dissolution in concentrated HCl' : 'AgCl reprecipitation upon dilution',
        descVi: 'Nồng độ Cl⁻ cực cao hòa tan AgCl thành [AgCl₂]⁻ trong suốt; thêm nước làm kết tủa trắng tái sinh.',
        descEn: 'Concentrated Cl⁻ solubilizes AgCl as [AgCl₂]⁻; diluting with water immediately reprecipitates AgCl(s).',
      }),
    });
  }

  // 2. CuCl(s) + Cl- <-> [CuCl2]- (precipitates white CuCl when [Cl-] drops < 2.5 M)
  const nCuCl = moles.CuCl_s || 0;
  const nCuComp = moles.CuCl2_comp_aq || 0;
  if (nCuCl + nCuComp > 1e-11) {
    const maxCuCl2Conc = cCl > 2.4 ? 1.1 * Math.pow((cCl - 2.4) / 6.0, 1.8) : 0;
    const targetComp = Math.min(nCuCl + nCuComp, maxCuCl2Conc * liquidVolL);
    let dXi = (targetComp - nCuComp) * Math.min(1, 20.0 * dt);
    dXi = dXi > 0 ? Math.min(dXi, nCuCl, moles.Cl_aq || 0) : Math.max(dXi, -nCuComp);

    heatJ += applyEquilibriumShift({
      moles,
      dXi,
      deltas: { CuCl_s: -1, Cl_aq: -1, CuCl2_comp_aq: 1 },
      heatPerMolJ: -16000,
      dt,
      activeReactions,
      logThresholdRate: 5e-5,
      buildMeta: (shift) => ({
        id: 'cucl_dilution_precipitate',
        equation: '[CuCl₂]⁻(aq) ⇌ CuCl(s)↓ + Cl⁻(aq)',
        nameVi: shift < 0 ? 'Tách kết tủa trắng CuCl khi pha loãng' : 'Hòa tan CuCl trong HCl đặc',
        nameEn: shift < 0 ? 'Precipitation of white CuCl(s) upon dilution' : 'Dissolution of CuCl in conc. HCl',
        descVi: 'Pha loãng dung dịch [CuCl₂]⁻ vào lượng nước lớn làm tách ra kết tủa trắng tinh khiết Đồng(I) chloride (CuCl).',
        descEn: 'Diluting [CuCl₂]⁻ lowers [Cl⁻] and precipitates pure white Copper(I) chloride (CuCl).',
      }),
    });
  }

  return heatJ;
}

/**
 * Dry chemisorption of headspace HCl(g) onto anhydrous CuSO4(s) -> golden-brown CuSO4·2HCl(s),
 * plus osmotic chemical garden nucleation state tracking.
 */
function stepChemisorptionAndGarden(vessel, liquidVolL, dt, activeReactions) {
  const moles = vessel.moles;
  let heatJ = 0;

  // Chemisorption from vessel headspace when dry
  const nHeadHCl = vessel.headspaceGasMoles?.HCl_g || 0;
  if (nHeadHCl > 1e-9 && (moles.CuSO4_s || 0) > 1e-8 && (moles.H2O_l || 0) < 0.025 && vessel.tempK < 405) {
    const dAdduct = Math.min(moles.CuSO4_s, nHeadHCl / 2, Math.max(1e-6, moles.CuSO4_s * 3.0 * dt));
    if (dAdduct > 1e-13) {
      moles.CuSO4_s -= dAdduct;
      if (moles.CuSO4_s < 1e-13) delete moles.CuSO4_s;
      vessel.headspaceGasMoles.HCl_g = Math.max(0, nHeadHCl - 2 * dAdduct);
      moles.CuSO4_2HCl_s = (moles.CuSO4_2HCl_s || 0) + dAdduct;
      heatJ += 68000 * dAdduct;
      activeReactions.push({
        id: 'cuso4_hcl_chemisorption',
        equation: 'CuSO₄(s) + 2HCl(g) ⇌ CuSO₄·2HCl(s)',
        nameVi: 'Hấp phụ hóa học HCl khô tạo CuSO₄·2HCl nâu vàng',
        nameEn: 'Dry HCl chemisorption forming golden-brown CuSO₄·2HCl',
        descVi: 'Bột CuSO₄ khan trắng hấp phụ khí HCl khô tạo phức CuSO₄·2HCl màu vàng nâu.',
        descEn: 'White anhydrous CuSO₄ chemisorbs dry HCl(g) into a golden-brown adduct.',
        rateMolS: dAdduct / Math.max(1e-4, dt),
        vigorousGas: false,
        dXi: dAdduct,
      });
    }
  }

  // Osmotic Chemical Garden detection: coarse CuSO4·5H2O crystal in conc. NaOH (>=2.5 M) OR coarse NaOH pellet in conc. Cu2+ (>=0.4 M)
  if (liquidVolL > 1e-4) {
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    const cCu = (moles.Cu2_aq || 0) / liquidVolL;
    const hasCoarseCuCrystal = (moles.CuSO4_5H2O_s || 0) > 1e-3 && (vessel.particleCounts?.CuSO4_5H2O_s ?? 6) <= 10;
    const hasCoarseNaOHPellet = (moles.NaOH_s || 0) > 2e-3 && (vessel.particleCounts?.NaOH_s ?? 6) <= 10;
    if (!vessel.stirTimer && ((hasCoarseCuCrystal && cOH >= 2.5) || (hasCoarseNaOHPellet && cCu >= 0.35))) {
      vessel.gardenActive = true;
      vessel.gardenGrowth = Math.min(1.0, (vessel.gardenGrowth || 0.05) + dt * 0.22);
      // Gradually convert small interface into hollow Cu(OH)2 tubular spire membrane
      const membraneRate = Math.min(0.002, ((hasCoarseCuCrystal ? moles.CuSO4_5H2O_s : moles.NaOH_s) || 0) * 0.08 * dt);
      if (hasCoarseCuCrystal && (moles.OH_aq || 0) >= 2 * membraneRate && membraneRate > 1e-9) {
        moles.CuSO4_5H2O_s -= membraneRate;
        moles.OH_aq -= 2 * membraneRate;
        moles.CuOH2_s = (moles.CuOH2_s || 0) + membraneRate;
        moles.SO4_2_aq = (moles.SO4_2_aq || 0) + membraneRate;
        moles.H2O_l = (moles.H2O_l || 0) + 5 * membraneRate;
        heatJ += 18000 * membraneRate;
        activeReactions.push({
          id: 'osmotic_chemical_garden',
          equation: 'CuSO₄·5H₂O(s) + 2OH⁻(aq) → Cu(OH)₂(màng ống thẩm thấu) + SO₄²⁻ + 5H₂O',
          nameVi: 'Vườn hóa học thẩm thấu Cu(OH)₂ (ống san hô rỗng)',
          nameEn: 'Osmotic Chemical Garden: hollow Cu(OH)₂ coral tubules',
          descVi: 'Áp suất thẩm thấu làm trương vỡ màng bán thấm Cu(OH)₂, đẩy dòng muối phun lên tạo các ống san hô xanh lam rỗng.',
          descEn: 'Osmotic rupture of the Cu(OH)₂ semipermeable membrane grows hollow vertical blue coral tubules.',
          rateMolS: membraneRate / Math.max(1e-4, dt),
          vigorousGas: false,
          dXi: membraneRate,
        });
      }
    } else if (vessel.stirTimer > 0) {
      vessel.gardenActive = false;
      vessel.gardenGrowth = Math.max(0, (vessel.gardenGrowth || 0) - dt * 1.5);
    }
  } else if (!vessel.isFrozenSolid) {
    vessel.gardenActive = false;
    vessel.gardenGrowth = 0;
  }

  return heatJ;
}

/**
 * Reversible Cu2+ + 4Cl- <-> [CuCl4]2- complexation (turns blue -> emerald/yellow-green in conc. Cl-).
 */
function stepChlorocuprateEquilibrium(vessel, liquidVolL, dt, activeReactions) {
  if (liquidVolL <= 1e-6) return 0;
  const moles = vessel.moles;
  const nCuFree = moles.Cu2_aq || 0;
  const nComp = moles.CuCl4_2_aq || 0;
  const nCuTot = nCuFree + nComp;
  if (nCuTot <= 1e-11) return 0;

  const cCl = (moles.Cl_aq || 0) / liquidVolL;
  const nClTot = (moles.Cl_aq || 0) + 4 * nComp;
  const maxStoichFrac = Math.min(0.94, nClTot / (4 * nCuTot));
  const kT = Math.exp(Math.max(-2, Math.min(2, 0.018 * (vessel.tempK - CONSTANTS.T_STD_K))));
  const ratio = Math.max(0, cCl / 3.0);
  const eqFrac = Math.min(maxStoichFrac, (Math.pow(ratio, 2.2) * kT) / (1 + Math.pow(ratio, 2.2) * kT));
  const targetComp = nCuTot * eqFrac;
  let dXi = (targetComp - nComp) * Math.min(1, 18.0 * dt);
  dXi = dXi > 0 ? Math.min(dXi, nCuFree, (moles.Cl_aq || 0) / 4) : Math.max(dXi, -nComp);
  if (Math.abs(dXi) <= 1e-14) return 0;

  // Forward complexation is slightly endothermic (+18 kJ/mol -> absorbs heat)
  return applyEquilibriumShift({
    moles,
    dXi,
    deltas: { Cu2_aq: -1, Cl_aq: -4, CuCl4_2_aq: 1 },
    heatPerMolJ: -18000,
    dt,
    activeReactions,
    buildMeta: () => ({
      id: 'cu_chloride_complex',
      equation: 'Cu²⁺(aq) + 4Cl⁻(aq) ⇌ [CuCl₄]²⁻(aq)',
      nameVi: 'Tạo phức Tetrachlorocuprate(II)',
      nameEn: 'Tetrachlorocuprate(II) complexation',
      descVi: 'Ion Cu²⁺ kết hợp với Cl⁻ nồng độ cao tạo phức [CuCl₄]²⁻ màu xanh lục vàng.',
      descEn: 'High [Cl⁻] coordinates with Cu²⁺ to form emerald/yellow-green [CuCl₄]²⁻.',
    }),
  });
}

/**
 * Reversible Ammonia coordination equilibria:
 * - Cu(OH)2(s) + 4NH3(aq) <-> [Cu(NH3)4]2+(aq) + 2OH-(aq) (deep royal violet-blue)
 * - AgCl(s) + 2NH3(aq) <-> [Ag(NH3)2]+(aq) + Cl-(aq)
 * - Ag2O(s) + 4NH3(aq) + H2O(l) <-> 2[Ag(NH3)2]+(aq) + 2OH-(aq)
 */
/**
 * Halogen (Cl2 / Br2 / I2) phase dissolution, triiodide complexation, halide displacement,
 * temperature-dependent alkali disproportionation, water-catalyzed Al+I2 ignition & H2 + Br2/I2 synthesis.
 */
function stepHalogenRedoxAndAlkali(vessel, liquidVolL, dt, activeReactions, gasProduced, strat, iceMob = 1) {
  if (!vessel?.moles || dt <= 0) return 0;
  const moles = vessel.moles;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  let heatJ = 0;

  const consumeGas = (gId, dMol) => {
    const cur = vessel.headspaceGasMoles?.[gId] || 0;
    const take = Math.min(cur, dMol);
    if (take > 1e-13 && vessel.headspaceGasMoles) {
      vessel.headspaceGasMoles[gId] = Math.max(0, cur - take);
      if (vessel.headspaceGasMoles[gId] < 1e-13) vessel.headspaceGasMoles[gId] = 0;
    }
    return take;
  };
  const emitGas = (gId, dMol) => {
    if (dMol > 1e-13 && gasProduced) {
      gasProduced[gId] = (gasProduced[gId] || 0) + dMol;
    }
  };

  // 1. Classic Al + I2 catalyzed by a drop of H2O (or dry heat >= 120 C; self-sustaining once ignited)
  const nAl = moles.Al_s || 0;
  const nI2s = moles.I2_s || 0;
  const nH2O = moles.H2O_l || 0;
  if (nAl > 1e-8 && nI2s > 1e-8 && (nH2O >= 1e-5 || (vessel.alCombustionTimer || 0) > 0 || T >= 393.15)) {
    const excessAq = nH2O >= 0.08;
    const kCat = T >= 393.15 || (vessel.alCombustionTimer || 0) > 0 ? 3.8 : Math.min(4.5, 1.8 + 25.0 * Math.min(0.15, nH2O));
    const dAlI2 = Math.min(nAl / 2, nI2s / 3) * (1 - Math.exp(-kCat * dt));
    if (dAlI2 > 1e-11) {
      heatJ += applyEquilibriumShift({
        moles,
        dXi: dAlI2,
        deltas: excessAq
          ? { Al_s: -2, I2_s: -3, Al3_aq: 2, I_aq: 6 }
          : { Al_s: -2, I2_s: -3, AlI3_s: 2 },
        heatPerMolJ: 628000,
        dt,
        activeReactions,
        logThresholdRate: 1e-6,
        buildMeta: () => ({
          id: 'al_i2_water_cat',
          equation: '2Al(s) + 3I₂(s) —(H₂O)→ 2AlI₃(s) + hơi tím I₂↑',
          nameVi: 'Phản ứng mãnh liệt Aluminium + Iodine có nước xúc tác',
          nameEn: 'Water-catalyzed exothermic ignition of Aluminium and Iodine',
          descVi: 'Chỉ một giọt nước làm mồi cho phản ứng 2Al + 3I₂ tỏa nhiệt rất mạnh, phát sáng và thăng hoa khói tím I₂ dày đặc.',
          descEn: 'A trace drop of water catalyzes vigorous exothermic 2Al + 3I₂ → 2AlI₃, erupting in violet I₂ vapor plumes.',
        }),
      });
      vessel.alCombustionTimer = 1.6;
      const remI2Burst = moles.I2_s || 0;
      const dSublFlare = Math.min(remI2Burst, dAlI2 * 0.45);
      if (dSublFlare > 1e-11) {
        moles.I2_s = remI2Burst - dSublFlare;
        if (moles.I2_s < 1e-13) delete moles.I2_s;
        emitGas('I2_g', dSublFlare);
      }
    }
  }

  // 2. Direct Metal + Br2(l/aq) and Metal + I2(s) redox (table-driven)
  const nBr2Avail = (moles.Br2_l || 0) + (moles.Br2_aq || 0);
  if (nBr2Avail > 1e-9) {
    const brSrcKey = (moles.Br2_l || 0) >= (moles.Br2_aq || 0) ? 'Br2_l' : 'Br2_aq';
    const nBrSrc = moles[brSrcKey] || 0;
    const isAqBulk = nH2O >= 0.03;
    const brMetals = [
      { id: 'K', sId: 'K_s', cM: 2, cHal: 1, minK: 250, rate: 8.5, prodS: 'KBr_s', prodC: 2, ionId: 'K_aq', z: 1, heatJ: 787000, timerKey: 'kDryBurnTimer', eq: '2K + Br₂ → 2KBr', nameVi: 'Potassium phản ứng mãnh liệt với Bromine tạo KBr', nameEn: 'Vigorous Potassium + Bromine reaction forming KBr' },
      { id: 'Na', sId: 'Na_s', cM: 2, cHal: 1, minK: 260, rate: 6.5, prodS: 'NaBr_s', prodC: 2, ionId: 'Na_aq', z: 1, heatJ: 722000, timerKey: 'naDryBurnTimer', eq: '2Na + Br₂ → 2NaBr', nameVi: 'Sodium phản ứng mạnh với Bromine tạo NaBr', nameEn: 'Vigorous Sodium + Bromine reaction forming NaBr' },
      { id: 'Al', sId: 'Al_s', cM: 2, cHal: 3, minK: 280, rate: 3.4, prodS: 'AlBr3_s', prodC: 2, ionId: 'Al3_aq', z: 3, heatJ: 1022000, timerKey: 'alCombustionTimer', eq: '2Al + 3Br₂ → 2AlBr₃', nameVi: 'Aluminium cháy sáng trong Bromine lỏng tạo AlBr₃', nameEn: 'Exothermic Aluminium + Bromine reaction forming AlBr₃' },
      { id: 'Mg', sId: 'Mg_s', cM: 1, cHal: 1, minK: 285, rate: 1.6, prodS: 'MgBr2_s', prodC: 1, ionId: 'Mg2_aq', z: 2, heatJ: 524000, eq: 'Mg + Br₂ → MgBr₂', nameVi: 'Magnesium tác dụng với Bromine tạo MgBr₂', nameEn: 'Magnesium + Bromine reaction forming MgBr₂' },
      { id: 'Zn', sId: 'Zn_s', cM: 1, cHal: 1, minK: 285, rate: 1.4, prodS: 'ZnBr2_s', prodC: 1, ionId: 'Zn2_aq', z: 2, heatJ: 329000, eq: 'Zn + Br₂ → ZnBr₂', nameVi: 'Zinc tác dụng với Bromine tạo ZnBr₂', nameEn: 'Zinc + Bromine reaction forming ZnBr₂' },
      { id: 'Fe', sId: 'Fe_s', cM: 2, cHal: 3, minK: 288, rate: 0.95, prodS: 'FeBr3_s', prodC: 2, ionId: 'Fe3_aq', z: 3, heatJ: 536000, eq: '2Fe + 3Br₂ → 2FeBr₃', nameVi: 'Iron bị Bromine oxi hóa thành Iron(III) bromide (FeBr₃)', nameEn: 'Bromine oxidizes Iron to Iron(III) bromide (FeBr₃)' },
      { id: 'Cu', sId: 'Cu_s', cM: 1, cHal: 1, minK: 305, rate: 0.45, prodS: 'CuBr2_s', prodC: 1, ionId: 'Cu2_aq', z: 2, heatJ: 141800, eq: 'Cu + Br₂ → CuBr₂', nameVi: 'Copper phản ứng với Bromine tạo Copper(II) bromide', nameEn: 'Copper reacts with Bromine forming Copper(II) bromide' },
    ];
    for (const mSpec of brMetals) {
      const nM = moles[mSpec.sId] || 0;
      const curSrc = moles[brSrcKey] || 0;
      if (nM <= 1e-9 || curSrc <= 1e-9 || T < mSpec.minK) continue;
      const dXi = Math.min(nM / mSpec.cM, curSrc / mSpec.cHal) * (1 - Math.exp(-mSpec.rate * dt));
      if (dXi <= 1e-11) continue;
      const deltas = isAqBulk
        ? { [mSpec.sId]: -mSpec.cM, [brSrcKey]: -mSpec.cHal, [mSpec.ionId]: mSpec.cM, Br_aq: mSpec.cHal * 2 }
        : { [mSpec.sId]: -mSpec.cM, [brSrcKey]: -mSpec.cHal, [mSpec.prodS]: mSpec.prodC };
      heatJ += applyEquilibriumShift({
        moles,
        dXi,
        deltas,
        heatPerMolJ: mSpec.heatJ,
        dt,
        activeReactions,
        logThresholdRate: 1e-6,
        buildMeta: () => ({
          id: `metal_${mSpec.id.toLowerCase()}_br2`,
          equation: mSpec.eq,
          nameVi: mSpec.nameVi,
          nameEn: mSpec.nameEn,
          descVi: `${mSpec.nameVi} ở nhiệt độ ${Math.round(T - 273.15)} °C.`,
          descEn: `${mSpec.nameEn}.`,
        }),
      });
      if (mSpec.timerKey) vessel[mSpec.timerKey] = 1.4;
    }
  }

  const nI2Direct = (moles.I2_s || 0) + (moles.I2_aq || 0);
  if (nI2Direct > 1e-9) {
    const iSrcKey = (moles.I2_s || 0) >= (moles.I2_aq || 0) ? 'I2_s' : 'I2_aq';
    const isAqBulk = nH2O >= 0.03;
    const iMetals = [
      { id: 'K', sId: 'K_s', cM: 2, cHal: 1, minK: 308, rate: 2.8, prodS: 'KI_s', prodC: 2, ionId: 'K_aq', heatJ: 655000, eq: '2K + I₂ —(t°)→ 2KI', nameVi: 'Potassium tác dụng với Iodine tạo KI', nameEn: 'Potassium + Iodine reaction forming KI' },
      { id: 'Na', sId: 'Na_s', cM: 2, cHal: 1, minK: 323, rate: 2.0, prodS: 'NaI_s', prodC: 2, ionId: 'Na_aq', heatJ: 576000, eq: '2Na + I₂ —(t°)→ 2NaI', nameVi: 'Sodium tác dụng với Iodine khi đun tạo NaI', nameEn: 'Warmed Sodium + Iodine reaction forming NaI' },
      { id: 'Zn', sId: 'Zn_s', cM: 1, cHal: 1, minK: 320, minAqK: 285, rate: 0.9, prodS: 'ZnI2_s', prodC: 1, ionId: 'Zn2_aq', heatJ: 208000, eq: 'Zn + I₂ → ZnI₂', nameVi: 'Zinc khử Iodine tạo muối Zinc iodide (ZnI₂)', nameEn: 'Zinc + Iodine reaction forming Zinc iodide (ZnI₂)' },
      { id: 'Mg', sId: 'Mg_s', cM: 1, cHal: 1, minK: 333, minAqK: 290, rate: 0.75, prodS: 'MgI2_s', prodC: 1, ionId: 'Mg2_aq', heatJ: 364000, eq: 'Mg + I₂ → MgI₂', nameVi: 'Magnesium tác dụng với Iodine tạo MgI₂', nameEn: 'Magnesium + Iodine reaction forming MgI₂' },
      { id: 'Fe', sId: 'Fe_s', cM: 1, cHal: 1, minK: 353, minAqK: 320, rate: 0.45, prodS: 'FeI2_s', prodC: 1, ionId: 'Fe2_aq', heatJ: 113000, eq: 'Fe + I₂ —(t°)→ FeI₂', nameVi: 'Iron tác dụng Iodine chỉ tạo Iron(II) iodide (FeI₂)', nameEn: 'Iron + Iodine forms Iron(II) iodide (Fe(+2) only)' },
    ];
    for (const mSpec of iMetals) {
      const nM = moles[mSpec.sId] || 0;
      const curSrc = moles[iSrcKey] || 0;
      const threshold = isAqBulk && mSpec.minAqK ? mSpec.minAqK : mSpec.minK;
      if (nM <= 1e-9 || curSrc <= 1e-9 || T < threshold) continue;
      const dXi = Math.min(nM / mSpec.cM, curSrc / mSpec.cHal) * (1 - Math.exp(-mSpec.rate * dt));
      if (dXi <= 1e-11) continue;
      const deltas = isAqBulk
        ? { [mSpec.sId]: -mSpec.cM, [iSrcKey]: -mSpec.cHal, [mSpec.ionId]: mSpec.cM, I_aq: mSpec.cHal * 2 }
        : { [mSpec.sId]: -mSpec.cM, [iSrcKey]: -mSpec.cHal, [mSpec.prodS]: mSpec.prodC };
      heatJ += applyEquilibriumShift({
        moles,
        dXi,
        deltas,
        heatPerMolJ: mSpec.heatJ,
        dt,
        activeReactions,
        logThresholdRate: 1e-6,
        buildMeta: () => ({
          id: `metal_${mSpec.id.toLowerCase()}_i2`,
          equation: mSpec.eq,
          nameVi: mSpec.nameVi,
          nameEn: mSpec.nameEn,
          descVi: `${mSpec.nameVi}.`,
          descEn: `${mSpec.nameEn}.`,
        }),
      });
    }
  }

  // 3. Gas-phase H2 + Br2 -> 2HBr (>= 200 C) and reversible H2 + I2 <-> 2HI (>= 300 C)
  const headH2 = vessel.headspaceGasMoles?.H2_g || 0;
  const headBr2 = vessel.headspaceGasMoles?.Br2_g || 0;
  if (headH2 > 1e-9 && headBr2 > 1e-9 && T >= 473.15) {
    const dSynthBr = Math.min(headH2, headBr2) * (1 - Math.exp(-2.2 * dt));
    const takenH2 = consumeGas('H2_g', dSynthBr);
    const takenBr2 = consumeGas('Br2_g', dSynthBr);
    const dActual = Math.min(takenH2, takenBr2);
    if (dActual > 1e-11) {
      emitGas('HBr_g', 2 * dActual);
      heatJ += dActual * 103000;
      activeReactions.push({
        id: 'h2_br2_synth',
        equation: 'H₂(g) + Br₂(g) —(200–400 °C)→ 2HBr(g)',
        nameVi: 'Tổng hợp Hydrogen bromide (HBr) từ H₂ và Br₂ ở nhiệt độ cao',
        nameEn: 'High-temperature synthesis of Hydrogen bromide from H₂ and Br₂',
        descVi: 'Ở 200–400 °C, khí H₂ phản ứng thuận lợi với hơi Br₂ tạo khí không màu HBr (tan vào nước thành acid mạnh).',
        descEn: 'At 200–400 °C, H₂ reacts smoothly with Br₂ vapor yielding gaseous HBr.',
        rateMolS: dActual / dt,
        vigorousGas: false,
        dXi: dActual,
      });
    }
  }
  const headI2 = vessel.headspaceGasMoles?.I2_g || 0;
  const headHI = vessel.headspaceGasMoles?.HI_g || 0;
  if (T >= 573.15 && ((headH2 > 1e-9 && headI2 > 1e-9) || headHI > 1e-9)) {
    const KeqHI = 48.0 * Math.exp((-10400 / CONSTANTS.R_J_MOL_K) * (1 / T - 1 / 673.15));
    const totH2 = headH2 + 0.5 * headHI;
    const totI2 = headI2 + 0.5 * headHI;
    const totProd = headH2 * headI2;
    const qRatio = totProd > 1e-18 ? (headHI * headHI) / totProd : 1e9;
    if (qRatio < KeqHI && headH2 > 1e-9 && headI2 > 1e-9) {
      const targetHI = 0.5 * (totH2 + totI2 - Math.sqrt(Math.max(0, (totH2 + totI2) ** 2 - 4 * totH2 * totI2 * (1 - 4 / (KeqHI + 4))))) * 2;
      const dFwd = Math.min(headH2, headI2, Math.max(0, (targetHI - headHI) * 0.5)) * (1 - Math.exp(-1.4 * dt));
      if (dFwd > 1e-11) {
        consumeGas('H2_g', dFwd);
        consumeGas('I2_g', dFwd);
        emitGas('HI_g', 2 * dFwd);
        heatJ += dFwd * 10400;
        activeReactions.push({
          id: 'h2_i2_reversible',
          equation: 'H₂(g) + I₂(g) ⇌ 2HI(g) (thuận nghịch, ≥ 300 °C)',
          nameVi: 'Tổng hợp thuận nghịch Hydrogen iodide (HI) ở 300–450 °C',
          nameEn: 'Reversible gas-phase synthesis of Hydrogen iodide (H₂ + I₂ ⇌ 2HI)',
          descVi: 'Ở 300–450 °C, H₂ và hơi tím I₂ phản ứng thuận nghịch đạt cân bằng tạo khí HI.',
          descEn: 'At 300–450 °C, H₂ and violet I₂ vapor reach reversible equilibrium forming HI gas.',
          rateMolS: dFwd / dt,
          vigorousGas: false,
          dXi: dFwd,
        });
      }
    }
  }

  // Stop aqueous chemistry if solvent frozen or virtually absent
  const aqMl = strat?.aqueousMl || 0;
  const vAqL = aqMl / 1000;
  if (iceMob <= 0 || vAqL <= 1e-6 || nH2O + (moles.C2H5OH_l || 0) <= 1e-5) {
    return heatJ;
  }

  const etohMl = ((moles.C2H5OH_l || 0) * SPECIES.C2H5OH_l.molarMass) / SPECIES.C2H5OH_l.density;
  const wEtOH = Math.min(1, etohMl / Math.max(1e-6, aqMl));
  const tC = T - CONSTANTS.KELVIN_OFFSET;
  const relaxFast = Math.min(1, 20.0 * dt);

  // 4. Br2(l) <-> Br2(aq) solubility (~3.5 g/100 g H2O @ 20 C = 0.219 M, freely in EtOH)
  const nBr2L = moles.Br2_l || 0;
  const nBr2Aq = moles.Br2_aq || 0;
  if (nBr2L + nBr2Aq > 1e-10) {
    const cSatBr2 = 0.219 * (1 + 0.004 * Math.max(-15, Math.min(80, tC - 20))) * (1 + 14.0 * wEtOH * wEtOH);
    const targetAq = Math.min(nBr2L + nBr2Aq, cSatBr2 * vAqL);
    const rawShift = (targetAq - nBr2Aq) * Math.min(1, 3.2 * dt);
    const dShift = rawShift > 0 ? Math.min(nBr2L, rawShift) : Math.max(-nBr2Aq, rawShift);
    heatJ += applyEquilibriumShift({
      moles,
      dXi: dShift,
      deltas: { Br2_l: -1, Br2_aq: 1 },
      heatPerMolJ: 1200,
      dt,
      activeReactions,
      logThresholdRate: 2e-4,
      buildMeta: (shift) => ({
        id: 'br2_water_partition',
        equation: 'Br₂(l) ⇌ Br₂(aq) (nước Bromine màu vàng nâu)',
        nameVi: shift > 0 ? 'Hòa tan một phần Bromine vào nước (~3,5 g/100 g)' : 'Tách lớp Bromine lỏng nặng (3,11 g/cm³) xuống đáy',
        nameEn: shift > 0 ? 'Partial dissolution of Bromine in water (~3.5 g/100 g)' : 'Phase separation of dense liquid Bromine (3.11 g/cm³)',
        descVi: 'Br₂ tan hạn chế trong nước tạo nước Bromine vàng nâu; phần dư nặng 3,11 g/cm³ chìm xuống đáy.',
        descEn: 'Br₂ dissolves sparingly into amber-brown Bromine water; excess dense 3.11 g/cm³ liquid sinks below.',
      }),
    });
  }

  // 5. Mild reversible halogen hydrolysis in neutral water (X2 + H2O <-> H+ + X- + HXO)
  if ((moles.OH_aq || 0) < 1e-6) {
    const nBr2Now = moles.Br2_aq || 0;
    const nH = moles.H_aq || 0;
    const nBr = moles.Br_aq || 0;
    const nHBrO = moles.HBrO_aq || 0;
    const cH = nH / vAqL;
    const cBr = nBr / vAqL;
    if (nBr2Now > 1e-9 && nH2O > 1e-4) {
      const targetHydro = Math.min(nBr2Now, Math.max(0, 0.018 * nBr2Now - 0.5 * Math.min(cH, cBr) * vAqL));
      const dH = (targetHydro - Math.min(nHBrO, nBr)) * Math.min(1, 0.65 * dt);
      if (dH > 1e-11) {
        const takeBr2 = Math.min(nBr2Now, dH);
        moles.Br2_aq = nBr2Now - takeBr2;
        if (moles.Br2_aq < 1e-13) delete moles.Br2_aq;
        moles.H2O_l = Math.max(0, nH2O - takeBr2);
        moles.H_aq = nH + takeBr2;
        moles.Br_aq = nBr + takeBr2;
        moles.HBrO_aq = nHBrO + takeBr2;
      }
    }
    const nCl2Now = moles.Cl2_aq || 0;
    if (nCl2Now > 1e-9 && nH2O > 1e-4) {
      const targetClH = Math.min(nCl2Now, Math.max(0, 0.25 * nCl2Now));
      const dClH = (targetClH - Math.min(moles.HClO_aq || 0, moles.Cl_aq || 0)) * Math.min(1, 1.2 * dt);
      if (dClH > 1e-11) {
        const takeCl2 = Math.min(nCl2Now, dClH);
        moles.Cl2_aq = nCl2Now - takeCl2;
        if (moles.Cl2_aq < 1e-13) delete moles.Cl2_aq;
        moles.H2O_l = Math.max(0, (moles.H2O_l || 0) - takeCl2);
        moles.H_aq = (moles.H_aq || 0) + takeCl2;
        moles.Cl_aq = (moles.Cl_aq || 0) + takeCl2;
        moles.HClO_aq = (moles.HClO_aq || 0) + takeCl2;
      }
    }
  }

  // 6. Triiodide equilibrium I2(aq) + I-(aq) <-> I3-(aq) (Kf = 720) & I2(s) <-> I2(aq)
  const eqTriiodide = () => {
    const n2 = moles.I2_aq || 0;
    const n1 = moles.I_aq || 0;
    const n3 = moles.I3_aq || 0;
    if (n2 + n3 <= 1e-12) return;
    const Kf = 720.0;
    const tot2 = (n2 + n3) / vAqL;
    const tot1 = (n1 + n3) / vAqL;
    const b = tot2 + tot1 + 1 / Kf;
    const disc = Math.max(0, b * b - 4 * tot2 * tot1);
    const c3Eq = 0.5 * (b - Math.sqrt(disc));
    const dXi = (c3Eq * vAqL - n3) * relaxFast;
    const clamped = dXi > 0 ? Math.min(n2, n1, dXi) : Math.max(-n3, dXi);
    heatJ += applyEquilibriumShift({
      moles,
      dXi: clamped,
      deltas: { I2_aq: -1, I_aq: -1, I3_aq: 1 },
      heatPerMolJ: 17000,
      dt,
      activeReactions,
      logThresholdRate: 1e-5,
      buildMeta: () => ({
        id: 'i2_ki_triiodide',
        equation: 'I₂(s/aq) + I⁻(aq) ⇌ I₃⁻(aq) (nâu đỏ sẫm)',
        nameVi: 'Tạo ion phức Triiodide I₃⁻ làm Iodine tan mạnh trong dung dịch KI',
        nameEn: 'Triiodide (I₃⁻) complexation solubilizing Iodine in iodide solution',
        descVi: 'Iodine rất ít tan trong nước nguyên chất nhưng tan dễ trong dung dịch I⁻ (KI/NaI) tạo dung dịch I₃⁻ màu nâu đỏ đậm.',
        descEn: 'Iodine dissolves readily in KI/I⁻ solution as deep red-brown Triiodide ion I₃⁻.',
      }),
    });
  };
  eqTriiodide();

  // Surface attack of I-(aq) on crystalline I2(s): I2(s) + I-(aq) -> I3-(aq)
  if ((moles.I2_s || 0) > 1e-9 && (moles.I_aq || 0) > 1e-9) {
    const dKI = Math.min(moles.I2_s, moles.I_aq) * (1 - Math.exp(-3.4 * dt));
    heatJ += applyEquilibriumShift({
      moles,
      dXi: dKI,
      deltas: { I2_s: -1, I_aq: -1, I3_aq: 1 },
      heatPerMolJ: -5000,
      dt,
      activeReactions,
      logThresholdRate: 1e-5,
      buildMeta: () => ({
        id: 'i2_ki_triiodide',
        equation: 'I₂(s) + I⁻(aq) ⇌ I₃⁻(aq) (nâu đỏ sẫm)',
        nameVi: 'Tạo ion phức Triiodide I₃⁻ làm Iodine tan mạnh trong dung dịch KI',
        nameEn: 'Triiodide (I₃⁻) complexation solubilizing Iodine in iodide solution',
        descVi: 'Iodine rất ít tan trong nước nguyên chất nhưng tan dễ trong dung dịch I⁻ (KI/NaI) tạo dung dịch I₃⁻ màu nâu đỏ đậm.',
        descEn: 'Iodine dissolves readily in KI/I⁻ solution as deep red-brown Triiodide ion I₃⁻.',
      }),
    });
  }

  const curI2s = moles.I2_s || 0;
  const curI2Aq = moles.I2_aq || 0;
  if (curI2s + curI2Aq > 1e-11) {
    // 0.032 g / 100 mL @ 20 C = 1.26e-3 M in pure H2O; ~0.85 M in EtOH
    const cSatI2 = 0.00126 * Math.exp(0.022 * Math.max(-15, Math.min(80, tC - 20))) + 0.85 * Math.pow(wEtOH, 1.8);
    const targetI2Aq = Math.min(curI2s + curI2Aq, cSatI2 * vAqL);
    const kSol = (moles.I_aq || 0) > 1e-5 ? 6.5 : 3.2;
    let dI2Shift = (targetI2Aq - curI2Aq) * Math.min(1, kSol * dt);
    dI2Shift = dI2Shift > 0 ? Math.min(curI2s, dI2Shift) : Math.max(-curI2Aq, dI2Shift);
    if (Math.abs(dI2Shift) > 1e-12) {
      heatJ += applyEquilibriumShift({
        moles,
        dXi: dI2Shift,
        deltas: { I2_s: -1, I2_aq: 1 },
        heatPerMolJ: -22000,
        dt,
        activeReactions,
        logThresholdRate: 5e-5,
        buildMeta: (s) => ({
          id: s > 0 ? 'i2_dissolve' : 'i2_crystallize',
          equation: s > 0 ? 'I₂(s) ⇌ I₂(aq)' : 'I₂(aq) → I₂(s)↓ (tinh thể tím đen)',
          nameVi: s > 0 ? 'Hòa tan nhẹ Iodine' : 'Kết tinh tinh thể Iodine tím đen',
          nameEn: s > 0 ? 'Partial dissolution of Iodine' : 'Crystallization of dark purple-black Iodine',
          descVi: s > 0 ? 'I₂ tan rất ít trong nước (~0,032 g/100 mL), tan tốt hơn trong Ethanol và KI.' : 'Lượng I₂ vượt độ tan tách ra dưới dạng tinh thể vảy tím đen.',
          descEn: s > 0 ? 'I₂ dissolves slightly in water (~0.032 g/100 mL), far better in Ethanol or KI.' : 'Excess aqueous I₂ crystallizes into shiny dark purple-black flakes.',
        }),
      });
      eqTriiodide();
    }
  }

  // 7. Halogen displacement: Cl2 > Br2 > I2 (absorbs reactive headspace Cl2/Br2 too!)
  const runHalogenDisplacement = (oxAqKey, oxGasKey, redIonKey, newHalAqKey, prodIonKey, eqStr, nameVi, nameEn, heatRxn) => {
    const nRed = moles[redIonKey] || 0;
    if (nRed < 1e-10) return;
    const nAqOx = moles[oxAqKey] || 0;
    const nGasOx = oxGasKey ? (vessel.headspaceGasMoles?.[oxGasKey] || 0) : 0;
    const totOx = nAqOx + nGasOx;
    if (totOx <= 1e-10) return;
    const dXi = Math.min(totOx, nRed / 2) * Math.min(1, 5.5 * dt);
    if (dXi <= 1e-11) return;
    const fromAq = Math.min(nAqOx, dXi);
    const fromGas = Math.min(nGasOx, dXi - fromAq);
    if (fromGas > 1e-12) consumeGas(oxGasKey, fromGas);
    if (fromAq > 1e-12) {
      moles[oxAqKey] = nAqOx - fromAq;
      if (moles[oxAqKey] < 1e-13) delete moles[oxAqKey];
    }
    const act = fromAq + fromGas;
    moles[redIonKey] = nRed - 2 * act;
    if (moles[redIonKey] < 1e-13) delete moles[redIonKey];
    moles[prodIonKey] = (moles[prodIonKey] || 0) + 2 * act;
    moles[newHalAqKey] = (moles[newHalAqKey] || 0) + act;
    heatJ += act * heatRxn;
    if (act / dt > 1e-6) {
      activeReactions.push({
        id: `disp_${oxAqKey}_${redIonKey}`,
        equation: eqStr,
        nameVi,
        nameEn,
        descVi: `${nameVi} (tính oxi hóa Cl₂ > Br₂ > I₂).`,
        descEn: `${nameEn} (oxidizing strength Cl₂ > Br₂ > I₂).`,
        rateMolS: act / dt,
        vigorousGas: false,
        dXi: act,
      });
    }
  };
  runHalogenDisplacement('Cl2_aq', 'Cl2_g', 'Br_aq', 'Br2_aq', 'Cl_aq', 'Cl₂ + 2Br⁻ → 2Cl⁻ + Br₂', 'Chlorine đẩy Bromine ra khỏi dung dịch muối Br⁻', 'Chlorine displaces Bromine from Bromide (Cl₂ + 2Br⁻ → 2Cl⁻ + Br₂)', 82000);
  runHalogenDisplacement('Cl2_aq', 'Cl2_g', 'I_aq', 'I2_aq', 'Cl_aq', 'Cl₂ + 2I⁻ → 2Cl⁻ + I₂', 'Chlorine đẩy Iodine ra khỏi dung dịch muối I⁻', 'Chlorine displaces Iodine from Iodide (Cl₂ + 2I⁻ → 2Cl⁻ + I₂)', 164000);
  runHalogenDisplacement('Br2_aq', 'Br2_g', 'I_aq', 'I2_aq', 'Br_aq', 'Br₂ + 2I⁻ → 2Br⁻ + I₂', 'Bromine đẩy Iodine ra khỏi dung dịch muối I⁻', 'Bromine displaces Iodine from Iodide (Br₂ + 2I⁻ → 2Br⁻ + I₂)', 81000);

  // Classic Cu2+ + 4I- -> 2CuI(s) + I2(aq)
  if ((moles.Cu2_aq || 0) > 1e-8 && (moles.I_aq || 0) > 1e-8) {
    const dCuI = Math.min((moles.Cu2_aq || 0) / 2, (moles.I_aq || 0) / 4) * Math.min(1, 6.0 * dt);
    heatJ += applyEquilibriumShift({
      moles,
      dXi: dCuI,
      deltas: { Cu2_aq: -2, I_aq: -4, CuI_s: 2, I2_aq: 1 },
      heatPerMolJ: 92000,
      dt,
      activeReactions,
      logThresholdRate: 1e-5,
      buildMeta: () => ({
        id: 'cu2_iodide_redox',
        equation: '2Cu²⁺(aq) + 4I⁻(aq) → 2CuI(s)↓ + I₂(aq)',
        nameVi: 'Cu²⁺ oxi hóa I⁻ tạo kết tủa trắng CuI và I₂/I₃⁻ nâu đỏ',
        nameEn: 'Copper(II) oxidizes Iodide yielding white CuI↓ and brown I₂/I₃⁻',
        descVi: 'Ion Cu²⁺ bị I⁻ khử về kết tủa trắng Copper(I) iodide (CuI) đồng thời giải phóng I₂/I₃⁻.',
        descEn: 'Cu²⁺ is reduced to white CuI precipitate while liberating brown I₂/I₃⁻.',
      }),
    });
  }
  eqTriiodide();

  // 8. Halogen + Alkali (OH-) temperature matrix (Cl2, Br2, I2 @ <5 C, 20-25 C, 50-100 C)
  const halogenAlkaliTable = [
    {
      halAq: 'Cl2_aq',
      halOther: null,
      gasKey: 'Cl2_g',
      xIon: 'Cl_aq',
      xoIon: 'ClO_aq',
      xo3Ion: 'ClO3_aq',
      hxoIon: 'HClO_aq',
      hotK: 323.15,
      coldEndK: 320.15,
      dispropCold: 0.0,
      dispropRoom: 0.0,
      dispropHot: 0.75 * Math.exp(Math.min(2.5, Math.max(0, 0.045 * (T - 323.15)))),
      eqCold: 'Cl₂ + 2OH⁻ → Cl⁻ + ClO⁻ + H₂O',
      eqHot: '3Cl₂ + 6OH⁻ —(t°)→ 5Cl⁻ + ClO₃⁻ + 3H₂O',
      nameColdVi: 'Chlorine tác dụng kiềm lạnh/thường tạo nước Javel (Cl⁻ + ClO⁻)',
      nameColdEn: 'Chlorine in cold/ambient alkali yields Hypochlorite (Cl⁻ + ClO⁻)',
      nameHotVi: 'Chlorine tác dụng kiềm nóng (≥ 50 °C) tạo Chlorate (Cl⁻ + ClO₃⁻)',
      nameHotEn: 'Chlorine in hot alkali (≥ 50 °C) yields Chlorate (Cl⁻ + ClO₃⁻)',
    },
    {
      halAq: 'Br2_aq',
      halOther: 'Br2_l',
      gasKey: 'Br2_g',
      xIon: 'Br_aq',
      xoIon: 'BrO_aq',
      xo3Ion: 'BrO3_aq',
      hxoIon: 'HBrO_aq',
      hotK: 323.15,
      coldEndK: 283.15,
      dispropCold: 0.0005,
      dispropRoom: 0.095,
      dispropHot: 2.6,
      eqCold: 'Br₂ + 2OH⁻ —(< 5 °C)→ Br⁻ + BrO⁻ + H₂O',
      eqHot: '3Br₂ + 6OH⁻ —(≥ 50 °C)→ 5Br⁻ + BrO₃⁻ + 3H₂O',
      nameColdVi: 'Bromine + kiềm lạnh (< 5 °C) tạo Hypobromite Br⁻ + BrO⁻',
      nameColdEn: 'Bromine + cold alkali (< 5 °C) forms Hypobromite Br⁻ + BrO⁻',
      nameHotVi: 'Bromine + kiềm tạo Bromate (Br⁻ + BrO₃⁻) khi ấm/nóng',
      nameHotEn: 'Bromine + warm/hot alkali disproportionates to Bromate (Br⁻ + BrO₃⁻)',
    },
    {
      halAq: 'I2_aq',
      halOther: 'I2_s',
      gasKey: 'I2_g',
      xIon: 'I_aq',
      xoIon: 'IO_aq',
      xo3Ion: 'IO3_aq',
      hxoIon: null,
      hotK: 285.15,
      coldEndK: 283.15,
      dispropCold: 0.015,
      dispropRoom: 6.5,
      dispropHot: 8.0,
      eqCold: 'I₂ + 2OH⁻ —(< 5 °C)→ I⁻ + IO⁻ + H₂O (kém bền)',
      eqHot: '3I₂ + 6OH⁻ → 5I⁻ + IO₃⁻ + 3H₂O',
      nameColdVi: 'Iodine + kiềm siêu lạnh (< 5 °C) tạo I⁻ + IO⁻ tạm thời',
      nameColdEn: 'Iodine + ice-cold alkali (< 5 °C) transiently forms I⁻ + IO⁻',
      nameHotVi: 'Iodine mất màu trong kiềm tạo I⁻ + IO₃⁻ không màu',
      nameHotEn: 'Iodine disproportionates rapidly in alkali to colorless I⁻ + IO₃⁻',
    },
  ];

  for (const h of halogenAlkaliTable) {
    // Neutralize any free HClO/HBrO in alkali first
    if (h.hxoIon && (moles[h.hxoIon] || 0) > 1e-11 && (moles.OH_aq || 0) > 1e-11) {
      const dNeut = Math.min(moles[h.hxoIon], moles.OH_aq) * relaxFast;
      applyEquilibriumShift({ moles, dXi: dNeut, deltas: { [h.hxoIon]: -1, OH_aq: -1, [h.xoIon]: 1, H2O_l: 1 }, heatPerMolJ: 45000, dt, activeReactions });
    }
    const nOH = moles.OH_aq || 0;
    if (nOH > 1e-9) {
      const srcOrder = [h.halAq, h.halOther].filter(Boolean);
      let remainingOH = nOH;
      const isHotRegime = T >= h.hotK;
      for (const srcKey of srcOrder) {
        const nSrc = moles[srcKey] || 0;
        if (nSrc <= 1e-10 || remainingOH <= 1e-10) continue;
        const rateS = srcKey === h.halAq ? 9.5 : 4.2;
        const dHal = Math.min(nSrc, remainingOH / 2) * (1 - Math.exp(-rateS * dt));
        if (dHal <= 1e-12) continue;
        remainingOH -= 2 * dHal;
        const deltas = isHotRegime
          ? { [srcKey]: -1, OH_aq: -2, [h.xIon]: 5 / 3, [h.xo3Ion]: 1 / 3, H2O_l: 1 }
          : { [srcKey]: -1, OH_aq: -2, [h.xIon]: 1, [h.xoIon]: 1, H2O_l: 1 };
        heatJ += applyEquilibriumShift({
          moles,
          dXi: dHal,
          deltas,
          heatPerMolJ: isHotRegime ? 105000 : 88000,
          dt,
          activeReactions,
          logThresholdRate: 1e-5,
          buildMeta: () => ({
            id: `hal_oh_${h.halAq}_${isHotRegime ? 'hot' : 'cold'}`,
            equation: isHotRegime ? h.eqHot : h.eqCold,
            nameVi: isHotRegime ? h.nameHotVi : h.nameColdVi,
            nameEn: isHotRegime ? h.nameHotEn : h.nameColdEn,
            descVi: isHotRegime ? h.nameHotVi : h.nameColdVi,
            descEn: isHotRegime ? h.nameHotEn : h.nameColdEn,
          }),
        });
      }
      // Also pull I3- or headspace halogen when OH- is present
      if (h.halAq === 'I2_aq' && (moles.I3_aq || 0) > 1e-10) eqTriiodide();
      if (h.gasKey && (vessel.headspaceGasMoles?.[h.gasKey] || 0) > 1e-9 && (moles.OH_aq || 0) > 1e-9) {
        const takeG = consumeGas(h.gasKey, Math.min(vessel.headspaceGasMoles[h.gasKey], (moles.OH_aq || 0) * 0.5) * Math.min(1, 3.5 * dt));
        if (takeG > 1e-12) moles[h.halAq] = (moles[h.halAq] || 0) + takeG;
      }
    }

    // Disproportionation of hypohalite 3 XO- -> 2 X- + XO3- controlled by temperature!
    const nXO = moles[h.xoIon] || 0;
    if (nXO > 1e-10) {
      const kDis = T < h.coldEndK ? h.dispropCold : T < h.hotK ? h.dispropRoom : h.dispropHot;
      if (kDis > 0) {
        const dDis = (nXO / 3) * (1 - Math.exp(-kDis * dt));
        heatJ += applyEquilibriumShift({
          moles,
          dXi: dDis,
          deltas: { [h.xoIon]: -3, [h.xIon]: 2, [h.xo3Ion]: 1 },
          heatPerMolJ: 54000,
          dt,
          activeReactions,
          logThresholdRate: 1e-5,
          buildMeta: () => ({
            id: `xo_disprop_${h.xoIon}`,
            equation: `3${SPECIES[h.xoIon].formula}(aq) → 2${SPECIES[h.xIon].formula}(aq) + ${SPECIES[h.xo3Ion].formula}(aq)`,
            nameVi: `Tự oxi hóa - khử ${SPECIES[h.xoIon].formula} tạo ${SPECIES[h.xo3Ion].formula}`,
            nameEn: `Disproportionation of ${SPECIES[h.xoIon].formula} into ${SPECIES[h.xo3Ion].formula}`,
            descVi: `${SPECIES[h.xoIon].formula} kém bền nhiệt phân hủy thành halide và halate.`,
            descEn: `Thermally unstable ${SPECIES[h.xoIon].formula} disproportionates to halide and halate.`,
          }),
        });
      }
    }

    // Acidification comproportionation: XO- + X- + 2H+ -> X2 + H2O and XO3- + 5X- + 6H+ -> 3X2 + 3H2O
    const nHNow = moles.H_aq || 0;
    const nXNow = moles[h.xIon] || 0;
    const nXONow = moles[h.xoIon] || 0;
    if (nHNow > 1e-8 && nXNow > 1e-8 && nXONow > 1e-8) {
      const dXOH = Math.min(nXONow, nXNow, nHNow / 2) * Math.min(1, 5.5 * dt);
      heatJ += applyEquilibriumShift({
        moles,
        dXi: dXOH,
        deltas: { [h.xoIon]: -1, [h.xIon]: -1, H_aq: -2, [h.halAq]: 1, H2O_l: 1 },
        heatPerMolJ: 68000,
        dt,
        activeReactions,
      });
    }
    const nXO3Now = moles[h.xo3Ion] || 0;
    if (nHNow > 1e-8 && nXNow > 1e-8 && nXO3Now > 1e-8) {
      const dComp = Math.min(nXO3Now, nXNow / 5, nHNow / 6) * Math.min(1, 3.8 * dt);
      heatJ += applyEquilibriumShift({
        moles,
        dXi: dComp,
        deltas: { [h.xo3Ion]: -1, [h.xIon]: -5, H_aq: -6, [h.halAq]: 3, H2O_l: 3 },
        heatPerMolJ: 95000,
        dt,
        activeReactions,
        logThresholdRate: 1e-5,
        buildMeta: () => ({
          id: `halate_acid_comprop_${h.halAq}`,
          equation: `${SPECIES[h.xo3Ion].formula} + 5${SPECIES[h.xIon].formula} + 6H⁺ → 3${SPECIES[h.halAq].formula} + 3H₂O`,
          nameVi: `Acid tái tạo ${SPECIES[h.halAq].formula} từ ${SPECIES[h.xo3Ion].formula} và ${SPECIES[h.xIon].formula}`,
          nameEn: `Acid comproportionation regenerating ${SPECIES[h.halAq].formula}`,
          descVi: 'Thêm acid H⁺ vào hỗn hợp halide + halate giải phóng lại halogen tự do.',
          descEn: 'Acidifying a halide + halate mixture regenerates free halogen.',
        }),
      });
    }
  }

  // 9. Hot conc. HNO3 (>=60% @ 70-100 C) oxidizes I2 -> 2HIO3 + 10NO2↑ + 4H2O (Br2 does NOT react; HCl/H2SO4 do NOT oxidize Br2/I2)
  const nI2ForHNO3 = (moles.I2_s || 0) + (moles.I2_aq || 0);
  if (nI2ForHNO3 > 1e-9 && T >= 343.15) {
    const nNO3 = (moles.NO3_aq || 0) + (moles.HNO3_l || 0);
    const nHT = (moles.H_aq || 0) + (moles.HNO3_l || 0);
    const mHNO3 = Math.min(nNO3, nHT) * 63.013;
    const wHNO3 = mHNO3 / Math.max(1e-9, mHNO3 + (moles.H2O_l || 0) * 18.015);
    if (wHNO3 >= 0.60 && (moles.H_aq || 0) > 1e-4 && (moles.NO3_aq || 0) > 1e-4) {
      const iSrcKey = (moles.I2_s || 0) >= (moles.I2_aq || 0) ? 'I2_s' : 'I2_aq';
      const tRamp = Math.min(1.0, 0.4 + ((T - 343.15) / 30.0) * 0.6);
      const dOxI2 = Math.min(moles[iSrcKey] || 0, (moles.H_aq || 0) / 10, (moles.NO3_aq || 0) / 10) * (1 - Math.exp(-1.85 * tRamp * dt));
      if (dOxI2 > 1e-11) {
        moles[iSrcKey] = Math.max(0, (moles[iSrcKey] || 0) - dOxI2);
        if (moles[iSrcKey] < 1e-13) delete moles[iSrcKey];
        moles.H_aq = Math.max(0, moles.H_aq - 8 * dOxI2);
        moles.NO3_aq = Math.max(0, moles.NO3_aq - 10 * dOxI2);
        moles.IO3_aq = (moles.IO3_aq || 0) + 2 * dOxI2;
        moles.H2O_l = (moles.H2O_l || 0) + 4 * dOxI2;
        emitGas('NO2_g', 10 * dOxI2);
        heatJ += dOxI2 * 220000;
        activeReactions.push({
          id: 'i2_hno3_conc_hot',
          equation: 'I₂(s/aq) + 10HNO₃(đặc) —(70–100 °C)→ 2HIO₃(aq) + 10NO₂(g)↑ + 4H₂O',
          nameVi: 'Iodine bị HNO₃ đặc nóng oxi hóa thành Iodic acid (HIO₃) và khí NO₂ nâu đỏ',
          nameEn: 'Hot conc. Nitric acid oxidizes Iodine to Iodic acid (HIO₃) + NO₂↑',
          descVi: 'Khác với Cl₂ và Br₂, Iodine phản ứng với HNO₃ đặc nóng (70–100 °C) tạo dung dịch không màu HIO₃ và khí NO₂↑ (không phản ứng với HCl hay H₂SO₄ đặc).',
          descEn: 'Unlike Cl₂/Br₂, Iodine is oxidized by hot conc. HNO₃ (70–100 °C) to colorless HIO₃ and brown NO₂↑ (inert to HCl & H₂SO₄).',
          rateMolS: dOxI2 / dt,
          vigorousGas: true,
          dXi: dOxI2,
        });
      }
    }
  }

  return heatJ;
}

/**
 * Sulfur (S) thermal combustion, metal/H2 synthesis, oxidizer attack (HNO3/H2SO4/Cl2),
 * Al2S3/S2- hydrolysis, H2S reversible pyrolysis & plastic sulfur relaxation.
 */
function stepSulfurChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
  if (!vessel?.moles || dt <= 0) return 0;
  const moles = vessel.moles;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  let heatJ = 0;

  if ((vessel._fesPropagateTimer || 0) > 0) {
    vessel._fesPropagateTimer = Math.max(0, vessel._fesPropagateTimer - dt);
  }
  if ((vessel._al2s3PropagateTimer || 0) > 0) {
    vessel._al2s3PropagateTimer = Math.max(0, vessel._al2s3PropagateTimer - dt);
  }
  if ((vessel._mgsPropagateTimer || 0) > 0) {
    vessel._mgsPropagateTimer = Math.max(0, vessel._mgsPropagateTimer - dt);
  }

  // 0. Plastic sulfur (S_plastic_s) gradually reverts to brittle yellow crystalline S_s
  const nPlast = moles.S_plastic_s || 0;
  if (nPlast > 1e-10) {
    const kRelax = T >= 323.15 ? 0.35 : 0.04;
    const dRel = nPlast * (1 - Math.exp(-kRelax * dt));
    if (dRel > 1e-12) {
      moles.S_plastic_s = nPlast - dRel;
      if (moles.S_plastic_s < 1e-13) delete moles.S_plastic_s;
      moles.S_s = (moles.S_s || 0) + dRel;
    }
  }

  // 1. Dry/hot combustion S + O2 -> SO2 (pale blue flame >= 250 C in air; bright violet-blue >= 230 C in O2)
  const nSulf = moles.S_s || 0;
  const nH2O = moles.H2O_l || 0;
  const pO2 = getVesselEffectiveO2Bar(vessel, options.environment);
  if (nSulf > 1e-9 && nH2O < 0.04 && pO2 >= 0.06) {
    const isConcO2 = pO2 >= 0.38;
    const igniteK = isConcO2 ? 503.15 : 523.15;
    if (T >= igniteK || ((vessel.sulfurFlameTimer || 0) > 0.02 && T >= 440.0)) {
      const rateBurn = (isConcO2 ? 2.4 : 0.85) * Math.min(2.5, Math.max(0.4, pO2 / 0.21));
      const dBurn = Math.min(nSulf, rateBurn * 0.08 * dt);
      if (dBurn > 1e-11) {
        moles.S_s = nSulf - dBurn;
        if (moles.S_s < 1e-13) delete moles.S_s;
        gasProduced.SO2_g = (gasProduced.SO2_g || 0) + dBurn;
        heatJ += dBurn * 296800;
        vessel.sulfurFlameTimer = 1.4;
        vessel.sulfurO2Flame = isConcO2;
        activeReactions.push({
          id: isConcO2 ? 's_o2_burn_conc' : 's_o2_burn_air',
          equation: 'S(s/l) + O₂(g) —(t°)→ SO₂(g)↑',
          nameVi: isConcO2 ? 'Sulfur cháy mãnh liệt trong O₂ với ngọn lửa xanh tím' : 'Sulfur cháy trong không khí với ngọn lửa xanh nhạt sinh khí SO₂',
          nameEn: isConcO2 ? 'Sulfur burns brilliantly with violet-blue flame in O₂' : 'Sulfur burns in air with pale-blue flame forming SO₂',
          descVi: isConcO2 ? 'Trong O₂ tinh khiết (≥ 230 °C), S cháy mạnh phát ánh sáng xanh tím sinh khí hắc SO₂.' : 'Trong không khí (≥ 250 °C), S cháy nhẹ tạo ngọn lửa xanh và khí SO₂.',
          descEn: isConcO2 ? 'In concentrated O₂ (≥ 230 °C), S burns briskly with bright violet-blue flame.' : 'In air (≥ 250 °C), S burns gently with a pale-blue flame yielding SO₂.',
          rateMolS: dBurn / dt,
          vigorousGas: true,
          dXi: dBurn,
        });
      }
    }
  }

  // 2. Direct Metal + Sulfur synthesis (reacts with S_s OR refluxing S_g vapor; self-propagating exothermic after ignition!)
  if (((moles.S_s || 0) > 1e-9 || (vessel.headspaceGasMoles?.S_g || 0) > 1e-9) && nH2O < 0.05) {
    const metalSulfurSpecs = [
      { id: 'K', sId: 'K_s', cM: 2, cS: 1, minK: 312, rate: 5.5, prodS: 'K2S_s', heatJ: 381000, eq: '2K(s) + S(s) → K₂S(s)', nameVi: 'Potassium phản ứng mãnh liệt với Sulfur tạo K₂S', nameEn: 'Potassium reacts vigorously with Sulfur forming K₂S' },
      { id: 'Na', sId: 'Na_s', cM: 2, cS: 1, minK: 325, rate: 4.5, prodS: 'Na2S_s', heatJ: 365000, eq: '2Na(s) + S(s) → Na₂S(s)', nameVi: 'Sodium hóa hợp tỏa nhiệt mạnh với Sulfur tạo Na₂S', nameEn: 'Sodium combines vigorously with Sulfur forming Na₂S' },
      { id: 'Zn', sId: 'Zn_s', cM: 1, cS: 1, minK: 423.15, rate: 3.2, prodS: 'ZnS_s', heatJ: 206000, timer: 'znCombustionTimer', eq: 'Zn(s) + S(s) —(t° ≥ 150 °C)→ ZnS(s)', nameVi: 'Zinc hóa hợp mạnh với Sulfur tạo bột trắng ZnS', nameEn: 'Zinc reacts exothermically with Sulfur forming white ZnS' },
      { id: 'Al', sId: 'Al_s', cM: 2, cS: 3, minK: 473.15, rate: 2.8, prodS: 'Al2S3_s', propKey: '_al2s3PropagateTimer', heatJ: 724000, timer: 'alCombustionTimer', eq: '2Al(s) + 3S(s) —(t° ≥ 200 °C)→ Al₂S₃(s)', nameVi: 'Aluminium phản ứng tỏa nhiệt rất mạnh với Sulfur tạo Al₂S₃', nameEn: 'Aluminium reacts strongly with Sulfur yielding Al₂S₃' },
      { id: 'Mg', sId: 'Mg_s', cM: 1, cS: 1, minK: 723.15, rate: 45.0, prodS: 'MgS_s', propKey: '_mgsPropagateTimer', heatJ: 345700, timer: 'mgCombustionTimer', eq: 'Mg(s) + S(l/g) —(450–500 °C)→ MgS(s)', nameVi: 'Magnesium cháy lóe sáng chói với Sulfur tạo MgS trắng ngà', nameEn: 'Magnesium ignites brilliantly with Sulfur forming off-white MgS' },
      { id: 'Fe', sId: 'Fe_s', cM: 1, cS: 1, minK: 673.15, rate: 9.5, prodS: 'FeS_s', propKey: '_fesPropagateTimer', heatJ: 95000, eq: 'Fe(s) + S(l/g) —(t° ≥ 450–500 °C)→ FeS(s)', nameVi: 'Iron hóa hợp với Sulfur nóng đỏ tạo Iron(II) sulfide (FeS đen xám)', nameEn: 'Iron combines with Sulfur at red heat forming black non-magnetic FeS' },
    ];
    for (const ms of metalSulfurSpecs) {
      const curS = moles.S_s || 0;
      const curSG = vessel.headspaceGasMoles?.S_g || 0;
      const nM = moles[ms.sId] || 0;
      if (nM <= 1e-9 || (curS <= 1e-9 && curSG <= 1e-9)) continue;
      const propagated = ms.propKey && (vessel[ms.propKey] || 0) > 0 && T >= 450;
      if (T < ms.minK && !propagated) continue;
      const srcIsGas = curS < curSG && curSG > 1e-9;
      const availS = srcIsGas ? curSG : curS;
      const dXi = Math.min(nM / ms.cM, availS / ms.cS) * (1 - Math.exp(-ms.rate * dt));
      if (dXi <= 1e-11) continue;
      if (srcIsGas && vessel.headspaceGasMoles) {
        vessel.headspaceGasMoles.S_g = Math.max(0, curSG - ms.cS * dXi);
        heatJ += applyEquilibriumShift({
          moles,
          dXi,
          deltas: { [ms.sId]: -ms.cM, [ms.prodS]: 1 },
          heatPerMolJ: ms.heatJ,
          dt,
          activeReactions,
          logThresholdRate: 1e-6,
          buildMeta: () => ({
            id: `metal_${ms.id.toLowerCase()}_s`,
            equation: ms.eq,
            nameVi: ms.nameVi,
            nameEn: ms.nameEn,
            descVi: `${ms.nameVi}, tự duy trì phản ứng nhờ nhiệt lượng tỏa ra lớn.`,
            descEn: `${ms.nameEn}, self-propagating exothermically once initiated.`,
          }),
        });
      } else {
        heatJ += applyEquilibriumShift({
          moles,
          dXi,
          deltas: { [ms.sId]: -ms.cM, S_s: -ms.cS, [ms.prodS]: 1 },
          heatPerMolJ: ms.heatJ,
          dt,
          activeReactions,
          logThresholdRate: 1e-6,
          buildMeta: () => ({
            id: `metal_${ms.id.toLowerCase()}_s`,
            equation: ms.eq,
            nameVi: ms.nameVi,
            nameEn: ms.nameEn,
            descVi: `${ms.nameVi}, tự duy trì phản ứng nhờ nhiệt lượng tỏa ra lớn.`,
            descEn: `${ms.nameEn}, self-propagating exothermically once initiated.`,
          }),
        });
      }
      if (ms.propKey) vessel[ms.propKey] = 2.0;
      if (ms.timer) vessel[ms.timer] = 1.4;
    }
  }

  // 3. Reversible H2(g) + S <-> H2S(g) (forward ~350-400 C; thermally dissociates above 450-500 C!)
  const headH2 = vessel.headspaceGasMoles?.H2_g || 0;
  const headH2S = vessel.headspaceGasMoles?.H2S_g || 0;
  if (T >= 613.15 && ((headH2 > 1e-9 && (moles.S_s || 0) > 1e-9) || headH2S > 1e-9)) {
    const kEqH2S = T < 683.15 ? 24.0 : Math.max(0.25, 24.0 * Math.exp(-0.028 * (T - 683.15)));
    const curS = moles.S_s || 0;
    const desiredRatio = kEqH2S; // [H2S] / [H2] at sulfur saturation
    const curRatio = headH2 > 1e-10 ? headH2S / headH2 : 1e6;
    if (curRatio < desiredRatio && curS > 1e-9 && headH2 > 1e-9) {
      const targetH2S = (headH2 + headH2S) * (desiredRatio / (1 + desiredRatio));
      const dFwd = Math.min(curS, headH2, Math.max(0, targetH2S - headH2S)) * (1 - Math.exp(-1.5 * dt));
      if (dFwd > 1e-11 && vessel.headspaceGasMoles) {
        vessel.headspaceGasMoles.H2_g = Math.max(0, headH2 - dFwd);
        moles.S_s = Math.max(0, curS - dFwd);
        if (moles.S_s < 1e-13) delete moles.S_s;
        gasProduced.H2S_g = (gasProduced.H2S_g || 0) + dFwd;
        heatJ += dFwd * 20600;
        activeReactions.push({
          id: 'h2_s_to_h2s',
          equation: 'H₂(g) + S(l/g) ⇌ H₂S(g) (350–400 °C)',
          nameVi: 'Hydrogen tác dụng với Sulfur tạo khí Hydrogen sulfide (H₂S)',
          nameEn: 'Reversible synthesis of Hydrogen sulfide (H₂ + S ⇌ H₂S)',
          descVi: 'Ở 350–400 °C, H₂ khử S thành khí H₂S; đun nóng quá 450–500 °C H₂S phân hủy ngược một phần về H₂ + S.',
          descEn: 'At 350–400 °C H₂ reduces S to H₂S; above 450–500 °C thermal dissociation lowers equilibrium yield.',
          rateMolS: dFwd / dt,
          vigorousGas: false,
          dXi: dFwd,
        });
      }
    } else if (curRatio > desiredRatio * 1.15 && headH2S > 1e-9 && vessel.headspaceGasMoles) {
      const targetH2S = (headH2 + headH2S) * (desiredRatio / (1 + desiredRatio));
      const dRev = Math.min(headH2S, Math.max(0, headH2S - targetH2S)) * (1 - Math.exp(-1.6 * dt));
      if (dRev > 1e-11) {
        vessel.headspaceGasMoles.H2S_g = Math.max(0, headH2S - dRev);
        moles.S_s = (moles.S_s || 0) + dRev;
        gasProduced.H2_g = (gasProduced.H2_g || 0) + dRev;
        heatJ -= dRev * 20600;
        activeReactions.push({
          id: 'h2s_thermal_decomp',
          equation: 'H₂S(g) ⇌ H₂(g) + S (nhiệt phân > 450 °C)',
          nameVi: 'Nhiệt phân một phần H₂S thành H₂ và Sulfur ở nhiệt độ cao',
          nameEn: 'Partial thermal dissociation of H₂S above 450 °C',
          descVi: 'Trên 450–500 °C, H₂S kém bền nhiệt tách ngược trở lại H₂ và hơi/tinh thể Sulfur.',
          descEn: 'Above 450–500 °C, H₂S partially dissociates back into H₂ and S.',
          rateMolS: dRev / dt,
          vigorousGas: false,
          dXi: dRev,
        });
      }
    }
  }

  // 3b. Thermal equilibrium 2SO3(g) <-> 2SO2(g) + O2(g) above 700 °C (973.15 K)
  const headSO3 = vessel.headspaceGasMoles?.SO3_g || 0;
  const prodSO3 = gasProduced?.SO3_g || 0;
  if (T >= 973.15 && (headSO3 > 1e-9 || prodSO3 > 1e-9)) {
    const dissocFrac = Math.min(0.88, 0.35 + ((T - 973.15) / 250.0) * 0.50);
    if (headSO3 > 1e-9 && vessel.headspaceGasMoles) {
      const dSO3 = headSO3 * dissocFrac * (1 - Math.exp(-3.2 * dt));
      if (dSO3 > 1e-11) {
        vessel.headspaceGasMoles.SO3_g = Math.max(0, headSO3 - dSO3);
        if (vessel.headspaceGasMoles.SO3_g < 1e-13) vessel.headspaceGasMoles.SO3_g = 0;
        gasProduced.SO2_g = (gasProduced.SO2_g || 0) + dSO3;
        gasProduced.O2_g = (gasProduced.O2_g || 0) + 0.5 * dSO3;
        heatJ -= dSO3 * 98900;
      }
    }
    if (prodSO3 > 1e-9 && gasProduced) {
      const dProd = prodSO3 * dissocFrac;
      if (dProd > 1e-11) {
        gasProduced.SO3_g = Math.max(0, prodSO3 - dProd);
        gasProduced.SO2_g = (gasProduced.SO2_g || 0) + dProd;
        gasProduced.O2_g = (gasProduced.O2_g || 0) + 0.5 * dProd;
        heatJ -= dProd * 98900;
      }
    }
  }

  // Slow ambient moist-air hydrolysis of MgS even without bulk water
  if ((moles.MgS_s || 0) > 1e-8 && nH2O <= 1e-5 && (options.environment?.atmosphereMode || 'air') === 'air' && !vessel.isStoppered && T < 393.15) {
    const dAirMgS = Math.min(moles.MgS_s, 0.0008 * dt);
    if (dAirMgS > 1e-11) {
      moles.MgS_s -= dAirMgS;
      if (moles.MgS_s < 1e-13) delete moles.MgS_s;
      moles.MgOH2_s = (moles.MgOH2_s || 0) + dAirMgS;
      gasProduced.H2S_g = (gasProduced.H2S_g || 0) + dAirMgS;
    }
  }

  // Stop aqueous/hydrolysis sulfur reactions if solvent frozen or absent
  if (iceMob <= 0 || liquidVolL <= 1e-6 || nH2O <= 1e-5) {
    return heatJ;
  }

  // 4. Vigorous Al2S3(s) & MgS(s) hydrolysis (even in cold water!)
  const nMgS = moles.MgS_s || 0;
  if (nMgS > 1e-9 && ((moles.H_aq || 0) > 1e-5 || nH2O >= 1e-4)) {
    const useAcid = (moles.H_aq || 0) >= 2e-5;
    const dMgS = Math.min(nMgS, useAcid ? moles.H_aq / 2 : nH2O / 2) * (1 - Math.exp(-(useAcid ? 6.5 : 3.8) * dt));
    if (dMgS > 1e-11) {
      moles.MgS_s = nMgS - dMgS;
      if (moles.MgS_s < 1e-13) delete moles.MgS_s;
      if (useAcid) {
        moles.H_aq = Math.max(0, moles.H_aq - 2 * dMgS);
        moles.Mg2_aq = (moles.Mg2_aq || 0) + dMgS;
      } else {
        moles.H2O_l = Math.max(0, nH2O - 2 * dMgS);
        if (moles.H2O_l < 1e-13) delete moles.H2O_l;
        moles.MgOH2_s = (moles.MgOH2_s || 0) + dMgS;
      }
      gasProduced.H2S_g = (gasProduced.H2S_g || 0) + dMgS;
      heatJ += dMgS * 108000;
      activeReactions.push({
        id: 'mgs_hydrolysis',
        equation: useAcid ? 'MgS(s) + 2H⁺(aq) → Mg²⁺(aq) + H₂S(g)↑' : 'MgS(s) + 2H₂O(l) → Mg(OH)₂(s)↓ + H₂S(g)↑',
        nameVi: 'Thủy phân mạnh Magnesium sulfide (MgS) ngay trong nước lạnh tạo H₂S↑',
        nameEn: 'Rapid cold hydrolysis of Magnesium sulfide (MgS) evolving H₂S↑',
        descVi: 'MgS rất kém bền nước, thủy phân nhanh ngay ở nhiệt độ thường hoặc ẩm không khí tạo Mg(OH)₂↓ và khí mùi trứng thối H₂S↑.',
        descEn: 'MgS hydrolyzes rapidly even in cold water or humid air yielding Mg(OH)₂↓ and H₂S gas.',
        rateMolS: dMgS / dt,
        vigorousGas: true,
        dXi: dMgS,
      });
    }
  }
  const nAl2S3 = moles.Al2S3_s || 0;
  if (nAl2S3 > 1e-9 && nH2O >= 1e-4) {
    const dHyd = Math.min(nAl2S3, nH2O / 6) * (1 - Math.exp(-4.5 * dt));
    if (dHyd > 1e-11) {
      moles.Al2S3_s = nAl2S3 - dHyd;
      if (moles.Al2S3_s < 1e-13) delete moles.Al2S3_s;
      moles.H2O_l = nH2O - 6 * dHyd;
      if (moles.H2O_l < 1e-13) delete moles.H2O_l;
      moles.AlOH3_s = (moles.AlOH3_s || 0) + 2 * dHyd;
      gasProduced.H2S_g = (gasProduced.H2S_g || 0) + 3 * dHyd;
      heatJ += dHyd * 290000;
      activeReactions.push({
        id: 'al2s3_hydrolysis',
        equation: 'Al₂S₃(s) + 6H₂O(l) → 2Al(OH)₃(s)↓ + 3H₂S(g)↑',
        nameVi: 'Thủy phân hoàn toàn Aluminium sulfide (Al₂S₃) sinh khí H₂S và Al(OH)₃',
        nameEn: 'Complete hydrolysis of Aluminium sulfide yielding Al(OH)₃↓ and H₂S↑',
        descVi: 'Al₂S₃ bị nước thủy phân mạnh và hoàn toàn ngay ở nhiệt độ thường tạo kết tủa keo trắng Al(OH)₃ và sủi bọt khí H₂S.',
        descEn: 'Aluminium sulfide hydrolyzes completely in water forming gelatinous white Al(OH)₃ and vigorous H₂S gas.',
        rateMolS: dHyd / dt,
        vigorousGas: true,
        dXi: dHyd,
      });
    }
  }

  // 5. Sulfur + Acids (HNO3 conc >= 60% @ 70-100C -> NO2; HNO3 dilute boiling >= 90C -> slow NO; H2SO4 conc 90-98% @ 100-120C -> SO2; H2SO4 dilute -> no reaction)
  const nSnow = moles.S_s || 0;
  if (nSnow > 1e-9) {
    const nNO3Tot = (moles.NO3_aq || 0) + (moles.HNO3_l || 0);
    const nHTot = (moles.H_aq || 0) + (moles.HNO3_l || 0);
    const mHNO3 = Math.min(nNO3Tot, nHTot) * 63.013;
    const wHNO3 = mHNO3 / Math.max(1e-9, mHNO3 + (moles.H2O_l || 0) * 18.015);
    if (wHNO3 >= 0.60 && T >= 343.15 && (moles.H_aq || 0) > 1e-4 && (moles.NO3_aq || 0) > 1e-4) {
      const tRamp = Math.min(1.0, 0.35 + ((T - 343.15) / 30.0) * 0.65);
      const dOxN = Math.min(nSnow, (moles.H_aq || 0) / 6, (moles.NO3_aq || 0) / 6) * (1 - Math.exp(-0.55 * tRamp * dt));
      if (dOxN > 1e-11) {
        moles.S_s = nSnow - dOxN;
        if (moles.S_s < 1e-13) delete moles.S_s;
        moles.H_aq = Math.max(0, moles.H_aq - 4 * dOxN);
        moles.NO3_aq = Math.max(0, moles.NO3_aq - 6 * dOxN);
        moles.SO4_2_aq = (moles.SO4_2_aq || 0) + dOxN;
        moles.H2O_l = (moles.H2O_l || 0) + 2 * dOxN;
        gasProduced.NO2_g = (gasProduced.NO2_g || 0) + 6 * dOxN;
        heatJ += dOxN * 410000;
        activeReactions.push({
          id: 's_hno3_conc_hot',
          equation: 'S(s) + 6HNO₃(đặc) —(70–100 °C)→ H₂SO₄ + 6NO₂(g)↑ + 2H₂O',
          nameVi: 'Sulfur bị HNO₃ đặc (63–68%+) oxi hóa nóng lên H₂SO₄ và NO₂ nâu đỏ',
          nameEn: 'Hot concentrated Nitric acid oxidizes Sulfur to H₂SO₄ + NO₂↑',
          descVi: 'Đun nóng nhẹ (70–100 °C) HNO₃ đặc 63–68%+ oxi hóa Sulfur thành SO₄²⁻ và giải phóng NO₂ nâu đỏ.',
          descEn: 'Gently heated (70–100 °C) conc. HNO₃ oxidizes S to Sulfate liberating brown NO₂ gas.',
          rateMolS: dOxN / dt,
          vigorousGas: true,
          dXi: dOxN,
        });
      }
    } else if (wHNO3 >= 0.05 && wHNO3 < 0.60 && T >= 363.15 && (moles.H_aq || 0) > 1e-4 && (moles.NO3_aq || 0) > 1e-4) {
      // Prolonged boiling with dilute HNO3 very slowly oxidizes S forming NO(g)
      const dOxNDil = Math.min(nSnow, (moles.H_aq || 0) / 2, (moles.NO3_aq || 0) / 2) * (1 - Math.exp(-0.045 * dt));
      if (dOxNDil > 1e-11) {
        moles.S_s = nSnow - dOxNDil;
        if (moles.S_s < 1e-13) delete moles.S_s;
        moles.NO3_aq = Math.max(0, moles.NO3_aq - 2 * dOxNDil);
        moles.SO4_2_aq = (moles.SO4_2_aq || 0) + dOxNDil;
        gasProduced.NO_g = (gasProduced.NO_g || 0) + 2 * dOxNDil;
        heatJ += dOxNDil * 180000;
        activeReactions.push({
          id: 's_hno3_dil_boil',
          equation: 'S(s) + 2HNO₃(loãng) —(đun sôi kéo dài)→ H₂SO₄ + 2NO(g)↑',
          nameVi: 'Sulfur phản ứng rất chậm với HNO₃ loãng đun sôi tạo SO₄²⁻ và khí NO',
          nameEn: 'Boiling dilute Nitric acid very slowly oxidizes Sulfur to H₂SO₄ + NO↑',
          descVi: 'Khi đun sôi kéo dài HNO₃ loãng, Sulfur bị oxi hóa rất chậm sinh khí không màu NO.',
          descEn: 'Prolonged boiling of dilute HNO₃ very slowly oxidizes S evolving NO gas.',
          rateMolS: dOxNDil / dt,
          dXi: dOxNDil,
        });
      }
    }

    const sulf = computeSulfuricAcidState(moles);
    if ((moles.S_s || 0) > 1e-9 && sulf.w >= 0.90 && T >= 373.15 && (moles.H2SO4_l || 0) > 1e-5) {
      // 90-98% H2SO4 oxidizes Sulfur when heated to 100-120 °C (near Sulfur 115 °C melting point); dilute does NOT react
      const meltRamp = T >= 388.15 ? 1.0 : 0.35 + ((T - 373.15) / 15.0) * 0.65;
      const dOxS = Math.min(moles.S_s, (moles.H2SO4_l || 0) / 2) * (1 - Math.exp(-0.48 * meltRamp * dt));
      if (dOxS > 1e-11) {
        moles.S_s -= dOxS;
        if (moles.S_s < 1e-13) delete moles.S_s;
        moles.H2SO4_l = Math.max(0, moles.H2SO4_l - 2 * dOxS);
        if (moles.H2SO4_l < 1e-13) delete moles.H2SO4_l;
        moles.H2O_l = (moles.H2O_l || 0) + 2 * dOxS;
        gasProduced.SO2_g = (gasProduced.SO2_g || 0) + 3 * dOxS;
        heatJ += dOxS * 120000;
        activeReactions.push({
          id: 's_h2so4_conc_hot',
          equation: 'S(s) + 2H₂SO₄(đặc 90–98%) —(100–120 °C)→ 3SO₂(g)↑ + 2H₂O',
          nameVi: 'Sulfur tác dụng với H₂SO₄ đặc (90–98%) nóng chảy ở 100–120 °C sinh khí SO₂',
          nameEn: 'Sulfur reduces hot concentrated H₂SO₄ (90–98%, 100–120 °C) evolving SO₂↑',
          descVi: 'Chỉ H₂SO₄ đặc 90–98% đun nóng 100–120 °C (gần điểm nóng chảy 115 °C của Sulfur) mới oxi hóa mạnh S thành SO₂↑; H₂SO₄ loãng không phản ứng.',
          descEn: 'Concentrated 90–98% H₂SO₄ at 100–120 °C oxidizes melting Sulfur to pungent SO₂↑; dilute acid does not react.',
          rateMolS: dOxS / dt,
          vigorousGas: true,
          dXi: dOxS,
        });
      }
    }

    if ((moles.S_s || 0) > 1e-9 && (moles.Cl2_aq || 0) > 1e-8 && (moles.H2O_l || 0) > 0.01) {
      const dClS = Math.min(moles.S_s, (moles.Cl2_aq || 0) / 3) * (1 - Math.exp(-0.35 * dt));
      if (dClS > 1e-11) {
        heatJ += applyEquilibriumShift({
          moles,
          dXi: dClS,
          deltas: { S_s: -1, Cl2_aq: -3, H2O_l: -4, SO4_2_aq: 1, Cl_aq: 6, H_aq: 8 },
          heatPerMolJ: 540000,
          dt,
          activeReactions,
          logThresholdRate: 1e-6,
          buildMeta: () => ({
            id: 's_cl2_aq_ox',
            equation: 'S(s) + 3Cl₂(aq) + 4H₂O → SO₄²⁻ + 6Cl⁻ + 8H⁺',
            nameVi: 'Nước Chlorine oxi hóa Sulfur thành acid',
            nameEn: 'Aqueous Chlorine oxidizes Sulfur to Sulfate and Chloride acid',
            descVi: 'Cl₂ trong nước oxi hóa chậm S về ion SO₄²⁻ + HCl.',
            descEn: 'Aqueous Chlorine slowly oxidizes S to Sulfate and acid.',
          }),
        });
      }
    }
  }

  // 6. Aqueous sulfide / acid equilibria: S2- + H2O <-> HS- + OH- and acidification -> H2S(g)
  if ((moles.H_aq || 0) > 1e-9 && ((moles.S2_aq || 0) > 1e-9 || (moles.HS_aq || 0) > 1e-9)) {
    const d1 = Math.min(moles.S2_aq || 0, moles.H_aq || 0) * Math.min(1, 22.0 * dt);
    if (d1 > 1e-12) applyEquilibriumShift({ moles, dXi: d1, deltas: { S2_aq: -1, H_aq: -1, HS_aq: 1 }, heatPerMolJ: 35000, dt, activeReactions });
    const d2 = Math.min(moles.HS_aq || 0, moles.H_aq || 0) * Math.min(1, 20.0 * dt);
    if (d2 > 1e-12) {
      moles.HS_aq = Math.max(0, (moles.HS_aq || 0) - d2);
      if (moles.HS_aq < 1e-13) delete moles.HS_aq;
      moles.H_aq = Math.max(0, (moles.H_aq || 0) - d2);
      if (moles.H_aq < 1e-13) delete moles.H_aq;
      gasProduced.H2S_g = (gasProduced.H2S_g || 0) + d2;
    }
  }

  return heatJ;
}

/**
 * Calcium carbide (CaC2) + commercial impurities (Ca3P2, CaS) AND Amorphous Carbon (C):
 * - CaC2 hydrolysis (H2O -> C2H2 + Ca(OH)2, HCl/H+ -> C2H2 + Ca2+, Ca3P2 -> PH3, CaS -> H2S)
 * - CaC2 + N2 (1000-1100 C -> CaCN2 + C), O2 (>600-700 C -> CaO + CO2/CO), Cl2/Br2, & oxide reduction (CuO, FeO, Fe2O3, ZnO)
 * - Amorphous C adsorption of gases/solutes, Boudouard CO2 -> 2CO (>= 800 C), combustion (<700 C -> CO2 vs >=800 C -> CO)
 * - Carbon pyrometallurgy of CuO (500-700 C), Fe2O3/Fe3O4/FeO (700-1000 C), ZnO (1000-1200 C)
 * - Water-gas (C + H2O(g) @ 1000 C -> CO + H2), conc HNO3 (80-100 C), conc H2SO4 (95-98% @ 120-180 C), H2 -> CH4, Al -> Al4C3, CaO -> CaC2
 */
function stepCarbideAndCarbonChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
  const moles = vessel.moles;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  const head = (vessel.headspaceGasMoles = vessel.headspaceGasMoles || {});
  const atmMode = options.environment?.atmosphereMode || 'air';
  const isInertAtm = atmMode === 'inert';
  const airFraction = isInertAtm || vessel.isStoppered ? 0 : Math.max(0, vessel.airO2PurgeFrac ?? 1);
  const liqMob = (moles.H2O_l || 0) > 1e-8 ? iceMob : 0;
  let heatJ = 0;

  // --- PART A: Commercial Calcium carbide (CaC2) & Impurities (Ca3P2, CaS, Al4C3 hydrolysis) ---
  if ((moles.CaC2_s || 0) > 1e-9) {
    // 1. Reaction with Acid (H+) first if acidic aqueous medium
    if (liquidVolL > 1e-6 && (moles.H_aq || 0) > 1e-5 && liqMob > 0) {
      const kAcid = Math.min(18, 8.5 * liqMob);
      const dCa = Math.min(moles.CaC2_s, (moles.H_aq || 0) / 2) * (1 - Math.exp(-kAcid * dt));
      if (dCa > 1e-11) {
        moles.CaC2_s -= dCa;
        if (moles.CaC2_s < 1e-13) delete moles.CaC2_s;
        moles.H_aq = Math.max(0, moles.H_aq - 2 * dCa);
        if (moles.H_aq < 1e-13) delete moles.H_aq;
        moles.Ca2_aq = (moles.Ca2_aq || 0) + dCa;
        gasProduced.C2H2_g = (gasProduced.C2H2_g || 0) + dCa;
        heatJ += dCa * 195000;
        activeReactions.push({
          id: 'cac2_acid',
          equation: 'CaC₂(s) + 2H⁺(aq) → Ca²⁺(aq) + C₂H₂(g)↑',
          nameVi: 'Calcium carbide tác dụng mãnh liệt với acid sinh khí C₂H₂',
          nameEn: 'Calcium carbide reacts violently with acid evolving C₂H₂↑',
          descVi: 'CaC₂ phản ứng cực kỳ mãnh liệt với acid giải phóng khí Ethyne (C₂H₂).',
          descEn: 'CaC₂ reacts violently with acid liberating Ethyne (C₂H₂) gas.',
          rateMolS: dCa / dt,
          vigorousGas: true,
          dXi: dCa,
        });
      }
    }
    // 2. Vigorous hydrolysis with water (CaC2 + 2H2O -> C2H2 + Ca(OH)2)
    if ((moles.CaC2_s || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-6 && liqMob > 0) {
      const kHyd = 3.2 * liqMob * (0.85 + Math.min(1.5, (T - 273.15) / 80));
      const dHyd = Math.min(moles.CaC2_s, (moles.H2O_l || 0) / 2) * (1 - Math.exp(-kHyd * dt));
      if (dHyd > 1e-11) {
        moles.CaC2_s -= dHyd;
        if (moles.CaC2_s < 1e-13) delete moles.CaC2_s;
        moles.H2O_l = Math.max(0, moles.H2O_l - 2 * dHyd);
        if (moles.H2O_l < 1e-13) delete moles.H2O_l;
        if ((moles.H2O_l || 0) > 0.06) {
          moles.Ca2_aq = (moles.Ca2_aq || 0) + dHyd;
          moles.OH_aq = (moles.OH_aq || 0) + 2 * dHyd;
        } else {
          moles.CaOH2_s = (moles.CaOH2_s || 0) + dHyd;
        }
        gasProduced.C2H2_g = (gasProduced.C2H2_g || 0) + dHyd;
        heatJ += dHyd * 127200;
        activeReactions.push({
          id: 'cac2_hydrolysis',
          equation: 'CaC₂(s) + 2H₂O(l) → C₂H₂(g)↑ + Ca(OH)₂',
          nameVi: 'Thủy phân Calcium carbide điều chế khí Ethyne (C₂H₂)',
          nameEn: 'Calcium carbide hydrolyzes violently yielding C₂H₂↑ + Ca(OH)₂',
          descVi: 'CaC₂ thủy phân mãnh liệt ngay ở nhiệt độ thường, tỏa nhiệt và giải phóng khí C₂H₂.',
          descEn: 'CaC₂ hydrolyzes rapidly in water releasing exothermic heat and C₂H₂ gas.',
          rateMolS: dHyd / dt,
          vigorousGas: true,
          dXi: dHyd,
        });
      }
    }
    // 3. Dry Nitrogen at 1000-1100 °C -> CaCN2 + C (Cyanamide process)
    if ((moles.CaC2_s || 0) > 1e-9 && T >= 1273.15 && (head.N2_g || 0) > 1e-7) {
      const dN2 = Math.min(moles.CaC2_s, head.N2_g) * (1 - Math.exp(-0.55 * dt));
      if (dN2 > 1e-11) {
        moles.CaC2_s -= dN2;
        if (moles.CaC2_s < 1e-13) delete moles.CaC2_s;
        head.N2_g = Math.max(0, head.N2_g - dN2);
        moles.CaCN2_s = (moles.CaCN2_s || 0) + dN2;
        moles.C_s = (moles.C_s || 0) + dN2;
        heatJ += dN2 * 288000;
        activeReactions.push({
          id: 'cac2_n2',
          equation: 'CaC₂(s) + N₂(g) —(1,000–1,100 °C)→ CaCN₂(s) + C(s)',
          nameVi: 'Calcium carbide kết hợp N₂ ở 1,000–1,100 °C tạo Calcium cyanamide',
          nameEn: 'Calcium carbide fixes N₂ at 1,000–1,100 °C forming CaCN₂ + Carbon',
          descVi: 'Nung nóng CaC₂ trong luồng N₂ (1,000–1,100 °C) tạo hỗn hợp rắn đen CaCN₂ và Carbon.',
          descEn: 'Heating CaC₂ in Nitrogen at 1,000–1,100 °C produces CaCN₂ and black Carbon.',
          rateMolS: dN2 / dt,
          dXi: dN2,
        });
      }
    }
    // 4. Dry O2 combustion (> 600-700 °C)
    const nO2Av = (head.O2_g || 0) + (airFraction > 0 && !vessel.isStoppered && (moles.H2O_l || 0) < 0.02 ? 0.05 * airFraction : 0);
    if ((moles.CaC2_s || 0) > 1e-9 && T >= 873.15 && nO2Av > 1e-7 && (moles.H2O_l || 0) < 0.02) {
      const dOx = Math.min(moles.CaC2_s / 2, nO2Av / 5) * (1 - Math.exp(-0.75 * dt));
      if (dOx > 1e-11) {
        moles.CaC2_s -= 2 * dOx;
        if (moles.CaC2_s < 1e-13) delete moles.CaC2_s;
        if ((head.O2_g || 0) > 0) head.O2_g = Math.max(0, head.O2_g - Math.min(head.O2_g, 5 * dOx));
        moles.CaO_s = (moles.CaO_s || 0) + 2 * dOx;
        if (T >= 1073.15) {
          gasProduced.CO_g = (gasProduced.CO_g || 0) + 4 * dOx;
        } else {
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + 4 * dOx;
        }
        heatJ += dOx * 1450000;
        activeReactions.push({
          id: 'cac2_o2_burn',
          equation: T >= 1073.15 ? 'CaC₂(s) + 1.5O₂(g) —(>800 °C)→ CaO(s) + 2CO(g)↑' : '2CaC₂(s) + 5O₂(g) —(>600 °C)→ 2CaO(s) + 4CO₂(g)↑',
          nameVi: 'Calcium carbide cháy trong O₂ ở nhiệt độ cao',
          nameEn: 'Calcium carbide burns in Oxygen at high temperature',
          descVi: 'Trên 600–700 °C, CaC₂ cháy trong O₂ tạo CaO và khí oxide Carbon.',
          descEn: 'Above 600–700 °C, CaC₂ burns in O₂ forming CaO and Carbon oxides.',
          rateMolS: dOx / dt,
          dXi: dOx,
        });
      }
    }
    // 5. Dry Halogens (Cl2 / Br2)
    if ((moles.CaC2_s || 0) > 1e-9 && T >= 453.15 && (head.Cl2_g || 0) > 1e-7) {
      const dCl = Math.min(moles.CaC2_s, head.Cl2_g) * (1 - Math.exp(-1.1 * dt));
      if (dCl > 1e-11) {
        moles.CaC2_s -= dCl;
        if (moles.CaC2_s < 1e-13) delete moles.CaC2_s;
        head.Cl2_g = Math.max(0, head.Cl2_g - dCl);
        moles.CaCl2_s = (moles.CaCl2_s || 0) + dCl;
        moles.C_s = (moles.C_s || 0) + 2 * dCl;
        heatJ += dCl * 420000;
        activeReactions.push({
          id: 'cac2_cl2',
          equation: 'CaC₂(s) + Cl₂(g) —(t°)→ CaCl₂(s) + 2C(s)',
          nameVi: 'Calcium carbide cháy trong khí Cl₂ tạo CaCl₂ và muội than',
          nameEn: 'Calcium carbide reacts with hot Cl₂ forming CaCl₂ + Carbon soot',
          descVi: 'CaC₂ nóng phản ứng với Cl₂ giải phóng muội than đen Carbon và muối CaCl₂.',
          descEn: 'Hot CaC₂ reacts with Cl₂ yielding CaCl₂ and amorphous Carbon.',
          rateMolS: dCl / dt,
          dXi: dCl,
        });
      }
    }
    // 6. High-temperature CaC2 Metal Oxide Reduction (CuO, Cu2O, FeO, ZnO -> M + CaO + CO2/CO)
    if ((moles.CaC2_s || 0) > 1e-9 && T >= 973.15 && (moles.H2O_l || 0) < 0.02) {
      const cac2OxSpecs = [
        { oxId: 'CuO_s', metId: 'Cu_s', metMult: 1, minK: 973.15, stoichCo2: 5, stoichCo: 3 },
        { oxId: 'Cu2O_s', metId: 'Cu_s', metMult: 2, minK: 923.15, stoichCo2: 5, stoichCo: 3 },
        { oxId: 'FeO_s', metId: 'Fe_s', metMult: 1, minK: 1123.15, stoichCo2: 5, stoichCo: 3 },
        { oxId: 'ZnO_s', metId: 'Zn_s', metMult: 1, minK: 1223.15, stoichCo2: 5, stoichCo: 3 },
      ];
      for (const sp of cac2OxSpecs) {
        const nOx = moles[sp.oxId] || 0;
        if (nOx <= 1e-9 || (moles.CaC2_s || 0) <= 1e-9 || T < sp.minK) continue;
        const highT = T >= 1073.15;
        const stM = highT ? sp.stoichCo : sp.stoichCo2;
        const dRed = Math.min(moles.CaC2_s, nOx / stM) * (1 - Math.exp(-0.65 * dt));
        if (dRed > 1e-11) {
          moles.CaC2_s -= dRed;
          if (moles.CaC2_s < 1e-13) delete moles.CaC2_s;
          moles[sp.oxId] -= stM * dRed;
          if (moles[sp.oxId] < 1e-13) delete moles[sp.oxId];
          moles[sp.metId] = (moles[sp.metId] || 0) + (sp.metMult || 1) * stM * dRed;
          moles.CaO_s = (moles.CaO_s || 0) + dRed;
          if (highT) gasProduced.CO_g = (gasProduced.CO_g || 0) + 2 * dRed;
          else gasProduced.CO2_g = (gasProduced.CO2_g || 0) + 2 * dRed;
          heatJ += dRed * 320000;
          activeReactions.push({
            id: `cac2_red_${sp.oxId}`,
            equation: `CaC₂ + ${stM}${SPECIES[sp.oxId].formula} —(t°)→ ${stM}${SPECIES[sp.metId].formula} + CaO + 2${highT ? 'CO' : 'CO₂'}↑`,
            nameVi: `CaC₂ khử ${SPECIES[sp.oxId].formula} ở nhiệt độ cao tạo kim loại ${SPECIES[sp.metId].formula}`,
            nameEn: `Calcium carbide reduces ${SPECIES[sp.oxId].formula} at high T to metallic ${SPECIES[sp.metId].formula}`,
            descVi: 'Ở nhiệt độ cao trong luyện kim, CaC₂ khử mạnh oxit kim loại thành kim loại tự do.',
            descEn: 'At elevated metallurgical temperatures, CaC₂ reduces metal oxides to free metals.',
            rateMolS: dRed / dt,
            dXi: dRed,
          });
        }
      }
    }
  }

  // Impurity hydrolysis (Ca3P2 -> PH3↑, CaS -> H2S↑) giving commercial carbide its signature odor!
  if ((moles.Ca3P2_s || 0) > 1e-10 && ((moles.H2O_l || 0) > 1e-6 || (moles.H_aq || 0) > 1e-5) && liqMob > 0) {
    const dP = Math.min(moles.Ca3P2_s, (moles.H2O_l || 0) / 6 + (moles.H_aq || 0) / 6) * (1 - Math.exp(-3.6 * liqMob * dt));
    if (dP > 1e-12) {
      moles.Ca3P2_s -= dP;
      if (moles.Ca3P2_s < 1e-14) delete moles.Ca3P2_s;
      if ((moles.H2O_l || 0) >= 6 * dP) moles.H2O_l -= 6 * dP;
      moles.Ca2_aq = (moles.Ca2_aq || 0) + 3 * dP;
      if ((moles.H_aq || 0) >= 6 * dP) {
        moles.H_aq -= 6 * dP;
      } else {
        moles.OH_aq = (moles.OH_aq || 0) + 6 * dP;
      }
      gasProduced.PH3_g = (gasProduced.PH3_g || 0) + 2 * dP;
    }
  }
  if ((moles.CaS_s || 0) > 1e-10 && (moles.H2O_l || 0) > 1e-6 && liqMob > 0) {
    const dSImp = Math.min(moles.CaS_s, (moles.H2O_l || 0) / 2) * (1 - Math.exp(-2.8 * liqMob * dt));
    if (dSImp > 1e-12) {
      moles.CaS_s -= dSImp;
      if (moles.CaS_s < 1e-14) delete moles.CaS_s;
      moles.H2O_l = Math.max(0, moles.H2O_l - 2 * dSImp);
      moles.Ca2_aq = (moles.Ca2_aq || 0) + dSImp;
      moles.OH_aq = (moles.OH_aq || 0) + 2 * dSImp;
      gasProduced.H2S_g = (gasProduced.H2S_g || 0) + dSImp;
    }
  }

  // Impurity & Sulfate air-roasting / thermal decomposition for Đất đèn (300-600 C air roast; >1200 C CaSO4 decomp)
  const pO2CarbAir = getVesselEffectiveO2Bar(vessel, options.environment);
  const nO2ImpAir = (head.O2_g || 0) + (pO2CarbAir > 0.03 ? 0.08 * (pO2CarbAir / 0.21) : 0);
  if ((moles.H2O_l || 0) < 0.02 && T >= 573.15 && nO2ImpAir > 1e-7) {
    if ((moles.Ca3P2_s || 0) > 1e-9) {
      const dCaP = Math.min(moles.Ca3P2_s, nO2ImpAir / 4) * (1 - Math.exp(-0.65 * dt));
      if (dCaP > 1e-11) {
        moles.Ca3P2_s -= dCaP;
        if (moles.Ca3P2_s < 1e-13) delete moles.Ca3P2_s;
        if ((head.O2_g || 0) > 0) head.O2_g = Math.max(0, head.O2_g - Math.min(head.O2_g, 4 * dCaP));
        moles.Ca3PO4_2_s = (moles.Ca3PO4_2_s || 0) + dCaP;
        heatJ += dCaP * 1150000;
      }
    }
    if ((moles.CaS_s || 0) > 1e-9 && T >= 623.15) {
      const dCaS = Math.min(moles.CaS_s, nO2ImpAir / 2) * (1 - Math.exp(-0.55 * dt));
      if (dCaS > 1e-11) {
        moles.CaS_s -= dCaS;
        if (moles.CaS_s < 1e-13) delete moles.CaS_s;
        if ((head.O2_g || 0) > 0) head.O2_g = Math.max(0, head.O2_g - Math.min(head.O2_g, 2 * dCaS));
        moles.CaSO4_s = (moles.CaSO4_s || 0) + dCaS;
        heatJ += dCaS * 950000;
      }
    }
  }
  if ((moles.CaSO4_s || 0) > 1e-9 && T >= 1473.15 && (moles.H2O_l || 0) < 0.01) {
    const cBoost = (moles.C_s || 0) > 1e-8 ? 2.2 : 1.0;
    const dCaSO4 = moles.CaSO4_s * (1 - Math.exp(-0.08 * cBoost * dt));
    if (dCaSO4 > 1e-11) {
      moles.CaSO4_s -= dCaSO4;
      if (moles.CaSO4_s < 1e-13) delete moles.CaSO4_s;
      moles.CaO_s = (moles.CaO_s || 0) + dCaSO4;
      gasProduced.SO2_g = (gasProduced.SO2_g || 0) + dCaSO4;
      gasProduced.O2_g = (gasProduced.O2_g || 0) + 0.5 * dCaSO4;
      heatJ -= dCaSO4 * 498000;
      activeReactions.push({
        id: 'caso4_thermal_decomp',
        equation: '2CaSO₄(s) —(> 1,200 °C)→ 2CaO(s) + 2SO₂(g)↑ + O₂(g)↑',
        nameVi: 'Nhiệt phân một phần CaSO₄ ở > 1,200 °C tạo CaO và SO₂ + O₂',
        nameEn: 'High-temperature thermal decomposition of CaSO₄ (> 1,200 °C) yielding CaO + SO₂↑ + O₂↑',
        descVi: 'Trên 1,200–1,400 °C, CaSO₄ bắt đầu phân hủy giải phóng SO₂ và O₂ để lại CaO thiêu kết.',
        descEn: 'Above 1,200–1,400 °C, CaSO₄ partially decomposes releasing SO₂ and O₂.',
        rateMolS: dCaSO4 / dt,
        dXi: dCaSO4,
      });
    }
  }

  // Hydrolysis of newly synthesized metal carbides & KC8 (KC8->H2+KOH+C; Na2C2->C2H2; MgC2->C2H2; Mg2C3->C3H4 propyne; Fe3C+H+->CH4/H2)
  if ((moles.KC8_s || 0) > 1e-9 && ((moles.H2O_l || 0) > 1e-5 || (moles.H_aq || 0) > 1e-5) && liqMob > 0) {
    const dKC8 = Math.min(moles.KC8_s, (moles.H2O_l || 0) + (moles.H_aq || 0)) * (1 - Math.exp(-5.5 * liqMob * dt));
    if (dKC8 > 1e-11) {
      moles.KC8_s -= dKC8;
      if (moles.KC8_s < 1e-13) delete moles.KC8_s;
      moles.K_aq = (moles.K_aq || 0) + dKC8;
      if ((moles.H_aq || 0) >= dKC8) {
        moles.H_aq -= dKC8;
      } else {
        moles.H2O_l = Math.max(0, (moles.H2O_l || 0) - dKC8);
        moles.OH_aq = (moles.OH_aq || 0) + dKC8;
      }
      moles.C_s = (moles.C_s || 0) + 8 * dKC8;
      gasProduced.H2_g = (gasProduced.H2_g || 0) + 0.5 * dKC8;
      heatJ += dKC8 * 145000;
    }
  }
  if ((moles.Na2C2_s || 0) > 1e-9 && ((moles.H2O_l || 0) > 1e-5 || (moles.H_aq || 0) > 1e-5) && liqMob > 0) {
    const dNa2C2 = Math.min(moles.Na2C2_s, ((moles.H2O_l || 0) + (moles.H_aq || 0)) / 2) * (1 - Math.exp(-5.8 * liqMob * dt));
    if (dNa2C2 > 1e-11) {
      moles.Na2C2_s -= dNa2C2;
      if (moles.Na2C2_s < 1e-13) delete moles.Na2C2_s;
      moles.Na_aq = (moles.Na_aq || 0) + 2 * dNa2C2;
      if ((moles.H_aq || 0) >= 2 * dNa2C2) {
        moles.H_aq -= 2 * dNa2C2;
      } else {
        moles.H2O_l = Math.max(0, (moles.H2O_l || 0) - 2 * dNa2C2);
        moles.OH_aq = (moles.OH_aq || 0) + 2 * dNa2C2;
      }
      gasProduced.C2H2_g = (gasProduced.C2H2_g || 0) + dNa2C2;
      heatJ += dNa2C2 * 175000;
    }
  }
  if ((moles.MgC2_s || 0) > 1e-9 && ((moles.H2O_l || 0) > 1e-5 || (moles.H_aq || 0) > 1e-5) && liqMob > 0) {
    const dMgC2 = Math.min(moles.MgC2_s, ((moles.H2O_l || 0) + (moles.H_aq || 0)) / 2) * (1 - Math.exp(-2.8 * liqMob * dt));
    if (dMgC2 > 1e-11) {
      moles.MgC2_s -= dMgC2;
      if (moles.MgC2_s < 1e-13) delete moles.MgC2_s;
      if ((moles.H_aq || 0) >= 2 * dMgC2) {
        moles.H_aq -= 2 * dMgC2;
        moles.Mg2_aq = (moles.Mg2_aq || 0) + dMgC2;
      } else {
        moles.H2O_l = Math.max(0, (moles.H2O_l || 0) - 2 * dMgC2);
        moles.MgOH2_s = (moles.MgOH2_s || 0) + dMgC2;
      }
      gasProduced.C2H2_g = (gasProduced.C2H2_g || 0) + dMgC2;
      heatJ += dMgC2 * 135000;
    }
  }
  if ((moles.Mg2C3_s || 0) > 1e-9 && ((moles.H2O_l || 0) > 1e-5 || (moles.H_aq || 0) > 1e-5) && liqMob > 0) {
    const dMg2C3 = Math.min(moles.Mg2C3_s, ((moles.H2O_l || 0) + (moles.H_aq || 0)) / 4) * (1 - Math.exp(-2.5 * liqMob * dt));
    if (dMg2C3 > 1e-11) {
      moles.Mg2C3_s -= dMg2C3;
      if (moles.Mg2C3_s < 1e-13) delete moles.Mg2C3_s;
      if ((moles.H_aq || 0) >= 4 * dMg2C3) {
        moles.H_aq -= 4 * dMg2C3;
        moles.Mg2_aq = (moles.Mg2_aq || 0) + 2 * dMg2C3;
      } else {
        moles.H2O_l = Math.max(0, (moles.H2O_l || 0) - 4 * dMg2C3);
        moles.MgOH2_s = (moles.MgOH2_s || 0) + 2 * dMg2C3;
      }
      gasProduced.C3H4_g = (gasProduced.C3H4_g || 0) + dMg2C3;
      heatJ += dMg2C3 * 165000;
      activeReactions.push({
        id: 'mg2c3_hydrolysis',
        equation: 'Mg₂C₃(s) + 4H₂O(l) → 2Mg(OH)₂(s)↓ + C₃H₄(g)↑ (Propyne)',
        nameVi: 'Thủy phân Magnesium sesquicarbide sinh khí Propyne (C₃H₄)',
        nameEn: 'Hydrolysis of Mg₂C₃ yielding Mg(OH)₂↓ and Propyne (C₃H₄↑)',
        descVi: 'Mg₂C₃ thủy phân giải phóng khí Propyne (CH₃–C≡CH) thay vì Acetylene.',
        descEn: 'Mg₂C₃ hydrolyzes liberating Propyne (C₃H₄) gas instead of Acetylene.',
        rateMolS: dMg2C3 / dt,
        dXi: dMg2C3,
      });
    }
  }

  // Al4C3 hydrolysis with water / acid -> Al(OH)3 / Al3+ + CH4(g)↑
  if ((moles.Al4C3_s || 0) > 1e-9 && ((moles.H2O_l || 0) > 1e-5 || (moles.H_aq || 0) > 1e-5) && liqMob > 0) {
    const kAl = 1.6 * liqMob;
    const dAlC = Math.min(moles.Al4C3_s, (moles.H2O_l || 0) / 12 + (moles.H_aq || 0) / 12) * (1 - Math.exp(-kAl * dt));
    if (dAlC > 1e-11) {
      moles.Al4C3_s -= dAlC;
      if (moles.Al4C3_s < 1e-13) delete moles.Al4C3_s;
      if ((moles.H_aq || 0) >= 12 * dAlC) {
        moles.H_aq -= 12 * dAlC;
        moles.Al3_aq = (moles.Al3_aq || 0) + 4 * dAlC;
      } else {
        moles.H2O_l = Math.max(0, (moles.H2O_l || 0) - 12 * dAlC);
        moles.AlOH3_s = (moles.AlOH3_s || 0) + 4 * dAlC;
      }
      gasProduced.CH4_g = (gasProduced.CH4_g || 0) + 3 * dAlC;
      activeReactions.push({
        id: 'al4c3_hydrolysis',
        equation: 'Al₄C₃(s) + 12H₂O(l) → 4Al(OH)₃(s)↓ + 3CH₄(g)↑',
        nameVi: 'Thủy phân Aluminium carbide sinh khí Methane (CH₄)',
        nameEn: 'Aluminium carbide hydrolyzes yielding Al(OH)₃↓ + Methane (CH₄↑)',
        descVi: 'Al₄C₃ thủy phân giải phóng khí không màu Methane (CH₄).',
        descEn: 'Al₄C₃ hydrolyzes evolving colorless Methane (CH₄) gas.',
        rateMolS: dAlC / dt,
        dXi: dAlC,
      });
    }
  }

  // --- PART B: Amorphous Carbon (C_s) ---
  if ((moles.C_s || 0) > 1e-9) {
    // 1. Physical Adsorption of gases & dissolved colored solutes (at cool/moderate T < 420 K)
    if (T < 423.15) {
      const capMol = Math.max(0, moles.C_s * 0.22 - (vessel.carbonAdsorbedMol || 0));
      if (capMol > 1e-7) {
        let adsTotal = 0;
        for (const gId of ['NO2_g', 'H2S_g', 'Cl2_g', 'Br2_g', 'PH3_g']) {
          const hg = head[gId] || 0;
          if (hg > 1e-7 && adsTotal < capMol) {
            const take = Math.min(hg, (capMol - adsTotal) * 0.5) * (1 - Math.exp(-0.9 * dt));
            if (take > 1e-10) {
              head[gId] = hg - take;
              adsTotal += take;
            }
          }
        }
        if (liquidVolL > 1e-6) {
          for (const solId of ['I2_aq', 'Br2_aq', 'Phenolphthalein_aq']) {
            const ns = moles[solId] || 0;
            if (ns > 1e-8 && adsTotal < capMol) {
              const takeS = Math.min(ns, (capMol - adsTotal) * 0.5) * (1 - Math.exp(-0.75 * dt));
              if (takeS > 1e-10) {
                moles[solId] = ns - takeS;
                if (moles[solId] < 1e-13) delete moles[solId];
                adsTotal += takeS;
              }
            }
          }
        }
        if (adsTotal > 1e-9) {
          vessel.carbonAdsorbedMol = (vessel.carbonAdsorbedMol || 0) + adsTotal;
          activeReactions.push({
            id: 'c_adsorption',
            equation: 'C(xốp) + Chất tan/Khí → [Hấp phụ bề mặt]',
            nameVi: 'Carbon vô định hình hấp phụ khí màu & chất tan',
            nameEn: 'Amorphous Carbon adsorbs colored solutes & gases',
            descVi: 'Nhờ hệ thống lỗ xốp diện tích bề mặt lớn, Carbon hấp phụ mạnh chất màu và khí mùi.',
            descEn: 'Porous amorphous Carbon strongly adsorbs colored solutes and odorous gases.',
            rateMolS: adsTotal / dt,
            dXi: adsTotal,
          });
        }
      }
    }

    // 2. Boudouard Reduction above 800 °C: C(s) + CO2(g) -> 2CO(g)
    if (T >= 1073.15 && (head.CO2_g || 0) > 1e-7) {
      const dBoud = Math.min(moles.C_s, head.CO2_g) * (1 - Math.exp(-1.35 * dt));
      if (dBoud > 1e-11) {
        moles.C_s -= dBoud;
        if (moles.C_s < 1e-13) delete moles.C_s;
        head.CO2_g = Math.max(0, head.CO2_g - dBoud);
        gasProduced.CO_g = (gasProduced.CO_g || 0) + 2 * dBoud;
        heatJ -= dBoud * 172000;
        activeReactions.push({
          id: 'c_boudouard_co',
          equation: 'C(s) + CO₂(g) —(≥ 800 °C)→ 2CO(g)↑',
          nameVi: 'Carbon nóng đỏ khử ngược CO₂ thành CO ở trên 800 °C',
          nameEn: 'Incandescent Carbon reduces CO₂ back to CO above 800 °C',
          descVi: 'Trên 800–1,000 °C, CO₂ bị Carbon nóng đỏ khử thành khí độc CO là chủ yếu.',
          descEn: 'Above 800–1,000 °C, hot Carbon reduces CO₂ to CO gas.',
          rateMolS: dBoud / dt,
          dXi: dBoud,
        });
      }
    }

    // 3. Combustion in O2 / Air (300-500 °C -> CO2; >= 800 °C or O2-lean -> CO)
    const nO2C = (head.O2_g || 0) + (airFraction > 0 && !vessel.isStoppered && (moles.H2O_l || 0) < 0.02 ? 0.05 * airFraction : 0);
    if ((moles.C_s || 0) > 1e-9 && T >= 573.15 && nO2C > 1e-7 && (moles.H2O_l || 0) < 0.02) {
      const toCO = T >= 1073.15;
      const dComb = toCO
        ? Math.min(moles.C_s, 2 * nO2C) * (1 - Math.exp(-0.55 * dt))
        : Math.min(moles.C_s, nO2C) * (1 - Math.exp(-0.35 * dt));
      if (dComb > 1e-11) {
        moles.C_s -= dComb;
        if (moles.C_s < 1e-13) delete moles.C_s;
        const o2Use = toCO ? 0.5 * dComb : dComb;
        if ((head.O2_g || 0) > 0) head.O2_g = Math.max(0, head.O2_g - Math.min(head.O2_g, o2Use));
        if (toCO) gasProduced.CO_g = (gasProduced.CO_g || 0) + dComb;
        else gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dComb;
        heatJ += dComb * (toCO ? 110500 : 393500);
        activeReactions.push({
          id: toCO ? 'c_burn_co' : 'c_burn_co2',
          equation: toCO ? '2C(s) + O₂(g) —(≥ 800 °C)→ 2CO(g)↑' : 'C(s) + O₂(g) —(300–700 °C)→ CO₂(g)↑',
          nameVi: toCO ? 'Carbon cháy ở trên 800 °C tạo khí chủ yếu là CO' : 'Carbon cháy tỏa nhiệt mạnh tạo khí CO₂',
          nameEn: toCO ? 'Carbon burns above 800 °C producing predominantly CO↑' : 'Amorphous Carbon burns in O₂ forming CO₂↑',
          descVi: toCO ? 'Ở >800 °C sản phẩm khí chủ yếu là CO.' : 'Bột Carbon vô định hình dễ cháy ở 300–500 °C tạo CO₂.',
          descEn: toCO ? 'Above 800 °C, CO is the dominant gaseous product.' : 'Amorphous Carbon ignites around 300–500 °C forming CO₂.',
          rateMolS: dComb / dt,
          dXi: dComb,
        });
      }
    }

    // 4. Pyrometallurgical Oxide Reductions (only metals below Al; < 700-800C -> CO2, >= 800C -> CO!)
    if ((moles.C_s || 0) > 1e-9 && T >= 773.15 && (moles.H2O_l || 0) < 0.02) {
      const cRedSpecs = [
        { oxId: 'CuO_s', metId: 'Cu_s', oxSt: 1, metSt: 1, oAtoms: 1, minK: 773.15, name: 'CuO' },
        { oxId: 'Fe2O3_s', metId: 'Fe_s', oxSt: 1, metSt: 2, oAtoms: 3, minK: 973.15, name: 'Fe₂O₃' },
        { oxId: 'Fe3O4_s', metId: 'Fe_s', oxSt: 1, metSt: 3, oAtoms: 4, minK: 973.15, name: 'Fe₃O₄' },
        { oxId: 'FeO_s', metId: 'Fe_s', oxSt: 1, metSt: 1, oAtoms: 1, minK: 973.15, name: 'FeO' },
        { oxId: 'ZnO_s', metId: 'Zn_s', oxSt: 1, metSt: 1, oAtoms: 1, minK: 1273.15, name: 'ZnO' },
      ];
      for (const rs of cRedSpecs) {
        const nOx = moles[rs.oxId] || 0;
        if (nOx <= 1e-9 || (moles.C_s || 0) <= 1e-9 || T < rs.minK) continue;
        const makeCO = T >= 1073.15; // > 800 °C predominantly CO; < 700-800 °C primarily CO2
        const cPerOx = makeCO ? rs.oAtoms : rs.oAtoms * 0.5;
        const dM = Math.min(nOx, (moles.C_s || 0) / cPerOx) * (1 - Math.exp(-0.52 * dt));
        if (dM > 1e-11) {
          moles[rs.oxId] -= dM;
          if (moles[rs.oxId] < 1e-13) delete moles[rs.oxId];
          moles.C_s = Math.max(0, moles.C_s - cPerOx * dM);
          if (moles.C_s < 1e-13) delete moles.C_s;
          moles[rs.metId] = (moles[rs.metId] || 0) + rs.metSt * dM;
          if (makeCO) {
            gasProduced.CO_g = (gasProduced.CO_g || 0) + cPerOx * dM;
          } else {
            gasProduced.CO2_g = (gasProduced.CO2_g || 0) + cPerOx * dM;
          }
          heatJ -= dM * 85000;
          activeReactions.push({
            id: `c_red_${rs.oxId}`,
            equation: `${rs.name}(s) + ${cPerOx}C(s) —(t°)→ ${rs.metSt > 1 ? rs.metSt : ''}${SPECIES[rs.metId].formula} + ${cPerOx}${makeCO ? 'CO' : 'CO₂'}↑`,
            nameVi: `Carbon khử ${rs.name} thành ${SPECIES[rs.metId].formula} (khí ${makeCO ? 'CO' : 'CO₂'})`,
            nameEn: `Carbon reduces ${rs.name} to metallic ${SPECIES[rs.metId].formula} (evolving ${makeCO ? 'CO' : 'CO₂'})`,
            descVi: makeCO ? 'Trên 800–1,000 °C, sản phẩm khí chủ yếu là CO.' : 'Dưới 700 °C, sản phẩm khí chủ yếu là CO₂.',
            descEn: makeCO ? 'Above 800 °C, CO dominates gaseous product.' : 'Below 700 °C, CO₂ dominates gaseous product.',
            rateMolS: dM / dt,
            dXi: dM,
          });
        }
      }
    }

    // 5. Water-Gas Reaction with Steam (>= 1,000 °C): C + H2O(g) -> CO + H2
    if ((moles.C_s || 0) > 1e-9 && T >= 1273.15 && (head.H2O_g || 0) > 1e-7) {
      const dWG = Math.min(moles.C_s, head.H2O_g) * (1 - Math.exp(-0.85 * dt));
      if (dWG > 1e-11) {
        moles.C_s -= dWG;
        if (moles.C_s < 1e-13) delete moles.C_s;
        head.H2O_g = Math.max(0, head.H2O_g - dWG);
        gasProduced.CO_g = (gasProduced.CO_g || 0) + dWG;
        gasProduced.H2_g = (gasProduced.H2_g || 0) + dWG;
        heatJ -= dWG * 131300;
        activeReactions.push({
          id: 'c_water_gas',
          equation: 'C(s) + H₂O(g) —(≥ 1,000 °C)→ CO(g)↑ + H₂(g)↑',
          nameVi: 'Carbon nung đỏ phản ứng hơi nước tạo khí than ướt (CO + H₂)',
          nameEn: 'Steam over incandescent Carbon yields water gas (CO↑ + H₂↑)',
          descVi: 'Ở ~1,000 °C, hơi nước đi qua than đỏ tạo hỗn hợp khí CO và H₂.',
          descEn: 'At ~1,000 °C, steam reacts with hot Carbon producing CO and H₂.',
          rateMolS: dWG / dt,
          dXi: dWG,
        });
      }
    }

    // 6. Strong Oxidizing Acids: conc. HNO3 (>=60% @ 80-100 C) & conc. H2SO4 (>=90% @ 120-180 C); dilute -> NO reaction
    if ((moles.C_s || 0) > 1e-9 && liquidVolL > 1e-6) {
      const nNO3C = (moles.NO3_aq || 0) + (moles.HNO3_l || 0);
      const nHTC = (moles.H_aq || 0) + (moles.HNO3_l || 0);
      const mHNO3C = Math.min(nNO3C, nHTC) * 63.013;
      const wHNO3C = mHNO3C / Math.max(1e-9, mHNO3C + (moles.H2O_l || 0) * 18.015);
      if (wHNO3C >= 0.60 && T >= 343.15 && (moles.H_aq || 0) > 1e-4 && (moles.NO3_aq || 0) > 1e-4) {
        const dCN = Math.min(moles.C_s, (moles.H_aq || 0) / 4, (moles.NO3_aq || 0) / 4) * (1 - Math.exp(-0.48 * dt));
        if (dCN > 1e-11) {
          moles.C_s -= dCN;
          if (moles.C_s < 1e-13) delete moles.C_s;
          moles.H_aq = Math.max(0, moles.H_aq - 4 * dCN);
          moles.NO3_aq = Math.max(0, moles.NO3_aq - 4 * dCN);
          moles.H2O_l = (moles.H2O_l || 0) + 2 * dCN;
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dCN;
          gasProduced.NO2_g = (gasProduced.NO2_g || 0) + 4 * dCN;
          heatJ += dCN * 185000;
          activeReactions.push({
            id: 'c_hno3_conc',
            equation: 'C(s) + 4HNO₃(đặc) —(80–100 °C)→ CO₂(g)↑ + 4NO₂(g)↑ + 2H₂O',
            nameVi: 'Carbon khử HNO₃ đặc nóng tạo khí CO₂ và NO₂ nâu đỏ',
            nameEn: 'Amorphous Carbon oxidized by hot conc. HNO₃ → CO₂↑ + 4NO₂↑',
            descVi: 'Carbon vô định hình bị HNO₃ đặc (63–68%+) đun nóng 80–100 °C oxi hóa mạnh; acid loãng không phản ứng.',
            descEn: 'Hot conc. HNO₃ oxidizes amorphous Carbon to CO₂ + NO₂; dilute HNO₃ does not react.',
            rateMolS: dCN / dt,
            vigorousGas: true,
            dXi: dCN,
          });
        }
      }

      const sulfC = computeSulfuricAcidState(moles);
      if ((moles.C_s || 0) > 1e-9 && sulfC.w >= 0.90 && T >= 393.15 && (moles.H2SO4_l || 0) > 1e-5) {
        const dCS = Math.min(moles.C_s, (moles.H2SO4_l || 0) / 2) * (1 - Math.exp(-0.42 * dt));
        if (dCS > 1e-11) {
          moles.C_s -= dCS;
          if (moles.C_s < 1e-13) delete moles.C_s;
          moles.H2SO4_l = Math.max(0, moles.H2SO4_l - 2 * dCS);
          if (moles.H2SO4_l < 1e-13) delete moles.H2SO4_l;
          moles.H2O_l = (moles.H2O_l || 0) + 2 * dCS;
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dCS;
          gasProduced.SO2_g = (gasProduced.SO2_g || 0) + 2 * dCS;
          heatJ += dCS * 95000;
          activeReactions.push({
            id: 'c_h2so4_conc',
            equation: 'C(s) + 2H₂SO₄(đặc 95–98%) —(120–180 °C)→ CO₂(g)↑ + 2SO₂(g)↑ + 2H₂O',
            nameVi: 'Carbon khử H₂SO₄ đặc nóng sinh hỗn hợp khí CO₂ và SO₂',
            nameEn: 'Amorphous Carbon oxidized by hot conc. H₂SO₄ → CO₂↑ + 2SO₂↑',
            descVi: 'Chỉ H₂SO₄ đặc 95–98% đun mạnh 120–180 °C mới oxi hóa Carbon; H₂SO₄ <70% không phản ứng.',
            descEn: 'Only hot conc. H₂SO₄ (95–98%, 120–180 °C) oxidizes Carbon; dilute / <70% H₂SO₄ does not react.',
            rateMolS: dCS / dt,
            vigorousGas: true,
            dXi: dCS,
          });
        }
      }
    }

    // 7. Direct Metal + Carbon synthesis (REQUIRES inert Ar/N2/vacuum without O2 or CO2 — Zn forms NO carbide!)
    const isLowO2CarbideEnv = (isInertAtm || getVesselEffectiveO2Bar(vessel, options.environment) <= 0.03) && (head.CO2_g || 0) <= 1e-5;
    const isSealedVessel = Boolean(vessel.isStoppered || vessel.lidState === 'closed' || (vessel.leftStoppered && vessel.rightStoppered));

    if ((moles.C_s || 0) > 1e-9 && (moles.H2O_l || 0) < 0.02 && isLowO2CarbideEnv) {
      // K + 8C -> KC8 (200-400 C; red-copper intercalation compound)
      if ((moles.K_s || 0) > 1e-9 && T >= 473.15 && T <= 753.15) {
        const dKC8 = Math.min(moles.K_s, moles.C_s / 8) * (1 - Math.exp(-0.85 * dt));
        if (dKC8 > 1e-11) {
          moles.K_s -= dKC8;
          if (moles.K_s < 1e-13) delete moles.K_s;
          moles.C_s -= 8 * dKC8;
          if (moles.C_s < 1e-13) delete moles.C_s;
          moles.KC8_s = (moles.KC8_s || 0) + dKC8;
          heatJ += dKC8 * 85000;
          activeReactions.push({
            id: 'k_c_kc8',
            equation: 'K(l) + 8C(s) —(200–400 °C, khí trơ)→ KC₈(s)',
            nameVi: 'Potassium xen kẽ Carbon ở 200–400 °C tạo KC₈ đỏ đồng (không tạo K₂C₂)',
            nameEn: 'Potassium intercalates into Carbon at 200–400 °C forming red-copper KC₈',
            descVi: 'Trong chân không/Argon ở 200–400 °C, K tạo hợp chất xen lớp KC₈ màu đỏ đồng chứ không tạo acetylide K₂C₂.',
            descEn: 'In Ar/vacuum at 200–400 °C, K forms copper-red intercalation compound KC₈ directly.',
            rateMolS: dKC8 / dt,
            dXi: dKC8,
          });
        }
      }

      // 2Na + 2C -> Na2C2 (700-900 C, sealed vessel prevents Na boiling off at 883 C!)
      if ((moles.Na_s || 0) > 1e-9 && T >= 973.15 && (isSealedVessel || T <= 1156.15)) {
        const dNaC = Math.min(moles.Na_s / 2, moles.C_s / 2) * (1 - Math.exp(-(isSealedVessel ? 0.65 : 0.35) * dt));
        if (dNaC > 1e-11) {
          moles.Na_s -= 2 * dNaC;
          if (moles.Na_s < 1e-13) delete moles.Na_s;
          moles.C_s -= 2 * dNaC;
          if (moles.C_s < 1e-13) delete moles.C_s;
          moles.Na2C2_s = (moles.Na2C2_s || 0) + dNaC;
          heatJ += dNaC * 18000;
          activeReactions.push({
            id: 'na_c_na2c2',
            equation: '2Na(l/g) + 2C(s) —(700–900 °C, bình kín trơ)→ Na₂C₂(s)',
            nameVi: 'Sodium hóa hợp Carbon ở 700–900 °C (bình kín trơ) tạo Na₂C₂',
            nameEn: 'Sodium + Carbon in sealed inert vessel (700–900 °C) yields Na₂C₂',
            descVi: 'Cần bình kín chịu áp (giữ hơi Na sôi ở 883 °C) và khí trơ ở 700–900 °C để tạo Na₂C₂.',
            descEn: 'Sealed inert containment above 700 °C reacts molten/vapor Na with C forming Na₂C₂.',
            rateMolS: dNaC / dt,
            dXi: dNaC,
          });
        }
      }

      // Mg + C: ~500-600 C -> MgC2; >600 C -> Mg2C3 (+ 2MgC2 -> Mg2C3 + C)
      if ((moles.Mg_s || 0) > 1e-9 && T >= 773.15 && T < 873.15) {
        const dMgC2 = Math.min(moles.Mg_s, moles.C_s / 2) * (1 - Math.exp(-0.48 * dt));
        if (dMgC2 > 1e-11) {
          moles.Mg_s -= dMgC2;
          if (moles.Mg_s < 1e-13) delete moles.Mg_s;
          moles.C_s -= 2 * dMgC2;
          if (moles.C_s < 1e-13) delete moles.C_s;
          moles.MgC2_s = (moles.MgC2_s || 0) + dMgC2;
          activeReactions.push({
            id: 'mg_c_mgc2',
            equation: 'Mg(s) + 2C(s) —(~500 °C, khí trơ)→ MgC₂(s)',
            nameVi: 'Magnesium tác dụng Carbon ở ~500 °C (khí trơ) tạo MgC₂',
            nameEn: 'Magnesium + Carbon at ~500 °C (inert) forms MgC₂',
            descVi: 'Ở ~500 °C trong khí trơ tạo MgC₂ (thủy phân sinh C₂H₂); trên 600 °C chuyển thành Mg₂C₃.',
            descEn: 'At ~500 °C in inert gas forms MgC₂; above 600 °C converts to Mg₂C₃.',
            rateMolS: dMgC2 / dt,
            dXi: dMgC2,
          });
        }
      } else if ((moles.Mg_s || 0) > 1e-9 && T >= 873.15) {
        const dMg2C3 = Math.min(moles.Mg_s / 2, moles.C_s / 3) * (1 - Math.exp(-0.55 * dt));
        if (dMg2C3 > 1e-11) {
          moles.Mg_s -= 2 * dMg2C3;
          if (moles.Mg_s < 1e-13) delete moles.Mg_s;
          moles.C_s -= 3 * dMg2C3;
          if (moles.C_s < 1e-13) delete moles.C_s;
          moles.Mg2C3_s = (moles.Mg2C3_s || 0) + dMg2C3;
          activeReactions.push({
            id: 'mg_c_mg2c3',
            equation: '2Mg(s/l) + 3C(s) —(> 600 °C, khí trơ)→ Mg₂C₃(s)',
            nameVi: 'Magnesium tác dụng Carbon ở > 600 °C tạo Mg₂C₃',
            nameEn: 'Magnesium + Carbon above 600 °C (inert) forms Mg₂C₃',
            descVi: 'Trên 600 °C trong khí trơ, Mg và C tạo pha bền Mg₂C₃ (thủy phân sinh khí C₃H₄).',
            descEn: 'Above 600 °C in inert atmosphere, Mg and C yield Mg₂C₃ (hydrolyzing to C₃H₄).',
            rateMolS: dMg2C3 / dt,
            dXi: dMg2C3,
          });
        }
      }
      if ((moles.MgC2_s || 0) > 1e-9 && T >= 873.15) {
        const dConv = (moles.MgC2_s / 2) * (1 - Math.exp(-0.42 * dt));
        if (dConv > 1e-11) {
          moles.MgC2_s -= 2 * dConv;
          if (moles.MgC2_s < 1e-13) delete moles.MgC2_s;
          moles.Mg2C3_s = (moles.Mg2C3_s || 0) + dConv;
          moles.C_s = (moles.C_s || 0) + dConv;
        }
      }

      // 4Al + 3C -> Al4C3 (800-1200 C, inert/vacuum)
      if ((moles.Al_s || 0) > 1e-9 && T >= 1073.15) {
        const dAlCarb = Math.min((moles.Al_s || 0) / 4, moles.C_s / 3) * (1 - Math.exp(-0.42 * dt));
        if (dAlCarb > 1e-11) {
          moles.Al_s -= 4 * dAlCarb;
          if (moles.Al_s < 1e-13) delete moles.Al_s;
          moles.C_s -= 3 * dAlCarb;
          if (moles.C_s < 1e-13) delete moles.C_s;
          moles.Al4C3_s = (moles.Al4C3_s || 0) + dAlCarb;
          heatJ += dAlCarb * 209000;
          activeReactions.push({
            id: 'al_c_al4c3',
            equation: '4Al(s/l) + 3C(s) —(800–1,200 °C, khí trơ)→ Al₄C₃(s)',
            nameVi: 'Aluminium kết hợp với Carbon ở 800–1,200 °C tạo Al₄C₃',
            nameEn: 'Aluminium reacts with Carbon at 800–1,200 °C forming Al₄C₃',
            descVi: 'Ở 800–1,200 °C trong khí trơ Argon/chân không, Al nóng chảy kết hợp Carbon tạo tinh thể vàng Al₄C₃.',
            descEn: 'At 800–1,200 °C in inert Ar/vacuum, molten Al reacts with Carbon forming yellow Al₄C₃.',
            rateMolS: dAlCarb / dt,
            dXi: dAlCarb,
          });
        }
      }

      // 3Fe + C -> Fe3C (> 1,150 C, inert/vacuum cementite; Zn forms NO carbide!)
      if ((moles.Fe_s || 0) > 1e-9 && T >= 1423.15) {
        const dFeC = Math.min((moles.Fe_s || 0) / 3, moles.C_s) * (1 - Math.exp(-0.35 * dt));
        if (dFeC > 1e-11) {
          moles.Fe_s -= 3 * dFeC;
          if (moles.Fe_s < 1e-13) delete moles.Fe_s;
          moles.C_s -= dFeC;
          if (moles.C_s < 1e-13) delete moles.C_s;
          moles.Fe3C_s = (moles.Fe3C_s || 0) + dFeC;
          activeReactions.push({
            id: 'fe_c_fe3c',
            equation: '3Fe(s) + C(s) —(> 1,150 °C, khí trơ)→ Fe₃C(s) (Cementite)',
            nameVi: 'Iron hòa tan Carbon ở > 1,150 °C tạo Xementit (Fe₃C)',
            nameEn: 'Iron reacts with Carbon above 1,150 °C forming Cementite (Fe₃C)',
            descVi: 'Trên 1,150 °C trong khí trơ/chân không, Iron và Carbon tạo Fe₃C (Zn hoàn toàn không phản ứng với C).',
            descEn: 'Above 1,150 °C in inert/vacuum atmosphere, Fe and C form Fe₃C (Zn forms no carbide).',
            rateMolS: dFeC / dt,
            dXi: dFeC,
          });
        }
      }

      // Carbothermal CaO + 3C -> CaC2 + CO in inert/closed crucible (begins 1,400-1,500 C!)
      if ((moles.CaO_s || 0) > 1e-9 && T >= 1673.15) {
        const arcRate = T >= 1773.15 ? 0.35 : 0.14;
        const dArc = Math.min(moles.CaO_s, moles.C_s / 3) * (1 - Math.exp(-arcRate * dt));
        if (dArc > 1e-11) {
          moles.CaO_s -= dArc;
          if (moles.CaO_s < 1e-13) delete moles.CaO_s;
          moles.C_s -= 3 * dArc;
          if (moles.C_s < 1e-13) delete moles.C_s;
          moles.CaC2_s = (moles.CaC2_s || 0) + dArc;
          gasProduced.CO_g = (gasProduced.CO_g || 0) + dArc;
          heatJ -= dArc * 464000;
          activeReactions.push({
            id: 'cao_3c_cac2',
            equation: 'CaO(s) + 3C(s) —(1,450–2,000 °C, kín/trơ)→ CaC₂(s) + CO(g)↑',
            nameVi: 'Cacbon khử CaO ở 1,400–1,500+ °C (khí trơ) tạo CaC₂ và CO↑',
            nameEn: 'Carbothermal reduction of CaO (1,450–2,000 °C, inert) → CaC₂ + CO↑',
            descVi: 'Từ 1,450–1,500 °C trong môi trường trơ không có không khí, Carbon bắt đầu khử CaO rắn tạo thêm CaC₂ và khí CO.',
            descEn: 'Above 1,450–1,500 °C in O₂-free furnace/inert gas, C reduces CaO forming CaC₂ and CO.',
            rateMolS: dArc / dt,
            dXi: dArc,
          });
        }
      }
    }

    // C + 2H2 -> CH4 (500-1000 C) kept outside low-O2 lock if H2 gas is present in sealed vessel
    if ((moles.C_s || 0) > 1e-9 && T >= 773.15 && (head.H2_g || 0) > 1e-7) {
      const dCH4 = Math.min(moles.C_s, head.H2_g / 2) * (1 - Math.exp(-0.28 * dt));
      if (dCH4 > 1e-11) {
        moles.C_s -= dCH4;
        if (moles.C_s < 1e-13) delete moles.C_s;
        head.H2_g = Math.max(0, head.H2_g - 2 * dCH4);
        gasProduced.CH4_g = (gasProduced.CH4_g || 0) + dCH4;
        heatJ += dCH4 * 74800;
        activeReactions.push({
          id: 'c_h2_ch4',
          equation: 'C(s) + 2H₂(g) —(500–1,000 °C)→ CH₄(g)↑',
          nameVi: 'Carbon tác dụng với H₂ ở nhiệt độ cao tạo khí Methane',
          nameEn: 'Carbon hydrogenates at 500–1,000 °C forming Methane (CH₄)',
          descVi: 'Carbon thể hiện tính oxi hóa tác dụng với H₂ tạo khí Methane (CH₄).',
          descEn: 'At 500–1,000 °C Carbon oxidizes H₂ forming Methane (CH₄).',
          rateMolS: dCH4 / dt,
          dXi: dCH4,
        });
      }
    }
  }

  return heatJ;
}

function stepAmmineComplexEquilibria(vessel, liquidVolL, dt, activeReactions) {
  const moles = vessel.moles;
  if ((moles.H2O_l || 0) <= 1e-7 || liquidVolL <= 1e-6) return 0;

  let heatJ = 0;
  const cNH3 = (moles.NH3_aq || 0) / liquidVolL;
  const cH = (moles.H_aq || 0) / liquidVolL;
  const relax = Math.min(1, 22.0 * dt);

  // 1. Copper(II) hydroxide <-> Tetraamminecopper(II)
  const nCuOH2 = moles.CuOH2_s || 0;
  const nCuAmm = moles.CuNH3_4_2_aq || 0;
  if (nCuOH2 + nCuAmm > 1e-11) {
    const fracCu = cNH3 > 0.15 ? Math.min(1.0, (cNH3 - 0.15) / 0.30) : 0;
    const targetCu = (nCuOH2 + nCuAmm) * fracCu;
    let dXi = (targetCu - nCuAmm) * relax;
    if (dXi > 1e-11 && cH < 1e-4) {
      dXi = Math.min(dXi, nCuOH2, (moles.NH3_aq || 0) / 4);
      heatJ += applyEquilibriumShift({
        moles,
        dXi,
        deltas: { CuOH2_s: -1, NH3_aq: -4, CuNH3_4_2_aq: 1, OH_aq: 2 },
        heatPerMolJ: -22000,
        dt,
        activeReactions,
        buildMeta: () => ({
          id: 'cu_ammine_complex',
          equation: 'Cu(OH)₂(s) + 4NH₃(aq) ⇌ [Cu(NH₃)₄]²⁺(aq) + 2OH⁻(aq)',
          nameVi: 'Tạo phức xanh thẫm [Cu(NH₃)₄]²⁺ trong NH₃ dư',
          nameEn: 'Formation of deep violet-blue [Cu(NH₃)₄]²⁺ in excess NH₃',
          descVi: 'Kết tủa Cu(OH)₂ tan trong NH₃ dư tạo phức xanh tím đặc trưng [Cu(NH₃)₄]²⁺.',
          descEn: 'Blue Cu(OH)₂ precipitate dissolves in excess NH₃ forming deep royal violet-blue [Cu(NH₃)₄]²⁺.',
        }),
      });
    } else if (dXi < -1e-11 && cH < 1e-4) {
      if ((moles.OH_aq || 0) >= 2 * Math.abs(dXi)) {
        dXi = Math.max(dXi, -nCuAmm, -(moles.OH_aq || 0) / 2);
        heatJ += applyEquilibriumShift({
          moles,
          dXi,
          deltas: { CuOH2_s: -1, NH3_aq: -4, CuNH3_4_2_aq: 1, OH_aq: 2 },
          heatPerMolJ: -22000,
          dt,
          activeReactions,
          buildMeta: () => ({
            id: 'cu_ammine_complex',
            equation: '[Cu(NH₃)₄]²⁺(aq) + 2OH⁻(aq) → Cu(OH)₂(s)↓ + 4NH₃(aq)',
            nameVi: 'Tái kết tủa Cu(OH)₂ khi giảm NH₃',
            nameEn: 'Reprecipitation of Cu(OH)₂ upon NH₃ depletion',
            descVi: 'Giảm nồng độ NH₃ làm phức [Cu(NH₃)₄]²⁺ tách lại kết tủa Cu(OH)₂.',
            descEn: 'Depleting NH₃ shifts [Cu(NH₃)₄]²⁺ back into blue Cu(OH)₂ precipitate.',
          }),
        });
      } else {
        dXi = Math.max(dXi, -nCuAmm, -(moles.H2O_l || 0) / 2);
        heatJ += applyEquilibriumShift({
          moles,
          dXi,
          deltas: { CuNH3_4_2_aq: 1, H2O_l: 2, CuOH2_s: -1, NH3_aq: -2, NH4_aq: -2 },
          heatPerMolJ: 0,
          dt,
          activeReactions,
          buildMeta: () => ({
            id: 'cu_ammine_complex',
            equation: '[Cu(NH₃)₄]²⁺(aq) + 2H₂O(l) → Cu(OH)₂(s)↓ + 2NH₃(aq) + 2NH₄⁺(aq)',
            nameVi: 'Thủy phân [Cu(NH₃)₄]²⁺ tái tạo Cu(OH)₂',
            nameEn: 'Hydrolysis of [Cu(NH₃)₄]²⁺ upon NH₃ loss',
            descVi: 'NH₃ bay hơi làm phức [Cu(NH₃)₄]²⁺ phân hủy tái tạo kết tủa xanh lam Cu(OH)₂.',
            descEn: 'Loss of free NH₃ decomposes [Cu(NH₃)₄]²⁺ back into blue Cu(OH)₂.',
          }),
        });
      }
    }
  }

  // 2. Silver chloride <-> Diamminesilver(I)
  const nAgCl = moles.AgCl_s || 0;
  const nAgAmm = moles.AgNH3_2_aq || 0;
  const nCl = moles.Cl_aq || 0;
  const fracAg = cNH3 > 0.12 ? Math.min(1.0, (cNH3 - 0.12) / 0.25) : 0;
  if (nAgCl + nAgAmm > 1e-11 && (nAgCl > 1e-11 || nCl > 1e-11)) {
    const targetAgClComp = (nAgCl + Math.min(nAgAmm, nCl + nAgCl)) * fracAg;
    let dXi = (targetAgClComp - nAgAmm) * relax;
    if (dXi > 1e-11 && cH < 1e-4) {
      dXi = Math.min(dXi, nAgCl, (moles.NH3_aq || 0) / 2);
      heatJ += applyEquilibriumShift({
        moles,
        dXi,
        deltas: { AgCl_s: -1, NH3_aq: -2, AgNH3_2_aq: 1, Cl_aq: 1 },
        heatPerMolJ: -14000,
        dt,
        activeReactions,
        buildMeta: () => ({
          id: 'agcl_ammine_complex',
          equation: 'AgCl(s) + 2NH₃(aq) ⇌ [Ag(NH₃)₂]⁺(aq) + Cl⁻(aq)',
          nameVi: 'Hòa tan kết tủa trắng AgCl trong dung dịch NH₃',
          nameEn: 'Dissolution of white AgCl precipitate in NH₃',
          descVi: 'NH₃ tạo phức tan không màu [Ag(NH₃)₂]⁺ làm tan hoàn toàn kết tủa trắng AgCl.',
          descEn: 'Ammonia coordinates Ag⁺ to dissolve white AgCl into colorless [Ag(NH₃)₂]⁺.',
        }),
      });
    } else if (dXi < -1e-11 && cH < 1e-4 && nCl > 1e-11) {
      dXi = Math.max(dXi, -nAgAmm, -nCl);
      heatJ += applyEquilibriumShift({
        moles,
        dXi,
        deltas: { AgCl_s: -1, NH3_aq: -2, AgNH3_2_aq: 1, Cl_aq: 1 },
        heatPerMolJ: -14000,
        dt,
        activeReactions,
        buildMeta: () => ({
          id: 'agcl_ammine_complex',
          equation: '[Ag(NH₃)₂]⁺(aq) + Cl⁻(aq) → AgCl(s)↓ + 2NH₃(aq)',
          nameVi: 'Tái kết tủa trắng AgCl khi giảm NH₃',
          nameEn: 'Reprecipitation of AgCl upon NH₃ depletion',
          descVi: 'Mất NH₃ làm tách trở lại kết tủa trắng AgCl.',
          descEn: 'Depleting NH₃ shifts equilibrium back to white AgCl(s).',
        }),
      });
    }
  }

  // 3. Silver oxide <-> Diamminesilver(I)
  const nAg2O = moles.Ag2O_s || 0;
  const nAgAmmNow = moles.AgNH3_2_aq || 0;
  const nClNow = moles.Cl_aq || 0;
  if (nAg2O > 1e-11 || (nAgAmmNow > 1e-11 && nClNow < 1e-11)) {
    const totalAgAtoms = 2 * nAg2O + nAgAmmNow;
    const targetComp = totalAgAtoms * fracAg;
    let dXi = ((targetComp - nAgAmmNow) / 2) * relax;
    if (dXi > 1e-11 && cH < 1e-4 && nAg2O > 1e-11) {
      dXi = Math.min(dXi, nAg2O, (moles.NH3_aq || 0) / 4, moles.H2O_l || 0);
      heatJ += applyEquilibriumShift({
        moles,
        dXi,
        deltas: { Ag2O_s: -1, NH3_aq: -4, H2O_l: -1, AgNH3_2_aq: 2, OH_aq: 2 },
        heatPerMolJ: -18000,
        dt,
        activeReactions,
        buildMeta: () => ({
          id: 'ag2o_ammine_complex',
          equation: 'Ag₂O(s) + 4NH₃(aq) + H₂O(l) ⇌ 2[Ag(NH₃)₂]⁺(aq) + 2OH⁻(aq)',
          nameVi: 'Hòa tan Ag₂O trong NH₃ tạo thuốc thử Tollens [Ag(NH₃)₂]⁺',
          nameEn: 'Dissolution of Ag₂O in NH₃ forming [Ag(NH₃)₂]⁺',
          descVi: 'Kết tủa nâu Ag₂O tan hết trong NH₃ dư tạo phức bạc ammine trong suốt.',
          descEn: 'Dark Ag₂O dissolves completely in excess NH₃ giving clear [Ag(NH₃)₂]⁺ solution.',
        }),
      });
    } else if (dXi < -1e-11 && cH < 1e-4 && nClNow < 1e-11) {
      if ((moles.OH_aq || 0) >= 2 * Math.abs(dXi)) {
        dXi = Math.max(dXi, -nAgAmmNow / 2, -(moles.OH_aq || 0) / 2);
        heatJ += applyEquilibriumShift({
          moles,
          dXi,
          deltas: { Ag2O_s: -1, NH3_aq: -4, H2O_l: -1, AgNH3_2_aq: 2, OH_aq: 2 },
          heatPerMolJ: -18000,
          dt,
          activeReactions,
          buildMeta: () => ({
            id: 'ag2o_ammine_complex',
            equation: '2[Ag(NH₃)₂]⁺(aq) + 2OH⁻(aq) → Ag₂O(s)↓ + 4NH₃(aq) + H₂O(l)',
            nameVi: 'Tái kết tủa Ag₂O khi mất NH₃',
            nameEn: 'Reprecipitation of Ag₂O upon NH₃ loss',
            descVi: 'Bay hơi hết NH₃ làm tách lại kết tủa nâu đen Ag₂O.',
            descEn: 'Depleting NH₃ shifts [Ag(NH₃)₂]⁺ back into Ag₂O(s).',
          }),
        });
      } else {
        dXi = Math.max(dXi, -nAgAmmNow / 2, -(moles.H2O_l || 0));
        heatJ += applyEquilibriumShift({
          moles,
          dXi,
          deltas: { AgNH3_2_aq: 2, H2O_l: 1, Ag2O_s: -1, NH3_aq: -2, NH4_aq: -2 },
          heatPerMolJ: 0,
          dt,
          activeReactions,
          buildMeta: () => ({
            id: 'ag2o_ammine_complex',
            equation: '2[Ag(NH₃)₂]⁺(aq) + H₂O(l) → Ag₂O(s)↓ + 2NH₃(aq) + 2NH₄⁺(aq)',
            nameVi: 'Thủy phân [Ag(NH₃)₂]⁺ khi mất NH₃',
            nameEn: 'Hydrolysis of [Ag(NH₃)₂]⁺ upon NH₃ loss',
            descVi: 'Bay hơi NH₃ làm phức [Ag(NH₃)₂]⁺ tách lại kết tủa Ag₂O.',
            descEn: 'Loss of NH₃ precipitates dark Ag₂O(s).',
          }),
        });
      }
    }
  }

  // 4. Zinc hydroxide <-> Tetraamminezinc(II)
  const nZnOH2 = moles.ZnOH2_s || 0;
  const nZnAmm = moles.ZnNH3_4_2_aq || 0;
  if (nZnOH2 + nZnAmm > 1e-11) {
    const fracZn = cNH3 > 0.18 ? Math.min(1.0, (cNH3 - 0.18) / 0.35) : 0;
    const targetZn = (nZnOH2 + nZnAmm) * fracZn;
    let dXi = (targetZn - nZnAmm) * relax;
    if (dXi > 1e-11 && cH < 1e-4) {
      dXi = Math.min(dXi, nZnOH2, (moles.NH3_aq || 0) / 4);
      heatJ += applyEquilibriumShift({
        moles,
        dXi,
        deltas: { ZnOH2_s: -1, NH3_aq: -4, ZnNH3_4_2_aq: 1, OH_aq: 2 },
        heatPerMolJ: -18000,
        dt,
        activeReactions,
        buildMeta: () => ({
          id: 'zn_ammine_complex',
          equation: 'Zn(OH)₂(s) + 4NH₃(aq) ⇌ [Zn(NH₃)₄]²⁺(aq) + 2OH⁻(aq)',
          nameVi: 'Tạo phức không màu [Zn(NH₃)₄]²⁺ trong NH₃ dư',
          nameEn: 'Dissolution of Zn(OH)₂ precipitate in excess NH₃ forming [Zn(NH₃)₄]²⁺',
          descVi: 'Kết tủa trắng Zn(OH)₂ tan trong dung dịch NH₃ dư tạo phức Tetraamminezinc(II) không màu.',
          descEn: 'White Zn(OH)₂ dissolves cleanly in excess NH₃ yielding colorless [Zn(NH₃)₄]²⁺.',
        }),
      });
    } else if (dXi < -1e-11 && cH < 1e-4 && (moles.OH_aq || 0) >= 2 * Math.abs(dXi)) {
      dXi = Math.max(dXi, -nZnAmm, -(moles.OH_aq || 0) / 2);
      heatJ += applyEquilibriumShift({
        moles,
        dXi,
        deltas: { ZnOH2_s: -1, NH3_aq: -4, ZnNH3_4_2_aq: 1, OH_aq: 2 },
        heatPerMolJ: -18000,
        dt,
        activeReactions,
        buildMeta: () => ({
          id: 'zn_ammine_complex',
          equation: '[Zn(NH₃)₄]²⁺(aq) + 2OH⁻(aq) → Zn(OH)₂(s)↓ + 4NH₃(aq)',
          nameVi: 'Tái kết tủa Zn(OH)₂ khi giảm NH₃',
          nameEn: 'Reprecipitation of Zn(OH)₂ upon NH₃ loss',
          descVi: 'Thiếu NH₃ làm tách trở lại kết tủa trắng Zn(OH)₂.',
          descEn: 'Depleting NH₃ shifts [Zn(NH₃)₄]²⁺ back to white Zn(OH)₂.',
        }),
      });
    }
  }

  return heatJ;
}

/**
 * Carbonate–CO2 aqueous equilibria:
 * - Dissolves headspace CO2(g) into H2CO3_aq (accelerated strongly by OH- trap)
 * - Fast stepwise protolysis H2CO3 <-> HCO3- <-> CO3^2- with H+ & OH-
 * - Releases CO2(g) bubbles when supersaturated (acidification of CO3^2- / HCO3- or thermal heating)
 */
function stepCarbonateAndCO2Equilibria(vessel, liquidVolL, dt, activeReactions, gasProduced) {
  const moles = vessel.moles;
  if ((moles.H2O_l || 0) <= 1e-7 || liquidVolL <= 1e-6) return 0;

  let heatJ = 0;
  const relax = Math.min(1, 24.0 * dt);

  // 1. Dissolve CO2(g) from headspace/bubbling into liquid water -> H2CO3_aq
  const headCo2 = vessel.headspaceGasMoles?.CO2_g || 0;
  if (headCo2 > 1e-9) {
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    const cNH3 = (moles.NH3_aq || 0) / liquidVolL;
    const absorbRate = (cOH > 1e-4 || cNH3 > 0.05 ? 6.5 : 1.2) * (vessel.stirTimer > 0 ? 1.8 : 1.0);
    const dAbs = Math.min(headCo2, headCo2 * Math.min(1, absorbRate * dt));
    if (dAbs > 1e-12) {
      vessel.headspaceGasMoles.CO2_g = Math.max(0, headCo2 - dAbs);
      moles.H2CO3_aq = (moles.H2CO3_aq || 0) + dAbs;
      heatJ += 19900 * dAbs;
    }
  }

  // 2. Stepwise acid/base carbonate proton transfers (+ Solvay NH3 carbonation)
  const nH = moles.H_aq || 0;
  const nOH = moles.OH_aq || 0;
  if ((moles.NH3_aq || 0) > 1e-12 && (moles.H2CO3_aq || 0) > 1e-12) {
    const dSolvay = Math.min(moles.NH3_aq, moles.H2CO3_aq) * relax;
    heatJ += applyEquilibriumShift({
      moles,
      dXi: dSolvay,
      deltas: { NH3_aq: -1, H2CO3_aq: -1, NH4_aq: 1, HCO3_aq: 1 },
      heatPerMolJ: -34000,
      dt,
      activeReactions,
      buildMeta: () => ({
        id: 'solvay_nh3_co2',
        equation: 'NH₃(aq) + CO₂(aq) + H₂O(l) → NH₄⁺(aq) + HCO₃⁻(aq)',
        nameVi: 'Hấp thụ CO₂ tạo NH₄HCO₃ (quy trình Solvay)',
        nameEn: 'Carbonation of ammoniated brine (Solvay intermediate step)',
        descVi: 'NH₃ phản ứng với H₂CO₃ tạo ion NH₄⁺ và HCO₃⁻; khi có NaCl bão hòa, NaHCO₃(s) ít tan kết tinh tách ra.',
        descEn: 'NH₃ converts CO₂(aq) to HCO₃⁻ + NH₄⁺; saturated Na⁺ brine triggers white NaHCO₃(s) crystallization.',
      }),
    });
  }
  if (nOH > 1e-12 && (moles.H2CO3_aq || 0) > 1e-12) {
    const d1 = Math.min(moles.H2CO3_aq, nOH) * relax;
    heatJ += applyEquilibriumShift({
      moles,
      dXi: d1,
      deltas: { H2CO3_aq: -1, OH_aq: -1, HCO3_aq: 1, H2O_l: 1 },
      heatPerMolJ: -48000,
      dt,
      activeReactions,
      buildMeta: () => ({
        id: 'co2_oh_bicarb',
        equation: 'CO₂(aq)/H₂CO₃ + OH⁻(aq) → HCO₃⁻(aq) + H₂O(l)',
        nameVi: 'Hấp thụ CO₂ trong dung dịch kiềm tạo HCO₃⁻',
        nameEn: 'Alkaline CO₂ absorption yielding Hydrogen carbonate',
        descVi: 'Dung dịch kiềm hấp thụ CO₂ nhanh chóng chuyển sang HCO₃⁻ / CO₃²⁻.',
        descEn: 'Hydroxide rapidly traps dissolved CO₂ as Hydrogen carbonate and Carbonate.',
      }),
    });
  }
  if ((moles.OH_aq || 0) > 1e-12 && (moles.HCO3_aq || 0) > 1e-12) {
    const d2 = Math.min(moles.HCO3_aq, moles.OH_aq) * relax;
    heatJ += applyEquilibriumShift({
      moles,
      dXi: d2,
      deltas: { HCO3_aq: -1, OH_aq: -1, CO3_2_aq: 1, H2O_l: 1 },
      heatPerMolJ: -41000,
      dt,
      activeReactions,
      logThresholdRate: 1e-3,
      buildMeta: () => ({
        id: 'bicarb_oh_carb',
        equation: 'HCO₃⁻(aq) + OH⁻(aq) → CO₃²⁻(aq) + H₂O(l)',
        nameVi: 'Chuyển hóa HCO₃⁻ thành CO₃²⁻ trong môi trường kiềm',
        nameEn: 'Deprotonation of HCO₃⁻ to Carbonate in alkali',
        descVi: 'OH⁻ dư chuyển ion HCO₃⁻ thành CO₃²⁻ (gây kết tủa CaCO₃↓ ngay khi có Ca²⁺).',
        descEn: 'Excess hydroxide converts HCO₃⁻ into CO₃²⁻ (immediately precipitating CaCO₃↓ with Ca²⁺).',
      }),
    });
  }
  if ((moles.H_aq || 0) > 1e-12 && (moles.CO3_2_aq || 0) > 1e-12) {
    const d3 = Math.min(moles.CO3_2_aq, moles.H_aq) * relax;
    heatJ += applyEquilibriumShift({
      moles,
      dXi: d3,
      deltas: { CO3_2_aq: -1, H_aq: -1, HCO3_aq: 1 },
      heatPerMolJ: -14000,
      dt,
      activeReactions,
      logThresholdRate: 1e-3,
      buildMeta: () => ({
        id: 'carb_protonate',
        equation: 'CO₃²⁻(aq) + H⁺(aq) → HCO₃⁻(aq)',
        nameVi: 'Acid hóa ion Carbonate thành Hydrogen carbonate',
        nameEn: 'Protonation of Carbonate to Hydrogen carbonate',
        descVi: 'Ion CO₃²⁻ nhận H⁺ tạo ion HCO₃⁻.',
        descEn: 'Carbonate accepts a proton forming HCO₃⁻.',
      }),
    });
  }
  if ((moles.H_aq || 0) > 1e-12 && (moles.HCO3_aq || 0) > 1e-12) {
    const d4 = Math.min(moles.HCO3_aq, moles.H_aq) * relax;
    heatJ += applyEquilibriumShift({
      moles,
      dXi: d4,
      deltas: { HCO3_aq: -1, H_aq: -1, H2CO3_aq: 1 },
      heatPerMolJ: -8000,
      dt,
      activeReactions,
      buildMeta: () => ({
        id: 'bicarb_acid_effervesce',
        equation: 'HCO₃⁻(aq) + H⁺(aq) → H₂O(l) + CO₂(g)↑',
        nameVi: 'Acid đẩy khí CO₂ khỏi muối Hydrogen carbonate',
        nameEn: 'Acidification of HCO₃⁻ liberating CO₂ gas',
        descVi: 'Ion H⁺ đẩy nhanh khí CO₂ sủi bọt mạnh từ dung dịch.',
        descEn: 'H⁺ immediately releases vigorous CO₂ gas bubbles from HCO₃⁻.',
      }),
    });
  }

  // 3. Effervesce excess H2CO3_aq -> H2O_l + CO2(g) when not trapping into CaCO3 dissolution
  const nAcidCO2 = moles.H2CO3_aq || 0;
  if (nAcidCO2 > 1e-7) {
    const tC = Math.max(0, vessel.tempK - CONSTANTS.KELVIN_OFFSET);
    const solEq = Math.max(0.0005, 0.034 * Math.exp(-0.025 * tC)) * liquidVolL;
    const isDissolvingCaCO3 = (moles.CaCO3_s || 0) > 1e-7 && (moles.OH_aq || 0) <= 1e-5;
    const maxHold = isDissolvingCaCO3 ? Math.max(solEq, nAcidCO2 * 0.45) : solEq;
    if (nAcidCO2 > maxHold && ((moles.H_aq || 0) > 1e-5 || tC >= 45 || ((moles.OH_aq || 0) < 1e-6 && (moles.NH3_aq || 0) < 1e-4))) {
      const ex = nAcidCO2 - maxHold;
      const dOut = Math.min(nAcidCO2, ex * Math.min(1, 2.8 * dt));
      if (dOut > 1e-11) {
        moles.H2CO3_aq = Math.max(0, nAcidCO2 - dOut);
        if (moles.H2CO3_aq < 1e-13) delete moles.H2CO3_aq;
        moles.H2O_l = (moles.H2O_l || 0) + dOut;
        gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dOut;
        heatJ -= 19900 * dOut;
      }
    }
  }

  return heatJ;
}

/**
 * Red Phosphorus (P_red_s) comprehensive inorganic solver (Prompt 52):
 *  a) Direct Metal + P synthesis (inert/sealed: K, Na, Mg, Ca, Ba, Al [cat. I2/AlCl3], Zn, Fe, Cu; Ag only sealed)
 *  b) Nonmetal reactions (Cl2 -> PCl3/PCl5, Br2 -> PBr3/PBr5, I2 -> PI3/P2I4, O2 -> P4O10/P4O6, S -> P4S3/P4S10, P4 sublimation >416 C; H2/C inert)
 *  c) Acid selectivity (HCl/dil H2SO4 inert; dil HNO3 hot -> NO; conc HNO3 -> NO2; hot conc H2SO4 >=150 C -> SO2)
 *  d) Base selectivity (dil NaOH/NH3 inert; conc NaOH >=4.5 M boiling -> PH3 + H2PO2- -> HPO3^2- + H2)
 *  e) Salt reactions (KMnO4 dry/aq, AgNO3 aq/molten + Ag3PO4 ppt, CuSO4 hot aq/dry CuO; CaCO3/BaCl2/NaCl/CaC2 inert)
 *  f) Hydrolyses of phosphides, halides, and oxides.
 */
function stepPhosphorusChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
  const moles = vessel.moles;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  const head = (vessel.headspaceGasMoles = vessel.headspaceGasMoles || {});
  const atmMode = options.environment?.atmosphereMode || 'air';
  const isInertAtm = atmMode === 'inert';
  const airFraction = isInertAtm || vessel.isStoppered || vessel.lidState === 'closed'
    ? 0
    : Math.max(0, vessel.airO2PurgeFrac ?? 1);
  const isSealedVessel = Boolean(vessel.isStoppered || vessel.lidState === 'closed' || (vessel.leftStoppered && vessel.rightStoppered));
  const isLowO2Env = isInertAtm || isSealedVessel || getVesselEffectiveO2Bar(vessel, options.environment) <= 0.03;
  const liqMob = (moles.H2O_l || 0) > 1e-8 ? iceMob : 0;
  let heatJ = 0;

  const consumeSpecies = (id, amt) => {
    moles[id] = Math.max(0, (moles[id] || 0) - amt);
    if (moles[id] < 1e-13) delete moles[id];
  };
  const consumeHead = (id, amt) => {
    head[id] = Math.max(0, (head[id] || 0) - amt);
    if (head[id] < 1e-13) head[id] = 0;
  };
  const pushRxn = (id, equation, nameVi, nameEn, descVi, descEn, dXi, vigorousGas = false) => {
    activeReactions.push({ id, equation, nameVi, nameEn, descVi, descEn, rateMolS: dXi / dt, vigorousGas, dXi });
  };

  // --- PART F1: Phosphide, Halide & Oxide Hydrolyses ---
  if (((moles.H2O_l || 0) > 1e-6 || (moles.H_aq || 0) > 1e-5) && (liqMob > 0 || (moles.H2O_l || 0) > 1e-5)) {
    const mob = Math.max(0.25, liqMob);
    // Oxides: P4O10 + 6H2O -> 4H3PO4(aq); P4O6 + 6H2O -> 4H3PO3(aq)
    for (const [oxId, prodId, rxnId, eq, nVi, nEn, heatMol] of [
      ['P4O10_s', 'H3PO4_aq', 'p4o10_hyd', 'P₄O₁₀(s) + 6H₂O(l) → 4H₃PO₄(aq)', 'Phosphorus pentoxide hấp thụ ẩm thủy phân mãnh liệt thành H₃PO₄', 'P₄O₁₀ hydrolyzes violently in water forming Phosphoric acid (H₃PO₄)', 377000],
      ['P4O6_s', 'H3PO3_aq', 'p4o6_hyd', 'P₄O₆(s) + 6H₂O(l) → 4H₃PO₃(aq)', 'Phosphorus trioxide thủy phân thành H₃PO₃', 'P₄O₆ hydrolyzes forming Phosphorous acid (H₃PO₃)', 260000],
    ]) {
      const nOx = moles[oxId] || 0;
      if (nOx > 1e-10 && (moles.H2O_l || 0) >= 6 * 1e-10) {
        const d = Math.min(nOx, (moles.H2O_l || 0) / 6) * (1 - Math.exp(-4.5 * mob * dt));
        if (d > 1e-11) {
          consumeSpecies(oxId, d);
          consumeSpecies('H2O_l', 6 * d);
          moles[prodId] = (moles[prodId] || 0) + 4 * d;
          heatJ += d * heatMol;
          pushRxn(rxnId, eq, nVi, nEn, eq, eq, d);
        }
      }
    }

    // Halides: PX3 + 3H2O -> H3PO3 + 3HX; PX5 + 4H2O -> H3PO4 + 5HX
    const halideSpecs = [
      ['PCl3_l', 3, 'H3PO3_aq', 3, 'Cl_aq', 'pcl3_hyd', 'PCl₃(l) + 3H₂O(l) → H₃PO₃(aq) + 3HCl(aq)', 'PCl₃ bốc khói thủy phân thành H₃PO₃ + HCl', 'PCl₃ hydrolyzes fuming into H₃PO₃ + HCl', 286000],
      ['PCl5_s', 4, 'H3PO4_aq', 5, 'Cl_aq', 'pcl5_hyd', 'PCl₅(s) + 4H₂O(l) → H₃PO₄(aq) + 5HCl(aq)', 'PCl₅ thủy phân mãnh liệt thành H₃PO₄ + HCl', 'PCl₅ hydrolyzes vigorously into H₃PO₄ + HCl', 540000],
      ['PBr3_l', 3, 'H3PO3_aq', 3, 'Br_aq', 'pbr3_hyd', 'PBr₃(l) + 3H₂O(l) → H₃PO₃(aq) + 3HBr(aq)', 'PBr₃ thủy phân tạo H₃PO₃ + HBr', 'PBr₃ hydrolyzes yielding H₃PO₃ + HBr', 270000],
      ['PBr5_s', 4, 'H3PO4_aq', 5, 'Br_aq', 'pbr5_hyd', 'PBr₅(s) + 4H₂O(l) → H₃PO₄(aq) + 5HBr(aq)', 'PBr₅ thủy phân thành H₃PO₄ + HBr', 'PBr₅ hydrolyzes yielding H₃PO₄ + HBr', 460000],
      ['PI3_s', 3, 'H3PO3_aq', 3, 'I_aq', 'pi3_hyd', 'PI₃(s) + 3H₂O(l) → H₃PO₃(aq) + 3HI(aq)', 'PI₃ thủy phân hoàn toàn thành H₃PO₃ + HI', 'PI₃ hydrolyzes yielding H₃PO₃ + HI', 220000],
    ];
    for (const [halId, wSt, acidId, xSt, ionId, rxnId, eq, nVi, nEn, heatMol] of halideSpecs) {
      const nHal = moles[halId] || 0;
      if (nHal > 1e-10 && (moles.H2O_l || 0) > 1e-6) {
        const d = Math.min(nHal, (moles.H2O_l || 0) / wSt) * (1 - Math.exp(-3.8 * mob * dt));
        if (d > 1e-11) {
          consumeSpecies(halId, d);
          consumeSpecies('H2O_l', wSt * d);
          moles[acidId] = (moles[acidId] || 0) + d;
          moles[ionId] = (moles[ionId] || 0) + xSt * d;
          moles.H_aq = (moles.H_aq || 0) + xSt * d;
          heatJ += d * heatMol;
          pushRxn(rxnId, eq, nVi, nEn, eq, eq, d);
        }
      }
    }
    if ((moles.P2I4_s || 0) > 1e-10 && (moles.H2O_l || 0) > 1e-6) {
      const d24 = Math.min(moles.P2I4_s, (moles.H2O_l || 0) / 5) * (1 - Math.exp(-3.2 * mob * dt));
      if (d24 > 1e-11) {
        consumeSpecies('P2I4_s', d24);
        consumeSpecies('H2O_l', 5 * d24);
        moles.H3PO2_aq = (moles.H3PO2_aq || 0) + d24;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + d24;
        moles.H_aq = (moles.H_aq || 0) + 4 * d24;
        moles.I_aq = (moles.I_aq || 0) + 4 * d24;
        heatJ += d24 * 185000;
        pushRxn('p2i4_hyd', 'P₂I₄(s) + 5H₂O(l) → H₃PO₂(aq) + H₃PO₃(aq) + 4HI(aq)', 'P₂I₄ thủy phân trong nước', 'P₂I₄ hydrolyzes into H₃PO₂ + H₃PO₃ + HI', 'P₂I₄ thủy phân thành hỗn hợp acid chứa Phosphorus và HI.', 'P₂I₄ hydrolyzes forming Phosphorus oxyacids and HI.', d24);
      }
    }

    // Phosphide hydrolyses -> PH3↑
    const phosphideHydSpecs = [
      ['K3P_s', 3, 'K_aq', 3, 'OH_aq', 3, 1, 'k3p_hyd', 'K₃P(s) + 3H₂O(l) → 3KOH(aq) + PH₃(g)↑', 'K₃P thủy phân mãnh liệt sinh khí PH₃'],
      ['Na3P_s', 3, 'Na_aq', 3, 'OH_aq', 3, 1, 'na3p_hyd', 'Na₃P(s) + 3H₂O(l) → 3NaOH(aq) + PH₃(g)↑', 'Na₃P thủy phân sinh khí PH₃'],
      ['Mg3P2_s', 6, 'MgOH2_s', 3, null, 0, 2, 'mg3p2_hyd', 'Mg₃P₂(s) + 6H₂O(l) → 3Mg(OH)₂(s)↓ + 2PH₃(g)↑', 'Mg₃P₂ thủy phân sinh khí PH₃ và kết tủa Mg(OH)₂'],
      ['Ba3P2_s', 6, 'Ba2_aq', 3, 'OH_aq', 6, 2, 'ba3p2_hyd', 'Ba₃P₂(s) + 6H₂O(l) → 3Ba(OH)₂(aq) + 2PH₃(g)↑', 'Ba₃P₂ thủy phân sinh khí PH₃'],
      ['AlP_s', 3, 'AlOH3_s', 1, null, 0, 1, 'alp_hyd', 'AlP(s) + 3H₂O(l) → Al(OH)₃(s)↓ + PH₃(g)↑', 'AlP thủy phân từ từ sinh khí PH₃ độc hại'],
    ];
    for (const [phId, wSt, p1, c1, p2, c2, ph3St, rxnId, eq, nVi] of phosphideHydSpecs) {
      const nPh = moles[phId] || 0;
      if (nPh > 1e-10 && (moles.H2O_l || 0) >= wSt * 1e-10) {
        const d = Math.min(nPh, (moles.H2O_l || 0) / wSt) * (1 - Math.exp(-2.8 * mob * dt));
        if (d > 1e-11) {
          consumeSpecies(phId, d);
          consumeSpecies('H2O_l', wSt * d);
          if (p1) moles[p1] = (moles[p1] || 0) + c1 * d;
          if (p2) moles[p2] = (moles[p2] || 0) + c2 * d;
          gasProduced.PH3_g = (gasProduced.PH3_g || 0) + ph3St * d;
          heatJ += d * 185000;
          pushRxn(rxnId, eq, nVi, `${SPECIES[phId].formula} hydrolyzes evolving toxic PH₃(g)↑`, eq, eq, d, true);
        }
      }
    }
    // Zn3P2 requires acid (does NOT rapidly hydrolyze in neutral cold water)
    if ((moles.Zn3P2_s || 0) > 1e-10 && (moles.H_aq || 0) > 1e-5 && liquidVolL > 1e-6) {
      const dZnP = Math.min(moles.Zn3P2_s, moles.H_aq / 6) * (1 - Math.exp(-3.2 * mob * dt));
      if (dZnP > 1e-11) {
        consumeSpecies('Zn3P2_s', dZnP);
        consumeSpecies('H_aq', 6 * dZnP);
        moles.Zn2_aq = (moles.Zn2_aq || 0) + 3 * dZnP;
        gasProduced.PH3_g = (gasProduced.PH3_g || 0) + 2 * dZnP;
        heatJ += dZnP * 210000;
        pushRxn('zn3p2_acid', 'Zn₃P₂(s) + 6H⁺(aq) → 3Zn²⁺(aq) + 2PH₃(g)↑', 'Zn₃P₂ tan trong acid giải phóng khí PH₃', 'Zn₃P₂ dissolves in acid evolving PH₃ gas', 'Zn₃P₂ bền trong nước lạnh nhưng tan trong acid giải phóng khí PH₃.', 'Zn₃P₂ resists cold water but dissolves in acid releasing PH₃ gas.', dZnP, true);
      }
    }
  }

  // --- PART F2: Thermal equilibria & decompositions of P halides, P4(g), PH3, AgP2 ---
  if ((moles.PCl5_s || 0) > 1e-9 && T >= 433.15) {
    const dDiss = moles.PCl5_s * (1 - Math.exp(-0.95 * dt));
    if (dDiss > 1e-11) {
      consumeSpecies('PCl5_s', dDiss);
      moles.PCl3_l = (moles.PCl3_l || 0) + dDiss;
      gasProduced.Cl2_g = (gasProduced.Cl2_g || 0) + dDiss;
      heatJ -= dDiss * 92000;
      pushRxn('pcl5_dissoc', 'PCl₅(s) ⇌ PCl₃(l/g) + Cl₂(g)↑ (>160 °C)', 'Nhiệt phân thuận nghịch PCl₅ (>160 °C)', 'Thermal dissociation of PCl₅ (>160 °C)', 'Trên 160 °C, PCl₅ phân li thuận nghịch thành PCl₃ và Cl₂.', 'Above 160 °C, PCl₅ dissociates reversibly into PCl₃ and Cl₂.', dDiss);
    }
  }
  if ((moles.PBr5_s || 0) > 1e-9 && T >= 373.15) {
    const dDissB = moles.PBr5_s * (1 - Math.exp(-0.95 * dt));
    if (dDissB > 1e-11) {
      consumeSpecies('PBr5_s', dDissB);
      moles.PBr3_l = (moles.PBr3_l || 0) + dDissB;
      gasProduced.Br2_g = (gasProduced.Br2_g || 0) + dDissB;
      heatJ -= dDissB * 65000;
      pushRxn('pbr5_dissoc', 'PBr₅(s) ⇌ PBr₃(l) + Br₂(g)↑ (>100 °C)', 'PBr₅ phân li trên 100 °C → PBr₃ + Br₂', 'PBr₅ dissociates above 100 °C → PBr₃ + Br₂', 'PBr₅ kém bền nhiệt, phân li hoàn toàn trên 100 °C.', 'PBr₅ thermally dissociates above 100 °C into PBr₃ and Br₂.', dDissB);
    }
  }
  if ((moles.AgP2_s || 0) > 1e-9 && !isSealedVessel && T >= 773.15) {
    const dAg = moles.AgP2_s * (1 - Math.exp(-0.75 * dt));
    if (dAg > 1e-11) {
      consumeSpecies('AgP2_s', dAg);
      moles.Ag_s = (moles.Ag_s || 0) + dAg;
      gasProduced.P4_g = (gasProduced.P4_g || 0) + dAg * 0.5;
      heatJ -= dAg * 45000;
      pushRxn('agp2_decomp', '2AgP₂(s) —(500–600 °C, hở)→ 2Ag(s) + P₄(g)↑', 'Phân hủy AgP₂ giải phóng P₄ hơi', 'AgP₂ decomposes to metallic Ag + P₄ vapor', 'Ở bình hở trên 500 °C, AgP₂ mất P thu lại Silver kim loại.', 'In an open vessel >500 °C, AgP₂ loses P yielding metallic Silver.', dAg);
    }
  }
  if ((head.PH3_g || 0) > 1e-8 && T >= 713.15) {
    const dCrk = head.PH3_g * (1 - Math.exp(-0.45 * dt));
    if (dCrk > 1e-11) {
      consumeHead('PH3_g', dCrk);
      moles.P_red_s = (moles.P_red_s || 0) + dCrk;
      gasProduced.H2_g = (gasProduced.H2_g || 0) + 1.5 * dCrk;
      pushRxn('ph3_crack', '2PH₃(g) —(>440 °C)→ 2P(đỏ) + 3H₂(g)↑', 'Nhiệt phân PH₃ trên 440 °C → P đỏ + H₂', 'PH₃ cracks above 440 °C → Red P + H₂', 'Trên 440 °C, khí PH₃ phân hủy thành Phosphorus đỏ và Hydrogen.', 'Above 440 °C, PH₃ dissociates into Red Phosphorus and Hydrogen.', dCrk);
    }
  }

  // --- PART A, B, C, D, E: Red Phosphorus (P_red_s) chemistry ---
  if ((moles.P_red_s || 0) > 1e-10) {
    const dryEnough = (moles.H2O_l || 0) < 0.015;

    // b1) Halogens Cl2, Br2, I2 (dry / direct contact)
    if (dryEnough) {
      // Cl2(g): spontaneous even at room temperature (pale yellow-green flame)
      if ((head.Cl2_g || 0) > 1e-8 && T >= 285.0) {
        const dPCl = Math.min(moles.P_red_s, (head.Cl2_g || 0) / 1.5) * (1 - Math.exp(-3.4 * dt));
        if (dPCl > 1e-11) {
          consumeSpecies('P_red_s', dPCl);
          consumeHead('Cl2_g', 1.5 * dPCl);
          moles.PCl3_l = (moles.PCl3_l || 0) + dPCl;
          heatJ += dPCl * 320000;
          vessel.phosphorusFlameTimer = 0.85;
          vessel.phosphorusFlameColor = 'cl2_green';
          pushRxn('p_cl2_pcl3', '2P(đỏ) + 3Cl₂(g) → 2PCl₃(l)', 'P đỏ tự bốc cháy trong khí Cl₂ tạo PCl₃ lỏng', 'Red P ignites spontaneously in Cl₂ → PCl₃', 'Phosphorus đỏ tự bốc cháy trong Cl₂ khô (lửa vàng lục nhạt) tạo PCl₃.', 'Red P ignites spontaneously in dry Cl₂ with pale yellow-green flame forming PCl₃.', dPCl);
        }
      }
      // Cl2(g) + PCl3(l) -> PCl5(s) if excess Cl2 below 160 C
      if ((moles.PCl3_l || 0) > 1e-9 && (head.Cl2_g || 0) > 1e-8 && T < 433.15) {
        const d5 = Math.min(moles.PCl3_l, head.Cl2_g) * (1 - Math.exp(-2.6 * dt));
        if (d5 > 1e-11) {
          consumeSpecies('PCl3_l', d5);
          consumeHead('Cl2_g', d5);
          moles.PCl5_s = (moles.PCl5_s || 0) + d5;
          heatJ += d5 * 124000;
          pushRxn('pcl3_cl2_pcl5', 'PCl₃(l) + Cl₂(dư) → PCl₅(s) (<160 °C)', 'Cl₂ dư oxi hóa PCl₃ thành tinh thể PCl₅', 'Excess Cl₂ oxidizes PCl₃ to solid PCl₅', 'Với Cl₂ dư dưới 160 °C, PCl₃ tiếp tục kết hợp tạo tinh thể vàng trắng PCl₅.', 'With excess Cl₂ below 160 °C, PCl₃ converts to pale-yellow PCl₅.', d5);
        }
      }

      // Br2(l / g): vigorous at room temperature -> PBr3(l), excess Br2 (<100 C) -> PBr5(s)
      const availBr2 = (moles.Br2_l || 0) + (head.Br2_g || 0);
      if (availBr2 > 1e-8 && (moles.P_red_s || 0) > 1e-10 && T >= 275.0) {
        const dPBr = Math.min(moles.P_red_s, availBr2 / 1.5) * (1 - Math.exp(-2.8 * dt));
        if (dPBr > 1e-11) {
          consumeSpecies('P_red_s', dPBr);
          let needBr = 1.5 * dPBr;
          const takeL = Math.min(moles.Br2_l || 0, needBr);
          if (takeL > 0) { consumeSpecies('Br2_l', takeL); needBr -= takeL; }
          if (needBr > 0) consumeHead('Br2_g', Math.min(head.Br2_g || 0, needBr));
          moles.PBr3_l = (moles.PBr3_l || 0) + dPBr;
          heatJ += dPBr * 184000;
          pushRxn('p_br2_pbr3', '2P(đỏ) + 3Br₂(l) → 2PBr₃(l)', 'P đỏ phản ứng mãnh liệt với Br₂ tạo PBr₃', 'Red P reacts vigorously with Br₂ → PBr₃', 'P đỏ phản ứng mạnh với Bromine ngay nhiệt độ thường tạo PBr₃ lỏng.', 'Red P reacts vigorously with Bromine at room temp yielding PBr₃.', dPBr);
        }
      }
      const remBr2 = (moles.Br2_l || 0) + (head.Br2_g || 0);
      if ((moles.PBr3_l || 0) > 1e-9 && remBr2 > 1e-8 && T < 373.15) {
        const dB5 = Math.min(moles.PBr3_l, remBr2) * (1 - Math.exp(-2.2 * dt));
        if (dB5 > 1e-11) {
          consumeSpecies('PBr3_l', dB5);
          let needB = dB5;
          const takeL = Math.min(moles.Br2_l || 0, needB);
          if (takeL > 0) { consumeSpecies('Br2_l', takeL); needB -= takeL; }
          if (needB > 0) consumeHead('Br2_g', Math.min(head.Br2_g || 0, needB));
          moles.PBr5_s = (moles.PBr5_s || 0) + dB5;
          heatJ += dB5 * 85000;
          pushRxn('pbr3_br2_pbr5', 'PBr₃(l) + Br₂(dư) → PBr₅(s) (<100 °C)', 'Br₂ dư tạo tinh thể vàng PBr₅ (<100 °C)', 'Excess Br₂ converts PBr₃ to yellow PBr₅ (<100 °C)', 'Br₂ dư tác dụng PBr₃ tạo tinh thể vàng PBr₅ (phân li ngược >100 °C).', 'Excess Br₂ converts PBr₃ into yellow PBr₅ crystals (<100 °C).', dB5);
        }
      }

      // I2(s / g): warm dry heat 60-120 C -> PI3(s) or P2I4(s) (NO PI5!)
      const availI2 = (moles.I2_s || 0) + (head.I2_g || 0);
      if (availI2 > 1e-8 && (moles.P_red_s || 0) > 1e-10 && T >= 333.15) {
        const excessP = (moles.P_red_s || 0) > availI2 * 0.9;
        const iPerP = excessP ? 1.0 : 1.5;
        const dPI = Math.min(moles.P_red_s, availI2 / iPerP) * (1 - Math.exp(-1.1 * dt));
        if (dPI > 1e-11) {
          consumeSpecies('P_red_s', dPI);
          let needI = iPerP * dPI;
          const takeIS = Math.min(moles.I2_s || 0, needI);
          if (takeIS > 0) { consumeSpecies('I2_s', takeIS); needI -= takeIS; }
          if (needI > 0) consumeHead('I2_g', Math.min(head.I2_g || 0, needI));
          if (excessP) {
            moles.P2I4_s = (moles.P2I4_s || 0) + dPI * 0.5;
          } else {
            moles.PI3_s = (moles.PI3_s || 0) + dPI;
          }
          heatJ += dPI * 46000;
          pushRxn(
            excessP ? 'p_i2_p2i4' : 'p_i2_pi3',
            excessP ? '2P(đỏ, dư) + 2I₂ —(60–120 °C)→ P₂I₄(s)' : '2P(đỏ) + 3I₂ —(60–120 °C)→ 2PI₃(s)',
            excessP ? 'P đỏ dư hóa hợp I₂ tạo P₂I₄ tinh thể cam' : 'P đỏ hóa hợp I₂ khi đun nhẹ tạo PI₃ đỏ sẫm (không tạo PI₅)',
            excessP ? 'Excess Red P + I₂ (60–120 °C) → orange P₂I₄' : 'Red P + I₂ (60–120 °C) → dark red PI₃ (no PI₅)',
            'Đun nhẹ hỗn hợp khô P đỏ + I₂ (60–120 °C) tạo PI₃ đỏ hoặc P₂I₄ cam; PI₅ không tồn tại bền.',
            'Warming dry Red P + I₂ yields PI₃ or orange P₂I₄; PI₅ does not form.',
            dPI
          );
        }
      }

      // b2) O2 combustion: pure/high O2 (>200 C) or open air (>=250 C) -> P4O10 (sufficient O2) or P4O6 (O2-lean)
      const headO2 = head.O2_g || 0;
      const openAirO2 = airFraction > 0 && !vessel.isStoppered && vessel.lidState !== 'closed' ? 0.06 * airFraction : 0;
      const effO2 = headO2 + openAirO2;
      const ignTempK = headO2 > 1e-4 ? 473.15 : 523.15;
      if ((moles.P_red_s || 0) > 1e-10 && effO2 > 1e-7 && T >= ignTempK) {
        const isO2Rich = openAirO2 > 0 || headO2 >= moles.P_red_s * 1.1;
        const o2PerP = isO2Rich ? 1.25 : 0.75;
        const dOxP = Math.min(moles.P_red_s, effO2 / o2PerP) * (1 - Math.exp(-1.9 * dt));
        if (dOxP > 1e-11) {
          consumeSpecies('P_red_s', dOxP);
          if (headO2 > 0) consumeHead('O2_g', Math.min(headO2, o2PerP * dOxP));
          if (isO2Rich) {
            moles.P4O10_s = (moles.P4O10_s || 0) + dOxP * 0.25;
            heatJ += dOxP * 746000;
          } else {
            moles.P4O6_s = (moles.P4O6_s || 0) + dOxP * 0.25;
            heatJ += dOxP * 410000;
          }
          vessel.phosphorusFlameTimer = 1.05;
          vessel.phosphorusFlameColor = 'p_white_yellow';
          pushRxn(
            isO2Rich ? 'p_o2_p4o10' : 'p_o2_p4o6',
            isO2Rich ? '4P(đỏ) + 5O₂(g) —(≥ 250 °C)→ P₄O₁₀(s) (khói trắng dày)' : '4P(đỏ) + 3O₂(thiếu) → P₄O₆(s)',
            isO2Rich ? 'P đỏ cháy rực tạo khói trắng dày P₄O₁₀' : 'P đỏ cháy thiếu Oxygen tạo P₄O₆',
            isO2Rich ? 'Red P burns brightly yielding dense white P₄O₁₀ smoke' : 'O₂-lean P combustion yields P₄O₆',
            isO2Rich ? 'P đỏ cháy ở ≥250 °C (hoặc ~200–240 °C trong O₂) với ngọn lửa sáng chói và khói trắng dày P₄O₁₀.' : 'Khi thiếu Oxygen, sản phẩm cháy tạo chủ yếu P₄O₆.',
            isO2Rich ? 'Red P ignites ~250 °C in air (~200 °C in pure O₂) with bright flame and dense white P₄O₁₀ smoke.' : 'Under O₂-lean conditions, P₄O₆ forms predominantly.',
            dOxP
          );
        }
      }

      // b3) Sulfur (P_red_s + S_s): NO room-T reaction; >= 200 C (473.15 K) -> P4S3 or P4S10 (inert/sealed or before burning)
      if ((moles.P_red_s || 0) > 1e-10 && (moles.S_s || 0) > 1e-10 && T >= 473.15 && (isLowO2Env || T < 523.15)) {
        const pExcess = moles.P_red_s >= moles.S_s * 0.9;
        const sPerP = pExcess ? 0.75 : 2.5;
        const dPS = Math.min(moles.P_red_s, moles.S_s / sPerP) * (1 - Math.exp(-0.95 * dt));
        if (dPS > 1e-11) {
          consumeSpecies('P_red_s', dPS);
          consumeSpecies('S_s', sPerP * dPS);
          if (pExcess) {
            moles.P4S3_s = (moles.P4S3_s || 0) + dPS * 0.25;
          } else {
            moles.P4S10_s = (moles.P4S10_s || 0) + dPS * 0.25;
          }
          heatJ += dPS * 75000;
          pushRxn(
            pExcess ? 'p_s_p4s3' : 'p_s_p4s10',
            pExcess ? '4P(đỏ) + 3S(l) —(200–300 °C)→ P₄S₃(s)' : '4P(đỏ) + 10S(l, dư) —(200–300 °C)→ P₄S₁₀(s)',
            pExcess ? 'P đỏ kết hợp Sulfur ở 200–300 °C → P₄S₃' : 'P đỏ kết hợp Sulfur dư ở 200–300 °C → P₄S₁₀',
            pExcess ? 'Red P + Sulfur (200–300 °C) → P₄S₃' : 'Red P + excess Sulfur (200–300 °C) → P₄S₁₀',
            'Không phản ứng ở nhiệt độ thường; đun nóng 200–300 °C trong khí trơ/kín tạo P₄S₃ (dư P) hoặc P₄S₁₀ (dư S).',
            'No reaction at room temp; heating 200–300 °C in inert/sealed tube yields P₄S₃ or P₄S₁₀.',
            dPS
          );
        }
      }

      // a) Direct Metal + Red Phosphorus synthesis (K, Na, Mg, Ca, Ba, Al [cat. I2/AlCl3], Zn, Fe, Cu; Ag ONLY sealed!)
      if ((moles.P_red_s || 0) > 1e-10 && (isLowO2Env || T < 473.15)) {
        const hasAlCat = (moles.I2_s || 0) > 1e-8 || (head.I2_g || 0) > 1e-8 || (moles.AlCl3_s || 0) > 1e-8 || (moles.PI3_s || 0) > 1e-8;
        const metalPhosphideSpecs = [
          ['K_s', 3, 1, 'K3P_s', 373.15, 0.55, false, 'p_k_k3p', '3K + P(đỏ) —(100–300 °C, khí trơ)→ K₃P(s)'],
          ['Na_s', 3, 1, 'Na3P_s', 423.15, 0.50, false, 'p_na_na3p', '3Na + P(đỏ) —(150–400 °C, khí trơ)→ Na₃P(s)'],
          ['Mg_s', 3, 2, 'Mg3P2_s', 723.15, 0.45, false, 'p_mg_mg3p2', '3Mg + 2P(đỏ) —(450–750 °C, khí trơ)→ Mg₃P₂(s)'],
          ['Ca_s', 3, 2, 'Ca3P2_s', 723.15, 0.45, false, 'p_ca_ca3p2', '3Ca + 2P(đỏ) —(450–750 °C, khí trơ)→ Ca₃P₂(s)'],
          ['Ba_s', 3, 2, 'Ba3P2_s', 773.15, 0.42, false, 'p_ba_ba3p2', '3Ba + 2P(đỏ) —(500–700 °C, khí trơ)→ Ba₃P₂(s)'],
          ['Al_s', 1, 1, 'AlP_s', hasAlCat ? 573.15 : 773.15, 0.40, false, 'p_al_alp', hasAlCat ? 'Al + P(đỏ) —(300–450 °C, xt I₂/AlCl₃)→ AlP(s)' : 'Al + P(đỏ) —(500–600 °C, khí trơ)→ AlP(s)'],
          ['Zn_s', 3, 2, 'Zn3P2_s', 723.15, 0.40, false, 'p_zn_zn3p2', '3Zn + 2P(đỏ) —(450–700 °C, khí trơ)→ Zn₃P₂(s)'],
          ['Fe_s', 3, 1, 'Fe3P_s', 1073.15, 0.16, false, 'p_fe_fe3p', '3Fe + P(đỏ) —(800–950 °C, khí trơ)→ Fe₃P(s)'],
          ['Cu_s', 3, 1, 'Cu3P_s', 673.15, 0.38, false, 'p_cu_cu3p', '3Cu + P(đỏ) —(400–650 °C, khí trơ)→ Cu₃P(s)'],
          ['Ag_s', 1, 2, 'AgP2_s', 773.15, 0.28, true, 'p_ag_agp2', 'Ag + 2P(hơi) —(500–700 °C, ống kín áp suất cao)→ AgP₂(s)'],
        ];
        for (const [mId, mSt, pSt, outId, minK, rate, reqSeal, rxnId, eq] of metalPhosphideSpecs) {
          if (reqSeal && !isSealedVessel) continue;
          const nM = moles[mId] || 0;
          if (nM > 1e-10 && (moles.P_red_s || 0) > 1e-10 && T >= minK) {
            const dXi = Math.min(nM / mSt, moles.P_red_s / pSt) * (1 - Math.exp(-rate * dt));
            if (dXi > 1e-11) {
              consumeSpecies(mId, mSt * dXi);
              consumeSpecies('P_red_s', pSt * dXi);
              moles[outId] = (moles[outId] || 0) + dXi;
              heatJ += dXi * 165000;
              pushRxn(rxnId, eq, `Tổng hợp phosphide ${SPECIES[outId].formula}`, `Direct synthesis of ${SPECIES[outId].formula}`, `Nung nóng ${SPECIES[mId].formula} với P đỏ trong môi trường khí trơ/kín thu được ${SPECIES[outId].formula}.`, `Heating ${SPECIES[mId].formula} with Red P in inert/sealed atmosphere forms ${SPECIES[outId].formula}.`, dXi);
            }
          }
        }
      }

      // b4) Red Phosphorus Sublimation > 416 C (689.15 K) -> P4(g) (in inert/sealed)
      if ((moles.P_red_s || 0) > 1e-10 && T >= 689.15 && isLowO2Env) {
        const dSubP = moles.P_red_s * (1 - Math.exp(-0.55 * dt));
        if (dSubP > 1e-11) {
          consumeSpecies('P_red_s', dSubP);
          gasProduced.P4_g = (gasProduced.P4_g || 0) + dSubP * 0.25;
          heatJ -= dSubP * 18400;
          pushRxn('p_red_subl', '4P(đỏ) —(>416 °C, khí trơ/kín)→ P₄(g)↑', 'Phosphorus đỏ thăng hoa (>416 °C) thành hơi P₄', 'Red Phosphorus sublimes (>416 °C) into P₄ vapor', 'Ở áp suất 1 atm, P đỏ thăng hoa trực tiếp không qua trạng thái lỏng ở >416 °C thành hơi P₄.', 'At 1 atm, Red P depolymerizes and sublimes above 416 °C into P₄ vapor.', dSubP);
        }
      }

      // e) Dry Salt Reactions: P_red + KMnO4 (heat >100 C), AgNO3 (molten >=212 C), CuO (from CuSO4 >550 C)
      if ((moles.P_red_s || 0) > 1e-10 && (moles.KMnO4_s || 0) > 1e-10 && T >= 373.15) {
        const dPK = Math.min(moles.P_red_s / 9, moles.KMnO4_s / 15) * (1 - Math.exp(-4.2 * dt));
        if (dPK > 1e-11) {
          consumeSpecies('P_red_s', 9 * dPK);
          consumeSpecies('KMnO4_s', 15 * dPK);
          moles.K3PO4_s = (moles.K3PO4_s || 0) + 5 * dPK;
          moles.P4O10_s = (moles.P4O10_s || 0) + dPK;
          moles.MnO2_s = (moles.MnO2_s || 0) + 15 * dPK;
          heatJ += dPK * 6200000;
          vessel.phosphorusFlameTimer = 1.1;
          vessel.phosphorusFlameColor = 'p_white_yellow';
          pushRxn('p_kmno4_dry', '9P(đỏ) + 15KMnO₄(s) —(>100 °C)→ 5K₃PO₄ + P₄O₁₀ + 15MnO₂', '⚠️ Hỗn hợp P đỏ + KMnO₄ rắn bốc cháy nổ dữ dội khi đun nóng!', '⚠️ Violent flash ignition of dry Red P + KMnO₄ mixture!', 'Chất oxi hóa mạnh KMnO₄ phản ứng nổ lóe sáng với bột P đỏ ngay khi đun >100–150 °C hoặc ma sát.', 'Strong oxidizer KMnO₄ reacts explosively with Red P powder on heating or friction.', dPK);
        }
      }
      if ((moles.P_red_s || 0) > 1e-10 && (moles.AgNO3_s || 0) > 1e-10 && T >= 485.15) {
        const dAgM = Math.min(moles.P_red_s / 2, moles.AgNO3_s / 10) * (1 - Math.exp(-0.85 * dt));
        if (dAgM > 1e-11) {
          consumeSpecies('P_red_s', 2 * dAgM);
          consumeSpecies('AgNO3_s', 10 * dAgM);
          moles.Ag_s = (moles.Ag_s || 0) + 4 * dAgM;
          moles.Ag3PO4_s = (moles.Ag3PO4_s || 0) + 2 * dAgM;
          gasProduced.NO2_g = (gasProduced.NO2_g || 0) + 10 * dAgM;
          gasProduced.O2_g = (gasProduced.O2_g || 0) + dAgM;
          heatJ += dAgM * 680000;
          pushRxn('p_agno3_molten', '2P(đỏ) + 10AgNO₃(l) —(>212 °C)→ 4Ag(s) + 2Ag₃PO₄(s) + 10NO₂↑ + O₂↑', 'P đỏ phản ứng với AgNO₃ nóng chảy (>212 °C)', 'Red P reacts with molten AgNO₃ (>212 °C)', 'Trong AgNO₃ nóng chảy (>212 °C), P đỏ bị oxi hóa sinh Ag, Ag₃PO₄ vàng và khí nâu đỏ NO₂.', 'In molten AgNO₃ (>212 °C), Red P yields metallic Ag, Ag₃PO₄, and NO₂ gas.', dAgM, true);
        }
      }
      if ((moles.P_red_s || 0) > 1e-10 && (moles.CuO_s || 0) > 1e-10 && T >= 773.15) {
        const dCuO = Math.min(moles.CuO_s / 10, moles.P_red_s / 4) * (1 - Math.exp(-0.65 * dt));
        if (dCuO > 1e-11) {
          consumeSpecies('CuO_s', 10 * dCuO);
          consumeSpecies('P_red_s', 4 * dCuO);
          moles.Cu_s = (moles.Cu_s || 0) + 10 * dCuO;
          moles.P4O10_s = (moles.P4O10_s || 0) + dCuO;
          heatJ += dCuO * 1420000;
          pushRxn('p_cuo_red', '10CuO(s) + 4P(đỏ) —(>500 °C)→ 10Cu(s) + P₄O₁₀(s)', 'P đỏ khử CuO ở nhiệt độ cao thành Cu đỏ', 'Red P reduces hot CuO to metallic Copper', 'P đỏ khử được CuO (hoặc sản phẩm nhiệt phân CuSO₄ >500 °C) tạo Cu kim loại.', 'Red P reduces hot CuO to metallic Copper.', dCuO);
        }
      }
    }

    // Condensation of P4_g -> P_white_s when cooled below 280 C (553.65 K)
    if ((head.P4_g || 0) > 1e-9 && T < 553.65) {
      const dCond = head.P4_g * (1 - Math.exp(-1.1 * dt));
      if (dCond > 1e-11) {
        consumeHead('P4_g', dCond);
        moles.P_white_s = (moles.P_white_s || 0) + dCond;
        heatJ += dCond * 56000;
      }
    }

    // c & d & e) Aqueous Acid, Base & Salt reactions (require liquid volume or anhydrous liquid HNO3/H2SO4)
    const acidMob = (moles.H2O_l || 0) > 1e-8 ? iceMob : ((moles.H2SO4_l || 0) + (moles.HNO3_l || 0) > 1e-7 ? 1 : 0);
    if ((moles.P_red_s || 0) > 1e-10 && (liquidVolL > 1e-6 || acidMob > 0) && acidMob > 0) {
      // c1) HNO3 conc vs dilute (HCl & dilute H2SO4 strictly DO NOT react!)
      const nNO3P = (moles.NO3_aq || 0) + (moles.HNO3_l || 0);
      const nHTP = (moles.H_aq || 0) + (moles.HNO3_l || 0);
      const nHNO3 = Math.min(nNO3P, nHTP);
      if (nHNO3 > 1e-5) {
        const wHNO3 = (nHNO3 * 63.013) / Math.max(1e-9, nHNO3 * 63.013 + (moles.H2O_l || 0) * 18.015);
        const takeHNO3 = (amt) => {
          let rem = amt;
          const tkAq = Math.min(moles.H_aq || 0, moles.NO3_aq || 0, rem);
          if (tkAq > 0) { consumeSpecies('H_aq', tkAq); consumeSpecies('NO3_aq', tkAq); rem -= tkAq; }
          if (rem > 0 && (moles.HNO3_l || 0) > 0) consumeSpecies('HNO3_l', Math.min(moles.HNO3_l, rem));
        };
        if (wHNO3 >= 0.55 && (wHNO3 >= 0.63 || T >= 313.15)) {
          const kRate = T >= 313.15 ? 0.95 : 0.32;
          const dN5 = Math.min(moles.P_red_s, nHNO3 / 5) * (1 - Math.exp(-kRate * acidMob * dt));
          if (dN5 > 1e-11) {
            consumeSpecies('P_red_s', dN5);
            takeHNO3(5 * dN5);
            moles.H3PO4_aq = (moles.H3PO4_aq || 0) + dN5;
            moles.H2O_l = (moles.H2O_l || 0) + dN5;
            gasProduced.NO2_g = (gasProduced.NO2_g || 0) + 5 * dN5;
            heatJ += dN5 * 295000;
            pushRxn('p_hno3_conc', 'P(đỏ) + 5HNO₃(đặc) → H₃PO₄(aq) + 5NO₂(g)↑ + H₂O', 'P đỏ khử HNO₃ đặc thành H₃PO₄ và khí nâu đỏ NO₂', 'Red P + conc. HNO₃ → H₃PO₄ + NO₂↑', 'HNO₃ đặc (đặc biệt khi đun ấm 40–60 °C) oxi hóa mạnh P đỏ lên H₃PO₄ và giải phóng NO₂.', 'Conc. HNO₃ oxidizes Red P to Phosphoric acid and brown NO₂↑.', dN5, true);
          }
        } else if (wHNO3 < 0.55 && wHNO3 >= 0.03 && T >= 333.15 && (moles.H2O_l || 0) > 1e-5) {
          const dN3 = Math.min(moles.P_red_s / 3, nHNO3 / 5, moles.H2O_l / 2) * (1 - Math.exp(-0.55 * acidMob * dt));
          if (dN3 > 1e-11) {
            consumeSpecies('P_red_s', 3 * dN3);
            takeHNO3(5 * dN3);
            consumeSpecies('H2O_l', 2 * dN3);
            moles.H3PO4_aq = (moles.H3PO4_aq || 0) + 3 * dN3;
            gasProduced.NO_g = (gasProduced.NO_g || 0) + 5 * dN3;
            heatJ += dN3 * 520000;
            pushRxn('p_hno3_dil', '3P(đỏ) + 5HNO₃(loãng) + 2H₂O —(60–100 °C)→ 3H₃PO₄ + 5NO(g)↑', 'P đỏ khử HNO₃ loãng đun nóng sinh khí NO không màu', 'Hot dilute HNO₃ + Red P → H₃PO₄ + NO↑', 'HNO₃ loãng cần đun nóng (60–100 °C) để oxi hóa P đỏ thành H₃PO₄ và giải phóng khí NO.', 'Hot dilute HNO₃ slowly oxidizes Red P to H₃PO₄ evolving colorless NO gas.', dN3, true);
          }
        }
      }

      // c2) H2SO4 conc >= 82% hot (>= 150 C = 423.15 K) ONLY! Cold & dilute strictly NO reaction!
      if ((moles.P_red_s || 0) > 1e-10) {
        const sulfP = computeSulfuricAcidState(moles);
        if (sulfP.w >= 0.82 && T >= 423.15 && (moles.H2SO4_l || 0) > 1e-5) {
          const dS2 = Math.min(moles.P_red_s / 2, moles.H2SO4_l / 5) * (1 - Math.exp(-0.52 * acidMob * dt));
          if (dS2 > 1e-11) {
            consumeSpecies('P_red_s', 2 * dS2);
            consumeSpecies('H2SO4_l', 5 * dS2);
            moles.H3PO4_aq = (moles.H3PO4_aq || 0) + 2 * dS2;
            moles.H2O_l = (moles.H2O_l || 0) + 2 * dS2;
            gasProduced.SO2_g = (gasProduced.SO2_g || 0) + 5 * dS2;
            heatJ += dS2 * 240000;
            pushRxn('p_h2so4_conc', '2P(đỏ) + 5H₂SO₄(đặc) —(150–250 °C)→ 2H₃PO₄ + 5SO₂(g)↑ + 2H₂O', 'P đỏ khử H₂SO₄ đặc nóng sinh H₃PO₄ và khí SO₂', 'Hot conc. H₂SO₄ + Red P → H₃PO₄ + SO₂↑', 'H₂SO₄ đặc nóng (150–250 °C) oxi hóa P đỏ thành H₃PO₄ + SO₂↑; H₂SO₄ loãng hoặc nguội không phản ứng.', 'Only hot conc. H₂SO₄ (≥150 °C) oxidizes Red P; cold or dilute H₂SO₄ is unreactive.', dS2, true);
          }
        }
      }
    }
    if ((moles.P_red_s || 0) > 1e-10 && liquidVolL > 1e-6 && liqMob > 0) {

      // d) Bases: NaOH / KOH conc (>= 4.5 M) boiling (>= 100 C = 373.15 K); dilute (< 4 M) & NH3(aq) NO reaction!
      const cOH = (moles.OH_aq || 0) / Math.max(1e-6, liquidVolL);
      if ((moles.P_red_s || 0) > 1e-10 && cOH >= 4.5 && T >= 373.15 && (moles.H2O_l || 0) > 1e-5) {
        const dBase = Math.min(moles.P_red_s / 4, moles.OH_aq / 3, moles.H2O_l / 3) * (1 - Math.exp(-0.34 * liqMob * dt));
        if (dBase > 1e-11) {
          consumeSpecies('P_red_s', 4 * dBase);
          consumeSpecies('OH_aq', 3 * dBase);
          consumeSpecies('H2O_l', 3 * dBase);
          moles.H2PO2_aq = (moles.H2PO2_aq || 0) + 3 * dBase;
          gasProduced.PH3_g = (gasProduced.PH3_g || 0) + dBase;
          heatJ += dBase * 68000;
          pushRxn('p_naoh_conc', '4P(đỏ) + 3OH⁻(đặc) + 3H₂O —(105–130 °C)→ PH₃(g)↑ + 3H₂PO₂⁻', 'P đỏ tự oxi hóa-khử trong kiềm đặc nóng sinh PH₃↑ + hypophosphite', 'Boiling conc. alkali disproportionates Red P → PH₃↑ + H₂PO₂⁻', 'Kiềm loãng hoặc NH₃(aq) không phản ứng; chỉ NaOH/KOH đặc đun sôi mới tạo chậm PH₃↑ và NaH₂PO₂.', 'Dilute NaOH and NH₃(aq) do not react; only boiling conc. alkali slowly forms PH₃↑ + H₂PO₂⁻.', dBase, true);
        }
      }

      // e1) Aqueous KMnO4 warm (>= 50 C = 323.15 K)
      if ((moles.P_red_s || 0) > 1e-10 && (moles.MnO4_aq || 0) > 1e-7 && T >= 323.15) {
        if ((moles.H_aq || 0) > 1e-4) {
          const dKM = Math.min(moles.P_red_s, moles.MnO4_aq, moles.H_aq / 3) * (1 - Math.exp(-0.75 * liqMob * dt));
          if (dKM > 1e-11) {
            consumeSpecies('P_red_s', dKM);
            consumeSpecies('MnO4_aq', dKM);
            consumeSpecies('H_aq', 3 * dKM);
            moles.H3PO4_aq = (moles.H3PO4_aq || 0) + dKM;
            moles.Mn2_aq = (moles.Mn2_aq || 0) + dKM;
            heatJ += dKM * 410000;
            pushRxn('p_kmno4_acid', 'P(đỏ) + MnO₄⁻(aq) + 3H⁺ → H₃PO₄ + Mn²⁺ (mất màu tím)', 'P đỏ làm mất màu dung dịch KMnO₄/H⁺ đun nóng', 'Red P decolorizes hot acidic KMnO₄ → Mn²⁺ + H₃PO₄', 'KMnO₄ trong môi trường acid oxi hóa P đỏ lên H₃PO₄ và chuyển sang Mn²⁺ không màu.', 'Acidic KMnO₄ oxidizes warm Red P to H₃PO₄ and colorless Mn²⁺.', dKM);
          }
        } else if ((moles.H2O_l || 0) > 1e-5) {
          const dKMn = Math.min(moles.P_red_s / 3, moles.MnO4_aq / 5, moles.H2O_l / 2) * (1 - Math.exp(-0.55 * liqMob * dt));
          if (dKMn > 1e-11) {
            consumeSpecies('P_red_s', 3 * dKMn);
            consumeSpecies('MnO4_aq', 5 * dKMn);
            consumeSpecies('H2O_l', 2 * dKMn);
            moles.H2PO4_aq = (moles.H2PO4_aq || 0) + dKMn;
            moles.HPO4_2_aq = (moles.HPO4_2_aq || 0) + 2 * dKMn;
            moles.MnO2_s = (moles.MnO2_s || 0) + 5 * dKMn;
            heatJ += dKMn * 980000;
            pushRxn('p_kmno4_neut', '3P(đỏ) + 5MnO₄⁻ + 2H₂O → H₂PO₄⁻ + 2HPO₄²⁻ + 5MnO₂↓', 'P đỏ khử dung dịch KMnO₄ ấm tạo kết tủa nâu đen MnO₂', 'Warm aqueous KMnO₄ + Red P → phosphate + MnO₂↓', 'Dung dịch KMnO₄ ấm oxi hóa P đỏ tạo muối phosphate và kết tủa nâu đen MnO₂.', 'Warm aqueous KMnO₄ oxidizes Red P forming MnO₂ precipitate.', dKMn);
          }
        }
      }

      // e2) Aqueous AgNO3 (warm >= 45 C = 318.15 K): P + 5Ag+ + 4H2O -> H3PO4 + 5Ag↓ + 5H+
      if ((moles.P_red_s || 0) > 1e-10 && (moles.Ag_aq || 0) > 1e-7 && T >= 318.15 && (moles.H2O_l || 0) > 1e-5) {
        const dAgAq = Math.min(moles.P_red_s, moles.Ag_aq / 5, moles.H2O_l / 4) * (1 - Math.exp(-0.48 * liqMob * dt));
        if (dAgAq > 1e-11) {
          consumeSpecies('P_red_s', dAgAq);
          consumeSpecies('Ag_aq', 5 * dAgAq);
          consumeSpecies('H2O_l', 4 * dAgAq);
          moles.H3PO4_aq = (moles.H3PO4_aq || 0) + dAgAq;
          moles.Ag_s = (moles.Ag_s || 0) + 5 * dAgAq;
          moles.H_aq = (moles.H_aq || 0) + 5 * dAgAq;
          heatJ += dAgAq * 210000;
          pushRxn('p_agno3_aq', 'P(đỏ) + 5Ag⁺(aq) + 4H₂O —(50–80 °C)→ H₃PO₄ + 5Ag(s)↓ + 5H⁺', 'P đỏ khử Ag⁺ trong AgNO₃ đun ấm kết tủa Silver kim loại', 'Warm aqueous AgNO₃ + Red P → Ag↓ + H₃PO₄', 'Khi đun ấm 50–80 °C, P đỏ khử ion Ag⁺ xuống kết tủa xám đen Silver kim loại.', 'On warming to 50–80 °C, Red P reduces Ag⁺ to metallic Silver precipitate.', dAgAq);
        }
      }

      // e3) Aqueous CuSO4 (hot >= 70 C = 343.15 K): 2P + 5Cu2+ + 8H2O -> 2H3PO4 + 5Cu↓ + 10H+
      if ((moles.P_red_s || 0) > 1e-10 && (moles.Cu2_aq || 0) > 1e-7 && T >= 343.15 && (moles.H2O_l || 0) > 1e-5) {
        const dCuAq = Math.min(moles.P_red_s / 2, moles.Cu2_aq / 5, moles.H2O_l / 8) * (1 - Math.exp(-0.38 * liqMob * dt));
        if (dCuAq > 1e-11) {
          consumeSpecies('P_red_s', 2 * dCuAq);
          consumeSpecies('Cu2_aq', 5 * dCuAq);
          consumeSpecies('H2O_l', 8 * dCuAq);
          moles.H3PO4_aq = (moles.H3PO4_aq || 0) + 2 * dCuAq;
          moles.Cu_s = (moles.Cu_s || 0) + 5 * dCuAq;
          moles.H_aq = (moles.H_aq || 0) + 10 * dCuAq;
          heatJ += dCuAq * 195000;
          pushRxn('p_cuso4_aq', '2P(đỏ) + 5Cu²⁺(aq) + 8H₂O —(80–100 °C)→ 2H₃PO₄ + 5Cu(s)↓ + 10H⁺', 'P đỏ khử dung dịch CuSO₄ đun nóng kết tủa Cu kim loại', 'Hot aqueous CuSO₄ + Red P → metallic Cu↓ + H₃PO₄', 'Đun nóng 80–100 °C, P đỏ khử dần Cu²⁺ xanh lam thành kết tủa Copper kim loại.', 'At 80–100 °C, Red P reduces blue Cu²⁺ into metallic Copper precipitate.', dCuAq);
        }
      }
    }
  }

  // Secondary hypophosphite oxidation by prolonged boiling conc alkali: H2PO2- + OH- -> HPO3^2- + H2↑
  if (liquidVolL > 1e-6 && liqMob > 0 && (moles.H2PO2_aq || 0) > 1e-7 && (moles.OH_aq || 0) / liquidVolL >= 3.0 && T >= 378.15) {
    const dH2 = Math.min(moles.H2PO2_aq, moles.OH_aq) * (1 - Math.exp(-0.18 * liqMob * dt));
    if (dH2 > 1e-11) {
      consumeSpecies('H2PO2_aq', dH2);
      consumeSpecies('OH_aq', dH2);
      moles.HPO3_2_aq = (moles.HPO3_2_aq || 0) + dH2;
      gasProduced.H2_g = (gasProduced.H2_g || 0) + dH2;
      heatJ += dH2 * 45000;
    }
  }

  // Aqueous Ag3PO4 yellow precipitation (dissolves in excess strong acid)
  if (liquidVolL > 1e-6 && liqMob > 0 && (moles.Ag_aq || 0) > 1e-6 && (moles.H_aq || 0) / liquidVolL < 0.08) {
    for (const [pAnion, hRel] of [['PO4_3_aq', 0], ['HPO4_2_aq', 1], ['H2PO4_aq', 2]]) {
      const nP = moles[pAnion] || 0;
      if (nP > 1e-7 && (moles.Ag_aq || 0) > 3e-7) {
        const dPpt = Math.min(moles.Ag_aq / 3, nP) * (1 - Math.exp(-5.5 * liqMob * dt));
        if (dPpt > 1e-11) {
          consumeSpecies('Ag_aq', 3 * dPpt);
          consumeSpecies(pAnion, dPpt);
          moles.Ag3PO4_s = (moles.Ag3PO4_s || 0) + dPpt;
          if (hRel > 0) moles.H_aq = (moles.H_aq || 0) + hRel * dPpt;
          pushRxn('ag_po4_ppt', '3Ag⁺(aq) + PO₄³⁻(aq) → Ag₃PO₄(s)↓ (vàng)', 'Kết tủa vàng Silver phosphate (Ag₃PO₄)', 'Yellow Silver phosphate precipitate (Ag₃PO₄↓)', 'Ion Ag⁺ tạo kết tủa vàng tươi Ag₃PO₄ với ion phosphate (tan trong acid).', 'Ag⁺ precipitates yellow Ag₃PO₄ with phosphate ions.', dPpt);
        }
      }
    }
  }

  return heatJ;
}

/**
 * Amorphous Silicon dioxide (SiO2_s) & Potassium dichromate (K2Cr2O7) solver (Prompt 53):
 *  - SiO2: hot conc./molten NaOH/KOH -> silicate; Mg (600-800 C -> Si/Mg2Si); C (1700-2000 C -> Si/SiC); CaCO3 (900-1300 C -> CaSiO3); Al (>1150 C); HCl/HNO3/H2SO4/H2O/NH3/Fe/Zn/salts inert.
 *  - K2Cr2O7: HCl conc -> Cl2 + Cr3+; H2SO4 conc -> CrO3↓ (+ NaCl -> CrO2Cl2↑); NaOH/NH3 ⇄ CrO4^2- (yellow/orange toggle);
 *    H2O2/H+ -> indigo CrO5 -> green Cr3+ + O2↑; Ba2+ -> BaCrO4↓; Ag+ -> Ag2Cr2O7↓; Fe/Zn/Al/Mg/P_red/S/C reductions;
 *    HNO3/KMnO4/Br2/I2/neutral NaCl/CuSO4/CaCO3 inert.
 */
function stepSiliconAndChromiumChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
  const moles = vessel.moles;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  const head = (vessel.headspaceGasMoles = vessel.headspaceGasMoles || {});
  const atmMode = options.environment?.atmosphereMode || 'air';
  const isInertAtm = atmMode === 'inert';
  const isSealedVessel = Boolean(vessel.isStoppered || vessel.lidState === 'closed' || (vessel.leftStoppered && vessel.rightStoppered));
  const isLowO2Env = isInertAtm || isSealedVessel || getVesselEffectiveO2Bar(vessel, options.environment) <= 0.03;
  const liqMob = (moles.H2O_l || 0) > 1e-8 ? iceMob : 0;
  let heatJ = 0;

  const consumeSpecies = (id, amt) => {
    moles[id] = Math.max(0, (moles[id] || 0) - amt);
    if (moles[id] < 1e-13) delete moles[id];
  };
  const pushRxn = (id, equation, nameVi, nameEn, descVi, descEn, dXi, vigorousGas = false) => {
    activeReactions.push({ id, equation, nameVi, nameEn, descVi, descEn, rateMolS: dXi / dt, vigorousGas, dXi });
  };

  // ==================== PART 1: SILICON DIOXIDE (SiO2_s) & SILICATE CHEMISTRY ====================
  if ((moles.SiO2_s || 0) > 1e-10) {
    const isDrySi = (moles.H2O_l || 0) < 0.015;
    // 1a. Hot conc NaOH/KOH aqueous (>= 4.0 M OH-, >= 80 C = 353.15 K)
    if (liquidVolL > 1e-6 && liqMob > 0 && T >= 353.15) {
      const cOH = (moles.OH_aq || 0) / Math.max(1e-6, liquidVolL);
      if (cOH >= 4.0) {
        const dSiOH = Math.min(moles.SiO2_s, (moles.OH_aq || 0) / 2) * (1 - Math.exp(-0.36 * liqMob * dt));
        if (dSiOH > 1e-11) {
          consumeSpecies('SiO2_s', dSiOH);
          consumeSpecies('OH_aq', 2 * dSiOH);
          moles.SiO3_2_aq = (moles.SiO3_2_aq || 0) + dSiOH;
          moles.H2O_l = (moles.H2O_l || 0) + dSiOH;
          heatJ += dSiOH * 28000;
          pushRxn('sio2_naoh_aq', 'SiO₂(s) + 2OH⁻(đặc, nóng) —(80–100 °C)→ SiO₃²⁻(aq) + H₂O', 'SiO₂ vô định hình tan chậm trong kiềm đặc nóng', 'Amorphous SiO₂ dissolves in hot conc. alkali → silicate', 'SiO₂ vô định hình tan trong NaOH đặc nóng tạo dung dịch thủy tinh lỏng Na₂SiO₃.', 'Amorphous SiO₂ slowly dissolves in hot conc. NaOH forming water glass.', dSiOH);
        }
      }
    }
    // 1b. Molten dry NaOH / KOH (>= 318 C = 591.15 K)
    if (isDrySi && T >= 591.15) {
      for (const [alkId, silId, alkName] of [['NaOH_s', 'Na2SiO3_s', 'NaOH'], ['KOH_s', 'K2SiO3_s', 'KOH']]) {
        const nAlk = moles[alkId] || 0;
        if (nAlk > 1e-10 && (moles.SiO2_s || 0) > 1e-10) {
          const dMeltSi = Math.min(moles.SiO2_s, nAlk / 2) * (1 - Math.exp(-1.6 * dt));
          if (dMeltSi > 1e-11) {
            consumeSpecies('SiO2_s', dMeltSi);
            consumeSpecies(alkId, 2 * dMeltSi);
            moles[silId] = (moles[silId] || 0) + dMeltSi;
            gasProduced.H2O_g = (gasProduced.H2O_g || 0) + dMeltSi;
            heatJ += dMeltSi * 54000;
            pushRxn(`sio2_melt_${alkId}`, `SiO₂(s) + 2${alkName}(l) —(>320 °C)→ ${SPECIES[silId].formula}(s) + H₂O(g)↑`, `SiO₂ phản ứng nhanh với ${alkName} nóng chảy`, `SiO₂ fuses rapidly with molten ${alkName}`, `Ở trạng thái nóng chảy (>320–500 °C), ${alkName} hòa tan nhanh SiO₂ tạo ${SPECIES[silId].formula}.`, `Molten ${alkName} rapidly fuses with SiO₂ forming ${SPECIES[silId].formula}.`, dMeltSi);
          }
        }
      }
    }
    // 1c. Magnesium thermite reduction (600-800 C, T >= 873.15 K, inert/sealed or ignited Mg)
    if (isDrySi && (moles.SiO2_s || 0) > 1e-10 && (moles.Mg_s || 0) > 1e-10 && T >= 873.15 && (isLowO2Env || (vessel.mgCombustionTimer || 0) > 0.02)) {
      const dMgSi = Math.min(moles.SiO2_s, moles.Mg_s / 2) * (1 - Math.exp(-1.4 * dt));
      if (dMgSi > 1e-11) {
        consumeSpecies('SiO2_s', dMgSi);
        consumeSpecies('Mg_s', 2 * dMgSi);
        moles.Si_s = (moles.Si_s || 0) + dMgSi;
        moles.MgO_s = (moles.MgO_s || 0) + 2 * dMgSi;
        heatJ += dMgSi * 372000;
        vessel.mgCombustionTimer = 0.9;
        pushRxn('sio2_mg_red', 'SiO₂(s) + 2Mg(s) —(600–800 °C)→ Si(s) + 2MgO(s)', 'Phản ứng nhiệt Magnesium khử SiO₂ → Si + 2MgO', 'Magnesiothermic reduction: SiO₂ + 2Mg → Si + 2MgO', 'Nung hỗn hợp bột Mg và SiO₂ tới 600–800 °C xảy ra phản ứng tỏa nhiệt mạnh tạo Silicon và MgO.', 'Heating Mg + SiO₂ (600–800 °C) yields Silicon and MgO exothermically.', dMgSi);
      }
    }
    // 1d. Carbothermal reduction ONLY in electric-arc extreme heat (>= 1700 C = 1973.15 K)
    if (isDrySi && (moles.SiO2_s || 0) > 1e-10 && (moles.C_s || 0) > 1e-10 && T >= 1973.15) {
      const dCSi = Math.min(moles.SiO2_s, moles.C_s / 2) * (1 - Math.exp(-0.9 * dt));
      if (dCSi > 1e-11) {
        consumeSpecies('SiO2_s', dCSi);
        consumeSpecies('C_s', 2 * dCSi);
        moles.Si_s = (moles.Si_s || 0) + dCSi;
        gasProduced.CO_g = (gasProduced.CO_g || 0) + 2 * dCSi;
        heatJ -= dCSi * 689000;
        pushRxn('sio2_c_arc', 'SiO₂(s) + 2C(s) —(1,700–2,000 °C)→ Si(s) + 2CO(g)↑', 'Khử SiO₂ bằng Carbon ở lò hồ quang điện (≥ 1,700 °C)', 'Carbothermal SiO₂ reduction (electric arc ≥ 1,700 °C)', 'Chỉ xảy ra ở nhiệt độ cực cao ≥1,700 °C (lò hồ quang điện), tạo Si và khí CO.', 'Requires extreme electric-arc furnace temperature (≥1,700 °C) to form Si and CO↑.', dCSi, true);
      }
    }
    // 1e. Calcium carbonate / CaO fluxing (900-1300 C, T >= 1173.15 K)
    if (isDrySi && (moles.SiO2_s || 0) > 1e-10 && T >= 1173.15) {
      if ((moles.CaCO3_s || 0) > 1e-10) {
        const dCaC = Math.min(moles.SiO2_s, moles.CaCO3_s) * (1 - Math.exp(-0.75 * dt));
        if (dCaC > 1e-11) {
          consumeSpecies('SiO2_s', dCaC);
          consumeSpecies('CaCO3_s', dCaC);
          moles.CaSiO3_s = (moles.CaSiO3_s || 0) + dCaC;
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dCaC;
          heatJ -= dCaC * 89000;
          pushRxn('sio2_caco3', 'CaCO₃(s) + SiO₂(s) —(900–1,300 °C)→ CaSiO₃(l/s) + CO₂(g)↑', 'Nung CaCO₃ + SiO₂ ở 900–1,300 °C tạo xỉ CaSiO₃', 'High-T fusion of CaCO₃ + SiO₂ → CaSiO₃ + CO₂↑', 'Ở 900–1,300 °C, CaCO₃ tác dụng với SiO₂ tạo Calcium silicate nóng chảy và CO₂↑.', 'Fusing CaCO₃ + SiO₂ at 900–1,300 °C forms molten CaSiO₃ slag and CO₂↑.', dCaC, true);
        }
      }
      if ((moles.CaO_s || 0) > 1e-10 && (moles.SiO2_s || 0) > 1e-10) {
        const dCaO = Math.min(moles.SiO2_s, moles.CaO_s) * (1 - Math.exp(-0.85 * dt));
        if (dCaO > 1e-11) {
          consumeSpecies('SiO2_s', dCaO);
          consumeSpecies('CaO_s', dCaO);
          moles.CaSiO3_s = (moles.CaSiO3_s || 0) + dCaO;
          heatJ += dCaO * 89000;
          pushRxn('sio2_cao', 'CaO(s) + SiO₂(s) —(900–1,300 °C)→ CaSiO₃(s)', 'CaO hóa hợp SiO₂ tạo xỉ Calcium silicate', 'CaO fuses with SiO₂ yielding CaSiO₃ slag', 'Ở nhiệt độ cao, vôi sống CaO kết hợp với SiO₂ tạo CaSiO₃.', 'At high temperatures, CaO combines with SiO₂ forming CaSiO₃.', dCaO);
        }
      }
    }
    // 1f. Extreme Aluminium reduction (> 1150 C = 1423.15 K)
    if (isDrySi && (moles.SiO2_s || 0) > 1e-10 && (moles.Al_s || 0) > 1e-10 && T >= 1423.15) {
      const dAlSi = Math.min(moles.SiO2_s / 3, moles.Al_s / 4) * (1 - Math.exp(-0.28 * dt));
      if (dAlSi > 1e-11) {
        consumeSpecies('SiO2_s', 3 * dAlSi);
        consumeSpecies('Al_s', 4 * dAlSi);
        moles.Si_s = (moles.Si_s || 0) + 3 * dAlSi;
        moles.Al2O3_s = (moles.Al2O3_s || 0) + 2 * dAlSi;
        heatJ += dAlSi * 615000;
        pushRxn('sio2_al_hi', '3SiO₂(s) + 4Al(s) —(>1,150 °C)→ 3Si(s) + 2Al₂O₃(s)', 'Nhiệt Aluminium khử SiO₂ ở nhiệt độ rất cao', 'Aluminothermic SiO₂ reduction (>1,150 °C)', 'Bột Al chỉ khử được SiO₂ ở nhiệt độ rất cao (>1,100–1,200 °C).', 'Aluminium powder reduces SiO₂ only above 1,100–1,200 °C.', dAlSi);
      }
    }
  }
  // Excess Mg -> Mg2Si; excess C @ >= 2173 K -> SiC; SiO3^2- + 2H+ -> H2SiO3↓ gel -> >100 C -> SiO2
  if ((moles.H2O_l || 0) < 0.015 && (moles.Si_s || 0) > 1e-10) {
    if ((moles.Mg_s || 0) > (moles.SiO2_s || 0) * 1.5 && moles.Mg_s > 1e-10 && T >= 873.15) {
      const dSil = Math.min(moles.Si_s, moles.Mg_s / 2) * (1 - Math.exp(-0.75 * dt));
      if (dSil > 1e-11) {
        consumeSpecies('Si_s', dSil);
        consumeSpecies('Mg_s', 2 * dSil);
        moles.Mg2Si_s = (moles.Mg2Si_s || 0) + dSil;
        heatJ += dSil * 78000;
      }
    }
    if ((moles.C_s || 0) > 1e-10 && T >= 2173.15) {
      const dSiC = Math.min(moles.Si_s, moles.C_s) * (1 - Math.exp(-0.65 * dt));
      if (dSiC > 1e-11) {
        consumeSpecies('Si_s', dSiC);
        consumeSpecies('C_s', dSiC);
        moles.SiC_s = (moles.SiC_s || 0) + dSiC;
      }
    }
  }
  if (liquidVolL > 1e-6 && liqMob > 0 && (moles.SiO3_2_aq || 0) > 1e-9 && (moles.H_aq || 0) > 1e-5) {
    const dGel = Math.min(moles.SiO3_2_aq, moles.H_aq / 2) * (1 - Math.exp(-6.5 * liqMob * dt));
    if (dGel > 1e-11) {
      consumeSpecies('SiO3_2_aq', dGel);
      consumeSpecies('H_aq', 2 * dGel);
      moles.H2SiO3_s = (moles.H2SiO3_s || 0) + dGel;
      pushRxn('silicate_gel', 'SiO₃²⁻(aq) + 2H⁺(aq) → H₂SiO₃(s)↓ (keo trắng)', 'Acid hóa silicate kết tủa keo trắng H₂SiO₃', 'Acidification of silicate precipitates H₂SiO₃↓ gel', 'Dung dịch silicate tác dụng acid kết tủa keo trắng H₂SiO₃.', 'Acidifying silicate precipitates gelatinous white H₂SiO₃.', dGel);
    }
  }
  if ((moles.H2SiO3_s || 0) > 1e-10 && (moles.H2O_l || 0) < 0.01 && T >= 393.15) {
    const dDeh = moles.H2SiO3_s * (1 - Math.exp(-0.85 * dt));
    if (dDeh > 1e-11) {
      consumeSpecies('H2SiO3_s', dDeh);
      moles.SiO2_s = (moles.SiO2_s || 0) + dDeh;
      gasProduced.H2O_g = (gasProduced.H2O_g || 0) + dDeh;
    }
  }

  // ==================== PART 2: POTASSIUM DICHROMATE (K2Cr2O7) / CHROMATE ====================
  // 2a. Base <-> Acid equilibrium: Cr2O7^2- (orange) + 2OH- ⇄ 2CrO4^2- (yellow) + H2O; Cr2O7^2- + 2NH3 + H2O -> 2CrO4^2- + 2NH4+
  if (liquidVolL > 1e-6 && liqMob > 0) {
    if ((moles.Cr2O7_2_aq || 0) > 1e-10 && (moles.OH_aq || 0) > 1e-9) {
      const dBase = Math.min(moles.Cr2O7_2_aq, moles.OH_aq / 2) * (1 - Math.exp(-12.0 * liqMob * dt));
      if (dBase > 1e-11) {
        consumeSpecies('Cr2O7_2_aq', dBase);
        consumeSpecies('OH_aq', 2 * dBase);
        moles.CrO4_2_aq = (moles.CrO4_2_aq || 0) + 2 * dBase;
        moles.H2O_l = (moles.H2O_l || 0) + dBase;
        heatJ += dBase * 34000;
        pushRxn('cr2o7_to_cro4', 'Cr₂O₇²⁻(cam) + 2OH⁻(aq) → 2CrO₄²⁻(vàng) + H₂O(l)', 'Kiềm hóa Cr₂O₇²⁻ (cam) → CrO₄²⁻ (vàng chanh)', 'Alkali converts orange Cr₂O₇²⁻ to lemon-yellow CrO₄²⁻', 'Ion OH⁻ chuyển cân bằng dichromate màu cam sang chromate màu vàng chanh ngay nhiệt độ thường.', 'Hydroxide shifts orange dichromate rapidly into lemon-yellow chromate.', dBase);
      }
    }
    if ((moles.Cr2O7_2_aq || 0) > 1e-10 && (moles.NH3_aq || 0) > 1e-7 && (moles.H2O_l || 0) > 1e-6) {
      const dAm = Math.min(moles.Cr2O7_2_aq, moles.NH3_aq / 2, moles.H2O_l) * (1 - Math.exp(-9.5 * liqMob * dt));
      if (dAm > 1e-11) {
        consumeSpecies('Cr2O7_2_aq', dAm);
        consumeSpecies('NH3_aq', 2 * dAm);
        consumeSpecies('H2O_l', dAm);
        moles.CrO4_2_aq = (moles.CrO4_2_aq || 0) + 2 * dAm;
        moles.NH4_aq = (moles.NH4_aq || 0) + 2 * dAm;
        heatJ += dAm * 26000;
        pushRxn('cr2o7_nh3', 'Cr₂O₇²⁻(cam) + 2NH₃(aq) + H₂O → 2CrO₄²⁻(vàng) + 2NH₄⁺', 'NH₃ chuyển dung dịch K₂Cr₂O₇ (cam) sang vàng tươi CrO₄²⁻', 'Aqueous NH₃ converts orange Cr₂O₇²⁻ to yellow CrO₄²⁻', 'Dung dịch NH₃ làm mất sắc cam dichromate chuyển sang màu vàng tươi chromate.', 'Aqueous ammonia converts orange dichromate into bright yellow chromate.', dAm);
      }
    }
    if ((moles.CrO4_2_aq || 0) > 1e-10 && (moles.H_aq || 0) > 1e-6) {
      const dAcid = Math.min(moles.CrO4_2_aq / 2, moles.H_aq / 2) * (1 - Math.exp(-12.0 * liqMob * dt));
      if (dAcid > 1e-11) {
        consumeSpecies('CrO4_2_aq', 2 * dAcid);
        consumeSpecies('H_aq', 2 * dAcid);
        moles.Cr2O7_2_aq = (moles.Cr2O7_2_aq || 0) + dAcid;
        moles.H2O_l = (moles.H2O_l || 0) + dAcid;
        heatJ += dAcid * 14000;
        pushRxn('cro4_to_cr2o7', '2CrO₄²⁻(vàng) + 2H⁺(aq) → Cr₂O₇²⁻(cam) + H₂O(l)', 'Acid hóa CrO₄²⁻ (vàng) chuyển lại thành Cr₂O₇²⁻ (cam)', 'Acid converts yellow CrO₄²⁻ back to orange Cr₂O₇²⁻', 'Thêm acid làm cân bằng chromate (vàng) dịch chuyển ngược lại dichromate (cam).', 'Acidifying yellow chromate shifts equilibrium back to orange dichromate.', dAcid);
      }
    }

    // 2b. Double-exchange precipitations: Ba2+ -> BaCrO4↓ (yellow); Ag+ -> Ag2Cr2O7↓ (brick-red) / Ag2CrO4↓
    if ((moles.Ba2_aq || 0) > 1e-8) {
      if ((moles.CrO4_2_aq || 0) > 1e-8) {
        const dBaY = Math.min(moles.Ba2_aq, moles.CrO4_2_aq) * (1 - Math.exp(-9.0 * liqMob * dt));
        if (dBaY > 1e-11) {
          consumeSpecies('Ba2_aq', dBaY);
          consumeSpecies('CrO4_2_aq', dBaY);
          moles.BaCrO4_s = (moles.BaCrO4_s || 0) + dBaY;
          pushRxn('ba_cro4_ppt', 'Ba²⁺(aq) + CrO₄²⁻(aq) → BaCrO₄(s)↓ (vàng tươi)', 'Kết tủa vàng tươi Barium chromate (BaCrO₄)', 'Bright yellow BaCrO₄ precipitate', 'Ba²⁺ kết tủa hoàn toàn ion chromate thành BaCrO₄ vàng tươi.', 'Ba²⁺ precipitates yellow BaCrO₄.', dBaY);
        }
      }
      if ((moles.Cr2O7_2_aq || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-6) {
        const dBaD = Math.min(moles.Ba2_aq / 2, moles.Cr2O7_2_aq, moles.H2O_l) * (1 - Math.exp(-7.5 * liqMob * dt));
        if (dBaD > 1e-11) {
          consumeSpecies('Ba2_aq', 2 * dBaD);
          consumeSpecies('Cr2O7_2_aq', dBaD);
          consumeSpecies('H2O_l', dBaD);
          moles.BaCrO4_s = (moles.BaCrO4_s || 0) + 2 * dBaD;
          moles.H_aq = (moles.H_aq || 0) + 2 * dBaD;
          pushRxn('ba_cr2o7_ppt', '2Ba²⁺(aq) + Cr₂O₇²⁻(aq) + H₂O → 2BaCrO₄(s)↓ + 2H⁺(aq)', 'BaCl₂ tác dụng K₂Cr₂O₇ kết tủa vàng tươi BaCrO₄', 'Ba²⁺ + Cr₂O₇²⁻ + H₂O → yellow BaCrO₄↓ + 2H⁺', 'Cân bằng thủy phân Cr₂O₇²⁻ dịch chuyển khi Ba²⁺ tạo kết tủa BaCrO₄ vàng tươi ít tan.', 'Ba²⁺ drives Cr₂O₇²⁻ hydrolysis to precipitate bright-yellow BaCrO₄.', dBaD);
        }
      }
    }
    if ((moles.Ag_aq || 0) > 1e-8) {
      if ((moles.Cr2O7_2_aq || 0) > 1e-8) {
        const dAgD = Math.min(moles.Ag_aq / 2, moles.Cr2O7_2_aq) * (1 - Math.exp(-9.0 * liqMob * dt));
        if (dAgD > 1e-11) {
          consumeSpecies('Ag_aq', 2 * dAgD);
          consumeSpecies('Cr2O7_2_aq', dAgD);
          moles.Ag2Cr2O7_s = (moles.Ag2Cr2O7_s || 0) + dAgD;
          pushRxn('ag_cr2o7_ppt', '2Ag⁺(aq) + Cr₂O₇²⁻(aq) → Ag₂Cr₂O₇(s)↓ (đỏ gạch sẫm)', 'Kết tủa đỏ gạch sẫm Silver dichromate (Ag₂Cr₂O₇)', 'Dark brick-red Ag₂Cr₂O₇ precipitate', 'AgNO₃ tác dụng ngay với K₂Cr₂O₇ tạo kết tủa đỏ gạch sẫm Ag₂Cr₂O₇.', 'Ag⁺ immediately precipitates dark brick-red Ag₂Cr₂O₇.', dAgD);
        }
      }
      if ((moles.CrO4_2_aq || 0) > 1e-8) {
        const dAgC = Math.min(moles.Ag_aq / 2, moles.CrO4_2_aq) * (1 - Math.exp(-9.0 * liqMob * dt));
        if (dAgC > 1e-11) {
          consumeSpecies('Ag_aq', 2 * dAgC);
          consumeSpecies('CrO4_2_aq', dAgC);
          moles.Ag2CrO4_s = (moles.Ag2CrO4_s || 0) + dAgC;
          pushRxn('ag_cro4_ppt', '2Ag⁺(aq) + CrO₄²⁻(aq) → Ag₂CrO₄(s)↓ (đỏ gạch)', 'Kết tủa đỏ gạch Silver chromate (Ag₂CrO₄)', 'Brick-red Ag₂CrO₄ precipitate', 'Ag⁺ tạo kết tủa đỏ gạch Ag₂CrO₄ với ion CrO₄²⁻.', 'Ag⁺ precipitates brick-red Ag₂CrO₄.', dAgC);
        }
      }
    }

    // 2c. H2O2 in acidic solution -> transient deep indigo CrO5(aq) -> emerald-green Cr3+ + O2↑
    if ((moles.Cr2O7_2_aq || 0) > 1e-9 && (moles.H2O2_aq || 0) > 1e-7 && (moles.H_aq || 0) > 1e-5 && liqMob > 0) {
      const dPer = Math.min(moles.Cr2O7_2_aq, moles.H2O2_aq / 4, moles.H_aq / 2) * (1 - Math.exp(-8.5 * liqMob * dt));
      if (dPer > 1e-11) {
        consumeSpecies('Cr2O7_2_aq', dPer);
        consumeSpecies('H2O2_aq', 4 * dPer);
        consumeSpecies('H_aq', 2 * dPer);
        moles.CrO5_aq = (moles.CrO5_aq || 0) + 2 * dPer;
        moles.H2O_l = (moles.H2O_l || 0) + 5 * dPer;
        heatJ += dPer * 165000;
        pushRxn('cr2o7_h2o2_cro5', 'Cr₂O₇²⁻ + 4H₂O₂ + 2H⁺ → 2CrO₅(xanh chàm đậm) + 5H₂O', 'H₂O₂ + K₂Cr₂O₇/H⁺ tạo hợp chất CrO₅ xanh chàm đậm!', 'Acidic dichromate + H₂O₂ forms deep indigo CrO₅!', 'Trong môi trường acid, H₂O₂ phản ứng tức thì tạo Chromium(VI) peroxide CrO₅ màu xanh chàm đậm.', 'In acidic media, H₂O₂ instantaneously yields deep indigo-blue CrO₅ peroxide.', dPer);
      }
    }
    if ((moles.CrO5_aq || 0) > 1e-10 && (moles.H_aq || 0) > 1e-6 && liqMob > 0) {
      const dDec = Math.min(moles.CrO5_aq / 2, moles.H_aq / 6) * (1 - Math.exp(-0.72 * liqMob * dt));
      if (dDec > 1e-11) {
        consumeSpecies('CrO5_aq', 2 * dDec);
        consumeSpecies('H_aq', 6 * dDec);
        moles.Cr3_aq = (moles.Cr3_aq || 0) + 2 * dDec;
        moles.H2O_l = (moles.H2O_l || 0) + 3 * dDec;
        gasProduced.O2_g = (gasProduced.O2_g || 0) + 3.5 * dDec;
        heatJ += dDec * 185000;
        pushRxn('cro5_decomp', '4CrO₅(aq) + 12H⁺ → 4Cr³⁺(xanh lục) + 7O₂(g)↑ + 6H₂O', 'CrO₅ kém bền phân hủy thành Cr³⁺ xanh lục và khí O₂↑', 'Unstable indigo CrO₅ decomposes → green Cr³⁺ + O₂↑', 'Peroxide CrO₅ phân hủy sau vài giây tạo dung dịch Cr³⁺ màu xanh lục và giải phóng khí O₂.', 'Indigo CrO₅ rapidly decomposes to emerald-green Cr³⁺ liberating O₂ gas.', dDec, true);
      }
    }

    // 2d. Concentrated HCl (>= 4.5 M H+ & Cl-) -> green Cr3+ + Cl2↑ (dilute HCl does NOT react!)
    const nDichTot = (moles.Cr2O7_2_aq || 0) + (moles.K2Cr2O7_s || 0);
    if (nDichTot > 1e-10 && (moles.H_aq || 0) > 1e-4 && (moles.Cl_aq || 0) > 1e-4 && liqMob > 0) {
      const cH = (moles.H_aq || 0) / Math.max(1e-6, liquidVolL);
      const cCl = (moles.Cl_aq || 0) / Math.max(1e-6, liquidVolL);
      if (cH >= 4.5 && cCl >= 4.5) {
        const dHCl = Math.min(nDichTot, moles.H_aq / 14, moles.Cl_aq / 6) * (1 - Math.exp(-1.35 * liqMob * dt));
        if (dHCl > 1e-11) {
          const tkAq = Math.min(moles.Cr2O7_2_aq || 0, dHCl);
          if (tkAq > 0) consumeSpecies('Cr2O7_2_aq', tkAq);
          const tkSol = dHCl - tkAq;
          if (tkSol > 0) { consumeSpecies('K2Cr2O7_s', tkSol); moles.K_aq = (moles.K_aq || 0) + 2 * tkSol; }
          consumeSpecies('H_aq', 14 * dHCl);
          consumeSpecies('Cl_aq', 6 * dHCl);
          moles.Cr3_aq = (moles.Cr3_aq || 0) + 2 * dHCl;
          moles.H2O_l = (moles.H2O_l || 0) + 7 * dHCl;
          gasProduced.Cl2_g = (gasProduced.Cl2_g || 0) + 3 * dHCl;
          heatJ += dHCl * 225000;
          pushRxn('k2cr2o7_hcl_conc', 'K₂Cr₂O₇ + 14HCl(đặc) → 2KCl + 2CrCl₃(xanh lục) + 3Cl₂↑ + 7H₂O', 'K₂Cr₂O₇ oxi hóa HCl đặc sinh khí Cl₂ và dung dịch xanh lục Cr³⁺', 'Conc. HCl reduces K₂Cr₂O₇ → green Cr³⁺ + Cl₂↑', 'HCl đặc (36%) bị K₂Cr₂O₇ oxi hóa giải phóng khí Cl₂ vàng lục và chuyển dung dịch sang xanh lục Cr³⁺; HCl loãng không phản ứng.', 'Conc. HCl (not dilute) is oxidized by K₂Cr₂O₇ to Cl₂↑ and green Cr³⁺.', dHCl, true);
        }
      }
    }

    // 2e. Aqueous Acidic Redox with Fe, Zn, Al, Mg, P_red, or I- (KI) -> green Cr3+
    if ((moles.Cr2O7_2_aq || 0) > 1e-10 && (moles.H_aq || 0) > 1e-4 && liqMob > 0) {
      for (const [mId, ionId, mSt, eqM] of [
        ['Zn_s', 'Zn2_aq', 3, 'Cr₂O₇²⁻ + 3Zn + 14H⁺ → 2Cr³⁺ + 3Zn²⁺ + 7H₂O'],
        ['Fe_s', 'Fe2_aq', 3, 'Cr₂O₇²⁻ + 3Fe + 14H⁺ → 2Cr³⁺ + 3Fe²⁺ + 7H₂O'],
        ['Mg_s', 'Mg2_aq', 3, 'Cr₂O₇²⁻ + 3Mg + 14H⁺ → 2Cr³⁺ + 3Mg²⁺ + 7H₂O'],
        ['Al_s', 'Al3_aq', 2, 'Cr₂O₇²⁻ + 2Al + 14H⁺ → 2Cr³⁺ + 2Al³⁺ + 7H₂O'],
      ]) {
        const nM = moles[mId] || 0;
        if (nM > 1e-9 && (moles.Cr2O7_2_aq || 0) > 1e-10 && (moles.H_aq || 0) > 1e-4) {
          const dMCr = Math.min(moles.Cr2O7_2_aq, nM / mSt, moles.H_aq / 14) * (1 - Math.exp(-1.1 * liqMob * dt));
          if (dMCr > 1e-11) {
            consumeSpecies('Cr2O7_2_aq', dMCr);
            consumeSpecies(mId, mSt * dMCr);
            consumeSpecies('H_aq', 14 * dMCr);
            moles.Cr3_aq = (moles.Cr3_aq || 0) + 2 * dMCr;
            moles[ionId] = (moles[ionId] || 0) + mSt * dMCr;
            moles.H2O_l = (moles.H2O_l || 0) + 7 * dMCr;
            heatJ += dMCr * 620000;
            pushRxn(`cr2o7_acid_${mId}`, eqM, `${SPECIES[mId].formula} khử K₂Cr₂O₇/H⁺ sang Cr³⁺ xanh lục`, `${SPECIES[mId].formula} reduces acidic Cr₂O₇²⁻ to green Cr³⁺`, `Trong môi trường acid loãng, ${SPECIES[mId].formula} khử ngay dung dịch cam Cr₂O₇²⁻ sang xanh lục Cr³⁺.`, `In dilute acid, ${SPECIES[mId].formula} reduces orange Cr₂O₇²⁻ to emerald-green Cr³⁺.`, dMCr);
          }
        }
      }
      if ((moles.Fe2_aq || 0) > 1e-8 && (moles.Cr2O7_2_aq || 0) > 1e-10) {
        const dF2 = Math.min(moles.Cr2O7_2_aq, moles.Fe2_aq / 6, moles.H_aq / 14) * (1 - Math.exp(-4.5 * liqMob * dt));
        if (dF2 > 1e-11) {
          consumeSpecies('Cr2O7_2_aq', dF2);
          consumeSpecies('Fe2_aq', 6 * dF2);
          consumeSpecies('H_aq', 14 * dF2);
          moles.Cr3_aq = (moles.Cr3_aq || 0) + 2 * dF2;
          moles.Fe3_aq = (moles.Fe3_aq || 0) + 6 * dF2;
          moles.H2O_l = (moles.H2O_l || 0) + 7 * dF2;
          heatJ += dF2 * 290000;
        }
      }
      if ((moles.P_red_s || 0) > 1e-9 && T >= 323.15 && (moles.Cr2O7_2_aq || 0) > 1e-10) {
        const dPCrAq = Math.min(moles.P_red_s / 6, moles.Cr2O7_2_aq / 5, moles.H_aq / 40) * (1 - Math.exp(-0.55 * liqMob * dt));
        if (dPCrAq > 1e-11) {
          consumeSpecies('P_red_s', 6 * dPCrAq);
          consumeSpecies('Cr2O7_2_aq', 5 * dPCrAq);
          consumeSpecies('H_aq', 40 * dPCrAq);
          moles.H3PO4_aq = (moles.H3PO4_aq || 0) + 6 * dPCrAq;
          moles.Cr3_aq = (moles.Cr3_aq || 0) + 10 * dPCrAq;
          moles.H2O_l = (moles.H2O_l || 0) + 11 * dPCrAq;
          heatJ += dPCrAq * 1450000;
          pushRxn('cr2o7_acid_pred', '6P(đỏ) + 5Cr₂O₇²⁻ + 40H⁺ —(t°)→ 6H₃PO₄ + 10Cr³⁺ + 11H₂O', 'P đỏ khử K₂Cr₂O₇ trong acid đun nóng → H₃PO₄ + Cr³⁺ xanh lục', 'Warm acidic dichromate oxidizes Red P → H₃PO₄ + green Cr³⁺', 'Trong dung dịch acid đun nóng, P đỏ bị oxi hóa lên H₃PO₄ còn Cr(VI) bị khử thành Cr³⁺ xanh lục.', 'In warm acidic solution, Red P reduces orange Cr₂O₇²⁻ to green Cr³⁺.', dPCrAq);
        }
      }
    }
  }

  // 2f. Conc H2SO4 (>= 78%): K2Cr2O7 + 2H2SO4(đặc) -> 2CrO3↓ (đỏ sẫm) + 2KHSO4 + H2O; if NaCl/Cl- + warm -> CrO2Cl2↑
  const sulfCr = computeSulfuricAcidState(moles);
  if (sulfCr.w >= 0.78 && (moles.H2SO4_l || 0) > 1e-5 && ((moles.K2Cr2O7_s || 0) > 1e-10 || (moles.Cr2O7_2_aq || 0) > 1e-10)) {
    const availCl = (moles.Cl_aq || 0) + (moles.NaCl_s || 0);
    if (availCl > 1e-7 && T >= 323.15 && (moles.K2Cr2O7_s || 0) > 1e-10 && (moles.H2SO4_l || 0) > 1e-5) {
      const dChl = Math.min(moles.K2Cr2O7_s, availCl / 4, moles.H2SO4_l / 6) * (1 - Math.exp(-1.1 * dt));
      if (dChl > 1e-11) {
        consumeSpecies('K2Cr2O7_s', dChl);
        let needCl = 4 * dChl;
        const tkNaCl = Math.min(moles.NaCl_s || 0, needCl);
        if (tkNaCl > 0) { consumeSpecies('NaCl_s', tkNaCl); moles.Na_aq = (moles.Na_aq || 0) + tkNaCl; needCl -= tkNaCl; }
        if (needCl > 0) consumeSpecies('Cl_aq', Math.min(moles.Cl_aq || 0, needCl));
        consumeSpecies('H2SO4_l', 6 * dChl);
        moles.K_aq = (moles.K_aq || 0) + 2 * dChl;
        moles.HSO4_aq = (moles.HSO4_aq || 0) + 6 * dChl;
        moles.H2O_l = (moles.H2O_l || 0) + 3 * dChl;
        gasProduced.CrO2Cl2_g = (gasProduced.CrO2Cl2_g || 0) + 2 * dChl;
        heatJ += dChl * 120000;
        pushRxn('chromyl_chloride', 'K₂Cr₂O₇ + 4NaCl + 6H₂SO₄(đặc, t°) → 2CrO₂Cl₂(g)↑ + 2KHSO₄ + 4NaHSO₄ + 3H₂O', 'Phản ứng tạo hơi Chromyl chloride CrO₂Cl₂ màu đỏ nâu!', 'Chromyl chloride (CrO₂Cl₂) red-brown vapor evolved!', 'Khi đun nóng K₂Cr₂O₇ + NaCl trong H₂SO₄ đặc sinh khí CrO₂Cl₂ màu đỏ nâu đặc trưng.', 'Heating K₂Cr₂O₇ + NaCl in conc. H₂SO₄ evolves deep red-brown CrO₂Cl₂ vapor.', dChl, true);
      }
    }
    const nKCrS = (moles.K2Cr2O7_s || 0) + (moles.Cr2O7_2_aq || 0);
    if (nKCrS > 1e-10 && (moles.H2SO4_l || 0) > 1e-5) {
      const dCrO3 = Math.min(nKCrS, moles.H2SO4_l / 2) * (1 - Math.exp(-1.8 * dt));
      if (dCrO3 > 1e-11) {
        const tkAq = Math.min(moles.Cr2O7_2_aq || 0, dCrO3);
        if (tkAq > 0) consumeSpecies('Cr2O7_2_aq', tkAq);
        const tkSol = dCrO3 - tkAq;
        if (tkSol > 0) { consumeSpecies('K2Cr2O7_s', tkSol); moles.K_aq = (moles.K_aq || 0) + 2 * tkSol; }
        consumeSpecies('H2SO4_l', 2 * dCrO3);
        moles.CrO3_s = (moles.CrO3_s || 0) + 2 * dCrO3;
        moles.HSO4_aq = (moles.HSO4_aq || 0) + 2 * dCrO3;
        moles.H2O_l = (moles.H2O_l || 0) + dCrO3;
        heatJ += dCrO3 * 85000;
        pushRxn('k2cr2o7_h2so4_cro3', 'K₂Cr₂O₇ + 2H₂SO₄(đặc) → 2CrO₃(s)↓ (đỏ sẫm) + 2KHSO₄ + H₂O', 'H₂SO₄ đặc tách nước kết tủa hình kim đỏ sẫm CrO₃ (hỗn hợp sunfocromic)', 'Conc. H₂SO₄ precipitates crimson CrO₃ crystals from K₂Cr₂O₇', 'H₂SO₄ đặc 98% đẩy và tách nước tạo kết tủa đỏ sẫm CrO₃ (hỗn hợp rửa sunfocromic); H₂SO₄ loãng chỉ tạo môi trường H⁺.', 'Conc. H₂SO₄ dehydrates K₂Cr₂O₇ yielding crimson CrO₃ needles (chromic cleaning mixture).', dCrO3);
      }
    }
  }

  // 2g. Dry Solid Pyrotechnic / Thermite / Alkali / Nonmetal Redox Reactions of K2Cr2O7_s
  if ((moles.K2Cr2O7_s || 0) > 1e-10 && (moles.H2O_l || 0) < 0.015) {
    // Metals: Al/Mg/Zn (>=500 C), Fe (>=550 C); Na/K dry flash (>= 70 C)
    const dryCrMetals = [
      ['Al_s', 2, 'Al2O3_s', 1, 773.15, 1.4, 'k2cr2o7_al', 'K₂Cr₂O₇ + 2Al —(>500 °C)→ Al₂O₃ + Cr₂O₃ + K₂O', 890000],
      ['Mg_s', 3, 'MgO_s', 3, 773.15, 1.4, 'k2cr2o7_mg', 'K₂Cr₂O₇ + 3Mg —(>500 °C)→ 3MgO + Cr₂O₃ + K₂O', 920000],
      ['Zn_s', 3, 'ZnO_s', 3, 773.15, 0.85, 'k2cr2o7_zn', 'K₂Cr₂O₇ + 3Zn —(>500 °C)→ 3ZnO + Cr₂O₃ + K₂O', 480000],
      ['Fe_s', 3, 'FeO_s', 3, 823.15, 0.55, 'k2cr2o7_fe', 'K₂Cr₂O₇ + 3Fe —(>550 °C)→ 3FeO + Cr₂O₃ + K₂O', 360000],
      ['Na_s', 6, 'Na2O_s', 3, 343.15, 3.2, 'k2cr2o7_na_dry', '⚠️ K₂Cr₂O₇(s) + 6Na(s) —(t° nhẹ)→ Cr₂O₃ + K₂O + 3Na₂O', 980000],
      ['K_s', 6, 'K2O_s', 3, 333.15, 3.5, 'k2cr2o7_k_dry', '⚠️ K₂Cr₂O₇(s) + 6K(s) —(t° nhẹ)→ Cr₂O₃ + 4K₂O', 990000],
    ];
    for (const [mId, mSt, oxId, oxSt, minK, rate, rxnId, eq, exH] of dryCrMetals) {
      const nM = moles[mId] || 0;
      if (nM > 1e-10 && (moles.K2Cr2O7_s || 0) > 1e-10 && T >= minK) {
        const dMC = Math.min(moles.K2Cr2O7_s, nM / mSt) * (1 - Math.exp(-rate * dt));
        if (dMC > 1e-11) {
          consumeSpecies('K2Cr2O7_s', dMC);
          consumeSpecies(mId, mSt * dMC);
          moles.Cr2O3_s = (moles.Cr2O3_s || 0) + dMC;
          moles.K2O_s = (moles.K2O_s || 0) + dMC;
          moles[oxId] = (moles[oxId] || 0) + oxSt * dMC;
          heatJ += dMC * exH;
          if (mId === 'Mg_s') vessel.mgCombustionTimer = 0.9;
          if (mId === 'Al_s') vessel.alCombustionTimer = 0.9;
          pushRxn(rxnId, eq, `Phản ứng khử K₂Cr₂O₇ rắn bằng ${SPECIES[mId].formula} tạo Cr₂O₃ lục thẫm`, `Solid redox: K₂Cr₂O₇ + ${SPECIES[mId].formula} → dark-green Cr₂O₃`, eq, eq, dMC);
        }
      }
    }
    // P_red_s (>= 150 C = 423.15 K)
    if ((moles.P_red_s || 0) > 1e-10 && (moles.K2Cr2O7_s || 0) > 1e-10 && T >= 423.15) {
      const dPCr = Math.min(moles.K2Cr2O7_s / 15, moles.P_red_s / 18) * (1 - Math.exp(-3.6 * dt));
      if (dPCr > 1e-11) {
        consumeSpecies('K2Cr2O7_s', 15 * dPCr);
        consumeSpecies('P_red_s', 18 * dPCr);
        moles.Cr2O3_s = (moles.Cr2O3_s || 0) + 15 * dPCr;
        moles.K3PO4_s = (moles.K3PO4_s || 0) + 10 * dPCr;
        moles.P4O10_s = (moles.P4O10_s || 0) + 2 * dPCr;
        heatJ += dPCr * 5800000;
        vessel.phosphorusFlameTimer = 1.05;
        vessel.phosphorusFlameColor = 'p_white_yellow';
        pushRxn('k2cr2o7_pred_dry', '15K₂Cr₂O₇ + 18P(đỏ) —(>150 °C)→ 15Cr₂O₃ + 10K₃PO₄ + 2P₄O₁₀', '⚠️ Hỗn hợp P đỏ + K₂Cr₂O₇ bùng cháy dữ dội tạo Cr₂O₃ lục thẫm!', '⚠️ Dry Red P + K₂Cr₂O₇ flashes violently → green Cr₂O₃ + P₄O₁₀!', 'Hỗn hợp P đỏ + K₂Cr₂O₇ cực nhạy nhiệt (>150–200 °C) hoặc ma sát.', 'Dry Red P + K₂Cr₂O₇ ignites violently >150 °C or by friction.', dPCr);
      }
    }
    // S_s (>= 300 C = 573.15 K): 8K2Cr2O7 + 9S -> 8Cr2O3 + 6K2SO4 + 2K2O + 3SO2↑
    if ((moles.S_s || 0) > 1e-10 && (moles.K2Cr2O7_s || 0) > 1e-10 && T >= 573.15) {
      const dSCr = Math.min(moles.K2Cr2O7_s / 8, moles.S_s / 9) * (1 - Math.exp(-1.1 * dt));
      if (dSCr > 1e-11) {
        consumeSpecies('K2Cr2O7_s', 8 * dSCr);
        consumeSpecies('S_s', 9 * dSCr);
        moles.Cr2O3_s = (moles.Cr2O3_s || 0) + 8 * dSCr;
        moles.K2SO4_s = (moles.K2SO4_s || 0) + 6 * dSCr;
        moles.K2O_s = (moles.K2O_s || 0) + 2 * dSCr;
        gasProduced.SO2_g = (gasProduced.SO2_g || 0) + 3 * dSCr;
        heatJ += dSCr * 2400000;
        pushRxn('k2cr2o7_s_dry', '8K₂Cr₂O₇ + 9S —(>300 °C)→ 8Cr₂O₃(s) + 6K₂SO₄ + 2K₂O + 3SO₂↑', 'K₂Cr₂O₇ + Sulfur đun nóng (>300 °C) → Cr₂O₃ lục thẫm + K₂SO₄ + SO₂↑', 'Molten Sulfur + K₂Cr₂O₇ (>300 °C) → green Cr₂O₃ + K₂SO₄ + SO₂↑', 'Đun hỗn hợp bột K₂Cr₂O₇ + S (>300–400 °C) phản ứng tự duy trì tạo Cr₂O₃ xanh lục, K₂SO₄ và khí SO₂.', 'Heating K₂Cr₂O₇ + S above 300 °C gives dark-green Cr₂O₃, K₂SO₄, and SO₂.', dSCr, true);
      }
    }
    // C_s (>= 400 C = 673.15 K): 2K2Cr2O7 + 3C -> 2Cr2O3 + 2K2CO3 + CO2↑
    if ((moles.C_s || 0) > 1e-10 && (moles.K2Cr2O7_s || 0) > 1e-10 && T >= 673.15) {
      const dCCr = Math.min(moles.K2Cr2O7_s / 2, moles.C_s / 3) * (1 - Math.exp(-0.95 * dt));
      if (dCCr > 1e-11) {
        consumeSpecies('K2Cr2O7_s', 2 * dCCr);
        consumeSpecies('C_s', 3 * dCCr);
        moles.Cr2O3_s = (moles.Cr2O3_s || 0) + 2 * dCCr;
        moles.K2CO3_s = (moles.K2CO3_s || 0) + 2 * dCCr;
        gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dCCr;
        heatJ += dCCr * 540000;
        pushRxn('k2cr2o7_c_dry', '2K₂Cr₂O₇ + 3C —(>400 °C)→ 2Cr₂O₃(s) + 2K₂CO₃ + CO₂(g)↑', 'Carbon khử K₂Cr₂O₇ (>400 °C) → Cr₂O₃ xanh lục + K₂CO₃ + CO₂↑', 'Hot Carbon reduces K₂Cr₂O₇ (>400 °C) → green Cr₂O₃ + K₂CO₃ + CO₂↑', 'Nung nóng Carbon với K₂Cr₂O₇ trên 400–500 °C thu được Cr₂O₃ lục thẫm, K₂CO₃ và khí CO₂.', 'Heating Carbon + K₂Cr₂O₇ (>400 °C) forms green Cr₂O₃, K₂CO₃, and CO₂↑.', dCCr, true);
      }
    }
    // SiO2_s at extreme temperature (> 800 C = 1073.15 K): 2K2Cr2O7 + 2SiO2 -> 2K2SiO3 + 2Cr2O3 + 3O2↑
    if ((moles.SiO2_s || 0) > 1e-10 && (moles.K2Cr2O7_s || 0) > 1e-10 && T >= 1073.15) {
      const dSiCr = Math.min(moles.K2Cr2O7_s / 2, moles.SiO2_s / 2) * (1 - Math.exp(-0.42 * dt));
      if (dSiCr > 1e-11) {
        consumeSpecies('K2Cr2O7_s', 2 * dSiCr);
        consumeSpecies('SiO2_s', 2 * dSiCr);
        moles.K2SiO3_s = (moles.K2SiO3_s || 0) + 2 * dSiCr;
        moles.Cr2O3_s = (moles.Cr2O3_s || 0) + 2 * dSiCr;
        gasProduced.O2_g = (gasProduced.O2_g || 0) + 3 * dSiCr;
        pushRxn('k2cr2o7_sio2_hi', '2K₂Cr₂O₇ + 2SiO₂ —(>800 °C)→ 2K₂SiO₃ + 2Cr₂O₃ + 3O₂↑', 'SiO₂ đẩy CrO₃ ở >800–1,000 °C tạo silicate và Cr₂O₃', 'SiO₂ fuses with K₂Cr₂O₇ >800 °C → K₂SiO₃ + Cr₂O₃ + O₂↑', 'Chỉ ở nhiệt độ nung chảy rất cao >800–1,000 °C, SiO₂ mới đẩy được oxide tạo silicate và Cr₂O₃.', 'Only above 800–1,000 °C does SiO₂ fuse with K₂Cr₂O₇ yielding silicate and Cr₂O₃.', dSiCr);
      }
    }
  }

  // 2h. High-temperature K2Cr2O7 / K2CrO4 / K2O stages up to 1500 C (Vacuum shift vs Air > 1200 C Stage 2)
  if ((moles.H2O_l || 0) < 0.015 && ((moles.K2Cr2O7_s || 0) > 1e-10 || (moles.K2CrO4_s || 0) > 1e-10 || (moles.K2O_s || 0) > 1e-10)) {
    const isVacThermal =
      options?.environment?.atmosphereMode === 'vacuum' ||
      (options?.environment?.pressureBar ?? 1.0) <= 0.15;

    // Early vacuum Stage 1 (450–470 C = 723.15 K .. 773.15 K, ~30-50 C lower than air)
    if (isVacThermal && (moles.K2Cr2O7_s || 0) > 1e-10 && T >= 723.15 && T < 773.15) {
      const dVac1 = (moles.K2Cr2O7_s / 4) * (1 - Math.exp(-0.28 * dt));
      if (dVac1 > 1e-11) {
        consumeSpecies('K2Cr2O7_s', 4 * dVac1);
        moles.K2CrO4_s = (moles.K2CrO4_s || 0) + 4 * dVac1;
        moles.Cr2O3_s = (moles.Cr2O3_s || 0) + 2 * dVac1;
        gasProduced.O2_g = (gasProduced.O2_g || 0) + 3 * dVac1;
        pushRxn('k2cr2o7_vac_stage1', '4K₂Cr₂O₇ —(chân không; 450–470 °C)→ 4K₂CrO₄ + 2Cr₂O₃ + 3O₂↑', 'Chân không hạ nhiệt độ nhiệt phân K₂Cr₂O₇ xuống 450–470 °C', 'Vacuum lowers K₂Cr₂O₇ decomposition onset to 450–470 °C', 'Hút chân không rút liên tục O₂ nên K₂Cr₂O₇ phân hủy sớm ở 450–470 °C thành K₂CrO₄ vàng và Cr₂O₃ lục.', 'Continuous vacuum O₂ pumping shifts K₂Cr₂O₇ decomposition ~40 °C lower to 450–470 °C.', dVac1, true);
      }
    }

    // Stage 2: Molten K2CrO4 (mp 968 C) — Vacuum (>= 850 C: full volatilization to pure Cr2O3) vs Air (> 1200 C: partial Stage 2)
    if ((moles.K2CrO4_s || 0) > 1e-10) {
      if (isVacThermal && T >= 1123.15) {
        // 850–1200 C vacuum: 2K2CrO4 -> Cr2O3(s) + 4K↑ + 2.5 O2↑ (leaves 100% pure Cr2O3 by 1200–1500 C)
        const kVac2 = T >= 1473.15 ? 1.8 : 0.45 + 0.9 * Math.min(1, (T - 1123.15) / 350);
        const dVac2 = (moles.K2CrO4_s / 2) * (1 - Math.exp(-kVac2 * dt));
        if (dVac2 > 1e-11) {
          consumeSpecies('K2CrO4_s', 2 * dVac2);
          moles.Cr2O3_s = (moles.Cr2O3_s || 0) + dVac2;
          gasProduced.K_g = (gasProduced.K_g || 0) + 4 * dVac2;
          gasProduced.O2_g = (gasProduced.O2_g || 0) + 2.5 * dVac2;
          pushRxn('k2cro4_vac_stage2', '2K₂CrO₄ —(chân không; 900–1200 °C)→ Cr₂O₃(s) + 4K↑ + 2.5O₂↑', 'Nhiệt phân K₂CrO₄ trong chân không (850–1200 °C) còn 100% Cr₂O₃ tinh khiết', 'Vacuum decomposition of K₂CrO₄ (850–1200 °C) leaves pure Cr₂O₃', 'Chân không hút liên tục O₂ và hơi K làm K₂CrO₄ phân hủy mạnh từ 850–1200 °C; tới 1500 °C chỉ còn Cr₂O₃ rắn lục thẫm tinh khiết.', 'Continuous vacuum evacuation removes K vapor and O₂ from 850–1200 °C, leaving 100% solid Cr₂O₃ at 1500 °C.', dVac2, true);
        }
      } else if (!isVacThermal && T >= 1473.15) {
        // Air > 1200 C (1473 K): molten K2CrO4 thermally stable at 968-1200 C; >1200 C partial Stage 2: 4K2CrO4(l) -> 2Cr2O3(s) + 4K2O + 3O2↑
        const kAir2 = 0.08 + 0.22 * Math.min(1, (T - 1473.15) / 300);
        const dAir2 = (moles.K2CrO4_s / 4) * (1 - Math.exp(-kAir2 * dt));
        if (dAir2 > 1e-11) {
          consumeSpecies('K2CrO4_s', 4 * dAir2);
          moles.Cr2O3_s = (moles.Cr2O3_s || 0) + 2 * dAir2;
          moles.K2O_s = (moles.K2O_s || 0) + 4 * dAir2;
          gasProduced.O2_g = (gasProduced.O2_g || 0) + 3 * dAir2;
          pushRxn('k2cro4_air_stage2', '4K₂CrO₄(l) —(>1200 °C)→ 2Cr₂O₃(s) + 4K₂O + 3O₂↑', 'Nhiệt phân K₂CrO₄ nóng chảy (>1200 °C trong không khí) tạo Cr₂O₃ và K₂O/K', 'Molten K₂CrO₄ partial Stage 2 decomposition (>1200 °C in air) → Cr₂O₃ + K₂O + O₂↑', 'Ở 968–1200 °C trong không khí (~0.21 atm O₂), K₂CrO₄ nóng chảy bền nhiệt; trên 1200 °C phân hủy một phần và bay hơi mạnh dần đến 1500 °C, chủ yếu còn Cr₂O₃ (t_nc 2435 °C).', 'Molten K₂CrO₄ stays stable at 968–1200 °C in air; above 1200 °C it partially decomposes toward dark-green Cr₂O₃ (mp 2435 °C) and K/O₂ vapor.', dAir2, true);
        }
      }
    }
    // K2O instability above 1000 C (1273 K air) or >= 850 C (1123 K vacuum): 2K2O -> 4K(g)↑ + O2(g)↑
    if ((moles.K2O_s || 0) > 1e-10 && !vessel.isStoppered && T >= (isVacThermal ? 1123.15 : 1273.15)) {
      const dK2O = (moles.K2O_s / 2) * (1 - Math.exp(-(isVacThermal ? 1.6 : 0.45) * dt));
      if (dK2O > 1e-11) {
        consumeSpecies('K2O_s', 2 * dK2O);
        gasProduced.K_g = (gasProduced.K_g || 0) + 4 * dK2O;
        gasProduced.O2_g = (gasProduced.O2_g || 0) + dK2O;
        pushRxn('k2o_hi_dissoc', '2K₂O —(>1000 °C)→ 4K(g)↑ + O₂(g)↑', 'K₂O phân ly ở nhiệt độ cao (>1000 °C) thành hơi Kali và O₂', 'High-temperature dissociation of K₂O (>1000 °C) into K(g)↑ + O₂↑', 'Trên 800–1000 °C (đặc biệt trong chân không), K₂O không bền và phân ly thành hơi K và khí O₂ thoát ra.', 'Above 800–1000 °C (especially in vacuum), K₂O dissociates into K vapor and O₂ gas.', dK2O);
      }
    }
  }

  return heatJ;
}

/**
 * Ethanol (C2H5OH) & Glacial Acetic Acid (CH3COOH) organic reaction solver (Prompt 54):
 *  - Ethanol: Na/K (existing reactions.js), Mg+I2(boiling -> (C2H5O)2Mg↓+H2), KMnO4 (dry flash & aq -> CH3COO-/MnO2/Mn2+),
 *    K2Cr2O7/H+ (orange -> green Cr3+), HNO3 conc (-> CH3COOH + NO2), H2O2 (Fenton Fe2+/hot acid),
 *    H2SO4 conc (140 C -> diethyl ether; >=165 C -> C2H4↑), Br2 (warm -> CH3COOC2H5 + HBr), I2+NaOH (CHI3↓ yellow iodoform).
 *  - Acetic Acid: pKa 4.76, NaOH/NH3 neutralizations, Na/K (fast), Mg/Zn (slow cold dry -> fast hot/aq), Fe (boiling/warm aq), Al passive,
 *    CaCO3/CaC2 (slow anhydrous -> fast warm/aq), Esterification w/ EtOH (H2SO4, 60-80 C -> CH3COOC2H5),
 *    H2O2/H2SO4 -> CH3COOOH, prolonged boiling KMnO4/H2SO4 -> CO2↑.
 */
function stepOrganicChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
  const moles = vessel.moles;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  const orgMob = vessel.isFrozenSolid ? 0 : 1;
  let heatJ = 0;

  const consumeSpecies = (id, amt) => {
    moles[id] = Math.max(0, (moles[id] || 0) - amt);
    if (moles[id] < 1e-13) delete moles[id];
  };
  const pushRxn = (id, equation, nameVi, nameEn, descVi, descEn, dXi, vigorousGas = false) => {
    activeReactions.push({ id, equation, nameVi, nameEn, descVi, descEn, rateMolS: dXi / dt, vigorousGas, dXi });
  };

  // ==================== PART 1: ABSOLUTE ETHANOL (C2H5OH_l) ====================
  if ((moles.C2H5OH_l || 0) > 1e-10 && orgMob > 0) {
    // 1a-ext. Calcium (Ca) reacts with anhydrous Ethanol -> (C2H5O)2Ca↓ + H2↑; Mg + I2 initiator at reflux >= 70 C
    if ((moles.Ca_s || 0) > 1e-9 && (moles.H2O_l || 0) < 0.015) {
      const kCaE = T >= 313.15 ? 0.72 : 0.25;
      const dCaE = Math.min(moles.Ca_s, moles.C2H5OH_l / 2) * (1 - Math.exp(-kCaE * dt));
      if (dCaE > 1e-11) {
        consumeSpecies('Ca_s', dCaE);
        consumeSpecies('C2H5OH_l', 2 * dCaE);
        moles.CaC2H5O_2_s = (moles.CaC2H5O_2_s || 0) + dCaE;
        gasProduced.H2_g = (gasProduced.H2_g || 0) + dCaE;
        heatJ += dCaE * 165000;
        pushRxn('etoh_ca', '2C₂H₅OH + Ca → (C₂H₅O)₂Ca↓ + H₂(g)↑', 'Calcium khử nhóm –OH của Ethanol tạo Calcium ethoxide & H₂', 'Calcium reacts with Ethanol → (C₂H₅O)₂Ca + H₂↑', 'Kim loại Ca tác dụng với Ethanol giải phóng khí H₂ tạo kết tủa trắng Calcium ethoxide.', 'Ca displaces H from Ethanol forming white Calcium ethoxide and H₂ gas.', dCaE, true);
      }
    }
    if ((moles.Mg_s || 0) > 1e-9 && ((moles.I2_s || 0) + (moles.I2_aq || 0)) > 1e-8 && T >= 343.15) {
      const dMgE = Math.min(moles.Mg_s, moles.C2H5OH_l / 2) * (1 - Math.exp(-0.55 * dt));
      if (dMgE > 1e-11) {
        consumeSpecies('Mg_s', dMgE);
        consumeSpecies('C2H5OH_l', 2 * dMgE);
        moles.MgC2H5O_2_s = (moles.MgC2H5O_2_s || 0) + dMgE;
        gasProduced.H2_g = (gasProduced.H2_g || 0) + dMgE;
        heatJ += dMgE * 145000;
        pushRxn('etoh_mg_i2', '2C₂H₅OH + Mg —(I₂, 78 °C)→ (C₂H₅O)₂Mg↓ + H₂↑', 'Magnesium phản ứng với Ethanol đun sôi có I₂ khơi mào', 'Mg reacts with boiling Ethanol (I₂ initiator) → (C₂H₅O)₂Mg↓ + H₂↑', 'Khi đun hồi lưu ~78 °C có tinh thể I₂ khơi mào, Mg tạo kết tủa trắng Magnesium ethoxide và H₂.', 'Refluxing Ethanol with clean Mg + I₂ initiator yields white (C₂H₅O)₂Mg and H₂.', dMgE, true);
      }
    }

    // 1b-pre. Anhydrous CrO3(s) + Ethanol -> rapid oxidation/ignition to CH3COOH + green Cr2O3(s)
    if ((moles.CrO3_s || 0) > 1e-9 && (moles.H2O_l || 0) < 0.025) {
      const dCr3E = Math.min(moles.C2H5OH_l / 3, moles.CrO3_s / 4) * (1 - Math.exp(-3.2 * dt));
      if (dCr3E > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dCr3E);
        consumeSpecies('CrO3_s', 4 * dCr3E);
        moles.CH3COOH_l = (moles.CH3COOH_l || 0) + 3 * dCr3E;
        moles.Cr2O3_s = (moles.Cr2O3_s || 0) + 2 * dCr3E;
        moles.H2O_l = (moles.H2O_l || 0) + 3 * dCr3E;
        heatJ += dCr3E * 1120000;
        vessel.naDryBurnTimer = Math.max(vessel.naDryBurnTimer || 0, 0.75);
        pushRxn('etoh_cro3_dry', '3C₂H₅OH + 4CrO₃(s) → 3CH₃COOH + 2Cr₂O₃(lục thẫm) + 3H₂O (Tỏa nhiệt mạnh!)', 'CrO₃ khan oxi hóa mãnh liệt Ethanol thành Acetic acid & Cr₂O₃ lục thẫm', 'Anhydrous CrO₃ vigorously oxidizes Ethanol → CH₃COOH + green Cr₂O₃', 'Nhỏ Ethanol lên tinh thể CrO₃ khan gây phản ứng tỏa nhiệt bùng cháy, khử Cr(VI) đỏ thẫm về Cr₂O₃ lục thẫm.', 'Pure Ethanol triggers violent exothermic oxidation on CrO₃ crystals leaving green Cr₂O₃.', dCr3E);
      }
    }

    // 1b. KMnO4 oxidation: anhydrous solid KMnO4_s flash, vs aqueous warm MnO4- (-> CH3COO-/MnO2 or acid -> CH3COOH + Mn2+)
    if ((moles.H2O_l || 0) < 0.015 && (moles.KMnO4_s || 0) > 1e-10) {
      const dKMnDry = Math.min(moles.C2H5OH_l / 3, moles.KMnO4_s / 4) * (1 - Math.exp(-2.8 * dt));
      if (dKMnDry > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dKMnDry);
        consumeSpecies('KMnO4_s', 4 * dKMnDry);
        moles.CH3COOK_s = (moles.CH3COOK_s || 0) + 3 * dKMnDry;
        moles.KOH_s = (moles.KOH_s || 0) + dKMnDry;
        moles.MnO2_s = (moles.MnO2_s || 0) + 4 * dKMnDry;
        moles.H2O_l = (moles.H2O_l || 0) + 4 * dKMnDry;
        heatJ += dKMnDry * 1350000;
        vessel.naDryBurnTimer = Math.max(vessel.naDryBurnTimer || 0, 0.85);
        pushRxn('etoh_kmno4_dry', '⚠️ 3C₂H₅OH(khan) + 4KMnO₄(s) → 3CH₃COOK + KOH + 4MnO₂ + 4H₂O (Bốc cháy!)', '⚠️ Nhỏ Ethanol khan lên KMnO₄ tinh thể gây tỏa nhiệt bốc cháy!', '⚠️ Anhydrous Ethanol + solid KMnO₄ ignites vigorously!', 'Ethanol tuyệt đối tiếp xúc KMnO₄ khan (nhất là có thêm H₂SO₄ đặc) tỏa nhiệt rất mạnh gây bốc cháy tức thì.', 'Anhydrous Ethanol on dry KMnO₄ triggers rapid exothermic ignition.', dKMnDry);
      }
    } else if (liquidVolL > 1e-6 && (moles.MnO4_aq || 0) > 1e-8) {
      if ((moles.H_aq || 0) > 1e-4) {
        const dMnA = Math.min(moles.C2H5OH_l / 5, moles.MnO4_aq / 4, moles.H_aq / 12) * (1 - Math.exp(-0.95 * dt));
        if (dMnA > 1e-11) {
          consumeSpecies('C2H5OH_l', 5 * dMnA);
          consumeSpecies('MnO4_aq', 4 * dMnA);
          consumeSpecies('H_aq', 12 * dMnA);
          moles.CH3COOH_l = (moles.CH3COOH_l || 0) + 5 * dMnA;
          moles.Mn2_aq = (moles.Mn2_aq || 0) + 4 * dMnA;
          moles.H2O_l = (moles.H2O_l || 0) + 11 * dMnA;
          heatJ += dMnA * 1280000;
          pushRxn('etoh_kmno4_acid', '5C₂H₅OH + 4MnO₄⁻ + 12H⁺ → 5CH₃COOH + 4Mn²⁺ + 11H₂O', 'KMnO₄/H⁺ oxi hóa Ethanol thành Acetic acid (mất màu tím)', 'Acidic KMnO₄ oxidizes Ethanol to Acetic acid (decolorizes)', 'Trong môi trường acid H₂SO₄, KMnO₄ mất màu tím hoàn toàn oxi hóa Ethanol lên CH₃COOH.', 'Acidic permanganate oxidizes Ethanol to Acetic acid forming colorless Mn²⁺.', dMnA);
        }
      } else if (T >= 313.15) {
        const dMnN = Math.min(moles.C2H5OH_l / 3, moles.MnO4_aq / 4) * (1 - Math.exp(-0.55 * dt));
        if (dMnN > 1e-11) {
          consumeSpecies('C2H5OH_l', 3 * dMnN);
          consumeSpecies('MnO4_aq', 4 * dMnN);
          moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 3 * dMnN;
          moles.MnO2_s = (moles.MnO2_s || 0) + 4 * dMnN;
          moles.OH_aq = (moles.OH_aq || 0) + dMnN;
          moles.H2O_l = (moles.H2O_l || 0) + 4 * dMnN;
          heatJ += dMnN * 780000;
          pushRxn('etoh_kmno4_neut', '3C₂H₅OH + 4MnO₄⁻ —(t°)→ 3CH₃COO⁻ + 4MnO₂↓ + OH⁻ + 4H₂O', 'KMnO₄ loãng đun nhẹ oxi hóa Ethanol tạo kết tủa nâu đen MnO₂', 'Warm aqueous KMnO₄ oxidizes Ethanol → CH₃COO⁻ + MnO₂↓', 'Dung dịch KMnO₄ loãng đun nhẹ chuyển nâu đen MnO₂↓ oxi hóa Ethanol thành muối acetate.', 'Warm aqueous KMnO₄ yields brown-black MnO₂↓ and acetate salt.', dMnN);
        }
      }
    }

    // 1c. K2Cr2O7 + H+ (breathalyzer reaction: orange -> emerald green Cr3+)
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.Cr2O7_2_aq || 0) > 1e-9 && (moles.H_aq || 0) > 1e-4 && liquidVolL > 1e-6) {
      const kBr = T >= 313.15 ? 2.4 : 0.85;
      const dCrE = Math.min(moles.C2H5OH_l / 3, moles.Cr2O7_2_aq / 2, moles.H_aq / 16) * (1 - Math.exp(-kBr * dt));
      if (dCrE > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dCrE);
        consumeSpecies('Cr2O7_2_aq', 2 * dCrE);
        consumeSpecies('H_aq', 16 * dCrE);
        moles.CH3COOH_l = (moles.CH3COOH_l || 0) + 3 * dCrE;
        moles.Cr3_aq = (moles.Cr3_aq || 0) + 4 * dCrE;
        moles.H2O_l = (moles.H2O_l || 0) + 11 * dCrE;
        heatJ += dCrE * 680000;
        pushRxn('etoh_k2cr2o7', '3C₂H₅OH + 2Cr₂O₇²⁻ + 16H⁺ → 3CH₃COOH + 4Cr³⁺(xanh lục) + 11H₂O', 'K₂Cr₂O₇/H⁺ oxi hóa Ethanol đổi màu đỏ cam → xanh lục (máy đo nồng độ cồn)', 'Dichromate/H⁺ oxidizes Ethanol: orange Cr₂O₇²⁻ → green Cr³⁺', 'Cơ chế máy thổi nồng độ cồn: K₂Cr₂O₇/H₂SO₄ đổi màu cam sang xanh lục Cr³⁺ khi gặp Ethanol.', 'Classic breathalyzer redox: acidic dichromate shifts from orange to emerald green Cr³⁺.', dCrE);
      }
    }

    // 1d. HNO3 conc (>= 55%, warm >= 313 K) -> CH3COOH + NO2↑
    const nNO3E = Math.min((moles.NO3_aq || 0) + (moles.HNO3_l || 0), (moles.H_aq || 0) + (moles.HNO3_l || 0));
    if ((moles.C2H5OH_l || 0) > 1e-10 && nNO3E > 1e-4 && T >= 313.15) {
      const wN = (nNO3E * 63.013) / Math.max(1e-9, nNO3E * 63.013 + (moles.H2O_l || 0) * 18.015);
      if (wN >= 0.55) {
        const dNE = Math.min(moles.C2H5OH_l, nNO3E / 4) * (1 - Math.exp(-0.95 * dt));
        if (dNE > 1e-11) {
          consumeSpecies('C2H5OH_l', dNE);
          let rem = 4 * dNE;
          const tkA = Math.min(moles.H_aq || 0, moles.NO3_aq || 0, rem);
          if (tkA > 0) { consumeSpecies('H_aq', tkA); consumeSpecies('NO3_aq', tkA); rem -= tkA; }
          if (rem > 0 && (moles.HNO3_l || 0) > 0) consumeSpecies('HNO3_l', Math.min(moles.HNO3_l, rem));
          moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dNE;
          moles.H2O_l = (moles.H2O_l || 0) + 3 * dNE;
          gasProduced.NO2_g = (gasProduced.NO2_g || 0) + 4 * dNE;
          heatJ += dNE * 340000;
          pushRxn('etoh_hno3_conc', 'C₂H₅OH + 4HNO₃(đặc) —(t°)→ CH₃COOH + 4NO₂(g)↑ + 3H₂O', 'HNO₃ đặc đun ấm oxi hóa mãnh liệt Ethanol sinh NO₂ nâu đỏ', 'Warm conc. HNO₃ vigorously oxidizes Ethanol evolving NO₂↑', 'HNO₃ đặc (68%) đun nhẹ oxi hóa mạnh Ethanol giải phóng khí nâu đỏ NO₂.', 'Warm conc. HNO₃ oxidizes Ethanol rapidly with brown NO₂ gas.', dNE, true);
        }
      }
    }

    // 1e. H2O2 + Fenton (Fe2+) or strong acid warm (>= 323 K)
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.H2O2_aq || 0) > 1e-7 && ((moles.Fe2_aq || 0) > 1e-6 || ((moles.H_aq || 0) > 0.01 && T >= 323.15))) {
      const dFen = Math.min(moles.C2H5OH_l, moles.H2O2_aq / 2) * (1 - Math.exp(-0.65 * dt));
      if (dFen > 1e-11) {
        consumeSpecies('C2H5OH_l', dFen);
        consumeSpecies('H2O2_aq', 2 * dFen);
        moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dFen;
        moles.H2O_l = (moles.H2O_l || 0) + 3 * dFen;
        heatJ += dFen * 290000;
        pushRxn('etoh_fenton', 'C₂H₅OH + 2H₂O₂ —(Fe²⁺ / H⁺)→ CH₃COOH + 3H₂O', 'Thuốc thử Fenton (H₂O₂/Fe²⁺) oxi hóa Ethanol thành Acetic acid', 'Fenton reagent (H₂O₂/Fe²⁺) oxidizes Ethanol → Acetic acid', 'Có xúc tác Fe²⁺ (thuốc thử Fenton) hoặc acid mạnh đun nóng, H₂O₂ oxi hóa Ethanol.', 'With Fe²⁺ Fenton catalyst or hot acid, H₂O₂ oxidizes Ethanol to Acetic acid.', dFen);
      }
    }

    // 1f. Conc H2SO4 dehydration: 130-162 C -> diethyl ether; >= 165 C -> ethylene C2H4↑
    const sulfE = computeSulfuricAcidState(moles);
    if ((moles.C2H5OH_l || 0) > 1e-10 && (sulfE.w >= 0.78 || (moles.H2SO4_l || 0) > 1e-4) && T >= 403.15) {
      if (T < 435.15) {
        const dEth = (moles.C2H5OH_l / 2) * (1 - Math.exp(-0.75 * dt));
        if (dEth > 1e-11) {
          consumeSpecies('C2H5OH_l', 2 * dEth);
          moles.C2H5OC2H5_l = (moles.C2H5OC2H5_l || 0) + dEth;
          moles.H2O_l = (moles.H2O_l || 0) + dEth;
          heatJ -= dEth * 24000;
          pushRxn('etoh_ether_140', '2C₂H₅OH —(H₂SO₄ đặc, 140 °C)→ C₂H₅OC₂H₅ + H₂O', 'Tách nước liên phân tử Ethanol ở 140 °C tạo Diethyl ether', 'Intermolecular Ethanol dehydration (140 °C) → Diethyl ether', 'Ở 140 °C có xúc tác H₂SO₄ đặc, 2 phân tử Ethanol tách nước tạo Diethyl ether.', 'At 140 °C with conc. H₂SO₄, two Ethanol molecules dehydrate to Diethyl ether.', dEth);
        }
      } else {
        const dC2H4 = moles.C2H5OH_l * (1 - Math.exp(-1.15 * dt));
        if (dC2H4 > 1e-11) {
          consumeSpecies('C2H5OH_l', dC2H4);
          moles.H2O_l = (moles.H2O_l || 0) + dC2H4;
          gasProduced.C2H4_g = (gasProduced.C2H4_g || 0) + dC2H4;
          heatJ -= dC2H4 * 45500;
          pushRxn('etoh_ethene_170', 'C₂H₅OH —(H₂SO₄ đặc, 170–180 °C)→ C₂H₄(g)↑ + H₂O', 'Tách nước nội phân tử Ethanol ở 170 °C điều chế khí Ethylene (C₂H₄)', 'Intramolecular Ethanol dehydration (170 °C) → Ethylene C₂H₄↑', 'Ở 170–180 °C có H₂SO₄ đặc, Ethanol tách nước nội phân tử giải phóng khí Ethene (C₂H₄).', 'At 170–180 °C with conc. H₂SO₄, Ethanol dehydrates cleanly to Ethylene gas.', dC2H4, true);
        }
      }
    }

    // 1f-3. –OH Nucleophilic substitution: HBr/H2SO4 (80-110 C), PBr3, PCl3 & acylation (CH3CO)2O / CH3COCl
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.Br_aq || 0) > 1e-6 && (moles.H_aq || 0) > 1e-4 && T >= 353.15) {
      const dHBrSub = Math.min(moles.C2H5OH_l, moles.Br_aq, moles.H_aq) * (1 - Math.exp(-0.52 * dt));
      if (dHBrSub > 1e-11) {
        consumeSpecies('C2H5OH_l', dHBrSub);
        consumeSpecies('Br_aq', dHBrSub);
        consumeSpecies('H_aq', dHBrSub);
        moles.C2H5Br_l = (moles.C2H5Br_l || 0) + dHBrSub;
        moles.H2O_l = (moles.H2O_l || 0) + dHBrSub;
        heatJ += dHBrSub * 14000;
        pushRxn('etoh_hbr_sub', 'C₂H₅OH + HBr —(H₂SO₄ đặc, 80–100 °C)→ C₂H₅Br(l) + H₂O', 'Thế nhóm –OH Ethanol bằng HBr đun nóng tạo Bromoethane C₂H₅Br', 'Nucleophilic substitution: Ethanol + HBr (80–100 °C) → Bromoethane', 'Đun Ethanol với HBr (hoặc NaBr + H₂SO₄ đặc) thế nhóm –OH thành dẫn xuất halogen Bromoethane.', 'Heating Ethanol with HBr substitutes –OH forming Bromoethane (C₂H₅Br).', dHBrSub);
      }
    }
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.PBr3_l || 0) > 1e-9 && (moles.H2O_l || 0) < 0.04) {
      const dPBrE = Math.min(moles.C2H5OH_l / 3, moles.PBr3_l) * (1 - Math.exp(-(T >= 313.15 ? 2.4 : 0.9) * dt));
      if (dPBrE > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dPBrE);
        consumeSpecies('PBr3_l', dPBrE);
        moles.C2H5Br_l = (moles.C2H5Br_l || 0) + 3 * dPBrE;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dPBrE;
        heatJ += dPBrE * 145000;
        pushRxn('etoh_pbr3', '3C₂H₅OH + PBr₃(l) —(25–60 °C)→ 3C₂H₅Br + H₃PO₃', 'Thế –OH Ethanol bằng PBr₃ điều chế Bromoethane C₂H₅Br', 'Ethanol + PBr₃ → 3C₂H₅Br + H₃PO₃', 'PBr₃ thay thế trực tiếp nhóm –OH trong Ethanol tạo Bromoethane hiệu suất cao.', 'PBr₃ cleanly converts Ethanol to Bromoethane and phosphorous acid.', dPBrE);
      }
    }
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.PCl3_l || 0) > 1e-9 && (moles.H2O_l || 0) < 0.04) {
      const dPClE = Math.min(moles.C2H5OH_l / 3, moles.PCl3_l) * (1 - Math.exp(-(T >= 313.15 ? 2.2 : 0.85) * dt));
      if (dPClE > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dPClE);
        consumeSpecies('PCl3_l', dPClE);
        gasProduced.C2H5Cl_g = (gasProduced.C2H5Cl_g || 0) + 3 * dPClE;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dPClE;
        heatJ += dPClE * 135000;
        pushRxn('etoh_pcl3', '3C₂H₅OH + PCl₃(l) —(25–60 °C)→ 3C₂H₅Cl↑ + H₃PO₃', 'Thế –OH Ethanol bằng PCl₃ tạo khí Ethyl chloride C₂H₅Cl↑', 'Ethanol + PCl₃ → 3C₂H₅Cl↑ + H₃PO₃', 'PCl₃ thế nhóm –OH của Ethanol tạo Ethyl chloride bay hơi và H₃PO₃.', 'PCl₃ converts Ethanol to gaseous Chloroethane and H₃PO₃.', dPClE, true);
      }
    }
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.CH3CO_2O_l || 0) > 1e-9) {
      const dAnhE = Math.min(moles.C2H5OH_l, moles.CH3CO_2O_l) * (1 - Math.exp(-(T >= 323.15 ? 2.4 : 0.75) * dt));
      if (dAnhE > 1e-11) {
        consumeSpecies('C2H5OH_l', dAnhE);
        consumeSpecies('CH3CO_2O_l', dAnhE);
        moles.CH3COOC2H5_l = (moles.CH3COOC2H5_l || 0) + dAnhE;
        moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dAnhE;
        heatJ += dAnhE * 62000;
        pushRxn('etoh_anhydride', 'C₂H₅OH + (CH₃CO)₂O → CH₃COOC₂H₅ + CH₃COOH', 'Acyl hóa Ethanol bằng Acetic anhydride tạo Ethyl acetate hiệu suất ~100%', 'Acetic anhydride esterifies Ethanol cleanly → Ethyl acetate + CH₃COOH', 'Phản ứng một chiều hoàn toàn, không cần tách nước như ester hóa Fischer.', 'Irreversible acylation with Acetic anhydride gives nearly quantitative Ethyl acetate.', dAnhE);
      }
    }
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.CH3COCl_l || 0) > 1e-9) {
      const dAcClE = Math.min(moles.C2H5OH_l, moles.CH3COCl_l) * (1 - Math.exp(-4.5 * dt));
      if (dAcClE > 1e-11) {
        consumeSpecies('C2H5OH_l', dAcClE);
        consumeSpecies('CH3COCl_l', dAcClE);
        moles.CH3COOC2H5_l = (moles.CH3COOC2H5_l || 0) + dAcClE;
        gasProduced.HCl_g = (gasProduced.HCl_g || 0) + dAcClE;
        heatJ += dAcClE * 68000;
        pushRxn('etoh_ch3cocl', 'C₂H₅OH + CH₃COCl → CH₃COOC₂H₅ + HCl(g)↑', 'Ethanol phản ứng mãnh liệt với Acetyl chloride tạo Ethyl acetate + HCl↑', 'Ethanol + Acetyl chloride → Ethyl acetate + HCl↑', 'CH₃COCl phản ứng tức thì ngay nhiệt độ thường với Ethanol giải phóng khí HCl.', 'Acetyl chloride reacts rapidly at room temperature with Ethanol evolving HCl↑.', dAcClE, true);
      }
    }

    // 1g. Halogens: Br2 warm (50-70 C) -> CH3COOC2H5 + 4HBr↑; I2 + NaOH warm (50-60 C) -> CHI3↓ yellow iodoform!
    const availBr = (moles.Br2_l || 0) + (moles.Br2_aq || 0);
    if ((moles.C2H5OH_l || 0) > 1e-10 && availBr > 1e-8 && T >= 323.15 && (moles.OH_aq || 0) < 1e-5) {
      const dBrE = Math.min(moles.C2H5OH_l / 2, availBr / 2) * (1 - Math.exp(-0.72 * dt));
      if (dBrE > 1e-11) {
        consumeSpecies('C2H5OH_l', 2 * dBrE);
        let needB = 2 * dBrE;
        const tkBL = Math.min(moles.Br2_l || 0, needB);
        if (tkBL > 0) { consumeSpecies('Br2_l', tkBL); needB -= tkBL; }
        if (needB > 0) consumeSpecies('Br2_aq', Math.min(moles.Br2_aq || 0, needB));
        moles.CH3COOC2H5_l = (moles.CH3COOC2H5_l || 0) + dBrE;
        gasProduced.HBr_g = (gasProduced.HBr_g || 0) + 4 * dBrE;
        heatJ += dBrE * 85000;
        pushRxn('etoh_br2_warm', '2C₂H₅OH + 2Br₂ —(50–70 °C)→ CH₃COOC₂H₅ + 4HBr↑ (mất màu nâu đỏ)', 'Ethanol đun nhẹ (50–70 °C) làm mất màu Bromine lỏng', 'Warm Ethanol decolorizes Br₂ → Ethyl acetate + HBr↑', 'Đun nhẹ ở 50–70 °C, Br₂ mất màu nâu đỏ giải phóng HBr.', 'At 50–70 °C, Ethanol reduces brown Br₂ forming ester and HBr.', dBrE);
      }
    }
    const availI2 = (moles.I2_s || 0) + (moles.I2_aq || 0) + (moles.I3_aq || 0);
    if ((moles.C2H5OH_l || 0) > 1e-10 && availI2 > 1e-7 && (moles.OH_aq || 0) > 1e-6 && T >= 320.15) {
      const dIodo = Math.min(moles.C2H5OH_l, availI2 / 4, moles.OH_aq / 6) * (1 - Math.exp(-1.1 * dt));
      if (dIodo > 1e-11) {
        consumeSpecies('C2H5OH_l', dIodo);
        let needI = 4 * dIodo;
        for (const ik of ['I2_s', 'I2_aq', 'I3_aq']) {
          const tk = Math.min(moles[ik] || 0, needI);
          if (tk > 0) {
            consumeSpecies(ik, tk);
            if (ik === 'I3_aq') moles.I_aq = (moles.I_aq || 0) + tk;
            needI -= tk;
          }
        }
        consumeSpecies('OH_aq', 6 * dIodo);
        moles.CHI3_s = (moles.CHI3_s || 0) + dIodo;
        moles.HCOO_aq = (moles.HCOO_aq || 0) + dIodo;
        moles.I_aq = (moles.I_aq || 0) + 5 * dIodo;
        moles.H2O_l = (moles.H2O_l || 0) + 5 * dIodo;
        heatJ += dIodo * 115000;
        pushRxn('etoh_iodoform', 'C₂H₅OH + 4I₂ + 6OH⁻ —(60 °C)→ CHI₃(s)↓ (vàng tươi) + HCOO⁻ + 5I⁻ + 5H₂O', 'Phản ứng Iodoform: Ethanol + I₂/NaOH → kết tủa vàng CHI₃↓', 'Iodoform test: Ethanol + I₂/NaOH (50–60 °C) → bright yellow CHI₃↓', 'I₂ đơn chất chỉ tan màu nâu trong Ethanol, nhưng có mặt NaOH đun 50–60 °C tạo kết tủa vàng Iodoform CHI₃↓.', 'Pure I₂ merely dissolves brown in Ethanol, but with NaOH @ 50–60 °C precipitates yellow CHI₃.', dIodo);
      }
    }
  }

  // ==================== PART 1B: ETHANOL VAPOR / HETEROGENEOUS HOT CATALYSIS (C2H5OH(l) or C2H5OH(g)) ====================
  const headEt = vessel.headspaceGasMoles || {};
  const availEtTotal = (moles.C2H5OH_l || 0) + (headEt.C2H5OH_g || 0);
  if (availEtTotal > 1e-10 && T >= 493.15) {
    const consumeEtAny = (amt) => {
      let rem = amt;
      const tkL = Math.min(moles.C2H5OH_l || 0, rem);
      if (tkL > 0) { consumeSpecies('C2H5OH_l', tkL); rem -= tkL; }
      if (rem > 0 && (headEt.C2H5OH_g || 0) > 0) {
        const tkG = Math.min(headEt.C2H5OH_g, rem);
        headEt.C2H5OH_g = Math.max(0, headEt.C2H5OH_g - tkG);
        if (headEt.C2H5OH_g < 1e-13) delete headEt.C2H5OH_g;
      }
    };
    const emitHotWater = (wAmt) => {
      if (T >= 373.15) {
        gasProduced.H2O_g = (gasProduced.H2O_g || 0) + wAmt;
      } else {
        moles.H2O_l = (moles.H2O_l || 0) + wAmt;
      }
    };
    const curEtRem = () => (moles.C2H5OH_l || 0) + (headEt.C2H5OH_g || 0);

    // Hot CuO (220–300+ °C): C2H5OH(g/l) + CuO -> CH3CHO↑ + Cu(red) + H2O(g)
    if ((moles.CuO_s || 0) > 1e-9 && T >= 493.15) {
      const kCuO = T >= 523.15 ? 2.4 : 0.85;
      const dCuOE = Math.min(curEtRem(), moles.CuO_s) * (1 - Math.exp(-kCuO * dt));
      if (dCuOE > 1e-11) {
        consumeEtAny(dCuOE);
        consumeSpecies('CuO_s', dCuOE);
        moles.Cu_s = (moles.Cu_s || 0) + dCuOE;
        emitHotWater(dCuOE);
        if (T >= 295.0) {
          gasProduced.CH3CHO_g = (gasProduced.CH3CHO_g || 0) + dCuOE;
        } else {
          moles.CH3CHO_l = (moles.CH3CHO_l || 0) + dCuOE;
        }
        heatJ -= dCuOE * 8200;
        pushRxn('etoh_cuo_ald', 'C₂H₅OH(g) + CuO(đen) —(250–300 °C)→ CH₃CHO(g)↑ + Cu(đỏ)↓ + H₂O↑', 'Oxi hóa không hoàn toàn hơi Ethanol bằng CuO đun nóng → Acetaldehyde CH₃CHO + Cu đỏ', 'Mild Ethanol vapor oxidation by hot CuO (250–300 °C) → CH₃CHO + Cu(red)', 'Bột CuO đen oxi hóa hơi Ethanol thành Acetaldehyde CH₃CHO mùi táo xanh và khử về Cu đỏ.', 'Hot black CuO oxidizes Ethanol vapor selectively to Acetaldehyde (green-apple odor) and red Cu.', dCuOE, true);
      }
    }

    // Catalytic Al2O3 dehydration & Lebedev reaction (Al2O3 + ZnO, 370-450+ °C -> Buta-1,3-diene)
    const etCatLeft = curEtRem();
    if (etCatLeft > 1e-10 && (moles.Al2O3_s || 0) > 1e-7 && T >= 513.15) {
      if ((moles.ZnO_s || 0) > 1e-7 && T >= 643.15) {
        const dLeb = (etCatLeft / 2) * (1 - Math.exp(-1.65 * dt));
        if (dLeb > 1e-11) {
          consumeEtAny(2 * dLeb);
          emitHotWater(2 * dLeb);
          gasProduced.C4H6_g = (gasProduced.C4H6_g || 0) + dLeb;
          gasProduced.H2_g = (gasProduced.H2_g || 0) + dLeb;
          heatJ -= dLeb * 102000;
          pushRxn('etoh_lebedev', '2C₂H₅OH —(Al₂O₃ + ZnO, 400–450 °C)→ CH₂=CH–CH=CH₂(g)↑ + 2H₂O + H₂↑', 'Phản ứng Lebedev tổng hợp Buta-1,3-diene từ Ethanol', 'Lebedev synthesis: Ethanol —(Al₂O₃/ZnO, 450 °C)→ Buta-1,3-diene↑', 'Trên hệ xúc tác Al₂O₃ + ZnO ở 400–450 °C, hơi Ethanol đóng mạch tách nước và H₂ tạo khí Buta-1,3-diene.', 'Over mixed Al₂O₃ + ZnO catalyst at 400–450 °C, Ethanol vapor yields Buta-1,3-diene and H₂.', dLeb, true);
        }
      } else if (T < 603.15) {
        const dAlEth = (etCatLeft / 2) * (1 - Math.exp(-1.15 * dt));
        if (dAlEth > 1e-11) {
          consumeEtAny(2 * dAlEth);
          moles.C2H5OC2H5_l = (moles.C2H5OC2H5_l || 0) + dAlEth;
          emitHotWater(dAlEth);
          heatJ -= dAlEth * 24000;
          pushRxn('etoh_al2o3_ether', '2C₂H₅OH —(Al₂O₃, 240–260 °C)→ C₂H₅OC₂H₅ + H₂O', 'Tách nước dị thể qua xúc tác Al₂O₃ (240–260 °C) tạo Diethyl ether', 'Al₂O₃-catalyzed Ethanol dehydration (250 °C) → Diethyl ether', 'Xúc tác Al₂O₃ ở 240–260 °C tách nước liên phân tử hơi Ethanol tạo Diethyl ether.', 'Al₂O₃ catalyst at 240–260 °C dehydrates Ethanol vapor to Diethyl ether.', dAlEth);
        }
      } else {
        const dAlC2H4 = etCatLeft * (1 - Math.exp(-1.55 * dt));
        if (dAlC2H4 > 1e-11) {
          consumeEtAny(dAlC2H4);
          emitHotWater(dAlC2H4);
          gasProduced.C2H4_g = (gasProduced.C2H4_g || 0) + dAlC2H4;
          heatJ -= dAlC2H4 * 45500;
          pushRxn('etoh_al2o3_ethene', 'C₂H₅OH —(Al₂O₃, 350–400 °C)→ C₂H₄(g)↑ + H₂O', 'Tách nước qua Al₂O₃ (350–400 °C) tạo Ethylene C₂H₄↑', 'Al₂O₃ dehydration of Ethanol (350–400 °C) → Ethylene C₂H₄↑', 'Ở 350–400 °C trên Al₂O₃, hơi Ethanol tách nước nội phân tử sinh khí Ethene.', 'Over Al₂O₃ at 350–400 °C, Ethanol vapor dehydrates to Ethylene gas.', dAlC2H4, true);
        }
      }
    }
  }

  // ==================== PART 2: GLACIAL ACETIC ACID (CH3COOH_l) ====================
  if ((moles.CH3COOH_l || 0) > 1e-10 && orgMob > 0) {
    const nWaterAc = moles.H2O_l || 0;
    const isGlacialDry = nWaterAc < 0.02;

    // 2a. Neutralization with NaOH / OH- & NH3
    if ((moles.OH_aq || 0) > 1e-9) {
      const dNeut = Math.min(moles.CH3COOH_l, moles.OH_aq) * (1 - Math.exp(-16.0 * dt));
      if (dNeut > 1e-11) {
        consumeSpecies('CH3COOH_l', dNeut);
        consumeSpecies('OH_aq', dNeut);
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dNeut;
        moles.H2O_l = (moles.H2O_l || 0) + dNeut;
        heatJ += dNeut * 56200;
        pushRxn('acoh_naoh', 'CH₃COOH + OH⁻(aq) → CH₃COO⁻(aq) + H₂O', 'Trung hòa Acetic acid bằng dung dịch kiềm mạnh', 'Neutralization of Acetic acid by strong alkali', 'CH₃COOH phản ứng trung hòa nhanh, tỏa nhiệt với NaOH/KOH tạo muối acetate.', 'Acetic acid neutralizes rapidly with NaOH/OH⁻ yielding acetate salt.', dNeut);
      }
    }
    if ((moles.CH3COOH_l || 0) > 1e-10 && (moles.NH3_aq || 0) > 1e-9) {
      const dAmA = Math.min(moles.CH3COOH_l, moles.NH3_aq) * (1 - Math.exp(-12.0 * dt));
      if (dAmA > 1e-11) {
        consumeSpecies('CH3COOH_l', dAmA);
        consumeSpecies('NH3_aq', dAmA);
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dAmA;
        moles.NH4_aq = (moles.NH4_aq || 0) + dAmA;
        heatJ += dAmA * 51500;
        pushRxn('acoh_nh3', 'CH₃COOH + NH₃(aq) → CH₃COONH₄(aq)', 'Acetic acid tác dụng với dung dịch Ammonia tạo Ammonium acetate', 'Acetic acid + NH₃(aq) → Ammonium acetate solution', 'Phản ứng xảy ra ngay nhiệt độ thường tạo dung dịch CH₃COONH₄.', 'CH₃COOH reacts immediately with Ammonia forming Ammonium acetate.', dAmA);
      }
    }

    // 2b. Metals: Na/K vigorous @ 25 C; Mg/Zn slow glacial 25 C -> fast warm/aq; Fe boiling/aq warm; Al PASSIVE!
    for (const [mId, catId, kRate] of [['Na_s', 'Na_aq', 3.4], ['K_s', 'K_aq', 4.6]]) {
      const nAlk = moles[mId] || 0;
      if (nAlk > 1e-10 && (moles.CH3COOH_l || 0) > 1e-10) {
        const dAlkA = Math.min(nAlk, moles.CH3COOH_l) * (1 - Math.exp(-kRate * dt));
        if (dAlkA > 1e-11) {
          consumeSpecies(mId, dAlkA);
          consumeSpecies('CH3COOH_l', dAlkA);
          moles[catId] = (moles[catId] || 0) + dAlkA;
          moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dAlkA;
          gasProduced.H2_g = (gasProduced.H2_g || 0) + 0.5 * dAlkA;
          heatJ += dAlkA * 185000;
          pushRxn(`acoh_${mId}`, `2CH₃COOH + 2${SPECIES[mId].formula} → 2CH₃COO${SPECIES[mId].formula} + H₂(g)↑`, `${SPECIES[mId].formula} tác dụng mãnh liệt với Acetic acid giải phóng H₂`, `Vigorous reaction: ${SPECIES[mId].formula} + CH₃COOH → acetate + H₂↑`, `${SPECIES[mId].formula} khử ngay H⁺ trong Acetic acid ngay nhiệt độ thường sinh khí H₂.`, `${SPECIES[mId].formula} reacts vigorously with Acetic acid evolving H₂↑.`, dAlkA, true);
        }
      }
    }
    for (const [mId, catId, kDryCold, kHotAq, minHotK] of [
      ['Mg_s', 'Mg2_aq', 0.012, 0.95, 323.15],
      ['Zn_s', 'Zn2_aq', 0.008, 0.65, 333.15],
      ['Fe_s', 'Fe2_aq', 0.0, 0.22, 373.15],
    ]) {
      const nM = moles[mId] || 0;
      if (nM > 1e-10 && (moles.CH3COOH_l || 0) > 1e-10) {
        const boosted = T >= minHotK || (!isGlacialDry && (mId !== 'Fe_s' || T >= 333.15));
        const rate = boosted ? kHotAq : kDryCold;
        if (rate > 0) {
          const dMAc = Math.min(nM, moles.CH3COOH_l / 2) * (1 - Math.exp(-rate * dt));
          if (dMAc > 1e-11) {
            consumeSpecies(mId, dMAc);
            consumeSpecies('CH3COOH_l', 2 * dMAc);
            moles[catId] = (moles[catId] || 0) + dMAc;
            moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dMAc;
            gasProduced.H2_g = (gasProduced.H2_g || 0) + dMAc;
            heatJ += dMAc * 145000;
            pushRxn(`acoh_${mId}`, `2CH₃COOH + ${SPECIES[mId].formula} → (CH₃COO)₂${SPECIES[mId].formula} + H₂(g)↑`, `${SPECIES[mId].formula} tan trong Acetic acid giải phóng H₂`, `${SPECIES[mId].formula} reacts with Acetic acid evolving H₂↑`, `${SPECIES[mId].formula} phản ứng rất chậm trong CH₃COOH băng nguội, nhanh hơn rõ rệt khi đun nóng hoặc pha nước.`, `${SPECIES[mId].formula} reacts slowly in cold glacial CH₃COOH and rapidly when heated or diluted.`, dMAc, true);
          }
        }
      }
    }

    // 2c. Carbonates (CaCO3 / Na2CO3 / NaHCO3) & CaC2: slow dry cold -> rapid warm/aq
    for (const [cId, stA, catId, catSt, wMake] of [
      ['CaCO3_s', 2, 'Ca2_aq', 1, 1],
      ['Na2CO3_s', 2, 'Na_aq', 2, 1],
      ['NaHCO3_s', 1, 'Na_aq', 1, 1],
    ]) {
      const nCarb = moles[cId] || 0;
      if (nCarb > 1e-10 && (moles.CH3COOH_l || 0) > 1e-10) {
        const kCarb = !isGlacialDry || T >= 323.15 ? 1.4 : 0.015;
        const dC = Math.min(nCarb, moles.CH3COOH_l / stA) * (1 - Math.exp(-kCarb * dt));
        if (dC > 1e-11) {
          consumeSpecies(cId, dC);
          consumeSpecies('CH3COOH_l', stA * dC);
          moles[catId] = (moles[catId] || 0) + catSt * dC;
          moles.CH3COO_aq = (moles.CH3COO_aq || 0) + stA * dC;
          moles.H2O_l = (moles.H2O_l || 0) + wMake * dC;
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dC;
          heatJ += dC * 18000;
          pushRxn(`acoh_${cId}`, `${stA > 1 ? stA : ''}CH₃COOH + ${SPECIES[cId].formula} → acetate + CO₂(g)↑ + H₂O`, `Acetic acid đẩy khí CO₂ khỏi muối ${SPECIES[cId].formula}`, `Acetic acid liberates CO₂↑ from ${SPECIES[cId].formula}`, 'Trong CH₃COOH băng khan ở 25 °C phản ứng chậm; thêm nước hoặc đun nóng sủi bọt CO₂ mạnh.', 'Slow in anhydrous glacial acid at 25 °C; vigorous CO₂ effervescence when warmed or diluted.', dC, true);
        }
      }
    }
    if ((moles.CaC2_s || 0) > 1e-10 && (moles.CH3COOH_l || 0) > 1e-10 && (T >= 353.15 || !isGlacialDry)) {
      const dCa2A = Math.min(moles.CaC2_s, moles.CH3COOH_l / 2) * (1 - Math.exp(-(T >= 353.15 ? 0.95 : 0.35) * dt));
      if (dCa2A > 1e-11) {
        consumeSpecies('CaC2_s', dCa2A);
        consumeSpecies('CH3COOH_l', 2 * dCa2A);
        moles.Ca2_aq = (moles.Ca2_aq || 0) + dCa2A;
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dCa2A;
        gasProduced.C2H2_g = (gasProduced.C2H2_g || 0) + dCa2A;
        heatJ += dCa2A * 95000;
        pushRxn('acoh_cac2', '2CH₃COOH + CaC₂ —(80–118 °C)→ (CH₃COO)₂Ca + C₂H₂(g)↑', 'Acetic acid đun nóng phân hủy CaC₂ giải phóng khí Ethyne C₂H₂', 'Hot Acetic acid + CaC₂ → Calcium acetate + C₂H₂↑', 'Khi đun nóng (80–118 °C), CH₃COOH phản ứng với CaC₂ tạo khí C₂H₂.', 'When heated (80–118 °C), CH₃COOH decomposes CaC₂ evolving Ethyne gas.', dCa2A, true);
      }
    }

    // 2d. Reversible Fischer Esterification: CH3COOH + C2H5OH ⇄ CH3COOC2H5 + H2O (Kc ~ 4.0, dH° = -3.8 kJ/mol, Ea ~ 50 kJ/mol)
    // Extended Arrhenius sensitivity: k1 = (k_uncat + k_cat * [H+]) * exp(-Ea/(R*T)), scaled into playable lab speed while preserving exact Kc = 4.0 equilibrium!
    const effVolEst = Math.max(1e-4, liquidVolL || 0.02);
    const cAcidCat = ((moles.H2SO4_l || 0) * 1.6 + (moles.H_aq || 0)) / effVolEst;
    const hasAcidCat = (moles.H2SO4_l || 0) > 1e-5 || (cAcidCat >= 0.35 && ((moles.SO4_2_aq || 0) + (moles.HSO4_aq || 0) + (moles.Cl_aq || 0)) > 1e-5);
    if (((moles.CH3COOH_l || 0) > 1e-8 && (moles.C2H5OH_l || 0) > 1e-8) || ((moles.CH3COOC2H5_l || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-8 && hasAcidCat)) {
      const KcEst = Math.max(3.5, Math.min(4.4, 4.0 * Math.exp((-3800 / CONSTANTS.R_J_MOL_K) * (1 / Math.max(250, T) - 1 / 348.15))));
      const eaEstJ = 50000;
      const arrhRatio = Math.exp((-eaEstJ / CONSTANTS.R_J_MOL_K) * (1 / Math.max(250, T) - 1 / 353.15));
      // Catalyzed reflux (75–85 C, ~1 M H+) equilibrates in ~4–8s lab time; cold (25 C) ~23x slower; uncatalyzed ~1000x slower!
      const catFactor = (hasAcidCat ? 0.001 + 1.0 * Math.max(0.25, Math.min(3.5, cAcidCat)) : 0.0008);
      const k1Sim = 0.055 * catFactor * arrhRatio;
      const kRevSim = k1Sim / KcEst;

      const cAc = (moles.CH3COOH_l || 0) / effVolEst;
      const cEt = (moles.C2H5OH_l || 0) / effVolEst;
      const cEst = (moles.CH3COOC2H5_l || 0) / effVolEst;
      const cW = (moles.H2O_l || 0) / effVolEst;
      const dcDt = k1Sim * cAc * cEt - kRevSim * cEst * cW;
      const dMolRaw = dcDt * effVolEst * dt;
      if (dMolRaw > 1e-11) {
        const dEst = Math.min(moles.CH3COOH_l || 0, moles.C2H5OH_l || 0, dMolRaw * 1.0);
        if (dEst > 1e-11) {
          consumeSpecies('CH3COOH_l', dEst);
          consumeSpecies('C2H5OH_l', dEst);
          moles.CH3COOC2H5_l = (moles.CH3COOC2H5_l || 0) + dEst;
          moles.H2O_l = (moles.H2O_l || 0) + dEst;
          heatJ += dEst * 3800; // slightly exothermic ΔH° = -3.8 kJ/mol
          if (hasAcidCat || T >= 345.0) {
            pushRxn('fischer_esterification', 'CH₃COOH + C₂H₅OH ⇌(H₂SO₄ đặc; 75–85 °C) CH₃COOC₂H₅ + H₂O', 'Phản ứng Ester hóa thuận nghịch (Kc ≈ 4): Tạo Ethyl acetate thơm dầu chuối', 'Reversible Fischer Esterification (Kc ≈ 4): Acetic acid + Ethanol ⇄ Ethyl acetate + H₂O', 'H₂SO₄ đặc vừa xúc tác vừa hút nước; đạt cân bằng thuận nghịch Kc ≈ 4 (tỉ lệ 1:1 đạt 66,7%, dư EtOH 1:2 đạt 84,5%, tách nước đạt ~100%).', 'Conc. H₂SO₄ catalyzes reversible esterification (Kc ≈ 4: 1:1 gives 66.7%, 1:2 EtOH excess gives 84.5%, removing H₂O approaches 100%).', dEst);
          }
        }
      } else if (dMolRaw < -1e-11 && hasAcidCat) {
        const dHyd = Math.min(moles.CH3COOC2H5_l || 0, moles.H2O_l || 0, -dMolRaw);
        if (dHyd > 1e-11) {
          consumeSpecies('CH3COOC2H5_l', dHyd);
          consumeSpecies('H2O_l', dHyd);
          moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dHyd;
          moles.C2H5OH_l = (moles.C2H5OH_l || 0) + dHyd;
          heatJ -= dHyd * 3800;
          pushRxn('fischer_hydrolysis', 'CH₃COOC₂H₅ + H₂O ⇌(H⁺; t°) CH₃COOH + C₂H₅OH', 'Thủy phân thuận nghịch Ethyl acetate tiến về trạng thái cân bằng Kc ≈ 4', 'Acid-catalyzed reverse ester hydrolysis approaching Kc ≈ 4', 'Khi dư nước hoặc sản phẩm vượt quá cân bằng Kc ≈ 4, ester bị thủy phân ngược lại một phần.', 'Excess water partially hydrolyzes Ethyl acetate back toward Kc ≈ 4 equilibrium.', dHyd);
        }
      }
      // Overheating conc. H2SO4 side-charring > 145 C with large excess conc. H2SO4
      if (T >= 418.15 && (moles.H2SO4_l || 0) >= 0.08 && (moles.C2H5OH_l || 0) > 1e-4 && (moles.H2SO4_l || 0) > (moles.C2H5OH_l || 0) * 0.45) {
        const dChar = Math.min(moles.C2H5OH_l, moles.H2SO4_l / 6) * (1 - Math.exp(-0.08 * dt));
        if (dChar > 1e-10) {
          consumeSpecies('C2H5OH_l', dChar);
          consumeSpecies('H2SO4_l', 6 * dChar);
          moles.C_s = (moles.C_s || 0) + 2 * dChar;
          moles.H2O_l = (moles.H2O_l || 0) + 9 * dChar;
          gasProduced.SO2_g = (gasProduced.SO2_g || 0) + 6 * dChar;
          pushRxn('etoh_h2so4_char', 'C₂H₅OH + 6H₂SO₄(đặc) —(>145 °C)→ 2C↓ (đen) + 6SO₂↑ + 9H₂O', 'Quá nhiệt H₂SO₄ đặc (>140 °C) oxi hóa sẫm màu hỗn hợp & sinh khí SO₂', 'Conc. H₂SO₄ overheating (>140 °C) chars mixture & evolves SO₂↑', 'Dùng quá nhiều H₂SO₄ đặc hoặc đun >130–140 °C gây tách nước tạo ether/ethene và oxi hóa sẫm màu.', 'Excess conc. H₂SO₄ or overheating (>130–140 °C) triggers ether/ethene side-reactions and dark charring.', dChar);
        }
      }
    }

    // 2e. Peracetic acid (CH3COOH + H2O2 with H2SO4 cat) & prolonged boiling KMnO4/H2SO4 -> CO2↑
    if ((moles.CH3COOH_l || 0) > 1e-9 && (moles.H2O2_aq || 0) > 1e-7 && hasAcidCat && T >= 295.0) {
      const dPaa = Math.min(moles.CH3COOH_l, moles.H2O2_aq) * (1 - Math.exp(-0.45 * dt));
      if (dPaa > 1e-11) {
        consumeSpecies('CH3COOH_l', dPaa);
        consumeSpecies('H2O2_aq', dPaa);
        moles.CH3COOOH_aq = (moles.CH3COOOH_aq || 0) + dPaa;
        moles.H2O_l = (moles.H2O_l || 0) + dPaa;
        pushRxn('acoh_h2o2_peracetic', 'CH₃COOH + H₂O₂ ⇌(H₂SO₄) CH₃COOOH + H₂O', 'Tạo Peracetic acid (CH₃COOOH) từ Acetic acid + H₂O₂', 'Peracetic acid synthesis: CH₃COOH + H₂O₂ (H₂SO₄ cat)', 'Trong môi trường H₂SO₄, CH₃COOH và H₂O₂ tạo cân bằng sinh Peracetic acid khử trùng mạnh.', 'Acetic acid reacts with H₂O₂ under H₂SO₄ catalysis forming Peracetic acid.', dPaa);
      }
    }
    if ((moles.CH3COOH_l || 0) > 1e-9 && (moles.MnO4_aq || 0) > 1e-8 && (moles.H_aq || 0) >= 0.05 && T >= 363.15) {
      const dKAc = Math.min(moles.CH3COOH_l / 5, moles.MnO4_aq / 8, moles.H_aq / 24) * (1 - Math.exp(-0.08 * dt));
      if (dKAc > 1e-11) {
        consumeSpecies('CH3COOH_l', 5 * dKAc);
        consumeSpecies('MnO4_aq', 8 * dKAc);
        consumeSpecies('H_aq', 24 * dKAc);
        moles.Mn2_aq = (moles.Mn2_aq || 0) + 8 * dKAc;
        moles.H2O_l = (moles.H2O_l || 0) + 22 * dKAc;
        gasProduced.CO2_g = (gasProduced.CO2_g || 0) + 10 * dKAc;
        heatJ += dKAc * 950000;
        pushRxn('acoh_kmno4_boil', '5CH₃COOH + 8MnO₄⁻ + 24H⁺ —(đun sôi kéo dài)→ 10CO₂↑ + 8Mn²⁺ + 22H₂O', 'KMnO₄/H₂SO₄ đun sôi mạnh kéo dài mới oxi hóa chậm CH₃COOH thành CO₂', 'Prolonged boiling KMnO₄/H⁺ slowly oxidizes Acetic acid → CO₂↑', 'CH₃COOH bền ở nhiệt độ thường; chỉ đun sôi kéo dài với KMnO₄/H⁺ đặc mới mất màu tím sinh CO₂.', 'CH₃COOH resists ambient KMnO₄; only prolonged boiling in strong acid slowly yields CO₂.', dKAc);
      }
    }

    // 2f. Basic oxides & hydroxides: CuO(t° >= 55 C), Cu(OH)2, ZnO, CaO, Ca(OH)2
    if ((moles.CuO_s || 0) > 1e-9 && T >= 323.15) {
      const dCuOAc = Math.min(moles.CuO_s, moles.CH3COOH_l / 2) * (1 - Math.exp(-0.85 * dt));
      if (dCuOAc > 1e-11) {
        consumeSpecies('CuO_s', dCuOAc);
        consumeSpecies('CH3COOH_l', 2 * dCuOAc);
        moles.Cu2_aq = (moles.Cu2_aq || 0) + dCuOAc;
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dCuOAc;
        moles.H2O_l = (moles.H2O_l || 0) + dCuOAc;
        heatJ += dCuOAc * 42000;
        pushRxn('acoh_cuo', 'CuO(đen) + 2CH₃COOH —(60–90 °C)→ (CH₃COO)₂Cu(xanh lam) + H₂O', 'CuO tan trong Acetic acid đun nóng tạo dung dịch Copper(II) acetate xanh lam', 'Hot Acetic acid dissolves black CuO → blue Copper(II) acetate', 'Bột CuO đen tan dần khi đun nóng trong CH₃COOH cho dung dịch xanh ngọc lam đặc trưng.', 'Black CuO dissolves in warm Acetic acid giving characteristic blue-teal Copper(II) acetate.', dCuOAc);
      }
    }
    for (const [oxId, catId, wSt, kOx, labelVi, labelEn] of [
      ['CuOH2_s', 'Cu2_aq', 2, 1.8, 'Cu(OH)₂ xanh lam tan trong Acetic acid', 'Blue Cu(OH)₂ dissolves in Acetic acid'],
      ['ZnO_s', 'Zn2_aq', 1, 1.4, 'ZnO tan trong Acetic acid tạo (CH₃COO)₂Zn', 'ZnO dissolves in Acetic acid → Zinc acetate'],
      ['CaO_s', 'Ca2_aq', 1, 2.2, 'CaO tác dụng với Acetic acid tạo (CH₃COO)₂Ca', 'CaO + CH₃COOH → Calcium acetate'],
      ['CaOH2_s', 'Ca2_aq', 2, 2.8, 'Ca(OH)₂ trung hòa Acetic acid tạo (CH₃COO)₂Ca', 'Ca(OH)₂ neutralizes CH₃COOH → Calcium acetate'],
    ]) {
      const nOx = moles[oxId] || 0;
      if (nOx > 1e-9 && (moles.CH3COOH_l || 0) > 1e-10) {
        const dOx = Math.min(nOx, moles.CH3COOH_l / 2) * (1 - Math.exp(-kOx * dt));
        if (dOx > 1e-11) {
          consumeSpecies(oxId, dOx);
          consumeSpecies('CH3COOH_l', 2 * dOx);
          moles[catId] = (moles[catId] || 0) + dOx;
          moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dOx;
          moles.H2O_l = (moles.H2O_l || 0) + wSt * dOx;
          heatJ += dOx * 52000;
          pushRxn(`acoh_${oxId}`, `${SPECIES[oxId].formula} + 2CH₃COOH → (CH₃COO)₂M + ${wSt > 1 ? wSt : ''}H₂O`, labelVi, labelEn, labelVi, labelEn, dOx);
        }
      }
    }

    // 2g. Carboxylic Acid Derivatives: PCl3 -> CH3COCl, P4O10 -> Acetic anhydride (CH3CO)2O
    if ((moles.PCl3_l || 0) > 1e-9 && (moles.H2O_l || 0) < 0.04) {
      const dAcCl = Math.min(moles.CH3COOH_l / 3, moles.PCl3_l) * (1 - Math.exp(-(T >= 313.15 ? 1.8 : 0.45) * dt));
      if (dAcCl > 1e-11) {
        consumeSpecies('CH3COOH_l', 3 * dAcCl);
        consumeSpecies('PCl3_l', dAcCl);
        moles.CH3COCl_l = (moles.CH3COCl_l || 0) + 3 * dAcCl;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dAcCl;
        heatJ += dAcCl * 85000;
        pushRxn('acoh_pcl3', '3CH₃COOH + PCl₃(l) —(50 °C)→ 3CH₃COCl(l) + H₃PO₃', 'Tổng hợp Acetyl chloride từ Acetic acid + PCl₃', 'Acetyl chloride synthesis: 3CH₃COOH + PCl₃ → 3CH₃COCl + H₃PO₃', 'PCl₃ thế nhóm –OH trong nhóm carboxyl tạo Acetyl chloride (CH₃COCl).', 'PCl₃ converts Acetic acid into Acetyl chloride (CH₃COCl).', dAcCl);
      }
    }
    if ((moles.P4O10_s || 0) > 1e-9 && (moles.H2O_l || 0) < 0.05 && T >= 333.15) {
      const dAnh = Math.min(moles.CH3COOH_l / 12, moles.P4O10_s) * (1 - Math.exp(-0.95 * dt));
      if (dAnh > 1e-11) {
        consumeSpecies('CH3COOH_l', 12 * dAnh);
        consumeSpecies('P4O10_s', dAnh);
        moles.CH3CO_2O_l = (moles.CH3CO_2O_l || 0) + 6 * dAnh;
        moles.H3PO4_aq = (moles.H3PO4_aq || 0) + 4 * dAnh;
        heatJ += dAnh * 165000;
        pushRxn('acoh_p4o10_anhydride', '12CH₃COOH + P₄O₁₀ —(t°)→ 6(CH₃CO)₂O(l) + 4H₃PO₄', 'Tách nước Acetic acid bằng P₄O₁₀ điều chế Acetic anhydride (CH₃CO)₂O', 'P₄O₁₀ dehydrates Acetic acid → Acetic anhydride (CH₃CO)₂O', 'P₄O₁₀ hút nước mạnh giúp hai phân tử CH₃COOH tách 1 H₂O tạo Acetic anhydride.', 'Strong dehydrating agent P₄O₁₀ condenses Acetic acid into Acetic anhydride.', dAnh);
      }
    }

    // 2h. Alpha-C Hell-Volhard-Zelinsky (HVZ) halogenation: CH3COOH + Cl2/Br2 —(P_red or UV, 80-100 C)→ haloacetic acid
    const hasHVZCat = (moles.P_red_s || 0) > 1e-8 || Boolean(options?.uvLight);
    if (hasHVZCat && T >= 348.15) {
      const head = vessel.headspaceGasMoles || {};
      const nClHVZ = (head.Cl2_g || 0) + (moles.Cl2_aq || 0);
      if (nClHVZ > 1e-8) {
        const dHClV = Math.min(moles.CH3COOH_l, nClHVZ) * (1 - Math.exp(-0.75 * dt));
        if (dHClV > 1e-11) {
          consumeSpecies('CH3COOH_l', dHClV);
          let needC = dHClV;
          const tkCg = Math.min(head.Cl2_g || 0, needC);
          if (tkCg > 0) { head.Cl2_g -= tkCg; if (head.Cl2_g < 1e-13) delete head.Cl2_g; needC -= tkCg; }
          if (needC > 0 && (moles.Cl2_aq || 0) > 0) consumeSpecies('Cl2_aq', Math.min(moles.Cl2_aq, needC));
          moles.ClCH2COOH_s = (moles.ClCH2COOH_s || 0) + dHClV;
          gasProduced.HCl_g = (gasProduced.HCl_g || 0) + dHClV;
          heatJ += dHClV * 95000;
          pushRxn('acoh_hvz_cl', 'CH₃COOH + Cl₂ —(P đỏ / UV, 80–100 °C)→ ClCH₂COOH + HCl(g)↑', 'Phản ứng thế gốc –CH₃ (HVZ): Tạo Chloroacetic acid & HCl↑', 'Alpha-C halogenation: CH₃COOH + Cl₂ (P_red / UV) → ClCH₂COOH + HCl↑', 'Có xúc tác P đỏ (hoặc UV) ở 80–100 °C, Cl₂ thế H ở vị trí alpha tạo Chloroacetic acid.', 'With red P catalyst or UV at 80–100 °C, Cl₂ substitutes alpha-H forming Chloroacetic acid.', dHClV, true);
        }
      }
      const nBrHVZ = (moles.Br2_l || 0) + (moles.Br2_aq || 0);
      if (nBrHVZ > 1e-8) {
        const dHBrV = Math.min(moles.CH3COOH_l, nBrHVZ) * (1 - Math.exp(-0.68 * dt));
        if (dHBrV > 1e-11) {
          consumeSpecies('CH3COOH_l', dHBrV);
          let needB = dHBrV;
          const tkBl = Math.min(moles.Br2_l || 0, needB);
          if (tkBl > 0) { consumeSpecies('Br2_l', tkBl); needB -= tkBl; }
          if (needB > 0 && (moles.Br2_aq || 0) > 0) consumeSpecies('Br2_aq', Math.min(moles.Br2_aq, needB));
          moles.BrCH2COOH_s = (moles.BrCH2COOH_s || 0) + dHBrV;
          gasProduced.HBr_g = (gasProduced.HBr_g || 0) + dHBrV;
          heatJ += dHBrV * 82000;
          pushRxn('acoh_hvz_br', 'CH₃COOH + Br₂ —(P đỏ, 80–100 °C)→ BrCH₂COOH + HBr(g)↑', 'Phản ứng Hell–Volhard–Zelinsky: CH₃COOH + Br₂ (P đỏ) → Bromoacetic acid + HBr↑', 'Hell–Volhard–Zelinsky: CH₃COOH + Br₂ (P_red) → BrCH₂COOH + HBr↑', 'Phản ứng Hell–Volhard–Zelinsky (xúc tác P đỏ) thế Br vào carbon alpha nhóm CH₃ tạo BrCH₂COOH.', 'Hell–Volhard–Zelinsky alpha-bromination with red P yields Bromoacetic acid and HBr↑.', dHBrV, true);
        }
      }
    }
  }

  // ==================== PART 3: ORGANIC DERIVATIVES, ACETATE PYROLYSIS & SODA-LIME ====================
  // 3a. Hydrolysis of (C2H5O)2Ca, CH3COCl, (CH3CO)2O in aqueous water
  if ((moles.CaC2H5O_2_s || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-7 && orgMob > 0) {
    const dHydCaE = Math.min(moles.CaC2H5O_2_s, moles.H2O_l / 2) * (1 - Math.exp(-4.5 * dt));
    if (dHydCaE > 1e-11) {
      consumeSpecies('CaC2H5O_2_s', dHydCaE);
      consumeSpecies('H2O_l', 2 * dHydCaE);
      moles.CaOH2_s = (moles.CaOH2_s || 0) + dHydCaE;
      moles.C2H5OH_l = (moles.C2H5OH_l || 0) + 2 * dHydCaE;
      heatJ += dHydCaE * 78000;
      pushRxn('cac2h5o2_hyd', '(C₂H₅O)₂Ca + 2H₂O → Ca(OH)₂ + 2C₂H₅OH', 'Thủy phân Calcium ethoxide trong nước', 'Hydrolysis of Calcium ethoxide', 'Ethoxide kim loại bị thủy phân hoàn toàn trong nước tái tạo Ethanol.', 'Calcium ethoxide hydrolyzes cleanly to Ca(OH)₂ and Ethanol.', dHydCaE);
    }
  }
  if ((moles.CH3COCl_l || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-7 && orgMob > 0) {
    const dHydAcCl = Math.min(moles.CH3COCl_l, moles.H2O_l) * (1 - Math.exp(-6.5 * dt));
    if (dHydAcCl > 1e-11) {
      consumeSpecies('CH3COCl_l', dHydAcCl);
      consumeSpecies('H2O_l', dHydAcCl);
      moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dHydAcCl;
      moles.H_aq = (moles.H_aq || 0) + dHydAcCl;
      moles.Cl_aq = (moles.Cl_aq || 0) + dHydAcCl;
      heatJ += dHydAcCl * 92000;
      pushRxn('ch3cocl_hyd', 'CH₃COCl + H₂O → CH₃COOH + HCl(aq)', 'Thủy phân mãnh liệt Acetyl chloride', 'Vigorous Acetyl chloride hydrolysis', 'CH₃COCl thủy phân ngay trong nước tạo Acetic acid và HCl.', 'Acetyl chloride hydrolyzes briskly forming CH₃COOH and HCl.', dHydAcCl);
    }
  }
  if ((moles.CH3CO_2O_l || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-7 && orgMob > 0) {
    const kHA = T >= 323.15 ? 2.4 : 0.35;
    const dHydAnh = Math.min(moles.CH3CO_2O_l, moles.H2O_l) * (1 - Math.exp(-kHA * dt));
    if (dHydAnh > 1e-11) {
      consumeSpecies('CH3CO_2O_l', dHydAnh);
      consumeSpecies('H2O_l', dHydAnh);
      moles.CH3COOH_l = (moles.CH3COOH_l || 0) + 2 * dHydAnh;
      heatJ += dHydAnh * 58000;
      pushRxn('anhydride_hyd', '(CH₃CO)₂O + H₂O → 2CH₃COOH', 'Thủy phân Acetic anhydride thành Acetic acid', 'Acetic anhydride hydrolysis → 2CH₃COOH', 'Acetic anhydride thủy phân tạo 2 phân tử Acetic acid.', 'Acetic anhydride hydrolyzes yielding two equivalents of Acetic acid.', dHydAnh);
    }
  }

  // 3b. Acetamide dehydration: CH3COONH4 —(150–200 °C)→ CH3CONH2 + H2O↑
  if ((moles.CH3COONH4_s || 0) > 1e-9 && T >= 423.15) {
    const dAmide = moles.CH3COONH4_s * (1 - Math.exp(-0.55 * dt));
    if (dAmide > 1e-11) {
      consumeSpecies('CH3COONH4_s', dAmide);
      moles.CH3CONH2_s = (moles.CH3CONH2_s || 0) + dAmide;
      gasProduced.H2O_g = (gasProduced.H2O_g || 0) + dAmide;
      heatJ -= dAmide * 48000;
      pushRxn('ch3coonh4_acetamide', 'CH₃COONH₄(s) —(150–200 °C)→ CH₃CONH₂(s) + H₂O(g)↑', 'Nhiệt phân tách nước Ammonium acetate tạo Acetamide CH₃CONH₂', 'Ammonium acetate dehydration (150–200 °C) → Acetamide + H₂O↑', 'Đun nóng muối CH₃COONH₄ ở 150–200 °C tách nước tạo Acetamide (CH₃CONH₂).', 'Heating solid Ammonium acetate (150–200 °C) dehydrates to crystalline Acetamide.', dAmide);
    }
  }

  // 3c. Soda-lime decarboxylation: CH3COONa(s) + NaOH(s) —(CaO, 300–400 °C)→ CH4(g)↑ + Na2CO3(s)
  if ((moles.CH3COONa_s || 0) > 1e-9 && (moles.NaOH_s || 0) > 1e-9 && T >= 573.15 && (moles.H2O_l || 0) < 0.01) {
    const hasCaOCat = (moles.CaO_s || 0) > 1e-9;
    if (hasCaOCat || T >= 623.15) {
      const kDec = hasCaOCat ? 1.15 : 0.45;
      const dCH4 = Math.min(moles.CH3COONa_s, moles.NaOH_s) * (1 - Math.exp(-kDec * dt));
      if (dCH4 > 1e-11) {
        consumeSpecies('CH3COONa_s', dCH4);
        consumeSpecies('NaOH_s', dCH4);
        moles.Na2CO3_s = (moles.Na2CO3_s || 0) + dCH4;
        gasProduced.CH4_g = (gasProduced.CH4_g || 0) + dCH4;
        heatJ -= dCH4 * 18000;
        pushRxn('sodalime_ch4', 'CH₃COONa + NaOH —(CaO, 300–400 °C)→ CH₄(g)↑ + Na₂CO₃', 'Phản ứng vôi tôi xút (Soda-lime) điều chế khí Methane CH₄↑', 'Soda-lime decarboxylation: CH₃COONa + NaOH (CaO, 350 °C) → CH₄↑ + Na₂CO₃', 'Nung khan CH₃COONa với NaOH và vôi sống CaO ở 300–400 °C giải phóng khí Methane tinh khiết.', 'Heating dry Sodium acetate with NaOH/CaO soda-lime (300–400 °C) liberates Methane CH₄↑.', dCH4, true);
      }
    }
  }

  // 3d. Dry distillation of Calcium acetate: (CH3COO)2Ca(s) —(400–500 °C)→ CH3COCH3(Acetone) + CaCO3(s)
  if ((moles.CaCH3COO_2_s || 0) > 1e-9 && T >= 653.15 && (moles.H2O_l || 0) < 0.01) {
    const dAcet = moles.CaCH3COO_2_s * (1 - Math.exp(-0.82 * dt));
    if (dAcet > 1e-11) {
      consumeSpecies('CaCH3COO_2_s', dAcet);
      moles.CaCO3_s = (moles.CaCO3_s || 0) + dAcet;
      if (T >= 329.20) {
        gasProduced.CH3COCH3_g = (gasProduced.CH3COCH3_g || 0) + dAcet;
      } else {
        moles.CH3COCH3_l = (moles.CH3COCH3_l || 0) + dAcet;
      }
      heatJ -= dAcet * 42000;
      pushRxn('ca_acetate_pyrolysis', '(CH₃COO)₂Ca(s) —(400–500 °C)→ CH₃COCH₃(Acetone)↑ + CaCO₃(s)', 'Chưng khô Calcium acetate điều chế Acetone CH₃COCH₃', 'Calcium acetate dry distillation (400–500 °C) → Acetone + CaCO₃', 'Nhiệt phân muối (CH₃COO)₂Ca khan ở 400–500 °C tạo hơi Acetone và cặn CaCO₃.', 'Pyrolyzing anhydrous Calcium acetate at 400–500 °C distills Acetone leaving CaCO₃.', dAcet, true);
    }
  }

  // 3e. Acetaldehyde mild oxidations (Cu(OH)2 warm -> Cu2O đỏ gạch; Ag+ / NH3 Tollens silver mirror!) & Acetone Iodoform
  if ((moles.CH3CHO_l || 0) > 1e-9 && (moles.CuOH2_s || 0) > 1e-9 && (moles.OH_aq || 0) > 1e-5 && T >= 333.15 && orgMob > 0) {
    const dCu2O = Math.min(moles.CH3CHO_l, moles.CuOH2_s / 2, moles.OH_aq) * (1 - Math.exp(-1.1 * dt));
    if (dCu2O > 1e-11) {
      consumeSpecies('CH3CHO_l', dCu2O);
      consumeSpecies('CuOH2_s', 2 * dCu2O);
      consumeSpecies('OH_aq', dCu2O);
      moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dCu2O;
      moles.Cu2O_s = (moles.Cu2O_s || 0) + dCu2O;
      moles.H2O_l = (moles.H2O_l || 0) + 3 * dCu2O;
      heatJ += dCu2O * 140000;
      pushRxn('ch3cho_fehling', 'CH₃CHO + 2Cu(OH)₂ + OH⁻ —(t°)→ CH₃COO⁻ + Cu₂O↓ (đỏ gạch) + 3H₂O', 'Acetaldehyde khử Cu(OH)₂/OH⁻ đun nóng tạo kết tủa đỏ gạch Cu₂O↓', 'Acetaldehyde reduces Cu(OH)₂/OH⁻ (heat) → brick-red Cu₂O↓', 'Phản ứng đặc trưng nhóm –CHO tạo kết tủa đỏ gạch Cu₂O.', 'Aldehyde –CHO reduces alkaline Cu(OH)₂ on heating forming brick-red Cu₂O↓.', dCu2O);
    }
  }
  if ((moles.CH3CHO_l || 0) > 1e-9 && (moles.AgNH3_2_aq || 0) > 1e-7 && T >= 313.15 && orgMob > 0) {
    const dSilv = Math.min(moles.CH3CHO_l, moles.AgNH3_2_aq / 2) * (1 - Math.exp(-0.95 * dt));
    if (dSilv > 1e-11) {
      consumeSpecies('CH3CHO_l', dSilv);
      consumeSpecies('AgNH3_2_aq', 2 * dSilv);
      moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dSilv;
      moles.NH4_aq = (moles.NH4_aq || 0) + dSilv;
      moles.NH3_aq = (moles.NH3_aq || 0) + 3 * dSilv;
      moles.Ag_s = (moles.Ag_s || 0) + 2 * dSilv;
      vessel.silverMirrorFrac = Math.min(1, (vessel.silverMirrorFrac || 0) + 0.65);
      vessel.silverMirrorLevel = Math.min(1, (vessel.silverMirrorLevel || 0) + 0.65);
      heatJ += dSilv * 185000;
      pushRxn('ch3cho_tollens', 'CH₃CHO + 2[Ag(NH₃)₂]⁺ + OH⁻ —(t°)→ CH₃COO⁻ + 2Ag↓ (tráng gương) + 3NH₃ + H₂O', 'Phản ứng tráng bạc Tollens: Acetaldehyde tạo lớp gương Ag↓', 'Tollens silver mirror test: CH₃CHO + [Ag(NH₃)₂]⁺ → 2Ag↓', 'Acetaldehyde khử phức bạc amoniac tạo lớp bạc sáng bóng bám thành bình.', 'Acetaldehyde reduces Tollens reagent depositing a bright metallic silver mirror.', dSilv);
    }
  }
  const availI2Ac = (moles.I2_s || 0) + (moles.I2_aq || 0) + (moles.I3_aq || 0);
  if ((moles.CH3COCH3_l || 0) > 1e-9 && availI2Ac > 1e-7 && (moles.OH_aq || 0) > 1e-6 && orgMob > 0) {
    const dIodoAc = Math.min(moles.CH3COCH3_l, availI2Ac / 3, moles.OH_aq / 4) * (1 - Math.exp(-1.4 * dt));
    if (dIodoAc > 1e-11) {
      consumeSpecies('CH3COCH3_l', dIodoAc);
      let needIAc = 3 * dIodoAc;
      for (const ik of ['I2_s', 'I2_aq', 'I3_aq']) {
        const tk = Math.min(moles[ik] || 0, needIAc);
        if (tk > 0) {
          consumeSpecies(ik, tk);
          if (ik === 'I3_aq') moles.I_aq = (moles.I_aq || 0) + tk;
          needIAc -= tk;
        }
      }
      consumeSpecies('OH_aq', 4 * dIodoAc);
      moles.CHI3_s = (moles.CHI3_s || 0) + dIodoAc;
      moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dIodoAc;
      moles.I_aq = (moles.I_aq || 0) + 3 * dIodoAc;
      moles.H2O_l = (moles.H2O_l || 0) + 3 * dIodoAc;
      heatJ += dIodoAc * 125000;
      pushRxn('acetone_iodoform', 'CH₃COCH₃ + 3I₂ + 4OH⁻ → CHI₃↓ (vàng tươi) + CH₃COO⁻ + 3I⁻ + 3H₂O', 'Phản ứng Iodoform của Acetone tạo kết tủa vàng CHI₃↓', 'Acetone Iodoform test → bright yellow CHI₃↓', 'Nhóm methyl ketone CH₃CO– trong Acetone tạo ngay kết tủa vàng CHI₃↓ với I₂/NaOH.', 'Acetone rapidly yields bright yellow CHI₃ precipitate with I₂/NaOH.', dIodoAc);
    }
  }

  // ==================== PART 5: BENZENE, HALOGEN DERIVATIVES, & ALCOHOL/PHENOL PREPARATIONS ====================
  const uvOn = Boolean(options?.uvLight || vessel.uvExposureActive);

  // 5A. Benzene (C6H6_l) Reactions
  if ((moles.C6H6_l || 0) > 1e-10 && orgMob > 0) {
    const hasFeCat = (moles.Fe_s || 0) > 1e-8 || (moles.FeCl3_s || 0) > 1e-8 || (moles.FeBr3_s || 0) > 1e-8 || (moles.Fe3_aq || 0) > 1e-8 || (moles.Fe2_aq || 0) > 1e-8;
    const hsGas = vessel.headspaceGasMoles || {};
    const brSource = (moles.Br2_l || 0) > 1e-9 ? 'Br2_l' : (moles.Br2_g || 0) > 1e-9 ? 'Br2_g' : (hsGas.Br2_g || 0) > 1e-9 ? 'hs:Br2_g' : null;
    const clSource = (moles.Cl2_g || 0) > 1e-9 ? 'Cl2_g' : (hsGas.Cl2_g || 0) > 1e-9 ? 'hs:Cl2_g' : null;
    const getSrcAmt = (src) => (!src ? 0 : src.startsWith('hs:') ? (hsGas[src.slice(3)] || 0) : (moles[src] || 0));
    const consumeSrc = (src, amt) => {
      if (!src) return;
      if (src.startsWith('hs:')) {
        const k = src.slice(3);
        hsGas[k] = Math.max(0, (hsGas[k] || 0) - amt);
        if (hsGas[k] < 1e-13) delete hsGas[k];
      } else {
        consumeSpecies(src, amt);
      }
    };

    // 5A-1. Electrophilic Bromination / Chlorination (Fe / FeX3 catalyst, 40–60 °C, NO UV)
    if (hasFeCat && !uvOn && T >= 313.15) {
      if (brSource) {
        const dBzBr = Math.min(moles.C6H6_l, getSrcAmt(brSource)) * (1 - Math.exp(-0.85 * dt));
        if (dBzBr > 1e-11) {
          consumeSpecies('C6H6_l', dBzBr);
          consumeSrc(brSource, dBzBr);
          moles.C6H5Br_l = (moles.C6H5Br_l || 0) + dBzBr;
          if ((moles.H2O_l || 0) > 1e-4) {
            moles.H_aq = (moles.H_aq || 0) + dBzBr;
            moles.Br_aq = (moles.Br_aq || 0) + dBzBr;
          } else {
            gasProduced.HBr_g = (gasProduced.HBr_g || 0) + dBzBr;
          }
          heatJ += dBzBr * 45000;
          pushRxn('benzene_br2_fe', 'C₆H₆ + Br₂ —(Fe, 40–60 °C)→ C₆H₅Br + HBr↑', 'Brom hóa Benzene (xúc tác Fe, 40–60 °C) → Bromobenzene + HBr↑', 'Benzene bromination (Fe, 40–60 °C) → Bromobenzene + HBr↑', 'Xúc tác Fe/FeBr₃ phân cực Br₂ giúp thế H trên vòng Benzene tạo Bromobenzene và khí HBr.', 'Fe catalyst polarizes Br₂ for electrophilic substitution on Benzene yielding Bromobenzene and HBr.', dBzBr, true);
        }
      }
      if (clSource) {
        const dBzCl = Math.min(moles.C6H6_l, getSrcAmt(clSource)) * (1 - Math.exp(-0.92 * dt));
        if (dBzCl > 1e-11) {
          consumeSpecies('C6H6_l', dBzCl);
          consumeSrc(clSource, dBzCl);
          moles.C6H5Cl_l = (moles.C6H5Cl_l || 0) + dBzCl;
          if ((moles.H2O_l || 0) > 1e-4) {
            moles.H_aq = (moles.H_aq || 0) + dBzCl;
            moles.Cl_aq = (moles.Cl_aq || 0) + dBzCl;
          } else {
            gasProduced.HCl_g = (gasProduced.HCl_g || 0) + dBzCl;
          }
          heatJ += dBzCl * 115000;
          pushRxn('benzene_cl2_fe', 'C₆H₆ + Cl₂ —(Fe/FeCl₃, 40–60 °C)→ C₆H₅Cl + HCl↑', 'Clo hóa Benzene (xúc tác Fe/FeCl₃, 40–60 °C) → Chlorobenzene + HCl↑', 'Benzene chlorination (Fe/FeCl₃, 40–60 °C) → Chlorobenzene + HCl↑', 'Xúc tác FeCl₃ thế H trên vòng Benzene tạo Chlorobenzene và khí HCl.', 'FeCl₃-catalyzed chlorination of Benzene yields Chlorobenzene and HCl gas.', dBzCl, true);
        }
      }
    }

    // 5A-2. Radical UV Addition: C6H6 + 3Cl2 -> C6H6Cl6(s), C6H6 + 3Br2 -> C6H6Br6(s)
    if (uvOn && !hasFeCat) {
      if (clSource && moles[clSource] > 1e-9) {
        const dAddCl = Math.min(moles.C6H6_l, moles[clSource] / 3) * (1 - Math.exp(-0.65 * dt));
        if (dAddCl > 1e-11) {
          consumeSpecies('C6H6_l', dAddCl);
          consumeSpecies(clSource, 3 * dAddCl);
          moles.C6H6Cl6_s = (moles.C6H6Cl6_s || 0) + dAddCl;
          heatJ += dAddCl * 290000;
          pushRxn('benzene_cl2_uv', 'C₆H₆ + 3Cl₂ —(UV)→ C₆H₆Cl₆(s)', 'Cộng gốc tự do Cl₂ vào Benzene dưới tia UV → Hexachlorocyclohexane', 'Benzene + 3Cl₂ (UV) → Hexachlorocyclohexane C₆H₆Cl₆(s)', 'Dưới ánh sáng UV, Benzene cộng hợp với 3Cl₂ phá vỡ hệ thơm tạo tinh thể trắng C₆H₆Cl₆.', 'Under UV irradiation, Benzene undergoes radical addition with 3Cl₂ to form white C₆H₆Cl₆ crystals.', dAddCl);
        }
      }
      if (brSource && moles[brSource] > 1e-9) {
        const dAddBr = Math.min(moles.C6H6_l, moles[brSource] / 3) * (1 - Math.exp(-0.45 * dt));
        if (dAddBr > 1e-11) {
          consumeSpecies('C6H6_l', dAddBr);
          consumeSpecies(brSource, 3 * dAddBr);
          moles.C6H6Br6_s = (moles.C6H6Br6_s || 0) + dAddBr;
          heatJ += dAddBr * 220000;
          pushRxn('benzene_br2_uv', 'C₆H₆ + 3Br₂ —(UV)→ C₆H₆Br₆(s)', 'Cộng gốc tự do Br₂ vào Benzene dưới tia UV → Hexabromocyclohexane', 'Benzene + 3Br₂ (UV) → Hexabromocyclohexane C₆H₆Br₆(s)', 'Dưới tia UV không có xúc tác Fe, Benzene cộng 3Br₂ tạo tinh thể C₆H₆Br₆.', 'Under UV without Fe, Benzene adds 3Br₂ to form C₆H₆Br₆ crystals.', dAddBr);
        }
      }
    }

    // 5A-3. Nitration: C6H6 + HNO3 -(H2SO4 conc, 50–60 °C)-> C6H5NO2(l) + H2O
    const hasConcH2SO4 = (moles.H2SO4_l || 0) > 1e-6 || ((moles.HSO4_aq || 0) > 1e-4 && (moles.H_aq || 0) > 1e-4);
    const hasNitric = (moles.HNO3_l || 0) > 1e-8 || ((moles.NO3_aq || 0) > 1e-6 && (moles.H_aq || 0) > 1e-5);
    if (hasConcH2SO4 && hasNitric && T >= 323.15) {
      const nNit = (moles.HNO3_l || 0) > 1e-8 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
      const dNit = Math.min(moles.C6H6_l, nNit) * (1 - Math.exp(-0.78 * dt));
      if (dNit > 1e-11) {
        consumeSpecies('C6H6_l', dNit);
        if ((moles.HNO3_l || 0) >= dNit) consumeSpecies('HNO3_l', dNit);
        else { consumeSpecies('NO3_aq', dNit); consumeSpecies('H_aq', dNit); }
        moles.C6H5NO2_l = (moles.C6H5NO2_l || 0) + dNit;
        moles.H2O_l = (moles.H2O_l || 0) + dNit;
        heatJ += dNit * 117000;
        pushRxn('benzene_nitration', 'C₆H₆ + HNO₃ —(H₂SO₄ đặc, 50–60 °C)→ C₆H₅NO₂(l) + H₂O', 'Nitro hóa Benzene tạo Nitrobenzene (lỏng vàng nhạt, d = 1.20)', 'Benzene nitration (conc. H₂SO₄, 50–60 °C) → Nitrobenzene', 'Hỗn hợp HNO₃/H₂SO₄ đặc tạo tác nhân NO₂⁺ thế vào vòng Benzene sinh Nitrobenzene sánh vàng nhạt.', 'Mixed HNO₃/H₂SO₄ generates NO₂⁺ to nitrate Benzene into pale-yellow dense Nitrobenzene.', dNit);
      }
    }

    // 5A-4. Sulfonation: C6H6 + H2SO4(conc) -(80–100 °C)-> C6H5SO3H(aq) + H2O
    if ((moles.H2SO4_l || 0) > 1e-6 && !hasNitric && T >= 353.15) {
      const dSulf = Math.min(moles.C6H6_l, moles.H2SO4_l) * (1 - Math.exp(-0.55 * dt));
      if (dSulf > 1e-11) {
        consumeSpecies('C6H6_l', dSulf);
        consumeSpecies('H2SO4_l', dSulf);
        moles.C6H5SO3H_aq = (moles.C6H5SO3H_aq || 0) + dSulf;
        moles.H2O_l = (moles.H2O_l || 0) + dSulf;
        heatJ += dSulf * 62000;
        pushRxn('benzene_sulfonation', 'C₆H₆ + H₂SO₄(đặc) —(80–100 °C)→ C₆H₅SO₃H + H₂O', 'Sulfon hóa Benzene tạo Benzenesulfonic acid tan thành 1 pha đồng nhất', 'Benzene sulfonation (80–100 °C) → Benzenesulfonic acid', 'Đun Benzene với H₂SO₄ đặc 80–100 °C thu được Benzenesulfonic acid tan hoàn toàn trong pha nước.', 'Sulfonation of Benzene at 80–100 °C yields water-soluble Benzenesulfonic acid.', dSulf);
      }
    }

    // 5A-5. Friedel–Crafts Acylation & Alkylation (anhydrous AlCl3_s, T >= 298.15 K)
    if ((moles.AlCl3_s || 0) > 1e-8 && (moles.H2O_l || 0) < 0.02 && T >= 298.15) {
      if ((moles.CH3COCl_l || 0) > 1e-9) {
        const dFCac = Math.min(moles.C6H6_l, moles.CH3COCl_l) * (1 - Math.exp(-0.95 * dt));
        if (dFCac > 1e-11) {
          consumeSpecies('C6H6_l', dFCac);
          consumeSpecies('CH3COCl_l', dFCac);
          moles.C6H5COCH3_l = (moles.C6H5COCH3_l || 0) + dFCac;
          gasProduced.HCl_g = (gasProduced.HCl_g || 0) + dFCac;
          heatJ += dFCac * 88000;
          pushRxn('benzene_fc_acylation', 'C₆H₆ + CH₃COCl —(AlCl₃ khan)→ C₆H₅COCH₃ + HCl↑', 'Acyl hóa Friedel–Crafts tạo Acetophenone', 'Friedel–Crafts acylation → Acetophenone + HCl↑', 'Xúc tác AlCl₃ khan thực hiện phản ứng thế acyl vào Benzene tạo Acetophenone và khí HCl.', 'Anhydrous AlCl₃ catalyzes Friedel–Crafts acylation of Benzene to Acetophenone and HCl gas.', dFCac, true);
        }
      }
      if ((moles.C2H4_g || 0) > 1e-9) {
        const dFCet = Math.min(moles.C6H6_l, moles.C2H4_g) * (1 - Math.exp(-0.72 * dt));
        if (dFCet > 1e-11) {
          consumeSpecies('C6H6_l', dFCet);
          consumeSpecies('C2H4_g', dFCet);
          moles.C6H5C2H5_l = (moles.C6H5C2H5_l || 0) + dFCet;
          heatJ += dFCet * 105000;
          pushRxn('benzene_fc_ethylene', 'C₆H₆ + C₂H₄ —(AlCl₃)→ C₆H₅C₂H₅', 'Alkyl hóa Benzene với Ethylene → Ethylbenzene', 'Friedel–Crafts alkylation: Benzene + C₂H₄ → Ethylbenzene', 'AlCl₃ xúc tác cộng Ethylene vào vòng Benzene tạo Ethylbenzene.', 'AlCl₃-catalyzed alkylation of Benzene with Ethylene forms Ethylbenzene.', dFCet);
        }
      }
      const fcHalId = (moles.C2H5Cl_l || 0) > 1e-9 ? 'C2H5Cl_l' : (moles.C2H5Cl_g || 0) > 1e-9 ? 'C2H5Cl_g' : (moles.C2H5Br_l || 0) > 1e-9 ? 'C2H5Br_l' : null;
      if (fcHalId) {
        const dFChal = Math.min(moles.C6H6_l, moles[fcHalId]) * (1 - Math.exp(-0.82 * dt));
        if (dFChal > 1e-11) {
          consumeSpecies('C6H6_l', dFChal);
          consumeSpecies(fcHalId, dFChal);
          moles.C6H5C2H5_l = (moles.C6H5C2H5_l || 0) + dFChal;
          const hxGas = fcHalId === 'C2H5Br_l' ? 'HBr_g' : 'HCl_g';
          gasProduced[hxGas] = (gasProduced[hxGas] || 0) + dFChal;
          heatJ += dFChal * 78000;
          pushRxn('benzene_fc_alkyl', `C₆H₆ + ${fcHalId === 'C2H5Br_l' ? 'C₂H₅Br' : 'C₂H₅Cl'} —(AlCl₃)→ C₆H₅C₂H₅ + ${fcHalId === 'C2H5Br_l' ? 'HBr' : 'HCl'}↑`, 'Alkyl hóa Friedel–Crafts tạo Ethylbenzene', 'Friedel–Crafts alkylation → Ethylbenzene', 'Xúc tác AlCl₃ khan thế nhóm ethyl vào vòng Benzene giải phóng khí HX.', 'Anhydrous AlCl₃ catalyzes Friedel–Crafts alkylation to Ethylbenzene and HX gas.', dFChal, true);
        }
      }
    }

    // 5A-6. Hydrogenation: C6H6 + 3H2 -(Ni/Pt, 180 °C)-> C6H12(l)
    const hasHydCat = (moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8;
    if (hasHydCat && (moles.H2_g || 0) > 1e-9 && T >= 423.15) {
      const dHyd = Math.min(moles.C6H6_l, moles.H2_g / 3) * (1 - Math.exp(-0.65 * dt));
      if (dHyd > 1e-11) {
        consumeSpecies('C6H6_l', dHyd);
        consumeSpecies('H2_g', 3 * dHyd);
        moles.C6H12_l = (moles.C6H12_l || 0) + dHyd;
        heatJ += dHyd * 206000;
        pushRxn('benzene_hydrogenation', 'C₆H₆ + 3H₂ —(Ni/Pt, 180 °C)→ C₆H₁₂', 'Hydro hóa Benzene → Cyclohexane', 'Benzene hydrogenation (Ni/Pt, 180 °C) → Cyclohexane', 'Benzene cộng 3H₂ trên xúc tác Ni/Pt ở 180 °C tạo Cyclohexane.', 'Catalytic hydrogenation of Benzene over Ni/Pt at 180 °C yields Cyclohexane.', dHyd);
      }
    }

    // 5A-7. Fenton Hydroxylation (H2O2 + Fe2+, 50–70 °C) -> Phenol + H2O
    if ((moles.H2O2_aq || 0) > 1e-7 && (moles.Fe2_aq || 0) > 1e-8 && T >= 323.15 && T <= 363.15) {
      const dFen = Math.min(moles.C6H6_l, moles.H2O2_aq) * (1 - Math.exp(-0.48 * dt));
      if (dFen > 1e-11) {
        consumeSpecies('C6H6_l', dFen);
        consumeSpecies('H2O2_aq', dFen);
        moles.C6H5OH_l = (moles.C6H5OH_l || 0) + dFen;
        moles.H2O_l = (moles.H2O_l || 0) + dFen;
        heatJ += dFen * 195000;
        pushRxn('benzene_fenton', 'C₆H₆ + H₂O₂ —(Fe²⁺, 50–70 °C)→ C₆H₅OH + H₂O', 'Oxi hóa Fenton Benzene bằng H₂O₂/Fe²⁺ → Phenol', 'Fenton oxidation: Benzene + H₂O₂ (Fe²⁺) → Phenol', 'Gốc tự do •OH từ hệ Fenton (Fe²⁺ + H₂O₂) hydroxyl hóa trực tiếp Benzene thành Phenol.', 'Fenton reagent (H₂O₂/Fe²⁺) hydroxylates Benzene directly to Phenol.', dFen);
      }
    }

    // 5A-8. V2O5 Partial Oxidation (450 °C) & Pyrolysis to Biphenyl (650–800 °C) & Combustion
    if ((moles.V2O5_s || 0) > 1e-8 && (moles.O2_g || 0) > 1e-9 && T >= 700.0) {
      const dV2O5 = Math.min(moles.C6H6_l / 2, moles.O2_g / 9) * (1 - Math.exp(-0.55 * dt));
      if (dV2O5 > 1e-11) {
        consumeSpecies('C6H6_l', 2 * dV2O5);
        consumeSpecies('O2_g', 9 * dV2O5);
        moles.C4H2O3_s = (moles.C4H2O3_s || 0) + 2 * dV2O5;
        gasProduced.CO2_g = (gasProduced.CO2_g || 0) + 4 * dV2O5;
        gasProduced.H2O_g = (gasProduced.H2O_g || 0) + 4 * dV2O5;
        heatJ += dV2O5 * 3650000;
        pushRxn('benzene_v2o5_ox', '2C₆H₆ + 9O₂ —(V₂O₅, 450 °C)→ 2C₄H₂O₃ + 4CO₂↑ + 4H₂O↑', 'Oxi hóa xúc tác Benzene (V₂O₅, 450 °C) → Maleic anhydride', 'Benzene oxidation (V₂O₅, 450 °C) → Maleic anhydride', 'Oxi hóa chọn lọc Benzene trên xúc tác V₂O₅ ở 450 °C tạo Maleic anhydride.', 'Selective V₂O₅-catalyzed oxidation of Benzene at 450 °C yields Maleic anhydride.', dV2O5, true);
      }
    }
    if (T >= 923.15 && (moles.O2_g || 0) < 1e-6) {
      const dPyr = (moles.C6H6_l / 2) * (1 - Math.exp(-0.35 * dt));
      if (dPyr > 1e-11) {
        consumeSpecies('C6H6_l', 2 * dPyr);
        moles.C12H10_s = (moles.C12H10_s || 0) + dPyr;
        gasProduced.H2_g = (gasProduced.H2_g || 0) + dPyr;
        heatJ -= dPyr * 18000;
        pushRxn('benzene_pyrolysis', '2C₆H₆ —(650–800 °C)→ C₁₂H₁₀ + H₂↑', 'Nhiệt phân Benzene (650–800 °C) → Biphenyl + H₂↑', 'Benzene pyrolysis (650–800 °C) → Biphenyl + H₂↑', 'Nhiệt phân Benzene ở 650–800 °C ngưng tụ tạo Biphenyl và khí H₂.', 'High-temperature pyrolysis of Benzene yields Biphenyl and H₂ gas.', dPyr, true);
      }
    }
  }

  // 5A-9. Secondary nitration: C6H5NO2 + HNO3 -(H2SO4 conc, >= 90 °C)-> m-C6H4(NO2)2 + H2O
  if ((moles.C6H5NO2_l || 0) > 1e-9 && ((moles.H2SO4_l || 0) > 1e-6 || (moles.HSO4_aq || 0) > 1e-4) && ((moles.HNO3_l || 0) > 1e-8 || ((moles.NO3_aq || 0) > 1e-6 && (moles.H_aq || 0) > 1e-5)) && T >= 363.15) {
    const nNit2 = (moles.HNO3_l || 0) > 1e-8 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
    const dNit2 = Math.min(moles.C6H5NO2_l, nNit2) * (1 - Math.exp(-0.42 * dt));
    if (dNit2 > 1e-11) {
      consumeSpecies('C6H5NO2_l', dNit2);
      if ((moles.HNO3_l || 0) >= dNit2) consumeSpecies('HNO3_l', dNit2);
      else { consumeSpecies('NO3_aq', dNit2); consumeSpecies('H_aq', dNit2); }
      moles.C6H4_NO2_2_s = (moles.C6H4_NO2_2_s || 0) + dNit2;
      moles.H2O_l = (moles.H2O_l || 0) + dNit2;
      heatJ += dNit2 * 98000;
      pushRxn('nitrobenzene_dinitro', 'C₆H₅NO₂ + HNO₃ —(H₂SO₄ đặc, ≥ 90 °C)→ m-C₆H₄(NO₂)₂ + H₂O', 'Nitro hóa tiếp Nitrobenzene ở ≥ 90 °C → m-Dinitrobenzene', 'Nitrobenzene nitration (≥ 90 °C) → m-Dinitrobenzene', 'Nhóm –NO₂ định hướng thế meta tạo tinh thể vàng m-Dinitrobenzene khi đun ≥ 90 °C.', 'The meta-directing –NO₂ group yields m-Dinitrobenzene crystals at ≥ 90 °C.', dNit2);
    }
  }

  // 5B. Halogen Derivatives (C2H5Br, C2H5I, C2H5Cl, C6H5Br, C6H5Cl)
  if (orgMob > 0) {
    const alkylHalides = [
      { id: 'C2H5Br_l', gasId: 'C2H5Br_g', ion: 'Br_aq', label: 'C₂H₅Br', name: 'Bromoethane', kScale: 1.0 },
      { id: 'C2H5I_l', gasId: 'C2H5I_g', ion: 'I_aq', label: 'C₂H₅I', name: 'Iodoethane', kScale: 1.35 },
      { id: 'C2H5Cl_l', gasId: 'C2H5Cl_g', ion: 'Cl_aq', label: 'C₂H₅Cl', name: 'Chloroethane', kScale: 0.65 },
    ];
    const isAlcoholicKOH = (moles.C2H5OH_l || 0) > 0.01 && ((moles.H2O_l || 0) < 0.05 || (moles.C2H5OH_l || 0) > (moles.H2O_l || 0));
    const hsHal = vessel.headspaceGasMoles || {};

    for (const hx of alkylHalides) {
      const nLiqHx = moles[hx.id] || 0;
      const nGasHx = hsHal[hx.gasId] || 0;
      const nHx = nLiqHx + nGasHx;
      if (nHx <= 1e-10) continue;
      const consumeHx = (amt) => {
        const fromLiq = Math.min(moles[hx.id] || 0, amt);
        if (fromLiq > 0) consumeSpecies(hx.id, fromLiq);
        const rem = amt - fromLiq;
        if (rem > 1e-13 && hsHal[hx.gasId] > 0) {
          hsHal[hx.gasId] = Math.max(0, hsHal[hx.gasId] - rem);
          if (hsHal[hx.gasId] < 1e-13) delete hsHal[hx.gasId];
        }
      };

      // 5B-1. Zaitsev elimination in alcoholic KOH/NaOH (70–100 °C) vs Hydrolysis in aqueous NaOH/KOH (70–90 °C)
      if ((moles.OH_aq || 0) > 1e-6 && T >= 343.15) {
        if (isAlcoholicKOH) {
          const dElim = Math.min(nHx, moles.OH_aq) * (1 - Math.exp(-0.85 * hx.kScale * dt));
          if (dElim > 1e-11) {
            consumeHx(dElim);
            consumeSpecies('OH_aq', dElim);
            gasProduced.C2H4_g = (gasProduced.C2H4_g || 0) + dElim;
            moles[hx.ion] = (moles[hx.ion] || 0) + dElim;
            moles.H2O_l = (moles.H2O_l || 0) + dElim;
            heatJ += dElim * 36000;
            pushRxn(`rx_elim_${hx.id}`, `${hx.label} + OH⁻ —(C₂H₅OH, t°)→ C₂H₄↑ + ${hx.ion.replace('_aq', '⁻')} + H₂O`, `Tách HX ${hx.name} trong KOH/C₂H₅OH → Ethylene C₂H₄↑`, `Zaitsev elimination: ${hx.name} + OH⁻/EtOH → Ethylene C₂H₄↑`, 'Trong dung dịch kiềm/Ethanol đun nóng, dẫn xuất halogen tách HX tạo khí Ethylene.', 'In hot alcoholic alkali, ethyl halides undergo E2 elimination to Ethylene gas.', dElim, true);
          }
        } else if ((moles.H2O_l || 0) > 1e-4) {
          const dHydHx = Math.min(nHx, moles.OH_aq) * (1 - Math.exp(-0.72 * hx.kScale * dt));
          if (dHydHx > 1e-11) {
            consumeHx(dHydHx);
            consumeSpecies('OH_aq', dHydHx);
            moles.C2H5OH_l = (moles.C2H5OH_l || 0) + dHydHx;
            moles[hx.ion] = (moles[hx.ion] || 0) + dHydHx;
            heatJ += dHydHx * 42000;
            pushRxn(`rx_hyd_${hx.id}`, `${hx.label} + OH⁻ —(H₂O, 70–90 °C)→ C₂H₅OH + ${hx.ion.replace('_aq', '⁻')}`, `Thủy phân ${hx.name} trong NaOH/KOH loãng → Ethanol`, `Alkaline hydrolysis: ${hx.name} + OH⁻ → Ethanol`, 'Đun nóng dẫn xuất halogen với NaOH/KOH loãng thế –X bằng –OH tái tạo Ethanol.', 'Warm aqueous NaOH/KOH hydrolyzes ethyl halides back to Ethanol.', dHydHx);
          }
        }
      }

      // 5B-2. Williamson Ether Synthesis: C2H5O- + C2H5X -> (C2H5)2O + X-
      if ((moles.C2H5O_aq || 0) > 1e-7) {
        const dWill = Math.min(nHx, moles.C2H5O_aq) * (1 - Math.exp(-1.15 * hx.kScale * dt));
        if (dWill > 1e-11) {
          consumeSpecies(hx.id, dWill);
          consumeSpecies('C2H5O_aq', dWill);
          moles.C2H5OC2H5_l = (moles.C2H5OC2H5_l || 0) + dWill;
          moles[hx.ion] = (moles[hx.ion] || 0) + dWill;
          heatJ += dWill * 68000;
          pushRxn(`williamson_${hx.id}`, `C₂H₅O⁻ + ${hx.label} → (C₂H₅)₂O + ${hx.ion.replace('_aq', '⁻')}`, `Tổng hợp Williamson từ ${hx.name} → Diethyl ether`, `Williamson ether synthesis: C₂H₅O⁻ + ${hx.label} → Diethyl ether`, 'Ion ethoxide thế nucleophil vào dẫn xuất halogen tạo Diethyl ether.', 'Nucleophilic substitution by ethoxide yields Diethyl ether.', dWill);
        }
      }

      // 5B-3. Reaction with NH3 (T >= 323.15 K) -> C2H5NH2 + NH4+ + X-
      if ((moles.NH3_aq || 0) > 1e-6 && T >= 323.15) {
        const dAmn = Math.min(nHx, moles.NH3_aq / 2) * (1 - Math.exp(-0.55 * hx.kScale * dt));
        if (dAmn > 1e-11) {
          consumeSpecies(hx.id, dAmn);
          consumeSpecies('NH3_aq', 2 * dAmn);
          moles.C2H5NH2_aq = (moles.C2H5NH2_aq || 0) + dAmn;
          moles.NH4_aq = (moles.NH4_aq || 0) + dAmn;
          moles[hx.ion] = (moles[hx.ion] || 0) + dAmn;
          heatJ += dAmn * 54000;
          pushRxn(`rx_nh3_${hx.id}`, `${hx.label} + 2NH₃ —(t°)→ C₂H₅NH₂ + NH₄⁺ + ${hx.ion.replace('_aq', '⁻')}`, `${hx.name} phản ứng với NH₃ tạo Ethylamine`, `${hx.name} + 2NH₃ → Ethylamine + NH₄⁺`, 'NH₃ thế halogen tạo Ethylamine.', 'Ammonia substitutes halide to yield Ethylamine.', dAmn);
        }
      }

      // 5B-4. Carboxylate esterification: CH3COO- + C2H5X -> CH3COOC2H5 + X-
      if ((moles.CH3COO_aq || 0) > 1e-6 && T >= 333.15) {
        const dEst = Math.min(nHx, moles.CH3COO_aq) * (1 - Math.exp(-0.48 * hx.kScale * dt));
        if (dEst > 1e-11) {
          consumeSpecies(hx.id, dEst);
          consumeSpecies('CH3COO_aq', dEst);
          moles.CH3COOC2H5_l = (moles.CH3COOC2H5_l || 0) + dEst;
          moles[hx.ion] = (moles[hx.ion] || 0) + dEst;
          heatJ += dEst * 32000;
          pushRxn(`rx_ester_${hx.id}`, `CH₃COO⁻ + ${hx.label} —(t°)→ CH₃COOC₂H₅ + ${hx.ion.replace('_aq', '⁻')}`, `Tổng hợp Ethyl acetate từ ${hx.name} và muối Acetate`, `${hx.name} + CH₃COO⁻ → Ethyl acetate`, 'Ion acetate thế halogen tạo ester Ethyl acetate.', 'Acetate displaces halide yielding Ethyl acetate.', dEst);
        }
      }

      // 5B-5. Grignard (Mg in dry Et2O) & Wurtz (Na in dry Et2O) & Zn/H+ reduction
      if ((moles.C2H5OC2H5_l || 0) > 1e-4 && (moles.H2O_l || 0) < 0.005) {
        if ((moles.Mg_s || 0) > 1e-9 && hx.id === 'C2H5Br_l') {
          const dGrig = Math.min(nHx, moles.Mg_s) * (1 - Math.exp(-0.75 * dt));
          if (dGrig > 1e-11) {
            consumeSpecies('C2H5Br_l', dGrig);
            consumeSpecies('Mg_s', dGrig);
            moles.C2H5MgBr_l = (moles.C2H5MgBr_l || 0) + dGrig;
            heatJ += dGrig * 145000;
            pushRxn('grignard_etmgbr', 'C₂H₅Br + Mg —((C₂H₅)₂O khan)→ C₂H₅MgBr', 'Tổng hợp tác nhân Grignard C₂H₅MgBr trong Ether khan', 'Grignard reagent synthesis: C₂H₅Br + Mg → C₂H₅MgBr', 'Magnesium chèn vào liên kết C–Br trong Ether khan tạo Ethylmagnesium bromide.', 'Mg inserts into C–Br in anhydrous Diethyl ether to form Ethylmagnesium bromide.', dGrig);
          }
        }
        if ((moles.Na_s || 0) > 1e-9) {
          const dWurtz = Math.min(nHx / 2, moles.Na_s / 2) * (1 - Math.exp(-0.95 * hx.kScale * dt));
          if (dWurtz > 1e-11) {
            consumeSpecies(hx.id, 2 * dWurtz);
            consumeSpecies('Na_s', 2 * dWurtz);
            gasProduced.C4H10_g = (gasProduced.C4H10_g || 0) + dWurtz;
            moles.Na_aq = (moles.Na_aq || 0) + 2 * dWurtz;
            moles[hx.ion] = (moles[hx.ion] || 0) + 2 * dWurtz;
            heatJ += dWurtz * 320000;
            pushRxn(`wurtz_${hx.id}`, `2${hx.label} + 2Na —(Ether khan)→ C₄H₁₀↑ + 2Na⁺ + 2${hx.ion.replace('_aq', '⁻')}`, `Phản ứng Wurtz từ ${hx.name} + Na → Butane C₄H₁₀↑`, `Wurtz coupling: 2${hx.label} + 2Na → Butane C₄H₁₀↑`, 'Kim loại Na khử ghép 2 gốc ethyl trong Ether khan giải phóng khí Butane.', 'Sodium couples two ethyl halides in dry ether to evolve Butane gas.', dWurtz, true);
          }
        }
      }
      if ((moles.Zn_s || 0) > 1e-9 && ((moles.H_aq || 0) > 1e-5 || (moles.CH3COOH_l || 0) > 1e-5) && T >= 313.15) {
        const acidAvail = (moles.H_aq || 0) > 1e-5 ? moles.H_aq : moles.CH3COOH_l;
        const dRedHx = Math.min(nHx, moles.Zn_s, acidAvail) * (1 - Math.exp(-0.62 * hx.kScale * dt));
        if (dRedHx > 1e-11) {
          consumeSpecies(hx.id, dRedHx);
          consumeSpecies('Zn_s', dRedHx);
          if ((moles.H_aq || 0) >= dRedHx) consumeSpecies('H_aq', dRedHx);
          else { consumeSpecies('CH3COOH_l', dRedHx); moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dRedHx; }
          gasProduced.C2H6_g = (gasProduced.C2H6_g || 0) + dRedHx;
          moles.Zn2_aq = (moles.Zn2_aq || 0) + dRedHx;
          moles[hx.ion] = (moles[hx.ion] || 0) + dRedHx;
          heatJ += dRedHx * 110000;
          pushRxn(`rx_red_zn_${hx.id}`, `${hx.label} + Zn + H⁺ → C₂H₆↑ + Zn²⁺ + ${hx.ion.replace('_aq', '⁻')}`, `Khử ${hx.name} bằng Zn/acid → Ethane C₂H₆↑`, `Reduction: ${hx.name} + Zn/H⁺ → Ethane C₂H₆↑`, 'Zn khử dẫn xuất halogen trong môi trường acid giải phóng khí Ethane.', 'Zn in acid reduces ethyl halides to Ethane gas.', dRedHx, true);
        }
      }
    }

    // Grignard hydrolysis: C2H5MgBr + H2O -> C2H6↑ + Mg2+ + OH- + Br-
    if ((moles.C2H5MgBr_l || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-5) {
      const dGrigHyd = Math.min(moles.C2H5MgBr_l, moles.H2O_l) * (1 - Math.exp(-2.8 * dt));
      if (dGrigHyd > 1e-11) {
        consumeSpecies('C2H5MgBr_l', dGrigHyd);
        consumeSpecies('H2O_l', dGrigHyd);
        gasProduced.C2H6_g = (gasProduced.C2H6_g || 0) + dGrigHyd;
        moles.Mg2_aq = (moles.Mg2_aq || 0) + dGrigHyd;
        moles.OH_aq = (moles.OH_aq || 0) + dGrigHyd;
        moles.Br_aq = (moles.Br_aq || 0) + dGrigHyd;
        heatJ += dGrigHyd * 185000;
        pushRxn('grignard_hydrolysis', 'C₂H₅MgBr + H₂O → C₂H₆↑ + Mg²⁺ + OH⁻ + Br⁻', 'Thủy phân tác nhân Grignard C₂H₅MgBr → Ethane C₂H₆↑', 'Grignard hydrolysis → Ethane C₂H₆↑', 'Nước thủy phân mãnh liệt C₂H₅MgBr giải phóng khí Ethane.', 'Water vigorously hydrolyzes Ethylmagnesium bromide to Ethane gas.', dGrigHyd, true);
      }
    }

    // Aryl halide Dow hydrolysis ONLY at extreme T >= 573.15 K (300 °C)
    if ((moles.C6H5Cl_l || 0) > 1e-9 && (moles.OH_aq || 0) > 1e-6 && T >= 573.15) {
      const dDow = Math.min(moles.C6H5Cl_l, moles.OH_aq / 2) * (1 - Math.exp(-0.55 * dt));
      if (dDow > 1e-11) {
        consumeSpecies('C6H5Cl_l', dDow);
        consumeSpecies('OH_aq', 2 * dDow);
        moles.C6H5O_aq = (moles.C6H5O_aq || 0) + dDow;
        moles.Cl_aq = (moles.Cl_aq || 0) + dDow;
        moles.H2O_l = (moles.H2O_l || 0) + dDow;
        heatJ += dDow * 75000;
        pushRxn('dow_chlorobenzene', 'C₆H₅Cl + 2OH⁻ —(≥ 300 °C)→ C₆H₅O⁻ + Cl⁻ + H₂O', 'Thủy phân Chlorobenzene ở ≥ 300 °C → Phenoxide', 'Dow hydrolysis: Chlorobenzene + 2OH⁻ (≥ 300 °C) → Phenoxide', 'Aryl halide trơ ở ≤ 100 °C, chỉ thủy phân trong kiềm đặc ở ≥ 300 °C.', 'Aryl halides are inert ≤ 100 °C and only hydrolyze in alkali at ≥ 300 °C.', dDow);
      }
    }

    // 5C. Preparations of Halogen Derivatives & Alcohols / Phenol
    // 5C-1. 3C2H5OH + P_red + 1.5Br2 -> 3C2H5Br + H3PO3 (50-70 °C)
    const brPrep = (moles.Br2_l || 0) > 1e-9 ? 'Br2_l' : (moles.Br2_g || 0) > 1e-9 ? 'Br2_g' : null;
    if ((moles.C2H5OH_l || 0) > 1e-8 && (moles.P_red_s || 0) > 1e-8 && brPrep && T >= 323.15) {
      const dPrepBr = Math.min(moles.C2H5OH_l / 3, moles.P_red_s, moles[brPrep] / 1.5) * (1 - Math.exp(-0.75 * dt));
      if (dPrepBr > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dPrepBr);
        consumeSpecies('P_red_s', dPrepBr);
        consumeSpecies(brPrep, 1.5 * dPrepBr);
        moles.C2H5Br_l = (moles.C2H5Br_l || 0) + 3 * dPrepBr;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dPrepBr;
        heatJ += dPrepBr * 240000;
        pushRxn('prep_c2h5br_p_br2', '3C₂H₅OH + P(đỏ) + 1.5Br₂ —(50–70 °C)→ 3C₂H₅Br + H₃PO₃', 'Điều chế Bromoethane từ Ethanol + P(đỏ) + Br₂', 'Preparation of Bromoethane: EtOH + P(red) + Br₂', 'P đỏ và Br₂ tạo PBr₃ tại chỗ thế –OH Ethanol thành Bromoethane.', 'Red phosphorus + Br₂ converts Ethanol to Bromoethane in situ.', dPrepBr);
      }
    }
    // 5C-2. 3C2H5OH + P_red + 1.5I2 -> 3C2H5I + H3PO3 (70-80 °C)
    if ((moles.C2H5OH_l || 0) > 1e-8 && (moles.P_red_s || 0) > 1e-8 && (moles.I2_s || 0) > 1e-8 && T >= 343.15) {
      const dPrepI = Math.min(moles.C2H5OH_l / 3, moles.P_red_s, moles.I2_s / 1.5) * (1 - Math.exp(-0.68 * dt));
      if (dPrepI > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dPrepI);
        consumeSpecies('P_red_s', dPrepI);
        consumeSpecies('I2_s', 1.5 * dPrepI);
        moles.C2H5I_l = (moles.C2H5I_l || 0) + 3 * dPrepI;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dPrepI;
        heatJ += dPrepI * 185000;
        pushRxn('prep_c2h5i_p_i2', '3C₂H₅OH + P(đỏ) + 1.5I₂ —(70–80 °C)→ 3C₂H₅I + H₃PO₃', 'Điều chế Iodoethane từ Ethanol + P(đỏ) + I₂', 'Preparation of Iodoethane: EtOH + P(red) + I₂', 'P đỏ và I₂ thế nhóm –OH của Ethanol ở 70–80 °C tạo Iodoethane.', 'Red phosphorus + I₂ converts Ethanol to Iodoethane at 70–80 °C.', dPrepI);
      }
    }
    // 5C-3. C2H5OH + HCl(conc) -(ZnCl2/Zn2+, 70-85 °C)-> C2H5Cl + H2O
    if ((moles.C2H5OH_l || 0) > 1e-8 && (moles.H_aq || 0) > 1e-4 && (moles.Cl_aq || 0) > 1e-4 && ((moles.Zn2_aq || 0) > 1e-7 || (moles.ZnCl2_s || 0) > 1e-7) && T >= 343.15) {
      const dPrepCl = Math.min(moles.C2H5OH_l, moles.H_aq, moles.Cl_aq) * (1 - Math.exp(-0.62 * dt));
      if (dPrepCl > 1e-11) {
        consumeSpecies('C2H5OH_l', dPrepCl);
        consumeSpecies('H_aq', dPrepCl);
        consumeSpecies('Cl_aq', dPrepCl);
        gasProduced.C2H5Cl_g = (gasProduced.C2H5Cl_g || 0) + dPrepCl;
        moles.H2O_l = (moles.H2O_l || 0) + dPrepCl;
        heatJ += dPrepCl * 28000;
        pushRxn('prep_c2h5cl_zncl2', 'C₂H₅OH + HCl(đặc) —(ZnCl₂, 70–85 °C)→ C₂H₅Cl↑ + H₂O', 'Điều chế Chloroethane từ Ethanol + HCl đặc (xúc tác ZnCl₂)', 'Preparation of Chloroethane: EtOH + HCl (ZnCl₂)', 'ZnCl₂ khan xúc tác thế –OH bằng Cl⁻ giải phóng khí Chloroethane (ngưng tụ < 12.3 °C).', 'ZnCl₂ catalyzes HCl substitution on Ethanol to evolve Chloroethane.', dPrepCl, true);
      }
    }

    // 5C-4. Alkene/Alkyne + Br2: C2H4 + Br2 -> C2H4Br2; C2H2 + 2Br2 -> C2H2Br4
    const brAdd = (moles.Br2_l || 0) > 1e-9 ? 'Br2_l' : (moles.Br2_aq || 0) > 1e-9 ? 'Br2_aq' : (moles.Br2_g || 0) > 1e-9 ? 'Br2_g' : null;
    if ((moles.C2H4_g || 0) > 1e-9 && brAdd) {
      const dC2H4Br = Math.min(moles.C2H4_g, moles[brAdd]) * (1 - Math.exp(-2.2 * dt));
      if (dC2H4Br > 1e-11) {
        consumeSpecies('C2H4_g', dC2H4Br);
        consumeSpecies(brAdd, dC2H4Br);
        moles.C2H4Br2_l = (moles.C2H4Br2_l || 0) + dC2H4Br;
        heatJ += dC2H4Br * 122000;
        pushRxn('c2h4_br2_add', 'C₂H₄ + Br₂ → BrCH₂–CH₂Br(l)', 'Cộng Br₂ vào Ethylene → 1,2-Dibromoethane (d = 2.18)', 'Ethylene + Br₂ → 1,2-Dibromoethane', 'Ethylene làm mất màu dung dịch Bromine tạo 1,2-Dibromoethane nặng chìm xuống đáy.', 'Ethylene decolorizes Bromine forming dense 1,2-Dibromoethane.', dC2H4Br);
      }
    }
    if ((moles.C2H2_g || 0) > 1e-9 && brAdd) {
      const dC2H2Br = Math.min(moles.C2H2_g, moles[brAdd] / 2) * (1 - Math.exp(-1.9 * dt));
      if (dC2H2Br > 1e-11) {
        consumeSpecies('C2H2_g', dC2H2Br);
        consumeSpecies(brAdd, 2 * dC2H2Br);
        moles.C2H2Br4_l = (moles.C2H2Br4_l || 0) + dC2H2Br;
        heatJ += dC2H2Br * 235000;
        pushRxn('c2h2_br2_add', 'C₂H₂ + 2Br₂ → Br₂CH–CHBr₂(l)', 'Cộng 2Br₂ vào Acetylene → 1,1,2,2-Tetrabromoethane', 'Acetylene + 2Br₂ → 1,1,2,2-Tetrabromoethane', 'Acetylene cộng 2 phân tử Br₂ tạo 1,1,2,2-Tetrabromoethane (d = 2.97).', 'Acetylene adds 2 equivalents of Br₂ to form 1,1,2,2-Tetrabromoethane.', dC2H2Br);
      }
    }

    // 5C-5. Wagner oxidation: 3C2H4 + 2KMnO4 + 4H2O -(0–15 °C, cold dil)-> 3C2H4(OH)2 + 2MnO2↓ + 2KOH
    if ((moles.C2H4_g || 0) > 1e-9 && (moles.MnO4_aq || 0) > 1e-7 && (moles.H2O_l || 0) > 1e-4 && T <= 293.15) {
      const dWag = Math.min(moles.C2H4_g / 3, moles.MnO4_aq / 2, moles.H2O_l / 4) * (1 - Math.exp(-1.4 * dt));
      if (dWag > 1e-11) {
        consumeSpecies('C2H4_g', 3 * dWag);
        consumeSpecies('MnO4_aq', 2 * dWag);
        consumeSpecies('H2O_l', 4 * dWag);
        moles.C2H4OH_2_l = (moles.C2H4OH_2_l || 0) + 3 * dWag;
        moles.MnO2_s = (moles.MnO2_s || 0) + 2 * dWag;
        moles.OH_aq = (moles.OH_aq || 0) + 2 * dWag;
        heatJ += dWag * 410000;
        pushRxn('wagner_glycol', '3C₂H₄ + 2MnO₄⁻ + 4H₂O —(0–15 °C)→ 3C₂H₄(OH)₂ + 2MnO₂↓ + 2OH⁻', 'Phản ứng Wagner: Ethylene + KMnO₄ lạnh → Ethylene glycol + MnO₂↓', 'Wagner oxidation: 3C₂H₄ + 2KMnO₄ + 4H₂O → 3 Ethylene glycol + 2MnO₂↓', 'KMnO₄ loãng lạnh oxi hóa Ethylene thành Ethylene glycol và kết tủa nâu đen MnO₂.', 'Cold dilute KMnO₄ oxidizes Ethylene to Ethylene glycol and brown-black MnO₂ precipitate.', dWag);
      }
    }

    // 5C-6. Allyl alcohol: CH2=CHCHO + Zn + 2CH3COOH -(50–70 °C)-> CH2=CHCH2OH + Zn2+ + 2CH3COO-
    if ((moles.CH2CHCHO_l || 0) > 1e-9 && (moles.Zn_s || 0) > 1e-9 && (moles.CH3COOH_l || 0) > 1e-8 && T >= 323.15) {
      const dAllyl = Math.min(moles.CH2CHCHO_l, moles.Zn_s, moles.CH3COOH_l / 2) * (1 - Math.exp(-0.75 * dt));
      if (dAllyl > 1e-11) {
        consumeSpecies('CH2CHCHO_l', dAllyl);
        consumeSpecies('Zn_s', dAllyl);
        consumeSpecies('CH3COOH_l', 2 * dAllyl);
        moles.CH2CHCH2OH_l = (moles.CH2CHCH2OH_l || 0) + dAllyl;
        moles.Zn2_aq = (moles.Zn2_aq || 0) + dAllyl;
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dAllyl;
        heatJ += dAllyl * 115000;
        pushRxn('prep_allyl_alcohol', 'CH₂=CHCHO + Zn + 2CH₃COOH —(50–70 °C)→ CH₂=CHCH₂OH + Zn(CH₃COO)₂', 'Khử Acrolein bằng Zn/CH₃COOH → Allyl alcohol', 'Acrolein reduction (Zn/CH₃COOH) → Allyl alcohol', 'Hệ Zn + CH₃COOH khử chọn lọc nhóm –CHO của Acrolein thành Allyl alcohol.', 'Zn/CH₃COOH selectively reduces Acrolein to Allyl alcohol.', dAllyl);
      }
    }

    // 5C-7. Butan-1-ol via Aldol-Crotonaldehyde: 2CH3CHO -> CH3CH=CHCHO + H2O; CH3CH=CHCHO + 2Zn + 4H+ -> C4H9OH + 2Zn2+
    if ((moles.CH3CHO_l || 0) > 1e-8 && (moles.OH_aq || 0) > 1e-6 && T >= 343.15) {
      const dAldol = (moles.CH3CHO_l / 2) * (1 - Math.exp(-0.55 * dt));
      if (dAldol > 1e-11) {
        consumeSpecies('CH3CHO_l', 2 * dAldol);
        moles.CH3CHCHCHO_l = (moles.CH3CHCHCHO_l || 0) + dAldol;
        moles.H2O_l = (moles.H2O_l || 0) + dAldol;
        heatJ += dAldol * 42000;
        pushRxn('aldol_crotonaldehyde', '2CH₃CHO —(NaOH loãng, t°)→ CH₃CH=CHCHO + H₂O', 'Ngưng tụ Aldol Acetaldehyde → Crotonaldehyde', 'Aldol condensation: 2CH₃CHO → Crotonaldehyde + H₂O', 'Acetaldehyde ngưng tụ và tách nước trong kiềm tạo Crotonaldehyde.', 'Base-catalyzed aldol condensation of Acetaldehyde yields Crotonaldehyde.', dAldol);
      }
    }
    if ((moles.CH3CHCHCHO_l || 0) > 1e-9 && (moles.Zn_s || 0) > 1e-9 && (moles.H_aq || 0) > 1e-5 && T >= 333.15) {
      const dBut = Math.min(moles.CH3CHCHCHO_l, moles.Zn_s / 2, moles.H_aq / 4) * (1 - Math.exp(-0.68 * dt));
      if (dBut > 1e-11) {
        consumeSpecies('CH3CHCHCHO_l', dBut);
        consumeSpecies('Zn_s', 2 * dBut);
        consumeSpecies('H_aq', 4 * dBut);
        moles.C4H9OH_l = (moles.C4H9OH_l || 0) + dBut;
        moles.Zn2_aq = (moles.Zn2_aq || 0) + 2 * dBut;
        heatJ += dBut * 210000;
        pushRxn('prep_butanol', 'CH₃CH=CHCHO + 2Zn + 4H⁺ —(60–80 °C)→ C₄H₉OH + 2Zn²⁺', 'Khử Crotonaldehyde → Butan-1-ol', 'Reduction of Crotonaldehyde → Butan-1-ol', 'Khử hoàn toàn Crotonaldehyde bằng Zn/H⁺ thu được Butan-1-ol.', 'Complete reduction of Crotonaldehyde yields Butan-1-ol.', dBut);
      }
    }

    // 5C-8. Ethyl acetate alkaline saponification: CH3COOC2H5 + OH- -(>= 60 °C)-> CH3COO- + C2H5OH
    if ((moles.CH3COOC2H5_l || 0) > 1e-9 && (moles.OH_aq || 0) > 1e-6 && T >= 333.15) {
      const dSap = Math.min(moles.CH3COOC2H5_l, moles.OH_aq) * (1 - Math.exp(-0.82 * dt));
      if (dSap > 1e-11) {
        consumeSpecies('CH3COOC2H5_l', dSap);
        consumeSpecies('OH_aq', dSap);
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dSap;
        moles.C2H5OH_l = (moles.C2H5OH_l || 0) + dSap;
        heatJ += dSap * 48000;
        pushRxn('etoac_saponification', 'CH₃COOC₂H₅ + OH⁻ —(75 °C)→ CH₃COO⁻ + C₂H₅OH', 'Xà phòng hóa Ethyl acetate tái tạo Ethanol', 'Alkaline saponification of Ethyl acetate → CH₃COO⁻ + Ethanol', 'Đun Ethyl acetate với NaOH thủy phân hoàn toàn tái tạo Ethanol.', 'Hot NaOH saponifies Ethyl acetate to Acetate and Ethanol.', dSap);
      }
    }

    // 5D. Phenol (C6H5OH_l / C6H5OH_s) Reactions
    const phSrc = (moles.C6H5OH_l || 0) > 1e-9 ? 'C6H5OH_l' : (moles.C6H5OH_s || 0) > 1e-9 ? 'C6H5OH_s' : null;
    if (phSrc) {
      if ((moles.OH_aq || 0) > 1e-6) {
        const dPhOH = Math.min(moles[phSrc], moles.OH_aq) * (1 - Math.exp(-2.8 * dt));
        if (dPhOH > 1e-11) {
          consumeSpecies(phSrc, dPhOH);
          consumeSpecies('OH_aq', dPhOH);
          moles.C6H5O_aq = (moles.C6H5O_aq || 0) + dPhOH;
          moles.H2O_l = (moles.H2O_l || 0) + dPhOH;
          heatJ += dPhOH * 32000;
          pushRxn('phenol_naoh', 'C₆H₅OH + OH⁻ → C₆H₅O⁻ + H₂O', 'Phenol tan trong dung dịch kiềm tạo Phenoxide', 'Phenol + OH⁻ → Phenoxide + H₂O', 'Tính acid yếu của Phenol giúp tan hoàn toàn trong NaOH tạo muối Phenoxide.', 'Weakly acidic Phenol dissolves in NaOH forming soluble Phenoxide.', dPhOH);
        }
      }
      if ((moles.Na_s || 0) > 1e-9) {
        const dPhNa = Math.min(moles[phSrc], moles.Na_s) * (1 - Math.exp(-2.2 * dt));
        if (dPhNa > 1e-11) {
          consumeSpecies(phSrc, dPhNa);
          consumeSpecies('Na_s', dPhNa);
          moles.C6H5O_aq = (moles.C6H5O_aq || 0) + dPhNa;
          moles.Na_aq = (moles.Na_aq || 0) + dPhNa;
          gasProduced.H2_g = (gasProduced.H2_g || 0) + 0.5 * dPhNa;
          heatJ += dPhNa * 155000;
          pushRxn('phenol_na', 'C₆H₅OH + Na → C₆H₅ONa + ½H₂↑', 'Phenol tác dụng với Na giải phóng H₂↑', 'Phenol + Na → Sodium phenoxide + ½H₂↑', 'Kim loại Na khử H linh động của Phenol giải phóng khí H₂.', 'Sodium reacts with Phenol evolving H₂ gas.', dPhNa, true);
        }
      }
      const brPh = (moles.Br2_aq || 0) > 1e-8 ? 'Br2_aq' : ((moles.Br2_l || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-4) ? 'Br2_l' : null;
      if (brPh) {
        const dPhBr = Math.min(moles[phSrc], moles[brPh] / 3) * (1 - Math.exp(-3.4 * dt));
        if (dPhBr > 1e-11) {
          consumeSpecies(phSrc, dPhBr);
          consumeSpecies(brPh, 3 * dPhBr);
          moles.C6H2Br3OH_s = (moles.C6H2Br3OH_s || 0) + dPhBr;
          moles.H_aq = (moles.H_aq || 0) + 3 * dPhBr;
          moles.Br_aq = (moles.Br_aq || 0) + 3 * dPhBr;
          heatJ += dPhBr * 165000;
          pushRxn('phenol_br2_white_ppt', 'C₆H₅OH + 3Br₂(aq) → C₆H₂Br₃OH↓ (trắng) + 3HBr', 'Phenol + nước Bromine → kết tủa trắng 2,4,6-Tribromophenol', 'Phenol + 3Br₂(aq) → white 2,4,6-Tribromophenol↓ + 3HBr', 'Phản ứng đặc trưng nhận biết Phenol tạo ngay kết tủa trắng 2,4,6-Tribromophenol.', 'Characteristic Phenol test immediately yields white 2,4,6-Tribromophenol precipitate.', dPhBr);
        }
      }

      // 5D-2. Picric acid (2,4,6-Trinitrophenol): C6H5OH + 3HNO3(conc) -(H2SO4 conc, >= 353.15 K)-> C6H2(NO2)3OH↓ + 3H2O
      const hasPicAcid = (moles.H2SO4_l || 0) > 1e-6 || (moles.HSO4_aq || 0) > 1e-4;
      const hasPicNit = (moles.HNO3_l || 0) > 1e-7 || ((moles.NO3_aq || 0) > 1e-5 && (moles.H_aq || 0) > 1e-5);
      if (hasPicAcid && hasPicNit && T >= 353.15) {
        const nNitP = (moles.HNO3_l || 0) > 1e-7 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
        const dPic = Math.min(moles[phSrc], nNitP / 3) * (1 - Math.exp(-0.72 * dt));
        if (dPic > 1e-11) {
          consumeSpecies(phSrc, dPic);
          if ((moles.HNO3_l || 0) >= 3 * dPic) consumeSpecies('HNO3_l', 3 * dPic);
          else { consumeSpecies('NO3_aq', 3 * dPic); consumeSpecies('H_aq', 3 * dPic); }
          moles.C6H2_NO2_3OH_s = (moles.C6H2_NO2_3OH_s || 0) + dPic;
          moles.H2O_l = (moles.H2O_l || 0) + 3 * dPic;
          heatJ += dPic * 240000;
          pushRxn('phenol_picric_acid', 'C₆H₅OH + 3HNO₃(đặc) —(H₂SO₄ đặc, 95 °C)→ C₆H₂(NO₂)₃OH↓ + 3H₂O', 'Nitro hóa Phenol → tinh thể vàng Picric acid', 'Phenol nitration → Picric acid C₆H₂(NO₂)₃OH↓', 'Phenol phản ứng với HNO₃ đặc/H₂SO₄ đặc tạo tinh thể vàng tươi 2,4,6-Trinitrophenol (Picric acid).', 'Nitration of Phenol in conc. H₂SO₄/HNO₃ precipitates bright yellow Picric acid.', dPic);
        }
      }

      // 5D-3. Catechol / Hydroquinone: C6H5OH + H2O2 -(Fe2+ or H3PO4, 50–70 °C)-> C6H4(OH)2 + H2O
      if ((moles.H2O2_aq || 0) > 1e-7 && ((moles.Fe2_aq || 0) > 1e-8 || (moles.H3PO4_aq || 0) > 1e-6) && T >= 323.15 && T <= 363.15) {
        const dCat = Math.min(moles[phSrc], moles.H2O2_aq) * (1 - Math.exp(-0.58 * dt));
        if (dCat > 1e-11) {
          consumeSpecies(phSrc, dCat);
          consumeSpecies('H2O2_aq', dCat);
          moles.C6H4OH_2_s = (moles.C6H4OH_2_s || 0) + dCat;
          moles.H2O_l = (moles.H2O_l || 0) + dCat;
          heatJ += dCat * 165000;
          pushRxn('phenol_catechol', 'C₆H₅OH + H₂O₂ —(Fe²⁺/H₃PO₄, 60 °C)→ C₆H₄(OH)₂ + H₂O', 'Hydroxyl hóa Phenol → Catechol & Hydroquinone', 'Phenol hydroxylation → Catechol / Hydroquinone', 'H₂O₂ có xúc tác Fe²⁺ hoặc H₃PO₄ gắn thêm –OH tạo đồng phân o/p-Dihydroxybenzene.', 'Catalytic H₂O₂ hydroxylation of Phenol yields Catechol and Hydroquinone.', dCat);
        }
      }
    }

    // ==================== PART 6: CARBOXYLIC ACID & ARENE (TOLUENE / ETHYLBENZENE) CHEMISTRY ====================
    // 6A. Phenol regeneration from Phenoxide (H+ or CO2 + H2O) & Benzenesulfonate alkali fusion
    if ((moles.C6H5O_aq || 0) > 1e-9) {
      if ((moles.H_aq || 0) > 1e-6) {
        const dReg = Math.min(moles.C6H5O_aq, moles.H_aq) * (1 - Math.exp(-3.5 * dt));
        if (dReg > 1e-11) {
          consumeSpecies('C6H5O_aq', dReg);
          consumeSpecies('H_aq', dReg);
          moles.C6H5OH_l = (moles.C6H5OH_l || 0) + dReg;
          heatJ += dReg * 28000;
          pushRxn('phenoxide_acidify', 'C₆H₅O⁻ + H⁺ → C₆H₅OH', 'Acid hóa Phenoxide tái tạo Phenol', 'Acidification of Phenoxide → Phenol', 'Acid mạnh đẩy Phenol ra khỏi muối Phenoxide.', 'Strong acid regenerates Phenol from Phenoxide.', dReg);
        }
      } else if (((moles.H2CO3_aq || 0) > 1e-8 || (moles.CO2_aq || 0) > 1e-8 || (moles.CO2_g || 0) > 1e-8 || (vessel.headspaceGasMoles?.CO2_g || 0) > 1e-8) && (moles.H2O_l || 0) > 1e-4) {
        const hsCo2 = vessel.headspaceGasMoles || {};
        const co2Src = (moles.H2CO3_aq || 0) > 1e-8 ? 'H2CO3_aq' : (moles.CO2_aq || 0) > 1e-8 ? 'CO2_aq' : (moles.CO2_g || 0) > 1e-8 ? 'CO2_g' : 'hs:CO2_g';
        const nCo2Avail = co2Src === 'hs:CO2_g' ? (hsCo2.CO2_g || 0) : (moles[co2Src] || 0);
        const dCo2Ph = Math.min(moles.C6H5O_aq, nCo2Avail, moles.H2O_l) * (1 - Math.exp(-1.6 * dt));
        if (dCo2Ph > 1e-11) {
          consumeSpecies('C6H5O_aq', dCo2Ph);
          if (co2Src === 'hs:CO2_g') { hsCo2.CO2_g = Math.max(0, hsCo2.CO2_g - dCo2Ph); if (hsCo2.CO2_g < 1e-13) delete hsCo2.CO2_g; }
          else consumeSpecies(co2Src, dCo2Ph);
          if (co2Src !== 'H2CO3_aq') consumeSpecies('H2O_l', dCo2Ph);
          moles.C6H5OH_l = (moles.C6H5OH_l || 0) + dCo2Ph;
          moles.HCO3_aq = (moles.HCO3_aq || 0) + dCo2Ph;
          heatJ += dCo2Ph * 22000;
          pushRxn('phenoxide_co2', 'C₆H₅O⁻ + CO₂ + H₂O → C₆H₅OH + HCO₃⁻', 'Sục CO₂ vào Phenoxide tái tạo Phenol (đục nhẹ)', 'CO₂ + Phenoxide + H₂O → Phenol + HCO₃⁻', 'H₂CO₃ mạnh hơn Phenol nên đẩy được Phenol tự do ra khỏi muối Phenoxide.', 'Carbonic acid displaces weaker Phenol from Phenoxide solution.', dCo2Ph);
        }
      }
    }
    if ((moles.C6H5SO3H_aq || 0) > 1e-9 && (moles.OH_aq || 0) > 1e-6) {
      const dBsa = Math.min(moles.C6H5SO3H_aq, moles.OH_aq) * (1 - Math.exp(-3.2 * dt));
      if (dBsa > 1e-11) {
        consumeSpecies('C6H5SO3H_aq', dBsa);
        consumeSpecies('OH_aq', dBsa);
        moles.C6H5SO3_aq = (moles.C6H5SO3_aq || 0) + dBsa;
        moles.H2O_l = (moles.H2O_l || 0) + dBsa;
        heatJ += dBsa * 55000;
        pushRxn('bsa_neutralize', 'C₆H₅SO₃H + OH⁻ → C₆H₅SO₃⁻ + H₂O', 'Trung hòa Benzenesulfonic acid', 'Neutralization of Benzenesulfonic acid', 'Benzenesulfonic acid phản ứng nhanh với NaOH tạo muối Benzenesulfonate.', 'Benzenesulfonic acid neutralizes with alkali to Benzenesulfonate.', dBsa);
      }
    }
    if ((moles.C6H5SO3Na_s || 0) > 1e-9 && (moles.NaOH_s || 0) > 1e-8 && T >= 573.15) {
      const dFus = Math.min(moles.C6H5SO3Na_s, moles.NaOH_s / 2) * (1 - Math.exp(-0.75 * dt));
      if (dFus > 1e-11) {
        consumeSpecies('C6H5SO3Na_s', dFus);
        consumeSpecies('NaOH_s', 2 * dFus);
        moles.C6H5O_aq = (moles.C6H5O_aq || 0) + dFus;
        moles.Na_aq = (moles.Na_aq || 0) + dFus;
        moles.Na2SO3_s = (moles.Na2SO3_s || 0) + dFus;
        gasProduced.H2O_g = (gasProduced.H2O_g || 0) + dFus;
        heatJ += dFus * 65000;
        pushRxn('bsa_alkali_fusion', 'C₆H₅SO₃Na + 2NaOH(rắn) —(310 °C)→ C₆H₅ONa + Na₂SO₃ + H₂O↑', 'Nung chảy kiềm Sodium benzenesulfonate → Sodium phenoxide', 'Alkali fusion of C₆H₅SO₃Na (310 °C) → Phenoxide + Na₂SO₃', 'Nung chảy C₆H₅SO₃Na với NaOH rắn ở 300–320 °C tạo muối Phenoxide.', 'Alkali fusion of sodium benzenesulfonate at 310 °C yields sodium phenoxide.', dFus, true);
      }
    }

    // 6B. Carboxylic Acid Preparations: Oxalic acid (EtOH/Glycol + conc HNO3), Acrylic & Crotonic acid (Aldehyde + Tollens/Ag2O)
    const oxNitConc = (moles.HNO3_l || 0) > 1e-7 ? moles.HNO3_l : ((moles.NO3_aq || 0) > 1e-4 && (moles.H_aq || 0) > 1e-4 && (moles.H2O_l || 0) < 0.8) ? Math.min(moles.NO3_aq, moles.H_aq) : 0;
    if (oxNitConc > 1e-7 && T >= 333.15) {
      if ((moles.C2H4OH_2_l || 0) > 1e-9) {
        const dOxG = Math.min(moles.C2H4OH_2_l, oxNitConc / 4) * (1 - Math.exp(-0.68 * dt));
        if (dOxG > 1e-11) {
          consumeSpecies('C2H4OH_2_l', dOxG);
          if ((moles.HNO3_l || 0) >= 4 * dOxG) consumeSpecies('HNO3_l', 4 * dOxG);
          else { consumeSpecies('NO3_aq', 4 * dOxG); consumeSpecies('H_aq', 4 * dOxG); }
          moles.H2C2O4_s = (moles.H2C2O4_s || 0) + dOxG;
          gasProduced.NO2_g = (gasProduced.NO2_g || 0) + 4 * dOxG;
          moles.H2O_l = (moles.H2O_l || 0) + 4 * dOxG;
          heatJ += dOxG * 280000;
          pushRxn('glycol_oxalic', 'HOCH₂CH₂OH + 4HNO₃(đặc) —(60 °C)→ HOOC–COOH + 4NO₂↑ + 4H₂O', 'Oxi hóa Ethylene glycol bằng HNO₃ đặc → Oxalic acid', 'Ethylene glycol + 4HNO₃(conc) → Oxalic acid + 4NO₂↑', 'HNO₃ đặc oxi hóa hai nhóm –CH₂OH của Ethylene glycol thành Oxalic acid và khí nâu đỏ NO₂.', 'Conc. HNO₃ oxidizes Ethylene glycol to Oxalic acid crystals and brown NO₂ gas.', dOxG, true);
        }
      } else if ((moles.C2H5OH_l || 0) > 1e-8) {
        const dOxE = Math.min(moles.C2H5OH_l, oxNitConc / 8) * (1 - Math.exp(-0.55 * dt));
        if (dOxE > 1e-11) {
          consumeSpecies('C2H5OH_l', dOxE);
          if ((moles.HNO3_l || 0) >= 8 * dOxE) consumeSpecies('HNO3_l', 8 * dOxE);
          else { consumeSpecies('NO3_aq', 8 * dOxE); consumeSpecies('H_aq', 8 * dOxE); }
          moles.H2C2O4_s = (moles.H2C2O4_s || 0) + dOxE;
          gasProduced.NO2_g = (gasProduced.NO2_g || 0) + 8 * dOxE;
          moles.H2O_l = (moles.H2O_l || 0) + 6 * dOxE;
          heatJ += dOxE * 420000;
          pushRxn('etoh_oxalic', 'C₂H₅OH + 8HNO₃(đặc) —(70 °C)→ HOOC–COOH + 8NO₂↑ + 6H₂O', 'Oxi hóa Ethanol bằng HNO₃ đặc → Oxalic acid + 8NO₂↑', 'Ethanol + 8HNO₃(conc) → Oxalic acid + 8NO₂↑', 'HNO₃ đặc nóng oxi hóa hoàn toàn Ethanol thành Oxalic acid và giải phóng khí NO₂.', 'Hot conc. HNO₃ oxidizes Ethanol to Oxalic acid and NO₂ gas.', dOxE, true);
        }
      }
    }

    // Acrylic & Crotonic acid via mild Tollens (Ag(NH3)2+ / Ag2O, 40–60 °C)
    if ((moles.CH2CHCHO_l || 0) > 1e-9 && T >= 313.15) {
      if ((moles.AgNH3_2_aq || 0) > 1e-7 && (moles.OH_aq || 0) > 1e-7) {
        const dAcr = Math.min(moles.CH2CHCHO_l, moles.AgNH3_2_aq / 2, moles.OH_aq / 2) * (1 - Math.exp(-0.95 * dt));
        if (dAcr > 1e-11) {
          consumeSpecies('CH2CHCHO_l', dAcr);
          consumeSpecies('AgNH3_2_aq', 2 * dAcr);
          consumeSpecies('OH_aq', 2 * dAcr);
          moles.CH2CHCOO_aq = (moles.CH2CHCOO_aq || 0) + dAcr;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dAcr;
          moles.NH3_aq = (moles.NH3_aq || 0) + 4 * dAcr;
          moles.H2O_l = (moles.H2O_l || 0) + 2 * dAcr;
          heatJ += dAcr * 115000;
          pushRxn('acrolein_tollens', 'CH₂=CHCHO + 2[Ag(NH₃)₂]⁺ + 2OH⁻ —(50 °C)→ CH₂=CHCOO⁻ + 2Ag↓ + 4NH₃ + 2H₂O', 'Oxi hóa Acrolein bằng thuốc thử Tollens → Acrylate + 2Ag↓', 'Acrolein + Tollens reagent → Acrylate + 2Ag↓', 'Thuốc thử Tollens oxi hóa chọn lọc nhóm –CHO bảo toàn nối đôi C=C tạo muối Acrylate.', 'Tollens reagent selectively oxidizes Acrolein to Acrylate preserving C=C.', dAcr);
        }
      } else if ((moles.Ag2O_s || 0) > 1e-8) {
        const dAcr2 = Math.min(moles.CH2CHCHO_l, moles.Ag2O_s) * (1 - Math.exp(-0.78 * dt));
        if (dAcr2 > 1e-11) {
          consumeSpecies('CH2CHCHO_l', dAcr2);
          consumeSpecies('Ag2O_s', dAcr2);
          moles.CH2CHCOOH_l = (moles.CH2CHCOOH_l || 0) + dAcr2;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dAcr2;
          heatJ += dAcr2 * 105000;
          pushRxn('acrolein_ag2o', 'CH₂=CHCHO + Ag₂O —(50 °C)→ CH₂=CHCOOH + 2Ag↓', 'Oxi hóa Acrolein bằng Ag₂O → Acrylic acid + 2Ag↓', 'Acrolein + Ag₂O → Acrylic acid + 2Ag↓', 'Ag₂O oxi hóa nhóm –CHO của Acrolein thành Acrylic acid.', 'Ag₂O oxidizes Acrolein directly to Acrylic acid.', dAcr2);
        }
      }
    }
    if ((moles.CH2CHCOO_aq || 0) > 1e-9 && (moles.H_aq || 0) > 1e-6) {
      const dAcrH = Math.min(moles.CH2CHCOO_aq, moles.H_aq) * (1 - Math.exp(-3.0 * dt));
      if (dAcrH > 1e-11) {
        consumeSpecies('CH2CHCOO_aq', dAcrH);
        consumeSpecies('H_aq', dAcrH);
        moles.CH2CHCOOH_l = (moles.CH2CHCOOH_l || 0) + dAcrH;
        heatJ += dAcrH * 15000;
      }
    }
    if ((moles.CH3CHCHCHO_l || 0) > 1e-9 && T >= 313.15) {
      if ((moles.AgNH3_2_aq || 0) > 1e-7 && (moles.OH_aq || 0) > 1e-7) {
        const dCrot = Math.min(moles.CH3CHCHCHO_l, moles.AgNH3_2_aq / 2, moles.OH_aq / 2) * (1 - Math.exp(-0.88 * dt));
        if (dCrot > 1e-11) {
          consumeSpecies('CH3CHCHCHO_l', dCrot);
          consumeSpecies('AgNH3_2_aq', 2 * dCrot);
          consumeSpecies('OH_aq', 2 * dCrot);
          moles.CH3CHCHCOO_aq = (moles.CH3CHCHCOO_aq || 0) + dCrot;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dCrot;
          moles.NH3_aq = (moles.NH3_aq || 0) + 4 * dCrot;
          moles.H2O_l = (moles.H2O_l || 0) + 2 * dCrot;
          heatJ += dCrot * 112000;
          pushRxn('croton_tollens', 'CH₃CH=CHCHO + 2[Ag(NH₃)₂]⁺ + 2OH⁻ —(50 °C)→ CH₃CH=CHCOO⁻ + 2Ag↓ + 4NH₃ + 2H₂O', 'Oxi hóa Crotonaldehyde bằng Tollens → Crotonate + 2Ag↓', 'Crotonaldehyde + Tollens → Crotonate + 2Ag↓', 'Oxi hóa nhẹ Crotonaldehyde ở 50 °C thu được muối Crotonate và kết tủa bạc.', 'Mild Tollens oxidation of Crotonaldehyde yields Crotonate and Ag mirror.', dCrot);
        }
      } else if ((moles.Ag2O_s || 0) > 1e-8) {
        const dCrot2 = Math.min(moles.CH3CHCHCHO_l, moles.Ag2O_s) * (1 - Math.exp(-0.74 * dt));
        if (dCrot2 > 1e-11) {
          consumeSpecies('CH3CHCHCHO_l', dCrot2);
          consumeSpecies('Ag2O_s', dCrot2);
          moles.CH3CHCHCOOH_s = (moles.CH3CHCHCOOH_s || 0) + dCrot2;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dCrot2;
          heatJ += dCrot2 * 102000;
          pushRxn('croton_ag2o', 'CH₃CH=CHCHO + Ag₂O —(50 °C)→ CH₃CH=CHCOOH + 2Ag↓', 'Oxi hóa Crotonaldehyde bằng Ag₂O → Crotonic acid', 'Crotonaldehyde + Ag₂O → Crotonic acid + 2Ag↓', 'Ag₂O oxi hóa Crotonaldehyde tạo tinh thể trắng Crotonic acid.', 'Ag₂O oxidizes Crotonaldehyde to white Crotonic acid crystals.', dCrot2);
        }
      }
    }
    if ((moles.CH3CHCHCOO_aq || 0) > 1e-9 && (moles.H_aq || 0) > 1e-6) {
      const dCrotH = Math.min(moles.CH3CHCHCOO_aq, moles.H_aq) * (1 - Math.exp(-3.0 * dt));
      if (dCrotH > 1e-11) {
        consumeSpecies('CH3CHCHCOO_aq', dCrotH);
        consumeSpecies('H_aq', dCrotH);
        moles.CH3CHCHCOOH_s = (moles.CH3CHCHCOOH_s || 0) + dCrotH;
        heatJ += dCrotH * 15000;
      }
    }

    // 6C. Carboxylic Acid Properties: H2C2O4_s, C6H5COOH_s, CH2CHCOOH_l, CH3CHCHCOOH_s (OH-, CaCO3/CO3^2-, Mg, Phenoxide)
    const carbAcids = [
      { id: 'H2C2O4_s', ion: 'C2O4_2_aq', stoich: 2, label: 'H₂C₂O₄', name: 'Oxalic acid' },
      { id: 'C6H5COOH_s', ion: 'C6H5COO_aq', stoich: 1, label: 'C₆H₅COOH', name: 'Benzoic acid' },
      { id: 'CH2CHCOOH_l', ion: 'CH2CHCOO_aq', stoich: 1, label: 'CH₂=CHCOOH', name: 'Acrylic acid' },
      { id: 'CH3CHCHCOOH_s', ion: 'CH3CHCHCOO_aq', stoich: 1, label: 'CH₃CH=CHCOOH', name: 'Crotonic acid' },
    ];
    for (const ca of carbAcids) {
      const nCa = moles[ca.id] || 0;
      if (nCa <= 1e-10) continue;
      if ((moles.OH_aq || 0) > 1e-6) {
        const dN = Math.min(nCa, moles.OH_aq / ca.stoich) * (1 - Math.exp(-3.0 * dt));
        if (dN > 1e-11) {
          consumeSpecies(ca.id, dN);
          consumeSpecies('OH_aq', ca.stoich * dN);
          moles[ca.ion] = (moles[ca.ion] || 0) + dN;
          moles.H2O_l = (moles.H2O_l || 0) + ca.stoich * dN;
          heatJ += dN * 54000 * ca.stoich;
          pushRxn(`ca_oh_${ca.id}`, `${ca.label} + ${ca.stoich > 1 ? '2' : ''}OH⁻ → ${ca.ion.replace('_2_aq', '²⁻').replace('_aq', '⁻')} + ${ca.stoich > 1 ? '2' : ''}H₂O`, `Trung hòa ${ca.name} bằng kiềm`, `Neutralization of ${ca.name}`, `${ca.name} phản ứng hoàn toàn với dung dịch kiềm tạo muối carboxylate.`, `${ca.name} neutralizes cleanly with alkali.`, dN);
        }
      } else if ((moles.CaCO3_s || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-4) {
        const acidNeed = ca.stoich === 2 ? 1 : 2;
        const dC = Math.min(nCa / acidNeed, moles.CaCO3_s) * (1 - Math.exp(-1.4 * dt));
        if (dC > 1e-11) {
          consumeSpecies(ca.id, acidNeed * dC);
          consumeSpecies('CaCO3_s', dC);
          moles[ca.ion] = (moles[ca.ion] || 0) + acidNeed * dC;
          moles.Ca2_aq = (moles.Ca2_aq || 0) + dC;
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dC;
          moles.H2O_l = (moles.H2O_l || 0) + dC;
          heatJ += dC * 28000;
          pushRxn(`ca_caco3_${ca.id}`, `${acidNeed > 1 ? '2' : ''}${ca.label} + CaCO₃ → Ca²⁺ + ${acidNeed > 1 ? '2' : ''}${ca.ion.replace('_2_aq', '²⁻').replace('_aq', '⁻')} + CO₂↑ + H₂O`, `${ca.name} + CaCO₃ → giải phóng CO₂↑`, `${ca.name} + CaCO₃ → CO₂↑`, `${ca.name} mạnh hơn H₂CO₃ nên sủi bọt khí CO₂ với CaCO₃ (khác với Phenol).`, `${ca.name} evolves CO₂ gas with CaCO₃, distinguishing –COOH from Phenol.`, dC, true);
        }
      } else if ((moles.Mg_s || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-4) {
        const acidNeed = ca.stoich === 2 ? 1 : 2;
        const dMg = Math.min(nCa / acidNeed, moles.Mg_s) * (1 - Math.exp(-1.6 * dt));
        if (dMg > 1e-11) {
          consumeSpecies(ca.id, acidNeed * dMg);
          consumeSpecies('Mg_s', dMg);
          moles[ca.ion] = (moles[ca.ion] || 0) + acidNeed * dMg;
          moles.Mg2_aq = (moles.Mg2_aq || 0) + dMg;
          gasProduced.H2_g = (gasProduced.H2_g || 0) + dMg;
          heatJ += dMg * 195000;
          pushRxn(`ca_mg_${ca.id}`, `${acidNeed > 1 ? '2' : ''}${ca.label} + Mg → Mg²⁺ + ${acidNeed > 1 ? '2' : ''}${ca.ion.replace('_2_aq', '²⁻').replace('_aq', '⁻')} + H₂↑`, `${ca.name} + Mg → H₂↑`, `${ca.name} + Mg → H₂↑`, `Kim loại Mg khử H⁺ của ${ca.name} giải phóng khí H₂.`, `Magnesium reacts with ${ca.name} evolving H₂ gas.`, dMg, true);
        }
      }
    }

    // 6D. Arene Chemistry: Toluene (C6H5CH3_l) & Ethylbenzene (C6H5C2H5_l)
    const hasFeAr = (moles.Fe_s || 0) > 1e-8 || (moles.FeCl3_s || 0) > 1e-8 || (moles.FeBr3_s || 0) > 1e-8 || (moles.Fe3_aq || 0) > 1e-8;
    const hsAr = vessel.headspaceGasMoles || {};
    const brAr = (moles.Br2_l || 0) > 1e-9 ? 'Br2_l' : (moles.Br2_g || 0) > 1e-9 ? 'Br2_g' : (hsAr.Br2_g || 0) > 1e-9 ? 'hs:Br2_g' : null;
    if ((moles.C6H5CH3_l || 0) > 1e-9) {
      // Ring bromination (Fe, 30-50 C, no UV) vs Side-chain benzyl bromination (UV or >= 373.15 K, no Fe)
      if (brAr) {
        const nBrA = brAr.startsWith('hs:') ? hsAr.Br2_g : moles[brAr];
        const takeBrA = (amt) => {
          if (brAr.startsWith('hs:')) { hsAr.Br2_g = Math.max(0, hsAr.Br2_g - amt); if (hsAr.Br2_g < 1e-13) delete hsAr.Br2_g; }
          else consumeSpecies(brAr, amt);
        };
        if (hasFeAr && !uvOn && T >= 303.15) {
          const dTolBr = Math.min(moles.C6H5CH3_l, nBrA) * (1 - Math.exp(-0.95 * dt));
          if (dTolBr > 1e-11) {
            consumeSpecies('C6H5CH3_l', dTolBr);
            takeBrA(dTolBr);
            moles.BrC6H4CH3_l = (moles.BrC6H4CH3_l || 0) + dTolBr;
            gasProduced.HBr_g = (gasProduced.HBr_g || 0) + dTolBr;
            heatJ += dTolBr * 52000;
            pushRxn('toluene_ring_br2', 'C₆H₅CH₃ + Br₂ —(Fe, 30–50 °C)→ o/p-BrC₆H₄CH₃ + HBr↑', 'Thế Bromine vào nhân thơm Toluene (xúc tác Fe)', 'Toluene ring bromination (Fe) → o/p-Bromotoluene + HBr↑', 'Nhóm –CH₃ đẩy electron hoạt hóa vòng thơm giúp thế Br₂ vào vị trí ortho/para.', 'Electron-donating –CH₃ directs Fe-catalyzed bromination to ortho/para positions.', dTolBr, true);
          }
        } else if (!hasFeAr && (uvOn || T >= 373.15)) {
          const dBnBr = Math.min(moles.C6H5CH3_l, nBrA) * (1 - Math.exp(-0.85 * dt));
          if (dBnBr > 1e-11) {
            consumeSpecies('C6H5CH3_l', dBnBr);
            takeBrA(dBnBr);
            moles.C6H5CH2Br_l = (moles.C6H5CH2Br_l || 0) + dBnBr;
            gasProduced.HBr_g = (gasProduced.HBr_g || 0) + dBnBr;
            heatJ += dBnBr * 44000;
            pushRxn('toluene_benzyl_br2', 'C₆H₅CH₃ + Br₂ —(UV / 110 °C)→ C₆H₅CH₂Br + HBr↑', 'Thế gốc tự do ở nhánh methyl Toluene → Benzyl bromide', 'Side-chain radical bromination (UV/110 °C) → Benzyl bromide', 'Dưới tia UV hoặc đun nóng không có Fe, Br₂ thế ưu tiên vào carbon benzyl tạo Benzyl bromide.', 'Under UV or heat without Fe, Br₂ substitutes at the benzylic methyl group.', dBnBr, true);
          }
        }
      }

      // Toluene Nitration (35 C -> NO2C6H4CH3; >= 100 C -> TNT)
      const hasTolAcid = (moles.H2SO4_l || 0) > 1e-6 || (moles.HSO4_aq || 0) > 1e-4;
      const hasTolNit = (moles.HNO3_l || 0) > 1e-7 || ((moles.NO3_aq || 0) > 1e-5 && (moles.H_aq || 0) > 1e-5);
      if (hasTolAcid && hasTolNit && T >= 303.15) {
        const nNitT = (moles.HNO3_l || 0) > 1e-7 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
        if (T >= 373.15 && nNitT >= 3e-7) {
          const dTnt = Math.min(moles.C6H5CH3_l, nNitT / 3) * (1 - Math.exp(-0.55 * dt));
          if (dTnt > 1e-11) {
            consumeSpecies('C6H5CH3_l', dTnt);
            if ((moles.HNO3_l || 0) >= 3 * dTnt) consumeSpecies('HNO3_l', 3 * dTnt);
            else { consumeSpecies('NO3_aq', 3 * dTnt); consumeSpecies('H_aq', 3 * dTnt); }
            moles.C6H2_NO2_3CH3_s = (moles.C6H2_NO2_3CH3_s || 0) + dTnt;
            moles.H2O_l = (moles.H2O_l || 0) + 3 * dTnt;
            heatJ += dTnt * 280000;
            pushRxn('toluene_tnt', 'C₆H₅CH₃ + 3HNO₃(đặc) —(H₂SO₄ đặc, 100–110 °C)→ 2,4,6-(NO₂)₃C₆H₂CH₃↓ + 3H₂O', 'Nitro hóa mạnh Toluene → 2,4,6-Trinitrotoluene (TNT)', 'Vigorous nitration of Toluene → 2,4,6-Trinitrotoluene (TNT)', 'Đun nóng 100–110 °C với hỗn hợp HNO₃/H₂SO₄ dư tạo tinh thể vàng TNT.', 'Vigorous nitration at 100–110 °C produces yellow 2,4,6-Trinitrotoluene (TNT).', dTnt);
          }
        } else {
          const dMonoN = Math.min(moles.C6H5CH3_l, nNitT) * (1 - Math.exp(-0.85 * dt));
          if (dMonoN > 1e-11) {
            consumeSpecies('C6H5CH3_l', dMonoN);
            if ((moles.HNO3_l || 0) >= dMonoN) consumeSpecies('HNO3_l', dMonoN);
            else { consumeSpecies('NO3_aq', dMonoN); consumeSpecies('H_aq', dMonoN); }
            moles.NO2C6H4CH3_l = (moles.NO2C6H4CH3_l || 0) + dMonoN;
            moles.H2O_l = (moles.H2O_l || 0) + dMonoN;
            heatJ += dMonoN * 125000;
            pushRxn('toluene_nitration', 'C₆H₅CH₃ + HNO₃ —(H₂SO₄ đặc, 35 °C)→ o/p-NO₂C₆H₄CH₃ + H₂O', 'Nitro hóa Toluene (35 °C) → o/p-Nitrotoluene', 'Toluene nitration (35 °C) → o/p-Nitrotoluene', 'Toluene phản ứng nitro hóa dễ hơn Benzene ngay ở 30–40 °C.', 'Toluene nitrates more readily than Benzene at 30–40 °C.', dMonoN);
          }
        }
      }

      // Toluene Hydrogenation (Ni/Pt, >= 423.15 K) -> Methylcyclohexane
      if (((moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8) && (moles.H2_g || 0) > 1e-9 && T >= 423.15) {
        const dHydT = Math.min(moles.C6H5CH3_l, moles.H2_g / 3) * (1 - Math.exp(-0.62 * dt));
        if (dHydT > 1e-11) {
          consumeSpecies('C6H5CH3_l', dHydT);
          consumeSpecies('H2_g', 3 * dHydT);
          moles.C7H14_l = (moles.C7H14_l || 0) + dHydT;
          heatJ += dHydT * 205000;
          pushRxn('toluene_hydrogenation', 'C₆H₅CH₃ + 3H₂ —(Ni, 180 °C)→ C₇H₁₄', 'Hydro hóa Toluene → Methylcyclohexane', 'Toluene hydrogenation → Methylcyclohexane', 'Cộng 3H₂ vào vòng thơm Toluene tạo Methylcyclohexane.', 'Catalytic hydrogenation of Toluene yields Methylcyclohexane.', dHydT);
        }
      }

      // Toluene + KMnO4 (ONLY on heating >= 343.15 K / 70–100 °C -> Benzoate + 2MnO2↓)
      if ((moles.MnO4_aq || 0) > 1e-7 && (moles.H2O_l || 0) > 1e-4 && T >= 343.15) {
        const dKmT = Math.min(moles.C6H5CH3_l, moles.MnO4_aq / 2) * (1 - Math.exp(-0.78 * dt));
        if (dKmT > 1e-11) {
          consumeSpecies('C6H5CH3_l', dKmT);
          consumeSpecies('MnO4_aq', 2 * dKmT);
          moles.C6H5COO_aq = (moles.C6H5COO_aq || 0) + dKmT;
          moles.MnO2_s = (moles.MnO2_s || 0) + 2 * dKmT;
          moles.OH_aq = (moles.OH_aq || 0) + dKmT;
          moles.H2O_l = (moles.H2O_l || 0) + dKmT;
          heatJ += dKmT * 360000;
          pushRxn('toluene_kmno4_hot', 'C₆H₅CH₃ + 2MnO₄⁻ —(80–100 °C)→ C₆H₅COO⁻ + 2MnO₂↓ + OH⁻ + H₂O', 'Oxi hóa Toluene bằng KMnO₄ đun nóng → Benzoate + MnO₂↓', 'Hot KMnO₄ oxidizes Toluene → Benzoate + 2MnO₂↓', 'Khác với Benzene trơ hoàn toàn, Toluene làm mất màu KMnO₄ khi đun nóng tạo kết tủa nâu đen MnO₂.', 'Unlike inert Benzene, hot KMnO₄ oxidizes Toluene to Benzoate and brown-black MnO₂↓.', dKmT);
        }
      }
    }

    // Ethylbenzene + KMnO4 (>= 343.15 K) -> Benzoate + CO3^2- + 4MnO2↓
    if ((moles.C6H5C2H5_l || 0) > 1e-9 && (moles.MnO4_aq || 0) > 1e-7 && (moles.H2O_l || 0) > 1e-4 && T >= 343.15) {
      const dKmEb = Math.min(moles.C6H5C2H5_l, moles.MnO4_aq / 4) * (1 - Math.exp(-0.72 * dt));
      if (dKmEb > 1e-11) {
        consumeSpecies('C6H5C2H5_l', dKmEb);
        consumeSpecies('MnO4_aq', 4 * dKmEb);
        moles.C6H5COO_aq = (moles.C6H5COO_aq || 0) + dKmEb;
        moles.CO3_2_aq = (moles.CO3_2_aq || 0) + dKmEb;
        moles.MnO2_s = (moles.MnO2_s || 0) + 4 * dKmEb;
        moles.OH_aq = (moles.OH_aq || 0) + dKmEb;
        moles.H2O_l = (moles.H2O_l || 0) + 2 * dKmEb;
        heatJ += dKmEb * 620000;
        pushRxn('ethylbenzene_kmno4_hot', 'C₆H₅C₂H₅ + 4MnO₄⁻ —(90 °C)→ C₆H₅COO⁻ + CO₃²⁻ + 4MnO₂↓ + OH⁻ + 2H₂O', 'Oxi hóa cắt mạch Ethylbenzene bằng KMnO₄ nóng → Benzoate + MnO₂↓', 'Hot KMnO₄ cleaves Ethylbenzene → Benzoate + CO₃²⁻ + 4MnO₂↓', 'Toàn bộ nhánh ethyl bị oxi hóa cắt mạch thành nhóm –COO⁻ (Benzoate) và MnO₂↓.', 'Hot KMnO₄ cleaves the entire ethyl side chain to Benzoate and MnO₂↓.', dKmEb);
      }
    }

    // Benzoate acidification: C6H5COO- + H+ -> C6H5COOH↓ (white crystals)
    if ((moles.C6H5COO_aq || 0) > 1e-9 && (moles.H_aq || 0) > 1e-6) {
      const dBzAcid = Math.min(moles.C6H5COO_aq, moles.H_aq) * (1 - Math.exp(-3.2 * dt));
      if (dBzAcid > 1e-11) {
        consumeSpecies('C6H5COO_aq', dBzAcid);
        consumeSpecies('H_aq', dBzAcid);
        moles.C6H5COOH_s = (moles.C6H5COOH_s || 0) + dBzAcid;
        heatJ += dBzAcid * 24000;
        pushRxn('benzoate_acidify', 'C₆H₅COO⁻ + H⁺ → C₆H₅COOH↓ (trắng)', 'Acid hóa Benzoate kết tinh Benzoic acid trắng', 'Acidification of Benzoate → white Benzoic acid↓', 'Acid hóa muối Benzoate kết tủa tinh thể trắng Benzoic acid.', 'Acidifying Benzoate precipitates white Benzoic acid crystals.', dBzAcid);
      }
    }
  }

  return heatJ;
}

/**
 * Declarative complex dissociations & ion salt pairings enforced at zero-liquid dry phase boundaries.
 * Adding a new aqueous ion or complex to SPECIES should include its dry fate here.
 */
export const DRY_COMPLEX_DISSOCIATIONS = {
  CuCl4_2_aq: { Cu2_aq: 1, Cl_aq: 4 },
  CuOH4_2_aq: { CuOH2_s: 1, OH_aq: 2 },
  AgOH2_aq: { Ag2O_s: 0.5, H2O_g: 0.5, OH_aq: 1 },
  AgCl2_aq: { AgCl_s: 1, Cl_aq: 1 },
  CuCl2_comp_aq: { CuCl_s: 1, Cl_aq: 1 },
  CuNH3_4_2_aq: { Cu2_aq: 1, NH3_g: 4 },
  AgNH3_2_aq: { Ag_aq: 1, NH3_g: 2 },
  ZnNH3_4_2_aq: { Zn2_aq: 1, NH3_g: 4 },
  AlOH4_aq: { AlOH3_s: 1, OH_aq: 1 },
  H2O2_aq: { H2O_g: 1, O2_g: 0.5 },
  H2CO3_aq: { H2O_g: 1, CO2_g: 1 },
  NH3_aq: { NH3_g: 1 },
  NO2_aq: { NO2_g: 1 },
  SO2_aq: { SO2_g: 1 },
  Cl2_aq: { Cl2_g: 1 },
  HClO_aq: { H2O_g: 0.5, Cl2_g: 0.5, O2_g: 0.25 },
  Br2_aq: { Br2_g: 1 },
  HBrO_aq: { H2O_g: 0.5, Br2_g: 0.5, O2_g: 0.25 },
  I2_aq: { I2_s: 1 },
  I3_aq: { I2_s: 1, I_aq: 1 },
  H2S_aq: { H2S_g: 1 },
  HS_aq: { H2S_g: 0.5, S2_aq: 0.5 },
  H3PO4_aq: { H3PO4_s: 1 },
  H3PO3_aq: { P4O6_s: 0.25, H2O_g: 1.5 },
  H3PO2_aq: { H2O_g: 1.5, P_red_s: 0.5 },
  CrO5_aq: { Cr2O3_s: 0.5, O2_g: 1.75 },
  CH3COOOH_aq: { CH3COOH_s: 1, O2_g: 0.5 },
  C6H5SO3H_aq: { C6H6_g: 1, SO3_g: 1 },
  C6H5O_aq: { C6H5OH_s: 1 },
  C2H5NH2_aq: { C2H5NH2_g: 1 },
  C2O4_2_aq: { H2C2O4_s: 1 },
  C6H5COO_aq: { C6H5COOH_s: 1 },
  C6H5SO3_aq: { C6H5SO3Na_s: 1 },
  CH2CHCOO_aq: { CH2CHCOOH_g: 1 },
  CH3CHCHCOO_aq: { CH3CHCHCOOH_s: 1 },
};

export const DRY_SALT_PAIRINGS = [
  ['Ag_aq', 2, 'Cr2O7_2_aq', 1, 'Ag2Cr2O7_s', 1, false],
  ['Ag_aq', 2, 'CrO4_2_aq', 1, 'Ag2CrO4_s', 1, false],
  ['Ba2_aq', 1, 'CrO4_2_aq', 1, 'BaCrO4_s', 1, false],
  ['Cr3_aq', 1, 'OH_aq', 3, 'CrOH3_s', 1, false],
  ['Cr3_aq', 1, 'PO4_3_aq', 1, 'CrPO4_s', 1, false],
  ['Cr3_aq', 2, 'SO4_2_aq', 3, 'Cr2SO4_3_s', 1, false],
  ['Cr3_aq', 1, 'Cl_aq', 3, 'CrCl3_s', 1, false],
  ['Cr3_aq', 1, 'NO3_aq', 3, 'CrNO3_3_s', 1, false],
  ['Ag_aq', 1, 'Cl_aq', 1, 'AgCl_s', 1, false],
  ['Ag_aq', 1, 'Br_aq', 1, 'AgBr_s', 1, false],
  ['Ag_aq', 1, 'I_aq', 1, 'AgI_s', 1, false],
  ['Ag_aq', 2, 'SO4_2_aq', 1, 'Ag2SO4_s', 1, false],
  ['Ag_aq', 2, 'CO3_2_aq', 1, 'Ag2CO3_s', 1, false],
  ['Ag_aq', 1, 'NO3_aq', 1, 'AgNO3_s', 1, false],
  ['Ba2_aq', 1, 'SO4_2_aq', 1, 'BaSO4_s', 1, false],
  ['Ba2_aq', 1, 'CO3_2_aq', 1, 'BaCO3_s', 1, false],
  ['Ba2_aq', 1, 'OH_aq', 2, 'BaOH2_s', 1, false],
  ['Ba2_aq', 1, 'Cl_aq', 2, 'BaCl2_s', 1, false],
  ['Ba2_aq', 1, 'Br_aq', 2, 'BaBr2_s', 1, false],
  ['Ba2_aq', 1, 'I_aq', 2, 'BaI2_s', 1, false],
  ['Ba2_aq', 1, 'NO3_aq', 2, 'BaNO3_2_s', 1, false],
  ['Fe3_aq', 1, 'OH_aq', 3, 'FeOH3_s', 1, false],
  ['Fe3_aq', 2, 'SO4_2_aq', 3, 'Fe2SO4_3_s', 1, false],
  ['Fe3_aq', 1, 'Cl_aq', 3, 'FeCl3_s', 1, false],
  ['Fe3_aq', 1, 'Br_aq', 3, 'FeBr3_s', 1, false],
  ['Fe3_aq', 1, 'NO3_aq', 3, 'FeNO3_3_s', 1, false],
  ['Fe2_aq', 1, 'CO3_2_aq', 1, 'FeCO3_s', 1, false],
  ['Fe2_aq', 1, 'OH_aq', 2, 'FeOH2_s', 1, false],
  ['Fe2_aq', 1, 'SO4_2_aq', 1, 'FeSO4_s', 1, false],
  ['Fe2_aq', 1, 'Cl_aq', 2, 'FeCl2_s', 1, false],
  ['Fe2_aq', 1, 'Br_aq', 2, 'FeBr2_s', 1, false],
  ['Fe2_aq', 1, 'I_aq', 2, 'FeI2_s', 1, false],
  ['Fe2_aq', 1, 'NO3_aq', 2, 'FeNO3_2_s', 1, false],
  ['Ca2_aq', 1, 'CO3_2_aq', 1, 'CaCO3_s', 1, false],
  ['Ca2_aq', 1, 'OH_aq', 2, 'CaOH2_s', 1, false],
  ['Ca2_aq', 1, 'SO4_2_aq', 1, 'CaSO4_s', 1, false],
  ['Ca2_aq', 1, 'Cl_aq', 2, 'CaCl2_s', 1, false],
  ['Ca2_aq', 1, 'Br_aq', 2, 'CaBr2_s', 1, false],
  ['Ca2_aq', 1, 'I_aq', 2, 'CaI2_s', 1, false],
  ['Ca2_aq', 1, 'NO3_aq', 2, 'CaNO3_2_s', 1, false],
  ['Cu2_aq', 1, 'CO3_2_aq', 1, 'CuCO3_s', 1, false],
  ['Cu2_aq', 1, 'SO4_2_aq', 1, 'CuSO4_s', 1, false],
  ['Cu2_aq', 1, 'OH_aq', 2, 'CuOH2_s', 1, false],
  ['Cu2_aq', 1, 'Cl_aq', 2, 'CuCl2_s', 1, false],
  ['Cu2_aq', 1, 'Br_aq', 2, 'CuBr2_s', 1, false],
  ['Cu2_aq', 1, 'NO3_aq', 2, 'CuNO3_2_s', 1, false],
  ['Zn2_aq', 1, 'CO3_2_aq', 1, 'ZnCO3_s', 1, false],
  ['Zn2_aq', 1, 'SO4_2_aq', 1, 'ZnSO4_s', 1, false],
  ['Zn2_aq', 1, 'Cl_aq', 2, 'ZnCl2_s', 1, false],
  ['Zn2_aq', 1, 'Br_aq', 2, 'ZnBr2_s', 1, false],
  ['Zn2_aq', 1, 'I_aq', 2, 'ZnI2_s', 1, false],
  ['Zn2_aq', 1, 'NO3_aq', 2, 'ZnNO3_2_s', 1, false],
  ['Zn2_aq', 1, 'OH_aq', 2, 'ZnOH2_s', 1, false],
  ['Na_aq', 2, 'CO3_2_aq', 1, 'Na2CO3_s', 1, false],
  ['Na_aq', 1, 'HCO3_aq', 1, 'NaHCO3_s', 1, false],
  ['Na_aq', 1, 'Cl_aq', 1, 'NaCl_s', 1, false],
  ['Na_aq', 1, 'Br_aq', 1, 'NaBr_s', 1, false],
  ['Na_aq', 1, 'I_aq', 1, 'NaI_s', 1, false],
  ['Na_aq', 1, 'ClO_aq', 1, 'NaClO_s', 1, false],
  ['Na_aq', 1, 'ClO3_aq', 1, 'NaClO3_s', 1, false],
  ['Na_aq', 1, 'BrO_aq', 1, 'NaBrO_s', 1, false],
  ['Na_aq', 1, 'BrO3_aq', 1, 'NaBrO3_s', 1, false],
  ['Na_aq', 1, 'IO_aq', 1, 'NaIO_s', 1, false],
  ['Na_aq', 1, 'IO3_aq', 1, 'NaIO3_s', 1, false],
  ['Na_aq', 2, 'SO4_2_aq', 1, 'Na2SO4_s', 1, false],
  ['Na_aq', 1, 'HSO4_aq', 1, 'NaHSO4_s', 1, false],
  ['Na_aq', 1, 'NO3_aq', 1, 'NaNO3_s', 1, false],
  ['Na_aq', 1, 'C2H5O_aq', 1, 'C2H5ONa_s', 1, false],
  ['Na_aq', 1, 'OH_aq', 1, 'NaOH_s', 1, false],
  ['NH4_aq', 1, 'Cl_aq', 1, 'NH4Cl_s', 1, false],
  ['NH4_aq', 1, 'Br_aq', 1, 'NH4Br_s', 1, false],
  ['NH4_aq', 1, 'I_aq', 1, 'NH4I_s', 1, false],
  ['NH4_aq', 1, 'NO3_aq', 1, 'NH4NO3_s', 1, false],
  ['NH4_aq', 2, 'SO4_2_aq', 1, 'NH4_2_SO4_s', 1, false],
  ['NH4_aq', 1, 'HSO4_aq', 1, 'NH4HSO4_s', 1, false],
  ['Mg2_aq', 1, 'CO3_2_aq', 1, 'MgCO3_s', 1, false],
  ['Mg2_aq', 1, 'OH_aq', 2, 'MgOH2_s', 1, false],
  ['Mg2_aq', 1, 'SO4_2_aq', 1, 'MgSO4_s', 1, false],
  ['Mg2_aq', 1, 'Cl_aq', 2, 'MgCl2_s', 1, false],
  ['Mg2_aq', 1, 'Br_aq', 2, 'MgBr2_s', 1, false],
  ['Mg2_aq', 1, 'I_aq', 2, 'MgI2_s', 1, false],
  ['Mg2_aq', 1, 'NO3_aq', 2, 'MgNO3_2_s', 1, false],
  ['Al3_aq', 1, 'OH_aq', 3, 'AlOH3_s', 1, false],
  ['Al3_aq', 2, 'SO4_2_aq', 3, 'Al2SO4_3_s', 1, false],
  ['Al3_aq', 1, 'Cl_aq', 3, 'AlCl3_s', 1, false],
  ['Al3_aq', 1, 'Br_aq', 3, 'AlBr3_s', 1, false],
  ['Al3_aq', 1, 'I_aq', 3, 'AlI3_s', 1, false],
  ['Al3_aq', 1, 'NO3_aq', 3, 'AlNO3_3_s', 1, false],
  ['K_aq', 2, 'CO3_2_aq', 1, 'K2CO3_s', 1, false],
  ['K_aq', 1, 'HCO3_aq', 1, 'KHCO3_s', 1, false],
  ['K_aq', 2, 'SO4_2_aq', 1, 'K2SO4_s', 1, false],
  ['K_aq', 1, 'HSO4_aq', 1, 'KHSO4_s', 1, false],
  ['K_aq', 1, 'Cl_aq', 1, 'KCl_s', 1, false],
  ['K_aq', 1, 'Br_aq', 1, 'KBr_s', 1, false],
  ['K_aq', 1, 'I_aq', 1, 'KI_s', 1, false],
  ['K_aq', 1, 'ClO_aq', 1, 'KClO_s', 1, false],
  ['K_aq', 1, 'ClO3_aq', 1, 'KClO3_s', 1, false],
  ['K_aq', 1, 'BrO_aq', 1, 'KBrO_s', 1, false],
  ['K_aq', 1, 'BrO3_aq', 1, 'KBrO3_s', 1, false],
  ['K_aq', 1, 'IO_aq', 1, 'KIO_s', 1, false],
  ['K_aq', 1, 'IO3_aq', 1, 'KIO3_s', 1, false],
  ['H_aq', 1, 'IO3_aq', 1, 'HIO3_s', 1, false],
  ['K_aq', 1, 'NO3_aq', 1, 'KNO3_s', 1, false],
  ['K_aq', 1, 'C2H5O_aq', 1, 'C2H5OK_s', 1, false],
  ['K_aq', 1, 'OH_aq', 1, 'KOH_s', 1, false],
  ['K_aq', 1, 'MnO4_aq', 1, 'KMnO4_s', 1, false],
  ['K_aq', 2, 'MnO4_2_aq', 1, 'K2MnO4_s', 1, false],
  ['Mn2_aq', 1, 'OH_aq', 2, 'MnOH2_s', 1, false],
  ['Mn2_aq', 1, 'SO4_2_aq', 1, 'MnSO4_s', 1, false],
  ['Mn2_aq', 1, 'Cl_aq', 2, 'MnCl2_s', 1, false],
  ['Mn2_aq', 1, 'Br_aq', 2, 'MnBr2_s', 1, false],
  ['Mn2_aq', 1, 'I_aq', 2, 'MnI2_s', 1, false],
  ['H_aq', 1, 'OH_aq', 1, 'H2O_g', 1, true],
  ['H_aq', 1, 'Cl_aq', 1, 'HCl_g', 1, true],
  ['H_aq', 1, 'Br_aq', 1, 'HBr_g', 1, true],
  ['H_aq', 1, 'I_aq', 1, 'HI_g', 1, true],
  ['H_aq', 1, 'HS_aq', 1, 'H2S_g', 1, true],
  ['H_aq', 2, 'S2_aq', 1, 'H2S_g', 1, true],
  ['H_aq', 1, 'NO3_aq', 1, 'HNO3_g', 1, true],
  ['Ag_aq', 2, 'S2_aq', 1, 'Ag2S_s', 1, false],
  ['Cu2_aq', 1, 'S2_aq', 1, 'CuS_s', 1, false],
  ['Fe2_aq', 1, 'S2_aq', 1, 'FeS_s', 1, false],
  ['Zn2_aq', 1, 'S2_aq', 1, 'ZnS_s', 1, false],
  ['Mn2_aq', 1, 'S2_aq', 1, 'MnS_s', 1, false],
  ['Mg2_aq', 1, 'S2_aq', 1, 'MgS_s', 1, false],
  ['Ca2_aq', 1, 'S2_aq', 1, 'CaS_s', 1, false],
  ['Ba2_aq', 1, 'S2_aq', 1, 'BaS_s', 1, false],
  ['Al3_aq', 2, 'S2_aq', 3, 'Al2S3_s', 1, false],
  ['Na_aq', 2, 'S2_aq', 1, 'Na2S_s', 1, false],
  ['K_aq', 2, 'S2_aq', 1, 'K2S_s', 1, false],
  ['H_aq', 1, 'H2PO4_aq', 1, 'H3PO4_s', 1, false],
  ['H_aq', 2, 'HPO4_2_aq', 1, 'H3PO4_s', 1, false],
  ['H_aq', 3, 'PO4_3_aq', 1, 'H3PO4_s', 1, false],
  ['K_aq', 1, 'H2PO4_aq', 1, 'KH2PO4_s', 1, false],
  ['K_aq', 2, 'HPO4_2_aq', 1, 'K2HPO4_s', 1, false],
  ['K_aq', 3, 'PO4_3_aq', 1, 'K3PO4_s', 1, false],
  ['Na_aq', 1, 'H2PO4_aq', 1, 'NaH2PO4_s', 1, false],
  ['Na_aq', 2, 'HPO4_2_aq', 1, 'Na2HPO4_s', 1, false],
  ['Na_aq', 3, 'PO4_3_aq', 1, 'Na3PO4_s', 1, false],
  ['Na_aq', 1, 'H2PO2_aq', 1, 'NaH2PO2_s', 1, false],
  ['Na_aq', 1, 'H2PO3_aq', 1, 'NaH2PO3_s', 1, false],
  ['Na_aq', 2, 'HPO3_2_aq', 1, 'Na2HPO3_s', 1, false],
  ['Ag_aq', 3, 'PO4_3_aq', 1, 'Ag3PO4_s', 1, false],
  ['Ca2_aq', 3, 'PO4_3_aq', 2, 'Ca3PO4_2_s', 1, false],
  ['Ba2_aq', 3, 'PO4_3_aq', 2, 'Ba3PO4_2_s', 1, false],
  ['Mg2_aq', 3, 'PO4_3_aq', 2, 'Mg3PO4_2_s', 1, false],
  ['Cu2_aq', 3, 'PO4_3_aq', 2, 'Cu3PO4_2_s', 1, false],
  ['Zn2_aq', 3, 'PO4_3_aq', 2, 'Zn3PO4_2_s', 1, false],
  ['Fe3_aq', 1, 'PO4_3_aq', 1, 'FePO4_s', 1, false],
  ['Fe2_aq', 3, 'PO4_3_aq', 2, 'Fe3PO4_2_s', 1, false],
  ['Al3_aq', 1, 'PO4_3_aq', 1, 'AlPO4_s', 1, false],
  ['Mn2_aq', 3, 'PO4_3_aq', 2, 'Mn3PO4_2_s', 1, false],
  ['Na_aq', 2, 'SiO3_2_aq', 1, 'Na2SiO3_s', 1, false],
  ['K_aq', 2, 'SiO3_2_aq', 1, 'K2SiO3_s', 1, false],
  ['Ca2_aq', 1, 'SiO3_2_aq', 1, 'CaSiO3_s', 1, false],
  ['H_aq', 2, 'SiO3_2_aq', 1, 'H2SiO3_s', 1, false],
  ['K_aq', 2, 'Cr2O7_2_aq', 1, 'K2Cr2O7_s', 1, false],
  ['Na_aq', 2, 'Cr2O7_2_aq', 1, 'Na2Cr2O7_s', 1, false],
  ['H_aq', 2, 'Cr2O7_2_aq', 1, 'CrO3_s', 2, false],
  ['K_aq', 2, 'CrO4_2_aq', 1, 'K2CrO4_s', 1, false],
  ['Na_aq', 2, 'CrO4_2_aq', 1, 'Na2CrO4_s', 1, false],
  ['NH4_aq', 2, 'CrO4_2_aq', 1, 'NH4_2_CrO4_s', 1, false],
  ['H_aq', 2, 'CrO4_2_aq', 1, 'CrO3_s', 1, false],
  ['Na_aq', 1, 'CH3COO_aq', 1, 'CH3COONa_s', 1, false],
  ['K_aq', 1, 'CH3COO_aq', 1, 'CH3COOK_s', 1, false],
  ['NH4_aq', 1, 'CH3COO_aq', 1, 'CH3COONH4_s', 1, false],
  ['Mg2_aq', 1, 'CH3COO_aq', 2, 'MgCH3COO_2_s', 1, false],
  ['Zn2_aq', 1, 'CH3COO_aq', 2, 'ZnCH3COO_2_s', 1, false],
  ['Ca2_aq', 1, 'CH3COO_aq', 2, 'CaCH3COO_2_s', 1, false],
  ['Cu2_aq', 1, 'CH3COO_aq', 2, 'CuCH3COO_2_s', 1, false],
  ['Fe2_aq', 1, 'CH3COO_aq', 2, 'FeCH3COO_2_s', 1, false],
  ['H_aq', 1, 'CH3COO_aq', 1, 'CH3COOH_s', 1, false],
  ['Na_aq', 1, 'HCOO_aq', 1, 'HCOONa_s', 1, false],
  ['K_aq', 1, 'HCOO_aq', 1, 'HCOOK_s', 1, false],
  ['H_aq', 1, 'HCOO_aq', 1, 'CO_g', 1, true],
];

/**
 * Enforce strict dry phase boundary: when liquid solvent volume reaches 0,
 * zero aqueous (aq) ions may remain — volatile HCl/HNO3/H2O/NH3 escape as gas and
 * non-volatile ions crystallize cleanly as anhydrous solids with exact mass conservation.
 */
export function enforceDryPhaseBoundary(vessel) {
  const moles = vessel.moles;
  const gasProduced = createZeroGasMap();
  if (
    (moles.H2O_l || 0) > 1e-7 ||
    (moles.C2H5OH_l || 0) > 1e-7 ||
    (moles.CH3COOH_l || 0) > 1e-7 ||
    (moles.C2H5OC2H5_l || 0) > 1e-7 ||
    (moles.CH3COOC2H5_l || 0) > 1e-7 ||
    (moles.HNO3_l || 0) > 1e-7 ||
    (moles.H2SO4_l || 0) > 1e-7 ||
    (moles.H2O_s || 0) > 1e-7
  ) {
    return { gasProduced };
  }

  // Any sub-threshold solvent film evaporates completely to dry state
  if ((moles.H2O_l || 0) > 0) {
    gasProduced.H2O_g += moles.H2O_l;
    delete moles.H2O_l;
  }
  for (const subOrg of ['C2H5OH_l', 'CH3COOH_l', 'C2H5OC2H5_l', 'CH3COOC2H5_l']) {
    if ((moles[subOrg] || 0) > 0) delete moles[subOrg];
  }

  // Dissociate complex ions cleanly before salt pairing
  for (const [compId, outputs] of Object.entries(DRY_COMPLEX_DISSOCIATIONS)) {
    const n = moles[compId] || 0;
    if (n <= 0) continue;
    for (const [outId, coeff] of Object.entries(outputs)) {
      if (SPECIES[outId]?.phase === 'g') {
        gasProduced[outId] = (gasProduced[outId] || 0) + coeff * n;
      } else {
        moles[outId] = (moles[outId] || 0) + coeff * n;
      }
    }
    delete moles[compId];
  }

  const pairToProduct = (a, cA, b, cB, outId, cOut, isGas = false) => {
    const na = moles[a] || 0;
    const nb = moles[b] || 0;
    if (na <= 0 || nb <= 0) return;
    const xi = Math.min(na / cA, nb / cB);
    if (xi <= 0) return;
    moles[a] = na - cA * xi;
    moles[b] = nb - cB * xi;
    if (moles[a] < 1e-13) delete moles[a];
    if (moles[b] < 1e-13) delete moles[b];
    if (isGas) {
      gasProduced[outId] = (gasProduced[outId] || 0) + cOut * xi;
    } else {
      moles[outId] = (moles[outId] || 0) + cOut * xi;
    }
  };

  // Zincate in NaOH -> Zn(OH)2(s) + 2 NaOH(s)
  if ((moles.ZnOH4_2_aq || 0) > 0) {
    pairToProduct('ZnOH4_2_aq', 1, 'Na_aq', 2, 'ZnOH2_s', 1, false);
    if ((moles.ZnOH4_2_aq || 0) > 0) {
      const rem = moles.ZnOH4_2_aq;
      const nh = moles.H_aq || 0;
      const xh = Math.min(rem, nh / 2);
      if (xh > 0) {
        moles.ZnOH4_2_aq -= xh;
        moles.H_aq -= 2 * xh;
        moles.ZnOH2_s = (moles.ZnOH2_s || 0) + xh;
        gasProduced.H2O_g += 2 * xh;
      }
      if ((moles.ZnOH4_2_aq || 0) < 1e-13) delete moles.ZnOH4_2_aq;
      if ((moles.H_aq || 0) < 1e-13) delete moles.H_aq;
    }
  }

  // Deprotonate NH4+ + OH- -> NH3(g) + H2O(g) at dry boundary
  if ((moles.NH4_aq || 0) > 0 && (moles.OH_aq || 0) > 0) {
    const xNh4 = Math.min(moles.NH4_aq, moles.OH_aq);
    moles.NH4_aq -= xNh4;
    moles.OH_aq -= xNh4;
    gasProduced.NH3_g += xNh4;
    gasProduced.H2O_g += xNh4;
    if (moles.NH4_aq < 1e-13) delete moles.NH4_aq;
    if (moles.OH_aq < 1e-13) delete moles.OH_aq;
  }

  // Ca(HCO3)2 decomposition cleanly at dry boundary -> CaCO3(s) + H2O(g) + CO2(g)
  if ((moles.Ca2_aq || 0) > 0 && (moles.HCO3_aq || 0) >= 2e-13) {
    const xBicarb = Math.min(moles.Ca2_aq, moles.HCO3_aq / 2);
    if (xBicarb > 0) {
      moles.Ca2_aq -= xBicarb;
      moles.HCO3_aq -= 2 * xBicarb;
      moles.CaCO3_s = (moles.CaCO3_s || 0) + xBicarb;
      gasProduced.H2O_g += xBicarb;
      gasProduced.CO2_g = (gasProduced.CO2_g || 0) + xBicarb;
      if (moles.Ca2_aq < 1e-13) delete moles.Ca2_aq;
      if (moles.HCO3_aq < 1e-13) delete moles.HCO3_aq;
    }
  }

  for (const [a, cA, b, cB, outId, cOut, isGas] of DRY_SALT_PAIRINGS) {
    pairToProduct(a, cA, b, cB, outId, cOut, isGas);
  }

  if ((moles.Phenolphthalein_aq || 0) > 0) {
    moles.Phenolphthalein_s = (moles.Phenolphthalein_s || 0) + moles.Phenolphthalein_aq;
    delete moles.Phenolphthalein_aq;
  }

  // Final guard: strip any floating-point dust (< 1e-10) so zero (aq) remains
  for (const [id, n] of Object.entries(moles)) {
    if (SPECIES[id]?.phase === 'aq' && n < 1e-10) {
      delete moles[id];
    }
  }

  return { gasProduced };
}

/**
 * Equilibrate solutes with Nernst octanol/water partition metadata across multi-phase liquid-liquid strata.
 */
export function stepLiquidLiquidPartition(vessel, strat, dt) {
  if (!vessel?.moles || !strat || vessel.isFrozenSolid || dt <= 0) return;
  const orgMl = (strat.lightOrganicMl || 0) + (strat.heavyOrganicMl || 0);
  const vAqL = Math.max(0, strat.aqueousMl || 0) / 1000;
  const vOrgL = Math.max(0, orgMl) / 1000;

  for (const sp of Object.values(SPECIES)) {
    if (!sp || !sp.organicSpeciesId || !(sp.partitionKow > 0)) continue;
    const aqId = sp.id;
    const orgId = sp.organicSpeciesId;
    const nAq = vessel.moles[aqId] || 0;
    const nOrg = vessel.moles[orgId] || 0;
    const nTot = nAq + nOrg;
    if (nTot <= 1e-12) continue;

    if (vOrgL <= 1e-7 && vAqL > 1e-7) {
      if (nOrg > 1e-12) {
        vessel.moles[aqId] = nTot;
        delete vessel.moles[orgId];
      }
      continue;
    }
    if (vAqL <= 1e-7 || vOrgL <= 1e-7) continue;

    const agitate = (vessel.magStirRpm || 0) > 0 || (vessel.stirTimer || 0) > 0 ? 4.2 : 1.0;
    const kPart = Math.min(8.5, Math.max(0.15, 0.045 * Math.max(1, strat.interfaceAreaCm2 || 15) * agitate));
    const nOrgEq = nTot * ((sp.partitionKow * vOrgL) / (vAqL + sp.partitionKow * vOrgL));
    const nextOrg = nOrgEq + (nOrg - nOrgEq) * Math.exp(-kPart * dt);
    const clampedOrg = Math.max(0, Math.min(nTot, nextOrg));
    const clampedAq = Math.max(0, nTot - clampedOrg);

    if (clampedAq > 1e-12) vessel.moles[aqId] = clampedAq;
    else delete vessel.moles[aqId];
    if (clampedOrg > 1e-12) vessel.moles[orgId] = clampedOrg;
    else delete vessel.moles[orgId];
  }
}

/**
 * Audit mathematical and mass-conservation invariants on a single vessel state.
 * Returns { valid: boolean, errors: string[] }.
 */
export function validateVesselInvariants(vessel) {
  const errors = [];
  if (!vessel) return { valid: false, errors: ['vessel is null'] };

  if (!Number.isFinite(vessel.tempK) || vessel.tempK < 150 || vessel.tempK > 2050) {
    errors.push(`Invalid tempK=${vessel.tempK}`);
  }
  if (
    !Number.isFinite(vessel.internalPressureBar) ||
    vessel.internalPressureBar < 0 ||
    vessel.internalPressureBar > 100
  ) {
    errors.push(`Invalid internalPressureBar=${vessel.internalPressureBar}`);
  }
  if (!Number.isFinite(vessel.pickeringFoamMl || 0) || (vessel.pickeringFoamMl || 0) < 0) {
    errors.push(`Invalid pickeringFoamMl=${vessel.pickeringFoamMl}`);
  }
  for (const mapName of ['moles', 'headspaceGasMoles', 'escapedGasMoles']) {
    const map = vessel[mapName];
    if (!map) continue;
    for (const [spId, val] of Object.entries(map)) {
      if (!Number.isFinite(val) || val < 0) {
        errors.push(`Invalid ${mapName}.${spId}=${val}`);
      }
    }
  }
  if (
    !Number.isFinite(vessel.phenBleachFrac || 0) ||
    (vessel.phenBleachFrac || 0) < 0 ||
    (vessel.phenBleachFrac || 0) > 1.0001
  ) {
    errors.push(`Invalid phenBleachFrac=${vessel.phenBleachFrac}`);
  }
  return { valid: errors.length === 0, errors };
}

export const METAL_REDOX_SPECS = {
  K_s: { solidId: 'K_s', formula: 'K', name: 'Potassium', E0: -2.93, maxValence: 1, ionId: 'K_aq', canPassivate: false, noble: false },
  Na_s: { solidId: 'Na_s', formula: 'Na', name: 'Sodium', E0: -2.71, maxValence: 1, ionId: 'Na_aq', canPassivate: false, noble: false },
  Mg_s: { solidId: 'Mg_s', formula: 'Mg', name: 'Magnesium', E0: -2.37, maxValence: 2, ionId: 'Mg2_aq', canPassivate: false, noble: false },
  Al_s: { solidId: 'Al_s', formula: 'Al', name: 'Aluminium', E0: -1.66, maxValence: 3, ionId: 'Al3_aq', canPassivate: true, noble: false },
  Zn_s: { solidId: 'Zn_s', formula: 'Zn', name: 'Zinc', E0: -0.76, maxValence: 2, ionId: 'Zn2_aq', canPassivate: false, noble: false },
  Fe_s: { solidId: 'Fe_s', formula: 'Fe', name: 'Iron', E0: -0.44, maxValence: 3, ionId: 'Fe3_aq', canPassivate: true, noble: false },
  Cu_s: { solidId: 'Cu_s', formula: 'Cu', name: 'Copper', E0: 0.34, maxValence: 2, ionId: 'Cu2_aq', canPassivate: false, noble: false },
  Ag_s: { solidId: 'Ag_s', formula: 'Ag', name: 'Silver', E0: 0.80, maxValence: 1, ionId: 'Ag_aq', canPassivate: false, noble: false },
  Pt_s: { solidId: 'Pt_s', formula: 'Pt', name: 'Platinum', E0: 1.18, maxValence: 4, ionId: 'PtCl6_2_aq', canPassivate: false, noble: true },
  Au_s: { solidId: 'Au_s', formula: 'Au', name: 'Gold', E0: 1.50, maxValence: 3, ionId: 'AuCl4_aq', canPassivate: false, noble: true },
};

export const NITRATE_PRODUCTS = {
  NO2: { id: 'NO2', speciesId: 'NO2_g', formula: 'NO₂', isGas: true, ep: 1, kN: 1, hP: 2 },
  NO: { id: 'NO', speciesId: 'NO_g', formula: 'NO', isGas: true, ep: 3, kN: 1, hP: 4 },
  N2O: { id: 'N2O', speciesId: 'N2O_g', formula: 'N₂O', isGas: true, ep: 8, kN: 2, hP: 10 },
  N2: { id: 'N2', speciesId: 'N2_g', formula: 'N₂', isGas: true, ep: 10, kN: 2, hP: 12 },
  'NH4+': { id: 'NH4+', speciesId: 'NH4_aq', formula: 'NH₄⁺', isGas: false, ep: 8, kN: 1, hP: 10 },
};

/**
 * Classify Sulfuric acid mass fraction & concentration tier:
 * low (<20%), mid (20-65%), conc (65-90%), conc_98 (>=90%).
 */
export function computeSulfuricAcidState(moles) {
  if (!moles) return { nAcidEq: 0, w: 0, tier: 'none' };
  const nH2SO4L = moles.H2SO4_l || 0;
  const nSO4Tot = (moles.SO4_2_aq || 0) + (moles.HSO4_aq || 0);
  const nHTot = (moles.H_aq || 0) + (moles.HSO4_aq || 0);
  const nH2SO4Aq = Math.min(nSO4Tot, nHTot * 0.5);
  const nAcidEq = nH2SO4L + nH2SO4Aq;
  if (nAcidEq <= 1e-8) return { nAcidEq: 0, w: 0, tier: 'none' };
  const mAcidG = nAcidEq * CONSTANTS.M_H2SO4;
  const mWaterG = (moles.H2O_l || 0) * CONSTANTS.M_H2O;
  const denom = mAcidG + mWaterG;
  const w = denom > 1e-9 ? mAcidG / denom : 1.0;
  const tier = w >= 0.90 ? 'conc_98' : w >= 0.65 ? 'conc' : w >= 0.20 ? 'mid' : 'low';
  return { nAcidEq, w, tier };
}

export function hasNitrateOxidizingEnv(moles, liquidVolL) {
  if (!moles || !(liquidVolL > 1e-6)) return false;
  return (moles.H_aq || 0) / liquidVolL > 0.01 && (moles.NO3_aq || 0) / liquidVolL > 0.01;
}

export function selectNitrateReductionMix(metalSpec, wHNO3, cAcid) {
  if (!metalSpec || metalSpec.noble || metalSpec.E0 > 1.2) return [];
  const isStrongMetal = metalSpec.E0 < -0.7;
  if (wHNO3 >= 0.60 || cAcid >= 10.0) {
    return [{ product: NITRATE_PRODUCTS.NO2, weight: 1.0 }];
  }
  if (cAcid >= 4.0 || wHNO3 >= 0.30) {
    const fConc = Math.max(0, Math.min(1, Math.max((cAcid - 4.0) / 6.0, (wHNO3 - 0.30) / 0.30)));
    if (!isStrongMetal) {
      return [
        { product: NITRATE_PRODUCTS.NO2, weight: fConc },
        { product: NITRATE_PRODUCTS.NO, weight: 1 - fConc },
      ].filter((x) => x.weight > 0.01);
    }
    const rem = 1 - fConc;
    return [
      { product: NITRATE_PRODUCTS.NO2, weight: fConc },
      { product: NITRATE_PRODUCTS.NO, weight: 0.45 * rem },
      { product: NITRATE_PRODUCTS.N2O, weight: 0.40 * rem },
      { product: NITRATE_PRODUCTS.N2, weight: 0.15 * rem },
    ].filter((x) => x.weight > 0.01);
  }
  if (wHNO3 >= 0.10 || cAcid >= 1.0) {
    if (!isStrongMetal) {
      return [{ product: NITRATE_PRODUCTS.NO, weight: 1.0 }];
    }
    return [
      { product: NITRATE_PRODUCTS.NO, weight: 0.45 },
      { product: NITRATE_PRODUCTS.N2O, weight: 0.40 },
      { product: NITRATE_PRODUCTS.N2, weight: 0.15 },
    ];
  }
  return isStrongMetal
    ? [{ product: NITRATE_PRODUCTS['NH4+'], weight: 1.0 }]
    : [{ product: NITRATE_PRODUCTS.NO, weight: 1.0 }];
}

export function solveMetalNitrateStep(metalMolesAvailable, n, hPlusMoles, no3MinusMoles, product) {
  if (!(metalMolesAvailable > 0) || !(hPlusMoles > 0) || !(no3MinusMoles > 0) || !product || !(n > 0)) {
    return {
      reactedMetal: 0,
      deltaMetal: 0,
      deltaMetalIon: 0,
      deltaHPlus: 0,
      deltaNO3Minus: 0,
      deltaProduct: 0,
      deltaH2O: 0,
    };
  }
  const prodPerMetal = n / product.ep;
  const hPlusPerMetal = prodPerMetal * product.hP;
  const no3RedoxPerMetal = prodPerMetal * product.kN;
  const reactedMetal = Math.max(
    0,
    Math.min(
      metalMolesAvailable,
      hPlusMoles / hPlusPerMetal,
      no3MinusMoles / no3RedoxPerMetal
    )
  );
  const dProd = reactedMetal * prodPerMetal;
  return {
    reactedMetal,
    deltaMetal: -reactedMetal,
    deltaMetalIon: +reactedMetal,
    deltaHPlus: -(reactedMetal * hPlusPerMetal),
    deltaNO3Minus: -(reactedMetal * no3RedoxPerMetal),
    deltaProduct: +dProd,
    deltaH2O: +(reactedMetal * (hPlusPerMetal - (product.id === 'NH4+' ? 4 * prodPerMetal : 0)) / 2),
  };
}

function formatNitrateEquation(metalSpec, product) {
  const gcd2 = (a, b) => (b === 0 ? a : gcd2(b, a % b));
  const n = metalSpec.maxValence;
  const div = gcd2(n, product.ep);
  const mCoeff = product.ep / div;
  const pCoeff = n / div;
  const hCoeff = pCoeff * product.hP;
  const nCoeff = pCoeff * product.kN;
  const wCoeff = (hCoeff - (product.id === 'NH4+' ? 4 * pCoeff : 0)) / 2;
  const gDiv = [mCoeff, hCoeff, nCoeff, pCoeff, wCoeff].reduce(gcd2);
  const cM = mCoeff / gDiv;
  const cH = hCoeff / gDiv;
  const cN = nCoeff / gDiv;
  const cP = pCoeff / gDiv;
  const cW = wCoeff / gDiv;
  const fIon = SPECIES[metalSpec.ionId]?.formula || `${metalSpec.formula}${n > 1 ? `${n}⁺` : '⁺'}`;
  const mStr = cM > 1 ? `${cM}${metalSpec.formula}(s)` : `${metalSpec.formula}(s)`;
  const mOutStr = cM > 1 ? `${cM}${fIon}(aq)` : `${fIon}(aq)`;
  const pTag = product.isGas ? `${product.formula}(g)↑` : `${product.formula}(aq)`;
  const pStr = cP > 1 ? `${cP}${pTag}` : pTag;
  const wStr = cW > 1 ? `${cW}H₂O(l)` : 'H₂O(l)';
  return `${mStr} + ${cH}H⁺ + ${cN}NO₃⁻ → ${mOutStr} + ${pStr} + ${wStr}`;
}

function stepMetalNitrateSolver(vessel, liquidVolL, dt, activeReactions, gasProduced) {
  const moles = vessel.moles;
  if (!hasNitrateOxidizingEnv(moles, liquidVolL) || (moles.H2O_l || 0) <= 1e-7) return 0;
  const iceMob = computeIceMobilityFactor(vessel);
  if (iceMob <= 0) return 0;

  const T = vessel.tempK;
  const cH = (moles.H_aq || 0) / liquidVolL;
  const cNO3 = (moles.NO3_aq || 0) / liquidVolL;
  const cCl = (moles.Cl_aq || 0) / liquidVolL;
  const nAcid = Math.min(moles.H_aq || 0, moles.NO3_aq || 0);
  const cAcid = nAcid / liquidVolL;
  const mHNO3 = nAcid * CONSTANTS.M_HNO3;
  const mWater = (moles.H2O_l || 0) * CONSTANTS.M_H2O;
  const wHNO3 = mHNO3 / Math.max(1e-9, mHNO3 + mWater);
  const stirBoost = vessel.stirTimer > 0 ? 3.0 : 1.0;

  let totalHeatJ = 0;

  for (const metalSpec of Object.values(METAL_REDOX_SPECS)) {
    const solidId = metalSpec.solidId;
    const nSolid = moles[solidId] || 0;
    if (nSolid <= 1e-10 || metalSpec.noble || !SPECIES[metalSpec.ionId]) continue;
    // Let aqua regia reactions handle Cu/Ag when concentrated Cl- >= 4.0 M is present
    if (cCl >= 4.0 && (solidId === 'Cu_s' || solidId === 'Ag_s')) continue;

    if (metalSpec.canPassivate) {
      if ((wHNO3 >= 0.60 || cAcid >= 10.0) && T < 323.15) {
        if (solidId === 'Fe_s') vessel.fePassivated = true;
        if (solidId === 'Al_s') vessel.alPassivated = true;
        continue;
      }
      if (solidId === 'Fe_s') vessel.fePassivated = false;
      if (solidId === 'Al_s') vessel.alPassivated = false;
    }

    const mix = selectNitrateReductionMix(metalSpec, wHNO3, cAcid);
    if (!mix.length) continue;

    const pCount = vessel.particleCounts?.[solidId] ?? 8;
    const isFine = Boolean(vessel.groundPowderMap?.[solidId]) || pCount >= 18;
    const area = computeSolidSurfaceAreaM2(solidId, nSolid, isFine ? Math.max(pCount, 60) : pCount);
    const fineBoost = isFine ? 1.85 : 1.0;
    const baseK298 =
      metalSpec.E0 <= -2.0 ? 2.4 : metalSpec.E0 <= -0.7 ? 0.85 : metalSpec.E0 <= 0 ? 0.55 : metalSpec.E0 <= 0.4 ? 0.52 : 0.36;
    const eaJ = solidId === 'Ag_s' ? 32000 : 28000;
    const k = baseK298 * arrheniusFactor(eaJ, T);
    const drive = Math.min(5.0, cH / 2.2) * Math.min(4.0, cNO3 / 1.8) * (0.45 + 0.55 * Math.min(1, cAcid / 1.5));
    const rateMetal = k * area * fineBoost * Math.max(0.025, drive) * stirBoost * iceMob * 4.5;
    const targetMetal = Math.min(nSolid, rateMetal * dt);
    if (targetMetal <= 1e-14) continue;

    let reactedTotal = 0;
    let dominantProduct = mix[0].product;
    let maxProdYield = -1;

    for (const part of mix) {
      const nHAvail = moles.H_aq || 0;
      const nNO3Avail = moles.NO3_aq || 0;
      const nMAvail = Math.min(moles[solidId] || 0, targetMetal * part.weight);
      if (nMAvail <= 1e-15 || nHAvail <= 1e-14 || nNO3Avail <= 1e-14) continue;

      const step = solveMetalNitrateStep(nMAvail, metalSpec.maxValence, nHAvail, nNO3Avail, part.product);
      if (step.reactedMetal <= 1e-15) continue;

      moles[solidId] = Math.max(0, (moles[solidId] || 0) + step.deltaMetal);
      if (moles[solidId] < 1e-13) delete moles[solidId];
      moles[metalSpec.ionId] = (moles[metalSpec.ionId] || 0) + step.deltaMetalIon;
      moles.H_aq = Math.max(0, (moles.H_aq || 0) + step.deltaHPlus);
      if (moles.H_aq < 1e-13) delete moles.H_aq;
      moles.NO3_aq = Math.max(0, (moles.NO3_aq || 0) + step.deltaNO3Minus);
      if (moles.NO3_aq < 1e-13) delete moles.NO3_aq;
      moles.H2O_l = (moles.H2O_l || 0) + step.deltaH2O;
      if (part.product.isGas) {
        gasProduced[part.product.speciesId] = (gasProduced[part.product.speciesId] || 0) + step.deltaProduct;
      } else {
        moles[part.product.speciesId] = (moles[part.product.speciesId] || 0) + step.deltaProduct;
      }
      reactedTotal += step.reactedMetal;
      if (step.deltaProduct > maxProdYield) {
        maxProdYield = step.deltaProduct;
        dominantProduct = part.product;
      }
      const heatPerMolMetal = metalSpec.maxValence * 115000 + (part.product.id === 'NH4+' ? 85000 : 0);
      totalHeatJ += heatPerMolMetal * step.reactedMetal;
    }

    if (reactedTotal > 1e-11 && activeReactions) {
      const prodList = mix.map((m) => m.product.formula).join(' + ');
      activeReactions.push({
        id: `nitrate_redox_${metalSpec.formula.toLowerCase()}_${dominantProduct.id.toLowerCase().replace('+', 'p')}`,
        equation: formatNitrateEquation(metalSpec, dominantProduct),
        nameVi: `${metalSpec.name} phản ứng trong môi trường H⁺ + NO₃⁻ (tạo ${prodList})`,
        nameEn: `${metalSpec.name} oxidation in H⁺ + NO₃⁻ medium (yielding ${prodList})`,
        descVi: `Ion H⁺ và NO₃⁻ oxi hóa ${metalSpec.name} lên hóa trị cực đại ${SPECIES[metalSpec.ionId]?.formula} không giải phóng H₂.`,
        descEn: `Combined H⁺ + NO₃⁻ oxidizes ${metalSpec.name} to ${SPECIES[metalSpec.ionId]?.formula} without evolving H₂ gas.`,
        rateMolS: reactedTotal / Math.max(1e-4, dt),
        vigorousGas: dominantProduct.isGas,
        dXi: reactedTotal,
      });
    }
  }

  return totalHeatJ;
}

/**
 * Sulfuric Acid Concentration-Tier Redox Solver for Zn, Fe, Cu across mid (20-65%), conc (65-90%), conc_98 (>=90%).
 * - Fe passivates in cold conc H2SO4 (>= 65%, T < 50 °C) and reacts on heating yielding Fe3+ + SO2.
 * - Zn yields SO2 in conc/hot H2SO4 and blends H2/SO2 (+ trace S/H2S when hot) in mid 20-65% tier.
 * - Cu dissolves in hot conc H2SO4 (>= 65%, T >= 70 °C) yielding Cu2+ + SO2.
 */
function stepMetalSulfuricSolver(vessel, liquidVolL, dt, activeReactions, gasProduced) {
  const moles = vessel.moles;
  if (liquidVolL <= 1e-6 || hasNitrateOxidizingEnv(moles, liquidVolL)) return 0;
  const sulf = computeSulfuricAcidState(moles);
  if (sulf.nAcidEq <= 1e-8 || sulf.tier === 'low') return 0;
  const iceMob = computeIceMobilityFactor(vessel);
  if (iceMob <= 0) return 0;

  const T = vessel.tempK;
  const stirBoost = vessel.stirTimer > 0 ? 2.6 : 1.0;
  // Cold 100% anhydrous H2SO4 (~>=98.5% w/w, <50 C) lacks mobile H3O+ and coats Zn/Mg/Fe/Al/Cu with insoluble sulfates
  const isColdAnhydrous = sulf.w >= 0.985 && T < 323.15;
  let totalHeatJ = 0;

  // Consume nEq mol of H2SO4 equivalents from molecular H2SO4_l first, then aqueous H+ + sulfate
  const consumeH2SO4Eq = (reqEq) => {
    let rem = reqEq;
    const nL = moles.H2SO4_l || 0;
    if (nL > 1e-13 && rem > 0) {
      const takeL = Math.min(nL, rem);
      moles.H2SO4_l = nL - takeL;
      if (moles.H2SO4_l < 1e-14) delete moles.H2SO4_l;
      rem -= takeL;
    }
    if (rem > 1e-13) {
      const availAq = Math.min((moles.SO4_2_aq || 0) + (moles.HSO4_aq || 0), ((moles.H_aq || 0) + (moles.HSO4_aq || 0)) * 0.5);
      const takeAq = Math.min(availAq, rem);
      if (takeAq > 1e-13) {
        // Draw HSO4_aq first (supplies 1 H+ + 1 SO4), plus H_aq + SO4_2_aq for remainder
        let needH = 2 * takeAq;
        let needS = takeAq;
        const takeHSO4 = Math.min(moles.HSO4_aq || 0, needH, needS);
        if (takeHSO4 > 1e-14) {
          moles.HSO4_aq = (moles.HSO4_aq || 0) - takeHSO4;
          if (moles.HSO4_aq < 1e-14) delete moles.HSO4_aq;
          needH -= takeHSO4;
          needS -= takeHSO4;
        }
        if (needH > 1e-14) {
          moles.H_aq = Math.max(0, (moles.H_aq || 0) - needH);
          if (moles.H_aq < 1e-14) delete moles.H_aq;
        }
        if (needS > 1e-14) {
          moles.SO4_2_aq = Math.max(0, (moles.SO4_2_aq || 0) - needS);
          if (moles.SO4_2_aq < 1e-14) delete moles.SO4_2_aq;
        }
        rem -= takeAq;
      }
    }
    return reqEq - rem;
  };

  const getAvailAcidEq = () => {
    const nL = moles.H2SO4_l || 0;
    const availAq = Math.min((moles.SO4_2_aq || 0) + (moles.HSO4_aq || 0), ((moles.H_aq || 0) + (moles.HSO4_aq || 0)) * 0.5);
    return nL + availAq;
  };

  // 1. Iron (Fe_s) in conc/hot H2SO4
  const nFe = moles.Fe_s || 0;
  if (nFe > 1e-10) {
    if (sulf.w >= 0.65 && T < 323.15) {
      vessel.fePassivated = true;
    } else if (sulf.w >= 0.65 && T >= 323.15) {
      vessel.fePassivated = false;
      const pCount = vessel.particleCounts?.Fe_s ?? 4;
      const isFine = Boolean(vessel.groundPowderMap?.Fe_s) || pCount >= 18;
      const area = computeSolidSurfaceAreaM2('Fe_s', nFe, isFine ? Math.max(pCount, 60) : pCount);
      const k = 0.28 * arrheniusFactor(30000, T) * (isFine ? 1.85 : 1.0) * stirBoost * iceMob;
      const dFe = Math.min(nFe, getAvailAcidEq() / 3, k * Math.max(1e-5, area) * 3.8 * dt);
      if (dFe > 1e-12) {
        const usedAcid = consumeH2SO4Eq(3 * dFe);
        const effFe = usedAcid / 3;
        moles.Fe_s = Math.max(0, nFe - effFe);
        if (moles.Fe_s < 1e-13) delete moles.Fe_s;
        moles.Fe3_aq = (moles.Fe3_aq || 0) + effFe;
        moles.SO4_2_aq = (moles.SO4_2_aq || 0) + 1.5 * effFe;
        moles.H2O_l = (moles.H2O_l || 0) + 3 * effFe;
        gasProduced.SO2_g = (gasProduced.SO2_g || 0) + 1.5 * effFe;
        totalHeatJ += 230000 * effFe;
        activeReactions.push({
          id: 'fe_h2so4_conc_hot',
          equation: '2Fe(s) + 6H₂SO₄(đặc, nóng) → Fe₂(SO₄)₃ + 3SO₂(g)↑ + 6H₂O(l)',
          nameVi: 'Iron tác dụng với H₂SO₄ đặc, nóng (tạo Fe³⁺ + SO₂↑)',
          nameEn: 'Iron oxidation in hot concentrated H₂SO₄ (Fe³⁺ + SO₂↑)',
          descVi: 'Nhiệt độ ≥ 50 °C phá vỡ lớp thụ động trên Iron, tạo muối Fe₂(SO₄)₃ vàng nâu và giải phóng khí SO₂ mùi hắc.',
          descEn: 'Heating above 50 °C breaks Iron passivation yielding amber Fe³⁺ sulfate and pungent SO₂ gas.',
          rateMolS: effFe / Math.max(1e-4, dt),
          vigorousGas: true,
          dXi: effFe,
        });
      }
    }
  }

  // 2. Zinc (Zn_s) across mid (20-65% -> SO2 + trace S/H2S) & conc/conc_98 (>=65% -> SO2); passivated in cold 100% anhydrous H2SO4
  const nZn = moles.Zn_s || 0;
  if (nZn > 1e-10 && !isColdAnhydrous) {
    const fOx = sulf.w >= 0.65 ? 1.0 : (sulf.w - 0.20) / 0.45;
    const pCount = vessel.particleCounts?.Zn_s ?? 8;
    const area = computeSolidSurfaceAreaM2('Zn_s', nZn, pCount);
    const k = (sulf.w >= 0.65 ? 0.34 : 0.22) * arrheniusFactor(28000, T) * stirBoost * iceMob * fOx;
    const dZn = Math.min(nZn, getAvailAcidEq() / 2.2, k * Math.max(1e-5, area) * 4.2 * dt);
    if (dZn > 1e-12) {
      // Mid hot transition (20-65%, T >= 50 °C) yields trace S(s) & H2S(g) alongside dominant SO2(g)
      const hasMidTrace = sulf.tier === 'mid' && T >= 323.15;
      const fracH2S = hasMidTrace ? 0.08 : 0;
      const fracS = hasMidTrace ? 0.07 : 0;
      const fracSO2 = 1 - fracH2S - fracS;
      const acidNeeded = dZn * (2 * fracSO2 + (4 / 3) * fracS + 1.25 * fracH2S);
      const usedAcid = consumeH2SO4Eq(acidNeeded);
      const scale = acidNeeded > 0 ? usedAcid / acidNeeded : 0;
      const effZn = dZn * scale;
      if (effZn > 1e-13) {
        moles.Zn_s = Math.max(0, nZn - effZn);
        if (moles.Zn_s < 1e-13) delete moles.Zn_s;
        moles.Zn2_aq = (moles.Zn2_aq || 0) + effZn;
        moles.SO4_2_aq = (moles.SO4_2_aq || 0) + effZn;
        moles.H2O_l = (moles.H2O_l || 0) + effZn * (2 * fracSO2 + (4 / 3) * fracS + fracH2S);
        if (fracSO2 > 0) gasProduced.SO2_g = (gasProduced.SO2_g || 0) + effZn * fracSO2;
        if (fracS > 0) moles.S_s = (moles.S_s || 0) + (effZn * fracS) / 3;
        if (fracH2S > 0) gasProduced.H2S_g = (gasProduced.H2S_g || 0) + effZn * fracH2S * 0.25;
        totalHeatJ += 215000 * effZn;
        activeReactions.push({
          id: 'zn_h2so4_conc',
          equation: hasMidTrace
            ? 'Zn(s) + 2H₂SO₄ → ZnSO₄ + SO₂(g)↑ + [vết S↓ / H₂S↑] + 2H₂O'
            : 'Zn(s) + 2H₂SO₄(đặc) → ZnSO₄ + SO₂(g)↑ + 2H₂O(l)',
          nameVi: hasMidTrace ? 'Zinc + H₂SO₄ trung bình nóng (SO₂ + vết S / H₂S)' : 'Zinc khử H₂SO₄ đặc sinh khí SO₂',
          nameEn: hasMidTrace ? 'Zinc in warm mid-conc. H₂SO₄ (SO₂ + trace S / H₂S)' : 'Zinc reduction of conc. H₂SO₄ to SO₂',
          descVi: 'Zinc khử H₂SO₄ đặc tạo dung dịch/muối ZnSO₄ và giải phóng khí SO₂ mùi hắc.',
          descEn: 'Metallic Zinc reduces concentrated Sulfuric acid evolving pungent SO₂ gas and Zn²⁺.',
          rateMolS: effZn / Math.max(1e-4, dt),
          vigorousGas: true,
          dXi: effZn,
        });
      }
    }
  }

  // 3. Copper (Cu_s) in hot conc H2SO4 (>= 65%, T >= 70 °C)
  const nCu = moles.Cu_s || 0;
  if (nCu > 1e-10 && sulf.w >= 0.65 && T >= 343.15) {
    const pCount = vessel.particleCounts?.Cu_s ?? 8;
    const area = computeSolidSurfaceAreaM2('Cu_s', nCu, pCount);
    const k = 0.24 * arrheniusFactor(32000, T - 343.15 + CONSTANTS.T_STD_K) * stirBoost * iceMob;
    const dCu = Math.min(nCu, getAvailAcidEq() / 2, k * Math.max(1e-5, area) * 3.6 * dt);
    if (dCu > 1e-12) {
      const usedAcid = consumeH2SO4Eq(2 * dCu);
      const effCu = usedAcid / 2;
      moles.Cu_s = Math.max(0, nCu - effCu);
      if (moles.Cu_s < 1e-13) delete moles.Cu_s;
      moles.Cu2_aq = (moles.Cu2_aq || 0) + effCu;
      moles.SO4_2_aq = (moles.SO4_2_aq || 0) + effCu;
      moles.H2O_l = (moles.H2O_l || 0) + 2 * effCu;
      gasProduced.SO2_g = (gasProduced.SO2_g || 0) + effCu;
      totalHeatJ += 118000 * effCu;
      activeReactions.push({
        id: 'cu_h2so4_conc_hot',
        equation: 'Cu(s) + 2H₂SO₄(đặc, nóng) → CuSO₄ + SO₂(g)↑ + 2H₂O(l)',
        nameVi: 'Copper phản ứng với H₂SO₄ đặc, nóng tạo Cu²⁺ xanh lam + SO₂↑',
        nameEn: 'Copper oxidation in hot concentrated H₂SO₄ (blue Cu²⁺ + SO₂↑)',
        descVi: 'Đun nóng (≥ 70 °C), H₂SO₄ đặc oxi hóa Copper thành dung dịch xanh lam Cu²⁺ và khí SO₂.',
        descEn: 'Heating above 70 °C enables conc. H₂SO₄ to oxidize Copper yielding blue Cu²⁺ and SO₂ gas.',
        rateMolS: effCu / Math.max(1e-4, dt),
        vigorousGas: true,
        dXi: effCu,
      });
    }
  }

  // 4. Aluminium (Al_s): passivates in cold conc H2SO4 (>= 65%, T < 50 °C); reacts on heating -> Al3+ + SO2
  const nAl = moles.Al_s || 0;
  if (nAl > 1e-10) {
    if (sulf.w >= 0.65 && T < 323.15) {
      vessel.alPassivated = true;
    } else if (sulf.w >= 0.65 && T >= 323.15) {
      vessel.alPassivated = false;
      const pCount = vessel.particleCounts?.Al_s ?? 6;
      const area = computeSolidSurfaceAreaM2('Al_s', nAl, pCount);
      const k = 0.34 * arrheniusFactor(30000, T) * stirBoost * iceMob;
      const dAl = Math.min(nAl, getAvailAcidEq() / 3, k * Math.max(1e-5, area) * 4.0 * dt);
      if (dAl > 1e-12) {
        const usedAcid = consumeH2SO4Eq(3 * dAl);
        const effAl = usedAcid / 3;
        moles.Al_s = Math.max(0, nAl - effAl);
        if (moles.Al_s < 1e-13) delete moles.Al_s;
        moles.Al3_aq = (moles.Al3_aq || 0) + effAl;
        moles.SO4_2_aq = (moles.SO4_2_aq || 0) + 1.5 * effAl;
        moles.H2O_l = (moles.H2O_l || 0) + 3 * effAl;
        gasProduced.SO2_g = (gasProduced.SO2_g || 0) + 1.5 * effAl;
        totalHeatJ += 360000 * effAl;
        activeReactions.push({
          id: 'al_h2so4_conc_hot',
          equation: '2Al(s) + 6H₂SO₄(đặc, nóng) → Al₂(SO₄)₃ + 3SO₂(g)↑ + 6H₂O(l)',
          nameVi: 'Aluminium tác dụng với H₂SO₄ đặc, nóng tạo Al³⁺ + SO₂↑ (thụ động khi nguội!)',
          nameEn: 'Aluminium oxidation in hot conc. H₂SO₄ (passivated when cold)',
          descVi: 'Al thụ động hóa trong H₂SO₄ đặc nguội; khi đun nóng (≥ 50 °C) tan mạnh giải phóng khí SO₂ mùi hắc.',
          descEn: 'Aluminium passivates in cold conc. H₂SO₄; heating above 50 °C dissolves it releasing pungent SO₂.',
          rateMolS: effAl / Math.max(1e-4, dt),
          vigorousGas: true,
          dXi: effAl,
        });
      }
    }
  }

  // 5. Magnesium (Mg_s) across mid (20-65% -> SO2 + trace S/H2S) & conc/conc_98 (>=65% -> SO2); passivated in cold 100% anhydrous H2SO4
  const nMg = moles.Mg_s || 0;
  if (nMg > 1e-10 && !isColdAnhydrous) {
    const fOxMg = sulf.w >= 0.65 ? 1.0 : (sulf.w - 0.20) / 0.45;
    const pCount = vessel.particleCounts?.Mg_s ?? 6;
    const area = computeSolidSurfaceAreaM2('Mg_s', nMg, pCount);
    const k = (sulf.w >= 0.65 ? 0.46 : 0.30) * arrheniusFactor(26000, T) * stirBoost * iceMob * fOxMg;
    const dMg = Math.min(nMg, getAvailAcidEq() / 2.2, k * Math.max(1e-5, area) * 4.5 * dt);
    if (dMg > 1e-12) {
      const hasMidTrace = sulf.tier === 'mid' && T >= 323.15;
      const fracH2S = hasMidTrace ? 0.10 : 0;
      const fracS = hasMidTrace ? 0.08 : 0;
      const fracSO2 = 1 - fracH2S - fracS;
      const acidNeeded = dMg * (2 * fracSO2 + (4 / 3) * fracS + 1.25 * fracH2S);
      const usedAcid = consumeH2SO4Eq(acidNeeded);
      const effMg = dMg * (acidNeeded > 0 ? usedAcid / acidNeeded : 0);
      if (effMg > 1e-13) {
        moles.Mg_s = Math.max(0, nMg - effMg);
        if (moles.Mg_s < 1e-13) delete moles.Mg_s;
        moles.Mg2_aq = (moles.Mg2_aq || 0) + effMg;
        moles.SO4_2_aq = (moles.SO4_2_aq || 0) + effMg;
        moles.H2O_l = (moles.H2O_l || 0) + effMg * (2 * fracSO2 + (4 / 3) * fracS + fracH2S);
        if (fracSO2 > 0) gasProduced.SO2_g = (gasProduced.SO2_g || 0) + effMg * fracSO2;
        if (fracS > 0) moles.S_s = (moles.S_s || 0) + (effMg * fracS) / 3;
        if (fracH2S > 0) gasProduced.H2S_g = (gasProduced.H2S_g || 0) + effMg * fracH2S * 0.25;
        totalHeatJ += 380000 * effMg;
        activeReactions.push({
          id: 'mg_h2so4_conc',
          equation: 'Mg(s) + 2H₂SO₄(đặc) → MgSO₄ + SO₂(g)↑ + 2H₂O(l)',
          nameVi: 'Magnesium khử H₂SO₄ đặc tạo Mg²⁺ + SO₂↑ (kèm S / H₂S ở nồng độ trung bình nóng)',
          nameEn: 'Magnesium reduction of conc. H₂SO₄ yielding Mg²⁺ + SO₂↑',
          descVi: 'Mg khử mạnh H₂SO₄ đặc sinh khí SO₂ (và vết S vàng / H₂S mùi trứng thối khi đun nóng ở vùng nồng độ 20–65%).',
          descEn: 'Magnesium reduces conc. H₂SO₄ to pungent SO₂ (plus trace S/H₂S in warm 20–65% acid).',
          rateMolS: effMg / Math.max(1e-4, dt),
          vigorousGas: true,
          dXi: effMg,
        });
      }
    }
  }

  // 6. Silver (Ag_s) in hot conc. / anhydrous H2SO4 (>= 80%, T >= 90 C -> Ag2SO4↓ + SO2↑ + 2H2O)
  const nAg = moles.Ag_s || 0;
  if (nAg > 1e-10 && sulf.w >= 0.80 && T >= 363.15) {
    const pCount = vessel.particleCounts?.Ag_s ?? 6;
    const area = computeSolidSurfaceAreaM2('Ag_s', nAg, pCount);
    const k = 0.55 * arrheniusFactor(34000, T - 363.15 + CONSTANTS.T_STD_K) * stirBoost * iceMob;
    const dAg = Math.min(nAg, getAvailAcidEq(), k * Math.max(1e-5, area) * 3.2 * dt);
    if (dAg > 1e-12) {
      const usedAcid = consumeH2SO4Eq(dAg);
      if (usedAcid > 1e-12) {
        moles.Ag_s = Math.max(0, nAg - usedAcid);
        if (moles.Ag_s < 1e-13) delete moles.Ag_s;
        moles.Ag2SO4_s = (moles.Ag2SO4_s || 0) + 0.5 * usedAcid;
        moles.H2O_l = (moles.H2O_l || 0) + usedAcid;
        gasProduced.SO2_g = (gasProduced.SO2_g || 0) + 0.5 * usedAcid;
        totalHeatJ += 45000 * usedAcid;
        activeReactions.push({
          id: 'ag_h2so4_conc_hot',
          equation: '2Ag(s) + 2H₂SO₄(đặc, nóng ≥ 90 °C) → Ag₂SO₄(s)↓ + SO₂(g)↑ + 2H₂O(l)',
          nameVi: 'Silver tác dụng với H₂SO₄ đặc nóng (≥ 90 °C) tạo Ag₂SO₄↓ và SO₂↑',
          nameEn: 'Silver oxidized by hot conc. H₂SO₄ (≥ 90 °C) yielding Ag₂SO₄↓ + SO₂↑',
          descVi: 'Khi đun nóng mạnh (≥ 90 °C), H₂SO₄ đặc/khan oxi hóa được cả Silver giải phóng SO₂.',
          descEn: 'Strongly heated conc./anhydrous H₂SO₄ oxidizes Silver releasing pungent SO₂.',
          rateMolS: (usedAcid * 0.5) / Math.max(1e-4, dt),
          vigorousGas: true,
          dXi: usedAcid * 0.5,
        });
      }
    }
  }

  return totalHeatJ;
}

/**
 * Shared two-temperature coupled alkali metal (Na / K) droplet thermal balance, local ice melting,
 * Marangoni H2-jetting wake trail & H2 auto-ignition / hazard check.
 */
function updateAlkaliDropletBalance(vessel, spec, solidVolMl, strat, liquidVolL, dt, cfg, heatGenJ, h2ProducedMol) {
  const nLeft = vessel.moles[cfg.speciesId] || 0;
  const hasIce = (vessel.moles.H2O_s || 0) > 1e-6;
  if (nLeft <= 1e-10 || (liquidVolL <= 1e-6 && !hasIce)) {
    vessel[cfg.tempKey] = null;
    vessel[cfg.pinnedKey] = false;
    vessel[cfg.ignitedKey] = false;
    vessel[cfg.localH2Key] = 0;
    if (Array.isArray(vessel[cfg.wakeKey]) && vessel[cfg.wakeKey].length > 0) {
      for (const wp of vessel[cfg.wakeKey]) wp.age += dt;
      vessel[cfg.wakeKey] = vessel[cfg.wakeKey].filter((wp) => wp.age < wp.maxLife);
    }
    return { event: null, reactionHeatDeltaJ: heatGenJ };
  }

  const tPrev = vessel[cfg.tempKey] ?? vessel.tempK;
  const pCount = vessel.particleCounts?.[cfg.speciesId] ?? 1;
  const areaCm2 = Math.max(0.04, computeSolidSurfaceAreaM2(cfg.speciesId, nLeft, pCount) * 1e4);
  const totMl = strat.totalLiqMl + solidVolMl;
  const areaSurfCm2 = spec?.geometry
    ? Math.max(0.5, spec.geometry.getLiquidState(totMl).surfaceAreaCm2)
    : spec?.surfaceAreaCm2 || 25.0;

  const effLiqL = Math.max(1e-5, liquidVolL);
  const cAlkOH = (vessel.moles.OH_aq || 0) / effLiqL;
  const cH = (vessel.moles.H_aq || 0) / effLiqL;
  const cAg = (vessel.moles.Ag_aq || 0) / effLiqL;
  const nW = vessel.moles.H2O_l || 0;
  const nE = vessel.moles.C2H5OH_l || 0;
  const xEtOH = nE / Math.max(1e-9, nW + nE);
  const massG = nLeft * SPECIES[cfg.speciesId].molarMass;
  const isDirectHazard = liquidVolL > 1e-5 && (cH >= 6.0 || cAg >= 1.5 || (vessel.moles.H2SO4_l || 0) > 1e-4) && massG >= cfg.minHazardG;

  const effFootprint = Math.min(Math.max(areaCm2, 0.08), 6.0);
  const mobilityFactor = 0.28 + 0.72 * (1 - Math.exp(-0.14 * (areaSurfCm2 / effFootprint)));
  const pinHeatLoss = areaSurfCm2 < 15.0 ? 0.42 : 1.0;
  const viscosityDamping = 1 / (1 + 0.55 * cAlkOH + 0.35 * cAlkOH * cAlkOH);
  const hLiquid = 11.5 * mobilityFactor * pinHeatLoss * viscosityDamping;
  const iceWetBlend = hasIce ? Math.min(1, nW / 0.04) : 1.0;
  const hEff = 0.08 * (1 - iceWetBlend) + hLiquid * iceWetBlend;
  const condWK = Math.max(1e-4, hEff * areaCm2);

  const mSafeG = Math.max(1e-4, massG);
  const cMet = Math.max(1e-4, mSafeG * (tPrev >= cfg.meltTempK ? cfg.cpMolten : cfg.cpSolid));
  const qGenW = heatGenJ / Math.max(1e-6, dt);
  const tEq = Math.min(cfg.tEqCap, vessel.tempK + qGenW / condWK);
  const alpha = condWK / cMet;
  let newT = Math.max(200, Math.min(cfg.tEqCap, tEq + (tPrev - tEq) * Math.exp(-alpha * dt)));
  if (xEtOH > 0.35) {
    newT = Math.min(newT, 360.0);
  }

  let localMeltHeatUsedJ = 0;
  if (hasIce && newT > CONSTANTS.T_FREEZE_WATER_K && heatGenJ > 0) {
    const maxMeltFilm = Math.min(vessel.moles.H2O_s || 0, Math.max(0.015, nLeft * 6.0));
    if (nW < maxMeltFilm) {
      const availMeltJ = heatGenJ * 0.55;
      const dMelt = Math.min(vessel.moles.H2O_s || 0, maxMeltFilm - nW, availMeltJ / CONSTANTS.DELTA_H_FUS_WATER_J);
      if (dMelt > 1e-10) {
        vessel.moles.H2O_s -= dMelt;
        if (vessel.moles.H2O_s < 1e-12) delete vessel.moles.H2O_s;
        vessel.moles.H2O_l = nW + dMelt;
        localMeltHeatUsedJ = dMelt * CONSTANTS.DELTA_H_FUS_WATER_J;
      }
    }
  }

  const reactionHeatDeltaJ = Math.max(0, heatGenJ - localMeltHeatUsedJ - cMet * (newT - tPrev));

  const kEsc = 0.08;
  const escRate = kEsc * areaSurfCm2;
  const dec = Math.exp(-escRate * dt);
  const localIn = escRate * dt > 1e-6 ? h2ProducedMol * ((1 - dec) / (escRate * dt)) : h2ProducedMol;
  const newLocalH2 = Math.max(0, (vessel[cfg.localH2Key] || 0) * dec + localIn);

  vessel[cfg.tempKey] = newT;
  vessel[cfg.pinnedKey] = areaSurfCm2 < 15.0 && xEtOH <= 0.35;
  vessel[cfg.ignitedKey] = (newT >= cfg.igniteTempK || (cfg.instantIgniteOnH2 && h2ProducedMol > 1e-9 && nW > 1e-4)) && xEtOH <= 0.35;
  vessel[cfg.localH2Key] = newLocalH2;

  vessel[cfg.wakeKey] = vessel[cfg.wakeKey] || [];
  for (const wp of vessel[cfg.wakeKey]) wp.age += dt;
  vessel[cfg.wakeKey] = vessel[cfg.wakeKey].filter((wp) => wp.age < wp.maxLife);
  if (liquidVolL > 1e-6 && newT >= cfg.skateMinK) {
    const spanScale = (vessel[cfg.pinnedKey] ? 0.38 : Math.min(2.8, Math.max(0.85, Math.sqrt(areaSurfCm2 / 25.0)))) * cfg.motionMult;
    if (typeof vessel[cfg.velKey] !== 'number' || Math.abs(vessel[cfg.velKey]) < 0.25) {
      vessel[cfg.velKey] = (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 0.9);
    }
    if (Math.random() < 4.5 * dt) {
      vessel[cfg.velKey] = (Math.random() < 0.5 ? -1 : 1) * (1.1 + Math.random() * 1.9);
    }
    let nextPos = (vessel[cfg.posKey] ?? 0.5) + vessel[cfg.velKey] * spanScale * dt;
    if (nextPos < 0.09) {
      nextPos = 0.09 + (0.09 - nextPos) * 0.5;
      vessel[cfg.velKey] = Math.abs(vessel[cfg.velKey]);
    } else if (nextPos > 0.91) {
      nextPos = 0.91 - (nextPos - 0.91) * 0.5;
      vessel[cfg.velKey] = -Math.abs(vessel[cfg.velKey]);
    }
    vessel[cfg.posKey] = nextPos;
    vessel[cfg.accumKey] = (vessel[cfg.accumKey] || 0) + dt;
    const prevWake = vessel[cfg.wakeKey][vessel[cfg.wakeKey].length - 1];
    if (vessel[cfg.accumKey] >= 0.035 || !prevWake || Math.abs(nextPos - prevWake.pos) >= 0.015) {
      vessel[cfg.accumKey] = 0;
      vessel[cfg.wakeKey].push({ pos: nextPos, age: 0, maxLife: 1.8 });
      if (vessel[cfg.wakeKey].length > 26) vessel[cfg.wakeKey].shift();
    }
  }

  let event = null;
  if (vessel[cfg.ignitedKey] || isDirectHazard) {
    const confinement = Math.max(1.0, 22.0 / Math.max(areaSurfCm2, 1.0));
    const blastEnergyJ = newLocalH2 * 241800 * Math.min(confinement, 5.0);
    const blastLimitJ = isDirectHazard ? cfg.blastHazardJ : cfg.blastBaseJ;
    if (blastEnergyJ > blastLimitJ || (isDirectHazard && newT >= 450.0)) {
      event = 'explosion';
      if (isDirectHazard) vessel[cfg.hazardKey] = true;
    } else {
      event = 'ignition_flame';
    }
  } else if (h2ProducedMol > 0) {
    event = 'fizzing';
  }
  return { event, reactionHeatDeltaJ };
}

/**
 * Advance all chemical reactions inside one vessel by dt seconds.
 * Guarantees non-negative moles and exact stoichiometry.
 * Returns { reactionHeatJ, gasProduced, activeReactions, naEvent, kEvent }
 */
export function stepVesselChemistry(vessel, dt, options = {}) {
  const spec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
  const liquidVolL = computeAqueousVolumeL(vessel.moles, vessel.tempK);
  const solidVolMl = computeSolidVolumeMl(vessel.moles);
  const strat = computePhaseStratification(vessel.moles, vessel.tempK, spec, solidVolMl);
  vessel.liquidStratification = strat;

  if (strat.lightOrganicMl > 0.15 && strat.aqueousMl <= 0.05 && (vessel.moles.Na_s || 0) > 1e-10) {
    vessel.naLayerHeightFrac = 0.04;
    vessel.naInterfaceMl = null;
  } else if (strat.hasLightCover && strat.totalLiqMl > 0.1) {
    const aqLayer = strat.layers.find((l) => l.phaseKey === 'aqueous');
    const aqTopMl = aqLayer ? aqLayer.topMl : (strat.interfaceMl ?? strat.aqueousMl);
    vessel.naInterfaceMl = aqTopMl;
    vessel.naLayerHeightFrac = Math.max(0.05, Math.min(0.98, aqTopMl / Math.max(0.1, strat.totalLiqMl + solidVolMl)));
  } else {
    vessel.naInterfaceMl = null;
    vessel.naLayerHeightFrac = 1.0;
  }

  const phNow = liquidVolL > 1e-6 && !vessel.isFrozenSolid ? (computePH(vessel.moles, liquidVolL, vessel.tempK) ?? 7.0) : 7.0;
  options = { ...options, phNow, strat };

  // Advance Zinc amphoteric surface passivation film across neutral–weak alkali window (pH 6.4 .. 12.2)
  if ((vessel.moles.Zn_s || 0) > 1e-9 && liquidVolL > 1e-6 && computeIceMobilityFactor(vessel) > 0) {
    const cOH = (vessel.moles.OH_aq || 0) / liquidVolL;
    let pFrac = vessel.znPassivationFrac || 0;
    if (phNow >= 6.4 && phNow <= 12.18 && cOH < 0.016) {
      const kPass = phNow >= 7.0 && phNow <= 11.6 ? 3.2 : 1.4;
      pFrac = Math.min(1.0, pFrac + (1 - pFrac) * (1 - Math.exp(-kPass * dt)));
    } else if (phNow < 5.2) {
      const kDepass = 2.8 * (5.2 - phNow);
      pFrac = Math.max(0, pFrac * Math.exp(-kDepass * dt));
    } else if (phNow >= 12.4 || cOH >= 0.025) {
      const excessOH = Math.max(0.01, cOH - 0.02);
      const kDepass = 2.6 * Math.min(4.5, excessOH * 15);
      pFrac = Math.max(0, pFrac * Math.exp(-kDepass * dt));
    }
    vessel.znPassivationFrac = pFrac < 0.002 ? 0 : pFrac;
  } else {
    vessel.znPassivationFrac = 0;
  }

  vessel.langmuirCoverage = 0;
  vessel.langmuirOrder = 1.0;

  // Track live galvanic micro-cell & sacrificial cathodic protection flags for telemetry / rendering
  vessel.znCuMicroActive =
    (vessel.moles.Zn_s || 0) > 1e-7 && (vessel.moles.Cu_s || 0) > 1e-7 && (vessel.moles.H_aq || 0) > 1e-5;
  vessel.cathodicProtected =
    ((vessel.moles.Cu_s || 0) > 1e-7 && ((vessel.moles.Zn_s || 0) > 1e-6 || Boolean(vessel.cathodicProtectedByZn))) ||
    Boolean(vessel.cathodicProtectedByZn);

  // 1. Compute raw reaction extents
  const rawExtents = [];
  for (const rxn of REACTIONS) {
    const rate = computeReactionRate(rxn, vessel, liquidVolL, options);
    if (rate > 1e-13) {
      rawExtents.push({ rxn, rate, rawDxi: rate * dt });
    }
  }

  // 2. Compute total demand per reactant species for competitive clamping
  const demand = {};
  for (const item of rawExtents) {
    for (const [spId, stoich] of Object.entries(item.rxn.reactants)) {
      demand[spId] = (demand[spId] || 0) + stoich * item.rawDxi;
    }
  }

  const scaleFactor = {};
  const env = options.environment;
  for (const [spId, dem] of Object.entries(demand)) {
    const avail = getReactantAvailableMol(vessel, spId, env);
    scaleFactor[spId] = dem > avail && dem > 0 ? avail / dem : 1.0;
  }

  // 3. Apply clamped reaction steps
  let reactionHeatJ = 0;
  let naHeatGenJ = 0;
  let naH2ProducedMol = 0;
  let kHeatGenJ = 0;
  let kH2ProducedMol = 0;
  const gasProduced = createZeroGasMap();
  const activeReactions = [];

  for (const item of rawExtents) {
    let minScale = 1.0;
    for (const spId of Object.keys(item.rxn.reactants)) {
      if (scaleFactor[spId] < minScale) {
        minScale = scaleFactor[spId];
      }
    }
    const dXi = item.rawDxi * minScale;
    if (dXi <= 1e-15) continue;

    // Subtract reactants (condensed or headspace gas + trapped O2 air)
    for (const [spId, stoich] of Object.entries(item.rxn.reactants)) {
      const sp = SPECIES[spId];
      const used = stoich * dXi;
      if (sp && sp.phase === 'g') {
        const headAvail = vessel.headspaceGasMoles?.[spId] || 0;
        const fromHead = Math.min(headAvail, used);
        if (fromHead > 0) {
          vessel.headspaceGasMoles[spId] = Math.max(0, headAvail - fromHead);
        }
        const rem = used - fromHead;
        if (rem > 0 && spId === 'H2O_g' && (vessel.tempK || 298) > 373.65) {
          vessel.moles.H2O_l = Math.max(0, (vessel.moles.H2O_l || 0) - rem);
          if (vessel.moles.H2O_l < 1e-14) delete vessel.moles.H2O_l;
        }
        if (rem > 0 && spId === 'O2_g') {
          if ((vessel.isStoppered || vessel.lidState === 'closed') && (vessel.sealedAirO2Moles || 0) > 0) {
            const fromAir = Math.min(vessel.sealedAirO2Moles, rem);
            vessel.sealedAirO2Moles = Math.max(0, vessel.sealedAirO2Moles - fromAir);
            if ((vessel.sealedAirMoles || 0) > 0) {
              vessel.sealedAirMoles = Math.max(0, vessel.sealedAirMoles - fromAir);
            }
          } else if (vessel.isInverted && vessel.submergedInTroughId && (vessel.trappedAirO2Moles || 0) > 0) {
            vessel.trappedAirO2Moles = Math.max(0, vessel.trappedAirO2Moles - rem);
          }
        }
      } else {
        vessel.moles[spId] = Math.max(0, (vessel.moles[spId] || 0) - used);
        if (vessel.moles[spId] < 1e-14) delete vessel.moles[spId];
      }
    }

    // Add products
    for (const [spId, stoich] of Object.entries(item.rxn.products)) {
      const sp = SPECIES[spId];
      if (sp && sp.phase === 'g') {
        gasProduced[spId] = (gasProduced[spId] || 0) + stoich * dXi;
      } else {
        vessel.moles[spId] = (vessel.moles[spId] || 0) + stoich * dXi;
      }
    }

    if (item.rxn.id === 'cuo_h2_reduction' && dXi > 1e-10) {
      if (!vessel.particleCounts) vessel.particleCounts = {};
      vessel.particleCounts.Cu_s = Math.max(vessel.particleCounts.Cu_s || 0, 260);
      vessel._cuoReductionCondenseTimer = 2.2;
    } else if (item.rxn.id === 'zn_o2_burn' && dXi > 1e-10) {
      vessel.znCombustionTimer = 1.0;
      vessel.znFlameColor = 'cyan_blue';
    } else if (
      (item.rxn.id === 'mg_o2_burn' ||
        item.rxn.id === 'mg_co2_burn' ||
        item.rxn.id === 'mg_n2_burn' ||
        item.rxn.id === 'mg_cl2_burn' ||
        (item.rxn.id === 'mg_steam_burn' && (vessel.tempK || 298) >= 423.15)) &&
      dXi > 1e-10
    ) {
      vessel.mgCombustionTimer = 1.25;
    } else if ((item.rxn.id === 'al_o2_burn' || item.rxn.id === 'al_cl2_burn' || item.rxn.id === 'al_fe2o3_thermite') && dXi > 1e-10) {
      vessel.alCombustionTimer = 1.2;
    } else if ((item.rxn.id === 'fe_o2_burn' || item.rxn.id === 'fe_powder_air_ignite') && dXi > 1e-10) {
      vessel.feSparkBurning = 1.0;
    } else if (item.rxn.id === 'na_o2_burn' && dXi > 1e-10) {
      vessel.naDryBurnTimer = 1.0;
    } else if ((item.rxn.id === 'k_o2_burn' || item.rxn.id === 'k_cl2_burn') && dXi > 1e-10) {
      vessel.kDryBurnTimer = 1.0;
    } else if (item.rxn.id === 'mn2o7_explosive_decomp' && dXi > 1e-8) {
      vessel._mn2o7HazardPending = true;
    } else if (item.rxn.id === 'calcine_caco3' && dXi > 1e-10) {
      if (!vessel.particleCounts) vessel.particleCounts = {};
      vessel.particleCounts.CaO_s = Math.max(vessel.particleCounts.CaO_s || 0, 180);
      const stats = (vessel.calcinationStats = vessel.calcinationStats || {
        peakCaMol: (vessel.moles.CaCO3_s || 0) + (vessel.moles.CaO_s || 0) + dXi,
        groundFine: Boolean(vessel.groundPowderMap?.CaCO3_s) || (vessel.particleCounts?.CaCO3_s || 0) >= 60,
        ventedWhileHeating: false,
        roaringBlueZone: false,
        cooledProtected: true,
      });
      stats.peakCaMol = Math.max(stats.peakCaMol, (vessel.moles.CaCO3_s || 0) + (vessel.moles.CaO_s || 0));
      if (vessel.groundPowderMap?.CaCO3_s || (vessel.particleCounts?.CaCO3_s || 0) >= 60) {
        stats.groundFine = true;
      }
      if (vessel.lidState !== 'closed') {
        stats.ventedWhileHeating = true;
      }
      if (options.heatSrc?.burner?.typeId === 'bunsen_burner' && options.heatSrc.burner.airHoleOpen !== false) {
        stats.roaringBlueZone = true;
      }
    }

    // Separate Sodium reaction enthalpy to drive independent metal droplet temperature T_Na
    if (item.rxn.type === 'tollens_h2o2' || item.rxn.type === 'tollens_h2o2_neut') {
      if (!vessel.particleCounts) vessel.particleCounts = {};
      vessel.particleCounts.Ag_s = Math.max(vessel.particleCounts.Ag_s || 0, 900);
      vessel.silverMirrorFrac = Math.min(1.0, (vessel.silverMirrorFrac || 0) + dXi * 180);
    }
    const rxnHeat = -item.rxn.deltaHJ * dXi;
    if (item.rxn.id === 'na_water' || item.rxn.id === 'na_acid' || item.rxn.id === 'na_ice') {
      naHeatGenJ += rxnHeat;
      naH2ProducedMol += (item.rxn.products.H2_g || 0) * dXi;
    } else if (item.rxn.id === 'na_ethanol') {
      naHeatGenJ += rxnHeat * 0.45;
      reactionHeatJ += rxnHeat * 0.55;
      naH2ProducedMol += (item.rxn.products.H2_g || 0) * dXi * 0.25;
    } else if (item.rxn.id === 'k_water' || item.rxn.id === 'k_acid' || item.rxn.id === 'k_ice') {
      kHeatGenJ += rxnHeat;
      kH2ProducedMol += (item.rxn.products.H2_g || 0) * dXi;
    } else if (item.rxn.id === 'k_ethanol') {
      kHeatGenJ += rxnHeat * 0.52;
      reactionHeatJ += rxnHeat * 0.48;
      kH2ProducedMol += (item.rxn.products.H2_g || 0) * dXi * 0.35;
    } else {
      reactionHeatJ += rxnHeat;
    }

    activeReactions.push({
      id: item.rxn.id,
      equation: item.rxn.equation,
      nameVi: item.rxn.nameVi,
      nameEn: item.rxn.nameEn,
      descVi: item.rxn.descVi,
      descEn: item.rxn.descEn,
      rateMolS: dXi / dt,
      vigorousGas: !!item.rxn.vigorousGas,
      dXi,
    });
  }

  // 3b. Two-temperature coupled Sodium & Potassium droplet thermal balances, local ice melting & H2 ignition triggers
  const naBal = updateAlkaliDropletBalance(
    vessel,
    spec,
    solidVolMl,
    strat,
    liquidVolL,
    dt,
    {
      speciesId: 'Na_s',
      tempKey: 'naTempK',
      pinnedKey: 'naPinned',
      ignitedKey: 'naIgnited',
      localH2Key: 'localH2Mol',
      wakeKey: 'naWakeTrail',
      velKey: 'naVelX',
      posKey: 'naPosRatio',
      accumKey: '_naWakeAccum',
      hazardKey: 'naHazardFlag',
      meltTempK: 370.95,
      igniteTempK: 680.0,
      instantIgniteOnH2: false,
      cpSolid: 1.23,
      cpMolten: 1.38,
      tEqCap: 1350,
      skateMinK: 340.0,
      motionMult: 1.0,
      minHazardG: 0.08,
      blastBaseJ: 1150.0,
      blastHazardJ: 220.0,
    },
    naHeatGenJ,
    naH2ProducedMol
  );
  reactionHeatJ += naBal.reactionHeatDeltaJ;
  const naEvent = naBal.event;

  const kBal = updateAlkaliDropletBalance(
    vessel,
    spec,
    solidVolMl,
    strat,
    liquidVolL,
    dt,
    {
      speciesId: 'K_s',
      tempKey: 'kTempK',
      pinnedKey: 'kPinned',
      ignitedKey: 'kIgnited',
      localH2Key: 'localKH2Mol',
      wakeKey: 'kWakeTrail',
      velKey: 'kVelX',
      posKey: 'kPosRatio',
      accumKey: '_kWakeAccum',
      hazardKey: 'kHazardFlag',
      meltTempK: 336.65,
      igniteTempK: 430.0,
      instantIgniteOnH2: true,
      cpSolid: 0.76,
      cpMolten: 0.82,
      tEqCap: 1420,
      skateMinK: 290.0,
      motionMult: 1.35,
      minHazardG: 0.06,
      blastBaseJ: 1550.0,
      blastHazardJ: 180.0,
    },
    kHeatGenJ,
    kH2ProducedMol
  );
  reactionHeatJ += kBal.reactionHeatDeltaJ;
  const kEvent = kBal.event;

  // 4. Reversible [CuCl4]2-, diprotic HSO4- <-> H+ + SO4^2-, amphoteric Cu(OH)2/Ag2O, chloro-silver/cuprous, ammine complexes, carbonate CO2 equilibria, Nernst extraction & chemisorption/garden equilibria
  if ((vessel.moles.CaCO3_s || 0) <= 1e-10) {
    vessel.caso4Passivated = false;
  }
  if (computeIceMobilityFactor(vessel) > 0) {
    if (liquidVolL > 1e-6 && computeSulfuricAcidState(vessel.moles).w < 0.78) {
      const m = vessel.moles;
      const nH = m.H_aq || 0;
      const nSO4 = m.SO4_2_aq || 0;
      const nHSO4 = m.HSO4_aq || 0;
      if (nHSO4 > 1e-12) {
        const Ka2 = 0.0102;
        const cH = nH / liquidVolL;
        const cSO4 = nSO4 / liquidVolL;
        const cHSO4 = nHSO4 / liquidVolL;
        const b = cH + cSO4 + Ka2;
        const disc = Math.max(0, b * b - 4 * (cH * cSO4 - Ka2 * cHSO4));
        const dxConc = (-b + Math.sqrt(disc)) * 0.5;
        const stepMol = dxConc * liquidVolL * Math.min(1, 18.0 * dt);
        if (stepMol > 1e-12) {
          const takeHSO4 = Math.min(nHSO4, stepMol);
          m.HSO4_aq = Math.max(0, nHSO4 - takeHSO4);
          if (m.HSO4_aq < 1e-14) delete m.HSO4_aq;
          m.H_aq = nH + takeHSO4;
          m.SO4_2_aq = nSO4 + takeHSO4;
        }
      }
    }
    reactionHeatJ += stepCarbonateAndCO2Equilibria(vessel, liquidVolL, dt, activeReactions, gasProduced);
    reactionHeatJ += stepChlorocuprateEquilibrium(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepAmphotericHydroxideEquilibria(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepChloroSilverAndCuprousEquilibria(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepAmmineComplexEquilibria(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepMetalNitrateSolver(vessel, liquidVolL, dt, activeReactions, gasProduced);
    reactionHeatJ += stepMetalSulfuricSolver(vessel, liquidVolL, dt, activeReactions, gasProduced);
    reactionHeatJ += stepHalogenRedoxAndAlkali(vessel, liquidVolL, dt, activeReactions, gasProduced, strat, computeIceMobilityFactor(vessel));
    reactionHeatJ += stepSulfurChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, computeIceMobilityFactor(vessel), options);
    reactionHeatJ += stepCarbideAndCarbonChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, computeIceMobilityFactor(vessel), options);
    reactionHeatJ += stepPhosphorusChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, computeIceMobilityFactor(vessel), options);
    reactionHeatJ += stepSiliconAndChromiumChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, computeIceMobilityFactor(vessel), options);
    reactionHeatJ += stepOrganicChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, computeIceMobilityFactor(vessel), options);
    stepLiquidLiquidPartition(vessel, strat, dt);
    reactionHeatJ += stepChemisorptionAndGarden(vessel, liquidVolL, dt, activeReactions);
  } else {
    // Only allow dry chemisorption & dry halogen/sulfur/carbon/phosphorus/silicon/chromium/organic reactions when no aqueous transport exists
    reactionHeatJ += stepHalogenRedoxAndAlkali(vessel, 0, dt, activeReactions, gasProduced, strat, 0);
    reactionHeatJ += stepSulfurChemistry(vessel, 0, dt, activeReactions, gasProduced, 0, options);
    reactionHeatJ += stepCarbideAndCarbonChemistry(vessel, 0, dt, activeReactions, gasProduced, 0, options);
    reactionHeatJ += stepPhosphorusChemistry(vessel, 0, dt, activeReactions, gasProduced, 0, options);
    reactionHeatJ += stepSiliconAndChromiumChemistry(vessel, 0, dt, activeReactions, gasProduced, 0, options);
    reactionHeatJ += stepOrganicChemistry(vessel, 0, dt, activeReactions, gasProduced, 0, options);
    reactionHeatJ += stepChemisorptionAndGarden(vessel, 0, dt, activeReactions);
  }

  // 5. Supersaturation & cryo-cooling crystallization (including ethanol salting-out)
  reactionHeatJ += applySupersaturationCrystallization(vessel, dt, activeReactions);

  // 6. Exp 20: Pickering Colloidal Foam — Cu(OH)2 nanoparticles stabilize ascending O2 microbubbles
  const nColloidCu = vessel.moles.CuOH2_s || 0;
  const maxVesselMl = APPARATUS[vessel.typeId]?.maxVolumeMl || 250;
  const curLiqMl = liquidVolL * 1000;
  let foamMl = vessel.pickeringFoamMl || 0;
  if (liquidVolL > 1e-5 && !vessel.isFrozenSolid && !vessel.isShattered) {
    if (nColloidCu > 2e-5 && (gasProduced.O2_g || 0) > 1e-11) {
      const trapEff = Math.min(0.92, 0.32 + (nColloidCu / Math.max(0.015, liquidVolL)) * 3.5);
      const gainMl = gasProduced.O2_g * 24500 * trapEff;
      foamMl += gainMl;
      vessel.pickeringOverflowActive = curLiqMl + foamMl > maxVesselMl * 1.04;
      foamMl = Math.min(maxVesselMl * 1.15 - curLiqMl, foamMl);
      foamMl = Math.max(0, foamMl);
    } else {
      vessel.pickeringOverflowActive = false;
    }
    const drainRate = nColloidCu > 2e-5 ? 0.055 : 0.45;
    foamMl *= Math.exp(-drainRate * dt);
  } else {
    foamMl = 0;
    vessel.pickeringOverflowActive = false;
  }
  vessel.pickeringFoamMl = foamMl < 0.05 ? 0 : foamMl;

  // 7. Ambient atmosphere surface reactions: Na & K surface oxide tarnishing, combustion flash timers, humid-air NaOH deliquescence & open CaO cooling carbonation
  const atmMode = options.environment?.atmosphereMode || 'air';
  for (const timerKey of ['znCombustionTimer', 'mgCombustionTimer', 'alCombustionTimer', 'feSparkBurning', 'naDryBurnTimer', 'kDryBurnTimer', 'sulfurFlameTimer', 'phosphorusFlameTimer']) {
    if ((vessel[timerKey] || 0) > 0) {
      vessel[timerKey] = Math.max(0, vessel[timerKey] - dt);
    }
  }
  const hasCoolingCaO =
    (vessel.moles.CaO_s || 0) > 1e-6 &&
    (vessel.moles.H2O_l || 0) < 1e-4 &&
    vessel.tempK < 680;
  if (atmMode === 'air' && !vessel.isStoppered && vessel.lidState !== 'closed' && hasCoolingCaO) {
    // Freshly calcined quicklime left exposed in moist room air slowly re-absorbs H2O & CO2 when cooling!
    if (vessel.calcinationStats) {
      vessel.calcinationStats.cooledProtected = false;
    }
    const dReCarb = Math.min(vessel.moles.CaO_s, 0.00045 * dt);
    if (dReCarb > 1e-10) {
      vessel.moles.CaO_s -= dReCarb;
      if (vessel.moles.CaO_s < 1e-13) delete vessel.moles.CaO_s;
      vessel.moles.CaOH2_s = (vessel.moles.CaOH2_s || 0) + dReCarb * 0.55;
      vessel.moles.CaCO3_s = (vessel.moles.CaCO3_s || 0) + dReCarb * 0.45;
    }
  } else if (vessel.calcinationStats && (vessel.lidState === 'closed' || atmMode === 'inert')) {
    vessel.calcinationStats.cooledProtected = true;
  }
  const hasDryNa = (vessel.moles.Na_s || 0) > 1e-7 && (vessel.moles.H2O_l || 0) < 1e-4;
  const hasDryK = (vessel.moles.K_s || 0) > 1e-7 && (vessel.moles.H2O_l || 0) < 1e-4;
  const isOiled = strat.hasLightCover || (strat.lightOrganicMl || 0) > 0.05;
  if (atmMode === 'air' && !vessel.isStoppered && hasDryNa && !isOiled) {
    vessel.naTarnishFrac = Math.min(1.0, (vessel.naTarnishFrac || 0) + 0.14 * dt);
    const dTarn = Math.min((vessel.moles.Na_s || 0) * 0.001, 3.5e-7 * dt);
    if (dTarn > 1e-12) {
      vessel.moles.Na_s = Math.max(0, vessel.moles.Na_s - 2 * dTarn);
      vessel.moles.Na2O_s = (vessel.moles.Na2O_s || 0) + dTarn;
    }
  } else if (!hasDryNa || isOiled) {
    vessel.naTarnishFrac = 0;
  }
  if (atmMode === 'air' && !vessel.isStoppered && hasDryK && !isOiled) {
    vessel.kTarnishFrac = Math.min(1.0, (vessel.kTarnishFrac || 0) + 0.22 * dt);
    const dTarnK = Math.min((vessel.moles.K_s || 0) * 0.0014, 5.0e-7 * dt);
    if (dTarnK > 1e-12) {
      vessel.moles.K_s = Math.max(0, vessel.moles.K_s - 2 * dTarnK);
      vessel.moles.K2O_s = (vessel.moles.K2O_s || 0) + dTarnK;
    }
  } else if (!hasDryK || isOiled) {
    vessel.kTarnishFrac = 0;
  }

  const canDeliquesceNaOH =
    atmMode === 'air' &&
    !vessel.isStoppered &&
    (vessel.moles.NaOH_s || 0) > 1e-6 &&
    vessel.tempK < 345 &&
    !(vessel.moles.AgNO3_s > 1e-6) &&
    !(vessel.moles.Zn_s > 1e-6);
  if (canDeliquesceNaOH) {
    vessel.naohAirExposeSec = (vessel.naohAirExposeSec || 0) + dt;
    if (vessel.naohAirExposeSec >= 3.0) {
      vessel.naohDeliquesceFrac = Math.min(1.0, (vessel.naohDeliquesceFrac || 0) + 0.12 * dt);
      const dMoist = Math.min(0.08, 1.8e-4 * dt);
      if ((vessel.moles.H2O_l || 0) < (vessel.moles.NaOH_s || 0) * 1.5) {
        vessel.moles.H2O_l = (vessel.moles.H2O_l || 0) + dMoist;
      }
    }
  } else if (!(vessel.moles.NaOH_s > 1e-6) || vessel.tempK >= 375) {
    vessel.naohAirExposeSec = 0;
    vessel.naohDeliquesceFrac = 0;
  }

  const moles = vessel.moles;
  const liqV = computeLiquidVolumeL(moles, vessel.tempK);

  // Clear Fe & Al passivation flags once outside cold concentrated HNO3 or cold concentrated H2SO4
  if (vessel.fePassivated || vessel.alPassivated) {
    const nAcidCheck = Math.min(moles.H_aq || 0, moles.NO3_aq || 0);
    const cAcidCheck = liqV > 1e-5 ? nAcidCheck / liqV : 0;
    const mHno3C = nAcidCheck * CONSTANTS.M_HNO3;
    const mWaterC = (moles.H2O_l || 0) * CONSTANTS.M_H2O;
    const wHno3C = mHno3C / Math.max(1e-9, mHno3C + mWaterC);
    const inColdConcHNO3 = (wHno3C >= 0.60 || cAcidCheck >= 10.0) && vessel.tempK < 323.15;
    const sulfC = computeSulfuricAcidState(moles);
    const inColdConcH2SO4 = sulfC.w >= 0.65 && vessel.tempK < 323.15;
    if ((moles.Fe_s || 0) <= 1e-10 || (!inColdConcHNO3 && !inColdConcH2SO4)) {
      vessel.fePassivated = false;
    }
    if ((moles.Al_s || 0) <= 1e-10 || (!inColdConcHNO3 && !inColdConcH2SO4)) {
      vessel.alPassivated = false;
    }
  }

  // Outgassing of dissolved NO2(aq) -> brown NO2(g) above threshold or when warmed/stirred
  const nNO2Aq = moles.NO2_aq || 0;
  if (nNO2Aq > 1e-8 && !vessel.isFrozenSolid && liqV > 1e-5) {
    const cNO2 = nNO2Aq / liqV;
    const satC = Math.max(0.015, 0.22 * Math.exp(-0.042 * (vessel.tempK - CONSTANTS.T_STD_K)));
    if (cNO2 > satC || vessel.tempK >= 325.15) {
      const excessNO2 = Math.max(nNO2Aq * (vessel.tempK >= 338.15 ? 0.35 : 0.12), nNO2Aq - satC * liqV);
      const dOutNO2 = Math.min(nNO2Aq, excessNO2 * Math.min(1, 1.4 * dt * ((vessel.stirTimer || 0) > 0 ? 2.2 : 1.0)));
      if (dOutNO2 > 1e-10) {
        moles.NO2_aq = nNO2Aq - dOutNO2;
        if (moles.NO2_aq < 1e-12) delete moles.NO2_aq;
        gasProduced.NO2_g = (gasProduced.NO2_g || 0) + dOutNO2;
      }
    }
  }

  // Thin white CaCO3(s) crust across calm open Ca(OH)2(aq) limewater meniscus exposed to ambient CO2
  const hasLimewater =
    (moles.Ca2_aq || 0) > 1e-5 &&
    (moles.OH_aq || 0) > 1e-5 &&
    (moles.H2O_l || 0) > 1e-4 &&
    (moles.H_aq || 0) <= 1e-5;
  const isAcidPresent = (moles.H_aq || 0) > 1e-4;
  const isDisturbed = (vessel.stirTimer || 0) > 0 || (vessel.magStirRpm || 0) > 0 || isAcidPresent;
  if (
    atmMode === 'air' &&
    hasLimewater &&
    !vessel.isStoppered &&
    !vessel.isInverted &&
    !vessel.isFrozenSolid &&
    !isDisturbed
  ) {
    vessel.caCo3FilmFrac = Math.min(1.0, (vessel.caCo3FilmFrac || 0) + 0.085 * dt);
    const dFilm = Math.min(moles.Ca2_aq, moles.OH_aq / 2, 1.4e-4 * dt);
    if (dFilm > 1e-10) {
      moles.Ca2_aq -= dFilm;
      moles.OH_aq -= 2 * dFilm;
      if (moles.Ca2_aq < 1e-13) delete moles.Ca2_aq;
      if (moles.OH_aq < 1e-13) delete moles.OH_aq;
      moles.CaCO3_s = (moles.CaCO3_s || 0) + dFilm;
      moles.H2O_l = (moles.H2O_l || 0) + dFilm;
      activeReactions.push({
        id: 'caoh2_air_surface_crust',
        equation: 'Ca(OH)₂(aq) + CO₂(không khí) → CaCO₃(s)↓ + H₂O(l)',
        nameVi: 'Tạo màng mỏng CaCO₃ trắng trên bề mặt nước vôi trong',
        nameEn: 'Surface CaCO₃ crystalline crust on open Ca(OH)₂(aq) exposed to air',
        descVi: 'CO₂ trong không khí tác dụng nhẹ ở mặt thoáng nước vôi trong tạo lớp váng trắng mỏng CaCO₃ nổi trên bề mặt (vỡ tan khi khuấy hoặc thêm acid).',
        descEn: 'Atmospheric CO₂ slowly forms a delicate floating white CaCO₃ film across quiescent open limewater (dispersed upon stirring or acidifying).',
        dXi: dFilm,
        rateMolS: dFilm / Math.max(1e-4, dt),
        vigorousGas: false,
      });
    }
  } else if (isDisturbed || !hasLimewater || vessel.isFrozenSolid) {
    vessel.caCo3FilmFrac = isAcidPresent || !hasLimewater ? 0 : Math.max(0, (vessel.caCo3FilmFrac || 0) - 2.8 * dt);
  }

  return {
    reactionHeatJ,
    gasProduced,
    activeReactions,
    naEvent,
    kEvent,
  };
}
