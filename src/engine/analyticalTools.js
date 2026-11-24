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
export const SPECTROMETER_MODES = ['uvvis_kinetics', 'uvvis_spectrum', 'ir_spectrum'];

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

// Full UV-Vis spectral bands [centerNm, sigmaNm, epsPeak, tagVi, tagEn] across 220–750 nm
const UVVIS_BANDS = {
  MnO4_aq: [
    [526, 30, 2400, 'MnO₄⁻ (λmax ~526 nm)', 'MnO₄⁻ (λmax ~526 nm)'],
    [546, 22, 1650, 'MnO₄⁻ d–d/CT', 'MnO₄⁻ vibronic'],
    [310, 26, 1450, 'MnO₄⁻ (UV CT)', 'MnO₄⁻ (UV LMCT)'],
  ],
  Cr2O7_2_aq: [
    [352, 34, 3050, 'Cr₂O₇²⁻ (352 nm)', 'Cr₂O₇²⁻ (352 nm)'],
    [440, 32, 460, 'Cr₂O₇²⁻ (440 nm)', 'Cr₂O₇²⁻ (440 nm)'],
    [258, 22, 4200, 'Cr₂O₇²⁻ (UV)', 'Cr₂O₇²⁻ (UV)'],
  ],
  CrO4_2_aq: [
    [372, 28, 4800, 'CrO₄²⁻ (372 nm)', 'CrO₄²⁻ (372 nm)'],
    [274, 24, 3650, 'CrO₄²⁻ (274 nm)', 'CrO₄²⁻ (274 nm)'],
  ],
  Br2_aq: [
    [395, 36, 210, 'Br₂(aq)', 'Br₂(aq)'],
    [270, 24, 920, 'Br₂ (UV)', 'Br₂ (UV)'],
  ],
  Br2_l: [
    [400, 38, 225, 'Br₂(l)', 'Br₂(l)'],
    [272, 24, 980, 'Br₂ (UV)', 'Br₂ (UV)'],
  ],
  I2_aq: [
    [460, 42, 760, 'I₂(aq) (460 nm)', 'I₂(aq) (460 nm)'],
    [288, 22, 4200, 'I₂ (UV)', 'I₂ (UV)'],
  ],
  I3_aq: [
    [288, 22, 38000, 'I₃⁻ (288 nm)', 'I₃⁻ (288 nm)'],
    [353, 28, 25000, 'I₃⁻ (353 nm)', 'I₃⁻ (353 nm)'],
    [465, 36, 1280, 'I₃⁻ (Vis)', 'I₃⁻ (Vis)'],
  ],
  Cu2_aq: [
    [740, 75, 19, 'Cu²⁺ d–d', 'Cu²⁺ d–d'],
    [245, 22, 320, 'Cu²⁺ (UV)', 'Cu²⁺ (UV)'],
  ],
  CuNH3_4_2_aq: [
    [605, 58, 58, '[Cu(NH₃)₄]²⁺ (605 nm)', '[Cu(NH₃)₄]²⁺ (605 nm)'],
    [262, 24, 960, '[Cu(NH₃)₄]²⁺ CT', '[Cu(NH₃)₄]²⁺ CT'],
  ],
  CuPeptide_aq: [
    [540, 46, 62, 'Phức Cu–Peptide (Biuret)', 'Cu–Peptide Complex (Biuret)'],
    [272, 22, 780, 'Peptide (UV)', 'Peptide (UV)'],
  ],
  CuGlc2_aq: [[655, 68, 48, 'Phức Cu–Glucose', 'Cu–Glucose Complex']],
  CuSuc2_aq: [[655, 68, 48, 'Phức Cu–Sucrose', 'Cu–Sucrose Complex']],
  CuC2H4O2_aq: [[650, 66, 46, 'Phức Cu–Glycerol', 'Cu–Glycerol Complex']],
  StarchI2_aq: [
    [592, 68, 14800, 'Hồ tinh bột–I₂ (592 nm)', 'Starch–I₂ Complex (592 nm)'],
    [355, 34, 6500, 'Tinh bột–I₂ (UV)', 'Starch–I₂ (UV)'],
  ],
  Phenolphthalein_aq: [
    [552, 28, 26000, 'Phenolphthalein²⁻ (552 nm)', 'Phenolphthalein²⁻ (552 nm)'],
    [278, 22, 3600, 'Phenolphthalein (π→π*)', 'Phenolphthalein (π→π*)'],
  ],
  Fe3_aq: [
    [296, 26, 2200, 'Fe³⁺ (UV CT)', 'Fe³⁺ (UV CT)'],
    [404, 34, 155, 'Fe³⁺ (404 nm)', 'Fe³⁺ (404 nm)'],
  ],
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
    const sp = SPECIES[spId];
    let effMol = nMol;
    if (spId === 'Phenolphthalein_aq') {
      effMol = nMol * Math.max(0, computePhenolphthaleinAlpha(ph, vessel.phenBleachFrac || 0));
    }
    const conc = effMol / liqL;
    if (Array.isArray(sp?.uvVisBands) && sp.uvVisBands.length > 0) {
      let epsWl = 0;
      for (const b of sp.uvVisBands) {
        const sig = b.sigmaNm || (b.fwhmNm ? b.fwhmNm / 2.3548 : 30);
        const z = (wl - b.lambdaNm) / Math.max(4, sig);
        if (Math.abs(z) < 4.2 && b.eps > 0) epsWl += b.eps * Math.exp(-0.5 * z * z);
      }
      if (epsWl > 0) A += epsWl * bCm * conc;
      continue;
    }
    const tbl = CHROMOPHORE_EPSILON[spId];
    if (!tbl || !(tbl[wl] > 0)) continue;
    A += tbl[wl] * bCm * conc;
  }

  const clampedA = Math.min(3.5, Math.max(0, A));
  const transmittancePct = Math.max(0, Math.min(100, 100 * Math.pow(10, -clampedA)));
  return { absorbance: clampedA, transmittancePct };
}

