import { CONSTANTS, waterVaporPressureBar } from '../data/constants.js';
import { APPARATUS } from '../data/apparatus.js';
import { computeLiquidVolumeL, computeSolidVolumeMl } from './equilibrium.js';

/**
 * Compute syringe collected gas volume (mL) using Ideal Gas Law: V = nRT / P.
 */
export function computeSyringeGasVolumeMl(syringe, env) {
  const totalMol =
    (syringe.gasMoles.H2_g || 0) +
    (syringe.gasMoles.O2_g || 0) +
    (syringe.gasMoles.H2O_g || 0);
  if (totalMol <= 1e-12) return 0;

  const volL = (totalMol * CONSTANTS.R_L_BAR_MOL_K * env.tempK) / Math.max(0.05, env.pressureBar);
  return volL * 1000;
}

/**
 * Route generated gases from a vessel according to its boundary state:
 * - Open: escapes to room (mass lost)
 * - Connected to Gas syringe: permanent gases flow into syringe (V = nRT/P)
 * - Stoppered closed: accumulates in headspace, building pressure P_in -> pop/shatter
 */
export function stepVesselGasAndPressure(vessel, gasProduced, steamProducedMol, env, getApparatusById) {
  const spec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
  const events = [];

  const totalH2 = gasProduced.H2_g || 0;
  const totalO2 = gasProduced.O2_g || 0;
  const totalSteam = (gasProduced.H2O_g || 0) + (steamProducedMol || 0);

  if (vessel.isShattered) {
    // Open to atmosphere after shattering
    vessel.escapedGasMoles.H2_g = (vessel.escapedGasMoles.H2_g || 0) + totalH2;
    vessel.escapedGasMoles.O2_g = (vessel.escapedGasMoles.O2_g || 0) + totalO2;
    vessel.escapedGasMoles.H2O_g = (vessel.escapedGasMoles.H2O_g || 0) + totalSteam;
    vessel.internalPressureBar = env.pressureBar;
    return events;
  }

  // Compute vessel headspace in Liters
  const liqMl = computeLiquidVolumeL(vessel.moles, vessel.tempK) * 1000;
  const solMl = computeSolidVolumeMl(vessel.moles);
  const headspaceL = Math.max(0.015, (spec.maxVolumeMl - Math.min(spec.maxVolumeMl * 0.94, liqMl + solMl)) / 1000);

  if (!vessel.isStoppered) {
    // Open system: all generated gases escape directly to the room
    vessel.escapedGasMoles.H2_g = (vessel.escapedGasMoles.H2_g || 0) + totalH2;
    vessel.escapedGasMoles.O2_g = (vessel.escapedGasMoles.O2_g || 0) + totalO2;
    vessel.escapedGasMoles.H2O_g = (vessel.escapedGasMoles.H2O_g || 0) + totalSteam;
    vessel.internalPressureBar = env.pressureBar;
    return events;
  }

  // Connected to a Gas Syringe via rubber tubing
  if (vessel.connectedSyringeId) {
    const syringe = getApparatusById(vessel.connectedSyringeId);
    if (syringe && !syringe.isBroken) {
      const syringeSpec = APPARATUS[syringe.typeId];
      const currentVolMl = computeSyringeGasVolumeMl(syringe, env);

      if (currentVolMl < syringeSpec.maxVolumeMl * 0.995) {
        syringe.gasMoles.H2_g = (syringe.gasMoles.H2_g || 0) + totalH2;
        syringe.gasMoles.O2_g = (syringe.gasMoles.O2_g || 0) + totalO2;
        // Steam only stays gaseous in syringe if ambient >= boiling point
        if (env.tempK >= 372.5) {
          syringe.gasMoles.H2O_g = (syringe.gasMoles.H2O_g || 0) + totalSteam;
        } else {
          vessel.escapedGasMoles.H2O_g = (vessel.escapedGasMoles.H2O_g || 0) + totalSteam;
        }
        vessel.internalPressureBar = env.pressureBar;
        return events;
      }
      // Syringe maxed out -> remaining gas pressurizes vessel!
    }
  }

  // Stoppered closed (or syringe bottomed out) -> gas accumulates in headspace
  if (vessel.sealedAirMoles === null || vessel.sealedAirMoles === undefined) {
    vessel.sealedAirMoles = (env.pressureBar * headspaceL) / (CONSTANTS.R_L_BAR_MOL_K * vessel.tempK);
  }

  vessel.headspaceGasMoles.H2_g = (vessel.headspaceGasMoles.H2_g || 0) + totalH2;
  vessel.headspaceGasMoles.O2_g = (vessel.headspaceGasMoles.O2_g || 0) + totalO2;
  vessel.headspaceGasMoles.H2O_g = (vessel.headspaceGasMoles.H2O_g || 0) + totalSteam;

  const extraGasMol =
    (vessel.headspaceGasMoles.H2_g || 0) +
    (vessel.headspaceGasMoles.O2_g || 0) +
    (vessel.headspaceGasMoles.H2O_g || 0);

  const partialAirAndGas =
    ((vessel.sealedAirMoles + extraGasMol) * CONSTANTS.R_L_BAR_MOL_K * vessel.tempK) / headspaceL;
  const hasWater = (vessel.moles.H2O_l || 0) > 1e-6;
  const vaporContribution = hasWater ? Math.max(0, waterVaporPressureBar(vessel.tempK) - 0.03) : 0;

  vessel.internalPressureBar = partialAirAndGas + vaporContribution;

  // Check overpressure thresholds
  if (spec.shatterPressureBar && vessel.internalPressureBar >= spec.shatterPressureBar) {
    vessel.isShattered = true;
    vessel.isStoppered = false;
    vessel.connectedSyringeId = null;
    events.push({ type: 'shatter', vesselId: vessel.id });
  } else if (spec.popPressureBar && vessel.internalPressureBar >= spec.popPressureBar) {
    vessel.isStoppered = false;
    vessel.connectedSyringeId = null;
    // Vent accumulated headspace gas
    for (const g of ['H2_g', 'O2_g', 'H2O_g']) {
      vessel.escapedGasMoles[g] = (vessel.escapedGasMoles[g] || 0) + (vessel.headspaceGasMoles[g] || 0);
      vessel.headspaceGasMoles[g] = 0;
    }
    vessel.sealedAirMoles = null;
    vessel.internalPressureBar = env.pressureBar;
    events.push({ type: 'stopper_pop', vesselId: vessel.id });
  }

  return events;
}
