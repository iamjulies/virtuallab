/**
 * Quantitative Analytical Instruments & Separation Engine (Prompt 67):
 *  - pH / Conductivity Dual Probe (`ph_conductometer`) with real-time titration curve capture
 *  - Beer-Lambert Optical Colorimeter (`colorimeter`) across visible LED wavelengths
 *  - Thin-Layer Chromatography Silica Plate (`tlc_plate`) separation by analyte polarity vs eluent
 */

import { APPARATUS, getProbeTipPos } from '../data/apparatus.js';
import { SPECIES } from '../data/species.js';
import {
  computeVesselElectrochemicalMetrics,
  computeLiquidVolumeL,
  computePH,
  computePhaseStratification,
  computePhenolphthaleinAlpha,
} from './equilibrium.js';

export const COLORIMETER_WAVELENGTHS = [420, 470, 525, 590, 635];

// Molar absorptivity epsilon (L / mol*cm) calibrated for educational visible-band behavior
const CHROMOPHORE_EPSILON = {
  MnO4_aq: { 420: 120, 470: 550, 525: 2400, 590: 180, 635: 15 },
  Cr2O7_2_aq: { 420: 420, 470: 180, 525: 28, 590: 4, 635: 1 },
  CrO4_2_aq: { 420: 1200, 470: 85, 525: 5, 590: 1, 635: 0 },
  Br2_aq: { 420: 170, 470: 95, 525: 14, 590: 2, 635: 0 },
  Br2_l: { 420: 180, 470: 105, 525: 18, 590: 3, 635: 1 },
  I2_aq: { 420: 520, 470: 740, 525: 190, 590: 22, 635: 4 },
  I3_aq: { 420: 980, 470: 1250, 525: 210, 590: 25, 635: 4 },
  Cu2_aq: { 420: 2, 470: 3, 525: 6, 590: 10, 635: 18 },
  CuNH3_4_2_aq: { 420: 4, 470: 8, 525: 28, 590: 55, 635: 48 },
  CuPeptide_aq: { 420: 6, 470: 15, 525: 58, 590: 25, 635: 6 },
  CuGlc2_aq: { 420: 3, 470: 6, 525: 14, 590: 34, 635: 45 },
  CuSuc2_aq: { 420: 3, 470: 6, 525: 14, 590: 34, 635: 45 },
  CuC2H4O2_aq: { 420: 3, 470: 6, 525: 14, 590: 34, 635: 45 },
  StarchI2_aq: { 420: 1200, 470: 2800, 525: 8500, 590: 14500, 635: 11000 },
  Phenolphthalein_aq: { 420: 120, 470: 1100, 525: 18000, 590: 3200, 635: 80 },
  Fe3_aq: { 420: 120, 470: 42, 525: 6, 590: 1, 635: 0 },
};

const ELUENT_STRENGTH = {
  C6H14_l: 0.01,
  C6H12_l: 0.05,
  C6H6_l: 0.32,
  C6H5CH3_l: 0.29,
  CHCl3_l: 0.40,
  CH3COOC2H5_l: 0.58,
  CH3COOC3H7_l: 0.56,
  CH3COOCH3_l: 0.60,
  CH3COCH3_l: 0.56,
  C3H7OH_l: 0.82,
  C2H5OH_l: 0.88,
  CH3OH_l: 0.95,
  H2O_l: 0.95,
};

function findImmersedVessel(sim, tipX, tipY) {
  for (let i = sim.items.length - 1; i >= 0; i--) {
    const v = sim.items[i];
    if (v.kind !== 'vessel' || v.isShattered || v.isBroken) continue;
    const spec = APPARATUS[v.typeId];
    if (!spec) continue;
    const hw = Math.max(18, spec.width * 0.46);
    const hh = Math.max(20, spec.height * 0.52);
    if (Math.abs(tipX - v.x) <= hw && tipY >= v.y - hh - 4 && tipY <= v.y + hh + 6) {
      const strat = computePhaseStratification(v.moles, v.tempK || 298.15, spec, 0);
      if (strat.totalLiqL > 1e-6) return { vessel: v, strat };
    }
  }
  return null;
}

/**
 * Beer-Lambert Absorbance A = sum(eps(lambda) * b * c) at b = 1.0 cm and %T = 100 * 10^(-A).
 */
