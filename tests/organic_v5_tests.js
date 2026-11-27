/**
 * Modular Verification Suite for Organic Solver v5 Architecture & Beyond (Prompt 66+).
 */
import { APP_VERSION_TAG, CONSTANTS } from '../src/data/constants.js';
import { APPARATUS, APPARATUS_ORDER } from '../src/data/apparatus.js';
import { SPECIES, STARTER_REAGENTS } from '../src/data/species.js';
import { LabSimulation } from '../src/engine/simulation.js';
import { stepVesselChemistry } from '../src/engine/chemistry.js';
import { computePhaseStratification, computeSolutionVisuals, computeLiquidVolumeL, computePH, computeVesselAroma } from '../src/engine/equilibrium.js';
import { renderVesselSolids } from '../src/canvas/chemicalVisuals.js';
import { computeBeerLambertReading, computeIrSpectrum, computeUvVisSpectrum, stepAnalyticalInstruments } from '../src/engine/analyticalTools.js';
import { renderBoilingChips, renderColorimeter, renderPhConductometer, renderTlcPlate } from '../src/canvas/toolRenderer.js';
import { PRESET_MENU_ITEMS } from '../src/data/presets.js';
import { I18N } from '../src/data/i18n.js';
import { InspectorPanel } from '../src/ui/inspectorPanel.js';
import { EnvironmentBar } from '../src/ui/environmentBar.js';
import { LabWorkbenchCanvas } from '../src/canvas/workbench.js';
import { ParticleSystem } from '../src/canvas/particles.js';
import { FluidGasOverlay } from '../src/canvas/fluidGasOverlay.js';
import { ShelfPanel } from '../src/ui/shelfPanel.js';
import { serializeWorkspace, serializeWorkspaceJson, initWorkspacePersistence } from '../src/storage/workspaceStorage.js';
import { LabManager } from '../src/engine/labManager.js';
import { renderRetortClampJaw, renderVessel, getVesselGlassShellCacheSize } from '../src/canvas/vesselRenderer.js';

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

  // TEST 189: Prompt 71 — Tripalmitin ESTER_KINETICS, KOH vs NaOH Soft Gel, Vapor Aroma Telemetry,
  // Strict Conc vs Dilute H2SO4 Esterification (Ethanol + Isoamyl) & Boiling Chips ('boiling_chips') Anti-Bumping Tool
  {
    const sim71 = new LabSimulation();

    // 1) boiling_chips equipment registry + placement + anti-bumping boiling physics + render test
    const hasChipsSpec = Boolean(APPARATUS.boiling_chips) && APPARATUS_ORDER.includes('boiling_chips');
    const stand1 = sim71.createApparatus('retort_stand', 140, 310);
    const tubeNoChips = sim71.createApparatus('test_tube_50', 140, 290);
    tubeNoChips.clampedToId = stand1.id;
    tubeNoChips.moles = { C2H5OH_l: 0.25 };
    const burner1 = sim71.createApparatus('bunsen_burner', 140, 418);
    sim71.setBurnerFlame(burner1.id, 2);
    burner1.airHoleOpen = true;

    const stand2 = sim71.createApparatus('retort_stand', 260, 310);
    const tubeWithChips = sim71.createApparatus('test_tube_50', 260, 290);
    tubeWithChips.clampedToId = stand2.id;
    tubeWithChips.moles = { C2H5OH_l: 0.25 };
    const burner2 = sim71.createApparatus('bunsen_burner', 260, 418);
    sim71.setBurnerFlame(burner2.id, 2);
    burner2.airHoleOpen = true;
    const chips = sim71.createApparatus('boiling_chips', 260, 290);
    sim71.insertBoilingChipsIntoVessel(chips.id, tubeWithChips.id);

    for (let i = 0; i < 18; i++) {
      tubeNoChips.tempK = 358.15;
      tubeWithChips.tempK = 358.15;
      sim71.step(0.25);
    }
    const bumpingOk =
      hasChipsSpec &&
      tubeWithChips.hasBoilingChips === true &&
      (tubeWithChips.bumpingSurgeFrac || 0) === 0 &&
      (tubeNoChips.bumpingSurgeFrac || 0) > 0.2 &&
      sim71.logs.some((l) => l.key === 'alertBoilingBumping');
    const cChip = document.createElement('canvas');
    cChip.width = 160;
    cChip.height = 160;
    let chipRenderOk = true;
    try {
      const chipsBench = sim71.createApparatus('boiling_chips', 80, 80);
      renderBoilingChips(cChip.getContext('2d'), chipsBench, false, true);
    } catch {
      chipRenderOk = false;
    }

    // 2) Tripalmitin (C51H98O6_s) autocatalytic saponification + conc alkali passivation + KOH vs NaOH distinction
    const vPalm = sim71.createApparatus('beaker_250', 400, 300);
    vPalm.moles = { C51H98O6_s: 0.01, Na_aq: 0.16, OH_aq: 0.16, H2O_l: 1.5, C2H5OH_l: 0.08 };
    const vKoh = sim71.createApparatus('beaker_250', 520, 300);
    vKoh.moles = { C57H104O6_l: 0.01, K_aq: 0.25, OH_aq: 0.25, H2O_l: 1.8, C2H5OH_l: 0.08 };
    for (let i = 0; i < 20; i++) {
      vPalm.tempK = 358.15;
      vPalm.stirTimer = 4;
      vKoh.tempK = 358.15;
      vKoh.stirTimer = 4;
      sim71.step(0.5);
    }
    vPalm.moles.Na_aq = (vPalm.moles.Na_aq || 0) + 0.55;
    vPalm.moles.Cl_aq = 0.55;
    for (let i = 0; i < 6; i++) {
      vPalm.tempK = 328.15;
      sim71.step(0.4);
    }
    const tripalmOk =
      (vPalm.moles.C15H31COONa_s || 0) > 0.015 &&
      (vPalm.moles.C3H5OH_3_l || 0) > 0.008 &&
      vPalm.soapSaltedOutCake === true;
    const kohGelOk =
      (vKoh.moles.C17H33COO_aq || 0) > 0.015 &&
      (vKoh.moles.C17H33COONa_s || 0) === 0 &&
      vKoh.soapSaltedOutCake === false &&
      vKoh.soapSoftPotassiumGel === true;

    // 3) Strict conc vs dilute H2SO4 for both CH3COOH + C2H5OH and CH3COOH + Isoamyl alcohol (C5H11OH_l)
    const vConcEt = sim71.createApparatus('round_flask_250', 640, 300);
    vConcEt.isStoppered = true;
    vConcEt.moles = { CH3COOH_l: 0.15, C2H5OH_l: 0.15, H2SO4_l: 0.08 };
    const vDilEt = sim71.createApparatus('round_flask_250', 740, 300);
    vDilEt.isStoppered = true;
    vDilEt.moles = { CH3COOH_l: 0.15, C2H5OH_l: 0.15, H2SO4_l: 0.015, H2O_l: 2.0 };
    const vIsoConc = sim71.createApparatus('round_flask_250', 840, 300);
    vIsoConc.isStoppered = true;
    vIsoConc.moles = { CH3COOH_l: 0.10, C5H11OH_l: 0.10, H2SO4_l: 0.05 };
    const vIsoDil = sim71.createApparatus('round_flask_250', 920, 300);
    vIsoDil.isStoppered = true;
    vIsoDil.moles = { CH3COOH_l: 0.10, C5H11OH_l: 0.10, H_aq: 0.05, H2O_l: 1.5 };
    for (let i = 0; i < 16; i++) {
      for (const vv of [vConcEt, vDilEt, vIsoConc, vIsoDil]) {
        vv.tempK = 351.15;
        stepVesselChemistry(vv, 0.4, { environment: sim71.environment });
      }
    }
    const esterConcOk =
      (vConcEt.moles.CH3COOC2H5_l || 0) > (vDilEt.moles.CH3COOC2H5_l || 0) * 5 &&
      (vConcEt.moles.CH3COOC2H5_l || 0) > 0.08 &&
      (vIsoConc.moles.CH3COOC5H11_l || 0) > (vIsoDil.moles.CH3COOC5H11_l || 0) * 3;

    // 4) Vapor Aroma telemetry across reaction stages + InspectorPanel HTML rendering
    const aromaVinegar = computeVesselAroma({ moles: { CH3COOH_l: 0.05 } });
    const aromaFruity = computeVesselAroma(vConcEt);
    const aromaCleared = computeVesselAroma({ _hadVolatileEsterForAroma: true, moles: { CH3COO_aq: 0.05, OH_aq: 0.02 } });
    const aromaOverheat = computeVesselAroma({ esterOverheatFrac: 0.5, moles: { H2SO4_l: 0.1 } });
    const insHost = document.createElement('div');
    document.body.appendChild(insHost);
    const tVi71 = (k) => I18N.vi[k] || k;
    const ins71 = new InspectorPanel(insHost, sim71, () => tVi71, { getLabsMeta: () => null });
    sim71.selectedId = vConcEt.id;
    ins71.update('vi', true);
    const insHasAroma = insHost.textContent.includes(I18N.vi.aromaEsterFruity);
    document.body.removeChild(insHost);
    const aromaOk =
      aromaVinegar?.kind === 'vinegar' &&
      aromaFruity?.kind === 'ester_fruity' &&
      aromaCleared?.kind === 'ester_cleared' &&
      aromaOverheat?.kind === 'burnt_so2' &&
      insHasAroma;

    assert(
      'Prompt 71 invariants: Boiling Chips (boiling_chips) anti-bumping & render, Tripalmitin ESTER_KINETICS, KOH soft gel vs NaOH cake, conc vs dilute H2SO4 esterification (EtOH + Isoamyl) & Aroma telemetry',
      bumpingOk && chipRenderOk && tripalmOk && kohGelOk && esterConcOk && aromaOk,
      `bump=${bumpingOk}(no:${(tubeNoChips.bumpingSurgeFrac||0).toFixed(2)},with:${(tubeWithChips.bumpingSurgeFrac||0).toFixed(2)}), ren=${chipRenderOk}, palm=${tripalmOk}(salt=${(vPalm.moles.C15H31COONa_s||0).toFixed(3)}), koh=${kohGelOk}, estConc=${esterConcOk}(et:${(vConcEt.moles.CH3COOC2H5_l||0).toFixed(3)}/${(vDilEt.moles.CH3COOC2H5_l||0).toFixed(3)},iso:${(vIsoConc.moles.CH3COOC5H11_l||0).toFixed(3)}/${(vIsoDil.moles.CH3COOC5H11_l||0).toFixed(3)}), aroma=${aromaOk}`
    );
  }

  // TEST 190: Prompt 72 — General Property-Driven Lipid & Soap Architecture
  // Verifies brand-new fats declared only via SPECIES metadata (Trilinolein db=6, Tributyrin C4 short-chain,
  // and a synthetic mixed-acyl glyceride with acylChains 2:1) run every engine & visual path automatically!
  {
    const sim72 = new LabSimulation();

    // 1) Trilinolein (C57H98O6_l, db=6) added ONLY via SPECIES metadata: floats, saponifies with emulsion/foam,
    //    salts out floating C17H31COONa_s cake, renders on Canvas, consumes 6 Br2 & 6 H2 -> Tristearin!
    const vTrilin = sim72.createApparatus('beaker_250', 120, 434);
    vTrilin.moles = { C57H98O6_l: 0.01, Na_aq: 0.20, OH_aq: 0.20, H2O_l: 1.1, C2H5OH_l: 0.08 };
    const stratInitL = computePhaseStratification(vTrilin.moles, 298.15, APPARATUS.beaker_250, 0);
    for (let i = 0; i < 32; i++) {
      vTrilin.tempK = 358.15;
      vTrilin.stirTimer = 4;
      sim72.step(0.5);
    }
    const visLinEmul = computeSolutionVisuals(
      vTrilin.moles,
      computeLiquidVolumeL(vTrilin.moles, vTrilin.tempK),
      12,
      4,
      0,
      0,
      { phaseFilter: 'aq' }
    );
    const foamTrilinOk = (vTrilin.soapFoamMl || 0) > 1.0 && (vTrilin.moles.C17H31COO_aq || 0) > 0.025;
    vTrilin.moles.Na_aq = (vTrilin.moles.Na_aq || 0) + 0.55;
    vTrilin.moles.Cl_aq = 0.55;
    for (let i = 0; i < 6; i++) {
      vTrilin.tempK = 328.15;
      sim72.step(0.4);
    }
    const c72 = document.createElement('canvas');
    c72.width = 160;
    c72.height = 200;
    let linRenderOk = true;
    try {
      renderVesselSolids(c72.getContext('2d'), vTrilin, { left: 20, right: 140, top: 20, bottom: 180, width: 120 }, true, 75);
    } catch {
      linRenderOk = false;
    }
    const trilinOk =
      stratInitL.lightOrganicMl > 5 &&
      visLinEmul.r > 205 &&
      foamTrilinOk &&
      linRenderOk &&
      vTrilin.soapSaltedOutCake === true &&
      (vTrilin.moles.C17H31COONa_s || 0) > 0.015;

    // 2) Short-chain Tributyrin (C15H26O6_l, C4, saltOutNaId=null): saponifies fast, minimal foam/emulsion, zero soap cake with NaCl!
    const vTrib = sim72.createApparatus('beaker_250', 500, 434);
    vTrib.moles = { C15H26O6_l: 0.015, Na_aq: 0.45, OH_aq: 0.15, Cl_aq: 0.30, H2O_l: 1.2 };
    for (let i = 0; i < 20; i++) {
      vTrib.tempK = 353.15;
      sim72.step(0.5);
    }
    const tributOk =
      (vTrib.moles.C3H7COO_aq || 0) > 0.04 &&
      (vTrib.moles.C3H5OH_3_l || 0) > 0.013 &&
      (vTrib.soapFoamMl || 0) < 1.0 &&
      vTrib.soapSaltedOutCake === false;

    // 1b) Unsaturation stoichiometry db=6 on Trilinolein: 6 mol Br2 consumed vs 3 for Triolein; 6 H2 -> Tristearin
    const vBrLin = sim72.createApparatus('beaker_250', 260, 434);
    vBrLin.moles = { C57H98O6_l: 0.01, Br2_l: 0.08, H2O_l: 0 };
    const vHydLin = sim72.createApparatus('round_flask_250', 380, 418);
    vHydLin.isStoppered = true;
    vHydLin.sealedAirO2Moles = 0;
    vHydLin.moles = { C57H98O6_l: 0.01, Ni_s: 0.01, H2O_l: 0 };
    vHydLin.headspaceGasMoles = { H2_g: 0.08 };
    for (let i = 0; i < 14; i++) {
      vBrLin.tempK = 305.15;
      stepVesselChemistry(vBrLin, 0.4, { environment: sim72.environment });
      vHydLin.tempK = 448.15;
      stepVesselChemistry(vHydLin, 0.4, { environment: sim72.environment });
    }
    const unsat6Ok =
      (vBrLin.moles.C57H98O6_l || 0) < 1e-4 &&
      (vBrLin.moles.Br2_l || 0) > 0.015 &&
      (vBrLin.moles.Br2_l || 0) < 0.025 && // 0.08 - 6*0.01 = 0.020!
      (vHydLin.moles.C57H110O6_s || 0) > 0.009 &&
      (vHydLin.headspaceGasMoles.H2_g || 0) > 0.015 &&
      (vHydLin.headspaceGasMoles.H2_g || 0) < 0.025; // 0.08 - 6*0.01 = 0.020!

    // 3) Synthetic mixed-chain triglyceride registered at runtime via acylChains (2 Oleate + 1 Stearate)
    SPECIES.__TEST_MIXED_FAT_l = {
      id: '__TEST_MIXED_FAT_l',
      formula: '(C₁₇H₃₃COO)₂(C₁₇H₃₅COO)C₃H₅',
      name: 'Dioleostearin (Mixed fat)',
      phase: 'l',
      liquidGroup: 'organic_light',
      isFat: true,
      alcoholId: 'C3H5OH_3_l',
      acylChains: [
        { acidId: 'C17H33COOH_l', soapIonId: 'C17H33COO_aq', soapNaId: 'C17H33COONa_s', count: 2 },
        { acidId: 'C17H35COOH_s', soapIonId: 'C17H35COO_aq', soapNaId: 'C17H35COONa_s', count: 1 },
      ],
      emulsifyPower: 1.0,
      molarMass: 887.4,
      density: 0.92,
      cp: 1850,
    };
    const vMixed = sim72.createApparatus('beaker_250', 620, 300);
    vMixed.moles = { __TEST_MIXED_FAT_l: 0.01, Na_aq: 0.12, OH_aq: 0.12, H2O_l: 1.4, C2H5OH_l: 0.08 };
    for (let i = 0; i < 18; i++) {
      vMixed.tempK = 358.15;
      vMixed.stirTimer = 4;
      stepVesselChemistry(vMixed, 0.5, { environment: sim72.environment });
    }
    const ole = vMixed.moles.C17H33COO_aq || 0;
    const ste = vMixed.moles.C17H35COO_aq || 0;
    delete SPECIES.__TEST_MIXED_FAT_l;
    const mixedOk = ole > 0.018 && ste > 0.009 && Math.abs(ole / Math.max(1e-6, ste) - 2.0) < 0.08;

    assert(
      'Prompt 72 invariants: Zero-hardcode SPECIES-driven lipid/soap engine (Trilinolein db=6 + Br2/H2 + floating linoleate cake, short-chain Tributyrin no cake/low foam, runtime acylChains 2:1 mixed lipid)',
      trilinOk && unsat6Ok && tributOk && mixedOk,
      `trilin=${trilinOk}(cake=${(vTrilin.moles.C17H31COONa_s||0).toFixed(3)},foam=${(vTrilin.soapFoamMl||0).toFixed(1)}), unsat6=${unsat6Ok}(brRem=${(vBrLin.moles.Br2_l||0).toFixed(3)},ste=${(vHydLin.moles.C57H110O6_s||0).toFixed(3)},h2=${(vHydLin.headspaceGasMoles.H2_g||0).toFixed(3)}), tribut=${tributOk}(but=${(vTrib.moles.C3H7COO_aq||0).toFixed(3)},foam=${(vTrib.soapFoamMl||0).toFixed(1)}), mixed=${mixedOk}(${ole.toFixed(4)}/${ste.toFixed(4)})`
    );
  }

  // TEST 191: Prompt 73 — Drag & Canvas Performance Optimization Invariants
  // (GPU translate3d ghost drag, rAF-coalesced pointermove + cached canvasRect, FluidGasOverlay auto-idle sleep/wake,
  // zero per-frame shadowBlur on render paths, offscreen static backdrop/bench cache)
  {
    const sim73 = new LabSimulation();
    const wrap73 = document.createElement('div');
    wrap73.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:560px;pointer-events:none;opacity:0.01;';
    const cvs73 = document.createElement('canvas');
    cvs73.width = 1000;
    cvs73.height = 560;
    cvs73.style.cssText = 'width:1000px;height:560px;display:block;';
    wrap73.appendChild(cvs73);
    const shelfHost73 = document.createElement('div');
    document.body.appendChild(wrap73);
    document.body.appendChild(shelfHost73);

    const wb73 = new LabWorkbenchCanvas(cvs73, sim73, new ParticleSystem());
    wb73.resize();
    const shelf73 = new ShelfPanel(shelfHost73, sim73, () => (k) => I18N.vi[k] || k, {
      onExternalDragMove: (cx, cy, kind, id) => wb73.setExternalDropPreview(cx, cy, kind, id),
      onExternalDrop: (cx, cy, kind, id) => wb73.dropFromShelf(cx, cy, kind, id),
    });
    shelf73.render((k) => I18N.vi[k] || k);
    shelfHost73.querySelector('[data-shelf-tab="reagents"]')?.click();

    // 1) Shelf reagent drag uses GPU translate3d without layout style.left/top & caches canvasRect cleanly
    let rectCalls = 0;
    const origGetRect = cvs73.getBoundingClientRect.bind(cvs73);
    cvs73.getBoundingClientRect = () => {
      rectCalls++;
      return origGetRect();
    };
    const regCard = shelfHost73.querySelector('.reagent-card[data-reagent-id="cuso4_5h2o"]');
    regCard.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 25, clientY: 120, button: 0, pointerType: 'mouse' }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 220, clientY: 200, pointerType: 'mouse' }));
    const ghostTransform = shelf73._dragSession?.ghostEl?.style?.transform || '';
    const ghostNoLeftTop = !shelf73._dragSession?.ghostEl?.style?.left && !shelf73._dragSession?.ghostEl?.style?.top;
    const rectCallsDuringExternal = rectCalls;
    for (let k = 0; k < 6; k++) {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 230 + k * 10, clientY: 200 + k * 5, pointerType: 'mouse' }));
    }
    const extCoalescedOk = rectCalls === rectCallsDuringExternal; // Cached rect & rAF coalescing prevent repeated layout queries!
    window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
    localStorage.removeItem('virlab_shelf_tab');
    const ghostOk = ghostTransform.includes('translate3d(') && ghostNoLeftTop && extCoalescedOk && !wb73._canvasRect;

    // 2) Canvas item drag caches rect + coalesces burst pointermove + releases cleanly on endDrag
    const beaker73 = sim73.createApparatus('beaker_250', 400, 420);
    beaker73.moles = { H2O_l: 5.0 };
    beaker73.tempK = 420;
    beaker73.softenGlowFrac = 0.5;
    rectCalls = 0;
    cvs73.dispatchEvent(new PointerEvent('pointerdown', { clientX: 400, clientY: 420, pointerId: 1 }));
    for (let k = 1; k <= 8; k++) {
      cvs73.dispatchEvent(new PointerEvent('pointermove', { clientX: 400 + k * 12, clientY: 420 - k * 10, pointerId: 1 }));
    }
    const movedPos = beaker73.x;
    const canvasRectCachedOk = rectCalls <= 1 && Boolean(wb73._canvasRect);
    cvs73.dispatchEvent(new PointerEvent('pointerup', { clientX: 496, clientY: 340, pointerId: 1 }));
    const finalBeakerX = beaker73.x; // Trailing queued move flushed before endDrag!
    const dragCoalesceOk = canvasRectCachedOk && movedPos >= 400 && finalBeakerX > 480 && !wb73._canvasRect;

    // 3) Zero per-frame ctx.shadowBlur usage on live canvas scene & renderers
    const testCvs = document.createElement('canvas');
    testCvs.width = 1000;
    testCvs.height = 560;
    const rawCtx = testCvs.getContext('2d');
    let shadowBlurWrites = 0;
    const trackedCtx = new Proxy(rawCtx, {
      set(target, prop, value) {
        if (prop === 'shadowBlur' && Number(value) > 0) shadowBlurWrites++;
        target[prop] = value;
        return true;
      },
      get(target, prop) {
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    wb73.setSelection([beaker73.id], beaker73.id);
    wb73.dropTargetVesselId = beaker73.id;
    wb73.zoomMode = true;
    wb73.zoomScale = 2.0;
    wb73.pointerLogical = { x: 450, y: 340 };
    wb73.renderWorldScene(trackedCtx, 1.5);
    wb73.renderLoupeLens(trackedCtx, 1.5, 450, 340);
    wb73.toggleZoomMode(false);
    renderVessel(trackedCtx, beaker73, true, true, true, 1.0, 'vi');
    renderBoilingChips(trackedCtx, sim73.createApparatus('boiling_chips', 200, 460), true, true);
    renderColorimeter(trackedCtx, sim73.createApparatus('colorimeter', 260, 420), true, true);
    renderPhConductometer(trackedCtx, sim73.createApparatus('ph_conductometer', 320, 420), true, true, 'vi');
    renderTlcPlate(trackedCtx, sim73.createApparatus('tlc_plate', 360, 420), true, true, true);
    const zeroShadowBlurOk = shadowBlurWrites === 0;

    // 4) Offscreen background cache builds & invalidates cleanly on theme/resize
    const darkBg = wb73._ensureBgCache();
    const darkKey = wb73._bgCacheKey;
    wb73.setTheme(false, 'ctrl');
    const ctrlInvalidated = wb73._bgCacheKey === '';
    wb73.renderWorldScene(rawCtx, 2.0);
    const ctrlKey = wb73._bgCacheKey;
    wb73.setTheme(true, 'sos');
    wb73.renderWorldScene(rawCtx, 2.5);
    const sosKey = wb73._bgCacheKey;
    wb73.resize();
    const resizeInvalidated = wb73._bgCacheKey === '';
    const bgCacheOk =
      Boolean(darkBg) &&
      darkBg.width >= 1000 &&
      ctrlInvalidated &&
      darkKey !== ctrlKey &&
      ctrlKey !== sosKey &&
      resizeInvalidated;

    // 5) FluidGasOverlay auto-idle sleep & wake
    const fgo = new FluidGasOverlay();
    const emptyEmit = fgo._collectEmitters([], CONSTANTS.T_STD_K, 'normal');
    const burnerItem = { kind: 'burner', typeId: 'bunsen_burner', x: 300, y: 440, powerW: 900 };
    const burnerEmit = fgo._collectEmitters([burnerItem], CONSTANTS.T_STD_K, 'normal');
    let fgoSleepCycleOk = emptyEmit.burners.length === 0 && burnerEmit.burners.length === 1;
    if (fgo.enabled) {
      const simF = new LabSimulation();
      fgo.stepAndRender(simF, 0.016, true);
      const sleptEmpty = fgo.isSleeping === true;
      const bn = simF.createApparatus('bunsen_burner', 300, 440);
      bn.powerW = 900;
      fgo.stepAndRender(simF, 0.016, true);
      const wokeOnBurner = fgo.isSleeping === false && fgo._hasPlumeEnergy === true;
      bn.powerW = 0;
      for (let t = 0; t < 180; t++) fgo.stepAndRender(simF, 0.02, true);
      const sleptAfterCool = fgo.isSleeping === true;
      fgoSleepCycleOk = fgoSleepCycleOk && sleptEmpty && wokeOnBurner && sleptAfterCool;
    }

    wrap73.remove();
    shelfHost73.remove();

    assert(
      'Prompt 73 invariants: GPU translate3d shelf ghost, rAF-coalesced pointermove + cached canvasRect, zero per-frame shadowBlur, offscreen bg/bench cache & FluidGasOverlay auto-idle sleep',
      ghostOk && dragCoalesceOk && zeroShadowBlurOk && bgCacheOk && fgoSleepCycleOk,
      `ghost=${ghostOk}(t=${ghostTransform}), drag=${dragCoalesceOk}(rectCalls=${rectCalls},finalX=${finalBeakerX.toFixed(1)}), noBlur=${zeroShadowBlurOk}(writes=${shadowBlurWrites}), bgCache=${bgCacheOk}, fluidSleep=${fgoSleepCycleOk}`
    );
  }

  // TEST 192: Prompt 74 — Zero-Overhead Clicks/Drags (Outside-Only Tab Hover, Light Position Undo vs Chemical Full Undo,
  // No Selection emitChange, Deferred Idle Save, FluidGasOverlay 30Hz/13Hz Throttle, Shelf Hover Deactivation & Chart Skip)
  {
    const sim74 = new LabSimulation();
    const wrap74 = document.createElement('div');
    wrap74.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:560px;pointer-events:none;opacity:0.01;';
    const cvs74 = document.createElement('canvas');
    cvs74.width = 1000;
    cvs74.height = 560;
    cvs74.style.cssText = 'width:1000px;height:560px;display:block;';
    wrap74.appendChild(cvs74);
    const shelfHost74 = document.createElement('div');
    document.body.appendChild(wrap74);
    document.body.appendChild(shelfHost74);

    let extHoverCallsInside = 0;
    let extHoverCallsOutside = 0;
    let selectCbCount = 0;
    let emitCount = 0;
    sim74.subscribe(() => {
      emitCount++;
    });

    const wb74 = new LabWorkbenchCanvas(cvs74, sim74, new ParticleSystem(), {
      onSelect: () => { selectCbCount++; },
      onExternalTabDragHover: (cx, cy, it) => {
        if (it) extHoverCallsOutside++;
      },
    });
    wb74.resize();

    const b74 = sim74.createApparatus('beaker_250', 300, 420);
    b74.moles = { H2O_l: 2.0 };
    const spoon74 = sim74.createApparatus('iron_spoon', 500, 440);
    spoon74.moles = { NaCl_s: 0.05 };

    let exportSnapCalls = 0;
    const origExportSnap = sim74.exportSnapshot.bind(sim74);
    sim74.exportSnapshot = () => {
      exportSnapCalls++;
      return origExportSnap();
    };

    // 1) Pure selection click -> fires onSelect once, ZERO exportSnapshot(), ZERO emitChange()
    emitCount = 0;
    selectCbCount = 0;
    cvs74.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, clientY: 420, pointerId: 2 }));
    cvs74.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 420, pointerId: 2 }));
    const selectionZeroCostOk = selectCbCount === 1 && exportSnapCalls === 0 && emitCount === 0;

    // 2) Pure position move -> lightweight 'positions' undo (ZERO exportSnapshot!), restores X/Y cleanly; inside drag skips external hover
    const origX = b74.x;
    const origY = b74.y;
    extHoverCallsOutside = 0;
    cvs74.dispatchEvent(new PointerEvent('pointerdown', { clientX: b74.x, clientY: b74.y, pointerId: 3 }));
    cvs74.dispatchEvent(new PointerEvent('pointermove', { clientX: 460, clientY: 380, pointerId: 3 }));
    extHoverCallsInside = extHoverCallsOutside;
    cvs74.dispatchEvent(new PointerEvent('pointerup', { clientX: 460, clientY: 380, pointerId: 3 }));
    const movedX = b74.x;
    const topUndoType = sim74.undoStack[sim74.undoStack.length - 1]?.type;
    const zeroFullSnapOnMove = exportSnapCalls === 0 && topUndoType === 'positions';
    sim74.undo();
    const posUndoRestoredOk = Math.abs(b74.x - origX) < 0.5 && Math.abs(b74.y - origY) < 0.5;

    // 2b) Drag outside canvas boundary invokes onExternalTabDragHover and resets cleanly on pointerup
    // Advance flush frame between sequential synthetic drags by clearing rAF lock via pointerdown/move after reset
    wb74._moveRafId = 0;
    wb74._pendingPointerMove = null;
    cvs74.dispatchEvent(new PointerEvent('pointerdown', { clientX: b74.x, clientY: b74.y, pointerId: 5 }));
    cvs74.dispatchEvent(new PointerEvent('pointermove', { clientX: 1200, clientY: -20, pointerId: 5 }));
    const movedOutsideCalls = extHoverCallsOutside;
    cvs74.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 420, pointerId: 5 }));
    sim74.undo();
    const outsideHoverFilterOk = extHoverCallsInside === 0 && movedOutsideCalls >= 1 && wb74._extHoverWasOutside === false;

    // 3) Chemical spoon pour drag -> upgrades to full undo right before drop, sim.undo() restores salt moles & spoon position
    b74.x = 300;
    b74.y = 434;
    wb74._moveRafId = 0;
    wb74._pendingPointerMove = null;
    cvs74.dispatchEvent(new PointerEvent('pointerdown', { clientX: spoon74.x, clientY: spoon74.y, pointerId: 4 }));
    cvs74.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 390, pointerId: 4 }));
    cvs74.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 390, pointerId: 4 }));
    const pouredSalt = (b74.moles.NaCl_s || 0) > 0.01 && exportSnapCalls >= 1;
    sim74.undo();
    const bAfterChemUndo = sim74.getItem(b74.id);
    const spAfterChemUndo = sim74.getItem(spoon74.id);
    const chemUndoRestoredOk = (bAfterChemUndo?.moles?.NaCl_s || 0) < 1e-6 && (spAfterChemUndo?.moles?.NaCl_s || 0) > 0.04;

    // 4) ShelfPanel adds .shelf-dragging-active class during drag & removes on cleanup
    const shelf74 = new ShelfPanel(shelfHost74, sim74, () => (k) => I18N.vi[k] || k, {
      onExternalDragMove: (cx, cy, kind, id) => wb74.setExternalDropPreview(cx, cy, kind, id),
    });
    shelf74.render((k) => I18N.vi[k] || k);
    shelfHost74.querySelector('[data-shelf-tab="apparatus"]')?.click();
    const appCard74 = shelfHost74.querySelector('.apparatus-card[data-apparatus-id="beaker_250"]');
    appCard74.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 15, clientY: 15, button: 0, pointerType: 'mouse' }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 80, pointerType: 'mouse' }));
    const hasDragClass = shelfHost74.classList.contains('shelf-dragging-active');
    window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
    localStorage.removeItem('virlab_shelf_tab');
    const removedDragClass = !shelfHost74.classList.contains('shelf-dragging-active');

    // 5) InspectorPanel chart placeholder skips redundant clears when history < 2 & Scale skips when none
    const inspHost74 = document.createElement('div');
    document.body.appendChild(inspHost74);
    const insp74 = new InspectorPanel(inspHost74, sim74, () => (k) => I18N.vi[k] || k, { getLabsMeta: () => null });
    sim74.selectedId = b74.id;
    insp74.update('vi', true);
    const chartCvs = inspHost74.querySelector('#vessel-mole-chart');
    const chartPlaceholderOk = Boolean(chartCvs?.dataset?.placeholderKey);
    inspHost74.remove();

    // 6) FluidGasOverlay 30Hz step & deferred persistence controller
    const fgo74 = new FluidGasOverlay();
    let fgoThrottleOk = true;
    if (fgo74.enabled) {
      const simFG = new LabSimulation();
      const bnFG = simFG.createApparatus('bunsen_burner', 300, 440);
      bnFG.powerW = 800;
      fgo74.isSleeping = true;
      fgo74.stepAndRender(simFG, 0.01, true); // Wakes & steps immediately
      const wokeAccum = fgo74._stepAccumDt === 0;
      fgo74.stepAndRender(simFG, 0.01, true); // < 1/30 -> skipped & accumulated
      const skippedAccum = fgo74._stepAccumDt > 0 && fgo74._stepAccumDt < 0.033;
      fgoThrottleOk = wokeAccum && skippedAccum;
    }

    let deferredDragFlag = true;
    const mgr74 = new LabManager();
    const wp74 = initWorkspacePersistence(mgr74, { shouldDefer: () => deferredDragFlag });
    wp74.triggerDebouncedSave();
    wp74.dispose();

    wrap74.remove();
    shelfHost74.remove();

    assert(
      'Prompt 74 invariants: Zero-cost clicks (no exportSnapshot/emitChange), lightweight position undo vs full chemical undo, outside-only tab hover, shelf hover lock, chart placeholder skip & 30Hz FluidGas throttle',
      selectionZeroCostOk && zeroFullSnapOnMove && posUndoRestoredOk && outsideHoverFilterOk && pouredSalt && chemUndoRestoredOk && hasDragClass && removedDragClass && chartPlaceholderOk && fgoThrottleOk,
      `sel=${selectionZeroCostOk}, posUndo=${zeroFullSnapOnMove && posUndoRestoredOk}(type=${topUndoType},movedX=${movedX.toFixed(0)}), outHover=${outsideHoverFilterOk}(in=${extHoverCallsInside},out=${movedOutsideCalls}), chemUndo=${pouredSalt && chemUndoRestoredOk}, shelfCls=${hasDragClass && removedDragClass}, chart=${chartPlaceholderOk}, fgo30=${fgoThrottleOk}`
    );
  }

  // TEST 193: Prompt 75 — Property-Driven Ksp(T) Soap Salting-Out + Quadratic Equilibrium, NaCl [Na+][Cl-] Dissolution,
  // Inspector phenFlags, Filter Funnel Soap Separation, Round-Robin 9 Background Labs, Smart Quiescent Sleep & Auto-Wake,
  // Per-Lab Dirty Cache & Offscreen Vessel Glass Shell Cache
  {
    const sim75 = new LabSimulation();

    // 1) Screenshot 001520 exact scenario: [Na+]=4.29M (NaOH+NaCl), [Cl-]=1.09M (<1.5M!), [Oleate]=0.88M -> MUST salt out!
    const vSalt = sim75.createApparatus('beaker_250', 220, 434);
    vSalt.tempK = 298.15;
    vSalt.soapFoamMl = 18;
    vSalt.moles = {
      H2O_l: 13.0,
      Na_aq: 1.5098,
      OH_aq: 0.8151,
      Cl_aq: 0.3847,
      C17H33COO_aq: 0.3100,
      C3H5OH_3_l: 0.1033,
    };
    const host75 = document.createElement('div');
    document.body.appendChild(host75);
    const insp75 = new InspectorPanel(host75, sim75, () => (k) => I18N.vi[k] || k, { getLabsMeta: () => null });
    sim75.selectedId = vSalt.id;
    const sigBeforeCake = insp75.getStructureSignature((k) => I18N.vi[k] || k, 'vi');
    for (let i = 0; i < 6; i++) {
      vSalt.tempK = 298.15;
      stepVesselChemistry(vSalt, 0.5, { environment: sim75.environment });
    }
    const sigAfterCake = insp75.getStructureSignature((k) => I18N.vi[k] || k, 'vi');
    host75.remove();
    const cakeRatio = (vSalt.moles.C17H33COONa_s || 0) / 0.3100;
    const saltingOutKspOk =
      cakeRatio > 0.90 &&
      vSalt.soapSaltedOutCake === true &&
      vSalt.soapFoamMl < 5 &&
      sigBeforeCake !== sigAfterCake;

    // 1b) Ksp(T) temperature scaling & chain-specific soapKsp298 (Stearate 0.028 < Oleate 0.050 < Linoleate 0.072)
    const vColdSte = sim75.createApparatus('beaker_250', 360, 434);
    const vHotLin = sim75.createApparatus('beaker_250', 500, 434);
    vColdSte.moles = { H2O_l: 15.0, Na_aq: 0.25, C17H35COO_aq: 0.25 };
    vHotLin.moles = { H2O_l: 15.0, Na_aq: 0.25, C17H31COO_aq: 0.25 };
    vColdSte.tempK = 298.15;
    vHotLin.tempK = 353.15;
    stepVesselChemistry(vColdSte, 1.0, { environment: sim75.environment });
    stepVesselChemistry(vHotLin, 1.0, { environment: sim75.environment });
    const kspChainTempOk = (vColdSte.moles.C17H35COONa_s || 0) > (vHotLin.moles.C17H31COONa_s || 0) + 0.04;

    // 1c) dissolve_nacl checks [Na+][Cl-] instead of blocking purely on excess NaOH's Na_aq
    const vNaCl = sim75.createApparatus('beaker_250', 620, 434);
    vNaCl.moles = { H2O_l: 20.0, Na_aq: 2.3, OH_aq: 2.3, NaCl_s: 0.4 };
    vNaCl.tempK = 298.15;
    stepVesselChemistry(vNaCl, 0.5, { environment: sim75.environment });
    const naclProductDissolveOk = (vNaCl.moles.Cl_aq || 0) > 0.05;

    // 1d) earlyBrineBlocked preserved when raw lipid still present & saturated NaCl poured early
    const vEarly = sim75.createApparatus('beaker_250', 740, 434);
    vEarly.moles = { H2O_l: 12.0, C57H104O6_l: 0.05, Na_aq: 0.8, OH_aq: 0.8, Cl_aq: 0.7 };
    vEarly.tempK = 353.15;
    stepVesselChemistry(vEarly, 0.2, { environment: sim75.environment });
    const earlyWarnOk = vEarly.soapEarlySalted === true;

    // 1e) Filter funnel retains 100% solid RCOONa soap cake while draining aqueous brine below
    const simFilt = new LabSimulation();
    const vRecvF = simFilt.createApparatus('beaker_250', 300, 434);
    const fSoap = simFilt.createApparatus('filter_funnel', 300, vRecvF.y - 60);
    fSoap.mountedOnVesselId = vRecvF.id;
    fSoap.moles = { H2O_l: 2.0, Cl_aq: 0.2, OH_aq: 0.2, C3H5OH_3_l: 0.05, C17H33COONa_s: 0.12 };
    for (let i = 0; i < 40; i++) simFilt.step(0.15);
    const funnelSepOk =
      (fSoap.moles.C17H33COONa_s || 0) > 0.119 &&
      (fSoap.moles.H2O_l || 0) < 0.05 &&
      (vRecvF.moles.Cl_aq || 0) > 0.18 &&
      (vRecvF.moles.C17H33COONa_s || 0) < 1e-6;

    // 2) Round-Robin 9 background labs + Smart Quiescent Sleep & Auto Wake-Up + Per-Lab Dirty Cache
    const mgr75 = new LabManager();
    for (let k = 0; k < 9; k++) mgr75.addLab('clean');
    const bgStepCounts = new Array(10).fill(0);
    for (let idx = 1; idx < mgr75.labs.length; idx++) {
      const origStep = mgr75.labs[idx].sim.step.bind(mgr75.labs[idx].sim);
      mgr75.labs[idx].sim.step = (...args) => {
        bgStepCounts[idx]++;
        return origStep(...args);
      };
    }
    mgr75.stepAllLabs(0.05);
    const frame1RanBg = bgStepCounts.slice(1).reduce((a, b) => a + b, 0);
    for (let f = 0; f < 10; f++) mgr75.stepAllLabs(0.05);
    const allAdvancedBg = bgStepCounts.slice(1).every((c) => c >= 1);
    const roundRobinOk = frame1RanBg <= 2 && allAdvancedBg;

    // Quiescent Sleep & Auto Wake-Up
    const simQ = new LabSimulation();
    const vQuiet = simQ.createApparatus('beaker_250', 240, 434);
    vQuiet.moles = { H2O_l: 5.0, Na_aq: 0.2, Cl_aq: 0.2 };
    for (let i = 0; i < 8; i++) simQ.step(0.05);
    const enteredQuiet = vQuiet._quiescent === true;
    // Trigger wakeup via adding reagent / modifying moles + stepping
    vQuiet.moles.HCl_aq = 0.2;
    simQ.step(0.05);
    const wokeOnReagent = vQuiet._quiescent === false;
    // Return to sleep then wake via ambient temp shift
    delete vQuiet.moles.HCl_aq;
    for (let i = 0; i < 8; i++) simQ.step(0.05);
    const reQuieted = vQuiet._quiescent === true;
    simQ.environment.tempK = 335.15;
    simQ.step(0.05);
    const wokeOnEnvTemp = vQuiet._quiescent === false;
    const quiescentOk = enteredQuiet && wokeOnReagent && reQuieted && wokeOnEnvTemp;

    // Per-Lab dirty JSON cache
    serializeWorkspace(mgr75);
    const cachedRefBefore = mgr75.labs[9]._benchSerCache;
    mgr75.labs[0].sim.createApparatus('beaker_250', 400, 434);
    const json75 = serializeWorkspaceJson(mgr75);
    const cachedRefAfter = mgr75.labs[9]._benchSerCache;
    const parsedOk = Boolean(json75 && JSON.parse(json75).benches?.length === 10);
    const cacheReuseOk = Boolean(cachedRefBefore && cachedRefBefore === cachedRefAfter && parsedOk);

    // 3) Offscreen Vessel Glass Shell Cache reuse
    const c75 = document.createElement('canvas');
    c75.width = 400;
    c75.height = 400;
    const ctx75 = c75.getContext('2d');
    const bShell1 = sim75.createApparatus('beaker_250', 120, 200);
    const bShell2 = sim75.createApparatus('beaker_250', 260, 200);
    renderVessel(ctx75, bShell1, { isSelected: false, isDropTarget: false, isDark: true, timeNow: 1.0 });
    const sizeAfter1 = getVesselGlassShellCacheSize();
    renderVessel(ctx75, bShell2, { isSelected: false, isDropTarget: false, isDark: true, timeNow: 1.1 });
    const sizeAfter2 = getVesselGlassShellCacheSize();
    const glassShellCacheOk = sizeAfter1 >= 1 && sizeAfter2 === sizeAfter1;

    assert(
      'Prompt 75 invariants: Ksp(T) soap salting-out (NaOH+low Cl), NaCl [Na+][Cl-] dissolution, funnel cake separation, round-robin 9 bg labs, smart quiescent sleep/wake, per-lab JSON cache & offscreen glass shell cache',
      saltingOutKspOk && kspChainTempOk && naclProductDissolveOk && earlyWarnOk && funnelSepOk && roundRobinOk && quiescentOk && cacheReuseOk && glassShellCacheOk,
      `kspOut=${saltingOutKspOk}(ratio=${cakeRatio.toFixed(3)},sigDiff=${sigBeforeCake!==sigAfterCake}), chainT=${kspChainTempOk}, nacl=${naclProductDissolveOk}(Cl=${(vNaCl.moles.Cl_aq||0).toFixed(3)}), early=${earlyWarnOk}, funnel=${funnelSepOk}, rr=${roundRobinOk}(f1=${frame1RanBg}), quiet=${quiescentOk}, jsonCache=${cacheReuseOk}, glassCache=${glassShellCacheOk}(${sizeAfter1}->${sizeAfter2})`
    );
  }

  // TEST 194: Prompt 76 — phenFlags Sync for soapSaltedOutCake & UV–Vis (220–750 nm) + FT-IR (4000 → 400 cm^-1) Spectrometer System
  {
    const sim76 = new LabSimulation();

    // 1) phenFlags sync when soapSaltedOutCake toggles WITHOUT changing vessel.moles keys
    const vFlag = sim76.createApparatus('beaker_250', 180, 434);
    vFlag.moles = { H2O_l: 5.0, C17H33COONa_s: 0.05 };
    vFlag.soapSaltedOutCake = false;
    const host76 = document.createElement('div');
    document.body.appendChild(host76);
    const insp76 = new InspectorPanel(host76, sim76, () => (k) => I18N.vi[k] || k, { getLabsMeta: () => null });
    sim76.selectedId = vFlag.id;
    const sigCakeOff = insp76.getStructureSignature((k) => I18N.vi[k] || k, 'vi');
    vFlag.soapSaltedOutCake = true;
    const sigCakeOn = insp76.getStructureSignature((k) => I18N.vi[k] || k, 'vi');
    insp76.update('vi', true);
    const badgeVisibleVi = host76.innerHTML.includes(I18N.vi.badgeSoapSaltedCake);
    const phenFlagSyncOk = sigCakeOff !== sigCakeOn && badgeVisibleVi;

    // 2) Full-range UV–Vis Scan (220–750 nm): chromophore λmax + UV aromatic peak (220–320 nm)
    const vMnO4 = sim76.createApparatus('beaker_250', 300, 434);
    vMnO4.moles = { H2O_l: 5.5, MnO4_aq: 0.00004, K_aq: 0.00004 };
    const uvMnO4 = computeUvVisSpectrum(vMnO4);
    const vCuAmm = sim76.createApparatus('beaker_250', 420, 434);
    vCuAmm.moles = { H2O_l: 5.5, CuNH3_4_2_aq: 0.002 };
    const uvCuAmm = computeUvVisSpectrum(vCuAmm);
    const vPhenol = sim76.createApparatus('beaker_250', 540, 434);
    vPhenol.moles = { H2O_l: 5.5, C6H5OH_s: 0.02 };
    const uvPhenol = computeUvVisSpectrum(vPhenol);
    const uvScanOk =
      uvMnO4.points[0].nm === 220 &&
      uvMnO4.points[uvMnO4.points.length - 1].nm === 750 &&
      Math.abs(uvMnO4.lambdaMaxNm - 525) <= 15 &&
      uvMnO4.maxA > 0.4 &&
      uvCuAmm.peaks.some((p) => p.nm >= 590 && p.nm <= 620) &&
      uvPhenol.lambdaMaxNm >= 220 &&
      uvPhenol.lambdaMaxNm <= 310 &&
      uvPhenol.maxA > 0.25;

    // 3) FT-IR (4000 -> 400 cm^-1 reversed axis, %T):
    // 3a) Triglyceride saponification -> ~1744 cm^-1 ester C=O disappears, ~1576 cm^-1 (-COO-) + broad O-H (~3355) appear
    const getIrTAt = (ir, targetWn) =>
      ir.points.reduce((best, p) => (Math.abs(p.wn - targetWn) < Math.abs(best.wn - targetWn) ? p : best), ir.points[0]).T;

    const vLipidIR = sim76.createApparatus('beaker_250', 220, 434);
    vLipidIR.moles = { C57H104O6_l: 0.02 };
    const irLipid = computeIrSpectrum(vLipidIR, { subtractWater: true });
    const axisDescOk =
      irLipid.points[0].wn === 4000 &&
      irLipid.points[irLipid.points.length - 1].wn === 400 &&
      irLipid.points.every((p, idx) => idx === 0 || p.wn < irLipid.points[idx - 1].wn);
    const esterTBefore = getIrTAt(irLipid, 1744);
    const cooTBefore = getIrTAt(irLipid, 1576);

    vLipidIR.moles = { H2O_l: 5.0, C17H33COO_aq: 0.06, C3H5OH_3_l: 0.02, Na_aq: 0.12, Cl_aq: 0.06 };
    const irSoap = computeIrSpectrum(vLipidIR, { subtractWater: true });
    const esterTAfter = getIrTAt(irSoap, 1744);
    const cooTAfter = getIrTAt(irSoap, 1576);
    const glyOhTAfter = getIrTAt(irSoap, 3355);
    const irSaponificationOk =
      axisDescOk &&
      esterTBefore < 35 &&
      esterTAfter > 85 &&
      cooTAfter < 40 &&
      cooTBefore > 80 &&
      glyOhTAfter < 65;

    // 3b) Fischer Esterification -> broad O-H decreases cleanly while Ester ~1744 grows
    const vEstIR = sim76.createApparatus('beaker_250', 340, 434);
    vEstIR.moles = { CH3COOH_l: 0.05, C2H5OH_l: 0.05 };
    const irEstBefore = computeIrSpectrum(vEstIR, { subtractWater: true });
    const ohInitT = getIrTAt(irEstBefore, 3355);
    vEstIR.moles = { CH3COOH_l: 0.015, C2H5OH_l: 0.015, CH3COOC2H5_l: 0.035, H2O_l: 0.035 };
    const irEstAfter = computeIrSpectrum(vEstIR, { subtractWater: true });
    const ohFinalT = getIrTAt(irEstAfter, 3355);
    const estPeakFinalT = getIrTAt(irEstAfter, 1744);
    const irEsterificationOk = ohInitT < 40 && ohFinalT > ohInitT + 15 && estPeakFinalT < 40;

    // 3c) H2O solvent subtraction toggle + Primary amine doublet + UI/Canvas rendering in Light & Dark
    const vWaterOnly = sim76.createApparatus('beaker_250', 460, 434);
    vWaterOnly.moles = { H2O_l: 5.0 };
    const irWaterSub = computeIrSpectrum(vWaterOnly, { subtractWater: true });
    const irWaterRaw = computeIrSpectrum(vWaterOnly, { subtractWater: false });
    const waterToggleOk = getIrTAt(irWaterSub, 3390) > 95 && getIrTAt(irWaterRaw, 3390) < 35;

    const vAmine = sim76.createApparatus('beaker_250', 580, 434);
    vAmine.moles = { C6H5NH2_l: 0.04 };
    const irAmine = computeIrSpectrum(vAmine, { subtractWater: true });
    const amineDoubletOk = getIrTAt(irAmine, 3420) < 60 && getIrTAt(irAmine, 3340) < 65;

    // Inspector UI + Canvas instrument render in uvvis_spectrum & ir_spectrum modes across Dark/Light themes
    const col76 = sim76.createApparatus('colorimeter', vMnO4.x, vMnO4.y - 35);
    let uiRenderOk = true;
    try {
      const cvs76 = document.createElement('canvas');
      cvs76.width = 240;
      cvs76.height = 240;
      const ctx76 = cvs76.getContext('2d');
      sim76.selectedId = col76.id;

      col76.spectroMode = 'uvvis_spectrum';
      stepAnalyticalInstruments(sim76, col76, 0.05);
      insp76.setTheme(true);
      insp76.update('vi', true);
      renderColorimeter(ctx76, col76, true, true);

      col76.x = vEstIR.x;
      col76.y = vEstIR.y - 35;
      col76.spectroMode = 'ir_spectrum';
      stepAnalyticalInstruments(sim76, col76, 0.05);
      insp76.setTheme(false);
      insp76.update('en', true);
      renderColorimeter(ctx76, col76, false, false);
    } catch {
      uiRenderOk = false;
    } finally {
      host76.remove();
    }

    assert(
      'Prompt 76 invariants: phenFlags soapSaltedOutCake sync, full UV–Vis (220–750 nm) + UV arene scan, FT-IR (4000->400 cm^-1 %T) saponification/esterification/H2O-subtract/amine doublet & Light/Dark UI render',
      phenFlagSyncOk && uvScanOk && irSaponificationOk && irEsterificationOk && waterToggleOk && amineDoubletOk && uiRenderOk,
      `phenSync=${phenFlagSyncOk}, uvScan=${uvScanOk}(MnLmax=${uvMnO4.lambdaMaxNm},PhMax=${uvPhenol.lambdaMaxNm}), irSap=${irSaponificationOk}(est:${esterTBefore.toFixed(1)}->${esterTAfter.toFixed(1)},coo:${cooTAfter.toFixed(1)}), irEst=${irEsterificationOk}(oh:${ohInitT.toFixed(1)}->${ohFinalT.toFixed(1)},est:${estPeakFinalT.toFixed(1)}), h2oSub=${waterToggleOk}, amine=${amineDoubletOk}, ui=${uiRenderOk}`
    );
  }

  // TEST 195: Prompt 77 — Closed Organic Bridges, Shelf Biologicals & Carbohydrates, Diazonium/Azo, Amino Acid/Protein/Enzyme Bell Curve & Synthetic Fibers/Adhesives
  {
    const sim77 = new LabSimulation();

    // 1) Closed Synthesis Bridges (Toluene from MeOH->CH3Cl->Benzene/AlCl3, Styrene->PS, Aniline Bechamp + H2/Ni, CH3NH2, VCM->PVC, Buna-S + Vulcanization)
    const vMeCl = sim77.createApparatus('round_flask_250', 140, 434);
    vMeCl.isStoppered = true;
    vMeCl.moles = { CH3OH_l: 0.1, H_aq: 0.15, Cl_aq: 0.15, ZnCl2_s: 0.02, H2O_l: 0.2 };
    const vFcTol = sim77.createApparatus('round_flask_250', 260, 434);
    vFcTol.isStoppered = true;
    vFcTol.moles = { C6H6_l: 0.1, CH3Cl_g: 0.06, AlCl3_s: 0.02 };
    const simEb = new LabSimulation();
    simEb.setAtmosphereMode('inert');
    const vEbSty = simEb.createApparatus('quartz_tube', 380, 434);
    const vEbRecv = simEb.createApparatus('round_flask_250', 520, 434);
    vEbSty.isStoppered = true;
    vEbSty.leftStoppered = true;
    vEbSty.rightStoppered = true;
    vEbSty.stopperMode = 'holed';
    vEbSty.connectedPortSide = 'right';
    vEbSty.connectedTargetId = vEbRecv.id;
    vEbRecv.connectedFromId = vEbSty.id;
    vEbSty.moles = { C6H5C2H5_l: 0.025, Fe2O3_s: 0.02 };
    const vBech = sim77.createApparatus('beaker_250', 500, 434);
    vBech.moles = { C6H5NO2_l: 0.04, Fe_s: 0.15, H_aq: 0.35, Cl_aq: 0.35, H2O_l: 2.0 };
    const vPvc = sim77.createApparatus('round_flask_250', 620, 434);
    vPvc.isStoppered = true;
    vPvc.moles = { C2H2_g: 0.08, HCl_g: 0.08, HgCl2_s: 0.01 };
    const vBunaS = sim77.createApparatus('beaker_250', 740, 434);
    vBunaS.moles = { C4H6_g: 0.06, C8H8_l: 0.06, Na_s: 0.015 };
    const vVulc = sim77.createApparatus('beaker_250', 860, 434);
    vVulc.moles = { Buna_S_s: 0.05, S_s: 0.05 };

    for (let i = 0; i < 8; i++) {
      vMeCl.tempK = 355.15;
      vFcTol.tempK = 310.15;
      vEbSty.tempK = 873.15;
      vBech.tempK = 345.15;
      vPvc.tempK = 423.15;
      vBunaS.tempK = 343.15;
      vVulc.tempK = 423.15;
      sim77.step(0.4);
    }
    for (let i = 0; i < 16; i++) {
      vEbSty.tempK = 873.15;
      simEb.step(0.2);
    }
    // Alkalinize Bechamp Anilinium salt -> oily Aniline
    vBech.moles.OH_aq = 0.25;
    vBech.moles.Na_aq = 0.25;
    sim77.step(0.2);

    const brgOk =
      ((vMeCl.headspaceGasMoles?.CH3Cl_g || 0) + (vMeCl.escapedGasMoles?.CH3Cl_g || 0) + (vMeCl.moles.CH3Cl_g || 0)) > 0.02 &&
      (vFcTol.moles.C6H5CH3_l || 0) > 0.02 &&
      ((vEbSty.moles.PS_s || 0) + (vEbRecv.moles.C8H8_l || 0) + (vEbRecv.headspaceGasMoles?.C8H8_g || 0) + (vEbSty.headspaceGasMoles?.C8H8_g || 0) + (vEbRecv.escapedGasMoles?.C8H8_g || 0)) > 0.01 &&
      ((vEbRecv.escapedGasMoles?.H2_g || 0) + (vEbRecv.headspaceGasMoles?.H2_g || 0) + (vEbSty.escapedGasMoles?.H2_g || 0)) > 0.01 &&
      (vBech.moles.C6H5NH2_l || 0) > 0.015 &&
      (vPvc.moles.PVC_s || 0) > 0.005 &&
      (vBunaS.moles.Buna_S_s || 0) > 0.02 &&
      (vVulc.moles.Vulcanized_Rubber_s || 0) > 0.01;

    // 2) Shelf bio reagents + Carbohydrates (Glucose vs Fructose Br2, Maltose, Cellulose + Schweizer + Trinitrate)
    const shelfOk = ['nano2', 'glucose', 'fructose', 'sucrose', 'starch', 'cellulose', 'glycine', 'albumin'].every((id) =>
      STARTER_REAGENTS.some((r) => r.id === id)
    );
    const vGlcBr = sim77.createApparatus('beaker_250', 140, 434);
    vGlcBr.moles = { H2O_l: 4.0, Glucose_aq: 0.04, Br2_aq: 0.02 };
    const vFrcBr = sim77.createApparatus('beaker_250', 260, 434);
    vFrcBr.moles = { H2O_l: 4.0, Fructose_aq: 0.04, Br2_aq: 0.02 };
    const vFrcTol = sim77.createApparatus('beaker_250', 380, 434);
    vFrcTol.moles = { H2O_l: 4.0, Fructose_aq: 0.04, AgNH3_2_aq: 0.06, OH_aq: 0.08 };
    const vSchw = sim77.createApparatus('beaker_250', 500, 434);
    vSchw.moles = { H2O_l: 4.0, Cellulose_s: 0.04, CuNH3_4_2_aq: 0.06, OH_aq: 0.14 };
    const vNitCel = sim77.createApparatus('beaker_250', 620, 434);
    vNitCel.moles = { H2O_l: 0.5, Cellulose_s: 0.02, NO3_aq: 0.15, H_aq: 0.15, H2SO4_l: 0.1 };
    const vMaltS = sim77.createApparatus('beaker_250', 740, 434);
    vMaltS.moles = { H2O_l: 4.0, Starch_aq: 0.05, H_aq: 0.008, Cl_aq: 0.008 };

    for (let i = 0; i < 8; i++) {
      vFrcTol.tempK = 330.15;
      vMaltS.tempK = 335.15;
      sim77.step(0.4);
    }
    const carb77Ok =
      (vGlcBr.moles.Br2_aq || 0) < (vFrcBr.moles.Br2_aq || 0) * 0.35 &&
      (vGlcBr.moles.Glucose_aq || 0) < 0.032 &&
      (vFrcBr.moles.Fructose_aq || 0) > 0.039 &&
      (vFrcTol.moles.Ag_s || 0) > 0.005 &&
      (vSchw.moles.CuCellulose_aq || 0) > 0.015 &&
      (vNitCel.moles.CelluloseNitrate_s || 0) > 0.008 &&
      (vMaltS.moles.Maltose_aq || 0) > 0.005;

    // 3) Amine + HNO2: CH3NH2 -> N2, Aniline 0-5 °C -> Diazonium -> Azo dye vs >10 °C -> Phenol + N2↑
    const vColdDiaz = sim77.createApparatus('beaker_250', 140, 400);
    vColdDiaz.moles = { H2O_l: 4.0, C6H5NH3_aq: 0.04, Cl_aq: 0.08, NO2_aq: 0.04, H_aq: 0.06 };
    const vWarmDiaz = sim77.createApparatus('beaker_250', 260, 400);
    vWarmDiaz.moles = { H2O_l: 4.0, C6H5NH3_aq: 0.04, Cl_aq: 0.08, NO2_aq: 0.04, H_aq: 0.06 };
    for (let i = 0; i < 6; i++) {
      vColdDiaz.tempK = 276.15; // 3 °C ice bath
      vWarmDiaz.tempK = 305.15; // 32 °C > 10 °C
      stepVesselChemistry(vColdDiaz, 0.4, { environment: sim77.environment });
      stepVesselChemistry(vWarmDiaz, 0.4, { environment: sim77.environment });
    }
    const diazFormedCold = vColdDiaz.moles.C6H5N2Cl_aq || 0;
    vColdDiaz.moles.Na_aq = (vColdDiaz.moles.Na_aq || 0) + 0.06;
    vColdDiaz.moles.OH_aq = 0.04;
    vColdDiaz.moles.C6H5O_aq = 0.03;
    for (let i = 0; i < 3; i++) {
      vColdDiaz.tempK = 276.15;
      stepVesselChemistry(vColdDiaz, 0.4, { environment: sim77.environment });
    }
    const diazOk =
      diazFormedCold > 0.025 &&
      (vColdDiaz.moles.AzoDye_s || 0) > 0.015 &&
      (vWarmDiaz.moles.C6H5OH_s || 0) > 0.015 &&
      (vWarmDiaz.moles.C6H5N2Cl_aq || 0) < 0.005;

    // 4) Amino acid pH/Litmus (Glu red < Gly/Ala purple < Lys blue), Protein coagulation/Xanthoproteic & Enzyme Bell Curve
    const pGlu = computePH({ H2O_l: 5.5, Glutamic_aq: 0.02 }, 0.1, 298.15);
    const pGly = computePH({ H2O_l: 5.5, Glycine_aq: 0.02 }, 0.1, 298.15);
    const pAla = computePH({ H2O_l: 5.5, Alanine_aq: 0.02 }, 0.1, 298.15);
    const pLys = computePH({ H2O_l: 5.5, Lysine_aq: 0.02 }, 0.1, 298.15);
    const aaPhOk = pGlu < 4.5 && pGly > 5.2 && pGly < 6.8 && pAla > 5.2 && pAla < 6.8 && pLys > 8.5;

    const vAlbHeat = sim77.createApparatus('beaker_250', 380, 434);
    vAlbHeat.moles = { H2O_l: 4.0, Albumin_aq: 0.03 };
    const vAlbXan = sim77.createApparatus('beaker_250', 500, 434);
    vAlbXan.moles = { H2O_l: 1.5, Albumin_aq: 0.03, NO3_aq: 0.12, H_aq: 0.12 };
    const vEnzOpt = sim77.createApparatus('beaker_250', 620, 434);
    vEnzOpt.moles = { H2O_l: 4.0, H2O2_aq: 0.04, Catalase_aq: 0.002 };
    const vEnzBoil = sim77.createApparatus('beaker_250', 740, 434);
    vEnzBoil.moles = { H2O_l: 4.0, H2O2_aq: 0.04, Catalase_aq: 0.002 };
    for (let i = 0; i < 6; i++) {
      vAlbHeat.tempK = 350.15; // > 65 °C
      vEnzOpt.tempK = 311.15; // 38 °C optimum
      vEnzBoil.tempK = 358.15; // > 75 °C denatures!
      sim77.step(0.35);
    }
    const bio77Ok =
      aaPhOk &&
      (vAlbHeat.moles.AlbuminCoagulated_s || 0) > 0.02 &&
      (vAlbXan.moles.AlbuminXantho_s || 0) > 0.02 &&
      (vEnzOpt.moles.H2O2_aq || 0) < 0.005 &&
      (vEnzBoil.moles.CatalaseDenatured_s || 0) > 0.001 &&
      (vEnzBoil.moles.H2O2_aq || 0) > 0.035;

    // 5) Synthetic Fibers & 2-Component Adhesives (Nylon-6,6 two-phase, Nylon-6, PAN, UF, Epoxy exothermic curing)
    const vNy66 = sim77.createApparatus('beaker_250', 140, 434);
    vNy66.moles = { H2O_l: 3.0, HexamethyleneDiamine_aq: 0.03, AdipoylChloride_l: 0.03 };
    const vEpoxy = sim77.createApparatus('beaker_250', 260, 434);
    vEpoxy.moles = { EpoxyResin_l: 0.04, EpoxyHardener_l: 0.04 };
    vEpoxy.tempK = 298.15;
    const epoxyT0 = vEpoxy.tempK;
    const vPan = sim77.createApparatus('beaker_250', 380, 434);
    vPan.moles = { Acrylonitrile_l: 0.04 };
    const vUf = sim77.createApparatus('beaker_250', 500, 434);
    vUf.moles = { H2O_l: 2.0, Urea_s: 0.04, HCHO_aq: 0.04 };
    for (let i = 0; i < 8; i++) {
      vPan.tempK = 348.15;
      vUf.tempK = 333.15;
      sim77.step(0.4);
    }
    const poly77Ok =
      (vNy66.moles.Nylon66_s || 0) > 0.012 &&
      (vEpoxy.moles.EpoxyPolymer_s || 0) > 0.015 &&
      vEpoxy.tempK > epoxyT0 + 0.5 &&
      (vPan.moles.PAN_s || 0) > 0.015 &&
      (vUf.moles.UF_Resin_s || 0) > 0.01;

    assert(
      'Prompt 77 invariants: organic bridges (MeOH->MeCl->Toluene, Styrene->PS, Aniline, VCM->PVC, Buna-S/vulc), shelf bio & Glu/Frc/Maltose/Cellulose, Diazonium 0-5C vs >10C + Azo, AA pH/Albumin/Bell Enzyme & Nylon-6,6/PAN/UF/Epoxy',
      brgOk && shelfOk && carb77Ok && diazOk && bio77Ok && poly77Ok,
      `brg=${brgOk}, shelf=${shelfOk}, carb=${carb77Ok}, diaz=${diazOk}(cold=${diazFormedCold.toFixed(3)},azo=${(vColdDiaz.moles.AzoDye_s||0).toFixed(3)},hotPh=${(vWarmDiaz.moles.C6H5OH_s||0).toFixed(3)}), bio=${bio77Ok}(pH:${pGlu.toFixed(1)}/${pGly.toFixed(1)}/${pLys.toFixed(1)},enzOptH2O2=${(vEnzOpt.moles.H2O2_aq||0).toFixed(3)},enzBoilH2O2=${(vEnzBoil.moles.H2O2_aq||0).toFixed(3)}), poly=${poly77Ok}`
    );
  }
}
