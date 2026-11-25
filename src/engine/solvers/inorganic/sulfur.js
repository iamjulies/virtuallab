import { CONSTANTS } from '../../../data/constants.js';
import { SPECIES } from '../../../data/species.js';
import { applyEquilibriumShift, computeSulfuricAcidState, getVesselEffectiveO2Bar } from '../../chemistryHelpers.js';

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
      { id: 'Ni', sId: 'Ni_s', cM: 1, cS: 1, minK: 693.15, rate: 7.5, prodS: 'NiS_s', propKey: '_nisPropagateTimer', heatJ: 82000, eq: 'Ni(s) + S(l/g) —(t° ≥ 420 °C)→ NiS(s)', nameVi: 'Nickel tác dụng với Sulfur đun nóng tạo Nickel(II) sulfide (NiS đen)', nameEn: 'Heated Nickel combines with Sulfur forming black Nickel(II) sulfide (NiS)' },
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
