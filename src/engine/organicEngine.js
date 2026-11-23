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
  let heatJ = 0;

  // Dissociate Glucose Cu(II) chelate back above 70 °C so warm Cu2O redox proceeds cleanly
  if (T >= 343.15 && (moles.CuGlc2_aq || 0) > 1e-8) {
    const dRel = moles.CuGlc2_aq * (1 - Math.exp(-2.8 * dt));
    moles.CuGlc2_aq = Math.max(0, moles.CuGlc2_aq - dRel);
    if (moles.CuGlc2_aq < 1e-13) delete moles.CuGlc2_aq;
    moles.CuOH2_s = (moles.CuOH2_s || 0) + dRel;
    moles.Glucose_aq = (moles.Glucose_aq || 0) + 2 * dRel;
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
    // 3. Property-driven Polyol Cu(OH)2 room-T azure chelation (hasVicinalDiol: Glucose, Sucrose)
    const polyolMap = { Glucose_aq: 'CuGlc2_aq', Sucrose_aq: 'CuSuc2_aq' };
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

    // Dissociate Glucose Cu(II) chelate back above 70 °C so warm Cu2O redox proceeds cleanly
    if (spId === 'CuGlc2_aq' && T >= 343.15 && (moles.CuGlc2_aq || 0) > 1e-8) {
      const dRel = moles.CuGlc2_aq * (1 - Math.exp(-2.8 * dt));
      moles.CuGlc2_aq = Math.max(0, moles.CuGlc2_aq - dRel);
      if (moles.CuGlc2_aq < 1e-13) delete moles.CuGlc2_aq;
      moles.CuOH2_s = (moles.CuOH2_s || 0) + dRel;
      moles.Glucose_aq = (moles.Glucose_aq || 0) + 2 * dRel;
    }

    // 4. Property-driven Aldehyde oxidation: Tollens Ag(NH3)2+ -> Ag mirror & Hot Cu(OH)2 -> Cu2O brick-red
    const aldProductMap = { Glucose_aq: 'Gluconate_aq', C2H5CHO_l: 'C2H5COO_aq', C6H5CHO_l: 'C6H5COO_aq' };
    if (fg.hasAldehydeGroup && !fg.legacyHandled && aldProductMap[spId]) {
      const prodSalt = aldProductMap[spId];
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
