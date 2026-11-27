import { CONSTANTS } from '../data/constants.js';
import { APPARATUS } from '../data/apparatus.js';
import { computeLiquidVolumeL } from './equilibrium.js';

export const ELECTRODE_MATERIALS = {
  C:   { id: 'C',   formula: 'C(graphite)',       color: '#1e293b', stroke: '#64748b', e0: null,    nEq: 0, ionId: null,     solidId: null,   defaultMol: 0,    canPassivate: false, nameVi: 'Graphite (C)',                    nameEn: 'Graphite (C)' },
  Pt:  { id: 'Pt',  formula: 'Pt(s)',             color: '#cbd5e1', stroke: '#e2e8f0', e0: null,    nEq: 0, ionId: null,     solidId: null,   defaultMol: 0,    canPassivate: false, nameVi: 'Platinum (Pt)',                   nameEn: 'Platinum (Pt)' },
  SHE: { id: 'SHE', formula: 'Pt | H₂(g) | H⁺',   color: '#94a3b8', stroke: '#38bdf8', e0: 0.0,     nEq: 2, ionId: 'H_aq',   solidId: null,   defaultMol: 0,    canPassivate: false, isSHE: true, nameVi: 'Điện cực Hydrogen chuẩn (SHE)', nameEn: 'Standard Hydrogen Electrode (SHE)' },
  Ag:  { id: 'Ag',  formula: 'Ag(s)',             color: '#e2e8f0', stroke: '#f8fafc', e0: 0.7996,  nEq: 1, ionId: 'Ag_aq',  solidId: 'Ag_s', defaultMol: 0.05, canPassivate: false, nameVi: 'Silver (Ag)',                     nameEn: 'Silver (Ag)' },
  Cu:  { id: 'Cu',  formula: 'Cu(s)',             color: '#d97706', stroke: '#f59e0b', e0: 0.3419,  nEq: 2, ionId: 'Cu2_aq', solidId: 'Cu_s', defaultMol: 0.08, canPassivate: false, nameVi: 'Copper (Cu)',                     nameEn: 'Copper (Cu)' },
  Ni:  { id: 'Ni',  formula: 'Ni(s)',             color: '#c4c4bc', stroke: '#e5e7eb', e0: -0.257,  nEq: 2, ionId: 'Ni2_aq', solidId: 'Ni_s', defaultMol: 0.07, canPassivate: true,  nameVi: 'Nickel (Ni)',                     nameEn: 'Nickel (Ni)' },
  Pb:  { id: 'Pb',  formula: 'Pb(s)',             color: '#64748b', stroke: '#94a3b8', e0: -0.126,  nEq: 2, ionId: 'Pb2_aq', solidId: 'Pb_s', defaultMol: 0.05, canPassivate: false, nameVi: 'Lead (Pb)',                       nameEn: 'Lead (Pb)' },
  Fe:  { id: 'Fe',  formula: 'Fe(s)',             color: '#475569', stroke: '#94a3b8', e0: -0.447,  nEq: 2, ionId: 'Fe2_aq', solidId: 'Fe_s', defaultMol: 0.10, canPassivate: true,  nameVi: 'Iron (Fe)',                       nameEn: 'Iron (Fe)' },
  Zn:  { id: 'Zn',  formula: 'Zn(s)',             color: '#94a3b8', stroke: '#cbd5e1', e0: -0.7618, nEq: 2, ionId: 'Zn2_aq', solidId: 'Zn_s', defaultMol: 0.08, canPassivate: false, nameVi: 'Zinc (Zn)',                       nameEn: 'Zinc (Zn)' },
  Al:  { id: 'Al',  formula: 'Al(s)',             color: '#cbd5e1', stroke: '#e2e8f0', e0: -1.662,  nEq: 3, ionId: 'Al3_aq', solidId: 'Al_s', defaultMol: 0.12, canPassivate: true,  nameVi: 'Aluminum (Al)',                   nameEn: 'Aluminum (Al)' },
  Mg:  { id: 'Mg',  formula: 'Mg(s)',             color: '#d4d4d8', stroke: '#f4f4f5', e0: -2.372,  nEq: 2, ionId: 'Mg2_aq', solidId: 'Mg_s', defaultMol: 0.10, canPassivate: false, nameVi: 'Magnesium (Mg)',                  nameEn: 'Magnesium (Mg)' },
};

export const SALT_BRIDGE_ELECTROLYTES = {
  KNO3:   { id: 'KNO3',   formula: 'KNO₃',   ions: { K_aq: 0.04, NO3_aq: 0.04 },      cation: 'K_aq',   anion: 'NO3_aq',   qCat: 1, qAn: 1 },
  KCl:    { id: 'KCl',    formula: 'KCl',    ions: { K_aq: 0.04, Cl_aq: 0.04 },       cation: 'K_aq',   anion: 'Cl_aq',    qCat: 1, qAn: 1 },
  NaNO3:  { id: 'NaNO3',  formula: 'NaNO₃',  ions: { Na_aq: 0.04, NO3_aq: 0.04 },     cation: 'Na_aq',  anion: 'NO3_aq',   qCat: 1, qAn: 1 },
  NH4NO3: { id: 'NH4NO3', formula: 'NH₄NO₃', ions: { NH4_aq: 0.04, NO3_aq: 0.04 },    cation: 'NH4_aq', anion: 'NO3_aq',   qCat: 1, qAn: 1 },
  Na2SO4: { id: 'Na2SO4', formula: 'Na₂SO₄', ions: { Na_aq: 0.04, SO4_2_aq: 0.02 },   cation: 'Na_aq',  anion: 'SO4_2_aq', qCat: 1, qAn: 2 },
  NaCl:   { id: 'NaCl',   formula: 'NaCl',   ions: { Na_aq: 0.04, Cl_aq: 0.04 },      cation: 'Na_aq',  anion: 'Cl_aq',    qCat: 1, qAn: 1 },
};

export function ensureElectrodeMetalMoles(el) {
  if (!el) return 0;
  const mat = ELECTRODE_MATERIALS[el.material] || ELECTRODE_MATERIALS.C;
  if (!mat.solidId) {
    el._rodMaterialInit = el.material;
    return 0;
  }
  if (el._rodMaterialInit !== el.material || !Number.isFinite(el.rodMetalMol) || el.rodMetalMol < 0) {
    el.rodMetalMol = mat.defaultMol;
    el._rodMaterialInit = el.material;
  }
  return el.rodMetalMol;
}

