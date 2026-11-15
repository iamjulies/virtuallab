import { CONSTANTS, waterDensityGPerMl } from '../data/constants.js';
import { SPECIES } from '../data/species.js';

/**
 * Compute aqueous liquid volume in Liters.
 * Blends infinite-dilution partial molar volume into realistic finite-concentration
 * apparent molar volume so concentrated solutions do not shrink unphysically.
 */
export function computeLiquidVolumeL(moles, tempK = CONSTANTS.T_STD_K) {
  const nH2O = moles.H2O_l || 0;
  const nEtOH = moles.C2H5OH_l || 0;
  if (nH2O <= 1e-12 && nEtOH <= 1e-12) return 0;

  const rho = waterDensityGPerMl(tempK);
  const waterVolMl = (nH2O * SPECIES.H2O_l.molarMass) / rho;
  const etohVolMl = (nEtOH * SPECIES.C2H5OH_l.molarMass) / SPECIES.C2H5OH_l.density;
  // Ethanol-water mixtures exhibit ~3% excess volume contraction
  const mixFactor = nH2O > 1e-9 && nEtOH > 1e-9 ? 0.965 : 1.0;
  const solventVolMl = (waterVolMl + etohVolMl) * mixFactor;

  let diluteVolDeltaMl = 0;
  let totalSoluteMoles = 0;
  let totalSoluteMassG = 0;

  for (const [id, n] of Object.entries(moles)) {
    if (n <= 0) continue;
    const sp = SPECIES[id];
    if (sp && sp.phase === 'aq') {
      totalSoluteMoles += n;
      totalSoluteMassG += n * sp.molarMass;
      if (typeof sp.partialMolarVolMl === 'number') {
        diluteVolDeltaMl += n * sp.partialMolarVolMl;
      }
    }
  }

  // Smoothly blend toward positive effective solute volume (~m/2.25) at high molality
  const waterKg = (nH2O * SPECIES.H2O_l.molarMass) / 1000;
  const etohKg = (nEtOH * SPECIES.C2H5OH_l.molarMass) / 1000;
  const solventKg = waterKg + etohKg;
  const molality = solventKg > 1e-9 ? totalSoluteMoles / solventKg : 0;
  const highConcWeight = molality / (molality + 4.0);
  const concVolDeltaMl = totalSoluteMassG / 2.25;
  const blendedDeltaMl =
    (1 - highConcWeight) * diluteVolDeltaMl + highConcWeight * Math.max(diluteVolDeltaMl, concVolDeltaMl);

  const totalMl = Math.max(solventVolMl * 0.96, solventVolMl + blendedDeltaMl);
  return totalMl / 1000;
}

/**
 * Water auto-ionization constant Kw(T) using Van 't Hoff equation.
 */
export function computeKw(tempK = CONSTANTS.T_STD_K) {
  const T = Math.max(250, Math.min(450, tempK));
  const exponent =
    (-CONSTANTS.DELTA_H_WATER_IONIZATION_J / CONSTANTS.R_J_MOL_K) *
    (1 / T - 1 / CONSTANTS.T_STD_K);
  return CONSTANTS.KW_298 * Math.exp(exponent);
}

/**
 * Exact strong-electrolyte + water auto-ionization pH calculation.
 * Returns null if vessel contains virtually no liquid water.
 */
export function computePH(moles, liquidVolL, tempK = CONSTANTS.T_STD_K) {
  if (liquidVolL <= 1e-6) return null;

  const nH = moles.H_aq || 0;
  const nOH = moles.OH_aq || 0;
  const cNet = (nH - nOH) / liquidVolL;
  const kw = computeKw(tempK);

  let hPlus;
  if (cNet >= 0) {
    hPlus = 0.5 * (cNet + Math.sqrt(cNet * cNet + 4 * kw));
  } else {
    const ohMinus = 0.5 * (-cNet + Math.sqrt(cNet * cNet + 4 * kw));
    hPlus = ohMinus > 0 ? kw / ohMinus : Math.sqrt(kw);
  }
  if (hPlus <= 0) return 14;
  const ph = -Math.log10(hPlus);
  return Math.max(-1.2, Math.min(15.6, ph));
}

/**
 * Equilibrium carbinol (colorless In(OH)^3-) fraction for phenolphthalein at high [OH-].
 */
export function computePhenolphthaleinBleachEq(cOH) {
  const oh = Math.max(0, cOH || 0);
  if (oh <= 1e-6) return 0;
  const term = Math.pow(oh / 0.32, 1.45);
  return term / (1 + term);
}

/**
 * Phenolphthalein fraction in pink basic dianion form (In^2-, pH ~ 8.2..12).
 * Accepts optional dynamic carbinol bleachFrac (0..1) for real-time flash-then-fade kinetics.
 */
export function computePhenolphthaleinAlpha(ph, cOH = null, bleachFrac = null) {
  if (ph === null || ph === undefined) return 0;
  const acidTerm = Math.pow(10, Math.max(-30, Math.min(30, CONSTANTS.PHENOLPHTHALEIN_PKA - ph)));
  const effectiveOH = cOH !== null && cOH !== undefined ? Math.max(0, cOH) : Math.pow(10, Math.min(2, ph - 14));
  const bleach =
    bleachFrac !== null && bleachFrac !== undefined
      ? Math.max(0, Math.min(1, bleachFrac))
      : computePhenolphthaleinBleachEq(effectiveOH);
  return Math.max(0, 1 - bleach) / (1 + acidTerm);
}

