/**
 * Guided Experiment Scenarios (Thí nghiệm mẫu / Presets Registry — Prompt 68).
 * Centralized single source of truth shared between EnvironmentBar menu & LabSimulation.
 */
import { APPARATUS } from './apparatus.js';
import { syncDockedToolPositions } from '../engine/apparatusTools.js';

export const PRESET_MENU_ITEMS = [
  { id: 'starter', i18nKey: 'presetStarter' },
  { id: 'clean', i18nKey: 'presetClean' },
  { id: 'ester_distill', i18nKey: 'presetEsterDistill' },
  { id: 'titration_probe', i18nKey: 'presetTitrationProbe' },
  { id: 'starch_colorimetry', i18nKey: 'presetStarchColorimetry' },
  { id: 'compare_rate_factors', i18nKey: 'presetCompareRateFactors' },
  { id: 'compare_corrosion', i18nKey: 'presetCompareCorrosion' },
  { id: 'caco3_calcination_limewater', i18nKey: 'presetCaco3Calcination' },
  { id: 'cu_ammine_complex', i18nKey: 'presetCuAmmineComplex' },
  { id: 'cuo_h2_reduction', i18nKey: 'presetCuoH2Reduction' },
  { id: 'zn_burn_o2', i18nKey: 'presetZnBurnO2' },
  { id: 'air_tarnish_deliquesce', i18nKey: 'presetAirTarnish' },
  { id: 'na_water_phen', i18nKey: 'presetNaWaterPhen' },
  { id: 'copper_hydroxide_series', i18nKey: 'presetCuSeries' },
  { id: 'amphoteric_zn_cu', i18nKey: 'presetAmphotericZnCu' },
  { id: 'gas_collect', i18nKey: 'presetGasCollect' },
  { id: 'trough_collect', i18nKey: 'presetTroughCollect' },
  { id: 'titration', i18nKey: 'presetTitration' },
  { id: 'filtration', i18nKey: 'presetFiltration' },
  { id: 'daniell_cell', i18nKey: 'presetDaniellCell' },
  { id: 'electrolysis', i18nKey: 'presetElectrolysis' },
  { id: 'distillation', i18nKey: 'presetDistillation' },
  { id: 'ammonia_fountain', i18nKey: 'presetAmmoniaFountain' },
  { id: 'graham_diffusion', i18nKey: 'presetGrahamDiffusion' },
];