export function ensureSaltBridgeMoles(sb) {
  if (!sb) return {};
  if (!sb.electrolyteId) sb.electrolyteId = 'KNO3';
  if (!sb.moles || Object.keys(sb.moles).length === 0) {
    const preset = SALT_BRIDGE_ELECTROLYTES[sb.electrolyteId] || SALT_BRIDGE_ELECTROLYTES.KNO3;
    sb.moles = { ...preset.ions };
  }
  return sb.moles;
}

function addMolSafe(moles, id, delta) {
  const next = (moles[id] || 0) + delta;
  if (next <= 1e-13) delete moles[id];
  else moles[id] = next;
}

function isVesselPassivatingForMetal(vessel, liqL, matId) {
  if (!vessel || (matId !== 'Fe' && matId !== 'Al' && matId !== 'Ni')) return false;
  if ((matId === 'Fe' && vessel.fePassivated) || (matId === 'Al' && vessel.alPassivated) || (matId === 'Ni' && vessel.niPassivated)) return true;
  const m = vessel.moles || {};
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  if (T >= 323.15) return false;
  const nAcidHNO3 = Math.min(m.H_aq || 0, m.NO3_aq || 0);
  const wHNO3 = (nAcidHNO3 * CONSTANTS.M_HNO3) / Math.max(1e-9, nAcidHNO3 * CONSTANTS.M_HNO3 + (m.H2O_l || 0) * CONSTANTS.M_H2O);
  if (wHNO3 >= 0.60 || nAcidHNO3 / Math.max(1e-4, liqL) >= 10.0) return true;
  const nH2SO4 = m.H2SO4_l || 0;
  const wH2SO4 = (nH2SO4 * CONSTANTS.M_H2SO4) / Math.max(1e-9, nH2SO4 * CONSTANTS.M_H2SO4 + (m.H2O_l || 0) * CONSTANTS.M_H2O);
  return nH2SO4 > 1e-5 && wH2SO4 >= 0.80;
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

function computeTotalElectrolyteIons(moles = {}) {
  return (
    (moles.H_aq || 0) +
    (moles.OH_aq || 0) +
    (moles.Na_aq || 0) +
    (moles.K_aq || 0) +
    (moles.NH4_aq || 0) +
    (moles.Cu2_aq || 0) +
    (moles.Ag_aq || 0) +
    (moles.Zn2_aq || 0) +
    (moles.Fe2_aq || 0) +
    (moles.Fe3_aq || 0) +
    (moles.Ni2_aq || 0) +
    (moles.Pb2_aq || 0) +
    (moles.Mg2_aq || 0) +
    (moles.Al3_aq || 0) +
    (moles.Ba2_aq || 0) +
    (moles.Cl_aq || 0) +
    (moles.SO4_2_aq || 0) +
    (moles.NO3_aq || 0)
  );
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
        const midV = items.find((it) => it.id === nextId && it.kind === 'vessel' && !it.isShattered);
        if (!midV) continue;
        const midLiq = computeLiquidVolumeL(midV.moles || {}, midV.tempK || 298.15);
        if (midLiq < 0.002 || computeTotalElectrolyteIons(midV.moles) < 1e-5) continue;
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
 * Compute standard/Nernst Galvanic cell potential E (V vs SHE) for any half-cell electrode.
 * Supports C, Pt, SHE (2H+/H2), Ag, Cu, Ni, Pb, Fe, Zn, Al, Mg with complexation & passivation.
 */
export function computeHalfCellPotentialV(elOrMat, vessel, liqL, items = []) {
  const matId = typeof elOrMat === 'string' ? elOrMat : elOrMat?.material || 'C';
  const el = typeof elOrMat === 'object' ? elOrMat : null;
  const mat = ELECTRODE_MATERIALS[matId] || ELECTRODE_MATERIALS.C;
  const safeVolL = Math.max(1e-4, liqL);
  const T = vessel?.tempK || CONSTANTS.T_STD_K;
  const rtF = (CONSTANTS.R_J_MOL_K * T) / CONSTANTS.FARADAY_C_MOL;
  const rt2F = rtF / 2;
  const m = vessel?.moles || {};

  if (matId === 'SHE') {
    const cH = Math.max(1e-12, (m.H_aq || 0) / safeVolL);
    let pH2 = Math.max(0.1, Math.min(5.0, el?.shePressureBar ?? 1.0));
    if (el?.sheGasVesselId) {
      const gasSrc = items.find((i) => i.id === el.sheGasVesselId);
      if (gasSrc?.headspaceGasMoles?.H2_g > 1e-5) {
        pH2 = Math.max(0.1, Math.min(5.0, gasSrc.internalPressureBar ?? 1.0));
      }
    }
    return 0.0 - rt2F * Math.log(pH2 / (cH * cH));
  }

  if (matId === 'Cu') {
    const cFreeCu = (m.Cu2_aq || 0) / safeVolL;
    const cCuAmm = (m.CuNH3_4_2_aq || 0) / safeVolL;
    const cCuOH4 = (m.CuOH4_2_aq || 0) / safeVolL;
    const cNH3 = Math.max(0.01, (m.NH3_aq || 0) / safeVolL);
    const cOH = Math.max(1e-7, (m.OH_aq || 0) / safeVolL);
    let cEff = cFreeCu;
    if (cEff < 1e-6) {
      if (cCuAmm > 1e-8) {
        cEff = Math.max(1e-18, cCuAmm / (1.1e13 * Math.pow(cNH3, 4)));
      } else if ((m.CuOH2_s || 0) > 1e-8) {
        cEff = Math.max(1e-18, 2.2e-20 / Math.pow(cOH, 2));
      } else if (cCuOH4 > 1e-8) {
        cEff = Math.max(1e-19, cCuOH4 / (1e16 * Math.pow(cOH, 4)));
      }
    }
    cEff = Math.max(1e-18, cEff || 1e-6);
    return mat.e0 + rt2F * Math.log(cEff);
  }

  if (matId === 'Zn') {
    const cZnFree = (m.Zn2_aq || 0) / safeVolL;
    const cZincate = (m.ZnOH4_2_aq || 0) / safeVolL;
    const cOH = Math.max(1e-4, (m.OH_aq || 0) / safeVolL);
    let cEff = cZnFree;
    if (cEff < 1e-7 && cZincate > 1e-8) {
      cEff = Math.max(1e-18, cZincate / (3.0e15 * Math.pow(cOH, 4)));
    }
    cEff = Math.max(1e-18, cEff || 1e-5);
    return mat.e0 + rt2F * Math.log(cEff);
  }

  if (mat.e0 != null && mat.ionId && mat.nEq > 0) {
    let cEff = (m[mat.ionId] || 0) / safeVolL;
    if (matId === 'Al' && cEff < 1e-7 && (m.AlOH4_aq || 0) > 1e-8) {
      const cOH = Math.max(1e-4, (m.OH_aq || 0) / safeVolL);
      cEff = Math.max(1e-18, ((m.AlOH4_aq || 0) / safeVolL) / (1e14 * Math.pow(cOH, 4)));
    }
    cEff = Math.max(1e-18, cEff || 1e-5);
    const passivShift = isVesselPassivatingForMetal(vessel, safeVolL, matId) ? 0.55 : 0;
    return mat.e0 + passivShift + (rtF / mat.nEq) * Math.log(cEff);
  }

  // Inert C / Pt electrode in aqueous medium: mixed H+/O2 or dominant redox couple
  if ((m.Fe3_aq || 0) > 1e-6 && (m.Fe2_aq || 0) > 1e-6) {
    return 0.771 + rtF * Math.log(((m.Fe3_aq || 0) / safeVolL) / ((m.Fe2_aq || 0) / safeVolL));
  }
  const cH = Math.max(1e-10, (m.H_aq || 0) / safeVolL);
  if (cH > 0.01) return 0.0 + rt2F * 2 * Math.log(cH);
  // Neutral/aerated O2/H2O response on inert C/Pt so Galvanic corrosion with H2/O2 depolarization drives active metals
  const pH = Math.min(14, Math.max(0, -Math.log10(cH)));
  return 0.42 - 0.05916 * (T / 298.15) * (pH - 7) * 0.4;
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

function oxidizeAnodeMetal(vessel, el, neMol) {
  const mat = ELECTRODE_MATERIALS[el.material];
  if (!mat || !mat.solidId || !mat.ionId || !mat.nEq) return 0;
  const avail = ensureElectrodeMetalMoles(el);
  if (avail <= 1e-10) return 0;
  const dM = Math.min(avail, neMol / mat.nEq);
  el.rodMetalMol = Math.max(0, avail - dM);
  addMolSafe(vessel.moles, mat.ionId, dM);
  return dM;
}

function markVesselElectroOverride(vessel, solidId, info) {
  if (!vessel || !solidId) return;
  if (!vessel.electrochemOverrideMap) vessel.electrochemOverrideMap = {};
  vessel.electrochemOverrideMap[solidId] = info;
}

function stepElectrodeDirectSurfaceChemistry(sim, el, v, liqL, dt, coupledAnodeEls, coupledCathodeEls) {
  const mat = ELECTRODE_MATERIALS[el.material];
  if (!mat || !mat.solidId || !mat.ionId || !mat.nEq) return;
  const isPassivated = isVesselPassivatingForMetal(v, liqL, el.material);
  el.passivatedActive = isPassivated;
  if (isPassivated || el.cathodicProtectedActive || coupledCathodeEls.has(el.id)) return;

  const rodMol = ensureElectrodeMetalMoles(el);
  if (rodMol <= 1e-9) return;
  const T = v.tempK || CONSTANTS.T_STD_K;
  const arrh = Math.exp((-26000 / CONSTANTS.R_J_MOL_K) * (1 / T - 1 / CONSTANTS.T_STD_K));
  const cH = (v.moles.H_aq || 0) / Math.max(1e-4, liqL);
  const isCoupledAnode = coupledAnodeEls.has(el.id);

  // Check noble displacement ions in vessel (e.g. Fe + Cu2+ -> Fe2+ + Cu↓; Cu + 2Ag+ -> Cu2+ + 2Ag↓)
  const nobleTargets = [
    { ionId: 'Ag_aq', sym: 'Ag', e0: 0.7996, nIon: 1, colKey: 'platedAgMol' },
    { ionId: 'Cu2_aq', sym: 'Cu', e0: 0.3419, nIon: 2, colKey: 'platedCuMol' },
    { ionId: 'Ni2_aq', sym: 'Ni', e0: -0.257, nIon: 2, colKey: 'platedNiMol' },
    { ionId: 'Pb2_aq', sym: 'Pb', e0: -0.126, nIon: 2, colKey: null },
  ];
  for (const nt of nobleTargets) {
    if (mat.e0 >= nt.e0 - 0.05) continue;
    const nIon = v.moles[nt.ionId] || 0;
    if (nIon <= 1e-7) continue;
    const neDisp = Math.min(rodMol * mat.nEq, nIon * nt.nIon, 0.0028 * arrh * dt * mat.nEq);
    if (neDisp <= 1e-11) continue;
    const dM = neDisp / mat.nEq;
    const dRed = neDisp / nt.nIon;
    el.rodMetalMol = Math.max(0, el.rodMetalMol - dM);
    addMolSafe(v.moles, mat.ionId, dM);
    addMolSafe(v.moles, nt.ionId, -dRed);
    if (nt.sym === 'Cu' || nt.sym === 'Ag') {
      el.platedMaterial = nt.sym;
      el[nt.colKey] = (el[nt.colKey] || 0) + dRed;
      el.platedQuality = nt.sym === 'Ag' ? 'dendrite' : 'smooth';
      addMolSafe(v.moles, `${nt.sym}_s`, dRed);
    }
    v.activeReactions = [
      ...(v.activeReactions || []),
      {
        id: `el_disp_${mat.id}_${nt.sym}`,
        equation: `${mat.id}(điện cực) + ${nt.sym}${(nt.nIon === 2 ? '²⁺' : '⁺')} → ${mat.id}${mat.nEq === 3 ? '³⁺' : mat.nEq === 2 ? '²⁺' : '⁺'} + ${nt.sym}↓`,
        nameVi: `Thanh ${mat.id} đẩy ${nt.sym} bám lên bề mặt điện cực`,
        nameEn: `${mat.id} rod displaces ${nt.sym} onto electrode surface`,
        descVi: `Kim loại ${mat.id} trên thanh điện cực khử trực tiếp ion ${nt.sym} trong dung dịch tạo lớp mạ & vi pin cục bộ.`,
        descEn: `${mat.id} electrode metal reduces ${nt.sym} ions directly from solution, plating ${nt.sym} and forming local micro-cells.`,
        rateMolS: dM / Math.max(1e-4, dt),
        vigorousGas: false,
        dXi: dM,
      },
    ];
  }

  // Local Galvanic micro-cell when foreign noble metal is plated directly onto active rod!
  const hasPlatedLocalCathode =
    (el.material !== 'Ag' && (el.platedAgMol || 0) > 1e-7) ||
    (el.material !== 'Cu' && (el.platedCuMol || 0) > 1e-7);

  // Acid chemical dissolution on uncoupled metal rod (or local micro-cell acceleration when noble metal plated on rod)
  if (mat.e0 < -0.02 && (v.moles.H_aq || 0) > 1e-6 && cH > 0.005) {
    const baseRateScale = mat.e0 <= -2.0 ? 0.0022 : mat.e0 <= -1.2 ? 0.0012 : mat.e0 <= -0.6 ? 0.0007 : 0.00045;
    const microMult = hasPlatedLocalCathode ? 5.2 : isCoupledAnode ? 0.08 : 1.0;
    const dM = Math.min(el.rodMetalMol, (v.moles.H_aq || 0) / mat.nEq, baseRateScale * Math.min(4.0, cH) * arrh * microMult * dt);
    if (dM > 1e-10) {
      el.rodMetalMol = Math.max(0, el.rodMetalMol - dM);
      addMolSafe(v.moles, mat.ionId, dM);
      const dH2 = (dM * mat.nEq) / 2;
      addMolSafe(v.moles, 'H_aq', -2 * dH2);
      sim.emitElectrolysisGas(v, 'H2_g', dH2, el.x, el);
      if (!isCoupledAnode) {
        el.gasBubbleType = 'H2_g';
        el.gasBubbleRate = dH2 / Math.max(1e-4, dt);
      }
      v.activeReactions = [
        ...(v.activeReactions || []),
        {
          id: hasPlatedLocalCathode ? `el_microcell_${mat.id}` : `el_chem_${mat.id}`,
          equation: `${mat.id}(s) + ${mat.nEq}H⁺ → ${mat.id}${mat.nEq === 3 ? '³⁺' : mat.nEq === 2 ? '²⁺' : '⁺'} + ${mat.nEq === 2 ? '' : mat.nEq === 3 ? '1.5' : '0.5'}H₂↑`,
          nameVi: hasPlatedLocalCathode ? `Ăn mòn điện hóa vi pin trên thanh ${mat.id}` : `Ăn mòn hóa học trên thanh ${mat.id}`,
          nameEn: hasPlatedLocalCathode ? `Local micro-cell galvanic corrosion on ${mat.id} rod` : `Chemical acid corrosion on ${mat.id} rod`,
          descVi: hasPlatedLocalCathode
            ? `Lớp kim loại quý bám trên ${mat.id} tạo vô số vi pin làm tăng tốc độ ăn mòn gấp nhiều lần.`
            : `Thanh ${mat.id} hòa tan từ từ trong dung dịch acid (ăn mòn hóa học chậm).`,
          descEn: hasPlatedLocalCathode
            ? `Plated noble metal patches on ${mat.id} create micro-galvanic cells accelerating dissolution.`
            : `${mat.id} rod undergoes slow chemical corrosion in acid.`,
          rateMolS: dM / Math.max(1e-4, dt),
          vigorousGas: false,
          dXi: dM,
        },
      ];
    }
  }
}

function stepSaltBridgeJunction(sb, vessel, dt) {
  if (!sb || !vessel || sb.isBroken) return;
  const sbMoles = ensureSaltBridgeMoles(sb);
  const vM = vessel.moles || {};

  // Cl- in KCl / NaCl salt bridge reacts with Ag+ at the solution junction forming insoluble white AgCl↓
  if ((sbMoles.Cl_aq || 0) > 1e-7 && (vM.Ag_aq || 0) > 1e-6) {
    const dAgCl = Math.min(sbMoles.Cl_aq, vM.Ag_aq, 0.0012 * Math.max(0.016, dt));
    if (dAgCl > 1e-9) {
      addMolSafe(sbMoles, 'Cl_aq', -dAgCl);
      addMolSafe(vM, 'Ag_aq', -dAgCl);
      addMolSafe(vM, 'AgCl_s', dAgCl);
      sb.fouledByAgCl = true;
      sb.fouledWarningKey = 'saltBridgeKclAgWarn';
      sb.junctionResistanceOhm = Math.min(28, (sb.junctionResistanceOhm || 0.8) + dAgCl * 2200);
      vessel.activeReactions = [
        ...(vessel.activeReactions || []),
        {
          id: 'salt_bridge_agcl_foul',
          equation: 'Ag⁺(aq) + Cl⁻(cầu muối) → AgCl(s)↓ (tắc cầu)',
          nameVi: 'Kết tủa AgCl↓ ở đầu cầu muối KCl/NaCl',
          nameEn: 'AgCl(s)↓ fouling at KCl/NaCl salt-bridge junction',
          descVi: 'Ion Cl⁻ từ cầu muối gặp Ag⁺ tạo kết tủa trắng AgCl bít đầu cầu, làm tăng điện trở và sụt dòng pin.',
          descEn: 'Cl⁻ leaching from the salt bridge precipitates white AgCl(s) at the porous plug, fouling the junction.',
          rateMolS: dAgCl / Math.max(1e-4, dt),
          vigorousGas: false,
          dXi: dAgCl,
        },
      ];
    }
  }

  // SO4^2- in Na2SO4 salt bridge reacts with Ba2+ or Pb2+ forming white sulfate precipitates
  if ((sbMoles.SO4_2_aq || 0) > 1e-7 && ((vM.Ba2_aq || 0) > 1e-6 || (vM.Pb2_aq || 0) > 1e-6)) {
    const ionId = (vM.Ba2_aq || 0) >= (vM.Pb2_aq || 0) ? 'Ba2_aq' : 'Pb2_aq';
    const pptId = ionId === 'Ba2_aq' ? 'BaSO4_s' : 'PbSO4_s';
    const dPpt = Math.min(sbMoles.SO4_2_aq, vM[ionId], 0.001 * Math.max(0.016, dt));
    if (dPpt > 1e-9) {
      addMolSafe(sbMoles, 'SO4_2_aq', -dPpt);
      addMolSafe(vM, ionId, -dPpt);
      addMolSafe(vM, pptId, dPpt);
      sb.fouledBySulfate = true;
      if (!sb.fouledWarningKey) sb.fouledWarningKey = 'saltBridgeSulfateBaWarn';
      sb.junctionResistanceOhm = Math.min(24, (sb.junctionResistanceOhm || 0.8) + dPpt * 1900);
    }
  }
}

function migrateSaltBridgeChargeBalance(sb, anV, cathV, neMol) {
  if (!sb || neMol <= 1e-12) return;
  const sbMoles = ensureSaltBridgeMoles(sb);
  // Pick available cation in bridge to migrate to cathode vessel (+), anion to anode vessel (-)
  const catPriority = ['K_aq', 'Na_aq', 'NH4_aq'];
  const anPriority = ['NO3_aq', 'Cl_aq', 'SO4_2_aq'];
  const catId = catPriority.find((k) => (sbMoles[k] || 0) > 1e-9);
  const anId = anPriority.find((k) => (sbMoles[k] || 0) > 1e-9);
  if (catId && cathV?.moles) {
    const dCat = Math.min(sbMoles[catId], neMol * 0.25);
    addMolSafe(sbMoles, catId, -dCat);
    addMolSafe(cathV.moles, catId, dCat);
  }
  if (anId && anV?.moles) {
    const charge = anId === 'SO4_2_aq' ? 2 : 1;
    const dAn = Math.min(sbMoles[anId], (neMol * 0.25) / charge);
    addMolSafe(sbMoles, anId, -dAn);
    addMolSafe(anV.moles, anId, dAn);
  }
}

/**
 * Resolve wiring pairs and step Faraday electrolysis, Galvanic cells, SHE, Salt Bridges & electrochemical corrosion override.
 */
export function stepElectrochemistry(sim, dt) {
  const items = sim.items;
  const electrodes = items.filter((i) => i.kind === 'electrode');
  const supplies = items.filter((i) => i.kind === 'dc_power');
  const meters = items.filter((i) => i.kind === 'volt_ammeter');
  const bridges = items.filter((i) => i.kind === 'salt_bridge' && !i.isBroken);
  const CATHODE_AREA_DM2 = 0.04;

  // Clear stale per-frame flags on electrodes and vessels
  for (const el of electrodes) {
    ensureElectrodeMetalMoles(el);
    el.gasBubbleType = null;
    el.gasBubbleRate = 0;
    el.polarityLabel = '';
    el.currentDensityADm2 = 0;
    el.cathodicProtectedActive = false;
    el.galvanicDominantActive = false;
    el.passivatedActive = false;
  }
  for (const v of items) {
    if (v.kind === 'vessel') {
      v.cathodicProtectedByZn = false;
      v.electrochemOverrideMap = null;
    }
  }

  const coupledAnodeEls = new Set();
  const coupledCathodeEls = new Set();

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

  // Reset live circuit indicator on bridges & process junction chemistry
  for (const sb of bridges) {
    ensureSaltBridgeMoles(sb);
    sb.activeCurrentA = 0;
    sb.fouledWarningKey = null;
    sb.fouledByAgCl = false;
    sb.fouledBySulfate = false;
    sb.junctionResistanceOhm = Math.max(0.6, (sb.junctionResistanceOhm || 0.6) * 0.92);

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
      stepSaltBridgeJunction(sb, bestA, dt);
      stepSaltBridgeJunction(sb, bestB, dt);
    } else {
      sb.vesselAId = null;
      sb.vesselBId = null;
    }
  }

  for (const sup of supplies) {
    const linkedEp = items.find((i) => i.kind === 'electrophoresis' && i.connectedPowerId === sup.id);
    if (linkedEp) {
      const vSet = Math.max(0, Math.min(12, sup.voltageV ?? 6.0));
      const rheoOhm = Math.max(0.2, Math.min(25, sup.rheostatOhm ?? 2.0));
      sup.circuitMode = 'electrophoresis';
      if (!sup.powerOn || vSet < 0.05) {
        sup.measuredV = 0;
        sup.measuredCurrentA = 0;
        sup.currentDensityADm2 = 0;
      } else {
        const phExtremity = Math.abs((linkedEp.bufferPH ?? 6.0) - 7.0) / 7.0;
        const rCellOhm = Math.max(40, 180 - phExtremity * 110) + rheoOhm;
        const iAmp = vSet / rCellOhm;
        sup.measuredV = +(vSet * (1 - rheoOhm / rCellOhm)).toFixed(2);
        sup.measuredCurrentA = +iAmp.toFixed(3);
        sup.currentDensityADm2 = +(iAmp / 0.015).toFixed(1);
      }
      continue;
    }

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
        : Math.max(0.04, Math.min(1.0, 0.08 + 0.35 * computeTotalElectrolyteIons(v.moles) / Math.max(0.05, liqL)));

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
      } else if ((v.moles.Ni2_aq || 0) > 1e-7) {
        const dNi = Math.min(v.moles.Ni2_aq, (neMol * 0.85) / 2);
        addMolSafe(v.moles, 'Ni2_aq', -dNi);
        addMolSafe(v.moles, 'Ni_s', dNi);
        elNeg.platedMaterial = 'Ni';
        elNeg.platedQuality = jADm2 > 6.5 ? 'burned' : 'smooth';
        elNeg.platedNiMol = (elNeg.platedNiMol || 0) + dNi;
        cathDesc = 'Ni²⁺ + 2e⁻ → Ni(s) (mạ bạc-nickel)';
      } else if ((v.moles.NiNH3_6_2_aq || 0) > 1e-7) {
        const dNi = Math.min(v.moles.NiNH3_6_2_aq, neMol / 2);
        addMolSafe(v.moles, 'NiNH3_6_2_aq', -dNi);
        addMolSafe(v.moles, 'NH3_aq', 6 * dNi);
        addMolSafe(v.moles, 'Ni_s', dNi);
        elNeg.platedMaterial = 'Ni';
        elNeg.platedQuality = 'smooth';
        elNeg.platedNiMol = (elNeg.platedNiMol || 0) + dNi;
        cathDesc = '[Ni(NH₃)₆]²⁺ + 2e⁻ → Ni(s) + 6NH₃';
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

      let anDesc = '2H₂O → O₂(g)↑ + 4H⁺ + 4e⁻';
      const anMat = ELECTRODE_MATERIALS[elPos.material];
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
      } else if (anMat?.solidId && elPos.material !== 'C' && elPos.material !== 'Pt' && elPos.material !== 'SHE' && ensureElectrodeMetalMoles(elPos) > 1e-9) {
        oxidizeAnodeMetal(v, elPos, neMol);
        anDesc = `${anMat.id}(s) → ${anMat.id}${anMat.nEq === 3 ? '³⁺' : anMat.nEq === 2 ? '²⁺' : '⁺'}(aq) + ${anMat.nEq}e⁻`;
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
      const bridgePath = findBridgingSaltBridgePath(items, infoPos.vessel.id, infoNeg.vessel.id);
      const vSet = Math.max(0, Math.min(12, sup.voltageV ?? 6.0));
      const e1 = computeHalfCellPotentialV(elPos, infoPos.vessel, infoPos.liqL, items);
      const e2 = computeHalfCellPotentialV(elNeg, infoNeg.vessel, infoNeg.liqL, items);
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
        stepGalvanicInstrument(sim, sup, elPos, elNeg, infoPos, infoNeg, items, dt, true, 2.2, coupledAnodeEls, coupledCathodeEls);
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
      // Single-vessel Galvanic Corrosion Couple & Cathodic Protection (dominant over chemical corrosion!)
      const v = infoPos.vessel;
      const e1 = computeHalfCellPotentialV(elPos, v, infoPos.liqL, items);
      const e2 = computeHalfCellPotentialV(elNeg, v, infoPos.liqL, items);
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
        // High impedance Voltmeter: open circuit I = 0 -> no electrochemical override (reverts to chemical corrosion)
        meter.circuitMode = 'galvanic_couple';
        meter.measuredV = emfV;
        meter.measuredCurrentA = 0;
        continue;
      }

      const anMat = ELECTRODE_MATERIALS[anEl.material];
      const cathMat = ELECTRODE_MATERIALS[cathEl.material];
      const anPassivated = isVesselPassivatingForMetal(v, infoPos.liqL, anEl.material);
      const ionTotal = computeTotalElectrolyteIons(v.moles);
      const canConduct = (v.moles.H2O_l || 0) > 1e-4 && ionTotal > 1e-5 && !anPassivated;
      const rShunt = mode === 'short' ? 0.14 : 1.4;
      const currentA = canConduct ? Math.min(3.5, emfV / rShunt) : 0;

      meter.circuitMode = 'cathodic_protection';
      meter.measuredV = mode === 'short' ? 0.02 : currentA * 0.25;
      meter.measuredCurrentA = currentA;

      if (currentA > 1e-4 && anMat?.solidId && !anMat.isSHE) {
        coupledAnodeEls.add(anEl.id);
        coupledCathodeEls.add(cathEl.id);

        if (anEl.material === 'Zn' && (cathEl.material === 'Cu' || cathEl.material === 'C' || cathEl.material === 'Pt')) {
          v.cathodicProtectedByZn = true;
        }
        cathEl.cathodicProtectedActive = true;
        anEl.galvanicDominantActive = true;
        meter.cathodicProtectedActive = true;

        // Electrochemical corrosion dominates (85-95% suppression of chemical channel on anode + 100% on cathode)
        markVesselElectroOverride(v, anMat.solidId, { role: 'anode', chemRetentionFrac: 0.08 });
        if (cathMat?.solidId) {
          markVesselElectroOverride(v, cathMat.solidId, { role: 'cathode', chemRetentionFrac: 0.0 });
        }

        // Fast anodic oxidation (4-8x faster than isolated slow chemical corrosion due to H2 depolarization at cathode!)
        const neMol = (currentA * dt) / CONSTANTS.FARADAY_C_MOL;
        const dAnMetal = oxidizeAnodeMetal(v, anEl, neMol);
        // Also oxidize free metal granules of the anode material in the vessel when present (dominant electrochemical corrosion!)
        const freeAnMol = v.moles[anMat.solidId] || 0;
        let dFreeAn = 0;
        if (freeAnMol > 1e-8) {
          dFreeAn = Math.min(freeAnMol, Math.max(0, neMol / anMat.nEq - dAnMetal * 0.5));
          if (dFreeAn > 1e-10) {
            addMolSafe(v.moles, anMat.solidId, -dFreeAn);
            addMolSafe(v.moles, anMat.ionId, dFreeAn);
          }
        }
        const totalOxNe = (dAnMetal + dFreeAn) * anMat.nEq;
        if (totalOxNe > 1e-10) {
          if ((v.moles.H_aq || 0) > 1e-6) {
            const dH2 = Math.min((v.moles.H_aq || 0) / 2, totalOxNe / 2);
            addMolSafe(v.moles, 'H_aq', -2 * dH2);
            sim.emitElectrolysisGas(v, 'H2_g', dH2, cathEl.x, cathEl);
            cathEl.gasBubbleType = 'H2_g';
            cathEl.gasBubbleRate = dH2 / Math.max(1e-4, dt);
          } else {
            // Neutral aerated electrolyte: O2 + 2H2O + 4e- -> 4OH- reduction at Cathode
            const dOH = Math.min((v.moles.H2O_l || 0) * 0.5, totalOxNe);
            addMolSafe(v.moles, 'H2O_l', -0.5 * dOH);
            addMolSafe(v.moles, 'OH_aq', dOH);
          }
          v.activeReactions = [
            ...(v.activeReactions || []),
            {
              id: 'cathodic_protection',
              equation: `${anEl.material}(Anode) → ${anEl.material}${anMat.nEq === 3 ? '³⁺' : anMat.nEq === 2 ? '²⁺' : '⁺'} + ${anMat.nEq}e⁻  ⟶  Cathode ${cathEl.material} ${(v.moles.H_aq || 0) > 1e-6 ? '(H₂↑)' : '(O₂ + H₂O → OH⁻)'}`,
              nameVi: `Ăn mòn điện hóa áp đảo & bảo vệ ${cathEl.material} (${currentA.toFixed(2)} A)`,
              nameEn: `Dominant Galvanic Corrosion ${anEl.material}–${cathEl.material} (${currentA.toFixed(2)} A)`,
              descVi: `Pin điện hóa kín mạch chuyển phản ứng khử H⁺/O₂ sang cực ${cathEl.material}, bảo vệ hoàn toàn Cathode và tăng tốc hòa tan ${anEl.material} gấp nhiều lần ăn mòn hóa học.`,
              descEn: `Closed Galvanic couple shifts cathodic reduction onto ${cathEl.material}, fully protecting cathode and accelerating ${anEl.material} anodic dissolution ~4–8×.`,
              rateMolS: totalOxNe / Math.max(1e-4, dt),
              vigorousGas: false,
              dXi: totalOxNe,
            },
          ];
        }
      }
      continue;
    }

    const allowLoad = (meter.mode || 'voltmeter') !== 'voltmeter';
    stepGalvanicInstrument(
      sim,
      meter,
      elPos,
      elNeg,
      infoPos,
      infoNeg,
      items,
      dt,
      allowLoad,
      meter.mode === 'short' ? 0.25 : 2.2,
      coupledAnodeEls,
      coupledCathodeEls
    );
  }

  // Step direct chemical surface reactions & displacement on all immersed electrodes
  for (const el of electrodes) {
    const info = getElectrodeLiquidInfo(items, el);
    if (!info) continue;
    stepElectrodeDirectSurfaceChemistry(sim, el, info.vessel, info.liqL, dt, coupledAnodeEls, coupledCathodeEls);
  }
}

