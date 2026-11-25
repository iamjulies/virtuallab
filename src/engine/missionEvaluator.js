/**
 * Practical Lab Telemetry Tracker & 4-Layer Rubric Evaluator (Prompt 83).
 * Evaluates Process, Quantitative Accuracy, Identification/Conclusion & Lab Safety.
 */
import { computeCaOOptimizationScore } from './chemistry.js';
import { computeLiquidVolumeL, computePH } from './equilibrium.js';
import { computeSyringeGasVolumeMl, buildCombinedSyringeTotalMoles } from './gasNetwork.js';
import { MISSION_REGISTRY } from '../data/missions.js';
import { CONSTANTS } from '../data/constants.js';

const STORAGE_MISSION_PROGRESS_KEY = 'virlab_missions_progress_v1';
const TOXIC_GASES = ['Cl2_g', 'H2S_g', 'Br2_g', 'NO2_g', 'SO2_g', 'HCl_g', 'NH3_g', 'CO_g'];

export function createEmptyMissionTelemetry() {
  return {
    sampledBlindLabels: [],
    usedPipetteTransfer: false,
    usedBuretteDrops: 0,
    usedLitmusOrPh: false,
    usedIndicator: false,
    bunsenBlueUsed: false,
    mortarGroundCaCO3: false,
    gasDriedViaH2SO4: false,
    gasConnectedToSyringe: false,
    esterFormed: false,
    sepFunnelTaps: 0,
    contaminatedBlindIds: [],
    shatteredCount: 0,
    explosionCount: 0,
    toxicLeakCount: 0,
    overflowCount: 0,
    directCheatFlags: 0,
    _seenShatteredIds: {},
    _seenOverflowIds: {},
    _toxicLeakMaxMol: 0,
  };
}

export function ensureMissionTelemetry(sim) {
  if (!sim) return createEmptyMissionTelemetry();
  if (!sim.missionTelemetry) sim.missionTelemetry = createEmptyMissionTelemetry();
  return sim.missionTelemetry;
}

export function updateMissionTelemetryOnStep(sim) {
  if (!sim || !sim.missionState?.active) return;
  const tel = ensureMissionTelemetry(sim);
  const items = sim.items || [];

  for (const it of items) {
    if (it.kind === 'vessel') {
      if (it.isShattered && !tel._seenShatteredIds[it.id]) {
        tel._seenShatteredIds[it.id] = true;
        tel.shatteredCount += 1;
      }
      if ((it.overflowRateMlS || 0) > 0.25 && !tel._seenOverflowIds[it.id]) {
        tel._seenOverflowIds[it.id] = true;
        tel.overflowCount += 1;
      }
      if ((it.moles?.CaCO3_s || 0) > 1e-6 && (it.groundPowderMap?.CaCO3_s || (it.particleCounts?.CaCO3_s || 0) >= 60)) {
        tel.mortarGroundCaCO3 = true;
      }
      if ((it.calcinationStats?.roaringBlueZone)) {
        tel.bunsenBlueUsed = true;
      }
      if ((it.moles?.CH3COOC2H5_l || 0) > 0.002) {
        tel.esterFormed = true;
      }
      // Track toxic gas escaping freely from open vessels
      if (!it.isStoppered && !it.connectedTargetId && !it.connectedSyringeId) {
        let vesselToxicEsc = 0;
        for (const g of TOXIC_GASES) {
          vesselToxicEsc += it.escapedGasMoles?.[g] || 0;
        }
        if (vesselToxicEsc > 0.0025 && vesselToxicEsc > tel._toxicLeakMaxMol + 0.002) {
          tel._toxicLeakMaxMol = vesselToxicEsc;
          tel.toxicLeakCount += 1;
        }
      }
      // Check H2SO4 drying flask in gas network
      if (it.connectedTargetId) {
        const tgt = sim.getItem(it.connectedTargetId);
        if (tgt && tgt.kind === 'vessel') {
          const isDryFlask = (tgt.moles?.H2SO4_l || 0) > 0.02 || ((tgt.moles?.H_aq || 0) > 0.02 && (tgt.moles?.HSO4_aq || 0) > 0.01);
          if (isDryFlask && (tgt.connectedTargetId || tgt.connectedSyringeId)) {
            tel.gasDriedViaH2SO4 = true;
          }
        }
        if (tgt && tgt.kind === 'gas_syringe') {
          tel.gasConnectedToSyringe = true;
        }
      }
      if (it.connectedSyringeId) {
        tel.gasConnectedToSyringe = true;
      }
    } else if (it.kind === 'burner' && it.typeId === 'bunsen_burner' && it.isLit && it.airHoleOpen !== false) {
      tel.bunsenBlueUsed = true;
    } else if (it.kind === 'litmus_paper' || it.kind === 'indicator_strip' || it.kind === 'ph_conductometer') {
      if (it.dockedVesselId || it.lastTestedVesselId || it.probeResult || it.testHistory?.length) {
        tel.usedLitmusOrPh = true;
      }
    } else if (it.kind === 'gas_syringe') {
      if (it.isBroken && !tel._seenShatteredIds[it.id]) {
        tel._seenShatteredIds[it.id] = true;
        tel.shatteredCount += 1;
      }
      if (it.connectedFromId) {
        tel.gasConnectedToSyringe = true;
      }
    } else if (it.kind === 'separatory_funnel' && it.valveOpen && (it.flowRateMlS || 0) > 0.05) {
      tel.sepFunnelTaps = Math.max(1, tel.sepFunnelTaps);
    }
  }

  // Check logs for explosions / gas testing / burette / indicator
  for (let i = 0; i < Math.min(8, (sim.logs || []).length); i++) {
    const k = sim.logs[i]?.key || '';
    if (k.includes('Explod') || k.includes('H2O2Explod') || k.includes('shatter') || k.includes('PressureBurst')) {
      tel.explosionCount = Math.max(tel.explosionCount, 1);
    }
  }
}

