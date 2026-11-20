import { APPARATUS } from '../data/apparatus.js';
import { CONSTANTS } from '../data/constants.js';
import { SPECIES } from '../data/species.js';

const WAVE_N = 20;

/**
 * Estimate dimensionless liquid viscosity multiplier (>= 1.0) from vessel composition & temperature.
 * Pure water/ethanol ~ 1.0 (oscillates 3-4 cycles); conc. H2SO4 or concentrated brine/alkali -> 2.6..4.0 (overdamped).
 */
export function computeLiquidViscosityFactor(vessel) {
  if (!vessel?.moles) return 1.0;
  const m = vessel.moles;
  const nH2O = m.H2O_l || 0;
  const nH2SO4 = m.H2SO4_l || 0;
  const nAlk = (m.Na_aq || 0) + (m.K_aq || 0) + (m.OH_aq || 0);
  const nSol = nAlk + (m.SO4_2_aq || 0) + (m.HSO4_aq || 0) + (m.Cu2_aq || 0) + (m.Cl_aq || 0);
  const totAq = Math.max(1e-5, nH2O + nH2SO4);
  const acidFrac = nH2SO4 / totAq;
  const solRatio = nSol / totAq;
  const T = Math.max(240, vessel.tempK || CONSTANTS.T_STD_K);
  const tempFactor = Math.pow(298.15 / Math.min(420, T), 0.55);
  return Math.max(0.75, Math.min(4.2, (1.0 + acidFrac * 2.5 + solRatio * 1.15) * tempFactor));
}

/**
 * Lazily allocate or return the 1D 20-node Shallow-Water spring-damper wave state on a vessel.
 */
export function ensureSurfaceWave(vessel) {
  if (!vessel._surfaceWave || vessel._surfaceWave.n !== WAVE_N) {
    vessel._surfaceWave = {
      n: WAVE_N,
      h: new Float32Array(WAVE_N),
      v: new Float32Array(WAVE_N),
    };
  }
  return vessel._surfaceWave;
}

/**
 * Inject a localized surface impulse (from droplets, pour stream, or fizzing gas bubbles).
 */
export function applySurfaceImpulse(vessel, normX = 0.5, impulse = -0.35) {
  if (!vessel || vessel.isFrozenSolid || vessel.isShattered) return;
  const sw = ensureSurfaceWave(vessel);
  const centerIdx = Math.max(0, Math.min(WAVE_N - 1, Math.round(normX * (WAVE_N - 1))));
  for (let i = 0; i < WAVE_N; i++) {
    const d = i - centerIdx;
    if (Math.abs(d) <= 3) {
      sw.v[i] = Math.max(-28, Math.min(28, sw.v[i] + impulse * 18.0 * Math.exp(-(d * d) * 0.45)));
    }
  }
}

/**
 * Step 1D spring-damper shallow-water surface oscillations with viscosity-driven damping and zero mean height drift.
 */
export function stepVesselSurfaceWaves(vessel, dt, horizAccel = 0, angularVel = 0) {
  if (!vessel || dt <= 0 || dt > 0.2) return;
  const sw = ensureSurfaceWave(vessel);
  const h = sw.h;
  const v = sw.v;
  const visc = computeLiquidViscosityFactor(vessel);
  const kSpring = 36.0 / Math.max(0.75, Math.sqrt(visc));
  const cSpread = 58.0 / Math.max(0.85, Math.pow(visc, 0.3));
  const damp = 1.45 * Math.pow(visc, 1.35);

  const clampedAcc = Math.max(-180, Math.min(180, horizAccel));
  const clampedAng = Math.max(-12, Math.min(12, angularVel));

  let maxMag = 0;
  let meanH = 0;
  for (let i = 0; i < WAVE_N; i++) {
    const left = i > 0 ? h[i - 1] : h[i];
    const right = i < WAVE_N - 1 ? h[i + 1] : h[i];
    const spreadForce = (left + right - 2 * h[i]) * cSpread;
    const normCenter = (i / (WAVE_N - 1)) * 2 - 1; // [-1 .. +1]
    const inertialForce = -normCenter * (clampedAcc * 0.24 + clampedAng * 22.0);
    const acc = -kSpring * h[i] + spreadForce + inertialForce - damp * v[i];
    v[i] += acc * dt;
    h[i] += v[i] * dt;
    h[i] = Math.max(-8.5, Math.min(8.5, h[i]));
    meanH += h[i];
    maxMag = Math.max(maxMag, Math.abs(h[i]), Math.abs(v[i]) * 0.05);
  }
  // Enforce exact zero-mean surface displacement so average liquid level / volume stays strictly conserved
  meanH /= WAVE_N;
  for (let i = 0; i < WAVE_N; i++) h[i] -= meanH;
  sw.active = maxMag > 0.015;
}

