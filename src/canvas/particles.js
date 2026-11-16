import { APPARATUS } from '../data/apparatus.js';
import { computeLiquidVolumeL, computeSolidVolumeMl } from '../engine/equilibrium.js';
import { computeVesselFluidGeometry } from './vesselRenderer.js';

const BENCH_FLOOR_Y = 482;

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
    const geom = computeVesselFluidGeometry(spec, vessel.y, liqMl + solMl);
    const bottomY = geom.interiorBottom;
    const surfaceY = geom.surfaceY;
    const halfW = Math.max(6, geom.surfaceHalfWPx || spec.width * 0.34);

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

    // 3. Steam / HCl acid fuming / Cl2 greenish-yellow gas mist
    const nH = vessel.moles.H_aq || 0;
    const nCl = vessel.moles.Cl_aq || 0;
    const hConc = liqMl > 1 ? Math.min(nH, nCl) / (liqMl / 1000) : 0;
    const hasCl2 = (metrics.gasRateCl2 || 0) > 1e-6;
    const hasHClFume = !vessel.isStoppered && (hConc > 6.5 || (metrics.gasRateHCl || 0) > 5e-5);
    const vaporIntensity =
      (metrics.isBoiling ? 1.0 : 0) +
      (metrics.naActive ? 0.9 : 0) +
      Math.max(0, (vessel.tempK - 325) / 50) * 0.45 +
      (hasHClFume ? 0.35 : 0) +
      (hasCl2 ? 0.55 : 0);

    if (vaporIntensity > 0.08 && !vessel.isStoppered) {
      const mistRate = Math.min(45, vaporIntensity * 24);
      const count = Math.floor(mistRate * dt) + (Math.random() < (mistRate * dt) % 1 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const startY = metrics.naActive ? surfaceY - 2 : vessel.y - spec.height / 2 + 8;
        const mistColor = hasCl2
          ? 'rgba(217, 249, 157, 0.45)'
          : hasHClFume
          ? 'rgba(226, 232, 240, 0.44)'
          : 'rgba(226, 232, 240, 0.35)';
        this.particles.push({
          kind: 'mist',
          x: vessel.x + (Math.random() - 0.5) * spec.neckRadius * 0.85,
          y: startY,
          vx: (Math.random() - 0.5) * 18,
          vy: -(22 + Math.random() * 26),
          r: 5 + Math.random() * 7,
          life: 0,
          maxLife: 1.1 + Math.random() * 0.6,
          color: mistColor,
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

    // 5. Gradual continuous rim overflow droplets cascading down onto the bench
    if ((metrics.overflowRateMlS || 0) > 0.5) {
      const rate = Math.min(75, 18 + metrics.overflowRateMlS * 0.45);
      const dropCount = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
      const topY = vessel.y - spec.height / 2 + 2;
      const rimX = vessel.x - (spec.shape === 'erlenmeyer' ? spec.neckRadius || 18.5 : spec.width / 2);
      const col = metrics.overflowColor || 'rgba(186, 230, 253, 0.85)';

      for (let i = 0; i < dropCount; i++) {
        const side = Math.random() < 0.72 ? -1 : 1; // Mainly from left pouring spout + minor right lip
        const spawnX = side < 0 ? rimX - 2 : vessel.x + (vessel.x - rimX);
        this.particles.push({
          kind: 'drip',
          x: spawnX + (Math.random() - 0.5) * 3,
          y: topY + Math.random() * 4,
          vx: side * (16 + Math.random() * 28),
          vy: 15 + Math.random() * 35,
          r: 2.2 + Math.random() * 2.2,
          life: 0,
          maxLife: 1.05 + Math.random() * 0.35,
          color: col,
          splashed: false,
        });
      }
    }
  }

  emitBurst(type, x, y, meta = null) {
    if (type === 'overflow') return;

    const isExpl = type === 'explosion';
    const isShatter = type === 'shatter' || isExpl;

    if (isShatter) {
      // 1. Blinding shock flash + expanding pressure ring(s)
      this.particles.push({
        kind: 'flash',
        x,
        y,
        vx: 0,
        vy: 0,
        r: isExpl ? 92 : 52,
        life: 0,
        maxLife: isExpl ? 0.24 : 0.16,
        color: isExpl ? '#fef08a' : '#e0f2fe',
      });
      this.particles.push({
        kind: 'shockwave',
        x,
        y,
        vx: 0,
        vy: 0,
        r: 10,
        maxR: isExpl ? 195 : 130,
        life: 0,
        maxLife: isExpl ? 0.42 : 0.32,
        color: isExpl ? '#fb923c' : '#bae6fd',
      });
      if (isExpl) {
        this.particles.push({
          kind: 'shockwave',
          x,
          y,
          vx: 0,
          vy: 0,
          r: 6,
          maxR: 135,
          life: 0,
          maxLife: 0.28,
          color: '#fef08a',
        });
      }

      // 2. Jagged flying Borosilicate glass triangles scattering & bouncing across the bench
      const vw = meta?.vesselWidth || 84;
      const vh = meta?.vesselHeight || 120;
      const shardCount = isExpl ? 56 : 42;
      for (let i = 0; i < shardCount; i++) {
        const angle = (Math.PI * 2 * i) / shardCount + (Math.random() - 0.5) * 0.45;
        const spd = isExpl ? 130 + Math.random() * 270 : 85 + Math.random() * 175;
        this.particles.push({
          kind: 'glass_triangle',
          x: x + (Math.random() - 0.5) * vw * 0.6,
          y: y + (Math.random() - 0.5) * vh * 0.5,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd - (isExpl ? 115 : 70),
          r: 4 + Math.random() * 7.5,
          angle: Math.random() * Math.PI * 2,
          spin: (Math.random() - 0.5) * 18,
          life: 0,
          maxLife: 1.35 + Math.random() * 0.85,
          color: Math.random() < 0.35 ? 'rgba(241, 245, 249, 0.92)' : 'rgba(186, 230, 253, 0.85)',
        });
      }

      // 3. Dramatic liquid splash jets arcing & splattering across the bench
      if (meta?.hadLiquid) {
        const dropCount = Math.min(75, Math.max(28, Math.round((meta.liquidMl || 40) * 0.42)));
        for (let i = 0; i < dropCount; i++) {
          const angle = -Math.PI * (0.04 + Math.random() * 0.92);
          const spd = isExpl ? 110 + Math.random() * 240 : 75 + Math.random() * 165;
          this.particles.push({
            kind: 'drip',
            x: x + (Math.random() - 0.5) * vw * 0.5,
            y: y + (Math.random() - 0.5) * vh * 0.35,
            vx: Math.cos(angle) * spd,
            vy: Math.sin(angle) * spd - 30,
            r: 2.5 + Math.random() * 4.5,
            life: 0,
            maxLife: 1.05 + Math.random() * 0.65,
            color: meta.liquidColor || 'rgba(186, 230, 253, 0.85)',
            splashed: false,
          });
        }
      }

      // 4. Fireball plume, sparks & smoke cloud on runaway Sodium explosion
      if (isExpl) {
        for (let i = 0; i < 38; i++) {
          const angle = -Math.PI * Math.random();
          const spd = 45 + Math.random() * 195;
          this.particles.push({
            kind: i % 3 === 0 ? 'spark' : 'flame',
            x: x + (Math.random() - 0.5) * 28,
            y: y + (Math.random() - 0.5) * 24,
            vx: Math.cos(angle) * spd,
            vy: Math.sin(angle) * spd - 55,
            r: i % 3 === 0 ? 2.5 + Math.random() * 2.5 : 8 + Math.random() * 11,
            life: 0,
            maxLife: 0.45 + Math.random() * 0.42,
            color: i % 3 === 0 ? '#fef08a' : Math.random() < 0.45 ? '#fbbf24' : '#f97316',
          });
        }
        for (let i = 0; i < 18; i++) {
          this.particles.push({
            kind: 'mist',
            x: x + (Math.random() - 0.5) * 34,
            y: y - 10 + (Math.random() - 0.5) * 22,
            vx: (Math.random() - 0.5) * 55,
            vy: -(38 + Math.random() * 65),
            r: 10 + Math.random() * 12,
            life: 0,
            maxLife: 1.2 + Math.random() * 0.7,
            color: 'rgba(226, 232, 240, 0.48)',
          });
        }
      }
      return;
    }

    // Stopper pop puff
    for (let i = 0; i < 18; i++) {
      const angle = -Math.PI * (0.15 + Math.random() * 0.7);
      const spd = 60 + Math.random() * 120;
      this.particles.push({
        kind: 'mist',
        x,
        y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - 35,
        r: 6 + Math.random() * 6,
        life: 0,
        maxLife: 0.75 + Math.random() * 0.45,
        color: 'rgba(241, 245, 249, 0.52)',
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
      } else if (p.kind === 'shockwave') {
        const progress = p.life / p.maxLife;
        p.r = 10 + (p.maxR - 10) * (1 - Math.pow(1 - progress, 2));
      } else if (p.kind === 'glass_triangle') {
        p.vy += 380 * dt;
        p.angle += p.spin * dt;
        if (p.y >= BENCH_FLOOR_Y) {
          p.y = BENCH_FLOOR_Y;
          p.vy = -Math.abs(p.vy) * 0.32;
          p.vx *= 0.72;
          p.spin *= 0.6;
        }
      } else if (p.kind === 'drip') {
        p.vy += 390 * dt;
        if (p.y >= BENCH_FLOOR_Y) {
          p.y = BENCH_FLOOR_Y;
          if (!p.splashed) {
            p.splashed = true;
            p.vy = -Math.abs(p.vy) * 0.16;
            p.vx = (p.vx === 0 ? (Math.random() - 0.5) * 40 : p.vx * 1.35);
          } else {
            p.vy = 0;
            p.vx *= 0.85;
          }
        }
      } else if (p.kind === 'spark' || p.kind === 'shard') {
        p.vy += 210 * dt;
      }
    }

    if (this.particles.length > 900) {
      this.particles.splice(0, this.particles.length - 900);
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
      } else if (p.kind === 'drip') {
        ctx.beginPath();
        if (p.splashed) {
          ctx.ellipse(p.x, p.y, p.r * 1.6, p.r * 0.55, 0, 0, Math.PI * 2);
        } else {
          ctx.ellipse(p.x, p.y, p.r * 0.78, p.r * 1.25, Math.atan2(p.vy, p.vx) + Math.PI / 2, 0, Math.PI * 2);
        }
        ctx.fillStyle = p.color;
        ctx.fill();
      } else if (p.kind === 'flash') {
        const grad = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, p.r * (0.4 + t * 0.7));
        grad.addColorStop(0, p.color);
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'shockwave') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, 5 * (1 - t));
        ctx.stroke();
      } else if (p.kind === 'glass_triangle') {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.beginPath();
        ctx.moveTo(-p.r * 0.7, -p.r * 0.45);
        ctx.lineTo(p.r * 0.8, -p.r * 0.1);
        ctx.lineTo(-p.r * 0.15, p.r * 0.75);
        ctx.closePath();
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
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