function makeCriterionResult(crit, earnedRaw, detail) {
  const maxPoints = Number(crit.maxPoints) || 0;
  const earned = Math.max(0, Math.min(maxPoints, +Number(earnedRaw).toFixed(2)));
  const ratio = maxPoints > 0 ? earned / maxPoints : 0;
  const status = ratio >= 0.9 ? 'pass' : ratio >= 0.35 ? 'partial' : 'fail';
  return {
    id: crit.id,
    category: crit.category,
    labelKey: crit.labelKey,
    earned,
    maxPoints,
    status,
    detail: detail || '',
  };
}

function computeCommonSafetyPoints(maxPts, sim, tel, extraPenalty = 0) {
  const shattered = tel.shatteredCount + (sim.items || []).filter((i) => i.isShattered && !tel._seenShatteredIds?.[i.id]).length;
  const incidents = shattered + tel.explosionCount + tel.toxicLeakCount + tel.overflowCount;
  const deduct = Math.min(maxPts, incidents * 0.5 + extraPenalty);
  return {
    pts: Math.max(0, maxPts - deduct),
    incidents,
  };
}

function gradeFromScore(score) {
  if (score >= 9.2) return { grade: 'S', stars: 3, medal: '🥇' };
  if (score >= 8.0) return { grade: 'A', stars: 3, medal: '🥇' };
  if (score >= 6.5) return { grade: 'B', stars: 2, medal: '🥈' };
  if (score >= 5.0) return { grade: 'C', stars: 1, medal: '🥉' };
  return { grade: 'D', stars: 0, medal: '📘' };
}