const CLUMP_HYGROSCOPIC_SET = new Set([
  'NaOH_s', 'KOH_s', 'CaO_s', 'CaCl2_s', 'MgCl2_s', 'FeCl3_s', 'Na2O_s', 'K2O_s', 'K2O2_s',
]);

/**
 * Classify a solid species into its 4 physical solid behavior modes:
 * 1: 'free_granule', 2: 'hygroscopic_clump', 3: 'buoyant_float', 4: 'reactive_shrinking'
 */
export function classifySolidBehavior(spId, vessel = null) {
  const sp = SPECIES[spId];
  if (!sp) return { group: 1, label: 'free_granule', density: 2.5, sticky: false, buoyant: false };
  const density = sp.density || 2.5;
  const nWater = vessel?.moles?.H2O_l || 0;
  const isDamp = nWater > 1e-4 && nWater < 0.08;
  if (density < 1.02) {
    return { group: 3, label: 'buoyant_float', density, sticky: false, buoyant: true };
  }
  if (CLUMP_HYGROSCOPIC_SET.has(spId) || (isDamp && Boolean(vessel?.groundPowderMap?.[spId]))) {
    return { group: 2, label: 'hygroscopic_clump', density, sticky: true, buoyant: false };
  }
  if (sp.isPrecipitate || sp.PhaseShrink) {
    return { group: 4, label: 'reactive_shrinking', density, sticky: false, buoyant: false };
  }
  return { group: 1, label: 'free_granule', density, sticky: false, buoyant: false };
}

/**
 * Lightweight rigid-body particle solver (5..28 physical grains/clumps per vessel) supporting:
 * - Tilted bottom gravity sliding & gentle restitution bounce inside glass wall boundaries
 * - Hygroscopic / moist sticky clumping (high friction & cohesive clustering)
 * - Archimedes buoyancy (rho_solid vs rho_liquid: Na/K/ice float at surfaceY, Zn/Fe/CaCO3 sink)
 * - Stoichiometric dissolution / reaction radius shrinking (r ~ (n / n0)^(1/3))
 */
