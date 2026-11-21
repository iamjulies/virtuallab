import { CONSTANTS } from '../data/constants.js';
import { APPARATUS } from '../data/apparatus.js';
import { computeLiquidVolumeL } from './equilibrium.js';

export const ELECTRODE_MATERIALS = {
  C: { id: 'C', formula: 'C(graphite)', color: '#1e293b', stroke: '#64748b', e0: null, nameVi: 'Graphite (C)', nameEn: 'Graphite (C)' },
  Cu: { id: 'Cu', formula: 'Cu(s)', color: '#d97706', stroke: '#f59e0b', e0: 0.3419, nameVi: 'Copper (Cu)', nameEn: 'Copper (Cu)' },
  Zn: { id: 'Zn', formula: 'Zn(s)', color: '#94a3b8', stroke: '#cbd5e1', e0: -0.7618, nameVi: 'Zinc (Zn)', nameEn: 'Zinc (Zn)' },
};

function addMolSafe(moles, id, delta) {
  const next = (moles[id] || 0) + delta;
  if (next <= 1e-13) delete moles[id];
  else moles[id] = next;
}

function getElectrodeLiquidInfo(items, elec) {
  if (!elec || !elec.dockedVesselId) return null;
  const v = items.find((i) => i.id === elec.dockedVesselId && i.kind === 'vessel' && !i.isShattered);
  if (!v || v.isFrozenSolid) return null;
  const liqL = computeLiquidVolumeL(v.moles, v.tempK);
  const hasMoltenNaCl =
    (v.moles.NaCl_s || 0) > 1e-6 &&
    v.tempK >= 1073.85 &&
    (v.moles.H2O_l || 0) < 0.005;
  const hasMoltenBaCl2 =
    (v.moles.BaCl2_s || 0) > 1e-6 &&
    v.tempK >= 1235.15 &&
    (v.moles.H2O_l || 0) < 0.005;
  if ((hasMoltenNaCl || hasMoltenBaCl2) && liqL <= 1e-5) {
    const moltenVolL = Math.max(
      0.01,
      ((v.moles.NaCl_s || 0) * 58.44 + (v.moles.BaCl2_s || 0) * 208.23) / 1800 / 1000
    );
    return { vessel: v, liqL: moltenVolL, isMoltenNaCl: hasMoltenNaCl, isMoltenBaCl2: hasMoltenBaCl2 };
  }
  if (elec.immersedFrac !== undefined && elec.immersedFrac <= 0.01) return null;
  if (liqL <= 1e-5 || (v.moles.H2O_l || 0) <= 1e-5) return null;
  return { vessel: v, liqL, isMoltenNaCl: false };
}

function findBridgingSaltBridgePath(items, vIdA, vIdB) {
  if (!vIdA || !vIdB || vIdA === vIdB) return [];
  const validBridges = items.filter(
    (sb) => sb.kind === 'salt_bridge' && !sb.isBroken && sb.vesselAId && sb.vesselBId && sb.vesselAId !== sb.vesselBId
  );
  const visited = new Set([vIdA]);
  const queue = [{ vId: vIdA, path: [] }];
  while (queue.length > 0) {
    const { vId, path } = queue.shift();
    for (const sb of validBridges) {
      const nextId = sb.vesselAId === vId ? sb.vesselBId : sb.vesselBId === vId ? sb.vesselAId : null;
      if (!nextId || visited.has(nextId)) continue;
      if (nextId !== vIdB) {
        // Intermediate series vessel must contain conductive aqueous liquid electrolyte
        const midV = items.find((it) => it.id === nextId && it.kind === 'vessel' && !it.isShattered);
        if (!midV) continue;
        const midLiq = computeLiquidVolumeL(midV.moles || {}, midV.tempK || 298.15);
        const midIon =
          (midV.moles?.H_aq || 0) +
          (midV.moles?.OH_aq || 0) +
          (midV.moles?.Na_aq || 0) +
          (midV.moles?.K_aq || 0) +
          (midV.moles?.Cu2_aq || 0) +
          (midV.moles?.Ag_aq || 0) +
          (midV.moles?.Zn2_aq || 0) +
          (midV.moles?.Cl_aq || 0) +
          (midV.moles?.SO4_2_aq || 0) +
          (midV.moles?.NO3_aq || 0);
        if (midLiq < 0.002 || midIon < 1e-5) continue;
      }
      const nextPath = [...path, sb];
      if (nextId === vIdB) return nextPath;
      visited.add(nextId);
      queue.push({ vId: nextId, path: nextPath });
    }
  }
  return null;
}

/**
 * Compute standard/Nernst Galvanic cell EMF between two half-cell electrodes.
 * Accounts for free [Cu2+] depressed by NH3/OH-/Cl- complexation (beta4 ~ 1.1e13 for [Cu(NH3)4]2+),
 * restored immediately upon acidification.
 */
function computeHalfCellPotentialV(mat, vessel, liqL) {
  const safeVolL = Math.max(1e-4, liqL);
  const rt2F = (CONSTANTS.R_J_MOL_K * vessel.tempK) / (2 * CONSTANTS.FARADAY_C_MOL);
  if (mat === 'Cu') {
    const cFreeCu = (vessel.moles.Cu2_aq || 0) / safeVolL;
    const cCuAmm = (vessel.moles.CuNH3_4_2_aq || 0) / safeVolL;
    const cCuOH4 = (vessel.moles.CuOH4_2_aq || 0) / safeVolL;
    const cNH3 = Math.max(0.01, (vessel.moles.NH3_aq || 0) / safeVolL);
    const cOH = Math.max(1e-7, (vessel.moles.OH_aq || 0) / safeVolL);
    let cEff = cFreeCu;
    if (cEff < 1e-6) {
      if (cCuAmm > 1e-8) {
        // beta4([Cu(NH3)4]2+) = 1.1e13 -> shifts E(Cu2+/Cu) down strongly (~ -0.35 to -0.45 V relative shift)
        cEff = Math.max(1e-18, cCuAmm / (1.1e13 * Math.pow(cNH3, 4)));
      } else if ((vessel.moles.CuOH2_s || 0) > 1e-8) {
        // Ksp(Cu(OH)2) = 2.2e-20
        cEff = Math.max(1e-18, 2.2e-20 / Math.pow(cOH, 2));
      } else if (cCuOH4 > 1e-8) {
        cEff = Math.max(1e-19, cCuOH4 / (1e16 * Math.pow(cOH, 4)));
      }
    }
    cEff = Math.max(1e-18, cEff);
    return 0.3419 + rt2F * Math.log(cEff);
  }
  if (mat === 'Zn') {
    const cZnFree = (vessel.moles.Zn2_aq || 0) / safeVolL;
    const cZincate = (vessel.moles.ZnOH4_2_aq || 0) / safeVolL;
    const cOH = Math.max(1e-4, (vessel.moles.OH_aq || 0) / safeVolL);
    let cEff = cZnFree;
    if (cEff < 1e-7 && cZincate > 1e-8) {
      cEff = Math.max(1e-18, cZincate / (3.0e15 * Math.pow(cOH, 4)));
    }
    cEff = Math.max(1e-18, cEff || 1e-5);
    return -0.7618 + rt2F * Math.log(cEff);
  }
  const cH = Math.max(1e-7, (vessel.moles.H_aq || 0) / safeVolL);
  return 0.0 + rt2F * 2 * Math.log(cH);
}

