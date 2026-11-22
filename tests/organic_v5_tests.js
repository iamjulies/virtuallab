/**
 * Modular Verification Suite for Organic Solver v5 Architecture & Beyond (Prompt 66+).
 */
import { CONSTANTS } from '../src/data/constants.js';
import { APPARATUS } from '../src/data/apparatus.js';
import { SPECIES } from '../src/data/species.js';
import { LabSimulation } from '../src/engine/simulation.js';
import { renderVesselSolids } from '../src/canvas/chemicalVisuals.js';
import { computeBeerLambertReading } from '../src/engine/analyticalTools.js';
import { renderColorimeter, renderPhConductometer, renderTlcPlate } from '../src/canvas/toolRenderer.js';

export function runOrganicV5Tests(assert) {
  // TEST 184: Prompt 66 — Modular Organic Architecture, Reversible Zero-Reactant/Anhydrous Solver,
  // Phase-Contact Stirring, Instant Kinetics Isolation, Property-Driven Combustion (CO2 vs CO+C Soot),
  // Peptide Biuret Test & Polymer Film Visuals
  {
    const sim66 = new LabSimulation();

    // 1) Reversible data-driven esterification (Forward + Zero-Reactant Reverse)
    const vFwd = sim66.createApparatus('round_flask_250', 120, 300);
    vFwd.isStoppered = true;
    vFwd.moles.CH3COOH_l = 0.05;
    vFwd.moles.C3H7OH_l = 0.05;
    vFwd.moles.H2O_l = 0.10; // Holds aqueous acid catalyst H_aq
    vFwd.moles.H_aq = 0.02;
    vFwd.moles.Cl_aq = 0.02;

    const vRev = sim66.createApparatus('round_flask_250', 240, 300);
    vRev.isStoppered = true;
    vRev.moles.CH3COOC3H7_l = 0.05;
    vRev.moles.H2O_l = 0.20;
    vRev.moles.H_aq = 0.02;
    vRev.moles.Cl_aq = 0.02;

    // 2) Anhydrous (liquidVolL === 0) + phaseContact acceleration (unmixed vs stirred)
    const vStill = sim66.createApparatus('round_flask_250', 360, 300);
    vStill.isStoppered = true;
    vStill.moles.C6H12_l = 0.04;
    vStill.moles.Br2_l = 0.04;

    const vStir = sim66.createApparatus('round_flask_250', 480, 300);
    vStir.isStoppered = true;
    vStir.moles.C6H12_l = 0.04;
    vStir.moles.Br2_l = 0.04;
    vStir.stirTimer = 5.0;

    // 3) Instant kinetics isolation alongside slow kinetics
    const vInst = sim66.createApparatus('beaker_250', 600, 300);
    vInst.moles.NaC3H7O_s = 0.03;
    vInst.moles.H2O_l = 0.5;
    vInst.moles.CH3COOC3H7_l = 0.01;

    // Step 1 tick first to verify instant kinetics completes immediately & record early phaseContact rate
    vInst.tempK = 298.15;
    vStill.tempK = 298.15;
    vStir.tempK = 298.15;
    sim66.step(0.05);
    const instantOk =
      (vInst.moles.NaC3H7O_s || 0) < 1e-9 &&
      (vInst.moles.C3H7OH_l || 0) > 0.029 &&
      (vInst.moles.OH_aq || 0) > 0.029;
    const stir05 = vStir.moles.C6H12Br2_l || 0;
    const still05 = vStill.moles.C6H12Br2_l || 0;
    const phaseContactOk = stir05 > 0.002 && stir05 > still05 * 2.5;

    // 4) Advance reversible & phaseContact reactions for 4 seconds
    for (let i = 0; i < 8; i++) {
      vFwd.tempK = 353.15;
      vRev.tempK = 353.15;
      vStill.tempK = 298.15;
      vStir.tempK = 298.15;
      vStir.stirTimer = 3.0;
      sim66.step(0.5);
    }

    const fwdOk =
      (vFwd.moles.CH3COOC3H7_l || 0) > 0.01 &&
      (vFwd.moles.CH3COOH_l || 0) > 0.004;
    const revOk =
      (vRev.moles.CH3COOH_l || 0) > 0.008 &&
      (vRev.moles.C3H7OH_l || 0) > 0.008 &&
      (vRev.moles.CH3COOC3H7_l || 0) < 0.042;

    // 5) Property-driven combustion: Complete (open air) vs O2-starved (CO + C_s soot)
    const vBurnFull = sim66.createApparatus('crucible_porcelain', 720, 300);
    vBurnFull.moles.C6H12_l = 0.02;
    const vBurnLean = sim66.createApparatus('round_flask_250', 840, 300);
    vBurnLean.isStoppered = true;
    vBurnLean.sealedAirO2Moles = 0;
    vBurnLean.moles.C6H12_l = 0.04;
    vBurnLean.headspaceGasMoles.O2_g = 0.10; // Complete needs 0.36 mol O2 -> starved!

    for (let i = 0; i < 6; i++) {
      vBurnFull.tempK = 560.15;
      vBurnLean.tempK = 560.15;
      sim66.step(0.5);
    }
    const co2Made = (vBurnFull.escapedGasMoles?.CO2_g || 0) + (vBurnFull.headspaceGasMoles?.CO2_g || 0);
    const leanCO = (vBurnLean.headspaceGasMoles?.CO_g || 0) + (vBurnLean.escapedGasMoles?.CO_g || 0);
    const leanSoot = vBurnLean.moles.C_s || 0;
    const combustOk =
      co2Made > 0.05 &&
      (vBurnFull.moles.C_s || 0) === 0 &&
      (leanCO > 0.01 || leanSoot > 0.005) &&
      leanSoot > 0.002;

    // 6) Functional group rule (hasPeptideBond Biuret test) + Polymer visual rendering check
    const vBio = sim66.createApparatus('beaker_250', 960, 300);
    vBio.moles.H2O_l = 1.0;
    vBio.moles.Peptide_s = 0.04;
    vBio.moles.CuOH2_s = 0.02;
    vBio.moles.Na_aq = 0.05;
    vBio.moles.OH_aq = 0.05;
    for (let i = 0; i < 10; i++) {
      vBio.tempK = 298.15;
      sim66.step(0.5);
    }
    const biuretOk = (vBio.moles.CuPeptide_aq || 0) > 0.005;

    const polyCanvas = document.createElement('canvas');
    polyCanvas.width = 120;
    polyCanvas.height = 160;
    const polyCtx = polyCanvas.getContext('2d');
    const polyVessel = {
      moles: { PE_s: 0.05, PVC_s: 0.04, Buna_s: 0.04, Novolac_s: 0.04 },
      precipitateSettle: {},
      tempK: 298.15,
    };
    let polymerRenderOk =
      Boolean(SPECIES.PE_s?.isPolymer && SPECIES.PVC_s?.isPolymer && SPECIES.Buna_s?.isPolymer && SPECIES.Novolac_s?.isPolymer);
    try {
      renderVesselSolids(polyCtx, polyVessel, { left: 10, right: 110, bottom: 150, top: 10, width: 100 }, false, 150);
    } catch {
      polymerRenderOk = false;
    }

    assert(
      'Prompt 66 invariants: Modular organic engine, bidirectional reversible (0 reactant), anhydrous phaseContact, instant isolation, C_xH_y combustion (CO2 vs soot), Biuret peptide & polymer visuals',
      fwdOk && revOk && phaseContactOk && instantOk && combustOk && biuretOk && polymerRenderOk,
      `fwd=${fwdOk}(${JSON.stringify(vFwd.moles)}), rev=${revOk}(${JSON.stringify(vRev.moles)}), phase=${phaseContactOk}(stir=${stir05.toFixed(4)} vs still=${still05.toFixed(4)}), inst=${instantOk}, comb=${combustOk}(CO2=${co2Made.toFixed(3)},CO=${leanCO.toFixed(3)},soot=${leanSoot.toFixed(3)}), bio=${biuretOk}(${(vBio.moles.CuPeptide_aq || 0).toFixed(4)}), poly=${polymerRenderOk}`
    );
  }

  // TEST 185: Prompt 67 — Full Organic Ecosystem (Halo/Polymer/Aldehyde/Amine/AminoAcid/Sugar/Starch-I2)
  // & 3 Analytical Apparatus (pH/Conductometer Titration, Beer-Lambert Colorimeter, TLC Plate Rf)
  {
    const sim67 = new LabSimulation();

    // 1) Hydrocarbons + Halogen UV + Polymers (PS_s, PMMA_s)
    const vHexUv = sim67.createApparatus('round_flask_250', 100, 300);
    vHexUv.isStoppered = true;
    vHexUv.uvExposureActive = true;
    vHexUv.moles.C6H14_l = 0.05;
    vHexUv.moles.Br2_l = 0.05;

    const vPoly = sim67.createApparatus('round_flask_250', 220, 300);
    vPoly.isStoppered = true;
    vPoly.moles.C8H8_l = 0.04;
    vPoly.moles.MMA_l = 0.04;

    // 2) Oxygen ecosystem: Acetone Iodoform + Tripalmitin hot saponification + Propanal Tollens
    const vIodo = sim67.createApparatus('beaker_250', 340, 300);
    vIodo.moles.H2O_l = 1.0;
    vIodo.moles.CH3COCH3_l = 0.03;
    vIodo.moles.I2_aq = 0.06;
    vIodo.moles.OH_aq = 0.08;
    vIodo.moles.Na_aq = 0.08;
    vIodo.stirTimer = 4.0;

    const vPal = sim67.createApparatus('beaker_250', 460, 300);
    vPal.moles.H2O_l = 1.0;
    vPal.moles.C51H98O6_s = 0.02;
    vPal.moles.OH_aq = 0.08;
    vPal.moles.Na_aq = 0.08;
    vPal.stirTimer = 4.0;

    const vTol = sim67.createApparatus('beaker_250', 580, 300);
    vTol.moles.H2O_l = 1.0;
    vTol.moles.C2H5CHO_l = 0.03;
    vTol.moles.AgNH3_2_aq = 0.06;
    vTol.moles.OH_aq = 0.09;
    vTol.moles.NO3_aq = 0.03;
    vTol.moles.Na_aq = 0.06;

    // 3) Nitrogen & Bio: Aniline + Br2(aq) -> white ppt, Glycine amphoteric, Glucose vs Sucrose, Starch-I2 thermochromic
    const vAni = sim67.createApparatus('beaker_250', 700, 300);
    vAni.moles.H2O_l = 3.0;
    vAni.moles.C6H5NH2_l = 0.04;
    vAni.moles.Br2_aq = 0.06;
    vAni.stirTimer = 4.0;

    const vGlyA = sim67.createApparatus('beaker_250', 820, 300);
    vGlyA.moles.H2O_l = 3.0;
    vGlyA.moles.Glycine_aq = 0.03;
    vGlyA.moles.H_aq = 0.02;
    vGlyA.moles.Cl_aq = 0.02;

    const vGlyB = sim67.createApparatus('beaker_250', 940, 300);
    vGlyB.moles.H2O_l = 3.0;
    vGlyB.moles.Glycine_aq = 0.03;
    vGlyB.moles.OH_aq = 0.02;
    vGlyB.moles.Na_aq = 0.02;

    const vGlc = sim67.createApparatus('beaker_250', 140, 440);
    vGlc.moles.H2O_l = 1.0;
    vGlc.moles.Glucose_aq = 0.04;
    vGlc.moles.CuOH2_s = 0.02;
    vGlc.moles.OH_aq = 0.05;
    vGlc.moles.Na_aq = 0.05;

    const vSuc = sim67.createApparatus('beaker_250', 260, 440);
    vSuc.moles.H2O_l = 1.0;
    vSuc.moles.Sucrose_aq = 0.04;
    vSuc.moles.CuOH2_s = 0.02;
    vSuc.moles.OH_aq = 0.05;
    vSuc.moles.Na_aq = 0.05;

    const vStarch = sim67.createApparatus('beaker_250', 380, 440);
    vStarch.moles.H2O_l = 1.0;
    vStarch.moles.Starch_aq = 0.02;
    vStarch.moles.I2_aq = 0.01;

    // Step cold / moderate first (StarchI2 forms cold, Glucose/Sucrose Cu(OH)2 room-T chelation)
    for (let i = 0; i < 6; i++) {
      vPoly.tempK = 368.15;
      vIodo.tempK = 315.15;
      vPal.tempK = 353.15;
      vTol.tempK = 328.15;
      vGlc.tempK = 298.15;
      vSuc.tempK = 298.15;
      vStarch.tempK = 295.15;
      sim67.step(0.5);
    }
    const coldStarchComplex = vStarch.moles.StarchI2_aq || 0;
    const coldGlcBlue = vGlc.moles.CuGlc2_aq || 0;
    const coldSucBlue = vSuc.moles.CuSuc2_aq || 0;

    // Warm Glucose & Sucrose -> Cu2O↓ for Glucose ONLY; Warm Starch -> StarchI2 dissociates!
    for (let i = 0; i < 8; i++) {
      vGlc.tempK = 358.15;
      vSuc.tempK = 358.15;
      vStarch.tempK = 358.15;
      sim67.step(0.5);
    }
    const hotStarchComplex = vStarch.moles.StarchI2_aq || 0;

    // Cool Starch back down -> navy-blue complex returns reversibly!
    for (let i = 0; i < 6; i++) {
      vStarch.tempK = 293.15;
      sim67.step(0.5);
    }
    const reCooledStarch = vStarch.moles.StarchI2_aq || 0;

    const hexUvOk = (vHexUv.moles.C6H13Br_l || 0) > 0.008 && ((vHexUv.headspaceGasMoles?.HBr_g || 0) + (vHexUv.escapedGasMoles?.HBr_g || 0)) > 0.008;
    const polyOk = (vPoly.moles.PS_s || 0) > 0.005 && (vPoly.moles.PMMA_s || 0) > 0.005 && SPECIES.PS_s.isPolymer && SPECIES.PP_s.isPolymer && SPECIES.PMMA_s.isPolymer;
    const iodoPalTolOk = (vIodo.moles.CHI3_s || 0) > 0.005 && (vPal.moles.C15H31COO_aq || 0) > 0.01 && (vTol.moles.Ag_s || 0) > 0.02;
    const aniGlyOk = (vAni.moles.C6H2Br3NH2_s || 0) > 0.005 && (vGlyA.moles.Glycinium_aq || 0) > 0.015 && (vGlyB.moles.Glycinate_aq || 0) > 0.015;
    const carbOk =
      coldGlcBlue > 0.005 &&
      coldSucBlue > 0.005 &&
      (vGlc.moles.Cu2O_s || 0) > 0.004 &&
      (vSuc.moles.Cu2O_s || 0) === 0 &&
      coldStarchComplex > 0.006 &&
      hotStarchComplex < coldStarchComplex * 0.45 &&
      reCooledStarch > hotStarchComplex * 1.6;

    // 4) Analytical Trio: pH/Conductivity Titration Probe, Beer-Lambert Colorimeter, TLC Plate
    const simAna = new LabSimulation();
    const vTit = simAna.createApparatus('beaker_250', 300, 380);
    vTit.moles.H2O_l = 2.0;
    vTit.moles.H_aq = 0.05;
    vTit.moles.Cl_aq = 0.05;
    const bur = simAna.createApparatus('burette_50', 300, 200);
    bur.moles.H2O_l = 1.5;
    bur.moles.OH_aq = 0.08;
    bur.moles.Na_aq = 0.08;

    const phMeter = simAna.createApparatus('ph_conductometer', 300, 305);
    const tipYPh = phMeter.y + APPARATUS.ph_conductometer.height / 2 - 6;
    if (tipYPh < vTit.y - APPARATUS.beaker_250.height / 2) phMeter.y = vTit.y - 40;

    for (let d = 0; d < 4; d++) {
      simAna.buretteDispenseDrop(bur.id, 2.5);
      simAna.step(0.5);
    }
    const phProbeOk =
      phMeter.contactVesselId === vTit.id &&
      phMeter.measuredPH != null &&
      phMeter.measuredConductivity > 5 &&
      (vTit.buretteDeliveredMl || 0) >= 9.9 &&
      phMeter.history.length >= 2;

    const vCol = simAna.createApparatus('beaker_250', 520, 380);
    vCol.moles.H2O_l = 2.0;
    vCol.moles.MnO4_aq = 0.0005;
    vCol.moles.K_aq = 0.0005;
    const colorimeter = simAna.createApparatus('colorimeter', 520, 330);
    colorimeter.wavelengthNm = 525;
    simAna.step(0.5);
    const a525 = colorimeter.measuredAbsorbance;
    const a635 = computeBeerLambertReading(vCol, 635).absorbance;
    const colorimeterOk = a525 > 0.5 && a525 > a635 * 10 && colorimeter.history.length >= 1;

    const vTlcMix = simAna.createApparatus('beaker_250', 740, 380);
    vTlcMix.moles.C6H14_l = 0.15;
    vTlcMix.moles.CH3COOC3H7_l = 0.10;
    vTlcMix.moles.C8H8_l = 0.03;
    vTlcMix.moles.C2H5COOH_l = 0.03;
    const tlc = simAna.createApparatus('tlc_plate', 740, 355);
    for (let i = 0; i < 6; i++) simAna.step(0.5);
    const stySpot = (tlc.spots || []).find((s) => s.id === 'C8H8_l');
    const acidSpot = (tlc.spots || []).find((s) => s.id === 'C2H5COOH_l');
    const tlcOk = tlc.solventFront > 0.3 && stySpot && acidSpot && stySpot.rf > acidSpot.rf;

    const cvs = document.createElement('canvas');
    cvs.width = 180;
    cvs.height = 180;
    const cctx = cvs.getContext('2d');
    let anaRenderOk = true;
    try {
      renderPhConductometer(cctx, phMeter, true, true, 'vi');
      renderColorimeter(cctx, colorimeter, false, true);
      renderTlcPlate(cctx, tlc, true, true, true);
    } catch {
      anaRenderOk = false;
    }

    assert(
      'Prompt 67 invariants: Full organic ecosystem (UV halo, polymers, iodoform/palmitate/Tollens, aniline/glycine/Glucose-Sucrose/Starch-I2 thermochromic) & Analytical Trio (pH/EC curve, Beer-Lambert A, TLC Rf)',
      hexUvOk && polyOk && iodoPalTolOk && aniGlyOk && carbOk && phProbeOk && colorimeterOk && tlcOk && anaRenderOk,
      `uv=${hexUvOk}, poly=${polyOk}, oxy=${iodoPalTolOk}, nbio=${aniGlyOk}(ani=${(vAni.moles.C6H2Br3NH2_s||0).toFixed(4)},glyA=${(vGlyA.moles.Glycinium_aq||0).toFixed(4)},glyB=${(vGlyB.moles.Glycinate_aq||0).toFixed(4)}), carb=${carbOk}(st:${coldStarchComplex.toFixed(4)}->${hotStarchComplex.toFixed(4)}->${reCooledStarch.toFixed(4)},glcCu2O:${(vGlc.moles.Cu2O_s||0).toFixed(4)}), phEC=${phProbeOk}(pts=${phMeter.history.length},k=${(phMeter.measuredConductivity||0).toFixed(1)}), beer=${colorimeterOk}(A525=${a525.toFixed(2)},A635=${a635.toFixed(3)}), tlc=${tlcOk}(sf=${tlc.solventFront.toFixed(2)},sty=${stySpot?.rf},acid=${acidSpot?.rf}), rnd=${anaRenderOk}`
    );
  }
}
