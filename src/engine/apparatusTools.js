import { APPARATUS } from '../data/apparatus.js';
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
 * Gravity liquid-only filtration (Phase 'l' & 'aq' pass through; ALL phase 's' solids stay on filter paper).
 */
function stepFilterFunnel(sim, funnel, dt) {
  funnel.isFiltering = false;
  funnel.filtrateTargetId = null;

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
  const spoutX = cond.x + 68;
  const spoutY = cond.y + 18;
  const dst = findOpenVesselBelowPoint(sim.items, spoutX, spoutY - 8, 58, 0, 320);

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
  const tipX = splint.x - 52;
  const tipY = splint.y;

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

    // Burning splint + H2 -> "Pop!" test
    if (splint.mode === 'burning' && h2Pocket > 6e-5) {
      splint.cooldownTimer = 1.6;
      splint.lastTestEvent = 'h2_pop';
      splint.lastEventTimer = 1.6;
      if (v.headspaceGasMoles?.H2_g > 0) {
        const burnH2 = Math.min(v.headspaceGasMoles.H2_g, 0.004);
        v.headspaceGasMoles.H2_g = Math.max(0, v.headspaceGasMoles.H2_g - burnH2);
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

    // Glowing ember splint + O2 -> Relights brightly
    if (splint.mode === 'glowing' && o2Pocket > 6e-5) {
      splint.mode = 'burning';
      splint.cooldownTimer = 1.6;
      splint.lastTestEvent = 'o2_relight';
      splint.lastEventTimer = 1.6;
      sim.addLog({
        type: 'reaction',
        equation: 'C(tàn đóm) + O₂(g) dư → CO₂(g) (Bùng cháy rực rỡ)',
        nameVi: 'Thử khí Oxygen: Tàn đóm đỏ bùng cháy lại mạnh mẽ',
        nameEn: 'Splint Test: Glowing splint bursts back into flame in O₂(g)',
        descVi: 'Môi trường giàu O₂(g) làm tàn đóm đỏ lập tức bùng ngọn lửa sáng rực.',
        descEn: 'Elevated O₂(g) concentration immediately relights a glowing ember into bright flame.',
        vesselLabel: `${splint.label} → ${v.label}`,
      });
      if (sim.visualHooks.onAlert) {
        sim.visualHooks.onAlert('o2_relight', { x: tipX, y: tipY }, { vesselId: v.id });
      }
      return 'o2_relight';
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
  const tipX = loop.x - 50;
  const tipY = loop.y;

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
        loop.sampleLabel = 'Cu²⁺ (510 nm Green)';
      } else if (hasNa) {
        loop.sampledIon = 'Na⁺';
        loop.sampledColor = '#facc15';
        loop.sampleLabel = 'Na⁺ (589 nm Yellow)';
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
  const tipX = strip.x - 24;
  const tipY = strip.y;

  for (const v of sim.items) {
    if (v.kind !== 'vessel' || v.isShattered) continue;
    const spec = APPARATUS[v.typeId];
    const rimY = v.y - spec.height / 2;
    const inVesselBody = Math.abs(tipX - v.x) <= spec.width * 0.5 && tipY >= rimY - 10 && tipY <= v.y + spec.height * 0.48;
    const nearOpenMouth = !v.isStoppered && Math.hypot(tipX - v.x, tipY - rimY) <= 50;
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
      const rCl2 = v.lastGasRateMap?.Cl2_g || 0;
      const concHCl = (v.moles.H_aq || 0) / Math.max(0.01, computeLiquidVolumeL(v.moles, v.tempK) || 0.01);
      if (rCl2 > 8e-6) {
        detectedPH = 2.0;
        bleached = true;
        sourceTag = `Cl₂ (${v.label})`;
      } else if (rHCl > 8e-6 || (concHCl > 6.5 && v.tempK >= 268.15)) {
        detectedPH = 1.5;
        sourceTag = `HCl(g) (${v.label})`;
      } else if (rNH3 > 8e-6) {
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
    } else if (it.kind === 'burette') {
      stepBurette(sim, it, dt);
    } else if (it.kind === 'condenser') {
      stepLiebigCondenser(sim, it, dt);
    } else if (it.kind === 'splint') {
      if ((it.cooldownTimer || 0) > 0) it.cooldownTimer = Math.max(0, it.cooldownTimer - realDeltaSec);
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
    } else if (it.kind === 'wash_bottle' && it.isSpraying) {
      const target = findOpenVesselBelowPoint(sim.items, it.x - 24, it.y - 10, 85, -40, 260) ||
        sim.items.find((f) => f.kind === 'filter_funnel' && Math.hypot(f.x - (it.x - 24), f.y - it.y) <= 85);
      const waterMl = Math.min(it.waterMl || 0, 6.0 * dt);
      if (waterMl > 1e-4) {
        it.waterMl -= waterMl;
        if (target) {
          const addMol = (waterMl * 0.997) / SPECIES.H2O_l.molarMass;
          target.moles.H2O_l = (target.moles.H2O_l || 0) + addMol;
          it.sprayTargetId = target.id;
        }
      } else {
        it.isSpraying = false;
      }
    }
  }

  stepPneumaticTrough(sim);
  syncDockedToolPositions(sim);
}

/**
 * Mortar & Pestle solid comminution: boosts particle count -> jumps reactive surface area A_solid (Noyes-Whitney).
 */
export function grindMortarSolids(sim, mortarId) {
  const m = sim.getItem(mortarId);
  if (!m || !APPARATUS[m.typeId]?.isMortar) return false;
  let groundAny = false;
  const names = [];
  for (const [spId, n] of Object.entries(m.moles)) {
    const sp = SPECIES[spId];
    if (sp && sp.phase === 's' && n > 1e-8) {
      const cur = m.particleCounts[spId] || 6;
      m.particleCounts[spId] = Math.min(2400, Math.max(600, cur * 24));
      groundAny = true;
      names.push(sp.formula || spId);
    }
  }
  if (groundAny) {
    m.grindAnimTimer = 1.1;
    sim.addLog({
      type: 'reaction',
      equation: `${names.join(' + ')} (tinh thể lớn) —(Nghiền cối chày)→ Bột mịn (A_rắn ↑↑)`,
      nameVi: `Đã nghiền mịn ${names.join(', ')} bằng Cối & Chày sứ`,
      nameEn: `Ground ${names.join(', ')} into fine powder (Noyes–Whitney area ↑)`,
      descVi: 'Giảm kích thước hạt giúp tăng diện tích bề mặt tiếp xúc A_rắn, đẩy mạnh tốc độ hòa tan và phản ứng.',
      descEn: 'Reducing solid particle radius sharply increases reactive surface area A_solid.',
      vesselLabel: m.label,
    });
    sim.emitChange();
  }
  return groundAny;
}
