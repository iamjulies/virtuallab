import { APPARATUS } from '../data/apparatus.js';
import { CONSTANTS, waterDensityGPerMl } from '../data/constants.js';
import { SPECIES } from '../data/species.js';

/**
 * Compute aqueous phase volume in Liters (H2O + water-miscible Ethanol + _aq solutes).
 * Blends infinite-dilution partial molar volume into realistic finite-concentration
 * apparent molar volume so concentrated solutions do not shrink unphysically.
 */
export function computeAqueousVolumeL(moles, tempK = CONSTANTS.T_STD_K) {
  if (!moles) return 0;
  const T = Number.isFinite(tempK) ? Math.max(155, Math.min(800, tempK)) : CONSTANTS.T_STD_K;
  const rho = waterDensityGPerMl(T);
  const nH2O = Math.max(0, moles.H2O_l || 0);
  const waterVolMl = nH2O > 1e-12 ? (nH2O * SPECIES.H2O_l.molarMass) / rho : 0;
  const waterKg = (nH2O * SPECIES.H2O_l.molarMass) / 1000;

  let alcoholVolMl = 0;
  let otherAqLiqVolMl = 0;
  let solventKg = waterKg;
  let hasAlcohol = false;

  let diluteVolDeltaMl = 0;
  let totalSoluteMoles = 0;
  let totalSoluteMassG = 0;

  for (const [id, n] of Object.entries(moles)) {
    if (!Number.isFinite(n) || n <= 1e-12) continue;
    if (id === 'H2O_l') continue;
    const sp = SPECIES[id];
    if (!sp) continue;
    if (sp.phase === 'l' && (sp.liquidGroup || 'aqueous') === 'aqueous' && sp.density > 0) {
      const volMl = (n * sp.molarMass) / sp.density;
      if (id === 'C2H5OH_l' || id === 'CH3OH_l') {
        alcoholVolMl += volMl;
        hasAlcohol = true;
      } else {
        otherAqLiqVolMl += volMl;
      }
      solventKg += (n * sp.molarMass) / 1000;
    } else if (sp.phase === 'aq') {
      totalSoluteMoles += n;
      totalSoluteMassG += n * sp.molarMass;
      if (typeof sp.partialMolarVolMl === 'number') {
        diluteVolDeltaMl += n * sp.partialMolarVolMl;
      }
    }
  }

  if (waterVolMl <= 0 && alcoholVolMl <= 0 && otherAqLiqVolMl <= 0) return 0;

  // Alcohol-water mixtures (EtOH/MeOH + H2O) exhibit ~3.5% excess volume contraction
  const mixFactor = nH2O > 1e-9 && hasAlcohol ? 0.965 : 1.0;
  const solventVolMl = (waterVolMl + alcoholVolMl) * mixFactor + otherAqLiqVolMl;

  // Smoothly blend toward positive effective solute volume (~m/2.25) at high molality
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
    if ((moles?.CH3COOH_l || 0) > 1e-12 && (moles?.C2H5OH_l || 0) <= 1e-9) return 289.75;
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
  const cCr2O7 = Math.max(0, moles.Cr2O7_2_aq || 0) / effVolL;
  const crWeakH = cCr2O7 > 1e-6 && nOH <= 1e-12 ? Math.sqrt(3e-7 * cCr2O7) * effVolL : 0;
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

  const cNet = (nH + crWeakH - nOH - nEthoxide) / effVolL;
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
        : phaseFilter === 'aq' || phaseFilter === 'aqueous'
        ? sp.phase === 'aq' || (sp.phase === 'l' && (sp.liquidGroup || 'aqueous') === 'aqueous')
        : (sp.phase === 'org' || sp.phase === 'l') && (sp.liquidGroup || 'organic_light') === phaseFilter;
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

  // 1b. Nonpolar organic solvent extraction / dissolution optics (e.g. I2 in C6H6 -> violet-pink, S in C6H6 -> pale yellow, Nitrobenzene -> pale yellow)
  if (phaseFilter === 'organic_light' || phaseFilter === 'all') {
    const nBz = (moles.C6H6_l || 0) + (moles.C6H12_l || 0) + (moles.C6H5CH3_l || 0);
    if (nBz > 1e-6) {
      const nI2 = moles.I2_s || 0;
      if (nI2 > 1e-8) {
        const cI2 = Math.min(2.0, nI2 / liquidVolL);
        const k = Math.min(2.2, cI2 * 8.5) * opticalPathCm * 0.25;
        tr *= Math.exp(-0.12 * k);
        tg *= Math.exp(-2.15 * k);
        tb *= Math.exp(-0.22 * k);
        extraOpacity += Math.min(0.42, k * 0.28);
      }
      const nS = moles.S_s || 0;
      if (nS > 1e-7) {
        const kS = Math.min(1.5, (nS / liquidVolL) * 4.0) * opticalPathCm * 0.2;
        tr *= Math.exp(-0.04 * kS);
        tg *= Math.exp(-0.10 * kS);
        tb *= Math.exp(-1.15 * kS);
        extraOpacity += Math.min(0.22, kS * 0.14);
      }
    }
  }
  if ((phaseFilter === 'organic_heavy' || phaseFilter === 'all') && (moles.C6H5NO2_l || 0) > 1e-6) {
    const cNB = Math.min(10, (moles.C6H5NO2_l || 0) / liquidVolL);
    const kNB = Math.min(1.6, cNB * 0.16) * opticalPathCm * 0.2;
    tr *= Math.exp(-0.02 * kNB);
    tg *= Math.exp(-0.08 * kNB);
    tb *= Math.exp(-1.25 * kNB);
    extraOpacity += Math.min(0.25, kNB * 0.18);
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

  // 3b. Soap micelle / emulsion opalescence (property-driven via sp.isSoapIon & sp.isFat)
  let nSoapMol = 0;
  let hasOilLeft = false;
  for (const [id, n] of Object.entries(moles)) {
    if (!n || n <= 1e-10) continue;
    const sp = SPECIES[id];
    if (!sp) continue;
    if (sp.isSoapIon) {
      const str = sp.emulsifyStrength ?? (sp.soapChainLength != null && sp.soapChainLength < 10 ? 0.08 : 1.0);
      nSoapMol += n * str;
    } else if (sp.isFat && n > 1e-6 && (sp.emulsifyPower ?? 1.0) > 0.05) {
      hasOilLeft = true;
    }
  }
  if (nSoapMol > 1e-5 && (phaseFilter === 'aq' || phaseFilter === 'aqueous' || phaseFilter === 'all')) {
    const cSoap = nSoapMol / Math.max(1e-4, liquidVolL);
    const wSoap = Math.min(hasOilLeft ? 0.68 : 0.42, cSoap / (cSoap + 0.16));
    if (wSoap > 0.02) {
      r = Math.round(r * (1 - wSoap) + 244 * wSoap);
      g = Math.round(g * (1 - wSoap) + 241 * wSoap);
      b = Math.round(b * (1 - wSoap) + 230 * wSoap);
      alpha = Math.min(0.90, alpha + wSoap * 0.44);
    }
  }

  // 3c. Overheated esterification yellow-amber charring & boiled-dry saponification scorching tint
  const estAmber = Math.max(0, Math.min(1, options.esterOverheatFrac || 0));
  if (estAmber > 0.04) {
    const wAmb = Math.min(0.84, estAmber * 0.85);
    const targetR = estAmber < 0.45 ? 245 : 146;
    const targetG = estAmber < 0.45 ? 196 : 64;
    const targetB = estAmber < 0.45 ? 66 : 14;
    r = Math.round(r * (1 - wAmb) + targetR * wAmb);
    g = Math.round(g * (1 - wAmb) + targetG * wAmb);
    b = Math.round(b * (1 - wAmb) + targetB * wAmb);
    alpha = Math.min(0.92, alpha + wAmb * 0.36);
  }
  const scorchFrac = Math.max(0, Math.min(1, options.soapScorchFrac || 0));
  if (scorchFrac > 0.04 && (phaseFilter === 'aq' || phaseFilter === 'aqueous' || phaseFilter === 'all')) {
    const wSc = Math.min(0.86, scorchFrac * 0.85);
    r = Math.round(r * (1 - wSc) + 120 * wSc);
    g = Math.round(g * (1 - wSc) + 53 * wSc);
    b = Math.round(b * (1 - wSc) + 15 * wSc);
    alpha = Math.min(0.95, alpha + wSc * 0.42);
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
 * and bottom-sludge disturbance near empty — without shaking, decanting liquid never dumps settled heavy solids cleanly.
 */
export function calcSolidTransferRatio({
  pourFraction,
  solidDensity,
  liquidDensity,
  vesselType,
  suspensionFactor,
  shakeBeforePour,
  hasLiquid = true,
}) {
  if (pourFraction <= 0) return 0;

  // 1. Floating solids (rho_s < rho_l, e.g. Na metal at 0.968 g/cm3) skim across first
  if (hasLiquid && solidDensity < liquidDensity) {
    return pourFraction >= 0.995 ? 1 : Math.min(1, pourFraction * 2.5);
  }

  // 2. Sinking solids: governed by suspension vs vessel shoulder trap & inertia
  const effectiveSuspension = shakeBeforePour ? 1.0 : Math.max(0, Math.min(1, suspensionFactor));
  if (pourFraction >= 0.995 && (!hasLiquid || effectiveSuspension >= 0.85 || vesselType === 'dish' || vesselType === 'crucible')) {
    return 1;
  }

  const clampedFrac = Math.min(1, pourFraction);
  const suspendedTransfer = clampedFrac * effectiveSuspension;

  const vesselTrap =
    vesselType === 'erlenmeyer' || vesselType === 'round_flask' || vesselType === 'distillation_flask'
      ? 0.98
      : vesselType === 'test_tube' || vesselType === 'bottle'
      ? 0.94
      : vesselType === 'dish' || vesselType === 'crucible'
      ? 0.45
      : 0.88;
  const bottomDisturbance = Math.pow(clampedFrac, 4);
  const settledTransfer = (1 - effectiveSuspension) * (1 - vesselTrap) * bottomDisturbance;

  return Math.min(1, suspendedTransfer + settledTransfer);
}

/**
 * Physical continuous tilt-pouring fractional rate (/s) for each solid species during interactive tilt pouring.
 * Combines:
 *  - Hydrodynamic entrainment in overflowing liquid (buoyant skim + dispersed/colloidal suspension fraction)
 *  - Vessel-specific neck constriction & shoulder trap (Erlenmeyer/round flask vs Test tube vs Beaker vs Dish vs Spoon)
 *  - Repose onset angle & smooth sin(excessTilt) granular discharge curve
 */
export function calcSolidPourDischargeRate({
  spec,
  kind = 'vessel',
  spId = '',
  sp,
  tiltDeg = 0,
  liquidFlowFrac = 0,
  liquidDensity = 1.0,
  hasLiquid = false,
  suspensionFactor = 0,
  isPowder = false,
  holdVolumeMl = null,
  totalContentsMl = null,
}) {
  if (!sp || sp.phase !== 's') return { ratioStep: 0, ratePerSec: 0, onsetDeg: 48 };
  const sDens = sp.density || 2.5;
  const vShape = spec?.shape || spec?.typeId || kind || 'beaker';

  // Hydrodynamic entrainment ONLY when liquid actually reaches & pours over the lip (liquidFlowFrac > 0)
  let entrainedStep = 0;
  if (liquidFlowFrac > 0 && hasLiquid) {
    if (sDens < liquidDensity) {
      const tiltBoost = 1.55 + 0.9 * Math.sin(Math.min(Math.PI / 2, ((tiltDeg || 25) * Math.PI) / 180));
      entrainedStep = Math.min(1, liquidFlowFrac * tiltBoost);
    } else if (suspensionFactor > 0.01) {
      entrainedStep = Math.min(1, liquidFlowFrac * Math.max(0, Math.min(1, suspensionFactor)));
    } else if (vShape !== 'erlenmeyer' && vShape !== 'round_flask' && (tiltDeg || 0) >= 68 && liquidFlowFrac > 0.14) {
      // Bottom scour only during rapid high-angle decanting
      entrainedStep = Math.min(0.16, liquidFlowFrac * 0.07 * Math.min(1, ((tiltDeg || 68) - 64) / 35));
    }
  }

  // Geometry profile for dry/steep solid discharge:
  // When geometric holdVolumeMl & totalContentsMl are supplied, settled solids below the tilted spout rim
  // cannot spill prematurely at 40-55 deg unless tilted past steep wall-slide angle (74-84 deg for tall vessels)!
  const belowRimByGeo = holdVolumeMl != null && totalContentsMl != null && totalContentsMl <= holdVolumeMl + 0.05;
  let onsetDeg = 46;
  let neckFactor = 1.0;
  if (kind === 'spoon') {
    onsetDeg = isPowder || sp.isPrecipitate ? 22 : 26;
    neckFactor = 2.6;
  } else if (kind === 'filter_funnel') {
    onsetDeg = 24;
    neckFactor = 1.75;
  } else if (vShape === 'erlenmeyer' || vShape === 'round_flask' || vShape === 'distillation_flask') {
    onsetDeg = belowRimByGeo ? (isPowder || sp.isPrecipitate ? 78 : 84) : (isPowder || sp.isPrecipitate ? 62 : 70);
    neckFactor = 0.36;
  } else if (vShape === 'test_tube' || vShape === 'bottle') {
    onsetDeg = belowRimByGeo ? (isPowder || sp.isPrecipitate ? 74 : 80) : (isPowder || sp.isPrecipitate ? 52 : 60);
    neckFactor = 0.52;
  } else if (vShape === 'dish' || vShape === 'crucible' || spec?.isPorcelain || spec?.isMortar || spec?.typeId === 'petri_dish') {
    onsetDeg = belowRimByGeo ? (isPowder || sp.isPrecipitate ? 38 : 44) : (isPowder || sp.isPrecipitate ? 30 : 36);
    neckFactor = 1.45;
  } else {
    // Standard cylindrical beaker / cylinder: bottom-settled solids stay put at 40-70 deg if below tilted rim height
    onsetDeg = belowRimByGeo ? (isPowder || sp.isPrecipitate ? 74 : 80) : (isPowder || sp.isPrecipitate ? 41 : 48);
    neckFactor = 1.0;
  }

  // Wet settled precipitate clings via capillary cohesion until steeped further or resuspended
  const isWetCling = hasLiquid && sp.isPrecipitate && suspensionFactor < 0.25 && kind === 'vessel';
  const effOnsetDeg = isWetCling ? onsetDeg + 6 : onsetDeg;
  const wetDrag = isWetCling ? 0.52 : 1.0;
  const morphFactor = isPowder ? 1.32 : sp.isPrecipitate ? 1.08 : sDens >= 5.0 ? 1.15 : 0.92;

  let gravityRateS = 0;
  if ((tiltDeg || 0) >= effOnsetDeg) {
    const excess = tiltDeg - effOnsetDeg;
    const span = Math.max(12, 122 - effOnsetDeg);
    const angleCurve = Math.sin(Math.min(Math.PI / 2, (excess / span) * (Math.PI / 2)));
    gravityRateS = 1.65 * neckFactor * morphFactor * wetDrag * (0.14 + 0.86 * angleCurve);
  }

  return {
    entrainedStep,
    ratePerSec: gravityRateS,
    onsetDeg: effOnsetDeg,
    neckFactor,
  };
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
  let aqVolMl = aqVolL * 1000;
  let aqMassG = 0;
  for (const [id, n] of Object.entries(moles)) {
    if (!Number.isFinite(n) || n <= 1e-12) continue;
    const sp = SPECIES[id];
    if (!sp) continue;
    if (sp.phase === 'aq' || (sp.phase === 'l' && (sp.liquidGroup || 'aqueous') === 'aqueous')) {
      aqMassG += n * sp.molarMass;
    }
  }

  let lightVolMl = 0;
  let lightMassG = 0;
  let heavyVolMl = 0;
  let heavyMassG = 0;
  let aqBonusVolMl = 0;
  let aqBonusMassG = 0;

  let nSoapStrat = 0;
  for (const [id, n] of Object.entries(moles)) {
    if (!Number.isFinite(n) || n <= 1e-12) continue;
    const sp = SPECIES[id];
    if (sp?.isSoapIon) {
      nSoapStrat += n * (sp.emulsifyStrength ?? (sp.soapChainLength != null && sp.soapChainLength < 10 ? 0.08 : 1.0));
    }
  }
  const cSoapStrat = aqVolL > 1e-5 ? nSoapStrat / aqVolL : 0;
  const lipidEmulsifyFrac = nSoapStrat > 1e-5 && aqVolMl > 0.5 ? Math.min(0.95, Math.max(0, (cSoapStrat - 0.04) / 0.25)) : 0;
  const aqIonicSalt = ((moles.Na_aq || 0) + (moles.Cl_aq || 0) + 2 * (moles.Ca2_aq || 0)) / Math.max(1e-4, aqVolL);
  const esterSaltedOut = aqIonicSalt >= 2.2;
  const cEtAq = (moles.C2H5OH_l || 0) / Math.max(1e-4, aqVolL);
  const estSolMol = aqVolMl > 0.5
    ? Math.max(0, (0.65 + 1.8 * Math.min(4, cEtAq)) * Math.exp(-0.42 * aqIonicSalt) * aqVolL)
    : 0;

  for (const [id, n] of Object.entries(moles)) {
    if (!Number.isFinite(n) || n <= 1e-12) continue;
    const sp = SPECIES[id];
    if (!sp || sp.phase !== 'l') continue;
    const lg = sp.liquidGroup || 'aqueous';
    if (lg === 'organic_light' && sp.density > 0) {
      const mG = n * sp.molarMass;
      const vMl = mG / sp.density;
      const emulPow = sp.isFat ? (sp.emulsifyPower ?? 1.0) : 0;
      if (emulPow > 0.05 && lipidEmulsifyFrac > 0.01) {
        const effFrac = Math.min(0.95, lipidEmulsifyFrac * emulPow);
        aqBonusMassG += mG * effFrac;
        aqBonusVolMl += vMl * effFrac;
        lightMassG += mG * (1 - effFrac);
        lightVolMl += vMl * (1 - effFrac);
      } else if (id === 'CH3COOC2H5_l' && !esterSaltedOut && estSolMol > 1e-6 && aqVolMl > 0.5) {
        const dissolvedFrac = Math.min(0.65, estSolMol / Math.max(1e-9, n));
        aqBonusMassG += mG * dissolvedFrac;
        aqBonusVolMl += vMl * dissolvedFrac;
        lightMassG += mG * (1 - dissolvedFrac);
        lightVolMl += vMl * (1 - dissolvedFrac);
      } else {
        lightMassG += mG;
        lightVolMl += vMl;
      }
    } else if (lg === 'organic_heavy' && sp.density > 0) {
      const mG = n * sp.molarMass;
      heavyMassG += mG;
      heavyVolMl += mG / sp.density;
    }
  }
  aqVolMl += aqBonusVolMl;
  aqMassG += aqBonusMassG;
  const aqDensity = aqVolMl > 1e-6 ? aqMassG / aqVolMl : 0.997;

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

export const MOLAR_IONIC_CONDUCTIVITY_MS_CM2_MMOL = {
  H_aq: 349.6,
  OH_aq: 198.0,
  Na_aq: 50.1,
  K_aq: 73.5,
  NH4_aq: 73.4,
  Ag_aq: 61.9,
  Cu2_aq: 107.2,
  Zn2_aq: 105.6,
  Fe2_aq: 108.0,
  Fe3_aq: 204.0,
  Mg2_aq: 106.1,
  Ca2_aq: 119.0,
  Ba2_aq: 127.3,
  Al3_aq: 183.0,
  Mn2_aq: 107.0,
  Cr3_aq: 201.0,
  Cl_aq: 76.3,
  Br_aq: 78.1,
  I_aq: 76.8,
  NO3_aq: 71.4,
  HSO4_aq: 50.0,
  SO4_2_aq: 160.0,
  HCO3_aq: 44.5,
  CO3_2_aq: 138.6,
  CH3COO_aq: 40.9,
  HCOO_aq: 54.6,
  MnO4_aq: 61.3,
  CrO4_2_aq: 170.0,
  Cr2O7_2_aq: 145.0,
  AlO2_aq: 50.0,
  ZnOH4_2_aq: 90.0,
  CuNH3_4_2_aq: 115.0,
  AgNH3_2_aq: 65.0,
};

/**
 * Compute per-species liquid & dissolved solute breakdown (mol, mass g, phase volume mL, CM, C%).
 */
export function computeLiquidSpeciesTableData(moles, tempK = CONSTANTS.T_STD_K, strat = null) {
  const s = strat || computePhaseStratification(moles, tempK);
  const T = Number.isFinite(tempK) ? Math.max(155, Math.min(800, tempK)) : CONSTANTS.T_STD_K;
  const aqVolL = Math.max(0, s.aqueousMl / 1000);
  const lightVolL = Math.max(0, s.lightOrganicMl / 1000);
  const heavyVolL = Math.max(0, s.heavyOrganicMl / 1000);

  let aqMassG = 0;
  let lightMassG = 0;
  let heavyMassG = 0;
  const rawEntries = [];

  for (const [spId, n] of Object.entries(moles || {})) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const sp = SPECIES[spId];
    if (!sp || (sp.phase !== 'l' && sp.phase !== 'aq')) continue;
    const massG = n * (sp.molarMass || 0);
    if (n < 5e-7 && massG < 5e-4) continue;
    const lg = sp.phase === 'aq' ? 'aqueous' : sp.liquidGroup || 'aqueous';
    if (lg === 'organic_light') lightMassG += massG;
    else if (lg === 'organic_heavy') heavyMassG += massG;
    else aqMassG += massG;
    rawEntries.push({ spId, sp, n, massG, lg });
  }

  const rows = rawEntries
    .sort((a, b) => b.n - a.n)
    .map(({ spId, sp, n, massG, lg }) => {
      const rho = spId === 'H2O_l' ? waterDensityGPerMl(T) : sp.density;
      const volMl = sp.phase === 'l' && rho > 0 ? massG / rho : null;
      const hostVolL = lg === 'organic_light' ? lightVolL : lg === 'organic_heavy' ? heavyVolL : aqVolL;
      const hostMassG = lg === 'organic_light' ? lightMassG : lg === 'organic_heavy' ? heavyMassG : aqMassG;
      const cM = hostVolL > 1e-7 ? n / hostVolL : 0;
      const cPct = hostMassG > 1e-7 ? (massG / hostMassG) * 100 : 0;
      return {
        spId,
        sp,
        mol: n,
        massG,
        volMl,
        cM,
        cPct,
        layerGroup: lg,
      };
    });

  const totalLiqMl = s.totalLiqMl;
  const totalLiqMassG = aqMassG + lightMassG + heavyMassG;
  const solidVolMl = computeSolidVolumeMl(moles);
  let solidMassG = 0;
  for (const [spId, n] of Object.entries(moles || {})) {
    if (n > 0 && SPECIES[spId]?.phase === 's') solidMassG += n * (SPECIES[spId].molarMass || 0);
  }
  const mixVolMl = totalLiqMl + solidVolMl;
  const mixDensity = mixVolMl > 1e-6 ? (totalLiqMassG + solidMassG) / mixVolMl : 0;
  const liqDensity = totalLiqMl > 1e-6 ? totalLiqMassG / totalLiqMl : 0;

  return {
    rows,
    totalLiqMl,
    totalLiqMassG,
    liqDensity,
    mixDensity,
    strat: s,
  };
}

/**
 * Compute ionic strength I (mol/L) and estimated Kohlrausch electrical conductivity sigma (mS/cm).
 */
export function computeVesselElectrochemicalMetrics(vessel, ph = null, liqL = null) {
  if (!vessel || vessel.isFrozenSolid) return { ionicStrengthM: 0, conductivityMSCm: 0 };
  const moles = vessel.moles || {};
  const vL = liqL ?? computeLiquidVolumeL(moles, vessel.tempK);
  const aqL = computeAqueousVolumeL(moles, vessel.tempK);
  const effL = aqL > 1e-6 ? aqL : vL;
  if (effL <= 1e-6) return { ionicStrengthM: 0, conductivityMSCm: 0 };

  const T = Number.isFinite(vessel.tempK) ? vessel.tempK : CONSTANTS.T_STD_K;
  const effPh = ph ?? computePH(moles, effL, T);
  const hFromPh = effPh !== null ? Math.pow(10, -effPh) : 0;
  const ohFromPh = effPh !== null ? computeKw(T) / Math.max(1e-16, hFromPh) : 0;

  let sumCZ2 = 0;
  let sumLambdaC = 0;
  let cHRecorded = 0;
  let cOHRecorded = 0;

  for (const [spId, n] of Object.entries(moles)) {
    if (!Number.isFinite(n) || n <= 1e-12) continue;
    const sp = SPECIES[spId];
    if (!sp || sp.phase !== 'aq') continue;
    const z = Math.abs(sp.charge || 0);
    if (z === 0) continue;
    const c = n / effL;
    if (spId === 'H_aq') cHRecorded = c;
    if (spId === 'OH_aq') cOHRecorded = c;
    sumCZ2 += c * z * z;
    const lambda0 = Number.isFinite(sp.molarConductivity)
      ? sp.molarConductivity
      : MOLAR_IONIC_CONDUCTIVITY_MS_CM2_MMOL[spId] ?? z * 60;
    sumLambdaC += lambda0 * c;
  }

  // Include weak-acid / water self-ionization H+ & OH- beyond explicit H_aq/OH_aq (e.g. CH3COOH dissociation -> H+ + CH3COO-)
  const extraH = Math.max(0, hFromPh - cHRecorded);
  const extraOH = Math.max(0, ohFromPh - cOHRecorded);
  if (extraH > 1e-11) {
    sumCZ2 += extraH;
    sumLambdaC += MOLAR_IONIC_CONDUCTIVITY_MS_CM2_MMOL.H_aq * extraH;
    if ((moles.CH3COOH_l || 0) > 1e-8 && (moles.H2O_l || 0) > 1e-7) {
      sumCZ2 += extraH;
      sumLambdaC += MOLAR_IONIC_CONDUCTIVITY_MS_CM2_MMOL.CH3COO_aq * extraH;
    }
  }
  if (extraOH > 1e-11) {
    sumCZ2 += extraOH;
    sumLambdaC += MOLAR_IONIC_CONDUCTIVITY_MS_CM2_MMOL.OH_aq * extraOH;
    if ((moles.NH3_aq || 0) > 1e-8) {
      sumCZ2 += extraOH;
      sumLambdaC += MOLAR_IONIC_CONDUCTIVITY_MS_CM2_MMOL.NH4_aq * extraOH;
    }
  }

  // Concentrated anhydrous liquids without water conduct much less due to incomplete ion solvation
  const waterFracFactor =
    (moles.H2O_l || 0) > 1e-5 ? Math.min(1.0, ((moles.H2O_l || 0) * 18) / Math.max(1e-5, (moles.H2O_l || 0) * 18 + (moles.CH3COOH_l || 0) * 60 + (moles.C2H5OH_l || 0) * 46)) : 0.04;

  const ionicStrengthM = 0.5 * sumCZ2;
  const tempScale = Math.max(0.4, 1 + 0.019 * (T - CONSTANTS.T_STD_K));
  const crowding = 1 / (1 + 0.30 * Math.sqrt(Math.max(0, ionicStrengthM)));
  const conductivityMSCm = Math.max(0, sumLambdaC * crowding * tempScale * Math.max(0.04, waterFracFactor));

  return { ionicStrengthM, conductivityMSCm };
}

/**
 * Resolve partial pressures of room atmosphere gases and relative humidity from environment state.
 */
export function computeAtmospherePartialPressures(env = {}) {
  const mode = env.atmosphereMode || 'air';
  const pTotalBar = mode === 'vacuum' ? Math.max(0, env.pressureBar ?? 0.02) : Math.max(0, env.pressureBar ?? CONSTANTS.P_STD_BAR);
  if (mode === 'vacuum' || pTotalBar <= 0.001) {
    return { pTotalBar, pN2Bar: 0, pO2Bar: 0, pCO2Bar: 0, pOtherBar: pTotalBar, rhPct: 0 };
  }
  if (mode === 'o2') {
    return { pTotalBar, pN2Bar: 0, pO2Bar: pTotalBar, pCO2Bar: 0, pOtherBar: 0, rhPct: 0 };
  }
  if (mode === 'co2') {
    return { pTotalBar, pN2Bar: 0, pO2Bar: 0, pCO2Bar: pTotalBar, pOtherBar: 0, rhPct: 0 };
  }
  if (mode === 'n2' || mode === 'nitrogen') {
    return { pTotalBar, pN2Bar: pTotalBar, pO2Bar: 0, pCO2Bar: 0, pOtherBar: 0, rhPct: 0 };
  }
  if (mode === 'h2' || mode === 'inert' || mode === 'ar') {
    return { pTotalBar, pN2Bar: 0, pO2Bar: 0, pCO2Bar: 0, pOtherBar: pTotalBar, rhPct: 0 };
  }
  // Standard atmospheric air
  const pN2Bar = pTotalBar * 0.7808;
  const pO2Bar = pTotalBar * 0.2095;
  const pCO2Bar = pTotalBar * 0.00042;
  const pOtherBar = Math.max(0, pTotalBar - pN2Bar - pO2Bar - pCO2Bar);
  const rhPct = (env.relativeHumidity ?? CONSTANTS.RELATIVE_HUMIDITY ?? 0.6) * 100;
  return { pTotalBar, pN2Bar, pO2Bar, pCO2Bar, pOtherBar, rhPct };
}

/**
 * Aggregate global telemetry across the entire active workbench (for Bench Telemetry panel).
 */
export function computeBenchTelemetry(sim) {
  const items = sim?.items || [];
  let totalTareMassG = 0;
  let totalChemMassG = 0;
  let totalEscapedGasMassG = 0;
  let activeReactionCount = 0;
  let heatingVesselCount = 0;
  let boilingVesselCount = 0;
  let overpressureVesselCount = 0;
  let vesselCount = 0;
  let toolCount = 0;
  const pEnv = Math.max(0.05, sim?.environment?.pressureBar || CONSTANTS.P_STD_BAR);

  for (const it of items) {
    const spec = APPARATUS[it.typeId];
    totalTareMassG += spec?.tareMassG || 0;
    if (it.kind === 'vessel') {
      vesselCount++;
      totalChemMassG += computeContentsMassG(it.moles || {});
      if (it.tubeMoles) totalChemMassG += computeContentsMassG(it.tubeMoles);
      if (it.isStoppered && it.headspaceGasMoles) {
        totalChemMassG += computeContentsMassG(it.headspaceGasMoles);
      }
      if (it.escapedGasMoles) {
        totalEscapedGasMassG += computeContentsMassG(it.escapedGasMoles);
      }
      activeReactionCount += (it.activeReactions || []).length;
      if (it.wasBoiling) boilingVesselCount++;
      const burnerSrc = typeof sim.getBurnerHeatingSource === 'function' ? sim.getBurnerHeatingSource(it) : null;
      if ((burnerSrc?.powerW || 0) > 0) heatingVesselCount++;
      if ((it.internalPressureBar ?? pEnv) - pEnv >= 0.15) overpressureVesselCount++;
    } else {
      toolCount++;
      if (it.moles) totalChemMassG += computeContentsMassG(it.moles);
      if (it.kind === 'gas_syringe') {
        if (it.gasMoles) totalChemMassG += computeContentsMassG(it.gasMoles);
        if (it.overflowMoles) totalChemMassG += computeContentsMassG(it.overflowMoles);
        totalChemMassG += (it.condensedWaterMol || 0) * CONSTANTS.M_H2O;
        totalChemMassG += (it.frozenWaterMol || 0) * CONSTANTS.M_H2O;
        totalChemMassG += (it.condensedEtOHMol || 0) * (SPECIES.C2H5OH_l?.molarMass || 46.068);
      } else if (it.kind === 'wash_bottle') {
        totalChemMassG += Math.max(0, it.waterMl || 0) * 0.997;
      }
    }
  }

  return {
    totalBenchMassG: totalTareMassG + totalChemMassG,
    totalTareMassG,
    totalChemMassG,
    totalEscapedGasMassG,
    activeReactionCount,
    heatingVesselCount,
    boilingVesselCount,
    overpressureVesselCount,
    vesselCount,
    toolCount,
  };
}

/**
 * Analytical Fischer Esterification Equilibrium Solver (Kc ~ 4.0 for AcOH + EtOH ⇄ EtOAc + H2O):
 *   x = [Kc(a+b) - sqrt(Kc^2(a-b)^2 + 4*Kc*a*b)] / (2*(Kc - 1)) when cEst=0, cW=0;
 *   or generalized root for arbitrary initial product concentrations cEst, cW.
 */
export function calcEsterificationEquilibrium({ a = 0, b = 0, cEst = 0, cW = 0, Kc = 4.0 }) {
  const safeA = Math.max(0, Number(a) || 0);
  const safeB = Math.max(0, Number(b) || 0);
  const safeC = Math.max(0, Number(cEst) || 0);
  const safeW = Math.max(0, Number(cW) || 0);
  const safeK = Math.max(1e-4, Number(Kc) || 4.0);
  const minAB = Math.min(safeA, safeB);
  if (minAB <= 1e-12 && (safeC <= 1e-12 || safeW <= 1e-12)) {
    return { xEq: 0, x1: 0, x2: 0, yieldPct: 0 };
  }

  // Quadratic: (Kc - 1) x^2 - [Kc(a + b) + cEst + cW] x + (Kc*a*b - cEst*cW) = 0
  const A = safeK - 1;
  const B = -(safeK * (safeA + safeB) + safeC + safeW);
  const C = safeK * safeA * safeB - safeC * safeW;

  if (Math.abs(A) < 1e-9) {
    const xEq = Math.abs(B) > 1e-12 ? -C / B : 0;
    const clamped = Math.max(-Math.min(safeC, safeW), Math.min(minAB, xEq));
    return {
      xEq: clamped,
      x1: clamped,
      x2: Infinity,
      yieldPct: minAB > 1e-12 ? Math.max(0, (clamped / minAB) * 100) : 0,
    };
  }

  const disc = Math.max(0, B * B - 4 * A * C);
  const sqrtD = Math.sqrt(disc);
  const r1 = (-B - sqrtD) / (2 * A);
  const r2 = (-B + sqrtD) / (2 * A);
  const x1 = A > 0 ? r1 : r2;
  const x2 = A > 0 ? r2 : r1;
  const clamped = Math.max(-Math.min(safeC, safeW), Math.min(minAB, x1));
  return {
    xEq: clamped,
    x1,
    x2,
    yieldPct: minAB > 1e-12 ? Math.max(0, ((safeC + clamped) / (minAB + safeC)) * 100) : 0,
  };
}

/**
 * Extended Arrhenius forward rate constant k1 (L / (mol * s)):
 *   k1 = (k_uncat + k_cat * [H+]) * exp(-Ea / (R * T))
 */
export function calcEsterificationRateConstantK1({
  tempK = CONSTANTS.T_STD_K,
  cHPlus = 0,
  kUncat = 5.76,
  kCat = 11500.0,
  eaJ = 50000.0,
}) {
  const T = Math.max(200, Math.min(800, Number(tempK) || CONSTANTS.T_STD_K));
  const H = Math.max(0, Number(cHPlus) || 0);
  return (kUncat + kCat * H) * Math.exp(-eaJ / (CONSTANTS.R_J_MOL_K * T));
}

/**
 * Closed-form integrated second-order reversible esterification concentration x(t) (mol/L):
 *   ln[(x - x1)/(x - x2) * (x2 / x1)] = k1 * (1 - 1/Kc) * (x1 - x2) * t
 */
export function calcEsterificationConcAtTime({ a = 0, b = 0, tSec = 0, k1 = 0, Kc = 4.0 }) {
  const safeA = Math.max(0, Number(a) || 0);
  const safeB = Math.max(0, Number(b) || 0);
  const t = Math.max(0, Number(tSec) || 0);
  const k = Math.max(0, Number(k1) || 0);
  const safeK = Math.max(1e-4, Number(Kc) || 4.0);
  if (safeA <= 1e-12 || safeB <= 1e-12 || t <= 0 || k <= 0) return 0;

  const { x1, x2 } = calcEsterificationEquilibrium({ a: safeA, b: safeB, Kc: safeK });
  if (Math.abs(safeK - 1) < 1e-7) {
    const expTerm = Math.exp(-k * (safeA + safeB) * t);
    return (safeA * safeB * (1 - expTerm)) / Math.max(1e-12, safeA + safeB);
  }
  const E = k * (1 - 1 / safeK) * (x1 - x2) * t;
  const eE = Math.exp(Math.max(-60, Math.min(0, E)));
  const denom = x2 - x1 * eE;
  return Math.abs(denom) > 1e-12 ? Math.max(0, Math.min(Math.min(safeA, safeB), (x1 * x2 * (1 - eE)) / denom)) : x1;
}

/**
 * Compute live Fischer Esterification diagnostics (Kc, theoretical equilibrium yield %, actual conversion %) for a vessel.
 */
export function estimateVesselEsterificationMetrics(vessel, liqL = 0) {
  if (!vessel || liqL <= 1e-6) return null;
  const m = vessel.moles || {};
  const nAc = m.CH3COOH_l || 0;
  const nEt = m.C2H5OH_l || 0;
  const nEst = m.CH3COOC2H5_l || 0;
  const nW = m.H2O_l || 0;
  if (nAc + nEst <= 1e-8 || (nEt + nEst <= 1e-8 && nEst <= 1e-8)) return null;
  if (nAc <= 1e-8 && nEst <= 1e-8) return null;

  const T = Number.isFinite(vessel.tempK) ? vessel.tempK : CONSTANTS.T_STD_K;
  const Kc = 4.0 * Math.exp((-3800 / CONSTANTS.R_J_MOL_K) * (1 / Math.max(250, T) - 1 / 348.15));
  const aTot = (nAc + nEst) / liqL;
  const bTot = (nEt + nEst) / liqL;
  const cW0 = Math.max(0, (nW - nEst) / liqL);
  const { xEq } = calcEsterificationEquilibrium({ a: aTot, b: bTot, cEst: 0, cW: cW0, Kc });
  const minAB = Math.min(aTot, bTot);
  const yieldEqPct = minAB > 1e-9 ? Math.min(100, Math.max(0, (xEq / minAB) * 100)) : 0;
  const yieldActualPct = minAB > 1e-9 ? Math.min(100, Math.max(0, ((nEst / liqL) / minAB) * 100)) : 0;
  const cHPlus = ((m.H_aq || 0) + (m.H2SO4_l || 0) * 1.5) / liqL;
  const k1Phys = calcEsterificationRateConstantK1({ tempK: T, cHPlus });
  return { Kc, yieldEqPct, yieldActualPct, k1Phys, minABMol: minAB * liqL };
}

/**
 * Qualitative vapor/solution aroma telemetry (Prompt 71 / Property-driven Prompt 80) for Inspector panel.
 */
export function computeVesselAroma(vessel) {
  if (!vessel || vessel.isShattered) return null;
  const m = vessel.moles || {};
  const h = vessel.headspaceGasMoles || {};
  const nSO2 = (h.SO2_g || 0) + (vessel.escapedGasMoles?.SO2_g || 0);
  if ((vessel.esterOverheatFrac || 0) > 0.25 || nSO2 > 2e-4) {
    return { kind: 'burnt_so2', key: 'aromaBurntSO2', tone: 'text-red-400 border-red-500/40 bg-red-500/10' };
  }
  if (vessel.soapScorched || (vessel.soapScorchFrac || 0) > 0.2) {
    return { kind: 'scorched', key: 'aromaScorched', tone: 'text-amber-400 border-amber-500/40 bg-amber-500/10' };
  }

  let nFruityEster = 0;
  let nPungentAcid = 0;
  let nAlcohol = 0;
  let nSoapTot = 0;
  let customAroma = null;

  for (const [id, n] of Object.entries(m)) {
    if (!Number.isFinite(n) || n <= 1e-10) continue;
    const sp = SPECIES[id];
    if (!sp) continue;
    if (sp.isSoapIon || sp.isSoapSolid) nSoapTot += n;

    const ap = sp.aromaProfile;
    if (ap) {
      if (ap.category === 'ester_fruity') nFruityEster += n;
      else if (ap.category === 'vinegar') nPungentAcid += n;
      else if (ap.category === 'alcohol') nAlcohol += n;
      else if (n >= (ap.minMol ?? 0.003) && !customAroma) {
        customAroma = {
          kind: ap.category || ap.key,
          key: ap.key,
          tone: ap.tone || 'text-main border-theme bg-surface-alt',
        };
      }
      continue;
    }

    // Legacy fallback categories for species without explicit aromaProfile
    if (sp.functionalGroups?.isEster && !sp.isFat && !sp.isPolymer && (sp.atoms?.C || 10) <= 8) nFruityEster += n;
    else if (sp.functionalGroups?.isCarboxylicAcid && (sp.atoms?.C || 10) <= 4) nPungentAcid += n;
    else if (sp.functionalGroups?.isPrimaryAlcohol && (sp.atoms?.C || 10) <= 5) nAlcohol += n;
  }

  if (nFruityEster >= 0.003 && (nFruityEster >= nPungentAcid * 0.12 || (m.H2SO4_l || 0) > 1e-4)) {
    return { kind: 'ester_fruity', key: 'aromaEsterFruity', tone: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' };
  }
  if (vessel._hadVolatileEsterForAroma && nFruityEster < 0.001 && (m.OH_aq || 0) + (m.CH3COO_aq || 0) + (m.HCOO_aq || 0) > 0.005) {
    return { kind: 'ester_cleared', key: 'aromaEsterCleared', tone: 'text-sky-400 border-sky-500/40 bg-sky-500/10' };
  }
  if (customAroma) return customAroma;
  if ((m.C2H5OC2H5_l || 0) >= 0.003) {
    return { kind: 'ether', key: 'aromaEther', tone: 'text-purple-300 border-purple-500/40 bg-purple-500/10' };
  }
  if (nPungentAcid >= 0.005) {
    return { kind: 'vinegar', key: 'aromaVinegar', tone: 'text-amber-300 border-amber-500/40 bg-amber-500/10' };
  }
  if (vessel.saponificationComplete || nSoapTot >= 0.005) {
    return { kind: 'soapy_clean', key: 'aromaSoapyClean', tone: 'text-sky-300 border-sky-400/40 bg-sky-400/10' };
  }
  if (nAlcohol >= 0.01) {
    return { kind: 'alcohol', key: 'aromaAlcohol', tone: 'text-main border-theme bg-surface-alt' };
  }
  return null;
}
