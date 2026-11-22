import { APPARATUS, getCondenserPorts, getProbeTipPos, getVesselEndPorts } from '../data/apparatus.js';
import { CONSTANTS } from '../data/constants.js';
import { SPECIES, createZeroGasMap } from '../data/species.js';
import {
  computeLiquidVolumeL,
  computePH,
  computePhaseStratification,
  computeSolidVolumeMl,
  computeSolutionVisuals,
} from './equilibrium.js';
import { computeHeatCapacityJK } from './thermodynamics.js';
import { stepVesselChemistry } from './chemistry.js';
import { NON_STEAM_GASES, routeGasPacketToTarget } from './gasNetwork.js';

const UNIVERSAL_PH_COLORS = [
  '#dc2626', // 0-1
  '#ef4444', // 2
  '#f97316', // 3
  '#fb923c', // 4
  '#facc15', // 5
  '#a3e635', // 6
  '#22c55e', // 7 Neutral
  '#10b981', // 8
  '#06b6d4', // 9
  '#0ea5e9', // 10
  '#3b82f6', // 11
  '#4f46e5', // 12
  '#7c3aed', // 13
  '#581c87', // 14
];

export function universalColorForPH(ph) {
  if (ph == null || !Number.isFinite(ph)) return UNIVERSAL_PH_COLORS[7];
  const idx = Math.max(0, Math.min(13, Math.round(ph)));
  return UNIVERSAL_PH_COLORS[idx];
}

function findOpenVesselBelowPoint(items, x, y, maxDx = 48, minDy = 10, maxDy = 260) {
  let best = null;
  let bestY = Infinity;
  for (const v of items) {
    if (v.kind !== 'vessel' || v.isShattered || v.isStoppered) continue;
    const spec = APPARATUS[v.typeId];
    if (!spec) continue;
    const rimY = v.y - spec.height / 2;
    const halfMouth = Math.max(22, spec.neckRadius || spec.width * 0.44);
    if (Math.abs(v.x - x) <= Math.min(maxDx, halfMouth + 14) && rimY >= y - 16 && rimY - y <= maxDy && rimY < bestY) {
      if (v.y > y + minDy || rimY >= y - 12) {
        bestY = rimY;
        best = v;
      }
    }
  }
  return best;
}

/**
 * Compute parabolic water jet trajectory from a Wash Bottle PTFE spout under gravity,
 * hitting any open vessel (beaker, erlenmeyer, test tube, dish, mortar) or Filter Funnel.
 */
export function computeWashBottleStreamArc(
  wb,
  items = [],
  benchFloorY = 482,
  gravityPxS2 = CONSTANTS.GRAVITY_PX_S2 || 1800
) {
  const { x: spoutX, y: spoutY, dir } = getProbeTipPos(wb);
  const angleRad = ((Number(wb.sprayAngleDeg) || 0) * Math.PI) / 180;
  const rawVx = dir * 195;
  const rawVy = -515;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const vx0 = rawVx * cosA - rawVy * sinA;
  const vy0 = rawVx * sinA + rawVy * cosA;
  const dtStep = 0.004;
  const points = [{ x: spoutX, y: spoutY }];
  let hitTarget = null;
  let blockedByStopper = false;
  let hitX = spoutX;
  let hitY = Math.min(benchFloorY, spoutY);
  let prevX = spoutX;
  let prevY = spoutY;

  for (let i = 1; i <= 360; i++) {
    const t = i * dtStep;
    const px = spoutX + vx0 * t;
    const py = spoutY + vy0 * t + 0.5 * gravityPxS2 * t * t;
    const vyNow = vy0 + gravityPxS2 * t;

    if (vyNow >= -10 && i >= 6) {
      const scanOrder = [
        ...items.filter((d) => d.kind === 'filter_funnel'),
        ...items.filter((d) => d.kind === 'vessel'),
      ];
      for (const dst of scanOrder) {
        if (dst.id === wb.id || dst.isShattered || dst.isBroken || dst.isInverted) continue;
        if (dst.kind !== 'vessel' && dst.kind !== 'filter_funnel') continue;
        const dSpec = APPARATUS[dst.typeId];
        if (!dSpec) continue;
        const rimY =
          dst.kind === 'filter_funnel'
            ? dst.y - dSpec.height / 2 + 4
            : dst.y - dSpec.height / 2 + 2;
        const halfMouth =
          dst.kind === 'filter_funnel'
            ? 31
            : Math.max(20, dSpec.neckRadius || dSpec.width * 0.44);

        const crossRim = prevY <= rimY + 6 && py >= rimY - 4;
        const inMouthBand = py >= rimY - 5 && py <= rimY + 18 && i <= 22;
        if ((crossRim || inMouthBand) && Math.abs(px - dst.x) <= halfMouth + 5) {
          if (dst.isStoppered) {
            blockedByStopper = true;
            hitX = px;
            hitY = rimY - 5;
            points.push({ x: hitX, y: hitY });
            return { spoutX, spoutY, dir, points, hitTarget: null, blockedByStopper, hitX, hitY };
          }
          hitTarget = dst;
          hitX = px;
          hitY = rimY + 3;
          points.push({ x: hitX, y: hitY });
          return { spoutX, spoutY, dir, points, hitTarget, blockedByStopper: false, hitX, hitY };
        }
      }
    }

    if (py >= benchFloorY) {
      const f = (benchFloorY - prevY) / Math.max(1e-6, py - prevY);
      hitX = prevX + (px - prevX) * f;
      hitY = benchFloorY;
      points.push({ x: hitX, y: hitY });
      return { spoutX, spoutY, dir, points, hitTarget: null, blockedByStopper: false, hitX, hitY };
    }

    points.push({ x: px, y: py });
    prevX = px;
    prevY = py;
  }
  return { spoutX, spoutY, dir, points, hitTarget, blockedByStopper, hitX, hitY };
}

/**
 * Gravity liquid-only filtration (Phase 'l' & 'aq' pass through; ALL phase 's' solids stay on filter paper).
 */
function stepFilterFunnel(sim, funnel, dt) {
  funnel.isFiltering = false;
  funnel.filtrateTargetId = null;

  // Phenomenon #7A: Photochemical AgCl(s) -> Ag(s) + 0.5 Cl2(g) on filter paper under UV / bright sunlight
  const nAgClStart = funnel.moles.AgCl_s || 0;
  if (nAgClStart > 1e-8 && sim.environment.uvLight) {
    // Track total Ag pool initially present when UV exposure begins so masking protects exactly half from darkening
    const curTotalAgPool = nAgClStart + (funnel.moles.Ag_s || 0);
    if (!funnel.uvExposedPoolRef || funnel.uvExposedPoolRef < curTotalAgPool) {
      funnel.uvExposedPoolRef = curTotalAgPool;
    }
    const exposedLimit = funnel.uvMaskHalf ? funnel.uvExposedPoolRef * 0.5 : funnel.uvExposedPoolRef;
    const exposedRemain = Math.max(0, exposedLimit - (funnel.moles.Ag_s || 0));
    const dPhoto = Math.min(nAgClStart, exposedRemain, Math.max(1e-7, nAgClStart * 0.35 * dt));
    if (dPhoto > 1e-9) {
      funnel.moles.AgCl_s = nAgClStart - dPhoto;
      if (funnel.moles.AgCl_s < 1e-12) delete funnel.moles.AgCl_s;
      funnel.moles.Ag_s = (funnel.moles.Ag_s || 0) + dPhoto;
      funnel.escapedGasMoles = funnel.escapedGasMoles || {};
      funnel.escapedGasMoles.Cl2_g = (funnel.escapedGasMoles.Cl2_g || 0) + dPhoto * 0.5;
      funnel.uvDarkFrac = Math.min(1, (funnel.moles.Ag_s || 0) / Math.max(1e-8, funnel.uvExposedPoolRef));
      if (!funnel._uvPhotoLogged && (funnel.moles.Ag_s || 0) > 1e-4) {
        funnel._uvPhotoLogged = true;
        sim.addLog({
          type: 'reaction',
          equation: '2AgCl(s) —(hν)→ 2Ag(s) + Cl₂(g)↑',
          nameVi: 'Quang phân hủy AgCl(s) trên giấy lọc dưới ánh sáng UV',
          nameEn: 'Photochemical darkening of AgCl(s) on filter paper under UV',
          descVi: 'Ánh sáng mạnh khử phần AgCl(s) không bị che thành bạc kim loại Ag(s) xám đen; phần bị che vẫn giữ nguyên AgCl trắng.',
          descEn: 'Bright UV reduces unmasked AgCl(s) to dark metallic Ag(s), while masked AgCl stays pure white.',
          vesselLabel: funnel.label,
        });
      }
    }
  } else {
    funnel.uvExposedPoolRef = null;
  }

  // Phenomenon #7B: Rinsing filter paper with NH3(aq) fixes the image: unexposed AgCl dissolves as [Ag(NH3)2]+ while metallic Ag(s) stays fixed!
  const nAgClNow = funnel.moles.AgCl_s || 0;
  const nNH3Now = funnel.moles.NH3_aq || 0;
  if (nAgClNow > 1e-8 && nNH3Now > 1e-6) {
    const dFix = Math.min(nAgClNow, nNH3Now / 2, Math.max(1e-6, nAgClNow * 1.8 * dt));
    if (dFix > 1e-9) {
      funnel.moles.AgCl_s = nAgClNow - dFix;
      if (funnel.moles.AgCl_s < 1e-12) delete funnel.moles.AgCl_s;
      funnel.moles.NH3_aq = nNH3Now - 2 * dFix;
      if (funnel.moles.NH3_aq < 1e-12) delete funnel.moles.NH3_aq;
      funnel.moles.AgNH3_2_aq = (funnel.moles.AgNH3_2_aq || 0) + dFix;
      funnel.moles.Cl_aq = (funnel.moles.Cl_aq || 0) + dFix;
      if (!funnel._uvFixLogged) {
        funnel._uvFixLogged = true;
        sim.addLog({
          type: 'reaction',
          equation: 'AgCl(s) + 2NH₃(aq) → [Ag(NH₃)₂]⁺(aq) + Cl⁻(aq) (Rửa định hình ảnh Ag)',
          nameVi: 'Rửa trôi AgCl bằng NH₃ ("Định hình ảnh bạc Ag(s)")',
          nameEn: 'Photographic fixing: NH₃ rinses away AgCl leaving permanent Ag(s)',
          descVi: 'Dung dịch NH₃ hòa tan sạch AgCl chưa phơi sáng trôi xuống bình hứng, chỉ giữ lại lớp Ag(s) đen bền vững trên giấy lọc.',
          descEn: 'NH₃ dissolves unexposed white AgCl through the filter as [Ag(NH₃)₂]⁺ while dark Ag(s) stays permanently fixed.',
          vesselLabel: funnel.label,
        });
      }
    }
  }

  const liqL = computeLiquidVolumeL(funnel.moles, funnel.tempK);
  const liqMl = liqL * 1000;
  if (liqMl <= 0.005) {
    funnel.filtrateRateMlS = 0;
    return;
  }

  const target = findOpenVesselBelowPoint(sim.items, funnel.x, funnel.y + 18, 56, 4, 240);
  const flowRateMlS = Math.min(16.0, 4.5 + liqMl * 0.35);
  const moveMl = Math.min(liqMl, flowRateMlS * dt);
  const frac = Math.min(1, moveMl / Math.max(1e-6, liqMl));
  if (frac <= 1e-6) return;

  funnel.isFiltering = true;
  funnel.filtrateRateMlS = flowRateMlS;
  funnel.filtrateTargetId = target ? target.id : null;
  funnel.filtrateColor = computeSolutionVisuals(
    funnel.moles,
    liqL,
    computePH(funnel.moles, liqL, funnel.tempK),
    3.0,
    funnel.phenBleachFrac || 0,
    funnel.phenIrrevFrac || 0
  ).css;

  const cDstBefore = target ? computeHeatCapacityJK(target) : 0;
  const oldDstPhen = target ? target.moles.Phenolphthalein_aq || 0 : 0;
  const oldDstBleach = target ? target.phenBleachFrac || 0 : 0;
  let movedPhen = 0;
  let cMoved = 0;

  for (const [spId, n] of Object.entries(funnel.moles)) {
    if (n <= 0) continue;
    const sp = SPECIES[spId];
    if (!sp || (sp.phase !== 'l' && sp.phase !== 'aq')) continue; // Retain 100% of solids (s) on filter paper
    const dMol = n * frac;
    funnel.moles[spId] = n - dMol;
    if (funnel.moles[spId] < 1e-13) delete funnel.moles[spId];
    if (target) {
      if (spId === 'Phenolphthalein_aq') movedPhen = dMol;
      target.moles[spId] = (target.moles[spId] || 0) + dMol;
      cMoved += dMol * Math.max(0, sp.cp || 0);
    }
  }

  if (target) {
    if (movedPhen > 0) {
      const totP = oldDstPhen + movedPhen;
      target.phenBleachFrac = totP > 1e-14 ? (oldDstPhen * oldDstBleach + movedPhen * (funnel.phenBleachFrac || 0)) / totP : 0;
    }
    if (cDstBefore + cMoved > 0) {
      target.tempK = (cDstBefore * target.tempK + cMoved * funnel.tempK) / (cDstBefore + cMoved);
    }
    sim.checkOverflow(target);
  }
}

/**
 * ISO 4800 Pear-Shaped Separatory / Dropping Funnel (100 mL):
 * - Dropping mode: feeds reagent dropwise or in a controlled stream into a mounted (open or sealed) host vessel or flask below.
 * - Extraction mode: computes stratified layers (organic_heavy / aqueous / organic_light), supports shaking & settling,
 *   and selectively drains the bottom-most dense phase cleanly, stopping automatically at the phase interface!
 */
