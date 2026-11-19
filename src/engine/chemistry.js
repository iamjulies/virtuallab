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
  if (vessel?.groundPowderMap?.Na_s || pCnt >= 120) return 296.15;
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
  if (vessel?.groundPowderMap?.K_s || pCnt >= 120) return 290.15;
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
export function getZnIgnitionTempK(vessel, env = null) {
  const headO2 = vessel?.headspaceGasMoles?.O2_g || 0;
  if (headO2 > 1.2e-4) return 615.0;
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
    const sTemp =
      rxn.solubilityMolPerKg298 *
      saltingMult *
      Math.exp(rxn.solubilityTempCoeff * (T - CONSTANTS.T_STD_K));
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
    if (T < rxn.minTempK) return 0;
    if (rxn.maxTempK && T >= rxn.maxTempK) return 0;
    if (rxn.requiresInertOrVacuum && env?.atmosphereMode !== 'inert' && getVesselEffectiveO2Bar(vessel, env) > 0.03) return 0;
    if (rxn.id === 'na2o_inert_disprop' && env?.atmosphereMode !== 'inert') return 0;
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    const k = rxn.kAtThreshold * arrheniusFactor(rxn.eaJ, T - rxn.minTempK + CONSTANTS.T_STD_K);
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
    const area = computeSolidSurfaceAreaM2('Mg_s', nMg, vessel.particleCounts?.Mg_s ?? 6);
    const hotBoost = T >= 333.15 ? 5.2 : 0.08;
    return rxn.k298 * arrheniusFactor(rxn.eaJ || 42000, T) * Math.max(1e-5, area) * hotBoost * stirBoost * iceMob * 8.0;
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
    // Effective exposed catalyst area scales linearly with fine precipitated Ag2O mass/particle count
    const catArea = Math.min(0.18, nCat * 18.0);
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
    const minTK =
      solidId === 'Zn_s'
        ? getZnIgnitionTempK(vessel, options.environment)
        : solidId === 'Fe_s'
        ? (isFineMetal ? 610 : rxn.minTempK || 760)
        : (rxn.minTempK || 585);
    if (T < minTK) return 0;
    const pO2 = getVesselEffectiveO2Bar(vessel, options.environment);
    // Fe_s in ordinary air is governed by fe_air_combustion (powder spark combustion vs nail protective 3-layer scale);
    // fe_o2_burn activates specifically in pure/enriched O2 (>0.35 bar or headspace O2 > 1e-4)
    if (solidId === 'Fe_s' && pO2 <= 0.35 && (vessel.headspaceGasMoles?.O2_g || 0) <= 1e-4) return 0;
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
    { cat: 'K_aq', cCat: 2, an: 'SO4_2_aq', cAn: 1, solid: 'K2SO4_s', formula: 'K₂SO₄', sol298: 0.69, coeff: 0.012, etohRel: 0.01, crystHeatJ: -23800 },
    { cat: 'K_aq', cCat: 1, an: 'NO3_aq', cAn: 1, solid: 'KNO3_s', formula: 'KNO₃', sol298: 3.75, coeff: 0.029, etohRel: 0.02, crystHeatJ: -34900 },
    { cat: 'K_aq', cCat: 1, an: 'Cl_aq', cAn: 1, solid: 'KCl_s', formula: 'KCl', sol298: 4.8, coeff: 0.008, etohRel: 0.01, crystHeatJ: -17200 },
    { cat: 'K_aq', cCat: 2, an: 'CO3_2_aq', cAn: 1, solid: 'K2CO3_s', formula: 'K₂CO₃', sol298: 8.1, coeff: 0.006, etohRel: 0.01, crystHeatJ: 30900 },
    { cat: 'K_aq', cCat: 1, an: 'OH_aq', cAn: 1, solid: 'KOH_s', formula: 'KOH', sol298: 21.5, coeff: 0.020, etohRel: 0.14, crystHeatJ: 57600 },
    { cat: 'Mg2_aq', cCat: 1, an: 'SO4_2_aq', cAn: 1, solid: 'MgSO4_s', formula: 'MgSO₄', sol298: 2.95, coeff: 0.012, etohRel: 0.02, crystHeatJ: 12000 },
    { cat: 'Mg2_aq', cCat: 1, an: 'Cl_aq', cAn: 2, solid: 'MgCl2_s', formula: 'MgCl₂', sol298: 5.7, coeff: 0.009, etohRel: 0.15, crystHeatJ: 15500 },
    { cat: 'Mg2_aq', cCat: 1, an: 'NO3_aq', cAn: 2, solid: 'MgNO3_2_s', formula: 'Mg(NO₃)₂', sol298: 4.8, coeff: 0.014, etohRel: 0.05, crystHeatJ: 6000 },
    { cat: 'Al3_aq', cCat: 2, an: 'SO4_2_aq', cAn: 3, solid: 'Al2SO4_3_s', formula: 'Al₂(SO₄)₃', sol298: 1.1, coeff: 0.016, etohRel: 0.01, crystHeatJ: 18000 },
    { cat: 'Al3_aq', cCat: 1, an: 'Cl_aq', cAn: 3, solid: 'AlCl3_s', formula: 'AlCl₃', sol298: 3.4, coeff: 0.009, etohRel: 0.15, crystHeatJ: 32500 },
    { cat: 'Al3_aq', cCat: 1, an: 'NO3_aq', cAn: 3, solid: 'AlNO3_3_s', formula: 'Al(NO₃)₃', sol298: 3.1, coeff: 0.015, etohRel: 0.05, crystHeatJ: 10000 },
    { cat: 'Na_aq', cCat: 1, an: 'HCO3_aq', cAn: 1, solid: 'NaHCO3_s', formula: 'NaHCO₃', sol298: 1.15, coeff: 0.016, etohRel: 0.01, crystHeatJ: -17500, useKsp: true },
    { cat: 'Na_aq', cCat: 2, an: 'SO4_2_aq', cAn: 1, solid: 'Na2SO4_s', formula: 'Na₂SO₄', sol298: 1.98, coeff: 0.032, etohRel: 0.02, crystHeatJ: 8000 },
    { cat: 'Na_aq', cCat: 2, an: 'CO3_2_aq', cAn: 1, solid: 'Na2CO3_s', formula: 'Na₂CO₃', sol298: 2.9, coeff: 0.015, etohRel: 0.01, crystHeatJ: 26700 },
    { cat: 'Zn2_aq', cCat: 1, an: 'SO4_2_aq', cAn: 1, solid: 'ZnSO4_s', formula: 'ZnSO₄', sol298: 3.57, coeff: 0.012, etohRel: 0.02, crystHeatJ: 8000 },
    { cat: 'Cu2_aq', cCat: 1, an: 'Cl_aq', cAn: 2, solid: 'CuCl2_s', formula: 'CuCl₂', sol298: 5.6, coeff: 0.010, etohRel: 0.35, crystHeatJ: 8000 },
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
};