/**
 * Property-driven functional-group inference combining SPECIES metadata, lipids/soaps, and formula topology.
 */
export function inferSpectroFunctionalGroups(spId, sp = SPECIES[spId]) {
  if (!sp && !spId) return {};
  const fg = { ...(sp?.functionalGroups || {}) };
  const id = String(spId || sp?.id || '');
  const fRaw = String(sp?.formula || id);

  const isInorgIon =
    id === 'OH_aq' ||
    id === 'H_aq' ||
    id === 'Na_aq' ||
    id === 'K_aq' ||
    id === 'Cl_aq' ||
    id === 'Br_aq' ||
    id === 'I_aq' ||
    id === 'SO4_2_aq' ||
    id === 'HSO4_aq' ||
    id === 'NO3_aq' ||
    id === 'CO3_2_aq' ||
    id === 'HCO3_aq' ||
    id === 'NH4_aq' ||
    id === 'Cu2_aq' ||
    id === 'Fe2_aq' ||
    id === 'Fe3_aq' ||
    id === 'Ag_aq' ||
    id === 'Ca2_aq' ||
    id === 'Mg2_aq' ||
    id === 'Ba2_aq' ||
    id === 'Zn2_aq' ||
    id === 'Al3_aq' ||
    id === 'H2O_l' ||
    id === 'H2O_s' ||
    id === 'H2O_g';
  if (isInorgIon) return fg;

  const isOrganic =
    Boolean(sp?.atoms?.C > 0 || sp?.isFat || sp?.isSoapIon || sp?.isSoapSolid || sp?.isPolymer || Object.keys(fg).length > 0) ||
    /^(CH|C[2-9]|C\d{2}|HCOO|BrCH|ClCH|CHI3|Ag2C2|C6H)/.test(id) ||
    id.includes('Peptide') ||
    id.includes('Glycin') ||
    id.includes('Glc') ||
    id.includes('Suc') ||
    id.includes('Starch') ||
    id.includes('Phenolphthalein') ||
    id === 'NH2CH2COOH_s' ||
    id === 'CH3COONa_s' ||
    id === 'HCOONa_s';
  if (!isOrganic) return fg;

  // Lipid triglycerides & fatty esters
  if (sp?.isFat || id.includes('C57H') || id.includes('C51H') || id.includes('C15H26O6')) {
    fg.isLipid = true;
    fg.isEster = true;
    fg.esterCount = sp?.esterBonds || 3;
    if ((sp?.doubleBondsPerMolecule || 0) > 0) fg.isAlkene = true;
  }
  // Soap carboxylate anions / solid sodium or potassium soaps / organic salts
  if (sp?.isSoapIon || sp?.isSoapSolid || /COO_aq$|COONa_s$|COOK_s$|COO_/.test(id) || id === 'Glycinate_aq') {
    fg.isCarboxylate = true;
    if ((sp?.soapChainLength || 0) >= 6 || /C1[57]H/.test(id)) fg.isAlkane = true;
    if (id.startsWith('C17H33') || id.startsWith('C17H31')) fg.isAlkene = true;
  }
  // Carboxylic acids
  if (/(COOH_l|COOH_s|COOH_aq)$/.test(id) && !id.startsWith('NH2')) {
    fg.isCarboxylicAcid = true;
  }
  // Esters (non-fat simple esters: HCOOCH3, CH3COOC2H5, CH3COOC5H11, etc.)
  if (!fg.isCarboxylicAcid && !fg.isCarboxylate && !fg.isLipid && /(COOC|HCOOC|OOC)/.test(id)) {
    fg.isEster = true;
    fg.esterCount = fg.esterCount || 1;
  }
  // Ketones (acetone CH3COCH3) & Aldehydes
  if (id === 'CH3COCH3_l' || id === 'CH3COCH3_g' || /COCH3/.test(id)) {
    fg.isKetone = true;
  }
  if (/CHO(_l|_aq|_g)?$/.test(id) && !id.includes('COOH')) {
    fg.hasAldehydeGroup = true;
  }
  // Phenols & alcohols
  if (id.includes('C6H5OH') || id.includes('C6H2Br3OH') || id.includes('NO2_3OH') || id.includes('C6H4OH')) {
    fg.isPhenol = true;
    fg.isArene = true;
  }
  if (id === 'C3H5OH_3_l' || id === 'C6H12O6_s' || id === 'C6H12O6_aq' || id === 'C12H22O11_s' || id === 'C12H22O11_aq') {
    fg.hasVicinalDiol = true;
  }
  if (!fg.isPhenol && !fg.isCarboxylicAcid && /(OH_l|OH_aq|OH_s)$/.test(id) && !id.includes('COOH')) {
    fg.isPrimaryAlcohol = true;
  }
  // Arenes & Nitro/Aniline/Benzoic
  if (/(C6H5|C6H4|C6H2|C6H6|C8H8|C10H8|C12H10)/.test(id) || fRaw.includes('C₆H₅') || fRaw.includes('C₆H₆')) {
    fg.isArene = true;
  }
  if (id.includes('NO2')) fg.hasNitroGroup = true;
  if (id.includes('NH2') || id.includes('Glycin')) {
    if (fg.isAminoAcid || id.includes('Glycin') || id === 'NH2CH2COOH_s') {
      fg.isAminoAcid = true;
    } else if (fg.isArene) {
      fg.isAromaticAmine = true;
      fg.isAmine = true;
    } else {
      fg.isAmine = true;
    }
  }
  if (id.includes('Peptide') || fg.hasPeptideBond) {
    fg.hasPeptideBond = true;
  }
  // C-Cl / C-Br halocarbons
  if (sp?.atoms?.Cl > 0 || /Cl/.test(id)) fg.hasCCl = true;
  if (sp?.atoms?.Br > 0 || /Br/.test(id)) fg.hasCBr = true;
  // Saturated C-H hydrocarbons / alkyl chains
  if (
    !fg.isAlkane &&
    ((sp?.atoms?.C >= 1 && (sp?.atoms?.H || 0) >= 2) ||
      fg.isLipid ||
      fg.isEster ||
      fg.isCarboxylicAcid ||
      fg.isPrimaryAlcohol ||
      fg.isKetone ||
      fg.hasAldehydeGroup ||
      fg.isAmine)
  ) {
    fg.isAlkane = true;
  }
  return fg;
}

