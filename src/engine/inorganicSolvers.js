/**
 * Elemental Inorganic Solvers Barrel Module (Prompt 68 / Refactor 81).
 */
export { stepHalogenRedoxAndAlkali } from './solvers/inorganic/halogen_alkali.js';
export { stepSulfurChemistry } from './solvers/inorganic/sulfur.js';
export { stepCarbideAndCarbonChemistry, stepCarbonateAndCO2Equilibria } from './solvers/inorganic/carbon_carbide.js';
export {
  stepAmmineComplexEquilibria,
  stepPhosphorusChemistry,
  stepSiliconAndChromiumChemistry,
} from './solvers/inorganic/phosphorus_nitrogen_ammine.js';
