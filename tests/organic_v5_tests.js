/**
 * Modular Verification Suite for Organic Solver v5 Architecture & Beyond (Prompt 66+).
 */
import { APP_VERSION_TAG, CONSTANTS } from '../src/data/constants.js';
import { APPARATUS } from '../src/data/apparatus.js';
import { SPECIES } from '../src/data/species.js';
import { LabSimulation } from '../src/engine/simulation.js';
import { stepVesselChemistry } from '../src/engine/chemistry.js';
import { computePhaseStratification, computeSolutionVisuals, computeLiquidVolumeL, computePH } from '../src/engine/equilibrium.js';
import { renderVesselSolids } from '../src/canvas/chemicalVisuals.js';
import { computeBeerLambertReading } from '../src/engine/analyticalTools.js';
import { renderColorimeter, renderPhConductometer, renderTlcPlate } from '../src/canvas/toolRenderer.js';
import { PRESET_MENU_ITEMS } from '../src/data/presets.js';
import { I18N } from '../src/data/i18n.js';
import { InspectorPanel } from '../src/ui/inspectorPanel.js';
import { EnvironmentBar } from '../src/ui/environmentBar.js';
import { renderRetortClampJaw } from '../src/canvas/vesselRenderer.js';

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

  // TEST 186: Prompt 68 — Adaptive Sub-stepping, Sealed Saturated Vapor Overpressure (Stopper Pop),
  // Cooling / Dissolution Suck-back, & Guided Experiments ('Thí nghiệm mẫu') Presets Registry
  {
    // 1) Presets registry & bilingual VI/EN parity ('Thí nghiệm mẫu:' / 'Guided Experiments:')
    const sim68 = new LabSimulation();
    const presetsTranslated =
      I18N.vi.quickPresets.includes('Thí nghiệm mẫu') &&
      I18N.en.quickPresets.includes('Guided Experiments') &&
      PRESET_MENU_ITEMS.every((p) => Boolean(I18N.vi[p.i18nKey] && I18N.en[p.i18nKey]));

    sim68.setupPreset('ester_distill');
    const esterHasFlaskCond = sim68.items.some((i) => i.typeId === 'round_flask_250') && sim68.items.some((i) => i.typeId === 'liebig_condenser');
    sim68.setupPreset('titration_probe');
    const titProbeOk = sim68.items.some((i) => i.kind === 'burette') && sim68.items.some((i) => i.kind === 'ph_conductometer');
    sim68.setupPreset('starch_colorimetry');
    const colPresetOk = sim68.items.some((i) => i.kind === 'colorimeter') && sim68.items.some((i) => i.moles?.Starch_aq > 0);
    const presetsOk = presetsTranslated && esterHasFlaskCond && titProbeOk && colPresetOk;

    // 2) Adaptive sub-stepping activates finer step splitting under vigorous / alkali / high-T kinetics
    const simAda = new LabSimulation();
    const vCalm = simAda.createApparatus('beaker_250', 200, 380);
    vCalm.moles = { H2O_l: 2.0 };
    const vVig = simAda.createApparatus('beaker_250', 420, 380);
    vVig.moles = { H2O_l: 2.0, Na_s: 0.01 };
    simAda.step(0.05);
    const adaptiveOk = (vCalm.lastAdaptiveSubsteps || 0) === 1 && (vVig.lastAdaptiveSubsteps || 0) >= 4;

    // 3) Sealed volatile organic vapor overpressure -> pops rubber_stopper cleanly!
    const simPop = new LabSimulation();
    const vSeal = simPop.createApparatus('erlenmeyer_250', 260, 360);
    vSeal.isStoppered = true;
    vSeal.stopperMode = 'solid';
    vSeal.moles.CH3COCH3_l = 0.25; // Boils at 56.1 C (329.2 K)
    let popped = false;
    for (let i = 0; i < 16; i++) {
      vSeal.tempK = 355.15; // 82 C sealed vapor > 2 bar -> exceeds popOverpressureBar (+0.38 bar)
      simPop.step(0.25);
      if (!vSeal.isStoppered) {
        popped = true;
        break;
      }
    }

    // 4) Thermal contraction & soluble-gas suck-back through submerged delivery tube
    const simSuck = new LabSimulation();
    const vGen = simSuck.createApparatus('erlenmeyer_250', 240, 360);
    const vRecv = simSuck.createApparatus('beaker_250', 480, 360);
    vGen.isStoppered = true;
    vGen.moles.H2O_l = 0.1;
    vGen.tempK = 393.15; // Hot flask connected to submerged tube vents expanding air cleanly
    vRecv.moles.H2O_l = 8.0;
    simSuck.connectTube(vGen.id, vRecv.id);
    for (let i = 0; i < 4; i++) {
      vGen.tempK = 393.15;
      simSuck.step(0.25);
    }
    const waterBeforeCool = vGen.moles.H2O_l || 0;
    const airAfterHeat = vGen.sealedAirMoles || 0;
    for (let i = 0; i < 8; i++) {
      vGen.tempK = 278.15; // Rapid cooling contracts sealed gas < 1 bar -> liquid sucked back!
      simSuck.step(0.25);
    }
    const suckBackOk =
      (vGen.moles.H2O_l || 0) > waterBeforeCool + 0.05 &&
      simSuck.logs.some((l) => l.key === 'alertTubeSuckBack' || l.equation?.includes('Phun trào'));

    assert(
      'Prompt 68 invariants: Guided presets registry & 1-click organic/analytical benches, 4x adaptive sub-stepping, volatile vapor stopper_pop & cooling suck-back',
      presetsOk && adaptiveOk && popped && suckBackOk,
      `presets=${presetsOk}, adaptive=${adaptiveOk}(calm=${vCalm.lastAdaptiveSubsteps},vig=${vVig.lastAdaptiveSubsteps}), pop=${popped}(p=${(vSeal.internalPressureBar||0).toFixed(2)}), suck=${suckBackOk}(H2O:${waterBeforeCool.toFixed(2)}->${(vGen.moles.H2O_l||0).toFixed(2)},p=${(vGen.internalPressureBar||0).toFixed(2)},air=${airAfterHeat.toFixed(4)})`
    );
  }

  // TEST 187: Prompt 69 — Colorimeter Wavelength Sync + Immediate Recalc, Probe Clamping to Retort Stand,
  // Clamp Jaw Fit & Presets Suspended Immersion
  {
    const sim69 = new LabSimulation();
    sim69.setupPreset('starch_colorimetry');
    const col = sim69.items.find((i) => i.kind === 'colorimeter');
    const standCol = sim69.items.find((i) => i.kind === 'stand');
    sim69.step(0.5);
    const colYAfterStep = col.y;
    const clampedColOk = Boolean(
      APPARATUS.colorimeter.supportsClamp &&
      APPARATUS.ph_conductometer.supportsClamp &&
      APPARATUS.tlc_plate.supportsClamp &&
      APPARATUS.colorimeter.neckRadius <= 8 &&
      col.clampedToId === standCol?.id &&
      col.contactVesselId != null &&
      col.measuredAbsorbance > 0.2 &&
      Math.abs(col.y - colYAfterStep) < 1
    );

    // Mount InspectorPanel in headless DOM to verify wavelength switch syncs UI, clears history, & recalculates A immediately
    const hostDiv = document.createElement('div');
    document.body.appendChild(hostDiv);
    const tVi69 = (k) => I18N.vi[k] || k;
    const insp = new InspectorPanel(hostDiv, sim69, () => tVi69, { getLabsMeta: () => null });
    sim69.selectedId = col.id;
    insp.update('vi', true);
    const sig590 = insp.getStructureSignature(tVi69, 'vi');
    const wlBtn420 = hostDiv.querySelector('.col-wl-btn[data-wl="420"]');
    const colBeforeAbs = col.measuredAbsorbance;
    wlBtn420?.click();
    insp.update('vi');
    const sig420 = insp.getStructureSignature(tVi69, 'vi');
    const wlLabelAfter = hostDiv.querySelector('#live-col-wl')?.textContent?.trim();
    const btn420Highlighted = hostDiv.querySelector('.col-wl-btn[data-wl="420"]')?.className?.includes('sky-500');
    const hasClampBtn = Boolean(hostDiv.querySelector('#ins-toggle-clamp'));
    const syncOk =
      sig590 !== sig420 &&
      col.wavelengthNm === 420 &&
      wlLabelAfter === '420 nm' &&
      Boolean(btn420Highlighted) &&
      hasClampBtn &&
      col.measuredAbsorbance < colBeforeAbs;
    document.body.removeChild(hostDiv);

    // Verify titration_probe clamps ph_conductometer onto stand cleanly without falling
    sim69.setupPreset('titration_probe');
    const phProbe = sim69.items.find((i) => i.kind === 'ph_conductometer');
    sim69.step(0.5);
    const clampedPhOk = Boolean(phProbe?.clampedToId) && phProbe?.contactVesselId != null && phProbe?.measuredPH != null;

    // Verify miniature clamp jaw renders cleanly without throwing
    const jCanvas = document.createElement('canvas');
    jCanvas.width = 160;
    jCanvas.height = 160;
    const jCtx = jCanvas.getContext('2d');
    let jawRenderOk = true;
    try {
      const stand2 = sim69.items.find((i) => i.id === phProbe.clampedToId);
      renderRetortClampJaw(jCtx, stand2, phProbe, true);
    } catch {
      jawRenderOk = false;
    }

    assert(
      'Prompt 69 invariants: Colorimeter wavelength UI/Canvas sync & instant recalc, probe supportsClamp + wide reach + sleek jaws, clamped starch_colorimetry & titration_probe presets',
      clampedColOk && syncOk && clampedPhOk && jawRenderOk,
      `colClamp=${clampedColOk}(A=${(col.measuredAbsorbance||0).toFixed(2)},cl=${col.clampedToId}), sync=${syncOk}(wl=${wlLabelAfter},hi=${btn420Highlighted},btn=${hasClampBtn}), phClamp=${clampedPhOk}(pH=${phProbe?.measuredPH?.toFixed(2)}), jaw=${jawRenderOk}`
    );
  }

  // TEST 188: Prompt 70 — Header Version Badge Dynamic Sync, Saponification Realism & Hazards,
  // and Fischer Esterification Catalysis, Overheating & Purification Cascade
  {
    // 1) Header version badge sync (never hardcoded stale v4+build.24)
    const sim70 = new LabSimulation();
    const envHost = document.createElement('div');
    document.body.appendChild(envHost);
    const appState = { lang: 'vi', theme: 'dark', deviceMode: 'desktop', audioEnabled: false };
    const bar70 = new EnvironmentBar(envHost, sim70, appState, {});
    bar70.render((k) => I18N.vi[k] || k);
    const badgeText = envHost.querySelector('#app-version-badge')?.textContent?.trim();
    const headerSyncOk =
      badgeText === APP_VERSION_TAG &&
      !badgeText.includes('v4+build.24') &&
      I18N.vi.appSubtitle.includes(APP_VERSION_TAG) &&
      I18N.en.appSubtitle.includes(APP_VERSION_TAG);
    document.body.removeChild(envHost);

    // 2a) Saponification: Too-conc alkali (>45 wt% NaOH) causes early salting-out crust passivation; diluting resumes conversion
    const vConcBase = sim70.createApparatus('beaker_250', 100, 300);
    vConcBase.stirTimer = 8;
    // 55 wt% NaOH (~0.40 mol NaOH = 16g + ~0.72 mol H2O = 13g) + 0.02 mol Triolein
    vConcBase.moles = { C57H104O6_l: 0.02, Na_aq: 0.40, OH_aq: 0.40, H2O_l: 0.72 };
    const vNormBase = sim70.createApparatus('beaker_250', 220, 300);
    vNormBase.stirTimer = 8;
    // 25 wt% NaOH (0.12 mol NaOH = 4.8g + 0.80 mol H2O = 14.4g) + 0.02 mol Triolein
    vNormBase.moles = { C57H104O6_l: 0.02, Na_aq: 0.12, OH_aq: 0.12, H2O_l: 0.80 };
    for (let i = 0; i < 6; i++) {
      vConcBase.tempK = 358.15;
      vNormBase.tempK = 358.15;
      vConcBase.stirTimer = 5;
      vNormBase.stirTimer = 5;
      sim70.step(0.5);
    }
    const concAlertOk =
      vConcBase.soapConcPassivated === true &&
      (vNormBase.moles.C17H33COO_aq || 0) > (vConcBase.moles.C17H33COO_aq || 0) * 1.8 &&
      sim70.logs.some((l) => l.key === 'alertSoapConcAlkaliPassivate');
    // Dilute conc batch with hot water -> passivation clears and saponification resumes!
    vConcBase.moles.H2O_l += 1.6;
    const soapBeforeDil = vConcBase.moles.C17H33COO_aq || 0;
    for (let i = 0; i < 8; i++) {
      vConcBase.tempK = 358.15;
      vConcBase.stirTimer = 5;
      sim70.step(0.5);
    }
    const dilResumeOk = !vConcBase.soapConcPassivated && (vConcBase.moles.C17H33COO_aq || 0) > soapBeforeDil + 0.005;

    // 2b) Premature brine traps lipid vs post-reaction brine yields floating soap cake + foam + glycerol Cu(OH)2 check
    const vEarlySalt = sim70.createApparatus('beaker_250', 340, 300);
    vEarlySalt.moles = { C57H104O6_l: 0.02, Na_aq: 0.35, OH_aq: 0.12, Cl_aq: 0.23, H2O_l: 2.2, C17H33COO_aq: 0.004 };
    const vDoneSalt = sim70.createApparatus('beaker_250', 460, 300);
    vDoneSalt.moles = { C57H104O6_l: 0.01, Na_aq: 0.16, OH_aq: 0.16, H2O_l: 1.5, C2H5OH_l: 0.08 };
    for (let i = 0; i < 6; i++) {
      vEarlySalt.tempK = 358.15;
      sim70.step(0.4);
    }
    const earlyBrineOk = vEarlySalt.soapEarlySalted === true && sim70.logs.some((l) => l.key === 'alertSoapEarlyBrine');
    for (let i = 0; i < 24; i++) {
      vDoneSalt.tempK = 358.15;
      vDoneSalt.stirTimer = 4;
      sim70.step(0.5);
    }
    const foamDoneOk =
      (vDoneSalt.soapFoamMl || 0) > 1.0 &&
      vDoneSalt.saponificationComplete === true &&
      (vDoneSalt.moles.C57H104O6_l || 0) <= 1e-4 &&
      sim70.logs.some((l) => l.key === 'alertSoapComplete');
    // Now add saturated NaCl post-completion -> clean floating cake + Cu(OH)2 glycerol check + renderCanvas ok
    vDoneSalt.moles.Na_aq = (vDoneSalt.moles.Na_aq || 0) + 0.55;
    vDoneSalt.moles.Cl_aq = (vDoneSalt.moles.Cl_aq || 0) + 0.55;
    for (let i = 0; i < 6; i++) {
      vDoneSalt.tempK = 328.15;
      sim70.step(0.4);
    }
    vDoneSalt.moles.CuOH2_s = 0.008;
    sim70.step(0.5);
    const postBrineCakeOk =
      vDoneSalt.soapSaltedOutCake === true &&
      (vDoneSalt.moles.C17H33COONa_s || 0) > 0.015 &&
      (vDoneSalt.moles.CuC2H4O2_aq || 0) > 0.001;
    const fCanvas = document.createElement('canvas');
    fCanvas.width = 180;
    fCanvas.height = 240;
    let soapRenderOk = true;
    try {
      renderVesselSolids(fCanvas.getContext('2d'), vDoneSalt, { left: 20, right: 160, top: 20, bottom: 220, width: 140 }, true, 85);
    } catch {
      soapRenderOk = false;
    }

    // 2c) Water-depletion scorching at >= 100 C when water drops very low
    const vScorch = sim70.createApparatus('beaker_250', 560, 300);
    vScorch.moles = { C17H33COO_aq: 0.04, Na_aq: 0.06, OH_aq: 0.02, C3H5OH_3_l: 0.013, H2O_l: 0.03 };
    for (let i = 0; i < 6; i++) {
      vScorch.tempK = 378.15;
      sim70.step(0.4);
    }
    const visScorch = computeSolutionVisuals(
      vScorch.moles,
      computeLiquidVolumeL(vScorch.moles, vScorch.tempK),
      computePH(vScorch.moles, 0.02, vScorch.tempK),
      4,
      0,
      0,
      { phaseFilter: 'aq', soapScorchFrac: vScorch.soapScorchFrac || 0 }
    );
    const scorchOk =
      vScorch.soapScorched === true &&
      (vScorch.soapScorchFrac || 0) > 0.16 &&
      visScorch.r > visScorch.b + 10 &&
      sim70.logs.some((l) => l.key === 'alertSoapScorch');

    // 3) Fischer Esterification: Conc acid hazard pour + Conc H2SO4 dehydrating excess >66.7% + overheating amber + NaCl/Na2CO3/CaCl2 purification
    const vAcidBad = sim70.createApparatus('round_flask_250', 120, 460);
    vAcidBad.moles = { H2SO4_l: 0.18 };
    sim70.addReagentToVessel(vAcidBad.id, 'etoh', 10);
    const pourHazardOk = sim70.logs.some((l) => l.key === 'alertEsterConcAcidPour');

    const vOverheat = sim70.createApparatus('round_flask_250', 240, 460);
    vOverheat.moles = { CH3COOH_l: 0.08, C2H5OH_l: 0.04, H2SO4_l: 0.18 };
    for (let i = 0; i < 6; i++) {
      vOverheat.tempK = 416.15; // 143 C sustained overheat with conc. H2SO4!
      stepVesselChemistry(vOverheat, 0.4, { environment: sim70.environment });
    }
    sim70.step(0.05); // Flush _esterOverheatAlertPending to sim70.logs
    const visOverheat = computeSolutionVisuals(
      vOverheat.moles,
      computeLiquidVolumeL(vOverheat.moles, vOverheat.tempK),
      1,
      4,
      0,
      0,
      { phaseFilter: 'all', esterOverheatFrac: vOverheat.esterOverheatFrac || 0 }
    );
    const overheatOk =
      (vOverheat.esterOverheatFrac || 0) > 0.25 &&
      visOverheat.r > visOverheat.b + 15 &&
      sim70.logs.some((l) => l.key === 'alertEsterOverheat');

    // Purification cascade: EtOAc + EtOH + H2O -> brine salting-out -> Na2CO3 neutralization -> CaCl2 drying
    const vPure = sim70.createApparatus('beaker_250', 380, 460);
    vPure.moles = { CH3COOC2H5_l: 0.10, CH3COOH_l: 0.015, C2H5OH_l: 0.05, H2O_l: 1.5 };
    const stratPreSalt = computePhaseStratification(vPure.moles, 298.15, APPARATUS.beaker_250, 0);
    // Wash 1: CO3^2- neutralizes residual Acetic acid evolving CO2_g
    vPure.moles.Na_aq = 0.28;
    vPure.moles.CO3_2_aq = 0.02;
    vPure.moles.Cl_aq = 0.24; // NaCl + Na2CO3 wash
    const co2BeforeWash = vPure.escapedGasMoles?.CO2_g || vPure.headspaceGasMoles?.CO2_g || 0;
    for (let i = 0; i < 6; i++) {
      vPure.tempK = 298.15;
      sim70.step(0.5);
    }
    const co2TotalWash = (vPure.escapedGasMoles?.CO2_g || 0) + (vPure.headspaceGasMoles?.CO2_g || 0);
    const stratPostSalt = computePhaseStratification(vPure.moles, 298.15, APPARATUS.beaker_250, 0);
    // Decant water/EtOH and dry with anhydrous CaCl2_s
    vPure.moles = { CH3COOC2H5_l: 0.095, CaCl2_s: 0.02, H2O_l: 0.015, C2H5OH_l: 0.01 };
    for (let i = 0; i < 4; i++) {
      vPure.tempK = 298.15;
      sim70.step(0.4);
    }
    const purifyOk =
      stratPostSalt.lightOrganicMl > stratPreSalt.lightOrganicMl + 0.5 &&
      co2TotalWash > co2BeforeWash + 0.005 &&
      vPure.esterPurified === true;

    assert(
      'Prompt 70 invariants: Dynamic header build badge, conc alkali passivation + early/post brine floating soap cake + scorch + glycerol Cu(OH)2, conc H2SO4 hazard/overheat amber & NaCl/Na2CO3/CaCl2 ester purification',
      headerSyncOk && concAlertOk && dilResumeOk && earlyBrineOk && foamDoneOk && postBrineCakeOk && soapRenderOk && scorchOk && pourHazardOk && overheatOk && purifyOk,
      `hdr=${headerSyncOk}(${badgeText}), conc=${concAlertOk}, dil=${dilResumeOk}, early=${earlyBrineOk}, foam=${foamDoneOk}, cake=${postBrineCakeOk}, ren=${soapRenderOk}, scorch=${scorchOk}, pour=${pourHazardOk}, ovh=${overheatOk}(f=${(vOverheat.esterOverheatFrac||0).toFixed(2)}), pur=${purifyOk}(light:${stratPreSalt.lightOrganicMl.toFixed(1)}->${stratPostSalt.lightOrganicMl.toFixed(1)},CO2=${co2TotalWash.toFixed(3)})`
    );
  }
}