export const DRY_SALT_PAIRINGS = [
  ['Ag_aq', 1, 'Cl_aq', 1, 'AgCl_s', 1, false],
  ['Ag_aq', 2, 'SO4_2_aq', 1, 'Ag2SO4_s', 1, false],
  ['Ag_aq', 2, 'CO3_2_aq', 1, 'Ag2CO3_s', 1, false],
  ['Ag_aq', 1, 'NO3_aq', 1, 'AgNO3_s', 1, false],
  ['Ba2_aq', 1, 'SO4_2_aq', 1, 'BaSO4_s', 1, false],
  ['Ba2_aq', 1, 'CO3_2_aq', 1, 'BaCO3_s', 1, false],
  ['Ba2_aq', 1, 'OH_aq', 2, 'BaOH2_s', 1, false],
  ['Ba2_aq', 1, 'Cl_aq', 2, 'BaCl2_s', 1, false],
  ['Ba2_aq', 1, 'NO3_aq', 2, 'BaNO3_2_s', 1, false],
  ['Fe3_aq', 1, 'OH_aq', 3, 'FeOH3_s', 1, false],
  ['Fe3_aq', 2, 'SO4_2_aq', 3, 'Fe2SO4_3_s', 1, false],
  ['Fe3_aq', 1, 'Cl_aq', 3, 'FeCl3_s', 1, false],
  ['Fe3_aq', 1, 'NO3_aq', 3, 'FeNO3_3_s', 1, false],
  ['Fe2_aq', 1, 'CO3_2_aq', 1, 'FeCO3_s', 1, false],
  ['Fe2_aq', 1, 'OH_aq', 2, 'FeOH2_s', 1, false],
  ['Fe2_aq', 1, 'SO4_2_aq', 1, 'FeSO4_s', 1, false],
  ['Fe2_aq', 1, 'Cl_aq', 2, 'FeCl2_s', 1, false],
  ['Fe2_aq', 1, 'NO3_aq', 2, 'FeNO3_2_s', 1, false],
  ['Ca2_aq', 1, 'CO3_2_aq', 1, 'CaCO3_s', 1, false],
  ['Ca2_aq', 1, 'OH_aq', 2, 'CaOH2_s', 1, false],
  ['Ca2_aq', 1, 'SO4_2_aq', 1, 'CaSO4_s', 1, false],
  ['Ca2_aq', 1, 'Cl_aq', 2, 'CaCl2_s', 1, false],
  ['Ca2_aq', 1, 'NO3_aq', 2, 'CaNO3_2_s', 1, false],
  ['Cu2_aq', 1, 'CO3_2_aq', 1, 'CuCO3_s', 1, false],
  ['Cu2_aq', 1, 'SO4_2_aq', 1, 'CuSO4_s', 1, false],
  ['Cu2_aq', 1, 'OH_aq', 2, 'CuOH2_s', 1, false],
  ['Cu2_aq', 1, 'Cl_aq', 2, 'CuCl2_s', 1, false],
  ['Cu2_aq', 1, 'NO3_aq', 2, 'CuNO3_2_s', 1, false],
  ['Zn2_aq', 1, 'CO3_2_aq', 1, 'ZnCO3_s', 1, false],
  ['Zn2_aq', 1, 'SO4_2_aq', 1, 'ZnSO4_s', 1, false],
  ['Zn2_aq', 1, 'Cl_aq', 2, 'ZnCl2_s', 1, false],
  ['Zn2_aq', 1, 'NO3_aq', 2, 'ZnNO3_2_s', 1, false],
  ['Zn2_aq', 1, 'OH_aq', 2, 'ZnOH2_s', 1, false],
  ['Na_aq', 2, 'CO3_2_aq', 1, 'Na2CO3_s', 1, false],
  ['Na_aq', 1, 'HCO3_aq', 1, 'NaHCO3_s', 1, false],
  ['Na_aq', 1, 'Cl_aq', 1, 'NaCl_s', 1, false],
  ['Na_aq', 1, 'ClO_aq', 1, 'NaClO_s', 1, false],
  ['Na_aq', 2, 'SO4_2_aq', 1, 'Na2SO4_s', 1, false],
  ['Na_aq', 1, 'HSO4_aq', 1, 'NaHSO4_s', 1, false],
  ['Na_aq', 1, 'NO3_aq', 1, 'NaNO3_s', 1, false],
  ['Na_aq', 1, 'C2H5O_aq', 1, 'C2H5ONa_s', 1, false],
  ['Na_aq', 1, 'OH_aq', 1, 'NaOH_s', 1, false],
  ['NH4_aq', 1, 'Cl_aq', 1, 'NH4Cl_s', 1, false],
  ['NH4_aq', 1, 'NO3_aq', 1, 'NH4NO3_s', 1, false],
  ['NH4_aq', 2, 'SO4_2_aq', 1, 'NH4_2_SO4_s', 1, false],
  ['NH4_aq', 1, 'HSO4_aq', 1, 'NH4HSO4_s', 1, false],
  ['Mg2_aq', 1, 'CO3_2_aq', 1, 'MgCO3_s', 1, false],
  ['Mg2_aq', 1, 'OH_aq', 2, 'MgOH2_s', 1, false],
  ['Mg2_aq', 1, 'SO4_2_aq', 1, 'MgSO4_s', 1, false],
  ['Mg2_aq', 1, 'Cl_aq', 2, 'MgCl2_s', 1, false],
  ['Mg2_aq', 1, 'NO3_aq', 2, 'MgNO3_2_s', 1, false],
  ['Al3_aq', 1, 'OH_aq', 3, 'AlOH3_s', 1, false],
  ['Al3_aq', 2, 'SO4_2_aq', 3, 'Al2SO4_3_s', 1, false],
  ['Al3_aq', 1, 'Cl_aq', 3, 'AlCl3_s', 1, false],
  ['Al3_aq', 1, 'NO3_aq', 3, 'AlNO3_3_s', 1, false],
  ['K_aq', 2, 'CO3_2_aq', 1, 'K2CO3_s', 1, false],
  ['K_aq', 1, 'HCO3_aq', 1, 'KHCO3_s', 1, false],
  ['K_aq', 2, 'SO4_2_aq', 1, 'K2SO4_s', 1, false],
  ['K_aq', 1, 'HSO4_aq', 1, 'KHSO4_s', 1, false],
  ['K_aq', 1, 'Cl_aq', 1, 'KCl_s', 1, false],
  ['K_aq', 1, 'NO3_aq', 1, 'KNO3_s', 1, false],
  ['K_aq', 1, 'C2H5O_aq', 1, 'C2H5OK_s', 1, false],
  ['K_aq', 1, 'OH_aq', 1, 'KOH_s', 1, false],
  ['H_aq', 1, 'OH_aq', 1, 'H2O_g', 1, true],
  ['H_aq', 1, 'Cl_aq', 1, 'HCl_g', 1, true],
  ['H_aq', 1, 'NO3_aq', 1, 'HNO3_g', 1, true],
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
  if ((moles.C2H5OH_l || 0) > 0) {
    delete moles.C2H5OH_l;
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

  // 2. Zinc (Zn_s) across mid (20-65% -> SO2 + trace S/H2S) & conc/conc_98 (>=65% -> SO2)
  const nZn = moles.Zn_s || 0;
  if (nZn > 1e-10) {
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

  // 5. Magnesium (Mg_s) across mid (20-65% -> SO2 + trace S/H2S) & conc/conc_98 (>=65% -> SO2)
  const nMg = moles.Mg_s || 0;
  if (nMg > 1e-10) {
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
    } else if ((item.rxn.id === 'mg_o2_burn' || item.rxn.id === 'mg_co2_burn' || item.rxn.id === 'mg_n2_burn' || item.rxn.id === 'mg_cl2_burn') && dXi > 1e-10) {
      vessel.mgCombustionTimer = 1.25;
    } else if ((item.rxn.id === 'al_o2_burn' || item.rxn.id === 'al_cl2_burn' || item.rxn.id === 'al_fe2o3_thermite') && dXi > 1e-10) {
      vessel.alCombustionTimer = 1.2;
    } else if ((item.rxn.id === 'fe_o2_burn' || item.rxn.id === 'fe_powder_air_ignite') && dXi > 1e-10) {
      vessel.feSparkBurning = 1.0;
    } else if (item.rxn.id === 'na_o2_burn' && dXi > 1e-10) {
      vessel.naDryBurnTimer = 1.0;
    } else if ((item.rxn.id === 'k_o2_burn' || item.rxn.id === 'k_cl2_burn') && dXi > 1e-10) {
      vessel.kDryBurnTimer = 1.0;
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

  // 4. Reversible [CuCl4]2-, amphoteric Cu(OH)2/Ag2O, chloro-silver/cuprous, ammine complexes, carbonate CO2 equilibria, Nernst extraction & chemisorption/garden equilibria
  if (computeIceMobilityFactor(vessel) > 0) {
    reactionHeatJ += stepCarbonateAndCO2Equilibria(vessel, liquidVolL, dt, activeReactions, gasProduced);
    reactionHeatJ += stepChlorocuprateEquilibrium(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepAmphotericHydroxideEquilibria(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepChloroSilverAndCuprousEquilibria(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepAmmineComplexEquilibria(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepMetalNitrateSolver(vessel, liquidVolL, dt, activeReactions, gasProduced);
    reactionHeatJ += stepMetalSulfuricSolver(vessel, liquidVolL, dt, activeReactions, gasProduced);
    stepLiquidLiquidPartition(vessel, strat, dt);
    reactionHeatJ += stepChemisorptionAndGarden(vessel, liquidVolL, dt, activeReactions);
  } else {
    // Only allow dry chemisorption when no aqueous transport exists
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
  for (const timerKey of ['znCombustionTimer', 'mgCombustionTimer', 'alCombustionTimer', 'feSparkBurning', 'naDryBurnTimer', 'kDryBurnTimer']) {
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