function stepSeparatoryFunnel(sim, funnel, dt) {
  funnel.activeDrop = false;
  funnel.drainRateMlS = 0;
  funnel.drainTargetId = null;

  if ((funnel.emulsionTimer || 0) > 0) {
    funnel.emulsionTimer = Math.max(0, funnel.emulsionTimer - dt);
  }

  const sfSpec = APPARATUS.separatory_funnel;
  const solMl = computeSolidVolumeMl(funnel.moles);
  const strat = computePhaseStratification(funnel.moles, funnel.tempK, sfSpec, solMl);
  funnel.liquidStratification = strat;
  const totalLiqMl = strat.totalLiqMl || 0;
  funnel.activeLayerKey = strat.layers[0]?.phaseKey || null;

  if (totalLiqMl <= 0.002) {
    funnel.valveOpen = false;
    return;
  }
  if (!funnel.valveOpen) return;

  let target = null;
  if (funnel.mountedOnVesselId) {
    const m = sim.getItem(funnel.mountedOnVesselId);
    if (m && m.kind === 'vessel' && !m.isShattered && !m.isInverted) {
      target = m;
    } else {
      funnel.mountedOnVesselId = null;
    }
  }
  if (!target) {
    const tipY = funnel.y + (sfSpec?.height || 174) * 0.5 - 6;
    target = findOpenVesselBelowPoint(sim.items, funnel.x, tipY, 56, -8, 280);
  }

  const flowFrac = Math.max(0.05, Math.min(1.0, funnel.valveFlowFrac ?? 0.35));
  const rateMlS = flowFrac * 12.0; // 0.6 .. 12.0 mL/s controllable stopcock
  const isSettledMulti = strat.layers.length >= 2 && (funnel.emulsionTimer || 0) <= 0.2;
  const bottomLayer = isSettledMulti ? strat.layers[0] : null;
  const refVolMl = bottomLayer ? bottomLayer.volMl : totalLiqMl;
  const moveMl = Math.min(refVolMl, rateMlS * dt);
  if (moveMl <= 1e-6) return;
  const frac = Math.min(1, moveMl / Math.max(1e-6, refVolMl));

  funnel.activeDrop = true;
  funnel.drainRateMlS = rateMlS;
  funnel.drainTargetId = target ? target.id : null;
  funnel.dispensedMl = (funnel.dispensedMl || 0) + moveMl;

  // Color of draining bottom phase or bulk solution
  const matchesTargetPhase = (sp) => {
    if (!sp || (sp.phase !== 'l' && sp.phase !== 'aq')) return false;
    if (!bottomLayer) return true;
    if (bottomLayer.phaseKey === 'organic_heavy') return sp.phase === 'l' && sp.liquidGroup === 'organic_heavy';
    if (bottomLayer.phaseKey === 'organic_light') return sp.phase === 'l' && sp.liquidGroup === 'organic_light';
    return sp.phase === 'aq' || (sp.phase === 'l' && (sp.liquidGroup || 'aqueous') === 'aqueous');
  };

  const layerMoles = {};
  for (const [id, n] of Object.entries(funnel.moles)) {
    if (n > 0 && matchesTargetPhase(SPECIES[id])) layerMoles[id] = n;
  }
  const layerL = Math.max(1e-5, refVolMl / 1000);
  funnel.drainColor = computeSolutionVisuals(
    layerMoles,
    layerL,
    computePH(layerMoles, layerL, funnel.tempK),
    2.5,
    funnel.phenBleachFrac || 0,
    funnel.phenIrrevFrac || 0
  ).css;

  const cDstBefore = target ? computeHeatCapacityJK(target) : 0;
  const oldDstPhen = target ? target.moles.Phenolphthalein_aq || 0 : 0;
  const oldDstBleach = target ? target.phenBleachFrac || 0 : 0;
  let movedPhen = 0;
  let cMoved = 0;

  for (const [spId, n] of Object.entries(funnel.moles)) {
    if (n <= 0 || !matchesTargetPhase(SPECIES[spId])) continue;
    const dMol = n * frac;
    funnel.moles[spId] = n - dMol;
    if (funnel.moles[spId] < 1e-13) delete funnel.moles[spId];
    if (target) {
      if (spId === 'Phenolphthalein_aq') movedPhen = dMol;
      target.moles[spId] = (target.moles[spId] || 0) + dMol;
      cMoved += dMol * Math.max(0, SPECIES[spId]?.cp || 0);
    }
  }

  if (target) {
    if (movedPhen > 0) {
      const totP = oldDstPhen + movedPhen;
      target.phenBleachFrac = totP > 1e-14 ? (oldDstPhen * oldDstBleach + movedPhen * (funnel.phenBleachFrac || 0)) / totP : 0;
    }
    if (cDstBefore + cMoved > 0) {
      target.tempK = (cDstBefore * target.tempK + cMoved * funnel.tempK) / (cDstBefore + cMoved);
    }
    sim.checkOverflow(target);
  }

  // Recompute remaining layers and auto-close cleanly right at phase interface!
  if (bottomLayer && funnel.stopAtInterface !== false) {
    const remStrat = computePhaseStratification(funnel.moles, funnel.tempK, sfSpec, solMl);
    const sameBottomRemain = remStrat.layers.find((l) => l.phaseKey === bottomLayer.phaseKey)?.volMl || 0;
    if (sameBottomRemain <= 0.06) {
      funnel.valveOpen = false;
      funnel.liquidStratification = remStrat;
      funnel.activeLayerKey = remStrat.layers[0]?.phaseKey || null;
      if (!funnel._lastInterfaceLogged || Math.abs(sim.timeSec - funnel._lastInterfaceLogged) > 1.2) {
        funnel._lastInterfaceLogged = sim.timeSec;
        sim.addLog({
          type: 'info',
          key: 'logSepFunnelInterface',
          vesselLabel: funnel.label,
        });
      }
    }
  }
}

/**
 * Burette stopcock drip / continuous stream strictly vertically along burette.x into vessel underneath.
 */
function stepBurette(sim, burette, dt) {
  burette.activeTargetId = null;
  burette.streamingNow = false;

  const rate = burette.valveRateMlS || 0;
  const liqL = computeLiquidVolumeL(burette.moles, burette.tempK);
  const liqMl = liqL * 1000;
  if (rate <= 0 || liqMl <= 0.002) {
    if (liqMl <= 0.002 && rate > 0) burette.valveRateMlS = 0;
    return;
  }

  const tipY = burette.y + (APPARATUS.burette_50?.height || 204) / 2;
  const target = findOpenVesselBelowPoint(sim.items, burette.x, tipY - 12, 54, -8, 320);
  // Also allow dripping into a filter funnel positioned below burette
  let dropTarget = target;
  if (!dropTarget) {
    dropTarget = sim.items.find(
      (i) => i.kind === 'filter_funnel' && !i.isBroken && Math.abs(i.x - burette.x) <= 34 && i.y > burette.y + 40
    );
  }

  const dispenseMl = Math.min(liqMl, rate * dt);
  if (dispenseMl <= 1e-6) return;
  const frac = Math.min(1, dispenseMl / Math.max(1e-6, liqMl));

  burette.streamingNow = true;
  burette.dispensedMl = (burette.dispensedMl || 0) + dispenseMl;
  burette.activeTargetId = dropTarget ? dropTarget.id : null;
  burette.streamColor = computeSolutionVisuals(
    burette.moles,
    liqL,
    computePH(burette.moles, liqL, burette.tempK),
    2.0,
    burette.phenBleachFrac || 0
  ).css;

  const cDst = dropTarget ? computeHeatCapacityJK(dropTarget) : 0;
  let cMoved = 0;

  for (const [spId, n] of Object.entries(burette.moles)) {
    if (n <= 0) continue;
    const sp = SPECIES[spId];
    if (!sp || (sp.phase !== 'l' && sp.phase !== 'aq')) continue;
    const dMol = n * frac;
    burette.moles[spId] = n - dMol;
    if (burette.moles[spId] < 1e-13) delete burette.moles[spId];
    if (dropTarget) {
      dropTarget.moles[spId] = (dropTarget.moles[spId] || 0) + dMol;
      cMoved += dMol * Math.max(0, sp.cp || 0);
    }
  }

  if (dropTarget && cDst + cMoved > 0) {
    dropTarget.tempK = (cDst * dropTarget.tempK + cMoved * burette.tempK) / (cDst + cMoved);
  }
}

/**
 * Liebig Condenser: chills vapor delivered from a connected boiling vessel and drips distillate from distal tip.
 */
function stepLiebigCondenser(sim, cond, dt) {
  cond.distillRateMlS = 0;
  cond.activeDrop = false;
  const vapor = cond.vaporInMoles;
  if (!vapor) return;

  let totalInMol = 0;
  for (const n of Object.values(vapor)) totalInMol += n;
  if (totalInMol <= 1e-9) return;

  const tJacketK = cond.waterFlowOn ? 286.15 : 333.15;
  const { spout } = getCondenserPorts(cond);
  const spoutX = spout.x;
  const spoutY = spout.y;
  let gasDst = null;
  if (cond.outletTargetId) {
    const oDst = sim.getItem(cond.outletTargetId);
    if (oDst && oDst.kind === 'vessel' && !oDst.isShattered) {
      gasDst = oDst;
    } else if (!oDst || oDst.isShattered) {
      cond.outletTargetId = null;
    }
  }

  let refluxDst = null;
  if (cond.refluxMode) {
    const rId = cond.refluxVesselId || cond.connectedFromId;
    const rV = rId ? sim.getItem(rId) : null;
    if (rV && rV.kind === 'vessel' && !rV.isShattered) {
      refluxDst = rV;
    }
  }
  let liqDst = refluxDst || gasDst;
  if (!liqDst && !cond.refluxMode) {
    liqDst = findOpenVesselBelowPoint(sim.items, spoutX, spoutY - 8, 58, 0, 320);
  }
  const gasOutDst = cond.refluxMode ? gasDst : gasDst || liqDst;

  // Data-driven generalized condensation across all condensable vapors (SPECIES[g].liquidSpeciesId)
  const condensedLiqs = {};
  const remNonSteam = createZeroGasMap();
  let remSteam = 0;
  let dCondMl = 0;
  let cCondAdd = 0;
  const tCond = cond.waterFlowOn ? 290.15 : 335.0;

  for (const [gId, nIn] of Object.entries(vapor)) {
    if (!Number.isFinite(nIn) || nIn <= 1e-12) continue;
    if (gId === 'HCl_g' || gId === 'NH3_g' || gId === 'HBr_g' || gId === 'HI_g') continue;
    const spVap = SPECIES[gId];
    const liqId = spVap?.liquidSpeciesId;
    const spLiq = liqId ? SPECIES[liqId] : null;
    if (spVap?.isCondensableVapor && spLiq) {
      const bpK = spLiq.boilTempK || 373.15;
      let eff = 0;
      if (cond.waterFlowOn) {
        eff = bpK > tJacketK ? (bpK - tJacketK >= 15 ? 0.96 : 0.72 + 0.016 * (bpK - tJacketK)) : 0.12;
      } else {
        eff = bpK > tJacketK + 8 ? 0.28 : 0.04;
      }
      const dCond = nIn * Math.max(0, Math.min(0.98, eff));
      const dRem = Math.max(0, nIn - dCond);
      if (dCond > 1e-12) {
        condensedLiqs[liqId] = (condensedLiqs[liqId] || 0) + dCond;
        const dens = Math.max(0.4, spLiq.density || 0.997);
        dCondMl += (dCond * (spLiq.molarMass || 50)) / dens;
        cCondAdd += dCond * (spLiq.cp || 90);
      }
      if (dRem > 1e-12) {
        if (gId === 'H2O_g') remSteam += dRem;
        else remNonSteam[gId] = (remNonSteam[gId] || 0) + dRem;
      }
    } else if (gId === 'H2O_g') {
      remSteam += nIn;
    } else {
      remNonSteam[gId] = (remNonSteam[gId] || 0) + nIn;
    }
  }

  // Acid/Base volatile gases (HCl, HBr, HI, NH3) absorb into chilled co-condensing water droplets
  const condW = condensedLiqs.H2O_l || 0;
  const effSol = cond.waterFlowOn ? 0.94 : 0.22;
  const nHCl = vapor.HCl_g || 0;
  const nHBr = vapor.HBr_g || 0;
  const nHI = vapor.HI_g || 0;
  const nNH3 = vapor.NH3_g || 0;
  const absHCl = condW > 1e-8 ? Math.min(nHCl, condW * 0.45, nHCl * effSol) : 0;
  const absHBr = condW > 1e-8 ? Math.min(nHBr, condW * 0.45, nHBr * effSol) : 0;
  const absHI = condW > 1e-8 ? Math.min(nHI, condW * 0.45, nHI * effSol) : 0;
  const absNH3 = condW > 1e-8 ? Math.min(nNH3, condW * 0.55, nNH3 * effSol) : 0;
  remNonSteam.HCl_g = Math.max(0, nHCl - absHCl);
  remNonSteam.HBr_g = Math.max(0, nHBr - absHBr);
  remNonSteam.HI_g = Math.max(0, nHI - absHI);
  remNonSteam.NH3_g = Math.max(0, nNH3 - absNH3);

  // If co-condensing HNO3 with H2O, dissociate cleanly to aqueous H+ + NO3-; when anhydrous/dry keep HNO3_l
  const condHNO3 = condensedLiqs.HNO3_l || 0;
  let absHNO3Aq = 0;
  if (condHNO3 > 0 && condW > 1e-7) {
    absHNO3Aq = condHNO3;
    delete condensedLiqs.HNO3_l;
  }

  if (dCondMl > 1e-9) {
    cond.distillRateMlS = dCondMl / Math.max(1e-4, dt);
    cond.totalCondensedMl = (cond.totalCondensedMl || 0) + dCondMl;
    cond.activeDrop = true;
    const condVolL = Math.max(1e-6, dCondMl / 1000);
    cond.lastCondColor = computeSolutionVisuals(
      condensedLiqs,
      condVolL,
      absHCl + absHBr + absHI + absHNO3Aq > 0 ? 1.5 : absNH3 > 0 ? 11.0 : 7.0,
      1.8,
      0,
      0
    ).css;

    if (liqDst) {
      const cOld = computeHeatCapacityJK(liqDst);
      for (const [liqId, nC] of Object.entries(condensedLiqs)) {
        if (nC > 0) liqDst.moles[liqId] = (liqDst.moles[liqId] || 0) + nC;
      }
      if (absHCl > 0) {
        liqDst.moles.H_aq = (liqDst.moles.H_aq || 0) + absHCl;
        liqDst.moles.Cl_aq = (liqDst.moles.Cl_aq || 0) + absHCl;
      }
      if (absHBr > 0) {
        liqDst.moles.H_aq = (liqDst.moles.H_aq || 0) + absHBr;
        liqDst.moles.Br_aq = (liqDst.moles.Br_aq || 0) + absHBr;
      }
      if (absHI > 0) {
        liqDst.moles.H_aq = (liqDst.moles.H_aq || 0) + absHI;
        liqDst.moles.I_aq = (liqDst.moles.I_aq || 0) + absHI;
      }
      if (absHNO3Aq > 0) {
        liqDst.moles.H_aq = (liqDst.moles.H_aq || 0) + absHNO3Aq;
        liqDst.moles.NO3_aq = (liqDst.moles.NO3_aq || 0) + absHNO3Aq;
      }
      if (absNH3 > 0) {
        liqDst.moles.NH3_aq = (liqDst.moles.NH3_aq || 0) + absNH3;
      }
      if (cOld + cCondAdd > 0 && !cond.refluxMode) {
        liqDst.tempK = (cOld * liqDst.tempK + cCondAdd * tCond) / (cOld + cCondAdd);
      }
    }
  }

  // Route remaining non-condensable permanent gases (C2H4, C4H6, H2, CO2, etc.) & uncondensed vapors out top/outlet port!
  let outTot = remSteam;
  const outComp = [];
  for (const g of NON_STEAM_GASES) {
    const amt = remNonSteam[g] || 0;
    if (amt > 1e-12) {
      outTot += amt;
      outComp.push({ id: g, formula: SPECIES[g]?.formula || g, mol: amt });
    }
  }
  if (remSteam > 1e-12) {
    outComp.push({ id: 'H2O_g', formula: 'H₂O(g)', mol: remSteam });
  }
  if (outTot > 1e-10) {
    const tOutK = cond.waterFlowOn ? 293.15 : 345.0;
    outComp.sort((a, b) => b.mol - a.mol);
    const volMlS = (((outTot * CONSTANTS.R_L_BAR_MOL_K * tOutK) / Math.max(0.2, sim.environment?.pressureBar || 1.0)) * 1000) / Math.max(1e-4, dt);
    cond._liveTubeFlow = {
      composition: outComp.slice(0, 3).map((c) => ({ ...c, pct: Math.round((c.mol / outTot) * 100) })),
      rateMlS: Number.isFinite(volMlS) ? volMlS : 0,
      totalMlS: Number.isFinite(volMlS) ? volMlS : 0,
      tempC: tOutK - 273.15,
      updatedAt: Date.now(),
    };
    if (gasOutDst) {
      routeGasPacketToTarget(cond, gasOutDst, remNonSteam, remSteam, sim.environment, (id) => sim.getItem(id));
    } else if (cond.refluxMode) {
      // Uncondensed/permanent gases vent harmlessly from top of reflux condenser into room air
      const srcV = refluxDst || (cond.connectedFromId ? sim.getItem(cond.connectedFromId) : null);
      if (srcV && srcV.escapedGasMoles) {
        for (const g of NON_STEAM_GASES) {
          if (remNonSteam[g] > 1e-12) srcV.escapedGasMoles[g] = (srcV.escapedGasMoles[g] || 0) + remNonSteam[g];
        }
        if (remSteam > 1e-12) srcV.escapedGasMoles.H2O_g = (srcV.escapedGasMoles.H2O_g || 0) + remSteam;
      }
    }
  } else if (cond._liveTubeFlow && Date.now() - cond._liveTubeFlow.updatedAt > 350) {
    cond._liveTubeFlow = null;
  }

  // Clear per-step vapor buffer
  cond.vaporInMoles = createZeroGasMap();
}

