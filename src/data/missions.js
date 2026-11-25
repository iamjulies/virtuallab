/**
 * Data-Driven Mission Registry for Practical Lab & Assessment Mode (Prompt 83).
 * Pure declarative mission definitions + seeded setup generators.
 */
import { APPARATUS } from './apparatus.js';
import { CONSTANTS } from './constants.js';
import { ELECTRODE_MATERIALS } from '../engine/electrochemistry.js';

export function createSeededRng(seed = 1) {
  let s = (Math.floor(Math.abs(Number(seed) || 1)) % 2147483647) || 1;
  return () => {
    s = (s * 48271) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function shuffleWithRng(arr, rng) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createCleanBench(sim) {
  sim.withUndoSuppressed(() => {
    sim.items = [];
    sim.selectedId = null;
    sim.selectedIds?.clear?.();
    sim.compareVesselIds = [];
    sim.logs = [];
    sim.timedTransfers = [];
    sim.timeSec = 0;
    sim.environment.tempK = CONSTANTS.T_STD_K;
    sim.environment.pressureBar = CONSTANTS.P_STD_BAR;
    sim.environment.paused = false;
    sim.environment.speed = 1.0;
    sim.environment.atmosphereMode = 'air';
    sim.pipette = {
      capacityMl: 10.0,
      volumeMl: 0,
      moles: {},
      tempK: CONSTANTS.T_STD_K,
      sourceLabel: '',
      hideComposition: false,
      blindLabel: null,
    };
  });
}

export const MISSION_REGISTRY = {
  mission_qualitative_4: {
    id: 'mission_qualitative_4',
    order: 1,
    topic: 'qualitative',
    difficulty: 'basic',
    titleKey: 'm1Title',
    shortTitleKey: 'm1Short',
    summaryKey: 'm1Summary',
    goalKey: 'm1Goal',
    equationText: 'Na₂CO₃ + 2HCl → 2NaCl + CO₂↑ + H₂O  |  BaCl₂ + Na₂CO₃ → BaCO₃↓(white) + 2NaCl  |  HCl + NaOH → NaCl + H₂O',
    allowedApparatus: ['test_tube_50', 'beaker_250', 'pipette_10', 'litmus_paper', 'ph_strip', 'ph_conductometer', 'wash_bottle', 'stir_bar'],
    allowedReagents: ['h2o'],
    maxExtraTools: 10,
    hints: ['m1Hint1', 'm1Hint2', 'm1Hint3'],
    submitFields: [
      { id: 'ans_?A', labelKey: 'm1FieldA', type: 'select', options: ['HCl', 'NaOH', 'Na₂CO₃', 'BaCl₂'] },
      { id: 'ans_?B', labelKey: 'm1FieldB', type: 'select', options: ['HCl', 'NaOH', 'Na₂CO₃', 'BaCl₂'] },
      { id: 'ans_?C', labelKey: 'm1FieldC', type: 'select', options: ['HCl', 'NaOH', 'Na₂CO₃', 'BaCl₂'] },
      { id: 'ans_?D', labelKey: 'm1FieldD', type: 'select', options: ['HCl', 'NaOH', 'Na₂CO₃', 'BaCl₂'] },
    ],
    rubric: [
      { id: 'm1_proc', category: 'process', maxPoints: 2.5, labelKey: 'm1RubProc' },
      { id: 'm1_quant', category: 'quantitative', maxPoints: 1.5, labelKey: 'm1RubQuant' },
      { id: 'm1_ident', category: 'identification', maxPoints: 5.0, labelKey: 'm1RubIdent' },
      { id: 'm1_safe', category: 'safety', maxPoints: 1.0, labelKey: 'm1RubSafe' },
    ],
    setup(sim, seed = 101) {
      createCleanBench(sim);
      const rng = createSeededRng(seed);
      const labels = ['?A', '?B', '?C', '?D'];
      const solutions = shuffleWithRng([
        { key: 'HCl', moles: { H2O_l: 4.44, H_aq: 0.016, Cl_aq: 0.016 } },
        { key: 'NaOH', moles: { H2O_l: 4.44, Na_aq: 0.016, OH_aq: 0.016 } },
        { key: 'Na₂CO₃', moles: { H2O_l: 4.44, Na_aq: 0.032, CO3_2_aq: 0.016 } },
        { key: 'BaCl₂', moles: { H2O_l: 4.44, Ba2_aq: 0.012, Cl_aq: 0.024 } },
      ], rng);

      const answerKey = {};
      const blindVesselIds = [];
      const initialVols = {};

      sim.withUndoSuppressed(() => {
        labels.forEach((lbl, idx) => {
          const sol = solutions[idx];
          const v = sim.createApparatus('beaker_250', 175 + idx * 145, 420, { silentUndo: true });
          v.moles = { ...sol.moles };
          v.hideComposition = true;
          v.blindLabel = lbl;
          v.label = lbl;
          v.initialVolumeMl = 80;
          blindVesselIds.push(v.id);
          answerKey[lbl] = sol.key;
          initialVols[v.id] = 80;
        });
        // Add clean test tube rack pair + pipette + litmus paper for immediate workflow
        sim.createApparatus('test_tube_50', 760, 425, { silentUndo: true });
        sim.createApparatus('test_tube_50', 815, 425, { silentUndo: true });
        sim.createApparatus('pipette_10', 705, 360, { silentUndo: true });
        sim.createApparatus('litmus_paper', 875, 420, { silentUndo: true });
      });
      sim.selectedId = blindVesselIds[0];
      return {
        answerKey,
        blindVesselIds,
        initialVols,
        sampleCount: 4,
      };
    },
  },

  mission_titration_hcl: {
    id: 'mission_titration_hcl',
    order: 2,
    topic: 'titration',
    difficulty: 'basic',
    titleKey: 'm2Title',
    shortTitleKey: 'm2Short',
    summaryKey: 'm2Summary',
    goalKey: 'm2Goal',
    equationText: 'HCl(aq) + NaOH(aq) → NaCl(aq) + H₂O(l)   |   C₁·V₁ = C₂·V₂',
    allowedApparatus: ['erlenmeyer_250', 'burette_50', 'retort_stand', 'pipette_10', 'ph_conductometer', 'ph_strip', 'litmus_paper', 'stir_bar', 'wash_bottle'],
    allowedReagents: ['phen', 'h2o', 'naoh'],
    maxExtraTools: 6,
    hints: ['m2Hint1', 'm2Hint2', 'm2Hint3'],
    submitFields: [
      { id: 'ans_molarity', labelKey: 'm2FieldMolarity', type: 'number', min: 0.01, max: 1.0, step: 0.001, placeholder: '0.120' },
    ],
    rubric: [
      { id: 'm2_proc', category: 'process', maxPoints: 2.5, labelKey: 'm2RubProc' },
      { id: 'm2_quant', category: 'quantitative', maxPoints: 2.5, labelKey: 'm2RubQuant' },
      { id: 'm2_ident', category: 'identification', maxPoints: 4.0, labelKey: 'm2RubIdent' },
      { id: 'm2_safe', category: 'safety', maxPoints: 1.0, labelKey: 'm2RubSafe' },
    ],
    setup(sim, seed = 202) {
      createCleanBench(sim);
      const rng = createSeededRng(seed);
      // Randomize HCl molarity between 0.080 M and 0.180 M in clean 0.005 M steps
      const stepIdx = Math.floor(rng() * 21); // 0..20
      const targetMolarityM = +(0.080 + stepIdx * 0.005).toFixed(3);
      const volHClMl = 25.0;
      const molHCl = targetMolarityM * (volHClMl / 1000);
      const molH2O = (volHClMl * 0.997) / CONSTANTS.M_H2O;

      let flask = null;
      let bur = null;
      sim.withUndoSuppressed(() => {
        const stand = sim.createApparatus('retort_stand', 440, 355, { silentUndo: true });
        flask = sim.createApparatus('erlenmeyer_250', 440, 412, { silentUndo: true });
        flask.moles = {
          H2O_l: molH2O,
          H_aq: molHCl,
          Cl_aq: molHCl,
        };
        flask.hideComposition = true;
        flask.blindLabel = '?X';
        flask.label = '?X';

        bur = sim.createApparatus('burette_50', 440, 225, { silentUndo: true });
        bur.clampedToId = stand.id;
        // 50.0 mL standard NaOH 0.100 M
        bur.moles = {
          H2O_l: (50.0 * 0.998) / CONSTANTS.M_H2O,
          Na_aq: 0.005,
          OH_aq: 0.005,
        };
        bur.valveRateMlS = 0; // Start completely closed so student controls titration
        sim.createApparatus('ph_conductometer', 595, 405, { silentUndo: true });
      });
      sim.selectedId = bur.id;
      return {
        answerKey: {
          targetMolarityM,
          volHClMl,
          titrantMolarityM: 0.100,
          equivVolNaohMl: +(volHClMl * targetMolarityM / 0.100).toFixed(2),
        },
        blindVesselIds: [flask.id],
        targetVesselId: flask.id,
        buretteId: bur.id,
      };
    },
  },

  mission_calcination_cao: {
    id: 'mission_calcination_cao',
    order: 3,
    topic: 'calcination',
    difficulty: 'intermediate',
    titleKey: 'm3Title',
    shortTitleKey: 'm3Short',
    summaryKey: 'm3Summary',
    goalKey: 'm3Goal',
    equationText: 'CaCO₃(s) —(Δ ≥ 850 °C)→ CaO(s) + CO₂(g)↑',
    allowedApparatus: ['crucible_porcelain', 'mortar_pestle', 'bunsen_burner', 'retort_stand', 'thermometer', 'scale', 'beaker_250', 'iron_spoon', 'litmus_paper', 'pipette_10'],
    allowedReagents: ['caco3', 'h2o'],
    maxExtraTools: 5,
    hints: ['m3Hint1', 'm3Hint2', 'm3Hint3'],
    submitFields: [
      { id: 'ans_gas', labelKey: 'm3FieldGas', type: 'select', options: ['CO₂', 'O₂', 'H₂', 'CO'] },
      { id: 'ans_product', labelKey: 'm3FieldProduct', type: 'select', options: ['CaO', 'Ca(OH)₂', 'CaC₂', 'CaCl₂'] },
    ],
    rubric: [
      { id: 'm3_proc', category: 'process', maxPoints: 4.0, labelKey: 'm3RubProc' },
      { id: 'm3_quant', category: 'quantitative', maxPoints: 4.0, labelKey: 'm3RubQuant' },
      { id: 'm3_ident', category: 'identification', maxPoints: 1.0, labelKey: 'm3RubIdent' },
      { id: 'm3_safe', category: 'safety', maxPoints: 1.0, labelKey: 'm3RubSafe' },
    ],
    setup(sim, seed = 303) {
      createCleanBench(sim);
      const rng = createSeededRng(seed);
      const baseMol = +(0.045 + Math.floor(rng() * 3) * 0.01).toFixed(3); // 0.045, 0.055, 0.065 mol
      let crucible = null;
      let mortar = null;
      let bunsen = null;
      sim.withUndoSuppressed(() => {
        mortar = sim.createApparatus('mortar_pestle', 250, 445, { silentUndo: true });
        mortar.moles = { CaCO3_s: baseMol };
        crucible = sim.createApparatus('crucible_porcelain', 450, 445, { silentUndo: true });
        crucible.lidState = 'open';
        bunsen = sim.createApparatus('bunsen_burner', 450, 440, { silentUndo: true });
        bunsen.airHoleOpen = false; // Student must open collar for blue roaring flame!
        sim.createApparatus('retort_stand', 560, 355, { silentUndo: true });
        sim.createApparatus('thermometer', 650, 420, { silentUndo: true });
        sim.createApparatus('scale', 775, 442, { silentUndo: true });
      });
      sim.selectedId = mortar.id;
      return {
        answerKey: {
          gas: 'CO₂',
          product: 'CaO',
          initialCaCO3Mol: baseMol,
        },
        crucibleId: crucible.id,
        mortarId: mortar.id,
        burnerId: bunsen.id,
      };
    },
  },

  mission_gas_prep: {
    id: 'mission_gas_prep',
    order: 4,
    topic: 'gas_prep',
    difficulty: 'intermediate',
    titleKey: 'm4Title',
    shortTitleKey: 'm4Short',
    summaryKey: 'm4Summary',
    goalKey: 'm4Goal',
    equationText: 'Zn + 2HCl → ZnCl₂ + H₂↑   |   MnO₂ / KMnO₄ + HCl(conc) → Cl₂↑ (dry over H₂SO₄)',
    allowedApparatus: ['round_flask_250', 'erlenmeyer_250', 'beaker_250', 'test_tube_50', 'gas_syringe', 'separatory_funnel', 'bunsen_burner', 'retort_stand', 'rubber_stopper', 'splint', 'litmus_paper', 'ph_strip', 'pipette_10'],
    allowedReagents: ['zn', 'kmno4', 'hcl_37', 'h2so4_98', 'nacl', 'h2o'],
    maxExtraTools: 6,
    hints: ['m4Hint1', 'm4Hint2', 'm4Hint3'],
    submitFields: [
      { id: 'ans_gas', labelKey: 'm4FieldGas', type: 'select', options: ['H₂', 'Cl₂', 'O₂', 'CO₂'] },
      { id: 'ans_drying', labelKey: 'm4FieldDrying', type: 'select', options: ['H₂SO₄(conc)', 'NaOH(aq)', 'H₂O(l)', 'NH₃(aq)'] },
    ],
    rubric: [
      { id: 'm4_proc', category: 'process', maxPoints: 3.0, labelKey: 'm4RubProc' },
      { id: 'm4_quant', category: 'quantitative', maxPoints: 4.0, labelKey: 'm4RubQuant' },
      { id: 'm4_ident', category: 'identification', maxPoints: 1.0, labelKey: 'm4RubIdent' },
      { id: 'm4_safe', category: 'safety', maxPoints: 2.0, labelKey: 'm4RubSafe' },
    ],
    setup(sim, seed = 404) {
      createCleanBench(sim);
      const rng = createSeededRng(seed);
      const isChlorineVariant = rng() >= 0.5;
      let genFlask = null;
      let washDry = null;
      let syr = null;
      sim.withUndoSuppressed(() => {
        genFlask = sim.createApparatus('round_flask_250', 220, 415, { silentUndo: true });
        genFlask.moles = isChlorineVariant
          ? { MnO2_s: 0.03 }
          : { Zn_s: 0.025 };
        if (isChlorineVariant) {
          sim.createApparatus('bunsen_burner', 220, 465, { silentUndo: true });
        }
        washDry = sim.createApparatus('erlenmeyer_250', 430, 415, { silentUndo: true });
        // Leave wash/drying flask empty or pre-equipped stand; let student pour conc. H2SO4 drying agent & connect tubing!
        syr = sim.createApparatus('gas_syringe', 660, 405, { silentUndo: true });
      });
      sim.selectedId = genFlask.id;
      return {
        variant: isChlorineVariant ? 'Cl2' : 'H2',
        answerKey: {
          gas: isChlorineVariant ? 'Cl₂' : 'H₂',
          targetGasId: isChlorineVariant ? 'Cl2_g' : 'H2_g',
          dryingAgent: 'H₂SO₄(conc)',
        },
        generatorId: genFlask.id,
        washBottleId: washDry.id,
        targetSyringeId: syr.id,
      };
    },
  },

  mission_electrochem_cell: {
    id: 'mission_electrochem_cell',
    order: 5,
    topic: 'electrochemistry',
    difficulty: 'advanced',
    titleKey: 'm5Title',
    shortTitleKey: 'm5Short',
    summaryKey: 'm5Summary',
    goalKey: 'm5Goal',
    equationText: 'Zn + 2H⁺ → Zn²⁺ + H₂↑ (E°_cell = +0.76 V)  |  Fe protected by Mg/Zn sacrificial anode',
    allowedApparatus: ['beaker_250', 'beaker_tall_250', 'electrode_rod', 'salt_bridge', 'volt_ammeter', 'dc_power', 'ph_conductometer', 'pipette_10', 'gas_syringe'],
    allowedReagents: ['zn', 'mg', 'fe', 'cuso4_5h2o', 'agno3', 'hcl_37', 'h2so4_98', 'nacl', 'h2o'],
    maxExtraTools: 6,
    hints: ['m5Hint1', 'm5Hint2', 'm5Hint3'],
    submitFields: [
      { id: 'ans_anode', labelKey: 'm5FieldAnode', type: 'select', options: ['Zn', 'Mg', 'Fe', 'Cu', 'SHE (Pt|H₂)', 'Ag'] },
      { id: 'ans_emf', labelKey: 'm5FieldEmf', type: 'number', min: 0.0, max: 5.0, step: 0.01, placeholder: '0.76' },
    ],
    rubric: [
      { id: 'm5_proc', category: 'process', maxPoints: 3.0, labelKey: 'm5RubProc' },
      { id: 'm5_quant', category: 'quantitative', maxPoints: 4.0, labelKey: 'm5RubQuant' },
      { id: 'm5_ident', category: 'identification', maxPoints: 2.0, labelKey: 'm5RubIdent' },
      { id: 'm5_safe', category: 'safety', maxPoints: 1.0, labelKey: 'm5RubSafe' },
    ],
    setup(sim, seed = 505) {
      createCleanBench(sim);
      const rng = createSeededRng(seed);
      const isSacrificialMode = rng() >= 0.5;
      let bLeft = null;
      let bRight = null;
      let elL = null;
      let elR = null;
      let sb = null;
      let dmm = null;

      sim.withUndoSuppressed(() => {
        if (isSacrificialMode) {
          // Variant B: Protect Fe rod in acidic HCl + NaCl medium by connecting a Zn or Mg sacrificial anode
          bLeft = sim.createApparatus('beaker_250', 380, 415, { silentUndo: true });
          bLeft.moles = { H2O_l: 5.55, H_aq: 0.02, Cl_aq: 0.07, Na_aq: 0.05 };
          elL = sim.createApparatus('electrode_rod', 355, 360, { silentUndo: true });
          sim.setElectrodeMaterial(elL.id, 'Fe');
          elL.dockedVesselId = bLeft.id;
          elR = sim.createApparatus('electrode_rod', 405, 360, { silentUndo: true });
          sim.setElectrodeMaterial(elR.id, 'C'); // Student chooses Zn or Mg!
          elR.dockedVesselId = bLeft.id;
          dmm = sim.createApparatus('volt_ammeter', 380, 235, { silentUndo: true });
          dmm.mode = 'ammeter';
          dmm.posElectrodeId = elL.id;
          dmm.negElectrodeId = elR.id;
        } else {
          // Variant A: Assemble Zn | Zn2+(1M) || H+(1M) | H2(1bar) | Pt (SHE) standard cell (E° = 0.76 V)
          bLeft = sim.createApparatus('beaker_250', 270, 415, { silentUndo: true });
          bLeft.moles = { H2O_l: 5.55, Zn2_aq: 0.1, SO4_2_aq: 0.1 };
          bRight = sim.createApparatus('beaker_250', 490, 415, { silentUndo: true });
          bRight.moles = { H2O_l: 5.55, H_aq: 0.1, Cl_aq: 0.1 };
          elL = sim.createApparatus('electrode_rod', 270, 360, { silentUndo: true });
          sim.setElectrodeMaterial(elL.id, 'C'); // Student switches to Zn
          elL.dockedVesselId = bLeft.id;
          elR = sim.createApparatus('electrode_rod', 490, 360, { silentUndo: true });
          sim.setElectrodeMaterial(elR.id, 'C'); // Student switches to SHE
          elR.dockedVesselId = bRight.id;
          sb = sim.createApparatus('salt_bridge', 380, 378, { silentUndo: true });
          sb.vesselAId = bLeft.id;
          sb.vesselBId = bRight.id;
          sim.setSaltBridgeElectrolyte(sb.id, 'KNO3');
          dmm = sim.createApparatus('volt_ammeter', 380, 235, { silentUndo: true });
          dmm.mode = 'voltmeter';
          dmm.posElectrodeId = elR.id;
          dmm.negElectrodeId = elL.id;
        }
      });
      sim.selectedId = elL.id;
      return {
        variant: isSacrificialMode ? 'sacrificial' : 'she_cell',
        answerKey: isSacrificialMode
          ? {
              mode: 'sacrificial',
              validAnodes: ['Zn', 'Mg'],
              targetEmfV: 0.315, // Fe (-0.447) vs Zn (-0.762) = ~0.31V
              protectedVesselId: bLeft.id,
              feElectrodeId: elL.id,
              feInitialMol: ELECTRODE_MATERIALS.Fe.defaultMol,
            }
          : {
              mode: 'she_cell',
              validAnodes: ['Zn'],
              targetEmfV: 0.762,
              leftVesselId: bLeft.id,
              rightVesselId: bRight.id,
            },
        dmmId: dmm.id,
        saltBridgeId: sb?.id || null,
        elLeftId: elL.id,
        elRightId: elR.id,
      };
    },
  },

  mission_ester_synth: {
    id: 'mission_ester_synth',
    order: 6,
    topic: 'organic',
    difficulty: 'advanced',
    titleKey: 'm6Title',
    shortTitleKey: 'm6Short',
    summaryKey: 'm6Summary',
    goalKey: 'm6Goal',
    equationText: 'CH₃COOH + C₂H₅OH ⇌(H₂SO₄ conc, Δ) CH₃COOC₂H₅ + H₂O',
    allowedApparatus: ['round_flask_250', 'erlenmeyer_250', 'beaker_250', 'liebig_condenser', 'separatory_funnel', 'bunsen_burner', 'retort_stand', 'thermometer', 'boiling_chips', 'rubber_stopper', 'pipette_10', 'wash_bottle'],
    allowedReagents: ['ch3cooh', 'etoh', 'h2so4_98', 'naoh', 'nacl', 'h2o'],
    maxExtraTools: 7,
    hints: ['m6Hint1', 'm6Hint2', 'm6Hint3'],
    submitFields: [
      { id: 'ans_layer', labelKey: 'm6FieldLayer', type: 'select', options: ['top_organic', 'bottom_aqueous'] },
      { id: 'ans_ester', labelKey: 'm6FieldName', type: 'select', options: ['Ethyl acetate', 'Acetic acid', 'Ethanol', 'Diethyl ether'] },
    ],
    rubric: [
      { id: 'm6_proc', category: 'process', maxPoints: 3.5, labelKey: 'm6RubProc' },
      { id: 'm6_quant', category: 'quantitative', maxPoints: 3.5, labelKey: 'm6RubQuant' },
      { id: 'm6_ident', category: 'identification', maxPoints: 2.0, labelKey: 'm6RubIdent' },
      { id: 'm6_safe', category: 'safety', maxPoints: 1.0, labelKey: 'm6RubSafe' },
    ],
    setup(sim, seed = 606) {
      createCleanBench(sim);
      const rng = createSeededRng(seed);
      const rxnScale = rng() >= 0.5 ? 0.12 : 0.10;
      let flask = null;
      let cond = null;
      let recv = null;
      let sep = null;
      sim.withUndoSuppressed(() => {
        const stand = sim.createApparatus('retort_stand', 310, 355, { silentUndo: true });
        flask = sim.createApparatus('round_flask_250', 240, 412, { silentUndo: true });
        flask.moles = {
          CH3COOH_l: rxnScale,
          C2H5OH_l: +(rxnScale * 1.25).toFixed(3),
          H2SO4_l: 0.02,
        };
        flask.hasBoilingChips = true;
        sim.createApparatus('bunsen_burner', 240, 465, { silentUndo: true });
        cond = sim.createApparatus('liebig_condenser', 380, 315, { silentUndo: true });
        cond.clampedToId = stand.id;
        cond.coolantOn = true;
        recv = sim.createApparatus('erlenmeyer_250', 525, 420, { silentUndo: true });
        sep = sim.createApparatus('separatory_funnel', 725, 315, { silentUndo: true });
      });
      sim.selectedId = flask.id;
      return {
        answerKey: {
          layer: 'top_organic',
          esterName: 'Ethyl acetate',
          expectedMinMol: 0.015,
        },
        reactFlaskId: flask.id,
        condenserId: cond.id,
        receiverId: recv.id,
        sepFunnelId: sep.id,
      };
    },
  },
};

export const MISSION_ORDER = [
  'mission_qualitative_4',
  'mission_titration_hcl',
  'mission_calcination_cao',
  'mission_gas_prep',
  'mission_electrochem_cell',
  'mission_ester_synth',
];

export function getMissionById(id) {
  return MISSION_REGISTRY[id] || null;
}

export function getActiveMissionPolicy(sim) {
  const ms = sim?.missionState;
  if (!ms?.active) return null;
  return getMissionById(ms.missionId) || ms;
}

export function isApparatusAllowedInMission(missionOrState, typeId) {
  if (!missionOrState || !Array.isArray(missionOrState.allowedApparatus) || missionOrState.allowedApparatus.length === 0) return true;
  if (!APPARATUS[typeId]) return false;
  return missionOrState.allowedApparatus.includes(typeId);
}

export function isReagentAllowedInMission(missionOrState, reagentId) {
  if (!missionOrState || missionOrState.allowedReagents === null || missionOrState.allowedReagents === undefined) return true;
  return missionOrState.allowedReagents.includes(reagentId);
}
