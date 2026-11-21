/**
 * Physical & chemical constants (SI / IUPAC standard units).
 */
export const CONSTANTS = {
  // Ideal gas constant
  R_J_MOL_K: 8.314462618,
  R_L_BAR_MOL_K: 0.08314462618,

  // IUPAC Standard Ambient Temperature & Pressure (SATP) & Lab Air Humidity
  T_STD_K: 298.15,
  P_STD_BAR: 1.0,
  KELVIN_OFFSET: 273.15,
  RELATIVE_HUMIDITY: 0.60, // 60% RH in ambient lab room air

  // Standard Dry Air Composition (STP/SATP mole fractions & mean molar mass)
  AIR_O2_FRAC: 0.2095,
  AIR_N2_FRAC: 0.7808,
  AIR_CO2_FRAC: 0.0004,
  AIR_AR_FRAC: 0.0093,
  AIR_MEAN_MOLAR_MASS: 28.97,
  MAX_LABS: 10,

  // Water properties & auto-ionization
  KW_298: 1.0e-14,
  DELTA_H_WATER_IONIZATION_J: 55800, // J/mol
  DELTA_H_VAP_WATER_J: 40660,        // J/mol at ~373K
  DELTA_H_FUS_WATER_J: 6010,         // J/mol latent heat of fusion of water (333.5 J/g)
  DELTA_H_SUB_ICE_J: 51060,          // J/mol sublimation enthalpy of ice near 273.15 K
  T_FREEZE_WATER_K: 273.15,          // Normal freezing point of pure water (0 C)
  CRYOSCOPY_KF_WATER: 1.86,          // Cryoscopic constant Kf of water (K*kg/mol)
  EUTECTIC_FLOOR_K: 210.0,           // Eutectic freezing depression limit for aqueous solutions
  ICE_DENSITY_G_ML: 0.917,           // Ice density at 0 C (~9% volume expansion)
  CP_ICE_J_MOL_K: 38.0,              // Molar heat capacity of solid ice H2O(s)
  DELTA_H_VAP_HCL_AQ_J: 74800,       // J/mol enthalpy of HCl(aq) -> HCl(g) outgassing
  HCL_AZEOTROPE_WT_FRAC: 0.2024,     // 20.24% w/w HCl-H2O azeotrope (~108.6 C at 1 bar)
  M_H2O: 18.01528,                   // g/mol
  M_HCL: 36.46094,                   // g/mol
  M_HNO3: 63.01284,                  // g/mol
  DELTA_H_VAP_HNO3_J: 39100,         // J/mol pure anhydrous HNO3 (83 °C)
  DELTA_H_VAP_HNO3_AQ_J: 66200,      // J/mol HNO3(aq) -> HNO3(g) + hydration release
  HNO3_AZEOTROPE_WT_FRAC: 0.68,      // Maximum-boiling HNO3/H2O azeotrope at 68% w/w (121.2 °C)
  T_FREEZE_PURE_HNO3_K: 231.15,      // -42 °C freezing point of anhydrous HNO3
  T_BOIL_PURE_HNO3_K: 356.15,        // +83 °C normal boiling point of anhydrous HNO3
  M_H2SO4: 98.0785,                  // g/mol Sulfuric acid
  M_SO2: 64.0638,                    // g/mol Sulfur dioxide
  M_H2S: 34.0809,                    // g/mol Hydrogen sulfide
  H2SO4_AZEOTROPE_WT_FRAC: 0.983,    // 98.3% w/w constant-boiling azeotrope (~337 °C at 1 bar)
  H2SO4_CONC_WT_FRAC: 0.98,          // Commercial 98% w/w reagent
  H2SO4_CONC_DENSITY_G_ML: 1.836,    // g/mL at 298.15 K
  T_FREEZE_PURE_H2SO4_K: 283.46,     // +10.31 °C pure H2SO4 (~3 °C for 98%)
  T_BOIL_H2SO4_98_K: 610.15,         // +337 °C 98.3% H2SO4 azeotrope normal boiling point
  DELTA_H_HYDRATION_H2SO4_J: 74500,  // J/mol standard hydration exotherm of H2SO4(l) in water
  CP_H2O_J_MOL_K: 75.38,             // J/(mol·K)

  // Antoine coefficients for water vapor pressure (log10(P_mmHg) = A - B / (C + T_C))
  ANTOINE_WATER: {
    A: 8.07131,
    B: 1730.63,
    C: 233.426,
    MMHG_PER_BAR: 750.061683,
  },

  // Physical electrochemical constant
  FARADAY_C_MOL: 96485.33212,        // C/mol (F)

  // Phenolphthalein pKa (colorless -> pink transition centered around 9.3)
  PHENOLPHTHALEIN_PKA: 9.3,

  // Concentrated HCl 37% w/w commercial bottle specs at 298.15 K
  HCL_CONC_WT_FRAC: 0.37,
  HCL_CONC_DENSITY_G_ML: 1.189,

  // Phenolphthalein 1% w/v indicator solution specs
  PHEN_SOL_DENSITY_G_ML: 0.85,
  PHEN_SOL_MOL_PER_ML: 0.0000267, // ~0.85 g / 100 mL -> ~0.0267 M

  // Physical workbench geometry & tubing bore constants
  PX_PER_MM: 1.15,                   // 1.15 px/mm across all ISO apparatus
  TUBING_INNER_DIAMETER_MM: 6.0,     // Fixed 6.0 mm inner bore silicone/rubber delivery tubing
  GRAVITY_PX_S2: 1800.0,             // Workbench gravitational acceleration (px/s^2)

  // Physical combustion, glassware softening & equilibrium thresholds
  R_ATM_L_MOL_K: 0.082057366,        // Ideal gas constant (L·atm/(mol·K))
  BOROSILICATE_SOFTEN_K: 1093.15,    // ~820 °C borosilicate 3.3 softening threshold
  BOROSILICATE_MELT_FAIL_K: 1153.15, // ~880 °C molten sag breach on sustained Bunsen flame
  CACO3_DECOMP_DELTA_H_J: 178300,    // +178.3 kJ/mol standard enthalpy of calcination

  // Numerical integration limits
  SUBSTEP_MAX_DT: 0.01, // 10 ms max physics/chem substep
};