/**
 * Pneumatic Water Bath displacement: inverted tubes sitting in any open liquid bath (water trough OR electrolyte beaker)
 * trap rising / tubed gas & seal mouth against air escape.
 */
function stepPneumaticTrough(sim) {
  const baths = sim.items.filter(
    (i) =>
      i.kind === 'vessel' &&
      !i.isShattered &&
      !i.isInverted &&
      !i.isStoppered &&
      !APPARATUS[i.typeId]?.isMortar &&
      (i.moles?.H2O_l || 0) > 0.25
  );
  for (const v of sim.items) {
    if (v.kind !== 'vessel' || v.isShattered || !v.isInverted) {
      if (v.kind === 'vessel') v.submergedInTroughId = null;
      continue;
    }
    const spec = APPARATUS[v.typeId];
    const mouthY = v.y + spec.height / 2;
    let matchedBath = null;
    for (const tr of baths) {
      if (tr.id === v.id) continue;
      const trSpec = APPARATUS[tr.typeId];
      const trTop = tr.y - trSpec.height / 2;
      const trBot = tr.y + trSpec.height / 2;
      const maxXSpan = Math.max(40, trSpec.width * 0.48);
      if (Math.abs(v.x - tr.x) <= maxXSpan && mouthY >= trTop - 16 && mouthY <= trBot + 10) {
        matchedBath = tr;
        if (tr.typeId === 'water_trough') break;
      }
    }
    v.submergedInTroughId = matchedBath ? matchedBath.id : null;
  }
}

/**
 * Test open/inverted vessel gas, active electrolysis electrode plume, or burner with Wooden Splint.
 */
export function checkSplintInteractions(sim, splint) {
  if (!splint || splint.kind !== 'splint') return null;
  const { x: tipX, y: tipY } = getProbeTipPos(splint);

  // 1. Auto-light splint near lit Alcohol Burner
  for (const b of sim.items) {
    if (b.kind !== 'burner' || (b.powerW || 0) <= 10) continue;
    const flameY = b.y - APPARATUS.burner.height / 2 - 14;
    if (Math.hypot(tipX - b.x, tipY - flameY) <= 44) {
      if (splint.mode !== 'burning') {
        splint.mode = 'burning';
      }
    }
  }

  if (splint.mode === 'unlit') return null;
  if ((splint.cooldownTimer || 0) > 0) return null;

  // 1b. Direct electrolysis gas plumes rising off immersed Cathode (-) / Anode (+) electrodes!
  for (const el of sim.items) {
    if (el.kind !== 'electrode' || !el.dockedVesselId || !el.gasBubbleType) continue;
    const rate = el.gasBubbleRate || 0;
    if (rate <= 1.2e-7 && (el.recentGasMol || 0) <= 3e-7) continue;
    const parent = sim.getItem(el.dockedVesselId);
    if (!parent || parent.isShattered || parent.isStoppered) continue;
    const pSpec = APPARATUS[parent.typeId];
    const pTop = parent.y - pSpec.height / 2;
    if (Math.abs(tipX - el.x) > 38 || tipY < pTop - 52 || tipY > el.y + 34) continue;

    if (el.gasBubbleType === 'H2_g' && splint.mode === 'burning') {
      splint.cooldownTimer = 1.6;
      splint.lastTestEvent = 'h2_pop';
      splint.lastEventTimer = 1.6;
      sim.addLog({
        type: 'reaction',
        equation: '2H₂(g) + O₂(g) —(tia lửa điện cực)→ 2H₂O(g) ("Póc!")',
        nameVi: 'Thử khí Cathode H₂(g): Que đóm cháy nổ tiếng "Póc!"',
        nameEn: 'Splint Test (Cathode H₂): Sharp hydrogen "Pop!" bark',
        descVi: 'Luồng khí Hydrogen sinh ra tại cực âm (Cathode) bùng cháy nổ tiếng "póc" đặc trưng khi đưa que đóm đang cháy vào.',
        descEn: 'Evolving cathodic H₂(g) ignites with air forming a crisp "Pop!" bark at the lit splint.',
        vesselLabel: `${splint.label} → ${el.label} (${parent.label})`,
      });
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('h2_pop', { x: tipX, y: tipY }, { vesselId: parent.id, electrodeId: el.id });
      }
      return 'h2_pop';
    }
    if (el.gasBubbleType === 'O2_g') {
      const wasGlowing = splint.mode === 'glowing';
      splint.mode = 'burning';
      splint.cooldownTimer = 1.6;
      splint.o2FlareTimer = wasGlowing ? 0.7 : 2.0;
      splint.lastTestEvent = wasGlowing ? 'o2_relight' : 'o2_flare';
      splint.lastEventTimer = 1.8;
      sim.addLog({
        type: 'reaction',
        equation: wasGlowing ? 'C(tàn đóm) + O₂(g) → CO₂(g) (Bùng cháy)' : 'C(que đang cháy) + O₂(g) → CO₂(g) + hν (Cháy rực!)',
        nameVi: wasGlowing ? 'Thử khí Anode O₂(g): Tàn đóm bùng cháy' : 'Que đóm cháy rực sáng hơn trong luồng O₂(g) Anode',
        nameEn: wasGlowing ? 'Splint Test (Anode O₂): Glowing ember relights!' : 'Burning splint flares brightly in anodic O₂(g)!',
        descVi: 'Luồng khí Oxygen tinh khiết thoát ra ở cực dương (Anode) làm tàn đóm đỏ bùng cháy lại / ngọn lửa cháy sáng chói.',
        descEn: 'Anodic O₂(g) enriches combustion, relighting a glowing ember or flaring a lit splint.',
        vesselLabel: `${splint.label} → ${el.label} (${parent.label})`,
      });
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert(splint.lastTestEvent, { x: tipX, y: tipY }, { vesselId: parent.id, electrodeId: el.id });
      }
      return splint.lastTestEvent;
    }
    if (el.gasBubbleType === 'Cl2_g') {
      splint.mode = 'unlit';
      splint.cooldownTimer = 1.6;
      splint.o2FlareTimer = 0;
      splint.lastTestEvent = null;
      sim.addLog({
        type: 'reaction',
        equation: 'Cl₂(g) đậm đặc → Tắt ngọn lửa que đóm',
        nameVi: 'Thử khí Anode Cl₂(g): Không duy trì sự cháy, tắt que đóm',
        nameEn: 'Splint Test (Anode Cl₂): Dense Cl₂(g) extinguishes flame',
        descVi: 'Khí Chlorine thoát ra tại Anode nặng hơn không khí và làm ngạt tắt ngọn lửa gỗ.',
        descEn: 'Dense Cl₂(g) evolving from the anode displaces air and extinguishes the burning wood splint.',
        vesselLabel: `${splint.label} → ${el.label} (${parent.label})`,
      });
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('cl2_extinguish', { x: tipX, y: tipY }, { vesselId: parent.id, electrodeId: el.id });
      }
      return 'cl2_extinguish';
    }
  }

  for (const v of sim.items) {
    if (v.kind !== 'vessel' || v.isShattered || v.isStoppered) continue;
    const spec = APPARATUS[v.typeId];
    const testY = v.isInverted ? v.y + spec.height / 2 : v.y - spec.height / 2;
    const dist = Math.hypot(tipX - v.x, tipY - testY);
    if (dist > 62) continue;

    const headH2 = v.headspaceGasMoles?.H2_g || 0;
    const headO2 = v.headspaceGasMoles?.O2_g || 0;
    const rateH2 = v.lastGasRateMap?.H2_g || 0;
    const rateO2 = v.lastGasRateMap?.O2_g || 0;
    const hasH2 = headH2 > 4e-5 || rateH2 > 2e-6;
    const hasO2 = headO2 > 4e-5 || rateO2 > 1.5e-6;

    // Phenomenon #6: Burning splint + mixed Oxyhydrogen (2H2 : 1O2) scaled detonation OR lean H2 "Pop!" test
    if (splint.mode === 'burning' && hasH2) {
      splint.cooldownTimer = 1.6;
      const nDetO2 = Math.min(headH2 / 2, headO2);

      if (nDetO2 >= 4e-5) {
        // Scaled Oxyhydrogen 2H2 + O2 -> 2H2O detonation! (483.6 kJ per mol O2)
        const dO2Burn = Math.min(headO2, nDetO2);
        const dH2Burn = Math.min(headH2, 2 * dO2Burn);
        const detEnergyJ = dO2Burn * 483600;
        const blastScale = Math.max(0.7, Math.min(3.2, Math.sqrt(detEnergyJ / 90)));

        v.headspaceGasMoles.H2_g = Math.max(0, headH2 - dH2Burn);
        v.headspaceGasMoles.O2_g = Math.max(0, headO2 - dO2Burn);
        if (v.headspaceGasMoles.H2_g < 1e-10) v.headspaceGasMoles.H2_g = 0;
        if (v.headspaceGasMoles.O2_g < 1e-10) v.headspaceGasMoles.O2_g = 0;
        // Trace moisture droplet film formed inside detonated tube
        v.moles.H2O_l = (v.moles.H2O_l || 0) + dH2Burn;

        splint.lastTestEvent = 'oxyhydrogen_detonation';
        splint.lastEventTimer = 2.0;
        sim.addLog({
          type: 'reaction',
          equation: `2H₂(g) + O₂(g) → 2H₂O(g) (Nổ Oxyhydrogen · ~${detEnergyJ.toFixed(0)} J)`,
          nameVi: `Nổ hỗn hợp khí nổ Oxyhydrogen 2H₂:O₂ (Năng lượng ~${detEnergyJ.toFixed(0)} J)`,
          nameEn: `Oxyhydrogen 2H₂:O₂ Detonation (~${detEnergyJ.toFixed(0)} J shockwave)`,
          descVi: 'Tỉ lệ H₂ + O₂ trộn sẵn bùng nổ dữ dội kèm sóng xung kích tỉ lệ với lượng khí tích trữ.',
          descEn: 'Premixed H₂ + O₂ detonates instantaneously with shockwave energy proportional to trapped stoichiometric moles.',
          vesselLabel: `${splint.label} → ${v.label}`,
        });
        if (detEnergyJ >= 1650 && v.typeId === 'test_tube_50' && !v.submergedInTroughId) {
          sim.shatterVessel(v, 'alertOxyhydrogenDetonation', 'explosion');
        } else if (sim.visualHooks.onAlert) {
          sim.visualHooks.onAlert('oxyhydrogen_detonation', { x: tipX, y: tipY }, {
            vesselId: v.id,
            blastScale,
            detEnergyJ,
          });
        }
        return 'oxyhydrogen_detonation';
      }

      splint.lastTestEvent = 'h2_pop';
      splint.lastEventTimer = 1.6;
      if (headH2 > 0) {
        const burnH2 = Math.min(headH2, 0.004);
        v.headspaceGasMoles.H2_g = Math.max(0, headH2 - burnH2);
      }
      sim.addLog({
        type: 'reaction',
        equation: '2H₂(g) + O₂(g) —(tia lửa)→ 2H₂O(g) ("Póc!")',
        nameVi: 'Thử khí Hydrogen: Que đóm cháy nổ tiếng "Póc!" nhẹ',
        nameEn: 'Splint Test: Hydrogen burns with characteristic "Pop!" bark',
        descVi: 'Que đóm đang cháy gặp H₂(g) trộn không khí bùng nổ tiếng "póc" nhẹ kèm ngọn lửa xanh nhạt.',
        descEn: 'A lit wooden splint ignites collected H₂(g) in air with a sharp "Pop!" sound.',
        vesselLabel: `${splint.label} → ${v.label}`,
      });
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('h2_pop', { x: tipX, y: tipY }, { vesselId: v.id });
      }
      return 'h2_pop';
    }

    // Glowing ember splint + O2 -> Relights softly into steady burning flame; Burning splint + O2 -> Intense blazing flare!
    if (splint.mode === 'glowing' && hasO2) {
      splint.mode = 'burning';
      splint.cooldownTimer = 1.6;
      splint.o2FlareTimer = 0.6;
      splint.lastTestEvent = 'o2_relight';
      splint.lastEventTimer = 1.6;
      sim.addLog({
        type: 'reaction',
        equation: 'C(tàn đóm) + O₂(g) dư → CO₂(g) (Bùng cháy)',
        nameVi: 'Thử khí Oxygen: Tàn đóm đỏ bùng cháy thành ngọn lửa',
        nameEn: 'Splint Test: Glowing splint relights into flame in O₂(g)',
        descVi: 'Môi trường giàu O₂(g) làm tàn đóm đỏ lập tức bùng cháy lại.',
        descEn: 'Elevated O₂(g) immediately relights a glowing ember into steady flame.',
        vesselLabel: `${splint.label} → ${v.label}`,
      });
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('o2_relight', { x: tipX, y: tipY }, { vesselId: v.id });
      }
      return 'o2_relight';
    }

    if (splint.mode === 'burning' && hasO2 && !hasH2) {
      splint.cooldownTimer = 1.6;
      splint.o2FlareTimer = 2.0;
      splint.lastTestEvent = 'o2_flare';
      splint.lastEventTimer = 1.8;
      sim.addLog({
        type: 'reaction',
        equation: 'C(que đang cháy) + O₂(g) đặc → CO₂(g) + hν (Cháy sáng chói!)',
        nameVi: 'Que đóm đang cháy gặp Oxygen: Ngọn lửa bùng to sáng chói',
        nameEn: 'Burning splint flares violently brighter in pure O₂(g)',
        descVi: 'Ngọn lửa đang cháy được cung cấp O₂(g) nguyên chất nên tốc độ oxi hóa tăng vọt, bùng cháy to và sáng chói.',
        descEn: 'An already burning splint accelerates dramatically in high-O₂ gas, flaring intensely bright and tall.',
        vesselLabel: `${splint.label} → ${v.label}`,
      });
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('o2_flare', { x: tipX, y: tipY }, { vesselId: v.id });
      }
      return 'o2_flare';
    }

    // CO2(g) extinguishes both burning flame and glowing ember!
    const headCO2 = v.headspaceGasMoles?.CO2_g || 0;
    const rateCO2 = v.lastGasRateMap?.CO2_g || 0;
    if ((headCO2 > 6e-5 || rateCO2 > 2e-5) && !hasO2 && !hasH2) {
      splint.mode = 'unlit';
      splint.cooldownTimer = 1.6;
      splint.o2FlareTimer = 0;
      splint.lastTestEvent = 'co2_extinguish';
      splint.lastEventTimer = 1.6;
      sim.addLog({
        type: 'reaction',
        equation: 'CO₂(g) → Không duy trì sự cháy, tắt ngọn lửa que đóm',
        nameVi: 'Thử khí CO₂(g): Tắt ngọn lửa que đóm đang cháy',
        nameEn: 'Splint Test: Dense CO₂(g) extinguishes burning splint',
        descVi: 'Khí Carbon dioxide (M = 44 > 29) nặng hơn không khí và không duy trì sự cháy làm tắt que đóm ngay.',
        descEn: 'Carbon dioxide (M = 44 > 29) displaces O₂ and does not support combustion, extinguishing the splint.',
        vesselLabel: `${splint.label} → ${v.label}`,
      });
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('co2_extinguish', { x: tipX, y: tipY }, { vesselId: v.id });
      }
      return 'co2_extinguish';
    }

    // Ignition source over exposed Sodium or Potassium
    if (((v.moles.Na_s || 0) > 1e-7 || (v.moles.K_s || 0) > 1e-7) && dist <= 52) {
      if ((v.moles.Na_s || 0) > 1e-7) v.naTempK = Math.max(v.naTempK ?? v.tempK, 720);
      if ((v.moles.K_s || 0) > 1e-7) v.kTempK = Math.max(v.kTempK ?? v.tempK, 620);
      splint.cooldownTimer = 1.2;
      return 'ignite_na';
    }
  }
  return null;
}

