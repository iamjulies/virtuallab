import { APPARATUS } from '../data/apparatus.js';
import { computeLiquidVolumeL, computeSolidVolumeMl } from '../engine/equilibrium.js';

export class ParticleSystem {
  constructor() {
    this.particles = [];
  }

  clear() {
    this.particles = [];
  }

  /**
   * Spawn bubbles, steam, sparks, and fuming wisps for a vessel.
   */
  emitForVessel(vessel, metrics, dt) {
    if (vessel.isShattered) return;
    const spec = APPARATUS[vessel.typeId];
    if (!spec) return;

    const liqMl = computeLiquidVolumeL(vessel.moles, vessel.tempK) * 1000;
    const solMl = computeSolidVolumeMl(vessel.moles);
    const fillFrac = Math.min(0.92, (liqMl + solMl) / spec.maxVolumeMl);

    const interiorH = spec.height - 16;
    const bottomY = vessel.y + spec.height / 2 - 6;
    const surfaceY = bottomY - fillFrac * interiorH;
    const halfW = spec.shape === 'erlenmeyer'
      ? Math.max(18, (spec.width * 0.42) * (1 - fillFrac * 0.55))
      : spec.width * 0.36;

    // 1. Gas bubbles (H2 / O2) inside liquid
    const gasIntensity = metrics.gasRateH2 + metrics.gasRateO2;
    if (gasIntensity > 1e-6 && liqMl > 0.2) {
      const spawnRate = Math.min(95, 10 + Math.log10(1 + gasIntensity * 5000) * 28);
      const count = Math.floor(spawnRate * dt) + (Math.random() < (spawnRate * dt) % 1 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const fromNa = metrics.naActive && Math.random() < 0.7;
        const px = fromNa
          ? vessel.x + (vessel.naPosRatio - 0.5) * halfW * 1.7 + (Math.random() - 0.5) * 12
          : vessel.x + (Math.random() - 0.5) * halfW * 1.4;
        const py = fromNa
          ? surfaceY + 4 + Math.random() * 8
          : bottomY - 4 - Math.random() * Math.max(4, (bottomY - surfaceY) * 0.25);

        this.particles.push({
          kind: 'bubble',
          x: px,
          y: py,
          vx: (Math.random() - 0.5) * 14,
          vy: -(38 + Math.random() * 45),
          r: 1.4 + Math.random() * 2.4,
          minY: surfaceY + 1,
          life: 0,
          maxLife: 1.5,
          color: 'rgba(255,255,255,0.72)',
        });
      }
    }

    // 2. Boiling bottom bubbles
    if (metrics.isBoiling && liqMl > 0.5) {
      const boilCount = Math.floor(42 * dt) + (Math.random() < (42 * dt) % 1 ? 1 : 0);
      for (let i = 0; i < boilCount; i++) {
        this.particles.push({
          kind: 'bubble',
          x: vessel.x + (Math.random() - 0.5) * halfW * 1.5,
          y: bottomY - 3,
          vx: (Math.random() - 0.5) * 12,
          vy: -(55 + Math.random() * 55),
          r: 1.8 + Math.random() * 3.0,
          minY: surfaceY + 1,
          life: 0,
          maxLife: 1.4,
          color: 'rgba(240,249,255,0.8)',
        });
      }
    }

    // 3. Steam / Vapor mist (hot water, vigorous Na, or open conc HCl)
    const nH = vessel.moles.H_aq || 0;
    const hConc = liqMl > 1 ? nH / (liqMl / 1000) : 0;
    const isAcidFuming = !vessel.isStoppered && hConc > 7.0;
    const vaporIntensity =
      (metrics.isBoiling ? 1.0 : 0) +
      (metrics.naActive ? 0.9 : 0) +
      Math.max(0, (vessel.tempK - 325) / 50) * 0.45 +
      (isAcidFuming ? 0.22 : 0);

    if (vaporIntensity > 0.08 && !vessel.isStoppered) {
      const mistRate = Math.min(45, vaporIntensity * 24);
      const count = Math.floor(mistRate * dt) + (Math.random() < (mistRate * dt) % 1 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const startY = metrics.naActive ? surfaceY - 2 : vessel.y - spec.height / 2 + 8;
        this.particles.push({
          kind: 'mist',
          x: vessel.x + (Math.random() - 0.5) * spec.neckRadius * 0.85,
          y: startY,
          vx: (Math.random() - 0.5) * 18,
          vy: -(22 + Math.random() * 26),
          r: 5 + Math.random() * 7,
          life: 0,
          maxLife: 1.1 + Math.random() * 0.6,
          color: 'rgba(226, 232, 240, 0.35)',
        });
      }
    }

    // 4. Sodium molten yellow-orange flame & sparks!
    if (metrics.naActive && (vessel.moles.Na_s || 0) > 1e-7) {
      const naX = vessel.x + (vessel.naPosRatio - 0.5) * halfW * 1.55;
      const intensity = Math.min(1.5, metrics.naRate * 450 + (vessel.tempK > 335 ? 0.5 : 0.2));
      const sparkProb = Math.min(0.95, 0.28 + intensity * 0.55);

      if (Math.random() < sparkProb) {
        this.particles.push({
          kind: 'flame',
          x: naX + (Math.random() - 0.5) * 6,
          y: surfaceY - 2,
          vx: (Math.random() - 0.5) * 20,
          vy: -(24 + Math.random() * 28),
          r: 4 + Math.random() * 5,
          life: 0,
          maxLife: 0.22 + Math.random() * 0.16,
          color: Math.random() < 0.5 ? '#fbbf24' : '#f97316',
        });
      }

      if (intensity > 0.45 && Math.random() < 0.45) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
        const spd = 45 + Math.random() * 85;
        this.particles.push({
          kind: 'spark',
          x: naX,
          y: surfaceY - 3,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd,
          r: 1.6 + Math.random() * 1.4,
          life: 0,
          maxLife: 0.35 + Math.random() * 0.25,
          color: '#fef08a',
        });
      }
    }
  }

  emitBurst(type, x, y) {
    const count = type === 'shatter' ? 28 : 16;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.3;
      const spd = 60 + Math.random() * 130;
      this.particles.push({
        kind: type === 'shatter' ? 'shard' : 'mist',
        x,
        y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - 45,
        r: type === 'shatter' ? 3 + Math.random() * 4 : 6 + Math.random() * 6,
        life: 0,
        maxLife: 0.7 + Math.random() * 0.5,
        color: type === 'shatter' ? 'rgba(186, 230, 253, 0.85)' : 'rgba(241, 245, 249, 0.5)',
      });
    }
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
        continue;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (p.kind === 'bubble') {
        p.vx += (Math.random() - 0.5) * 30 * dt;
        if (p.y <= p.minY) {
          this.particles.splice(i, 1);
        }
      } else if (p.kind === 'mist') {
        p.r += 10 * dt;
        p.vx *= 0.98;
      } else if (p.kind === 'spark' || p.kind === 'shard') {
        p.vy += 210 * dt; // Gravity
      }
    }

    if (this.particles.length > 750) {
      this.particles.splice(0, this.particles.length - 750);
    }
  }

  render(ctx) {
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      const alpha = 1 - t;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

      if (p.kind === 'bubble') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      } else if (p.kind === 'mist') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      } else if (p.kind === 'flame') {
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.r * 0.65, p.r * 1.4, 0, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      } else if (p.kind === 'spark') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      } else if (p.kind === 'shard') {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.life * 7);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      }

      ctx.restore();
    }
  }
}