/**
 * Strongly acidic orange-red oxonium cation (H3In+) fraction of phenolphthalein (pH < 0).
 */
export function computePhenolphthaleinOrangeAlpha(ph) {
  if (ph === null || ph === undefined) return 0;
  const expo = Math.max(-20, Math.min(20, ph + 0.25));
  return 1 / (1 + Math.pow(10, expo));
}

/**
 * Beer-Lambert RGB optical color calculation for aqueous solution.
 * Returns { css, r, g, b, alpha, hasIndicatorPink, hasIndicatorOrange }
 */
export function computeSolutionVisuals(moles, liquidVolL, ph, opticalPathCm = 6.5, phenBleachFrac = null) {
  if (liquidVolL <= 1e-6) {
    return {
      css: 'rgba(200, 230, 250, 0.25)',
      r: 200,
      g: 230,
      b: 250,
      alpha: 0.25,
      hasIndicatorPink: false,
      hasIndicatorOrange: false,
    };
  }

  // White light reference background normalized [0..1]
  let tr = 1.0;
  let tg = 1.0;
  let tb = 1.0;
  let extraOpacity = 0;
  let indicatorBoost = 0;

  // 1. Copper(II) sky-blue absorption
  const nCu = moles.Cu2_aq || 0;
  if (nCu > 1e-9) {
    const cCu = nCu / liquidVolL;
    const ext = SPECIES.Cu2_aq.extinctionRGB;
    tr *= Math.exp(-ext.r * cCu * opticalPathCm * 0.22);
    tg *= Math.exp(-ext.g * cCu * opticalPathCm * 0.22);
    tb *= Math.exp(-ext.b * cCu * opticalPathCm * 0.22);
    extraOpacity += Math.min(0.45, cCu * 0.45);
  }

  // 2. Phenolphthalein indicator 4-state optics:
  //    pH < 0: H3In+ (orange-red), 0..8.2: H2In (colorless), 8.2..12: In^2- (rose-pink), >13: In(OH)^3- (colorless)
  const nPhen = moles.Phenolphthalein_aq || 0;
  let alphaPink = 0;
  let alphaOrange = 0;
  if (nPhen > 1e-9 && ph !== null) {
    const cPhen = nPhen / liquidVolL;
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    alphaPink = computePhenolphthaleinAlpha(ph, cOH, phenBleachFrac);
    alphaOrange = computePhenolphthaleinOrangeAlpha(ph);

    if (alphaPink > 0.005) {
      const effStrength = Math.min(1.65, (cPhen / 1.0e-5) * 0.42) * alphaPink;
      tr *= Math.exp(-0.02 * effStrength);
      tg *= Math.exp(-1.95 * effStrength);
      tb *= Math.exp(-0.21 * effStrength);
      indicatorBoost = Math.max(indicatorBoost, Math.min(1, effStrength));
      extraOpacity += Math.min(0.5, effStrength * 0.36);
    }

    if (alphaOrange > 0.01) {
      const effOrange = Math.min(1.65, (cPhen / 1.0e-5) * 0.42) * alphaOrange;
      tr *= Math.exp(-0.04 * effOrange);
      tg *= Math.exp(-0.78 * effOrange);
      tb *= Math.exp(-2.45 * effOrange);
      indicatorBoost = Math.max(indicatorBoost, Math.min(1, effOrange));
      extraOpacity += Math.min(0.48, effOrange * 0.35);
    }
  }

  // Base watery tint blended with Beer-Lambert transmission
  const rBase = 224 + 26 * indicatorBoost;
  const gBase = 240 + 4 * indicatorBoost;
  const bBase = 252;
  const r = Math.round(Math.max(12, Math.min(255, rBase * tr)));
  const g = Math.round(Math.max(12, Math.min(255, gBase * tg)));
  const b = Math.round(Math.max(18, Math.min(255, bBase * tb)));
  const alpha = Math.min(0.86, 0.34 + extraOpacity);

  return {
    css: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`,
    r,
    g,
    b,
    alpha,
    hasIndicatorPink: alphaPink > 0.03 && nPhen > 1e-9,
    hasIndicatorOrange: alphaOrange > 0.03 && nPhen > 1e-9,
  };
}

/**
 * Total condensed + trapped gas mass (g) excluding vessel tare mass.
 */
export function computeContentsMassG(moles) {
  let mass = 0;
  for (const [id, n] of Object.entries(moles)) {
    if (n <= 0) continue;
    const sp = SPECIES[id];
    if (sp) {
      mass += n * sp.molarMass;
    }
  }
  return mass;
}

/**
 * Total solid + precipitate volume in mL (contributes to visual fill height).
 */
export function computeSolidVolumeMl(moles) {
  let vol = 0;
  for (const [id, n] of Object.entries(moles)) {
    if (n <= 0) continue;
    const sp = SPECIES[id];
    if (sp && sp.phase === 's' && sp.density) {
      vol += (n * sp.molarMass) / sp.density;
    }
  }
  return vol;
}
