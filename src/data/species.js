/**
 * Chemical Species Database & Starter Pure Reagents.
 * Atomic weights derived consistently so mass conservation holds to machine precision.
 *
 * ============================================================================
 * PROPERTY-DRIVEN METADATA SCHEMA (SPECIES[id]) — Prompt 80 Standard
 * ============================================================================
 * 1. Core Identity:
 *    id, formula, name, phase ('s' | 'l' | 'aq' | 'g'), molarMass (g/mol),
 *    atoms ({ C, H, O, N, ... }), charge (integer for 'aq' ions).
 * 2. Thermodynamics & Phase Change:
 *    cp (J/(mol·K)), density (g/mL), meltTempK, boilTempK, dHFusJ, dHVapJ,
 *    dHCombustJ, autoIgnitionK, flashPointK, partialMolarVolMl, noMelt.
 * 3. Phase Stratification & Solubility:
 *    liquidGroup ('aqueous' | 'water_miscible_organic' | 'light_organic' |
 *                 'organic_light' | 'heavy_organic' | 'organic_heavy'),
 *    partitionKow (octanol-water K_ow), vaporPressureAtm298, vaporSpeciesId,
 *    isPrecipitate, isPolymer, isFat, isSoapIon, isSoapSolid.
 * 4. Viscosity & Electrochemistry:
 *    viscosityCp298 (dynamic viscosity at 298.15 K in cP; 0.89 for H2O),
 *    viscosityRel298 (dimensionless ratio relative to H2O; alternative to Cp),
 *    molarConductivity (limiting molar conductivity λ⁰ in mS·cm²/mmol at 298 K).
 * 5. Optical Spectroscopy & Chromatography:
 *    color, visualType, renderLayer, extinctionRGB, opticalCoeff,
 *    uvActive / isUV (boolean UV-254 quenching), tlcColor (hex), tlcPolarity (0..1),
 *    eluentStrength (0.0..1.0 solvent strength for TLC mobile phase),
 *    uvVisBands ([{ lambdaNm, eps, fwhmNm?, sigmaNm?, tagVi?, tagEn? }]),
 *    irBands ([{ wn, fwhm?, strength?, labelVi, labelEn, key? }]),
 *    functionalGroups ({ isArene, isAlkene, isPrimaryAlcohol, hasAldehydeGroup, ... }).
 * 6. Aroma & GHS Laboratory Safety:
 *    aromaProfile ({ key, minMol, tone?, category? }),
 *    ghsHazards (Array of 'flammable' | 'corrosive' | 'toxic' | 'oxidizer').
 * ============================================================================
 */
import { AW, M_H2O, M_ETOH, M_OH, M_SO4, M_NO3, M_CO3, M_HCO3, M_H2SO4, M_SO2, M_H2S, M_MnO4 } from './inorganic/atomicWeights.js';
import { INORGANIC_ION_SPECIES } from './inorganic/ions.js';
import { INORGANIC_SOLID_GAS_SPECIES } from './inorganic/solids_gases.js';
import { HYDROCARBON_SPECIES } from './organic/hydrocarbons.js';
import { OXYGEN_SPECIES } from './organic/oxygen_compounds.js';
import { NITROGEN_BIO_SPECIES } from './organic/nitrogen_bio.js';
import { REAGENT_CATEGORIES, ORGANIC_SUBCATEGORIES, STARTER_REAGENTS, REAGENTS } from './reagents.js';

export { REAGENT_CATEGORIES, ORGANIC_SUBCATEGORIES, STARTER_REAGENTS, REAGENTS };

export const SPECIES = {
  ...INORGANIC_SOLID_GAS_SPECIES,
  ...INORGANIC_ION_SPECIES,
  ...HYDROCARBON_SPECIES,
  ...OXYGEN_SPECIES,
  ...NITROGEN_BIO_SPECIES,
};

/**
 * Automatically derived species groupings & registries from SPECIES.
 * Adding a new species to SPECIES auto-propagates gases, precipitate layers, and inspectors.
 */
