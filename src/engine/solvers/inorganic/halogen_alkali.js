import { CONSTANTS } from '../../../data/constants.js';
import { SPECIES } from '../../../data/species.js';
import { applyEquilibriumShift, computeSulfuricAcidState, getVesselEffectiveO2Bar } from '../../chemistryHelpers.js';

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