function stepTwoVesselElectrolysis(sim, sup, elPos, elNeg, infoPos, infoNeg, bridgeOrPath, dt) {
  const bridgeList = Array.isArray(bridgeOrPath) ? bridgeOrPath : bridgeOrPath ? [bridgeOrPath] : [];
  const CATHODE_AREA_DM2 = 0.08;
  const vPos = infoPos.vessel;
  const vNeg = infoNeg.vessel;
  const vSet = Math.max(0, Math.min(12, sup.voltageV ?? 6.0));
  const rheoOhm = Math.max(0.2, Math.min(25, sup.rheostatOhm ?? 2.0));
  const condPos = Math.min(1.0, 0.08 + 0.35 * computeTotalElectrolyteIons(vPos.moles) / Math.max(0.05, infoPos.liqL));
  const condNeg = Math.min(1.0, 0.08 + 0.35 * computeTotalElectrolyteIons(vNeg.moles) / Math.max(0.05, infoNeg.liqL));
  const foulOhm = bridgeList.reduce((acc, b) => acc + Math.max(0, (b.junctionResistanceOhm || 0.6) - 0.6), 0);
  const effRes = rheoOhm + foulOhm + (1.8 * Math.max(1, bridgeList.length)) / Math.max(0.04, Math.min(condPos, condNeg));
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

  if ((vNeg.moles.Ag_aq || 0) > 1e-7) {
    const dAg = Math.min(vNeg.moles.Ag_aq, neMol);
    addMolSafe(vNeg.moles, 'Ag_aq', -dAg);
    addMolSafe(vNeg.moles, 'Ag_s', dAg);
    elNeg.platedMaterial = 'Ag';
    elNeg.platedAgMol = (elNeg.platedAgMol || 0) + dAg;
    cathDesc = 'Ag⁺ + e⁻ → Ag(s)';
  } else if ((vNeg.moles.Cu2_aq || 0) > 1e-7) {
    const dCu = Math.min(vNeg.moles.Cu2_aq, neMol / 2);
    addMolSafe(vNeg.moles, 'Cu2_aq', -dCu);
    addMolSafe(vNeg.moles, 'Cu_s', dCu);
    elNeg.platedMaterial = 'Cu';
    elNeg.platedCuMol = (elNeg.platedCuMol || 0) + dCu;
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
    const dNaMig = Math.min(vPos.moles.Na_aq || 0, 2 * dH2);
    if (dNaMig > 1e-11) {
      addMolSafe(vPos.moles, 'Na_aq', -dNaMig);
      addMolSafe(vNeg.moles, 'Na_aq', dNaMig);
    }
    sim.emitElectrolysisGas(vNeg, 'H2_g', dH2, elNeg.x, elNeg);
    elNeg.gasBubbleType = 'H2_g';
    elNeg.gasBubbleRate = dH2 / Math.max(1e-4, dt);
  }

  const cClPos = (vPos.moles.Cl_aq || 0) / Math.max(1e-5, infoPos.liqL);
  const anMat = ELECTRODE_MATERIALS[elPos.material];
  if (anMat?.solidId && elPos.material !== 'C' && elPos.material !== 'Pt' && elPos.material !== 'SHE' && ensureElectrodeMetalMoles(elPos) > 1e-9) {
    oxidizeAnodeMetal(vPos, elPos, neMol);
    anDesc = `${anMat.id}(s) → ${anMat.id}${anMat.nEq === 3 ? '³⁺' : anMat.nEq === 2 ? '²⁺' : '⁺'}(aq) + ${anMat.nEq}e⁻`;
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

  for (const sb of bridgeList) {
    migrateSaltBridgeChargeBalance(sb, vPos, vNeg, neMol);
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

function stepGalvanicInstrument(
  sim,
  inst,
  elPos,
  elNeg,
  infoPos,
  infoNeg,
  items,
  dt,
  allowLoad = false,
  loadOhm = 2.2,
  coupledAnodeEls = null,
  coupledCathodeEls = null
) {
  const bridgePath = findBridgingSaltBridgePath(items, infoPos.vessel.id, infoNeg.vessel.id);
  if (!bridgePath || bridgePath.length === 0) {
    inst.circuitMode = 'open_circuit';
    inst.measuredV = 0;
    inst.measuredCurrentA = 0;
    return;
  }

  const e1 = computeHalfCellPotentialV(elPos, infoPos.vessel, infoPos.liqL, items);
  const e2 = computeHalfCellPotentialV(elNeg, infoNeg.vessel, infoNeg.liqL, items);
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

  const cathMat = ELECTRODE_MATERIALS[cathEl.material];
  const anMat = ELECTRODE_MATERIALS[anEl.material];
  const cm = cathInfo.vessel.moles;
  const hasCathIon =
    (cathEl.material === 'Cu' && ((cm.Cu2_aq || 0) > 1e-6 || (cm.CuNH3_4_2_aq || 0) > 1e-6)) ||
    (cathEl.material === 'Ag' && (cm.Ag_aq || 0) > 1e-6) ||
    (cathMat?.ionId && (cm[cathMat.ionId] || 0) > 1e-6) ||
    (cm.H_aq || 0) > 1e-5;
  const foulRes = bridgePath.reduce((acc, b) => acc + Math.max(0, (b.junctionResistanceOhm || 0.6) - 0.6), 0);
  const currentA = hasCathIon ? Math.min(2.4, emfV / Math.max(0.2, loadOhm + foulRes)) : 0;
  inst.measuredCurrentA = currentA;
  if (currentA > 1e-5) {
    for (const sb of bridgePath) sb.activeCurrentA = Math.max(sb.activeCurrentA || 0, currentA);
  }
  if (currentA <= 1e-5) return;

  if (coupledAnodeEls) coupledAnodeEls.add(anEl.id);
  if (coupledCathodeEls) coupledCathodeEls.add(cathEl.id);
  cathEl.cathodicProtectedActive = true;
  if (anMat?.solidId) {
    anEl.galvanicDominantActive = true;
    markVesselElectroOverride(anInfo.vessel, anMat.solidId, { role: 'anode', chemRetentionFrac: 0.08 });
  }
  if (cathMat?.solidId) {
    markVesselElectroOverride(cathInfo.vessel, cathMat.solidId, { role: 'cathode', chemRetentionFrac: 0.0 });
  }

  const neMol = (currentA * dt) / CONSTANTS.FARADAY_C_MOL;

  // Anode oxidation (supports SHE H2(g) -> 2H+ + 2e- as well as all active metals)
  let anEqLeft = anEl.material;
  let anEqRight = anEl.material;
  if (anEl.material === 'SHE') {
    addMolSafe(anInfo.vessel.moles, 'H_aq', neMol);
    anEqLeft = '½H₂(g)';
    anEqRight = 'H⁺(aq)';
  } else if (anMat?.solidId) {
    oxidizeAnodeMetal(anInfo.vessel, anEl, neMol);
    anEqLeft = `${anMat.id}(s)`;
    anEqRight = `${anMat.id}${anMat.nEq === 3 ? '³⁺' : anMat.nEq === 2 ? '²⁺' : '⁺'}`;
  }

  // Cathode reduction (Ag+ / Cu2+ / [Cu(NH3)4]2+ / other cation / 2H+ -> H2 at SHE or Pt/C/Cu)
  let cathEqLeft = '2H⁺';
  let cathEqRight = 'H₂↑';
  if (cathEl.material === 'SHE' && (cm.H_aq || 0) > 1e-6) {
    const dH2 = Math.min((cm.H_aq || 0) / 2, neMol / 2);
    addMolSafe(cm, 'H_aq', -2 * dH2);
    sim.emitElectrolysisGas(cathInfo.vessel, 'H2_g', dH2, cathEl.x, cathEl);
    cathEl.gasBubbleType = 'H2_g';
    cathEl.gasBubbleRate = dH2 / Math.max(1e-4, dt);
    cathEqLeft = '2H⁺(SHE)';
    cathEqRight = 'H₂(g)↑';
  } else if (cathEl.material === 'Ag' && (cm.Ag_aq || 0) > 1e-6) {
    const dAg = Math.min(cm.Ag_aq, neMol);
    addMolSafe(cm, 'Ag_aq', -dAg);
    addMolSafe(cm, 'Ag_s', dAg);
    cathEl.platedMaterial = 'Ag';
    cathEl.platedAgMol = (cathEl.platedAgMol || 0) + dAg;
    cathEqLeft = 'Ag⁺';
    cathEqRight = 'Ag(s)';
  } else if (cathEl.material === 'Cu' && (cm.Cu2_aq || 0) > 1e-6) {
    const dCu = Math.min(cm.Cu2_aq, neMol / 2);
    addMolSafe(cm, 'Cu2_aq', -dCu);
    addMolSafe(cm, 'Cu_s', dCu);
    cathEl.platedMaterial = 'Cu';
    cathEl.platedCuMol = (cathEl.platedCuMol || 0) + dCu;
    cathEqLeft = 'Cu²⁺';
    cathEqRight = 'Cu(s)';
  } else if (cathEl.material === 'Cu' && (cm.CuNH3_4_2_aq || 0) > 1e-6) {
    const dCu = Math.min(cm.CuNH3_4_2_aq, neMol / 2);
    addMolSafe(cm, 'CuNH3_4_2_aq', -dCu);
    addMolSafe(cm, 'NH3_aq', 4 * dCu);
    addMolSafe(cm, 'Cu_s', dCu);
    cathEqLeft = '[Cu(NH₃)₄]²⁺';
    cathEqRight = 'Cu(s)';
  } else if (cathMat?.ionId && cathMat.ionId !== 'H_aq' && (cm[cathMat.ionId] || 0) > 1e-6 && cathMat.nEq > 0) {
    const dMRed = Math.min(cm[cathMat.ionId], neMol / cathMat.nEq);
    addMolSafe(cm, cathMat.ionId, -dMRed);
    if (cathMat.solidId) addMolSafe(cm, cathMat.solidId, dMRed);
    cathEqLeft = `${cathMat.id}${cathMat.nEq === 3 ? '³⁺' : cathMat.nEq === 2 ? '²⁺' : '⁺'}`;
    cathEqRight = `${cathMat.id}(s)`;
  } else if ((cm.H_aq || 0) > 1e-5) {
    const dH2 = Math.min(cm.H_aq / 2, neMol / 2);
    addMolSafe(cm, 'H_aq', -2 * dH2);
    sim.emitElectrolysisGas(cathInfo.vessel, 'H2_g', dH2, cathEl.x, cathEl);
    cathEl.gasBubbleType = 'H2_g';
    cathEl.gasBubbleRate = dH2 / Math.max(1e-4, dt);
  }

  for (const sb of bridgePath) {
    migrateSaltBridgeChargeBalance(sb, anInfo.vessel, cathInfo.vessel, neMol);
  }

  const eqStr = `${anEqLeft} + ${cathEqLeft} → ${anEqRight} + ${cathEqRight} (E = +${emfV.toFixed(3)} V)`;
  anInfo.vessel.activeReactions = [
    ...(anInfo.vessel.activeReactions || []),
    {
      id: 'galvanic_cell_anode',
      equation: eqStr,
      nameVi: `Pin Galvanic ${anEl.material}–${cathEl.material} (${emfV.toFixed(3)} V)`,
      nameEn: `Galvanic Cell ${anEl.material}–${cathEl.material} (${emfV.toFixed(3)} V)`,
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
  const activeHalfEl = dockedEls.find((e) => ELECTRODE_MATERIALS[e.material]?.e0 != null);
  if (activeHalfEl) {
    ehV = computeHalfCellPotentialV(activeHalfEl, vessel, vSafe, items);
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
  } else if ((m.Ni2_aq || 0) > 1e-7) {
    ehV = -0.257 + (rtF / 2) * Math.log(Math.max(1e-12, (m.Ni2_aq || 0) / vSafe));
  } else if ((m.Zn2_aq || 0) > 1e-7) {
    ehV = -0.7618 + (rtF / 2) * Math.log(Math.max(1e-12, (m.Zn2_aq || 0) / vSafe));
  } else {
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
      const eSelf = computeHalfCellPotentialV(selfEl, vessel, vSafe, items);
      const ePart = computeHalfCellPotentialV(partnerEl, partnerV, partnerLiq, items);
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
