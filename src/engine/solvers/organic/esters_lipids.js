/**
 * Organic Chemistry Solver: Methanol, Formic Acid, Polyols, Esters & Lipids (Split 81).
 */
import { CONSTANTS } from '../../../data/constants.js';
import { SPECIES } from '../../../data/species.js';
import { computeSulfuricAcidState } from '../../chemistryHelpers.js';

export function stepOrganicEstersLipids(ctx) {
  const {
    vessel, liquidVolL, dt, gasProduced, iceMob, options,
    moles, T, orgMob, uvOn, hs63, getG, takeG,
    consumeSpecies, pushRxn,
  } = ctx;
  let heatJ = 0;
  if (orgMob > 0) {
    // 7A. Methanol (CH3OH_l): + Na/K, + CuO(280 C)->HCHO, + HCOOH/CH3COOH (H2SO4 conc)
    if ((moles.CH3OH_l || 0) > 1e-9) {
      if ((moles.Na_s || 0) > 1e-9 && (moles.H2O_l || 0) < 0.02) {
        const dMeNa = Math.min(moles.CH3OH_l, moles.Na_s) * (1 - Math.exp(-3.2 * dt));
        if (dMeNa > 1e-11) {
          consumeSpecies('CH3OH_l', dMeNa); consumeSpecies('Na_s', dMeNa);
          moles.CH3O_aq = (moles.CH3O_aq || 0) + dMeNa; moles.Na_aq = (moles.Na_aq || 0) + dMeNa;
          gasProduced.H2_g = (gasProduced.H2_g || 0) + 0.5 * dMeNa; heatJ += dMeNa * 185000;
          pushRxn('meoh_na', 'CH₃OH + Na → CH₃ONa + ½H₂↑', 'Methanol tác dụng với Na giải phóng H₂↑', 'Methanol + Na → Sodium methoxide + ½H₂↑', 'Na thế H nhóm –OH trong Methanol giải phóng khí H₂.', 'Sodium reacts with Methanol evolving H₂ gas.', dMeNa, true);
        }
      }
      if ((moles.CuO_s || 0) > 1e-9 && T >= 523.15) {
        const dMeCuO = Math.min(moles.CH3OH_l, moles.CuO_s) * (1 - Math.exp(-1.2 * dt));
        if (dMeCuO > 1e-11) {
          consumeSpecies('CH3OH_l', dMeCuO); consumeSpecies('CuO_s', dMeCuO);
          gasProduced.HCHO_g = (gasProduced.HCHO_g || 0) + dMeCuO; moles.Cu_s = (moles.Cu_s || 0) + dMeCuO;
          gasProduced.H2O_g = (gasProduced.H2O_g || 0) + dMeCuO; heatJ += dMeCuO * 35000;
          pushRxn('meoh_cuo', 'CH₃OH + CuO —(250–300 °C)→ HCHO↑ + Cu↓ + H₂O↑', 'Oxi hóa Methanol bằng CuO nóng → Formaldehyde + Cu đỏ', 'Methanol + hot CuO → Formaldehyde + Cu↓', 'CuO oxi hóa Methanol ở 250–300 °C thành khí HCHO và đồng đỏ.', 'Hot CuO oxidizes Methanol vapor to Formaldehyde and metallic Cu.', dMeCuO, true);
        }
      }
      if ((moles.HCOOH_l || 0) > 1e-9 && ((moles.H2SO4_l || 0) > 1e-6 || (moles.HSO4_aq || 0) > 1e-4) && T >= 323.15) {
        const dEstMF = Math.min(moles.CH3OH_l, moles.HCOOH_l) * (1 - Math.exp(-0.92 * dt));
        if (dEstMF > 1e-11) {
          consumeSpecies('CH3OH_l', dEstMF); consumeSpecies('HCOOH_l', dEstMF);
          moles.HCOOCH3_l = (moles.HCOOCH3_l || 0) + dEstMF; moles.H2O_l = (moles.H2O_l || 0) + dEstMF;
          pushRxn('ester_methyl_formate', 'HCOOH + CH₃OH ⇌ HCOOCH₃ + H₂O', 'Ester hóa HCOOH + CH₃OH → Methyl formate', 'Esterification: Formic acid + Methanol → Methyl formate', 'Đun HCOOH với CH₃OH có xúc tác H₂SO₄ đặc tạo ester Methyl formate.', 'Fischer esterification of Formic acid with Methanol forms Methyl formate.', dEstMF);
        }
      }
      // Prepare HCHO / HCOOH from CH3OH via K2Cr2O7/H+ or KMnO4/H+
      if ((moles.Cr2O7_2_aq || 0) > 1e-7 && (moles.H_aq || 0) > 1e-5 && T >= 323.15) {
        if (T >= 348.15) {
          const dMeCrF = Math.min(moles.CH3OH_l / 3, moles.Cr2O7_2_aq / 2, moles.H_aq / 16) * (1 - Math.exp(-0.92 * dt));
          if (dMeCrF > 1e-11) {
            consumeSpecies('CH3OH_l', 3 * dMeCrF); consumeSpecies('Cr2O7_2_aq', 2 * dMeCrF); consumeSpecies('H_aq', 16 * dMeCrF);
            moles.HCOOH_l = (moles.HCOOH_l || 0) + 3 * dMeCrF; moles.Cr3_aq = (moles.Cr3_aq || 0) + 4 * dMeCrF; moles.H2O_l = (moles.H2O_l || 0) + 11 * dMeCrF;
            heatJ += dMeCrF * 650000;
            pushRxn('meoh_cr2o7_hcooh', '3CH₃OH + 2Cr₂O₇²⁻ + 16H⁺ —(75–90 °C)→ 3HCOOH + 4Cr³⁺ + 11H₂O', 'Oxi hóa mạnh Methanol (K₂Cr₂O₇/H⁺) → Formic acid HCOOH', 'Strong oxidation of Methanol (Cr₂O₇²⁻/H⁺) → Formic acid', 'Oxi hóa Methanol ở nhiệt độ cao bằng K₂Cr₂O₇/H₂SO₄ điều chế Formic acid.', 'Vigorous dichromate oxidation converts Methanol directly to Formic acid.', dMeCrF);
          }
        } else {
          const dMeCrH = Math.min(moles.CH3OH_l / 3, moles.Cr2O7_2_aq, moles.H_aq / 8) * (1 - Math.exp(-1.15 * dt));
          if (dMeCrH > 1e-11) {
            consumeSpecies('CH3OH_l', 3 * dMeCrH); consumeSpecies('Cr2O7_2_aq', dMeCrH); consumeSpecies('H_aq', 8 * dMeCrH);
            moles.HCHO_aq = (moles.HCHO_aq || 0) + 3 * dMeCrH; moles.Cr3_aq = (moles.Cr3_aq || 0) + 2 * dMeCrH; moles.H2O_l = (moles.H2O_l || 0) + 7 * dMeCrH;
            heatJ += dMeCrH * 380000;
            pushRxn('meoh_cr2o7_hcho', '3CH₃OH + Cr₂O₇²⁻ + 8H⁺ —(50–60 °C)→ 3HCHO + 2Cr³⁺ + 7H₂O', 'Oxi hóa nhẹ Methanol (K₂Cr₂O₇/H⁺) → Formaldehyde HCHO', 'Mild oxidation of Methanol (Cr₂O₇²⁻/H⁺) → Formaldehyde', 'Oxi hóa nhẹ Methanol ở 50–60 °C tạo Formaldehyde HCHO.', 'Controlled dichromate oxidation of Methanol at 50–60 °C yields Formaldehyde.', dMeCrH);
          }
        }
      } else if ((moles.MnO4_aq || 0) > 1e-7 && (moles.H_aq || 0) > 1e-5 && T >= 323.15) {
        const dMeMn = Math.min(moles.CH3OH_l / 5, moles.MnO4_aq / 4, moles.H_aq / 12) * (1 - Math.exp(-1.2 * dt));
        if (dMeMn > 1e-11) {
          consumeSpecies('CH3OH_l', 5 * dMeMn); consumeSpecies('MnO4_aq', 4 * dMeMn); consumeSpecies('H_aq', 12 * dMeMn);
          moles.HCOOH_l = (moles.HCOOH_l || 0) + 5 * dMeMn; moles.Mn2_aq = (moles.Mn2_aq || 0) + 4 * dMeMn; moles.H2O_l = (moles.H2O_l || 0) + 11 * dMeMn;
          heatJ += dMeMn * 920000;
          pushRxn('meoh_kmno4_hcooh', '5CH₃OH + 4MnO₄⁻ + 12H⁺ —(t°)→ 5HCOOH + 4Mn²⁺ + 11H₂O', 'Oxi hóa Methanol bằng KMnO₄/H⁺ → Formic acid HCOOH', 'Methanol + KMnO₄/H⁺ → Formic acid', 'KMnO₄ trong môi trường acid oxi hóa Methanol thành Formic acid.', 'Acidic permanganate oxidizes Methanol to Formic acid.', dMeMn);
        }
      }
      // Methanol -> CH3Cl (HCl + ZnCl2, t°), CH3Br (P_red + Br2), Methylamine CH3NH2 (NH3 + Al2O3, 350–400 °C)
      if ((moles.H_aq || 0) > 1e-4 && (moles.Cl_aq || 0) > 1e-4 && ((moles.ZnCl2_s || 0) > 1e-7 || (moles.Zn2_aq || 0) > 1e-7) && T >= 338.15) {
        const dMeCl = Math.min(moles.CH3OH_l, moles.H_aq, moles.Cl_aq) * (1 - Math.exp(-2.2 * dt));
        if (dMeCl > 1e-11) {
          consumeSpecies('CH3OH_l', dMeCl); consumeSpecies('H_aq', dMeCl); consumeSpecies('Cl_aq', dMeCl);
          gasProduced.CH3Cl_g = (gasProduced.CH3Cl_g || 0) + dMeCl; moles.H2O_l = (moles.H2O_l || 0) + dMeCl;
          heatJ += dMeCl * 26000;
          pushRxn('prep_ch3cl_zncl2', 'CH₃OH + HCl(đặc) —(ZnCl₂, t°)→ CH₃Cl↑ + H₂O', 'Điều chế Chloromethane từ Methanol + HCl (ZnCl₂)', 'Preparation of Chloromethane: MeOH + HCl (ZnCl₂)', 'ZnCl₂ xúc tác thế –OH bằng Cl⁻ tạo khí Chloromethane phục vụ alkyl hóa Friedel–Crafts.', 'ZnCl₂ catalyzes substitution of Methanol to Chloromethane gas.', dMeCl, true);
        }
      }
      const brMe = (moles.Br2_l || 0) > 1e-9 ? 'Br2_l' : (moles.Br2_aq || 0) > 1e-9 ? 'Br2_aq' : null;
      if (brMe && (moles.P_red_s || 0) > 1e-8 && T >= 313.15) {
        const dMeBr = Math.min(moles.CH3OH_l / 3, moles.P_red_s, moles[brMe] / 1.5) * (1 - Math.exp(-0.85 * dt));
        if (dMeBr > 1e-11) {
          consumeSpecies('CH3OH_l', 3 * dMeBr); consumeSpecies('P_red_s', dMeBr); consumeSpecies(brMe, 1.5 * dMeBr);
          gasProduced.CH3Br_g = (gasProduced.CH3Br_g || 0) + 3 * dMeBr; moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dMeBr;
          heatJ += dMeBr * 175000;
          pushRxn('prep_ch3br_p_br2', '3CH₃OH + P(đỏ) + 1.5Br₂ —(t°)→ 3CH₃Br↑ + H₃PO₃', 'Điều chế Bromomethane từ Methanol + P(đỏ) + Br₂', 'Preparation of Bromomethane: MeOH + P(red) + Br₂', 'P đỏ và Br₂ thế nhóm –OH của Methanol giải phóng khí Bromomethane.', 'Red P and Br₂ convert Methanol into Bromomethane gas.', 3 * dMeBr, true);
        }
      }
      const nNh3Me = getG('NH3_g') + (moles.NH3_aq || 0);
      if (nNh3Me > 1e-8 && (moles.Al2O3_s || 0) > 1e-8 && T >= 623.15) {
        const dMeAm = Math.min(moles.CH3OH_l, nNh3Me) * (1 - Math.exp(-0.65 * dt));
        if (dMeAm > 1e-11) {
          consumeSpecies('CH3OH_l', dMeAm);
          const mAq = Math.min(moles.NH3_aq || 0, dMeAm);
          if (mAq > 0) consumeSpecies('NH3_aq', mAq);
          if (dMeAm - mAq > 1e-13) takeG('NH3_g', dMeAm - mAq);
          gasProduced.CH3NH2_g = (gasProduced.CH3NH2_g || 0) + dMeAm;
          moles.H2O_l = (moles.H2O_l || 0) + dMeAm;
          heatJ += dMeAm * 21000;
          pushRxn('meoh_nh3_al2o3', 'CH₃OH + NH₃ —(Al₂O₃, 350–400 °C)→ CH₃NH₂↑ + H₂O', 'Điều chế Methylamine từ Methanol + NH₃ (xúc tác Al₂O₃)', 'Synthesis of Methylamine: MeOH + NH₃ (Al₂O₃, 350–400 °C)', 'Hơi Methanol phản ứng với NH₃ trên Al₂O₃ nung nóng điều chế khí Methylamine.', 'Al₂O₃ catalyzes amination of Methanol to Methylamine gas.', dMeAm, true);
        }
      }
    }
    // Ammonolysis CH3Cl + NH3 -> CH3NH3+ + Cl-
    if (getG('CH3Cl_g') > 1e-9 && (getG('NH3_g') > 1e-8 || (moles.NH3_aq || 0) > 1e-8) && T >= 313.15) {
      const nNh3Am = getG('NH3_g') + (moles.NH3_aq || 0);
      const dAmCl = Math.min(getG('CH3Cl_g'), nNh3Am) * (1 - Math.exp(-0.72 * dt));
      if (dAmCl > 1e-11) {
        takeG('CH3Cl_g', dAmCl);
        const mAq = Math.min(moles.NH3_aq || 0, dAmCl);
        if (mAq > 0) consumeSpecies('NH3_aq', mAq);
        if (dAmCl - mAq > 1e-13) takeG('NH3_g', dAmCl - mAq);
        moles.CH3NH3_aq = (moles.CH3NH3_aq || 0) + dAmCl;
        moles.Cl_aq = (moles.Cl_aq || 0) + dAmCl;
        heatJ += dAmCl * 52000;
        pushRxn('ch3cl_nh3_ammonolysis', 'CH₃Cl + NH₃ → CH₃NH₃⁺Cl⁻', 'Ammonolysis CH₃Cl với NH₃ tạo muối Methylammonium', 'Ammonolysis of CH₃Cl with NH₃ → Methylammonium chloride', 'CH₃Cl phản ứng với NH₃ tạo muối Methylammonium; kiềm hóa giải phóng CH₃NH₂↑.', 'Ammonolysis yields Methylammonium salt (NaOH releases Methylamine).', dAmCl);
      }
    }

    // 7B. Formic acid (HCOOH_l) & Formate Esters (HCOOCH3_l, HCOOC2H5_l): Acidic + Dehydration CO↑ + Tollens + Cu(OH)2 + Br2
    if ((moles.HCOOH_l || 0) > 1e-9) {
      // Dehydration by conc H2SO4 (no excess water): HCOOH -(conc H2SO4, >= 333 K)-> CO↑ + H2O
      if ((moles.H2SO4_l || 0) > 1e-6 && (moles.H2O_l || 0) < 0.08 && T >= 333.15) {
        const dDehF = Math.min(moles.HCOOH_l, moles.H2SO4_l) * (1 - Math.exp(-1.4 * dt));
        if (dDehF > 1e-11) {
          consumeSpecies('HCOOH_l', dDehF);
          gasProduced.CO_g = (gasProduced.CO_g || 0) + dDehF; moles.H2O_l = (moles.H2O_l || 0) + dDehF; heatJ += dDehF * 28000;
          pushRxn('hcooh_h2so4_co', 'HCOOH —(H₂SO₄ đặc, 60–90 °C)→ CO(g)↑ + H₂O', 'Tách nước Formic acid bằng H₂SO₄ đặc điều chế khí CO↑', 'Formic acid dehydration (conc. H₂SO₄) → CO(g)↑', 'H₂SO₄ đặc hút nước phân hủy Formic acid tạo khí CO tinh khiết.', 'Conc. H₂SO₄ dehydrates Formic acid to pure CO gas.', dDehF, true);
        }
      }
      if ((moles.AgNH3_2_aq || 0) > 1e-7 && (moles.OH_aq || 0) > 1e-7 && T >= 313.15) {
        const dFTol = Math.min(moles.HCOOH_l, moles.AgNH3_2_aq / 2, moles.OH_aq / 2) * (1 - Math.exp(-1.25 * dt));
        if (dFTol > 1e-11) {
          consumeSpecies('HCOOH_l', dFTol); consumeSpecies('AgNH3_2_aq', 2 * dFTol); consumeSpecies('OH_aq', 2 * dFTol);
          moles.CO3_2_aq = (moles.CO3_2_aq || 0) + dFTol; moles.NH4_aq = (moles.NH4_aq || 0) + 2 * dFTol;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dFTol; moles.NH3_aq = (moles.NH3_aq || 0) + 2 * dFTol; moles.H2O_l = (moles.H2O_l || 0) + 2 * dFTol;
          pushRxn('hcooh_tollens', 'HCOOH + 2[Ag(NH₃)₂]⁺ + 2OH⁻ → (NH₄)₂CO₃ + 2Ag↓ + 2NH₃ + 2H₂O', 'Tráng bạc Formic acid → 2Ag↓', 'Formic acid Tollens silver mirror → 2Ag↓', 'Nhóm –CHO trong Formic acid tham gia phản ứng tráng gương tạo 2Ag↓.', 'Formic acid reduces Tollens reagent to a silver mirror (2Ag↓).', dFTol);
        }
      } else if ((moles.CuOH2_s || 0) > 1e-8 && (moles.OH_aq || 0) > 1e-6 && T >= 333.15) {
        const dFCu = Math.min(moles.HCOOH_l, moles.CuOH2_s / 2, moles.OH_aq / 2) * (1 - Math.exp(-1.1 * dt));
        if (dFCu > 1e-11) {
          consumeSpecies('HCOOH_l', dFCu); consumeSpecies('CuOH2_s', 2 * dFCu); consumeSpecies('OH_aq', 2 * dFCu);
          moles.Cu2O_s = (moles.Cu2O_s || 0) + dFCu; moles.CO3_2_aq = (moles.CO3_2_aq || 0) + dFCu; moles.H2O_l = (moles.H2O_l || 0) + 3 * dFCu;
          pushRxn('hcooh_cuoh2_hot', 'HCOOH + 2Cu(OH)₂ + 2OH⁻ —(t°)→ Cu₂O↓ (đỏ gạch) + CO₃²⁻ + 3H₂O', 'Formic acid khử Cu(OH)₂ đun nóng → Cu₂O đỏ gạch', 'Formic acid + hot Cu(OH)₂/OH⁻ → red Cu₂O↓', 'Formic acid khử Cu(OH)₂ khi đun nóng tạo kết tủa đỏ gạch Cu₂O↓.', 'Hot Cu(OH)₂ oxidizes Formic acid forming brick-red Cu₂O precipitate.', dFCu);
        }
      } else if ((moles.OH_aq || 0) > 1e-6) {
        const dNF = Math.min(moles.HCOOH_l, moles.OH_aq) * (1 - Math.exp(-3.4 * dt));
        if (dNF > 1e-11) {
          consumeSpecies('HCOOH_l', dNF); consumeSpecies('OH_aq', dNF);
          moles.HCOO_aq = (moles.HCOO_aq || 0) + dNF; moles.H2O_l = (moles.H2O_l || 0) + dNF; heatJ += dNF * 56000;
          pushRxn('hcooh_oh', 'HCOOH + OH⁻ → HCOO⁻ + H₂O', 'Trung hòa Formic acid bằng kiềm', 'Formic acid + OH⁻ → Formate + H₂O', 'Formic acid trung hòa nhanh dung dịch kiềm.', 'Formic acid neutralizes alkali to Formate.', dNF);
        }
      } else if ((moles.CaCO3_s || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-4) {
        const dCF = Math.min(moles.HCOOH_l / 2, moles.CaCO3_s) * (1 - Math.exp(-1.8 * dt));
        if (dCF > 1e-11) {
          consumeSpecies('HCOOH_l', 2 * dCF); consumeSpecies('CaCO3_s', dCF);
          moles.HCOO_aq = (moles.HCOO_aq || 0) + 2 * dCF; moles.Ca2_aq = (moles.Ca2_aq || 0) + dCF;
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dCF; moles.H2O_l = (moles.H2O_l || 0) + dCF;
          pushRxn('hcooh_caco3', '2HCOOH + CaCO₃ → Ca(HCOO)₂ + CO₂↑ + H₂O', 'Formic acid + CaCO₃ → CO₂↑', 'Formic acid + CaCO₃ → CO₂↑', 'Formic acid (pKa 3.75) giải phóng mạnh khí CO₂ từ CaCO₃.', 'Formic acid evolves CO₂ gas briskly from CaCO₃.', dCF, true);
        }
      }
      if ((moles.C2H5OH_l || 0) > 1e-9 && ((moles.H2SO4_l || 0) > 1e-6 || (moles.HSO4_aq || 0) > 1e-4) && T >= 323.15) {
        const dEstEF = Math.min(moles.HCOOH_l, moles.C2H5OH_l) * (1 - Math.exp(-0.88 * dt));
        if (dEstEF > 1e-11) {
          consumeSpecies('HCOOH_l', dEstEF); consumeSpecies('C2H5OH_l', dEstEF);
          moles.HCOOC2H5_l = (moles.HCOOC2H5_l || 0) + dEstEF; moles.H2O_l = (moles.H2O_l || 0) + dEstEF;
          pushRxn('ester_ethyl_formate', 'HCOOH + C₂H₅OH ⇌ HCOOC₂H₅ + H₂O', 'Ester hóa HCOOH + C₂H₅OH → Ethyl formate', 'Esterification: Formic acid + Ethanol → Ethyl formate', 'Tạo ester Ethyl formate có mùi thơm nhẹ.', 'Esterification yields Ethyl formate.', dEstEF);
        }
      }
      const brFm = (moles.Br2_aq || 0) > 1e-8 ? 'Br2_aq' : (moles.Br2_l || 0) > 1e-8 ? 'Br2_l' : null;
      if (brFm) {
        const dFBr = Math.min(moles.HCOOH_l, moles[brFm]) * (1 - Math.exp(-1.2 * dt));
        if (dFBr > 1e-11) {
          consumeSpecies('HCOOH_l', dFBr); consumeSpecies(brFm, dFBr);
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dFBr; moles.H_aq = (moles.H_aq || 0) + 2 * dFBr; moles.Br_aq = (moles.Br_aq || 0) + 2 * dFBr;
          pushRxn('hcooh_br2', 'HCOOH + Br₂ → CO₂↑ + 2HBr', 'Formic acid làm mất màu nước Bromine', 'Formic acid + Br₂ → CO₂↑ + 2HBr', 'Formic acid khử được nước Bromine tạo CO₂↑ và HBr.', 'Formic acid decolorizes Bromine water liberating CO₂.', dFBr, true);
        }
      }
    }

    // Formate esters (HCOOCH3 / HCOOC2H5): Tollens (saponification handled by unified Arrhenius + RK2 kinetics in Part 7E)
    for (const fe of [{ id: 'HCOOCH3_l', alc: 'CH3OH_l', label: 'HCOOCH₃' }, { id: 'HCOOC2H5_l', alc: 'C2H5OH_l', label: 'HCOOC₂H₅' }]) {
      const nFe = moles[fe.id] || 0;
      if (nFe <= 1e-10) continue;
      if ((moles.AgNH3_2_aq || 0) > 1e-7 && (moles.OH_aq || 0) > 1e-7 && T >= 313.15) {
        const dFeT = Math.min(nFe, moles.AgNH3_2_aq / 2, moles.OH_aq / 2) * (1 - Math.exp(-0.85 * dt));
        if (dFeT > 1e-11) {
          consumeSpecies(fe.id, dFeT); consumeSpecies('AgNH3_2_aq', 2 * dFeT); consumeSpecies('OH_aq', 2 * dFeT);
          moles.CO3_2_aq = (moles.CO3_2_aq || 0) + dFeT; moles[fe.alc] = (moles[fe.alc] || 0) + dFeT;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dFeT; moles.NH4_aq = (moles.NH4_aq || 0) + 2 * dFeT; moles.NH3_aq = (moles.NH3_aq || 0) + 2 * dFeT;
          pushRxn(`tollens_${fe.id}`, `${fe.label} + 2[Ag(NH₃)₂]⁺ + 2OH⁻ → 2Ag↓ + ${fe.alc === 'CH3OH_l' ? 'CH₃OH' : 'C₂H₅OH'}`, `Ester formate ${fe.label} tráng bạc tạo 2Ag↓`, `${fe.label} undergoes Tollens silver mirror reaction`, 'Ester của Formic acid có nhóm H–COO– nên tham gia phản ứng tráng gương.', 'Formate esters preserve the –CHO motif and yield a silver mirror.', dFeT);
        }
      }
    }

    // 7C. Polyols (Ethylene glycol C2H4OH_2_l & Glycerol C3H5OH_3_l): Cu(OH)2 deep blue complex, Na, HNO3/H2SO4 -> Nitroglycerin
    for (const pol of [{ id: 'C3H5OH_3_l', name: 'Glycerol', formula: 'C₃H₅(OH)₃', h2Stoich: 1.5 }, { id: 'C2H4OH_2_l', name: 'Ethylene glycol', formula: 'C₂H₄(OH)₂', h2Stoich: 1.0 }]) {
      const nPol = moles[pol.id] || 0;
      if (nPol <= 1e-10) continue;
      if ((moles.CuOH2_s || 0) > 1e-9 && ((moles.OH_aq || 0) < 1e-5 || T <= 355.15)) {
        const dCuPol = Math.min(nPol / 2, moles.CuOH2_s) * (1 - Math.exp(-2.2 * dt));
        if (dCuPol > 1e-11) {
          consumeSpecies(pol.id, 2 * dCuPol); consumeSpecies('CuOH2_s', dCuPol);
          moles.CuC2H4O2_aq = (moles.CuC2H4O2_aq || 0) + dCuPol; moles.H2O_l = (moles.H2O_l || 0) + 2 * dCuPol;
          heatJ += dCuPol * 22000;
          pushRxn(`polyol_cuoh2_${pol.id}`, `2${pol.formula} + Cu(OH)₂ → [Cu(Polyol)₂]²⁻ (xanh lam thẫm) + 2H₂O`, `${pol.name} hòa tan Cu(OH)₂ tạo phức xanh lam thẫm`, `${pol.name} dissolves Cu(OH)₂ → deep azure complex`, 'Phản ứng đặc trưng nhận biết polyalcohol có nhóm –OH kề nhau hòa tan Cu(OH)₂ thành dung dịch xanh lam thẫm.', 'Vicinal –OH groups in polyalcohols dissolve blue Cu(OH)₂ into a deep royal-blue complex.', dCuPol);
        }
      }
      if ((moles.Na_s || 0) > 1e-9 && (moles.H2O_l || 0) < 0.02) {
        const dPolNa = Math.min(nPol, moles.Na_s / (2 * pol.h2Stoich)) * (1 - Math.exp(-2.6 * dt));
        if (dPolNa > 1e-11) {
          consumeSpecies(pol.id, dPolNa); consumeSpecies('Na_s', 2 * pol.h2Stoich * dPolNa);
          moles.Na_aq = (moles.Na_aq || 0) + 2 * pol.h2Stoich * dPolNa; moles.C2H5O_aq = (moles.C2H5O_aq || 0) + dPolNa;
          gasProduced.H2_g = (gasProduced.H2_g || 0) + pol.h2Stoich * dPolNa; heatJ += dPolNa * 260000;
          pushRxn(`polyol_na_${pol.id}`, `${pol.formula} + ${2 * pol.h2Stoich}Na → Muối alkoxide + ${pol.h2Stoich}H₂↑`, `${pol.name} tác dụng với Na giải phóng H₂↑`, `${pol.name} + Na → H₂↑`, 'Na khử các nguyên tử H nhóm –OH của polyalcohol giải phóng khí H₂.', 'Sodium displaces H from all –OH groups evolving H₂.', dPolNa, true);
        }
      }
      if (pol.id === 'C3H5OH_3_l' && (moles.H2SO4_l || 0) > 1e-6 && ((moles.HNO3_l || 0) > 1e-7 || ((moles.NO3_aq || 0) > 1e-5 && (moles.H_aq || 0) > 1e-5)) && T <= 303.15) {
        const nNitG = (moles.HNO3_l || 0) > 1e-7 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
        const dNg = Math.min(nPol, nNitG / 3) * (1 - Math.exp(-0.95 * dt));
        if (dNg > 1e-11) {
          consumeSpecies('C3H5OH_3_l', dNg);
          if ((moles.HNO3_l || 0) >= 3 * dNg) consumeSpecies('HNO3_l', 3 * dNg);
          else { consumeSpecies('NO3_aq', 3 * dNg); consumeSpecies('H_aq', 3 * dNg); }
          moles.C3H5_ONO2_3_l = (moles.C3H5_ONO2_3_l || 0) + dNg; moles.H2O_l = (moles.H2O_l || 0) + 3 * dNg; heatJ += dNg * 145000;
          pushRxn('glycerol_nitroglycerin', 'C₃H₅(OH)₃ + 3HNO₃ —(H₂SO₄ đặc, < 25 °C)→ C₃H₅(ONO₂)₃ + 3H₂O', 'Ester hóa Glycerol + HNO₃(đặc)/H₂SO₄ → Nitroglycerin', 'Glycerol nitration → Nitroglycerin + 3H₂O', 'Tạo lớp dầu nặng màu vàng nhạt Nitroglycerin (d = 1.60 g/cm³).', 'Esterification with mixed HNO₃/H₂SO₄ yields dense Nitroglycerin oil.', dNg);
        }
      }
      if (pol.id === 'C3H5OH_3_l' && ((moles.H2SO4_l || 0) > 1e-6 || (moles.KHSO4_s || 0) > 1e-6) && T >= 453.15) {
        const dDehG = nPol * (1 - Math.exp(-0.85 * dt));
        if (dDehG > 1e-11) {
          consumeSpecies('C3H5OH_3_l', dDehG);
          moles.CH2CHCHO_l = (moles.CH2CHCHO_l || 0) + dDehG; gasProduced.H2O_g = (gasProduced.H2O_g || 0) + 2 * dDehG;
          pushRxn('glycerol_acrolein', 'C₃H₅(OH)₃ —(H₂SO₄/KHSO₄, 180–200 °C)→ CH₂=CHCHO + 2H₂O↑', 'Tách nước Glycerol → Acrolein', 'Glycerol dehydration → Acrolein', 'Đun Glycerol với chất hút nước ở 180–200 °C thu được Acrolein mùi hăng cay.', 'Dehydration of Glycerol at 180–200 °C produces Acrolein.', dDehG, true);
        }
      }
    }

    // 7D. Formaldehyde (HCHO_aq / HCHO_g) & Aldehyde Br2/H2 reactions
    const nHcho = (moles.HCHO_aq || 0) + getG('HCHO_g');
    if (nHcho > 1e-9) {
      const takeHcho = (amt) => {
        const fromAq = Math.min(moles.HCHO_aq || 0, amt);
        if (fromAq > 0) consumeSpecies('HCHO_aq', fromAq);
        if (amt - fromAq > 1e-13) takeG('HCHO_g', amt - fromAq);
      };
      // 1:4 Silver Mirror Test!
      if ((moles.AgNH3_2_aq || 0) > 1e-7 && (moles.OH_aq || 0) > 1e-7 && T >= 313.15) {
        const dHchoAg = Math.min(nHcho, moles.AgNH3_2_aq / 4, moles.OH_aq / 4) * (1 - Math.exp(-1.15 * dt));
        if (dHchoAg > 1e-11) {
          takeHcho(dHchoAg); consumeSpecies('AgNH3_2_aq', 4 * dHchoAg); consumeSpecies('OH_aq', 4 * dHchoAg);
          moles.CO3_2_aq = (moles.CO3_2_aq || 0) + dHchoAg; moles.NH4_aq = (moles.NH4_aq || 0) + 2 * dHchoAg;
          moles.NH3_aq = (moles.NH3_aq || 0) + 6 * dHchoAg; moles.Ag_s = (moles.Ag_s || 0) + 4 * dHchoAg; moles.H2O_l = (moles.H2O_l || 0) + 3 * dHchoAg;
          heatJ += dHchoAg * 210000;
          pushRxn('hcho_tollens_4ag', 'HCHO + 4[Ag(NH₃)₂]OH → (NH₄)₂CO₃ + 4Ag↓ + 6NH₃ + 2H₂O', 'Tráng gương Formaldehyde tỉ lệ 1 : 4 tạo 4Ag↓', 'Formaldehyde Tollens (1:4 ratio) → 4Ag↓', 'Formaldehyde là aldehyde duy nhất cho phản ứng tráng bạc tỉ lệ mol 1 : 4.', 'Formaldehyde uniquely undergoes 4-electron Tollens oxidation yielding 4 Ag per HCHO.', dHchoAg);
        }
      }
      // Cannizzaro in strong alkali: 2HCHO + OH- -> HCOO- + CH3OH
      const cOHCann = (moles.OH_aq || 0) / Math.max(0.005, liquidVolL);
      if (cOHCann >= 1.2 && (moles.H2O_l || 0) > 1e-4 && (moles.CuOH2_s || 0) < 1e-7 && (moles.AgNH3_2_aq || 0) < 1e-7) {
        const dCan = Math.min(nHcho / 2, moles.OH_aq) * (1 - Math.exp(-0.85 * dt));
        if (dCan > 1e-11) {
          takeHcho(2 * dCan); consumeSpecies('OH_aq', dCan);
          moles.HCOO_aq = (moles.HCOO_aq || 0) + dCan; moles.CH3OH_l = (moles.CH3OH_l || 0) + dCan; heatJ += dCan * 48000;
          pushRxn('hcho_cannizzaro', '2HCHO + OH⁻(đặc) → HCOO⁻ + CH₃OH', 'Phản ứng Cannizzaro tự oxi hóa khử Formaldehyde', 'Cannizzaro disproportionation: 2HCHO + OH⁻ → HCOO⁻ + CH₃OH', 'Trong kiềm đặc, Formaldehyde tự oxi hóa khử thành Formate và Methanol.', 'Concentrated alkali triggers Cannizzaro disproportionation of HCHO.', dCan);
        }
      }
      // Phenol-Formaldehyde Novolac Resin (80-100 C, H+ or OH-)
      const phResSrc = (moles.C6H5OH_l || 0) > 1e-9 ? 'C6H5OH_l' : (moles.C6H5OH_s || 0) > 1e-9 ? 'C6H5OH_s' : null;
      if (phResSrc && T >= 353.15 && ((moles.H_aq || 0) > 1e-5 || (moles.OH_aq || 0) > 1e-5)) {
        const dNov = Math.min(nHcho, moles[phResSrc]) * (1 - Math.exp(-0.78 * dt));
        if (dNov > 1e-11) {
          takeHcho(dNov); consumeSpecies(phResSrc, dNov);
          moles.Novolac_s = (moles.Novolac_s || 0) + dNov; moles.H2O_l = (moles.H2O_l || 0) + dNov;
          pushRxn('phenol_formaldehyde_resin', 'nC₆H₅OH + nHCHO —(H⁺/OH⁻, 90 °C)→ Nhựa Novolac + nH₂O', 'Trùng ngưng Phenol + Formaldehyde → nhựa Novolac', 'Phenol-formaldehyde polycondensation → Novolac resin', 'Trùng ngưng Phenol và Formaldehyde tạo nhựa nhiệt rắn màu hổ phách.', 'Acid/base-catalyzed condensation forms amber Phenol-formaldehyde resin.', dNov);
        }
      }
      // HCHO + Br2(aq) + H2O -> CO2/HCOOH + 2HBr; HCHO + H2 -(Ni, 120 C)-> CH3OH
      const brAld0 = (moles.Br2_aq || 0) > 1e-8 ? 'Br2_aq' : (moles.Br2_l || 0) > 1e-8 ? 'Br2_l' : null;
      if (brAld0 && (moles.H2O_l || 0) > 1e-4) {
        const dHBr = Math.min(nHcho, moles[brAld0], moles.H2O_l) * (1 - Math.exp(-1.4 * dt));
        if (dHBr > 1e-11) {
          takeHcho(dHBr); consumeSpecies(brAld0, dHBr); consumeSpecies('H2O_l', dHBr);
          moles.HCOOH_l = (moles.HCOOH_l || 0) + dHBr; moles.H_aq = (moles.H_aq || 0) + 2 * dHBr; moles.Br_aq = (moles.Br_aq || 0) + 2 * dHBr;
          pushRxn('hcho_br2', 'HCHO + Br₂ + H₂O → HCOOH + 2HBr', 'Formaldehyde làm mất màu nước Bromine', 'Formaldehyde + Br₂ + H₂O → Formic acid + 2HBr', 'Nước Bromine oxi hóa HCHO thành Formic acid.', 'Bromine water oxidizes HCHO to Formic acid.', dHBr);
        }
      }
      if (((moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8) && getG('H2_g') > 1e-8 && T >= 373.15) {
        const dMeHyd = Math.min(nHcho, getG('H2_g')) * (1 - Math.exp(-0.92 * dt));
        if (dMeHyd > 1e-11) {
          takeHcho(dMeHyd); takeG('H2_g', dMeHyd); moles.CH3OH_l = (moles.CH3OH_l || 0) + dMeHyd;
          pushRxn('hcho_h2_meoh', 'HCHO + H₂ —(Ni, t°)→ CH₃OH', 'Khử HCHO bằng H₂/Ni → Methanol', 'Hydrogenation of Formaldehyde → Methanol', 'Cộng H₂ vào nhóm C=O tạo Methanol.', 'Hydrogenation of Formaldehyde yields Methanol.', dMeHyd);
        }
      }
    }
    if ((moles.CH3CHO_l || 0) > 1e-9) {
      const brAld1 = (moles.Br2_aq || 0) > 1e-8 ? 'Br2_aq' : (moles.Br2_l || 0) > 1e-8 ? 'Br2_l' : null;
      if (brAld1 && (moles.H2O_l || 0) > 1e-4) {
        const dAcBr = Math.min(moles.CH3CHO_l, moles[brAld1], moles.H2O_l) * (1 - Math.exp(-1.2 * dt));
        if (dAcBr > 1e-11) {
          consumeSpecies('CH3CHO_l', dAcBr); consumeSpecies(brAld1, dAcBr); consumeSpecies('H2O_l', dAcBr);
          moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dAcBr; moles.H_aq = (moles.H_aq || 0) + 2 * dAcBr; moles.Br_aq = (moles.Br_aq || 0) + 2 * dAcBr;
          pushRxn('ch3cho_br2', 'CH₃CHO + Br₂ + H₂O → CH₃COOH + 2HBr', 'Acetaldehyde làm mất màu nước Bromine', 'Acetaldehyde + Br₂ + H₂O → Acetic acid + 2HBr', 'Aldehyde làm mất màu nước Bromine chuyển thành acid tương ứng.', 'Bromine water oxidizes Acetaldehyde to Acetic acid.', dAcBr);
        }
      }
      if (((moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8) && getG('H2_g') > 1e-8 && T >= 373.15) {
        const dEtHyd = Math.min(moles.CH3CHO_l, getG('H2_g')) * (1 - Math.exp(-0.92 * dt));
        if (dEtHyd > 1e-11) {
          consumeSpecies('CH3CHO_l', dEtHyd); takeG('H2_g', dEtHyd); moles.C2H5OH_l = (moles.C2H5OH_l || 0) + dEtHyd;
          pushRxn('ch3cho_h2_etoh', 'CH₃CHO + H₂ —(Ni, t°)→ C₂H₅OH', 'Hydro hóa Acetaldehyde → Ethanol', 'Acetaldehyde hydrogenation → Ethanol', 'Cộng H₂ trên xúc tác Ni khử Acetaldehyde thành Ethanol.', 'Catalytic hydrogenation reduces Acetaldehyde to Ethanol.', dEtHyd);
        }
      }
    }

    // 7E. Unified Arrhenius + RK2 Midpoint Ester & Lipid Hydrolysis / Saponification Kinetics
    {
      const R_GAS = CONSTANTS.R_J_MOL_K || 8.314;
      const isStirred = (vessel.stirTimer || 0) > 0.05;
      const hasEtOHCosolvent = (moles.C2H5OH_l || 0) >= 0.005 || (moles.CH3OH_l || 0) >= 0.005;
      const totVolL = Math.max(0.008, (options?.strat?.totalLiqMl || liquidVolL * 1000 || 20) / 1000);
      const cH = (moles.H_aq || 0) / totVolL;

      const resolveAcylChains = (sp) => {
        if (Array.isArray(sp.acylChains) && sp.acylChains.length > 0) {
          return sp.acylChains.map((c) => ({
            acidId: c.acidId,
            soapIonId: c.soapIonId,
            soapNaId: c.soapNaId ?? null,
            count: Math.max(1, c.count || 1),
          }));
        }
        return [
          {
            acidId: sp.acidId,
            soapIonId: sp.soapIonId,
            soapNaId: sp.soapNaId ?? null,
            count: sp.esterBonds || 3,
          },
        ];
      };

      const SIMPLE_ESTERS = [
        { id: 'HCOOCH3_l', acidId: 'HCOOH_l', saltId: 'HCOO_aq', alcId: 'CH3OH_l', stoich: 1, aAlk: 1.25e8, eaAlk: 41800, aAcid: 4.80e8, eaAcid: 62500, kc: 0.28, isFat: false, dHAlkJ: 46000, dHAcidJ: 3200, rxnIdAlk: 'sap_HCOOCH3_l', eqAlk: 'HCOOCH₃ + OH⁻ → HCOO⁻ + CH₃OH', nameViAlk: 'Xà phòng hóa Methyl formate', nameEnAlk: 'Alkaline hydrolysis of Methyl formate' },
        { id: 'HCOOC2H5_l', acidId: 'HCOOH_l', saltId: 'HCOO_aq', alcId: 'C2H5OH_l', stoich: 1, aAlk: 6.50e7, eaAlk: 43500, aAcid: 2.20e8, eaAcid: 64000, kc: 0.26, isFat: false, dHAlkJ: 46000, dHAcidJ: 3400, rxnIdAlk: 'sap_HCOOC2H5_l', eqAlk: 'HCOOC₂H₅ + OH⁻ → HCOO⁻ + C₂H₅OH', nameViAlk: 'Xà phòng hóa Ethyl formate', nameEnAlk: 'Alkaline hydrolysis of Ethyl formate' },
        { id: 'CH3COOC2H5_l', acidId: 'CH3COOH_l', saltId: 'CH3COO_aq', alcId: 'C2H5OH_l', stoich: 1, aAlk: 1.58e7, eaAlk: 46500, aAcid: 6.15e7, eaAcid: 67000, kc: 0.25, isFat: false, skipAcid: true, dHAlkJ: 48000, dHAcidJ: 3800, rxnIdAlk: 'etoac_saponification', eqAlk: 'CH₃COOC₂H₅ + OH⁻ → CH₃COO⁻ + C₂H₅OH', nameViAlk: 'Xà phòng hóa Ethyl acetate', nameEnAlk: 'Alkaline saponification of Ethyl acetate' },
        { id: 'C6H5COOC2H5_l', acidId: 'C6H5COOH_s', saltId: 'C6H5COO_aq', alcId: 'C2H5OH_l', stoich: 1, aAlk: 4.10e7, eaAlk: 58200, aAcid: 1.20e8, eaAcid: 72000, kc: 0.24, isFat: false, dHAlkJ: 45000, dHAcidJ: 3500, rxnIdAlk: 'sap_C6H5COOC2H5_l', eqAlk: 'C₆H₅COOC₂H₅ + OH⁻ → C₆H₅COO⁻ + C₂H₅OH', nameViAlk: 'Xà phòng hóa Ethyl benzoate', nameEnAlk: 'Alkaline hydrolysis of Ethyl benzoate' },
      ];
      const DYNAMIC_LIPIDS = [];
      for (const sp of Object.values(SPECIES)) {
        if (!sp?.isFat) continue;
        const chains = resolveAcylChains(sp);
        if (chains.length === 0 || !chains[0].soapIonId) continue;
        const kp = sp.saponificationParams || {};
        const stoich = chains.reduce((s, c) => s + c.count, 0);
        const alcId = sp.alcoholId || 'C3H5OH_3_l';
        const firstChain = chains[0];
        const emulPower = sp.emulsifyPower ?? 1.0;
        const meltTempK = sp.phase === 's' && Number.isFinite(sp.meltTempK) ? sp.meltTempK : null;
        DYNAMIC_LIPIDS.push({
          id: sp.id,
          acidId: chains.length === 1 ? firstChain.acidId : null,
          saltId: firstChain.soapIonId,
          chains,
          alcId,
          stoich,
          aAlk: kp.aAlk ?? 3.20e7,
          eaAlk: kp.eaAlk ?? 54000,
          aAcid: kp.aAcid ?? 1.80e8,
          eaAcid: kp.eaAcid ?? 74500,
          kc: kp.kcAcid ?? 0.22,
          isFat: true,
          emulsifyPower: emulPower,
          meltTempK,
          skipAcid: chains.length > 1 || !firstChain.acidId,
          dHAlkJ: kp.dHAlkJ ?? 135000,
          dHAcidJ: kp.dHAcidJ ?? 11000,
          rxnIdAlk: `sap_${sp.id}`,
          eqAlk: `${sp.formula || sp.id} + ${stoich}OH⁻ → ${SPECIES[alcId]?.formula || 'Glycerol'} + ${chains.map((c) => `${c.count > 1 ? c.count : ''}${SPECIES[c.soapIonId]?.formula || c.soapIonId}`).join(' + ')}`,
          nameViAlk: `Xà phòng hóa ${sp.name || sp.id} → Glycerol + muối carboxylate`,
          nameEnAlk: `Saponification of ${sp.name || sp.id} → Glycerol + carboxylate soap`,
        });
      }
      const ESTER_KINETICS = [...SIMPLE_ESTERS, ...DYNAMIC_LIPIDS];

      if ((moles.CH3COOC2H5_l || 0) > 0.003 || (moles.HCOOC2H5_l || 0) > 0.003 || (moles.HCOOCH3_l || 0) > 0.003) {
        vessel._hadVolatileEsterForAroma = true;
      }

      // Property-driven lipid & soap totals (zero hardcoded IDs)
      const collectLipidSoapStats = () => {
        let nLipid = 0;
        let nLongLipid = 0;
        let nSoapAq = 0;
        let nSoapSolid = 0;
        let nSoapFoamWeighted = 0;
        let mSoapG = 0;
        for (const [id, n] of Object.entries(moles)) {
          if (!n || n <= 1e-12) continue;
          const sp = SPECIES[id];
          if (!sp) continue;
          if (sp.isFat) {
            nLipid += n;
            if ((sp.emulsifyPower ?? 1.0) >= 0.4) nLongLipid += n;
          } else if (sp.isSoapIon) {
            nSoapAq += n;
            mSoapG += n * (sp.molarMass || 304.4);
            nSoapFoamWeighted += n * (sp.foamStrength ?? (sp.soapChainLength != null && sp.soapChainLength < 10 ? 0.08 : 1.0));
          } else if (sp.isSoapSolid) {
            nSoapSolid += n;
            mSoapG += n * (sp.molarMass || 327.4);
          }
        }
        return { nLipid, nLongLipid, nSoapAq, nSoapSolid, nSoapTot: nSoapAq + nSoapSolid, nSoapFoamWeighted, mSoapG };
      };

      const initStats = collectLipidSoapStats();
      const nLipidLeft = initStats.nLipid;
      const nSoapTotNow = initStats.nSoapTot;
      if (initStats.nLongLipid > 1e-5) vessel._soapHadLipid = true;

      // Alkali concentration wt%: too conc NaOH/KOH (>45%) induces instant local soap salting-out passivation on long-chain lipids
      const nBaseMols = Math.min(moles.OH_aq || 0, (moles.Na_aq || 0) + (moles.K_aq || 0) + (moles.OH_aq || 0));
      const baseMM = (moles.K_aq || 0) > (moles.Na_aq || 0) ? 56.1056 : 39.9971;
      const mBaseEqG = nBaseMols * baseMM + (moles.NaOH_s || 0) * 39.9971 + (moles.KOH_s || 0) * 56.1056;
      const mAqH2OG = (moles.H2O_l || 0) * 18.01528;
      const wAlkali = mBaseEqG + mAqH2OG > 1e-4 ? mBaseEqG / (mBaseEqG + mAqH2OG) : 0;
      const concAlkaliBlocked = initStats.nLongLipid > 1e-5 && wAlkali >= 0.45 && (moles.OH_aq || 0) > 1e-4;
      vessel.soapConcPassivated = concAlkaliBlocked;
      if (concAlkaliBlocked) vessel._soapConcAlkaliAlertPending = true;

      // Water depletion scorching when boiling low on open vessel (>= 100 C & moisture drops < 18 wt%)
      const wMoisture = mAqH2OG / Math.max(1e-6, mAqH2OG + mBaseEqG + initStats.mSoapG);
      const dryBoilingScorch =
        T >= 373.15 &&
        (initStats.nLongLipid > 1e-5 || initStats.nSoapTot > 1e-4) &&
        wMoisture < 0.18 &&
        mAqH2OG < Math.max(1.2, (mBaseEqG + initStats.mSoapG) * 0.25);
      if (dryBoilingScorch) {
        vessel.soapScorchFrac = Math.min(1, (vessel.soapScorchFrac || 0) + 0.20 * dt);
        vessel.soapScorched = vessel.soapScorchFrac > 0.16;
        if (vessel.soapScorched) vessel._soapScorchAlertPending = true;
      } else if (wMoisture >= 0.30) {
        vessel.soapScorchFrac = Math.max(0, (vessel.soapScorchFrac || 0) - 0.12 * dt);
        vessel.soapScorched = vessel.soapScorchFrac > 0.45;
      } else {
        vessel.soapScorched = (vessel.soapScorchFrac || 0) > 0.25;
      }

      // Premature saturated NaCl brine while unreacted long-chain lipid remains vs post-reaction brine
      const cNaSalt = (moles.Na_aq || 0) / totVolL;
      const cClSalt = (moles.Cl_aq || 0) / totVolL;
      const hasSatBrine = cNaSalt >= 1.8 && cClSalt >= 1.5 && (moles.H2O_l || 0) > 1e-4;
      const earlyBrineBlocked = hasSatBrine && initStats.nLongLipid > 1e-4 && (nSoapTotNow > 1e-5 || (moles.OH_aq || 0) > 1e-4);
      vessel.soapEarlySalted = earlyBrineBlocked;
      if (earlyBrineBlocked) vessel._soapEarlyBrineAlertPending = true;

      for (const ep of ESTER_KINETICS) {
        const nEster = moles[ep.id] || 0;
        const nAcid = ep.acidId ? (moles[ep.acidId] || 0) : 0;
        const nAlc = moles[ep.alcId] || 0;
        if (nEster <= 1e-10 && (ep.skipAcid || nAcid <= 1e-10 || nAlc <= 1e-10)) continue;

        const cEstEq = (nEster * ep.stoich) / totVolL;
        const cOH = (moles.OH_aq || 0) / totVolL;
        const cSalt = (moles[ep.saltId] || 0) / totVolL;
        const cW = (moles.H2O_l || 0) / totVolL;

        // 1. Alkaline Saponification (Arrhenius k2 + RK2 Midpoint integration + Emulsion scaled by ep.emulsifyPower)
        if (cOH > 1e-7 && cEstEq > 1e-9 && (moles.H2O_l || 0) > 1e-5) {
          const k2Base = ep.aAlk * Math.exp(-ep.eaAlk / (R_GAS * Math.max(250, T)));
          const solidFactor = ep.meltTempK && T < ep.meltTempK ? 0.22 : 1.0;
          const emulPow = ep.emulsifyPower ?? 1.0;
          const mixFactor = ep.isFat ? (emulPow < 0.4 ? 1.0 : (isStirred ? 1.0 : hasEtOHCosolvent ? 0.85 : 0.28)) : (cEstEq > 0.9 && !isStirred ? 0.45 : 1.0);
          const hazardFactor = ep.isFat && emulPow >= 0.4
            ? (concAlkaliBlocked ? 0.04 : 1.0) * (earlyBrineBlocked ? 0.05 : 1.0) * (dryBoilingScorch ? 0.05 : 1.0)
            : 1.0;
          const rateAlkAt = (ce, coh, cs) => {
            if (ce <= 1e-10 || coh <= 1e-10) return 0;
            const emul = ep.isFat ? ((1 - emulPow) + emulPow * (0.20 + 0.80 * (cs / (cs + 0.05)))) : 1.0;
            const viscBrake = ep.isFat && emulPow >= 0.4 && !isStirred && !hasEtOHCosolvent ? (1 / (1 + 1.2 * cs)) : 1.0;
            return k2Base * solidFactor * mixFactor * hazardFactor * emul * viscBrake * ce * coh;
          };

          // Multi-substep RK2 Midpoint integration prevents stiff overshoot/spikes
          const r0 = rateAlkAt(cEstEq, cOH, cSalt);
          const estMaxScale = k2Base * mixFactor * hazardFactor * Math.max(cEstEq, cOH) * dt;
          const nSub = Math.max(1, Math.min(12, Math.ceil(estMaxScale * 3.5)));
          const subDt = dt / nSub;
          let ce = cEstEq, coh = cOH, cs = cSalt;
          for (let s = 0; s < nSub; s++) {
            const k1 = rateAlkAt(ce, coh, cs);
            const ceMid = Math.max(0, ce - 0.5 * subDt * k1);
            const cohMid = Math.max(0, coh - 0.5 * subDt * k1);
            const csMid = cs + 0.5 * subDt * k1;
            const k2rk = rateAlkAt(ceMid, cohMid, csMid);
            const stepDx = Math.min(subDt * k2rk, ce, coh);
            ce -= stepDx; coh -= stepDx; cs += stepDx;
          }
          const dxEqMol = Math.min(nEster * ep.stoich, moles.OH_aq || 0, Math.max(0, (cEstEq - ce) * totVolL));
          const dFormMol = dxEqMol / ep.stoich;
          if (dFormMol > 1e-11 && r0 >= 0) {
            consumeSpecies(ep.id, dFormMol);
            consumeSpecies('OH_aq', dxEqMol);
            if (ep.chains) {
              for (const ch of ep.chains) {
                moles[ch.soapIonId] = (moles[ch.soapIonId] || 0) + ch.count * dFormMol;
              }
            } else {
              moles[ep.saltId] = (moles[ep.saltId] || 0) + dxEqMol;
            }
            moles[ep.alcId] = (moles[ep.alcId] || 0) + dFormMol;
            heatJ += dFormMol * ep.dHAlkJ;
            if (T >= 303.15 || dxEqMol / Math.max(1e-6, dt) >= 1e-5) {
              pushRxn(ep.rxnIdAlk, ep.eqAlk, ep.nameViAlk, ep.nameEnAlk, 'Thủy phân ester/chất béo theo động học Arrhenius + tự xúc tác nhũ tương hóa bằng xà phòng.', 'Arrhenius RK2 kinetics with autocatalytic soap emulsification.', dFormMol);
            }
          }
        }
        // 2. Reversible Acid-Catalyzed Hydrolysis <-> Esterification (halts strictly at Kc < 1)
        else if (!ep.skipAcid && ep.acidId && cH > 1e-4 && (moles.H2O_l || 0) > 1e-5) {
          const kCat = ep.aAcid * Math.exp(-ep.eaAcid / (R_GAS * Math.max(250, T)));
          const mixFactor = ep.isFat ? (isStirred ? 1.0 : hasEtOHCosolvent ? 0.85 : 0.32) : 1.0;
          const timeMult = ep.isFat ? 18.0 : 8.0; // Compressed lab timescale for slow acid equilibrium while preserving exact Kc
          const k1 = kCat * cH * mixFactor * timeMult;
          const kRev = k1 / ep.kc;
          const cAcid = nAcid / totVolL;
          const cAlcEq = (nAlc * ep.stoich) / totVolL;
          const netRateAt = (ce, cw, ca, cal) => k1 * ce * cw - kRev * ca * cal;
          const kr1 = netRateAt(cEstEq, cW, cAcid, cAlcEq);
          const dcMid = 0.5 * dt * kr1;
          const kr2 = netRateAt(
            Math.max(0, cEstEq - dcMid),
            Math.max(0, cW - dcMid),
            Math.max(0, cAcid + dcMid),
            Math.max(0, cAlcEq + dcMid)
          );
          let dxEqMol = kr2 * dt * totVolL;
          if (dxEqMol > 1e-11) {
            dxEqMol = Math.min(dxEqMol, nEster * ep.stoich, moles.H2O_l || 0);
            const dHyd = dxEqMol / ep.stoich;
            if (dHyd > 1e-11) {
              consumeSpecies(ep.id, dHyd); consumeSpecies('H2O_l', dxEqMol);
              moles[ep.acidId] = (moles[ep.acidId] || 0) + dxEqMol;
              moles[ep.alcId] = (moles[ep.alcId] || 0) + dHyd;
              heatJ -= dHyd * ep.dHAcidJ;
              pushRxn(`acid_hyd_${ep.id}`, `${ep.id.replace('_l', '').replace('_s', '')} + ${ep.stoich > 1 ? '3' : ''}H₂O ⇌(H⁺, Kc=${ep.kc}) Acid + ${ep.stoich > 1 ? 'Glycerol' : 'Alcohol'}`, `Thủy phân thuận nghịch trong acid (đạt cân bằng Kc = ${ep.kc})`, `Reversible acid hydrolysis (Kc = ${ep.kc})`, 'Phản ứng thuận nghịch tiến về cân bằng nhiệt động Kc, không bao giờ đạt 100% khi còn nước/sản phẩm.', 'Reversible acid hydrolysis approaches thermodynamic Kc equilibrium (never 100%).', dHyd);
            }
          } else if (dxEqMol < -1e-11 && nAcid > 1e-9 && nAlc > 1e-9) {
            dxEqMol = Math.max(dxEqMol, -nAcid, -nAlc * ep.stoich);
            const dRev = (-dxEqMol) / ep.stoich;
            if (dRev > 1e-11) {
              consumeSpecies(ep.acidId, -dxEqMol); consumeSpecies(ep.alcId, dRev);
              moles[ep.id] = (moles[ep.id] || 0) + dRev; moles.H2O_l = (moles.H2O_l || 0) + (-dxEqMol);
              heatJ += dRev * ep.dHAcidJ;
            }
          }
        }
      }

      // Property-Driven Soap Salting-Out via Ksp(T): scans sp.isSoapIon + sp.saltOutNaId cleanly
      // Checks ion product Q = [Na+][RCOO-] > Ksp(T) & solves exact equilibrium precipitation (no cClSalt >= 1.5 gate)
      if ((moles.H2O_l || 0) > 1e-4 && (moles.Na_aq || 0) > 1e-9) {
        let nNaAvail = moles.Na_aq || 0;
        const invV = 1 / Math.max(1e-5, totVolL);
        const vSq = totVolL * totVolL;
        for (const [ionId, nSoapI] of Object.entries(moles)) {
          if (nSoapI <= 1e-9 || nNaAvail <= 1e-9) continue;
          const spSoap = SPECIES[ionId];
          if (!spSoap?.isSoapIon || !spSoap.saltOutNaId || !SPECIES[spSoap.saltOutNaId]) continue;
          const ksp298 = spSoap.soapKsp298 ?? Math.max(0.012, 0.05 * Math.pow(0.76, (spSoap.soapChainLength || 18) - 18));
          const krafftBoost = T > 338.15 ? Math.exp(0.32 * Math.min(25, T - 338.15)) : 1;
          const kspT = ksp298 * Math.exp(0.022 * (T - 298.15)) * krafftBoost;
          const qIon = (nNaAvail * invV) * (nSoapI * invV);
          if (qIon <= kspT) continue;

          // Solve (nNa - x)(nRCOO - x) = Ksp(T) * V^2 => x^2 - (nNa + nRCOO)x + (nNa*nRCOO - Ksp*V^2) = 0
          const bSum = nNaAvail + nSoapI;
          const cTerm = nNaAvail * nSoapI - kspT * vSq;
          const disc = Math.max(0, bSum * bSum - 4 * cTerm);
          const xEq = Math.min(nNaAvail, nSoapI, Math.max(0, 0.5 * (bSum - Math.sqrt(disc))));
          const dSaltOut = Math.min(nSoapI, nNaAvail, xEq * (1 - Math.exp(-3.2 * dt)));
          if (dSaltOut > 1e-11) {
            const solidId = spSoap.saltOutNaId;
            consumeSpecies(ionId, dSaltOut);
            consumeSpecies('Na_aq', dSaltOut);
            nNaAvail = Math.max(0, nNaAvail - dSaltOut);
            moles[solidId] = (moles[solidId] || 0) + dSaltOut;
            const label = SPECIES[solidId]?.formula?.replace(/↓$/, '') || solidId;
            pushRxn(`saltout_${solidId}`, `${spSoap.formula || ionId} + Na⁺ —(Salting-out Ksp)→ ${label}↓`, `Kết tinh tách xà phòng ${label}↓ nổi lên trên khi [Na⁺][RCOO⁻] > Ksp`, `Salting-out soap: ${label}↓ floats above brine`, 'Hiệu ứng ion chung (thêm NaCl hoặc Na⁺ dư) đẩy [Na⁺][RCOO⁻] vượt Ksp(T) khiến xà phòng kết tinh tách lớp nổi lên trên dung dịch Glycerol + kiềm/muối.', 'Common-ion salting-out drives [Na⁺][RCOO⁻] > Ksp(T), precipitating buoyant solid soap cake cleanly above the glycerol brine.', dSaltOut);
          }
        }
      }
      const afterStats = collectLipidSoapStats();
      const nLipidAfter = afterStats.nLongLipid;
      const nSoapAqAfter = afterStats.nSoapAq;
      const nSoapSolidAfter = afterStats.nSoapSolid;
      vessel.soapSaltedOutCake = nLipidAfter <= 1e-4 && nSoapSolidAfter >= 1e-4;
      vessel.soapSoftPotassiumGel = (moles.K_aq || 0) >= 0.03 && (moles.Na_aq || 0) < 0.02 && nSoapAqAfter >= 0.005 && !vessel.soapSaltedOutCake;

      // Durable white soap foam column (collapses once salted-out solid soap cake separates or under saturated brine)
      if (afterStats.nSoapFoamWeighted > 5e-5 && (moles.H2O_l || 0) > 1e-4 && !hasSatBrine && !vessel.soapSaltedOutCake) {
        const isWarmAgitated = isStirred || (T >= 348.15 && (vessel.wasBoiling || nLipidAfter > 1e-5 || (vessel.tempK || 298) >= 353.15));
        const targetSoapFoam = Math.min(48, 3.0 + afterStats.nSoapFoamWeighted * 220);
        if (isWarmAgitated) {
          vessel.soapFoamMl = Math.min(targetSoapFoam, (vessel.soapFoamMl || 0) + (targetSoapFoam - (vessel.soapFoamMl || 0)) * (1 - Math.exp(-0.85 * dt)));
        } else {
          vessel.soapFoamMl = Math.max(0, (vessel.soapFoamMl || 0) * Math.exp(-0.025 * dt));
        }
      } else {
        vessel.soapFoamMl = Math.max(0, (vessel.soapFoamMl || 0) * Math.exp(-0.55 * dt));
      }
      if ((vessel.soapFoamMl || 0) < 0.05) vessel.soapFoamMl = 0;

      const wasDone = Boolean(vessel.saponificationComplete);
      vessel.saponificationComplete =
        Boolean(vessel._soapHadLipid) &&
        nLipidAfter <= 1e-4 &&
        nSoapAqAfter + nSoapSolidAfter >= 1e-3 &&
        !earlyBrineBlocked &&
        !vessel.soapScorched &&
        !concAlkaliBlocked;
      if (vessel.saponificationComplete && !wasDone) {
        vessel._soapCompleteAlertPending = true;
      }
    }

    // Property-Driven Unsaturated Lipid Catalytic Hydrogenation & Br2 Decolorization (doubleBondsPerMolecule & hydrogenatedSpeciesId)
    for (const [fatId, nFatRaw] of Object.entries(moles)) {
      if (nFatRaw <= 1e-9) continue;
      const spFat = SPECIES[fatId];
      const db = spFat?.doubleBondsPerMolecule || 0;
      if (!spFat?.isFat || db <= 0) continue;

      if (((moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8) && getG('H2_g') > 1e-8 && T >= 423.15) {
        const dHard = Math.min(moles[fatId] || 0, getG('H2_g') / db) * (1 - Math.exp(-0.78 * dt));
        if (dHard > 1e-11) {
          consumeSpecies(fatId, dHard); takeG('H2_g', db * dHard);
          const prodId = spFat.hydrogenatedSpeciesId && SPECIES[spFat.hydrogenatedSpeciesId] ? spFat.hydrogenatedSpeciesId : 'C57H110O6_s';
          moles[prodId] = (moles[prodId] || 0) + dHard;
          heatJ += dHard * db * 118300;
          pushRxn(`hardening_${fatId}`, `${spFat.formula || fatId} + ${db}H₂ —(Ni, 175 °C)→ ${SPECIES[prodId]?.formula || prodId}`, `Hydro hóa ${spFat.name || fatId} → chất béo rắn no`, `Fat hardening: ${spFat.name || fatId} + ${db}H₂ (Ni) → ${SPECIES[prodId]?.name || prodId}`, 'Cộng H₂ vào liên kết đôi C=C biến dầu thực vật lỏng thành mỡ rắn.', 'Catalytic hydrogenation converts unsaturated oil into saturated solid fat.', dHard);
        }
      }
      const brLip = (moles.Br2_aq || 0) > 1e-8 ? 'Br2_aq' : (moles.Br2_l || 0) > 1e-8 ? 'Br2_l' : null;
      if (brLip && (moles[fatId] || 0) > 1e-9) {
        const dBrL = Math.min(moles[fatId], (moles[brLip] || 0) / db) * (1 - Math.exp(-1.5 * dt));
        if (dBrL > 1e-11) {
          consumeSpecies(fatId, dBrL); consumeSpecies(brLip, db * dBrL);
          pushRxn(`br2_unsat_${fatId}`, `${spFat.formula || fatId} + ${db}Br₂ → Cộng Br₂ mất màu`, `${spFat.name || fatId} không no làm mất màu nước Bromine`, `Unsaturated ${spFat.name || fatId} decolorizes ${db} eq Br₂`, 'Các liên kết đôi C=C trong gốc acid không no cộng Br₂ theo tỉ lệ số nối đôi làm mất màu dung dịch Bromine.', `Each C=C double bond rapidly adds Br₂ (1:${db}), decolorizing Bromine.`, dBrL);
        }
      }
    }
  }

  return heatJ;
}
