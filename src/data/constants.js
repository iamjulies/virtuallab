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

  // Water properties & auto-ionization
  KW_298: 1.0e-14,
  DELTA_H_WATER_IONIZATION_J: 55800, // J/mol
  DELTA_H_VAP_WATER_J: 40660,        // J/mol at ~373K
  DELTA_H_VAP_HCL_AQ_J: 74800,       // J/mol enthalpy of HCl(aq) -> HCl(g) outgassing
  HCL_AZEOTROPE_WT_FRAC: 0.2024,     // 20.24% w/w HCl-H2O azeotrope (~108.6 C at 1 bar)
  M_H2O: 18.01528,                   // g/mol
  M_HCL: 36.46094,                   // g/mol
  CP_H2O_J_MOL_K: 75.38,             // J/(mol·K)

  // Antoine coefficients for water vapor pressure (log10(P_mmHg) = A - B / (C + T_C))
  ANTOINE_WATER: {
    A: 8.07131,
    B: 1730.63,
    C: 233.426,
    MMHG_PER_BAR: 750.061683,
  },

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

  // Numerical integration limits
  SUBSTEP_MAX_DT: 0.01, // 10 ms max physics/chem substep
};

export function kelvinToCelsius(k) {
  return k - CONSTANTS.KELVIN_OFFSET;
}

export function celsiusToKelvin(c) {
  return c + CONSTANTS.KELVIN_OFFSET;
}

/**
 * Water vapor saturation pressure in mmHg using the Antoine equation (valid ~0..150 C).
 */
export function waterVaporPressureMmHg(T_K) {
  const T_C = Math.max(0, Math.min(200, T_K - CONSTANTS.KELVIN_OFFSET));
  const { A, B, C } = CONSTANTS.ANTOINE_WATER;
  return Math.pow(10, A - B / (C + T_C));
}

/**
 * Water vapor saturation pressure in bar using the Antoine equation.
 */
export function waterVaporPressureBar(T_K) {
  return waterVaporPressureMmHg(T_K) / CONSTANTS.ANTOINE_WATER.MMHG_PER_BAR;
}

/**
 * Solvent water mole fraction x_H2O for Raoult's Law vapor pressure lowering.
 */
export function waterMoleFraction(moles) {
  const nH2O = moles.H2O_l || 0;
  if (nH2O <= 1e-12) return 0;
  const soluteMol =
    (moles.C2H5OH_l || 0) +
    (moles.Na_aq || 0) +
    (moles.OH_aq || 0) +
    (moles.H_aq || 0) +
    (moles.Cl_aq || 0) +
    (moles.Cu2_aq || 0) +
    (moles.Zn2_aq || 0) +
    (moles.Ag_aq || 0) +
    (moles.SO4_2_aq || 0) +
    (moles.NO3_aq || 0) +
    (moles.CuCl4_2_aq || 0) +
    (moles.ZnOH4_2_aq || 0);
  return nH2O / (nH2O + Math.max(0, soluteMol));
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
 * Aqueous solution boiling temperature (K), using:
 * - Exact HCl-H2O azeotropic boiling curve (20.24% w/w azeotrope at 108.6 C, 37% fuming ~48 C)
 * - Raoult's Law P_surface = x_H2O * P_sat(T) = P_bar for non-volatile dissolved salts/bases
 */
export function solutionBoilingPointK(moles, P_bar) {
  const baseK = waterBoilingPointK(P_bar);
  const nH2O = moles.H2O_l || 0;
  if (nH2O <= 1e-10) return baseK;

  const mH2O = nH2O * CONSTANTS.M_H2O;
  const nHCl = Math.min(moles.H_aq || 0, moles.Cl_aq || 0);

  if (nHCl > 1e-9) {
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

  // Raoult's Law: boiling occurs where P_sat(T) = P_bar / x_H2O
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
