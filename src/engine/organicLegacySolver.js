/**
 * Classic Organic Chemistry Solver (Ethanol, Acetic Acid, Formic, Aldehydes, Lipids, Hydrocarbons).
 * Modularized from chemistry.js in Prompt 68.
 */
import { CONSTANTS } from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { computeSulfuricAcidState } from './chemistryHelpers.js';

/**
 * Ethanol (C2H5OH) & Glacial Acetic Acid (CH3COOH) organic reaction solver (Prompt 54):
 *  - Ethanol: Na/K (existing reactions.js), Mg+I2(boiling -> (C2H5O)2Mg↓+H2), KMnO4 (dry flash & aq -> CH3COO-/MnO2/Mn2+),
 *    K2Cr2O7/H+ (orange -> green Cr3+), HNO3 conc (-> CH3COOH + NO2), H2O2 (Fenton Fe2+/hot acid),
 *    H2SO4 conc (140 C -> diethyl ether; >=165 C -> C2H4↑), Br2 (warm -> CH3COOC2H5 + HBr), I2+NaOH (CHI3↓ yellow iodoform).
 *  - Acetic Acid: pKa 4.76, NaOH/NH3 neutralizations, Na/K (fast), Mg/Zn (slow cold dry -> fast hot/aq), Fe (boiling/warm aq), Al passive,
 *    CaCO3/CaC2 (slow anhydrous -> fast warm/aq), Esterification w/ EtOH (H2SO4, 60-80 C -> CH3COOC2H5),
 *    H2O2/H2SO4 -> CH3COOOH, prolonged boiling KMnO4/H2SO4 -> CO2↑.
 */
