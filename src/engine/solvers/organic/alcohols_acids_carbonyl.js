/**
 * Organic Chemistry Solver: Alcohols, Carboxylic Acids & Carbonyls (Split 81).
 */
import { CONSTANTS } from '../../../data/constants.js';
import { SPECIES } from '../../../data/species.js';
import { computeSulfuricAcidState } from '../../chemistryHelpers.js';

export function stepOrganicAlcoholsAcidsCarbonyl(ctx) {
  const {
    vessel, liquidVolL, dt, gasProduced, iceMob, options,
    moles, T, orgMob, uvOn, hs63, getG, takeG,
    consumeSpecies, pushRxn,
  } = ctx;
  let heatJ = 0;
  // ==================== PART 1: ABSOLUTE ETHANOL (C2H5OH_l) ====================
  if ((moles.C2H5OH_l || 0) > 1e-10 && orgMob > 0) {
    // 1a-ext. Calcium (Ca) reacts with anhydrous Ethanol -> (C2H5O)2Ca↓ + H2↑; Mg + I2 initiator at reflux >= 70 C
    if ((moles.Ca_s || 0) > 1e-9 && (moles.H2O_l || 0) < 0.015) {
      const kCaE = T >= 313.15 ? 0.72 : 0.25;
      const dCaE = Math.min(moles.Ca_s, moles.C2H5OH_l / 2) * (1 - Math.exp(-kCaE * dt));
      if (dCaE > 1e-11) {
        consumeSpecies('Ca_s', dCaE);
        consumeSpecies('C2H5OH_l', 2 * dCaE);
        moles.CaC2H5O_2_s = (moles.CaC2H5O_2_s || 0) + dCaE;
        gasProduced.H2_g = (gasProduced.H2_g || 0) + dCaE;
        heatJ += dCaE * 165000;
        pushRxn('etoh_ca', '2C₂H₅OH + Ca → (C₂H₅O)₂Ca↓ + H₂(g)↑', 'Calcium khử nhóm –OH của Ethanol tạo Calcium ethoxide & H₂', 'Calcium reacts with Ethanol → (C₂H₅O)₂Ca + H₂↑', 'Kim loại Ca tác dụng với Ethanol giải phóng khí H₂ tạo kết tủa trắng Calcium ethoxide.', 'Ca displaces H from Ethanol forming white Calcium ethoxide and H₂ gas.', dCaE, true);
      }
    }
    if ((moles.Mg_s || 0) > 1e-9 && ((moles.I2_s || 0) + (moles.I2_aq || 0)) > 1e-8 && T >= 343.15) {
      const dMgE = Math.min(moles.Mg_s, moles.C2H5OH_l / 2) * (1 - Math.exp(-0.55 * dt));
      if (dMgE > 1e-11) {
        consumeSpecies('Mg_s', dMgE);
        consumeSpecies('C2H5OH_l', 2 * dMgE);
        moles.MgC2H5O_2_s = (moles.MgC2H5O_2_s || 0) + dMgE;
        gasProduced.H2_g = (gasProduced.H2_g || 0) + dMgE;
        heatJ += dMgE * 145000;
        pushRxn('etoh_mg_i2', '2C₂H₅OH + Mg —(I₂, 78 °C)→ (C₂H₅O)₂Mg↓ + H₂↑', 'Magnesium phản ứng với Ethanol đun sôi có I₂ khơi mào', 'Mg reacts with boiling Ethanol (I₂ initiator) → (C₂H₅O)₂Mg↓ + H₂↑', 'Khi đun hồi lưu ~78 °C có tinh thể I₂ khơi mào, Mg tạo kết tủa trắng Magnesium ethoxide và H₂.', 'Refluxing Ethanol with clean Mg + I₂ initiator yields white (C₂H₅O)₂Mg and H₂.', dMgE, true);
      }
    }

    // 1b-pre. Anhydrous CrO3(s) + Ethanol -> rapid oxidation/ignition to CH3COOH + green Cr2O3(s)
    if ((moles.CrO3_s || 0) > 1e-9 && (moles.H2O_l || 0) < 0.025) {
      const dCr3E = Math.min(moles.C2H5OH_l / 3, moles.CrO3_s / 4) * (1 - Math.exp(-3.2 * dt));
      if (dCr3E > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dCr3E);
        consumeSpecies('CrO3_s', 4 * dCr3E);
        moles.CH3COOH_l = (moles.CH3COOH_l || 0) + 3 * dCr3E;
        moles.Cr2O3_s = (moles.Cr2O3_s || 0) + 2 * dCr3E;
        moles.H2O_l = (moles.H2O_l || 0) + 3 * dCr3E;
        heatJ += dCr3E * 1120000;
        vessel.naDryBurnTimer = Math.max(vessel.naDryBurnTimer || 0, 0.75);
        pushRxn('etoh_cro3_dry', '3C₂H₅OH + 4CrO₃(s) → 3CH₃COOH + 2Cr₂O₃(lục thẫm) + 3H₂O (Tỏa nhiệt mạnh!)', 'CrO₃ khan oxi hóa mãnh liệt Ethanol thành Acetic acid & Cr₂O₃ lục thẫm', 'Anhydrous CrO₃ vigorously oxidizes Ethanol → CH₃COOH + green Cr₂O₃', 'Nhỏ Ethanol lên tinh thể CrO₃ khan gây phản ứng tỏa nhiệt bùng cháy, khử Cr(VI) đỏ thẫm về Cr₂O₃ lục thẫm.', 'Pure Ethanol triggers violent exothermic oxidation on CrO₃ crystals leaving green Cr₂O₃.', dCr3E);
      }
    }

    // 1b. KMnO4 oxidation: anhydrous solid KMnO4_s flash, vs aqueous warm MnO4- (-> CH3COO-/MnO2 or acid -> CH3COOH + Mn2+)
    if ((moles.H2O_l || 0) < 0.015 && (moles.KMnO4_s || 0) > 1e-10) {
      const dKMnDry = Math.min(moles.C2H5OH_l / 3, moles.KMnO4_s / 4) * (1 - Math.exp(-2.8 * dt));
      if (dKMnDry > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dKMnDry);
        consumeSpecies('KMnO4_s', 4 * dKMnDry);
        moles.CH3COOK_s = (moles.CH3COOK_s || 0) + 3 * dKMnDry;
        moles.KOH_s = (moles.KOH_s || 0) + dKMnDry;
        moles.MnO2_s = (moles.MnO2_s || 0) + 4 * dKMnDry;
        moles.H2O_l = (moles.H2O_l || 0) + 4 * dKMnDry;
        heatJ += dKMnDry * 1350000;
        vessel.naDryBurnTimer = Math.max(vessel.naDryBurnTimer || 0, 0.85);
        pushRxn('etoh_kmno4_dry', '⚠️ 3C₂H₅OH(khan) + 4KMnO₄(s) → 3CH₃COOK + KOH + 4MnO₂ + 4H₂O (Bốc cháy!)', '⚠️ Nhỏ Ethanol khan lên KMnO₄ tinh thể gây tỏa nhiệt bốc cháy!', '⚠️ Anhydrous Ethanol + solid KMnO₄ ignites vigorously!', 'Ethanol tuyệt đối tiếp xúc KMnO₄ khan (nhất là có thêm H₂SO₄ đặc) tỏa nhiệt rất mạnh gây bốc cháy tức thì.', 'Anhydrous Ethanol on dry KMnO₄ triggers rapid exothermic ignition.', dKMnDry);
      }
    } else if (liquidVolL > 1e-6 && (moles.MnO4_aq || 0) > 1e-8) {
      if ((moles.H_aq || 0) > 1e-4) {
        const dMnA = Math.min(moles.C2H5OH_l / 5, moles.MnO4_aq / 4, moles.H_aq / 12) * (1 - Math.exp(-0.95 * dt));
        if (dMnA > 1e-11) {
          consumeSpecies('C2H5OH_l', 5 * dMnA);
          consumeSpecies('MnO4_aq', 4 * dMnA);
          consumeSpecies('H_aq', 12 * dMnA);
          moles.CH3COOH_l = (moles.CH3COOH_l || 0) + 5 * dMnA;
          moles.Mn2_aq = (moles.Mn2_aq || 0) + 4 * dMnA;
          moles.H2O_l = (moles.H2O_l || 0) + 11 * dMnA;
          heatJ += dMnA * 1280000;
          pushRxn('etoh_kmno4_acid', '5C₂H₅OH + 4MnO₄⁻ + 12H⁺ → 5CH₃COOH + 4Mn²⁺ + 11H₂O', 'KMnO₄/H⁺ oxi hóa Ethanol thành Acetic acid (mất màu tím)', 'Acidic KMnO₄ oxidizes Ethanol to Acetic acid (decolorizes)', 'Trong môi trường acid H₂SO₄, KMnO₄ mất màu tím hoàn toàn oxi hóa Ethanol lên CH₃COOH.', 'Acidic permanganate oxidizes Ethanol to Acetic acid forming colorless Mn²⁺.', dMnA);
        }
      } else if (T >= 313.15) {
        const dMnN = Math.min(moles.C2H5OH_l / 3, moles.MnO4_aq / 4) * (1 - Math.exp(-0.55 * dt));
        if (dMnN > 1e-11) {
          consumeSpecies('C2H5OH_l', 3 * dMnN);
          consumeSpecies('MnO4_aq', 4 * dMnN);
          moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 3 * dMnN;
          moles.MnO2_s = (moles.MnO2_s || 0) + 4 * dMnN;
          moles.OH_aq = (moles.OH_aq || 0) + dMnN;
          moles.H2O_l = (moles.H2O_l || 0) + 4 * dMnN;
          heatJ += dMnN * 780000;
          pushRxn('etoh_kmno4_neut', '3C₂H₅OH + 4MnO₄⁻ —(t°)→ 3CH₃COO⁻ + 4MnO₂↓ + OH⁻ + 4H₂O', 'KMnO₄ loãng đun nhẹ oxi hóa Ethanol tạo kết tủa nâu đen MnO₂', 'Warm aqueous KMnO₄ oxidizes Ethanol → CH₃COO⁻ + MnO₂↓', 'Dung dịch KMnO₄ loãng đun nhẹ chuyển nâu đen MnO₂↓ oxi hóa Ethanol thành muối acetate.', 'Warm aqueous KMnO₄ yields brown-black MnO₂↓ and acetate salt.', dMnN);
        }
      }
    }

    // 1c. K2Cr2O7 + H+ (breathalyzer reaction: orange -> emerald green Cr3+)
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.Cr2O7_2_aq || 0) > 1e-9 && (moles.H_aq || 0) > 1e-4 && liquidVolL > 1e-6) {
      const kBr = T >= 313.15 ? 2.4 : 0.85;
      const dCrE = Math.min(moles.C2H5OH_l / 3, moles.Cr2O7_2_aq / 2, moles.H_aq / 16) * (1 - Math.exp(-kBr * dt));
      if (dCrE > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dCrE);
        consumeSpecies('Cr2O7_2_aq', 2 * dCrE);
        consumeSpecies('H_aq', 16 * dCrE);
        moles.CH3COOH_l = (moles.CH3COOH_l || 0) + 3 * dCrE;
        moles.Cr3_aq = (moles.Cr3_aq || 0) + 4 * dCrE;
        moles.H2O_l = (moles.H2O_l || 0) + 11 * dCrE;
        heatJ += dCrE * 680000;
        pushRxn('etoh_k2cr2o7', '3C₂H₅OH + 2Cr₂O₇²⁻ + 16H⁺ → 3CH₃COOH + 4Cr³⁺(xanh lục) + 11H₂O', 'K₂Cr₂O₇/H⁺ oxi hóa Ethanol đổi màu đỏ cam → xanh lục (máy đo nồng độ cồn)', 'Dichromate/H⁺ oxidizes Ethanol: orange Cr₂O₇²⁻ → green Cr³⁺', 'Cơ chế máy thổi nồng độ cồn: K₂Cr₂O₇/H₂SO₄ đổi màu cam sang xanh lục Cr³⁺ khi gặp Ethanol.', 'Classic breathalyzer redox: acidic dichromate shifts from orange to emerald green Cr³⁺.', dCrE);
      }
    }

    // 1d. HNO3 conc (>= 55%, warm >= 313 K) -> CH3COOH + NO2↑
    const nNO3E = Math.min((moles.NO3_aq || 0) + (moles.HNO3_l || 0), (moles.H_aq || 0) + (moles.HNO3_l || 0));
    if ((moles.C2H5OH_l || 0) > 1e-10 && nNO3E > 1e-4 && T >= 313.15) {
      const wN = (nNO3E * 63.013) / Math.max(1e-9, nNO3E * 63.013 + (moles.H2O_l || 0) * 18.015);
      if (wN >= 0.55) {
        const dNE = Math.min(moles.C2H5OH_l, nNO3E / 4) * (1 - Math.exp(-0.95 * dt));
        if (dNE > 1e-11) {
          consumeSpecies('C2H5OH_l', dNE);
          let rem = 4 * dNE;
          const tkA = Math.min(moles.H_aq || 0, moles.NO3_aq || 0, rem);
          if (tkA > 0) { consumeSpecies('H_aq', tkA); consumeSpecies('NO3_aq', tkA); rem -= tkA; }
          if (rem > 0 && (moles.HNO3_l || 0) > 0) consumeSpecies('HNO3_l', Math.min(moles.HNO3_l, rem));
          moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dNE;
          moles.H2O_l = (moles.H2O_l || 0) + 3 * dNE;
          gasProduced.NO2_g = (gasProduced.NO2_g || 0) + 4 * dNE;
          heatJ += dNE * 340000;
          pushRxn('etoh_hno3_conc', 'C₂H₅OH + 4HNO₃(đặc) —(t°)→ CH₃COOH + 4NO₂(g)↑ + 3H₂O', 'HNO₃ đặc đun ấm oxi hóa mãnh liệt Ethanol sinh NO₂ nâu đỏ', 'Warm conc. HNO₃ vigorously oxidizes Ethanol evolving NO₂↑', 'HNO₃ đặc (68%) đun nhẹ oxi hóa mạnh Ethanol giải phóng khí nâu đỏ NO₂.', 'Warm conc. HNO₃ oxidizes Ethanol rapidly with brown NO₂ gas.', dNE, true);
        }
      }
    }

    // 1e. H2O2 + Fenton (Fe2+) or strong acid warm (>= 323 K)
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.H2O2_aq || 0) > 1e-7 && ((moles.Fe2_aq || 0) > 1e-6 || ((moles.H_aq || 0) > 0.01 && T >= 323.15))) {
      const dFen = Math.min(moles.C2H5OH_l, moles.H2O2_aq / 2) * (1 - Math.exp(-0.65 * dt));
      if (dFen > 1e-11) {
        consumeSpecies('C2H5OH_l', dFen);
        consumeSpecies('H2O2_aq', 2 * dFen);
        moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dFen;
        moles.H2O_l = (moles.H2O_l || 0) + 3 * dFen;
        heatJ += dFen * 290000;
        pushRxn('etoh_fenton', 'C₂H₅OH + 2H₂O₂ —(Fe²⁺ / H⁺)→ CH₃COOH + 3H₂O', 'Thuốc thử Fenton (H₂O₂/Fe²⁺) oxi hóa Ethanol thành Acetic acid', 'Fenton reagent (H₂O₂/Fe²⁺) oxidizes Ethanol → Acetic acid', 'Có xúc tác Fe²⁺ (thuốc thử Fenton) hoặc acid mạnh đun nóng, H₂O₂ oxi hóa Ethanol.', 'With Fe²⁺ Fenton catalyst or hot acid, H₂O₂ oxidizes Ethanol to Acetic acid.', dFen);
      }
    }

    // 1f. Conc H2SO4 dehydration: 130-162 C -> diethyl ether; >= 165 C -> ethylene C2H4↑
    const sulfE = computeSulfuricAcidState(moles);
    if ((moles.C2H5OH_l || 0) > 1e-10 && (sulfE.w >= 0.78 || (moles.H2SO4_l || 0) > 1e-4) && T >= 403.15) {
      if (T < 435.15) {
        const dEth = (moles.C2H5OH_l / 2) * (1 - Math.exp(-0.75 * dt));
        if (dEth > 1e-11) {
          consumeSpecies('C2H5OH_l', 2 * dEth);
          moles.C2H5OC2H5_l = (moles.C2H5OC2H5_l || 0) + dEth;
          moles.H2O_l = (moles.H2O_l || 0) + dEth;
          heatJ -= dEth * 24000;
          pushRxn('etoh_ether_140', '2C₂H₅OH —(H₂SO₄ đặc, 140 °C)→ C₂H₅OC₂H₅ + H₂O', 'Tách nước liên phân tử Ethanol ở 140 °C tạo Diethyl ether', 'Intermolecular Ethanol dehydration (140 °C) → Diethyl ether', 'Ở 140 °C có xúc tác H₂SO₄ đặc, 2 phân tử Ethanol tách nước tạo Diethyl ether.', 'At 140 °C with conc. H₂SO₄, two Ethanol molecules dehydrate to Diethyl ether.', dEth);
        }
      } else {
        const dC2H4 = moles.C2H5OH_l * (1 - Math.exp(-1.15 * dt));
        if (dC2H4 > 1e-11) {
          consumeSpecies('C2H5OH_l', dC2H4);
          moles.H2O_l = (moles.H2O_l || 0) + dC2H4;
          gasProduced.C2H4_g = (gasProduced.C2H4_g || 0) + dC2H4;
          heatJ -= dC2H4 * 45500;
          pushRxn('etoh_ethene_170', 'C₂H₅OH —(H₂SO₄ đặc, 170–180 °C)→ C₂H₄(g)↑ + H₂O', 'Tách nước nội phân tử Ethanol ở 170 °C điều chế khí Ethylene (C₂H₄)', 'Intramolecular Ethanol dehydration (170 °C) → Ethylene C₂H₄↑', 'Ở 170–180 °C có H₂SO₄ đặc, Ethanol tách nước nội phân tử giải phóng khí Ethene (C₂H₄).', 'At 170–180 °C with conc. H₂SO₄, Ethanol dehydrates cleanly to Ethylene gas.', dC2H4, true);
        }
      }
    }

    // 1f-3. –OH Nucleophilic substitution: HBr/H2SO4 (80-110 C), PBr3, PCl3 & acylation (CH3CO)2O / CH3COCl
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.Br_aq || 0) > 1e-6 && (moles.H_aq || 0) > 1e-4 && T >= 353.15) {
      const dHBrSub = Math.min(moles.C2H5OH_l, moles.Br_aq, moles.H_aq) * (1 - Math.exp(-0.52 * dt));
      if (dHBrSub > 1e-11) {
        consumeSpecies('C2H5OH_l', dHBrSub);
        consumeSpecies('Br_aq', dHBrSub);
        consumeSpecies('H_aq', dHBrSub);
        moles.C2H5Br_l = (moles.C2H5Br_l || 0) + dHBrSub;
        moles.H2O_l = (moles.H2O_l || 0) + dHBrSub;
        heatJ += dHBrSub * 14000;
        pushRxn('etoh_hbr_sub', 'C₂H₅OH + HBr —(H₂SO₄ đặc, 80–100 °C)→ C₂H₅Br(l) + H₂O', 'Thế nhóm –OH Ethanol bằng HBr đun nóng tạo Bromoethane C₂H₅Br', 'Nucleophilic substitution: Ethanol + HBr (80–100 °C) → Bromoethane', 'Đun Ethanol với HBr (hoặc NaBr + H₂SO₄ đặc) thế nhóm –OH thành dẫn xuất halogen Bromoethane.', 'Heating Ethanol with HBr substitutes –OH forming Bromoethane (C₂H₅Br).', dHBrSub);
      }
    }
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.PBr3_l || 0) > 1e-9 && (moles.H2O_l || 0) < 0.04) {
      const dPBrE = Math.min(moles.C2H5OH_l / 3, moles.PBr3_l) * (1 - Math.exp(-(T >= 313.15 ? 2.4 : 0.9) * dt));
      if (dPBrE > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dPBrE);
        consumeSpecies('PBr3_l', dPBrE);
        moles.C2H5Br_l = (moles.C2H5Br_l || 0) + 3 * dPBrE;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dPBrE;
        heatJ += dPBrE * 145000;
        pushRxn('etoh_pbr3', '3C₂H₅OH + PBr₃(l) —(25–60 °C)→ 3C₂H₅Br + H₃PO₃', 'Thế –OH Ethanol bằng PBr₃ điều chế Bromoethane C₂H₅Br', 'Ethanol + PBr₃ → 3C₂H₅Br + H₃PO₃', 'PBr₃ thay thế trực tiếp nhóm –OH trong Ethanol tạo Bromoethane hiệu suất cao.', 'PBr₃ cleanly converts Ethanol to Bromoethane and phosphorous acid.', dPBrE);
      }
    }
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.PCl3_l || 0) > 1e-9 && (moles.H2O_l || 0) < 0.04) {
      const dPClE = Math.min(moles.C2H5OH_l / 3, moles.PCl3_l) * (1 - Math.exp(-(T >= 313.15 ? 2.2 : 0.85) * dt));
      if (dPClE > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dPClE);
        consumeSpecies('PCl3_l', dPClE);
        gasProduced.C2H5Cl_g = (gasProduced.C2H5Cl_g || 0) + 3 * dPClE;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dPClE;
        heatJ += dPClE * 135000;
        pushRxn('etoh_pcl3', '3C₂H₅OH + PCl₃(l) —(25–60 °C)→ 3C₂H₅Cl↑ + H₃PO₃', 'Thế –OH Ethanol bằng PCl₃ tạo khí Ethyl chloride C₂H₅Cl↑', 'Ethanol + PCl₃ → 3C₂H₅Cl↑ + H₃PO₃', 'PCl₃ thế nhóm –OH của Ethanol tạo Ethyl chloride bay hơi và H₃PO₃.', 'PCl₃ converts Ethanol to gaseous Chloroethane and H₃PO₃.', dPClE, true);
      }
    }
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.CH3CO_2O_l || 0) > 1e-9) {
      const dAnhE = Math.min(moles.C2H5OH_l, moles.CH3CO_2O_l) * (1 - Math.exp(-(T >= 323.15 ? 2.4 : 0.75) * dt));
      if (dAnhE > 1e-11) {
        consumeSpecies('C2H5OH_l', dAnhE);
        consumeSpecies('CH3CO_2O_l', dAnhE);
        moles.CH3COOC2H5_l = (moles.CH3COOC2H5_l || 0) + dAnhE;
        moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dAnhE;
        heatJ += dAnhE * 62000;
        pushRxn('etoh_anhydride', 'C₂H₅OH + (CH₃CO)₂O → CH₃COOC₂H₅ + CH₃COOH', 'Acyl hóa Ethanol bằng Acetic anhydride tạo Ethyl acetate hiệu suất ~100%', 'Acetic anhydride esterifies Ethanol cleanly → Ethyl acetate + CH₃COOH', 'Phản ứng một chiều hoàn toàn, không cần tách nước như ester hóa Fischer.', 'Irreversible acylation with Acetic anhydride gives nearly quantitative Ethyl acetate.', dAnhE);
      }
    }
    if ((moles.C2H5OH_l || 0) > 1e-10 && (moles.CH3COCl_l || 0) > 1e-9) {
      const dAcClE = Math.min(moles.C2H5OH_l, moles.CH3COCl_l) * (1 - Math.exp(-4.5 * dt));
      if (dAcClE > 1e-11) {
        consumeSpecies('C2H5OH_l', dAcClE);
        consumeSpecies('CH3COCl_l', dAcClE);
        moles.CH3COOC2H5_l = (moles.CH3COOC2H5_l || 0) + dAcClE;
        gasProduced.HCl_g = (gasProduced.HCl_g || 0) + dAcClE;
        heatJ += dAcClE * 68000;
        pushRxn('etoh_ch3cocl', 'C₂H₅OH + CH₃COCl → CH₃COOC₂H₅ + HCl(g)↑', 'Ethanol phản ứng mãnh liệt với Acetyl chloride tạo Ethyl acetate + HCl↑', 'Ethanol + Acetyl chloride → Ethyl acetate + HCl↑', 'CH₃COCl phản ứng tức thì ngay nhiệt độ thường với Ethanol giải phóng khí HCl.', 'Acetyl chloride reacts rapidly at room temperature with Ethanol evolving HCl↑.', dAcClE, true);
      }
    }

    // 1g. Halogens: Br2 warm (50-70 C) -> CH3COOC2H5 + 4HBr↑; I2 + NaOH warm (50-60 C) -> CHI3↓ yellow iodoform!
    const availBr = (moles.Br2_l || 0) + (moles.Br2_aq || 0);
    if ((moles.C2H5OH_l || 0) > 1e-10 && availBr > 1e-8 && T >= 323.15 && (moles.OH_aq || 0) < 1e-5) {
      const dBrE = Math.min(moles.C2H5OH_l / 2, availBr / 2) * (1 - Math.exp(-0.72 * dt));
      if (dBrE > 1e-11) {
        consumeSpecies('C2H5OH_l', 2 * dBrE);
        let needB = 2 * dBrE;
        const tkBL = Math.min(moles.Br2_l || 0, needB);
        if (tkBL > 0) { consumeSpecies('Br2_l', tkBL); needB -= tkBL; }
        if (needB > 0) consumeSpecies('Br2_aq', Math.min(moles.Br2_aq || 0, needB));
        moles.CH3COOC2H5_l = (moles.CH3COOC2H5_l || 0) + dBrE;
        gasProduced.HBr_g = (gasProduced.HBr_g || 0) + 4 * dBrE;
        heatJ += dBrE * 85000;
        pushRxn('etoh_br2_warm', '2C₂H₅OH + 2Br₂ —(50–70 °C)→ CH₃COOC₂H₅ + 4HBr↑ (mất màu nâu đỏ)', 'Ethanol đun nhẹ (50–70 °C) làm mất màu Bromine lỏng', 'Warm Ethanol decolorizes Br₂ → Ethyl acetate + HBr↑', 'Đun nhẹ ở 50–70 °C, Br₂ mất màu nâu đỏ giải phóng HBr.', 'At 50–70 °C, Ethanol reduces brown Br₂ forming ester and HBr.', dBrE);
      }
    }
    const availI2 = (moles.I2_s || 0) + (moles.I2_aq || 0) + (moles.I3_aq || 0);
    if ((moles.C2H5OH_l || 0) > 1e-10 && availI2 > 1e-7 && (moles.OH_aq || 0) > 1e-6 && T >= 320.15) {
      const dIodo = Math.min(moles.C2H5OH_l, availI2 / 4, moles.OH_aq / 6) * (1 - Math.exp(-1.1 * dt));
      if (dIodo > 1e-11) {
        consumeSpecies('C2H5OH_l', dIodo);
        let needI = 4 * dIodo;
        for (const ik of ['I2_s', 'I2_aq', 'I3_aq']) {
          const tk = Math.min(moles[ik] || 0, needI);
          if (tk > 0) {
            consumeSpecies(ik, tk);
            if (ik === 'I3_aq') moles.I_aq = (moles.I_aq || 0) + tk;
            needI -= tk;
          }
        }
        consumeSpecies('OH_aq', 6 * dIodo);
        moles.CHI3_s = (moles.CHI3_s || 0) + dIodo;
        moles.HCOO_aq = (moles.HCOO_aq || 0) + dIodo;
        moles.I_aq = (moles.I_aq || 0) + 5 * dIodo;
        moles.H2O_l = (moles.H2O_l || 0) + 5 * dIodo;
        heatJ += dIodo * 115000;
        pushRxn('etoh_iodoform', 'C₂H₅OH + 4I₂ + 6OH⁻ —(60 °C)→ CHI₃(s)↓ (vàng tươi) + HCOO⁻ + 5I⁻ + 5H₂O', 'Phản ứng Iodoform: Ethanol + I₂/NaOH → kết tủa vàng CHI₃↓', 'Iodoform test: Ethanol + I₂/NaOH (50–60 °C) → bright yellow CHI₃↓', 'I₂ đơn chất chỉ tan màu nâu trong Ethanol, nhưng có mặt NaOH đun 50–60 °C tạo kết tủa vàng Iodoform CHI₃↓.', 'Pure I₂ merely dissolves brown in Ethanol, but with NaOH @ 50–60 °C precipitates yellow CHI₃.', dIodo);
      }
    }
  }

  // ==================== PART 1B: ETHANOL VAPOR / HETEROGENEOUS HOT CATALYSIS (C2H5OH(l) or C2H5OH(g)) ====================
  const headEt = vessel.headspaceGasMoles || {};
  const availEtTotal = (moles.C2H5OH_l || 0) + (headEt.C2H5OH_g || 0);
  if (availEtTotal > 1e-10 && T >= 493.15) {
    const consumeEtAny = (amt) => {
      let rem = amt;
      const tkL = Math.min(moles.C2H5OH_l || 0, rem);
      if (tkL > 0) { consumeSpecies('C2H5OH_l', tkL); rem -= tkL; }
      if (rem > 0 && (headEt.C2H5OH_g || 0) > 0) {
        const tkG = Math.min(headEt.C2H5OH_g, rem);
        headEt.C2H5OH_g = Math.max(0, headEt.C2H5OH_g - tkG);
        if (headEt.C2H5OH_g < 1e-13) delete headEt.C2H5OH_g;
      }
    };
    const emitHotWater = (wAmt) => {
      if (T >= 373.15) {
        gasProduced.H2O_g = (gasProduced.H2O_g || 0) + wAmt;
      } else {
        moles.H2O_l = (moles.H2O_l || 0) + wAmt;
      }
    };
    const curEtRem = () => (moles.C2H5OH_l || 0) + (headEt.C2H5OH_g || 0);

    // Hot CuO (220–300+ °C): C2H5OH(g/l) + CuO -> CH3CHO↑ + Cu(red) + H2O(g)
    if ((moles.CuO_s || 0) > 1e-9 && T >= 493.15) {
      const kCuO = T >= 523.15 ? 2.4 : 0.85;
      const dCuOE = Math.min(curEtRem(), moles.CuO_s) * (1 - Math.exp(-kCuO * dt));
      if (dCuOE > 1e-11) {
        consumeEtAny(dCuOE);
        consumeSpecies('CuO_s', dCuOE);
        moles.Cu_s = (moles.Cu_s || 0) + dCuOE;
        emitHotWater(dCuOE);
        if (T >= 295.0) {
          gasProduced.CH3CHO_g = (gasProduced.CH3CHO_g || 0) + dCuOE;
        } else {
          moles.CH3CHO_l = (moles.CH3CHO_l || 0) + dCuOE;
        }
        heatJ -= dCuOE * 8200;
        pushRxn('etoh_cuo_ald', 'C₂H₅OH(g) + CuO(đen) —(250–300 °C)→ CH₃CHO(g)↑ + Cu(đỏ)↓ + H₂O↑', 'Oxi hóa không hoàn toàn hơi Ethanol bằng CuO đun nóng → Acetaldehyde CH₃CHO + Cu đỏ', 'Mild Ethanol vapor oxidation by hot CuO (250–300 °C) → CH₃CHO + Cu(red)', 'Bột CuO đen oxi hóa hơi Ethanol thành Acetaldehyde CH₃CHO mùi táo xanh và khử về Cu đỏ.', 'Hot black CuO oxidizes Ethanol vapor selectively to Acetaldehyde (green-apple odor) and red Cu.', dCuOE, true);
      }
    }

    // Catalytic Al2O3 dehydration & Lebedev reaction (Al2O3 + ZnO, 370-450+ °C -> Buta-1,3-diene)
    const etCatLeft = curEtRem();
    if (etCatLeft > 1e-10 && (moles.Al2O3_s || 0) > 1e-7 && T >= 513.15) {
      if ((moles.ZnO_s || 0) > 1e-7 && T >= 643.15) {
        const dLeb = (etCatLeft / 2) * (1 - Math.exp(-1.65 * dt));
        if (dLeb > 1e-11) {
          consumeEtAny(2 * dLeb);
          emitHotWater(2 * dLeb);
          gasProduced.C4H6_g = (gasProduced.C4H6_g || 0) + dLeb;
          gasProduced.H2_g = (gasProduced.H2_g || 0) + dLeb;
          heatJ -= dLeb * 102000;
          pushRxn('etoh_lebedev', '2C₂H₅OH —(Al₂O₃ + ZnO, 400–450 °C)→ CH₂=CH–CH=CH₂(g)↑ + 2H₂O + H₂↑', 'Phản ứng Lebedev tổng hợp Buta-1,3-diene từ Ethanol', 'Lebedev synthesis: Ethanol —(Al₂O₃/ZnO, 450 °C)→ Buta-1,3-diene↑', 'Trên hệ xúc tác Al₂O₃ + ZnO ở 400–450 °C, hơi Ethanol đóng mạch tách nước và H₂ tạo khí Buta-1,3-diene.', 'Over mixed Al₂O₃ + ZnO catalyst at 400–450 °C, Ethanol vapor yields Buta-1,3-diene and H₂.', dLeb, true);
        }
      } else if (T < 603.15) {
        const dAlEth = (etCatLeft / 2) * (1 - Math.exp(-1.15 * dt));
        if (dAlEth > 1e-11) {
          consumeEtAny(2 * dAlEth);
          moles.C2H5OC2H5_l = (moles.C2H5OC2H5_l || 0) + dAlEth;
          emitHotWater(dAlEth);
          heatJ -= dAlEth * 24000;
          pushRxn('etoh_al2o3_ether', '2C₂H₅OH —(Al₂O₃, 240–260 °C)→ C₂H₅OC₂H₅ + H₂O', 'Tách nước dị thể qua xúc tác Al₂O₃ (240–260 °C) tạo Diethyl ether', 'Al₂O₃-catalyzed Ethanol dehydration (250 °C) → Diethyl ether', 'Xúc tác Al₂O₃ ở 240–260 °C tách nước liên phân tử hơi Ethanol tạo Diethyl ether.', 'Al₂O₃ catalyst at 240–260 °C dehydrates Ethanol vapor to Diethyl ether.', dAlEth);
        }
      } else {
        const dAlC2H4 = etCatLeft * (1 - Math.exp(-1.55 * dt));
        if (dAlC2H4 > 1e-11) {
          consumeEtAny(dAlC2H4);
          emitHotWater(dAlC2H4);
          gasProduced.C2H4_g = (gasProduced.C2H4_g || 0) + dAlC2H4;
          heatJ -= dAlC2H4 * 45500;
          pushRxn('etoh_al2o3_ethene', 'C₂H₅OH —(Al₂O₃, 350–400 °C)→ C₂H₄(g)↑ + H₂O', 'Tách nước qua Al₂O₃ (350–400 °C) tạo Ethylene C₂H₄↑', 'Al₂O₃ dehydration of Ethanol (350–400 °C) → Ethylene C₂H₄↑', 'Ở 350–400 °C trên Al₂O₃, hơi Ethanol tách nước nội phân tử sinh khí Ethene.', 'Over Al₂O₃ at 350–400 °C, Ethanol vapor dehydrates to Ethylene gas.', dAlC2H4, true);
        }
      }
    }
  }

  // ==================== PART 2: GLACIAL ACETIC ACID (CH3COOH_l) & FISCHER ESTER ====================
  if (((moles.CH3COOH_l || 0) > 1e-10 || (moles.CH3COOC2H5_l || 0) > 1e-10) && orgMob > 0) {
    const nWaterAc = moles.H2O_l || 0;
    const isGlacialDry = nWaterAc < 0.02;

    // 2a. Neutralization with NaOH / OH- & NH3
    if ((moles.OH_aq || 0) > 1e-9) {
      const dNeut = Math.min(moles.CH3COOH_l, moles.OH_aq) * (1 - Math.exp(-16.0 * dt));
      if (dNeut > 1e-11) {
        consumeSpecies('CH3COOH_l', dNeut);
        consumeSpecies('OH_aq', dNeut);
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dNeut;
        moles.H2O_l = (moles.H2O_l || 0) + dNeut;
        heatJ += dNeut * 56200;
        pushRxn('acoh_naoh', 'CH₃COOH + OH⁻(aq) → CH₃COO⁻(aq) + H₂O', 'Trung hòa Acetic acid bằng dung dịch kiềm mạnh', 'Neutralization of Acetic acid by strong alkali', 'CH₃COOH phản ứng trung hòa nhanh, tỏa nhiệt với NaOH/KOH tạo muối acetate.', 'Acetic acid neutralizes rapidly with NaOH/OH⁻ yielding acetate salt.', dNeut);
      }
    }
    if ((moles.CH3COOH_l || 0) > 1e-10 && (moles.NH3_aq || 0) > 1e-9) {
      const dAmA = Math.min(moles.CH3COOH_l, moles.NH3_aq) * (1 - Math.exp(-12.0 * dt));
      if (dAmA > 1e-11) {
        consumeSpecies('CH3COOH_l', dAmA);
        consumeSpecies('NH3_aq', dAmA);
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dAmA;
        moles.NH4_aq = (moles.NH4_aq || 0) + dAmA;
        heatJ += dAmA * 51500;
        pushRxn('acoh_nh3', 'CH₃COOH + NH₃(aq) → CH₃COONH₄(aq)', 'Acetic acid tác dụng với dung dịch Ammonia tạo Ammonium acetate', 'Acetic acid + NH₃(aq) → Ammonium acetate solution', 'Phản ứng xảy ra ngay nhiệt độ thường tạo dung dịch CH₃COONH₄.', 'CH₃COOH reacts immediately with Ammonia forming Ammonium acetate.', dAmA);
      }
    }

    // 2b. Metals: Na/K vigorous @ 25 C; Mg/Zn slow glacial 25 C -> fast warm/aq; Fe boiling/aq warm; Al PASSIVE!
    for (const [mId, catId, kRate] of [['Na_s', 'Na_aq', 3.4], ['K_s', 'K_aq', 4.6]]) {
      const nAlk = moles[mId] || 0;
      if (nAlk > 1e-10 && (moles.CH3COOH_l || 0) > 1e-10) {
        const dAlkA = Math.min(nAlk, moles.CH3COOH_l) * (1 - Math.exp(-kRate * dt));
        if (dAlkA > 1e-11) {
          consumeSpecies(mId, dAlkA);
          consumeSpecies('CH3COOH_l', dAlkA);
          moles[catId] = (moles[catId] || 0) + dAlkA;
          moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dAlkA;
          gasProduced.H2_g = (gasProduced.H2_g || 0) + 0.5 * dAlkA;
          heatJ += dAlkA * 185000;
          pushRxn(`acoh_${mId}`, `2CH₃COOH + 2${SPECIES[mId].formula} → 2CH₃COO${SPECIES[mId].formula} + H₂(g)↑`, `${SPECIES[mId].formula} tác dụng mãnh liệt với Acetic acid giải phóng H₂`, `Vigorous reaction: ${SPECIES[mId].formula} + CH₃COOH → acetate + H₂↑`, `${SPECIES[mId].formula} khử ngay H⁺ trong Acetic acid ngay nhiệt độ thường sinh khí H₂.`, `${SPECIES[mId].formula} reacts vigorously with Acetic acid evolving H₂↑.`, dAlkA, true);
        }
      }
    }
    for (const [mId, catId, kDryCold, kHotAq, minHotK] of [
      ['Mg_s', 'Mg2_aq', 0.012, 0.95, 323.15],
      ['Zn_s', 'Zn2_aq', 0.008, 0.65, 333.15],
      ['Fe_s', 'Fe2_aq', 0.0, 0.22, 373.15],
    ]) {
      const nM = moles[mId] || 0;
      if (nM > 1e-10 && (moles.CH3COOH_l || 0) > 1e-10) {
        const boosted = T >= minHotK || (!isGlacialDry && (mId !== 'Fe_s' || T >= 333.15));
        const rate = boosted ? kHotAq : kDryCold;
        if (rate > 0) {
          const dMAc = Math.min(nM, moles.CH3COOH_l / 2) * (1 - Math.exp(-rate * dt));
          if (dMAc > 1e-11) {
            consumeSpecies(mId, dMAc);
            consumeSpecies('CH3COOH_l', 2 * dMAc);
            moles[catId] = (moles[catId] || 0) + dMAc;
            moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dMAc;
            gasProduced.H2_g = (gasProduced.H2_g || 0) + dMAc;
            heatJ += dMAc * 145000;
            pushRxn(`acoh_${mId}`, `2CH₃COOH + ${SPECIES[mId].formula} → (CH₃COO)₂${SPECIES[mId].formula} + H₂(g)↑`, `${SPECIES[mId].formula} tan trong Acetic acid giải phóng H₂`, `${SPECIES[mId].formula} reacts with Acetic acid evolving H₂↑`, `${SPECIES[mId].formula} phản ứng rất chậm trong CH₃COOH băng nguội, nhanh hơn rõ rệt khi đun nóng hoặc pha nước.`, `${SPECIES[mId].formula} reacts slowly in cold glacial CH₃COOH and rapidly when heated or diluted.`, dMAc, true);
          }
        }
      }
    }

    // 2c. Carbonates (CaCO3 / Na2CO3 / NaHCO3) & CaC2: slow dry cold -> rapid warm/aq
    for (const [cId, stA, catId, catSt, wMake] of [
      ['CaCO3_s', 2, 'Ca2_aq', 1, 1],
      ['Na2CO3_s', 2, 'Na_aq', 2, 1],
      ['NaHCO3_s', 1, 'Na_aq', 1, 1],
    ]) {
      const nCarb = moles[cId] || 0;
      if (nCarb > 1e-10 && (moles.CH3COOH_l || 0) > 1e-10) {
        const kCarb = !isGlacialDry || T >= 323.15 ? 1.4 : 0.015;
        const dC = Math.min(nCarb, moles.CH3COOH_l / stA) * (1 - Math.exp(-kCarb * dt));
        if (dC > 1e-11) {
          consumeSpecies(cId, dC);
          consumeSpecies('CH3COOH_l', stA * dC);
          moles[catId] = (moles[catId] || 0) + catSt * dC;
          moles.CH3COO_aq = (moles.CH3COO_aq || 0) + stA * dC;
          moles.H2O_l = (moles.H2O_l || 0) + wMake * dC;
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dC;
          heatJ += dC * 18000;
          pushRxn(`acoh_${cId}`, `${stA > 1 ? stA : ''}CH₃COOH + ${SPECIES[cId].formula} → acetate + CO₂(g)↑ + H₂O`, `Acetic acid đẩy khí CO₂ khỏi muối ${SPECIES[cId].formula}`, `Acetic acid liberates CO₂↑ from ${SPECIES[cId].formula}`, 'Trong CH₃COOH băng khan ở 25 °C phản ứng chậm; thêm nước hoặc đun nóng sủi bọt CO₂ mạnh.', 'Slow in anhydrous glacial acid at 25 °C; vigorous CO₂ effervescence when warmed or diluted.', dC, true);
        }
      }
    }
    // Neutralize residual CH3COOH during ester washing with Na2CO3(aq) / NaHCO3(aq)
    if ((moles.CH3COOH_l || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-5) {
      if ((moles.CO3_2_aq || 0) > 1e-8) {
        const dCarbAq = Math.min(moles.CO3_2_aq, moles.CH3COOH_l / 2) * (1 - Math.exp(-4.5 * dt));
        if (dCarbAq > 1e-11) {
          consumeSpecies('CO3_2_aq', dCarbAq);
          consumeSpecies('CH3COOH_l', 2 * dCarbAq);
          moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dCarbAq;
          moles.H2O_l = (moles.H2O_l || 0) + dCarbAq;
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dCarbAq;
          heatJ += dCarbAq * 19000;
          pushRxn('acoh_co3_aq', '2CH₃COOH + CO₃²⁻ → 2CH₃COO⁻ + CO₂(g)↑ + H₂O', 'Rửa trung hòa acid dư bằng dung dịch muối Carbonate (sủi bọt CO₂)', 'Aqueous carbonate wash neutralizes residual Acetic acid → CO₂↑', 'Dung dịch Na₂CO₃ trung hòa acid dư giải phóng CO₂↑ đến khi hết sủi bọt.', 'Dilute Na₂CO₃ wash neutralizes leftover CH₃COOH liberating CO₂↑ effervescence.', dCarbAq, true);
        }
      }
      if ((moles.HCO3_aq || 0) > 1e-8) {
        const dHco3Aq = Math.min(moles.HCO3_aq, moles.CH3COOH_l) * (1 - Math.exp(-4.8 * dt));
        if (dHco3Aq > 1e-11) {
          consumeSpecies('HCO3_aq', dHco3Aq);
          consumeSpecies('CH3COOH_l', dHco3Aq);
          moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dHco3Aq;
          moles.H2O_l = (moles.H2O_l || 0) + dHco3Aq;
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dHco3Aq;
          heatJ += dHco3Aq * 15000;
          pushRxn('acoh_hco3_aq', 'CH₃COOH + HCO₃⁻ → CH₃COO⁻ + CO₂(g)↑ + H₂O', 'Rửa trung hòa acid dư bằng dung dịch Hydrogencarbonate (sủi bọt CO₂)', 'NaHCO₃ wash neutralizes residual Acetic acid → CO₂↑', 'Dung dịch NaHCO₃ rửa sạch hoàn toàn CH₃COOH/H₂SO₄ dư cho tới khi ngừng sủi CO₂.', 'Dilute NaHCO₃ wash neutralizes leftover acid until CO₂ effervescence ceases.', dHco3Aq, true);
        }
      }
    }
    if ((moles.CaC2_s || 0) > 1e-10 && (moles.CH3COOH_l || 0) > 1e-10 && (T >= 353.15 || !isGlacialDry)) {
      const dCa2A = Math.min(moles.CaC2_s, moles.CH3COOH_l / 2) * (1 - Math.exp(-(T >= 353.15 ? 0.95 : 0.35) * dt));
      if (dCa2A > 1e-11) {
        consumeSpecies('CaC2_s', dCa2A);
        consumeSpecies('CH3COOH_l', 2 * dCa2A);
        moles.Ca2_aq = (moles.Ca2_aq || 0) + dCa2A;
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dCa2A;
        gasProduced.C2H2_g = (gasProduced.C2H2_g || 0) + dCa2A;
        heatJ += dCa2A * 95000;
        pushRxn('acoh_cac2', '2CH₃COOH + CaC₂ —(80–118 °C)→ (CH₃COO)₂Ca + C₂H₂(g)↑', 'Acetic acid đun nóng phân hủy CaC₂ giải phóng khí Ethyne C₂H₂', 'Hot Acetic acid + CaC₂ → Calcium acetate + C₂H₂↑', 'Khi đun nóng (80–118 °C), CH₃COOH phản ứng với CaC₂ tạo khí C₂H₂.', 'When heated (80–118 °C), CH₃COOH decomposes CaC₂ evolving Ethyne gas.', dCa2A, true);
      }
    }

    // 2d. Reversible Fischer Esterification: CH3COOH + C2H5OH ⇄ CH3COOC2H5 + H2O (Kc ~ 4.0, dH° = -3.8 kJ/mol, Ea ~ 50 kJ/mol)
    // Conc. H2SO4 provides strong H+ catalysis AND dehydrating equilibrium push when used in dehydrating excess; dilute acid reacts markedly slower!
    const effVolEst = Math.max(1e-4, liquidVolL || 0.02);
    const nConcSulfEst = moles.H2SO4_l || 0;
    const nSulfIonEst = (moles.HSO4_aq || 0) + (moles.SO4_2_aq || 0);
    const nSulfTotEst = nConcSulfEst + nSulfIonEst;
    const cAcidCat = (nConcSulfEst * 1.6 + (moles.H_aq || 0)) / effVolEst;
    const hasConcH2SO4 = nConcSulfEst > 1e-5;
    const hasSulfSource = nSulfTotEst > 1e-5;
    const hasAcidCat = hasConcH2SO4 || (cAcidCat >= 0.35 && ((moles.SO4_2_aq || 0) + (moles.HSO4_aq || 0) + (moles.Cl_aq || 0)) > 1e-5);
    const nAcTotEst = (moles.CH3COOH_l || 0) + (moles.CH3COOC2H5_l || 0);
    const sulfAcRatio = nAcTotEst > 1e-6 ? nConcSulfEst / nAcTotEst : 0;
    const sulfMassEst = nSulfTotEst * 98.079;
    const waterMassEst = (moles.H2O_l || 0) * 18.01528;
    const sulfConcFrac = sulfMassEst + waterMassEst > 1e-6 ? sulfMassEst / (sulfMassEst + waterMassEst) : 0;
    // Strict conc vs dilute H2SO4 gating (tracks total sulfate so partial H2SO4->H++HSO4- ionization as H2O forms never stalls reflux):
    const isConcSulfEst = hasSulfSource && sulfConcFrac >= 0.25;
    // Catalytic conc. H2SO4 (~5-12 mol%) keeps exact Kc=4 equilibrium; heavy dehydrating excess (>22 mol%, >38 wt%) ties up H2O to push yield past 66.7%!
    const dehydrateTieUp =
      hasConcH2SO4 && isConcSulfEst && sulfAcRatio >= 0.22 && sulfConcFrac >= 0.38
        ? Math.min(0.62, ((sulfAcRatio - 0.18) / 0.65) * 0.62 * Math.min(1, sulfConcFrac / 0.65))
        : 0;
    if (((moles.CH3COOH_l || 0) > 1e-8 && (moles.C2H5OH_l || 0) > 1e-8) || ((moles.CH3COOC2H5_l || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-8 && hasAcidCat)) {
      const KcEst = Math.max(3.5, Math.min(4.4, 4.0 * Math.exp((-3800 / CONSTANTS.R_J_MOL_K) * (1 / Math.max(250, T) - 1 / 348.15))));
      const eaEstJ = 50000;
      const arrhRatio = Math.exp((-eaEstJ / CONSTANTS.R_J_MOL_K) * (1 / Math.max(250, T) - 1 / 353.15));
      // Conc. H2SO4 runs briskly; dilute aqueous mineral acid (<25 wt% H2SO4 or H_aq only) catalyzes markedly slower; uncatalyzed ~1000x slower!
      const dilPenalty = isConcSulfEst ? 1.0 : hasSulfSource ? 0.055 : 0.04;
      const catFactor = (hasAcidCat ? (0.001 + 1.0 * Math.max(0.25, Math.min(3.5, cAcidCat))) * dilPenalty : 0.0008);
      const k1Sim = 0.055 * catFactor * arrhRatio;
      const kRevSim = k1Sim / KcEst;

      const cAc = (moles.CH3COOH_l || 0) / effVolEst;
      const cEt = (moles.C2H5OH_l || 0) / effVolEst;
      const cEst = (moles.CH3COOC2H5_l || 0) / effVolEst;
      const cW = ((moles.H2O_l || 0) / effVolEst) * (1 - dehydrateTieUp);
      const dcDt = k1Sim * cAc * cEt - kRevSim * cEst * cW;
      const dMolRaw = dcDt * effVolEst * dt;
      if (dMolRaw > 1e-11) {
        const dEst = Math.min(moles.CH3COOH_l || 0, moles.C2H5OH_l || 0, dMolRaw * 1.0);
        if (dEst > 1e-11) {
          consumeSpecies('CH3COOH_l', dEst);
          consumeSpecies('C2H5OH_l', dEst);
          moles.CH3COOC2H5_l = (moles.CH3COOC2H5_l || 0) + dEst;
          moles.H2O_l = (moles.H2O_l || 0) + dEst;
          heatJ += dEst * 3800; // slightly exothermic ΔH° = -3.8 kJ/mol
          if (hasAcidCat || T >= 345.0) {
            pushRxn('fischer_esterification', 'CH₃COOH + C₂H₅OH ⇌(H₂SO₄ đặc; 60–80 °C) CH₃COOC₂H₅ + H₂O', 'Phản ứng Ester hóa thuận nghịch (Kc ≈ 4): Tạo Ethyl acetate thơm dầu chuối', 'Reversible Fischer Esterification (Kc ≈ 4): Acetic acid + Ethanol ⇄ Ethyl acetate + H₂O', 'H₂SO₄ đặc vừa xúc tác vừa hút nước chuyển dịch cân bằng thuận nghịch Kc ≈ 4 (tỉ lệ 1:1 đạt ~66,7%, dư EtOH 1:2 đạt ~84,5%, H₂SO₄ đặc hút nước/tách nước đạt cao hơn).', 'Conc. H₂SO₄ catalyzes and dehydrates reversible esterification (Kc ≈ 4: 1:1 gives 66.7%, 1:2 EtOH excess gives 84.5%, dehydration pushes conversion further).', dEst);
          }
        }
      } else if (dMolRaw < -1e-11 && hasAcidCat) {
        const dHyd = Math.min(moles.CH3COOC2H5_l || 0, moles.H2O_l || 0, -dMolRaw);
        if (dHyd > 1e-11) {
          consumeSpecies('CH3COOC2H5_l', dHyd);
          consumeSpecies('H2O_l', dHyd);
          moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dHyd;
          moles.C2H5OH_l = (moles.C2H5OH_l || 0) + dHyd;
          heatJ -= dHyd * 3800;
          pushRxn('fischer_hydrolysis', 'CH₃COOC₂H₅ + H₂O ⇌(H⁺; t°) CH₃COOH + C₂H₅OH', 'Thủy phân thuận nghịch Ethyl acetate tiến về trạng thái cân bằng Kc ≈ 4', 'Acid-catalyzed reverse ester hydrolysis approaching Kc ≈ 4', 'Khi dư nước hoặc sản phẩm vượt quá cân bằng Kc ≈ 4, ester bị thủy phân ngược lại một phần.', 'Excess water partially hydrolyzes Ethyl acetate back toward Kc ≈ 4 equilibrium.', dHyd);
        }
      }
      // Overheating (>130–140 C) with conc. H2SO4 across any esterification alcohols/esters: yellows/darkens mixture & triggers side charring + SO2
      const hasOverheatOrg =
        (moles.C2H5OH_l || 0) > 1e-4 ||
        (moles.C5H11OH_l || 0) > 1e-4 ||
        (moles.C3H7OH_l || 0) > 1e-4 ||
        (moles.CH3OH_l || 0) > 1e-4 ||
        (moles.CH3COOC2H5_l || 0) > 1e-4 ||
        (moles.CH3COOC5H11_l || 0) > 1e-4;
      if (T >= 403.15 && nConcSulfEst >= 0.005 && hasOverheatOrg) {
        vessel.esterOverheatFrac = Math.min(1, (vessel.esterOverheatFrac || 0) + (T >= 413.15 ? 0.28 : 0.14) * dt);
        vessel._esterOverheatAlertPending = true;
      }
      if (T >= 413.15 && nConcSulfEst >= 0.04 && (moles.C2H5OH_l || 0) > 1e-4 && nConcSulfEst > (moles.C2H5OH_l || 0) * 0.35) {
        const dChar = Math.min(moles.C2H5OH_l, nConcSulfEst / 6) * (1 - Math.exp(-(T >= 418.15 ? 0.09 : 0.035) * dt));
        if (dChar > 1e-10) {
          consumeSpecies('C2H5OH_l', dChar);
          consumeSpecies('H2SO4_l', 6 * dChar);
          moles.C_s = (moles.C_s || 0) + 2 * dChar;
          moles.H2O_l = (moles.H2O_l || 0) + 9 * dChar;
          gasProduced.SO2_g = (gasProduced.SO2_g || 0) + 6 * dChar;
          pushRxn('etoh_h2so4_char', 'C₂H₅OH + 6H₂SO₄(đặc) —(>140 °C)→ 2C↓ (đen) + 6SO₂↑ + 9H₂O', 'Quá nhiệt H₂SO₄ đặc (>130–140 °C) làm vàng–nâu sẫm hỗn hợp & sinh khí SO₂', 'Conc. H₂SO₄ overheating (>130–140 °C) darkens mixture & evolves SO₂↑', 'Dùng quá nhiều H₂SO₄ đặc hoặc đun >130–140 °C gây tách nước tạo ether/ethene và oxi hóa sẫm màu.', 'Excess conc. H₂SO₄ or overheating (>130–140 °C) triggers ether/ethene side-reactions and amber-dark charring.', dChar);
        }
      }
    }
    // Stage 3 Ester Purification telemetry: brine + carbonate acid-free wash + CaCl2 drying -> pure CH3COOC2H5
    const nEstPureCheck = moles.CH3COOC2H5_l || 0;
    const hasAcidFreeWash = (moles.CH3COOH_l || 0) + nConcSulfEst < 2e-3 && (moles.H_aq || 0) < 2e-3;
    const hasDryingCaCl2 = (moles.CaCl2_s || 0) > 1e-4 || ((moles.Ca2_aq || 0) > 1e-3 && (moles.Cl_aq || 0) > 2e-3);
    vessel.esterPurified = Boolean(
      nEstPureCheck >= 0.01 &&
      hasAcidFreeWash &&
      hasDryingCaCl2 &&
      (moles.C2H5OH_l || 0) <= Math.max(0.01, nEstPureCheck * 0.25 + ((moles.CaCl2_s || 0) + (moles.Ca2_aq || 0)) * 4)
    );
    if (nEstPureCheck >= 0.01 && (moles.CaCl2_s || 0) > 1e-4 && (moles.H2O_l || 0) > 1e-6 && (moles.H2O_l || 0) < 0.08) {
      // Anhydrous CaCl2 rapidly pulls trace moisture from crude organic ester into dense hydrated/brine phase
      const dCaDry = Math.min(moles.CaCl2_s, (moles.H2O_l || 0) * 0.5) * (1 - Math.exp(-3.5 * dt));
      if (dCaDry > 1e-10) {
        consumeSpecies('CaCl2_s', dCaDry);
        moles.Ca2_aq = (moles.Ca2_aq || 0) + dCaDry;
        moles.Cl_aq = (moles.Cl_aq || 0) + 2 * dCaDry;
        heatJ += dCaDry * 81300;
        pushRxn('ester_cacl2_dry', 'CaCl₂(khan) + nH₂O + 4C₂H₅OH —(làm khô Ester)→ CaCl₂·nH₂O / [CaCl₂·4EtOH]↓', 'CaCl₂ khan hút nước & tách Ethanol dư làm tinh khiết Ethyl acetate', 'Anhydrous CaCl₂ dries H₂O & sequesters residual Ethanol from Ethyl acetate', 'Làm khô pha hữu cơ bằng CaCl₂ khan loại bỏ nước và Ethanol vết để thu Ethyl acetate tinh khiết.', 'Anhydrous CaCl₂ binds trace water and Ethanol leaving clean anhydrous Ethyl acetate.', dCaDry);
      }
    }

    // 2e. Peracetic acid (CH3COOH + H2O2 with H2SO4 cat) & prolonged boiling KMnO4/H2SO4 -> CO2↑
    if ((moles.CH3COOH_l || 0) > 1e-9 && (moles.H2O2_aq || 0) > 1e-7 && hasAcidCat && T >= 295.0) {
      const dPaa = Math.min(moles.CH3COOH_l, moles.H2O2_aq) * (1 - Math.exp(-0.45 * dt));
      if (dPaa > 1e-11) {
        consumeSpecies('CH3COOH_l', dPaa);
        consumeSpecies('H2O2_aq', dPaa);
        moles.CH3COOOH_aq = (moles.CH3COOOH_aq || 0) + dPaa;
        moles.H2O_l = (moles.H2O_l || 0) + dPaa;
        pushRxn('acoh_h2o2_peracetic', 'CH₃COOH + H₂O₂ ⇌(H₂SO₄) CH₃COOOH + H₂O', 'Tạo Peracetic acid (CH₃COOOH) từ Acetic acid + H₂O₂', 'Peracetic acid synthesis: CH₃COOH + H₂O₂ (H₂SO₄ cat)', 'Trong môi trường H₂SO₄, CH₃COOH và H₂O₂ tạo cân bằng sinh Peracetic acid khử trùng mạnh.', 'Acetic acid reacts with H₂O₂ under H₂SO₄ catalysis forming Peracetic acid.', dPaa);
      }
    }
    if ((moles.CH3COOH_l || 0) > 1e-9 && (moles.MnO4_aq || 0) > 1e-8 && (moles.H_aq || 0) >= 0.05 && T >= 363.15) {
      const dKAc = Math.min(moles.CH3COOH_l / 5, moles.MnO4_aq / 8, moles.H_aq / 24) * (1 - Math.exp(-0.08 * dt));
      if (dKAc > 1e-11) {
        consumeSpecies('CH3COOH_l', 5 * dKAc);
        consumeSpecies('MnO4_aq', 8 * dKAc);
        consumeSpecies('H_aq', 24 * dKAc);
        moles.Mn2_aq = (moles.Mn2_aq || 0) + 8 * dKAc;
        moles.H2O_l = (moles.H2O_l || 0) + 22 * dKAc;
        gasProduced.CO2_g = (gasProduced.CO2_g || 0) + 10 * dKAc;
        heatJ += dKAc * 950000;
        pushRxn('acoh_kmno4_boil', '5CH₃COOH + 8MnO₄⁻ + 24H⁺ —(đun sôi kéo dài)→ 10CO₂↑ + 8Mn²⁺ + 22H₂O', 'KMnO₄/H₂SO₄ đun sôi mạnh kéo dài mới oxi hóa chậm CH₃COOH thành CO₂', 'Prolonged boiling KMnO₄/H⁺ slowly oxidizes Acetic acid → CO₂↑', 'CH₃COOH bền ở nhiệt độ thường; chỉ đun sôi kéo dài với KMnO₄/H⁺ đặc mới mất màu tím sinh CO₂.', 'CH₃COOH resists ambient KMnO₄; only prolonged boiling in strong acid slowly yields CO₂.', dKAc);
      }
    }

    // 2f. Basic oxides & hydroxides: CuO(t° >= 55 C), Cu(OH)2, ZnO, CaO, Ca(OH)2
    if ((moles.CuO_s || 0) > 1e-9 && T >= 323.15) {
      const dCuOAc = Math.min(moles.CuO_s, moles.CH3COOH_l / 2) * (1 - Math.exp(-0.85 * dt));
      if (dCuOAc > 1e-11) {
        consumeSpecies('CuO_s', dCuOAc);
        consumeSpecies('CH3COOH_l', 2 * dCuOAc);
        moles.Cu2_aq = (moles.Cu2_aq || 0) + dCuOAc;
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dCuOAc;
        moles.H2O_l = (moles.H2O_l || 0) + dCuOAc;
        heatJ += dCuOAc * 42000;
        pushRxn('acoh_cuo', 'CuO(đen) + 2CH₃COOH —(60–90 °C)→ (CH₃COO)₂Cu(xanh lam) + H₂O', 'CuO tan trong Acetic acid đun nóng tạo dung dịch Copper(II) acetate xanh lam', 'Hot Acetic acid dissolves black CuO → blue Copper(II) acetate', 'Bột CuO đen tan dần khi đun nóng trong CH₃COOH cho dung dịch xanh ngọc lam đặc trưng.', 'Black CuO dissolves in warm Acetic acid giving characteristic blue-teal Copper(II) acetate.', dCuOAc);
      }
    }
    for (const [oxId, catId, wSt, kOx, labelVi, labelEn] of [
      ['CuOH2_s', 'Cu2_aq', 2, 1.8, 'Cu(OH)₂ xanh lam tan trong Acetic acid', 'Blue Cu(OH)₂ dissolves in Acetic acid'],
      ['ZnO_s', 'Zn2_aq', 1, 1.4, 'ZnO tan trong Acetic acid tạo (CH₃COO)₂Zn', 'ZnO dissolves in Acetic acid → Zinc acetate'],
      ['CaO_s', 'Ca2_aq', 1, 2.2, 'CaO tác dụng với Acetic acid tạo (CH₃COO)₂Ca', 'CaO + CH₃COOH → Calcium acetate'],
      ['CaOH2_s', 'Ca2_aq', 2, 2.8, 'Ca(OH)₂ trung hòa Acetic acid tạo (CH₃COO)₂Ca', 'Ca(OH)₂ neutralizes CH₃COOH → Calcium acetate'],
    ]) {
      const nOx = moles[oxId] || 0;
      if (nOx > 1e-9 && (moles.CH3COOH_l || 0) > 1e-10) {
        const dOx = Math.min(nOx, moles.CH3COOH_l / 2) * (1 - Math.exp(-kOx * dt));
        if (dOx > 1e-11) {
          consumeSpecies(oxId, dOx);
          consumeSpecies('CH3COOH_l', 2 * dOx);
          moles[catId] = (moles[catId] || 0) + dOx;
          moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dOx;
          moles.H2O_l = (moles.H2O_l || 0) + wSt * dOx;
          heatJ += dOx * 52000;
          pushRxn(`acoh_${oxId}`, `${SPECIES[oxId].formula} + 2CH₃COOH → (CH₃COO)₂M + ${wSt > 1 ? wSt : ''}H₂O`, labelVi, labelEn, labelVi, labelEn, dOx);
        }
      }
    }

    // 2g. Carboxylic Acid Derivatives: PCl3 -> CH3COCl, P4O10 -> Acetic anhydride (CH3CO)2O
    if ((moles.PCl3_l || 0) > 1e-9 && (moles.H2O_l || 0) < 0.04) {
      const dAcCl = Math.min(moles.CH3COOH_l / 3, moles.PCl3_l) * (1 - Math.exp(-(T >= 313.15 ? 1.8 : 0.45) * dt));
      if (dAcCl > 1e-11) {
        consumeSpecies('CH3COOH_l', 3 * dAcCl);
        consumeSpecies('PCl3_l', dAcCl);
        moles.CH3COCl_l = (moles.CH3COCl_l || 0) + 3 * dAcCl;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dAcCl;
        heatJ += dAcCl * 85000;
        pushRxn('acoh_pcl3', '3CH₃COOH + PCl₃(l) —(50 °C)→ 3CH₃COCl(l) + H₃PO₃', 'Tổng hợp Acetyl chloride từ Acetic acid + PCl₃', 'Acetyl chloride synthesis: 3CH₃COOH + PCl₃ → 3CH₃COCl + H₃PO₃', 'PCl₃ thế nhóm –OH trong nhóm carboxyl tạo Acetyl chloride (CH₃COCl).', 'PCl₃ converts Acetic acid into Acetyl chloride (CH₃COCl).', dAcCl);
      }
    }
    if ((moles.P4O10_s || 0) > 1e-9 && (moles.H2O_l || 0) < 0.05 && T >= 333.15) {
      const dAnh = Math.min(moles.CH3COOH_l / 12, moles.P4O10_s) * (1 - Math.exp(-0.95 * dt));
      if (dAnh > 1e-11) {
        consumeSpecies('CH3COOH_l', 12 * dAnh);
        consumeSpecies('P4O10_s', dAnh);
        moles.CH3CO_2O_l = (moles.CH3CO_2O_l || 0) + 6 * dAnh;
        moles.H3PO4_aq = (moles.H3PO4_aq || 0) + 4 * dAnh;
        heatJ += dAnh * 165000;
        pushRxn('acoh_p4o10_anhydride', '12CH₃COOH + P₄O₁₀ —(t°)→ 6(CH₃CO)₂O(l) + 4H₃PO₄', 'Tách nước Acetic acid bằng P₄O₁₀ điều chế Acetic anhydride (CH₃CO)₂O', 'P₄O₁₀ dehydrates Acetic acid → Acetic anhydride (CH₃CO)₂O', 'P₄O₁₀ hút nước mạnh giúp hai phân tử CH₃COOH tách 1 H₂O tạo Acetic anhydride.', 'Strong dehydrating agent P₄O₁₀ condenses Acetic acid into Acetic anhydride.', dAnh);
      }
    }

    // 2h. Alpha-C Hell-Volhard-Zelinsky (HVZ) halogenation: CH3COOH + Cl2/Br2 —(P_red or UV, 80-100 C)→ haloacetic acid
    const hasHVZCat = (moles.P_red_s || 0) > 1e-8 || Boolean(options?.uvLight);
    if (hasHVZCat && T >= 348.15) {
      const head = vessel.headspaceGasMoles || {};
      const nClHVZ = (head.Cl2_g || 0) + (moles.Cl2_aq || 0);
      if (nClHVZ > 1e-8) {
        const dHClV = Math.min(moles.CH3COOH_l, nClHVZ) * (1 - Math.exp(-0.75 * dt));
        if (dHClV > 1e-11) {
          consumeSpecies('CH3COOH_l', dHClV);
          let needC = dHClV;
          const tkCg = Math.min(head.Cl2_g || 0, needC);
          if (tkCg > 0) { head.Cl2_g -= tkCg; if (head.Cl2_g < 1e-13) delete head.Cl2_g; needC -= tkCg; }
          if (needC > 0 && (moles.Cl2_aq || 0) > 0) consumeSpecies('Cl2_aq', Math.min(moles.Cl2_aq, needC));
          moles.ClCH2COOH_s = (moles.ClCH2COOH_s || 0) + dHClV;
          gasProduced.HCl_g = (gasProduced.HCl_g || 0) + dHClV;
          heatJ += dHClV * 95000;
          pushRxn('acoh_hvz_cl', 'CH₃COOH + Cl₂ —(P đỏ / UV, 80–100 °C)→ ClCH₂COOH + HCl(g)↑', 'Phản ứng thế gốc –CH₃ (HVZ): Tạo Chloroacetic acid & HCl↑', 'Alpha-C halogenation: CH₃COOH + Cl₂ (P_red / UV) → ClCH₂COOH + HCl↑', 'Có xúc tác P đỏ (hoặc UV) ở 80–100 °C, Cl₂ thế H ở vị trí alpha tạo Chloroacetic acid.', 'With red P catalyst or UV at 80–100 °C, Cl₂ substitutes alpha-H forming Chloroacetic acid.', dHClV, true);
        }
      }
      const nBrHVZ = (moles.Br2_l || 0) + (moles.Br2_aq || 0);
      if (nBrHVZ > 1e-8) {
        const dHBrV = Math.min(moles.CH3COOH_l, nBrHVZ) * (1 - Math.exp(-0.68 * dt));
        if (dHBrV > 1e-11) {
          consumeSpecies('CH3COOH_l', dHBrV);
          let needB = dHBrV;
          const tkBl = Math.min(moles.Br2_l || 0, needB);
          if (tkBl > 0) { consumeSpecies('Br2_l', tkBl); needB -= tkBl; }
          if (needB > 0 && (moles.Br2_aq || 0) > 0) consumeSpecies('Br2_aq', Math.min(moles.Br2_aq, needB));
          moles.BrCH2COOH_s = (moles.BrCH2COOH_s || 0) + dHBrV;
          gasProduced.HBr_g = (gasProduced.HBr_g || 0) + dHBrV;
          heatJ += dHBrV * 82000;
          pushRxn('acoh_hvz_br', 'CH₃COOH + Br₂ —(P đỏ, 80–100 °C)→ BrCH₂COOH + HBr(g)↑', 'Phản ứng Hell–Volhard–Zelinsky: CH₃COOH + Br₂ (P đỏ) → Bromoacetic acid + HBr↑', 'Hell–Volhard–Zelinsky: CH₃COOH + Br₂ (P_red) → BrCH₂COOH + HBr↑', 'Phản ứng Hell–Volhard–Zelinsky (xúc tác P đỏ) thế Br vào carbon alpha nhóm CH₃ tạo BrCH₂COOH.', 'Hell–Volhard–Zelinsky alpha-bromination with red P yields Bromoacetic acid and HBr↑.', dHBrV, true);
        }
      }
    }
  }

  // ==================== PART 3: ORGANIC DERIVATIVES, ACETATE PYROLYSIS & SODA-LIME ====================
  // 3a. Hydrolysis of (C2H5O)2Ca, CH3COCl, (CH3CO)2O in aqueous water
  if ((moles.CaC2H5O_2_s || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-7 && orgMob > 0) {
    const dHydCaE = Math.min(moles.CaC2H5O_2_s, moles.H2O_l / 2) * (1 - Math.exp(-4.5 * dt));
    if (dHydCaE > 1e-11) {
      consumeSpecies('CaC2H5O_2_s', dHydCaE);
      consumeSpecies('H2O_l', 2 * dHydCaE);
      moles.CaOH2_s = (moles.CaOH2_s || 0) + dHydCaE;
      moles.C2H5OH_l = (moles.C2H5OH_l || 0) + 2 * dHydCaE;
      heatJ += dHydCaE * 78000;
      pushRxn('cac2h5o2_hyd', '(C₂H₅O)₂Ca + 2H₂O → Ca(OH)₂ + 2C₂H₅OH', 'Thủy phân Calcium ethoxide trong nước', 'Hydrolysis of Calcium ethoxide', 'Ethoxide kim loại bị thủy phân hoàn toàn trong nước tái tạo Ethanol.', 'Calcium ethoxide hydrolyzes cleanly to Ca(OH)₂ and Ethanol.', dHydCaE);
    }
  }
  if ((moles.CH3COCl_l || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-7 && orgMob > 0) {
    const dHydAcCl = Math.min(moles.CH3COCl_l, moles.H2O_l) * (1 - Math.exp(-6.5 * dt));
    if (dHydAcCl > 1e-11) {
      consumeSpecies('CH3COCl_l', dHydAcCl);
      consumeSpecies('H2O_l', dHydAcCl);
      moles.CH3COOH_l = (moles.CH3COOH_l || 0) + dHydAcCl;
      moles.H_aq = (moles.H_aq || 0) + dHydAcCl;
      moles.Cl_aq = (moles.Cl_aq || 0) + dHydAcCl;
      heatJ += dHydAcCl * 92000;
      pushRxn('ch3cocl_hyd', 'CH₃COCl + H₂O → CH₃COOH + HCl(aq)', 'Thủy phân mãnh liệt Acetyl chloride', 'Vigorous Acetyl chloride hydrolysis', 'CH₃COCl thủy phân ngay trong nước tạo Acetic acid và HCl.', 'Acetyl chloride hydrolyzes briskly forming CH₃COOH and HCl.', dHydAcCl);
    }
  }
  if ((moles.CH3CO_2O_l || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-7 && orgMob > 0) {
    const kHA = T >= 323.15 ? 2.4 : 0.35;
    const dHydAnh = Math.min(moles.CH3CO_2O_l, moles.H2O_l) * (1 - Math.exp(-kHA * dt));
    if (dHydAnh > 1e-11) {
      consumeSpecies('CH3CO_2O_l', dHydAnh);
      consumeSpecies('H2O_l', dHydAnh);
      moles.CH3COOH_l = (moles.CH3COOH_l || 0) + 2 * dHydAnh;
      heatJ += dHydAnh * 58000;
      pushRxn('anhydride_hyd', '(CH₃CO)₂O + H₂O → 2CH₃COOH', 'Thủy phân Acetic anhydride thành Acetic acid', 'Acetic anhydride hydrolysis → 2CH₃COOH', 'Acetic anhydride thủy phân tạo 2 phân tử Acetic acid.', 'Acetic anhydride hydrolyzes yielding two equivalents of Acetic acid.', dHydAnh);
    }
  }

  // 3b. Acetamide dehydration: CH3COONH4 —(150–200 °C)→ CH3CONH2 + H2O↑
  if ((moles.CH3COONH4_s || 0) > 1e-9 && T >= 423.15) {
    const dAmide = moles.CH3COONH4_s * (1 - Math.exp(-0.55 * dt));
    if (dAmide > 1e-11) {
      consumeSpecies('CH3COONH4_s', dAmide);
      moles.CH3CONH2_s = (moles.CH3CONH2_s || 0) + dAmide;
      gasProduced.H2O_g = (gasProduced.H2O_g || 0) + dAmide;
      heatJ -= dAmide * 48000;
      pushRxn('ch3coonh4_acetamide', 'CH₃COONH₄(s) —(150–200 °C)→ CH₃CONH₂(s) + H₂O(g)↑', 'Nhiệt phân tách nước Ammonium acetate tạo Acetamide CH₃CONH₂', 'Ammonium acetate dehydration (150–200 °C) → Acetamide + H₂O↑', 'Đun nóng muối CH₃COONH₄ ở 150–200 °C tách nước tạo Acetamide (CH₃CONH₂).', 'Heating solid Ammonium acetate (150–200 °C) dehydrates to crystalline Acetamide.', dAmide);
    }
  }

  // 3c. Soda-lime decarboxylation: CH3COONa(s) + NaOH(s) —(CaO, 300–400 °C)→ CH4(g)↑ + Na2CO3(s)
  if ((moles.CH3COONa_s || 0) > 1e-9 && (moles.NaOH_s || 0) > 1e-9 && T >= 573.15 && (moles.H2O_l || 0) < 0.01) {
    const hasCaOCat = (moles.CaO_s || 0) > 1e-9;
    if (hasCaOCat || T >= 623.15) {
      const kDec = hasCaOCat ? 1.15 : 0.45;
      const dCH4 = Math.min(moles.CH3COONa_s, moles.NaOH_s) * (1 - Math.exp(-kDec * dt));
      if (dCH4 > 1e-11) {
        consumeSpecies('CH3COONa_s', dCH4);
        consumeSpecies('NaOH_s', dCH4);
        moles.Na2CO3_s = (moles.Na2CO3_s || 0) + dCH4;
        gasProduced.CH4_g = (gasProduced.CH4_g || 0) + dCH4;
        heatJ -= dCH4 * 18000;
        pushRxn('sodalime_ch4', 'CH₃COONa + NaOH —(CaO, 300–400 °C)→ CH₄(g)↑ + Na₂CO₃', 'Phản ứng vôi tôi xút (Soda-lime) điều chế khí Methane CH₄↑', 'Soda-lime decarboxylation: CH₃COONa + NaOH (CaO, 350 °C) → CH₄↑ + Na₂CO₃', 'Nung khan CH₃COONa với NaOH và vôi sống CaO ở 300–400 °C giải phóng khí Methane tinh khiết.', 'Heating dry Sodium acetate with NaOH/CaO soda-lime (300–400 °C) liberates Methane CH₄↑.', dCH4, true);
      }
    }
  }

  // 3d. Dry distillation of Calcium acetate: (CH3COO)2Ca(s) —(400–500 °C)→ CH3COCH3(Acetone) + CaCO3(s)
  if ((moles.CaCH3COO_2_s || 0) > 1e-9 && T >= 653.15 && (moles.H2O_l || 0) < 0.01) {
    const dAcet = moles.CaCH3COO_2_s * (1 - Math.exp(-0.82 * dt));
    if (dAcet > 1e-11) {
      consumeSpecies('CaCH3COO_2_s', dAcet);
      moles.CaCO3_s = (moles.CaCO3_s || 0) + dAcet;
      if (T >= 329.20) {
        gasProduced.CH3COCH3_g = (gasProduced.CH3COCH3_g || 0) + dAcet;
      } else {
        moles.CH3COCH3_l = (moles.CH3COCH3_l || 0) + dAcet;
      }
      heatJ -= dAcet * 42000;
      pushRxn('ca_acetate_pyrolysis', '(CH₃COO)₂Ca(s) —(400–500 °C)→ CH₃COCH₃(Acetone)↑ + CaCO₃(s)', 'Chưng khô Calcium acetate điều chế Acetone CH₃COCH₃', 'Calcium acetate dry distillation (400–500 °C) → Acetone + CaCO₃', 'Nhiệt phân muối (CH₃COO)₂Ca khan ở 400–500 °C tạo hơi Acetone và cặn CaCO₃.', 'Pyrolyzing anhydrous Calcium acetate at 400–500 °C distills Acetone leaving CaCO₃.', dAcet, true);
    }
  }

  // 3e. Acetaldehyde mild oxidations (Cu(OH)2 warm -> Cu2O đỏ gạch; Ag+ / NH3 Tollens silver mirror!) & Acetone Iodoform
  if ((moles.CH3CHO_l || 0) > 1e-9 && (moles.CuOH2_s || 0) > 1e-9 && (moles.OH_aq || 0) > 1e-5 && T >= 333.15 && orgMob > 0) {
    const dCu2O = Math.min(moles.CH3CHO_l, moles.CuOH2_s / 2, moles.OH_aq) * (1 - Math.exp(-1.1 * dt));
    if (dCu2O > 1e-11) {
      consumeSpecies('CH3CHO_l', dCu2O);
      consumeSpecies('CuOH2_s', 2 * dCu2O);
      consumeSpecies('OH_aq', dCu2O);
      moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dCu2O;
      moles.Cu2O_s = (moles.Cu2O_s || 0) + dCu2O;
      moles.H2O_l = (moles.H2O_l || 0) + 3 * dCu2O;
      heatJ += dCu2O * 140000;
      pushRxn('ch3cho_fehling', 'CH₃CHO + 2Cu(OH)₂ + OH⁻ —(t°)→ CH₃COO⁻ + Cu₂O↓ (đỏ gạch) + 3H₂O', 'Acetaldehyde khử Cu(OH)₂/OH⁻ đun nóng tạo kết tủa đỏ gạch Cu₂O↓', 'Acetaldehyde reduces Cu(OH)₂/OH⁻ (heat) → brick-red Cu₂O↓', 'Phản ứng đặc trưng nhóm –CHO tạo kết tủa đỏ gạch Cu₂O.', 'Aldehyde –CHO reduces alkaline Cu(OH)₂ on heating forming brick-red Cu₂O↓.', dCu2O);
    }
  }
  if ((moles.CH3CHO_l || 0) > 1e-9 && (moles.AgNH3_2_aq || 0) > 1e-7 && T >= 313.15 && orgMob > 0) {
    const dSilv = Math.min(moles.CH3CHO_l, moles.AgNH3_2_aq / 2) * (1 - Math.exp(-0.95 * dt));
    if (dSilv > 1e-11) {
      consumeSpecies('CH3CHO_l', dSilv);
      consumeSpecies('AgNH3_2_aq', 2 * dSilv);
      moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dSilv;
      moles.NH4_aq = (moles.NH4_aq || 0) + dSilv;
      moles.NH3_aq = (moles.NH3_aq || 0) + 3 * dSilv;
      moles.Ag_s = (moles.Ag_s || 0) + 2 * dSilv;
      vessel.silverMirrorFrac = Math.min(1, (vessel.silverMirrorFrac || 0) + 0.65);
      vessel.silverMirrorLevel = Math.min(1, (vessel.silverMirrorLevel || 0) + 0.65);
      heatJ += dSilv * 185000;
      pushRxn('ch3cho_tollens', 'CH₃CHO + 2[Ag(NH₃)₂]⁺ + OH⁻ —(t°)→ CH₃COO⁻ + 2Ag↓ (tráng gương) + 3NH₃ + H₂O', 'Phản ứng tráng bạc Tollens: Acetaldehyde tạo lớp gương Ag↓', 'Tollens silver mirror test: CH₃CHO + [Ag(NH₃)₂]⁺ → 2Ag↓', 'Acetaldehyde khử phức bạc amoniac tạo lớp bạc sáng bóng bám thành bình.', 'Acetaldehyde reduces Tollens reagent depositing a bright metallic silver mirror.', dSilv);
    }
  }
  const availI2Ac = (moles.I2_s || 0) + (moles.I2_aq || 0) + (moles.I3_aq || 0);
  if ((moles.CH3COCH3_l || 0) > 1e-9 && availI2Ac > 1e-7 && (moles.OH_aq || 0) > 1e-6 && orgMob > 0) {
    const dIodoAc = Math.min(moles.CH3COCH3_l, availI2Ac / 3, moles.OH_aq / 4) * (1 - Math.exp(-1.4 * dt));
    if (dIodoAc > 1e-11) {
      consumeSpecies('CH3COCH3_l', dIodoAc);
      let needIAc = 3 * dIodoAc;
      for (const ik of ['I2_s', 'I2_aq', 'I3_aq']) {
        const tk = Math.min(moles[ik] || 0, needIAc);
        if (tk > 0) {
          consumeSpecies(ik, tk);
          if (ik === 'I3_aq') moles.I_aq = (moles.I_aq || 0) + tk;
          needIAc -= tk;
        }
      }
      consumeSpecies('OH_aq', 4 * dIodoAc);
      moles.CHI3_s = (moles.CHI3_s || 0) + dIodoAc;
      moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dIodoAc;
      moles.I_aq = (moles.I_aq || 0) + 3 * dIodoAc;
      moles.H2O_l = (moles.H2O_l || 0) + 3 * dIodoAc;
      heatJ += dIodoAc * 125000;
      pushRxn('acetone_iodoform', 'CH₃COCH₃ + 3I₂ + 4OH⁻ → CHI₃↓ (vàng tươi) + CH₃COO⁻ + 3I⁻ + 3H₂O', 'Phản ứng Iodoform của Acetone tạo kết tủa vàng CHI₃↓', 'Acetone Iodoform test → bright yellow CHI₃↓', 'Nhóm methyl ketone CH₃CO– trong Acetone tạo ngay kết tủa vàng CHI₃↓ với I₂/NaOH.', 'Acetone rapidly yields bright yellow CHI₃ precipitate with I₂/NaOH.', dIodoAc);
    }
  }
  return heatJ;
}