function resolveMeterElectrodes(meter, electrodes) {
  let elPos = electrodes.find((e) => e.id === meter.posElectrodeId && e.dockedVesselId);
  let elNeg = electrodes.find((e) => e.id === meter.negElectrodeId && e.dockedVesselId);
  const docked = electrodes
    .filter((e) => e.dockedVesselId)
    .sort((a, b) => Math.hypot(a.x - meter.x, a.y - meter.y) - Math.hypot(b.x - meter.x, b.y - meter.y));

  if ((!elPos || !elNeg || elPos.id === elNeg.id) && docked.length >= 2) {
    const pair = docked.slice(0, 2).sort((a, b) => a.x - b.x);
    elPos = pair[0];
    elNeg = pair[1];
    meter.posElectrodeId = elPos.id;
    meter.negElectrodeId = elNeg.id;
  }
  return { elPos, elNeg };
}

/**
 * Resolve wiring pairs and step Faraday electrolysis, Galvanic cells, Volt-Ammeter & electrode etching/protection.
 */
export function stepElectrochemistry(sim, dt) {
  const items = sim.items;
  const electrodes = items.filter((i) => i.kind === 'electrode');
  const supplies = items.filter((i) => i.kind === 'dc_power');
  const meters = items.filter((i) => i.kind === 'volt_ammeter');
  const bridges = items.filter((i) => i.kind === 'salt_bridge' && !i.isBroken);
  const CATHODE_AREA_DM2 = 0.04; // ~4.0 cm2 immersed electrode tip area

  // Clear stale per-frame flags on electrodes and vessels
  for (const el of electrodes) {
    el.gasBubbleType = null;
    el.gasBubbleRate = 0;
    el.polarityLabel = '';
    el.currentDensityADm2 = 0;
    el.cathodicProtectedActive = false;
  }
  for (const v of items) {
    if (v.kind === 'vessel') v.cathodicProtectedByZn = false;
  }

  // Phenomenon #9B: Etch copper electroplate or Cu electrode surface when dipped in alkaline NH3 + H2O2
  for (const el of electrodes) {
    const info = getElectrodeLiquidInfo(items, el);
    if (!info) continue;
    const { vessel: v, liqL } = info;
    const nNH3 = v.moles.NH3_aq || 0;
    const nPerox = v.moles.H2O2_aq || 0;
    if ((el.platedCuMol || 0) > 1e-7 && nNH3 > 1e-4 && nPerox > 1e-4) {
      const remCuRatio = (v.moles.Cu_s || 0) / Math.max(1e-7, el.platedCuMol);
      if ((v.moles.Cu_s || 0) <= 1e-7) {
        const cNH3 = nNH3 / liqL;
        const cPerox = nPerox / liqL;
        const dEtch = Math.min(el.platedCuMol, nNH3 / 4, nPerox, 0.0025 * Math.min(3, cNH3) * Math.min(3, cPerox) * dt);
        if (dEtch > 1e-10) {
          el.platedCuMol = Math.max(0, el.platedCuMol - dEtch);
          addMolSafe(v.moles, 'NH3_aq', -4 * dEtch);
          addMolSafe(v.moles, 'H2O2_aq', -dEtch);
          addMolSafe(v.moles, 'CuNH3_4_2_aq', dEtch);
          addMolSafe(v.moles, 'OH_aq', 2 * dEtch);
        }
      } else {
        el.platedCuMol = Math.min(el.platedCuMol, v.moles.Cu_s || 0);
      }
      if (el.platedCuMol < 1e-7 || remCuRatio < 0.02) {
        el.platedCuMol = 0;
        el.platedMaterial = null;
        el.platedQuality = null;
      }
    }
  }

  // Reset live circuit indicator on bridges before evaluating supplies & meters
  for (const sb of bridges) {
    sb.activeCurrentA = 0;
    const valid = items.filter(
      (v) => v.kind === 'vessel' && !v.isShattered && !APPARATUS[v.typeId]?.isMortar && Math.abs(v.y - sb.y) <= 170
    );
    const leftCands = valid
      .filter((v) => v.x <= sb.x + 28 && Math.abs(v.x - sb.x) <= 175)
      .sort((a, b) => Math.abs(a.x - (sb.x - 48)) - Math.abs(b.x - (sb.x - 48)));
    const bestA = leftCands[0] || null;
    const rightCands = valid
      .filter((v) => (!bestA || v.id !== bestA.id) && v.x >= sb.x - 28 && Math.abs(v.x - sb.x) <= 175)
      .sort((a, b) => Math.abs(a.x - (sb.x + 48)) - Math.abs(b.x - (sb.x + 48)));
    const bestB = rightCands[0] || null;

    if (bestA && bestB && bestA.id !== bestB.id) {
      sb.vesselAId = bestA.x <= bestB.x ? bestA.id : bestB.id;
      sb.vesselBId = bestA.x <= bestB.x ? bestB.id : bestA.id;
    } else {
      sb.vesselAId = null;
      sb.vesselBId = null;
    }
  }

  for (const sup of supplies) {
    const { elPos, elNeg } = resolveMeterElectrodes(sup, electrodes);
    const infoPos = getElectrodeLiquidInfo(items, elPos);
    const infoNeg = getElectrodeLiquidInfo(items, elNeg);
    if (!infoPos || !infoNeg || !elPos || !elNeg) {
      sup.circuitMode = 'idle';
      sup.measuredV = 0;
      sup.measuredCurrentA = 0;
      sup.currentDensityADm2 = 0;
      continue;
    }

    // 1. Single-vessel Electrolysis Mode
    if (infoPos.vessel.id === infoNeg.vessel.id) {
      const v = infoPos.vessel;
      const liqL = infoPos.liqL;
      const vSet = Math.max(0, Math.min(12, sup.voltageV ?? 6.0));
      const rheoOhm = Math.max(0.2, Math.min(25, sup.rheostatOhm ?? 2.0));
      sup.circuitMode = 'electrolysis';

      if (!sup.powerOn || vSet < 0.2) {
        sup.measuredV = 0;
        sup.measuredCurrentA = 0;
        sup.currentDensityADm2 = 0;
        continue;
      }

      const isMoltenNaCl = Boolean(infoPos.isMoltenNaCl && infoNeg.isMoltenNaCl);
      const isMoltenBaCl2 = Boolean(infoPos.isMoltenBaCl2 && infoNeg.isMoltenBaCl2);
      const isMoltenSalt = isMoltenNaCl || isMoltenBaCl2;
      const cCu = ((v.moles.Cu2_aq || 0) + 0.65 * (v.moles.CuNH3_4_2_aq || 0)) / liqL;
      const cAg = (v.moles.Ag_aq || 0) / liqL;
      const cCl = (v.moles.Cl_aq || 0) / liqL;
      const hasPlatedAgAnode = elPos.platedMaterial === 'Ag' && (elPos.platedAgMol || 0) > 1e-8;
      const decompV = isMoltenSalt
        ? 3.6
        : hasPlatedAgAnode
        ? 0.12
        : elPos.material === 'Cu' && cCu > 0.01
        ? 0.15
        : cAg > 0.002
        ? 0.85
        : cCu > 0.005
        ? 1.15
        : 1.55;
      const ionConductivity = isMoltenSalt
        ? 1.0
        : Math.max(
            0.04,
            Math.min(
              1.0,
              0.08 +
                0.35 *
                  ((v.moles.H_aq || 0) +
                    (v.moles.OH_aq || 0) +
                    (v.moles.Cu2_aq || 0) +
                    (v.moles.Ag_aq || 0) +
                    (v.moles.NO3_aq || 0) +
                    (v.moles.Na_aq || 0) +
                    (v.moles.SO4_2_aq || 0) +
                    (v.moles.Cl_aq || 0)) /
                  Math.max(0.05, liqL)
            )
          );

      const effResistanceOhm = rheoOhm + 1.4 / ionConductivity;
      const currentA = vSet > decompV ? Math.min(5.0, (vSet - decompV) / effResistanceOhm) : 0;
      const jADm2 = currentA / CATHODE_AREA_DM2;
      sup.measuredV = vSet;
      sup.measuredCurrentA = currentA;
      sup.currentDensityADm2 = jADm2;
      elPos.polarityLabel = '+ Anode';
      elNeg.polarityLabel = `- Cathode (${jADm2.toFixed(1)} A/dm²)`;
      elNeg.currentDensityADm2 = jADm2;

      if (currentA <= 1e-4) continue;

      const neMol = (currentA * dt) / CONSTANTS.FARADAY_C_MOL;

      if (isMoltenSalt) {
        if (isMoltenBaCl2 && (v.moles.BaCl2_s || 0) > 1e-10) {
          const dElectBa = Math.min(v.moles.BaCl2_s || 0, neMol / 2);
          if (dElectBa > 1e-10) {
            addMolSafe(v.moles, 'BaCl2_s', -dElectBa);
            sim.emitElectrolysisGas(v, 'Cl2_g', dElectBa, elPos.x, elPos);
            elPos.gasBubbleType = 'Cl2_g';
            elPos.gasBubbleRate = dElectBa / Math.max(1e-4, dt);
          }
          continue;
        }
        const dElect = Math.min(v.moles.NaCl_s || 0, neMol);
        if (dElect > 1e-10) {
          addMolSafe(v.moles, 'NaCl_s', -dElect);
          addMolSafe(v.moles, 'Na_s', dElect);
          const dCl2M = dElect / 2;
          sim.emitElectrolysisGas(v, 'Cl2_g', dCl2M, elPos.x, elPos);
          elPos.gasBubbleType = 'Cl2_g';
          elPos.gasBubbleRate = dCl2M / Math.max(1e-4, dt);
          v.tempK = Math.min(1850, v.tempK + (currentA * vSet * 0.25 * dt) / Math.max(50, 2200 * liqL + 100));
          v.activeReactions = [
            ...(v.activeReactions || []),
            {
              id: 'electrolysis_molten_nacl',
              equation: '2NaCl(l) —(đpnc)→ 2Na + Cl₂(g)↑',
              nameVi: `Điện phân nóng chảy NaCl (${currentA.toFixed(2)} A)`,
              nameEn: `Molten NaCl electrolysis (${currentA.toFixed(2)} A)`,
              descVi: `NaCl nóng chảy trên 801 °C dẫn điện tốt, tạo kim loại Na ở Cathode (-) và khí Cl₂ vàng lục ở Anode (+).`,
              descEn: `Conductive molten NaCl (> 801 °C) electrolyzes into metallic Na at Cathode (-) and green-yellow Cl₂ gas at Anode (+).`,
              rateMolS: dElect / Math.max(1e-4, dt),
              vigorousGas: true,
              dXi: dElect,
            },
          ];
        }
        continue;
      }

      // Cathode (-) reduction: Ag+ > Cu2+ (free or ammine) > 2H+/2H2O -> H2(g)
      // Phenomenon #9A: Moderate J <= 6.5 A/dm2 plates bright salmon-pink Cu(s); high J > 6.5 A/dm2 gives burned powdery black Cu(s) + H2 co-evolution
      let cathDesc = '2H₂O + 2e⁻ → H₂(g)↑ + 2OH⁻';
      if ((v.moles.Ag_aq || 0) > 1e-7) {
        const dAg = Math.min(v.moles.Ag_aq, neMol);
        addMolSafe(v.moles, 'Ag_aq', -dAg);
        addMolSafe(v.moles, 'Ag_s', dAg);
        elNeg.platedMaterial = 'Ag';
        elNeg.platedAgMol = (elNeg.platedAgMol || 0) + dAg;
        elNeg.platedQuality = jADm2 <= 5.0 ? 'dendrite' : 'spongy';
        elNeg.dendriteSide = elPos.x >= elNeg.x ? 1 : -1;
        cathDesc = 'Ag⁺ + e⁻ → Ag(s) (Cây tinh thể Dendrite)';
      } else if ((v.moles.Cu2_aq || 0) > 1e-7) {
        const isBurned = jADm2 > 6.5;
        const cuFrac = isBurned ? 0.85 : 1.0;
        const dCu = Math.min(v.moles.Cu2_aq, (neMol * cuFrac) / 2);
        addMolSafe(v.moles, 'Cu2_aq', -dCu);
        addMolSafe(v.moles, 'Cu_s', dCu);
        elNeg.platedMaterial = 'Cu';
        elNeg.platedQuality = isBurned ? 'burned' : 'smooth';
        elNeg.platedCuMol = (elNeg.platedCuMol || 0) + dCu;
        if (isBurned) {
          if (!v.particleCounts) v.particleCounts = {};
          v.particleCounts.Cu_s = Math.max(v.particleCounts.Cu_s || 0, 900);
          const dH2Co = (neMol * 0.15) / 2;
          if ((v.moles.H2O_l || 0) > dH2Co * 2) {
            sim.emitElectrolysisGas(v, 'H2_g', dH2Co, elNeg.x, elNeg);
            elNeg.gasBubbleType = 'H2_g';
            elNeg.gasBubbleRate = dH2Co / Math.max(1e-4, dt);
          }
          cathDesc = 'Cu²⁺ + 2e⁻ → Cu(s) cháy đen + H₂↑ (J cao)';
        } else {
          cathDesc = 'Cu²⁺ + 2e⁻ → Cu(s) (mạ hồng mịn)';
        }
      } else if ((v.moles.CuNH3_4_2_aq || 0) > 1e-7) {
        const dCu = Math.min(v.moles.CuNH3_4_2_aq, neMol / 2);
        addMolSafe(v.moles, 'CuNH3_4_2_aq', -dCu);
        addMolSafe(v.moles, 'NH3_aq', 4 * dCu);
        addMolSafe(v.moles, 'Cu_s', dCu);
        elNeg.platedMaterial = 'Cu';
        elNeg.platedQuality = jADm2 > 6.5 ? 'burned' : 'smooth';
        elNeg.platedCuMol = (elNeg.platedCuMol || 0) + dCu;
        cathDesc = '[Cu(NH₃)₄]²⁺ + 2e⁻ → Cu(s) + 4NH₃';
      } else if ((v.moles.H_aq || 0) > neMol * 1.2) {
        const dH2 = neMol / 2;
        addMolSafe(v.moles, 'H_aq', -2 * dH2);
        sim.emitElectrolysisGas(v, 'H2_g', dH2, elNeg.x, elNeg);
        elNeg.gasBubbleType = 'H2_g';
        elNeg.gasBubbleRate = dH2 / Math.max(1e-4, dt);
        cathDesc = '2H⁺ + 2e⁻ → H₂(g)↑';
      } else if ((v.moles.H2O_l || 0) > neMol) {
        const dH2 = neMol / 2;
        addMolSafe(v.moles, 'H2O_l', -2 * dH2);
        addMolSafe(v.moles, 'OH_aq', 2 * dH2);
        sim.emitElectrolysisGas(v, 'H2_g', dH2, elNeg.x, elNeg);
        elNeg.gasBubbleType = 'H2_g';
        elNeg.gasBubbleRate = dH2 / Math.max(1e-4, dt);
      }

      // Anode (+) oxidation: Stripping plated Silver dendrites, Cu/Zn active dissolution, Cl- -> Cl2(g), or 2H2O -> O2(g) + 4H+
      let anDesc = '2H₂O → O₂(g)↑ + 4H⁺ + 4e⁻';
      if (elPos.platedMaterial === 'Ag' && (elPos.platedAgMol || 0) > 1e-8) {
        const dAgDiss = Math.min(elPos.platedAgMol, neMol);
        elPos.platedAgMol -= dAgDiss;
        if (elPos.platedAgMol < 1e-9) {
          elPos.platedAgMol = 0;
          elPos.platedMaterial = null;
          elPos.platedQuality = null;
        }
        addMolSafe(v.moles, 'Ag_s', -Math.min(v.moles.Ag_s || 0, dAgDiss));
        addMolSafe(v.moles, 'Ag_aq', dAgDiss);
        anDesc = 'Ag(s dendrite) → Ag⁺(aq) + e⁻ (Hòa tan đảo cực)';
      } else if (elPos.material === 'Cu') {
        const dCuDiss = neMol / 2;
        addMolSafe(v.moles, 'Cu2_aq', dCuDiss);
        anDesc = 'Cu(s) → Cu²⁺(aq) + 2e⁻';
      } else if (elPos.material === 'Zn') {
        const dZnDiss = neMol / 2;
        addMolSafe(v.moles, 'Zn2_aq', dZnDiss);
        anDesc = 'Zn(s) → Zn²⁺(aq) + 2e⁻';
      } else if (cCl >= 0.45 && (v.moles.Cl_aq || 0) > 1e-7) {
        const dCl2Raw = Math.min((v.moles.Cl_aq || 0) / 2, neMol / 2);
        const nOH = v.moles.OH_aq || 0;
        const dJavel = nOH >= 1e-7 ? Math.min(dCl2Raw * 0.55, nOH / 2) : 0;
        const dCl2Emit = dCl2Raw - dJavel;
        addMolSafe(v.moles, 'Cl_aq', -2 * dCl2Raw + dJavel);
        if (dJavel > 1e-11) {
          addMolSafe(v.moles, 'OH_aq', -2 * dJavel);
          addMolSafe(v.moles, 'ClO_aq', dJavel);
          addMolSafe(v.moles, 'H2O_l', dJavel);
        }
        if (dCl2Emit > 1e-11) {
          sim.emitElectrolysisGas(v, 'Cl2_g', dCl2Emit, elPos.x, elPos);
          elPos.gasBubbleType = 'Cl2_g';
          elPos.gasBubbleRate = dCl2Emit / Math.max(1e-4, dt);
        }
        anDesc = dJavel > 1e-10 ? '2Cl⁻ → Cl₂↑  (+ ClO⁻ Javel không màng ngăn)' : '2Cl⁻ → Cl₂(g)↑ + 2e⁻';
      } else if ((v.moles.H2O_l || 0) > neMol * 0.6) {
        const dO2 = neMol / 4;
        addMolSafe(v.moles, 'H2O_l', -2 * dO2);
        addMolSafe(v.moles, 'H_aq', 4 * dO2);
        sim.emitElectrolysisGas(v, 'O2_g', dO2, elPos.x, elPos);
        elPos.gasBubbleType = 'O2_g';
        elPos.gasBubbleRate = dO2 / Math.max(1e-4, dt);
      }

      v.tempK = Math.min(372, v.tempK + (currentA * vSet * 0.25 * dt) / Math.max(50, 4200 * liqL + 100));

      v.activeReactions = [
        ...(v.activeReactions || []),
        {
          id: 'electrolysis_cell',
          equation: `${cathDesc}  |  ${anDesc}`,
          nameVi: `Điện phân dung dịch (${currentA.toFixed(2)} A · J=${jADm2.toFixed(1)} A/dm²)`,
          nameEn: `Electrolysis (${currentA.toFixed(2)} A · J=${jADm2.toFixed(1)} A/dm²)`,
          descVi: `Dòng điện một chiều tách chất theo định luật Faraday tại Anode (+) và Cathode (-).`,
          descEn: `DC Faraday electrolysis decomposing species at Anode (+) and Cathode (-).`,
          rateMolS: neMol / Math.max(1e-4, dt),
          vigorousGas: false,
          dXi: neMol,
        },
      ];
    } else {
      // 2. Multi-vessel DC Electrolysis across 1 or more salt bridges in series OR Galvanic discharge
      const bridgePath = findBridgingSaltBridgePath(items, infoPos.vessel.id, infoNeg.vessel.id);
      const vSet = Math.max(0, Math.min(12, sup.voltageV ?? 6.0));
      const e1 = computeHalfCellPotentialV(elPos.material, infoPos.vessel, infoPos.liqL);
      const e2 = computeHalfCellPotentialV(elNeg.material, infoNeg.vessel, infoNeg.liqL);
      const emfV = Math.max(0, Math.abs(e1 - e2));
      const vPos = infoPos.vessel;
      const cClPos = (vPos.moles.Cl_aq || 0) / Math.max(1e-5, infoPos.liqL);
      const hasBridgeChain = Boolean(bridgePath && bridgePath.length >= 1);
      const forceTwoVesselElectrolysis = Boolean(
        hasBridgeChain && (sup.powerOn || emfV < 0.02) && vSet >= 1.8 && (cClPos >= 0.45 || vSet > emfV + 0.3)
      );
      if (forceTwoVesselElectrolysis) {
        if (!sup.powerOn) {
          sup.circuitMode = 'electrolysis';
          sup.measuredV = 0;
          sup.measuredCurrentA = 0;
          sup.currentDensityADm2 = 0;
        } else {
          stepTwoVesselElectrolysis(sim, sup, elPos, elNeg, infoPos, infoNeg, bridgePath, dt);
        }
      } else {
        stepGalvanicInstrument(sim, sup, elPos, elNeg, infoPos, infoNeg, items, dt, true);
      }
    }
  }

  // Dedicated Digital Volt–Ammeter (DMM) processing
  for (const meter of meters) {
    meter.cathodicProtectedActive = false;
    const { elPos, elNeg } = resolveMeterElectrodes(meter, electrodes);
    const infoPos = getElectrodeLiquidInfo(items, elPos);
    const infoNeg = getElectrodeLiquidInfo(items, elNeg);
    if (!infoPos || !infoNeg || !elPos || !elNeg) {
      meter.circuitMode = 'idle';
      meter.measuredV = 0;
      meter.measuredCurrentA = 0;
      continue;
    }

    if (infoPos.vessel.id === infoNeg.vessel.id) {
      // Phenomenon #10B: Same-vessel galvanic couple (e.g. Zn + Cu wired through Ammeter/Short) -> Sacrificial Cathodic Protection!
      const v = infoPos.vessel;
      const e1 = computeHalfCellPotentialV(elPos.material, v, infoPos.liqL);
      const e2 = computeHalfCellPotentialV(elNeg.material, v, infoPos.liqL);
      const emfV = Math.max(0, Math.abs(e1 - e2));
      const mode = meter.mode || 'voltmeter';

      if (elPos.material === elNeg.material || emfV < 0.02) {
        meter.circuitMode = 'same_vessel';
        meter.measuredV = emfV;
        meter.measuredCurrentA = 0;
        continue;
      }

      const cathEl = e1 >= e2 ? elPos : elNeg;
      const anEl = e1 >= e2 ? elNeg : elPos;
      cathEl.polarityLabel = `+ Cathode (${cathEl.material})`;
      anEl.polarityLabel = `- Anode (${anEl.material})`;

      if (mode === 'voltmeter') {
        meter.circuitMode = 'galvanic_couple';
        meter.measuredV = emfV;
        meter.measuredCurrentA = 0;
        continue;
      }

      const rShunt = mode === 'short' ? 0.15 : 2.2;
      const currentA = Math.min(3.0, emfV / rShunt);
      meter.circuitMode = 'cathodic_protection';
      meter.measuredV = mode === 'short' ? 0.02 : currentA * 0.25;
      meter.measuredCurrentA = currentA;

      if (anEl.material === 'Zn' && (cathEl.material === 'Cu' || cathEl.material === 'C')) {
        v.cathodicProtectedByZn = true;
        cathEl.cathodicProtectedActive = true;
        meter.cathodicProtectedActive = true;
        const neMol = (currentA * dt) / CONSTANTS.FARADAY_C_MOL;
        addMolSafe(v.moles, 'Zn2_aq', neMol / 2);
        if ((v.moles.H_aq || 0) > 1e-6) {
          const dH2 = Math.min(v.moles.H_aq / 2, neMol / 2);
          addMolSafe(v.moles, 'H_aq', -2 * dH2);
          sim.emitElectrolysisGas(v, 'H2_g', dH2, cathEl.x, cathEl);
          cathEl.gasBubbleType = 'H2_g';
          cathEl.gasBubbleRate = dH2 / Math.max(1e-4, dt);
        }
        v.activeReactions = [
          ...(v.activeReactions || []),
          {
            id: 'cathodic_protection',
            equation: `Zn(s) → Zn²⁺ + 2e⁻  ⟶  Cathode ${cathEl.material} được bảo vệ!`,
            nameVi: `Bảo vệ Catốt bằng Anode hi sinh Zn (${currentA.toFixed(2)} A)`,
            nameEn: `Sacrificial Zn Cathodic Protection on ${cathEl.material} (${currentA.toFixed(2)} A)`,
            descVi: `Electron từ Zn chảy sang bảo vệ hoàn toàn ${cathEl.material} không bị hòa tan; H₂ thoát ra trên bề mặt ${cathEl.material}.`,
            descEn: `Electron flux from Zn cathodically polarizes and protects ${cathEl.material} while evolving H₂ at cathode.`,
            rateMolS: neMol / Math.max(1e-4, dt),
            vigorousGas: false,
            dXi: neMol,
          },
        ];
      }
      continue;
    }

    const allowLoad = (meter.mode || 'voltmeter') !== 'voltmeter';
    stepGalvanicInstrument(sim, meter, elPos, elNeg, infoPos, infoNeg, items, dt, allowLoad, meter.mode === 'short' ? 0.25 : 2.2);
  }
}

