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
      ['Valine_aq', 'ValEthylEster_aq', 'Valine'],
      ['Valinium_aq', 'ValEthylEster_aq', 'Valine'],
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
  // Glycine polycondensation/decomposition starts at >= 233 °C (506.15 K) via stepThermalPyrolysis (crystalline below 220 °C).
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

  // 9. Protein (Albumin & Keratin) Tests & Thermal/Alkali Hydrolysis
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

  // 9b. Keratin (insoluble fibrous disulfide protein): Xanthoproteic HNO3, hot alkali/acid disulfide scission, hot Biuret
  if ((moles.Keratin_s || 0) > 1e-9) {
    if (hasConcHno3X) {
      const nNitK = (moles.HNO3_l || 0) > 1e-7 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
      const dKx = Math.min(moles.Keratin_s, nNitK) * (1 - Math.exp(-0.95 * dt));
      if (dKx > 1e-11) {
        moles.Keratin_s = Math.max(0, moles.Keratin_s - dKx);
        if (moles.Keratin_s < 1e-13) delete moles.Keratin_s;
        if ((moles.HNO3_l || 0) >= dKx) moles.HNO3_l = Math.max(0, moles.HNO3_l - dKx);
        else {
          moles.NO3_aq = Math.max(0, moles.NO3_aq - dKx);
          moles.H_aq = Math.max(0, moles.H_aq - dKx);
        }
        moles.KeratinXantho_s = (moles.KeratinXantho_s || 0) + dKx;
        moles.H2O_l = (moles.H2O_l || 0) + dKx;
        heatJ += dKx * 38000;
        activeReactions.push({
          id: 'keratin_xanthoproteic',
          equation: 'Keratin(s) + HNO₃ → Keratin–NO₂↓ (vàng Xanthoproteic)',
          nameVi: 'Phản ứng Xanthoproteic: Sợi Keratin + HNO₃ → hóa vàng',
          nameEn: 'Xanthoproteic test: Insoluble Keratin fiber + conc. HNO₃ → yellow↓',
          descVi: 'Sợi Keratin không tan bị nitro hóa trên nhân thơm bởi HNO₃ tạo màu vàng cam đặc trưng.',
          descEn: 'Nitration of aromatic amino-acid side chains stains insoluble Keratin fibers yellow.',
          rateMolS: dKx / dt,
          dXi: dKx,
        });
      }
    } else if (hasWater && T >= 343.15 && (moles.OH_aq || 0) > 1e-3) {
      // Hot alkaline hydrolysis cuts peptide + disulfide (-S-S-) crosslinks -> Peptide(aq) + Amino acid + S2- + NH3 + H2S
      const dKerAlk = Math.min(moles.Keratin_s, (moles.OH_aq || 0) / 4) * (1 - Math.exp(-0.38 * dt));
      if (dKerAlk > 1e-11) {
        moles.Keratin_s = Math.max(0, moles.Keratin_s - dKerAlk);
        if (moles.Keratin_s < 1e-13) delete moles.Keratin_s;
        moles.OH_aq = Math.max(0, moles.OH_aq - 4 * dKerAlk);
        moles.Peptide_aq = (moles.Peptide_aq || 0) + dKerAlk;
        moles.Glycine_aq = (moles.Glycine_aq || 0) + dKerAlk;
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dKerAlk;
        moles.S2_aq = (moles.S2_aq || 0) + dKerAlk;
        moles.H2O_l = (moles.H2O_l || 0) + dKerAlk;
        if (options?.gasProduced) {
          options.gasProduced.NH3_g = (options.gasProduced.NH3_g || 0) + dKerAlk;
          options.gasProduced.H2S_g = (options.gasProduced.H2S_g || 0) + dKerAlk;
        } else {
          moles.NH3_g = (moles.NH3_g || 0) + dKerAlk;
          moles.H2S_g = (moles.H2S_g || 0) + dKerAlk;
        }
        activeReactions.push({
          id: 'keratin_alkali_hydrolysis',
          equation: 'Keratin(s) + 4OH⁻ —(t° ≥ 70 °C)→ Polypeptide + Glycine + S²⁻(aq) + NH₃↑ + H₂S↑',
          nameVi: 'Thủy phân kiềm nóng Keratin cắt cầu –S–S– giải phóng S²⁻, NH₃↑, H₂S↑',
          nameEn: 'Hot alkaline Keratin hydrolysis cleaving –S–S– bonds → Peptide + S²⁻ + NH₃↑ + H₂S↑',
          descVi: 'Đun nóng Keratin trong kiềm phá hủy cầu disulfua sinh ion S²⁻ (tạo CuS↓ đen với Cu²⁺), khí NH₃↑ và Polypeptide cho phản ứng tím Biuret.',
          descEn: 'Boiling Keratin in alkali ruptures disulfide crosslinks forming sulfide ions (black CuS↓ with Cu²⁺), Ammonia, and Biuret-active Peptides.',
          rateMolS: dKerAlk / dt,
          vigorousGas: true,
          dXi: dKerAlk,
        });
      }
    } else if (hasWater && T >= 343.15 && (moles.H_aq || 0) > 1e-3 && (moles.H2O_l || 0) > 1e-3) {
      const dKerAc = Math.min(moles.Keratin_s, (moles.H_aq || 0) / 4, (moles.H2O_l || 0) / 2) * (1 - Math.exp(-0.32 * dt));
      if (dKerAc > 1e-11) {
        moles.Keratin_s = Math.max(0, moles.Keratin_s - dKerAc);
        if (moles.Keratin_s < 1e-13) delete moles.Keratin_s;
        moles.H_aq = Math.max(0, moles.H_aq - 4 * dKerAc);
        moles.H2O_l = Math.max(0, moles.H2O_l - 2 * dKerAc);
        moles.Alaninium_aq = (moles.Alaninium_aq || 0) + 2 * dKerAc;
        moles.Glycinium_aq = (moles.Glycinium_aq || 0) + 2 * dKerAc;
        moles.S_s = (moles.S_s || 0) + dKerAc;
        if (options?.gasProduced) {
          options.gasProduced.H2S_g = (options.gasProduced.H2S_g || 0) + dKerAc;
        } else {
          moles.H2S_g = (moles.H2S_g || 0) + dKerAc;
        }
        activeReactions.push({
          id: 'keratin_acid_hydrolysis',
          equation: 'Keratin(s) + 4H⁺ + 2H₂O —(t° ≥ 70 °C)→ 2 Alaninium⁺ + 2 Glycinium⁺ + H₂S↑ + S↓',
          nameVi: 'Thủy phân acid nóng sợi Keratin thu hỗn hợp Amino acid & H₂S↑',
          nameEn: 'Hot acid hydrolysis of insoluble Keratin fiber yielding Amino acids + H₂S↑',
          descVi: 'Đun nóng lâu trong acid mạnh thủy phân hoàn toàn protein sợi Keratin thành α-amino acid hòa tan và H₂S.',
          descEn: 'Prolonged hot acid hydrolyzes Keratin fibers into soluble amino acid cations and H₂S gas.',
          rateMolS: dKerAc / dt,
          vigorousGas: true,
          dXi: dKerAc,
        });
      }
    }
  }

  // 10. Enzyme Bell-Shaped Activity Curve (Optimum ~35–42 °C, pH 6–8; Irreversible Denaturation >75 °C or extreme pH)
  const enzymeActFactor = Math.exp(-Math.pow((T - 311.15) / 14.0, 2)) * Math.exp(-Math.pow((phCur - 7.0) / 1.9, 2));
  const isEnzymeDenature = T > 348.15 || phCur < 2.2 || phCur > 11.4;
  const denatureK = T > 348.15 ? 4.5 + Math.max(0, T - 348.15) * 0.25 : 3.2;
  for (const [enzAq, enzDen, enzName] of [
    ['Amylase_aq', 'AmylaseDenatured_s', 'Amylase'],
    ['Catalase_aq', 'CatalaseDenatured_s', 'Catalase'],
  ]) {
    if ((moles[enzAq] || 0) > 1e-12 && isEnzymeDenature) {
      let dDen = moles[enzAq] * (1 - Math.exp(-denatureK * dt));
      if (moles[enzAq] - dDen < 1e-8) dDen = moles[enzAq];
      if (dDen > 1e-12) {
        moles[enzAq] = Math.max(0, moles[enzAq] - dDen);
        if (moles[enzAq] < 1e-12) delete moles[enzAq];
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
    if ((moles.Amylase_aq || 0) > 1e-9 && ((moles.Starch_aq || 0) > 1e-8 || (moles.StarchI2_aq || 0) > 1e-8)) {
      const kEnzSt = 2.8 * enzymeActFactor;
      const dEnzM = Math.min((moles.Starch_aq || 0) / 2, moles.H2O_l) * (1 - Math.exp(-kEnzSt * dt));
      const dEnzI2 = Math.min((moles.StarchI2_aq || 0) / 2, moles.H2O_l) * (1 - Math.exp(-kEnzSt * dt));
      if (dEnzM > 1e-11 || dEnzI2 > 1e-11) {
        if (dEnzM > 1e-11) {
          moles.Starch_aq = Math.max(0, moles.Starch_aq - 2 * dEnzM);
          if (moles.Starch_aq < 1e-13) delete moles.Starch_aq;
        }
        if (dEnzI2 > 1e-11) {
          moles.StarchI2_aq = Math.max(0, moles.StarchI2_aq - 2 * dEnzI2);
          if (moles.StarchI2_aq < 1e-13) delete moles.StarchI2_aq;
          moles.I2_aq = (moles.I2_aq || 0) + 2 * dEnzI2;
        }
        const totMal = dEnzM + dEnzI2;
        moles.H2O_l = Math.max(0, moles.H2O_l - totMal);
        moles.Maltose_aq = (moles.Maltose_aq || 0) + totMal;
        activeReactions.push({
          id: 'amylase_starch_maltose',
          equation: 'Tinh bột + H₂O —(Amylase, ~37 °C)→ Maltose',
          nameVi: 'Enzyme Amylase thủy phân Tinh bột thành Maltose',
          nameEn: 'Amylase-catalyzed hydrolysis of Starch into Maltose',
          descVi: `Hoạt tính Amylase hiện tại ${(enzymeActFactor * 100).toFixed(0)}% (tối ưu quanh 37–40 °C, pH 7), làm mất màu xanh tím phức [Tinh bột · I₂].`,
          descEn: `Amylase catalytic activity at ${(enzymeActFactor * 100).toFixed(0)}% (bell optimum ~38 °C, pH 7), decolorizing blue [Starch · I₂].`,
          rateMolS: totMal / dt,
          dXi: totMal,
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
 * Heterogeneous Nickel (Ni_s) Catalytic Hydrogenation:
 * Requires Ni_s catalyst + headspace H2_g + heating (T >= 373.15 K / 100 °C).
 * Drives Triolein/Trilinolein fat hardening -> Tristearin, HCHO/CH3CHO reduction -> alcohols,
 * and alkene/alkyne hydrogen additions.
 */
function stepNickelHydrogenation(vessel, dt, activeReactions, gasProduced) {
  if (!vessel || vessel.isFrozenSolid || dt <= 0) return 0;
  const moles = vessel.moles;
  const head = vessel.headspaceGasMoles || {};
  const nNi = moles?.Ni_s || 0;
  const nH2Init = head.H2_g || 0;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  if (nNi <= 1e-8 || nH2Init <= 1e-8 || T < 373.15) return 0;

  let heatJ = 0;
  const pCount = vessel.particleCounts?.Ni_s ?? 6;
  const isFine = Boolean(vessel.groundPowderMap?.Ni_s) || pCount >= 18;
  const catFactor = Math.min(4.5, (0.4 + nNi * 30.0) * (isFine ? 1.85 : 1.0) * ((vessel.stirTimer || 0) > 0 ? 1.6 : 1.0));
  const tFactor = Math.min(3.5, Math.exp((T - 423.15) / 55.0));

  // 1. Fat hardening: unsaturated triglycerides (isFat && hydrogenatedSpeciesId) + n H2 -> solid Tristearin
  for (const spId of Object.keys(moles)) {
    const sp = SPECIES[spId];
    const nFat = moles[spId] || 0;
    const h2Now = head.H2_g || 0;
    if (!sp?.isFat || !sp.hydrogenatedSpeciesId || !SPECIES[sp.hydrogenatedSpeciesId] || nFat <= 1e-9 || h2Now <= 1e-8) continue;
    const nH2Need = Math.max(1, Number(sp.doubleBondsPerMolecule) || 3);
    const kFat = 0.55 * catFactor * tFactor;
    const dExt = Math.min(nFat, h2Now / nH2Need) * (1 - Math.exp(-kFat * dt));
    if (dExt > 1e-12) {
      moles[spId] = Math.max(0, nFat - dExt);
      if (moles[spId] < 1e-13) delete moles[spId];
      head.H2_g = Math.max(0, h2Now - nH2Need * dExt);
      const targetId = sp.hydrogenatedSpeciesId;
      moles[targetId] = (moles[targetId] || 0) + dExt;
      heatJ += dExt * nH2Need * 124000;
      activeReactions.push({
        id: `ni_h2_fat_${spId}`,
        equation: `${sp.formula} + ${nH2Need}H₂(g) —(Ni, t°)→ ${SPECIES[targetId].formula} (bơ rắn)`,
        nameVi: `Cộng H₂ (xúc tác Ni, t°) chuyển hóa chất béo lỏng thành ${SPECIES[targetId].name}`,
        nameEn: `Nickel-catalyzed hydrogenation hardening fat to solid ${SPECIES[targetId].name}`,
        descVi: 'Xúc tác Ni và đun nóng cộng H₂ bão hòa các nối đôi C=C làm dầu thực vật lỏng rắn hóa thành mỡ rắn.',
        descEn: 'Ni catalysis saturates C=C bonds with H₂(g), hardening liquid vegetable oil into solid Tristearin.',
        rateMolS: dExt / dt,
        dXi: dExt,
      });
    }
  }

  // 2. Aldehyde reduction: HCHO + H2 -> CH3OH, CH3CHO + H2 -> C2H5OH
  for (const [aldId, alcId, aldName] of [
    ['HCHO_aq', 'CH3OH_l', 'Formaldehyde (HCHO)'],
    ['CH3CHO_l', 'C2H5OH_l', 'Acetaldehyde (CH₃CHO)'],
  ]) {
    const nAld = moles[aldId] || 0;
    const h2Now = head.H2_g || 0;
    if (nAld > 1e-9 && h2Now > 1e-8 && SPECIES[alcId]) {
      const kAld = 0.72 * catFactor * tFactor;
      const dExt = Math.min(nAld, h2Now) * (1 - Math.exp(-kAld * dt));
      if (dExt > 1e-12) {
        moles[aldId] = Math.max(0, nAld - dExt);
        if (moles[aldId] < 1e-13) delete moles[aldId];
        head.H2_g = Math.max(0, h2Now - dExt);
        moles[alcId] = (moles[alcId] || 0) + dExt;
        heatJ += dExt * 82000;
        activeReactions.push({
          id: `ni_h2_ald_${aldId}`,
          equation: `${SPECIES[aldId]?.formula || aldId} + H₂(g) —(Ni, t°)→ ${SPECIES[alcId].formula}`,
          nameVi: `Khử ${aldName} bằng H₂ (xúc tác Ni) tạo ancol`,
          nameEn: `Nickel-catalyzed hydrogenation of ${aldName}`,
          descVi: 'Trên bề mặt xúc tác Nickel nung nóng, H₂ cộng vào nhóm C=O khử aldehyde thành alcohol.',
          descEn: 'Heated Nickel catalyzes H₂ addition across the carbonyl bond reducing aldehyde to alcohol.',
          rateMolS: dExt / dt,
          dXi: dExt,
        });
      }
    }
  }

  // 3. Unsaturated hydrocarbons hydrogenation (moles & headspace)
  const unsatTargets = [
    { src: 'C6H12_l', dst: 'C6H14_l', inHead: false, outHead: false },
    { src: 'C3H6_g', dst: 'C3H8_g', inHead: true, outHead: true },
    { src: 'C2H2_g', dst: 'C2H4_g', inHead: true, outHead: true },
    { src: 'C2H4_g', dst: 'C2H6_g', inHead: true, outHead: true },
  ];
  for (const ut of unsatTargets) {
    if (!SPECIES[ut.src] || !SPECIES[ut.dst]) continue;
    const srcMap = ut.inHead ? head : moles;
    const nSrc = srcMap[ut.src] || 0;
    const h2Now = head.H2_g || 0;
    if (nSrc <= 1e-9 || h2Now <= 1e-8) continue;
    const dExt = Math.min(nSrc, h2Now) * (1 - Math.exp(-0.85 * catFactor * tFactor * dt));
    if (dExt > 1e-12) {
      srcMap[ut.src] = Math.max(0, nSrc - dExt);
      if (!ut.inHead && srcMap[ut.src] < 1e-13) delete srcMap[ut.src];
      head.H2_g = Math.max(0, h2Now - dExt);
      if (ut.outHead) {
        if (gasProduced) gasProduced[ut.dst] = (gasProduced[ut.dst] || 0) + dExt;
        else head[ut.dst] = (head[ut.dst] || 0) + dExt;
      } else {
        moles[ut.dst] = (moles[ut.dst] || 0) + dExt;
      }
      heatJ += dExt * 136000;
      activeReactions.push({
        id: `ni_h2_${ut.src}`,
        equation: `${SPECIES[ut.src].formula} + H₂(g) —(Ni, t°)→ ${SPECIES[ut.dst].formula}`,
        nameVi: `Hydrogen hóa ${SPECIES[ut.src].name} (xúc tác Ni, t°)`,
        nameEn: `Ni-catalyzed hydrogenation of ${SPECIES[ut.src].name}`,
        descVi: 'Xúc tác Nickel cộng H₂ bão hòa liên kết bội hydrocarbon khi đun nóng.',
        descEn: 'Heated Nickel catalyzes hydrogen addition across unsaturated carbon bonds.',
        rateMolS: dExt / dt,
        dXi: dExt,
      });
    }
  }

  return heatJ;
}

const THERMAL_PYROLYSIS_SPECS = [
  {
    id: 'glycerol_acrolein_dehyd',
    equation: 'C₃H₅(OH)₃ —(270–310 °C)→ CH₂=CH–CHO(g)↑ + 2H₂O(g)↑',
    nameVi: 'Tách nước Glycerol gần nhiệt độ sôi tạo hơi Acrolein cay mắt',
    nameEn: 'High-temperature Glycerol dehydration yielding acrid Acrolein vapor',
    descVi: 'Ở vùng 270–310 °C sát nhiệt độ sôi, một phần Glycerol mất nước tạo khí Acrolein có mùi khét cay mắt.',
    descEn: 'Near its 290 °C boiling point, Glycerol partially dehydrates into pungent Acrolein vapor and steam.',
    reactantId: 'C3H5OH_3_l',
    reactantStoich: 1,
    products: { CH2CHCHO_g: 1, H2O_g: 2 },
    minTempK: 543.15,
    kBase: 0.14,
  },
  {
    id: 'triolein_smoke_acrolein',
    equation: '(C₁₇H₃₃COO)₃C₃H₅ —(240–350 °C)→ Acrolein↑ + 2 C₁₇H₃₃COOH + Khí hidrocacbon',
    nameVi: 'Phân hủy điểm khói Triolein (240–350 °C) tạo Acrolein & Oleic acid',
    nameEn: 'Triolein smoke-point breakdown (240–350 °C) yielding Acrolein & Oleic acid',
    descVi: 'Trên 240 °C trước khi sôi, khung glycerol của Triolein đứt gãy tạo khói cay Acrolein và acid béo tự do.',
    descEn: 'Above its 240 °C smoke point, Triolein cleaves into acrid Acrolein fumes, free Oleic acid, and light alkenes.',
    reactantId: 'C57H104O6_l',
    reactantStoich: 1,
    products: { CH2CHCHO_g: 1, C17H33COOH_l: 2, H2O_g: 1, C2H4_g: 6, C6H6_g: 1 },
    minTempK: 513.15,
    maxTempK: 623.15,
    kBase: 0.52,
  },
  {
    id: 'triolein_cracking',
    equation: 'Triolein —(>350 °C)→ C(muội) + CH₄↑ + C₂H₄↑ + CO↑ + CO₂↑ + H₂O↑',
    nameVi: 'Cracking bẻ mạch Triolein (>350 °C) sinh khí cháy & muội than đen',
    nameEn: 'Thermal cracking of Triolein (>350 °C) into flammable gases & carbon soot',
    descVi: 'Trên 350 °C mạch hidrocacbon dài của Triolein gãy hoàn toàn thành khí dễ cháy và cặn carbon đen.',
    descEn: 'Above 350 °C Triolein chains crack completely into light hydrocarbons, CO/CO₂, and black carbon soot.',
    reactantId: 'C57H104O6_l',
    reactantStoich: 1,
    products: { C_s: 21, CO2_g: 2, CO_g: 1, H2O_g: 1, C2H4_g: 9, CH4_g: 15, H2_g: 3 },
    minTempK: 623.15,
    kBase: 1.05,
  },
  {
    id: 'oleic_cracking',
    equation: '2 C₁₇H₃₃COOH —(>350 °C)→ 12 C(muội) + C₂H₄↑ + CH₄↑ + CO/CO₂↑ + H₂O↑',
    nameVi: 'Cracking nhiệt Oleic acid (>350 °C) tạo khí cháy & muội than C',
    nameEn: 'Thermal cracking of Oleic acid (>350 °C) yielding light gases & carbon soot',
    descVi: 'Acid béo mạch dài bẻ mạch trên 350 °C tạo hỗn hợp khí CH₄, C₂H₄, CO, CO₂ và cặn than C.',
    descEn: 'Above 350 °C Oleic acid undergoes C–C cracking to light combustible gases and soot.',
    reactantId: 'C17H33COOH_l',
    reactantStoich: 2,
    products: { C_s: 12, CO2_g: 1, CO_g: 1, H2O_g: 1, C2H4_g: 6, CH4_g: 10, H2_g: 1 },
    minTempK: 623.15,
    kBase: 1.05,
  },
  {
    id: 'fructose_caramelize',
    equation: '2 C₆H₁₂O₆ (Fructose) —(≥110 °C)→ C₁₂H₁₈O₉ (Caramel) + 3H₂O(g)↑',
    nameVi: 'Caramen hóa Fructose sớm (≥110 °C) tách nước hóa vàng nâu',
    nameEn: 'Early Fructose caramelization (≥110 °C) with dehydration',
    descVi: 'Fructose nóng chảy (~103 °C) và caramen hóa sớm nhất ở ≥110 °C, ngả vàng nâu và tách hơi nước.',
    descEn: 'Fructose melts (~103 °C) and caramelizes earliest above 110 °C, browning and releasing steam.',
    reactantId: 'Fructose_s',
    reactantStoich: 2,
    products: { Caramel_s: 1, H2O_g: 3 },
    minTempK: 383.15,
    kBase: 0.75,
  },
  {
    id: 'glucose_caramelize',
    equation: '2 C₆H₁₂O₆ (Glucose) —(≥160 °C)→ C₁₂H₁₈O₉ (Caramel) + 3H₂O(g)↑',
    nameVi: 'Caramen hóa Glucose (≥160 °C) hóa hổ phách nâu & tách nước',
    nameEn: 'Glucose caramelization (≥160 °C) yielding amber Caramel + H₂O↑',
    descVi: 'Sau khi nóng chảy quanh 146 °C, Glucose caramen hóa mạnh từ 160 °C thành hỗn hợp caramel nâu thơm.',
    descEn: 'After melting near 146 °C, Glucose dehydrates cleanly at ≥160 °C into amber caramel.',
    reactantId: 'Glucose_s',
    reactantStoich: 2,
    products: { Caramel_s: 1, H2O_g: 3 },
    minTempK: 433.15,
    kBase: 0.78,
  },
  {
    id: 'sucrose_invert_caramel',
    equation: '2 C₁₂H₂₂O₁₁ (Sucrose) —(160–170 °C)→ Caramel + Glucose + Fructose + H₂O↑',
    nameVi: 'Nóng chảy & nghịch đảo Sucrose (160–170 °C) trước caramen hóa',
    nameEn: 'Sucrose thermal inversion & early caramelization (160–170 °C)',
    descVi: 'Quanh 160–186 °C Sucrose tách thành Glucose + Fructose và bắt đầu chuyển thành Caramel nâu.',
    descEn: 'Around 160–186 °C Sucrose splits into Glucose/Fructose mixtures as caramelization begins.',
    reactantId: 'Sucrose_s',
    reactantStoich: 2,
    products: { Caramel_s: 1, Glucose_s: 1, Fructose_s: 1, H2O_g: 1 },
    minTempK: 433.15,
    maxTempK: 443.15,
    kBase: 0.55,
  },
  {
    id: 'sucrose_caramelize',
    equation: 'C₁₂H₂₂O₁₁ (Sucrose) —(≥170 °C)→ C₁₂H₁₈O₉ (Caramel) + 2H₂O(g)↑',
    nameVi: 'Caramen hóa mạnh Sucrose (≥170 °C) tạo Caramel nâu & H₂O↑',
    nameEn: 'Rapid Sucrose caramelization (≥170 °C) forming brown Caramel + steam',
    descVi: 'Ở 170–200 °C Sucrose tách nước mạnh thành siro/khối Caramel màu hổ phách đậm.',
    descEn: 'Above 170 °C Sucrose caramelizes rapidly with vigorous dehydration to dark amber Caramel.',
    reactantId: 'Sucrose_s',
    reactantStoich: 1,
    products: { Caramel_s: 1, H2O_g: 2 },
    minTempK: 443.15,
    kBase: 0.88,
  },
  {
    id: 'starch_dextrinize',
    equation: '(C₆H₁₀O₅)ₙ (Tinh bột) —(≥220 °C)→ Dextrin (vàng nâu)',
    nameVi: 'Dextrin hóa Tinh bột không nóng chảy (≥220 °C) hóa vàng nâu',
    nameEn: 'Solid-state Starch dextrinization (≥220 °C) turning yellow-brown',
    descVi: 'Tinh bột không nóng chảy mà đứt mạch glycoside ở 220–250 °C thành Dextrin màu vàng nâu.',
    descEn: 'Without melting, Starch cleaves glycosidic bonds at 220–250 °C forming golden-brown Dextrin.',
    reactantId: 'Starch_s',
    reactantStoich: 1,
    products: { Dextrin_s: 1 },
    minTempK: 493.15,
    kBase: 0.85,
  },
  {
    id: 'caramel_pyrolysis',
    equation: 'C₁₂H₁₈O₉ (Caramel) —(≥250 °C)→ 7C(s) + 4H₂O↑ + CO₂↑ + CO↑ + CH₃COOH↑ + CH₄↑ + H₂↑',
    nameVi: 'Nhiệt phân & than hóa Caramel (≥250 °C) tạo bọt than C đen & khí',
    nameEn: 'Caramel pyrolysis & charring (≥250 °C) yielding porous C_s + volatiles',
    descVi: 'Trên 250 °C đường caramen sủi bọt phồng xốp thành than đen C và giải phóng H₂O, CO₂, CO, CH₃COOH, CH₄.',
    descEn: 'Above 250 °C caramelized sugar foams vigorously into black char and CO/CO₂/AcOH/CH₄ gases.',
    reactantId: 'Caramel_s',
    reactantStoich: 1,
    products: { C_s: 7, CH3COOH_g: 1, CO2_g: 1, CO_g: 1, H2O_g: 4, CH4_g: 1, H2_g: 1 },
    minTempK: 523.15,
    kBase: 0.95,
  },
  {
    id: 'dextrin_pyrolysis',
    equation: '2 Dextrin —(≥250 °C)→ 7C(s) + 5H₂O↑ + CO₂↑ + CO↑ + CH₃COOH↑ + CH₄↑ + H₂↑',
    nameVi: 'Than hóa Dextrin / Tinh bột (≥250 °C) tạo cặn carbon C đen & khí',
    nameEn: 'Dextrin / Starch carbonization (≥250 °C) yielding carbon char + volatiles',
    descVi: 'Dextrin từ Tinh bột nhiệt phân mạnh ở 250–350 °C tạo bọt than xốp C và hơi acid acetic, CO, CO₂.',
    descEn: 'Dextrin pyrolyzes above 250 °C into black carbon char plus steam, acetic acid vapor, CO, and CO₂.',
    reactantId: 'Dextrin_s',
    reactantStoich: 2,
    products: { C_s: 7, CH3COOH_g: 1, CO2_g: 1, CO_g: 1, H2O_g: 5, CH4_g: 1, H2_g: 1 },
    minTempK: 523.15,
    kBase: 0.95,
  },
  {
    id: 'cellulose_pyrolysis',
    equation: '2 (C₆H₁₀O₅)ₙ (Cellulose) —(≥280–350 °C)→ 8C(s) + CO₂↑ + 2CO↑ + 6H₂O↑ + CH₄↑ + 2H₂↑',
    nameVi: 'Nhiệt phân sợi Cellulose (≥280–350 °C) tạo than xốp C & khí cháy',
    nameEn: 'Cellulose fiber pyrolysis (≥280–350 °C) yielding porous char & syngas',
    descVi: 'Cellulose bền nhất trong 5 carbohydrate (ổn định tới ~270 °C), chỉ đứt mạch mạnh từ 280–350 °C thành than C và CO, CH₄, H₂, CO₂, H₂O.',
    descEn: 'Cellulose stays intact until ~270–280 °C, then thermally depolymerizes around 350 °C into char and CO/CH₄/H₂.',
    reactantId: 'Cellulose_s',
    reactantStoich: 2,
    products: { C_s: 8, CO2_g: 1, CO_g: 2, H2O_g: 6, CH4_g: 1, H2_g: 2 },
    minTempK: 553.15,
    kBase: 0.32,
    hotBoostTempK: 613.15,
    hotBoostMult: 3.2,
  },
  {
    id: 'glycine_polycondense',
    equation: '2 H₂N–CH₂–COOH —(≥233 °C)→ Polypeptide(s) + H₂O(g)↑',
    nameVi: 'Ngưng tụ nhiệt Glycine (233–260 °C) tách nước tạo vòng/chuỗi DKP–Peptide',
    nameEn: 'Glycine melt polycondensation (233–260 °C) to Peptide/DKP + steam',
    descVi: 'Glycine bền tinh thể dưới 220 °C; ở 233–260 °C vừa nóng chảy vừa trùng ngưng sủi bọt tạo vòng DKP/peptide và hơi nước.',
    descEn: 'Crystalline below 220 °C, Glycine decomposes upon melting (233–260 °C) forming DKP/peptide condensates and steam.',
    reactantId: 'Glycine_s',
    reactantStoich: 2,
    products: { Peptide_s: 1, H2O_g: 1 },
    minTempK: 506.15,
    kBase: 0.65,
  },
  {
    id: 'glycine_decarboxylation',
    equation: 'H₂N–CH₂–COOH —(≥233 °C)→ CH₃NH₂(g)↑ + CO₂(g)↑',
    nameVi: 'Decarboxyl hóa Glycine (233–260 °C) giải phóng Methylamine & CO₂↑',
    nameEn: 'Glycine thermal decarboxylation (233–260 °C) into CH₃NH₂↑ + CO₂↑',
    descVi: 'Nhóm –COOH của Glycine tách thành CO₂ giải phóng khí Methylamine và gây sủi bọt mạnh.',
    descEn: 'Thermal decarboxylation cleaves Glycine cleanly into Methylamine and Carbon dioxide gas.',
    reactantId: 'Glycine_s',
    reactantStoich: 1,
    products: { CH3NH2_g: 1, CO2_g: 1 },
    minTempK: 506.15,
    kBase: 0.60,
  },
  {
    id: 'glycine_deaminate',
    equation: '2 H₂N–CH₂–COOH —(≥233 °C)→ 2NH₃(g)↑ + 2CO₂(g)↑ + C₂H₄(g)↑',
    nameVi: 'Khử amin nhiệt Glycine giải phóng NH₃↑ & CO₂↑',
    nameEn: 'Thermal deamination of Glycine releasing NH₃↑ and CO₂↑',
    descVi: 'Quá trình phân hủy nóng chảy đồng thời giải phóng mạnh khí NH₃ khai hăng cùng CO₂.',
    descEn: 'Concurrent deamination releases pungent Ammonia gas alongside Carbon dioxide.',
    reactantId: 'Glycine_s',
    reactantStoich: 2,
    products: { NH3_g: 2, CO2_g: 2, C2H4_g: 1 },
    minTempK: 506.15,
    kBase: 0.45,
  },
  {
    id: 'peptide_char_decomp',
    equation: '2 Peptide(s) —(260–500 °C)→ 2 C₃N (Than N) + HCN↑ + NH₃↑ + CO↑ + 5H₂O↑ + H₂↑',
    nameVi: 'Phân hủy vòng ngưng tụ Peptide (260–500 °C) sinh HCN↑, NH₃↑, CO↑ & nhựa than đen',
    nameEn: 'DKP / Peptide pyrolysis (260–500 °C) releasing HCN↑, NH₃↑, CO↑ & N-char',
    descVi: 'Từ 260–500 °C các vòng DKP và mạch peptide đứt gãy tạo bọt than giàu nitơ và giải phóng khí CO, NH₃, HCN độc.',
    descEn: 'From 260–500 °C DKP rings and peptides decompose into porous N-doped black char plus toxic HCN, NH₃, and CO.',
    reactantId: 'Peptide_s',
    reactantStoich: 2,
    products: { CharN_s: 2, HCN_g: 1, NH3_g: 1, CO_g: 1, H2O_g: 5, H2_g: 1 },
    minTempK: 533.15,
    kBase: 0.85,
  },
  {
    id: 'char_n_denitro',
    equation: '2 C₃N (Than N) —(900–1,500 °C, khí trơ)→ 6C(s) + N₂(g)↑',
    nameVi: 'Khử nitơ than hóa sâu (900–1,500 °C, khí trơ) tạo khung Carbon xốp C',
    nameEn: 'High-T N-doped char denitrogenation (900–1,500 °C, inert) → C_s + N₂↑',
    descVi: 'Trong khí trơ ở 900–1,500 °C, nguyên tử N thoát dần dạng N₂↑ để lại khung vật liệu carbon xốp tinh khiết.',
    descEn: 'Between 900 and 1,500 °C in inert gas, residual nitrogen evolves as N₂ leaving conductive porous carbon.',
    reactantId: 'CharN_s',
    reactantStoich: 2,
    products: { C_s: 6, N2_g: 1 },
    minTempK: 1173.15,
    requiresNoO2: true,
    kBase: 0.92,
  },
  {
    id: 'char_n_combust',
    equation: '2 C₃N (Than N) + 7O₂(g) —(≥450 °C)→ 6CO₂(g)↑ + 2NO(g)↑',
    nameVi: 'Đốt cháy hoàn toàn bọt than chứa Nitơ (≥450 °C trong không khí)',
    nameEn: 'Complete air combustion of N-doped char (≥450 °C) → CO₂↑ + NO↑',
    descVi: 'Trong không khí có O₂ từ 450–650 °C, than pha tạp nitơ cháy hết thành khí CO₂ và N₂/NO không còn cặn.',
    descEn: 'In air above 450 °C, nitrogenous char oxidizes completely to CO₂ and nitrogen oxides leaving zero ash.',
    reactantId: 'CharN_s',
    reactantStoich: 2,
    products: { CO2_g: 6, NO_g: 2 },
    o2Stoich: 7,
    heatPerXi: 2450000,
    minTempK: 723.15,
    kBase: 1.05,
  },
  {
    id: 'albumin_s_browning',
    equation: 'Albumin(s) —(150–220 °C)→ Albumin (vàng nâu) + H₂S(g)↑ + NH₃(g)↑ + H₂O(g)↑',
    nameVi: 'Biến màu vàng nâu Albumin khô (150–220 °C) đứt cầu disulfide tách H₂S↑, NH₃↑',
    nameEn: 'Albumin thermal browning & disulfide scission (150–220 °C) releasing H₂S↑, NH₃↑',
    descVi: 'Ở 150–220 °C khối protein khô cứng ngả vàng nâu, tách nước liên kết và bắt đầu thoát vết H₂S mùi trứng thối + NH₃.',
    descEn: 'At 150–220 °C dry Albumin browns and loses bound water while releasing trace rotten-egg H₂S and NH₃.',
    reactantId: 'Albumin_s',
    reactantStoich: 1,
    products: { AlbuminBrown_s: 1, H2S_g: 1, NH3_g: 1, H2O_g: 1 },
    minTempK: 423.15,
    kBase: 0.72,
  },
  {
    id: 'albumin_coag_browning',
    equation: 'Albumin↓ —(150–220 °C)→ Albumin (vàng nâu) + H₂S(g)↑ + NH₃(g)↑ + H₂O(g)↑',
    nameVi: 'Biến màu vàng nâu Albumin đông tụ (150–220 °C) tách H₂S↑, NH₃↑',
    nameEn: 'Coagulated Albumin thermal browning (150–220 °C) releasing H₂S↑, NH₃↑',
    descVi: 'Protein đông tụ mất nước ngả vàng nâu từ 150 °C kèm đứt cầu nối –S–S– giải phóng H₂S và NH₃.',
    descEn: 'Coagulated protein dehydrates to golden-brown at 150–220 °C releasing H₂S and NH₃.',
    reactantId: 'AlbuminCoagulated_s',
    reactantStoich: 1,
    products: { AlbuminBrown_s: 1, H2S_g: 1, NH3_g: 1, H2O_g: 1 },
    minTempK: 423.15,
    kBase: 0.72,
  },
  {
    id: 'albumin_brown_pyrolysis',
    equation: '2 Albumin (vàng nâu) —(220–450 °C)→ Than N,S + 8C(s) + NH₃↑ + H₂S↑ + HCN↑ + CO₂/CO↑ + CH₄↑',
    nameVi: 'Đứt gãy mạch polypeptide Albumin (220–450 °C) mùi khét sừng cháy & bọt than đen',
    nameEn: 'Albumin polypeptide pyrolysis (220–450 °C) yielding burnt-hair volatiles & black char',
    descVi: 'Nhiệt phân chính quanh 300–350 °C bẻ gãy hàng loạt liên kết peptide giải phóng NH₃, CO₂, CO, H₂S, HCN, CH₄ và tạo cặn than bọt.',
    descEn: 'Peaking at 300–350 °C, peptide backbone cleavage releases NH₃, H₂S, HCN, CO, CO₂, CH₄ leaving carbonaceous char.',
    reactantId: 'AlbuminBrown_s',
    reactantStoich: 2,
    products: { CharNS_s: 1, C_s: 8, H2S_g: 1, HCN_g: 2, NH3_g: 2, CO2_g: 2, CO_g: 2, H2O_g: 4, CH4_g: 4, H2_g: 2 },
    minTempK: 493.15,
    kBase: 0.48,
    hotBoostTempK: 573.15,
    hotBoostMult: 2.3,
  },
  {
    id: 'char_ns_desulfur_denitro',
    equation: 'C₆N₂S (Than N,S) —(1,000–1,500 °C, khí trơ)→ 6C(s) + N₂(g)↑ + S(g)↑',
    nameVi: 'Thoát hết S và N ở 1,000–1,500 °C (khí trơ) giữ lại khung Carbon bán graphit',
    nameEn: 'High-T N,S-char graphitization (1,000–1,500 °C, inert) → C_s + N₂↑ + S↑',
    descVi: 'Trong khí trơ ở 1,000–1,500 °C, lưu huỳnh và nitơ thoát hết để lại khung carbon bán graphit xốp bền nhiệt.',
    descEn: 'At 1,000–1,500 °C in inert gas, sulfur and nitrogen strip completely leaving a pure porous carbon skeleton.',
    reactantId: 'CharNS_s',
    reactantStoich: 1,
    products: { C_s: 6, N2_g: 1, S_g: 1 },
    minTempK: 1273.15,
    requiresNoO2: true,
    kBase: 0.92,
  },
  {
    id: 'char_ns_combust',
    equation: 'C₆N₂S (Than N,S) + 8O₂(g) —(≥500 °C)→ 6CO₂(g)↑ + 2NO(g)↑ + SO₂(g)↑',
    nameVi: 'Đốt cháy sạch bọt than Albumin (≥500 °C trong không khí) → CO₂ + NO + SO₂',
    nameEn: 'Air combustion of N,S-doped protein char (≥500 °C) → CO₂↑ + NO↑ + SO₂↑',
    descVi: 'Trong không khí có O₂ từ 500–700 °C, toàn bộ phần hữu cơ/than protein cháy sạch thành CO₂, NO và SO₂.',
    descEn: 'In air above 500 °C, N,S-doped protein char burns completely into CO₂, NO, and SO₂ gases.',
    reactantId: 'CharNS_s',
    reactantStoich: 1,
    products: { CO2_g: 6, NO_g: 2, SO2_g: 1 },
    o2Stoich: 8,
    heatPerXi: 2800000,
    minTempK: 773.15,
    kBase: 1.05,
  },
  // Prompt 96: Glutamic acid (180 °C), Lysine (210 °C), Alanine (250 °C), Valine (260 °C sublimation + 290 °C), Keratin (180 °C)
  {
    id: 'glutamic_lactonize_pyroglutamic',
    equation: 'Glutamic acid(s) —(180–205 °C)→ Pyroglutamic acid(s) + H₂O(g)↑',
    nameVi: 'Đóng vòng tách nước Glutamic acid (180–205 °C) tạo Pyroglutamic acid',
    nameEn: 'Glutamic acid cyclodehydration (180–205 °C) → Pyroglutamic acid + steam',
    descVi: 'Glutamic acid kém bền nhiệt nhất trong các amino acid thường gặp, nóng chảy đóng vòng lactam từ ~180 °C tách hơi nước.',
    descEn: 'Earliest decomposing amino acid: Glutamic acid cyclizes into Pyroglutamic lactam releasing steam at 180–205 °C.',
    reactantId: 'Glutamic_s',
    reactantStoich: 1,
    products: { Pyroglutamic_s: 1, H2O_g: 1 },
    minTempK: 453.15,
    kBase: 0.78,
    hotBoostTempK: 573.15,
    hotBoostMult: 3.2,
  },
  {
    id: 'pyroglutamic_decarboxyl_pyrrolidone',
    equation: 'Pyroglutamic(s) —(250–350 °C)→ 2-Pyrrolidone(g)↑ + CO₂(g)↑',
    nameVi: 'Decarboxyl hóa Pyroglutamic (250–350 °C) sinh hơi 2-Pyrrolidone & CO₂↑',
    nameEn: 'Pyroglutamic decarboxylation (250–350 °C) yielding 2-Pyrrolidone(g) + CO₂↑',
    descVi: 'Vòng lactam tiếp tục tách CO₂(g) tạo một phần hơi 2-Pyrrolidone mùi hắc nhẹ.',
    descEn: 'Thermal decarboxylation eliminates CO₂ producing volatile 2-Pyrrolidone vapor.',
    reactantId: 'Pyroglutamic_s',
    reactantStoich: 1,
    products: { C4H7NO_g: 1, CO2_g: 1 },
    minTempK: 523.15,
    kBase: 0.28,
    hotBoostTempK: 623.15,
    hotBoostMult: 2.5,
  },
  {
    id: 'pyroglutamic_condense_char',
    equation: '2 Pyroglutamic(s) —(250–380 °C)→ Polypeptide(s) + 3C(s) + CO₂↑ + CO↑ + CH₄↑ + H₂↑',
    nameVi: 'Ngưng tụ than hóa Pyroglutamic (250–380 °C) tạo bọt nhựa đen giàu Nitơ',
    nameEn: 'Pyroglutamic carbonization & resin condensation (250–380 °C) → N-rich char',
    descVi: 'Nhánh chủ đạo của Pyroglutamic ngưng tụ thành nhựa polyme và bọt than xốp (~22–28% khối lượng ban đầu).',
    descEn: 'Dominant carbonization pathway condenses Pyroglutamic acid into dense N-rich char residue (~22–28%).',
    reactantId: 'Pyroglutamic_s',
    reactantStoich: 2,
    products: { Peptide_s: 1, C_s: 3, CO2_g: 1, CO_g: 1, CH4_g: 1, H2_g: 1 },
    minTempK: 523.15,
    kBase: 0.85,
    hotBoostTempK: 623.15,
    hotBoostMult: 2.6,
  },
  {
    id: 'lysine_cyclize_caprolactam',
    equation: '2 Lysine(s) —(210–250 °C)→ ε-Caprolactam(s) + C₂H₅NH₂↑ + 2NH₃↑ + CO₂↑ + CO↑ + C₂H₄↑',
    nameVi: 'Khử amin đóng vòng Lysine (210–230 °C) tạo ε-Caprolactam & NH₃(g)↑',
    nameEn: 'Lysine thermal deamination & cyclization (210–230 °C) → ε-Caprolactam + NH₃↑',
    descVi: 'Lysine nóng chảy quanh 215 °C đồng thời tách mạnh NH₃↑ và đóng vòng thành ε-Caprolactam.',
    descEn: 'Around 215 °C, Lysine deaminates vigorously releasing Ammonia and ε-Caprolactam.',
    reactantId: 'Lysine_s',
    reactantStoich: 2,
    products: { Caprolactam_s: 1, C2H5NH2_g: 1, NH3_g: 2, CO2_g: 1, CO_g: 1, C2H4_g: 1 },
    minTempK: 483.15,
    kBase: 0.56,
  },
  {
    id: 'lysine_crosslink_nchar',
    equation: '2 Lysine(s) —(220–350 °C)→ 2 C₃N + 3C(s) + 2NH₃↑ + CO₂↑ + 2H₂O↑ + 2CH₄↑ + 5H₂↑',
    nameVi: 'Trùng ngưng khâu mạch Lysine tạo nhựa than xốp giàu N (~22% cặn)',
    nameEn: 'Lysine crosslinking carbonization → porous N-doped char & NH₃↑',
    descVi: 'Hai nhóm –NH₂ giúp Lysine khâu mạch mạnh tạo cặn than xốp giàu N ổn định tới 1,500 °C trong khí trơ.',
    descEn: 'Dual amine groups drive extensive crosslinking of Lysine into high-yield porous N-char.',
    reactantId: 'Lysine_s',
    reactantStoich: 2,
    products: { CharN_s: 2, C_s: 3, NH3_g: 2, CO2_g: 1, H2O_g: 2, CH4_g: 2, H2_g: 5 },
    minTempK: 493.15,
    kBase: 0.44,
  },
  {
    id: 'caprolactam_ring_open_pyro',
    equation: 'ε-Caprolactam(s) —(250–380 °C)→ Nylon-6(s)',
    nameVi: 'Mở vòng nhiệt ε-Caprolactam (250–380 °C) trùng hợp thành Nylon-6',
    nameEn: 'Ring-opening polymerization of ε-Caprolactam (250–380 °C) → Nylon-6',
    descVi: 'Vòng lactam 7 cạnh mở vòng trùng hợp nhanh thành chuỗi polyamide Nylon-6 nóng chảy.',
    descEn: 'Seven-membered Caprolactam ring opens thermally into Nylon-6 polyamide chains.',
    reactantId: 'Caprolactam_s',
    reactantStoich: 1,
    products: { Nylon6_s: 1 },
    minTempK: 523.15,
    kBase: 0.92,
  },
  {
    id: 'nylon6_secondary_pyrolysis',
    equation: '3 Nylon-6(s) —(350–500 °C)→ 2 C₃N + 2C(s) + HCN↑ + CO↑ + 2H₂O↑ + 2C₃H₆↑ + 2CH₄↑ + 4H₂↑',
    nameVi: 'Nhiệt phân thứ cấp chuỗi Nylon-6 (350–500 °C) giải phóng HCN↑, C₃H₆↑ & bọt than',
    nameEn: 'Nylon-6 secondary pyrolysis (350–500 °C) releasing HCN↑, propene & N-char',
    descVi: 'Mạch polyamide đứt gãy ở 350–500 °C sinh hydrocarbon nhẹ, HCN(g), CO và để lại bọt than C₃N + C.',
    descEn: 'High-temperature polyamide backbone scission yields volatiles and carbon char.',
    reactantId: 'Nylon6_s',
    reactantStoich: 3,
    products: { CharN_s: 2, C_s: 2, HCN_g: 1, CO_g: 1, H2O_g: 2, C3H6_g: 2, CH4_g: 2, H2_g: 4 },
    minTempK: 623.15,
    kBase: 0.98,
  },
  {
    id: 'alanine_decarboxyl',
    equation: 'CH₃CH(NH₂)COOH(s) —(250–320 °C)→ C₂H₅NH₂(g)↑ + CO₂(g)↑',
    nameVi: 'Decarboxyl hóa Alanine (250–320 °C) giải phóng Ethylamine & CO₂↑',
    nameEn: 'Alanine thermal decarboxylation (250–320 °C) → Ethylamine↑ + CO₂↑',
    descVi: 'Alanine bền nhiệt hơn Glycine và Lysine; từ 250 °C tách CO₂(g) giải phóng Ethylamine bay hơi.',
    descEn: 'More thermally stable than Gly/Lys, Alanine decarboxylates above 250 °C into volatile Ethylamine and CO₂.',
    reactantId: 'Alanine_s',
    reactantStoich: 1,
    products: { C2H5NH2_g: 1, CO2_g: 1 },
    minTempK: 523.15,
    kBase: 0.52,
  },
  {
    id: 'alanine_dkp_condense',
    equation: '2 Alanine(s) —(250–330 °C)→ Polypeptide(s) + C₂H₄(g)↑ + H₂O(g)↑',
    nameVi: 'Ngưng tụ DKP Alanine (250–330 °C) tạo trung gian vòng – peptide',
    nameEn: 'Alanine DKP/peptide condensation (250–330 °C)',
    descVi: 'Nhánh song song ngưng tụ tạo vòng diketopiperazine / peptide trước khi than hóa tiếp ở 350–500 °C.',
    descEn: 'Concurrent condensation forms DKP/peptide intermediates that subsequently carbonize.',
    reactantId: 'Alanine_s',
    reactantStoich: 2,
    products: { Peptide_s: 1, C2H4_g: 1, H2O_g: 1 },
    minTempK: 523.15,
    kBase: 0.48,
  },
  {
    id: 'valine_sublimation',
    equation: 'Valine(s) —(260–320 °C)→ Valine(g)↑ (thăng hoa mạnh)',
    nameVi: 'Thăng hoa Valine tinh thể (260–320 °C) bay hơi mạnh (< 10% cặn)',
    nameEn: 'Strong sublimation of Valine (260–320 °C) leaving minimal residue (< 10%)',
    descVi: 'Valine có nhánh isopropyl kỵ nước nên thăng hoa mạnh nhất trong nhóm amino acid, bay hơi nhanh làm cặn rắn < 5–10%.',
    descEn: 'Hydrophobic isopropyl sidechain gives Valine high volatility; vigorous sublimation leaves minimal char.',
    reactantId: 'Valine_s',
    reactantStoich: 1,
    products: { Valine_g: 1 },
    minTempK: 533.15,
    kBase: 1.48,
  },
  {
    id: 'valine_decarboxyl',
    equation: 'Valine(s) —(290–340 °C)→ i-C₄H₉NH₂(g)↑ + CO₂(g)↑',
    nameVi: 'Decarboxyl hóa Valine (290–340 °C) sinh Isobutylamine & CO₂↑',
    nameEn: 'Valine decarboxylation (290–340 °C) → Isobutylamine↑ + CO₂↑',
    descVi: 'Phần Valine chưa kịp thăng hoa bị decarboxyl hóa sinh Isobutylamine và khí CO₂.',
    descEn: 'Portion not lost to sublimation decarboxylates cleanly to Isobutylamine and CO₂.',
    reactantId: 'Valine_s',
    reactantStoich: 1,
    products: { iC4H9NH2_g: 1, CO2_g: 1 },
    minTempK: 563.15,
    kBase: 0.22,
  },
  {
    id: 'valine_crack_isobutene',
    equation: 'Valine(s) —(290–350 °C)→ C₄H₈(g)↑ + NH₃(g)↑ + CO₂(g)↑',
    nameVi: 'Bẻ mạch khử amin Valine (290–350 °C) sinh Isobutene, NH₃↑ & CO₂↑',
    nameEn: 'Valine deamination cracking → Isobutene↑ + NH₃↑ + CO₂↑',
    descVi: 'Tách đồng thời nhóm –NH₂ và –COOH sinh isobutene (C₄H₈), NH₃ và CO₂.',
    descEn: 'Thermal elimination releases Isobutene, Ammonia, and CO₂.',
    reactantId: 'Valine_s',
    reactantStoich: 1,
    products: { C4H8_g: 1, NH3_g: 1, CO2_g: 1 },
    minTempK: 563.15,
    kBase: 0.14,
  },
  {
    id: 'valine_dkp_trace',
    equation: '2 Valine(s) —(295–360 °C)→ Polypeptide(s) + C₄H₈↑ + C₂H₄↑ + H₂O↑',
    nameVi: 'Ngưng tụ vết vòng DKP từ Valine tạo lượng nhỏ nhựa than',
    nameEn: 'Minor Valine DKP condensation yielding trace char',
    descVi: 'Một tỷ lệ rất nhỏ Valine tạo trung gian peptide rồi than hóa.',
    descEn: 'Minor DKP condensation converts a small fraction into residual char.',
    reactantId: 'Valine_s',
    reactantStoich: 2,
    products: { Peptide_s: 1, C4H8_g: 1, C2H4_g: 1, H2O_g: 1 },
    minTempK: 568.15,
    kBase: 0.08,
  },
  {
    id: 'keratin_browning',
    equation: 'Keratin(s) —(180–260 °C)→ Keratin (sém nâu) + H₂S(g)↑ + NH₃(g)↑ + H₂O(g)↑',
    nameVi: 'Sém vàng nâu sợi Keratin (180–260 °C) tỏa mùi khét tóc/lông cháy (H₂S↑ + NH₃↑)',
    nameEn: 'Keratin thermal scorching (180–260 °C) emitting burnt-hair H₂S↑ & NH₃↑ odor',
    descVi: 'Từ 180 °C, sợi Keratin sém nâu, đứt cầu disulfua –S–S– giải phóng khí H₂S & NH₃ đặc trưng mùi sừng/lông vũ cháy.',
    descEn: 'Above 180 °C, Keratin fibers scorch brown and cleave disulfide crosslinks emitting signature burnt-feather H₂S and NH₃.',
    reactantId: 'Keratin_s',
    reactantStoich: 1,
    products: { KeratinBrown_s: 1, H2S_g: 1, NH3_g: 1, H2O_g: 1 },
    minTempK: 453.15,
    kBase: 0.72,
    hotBoostTempK: 573.15,
    hotBoostMult: 3.0,
  },
  {
    id: 'keratin_brown_pyrolysis',
    equation: '2 Keratin (sém nâu) —(260–450 °C)→ Than N,S + 5C(s) + H₂S↑ + 2HCN↑ + 2NH₃↑ + 2CO₂/2CO↑ + 3CH₄↑',
    nameVi: 'Bẻ mạch hoàn toàn Keratin sém nâu (260–450 °C) sinh NH₃↑, H₂S↑, HCN↑ & bọt than đen',
    nameEn: 'Scorched Keratin pyrolysis (260–450 °C) → burnt-protein volatiles & N,S-char',
    descVi: 'Nhiệt phân mạnh 260–450 °C giải phóng NH₃, H₂S, HCN, CO₂, CO, CH₄, H₂O và tạo khối bọt than đen C₆N₂S + C.',
    descEn: 'Between 260 and 450 °C, peptide backbone cleavage releases NH₃, H₂S, HCN, CO₂, CO, CH₄ leaving N,S-char.',
    reactantId: 'KeratinBrown_s',
    reactantStoich: 2,
    products: { CharNS_s: 1, C_s: 5, H2S_g: 1, HCN_g: 2, NH3_g: 2, CO2_g: 2, CO_g: 2, H2O_g: 4, CH4_g: 3 },
    minTempK: 533.15,
    kBase: 0.56,
    hotBoostTempK: 593.15,
    hotBoostMult: 2.2,
  },
];

function stepThermalPyrolysis(vessel, dt, activeReactions, gasProduced, getMolFn, options = {}) {
  if (!vessel || vessel.isFrozenSolid || dt <= 0) return 0;
  const moles = vessel.moles;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  const gasOut = gasProduced || vessel.headspaceGasMoles;
  let o2Avail = getMolFn('O2_g') || 0;
  let heatJ = 0;

  for (const spc of THERMAL_PYROLYSIS_SPECS) {
    if (T < spc.minTempK || (spc.maxTempK && T >= spc.maxTempK)) continue;
    const avail = moles[spc.reactantId] || 0;
    if (avail <= 1e-10) continue;
    if (spc.requiresNoO2 && o2Avail > 1e-8) continue;
    if (spc.o2Stoich > 0 && o2Avail <= 1e-9) continue;

    let effK = spc.kBase;
    if (spc.hotBoostTempK && T >= spc.hotBoostTempK) {
      effK *= spc.hotBoostMult || 2.0;
    }
    const maxXiReact = avail / spc.reactantStoich;
    let dXi = maxXiReact * (1 - Math.exp(-effK * dt));
    if (spc.o2Stoich > 0) {
      dXi = Math.min(dXi, o2Avail / spc.o2Stoich);
    }
    if (dXi <= 1e-12) continue;

    const usedR = spc.reactantStoich * dXi;
    moles[spc.reactantId] = Math.max(0, avail - usedR);
    if (moles[spc.reactantId] < 1e-13) delete moles[spc.reactantId];

    if (spc.o2Stoich > 0) {
      const o2Used = spc.o2Stoich * dXi;
      consumeO2Pool(vessel, o2Used, options.environment);
      o2Avail = Math.max(0, o2Avail - o2Used);
    }

    for (const [pId, pSt] of Object.entries(spc.products)) {
      const addM = pSt * dXi;
      if (addM <= 0) continue;
      if (SPECIES[pId]?.phase === 'g') {
        gasOut[pId] = (gasOut[pId] || 0) + addM;
      } else {
        moles[pId] = (moles[pId] || 0) + addM;
        if (pId === 'C_s' || pId === 'CharN_s' || pId === 'CharNS_s') {
          if (!vessel.particleCounts) vessel.particleCounts = {};
          vessel.particleCounts[pId] = Math.max(vessel.particleCounts[pId] || 0, 260);
        }
      }
    }

    if (spc.heatPerXi) heatJ += spc.heatPerXi * dXi;
    const emitsGas = Object.keys(spc.products).some((pId) => SPECIES[pId]?.phase === 'g');
    activeReactions.push({
      id: spc.id,
      equation: spc.equation,
      nameVi: spc.nameVi,
      nameEn: spc.nameEn,
      descVi: spc.descVi,
      descEn: spc.descEn,
      rateMolS: dXi / dt,
      vigorousGas: emitsGas,
      dXi,
    });
  }

  // Amorphous Carbon soot / charcoal glowing combustion in O2 (>= 400 °C)
  const nCarbon = moles.C_s || 0;
  if (nCarbon > 1e-10 && T >= 673.15 && o2Avail > 1e-9) {
    const sufficientO2 = o2Avail >= nCarbon * 0.65;
    const o2Stoich = sufficientO2 ? 1 : 0.5;
    const dBurn = Math.min(nCarbon, o2Avail / o2Stoich, nCarbon * (1 - Math.exp(-1.12 * dt)));
    if (dBurn > 1e-12) {
      moles.C_s = Math.max(0, nCarbon - dBurn);
      if (moles.C_s < 1e-13) delete moles.C_s;
      const o2Used = dBurn * o2Stoich;
      consumeO2Pool(vessel, o2Used, options.environment);
      o2Avail = Math.max(0, o2Avail - o2Used);
      const gasKey = sufficientO2 ? 'CO2_g' : 'CO_g';
      gasOut[gasKey] = (gasOut[gasKey] || 0) + dBurn;
      heatJ += dBurn * (sufficientO2 ? 393500 : 110500);
      activeReactions.push({
        id: sufficientO2 ? 'carbon_char_combust_co2' : 'carbon_char_combust_co',
        equation: sufficientO2 ? 'C(r) + O₂(g) —(≥400 °C)→ CO₂(g)↑' : '2C(r) + O₂(g) —(thiếu O₂)→ 2CO(g)↑',
        nameVi: sufficientO2 ? 'Đốt cháy hoàn toàn than C rực đỏ (≥400 °C) → CO₂↑' : 'Đốt cháy thiếu O₂ muội than C → CO↑',
        nameEn: sufficientO2 ? 'Glowing combustion of Carbon char (≥400 °C) → CO₂↑' : 'O₂-limited Carbon char combustion → CO↑',
        descVi: sufficientO2 ? 'Lớp muội than đen bốc cháy rực trong O₂ tạo khí CO₂ không để lại cặn.' : 'Trong môi trường thiếu Oxygen, than cháy tạo khí CO.',
        descEn: sufficientO2 ? 'Incandescent carbon char oxidizes completely in air leaving zero solid ash.' : 'Oxygen-starved char oxidation produces Carbon monoxide.',
        rateMolS: dBurn / dt,
        vigorousGas: true,
        dXi: dBurn,
      });
    }
  }

  return heatJ;
}

/**
 * Combined entry point for property-driven organic chemistry inside stepVesselChemistry.
 */
export function stepPropertyDrivenOrganic(vessel, strat, liquidVolL, dt, activeReactions, gasProduced, getMolFn, options = {}) {
  let heatJ = 0;
  heatJ += stepThermalPyrolysis(vessel, dt, activeReactions, gasProduced, getMolFn, options);
  heatJ += stepGeneralOrganicCombustion(vessel, dt, activeReactions, gasProduced, getMolFn, options);
  heatJ += stepFunctionalGroupTests(vessel, strat, liquidVolL, dt, activeReactions, { ...options, gasProduced });
  heatJ += stepNickelHydrogenation(vessel, dt, activeReactions, gasProduced);
  return heatJ;
}