/**
 * Sample ion onto Flame Test Loop from wet vessels & colorize burner flame plume on contact.
 */
export function checkFlameLoopInteractions(sim, loop) {
  if (!loop || loop.kind !== 'flame_loop') return;
  const { x: tipX, y: tipY } = getProbeTipPos(loop);

  // 1. Sample from vessel or deflagrating spoon interior/liquid
  for (const v of sim.items) {
    if ((v.kind !== 'vessel' && v.kind !== 'spoon') || v.isShattered) continue;
    const spec = APPARATUS[v.typeId];
    const inSpoonBowl =
      v.kind === 'spoon' && Math.hypot(tipX - (v.x + (v.flippedX ? 48 : -48)), tipY - (v.y + 4)) <= 26;
    const inVessel =
      v.kind === 'vessel' &&
      Math.abs(tipX - v.x) <= spec.width * 0.48 &&
      Math.abs(tipY - v.y) <= spec.height * 0.52;
    if (inVessel || inSpoonBowl) {
      if (v.kind === 'vessel' && v.isSupersaturated) {
        v.crystallizeTriggered = true;
      }
      const m = v.moles || {};
      const hasNa =
        (m.Na_aq || 0) + (m.Na_s || 0) + (m.NaOH_s || 0) + (m.NaCl_s || 0) +
        (m.Na2CO3_s || 0) + (m.NaHCO3_s || 0) + (m.Na2SO4_s || 0) + (m.NaNO3_s || 0) +
        (m.Na2O_s || 0) + (m.Na2O2_s || 0) + (m.NaBr_s || 0) + (m.NaBrO3_s || 0) +
        (m.NaI_s || 0) + (m.NaIO3_s || 0) + (m.NaClO3_s || 0) > 1e-6;
      const hasCa =
        (m.Ca2_aq || 0) + (m.CaCl2_s || 0) + (m.CaBr2_s || 0) + (m.CaI2_s || 0) +
        (m.CaNO3_2_s || 0) + (m.CaCO3_s || 0) + (m.CaO_s || 0) + (m.CaOH2_s || 0) +
        (m.CaSO4_s || 0) > 1e-6;
      const hasBa =
        (m.Ba2_aq || 0) + (m.BaCl2_2H2O_s || 0) + (m.BaCl2_s || 0) + (m.BaBr2_s || 0) +
        (m.BaI2_s || 0) + (m.BaNO3_2_s || 0) + (m.BaOH2_s || 0) + (m.BaCO3_s || 0) +
        (m.BaSO4_s || 0) > 1e-6;
      const hasCu =
        (m.Cu2_aq || 0) + (m.CuCl4_2_aq || 0) + (m.CuNH3_4_2_aq || 0) + (m.CuOH4_2_aq || 0) +
        (m.CuSO4_5H2O_s || 0) + (m.CuSO4_s || 0) + (m.CuCl2_s || 0) + (m.CuBr2_s || 0) +
        (m.CuI_s || 0) + (m.CuNO3_2_s || 0) + (m.CuCO3_s || 0) + (m.CuO_s || 0) +
        (m.CuOH2_s || 0) > 1e-6;
      const hasFe =
        (m.Fe2_aq || 0) + (m.Fe3_aq || 0) + (m.FeCl2_s || 0) + (m.FeCl3_s || 0) +
        (m.FeBr2_s || 0) + (m.FeBr3_s || 0) + (m.FeI2_s || 0) + (m.FeSO4_s || 0) +
        (m.FeNO3_2_s || 0) + (m.FeNO3_3_s || 0) > 1e-6;
      const hasK =
        (m.K_aq || 0) + (m.K_s || 0) + (m.KOH_s || 0) + (m.KCl_s || 0) +
        (m.KBr_s || 0) + (m.KBrO3_s || 0) + (m.KI_s || 0) + (m.KIO3_s || 0) + (m.KClO3_s || 0) +
        (m.KNO3_s || 0) + (m.K2SO4_s || 0) + (m.K2CO3_s || 0) + (m.KHCO3_s || 0) +
        (m.KHSO4_s || 0) + (m.KO2_s || 0) + (m.K2O_s || 0) + (m.KMnO4_s || 0) + (m.K2MnO4_s || 0) > 1e-6;
      if (hasNa) {
        // Exp 17: 589 nm Na D-doublet quantum emission overwhelms & masks weaker Cu2+ / Ca2+ / Ba2+ / K+ bands
        loop.sampledIon = 'Na⁺';
        loop.sampledColor = '#facc15';
        const maskedList = [];
        if (hasK) maskedList.push('K⁺');
        if (hasCa) maskedList.push('Ca²⁺');
        if (hasBa) maskedList.push('Ba²⁺');
        if (hasCu) maskedList.push('Cu²⁺');
        const maskedLabel = maskedList.length > 0 ? `Na⁺ (che ${maskedList.join(', ')})` : 'Na⁺';
        loop.sampleLabel = maskedLabel;
        loop.maskedCuByNa = maskedList.length > 0;
        loop.maskedTargetName = maskedList[0] || 'Cu²⁺';
      } else if (hasK) {
        loop.sampledIon = 'K⁺';
        loop.sampledColor = '#c084fc';
        loop.sampleLabel = 'K⁺ (Tím hoa cà · 766 nm)';
        loop.maskedCuByNa = false;
      } else if (hasBa) {
        loop.sampledIon = 'Ba²⁺';
        loop.sampledColor = '#84cc16';
        loop.sampleLabel = 'Ba²⁺ (Vàng lục · 524 nm)';
        loop.maskedCuByNa = false;
      } else if (hasCa) {
        loop.sampledIon = 'Ca²⁺';
        loop.sampledColor = '#ef4444';
        loop.sampleLabel = 'Ca²⁺ (Đỏ gạch · 622 nm)';
        loop.maskedCuByNa = false;
      } else if (hasCu) {
        loop.sampledIon = 'Cu²⁺';
        loop.sampledColor = '#10b981';
        loop.sampleLabel = 'Cu²⁺ (Xanh lục · 515 nm)';
        loop.maskedCuByNa = false;
      } else if (hasFe) {
        loop.sampledIon = 'Fe²⁺/Fe³⁺';
        loop.sampledColor = '#f59e0b';
        loop.sampleLabel = 'Fe (Vàng cam ánh sao)';
        loop.maskedCuByNa = false;
      }
    }
  }

  // 2. Apply emission spectrum onto lit Alcohol / Bunsen Burner when loop tip enters flame
  if (loop.sampledIon) {
    for (const b of sim.items) {
      if (b.kind !== 'burner' || (b.powerW || 0) <= 10) continue;
      const bSpec = APPARATUS[b.typeId] || APPARATUS.burner;
      const flameY =
        b.typeId === 'bunsen_burner'
          ? b.y + bSpec.height / 2 - 86
          : b.y - bSpec.height / 2 - 16;
      const hitR = b.typeId === 'bunsen_burner' ? 54 : 46;
      if (Math.hypot(tipX - b.x, tipY - flameY) <= hitR) {
        b.flameTestTimer = 1.8;
        b.flameTestColor = loop.sampledColor;
        b.flameTestIon = loop.sampledIon;
        if ((loop.logCooldown || 0) <= 0) {
          loop.logCooldown = 5.0;
          const maskedTgt = loop.maskedTargetName || 'Cu²⁺';
          sim.addLog({
            type: 'reaction',
            equation: loop.maskedCuByNa
              ? `Na⁺* (589 nm) >> ${maskedTgt}* → Che lấp quang phổ vàng rực!`
              : `${loop.sampledIon}* → ${loop.sampledIon} + hν (${loop.sampleLabel})`,
            nameVi: loop.maskedCuByNa
              ? `Thử màu ngọn lửa: Na⁺ (589 nm) che lấp hoàn toàn màu ${maskedTgt}`
              : loop.sampledIon === 'Ca²⁺'
              ? 'Thử màu ngọn lửa: Ion Ca²⁺ phát quang đỏ gạch (622 nm)'
              : `Thử màu ngọn lửa: Ion ${loop.sampledIon} phát quang đặc trưng`,
            nameEn: loop.maskedCuByNa
              ? `Flame Test Spectral Masking: Trace Na⁺ (589 nm) masks ${maskedTgt}!`
              : loop.sampledIon === 'Ca²⁺'
              ? 'Flame Test: Ca²⁺ emits characteristic brick-red (622 nm) flame'
              : `Flame Test: Characteristic ${loop.sampleLabel} emission`,
            descVi: loop.maskedCuByNa
              ? `Vạch D vàng của Sodium (589 nm) có cường độ lượng tử vượt trội làm khuất hoàn toàn ánh phát xạ của ${maskedTgt}.`
              : loop.sampledIon === 'Ca²⁺'
              ? 'Ion Ca²⁺ bị kích thích nhiệt trong ngọn lửa phát ra dải quang phổ đỏ gạch / da cam đặc trưng (~622 nm).'
              : `Ion ${loop.sampledIon} kích thích nhiệt trong ngọn lửa đèn cồn/Bunsen phát xạ bước sóng đặc trưng.`,
            descEn: loop.maskedCuByNa
              ? `Intense 589 nm Sodium D-line emission overwhelms and masks the weaker ${maskedTgt} flame band.`
              : loop.sampledIon === 'Ca²⁺'
              ? 'Thermally excited Ca²⁺ (CaOH* band ~622 nm) produces a brilliant brick-red flame coloration.'
              : `Thermal excitation of ${loop.sampledIon} emits its characteristic atomic flame line.`,
            vesselLabel: `${loop.label} → ${b.label}`,
          });
        }
      }
    }
  }
}

