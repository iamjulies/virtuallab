/**
 * Reaction Vessel & Glassware Liquid/Steam Canvas Renderer (Refactor 81).
 * Equipment & theme helpers live in ./equipmentRenderer.js
 */
import {
  APPARATUS,
  getClampNeckOffsetY,
  getCondenserPorts,
  getStandGeometry,
  getSyringeGeometry,
  getVesselEndPorts,
  getVesselTubingPort,
} from '../data/apparatus.js';
import { CONSTANTS, kelvinToCelsius } from '../data/constants.js';
import { findClipYForVolume, findTiltClipY3D, getInnerPolygonPx } from '../data/vesselGeometry.js';
import { SPECIES } from '../data/species.js';
import {
  computeLiquidVolumeL,
  computePH,
  computePhaseStratification,
  computeSolidVolumeMl,
  computeSolutionVisuals,
} from '../engine/equilibrium.js';
import {
  ALL_GASES,
  buildCombinedSyringeLiquidMoles,
  buildCombinedSyringeTotalMoles,
  computeSyringeFrozenVolumeMl,
  computeSyringeGasVolumeMl,
  computeSyringeLiquidVolumeMl,
  computeSyringeTotalVolumeMl,
  computeCondenserOutletGeometry,
  computeTubingGeometry,
  cubicBezierPoint,
  getSyringeNozzlePos,
  samplePolylineAt,
} from '../engine/gasNetwork.js';

import { renderVesselSolids } from './chemicalVisuals.js';
import {
  strokeHaloGlow, strokeSelectionGlow, getThemePalette, computeVesselFluidGeometry, getCurrentCanvasTheme, formatCanvasText, beginCanvasLabelFrame, setCurrentLabelItemId, flushCanvasLabelFrame, drawLabelPill, renderScale, renderBurner, renderRetortStand, renderRetortClampJaw, renderGasSyringe, renderPipette, renderTubingConnections, cylinderFillHeightFraction, mapProfileToCanvas, traceVesselPath, traceVesselInteriorClip, getVesselAeroProfile,
} from './equipmentRenderer.js';

export {
  strokeHaloGlow, strokeSelectionGlow, getThemePalette, computeVesselFluidGeometry, getCurrentCanvasTheme, formatCanvasText, beginCanvasLabelFrame, setCurrentLabelItemId, flushCanvasLabelFrame, drawLabelPill, renderScale, renderBurner, renderRetortStand, renderRetortClampJaw, renderGasSyringe, renderPipette, renderTubingConnections, traceVesselInteriorClip, getVesselAeroProfile,
};

