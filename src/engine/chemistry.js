import { CONSTANTS } from '../data/constants.js';
import { APPARATUS } from '../data/apparatus.js';
import { SPECIES } from '../data/species.js';
import { REACTIONS } from '../data/reactions.js';
import { computeLiquidVolumeL, computeSolidVolumeMl } from './equilibrium.js';

/**
 * Arrhenius factor relative to 298.15 K.
 */
function arrheniusFactor(eaJ, tempK) {
  const T = Math.max(240, Math.min(1200, tempK));
  const expo = (-eaJ / CONSTANTS.R_J_MOL_K) * (1 / T - 1 / CONSTANTS.T_STD_K);
  return Math.exp(Math.max(-20, Math.min(20, expo)));
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
 * Compute raw reaction velocity v_r (mol of reaction extent / s) at current state.
 */
function computeReactionRate(rxn, vessel, liquidVolL) {
  const moles = vessel.moles;
  const T = vessel.tempK;
  const stirBoost = vessel.stirTimer > 0 ? 3.2 : 1.0;

  // Check reactant availability
  for (const [spId, stoich] of Object.entries(rxn.reactants)) {
    if ((moles[spId] || 0) <= 1e-12) return 0;
  }

  // Ensure aqueous environment exists for non-dry reactions
  const hasWater = (moles.H2O_l || 0) > 1e-7 && liquidVolL > 1e-6;

  if (rxn.type === 'dissolution') {
    if (!hasWater) return 0;
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
    return k * area * undersaturation * stirBoost * gardenSlow * 80;
  }

  if (rxn.type === 'ionic_fast') {
    if (!hasWater) return 0;
    if (rxn.id === 'dissolve_cuso4_2hcl' && liquidVolL < 0.0004) return 0;
    if (rxn.maxOhConc !== undefined) {
      const ohConc = (moles.OH_aq || 0) / liquidVolL;
      if (ohConc > rxn.maxOhConc) return 0;
    }
    // Limiting reactant extent in moles
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    if (minExtent <= 1e-12 || !Number.isFinite(minExtent)) return 0;

    // Homogeneous ionic reactions are activation/collision controlled -> unaffected by stirring
    const kRelax = rxn.kRelax298 * arrheniusFactor(rxn.eaJ, T);
    return minExtent * kRelax;
  }

  if (rxn.type === 'amphoteric_base') {
    if (!hasWater) return 0;
    const ohConc = (moles.OH_aq || 0) / liquidVolL;
    if (ohConc < rxn.minOhConc) return 0;
    const nSolid = moles.ZnOH2_s || 0;
    const excessFactor = Math.min(4.0, (ohConc - rxn.minOhConc) * 1.6);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T) * stirBoost;
    return Math.min(nSolid, (moles.OH_aq || 0) / 2) * k * excessFactor;
  }

  if (rxn.type === 'acid_dissolve_precipitate') {
    if (!hasWater) return 0;
    const hConc = (moles.H_aq || 0) / liquidVolL;
    if (hConc < 1e-5) return 0;
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T) * stirBoost;
    return minExtent * k * Math.min(2.5, 0.35 + hConc);
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
        const waterFrac = Math.min(1.0, (moles.H2O_l || 0) / 0.1);
        return k * area * waterFrac;
      }
      const aqConc = (moles[rxn.aqueousId] || 0) / liquidVolL;
      if (rxn.minAqConc && aqConc < rxn.minAqConc) return 0;
      const concFactor = Math.pow(Math.min(14.0, aqConc), 1.05);
      return k * area * concFactor * (vessel.stirTimer > 0 ? 2.4 : 1.0) * 3.5;
    }

    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T);
    const aqConc = (moles[rxn.aqueousId] || 0) / liquidVolL;
    if (rxn.minAqConc && aqConc < rxn.minAqConc) return 0;

    // Effective kinetic order with mild saturation at very high acid molarity
    const concFactor = Math.pow(Math.min(14.0, aqConc), 1.05);
    // Noyes-Whitney diffusion boundary layer thinning when stirred
    return k * area * concFactor * (vessel.stirTimer > 0 ? 2.6 : 1.0) * 3.5;
  }

  if (rxn.type === 'thermal_decomposition') {
    if (rxn.requiresDry && hasWater && (moles.H2O_l || 0) > 1e-4) return 0;
    if (T < rxn.minTempK) return 0;
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    const k = rxn.kAtThreshold * arrheniusFactor(rxn.eaJ, T - rxn.minTempK + CONSTANTS.T_STD_K);
    return minExtent * k;
  }

  if (rxn.type === 'solid_state') {
    if ((moles.H2O_l || 0) >= 0.01 || (moles.C2H5OH_l || 0) >= 0.01) return 0;
    const nNa = moles.Na_s || 0;
    const area = computeSolidSurfaceAreaM2('Na_s', nNa, vessel.particleCounts?.Na_s ?? 1);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T);
    const naohMol = moles.NaOH_s || 0;
    return k * Math.max(1e-5, area) * Math.min(3.5, 0.4 + naohMol * 18) * stirBoost * 4.5;
  }

  if (rxn.type === 'heterogeneous_rapid') {
    if (!hasWater) return 0;
    let minExtent = Infinity;
    for (const [spId, stoich] of Object.entries(rxn.reactants)) {
      minExtent = Math.min(minExtent, (moles[spId] || 0) / stoich);
    }
    return minExtent * rxn.kRelax298 * arrheniusFactor(rxn.eaJ, T);
  }

  if (rxn.type === 'lucas_sn2') {
    if (!hasWater || T < rxn.minTempK) return 0;
    const cZn = (moles.Zn2_aq || 0) / liquidVolL;
    const cCl = (moles.Cl_aq || 0) / liquidVolL;
    const cH = (moles.H_aq || 0) / liquidVolL;
    if (cZn < rxn.minZnConc || cCl < rxn.minClConc || cH < rxn.minHConc) return 0;
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T);
    const catBoost = Math.min(3.5, cZn / rxn.minZnConc) * Math.min(2.5, cCl / rxn.minClConc);
    return (moles.C2H5OH_l || 0) * k * catBoost;
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
    if (!hasWater) return 0;
    const nW = moles.H2O_l || 0;
    const nE = moles.C2H5OH_l || 0;
    const nEtho = moles.C2H5O_aq || 0;
    const nTotBase = (moles.OH_aq || 0) + nEtho;
    if (nEtho <= 1e-10 || nTotBase <= 1e-10) return 0;
    const xEtOH = nE / Math.max(1e-9, nW + nE);
    const maxEthoKeepFrac = Math.min(0.65, 1.35 * xEtOH);
    const excessEtho = nEtho - nTotBase * maxEthoKeepFrac;
    if (excessEtho <= 1e-11) return 0;
    return Math.min(excessEtho, nW) * rxn.kRelax298 * arrheniusFactor(rxn.eaJ, T);
  }

  if (rxn.type === 'cu_comprop_complex' || rxn.type === 'cu_comprop_free') {
    if (!hasWater || T < rxn.minTempK) return 0;
    const cCl = (moles.Cl_aq || 0) / liquidVolL;
    if (cCl < rxn.minClConc) return 0;
    const area = computeSolidSurfaceAreaM2('Cu_s', moles.Cu_s || 0, vessel.particleCounts?.Cu_s ?? 8);
    const cuSrc = rxn.type === 'cu_comprop_complex' ? moles.CuCl4_2_aq || 0 : moles.Cu2_aq || 0;
    const cCuSrc = cuSrc / liquidVolL;
    return rxn.k298 * arrheniusFactor(rxn.eaJ, T) * area * Math.min(3.0, cCuSrc * 4.0) * stirBoost * 4.0;
  }

  if (rxn.type === 'brass_plating') {
    if (!hasWater || T < rxn.minTempK) return 0;
    if ((moles.ZnOH4_2_aq || 0) < 1e-5) return 0;
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    if (cOH < rxn.minOhConc) return 0;
    const areaCu = computeSolidSurfaceAreaM2('Cu_s', moles.Cu_s || 0, 8);
    const cZincate = (moles.ZnOH4_2_aq || 0) / liquidVolL;
    return rxn.k298 * arrheniusFactor(rxn.eaJ, T) * Math.max(1e-5, areaCu) * Math.min(3.5, 0.8 + cZincate * 8) * 18.0;
  }

  if (rxn.type === 'alkali_nitrate_red') {
    if (!hasWater || T < rxn.minTempK) return 0;
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    const cNO3 = (moles.NO3_aq || 0) / liquidVolL;
    if (cOH < rxn.minOhConc || cNO3 < 0.005) return 0;
    const area = computeSolidSurfaceAreaM2('Zn_s', moles.Zn_s || 0, vessel.particleCounts?.Zn_s ?? 8);
    return rxn.k298 * arrheniusFactor(rxn.eaJ, T) * area * Math.min(4.0, cNO3 * 3.0) * Math.min(3.0, cOH / 2.5) * stirBoost * 8.0;
  }

  if (rxn.type === 'moist_solid_redox') {
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
    if (!hasWater) return 0;
    const cH = (moles.H_aq || 0) / liquidVolL;
    const cCl = (moles.Cl_aq || 0) / liquidVolL;
    const cNO3 = (moles.NO3_aq || 0) / liquidVolL;
    if (cH < 4.0 || cCl < 4.0 || cNO3 < 0.20) return 0;
    const solidId = rxn.reactants.Cu_s ? 'Cu_s' : 'Ag_s';
    const area = computeSolidSurfaceAreaM2(solidId, moles[solidId] || 0, 8);
    const oxDrive = Math.min(4.0, (cH / 5.0) * (cCl / 5.0) * (cNO3 / 0.3));
    return rxn.k298 * arrheniusFactor(rxn.eaJ, T) * Math.max(1e-5, area) * oxDrive * stirBoost * 12.0;
  }

  return 0;
}

