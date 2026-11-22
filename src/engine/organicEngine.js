/**
 * Data-Driven & Property-Driven Organic Solver Engine (Prompt 66).
 * Handles:
 *  - General & reversible kinetics (`type: 'general' | 'reversible'`) with Van 't Hoff Kc(T),
 *    catalyst order, phaseContact acceleration, and proper condensed/gas volume resolution.
 *  - Property-driven general organic combustion (C_x H_y O_z N_t Cl_u Br_w) for complete & O2-starved soot/CO regimes.
 *  - Property-driven qualitative functional group rules (Biuret peptide complex, alkene tests, etc.).
 */

import { CONSTANTS } from '../data/constants.js';
import { APPARATUS } from '../data/apparatus.js';
import { SPECIES } from '../data/species.js';

/**
 * Resolve appropriate effective reaction volume (L) for general/reversible organic steps,
 * avoiding liquidVolL === 0 traps on anhydrous liquid or gas-phase systems.
 */
function resolveReactionVolumeL(rxn, vessel, strat, liquidVolL) {
  const cond = rxn.conditions || {};
  const spIds = [...Object.keys(rxn.reactants || {}), ...Object.keys(rxn.products || {})];
  const hasGasOnly = Object.keys(rxn.reactants || {}).every((id) => SPECIES[id]?.phase === 'g');
  if (hasGasOnly && !cond.preferLiquidVolume) {
    const vesselMaxL = (APPARATUS[vessel.typeId]?.maxVolumeMl || 250) / 1000;
    const liqOccupied = strat?.totalLiqL ?? liquidVolL ?? 0;
    return Math.max(0.02, vesselMaxL - Math.min(vesselMaxL * 0.8, liqOccupied));
  }
  const hasAq = spIds.some((id) => SPECIES[id]?.phase === 'aq');
  if (hasAq && !cond.allowAnhydrous) {
    return Math.max(1e-5, liquidVolL || 0);
  }
  const totalCondensedL = strat?.totalLiqL ?? liquidVolL ?? 0;
  return Math.max(1e-5, totalCondensedL || 0.05);
}

/**
 * Check environmental & kinetic activation conditions + compute catalyst & phase-contact multipliers.
 * Returns signed rate (mol extent / s): positive = forward, negative = reverse (for type: 'reversible').
 */