export function computeBeerLambertReading(vessel, wavelengthNm = 525) {
  if (!vessel || vessel.isShattered) return { absorbance: 0, transmittancePct: 100 };
  const spec = APPARATUS[vessel.typeId] || {};
  const strat = computePhaseStratification(vessel.moles, vessel.tempK || 298.15, spec, 0);
  const liqL = strat.aqueousL > 1e-6 ? strat.aqueousL : strat.totalLiqL;
  if (liqL <= 1e-6) return { absorbance: 0, transmittancePct: 100 };

  const wl = COLORIMETER_WAVELENGTHS.includes(wavelengthNm) ? wavelengthNm : 525;
  const ph = computePH(vessel.moles, Math.max(1e-6, computeLiquidVolumeL(vessel.moles, vessel.tempK)), vessel.tempK);
  const bCm = 1.0;
  let A = 0;

  for (const [spId, nMol] of Object.entries(vessel.moles || {})) {
    if (!Number.isFinite(nMol) || nMol <= 1e-10) continue;
    const tbl = CHROMOPHORE_EPSILON[spId];
    if (!tbl || !(tbl[wl] > 0)) continue;
    let effMol = nMol;
    if (spId === 'Phenolphthalein_aq') {
      effMol = nMol * Math.max(0, computePhenolphthaleinAlpha(ph, vessel.phenBleachFrac || 0));
    }
    const conc = effMol / liqL;
    A += tbl[wl] * bCm * conc;
  }

  const clampedA = Math.min(3.5, Math.max(0, A));
  const transmittancePct = Math.max(0, Math.min(100, 100 * Math.pow(10, -clampedA)));
  return { absorbance: clampedA, transmittancePct };
}

function estimateAnalytePolarity(sp) {
  if (!sp) return 0.5;
  if (typeof sp.tlcPolarity === 'number') return sp.tlcPolarity;
  const fg = sp.functionalGroups || {};
  if (fg.isPolysaccharide || fg.hasPeptideBond || fg.isAminoAcid) return 0.92;
  if (fg.hasVicinalDiol || fg.isCarboxylicAcid) return 0.85;
  if (fg.isPrimaryAlcohol || fg.isAmine) return 0.58;
  if (fg.hasAldehydeGroup) return 0.40;
  if (fg.isEster) return 0.30;
  if (fg.isHaloalkane) return 0.18;
  if (fg.isArene || fg.isAlkene || fg.isAlkane) return 0.10;
  if ((sp.partitionKow || 0) > 100) return 0.14;
  return 0.48;
}

const TLC_SPOT_COLORS = {
  Br2_l: '#b45309',
  C6H5NH2_l: '#eab308',
  C6H5OH_s: '#f472b6',
  C6H5CHO_l: '#38bdf8',
  C8H8_l: '#a855f7',
  C10H8_s: '#60a5fa',
  C6H6_l: '#818cf8',
  CH3COOC5H11_l: '#fb923c',
  CH3COOC3H7_l: '#34d399',
  C2H5CHO_l: '#2dd4bf',
  C6H14_l: '#94a3b8',
  C6H12_l: '#a78bfa',
};

function computeVesselEluentStrength(vessel) {
  let sumWeight = 0;
  let weightedElu = 0;
  for (const [spId, nMol] of Object.entries(vessel.moles || {})) {
    if (!Number.isFinite(nMol) || nMol <= 1e-6) continue;
    const str = ELUENT_STRENGTH[spId];
    if (str == null) continue;
    sumWeight += nMol;
    weightedElu += nMol * str;
  }
  return sumWeight > 1e-8 ? weightedElu / sumWeight : 0.35;
}

function captureTlcSpots(plate, vessel) {
  const eluentStr = computeVesselEluentStrength(vessel);
  plate.eluentStrength = eluentStr;
  const existing = plate.spots || [];
  const existingMap = new Map(existing.map((s) => [s.id, s]));

  for (const [spId, nMol] of Object.entries(vessel.moles || {})) {
    if (!Number.isFinite(nMol) || nMol <= 1e-5) continue;
    const sp = SPECIES[spId];
    if (!sp || (sp.phase !== 'l' && sp.phase !== 's' && sp.phase !== 'aq')) continue;
    // Skip inorganic salts, pure water, and giant insoluble polymers
    if (spId === 'H2O_l' || sp.isPolymer) continue;
    const isOrganic =
      Boolean(sp.atoms?.C > 0 || sp.functionalGroups || sp.tlcPolarity != null || (sp.liquidGroup && sp.liquidGroup.includes('organic')));
    if (!isOrganic) continue;

    const pol = estimateAnalytePolarity(sp);
    // Polarity vs Eluent Strength: non-polar compounds travel fast (high Rf) in non-polar/mid eluents;
    // increasing eluent polarity boosts Rf across polar substrates symmetrically.
    const rawRf = (1 - pol * 0.85) * 0.55 + eluentStr * (0.45 - 0.18 * pol);
    const rf = Math.max(0.05, Math.min(0.95, +rawRf.toFixed(3)));
    existingMap.set(spId, {
      id: spId,
      formula: sp.formula || spId,
      name: sp.name || spId,
      rf,
      color: TLC_SPOT_COLORS[spId] || (sp.functionalGroups?.isArene ? '#818cf8' : '#38bdf8'),
      uvActive: Boolean(sp.functionalGroups?.isArene || sp.functionalGroups?.isAlkene || sp.functionalGroups?.hasAldehydeGroup || sp.atoms?.C >= 6),
    });
  }
  plate.spots = Array.from(existingMap.values()).slice(0, 8);
}

