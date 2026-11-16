import { CONSTANTS } from '../data/constants.js';
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
 * Supports Daniell Zn|Zn2+ || Cu2+|Cu (~1.10 V) and concentration/acid cells.
 */
function computeHalfCellPotentialV(mat, vessel, liqL) {
  const rt2F = (CONSTANTS.R_J_MOL_K * vessel.tempK) / (2 * CONSTANTS.FARADAY_C_MOL);
  if (mat === 'Cu') {
    const cCu = Math.max(1e-5, (vessel.moles.Cu2_aq || 0) / Math.max(1e-4, liqL));
    return 0.3419 + rt2F * Math.log(cCu);
  }
  if (mat === 'Zn') {
    const cZn = Math.max(1e-4, (vessel.moles.Zn2_aq || 0) / Math.max(1e-4, liqL));
    return -0.7618 + rt2F * Math.log(cZn);
  }
  const cH = Math.max(1e-7, (vessel.moles.H_aq || 0) / Math.max(1e-4, liqL));
  return 0.0 + rt2F * 2 * Math.log(cH);
}

/**
 * Resolve wiring pairs and step Faraday electrolysis / Galvanic cell reactions for all DC supplies.
 */
export function stepElectrochemistry(sim, dt) {
  const items = sim.items;
  const electrodes = items.filter((i) => i.kind === 'electrode');
  const supplies = items.filter((i) => i.kind === 'dc_power');
  const bridges = items.filter((i) => i.kind === 'salt_bridge' && !i.isBroken);

  // Clear stale electrode gas flags each frame before recomputing active current
  for (const el of electrodes) {
    el.gasBubbleType = null;
    el.gasBubbleRate = 0;
    el.polarityLabel = '';
  }

  // Update salt bridge endpoints to two nearest valid open vessels beneath its left & right legs
  for (const sb of bridges) {
    const leftX = sb.x - 42;
    const rightX = sb.x + 42;
    let bestA = null;
    let bestDA = 75;
    let bestB = null;
    let bestDB = 75;
    for (const v of items) {
      if (v.kind !== 'vessel' || v.isShattered || v.isStoppered) continue;
      if (Math.abs(v.y - sb.y) > 130) continue;
      const dA = Math.abs(v.x - leftX);
      const dB = Math.abs(v.x - rightX);
      if (dA < bestDA) {
        bestDA = dA;
        bestA = v;
      }
      if (dB < bestDB && (!bestA || v.id !== bestA.id)) {
        bestDB = dB;
        bestB = v;
      }
    }
    if (bestA && bestB && bestA.id !== bestB.id) {
      sb.vesselAId = bestA.id;
      sb.vesselBId = bestB.id;
    } else {
      sb.vesselAId = null;
      sb.vesselBId = null;
    }
  }

  for (const sup of supplies) {
    // Auto-select two closest docked electrodes if manually unassigned or deleted
    let elPos = electrodes.find((e) => e.id === sup.posElectrodeId && e.dockedVesselId);
    let elNeg = electrodes.find((e) => e.id === sup.negElectrodeId && e.dockedVesselId);
    const docked = electrodes
      .filter((e) => e.dockedVesselId)
      .sort((a, b) => Math.hypot(a.x - sup.x, a.y - sup.y) - Math.hypot(b.x - sup.x, b.y - sup.y));

    if ((!elPos || !elNeg || elPos.id === elNeg.id) && docked.length >= 2) {
      const pair = docked.slice(0, 2).sort((a, b) => a.x - b.x);
      elPos = pair[0];
      elNeg = pair[1];
      sup.posElectrodeId = elPos.id;
      sup.negElectrodeId = elNeg.id;
    }

    const infoPos = getElectrodeLiquidInfo(items, elPos);
    const infoNeg = getElectrodeLiquidInfo(items, elNeg);
    if (!infoPos || !infoNeg || !elPos || !elNeg) {
      sup.circuitMode = 'idle';
      sup.measuredV = 0;
      sup.measuredCurrentA = 0;
      continue;
    }

    // 1. Single-vessel Electrolysis Mode
    if (infoPos.vessel.id === infoNeg.vessel.id) {
      const v = infoPos.vessel;
      const liqL = infoPos.liqL;
      const vSet = Math.max(0, Math.min(12, sup.voltageV ?? 6.0));
      sup.circuitMode = 'electrolysis';

      if (!sup.powerOn || vSet < 0.2) {
        sup.measuredV = 0;
        sup.measuredCurrentA = 0;
        continue;
      }

      // Compute threshold decomposition potential (~1.23V for CuSO4->O2+Cu, ~1.5V for brine/water)
      const cCu = (v.moles.Cu2_aq || 0) / liqL;
      const cAg = (v.moles.Ag_aq || 0) / liqL;
      const cCl = (v.moles.Cl_aq || 0) / liqL;
      const decompV = elPos.material === 'Cu' && cCu > 0.01 ? 0.15 : cCu > 0.005 || cAg > 0.005 ? 1.15 : 1.55;
      const ionConductivity = Math.max(
        0.04,
        Math.min(
          1.0,
          0.08 +
            0.35 * ((v.moles.H_aq || 0) + (v.moles.OH_aq || 0) + (v.moles.Cu2_aq || 0) + (v.moles.Na_aq || 0) + (v.moles.SO4_2_aq || 0) + (v.moles.Cl_aq || 0)) /
              Math.max(0.05, liqL)
        )
      );

      const effResistanceOhm = 1.8 / ionConductivity;
      const currentA = vSet > decompV ? Math.min(5.0, (vSet - decompV) / effResistanceOhm) : 0;
      sup.measuredV = vSet;
      sup.measuredCurrentA = currentA;
      elPos.polarityLabel = '+ Anode';
      elNeg.polarityLabel = '- Cathode';

      if (currentA <= 1e-4) continue;

      const neMol = (currentA * dt) / CONSTANTS.FARADAY_C_MOL;

      // Cathode (-) reduction: Ag+ > Cu2+ > 2H+/2H2O -> H2(g)
      let cathDesc = '2H₂O + 2e⁻ → H₂(g)↑ + 2OH⁻';
      if ((v.moles.Ag_aq || 0) > 1e-7) {
        const dAg = Math.min(v.moles.Ag_aq, neMol);
        addMolSafe(v.moles, 'Ag_aq', -dAg);
        addMolSafe(v.moles, 'Ag_s', dAg);
        cathDesc = 'Ag⁺ + e⁻ → Ag(s)↓';
      } else if ((v.moles.Cu2_aq || 0) > 1e-7) {
        const dCu = Math.min(v.moles.Cu2_aq, neMol / 2);
        addMolSafe(v.moles, 'Cu2_aq', -dCu);
        addMolSafe(v.moles, 'Cu_s', dCu);
        cathDesc = 'Cu²⁺ + 2e⁻ → Cu(s)↓';
      } else if ((v.moles.H_aq || 0) > neMol * 1.2) {
        const dH2 = neMol / 2;
        addMolSafe(v.moles, 'H_aq', -2 * dH2);
        sim.emitElectrolysisGas(v, 'H2_g', dH2);
        elNeg.gasBubbleType = 'H2_g';
        elNeg.gasBubbleRate = dH2 / Math.max(1e-4, dt);
        cathDesc = '2H⁺ + 2e⁻ → H₂(g)↑';
      } else if ((v.moles.H2O_l || 0) > neMol) {
        const dH2 = neMol / 2;
        addMolSafe(v.moles, 'H2O_l', -2 * dH2);
        addMolSafe(v.moles, 'OH_aq', 2 * dH2);
        sim.emitElectrolysisGas(v, 'H2_g', dH2);
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
        sim.emitElectrolysisGas(v, 'Cl2_g', dCl2);
        elPos.gasBubbleType = 'Cl2_g';
        elPos.gasBubbleRate = dCl2 / Math.max(1e-4, dt);
        anDesc = '2Cl⁻ → Cl₂(g)↑ + 2e⁻';
      } else if ((v.moles.H2O_l || 0) > neMol * 0.6) {
        const dO2 = neMol / 4;
        addMolSafe(v.moles, 'H2O_l', -2 * dO2);
        addMolSafe(v.moles, 'H_aq', 4 * dO2);
        sim.emitElectrolysisGas(v, 'O2_g', dO2);
        elPos.gasBubbleType = 'O2_g';
        elPos.gasBubbleRate = dO2 / Math.max(1e-4, dt);
      }

      // Joule ohmic heating
      v.tempK = Math.min(372, v.tempK + (currentA * vSet * 0.25 * dt) / Math.max(50, 4200 * liqL + 100));

      v.activeReactions = [
        ...(v.activeReactions || []),
        {
          id: 'electrolysis_cell',
          equation: `${cathDesc}  |  ${anDesc}`,
          nameVi: `Điện phân dung dịch (${currentA.toFixed(2)} A · ${vSet.toFixed(1)} V)`,
          nameEn: `Electrolysis (${currentA.toFixed(2)} A · ${vSet.toFixed(1)} V)`,
          descVi: `Dòng điện một chiều tách chất theo định luật Faraday tại Anode (+) và Cathode (-).`,
          descEn: `DC Faraday electrolysis decomposing species at Anode (+) and Cathode (-).`,
          rateMolS: neMol / Math.max(1e-4, dt),
          vigorousGas: false,
          dXi: neMol,
        },
      ];
    } else {
      // 2. Two-vessel Galvanic Cell Mode (requires Salt Bridge connecting both vessels)
      const bridge = findBridgingSaltBridge(items, infoPos.vessel.id, infoNeg.vessel.id);
      if (!bridge) {
        sup.circuitMode = 'open_circuit';
        sup.measuredV = 0;
        sup.measuredCurrentA = 0;
        continue;
      }

      const e1 = computeHalfCellPotentialV(elPos.material, infoPos.vessel, infoPos.liqL);
      const e2 = computeHalfCellPotentialV(elNeg.material, infoNeg.vessel, infoNeg.liqL);
      const cathFirst = e1 >= e2;
      const cathEl = cathFirst ? elPos : elNeg;
      const anEl = cathFirst ? elNeg : elPos;
      const cathInfo = cathFirst ? infoPos : infoNeg;
      const anInfo = cathFirst ? infoNeg : infoPos;
      const emfV = Math.max(0, Math.abs(e1 - e2));

      sup.circuitMode = 'galvanic';
      sup.measuredV = emfV;
      cathEl.polarityLabel = `+ Cathode (${cathEl.material})`;
      anEl.polarityLabel = `- Anode (${anEl.material})`;

      // Close external circuit load when user clicks Power ON (or voltage >= 0 in galvanic load)
      if (!sup.powerOn || emfV < 0.02) {
        sup.measuredCurrentA = 0;
        continue;
      }

      // Spontaneous Galvanic discharge through nominal 2.2 Ohm external load
      const rTotal = 2.2;
      const hasCathIon =
        (cathEl.material === 'Cu' && (cathInfo.vessel.moles.Cu2_aq || 0) > 1e-6) ||
        (cathInfo.vessel.moles.H_aq || 0) > 1e-5;
      const currentA = hasCathIon ? Math.min(2.0, emfV / rTotal) : 0;
      sup.measuredCurrentA = currentA;
      if (currentA <= 1e-5) continue;

      const neMol = (currentA * dt) / CONSTANTS.FARADAY_C_MOL;
      // Anode oxidizes (Zn -> Zn2+ or Cu -> Cu2+)
      if (anEl.material === 'Zn') {
        addMolSafe(anInfo.vessel.moles, 'Zn2_aq', neMol / 2);
      } else if (anEl.material === 'Cu') {
        addMolSafe(anInfo.vessel.moles, 'Cu2_aq', neMol / 2);
      }

      // Cathode reduces (Cu2+ -> Cu(s) or H+ -> H2)
      if (cathEl.material === 'Cu' && (cathInfo.vessel.moles.Cu2_aq || 0) > 1e-6) {
        const dCu = Math.min(cathInfo.vessel.moles.Cu2_aq, neMol / 2);
        addMolSafe(cathInfo.vessel.moles, 'Cu2_aq', -dCu);
        addMolSafe(cathInfo.vessel.moles, 'Cu_s', dCu);
      } else if ((cathInfo.vessel.moles.H_aq || 0) > 1e-5) {
        const dH2 = Math.min(cathInfo.vessel.moles.H_aq / 2, neMol / 2);
        addMolSafe(cathInfo.vessel.moles, 'H_aq', -2 * dH2);
        sim.emitElectrolysisGas(cathInfo.vessel, 'H2_g', dH2);
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
  }
}
