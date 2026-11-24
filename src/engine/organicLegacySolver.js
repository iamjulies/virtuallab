/**
 * Classic Organic Chemistry Solver Orchestrator (Refactor 81).
 * Modularized into src/engine/solvers/organic/*.js
 */
import { CONSTANTS } from '../data/constants.js';
import { stepOrganicAlcoholsAcidsCarbonyl } from './solvers/organic/alcohols_acids_carbonyl.js';
import { stepOrganicArenesPhenol } from './solvers/organic/arenes_phenol.js';
import { stepOrganicEstersLipids } from './solvers/organic/esters_lipids.js';
import { stepOrganicHydrocarbonsPolymers } from './solvers/organic/hydrocarbons_polymers.js';

export function stepOrganicChemistry(vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob = 1, options = {}) {
  const moles = vessel.moles;
  const T = vessel.tempK || CONSTANTS.T_STD_K;
  const orgMob = vessel.isFrozenSolid ? 0 : 1;
  const uvOn = Boolean(options?.uvLight || vessel.uvExposureActive);
  let heatJ = 0;

  const consumeSpecies = (id, amt) => {
    moles[id] = Math.max(0, (moles[id] || 0) - amt);
    if (moles[id] < 1e-13) delete moles[id];
  };
  const pushRxn = (id, equation, nameVi, nameEn, descVi, descEn, dXi, vigorousGas = false) => {
    activeReactions.push({ id, equation, nameVi, nameEn, descVi, descEn, rateMolS: dXi / dt, vigorousGas, dXi });
  };
  const hs63 = vessel.headspaceGasMoles || {};
  const getG = (id) => (moles[id] || 0) + (hs63[id] || 0);
  const takeG = (id, amt) => {
    const mUse = Math.min(moles[id] || 0, amt);
    if (mUse > 0) consumeSpecies(id, mUse);
    const rem = amt - mUse;
    if (rem > 1e-13 && hs63[id] > 0) {
      hs63[id] = Math.max(0, hs63[id] - rem);
      if (hs63[id] < 1e-13) delete hs63[id];
    }
  };

  const ctx = {
    vessel, liquidVolL, dt, activeReactions, gasProduced, iceMob, options,
    moles, T, orgMob, uvOn, hs63, getG, takeG,
    consumeSpecies, pushRxn,
  };

  heatJ += stepOrganicAlcoholsAcidsCarbonyl(ctx);
  heatJ += stepOrganicArenesPhenol(ctx);
  heatJ += stepOrganicEstersLipids(ctx);
  heatJ += stepOrganicHydrocarbonsPolymers(ctx);

  return heatJ;
}
