/**
 * Practical Lab Telemetry Tracker & 4-Layer Rubric Evaluator (Prompt 83).
 * Evaluates Process, Quantitative Accuracy, Identification/Conclusion & Lab Safety.
 */
import { computeCaOOptimizationScore } from './chemistry.js';
import { computeLiquidVolumeL, computePH } from './equilibrium.js';
import { SPECIES } from '../data/species.js';
import { computeSyringeGasVolumeMl, buildCombinedSyringeTotalMoles } from './gasNetwork.js';
import { MISSION_REGISTRY } from '../data/missions.js';
import { CONSTANTS } from '../data/constants.js';
import { verifyHashedAnswer } from './examProctor.js';

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
    usedFilterFunnel: false,
    usedMeasuringTools: false,
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
      if (
        it.dockedVesselId ||
        it.lastTestedVesselId ||
        it.probeResult ||
        it.testHistory?.length ||
        it.sampledPH != null ||
        Boolean(it.sampledFrom) ||
        Boolean(it.contactVesselId) ||
        it.measuredPH != null ||
        (it.history?.length || 0) > 0
      ) {
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
    } else if (it.kind === 'filter_funnel' && (it.filteredLiquidMl > 0 || it.solidMassG > 0 || it.receivingVesselId || Object.keys(it.moles || {}).length > 0)) {
      tel.usedFilterFunnel = true;
    } else if (it.kind === 'scale' || it.typeId === 'cylinder_100' || it.kind === 'wash_bottle') {
      if ((it.measuredG > 0.01 || Object.keys(it.moles || {}).length > 0 || (it.squirtCount || 0) > 0)) {
        tel.usedMeasuringTools = true;
      }
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
  const isCustom = Boolean(missionState?.customAssignment);
  const mission = isCustom ? missionState : MISSION_REGISTRY[missionState?.missionId];
  if (!mission || !sim) return null;

  const tel = ensureMissionTelemetry(sim);
  const setupData = missionState.setupData || {};
  const ak = setupData.answerKey || {};
  const t = options.t || ((k) => k);
  const isEn = options.langCode ? options.langCode === 'en' : String(t('missionSubmitBtn') || '').toLowerCase().includes('submit');
  const results = [];

  if (isCustom) {
    const rubric = Array.isArray(mission.rubric) && mission.rubric.length > 0
      ? mission.rubric
      : [
          { id: 'c_proc', category: 'process', maxPoints: 3.0, labelKey: 'teacherRubProc' },
          { id: 'c_quant', category: 'quantitative', maxPoints: 2.0, labelKey: 'teacherRubQuant' },
          { id: 'c_ident', category: 'identification', maxPoints: 4.0, labelKey: 'teacherRubIdent' },
          { id: 'c_safe', category: 'safety', maxPoints: 1.0, labelKey: 'teacherRubSafe' },
        ];
    const hasEvidence =
      tel.usedPipetteTransfer ||
      tel.usedLitmusOrPh ||
      tel.usedBuretteDrops > 0 ||
      tel.bunsenBlueUsed ||
      tel.gasConnectedToSyringe ||
      tel.esterFormed ||
      tel.sepFunnelTaps > 0 ||
      tel.usedFilterFunnel ||
      tel.usedMeasuringTools ||
      (sim.logs?.length || 0) > 0;

    const procCrit = rubric.find((r) => r.category === 'process') || rubric[0];
    const quantCrit = rubric.find((r) => r.category === 'quantitative') || rubric[1];
    const identCrit = rubric.find((r) => r.category === 'identification') || rubric[2];
    const safeCrit = rubric.find((r) => r.category === 'safety') || rubric[3];
    const arch = missionState.archetype || mission.archetype || 'blind_id';

    if (procCrit) {
      let procPts = hasEvidence ? procCrit.maxPoints : 0;
      let procDet = hasEvidence ? 'Experimental trace verified' : 'No experimental actions recorded';
      if (arch === 'standard_prep') {
        const usedTool = tel.usedMeasuringTools || tel.usedPipetteTransfer || (sim.items || []).some((i) => i.kind === 'scale');
        procPts = usedTool && hasEvidence ? procCrit.maxPoints : hasEvidence ? procCrit.maxPoints * 0.6 : 0;
        procDet = usedTool ? 'Measuring tools & preparation steps verified' : 'Use Scale / Cylinder / Pipette / Wash Bottle';
      } else if (arch === 'synthesis' && setupData.synthesisMeta) {
        const reqs = setupData.synthesisMeta.techniques || [];
        let reqHits = 0;
        for (const rk of reqs) {
          if (rk === 'filter' && tel.usedFilterFunnel) reqHits++;
          else if (rk === 'sep_funnel' && tel.sepFunnelTaps > 0) reqHits++;
          else if (rk === 'condenser' && (sim.items || []).some((i) => i.kind === 'condenser' && i.coolantOn !== false)) reqHits++;
          else if (rk === 'calcine' && tel.bunsenBlueUsed) reqHits++;
          else if (rk === 'gas_dry' && tel.gasDriedViaH2SO4 && tel.gasConnectedToSyringe) reqHits++;
        }
        procPts = reqs.length > 0 ? procCrit.maxPoints * (reqHits / reqs.length) : (hasEvidence ? procCrit.maxPoints : 0);
        procDet = reqs.length > 0 ? `${reqHits}/${reqs.length} techniques verified` : procDet;
      }
      results.push(makeCriterionResult(procCrit, procPts, procDet));
    }
    if (quantCrit) {
      let qPts = hasEvidence ? quantCrit.maxPoints * 0.5 : 0;
      let qDet = hasEvidence ? 'Measurements/samples valid' : 'Missing lab work';
      if (arch === 'titration' && setupData.titrationMeta?.itemId && tel.usedBuretteDrops > 0) {
        const tv = sim.getItem(setupData.titrationMeta.itemId);
        const liqL = tv ? computeLiquidVolumeL(tv.moles, tv.tempK) : 0;
        const ph = tv && liqL > 1e-6 ? computePH(tv.moles, liqL, tv.tempK) : null;
        if (ph !== null && ph >= 6.8 && ph <= 10.3) qPts = quantCrit.maxPoints;
        qDet = ph !== null ? `pH = ${ph.toFixed(2)}` : qDet;
      } else if (arch === 'standard_prep' && setupData.standardPrepMeta) {
        const spMeta = setupData.standardPrepMeta;
        const tol = (Number(spMeta.tolerancePct) || 5.0) / 100;
        const tgtVolMl = Number(spMeta.targetVolumeMl) || 100;
        const tgtVal = Number(spMeta.targetMolarityM) || 0.2;
        let bestPts = 0;
        for (const v of sim.items || []) {
          if (v.kind !== 'vessel' || v.isShattered) continue;
          const nSol = v.moles?.[spMeta.targetSpeciesId] || 0;
          const liqL = computeLiquidVolumeL(v.moles, v.tempK);
          const liqMl = liqL * 1000;
          if (nSol <= 1e-7 || liqMl < 5) continue;
          const actualConc = nSol / liqL;
          const cErr = Math.abs(actualConc - tgtVal) / Math.max(1e-6, tgtVal);
          const vErr = Math.abs(liqMl - tgtVolMl) / Math.max(1, tgtVolMl);
          if (cErr <= tol && vErr <= tol) bestPts = Math.max(bestPts, quantCrit.maxPoints);
          else if (cErr <= tol * 2 && vErr <= tol * 2) bestPts = Math.max(bestPts, quantCrit.maxPoints * 0.65);
          else bestPts = Math.max(bestPts, quantCrit.maxPoints * 0.25);
          qDet = `C=${actualConc.toFixed(3)}M · V=${liqMl.toFixed(1)}mL`;
        }
        qPts = bestPts;
      } else if (arch === 'synthesis' && setupData.synthesisMeta?.targetProductId) {
        const syn = setupData.synthesisMeta;
        const minMol = Number(syn.minYieldMol) || 0.005;
        const minPur = (Number(syn.minPurityPct) || 70) / 100;
        let bestPts = 0;
        for (const it of sim.items || []) {
          if (it.isShattered) continue;
          const map = it.kind === 'gas_syringe' ? buildCombinedSyringeTotalMoles(it) : (it.moles || {});
          const prodMol = map[syn.targetProductId] || 0;
          if (prodMol <= 1e-7) continue;
          const totMol = Object.entries(map).reduce((s, [k, n]) => s + (k === 'H2O_l' ? 0 : (n || 0)), 0);
          const pur = totMol > 0 ? prodMol / totMol : 0;
          const yFac = Math.min(1, prodMol / minMol);
          const pFac = pur >= minPur ? 1 : pur >= minPur * 0.6 ? 0.6 : 0.3;
          const cand = quantCrit.maxPoints * (0.55 * yFac + 0.45 * pFac);
          if (cand > bestPts) {
            bestPts = cand;
            qDet = `${(prodMol * 1000).toFixed(1)} mmol (${(pur * 100).toFixed(0)}% pure)`;
          }
        }
        qPts = bestPts;
      } else if (arch === 'electrochem' && setupData.electrochemMeta) {
        const ec = setupData.electrochemMeta;
        if (ec.preset === 'voltaic_emf') {
          const dmm = (sim.items || []).find((i) => i.kind === 'volt_ammeter');
          const meas = Math.abs(dmm?.measuredV || 0);
          const tgt = Number(ec.targetEmfV) || 1.10;
          const tolV = Number(ec.tolV) || 0.08;
          qPts = Math.abs(meas - tgt) <= tolV ? quantCrit.maxPoints : meas > 0.2 ? quantCrit.maxPoints * 0.5 : 0;
          qDet = `E=${meas.toFixed(2)}V (target ${tgt.toFixed(2)}±${tolV.toFixed(2)}V)`;
        } else {
          const tgtMol = Number(ec.targetAmountMol) || 0.005;
          let maxGot = 0;
          for (const it of sim.items || []) {
            if (ec.targetGasId && it.kind === 'gas_syringe') {
              maxGot = Math.max(maxGot, buildCombinedSyringeTotalMoles(it)[ec.targetGasId] || 0);
            } else if (ec.targetPlateMetal && it.kind === 'electrode') {
              const key = `plated${ec.targetPlateMetal}Mol`;
              maxGot = Math.max(maxGot, it[key] || 0);
            }
          }
          const err = tgtMol > 0 ? Math.abs(maxGot - tgtMol) / tgtMol : 1;
          qPts = err <= 0.1 ? quantCrit.maxPoints : maxGot > 1e-5 ? quantCrit.maxPoints * 0.6 : 0;
          qDet = `${(maxGot * 1000).toFixed(2)} mmol / ${(tgtMol * 1000).toFixed(2)} mmol`;
        }
      } else if (hasEvidence && (tel.contaminatedBlindIds || []).length === 0) {
        qPts = quantCrit.maxPoints;
      }
      results.push(makeCriterionResult(quantCrit, qPts, qDet));
    }
    if (identCrit) {
      const fields = mission.submitFields || [];
      let hits = 0;
      for (const f of fields) {
        const uVal = userAnswers[f.id];
        if (f.type === 'number' && ak.targetMolarityM != null) {
          const tol = (Number(setupData.titrationMeta?.tolerancePct) || 2.0) / 100;
          const num = Number(uVal);
          if (Number.isFinite(num) && num > 0) {
            const err = Math.abs(num - ak.targetMolarityM) / ak.targetMolarityM;
            if (err <= tol) hits += 1;
            else if (err <= tol * 2.5) hits += 0.7;
            else if (err <= tol * 5) hits += 0.4;
          }
        } else if (f.type === 'number' && (f.id === 'ans_pct_a' || f.id === 'ans_pct_b')) {
          const ref = f.id === 'ans_pct_a' ? ak.pctA : ak.pctB;
          const tolAbs = Number(setupData.mixtureMeta?.tolerancePct) || 3.0;
          const num = Number(uVal);
          if (Number.isFinite(num) && ref != null) {
            const diff = Math.abs(num - ref);
            if (diff <= tolAbs) hits += 1;
            else if (diff <= tolAbs * 2) hits += 0.6;
          }
        } else if (ak[f.id] && String(uVal || '').trim() === String(ak[f.id]).trim()) {
          hits += 1;
        }
      }
      const idPts = fields.length > 0 ? (hits / fields.length) * identCrit.maxPoints : 0;
      results.push(makeCriterionResult(identCrit, idPts, `${hits.toFixed(1)}/${fields.length} answered`));
    }
    if (safeCrit) {
      const safe = computeCommonSafetyPoints(safeCrit.maxPoints, sim, tel);
      results.push(makeCriterionResult(safeCrit, safe.pts, `${safe.incidents} incident(s)`));
    }
  } else if (mission.id === 'mission_qualitative_4') {
    const blindIds = setupData.blindVesselIds || [];
    const subVessels = (sim.items || []).filter((i) => i.kind === 'vessel' && !blindIds.includes(i.id) && !i.isShattered);
    const usedSubTest = subVessels.some((v) => Object.values(v.moles || {}).some((n) => n > 1e-6)) || tel.usedPipetteTransfer;
    const procScore = (tel.usedLitmusOrPh ? 1.25 : 0) + (usedSubTest ? 1.25 : 0);
    results.push(
      makeCriterionResult(
        mission.rubric[0],
        procScore,
        isEn
          ? `Pipette/Sub-tubes: ${usedSubTest ? 'OK (+1.25)' : 'Missing (+0)'} · Litmus/pH: ${tel.usedLitmusOrPh ? 'OK (+1.25)' : 'Not tested (+0)'}`
          : `Pipette/Ống thử: ${usedSubTest ? 'Đạt (+1.25)' : 'Chưa (+0)'} · Quỳ tím/pH: ${tel.usedLitmusOrPh ? 'Đạt (+1.25)' : 'Chưa thử (+0)'}`
      )
    );

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
    results.push(
      makeCriterionResult(
        mission.rubric[1],
        quantScore,
        isEn ? `${preservedCount}/${blindIds.length} clean samples preserved (≥44 mL)` : `Giữ nguyên vẹn ${preservedCount}/${blindIds.length} bình gốc (≥44 mL)`
      )
    );

    let correctLbl = 0;
    for (const lbl of ['?A', '?B', '?C', '?D']) {
      if (userAnswers[`ans_${lbl}`] && userAnswers[`ans_${lbl}`] === ak[lbl]) correctLbl += 1;
    }
    const identScore = (correctLbl / 4) * mission.rubric[2].maxPoints;
    results.push(
      makeCriterionResult(
        mission.rubric[2],
        identScore,
        isEn ? `Assigned ${correctLbl}/4 correctly` : `Gán đúng ${correctLbl}/4 bình`
      )
    );

    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, isEn ? `${safe.incidents} safety incident(s)` : `${safe.incidents} sự cố an toàn`));
  } else if (mission.id === 'mission_titration_hcl') {
    const flask = sim.getItem(setupData.targetVesselId);
    const hasPhen = Boolean(flask && (flask.moles?.Phenolphthalein_aq || 0) > 1e-9);
    const hasIndicator = hasPhen || tel.usedLitmusOrPh;
    const procPts = (tel.usedBuretteDrops > 0 ? 1.5 : 0) + (hasIndicator ? 1.0 : 0);
    results.push(
      makeCriterionResult(
        mission.rubric[0],
        procPts,
        isEn
          ? `Burette drops: ${tel.usedBuretteDrops} (${tel.usedBuretteDrops > 0 ? '+1.5' : '+0'}) · Phen/pH: ${hasIndicator ? 'OK (+1.0)' : 'Add Phen or pH probe (+0)'}`
          : `Nhỏ Burette: ${tel.usedBuretteDrops} lần (${tel.usedBuretteDrops > 0 ? '+1.5' : '+0'}) · Chỉ thị/pH: ${hasIndicator ? 'Đạt (+1.0)' : 'Chưa thêm Phen/đo pH (+0)'}`
      )
    );

    const liqL = flask ? computeLiquidVolumeL(flask.moles, flask.tempK) : 0;
    const ph = flask && liqL > 1e-6 ? computePH(flask.moles, liqL, flask.tempK) : null;
    let quantPts = 0;
    if (ph !== null && tel.usedBuretteDrops > 0) {
      if (ph >= 6.8 && ph <= 10.3) quantPts = mission.rubric[1].maxPoints;
      else if (ph > 10.3 && ph <= 11.4) quantPts = mission.rubric[1].maxPoints * 0.6;
      else if (ph > 5.0 && ph < 6.8) quantPts = mission.rubric[1].maxPoints * 0.5;
      else quantPts = 0.4;
    }
    results.push(
      makeCriterionResult(
        mission.rubric[1],
        quantPts,
        ph !== null
          ? isEn
            ? `Flask pH = ${ph.toFixed(2)} (target 6.8–10.3)`
            : `pH bình = ${ph.toFixed(2)} (mục tiêu 6.8–10.3)`
          : isEn
          ? 'Dispense NaOH from Burette toward equivalence'
          : 'Mở Burette nhỏ NaOH tới điểm tương đương'
      )
    );

    const userVal = Number(userAnswers.ans_molarity);
    const trueVal = Number(ak.targetMolarityM) || 0.1;
    let identPts = 0;
    let errPctStr = isEn ? 'Enter C_M(HCl) from C₁V₁ = C₂V₂' : 'Nhập C_M(HCl) tính từ C₁V₁ = C₂V₂';
    if (Number.isFinite(userVal) && userVal > 0) {
      const errPct = Math.abs(userVal - trueVal) / trueVal * 100;
      errPctStr = isEn
        ? `Error ±${errPct.toFixed(1)}% (≤2% full pts)`
        : `Sai số ±${errPct.toFixed(1)}% (≤2% đạt trọn điểm)`;
      if (errPct <= 2.0) identPts = mission.rubric[2].maxPoints;
      else if (errPct <= 5.0) identPts = mission.rubric[2].maxPoints * 0.7;
      else if (errPct <= 10.0) identPts = mission.rubric[2].maxPoints * 0.4;
    }
    results.push(makeCriterionResult(mission.rubric[2], identPts, errPctStr));

    const overTitratedPen = ph !== null && ph > 12.2 ? 0.5 : 0;
    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel, overTitratedPen);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, isEn ? `${safe.incidents} safety incident(s)` : `${safe.incidents} sự cố an toàn`));
  } else if (mission.id === 'mission_calcination_cao') {
    const cruc = sim.getItem(setupData.crucibleId) || (sim.items || []).find((i) => i.kind === 'vessel' && ((i.moles?.CaO_s || 0) > 1e-4 || (i.moles?.CaCO3_s || 0) > 1e-4));
    const caoScore = cruc ? computeCaOOptimizationScore(cruc) : null;
    const procPts = caoScore ? caoScore.points : 0;
    results.push(makeCriterionResult(mission.rubric[0], procPts, caoScore ? (isEn ? `${caoScore.points}/4 steps achieved` : `Đạt ${caoScore.points}/4 kỹ thuật nung`) : '0/4'));

    const yieldPct = caoScore ? caoScore.yieldPct : 0;
    let quantPts = 0;
    if (yieldPct >= 90) quantPts = mission.rubric[1].maxPoints;
    else quantPts = (yieldPct / 90) * mission.rubric[1].maxPoints * 0.85;
    results.push(makeCriterionResult(mission.rubric[1], quantPts, isEn ? `CaO yield = ${yieldPct.toFixed(1)}%` : `Hiệu suất CaO = ${yieldPct.toFixed(1)}%`));

    let identPts = 0;
    if (userAnswers.ans_gas === ak.gas) identPts += 0.5;
    if (userAnswers.ans_product === ak.product) identPts += 0.5;
    results.push(makeCriterionResult(mission.rubric[2], identPts, `${userAnswers.ans_gas || '—'} / ${userAnswers.ans_product || '—'}`));

    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, isEn ? `${safe.incidents} safety incident(s)` : `${safe.incidents} sự cố an toàn`));
  } else if (mission.id === 'mission_gas_prep') {
    const syr = sim.getItem(setupData.targetSyringeId) || (sim.items || []).find((i) => i.kind === 'gas_syringe' && !i.isBroken);
    const hasDryAgent = (sim.items || []).some((v) => v.kind === 'vessel' && ((v.moles?.H2SO4_l || 0) > 0.015 || ((v.moles?.H_aq || 0) > 0.02 && (v.moles?.HSO4_aq || 0) > 0.01)));
    const procPts = (tel.gasConnectedToSyringe ? 1.5 : 0) + ((tel.gasDriedViaH2SO4 || hasDryAgent) ? 1.5 : 0);
    results.push(
      makeCriterionResult(
        mission.rubric[0],
        procPts,
        isEn
          ? `Drying: ${tel.gasDriedViaH2SO4 || hasDryAgent ? 'H₂SO₄ OK (+1.5)' : 'Missing (+0)'} · Syringe link: ${tel.gasConnectedToSyringe ? 'OK (+1.5)' : 'Missing (+0)'}`
          : `Làm khô: ${tel.gasDriedViaH2SO4 || hasDryAgent ? 'H₂SO₄ Đạt (+1.5)' : 'Chưa có (+0)'} · Nối Syringe: ${tel.gasConnectedToSyringe ? 'Đạt (+1.5)' : 'Chưa nối (+0)'}`
      )
    );

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
    results.push(makeCriterionResult(mission.rubric[1], quantPts, isEn ? `Collected ${gasMl.toFixed(1)} mL · Purity ${purityPct.toFixed(1)}% ${ak.gas}` : `Thu được ${gasMl.toFixed(1)} mL · Tinh khiết ${purityPct.toFixed(1)}% ${ak.gas}`));

    let identPts = 0;
    if (userAnswers.ans_gas === ak.gas) identPts += 0.5;
    if (userAnswers.ans_drying === ak.dryingAgent) identPts += 0.5;
    results.push(makeCriterionResult(mission.rubric[2], identPts, `${userAnswers.ans_gas || '—'} · ${userAnswers.ans_drying || '—'}`));

    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, isEn ? `${safe.incidents} safety incident(s)` : `${safe.incidents} sự cố an toàn`));
  } else if (mission.id === 'mission_electrochem_cell') {
    const dmm = sim.getItem(setupData.dmmId) || (sim.items || []).find((i) => i.kind === 'volt_ammeter');
    const sb = setupData.saltBridgeId ? sim.getItem(setupData.saltBridgeId) : (sim.items || []).find((i) => i.kind === 'salt_bridge');
    const isSacrificial = ak.mode === 'sacrificial';
    const sbClean = isSacrificial ? true : Boolean(sb && !sb.isBroken && !sb.fouledByAgCl && !sb.fouledBySulfate && sb.vesselAId && sb.vesselBId);
    const hasClosedMeter = Boolean(dmm && dmm.posElectrodeId && dmm.negElectrodeId);
    const procPts = (hasClosedMeter ? 1.5 : 0) + (sbClean ? 1.5 : 0);
    results.push(
      makeCriterionResult(
        mission.rubric[0],
        procPts,
        isEn
          ? `Meter loop: ${hasClosedMeter ? 'OK (+1.5)' : 'Open (+0)'} · Salt bridge: ${sbClean ? 'Clean (+1.5)' : 'Fouled/Open (+0)'}`
          : `Mạch đồng hồ: ${hasClosedMeter ? 'Đạt (+1.5)' : 'Hở (+0)'} · Cầu muối: ${sbClean ? 'Sạch (+1.5)' : 'Kết tủa/Hở (+0)'}`
      )
    );

    let quantPts = 0;
    let quantDetail = '';
    if (isSacrificial) {
      const feEl = sim.getItem(ak.feElectrodeId);
      const protectedOk = Boolean(feEl?.cathodicProtectedActive);
      const feRatio = feEl && ak.feInitialMol > 0 ? (feEl.rodMetalMol || 0) / ak.feInitialMol : 0;
      if (protectedOk && feRatio >= 0.96) quantPts = mission.rubric[1].maxPoints;
      else if (protectedOk) quantPts = mission.rubric[1].maxPoints * 0.7;
      quantDetail = isEn
        ? `Cathodic protection: ${protectedOk ? 'ON' : 'OFF'} · Fe kept ${(feRatio * 100).toFixed(1)}%`
        : `Bảo vệ catốt: ${protectedOk ? 'Bật' : 'Chưa'} · Giữ được ${(feRatio * 100).toFixed(1)}% Fe`;
    } else {
      const measuredV = Math.abs(dmm?.measuredV || 0);
      const trueEmf = ak.targetEmfV || 0.762;
      const errPct = (Math.abs(measuredV - trueEmf) / trueEmf) * 100;
      if (errPct <= 4) quantPts = mission.rubric[1].maxPoints;
      else if (errPct <= 10) quantPts = mission.rubric[1].maxPoints * 0.65;
      else if (measuredV > 0.2) quantPts = mission.rubric[1].maxPoints * 0.35;
      quantDetail = isEn ? `Measured E = ${measuredV.toFixed(2)}V (target ${trueEmf.toFixed(2)}V)` : `Đo được E = ${measuredV.toFixed(2)}V (mục tiêu ${trueEmf.toFixed(2)}V)`;
    }
    results.push(makeCriterionResult(mission.rubric[1], quantPts, quantDetail));

    let identPts = 0;
    if ((ak.validAnodes || []).includes(userAnswers.ans_anode)) identPts += 1.0;
    const ansEmf = Number(userAnswers.ans_emf);
    const refEmf = ak.mode === 'sacrificial' ? Math.abs(dmm?.measuredV || ak.targetEmfV) : ak.targetEmfV;
    if (Number.isFinite(ansEmf) && refEmf > 0 && Math.abs(ansEmf - refEmf) <= Math.max(0.08, refEmf * 0.1)) {
      identPts += 1.0;
    }
    results.push(makeCriterionResult(mission.rubric[2], identPts, `Anode: ${userAnswers.ans_anode || '—'} · E = ${userAnswers.ans_emf || '—'}V`));

    const foulPen = sb && (sb.fouledByAgCl || sb.fouledBySulfate) ? 0.5 : 0;
    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel, foulPen);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, isEn ? `${safe.incidents} safety incident(s)` : `${safe.incidents} sự cố an toàn`));
  } else if (mission.id === 'mission_ester_synth') {
    const sep = sim.getItem(setupData.sepFunnelId) || (sim.items || []).find((i) => i.kind === 'separatory_funnel');
    const anyEsterMade = tel.esterFormed || (sim.items || []).some((i) => (i.moles?.CH3COOC2H5_l || 0) > 0.002);
    const sepActive = tel.sepFunnelTaps > 0 || (sep && (sep.moles?.CH3COOC2H5_l || 0) > 0.002);
    const procPts = (anyEsterMade ? 2.0 : 0) + (sepActive ? 1.5 : 0);
    results.push(
      makeCriterionResult(
        mission.rubric[0],
        procPts,
        isEn
          ? `Ester synthesis: ${anyEsterMade ? 'OK (+2.0)' : 'Not formed (+0)'} · Sep. funnel: ${sepActive ? 'OK (+1.5)' : 'Unused (+0)'}`
          : `Tạo este: ${anyEsterMade ? 'Đạt (+2.0)' : 'Chưa tạo (+0)'} · Phễu chiết: ${sepActive ? 'Đạt (+1.5)' : 'Chưa dùng (+0)'}`
      )
    );

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
    results.push(makeCriterionResult(mission.rubric[1], quantPts, isEn ? `${(bestEsterMol * 1000).toFixed(1)} mmol (${(bestPurity * 100).toFixed(0)}% pure)` : `Thu được ${(bestEsterMol * 1000).toFixed(1)} mmol (tinh khiết ${(bestPurity * 100).toFixed(0)}%)`));

    let identPts = 0;
    if (userAnswers.ans_layer === ak.layer) identPts += 1.0;
    if (userAnswers.ans_ester === ak.esterName) identPts += 1.0;
    results.push(makeCriterionResult(mission.rubric[2], identPts, `${userAnswers.ans_layer || '—'} · ${userAnswers.ans_ester || '—'}`));

    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, isEn ? `${safe.incidents} safety incident(s)` : `${safe.incidents} sự cố an toàn`));
  } else if (mission.id === 'mission_solution_prep') {
    const prepMeta = setupData.standardPrepMeta || mission.standardPrepConfig || {};
    const tgtM = Number(prepMeta.targetMolarityM || ak.targetMolarityM || 0.2);
    const tgtVolMl = Number(prepMeta.targetVolumeMl || ak.targetVolumeMl || 100);
    const tolFrac = (Number(prepMeta.tolerancePct || 5.0)) / 100;
    const usedTools = tel.usedMeasuringTools || tel.usedPipetteTransfer || (sim.items || []).some((i) => i.kind === 'scale');
    const procPts = (usedTools ? 2.0 : 0) + ((sim.items || []).some((i) => (i.moles?.H2O_l || 0) > 1.0) ? 1.0 : 0);
    results.push(makeCriterionResult(mission.rubric[0], procPts, usedTools ? (isEn ? 'Scale/Cylinder/Wash bottle used' : 'Đã dùng Cân / Ống đong / Bình tia') : (isEn ? 'Use measuring tools' : 'Hãy dùng Cân & Bình tia')));

    let qPts = 0;
    let qDetail = isEn ? 'Prepare target 100 mL CuSO₄ solution' : 'Pha đúng 100 mL dung dịch CuSO₄';
    for (const v of sim.items || []) {
      if (v.kind !== 'vessel' || v.isShattered) continue;
      const nCu = v.moles?.Cu2_aq || 0;
      const liqL = computeLiquidVolumeL(v.moles, v.tempK);
      const liqMl = liqL * 1000;
      if (nCu <= 1e-6 || liqMl < 5) continue;
      const cActual = nCu / liqL;
      const cErr = Math.abs(cActual - tgtM) / tgtM;
      const vErr = Math.abs(liqMl - tgtVolMl) / tgtVolMl;
      let pts = 0;
      if (cErr <= tolFrac && vErr <= tolFrac) pts = mission.rubric[1].maxPoints;
      else if (cErr <= tolFrac * 2 && vErr <= tolFrac * 2) pts = mission.rubric[1].maxPoints * 0.65;
      else pts = mission.rubric[1].maxPoints * 0.25;
      if (pts >= qPts) {
        qPts = pts;
        qDetail = `C = ${cActual.toFixed(3)} M (${tgtM.toFixed(2)} M) · V = ${liqMl.toFixed(1)} mL`;
      }
    }
    results.push(makeCriterionResult(mission.rubric[1], qPts, qDetail));

    const uMass = Number(userAnswers.ans_mass_g);
    const expMass = Number(ak.expectedMassG) || 4.99;
    let idPts = 0;
    if (Number.isFinite(uMass) && uMass > 0) {
      const mErr = Math.abs(uMass - expMass) / expMass;
      if (mErr <= 0.03) idPts = mission.rubric[2].maxPoints;
      else if (mErr <= 0.08) idPts = mission.rubric[2].maxPoints * 0.6;
    }
    results.push(makeCriterionResult(mission.rubric[2], idPts, `m = ${Number.isFinite(uMass) ? uMass.toFixed(2) : '—'} g (ref ${expMass.toFixed(2)} g)`));

    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, isEn ? `${safe.incidents} safety incident(s)` : `${safe.incidents} sự cố an toàn`));
  } else if (mission.id === 'mission_mixture_analysis') {
    const syr = sim.getItem(setupData.targetSyringeId) || (sim.items || []).find((i) => i.kind === 'gas_syringe' && !i.isBroken);
    const mixId = setupData.mixtureMeta?.vesselId;
    const mixV = mixId ? sim.getItem(mixId) : null;
    const procPts = (tel.gasConnectedToSyringe ? 1.5 : 0) + ((mixV && (mixV.moles?.Fe_s || 0) < 0.02) || (sim.logs?.length || 0) > 0 ? 1.5 : 0);
    results.push(makeCriterionResult(mission.rubric[0], procPts, tel.gasConnectedToSyringe ? (isEn ? 'Closed gas-syringe trap OK' : 'Đã nối kín Gas syringe thu H₂') : (isEn ? 'Connect closed Gas syringe!' : 'Cần nối kín Gas syringe!')));

    const allGas = syr ? buildCombinedSyringeTotalMoles(syr) : {};
    const h2Mol = allGas.H2_g || 0;
    const h2Ml = syr ? computeSyringeGasVolumeMl(syr, sim.environment) : 0;
    const feReacted = Boolean(mixV && (mixV.moles?.Fe_s || 0) < 1e-4 && (mixV.moles?.Cu_s || 0) > 1e-4);
    const quantPts = h2Mol >= 0.005 ? mission.rubric[1].maxPoints : feReacted || h2Mol > 0.0005 ? mission.rubric[1].maxPoints * 0.55 : 0;
    results.push(makeCriterionResult(mission.rubric[1], quantPts, isEn ? `Collected ${h2Ml.toFixed(1)} mL H₂` : `Thu được ${h2Ml.toFixed(1)} mL khí H₂`));

    const pctA = Number(userAnswers.ans_pct_a);
    const pctB = Number(userAnswers.ans_pct_b);
    let idPts = 0;
    if (Number.isFinite(pctA) && ak.pctA != null && Math.abs(pctA - ak.pctA) <= 3.0) idPts += 1.5;
    if (Number.isFinite(pctB) && ak.pctB != null && Math.abs(pctB - ak.pctB) <= 3.0) idPts += 1.5;
    results.push(makeCriterionResult(mission.rubric[2], idPts, `%Fe=${userAnswers.ans_pct_a || '—'}% · %Cu=${userAnswers.ans_pct_b || '—'}%`));

    const safe = computeCommonSafetyPoints(mission.rubric[3].maxPoints, sim, tel);
    results.push(makeCriterionResult(mission.rubric[3], safe.pts, isEn ? `${safe.incidents} safety incident(s)` : `${safe.incidents} sự cố an toàn`));
  }

  const rawScore = results.reduce((sum, r) => sum + r.earned, 0);
  const hintsUsed = missionState?.hintsUsed || 0;
  const hintPenalty = missionState?.mode === 'exam' ? Math.min(2.0, hintsUsed * 0.5) : 0;
  const integrityPenalty = Math.min(2.5, Number(options.integrityLog?.penaltyPoints || missionState?.integrityPenalty || 0));
  const totalScore = Math.max(0, Math.min(10.0, +(rawScore - hintPenalty - integrityPenalty).toFixed(1)));
  const rank = gradeFromScore(totalScore);
  const procItem = results.find((r) => r.category === 'process');
  const processAnomaly = Boolean(missionState?.examMode && procItem && procItem.earned <= 0.01 && Object.values(userAnswers || {}).some((v) => String(v || '').trim() !== ''));

  return {
    missionId: mission.id,
    titleKey: mission.titleKey || '',
    titleText: mission.titleText || '',
    mode: missionState?.mode || 'practice',
    examMode: Boolean(missionState?.examMode),
    examCode: missionState?.examCode || null,
    seed: missionState?.seed || 1,
    elapsedSec: Math.max(0, Math.round((Date.now() - (missionState?.startedAtMs || Date.now())) / 1000)),
    rawScore: +rawScore.toFixed(1),
    hintPenalty: +hintPenalty.toFixed(1),
    integrityPenalty: +integrityPenalty.toFixed(1),
    processAnomaly,
    hintsUsed,
    totalScore,
    maxScore: 10,
    passed: totalScore >= 5.0,
    ...rank,
    criteriaResults: results,
    equationText: mission.equationText || '',
    answerKey: ak,
    t,
  };
}