/**
 * Sample solution or escaping acid/base vapor onto Litmus / Universal pH Indicator Strip.
 */
export function checkIndicatorStripInteractions(sim, strip) {
  if (!strip || strip.kind !== 'indicator_strip') return;
  const { x: tipX, y: tipY } = getProbeTipPos(strip);

  for (const el of sim.items) {
    if (el.kind !== 'electrode' || !el.dockedVesselId || el.gasBubbleType !== 'Cl2_g') continue;
    const parent = sim.getItem(el.dockedVesselId);
    if (!parent || parent.isShattered || parent.isStoppered) continue;
    const pTop = parent.y - (APPARATUS[parent.typeId]?.height || 110) / 2;
    if ((el.gasBubbleRate || 0) > 1.2e-7 && Math.abs(tipX - el.x) <= 38 && tipY >= pTop - 48 && tipY <= el.y + 30) {
      strip.sampledPH = 2.0;
      strip.isBleached = true;
      strip.sampledFrom = `Cl₂ (${el.label})`;
      strip.tipColor = '#f8fafc';
      return;
    }
  }

  for (const v of sim.items) {
    if (v.kind !== 'vessel' || v.isShattered) continue;
    const spec = APPARATUS[v.typeId];
    const rimY = v.isInverted ? v.y + spec.height / 2 : v.y - spec.height / 2;
    const inVesselBody = Math.abs(tipX - v.x) <= spec.width * 0.5 && tipY >= v.y - spec.height * 0.52 && tipY <= v.y + spec.height * 0.52;
    const nearOpenMouth = !v.isStoppered && Math.hypot(tipX - v.x, tipY - rimY) <= 56;
    if (!inVesselBody && !nearOpenMouth) continue;

    let detectedPH = null;
    let bleached = false;
    let sourceTag = '';

    if (inVesselBody && !v.isFrozenSolid) {
      const liqL = computeLiquidVolumeL(v.moles, v.tempK);
      if (liqL > 1e-5) {
        detectedPH = computePH(v.moles, liqL, v.tempK);
        if ((v.moles.Cl2_aq || 0) > 1e-5 || (v.moles.ClO_aq || 0) > 1e-4) bleached = true;
        sourceTag = v.label;
      }
    }
    if (detectedPH === null && nearOpenMouth) {
      const rHCl = v.lastGasRateMap?.HCl_g || 0;
      const rNH3 = v.lastGasRateMap?.NH3_g || 0;
      const rCl2 = (v.lastGasRateMap?.Cl2_g || 0) + (v.headspaceGasMoles?.Cl2_g || 0) * 0.08;
      const concHCl = (v.moles.H_aq || 0) / Math.max(0.01, computeLiquidVolumeL(v.moles, v.tempK) || 0.01);
      if (rCl2 > 1.2e-6) {
        detectedPH = 2.0;
        bleached = true;
        sourceTag = `Cl₂ (${v.label})`;
      } else if (rHCl > 8e-6 || (concHCl > 6.5 && v.tempK >= 268.15)) {
        detectedPH = 1.5;
        sourceTag = `HCl(g) (${v.label})`;
      } else if (rNH3 > 8e-6 || (v.headspaceGasMoles?.NH3_g || 0) > 5e-5) {
        detectedPH = 11.0;
        sourceTag = `NH₃(g) (${v.label})`;
      }
    }

    if (detectedPH !== null) {
      strip.sampledPH = detectedPH;
      strip.isBleached = bleached;
      strip.sampledFrom = sourceTag;
      if (bleached) {
        strip.tipColor = '#f8fafc';
      } else if (strip.stripKind === 'litmus') {
        strip.tipColor = detectedPH < 5.2 ? '#ef4444' : detectedPH > 8.2 ? '#3b82f6' : '#8b5cf6';
      } else {
        strip.tipColor = universalColorForPH(detectedPH);
      }
      return;
    }
  }
}

/**
 * Keep docked items (magnetic stir bars, electrode rods, vessel-resting filter funnels) aligned with parent vessels.
 */
export function syncDockedToolPositions(sim) {
  for (const item of sim.items) {
    if (item.kind === 'vessel') item._hasMountedSepFunnel = false;
  }
  for (const it of sim.items) {
    if (it.kind === 'electrode') {
      if (it.dockedVesselId) {
        const v = sim.getItem(it.dockedVesselId);
        if (!v || v.isShattered) {
          it.dockedVesselId = null;
          it.renderHeight = null;
          it.immersedHeightPx = null;
          it.immersedFrac = undefined;
          continue;
        }
        const vSpec = APPARATUS[v.typeId];
        const eSpec = APPARATUS[it.typeId];
        if (vSpec.isUTube) {
          const dxU = vSpec.limbSpacingX || 28;
          const dxOff = it.dockSide === 'right' ? dxU : -dxU;
          const vTop = v.y - vSpec.height / 2;
          const vInteriorBot = v.y + vSpec.height / 2 - 4;
          const armBotY = v.y + vSpec.height / 2 - dxU * 0.85;
          const targetTopY = vTop - 16;
          const effHeight = Math.max(76, armBotY - targetTopY);
          it.renderHeight = effHeight;
          it.x = v.x + dxOff;
          it.y = armBotY - effHeight / 2;
          it.vy = 0;
          it.fallStartY = null;
          if (eSpec) it.restingOnId = null;
          const liqMl = computeLiquidVolumeL(v.moles || {}, v.tempK || 298.15) * 1000;
          const solMl = computeSolidVolumeMl(v.moles || {});
          const totMl = liqMl + solMl;
          if (liqMl <= 0.15 || totMl <= 0.1) {
            it.immersedHeightPx = 0;
            it.immersedFrac = 0;
          } else {
            const uFillFrac = Math.min(0.92, Math.max(0.08, totMl / Math.max(1, vSpec.maxVolumeMl || 100)));
            const surfY = vInteriorBot - uFillFrac * Math.max(12, vInteriorBot - vTop - 10);
            const immersedPx = Math.max(0, Math.min(effHeight - 14, armBotY - surfY));
            it.immersedHeightPx = immersedPx;
            it.immersedFrac = immersedPx <= 1.0 ? 0 : Math.min(1, immersedPx / Math.max(20, effHeight - 14));
          }
        } else {
          const neckHalfPx = vSpec.neckRadius ? vSpec.neckRadius * 0.65 : vSpec.width * 0.31;
          const maxDx = Math.min(26, vSpec.width * 0.31, neckHalfPx);
          const dxOff = it.dockSide === 'right' ? maxDx : -maxDx;

          const rimY = v.y - vSpec.height / 2;
          const vInteriorBottomY = v.y + vSpec.height / 2 - 7;
          const targetTopY = rimY - 18;
          const targetBotY = vInteriorBottomY - 3;
          const effHeight = Math.max(44, targetBotY - targetTopY);

          it.x = v.x + dxOff;
          it.y = 0.5 * (targetTopY + targetBotY);
          it.renderHeight = effHeight;
          it.vy = 0;
          it.fallStartY = null;
          if (eSpec) it.restingOnId = null;

          // Exact tip immersion vs current liquid surface level inside parent vessel
          const liqMl = computeLiquidVolumeL(v.moles, v.tempK) * 1000;
          const solMl = computeSolidVolumeMl(v.moles);
          if (liqMl <= 0.15) {
            it.immersedHeightPx = 0;
            it.immersedFrac = 0;
          } else if (vSpec.geometry) {
            const footH = vSpec.shape === 'cylinder' ? 9 : 3.5;
            const baseBottom = v.y + vSpec.height / 2 - footH;
            const topGlass = rimY + 4;
            const spanH = Math.max(10, baseBottom - topGlass);
            const st = vSpec.geometry.getLiquidState(liqMl + solMl);
            const surfaceY = baseBottom - st.fillRatio * spanH;
            const immPx = Math.max(0, Math.min(effHeight - 14, targetBotY - surfaceY));
            it.immersedHeightPx = immPx;
            it.immersedFrac = immPx <= 1.0 ? 0 : Math.min(1, immPx / Math.max(20, effHeight - 14));
          } else {
            const fillFrac = Math.max(0, Math.min(1, (liqMl + solMl) / Math.max(1, vSpec.maxVolumeMl)));
            const liqH = fillFrac * (vSpec.height - 14);
            it.immersedHeightPx = liqH;
            it.immersedFrac = liqH <= 1.0 ? 0 : Math.min(1, liqH / Math.max(20, effHeight - 14));
          }
        }
      } else {
        it.renderHeight = null;
        it.immersedHeightPx = null;
        it.immersedFrac = undefined;
      }
    } else if (it.kind === 'vessel' && it.isInverted && it.mountedOverElectrodeId && !it.isDragging) {
      const el = sim.getItem(it.mountedOverElectrodeId);
      const parentV = el?.dockedVesselId ? sim.getItem(el.dockedVesselId) : null;
      if (!el || !parentV || parentV.isShattered) {
        it.mountedOverElectrodeId = null;
        continue;
      }
      const vSpec = APPARATUS[parentV.typeId];
      const tSpec = APPARATUS[it.typeId];
      it.x = el.x;
      it.y = parentV.y - vSpec.height / 2 - tSpec.height * 0.28;
      it.vy = 0;
      it.fallStartY = null;
      it.submergedInTroughId = parentV.id;
    } else if (it.kind === 'stir_bar' && it.inVesselId) {
      const v = sim.getItem(it.inVesselId);
      if (!v || v.isShattered) {
        it.inVesselId = null;
        continue;
      }
      const vSpec = APPARATUS[v.typeId];
      it.x = v.x;
      it.y = v.y + vSpec.height / 2 - 12;
      it.vy = 0;
      it.fallStartY = null;
    } else if (it.kind === 'filter_funnel' && it.mountedOnVesselId && !it.isDragging) {
      const v = sim.getItem(it.mountedOnVesselId);
      if (!v || v.isShattered || v.isStoppered) {
        it.mountedOnVesselId = null;
        continue;
      }
      const vSpec = APPARATUS[v.typeId];
      const fSpec = APPARATUS.filter_funnel;
      it.x = v.x;
      it.y = v.y - vSpec.height / 2 - fSpec.height * 0.18;
      it.vy = 0;
      it.fallStartY = null;
    } else if (it.kind === 'condenser' && it.refluxMode && it.refluxVesselId && !it.isDragging) {
      const v = sim.getItem(it.refluxVesselId);
      if (!v || v.isShattered) {
        it.refluxVesselId = null;
        continue;
      }
      const vSpec = APPARATUS[v.typeId];
      const cSpec = APPARATUS.liebig_condenser;
      const halfW = (cSpec?.width || 152) / 2;
      const hasSepOnSame = sim.items.some((f) => f.kind === 'separatory_funnel' && !f.isBroken && f.mountedOnVesselId === v.id);
      it.x = v.x + (hasSepOnSame ? 14 : 0);
      it.y = v.y - vSpec.height / 2 - halfW * 0.88;
      it.vy = 0;
      it.fallStartY = null;
      if (it.connectedFromId !== v.id) {
        it.connectedFromId = v.id;
        v.connectedTargetId = it.id;
        v.isStoppered = true;
      }
    } else if (it.kind === 'separatory_funnel' && it.mountedOnVesselId && !it.isDragging) {
      const v = sim.getItem(it.mountedOnVesselId);
      if (!v || v.isShattered || v.isInverted) {
        it.mountedOnVesselId = null;
        continue;
      }
      v._hasMountedSepFunnel = true;
      const vSpec = APPARATUS[v.typeId];
      const sfSpec = APPARATUS.separatory_funnel;
      const isDualHole = v.isStoppered && v.stopperMode === 'dual_hole';
      const hasRefluxOnSame = sim.items.some((c) => c.kind === 'condenser' && !c.isBroken && c.refluxMode && c.refluxVesselId === v.id);
      it.x = v.x - (hasRefluxOnSame ? 18 : isDualHole || v.connectedTargetId ? 6 : 0);
      it.y = v.y - vSpec.height / 2 - (sfSpec?.height || 196) * 0.56;
      it.vy = 0;
      it.fallStartY = null;
    }
  }
}

