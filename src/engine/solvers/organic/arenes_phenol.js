/**
 * Organic Chemistry Solver: Benzene, Arenes, Halogen Derivatives & Phenols (Split 81).
 */
import { CONSTANTS } from '../../../data/constants.js';
import { SPECIES } from '../../../data/species.js';
import { computeSulfuricAcidState } from '../../chemistryHelpers.js';

export function stepOrganicArenesPhenol(ctx) {
  const {
    vessel, liquidVolL, dt, gasProduced, iceMob, options,
    moles, T, orgMob, uvOn, hs63, getG, takeG,
    consumeSpecies, pushRxn,
  } = ctx;
  let heatJ = 0;
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
      const fcMeId =
        (moles.CH3Cl_g || 0) > 1e-9
          ? 'CH3Cl_g'
          : (vessel.headspaceGasMoles?.CH3Cl_g || 0) > 1e-9
          ? 'hs:CH3Cl_g'
          : (moles.CH3Br_g || 0) > 1e-9
          ? 'CH3Br_g'
          : (vessel.headspaceGasMoles?.CH3Br_g || 0) > 1e-9
          ? 'hs:CH3Br_g'
          : null;
      if (fcMeId) {
        const isBrMe = fcMeId.includes('Br');
        const rawKey = fcMeId.replace(/^hs:/, '');
        const nHalMe = (moles[rawKey] || 0) + (vessel.headspaceGasMoles?.[rawKey] || 0);
        const dFCme = Math.min(moles.C6H6_l, nHalMe) * (1 - Math.exp(-0.90 * dt));
        if (dFCme > 1e-11) {
          consumeSpecies('C6H6_l', dFCme);
          const mUse = Math.min(moles[rawKey] || 0, dFCme);
          if (mUse > 0) consumeSpecies(rawKey, mUse);
          const hsRem = dFCme - mUse;
          if (hsRem > 1e-13 && vessel.headspaceGasMoles?.[rawKey] > 0) {
            vessel.headspaceGasMoles[rawKey] = Math.max(0, vessel.headspaceGasMoles[rawKey] - hsRem);
            if (vessel.headspaceGasMoles[rawKey] < 1e-13) delete vessel.headspaceGasMoles[rawKey];
          }
          moles.C6H5CH3_l = (moles.C6H5CH3_l || 0) + dFCme;
          const hxGas = isBrMe ? 'HBr_g' : 'HCl_g';
          gasProduced[hxGas] = (gasProduced[hxGas] || 0) + dFCme;
          heatJ += dFCme * 75000;
          pushRxn('benzene_fc_methylation', `C₆H₆ + ${isBrMe ? 'CH₃Br' : 'CH₃Cl'} —(AlCl₃ khan)→ C₆H₅CH₃ + ${isBrMe ? 'HBr' : 'HCl'}↑`, 'Alkyl hóa Friedel–Crafts Benzene + CH₃X → Toluene', 'Friedel–Crafts methylation: Benzene → Toluene + HX↑', 'Xúc tác AlCl₃ khan thực hiện phản ứng alkyl hóa tạo Toluene từ Benzene và CH₃Cl/CH₃Br.', 'Anhydrous AlCl₃ catalyzes Friedel–Crafts methylation yielding Toluene.', dFCme, true);
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

  // 5A-8b. Nitrobenzene -> Aniline (Bechamp Fe/HCl & Catalytic H2/Ni-Pt)
  if ((moles.C6H5NO2_l || 0) > 1e-9) {
    if ((moles.Fe_s || 0) > 1e-8 && (moles.H_aq || 0) > 1e-5 && T >= 323.15) {
      const dBech = Math.min(moles.C6H5NO2_l, moles.Fe_s / 3, moles.H_aq / 7) * (1 - Math.exp(-0.78 * dt));
      if (dBech > 1e-11) {
        consumeSpecies('C6H5NO2_l', dBech);
        consumeSpecies('Fe_s', 3 * dBech);
        consumeSpecies('H_aq', 7 * dBech);
        moles.C6H5NH3_aq = (moles.C6H5NH3_aq || 0) + dBech;
        moles.Fe2_aq = (moles.Fe2_aq || 0) + 3 * dBech;
        moles.H2O_l = (moles.H2O_l || 0) + 2 * dBech;
        heatJ += dBech * 410000;
        pushRxn('bechamp_nitrobenzene_aniline', 'C₆H₅NO₂ + 3Fe + 7H⁺ —(60–90 °C)→ C₆H₅NH₃⁺ + 3Fe²⁺ + 2H₂O', 'Khử Bechamp Nitrobenzene (Fe/HCl) → muối Anilinium', 'Bechamp reduction: Nitrobenzene + 3Fe + 7H⁺ → Anilinium + 3Fe²⁺', 'Sắt trong acid HCl khử Nitrobenzene thành muối Anilinium tan; thêm NaOH giải phóng dầu Aniline.', 'Fe/HCl reduces Nitrobenzene to Anilinium salt; NaOH liberates oily Aniline.', dBech);
      }
    }
    const hasHydCatN = (moles.Ni_s || 0) > 1e-8 || (moles.Pt_s || 0) > 1e-8;
    const nH2N = (moles.H2_g || 0) + (vessel.headspaceGasMoles?.H2_g || 0);
    if (hasHydCatN && nH2N > 1e-9 && T >= 373.15) {
      const dHydAn = Math.min(moles.C6H5NO2_l, nH2N / 3) * (1 - Math.exp(-0.75 * dt));
      if (dHydAn > 1e-11) {
        consumeSpecies('C6H5NO2_l', dHydAn);
        const mUse = Math.min(moles.H2_g || 0, 3 * dHydAn);
        if (mUse > 0) consumeSpecies('H2_g', mUse);
        const rem = 3 * dHydAn - mUse;
        if (rem > 1e-13 && vessel.headspaceGasMoles?.H2_g > 0) {
          vessel.headspaceGasMoles.H2_g = Math.max(0, vessel.headspaceGasMoles.H2_g - rem);
          if (vessel.headspaceGasMoles.H2_g < 1e-13) delete vessel.headspaceGasMoles.H2_g;
        }
        moles.C6H5NH2_l = (moles.C6H5NH2_l || 0) + dHydAn;
        moles.H2O_l = (moles.H2O_l || 0) + 2 * dHydAn;
        heatJ += dHydAn * 490000;
        pushRxn('nitrobenzene_h2_aniline', 'C₆H₅NO₂ + 3H₂ —(Ni/Pt, t°)→ C₆H₅NH₂ + 2H₂O', 'Hydro hóa xúc tác Nitrobenzene → Aniline', 'Catalytic hydrogenation: Nitrobenzene → Aniline', 'H₂ trên xúc tác Ni/Pt khử trực tiếp Nitrobenzene thành Aniline và nước.', 'Ni/Pt hydrogenation reduces Nitrobenzene cleanly to Aniline.', dHydAn);
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
    // Lebedev ethanol -> Buta-1,3-diene: 2 C2H5OH -(Al2O3 + ZnO, >= 653 K)-> C4H6_g + 2 H2O + H2_g
    if ((moles.C2H5OH_l || 0) > 1e-8 && (moles.Al2O3_s || 0) > 1e-8 && (moles.ZnO_s || 0) > 1e-8 && T >= 653.15) {
      const dLeb = (moles.C2H5OH_l / 2) * (1 - Math.exp(-0.55 * dt));
      if (dLeb > 1e-11) {
        consumeSpecies('C2H5OH_l', 2 * dLeb);
        gasProduced.C4H6_g = (gasProduced.C4H6_g || 0) + dLeb;
        gasProduced.H2_g = (gasProduced.H2_g || 0) + dLeb;
        moles.H2O_l = (moles.H2O_l || 0) + 2 * dLeb;
        heatJ -= dLeb * 98000;
        pushRxn('lebedev_c4h6', '2C₂H₅OH —(Al₂O₃/ZnO, 400 °C)→ CH₂=CH–CH=CH₂↑ + 2H₂O + H₂↑', 'Tổng hợp Lebedev từ Ethanol → Buta-1,3-diene', 'Lebedev synthesis: 2 Ethanol → Buta-1,3-diene + H₂↑', 'Quá trình Lebedev chuyển Ethanol thành Buta-1,3-diene làm monomer cao su Buna.', 'Lebedev catalytic conversion produces Buta-1,3-diene monomer from Ethanol.', dLeb, true);
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

    // Ethylbenzene dehydrogenation handled below (supports both liquid & hot vapor phases)

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
  }

  return heatJ;
}