/**
 * Update pH/Conductivity meter, Beer-Lambert colorimeter, or Silica TLC plate interactions.
 */
export function stepAnalyticalInstruments(sim, item, dt = 0.05) {
  if (!sim || !item) return;
  const tip = getProbeTipPos(item);
  const hit = findImmersedVessel(sim, tip.x, tip.y);

  if (item.kind === 'ph_conductometer') {
    item.history = item.history || [];
    if (!hit) {
      item.contactVesselId = null;
      item.contactLabel = '';
      item.measuredPH = null;
      item.measuredConductivity = null;
      return;
    }
    const v = hit.vessel;
    const liqVolL = computeLiquidVolumeL(v.moles, v.tempK);
    const effL = liqVolL > 1e-6 ? liqVolL : hit.strat.totalLiqL;
    const pH = liqVolL > 1e-6 ? computePH(v.moles, liqVolL, v.tempK) : null;
    const ec = computeVesselElectrochemicalMetrics(v, pH, liqVolL);
    const kappa = ec?.conductivityMSCm ?? 0;

    item.contactVesselId = v.id;
    item.contactLabel = v.label || v.typeId;
    item.measuredPH = pH != null && Number.isFinite(pH) ? pH : null;
    item.measuredConductivity = kappa;
    item._sampleTimer = (item._sampleTimer || 0) + dt;

    const buretteMl = v.buretteDeliveredMl || 0;
    const prev = item.history[item.history.length - 1];
    const volMoved = !prev || Math.abs(buretteMl - (prev.ml || 0)) >= 0.04;
    if (effL > 1e-6 && (volMoved || item._sampleTimer >= 0.45)) {
      item._sampleTimer = 0;
      const tNow = sim.timeSec || 0;
      if (
        !prev ||
        volMoved ||
        Math.abs((item.measuredPH ?? 7) - (prev.pH ?? 7)) >= 0.02 ||
        Math.abs(kappa - (prev.kappa || 0)) >= 0.05 ||
        tNow - (prev.t || 0) >= 1.0
      ) {
        item.history.push({
          t: tNow,
          ml: buretteMl,
          pH: item.measuredPH,
          kappa,
        });
        if (item.history.length > 160) item.history.shift();
      }
    }
  } else if (item.kind === 'colorimeter') {
    item.history = item.history || [];
    const wl = item.wavelengthNm || 525;
    if (!hit) {
      item.contactVesselId = null;
      item.contactLabel = '';
      item.measuredAbsorbance = 0;
      item.measuredTransmittance = 100;
      return;
    }
    const v = hit.vessel;
    const { absorbance, transmittancePct } = computeBeerLambertReading(v, wl);
    item.contactVesselId = v.id;
    item.contactLabel = v.label || v.typeId;
    item.measuredAbsorbance = absorbance;
    item.measuredTransmittance = transmittancePct;
    item._sampleTimer = (item._sampleTimer || 0) + dt;
    if (item._sampleTimer >= 0.25) {
      item._sampleTimer = 0;
      const tNow = sim.timeSec || 0;
      const prev = item.history[item.history.length - 1];
      if (!prev || Math.abs(absorbance - prev.A) >= 0.004 || tNow - prev.t >= 0.8) {
        item.history.push({ t: tNow, A: absorbance, T: transmittancePct, wl });
        if (item.history.length > 140) item.history.shift();
      }
    }
  } else if (item.kind === 'tlc_plate') {
    item.spots = item.spots || [];
    if (!hit) {
      item.contactVesselId = null;
      item.contactLabel = '';
      item.isDeveloping = false;
      return;
    }
    const v = hit.vessel;
    item.contactVesselId = v.id;
    item.contactLabel = v.label || v.typeId;
    item.isDeveloping = true;
    captureTlcSpots(item, v);
    const speed = 0.22 + (item.eluentStrength || 0.35) * 0.14;
    item.solventFront = Math.min(1.0, (item.solventFront || 0) + speed * Math.max(0.01, dt));
  }
}