export function checkPhenCottonInteractions(sim, cotton, dt) {
  if (!cotton || cotton.kind !== 'phen_cotton') return;
  const damp = Math.max(0.2, Math.min(1.0, cotton.dampness ?? 0.85));
  let nh3Hit = false;
  let acidHit = false;
  const sideBias = cotton.attachedSide;
  const attachedV = cotton.attachedToId ? sim.getItem(cotton.attachedToId) : null;

  const checkVesselGas = (v, rx, ry) => {
    if (!v || v.kind !== 'vessel' || v.isShattered) return;
    const rateMap = v.lastGasRateMap || {};
    const nNH3 = rateMap.NH3_g || 0;
    const nHCl = (rateMap.HCl_g || 0) + (rateMap.SO3_g || 0);
    if (nNH3 <= 1e-6 && nHCl <= 1e-6) return;
    if (Math.hypot(cotton.x - rx, cotton.y - ry) <= 60) {
      if (nNH3 > 1e-6) nh3Hit = true;
      if (nHCl > 1e-6) acidHit = true;
    }
  };

  if (attachedV && !attachedV.isShattered) {
    const aSpec = APPARATUS[attachedV.typeId] || APPARATUS.beaker_250;
    const ends = aSpec.hasTwoEnds ? getVesselEndPorts(attachedV) : null;
    const isSideOpen = ends
      ? (sideBias === 'left' ? !attachedV.leftStoppered : !attachedV.rightStoppered)
      : !attachedV.isStoppered;
    if (isSideOpen) {
      const rateMap = attachedV.lastGasRateMap || {};
      if ((rateMap.NH3_g || 0) > 1e-6) nh3Hit = true;
      if ((rateMap.HCl_g || 0) + (rateMap.SO3_g || 0) > 1e-6) acidHit = true;
    }
  } else {
    for (const v of sim.items) {
      if (v.kind !== 'vessel' || v.isShattered) continue;
      const spec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
      if (spec.hasTwoEnds) {
        const ends = getVesselEndPorts(v);
        if (ends?.left && !v.leftStoppered) checkVesselGas(v, ends.left.mouthX, ends.left.mouthY);
        if (ends?.right && !v.rightStoppered) checkVesselGas(v, ends.right.mouthX, ends.right.mouthY);
      } else if (!v.isStoppered) {
        const mouthY = v.isInverted ? v.y + spec.height / 2 : v.y - spec.height / 2;
        checkVesselGas(v, v.x, mouthY);
      }
    }
  }

  if (nh3Hit) {
    cotton.pinkLevel = Math.min(1.0, (cotton.pinkLevel || 0) + dt * (2.4 * damp));
  } else if (acidHit) {
    cotton.pinkLevel = Math.max(0, (cotton.pinkLevel || 0) - dt * 2.8);
  } else {
    cotton.pinkLevel = Math.max(0, (cotton.pinkLevel || 0) - dt * 0.035);
  }

  if (attachedV && !attachedV.isShattered) {
    if (sideBias === 'left') attachedV.phenCottonLeftLevel = cotton.pinkLevel;
    else if (sideBias === 'right') attachedV.phenCottonRightLevel = cotton.pinkLevel;
    else attachedV.phenCottonLevel = cotton.pinkLevel;
  }
}

/**
 * Step all physical bench tools during simulation tick.
 */
export function stepApparatusTools(sim, dt, realDeltaSec) {
  for (const it of sim.items) {
    if (it.isBroken || it.isShattered) continue;

    if (it.kind === 'filter_funnel') {
      stepFilterFunnel(sim, it, dt);
    } else if (it.kind === 'separatory_funnel') {
      stepSeparatoryFunnel(sim, it, dt);
    } else if (it.kind === 'diffusion_tube') {
      stepDiffusionTube(sim, it, dt);
    } else if (it.kind === 'burette') {
      stepBurette(sim, it, dt);
    } else if (it.kind === 'condenser') {
      stepLiebigCondenser(sim, it, dt);
    } else if (it.kind === 'splint') {
      if ((it.cooldownTimer || 0) > 0) it.cooldownTimer = Math.max(0, it.cooldownTimer - realDeltaSec);
      if ((it.o2FlareTimer || 0) > 0) it.o2FlareTimer = Math.max(0, it.o2FlareTimer - realDeltaSec);
      if ((it.lastEventTimer || 0) > 0) {
        it.lastEventTimer = Math.max(0, it.lastEventTimer - realDeltaSec);
        if (it.lastEventTimer === 0) it.lastTestEvent = null;
      }
      checkSplintInteractions(sim, it);
    } else if (it.kind === 'flame_loop') {
      if ((it.logCooldown || 0) > 0) it.logCooldown = Math.max(0, it.logCooldown - realDeltaSec);
      checkFlameLoopInteractions(sim, it);
    } else if (it.kind === 'indicator_strip') {
      checkIndicatorStripInteractions(sim, it);
    } else if (it.kind === 'phen_cotton') {
      checkPhenCottonInteractions(sim, it, realDeltaSec);
    } else if (it.kind === 'spoon') {
      stepIronSpoon(sim, it, dt);
    } else if (it.kind === 'thermometer') {
      checkThermometerInteractions(sim, it, dt);
    } else if (it.kind === 'vessel') {
      if ((it.magStirRpm || 0) > 0 && it.hasStirBar && !it.isFrozenSolid) {
        it.stirTimer = Math.max(it.stirTimer || 0, 0.35);
        it.suspensionLevel = Math.min(1.0, (it.suspensionLevel || 0) + 0.8 * realDeltaSec);
        it.stirBarPhase = (it.stirBarPhase || 0) + (it.magStirRpm / 60) * Math.PI * 2 * realDeltaSec;
      }
      if ((it.grindAnimTimer || 0) > 0) {
        it.grindAnimTimer = Math.max(0, it.grindAnimTimer - realDeltaSec);
      }
    } else if (it.kind === 'burner') {
      if ((it.flameTestTimer || 0) > 0) {
        it.flameTestTimer = Math.max(0, it.flameTestTimer - realDeltaSec);
        if (it.flameTestTimer === 0) {
          it.flameTestColor = null;
          it.flameTestIon = null;
        }
      }
    } else if (it.kind === 'electrode') {
      if ((it.recentGasMol || 0) > 0) {
        it.recentGasMol = Math.max(0, it.recentGasMol * Math.exp(-realDeltaSec * 1.4));
        if (it.recentGasMol < 1e-10) it.recentGasMol = 0;
      }
    } else if (it.kind === 'wash_bottle') {
      if ((it.squirtTimer || 0) > 0) {
        it.squirtTimer = Math.max(0, it.squirtTimer - realDeltaSec);
      }
      // Only spray when actively held/dragged by user or manual hold button is pressed
      const activeSqueeze = Boolean(it.isDragging || it.manualSprayHold);
      it.isSpraying = activeSqueeze && (it.waterMl || 0) > 0.1;
      if (it.isSpraying) {
        const arc = computeWashBottleStreamArc(it, sim.items, 482, CONSTANTS.GRAVITY_PX_S2 || 1800);
        const waterMl = Math.min(it.waterMl || 0, 6.0 * dt);
        if (waterMl > 1e-4) {
          it.waterMl -= waterMl;
          it.squirtArc = arc;
          it.squirtTimer = Math.max(it.squirtTimer || 0, 0.1);
          it.sprayTargetId = arc.hitTarget ? arc.hitTarget.id : null;
          if (arc.hitTarget) {
            const addMol = (waterMl * 0.997) / SPECIES.H2O_l.molarMass;
            arc.hitTarget.moles.H2O_l = (arc.hitTarget.moles.H2O_l || 0) + addMol;
          }
        } else {
          it.isSpraying = false;
        }
      }
    }
  }

  stepPneumaticTrough(sim);
  syncDockedToolPositions(sim);
}

/**
 * Phenomenon #8: 1D Graham's Law Gas Diffusion Tube solver (NH3(g) vs HCl(g) nucleating NH4Cl(s) ring at ~59.4%).
 */
function stepDiffusionTube(sim, tube, dt) {
  if (!tube.leftGasId && !tube.rightGasId) return;
  const T = Math.max(200, sim.environment.tempK || CONSTANTS.T_STD_K);
  const tFactor = Math.pow(T / CONSTANTS.T_STD_K, 0.75);
  const baseSpeed = 0.34; // ~5-7 s full traverse at room T

  const vLeft = tube.leftGasId && SPECIES[tube.leftGasId]?.molarMass
    ? (baseSpeed * tFactor) / Math.sqrt(SPECIES[tube.leftGasId].molarMass)
    : 0;
  const vRight = tube.rightGasId && SPECIES[tube.rightGasId]?.molarMass
    ? (baseSpeed * tFactor) / Math.sqrt(SPECIES[tube.rightGasId].molarMass)
    : 0;

  if (vLeft > 0) tube.leftFront = Math.min(1, (tube.leftFront || 0) + vLeft * dt);
  if (vRight > 0) tube.rightFront = Math.max(0, (tube.rightFront ?? 1) - vRight * dt);

  const isOppositePair =
    (tube.leftGasId === 'NH3_g' && tube.rightGasId === 'HCl_g') ||
    (tube.leftGasId === 'HCl_g' && tube.rightGasId === 'NH3_g');

  if (isOppositePair && vLeft > 0 && vRight > 0) {
    const xMeet = vLeft / (vLeft + vRight);
    tube.ringPosFrac = xMeet;
    if ((tube.leftFront || 0) >= xMeet && (tube.rightFront ?? 1) <= xMeet) {
      tube.ringGrowth = Math.min(1, (tube.ringGrowth || 0) + dt * 0.55);
      if (!tube._ringLogged && tube.ringGrowth >= 0.25) {
        tube._ringLogged = true;
        const distPctFromNH3 = tube.leftGasId === 'NH3_g' ? xMeet * 100 : (1 - xMeet) * 100;
        const ratio = Math.sqrt(SPECIES.HCl_g.molarMass / SPECIES.NH3_g.molarMass);
        sim.addLog({
          type: 'reaction',
          equation: `NH₃(g) + HCl(g) → NH₄Cl(s)↓  [Graham: v_NH₃/v_HCl = ${ratio.toFixed(3)} ⇒ ${distPctFromNH3.toFixed(1)}% từ đầu NH₃]`,
          nameVi: `Định luật khuếch tán Graham: Vòng khói trắng NH₄Cl(s) tại ${distPctFromNH3.toFixed(1)} cm từ đầu NH₃`,
          nameEn: `Graham's Law Diffusion: White NH₄Cl(s) ring forms at ${distPctFromNH3.toFixed(1)}% from NH₃ end`,
          descVi: `Do M(NH₃)=17.03 < M(HCl)=36.46, khí NH₃ khuếch tán nhanh hơn ${ratio.toFixed(2)} lần nên gặp HCl lệch rõ về phía HCl.`,
          descEn: `Lighter NH₃ (17.03 g/mol) diffuses ${ratio.toFixed(2)}× faster than HCl (36.46 g/mol), nucleating a crisp white ring at ${distPctFromNH3.toFixed(1)} cm from NH₃.`,
          vesselLabel: tube.label,
        });
      }
    }
  }
}

/**
 * Mortar & Pestle solid comminution & Phenomenon #5 Solid-State Mechanochemistry:
 * Grinding boosts reactive surface area A_solid AND mechanically reacts CuSO4·5H2O(s) + 2NaOH(s) -> Cu(OH)2(s) + Na2SO4(s) + 5H2O(l).
 */