function renderShatteredWreckage(ctx, vessel, spec, pal, isSelected) {
  const { x, y } = vessel;
  const w = spec.width;
  const h = spec.height;
  const bottom = y + h / 2;

  ctx.save();
  // Spilled wet chemical puddle on the bench / scale pan / burner
  if (vessel.spilledPuddleColor) {
    ctx.save();
    ctx.fillStyle = vessel.spilledPuddleColor;
    ctx.globalAlpha = 0.72;
    ctx.beginPath();
    ctx.ellipse(x - 4, bottom - 1, w * 0.85, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + w * 0.55, bottom - 1, w * 0.28, 3.8, 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x - w * 0.65, bottom - 1, w * 0.24, 3.2, -0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Jagged shattered base stump (glass broke completely open)
  const stumpHalf = w * 0.42;
  ctx.fillStyle = pal.glassFill;
  ctx.strokeStyle = isSelected ? '#3b82f6' : '#ef4444';
  ctx.lineWidth = isSelected ? 2.2 : 1.7;
  ctx.beginPath();
  ctx.moveTo(x - stumpHalf, bottom - 12);
  ctx.lineTo(x - stumpHalf * 0.65, bottom - 5);
  ctx.lineTo(x - stumpHalf * 0.25, bottom - 14);
  ctx.lineTo(x + stumpHalf * 0.15, bottom - 4);
  ctx.lineTo(x + stumpHalf * 0.58, bottom - 11);
  ctx.lineTo(x + stumpHalf, bottom - 6);
  ctx.lineTo(x + stumpHalf * 0.92, bottom);
  ctx.lineTo(x - stumpHalf * 0.92, bottom);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Pile of 15 scattered angular Borosilicate glass shards around wreckage
  for (let i = 0; i < 15; i++) {
    const seed = Math.sin((i + 1) * 91.7 + vessel.label.charCodeAt(vessel.label.length - 1) * 13.3);
    const seed2 = Math.cos((i + 1) * 47.3);
    const sx = x + seed * (w * 0.68);
    const sy = bottom - 2 - Math.abs(seed2) * 8;
    const size = 5.5 + (i % 4) * 2.4;
    const rot = seed * Math.PI;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(-size * 0.8, size * 0.35);
    ctx.lineTo(size * 0.7, -size * 0.4);
    ctx.lineTo(size * 0.15, size * 0.55);
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? 'rgba(224, 242, 254, 0.78)' : 'rgba(148, 163, 184, 0.62)';
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#3b82f6' : 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 0.85;
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

const VESSEL_SHELL_CACHE = new Map();
const VESSEL_SHELL_PAD = 24;

export function getVesselGlassShellCacheSize() {
  return VESSEL_SHELL_CACHE.size;
}

function getCachedVesselGlassShell(spec, pal, isDark, isSelected, isDropTarget, softenGlowFrac = 0, sagFrac = 0) {
  if (typeof document === 'undefined') return null;
  const cacheDpr = typeof window !== 'undefined' ? Math.min(2, Math.max(1, window.devicePixelRatio || 1)) : 1;
  const glowQ = softenGlowFrac > 0.08 ? Math.round(softenGlowFrac * 8) : 0;
  const sagQ = sagFrac > 0.005 ? Math.round(sagFrac * 20) : 0;
  const key = `${spec.id}|${isDark ? 1 : 0}|${isSelected ? 1 : 0}|${isDropTarget ? 1 : 0}|${glowQ}|${sagQ}|${cacheDpr}`;

  const hit = VESSEL_SHELL_CACHE.get(key);
  if (hit) return hit;

  const pad = VESSEL_SHELL_PAD;
  const w = spec.width;
  const h = spec.height;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((w + pad * 2) * cacheDpr);
  canvas.height = Math.round((h + pad * 2) * cacheDpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(cacheDpr, cacheDpr);

  const x = pad + w / 2;
  const y = pad + h / 2;
  const top = y - h / 2;
  const bottom = y + h / 2;
  const geom = computeVesselFluidGeometry(spec, y, 0);
  const { interiorBottom, scaleY, neckHalf, volumeMlToY, volumeMlToState } = geom;

  // Draw glass outer silhouette + ISO reinforced wall + red-orange thermal softening sag
  traceVesselPath(ctx, spec, x, y, sagFrac);
  const vesselGlowColor = isDropTarget
    ? '#10b981'
    : softenGlowFrac > 0.08
    ? `rgba(249, 115, 22, ${Math.min(0.95, 0.35 + softenGlowFrac * 0.6).toFixed(2)})`
    : isSelected
    ? '#3b82f6'
    : null;
  if (vesselGlowColor) strokeHaloGlow(ctx, vesselGlowColor, isSelected || isDropTarget ? 2.5 : 2.0);
  ctx.strokeStyle =
    softenGlowFrac > 0.25
      ? `rgb(249, ${Math.max(60, Math.round(160 - softenGlowFrac * 100))}, 22)`
      : isDropTarget
      ? '#10b981'
      : isSelected
      ? '#3b82f6'
      : pal.glassStroke;
  ctx.lineWidth = isSelected || isDropTarget ? 2.5 : spec.wallThicknessMm >= 1.1 || spec.shape === 'dish' || spec.shape === 'mortar' || spec.shape === 'crucible' ? 2.3 : 1.75;
  ctx.stroke();

  if (spec.hasTwoEnds) {
    if (spec.isHorizontalTube) {
      ctx.strokeStyle = pal.glassHighlight;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x - w * 0.44, y - h * 0.34);
      ctx.lineTo(x + w * 0.44, y - h * 0.34);
      ctx.stroke();
    } else if (spec.isUTube) {
      const dxU = spec.limbSpacingX || 28;
      const rOut = spec.tubeOuterR || 13;
      const topY = y - h / 2 + 2;
      const bendCy = y + h / 2 - 2 - (dxU + rOut);
      ctx.strokeStyle = pal.glassStroke;
      ctx.lineWidth = 2.0;
      for (const armSign of [-1, 1]) {
        const cxArm = x + armSign * dxU;
        ctx.beginPath();
        ctx.ellipse(cxArm, topY, rOut + 1.5, 2.2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = pal.glassHighlight;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x - dxU - rOut + 3.2, topY + 6);
      ctx.lineTo(x - dxU - rOut + 3.2, bendCy);
      ctx.arc(x, bendCy, dxU + rOut - 3.2, Math.PI, Math.PI * 0.56, true);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + dxU + rOut - 3.2, topY + 6);
      ctx.lineTo(x + dxU + rOut - 3.2, bendCy);
      ctx.stroke();
    }
  }

  // Glass vertical specular highlight
  if (!spec.isUTube && !spec.isHorizontalTube && spec.shape !== 'dish' && spec.shape !== 'mortar' && spec.shape !== 'crucible') {
    ctx.strokeStyle = pal.glassHighlight;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (spec.shape === 'erlenmeyer') {
      const shoulderY = interiorBottom - spec.geometry.profilePoints[3][0] * scaleY;
      ctx.moveTo(x - neckHalf + 4, shoulderY + 2);
      ctx.lineTo(x - w * 0.36, bottom - 15);
    } else if (spec.shape === 'round_flask') {
      const { pts } = mapProfileToCanvas(spec, x, y, sagFrac);
      const minBulbRx = Math.max(neckHalf + 5, w * 0.25);
      const bulbPts = pts.filter((p) => p.rx >= minBulbRx);
      if (bulbPts.length >= 3) {
        const iStart = Math.max(0, Math.floor(bulbPts.length * 0.14));
        const iEnd = Math.min(bulbPts.length - 1, Math.floor(bulbPts.length * 0.86));
        ctx.moveTo(x - bulbPts[iStart].rx * 0.80, bulbPts[iStart].cy);
        for (let i = iStart + 1; i <= iEnd; i++) {
          ctx.lineTo(x - bulbPts[i].rx * 0.80, bulbPts[i].cy);
        }
      }
    } else if (spec.shape === 'trough') {
      ctx.moveTo(x - w * 0.38, top + 12);
      ctx.lineTo(x - w * 0.35, bottom - 12);
    } else {
      ctx.moveTo(x - w * 0.33, top + 12);
      ctx.lineTo(x - w * 0.33, bottom - 14);
    }
    ctx.stroke();
  }

  // White ceramic enamel ISO graduations + frosted write-on patch
  // Record text labels relative to center (x, y) so main ctx renders crisp text & satisfies ctx.fillText tests
  const textDraws = [];
  ctx.fillText = (text, tx, ty) => {
    textDraws.push({
      text: String(text),
      dx: tx - x,
      dy: ty - y,
      font: ctx.font,
      fillStyle: ctx.fillStyle,
      textAlign: ctx.textAlign,
      textBaseline: ctx.textBaseline,
    });
  };
  ctx.textBaseline = 'middle';
  ctx.font = '600 8px system-ui, sans-serif';
  if (spec.shape === 'beaker') {
    const isLargeBeaker = (spec.maxVolumeMl || 250) >= 900;
    const marks = isLargeBeaker
      ? [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
      : [25, 50, 75, 100, 125, 150, 175, 200, 225, 250];
    for (const ml of marks) {
      const ty = volumeMlToY(ml);
      const isMajor = isLargeBeaker ? ml % 200 === 0 : ml % 50 === 0;
      const tickX = x - w * 0.32;
      const tickLen = isMajor ? 9 : 5;
      ctx.strokeStyle = isMajor ? pal.tickStroke : pal.tickMinor;
      ctx.lineWidth = isMajor ? 1.1 : 0.8;
      ctx.beginPath();
      ctx.moveTo(tickX, ty);
      ctx.lineTo(tickX + tickLen, ty);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = pal.enamelText;
        ctx.textAlign = 'left';
        ctx.fillText(String(ml), tickX + 11, ty + 0.5);
      }
    }
    const patchW = (spec.maxVolumeMl || 250) >= 900 ? 27 : spec.formVariant === 'tall' ? 17 : 19;
    const patchH = spec.formVariant === 'tall' ? 23 : 20;
    const patchX = x + w * 0.17;
    const patchY = top + h * 0.28;
    ctx.fillStyle = pal.writePatchBg;
    ctx.strokeStyle = pal.writePatchBorder;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.roundRect(patchX, patchY, patchW, patchH, 2.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = pal.enamelText;
    ctx.textAlign = 'center';
    ctx.font = 'bold 7.5px system-ui, sans-serif';
    ctx.fillText(String(spec.maxVolumeMl || 250), patchX + patchW / 2, patchY + 7);
    ctx.font = '600 6.5px system-ui, sans-serif';
    ctx.fillText(formatCanvasText('mL'), patchX + patchW / 2, patchY + 15);
  } else if (spec.shape === 'erlenmeyer') {
    const isLargeFlask = (spec.maxVolumeMl || 250) >= 900;
    const marks = isLargeFlask ? [200, 400, 600, 800, 1000] : [50, 100, 150, 200, 250];
    for (const ml of marks) {
      const st = volumeMlToState(ml);
      const ty = st.cy;
      const tickX = x - st.halfWPx * 0.72;
      const isTopMark = ml === (isLargeFlask ? 1000 : 250);
      const isMajor = isLargeFlask ? ml % 400 === 0 || ml === 200 || ml === 1000 : ml === 100 || ml === 200 || ml === 250;
      const tickLen = isTopMark ? 6 : isMajor ? 9 : 5.5;
      ctx.strokeStyle = pal.tickStroke;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(tickX, ty);
      ctx.lineTo(tickX + tickLen, ty);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = pal.enamelText;
        ctx.textAlign = 'left';
        ctx.fillText(String(ml), tickX + tickLen + 2, ty + 0.5);
      }
    }
    const patchW = (spec.maxVolumeMl || 250) >= 900 ? 27 : 20;
    const patchH = 22;
    const patchX = x + 9;
    const patchY = bottom - 46;
    ctx.fillStyle = pal.writePatchBg;
    ctx.strokeStyle = pal.writePatchBorder;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.roundRect(patchX, patchY, patchW, patchH, 2.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = pal.enamelText;
    ctx.textAlign = 'center';
    ctx.font = 'bold 7.5px system-ui, sans-serif';
    ctx.fillText(String(spec.maxVolumeMl || 250), patchX + patchW / 2, patchY + 7.5);
    ctx.font = '600 6.5px system-ui, sans-serif';
    ctx.fillText(formatCanvasText('ISO'), patchX + patchW / 2, patchY + 15.5);
  } else if (spec.shape === 'round_flask') {
    const isLargeRound = (spec.maxVolumeMl || 250) >= 900;
    const neckHalfPx = spec.neckRadius || 17;
    ctx.fillStyle = isDark ? 'rgba(226, 232, 240, 0.22)' : 'rgba(148, 163, 184, 0.25)';
    ctx.fillRect(x - neckHalfPx + 1.5, top + 2, (neckHalfPx - 1.5) * 2, 16);
    ctx.strokeStyle = pal.tickMinor;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x - neckHalfPx + 1.5, top + 18);
    ctx.lineTo(x + neckHalfPx - 1.5, top + 18);
    ctx.stroke();
    const marks = isLargeRound ? [200, 400, 600, 800, 1000] : [50, 100, 150, 200, 250];
    for (const ml of marks) {
      const st = volumeMlToState(ml);
      const ty = st.cy;
      const halfR = st.halfWPx || st.rx || w * 0.36;
      const tickX = x - Math.max(10, halfR * 0.72);
      const isMajor = isLargeRound ? ml % 400 === 0 || ml === 200 || ml === 1000 : ml % 100 === 0 || ml === 50 || ml === 250;
      const tickLen = isMajor ? (isLargeRound ? 8.5 : 6.5) : 4.5;
      ctx.strokeStyle = isMajor ? pal.tickStroke : pal.tickMinor;
      ctx.lineWidth = isMajor ? 1.05 : 0.85;
      ctx.beginPath();
      ctx.moveTo(tickX, ty);
      ctx.lineTo(tickX + tickLen, ty);
      ctx.stroke();
      ctx.fillStyle = pal.enamelText;
      ctx.textAlign = 'left';
      ctx.font = isLargeRound ? '600 7.5px system-ui, sans-serif' : '600 6.5px system-ui, sans-serif';
      ctx.fillText(String(ml), tickX + tickLen + 2, ty + 0.5);
    }
    const eqSt = volumeMlToState((spec.maxVolumeMl || 250) * 0.45);
    const patchW = isLargeRound ? 28 : 21;
    const patchH = 21;
    const patchX = x + (isLargeRound ? 14 : 7);
    const patchY = Math.round(eqSt.cy - patchH / 2);
    ctx.fillStyle = pal.writePatchBg;
    ctx.strokeStyle = pal.writePatchBorder;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.roundRect(patchX, patchY, patchW, patchH, 2.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = pal.enamelText;
    ctx.textAlign = 'center';
    ctx.font = 'bold 7.5px system-ui, sans-serif';
    ctx.fillText(String(spec.maxVolumeMl || 250), patchX + patchW / 2, patchY + 7.5);
    ctx.font = '600 6.5px system-ui, sans-serif';
    ctx.fillText('mL', patchX + patchW / 2, patchY + 15.5);
  } else if (spec.shape === 'cylinder') {
    for (let ml = 10; ml <= 100; ml += 10) {
      const ty = volumeMlToY(ml);
      const isMajor = ml % 20 === 0;
      const tickX = x - w * 0.34;
      const tickLen = isMajor ? 10 : 5;
      ctx.strokeStyle = isMajor ? pal.tickStroke : pal.tickMinor;
      ctx.lineWidth = isMajor ? 1.1 : 0.8;
      ctx.beginPath();
      ctx.moveTo(tickX, ty);
      ctx.lineTo(tickX + tickLen, ty);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = pal.enamelText;
        ctx.textAlign = 'left';
        ctx.font = '600 7.5px system-ui, sans-serif';
        ctx.fillText(String(ml), tickX + 11.5, ty + 0.5);
      }
    }
  } else if (spec.isUTube) {
    const dxU = spec.limbSpacingX || 28;
    const rOut = spec.tubeOuterR || 13;
    const armTickX = x - dxU - rOut + 2.5;
    for (let ml = 20; ml <= 80; ml += 10) {
      const frac = ml / Math.max(1, spec.maxVolumeMl || 100);
      const ty = interiorBottom - frac * Math.max(12, interiorBottom - top - 10);
      const isMajor = ml === 40 || ml === 80;
      const tickLen = isMajor ? 5.5 : 3.2;
      ctx.strokeStyle = isMajor ? pal.tickStroke : pal.tickMinor;
      ctx.lineWidth = isMajor ? 1.0 : 0.75;
      ctx.beginPath();
      ctx.moveTo(armTickX, ty);
      ctx.lineTo(armTickX + tickLen, ty);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = pal.enamelText;
        ctx.textAlign = 'right';
        ctx.font = '600 6.8px system-ui, sans-serif';
        ctx.fillText(String(ml), armTickX - 3.5, ty + 0.5);
      }
    }
  } else if (spec.isHorizontalTube) {
    const marks = [
      { fracX: -0.28, label: '20' },
      { fracX: -0.14, label: null },
      { fracX: 0.0, label: '60' },
      { fracX: 0.14, label: null },
      { fracX: 0.28, label: '100' },
    ];
    for (const mk of marks) {
      const tx = x + w * mk.fracX;
      const isMajor = Boolean(mk.label);
      ctx.strokeStyle = isMajor ? pal.tickStroke : pal.tickMinor;
      ctx.lineWidth = isMajor ? 1.0 : 0.75;
      ctx.beginPath();
      ctx.moveTo(tx, top + 3);
      ctx.lineTo(tx, top + (isMajor ? 8 : 5.5));
      ctx.stroke();
      if (mk.label) {
        ctx.fillStyle = pal.enamelText;
        ctx.textAlign = 'center';
        ctx.font = '600 6.8px system-ui, sans-serif';
        ctx.fillText(mk.label, tx, top + 14.5);
      }
    }
  } else if (spec.shape === 'trough') {
    for (let ml = 250; ml <= 1250; ml += 250) {
      const ty = volumeMlToY(ml);
      if (ty < top + 6 || ty > bottom - 7) continue;
      const isMajor = ml % 500 === 0;
      const tickX = x - w * 0.36;
      const tickLen = isMajor ? 9.5 : 5.5;
      ctx.strokeStyle = isMajor ? pal.tickStroke : pal.tickMinor;
      ctx.lineWidth = isMajor ? 1.05 : 0.75;
      ctx.beginPath();
      ctx.moveTo(tickX, ty);
      ctx.lineTo(tickX + tickLen, ty);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = pal.enamelText;
        ctx.textAlign = 'left';
        ctx.font = '600 7.2px system-ui, sans-serif';
        ctx.fillText(String(ml), tickX + tickLen + 2.5, ty + 0.5);
      }
    }
  } else if (spec.shape === 'test_tube') {
    for (let ml = 10; ml <= 50; ml += 5) {
      const ty = volumeMlToY(ml);
      const isMajor = ml % 10 === 0;
      const tickX = x - w * 0.30;
      const tickLen = isMajor ? 7.5 : 4;
      ctx.strokeStyle = isMajor ? pal.tickStroke : pal.tickMinor;
      ctx.lineWidth = isMajor ? 1.0 : 0.75;
      ctx.beginPath();
      ctx.moveTo(tickX, ty);
      ctx.lineTo(tickX + tickLen, ty);
      ctx.stroke();
      if (ml === 10 || ml === 30 || ml === 50) {
        ctx.fillStyle = pal.enamelText;
        ctx.textAlign = 'left';
        ctx.font = '600 6.8px system-ui, sans-serif';
        ctx.fillText(String(ml), tickX + 8.5, ty + 0.5);
      }
    }
  }

  if (VESSEL_SHELL_CACHE.size >= 96) {
    const oldestKey = VESSEL_SHELL_CACHE.keys().next().value;
    if (oldestKey !== undefined) VESSEL_SHELL_CACHE.delete(oldestKey);
  }
  const entry = { canvas, pad, textDraws };
  VESSEL_SHELL_CACHE.set(key, entry);
  return entry;
}

export function renderVessel(ctx, vessel, opts) {
  const { isSelected, isDropTarget, isDark, timeNow, langCode = 'vi', themeName = isDark ? 'dark' : 'light' } = opts;
  const spec = APPARATUS[vessel.typeId];
  const pal = getThemePalette(isDark);
  const { x, y } = vessel;
  const w = spec.width;
  const h = spec.height;
  const top = y - h / 2;
  const bottom = y + h / 2;

  if (vessel.isShattered) {
    renderShatteredWreckage(ctx, vessel, spec, pal, isSelected);
    const tempC = kelvinToCelsius(vessel.tempK);
    const pillText = `${vessel.label} · 💥 0.0mL · ${tempC.toFixed(0)}°C`;
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    const textW = ctx.measureText(pillText).width + 14;
    const py = bottom - 42;
    ctx.fillStyle = pal.badgeBg;
    ctx.strokeStyle = isSelected ? '#3b82f6' : '#ef4444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - textW / 2, py, textW, 20, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = pal.textPrimary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pillText, x, py + 10.5);
    ctx.restore();
    return;
  }

  ctx.save();

  // Spilled chemical puddle on floor around unbroken vessel from drop spill or overflow
  if (vessel.spilledPuddleColor && !vessel.isDragging) {
    ctx.save();
    ctx.fillStyle = vessel.spilledPuddleColor;
    ctx.globalAlpha = 0.56;
    ctx.beginPath();
    ctx.ellipse(x, bottom + 1, w * 0.62, 4.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Apply pour tilt + impact drop wobble + inverted orientation + molten sag deformation
  const sagFrac = vessel.softenSagFrac || 0;
  const effTilt = (vessel.tiltAngle || 0) + (vessel.landingTilt || 0);
  if (effTilt || vessel.isInverted) {
    ctx.translate(x, y);
    if (effTilt) ctx.rotate(effTilt);
    if (vessel.isInverted) ctx.scale(1, -1);
    ctx.translate(-x, -y);
  }

  // Cork support ring nested underneath Round-Bottom Flasks when sitting upright on bench or scale
  if (
    spec.isRoundBottom &&
    !vessel.isInverted &&
    !vessel.clampedToId &&
    !vessel.isDragging &&
    !vessel.isShattered &&
    Math.abs(vessel.vy || 0) < 4
  ) {
    const ringY = y + h / 2 - 2;
    const rx = Math.max(18, w * 0.27);
    ctx.save();
    ctx.fillStyle = isDark ? '#78350f' : '#92400e';
    ctx.beginPath();
    ctx.ellipse(x, ringY - 2, rx, 6.2, 0, 0, Math.PI * 2);
    ctx.fill();
    const corkGrad = ctx.createLinearGradient(x - rx, 0, x + rx, 0);
    corkGrad.addColorStop(0, '#92400e');
    corkGrad.addColorStop(0.35, '#d97706');
    corkGrad.addColorStop(0.7, '#b45309');
    corkGrad.addColorStop(1, '#78350f');
    ctx.fillStyle = corkGrad;
    ctx.strokeStyle = isDark ? '#fbbf24' : '#78350f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, ringY, rx, 5.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Draw porcelain opaque interior glaze for dishes/mortars/crucibles, or glass interior fill
  ctx.save();
  traceVesselInteriorClip(ctx, spec, x, y, sagFrac);
  const isPorcelain = spec.shape === 'dish' || spec.shape === 'mortar' || spec.shape === 'crucible';
  ctx.fillStyle = isPorcelain
    ? isDark
      ? 'rgba(241, 245, 249, 0.78)'
      : 'rgba(255, 255, 255, 0.94)'
    : pal.glassFill;
  ctx.fill();
  ctx.clip();

  // Horizontal Fused Quartz Combustion Tube glowing hot center furnace zone when heated
  if (spec.isHorizontalTube && vessel.tempK >= 650) {
    const heatG = Math.min(1, (vessel.tempK - 650) / 850);
    const qGrad = ctx.createRadialGradient(x, y, 6, x, y, 52);
    qGrad.addColorStop(0, `rgba(251, 146, 60, ${(0.35 * heatG).toFixed(2)})`);
    qGrad.addColorStop(1, 'rgba(251, 146, 60, 0)');
    ctx.fillStyle = qGrad;
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
  }

  // Compute liquid & solid levels calibrated to VesselGeometry slice profile
  const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
  const liqMl = liqL * 1000;
  const solMl = computeSolidVolumeMl(vessel.moles);
  const iceMol = vessel.moles.H2O_s || 0;
  const iceMl = (iceMol * SPECIES.H2O_s.molarMass) / CONSTANTS.ICE_DENSITY_G_ML;
  const hasIce = iceMl > 0.15;
  const geom = computeVesselFluidGeometry(spec, y, liqMl + solMl);
  const uFillFrac = spec.isUTube ? Math.min(0.92, Math.max(0.08, (liqMl + solMl) / Math.max(1, spec.maxVolumeMl))) : null;
  const surfaceY = spec.isUTube
    ? geom.interiorBottom - uFillFrac * Math.max(12, geom.interiorBottom - top - 10)
    : geom.surfaceY;
  const { interiorBottom, scaleY, neckHalf, surfaceHalfWPx, volumeMlToY, volumeMlToState } = geom;
  const strat = vessel.liquidStratification || computePhaseStratification(vessel.moles, vessel.tempK, spec, solMl);
  const hasWater =
    liqMl > 0.15 &&
    ((vessel.moles.H2O_l || 0) > 1e-7 || (vessel.moles.C2H5OH_l || 0) > 1e-7 || (vessel.moles.CH3COOH_l || 0) > 1e-7 || strat.totalLiqMl > 0.15);

  // Colored headspace gas tint (Cl2 / NO2 / Br2 / I2) inside any upright vessel even without water
  if (!vessel.isInverted) {
    const hGas = vessel.headspaceGasMoles || {};
    const hBr2 = hGas.Br2_g || 0;
    const hI2 = hGas.I2_g || 0;
    const hNO2U = hGas.NO2_g || 0;
    const hCl2U = hGas.Cl2_g || 0;
    let tintCol = null;
    if (hBr2 > 5e-6) {
      tintCol = `rgba(185, 28, 28, ${Math.min(0.42, 0.14 + hBr2 * 40).toFixed(2)})`;
    } else if (hI2 > 1e-7) {
      tintCol = `rgba(168, 85, 247, ${Math.min(0.45, 0.08 + hI2 * 85).toFixed(2)})`;
    } else if (hNO2U > 5e-6) {
      tintCol = `rgba(217, 119, 6, ${Math.min(0.36, 0.12 + hNO2U * 35).toFixed(2)})`;
    } else if (hCl2U > 5e-6) {
      tintCol = `rgba(190, 242, 100, ${Math.min(0.30, 0.10 + hCl2U * 28).toFixed(2)})`;
    }
    if (tintCol) {
      ctx.fillStyle = tintCol;
      ctx.fillRect(x - w / 2, top, w, Math.max(4, (hasWater ? surfaceY : interiorBottom) - top));
    }
  }

  // Draw liquid body using Beer-Lambert + Phenolphthalein color (supports multi-phase liquid-liquid strata)
  if (hasWater) {
    const ph = computePH(vessel.moles, liqL, vessel.tempK);
    const vis = computeSolutionVisuals(
      vessel.moles,
      liqL,
      ph,
      spec.opticalPathCm,
      vessel.phenBleachFrac,
      vessel.phenIrrevFrac || 0,
      {
        phaseFilter: 'all',
        suspensionLevel: vessel.suspensionLevel || 0,
        soapScorchFrac: vessel.soapScorchFrac || 0,
        esterOverheatFrac: vessel.esterOverheatFrac || 0,
      }
    );

    if (vessel.isInverted) {
      ctx.fillStyle = vis.css;
      // Inverted pneumatic vessel: water occupies mouth section upward cleanly, leaving top dome for collected gas
      const liqFillFrac = Math.max(0.05, Math.min(0.98, liqMl / Math.max(1, spec.maxVolumeMl)));
      const divY = top + (interiorBottom - top) * liqFillFrac;
      ctx.fillRect(x - w / 2, top - 4, w, divY - top + 4);
      ctx.beginPath();
      ctx.moveTo(x - w * 0.45, divY);
      ctx.lineTo(x + w * 0.45, divY);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // Colored headspace gas tint (Cl2 pale green-yellow / NO2 amber) inside inverted upper dome
      const hCl2 = vessel.headspaceGasMoles?.Cl2_g || 0;
      const hNO2 = vessel.headspaceGasMoles?.NO2_g || 0;
      const hBr2Inv = vessel.headspaceGasMoles?.Br2_g || 0;
      const hI2Inv = vessel.headspaceGasMoles?.I2_g || 0;
      if (vessel.isInverted && (hCl2 > 1e-6 || hNO2 > 1e-6 || hBr2Inv > 1e-6 || hI2Inv > 1e-6)) {
        ctx.fillStyle = hBr2Inv > 1e-6 ? 'rgba(185, 28, 28, 0.36)' : hI2Inv > 1e-6 ? 'rgba(168, 85, 247, 0.36)' : hNO2 >= hCl2 ? 'rgba(217, 119, 6, 0.34)' : 'rgba(190, 242, 100, 0.32)';
        ctx.fillRect(x - w / 2, divY, w, interiorBottom - divY + 4);
      }
    } else if (Math.abs(effTilt) > 0.015) {
      // Horizontally clipped liquid surface matching exact 3D rotational VesselGeometry volume at effTilt
      const totalFillMl = liqMl + solMl;
      const bigSpan = Math.max(w, h) * 2.2;
      if (strat.isMultiPhase && strat.layers.length >= 2) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-effTilt);
        for (let li = 0; li < strat.layers.length; li++) {
          const layer = strat.layers[li];
          const topTargetMl = li === strat.layers.length - 1 ? totalFillMl : layer.topMl;
          const layClipTopY = findTiltClipY3D(spec, topTargetMl, effTilt);
          const layClipBotY = li === 0 ? bigSpan : findTiltClipY3D(spec, layer.botMl, effTilt);
          if (!Number.isFinite(layClipTopY) && layClipTopY !== -Infinity) continue;
          const yTop = layClipTopY === -Infinity ? -bigSpan : layClipTopY;
          const yBot = !Number.isFinite(layClipBotY) ? bigSpan : layClipBotY;
          const layVis = computeSolutionVisuals(
            vessel.moles,
            Math.max(1e-6, layer.volMl / 1000),
            ph,
            spec.opticalPathCm,
            vessel.phenBleachFrac,
            vessel.phenIrrevFrac || 0,
            {
              phaseFilter: layer.phaseKey,
              suspensionLevel: layer.phaseKey === 'aqueous' ? (vessel.suspensionLevel || 0) : 0,
              soapScorchFrac: vessel.soapScorchFrac || 0,
              esterOverheatFrac: vessel.esterOverheatFrac || 0,
            }
          );
          ctx.fillStyle = layVis.css;
          ctx.fillRect(-bigSpan, yTop, bigSpan * 2, Math.max(1, yBot - yTop));
          if (li < strat.layers.length - 1 || li === strat.layers.length - 1) {
            ctx.beginPath();
            ctx.moveTo(-bigSpan, yTop);
            ctx.lineTo(bigSpan, yTop);
            ctx.strokeStyle = li === strat.layers.length - 1
              ? 'rgba(255, 255, 255, 0.72)'
              : isDark ? 'rgba(226, 232, 240, 0.74)' : 'rgba(148, 163, 184, 0.85)';
            ctx.lineWidth = 1.6;
            ctx.stroke();
          }
        }
        ctx.restore();
      } else {
        const clipLocalY = findTiltClipY3D(spec, totalFillMl, effTilt);
        if (clipLocalY === -Infinity || Number.isFinite(clipLocalY)) {
          const drawTopY = clipLocalY === -Infinity ? -bigSpan : clipLocalY;
          const sw = vessel._surfaceWave;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(-effTilt);
          ctx.fillStyle = vis.css;
          if (sw?.active && !hasIce && Number.isFinite(clipLocalY)) {
            const waveHalfSpan = Math.max(w, h) * 0.65;
            ctx.beginPath();
            ctx.moveTo(-bigSpan, bigSpan);
            ctx.lineTo(-bigSpan, drawTopY + sw.h[0]);
            for (let wi = 0; wi < sw.n; wi++) {
              const wx = -waveHalfSpan + (wi / (sw.n - 1)) * waveHalfSpan * 2;
              ctx.lineTo(wx, drawTopY + sw.h[wi]);
            }
            ctx.lineTo(bigSpan, drawTopY + sw.h[sw.n - 1]);
            ctx.lineTo(bigSpan, bigSpan);
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(-bigSpan, drawTopY + sw.h[0]);
            for (let wi = 0; wi < sw.n; wi++) {
              const wx = -waveHalfSpan + (wi / (sw.n - 1)) * waveHalfSpan * 2;
              ctx.lineTo(wx, drawTopY + sw.h[wi]);
            }
            ctx.lineTo(bigSpan, drawTopY + sw.h[sw.n - 1]);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
            ctx.lineWidth = 1.6;
            ctx.stroke();
          } else {
            ctx.fillRect(-bigSpan, drawTopY, bigSpan * 2, bigSpan - drawTopY);
            if (Number.isFinite(clipLocalY)) {
              ctx.beginPath();
              ctx.moveTo(-bigSpan, clipLocalY);
              ctx.lineTo(bigSpan, clipLocalY);
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
              ctx.lineWidth = 1.6;
              ctx.stroke();
            }
          }
          ctx.restore();
        }
      }
    } else {
      if (strat.isMultiPhase && strat.layers.length >= 2) {
        for (let li = 0; li < strat.layers.length; li++) {
          const layer = strat.layers[li];
          const layTopY = li === strat.layers.length - 1 ? surfaceY : volumeMlToY(layer.topMl);
          const layBotY = li === 0 ? interiorBottom + 4 : volumeMlToY(layer.botMl);
          const layVis = computeSolutionVisuals(
            vessel.moles,
            Math.max(1e-6, layer.volMl / 1000),
            ph,
            spec.opticalPathCm,
            vessel.phenBleachFrac,
            vessel.phenIrrevFrac || 0,
            {
              phaseFilter: layer.phaseKey,
              suspensionLevel: layer.phaseKey === 'aqueous' ? (vessel.suspensionLevel || 0) : 0,
              soapScorchFrac: vessel.soapScorchFrac || 0,
              esterOverheatFrac: vessel.esterOverheatFrac || 0,
            }
          );
          ctx.fillStyle = layVis.css;
          ctx.fillRect(x - w / 2, layTopY, w, Math.max(1, layBotY - layTopY));
          if (li < strat.layers.length - 1) {
            ctx.beginPath();
            ctx.moveTo(x - w / 2, layTopY);
            ctx.lineTo(x + w / 2, layTopY);
            ctx.strokeStyle = isDark ? 'rgba(226, 232, 240, 0.74)' : 'rgba(148, 163, 184, 0.85)';
            ctx.lineWidth = 1.6;
            ctx.stroke();
          }
        }
      } else {
        const sw = vessel._surfaceWave;
        ctx.fillStyle = vis.css;
        if (sw?.active && !hasIce && !spec.isUTube) {
          ctx.beginPath();
          ctx.moveTo(x - w / 2, interiorBottom + 4);
          const spanHalf = Math.max(surfaceHalfWPx + 6, w * 0.48);
          for (let wi = 0; wi < sw.n; wi++) {
            const wx = x - spanHalf + (wi / (sw.n - 1)) * spanHalf * 2;
            ctx.lineTo(wx, surfaceY + sw.h[wi]);
          }
          ctx.lineTo(x + w / 2, interiorBottom + 4);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(x - w / 2, surfaceY, w, interiorBottom - surfaceY + 4);
        }
      }

      // 2D local concentration diffusion plume (e.g. NaOH drop in Phenolphthalein or CuSO4 crystal) + Stir-bar swirl vortex
      const cf = vessel._concField;
      const liqH = Math.max(8, interiorBottom - surfaceY);
      if (cf) {
        const cellW = (w * 0.84) / cf.w;
        const cellH = liqH / cf.h;
        const gx0 = x - (w * 0.42);
        ctx.save();
        for (let j = 0; j < cf.h; j++) {
          for (let i = 0; i < cf.w; i++) {
            const idx = j * cf.w + i;
            const pv = cf.pink[idx];
            const cv = cf.copper[idx];
            if (pv > 0.04) {
              const cx = gx0 + (i + 0.5) * cellW;
              const cy = surfaceY + (j + 0.5) * cellH;
              const pr = Math.max(cellW, cellH) * 1.45;
              const pg = ctx.createRadialGradient(cx, cy, 0.5, cx, cy, pr);
              pg.addColorStop(0, `rgba(236, 72, 153, ${Math.min(0.86, pv * 0.85).toFixed(2)})`);
              pg.addColorStop(1, 'rgba(236, 72, 153, 0)');
              ctx.fillStyle = pg;
              ctx.beginPath();
              ctx.arc(cx, cy, pr, 0, Math.PI * 2);
              ctx.fill();
            }
            if (cv > 0.04) {
              const cx = gx0 + (i + 0.5) * cellW;
              const cy = surfaceY + (j + 0.5) * cellH;
              const cr = Math.max(cellW, cellH) * 1.45;
              const cg = ctx.createRadialGradient(cx, cy, 0.5, cx, cy, cr);
              cg.addColorStop(0, `rgba(14, 165, 233, ${Math.min(0.75, cv * 0.72).toFixed(2)})`);
              cg.addColorStop(1, 'rgba(14, 165, 233, 0)');
              ctx.fillStyle = cg;
              ctx.beginPath();
              ctx.arc(cx, cy, cr, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        if (vessel.hasStirBar && (vessel.magStirRpm || 0) > 40) {
          const ang = cf.swirlAngleRad || (timeNow || 0) * 6;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
          ctx.lineWidth = 1.4;
          for (let s = 0; s < 3; s++) {
            const cy = surfaceY + liqH * (0.28 + s * 0.24);
            const sx = Math.sin(ang + s * 2.1) * (w * 0.24);
            ctx.beginPath();
            ctx.ellipse(x + sx * 0.25, cy, w * 0.26, 3.2, 0, ang + s, ang + s + Math.PI * 0.85);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      if (!hasIce) {
        if (spec.isUTube) {
          const dxU = spec.limbSpacingX || 28;
          const armR = (spec.tubeOuterR || 13) - 3;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.58)';
          ctx.lineWidth = 1.5;
          for (const armSign of [-1, 1]) {
            const cxArm = x + armSign * dxU;
            ctx.beginPath();
            ctx.moveTo(cxArm - armR, surfaceY);
            ctx.quadraticCurveTo(cxArm, surfaceY + 2.5, cxArm + armR, surfaceY);
            ctx.stroke();
          }
        } else {
          // Concave meniscus (or 1D slosh wave curve / deeper vortex funnel when magnetic stir bar spins rapidly)
          const sw = vessel._surfaceWave;
          const vortexDip = (vessel.magStirRpm || 0) > 0 && vessel.hasStirBar && !vessel.isFrozenSolid
            ? 3.5 + Math.min(10, (vessel.magStirRpm / 1200) * 9) + Math.sin(timeNow * 24) * 1.2
            : 3.2;
          ctx.beginPath();
          if (sw?.active && !vessel.hasStirBar) {
            for (let wi = 0; wi < sw.n; wi++) {
              const fracW = wi / (sw.n - 1);
              const wx = x - surfaceHalfWPx + fracW * surfaceHalfWPx * 2;
              const sag = 2.0 * Math.sin(Math.PI * fracW);
              if (wi === 0) ctx.moveTo(wx, surfaceY + sw.h[wi]);
              else ctx.lineTo(wx, surfaceY + sw.h[wi] + sag);
            }
          } else {
            ctx.moveTo(x - surfaceHalfWPx, surfaceY);
            ctx.quadraticCurveTo(x, surfaceY + vortexDip, x + surfaceHalfWPx, surfaceY);
          }
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      }
      // Exp 15: Subtle crystalline shimmer along meniscus when solution is metastable supersaturated
      if (vessel.isSupersaturated && !hasIce) {
        ctx.save();
        const shimmer = 0.22 + 0.14 * Math.sin(timeNow * 4.5);
        ctx.strokeStyle = `rgba(125, 211, 252, ${shimmer.toFixed(2)})`;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(x - surfaceHalfWPx, surfaceY + 1.5);
        ctx.quadraticCurveTo(x, surfaceY + 4.5, x + surfaceHalfWPx, surfaceY + 1.5);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Durable white soap lather foam column during warm / stirred saponification
    if ((vessel.soapFoamMl || 0) > 0.3 && !vessel.isInverted && !vessel.isFrozenSolid) {
      const sFoamTopY = Math.max(top - 4, volumeMlToY(liqMl + solMl + vessel.soapFoamMl));
      const sFoamH = Math.max(2, surfaceY - sFoamTopY);
      ctx.save();
      const sGrad = ctx.createLinearGradient(0, surfaceY, 0, sFoamTopY);
      sGrad.addColorStop(0, 'rgba(241, 245, 249, 0.58)');
      sGrad.addColorStop(0.55, 'rgba(248, 250, 252, 0.74)');
      sGrad.addColorStop(1, 'rgba(255, 255, 255, 0.88)');
      ctx.fillStyle = sGrad;
      ctx.fillRect(x - w / 2, sFoamTopY, w, sFoamH + 2.5);
      const sCount = Math.min(42, Math.max(8, Math.round(sFoamH * 1.1)));
      for (let c = 0; c < sCount; c++) {
        const cx = x - w * 0.44 + (((c * 67 + 13) % 100) / 100) * w * 0.88;
        const cy = sFoamTopY + 1.5 + (((c * 113 + 31) % 100) / 100) * Math.max(2, sFoamH - 3);
        const cr = 1.4 + ((c * 19) % 3) * 0.85;
        ctx.beginPath();
        ctx.arc(cx, cy, cr, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(203, 213, 225, 0.62)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Exp 20: Pickering Colloidal Foam column (Cu(OH)2 floc + O2 microbubbles, rose-lavender with Phenolphthalein)
    if ((vessel.pickeringFoamMl || 0) > 0.3 && !vessel.isInverted && !vessel.isFrozenSolid) {
      const foamTopY = Math.max(top - 6, volumeMlToY(liqMl + solMl + vessel.pickeringFoamMl));
      const foamH = Math.max(2, surfaceY - foamTopY);
      const hasPhenBasic = (vessel.moles.Phenolphthalein_aq || 0) > 1e-9 && ph >= 8.2 && (vessel.phenBleachFrac || 0) < 0.7;
      ctx.save();
      const foamGrad = ctx.createLinearGradient(0, surfaceY, 0, foamTopY);
      if (hasPhenBasic) {
        foamGrad.addColorStop(0, 'rgba(219, 39, 119, 0.56)');
        foamGrad.addColorStop(0.55, 'rgba(244, 114, 182, 0.68)');
        foamGrad.addColorStop(1, 'rgba(251, 207, 232, 0.80)');
      } else {
        foamGrad.addColorStop(0, 'rgba(56, 189, 248, 0.42)');
        foamGrad.addColorStop(0.6, 'rgba(186, 230, 253, 0.56)');
        foamGrad.addColorStop(1, 'rgba(241, 245, 249, 0.72)');
      }
      ctx.fillStyle = foamGrad;
      ctx.fillRect(x - w / 2, foamTopY, w, foamH + 3);

      const cellCount = Math.min(48, Math.max(8, Math.round(foamH * 0.9)));
      for (let c = 0; c < cellCount; c++) {
        const s1 = ((c * 73 + 19) % 100) / 100;
        const s2 = ((c * 137 + 41) % 100) / 100;
        const cx = x - w * 0.42 + s1 * w * 0.84;
        const cy = foamTopY + 2 + s2 * Math.max(2, foamH - 4);
        const cr = 2.0 + ((c * 29) % 3) * 1.1;
        ctx.beginPath();
        ctx.arc(cx, cy, cr, 0, Math.PI * 2);
        ctx.fillStyle = hasPhenBasic ? 'rgba(253, 242, 248, 0.34)' : 'rgba(255, 255, 255, 0.36)';
        ctx.fill();
        ctx.strokeStyle = hasPhenBasic ? 'rgba(244, 114, 182, 0.58)' : 'rgba(148, 163, 184, 0.45)';
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Phenomenon #2: Ammonia Fountain vertical spraying jet inside vacuum-suction flask
  if ((vessel.fountainFlowMlS || 0) > 0.5 && !vessel.isShattered) {
    ctx.save();
    const fCol = vessel.fountainFlowColor || 'rgba(236, 72, 153, 0.88)';
    const jetBaseY = top + 6;
    const jetPeakY = top + (interiorBottom - top) * 0.86;
    const jetGrad = ctx.createLinearGradient(x, jetBaseY, x, jetPeakY);
    jetGrad.addColorStop(0, fCol);
    jetGrad.addColorStop(1, 'rgba(244, 114, 182, 0.45)');
    ctx.strokeStyle = jetGrad;
    ctx.lineWidth = 4.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, jetBaseY);
    ctx.lineTo(x, jetPeakY);
    ctx.stroke();

    ctx.fillStyle = fCol;
    for (let k = 0; k < 10; k++) {
      const ang = (k / 10) * Math.PI + (Math.sin(timeNow * 12 + k) * 0.15);
      const rad = 10 + ((timeNow * 45 + k * 7) % 24);
      const sx = x + Math.cos(ang) * rad * 0.85;
      const sy = jetPeakY - Math.abs(Math.sin(ang)) * rad * 0.55;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Dynamic Solid Behavior Overlay (free rolling grains, sticky hygroscopic clumps, buoyant/sinking, shrinking dissolution)
  if (Array.isArray(vessel._solidBodies) && vessel._solidBodies.length > 0 && !vessel.isShattered) {
    ctx.save();
    for (const b of vessel._solidBodies) {
      if (b.r < 0.75) continue;
      ctx.save();
      ctx.translate(x + b.x, y + b.y);
      ctx.rotate(b.angle || 0);
      ctx.fillStyle = b.color || '#cbd5e1';
      ctx.beginPath();
      if (b.behavior?.group === 1) {
        ctx.roundRect(-b.r, -b.r * 0.75, b.r * 2, b.r * 1.5, Math.min(2, b.r * 0.45));
      } else {
        ctx.arc(0, 0, b.r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.strokeStyle = b.highlight || 'rgba(255,255,255,0.65)';
      ctx.lineWidth = 0.6;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // Phenomenon #3: Gleaming metallic Silver Mirror film lining the lower wetted wall
  if ((vessel.silverMirrorFrac || 0) > 0.02 && !vessel.isShattered) {
    const mirAlpha = Math.min(0.68, vessel.silverMirrorFrac * 0.68);
    ctx.save();
    const mirGrad = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    mirGrad.addColorStop(0, `rgba(148, 163, 184, ${mirAlpha})`);
    mirGrad.addColorStop(0.28, `rgba(248, 250, 252, ${(mirAlpha * 1.1).toFixed(2)})`);
    mirGrad.addColorStop(0.55, `rgba(100, 116, 139, ${(mirAlpha * 0.8).toFixed(2)})`);
    mirGrad.addColorStop(0.82, `rgba(241, 245, 249, ${(mirAlpha * 1.05).toFixed(2)})`);
    mirGrad.addColorStop(1, `rgba(148, 163, 184, ${mirAlpha})`);
    ctx.fillStyle = mirGrad;
    const mirTopY = Math.max(top + 24, interiorBottom - Math.max(26, (interiorBottom - top) * 0.48));
    ctx.fillRect(x - w / 2, mirTopY, w, interiorBottom - mirTopY + 4);
    ctx.restore();
  }

  // Delicate white CaCO3(s) crystalline crust on quiescent open Ca(OH)2(aq) exposed to air CO2
  if ((vessel.caCo3FilmFrac || 0) > 0.03 && hasWater && !hasIce && surfaceY < interiorBottom - 3) {
    const fFrac = Math.min(1, vessel.caCo3FilmFrac || 0);
    const filmSpan = Math.max(8, surfaceHalfWPx - 1.5);
    const filmLeft = x - filmSpan * Math.min(1, 0.35 + 0.65 * fFrac);
    const filmRight = x + filmSpan * Math.min(1, 0.35 + 0.65 * fFrac);
    ctx.save();
    ctx.fillStyle = `rgba(248, 250, 252, ${(0.88 * fFrac).toFixed(2)})`;
    ctx.strokeStyle = isDark
      ? `rgba(203, 213, 225, ${(0.72 * fFrac).toFixed(2)})`
      : `rgba(100, 116, 139, ${(0.72 * fFrac).toFixed(2)})`;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.roundRect(filmLeft, surfaceY - 1.2, filmRight - filmLeft, 2.6, 1.2);
    ctx.fill();
    ctx.stroke();
    const plateCount = Math.max(4, Math.round(9 * fFrac));
    for (let i = 0; i < plateCount; i++) {
      const px = filmLeft + 3 + ((i + 0.5) / plateCount) * Math.max(4, filmRight - filmLeft - 6);
      ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#e2e8f0';
      ctx.fillRect(px - 1.4, surfaceY - 1.5, 2.8, 1.6);
    }
    ctx.restore();
  }

  // Draw rotating PTFE magnetic stir bar on vessel floor (or stopper/mouth bottom when inverted)
  if (vessel.hasStirBar) {
    const spinHalf = 11 * Math.max(0.28, Math.abs(Math.cos(vessel.stirBarPhase || 0)));
    const stirY = vessel.isInverted ? top + 2.5 : interiorBottom - 7;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - spinHalf, stirY, spinHalf * 2, 5.5, 2.5);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Draw porous SiC / ceramic boiling chips resting on vessel floor (anti-bumping nucleation sites)
  if (vessel.hasBoilingChips) {
    const chipY = vessel.isInverted ? top + 3.5 : interiorBottom - 4.5;
    ctx.save();
    const chipOffsets = [
      [-8, 0, 2.8, '#475569'],
      [-2, -1.2, 3.1, '#64748b'],
      [4, 0.4, 2.6, '#52525b'],
      [9, -0.8, 2.5, '#71717a'],
    ];
    for (const [dx, dy, r, col] of chipOffsets) {
      ctx.fillStyle = col;
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(x + dx, chipY + dy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if ((vessel.wasBoiling || (vessel.tempK || 298) >= 340) && !vessel.isFrozenSolid) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.68)';
      for (let b = 0; b < 6; b++) {
        const bx = x - 7 + b * 2.8 + Math.sin(timeNow * 7 + b) * 1.1;
        const by = chipY - 3 - ((timeNow * 24 + b * 11) % 22);
        if (by > surfaceY + 2) {
          ctx.beginPath();
          ctx.arc(bx, by, 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // Draw floating slush or solid frozen H2O(s) ice matrix with trapped solute tint & crystalline facets
  if (hasIce) {
    const iceFlippedByGravity = !hasWater && (vessel.isInverted || Math.cos(effTilt) < -0.08);
    ctx.save();
    if (iceFlippedByGravity) {
      ctx.translate(0, top + interiorBottom);
      ctx.scale(1, -1);
    }
    const aqSpanMl = Math.max(0.1, liqMl + iceMl);
    const iceFrac = Math.min(1, iceMl / aqSpanMl);
    const totalHeight = Math.max(4, interiorBottom - surfaceY);
    const iceBottomY = iceFrac >= 0.96 ? interiorBottom + 4 : surfaceY + Math.max(4, totalHeight * iceFrac);

    // Subtle trapped solute color behind frost matrix (e.g. dilute Cu2+ sky-blue or basic Phenolphthalein pink)
    const trappedAqL = Math.max(liqL, iceMl / 1000);
    const trappedVis = computeSolutionVisuals(
      vessel.moles,
      trappedAqL,
      computePH(vessel.moles, trappedAqL, vessel.tempK),
      spec.opticalPathCm,
      vessel.phenBleachFrac,
      vessel.phenIrrevFrac || 0
    );
    ctx.save();
    if (!hasWater && trappedVis?.css) {
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = trappedVis.css;
      ctx.fillRect(x - w / 2, surfaceY, w, iceBottomY - surfaceY);
    }

    // Translucent glacier ice body & frost facets (high contrast in both Light and Dark themes)
    ctx.globalAlpha = 1;
    const iceGrad = ctx.createLinearGradient(x, surfaceY, x, iceBottomY);
    iceGrad.addColorStop(0, isDark ? 'rgba(224, 242, 254, 0.74)' : 'rgba(186, 230, 253, 0.80)');
    iceGrad.addColorStop(0.5, isDark ? 'rgba(186, 230, 253, 0.56)' : 'rgba(125, 211, 252, 0.62)');
    iceGrad.addColorStop(1, isDark ? 'rgba(147, 197, 253, 0.44)' : 'rgba(96, 165, 250, 0.50)');
    ctx.fillStyle = iceGrad;
    ctx.fillRect(x - w / 2, surfaceY, w, iceBottomY - surfaceY);

    // Internal crystalline fracture lines
    ctx.strokeStyle = isDark ? 'rgba(248, 250, 252, 0.48)' : 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1;
    const bandH = Math.max(4, iceBottomY - surfaceY);
    const numFractures = Math.min(8, Math.max(3, Math.floor(bandH / 10)));
    ctx.beginPath();
    for (let i = 0; i < numFractures; i++) {
      const fy = surfaceY + 3 + ((i + 0.4) / numFractures) * Math.max(2, bandH - 6);
      const fx = x + (((i * 0.618 + 0.19) % 1) - 0.5) * surfaceHalfWPx * 1.3;
      ctx.moveTo(fx - 7, fy + 2.5);
      ctx.lineTo(fx, fy - 1.5);
      ctx.lineTo(fx + 6, fy + 1.5);
    }
    ctx.stroke();

    // Jagged crystalline ice top ridge
    ctx.beginPath();
    ctx.moveTo(x - surfaceHalfWPx, surfaceY);
    const segs = 6;
    for (let s = 1; s <= segs; s++) {
      const sx = x - surfaceHalfWPx + (s / segs) * (2 * surfaceHalfWPx);
      const sy = surfaceY + (s < segs ? (s % 2 === 0 ? 1.2 : -1.2) : 0);
      ctx.lineTo(sx, sy);
    }
    ctx.strokeStyle = isDark ? 'rgba(240, 249, 255, 0.85)' : 'rgba(2, 132, 199, 0.65)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  // Draw solids, crystals, precipitates, and floating Na inside clipped region
  // Mirror gravity-bound solids cleanly against the bottom mouth/stopper when inverted OR tilted > 95° upside-down!
  const invertedNeckSpan = Math.min(w - 8, Math.max(20, (spec.neckRadius || w * 0.24) * 2.15));
  const isUpsideDownByTilt = !vessel.isInverted && Math.cos(effTilt) < -0.08;
  const isBottomAtMouth = vessel.isInverted || isUpsideDownByTilt;
  const currentWidthAtBottom = isBottomAtMouth ? invertedNeckSpan : w - 6;
  const naInterfaceY = vessel.naInterfaceMl != null && strat.hasLightCover ? volumeMlToY(vessel.naInterfaceMl) : null;
  const solidBulkMl = solMl * 1.25;
  const solidPileTopY = solidBulkMl > 1e-4 ? Math.max(top + 2, volumeMlToY(Math.min(spec.maxVolumeMl * 1.04, solidBulkMl))) : interiorBottom;
  let solidSurfaceY = surfaceY;
  ctx.save();
  if (isBottomAtMouth) {
    ctx.translate(0, top + interiorBottom);
    ctx.scale(1, -1);
    if (hasWater) {
      const invFrac = Math.max(0.05, Math.min(0.98, liqMl / Math.max(1, spec.maxVolumeMl)));
      const invDivY = top + (interiorBottom - top) * invFrac;
      solidSurfaceY = top + interiorBottom - invDivY;
    }
  } else if (Math.abs(effTilt) > 0.08) {
    // Gentle downhill gravity slump when tilted toward one side (without crossing past horizontal)
    ctx.translate(x, interiorBottom - 2);
    ctx.rotate(-effTilt * 0.45);
    ctx.translate(-x, -(interiorBottom - 2));
  }
  renderVesselSolids(
    ctx,
    vessel,
    {
      left: x - currentWidthAtBottom / 2,
      right: x + currentWidthAtBottom / 2,
      bottom: interiorBottom,
      top,
      width: currentWidthAtBottom,
      naInterfaceY,
      solidPileTopY,
      solidBulkMl,
    },
    hasWater,
    solidSurfaceY
  );
  ctx.restore();

  // Glassware Surface Memory: Persistent Tollens Silver Mirror, stubborn CuO/BaSO4 wall crust, and NH4Cl frost dust
  if ((vessel.silverMirrorLevel || 0) > 0.04) {
    const mirAlpha = Math.min(0.92, (vessel.silverMirrorLevel || 0) * 0.92);
    ctx.save();
    ctx.globalAlpha = mirAlpha;
    const mirGrad = ctx.createLinearGradient(x - w / 2, top + h * 0.2, x + w / 2, bottom);
    mirGrad.addColorStop(0, '#94a3b8');
    mirGrad.addColorStop(0.28, '#f8fafc');
    mirGrad.addColorStop(0.5, '#cbd5e1');
    mirGrad.addColorStop(0.72, '#ffffff');
    mirGrad.addColorStop(1, '#64748b');
    ctx.fillStyle = mirGrad;
    ctx.fillRect(x - w / 2, top + h * 0.22, w, h * 0.78);
    // Metallic vertical gleam reflection
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = Math.max(2, w * 0.06);
    ctx.beginPath();
    ctx.moveTo(x - w * 0.22, top + h * 0.28);
    ctx.lineTo(x - w * 0.22, bottom - 6);
    ctx.stroke();
    ctx.restore();
  }
  const resMap = vessel.wallResidueMap || {};
  if ((resMap.CuO_s || 0) > 0.05 || (resMap.BaSO4_s || 0) > 0.05) {
    ctx.save();
    if ((resMap.CuO_s || 0) > 0.05) {
      ctx.fillStyle = `rgba(30, 27, 24, ${Math.min(0.55, resMap.CuO_s * 0.55).toFixed(2)})`;
      for (let k = 0; k < 7; k++) {
        const px = x + Math.sin(k * 2.4 + (vessel.id?.charCodeAt?.(0) || 1)) * w * 0.3;
        const py = bottom - 8 - (k % 4) * 9;
        ctx.beginPath();
        ctx.arc(px, py, 2.8 + (k % 3), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if ((resMap.BaSO4_s || 0) > 0.05) {
      ctx.fillStyle = `rgba(241, 245, 249, ${Math.min(0.62, resMap.BaSO4_s * 0.6).toFixed(2)})`;
      for (let k = 0; k < 8; k++) {
        const px = x + Math.cos(k * 1.9 + 1) * w * 0.32;
        const py = bottom - 7 - (k % 5) * 8;
        ctx.beginPath();
        ctx.arc(px, py, 2.5 + (k % 2), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  if ((vessel.nh4clFrostLevel || 0) > 0.04) {
    ctx.save();
    const nAlpha = Math.min(0.62, (vessel.nh4clFrostLevel || 0) * 0.65);
    const nGrad = ctx.createLinearGradient(x, top, x, top + h * 0.55);
    nGrad.addColorStop(0, `rgba(245, 248, 255, ${nAlpha.toFixed(2)})`);
    nGrad.addColorStop(1, 'rgba(245, 248, 255, 0)');
    ctx.fillStyle = nGrad;
    ctx.fillRect(x - w / 2, top, w, h * 0.55);
    ctx.restore();
  }

  // Inner glass condensation mist & micro-droplets on upper cooler neck/walls
  if ((vessel.wallCondenseLevel || 0) > 0.05) {
    const condAlpha = Math.min(0.65, vessel.wallCondenseLevel * 0.68);
    const upperLimitY = Math.min(surfaceY - 8, top + h * 0.44);
    if (upperLimitY > top + 12) {
      ctx.save();
      ctx.globalAlpha = condAlpha * 0.35;
      const fogGrad = ctx.createLinearGradient(x, top + 4, x, upperLimitY);
      fogGrad.addColorStop(0, 'rgba(224, 242, 254, 0.45)');
      fogGrad.addColorStop(1, 'rgba(224, 242, 254, 0)');
      ctx.fillStyle = fogGrad;
      ctx.fillRect(x - w / 2, top + 4, w, upperLimitY - (top + 4));

      ctx.globalAlpha = condAlpha;
      ctx.fillStyle = isDark ? 'rgba(224, 242, 254, 0.85)' : 'rgba(56, 189, 248, 0.65)';
      const halfSpan =
        spec.shape === 'erlenmeyer' || spec.shape === 'round_flask'
          ? Math.max(8, (spec.neckRadius || 18) * 1.1)
          : w * 0.38;
      for (let i = 0; i < 12; i++) {
        const dx = x + (((i * 0.618 + 0.17) % 1) - 0.5) * 2 * halfSpan;
        const dy = top + 12 + (((i * 0.37 + 0.09) % 1) * (upperLimitY - top - 14));
        const r = 1.0 + (i % 3) * 0.55;
        ctx.beginPath();
        ctx.arc(dx, dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // Outer/inner rime frost crystals coating cold vessel glass (< 0°C)
  if ((vessel.frostOpacity || 0) > 0.03) {
    const fAlpha = Math.min(0.82, (vessel.frostOpacity || 0) * 0.78);
    ctx.save();
    const frostGrad = ctx.createLinearGradient(x, top + 2, x, interiorBottom + 2);
    frostGrad.addColorStop(0, isDark ? `rgba(224, 242, 254, ${0.42 * fAlpha})` : `rgba(186, 230, 253, ${0.52 * fAlpha})`);
    frostGrad.addColorStop(0.55, isDark ? `rgba(224, 242, 254, ${0.22 * fAlpha})` : `rgba(186, 230, 253, ${0.28 * fAlpha})`);
    frostGrad.addColorStop(1, isDark ? `rgba(186, 230, 253, ${0.46 * fAlpha})` : `rgba(125, 211, 252, ${0.56 * fAlpha})`);
    ctx.fillStyle = frostGrad;
    ctx.fillRect(x - w / 2, top + 2, w, interiorBottom - top + 2);

    // Microscopic snowflake/rime needles on glass walls
    ctx.strokeStyle = isDark ? `rgba(248, 250, 252, ${0.62 * fAlpha})` : `rgba(14, 165, 233, ${0.52 * fAlpha})`;
    ctx.lineWidth = 0.85;
    const spanW =
      spec.shape === 'erlenmeyer' || spec.shape === 'round_flask'
        ? Math.max(12, (spec.neckRadius || 18) * 1.4)
        : w * 0.42;
    for (let i = 0; i < 14; i++) {
      const fx = x + (((i * 0.618 + 0.13) % 1) - 0.5) * 2 * spanW;
      const fy = top + 12 + (((i * 0.41 + 0.07) % 1) * Math.max(12, interiorBottom - top - 20));
      const arm = 1.8 + (i % 3) * 0.7;
      ctx.beginPath();
      ctx.moveTo(fx - arm, fy);
      ctx.lineTo(fx + arm, fy);
      ctx.moveTo(fx, fy - arm);
      ctx.lineTo(fx, fy + arm);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Stirring rod animation inside vessel
  if (vessel.stirTimer > 0) {
    const swing = Math.sin(timeNow * 14) * (w * 0.2);
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + swing * 0.4, top - 14);
    ctx.lineTo(x + swing, interiorBottom - 6);
    ctx.stroke();
  }

  ctx.restore(); // Remove clip

  // Blit offscreen-cached static glass silhouette, selection/thermal halo, specular highlight, and ISO graduations
  const shellEntry = getCachedVesselGlassShell(spec, pal, isDark, isSelected, isDropTarget, vessel.softenGlowFrac || 0, sagFrac);
  if (shellEntry) {
    const { canvas: sCvs, pad, textDraws } = shellEntry;
    ctx.drawImage(sCvs, x - w / 2 - pad, y - h / 2 - pad, w + pad * 2, h + pad * 2);
    if (textDraws?.length) {
      ctx.save();
      for (const td of textDraws) {
        ctx.font = td.font;
        ctx.fillStyle = td.fillStyle;
        ctx.textAlign = td.textAlign;
        ctx.textBaseline = td.textBaseline;
        ctx.fillText(td.text, x + td.dx, y + td.dy);
      }
      ctx.restore();
    }
  }

  // Horizontal Fused Quartz Tube & U-Shaped Quartz Tube double-ended stoppers, phen cotton plugs & tubing ports
  if (spec.hasTwoEnds && !vessel.isShattered) {

    const ends = getVesselEndPorts(vessel);
    const connSide = vessel.connectedPortSide || (vessel.flippedX ? 'left' : 'right');
    const isHoledStopper = vessel.stopperMode !== 'solid';
    for (const side of ['left', 'right']) {
      const ep = ends?.[side];
      if (!ep) continue;
      const hasPhysStop = side === 'left' ? vessel._physStopperLeft : vessel._physStopperRight;
      const hasPhysCotton = side === 'left' ? vessel._physCottonLeft : vessel._physCottonRight;
      const isClosed = Boolean(side === 'left' ? vessel.leftStoppered : vessel.rightStoppered);
      const hasCottonFlag = Boolean(side === 'left' ? vessel.leftHasPhenCotton : vessel.rightHasPhenCotton);

      if (isClosed && !hasPhysStop) {
        ctx.fillStyle = '#334155';
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (spec.isHorizontalTube) {
          ctx.roundRect(ep.mouthX - 5, ep.mouthY - h * 0.42, 10, h * 0.84, 2);
        } else {
          ctx.roundRect(ep.mouthX - 11, ep.mouthY - 6, 22, 12, 2.5);
        }
        ctx.fill();
        ctx.stroke();

        if (isHoledStopper && (!vessel.connectedTargetId || connSide === side)) {
          const isConn = Boolean((vessel.connectedTargetId || vessel.connectedSyringeId) && connSide === side);
          ctx.fillStyle = isConn ? '#f59e0b' : pal.badgeBg;
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(ep.x, ep.y, 4.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else if (!isClosed && hasCottonFlag && !hasPhysCotton) {
        const cLvl = Math.max(0, Math.min(1, (side === 'left' ? vessel.phenCottonLeftLevel : vessel.phenCottonRightLevel) || 0));
        const r = Math.round(244 * cLvl + 241 * (1 - cLvl));
        const g = Math.round(114 * cLvl + 245 * (1 - cLvl));
        const b = Math.round(182 * cLvl + 249 * (1 - cLvl));
        ctx.save();
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.strokeStyle = cLvl > 0.25 ? '#ec4899' : '#cbd5e1';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(ep.mouthX, ep.mouthY, spec.isHorizontalTube ? 5.5 : 8.5, spec.isHorizontalTube ? 9.5 : 5.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Removable Stepped Porcelain Crucible Lid (`open` = off to side | `ajar` = crooked venting CO2 | `closed` = sealed)
  if (spec.hasLid && !vessel.isShattered) {
    const lState = vessel.lidState || 'open';
    ctx.save();
    if (lState === 'closed' || lState === 'ajar') {
      const shiftX = lState === 'ajar' ? 8 : 0;
      const shiftY = lState === 'ajar' ? -4 : 0;
      const tilt = lState === 'ajar' ? 0.22 : 0;
      ctx.translate(x + shiftX, top + shiftY);
      if (tilt) ctx.rotate(tilt);
      ctx.fillStyle = isDark ? '#e2e8f0' : '#ffffff';
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-w * 0.50, 0);
      ctx.quadraticCurveTo(0, -11, w * 0.50, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Knob ring handle at crown
      ctx.beginPath();
      ctx.arc(0, -8, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // Porcelain Pestle resting inside Mortar & Pestle (animates grinding circle on crush)
  if (spec.isMortar) {
    const gT = vessel.grindAnimTimer || 0;
    const gx = gT > 0 ? Math.sin(timeNow * 22) * 10 : 4;
    ctx.save();
    ctx.strokeStyle = isDark ? '#e2e8f0' : '#475569';
    ctx.lineWidth = 7.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + gx, interiorBottom - 7);
    ctx.lineTo(x + gx + 18, top - 20);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.restore();
  }

  // Comparison mode selection tag pill (⚖️ A / B / C)
  if (vessel.compareTag && !vessel.isShattered) {
    ctx.save();
    const tagCol = vessel.compareColor || '#38bdf8';
    ctx.fillStyle = tagCol;
    ctx.beginPath();
    ctx.roundRect(x - w / 2 - 4, top - 16, 26, 15, 5);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`⚖️${vessel.compareTag}`, x - w / 2 + 9, top - 8.5);
    ctx.restore();
  }

  // Rubber stopper on narrow-neck vessels sized proportionally to neck ID (skip dual-ended quartz tubes handled above)
  if (vessel.isStoppered && !vessel.isShattered && !spec.hasTwoEnds) {
    if (!vessel._physStopperMain) {
      let neckHalfPx = (spec.neckRadius || 16) - 1.5;
      if (spec.geometry?.profilePoints?.length >= 2) {
        const ptsP = spec.geometry.profilePoints;
        const maxR = Math.max(...ptsP.map((p) => p[1]), 0.1);
        const neckCm = ptsP[ptsP.length - 2][1];
        neckHalfPx = Math.max(9.5, (neckCm / maxR) * (w / 2 - 2));
      }
      const stopBot = Math.max(9.5, neckHalfPx + 0.8);
      const stopTop = stopBot + 3.8;
      ctx.fillStyle = '#334155';
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - stopTop, top - 8);
      ctx.lineTo(x + stopTop, top - 8);
      ctx.lineTo(x + stopBot, top + 9);
      ctx.lineTo(x - stopBot, top + 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      if (vessel.stopperMode !== 'solid') {
        if (vessel.stopperMode === 'dual_hole') {
          ctx.fillStyle = vessel._hasMountedSepFunnel ? 'rgba(56, 189, 248, 0.35)' : pal.glassFill;
          ctx.strokeStyle = vessel._hasMountedSepFunnel ? '#38bdf8' : pal.glassStroke;
          ctx.lineWidth = 1.1;
          ctx.fillRect(x - 9, top - 10, 6, 18);
          ctx.strokeRect(x - 9, top - 10, 6, 18);
        }
        const vPort = getVesselTubingPort(vessel);
        if (vPort) {
          const isConn = Boolean(vessel.connectedTargetId || vessel.connectedSyringeId);
          ctx.fillStyle = isConn ? '#f59e0b' : pal.badgeBg;
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(vPort.x, vPort.y, 4.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    if (themeName === 'olivia') {
      // Olivia Rodrigo "drop dead" pink heart padlock charm on sealed stopper
      ctx.save();
      const lx = x;
      const ly = top - 16;
      ctx.strokeStyle = '#221F20';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(lx, ly - 5, 4.2, Math.PI, 0);
      ctx.stroke();
      ctx.fillStyle = '#F4A5B8';
      ctx.beginPath();
      ctx.moveTo(lx, ly + 4.5);
      ctx.bezierCurveTo(lx - 6.5, ly - 0.5, lx - 5.5, ly - 5.5, lx, ly - 2.2);
      ctx.bezierCurveTo(lx + 5.5, ly - 5.5, lx + 6.5, ly - 0.5, lx, ly + 4.5);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  } else if (vessel.hasPhenCotton && !vessel.isShattered && !spec.hasTwoEnds && !vessel._physCottonMain) {
    // Phenolphthalein-soaked cotton/indicator strip at mouth (turns bright rose-pink on NH3 gas!)
    const cLvl = Math.max(0, Math.min(1, vessel.phenCottonLevel || 0));
    const r = Math.round(244 * cLvl + 241 * (1 - cLvl));
    const g = Math.round(114 * cLvl + 245 * (1 - cLvl));
    const b = Math.round(182 * cLvl + 249 * (1 - cLvl));
    const span = Math.max(10, (spec.neckRadius || 18) * 0.72);
    ctx.save();
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.strokeStyle = cLvl > 0.25 ? '#ec4899' : '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, top + 1, span, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Gradual rim overflow waterfall stream when filled past vessel mouth (open vessels only)
  if (!vessel.isStoppered && (vessel.overflowRateMlS || 0) > 0.5 && !vessel.isShattered) {
    const { pts } = mapProfileToCanvas(spec, x, y, 0);
    const rimPt = pts[pts.length - 1];
    const spoutExtra = spec.shape === 'beaker' || spec.shape === 'cylinder' ? 3.5 : 0;
    const rimX = x - rimPt.rx - spoutExtra;
    const rimY = rimPt.cy + 2;
    const streamW = Math.min(6.5, 2.2 + Math.sqrt(vessel.overflowRateMlS) * 0.35);
    const wobble = Math.sin((timeNow || 0) * 18) * 1.6;

    ctx.save();
    ctx.strokeStyle = vessel.overflowColor || 'rgba(186, 230, 253, 0.85)';
    ctx.lineWidth = streamW;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(rimX, rimY);
    ctx.quadraticCurveTo(rimX - 10 + wobble, rimY + h * 0.25, rimX - 12 - wobble * 0.5, bottom - 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = Math.max(1, streamW * 0.3);
    ctx.stroke();

    // Wet overflow puddle pooling beside the base
    ctx.fillStyle = vessel.overflowColor || 'rgba(186, 230, 253, 0.65)';
    ctx.globalAlpha = 0.62;
    ctx.beginPath();
    ctx.ellipse(rimX - 10, bottom - 1, 14 + Math.min(18, vessel.overflowRateMlS * 0.12), 4.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Exterior amorphous Carbon soot deposit from incomplete yellow Bunsen flame
  if ((vessel.sootLevel || 0) > 0.02 && !vessel.isShattered) {
    const sFrac = Math.min(1, vessel.sootLevel || 0);
    ctx.save();
    const sootSpan = Math.max(12, w * 0.42);
    const sGrad = ctx.createRadialGradient(x, bottom - 1, 3, x, bottom - 1, sootSpan);
    sGrad.addColorStop(0, `rgba(15, 23, 42, ${(0.88 * sFrac).toFixed(2)})`);
    sGrad.addColorStop(0.55, `rgba(30, 41, 59, ${(0.55 * sFrac).toFixed(2)})`);
    sGrad.addColorStop(1, 'rgba(15, 23, 42, 0)');
    ctx.fillStyle = sGrad;
    ctx.beginPath();
    ctx.ellipse(x, bottom - 1, sootSpan, Math.max(8, h * 0.18), 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();

  // Sticky note label affixed upright onto vessel body (`stickyLabel: { text, bgColor }`)
  if (vessel.stickyLabel?.text && !vessel.isShattered) {
    const rawTxt = String(vessel.stickyLabel.text).trim().slice(0, 30);
    if (rawTxt) {
      ctx.save();
      const noteBg = vessel.stickyLabel.bgColor || '#fef08a';
      const lines = rawTxt.includes('\n')
        ? rawTxt.split('\n').slice(0, 2)
        : rawTxt.length > 15
        ? [rawTxt.slice(0, 15).trim(), rawTxt.slice(15, 30).trim()].filter(Boolean)
        : [rawTxt];
      ctx.font = 'bold 8.5px system-ui, -apple-system, sans-serif';
      const maxTextW = Math.max(...lines.map((l) => ctx.measureText(l).width), 22);
      const noteW = Math.min(Math.max(40, w * 0.82), maxTextW + 14);
      const noteH = lines.length > 1 ? 26 : 16;
      const nx = x - noteW / 2;
      const ny = y - noteH / 2 + (spec.shape === 'erlenmeyer' || spec.shape === 'round_flask' ? h * 0.14 : 0);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.16)';
      ctx.beginPath();
      ctx.roundRect(nx + 0.8, ny + 1.8, noteW, noteH, 3);
      ctx.fill();
      ctx.fillStyle = noteBg;
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.25)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.roundRect(nx, ny, noteW, noteH, 3);
      ctx.fill();
      ctx.stroke();

      // Subtle folded bottom-right paper corner
      ctx.fillStyle = 'rgba(15, 23, 42, 0.12)';
      ctx.beginPath();
      ctx.moveTo(nx + noteW - 5, ny + noteH);
      ctx.lineTo(nx + noteW, ny + noteH - 5);
      ctx.lineTo(nx + noteW - 5, ny + noteH - 5);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#0f172a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (lines.length === 1) {
        ctx.fillText(formatCanvasText(lines[0]), x, ny + noteH / 2 + 0.5, noteW - 8);
      } else {
        ctx.fillText(formatCanvasText(lines[0]), x, ny + 8, noteW - 8);
        ctx.fillText(formatCanvasText(lines[1]), x, ny + 18.5, noteW - 8);
      }
      ctx.restore();
    }
  }

  // Gravity falling stream pouring downward from unstoppered unsubmerged inverted mouth
  if (vessel.isInverted && !vessel.isStoppered && !vessel.submergedInTroughId && (vessel.gravitySpillRateMlS || 0) > 0.2 && !vessel.isShattered) {
    const gWobble = Math.sin((timeNow || 0) * 20) * 1.6;
    ctx.save();
    ctx.strokeStyle = vessel.gravitySpillColor || 'rgba(186, 230, 253, 0.85)';
    ctx.lineWidth = Math.min(7, 2.8 + Math.sqrt(vessel.gravitySpillRateMlS) * 0.35);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, bottom - 2);
    ctx.quadraticCurveTo(x + gWobble, Math.min(482, bottom + 65), x - gWobble * 0.5, 482);
    ctx.stroke();
    ctx.restore();
  }

  // Floating Vessel Status Pill below/above vessel (Temp + pH + Volume + Inverted Gas Formula)
  const tempC = kelvinToCelsius(vessel.tempK);
  const tDisp = Math.abs(tempC) < 0.05 ? 0 : tempC;
  const isBlind = Boolean(vessel.hideComposition);
  const ph = hasWater && !vessel.isFrozenSolid && !isBlind ? computePH(vessel.moles, liqL, vessel.tempK) : null;
  const shownName = isBlind ? (vessel.blindLabel || vessel.label) : vessel.label;
  const pillParts = [vessel.isInverted ? `🙃 ${shownName}` : shownName];
  if (!isBlind && (vessel.isInverted || Object.values(vessel.headspaceGasMoles || {}).some((n) => (n || 0) > 1e-6))) {
    const gasEntries = Object.entries(vessel.headspaceGasMoles || {})
      .filter(([gId, n]) => gId !== 'H2O_g' && (n || 0) > 1e-6)
      .sort((a, b) => (b[1] || 0) - (a[1] || 0));
    if (gasEntries.length > 0) {
      const topGases = gasEntries
        .slice(0, 2)
        .map(([gId, n]) => `${SPECIES[gId]?.formula || gId} ${(n * 1000).toFixed(1)}mmol`)
        .join(' + ');
      pillParts.push(`💨 ${topGases}`);
    }
  }
  if (vessel.isFrozenSolid && hasIce) {
    pillParts.push(`❄️ ${iceMl.toFixed(1)}mL`);
  } else if (hasIce && hasWater) {
    pillParts.push(`❄️💧 ${(liqMl + iceMl).toFixed(1)}mL`);
  } else if (liqMl > 0.05) {
    pillParts.push(`${liqMl.toFixed(1)}mL`);
  } else if (hasIce) {
    pillParts.push(`❄️ ${iceMl.toFixed(1)}mL`);
  }
  if (ph !== null) pillParts.push(`pH ${ph.toFixed(1)}`);
  pillParts.push(`${Math.abs(tDisp) < 10 ? tDisp.toFixed(1) : tDisp.toFixed(0)}°C`);

  const pillText = pillParts.join(' · ');
  const py = top - 24;
  drawLabelPill(ctx, x, py, pillText, {
    pal,
    borderColor: isSelected ? '#3b82f6' : pal.badgeBorder,
    font: '600 11.5px system-ui, sans-serif',
    height: 20,
    itemId: vessel.id,
  });

  // Escaping Hot Vapor / Gas Plume Temperature Label ("nhãn mác" on vapor stream)
  if ((vessel.gasOutBannerTimer || 0) > 0 && !vessel.isStoppered && vessel.lastGasOutFormula) {
    const tGasC = kelvinToCelsius(vessel.lastGasOutTempK ?? vessel.tempK);
    const fadeAlpha = Math.min(1, vessel.gasOutBannerTimer / 0.45);
    let gasBadgeText = '';
    if (vessel.gasOutBoiling) {
      gasBadgeText =
        langCode === 'vi'
          ? `💨 Hơi ${vessel.lastGasOutFormula} · ${tGasC.toFixed(0)}°C · Sôi`
          : `💨 Steam ${vessel.lastGasOutFormula} · ${tGasC.toFixed(0)}°C · Boiling`;
    } else if (vessel.gasOutSteam) {
      gasBadgeText =
        langCode === 'vi'
          ? `💨 Hơi ${vessel.lastGasOutFormula} · ${tGasC.toFixed(0)}°C`
          : `💨 Vapor ${vessel.lastGasOutFormula} · ${tGasC.toFixed(0)}°C`;
    } else {
      gasBadgeText =
        langCode === 'vi'
          ? `↑ Khí ${vessel.lastGasOutFormula} · ${tGasC.toFixed(0)}°C`
          : `↑ Gas ${vessel.lastGasOutFormula} · ${tGasC.toFixed(0)}°C`;
    }

    drawLabelPill(ctx, x, py - 24, gasBadgeText, {
      pal,
      borderColor: tGasC >= 95 ? '#f59e0b' : '#38bdf8',
      font: '600 10.5px system-ui, sans-serif',
      height: 19,
      alpha: fadeAlpha,
      itemId: vessel.id,
    });
  }
}
