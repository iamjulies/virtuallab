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
  if (spId !== 'O2_g') return headVal;

  const atmMode = env?.atmosphereMode || 'air';
  if (atmMode === 'inert') return headVal;
  if (vessel.isStoppered) {
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
    if (!vessel.isStoppered && !vessel.isInverted) {
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
    const nSolid = moles[rxn.solidId] || 0;
    const waterMassKg = (moles.H2O_l * SPECIES.H2O_l.molarMass) / 1000;
    const etohMassKg = ((moles.C2H5OH_l || 0) * SPECIES.C2H5OH_l.molarMass) / 1000;
    const effectiveSolventKg = waterMassKg + (rxn.etohRelSolubility || 0) * etohMassKg;
    let saltingMult = 1.0;
    let gardenSlow = 1.0;
    if (rxn.solidId === 'CuSO4_5H2O_s' || rxn.solidId === 'CuSO4_s') {
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
    if (currentIon >= maxSoluble * 0.999) return 0;

    const undersaturation = Math.max(0, 1 - currentIon / Math.max(1e-12, maxSoluble));
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
    const nNa = moles.Na_s || 0;
    const nIce = moles.H2O_s || 0;
    if (nNa <= 1e-12 || nIce <= 1e-6) return 0;
    const tNa = vessel.naTempK ?? T;
    const pCount = vessel.particleCounts?.Na_s ?? 1;
    const area = computeSolidSurfaceAreaM2('Na_s', nNa, pCount);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, tNa);
    return k * area;
  }

  if (rxn.type === 'heterogeneous_metal') {
    if (!hasWater) return 0;
    const nSolid = moles[rxn.solidId] || 0;
    const pCount = vessel.particleCounts?.[rxn.solidId] ?? (rxn.solidId === 'Na_s' ? 1 : 6);
    const area = computeSolidSurfaceAreaM2(rxn.solidId, nSolid, pCount);

    if (rxn.solidId === 'Na_s') {
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
    const nNa = moles.Na_s || 0;
    const pCount = vessel.particleCounts?.Na_s ?? 1;
    const area = computeSolidSurfaceAreaM2('Na_s', nNa, pCount);
    const nW = moles.H2O_l || 0;
    const nE = moles.C2H5OH_l || 0;
    const xEtOH = nE / Math.max(1e-9, nW + nE);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, vessel.naTempK ?? T);
    return k * area * (0.6 + 2.6 * xEtOH);
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
    const minTK = solidId === 'Zn_s' ? getZnIgnitionTempK(vessel, options.environment) : (rxn.minTempK || 585);
    if (T < minTK) return 0;
    const pO2 = getVesselEffectiveO2Bar(vessel, options.environment);
    if (pO2 <= 0.015) return 0;
    const nSolid = moles[solidId] || 0;
    if (nSolid <= 1e-10) return 0;
    const pCount = vessel.particleCounts?.[solidId] ?? 6;
    const area = computeSolidSurfaceAreaM2(solidId, nSolid, pCount);
    const o2Drive = Math.min(4.8, pO2 / CONSTANTS.AIR_O2_FRAC);
    const k = (rxn.kAtThreshold || 0.65) * arrheniusFactor(rxn.eaJ || 48000, T - minTK + CONSTANTS.T_STD_K);
    return Math.min(nSolid * 0.9, k * Math.max(1e-4, area) * o2Drive * 24.0);
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

  if (rxn.type === 'heterogeneous_acid_salt') {
    if (!hasWater || iceMob <= 0) return 0;
    const nSolid = moles[rxn.solidId] || 0;
    const cH = (moles[rxn.aqueousId] || 0) / liquidVolL;
    if (nSolid <= 1e-10 || cH < 1e-4) return 0;
    const pCount = vessel.particleCounts?.[rxn.solidId] ?? 6;
    const area = computeSolidSurfaceAreaM2(rxn.solidId, nSolid, pCount);
    const k = getEffectiveRateConstant(rxn, T, vessel.stirTimer > 0);
    return Math.min(nSolid, (moles[rxn.aqueousId] || 0) / 2, k * Math.max(1e-5, area) * Math.min(12.0, cH) * 6.5 * iceMob);
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
    { cat: 'Na_aq', cCat: 1, an: 'HCO3_aq', cAn: 1, solid: 'NaHCO3_s', formula: 'NaHCO₃', sol298: 1.15, coeff: 0.016, etohRel: 0.01, crystHeatJ: -17500 },
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
    const maxSol =
      effectiveSolventKg > 1e-8
        ? pair.sol298 * Math.exp(pair.coeff * (T - CONSTANTS.T_STD_K)) * effectiveSolventKg
        : 0;
    if (nPair > maxSol) {
      const excess = nPair - maxSol;
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
    const absorbRate = (cOH > 1e-4 ? 6.5 : 1.2) * (vessel.stirTimer > 0 ? 1.8 : 1.0);
    const dAbs = Math.min(headCo2, headCo2 * Math.min(1, absorbRate * dt));
    if (dAbs > 1e-12) {
      vessel.headspaceGasMoles.CO2_g = Math.max(0, headCo2 - dAbs);
      moles.H2CO3_aq = (moles.H2CO3_aq || 0) + dAbs;
      heatJ += 19900 * dAbs;
    }
  }

  // 2. Stepwise acid/base carbonate proton transfers
  const nH = moles.H_aq || 0;
  const nOH = moles.OH_aq || 0;
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
    if (nAcidCO2 > maxHold && ((moles.H_aq || 0) > 1e-5 || tC >= 45 || (moles.OH_aq || 0) < 1e-6)) {
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
  H2O2_aq: { H2O_g: 1, O2_g: 0.5 },
  H2CO3_aq: { H2O_g: 1, CO2_g: 1 },
  NH3_aq: { NH3_g: 1 },
};

export const DRY_SALT_PAIRINGS = [
  ['Ag_aq', 1, 'Cl_aq', 1, 'AgCl_s', 1, false],
  ['Ag_aq', 2, 'CO3_2_aq', 1, 'Ag2CO3_s', 1, false],
  ['Ag_aq', 1, 'NO3_aq', 1, 'AgNO3_s', 1, false],
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
  ['Na_aq', 2, 'SO4_2_aq', 1, 'Na2SO4_s', 1, false],
  ['Na_aq', 1, 'NO3_aq', 1, 'NaNO3_s', 1, false],
  ['Na_aq', 1, 'C2H5O_aq', 1, 'C2H5ONa_s', 1, false],
  ['Na_aq', 1, 'OH_aq', 1, 'NaOH_s', 1, false],
  ['NH4_aq', 1, 'Cl_aq', 1, 'NH4Cl_s', 1, false],
  ['NH4_aq', 1, 'NO3_aq', 1, 'NH4NO3_s', 1, false],
  ['NH4_aq', 2, 'SO4_2_aq', 1, 'NH4_2_SO4_s', 1, false],
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
  if ((moles.H2O_l || 0) > 1e-7 || (moles.C2H5OH_l || 0) > 1e-7 || (moles.H2O_s || 0) > 1e-7) {
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

/**
 * Advance all chemical reactions inside one vessel by dt seconds.
 * Guarantees non-negative moles and exact stoichiometry.
 * Returns { reactionHeatJ, gasProduced, activeReactions, naEvent }
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
          if (vessel.isStoppered && (vessel.sealedAirO2Moles || 0) > 0) {
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
    } else if (item.rxn.id === 'na_o2_burn' && dXi > 1e-10) {
      vessel.naDryBurnTimer = 1.0;
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

  // 3b. Two-temperature coupled Sodium droplet thermal balance, local ice melting & Coulomb/H2 blast trigger
  let naEvent = null;
  const nNaLeft = vessel.moles.Na_s || 0;
  const hasIceForNa = (vessel.moles.H2O_s || 0) > 1e-6;
  if (nNaLeft > 1e-10 && (liquidVolL > 1e-6 || hasIceForNa)) {
    const tNaPrev = vessel.naTempK ?? vessel.tempK;
    const pCount = vessel.particleCounts?.Na_s ?? 1;
    const aNaCm2 = Math.max(0.04, computeSolidSurfaceAreaM2('Na_s', nNaLeft, pCount) * 1e4);
    const totMl = strat.totalLiqMl + solidVolMl;
    const areaSurfCm2 = spec?.geometry
      ? Math.max(0.5, spec.geometry.getLiquidState(totMl).surfaceAreaCm2)
      : spec?.surfaceAreaCm2 || 25.0;

    const effLiqL = Math.max(1e-5, liquidVolL);
    const cNaOH = (vessel.moles.OH_aq || 0) / effLiqL;
    const cH = (vessel.moles.H_aq || 0) / effLiqL;
    const cAg = (vessel.moles.Ag_aq || 0) / effLiqL;
    const nW = vessel.moles.H2O_l || 0;
    const nE = vessel.moles.C2H5OH_l || 0;
    const xEtOH = nE / Math.max(1e-9, nW + nE);
    const isDirectHazard = liquidVolL > 1e-5 && (cH >= 6.0 || cAg >= 1.5) && nNaLeft * SPECIES.Na_s.molarMass >= 0.08;

    const effNaFootprint = Math.min(Math.max(aNaCm2, 0.08), 6.0);
    const mobilityFactor = 0.28 + 0.72 * (1 - Math.exp(-0.14 * (areaSurfCm2 / effNaFootprint)));
    const pinHeatLoss = areaSurfCm2 < 15.0 ? 0.42 : 1.0;
    const viscosityDamping = 1 / (1 + 0.55 * cNaOH + 0.35 * cNaOH * cNaOH);
    const hLiquid = 11.5 * mobilityFactor * pinHeatLoss * viscosityDamping;
    // Blend from slow solid-ice contact conductance (~0.08) to full liquid convective coupling as local film melts
    const iceWetBlend = hasIceForNa ? Math.min(1, nW / 0.04) : 1.0;
    const hEff = 0.08 * (1 - iceWetBlend) + hLiquid * iceWetBlend; // W / (cm^2 * K)
    const condWK = Math.max(1e-4, hEff * aNaCm2);

    const mNaG = Math.max(1e-4, nNaLeft * SPECIES.Na_s.molarMass);
    const cNa = Math.max(1e-4, mNaG * (tNaPrev >= 370.95 ? 1.38 : 1.23));
    const qGenW = naHeatGenJ / Math.max(1e-6, dt);
    const tEq = Math.min(1350, vessel.tempK + qGenW / condWK);
    const alpha = condWK / cNa;
    let newTNa = Math.max(200, Math.min(1250, tEq + (tNaPrev - tEq) * Math.exp(-alpha * dt)));
    if (xEtOH > 0.35) {
      newTNa = Math.min(newTNa, 360.0);
    }

    // Local melting beneath hot Na droplet on ice: converts part of reaction heat into thin liquid water film
    let localMeltHeatUsedJ = 0;
    if (hasIceForNa && newTNa > CONSTANTS.T_FREEZE_WATER_K && naHeatGenJ > 0) {
      const maxMeltFilm = Math.min(vessel.moles.H2O_s || 0, Math.max(0.015, nNaLeft * 6.0));
      if (nW < maxMeltFilm) {
        const availMeltJ = naHeatGenJ * 0.55;
        const dMelt = Math.min(
          vessel.moles.H2O_s || 0,
          maxMeltFilm - nW,
          availMeltJ / CONSTANTS.DELTA_H_FUS_WATER_J
        );
        if (dMelt > 1e-10) {
          vessel.moles.H2O_s -= dMelt;
          if (vessel.moles.H2O_s < 1e-12) delete vessel.moles.H2O_s;
          vessel.moles.H2O_l = nW + dMelt;
          localMeltHeatUsedJ = dMelt * CONSTANTS.DELTA_H_FUS_WATER_J;
        }
      }
    }

    const transferJ = Math.max(0, naHeatGenJ - localMeltHeatUsedJ - cNa * (newTNa - tNaPrev));
    reactionHeatJ += transferJ;

    const kEsc = 0.08;
    const escRate = kEsc * areaSurfCm2;
    const dec = Math.exp(-escRate * dt);
    const localIn = escRate * dt > 1e-6 ? naH2ProducedMol * ((1 - dec) / (escRate * dt)) : naH2ProducedMol;
    const newLocalH2 = Math.max(0, (vessel.localH2Mol || 0) * dec + localIn);

    vessel.naTempK = newTNa;
    vessel.naPinned = areaSurfCm2 < 15.0 && xEtOH <= 0.35;
    vessel.naIgnited = newTNa >= 680.0 && xEtOH <= 0.35;
    vessel.localH2Mol = newLocalH2;

    // Exp 18: Asymmetric H2 jetting + surface-tension Marangoni propulsion & Phenolphthalein wake trail
    vessel.naWakeTrail = vessel.naWakeTrail || [];
    for (const wp of vessel.naWakeTrail) wp.age += dt;
    vessel.naWakeTrail = vessel.naWakeTrail.filter((wp) => wp.age < wp.maxLife);
    if (liquidVolL > 1e-6 && newTNa >= 340.0) {
      const spanScale = vessel.naPinned ? 0.38 : Math.min(2.8, Math.max(0.85, Math.sqrt(areaSurfCm2 / 25.0)));
      if (typeof vessel.naVelX !== 'number' || Math.abs(vessel.naVelX) < 0.25) {
        vessel.naVelX = (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 0.9);
      }
      if (Math.random() < 4.5 * dt) {
        vessel.naVelX = (Math.random() < 0.5 ? -1 : 1) * (1.1 + Math.random() * 1.9);
      }
      let nextPos = (vessel.naPosRatio ?? 0.5) + vessel.naVelX * spanScale * dt;
      if (nextPos < 0.09) {
        nextPos = 0.09 + (0.09 - nextPos) * 0.5;
        vessel.naVelX = Math.abs(vessel.naVelX);
      } else if (nextPos > 0.91) {
        nextPos = 0.91 - (nextPos - 0.91) * 0.5;
        vessel.naVelX = -Math.abs(vessel.naVelX);
      }
      vessel.naPosRatio = nextPos;
      vessel._naWakeAccum = (vessel._naWakeAccum || 0) + dt;
      const prevWake = vessel.naWakeTrail[vessel.naWakeTrail.length - 1];
      if (vessel._naWakeAccum >= 0.035 || !prevWake || Math.abs(nextPos - prevWake.pos) >= 0.015) {
        vessel._naWakeAccum = 0;
        vessel.naWakeTrail.push({ pos: nextPos, age: 0, maxLife: 1.8 });
        if (vessel.naWakeTrail.length > 26) vessel.naWakeTrail.shift();
      }
    }

    if (vessel.naIgnited || isDirectHazard) {
      const confinement = Math.max(1.0, 22.0 / Math.max(areaSurfCm2, 1.0));
      const blastEnergyJ = newLocalH2 * 241800 * Math.min(confinement, 5.0);
      // Tiny Na droplets (e.g. 0.05 g) produce < ~765 J total combustion -> flame/sparks ONLY, never shatter Borosilicate!
      const blastLimitJ = isDirectHazard ? 220.0 : 1150.0;
      if (blastEnergyJ > blastLimitJ || (isDirectHazard && newTNa >= 450.0)) {
        naEvent = 'explosion';
        if (isDirectHazard) vessel.naHazardFlag = true;
      } else {
        naEvent = 'ignition_flame';
      }
    } else if (naH2ProducedMol > 0) {
      naEvent = 'fizzing';
    }
  } else {
    reactionHeatJ += naHeatGenJ;
    vessel.naTempK = null;
    vessel.naPinned = false;
    vessel.naIgnited = false;
    vessel.localH2Mol = 0;
    if (Array.isArray(vessel.naWakeTrail) && vessel.naWakeTrail.length > 0) {
      for (const wp of vessel.naWakeTrail) wp.age += dt;
      vessel.naWakeTrail = vessel.naWakeTrail.filter((wp) => wp.age < wp.maxLife);
    }
  }

  // 4. Reversible [CuCl4]2-, amphoteric Cu(OH)2/Ag2O, chloro-silver/cuprous, ammine complexes, carbonate CO2 equilibria, Nernst extraction & chemisorption/garden equilibria
  if (computeIceMobilityFactor(vessel) > 0) {
    reactionHeatJ += stepCarbonateAndCO2Equilibria(vessel, liquidVolL, dt, activeReactions, gasProduced);
    reactionHeatJ += stepChlorocuprateEquilibrium(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepAmphotericHydroxideEquilibria(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepChloroSilverAndCuprousEquilibria(vessel, liquidVolL, dt, activeReactions);
    reactionHeatJ += stepAmmineComplexEquilibria(vessel, liquidVolL, dt, activeReactions);
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

  // 7. Ambient atmosphere surface reactions: Na surface oxide tarnishing, Na dry burn glow, humid-air NaOH deliquescence & open CaO cooling carbonation
  const atmMode = options.environment?.atmosphereMode || 'air';
  if ((vessel.znCombustionTimer || 0) > 0) {
    vessel.znCombustionTimer = Math.max(0, vessel.znCombustionTimer - dt);
  }
  if ((vessel.naDryBurnTimer || 0) > 0) {
    vessel.naDryBurnTimer = Math.max(0, vessel.naDryBurnTimer - dt);
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

  return {
    reactionHeatJ,
    gasProduced,
    activeReactions,
    naEvent,
  };
}