export function evaluateMission(sim, missionState, userAnswers = {}, options = {}) {
  const mission = MISSION_REGISTRY[missionState?.missionId];
  if (!mission || !sim) return null;

  const tel = ensureMissionTelemetry(sim);
  const setupData = missionState.setupData || {};
  const ak = setupData.answerKey || {};
  const t = options.t || ((k) => k);
  const results = [];

  if (mission.id === 'mission_qualitative_4') {
    const blindIds = setupData.blindVesselIds || [];
    const subVessels = (sim.items || []).filter((i) => i.kind === 'vessel' && !blindIds.includes(i.id) && !i.isShattered);
    const usedSubTest = subVessels.some((v) => Object.values(v.moles || {}).some((n) => n > 1e-6)) || tel.usedPipetteTransfer;
    const procScore = (tel.usedLitmusOrPh ? 1.25 : 0) + (usedSubTest ? 1.25 : 0);
    results.push(makeCriterionResult(mission.rubric[0], procScore, `Pipette/Sub-tubes=${usedSubTest ? 'OK' : 'No'}, Litmus/pH=${tel.usedLitmusOrPh ? 'OK' : 'No'}`));

    // Sample preservation: none contaminated, remaining volume >= 55% of 80 mL = 44 mL
    let preservedCount = 0;
    for (const vid of blindIds) {
      const bv = sim.getItem(vid);
      if (!bv || bv.isShattered) continue;
      const ml = computeLiquidVolumeL(bv.moles, bv.tempK) * 1000;
      const contaminated = (tel.contaminatedBlindIds || []).includes(vid);
      if (!contaminated && ml >= 44) preservedCount += 1;
    }
    const quantScore = blindIds.length > 0 ? (preservedCount / blindIds.length) * mission.rubric[1].maxPoints : 0;
    results.push(makeCriterionResult(mission.rubric[1], quantScore, `${preservedCount}/${blindIds.length} clean samples kept`));

    let correctLbl = 0;
    for (const lbl of ['?A', '?B', '?C', '?D']) {
      if (userAnswers[`ans_${lbl}`] && userAnswers[`ans_${lbl}`] === ak[lbl]) correctLbl += 1;
    }
    const identScore = (correctLbl / 4) * mission.rubric[2].maxPoints;
    results.push(makeCriterionResult(mission.rubric[2], identScore, `${correctLbl}/4 matched`));

    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, `${safe.incidents} incident(s)`));
  } else if (mission.id === 'mission_titration_hcl') {
    const flask = sim.getItem(setupData.targetVesselId);
    const hasPhen = Boolean(flask && (flask.moles?.Phenolphthalein_aq || 0) > 1e-9);
    const procPts = (tel.usedBuretteDrops > 0 ? 1.5 : 0) + ((hasPhen || tel.usedLitmusOrPh) ? 1.0 : 0);
    results.push(makeCriterionResult(mission.rubric[0], procPts, `Burette drops=${tel.usedBuretteDrops}, Indicator/pH=${hasPhen || tel.usedLitmusOrPh ? 'OK' : 'No'}`));

    const liqL = flask ? computeLiquidVolumeL(flask.moles, flask.tempK) : 0;
    const ph = flask && liqL > 1e-6 ? computePH(flask.moles, liqL, flask.tempK) : null;
    let quantPts = 0;
    if (ph !== null && tel.usedBuretteDrops > 0) {
      if (ph >= 6.8 && ph <= 10.3) quantPts = mission.rubric[1].maxPoints;
      else if (ph > 10.3 && ph <= 11.4) quantPts = mission.rubric[1].maxPoints * 0.6;
      else if (ph > 5.0 && ph < 6.8) quantPts = mission.rubric[1].maxPoints * 0.5;
      else quantPts = 0.4;
    }
    results.push(makeCriterionResult(mission.rubric[1], quantPts, ph !== null ? `Endpoint pH = ${ph.toFixed(2)}` : 'No endpoint reached'));

    const userVal = Number(userAnswers.ans_molarity);
    const trueVal = Number(ak.targetMolarityM) || 0.1;
    let identPts = 0;
    let errPctStr = '—';
    if (Number.isFinite(userVal) && userVal > 0) {
      const errPct = Math.abs(userVal - trueVal) / trueVal * 100;
      errPctStr = `±${errPct.toFixed(1)}% (true ${trueVal.toFixed(3)} M)`;
      if (errPct <= 2.0) identPts = mission.rubric[2].maxPoints;
      else if (errPct <= 5.0) identPts = mission.rubric[2].maxPoints * 0.7;
      else if (errPct <= 10.0) identPts = mission.rubric[2].maxPoints * 0.4;
    }
    results.push(makeCriterionResult(mission.rubric[2], identPts, errPctStr));

    const overTitratedPen = ph !== null && ph > 12.2 ? 0.5 : 0;
    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel, overTitratedPen);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, `${safe.incidents} incident(s)`));
  } else if (mission.id === 'mission_calcination_cao') {
    const cruc = sim.getItem(setupData.crucibleId) || (sim.items || []).find((i) => i.kind === 'vessel' && ((i.moles?.CaO_s || 0) > 1e-4 || (i.moles?.CaCO3_s || 0) > 1e-4));
    const caoScore = cruc ? computeCaOOptimizationScore(cruc) : null;
    const procPts = caoScore ? caoScore.points : 0;
    results.push(makeCriterionResult(mission.rubric[0], procPts, caoScore ? `${caoScore.points}/4 criteria` : '0/4'));

    const yieldPct = caoScore ? caoScore.yieldPct : 0;
    let quantPts = 0;
    if (yieldPct >= 90) quantPts = mission.rubric[1].maxPoints;
    else quantPts = (yieldPct / 90) * mission.rubric[1].maxPoints * 0.85;
    results.push(makeCriterionResult(mission.rubric[1], quantPts, `CaO yield = ${yieldPct.toFixed(1)}%`));

    let identPts = 0;
    if (userAnswers.ans_gas === ak.gas) identPts += 0.5;
    if (userAnswers.ans_product === ak.product) identPts += 0.5;
    results.push(makeCriterionResult(mission.rubric[2], identPts, `${userAnswers.ans_gas || '—'} / ${userAnswers.ans_product || '—'}`));

    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, `${safe.incidents} incident(s)`));
  } else if (mission.id === 'mission_gas_prep') {
    const syr = sim.getItem(setupData.targetSyringeId) || (sim.items || []).find((i) => i.kind === 'gas_syringe' && !i.isBroken);
    const hasDryAgent = (sim.items || []).some((v) => v.kind === 'vessel' && ((v.moles?.H2SO4_l || 0) > 0.015 || ((v.moles?.H_aq || 0) > 0.02 && (v.moles?.HSO4_aq || 0) > 0.01)));
    const procPts = (tel.gasConnectedToSyringe ? 1.5 : 0) + ((tel.gasDriedViaH2SO4 || hasDryAgent) ? 1.5 : 0);
    results.push(makeCriterionResult(mission.rubric[0], procPts, `Drying=${tel.gasDriedViaH2SO4 || hasDryAgent ? 'H₂SO₄' : 'No'}, SyringeLink=${tel.gasConnectedToSyringe ? 'OK' : 'No'}`));

    const targetGasId = ak.targetGasId || 'H2_g';
    const allMoles = syr ? buildCombinedSyringeTotalMoles(syr) : {};
    let totalMol = 0;
    for (const n of Object.values(allMoles)) totalMol += n || 0;
    const targetMol = allMoles[targetGasId] || 0;
    const purityPct = totalMol > 1e-7 ? (targetMol / totalMol) * 100 : 0;
    const gasMl = syr ? computeSyringeGasVolumeMl(syr, sim.environment) : 0;
    let quantPts = 0;
    if (targetMol >= 0.0005 && gasMl >= 12) {
      const volFactor = Math.min(1, targetMol / 0.004);
      const purFactor = purityPct >= 95 ? 1.0 : purityPct >= 80 ? 0.65 : 0.3;
      quantPts = mission.rubric[1].maxPoints * (0.5 * volFactor + 0.5 * purFactor);
    }
    results.push(makeCriterionResult(mission.rubric[1], quantPts, `${gasMl.toFixed(1)} mL, ${purityPct.toFixed(1)}% ${ak.gas}`));

    let identPts = 0;
    if (userAnswers.ans_gas === ak.gas) identPts += 0.5;
    if (userAnswers.ans_drying === ak.dryingAgent) identPts += 0.5;
    results.push(makeCriterionResult(mission.rubric[2], identPts, `${userAnswers.ans_gas || '—'} · ${userAnswers.ans_drying || '—'}`));

    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, `${safe.incidents} incident(s)`));
  } else if (mission.id === 'mission_electrochem_cell') {
    const dmm = sim.getItem(setupData.dmmId) || (sim.items || []).find((i) => i.kind === 'volt_ammeter');
    const sb = setupData.saltBridgeId ? sim.getItem(setupData.saltBridgeId) : (sim.items || []).find((i) => i.kind === 'salt_bridge');
    const isSacrificial = ak.mode === 'sacrificial';
    const sbClean = isSacrificial ? true : Boolean(sb && !sb.isBroken && !sb.fouledByAgCl && !sb.fouledBySulfate && sb.vesselAId && sb.vesselBId);
    const hasClosedMeter = Boolean(dmm && dmm.posElectrodeId && dmm.negElectrodeId);
    const procPts = (hasClosedMeter ? 1.5 : 0) + (sbClean ? 1.5 : 0);
    results.push(makeCriterionResult(mission.rubric[0], procPts, `Meter=${hasClosedMeter ? 'OK' : 'No'}, SaltBridge=${sbClean ? 'Clean' : 'Fouled/Open'}`));

    let quantPts = 0;
    let quantDetail = '';
    if (isSacrificial) {
      const feEl = sim.getItem(ak.feElectrodeId);
      const protectedOk = Boolean(feEl?.cathodicProtectedActive);
      const feRatio = feEl && ak.feInitialMol > 0 ? (feEl.rodMetalMol || 0) / ak.feInitialMol : 0;
      if (protectedOk && feRatio >= 0.96) quantPts = mission.rubric[1].maxPoints;
      else if (protectedOk) quantPts = mission.rubric[1].maxPoints * 0.7;
      quantDetail = `Protected=${protectedOk}, Fe kept ${(feRatio * 100).toFixed(1)}%`;
    } else {
      const measuredV = Math.abs(dmm?.measuredV || 0);
      const trueEmf = ak.targetEmfV || 0.762;
      const errPct = (Math.abs(measuredV - trueEmf) / trueEmf) * 100;
      if (errPct <= 4) quantPts = mission.rubric[1].maxPoints;
      else if (errPct <= 10) quantPts = mission.rubric[1].maxPoints * 0.65;
      else if (measuredV > 0.2) quantPts = mission.rubric[1].maxPoints * 0.35;
      quantDetail = `EMF=${measuredV.toFixed(2)}V (target ${trueEmf.toFixed(2)}V)`;
    }
    results.push(makeCriterionResult(mission.rubric[1], quantPts, quantDetail));

    let identPts = 0;
    if ((ak.validAnodes || []).includes(userAnswers.ans_anode)) identPts += 1.0;
    const ansEmf = Number(userAnswers.ans_emf);
    const refEmf = ak.mode === 'sacrificial' ? Math.abs(dmm?.measuredV || ak.targetEmfV) : ak.targetEmfV;
    if (Number.isFinite(ansEmf) && refEmf > 0 && Math.abs(ansEmf - refEmf) <= Math.max(0.08, refEmf * 0.1)) {
      identPts += 1.0;
    }
    results.push(makeCriterionResult(mission.rubric[2], identPts, `Anode=${userAnswers.ans_anode || '—'}, E=${userAnswers.ans_emf || '—'}V`));

    const foulPen = sb && (sb.fouledByAgCl || sb.fouledBySulfate) ? 0.5 : 0;
    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel, foulPen);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, `${safe.incidents} incident(s)`));
  } else if (mission.id === 'mission_ester_synth') {
    const sep = sim.getItem(setupData.sepFunnelId) || (sim.items || []).find((i) => i.kind === 'separatory_funnel');
    const anyEsterMade = tel.esterFormed || (sim.items || []).some((i) => (i.moles?.CH3COOC2H5_l || 0) > 0.002);
    const sepActive = tel.sepFunnelTaps > 0 || (sep && (sep.moles?.CH3COOC2H5_l || 0) > 0.002);
    const procPts = (anyEsterMade ? 2.0 : 0) + (sepActive ? 1.5 : 0);
    results.push(makeCriterionResult(mission.rubric[0], procPts, `EsterSynth=${anyEsterMade ? 'OK' : 'No'}, SepFunnel=${sepActive ? 'OK' : 'No'}`));

    // Look for purified ester inside receiver vessel or separatory funnel (after draining aqueous bottom)
    let bestEsterMol = 0;
    let bestPurity = 0;
    for (const it of sim.items || []) {
      if ((it.kind !== 'vessel' && it.kind !== 'separatory_funnel') || it.id === setupData.reactFlaskId || it.isShattered) continue;
      const eMol = it.moles?.CH3COOC2H5_l || 0;
      if (eMol <= 1e-5) continue;
      const nonWaterTot = eMol + (it.moles?.CH3COOH_l || 0) + (it.moles?.C2H5OH_l || 0) + (it.moles?.H2O_l || 0) * 0.25;
      const pur = nonWaterTot > 0 ? eMol / nonWaterTot : 0;
      if (eMol * (0.4 + pur) > bestEsterMol * (0.4 + bestPurity)) {
        bestEsterMol = eMol;
        bestPurity = pur;
      }
    }
    let quantPts = 0;
    if (bestEsterMol >= 0.004) {
      const yieldFactor = Math.min(1, bestEsterMol / (ak.expectedMinMol || 0.015));
      const purFactor = bestPurity >= 0.7 ? 1.0 : bestPurity >= 0.45 ? 0.65 : 0.35;
      quantPts = mission.rubric[1].maxPoints * (0.5 * yieldFactor + 0.5 * purFactor);
    }
    results.push(makeCriterionResult(mission.rubric[1], quantPts, `${(bestEsterMol * 1000).toFixed(1)} mmol (${(bestPurity * 100).toFixed(0)}% org)`));

    let identPts = 0;
    if (userAnswers.ans_layer === ak.layer) identPts += 1.0;
    if (userAnswers.ans_ester === ak.esterName) identPts += 1.0;
    results.push(makeCriterionResult(mission.rubric[2], identPts, `${userAnswers.ans_layer || '—'} · ${userAnswers.ans_ester || '—'}`));

    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, `${safe.incidents} incident(s)`));
  }

  const rawScore = results.reduce((sum, r) => sum + r.earned, 0);
  const hintsUsed = missionState?.hintsUsed || 0;
  const hintPenalty = missionState?.mode === 'exam' ? Math.min(2.0, hintsUsed * 0.5) : 0;
  const totalScore = Math.max(0, Math.min(10.0, +(rawScore - hintPenalty).toFixed(1)));
  const rank = gradeFromScore(totalScore);

  return {
    missionId: mission.id,
    titleKey: mission.titleKey,
    mode: missionState?.mode || 'practice',
    seed: missionState?.seed || 1,
    elapsedSec: Math.max(0, Math.round((Date.now() - (missionState?.startedAtMs || Date.now())) / 1000)),
    rawScore: +rawScore.toFixed(1),
    hintPenalty: +hintPenalty.toFixed(1),
    hintsUsed,
    totalScore,
    maxScore: 10,
    passed: totalScore >= 5.0,
    ...rank,
    criteriaResults: results,
    equationText: mission.equationText,
    answerKey: ak,
    t,
  };
}

export function loadMissionProgress() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_MISSION_PROGRESS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveMissionAttempt(evalResult) {
  if (!evalResult?.missionId || typeof localStorage === 'undefined') return loadMissionProgress();
  const map = loadMissionProgress();
  const prev = map[evalResult.missionId] || { bestScore: 0, bestStars: 0, attempts: 0, history: [] };
  const next = {
    bestScore: Math.max(prev.bestScore || 0, evalResult.totalScore),
    bestStars: Math.max(prev.bestStars || 0, evalResult.stars || 0),
    attempts: (prev.attempts || 0) + 1,
    lastMode: evalResult.mode,
    lastScore: evalResult.totalScore,
    lastAt: new Date().toISOString(),
    history: [
      { score: evalResult.totalScore, grade: evalResult.grade, mode: evalResult.mode, at: new Date().toISOString() },
      ...(prev.history || []).slice(0, 9),
    ],
  };
  map[evalResult.missionId] = next;
  try {
    localStorage.setItem(STORAGE_MISSION_PROGRESS_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors
  }
  return map;
}