/**
 * Full UV–Vis Absorption Spectrum (220–750 nm) interpolating known chromophore bands
 * plus UV (220–320 nm) π→π* & n→π* bands for aromatic & conjugated organics.
 */
export function computeUvVisSpectrum(vessel, stepNm = 5) {
  const points = [];
  const dNm = Math.max(2, Math.min(20, Number(stepNm) || 5));
  if (!vessel || vessel.isShattered) {
    for (let nm = 220; nm <= 750; nm += dNm) points.push({ nm, A: 0, T: 100 });
    return { points, maxA: 0, lambdaMaxNm: 525, peaks: [] };
  }
  const spec = APPARATUS[vessel.typeId] || {};
  const strat = computePhaseStratification(vessel.moles, vessel.tempK || 298.15, spec, 0);
  const effLiqL = strat.aqueousL > 1e-6 ? strat.aqueousL : strat.organicL > 1e-6 ? strat.organicL : strat.totalLiqL;
  if (effLiqL <= 1e-6) {
    for (let nm = 220; nm <= 750; nm += dNm) points.push({ nm, A: 0, T: 100 });
    return { points, maxA: 0, lambdaMaxNm: 525, peaks: [] };
  }

  const ph = computePH(vessel.moles, Math.max(1e-6, computeLiquidVolumeL(vessel.moles, vessel.tempK)), vessel.tempK);
  const activeBands = [];

  for (const [spId, nMol] of Object.entries(vessel.moles || {})) {
    if (!Number.isFinite(nMol) || nMol <= 1e-10) continue;
    const sp = SPECIES[spId];
    let effMol = nMol;
    if (spId === 'Phenolphthalein_aq') {
      const alpha = Math.max(0, computePhenolphthaleinAlpha(ph, vessel.phenBleachFrac || 0));
      const concBase = nMol / effLiqL;
      // Basic quinonoid band ~552 nm modulated by alpha; aromatic lactone UV ~278 nm always present
      activeBands.push([552, 28, 26000 * alpha * concBase, 'Phenolphthalein²⁻', 'Phenolphthalein²⁻']);
      activeBands.push([278, 22, 3600 * concBase, 'Phenolphthalein (UV)', 'Phenolphthalein (UV)']);
      continue;
    }

    const conc = effMol / effLiqL;
    if (Array.isArray(sp?.uvVisBands) && sp.uvVisBands.length > 0) {
      for (const b of sp.uvVisBands) {
        const sig = b.sigmaNm || (b.fwhmNm ? b.fwhmNm / 2.3548 : 28);
        const tag = `${sp.formula || spId} (${b.lambdaNm} nm)`;
        activeBands.push([b.lambdaNm, sig, (b.eps || 0) * conc, b.tagVi || tag, b.tagEn || tag]);
      }
      continue;
    }

    const tblBands = UVVIS_BANDS[spId];
    if (tblBands) {
      for (const [cNm, sig, eps, lVi, lEn] of tblBands) {
        activeBands.push([cNm, sig, eps * conc, lVi, lEn]);
      }
      continue;
    }

    // Organic UV bands (220–320 nm) from functionalGroups
    const fg = inferSpectroFunctionalGroups(spId, sp);
    const uvConc = Math.min(2.5, conc); // cap neat organic absorbance cleanly within Beer-Lambert dynamic scale
    if (fg.isArene) {
      const hasAuxochrome = fg.isPhenol || fg.isAromaticAmine || fg.hasAldehydeGroup || fg.isCarboxylicAcid;
      const peakNm = fg.hasNitroGroup ? 305 : fg.isAromaticAmine || fg.hasAldehydeGroup ? 280 : fg.isPhenol ? 272 : 256;
      const peakEps = fg.hasNitroGroup ? 2400 : hasAuxochrome ? 1450 : 280;
      activeBands.push([peakNm, 18, peakEps * uvConc, `${sp?.formula || spId} (UV π→π*)`, `${sp?.formula || spId} (UV π→π*)`]);
      activeBands.push([226, 12, 1900 * uvConc, 'Vòng thơm (E₂ 226 nm)', 'Arene Ring (226 nm)']);
    } else if (fg.isLipid && (sp?.doubleBondsPerMolecule || 0) >= 6) {
      activeBands.push([236, 16, 480 * uvConc, 'Liên hợp π=π (UV)', 'Conjugated Diene (UV)']);
    } else if (fg.hasAldehydeGroup || fg.isKetone) {
      activeBands.push([278, 20, 26 * uvConc, 'C=O (n→π* 278 nm)', 'Carbonyl (n→π* 278 nm)']);
    } else if (fg.isEster || fg.isCarboxylicAcid || fg.isCarboxylate) {
      activeBands.push([224, 14, 52 * uvConc, 'C=O / COO (UV 224 nm)', 'Carbonyl / COO (UV)']);
    }
  }

  let maxA = 0;
  let lambdaMaxNm = 525;
  for (let nm = 220; nm <= 750; nm += dNm) {
    let A = 0;
    for (let i = 0; i < activeBands.length; i++) {
      const [cNm, sig, amp] = activeBands[i];
      if (amp <= 0) continue;
      const z = (nm - cNm) / sig;
      if (Math.abs(z) < 4.2) A += amp * Math.exp(-0.5 * z * z);
    }
    const clampedA = Math.min(3.5, Math.max(0, A));
    const T = Math.max(0, Math.min(100, 100 * Math.pow(10, -clampedA)));
    points.push({ nm, A: clampedA, T });
    if (clampedA > maxA) {
      maxA = clampedA;
      lambdaMaxNm = nm;
    }
  }

  // Detect local absorption peaks (A > 0.025) for auto-annotation
  const peaks = [];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (p.A > 0.025 && p.A >= points[i - 1].A && p.A >= points[i + 1].A) {
      // Find dominant contributor at p.nm
      let bestAmp = 0;
      let labelVi = `${p.nm} nm`;
      let labelEn = `${p.nm} nm`;
      for (const [cNm, sig, amp, lVi, lEn] of activeBands) {
        const z = (p.nm - cNm) / sig;
        const contrib = amp * Math.exp(-0.5 * z * z);
        if (contrib > bestAmp) {
          bestAmp = contrib;
          labelVi = lVi;
          labelEn = lEn;
        }
      }
      if (peaks.length === 0 || Math.abs(p.nm - peaks[peaks.length - 1].nm) >= 24) {
        peaks.push({ nm: p.nm, A: p.A, T: p.T, labelVi, labelEn });
      } else if (p.A > peaks[peaks.length - 1].A) {
        peaks[peaks.length - 1] = { nm: p.nm, A: p.A, T: p.T, labelVi, labelEn };
      }
    }
  }
  peaks.sort((a, b) => b.A - a.A);
  return { points, maxA, lambdaMaxNm, peaks: peaks.slice(0, 5) };
}