export function stepVesselSolidBodies(vessel, hasLiquid, surfaceRatioFromBottom, liqDensityGml, dt) {
  if (!vessel?.moles || vessel.isShattered) return;
  const spec = APPARATUS[vessel.typeId] || APPARATUS.beaker_250;
  const w = spec.width || 72;
  const h = spec.height || 100;
  const halfInnerW = Math.max(8, (spec.geometry?.bodyMaxRadiusCm ? w * 0.36 : w * 0.38));
  const halfInnerH = Math.max(12, h * 0.42);
  const surfaceOffsetY = halfInnerH - surfaceRatioFromBottom * (halfInnerH * 1.85);

  const bodies = (vessel._solidBodies = vessel._solidBodies || []);
  const trackMap = (vessel._solidInitMol = vessel._solidInitMol || {});

  // 1. Reconcile physical body list against current stoichiometric moles[spId]
  const activeSolids = [];
  for (const [spId, n] of Object.entries(vessel.moles)) {
    const sp = SPECIES[spId];
    if (!sp || sp.phase !== 's' || n <= 1e-8) {
      delete trackMap[spId];
      continue;
    }
    if (!trackMap[spId] || n > trackMap[spId]) {
      trackMap[spId] = n;
    }
    activeSolids.push([spId, sp, n]);
  }

  // Filter dissolved/reacted species cleanly
  for (let i = bodies.length - 1; i >= 0; i--) {
    const b = bodies[i];
    const nCur = vessel.moles[b.spId] || 0;
    if (nCur <= 1e-8) {
      bodies.splice(i, 1);
      continue;
    }
    const frac = Math.max(0.05, Math.min(1.0, nCur / Math.max(1e-8, trackMap[b.spId] || nCur)));
    b.r = b.baseR * Math.cbrt(frac);
    b.behavior = classifySolidBehavior(b.spId, vessel);
    if (b.r < 0.75) {
      bodies.splice(i, 1);
    }
  }

  // Spawn representative discrete grains (4..8 per active solid species, capped <= 24 total)
  for (const [spId, sp, n] of activeSolids) {
    const existing = bodies.filter((b) => b.spId === spId).length;
    const isFine = Boolean(vessel.groundPowderMap?.[spId]) || (vessel.particleCounts?.[spId] || 0) >= 60;
    const desired = Math.min(isFine ? 7 : 5, Math.max(2, Math.round(2 + Math.sqrt(n * sp.molarMass) * 1.4)));
    if (existing < desired && bodies.length < 24) {
      const behavior = classifySolidBehavior(spId, vessel);
      const baseR = isFine ? 2.1 + Math.random() * 0.9 : 2.8 + Math.random() * 1.4;
      for (let k = existing; k < desired && bodies.length < 24; k++) {
        bodies.push({
          spId,
          x: (Math.random() - 0.5) * halfInnerW * 1.2,
          y: behavior.buoyant && hasLiquid ? surfaceOffsetY : halfInnerH - baseR - Math.random() * 6,
          vx: (Math.random() - 0.5) * 14,
          vy: 0,
          angle: Math.random() * Math.PI * 2,
          baseR,
          r: baseR,
          color: sp.color || '#cbd5e1',
          highlight: sp.highlightColor || '#ffffff',
          behavior,
        });
      }
    }
  }

  if (bodies.length === 0 || dt <= 0) return;

  // Gravity projected into tilted vessel local frame
  const dir = vessel.tiltDir < 0 ? -1 : 1;
  const effTilt = ((dir * (vessel.tiltDeg || 0) * Math.PI) / 180) + (vessel.landingTilt || 0);
  const gBase = 240; // px/s^2 scaled to local vessel coords
  const gx = Math.sin(effTilt) * gBase * (vessel.isInverted ? -1 : 1);
  const gyBase = Math.cos(effTilt) * gBase * (vessel.isInverted ? -1 : 1);

  const invWaterTopY = -halfInnerH + halfInnerH * 1.85 * Math.max(0, Math.min(1, surfaceRatioFromBottom));
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    let fy = gyBase;
    const inLiquid = vessel.isInverted ? b.y <= invWaterTopY : b.y >= surfaceOffsetY;
    if (hasLiquid && inLiquid) {
      // Archimedes buoyancy: F_net = g * (1 - rho_liq / rho_solid)
      const rhoS = Math.max(0.25, b.behavior.density || 2.5);
      const buoyRatio = 1.0 - liqDensityGml / rhoS;
      fy = gyBase * buoyRatio;
      // Fluid drag (heavier damping inside water/acid, light lateral fizz jitter for Na/K)
      b.vx *= Math.exp(-3.8 * dt);
      b.vy *= Math.exp(-4.6 * dt);
      if (b.behavior.buoyant && (b.spId === 'Na_s' || b.spId === 'K_s')) {
        b.vx += (Math.random() - 0.5) * 42 * dt;
      }
    }

    b.vx += gx * dt;
    b.vy += fy * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.angle += b.vx * 0.04 * dt;

    // Clamping inside inner walls with friction & gentle restitution
    const friction = b.behavior.sticky ? 0.55 : 0.88;
    const bounce = b.behavior.sticky ? 0.05 : 0.25;
    const neckHalfW = Math.max(9, (spec.neckRadius || spec.width * 0.24) * 0.92);
    const localMaxW =
      vessel.isInverted && b.y < 0
        ? neckHalfW + (halfInnerW - neckHalfW) * Math.max(0, 1 + b.y / Math.max(12, halfInnerH * 0.65))
        : halfInnerW;
    if (b.x < -localMaxW + b.r) {
      b.x = -localMaxW + b.r;
      b.vx = Math.abs(b.vx) * bounce;
      b.vy *= friction;
    } else if (b.x > localMaxW - b.r) {
      b.x = localMaxW - b.r;
      b.vx = -Math.abs(b.vx) * bounce;
      b.vy *= friction;
    }
    if (b.y > halfInnerH - b.r) {
      b.y = halfInnerH - b.r;
      b.vy = -Math.abs(b.vy) * bounce;
      b.vx *= friction;
    } else if (b.y < -halfInnerH + b.r) {
      b.y = -halfInnerH + b.r;
      b.vy = Math.abs(b.vy) * bounce;
    }

    // Group 2 sticky hygroscopic clustering & lightweight grain separation
    for (let j = i + 1; j < bodies.length; j++) {
      const o = bodies[j];
      const dx = o.x - b.x;
      const dy = o.y - b.y;
      const dist = Math.hypot(dx, dy);
      const minD = b.r + o.r;
      if (dist > 1e-4 && dist < minD * (b.behavior.sticky && o.behavior.sticky ? 2.1 : 1.0)) {
        const nx = dx / dist;
        const ny = dy / dist;
        if (dist < minD) {
          const push = (minD - dist) * 0.5;
          b.x -= nx * push;
          b.y -= ny * push;
          o.x += nx * push;
          o.y += ny * push;
        } else if (b.behavior.sticky && o.behavior.sticky) {
          // Gentle cohesive clustering force pulls damp hygroscopic pellets into 1-3 clumps
          const coh = 18.0 * dt;
          b.vx = (b.vx + o.vx) * 0.5 + nx * coh;
          o.vx = (b.vx + o.vx) * 0.5 - nx * coh;
          b.vy = (b.vy + o.vy) * 0.5 + ny * coh;
          o.vy = (b.vy + o.vy) * 0.5 - ny * coh;
        }
      }
    }
  }
}
