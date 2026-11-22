/**
 * Shared Chemistry Core Helpers (extracted cleanly from chemistry.js in Prompt 68).
 */
import { CONSTANTS } from '../data/constants.js';

/**
 * Effective O2 partial pressure (bar) inside a vessel combining pure O2 headspace + ambient air.
 */
export function getVesselEffectiveO2Bar(vessel, env) {
  const headO2 = Math.max(0, vessel.headspaceGasMoles?.O2_g || 0);
  let pO2 = 0;
  if (headO2 > 1e-8) {
    // Approximate O2 partial contribution from headspace accumulation inside standard flask (~0.02..0.25 L)
    pO2 += Math.min(2.2, headO2 * 180.0);
  }
  if ((env?.atmosphereMode || 'air') === 'air') {
    const pEnv = env?.pressureBar || CONSTANTS.P_STD_BAR;
    const purgeFrac = vessel.airO2PurgeFrac ?? 1.0;
    const isClosedLid = vessel.lidState === 'closed';
    if (!vessel.isStoppered && !vessel.isInverted && !isClosedLid) {
      pO2 += CONSTANTS.AIR_O2_FRAC * pEnv * purgeFrac;
    } else if ((vessel.sealedAirO2Moles || 0) > 1e-7) {
      pO2 += CONSTANTS.AIR_O2_FRAC * pEnv * Math.min(1, (vessel.sealedAirO2Moles || 0) / 0.0015);
    }
  }
  return Math.max(0, Math.min(3.0, pO2));
}

/**
 * Apply a single equilibrium extent dXi across stoichiometries, trim <1e-13 dust,
 * record active reaction metadata when visible, and return enthalpy (J).
 */
export function applyEquilibriumShift({
  moles,
  dXi,
  deltas,
  heatPerMolJ,
  dt,
  activeReactions,
  buildMeta,
  logThresholdRate = 1e-4,
}) {
  if (Math.abs(dXi) <= 1e-13) return 0;
  for (const [spId, coeff] of Object.entries(deltas)) {
    const next = (moles[spId] || 0) + coeff * dXi;
    if (next < 1e-13) {
      delete moles[spId];
    } else {
      moles[spId] = next;
    }
  }
  const rateMolS = Math.abs(dXi) / Math.max(1e-4, dt);
  if (rateMolS > logThresholdRate && buildMeta) {
    activeReactions.push({
      ...buildMeta(dXi),
      rateMolS,
      vigorousGas: false,
      dXi: Math.abs(dXi),
    });
  }
  return heatPerMolJ * dXi;
}

/**
 * Classify Sulfuric acid mass fraction & concentration tier:
 * low (<20%), mid (20-65%), conc (65-90%), conc_98 (>=90%).
 */
export function computeSulfuricAcidState(moles) {
  if (!moles) return { nAcidEq: 0, w: 0, tier: 'none' };
  const nH2SO4L = moles.H2SO4_l || 0;
  const nSO4Tot = (moles.SO4_2_aq || 0) + (moles.HSO4_aq || 0);
  const nHTot = (moles.H_aq || 0) + (moles.HSO4_aq || 0);
  const nH2SO4Aq = Math.min(nSO4Tot, nHTot * 0.5);
  const nAcidEq = nH2SO4L + nH2SO4Aq;
  if (nAcidEq <= 1e-8) return { nAcidEq: 0, w: 0, tier: 'none' };
  const mAcidG = nAcidEq * CONSTANTS.M_H2SO4;
  const mWaterG = (moles.H2O_l || 0) * CONSTANTS.M_H2O;
  const denom = mAcidG + mWaterG;
  const w = denom > 1e-9 ? mAcidG / denom : 1.0;
  const tier = w >= 0.90 ? 'conc_98' : w >= 0.65 ? 'conc' : w >= 0.20 ? 'mid' : 'low';
  return { nAcidEq, w, tier };
}