// Property-driven IR absorption oscillators calibrated against textbook FTIR / ATR-IR positions
const IR_BAND_CATALOG = {
  oh_alcohol: [
    { wn: 3355, sigma: 135, weight: 1.05, key: 'oh_alcohol', vi: 'O–H (Ancol / Phenol)', en: 'O–H (Alcohol / Phenol)' },
  ],
  oh_acid: [
    { wn: 2980, sigma: 245, weight: 0.92, key: 'oh_acid', vi: 'O–H rộng (Acid -COOH)', en: 'Broad O–H (Carboxylic acid)' },
  ],
  nh_primary: [
    { wn: 3420, sigma: 32, weight: 0.58, key: 'nh_primary_a', vi: 'N–H₂ (Amine I)', en: 'N–H₂ Asym (Primary amine)' },
    { wn: 3340, sigma: 32, weight: 0.52, key: 'nh_primary_b', vi: 'N–H₂ (Amine I)', en: 'N–H₂ Sym (Primary amine)' },
  ],
  nh_secondary: [
    { wn: 3380, sigma: 42, weight: 0.62, key: 'nh_secondary', vi: 'N–H (Amide / Bậc II)', en: 'N–H (Amide / Sec. amine)' },
  ],
  ch_sp2: [
    { wn: 3060, sigma: 30, weight: 0.36, key: 'ch_sp2', vi: '=C–H (Thơm / Alkene)', en: '=C–H (Arene / Alkene)' },
  ],
  ch_sp3: [
    { wn: 2925, sigma: 34, weight: 0.72, key: 'ch_sp3_a', vi: 'C–H (Alkane)', en: 'C–H (Alkane)' },
    { wn: 2855, sigma: 30, weight: 0.48, key: 'ch_sp3_b', vi: 'C–H (Alkane)', en: 'C–H (Alkane)' },
  ],
  ch_aldehyde: [
    { wn: 2820, sigma: 24, weight: 0.42, key: 'ch_ald_a', vi: 'C–H (Aldehyde)', en: 'C–H (Aldehyde)' },
    { wn: 2720, sigma: 24, weight: 0.40, key: 'ch_ald_b', vi: 'C–H (Aldehyde Fermi)', en: 'C–H (Aldehyde)' },
  ],
  co_ester: [
    { wn: 1744, sigma: 18, weight: 1.32, key: 'co_ester', vi: 'C=O (Ester ~1744)', en: 'C=O (Ester ~1744)' },
  ],
  co_aldehyde_ketone: [
    { wn: 1720, sigma: 18, weight: 1.25, key: 'co_carbonyl', vi: 'C=O (Aldehyde/Ketone)', en: 'C=O (Aldehyde/Ketone)' },
  ],
  co_acid: [
    { wn: 1712, sigma: 20, weight: 1.24, key: 'co_acid', vi: 'C=O (Acid ~1712)', en: 'C=O (Carboxylic acid)' },
  ],
  co_amide: [
    { wn: 1655, sigma: 24, weight: 1.05, key: 'co_amide', vi: 'C=O (Amide I)', en: 'C=O (Amide I)' },
  ],
  cc_alkene: [
    { wn: 1645, sigma: 22, weight: 0.34, key: 'cc_alkene', vi: 'C=C (Alkene)', en: 'C=C (Alkene)' },
  ],
  cc_arene: [
    { wn: 1600, sigma: 22, weight: 0.56, key: 'cc_arene_1', vi: 'C=C (Nhân thơm)', en: 'C=C (Aromatic ring)' },
    { wn: 1495, sigma: 22, weight: 0.48, key: 'cc_arene_2', vi: 'Vòng thơm (~1500)', en: 'Arene ring (~1500)' },
  ],
  coo_salt: [
    { wn: 1576, sigma: 24, weight: 1.18, key: 'coo_asym', vi: '–COO⁻ bất đối (~1576)', en: '–COO⁻ Asym (~1576)' },
    { wn: 1412, sigma: 26, weight: 0.68, key: 'coo_sym', vi: '–COO⁻ đối xứng (~1412)', en: '–COO⁻ Sym (~1412)' },
  ],
  co_single_ester: [
    { wn: 1235, sigma: 28, weight: 0.72, key: 'co_s1', vi: 'C–O (Ester)', en: 'C–O (Ester)' },
    { wn: 1165, sigma: 26, weight: 0.66, key: 'co_s2', vi: 'C–O–C (~1165)', en: 'C–O–C (~1165)' },
  ],
  co_single_alcohol: [
    { wn: 1055, sigma: 28, weight: 0.62, key: 'co_alc', vi: 'C–O (Ancol)', en: 'C–O (Alcohol)' },
  ],
  co_single_phenol: [
    { wn: 1225, sigma: 26, weight: 0.68, key: 'co_phen', vi: 'C–O (Phenol)', en: 'C–O (Phenol)' },
  ],
  cx_cl: [
    { wn: 740, sigma: 28, weight: 0.72, key: 'cx_cl', vi: 'C–Cl (740)', en: 'C–Cl (740)' },
  ],
  cx_br: [
    { wn: 640, sigma: 28, weight: 0.72, key: 'cx_br', vi: 'C–Br (640)', en: 'C–Br (640)' },
  ],
  water_bg: [
    { wn: 3390, sigma: 185, weight: 1.35, key: 'h2o_oh', vi: 'H₂O nền (O–H)', en: 'H₂O Solvent (O–H)' },
    { wn: 1642, sigma: 42, weight: 0.72, key: 'h2o_bend', vi: 'H₂O uốn (1642)', en: 'H₂O H–O–H Bend' },
  ],
};