function stepTwoVesselElectrolysis(sim, sup, elPos, elNeg, infoPos, infoNeg, bridgeOrPath, dt) {
  const bridgeList = Array.isArray(bridgeOrPath) ? bridgeOrPath : bridgeOrPath ? [bridgeOrPath] : [];
  const CATHODE_AREA_DM2 = 0.08;
  const vPos = infoPos.vessel;
  const vNeg = infoNeg.vessel;
  const vSet = Math.max(0, Math.min(12, sup.voltageV ?? 6.0));
  const rheoOhm = Math.max(0.2, Math.min(25, sup.rheostatOhm ?? 2.0));
  const condPos = Math.min(1.0, 0.08 + 0.35 * ((vPos.moles.Cl_aq || 0) + (vPos.moles.Na_aq || 0) + (vPos.moles.SO4_2_aq || 0) + (vPos.moles.H_aq || 0) + (vPos.moles.OH_aq || 0)) / Math.max(0.05, infoPos.liqL));
  const condNeg = Math.min(1.0, 0.08 + 0.35 * ((vNeg.moles.Cl_aq || 0) + (vNeg.moles.Na_aq || 0) + (vNeg.moles.SO4_2_aq || 0) + (vNeg.moles.H_aq || 0) + (vNeg.moles.OH_aq || 0)) / Math.max(0.05, infoNeg.liqL));
  const effRes = rheoOhm + (1.8 * Math.max(1, bridgeList.length)) / Math.max(0.04, Math.min(condPos, condNeg));
  const decompV = 1.65;
  const currentA = vSet > decompV ? Math.min(5.0, (vSet - decompV) / effRes) : 0;
  const jADm2 = currentA / CATHODE_AREA_DM2;
  sup.circuitMode = 'electrolysis';
  sup.measuredV = vSet;
  sup.measuredCurrentA = currentA;
  sup.currentDensityADm2 = jADm2;
  elPos.polarityLabel = '+ Anode';
  elNeg.polarityLabel = `- Cathode (${jADm2.toFixed(1)} A/dm²)`;
  elNeg.currentDensityADm2 = jADm2;
  if (currentA <= 1e-4) return;
  for (const sb of bridgeList) {
    sb.activeCurrentA = Math.max(sb.activeCurrentA || 0, currentA);
  }

  const neMol = (currentA * dt) / CONSTANTS.FARADAY_C_MOL;
  let cathDesc = '2H₂O + 2e⁻ → H₂(g)↑ + 2OH⁻';
  let anDesc = '2H₂O → O₂(g)↑ + 4H⁺ + 4e⁻';

  // Cathode (-): Ag+ / Cu2+ / 2H+ / 2H2O -> H2 + 2OH-
  if ((vNeg.moles.Ag_aq || 0) > 1e-7) {
    const dAg = Math.min(vNeg.moles.Ag_aq, neMol);
    addMolSafe(vNeg.moles, 'Ag_aq', -dAg);
    addMolSafe(vNeg.moles, 'Ag_s', dAg);
    cathDesc = 'Ag⁺ + e⁻ → Ag(s)';
  } else if ((vNeg.moles.Cu2_aq || 0) > 1e-7) {
    const dCu = Math.min(vNeg.moles.Cu2_aq, neMol / 2);
    addMolSafe(vNeg.moles, 'Cu2_aq', -dCu);
    addMolSafe(vNeg.moles, 'Cu_s', dCu);
    cathDesc = 'Cu²⁺ + 2e⁻ → Cu(s)';
  } else if ((vNeg.moles.H_aq || 0) > neMol * 1.2) {
    const dH2 = neMol / 2;
    addMolSafe(vNeg.moles, 'H_aq', -2 * dH2);
    sim.emitElectrolysisGas(vNeg, 'H2_g', dH2, elNeg.x, elNeg);
    elNeg.gasBubbleType = 'H2_g';
    elNeg.gasBubbleRate = dH2 / Math.max(1e-4, dt);
    cathDesc = '2H⁺ + 2e⁻ → H₂(g)↑';
  } else if ((vNeg.moles.H2O_l || 0) > neMol) {
    const dH2 = neMol / 2;
    addMolSafe(vNeg.moles, 'H2O_l', -2 * dH2);
    addMolSafe(vNeg.moles, 'OH_aq', 2 * dH2);
    // Na+ migrates across salt bridge/diaphragm into cathode vessel to balance OH- as NaOH(aq)
    const dNaMig = Math.min(vPos.moles.Na_aq || 0, 2 * dH2);
    if (dNaMig > 1e-11) {
      addMolSafe(vPos.moles, 'Na_aq', -dNaMig);
      addMolSafe(vNeg.moles, 'Na_aq', dNaMig);
    }
    sim.emitElectrolysisGas(vNeg, 'H2_g', dH2, elNeg.x, elNeg);
    elNeg.gasBubbleType = 'H2_g';
    elNeg.gasBubbleRate = dH2 / Math.max(1e-4, dt);
  }

  // Anode (+): 2Cl- -> Cl2(g) or Cu/Zn oxidation or O2(g)
  const cClPos = (vPos.moles.Cl_aq || 0) / Math.max(1e-5, infoPos.liqL);
  if (elPos.material === 'Cu') {
    addMolSafe(vPos.moles, 'Cu2_aq', neMol / 2);
    anDesc = 'Cu(s) → Cu²⁺(aq) + 2e⁻';
  } else if (elPos.material === 'Zn') {
    addMolSafe(vPos.moles, 'Zn2_aq', neMol / 2);
    anDesc = 'Zn(s) → Zn²⁺(aq) + 2e⁻';
  } else if (cClPos >= 0.45 && (vPos.moles.Cl_aq || 0) > 1e-7) {
    const dCl2 = Math.min((vPos.moles.Cl_aq || 0) / 2, neMol / 2);
    addMolSafe(vPos.moles, 'Cl_aq', -2 * dCl2);
    sim.emitElectrolysisGas(vPos, 'Cl2_g', dCl2, elPos.x, elPos);
    elPos.gasBubbleType = 'Cl2_g';
    elPos.gasBubbleRate = dCl2 / Math.max(1e-4, dt);
    anDesc = '2Cl⁻ → Cl₂(g)↑ + 2e⁻';
  } else if ((vPos.moles.H2O_l || 0) > neMol * 0.6) {
    const dO2 = neMol / 4;
    addMolSafe(vPos.moles, 'H2O_l', -2 * dO2);
    addMolSafe(vPos.moles, 'H_aq', 4 * dO2);
    sim.emitElectrolysisGas(vPos, 'O2_g', dO2, elPos.x, elPos);
    elPos.gasBubbleType = 'O2_g';
    elPos.gasBubbleRate = dO2 / Math.max(1e-4, dt);
  }

  const rxnMeta = {
    id: 'electrolysis_diaphragm_cell',
    equation: `${cathDesc}  |  ${anDesc}`,
    nameVi: `Điện phân 2 bình qua cầu muối (${currentA.toFixed(2)} A)`,
    nameEn: `Two-cell diaphragm electrolysis (${currentA.toFixed(2)} A)`,
    descVi: `Ngăn riêng hai bán cực bằng cầu muối thu khí Cl₂ tại Anode (+) và H₂↑ + NaOH(aq) tinh khiết tại Cathode (-).`,
    descEn: `Salt-bridge compartment separation harvests Cl₂(g) at Anode (+) and pure NaOH(aq) + H₂(g) at Cathode (-).`,
    rateMolS: neMol / Math.max(1e-4, dt),
    vigorousGas: true,
    dXi: neMol,
  };
  vPos.activeReactions = [...(vPos.activeReactions || []), rxnMeta];
  vNeg.activeReactions = [...(vNeg.activeReactions || []), rxnMeta];
}

