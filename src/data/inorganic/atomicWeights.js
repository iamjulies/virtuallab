/**
 * Shared atomic and molecular weights (g/mol) for stoichiometric consistency.
 */
export const AW = {
  H: 1.00794,
  C: 12.0107,
  N: 14.0067,
  O: 15.9994,
  Na: 22.98977,
  S: 32.065,
  Cl: 35.453,
  Ca: 40.078,
  Cu: 63.546,
  Zn: 65.38,
  Ag: 107.8682,
  Mg: 24.305,
  Al: 26.981539,
  K: 39.0983,
  Mn: 54.938045,
  Br: 79.904,
  I: 126.90447,
};

export const M_H2O = 2 * AW.H + AW.O;
export const M_ETOH = 2 * AW.C + 6 * AW.H + AW.O;
export const M_OH = AW.O + AW.H;
export const M_SO4 = AW.S + 4 * AW.O;
AW.Fe = 55.845;
AW.Ba = 137.327;
AW.P = 30.973762;
AW.Si = 28.0855;
AW.Cr = 51.9961;
AW.Ni = 58.6934;
AW.Pb = 207.2;
export const M_NO3 = AW.N + 3 * AW.O;
export const M_CO3 = AW.C + 3 * AW.O;
export const M_HCO3 = AW.H + AW.C + 3 * AW.O;
export const M_H2SO4 = 2 * AW.H + AW.S + 4 * AW.O;
export const M_SO2 = AW.S + 2 * AW.O;
export const M_H2S = 2 * AW.H + AW.S;
export const M_MnO4 = AW.Mn + 4 * AW.O;
