/**
 * Organic Chemistry Solver: Hydrocarbons, Polymers & Styrene (Split 81).
 */
import { CONSTANTS } from '../../../data/constants.js';
import { SPECIES } from '../../../data/species.js';
import { computeSulfuricAcidState } from '../../chemistryHelpers.js';

export function stepOrganicHydrocarbonsPolymers(ctx) {
  const {
    vessel, liquidVolL, dt, gasProduced, iceMob, options,
    moles, T, orgMob, uvOn, hs63, getG, takeG,
    consumeSpecies, pushRxn,
  } = ctx;
  let heatJ = 0;
  if (orgMob > 0) {
    // 7F. Hydrocarbons: Alkane (CH4, C2H6, C4H10), Alkene (C2H4, C3H6), Alkyne (C2H2, C3H4), Alkadiene (C4H6)
    // Alkane halogenation & cracking / pyrolysis
    if (getG('CH4_g') > 1e-9) {
      if (getG('Cl2_g') > 1e-9 && (uvOn || T >= 523.15)) {
        const dChCl = Math.min(getG('CH4_g'), getG('Cl2_g')) * (1 - Math.exp(-0.95 * dt));
        if (dChCl > 1e-11) {
          takeG('CH4_g', dChCl); takeG('Cl2_g', dChCl);
          gasProduced.CH3Cl_g = (gasProduced.CH3Cl_g || 0) + dChCl; gasProduced.HCl_g = (gasProduced.HCl_g || 0) + dChCl; heatJ += dChCl * 102000;
          pushRxn('ch4_cl2_uv', 'CH₄ + Cl₂ —(UV / t°)→ CH₃Cl + HCl↑', 'Thế Cl₂ vào Methane dưới ánh sáng UV → Chloromethane', 'Methane radical chlorination (UV) → CH₃Cl + HCl↑', 'Dưới tia UV hoặc 250–400 °C, Methane thế H bằng Cl₂ tạo Chloromethane và HCl.', 'UV light initiates radical chlorination of Methane to Chloromethane.', dChCl, true);
        }
      }
      if (T >= 1673.15) {
        const dChPyr = (getG('CH4_g') / 2) * (1 - Math.exp(-0.85 * dt));
        if (dChPyr > 1e-11) {
          takeG('CH4_g', 2 * dChPyr); gasProduced.C2H2_g = (gasProduced.C2H2_g || 0) + dChPyr; gasProduced.H2_g = (gasProduced.H2_g || 0) + 3 * dChPyr;
          pushRxn('ch4_1500_c2h2', '2CH₄ —(1500 °C, làm lạnh nhanh)→ C₂H₂ + 3H₂↑', 'Nhiệt phân Methane ở 1500 °C → Acetylene + 3H₂↑', 'Methane pyrolysis (1500 °C, quench) → Acetylene + 3H₂↑', 'Nung nhanh CH₄ ở 1500 °C rồi làm lạnh nhanh thu được khí Acetylene.', 'Rapid quenching of Methane pyrolysis at 1500 °C produces Acetylene.', dChPyr, true);
        }
      }
    }
    if (getG('C4H10_g') > 1e-9 && T >= 723.15 && (moles.Al2O3_s || moles.Cr2O3_s)) {
      const dCrk = getG('C4H10_g') * (1 - Math.exp(-0.72 * dt));
      if (dCrk > 1e-11) {
        takeG('C4H10_g', dCrk);
        if (T >= 853.15) {
          gasProduced.C4H6_g = (gasProduced.C4H6_g || 0) + dCrk; gasProduced.H2_g = (gasProduced.H2_g || 0) + 2 * dCrk;
          pushRxn('c4h10_dehyd_buta', 'C₄H₁₀ —(Cr₂O₃/Al₂O₃, 600 °C)→ C₄H₆ + 2H₂↑', 'Đehidro hóa Butane → Buta-1,3-diene + 2H₂↑', 'Butane dehydrogenation (600 °C) → Buta-1,3-diene', 'Đehidro hóa Butane ở 550–650 °C điều chế Buta-1,3-diene.', 'Catalytic dehydrogenation of Butane yields Buta-1,3-diene.', dCrk, true);
        } else {
          gasProduced.C2H4_g = (gasProduced.C2H4_g || 0) + dCrk; gasProduced.C2H6_g = (gasProduced.C2H6_g || 0) + dCrk;
          pushRxn('c4h10_cracking', 'C₄H₁₀ —(xt, 500 °C)→ C₂H₄ + C₂H₆', 'Cracking Butane → Ethylene + Ethane', 'Butane cracking (500 °C) → C₂H₄ + C₂H₆', 'Phản ứng bẻ gãy mạch carbon tạo Ethylene và Ethane.', 'Thermal/catalytic cracking of Butane yields Ethylene and Ethane.', dCrk, true);
        }
      }
    }

    // Alkene (C2H4_g) reactions: hydrogenation, polymerization PE, Br2 addition (already in 5C-4), Wagner (5C-5), vicinal dihalide Zn debromination
    if ((moles.C2H4Br2_l || 0) > 1e-9 && (moles.Zn_s || 0) > 1e-9 && ((moles.C2H5OH_l || 0) > 1e-5 || (moles.CH3COOH_l || 0) > 1e-5) && T >= 323.15) {
      const dDebr = Math.min(moles.C2H4Br2_l, moles.Zn_s) * (1 - Math.exp(-1.1 * dt));
      if (dDebr > 1e-11) {
        consumeSpecies('C2H4Br2_l', dDebr); consumeSpecies('Zn_s', dDebr);
        gasProduced.C2H4_g = (gasProduced.C2H4_g || 0) + dDebr; moles.Zn2_aq = (moles.Zn2_aq || 0) + dDebr; moles.Br_aq = (moles.Br_aq || 0) + 2 * dDebr;
        pushRxn('c2h4br2_zn_ethene', 'BrCH₂–CH₂Br + Zn —(EtOH, t°)→ C₂H₄↑ + ZnBr₂', 'Tách Br₂ từ 1,2-Dibromoethane bằng Zn → Ethylene', 'Debromination: C₂H₄Br₂ + Zn → Ethylene↑ + ZnBr₂', 'Bột Zn tách 2 nguyên tử Bromine liền kề tái tạo nối đôi C=C.', 'Zinc powder debrominates vicinal dibromide back to Ethylene.', dDebr, true);
      }
    }
    if (getG('C2H4_g') > 1e-9) {
      if (((moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8 || (moles.Pd_s || 0) > 1e-8) && getG('H2_g') > 1e-9 && (T >= 373.15 || moles.Pt_s || moles.Pd_s)) {
        const dEthH = Math.min(getG('C2H4_g'), getG('H2_g')) * (1 - Math.exp(-1.2 * dt));
        if (dEthH > 1e-11) {
          takeG('C2H4_g', dEthH); takeG('H2_g', dEthH); gasProduced.C2H6_g = (gasProduced.C2H6_g || 0) + dEthH; heatJ += dEthH * 136000;
          pushRxn('c2h4_h2_ethane', 'C₂H₄ + H₂ —(Ni/Pt, t°)→ C₂H₆', 'Hydro hóa Ethylene → Ethane', 'Ethylene hydrogenation → Ethane', 'Ethylene cộng 1H₂ trên xúc tác Ni/Pt tạo Ethane.', 'Catalytic hydrogenation converts Ethylene to Ethane.', dEthH, true);
        }
      }
      if ((moles.H2O_l || 0) > 1e-4 && (moles.H_aq || 0) > 1e-4 && T >= 343.15 && (moles.MnO4_aq || 0) < 1e-7) {
        const dEtHyd = Math.min(getG('C2H4_g'), moles.H2O_l) * (1 - Math.exp(-0.55 * dt));
        if (dEtHyd > 1e-11) {
          takeG('C2H4_g', dEtHyd); consumeSpecies('H2O_l', dEtHyd); moles.C2H5OH_l = (moles.C2H5OH_l || 0) + dEtHyd;
          pushRxn('c2h4_h2o_etoh', 'C₂H₄ + H₂O —(H⁺, t°)→ C₂H₅OH', 'Hợp nước Ethylene (xúc tác H⁺) → Ethanol', 'Acid-catalyzed hydration of Ethylene → Ethanol', 'Cộng nước vào Ethylene trong môi trường acid thu được Ethanol.', 'Acid-catalyzed hydration of Ethylene yields Ethanol.', dEtHyd);
        }
      }
    }

    // Alkyne (C2H2_g): AgNO3/NH3 -> Ag2C2↓ yellow, Kucherov Hg2+ -> CH3CHO, Trimerization 600 C -> C6H6, Dimerization CuCl/NH4Cl -> C4H4, KMnO4 -> C2O4^2- + MnO2↓, + H2 -> C2H4/C2H6
    if (getG('C2H2_g') > 1e-9) {
      if ((moles.AgNH3_2_aq || 0) > 1e-7 && (moles.OH_aq || 0) > 1e-7) {
        const dAgAc = Math.min(getG('C2H2_g'), moles.AgNH3_2_aq / 2, moles.OH_aq / 2) * (1 - Math.exp(-2.6 * dt));
        if (dAgAc > 1e-11) {
          takeG('C2H2_g', dAgAc); consumeSpecies('AgNH3_2_aq', 2 * dAgAc); consumeSpecies('OH_aq', 2 * dAgAc);
          moles.Ag2C2_s = (moles.Ag2C2_s || 0) + dAgAc; moles.NH3_aq = (moles.NH3_aq || 0) + 4 * dAgAc; moles.H2O_l = (moles.H2O_l || 0) + 2 * dAgAc;
          heatJ += dAgAc * 125000;
          pushRxn('c2h2_ag2c2', 'C₂H₂ + 2[Ag(NH₃)₂]OH → Ag₂C₂↓ (vàng nhạt) + 4NH₃ + 2H₂O', 'Acetylene + AgNO₃/NH₃ → kết tủa vàng nhạt Ag₂C₂↓', 'Acetylene + Tollens/Ag(NH₃)₂⁺ → yellow Ag₂C₂↓', 'Thế 2 nguyên tử H linh động ở nối ba đầu mạch bằng ion Ag⁺ tạo kết tủa vàng nhạt Bạc acetylide.', 'Terminal alkyne H atoms are replaced by Ag⁺ forming pale-yellow Silver acetylide↓.', dAgAc);
        }
      }
      if ((moles.MnO4_aq || 0) > 1e-7 && (moles.H2O_l || 0) > 1e-4) {
        const dAcKm = Math.min(getG('C2H2_g') / 3, moles.MnO4_aq / 8) * (1 - Math.exp(-1.4 * dt));
        if (dAcKm > 1e-11) {
          takeG('C2H2_g', 3 * dAcKm); consumeSpecies('MnO4_aq', 8 * dAcKm);
          moles.C2O4_2_aq = (moles.C2O4_2_aq || 0) + 3 * dAcKm; moles.MnO2_s = (moles.MnO2_s || 0) + 8 * dAcKm;
          moles.OH_aq = (moles.OH_aq || 0) + 2 * dAcKm; moles.H2O_l = (moles.H2O_l || 0) + 2 * dAcKm;
          pushRxn('c2h2_kmno4', '3C₂H₂ + 8MnO₄⁻ → 3C₂O₄²⁻ + 8MnO₂↓ + 2OH⁻ + 2H₂O', 'Oxi hóa Acetylene bằng KMnO₄ → Oxalate + MnO₂↓', 'Acetylene + KMnO₄ → Oxalate + 8MnO₂↓', 'Acetylene làm mất màu tím KMnO₄ ngay ở nhiệt độ phòng tạo kết tủa nâu đen MnO₂ và muối Oxalate.', 'Acetylene immediately decolorizes KMnO₄ forming brown-black MnO₂↓ and Oxalate.', dAcKm);
        }
      }
      if (T >= 873.15 && (moles.C_s || 0) > 1e-8) {
        const dTrim = (getG('C2H2_g') / 3) * (1 - Math.exp(-0.92 * dt));
        if (dTrim > 1e-11) {
          takeG('C2H2_g', 3 * dTrim); moles.C6H6_l = (moles.C6H6_l || 0) + dTrim; heatJ += dTrim * 600000;
          pushRxn('c2h2_trimer_benzene', '3C₂H₂ —(C hoạt tính, 600 °C)→ C₆H₆', 'Trime hóa Acetylene → Benzene', 'Acetylene trimerization (C, 600 °C) → Benzene', 'Dẫn Acetylene qua than hoạt tính nung ở 600 °C đóng vòng thơm tạo Benzene.', 'Trimerization over hot activated carbon at 600 °C produces Benzene.', dTrim);
        }
      }
      if ((moles.CuCl_s || 0) > 1e-8 && (moles.NH4_aq || 0) > 1e-6 && T >= 343.15) {
        const dDim = (getG('C2H2_g') / 2) * (1 - Math.exp(-0.78 * dt));
        if (dDim > 1e-11) {
          takeG('C2H2_g', 2 * dDim); gasProduced.C4H4_g = (gasProduced.C4H4_g || 0) + dDim;
          pushRxn('c2h2_dimer_vinylacetylene', '2C₂H₂ —(CuCl/NH₄Cl, 80 °C)→ CH≡C–CH=CH₂', 'Đime hóa Acetylene → Vinylacetylene C₄H₄', 'Acetylene dimerization → Vinylacetylene', 'Xúc tác CuCl/NH₄Cl ở 80 °C đime hóa Acetylene thành Vinylacetylene.', 'CuCl/NH₄Cl catalyzes Acetylene dimerization to Vinylacetylene.', dDim, true);
        }
      }
      if (((moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8) && getG('H2_g') > 1e-9 && T >= 373.15) {
        const dAcH2 = Math.min(getG('C2H2_g'), getG('H2_g') / 2) * (1 - Math.exp(-1.1 * dt));
        if (dAcH2 > 1e-11) {
          takeG('C2H2_g', dAcH2); takeG('H2_g', 2 * dAcH2); gasProduced.C2H6_g = (gasProduced.C2H6_g || 0) + dAcH2; heatJ += dAcH2 * 310000;
          pushRxn('c2h2_2h2_ethane', 'C₂H₂ + 2H₂ —(Ni, t°)→ C₂H₆', 'Hydro hóa hoàn toàn Acetylene → Ethane', 'Full hydrogenation: C₂H₂ + 2H₂ → Ethane', 'Xúc tác Ni cộng 2H₂ tạo alkane Ethane.', 'Ni-catalyzed full hydrogenation converts Acetylene to Ethane.', dAcH2, true);
        }
      }
      if ((moles.Cu_s || 0) > 1e-7 && (moles.CuCl_s || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-4 && (moles.H_aq || 0) > 1e-4 && T >= 333.15) {
        const dKuc = Math.min(getG('C2H2_g'), moles.H2O_l) * (1 - Math.exp(-0.85 * dt));
        if (dKuc > 1e-11) {
          takeG('C2H2_g', dKuc); consumeSpecies('H2O_l', dKuc); moles.CH3CHO_l = (moles.CH3CHO_l || 0) + dKuc;
          pushRxn('kucherov_c2h2', 'C₂H₂ + H₂O —(xt H⁺, t°)→ CH₃CHO', 'Hợp nước Kucherov Acetylene → Acetaldehyde', 'Kucherov hydration: C₂H₂ + H₂O → Acetaldehyde', 'Phản ứng Kucherov cộng nước vào Acetylene tạo Acetaldehyde.', 'Hydration of Acetylene gives Acetaldehyde.', dKuc);
        }
      }
      // Acetylene + HCl(g) -(HgCl2_s / Cl-, >= 403 K / 130–160 °C)-> Vinyl chloride CH2=CHCl(g)
      const hasVinylCat = (moles.HgCl2_s || 0) > 1e-8 || (moles.ZnCl2_s || 0) > 1e-8 || (moles.Cl_aq || 0) > 1e-5;
      if (hasVinylCat && getG('HCl_g') > 1e-9 && T >= 403.15) {
        const dVcm = Math.min(getG('C2H2_g'), getG('HCl_g')) * (1 - Math.exp(-0.88 * dt));
        if (dVcm > 1e-11) {
          takeG('C2H2_g', dVcm); takeG('HCl_g', dVcm);
          gasProduced.CH2CHCl_g = (gasProduced.CH2CHCl_g || 0) + dVcm;
          heatJ += dVcm * 99000;
          pushRxn('c2h2_hcl_vcm', 'C₂H₂(g) + HCl(g) —(HgCl₂, 150 °C)→ CH₂=CHCl(g)↑', 'Cộng HCl vào Acetylene điều chế Vinyl chloride (monomer PVC)', 'Hydrochlorination: C₂H₂ + HCl (HgCl₂, 150 °C) → Vinyl chloride', 'Xúc tác HgCl₂ ở ~150 °C cộng HCl theo tỉ lệ 1:1 vào Acetylene tạo Vinyl chloride.', 'HgCl₂-catalyzed hydrochlorination of Acetylene yields Vinyl chloride monomer.', dVcm, true);
        }
      }
    }
    // Vinyl chloride polymerization (headspace or dissolved CH2CHCl_g -> PVC_s)
    if (getG('CH2CHCl_g') > 1e-9 && T >= 328.15) {
      const hasPvcInit = (moles.H2O2_aq || 0) > 1e-8 || (moles.AlCl3_s || 0) > 1e-8 || T >= 353.15;
      if (hasPvcInit) {
        const dPvc = getG('CH2CHCl_g') * (1 - Math.exp(-0.72 * dt));
        if (dPvc > 1e-11) {
          takeG('CH2CHCl_g', dPvc);
          moles.PVC_s = (moles.PVC_s || 0) + dPvc;
          heatJ += dPvc * 95000;
          pushRxn('vcm_polymerize_pvc', 'n CH₂=CHCl —(t°, xt)→ (–CH₂–CHCl–)ₙ (PVC)', 'Trùng hợp Vinyl chloride → Poly(vinyl chloride) (PVC)', 'Vinyl chloride polymerization → PVC', 'Trùng hợp Vinyl chloride tạo polymer nhiệt dẻo PVC trắng không tan.', 'Chain polymerization of Vinyl chloride produces solid PVC.', dPvc);
        }
      }
    }
    if ((moles.Ag2C2_s || 0) > 1e-9 && (moles.H_aq || 0) > 1e-5) {
      const dAgAcid = Math.min(moles.Ag2C2_s, moles.H_aq / 2) * (1 - Math.exp(-2.8 * dt));
      if (dAgAcid > 1e-11) {
        consumeSpecies('Ag2C2_s', dAgAcid); consumeSpecies('H_aq', 2 * dAgAcid);
        moles.Ag_aq = (moles.Ag_aq || 0) + 2 * dAgAcid; gasProduced.C2H2_g = (gasProduced.C2H2_g || 0) + dAgAcid;
        pushRxn('ag2c2_acid_regen', 'Ag₂C₂↓ + 2H⁺ → 2Ag⁺ + C₂H₂↑', 'Hòa tan Ag₂C₂ bằng acid tái tạo Acetylene↑', 'Acid dissolves Ag₂C₂ regenerating C₂H₂↑', 'HCl hoặc HNO₃ hòa tan kết tủa Ag₂C₂ giải phóng lại khí Acetylene.', 'Mineral acid dissolves Silver acetylide regenerating Acetylene gas.', dAgAcid, true);
      }
    }

    // Alkadiene (Buta-1,3-diene C4H6_g): + Br2 -> C4H6Br2 (1,2 at <=253 K vs 1,4 at >=293 K), + C2H4 (Diels-Alder >=453 K -> C6H10_l), + Na -> Buna_s, + 2H2 (Ni)-> C4H10
    if (getG('C4H6_g') > 1e-9) {
      const brDiene = (moles.Br2_l || 0) > 1e-9 ? 'Br2_l' : (moles.Br2_aq || 0) > 1e-9 ? 'Br2_aq' : null;
      if (brDiene) {
        const dDiBr = Math.min(getG('C4H6_g'), moles[brDiene]) * (1 - Math.exp(-1.8 * dt));
        if (dDiBr > 1e-11) {
          takeG('C4H6_g', dDiBr); consumeSpecies(brDiene, dDiBr);
          moles.C4H6Br2_l = (moles.C4H6Br2_l || 0) + dDiBr;
          const modeLabel = T < 253.15 ? '1,2 (kiểm soát động học, -80 °C)' : '1,4 (kiểm soát nhiệt động, ≥ 25 °C)';
          pushRxn('c4h6_br2_12_14', `C₄H₆ + Br₂ → C₄H₆Br₂ (${modeLabel})`, `Cộng Br₂ vào Buta-1,3-diene kiểu ${modeLabel}`, `Buta-1,3-diene + Br₂ (${T < 253.15 ? '1,2-adduct' : '1,4-adduct'})`, 'Buta-1,3-diene ưu tiên cộng 1,2 ở nhiệt độ rất thấp và cộng 1,4 ở nhiệt độ thường/nóng.', 'Buta-1,3-diene favors 1,2-addition at cryo temperatures and 1,4-addition at ≥ 25 °C.', dDiBr);
        }
      }
      if ((moles.Na_s || 0) > 1e-8 && T >= 323.15 && (moles.H2O_l || 0) < 0.02) {
        if ((moles.C8H8_l || 0) > 1e-9) {
          const dBunaS = Math.min(getG('C4H6_g'), moles.C8H8_l) * (1 - Math.exp(-0.88 * dt));
          if (dBunaS > 1e-11) {
            takeG('C4H6_g', dBunaS); consumeSpecies('C8H8_l', dBunaS);
            moles.Buna_S_s = (moles.Buna_S_s || 0) + dBunaS;
            heatJ += dBunaS * 115000;
            pushRxn('c4h6_buna_s_rubber', 'C₄H₆ + C₆H₅CH=CH₂ —(Na, t°)→ Cao su Buna-S', 'Đồng trùng hợp Buta-1,3-diene & Styrene → cao su Buna-S', 'Copolymerization (Na, t°) → Buna-S Rubber', 'Kim loại Na đồng trùng hợp Buta-1,3-diene với Styrene tạo cao su Buna-S đàn hồi bền mài mòn.', 'Sodium-catalyzed copolymerization yields Buna-S rubber.', dBunaS);
          }
        } else {
          const dBuna = getG('C4H6_g') * (1 - Math.exp(-0.75 * dt));
          if (dBuna > 1e-11) {
            takeG('C4H6_g', dBuna); moles.Buna_s = (moles.Buna_s || 0) + dBuna;
            pushRxn('c4h6_buna_rubber', 'nCH₂=CH–CH=CH₂ —(Na, t°)→ (–CH₂–CH=CH–CH₂–)ₙ (Cao su Buna)', 'Trùng hợp 1,4 Buta-1,3-diene (xúc tác Na) → cao su Buna', '1,4-Polymerization (Na) → Buna rubber', 'Kim loại Na xúc tác trùng hợp 1,4 Buta-1,3-diene tạo cao su Buna đàn hồi.', 'Sodium-initiated 1,4-polymerization yields elastic Buna rubber.', dBuna);
          }
        }
      }
      if (getG('C2H4_g') > 1e-9 && T >= 453.15) {
        const dDA = Math.min(getG('C4H6_g'), getG('C2H4_g')) * (1 - Math.exp(-0.68 * dt));
        if (dDA > 1e-11) {
          takeG('C4H6_g', dDA); takeG('C2H4_g', dDA); moles.C6H10_l = (moles.C6H10_l || 0) + dDA;
          pushRxn('c4h6_diels_alder', 'C₄H₆ + C₂H₄ —(200 °C)→ C₆H₁₀ (Cyclohexene)', 'Cộng đóng vòng Diels–Alder → Cyclohexene', 'Diels–Alder [4+2] cycloaddition → Cyclohexene', 'Dien liên hợp cộng đóng vòng [4+2] với Ethylene tạo vòng 6 cạnh Cyclohexene.', '[4+2] Diels–Alder cycloaddition yields Cyclohexene.', dDA);
        }
      }
      if (((moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8) && getG('H2_g') > 1e-9 && T >= 373.15) {
        const dDiH = Math.min(getG('C4H6_g'), getG('H2_g') / 2) * (1 - Math.exp(-1.1 * dt));
        if (dDiH > 1e-11) {
          takeG('C4H6_g', dDiH); takeG('H2_g', 2 * dDiH); gasProduced.C4H10_g = (gasProduced.C4H10_g || 0) + dDiH;
          pushRxn('c4h6_2h2_butane', 'C₄H₆ + 2H₂ —(Ni, t°)→ C₄H₁₀', 'Hydro hóa hoàn toàn Buta-1,3-diene → Butane', 'Full hydrogenation of Buta-1,3-diene → Butane', 'Cộng 2H₂ tạo Butane.', 'Complete hydrogenation yields Butane.', dDiH, true);
        }
      }
    }

    // Monomer & Polymer Bridges: C6H12 -> AdipicAcid -> HexamethyleneDiamine/AdipoylChloride, Urea from CO2+NH3, Acrylonitrile from C3H6+NH3+O2
    if ((moles.C6H12_l || 0) > 1e-8 && getG('O2_g') > 1e-8 && T >= 423.15) {
      const dAdi = Math.min(moles.C6H12_l, getG('O2_g') / 2.5) * (1 - Math.exp(-0.55 * dt));
      if (dAdi > 1e-11) {
        consumeSpecies('C6H12_l', dAdi); takeG('O2_g', 2.5 * dAdi);
        moles.AdipicAcid_s = (moles.AdipicAcid_s || 0) + dAdi; moles.H2O_l = (moles.H2O_l || 0) + dAdi;
        heatJ += dAdi * 580000;
        pushRxn('cyclohexane_o2_adipic', 'C₆H₁₂ + 2.5O₂ —(t°)→ HOOC(CH₂)₄COOH + H₂O', 'Oxi hóa Cyclohexane → Adipic acid (monomer Nylon-6,6)', 'Oxidation of Cyclohexane → Adipic acid', 'Oxi hóa mở vòng Cyclohexane điều chế Adipic acid cho tổng hợp tơ Nylon-6,6.', 'Oxidative ring-opening of Cyclohexane produces Adipic acid.', dAdi);
      }
    }
    if ((moles.AdipicAcid_s || 0) > 1e-8) {
      if ((moles.Ni_s || 0) > 1e-8 && (getG('NH3_g') > 1e-8 || (moles.NH3_aq || 0) > 1e-8) && getG('H2_g') > 1e-8 && T >= 473.15) {
        const nNh = getG('NH3_g') + (moles.NH3_aq || 0);
        const dHmda = Math.min(moles.AdipicAcid_s, nNh / 2, getG('H2_g') / 4) * (1 - Math.exp(-0.62 * dt));
        if (dHmda > 1e-11) {
          consumeSpecies('AdipicAcid_s', dHmda); takeG('H2_g', 4 * dHmda);
          const mAq = Math.min(moles.NH3_aq || 0, 2 * dHmda);
          if (mAq > 0) consumeSpecies('NH3_aq', mAq);
          if (2 * dHmda - mAq > 1e-13) takeG('NH3_g', 2 * dHmda - mAq);
          moles.HexamethyleneDiamine_aq = (moles.HexamethyleneDiamine_aq || 0) + dHmda;
          moles.H2O_l = (moles.H2O_l || 0) + 4 * dHmda;
          pushRxn('adipic_hmda', 'HOOC(CH₂)₄COOH + 2NH₃ + 4H₂ —(Ni, t°)→ H₂N(CH₂)₆NH₂ + 4H₂O', 'Điều chế Hexamethylenediamine từ Adipic acid', 'Reduction of Adipic acid + NH₃/H₂ → Hexamethylenediamine', 'Amin hóa khử Adipic acid tạo Hexamethylenediamine.', 'Reductive amination converts Adipic acid to Hexamethylenediamine.', dHmda);
        }
      }
      if (getG('HCl_g') > 1e-8 && (moles.ZnCl2_s || 0) > 1e-8 && T >= 373.15) {
        const dAdCl = Math.min(moles.AdipicAcid_s, getG('HCl_g') / 2) * (1 - Math.exp(-0.72 * dt));
        if (dAdCl > 1e-11) {
          consumeSpecies('AdipicAcid_s', dAdCl); takeG('HCl_g', 2 * dAdCl);
          moles.AdipoylChloride_l = (moles.AdipoylChloride_l || 0) + dAdCl;
          moles.H2O_l = (moles.H2O_l || 0) + 2 * dAdCl;
          pushRxn('adipic_adipoyl_chloride', 'HOOC(CH₂)₄COOH + 2HCl —(ZnCl₂, t°)→ ClOC(CH₂)₄COCl + 2H₂O', 'Chuyển hóa Adipic acid → Adipoyl chloride', 'Conversion of Adipic acid → Adipoyl chloride', 'Điều chế Adipoyl chloride phục vụ phản ứng trùng ngưng 2 pha Nylon-6,6.', 'Forms Adipoyl chloride for two-phase Nylon-6,6 synthesis.', dAdCl);
        }
      }
    }
    if (getG('CO2_g') > 1e-8 && getG('NH3_g') > 1e-8 && T >= 433.15) {
      const dUrea = Math.min(getG('CO2_g'), getG('NH3_g') / 2) * (1 - Math.exp(-0.65 * dt));
      if (dUrea > 1e-11) {
        takeG('CO2_g', dUrea); takeG('NH3_g', 2 * dUrea);
        moles.Urea_s = (moles.Urea_s || 0) + dUrea; moles.H2O_l = (moles.H2O_l || 0) + dUrea;
        heatJ += dUrea * 119000;
        pushRxn('co2_nh3_urea', 'CO₂ + 2NH₃ —(t°, p)→ (H₂N)₂CO (Urea) + H₂O', 'Tổng hợp Urea từ CO₂ và NH₃', 'Bosch–Meiser Urea synthesis: CO₂ + 2NH₃ → Urea + H₂O', 'NH₃ kết hợp CO₂ ở nhiệt độ cao tạo tinh thể Urea (dùng làm phân đạm hoặc nhựa keo UF).', 'Thermal condensation of CO₂ and Ammonia yields Urea crystals.', dUrea);
      }
    }
    if (getG('C3H6_g') > 1e-8 && getG('NH3_g') > 1e-8 && getG('O2_g') > 1e-8 && T >= 673.15) {
      const dAcn = Math.min(getG('C3H6_g'), getG('NH3_g'), getG('O2_g') / 1.5) * (1 - Math.exp(-0.68 * dt));
      if (dAcn > 1e-11) {
        takeG('C3H6_g', dAcn); takeG('NH3_g', dAcn); takeG('O2_g', 1.5 * dAcn);
        moles.Acrylonitrile_l = (moles.Acrylonitrile_l || 0) + dAcn; moles.H2O_l = (moles.H2O_l || 0) + 3 * dAcn;
        heatJ += dAcn * 515000;
        pushRxn('propene_ammoxidation_acn', 'C₃H₆ + NH₃ + 1.5O₂ —(400 °C)→ CH₂=CH–CN + 3H₂O', 'Oxi hóa amoni Propene → Acrylonitrile (monomer tơ Nitron)', 'Sohio ammoxidation: Propene → Acrylonitrile monomer', 'Propene phản ứng với NH₃ và O₂ ở ~400 °C tạo Acrylonitrile điều chế tơ Nitron (Olon).', 'Ammoxidation converts Propene into Acrylonitrile for Nitron fibers.', dAcn);
      }
    }
  }

  // Hot catalytic gas/vapor dehydrogenation: Ethylbenzene(l/g) -(Fe2O3/Cr2O3/ZnO, >= 823 K)-> Styrene + H2↑
  const hasEbCatTop = (moles.Fe2O3_s || 0) > 1e-8 || (moles.Cr2O3_s || 0) > 1e-8 || (moles.ZnO_s || 0) > 1e-8;
  const hsEbTop = vessel.headspaceGasMoles || {};
  const nEbTop = (moles.C6H5C2H5_l || 0) + (moles.C6H5C2H5_g || 0) + (hsEbTop.C6H5C2H5_g || 0);
  if (hasEbCatTop && nEbTop > 1e-9 && T >= 823.15) {
    const dSty = nEbTop * (1 - Math.exp(-1.2 * dt));
    if (dSty > 1e-11) {
      let remSty = dSty;
      for (const kEb of ['C6H5C2H5_l', 'C6H5C2H5_g']) {
        if (remSty <= 1e-13) break;
        const u = Math.min(moles[kEb] || 0, remSty);
        if (u > 0) {
          consumeSpecies(kEb, u);
          remSty -= u;
        }
      }
      if (remSty > 1e-13 && hsEbTop.C6H5C2H5_g > 0) {
        const u = Math.min(hsEbTop.C6H5C2H5_g, remSty);
        hsEbTop.C6H5C2H5_g = Math.max(0, hsEbTop.C6H5C2H5_g - u);
        if (hsEbTop.C6H5C2H5_g < 1e-13) delete hsEbTop.C6H5C2H5_g;
      }
      gasProduced.C8H8_g = (gasProduced.C8H8_g || 0) + dSty;
      gasProduced.H2_g = (gasProduced.H2_g || 0) + dSty;
      heatJ -= dSty * 117000;
      pushRxn('ethylbenzene_dehyd_sty', 'C₆H₅C₂H₅ —(Fe₂O₃/Cr₂O₃/ZnO, 600 °C)→ C₆H₅CH=CH₂ + H₂↑', 'Đehidro hóa Ethylbenzene → Styrene + H₂↑', 'Catalytic dehydrogenation of Ethylbenzene → Styrene + H₂↑', 'Xúc tác Fe₂O₃/Cr₂O₃/ZnO ở ~600 °C tách H₂ chuyển Ethylbenzene thành Styrene.', 'High-temperature oxide catalysis dehydrogenates Ethylbenzene to Styrene.', dSty, true);
    }
  }
  return heatJ;
}
