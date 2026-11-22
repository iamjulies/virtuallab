/**
 * Elemental Inorganic Solvers: Halogens, Sulfur, Carbon/Carbides, Ammine, Carbonate, Phosphorus, Silicon & Chromium.
 * Modularized from chemistry.js in Prompt 68.
 */
import { CONSTANTS } from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { applyEquilibriumShift, computeSulfuricAcidState, getVesselEffectiveO2Bar } from './chemistryHelpers.js';

/**
 * Halogen (Cl2 / Br2 / I2) phase dissolution, triiodide complexation, halide displacement,
 * temperature-dependent alkali disproportionation, water-catalyzed Al+I2 ignition & H2 + Br2/I2 synthesis.
 */
export function stepHalogenRedoxAndAlkali(vessel, liquidVolL, dt, activeReactions, gasProduced, strat, iceMob = 1) {
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
export function stepSulfurChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
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
export function stepCarbideAndCarbonChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
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

export function stepAmmineComplexEquilibria(vessel, liquidVolL, dt, activeReactions) {
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
export function stepCarbonateAndCO2Equilibria(vessel, liquidVolL, dt, activeReactions, gasProduced) {
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
export function stepPhosphorusChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
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
export function stepSiliconAndChromiumChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
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
