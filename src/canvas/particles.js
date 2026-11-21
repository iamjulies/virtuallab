import { CONSTANTS } from '../data/constants.js';
import { APPARATUS, getCondenserPorts, getSyringeGeometry, getVesselEndPorts } from '../data/apparatus.js';
import { NON_STEAM_GAS_IDS, SPECIES } from '../data/species.js';
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
    if (item.kind === 'vessel' && (metrics.troughOverfillRate || 0) > 1e-4) {
      // Phenomenon #4: Excess gas bubbling out of submerged inverted tube mouth through water trough surface
      const nBub = Math.random() < Math.min(0.9, metrics.troughOverfillRate * dt * 25) ? 2 : 0;
      for (let k = 0; k < nBub; k++) {
        this.particles.push({
          kind: 'bubble',
          x: (metrics.troughOverfillX ?? item.x) + (Math.random() - 0.5) * 26,
          y: item.y + 18,
          vx: (Math.random() - 0.5) * 18,
          vy: -(48 + Math.random() * 28),
          r: 2.0 + Math.random() * 2.2,
          minY: item.y - 26,
          life: 0,
          maxLife: 1.0,
          color: 'rgba(248, 250, 252, 0.85)',
        });
      }
      return;
    }

    if (item.kind === 'filter_funnel' || item.kind === 'separatory_funnel' || item.kind === 'burette' || item.kind === 'condenser') {
      const rate = metrics.rateMlS || 0;
      if (rate > 0.05 && Math.random() < Math.min(0.85, rate * dt * 8)) {
        const condSpout = item.kind === 'condenser' ? getCondenserPorts(item).spout : null;
        const dropX = condSpout ? condSpout.x : item.x;
        const dropY = condSpout
          ? condSpout.y
          : item.y + (APPARATUS[item.typeId]?.height || 92) / 2;
        this.particles.push({
          kind: 'drip',
          x: dropX,
          y: dropY,
          vx: (Math.random() - 0.5) * 4,
          vy: 28,
          r: item.kind === 'burette' ? 2.0 : 2.3,
          life: 0,
          maxLife: 0.45,
          color: metrics.color || 'rgba(186, 230, 253, 0.88)',
          splashed: false,
        });
      }
      return;
    }

    if (item.kind === 'electrode') {
      const rateMolS = metrics.rateMolS || 0;
      if (rateMolS > 1e-7) {
        const nBub = Math.random() < 0.65 ? 1 : 0;
        for (let k = 0; k < nBub; k++) {
          this.particles.push({
            kind: 'bubble',
            x: item.x + (Math.random() - 0.5) * 10,
            y: item.y + 24 + Math.random() * 14,
            vx: (Math.random() - 0.5) * 8,
            vy: -(36 + Math.random() * 24),
            r: 1.4 + Math.random() * 1.4,
            minY: item.y - 24,
            life: 0,
            maxLife: 0.9,
            color: metrics.gasId === 'Cl2_g' ? 'rgba(163, 230, 53, 0.72)' : 'rgba(241, 245, 249, 0.85)',
          });
        }
      }
      return;
    }

    if (item.kind === 'wash_bottle' && metrics.squirtArc) {
      const arc = metrics.squirtArc;
      const splashProb = metrics.activeSpray ? 0.92 : 0.72;
      if (arc.hitX != null && Math.random() < splashProb) {
        const dropN = metrics.activeSpray ? 2 : 1;
        for (let i = 0; i < dropN; i++) {
          const sx = arc.hitX + (Math.random() - 0.5) * 8;
          const sy = arc.hitY;
          this.particles.push({
            kind: 'drip',
            x: sx,
            y: sy - 2,
            vx: (arc.dir || -1) * (10 + Math.random() * 26) + (Math.random() - 0.5) * 42,
            vy: -(28 + Math.random() * 38),
            g: 980,
            r: 1.5 + Math.random() * 1.3,
            stopY: arc.hitY + 4,
            life: 0,
            maxLife: 0.34,
            color: 'rgba(186, 230, 253, 0.9)',
            splashed: false,
          });
        }
      }
      return;
    }

    if (item.kind === 'gas_syringe') {
      const syrGeom = getSyringeGeometry(item);
      const nozzle = { x: syrGeom.nozzleX, y: syrGeom.nozzleY };

      // 1. Rear collar spill when 250 mL syringe overflows
      if ((metrics.overflowOutRateMlS || 0) > 0.5) {
        const rate = Math.min(60, 14 + metrics.overflowOutRateMlS * 0.45);
        const dropCount = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
        const rearX = syrGeom.rearX;
        const col = metrics.overflowOutColor || 'rgba(186, 230, 253, 0.85)';
        for (let i = 0; i < dropCount; i++) {
          this.particles.push({
            kind: 'drip',
            x: rearX + (Math.random() - 0.5) * 4,
            y: item.y + (Math.random() - 0.5) * 16,
            vx: syrGeom.barrelDir * (45 + Math.random() * 75),
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
            vx: syrGeom.dischargeVx + (Math.random() - 0.5) * 8,
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
      // Driven declaratively by SPECIES[gId].plume (pure colorless H2 / O2 remain invisible)
      const gasRates = metrics.dischargeGasRates || {};
      const steamR = (metrics.gasTempK || 298) >= 316 ? gasRates.H2O_g || 0 : 0;
      let nozzlePlume = null;
      for (const gId of NON_STEAM_GAS_IDS) {
        const p = SPECIES[gId]?.plume;
        if (!p || !p.nozzleDarkColor) continue;
        const rateMin = p.nozzleRateMin ?? 5e-6;
        if ((gasRates[gId] || 0) > rateMin && (!nozzlePlume || p.priority > nozzlePlume.priority)) {
          nozzlePlume = p;
        }
      }

      if (nozzlePlume || steamR > 5e-6) {
        const filColor = nozzlePlume
          ? this.isDark
            ? nozzlePlume.nozzleDarkColor
            : nozzlePlume.nozzleLightColor
          : this.isDark
          ? 'rgba(226, 232, 240, 0.46)'
          : 'rgba(148, 163, 184, 0.36)';
        const cloudColor = nozzlePlume
          ? this.isDark
            ? nozzlePlume.nozzleCloudDark
            : nozzlePlume.nozzleCloudLight
          : this.isDark
          ? 'rgba(226, 232, 240, 0.20)'
          : 'rgba(100, 116, 139, 0.18)';

        const outDir = -syrGeom.barrelDir;
        const ratePlume = nozzlePlume?.nozzleFilamentRate || 14;
        const filW = (nozzlePlume?.filamentWidth || 2.4) === 2.8 ? 3.2 : 2.4;
        const pCount = Math.floor(ratePlume * dt) + (Math.random() < (ratePlume * dt) % 1 ? 1 : 0);
        for (let i = 0; i < pCount; i++) {
          if (Math.random() < 0.55) {
            this.particles.push({
              kind: 'gas_filament',
              x: nozzle.x,
              y: nozzle.y + (Math.random() - 0.5) * 3,
              vx: outDir * (28 + Math.random() * 24),
              vy: -(32 + Math.random() * 44),
              phase: Math.random() * Math.PI * 2,
              trail: [{ x: nozzle.x, y: nozzle.y }],
              w: filW,
              life: 0,
              maxLife: 1.55 + Math.random() * 0.75,
              color: filColor,
            });
          } else {
            this.particles.push({
              kind: 'gas_cloud',
              x: nozzle.x + outDir * 4,
              y: nozzle.y - 2,
              vx: outDir * (16 + Math.random() * 18),
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

    // 1. Gas bubbles (H2 / O2 / CO2) inside liquid
    const gasIntensity = metrics.gasRateH2 + metrics.gasRateO2 + (metrics.gasRateCO2 || 0);
    if (gasIntensity > 1e-6 && liqMl > 0.2) {
      const spawnRate = Math.min(95, 10 + Math.log10(1 + gasIntensity * 5000) * 28);
      const count = Math.floor(spawnRate * dt) + (Math.random() < (spawnRate * dt) % 1 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const fromNa = metrics.naActive && Math.random() < 0.7;
        const fromK = !fromNa && metrics.kActive && Math.random() < 0.75;
        const px = fromNa
          ? vessel.x + ((vessel.naPosRatio ?? 0.5) - 0.5) * halfW * 1.7 + (Math.random() - 0.5) * 12
          : fromK
          ? vessel.x + ((vessel.kPosRatio ?? 0.5) - 0.5) * halfW * 1.7 + (Math.random() - 0.5) * 12
          : vessel.x + (Math.random() - 0.5) * halfW * 1.4;
        const py = fromNa || fromK
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

    // 3. Optically calibrated Vapor Fog (steamOpacity from mixing dew point) + species plume table
    const rateMap = metrics.gasRates || {
      H2_g: metrics.gasRateH2 || 0,
      O2_g: metrics.gasRateO2 || 0,
      HCl_g: metrics.gasRateHCl || 0,
      HNO3_g: metrics.gasRateHNO3 || 0,
      Cl2_g: metrics.gasRateCl2 || 0,
      C2H5Cl_g: metrics.gasRateC2H5Cl || 0,
      NH3_g: metrics.gasRateNH3 || 0,
      NO2_g: metrics.gasRateNO2 || 0,
      SO2_g: metrics.gasRateSO2 || 0,
      H2S_g: metrics.gasRateH2S || 0,
      NO_g: metrics.gasRateNO || 0,
    };
    const nH = vessel.moles.H_aq || 0;
    const nCl = vessel.moles.Cl_aq || 0;
    const nNO3 = vessel.moles.NO3_aq || 0;
    const hConc = liqMl > 1 ? Math.min(nH, nCl) / (liqMl / 1000) : 0;
    const hno3Conc = liqMl > 1 ? Math.min(nH, nNO3) / (liqMl / 1000) : 0;
    const steamRate = metrics.steamRate || 0;
    const steamVis = metrics.isBoiling
      ? Math.max(0.88, metrics.steamOpacity || 0)
      : metrics.isDehydrating
      ? Math.max(0.62, metrics.steamOpacity || 0)
      : (metrics.steamOpacity || 0);

    let dominantPlume = null;
    let plumeSignalSum = 0;
    for (const gId of NON_STEAM_GAS_IDS) {
      const p = SPECIES[gId]?.plume;
      if (!p) continue;
      const rateMin = p.rateMin ?? 2e-5;
      const active =
        gId === 'HCl_g'
          ? !vessel.isStoppered && ((hConc > 6.5 && vessel.tempK >= 268.15) || (rateMap[gId] || 0) > rateMin)
          : gId === 'HNO3_g'
          ? !vessel.isStoppered &&
            (((hno3Conc > 9.5 || (vessel.moles.HNO3_l || 0) > 1e-5) && vessel.tempK >= 268.15) ||
              (rateMap[gId] || 0) > rateMin)
          : (rateMap[gId] || 0) > rateMin;
      if (active) {
        plumeSignalSum += p.signal || 0.25;
        if (!dominantPlume || p.priority > dominantPlume.priority) {
          dominantPlume = p;
        }
      }
    }

    const steamSignal =
      !vessel.isFrozenSolid &&
      ((steamRate > 1.5e-6 && steamVis > 0.03) || metrics.isBoiling || metrics.isDehydrating)
        ? Math.min(2.2, (0.28 + steamVis * 1.45) * (metrics.isBoiling ? 1.25 : 1.0))
        : 0;
    const naMistSignal = metrics.naIgnited ? 0.85 : (metrics.naTempK || 298) >= 540 ? 0.25 : 0;
    const vaporIntensity = steamSignal + plumeSignalSum + naMistSignal;
    const mistAlphaScale = dominantPlume?.alphaScale ?? Math.min(1.0, Math.max(0.18, steamVis));

    const steamPalette = this.isDark ? 'rgba(226, 232, 240, 0.50)' : 'rgba(100, 116, 139, 0.38)';
    const activePlumeColor = dominantPlume
      ? this.isDark
        ? dominantPlume.darkColor
        : dominantPlume.lightColor
      : steamPalette;
    const hasFilaments = Boolean(dominantPlume?.filamentProb);

    if (spec.hasTwoEnds) {
      const ends = getVesselEndPorts(vessel);
      const openLeft = vessel._openLeftEnd ?? !(vessel.leftStoppered ?? vessel.isStoppered);
      const openRight = vessel._openRightEnd ?? !(vessel.rightStoppered ?? vessel.isStoppered);
      const openList = [];
      if (openLeft && ends?.left) openList.push(ends.left);
      if (openRight && ends?.right) openList.push(ends.right);

      if (vaporIntensity > 0.08 && openList.length > 0) {
        const mistRate = Math.min(58, vaporIntensity * 26);
        const count = Math.floor(mistRate * dt) + (Math.random() < (mistRate * dt) % 1 ? 1 : 0);
        for (let i = 0; i < count; i++) {
          const port = openList[i % openList.length];
          const dirSign = port.side === 'left' ? -1 : 1;
          const outVx = spec.isHorizontalTube
            ? dirSign * (24 + Math.random() * 24)
            : (Math.random() - 0.5) * 14;
          const outVy = spec.isHorizontalTube
            ? -(10 + Math.random() * 18)
            : -(30 + Math.random() * 34);
          if (hasFilaments && Math.random() < dominantPlume.filamentProb) {
            this.particles.push({
              kind: 'gas_filament',
              x: port.mouthX,
              y: port.mouthY + (Math.random() - 0.5) * 6,
              vx: outVx,
              vy: outVy,
              phase: Math.random() * Math.PI * 2,
              trail: [{ x: port.mouthX, y: port.mouthY }],
              w: dominantPlume.filamentWidth || 2.8,
              life: 0,
              maxLife: 1.45 + Math.random() * 0.6,
              color: this.isDark ? dominantPlume.filDarkColor : dominantPlume.filLightColor,
            });
          } else {
            this.particles.push({
              kind:
                dominantPlume && (dominantPlume.kind === 'colored_filament' || dominantPlume.kind === 'colored_cloud')
                  ? 'gas_cloud'
                  : 'mist',
              x: port.mouthX,
              y: port.mouthY + (Math.random() - 0.5) * 6,
              vx: outVx,
              vy: outVy,
              phase: Math.random() * Math.PI * 2,
              r: (4.2 + steamVis * 2.0) + Math.random() * 5.2,
              growR: 13,
              alphaScale: mistAlphaScale,
              oxidizesInAirToNO2: Boolean(dominantPlume?.oxidizesInAirToNO2 && (metrics.atmosphereMode || 'air') === 'air'),
              life: 0,
              maxLife: 0.95 + Math.random() * 0.65,
              color: activePlumeColor,
            });
          }
        }
      }
      if ((metrics.horizontalSpillRateMlS || 0) > 0.5 && ends) {
        const spillRate = Math.min(60, 14 + metrics.horizontalSpillRateMlS * 0.45);
        const dropCount = Math.floor(spillRate * dt) + (Math.random() < (spillRate * dt) % 1 ? 1 : 0);
        const col = metrics.horizontalSpillColor || 'rgba(186, 230, 253, 0.85)';
        const spillEnds = [];
        if (metrics.horizontalSpillLeft && ends.left) spillEnds.push(ends.left);
        if (metrics.horizontalSpillRight && ends.right) spillEnds.push(ends.right);
        for (let i = 0; i < dropCount && spillEnds.length > 0; i++) {
          const ep = spillEnds[i % spillEnds.length];
          const dirSign = ep.side === 'left' ? -1 : 1;
          this.particles.push({
            kind: 'drip',
            x: ep.mouthX,
            y: ep.mouthY + 4,
            vx: dirSign * (18 + Math.random() * 24),
            vy: 18 + Math.random() * 28,
            r: 2.3 + Math.random() * 2.0,
            life: 0,
            maxLife: 0.95 + Math.random() * 0.35,
            color: col,
            splashed: false,
          });
        }
      }
    } else if (vaporIntensity > 0.08 && !vessel.isStoppered) {
      const mistRate = Math.min(58, vaporIntensity * 26);
      const count = Math.floor(mistRate * dt) + (Math.random() < (mistRate * dt) % 1 ? 1 : 0);
      const effTilt = (vessel.tiltAngle || 0) + (vessel.landingTilt || 0);
      const cosT = Math.cos(effTilt);
      const sinT = Math.sin(effTilt);
      for (let i = 0; i < count; i++) {
        const fromCrystal = metrics.isDehydrating && Math.random() < 0.55;
        const clearGap = metrics.isBoiling ? 5 : 0;
        const startY = fromCrystal
          ? bottomY - 10 - Math.random() * 8
          : metrics.naActive
          ? surfaceY - 4
          : Math.min(surfaceY - clearGap, vessel.y - spec.height / 2 + 8);
        const spreadX = fromCrystal ? halfW * 1.15 : Math.max(8, (spec.neckRadius || 20) * 0.9);
        const lx = (Math.random() - 0.5) * spreadX;
        const ly = fromCrystal
          ? startY - vessel.y
          : Math.abs(effTilt) > 0.015
          ? -spec.height / 2 + 6
          : startY - vessel.y;
        const px = vessel.x + lx * cosT - ly * sinT;
        const py = vessel.y + lx * sinT + ly * cosT;
        const outSkewVx = Math.sin(effTilt) * 18;

        if (hasFilaments && Math.random() < dominantPlume.filamentProb) {
          const lxFil = (Math.random() - 0.5) * spreadX * 0.6;
          const fx = vessel.x + lxFil * cosT - ly * sinT;
          const fy = vessel.y + lxFil * sinT + ly * cosT;
          const sinkAcc = dominantPlume.sinkAccel || 0;
          this.particles.push({
            kind: 'gas_filament',
            x: fx,
            y: fy,
            vx: outSkewVx + (Math.random() - 0.5) * (sinkAcc > 0 ? 34 : 16),
            vy: sinkAcc > 0 ? -(10 + Math.random() * 14) : -(38 + Math.random() * 36),
            sinkAccel: sinkAcc,
            phase: Math.random() * Math.PI * 2,
            trail: [{ x: fx, y: fy }],
            w: dominantPlume.filamentWidth || 2.8,
            life: 0,
            maxLife: (sinkAcc > 0 ? 1.85 : 1.5) + Math.random() * 0.7,
            color: this.isDark ? dominantPlume.filDarkColor : dominantPlume.filLightColor,
          });
        } else {
          const sinkAccC = dominantPlume?.sinkAccel || 0;
          this.particles.push({
            kind:
              dominantPlume && (dominantPlume.kind === 'colored_filament' || dominantPlume.kind === 'colored_cloud')
                ? 'gas_cloud'
                : 'mist',
            x: px,
            y: py,
            vx: outSkewVx + (Math.random() - 0.5) * (sinkAccC > 0 ? 32 : fromCrystal ? 12 : 20),
            vy: sinkAccC > 0 ? -(8 + Math.random() * 14) : -(28 + Math.random() * 34 + (metrics.isBoiling ? 12 : 0)),
            sinkAccel: sinkAccC,
            phase: Math.random() * Math.PI * 2,
            r: (fromCrystal ? 3.8 : 4.5 + steamVis * 2.2) + Math.random() * 5.8,
            growR: 13,
            alphaScale: mistAlphaScale,
            oxidizesInAirToNO2: Boolean(dominantPlume?.oxidizesInAirToNO2 && (metrics.atmosphereMode || 'air') === 'air'),
            life: 0,
            maxLife: (sinkAccC > 0 ? 1.65 : fromCrystal ? 1.35 : 0.95) + Math.random() * 0.65,
            color: activePlumeColor,
          });
        }
      }
    } else if (vaporIntensity > 0.18 && vessel.isStoppered) {
      // Swirling hot steam / colored gases trapped inside headspace or entering tubing toward gas syringe
      const innerRate = Math.min(26, vaporIntensity * 14);
      const count = Math.floor(innerRate * dt) + (Math.random() < (innerRate * dt) % 1 ? 1 : 0);
      const neckW = Math.max(7, (spec.neckRadius || 16) * 0.85);
      const effTilt = (vessel.tiltAngle || 0) + (vessel.landingTilt || 0);
      const cosT = Math.cos(effTilt);
      const sinT = Math.sin(effTilt);
      for (let i = 0; i < count; i++) {
        const fromBottom = metrics.isDehydrating && Math.random() < 0.6;
        const startY = fromBottom ? bottomY - 10 : Math.min(surfaceY - 4, vessel.y - spec.height / 2 + 34);
        const lx = (Math.random() - 0.5) * (fromBottom ? halfW * 1.05 : neckW);
        const ly = startY - vessel.y;
        this.particles.push({
          kind: 'mist',
          x: vessel.x + lx * cosT - ly * sinT,
          y: vessel.y + lx * sinT + ly * cosT,
          vx: (Math.random() - 0.5) * 10,
          vy: -(16 + Math.random() * 18),
          r: 3.2 + Math.random() * 4.2,
          life: 0,
          maxLife: 0.48 + Math.random() * 0.3,
          color: dominantPlume && dominantPlume.priority >= 30 ? activePlumeColor : steamPalette,
        });
      }
    }

    // 4. Sodium molten yellow-orange ignition flame & sparks driven by separate droplet T_Na (>= 680 K ignition!)
    if (metrics.naActive && (vessel.moles.Na_s || 0) > 1e-7) {
      const naX = vessel.x + (vessel.naPosRatio - 0.5) * halfW * 1.55;
      const tNa = metrics.naTempK ?? vessel.tempK;
      const isIgnited = !!metrics.naIgnited || tNa >= 680;
      const intensity = isIgnited
        ? 1.55
        : Math.min(0.85, Math.max(0.05, (tNa - 420) / 320));
      const flameProb = isIgnited ? 0.94 : tNa >= 560 ? 0.35 : 0.04;

      if (Math.random() < flameProb) {
        const flameScale = isIgnited ? 1.6 : 0.75;
        this.particles.push({
          kind: 'flame',
          x: naX + (Math.random() - 0.5) * 6,
          y: surfaceY - 2,
          vx: (Math.random() - 0.5) * 20,
          vy: -(24 + Math.random() * 32) * flameScale,
          r: (4 + Math.random() * 5) * flameScale,
          life: 0,
          maxLife: 0.22 + Math.random() * 0.16,
          color: Math.random() < 0.5 ? '#fbbf24' : '#f97316',
        });
      }

      if ((isIgnited || intensity > 0.55) && Math.random() < (isIgnited ? 0.75 : 0.28)) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
        const spd = (isIgnited ? 75 : 45) + Math.random() * 85;
        this.particles.push({
          kind: 'spark',
          x: naX,
          y: surfaceY - 3,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd,
          r: 1.6 + Math.random() * 1.6,
          life: 0,
          maxLife: 0.35 + Math.random() * 0.25,
          color: '#fef08a',
        });
      }
    }

    // 4a. Potassium (K) instantaneous lilac-purple 766 nm H2 ignition flame & purple sparks on water/acid/ice
    if (metrics.kActive && (vessel.moles.K_s || 0) > 1e-7) {
      const kX = vessel.x + ((vessel.kPosRatio ?? 0.5) - 0.5) * halfW * 1.55;
      const isKIgnited = !!metrics.kIgnited || (metrics.kTempK ?? vessel.tempK) >= 400;
      if (Math.random() < (isKIgnited ? 0.96 : 0.55)) {
        const flameScale = isKIgnited ? 1.7 : 1.0;
        this.particles.push({
          kind: 'flame',
          x: kX + (Math.random() - 0.5) * 7,
          y: surfaceY - 3,
          vx: (Math.random() - 0.5) * 24,
          vy: -(28 + Math.random() * 36) * flameScale,
          r: (4.5 + Math.random() * 5.2) * flameScale,
          life: 0,
          maxLife: 0.24 + Math.random() * 0.16,
          color: Math.random() < 0.55 ? '#c084fc' : '#9b59b6',
        });
      }
      if (Math.random() < (isKIgnited ? 0.85 : 0.45)) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.0;
        const spd = 68 + Math.random() * 98;
        this.particles.push({
          kind: 'spark',
          x: kX,
          y: surfaceY - 3,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd,
          r: 1.7 + Math.random() * 1.8,
          life: 0,
          maxLife: 0.34 + Math.random() * 0.24,
          color: Math.random() < 0.5 ? '#e9d5ff' : '#c084fc',
        });
      }
    }

    // 4c. Iron sparkling combustion: in pure O2 headspace (any Fe >= 610/760 K) OR fine Fe powder burning in open air (>= 760 °C / 1033 K)
    // Solid bulk Iron nail NEVER sparks in ordinary air!
    const feFineParticle = (vessel.moles.Fe_s || 0) > 1e-8 && (Boolean(vessel.groundPowderMap?.Fe_s) || (vessel.particleCounts?.Fe_s || 0) >= 18);
    const feSparkO2 = (vessel.moles.Fe_s || 0) > 1e-8 && (vessel.headspaceGasMoles?.O2_g || 0) > 1e-5 && vessel.tempK >= (feFineParticle ? 610 : 760);
    const feSparkAir = feFineParticle && !vessel.isStoppered && vessel.lidState !== 'closed' && (vessel.tempK >= 1033.15 || (vessel.feSparkBurning || 0) > 0.05);
    if (feSparkO2 || feSparkAir) {
      const sparkBurst = vessel.tempK >= 1373.15 ? 5 : 3;
      for (let i = 0; i < sparkBurst; i++) {
        if (Math.random() < 0.72) {
          const ang = Math.random() * Math.PI * 2;
          const spd = 48 + Math.random() * 88;
          this.particles.push({
            kind: 'spark',
            x: vessel.x + (Math.random() - 0.5) * 14,
            y: bottomY - 8,
            vx: Math.cos(ang) * spd,
            vy: Math.sin(ang) * spd - 20,
            r: 1.5 + Math.random() * 1.6,
            life: 0,
            maxLife: 0.32 + Math.random() * 0.22,
            color: i % 2 === 0 ? '#fef08a' : '#fb923c',
          });
        }
      }
    }

    // 4b. Dry Sodium auto-ignition in Air/O2: 589 nm vivid yellow flame & white peroxide mist
    if (metrics.naDryBurning && !vessel.isStoppered) {
      if (Math.random() < 0.85) {
        this.particles.push({
          kind: 'flame',
          x: vessel.x + (Math.random() - 0.5) * 12,
          y: bottomY - 5,
          vx: (Math.random() - 0.5) * 18,
          vy: -(28 + Math.random() * 34),
          r: 5.0 + Math.random() * 5.0,
          life: 0,
          maxLife: 0.22 + Math.random() * 0.14,
          color: Math.random() < 0.65 ? '#fde047' : '#fb923c',
        });
      }
      if (Math.random() < 0.55) {
        this.particles.push({
          kind: 'gas_cloud',
          x: vessel.x + (Math.random() - 0.5) * 14,
          y: bottomY - 12,
          vx: (Math.random() - 0.5) * 14,
          vy: -(30 + Math.random() * 24),
          phase: Math.random() * Math.PI * 2,
          r: 5.5 + Math.random() * 4,
          growR: 12,
          life: 0,
          maxLife: 1.2 + Math.random() * 0.5,
          color: this.isDark ? 'rgba(254, 240, 138, 0.32)' : 'rgba(202, 138, 4, 0.25)',
        });
      }
    }

    // 4b-K. Dry Potassium lilac 766 nm ignition flame & purple sparks
    if (metrics.kDryBurning && !vessel.isStoppered) {
      if (Math.random() < 0.9) {
        this.particles.push({
          kind: 'flame',
          x: vessel.x + (Math.random() - 0.5) * 12,
          y: bottomY - 5,
          vx: (Math.random() - 0.5) * 20,
          vy: -(30 + Math.random() * 34),
          r: 5.2 + Math.random() * 5.0,
          life: 0,
          maxLife: 0.24 + Math.random() * 0.14,
          color: Math.random() < 0.6 ? '#c084fc' : '#9b59b6',
        });
      }
      if (Math.random() < 0.65) {
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
        const spd = 60 + Math.random() * 80;
        this.particles.push({
          kind: 'spark',
          x: vessel.x + (Math.random() - 0.5) * 8,
          y: bottomY - 5,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          r: 1.6 + Math.random() * 1.5,
          life: 0,
          maxLife: 0.32 + Math.random() * 0.2,
          color: '#e9d5ff',
        });
      }
    }

    // 4b-Mg/Al. Magnesium blinding white flash (brightWhiteFlash) & Aluminium/thermite intense sparks
    if (metrics.mgBurning && !vessel.isStoppered) {
      for (let i = 0; i < 4; i++) {
        if (Math.random() < 0.85) {
          const ang = Math.random() * Math.PI * 2;
          const spd = 65 + Math.random() * 115;
          this.particles.push({
            kind: 'spark',
            x: vessel.x + (Math.random() - 0.5) * 10,
            y: bottomY - 7,
            vx: Math.cos(ang) * spd,
            vy: Math.sin(ang) * spd - 22,
            r: 2.0 + Math.random() * 2.2,
            life: 0,
            maxLife: 0.34 + Math.random() * 0.22,
            color: i % 2 === 0 ? '#ffffff' : '#bae6fd',
          });
        }
      }
    }
    if (metrics.alBurning && !vessel.isStoppered) {
      for (let i = 0; i < 3; i++) {
        if (Math.random() < 0.78) {
          const ang = Math.random() * Math.PI * 2;
          const spd = 55 + Math.random() * 95;
          this.particles.push({
            kind: 'spark',
            x: vessel.x + (Math.random() - 0.5) * 12,
            y: bottomY - 7,
            vx: Math.cos(ang) * spd,
            vy: Math.sin(ang) * spd - 20,
            r: 1.8 + Math.random() * 1.8,
            life: 0,
            maxLife: 0.34 + Math.random() * 0.22,
            color: i % 2 === 0 ? '#ffffff' : '#fde047',
          });
        }
      }
    }

    // 4c. Zinc combustion flame (characteristic pale bluish-cyan vapor flame + dense billowing white ZnO smoke!)
    if (metrics.znBurning && !vessel.isStoppered) {
      if (Math.random() < 0.82) {
        this.particles.push({
          kind: 'flame',
          x: vessel.x + (Math.random() - 0.5) * 14,
          y: bottomY - 5,
          vx: (Math.random() - 0.5) * 14,
          vy: -(24 + Math.random() * 28),
          r: 4.5 + Math.random() * 4.5,
          life: 0,
          maxLife: 0.20 + Math.random() * 0.14,
          color: Math.random() < 0.65 ? '#67e8f9' : '#a7f3d0',
        });
      }
      if (Math.random() < 0.72) {
        this.particles.push({
          kind: 'gas_cloud',
          x: vessel.x + (Math.random() - 0.5) * 16,
          y: bottomY - 14,
          vx: (Math.random() - 0.5) * 16,
          vy: -(34 + Math.random() * 28),
          phase: Math.random() * Math.PI * 2,
          r: 7 + Math.random() * 5,
          growR: 16,
          life: 0,
          maxLife: 1.45 + Math.random() * 0.6,
          color: this.isDark ? 'rgba(248, 250, 252, 0.42)' : 'rgba(148, 163, 184, 0.38)',
        });
      }
    }

    // 5. Gradual continuous rim overflow droplets cascading down onto the bench (open vessels only!)
    if (!vessel.isStoppered && (metrics.overflowRateMlS || 0) > 0.5) {
      const rate = Math.min(75, 18 + metrics.overflowRateMlS * 0.45);
      const dropCount = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
      const topY = vessel.y - spec.height / 2 + 2;
      const rimX =
        vessel.x -
        (spec.shape === 'erlenmeyer' || spec.shape === 'round_flask' ? spec.neckRadius || 18.5 : spec.width / 2);
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

  /**
   * SOS Theme shatter ocean wave: red beacon dot at break origin + concentric cyan-white
   * undulating sea waves sweeping across the entire lab bench.
   */
  emitSosShatterWave(x, y) {
    const cx = Math.max(0, Math.min(1000, x));
    const cy = Math.max(0, Math.min(BENCH_FLOOR_Y, y));
    this.particles.push({
      kind: 'sos_origin_dot',
      x: cx,
      y: cy,
      vx: 0,
      vy: 0,
      r: 5.5,
      life: 0,
      maxLife: 3.6,
    });
    for (let w = 0; w < 4; w++) {
      this.particles.push({
        kind: 'sos_wave',
        x: cx,
        y: cy,
        vx: 0,
        vy: 0,
        r: 6,
        maxR: 1220,
        waveIdx: w,
        delay: w * 0.24,
        life: 0,
        maxLife: 3.4,
      });
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

    if (type === 'burette_drop') {
      const tx = meta?.tipX ?? x;
      const ty = meta?.tipY ?? y;
      this.particles.push({
        kind: 'drip',
        x: tx,
        y: ty,
        vx: 0,
        vy: 68,
        g: 1100,
        r: 2.6,
        stopY: meta?.stopY ?? BENCH_FLOOR_Y,
        catchX: meta?.catchX ?? null,
        life: 0,
        maxLife: 0.72,
        color: meta?.color || 'rgba(186, 230, 253, 0.92)',
        splashed: false,
      });
      return;
    }

    if (type === 'tilt_spill' || type === 'tilt_solid_spill') {
      const isSolid = type === 'tilt_solid_spill';
      const fx = meta?.fromX ?? x;
      const fy = meta?.fromY ?? y;
      const col = isSolid ? (meta?.color || '#e2e8f0') : (meta?.liquidColor || 'rgba(186, 230, 253, 0.88)');
      if (!isSolid) {
        const visc = Math.max(1.0, meta?.viscosity || 1.0);
        const lipDir = meta?.lipDir || 1;
        const excessMl = meta?.excessMl || 2;
        const tiltDeg = meta?.tiltDeg || 45;
        const isCoanda = excessMl < 3.5 && tiltDeg < 74;
        const count = Math.min(7, Math.max(2, Math.round((meta?.rateMlS || 4) * 0.45)));
        for (let i = 0; i < count; i++) {
          const vxInit = isCoanda
            ? -lipDir * (10 + Math.random() * 6)
            : lipDir * (28 + Math.min(62, excessMl * 3.8)) / Math.pow(visc, 0.48) + (Math.random() - 0.5) * 8;
          this.particles.push({
            kind: 'metaball_drop',
            x: fx + (Math.random() - 0.5) * 4,
            y: fy + (Math.random() - 0.5) * 3,
            vx: vxInit,
            vy: (18 + Math.random() * 18) / Math.sqrt(visc),
            g: 1080 / Math.pow(visc, 0.25),
            r: 4.4 + (visc > 1.8 ? 1.0 : 0) + Math.random() * 1.4,
            coandaTimer: isCoanda ? 0.16 : 0,
            lipDir,
            stopY: meta?.toY ?? BENCH_FLOOR_Y,
            catchX: meta?.catchX ?? null,
            life: 0,
            maxLife: 0.85,
            color: col,
          });
        }
        return;
      }
      for (let i = 0; i < 5; i++) {
        this.particles.push({
          kind: 'drip',
          x: fx + (Math.random() - 0.5) * 6,
          y: fy + (Math.random() - 0.5) * 4,
          vx: (Math.random() - 0.5) * 22,
          vy: 35 + Math.random() * 35,
          g: 960,
          r: 1.9 + Math.random() * 1.1,
          stopY: meta?.toY ?? BENCH_FLOOR_Y,
          catchX: meta?.catchX ?? null,
          life: 0,
          maxLife: 0.75,
          color: col,
          splashed: false,
        });
      }
      return;
    }

    if (type === 'spoon_scoop') {
      const sx = meta?.x ?? x;
      const sy = meta?.y ?? y;
      const col = meta?.color || '#cbd5e1';
      for (let i = 0; i < 12; i++) {
        const ang = -Math.PI * (0.15 + Math.random() * 0.7);
        const spd = 25 + Math.random() * 48;
        this.particles.push({
          kind: 'drip',
          x: sx + (Math.random() - 0.5) * 16,
          y: sy + (Math.random() - 0.5) * 8,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          r: 1.8 + Math.random() * 1.4,
          stopY: sy + 14,
          life: 0,
          maxLife: 0.45 + Math.random() * 0.2,
          color: col,
          splashed: false,
        });
      }
      this.particles.push({
        kind: 'shockwave',
        x: sx,
        y: sy,
        vx: 0,
        vy: 0,
        r: 4,
        maxR: 22,
        life: 0,
        maxLife: 0.30,
        color: col,
      });
      return;
    }

    if (type === 'spoon_pour') {
      const fx = meta?.fromX ?? x;
      const fy = meta?.fromY ?? y - 40;
      const ty = meta?.toY ?? y;
      const col = meta?.color || '#e2e8f0';
      for (let i = 0; i < 16; i++) {
        this.particles.push({
          kind: 'drip',
          x: fx + (Math.random() - 0.5) * 10,
          y: fy + (Math.random() - 0.5) * 6,
          vx: (x - fx) * 1.4 + (Math.random() - 0.5) * 20,
          vy: 70 + Math.random() * 65,
          r: 1.9 + Math.random() * 1.5,
          stopY: ty + 6,
          life: 0,
          maxLife: 0.55 + Math.random() * 0.25,
          color: col,
          splashed: false,
        });
      }
      this.particles.push({
        kind: 'shockwave',
        x,
        y: ty,
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

    if (type === 'nh3_hcl_smoke') {
      // Soft radial-gradient NH4Cl(s) microcrystal aerosol puffs swirling & slowly settling downward
      if (!meta?.force && Math.random() > 0.62) return;
      const intensity = Math.max(0.4, Math.min(1.6, meta?.intensity ?? 0.9));
      const puffCount = meta?.count ?? (intensity > 0.95 ? 4 : 3);
      for (let i = 0; i < puffCount; i++) {
        const px = x + (Math.random() - 0.5) * 32;
        const py = y + (Math.random() - 0.5) * 18;
        this.particles.push({
          kind: 'aerosol_cloud',
          x: px,
          y: py,
          vx: (Math.random() - 0.5) * 16,
          vy: 2.5 + Math.random() * 6.5,
          phase: Math.random() * Math.PI * 2,
          r: 8 + Math.random() * 9,
          growR: 10 + Math.random() * 7,
          life: 0,
          maxLife: 2.1 + Math.random() * 1.1,
          color: this.isDark ? 'rgba(245, 248, 255, 0.75)' : 'rgba(226, 232, 240, 0.78)',
        });
      }
      return;
    }

    if (type === 'cl2_extinguish') {
      for (let i = 0; i < 6; i++) {
        this.particles.push({
          kind: 'smoke_ribbon',
          x: x + (Math.random() - 0.5) * 6,
          y: y - 2,
          vx: (Math.random() - 0.5) * 14,
          vy: -(24 + Math.random() * 16),
          phase: Math.random() * Math.PI * 2,
          freq1: 5.5,
          freq2: 11.0,
          amp1: 14,
          amp2: 6,
          trail: [{ x, y }],
          w: 1.6,
          life: 0,
          maxLife: 0.9,
          color: this.isDark ? 'rgba(217, 249, 157, 0.72)' : 'rgba(101, 163, 13, 0.58)',
          haloColor: 'rgba(190, 242, 100, 0.2)',
        });
      }
      return;
    }

    if (type === 'oxyhydrogen_detonation') {
      const scale = Math.max(0.8, Math.min(3.0, meta?.blastScale || 1.2));
      this.particles.push({
        kind: 'flash',
        x,
        y,
        vx: 0,
        vy: 0,
        r: 36 * scale,
        life: 0,
        maxLife: 0.34,
        color: 'rgba(254, 240, 138, 0.96)',
      });
      this.particles.push({
        kind: 'shockwave',
        x,
        y,
        vx: 0,
        vy: 0,
        r: 12,
        maxR: 95 * scale,
        life: 0,
        maxLife: 0.38,
        color: '#f97316',
      });
      const nSpk = Math.round(18 * scale);
      for (let i = 0; i < nSpk; i++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = (75 + Math.random() * 140) * Math.sqrt(scale);
        this.particles.push({
          kind: 'spark',
          x,
          y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          r: 2.2 + Math.random() * 2.0,
          life: 0,
          maxLife: 0.42 + Math.random() * 0.28,
          color: i % 2 === 0 ? '#fde047' : '#fb923c',
        });
      }
      return;
    }

    if (type === 'ammonia_fountain') {
      for (let i = 0; i < 20; i++) {
        const ang = -Math.PI * (0.15 + Math.random() * 0.70);
        const spd = 45 + Math.random() * 75;
        this.particles.push({
          kind: 'drip',
          x: x + (Math.random() - 0.5) * 14,
          y: y + 10,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          r: 2.2 + Math.random() * 2.0,
          life: 0,
          maxLife: 0.65,
          color: meta?.liquidColor || 'rgba(236, 72, 153, 0.88)',
          splashed: false,
        });
      }
      return;
    }

    if (type === 'h2_pop') {
      this.particles.push({
        kind: 'flash',
        x,
        y,
        vx: 0,
        vy: 0,
        r: 26,
        life: 0,
        maxLife: 0.28,
        color: 'rgba(125, 211, 252, 0.92)',
      });
      for (let i = 0; i < 12; i++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = 45 + Math.random() * 90;
        this.particles.push({
          kind: 'spark',
          x,
          y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          r: 2.0 + Math.random() * 1.5,
          life: 0,
          maxLife: 0.35 + Math.random() * 0.2,
          color: i % 2 === 0 ? '#7dd3fc' : '#fde047',
        });
      }
      return;
    }

    if (type === 'o2_relight' || type === 'o2_flare') {
      const isFlare = type === 'o2_flare';
      this.particles.push({
        kind: 'flash',
        x,
        y,
        vx: 0,
        vy: 0,
        r: isFlare ? 44 : 28,
        life: 0,
        maxLife: 0.40,
        color: isFlare ? 'rgba(254, 240, 138, 0.96)' : 'rgba(253, 224, 71, 0.9)',
      });
      const nSparks = isFlare ? 20 : 12;
      for (let i = 0; i < nSparks; i++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = (isFlare ? 40 : 28) + Math.random() * (isFlare ? 95 : 65);
        this.particles.push({
          kind: 'spark',
          x,
          y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 24,
          r: (isFlare ? 2.1 : 1.6) + Math.random() * 1.6,
          life: 0,
          maxLife: 0.42 + Math.random() * 0.25,
          color: i % 3 === 0 ? '#fef08a' : '#fbbf24',
        });
      }
      return;
    }

    if (type !== 'pop') return;

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
      } else if (p.kind === 'sos_wave') {
        if (p.delay > 0) {
          p.delay -= dt;
          p.life = 0;
        } else {
          const progress = Math.min(1, p.life / p.maxLife);
          p.r = 6 + (p.maxR - 6) * Math.pow(progress, 0.88);
        }
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
        p.vy = p.sinkAccel > 0 ? Math.min(76, p.vy + p.sinkAccel * dt) : Math.max(-115, p.vy - 18 * dt);
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 14) p.trail.shift();
      } else if (p.kind === 'smoke_ribbon') {
        const curlVx =
          Math.sin(p.life * p.freq1 + p.phase) * p.amp1 +
          Math.cos(p.life * p.freq2 + p.phase * 1.6) * p.amp2;
        p.x += curlVx * dt;
        p.vy = Math.max(-52, p.vy - 6 * dt);
        p.vx *= 0.96;
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 22) p.trail.shift();
      } else if (p.kind === 'gas_cloud') {
        p.r += (p.growR || 12) * dt;
        p.vx += (Math.sin(p.life * 4.5 + p.phase) * 32 - p.vx * 0.9) * dt;
        p.vy = p.sinkAccel > 0 ? Math.min(68, p.vy + p.sinkAccel * dt) : Math.max(-92, p.vy - 8 * dt);
      } else if (p.kind === 'aerosol_cloud') {
        p.r += (p.growR || 10) * dt;
        p.vx += (Math.sin(p.life * 2.8 + p.phase) * 18 - p.vx * 0.85) * dt;
        p.vy = Math.min(18, p.vy + 2.2 * dt); // Dense solid NH4Cl microcrystals gently settle downward
      } else if (p.kind === 'monochrome_petal') {
        p.vx = Math.sin(p.life * 2.2 + p.phase) * 24;
        p.vy = 28 + Math.cos(p.life * 1.4 + p.phase) * 6;
        p.angle = (p.angle || 0) + (p.spin || 1.2) * dt;
      } else if (p.kind === 'pipette_suck') {
        p.vx *= 0.98;
      } else if (p.kind === 'metaball_drop') {
        if (p.coandaTimer > 0) {
          p.coandaTimer -= dt;
          p.vx *= 0.92;
        }
        p.vy += (p.g || 1080) * dt;
        const limitY = p.stopY || BENCH_FLOOR_Y;
        if (p.y >= limitY) {
          p.y = limitY;
          p.life = p.maxLife;
          if (p.catchX != null) {
            this.particles.push({
              kind: 'shockwave',
              x: p.catchX + (Math.random() - 0.5) * 8,
              y: limitY + 3,
              vx: 0,
              vy: 0,
              r: 2,
              maxR: 12,
              life: 0,
              maxLife: 0.22,
              color: p.color,
            });
          }
        }
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
        const grad = ctx.createRadialGradient(p.x - p.r * 0.35, p.y - p.r * 0.35, p.r * 0.1, p.x, p.y, p.r);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.92)');
        grad.addColorStop(0.55, p.color);
        grad.addColorStop(1, 'rgba(186, 230, 253, 0.38)');
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = Math.max(0.55, p.r * 0.24);
        ctx.stroke();
        // Crisp optical specular meniscus glint inside bubble
        if (p.r >= 1.3) {
          ctx.beginPath();
          ctx.arc(p.x - p.r * 0.32, p.y - p.r * 0.32, Math.max(0.4, p.r * 0.25), 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.fill();
        }
      } else if (p.kind === 'mist') {
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha * (p.alphaScale ?? 1)));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        if (p.oxidizesInAirToNO2 && t > 0.20) {
          const brownAlpha = Math.max(0, Math.min(0.68, (t - 0.20) * 1.15 * alpha));
          ctx.globalAlpha = brownAlpha;
          ctx.fillStyle = this.isDark ? 'rgba(234, 88, 12, 0.72)' : 'rgba(180, 83, 9, 0.68)';
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 1.15, 0, Math.PI * 2);
          ctx.fill();
        }
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
      } else if (p.kind === 'smoke_ribbon') {
        const pts = p.trail || [];
        if (pts.length >= 2) {
          const traceRibbon = () => {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let k = 1; k < pts.length - 1; k++) {
              const mx = (pts[k].x + pts[k + 1].x) * 0.5;
              const my = (pts[k].y + pts[k + 1].y) * 0.5;
              ctx.quadraticCurveTo(pts[k].x, pts[k].y, mx, my);
            }
            const last = pts[pts.length - 1];
            ctx.lineTo(last.x, last.y);
          };
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          // Delicate soft smoky outer sheath
          traceRibbon();
          ctx.strokeStyle = p.haloColor || p.color;
          ctx.lineWidth = Math.max(2.0, (p.w || 2.0) * (1.8 + t * 1.1));
          ctx.stroke();
          // Crisp sinuous kitchen-smoke core strand
          traceRibbon();
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(0.7, (p.w || 2.0) * (0.95 - t * 0.35));
          ctx.stroke();
        }
      } else if (p.kind === 'gas_cloud' || p.kind === 'aerosol_cloud') {
        const grad = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, p.r);
        grad.addColorStop(0, p.color);
        grad.addColorStop(0.48, p.color);
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'monochrome_petal') {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle || 0);
        ctx.fillStyle = p.color || '#F2F2F5';
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r || 6, (p.r || 6) * 0.48, 0, 0, Math.PI * 2);
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
      } else if (p.kind === 'sos_origin_dot') {
        const pulse = 0.72 + Math.sin(p.life * 10) * 0.28;
        const glow = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, 18);
        glow.addColorStop(0, `rgba(239, 68, 68, ${(0.95 * alpha).toFixed(3)})`);
        glow.addColorStop(0.55, `rgba(220, 38, 38, ${(0.45 * alpha * pulse).toFixed(3)})`);
        glow.addColorStop(1, 'rgba(220, 38, 38, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(239, 68, 68, ${Math.min(1, alpha * 1.15).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5.2 + pulse * 1.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255, 255, 255, ${(0.85 * alpha).toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else if (p.kind === 'sos_wave') {
        if (p.delay > 0 || p.r < 6) {
          ctx.restore();
          continue;
        }
        const waveAmp = (2.8 + (1 - t) * 4.5) * Math.min(1, p.r / 90);
        const segs = 72;
        ctx.beginPath();
        for (let k = 0; k <= segs; k++) {
          const ang = (Math.PI * 2 * k) / segs;
          const rad = p.r + Math.sin(ang * 14 - p.life * 5.8 + p.waveIdx * 1.4) * waveAmp;
          const px = p.x + Math.cos(ang) * rad;
          const py = p.y + Math.sin(ang) * rad;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(91, 181, 201, ${(0.68 * alpha).toFixed(3)})`;
        ctx.lineWidth = Math.max(1.2, 4.2 * (1 - t * 0.55));
        ctx.stroke();
        ctx.strokeStyle = `rgba(240, 249, 255, ${(0.88 * alpha).toFixed(3)})`;
        ctx.lineWidth = Math.max(0.8, 1.8 * (1 - t * 0.5));
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

    // 2D Metaball Threshold-Alpha Liquid Ribbon pass (zero cost when not actively pouring)
    const mbDrops = this.particles.filter((p) => p.kind === 'metaball_drop');
    if (mbDrops.length > 0 && typeof document !== 'undefined') {
      if (!this._mbCanvas) {
        this._mbCanvas = document.createElement('canvas');
        this._mbCanvas.width = 500;
        this._mbCanvas.height = 280;
        this._mbCtx = this._mbCanvas.getContext('2d', { willReadFrequently: true });
      }
      const mctx = this._mbCtx;
      let minX = 500;
      let minY = 280;
      let maxX = 0;
      let maxY = 0;
      for (const d of mbDrops) {
        const sx = d.x * 0.5;
        const sy = d.y * 0.5;
        const sr = d.r * 0.85;
        minX = Math.min(minX, Math.floor(sx - sr - 2));
        minY = Math.min(minY, Math.floor(sy - sr - 2));
        maxX = Math.max(maxX, Math.ceil(sx + sr + 2));
        maxY = Math.max(maxY, Math.ceil(sy + sr + 2));
      }
      minX = Math.max(0, minX);
      minY = Math.max(0, minY);
      maxX = Math.min(500, maxX);
      maxY = Math.min(280, maxY);
      const bw = maxX - minX;
      const bh = maxY - minY;
      if (bw > 0 && bh > 0) {
        mctx.clearRect(minX, minY, bw, bh);
        for (const d of mbDrops) {
          const sx = d.x * 0.5;
          const sy = d.y * 0.5;
          const sr = d.r * 0.85;
          const g = mctx.createRadialGradient(sx, sy, 0.2, sx, sy, sr);
          g.addColorStop(0, d.color);
          g.addColorStop(0.55, d.color);
          g.addColorStop(1, 'rgba(255,255,255,0)');
          mctx.fillStyle = g;
          mctx.beginPath();
          mctx.arc(sx, sy, sr, 0, Math.PI * 2);
          mctx.fill();
        }
        const img = mctx.getImageData(minX, minY, bw, bh);
        const data = img.data;
        for (let idx = 3; idx < data.length; idx += 4) {
          const a = data[idx];
          data[idx] = a > 105 ? 232 : 0;
        }
        mctx.putImageData(img, minX, minY);
        ctx.save();
        ctx.drawImage(this._mbCanvas, minX, minY, bw, bh, minX * 2, minY * 2, bw * 2, bh * 2);
        ctx.restore();
      }
    }
  }

  spawnCelebrationPetals(count = 14) {
    for (let i = 0; i < count; i++) {
      this.particles.push({
        kind: 'monochrome_petal',
        x: 60 + Math.random() * 880,
        y: -15 - Math.random() * 90,
        vx: (Math.random() - 0.5) * 20,
        vy: 30 + Math.random() * 18,
        r: 4.5 + Math.random() * 3.5,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() > 0.5 ? 1 : -1) * (1.2 + Math.random() * 1.4),
        phase: Math.random() * Math.PI * 2,
        life: 0,
        maxLife: 5.5 + Math.random() * 2.5,
        color: '#F2F2F5',
      });
    }
  }
}
