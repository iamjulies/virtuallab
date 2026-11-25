import { CONSTANTS } from '../../../data/constants.js';
import { SPECIES } from '../../../data/species.js';
import { applyEquilibriumShift, computeSulfuricAcidState, getVesselEffectiveO2Bar } from '../../chemistryHelpers.js';

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

  // 5. Nickel(II) hydroxide <-> Hexaamminenickel(II) [Ni(NH3)6]2+ (royal deep blue)
  const nNiOH2 = moles.NiOH2_s || 0;
  const nNiAmm = moles.NiNH3_6_2_aq || 0;
  if (nNiOH2 + nNiAmm > 1e-11) {
    const fracNi = cNH3 > 0.22 ? Math.min(1.0, (cNH3 - 0.22) / 0.40) : 0;
    const targetNi = (nNiOH2 + nNiAmm) * fracNi;
    let dXi = (targetNi - nNiAmm) * relax;
    if (dXi > 1e-11 && cH < 1e-4) {
      dXi = Math.min(dXi, nNiOH2, (moles.NH3_aq || 0) / 6);
      heatJ += applyEquilibriumShift({
        moles,
        dXi,
        deltas: { NiOH2_s: -1, NH3_aq: -6, NiNH3_6_2_aq: 1, OH_aq: 2 },
        heatPerMolJ: -24000,
        dt,
        activeReactions,
        buildMeta: () => ({
          id: 'ni_ammine_complex',
          equation: 'Ni(OH)₂(s) + 6NH₃(aq) ⇌ [Ni(NH₃)₆]²⁺(aq) + 2OH⁻(aq)',
          nameVi: 'Hòa tan Ni(OH)₂ trong NH₃ dư tạo phức xanh dương thẫm [Ni(NH₃)₆]²⁺',
          nameEn: 'Dissolution of Ni(OH)₂ in excess NH₃ forming deep royal blue [Ni(NH₃)₆]²⁺',
          descVi: 'Kết tủa xanh lục nhạt Ni(OH)₂ không tan trong NaOH dư nhưng tan trong NH₃ dư tạo phức xanh dương thẫm [Ni(NH₃)₆]²⁺.',
          descEn: 'Pale-green Ni(OH)₂ is insoluble in excess NaOH but dissolves in excess NH₃ yielding deep royal blue [Ni(NH₃)₆]²⁺.',
        }),
      });
    } else if (dXi < -1e-11 && cH < 1e-4 && (moles.OH_aq || 0) >= 2 * Math.abs(dXi)) {
      dXi = Math.max(dXi, -nNiAmm, -(moles.OH_aq || 0) / 2);
      heatJ += applyEquilibriumShift({
        moles,
        dXi,
        deltas: { NiOH2_s: -1, NH3_aq: -6, NiNH3_6_2_aq: 1, OH_aq: 2 },
        heatPerMolJ: -24000,
        dt,
        activeReactions,
        buildMeta: () => ({
          id: 'ni_ammine_complex',
          equation: '[Ni(NH₃)₆]²⁺(aq) + 2OH⁻(aq) → Ni(OH)₂(s)↓ + 6NH₃(aq)',
          nameVi: 'Tái kết tủa xanh lục nhạt Ni(OH)₂ khi giảm NH₃',
          nameEn: 'Reprecipitation of Ni(OH)₂ upon NH₃ depletion',
          descVi: 'Giảm nồng độ NH₃ làm phức [Ni(NH₃)₆]²⁺ tách lại kết tủa xanh lục nhạt Ni(OH)₂.',
          descEn: 'Depleting NH₃ shifts [Ni(NH₃)₆]²⁺ back into pale-green Ni(OH)₂.',
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
