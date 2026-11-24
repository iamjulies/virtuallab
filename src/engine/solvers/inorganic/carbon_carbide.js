import { CONSTANTS } from '../../../data/constants.js';
import { SPECIES } from '../../../data/species.js';
import { applyEquilibriumShift, computeSulfuricAcidState, getVesselEffectiveO2Bar } from '../../chemistryHelpers.js';

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