function stepGalvanicInstrument(sim, inst, elPos, elNeg, infoPos, infoNeg, items, dt, allowLoad = false, loadOhm = 2.2) {
  const bridgePath = findBridgingSaltBridgePath(items, infoPos.vessel.id, infoNeg.vessel.id);
  if (!bridgePath || bridgePath.length === 0) {
    inst.circuitMode = 'open_circuit';
    inst.measuredV = 0;
    inst.measuredCurrentA = 0;
    return;
  }

  const e1 = computeHalfCellPotentialV(elPos.material, infoPos.vessel, infoPos.liqL);
  const e2 = computeHalfCellPotentialV(elNeg.material, infoNeg.vessel, infoNeg.liqL);
  const cathFirst = e1 >= e2;
  const cathEl = cathFirst ? elPos : elNeg;
  const anEl = cathFirst ? elNeg : elPos;
  const cathInfo = cathFirst ? infoPos : infoNeg;
  const anInfo = cathFirst ? infoNeg : infoPos;
  const emfV = Math.max(0, Math.abs(e1 - e2));

  inst.circuitMode = 'galvanic';
  inst.measuredV = emfV;
  cathEl.polarityLabel = `+ Cathode (${cathEl.material})`;
  anEl.polarityLabel = `- Anode (${anEl.material})`;

  const isClosed = inst.kind === 'dc_power' ? Boolean(inst.powerOn) : allowLoad;
  if (!isClosed || emfV < 0.02) {
    inst.measuredCurrentA = 0;
    return;
  }

  const hasCathIon =
    (cathEl.material === 'Cu' &&
      ((cathInfo.vessel.moles.Cu2_aq || 0) > 1e-6 || (cathInfo.vessel.moles.CuNH3_4_2_aq || 0) > 1e-6)) ||
    (cathInfo.vessel.moles.H_aq || 0) > 1e-5;
  const currentA = hasCathIon ? Math.min(2.0, emfV / Math.max(0.2, loadOhm)) : 0;
  inst.measuredCurrentA = currentA;
  if (currentA > 1e-5) {
    for (const sb of bridgePath) sb.activeCurrentA = Math.max(sb.activeCurrentA || 0, currentA);
  }
  if (currentA <= 1e-5) return;

  const neMol = (currentA * dt) / CONSTANTS.FARADAY_C_MOL;
  if (anEl.material === 'Zn') {
    addMolSafe(anInfo.vessel.moles, 'Zn2_aq', neMol / 2);
  } else if (anEl.material === 'Cu') {
    addMolSafe(anInfo.vessel.moles, 'Cu2_aq', neMol / 2);
  }

  if (cathEl.material === 'Cu' && (cathInfo.vessel.moles.Cu2_aq || 0) > 1e-6) {
    const dCu = Math.min(cathInfo.vessel.moles.Cu2_aq, neMol / 2);
    addMolSafe(cathInfo.vessel.moles, 'Cu2_aq', -dCu);
    addMolSafe(cathInfo.vessel.moles, 'Cu_s', dCu);
  } else if (cathEl.material === 'Cu' && (cathInfo.vessel.moles.CuNH3_4_2_aq || 0) > 1e-6) {
    const dCu = Math.min(cathInfo.vessel.moles.CuNH3_4_2_aq, neMol / 2);
    addMolSafe(cathInfo.vessel.moles, 'CuNH3_4_2_aq', -dCu);
    addMolSafe(cathInfo.vessel.moles, 'NH3_aq', 4 * dCu);
    addMolSafe(cathInfo.vessel.moles, 'Cu_s', dCu);
  } else if ((cathInfo.vessel.moles.H_aq || 0) > 1e-5) {
    const dH2 = Math.min(cathInfo.vessel.moles.H_aq / 2, neMol / 2);
    addMolSafe(cathInfo.vessel.moles, 'H_aq', -2 * dH2);
    sim.emitElectrolysisGas(cathInfo.vessel, 'H2_g', dH2, cathEl.x, cathEl);
    cathEl.gasBubbleType = 'H2_g';
    cathEl.gasBubbleRate = dH2 / Math.max(1e-4, dt);
  }

  const eqStr = `${anEl.material}(s) + Cu²⁺ → ${anEl.material}²⁺ + Cu(s) (E = +${emfV.toFixed(2)} V)`;
  anInfo.vessel.activeReactions = [
    ...(anInfo.vessel.activeReactions || []),
    {
      id: 'galvanic_cell_anode',
      equation: eqStr,
      nameVi: `Pin Galvanic ${anEl.material}–${cathEl.material} (${emfV.toFixed(2)} V)`,
      nameEn: `Galvanic Cell ${anEl.material}–${cathEl.material} (${emfV.toFixed(2)} V)`,
      descVi: `Pin điện hóa tự phát truyền electron từ cực âm ${anEl.material} sang cực dương ${cathEl.material} qua cầu muối.`,
      descEn: `Spontaneous Galvanic electron flow from ${anEl.material} anode to ${cathEl.material} cathode bridged by ions.`,
      rateMolS: neMol / Math.max(1e-4, dt),
      vigorousGas: false,
      dXi: neMol,
    },
  ];
}