/**
 * ATR FT-IR % Transmittance Spectrum Simulation (4000 → 400 cm^-1, reversed standard wavenumber axis).
 * Property-driven from SPECIES functionalGroups & dominant organic/solute stoichiometry.
 */
export function computeIrSpectrum(vessel, options = {}) {
  const { subtractWater = true, stepCm = 15 } = options;
  const dCm = Math.max(5, Math.min(40, Number(stepCm) || 15));
  const points = [];
  if (!vessel || vessel.isShattered) {
    for (let wn = 4000; wn >= 400; wn -= dCm) points.push({ wn, T: 100, A: 0 });
    return { points, peaks: [], subtractWater, hasAnalyte: false };
  }

  const moles = vessel.moles || {};
  const bandScores = Object.create(null);
  let orgWeightedSum = 0;

  // Determine functional-group optical weights weighted by main non-water components
  const contributions = [];
  for (const [spId, nMol] of Object.entries(moles)) {
    if (!Number.isFinite(nMol) || nMol <= 1e-8) continue;
    if (spId === 'H2O_l' || spId === 'H2O_s' || spId === 'H2O_g') continue;
    const sp = SPECIES[spId];
    const fg = inferSpectroFunctionalGroups(spId, sp);
    if (Object.keys(fg).length === 0) continue;

    // Triglycerides carry multiple equivalent ester/chain moieties per mole
    const mult = fg.isLipid ? fg.esterCount || 3 : fg.hasVicinalDiol ? 2 : 1;
    const equivMol = nMol * mult;
    orgWeightedSum += equivMol;
    contributions.push({ spId, sp, fg, nMol, equivMol });
  }

  const normDenom = Math.max(orgWeightedSum, 1e-5);
  const scaleFactor = orgWeightedSum > 1e-6 ? 1.0 : 0.0;
  const addBand = (bandGroupKey, amt) => {
    bandScores[bandGroupKey] = (bandScores[bandGroupKey] || 0) + amt;
  };

  for (const { spId, sp, fg, nMol, equivMol } of contributions) {
    // Use mole fraction of functional-group equivalents so pure/reacted mixtures show clear conversion
    const w = (equivMol / normDenom) * scaleFactor;
    const wSingle = (nMol / normDenom) * scaleFactor;
    if (fg.isPrimaryAlcohol || fg.hasVicinalDiol || fg.isPhenol || fg.isPolysaccharide) {
      const ohStrength = spId === 'C3H5OH_3_l' ? wSingle * 2.2 : wSingle * 1.15;
      addBand('oh_alcohol', ohStrength);
      addBand(fg.isPhenol ? 'co_single_phenol' : 'co_single_alcohol', wSingle * 0.95);
    }
    if (fg.isCarboxylicAcid) {
      addBand('oh_acid', wSingle * 1.05);
      addBand('co_acid', wSingle * 1.12);
    }
    if (fg.hasAminoAcid) {
      addBand('nh_primary', wSingle * 0.85);
      addBand('coo_salt', wSingle * 0.80);
    } else if (fg.isAmine || fg.isAromaticAmine) {
      addBand('nh_primary', wSingle * 0.95);
    }
    if (fg.hasPeptideBond) {
      addBand('nh_secondary', wSingle * 0.90);
      addBand('co_amide', wSingle * 1.0);
    }
    if (fg.isEster || fg.isLipid) {
      const esterMult = fg.isLipid ? (fg.esterCount || 3) * wSingle : wSingle;
      addBand('co_ester', esterMult * 1.12);
      addBand('co_single_ester', esterMult * 0.95);
    }
    if (fg.hasAldehydeGroup) {
      addBand('co_aldehyde_ketone', wSingle * 1.08);
      addBand('ch_aldehyde', wSingle * 0.85);
    } else if (fg.isKetone) {
      addBand('co_aldehyde_ketone', wSingle * 1.12);
    }
    if (fg.isCarboxylate) {
      addBand('coo_salt', wSingle * 1.08);
    }
    if (fg.isArene) {
      addBand('cc_arene', wSingle * 0.92);
      addBand('ch_sp2', wSingle * 0.85);
    }
    if (fg.isAlkene) {
      addBand('cc_alkene', w * 0.72);
      addBand('ch_sp2', w * 0.65);
    }
    if (fg.isAlkane) {
      const chainScale = (sp?.atoms?.C || (fg.isLipid ? 54 : fg.isCarboxylate ? 16 : 2)) >= 8 ? 1.15 : 0.78;
      addBand('ch_sp3', wSingle * chainScale);
    }
    if (fg.hasCCl) addBand('cx_cl', wSingle * 0.95);
    if (fg.hasCBr) addBand('cx_br', wSingle * 0.95);
  }

  const h2oMol = moles.H2O_l || 0;
  if (!subtractWater && h2oMol > 1e-4) {
    const waterScale = Math.min(1.5, 0.75 + 0.15 * Math.log10(1 + h2oMol));
    addBand('water_bg', waterScale);
  }

  // Compile active IR oscillators (functionalGroups + optional SPECIES.irBands overrides)
  const oscillators = [];
  for (const [grpKey, strength] of Object.entries(bandScores)) {
    if (strength <= 0.015) continue;
    const defs = IR_BAND_CATALOG[grpKey];
    if (!defs) continue;
    const clampedStrength = Math.min(1.8, strength);
    for (const d of defs) {
      oscillators.push({
        wn: d.wn,
        sigma: d.sigma,
        amp: d.weight * clampedStrength,
        key: d.key,
        vi: d.vi,
        en: d.en,
      });
    }
  }
  for (const { spId, sp, nMol } of contributions) {
    if (!Array.isArray(sp?.irBands) || sp.irBands.length === 0) continue;
    const wFrac = Math.min(1.8, (nMol / normDenom) * scaleFactor);
    for (const b of sp.irBands) {
      const fwhm = b.fwhm || 30;
      oscillators.push({
        wn: b.wn,
        sigma: Math.max(8, fwhm / 2),
        amp: (b.strength ?? 0.85) * wFrac,
        key: b.key || `${spId}_${b.wn}`,
        vi: b.labelVi || `${sp.formula || spId} (${b.wn} cm⁻¹)`,
        en: b.labelEn || `${sp.formula || spId} (${b.wn} cm⁻¹)`,
      });
    }
  }

  const hasAnalyte = contributions.length > 0 || (!subtractWater && h2oMol > 1e-4);
  for (let wn = 4000; wn >= 400; wn -= dCm) {
    let A = 0;
    for (let i = 0; i < oscillators.length; i++) {
      const o = oscillators[i];
      const dx = (wn - o.wn) / o.sigma;
      if (Math.abs(dx) < 3.6) {
        // Pseudo-Voigt mix (70% Lorentzian + 30% Gaussian) for crisp authentic FT-IR band tails
        const lor = 1 / (1 + dx * dx);
        const gau = Math.exp(-0.5 * dx * dx);
        A += o.amp * (0.65 * lor + 0.35 * gau);
      }
    }
    const clampedA = Math.min(2.2, Math.max(0, A));
    const T = Math.max(0.6, Math.min(100, 100 * Math.pow(10, -clampedA)));
    points.push({ wn, T, A: clampedA });
  }

  // Extract major downward IR absorption troughs (%T < 82%) with labels
  const rawPeaks = [];
  for (let i = 1; i < points.length - 1; i++) {
    const pt = points[i];
    if (pt.T < 82 && pt.T <= points[i - 1].T && pt.T <= points[i + 1].T) {
      let bestScore = 0;
      let labelVi = `${pt.wn} cm⁻¹`;
      let labelEn = `${pt.wn} cm⁻¹`;
      let bandKey = '';
      for (const o of oscillators) {
        const dx = (pt.wn - o.wn) / o.sigma;
        const c = o.amp / (1 + dx * dx);
        if (c > bestScore) {
          bestScore = c;
          labelVi = o.vi;
          labelEn = o.en;
          bandKey = o.key;
        }
      }
      if (rawPeaks.length === 0 || Math.abs(pt.wn - rawPeaks[rawPeaks.length - 1].wn) >= 75) {
        rawPeaks.push({ wn: pt.wn, T: pt.T, A: pt.A, labelVi, labelEn, bandKey });
      } else if (pt.T < rawPeaks[rawPeaks.length - 1].T) {
        rawPeaks[rawPeaks.length - 1] = { wn: pt.wn, T: pt.T, A: pt.A, labelVi, labelEn, bandKey };
      }
    }
  }
  rawPeaks.sort((a, b) => a.T - b.T);
  return { points, peaks: rawPeaks.slice(0, 6), subtractWater, hasAnalyte };
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

const TLC_FALLBACK_PALETTE = [
  '#f43f5e', '#f59e0b', '#8b5cf6', '#0ea5e9',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1',
  '#84cc16', '#06b6d4', '#e11d48', '#d97706',
  '#7c3aed', '#0284c7', '#c026d3', '#0d9488',
];

function resolveTlcSpotColor(spId, sp) {
  if (sp?.tlcColor) return sp.tlcColor;
  if (TLC_SPOT_COLORS[spId]) return TLC_SPOT_COLORS[spId];
  let hash = 2166136261;
  for (let i = 0; i < spId.length; i++) {
    hash ^= spId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return TLC_FALLBACK_PALETTE[(hash >>> 0) % TLC_FALLBACK_PALETTE.length];
}

export function resolveTlcUvActive(sp) {
  if (!sp) return false;
  if (typeof sp.uvActive === 'boolean') return sp.uvActive;
  if (typeof sp.isUV === 'boolean') return sp.isUV;
  const fg = sp.functionalGroups || {};
  if (fg.isArene || fg.isPhenol || fg.isAromaticAmine) return true;
  if (fg.isConjugatedDiene || fg.hasConjugatedPi || fg.hasAzoGroup || fg.hasNitroGroup) return true;
  // Conjugated α,β-unsaturated carbonyls absorb UV-254, whereas isolated alkenes/aldehydes/sugars do not
  if (fg.isAlkene && (fg.hasAldehydeGroup || fg.isKetone || fg.isCarboxylicAcid || fg.isEster)) return true;
  return false;
}

function computeVesselEluentStrength(vessel) {
  let sumWeight = 0;
  let weightedElu = 0;
  for (const [spId, nMol] of Object.entries(vessel.moles || {})) {
    if (!Number.isFinite(nMol) || nMol <= 1e-6) continue;
    const sp = SPECIES[spId];
    const str = typeof sp?.eluentStrength === 'number' ? sp.eluentStrength : ELUENT_STRENGTH[spId];
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
    const fg = sp.functionalGroups || {};
    // Exclude pure water, macromolecules/polymers/polysaccharides/proteins, and insoluble coagulated precipitates
    const isInsolubleMacromolecule =
      sp.isPolymer ||
      fg.isPolysaccharide ||
      fg.isProtein ||
      fg.isEnzyme ||
      (sp.isPrecipitate && (fg.hasPeptideBond || sp.noMelt || sp.isSoapSolid));
    if (spId === 'H2O_l' || isInsolubleMacromolecule) continue;
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
      color: resolveTlcSpotColor(spId, sp),
      uvActive: resolveTlcUvActive(sp),
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
      item.measuredLambdaMax = wl;
      item.measuredSpectrumMaxA = 0;
      return;
    }
    const v = hit.vessel;
    const { absorbance, transmittancePct } = computeBeerLambertReading(v, wl);
    item.contactVesselId = v.id;
    item.contactLabel = v.label || v.typeId;
    item.measuredAbsorbance = absorbance;
    item.measuredTransmittance = transmittancePct;
    if (item.spectroMode === 'uvvis_spectrum') {
      const uv = computeUvVisSpectrum(v, 10);
      item.measuredLambdaMax = uv.lambdaMaxNm;
      item.measuredSpectrumMaxA = uv.maxA;
    } else if (item.spectroMode === 'ir_spectrum') {
      item.measuredLambdaMax = 1740;
      item.measuredSpectrumMaxA = absorbance;
    }
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