export function stepOrganicChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
  const moles = vessel.moles;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  const orgMob = vessel.isFrozenSolid ? 0 : 1;
  let heatJ = 0;

  const consumeSpecies = (id, amt) => {
    moles[id] = Math.max(0, (moles[id] || 0) - amt);
    if (moles[id] < 1e-13) delete moles[id];
  };
  const pushRxn = (id, equation, nameVi, nameEn, descVi, descEn, dXi, vigorousGas = false) => {
    activeReactions.push({ id, equation, nameVi, nameEn, descVi, descEn, rateMolS: dXi / dt, vigorousGas, dXi });
  };

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

  // ==================== PART 5: BENZENE, HALOGEN DERIVATIVES, & ALCOHOL/PHENOL PREPARATIONS ====================
  const uvOn = Boolean(options?.uvLight || vessel.uvExposureActive);

  // 5A. Benzene (C6H6_l) Reactions
  if ((moles.C6H6_l || 0) > 1e-10 && orgMob > 0) {
    const hasFeCat = (moles.Fe_s || 0) > 1e-8 || (moles.FeCl3_s || 0) > 1e-8 || (moles.FeBr3_s || 0) > 1e-8 || (moles.Fe3_aq || 0) > 1e-8 || (moles.Fe2_aq || 0) > 1e-8;
    const hsGas = vessel.headspaceGasMoles || {};
    const brSource = (moles.Br2_l || 0) > 1e-9 ? 'Br2_l' : (moles.Br2_g || 0) > 1e-9 ? 'Br2_g' : (hsGas.Br2_g || 0) > 1e-9 ? 'hs:Br2_g' : null;
    const clSource = (moles.Cl2_g || 0) > 1e-9 ? 'Cl2_g' : (hsGas.Cl2_g || 0) > 1e-9 ? 'hs:Cl2_g' : null;
    const getSrcAmt = (src) => (!src ? 0 : src.startsWith('hs:') ? (hsGas[src.slice(3)] || 0) : (moles[src] || 0));
    const consumeSrc = (src, amt) => {
      if (!src) return;
      if (src.startsWith('hs:')) {
        const k = src.slice(3);
        hsGas[k] = Math.max(0, (hsGas[k] || 0) - amt);
        if (hsGas[k] < 1e-13) delete hsGas[k];
      } else {
        consumeSpecies(src, amt);
      }
    };

    // 5A-1. Electrophilic Bromination / Chlorination (Fe / FeX3 catalyst, 40–60 °C, NO UV)
    if (hasFeCat && !uvOn && T >= 313.15) {
      if (brSource) {
        const dBzBr = Math.min(moles.C6H6_l, getSrcAmt(brSource)) * (1 - Math.exp(-0.85 * dt));
        if (dBzBr > 1e-11) {
          consumeSpecies('C6H6_l', dBzBr);
          consumeSrc(brSource, dBzBr);
          moles.C6H5Br_l = (moles.C6H5Br_l || 0) + dBzBr;
          if ((moles.H2O_l || 0) > 1e-4) {
            moles.H_aq = (moles.H_aq || 0) + dBzBr;
            moles.Br_aq = (moles.Br_aq || 0) + dBzBr;
          } else {
            gasProduced.HBr_g = (gasProduced.HBr_g || 0) + dBzBr;
          }
          heatJ += dBzBr * 45000;
          pushRxn('benzene_br2_fe', 'C₆H₆ + Br₂ —(Fe, 40–60 °C)→ C₆H₅Br + HBr↑', 'Brom hóa Benzene (xúc tác Fe, 40–60 °C) → Bromobenzene + HBr↑', 'Benzene bromination (Fe, 40–60 °C) → Bromobenzene + HBr↑', 'Xúc tác Fe/FeBr₃ phân cực Br₂ giúp thế H trên vòng Benzene tạo Bromobenzene và khí HBr.', 'Fe catalyst polarizes Br₂ for electrophilic substitution on Benzene yielding Bromobenzene and HBr.', dBzBr, true);
        }
      }
      if (clSource) {
        const dBzCl = Math.min(moles.C6H6_l, getSrcAmt(clSource)) * (1 - Math.exp(-0.92 * dt));
        if (dBzCl > 1e-11) {
          consumeSpecies('C6H6_l', dBzCl);
          consumeSrc(clSource, dBzCl);
          moles.C6H5Cl_l = (moles.C6H5Cl_l || 0) + dBzCl;
          if ((moles.H2O_l || 0) > 1e-4) {
            moles.H_aq = (moles.H_aq || 0) + dBzCl;
            moles.Cl_aq = (moles.Cl_aq || 0) + dBzCl;
          } else {
            gasProduced.HCl_g = (gasProduced.HCl_g || 0) + dBzCl;
          }
          heatJ += dBzCl * 115000;
          pushRxn('benzene_cl2_fe', 'C₆H₆ + Cl₂ —(Fe/FeCl₃, 40–60 °C)→ C₆H₅Cl + HCl↑', 'Clo hóa Benzene (xúc tác Fe/FeCl₃, 40–60 °C) → Chlorobenzene + HCl↑', 'Benzene chlorination (Fe/FeCl₃, 40–60 °C) → Chlorobenzene + HCl↑', 'Xúc tác FeCl₃ thế H trên vòng Benzene tạo Chlorobenzene và khí HCl.', 'FeCl₃-catalyzed chlorination of Benzene yields Chlorobenzene and HCl gas.', dBzCl, true);
        }
      }
    }

    // 5A-2. Radical UV Addition: C6H6 + 3Cl2 -> C6H6Cl6(s), C6H6 + 3Br2 -> C6H6Br6(s)
    if (uvOn && !hasFeCat) {
      if (clSource && moles[clSource] > 1e-9) {
        const dAddCl = Math.min(moles.C6H6_l, moles[clSource] / 3) * (1 - Math.exp(-0.65 * dt));
        if (dAddCl > 1e-11) {
          consumeSpecies('C6H6_l', dAddCl);
          consumeSpecies(clSource, 3 * dAddCl);
          moles.C6H6Cl6_s = (moles.C6H6Cl6_s || 0) + dAddCl;
          heatJ += dAddCl * 290000;
          pushRxn('benzene_cl2_uv', 'C₆H₆ + 3Cl₂ —(UV)→ C₆H₆Cl₆(s)', 'Cộng gốc tự do Cl₂ vào Benzene dưới tia UV → Hexachlorocyclohexane', 'Benzene + 3Cl₂ (UV) → Hexachlorocyclohexane C₆H₆Cl₆(s)', 'Dưới ánh sáng UV, Benzene cộng hợp với 3Cl₂ phá vỡ hệ thơm tạo tinh thể trắng C₆H₆Cl₆.', 'Under UV irradiation, Benzene undergoes radical addition with 3Cl₂ to form white C₆H₆Cl₆ crystals.', dAddCl);
        }
      }
      if (brSource && moles[brSource] > 1e-9) {
        const dAddBr = Math.min(moles.C6H6_l, moles[brSource] / 3) * (1 - Math.exp(-0.45 * dt));
        if (dAddBr > 1e-11) {
          consumeSpecies('C6H6_l', dAddBr);
          consumeSpecies(brSource, 3 * dAddBr);
          moles.C6H6Br6_s = (moles.C6H6Br6_s || 0) + dAddBr;
          heatJ += dAddBr * 220000;
          pushRxn('benzene_br2_uv', 'C₆H₆ + 3Br₂ —(UV)→ C₆H₆Br₆(s)', 'Cộng gốc tự do Br₂ vào Benzene dưới tia UV → Hexabromocyclohexane', 'Benzene + 3Br₂ (UV) → Hexabromocyclohexane C₆H₆Br₆(s)', 'Dưới tia UV không có xúc tác Fe, Benzene cộng 3Br₂ tạo tinh thể C₆H₆Br₆.', 'Under UV without Fe, Benzene adds 3Br₂ to form C₆H₆Br₆ crystals.', dAddBr);
        }
      }
    }

    // 5A-3. Nitration: C6H6 + HNO3 -(H2SO4 conc, 50–60 °C)-> C6H5NO2(l) + H2O
    const hasConcH2SO4 = (moles.H2SO4_l || 0) > 1e-6 || ((moles.HSO4_aq || 0) > 1e-4 && (moles.H_aq || 0) > 1e-4);
    const hasNitric = (moles.HNO3_l || 0) > 1e-8 || ((moles.NO3_aq || 0) > 1e-6 && (moles.H_aq || 0) > 1e-5);
    if (hasConcH2SO4 && hasNitric && T >= 323.15) {
      const nNit = (moles.HNO3_l || 0) > 1e-8 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
      const dNit = Math.min(moles.C6H6_l, nNit) * (1 - Math.exp(-0.78 * dt));
      if (dNit > 1e-11) {
        consumeSpecies('C6H6_l', dNit);
        if ((moles.HNO3_l || 0) >= dNit) consumeSpecies('HNO3_l', dNit);
        else { consumeSpecies('NO3_aq', dNit); consumeSpecies('H_aq', dNit); }
        moles.C6H5NO2_l = (moles.C6H5NO2_l || 0) + dNit;
        moles.H2O_l = (moles.H2O_l || 0) + dNit;
        heatJ += dNit * 117000;
        pushRxn('benzene_nitration', 'C₆H₆ + HNO₃ —(H₂SO₄ đặc, 50–60 °C)→ C₆H₅NO₂(l) + H₂O', 'Nitro hóa Benzene tạo Nitrobenzene (lỏng vàng nhạt, d = 1.20)', 'Benzene nitration (conc. H₂SO₄, 50–60 °C) → Nitrobenzene', 'Hỗn hợp HNO₃/H₂SO₄ đặc tạo tác nhân NO₂⁺ thế vào vòng Benzene sinh Nitrobenzene sánh vàng nhạt.', 'Mixed HNO₃/H₂SO₄ generates NO₂⁺ to nitrate Benzene into pale-yellow dense Nitrobenzene.', dNit);
      }
    }

    // 5A-4. Sulfonation: C6H6 + H2SO4(conc) -(80–100 °C)-> C6H5SO3H(aq) + H2O
    if ((moles.H2SO4_l || 0) > 1e-6 && !hasNitric && T >= 353.15) {
      const dSulf = Math.min(moles.C6H6_l, moles.H2SO4_l) * (1 - Math.exp(-0.55 * dt));
      if (dSulf > 1e-11) {
        consumeSpecies('C6H6_l', dSulf);
        consumeSpecies('H2SO4_l', dSulf);
        moles.C6H5SO3H_aq = (moles.C6H5SO3H_aq || 0) + dSulf;
        moles.H2O_l = (moles.H2O_l || 0) + dSulf;
        heatJ += dSulf * 62000;
        pushRxn('benzene_sulfonation', 'C₆H₆ + H₂SO₄(đặc) —(80–100 °C)→ C₆H₅SO₃H + H₂O', 'Sulfon hóa Benzene tạo Benzenesulfonic acid tan thành 1 pha đồng nhất', 'Benzene sulfonation (80–100 °C) → Benzenesulfonic acid', 'Đun Benzene với H₂SO₄ đặc 80–100 °C thu được Benzenesulfonic acid tan hoàn toàn trong pha nước.', 'Sulfonation of Benzene at 80–100 °C yields water-soluble Benzenesulfonic acid.', dSulf);
      }
    }

    // 5A-5. Friedel–Crafts Acylation & Alkylation (anhydrous AlCl3_s, T >= 298.15 K)
    if ((moles.AlCl3_s || 0) > 1e-8 && (moles.H2O_l || 0) < 0.02 && T >= 298.15) {
      if ((moles.CH3COCl_l || 0) > 1e-9) {
        const dFCac = Math.min(moles.C6H6_l, moles.CH3COCl_l) * (1 - Math.exp(-0.95 * dt));
        if (dFCac > 1e-11) {
          consumeSpecies('C6H6_l', dFCac);
          consumeSpecies('CH3COCl_l', dFCac);
          moles.C6H5COCH3_l = (moles.C6H5COCH3_l || 0) + dFCac;
          gasProduced.HCl_g = (gasProduced.HCl_g || 0) + dFCac;
          heatJ += dFCac * 88000;
          pushRxn('benzene_fc_acylation', 'C₆H₆ + CH₃COCl —(AlCl₃ khan)→ C₆H₅COCH₃ + HCl↑', 'Acyl hóa Friedel–Crafts tạo Acetophenone', 'Friedel–Crafts acylation → Acetophenone + HCl↑', 'Xúc tác AlCl₃ khan thực hiện phản ứng thế acyl vào Benzene tạo Acetophenone và khí HCl.', 'Anhydrous AlCl₃ catalyzes Friedel–Crafts acylation of Benzene to Acetophenone and HCl gas.', dFCac, true);
        }
      }
      if ((moles.C2H4_g || 0) > 1e-9) {
        const dFCet = Math.min(moles.C6H6_l, moles.C2H4_g) * (1 - Math.exp(-0.72 * dt));
        if (dFCet > 1e-11) {
          consumeSpecies('C6H6_l', dFCet);
          consumeSpecies('C2H4_g', dFCet);
          moles.C6H5C2H5_l = (moles.C6H5C2H5_l || 0) + dFCet;
          heatJ += dFCet * 105000;
          pushRxn('benzene_fc_ethylene', 'C₆H₆ + C₂H₄ —(AlCl₃)→ C₆H₅C₂H₅', 'Alkyl hóa Benzene với Ethylene → Ethylbenzene', 'Friedel–Crafts alkylation: Benzene + C₂H₄ → Ethylbenzene', 'AlCl₃ xúc tác cộng Ethylene vào vòng Benzene tạo Ethylbenzene.', 'AlCl₃-catalyzed alkylation of Benzene with Ethylene forms Ethylbenzene.', dFCet);
        }
      }
      const fcHalId = (moles.C2H5Cl_l || 0) > 1e-9 ? 'C2H5Cl_l' : (moles.C2H5Cl_g || 0) > 1e-9 ? 'C2H5Cl_g' : (moles.C2H5Br_l || 0) > 1e-9 ? 'C2H5Br_l' : null;
      if (fcHalId) {
        const dFChal = Math.min(moles.C6H6_l, moles[fcHalId]) * (1 - Math.exp(-0.82 * dt));
        if (dFChal > 1e-11) {
          consumeSpecies('C6H6_l', dFChal);
          consumeSpecies(fcHalId, dFChal);
          moles.C6H5C2H5_l = (moles.C6H5C2H5_l || 0) + dFChal;
          const hxGas = fcHalId === 'C2H5Br_l' ? 'HBr_g' : 'HCl_g';
          gasProduced[hxGas] = (gasProduced[hxGas] || 0) + dFChal;
          heatJ += dFChal * 78000;
          pushRxn('benzene_fc_alkyl', `C₆H₆ + ${fcHalId === 'C2H5Br_l' ? 'C₂H₅Br' : 'C₂H₅Cl'} —(AlCl₃)→ C₆H₅C₂H₅ + ${fcHalId === 'C2H5Br_l' ? 'HBr' : 'HCl'}↑`, 'Alkyl hóa Friedel–Crafts tạo Ethylbenzene', 'Friedel–Crafts alkylation → Ethylbenzene', 'Xúc tác AlCl₃ khan thế nhóm ethyl vào vòng Benzene giải phóng khí HX.', 'Anhydrous AlCl₃ catalyzes Friedel–Crafts alkylation to Ethylbenzene and HX gas.', dFChal, true);
        }
      }
    }

    // 5A-6. Hydrogenation: C6H6 + 3H2 -(Ni/Pt, 180 °C)-> C6H12(l)
    const hasHydCat = (moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8;
    if (hasHydCat && (moles.H2_g || 0) > 1e-9 && T >= 423.15) {
      const dHyd = Math.min(moles.C6H6_l, moles.H2_g / 3) * (1 - Math.exp(-0.65 * dt));
      if (dHyd > 1e-11) {
        consumeSpecies('C6H6_l', dHyd);
        consumeSpecies('H2_g', 3 * dHyd);
        moles.C6H12_l = (moles.C6H12_l || 0) + dHyd;
        heatJ += dHyd * 206000;
        pushRxn('benzene_hydrogenation', 'C₆H₆ + 3H₂ —(Ni/Pt, 180 °C)→ C₆H₁₂', 'Hydro hóa Benzene → Cyclohexane', 'Benzene hydrogenation (Ni/Pt, 180 °C) → Cyclohexane', 'Benzene cộng 3H₂ trên xúc tác Ni/Pt ở 180 °C tạo Cyclohexane.', 'Catalytic hydrogenation of Benzene over Ni/Pt at 180 °C yields Cyclohexane.', dHyd);
      }
    }

    // 5A-7. Fenton Hydroxylation (H2O2 + Fe2+, 50–70 °C) -> Phenol + H2O
    if ((moles.H2O2_aq || 0) > 1e-7 && (moles.Fe2_aq || 0) > 1e-8 && T >= 323.15 && T <= 363.15) {
      const dFen = Math.min(moles.C6H6_l, moles.H2O2_aq) * (1 - Math.exp(-0.48 * dt));
      if (dFen > 1e-11) {
        consumeSpecies('C6H6_l', dFen);
        consumeSpecies('H2O2_aq', dFen);
        moles.C6H5OH_l = (moles.C6H5OH_l || 0) + dFen;
        moles.H2O_l = (moles.H2O_l || 0) + dFen;
        heatJ += dFen * 195000;
        pushRxn('benzene_fenton', 'C₆H₆ + H₂O₂ —(Fe²⁺, 50–70 °C)→ C₆H₅OH + H₂O', 'Oxi hóa Fenton Benzene bằng H₂O₂/Fe²⁺ → Phenol', 'Fenton oxidation: Benzene + H₂O₂ (Fe²⁺) → Phenol', 'Gốc tự do •OH từ hệ Fenton (Fe²⁺ + H₂O₂) hydroxyl hóa trực tiếp Benzene thành Phenol.', 'Fenton reagent (H₂O₂/Fe²⁺) hydroxylates Benzene directly to Phenol.', dFen);
      }
    }

    // 5A-8. V2O5 Partial Oxidation (450 °C) & Pyrolysis to Biphenyl (650–800 °C) & Combustion
    if ((moles.V2O5_s || 0) > 1e-8 && (moles.O2_g || 0) > 1e-9 && T >= 700.0) {
      const dV2O5 = Math.min(moles.C6H6_l / 2, moles.O2_g / 9) * (1 - Math.exp(-0.55 * dt));
      if (dV2O5 > 1e-11) {
        consumeSpecies('C6H6_l', 2 * dV2O5);
        consumeSpecies('O2_g', 9 * dV2O5);
        moles.C4H2O3_s = (moles.C4H2O3_s || 0) + 2 * dV2O5;
        gasProduced.CO2_g = (gasProduced.CO2_g || 0) + 4 * dV2O5;
        gasProduced.H2O_g = (gasProduced.H2O_g || 0) + 4 * dV2O5;
        heatJ += dV2O5 * 3650000;
        pushRxn('benzene_v2o5_ox', '2C₆H₆ + 9O₂ —(V₂O₅, 450 °C)→ 2C₄H₂O₃ + 4CO₂↑ + 4H₂O↑', 'Oxi hóa xúc tác Benzene (V₂O₅, 450 °C) → Maleic anhydride', 'Benzene oxidation (V₂O₅, 450 °C) → Maleic anhydride', 'Oxi hóa chọn lọc Benzene trên xúc tác V₂O₅ ở 450 °C tạo Maleic anhydride.', 'Selective V₂O₅-catalyzed oxidation of Benzene at 450 °C yields Maleic anhydride.', dV2O5, true);
      }
    }
    if (T >= 923.15 && (moles.O2_g || 0) < 1e-6) {
      const dPyr = (moles.C6H6_l / 2) * (1 - Math.exp(-0.35 * dt));
      if (dPyr > 1e-11) {
        consumeSpecies('C6H6_l', 2 * dPyr);
        moles.C12H10_s = (moles.C12H10_s || 0) + dPyr;
        gasProduced.H2_g = (gasProduced.H2_g || 0) + dPyr;
        heatJ -= dPyr * 18000;
        pushRxn('benzene_pyrolysis', '2C₆H₆ —(650–800 °C)→ C₁₂H₁₀ + H₂↑', 'Nhiệt phân Benzene (650–800 °C) → Biphenyl + H₂↑', 'Benzene pyrolysis (650–800 °C) → Biphenyl + H₂↑', 'Nhiệt phân Benzene ở 650–800 °C ngưng tụ tạo Biphenyl và khí H₂.', 'High-temperature pyrolysis of Benzene yields Biphenyl and H₂ gas.', dPyr, true);
      }
    }
  }

  // 5A-9. Secondary nitration: C6H5NO2 + HNO3 -(H2SO4 conc, >= 90 °C)-> m-C6H4(NO2)2 + H2O
  if ((moles.C6H5NO2_l || 0) > 1e-9 && ((moles.H2SO4_l || 0) > 1e-6 || (moles.HSO4_aq || 0) > 1e-4) && ((moles.HNO3_l || 0) > 1e-8 || ((moles.NO3_aq || 0) > 1e-6 && (moles.H_aq || 0) > 1e-5)) && T >= 363.15) {
    const nNit2 = (moles.HNO3_l || 0) > 1e-8 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
    const dNit2 = Math.min(moles.C6H5NO2_l, nNit2) * (1 - Math.exp(-0.42 * dt));
    if (dNit2 > 1e-11) {
      consumeSpecies('C6H5NO2_l', dNit2);
      if ((moles.HNO3_l || 0) >= dNit2) consumeSpecies('HNO3_l', dNit2);
      else { consumeSpecies('NO3_aq', dNit2); consumeSpecies('H_aq', dNit2); }
      moles.C6H4_NO2_2_s = (moles.C6H4_NO2_2_s || 0) + dNit2;
      moles.H2O_l = (moles.H2O_l || 0) + dNit2;
      heatJ += dNit2 * 98000;
      pushRxn('nitrobenzene_dinitro', 'C₆H₅NO₂ + HNO₃ —(H₂SO₄ đặc, ≥ 90 °C)→ m-C₆H₄(NO₂)₂ + H₂O', 'Nitro hóa tiếp Nitrobenzene ở ≥ 90 °C → m-Dinitrobenzene', 'Nitrobenzene nitration (≥ 90 °C) → m-Dinitrobenzene', 'Nhóm –NO₂ định hướng thế meta tạo tinh thể vàng m-Dinitrobenzene khi đun ≥ 90 °C.', 'The meta-directing –NO₂ group yields m-Dinitrobenzene crystals at ≥ 90 °C.', dNit2);
    }
  }

  // 5B. Halogen Derivatives (C2H5Br, C2H5I, C2H5Cl, C6H5Br, C6H5Cl)
  if (orgMob > 0) {
    const alkylHalides = [
      { id: 'C2H5Br_l', gasId: 'C2H5Br_g', ion: 'Br_aq', label: 'C₂H₅Br', name: 'Bromoethane', kScale: 1.0 },
      { id: 'C2H5I_l', gasId: 'C2H5I_g', ion: 'I_aq', label: 'C₂H₅I', name: 'Iodoethane', kScale: 1.35 },
      { id: 'C2H5Cl_l', gasId: 'C2H5Cl_g', ion: 'Cl_aq', label: 'C₂H₅Cl', name: 'Chloroethane', kScale: 0.65 },
    ];
    const isAlcoholicKOH = (moles.C2H5OH_l || 0) > 0.01 && ((moles.H2O_l || 0) < 0.05 || (moles.C2H5OH_l || 0) > (moles.H2O_l || 0));
    const hsHal = vessel.headspaceGasMoles || {};

    for (const hx of alkylHalides) {
      const nLiqHx = moles[hx.id] || 0;
      const nGasHx = hsHal[hx.gasId] || 0;
      const nHx = nLiqHx + nGasHx;
      if (nHx <= 1e-10) continue;
      const consumeHx = (amt) => {
        const fromLiq = Math.min(moles[hx.id] || 0, amt);
        if (fromLiq > 0) consumeSpecies(hx.id, fromLiq);
        const rem = amt - fromLiq;
        if (rem > 1e-13 && hsHal[hx.gasId] > 0) {
          hsHal[hx.gasId] = Math.max(0, hsHal[hx.gasId] - rem);
          if (hsHal[hx.gasId] < 1e-13) delete hsHal[hx.gasId];
        }
      };

      // 5B-1. Zaitsev elimination in alcoholic KOH/NaOH (70–100 °C) vs Hydrolysis in aqueous NaOH/KOH (70–90 °C)
      if ((moles.OH_aq || 0) > 1e-6 && T >= 343.15) {
        if (isAlcoholicKOH) {
          const dElim = Math.min(nHx, moles.OH_aq) * (1 - Math.exp(-0.85 * hx.kScale * dt));
          if (dElim > 1e-11) {
            consumeHx(dElim);
            consumeSpecies('OH_aq', dElim);
            gasProduced.C2H4_g = (gasProduced.C2H4_g || 0) + dElim;
            moles[hx.ion] = (moles[hx.ion] || 0) + dElim;
            moles.H2O_l = (moles.H2O_l || 0) + dElim;
            heatJ += dElim * 36000;
            pushRxn(`rx_elim_${hx.id}`, `${hx.label} + OH⁻ —(C₂H₅OH, t°)→ C₂H₄↑ + ${hx.ion.replace('_aq', '⁻')} + H₂O`, `Tách HX ${hx.name} trong KOH/C₂H₅OH → Ethylene C₂H₄↑`, `Zaitsev elimination: ${hx.name} + OH⁻/EtOH → Ethylene C₂H₄↑`, 'Trong dung dịch kiềm/Ethanol đun nóng, dẫn xuất halogen tách HX tạo khí Ethylene.', 'In hot alcoholic alkali, ethyl halides undergo E2 elimination to Ethylene gas.', dElim, true);
          }
        } else if ((moles.H2O_l || 0) > 1e-4) {
          const dHydHx = Math.min(nHx, moles.OH_aq) * (1 - Math.exp(-0.72 * hx.kScale * dt));
          if (dHydHx > 1e-11) {
            consumeHx(dHydHx);
            consumeSpecies('OH_aq', dHydHx);
            moles.C2H5OH_l = (moles.C2H5OH_l || 0) + dHydHx;
            moles[hx.ion] = (moles[hx.ion] || 0) + dHydHx;
            heatJ += dHydHx * 42000;
            pushRxn(`rx_hyd_${hx.id}`, `${hx.label} + OH⁻ —(H₂O, 70–90 °C)→ C₂H₅OH + ${hx.ion.replace('_aq', '⁻')}`, `Thủy phân ${hx.name} trong NaOH/KOH loãng → Ethanol`, `Alkaline hydrolysis: ${hx.name} + OH⁻ → Ethanol`, 'Đun nóng dẫn xuất halogen với NaOH/KOH loãng thế –X bằng –OH tái tạo Ethanol.', 'Warm aqueous NaOH/KOH hydrolyzes ethyl halides back to Ethanol.', dHydHx);
          }
        }
      }

      // 5B-2. Williamson Ether Synthesis: C2H5O- + C2H5X -> (C2H5)2O + X-
      if ((moles.C2H5O_aq || 0) > 1e-7) {
        const dWill = Math.min(nHx, moles.C2H5O_aq) * (1 - Math.exp(-1.15 * hx.kScale * dt));
        if (dWill > 1e-11) {
          consumeSpecies(hx.id, dWill);
          consumeSpecies('C2H5O_aq', dWill);
          moles.C2H5OC2H5_l = (moles.C2H5OC2H5_l || 0) + dWill;
          moles[hx.ion] = (moles[hx.ion] || 0) + dWill;
          heatJ += dWill * 68000;
          pushRxn(`williamson_${hx.id}`, `C₂H₅O⁻ + ${hx.label} → (C₂H₅)₂O + ${hx.ion.replace('_aq', '⁻')}`, `Tổng hợp Williamson từ ${hx.name} → Diethyl ether`, `Williamson ether synthesis: C₂H₅O⁻ + ${hx.label} → Diethyl ether`, 'Ion ethoxide thế nucleophil vào dẫn xuất halogen tạo Diethyl ether.', 'Nucleophilic substitution by ethoxide yields Diethyl ether.', dWill);
        }
      }

      // 5B-3. Reaction with NH3 (T >= 323.15 K) -> C2H5NH2 + NH4+ + X-
      if ((moles.NH3_aq || 0) > 1e-6 && T >= 323.15) {
        const dAmn = Math.min(nHx, moles.NH3_aq / 2) * (1 - Math.exp(-0.55 * hx.kScale * dt));
        if (dAmn > 1e-11) {
          consumeSpecies(hx.id, dAmn);
          consumeSpecies('NH3_aq', 2 * dAmn);
          moles.C2H5NH2_aq = (moles.C2H5NH2_aq || 0) + dAmn;
          moles.NH4_aq = (moles.NH4_aq || 0) + dAmn;
          moles[hx.ion] = (moles[hx.ion] || 0) + dAmn;
          heatJ += dAmn * 54000;
          pushRxn(`rx_nh3_${hx.id}`, `${hx.label} + 2NH₃ —(t°)→ C₂H₅NH₂ + NH₄⁺ + ${hx.ion.replace('_aq', '⁻')}`, `${hx.name} phản ứng với NH₃ tạo Ethylamine`, `${hx.name} + 2NH₃ → Ethylamine + NH₄⁺`, 'NH₃ thế halogen tạo Ethylamine.', 'Ammonia substitutes halide to yield Ethylamine.', dAmn);
        }
      }

      // 5B-4. Carboxylate esterification: CH3COO- + C2H5X -> CH3COOC2H5 + X-
      if ((moles.CH3COO_aq || 0) > 1e-6 && T >= 333.15) {
        const dEst = Math.min(nHx, moles.CH3COO_aq) * (1 - Math.exp(-0.48 * hx.kScale * dt));
        if (dEst > 1e-11) {
          consumeSpecies(hx.id, dEst);
          consumeSpecies('CH3COO_aq', dEst);
          moles.CH3COOC2H5_l = (moles.CH3COOC2H5_l || 0) + dEst;
          moles[hx.ion] = (moles[hx.ion] || 0) + dEst;
          heatJ += dEst * 32000;
          pushRxn(`rx_ester_${hx.id}`, `CH₃COO⁻ + ${hx.label} —(t°)→ CH₃COOC₂H₅ + ${hx.ion.replace('_aq', '⁻')}`, `Tổng hợp Ethyl acetate từ ${hx.name} và muối Acetate`, `${hx.name} + CH₃COO⁻ → Ethyl acetate`, 'Ion acetate thế halogen tạo ester Ethyl acetate.', 'Acetate displaces halide yielding Ethyl acetate.', dEst);
        }
      }

      // 5B-5. Grignard (Mg in dry Et2O) & Wurtz (Na in dry Et2O) & Zn/H+ reduction
      if ((moles.C2H5OC2H5_l || 0) > 1e-4 && (moles.H2O_l || 0) < 0.005) {
        if ((moles.Mg_s || 0) > 1e-9 && hx.id === 'C2H5Br_l') {
          const dGrig = Math.min(nHx, moles.Mg_s) * (1 - Math.exp(-0.75 * dt));
          if (dGrig > 1e-11) {
            consumeSpecies('C2H5Br_l', dGrig);
            consumeSpecies('Mg_s', dGrig);
            moles.C2H5MgBr_l = (moles.C2H5MgBr_l || 0) + dGrig;
            heatJ += dGrig * 145000;
            pushRxn('grignard_etmgbr', 'C₂H₅Br + Mg —((C₂H₅)₂O khan)→ C₂H₅MgBr', 'Tổng hợp tác nhân Grignard C₂H₅MgBr trong Ether khan', 'Grignard reagent synthesis: C₂H₅Br + Mg → C₂H₅MgBr', 'Magnesium chèn vào liên kết C–Br trong Ether khan tạo Ethylmagnesium bromide.', 'Mg inserts into C–Br in anhydrous Diethyl ether to form Ethylmagnesium bromide.', dGrig);
          }
        }
        if ((moles.Na_s || 0) > 1e-9) {
          const dWurtz = Math.min(nHx / 2, moles.Na_s / 2) * (1 - Math.exp(-0.95 * hx.kScale * dt));
          if (dWurtz > 1e-11) {
            consumeSpecies(hx.id, 2 * dWurtz);
            consumeSpecies('Na_s', 2 * dWurtz);
            gasProduced.C4H10_g = (gasProduced.C4H10_g || 0) + dWurtz;
            moles.Na_aq = (moles.Na_aq || 0) + 2 * dWurtz;
            moles[hx.ion] = (moles[hx.ion] || 0) + 2 * dWurtz;
            heatJ += dWurtz * 320000;
            pushRxn(`wurtz_${hx.id}`, `2${hx.label} + 2Na —(Ether khan)→ C₄H₁₀↑ + 2Na⁺ + 2${hx.ion.replace('_aq', '⁻')}`, `Phản ứng Wurtz từ ${hx.name} + Na → Butane C₄H₁₀↑`, `Wurtz coupling: 2${hx.label} + 2Na → Butane C₄H₁₀↑`, 'Kim loại Na khử ghép 2 gốc ethyl trong Ether khan giải phóng khí Butane.', 'Sodium couples two ethyl halides in dry ether to evolve Butane gas.', dWurtz, true);
          }
        }
      }
      if ((moles.Zn_s || 0) > 1e-9 && ((moles.H_aq || 0) > 1e-5 || (moles.CH3COOH_l || 0) > 1e-5) && T >= 313.15) {
        const acidAvail = (moles.H_aq || 0) > 1e-5 ? moles.H_aq : moles.CH3COOH_l;
        const dRedHx = Math.min(nHx, moles.Zn_s, acidAvail) * (1 - Math.exp(-0.62 * hx.kScale * dt));
        if (dRedHx > 1e-11) {
          consumeSpecies(hx.id, dRedHx);
          consumeSpecies('Zn_s', dRedHx);
          if ((moles.H_aq || 0) >= dRedHx) consumeSpecies('H_aq', dRedHx);
          else { consumeSpecies('CH3COOH_l', dRedHx); moles.CH3COO_aq = (moles.CH3COO_aq || 0) + dRedHx; }
          gasProduced.C2H6_g = (gasProduced.C2H6_g || 0) + dRedHx;
          moles.Zn2_aq = (moles.Zn2_aq || 0) + dRedHx;
          moles[hx.ion] = (moles[hx.ion] || 0) + dRedHx;
          heatJ += dRedHx * 110000;
          pushRxn(`rx_red_zn_${hx.id}`, `${hx.label} + Zn + H⁺ → C₂H₆↑ + Zn²⁺ + ${hx.ion.replace('_aq', '⁻')}`, `Khử ${hx.name} bằng Zn/acid → Ethane C₂H₆↑`, `Reduction: ${hx.name} + Zn/H⁺ → Ethane C₂H₆↑`, 'Zn khử dẫn xuất halogen trong môi trường acid giải phóng khí Ethane.', 'Zn in acid reduces ethyl halides to Ethane gas.', dRedHx, true);
        }
      }
    }

    // Grignard hydrolysis: C2H5MgBr + H2O -> C2H6↑ + Mg2+ + OH- + Br-
    if ((moles.C2H5MgBr_l || 0) > 1e-9 && (moles.H2O_l || 0) > 1e-5) {
      const dGrigHyd = Math.min(moles.C2H5MgBr_l, moles.H2O_l) * (1 - Math.exp(-2.8 * dt));
      if (dGrigHyd > 1e-11) {
        consumeSpecies('C2H5MgBr_l', dGrigHyd);
        consumeSpecies('H2O_l', dGrigHyd);
        gasProduced.C2H6_g = (gasProduced.C2H6_g || 0) + dGrigHyd;
        moles.Mg2_aq = (moles.Mg2_aq || 0) + dGrigHyd;
        moles.OH_aq = (moles.OH_aq || 0) + dGrigHyd;
        moles.Br_aq = (moles.Br_aq || 0) + dGrigHyd;
        heatJ += dGrigHyd * 185000;
        pushRxn('grignard_hydrolysis', 'C₂H₅MgBr + H₂O → C₂H₆↑ + Mg²⁺ + OH⁻ + Br⁻', 'Thủy phân tác nhân Grignard C₂H₅MgBr → Ethane C₂H₆↑', 'Grignard hydrolysis → Ethane C₂H₆↑', 'Nước thủy phân mãnh liệt C₂H₅MgBr giải phóng khí Ethane.', 'Water vigorously hydrolyzes Ethylmagnesium bromide to Ethane gas.', dGrigHyd, true);
      }
    }

    // Aryl halide Dow hydrolysis ONLY at extreme T >= 573.15 K (300 °C)
    if ((moles.C6H5Cl_l || 0) > 1e-9 && (moles.OH_aq || 0) > 1e-6 && T >= 573.15) {
      const dDow = Math.min(moles.C6H5Cl_l, moles.OH_aq / 2) * (1 - Math.exp(-0.55 * dt));
      if (dDow > 1e-11) {
        consumeSpecies('C6H5Cl_l', dDow);
        consumeSpecies('OH_aq', 2 * dDow);
        moles.C6H5O_aq = (moles.C6H5O_aq || 0) + dDow;
        moles.Cl_aq = (moles.Cl_aq || 0) + dDow;
        moles.H2O_l = (moles.H2O_l || 0) + dDow;
        heatJ += dDow * 75000;
        pushRxn('dow_chlorobenzene', 'C₆H₅Cl + 2OH⁻ —(≥ 300 °C)→ C₆H₅O⁻ + Cl⁻ + H₂O', 'Thủy phân Chlorobenzene ở ≥ 300 °C → Phenoxide', 'Dow hydrolysis: Chlorobenzene + 2OH⁻ (≥ 300 °C) → Phenoxide', 'Aryl halide trơ ở ≤ 100 °C, chỉ thủy phân trong kiềm đặc ở ≥ 300 °C.', 'Aryl halides are inert ≤ 100 °C and only hydrolyze in alkali at ≥ 300 °C.', dDow);
      }
    }

    // 5C. Preparations of Halogen Derivatives & Alcohols / Phenol
    // 5C-1. 3C2H5OH + P_red + 1.5Br2 -> 3C2H5Br + H3PO3 (50-70 °C)
    const brPrep = (moles.Br2_l || 0) > 1e-9 ? 'Br2_l' : (moles.Br2_g || 0) > 1e-9 ? 'Br2_g' : null;
    if ((moles.C2H5OH_l || 0) > 1e-8 && (moles.P_red_s || 0) > 1e-8 && brPrep && T >= 323.15) {
      const dPrepBr = Math.min(moles.C2H5OH_l / 3, moles.P_red_s, moles[brPrep] / 1.5) * (1 - Math.exp(-0.75 * dt));
      if (dPrepBr > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dPrepBr);
        consumeSpecies('P_red_s', dPrepBr);
        consumeSpecies(brPrep, 1.5 * dPrepBr);
        moles.C2H5Br_l = (moles.C2H5Br_l || 0) + 3 * dPrepBr;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dPrepBr;
        heatJ += dPrepBr * 240000;
        pushRxn('prep_c2h5br_p_br2', '3C₂H₅OH + P(đỏ) + 1.5Br₂ —(50–70 °C)→ 3C₂H₅Br + H₃PO₃', 'Điều chế Bromoethane từ Ethanol + P(đỏ) + Br₂', 'Preparation of Bromoethane: EtOH + P(red) + Br₂', 'P đỏ và Br₂ tạo PBr₃ tại chỗ thế –OH Ethanol thành Bromoethane.', 'Red phosphorus + Br₂ converts Ethanol to Bromoethane in situ.', dPrepBr);
      }
    }
    // 5C-2. 3C2H5OH + P_red + 1.5I2 -> 3C2H5I + H3PO3 (70-80 °C)
    if ((moles.C2H5OH_l || 0) > 1e-8 && (moles.P_red_s || 0) > 1e-8 && (moles.I2_s || 0) > 1e-8 && T >= 343.15) {
      const dPrepI = Math.min(moles.C2H5OH_l / 3, moles.P_red_s, moles.I2_s / 1.5) * (1 - Math.exp(-0.68 * dt));
      if (dPrepI > 1e-11) {
        consumeSpecies('C2H5OH_l', 3 * dPrepI);
        consumeSpecies('P_red_s', dPrepI);
        consumeSpecies('I2_s', 1.5 * dPrepI);
        moles.C2H5I_l = (moles.C2H5I_l || 0) + 3 * dPrepI;
        moles.H3PO3_aq = (moles.H3PO3_aq || 0) + dPrepI;
        heatJ += dPrepI * 185000;
        pushRxn('prep_c2h5i_p_i2', '3C₂H₅OH + P(đỏ) + 1.5I₂ —(70–80 °C)→ 3C₂H₅I + H₃PO₃', 'Điều chế Iodoethane từ Ethanol + P(đỏ) + I₂', 'Preparation of Iodoethane: EtOH + P(red) + I₂', 'P đỏ và I₂ thế nhóm –OH của Ethanol ở 70–80 °C tạo Iodoethane.', 'Red phosphorus + I₂ converts Ethanol to Iodoethane at 70–80 °C.', dPrepI);
      }
    }
    // 5C-3. C2H5OH + HCl(conc) -(ZnCl2/Zn2+, 70-85 °C)-> C2H5Cl + H2O
    if ((moles.C2H5OH_l || 0) > 1e-8 && (moles.H_aq || 0) > 1e-4 && (moles.Cl_aq || 0) > 1e-4 && ((moles.Zn2_aq || 0) > 1e-7 || (moles.ZnCl2_s || 0) > 1e-7) && T >= 343.15) {
      const dPrepCl = Math.min(moles.C2H5OH_l, moles.H_aq, moles.Cl_aq) * (1 - Math.exp(-0.62 * dt));
      if (dPrepCl > 1e-11) {
        consumeSpecies('C2H5OH_l', dPrepCl);
        consumeSpecies('H_aq', dPrepCl);
        consumeSpecies('Cl_aq', dPrepCl);
        gasProduced.C2H5Cl_g = (gasProduced.C2H5Cl_g || 0) + dPrepCl;
        moles.H2O_l = (moles.H2O_l || 0) + dPrepCl;
        heatJ += dPrepCl * 28000;
        pushRxn('prep_c2h5cl_zncl2', 'C₂H₅OH + HCl(đặc) —(ZnCl₂, 70–85 °C)→ C₂H₅Cl↑ + H₂O', 'Điều chế Chloroethane từ Ethanol + HCl đặc (xúc tác ZnCl₂)', 'Preparation of Chloroethane: EtOH + HCl (ZnCl₂)', 'ZnCl₂ khan xúc tác thế –OH bằng Cl⁻ giải phóng khí Chloroethane (ngưng tụ < 12.3 °C).', 'ZnCl₂ catalyzes HCl substitution on Ethanol to evolve Chloroethane.', dPrepCl, true);
      }
    }

    // 5C-4. Alkene/Alkyne + Br2: C2H4 + Br2 -> C2H4Br2; C2H2 + 2Br2 -> C2H2Br4
    const brAdd = (moles.Br2_l || 0) > 1e-9 ? 'Br2_l' : (moles.Br2_aq || 0) > 1e-9 ? 'Br2_aq' : (moles.Br2_g || 0) > 1e-9 ? 'Br2_g' : null;
    if ((moles.C2H4_g || 0) > 1e-9 && brAdd) {
      const dC2H4Br = Math.min(moles.C2H4_g, moles[brAdd]) * (1 - Math.exp(-2.2 * dt));
      if (dC2H4Br > 1e-11) {
        consumeSpecies('C2H4_g', dC2H4Br);
        consumeSpecies(brAdd, dC2H4Br);
        moles.C2H4Br2_l = (moles.C2H4Br2_l || 0) + dC2H4Br;
        heatJ += dC2H4Br * 122000;
        pushRxn('c2h4_br2_add', 'C₂H₄ + Br₂ → BrCH₂–CH₂Br(l)', 'Cộng Br₂ vào Ethylene → 1,2-Dibromoethane (d = 2.18)', 'Ethylene + Br₂ → 1,2-Dibromoethane', 'Ethylene làm mất màu dung dịch Bromine tạo 1,2-Dibromoethane nặng chìm xuống đáy.', 'Ethylene decolorizes Bromine forming dense 1,2-Dibromoethane.', dC2H4Br);
      }
    }
    if ((moles.C2H2_g || 0) > 1e-9 && brAdd) {
      const dC2H2Br = Math.min(moles.C2H2_g, moles[brAdd] / 2) * (1 - Math.exp(-1.9 * dt));
      if (dC2H2Br > 1e-11) {
        consumeSpecies('C2H2_g', dC2H2Br);
        consumeSpecies(brAdd, 2 * dC2H2Br);
        moles.C2H2Br4_l = (moles.C2H2Br4_l || 0) + dC2H2Br;
        heatJ += dC2H2Br * 235000;
        pushRxn('c2h2_br2_add', 'C₂H₂ + 2Br₂ → Br₂CH–CHBr₂(l)', 'Cộng 2Br₂ vào Acetylene → 1,1,2,2-Tetrabromoethane', 'Acetylene + 2Br₂ → 1,1,2,2-Tetrabromoethane', 'Acetylene cộng 2 phân tử Br₂ tạo 1,1,2,2-Tetrabromoethane (d = 2.97).', 'Acetylene adds 2 equivalents of Br₂ to form 1,1,2,2-Tetrabromoethane.', dC2H2Br);
      }
    }

    // 5C-5. Wagner oxidation: 3C2H4 + 2KMnO4 + 4H2O -(0–15 °C, cold dil)-> 3C2H4(OH)2 + 2MnO2↓ + 2KOH
    if ((moles.C2H4_g || 0) > 1e-9 && (moles.MnO4_aq || 0) > 1e-7 && (moles.H2O_l || 0) > 1e-4 && T <= 293.15) {
      const dWag = Math.min(moles.C2H4_g / 3, moles.MnO4_aq / 2, moles.H2O_l / 4) * (1 - Math.exp(-1.4 * dt));
      if (dWag > 1e-11) {
        consumeSpecies('C2H4_g', 3 * dWag);
        consumeSpecies('MnO4_aq', 2 * dWag);
        consumeSpecies('H2O_l', 4 * dWag);
        moles.C2H4OH_2_l = (moles.C2H4OH_2_l || 0) + 3 * dWag;
        moles.MnO2_s = (moles.MnO2_s || 0) + 2 * dWag;
        moles.OH_aq = (moles.OH_aq || 0) + 2 * dWag;
        heatJ += dWag * 410000;
        pushRxn('wagner_glycol', '3C₂H₄ + 2MnO₄⁻ + 4H₂O —(0–15 °C)→ 3C₂H₄(OH)₂ + 2MnO₂↓ + 2OH⁻', 'Phản ứng Wagner: Ethylene + KMnO₄ lạnh → Ethylene glycol + MnO₂↓', 'Wagner oxidation: 3C₂H₄ + 2KMnO₄ + 4H₂O → 3 Ethylene glycol + 2MnO₂↓', 'KMnO₄ loãng lạnh oxi hóa Ethylene thành Ethylene glycol và kết tủa nâu đen MnO₂.', 'Cold dilute KMnO₄ oxidizes Ethylene to Ethylene glycol and brown-black MnO₂ precipitate.', dWag);
      }
    }

    // 5C-6. Allyl alcohol: CH2=CHCHO + Zn + 2CH3COOH -(50–70 °C)-> CH2=CHCH2OH + Zn2+ + 2CH3COO-
    if ((moles.CH2CHCHO_l || 0) > 1e-9 && (moles.Zn_s || 0) > 1e-9 && (moles.CH3COOH_l || 0) > 1e-8 && T >= 323.15) {
      const dAllyl = Math.min(moles.CH2CHCHO_l, moles.Zn_s, moles.CH3COOH_l / 2) * (1 - Math.exp(-0.75 * dt));
      if (dAllyl > 1e-11) {
        consumeSpecies('CH2CHCHO_l', dAllyl);
        consumeSpecies('Zn_s', dAllyl);
        consumeSpecies('CH3COOH_l', 2 * dAllyl);
        moles.CH2CHCH2OH_l = (moles.CH2CHCH2OH_l || 0) + dAllyl;
        moles.Zn2_aq = (moles.Zn2_aq || 0) + dAllyl;
        moles.CH3COO_aq = (moles.CH3COO_aq || 0) + 2 * dAllyl;
        heatJ += dAllyl * 115000;
        pushRxn('prep_allyl_alcohol', 'CH₂=CHCHO + Zn + 2CH₃COOH —(50–70 °C)→ CH₂=CHCH₂OH + Zn(CH₃COO)₂', 'Khử Acrolein bằng Zn/CH₃COOH → Allyl alcohol', 'Acrolein reduction (Zn/CH₃COOH) → Allyl alcohol', 'Hệ Zn + CH₃COOH khử chọn lọc nhóm –CHO của Acrolein thành Allyl alcohol.', 'Zn/CH₃COOH selectively reduces Acrolein to Allyl alcohol.', dAllyl);
      }
    }

    // 5C-7. Butan-1-ol via Aldol-Crotonaldehyde: 2CH3CHO -> CH3CH=CHCHO + H2O; CH3CH=CHCHO + 2Zn + 4H+ -> C4H9OH + 2Zn2+
    if ((moles.CH3CHO_l || 0) > 1e-8 && (moles.OH_aq || 0) > 1e-6 && T >= 343.15) {
      const dAldol = (moles.CH3CHO_l / 2) * (1 - Math.exp(-0.55 * dt));
      if (dAldol > 1e-11) {
        consumeSpecies('CH3CHO_l', 2 * dAldol);
        moles.CH3CHCHCHO_l = (moles.CH3CHCHCHO_l || 0) + dAldol;
        moles.H2O_l = (moles.H2O_l || 0) + dAldol;
        heatJ += dAldol * 42000;
        pushRxn('aldol_crotonaldehyde', '2CH₃CHO —(NaOH loãng, t°)→ CH₃CH=CHCHO + H₂O', 'Ngưng tụ Aldol Acetaldehyde → Crotonaldehyde', 'Aldol condensation: 2CH₃CHO → Crotonaldehyde + H₂O', 'Acetaldehyde ngưng tụ và tách nước trong kiềm tạo Crotonaldehyde.', 'Base-catalyzed aldol condensation of Acetaldehyde yields Crotonaldehyde.', dAldol);
      }
    }
    if ((moles.CH3CHCHCHO_l || 0) > 1e-9 && (moles.Zn_s || 0) > 1e-9 && (moles.H_aq || 0) > 1e-5 && T >= 333.15) {
      const dBut = Math.min(moles.CH3CHCHCHO_l, moles.Zn_s / 2, moles.H_aq / 4) * (1 - Math.exp(-0.68 * dt));
      if (dBut > 1e-11) {
        consumeSpecies('CH3CHCHCHO_l', dBut);
        consumeSpecies('Zn_s', 2 * dBut);
        consumeSpecies('H_aq', 4 * dBut);
        moles.C4H9OH_l = (moles.C4H9OH_l || 0) + dBut;
        moles.Zn2_aq = (moles.Zn2_aq || 0) + 2 * dBut;
        heatJ += dBut * 210000;
        pushRxn('prep_butanol', 'CH₃CH=CHCHO + 2Zn + 4H⁺ —(60–80 °C)→ C₄H₉OH + 2Zn²⁺', 'Khử Crotonaldehyde → Butan-1-ol', 'Reduction of Crotonaldehyde → Butan-1-ol', 'Khử hoàn toàn Crotonaldehyde bằng Zn/H⁺ thu được Butan-1-ol.', 'Complete reduction of Crotonaldehyde yields Butan-1-ol.', dBut);
      }
    }

    // 5C-8. Ethyl acetate alkaline saponification is handled by unified Arrhenius + RK2 stepEsterAndLipidKinetics below (Part 7E).

    // 5D. Phenol (C6H5OH_l / C6H5OH_s) Reactions
    const phSrc = (moles.C6H5OH_l || 0) > 1e-9 ? 'C6H5OH_l' : (moles.C6H5OH_s || 0) > 1e-9 ? 'C6H5OH_s' : null;
    if (phSrc) {
      if ((moles.OH_aq || 0) > 1e-6) {
        const dPhOH = Math.min(moles[phSrc], moles.OH_aq) * (1 - Math.exp(-2.8 * dt));
        if (dPhOH > 1e-11) {
          consumeSpecies(phSrc, dPhOH);
          consumeSpecies('OH_aq', dPhOH);
          moles.C6H5O_aq = (moles.C6H5O_aq || 0) + dPhOH;
          moles.H2O_l = (moles.H2O_l || 0) + dPhOH;
          heatJ += dPhOH * 32000;
          pushRxn('phenol_naoh', 'C₆H₅OH + OH⁻ → C₆H₅O⁻ + H₂O', 'Phenol tan trong dung dịch kiềm tạo Phenoxide', 'Phenol + OH⁻ → Phenoxide + H₂O', 'Tính acid yếu của Phenol giúp tan hoàn toàn trong NaOH tạo muối Phenoxide.', 'Weakly acidic Phenol dissolves in NaOH forming soluble Phenoxide.', dPhOH);
        }
      }
      if ((moles.Na_s || 0) > 1e-9) {
        const dPhNa = Math.min(moles[phSrc], moles.Na_s) * (1 - Math.exp(-2.2 * dt));
        if (dPhNa > 1e-11) {
          consumeSpecies(phSrc, dPhNa);
          consumeSpecies('Na_s', dPhNa);
          moles.C6H5O_aq = (moles.C6H5O_aq || 0) + dPhNa;
          moles.Na_aq = (moles.Na_aq || 0) + dPhNa;
          gasProduced.H2_g = (gasProduced.H2_g || 0) + 0.5 * dPhNa;
          heatJ += dPhNa * 155000;
          pushRxn('phenol_na', 'C₆H₅OH + Na → C₆H₅ONa + ½H₂↑', 'Phenol tác dụng với Na giải phóng H₂↑', 'Phenol + Na → Sodium phenoxide + ½H₂↑', 'Kim loại Na khử H linh động của Phenol giải phóng khí H₂.', 'Sodium reacts with Phenol evolving H₂ gas.', dPhNa, true);
        }
      }
      const brPh = (moles.Br2_aq || 0) > 1e-8 ? 'Br2_aq' : ((moles.Br2_l || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-4) ? 'Br2_l' : null;
      if (brPh) {
        const dPhBr = Math.min(moles[phSrc], moles[brPh] / 3) * (1 - Math.exp(-3.4 * dt));
        if (dPhBr > 1e-11) {
          consumeSpecies(phSrc, dPhBr);
          consumeSpecies(brPh, 3 * dPhBr);
          moles.C6H2Br3OH_s = (moles.C6H2Br3OH_s || 0) + dPhBr;
          moles.H_aq = (moles.H_aq || 0) + 3 * dPhBr;
          moles.Br_aq = (moles.Br_aq || 0) + 3 * dPhBr;
          heatJ += dPhBr * 165000;
          pushRxn('phenol_br2_white_ppt', 'C₆H₅OH + 3Br₂(aq) → C₆H₂Br₃OH↓ (trắng) + 3HBr', 'Phenol + nước Bromine → kết tủa trắng 2,4,6-Tribromophenol', 'Phenol + 3Br₂(aq) → white 2,4,6-Tribromophenol↓ + 3HBr', 'Phản ứng đặc trưng nhận biết Phenol tạo ngay kết tủa trắng 2,4,6-Tribromophenol.', 'Characteristic Phenol test immediately yields white 2,4,6-Tribromophenol precipitate.', dPhBr);
        }
      }

      // 5D-2. Picric acid (2,4,6-Trinitrophenol): C6H5OH + 3HNO3(conc) -(H2SO4 conc, >= 353.15 K)-> C6H2(NO2)3OH↓ + 3H2O
      const hasPicAcid = (moles.H2SO4_l || 0) > 1e-6 || (moles.HSO4_aq || 0) > 1e-4;
      const hasPicNit = (moles.HNO3_l || 0) > 1e-7 || ((moles.NO3_aq || 0) > 1e-5 && (moles.H_aq || 0) > 1e-5);
      if (hasPicAcid && hasPicNit && T >= 353.15) {
        const nNitP = (moles.HNO3_l || 0) > 1e-7 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
        const dPic = Math.min(moles[phSrc], nNitP / 3) * (1 - Math.exp(-0.72 * dt));
        if (dPic > 1e-11) {
          consumeSpecies(phSrc, dPic);
          if ((moles.HNO3_l || 0) >= 3 * dPic) consumeSpecies('HNO3_l', 3 * dPic);
          else { consumeSpecies('NO3_aq', 3 * dPic); consumeSpecies('H_aq', 3 * dPic); }
          moles.C6H2_NO2_3OH_s = (moles.C6H2_NO2_3OH_s || 0) + dPic;
          moles.H2O_l = (moles.H2O_l || 0) + 3 * dPic;
          heatJ += dPic * 240000;
          pushRxn('phenol_picric_acid', 'C₆H₅OH + 3HNO₃(đặc) —(H₂SO₄ đặc, 95 °C)→ C₆H₂(NO₂)₃OH↓ + 3H₂O', 'Nitro hóa Phenol → tinh thể vàng Picric acid', 'Phenol nitration → Picric acid C₆H₂(NO₂)₃OH↓', 'Phenol phản ứng với HNO₃ đặc/H₂SO₄ đặc tạo tinh thể vàng tươi 2,4,6-Trinitrophenol (Picric acid).', 'Nitration of Phenol in conc. H₂SO₄/HNO₃ precipitates bright yellow Picric acid.', dPic);
        }
      }

      // 5D-3. Catechol / Hydroquinone: C6H5OH + H2O2 -(Fe2+ or H3PO4, 50–70 °C)-> C6H4(OH)2 + H2O
      if ((moles.H2O2_aq || 0) > 1e-7 && ((moles.Fe2_aq || 0) > 1e-8 || (moles.H3PO4_aq || 0) > 1e-6) && T >= 323.15 && T <= 363.15) {
        const dCat = Math.min(moles[phSrc], moles.H2O2_aq) * (1 - Math.exp(-0.58 * dt));
        if (dCat > 1e-11) {
          consumeSpecies(phSrc, dCat);
          consumeSpecies('H2O2_aq', dCat);
          moles.C6H4OH_2_s = (moles.C6H4OH_2_s || 0) + dCat;
          moles.H2O_l = (moles.H2O_l || 0) + dCat;
          heatJ += dCat * 165000;
          pushRxn('phenol_catechol', 'C₆H₅OH + H₂O₂ —(Fe²⁺/H₃PO₄, 60 °C)→ C₆H₄(OH)₂ + H₂O', 'Hydroxyl hóa Phenol → Catechol & Hydroquinone', 'Phenol hydroxylation → Catechol / Hydroquinone', 'H₂O₂ có xúc tác Fe²⁺ hoặc H₃PO₄ gắn thêm –OH tạo đồng phân o/p-Dihydroxybenzene.', 'Catalytic H₂O₂ hydroxylation of Phenol yields Catechol and Hydroquinone.', dCat);
        }
      }
    }

    // ==================== PART 6: CARBOXYLIC ACID & ARENE (TOLUENE / ETHYLBENZENE) CHEMISTRY ====================
    // 6A. Phenol regeneration from Phenoxide (H+ or CO2 + H2O) & Benzenesulfonate alkali fusion
    if ((moles.C6H5O_aq || 0) > 1e-9) {
      if ((moles.H_aq || 0) > 1e-6) {
        const dReg = Math.min(moles.C6H5O_aq, moles.H_aq) * (1 - Math.exp(-3.5 * dt));
        if (dReg > 1e-11) {
          consumeSpecies('C6H5O_aq', dReg);
          consumeSpecies('H_aq', dReg);
          moles.C6H5OH_l = (moles.C6H5OH_l || 0) + dReg;
          heatJ += dReg * 28000;
          pushRxn('phenoxide_acidify', 'C₆H₅O⁻ + H⁺ → C₆H₅OH', 'Acid hóa Phenoxide tái tạo Phenol', 'Acidification of Phenoxide → Phenol', 'Acid mạnh đẩy Phenol ra khỏi muối Phenoxide.', 'Strong acid regenerates Phenol from Phenoxide.', dReg);
        }
      } else if (((moles.H2CO3_aq || 0) > 1e-8 || (moles.CO2_aq || 0) > 1e-8 || (moles.CO2_g || 0) > 1e-8 || (vessel.headspaceGasMoles?.CO2_g || 0) > 1e-8) && (moles.H2O_l || 0) > 1e-4) {
        const hsCo2 = vessel.headspaceGasMoles || {};
        const co2Src = (moles.H2CO3_aq || 0) > 1e-8 ? 'H2CO3_aq' : (moles.CO2_aq || 0) > 1e-8 ? 'CO2_aq' : (moles.CO2_g || 0) > 1e-8 ? 'CO2_g' : 'hs:CO2_g';
        const nCo2Avail = co2Src === 'hs:CO2_g' ? (hsCo2.CO2_g || 0) : (moles[co2Src] || 0);
        const dCo2Ph = Math.min(moles.C6H5O_aq, nCo2Avail, moles.H2O_l) * (1 - Math.exp(-1.6 * dt));
        if (dCo2Ph > 1e-11) {
          consumeSpecies('C6H5O_aq', dCo2Ph);
          if (co2Src === 'hs:CO2_g') { hsCo2.CO2_g = Math.max(0, hsCo2.CO2_g - dCo2Ph); if (hsCo2.CO2_g < 1e-13) delete hsCo2.CO2_g; }
          else consumeSpecies(co2Src, dCo2Ph);
          if (co2Src !== 'H2CO3_aq') consumeSpecies('H2O_l', dCo2Ph);
          moles.C6H5OH_l = (moles.C6H5OH_l || 0) + dCo2Ph;
          moles.HCO3_aq = (moles.HCO3_aq || 0) + dCo2Ph;
          heatJ += dCo2Ph * 22000;
          pushRxn('phenoxide_co2', 'C₆H₅O⁻ + CO₂ + H₂O → C₆H₅OH + HCO₃⁻', 'Sục CO₂ vào Phenoxide tái tạo Phenol (đục nhẹ)', 'CO₂ + Phenoxide + H₂O → Phenol + HCO₃⁻', 'H₂CO₃ mạnh hơn Phenol nên đẩy được Phenol tự do ra khỏi muối Phenoxide.', 'Carbonic acid displaces weaker Phenol from Phenoxide solution.', dCo2Ph);
        }
      }
    }
    if ((moles.C6H5SO3H_aq || 0) > 1e-9 && (moles.OH_aq || 0) > 1e-6) {
      const dBsa = Math.min(moles.C6H5SO3H_aq, moles.OH_aq) * (1 - Math.exp(-3.2 * dt));
      if (dBsa > 1e-11) {
        consumeSpecies('C6H5SO3H_aq', dBsa);
        consumeSpecies('OH_aq', dBsa);
        moles.C6H5SO3_aq = (moles.C6H5SO3_aq || 0) + dBsa;
        moles.H2O_l = (moles.H2O_l || 0) + dBsa;
        heatJ += dBsa * 55000;
        pushRxn('bsa_neutralize', 'C₆H₅SO₃H + OH⁻ → C₆H₅SO₃⁻ + H₂O', 'Trung hòa Benzenesulfonic acid', 'Neutralization of Benzenesulfonic acid', 'Benzenesulfonic acid phản ứng nhanh với NaOH tạo muối Benzenesulfonate.', 'Benzenesulfonic acid neutralizes with alkali to Benzenesulfonate.', dBsa);
      }
    }
    if ((moles.C6H5SO3Na_s || 0) > 1e-9 && (moles.NaOH_s || 0) > 1e-8 && T >= 573.15) {
      const dFus = Math.min(moles.C6H5SO3Na_s, moles.NaOH_s / 2) * (1 - Math.exp(-0.75 * dt));
      if (dFus > 1e-11) {
        consumeSpecies('C6H5SO3Na_s', dFus);
        consumeSpecies('NaOH_s', 2 * dFus);
        moles.C6H5O_aq = (moles.C6H5O_aq || 0) + dFus;
        moles.Na_aq = (moles.Na_aq || 0) + dFus;
        moles.Na2SO3_s = (moles.Na2SO3_s || 0) + dFus;
        gasProduced.H2O_g = (gasProduced.H2O_g || 0) + dFus;
        heatJ += dFus * 65000;
        pushRxn('bsa_alkali_fusion', 'C₆H₅SO₃Na + 2NaOH(rắn) —(310 °C)→ C₆H₅ONa + Na₂SO₃ + H₂O↑', 'Nung chảy kiềm Sodium benzenesulfonate → Sodium phenoxide', 'Alkali fusion of C₆H₅SO₃Na (310 °C) → Phenoxide + Na₂SO₃', 'Nung chảy C₆H₅SO₃Na với NaOH rắn ở 300–320 °C tạo muối Phenoxide.', 'Alkali fusion of sodium benzenesulfonate at 310 °C yields sodium phenoxide.', dFus, true);
      }
    }

    // 6B. Carboxylic Acid Preparations: Oxalic acid (EtOH/Glycol + conc HNO3), Acrylic & Crotonic acid (Aldehyde + Tollens/Ag2O)
    const oxNitConc = (moles.HNO3_l || 0) > 1e-7 ? moles.HNO3_l : ((moles.NO3_aq || 0) > 1e-4 && (moles.H_aq || 0) > 1e-4 && (moles.H2O_l || 0) < 0.8) ? Math.min(moles.NO3_aq, moles.H_aq) : 0;
    if (oxNitConc > 1e-7 && T >= 333.15) {
      if ((moles.C2H4OH_2_l || 0) > 1e-9) {
        const dOxG = Math.min(moles.C2H4OH_2_l, oxNitConc / 4) * (1 - Math.exp(-0.68 * dt));
        if (dOxG > 1e-11) {
          consumeSpecies('C2H4OH_2_l', dOxG);
          if ((moles.HNO3_l || 0) >= 4 * dOxG) consumeSpecies('HNO3_l', 4 * dOxG);
          else { consumeSpecies('NO3_aq', 4 * dOxG); consumeSpecies('H_aq', 4 * dOxG); }
          moles.H2C2O4_s = (moles.H2C2O4_s || 0) + dOxG;
          gasProduced.NO2_g = (gasProduced.NO2_g || 0) + 4 * dOxG;
          moles.H2O_l = (moles.H2O_l || 0) + 4 * dOxG;
          heatJ += dOxG * 280000;
          pushRxn('glycol_oxalic', 'HOCH₂CH₂OH + 4HNO₃(đặc) —(60 °C)→ HOOC–COOH + 4NO₂↑ + 4H₂O', 'Oxi hóa Ethylene glycol bằng HNO₃ đặc → Oxalic acid', 'Ethylene glycol + 4HNO₃(conc) → Oxalic acid + 4NO₂↑', 'HNO₃ đặc oxi hóa hai nhóm –CH₂OH của Ethylene glycol thành Oxalic acid và khí nâu đỏ NO₂.', 'Conc. HNO₃ oxidizes Ethylene glycol to Oxalic acid crystals and brown NO₂ gas.', dOxG, true);
        }
      } else if ((moles.C2H5OH_l || 0) > 1e-8) {
        const dOxE = Math.min(moles.C2H5OH_l, oxNitConc / 8) * (1 - Math.exp(-0.55 * dt));
        if (dOxE > 1e-11) {
          consumeSpecies('C2H5OH_l', dOxE);
          if ((moles.HNO3_l || 0) >= 8 * dOxE) consumeSpecies('HNO3_l', 8 * dOxE);
          else { consumeSpecies('NO3_aq', 8 * dOxE); consumeSpecies('H_aq', 8 * dOxE); }
          moles.H2C2O4_s = (moles.H2C2O4_s || 0) + dOxE;
          gasProduced.NO2_g = (gasProduced.NO2_g || 0) + 8 * dOxE;
          moles.H2O_l = (moles.H2O_l || 0) + 6 * dOxE;
          heatJ += dOxE * 420000;
          pushRxn('etoh_oxalic', 'C₂H₅OH + 8HNO₃(đặc) —(70 °C)→ HOOC–COOH + 8NO₂↑ + 6H₂O', 'Oxi hóa Ethanol bằng HNO₃ đặc → Oxalic acid + 8NO₂↑', 'Ethanol + 8HNO₃(conc) → Oxalic acid + 8NO₂↑', 'HNO₃ đặc nóng oxi hóa hoàn toàn Ethanol thành Oxalic acid và giải phóng khí NO₂.', 'Hot conc. HNO₃ oxidizes Ethanol to Oxalic acid and NO₂ gas.', dOxE, true);
        }
      }
    }

    // Acrylic & Crotonic acid via mild Tollens (Ag(NH3)2+ / Ag2O, 40–60 °C)
    if ((moles.CH2CHCHO_l || 0) > 1e-9 && T >= 313.15) {
      if ((moles.AgNH3_2_aq || 0) > 1e-7 && (moles.OH_aq || 0) > 1e-7) {
        const dAcr = Math.min(moles.CH2CHCHO_l, moles.AgNH3_2_aq / 2, moles.OH_aq / 2) * (1 - Math.exp(-0.95 * dt));
        if (dAcr > 1e-11) {
          consumeSpecies('CH2CHCHO_l', dAcr);
          consumeSpecies('AgNH3_2_aq', 2 * dAcr);
          consumeSpecies('OH_aq', 2 * dAcr);
          moles.CH2CHCOO_aq = (moles.CH2CHCOO_aq || 0) + dAcr;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dAcr;
          moles.NH3_aq = (moles.NH3_aq || 0) + 4 * dAcr;
          moles.H2O_l = (moles.H2O_l || 0) + 2 * dAcr;
          heatJ += dAcr * 115000;
          pushRxn('acrolein_tollens', 'CH₂=CHCHO + 2[Ag(NH₃)₂]⁺ + 2OH⁻ —(50 °C)→ CH₂=CHCOO⁻ + 2Ag↓ + 4NH₃ + 2H₂O', 'Oxi hóa Acrolein bằng thuốc thử Tollens → Acrylate + 2Ag↓', 'Acrolein + Tollens reagent → Acrylate + 2Ag↓', 'Thuốc thử Tollens oxi hóa chọn lọc nhóm –CHO bảo toàn nối đôi C=C tạo muối Acrylate.', 'Tollens reagent selectively oxidizes Acrolein to Acrylate preserving C=C.', dAcr);
        }
      } else if ((moles.Ag2O_s || 0) > 1e-8) {
        const dAcr2 = Math.min(moles.CH2CHCHO_l, moles.Ag2O_s) * (1 - Math.exp(-0.78 * dt));
        if (dAcr2 > 1e-11) {
          consumeSpecies('CH2CHCHO_l', dAcr2);
          consumeSpecies('Ag2O_s', dAcr2);
          moles.CH2CHCOOH_l = (moles.CH2CHCOOH_l || 0) + dAcr2;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dAcr2;
          heatJ += dAcr2 * 105000;
          pushRxn('acrolein_ag2o', 'CH₂=CHCHO + Ag₂O —(50 °C)→ CH₂=CHCOOH + 2Ag↓', 'Oxi hóa Acrolein bằng Ag₂O → Acrylic acid + 2Ag↓', 'Acrolein + Ag₂O → Acrylic acid + 2Ag↓', 'Ag₂O oxi hóa nhóm –CHO của Acrolein thành Acrylic acid.', 'Ag₂O oxidizes Acrolein directly to Acrylic acid.', dAcr2);
        }
      }
    }
    if ((moles.CH2CHCOO_aq || 0) > 1e-9 && (moles.H_aq || 0) > 1e-6) {
      const dAcrH = Math.min(moles.CH2CHCOO_aq, moles.H_aq) * (1 - Math.exp(-3.0 * dt));
      if (dAcrH > 1e-11) {
        consumeSpecies('CH2CHCOO_aq', dAcrH);
        consumeSpecies('H_aq', dAcrH);
        moles.CH2CHCOOH_l = (moles.CH2CHCOOH_l || 0) + dAcrH;
        heatJ += dAcrH * 15000;
      }
    }
    if ((moles.CH3CHCHCHO_l || 0) > 1e-9 && T >= 313.15) {
      if ((moles.AgNH3_2_aq || 0) > 1e-7 && (moles.OH_aq || 0) > 1e-7) {
        const dCrot = Math.min(moles.CH3CHCHCHO_l, moles.AgNH3_2_aq / 2, moles.OH_aq / 2) * (1 - Math.exp(-0.88 * dt));
        if (dCrot > 1e-11) {
          consumeSpecies('CH3CHCHCHO_l', dCrot);
          consumeSpecies('AgNH3_2_aq', 2 * dCrot);
          consumeSpecies('OH_aq', 2 * dCrot);
          moles.CH3CHCHCOO_aq = (moles.CH3CHCHCOO_aq || 0) + dCrot;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dCrot;
          moles.NH3_aq = (moles.NH3_aq || 0) + 4 * dCrot;
          moles.H2O_l = (moles.H2O_l || 0) + 2 * dCrot;
          heatJ += dCrot * 112000;
          pushRxn('croton_tollens', 'CH₃CH=CHCHO + 2[Ag(NH₃)₂]⁺ + 2OH⁻ —(50 °C)→ CH₃CH=CHCOO⁻ + 2Ag↓ + 4NH₃ + 2H₂O', 'Oxi hóa Crotonaldehyde bằng Tollens → Crotonate + 2Ag↓', 'Crotonaldehyde + Tollens → Crotonate + 2Ag↓', 'Oxi hóa nhẹ Crotonaldehyde ở 50 °C thu được muối Crotonate và kết tủa bạc.', 'Mild Tollens oxidation of Crotonaldehyde yields Crotonate and Ag mirror.', dCrot);
        }
      } else if ((moles.Ag2O_s || 0) > 1e-8) {
        const dCrot2 = Math.min(moles.CH3CHCHCHO_l, moles.Ag2O_s) * (1 - Math.exp(-0.74 * dt));
        if (dCrot2 > 1e-11) {
          consumeSpecies('CH3CHCHCHO_l', dCrot2);
          consumeSpecies('Ag2O_s', dCrot2);
          moles.CH3CHCHCOOH_s = (moles.CH3CHCHCOOH_s || 0) + dCrot2;
          moles.Ag_s = (moles.Ag_s || 0) + 2 * dCrot2;
          heatJ += dCrot2 * 102000;
          pushRxn('croton_ag2o', 'CH₃CH=CHCHO + Ag₂O —(50 °C)→ CH₃CH=CHCOOH + 2Ag↓', 'Oxi hóa Crotonaldehyde bằng Ag₂O → Crotonic acid', 'Crotonaldehyde + Ag₂O → Crotonic acid + 2Ag↓', 'Ag₂O oxi hóa Crotonaldehyde tạo tinh thể trắng Crotonic acid.', 'Ag₂O oxidizes Crotonaldehyde to white Crotonic acid crystals.', dCrot2);
        }
      }
    }
    if ((moles.CH3CHCHCOO_aq || 0) > 1e-9 && (moles.H_aq || 0) > 1e-6) {
      const dCrotH = Math.min(moles.CH3CHCHCOO_aq, moles.H_aq) * (1 - Math.exp(-3.0 * dt));
      if (dCrotH > 1e-11) {
        consumeSpecies('CH3CHCHCOO_aq', dCrotH);
        consumeSpecies('H_aq', dCrotH);
        moles.CH3CHCHCOOH_s = (moles.CH3CHCHCOOH_s || 0) + dCrotH;
        heatJ += dCrotH * 15000;
      }
    }

    // 6C. Carboxylic Acid Properties: H2C2O4_s, C6H5COOH_s, CH2CHCOOH_l, CH3CHCHCOOH_s (OH-, CaCO3/CO3^2-, Mg, Phenoxide)
    const carbAcids = [
      { id: 'H2C2O4_s', ion: 'C2O4_2_aq', stoich: 2, label: 'H₂C₂O₄', name: 'Oxalic acid' },
      { id: 'C6H5COOH_s', ion: 'C6H5COO_aq', stoich: 1, label: 'C₆H₅COOH', name: 'Benzoic acid' },
      { id: 'CH2CHCOOH_l', ion: 'CH2CHCOO_aq', stoich: 1, label: 'CH₂=CHCOOH', name: 'Acrylic acid' },
      { id: 'CH3CHCHCOOH_s', ion: 'CH3CHCHCOO_aq', stoich: 1, label: 'CH₃CH=CHCOOH', name: 'Crotonic acid' },
    ];
    for (const ca of carbAcids) {
      const nCa = moles[ca.id] || 0;
      if (nCa <= 1e-10) continue;
      if ((moles.OH_aq || 0) > 1e-6) {
        const dN = Math.min(nCa, moles.OH_aq / ca.stoich) * (1 - Math.exp(-3.0 * dt));
        if (dN > 1e-11) {
          consumeSpecies(ca.id, dN);
          consumeSpecies('OH_aq', ca.stoich * dN);
          moles[ca.ion] = (moles[ca.ion] || 0) + dN;
          moles.H2O_l = (moles.H2O_l || 0) + ca.stoich * dN;
          heatJ += dN * 54000 * ca.stoich;
          pushRxn(`ca_oh_${ca.id}`, `${ca.label} + ${ca.stoich > 1 ? '2' : ''}OH⁻ → ${ca.ion.replace('_2_aq', '²⁻').replace('_aq', '⁻')} + ${ca.stoich > 1 ? '2' : ''}H₂O`, `Trung hòa ${ca.name} bằng kiềm`, `Neutralization of ${ca.name}`, `${ca.name} phản ứng hoàn toàn với dung dịch kiềm tạo muối carboxylate.`, `${ca.name} neutralizes cleanly with alkali.`, dN);
        }
      } else if ((moles.CaCO3_s || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-4) {
        const acidNeed = ca.stoich === 2 ? 1 : 2;
        const dC = Math.min(nCa / acidNeed, moles.CaCO3_s) * (1 - Math.exp(-1.4 * dt));
        if (dC > 1e-11) {
          consumeSpecies(ca.id, acidNeed * dC);
          consumeSpecies('CaCO3_s', dC);
          moles[ca.ion] = (moles[ca.ion] || 0) + acidNeed * dC;
          moles.Ca2_aq = (moles.Ca2_aq || 0) + dC;
          gasProduced.CO2_g = (gasProduced.CO2_g || 0) + dC;
          moles.H2O_l = (moles.H2O_l || 0) + dC;
          heatJ += dC * 28000;
          pushRxn(`ca_caco3_${ca.id}`, `${acidNeed > 1 ? '2' : ''}${ca.label} + CaCO₃ → Ca²⁺ + ${acidNeed > 1 ? '2' : ''}${ca.ion.replace('_2_aq', '²⁻').replace('_aq', '⁻')} + CO₂↑ + H₂O`, `${ca.name} + CaCO₃ → giải phóng CO₂↑`, `${ca.name} + CaCO₃ → CO₂↑`, `${ca.name} mạnh hơn H₂CO₃ nên sủi bọt khí CO₂ với CaCO₃ (khác với Phenol).`, `${ca.name} evolves CO₂ gas with CaCO₃, distinguishing –COOH from Phenol.`, dC, true);
        }
      } else if ((moles.Mg_s || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-4) {
        const acidNeed = ca.stoich === 2 ? 1 : 2;
        const dMg = Math.min(nCa / acidNeed, moles.Mg_s) * (1 - Math.exp(-1.6 * dt));
        if (dMg > 1e-11) {
          consumeSpecies(ca.id, acidNeed * dMg);
          consumeSpecies('Mg_s', dMg);
          moles[ca.ion] = (moles[ca.ion] || 0) + acidNeed * dMg;
          moles.Mg2_aq = (moles.Mg2_aq || 0) + dMg;
          gasProduced.H2_g = (gasProduced.H2_g || 0) + dMg;
          heatJ += dMg * 195000;
          pushRxn(`ca_mg_${ca.id}`, `${acidNeed > 1 ? '2' : ''}${ca.label} + Mg → Mg²⁺ + ${acidNeed > 1 ? '2' : ''}${ca.ion.replace('_2_aq', '²⁻').replace('_aq', '⁻')} + H₂↑`, `${ca.name} + Mg → H₂↑`, `${ca.name} + Mg → H₂↑`, `Kim loại Mg khử H⁺ của ${ca.name} giải phóng khí H₂.`, `Magnesium reacts with ${ca.name} evolving H₂ gas.`, dMg, true);
        }
      }
    }

    // 6D. Arene Chemistry: Toluene (C6H5CH3_l) & Ethylbenzene (C6H5C2H5_l)
    const hasFeAr = (moles.Fe_s || 0) > 1e-8 || (moles.FeCl3_s || 0) > 1e-8 || (moles.FeBr3_s || 0) > 1e-8 || (moles.Fe3_aq || 0) > 1e-8;
    const hsAr = vessel.headspaceGasMoles || {};
    const brAr = (moles.Br2_l || 0) > 1e-9 ? 'Br2_l' : (moles.Br2_g || 0) > 1e-9 ? 'Br2_g' : (hsAr.Br2_g || 0) > 1e-9 ? 'hs:Br2_g' : null;
    if ((moles.C6H5CH3_l || 0) > 1e-9) {
      // Ring bromination (Fe, 30-50 C, no UV) vs Side-chain benzyl bromination (UV or >= 373.15 K, no Fe)
      if (brAr) {
        const nBrA = brAr.startsWith('hs:') ? hsAr.Br2_g : moles[brAr];
        const takeBrA = (amt) => {
          if (brAr.startsWith('hs:')) { hsAr.Br2_g = Math.max(0, hsAr.Br2_g - amt); if (hsAr.Br2_g < 1e-13) delete hsAr.Br2_g; }
          else consumeSpecies(brAr, amt);
        };
        if (hasFeAr && !uvOn && T >= 303.15) {
          const dTolBr = Math.min(moles.C6H5CH3_l, nBrA) * (1 - Math.exp(-0.95 * dt));
          if (dTolBr > 1e-11) {
            consumeSpecies('C6H5CH3_l', dTolBr);
            takeBrA(dTolBr);
            moles.BrC6H4CH3_l = (moles.BrC6H4CH3_l || 0) + dTolBr;
            gasProduced.HBr_g = (gasProduced.HBr_g || 0) + dTolBr;
            heatJ += dTolBr * 52000;
            pushRxn('toluene_ring_br2', 'C₆H₅CH₃ + Br₂ —(Fe, 30–50 °C)→ o/p-BrC₆H₄CH₃ + HBr↑', 'Thế Bromine vào nhân thơm Toluene (xúc tác Fe)', 'Toluene ring bromination (Fe) → o/p-Bromotoluene + HBr↑', 'Nhóm –CH₃ đẩy electron hoạt hóa vòng thơm giúp thế Br₂ vào vị trí ortho/para.', 'Electron-donating –CH₃ directs Fe-catalyzed bromination to ortho/para positions.', dTolBr, true);
          }
        } else if (!hasFeAr && (uvOn || T >= 373.15)) {
          const dBnBr = Math.min(moles.C6H5CH3_l, nBrA) * (1 - Math.exp(-0.85 * dt));
          if (dBnBr > 1e-11) {
            consumeSpecies('C6H5CH3_l', dBnBr);
            takeBrA(dBnBr);
            moles.C6H5CH2Br_l = (moles.C6H5CH2Br_l || 0) + dBnBr;
            gasProduced.HBr_g = (gasProduced.HBr_g || 0) + dBnBr;
            heatJ += dBnBr * 44000;
            pushRxn('toluene_benzyl_br2', 'C₆H₅CH₃ + Br₂ —(UV / 110 °C)→ C₆H₅CH₂Br + HBr↑', 'Thế gốc tự do ở nhánh methyl Toluene → Benzyl bromide', 'Side-chain radical bromination (UV/110 °C) → Benzyl bromide', 'Dưới tia UV hoặc đun nóng không có Fe, Br₂ thế ưu tiên vào carbon benzyl tạo Benzyl bromide.', 'Under UV or heat without Fe, Br₂ substitutes at the benzylic methyl group.', dBnBr, true);
          }
        }
      }

      // Toluene Nitration (35 C -> NO2C6H4CH3; >= 100 C -> TNT)
      const hasTolAcid = (moles.H2SO4_l || 0) > 1e-6 || (moles.HSO4_aq || 0) > 1e-4;
      const hasTolNit = (moles.HNO3_l || 0) > 1e-7 || ((moles.NO3_aq || 0) > 1e-5 && (moles.H_aq || 0) > 1e-5);
      if (hasTolAcid && hasTolNit && T >= 303.15) {
        const nNitT = (moles.HNO3_l || 0) > 1e-7 ? moles.HNO3_l : Math.min(moles.NO3_aq || 0, moles.H_aq || 0);
        if (T >= 373.15 && nNitT >= 3e-7) {
          const dTnt = Math.min(moles.C6H5CH3_l, nNitT / 3) * (1 - Math.exp(-0.55 * dt));
          if (dTnt > 1e-11) {
            consumeSpecies('C6H5CH3_l', dTnt);
            if ((moles.HNO3_l || 0) >= 3 * dTnt) consumeSpecies('HNO3_l', 3 * dTnt);
            else { consumeSpecies('NO3_aq', 3 * dTnt); consumeSpecies('H_aq', 3 * dTnt); }
            moles.C6H2_NO2_3CH3_s = (moles.C6H2_NO2_3CH3_s || 0) + dTnt;
            moles.H2O_l = (moles.H2O_l || 0) + 3 * dTnt;
            heatJ += dTnt * 280000;
            pushRxn('toluene_tnt', 'C₆H₅CH₃ + 3HNO₃(đặc) —(H₂SO₄ đặc, 100–110 °C)→ 2,4,6-(NO₂)₃C₆H₂CH₃↓ + 3H₂O', 'Nitro hóa mạnh Toluene → 2,4,6-Trinitrotoluene (TNT)', 'Vigorous nitration of Toluene → 2,4,6-Trinitrotoluene (TNT)', 'Đun nóng 100–110 °C với hỗn hợp HNO₃/H₂SO₄ dư tạo tinh thể vàng TNT.', 'Vigorous nitration at 100–110 °C produces yellow 2,4,6-Trinitrotoluene (TNT).', dTnt);
          }
        } else {
          const dMonoN = Math.min(moles.C6H5CH3_l, nNitT) * (1 - Math.exp(-0.85 * dt));
          if (dMonoN > 1e-11) {
            consumeSpecies('C6H5CH3_l', dMonoN);
            if ((moles.HNO3_l || 0) >= dMonoN) consumeSpecies('HNO3_l', dMonoN);
            else { consumeSpecies('NO3_aq', dMonoN); consumeSpecies('H_aq', dMonoN); }
            moles.NO2C6H4CH3_l = (moles.NO2C6H4CH3_l || 0) + dMonoN;
            moles.H2O_l = (moles.H2O_l || 0) + dMonoN;
            heatJ += dMonoN * 125000;
            pushRxn('toluene_nitration', 'C₆H₅CH₃ + HNO₃ —(H₂SO₄ đặc, 35 °C)→ o/p-NO₂C₆H₄CH₃ + H₂O', 'Nitro hóa Toluene (35 °C) → o/p-Nitrotoluene', 'Toluene nitration (35 °C) → o/p-Nitrotoluene', 'Toluene phản ứng nitro hóa dễ hơn Benzene ngay ở 30–40 °C.', 'Toluene nitrates more readily than Benzene at 30–40 °C.', dMonoN);
          }
        }
      }

      // Toluene Hydrogenation (Ni/Pt, >= 423.15 K) -> Methylcyclohexane
      if (((moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8) && (moles.H2_g || 0) > 1e-9 && T >= 423.15) {
        const dHydT = Math.min(moles.C6H5CH3_l, moles.H2_g / 3) * (1 - Math.exp(-0.62 * dt));
        if (dHydT > 1e-11) {
          consumeSpecies('C6H5CH3_l', dHydT);
          consumeSpecies('H2_g', 3 * dHydT);
          moles.C7H14_l = (moles.C7H14_l || 0) + dHydT;
          heatJ += dHydT * 205000;
          pushRxn('toluene_hydrogenation', 'C₆H₅CH₃ + 3H₂ —(Ni, 180 °C)→ C₇H₁₄', 'Hydro hóa Toluene → Methylcyclohexane', 'Toluene hydrogenation → Methylcyclohexane', 'Cộng 3H₂ vào vòng thơm Toluene tạo Methylcyclohexane.', 'Catalytic hydrogenation of Toluene yields Methylcyclohexane.', dHydT);
        }
      }

      // Toluene + KMnO4 (ONLY on heating >= 343.15 K / 70–100 °C -> Benzoate + 2MnO2↓)
      if ((moles.MnO4_aq || 0) > 1e-7 && (moles.H2O_l || 0) > 1e-4 && T >= 343.15) {
        const dKmT = Math.min(moles.C6H5CH3_l, moles.MnO4_aq / 2) * (1 - Math.exp(-0.78 * dt));
        if (dKmT > 1e-11) {
          consumeSpecies('C6H5CH3_l', dKmT);
          consumeSpecies('MnO4_aq', 2 * dKmT);
          moles.C6H5COO_aq = (moles.C6H5COO_aq || 0) + dKmT;
          moles.MnO2_s = (moles.MnO2_s || 0) + 2 * dKmT;
          moles.OH_aq = (moles.OH_aq || 0) + dKmT;
          moles.H2O_l = (moles.H2O_l || 0) + dKmT;
          heatJ += dKmT * 360000;
          pushRxn('toluene_kmno4_hot', 'C₆H₅CH₃ + 2MnO₄⁻ —(80–100 °C)→ C₆H₅COO⁻ + 2MnO₂↓ + OH⁻ + H₂O', 'Oxi hóa Toluene bằng KMnO₄ đun nóng → Benzoate + MnO₂↓', 'Hot KMnO₄ oxidizes Toluene → Benzoate + 2MnO₂↓', 'Khác với Benzene trơ hoàn toàn, Toluene làm mất màu KMnO₄ khi đun nóng tạo kết tủa nâu đen MnO₂.', 'Unlike inert Benzene, hot KMnO₄ oxidizes Toluene to Benzoate and brown-black MnO₂↓.', dKmT);
        }
      }
    }

    // Ethylbenzene + KMnO4 (>= 343.15 K) -> Benzoate + CO3^2- + 4MnO2↓
    if ((moles.C6H5C2H5_l || 0) > 1e-9 && (moles.MnO4_aq || 0) > 1e-7 && (moles.H2O_l || 0) > 1e-4 && T >= 343.15) {
      const dKmEb = Math.min(moles.C6H5C2H5_l, moles.MnO4_aq / 4) * (1 - Math.exp(-0.72 * dt));
      if (dKmEb > 1e-11) {
        consumeSpecies('C6H5C2H5_l', dKmEb);
        consumeSpecies('MnO4_aq', 4 * dKmEb);
        moles.C6H5COO_aq = (moles.C6H5COO_aq || 0) + dKmEb;
        moles.CO3_2_aq = (moles.CO3_2_aq || 0) + dKmEb;
        moles.MnO2_s = (moles.MnO2_s || 0) + 4 * dKmEb;
        moles.OH_aq = (moles.OH_aq || 0) + dKmEb;
        moles.H2O_l = (moles.H2O_l || 0) + 2 * dKmEb;
        heatJ += dKmEb * 620000;
        pushRxn('ethylbenzene_kmno4_hot', 'C₆H₅C₂H₅ + 4MnO₄⁻ —(90 °C)→ C₆H₅COO⁻ + CO₃²⁻ + 4MnO₂↓ + OH⁻ + 2H₂O', 'Oxi hóa cắt mạch Ethylbenzene bằng KMnO₄ nóng → Benzoate + MnO₂↓', 'Hot KMnO₄ cleaves Ethylbenzene → Benzoate + CO₃²⁻ + 4MnO₂↓', 'Toàn bộ nhánh ethyl bị oxi hóa cắt mạch thành nhóm –COO⁻ (Benzoate) và MnO₂↓.', 'Hot KMnO₄ cleaves the entire ethyl side chain to Benzoate and MnO₂↓.', dKmEb);
      }
    }

    // Benzoate acidification: C6H5COO- + H+ -> C6H5COOH↓ (white crystals)
    if ((moles.C6H5COO_aq || 0) > 1e-9 && (moles.H_aq || 0) > 1e-6) {
      const dBzAcid = Math.min(moles.C6H5COO_aq, moles.H_aq) * (1 - Math.exp(-3.2 * dt));
      if (dBzAcid > 1e-11) {
        consumeSpecies('C6H5COO_aq', dBzAcid);
        consumeSpecies('H_aq', dBzAcid);
        moles.C6H5COOH_s = (moles.C6H5COOH_s || 0) + dBzAcid;
        heatJ += dBzAcid * 24000;
        pushRxn('benzoate_acidify', 'C₆H₅COO⁻ + H⁺ → C₆H₅COOH↓ (trắng)', 'Acid hóa Benzoate kết tinh Benzoic acid trắng', 'Acidification of Benzoate → white Benzoic acid↓', 'Acid hóa muối Benzoate kết tủa tinh thể trắng Benzoic acid.', 'Acidifying Benzoate precipitates white Benzoic acid crystals.', dBzAcid);
      }
    }

    // ==================== PART 7: PROMPT 63 — METHANOL, FORMIC, POLYOLS, HCHO, LIPIDS & HYDROCARBONS ====================
    const hs63 = vessel.headspaceGasMoles || {};
    const getG = (id) => (moles[id] || 0) + (hs63[id] || 0);
    const takeG = (id, amt) => {
      const mUse = Math.min(moles[id] || 0, amt);
      if (mUse > 0) consumeSpecies(id, mUse);
      const rem = amt - mUse;
      if (rem > 1e-13 && hs63[id] > 0) {
        hs63[id] = Math.max(0, hs63[id] - rem);
        if (hs63[id] < 1e-13) delete hs63[id];
      }
    };

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
        const dBuna = getG('C4H6_g') * (1 - Math.exp(-0.75 * dt));
        if (dBuna > 1e-11) {
          takeG('C4H6_g', dBuna); moles.Buna_s = (moles.Buna_s || 0) + dBuna;
          pushRxn('c4h6_buna_rubber', 'nCH₂=CH–CH=CH₂ —(Na, t°)→ (–CH₂–CH=CH–CH₂–)ₙ (Cao su Buna)', 'Trùng hợp 1,4 Buta-1,3-diene (xúc tác Na) → cao su Buna', '1,4-Polymerization (Na) → Buna rubber', 'Kim loại Na xúc tác trùng hợp 1,4 Buta-1,3-diene tạo cao su Buna đàn hồi.', 'Sodium-initiated 1,4-polymerization yields elastic Buna rubber.', dBuna);
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
  }

  return heatJ;
}
