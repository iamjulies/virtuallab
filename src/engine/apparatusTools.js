import { APPARATUS, getCondenserPorts, getProbeTipPos } from '../data/apparatus.js';
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
 * Pneumatic Water Trough displacement: inverted tubes sitting in wet trough trap incoming tube gas & displace water down.
 */
function stepPneumaticTrough(sim) {
  const troughs = sim.items.filter((i) => i.typeId === 'water_trough' && !i.isShattered);
  for (const v of sim.items) {
    if (v.kind !== 'vessel' || v.isShattered || !v.isInverted) {
      if (v.kind === 'vessel') v.submergedInTroughId = null;
      continue;
    }
    const spec = APPARATUS[v.typeId];
    const mouthY = v.y + spec.height / 2;
    let matchedTrough = null;
    for (const tr of troughs) {
      const trSpec = APPARATUS.water_trough;
      const trTop = tr.y - trSpec.height / 2;
      const trBot = tr.y + trSpec.height / 2;
      const hasWater = (tr.moles.H2O_l || 0) > 1.0;
      if (hasWater && Math.abs(v.x - tr.x) <= 78 && mouthY >= trTop - 6 && mouthY <= trBot + 10) {
        matchedTrough = tr;
        break;
      }
    }
    v.submergedInTroughId = matchedTrough ? matchedTrough.id : null;
  }
}

/**
 * Test open/inverted vessel gas or nearby burner with Wooden Splint (H2 pop / O2 relight / Na ignite).
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

  for (const v of sim.items) {
    if (v.kind !== 'vessel' || v.isShattered || v.isStoppered) continue;
    const spec = APPARATUS[v.typeId];
    const testY = v.isInverted ? v.y + spec.height / 2 : v.y - spec.height / 2;
    const dist = Math.hypot(tipX - v.x, tipY - testY);
    if (dist > 62) continue;

    const h2Pocket = (v.headspaceGasMoles?.H2_g || 0) + (v.lastGasRateMap?.H2_g || 0) * 1.5;
    const o2Pocket = (v.headspaceGasMoles?.O2_g || 0) + (v.lastGasRateMap?.O2_g || 0) * 1.5;

    // Phenomenon #6: Burning splint + mixed Oxyhydrogen (2H2 : 1O2) scaled detonation OR lean H2 "Pop!" test
    if (splint.mode === 'burning' && h2Pocket > 6e-5) {
      splint.cooldownTimer = 1.6;
      const headH2 = v.headspaceGasMoles?.H2_g || 0;
      const headO2 = v.headspaceGasMoles?.O2_g || 0;
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
    if (splint.mode === 'glowing' && o2Pocket > 6e-5) {
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

    if (splint.mode === 'burning' && o2Pocket > 6e-5 && h2Pocket <= 6e-5) {
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

  // 1. Sample from vessel interior/liquid
  for (const v of sim.items) {
    if (v.kind !== 'vessel' || v.isShattered) continue;
    const spec = APPARATUS[v.typeId];
    if (Math.abs(tipX - v.x) <= spec.width * 0.48 && Math.abs(tipY - v.y) <= spec.height * 0.52) {
      const hasCu = (v.moles.Cu2_aq || 0) + (v.moles.CuCl4_2_aq || 0) + (v.moles.CuSO4_5H2O_s || 0) + (v.moles.CuCl2_s || 0) > 1e-6;
      const hasNa = (v.moles.Na_aq || 0) + (v.moles.Na_s || 0) + (v.moles.NaOH_s || 0) + (v.moles.NaCl_s || 0) > 1e-6;
      if (hasCu) {
        loop.sampledIon = 'Cu²⁺';
        loop.sampledColor = '#10b981';
        loop.sampleLabel = 'Cu²⁺';
      } else if (hasNa) {
        loop.sampledIon = 'Na⁺';
        loop.sampledColor = '#facc15';
        loop.sampleLabel = 'Na⁺';
      }
    }
  }

  // 2. Apply emission spectrum onto lit Alcohol Burner when loop tip enters flame
  if (loop.sampledIon) {
    for (const b of sim.items) {
      if (b.kind !== 'burner' || (b.powerW || 0) <= 10) continue;
      const flameY = b.y - APPARATUS.burner.height / 2 - 16;
      if (Math.hypot(tipX - b.x, tipY - flameY) <= 46) {
        b.flameTestTimer = 1.8;
        b.flameTestColor = loop.sampledColor;
        b.flameTestIon = loop.sampledIon;
        if ((loop.logCooldown || 0) <= 0) {
          loop.logCooldown = 5.0;
          sim.addLog({
            type: 'reaction',
            equation: `${loop.sampledIon}* → ${loop.sampledIon} + hν (${loop.sampleLabel})`,
            nameVi: `Thử màu ngọn lửa: Ion ${loop.sampledIon} phát quang đặc trưng`,
            nameEn: `Flame Test: Characteristic ${loop.sampleLabel} emission`,
            descVi: `Ion ${loop.sampledIon} kích thích nhiệt trong ngọn lửa đèn cồn phát xạ bước sóng đặc trưng.`,
            descEn: `Thermal excitation of ${loop.sampledIon} emits its characteristic atomic flame line.`,
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
    if (it.kind === 'electrode' && it.dockedVesselId) {
      const v = sim.getItem(it.dockedVesselId);
      if (!v || v.isShattered) {
        it.dockedVesselId = null;
        continue;
      }
      const vSpec = APPARATUS[v.typeId];
      const eSpec = APPARATUS[it.typeId];
      const dxOff = it.dockSide === 'right' ? Math.min(22, vSpec.width * 0.28) : -Math.min(22, vSpec.width * 0.28);
      it.x = v.x + dxOff;
      it.y = v.y - vSpec.height * 0.14;
      it.vy = 0;
      it.fallStartY = null;
      if (eSpec) it.restingOnId = null;
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
    } else if (it.kind === 'wash_bottle') {
      if ((it.squirtTimer || 0) > 0) {
        it.squirtTimer = Math.max(0, it.squirtTimer - realDeltaSec);
      }
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