export function computeGeneralReactionRate(rxn, vessel, strat, liquidVolL, getMolFn, options = {}) {
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  const cond = rxn.conditions || {};
  const kin = rxn.kinetics || {};
  const env = options.environment || {};
  const atmMode = env.atmosphereMode || 'air';

  if (cond.minTempK != null && T < cond.minTempK) return 0;
  if (cond.maxTempK != null && T > cond.maxTempK) return 0;
  if (cond.requiresUv) {
    const hasUv = Boolean(options.uvLight || vessel.uvExposureActive || (options.uvIntensity || 0) > 0);
    if (!hasUv) return 0;
  }
  if (cond.atmosphere === 'inert' && atmMode !== 'inert' && !vessel.isStoppered && vessel.lidState !== 'closed') {
    return 0;
  }
  if (cond.atmosphere === 'air' && atmMode === 'inert' && (getMolFn('O2_g') || 0) <= 1e-9) {
    return 0;
  }

  // Aqueous check only if aqueous species participate and anhydrous mode is not allowed
  const spIds = [...Object.keys(rxn.reactants || {}), ...Object.keys(rxn.products || {})];
  const needsWater = spIds.some((id) => SPECIES[id]?.phase === 'aq' || id === 'H_aq' || id === 'OH_aq') && !cond.allowAnhydrous;
  if (needsWater && ((vessel.moles?.H2O_l || 0) <= 1e-7 || (liquidVolL || 0) <= 1e-6)) {
    return 0;
  }

  const effVolL = resolveReactionVolumeL(rxn, vessel, strat, liquidVolL);

  // Catalyst factor
  let catFactor = 1.0;
  if (Array.isArray(rxn.catalysts) && rxn.catalysts.length > 0) {
    let catMol = 0;
    for (const cId of rxn.catalysts) {
      catMol += getMolFn(cId) || 0;
    }
    if (catMol <= 1e-12) {
      if (!(rxn.uncatalyzedFactor > 0)) return 0;
      catFactor = rxn.uncatalyzedFactor;
    } else {
      const catConc = catMol / effVolL;
      catFactor = Math.min(25.0, Math.pow(catConc, rxn.catalystOrder ?? 1));
    }
  }

  // Interfacial phase-contact acceleration when stirred or emulsified by shaking
  let phaseBoost = 1.0;
  if (cond.phaseContact) {
    const mixed = (vessel.stirTimer || 0) > 0 || (vessel.emulsionTimer || 0) > 0;
    phaseBoost = mixed ? Math.max(vessel.emulsionTimer > 0 ? 5.5 : 1.0, vessel.stirTimer > 0 ? 4.5 : 1.0) : 0.12;
  }

  const R = CONSTANTS.R_J_MOL_K || 8.314462618;
  const tRef = kin.kAtThreshold != null && cond.minTempK != null ? cond.minTempK : (kin.refTempK || CONSTANTS.T_STD_K);
  const kBase = kin.kAtThreshold ?? kin.k298 ?? rxn.k298 ?? 0.1;
  const ea = kin.eaJ ?? rxn.eaJ ?? 0;
  const arrh = ea > 0 ? Math.exp((-ea / R) * (1 / T - 1 / tRef)) : 1.0;
  const kF = kBase * Math.min(1e6, arrh);

  // Instant kinetics return sentinel positive rate if all reactants exist
  if (kin.type === 'instant') {
    for (const spId of Object.keys(rxn.reactants || {})) {
      if ((getMolFn(spId) || 0) <= 1e-12) return 0;
    }
    return 1.0;
  }

  // Forward rate (allowed to be 0 if any reactant is 0 while reversible evaluates reverse)
  let hasAllReactants = true;
  let termF = 1.0;
  for (const [spId, stoich] of Object.entries(rxn.reactants || {})) {
    const nAvail = getMolFn(spId) || 0;
    if (nAvail <= 1e-12) {
      hasAllReactants = false;
      break;
    }
    const order = kin.orders?.[spId] ?? stoich;
    termF *= Math.pow(nAvail / effVolL, order);
  }
  const vF = hasAllReactants ? kF * effVolL * termF * catFactor * phaseBoost : 0;

  if (rxn.type === 'reversible' || kin.type === 'reversible') {
    const kcRef = kin.Kc298 ?? kin.Kc ?? 1.0;
    const dH = kin.deltaHJ ?? rxn.deltaHJ ?? 0;
    const Kc = Math.max(1e-6, kcRef * Math.exp((-dH / R) * (1 / T - 1 / 298.15)));
    const kR = kF / Kc;

    let hasAllProducts = true;
    let termR = 1.0;
    for (const [spId, stoich] of Object.entries(rxn.products || {})) {
      const nAvail = getMolFn(spId) || 0;
      if (nAvail <= 1e-12) {
        hasAllProducts = false;
        break;
      }
      const revOrder = kin.reverseOrders?.[spId] ?? stoich;
      termR *= Math.pow(nAvail / effVolL, revOrder);
    }
    const vR = hasAllProducts ? kR * effVolL * termR * catFactor * phaseBoost : 0;
    return vF - vR;
  }

  return vF;
}

/**
 * Helper: deduct consumed O2_g cleanly across headspace gas, stoppered trapped air, or submerged air.
 */
