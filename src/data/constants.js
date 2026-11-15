/**
 * Physical & chemical constants (SI / IUPAC standard units).
 */
export const CONSTANTS = {
  // Ideal gas constant
  R_J_MOL_K: 8.314462618,
  R_L_BAR_MOL_K: 0.08314462618,

  // IUPAC Standard Ambient Temperature & Pressure (SATP)
  T_STD_K: 298.15,
  P_STD_BAR: 1.0,
  KELVIN_OFFSET: 273.15,

  // Water properties & auto-ionization
  KW_298: 1.0e-14,
  DELTA_H_WATER_IONIZATION_J: 55800, // J/mol
  DELTA_H_VAP_WATER_J: 40660,        // J/mol at ~373K
  M_H2O: 18.01528,                   // g/mol
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
 * Water vapor saturation pressure in bar using the Antoine equation.
 */
export function waterVaporPressureBar(T_K) {
  const T_C = Math.max(0, Math.min(200, T_K - CONSTANTS.KELVIN_OFFSET));
  const { A, B, C, MMHG_PER_BAR } = CONSTANTS.ANTOINE_WATER;
  const pMmHg = Math.pow(10, A - B / (C + T_C));
  return pMmHg / MMHG_PER_BAR;
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
 * Water density (g/mL) approximation over 273-373 K.
 */
export function waterDensityGPerMl(T_K) {
  const t = Math.max(0, Math.min(100, T_K - CONSTANTS.KELVIN_OFFSET));
  // Kell's simplified polynomial around 0.99704 at 25C and 0.9584 at 100C
  return 0.99984 + 6.79e-5 * t - 9.09e-6 * t * t + 1.0e-7 * t * t * t - 1.12e-9 * t * t * t * t;
}