/**
 * Compute solution redox potential Eh (mV vs SHE) and Galvanic/Cell EMF Epin (V) for a vessel.
 * Shown automatically whenever an electrode is docked or a salt bridge links this vessel.
 */
export function computeVesselRedoxAndCellMetrics(vessel, items = [], liqL = 0, ph = null) {
  if (!vessel) return { hasElectroLink: false, ehMv: null, ePinV: null, cellPairLabel: null };
  const dockedEls = items.filter((i) => i.kind === 'electrode' && i.dockedVesselId === vessel.id);
  const linkedBridges = items.filter(
    (i) => i.kind === 'salt_bridge' && !i.isBroken && (i.vesselAId === vessel.id || i.vesselBId === vessel.id)
  );
  const hasElectroLink = dockedEls.length > 0 || linkedBridges.length > 0;
  if (!hasElectroLink || liqL <= 1e-6 || vessel.isFrozenSolid) {
    return { hasElectroLink, ehMv: null, ePinV: null, cellPairLabel: null };
  }

  const m = vessel.moles || {};
  const vSafe = Math.max(1e-4, liqL);
  const T = Number.isFinite(vessel.tempK) ? vessel.tempK : CONSTANTS.T_STD_K;
  const rtF = (CONSTANTS.R_J_MOL_K * T) / CONSTANTS.FARADAY_C_MOL;
  const effPh = ph ?? 7.0;
  const cH = Math.pow(10, -effPh);

  let ehV = null;
  const metalEl = dockedEls.find((e) => e.material === 'Zn' || e.material === 'Cu');
  if (metalEl) {
    ehV = computeHalfCellPotentialV(metalEl.material, vessel, vSafe);
  } else if ((m.MnO4_aq || 0) > 1e-7) {
    const ratio = ((m.MnO4_aq || 0) / vSafe) * Math.pow(Math.max(1e-8, cH), 8) / Math.max(1e-6, (m.Mn2_aq || 0) / vSafe);
    ehV = 1.507 + (rtF / 5) * Math.log(Math.max(1e-20, ratio));
  } else if ((m.Cr2O7_2_aq || 0) > 1e-7) {
    const ratio = ((m.Cr2O7_2_aq || 0) / vSafe) * Math.pow(Math.max(1e-8, cH), 14) / Math.pow(Math.max(1e-6, (m.Cr3_aq || 0) / vSafe), 2);
    ehV = 1.36 + (rtF / 6) * Math.log(Math.max(1e-20, ratio));
  } else if ((m.Fe3_aq || 0) > 1e-7 || ((m.Fe2_aq || 0) > 1e-7 && (m.Fe3_aq || 0) > 1e-9)) {
    const c3 = Math.max(1e-6, (m.Fe3_aq || 0) / vSafe);
    const c2 = Math.max(1e-6, (m.Fe2_aq || 0) / vSafe);
    ehV = 0.771 + rtF * Math.log(c3 / c2);
  } else if ((m.Ag_aq || 0) > 1e-7) {
    ehV = 0.7996 + rtF * Math.log(Math.max(1e-12, (m.Ag_aq || 0) / vSafe));
  } else if ((m.Cu2_aq || 0) > 1e-7) {
    ehV = 0.3419 + (rtF / 2) * Math.log(Math.max(1e-12, (m.Cu2_aq || 0) / vSafe));
  } else if ((m.Zn2_aq || 0) > 1e-7) {
    ehV = -0.7618 + (rtF / 2) * Math.log(Math.max(1e-12, (m.Zn2_aq || 0) / vSafe));
  } else {
    // Aerated aqueous solution (C/inert electrode): O2/H2O mixed potential vs pH
    ehV = 0.81 - 0.05916 * (T / 298.15) * effPh;
  }

  let ePinV = null;
  let cellPairLabel = null;
  for (const sb of linkedBridges) {
    const partnerId = sb.vesselAId === vessel.id ? sb.vesselBId : sb.vesselAId;
    const partnerV = items.find((i) => i.id === partnerId && i.kind === 'vessel' && !i.isShattered);
    if (!partnerV) continue;
    const partnerLiq = computeLiquidVolumeL(partnerV.moles, partnerV.tempK);
    if (partnerLiq <= 1e-5) continue;
    const partnerEl = items.find((i) => i.kind === 'electrode' && i.dockedVesselId === partnerId);
    const selfEl = dockedEls[0];
    if (selfEl && partnerEl) {
      const eSelf = computeHalfCellPotentialV(selfEl.material, vessel, vSafe);
      const ePart = computeHalfCellPotentialV(partnerEl.material, partnerV, partnerLiq);
      ePinV = Math.abs(eSelf - ePart);
      cellPairLabel = eSelf >= ePart ? `${partnerEl.material}(−) / ${selfEl.material}(+)` : `${selfEl.material}(−) / ${partnerEl.material}(+)`;
      break;
    }
  }
  if (ePinV === null) {
    const activeMeters = items.filter((mIt) => mIt.kind === 'volt_ammeter' && Math.abs(mIt.measuredV || 0) > 1e-4);
    const allEls = items.filter((i) => i.kind === 'electrode');
    for (const vm of activeMeters) {
      const pEl = allEls.find((e) => e.id === vm.posElectrodeId);
      const nEl = allEls.find((e) => e.id === vm.negElectrodeId);
      if (pEl?.dockedVesselId === vessel.id || nEl?.dockedVesselId === vessel.id) {
        ePinV = Math.abs(vm.measuredV || 0);
        break;
      }
    }
  }

  return {
    hasElectroLink,
    ehMv: ehV !== null && Number.isFinite(ehV) ? ehV * 1000 : null,
    ePinV: ePinV !== null && Number.isFinite(ePinV) ? ePinV : null,
    cellPairLabel,
  };
}