/**
 * Equilibrium CO2 decomposition pressure P_eq(T) (atm) for CaCO3(s) <-> CaO(s) + CO2(g):
 *   ln P_eq(T) ≈ 16.5 - 20474 / T(K)
 */
export function calcCaCO3EqPressureAtm(T_K) {
  const T = Math.max(200, Math.min(2400, T_K));
  return Math.exp(16.5 - 20474.0 / T);
}

export function kelvinToCelsius(k) {
  return k - CONSTANTS.KELVIN_OFFSET;
}

export function celsiusToKelvin(c) {
  return c + CONSTANTS.KELVIN_OFFSET;
}

/**
 * Water vapor saturation pressure in mmHg using the Antoine equation (>= 0 C)
 * and Clausius-Clapeyron ice sublimation curve below 0 C (< 273.15 K).
 */
export function waterVaporPressureMmHg(T_K) {
  const { A, B, C } = CONSTANTS.ANTOINE_WATER;
  const T_C = T_K - CONSTANTS.KELVIN_OFFSET;
  if (T_C < 0) {
    const T = Math.max(180, T_K);
    const pTriple = Math.pow(10, A - B / C);
    return pTriple * Math.exp((CONSTANTS.DELTA_H_SUB_ICE_J / CONSTANTS.R_J_MOL_K) * (1 / CONSTANTS.KELVIN_OFFSET - 1 / T));
  }
  return Math.pow(10, A - B / (C + Math.min(200, T_C)));
}

/**
 * Water vapor saturation pressure in bar using the Antoine equation.
 */
export function waterVaporPressureBar(T_K) {
  return waterVaporPressureMmHg(T_K) / CONSTANTS.ANTOINE_WATER.MMHG_PER_BAR;
}

/**
 * Non-volatile dissolved solute moles (ions & indicator; excludes volatile co-solvents & NH3 gas solute).
 */