export const AIR_MOLAR_MASS_G_MOL = 28.97;

for (const sp of Object.values(SPECIES)) {
  if (sp.phase === 'g' && sp.molarMass) {
    sp.relAirDensity = sp.molarMass / AIR_MOLAR_MASS_G_MOL;
    sp.densityGPerL298 = sp.molarMass / 24.789;
  }
}

export function getGasRelativeAirDensity(gasId) {
  const sp = SPECIES[gasId];
  return sp?.relAirDensity ?? (sp?.molarMass ? sp.molarMass / AIR_MOLAR_MASS_G_MOL : 1.0);
}

/**
 * Determine if a dry solid species should be displayed & treated visually as a molten liquid pool at tempK.
 */
export function isSolidMoltenAtTemp(sp, tempK, moles) {
  if (!sp || sp.phase !== 's' || sp.noMelt || !Number.isFinite(sp.meltTempK)) return false;
  if (!Number.isFinite(tempK) || tempK < sp.meltTempK) return false;
  if ((moles?.H2O_l || 0) >= 0.015 || (moles?.C2H5OH_l || 0) >= 0.015) return false;
  return true;
}

export const SPECIES_DISPLAY_OVERRIDES = {
  Starch_s: 'Starch',
  Starch_aq: 'Starch',
  Cellulose_s: 'Cellulose',
  Glucose_s: 'C₆H₁₂O₆ (Glc)',
  Glucose_aq: 'C₆H₁₂O₆ (Glc)',
  Fructose_s: 'C₆H₁₂O₆ (Frc)',
  Fructose_aq: 'C₆H₁₂O₆ (Frc)',
  Sucrose_s: 'C₁₂H₂₂O₁₁ (Suc)',
  Sucrose_aq: 'C₁₂H₂₂O₁₁ (Suc)',
  Maltose_s: 'C₁₂H₂₂O₁₁ (Mal)',
  Maltose_aq: 'C₁₂H₂₂O₁₁ (Mal)',
  Gly2_s: 'Gly–Gly (Gly₂)',
  Gly2_aq: 'Gly–Gly (Gly₂)',
  Gly3_s: 'Gly–Gly–Gly (Gly₃)',
  Gly3_aq: 'Gly–Gly–Gly (Gly₃)',
  Ala2_s: 'Ala–Ala (Ala₂)',
  Ala2_aq: 'Ala–Ala (Ala₂)',
  Ala3_s: 'Ala–Ala–Ala (Ala₃)',
  Ala3_aq: 'Ala–Ala–Ala (Ala₃)',
  Val2_s: 'Val–Val (Val₂)',
  Val2_aq: 'Val–Val (Val₂)',
  Val3_s: 'Val–Val–Val (Val₃)',
  Val3_aq: 'Val–Val–Val (Val₃)',
  Peptide_s: 'Polypeptide',
  Peptide_aq: 'Polypeptide',
  S_s: 'S',
  S_plastic_s: 'S(dẻo)',
  P_red_s: 'P(đỏ)',
  P_white_s: 'P(trắng)',
  C_s: 'C',
  H2CO3_aq: 'CO₂ / H₂CO₃',
  CharN_s: 'C₃N',
  CharNS_s: 'C₆N₂S',
  Albumin_s: 'Albumin',
  Albumin_aq: 'Albumin',
  AlbuminCoagulated_s: 'Albumin (đông tụ)',
  AlbuminBrown_s: 'Albumin (biến tính)',
  AlbuminDenatured_s: 'Albumin (biến tính)',
  AlbuminXantho_s: 'Albumin–NO₂',
  Keratin_s: 'Keratin',
  KeratinBrown_s: 'Keratin (biến tính)',
  KeratinXantho_s: 'Keratin–NO₂',
  Amylase_aq: 'α-Amylase',
  AmylaseDenatured_s: 'α-Amylase (biến tính)',
  Catalase_aq: 'Catalase',
  CatalaseDenatured_s: 'Catalase (biến tính)',
  Valine_g: 'Valine',
  C4H7NO_g: 'C₄H₇NO',
  Caprolactam_s: 'C₆H₁₁NO',
  Nylon6_s: 'Nylon-6',
  Pyroglutamic_s: 'C₅H₇NO₃',
};

