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
import { computePH } from './equilibrium.js';

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

  let dehydrateWaterAct = 1.0;
  if (rxn.dehydrateByH2SO4) {
    const nSulfC = getMolFn('H2SO4_l') || 0;
    const mSulfG = nSulfC * 98.079;
    const mWaterG = (getMolFn('H2O_l') || 0) * 18.01528;
    const wSulf = mSulfG + mWaterG > 1e-6 ? mSulfG / (mSulfG + mWaterG) : 0;
    if (nSulfC > 1e-5 && wSulf >= 0.25) {
      catFactor = Math.min(28.0, Math.max(catFactor, (nSulfC * 1.6) / effVolL) * 1.45);
      if (wSulf >= 0.38) {
        dehydrateWaterAct = Math.max(0.32, 1.0 - 0.62 * Math.min(1, wSulf / 0.72));
      }
    } else if (rxn.id === 'isoamyl_acetate_reversible') {
      // Isoamyl acetate requires conc. H2SO4 for brisk esterification; dilute aqueous acid reacts very slowly
      catFactor *= 0.08;
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
      const spConcEff = (nAvail / effVolL) * (spId === 'H2O_l' ? dehydrateWaterAct : 1.0);
      termR *= Math.pow(spConcEff, revOrder);
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
  const gasProduced = options.gasProduced || null;
  let heatJ = 0;

  // Dissociate polyol Cu(II) chelates above 70 °C so warm Cu2O redox proceeds cleanly
  for (const [chelateId, sugarId] of [
    ['CuGlc2_aq', 'Glucose_aq'],
    ['CuFrc2_aq', 'Fructose_aq'],
    ['CuMalt2_aq', 'Maltose_aq'],
  ]) {
    if (T >= 343.15 && (moles[chelateId] || 0) > 1e-8) {
      const dRel = moles[chelateId] * (1 - Math.exp(-2.8 * dt));
      moles[chelateId] = Math.max(0, moles[chelateId] - dRel);
      if (moles[chelateId] < 1e-13) delete moles[chelateId];
      moles.CuOH2_s = (moles.CuOH2_s || 0) + dRel;
      moles[sugarId] = (moles[sugarId] || 0) + 2 * dRel;
    }
  }

  // Reversible alkaline Glucose <-> Fructose isomerization & Fructose reducing tests (no Br2 oxidation)
  if (hasWater && (moles.OH_aq || 0) > 1e-4) {
    const nGlc = moles.Glucose_aq || 0;
    const nFrc = moles.Fructose_aq || 0;
    if (nGlc > 1e-9 || nFrc > 1e-9) {
      const eqFrc = (nGlc + nFrc) * 0.42;
      const diff = eqFrc - nFrc;
      const kIso = T >= 323.15 ? 1.4 : 0.75;
      const dIso = Math.sign(diff) * Math.min(Math.abs(diff), 0.35 * (nGlc + nFrc)) * (1 - Math.exp(-kIso * dt));
      if (Math.abs(dIso) > 1e-11) {
        moles.Glucose_aq = Math.max(0, nGlc - dIso);
        moles.Fructose_aq = Math.max(0, nFrc + dIso);
        if (moles.Glucose_aq < 1e-13) delete moles.Glucose_aq;
        if (moles.Fructose_aq < 1e-13) delete moles.Fructose_aq;
        activeReactions.push({
          id: 'glucose_fructose_isomerize',
          equation: 'Glucose ⇌ Fructose (OH⁻)',
          nameVi: 'Đồng phân hóa thuận nghịch Glucose ⇌ Fructose trong kiềm',
          nameEn: 'Alkaline Glucose ⇌ Fructose isomerization (Lobry de Bruyn)',
          descVi: 'Trong môi trường kiềm, Fructose chuyển hóa một phần sang Glucose nên vẫn tráng bạc và khử Cu(OH)₂.',
          descEn: 'In alkaline medium, Fructose tautomerizes to Glucose giving positive Tollens & Fehling tests.',
          rateMolS: Math.abs(dIso) / dt,
          dXi: Math.abs(dIso),
        });
      }
    }
  }

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
    // 3. Property-driven Polyol Cu(OH)2 room-T azure chelation (hasVicinalDiol: Glucose, Fructose, Maltose, Sucrose)
    const polyolMap = { Glucose_aq: 'CuGlc2_aq', Fructose_aq: 'CuFrc2_aq', Maltose_aq: 'CuMalt2_aq', Sucrose_aq: 'CuSuc2_aq' };
    if (fg.hasVicinalDiol && !fg.legacyHandled && hasWater && polyolMap[spId] && (moles.CuOH2_s || 0) > 1e-8 && (moles.OH_aq || 0) > 1e-6 && T < 343.15) {
      const chelateId = polyolMap[spId];
      const dPoly = Math.min(moles.CuOH2_s, (moles[spId] || 0) / 2) * (1 - Math.exp(-1.9 * dt));
      if (dPoly > 1e-11) {
        moles.CuOH2_s = Math.max(0, moles.CuOH2_s - dPoly);
        if (moles.CuOH2_s < 1e-13) delete moles.CuOH2_s;
        moles[spId] = Math.max(0, moles[spId] - 2 * dPoly);
        if (moles[spId] < 1e-13) delete moles[spId];
        moles[chelateId] = (moles[chelateId] || 0) + dPoly;
        heatJ += dPoly * 18000;
        activeReactions.push({
          id: `cu_diol_${spId}`,
          equation: `2 ${sp.formula} + Cu(OH)₂ → ${SPECIES[chelateId].formula} (xanh lam)`,
          nameVi: `${sp.name} hòa tan Cu(OH)₂ tạo phức xanh lam`,
          nameEn: `${sp.name} chelates Cu(OH)₂ forming azure blue polyol complex`,
          descVi: 'Các nhóm –OH liền kề hòa tan kết tủa Cu(OH)₂ ở nhiệt độ phòng tạo phức xanh lam thẫm.',
          descEn: 'Vicinal hydroxyl groups dissolve Cu(OH)₂ at room temperature into a deep azure complex.',
          rateMolS: dPoly / dt,
          dXi: dPoly,
        });
      }
    }

    // Dissociate polyol Cu(II) chelates at warm temperature (duplicate-safe guard skipped if already handled above)

    // 4. Property-driven Aldehyde & Reducing Sugar oxidation: Tollens Ag(NH3)2+, Hot Cu(OH)2 -> Cu2O, & Glucose + Br2(aq)
    const aldProductMap = { Glucose_aq: 'Gluconate_aq', Maltose_aq: 'Gluconate_aq', C2H5CHO_l: 'C2H5COO_aq', C6H5CHO_l: 'C6H5COO_aq' };
    if (fg.hasAldehydeGroup && !fg.legacyHandled && aldProductMap[spId]) {
      const prodSalt = aldProductMap[spId];
      // 4c. Aqueous Bromine oxidation (Glucose/Maltose decolorizes Br2(aq), whereas Fructose does NOT!)
      if (hasWater && (moles.Br2_aq || 0) > 1e-8 && !fg.noBr2Oxidation && (moles[spId] || 0) > 1e-9) {
        const dBrOx = Math.min(moles[spId], moles.Br2_aq) * (1 - Math.exp(-0.95 * dt));
        if (dBrOx > 1e-11) {
          moles[spId] = Math.max(0, moles[spId] - dBrOx);
          if (moles[spId] < 1e-13) delete moles[spId];
          moles.Br2_aq = Math.max(0, moles.Br2_aq - dBrOx);
          if (moles.Br2_aq < 1e-13) delete moles.Br2_aq;
          moles[prodSalt] = (moles[prodSalt] || 0) + dBrOx;
          moles.H_aq = (moles.H_aq || 0) + 2 * dBrOx;
          moles.Br_aq = (moles.Br_aq || 0) + 2 * dBrOx;
          heatJ += dBrOx * 62000;
          activeReactions.push({
            id: `ald_br2_${spId}`,
            equation: `${sp.formula} + Br₂(aq) + H₂O → ${SPECIES[prodSalt].formula} + 2H⁺ + 2Br⁻`,
            nameVi: `${sp.name} làm mất màu nước Bromine`,
            nameEn: `${sp.name} decolorizes aqueous Bromine water`,
            descVi: 'Nhóm –CHO bị nước Bromine oxi hóa (dùng phân biệt Glucose với Fructose không phản ứng).',
            descEn: 'Aldehyde –CHO reduces aqueous Bromine (distinguishing Glucose from unreactive Fructose).',
            rateMolS: dBrOx / dt,
            dXi: dBrOx,
          });
        }
      }
      const spCur = moles[spId] || 0;
      // 4a. Tollens silver mirror reaction
      if (hasWater && (moles.AgNH3_2_aq || 0) > 1e-8 && (moles.OH_aq || 0) > 1e-7 && T >= 295 && spCur > 1e-9) {
        const kTol = T >= 323.15 ? 1.8 : 0.35;
        const dTol = Math.min(spCur, moles.AgNH3_2_aq / 2, moles.OH_aq / 3) * (1 - Math.exp(-kTol * dt));
        if (dTol > 1e-11) {
          moles[spId] = Math.max(0, spCur - dTol);
          if (moles[spId] < 1e-13) delete moles[spId];
          moles.AgNH3_2_aq = Math.max(0, moles.AgNH3_2_aq - 2 * dTol);
          if (moles.AgNH3_2_aq < 1e-13) delete moles.AgNH3_2_aq;
          moles.OH_aq = Math.max(0, moles.OH_aq - 3 * dTol);
          if (moles.OH_aq < 1e-13) delete moles.OH_aq;
          moles[prodSalt] = (moles[prodSalt] || 0) + dTol;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dTol;
          moles.NH3_aq = (moles.NH3_aq || 0) + 4 * dTol;
          moles.H2O_l = (moles.H2O_l || 0) + 2 * dTol;
          if (!vessel.particleCounts) vessel.particleCounts = {};
          vessel.particleCounts.Ag_s = Math.max(vessel.particleCounts.Ag_s || 0, 900);
          vessel.silverMirrorFrac = Math.min(1.0, (vessel.silverMirrorFrac || 0) + dTol * 160);
          heatJ += dTol * 92000;
          activeReactions.push({
            id: `tollens_${spId}`,
            equation: `${sp.formula} + 2[Ag(NH₃)₂]⁺ + 3OH⁻ → ${SPECIES[prodSalt].formula} + 2Ag↓ + 4NH₃ + 2H₂O`,
            nameVi: `Tráng bạc ${sp.name} tạo lớp Ag sáng bóng`,
            nameEn: `Tollens silver mirror test on ${sp.name} yielding Ag↓`,
            descVi: 'Nhóm –CHO khử phức bạc amoniac tạo lớp bạc sáng bám thành bình.',
            descEn: 'Aldehyde functional group reduces Tollens reagent depositing metallic Ag.',
            rateMolS: dTol / dt,
            dXi: dTol,
          });
        }
      }
      // 4b. Warm Cu(OH)2 reduction >= 70 C -> brick-red Cu2O↓
      const spLeft = moles[spId] || 0;
      if (hasWater && T >= 343.15 && (moles.CuOH2_s || 0) > 1e-8 && (moles.OH_aq || 0) > 1e-7 && spLeft > 1e-9) {
        const dCuRed = Math.min(spLeft, moles.CuOH2_s / 2, moles.OH_aq) * (1 - Math.exp(-1.4 * dt));
        if (dCuRed > 1e-11) {
          moles[spId] = Math.max(0, spLeft - dCuRed);
          if (moles[spId] < 1e-13) delete moles[spId];
          moles.CuOH2_s = Math.max(0, moles.CuOH2_s - 2 * dCuRed);
          if (moles.CuOH2_s < 1e-13) delete moles.CuOH2_s;
          moles.OH_aq = Math.max(0, moles.OH_aq - dCuRed);
          if (moles.OH_aq < 1e-13) delete moles.OH_aq;
          moles[prodSalt] = (moles[prodSalt] || 0) + dCuRed;
          moles.Cu2O_s = (moles.Cu2O_s || 0) + dCuRed;
          moles.H2O_l = (moles.H2O_l || 0) + 3 * dCuRed;
          heatJ += dCuRed * 68000;
          activeReactions.push({
            id: `cu2o_${spId}`,
            equation: `${sp.formula} + 2Cu(OH)₂ + OH⁻ —(t°)→ ${SPECIES[prodSalt].formula} + Cu₂O↓ (đỏ gạch) + 3H₂O`,
            nameVi: `${sp.name} khử Cu(OH)₂ đun nóng tạo kết tủa Cu₂O đỏ gạch`,
            nameEn: `Hot reduction of Cu(OH)₂ by ${sp.name} yielding brick-red Cu₂O↓`,
            descVi: 'Khi đun nóng >= 70 °C trong kiềm, nhóm –CHO khử Cu(II) xuống Cu₂O đỏ gạch.',
            descEn: 'Heating above 70 °C drives aldehyde reduction of Cu(OH)₂ to brick-red Cu₂O↓.',
            rateMolS: dCuRed / dt,
            dXi: dCuRed,
          });
        }
      }
    }
  }

  // ==================== Prompt 77: Cellulose, Amine/Diazonium, Amino Acids, Protein & Bell-Curve Enzymes ====================
  const phCur = hasWater ? computePH(moles, liquidVolL, T) ?? 7.0 : 7.0;
  const effV = Math.max(1e-5, liquidVolL || 0);
  const cHCur = (moles.H_aq || 0) / effV;

  // 5. Mild acid hydrolysis of Starch -> Maltose (323–348 K or mild [H+] < 0.35 M)
  if (hasWater && (moles.Starch_aq || 0) > 1e-8 && (moles.H_aq || 0) > 1e-4 && cHCur < 0.35 && T >= 323.15 && T < 348.15) {
    const dMalt = Math.min(moles.Starch_aq / 2, moles.H2O_l) * (1 - Math.exp(-0.22 * dt));
    if (dMalt > 1e-11) {
      moles.Starch_aq = Math.max(0, moles.Starch_aq - 2 * dMalt);
      if (moles.Starch_aq < 1e-13) delete moles.Starch_aq;
      moles.H2O_l = Math.max(0, moles.H2O_l - dMalt);
      moles.Maltose_aq = (moles.Maltose_aq || 0) + dMalt;
      activeReactions.push({
        id: 'starch_mild_maltose',
        equation: '2 (C₆H₁₀O₅)ₙ + n H₂O —(H⁺ loãng)→ n C₁₂H₂₂O₁₁ (Maltose)',
        nameVi: 'Thủy phân không hoàn toàn Tinh bột tạo Maltose',
        nameEn: 'Partial Starch hydrolysis yielding Maltose',
        descVi: 'Thủy phân nhẹ tinh bột thu được disaccharide Maltose có tính khử.',
        descEn: 'Mild hydrolysis cleaves Starch chains into reducing disaccharide Maltose.',
        rateMolS: dMalt / dt,
        dXi: dMalt,
      });
    }
  }

  // 6. Cellulose reactions: Schweizer dissolution, Strong acid -> Glucose, Conc. HNO3/H2SO4 -> Cellulose trinitrate
  if ((moles.Cellulose_s || 0) > 1e-8) {
    if (hasWater && (moles.CuNH3_4_2_aq || 0) > 1e-7 && (moles.OH_aq || 0) > 1e-7) {
      const dSchw = Math.min(moles.Cellulose_s, moles.CuNH3_4_2_aq, moles.OH_aq / 2) * (1 - Math.exp(-0.95 * dt));
      if (dSchw > 1e-11) {
        moles.Cellulose_s = Math.max(0, moles.Cellulose_s - dSchw);
        if (moles.Cellulose_s < 1e-13) delete moles.Cellulose_s;
        moles.CuNH3_4_2_aq = Math.max(0, moles.CuNH3_4_2_aq - dSchw);
        moles.OH_aq = Math.max(0, moles.OH_aq - 2 * dSchw);
        if (moles.CuNH3_4_2_aq < 1e-13) delete moles.CuNH3_4_2_aq;
        if (moles.OH_aq < 1e-13) delete moles.OH_aq;
        moles.CuCellulose_aq = (moles.CuCellulose_aq || 0) + dSchw;
        moles.H2O_l = (moles.H2O_l || 0) + 2 * dSchw;
        heatJ += dSchw * 22000;
        activeReactions.push({
          id: 'cellulose_schweizer',
          equation: 'Cellulose + [Cu(NH₃)₄](OH)₂ → [Cu(NH₃)₄](Cellulose) (xanh thẫm)',
          nameVi: 'Hòa tan Cellulose trong nước Schweizer tạo dung dịch xanh thẫm nhớt',
          nameEn: 'Cellulose dissolution in Schweizer reagent ([Cu(NH₃)₄](OH)₂)',
          descVi: 'Cellulose không tan trong nước thường nhưng tan đặc trưng trong nước Schweizer.',
          descEn: 'Schweizer reagent dissolves insoluble Cellulose into a viscous deep-blue complex.',
          rateMolS: dSchw / dt,
          dXi: dSchw,
        });
      }
    }
    if (hasWater && cHCur >= 0.4 && T >= 363.15 && !((moles.NO3_aq || 0) > 0.05 && (moles.H2SO4_l || 0) > 0.02)) {
      const dCellHyd = Math.min(moles.Cellulose_s, moles.H2O_l) * (1 - Math.exp(-0.28 * dt));
      if (dCellHyd > 1e-11) {
        moles.Cellulose_s = Math.max(0, moles.Cellulose_s - dCellHyd);
        moles.H2O_l = Math.max(0, moles.H2O_l - dCellHyd);
        if (moles.Cellulose_s < 1e-13) delete moles.Cellulose_s;
        moles.Glucose_aq = (moles.Glucose_aq || 0) + dCellHyd;
        activeReactions.push({
          id: 'cellulose_acid_glucose',
          equation: '(C₆H₁₀O₅)ₙ + n H₂O —(H⁺ đặc, t°)→ n C₆H₁₂O₆ (Glucose)',
          nameVi: 'Thủy phân Cellulose trong acid mạnh đun nóng → Glucose',
          nameEn: 'Hot strong-acid hydrolysis of Cellulose → Glucose',
          descVi: 'Đun nóng Cellulose với acid mạnh H₂SO₄/HCl cắt mạch hoàn toàn thành Glucose.',
          descEn: 'Hot mineral acid completely hydrolyzes Cellulose polymer into Glucose.',
          rateMolS: dCellHyd / dt,
          dXi: dCellHyd,
        });
      }
    }
    const nNitCell = (moles.HNO3_l || 0) > 1e-7 ? moles.HNO3_l : (moles.NO3_aq || 0) > 0.02 && cHCur >= 1.5 ? Math.min(moles.NO3_aq, moles.H_aq) : 0;
    const hasConcH2SO4Cell = (moles.H2SO4_l || 0) > 1e-6 || (moles.HSO4_aq || 0) > 0.01;
    if (nNitCell > 1e-6 && hasConcH2SO4Cell && (moles.Cellulose_s || 0) > 1e-9) {
      const dNC = Math.min(moles.Cellulose_s, nNitCell / 3) * (1 - Math.exp(-1.25 * dt));
      if (dNC > 1e-11) {
        moles.Cellulose_s = Math.max(0, moles.Cellulose_s - dNC);
        if (moles.Cellulose_s < 1e-13) delete moles.Cellulose_s;
        if ((moles.HNO3_l || 0) >= 3 * dNC) {
          moles.HNO3_l = Math.max(0, moles.HNO3_l - 3 * dNC);
          if (moles.HNO3_l < 1e-13) delete moles.HNO3_l;
        } else {
          moles.NO3_aq = Math.max(0, moles.NO3_aq - 3 * dNC);
          moles.H_aq = Math.max(0, moles.H_aq - 3 * dNC);
          if (moles.NO3_aq < 1e-13) delete moles.NO3_aq;
          if (moles.H_aq < 1e-13) delete moles.H_aq;
        }
        moles.CelluloseNitrate_s = (moles.CelluloseNitrate_s || 0) + dNC;
        moles.H2O_l = (moles.H2O_l || 0) + 3 * dNC;
        heatJ += dNC * 95000;
        activeReactions.push({
          id: 'cellulose_trinitrate',
          equation: '[C₆H₇O₂(OH)₃]ₙ + 3n HNO₃ —(H₂SO₄ đặc)→ [C₆H₇O₂(ONO₂)₃]ₙ + 3n H₂O',
          nameVi: 'Nitrat hóa Cellulose tạo Cellulose trinitrate (bông thuốc súng)',
          nameEn: 'Nitration of Cellulose into Cellulose trinitrate (Guncotton)',
          descVi: 'Hỗn hợp HNO₃/H₂SO₄ đặc ester hóa 3 nhóm –OH tạo Cellulose trinitrate dễ cháy nổ.',
          descEn: 'Mixed HNO₃/H₂SO₄ converts Cellulose into flammable Cellulose trinitrate.',
          rateMolS: dNC / dt,
          dXi: dNC,
        });
      }
    }
  }

  // 7. Amine + HNO2 (NO2- + H+): CH3NH2 -> CH3OH + N2↑; Aniline @ 0-5 °C -> Diazonium vs >10 °C -> Phenol + N2↑; Azo coupling
  if (hasWater && (moles.NO2_aq || 0) > 1e-7 && (moles.H_aq || 0) > 1e-7) {
    const ch3Key = (moles.CH3NH2_aq || 0) > 1e-8 ? 'CH3NH2_aq' : (moles.CH3NH3_aq || 0) > 1e-8 ? 'CH3NH3_aq' : null;
    if (ch3Key) {
      const needH = ch3Key === 'CH3NH2_aq' ? 2 : 1;
      const dAlip = Math.min(moles[ch3Key], moles.NO2_aq, moles.H_aq / needH) * (1 - Math.exp(-1.4 * dt));
      if (dAlip > 1e-11) {
        moles[ch3Key] = Math.max(0, moles[ch3Key] - dAlip);
        moles.NO2_aq = Math.max(0, moles.NO2_aq - dAlip);
        moles.H_aq = Math.max(0, moles.H_aq - needH * dAlip);
        if (moles[ch3Key] < 1e-13) delete moles[ch3Key];
        if (moles.NO2_aq < 1e-13) delete moles.NO2_aq;
        if (moles.H_aq < 1e-13) delete moles.H_aq;
        moles.CH3OH_l = (moles.CH3OH_l || 0) + dAlip;
        moles.H2O_l = (moles.H2O_l || 0) + dAlip;
        if (gasProduced) gasProduced.N2_g = (gasProduced.N2_g || 0) + dAlip;
        else moles.N2_g = (moles.N2_g || 0) + dAlip;
        heatJ += dAlip * 145000;
        activeReactions.push({
          id: 'ch3nh2_hno2_n2',
          equation: 'CH₃NH₂ + HNO₂ → CH₃OH + N₂↑ + H₂O',
          nameVi: 'Methylamine tác dụng HNO₂ sủi bọt khí N₂ không màu',
          nameEn: 'Methylamine + HNO₂ → Methanol + N₂↑ + H₂O',
          descVi: 'Amine béo phản ứng với HNO₂ (NaNO₂ + HCl) giải phóng ngay khí N₂ không màu.',
          descEn: 'Aliphatic amine reacts with nitrous acid releasing colorless N₂ gas bubbles.',
          rateMolS: dAlip / dt,
          dXi: dAlip,
          vigorousGas: true,
        });
      }
    }

    const anKey = (moles.C6H5NH3_aq || 0) > 1e-8 ? 'C6H5NH3_aq' : (moles.C6H5NH2_l || 0) > 1e-8 ? 'C6H5NH2_l' : null;
    if (anKey && T <= 281.15) {
      const needH = anKey === 'C6H5NH2_l' ? 2 : 1;
      const dDiaz = Math.min(moles[anKey], moles.NO2_aq, moles.H_aq / needH) * (1 - Math.exp(-1.2 * dt));
      if (dDiaz > 1e-11) {
        moles[anKey] = Math.max(0, moles[anKey] - dDiaz);
        moles.NO2_aq = Math.max(0, moles.NO2_aq - dDiaz);
        moles.H_aq = Math.max(0, moles.H_aq - needH * dDiaz);
        if (moles[anKey] < 1e-13) delete moles[anKey];
        if (moles.NO2_aq < 1e-13) delete moles.NO2_aq;
        if (moles.H_aq < 1e-13) delete moles.H_aq;
        moles.C6H5N2Cl_aq = (moles.C6H5N2Cl_aq || 0) + dDiaz;
        moles.H2O_l = (moles.H2O_l || 0) + 2 * dDiaz;
        heatJ += dDiaz * 68000;
        activeReactions.push({
          id: 'aniline_diazotization_cold',
          equation: 'C₆H₅NH₂ + HNO₂ + HCl —(0–5 °C)→ [C₆H₅N₂⁺]Cl⁻ + 2H₂O',
          nameVi: 'Diazo hóa Aniline ở 0–5 °C tạo muối Benzenediazonium chloride',
          nameEn: 'Cold (0–5 °C) diazotization of Aniline → Benzenediazonium chloride',
          descVi: 'Làm lạnh bằng nước đá 0–5 °C ổn định muối diazonium [C₆H₅N₂⁺]Cl⁻ để thực hiện phản ứng ghép đôi phẩm azo.',
          descEn: 'Ice-bath cooling (0–5 °C) stabilizes Benzenediazonium salt without N₂ decomposition.',
          rateMolS: dDiaz / dt,
          dXi: dDiaz,
        });
      }
    } else if (anKey && T > 283.15) {
      const needH = anKey === 'C6H5NH2_l' ? 2 : 1;
      const dDiazHot = Math.min(moles[anKey], moles.NO2_aq, moles.H_aq / needH) * (1 - Math.exp(-1.1 * dt));
      if (dDiazHot > 1e-11) {
        moles[anKey] = Math.max(0, moles[anKey] - dDiazHot);
        moles.NO2_aq = Math.max(0, moles.NO2_aq - dDiazHot);
        moles.H_aq = Math.max(0, moles.H_aq - needH * dDiazHot);
        if (moles[anKey] < 1e-13) delete moles[anKey];
        if (moles.NO2_aq < 1e-13) delete moles.NO2_aq;
        if (moles.H_aq < 1e-13) delete moles.H_aq;
        moles.C6H5OH_s = (moles.C6H5OH_s || 0) + dDiazHot;
        moles.H_aq = (moles.H_aq || 0) + (needH === 2 ? dDiazHot : 0);
        if (gasProduced) gasProduced.N2_g = (gasProduced.N2_g || 0) + dDiazHot;
        else moles.N2_g = (moles.N2_g || 0) + dDiazHot;
        moles.H2O_l = (moles.H2O_l || 0) + dDiazHot;
        heatJ += dDiazHot * 132000;
        activeReactions.push({
          id: 'aniline_hno2_warm_phenol',
          equation: 'C₆H₅NH₂ + HNO₂ —(>10 °C)→ C₆H₅OH + N₂↑ + H₂O',
          nameVi: 'Aniline + HNO₂ ở >10 °C phân hủy thành Phenol + N₂↑',
          nameEn: 'Warm Aniline + HNO₂ (>10 °C) decomposes to Phenol + N₂↑',
          descVi: 'Không giữ lạnh 0–5 °C làm muối diazonium kém bền phân hủy ngay thành Phenol và khí N₂↑.',
          descEn: 'Above 10 °C, diazonium decomposes rapidly into Phenol and N₂ gas.',
          rateMolS: dDiazHot / dt,
          dXi: dDiazHot,
          vigorousGas: true,
        });
      }
    }
  }

  // Diazonium decomposition when warmed > 10 °C & Azo coupling with Phenol / Aniline
  if ((moles.C6H5N2Cl_aq || 0) > 1e-8) {
    const phenPartner = (moles.C6H5O_aq || 0) > 1e-8 ? 'C6H5O_aq' : (moles.C6H5OH_s || 0) > 1e-8 ? 'C6H5OH_s' : (moles.C6H5OH_l || 0) > 1e-8 ? 'C6H5OH_l' : (moles.C6H5NH2_l || 0) > 1e-8 ? 'C6H5NH2_l' : null;
    if (phenPartner && (phenPartner === 'C6H5O_aq' || (moles.OH_aq || 0) > 1e-7 || phenPartner === 'C6H5NH2_l')) {
      const dAzo = Math.min(moles.C6H5N2Cl_aq, moles[phenPartner]) * (1 - Math.exp(-2.6 * dt));
      if (dAzo > 1e-11) {
        moles.C6H5N2Cl_aq = Math.max(0, moles.C6H5N2Cl_aq - dAzo);
        moles[phenPartner] = Math.max(0, moles[phenPartner] - dAzo);
        if (moles.C6H5N2Cl_aq < 1e-13) delete moles.C6H5N2Cl_aq;
        if (moles[phenPartner] < 1e-13) delete moles[phenPartner];
        moles.AzoDye_s = (moles.AzoDye_s || 0) + dAzo;
        moles.H_aq = (moles.H_aq || 0) + dAzo;
        moles.Cl_aq = (moles.Cl_aq || 0) + dAzo;
        heatJ += dAzo * 85000;
        activeReactions.push({
          id: 'azo_coupling_dye',
          equation: '[C₆H₅N₂⁺]Cl⁻ + C₆H₅OH/C₆H₅NH₂ → Phẩm nhuộm Azo↓ (cam đỏ)',
          nameVi: 'Ghép đôi diazo tạo phẩm nhuộm Azo màu cam đỏ rực rỡ',
          nameEn: 'Azo coupling of Diazonium with Phenol/Aniline yielding vivid orange-red Azo dye↓',
          descVi: 'Ion diazonium ghép đôi với vòng thơm giàu electron tạo kết tủa phẩm nhuộm Azo màu cam đỏ.',
          descEn: 'Electrophilic aromatic azo coupling forms intensely colored orange-red Azo dye.',
          rateMolS: dAzo / dt,
          dXi: dAzo,
        });
      }
    } else if (hasWater && T > 283.15 && (moles.C6H5N2Cl_aq || 0) > 1e-8) {
      const kDec = 0.35 + Math.min(3.5, (T - 283.15) * 0.14);
      const dDec = Math.min(moles.C6H5N2Cl_aq, moles.H2O_l) * (1 - Math.exp(-kDec * dt));
      if (dDec > 1e-11) {
        moles.C6H5N2Cl_aq = Math.max(0, moles.C6H5N2Cl_aq - dDec);
        moles.H2O_l = Math.max(0, moles.H2O_l - dDec);
        if (moles.C6H5N2Cl_aq < 1e-13) delete moles.C6H5N2Cl_aq;
        moles.C6H5OH_s = (moles.C6H5OH_s || 0) + dDec;
        moles.H_aq = (moles.H_aq || 0) + dDec;
        moles.Cl_aq = (moles.Cl_aq || 0) + dDec;
        if (gasProduced) gasProduced.N2_g = (gasProduced.N2_g || 0) + dDec;
        else moles.N2_g = (moles.N2_g || 0) + dDec;
        heatJ += dDec * 72000;
        activeReactions.push({
          id: 'diazonium_thermal_decomp',
          equation: '[C₆H₅N₂⁺]Cl⁻ + H₂O —(>10 °C)→ C₆H₅OH + N₂↑ + H⁺ + Cl⁻',
          nameVi: 'Phân hủy nhiệt muối Diazonium (>10 °C) → Phenol + N₂↑',
          nameEn: 'Thermal hydrolysis of Benzenediazonium chloride (>10 °C) → Phenol + N₂↑',
          descVi: 'Khi nhiệt độ vượt >10 °C, muối Benzenediazonium chloride bị thủy phân giải phóng khí N₂ tạo Phenol.',
          descEn: 'Warming above 10 °C hydrolyzes Benzenediazonium to Phenol and N₂ gas.',
          rateMolS: dDec / dt,
          dXi: dDec,
          vigorousGas: true,
        });
      }
    }
  }

  // 8. Amino acid Esterification (with EtOH + HCl/H+) & Condensation -> Peptide & Peptide Hydrolysis
  if ((moles.C2H5OH_l || 0) > 1e-5 && (moles.H_aq || 0) > 1e-5 && (moles.Cl_aq || 0) > 1e-5 && T >= 328.15) {
    for (const [aaId, estId, lbl] of [
      ['Glycine_aq', 'GlyEthylEster_aq', 'Glycine'],
      ['Glycinium_aq', 'GlyEthylEster_aq', 'Glycine'],
      ['Alanine_aq', 'AlaEthylEster_aq', 'Alanine'],
      ['Alaninium_aq', 'AlaEthylEster_aq', 'Alanine'],
    ]) {
      if ((moles[aaId] || 0) > 1e-9) {
        const dAe = Math.min(moles[aaId], moles.C2H5OH_l, moles.Cl_aq) * (1 - Math.exp(-0.72 * dt));
        if (dAe > 1e-11) {
          moles[aaId] = Math.max(0, moles[aaId] - dAe);
          moles.C2H5OH_l = Math.max(0, moles.C2H5OH_l - dAe);
          moles.Cl_aq = Math.max(0, moles.Cl_aq - dAe);
          if (aaId.endsWith('aq') && !aaId.includes('ium')) moles.H_aq = Math.max(0, moles.H_aq - dAe);
          if (moles[aaId] < 1e-13) delete moles[aaId];
          moles[estId] = (moles[estId] || 0) + dAe;
          moles.H2O_l = (moles.H2O_l || 0) + dAe;
          activeReactions.push({
            id: `aa_ester_${aaId}`,
            equation: `${lbl} + C₂H₅OH + HCl → Cl⁻⁺H₃N–R–COOC₂H₅ + H₂O`,
            nameVi: `Ester hóa ${lbl} với Ethanol / HCl`,
            nameEn: `HCl-catalyzed esterification of ${lbl} with Ethanol`,
            descVi: 'Nhóm –COOH của amino acid phản ứng với Ethanol tạo muối ester.',
            descEn: 'Amino acid esterifies cleanly with Ethanol in HCl medium.',
            rateMolS: dAe / dt,
            dXi: dAe,
          });
        }
      }
    }
  }
  if ((moles.Glycine_s || 0) > 2e-8 && T >= 453.15) {
    const dCond = (moles.Glycine_s / 2) * (1 - Math.exp(-0.55 * dt));
    if (dCond > 1e-11) {
      moles.Glycine_s = Math.max(0, moles.Glycine_s - 2 * dCond);
      if (moles.Glycine_s < 1e-13) delete moles.Glycine_s;
      moles.Peptide_s = (moles.Peptide_s || 0) + dCond;
      moles.H2O_l = (moles.H2O_l || 0) + dCond;
      activeReactions.push({
        id: 'glycine_polycondense',
        equation: 'n H₂N–CH₂–COOH —(t°)→ Polypeptide + n H₂O',
        nameVi: 'Trùng ngưng Glycine tạo liên kết peptide',
        nameEn: 'Thermal peptide condensation of Glycine',
        descVi: 'Đun nóng amino acid tách nước hình thành liên kết peptide –CO–NH–.',
        descEn: 'Dehydration condensation builds peptide bonds between amino acids.',
        rateMolS: dCond / dt,
        dXi: dCond,
      });
    }
  }
  if (hasWater && (moles.Peptide_aq || 0) > 1e-8 && ((moles.H_aq || 0) > 1e-4 || (moles.OH_aq || 0) > 1e-4) && T >= 343.15) {
    const isAlkPep = (moles.OH_aq || 0) > (moles.H_aq || 0);
    const dPepHyd = Math.min(moles.Peptide_aq, moles.H2O_l) * (1 - Math.exp(-0.48 * dt));
    if (dPepHyd > 1e-11) {
      moles.Peptide_aq = Math.max(0, moles.Peptide_aq - dPepHyd);
      moles.H2O_l = Math.max(0, moles.H2O_l - dPepHyd);
      if (moles.Peptide_aq < 1e-13) delete moles.Peptide_aq;
      if (isAlkPep) {
        const dUseOH = Math.min(moles.OH_aq, 2 * dPepHyd);
        moles.OH_aq = Math.max(0, moles.OH_aq - dUseOH);
        moles.Glycinate_aq = (moles.Glycinate_aq || 0) + 2 * dPepHyd;
      } else {
        moles.Glycine_aq = (moles.Glycine_aq || 0) + 2 * dPepHyd;
      }
      activeReactions.push({
        id: 'peptide_hydrolysis',
        equation: 'Polypeptide + H₂O —(H⁺/OH⁻, t°)→ Amino acid tự do',
        nameVi: 'Thủy phân Peptide thu lại Amino acid tự do',
        nameEn: 'Acid/alkaline hydrolysis of Polypeptide to free Amino acids',
        descVi: 'Cắt đứt liên kết peptide –CO–NH– trong acid/kiềm đun nóng.',
        descEn: 'Hot acid or alkali hydrolyzes peptide bonds cleanly.',
        rateMolS: dPepHyd / dt,
        dXi: dPepHyd,
      });
    }
  }

  // 9. Protein (Albumin) Coagulation (>65 °C, acid/base, heavy metals) & Xanthoproteic HNO3 yellow
  const hasConcHno3X = (moles.HNO3_l || 0) > 1e-7 || ((moles.NO3_aq || 0) > 0.01 && cHCur >= 0.8);
  if (hasConcHno3X && ((moles.Albumin_aq || 0) > 1e-9 || (moles.AlbuminCoagulated_s || 0) > 1e-9)) {
    const srcAlb = (moles.Albumin_aq || 0) > 1e-9 ? 'Albumin_aq' : 'AlbuminCoagulated_s';
    const nNitX = (moles.HNO3_l || 0) > 1e-7 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
    const dXan = Math.min(moles[srcAlb], nNitX) * (1 - Math.exp(-1.5 * dt));
    if (dXan > 1e-11) {
      moles[srcAlb] = Math.max(0, moles[srcAlb] - dXan);
      if (moles[srcAlb] < 1e-13) delete moles[srcAlb];
      if ((moles.HNO3_l || 0) >= dXan) moles.HNO3_l = Math.max(0, moles.HNO3_l - dXan);
      else {
        moles.NO3_aq = Math.max(0, moles.NO3_aq - dXan);
        moles.H_aq = Math.max(0, moles.H_aq - dXan);
      }
      moles.AlbuminXantho_s = (moles.AlbuminXantho_s || 0) + dXan;
      moles.H2O_l = (moles.H2O_l || 0) + dXan;
      heatJ += dXan * 45000;
      activeReactions.push({
        id: 'albumin_xanthoproteic',
        equation: 'Albumin + HNO₃ → Kết tủa vàng Xanthoproteic↓',
        nameVi: 'Phản ứng màu Xanthoproteic: Albumin + HNO₃ → kết tủa vàng',
        nameEn: 'Xanthoproteic test: Albumin + conc. HNO₃ → yellow precipitate↓',
        descVi: 'Vòng thơm trong phân tử Protein bị nitro hóa bởi HNO₃ tạo kết tủa màu vàng đặc trưng.',
        descEn: 'Nitration of aromatic residues in Albumin yields bright yellow Xanthoproteic precipitate.',
        rateMolS: dXan / dt,
        dXi: dXan,
      });
    }
  } else if ((moles.Albumin_aq || 0) > 1e-9) {
    const isBiuretConditions = (moles.OH_aq || 0) > 1e-4 && ((moles.CuOH2_s || 0) > 1e-8 || (moles.Cu2_aq || 0) > 1e-8);
    const heavyMetalCoag = (!isBiuretConditions && ((moles.Cu2_aq || 0) > 1e-4 || (moles.Ag_aq || 0) > 1e-4));
    const heatCoag = T > 338.15; // > 65 °C
    const extremePhCoag = phCur < 2.2 || (!isBiuretConditions && phCur > 12.2);
    if (heatCoag || heavyMetalCoag || extremePhCoag) {
      const kCoag = heatCoag ? 1.8 : 1.4;
      const dCoag = moles.Albumin_aq * (1 - Math.exp(-kCoag * dt));
      if (dCoag > 1e-11) {
        moles.Albumin_aq = Math.max(0, moles.Albumin_aq - dCoag);
        if (moles.Albumin_aq < 1e-13) delete moles.Albumin_aq;
        moles.AlbuminCoagulated_s = (moles.AlbuminCoagulated_s || 0) + dCoag;
        activeReactions.push({
          id: 'albumin_coagulation',
          equation: 'Albumin(aq) —(>65 °C / Acid / Cu²⁺, Ag⁺)→ Albumin↓ (đông tụ)',
          nameVi: 'Đông tụ không thuận nghịch Protein (Albumin↓ trắng đục)',
          nameEn: 'Irreversible Protein (Albumin) coagulation precipitate↓',
          descVi: 'Dưới tác dụng nhiệt (>65 °C), acid/base mạnh hoặc ion kim loại nặng, Albumin đông tụ trắng không tan lại.',
          descEn: 'Heat (>65 °C), strong acid/base, or heavy metal ions irreversibly coagulate Albumin.',
          rateMolS: dCoag / dt,
          dXi: dCoag,
        });
      }
    }
  }

  // 10. Enzyme Bell-Shaped Activity Curve (Optimum ~35–42 °C, pH 6–8; Irreversible Denaturation >75 °C or extreme pH)
  const enzymeActFactor = Math.exp(-Math.pow((T - 311.15) / 14.0, 2)) * Math.exp(-Math.pow((phCur - 7.0) / 1.9, 2));
  const isEnzymeDenature = T > 348.15 || phCur < 2.2 || phCur > 11.4;
  for (const [enzAq, enzDen, enzName] of [
    ['Amylase_aq', 'AmylaseDenatured_s', 'Amylase'],
    ['Catalase_aq', 'CatalaseDenatured_s', 'Catalase'],
  ]) {
    if ((moles[enzAq] || 0) > 1e-10 && isEnzymeDenature) {
      const dDen = moles[enzAq] * (1 - Math.exp(-2.2 * dt));
      if (dDen > 1e-12) {
        moles[enzAq] = Math.max(0, moles[enzAq] - dDen);
        if (moles[enzAq] < 1e-13) delete moles[enzAq];
        moles[enzDen] = (moles[enzDen] || 0) + dDen;
        activeReactions.push({
          id: `denature_${enzAq}`,
          equation: `${enzName}(aq) —(>75 °C / pH khắc nghiệt)→ ${enzName}↓ (mất hoạt tính)`,
          nameVi: `Biến tính mất hoàn toàn hoạt tính Enzyme ${enzName}`,
          nameEn: `Irreversible thermal/pH denaturation of ${enzName} enzyme`,
          descVi: 'Ở nhiệt độ > 75 °C hoặc pH quá acid/kiềm, cấu trúc không gian enzyme bị phá hủy vĩnh viễn.',
          descEn: 'Above 75 °C or at extreme pH, enzyme tertiary structure denatures permanently.',
          rateMolS: dDen / dt,
          dXi: dDen,
        });
      }
    }
  }

  if (hasWater && !isEnzymeDenature && enzymeActFactor > 0.03) {
    if ((moles.Amylase_aq || 0) > 1e-9 && (moles.Starch_aq || 0) > 1e-8) {
      const kEnzSt = 2.8 * enzymeActFactor;
      const dEnzM = Math.min(moles.Starch_aq / 2, moles.H2O_l) * (1 - Math.exp(-kEnzSt * dt));
      if (dEnzM > 1e-11) {
        moles.Starch_aq = Math.max(0, moles.Starch_aq - 2 * dEnzM);
        moles.H2O_l = Math.max(0, moles.H2O_l - dEnzM);
        if (moles.Starch_aq < 1e-13) delete moles.Starch_aq;
        moles.Maltose_aq = (moles.Maltose_aq || 0) + dEnzM;
        activeReactions.push({
          id: 'amylase_starch_maltose',
          equation: 'Tinh bột + H₂O —(Amylase, ~37 °C)→ Maltose',
          nameVi: 'Enzyme Amylase thủy phân Tinh bột thành Maltose',
          nameEn: 'Amylase-catalyzed hydrolysis of Starch into Maltose',
          descVi: `Hoạt tính Amylase hiện tại ${(enzymeActFactor * 100).toFixed(0)}% (tối ưu quanh 37–40 °C, pH 7).`,
          descEn: `Amylase catalytic activity at ${(enzymeActFactor * 100).toFixed(0)}% (bell optimum ~38 °C, pH 7).`,
          rateMolS: dEnzM / dt,
          dXi: dEnzM,
        });
      }
    }
    if ((moles.Catalase_aq || 0) > 1e-9 && (moles.H2O2_aq || 0) > 1e-7) {
      const kCatH2 = 6.5 * enzymeActFactor;
      const dCatE = (moles.H2O2_aq / 2) * (1 - Math.exp(-kCatH2 * dt));
      if (dCatE > 1e-11) {
        moles.H2O2_aq = Math.max(0, moles.H2O2_aq - 2 * dCatE);
        if (moles.H2O2_aq < 1e-13) delete moles.H2O2_aq;
        moles.H2O_l = (moles.H2O_l || 0) + 2 * dCatE;
        if (gasProduced) gasProduced.O2_g = (gasProduced.O2_g || 0) + dCatE;
        else moles.O2_g = (moles.O2_g || 0) + dCatE;
        heatJ += dCatE * 196000;
        activeReactions.push({
          id: 'catalase_h2o2_o2',
          equation: '2H₂O₂ —(Catalase, ~37 °C)→ 2H₂O + O₂↑',
          nameVi: 'Enzyme Catalase phân hủy H₂O₂ giải phóng O₂↑ cực nhanh',
          nameEn: 'Catalase enzymatic decomposition: 2H₂O₂ → 2H₂O + O₂↑',
          descVi: `Hoạt tính Catalase ${(enzymeActFactor * 100).toFixed(0)}% theo đường cong hình chuông (T, pH).`,
          descEn: `Catalase activity at ${(enzymeActFactor * 100).toFixed(0)}% following T/pH bell curve.`,
          rateMolS: dCatE / dt,
          dXi: dCatE,
          vigorousGas: true,
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
  heatJ += stepFunctionalGroupTests(vessel, strat, liquidVolL, dt, activeReactions, { ...options, gasProduced });
  return heatJ;
}
