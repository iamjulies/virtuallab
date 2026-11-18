/**
 * Lightweight 12x10 2D diffusion & magnetic stir-bar vortex advection field for localized liquid concentration plumes.
 * Tracks localized phenolphthalein pink titration drops (before mixing/equivalence) and CuSO4 crystal dissolution streaks.
 */

const GRID_W = 12;
const GRID_H = 10;
const SIZE = GRID_W * GRID_H;

export function ensureConcField(vessel) {
  if (!vessel._concField) {
    vessel._concField = {
      w: GRID_W,
      h: GRID_H,
      pink: new Float32Array(SIZE),
      copper: new Float32Array(SIZE),
      nextPink: new Float32Array(SIZE),
      nextCopper: new Float32Array(SIZE),
      swirlAngleRad: 0,
    };
  }
  return vessel._concField;
}

/**
 * Inject a localized concentration plume at normalized coordinates inside the liquid body (normX, normY in [0..1]).
 */
export function injectLocalPlume(vessel, channel, normX = 0.5, normY = 0.14, strength = 0.95) {
  if (!vessel) return;
  const f = ensureConcField(vessel);
  const buf = channel === 'copper' ? f.copper : f.pink;
  const cx = Math.max(0, Math.min(GRID_W - 1, normX * (GRID_W - 1)));
  const cy = Math.max(0, Math.min(GRID_H - 1, normY * (GRID_H - 1)));
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      const d2 = (i - cx) * (i - cx) + (j - cy) * (j - cy);
      if (d2 <= 5.5) {
        const add = strength * Math.exp(-d2 * 0.65);
        const idx = j * GRID_W + i;
        buf[idx] = Math.min(1.0, buf[idx] + add);
      }
    }
  }
}

/**
 * Step 2D diffusion + gravity sinking + stir-bar vortex advection inside vessel liquid.
 */
export function stepLiquidConcField(vessel, dt) {
  const f = vessel?._concField;
  if (!f || dt <= 0) return;

  const rpm = vessel.hasStirBar ? Math.max(0, vessel.magStirRpm || 0) : 0;
  const stirNorm = rpm / 1200;
  const diffRate = (0.045 + stirNorm * 1.95) * Math.min(0.22, dt);
  const sinkRate = (rpm > 50 ? 0 : 0.085) * Math.min(0.2, dt);
  const fadeRate = (0.055 + stirNorm * 1.15) * dt;
  if (stirNorm > 0.02) {
    f.swirlAngleRad = (f.swirlAngleRad + (rpm / 60) * 2 * Math.PI * dt) % (Math.PI * 2);
  }

  const advectStep = (src, dst) => {
    const cx = (GRID_W - 1) * 0.5;
    const cy = (GRID_H - 1) * 0.5;
    const omega = stirNorm * 3.8 * Math.min(0.18, dt);

    for (let j = 0; j < GRID_H; j++) {
      for (let i = 0; i < GRID_W; i++) {
        const idx = j * GRID_W + i;
        let val = src[idx];
        if (val < 1e-4 && diffRate < 1e-4) {
          dst[idx] = 0;
          continue;
        }
        const left = src[j * GRID_W + Math.max(0, i - 1)];
        const right = src[j * GRID_W + Math.min(GRID_W - 1, i + 1)];
        const up = src[Math.max(0, j - 1) * GRID_W + i];
        const down = src[Math.min(GRID_H - 1, j + 1) * GRID_W + i];
        const lap = left + right + up + down - 4 * val;
        val += lap * diffRate;

        // Subtle gravity sinking plume when unstirred
        if (sinkRate > 0 && j > 0) {
          val += (up - val) * sinkRate;
        }

        // Swirl advection around tank center when magnetic stir bar is spinning
        if (omega > 0.002) {
          const dx = i - cx;
          const dy = j - cy;
          const si = Math.max(0, Math.min(GRID_W - 1, Math.round(i + dy * omega)));
          const sj = Math.max(0, Math.min(GRID_H - 1, Math.round(j - dx * omega)));
          const adv = src[sj * GRID_W + si];
          val = val * 0.62 + adv * 0.38;
        }

        val = Math.max(0, val * Math.max(0, 1 - fadeRate));
        dst[idx] = val < 0.003 ? 0 : Math.min(1, val);
      }
    }
  };

  advectStep(f.pink, f.nextPink);
  advectStep(f.copper, f.nextCopper);

  const tmpP = f.pink;
  f.pink = f.nextPink;
  f.nextPink = tmpP;
  const tmpC = f.copper;
  f.copper = f.nextCopper;
  f.nextCopper = tmpC;
}
