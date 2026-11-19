import { CONSTANTS, waterDensityGPerMl } from '../data/constants.js';
import { SPECIES } from '../data/species.js';

/**
 * Compute aqueous phase volume in Liters (H2O + water-miscible Ethanol + _aq solutes).
 * Blends infinite-dilution partial molar volume into realistic finite-concentration
 * apparent molar volume so concentrated solutions do not shrink unphysically.
 */
export function computeAqueousVolumeL(moles, tempK = CONSTANTS.T_STD_K) {
  if (!moles) return 0;
  const nH2O = Math.max(0, moles.H2O_l || 0);
  const nEtOH = Math.max(0, moles.C2H5OH_l || 0);
  const nH2SO4L = Math.max(0, moles.H2SO4_l || 0);
  const nHNO3L = Math.max(0, moles.HNO3_l || 0);
  if (nH2O <= 1e-12 && nEtOH <= 1e-12 && nH2SO4L <= 1e-12 && nHNO3L <= 1e-12) return 0;

  const T = Number.isFinite(tempK) ? Math.max(155, Math.min(800, tempK)) : CONSTANTS.T_STD_K;
  const rho = waterDensityGPerMl(T);
  const waterVolMl = (nH2O * SPECIES.H2O_l.molarMass) / rho;
  const etohVolMl = (nEtOH * SPECIES.C2H5OH_l.molarMass) / SPECIES.C2H5OH_l.density;
  const h2so4VolMl = nH2SO4L > 1e-12 ? (nH2SO4L * SPECIES.H2SO4_l.molarMass) / SPECIES.H2SO4_l.density : 0;
  const hno3VolMl = nHNO3L > 1e-12 ? (nHNO3L * SPECIES.HNO3_l.molarMass) / SPECIES.HNO3_l.density : 0;
  // Ethanol-water mixtures exhibit ~3.5% excess volume contraction
  const mixFactor = nH2O > 1e-9 && nEtOH > 1e-9 ? 0.965 : 1.0;
  const solventVolMl = (waterVolMl + etohVolMl) * mixFactor + h2so4VolMl + hno3VolMl;

  let diluteVolDeltaMl = 0;
  let totalSoluteMoles = 0;
  let totalSoluteMassG = 0;

  for (const [id, n] of Object.entries(moles)) {
    if (!Number.isFinite(n) || n <= 0) continue;
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
  return Math.max(0, totalMl / 1000);
}

/**
 * Total liquid volume across aqueous AND any stratified immiscible organic liquid phases (L).
 */
export function computeLiquidVolumeL(moles, tempK = CONSTANTS.T_STD_K) {
  if (!moles) return 0;
  let orgVolMl = 0;
  for (const [id, n] of Object.entries(moles)) {
    if (!Number.isFinite(n) || n <= 1e-12) continue;
    const sp = SPECIES[id];
    if (sp && sp.phase === 'l' && (sp.liquidGroup === 'organic_light' || sp.liquidGroup === 'organic_heavy') && sp.density > 0) {
      orgVolMl += (n * sp.molarMass) / sp.density;
    }
  }
  return computeAqueousVolumeL(moles, tempK) + orgVolMl / 1000;
}

/**
 * Compute Redlich-Kister excess enthalpy of mixing H_mix (J) for H2O(l) + C2H5OH(l) mixtures
 * (exothermic peak around x_EtOH ~ 0.25-0.30). Used as state function H(after) - H(before).
 */
export function computeEthanolWaterExcessEnthalpyJ(nWaterMol, nEtOHMol) {
  const nw = Math.max(0, nWaterMol || 0);
  const ne = Math.max(0, nEtOHMol || 0);
  const nTot = nw + ne;
  if (nw <= 1e-12 || ne <= 1e-12 || nTot <= 1e-12) return 0;
  const xE = ne / nTot;
  const xW = nw / nTot;
  return -3600 * nTot * xE * xW * (1.28 - 0.56 * xE);
}

/**
 * Effective osmolality-weighted solute moles for Raoult cryoscopy (freezing point depression).
 */
export function calcEffectiveSoluteMoles(moles) {
  let sum = 0;
  for (const [id, n] of Object.entries(moles || {})) {
    if (n <= 0) continue;
    const sp = SPECIES[id];
    if (!sp) continue;
    if (sp.phase === 'aq') {
      const weight = sp.cryoscopyFactor ?? (Math.abs(sp.charge || 0) >= 2 ? 0.7 : 1.0);
      sum += n * weight;
    } else if (id === 'C2H5OH_l') {
      sum += n * (sp.cryoscopyFactor ?? 1.0);
    }
  }
  return sum;
}

/**
 * Solution freezing point (K) via Raoult's Law cryoscopy:
 * T_freeze = 273.15 - Kf * sum(i_k * m_k), bounded at eutectic floor (~210 K).
 * Pure Ethanol without water freezes at 159.05 K (-114.1 C).
 */
export function solutionFreezingPointK(moles, useBulkWaterIfFrozen = false) {
  if ((moles?.HNO3_l || 0) > 1e-9 && (moles?.H2O_l || 0) <= 1e-6 && (moles?.H2O_s || 0) <= 1e-6 && (moles?.C2H5OH_l || 0) <= 1e-6) {
    return CONSTANTS.T_FREEZE_PURE_HNO3_K;
  }
  if ((moles?.H2SO4_l || 0) > 1e-9 && (moles?.H2O_s || 0) <= 1e-6 && (moles?.C2H5OH_l || 0) <= 1e-6) {
    const mA = (moles.H2SO4_l || 0) * CONSTANTS.M_H2SO4;
    const mW = (moles.H2O_l || 0) * CONSTANTS.M_H2O;
    const wA = mA / Math.max(1e-9, mA + mW);
    if (wA >= 0.90) {
      return 276.15 + (wA - 0.98) * 350; // ~3 °C for 98% -> 10.3 °C for 100% H2SO4
    }
  }
  const nWater = moles?.H2O_l || 0;
  const nIce = moles?.H2O_s || 0;
  if (nWater <= 1e-12 && nIce <= 1e-12) {
    return (moles?.C2H5OH_l || 0) > 1e-12 ? 159.05 : CONSTANTS.T_FREEZE_WATER_K;
  }
  const effectiveSoluteMol = calcEffectiveSoluteMoles(moles);
  const waterMol = useBulkWaterIfFrozen ? nWater + nIce : nWater;
  const waterMassKg = Math.max(waterMol * (CONSTANTS.M_H2O / 1000), 1e-5);
  const molality = effectiveSoluteMol / waterMassKg;
  return Math.max(
    CONSTANTS.EUTECTIC_FLOOR_K,
    CONSTANTS.T_FREEZE_WATER_K - CONSTANTS.CRYOSCOPY_KF_WATER * molality
  );
}

/**
 * Water auto-ionization constant Kw(T) using Van 't Hoff equation.
 */
export function computeKw(tempK = CONSTANTS.T_STD_K) {
  const T = Math.max(200, Math.min(450, tempK));
  const exponent =
    (-CONSTANTS.DELTA_H_WATER_IONIZATION_J / CONSTANTS.R_J_MOL_K) *
    (1 / T - 1 / CONSTANTS.T_STD_K);
  return CONSTANTS.KW_298 * Math.exp(exponent);
}

/**
 * Universal proton-balance pH solver supporting strong electrolytes, NH3/NH4+,
 * and extensible mono/polyprotic weak-acid buffer species declared via SPECIES[id].bufferFamily.
 * Returns null if vessel contains virtually no aqueous water/protic liquid.
 */
export function computePH(moles, liquidVolL, tempK = CONSTANTS.T_STD_K) {
  if (!moles || !Number.isFinite(liquidVolL) || liquidVolL <= 1e-6) return null;
  const aqVolL = computeAqueousVolumeL(moles, tempK);
  const effVolL = aqVolL > 1e-6 ? aqVolL : liquidVolL;

  const nH = (moles.H_aq || 0) + (moles.H2SO4_l || 0) * 1.5;
  const nOH = moles.OH_aq || 0;
  const nEthoxide = moles.C2H5O_aq || 0;
  const cNH3 = Math.max(0, moles.NH3_aq || 0) / effVolL;
  const cNH4 = Math.max(0, moles.NH4_aq || 0) / effVolL;

  // Discover any custom mono/diprotic acid-base conjugate families (e.g. CO3^2-/HCO3-/H2CO3 for beta_v3)
  let polyGroups = null;
  for (const [id, n] of Object.entries(moles)) {
    if (!Number.isFinite(n) || n <= 1e-12) continue;
    const sp = SPECIES[id];
    if (!sp || !sp.bufferFamily) continue;
    const fam = typeof sp.bufferFamily === 'string'
      ? { id: sp.bufferFamily, pKaList: sp.pKaList || sp.pkaValues, boundProtons: sp.boundProtons }
      : sp.bufferFamily;
    const pKaList = fam.pKaList || sp.pKaList || sp.pkaValues;
    if (!Array.isArray(pKaList) || pKaList.length === 0) continue;
    if (!polyGroups) polyGroups = new Map();
    const famId = fam.id || sp.bufferFamily;
    let entry = polyGroups.get(famId);
    if (!entry) {
      entry = {
        pKaList,
        totalConc: 0,
        boundProtonsConc: 0,
      };
      polyGroups.set(famId, entry);
    }
    const c = n / effVolL;
    entry.totalConc += c;
    const bp = fam.boundProtons ?? (sp.charge !== undefined ? Math.max(0, pKaList.length + sp.charge) : 0);
    entry.boundProtonsConc += c * bp;
  }

  const cNet = (nH - nOH - nEthoxide) / effVolL;
  const kw = computeKw(tempK);

  let hPlus;
  if (cNH3 <= 1e-12 && cNH4 <= 1e-12 && !polyGroups) {
    if (cNet >= 0) {
      hPlus = 0.5 * (cNet + Math.sqrt(cNet * cNet + 4 * kw));
    } else {
      const ohMinus = 0.5 * (-cNet + Math.sqrt(cNet * cNet + 4 * kw));
      hPlus = ohMinus > 0 ? kw / ohMinus : Math.sqrt(kw);
    }
  } else {
    // Monotonic bisection over log10([H+]) solving exact proton-balance identity
    const kbNH3 = 1.77e-5;
    const kaNH4 = kw / kbNH3;
    let lo = -16.0;
    let hi = 2.0;
    for (let i = 0; i < 46; i++) {
      const mid = 0.5 * (lo + hi);
      const h = Math.pow(10, mid);
      let f = h - kw / h - cNet;
      if (cNH3 > 1e-12 || cNH4 > 1e-12) {
        f += (cNH3 * h - cNH4 * kaNH4) / (h + kaNH4);
      }
      if (polyGroups) {
        for (const grp of polyGroups.values()) {
          if (grp.pKaList.length === 1) {
            const ka1 = Math.pow(10, -grp.pKaList[0]);
            const eqBound = grp.totalConc * (h / (h + ka1));
            f += eqBound - grp.boundProtonsConc;
          } else if (grp.pKaList.length === 2) {
            const k1 = Math.pow(10, -grp.pKaList[0]);
            const k2 = Math.pow(10, -grp.pKaList[1]);
            const denom = h * h + k1 * h + k1 * k2;
            const eqBound = denom > 0 ? grp.totalConc * ((2 * h * h + k1 * h) / denom) : 0;
            f += eqBound - grp.boundProtonsConc;
          }
        }
      }
      if (f > 0) hi = mid;
      else lo = mid;
    }
    hPlus = Math.pow(10, 0.5 * (lo + hi));
  }
  if (!Number.isFinite(hPlus) || hPlus <= 0) return 14;
  const ph = -Math.log10(hPlus);
  return Math.max(-1.2, Math.min(15.6, ph));
}

/**
 * Equilibrium carbinol (colorless In(OH)^3-) fraction for phenolphthalein at high [OH-] / [C2H5O-].
 */
export function computePhenolphthaleinBleachEq(cOH, cEthoxide = 0) {
  const oh = Math.max(0, (cOH || 0) + 2.2 * (cEthoxide || 0));
  if (oh <= 1e-6) return 0;
  const term = Math.pow(oh / 0.32, 1.45);
  return term / (1 + term);
}

/**
 * Phenolphthalein fraction in pink basic dianion form (In^2-, pH ~ 8.2..12).
 * Accepts optional carbinol bleachFrac (0..1) and irreversible C-C cleavage irrevFrac (0..1).
 */
export function computePhenolphthaleinAlpha(ph, cOH = null, bleachFrac = null, irrevFrac = 0) {
  if (ph === null || ph === undefined) return 0;
  const intact = Math.max(0, 1 - Math.max(0, Math.min(1, irrevFrac || 0)));
  if (intact <= 1e-4) return 0;
  const acidTerm = Math.pow(10, Math.max(-30, Math.min(30, CONSTANTS.PHENOLPHTHALEIN_PKA - ph)));
  const effectiveOH = cOH !== null && cOH !== undefined ? Math.max(0, cOH) : Math.pow(10, Math.min(2, ph - 14));
  const bleach =
    bleachFrac !== null && bleachFrac !== undefined
      ? Math.max(0, Math.min(1, bleachFrac))
      : computePhenolphthaleinBleachEq(effectiveOH);
  return (intact * Math.max(0, 1 - bleach)) / (1 + acidTerm);
}

/**
 * Strongly acidic orange-red oxonium cation (H3In+) fraction of phenolphthalein (pH < 0).
 */
export function computePhenolphthaleinOrangeAlpha(ph, irrevFrac = 0) {
  if (ph === null || ph === undefined) return 0;
  const intact = Math.max(0, 1 - Math.max(0, Math.min(1, irrevFrac || 0)));
  if (intact <= 1e-4) return 0;
  const expo = Math.max(-20, Math.min(20, ph + 0.25));
  return intact / (1 + Math.pow(10, expo));
}

/**
 * Beer-Lambert RGB optical color calculation across arbitrary phase chromophores
 * ('aq', 'org_light', 'org_heavy', or 'all') + colloidal suspension turbidity.
 * Returns { css, r, g, b, alpha, hasIndicatorPink, hasIndicatorOrange }
 */
export function computeSolutionVisuals(
  moles,
  liquidVolL,
  ph,
  opticalPathCm = 6.5,
  phenBleachFrac = null,
  phenIrrevFrac = 0,
  options = {}
) {
  const phaseFilter = options.phaseFilter || 'aq';
  if (!moles || !Number.isFinite(liquidVolL) || liquidVolL <= 1e-6) {
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

  // 1. Dynamic Beer-Lambert RGB absorption for chromophores matching the target liquid stratum
  for (const [spId, nMol] of Object.entries(moles)) {
    if (!Number.isFinite(nMol) || nMol <= 1e-9) continue;
    const sp = SPECIES[spId];
    if (!sp || !sp.extinctionRGB) continue;
    const inPhase =
      phaseFilter === 'all'
        ? sp.phase === 'aq' || sp.phase === 'org' || sp.phase === 'l'
        : phaseFilter === 'aq'
        ? sp.phase === 'aq'
        : sp.phase === 'org' && (sp.liquidGroup || 'organic_light') === phaseFilter;
    if (!inPhase) continue;
    const conc = Math.min(100, nMol / liquidVolL);
    const ext = sp.extinctionRGB;
    const coeff = sp.opticalCoeff ?? 0.22;
    const kPath = opticalPathCm * coeff;
    tr *= Math.exp(-ext.r * conc * kPath);
    tg *= Math.exp(-ext.g * conc * kPath);
    tb *= Math.exp(-ext.b * conc * kPath);
    const opScale = sp.opticalOpacityScale ?? 0.45;
    const opMax = sp.opticalOpacityMax ?? 0.45;
    const opBase = sp.opticalOpacityBase ?? 0;
    extraOpacity += Math.min(opMax, conc * opScale + opBase);
  }

  // 2. Phenolphthalein indicator 4-state optics + irreversible C-C cleavage guard (aqueous only):
  const nPhen = phaseFilter === 'aq' || phaseFilter === 'all' ? moles.Phenolphthalein_aq || 0 : 0;
  let alphaPink = 0;
  let alphaOrange = 0;
  if (nPhen > 1e-9 && ph !== null) {
    const cPhen = Math.min(10, nPhen / liquidVolL);
    const cOH = Math.min(40, ((moles.OH_aq || 0) + 2.2 * (moles.C2H5O_aq || 0)) / liquidVolL);
    alphaPink = computePhenolphthaleinAlpha(ph, cOH, phenBleachFrac, phenIrrevFrac);
    alphaOrange = computePhenolphthaleinOrangeAlpha(ph, phenIrrevFrac);

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

  // Base tint calibrated for aqueous vs organic solvent refractive clarity
  const isOrg = phaseFilter === 'organic_light' || phaseFilter === 'organic_heavy';
  const rBase = isOrg ? 242 : 224 + 26 * indicatorBoost;
  const gBase = isOrg ? 240 : 240 + 4 * indicatorBoost;
  const bBase = isOrg ? 225 : 252;
  let r = Math.round(Math.max(12, Math.min(255, rBase * tr)));
  let g = Math.round(Math.max(12, Math.min(255, gBase * tg)));
  let b = Math.round(Math.max(18, Math.min(255, bBase * tb)));
  let alpha = Math.min(0.88, (isOrg ? 0.30 : 0.34) + extraOpacity);

  // 3. Optional colloidal solid suspension scattering (e.g. brown-black MnO2(s), cloudy AgCl)
  const susp = Math.max(0, Math.min(1, options.suspensionLevel || 0));
  if (susp > 0.03 && phaseFilter === 'aq') {
    for (const [spId, nMol] of Object.entries(moles)) {
      const sp = SPECIES[spId];
      if (!sp || sp.phase !== 's' || !sp.suspensionRGB || nMol <= 1e-8) continue;
      const wBlend = Math.min(0.75, susp * Math.min(1, (nMol / liquidVolL) * 4.5));
      r = Math.round(r * (1 - wBlend) + sp.suspensionRGB.r * wBlend);
      g = Math.round(g * (1 - wBlend) + sp.suspensionRGB.g * wBlend);
      b = Math.round(b * (1 - wBlend) + sp.suspensionRGB.b * wBlend);
      alpha = Math.min(0.92, alpha + wBlend * 0.35);
    }
  }

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

/**
 * Compute natural undisturbed solid suspension factor (0 = settled on bottom, 1 = dispersed).
 * Coarse heavy metals/crystals sink immediately; fine colloidal precipitates follow vessel stir/settling state (~12-15s).
 */
export function computeSolidSuspensionFactor(vessel, spId, sp) {
  if (!sp || sp.phase !== 's') return 0;
  if (sp.isColloidal) {
    const settleFrac = vessel?.precipitateSettle?.[spId];
    const settleSusp = settleFrac !== undefined ? Math.max(0, 1 - settleFrac) : 0;
    return Math.max(vessel?.suspensionLevel || 0, settleSusp);
  }
  // Heavy metallic lumps / coarse salt crystals drop to bottom almost immediately
  return vessel?.stirTimer > 0 ? Math.min(0.12, (vessel?.suspensionLevel || 0) * 0.12) : 0;
}

/**
 * Physical Decantation vs Shake solid transfer ratio during vessel pouring.
 * Accounts for floating solids (Na), suspension/stirring state, Erlenmeyer shoulder trap (98%) vs Beaker (88%),
 * and bottom-sludge disturbance near empty (>75%).
 */
export function calcSolidTransferRatio({
  pourFraction,
  solidDensity,
  liquidDensity,
  vesselType,
  suspensionFactor,
  shakeBeforePour,
}) {
  if (pourFraction <= 0) return 0;
  if (pourFraction >= 0.995) return 1;

  // 1. Floating solids (rho_s < rho_l, e.g. Na metal at 0.968 g/cm3) skim across first
  if (solidDensity < liquidDensity) {
    return Math.min(1, pourFraction * 2.5);
  }

  // 2. Sinking solids: governed by suspension vs Erlenmeyer shoulder trap
  const effectiveSuspension = shakeBeforePour ? 1.0 : Math.max(0, Math.min(1, suspensionFactor));
  const suspendedTransfer = pourFraction * effectiveSuspension;

  const vesselTrap = vesselType === 'erlenmeyer' ? 0.98 : 0.88;
  const bottomDisturbance = Math.pow(pourFraction, 4);
  const settledTransfer = (1 - effectiveSuspension) * (1 - vesselTrap) * bottomDisturbance;

  return Math.min(1, suspendedTransfer + settledTransfer);
}

/**
 * Multi-phase liquid-liquid stratification analyzer.
 * Separates immiscible organic layers (light: rho < rho_aq, heavy: rho > rho_aq) from aqueous solution,
 * sorts bottom-to-top by density, and computes VesselGeometry interface boundaries & interfacial surface area A(h_int).
 */
export function computePhaseStratification(moles, tempK = CONSTANTS.T_STD_K, vesselSpec = null, solidVolMl = 0) {
  const layers = [];
  if (!moles) {
    return {
      isMultiPhase: false,
      layers,
      totalLiqMl: 0,
      totalLiqL: 0,
      interfaceMl: null,
      interfaceAreaCm2: 0,
      topAreaCm2: vesselSpec?.surfaceAreaCm2 || 20,
      topLayerKey: null,
      hasLightCover: false,
      hasHeavyBottom: false,
      aqueousMl: 0,
      aqueousDensity: 0.997,
      lightOrganicMl: 0,
      lightOrganicDensity: 0,
      heavyOrganicMl: 0,
      heavyOrganicDensity: 0,
    };
  }

  const T = Number.isFinite(tempK) ? Math.max(155, Math.min(800, tempK)) : CONSTANTS.T_STD_K;
  const aqVolL = computeAqueousVolumeL(moles, T);
  const aqVolMl = aqVolL * 1000;
  let aqMassG = 0;
  for (const [id, n] of Object.entries(moles)) {
    if (!Number.isFinite(n) || n <= 1e-12) continue;
    const sp = SPECIES[id];
    if (!sp) continue;
    if (sp.phase === 'aq' || (sp.phase === 'l' && (sp.liquidGroup || 'aqueous') === 'aqueous')) {
      aqMassG += n * sp.molarMass;
    }
  }
  const aqDensity = aqVolMl > 1e-6 ? aqMassG / aqVolMl : 0.997;

  let lightVolMl = 0;
  let lightMassG = 0;
  let heavyVolMl = 0;
  let heavyMassG = 0;

  for (const [id, n] of Object.entries(moles)) {
    if (!Number.isFinite(n) || n <= 1e-12) continue;
    const sp = SPECIES[id];
    if (!sp || sp.phase !== 'l') continue;
    const lg = sp.liquidGroup || 'aqueous';
    if (lg === 'organic_light' && sp.density > 0) {
      const mG = n * sp.molarMass;
      lightMassG += mG;
      lightVolMl += mG / sp.density;
    } else if (lg === 'organic_heavy' && sp.density > 0) {
      const mG = n * sp.molarMass;
      heavyMassG += mG;
      heavyVolMl += mG / sp.density;
    }
  }

  const lightDensity = lightVolMl > 1e-6 ? lightMassG / lightVolMl : 0.72;
  const heavyDensity = heavyVolMl > 1e-6 ? heavyMassG / heavyVolMl : 1.48;

  if (heavyVolMl > 0.05) {
    layers.push({ phaseKey: 'organic_heavy', volMl: heavyVolMl, massG: heavyMassG, density: heavyDensity });
  }
  if (aqVolMl > 0.05) {
    layers.push({ phaseKey: 'aqueous', volMl: aqVolMl, massG: aqMassG, density: aqDensity });
  }
  if (lightVolMl > 0.05) {
    layers.push({ phaseKey: 'organic_light', volMl: lightVolMl, massG: lightMassG, density: lightDensity });
  }

  // Strict thermodynamic gravity ordering: densest stratum at bottom -> lightest stratum on top
  layers.sort((a, b) => b.density - a.density);

  let accumMl = solidVolMl;
  for (const layer of layers) {
    layer.botMl = accumMl;
    accumMl += layer.volMl;
    layer.topMl = accumMl;
  }

  const totalLiqMl = aqVolMl + lightVolMl + heavyVolMl;
  const isMultiPhase = layers.length >= 2;
  const interfaceMl = isMultiPhase ? layers[0].topMl : null;
  const topLayer = layers.length > 0 ? layers[layers.length - 1] : null;
  const totalVolForGeo = solidVolMl + totalLiqMl;

  const getAreaAtMl = (volMl) => {
    if (vesselSpec?.geometry) {
      return Math.max(0.2, vesselSpec.geometry.getLiquidState(volMl).surfaceAreaCm2);
    }
    return vesselSpec?.surfaceAreaCm2 || 20.0;
  };

  return {
    isMultiPhase,
    layers,
    totalLiqMl,
    totalLiqL: totalLiqMl / 1000,
    interfaceMl,
    interfaceAreaCm2: interfaceMl !== null ? getAreaAtMl(interfaceMl) : 0,
    topAreaCm2: getAreaAtMl(totalVolForGeo),
    topLayerKey: topLayer ? topLayer.phaseKey : null,
    hasLightCover: lightVolMl > 0.15 && aqVolMl > 0.05,
    hasHeavyBottom: heavyVolMl > 0.15 && aqVolMl > 0.05,
    aqueousMl: aqVolMl,
    aqueousDensity: aqDensity,
    lightOrganicMl: lightVolMl,
    lightOrganicDensity: lightDensity,
    heavyOrganicMl: heavyVolMl,
    heavyOrganicDensity: heavyDensity,
  };
}