/**
 * Crystallization of dissolved salts when solution becomes supersaturated
 * (e.g., during boiling/evaporation or cooling).
 */
function applySupersaturationCrystallization(vessel, dt) {
  const moles = vessel.moles;
  const nH2O = moles.H2O_l || 0;
  const waterMassKg = (nH2O * SPECIES.H2O_l.molarMass) / 1000;
  const etohMassKg = ((moles.C2H5OH_l || 0) * SPECIES.C2H5OH_l.molarMass) / 1000;
  const T = vessel.tempK;

  const crystallizePairs = [
    {
      cat: 'Ag_aq',
      an: 'NO3_aq',
      solid: 'AgNO3_s',
      sol298: 15.0,
      coeff: 0.018,
      etohRel: 0.05,
      deltaHJ: -22600,
    },
    {
      cat: 'Na_aq',
      an: 'OH_aq',
      solid: 'NaOH_s',
      sol298: 27.5,
      coeff: 0.012,
      etohRel: 0.12,
      // Differential enthalpy of crystallization from saturated liquor is modest (~8 kJ/mol)
      deltaHJ: +8000,
    },
  ];

  let heatJ = 0;

  for (const pair of crystallizePairs) {
    const nPair = Math.min(moles[pair.cat] || 0, moles[pair.an] || 0);
    if (nPair <= 1e-11) continue;
    const effectiveSolventKg = waterMassKg + (pair.etohRel || 0) * etohMassKg;
    const maxSol =
      effectiveSolventKg > 1e-8
        ? pair.sol298 * Math.exp(pair.coeff * (T - CONSTANTS.T_STD_K)) * effectiveSolventKg
        : 0;
    if (nPair > maxSol) {
      const excess = nPair - maxSol;
      const dXi = Math.min(excess, excess * Math.min(1, 2.0 * dt));
      if (dXi > 1e-12) {
        moles[pair.cat] -= dXi;
        moles[pair.an] -= dXi;
        moles[pair.solid] = (moles[pair.solid] || 0) + dXi;
        heatJ += -pair.deltaHJ * dXi;
      }
    }
  }

  // CuSO4 crystallization: forms pentahydrate if enough H2O, otherwise anhydrous white CuSO4
  // Also strongly salted out by Ethanol cosolvent (e.g. pouring Phenolphthalein 1%)
  const nCuPair = Math.min(moles.Cu2_aq || 0, moles.SO4_2_aq || 0);
  if (nCuPair > 1e-11) {
    const totalSolvKg = waterMassKg + etohMassKg;
    const etohWtFrac = totalSolvKg > 1e-9 ? etohMassKg / totalSolvKg : 0;
    const saltingFactor = etohWtFrac > 0.05 ? Math.exp(-4.8 * etohWtFrac) : 1.0;
    const maxSolCu =
      waterMassKg > 1e-8
        ? 1.43 * saltingFactor * Math.exp(0.016 * (T - CONSTANTS.T_STD_K)) * waterMassKg
        : 0;
    if (nCuPair > maxSolCu) {
      const excess = nCuPair - maxSolCu;
      const dXi = Math.min(excess, excess * Math.min(1, 5.0 * dt));
      if (dXi > 1e-12) {
        if ((moles.H2O_l || 0) >= 5 * dXi && T < 383.15) {
          moles.Cu2_aq -= dXi;
          moles.SO4_2_aq -= dXi;
          moles.H2O_l -= 5 * dXi;
          moles.CuSO4_5H2O_s = (moles.CuSO4_5H2O_s || 0) + dXi;
          heatJ += 11700 * dXi;
        } else {
          moles.Cu2_aq -= dXi;
          moles.SO4_2_aq -= dXi;
          moles.CuSO4_s = (moles.CuSO4_s || 0) + dXi;
          heatJ += -66500 * dXi;
        }
      }
    }
  }

  return heatJ;
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
    let dXi = (targetComp - nCuC) * Math.min(1, 3.2 * dt);
    if (dXi > 0) dXi = Math.min(dXi, nCuS, (moles.OH_aq || 0) / 2);
    else dXi = Math.max(dXi, -nCuC);

    if (Math.abs(dXi) > 1e-13) {
      moles.CuOH2_s = nCuS - dXi;
      moles.OH_aq = (moles.OH_aq || 0) - 2 * dXi;
      moles.CuOH4_2_aq = nCuC + dXi;
      if (moles.CuOH2_s < 1e-13) delete moles.CuOH2_s;
      if (moles.OH_aq < 1e-13) delete moles.OH_aq;
      if (moles.CuOH4_2_aq < 1e-13) delete moles.CuOH4_2_aq;
      heatJ += -15000 * dXi;
      if (Math.abs(dXi / Math.max(1e-4, dt)) > 1e-4) {
        activeReactions.push({
          id: 'amphoteric_cuoh2',
          equation: 'Cu(OH)₂(s) + 2OH⁻(đặc) ⇌ [Cu(OH)₄]²⁻(aq)',
          nameVi: 'Lưỡng tính Cu(OH)₂ tạo phức xanh thẫm [Cu(OH)₄]²⁻',
          nameEn: 'Amphoteric dissolution of Cu(OH)₂ in super-concentrated alkali',
          descVi: 'Trong kiềm siêu đặc (>8 M), Cu(OH)₂ tan thành phức [Cu(OH)₄]²⁻ xanh tím thẫm; pha loãng lại tách kết tủa.',
          descEn: 'In >8 M NaOH, Cu(OH)₂ dissolves into deep royal-blue [Cu(OH)₄]²⁻ and reprecipitates on dilution.',
          rateMolS: Math.abs(dXi) / Math.max(1e-4, dt),
          vigorousGas: false,
          dXi: Math.abs(dXi),
        });
      }
    }
  }

  // 2. Ag2O(s) + 2OH- + H2O <-> 2[Ag(OH)2]- (colorless complex in >8 M NaOH)
  const nAg2O = moles.Ag2O_s || 0;
  const nAgC = moles.AgOH2_aq || 0;
  const nAgTot = 2 * nAg2O + nAgC;
  if (nAgTot > 1e-11) {
    const eqFrac = cOH > 1.5 ? Math.min(0.86, 0.86 / (1 + Math.pow(6.6 / cOH, 4.0))) : 0;
    const targetAgC = nAgTot * eqFrac;
    let dAg = (targetAgC - nAgC) * Math.min(1, 2.8 * dt); // moles of [Ag(OH)2]-
    if (dAg > 0) dAg = Math.min(dAg, 2 * nAg2O, moles.OH_aq || 0, 2 * (moles.H2O_l || 0));
    else dAg = Math.max(dAg, -nAgC);

    if (Math.abs(dAg) > 1e-13) {
      moles.Ag2O_s = nAg2O - 0.5 * dAg;
      moles.OH_aq = (moles.OH_aq || 0) - dAg;
      moles.H2O_l = (moles.H2O_l || 0) - 0.5 * dAg;
      moles.AgOH2_aq = nAgC + dAg;
      if (moles.Ag2O_s < 1e-13) delete moles.Ag2O_s;
      if (moles.OH_aq < 1e-13) delete moles.OH_aq;
      if (moles.H2O_l < 1e-13) delete moles.H2O_l;
      if (moles.AgOH2_aq < 1e-13) delete moles.AgOH2_aq;
      heatJ += -12000 * dAg;
      if (Math.abs(dAg / Math.max(1e-4, dt)) > 1e-4) {
        activeReactions.push({
          id: 'amphoteric_ag2o',
          equation: 'Ag₂O(s) + 2OH⁻(đặc) + H₂O ⇌ 2[Ag(OH)₂]⁻(aq)',
          nameVi: 'Lưỡng tính Ag₂O tan một phần trong kiềm siêu đặc',
          nameEn: 'Amphoteric dissolution of Ag₂O in super-concentrated NaOH',
          descVi: 'Ag₂O tan một phần trong NaOH siêu đặc tạo [Ag(OH)₂]⁻ không màu và tách ra khi pha loãng.',
          descEn: 'Ag₂O partially dissolves as colorless [Ag(OH)₂]⁻ in >8 M OH⁻ and reprecipitates on dilution.',
          rateMolS: Math.abs(dAg) / Math.max(1e-4, dt),
          vigorousGas: false,
          dXi: Math.abs(dAg),
        });
      }
    }
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
    let dXi = (targetComp - nAgComp) * Math.min(1, 3.8 * dt);
    if (dXi > 0) dXi = Math.min(dXi, nAgCl, moles.Cl_aq || 0);
    else dXi = Math.max(dXi, -nAgComp);

    if (Math.abs(dXi) > 1e-13) {
      moles.AgCl_s = nAgCl - dXi;
      moles.Cl_aq = (moles.Cl_aq || 0) - dXi;
      moles.AgCl2_aq = nAgComp + dXi;
      if (moles.AgCl_s < 1e-13) delete moles.AgCl_s;
      if (moles.Cl_aq < 1e-13) delete moles.Cl_aq;
      if (moles.AgCl2_aq < 1e-13) delete moles.AgCl2_aq;
      heatJ += -18000 * dXi;
      if (Math.abs(dXi / Math.max(1e-4, dt)) > 5e-5) {
        activeReactions.push({
          id: 'agcl_chloro_complex',
          equation: 'AgCl(s) + Cl⁻(đặc) ⇌ [AgCl₂]⁻(aq)',
          nameVi: dXi > 0 ? 'Hòa tan AgCl trong HCl đậm đặc' : 'Tái kết tủa AgCl khi pha loãng',
          nameEn: dXi > 0 ? 'AgCl dissolution in concentrated HCl' : 'AgCl reprecipitation upon dilution',
          descVi: 'Nồng độ Cl⁻ cực cao hòa tan AgCl thành [AgCl₂]⁻ trong suốt; thêm nước làm kết tủa trắng tái sinh.',
          descEn: 'Concentrated Cl⁻ solubilizes AgCl as [AgCl₂]⁻; diluting with water immediately reprecipitates AgCl(s).',
          rateMolS: Math.abs(dXi) / Math.max(1e-4, dt),
          vigorousGas: false,
          dXi: Math.abs(dXi),
        });
      }
    }
  }

  // 2. CuCl(s) + Cl- <-> [CuCl2]- (precipitates white CuCl when [Cl-] drops < 2.5 M)
  const nCuCl = moles.CuCl_s || 0;
  const nCuComp = moles.CuCl2_comp_aq || 0;
  if (nCuCl + nCuComp > 1e-11) {
    const maxCuCl2Conc = cCl > 2.4 ? 1.1 * Math.pow((cCl - 2.4) / 6.0, 1.8) : 0;
    const targetComp = Math.min(nCuCl + nCuComp, maxCuCl2Conc * liquidVolL);
    let dXi = (targetComp - nCuComp) * Math.min(1, 4.2 * dt);
    if (dXi > 0) dXi = Math.min(dXi, nCuCl, moles.Cl_aq || 0);
    else dXi = Math.max(dXi, -nCuComp);

    if (Math.abs(dXi) > 1e-13) {
      moles.CuCl_s = nCuCl - dXi;
      moles.Cl_aq = (moles.Cl_aq || 0) - dXi;
      moles.CuCl2_comp_aq = nCuComp + dXi;
      if (moles.CuCl_s < 1e-13) delete moles.CuCl_s;
      if (moles.Cl_aq < 1e-13) delete moles.Cl_aq;
      if (moles.CuCl2_comp_aq < 1e-13) delete moles.CuCl2_comp_aq;
      heatJ += -16000 * dXi;
      if (Math.abs(dXi / Math.max(1e-4, dt)) > 5e-5) {
        activeReactions.push({
          id: 'cucl_dilution_precipitate',
          equation: '[CuCl₂]⁻(aq) ⇌ CuCl(s)↓ + Cl⁻(aq)',
          nameVi: dXi < 0 ? 'Tách kết tủa trắng CuCl khi pha loãng' : 'Hòa tan CuCl trong HCl đặc',
          nameEn: dXi < 0 ? 'Precipitation of white CuCl(s) upon dilution' : 'Dissolution of CuCl in conc. HCl',
          descVi: 'Pha loãng dung dịch [CuCl₂]⁻ vào lượng nước lớn làm tách ra kết tủa trắng tinh khiết Đồng(I) chloride (CuCl).',
          descEn: 'Diluting [CuCl₂]⁻ lowers [Cl⁻] and precipitates pure white Copper(I) chloride (CuCl).',
          rateMolS: Math.abs(dXi) / Math.max(1e-4, dt),
          vigorousGas: false,
          dXi: Math.abs(dXi),
        });
      }
    }
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
  } else {
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
  let dXi = (targetComp - nComp) * Math.min(1, 3.0 * dt);

  if (dXi > 0) {
    dXi = Math.min(dXi, nCuFree, (moles.Cl_aq || 0) / 4);
  } else {
    dXi = Math.max(dXi, -nComp);
  }
  if (Math.abs(dXi) <= 1e-14) return 0;

  moles.Cu2_aq = nCuFree - dXi;
  moles.Cl_aq = (moles.Cl_aq || 0) - 4 * dXi;
  moles.CuCl4_2_aq = nComp + dXi;
  if (moles.Cu2_aq < 1e-13) delete moles.Cu2_aq;
  if (moles.Cl_aq < 1e-13) delete moles.Cl_aq;
  if (moles.CuCl4_2_aq < 1e-13) delete moles.CuCl4_2_aq;

  if (Math.abs(dXi / Math.max(1e-4, dt)) > 1e-4) {
    activeReactions.push({
      id: 'cu_chloride_complex',
      equation: 'Cu²⁺(aq) + 4Cl⁻(aq) ⇌ [CuCl₄]²⁻(aq)',
      nameVi: 'Tạo phức Tetrachlorocuprate(II)',
      nameEn: 'Tetrachlorocuprate(II) complexation',
      descVi: 'Ion Cu²⁺ kết hợp với Cl⁻ nồng độ cao tạo phức [CuCl₄]²⁻ màu xanh lục vàng.',
      descEn: 'High [Cl⁻] coordinates with Cu²⁺ to form emerald/yellow-green [CuCl₄]²⁻.',
      rateMolS: Math.abs(dXi) / Math.max(1e-4, dt),
      vigorousGas: false,
      dXi: Math.abs(dXi),
    });
  }

  // Forward complexation is slightly endothermic (+18 kJ/mol -> absorbs heat)
  return -18000 * dXi;
}

