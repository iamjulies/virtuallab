import { CONSTANTS, waterDensityGPerMl } from '../data/constants.js';
import { SPECIES } from '../data/species.js';

/**
 * Compute aqueous liquid volume in Liters.
 * Blends infinite-dilution partial molar volume into realistic finite-concentration
 * apparent molar volume so concentrated solutions do not shrink unphysically.
 */
export function computeLiquidVolumeL(moles, tempK = CONSTANTS.T_STD_K) {
  const nH2O = moles.H2O_l || 0;
  if (nH2O <= 1e-12) return 0;

  const rho = waterDensityGPerMl(tempK);
  const waterVolMl = (nH2O * SPECIES.H2O_l.molarMass) / rho;

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

  // Smoothly blend toward positive effective solute volume (~m/2.15) at high molality
  const waterKg = (nH2O * SPECIES.H2O_l.molarMass) / 1000;
  const molality = waterKg > 1e-9 ? totalSoluteMoles / waterKg : 0;
  const highConcWeight = molality / (molality + 4.0);
  const concVolDeltaMl = totalSoluteMassG / 2.25;
  const blendedDeltaMl =
    (1 - highConcWeight) * diluteVolDeltaMl + highConcWeight * Math.max(diluteVolDeltaMl, concVolDeltaMl);

  const totalMl = Math.max(waterVolMl * 0.96, waterVolMl + blendedDeltaMl);
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
 * Phenolphthalein fraction in pink basic dianion form (In^2-).
 * Accounts for both alkaline transition (H2In -> In^2-, pKa ≈ 9.3)
 * and excess-OH⁻ carbinol bleaching at high [OH⁻] (In^2- + OH⁻ ⇌ In(OH)^3-).
 */
export function computePhenolphthaleinAlpha(ph, cOH = null) {
  if (ph === null || ph === undefined) return 0;
  const acidTerm = Math.pow(10, Math.max(-30, Math.min(30, CONSTANTS.PHENOLPHTHALEIN_PKA - ph)));
  const effectiveOH = cOH !== null && cOH !== undefined ? Math.max(0, cOH) : Math.pow(10, Math.min(2, ph - 14));
  const bleachTerm = Math.pow(effectiveOH / 0.45, 1.5);
  return 1 / (1 + acidTerm + bleachTerm);
}

/**
 * Beer-Lambert RGB optical color calculation for aqueous solution.
 * Returns { css, r, g, b, alpha, turbidity }
 */
export function computeSolutionVisuals(moles, liquidVolL, ph, opticalPathCm = 6.5) {
  if (liquidVolL <= 1e-6) {
    return {
      css: 'rgba(200, 230, 250, 0.25)',
      r: 200,
      g: 230,
      b: 250,
      alpha: 0.25,
      hasIndicatorPink: false,
    };
  }

  // White light reference background normalized [0..1]
  let tr = 1.0;
  let tg = 1.0;
  let tb = 1.0;
  let extraOpacity = 0;
  let pinkBoost = 0;

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

  // 2. Phenolphthalein indicator absorption (rose/magenta-pink in base, fades in excess OH⁻)
  const nPhen = moles.Phenolphthalein_aq || 0;
  let alphaPink = 0;
  if (nPhen > 1e-9 && ph !== null) {
    const cOH = (moles.OH_aq || 0) / liquidVolL;
    alphaPink = computePhenolphthaleinAlpha(ph, cOH);
    if (alphaPink > 0.005) {
      const cPhen = nPhen / liquidVolL;
      // Scale effective optical strength by both indicator concentration and active In^2- fraction
      const effStrength = Math.min(1.65, (cPhen / 1.0e-5) * 0.42) * alphaPink;
      // Absorbs green strongly (~555 nm) while preserving red & blue/violet -> rose/fuchsia pink
      tr *= Math.exp(-0.02 * effStrength);
      tg *= Math.exp(-1.95 * effStrength);
      tb *= Math.exp(-0.21 * effStrength);
      pinkBoost = Math.min(1, effStrength);
      extraOpacity += Math.min(0.5, effStrength * 0.36);
    }
  }

  // Base watery tint blended with Beer-Lambert transmission
  const rBase = 224 + 26 * pinkBoost;
  const gBase = 240 + 4 * pinkBoost;
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
