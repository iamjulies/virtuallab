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
  if (liqL <= 1e-5 || (v.moles.H2O_l || 0) <= 1e-5) return null;
  return { vessel: v, liqL };
}

function findBridgingSaltBridge(items, vIdA, vIdB) {
  return items.find(
    (sb) =>
      sb.kind === 'salt_bridge' &&
      !sb.isBroken &&
      ((sb.vesselAId === vIdA && sb.vesselBId === vIdB) ||
        (sb.vesselAId === vIdB && sb.vesselBId === vIdA))
  );
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
      (v) => v.kind === 'vessel' && !v.isShattered && !v.isStoppered && !APPARATUS[v.typeId]?.isMortar && Math.abs(v.y - sb.y) <= 150
    );
    const leftCands = valid
      .filter((v) => v.x <= sb.x + 24 && Math.abs(v.x - sb.x) <= 145)
      .sort((a, b) => Math.abs(a.x - (sb.x - 44)) - Math.abs(b.x - (sb.x - 44)));
    const bestA = leftCands[0] || null;
    const rightCands = valid
      .filter((v) => (!bestA || v.id !== bestA.id) && v.x >= sb.x - 24 && Math.abs(v.x - sb.x) <= 145)
      .sort((a, b) => Math.abs(a.x - (sb.x + 44)) - Math.abs(b.x - (sb.x + 44)));
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

      const cCu = ((v.moles.Cu2_aq || 0) + 0.65 * (v.moles.CuNH3_4_2_aq || 0)) / liqL;
      const cAg = (v.moles.Ag_aq || 0) / liqL;
      const cCl = (v.moles.Cl_aq || 0) / liqL;
      const decompV = elPos.material === 'Cu' && cCu > 0.01 ? 0.15 : cCu > 0.005 || cAg > 0.005 ? 1.15 : 1.55;
      const ionConductivity = Math.max(
        0.04,
        Math.min(
          1.0,
          0.08 +
            0.35 *
              ((v.moles.H_aq || 0) +
                (v.moles.OH_aq || 0) +
                (v.moles.Cu2_aq || 0) +
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

      // Cathode (-) reduction: Ag+ > Cu2+ (free or ammine) > 2H+/2H2O -> H2(g)
      // Phenomenon #9A: Moderate J <= 6.5 A/dm2 plates bright salmon-pink Cu(s); high J > 6.5 A/dm2 gives burned powdery black Cu(s) + H2 co-evolution
      let cathDesc = '2H₂O + 2e⁻ → H₂(g)↑ + 2OH⁻';
      if ((v.moles.Ag_aq || 0) > 1e-7) {
        const dAg = Math.min(v.moles.Ag_aq, neMol);
        addMolSafe(v.moles, 'Ag_aq', -dAg);
        addMolSafe(v.moles, 'Ag_s', dAg);
        cathDesc = 'Ag⁺ + e⁻ → Ag(s)↓';
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
            sim.emitElectrolysisGas(v, 'H2_g', dH2Co, elNeg.x);
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
        sim.emitElectrolysisGas(v, 'H2_g', dH2, elNeg.x);
        elNeg.gasBubbleType = 'H2_g';
        elNeg.gasBubbleRate = dH2 / Math.max(1e-4, dt);
        cathDesc = '2H⁺ + 2e⁻ → H₂(g)↑';
      } else if ((v.moles.H2O_l || 0) > neMol) {
        const dH2 = neMol / 2;
        addMolSafe(v.moles, 'H2O_l', -2 * dH2);
        addMolSafe(v.moles, 'OH_aq', 2 * dH2);
        sim.emitElectrolysisGas(v, 'H2_g', dH2, elNeg.x);
        elNeg.gasBubbleType = 'H2_g';
        elNeg.gasBubbleRate = dH2 / Math.max(1e-4, dt);
      }

      // Anode (+) oxidation: Cu/Zn active dissolution, Cl- -> Cl2(g), or 2H2O -> O2(g) + 4H+
      let anDesc = '2H₂O → O₂(g)↑ + 4H⁺ + 4e⁻';
      if (elPos.material === 'Cu') {
        const dCuDiss = neMol / 2;
        addMolSafe(v.moles, 'Cu2_aq', dCuDiss);
        anDesc = 'Cu(s) → Cu²⁺(aq) + 2e⁻';
      } else if (elPos.material === 'Zn') {
        const dZnDiss = neMol / 2;
        addMolSafe(v.moles, 'Zn2_aq', dZnDiss);
        anDesc = 'Zn(s) → Zn²⁺(aq) + 2e⁻';
      } else if (cCl >= 0.45 && (v.moles.Cl_aq || 0) > neMol) {
        const dCl2 = neMol / 2;
        addMolSafe(v.moles, 'Cl_aq', -2 * dCl2);
        sim.emitElectrolysisGas(v, 'Cl2_g', dCl2, elPos.x);
        elPos.gasBubbleType = 'Cl2_g';
        elPos.gasBubbleRate = dCl2 / Math.max(1e-4, dt);
        anDesc = '2Cl⁻ → Cl₂(g)↑ + 2e⁻';
      } else if ((v.moles.H2O_l || 0) > neMol * 0.6) {
        const dO2 = neMol / 4;
        addMolSafe(v.moles, 'H2O_l', -2 * dO2);
        addMolSafe(v.moles, 'H_aq', 4 * dO2);
        sim.emitElectrolysisGas(v, 'O2_g', dO2, elPos.x);
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
      // 2. Two-vessel Galvanic Cell Mode through DC supply panel
      stepGalvanicInstrument(sim, sup, elPos, elNeg, infoPos, infoNeg, items, dt, true);
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
          sim.emitElectrolysisGas(v, 'H2_g', dH2, cathEl.x);
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

function stepGalvanicInstrument(sim, inst, elPos, elNeg, infoPos, infoNeg, items, dt, allowLoad = false, loadOhm = 2.2) {
  const bridge = findBridgingSaltBridge(items, infoPos.vessel.id, infoNeg.vessel.id);
  if (!bridge) {
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
  if (currentA > 1e-5) bridge.activeCurrentA = Math.max(bridge.activeCurrentA || 0, currentA);
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
    sim.emitElectrolysisGas(cathInfo.vessel, 'H2_g', dH2, cathEl.x);
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
