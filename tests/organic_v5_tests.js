/**
 * Modular Verification Suite for Organic Solver v5 Architecture & Beyond (Prompt 66+).
 */
import { CONSTANTS } from '../src/data/constants.js';
import { SPECIES } from '../src/data/species.js';
import { LabSimulation } from '../src/engine/simulation.js';
import { renderVesselSolids } from '../src/canvas/chemicalVisuals.js';

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
}
