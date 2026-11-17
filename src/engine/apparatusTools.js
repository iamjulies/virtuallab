import { APPARATUS, getCondenserPorts, getProbeTipPos, getVesselEndPorts } from '../data/apparatus.js';
import { CONSTANTS } from '../data/constants.js';
import { SPECIES, createZeroGasMap } from '../data/species.js';
import {
  computeLiquidVolumeL,
  computePH,
  computeSolidVolumeMl,
  computeSolutionVisuals,
} from './equilibrium.js';
import { computeHeatCapacityJK } from './thermodynamics.js';

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
  const vx0 = dir * 195;
  const vy0 = -515;
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
      for (const dst of items) {
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

  const eff = cond.waterFlowOn ? 0.94 : 0.22;
  const { spout } = getCondenserPorts(cond);
  const spoutX = spout.x;
  const spoutY = spout.y;
  let dst = null;
  if (cond.outletTargetId) {
    const oDst = sim.getItem(cond.outletTargetId);
    if (oDst && oDst.kind === 'vessel' && !oDst.isShattered && !oDst.isStoppered) {
      dst = oDst;
    } else if (!oDst || oDst.isShattered) {
      cond.outletTargetId = null;
    }
  }
  if (!dst) {
    dst = findOpenVesselBelowPoint(sim.items, spoutX, spoutY - 8, 58, 0, 320);
  }

  const nSteam = vapor.H2O_g || 0;
  const nEtOH = vapor.C2H5OH_g || 0;
  const nHCl = vapor.HCl_g || 0;
  const nNH3 = vapor.NH3_g || 0;
  const condW = nSteam * eff;
  const condE = nEtOH * eff;
  // HCl(g) & NH3(g) absorb strongly into chilled co-condensing water droplets
  const absHCl = condW > 1e-8 ? Math.min(nHCl, condW * 0.45, nHCl * eff) : 0;
  const absNH3 = condW > 1e-8 ? Math.min(nNH3, condW * 0.55, nNH3 * eff) : 0;

  if (condW + condE > 1e-9) {
    const dMl =
      ((condW * SPECIES.H2O_l.molarMass) / 0.997 +
        (condE * SPECIES.C2H5OH_l.molarMass) / SPECIES.C2H5OH_l.density);
    cond.distillRateMlS = dMl / Math.max(1e-4, dt);
    cond.totalCondensedMl = (cond.totalCondensedMl || 0) + dMl;
    cond.activeDrop = true;

    if (dst) {
      const cOld = computeHeatCapacityJK(dst);
      const tCond = cond.waterFlowOn ? 291.15 : 335.0;
      let cAdd = 0;
      if (condW > 0) {
        dst.moles.H2O_l = (dst.moles.H2O_l || 0) + condW;
        cAdd += condW * SPECIES.H2O_l.cp;
      }
      if (condE > 0) {
        dst.moles.C2H5OH_l = (dst.moles.C2H5OH_l || 0) + condE;
        cAdd += condE * SPECIES.C2H5OH_l.cp;
      }
      if (absHCl > 0) {
        dst.moles.H_aq = (dst.moles.H_aq || 0) + absHCl;
        dst.moles.Cl_aq = (dst.moles.Cl_aq || 0) + absHCl;
      }
      if (absNH3 > 0) {
        dst.moles.NH3_aq = (dst.moles.NH3_aq || 0) + absNH3;
      }
      if (cOld + cAdd > 0) {
        dst.tempK = (cOld * dst.tempK + cAdd * tCond) / (cOld + cAdd);
      }
    }
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

    // Ignition source over exposed Sodium
    if ((v.moles.Na_s || 0) > 1e-7 && dist <= 52) {
      v.naTempK = Math.max(v.naTempK ?? v.tempK, 720);
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
        (m.Na2O_s || 0) + (m.Na2O2_s || 0) > 1e-6;
      const hasCa =
        (m.Ca2_aq || 0) + (m.CaCl2_s || 0) + (m.CaNO3_2_s || 0) + (m.CaCO3_s || 0) +
        (m.CaO_s || 0) + (m.CaOH2_s || 0) + (m.CaSO4_s || 0) > 1e-6;
      const hasCu =
        (m.Cu2_aq || 0) + (m.CuCl4_2_aq || 0) + (m.CuNH3_4_2_aq || 0) + (m.CuOH4_2_aq || 0) +
        (m.CuSO4_5H2O_s || 0) + (m.CuSO4_s || 0) + (m.CuCl2_s || 0) + (m.CuNO3_2_s || 0) +
        (m.CuCO3_s || 0) + (m.CuO_s || 0) + (m.CuOH2_s || 0) > 1e-6;
      if (hasNa) {
        // Exp 17: 589 nm Na D-doublet quantum emission overwhelms & masks weaker Cu2+ / Ca2+ bands
        loop.sampledIon = 'Na⁺';
        loop.sampledColor = '#facc15';
        const maskedLabel =
          hasCu && hasCa ? 'Na⁺ (che Ca²⁺, Cu²⁺)' : hasCu ? 'Na⁺ (che Cu²⁺)' : hasCa ? 'Na⁺ (che Ca²⁺)' : 'Na⁺';
        loop.sampleLabel = maskedLabel;
        loop.maskedCuByNa = hasCu || hasCa;
        loop.maskedTargetName = hasCa && !hasCu ? 'Ca²⁺' : 'Cu²⁺';
      } else if (hasCa) {
        loop.sampledIon = 'Ca²⁺';
        loop.sampledColor = '#ef4444';
        loop.sampleLabel = 'Ca²⁺ (Đỏ gạch · 622 nm)';
        loop.maskedCuByNa = false;
      } else if (hasCu) {
        loop.sampledIon = 'Cu²⁺';
        loop.sampledColor = '#10b981';
        loop.sampleLabel = 'Cu²⁺';
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
        if ((v.moles.Cl2_aq || 0) > 1e-5) bleached = true;
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
    } else if (it.kind === 'tongs') {
      stepCrucibleTongs(sim, it, dt);
    } else if (it.kind === 'spoon') {
      stepIronSpoon(sim, it, dt);
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
 * Step metallic Crucible Tongs holding either a hot crucible/dish OR a gripped metal strip over flame.
 */
function stepCrucibleTongs(sim, tongs, dt) {
  if (!tongs || tongs.kind !== 'tongs') return;
  const { x: tipX, y: tipY } = getProbeTipPos(tongs);

  if (tongs.grippedVesselId) {
    const gv = sim.getItem(tongs.grippedVesselId);
    if (!gv || gv.isShattered) {
      tongs.grippedVesselId = null;
    } else {
      gv.x = tipX;
      gv.y = tipY;
      gv.restingOnId = null;
      gv.vy = 0;
    }
  }

  const sample = tongs.heldSample;
  if (!sample || (sample.moles || 0) <= 1e-8) {
    tongs.heldBurnTimer = Math.max(0, (tongs.heldBurnTimer || 0) - dt);
    if (!sample) return;
  }

  // Thermal exchange with nearest active burner plume (alcohol OR roaring Bunsen)
  let flameTargetK = sim.environment.tempK || CONSTANTS.T_STD_K;
  let kHeat = 0.08;
  for (const b of sim.items) {
    if (b.kind !== 'burner' || (b.powerW || 0) <= 0) continue;
    const bSpec = APPARATUS[b.typeId] || APPARATUS.burner;
    const nozzleY = b.typeId === 'bunsen_burner' ? b.y + bSpec.height / 2 - 68 : b.y + bSpec.height / 2 - 46;
    const dx = Math.abs(tipX - b.x);
    if (dx <= 42 && tipY <= nozzleY + 12 && tipY >= nozzleY - 88) {
      const fl = Math.round(b.flameLevel || 3);
      const isBunsen = b.typeId === 'bunsen_burner';
      const airOpen = b.airHoleOpen !== false;
      const peakK = isBunsen
        ? (airOpen ? bSpec.effectiveFlameK[fl] || 1520 : bSpec.yellowFlameK[fl] || 950)
        : (bSpec.effectiveFlameK[fl] || 696);
      flameTargetK = Math.max(flameTargetK, peakK);
      kHeat = isBunsen && airOpen ? 1.45 : 0.72;
    }
  }

  if (sample && sample.moles > 1e-8) {
    sample.tempK = (sample.tempK ?? 298.15) + (flameTargetK - (sample.tempK ?? 298.15)) * Math.min(1, kHeat * dt);
    const atmMode = sim.environment.atmosphereMode || 'air';
    if (atmMode === 'air') {
      if (sample.speciesId === 'Na_s' && sample.tempK >= 393.15) {
        const dBurn = Math.min(sample.moles, Math.max(1e-5, sample.moles * 1.4 * dt));
        sample.moles -= dBurn;
        tongs.heldBurnTimer = 0.9;
        tongs.heldFlameColor = 'yellow_na';
        if (sample.moles < 1e-7) {
          sample.speciesId = 'Na2O2_s';
          sample.moles = dBurn * 0.48;
          sim.addLog({
            type: 'reaction',
            equation: '2Na(s/l) + O₂(g) → Na₂O₂(s) (cháy ngọn lửa vàng 589 nm)',
            nameVi: 'Đốt cháy Sodium trên kẹp kim loại (ngọn lửa vàng → Na₂O₂)',
            nameEn: 'Sodium combustion held on crucible tongs (yellow flame → Na₂O₂)',
            descVi: 'Sodium bốc cháy ở ~120 °C với ngọn lửa vàng rực tạo Sodium peroxide vàng nhạt.',
            descEn: 'Tongs-held Sodium ignites around 120 °C with bright yellow 589 nm flame yielding Na₂O₂.',
            vesselLabel: tongs.label,
          });
        }
      } else if (sample.speciesId === 'Zn_s' && sample.tempK >= 1173.15) {
        const dBurn = Math.min(sample.moles, Math.max(1e-5, sample.moles * 0.9 * dt));
        sample.moles -= dBurn;
        tongs.heldBurnTimer = 1.0;
        tongs.heldFlameColor = 'cyan_zn';
        if (sample.moles < 1e-7) {
          sample.speciesId = 'ZnO_s';
          sample.moles = dBurn;
          sim.addLog({
            type: 'reaction',
            equation: '2Zn(hơi) + O₂(g) —(≥ 907 °C)→ 2ZnO(s) (lửa xanh lam & khói trắng)',
            nameVi: 'Đốt cháy Zinc trên kẹp kim loại (ngọn lửa xanh lam & khói trắng ZnO)',
            nameEn: 'Zinc combustion on crucible tongs (cyan-blue flame & white ZnO smoke)',
            descVi: 'Hơi Zinc bốc cháy với ngọn lửa xanh lam nhạt đặc trưng sinh khói trắng dày đặc ZnO.',
            descEn: 'Zinc vapor burns with a pale bluish-cyan flame producing dense white ZnO smoke.',
            vesselLabel: tongs.label,
          });
        }
      }
    }
  }
}

/**
 * Step Iron Combustion / Deflagrating Spoon (heating over burner flames, burning Zn / Na / Cu / salts in air or O2/Cl2 jars).
 */
function stepIronSpoon(sim, spoon, dt) {
  if (!spoon || spoon.kind !== 'spoon') return;
  const { x: bowlX, y: bowlY } = getProbeTipPos(spoon);
  spoon.burnTimer = Math.max(0, (spoon.burnTimer || 0) - dt);

  // 1. Check thermal coupling with any active Alcohol or Bunsen burner flame plume
  let flameTargetK = sim.environment.tempK || CONSTANTS.T_STD_K;
  let kHeat = 0.14;
  let inBurnerFlame = false;
  for (const b of sim.items) {
    if (b.kind !== 'burner' || (b.powerW || 0) <= 0) continue;
    const bSpec = APPARATUS[b.typeId] || APPARATUS.burner;
    const nozzleY = b.typeId === 'bunsen_burner' ? b.y + bSpec.height / 2 - 68 : b.y + bSpec.height / 2 - 46;
    const dx = Math.abs(bowlX - b.x);
    if (dx <= 46 && bowlY <= nozzleY + 14 && bowlY >= nozzleY - 94) {
      const fl = Math.round(b.flameLevel || 3);
      const isBunsen = b.typeId === 'bunsen_burner';
      const airOpen = b.airHoleOpen !== false;
      const peakK = isBunsen
        ? (airOpen ? bSpec.effectiveFlameK[fl] || 1520 : bSpec.yellowFlameK[fl] || 950)
        : (bSpec.effectiveFlameK[fl] || 720);
      flameTargetK = Math.max(flameTargetK, peakK);
      kHeat = isBunsen && airOpen ? 1.55 : 0.92;
      inBurnerFlame = true;
    }
  }

  spoon.tempK = (spoon.tempK ?? 298.15) + (flameTargetK - (spoon.tempK ?? 298.15)) * Math.min(1, kHeat * dt);

  const moles = spoon.moles || {};
  const totalSolidMol = Object.values(moles).reduce((s, n) => s + (n > 0 ? n : 0), 0);
  if (totalSolidMol <= 1e-9) return;

  // 2. Check if spoon bowl is dipped inside a vessel headspace (e.g. O2 or Cl2 gas jar)
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

  const headO2 = hostV?.headspaceGasMoles?.O2_g || 0;
  const headCl2 = hostV?.headspaceGasMoles?.Cl2_g || 0;
  const inO2Jar = headO2 > 8e-5;
  const inCl2Jar = headCl2 > 8e-5;
  const inOpenAir = (sim.environment.atmosphereMode || 'air') === 'air';

  // A. Zinc combustion on spoon: 2Zn(s) + O2(g) -> 2ZnO(s) (cyan-blue flame + white ZnO smoke)
  const nZn = moles.Zn_s || 0;
  const znIgnK = inO2Jar ? 615.0 : inBurnerFlame ? 665.0 : 753.15;
  if (nZn > 1e-8 && spoon.tempK >= znIgnK && (inO2Jar || inOpenAir)) {
    const rateScale = inO2Jar ? 1.45 : 0.75;
    const maxByO2 = inO2Jar ? headO2 * 2 : nZn;
    const dBurn = Math.min(nZn, maxByO2, Math.max(8e-5 * dt, nZn * rateScale * dt));
    if (dBurn > 1e-10) {
      moles.Zn_s -= dBurn;
      if (moles.Zn_s < 1e-10) delete moles.Zn_s;
      moles.ZnO_s = (moles.ZnO_s || 0) + dBurn;
      if (inO2Jar && hostV?.headspaceGasMoles) {
        hostV.headspaceGasMoles.O2_g = Math.max(0, headO2 - 0.5 * dBurn);
      }
      spoon.burnTimer = 0.95;
      spoon.flameColor = 'cyan_zn';
      spoon.tempK = Math.max(spoon.tempK, 1180);
      if (sim.visualHooks?.onParticlesNeeded) {
        sim.visualHooks.onParticlesNeeded(
          { x: bowlX, y: bowlY + 8, typeId: 'crucible_porcelain', moles: { ZnO_s: mOrZero(moles.ZnO_s) }, tempK: spoon.tempK },
          { znBurning: true, heatRate: 800 }
        );
      }
      if ((sim.timeSec - (spoon.seenReactions?.zn_spoon_burn ?? -99)) > 4.0) {
        spoon.seenReactions = spoon.seenReactions || {};
        spoon.seenReactions.zn_spoon_burn = sim.timeSec;
        sim.addLog({
          type: 'reaction',
          equation: '2Zn(s) + O₂(g) —(t°)→ 2ZnO(s) (ngọn lửa xanh lam & khói trắng)',
          nameVi: 'Đốt cháy Zinc trên thìa sắt tạo Zinc oxide trắng',
          nameEn: 'Zinc combustion on iron spoon forming white ZnO(s)',
          descVi: 'Zinc trên thìa sắt bốc cháy với ngọn lửa xanh lam nhạt đặc trưng và khói trắng ZnO (khi nóng có màu vàng, để nguội hóa trắng).',
          descEn: 'Zinc on the iron spoon burns with a pale bluish-cyan flame and dense white ZnO smoke (yellow while hot, white when cooled).',
          vesselLabel: spoon.label,
        });
      }
    }
  }

  // B. Sodium combustion on spoon: 2Na + O2 -> Na2O2 (589 nm yellow flame) or 2Na + Cl2 -> 2NaCl
  const nNa = moles.Na_s || 0;
  if (nNa > 1e-8 && inCl2Jar && spoon.tempK >= 360) {
    const dBurn = Math.min(nNa, headCl2 * 2, Math.max(1e-4 * dt, nNa * 1.6 * dt));
    moles.Na_s -= dBurn;
    if (moles.Na_s < 1e-10) delete moles.Na_s;
    moles.NaCl_s = (moles.NaCl_s || 0) + dBurn;
    hostV.headspaceGasMoles.Cl2_g = Math.max(0, headCl2 - 0.5 * dBurn);
    spoon.burnTimer = 0.95;
    spoon.flameColor = 'yellow_na';
    spoon.tempK = Math.max(spoon.tempK, 980);
  } else if (nNa > 1e-8 && spoon.tempK >= 393.15 && (inO2Jar || inOpenAir)) {
    const maxByO2 = inO2Jar ? headO2 : nNa;
    const dBurn = Math.min(nNa, maxByO2, Math.max(1e-4 * dt, nNa * 1.35 * dt));
    if (dBurn > 1e-10) {
      moles.Na_s -= dBurn;
      if (moles.Na_s < 1e-10) delete moles.Na_s;
      moles.Na2O2_s = (moles.Na2O2_s || 0) + dBurn * 0.45;
      moles.Na2O_s = (moles.Na2O_s || 0) + dBurn * 0.05;
      if (inO2Jar && hostV?.headspaceGasMoles) {
        hostV.headspaceGasMoles.O2_g = Math.max(0, headO2 - 0.95 * dBurn);
      }
      spoon.burnTimer = 0.95;
      spoon.flameColor = 'yellow_na';
      spoon.tempK = Math.max(spoon.tempK, 920);
      if (sim.visualHooks?.onParticlesNeeded) {
        sim.visualHooks.onParticlesNeeded(
          { x: bowlX, y: bowlY + 8, typeId: 'crucible_porcelain', moles: { Na2O2_s: mOrZero(moles.Na2O2_s) }, tempK: spoon.tempK },
          { naDryBurning: true }
        );
      }
      if ((sim.timeSec - (spoon.seenReactions?.na_spoon_burn ?? -99)) > 4.0) {
        spoon.seenReactions = spoon.seenReactions || {};
        spoon.seenReactions.na_spoon_burn = sim.timeSec;
        sim.addLog({
          type: 'reaction',
          equation: '2Na(s/l) + O₂(g) → Na₂O₂(s) (cháy ngọn lửa vàng 589 nm)',
          nameVi: 'Đốt cháy Sodium trên thìa sắt (ngọn lửa vàng → Na₂O₂)',
          nameEn: 'Sodium combustion on iron spoon (yellow flame → Na₂O₂)',
          descVi: 'Sodium nóng chảy trên thìa sắt bốc cháy với ngọn lửa vàng 589 nm tạo Sodium peroxide vàng nhạt.',
          descEn: 'Molten Sodium on the iron spoon burns with an intense 589 nm yellow flame yielding pale-yellow Na₂O₂.',
          vesselLabel: spoon.label,
        });
      }
    }
  }

  // C. Copper thermal oxidation on spoon: 2Cu + O2 -> 2CuO (black)
  const nCu = moles.Cu_s || 0;
  if (nCu > 1e-8 && spoon.tempK >= 585 && (inO2Jar || inOpenAir)) {
    const dOx = Math.min(nCu, Math.max(4e-5 * dt, nCu * 0.45 * dt));
    moles.Cu_s -= dOx;
    if (moles.Cu_s < 1e-10) delete moles.Cu_s;
    moles.CuO_s = (moles.CuO_s || 0) + dOx;
    if (inBurnerFlame && spoon.tempK >= 820) {
      spoon.burnTimer = Math.max(spoon.burnTimer || 0, 0.35);
      spoon.flameColor = 'emerald_cu';
    }
  }

  // D. Solid thermal decompositions directly on heated spoon (CuSO4.5H2O, Cu(OH)2, CuCO3, CaCO3)
  if ((moles.CuSO4_5H2O_s || 0) > 1e-8 && spoon.tempK >= 385) {
    const d = Math.min(moles.CuSO4_5H2O_s, moles.CuSO4_5H2O_s * 0.65 * dt);
    moles.CuSO4_5H2O_s -= d;
    if (moles.CuSO4_5H2O_s < 1e-10) delete moles.CuSO4_5H2O_s;
    moles.CuSO4_s = (moles.CuSO4_s || 0) + d;
  }
  if ((moles.CuOH2_s || 0) > 1e-8 && spoon.tempK >= 440) {
    const d = Math.min(moles.CuOH2_s, moles.CuOH2_s * 0.75 * dt);
    moles.CuOH2_s -= d;
    if (moles.CuOH2_s < 1e-10) delete moles.CuOH2_s;
    moles.CuO_s = (moles.CuO_s || 0) + d;
  }
  if ((moles.CuCO3_s || 0) > 1e-8 && spoon.tempK >= 480) {
    const d = Math.min(moles.CuCO3_s, moles.CuCO3_s * 0.75 * dt);
    moles.CuCO3_s -= d;
    if (moles.CuCO3_s < 1e-10) delete moles.CuCO3_s;
    moles.CuO_s = (moles.CuO_s || 0) + d;
  }
  if ((moles.CaCO3_s || 0) > 1e-8 && spoon.tempK >= 1120) {
    const d = Math.min(moles.CaCO3_s, moles.CaCO3_s * 0.45 * dt);
    moles.CaCO3_s -= d;
    if (moles.CaCO3_s < 1e-10) delete moles.CaCO3_s;
    moles.CaO_s = (moles.CaO_s || 0) + d;
  }
}

function mOrZero(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}