/**
 * Enforce strict dry phase boundary: when liquid solvent volume reaches 0,
 * zero aqueous (aq) ions may remain — volatile HCl/HNO3/H2O escape as gas and
 * non-volatile ions crystallize cleanly as anhydrous solids with exact mass conservation.
 */
export function enforceDryPhaseBoundary(vessel) {
  const moles = vessel.moles;
  const gasProduced = { HCl_g: 0, H2O_g: 0, HNO3_g: 0 };
  if ((moles.H2O_l || 0) > 1e-7 || (moles.C2H5OH_l || 0) > 1e-7) {
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
  if ((moles.CuCl4_2_aq || 0) > 0) {
    const n = moles.CuCl4_2_aq;
    moles.Cu2_aq = (moles.Cu2_aq || 0) + n;
    moles.Cl_aq = (moles.Cl_aq || 0) + 4 * n;
    delete moles.CuCl4_2_aq;
  }
  if ((moles.CuOH4_2_aq || 0) > 0) {
    const n = moles.CuOH4_2_aq;
    moles.CuOH2_s = (moles.CuOH2_s || 0) + n;
    moles.OH_aq = (moles.OH_aq || 0) + 2 * n;
    delete moles.CuOH4_2_aq;
  }
  if ((moles.AgOH2_aq || 0) > 0) {
    const n = moles.AgOH2_aq;
    moles.Ag2O_s = (moles.Ag2O_s || 0) + 0.5 * n;
    gasProduced.H2O_g += 0.5 * n;
    moles.OH_aq = (moles.OH_aq || 0) + n;
    delete moles.AgOH2_aq;
  }
  if ((moles.AgCl2_aq || 0) > 0) {
    const n = moles.AgCl2_aq;
    moles.AgCl_s = (moles.AgCl_s || 0) + n;
    moles.Cl_aq = (moles.Cl_aq || 0) + n;
    delete moles.AgCl2_aq;
  }
  if ((moles.CuCl2_comp_aq || 0) > 0) {
    const n = moles.CuCl2_comp_aq;
    moles.CuCl_s = (moles.CuCl_s || 0) + n;
    moles.Cl_aq = (moles.Cl_aq || 0) + n;
    delete moles.CuCl2_comp_aq;
  }
  if ((moles.NH3_aq || 0) > 0) {
    gasProduced.NH3_g = (gasProduced.NH3_g || 0) + moles.NH3_aq;
    delete moles.NH3_aq;
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
      // Fallback: Zn(OH)2 + 2 H2O(g) + ... or with remaining H+
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

  // Pair insoluble precipitates & anhydrous salts first, then volatile acids outgas completely
  pairToProduct('Ag_aq', 1, 'Cl_aq', 1, 'AgCl_s', 1, false);
  pairToProduct('Ag_aq', 1, 'NO3_aq', 1, 'AgNO3_s', 1, false);
  pairToProduct('Cu2_aq', 1, 'SO4_2_aq', 1, 'CuSO4_s', 1, false);
  pairToProduct('Cu2_aq', 1, 'OH_aq', 2, 'CuOH2_s', 1, false);
  pairToProduct('Cu2_aq', 1, 'Cl_aq', 2, 'CuCl2_s', 1, false);
  pairToProduct('Cu2_aq', 1, 'NO3_aq', 2, 'CuNO3_2_s', 1, false);
  pairToProduct('Zn2_aq', 1, 'SO4_2_aq', 1, 'ZnSO4_s', 1, false);
  pairToProduct('Zn2_aq', 1, 'Cl_aq', 2, 'ZnCl2_s', 1, false);
  pairToProduct('Zn2_aq', 1, 'NO3_aq', 2, 'ZnNO3_2_s', 1, false);
  pairToProduct('Zn2_aq', 1, 'OH_aq', 2, 'ZnOH2_s', 1, false);
  pairToProduct('Na_aq', 1, 'Cl_aq', 1, 'NaCl_s', 1, false);
  pairToProduct('Na_aq', 2, 'SO4_2_aq', 1, 'Na2SO4_s', 1, false);
  pairToProduct('Na_aq', 1, 'NO3_aq', 1, 'NaNO3_s', 1, false);
  pairToProduct('Na_aq', 1, 'C2H5O_aq', 1, 'C2H5ONa_s', 1, false);
  pairToProduct('Na_aq', 1, 'OH_aq', 1, 'NaOH_s', 1, false);
  pairToProduct('H_aq', 1, 'OH_aq', 1, 'H2O_g', 1, true);
  pairToProduct('H_aq', 1, 'Cl_aq', 1, 'HCl_g', 1, true);
  pairToProduct('H_aq', 1, 'NO3_aq', 1, 'HNO3_g', 1, true);

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
 * Advance all chemical reactions inside one vessel by dt seconds.
 * Guarantees non-negative moles and exact stoichiometry.
 * Returns { reactionHeatJ, gasProduced: {H2_g, O2_g, HCl_g, Cl2_g, H2O_g}, activeReactions: [...] }
 */
export function stepVesselChemistry(vessel, dt) {
  const liquidVolL = computeLiquidVolumeL(vessel.moles, vessel.tempK);

  // 1. Compute raw reaction extents
  const rawExtents = [];
  for (const rxn of REACTIONS) {
    const rate = computeReactionRate(rxn, vessel, liquidVolL);
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
  for (const [spId, dem] of Object.entries(demand)) {
    const avail = Math.max(0, vessel.moles[spId] || 0);
    scaleFactor[spId] = dem > avail && dem > 0 ? avail / dem : 1.0;
  }

  // 3. Apply clamped reaction steps
  let reactionHeatJ = 0;
  let naHeatGenJ = 0;
  let naH2ProducedMol = 0;
  const gasProduced = { H2_g: 0, O2_g: 0, HCl_g: 0, Cl2_g: 0, H2O_g: 0, HNO3_g: 0, C2H5Cl_g: 0, NH3_g: 0, NO2_g: 0, NO_g: 0 };
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

    // Subtract reactants
    for (const [spId, stoich] of Object.entries(item.rxn.reactants)) {
      vessel.moles[spId] = Math.max(0, (vessel.moles[spId] || 0) - stoich * dXi);
      if (vessel.moles[spId] < 1e-14) delete vessel.moles[spId];
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

    // Separate Sodium reaction enthalpy to drive independent metal droplet temperature T_Na
    const rxnHeat = -item.rxn.deltaHJ * dXi;
    if (item.rxn.id === 'na_water' || item.rxn.id === 'na_acid') {
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

  // 3b. Two-temperature coupled Sodium droplet thermal balance & Coulomb/H2 blast trigger
  let naEvent = null;
  const nNaLeft = vessel.moles.Na_s || 0;
  if (nNaLeft > 1e-10 && liquidVolL > 1e-6) {
    const tNaPrev = vessel.naTempK ?? vessel.tempK;
    const pCount = vessel.particleCounts?.Na_s ?? 1;
    const aNaCm2 = Math.max(0.04, computeSolidSurfaceAreaM2('Na_s', nNaLeft, pCount) * 1e4);
    const spec = APPARATUS[vessel.typeId];
    const totMl = liquidVolL * 1000 + computeSolidVolumeMl(vessel.moles);
    const areaSurfCm2 = spec?.geometry
      ? Math.max(0.5, spec.geometry.getLiquidState(totMl).surfaceAreaCm2)
      : spec?.surfaceAreaCm2 || 25.0;

    const cNaOH = (vessel.moles.OH_aq || 0) / Math.max(1e-5, liquidVolL);
    const cH = (vessel.moles.H_aq || 0) / Math.max(1e-5, liquidVolL);
    const cAg = (vessel.moles.Ag_aq || 0) / Math.max(1e-5, liquidVolL);
    const nW = vessel.moles.H2O_l || 0;
    const nE = vessel.moles.C2H5OH_l || 0;
    const xEtOH = nE / Math.max(1e-9, nW + nE);
    const isDirectHazard = (cH >= 6.0 || cAg >= 1.5) && nNaLeft * SPECIES.Na_s.molarMass >= 0.08;

    const effNaFootprint = Math.min(Math.max(aNaCm2, 0.08), 6.0);
    const mobilityFactor = 0.28 + 0.72 * (1 - Math.exp(-0.14 * (areaSurfCm2 / effNaFootprint)));
    const pinHeatLoss = areaSurfCm2 < 15.0 ? 0.42 : 1.0;
    const viscosityDamping = 1 / (1 + 0.55 * cNaOH + 0.35 * cNaOH * cNaOH);
    const hEff = 11.5 * mobilityFactor * pinHeatLoss * viscosityDamping; // W / (cm^2 * K)
    const condWK = Math.max(1e-4, hEff * aNaCm2);

    const mNaG = Math.max(1e-4, nNaLeft * SPECIES.Na_s.molarMass);
    const cNa = Math.max(1e-4, mNaG * (tNaPrev >= 370.95 ? 1.38 : 1.23));
    const qGenW = naHeatGenJ / Math.max(1e-6, dt);
    const tEq = Math.min(1350, vessel.tempK + qGenW / condWK);
    const alpha = condWK / cNa;
    let newTNa = Math.max(250, Math.min(1250, tEq + (tNaPrev - tEq) * Math.exp(-alpha * dt)));
    if (xEtOH > 0.35) {
      newTNa = Math.min(newTNa, 360.0);
    }

    const transferJ = Math.max(0, naHeatGenJ - cNa * (newTNa - tNaPrev));
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
  }

  // 4. Reversible [CuCl4]2-, amphoteric Cu(OH)2/Ag2O, chloro-silver/cuprous, & chemisorption/garden equilibria
  reactionHeatJ += stepChlorocuprateEquilibrium(vessel, liquidVolL, dt, activeReactions);
  reactionHeatJ += stepAmphotericHydroxideEquilibria(vessel, liquidVolL, dt, activeReactions);
  reactionHeatJ += stepChloroSilverAndCuprousEquilibria(vessel, liquidVolL, dt, activeReactions);
  reactionHeatJ += stepChemisorptionAndGarden(vessel, liquidVolL, dt, activeReactions);

  // 5. Supersaturation crystallization (including ethanol salting-out)
  reactionHeatJ += applySupersaturationCrystallization(vessel, dt);

  return {
    reactionHeatJ,
    gasProduced,
    activeReactions,
    naEvent,
  };
}