export async function evaluateMissionWithVerification(sim, missionState, userAnswers = {}, options = {}) {
  const baseRes = evaluateMission(sim, missionState, userAnswers, options);
  if (!baseRes || !missionState?.customAssignment) return baseRes;

  const hashes = missionState.answerHashes || {};
  const hashKeys = Object.keys(hashes);
  if (hashKeys.length === 0) return baseRes;

  // Verify static/hashed questions via SHA-256 without ever exposing plaintext answerKey in client bundle
  const identCrit = baseRes.criteriaResults.find((r) => r.category === 'identification');
  const fields = missionState.submitFields || [];
  const ak = missionState.setupData?.answerKey || {};
  if (identCrit && fields.length > 0) {
    let hits = 0;
    for (const f of fields) {
      const uVal = userAnswers[f.id];
      if (ak[f.id] && String(uVal || '').trim() === String(ak[f.id]).trim()) {
        hits += 1;
      } else if (hashes[f.id]) {
        const ok = await verifyHashedAnswer(missionState.seed, f.id, uVal, hashes[f.id]);
        if (ok) hits += 1;
      } else if (f.type === 'number' && ak.targetMolarityM != null) {
        const num = Number(uVal);
        if (Number.isFinite(num) && num > 0) {
          const err = Math.abs(num - ak.targetMolarityM) / ak.targetMolarityM;
          if (err <= 0.02) hits += 1;
          else if (err <= 0.05) hits += 0.7;
          else if (err <= 0.1) hits += 0.4;
        }
      }
    }
    const newPts = +Math.min(identCrit.maxPoints, (hits / fields.length) * identCrit.maxPoints).toFixed(2);
    identCrit.earned = newPts;
    const ratio = identCrit.maxPoints > 0 ? newPts / identCrit.maxPoints : 0;
    identCrit.status = ratio >= 0.9 ? 'pass' : ratio >= 0.35 ? 'partial' : 'fail';
    identCrit.detail = `${hits.toFixed(1)}/${fields.length} verified`;

    const rawScore = baseRes.criteriaResults.reduce((s, r) => s + r.earned, 0);
    const totalScore = Math.max(0, Math.min(10.0, +(rawScore - (baseRes.hintPenalty || 0) - (baseRes.integrityPenalty || 0)).toFixed(1)));
    const rank = gradeFromScore(totalScore);
    Object.assign(baseRes, {
      rawScore: +rawScore.toFixed(1),
      totalScore,
      passed: totalScore >= 5.0,
      ...rank,
    });
  }
  return baseRes;
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