export function nonVolatileSoluteMoles(moles) {
  let sum = 0;
  for (const [id, n] of Object.entries(moles)) {
    if (n > 0 && id.endsWith('_aq') && id !== 'NH3_aq' && id !== 'C2H5OH_aq') {
      sum += n;
    }
  }
  return sum;
}

/**
 * Solvent water mole fraction x_H2O for Raoult's Law vapor pressure lowering.
 */
export function waterMoleFraction(moles) {
  const nH2O = moles.H2O_l || 0;
  if (nH2O <= 1e-12) return 0;
  const soluteMol = nonVolatileSoluteMoles(moles);
  return nH2O / (nH2O + Math.max(0, soluteMol));
}

/**
 * Pure Ethanol saturation vapor pressure (bar) via Clausius-Clapeyron around T_b = 351.44 K.
 */
export function ethanolVaporPressureBar(T_K) {
  const T = Math.max(200, Math.min(450, T_K));
  const dHVapEtOH = 38560;
  const tbEtOH = 351.44;
  return 1.01325 * Math.exp((dHVapEtOH / CONSTANTS.R_J_MOL_K) * (1 / tbEtOH - 1 / T));
}

/**
 * Ethanol–Water non-ideal Vapor-Liquid Equilibrium (3-suffix Margules, A12=1.55, A21=0.88),
 * reproducing the real 95.6% w/w minimum-boiling azeotrope at 78.15 C (1 bar).
 * Returns { xE0, xW0, gammaE, gammaW, fIon, pEBar, pWBar, pTotBar, yE, yW }.
 */
export function computeEthanolWaterVLE(moles, tempK, clampIon = false) {
  const nW = Math.max(0, moles.H2O_l || 0);
  const nE = Math.max(0, moles.C2H5OH_l || 0);
  const nSolv = nW + nE;
  if (nSolv <= 1e-12) {
    return { xE0: 0, xW0: 0, gammaE: 1, gammaW: 1, fIon: 1, pEBar: 0, pWBar: 0, pTotBar: 0, yE: 0, yW: 1 };
  }
  const nIon = Math.max(0, nonVolatileSoluteMoles(moles));
  const fIonRaw = nSolv / (nSolv + nIon);
  const fIon = clampIon ? Math.max(0.55, fIonRaw) : fIonRaw;

  const xE0 = nE / nSolv;
  const xW0 = nW / nSolv;

  // 3-suffix Margules binary interaction constants for Ethanol (1) + Water (2)
  const A_EW = 1.55;
  const A_WE = 0.88;
  const gammaE = nE > 1e-12 && nW > 1e-12
    ? Math.exp(xW0 * xW0 * (A_EW + 2 * (A_WE - A_EW) * xE0))
    : 1.0;
  const gammaW = nE > 1e-12 && nW > 1e-12
    ? Math.exp(xE0 * xE0 * (A_WE + 2 * (A_EW - A_WE) * xW0))
    : 1.0;

  const pSatE = nE > 1e-12 ? ethanolVaporPressureBar(tempK) : 0;
  const pSatW = nW > 1e-12 ? waterVaporPressureBar(tempK) : 0;

  const pEBar = xE0 * gammaE * fIon * pSatE;
  const pWBar = xW0 * gammaW * fIon * pSatW;
  const pTotBar = pEBar + pWBar;
  const yE = pTotBar > 1e-12 ? pEBar / pTotBar : xE0;
  const yW = 1 - yE;

  return { xE0, xW0, gammaE, gammaW, fIon, pEBar, pWBar, pTotBar, yE, yW };
}

/**
 * Water boiling temperature (K) at given ambient pressure P_bar.
 */
export function waterBoilingPointK(P_bar) {
  const { A, B, C, MMHG_PER_BAR } = CONSTANTS.ANTOINE_WATER;
  const pMmHg = Math.max(10, P_bar * MMHG_PER_BAR);
  const T_C = B / (A - Math.log10(pMmHg)) - C;
  return T_C + CONSTANTS.KELVIN_OFFSET;
}

/**
 * Solution boiling temperature (K), using:
 * - Exact HCl-H2O azeotropic boiling curve (20.24% w/w azeotrope at 108.6 C, 37% fuming ~48 C)
 * - Real non-ideal Ethanol-Water azeotrope VLE (78.15 C azeotrope / 78.3 C pure EtOH -> 99.6 C pure H2O)
 * - Raoult's Law BPE for non-volatile dissolved salts/bases
 */