function consumeO2Pool(vessel, amountMol, env) {
  const headAvail = vessel.headspaceGasMoles?.O2_g || 0;
  const fromHead = Math.min(headAvail, amountMol);
  if (fromHead > 0) {
    vessel.headspaceGasMoles.O2_g = Math.max(0, headAvail - fromHead);
  }
  const rem = amountMol - fromHead;
  if (rem > 0) {
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
}

/**
 * Property-Driven General Organic Combustion Solver:
 * Automatically computes balanced complete combustion (CO2 + H2O + N2/HX) vs
 * O2-starved incomplete combustion (CO + C_s soot) from species `atoms`, `autoIgnitionK`, and `dHCombustJ`.
 */
export function stepGeneralOrganicCombustion(vessel, dt, activeReactions, gasProduced, getMolFn, options = {}) {
  if (vessel.isFrozenSolid || dt <= 0) return 0;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  const moles = vessel.moles;
  const head = vessel.headspaceGasMoles || {};
  let heatJ = 0;

  let o2Avail = getMolFn('O2_g') || 0;
  if (o2Avail <= 1e-9) return 0;

  const candidateIds = new Set([...Object.keys(moles), ...Object.keys(head)]);
  for (const spId of candidateIds) {
    const sp = SPECIES[spId];
    if (!sp || !sp.atoms || !(sp.atoms.C > 0) || !(sp.autoIgnitionK > 0)) continue;
    if (T < sp.autoIgnitionK) continue;

    const isGas = sp.phase === 'g';
    const inHead = isGas ? (head[spId] || 0) : 0;
    const inMoles = moles[spId] || 0;
    const fuelAvail = isGas ? inHead + inMoles : inMoles;
    if (fuelAvail <= 1e-9 || o2Avail <= 1e-9) continue;

    const a = sp.atoms;
    const cCount = a.C || 0;
    const hCount = a.H || 0;
    const oCount = a.O || 0;
    const nCount = a.N || 0;
    const clCount = a.Cl || 0;
    const brCount = a.Br || 0;

    const remH = Math.max(0, hCount - clCount - brCount);
    const h2oPerMol = remH / 2;
    const o2Complete = Math.max(0.25, cCount + h2oPerMol / 2 - oCount / 2);

    const kBurn = sp.phase === 'g' ? 2.4 : sp.phase === 'l' ? 1.6 : 0.9;
    let dFuelTarget = fuelAvail * (1 - Math.exp(-kBurn * dt));
    if (dFuelTarget <= 1e-11) continue;

    const o2NeededFull = dFuelTarget * o2Complete;
    const o2RatioTotal = o2Avail < 5.0 ? o2Avail / Math.max(1e-12, fuelAvail * o2Complete) : 1.0;
    let nuO2 = o2Complete;
    let xCO2 = cCount;
    let xCO = 0;
    let xSoot = 0;

    if (o2Avail < o2NeededFull * 0.98 || o2RatioTotal < 0.92) {
      // O2-starved incomplete combustion: shift toward CO + C_s soot while strictly conserving C, H, O
      const minNuO2 = Math.max(0.15, (h2oPerMol + 0.35 * cCount - oCount) / 2);
      const targetNu = o2RatioTotal < 0.92 ? Math.max(minNuO2, o2Complete * o2RatioTotal) : o2Complete;
      const possibleNu = o2Avail / dFuelTarget;
      if (possibleNu < minNuO2) {
        dFuelTarget = Math.min(dFuelTarget, o2Avail / minNuO2);
        nuO2 = minNuO2;
      } else {
        nuO2 = Math.min(targetNu, possibleNu);
      }
      const availOAtoms = 2 * nuO2 + oCount;
      const remO = Math.max(0, availOAtoms - h2oPerMol);
      if (remO >= cCount) {
        xCO2 = Math.max(0, remO - cCount);
        xCO = Math.max(0, 2 * cCount - remO);
        xSoot = 0;
      } else {
        xCO2 = 0;
        xCO = remO;
        xSoot = Math.max(0, cCount - remO);
      }
    }

    const dFuel = Math.min(fuelAvail, dFuelTarget, o2Avail / nuO2);
    if (dFuel <= 1e-11) continue;

    // Deduct fuel cleanly
    if (isGas) {
      const fromH = Math.min(inHead, dFuel);
      if (fromH > 0) head[spId] = Math.max(0, inHead - fromH);
      const fromM = dFuel - fromH;
      if (fromM > 0) {
        moles[spId] = Math.max(0, inMoles - fromM);
        if (moles[spId] < 1e-14) delete moles[spId];
      }
    } else {
      moles[spId] = Math.max(0, inMoles - dFuel);
      if (moles[spId] < 1e-14) delete moles[spId];
    }

    const dO2Used = dFuel * nuO2;
    consumeO2Pool(vessel, dO2Used, options.environment);
    o2Avail = Math.max(0, o2Avail - dO2Used);

    if (xCO2 > 1e-9) gasProduced.CO2_g = (gasProduced.CO2_g || 0) + xCO2 * dFuel;
    if (xCO > 1e-9) gasProduced.CO_g = (gasProduced.CO_g || 0) + xCO * dFuel;
    if (h2oPerMol > 1e-9) gasProduced.H2O_g = (gasProduced.H2O_g || 0) + h2oPerMol * dFuel;
    if (nCount > 0) gasProduced.N2_g = (gasProduced.N2_g || 0) + (nCount / 2) * dFuel;
    if (clCount > 0) gasProduced.HCl_g = (gasProduced.HCl_g || 0) + clCount * dFuel;
    if (brCount > 0) gasProduced.HBr_g = (gasProduced.HBr_g || 0) + brCount * dFuel;
    if (xSoot > 1e-9) {
      moles.C_s = (moles.C_s || 0) + xSoot * dFuel;
      if (!vessel.particleCounts) vessel.particleCounts = {};
      vessel.particleCounts.C_s = Math.max(vessel.particleCounts.C_s || 0, 260);
    }

    const baseHeat = Math.abs(sp.dHCombustJ || 1400000);
    const completeness = Math.min(1.0, Math.max(0.25, nuO2 / o2Complete));
    heatJ += dFuel * baseHeat * completeness;

    const incompleteTag = xSoot > 1e-6 || xCO > 1e-6;
    activeReactions.push({
      id: `combust_${spId}${incompleteTag ? '_incomplete' : ''}`,
      equation: incompleteTag
        ? `${sp.formula || spId} + O₂ → CO↑ + C(muội) + H₂O↑`
        : `${sp.formula || spId} + O₂ → CO₂↑ + H₂O↑`,
      nameVi: incompleteTag
        ? `Đốt cháy thiếu O₂ ${sp.name} sinh muội than C & CO`
        : `Đốt cháy hoàn toàn ${sp.name}`,
      nameEn: incompleteTag
        ? `O₂-starved incomplete combustion of ${sp.name} yielding CO & carbon soot`
        : `Complete combustion of ${sp.name}`,
      descVi: incompleteTag
        ? 'Thiếu Oxygen nên nhiên liệu cháy không hoàn toàn tạo khói muội than và khí CO.'
        : 'Cháy tỏa nhiệt mạnh trong Oxygen/không khí tạo CO₂ và hơi nước.',
      descEn: incompleteTag
        ? 'Oxygen deficit shifts combustion toward toxic CO gas and black carbon soot.'
        : 'Exothermic complete oxidation yielding CO₂ and H₂O vapor.',
      rateMolS: dFuel / dt,
      vigorousGas: true,
      dXi: dFuel,
    });
  }

  return heatJ;
}

/**
 * Property-Driven Functional Group Qualitative Rules Engine:
 * Evaluates species carrying `functionalGroups` flags (`hasPeptideBond`, general `isAlkene`, etc.)
 * without duplicating reagent-specific handlers for legacy organic species.
 */
export function stepFunctionalGroupTests(vessel, strat, liquidVolL, dt, activeReactions, options = {}) {
  if (vessel.isFrozenSolid || dt <= 0) return 0;
  const moles = vessel.moles;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  const hasWater = (moles.H2O_l || 0) > 1e-7 && (liquidVolL || 0) > 1e-6;
  let heatJ = 0;

  for (const spId of Object.keys(moles)) {
    const sp = SPECIES[spId];
    const fg = sp?.functionalGroups;
    const nSp = moles[spId] || 0;
    if (!fg || nSp <= 1e-9) continue;

    // 1. Biuret peptide-bond test: Polypeptide(aq) + Cu(OH)2(s) / [Cu2+ + 2 OH-] -> deep violet CuPeptide_aq
    if (fg.hasPeptideBond && sp.phase === 'aq' && hasWater && (moles.OH_aq || 0) > 1e-5) {
      if ((moles.CuOH2_s || 0) > 1e-8) {
        const dBiu = Math.min(moles.CuOH2_s, nSp / 2) * (1 - Math.exp(-1.8 * dt));
        if (dBiu > 1e-11) {
          moles.CuOH2_s = Math.max(0, moles.CuOH2_s - dBiu);
          if (moles.CuOH2_s < 1e-13) delete moles.CuOH2_s;
          moles[spId] = Math.max(0, moles[spId] - 2 * dBiu);
          if (moles[spId] < 1e-13) delete moles[spId];
          moles.CuPeptide_aq = (moles.CuPeptide_aq || 0) + dBiu;
          heatJ += dBiu * 28000;
          activeReactions.push({
            id: `biuret_${spId}`,
            equation: '2 Polypeptide + Cu(OH)₂ —(OH⁻)→ [Cu(Peptide)₂] (tím biuret)',
            nameVi: 'Phản ứng màu Biuret tạo phức tím với Cu(OH)₂/OH⁻',
            nameEn: 'Biuret reaction of peptide bonds forming violet Cu²⁺–peptide complex',
            descVi: 'Các liên kết peptide (–CO–NH–) hòa tan Cu(OH)₂ trong kiềm tạo phức màu tím đặc trưng.',
            descEn: 'Peptide bonds coordinate Cu(OH)₂ in alkaline solution producing deep violet Biuret color.',
            rateMolS: dBiu / dt,
            dXi: dBiu,
          });
        }
      } else if ((moles.Cu2_aq || 0) > 1e-8 && (moles.OH_aq || 0) > 2e-8) {
        const dBiu2 = Math.min(moles.Cu2_aq, moles.OH_aq / 2, (moles[spId] || 0) / 2) * (1 - Math.exp(-1.5 * dt));
        if (dBiu2 > 1e-11) {
          moles.Cu2_aq = Math.max(0, moles.Cu2_aq - dBiu2);
          if (moles.Cu2_aq < 1e-13) delete moles.Cu2_aq;
          moles.OH_aq = Math.max(0, moles.OH_aq - 2 * dBiu2);
          if (moles.OH_aq < 1e-13) delete moles.OH_aq;
          moles[spId] = Math.max(0, moles[spId] - 2 * dBiu2);
          if (moles[spId] < 1e-13) delete moles[spId];
          moles.CuPeptide_aq = (moles.CuPeptide_aq || 0) + dBiu2;
          heatJ += dBiu2 * 32000;
          activeReactions.push({
            id: `biuret_cu2_${spId}`,
            equation: '2 Polypeptide + Cu²⁺ + 2OH⁻ → [Cu(Peptide)₂] (tím biuret)',
            nameVi: 'Phản ứng màu Biuret trong dung dịch Cu²⁺/OH⁻',
            nameEn: 'Alkaline Biuret complexation of Cu²⁺ with peptide bonds',
            descVi: 'Phản ứng nhận biết từ 2 liên kết peptide trở lên qua phức màu tím đặc trưng.',
            descEn: 'Characteristic violet complex identifying peptide bonds.',
            rateMolS: dBiu2 / dt,
            dXi: dBiu2,
          });
        }
      }
    }

    // 2. General alkene aqueous Br2 decolorization (e.g. Hex-1-ene + Br2_aq when stirred)
    if (fg.isAlkene && !fg.legacyHandled && hasWater && (moles.Br2_aq || 0) > 1e-8) {
      const kBrAq = ((vessel.stirTimer || 0) > 0 || (vessel.emulsionTimer || 0) > 0) ? 1.4 : 0.22;
      const dAlkBr = Math.min(moles[spId] || 0, moles.Br2_aq) * (1 - Math.exp(-kBrAq * dt));
      if (dAlkBr > 1e-11 && SPECIES[`${spId.replace(/_l$/, '')}Br2_l`]) {
        const prodId = `${spId.replace(/_l$/, '')}Br2_l`;
        moles[spId] = Math.max(0, moles[spId] - dAlkBr);
        if (moles[spId] < 1e-13) delete moles[spId];
        moles.Br2_aq = Math.max(0, moles.Br2_aq - dAlkBr);
        if (moles.Br2_aq < 1e-13) delete moles.Br2_aq;
        moles[prodId] = (moles[prodId] || 0) + dAlkBr;
        heatJ += dAlkBr * 112000;
        activeReactions.push({
          id: `alkene_br2aq_${spId}`,
          equation: `${sp.formula || spId} + Br₂(aq) → ${SPECIES[prodId].formula}`,
          nameVi: `${sp.name} làm mất màu nước Bromine`,
          nameEn: `${sp.name} decolorizes aqueous Bromine water`,
          descVi: 'Liên kết đôi C=C cộng Br₂ làm nhạt mất màu vàng nâu của nước Bromine.',
          descEn: 'C=C double bond rapidly adds Br₂, decolorizing brown Bromine water.',
          rateMolS: dAlkBr / dt,
          dXi: dAlkBr,
        });
      }
    }
  }

  return heatJ;
}

/**
 * Combined entry point for property-driven organic chemistry inside stepVesselChemistry.
 */
export function stepPropertyDrivenOrganic(vessel, strat, liquidVolL, dt, activeReactions, gasProduced, getMolFn, options = {}) {
  let heatJ = 0;
  heatJ += stepGeneralOrganicCombustion(vessel, dt, activeReactions, gasProduced, getMolFn, options);
  heatJ += stepFunctionalGroupTests(vessel, strat, liquidVolL, dt, activeReactions, options);
  return heatJ;
}