export function grindMortarSolids(sim, mortarId) {
  const m = sim.getItem(mortarId);
  if (!m || !APPARATUS[m.typeId]?.isMortar) return false;
  m.groundPowderMap = m.groundPowderMap || {};
  m.flattenedMetalMap = m.flattenedMetalMap || {};
  let groundAny = false;
  const brittleNames = [];
  const metalNames = [];
  let hasSoftNa = false;
  let hasDuctileZnOrMetal = false;

  for (const [spId, n] of Object.entries(m.moles)) {
    const sp = SPECIES[spId];
    if (!sp || sp.phase !== 's' || n <= 1e-8) continue;
    const beh = sp.mechanicalBehavior;
    const cur = m.particleCounts[spId] || 6;

    if (spId === 'Na_s' || beh === 'soft_metal') {
      // Soft alkali metal (Mohs ~0.5): smears/flattens rather than shattering to dust
      m.particleCounts[spId] = Math.min(10, Math.max(4, cur));
      m.flattenedMetalMap[spId] = true;
      delete m.groundPowderMap[spId];
      hasSoftNa = true;
      groundAny = true;
      metalNames.push(sp.formula || spId);
    } else if (sp.isDenseMetal || beh === 'ductile_metal') {
      // Malleable/ductile metal (Zn, Cu, Ag): deforms into thin sheared plates rather than brittle micro-powder
      m.particleCounts[spId] = Math.min(36, Math.max(14, cur + 8));
      m.flattenedMetalMap[spId] = true;
      delete m.groundPowderMap[spId];
      hasDuctileZnOrMetal = true;
      groundAny = true;
      metalNames.push(sp.formula || spId);
    } else {
      // Brittle ionic crystals / hydrates / pellets comminute cleanly into fine micro-powder
      m.particleCounts[spId] = Math.min(2400, Math.max(600, cur * 24));
      m.groundPowderMap[spId] = true;
      groundAny = true;
      brittleNames.push(sp.formula || spId);
    }
  }

  // Phenomenon #5: Solid-state mechanochemistry: CuSO4·5H2O(s) + 2 NaOH(s) -> Cu(OH)2(s) + Na2SO4(s) + 5 H2O(l)
  const nCuHyd = m.moles.CuSO4_5H2O_s || 0;
  const nNaOH = m.moles.NaOH_s || 0;
  if (nCuHyd > 1e-6 && nNaOH > 1e-6) {
    const dXi = Math.min(nCuHyd, nNaOH / 2) * 0.94;
    if (dXi > 1e-7) {
      const cTot = computeHeatCapacityJK(m);
      m.moles.CuSO4_5H2O_s = nCuHyd - dXi;
      if (m.moles.CuSO4_5H2O_s < 1e-12) delete m.moles.CuSO4_5H2O_s;
      m.moles.NaOH_s = nNaOH - 2 * dXi;
      if (m.moles.NaOH_s < 1e-12) delete m.moles.NaOH_s;
      m.moles.CuOH2_s = (m.moles.CuOH2_s || 0) + dXi;
      m.moles.Na2SO4_s = (m.moles.Na2SO4_s || 0) + dXi;
      m.moles.H2O_l = (m.moles.H2O_l || 0) + 5 * dXi;
      m.particleCounts.CuOH2_s = 1200;
      m.particleCounts.Na2SO4_s = 1200;
      m.groundPowderMap.CuOH2_s = true;
      m.groundPowderMap.Na2SO4_s = true;
      // Exothermic lattice metathesis releases crystal water & heats paste noticeably
      m.tempK = Math.min(395, m.tempK + (dXi * 62000) / Math.max(40, cTot));
      groundAny = true;
      sim.addLog({
        type: 'reaction',
        equation: 'CuSO₄·5H₂O(s) + 2NaOH(s) —(Nghiền cối chày)→ Cu(OH)₂(s)↓ + Na₂SO₄(s) + 5H₂O(l)',
        nameVi: 'Phản ứng cơ hóa pha rắn: CuSO₄·5H₂O + NaOH (tạo hỗn hợp sệt xanh lam)',
        nameEn: 'Solid-state mechanochemistry: CuSO₄·5H₂O + 2NaOH → pale-blue Cu(OH)₂ paste',
        descVi: 'Nghiền mạnh giải phóng nước kết tinh tại ranh giới hạt tinh thể, chuyển thành bột nhão Cu(OH)₂ xanh nhạt kèm tỏa nhiệt (đổ vào bát sứ đun nóng sẽ phân hủy thành CuO đen).',
        descEn: 'Mechanical grinding liberates lattice hydration water to form moist pale-blue Cu(OH)₂ + Na₂SO₄ paste; heating in a Porcelain Dish dehydrates it to black CuO.',
        vesselLabel: m.label,
      });
    }
  }

  // Mechanochemical Red Phosphorus + KMnO4 / K2Cr2O7 & Alkali Metals + K2Cr2O7 friction flash on grinding
  const nPRed = m.moles.P_red_s || 0;
  const nKMn = m.moles.KMnO4_s || 0;
  if (nPRed > 1e-7 && nKMn > 1e-7) {
    const dPKM = Math.min(nPRed / 9, nKMn / 15) * 0.96;
    if (dPKM > 1e-9) {
      const cTot = computeHeatCapacityJK(m);
      m.moles.P_red_s = nPRed - 9 * dPKM;
      if (m.moles.P_red_s < 1e-12) delete m.moles.P_red_s;
      m.moles.KMnO4_s = nKMn - 15 * dPKM;
      if (m.moles.KMnO4_s < 1e-12) delete m.moles.KMnO4_s;
      m.moles.K3PO4_s = (m.moles.K3PO4_s || 0) + 5 * dPKM;
      m.moles.P4O10_s = (m.moles.P4O10_s || 0) + dPKM;
      m.moles.MnO2_s = (m.moles.MnO2_s || 0) + 15 * dPKM;
      m.particleCounts.K3PO4_s = 800;
      m.particleCounts.MnO2_s = 1200;
      m.phosphorusFlameTimer = 1.1;
      m.phosphorusFlameColor = 'p_white_yellow';
      m.tempK = Math.min(1450, m.tempK + (dPKM * 6200000) / Math.max(40, cTot));
      groundAny = true;
      sim.addLog({
        type: 'reaction',
        equation: '9P(đỏ) + 15KMnO₄(s) —(Ma sát / Nghiền)→ 5K₃PO₄(s) + P₄O₁₀(khói) + 15MnO₂(s)',
        nameVi: '⚠️ Cháy nổ dữ dội khi nghiền Phosphorus đỏ với KMnO₄!',
        nameEn: '⚠️ Violent friction flash reaction: grinding Red Phosphorus + KMnO₄!',
        descVi: 'Ma sát khi nghiền P đỏ và chất oxi hóa mạnh KMnO₄ kích hoạt phản ứng cháy nổ tức thì tạo khói trắng P₄O₁₀, K₃PO₄ và MnO₂!',
        descEn: 'Mechanical friction between Red Phosphorus and strong oxidizer KMnO₄ triggers immediate flash combustion!',
        vesselLabel: m.label,
      });
    }
  }
  const nCr2O7 = m.moles.K2Cr2O7_s || 0;
  if ((m.moles.P_red_s || 0) > 1e-7 && nCr2O7 > 1e-7) {
    const dPCr = Math.min((m.moles.P_red_s || 0) / 18, nCr2O7 / 15) * 0.94;
    if (dPCr > 1e-9) {
      const cTot = computeHeatCapacityJK(m);
      m.moles.P_red_s = (m.moles.P_red_s || 0) - 18 * dPCr;
      if (m.moles.P_red_s < 1e-12) delete m.moles.P_red_s;
      m.moles.K2Cr2O7_s = nCr2O7 - 15 * dPCr;
      if (m.moles.K2Cr2O7_s < 1e-12) delete m.moles.K2Cr2O7_s;
      m.moles.Cr2O3_s = (m.moles.Cr2O3_s || 0) + 15 * dPCr;
      m.moles.K3PO4_s = (m.moles.K3PO4_s || 0) + 10 * dPCr;
      m.moles.P4O10_s = (m.moles.P4O10_s || 0) + 2 * dPCr;
      m.phosphorusFlameTimer = 1.1;
      m.phosphorusFlameColor = 'p_white_yellow';
      m.tempK = Math.min(1480, m.tempK + (dPCr * 5800000) / Math.max(40, cTot));
      groundAny = true;
      sim.addLog({
        type: 'reaction',
        equation: '15K₂Cr₂O₇(s) + 18P(đỏ) —(Ma sát / Nghiền)→ 15Cr₂O₃(s) + 10K₃PO₄ + 2P₄O₁₀',
        nameVi: '⚠️ Cháy nổ cực mạnh khi nghiền Phosphorus đỏ với K₂Cr₂O₇!',
        nameEn: '⚠️ Violent friction flash reaction: grinding Red Phosphorus + K₂Cr₂O₇!',
        descVi: 'Hỗn hợp khô P đỏ + K₂Cr₂O₇ cực nhạy va chạm và ma sát, bùng cháy tạo Cr₂O₃ xanh lục thẫm, K₃PO₄ và khói trắng P₄O₁₀!',
        descEn: 'Dry Red P + K₂Cr₂O₇ is highly friction-sensitive and flashes immediately to dark-green Cr₂O₃ and P₄O₁₀.',
        vesselLabel: m.label,
      });
    }
  }
  for (const [mKey, oxProd, eqCr] of [
    ['Na_s', 'Na2O_s', 'K₂Cr₂O₇(s) + 6Na(s) —(Ma sát / Va đập)→ Cr₂O₃(s) + K₂O + 3Na₂O'],
    ['K_s', 'K2O_s', 'K₂Cr₂O₇(s) + 6K(s) —(Ma sát / Va đập)→ Cr₂O₃(s) + 4K₂O'],
  ]) {
    const nAlkCr = m.moles[mKey] || 0;
    const remCr = m.moles.K2Cr2O7_s || 0;
    if (nAlkCr > 1e-7 && remCr > 1e-7) {
      const dAC = Math.min(nAlkCr / 6, remCr) * 0.90;
      if (dAC > 1e-9) {
        const cTot = computeHeatCapacityJK(m);
        m.moles[mKey] = nAlkCr - 6 * dAC;
        if (m.moles[mKey] < 1e-12) delete m.moles[mKey];
        m.moles.K2Cr2O7_s = remCr - dAC;
        if (m.moles.K2Cr2O7_s < 1e-12) delete m.moles.K2Cr2O7_s;
        m.moles.Cr2O3_s = (m.moles.Cr2O3_s || 0) + dAC;
        m.moles.K2O_s = (m.moles.K2O_s || 0) + dAC;
        m.moles[oxProd] = (m.moles[oxProd] || 0) + 3 * dAC;
        m.tempK = Math.min(1380, m.tempK + (dAC * 950000) / Math.max(40, cTot));
        groundAny = true;
        sim.addLog({
          type: 'reaction',
          equation: eqCr,
          nameVi: `⚠️ Nổ tỏa nhiệt mạnh khi nghiền ${SPECIES[mKey]?.formula} với K₂Cr₂O₇!`,
          nameEn: `⚠️ Explosive friction reaction: ${SPECIES[mKey]?.formula} + K₂Cr₂O₇!`,
          descVi: 'Kim loại kiềm tiếp xúc chất oxi hóa mạnh K₂Cr₂O₇ khi va chạm/nghiền gây phản ứng khử nổ nguy hiểm!',
          descEn: 'Alkali metal grinding with solid K₂Cr₂O₇ triggers a hazardous exothermic reduction.',
          vesselLabel: m.label,
        });
      }
    }
  }

  // Mechanochemical Alkali Metal + Sulfur reaction on grinding in mortar: 2M + S -> M2S
  for (const [mKey, sProd, eqS, heatJ] of [
    ['Na_s', 'Na2S_s', '2Na(s) + S(s) —(Nghiền)→ Na₂S(s)', 365000],
    ['K_s', 'K2S_s', '2K(s) + S(s) —(Nghiền)→ K₂S(s)', 381000],
  ]) {
    const nAlk = m.moles[mKey] || 0;
    const nSulf = m.moles.S_s || 0;
    if (nAlk > 1e-7 && nSulf > 1e-7) {
      const dMS = Math.min(nAlk / 2, nSulf) * 0.92;
      if (dMS > 1e-8) {
        const cTot = computeHeatCapacityJK(m);
        m.moles[mKey] = nAlk - 2 * dMS;
        if (m.moles[mKey] < 1e-12) delete m.moles[mKey];
        m.moles.S_s = nSulf - dMS;
        if (m.moles.S_s < 1e-12) delete m.moles.S_s;
        m.moles[sProd] = (m.moles[sProd] || 0) + dMS;
        m.particleCounts[sProd] = 800;
        m.tempK = Math.min(820, m.tempK + (dMS * heatJ) / Math.max(40, cTot));
        groundAny = true;
        sim.addLog({
          type: 'reaction',
          equation: eqS,
          nameVi: `Phản ứng tỏa nhiệt mạnh khi nghiền ${SPECIES[mKey]?.formula} với Sulfur`,
          nameEn: `Vigorous mechanochemical reaction of ${SPECIES[mKey]?.formula} with Sulfur`,
          descVi: 'Kim loại kiềm phản ứng ngay với bột Sulfur khi nghiền/va chạm tạo muối sulfide và tỏa nhiệt lớn.',
          descEn: 'Alkali metal reacts vigorously on grinding with Sulfur powder yielding sulfide salt and heat.',
          vesselLabel: m.label,
        });
      }
    }
  }

  if (groundAny) {
    m.grindAnimTimer = 1.1;
    if (brittleNames.length > 0) {
      sim.addLog({
        type: 'reaction',
        equation: `${brittleNames.join(' + ')} (tinh thể lớn) —(Nghiền cối chày)→ Bột mịn (A_rắn ↑↑)`,
        nameVi: `Đã nghiền mịn ${brittleNames.join(', ')} bằng Cối & Chày sứ`,
        nameEn: `Ground ${brittleNames.join(', ')} into fine powder (Noyes–Whitney area ↑)`,
        descVi: 'Tinh thể ion/muối giòn vỡ thành bột mịn làm tăng mạnh diện tích bề mặt A_rắn và tốc độ phản ứng.',
        descEn: 'Brittle crystals shatter into fine micro-powder, sharply increasing reactive surface area A_solid.',
        vesselLabel: m.label,
      });
    }
    if (metalNames.length > 0) {
      sim.addLog({
        type: 'reaction',
        equation: `${metalNames.join(' + ')} —(Ép chày sứ)→ Dát mỏng / Trượt dẻo (Không vỡ bột)`,
        nameVi: `Biến dạng dẻo kim loại: ${metalNames.join(', ')}`,
        nameEn: `Metallic plasticity: ${metalNames.join(', ')} deformed/flattened without powdering`,
        descVi: hasSoftNa && hasDuctileZnOrMetal
          ? 'Sodium (Na) rất mềm bị ép dẹt/bết dính, còn Zinc (Zn) có liên kết kim loại trượt dẻo chỉ xước/bẹp cạnh nhẹ — không tán thành bột mịn được.'
          : hasSoftNa
          ? 'Sodium (Na) cực mềm (độ cứng Mohs ~0.5) nên chỉ bị miết dẹt trên thành cối chứ không vỡ thành bột như muối giòn.'
          : 'Zinc (Zn) và kim loại có mạng tinh thể trượt dẻo dưới lực nghiền: hạt bị dát mỏng và nứt nhẹ tăng nhẹ mép tiếp xúc, không nghiền thành bột mịn bằng chày tay.',
        descEn: hasSoftNa && !hasDuctileZnOrMetal
          ? 'Soft alkali Sodium (Mohs ~0.5) smears and flattens under the porcelain pestle instead of shattering into powder.'
          : 'Ductile metals undergo plastic slip rather than brittle fracture, flattening into thin metallic flakes with only modest edge exposure.',
        vesselLabel: m.label,
      });
    }
    sim.recomputeScaleReadings();
    sim.emitChange();
  }
  return groundAny;
}

