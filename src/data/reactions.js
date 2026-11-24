/**
 * Reaction Network Rules for virlab_beta_v1.
 * Every reaction operates on moles (mol), temperature (K), and aqueous concentrations (mol/L).
 */
import { HYDROCARBON_REACTIONS } from './organic/hydrocarbons.js';
import { OXYGEN_REACTIONS } from './organic/oxygen_compounds.js';
import { NITROGEN_BIO_REACTIONS } from './organic/nitrogen_bio.js';

import { DISSOLUTION_REACTIONS } from './reactions/dissolution.js';
import { ACID_BASE_IONIC_REACTIONS } from './reactions/acid_base_ionic.js';
import { METALS_OXIDES_REACTIONS } from './reactions/metals_oxides.js';
import { THERMAL_H2SO4_REACTIONS } from './reactions/thermal_h2so4.js';
import { HALOGEN_SULFUR_REDOX_REACTIONS } from './reactions/halogen_sulfur_redox.js';

export const REACTIONS = [
  ...DISSOLUTION_REACTIONS,
  ...ACID_BASE_IONIC_REACTIONS,
  ...METALS_OXIDES_REACTIONS,
  ...THERMAL_H2SO4_REACTIONS,
  ...HALOGEN_SULFUR_REDOX_REACTIONS,
  ...HYDROCARBON_REACTIONS,
  ...OXYGEN_REACTIONS,
  ...NITROGEN_BIO_REACTIONS,
];