export function solutionBoilingPointK(moles, P_bar) {
  const baseK = waterBoilingPointK(P_bar);
  const pSafe = Math.max(0.05, Math.min(20, P_bar || CONSTANTS.P_STD_BAR));
  const pureHno3BpK =
    1 /
    (1 / CONSTANTS.T_BOIL_PURE_HNO3_K -
      (CONSTANTS.R_J_MOL_K / CONSTANTS.DELTA_H_VAP_HNO3_J) * Math.log(pSafe / CONSTANTS.P_STD_BAR));
  const nPureHNO3 = moles.HNO3_l || 0;
  const nPureH2SO4 = moles.H2SO4_l || 0;
  if (nPureHNO3 > 1e-10 && nPureH2SO4 <= 1e-10 && (moles.H2O_l || 0) <= 1e-9 && (moles.C2H5OH_l || 0) <= 1e-9) {
    return Math.max(295, pureHno3BpK);
  }
  const nH2O = moles.H2O_l || 0;
  const nEtOH = moles.C2H5OH_l || 0;
  const nAcOH = moles.CH3COOH_l || 0;
  const nBr2Liq = moles.Br2_l || 0;
  const nSO4Tot = (moles.SO4_2_aq || 0) + (moles.HSO4_aq || 0);
  const nH2SO4Aq = Math.min(nSO4Tot, ((moles.H_aq || 0) + (moles.HSO4_aq || 0)) * 0.5);
  const nH2SO4Tot = nPureH2SO4 + nH2SO4Aq;
  if (nH2O <= 1e-10 && nEtOH <= 1e-10 && nPureH2SO4 <= 1e-10 && nPureHNO3 <= 1e-10 && nAcOH > 1e-10) {
    const pureAcBpK =
      1 / (1 / 391.05 - (CONSTANTS.R_J_MOL_K / 23700) * Math.log(pSafe / CONSTANTS.P_STD_BAR));
    return Math.max(300, pureAcBpK);
  }
  if (nH2O <= 1e-10 && nEtOH <= 1e-10 && nPureH2SO4 <= 1e-10 && nBr2Liq > 1e-8) {
    const pureBr2BpK =
      1 / (1 / 331.95 - (CONSTANTS.R_J_MOL_K / 29960) * Math.log(pSafe / CONSTANTS.P_STD_BAR));
    return Math.max(266, pureBr2BpK);
  }
  if (nH2O <= 1e-10 && nEtOH <= 1e-10 && nPureH2SO4 <= 1e-10 && nPureHNO3 <= 1e-10 && (moles.I2_s || 0) > 1e-8 && (moles.S_s || 0) <= 1e-8) {
    return 457.45; // Iodine normal boiling point 184.3 C (molten above 113.7 C)
  }
  if (nH2O <= 1e-10 && nEtOH <= 1e-10 && nPureH2SO4 <= 1e-10 && nPureHNO3 <= 1e-10 && (moles.S_s || 0) > 1e-8) {
    return 717.75; // Sulfur normal boiling point 444.6 C
  }
  if (nH2O <= 1e-10 && nEtOH <= 1e-10 && nPureH2SO4 <= 1e-10) return baseK;

  const mH2O = nH2O * CONSTANTS.M_H2O;
  const nHCl = Math.min(moles.H_aq || 0, moles.Cl_aq || 0);
  const nHNO3Aq = Math.min(moles.H_aq || 0, moles.NO3_aq || 0);
  const nHNO3Tot = nHNO3Aq + nPureHNO3;

  // Sulfuric acid-water BPE: rises monotonically from 100 °C -> ~124 °C (50%) -> ~205 °C (80%) -> 337 °C (98.3%)
  if (nEtOH <= 1e-9 && nH2SO4Tot > 1e-9 && (nPureH2SO4 > 1e-9 || (nH2SO4Tot >= nHCl * 0.5 && nH2SO4Tot >= nHNO3Tot * 0.5))) {
    const mAcid = nH2SO4Tot * CONSTANTS.M_H2SO4;
    const wAcid = Math.min(1, mAcid / Math.max(1e-9, mAcid + mH2O));
    const boil98P = CONSTANTS.T_BOIL_H2SO4_98_K + 18.0 * Math.log(pSafe / CONSTANTS.P_STD_BAR);
    if (wAcid >= 0.04) {
      const span = Math.max(0, boil98P - baseK);
      const deltaK = span * Math.pow(Math.min(1, wAcid / CONSTANTS.H2SO4_AZEOTROPE_WT_FRAC), 2.35);
      return Math.max(295, baseK + deltaK);
    }
  }

  // Aqueous HNO3 (including residual anhydrous HNO3_l): rises from 100 °C -> 121.2 °C (68% azeotrope) -> 83 °C (100%)
  if ((nH2O > 1e-10 || nPureHNO3 > 1e-10) && nEtOH <= 1e-9 && nHNO3Tot > 1e-9 && nHNO3Tot >= nHCl * 0.5) {
    const mHNO3 = nHNO3Tot * CONSTANTS.M_HNO3;
    const wHNO3 = Math.min(1, mHNO3 / Math.max(1e-9, mHNO3 + mH2O));
    const wAz = CONSTANTS.HNO3_AZEOTROPE_WT_FRAC;
    const azBoilK = baseK + 21.2; // 373.15 + 21.20 = 394.35 K (121.2 °C at 1 atm)
    if (wHNO3 <= wAz) {
      const frac = wHNO3 / wAz;
      const deltaK = 21.2 * Math.pow(frac, 1.45);
      return Math.max(295, baseK + deltaK);
    }
    const u = (wHNO3 - wAz) / Math.max(1e-6, 1 - wAz);
    return Math.max(295, azBoilK + (pureHno3BpK - azBoilK) * Math.pow(u, 1.25));
  }

  if (nH2O > 1e-10 && nEtOH <= 1e-9 && nHCl > 1e-9) {
    const mHCl = nHCl * CONSTANTS.M_HCL;
    const wHCl = mHCl / (mHCl + mH2O);
    const wAz = CONSTANTS.HCL_AZEOTROPE_WT_FRAC;
    let deltaK = 0;
    if (wHCl <= wAz) {
      deltaK = 8.97 * Math.pow(wHCl / wAz, 1.35);
    } else {
      const over = Math.min(1.15, (wHCl - wAz) / (0.37 - wAz));
      deltaK = 8.97 - 60.6 * Math.pow(over, 1.15);
    }
    return Math.max(295, baseK + deltaK);
  }

  // Binary Ethanol / Water / Salt mixture boiling point: solve P_tot(T) = P_bar via 18-step monotonic bisection
  if (nEtOH > 1e-9) {
    const targetP = Math.max(0.05, P_bar);
    let lo = 285.0;
    let hi = 435.0;
    for (let i = 0; i < 18; i++) {
      const mid = 0.5 * (lo + hi);
      const { pTotBar } = computeEthanolWaterVLE(moles, mid, true);
      if (pTotBar < targetP) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return 0.5 * (lo + hi);
  }

  // Pure aqueous + non-volatile solute: Raoult's Law BPE
  const xEff = Math.max(0.55, waterMoleFraction(moles));
  return waterBoilingPointK(P_bar / xEff);
}

/**
 * Water density (g/mL) approximation over 273-373 K.
 */
export function waterDensityGPerMl(T_K) {
  const t = Math.max(0, Math.min(100, T_K - CONSTANTS.KELVIN_OFFSET));
  // Kell's simplified polynomial around 0.99704 at 25C and 0.9584 at 100C
  return 0.99984 + 6.79e-5 * t - 9.09e-6 * t * t + 1.0e-7 * t * t * t - 1.12e-9 * t * t * t * t;
}

/**
 * Unified system-wide numeric formatter:
 * - Thousands separator: comma (`,`)
 * - Decimal separator: period (`.`)
 */
export function formatNumber(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  const d = Math.max(0, Math.min(8, Math.trunc(decimals)));
  const fixed = num.toFixed(d);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart !== undefined ? `${withCommas}.${decPart}` : withCommas;
}