/**
 * Unified clean display formatter for species in Liquid, Solid, Gas, Syringe, Report & XLSX tables.
 * Strips (aq)/(s)/(l)/(g), ↓/↑, color notes; keeps allotrope tags & appends 💨 for condensable vapors.
 */
export function formatSpeciesDisplayFormula(spOrId, context = 'table') {
  const sp = typeof spOrId === 'string' ? SPECIES[spOrId] : spOrId;
  if (!sp) return typeof spOrId === 'string' ? spOrId : '—';
  const id = sp.id || '';
  let base = SPECIES_DISPLAY_OVERRIDES[id];
  if (!base) {
    base = String(sp.formula || id)
      .replace(/[↓↑]/g, '')
      .replace(/\s*\((aq|s|l|g)\)/gi, '')
      .replace(/\s*\((vàng(?:\s*nâu|\s*cam)?|trắng|đỏ(?:\s*gạch)?|nâu(?:\s*đỏ)?|xanh|đen|tím|cam|thăng hoa|đậm đặc|sém nâu|muối|tinh thể|Protein[^)]*)\)/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  if (sp.phase === 'g' && context !== 'raw' && context !== 'noVaporIcon') {
    const stem = id.replace(/_g$/, '');
    const isCondensable = Boolean(
      sp.isCondensableVapor ||
        sp.liquidSpeciesId ||
        SPECIES[`${stem}_l`] ||
        SPECIES[`${stem}_s`] ||
        id === 'P4_g' ||
        id === 'S_g' ||
        id === 'C4H7NO_g' ||
        id === 'C8H8_g'
    );
    if (isCondensable && !base.includes('💨')) {
      return `${base} 💨`;
    }
  }
  return base;
}

export const NON_STEAM_GAS_IDS = Object.values(SPECIES)
  .filter((sp) => sp.phase === 'g' && sp.id !== 'H2O_g')
  .sort((a, b) => (a.gasOrder ?? 999) - (b.gasOrder ?? 999))
  .map((sp) => sp.id);

export const ALL_GAS_IDS = [...NON_STEAM_GAS_IDS, 'H2O_g'];

export const GAS_DISPLAY_META = Object.values(SPECIES)
  .filter((sp) => sp.phase === 'g')
  .sort((a, b) => (a.gasOrder ?? 999) - (b.gasOrder ?? 999))
  .map((sp) => ({
    id: sp.id,
    label: formatSpeciesDisplayFormula(sp, 'gas'),
    always: !!sp.gasAlwaysShow,
    relAirDensity: sp.relAirDensity ?? 1.0,
  }));

export function createZeroGasMap() {
  const map = {};
  for (const g of ALL_GAS_IDS) map[g] = 0;
  return map;
}

export const SORTED_PRECIPITATE_SPECIES = Object.values(SPECIES)
  .filter((sp) => sp.phase === 's' && (sp.renderLayer === 'precipitate' || (!sp.renderLayer && sp.isPrecipitate)))
  .sort((a, b) => (a.renderOrder ?? 999) - (b.renderOrder ?? 999));

export const SORTED_BOTTOM_SOLID_SPECIES = Object.values(SPECIES)
  .filter(
    (sp) =>
      sp.phase === 's' &&
      sp.renderLayer !== 'floating_metal' &&
      !(sp.renderLayer === 'precipitate' || (!sp.renderLayer && sp.isPrecipitate))
  )
  .sort((a, b) => (a.renderOrder ?? 999) - (b.renderOrder ?? 999));

const NIST_FUSION_ENTHALPY_J = {
  H2O_s: 6010,
  Br2_s: 10571,
  Na_s: 2600,
  K_s: 2334,
  Li_s: 3000,
  Ca_s: 8540,
  Ba_s: 7120,
  Mg_s: 8480,
  Al_s: 10710,
  Zn_s: 7320,
  Fe_s: 13810,
  Cu_s: 13260,
  Ag_s: 11280,
  S_s: 1727,
  I2_s: 15520,
  P_red_s: 18800,
  NaOH_s: 6600,
  KOH_s: 8600,
  NaCl_s: 28160,
  KCl_s: 26530,
  AgNO3_s: 11550,
  NaNO3_s: 15500,
  KNO3_s: 10040,
  KClO3_s: 18500,
  K2Cr2O7_s: 36700,
  K2CrO4_s: 28000,
  CH3COOH_s: 11730,
  CH3COONa_s: 18000,
  CH3COOK_s: 14800,
  CH3COONH4_s: 13200,
  CH3CONH2_s: 15600,
  ClCH2COOH_s: 12300,
  BrCH2COOH_s: 13500,
  CHI3_s: 16300,
  C6H6_s: 9870,
  C6H5OH_s: 11510,
  C6H6Cl6_s: 19500,
  C6H6Br6_s: 22000,
  C6H4_NO2_2_s: 17300,
  C4H2O3_s: 13660,
  C12H10_s: 18570,
  C6H2Br3OH_s: 20500,
  H2C2O4_s: 21500,
  CH3CHCHCOOH_s: 13200,
  C6H2_NO2_3OH_s: 19200,
  C6H4OH_2_s: 22700,
  C6H4_SO3H_2_s: 24000,
  C6H5COOH_s: 18060,
  C6H2_NO2_3CH3_s: 21400,
  C57H110O6_s: 190000,
  C17H35COOH_s: 61200,
  PE_s: 8200,
  PVC_s: 9500,
  C17H33COONa_s: 28000,
  C17H35COONa_s: 30000,
};

export function getSpeciesFusionHeatJ(sp) {
  if (!sp || sp.phase !== 's' || !sp.meltTempK || sp.noMelt) return 0;
  if (typeof sp.dHFusJ === 'number' && sp.dHFusJ > 0) return sp.dHFusJ;
  if (NIST_FUSION_ENTHALPY_J[sp.id]) return NIST_FUSION_ENTHALPY_J[sp.id];
  const isMetal = Boolean(sp.isMetal || sp.visualType?.includes('metal') || sp.visualType?.includes('granules'));
  return Math.max(1800, Math.round(sp.meltTempK * (isMetal ? 10.5 : 14.5)));
}

const ORGANIC_PROPERTY_METADATA = {
  CH4_g: { atoms: { C: 1, H: 4 }, autoIgnitionK: 810.15, dHCombustJ: -890300, functionalGroups: { isAlkane: true, legacyHandled: true } },
  C2H4_g: { atoms: { C: 2, H: 4 }, autoIgnitionK: 723.15, dHCombustJ: -1411000, functionalGroups: { isAlkene: true, legacyHandled: true } },
  C2H2_g: { atoms: { C: 2, H: 2 }, autoIgnitionK: 578.15, dHCombustJ: -1300000, functionalGroups: { hasTripleBondTerminal: true, legacyHandled: true } },
  CH3OH_l: { atoms: { C: 1, H: 4, O: 1 }, autoIgnitionK: 658.15, dHCombustJ: -726000, functionalGroups: { isPrimaryAlcohol: true, legacyHandled: true }, eluentStrength: 0.95, viscosityCp298: 0.54, aromaProfile: { key: 'aromaAlcohol', minMol: 0.01, category: 'alcohol', tone: 'text-main border-theme bg-surface-alt' }, ghsHazards: ['flammable', 'toxic'] },
  C2H5OH_l: { atoms: { C: 2, H: 6, O: 1 }, autoIgnitionK: 636.15, dHCombustJ: -1367000, functionalGroups: { isPrimaryAlcohol: true, legacyHandled: true }, eluentStrength: 0.88, viscosityCp298: 1.07, aromaProfile: { key: 'aromaAlcohol', minMol: 0.01, category: 'alcohol', tone: 'text-main border-theme bg-surface-alt' }, ghsHazards: ['flammable'] },
  CH3COOH_l: { atoms: { C: 2, H: 4, O: 2 }, autoIgnitionK: 736.15, dHCombustJ: -874000, functionalGroups: { isCarboxylicAcid: true, legacyHandled: true }, viscosityCp298: 1.13, aromaProfile: { key: 'aromaVinegar', minMol: 0.005, category: 'vinegar', tone: 'text-amber-300 border-amber-500/40 bg-amber-500/10' }, ghsHazards: ['corrosive', 'flammable'] },
  C3H5OH_3_l: { atoms: { C: 3, H: 8, O: 3 }, autoIgnitionK: 643.15, dHCombustJ: -1655000, functionalGroups: { hasVicinalDiol: true, legacyHandled: true }, viscosityCp298: 934.0, viscosityRel298: 4.1 },
  HCHO_aq: { atoms: { C: 1, H: 2, O: 1 }, functionalGroups: { hasAldehydeGroup: true, legacyHandled: true }, uvActive: false, ghsHazards: ['toxic'] },
  CH3CHO_l: { atoms: { C: 2, H: 4, O: 1 }, autoIgnitionK: 458.15, dHCombustJ: -1167000, functionalGroups: { hasAldehydeGroup: true, legacyHandled: true }, uvActive: false, ghsHazards: ['flammable'] },
  C6H6_l: { atoms: { C: 6, H: 6 }, autoIgnitionK: 771.15, dHCombustJ: -3268000, functionalGroups: { isArene: true, legacyHandled: true }, uvActive: true, eluentStrength: 0.32, viscosityCp298: 0.60, ghsHazards: ['flammable', 'toxic'] },
  C6H6_s: { atoms: { C: 6, H: 6 }, functionalGroups: { isArene: true, legacyHandled: true }, uvActive: true },
  C6H5Br_l: { atoms: { C: 6, H: 5, Br: 1 }, functionalGroups: { isArene: true, isHaloalkane: true, legacyHandled: true }, uvActive: true },
  C6H5Cl_l: { atoms: { C: 6, H: 5, Cl: 1 }, functionalGroups: { isArene: true, isHaloalkane: true, legacyHandled: true }, uvActive: true },
  C6H5NO2_l: { atoms: { C: 6, H: 5, N: 1, O: 2 }, functionalGroups: { isArene: true, hasNitroGroup: true, legacyHandled: true }, uvActive: true },
  C6H5CH3_l: { atoms: { C: 7, H: 8 }, functionalGroups: { isArene: true, legacyHandled: true }, uvActive: true, eluentStrength: 0.29, viscosityCp298: 0.56, ghsHazards: ['flammable', 'toxic'] },
  C6H5C2H5_l: { atoms: { C: 8, H: 10 }, functionalGroups: { isArene: true, legacyHandled: true }, uvActive: true, ghsHazards: ['flammable'] },
  C6H5COCH3_l: { atoms: { C: 8, H: 8, O: 1 }, functionalGroups: { isArene: true, isKetone: true, legacyHandled: true }, uvActive: true },
  C6H5OH_l: { atoms: { C: 6, H: 6, O: 1 }, functionalGroups: { isArene: true, isPhenol: true, legacyHandled: true }, uvActive: true, ghsHazards: ['corrosive', 'toxic'] },
  C6H5OH_s: { atoms: { C: 6, H: 6, O: 1 }, functionalGroups: { isArene: true, isPhenol: true, legacyHandled: true }, uvActive: true, ghsHazards: ['corrosive', 'toxic'] },
  C6H5CH2Br_l: { atoms: { C: 7, H: 7, Br: 1 }, functionalGroups: { isArene: true, isHaloalkane: true, legacyHandled: true }, uvActive: true },
  BrC6H4CH3_l: { atoms: { C: 7, H: 7, Br: 1 }, functionalGroups: { isArene: true, legacyHandled: true }, uvActive: true },
  NO2C6H4CH3_l: { atoms: { C: 7, H: 7, N: 1, O: 2 }, functionalGroups: { isArene: true, hasNitroGroup: true, legacyHandled: true }, uvActive: true },
  C6H5COOC2H5_l: { atoms: { C: 9, H: 10, O: 2 }, functionalGroups: { isArene: true, isEster: true, legacyHandled: true }, uvActive: true, aromaProfile: { key: 'aromaEsterFruity', minMol: 0.003, category: 'ester_fruity', tone: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' } },
  C6H4_NO2_2_s: { atoms: { C: 6, H: 4, N: 2, O: 4 }, functionalGroups: { isArene: true, hasNitroGroup: true, legacyHandled: true }, uvActive: true },
  C12H10_s: { atoms: { C: 12, H: 10 }, functionalGroups: { isArene: true, legacyHandled: true }, uvActive: true },
  C6H2Br3OH_s: { atoms: { C: 6, H: 3, Br: 3, O: 1 }, functionalGroups: { isArene: true, isPhenol: true, legacyHandled: true }, uvActive: true },
  C6H2_NO2_3OH_s: { atoms: { C: 6, H: 3, N: 3, O: 7 }, functionalGroups: { isArene: true, isPhenol: true, hasNitroGroup: true, legacyHandled: true }, uvActive: true },
  C6H4OH_2_s: { atoms: { C: 6, H: 6, O: 2 }, functionalGroups: { isArene: true, isPhenol: true, legacyHandled: true }, uvActive: true },
  C6H5SO3Na_s: { atoms: { C: 6, H: 5, S: 1, O: 3, Na: 1 }, functionalGroups: { isArene: true, legacyHandled: true }, uvActive: true },
  C6H4_SO3H_2_s: { atoms: { C: 6, H: 6, S: 2, O: 6 }, functionalGroups: { isArene: true, legacyHandled: true }, uvActive: true },
  C6H5COOH_s: { atoms: { C: 7, H: 6, O: 2 }, functionalGroups: { isArene: true, isCarboxylicAcid: true, legacyHandled: true }, uvActive: true },
  C6H2_NO2_3CH3_s: { atoms: { C: 7, H: 5, N: 3, O: 6 }, functionalGroups: { isArene: true, hasNitroGroup: true, legacyHandled: true }, uvActive: true },
  CH2CHCHO_l: { atoms: { C: 3, H: 4, O: 1 }, functionalGroups: { isAlkene: true, hasAldehydeGroup: true, legacyHandled: true }, uvActive: true, ghsHazards: ['flammable', 'toxic'] },
  CH3CHCHCHO_l: { atoms: { C: 4, H: 6, O: 1 }, functionalGroups: { isAlkene: true, hasAldehydeGroup: true, legacyHandled: true }, uvActive: true },
  CH2CHCOOH_l: { atoms: { C: 3, H: 4, O: 2 }, functionalGroups: { isAlkene: true, isCarboxylicAcid: true, legacyHandled: true }, uvActive: true, ghsHazards: ['corrosive', 'flammable'] },
  CH3CHCHCOOH_s: { atoms: { C: 4, H: 6, O: 2 }, functionalGroups: { isAlkene: true, isCarboxylicAcid: true, legacyHandled: true }, uvActive: true },
  C4H2O3_s: { atoms: { C: 4, H: 2, O: 3 }, functionalGroups: { isAlkene: true, isEster: true, legacyHandled: true }, uvActive: true },
  Br2_l: { atoms: { Br: 2 }, uvActive: true, ghsHazards: ['corrosive', 'toxic', 'oxidizer'] },
  H2O_l: { atoms: { H: 2, O: 1 }, eluentStrength: 0.95, viscosityCp298: 0.89, viscosityRel298: 1.0 },
  C6H14_l: { eluentStrength: 0.01, viscosityCp298: 0.30, ghsHazards: ['flammable'] },
  C6H12_l: { eluentStrength: 0.05, viscosityCp298: 0.32, ghsHazards: ['flammable'] },
  C3H7OH_l: { eluentStrength: 0.82, viscosityCp298: 1.94, aromaProfile: { key: 'aromaAlcohol', minMol: 0.01, category: 'alcohol', tone: 'text-main border-theme bg-surface-alt' }, ghsHazards: ['flammable'] },
  C5H11OH_l: { eluentStrength: 0.72, viscosityCp298: 3.7, aromaProfile: { key: 'aromaAlcohol', minMol: 0.01, category: 'alcohol', tone: 'text-main border-theme bg-surface-alt' }, ghsHazards: ['flammable'] },
  CHCl3_l: { eluentStrength: 0.40, viscosityCp298: 0.54, ghsHazards: ['toxic'] },
  CH3COOC2H5_l: { eluentStrength: 0.58, viscosityCp298: 0.43, aromaProfile: { key: 'aromaEsterFruity', minMol: 0.003, category: 'ester_fruity', tone: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' }, ghsHazards: ['flammable'] },
  CH3COOC3H7_l: { eluentStrength: 0.56, aromaProfile: { key: 'aromaEsterFruity', minMol: 0.003, category: 'ester_fruity', tone: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' }, ghsHazards: ['flammable'] },
  CH3COOCH3_l: { eluentStrength: 0.60, aromaProfile: { key: 'aromaEsterFruity', minMol: 0.003, category: 'ester_fruity', tone: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' }, ghsHazards: ['flammable'] },
  CH3COOC5H11_l: { aromaProfile: { key: 'aromaEsterFruity', minMol: 0.003, category: 'ester_fruity', tone: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' }, ghsHazards: ['flammable'] },
  HCOOCH3_l: { eluentStrength: 0.58, aromaProfile: { key: 'aromaEsterFruity', minMol: 0.003, category: 'ester_fruity', tone: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' }, ghsHazards: ['flammable'] },
  HCOOC2H5_l: { eluentStrength: 0.56, aromaProfile: { key: 'aromaEsterFruity', minMol: 0.003, category: 'ester_fruity', tone: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' }, ghsHazards: ['flammable'] },
  CH3COCH3_l: { eluentStrength: 0.56, viscosityCp298: 0.31, ghsHazards: ['flammable'] },
  C2H5OC2H5_l: { eluentStrength: 0.38, viscosityCp298: 0.22, aromaProfile: { key: 'aromaEther', minMol: 0.003, category: 'ether', tone: 'text-purple-300 border-purple-500/40 bg-purple-500/10' }, ghsHazards: ['flammable'] },
  HCOOH_l: { viscosityCp298: 1.61, aromaProfile: { key: 'aromaVinegar', minMol: 0.005, category: 'vinegar', tone: 'text-amber-300 border-amber-500/40 bg-amber-500/10' }, ghsHazards: ['corrosive', 'flammable'] },
  H2SO4_l: { viscosityCp298: 24.2, viscosityRel298: 3.5, ghsHazards: ['corrosive', 'oxidizer'] },
  HNO3_l: { viscosityCp298: 0.75, ghsHazards: ['corrosive', 'oxidizer'] },
  HCl_aq: { ghsHazards: ['corrosive'] },
  NaOH_s: { atoms: { Na: 1, O: 1, H: 1 }, ghsHazards: ['corrosive'] },
  KMnO4_s: { ghsHazards: ['oxidizer'] },
  H2O2_aq: { ghsHazards: ['oxidizer', 'corrosive'] },
  C57H104O6_l: { viscosityCp298: 65.0 },
  C6H5NH2_l: { viscosityCp298: 3.85, ghsHazards: ['toxic'] },
  Na_s: { atoms: { Na: 1 }, ghsHazards: ['flammable', 'corrosive'] },
  K_s: { ghsHazards: ['flammable', 'corrosive'] },
  AgNO3_s: { ghsHazards: ['corrosive', 'oxidizer'] },
  BaCl2_2H2O_s: { ghsHazards: ['toxic'] },
  K2Cr2O7_s: { ghsHazards: ['toxic', 'oxidizer'] },
  I2_s: { ghsHazards: ['toxic', 'corrosive'] },
  S_s: { ghsHazards: ['flammable'] },
  CaC2_s: { ghsHazards: ['flammable', 'corrosive'] },
  P_red_s: { ghsHazards: ['flammable'] },
  NaNO2_s: { ghsHazards: ['toxic', 'oxidizer'] },
  NH3_aq: { ghsHazards: ['corrosive', 'toxic'] },
  NH3_g: { atoms: { N: 1, H: 3 }, ghsHazards: ['corrosive', 'toxic'] },
  KOH_s: { ghsHazards: ['corrosive'] },
  Ba_OH_2_s: { ghsHazards: ['corrosive', 'toxic'] },
  Ba_OH_2_8H2O_s: { ghsHazards: ['corrosive', 'toxic'] },
  H2SO4_aq: { ghsHazards: ['corrosive'] },
  HNO3_aq: { ghsHazards: ['corrosive', 'oxidizer'] },
  Na_g: { atoms: { Na: 1 } },
  Na2O2_s: { atoms: { Na: 2, O: 2 } },
  Na2CO3_s: { atoms: { Na: 2, C: 1, O: 3 } },
  O2_g: { atoms: { O: 2 } },
  N2_g: { atoms: { N: 2 } },
  NO2_g: { atoms: { N: 1, O: 2 } },
  CO_g: { atoms: { C: 1, O: 1 } },
  CO2_g: { atoms: { C: 1, O: 2 } },
  H2O_g: { atoms: { H: 2, O: 1 } },
  H2_g: { atoms: { H: 2 } },
  S_g: { atoms: { S: 1 } },
  SO2_g: { atoms: { S: 1, O: 2 } },
  C6H6_g: { atoms: { C: 6, H: 6 } },
  CH3COOH_g: { atoms: { C: 2, H: 4, O: 2 } },
};

const GHS_HAZARD_ORDER = ['flammable', 'corrosive', 'toxic', 'oxidizer'];

/**
 * Resolve deduplicated GHS hazard flags for any pure or multi-component reagent entry.
 */
export function getReagentGhsHazards(reg) {
  if (!reg) return [];
  const found = new Set();
  const addList = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const h of arr) {
      if (!h) continue;
      found.add(h === 'irritant' ? 'corrosive' : h);
    }
  };
  addList(reg.ghsHazards);
  if (reg.speciesId) addList(SPECIES[reg.speciesId]?.ghsHazards);
  if (reg.perMl && typeof reg.perMl === 'object') {
    for (const spId of Object.keys(reg.perMl)) {
      if (spId === 'H2O_l') continue;
      addList(SPECIES[spId]?.ghsHazards);
    }
  }
  if (reg.components && typeof reg.components === 'object') {
    for (const spId of Object.keys(reg.components)) {
      if (spId === 'H2O_l') continue;
      addList(SPECIES[spId]?.ghsHazards);
    }
  }
  return GHS_HAZARD_ORDER.filter((h) => found.has(h)).concat([...found].filter((h) => !GHS_HAZARD_ORDER.includes(h)));
}

for (const sp of Object.values(SPECIES)) {
  if (sp && sp.phase === 's' && sp.meltTempK && !sp.noMelt && !sp.dHFusJ) {
    sp.dHFusJ = getSpeciesFusionHeatJ(sp);
  }
  const meta = sp && ORGANIC_PROPERTY_METADATA[sp.id];
  if (meta) {
    Object.assign(sp, meta);
  }
}