/**
 * Step Iron Combustion / Deflagrating Spoon using the unified engine (stepVesselChemistry)
 * so every metal, nonmetal, oxide, salt, decomposition & gas-jar reaction works identically.
 */
function stepIronSpoon(sim, spoon, dt) {
  if (!spoon || spoon.kind !== 'spoon') return;
  const { x: bowlX, y: bowlY } = getProbeTipPos(spoon);
  spoon.burnTimer = Math.max(0, (spoon.burnTimer || 0) - dt);
  if (spoon.burnTimer === 0) spoon.flameColor = null;

  // 1. Thermal coupling with active Alcohol / Bunsen burner or lit wooden splint
  let flameTargetK = sim.environment.tempK || CONSTANTS.T_STD_K;
  let kHeat = 0.14;
  let inBurnerFlame = false;
  let heatSrc = null;
  for (const b of sim.items) {
    if (b.kind === 'splint' && (b.mode === 'burning' || b.mode === 'glowing')) {
      const tip = getProbeTipPos(b);
      if (Math.hypot(bowlX - tip.x, bowlY - tip.y) <= 28) {
        const splTargetK = b.mode === 'burning' ? 840.0 : 653.15;
        if (splTargetK > flameTargetK) {
          flameTargetK = splTargetK;
          kHeat = Math.max(kHeat, 0.36);
          inBurnerFlame = b.mode === 'burning';
        }
      }
      continue;
    }
    if (b.kind !== 'burner' || (b.powerW || 0) <= 0) continue;
    const bSpec = APPARATUS[b.typeId] || APPARATUS.burner;
    const nozzleY = b.typeId === 'bunsen_burner' ? b.y + bSpec.height / 2 - 68 : b.y + bSpec.height / 2 - 46;
    const dx = Math.abs(bowlX - b.x);
    if (dx <= 46 && bowlY <= nozzleY + 14 && bowlY >= nozzleY - 94) {
      const fl = Math.round(b.flameLevel || 3);
      const isBunsen = b.typeId === 'bunsen_burner';
      const airOpen = b.airHoleOpen !== false;
      const alcPeakK = fl >= 3 ? 915.0 : fl === 2 ? 785.0 : 645.0;
      const peakK = isBunsen
        ? (airOpen ? bSpec.effectiveFlameK[fl] || 1520 : bSpec.yellowFlameK[fl] || 950)
        : Math.max(bSpec.effectiveFlameK[fl] || 720, alcPeakK);
      flameTargetK = Math.max(flameTargetK, peakK);
      kHeat = isBunsen && airOpen ? 1.55 : 0.96;
      inBurnerFlame = true;
      heatSrc = { burner: b, powerW: b.powerW || 0 };
    }
  }

  spoon.tempK = (spoon.tempK ?? 298.15) + (flameTargetK - (spoon.tempK ?? 298.15)) * Math.min(1, kHeat * dt);

  const moles = spoon.moles || {};
  let hasContents = false;
  for (const n of Object.values(moles)) {
    if (n > 1e-9) {
      hasContents = true;
      break;
    }
  }
  if (!hasContents) return;

  // 2. Detect surrounding gas-jar vessel headspace if spoon bowl is dipped inside an unstoppered vessel
  let hostV = null;
  for (const v of sim.items) {
    if (v.kind !== 'vessel' || v.isShattered || v.isStoppered) continue;
    const vSpec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
    if (
      Math.abs(bowlX - v.x) <= vSpec.width * 0.46 &&
      bowlY >= v.y - vSpec.height * 0.52 &&
      bowlY <= v.y + vSpec.height * 0.45
    ) {
      hostV = v;
      break;
    }
  }

  // 3. Delegate chemistry uniformly to stepVesselChemistry (temporarily sharing host jar atmosphere or open air)
  const savedHeadspace = spoon.headspaceGasMoles;
  const savedPurge = spoon.airO2PurgeFrac;
  const savedLiqVol = spoon.liquidVolL;
  spoon.particleCounts = spoon.particleCounts || {};
  spoon.seenReactions = spoon.seenReactions || {};
  spoon.escapedGasMoles = spoon.escapedGasMoles || createZeroGasMap();
  spoon.isStoppered = false;
  spoon.lidState = 'open';
  spoon.headspaceGasMoles = hostV ? (hostV.headspaceGasMoles = hostV.headspaceGasMoles || createZeroGasMap()) : createZeroGasMap();
  spoon.airO2PurgeFrac = hostV && hostV.airO2PurgeFrac !== undefined ? hostV.airO2PurgeFrac : 1.0;

  let chemRes;
  try {
    chemRes = stepVesselChemistry(spoon, dt, {
      environment: sim.environment,
      heatSrc,
      spoonInFlame: inBurnerFlame,
    });
  } finally {
    spoon.headspaceGasMoles = savedHeadspace || createZeroGasMap();
    spoon.airO2PurgeFrac = savedPurge;
    spoon.liquidVolL = savedLiqVol;
  }

  // Route produced gases to host jar headspace or open bench escape + heat exotherm
  if (chemRes?.gasProduced) {
    const destGas = hostV ? hostV.headspaceGasMoles : spoon.escapedGasMoles;
    for (const [gId, gMol] of Object.entries(chemRes.gasProduced)) {
      if (gMol > 0) destGas[gId] = (destGas[gId] || 0) + gMol;
    }
  }
  const cpSpoon = computeHeatCapacityJK(spoon);
  if (chemRes?.reactionHeatJ) {
    spoon.tempK = Math.max(155, Math.min(1850, spoon.tempK + chemRes.reactionHeatJ / Math.max(8, cpSpoon)));
  }

  // 4. Open-spoon phase evaporation for I2(s/l), Sulfur fumes, and trace moisture boil-off
  let evapI2Mol = 0;
  if ((moles.I2_s || 0) > 1e-8 && spoon.tempK >= 313.15) {
    const rate = spoon.tempK >= 457.45 ? 0.45 : spoon.tempK >= 386.85 ? 0.16 : 0.025;
    evapI2Mol = Math.min(moles.I2_s, moles.I2_s * rate * dt);
    moles.I2_s -= evapI2Mol;
    if (moles.I2_s < 1e-12) delete moles.I2_s;
    const destGas = hostV ? hostV.headspaceGasMoles : spoon.escapedGasMoles;
    destGas.I2_g = (destGas.I2_g || 0) + evapI2Mol;
  }
  if ((moles.H2O_l || 0) > 1e-7 && spoon.tempK >= 373.15) {
    const dBoil = Math.min(moles.H2O_l, Math.max(2e-4 * dt, moles.H2O_l * 0.65 * dt));
    moles.H2O_l -= dBoil;
    if (moles.H2O_l < 1e-12) delete moles.H2O_l;
  }

  // 5. Synchronize flame aura, radiant heat floors, particle plumes & reaction logs
  const activeIds = new Set((chemRes?.activeReactions || []).map((r) => r.id));
  const flameSpec =
    (spoon.mgCombustionTimer || 0) > 0.02
      ? { color: 'white_mg', floorK: 1650, flags: { mgBurning: true }, dur: 1.05 }
      : (spoon.alCombustionTimer || 0) > 0.02
      ? { color: 'white_al', floorK: 1580, flags: { alBurning: true }, dur: 1.0 }
      : (spoon.feSparkBurning || 0) > 0.02
      ? { color: 'sparks_fe', floorK: hostV ? 1460 : 1280, flags: { feSparkBurning: true }, dur: 0.95 }
      : (spoon.kDryBurnTimer || 0) > 0.02
      ? { color: 'violet_k', floorK: 1020, flags: { kDryBurning: true }, dur: 0.95 }
      : (spoon.naDryBurnTimer || 0) > 0.02
      ? { color: 'yellow_na', floorK: 920, flags: { naDryBurning: true }, dur: 0.95 }
      : (spoon.znCombustionTimer || 0) > 0.02 || activeIds.has('zn_o2_burn')
      ? { color: 'cyan_zn', floorK: 1180, flags: { znBurning: true, heatRate: 800 }, dur: 0.95 }
      : (spoon.sulfurFlameTimer || 0) > 0.02
      ? { color: spoon.sulfurO2Flame ? 'sulfur_violet' : 'sulfur_blue', floorK: 820, flags: { sulfurBurning: true }, dur: 0.85 }
      : (spoon.phosphorusFlameTimer || 0) > 0.02
      ? { color: 'white_mg', floorK: 960, flags: { pBurning: true }, dur: 0.95 }
      : activeIds.has('cu_o2_ox') && inBurnerFlame && spoon.tempK >= 820
      ? { color: 'emerald_cu', floorK: 0, flags: {}, dur: 0.35 }
      : null;

  if (flameSpec) {
    spoon.burnTimer = Math.max(spoon.burnTimer || 0, flameSpec.dur);
    spoon.flameColor = flameSpec.color;
    if (flameSpec.floorK > 0) spoon.tempK = Math.max(spoon.tempK, flameSpec.floorK);
    if (sim.visualHooks?.onParticlesNeeded) {
      sim.visualHooks.onParticlesNeeded(
        { x: bowlX, y: bowlY + 8, typeId: 'crucible_porcelain', moles, tempK: spoon.tempK },
        flameSpec.flags
      );
    }
  } else if (evapI2Mol > 1e-6 && sim.visualHooks?.onParticlesNeeded) {
    sim.visualHooks.onParticlesNeeded(
      { x: bowlX, y: bowlY + 6, typeId: 'crucible_porcelain', moles, tempK: spoon.tempK },
      { i2RateMolS: evapI2Mol / Math.max(1e-3, dt) }
    );
  }

  for (const r of chemRes?.activeReactions || []) {
    if ((sim.timeSec - (spoon.seenReactions[r.id] ?? -99)) > 4.0) {
      spoon.seenReactions[r.id] = sim.timeSec;
      sim.addLog({
        type: 'reaction',
        equation: r.equation,
        nameVi: r.nameVi,
        nameEn: r.nameEn,
        descVi: r.descVi,
        descEn: r.descEn,
        vesselLabel: spoon.label,
      });
    }
  }
}

function mOrZero(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function checkThermometerInteractions(sim, therm, dt = 0.05) {
  if (!sim || !therm || therm.isBroken) return;
  const { x: bx, y: by } = getProbeTipPos(therm);
  let targetK = sim.environment?.tempK ?? CONSTANTS.T_STD_K;
  let contactKind = 'ambient';
  let contactLabel = '';

  // Check vessels, funnels, baths, syringes containing or touching thermometer bulb
  for (let i = sim.items.length - 1; i >= 0; i--) {
    const it = sim.items[i];
    if (it.id === therm.id || it.isShattered || it.isBroken) continue;
    const spec = APPARATUS[it.typeId];
    if (!spec) continue;
    if (it.kind === 'vessel' || it.kind === 'filter_funnel') {
      const hw = Math.max(18, spec.width * 0.46);
      const hh = Math.max(20, spec.height * 0.52);
      if (Math.abs(bx - it.x) <= hw && by >= it.y - hh - 4 && by <= it.y + hh + 4) {
        targetK = it.tempK ?? targetK;
        contactKind = it.kind;
        contactLabel = it.label || it.typeId;
        break;
      }
    } else if (it.kind === 'bath') {
      if (Math.abs(bx - it.x) <= spec.width * 0.46 && by >= it.y - spec.height * 0.5 && by <= it.y + spec.height * 0.5) {
        targetK = it.bathTempK ?? (it.bathMode === 'ice_salt' ? 263.15 : 273.15);
        contactKind = 'bath';
        contactLabel = it.label || it.typeId;
        break;
      }
    } else if (it.kind === 'burner' && (it.powerW || 0) > 0) {
      if (Math.abs(bx - it.x) <= 30 && by <= it.y + 8 && by >= it.y - spec.height * 0.5 - 68) {
        const bTbl = it.typeId === 'bunsen_burner' && it.airHoleOpen === false ? spec.yellowFlameK : spec.effectiveFlameK;
        const fl = Math.max(1, Math.min(3, Math.round(it.flameLevel || 1)));
        const maxFlame = Math.min(723.15, bTbl?.[fl] || 650);
        targetK = Math.max(targetK, maxFlame);
        contactKind = 'burner';
        contactLabel = it.label || it.typeId;
        break;
      }
    }
  }

  therm.contactKind = contactKind;
  therm.contactLabel = contactLabel;
  if (!Number.isFinite(therm.measuredTempK)) {
    therm.measuredTempK = targetK;
  } else {
    const alpha = Math.min(1, 1 - Math.exp(-4.2 * Math.max(0.01, dt)));
    therm.measuredTempK = therm.measuredTempK + (targetK - therm.measuredTempK) * alpha;
  }
  therm.tempK = therm.measuredTempK;
}
