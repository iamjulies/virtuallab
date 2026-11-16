import { CONSTANTS } from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { REACTIONS } from '../data/reactions.js';
import { computeLiquidVolumeL } from './equilibrium.js';

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
    const sTemp =
      rxn.solubilityMolPerKg298 *
      Math.exp(rxn.solubilityTempCoeff * (T - CONSTANTS.T_STD_K));
    const maxSoluble = sTemp * effectiveSolventKg;
    const currentIon = moles[rxn.ionCheckId] || 0;
    if (currentIon >= maxSoluble * 0.999) return 0;

    const undersaturation = Math.max(0, 1 - currentIon / Math.max(1e-12, maxSoluble));
    const pCount = vessel.particleCounts?.[rxn.solidId] ?? 12;
    const area = computeSolidSurfaceAreaM2(rxn.solidId, nSolid, pCount);
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T);
    return k * area * undersaturation * stirBoost * 80;
  }

  if (rxn.type === 'ionic_fast') {
    if (!hasWater) return 0;
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
    const k = rxn.k298 * arrheniusFactor(rxn.eaJ, T);

    if (rxn.useWaterContact) {
      // Sodium + liquid water: melts at 370.95 K -> skitters & mixes faster
      const moltenBoost = T >= (SPECIES.Na_s.meltTempK || 370.95) ? 1.85 : 1.0;
      const waterFrac = Math.min(1.0, (moles.H2O_l || 0) / 0.1);
      return k * area * waterFrac * moltenBoost;
    }

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
  const nCuPair = Math.min(moles.Cu2_aq || 0, moles.SO4_2_aq || 0);
  if (nCuPair > 1e-11) {
    const maxSolCu =
      waterMassKg > 1e-8
        ? 1.43 * Math.exp(0.016 * (T - CONSTANTS.T_STD_K)) * waterMassKg
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
  const gasProduced = { H2_g: 0, O2_g: 0, HCl_g: 0, Cl2_g: 0, H2O_g: 0, HNO3_g: 0 };
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

    // Enthalpy: exothermic (deltaH < 0) releases positive heat (+J)
    reactionHeatJ += -item.rxn.deltaHJ * dXi;

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

  // 4. Reversible [CuCl4]2- complexation equilibrium
  reactionHeatJ += stepChlorocuprateEquilibrium(vessel, liquidVolL, dt, activeReactions);

  // 5. Supersaturation crystallization
  reactionHeatJ += applySupersaturationCrystallization(vessel, dt);

  return {
    reactionHeatJ,
    gasProduced,
    activeReactions,
  };
}