export function applyPresetScenario(sim, presetName, floorY = 482) {
    if (presetName === 'clean') {
      // Truly empty workbench (0 items)
      sim.selectedId = null;
      sim.emitChange();
      return;
    }

    if (presetName === 'gas_collect') {
      const flask = sim.createApparatus('erlenmeyer_250', 290, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      const stand = sim.createApparatus('retort_stand', 685, floorY - APPARATUS.retort_stand.height / 2 + 2);
      const syringe = sim.createApparatus('gas_syringe', 625, 325);
      sim.attachToStand(syringe.id, stand.id);
      sim.createApparatus('burner', 135, floorY - APPARATUS.burner.height / 2 + 2);
      sim.connectSyringe(flask.id, syringe.id);
      sim.selectedId = flask.id;
    } else if (presetName === 'trough_collect') {
      const flask = sim.createApparatus('erlenmeyer_250', 220, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      const trough = sim.createApparatus('water_trough', 540, floorY - APPARATUS.water_trough.height / 2 + 2);
      const tube = sim.createApparatus('test_tube_50', trough.x, trough.y - 68);
      sim.toggleVesselInverted(tube.id);
      tube.submergedInTroughId = trough.id;
      sim.connectTube(flask.id, tube.id);
      sim.selectedId = flask.id;
    } else if (presetName === 'titration') {
      const stand = sim.createApparatus('retort_stand', 360, floorY - APPARATUS.retort_stand.height / 2 + 2);
      const burette = sim.createApparatus('burette_50', 300, 235);
      sim.attachToStand(burette.id, stand.id);
      const flask = sim.createApparatus('erlenmeyer_250', 300, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      const stirBar = sim.createApparatus('stir_bar', 490, floorY - 8);
      sim.insertStirBarIntoVessel(stirBar.id, flask.id, 600);
      sim.createApparatus('litmus_paper', 540, floorY - 12);
      sim.selectedId = burette.id;
    } else if (presetName === 'filtration') {
      const beaker = sim.createApparatus('beaker_250', 340, floorY - APPARATUS.beaker_250.height / 2 + 2);
      const funnel = sim.createApparatus('filter_funnel', 340, beaker.y - APPARATUS.beaker_250.height / 2 - APPARATUS.filter_funnel.height * 0.18);
      funnel.mountedOnVesselId = beaker.id;
      sim.createApparatus('wash_bottle', 450, floorY - APPARATUS.wash_bottle.height / 2 + 2);
      sim.createApparatus('beaker_tall_250', 180, floorY - APPARATUS.beaker_tall_250.height / 2 + 2);
      sim.selectedId = funnel.id;
    } else if (presetName === 'daniell_cell') {
      const bLeft = sim.createApparatus('beaker_250', 270, floorY - APPARATUS.beaker_250.height / 2 + 2);
      const bRight = sim.createApparatus('beaker_250', 410, floorY - APPARATUS.beaker_250.height / 2 + 2);
      const bridge = sim.createApparatus('salt_bridge', 340, bLeft.y - 36);
      bridge.vesselAId = bLeft.id;
      bridge.vesselBId = bRight.id;
      const elZn = sim.createApparatus('electrode_rod', bLeft.x - 16, bLeft.y - 16);
      elZn.material = 'Zn';
      elZn.dockedVesselId = bLeft.id;
      elZn.dockSide = 'left';
      const elCu = sim.createApparatus('electrode_rod', bRight.x + 16, bRight.y - 16);
      elCu.material = 'Cu';
      elCu.dockedVesselId = bRight.id;
      elCu.dockSide = 'right';
      const dmm = sim.createApparatus('volt_ammeter', 620, floorY - APPARATUS.volt_ammeter.height / 2 + 2);
      dmm.posElectrodeId = elCu.id;
      dmm.negElectrodeId = elZn.id;
      sim.selectedId = dmm.id;
    } else if (presetName === 'electrolysis') {
      const beaker = sim.createApparatus('beaker_250', 300, floorY - APPARATUS.beaker_250.height / 2 + 2);
      const elA = sim.createApparatus('electrode_rod', beaker.x - 24, beaker.y - 16);
      elA.material = 'C';
      elA.dockedVesselId = beaker.id;
      elA.dockSide = 'left';
      const elB = sim.createApparatus('electrode_rod', beaker.x + 24, beaker.y - 16);
      elB.material = 'C';
      elB.dockedVesselId = beaker.id;
      elB.dockSide = 'right';
      const dc = sim.createApparatus('dc_power', 520, floorY - APPARATUS.dc_power.height / 2 + 2);
      dc.posElectrodeId = elA.id;
      dc.negElectrodeId = elB.id;
      sim.createApparatus('splint', 690, floorY - 12);
      sim.selectedId = dc.id;
    } else if (presetName === 'distillation') {
      const burner = sim.createApparatus('burner', 220, floorY - APPARATUS.burner.height / 2 + 2);
      const flask = sim.createApparatus('erlenmeyer_250', 220, burner.y - APPARATUS.burner.height / 2 + 10 - APPARATUS.erlenmeyer_250.height / 2);
      const stand = sim.createApparatus('retort_stand', 500, floorY - APPARATUS.retort_stand.height / 2 + 2);
      const cond = sim.createApparatus('liebig_condenser', 450, 250);
      sim.attachToStand(cond.id, stand.id);
      const recv = sim.createApparatus('beaker_250', 610, floorY - APPARATUS.beaker_250.height / 2 + 2);
      sim.connectTube(flask.id, cond.id);
      sim.connectCondenserOutlet(cond.id, recv.id);
      sim.selectedId = flask.id;
    } else if (presetName === 'ammonia_fountain') {
      const flask = sim.createApparatus('erlenmeyer_250', 220, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      const burner = sim.createApparatus('burner', 220, floorY - APPARATUS.burner.height / 2 + 2);
      flask.y = burner.y - APPARATUS.burner.height / 2 + 10 - APPARATUS.erlenmeyer_250.height / 2;
      const stand = sim.createApparatus('retort_stand', 520, floorY - APPARATUS.retort_stand.height / 2 + 2);
      const fountainFlask = sim.createApparatus('erlenmeyer_250', 460, 210);
      sim.toggleVesselInverted(fountainFlask.id);
      sim.attachToStand(fountainFlask.id, stand.id);
      const waterBeaker = sim.createApparatus('beaker_250', 460, floorY - APPARATUS.beaker_250.height / 2 + 2);
      sim.connectTube(flask.id, fountainFlask.id);
      sim.selectedId = waterBeaker.id;
    } else if (presetName === 'graham_diffusion') {
      const tube = sim.createApparatus('diffusion_tube', 430, floorY - APPARATUS.diffusion_tube.height / 2 + 2);
      sim.selectedId = tube.id;
    } else if (presetName === 'cuo_h2_reduction') {
      // Textbook CuO + H2 reduction: diluted ~5.5M HCl + mossy Zn granules (steady 25s H2 stream) -> rubber tube -> clamped test tube containing black CuO(s) over alcohol burner
      const flask = sim.createApparatus('erlenmeyer_250', 220, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      sim.addReagentToVessel(flask.id, 'h2o', 40, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(flask.id, 'hcl_37', 30, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(flask.id, 'zn', 12.0, { fine: false, silentAnim: true, silentEmit: true });
      flask.particleCounts.Zn_s = 2; // Large mossy Zinc chunks give sustained H2 stream over ~25s!
      flask.tempK = sim.environment.tempK;
      flask.isStoppered = true;

      const burner = sim.createApparatus('burner', 530, floorY - APPARATUS.burner.height / 2 + 2);
      sim.setBurnerFlame(burner.id, 0);
      const stand = sim.createApparatus('retort_stand', 585, floorY - APPARATUS.retort_stand.height / 2 + 2);
      const tube = sim.createApparatus('test_tube_50', 530, 326);
      tube.moles = { CuO_s: 0.04 };
      tube.particleCounts = { CuO_s: 260 };
      sim.attachToStand(tube.id, stand.id);
      sim.connectTube(flask.id, tube.id);
      sim.addLog({ type: 'info', key: 'guideCuoH2', vesselLabel: tube.label });
      sim.selectedId = burner.id;
    } else if (presetName === 'zn_burn_o2') {
      // Textbook O2 prep (H2O2 + CuO catalyst) -> O2 jar + Zn porcelain dish over burner
      const flaskA = sim.createApparatus('erlenmeyer_250', 200, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      flaskA.moles = { CuO_s: 0.02 };
      sim.addReagentToVessel(flaskA.id, 'h2o2_30', 35, { silentAnim: true, silentEmit: true });
      flaskA.isStoppered = true;
      const flaskO2 = sim.createApparatus('erlenmeyer_250', 430, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      flaskO2.headspaceGasMoles.O2_g = 0.008;
      flaskO2.moles = { Zn_s: 0.03 };
      flaskO2.particleCounts = { Zn_s: 12 };
      sim.connectTube(flaskA.id, flaskO2.id);
      const burner = sim.createApparatus('burner', 690, floorY - APPARATUS.burner.height / 2 + 2);
      sim.setBurnerFlame(burner.id, 3);
      const dish = sim.createApparatus('porcelain_dish', 690, burner.y - APPARATUS.burner.height / 2 + 10 - APPARATUS.porcelain_dish.height / 2);
      sim.addReagentToVessel(dish.id, 'zn', 2.0, { fine: true, silentAnim: true, silentEmit: true });
      sim.createApparatus('splint', 820, floorY - 12);
      sim.addLog({ type: 'info', key: 'guideZnBurnO2', vesselLabel: flaskO2.label });
      sim.selectedId = flaskO2.id;
    } else if (presetName === 'air_tarnish_deliquesce') {
      const dish = sim.createApparatus('porcelain_dish', 290, floorY - APPARATUS.porcelain_dish.height / 2 + 2);
      sim.addReagentToVessel(dish.id, 'na', 1.2, { silentAnim: true, silentEmit: true });
      const beaker = sim.createApparatus('beaker_250', 550, floorY - APPARATUS.beaker_250.height / 2 + 2);
      sim.addReagentToVessel(beaker.id, 'naoh', 4.5, { silentAnim: true, silentEmit: true });
      sim.addLog({ type: 'info', key: 'guideAirTarnish', vesselLabel: dish.label });
      sim.selectedId = dish.id;
    } else if (presetName === 'na_water_phen') {
      const beaker = sim.createApparatus('beaker_250', 360, floorY - APPARATUS.beaker_250.height / 2 + 2);
      sim.addReagentToVessel(beaker.id, 'h2o', 90, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(beaker.id, 'phen', 2, { silentAnim: true, silentEmit: true });
      const dish = sim.createApparatus('porcelain_dish', 580, floorY - APPARATUS.porcelain_dish.height / 2 + 2);
      sim.addReagentToVessel(dish.id, 'na', 0.45, { silentAnim: true, silentEmit: true });
      sim.selectedId = beaker.id;
    } else if (presetName === 'copper_hydroxide_series') {
      sim.createApparatus('scale', 210, floorY - APPARATUS.scale.height / 2 + 2);
      const beaker = sim.createApparatus('beaker_250', 210, floorY - APPARATUS.scale.height - APPARATUS.beaker_250.height / 2 + 2);
      sim.addReagentToVessel(beaker.id, 'h2o', 60, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(beaker.id, 'cuso4_5h2o', 6.0, { silentAnim: true, silentEmit: true });
      sim.createApparatus('burner', 530, floorY - APPARATUS.burner.height / 2 + 2);
      sim.createApparatus('erlenmeyer_250', 720, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      sim.selectedId = beaker.id;
    } else if (presetName === 'amphoteric_zn_cu') {
      const bZn = sim.createApparatus('beaker_250', 270, floorY - APPARATUS.beaker_250.height / 2 + 2);
      bZn.moles = { H2O_l: 3.5, ZnOH2_s: 0.03 };
      const bCu = sim.createApparatus('beaker_250', 510, floorY - APPARATUS.beaker_250.height / 2 + 2);
      bCu.moles = { H2O_l: 3.5, CuOH2_s: 0.03 };
      sim.createApparatus('burner', 740, floorY - APPARATUS.burner.height / 2 + 2);
      sim.selectedId = bZn.id;
    } else if (presetName === 'cu_ammine_complex') {
      const bCu = sim.createApparatus('beaker_250', 340, floorY - APPARATUS.beaker_250.height / 2 + 2);
      sim.addReagentToVessel(bCu.id, 'h2o', 45, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bCu.id, 'cuso4_5h2o', 2.5, { silentAnim: true, silentEmit: true });
      bCu.moles.CuOH2_s = 0.008;
      delete bCu.moles.Cu2_aq;
      const beakerNh3 = sim.createApparatus('beaker_250', 580, floorY - APPARATUS.beaker_250.height / 2 + 2);
      sim.addReagentToVessel(beakerNh3.id, 'nh3_25', 25, { silentAnim: true, silentEmit: true });
      sim.addLog({ type: 'info', key: 'guideCuAmmine', vesselLabel: bCu.label });
      sim.selectedId = bCu.id;
    } else if (presetName === 'compare_rate_factors') {
      const bCoarse = sim.createApparatus('erlenmeyer_250', 200, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      bCoarse.label = '#A (Đá vôi cục)';
      sim.addReagentToVessel(bCoarse.id, 'h2o', 45, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bCoarse.id, 'hcl_37', 12, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bCoarse.id, 'caco3', 5.0, { fine: false, silentAnim: true, silentEmit: true });
      bCoarse.particleCounts.CaCO3_s = 3;

      const bFine = sim.createApparatus('erlenmeyer_250', 440, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      bFine.label = '#B (Bột mịn CaCO₃)';
      sim.addReagentToVessel(bFine.id, 'h2o', 45, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bFine.id, 'hcl_37', 12, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bFine.id, 'caco3', 5.0, { fine: true, silentAnim: true, silentEmit: true });
      bFine.particleCounts.CaCO3_s = 800;
      bFine.groundPowderMap.CaCO3_s = true;

      const bHot = sim.createApparatus('erlenmeyer_250', 680, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      bHot.label = '#C (Đặc + Nóng 55°C)';
      sim.addReagentToVessel(bHot.id, 'h2o', 25, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bHot.id, 'hcl_37', 30, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bHot.id, 'caco3', 5.0, { fine: false, silentAnim: true, silentEmit: true });
      bHot.particleCounts.CaCO3_s = 3;
      bHot.tempK = 328.15;

      sim.compareVesselIds = [bCoarse.id, bFine.id, bHot.id];
      sim.selectedId = bFine.id;
    } else if (presetName === 'compare_corrosion') {
      const bChem = sim.createApparatus('beaker_250', 185, floorY - APPARATUS.beaker_250.height / 2 + 2);
      bChem.label = '#A (Ăn mòn hóa học Zn+HCl)';
      sim.addReagentToVessel(bChem.id, 'h2o', 55, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bChem.id, 'hcl_37', 18, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bChem.id, 'zn', 2.5, { fine: false, silentAnim: true, silentEmit: true });

      const bElec = sim.createApparatus('beaker_250', 415, floorY - APPARATUS.beaker_250.height / 2 + 2);
      bElec.label = '#B (Pin điện hóa Zn–Cu)';
      sim.addReagentToVessel(bElec.id, 'h2o', 55, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bElec.id, 'hcl_37', 18, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bElec.id, 'zn', 2.5, { fine: false, silentAnim: true, silentEmit: true });
      bElec.moles.Cu_s = 0.008;

      const elZn = sim.createApparatus('electrode_rod', 395, 390);
      elZn.material = 'Zn';
      elZn.dockedVesselId = bElec.id;
      elZn.dockSide = 'left';
      const elCu = sim.createApparatus('electrode_rod', 435, 390);
      elCu.material = 'Cu';
      elCu.dockedVesselId = bElec.id;
      elCu.dockSide = 'right';
      const vm = sim.createApparatus('volt_ammeter', 585, floorY - APPARATUS.volt_ammeter.height / 2 + 2);
      vm.mode = 'ammeter';
      vm.posElectrodeId = elCu.id;
      vm.negElectrodeId = elZn.id;
      syncDockedToolPositions(sim);

      const bPass = sim.createApparatus('beaker_250', 790, floorY - APPARATUS.beaker_250.height / 2 + 2);
      bPass.label = '#C (Cu nguyên chất trong HCl)';
      sim.addReagentToVessel(bPass.id, 'h2o', 55, { silentAnim: true, silentEmit: true });
      sim.addReagentToVessel(bPass.id, 'hcl_37', 18, { silentAnim: true, silentEmit: true });
      bPass.moles.Cu_s = 0.03;

      sim.compareVesselIds = [bChem.id, bElec.id, bPass.id];
      sim.selectedId = bElec.id;
    } else if (presetName === 'caco3_calcination_limewater') {
      const bnCruc = sim.createApparatus('bunsen_burner', 200, floorY - APPARATUS.bunsen_burner.height / 2 + 2);
      bnCruc.airHoleOpen = true;
      sim.setBurnerFlame(bnCruc.id, 3);
      const cruc = sim.createApparatus(
        'crucible_porcelain',
        200,
        bnCruc.y - APPARATUS.bunsen_burner.height / 2 + 10 - APPARATUS.crucible_porcelain.height / 2 + 12
      );
      sim.addReagentToVessel(cruc.id, 'caco3', 3.0, { fine: true, silentAnim: true, silentEmit: true });
      cruc.particleCounts.CaCO3_s = 800;
      cruc.groundPowderMap.CaCO3_s = true;
      cruc.lidState = 'ajar';

      const bnQuartz = sim.createApparatus('bunsen_burner', 530, floorY - APPARATUS.bunsen_burner.height / 2 + 2);
      bnQuartz.airHoleOpen = true;
      sim.setBurnerFlame(bnQuartz.id, 3);
      const stand = sim.createApparatus('retort_stand', 595, floorY - APPARATUS.retort_stand.height / 2 + 2);
      const qTube = sim.createApparatus('quartz_tube', 530, 386);
      sim.addReagentToVessel(qTube.id, 'caco3', 3.0, { fine: true, silentAnim: true, silentEmit: true });
      qTube.particleCounts.CaCO3_s = 800;
      qTube.groundPowderMap.CaCO3_s = true;
      sim.attachToStand(qTube.id, stand.id);
      qTube.y = 386;

      const limeBeaker = sim.createApparatus('beaker_250', 775, floorY - APPARATUS.beaker_250.height / 2 + 2);
      limeBeaker.label = '#Nước vôi trong';
      sim.addReagentToVessel(limeBeaker.id, 'h2o', 70, { silentAnim: true, silentEmit: true });
      limeBeaker.moles.Ca2_aq = 0.0016;
      limeBeaker.moles.OH_aq = 0.0032;
      sim.connectTube(qTube.id, limeBeaker.id);
      sim.addLog({ type: 'info', key: 'guideCaco3Calcination', vesselLabel: cruc.label });
      sim.selectedId = cruc.id;
    } else if (presetName === 'ester_distill') {
      const burner = sim.createApparatus('burner', 220, floorY - APPARATUS.burner.height / 2 + 2);
      sim.setBurnerFlame(burner.id, 2);
      const flask = sim.createApparatus('round_flask_250', 220, burner.y - APPARATUS.burner.height / 2 + 10 - APPARATUS.round_flask_250.height / 2);
      flask.moles = { CH3COOH_l: 0.25, C2H5OH_l: 0.25, H2O_l: 0.15, H_aq: 0.04, SO4_2_aq: 0.02 };
      const stand = sim.createApparatus('retort_stand', 500, floorY - APPARATUS.retort_stand.height / 2 + 2);
      const cond = sim.createApparatus('liebig_condenser', 450, 245);
      sim.attachToStand(cond.id, stand.id);
      const recv = sim.createApparatus('beaker_250', 610, floorY - APPARATUS.beaker_250.height / 2 + 2);
      sim.connectTube(flask.id, cond.id);
      sim.connectCondenserOutlet(cond.id, recv.id);
      sim.selectedId = flask.id;
    } else if (presetName === 'titration_probe') {
      const stand = sim.createApparatus('retort_stand', 360, floorY - APPARATUS.retort_stand.height / 2 + 2);
      const burette = sim.createApparatus('burette_50', 300, 225);
      sim.attachToStand(burette.id, stand.id);
      burette.moles = { H2O_l: 2.0, OH_aq: 0.05, Na_aq: 0.05 };
      const beaker = sim.createApparatus('beaker_250', 300, floorY - APPARATUS.beaker_250.height / 2 + 2);
      beaker.moles = { H2O_l: 2.5, H_aq: 0.025, Cl_aq: 0.025, Phenolphthalein_aq: 1e-4 };
      const stirBar = sim.createApparatus('stir_bar', 490, floorY - 8);
      sim.insertStirBarIntoVessel(stirBar.id, beaker.id, 600);
      sim.createApparatus('ph_conductometer', 300, beaker.y - 42);
      sim.selectedId = burette.id;
    } else if (presetName === 'starch_colorimetry') {
      const burner = sim.createApparatus('burner', 340, floorY - APPARATUS.burner.height / 2 + 2);
      sim.setBurnerFlame(burner.id, 1);
      const beaker = sim.createApparatus('beaker_250', 340, burner.y - APPARATUS.burner.height / 2 + 10 - APPARATUS.beaker_250.height / 2);
      beaker.moles = { H2O_l: 2.5, Starch_aq: 0.02, I2_aq: 0.008 };
      const col = sim.createApparatus('colorimeter', 340, beaker.y - 40);
      col.wavelengthNm = 590;
      sim.selectedId = col.id;
    } else {
      // 'starter' default bench: Scale + Beaker 250 mL + Burner + Erlenmeyer 250 mL
      sim.createApparatus('scale', 220, floorY - APPARATUS.scale.height / 2 + 2);
      const beaker = sim.createApparatus('beaker_250', 220, floorY - APPARATUS.scale.height - APPARATUS.beaker_250.height / 2 + 2);
      sim.createApparatus('burner', 560, floorY - APPARATUS.burner.height / 2 + 2);
      sim.createApparatus('erlenmeyer_250', 760, floorY - APPARATUS.erlenmeyer_250.height / 2 + 2);
      sim.selectedId = beaker.id;
    }
  sim.updateSupportAttachments();
  sim.emitChange();
}
