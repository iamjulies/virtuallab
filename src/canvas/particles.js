import { CONSTANTS } from '../data/constants.js';
import { APPARATUS } from '../data/apparatus.js';
import { computeLiquidVolumeL, computeSolidVolumeMl } from '../engine/equilibrium.js';
import { getSyringeNozzlePos } from '../engine/gasNetwork.js';
import { computeVesselFluidGeometry } from './vesselRenderer.js';

const BENCH_FLOOR_Y = 482;

export class ParticleSystem {
  constructor() {
    this.particles = [];
    this.isDark = true;
  }

  setTheme(isDark) {
    this.isDark = isDark;
  }

  clear() {
    this.particles = [];
  }

  /**
   * Spawn bubbles, steam, sparks, syringe spray, and overflow droplets.
   */
  emitForVessel(item, metrics, dt) {
    if (item.kind === 'gas_syringe') {
      const sSpec = APPARATUS.gas_syringe;
      const nozzle = getSyringeNozzlePos(item);

      // 1. Rear collar spill when 250 mL syringe overflows
      if ((metrics.overflowOutRateMlS || 0) > 0.5) {
        const rate = Math.min(60, 14 + metrics.overflowOutRateMlS * 0.45);
        const dropCount = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
        const rearX = item.x - sSpec.width / 2 + (sSpec.barrelLeftOffset || 20) + (sSpec.barrelW || 192);
        const col = metrics.overflowOutColor || 'rgba(186, 230, 253, 0.85)';
        for (let i = 0; i < dropCount; i++) {
          this.particles.push({
            kind: 'drip',
            x: rearX + (Math.random() - 0.5) * 4,
            y: item.y + (Math.random() - 0.5) * 16,
            vx: 45 + Math.random() * 75,
            vy: -15 + Math.random() * 35,
            r: 2.3 + Math.random() * 2.2,
            life: 0,
            maxLife: 1.15 + Math.random() * 0.4,
            color: col,
            splashed: false,
          });
        }
      }

      // 2. Active parabolic liquid discharge droplets falling from Luer nozzle
      if ((metrics.dischargeLiquidRateMlS || 0) > 0.2 && metrics.dischargeArc) {
        const arc = metrics.dischargeArc;
        const rate = Math.min(55, 14 + metrics.dischargeLiquidRateMlS * 0.55);
        const count = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
        const col = metrics.dischargeColor || 'rgba(186, 230, 253, 0.9)';
        for (let i = 0; i < count; i++) {
          this.particles.push({
            kind: 'drip',
            x: nozzle.x + (Math.random() - 0.5) * 2.5,
            y: nozzle.y + (Math.random() - 0.5) * 2.5,
            vx: -48 + (Math.random() - 0.5) * 8,
            vy: 14 + (Math.random() - 0.5) * 6,
            g: CONSTANTS.GRAVITY_PX_S2 || 1800,
            r: 2.1 + Math.random() * 1.4,
            stopY: arc.hitY,
            catchX: arc.hitTargetVessel ? arc.hitX : null,
            nozzleStream: true,
            life: 0,
            maxLife: 0.95,
            color: col,
            splashed: false,
          });
        }
      }

      // 3. Colored / fuming rising gas filaments & soft mist clouds from Luer nozzle
      // (Pure colorless gases H2 / O2 are intentionally invisible!)
      const gasRates = metrics.dischargeGasRates || {};
      const cl2R = gasRates.Cl2_g || 0;
      const acidR = (gasRates.HCl_g || 0) + (gasRates.HNO3_g || 0);
      const steamR = (metrics.gasTempK || 298) >= 316 ? gasRates.H2O_g || 0 : 0;

      if (cl2R > 2e-6 || acidR > 5e-6 || steamR > 5e-6) {
        const isCl2 = cl2R > 2e-6;
        const isAcid = !isCl2 && acidR > 5e-6;
        const filColor = isCl2
          ? this.isDark
            ? 'rgba(190, 242, 100, 0.64)'
            : 'rgba(101, 163, 13, 0.56)'
          : isAcid
          ? this.isDark
            ? 'rgba(241, 245, 249, 0.44)'
            : 'rgba(100, 116, 139, 0.34)'
          : this.isDark
          ? 'rgba(226, 232, 240, 0.46)'
          : 'rgba(148, 163, 184, 0.36)';
        const cloudColor = isCl2
          ? this.isDark
            ? 'rgba(163, 230, 53, 0.24)'
            : 'rgba(132, 204, 22, 0.24)'
          : this.isDark
          ? 'rgba(226, 232, 240, 0.20)'
          : 'rgba(100, 116, 139, 0.18)';

        const ratePlume = isCl2 ? 22 : 14;
        const pCount = Math.floor(ratePlume * dt) + (Math.random() < (ratePlume * dt) % 1 ? 1 : 0);
        for (let i = 0; i < pCount; i++) {
          if (Math.random() < 0.55) {
            this.particles.push({
              kind: 'gas_filament',
              x: nozzle.x,
              y: nozzle.y + (Math.random() - 0.5) * 3,
              vx: -(28 + Math.random() * 24),
              vy: -(32 + Math.random() * 44),
              phase: Math.random() * Math.PI * 2,
              trail: [{ x: nozzle.x, y: nozzle.y }],
              w: isCl2 ? 3.2 : 2.4,
              life: 0,
              maxLife: 1.55 + Math.random() * 0.75,
              color: filColor,
            });
          } else {
            this.particles.push({
              kind: 'gas_cloud',
              x: nozzle.x - 4,
              y: nozzle.y - 2,
              vx: -(16 + Math.random() * 18),
              vy: -(38 + Math.random() * 34),
              phase: Math.random() * Math.PI * 2,
              r: 6 + Math.random() * 5,
              growR: 15 + Math.random() * 10,
              life: 0,
              maxLife: 1.85 + Math.random() * 0.85,
              color: cloudColor,
            });
          }
        }
      }
      return;
    }

    const vessel = item;
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

    // 3. Real Steam (boiling, sub-boil evap, crystal dehydration), HCl fuming, & Cl2 gas mist
    const nH = vessel.moles.H_aq || 0;
    const nCl = vessel.moles.Cl_aq || 0;
    const hConc = liqMl > 1 ? Math.min(nH, nCl) / (liqMl / 1000) : 0;
    const steamRate = metrics.steamRate || 0;
    const hasCl2 = (metrics.gasRateCl2 || 0) > 1e-6;
    const hasHClFume = !vessel.isStoppered && (hConc > 6.5 || (metrics.gasRateHCl || 0) > 5e-5);

    const steamSignal =
      steamRate > 2e-6 || metrics.isBoiling || metrics.isDehydrating
        ? Math.min(
            2.2,
            0.42 +
              Math.log10(1 + steamRate * 4800) * 0.92 +
              (metrics.isBoiling ? 0.55 : 0) +
              (metrics.isDehydrating ? 0.35 : 0)
          )
        : 0;
    const cl2Signal = hasCl2 ? 0.65 : 0;
    const fumeSignal = hasHClFume ? 0.4 : 0;
    const naSignal = metrics.naActive ? 0.9 : 0;
    const vaporIntensity = steamSignal + cl2Signal + fumeSignal + naSignal;

    const steamPalette = this.isDark
      ? 'rgba(226, 232, 240, 0.50)'
      : 'rgba(100, 116, 139, 0.38)';
    const fumePalette = this.isDark
      ? 'rgba(241, 245, 249, 0.52)'
      : 'rgba(71, 85, 105, 0.42)';
    const cl2Palette = this.isDark
      ? 'rgba(217, 249, 157, 0.52)'
      : 'rgba(132, 204, 22, 0.52)';

    if (vaporIntensity > 0.08 && !vessel.isStoppered) {
      const mistRate = Math.min(58, vaporIntensity * 28);
      const count = Math.floor(mistRate * dt) + (Math.random() < (mistRate * dt) % 1 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const fromCrystal = metrics.isDehydrating && Math.random() < 0.55;
        const startY = fromCrystal
          ? bottomY - 10 - Math.random() * 8
          : metrics.naActive
          ? surfaceY - 2
          : vessel.y - spec.height / 2 + 8;
        const spreadX = fromCrystal ? halfW * 1.15 : Math.max(8, (spec.neckRadius || 20) * 0.9);
        const mistColor = hasCl2 ? cl2Palette : hasHClFume ? fumePalette : steamPalette;

        if (hasCl2 && Math.random() < 0.45) {
          this.particles.push({
            kind: 'gas_filament',
            x: vessel.x + (Math.random() - 0.5) * spreadX * 0.6,
            y: startY,
            vx: (Math.random() - 0.5) * 16,
            vy: -(38 + Math.random() * 36),
            phase: Math.random() * Math.PI * 2,
            trail: [{ x: vessel.x, y: startY }],
            w: 2.8,
            life: 0,
            maxLife: 1.5 + Math.random() * 0.7,
            color: this.isDark ? 'rgba(190, 242, 100, 0.55)' : 'rgba(101, 163, 13, 0.48)',
          });
        } else {
          this.particles.push({
            kind: hasCl2 ? 'gas_cloud' : 'mist',
            x: vessel.x + (Math.random() - 0.5) * spreadX,
            y: startY,
            vx: (Math.random() - 0.5) * (fromCrystal ? 12 : 20),
            vy: -(28 + Math.random() * 34 + (metrics.isBoiling ? 12 : 0)),
            phase: Math.random() * Math.PI * 2,
            r: (fromCrystal ? 3.8 : 5.2) + Math.random() * 6.5,
            growR: 13,
            life: 0,
            maxLife: (fromCrystal ? 1.35 : 1.05) + Math.random() * 0.65,
            color: mistColor,
          });
        }
      }
    } else if (vaporIntensity > 0.18 && vessel.isStoppered) {
      // Swirling hot steam / Cl2 trapped inside headspace or entering tubing toward gas syringe
      const innerRate = Math.min(26, vaporIntensity * 14);
      const count = Math.floor(innerRate * dt) + (Math.random() < (innerRate * dt) % 1 ? 1 : 0);
      const neckW = Math.max(7, (spec.neckRadius || 16) * 0.85);
      for (let i = 0; i < count; i++) {
        const fromBottom = metrics.isDehydrating && Math.random() < 0.6;
        const startY = fromBottom ? bottomY - 10 : Math.min(surfaceY - 4, vessel.y - spec.height / 2 + 34);
        this.particles.push({
          kind: 'mist',
          x: vessel.x + (Math.random() - 0.5) * (fromBottom ? halfW * 1.05 : neckW),
          y: startY,
          vx: (Math.random() - 0.5) * 10,
          vy: -(16 + Math.random() * 18),
          r: 3.2 + Math.random() * 4.2,
          life: 0,
          maxLife: 0.48 + Math.random() * 0.3,
          color: hasCl2 ? cl2Palette : steamPalette,
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

    // 5. Gradual continuous rim overflow droplets cascading down onto the bench (open vessels only!)
    if (!vessel.isStoppered && (metrics.overflowRateMlS || 0) > 0.5) {
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
    if (type === 'overflow' || type === 'syringe_overflow') return;

    if (type === 'pipette_suck') {
      const pip = meta?.pipette;
      const tipX = pip ? pip.x : x;
      const tipY = pip ? pip.y + 70 : y - 50;
      const srcY = y + 8;
      const col = meta?.color || 'rgba(186, 230, 253, 0.9)';
      const count = 10;
      for (let i = 0; i < count; i++) {
        const delayFrac = i / count;
        const dx = tipX - x;
        const dy = tipY - srcY;
        const lifeSpan = 0.42 + delayFrac * 0.22;
        this.particles.push({
          kind: 'pipette_suck',
          x: x + (Math.random() - 0.5) * 8,
          y: srcY + Math.random() * 6,
          vx: dx / lifeSpan + (Math.random() - 0.5) * 14,
          vy: dy / lifeSpan - 12,
          r: 2.0 + Math.random() * 1.6,
          life: 0,
          maxLife: lifeSpan,
          color: col,
        });
      }
      this.particles.push({
        kind: 'shockwave',
        x,
        y: srcY,
        vx: 0,
        vy: 0,
        r: 4,
        maxR: 26,
        life: 0,
        maxLife: 0.36,
        color: col,
      });
      return;
    }

    if (type === 'pipette_drop') {
      const pip = meta?.pipette;
      const tipX = pip ? pip.x : x;
      const tipY = pip ? pip.y + 68 : y - 65;
      const col = meta?.color || 'rgba(186, 230, 253, 0.92)';
      const dropCount = Math.min(12, Math.max(2, Math.round((meta?.liquidMl || 0.5) * 4)));
      for (let i = 0; i < dropCount; i++) {
        this.particles.push({
          kind: 'drip',
          x: tipX + (Math.random() - 0.5) * 5,
          y: tipY + i * 4,
          vx: (x - tipX) * 1.6 + (Math.random() - 0.5) * 12,
          vy: 75 + Math.random() * 45,
          r: 2.4 + Math.random() * 1.4,
          stopY: y - 10,
          life: 0,
          maxLife: 0.55,
          color: col,
          splashed: false,
        });
      }
      this.particles.push({
        kind: 'shockwave',
        x,
        y: y - 8,
        vx: 0,
        vy: 0,
        r: 4,
        maxR: 24,
        life: 0,
        maxLife: 0.34,
        color: col,
      });
      return;
    }

    if (type === 'tube_drip') {
      const count = Math.min(20, Math.max(6, Math.round((meta?.liquidMl || 4) * 1.4)));
      for (let i = 0; i < count; i++) {
        this.particles.push({
          kind: 'drip',
          x: (meta?.x ?? x) + (Math.random() - 0.5) * 18,
          y: (meta?.y ?? y) + (Math.random() - 0.5) * 10,
          vx: (Math.random() - 0.5) * 55,
          vy: 15 + Math.random() * 45,
          r: 2.4 + Math.random() * 2.2,
          life: 0,
          maxLife: 1.1 + Math.random() * 0.4,
          color: meta?.liquidColor || 'rgba(186, 230, 253, 0.85)',
          splashed: false,
        });
      }
      return;
    }

    if (type === 'drop_spill') {
      const vw = meta?.vesselWidth || 72;
      const vh = meta?.vesselHeight || 110;
      const count = Math.min(40, Math.max(12, Math.round((meta?.liquidMl || 20) * 0.45)));
      const col = meta?.liquidColor || 'rgba(186, 230, 253, 0.85)';
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI * (0.08 + Math.random() * 0.84);
        const spd = 65 + Math.random() * 135;
        this.particles.push({
          kind: 'drip',
          x: x + (Math.random() - 0.5) * vw * 0.5,
          y: y - vh * 0.25 + (Math.random() - 0.5) * 12,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd - 20,
          r: 2.3 + Math.random() * 3.0,
          life: 0,
          maxLife: 0.95 + Math.random() * 0.45,
          color: col,
          splashed: false,
        });
      }
      this.particles.push({
        kind: 'shockwave',
        x,
        y: y + vh * 0.42,
        vx: 0,
        vy: 0,
        r: 6,
        maxR: Math.max(46, vw * 0.8),
        life: 0,
        maxLife: 0.28,
        color: col,
      });
      return;
    }

    if (type === 'syringe_plunger_pop') {
      const col = meta?.liquidColor || 'rgba(226, 232, 240, 0.72)';
      this.particles.push({
        kind: 'shockwave',
        x: x + 90,
        y,
        vx: 0,
        vy: 0,
        r: 8,
        maxR: 86,
        life: 0,
        maxLife: 0.28,
        color: '#f59e0b',
      });
      if (meta?.hadLiquid) {
        for (let i = 0; i < 22; i++) {
          this.particles.push({
            kind: 'drip',
            x: x - 20 + Math.random() * 110,
            y: y + (Math.random() - 0.5) * 20,
            vx: 65 + Math.random() * 140,
            vy: -55 + Math.random() * 80,
            r: 2.5 + Math.random() * 2.5,
            life: 0,
            maxLife: 1.15,
            color: col,
            splashed: false,
          });
        }
      }
      return;
    }

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

    // Flying Rubber Stopper POP burst!
    const neckTopY = y - (meta?.vesselHeight || 150) / 2;
    const stopTopW = Math.max(15, (meta?.neckRadius || 18) + 1.5);
    const stopBotW = Math.max(11, (meta?.neckRadius || 18) - 3);
    const dir = Math.random() < 0.5 ? -1 : 1;
    this.particles.push({
      kind: 'stopper_fly',
      x,
      y: neckTopY,
      vx: dir * (55 + Math.random() * 55),
      vy: -(330 + Math.random() * 75),
      angle: 0,
      spin: dir * (9 + Math.random() * 6),
      stopTopW,
      stopBotW,
      life: 0,
      maxLife: 1.75,
    });
    this.particles.push({
      kind: 'shockwave',
      x,
      y: neckTopY,
      vx: 0,
      vy: 0,
      r: 8,
      maxR: meta?.hydraulic ? 78 : 64,
      life: 0,
      maxLife: 0.24,
      color: meta?.hydraulic ? '#38bdf8' : '#cbd5e1',
    });

    for (let i = 0; i < 22; i++) {
      const angle = -Math.PI * (0.12 + Math.random() * 0.76);
      const spd = 75 + Math.random() * 145;
      this.particles.push({
        kind: 'mist',
        x,
        y: neckTopY,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - 35,
        r: 6 + Math.random() * 6,
        life: 0,
        maxLife: 0.78 + Math.random() * 0.45,
        color: 'rgba(241, 245, 249, 0.56)',
      });
    }

    if (meta?.hadLiquid) {
      const jetCount = meta.hydraulic ? 26 : 14;
      for (let i = 0; i < jetCount; i++) {
        const angle = -Math.PI * (0.28 + Math.random() * 0.44);
        const spd = 135 + Math.random() * 175;
        this.particles.push({
          kind: 'drip',
          x: x + (Math.random() - 0.5) * 14,
          y: neckTopY + 4,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd,
          r: 2.6 + Math.random() * 2.8,
          life: 0,
          maxLife: 1.2 + Math.random() * 0.5,
          color: meta.liquidColor || 'rgba(186, 230, 253, 0.85)',
          splashed: false,
        });
      }
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
      } else if (p.kind === 'gas_filament') {
        p.vx += (Math.sin(p.life * 8.5 + p.phase) * 75 - p.vx * 1.4) * dt;
        p.vy = Math.max(-115, p.vy - 18 * dt);
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 14) p.trail.shift();
      } else if (p.kind === 'gas_cloud') {
        p.r += (p.growR || 12) * dt;
        p.vx += (Math.sin(p.life * 4.5 + p.phase) * 32 - p.vx * 0.9) * dt;
        p.vy = Math.max(-92, p.vy - 8 * dt);
      } else if (p.kind === 'pipette_suck') {
        p.vx *= 0.98;
      } else if (p.kind === 'drip') {
        p.vy += (p.g || 390) * dt;
        const limitY = p.stopY || BENCH_FLOOR_Y;
        if (p.y >= limitY) {
          p.y = limitY;
          if (!p.splashed) {
            p.splashed = true;
            if (p.catchX != null) {
              // Absorbed into receiving vessel rim cleanly
              p.life = p.maxLife;
              this.particles.push({
                kind: 'shockwave',
                x: p.catchX,
                y: limitY + 4,
                vx: 0,
                vy: 0,
                r: 2,
                maxR: 13,
                life: 0,
                maxLife: 0.22,
                color: p.color,
              });
            } else {
              p.vy = p.stopY && !p.nozzleStream ? 0 : -Math.abs(p.vy) * 0.18;
              p.vx = p.stopY && !p.nozzleStream ? 0 : p.vx === 0 ? (Math.random() - 0.5) * 40 : p.vx * 1.15;
            }
          } else {
            p.vy = 0;
            p.vx *= 0.85;
          }
        }
      } else if (p.kind === 'stopper_fly') {
        p.vy += 470 * dt;
        p.angle += p.spin * dt;
        if (p.y >= BENCH_FLOOR_Y - 7) {
          p.y = BENCH_FLOOR_Y - 7;
          p.vy = -Math.abs(p.vy) * 0.36;
          p.vx *= 0.72;
          p.spin *= 0.65;
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
      } else if (p.kind === 'gas_filament') {
        const pts = p.trail || [];
        if (pts.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let k = 1; k < pts.length; k++) {
            ctx.lineTo(pts[k].x, pts[k].y);
          }
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(0.8, (p.w || 2.8) * (1 - t * 0.4));
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
      } else if (p.kind === 'gas_cloud') {
        const grad = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, p.r);
        grad.addColorStop(0, p.color);
        grad.addColorStop(0.55, p.color);
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
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
      } else if (p.kind === 'pipette_suck') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
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
      } else if (p.kind === 'stopper_fly') {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = '#334155';
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(-p.stopTopW, -8);
        ctx.lineTo(p.stopTopW, -8);
        ctx.lineTo(p.stopBotW, 9);
        ctx.lineTo(-p.stopBotW, 9);
        ctx.closePath();
        ctx.fill();
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
