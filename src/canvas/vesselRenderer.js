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
} from '../engine/gasNetwork.js';
import { renderVesselSolids } from './chemicalVisuals.js';

function cylinderFillHeightFraction(areaFrac) {
  const f = Math.max(0, Math.min(1, areaFrac));
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  let theta = Math.PI * (0.25 + f * 1.5);
  const target = 2 * Math.PI * f;
  for (let k = 0; k < 4; k++) {
    const err = theta - Math.sin(theta) - target;
    const d = Math.max(0.05, 1 - Math.cos(theta));
    theta -= err / d;
  }
  return Math.max(0, Math.min(1, 0.5 * (1 - Math.cos(theta * 0.5))));
}

export function getThemePalette(isDark) {
  return isDark
    ? {
        glassStroke: 'rgba(148, 163, 184, 0.82)',
        glassHighlight: 'rgba(255, 255, 255, 0.24)',
        glassFill: 'rgba(148, 163, 184, 0.08)',
        tickStroke: 'rgba(241, 245, 249, 0.68)',
        tickMinor: 'rgba(226, 232, 240, 0.36)',
        enamelText: 'rgba(241, 245, 249, 0.78)',
        writePatchBg: 'rgba(248, 250, 252, 0.14)',
        writePatchBorder: 'rgba(241, 245, 249, 0.38)',
        textPrimary: '#f1f5f9',
        textMuted: '#94a3b8',
        badgeBg: 'rgba(15, 23, 42, 0.85)',
        badgeBorder: 'rgba(71, 85, 105, 0.9)',
        scaleBody: '#1e293b',
        scaleBorder: '#475569',
        scalePan: '#94a3b8',
        lcdBg: '#064e3b',
        lcdText: '#34d399',
        tubeColor: '#475569',
        burnerMetal: '#64748b',
      }
    : {
        glassStroke: 'rgba(71, 85, 105, 0.78)',
        glassHighlight: 'rgba(255, 255, 255, 0.62)',
        glassFill: 'rgba(226, 232, 240, 0.22)',
        tickStroke: 'rgba(30, 41, 59, 0.58)',
        tickMinor: 'rgba(51, 65, 85, 0.32)',
        enamelText: 'rgba(15, 23, 42, 0.68)',
        writePatchBg: 'rgba(255, 255, 255, 0.65)',
        writePatchBorder: 'rgba(100, 116, 139, 0.42)',
        textPrimary: '#0f172a',
        textMuted: '#475569',
        badgeBg: 'rgba(255, 255, 255, 0.9)',
        badgeBorder: 'rgba(203, 213, 225, 0.95)',
        scaleBody: '#e2e8f0',
        scaleBorder: '#94a3b8',
        scalePan: '#64748b',
        lcdBg: '#0f172a',
        lcdText: '#4ade80',
        tubeColor: '#334155',
        burnerMetal: '#475569',
      };
}

/**
 * Map VesselGeometry profile points [yCm, rCm] onto canvas pixels at (x, y).
 * Unified helper backing glass outline, liquid interior clip, meniscus, ticks & particles.
 */
function mapProfileToCanvas(spec, x, y, padPx = 0) {
  const geomDef = spec.geometry;
  const w = spec.width;
  const h = spec.height;
  const top = y - h / 2;
  const bottom = y + h / 2;
  const footH = spec.shape === 'cylinder' ? 9 : 3.5;
  const baseBottom = padPx > 0 ? bottom - footH : bottom - (spec.shape === 'cylinder' ? 8 : 0);
  const topY = top + (padPx > 0 ? 4 : 0);
  const spanH = Math.max(10, baseBottom - topY);

  const scaleX = (w / 2) / geomDef.bodyMaxRadiusCm;
  const scaleY = spanH / geomDef.maxHeightCm;

  const pts = geomDef.profilePoints.map(([yCm, rCm]) => ({
    cy: baseBottom - yCm * scaleY,
    rx: Math.max(0, rCm * scaleX - padPx),
  }));

  return { pts, top, bottom, baseBottom, spanH, scaleX, scaleY };
}

/**
 * Exact volume (mL) -> vertical Y coordinate & inner fluid geometry from VesselGeometry slices.
 * Ensures graduation tick marks, meniscus width, particle bounds & Dalton evaporation match 1:1.
 */
export function computeVesselFluidGeometry(spec, y, volMl = 0) {
  const geomDef = spec.geometry;
  const { top, bottom, baseBottom, spanH, scaleX, scaleY } = mapProfileToCanvas(spec, xFallback(spec), y, 2.2);
  const state = geomDef.getLiquidState(volMl);
  const volumeMlToState = (ml) => {
    const st = geomDef.getLiquidState(ml);
    return {
      cy: baseBottom - st.fillRatio * spanH,
      halfWPx: Math.max(2, st.radiusCm * scaleX - 2.2),
      surfaceAreaCm2: st.surfaceAreaCm2,
    };
  };

  return {
    top,
    bottom,
    interiorBottom: baseBottom,
    interiorHeight: spanH,
    scaleX,
    scaleY,
    neckHalf: spec.neckRadius || 18.5,
    surfaceY: baseBottom - state.fillRatio * spanH,
    surfaceHalfWPx: Math.max(2, state.radiusCm * scaleX - 2.2),
    volumeMlToY: (ml) => volumeMlToState(ml).cy,
    volumeMlToState,
  };
}

function xFallback() {
  return 0;
}

let _labelFrameActive = false;
let _allowedLabelIds = null;
let _currentLabelItemId = null;
let _deferredPills = [];

export function beginCanvasLabelFrame(allowedIds = null) {
  _labelFrameActive = Boolean(allowedIds);
  _allowedLabelIds = allowedIds;
  _currentLabelItemId = null;
  _deferredPills = [];
}

export function setCurrentLabelItemId(id) {
  _currentLabelItemId = id || null;
}

export function flushCanvasLabelFrame(ctx) {
  if (_deferredPills.length > 0) {
    for (const p of _deferredPills) {
      renderLabelPillImmediate(ctx, p.cx, p.cy, p.text, p.opts);
    }
  }
  _labelFrameActive = false;
  _allowedLabelIds = null;
  _currentLabelItemId = null;
  _deferredPills = [];
}

function renderLabelPillImmediate(ctx, cx, cy, text, opts = {}) {
  const { pal, borderColor, font = '600 11px system-ui, sans-serif', alpha = 1.0, height = 20 } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font;
  const textW = Math.max(44, ctx.measureText(text).width + 14);
  ctx.fillStyle = pal.badgeBg;
  ctx.strokeStyle = borderColor || pal.badgeBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(cx - textW / 2, cy, textW, height, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = pal.textPrimary;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + height / 2 + 0.5);
  ctx.restore();
}

export function drawLabelPill(ctx, cx, cy, text, opts = {}) {
  if (_labelFrameActive) {
    const itemId = opts.itemId ?? _currentLabelItemId;
    const isMatched = opts.alwaysShow
      ? true
      : Array.isArray(opts.itemIds)
      ? opts.itemIds.some((id) => _allowedLabelIds?.has(id))
      : Boolean(itemId && _allowedLabelIds?.has(itemId));
    if (!isMatched) return;
    if (!opts.immediate) {
      _deferredPills.push({ cx, cy, text, opts });
      return;
    }
  }
  renderLabelPillImmediate(ctx, cx, cy, text, opts);
}

function getDominantSyringeGasFormula(syringe, langCode) {
  const parts = [];
  let total = 0;
  for (const g of ALL_GASES) total += syringe.gasMoles?.[g] || 0;
  if (total <= 1e-10) return langCode === 'vi' ? 'Khí' : 'Gas';
  const sorted = ALL_GASES
    .map((g) => ({ id: g, n: syringe.gasMoles?.[g] || 0 }))
    .filter((x) => x.n > 1e-8 && (x.n / total >= 0.04 || x.n > 5e-5))
    .sort((a, b) => b.n - a.n);
  for (const item of sorted.slice(0, 2)) {
    parts.push(SPECIES[item.id]?.formula || item.id);
  }
  return parts.length > 0 ? parts.join(' + ') : langCode === 'vi' ? 'Khí' : 'Gas';
}

/**
 * Trace the outer glass silhouette path directly from VesselGeometry profilePoints.
 */
function traceVesselPath(ctx, spec, x, y, sagFrac = 0) {
  if (spec.isHorizontalTube) {
    const hw = spec.width / 2;
    const hh = spec.height / 2;
    ctx.beginPath();
    ctx.roundRect(x - hw, y - hh, spec.width, spec.height, 4);
    return;
  }
  if (spec.isUTube) {
    const dx = spec.limbSpacingX || 28;
    const rOut = spec.tubeOuterR || 13;
    const topY = y - spec.height / 2 + 2;
    const bottomY = y + spec.height / 2 - 2;
    const bendCy = bottomY - (dx + rOut);
    ctx.beginPath();
    // Outer U contour
    ctx.moveTo(x - dx - rOut, topY);
    ctx.lineTo(x - dx - rOut, bendCy);
    ctx.arc(x, bendCy, dx + rOut, Math.PI, 0, true);
    ctx.lineTo(x + dx + rOut, topY);
    // Inner U contour
    ctx.moveTo(x - dx + rOut, topY);
    ctx.lineTo(x - dx + rOut, bendCy);
    ctx.arc(x, bendCy, dx - rOut, Math.PI, 0, true);
    ctx.lineTo(x + dx - rOut, topY);
    return;
  }
  const { pts, bottom, baseBottom } = mapProfileToCanvas(spec, x, y, 0);
  const lastIdx = pts.length - 1;
  const spoutLeftExtra = spec.shape === 'beaker' || spec.shape === 'cylinder' ? 3.5 : 0;
  const sagPx = sagFrac > 0.01 ? sagFrac * 13.0 : 0;

  ctx.beginPath();
  // Top-left rim -> descend left wall across bottom fillet -> cross base (sags under high heat!) -> ascend right wall
  ctx.moveTo(x - pts[lastIdx].rx - spoutLeftExtra, pts[lastIdx].cy);
  for (let i = lastIdx - 1; i >= 0; i--) {
    const droop = i <= 1 ? sagPx * (1 - i * 0.45) : 0;
    ctx.lineTo(x - pts[i].rx, pts[i].cy + droop);
  }
  if (sagPx > 0.2) {
    ctx.quadraticCurveTo(x, pts[0].cy + sagPx * 1.45, x + pts[0].rx, pts[0].cy + sagPx);
  } else {
    ctx.lineTo(x + pts[0].rx, pts[0].cy);
  }
  for (let i = 1; i <= lastIdx; i++) {
    const droop = i <= 1 ? sagPx * (1 - i * 0.45) : 0;
    ctx.lineTo(x + pts[i].rx, pts[i].cy + droop);
  }

  // Graduated cylinder stable pedestal base foot
  if (spec.shape === 'cylinder') {
    const halfBase = spec.width / 2 + 11;
    ctx.moveTo(x - halfBase, bottom);
    ctx.lineTo(x + halfBase, bottom);
    ctx.lineTo(x + pts[0].rx, baseBottom);
    ctx.lineTo(x - pts[0].rx, baseBottom);
    ctx.closePath();
  }
}

/**
 * Trace closed interior liquid-clipping area directly from VesselGeometry profilePoints.
 */
function traceVesselInteriorClip(ctx, spec, x, y, sagFrac = 0) {
  if (spec.isHorizontalTube) {
    const hw = spec.width / 2 - 2.5;
    const hh = spec.height / 2 - 2.5;
    ctx.beginPath();
    ctx.roundRect(x - hw, y - hh, hw * 2, hh * 2, 2.5);
    return;
  }
  if (spec.isUTube) {
    const dx = spec.limbSpacingX || 28;
    const rIn = (spec.tubeOuterR || 13) - 2.4;
    const topY = y - spec.height / 2 + 2;
    const bottomY = y + spec.height / 2 - 4.4;
    const bendCy = bottomY - (dx + rIn);
    ctx.beginPath();
    ctx.moveTo(x - dx - rIn, topY);
    ctx.lineTo(x - dx - rIn, bendCy);
    ctx.arc(x, bendCy, dx + rIn, Math.PI, 0, true);
    ctx.lineTo(x + dx + rIn, topY);
    ctx.lineTo(x + dx - rIn, topY);
    ctx.lineTo(x + dx - rIn, bendCy);
    ctx.arc(x, bendCy, dx - rIn, 0, Math.PI, false);
    ctx.lineTo(x - dx + rIn, topY);
    ctx.closePath();
    return;
  }
  const pad = spec.shape === 'beaker' || spec.shape === 'crucible' ? 2.6 : 2.1;
  const { pts } = mapProfileToCanvas(spec, x, y, pad);
  const lastIdx = pts.length - 1;
  const sagPx = sagFrac > 0.01 ? sagFrac * 12.0 : 0;

  ctx.beginPath();
  ctx.moveTo(x - pts[lastIdx].rx, pts[lastIdx].cy);
  for (let i = lastIdx - 1; i >= 0; i--) {
    const droop = i <= 1 ? sagPx * (1 - i * 0.45) : 0;
    ctx.lineTo(x - pts[i].rx, pts[i].cy + droop);
  }
  if (sagPx > 0.2) {
    ctx.quadraticCurveTo(x, pts[0].cy + sagPx * 1.4, x + pts[0].rx, pts[0].cy + sagPx);
  } else {
    ctx.lineTo(x + pts[0].rx, pts[0].cy);
  }
  for (let i = 1; i <= lastIdx; i++) {
    const droop = i <= 1 ? sagPx * (1 - i * 0.45) : 0;
    ctx.lineTo(x + pts[i].rx, pts[i].cy + droop);
  }
  ctx.closePath();
}

export function renderScale(ctx, item, isSelected, isDark, timeNow) {
  const spec = APPARATUS.scale;
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const w = spec.width;
  const h = spec.height;
  const top = y - h / 2;

  ctx.save();
  if (isSelected) {
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 12;
  }

  // Weighing pan
  ctx.fillStyle = pal.scalePan;
  ctx.fillRect(x - spec.panWidth / 2, top, spec.panWidth, 6);
  ctx.fillRect(x - 16, top + 6, 32, 6);

  // Main body
  ctx.fillStyle = pal.scaleBody;
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.scaleBorder;
  ctx.lineWidth = isSelected ? 2.2 : 1.4;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, top + 12, w, h - 12, 8);
  ctx.fill();
  ctx.stroke();

  ctx.shadowBlur = 0;

  // LCD screen
  const lcdW = w - 26;
  const lcdH = 26;
  const lcdX = x - lcdW / 2;
  const lcdY = top + 20;
  ctx.fillStyle = pal.lcdBg;
  ctx.beginPath();
  ctx.roundRect(lcdX, lcdY, lcdW, lcdH, 4);
  ctx.fill();

  const val = item.measuredG || 0;
  const text = `${val.toFixed(2)} g`;
  ctx.fillStyle = pal.lcdText;
  ctx.font = 'bold 14px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, lcdX + lcdW - 8, lcdY + lcdH / 2 + 1);

  if (Math.abs(item.tareG) > 0.005) {
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('TARE', lcdX + 6, lcdY + lcdH / 2 + 1);
  }

  ctx.restore();
}

export function renderBurner(ctx, item, isSelected, isDark, timeNow) {
  const spec = APPARATUS[item.typeId] || APPARATUS.burner;
  const isBunsen = item.typeId === 'bunsen_burner';
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const airOpen = isBunsen ? item.airHoleOpen !== false : true;
  const powerTbl = isBunsen && !airOpen ? spec.yellowPowerLevelsW : spec.powerLevelsW;
  const powerW = item.powerW ?? (powerTbl[item.flameLevel || 0] || 0);
  const maxRefW = isBunsen && !airOpen ? (spec.yellowPowerLevelsW[3] || 820) : (spec.maxPowerW || 650);
  const powerFrac = Math.max(0, Math.min(1, powerW / maxRefW));
  const w = spec.width;
  const h = spec.height;
  const top = y - h / 2;
  const bottom = y + h / 2;

  ctx.save();
  if (isSelected) {
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x - w / 2 - 4, top - 4, w + 8, h + 8);
    ctx.setLineDash([]);
  }

  if (isBunsen) {
    // Integrated forged-iron tripod frame reaching up to top + 10 (50 px above burner nozzle)
    ctx.strokeStyle = pal.burnerMetal;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - 38, top + 12);
    ctx.lineTo(x - 50, bottom);
    ctx.moveTo(x + 38, top + 12);
    ctx.lineTo(x + 50, bottom);
    ctx.stroke();

    // Cast-iron heavy octagonal pedestal base + side brass gas hose barb
    ctx.fillStyle = isDark ? '#334155' : '#475569';
    ctx.strokeStyle = isDark ? '#64748b' : '#1e293b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x - 32, bottom - 12, 64, 12, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#d97706';
    ctx.fillRect(x + 10, bottom - 22, 18, 5);

    // Metallic burner barrel chimney up to nozzle (bottom - 68)
    const barrelGrad = ctx.createLinearGradient(x - 7, 0, x + 7, 0);
    barrelGrad.addColorStop(0, '#64748b');
    barrelGrad.addColorStop(0.45, '#e2e8f0');
    barrelGrad.addColorStop(1, '#475569');
    ctx.fillStyle = barrelGrad;
    ctx.fillRect(x - 6, bottom - 68, 12, 56);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 6, bottom - 68, 12, 56);

    // Brass rotating Air Collar sleeve around lower barrel + visible circular air intake port when OPEN
    ctx.fillStyle = '#d97706';
    ctx.fillRect(x - 8, bottom - 30, 16, 12);
    if (airOpen) {
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(x, bottom - 24, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    if (powerW > 0) {
      const fBaseY = bottom - 68;
      const scale = 0.65 + powerFrac * 1.15;
      const wobble = Math.sin(timeNow * 24 + x) * (airOpen ? 0.9 : 2.6);
      const fH = (airOpen ? 46 : 42) * scale;
      const fW = (airOpen ? 9.5 : 12.5) * scale;

      const isBeilstein = (item.beilsteinTimer || 0) > 0;
      const isFlameTest = !isBeilstein && (item.flameTestTimer || 0) > 0 && item.flameTestColor;

      const outerGrad = ctx.createLinearGradient(x, fBaseY, x, fBaseY - fH);
      if (isBeilstein) {
        outerGrad.addColorStop(0, 'rgba(16, 185, 129, 0.95)');
        outerGrad.addColorStop(1, 'rgba(110, 231, 183, 0.08)');
      } else if (isFlameTest) {
        outerGrad.addColorStop(0, item.flameTestColor);
        outerGrad.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
      } else if (airOpen) {
        outerGrad.addColorStop(0, 'rgba(37, 99, 235, 0.88)');
        outerGrad.addColorStop(0.55, 'rgba(56, 189, 248, 0.56)');
        outerGrad.addColorStop(1, 'rgba(139, 92, 246, 0.0)');
      } else {
        outerGrad.addColorStop(0, 'rgba(249, 115, 22, 0.88)');
        outerGrad.addColorStop(0.45, 'rgba(250, 204, 21, 0.94)');
        outerGrad.addColorStop(1, 'rgba(254, 240, 138, 0.0)');
      }

      // Outer mantle flame
      ctx.beginPath();
      ctx.moveTo(x - fW, fBaseY);
      ctx.quadraticCurveTo(x - fW * 1.05, fBaseY - fH * 0.55, x + wobble, fBaseY - fH);
      ctx.quadraticCurveTo(x + fW * 1.05, fBaseY - fH * 0.55, x + fW, fBaseY);
      ctx.closePath();
      ctx.fillStyle = outerGrad;
      ctx.fill();

      // Inner crisp reducing cone (sharp electric cyan cone at center of roaring Bunsen!)
      if (airOpen && !isBeilstein && !isFlameTest) {
        const coneH = fH * 0.54;
        ctx.beginPath();
        ctx.moveTo(x - fW * 0.52, fBaseY);
        ctx.lineTo(x + wobble * 0.3, fBaseY - coneH);
        ctx.lineTo(x + fW * 0.52, fBaseY);
        ctx.closePath();
        ctx.fillStyle = 'rgba(125, 211, 252, 0.95)';
        ctx.fill();

        // Highlight hottest oxidizing tip zone (~1500 °C) just above inner blue cone apex
        ctx.fillStyle = 'rgba(224, 242, 254, 0.9)';
        ctx.beginPath();
        ctx.arc(x + wobble * 0.3, fBaseY - coneH - 2, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }

      const flameBadge = isBeilstein
        ? `🔥 ${Math.round(powerW)} W · CuCl₂*`
        : isFlameTest
        ? `🔥 ${Math.round(powerW)} W · ${item.flameTestIon}`
        : `🔥 ${Math.round(powerW)} W · ${airOpen ? '~1400°C Blue' : '~800°C Yellow'}`;
      drawLabelPill(ctx, x, bottom + 6, flameBadge, {
        pal,
        borderColor: isBeilstein ? '#10b981' : isFlameTest ? item.flameTestColor : airOpen ? '#38bdf8' : '#f59e0b',
        font: '600 10.5px system-ui, sans-serif',
        height: 18,
      });
    }

    // Integrated tripod ring bar & glowing ceramic-center gauze drawn across top + 10
    ctx.strokeStyle = pal.burnerMetal;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x - 46, top + 10);
    ctx.lineTo(x + 46, top + 10);
    ctx.stroke();

    ctx.fillStyle =
      powerW > 0
        ? `rgba(249, 115, 22, ${0.24 + powerFrac * 0.56})`
        : isDark ? 'rgba(226, 232, 240, 0.48)' : 'rgba(148, 163, 184, 0.52)';
    ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.5)' : 'rgba(100, 116, 139, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - 32, top + 6.5, 64, 5.5, 2);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
    return;
  }

  // Tripod stand + wire gauze (Spirit Lamp burner)
  ctx.strokeStyle = pal.burnerMetal;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x - 46, top + 10);
  ctx.lineTo(x + 46, top + 10);
  ctx.moveTo(x - 36, top + 12);
  ctx.lineTo(x - 48, bottom);
  ctx.moveTo(x + 36, top + 12);
  ctx.lineTo(x + 48, bottom);
  ctx.stroke();

  // Ceramic gauze center glows with live burner wattage
  ctx.fillStyle =
    powerW > 0
      ? `rgba(249, 115, 22, ${0.18 + powerFrac * 0.42})`
      : 'rgba(148, 163, 184, 0.35)';
  ctx.fillRect(x - 32, top + 6, 64, 5);

  // Alcohol burner glass/brass reservoir
  ctx.fillStyle = isDark ? 'rgba(148, 163, 184, 0.2)' : 'rgba(203, 213, 225, 0.55)';
  ctx.strokeStyle = pal.glassStroke;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.roundRect(x - 24, bottom - 34, 48, 34, 8);
  ctx.fill();
  ctx.stroke();

  // Ethanol inside burner
  ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
  ctx.fillRect(x - 22, bottom - 20, 44, 17);

  // Brass wick collar
  ctx.fillStyle = '#d97706';
  ctx.fillRect(x - 7, bottom - 41, 14, 7);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(x - 2, bottom - 47, 4, 6);

  // Continuous wattage flickering flame
  if (powerW > 0) {
    const scale = 0.48 + powerFrac * 1.44;
    const wobble = Math.sin(timeNow * 16 + x) * (1.4 + powerFrac * 1.6);
    const fBaseY = bottom - 46;
    const fH = 34 * scale;
    const fW = 10.5 * scale;

    const isBeilstein = (item.beilsteinTimer || 0) > 0;
    const isFlameTest = !isBeilstein && (item.flameTestTimer || 0) > 0 && item.flameTestColor;
    const outerGrad = ctx.createRadialGradient(x, fBaseY - fH * 0.35, 2, x, fBaseY - fH * 0.35, fH * (isBeilstein || isFlameTest ? 1.05 : 0.8));
    if (isBeilstein) {
      outerGrad.addColorStop(0, 'rgba(110, 231, 183, 0.96)');
      outerGrad.addColorStop(0.5, 'rgba(16, 185, 129, 0.88)');
      outerGrad.addColorStop(1, 'rgba(5, 150, 105, 0.0)');
    } else if (isFlameTest) {
      const fCol = item.flameTestColor;
      outerGrad.addColorStop(0, '#ffffff');
      outerGrad.addColorStop(0.35, fCol);
      outerGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    } else {
      outerGrad.addColorStop(0, 'rgba(253, 224, 71, 0.95)');
      outerGrad.addColorStop(0.55, 'rgba(249, 115, 22, 0.78)');
      outerGrad.addColorStop(1, 'rgba(59, 130, 246, 0.0)');
    }

    ctx.beginPath();
    ctx.moveTo(x - fW * (isBeilstein || isFlameTest ? 1.18 : 1), fBaseY);
    ctx.quadraticCurveTo(x - fW * 1.15, fBaseY - fH * 0.5, x + wobble, fBaseY - fH * (isBeilstein || isFlameTest ? 1.18 : 1));
    ctx.quadraticCurveTo(x + fW * 1.15, fBaseY - fH * 0.5, x + fW * (isBeilstein || isFlameTest ? 1.18 : 1), fBaseY);
    ctx.closePath();
    ctx.fillStyle = outerGrad;
    ctx.fill();

    // Inner blue/emerald cone
    ctx.beginPath();
    ctx.moveTo(x - fW * 0.5, fBaseY);
    ctx.quadraticCurveTo(x, fBaseY - fH * 0.55, x + fW * 0.5, fBaseY);
    ctx.closePath();
    ctx.fillStyle = isBeilstein ? 'rgba(52, 211, 153, 0.92)' : isFlameTest ? item.flameTestColor : 'rgba(56, 189, 248, 0.88)';
    ctx.fill();

    // Compact live power badge (+ Beilstein / Flame Test ion)
    const flameBadge = isBeilstein
      ? `🔥 ${Math.round(powerW)} W · CuCl₂*`
      : isFlameTest
      ? `🔥 ${Math.round(powerW)} W · ${item.flameTestIon}`
      : `🔥 ${Math.round(powerW)} W`;
    drawLabelPill(ctx, x, bottom + 6, flameBadge, {
      pal,
      borderColor: isBeilstein ? '#10b981' : isFlameTest ? item.flameTestColor : powerFrac > 0.6 ? '#f97316' : '#f59e0b',
      font: '600 10.5px system-ui, sans-serif',
      height: 18,
    });
  }

  ctx.restore();
}

function renderBrokenSyringe(ctx, item, pal, isSelected) {
  const { x, y } = item;
  const spec = APPARATUS.gas_syringe;
  const bottom = y + spec.height / 2;

  ctx.save();
  if (item.spilledPuddleColor) {
    ctx.fillStyle = item.spilledPuddleColor;
    ctx.globalAlpha = 0.68;
    ctx.beginPath();
    ctx.ellipse(x - (item.flippedX ? -10 : 10), bottom - 1, 78, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Cracked Luer tip + shattered barrel base fragments
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(item.flippedX ? x + 94 : x - 110, bottom - 14, 16, 7);
  ctx.fillStyle = pal.glassFill;
  ctx.strokeStyle = isSelected ? '#3b82f6' : '#ef4444';
  ctx.lineWidth = isSelected ? 2 : 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 86, bottom - 22);
  ctx.lineTo(x - 42, bottom - 8);
  ctx.lineTo(x - 10, bottom - 19);
  ctx.lineTo(x + 28, bottom - 5);
  ctx.lineTo(x + 64, bottom - 15);
  ctx.lineTo(x + 68, bottom - 1);
  ctx.lineTo(x - 86, bottom - 1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Scattered glass splinters
  for (let i = 0; i < 12; i++) {
    const sx = x - 70 + i * 14 + Math.sin(i * 7.1) * 5;
    const sy = bottom - 3 - (i % 3) * 3;
    ctx.fillStyle = 'rgba(224, 242, 254, 0.72)';
    ctx.beginPath();
    ctx.moveTo(sx - 5, sy + 2);
    ctx.lineTo(sx + 4, sy - 4);
    ctx.lineTo(sx + 6, sy + 3);
    ctx.closePath();
    ctx.fill();
  }
  drawLabelPill(ctx, x, bottom - 44, `${item.label} · 💥`, {
    pal,
    borderColor: '#ef4444',
    font: '600 10.5px system-ui, sans-serif',
    height: 19,
  });
  ctx.restore();
}

export function renderRetortStand(ctx, stand, isSelected, isDark) {
  const spec = APPARATUS.retort_stand;
  const pal = getThemePalette(isDark);
  const { x, y } = stand;
  const w = spec.width;
  const h = spec.height;
  const extPx = Math.max(0, Math.min(200, stand.extendPx || 0));
  const top = y - h / 2 - extPx;
  const baseTop = y - h / 2;
  const bottom = y + h / 2;
  const { rodX } = getStandGeometry(stand);

  ctx.save();
  if (stand.landingTilt) {
    ctx.translate(x, bottom);
    ctx.rotate(stand.landingTilt * 0.4);
    ctx.translate(-x, -bottom);
  }
  if (isSelected) {
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 10;
  }

  // Heavy cast-iron base plate resting on bench
  ctx.fillStyle = isDark ? '#334155' : '#475569';
  ctx.strokeStyle = isSelected ? '#3b82f6' : isDark ? '#64748b' : '#1e293b';
  ctx.lineWidth = isSelected ? 2 : 1.4;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, bottom - 12, w, 12, 3);
  ctx.fill();
  ctx.stroke();

  // Boss socket collar at base of stainless rod
  ctx.fillStyle = isDark ? '#475569' : '#64748b';
  ctx.fillRect(rodX - 7, bottom - 22, 14, 10);

  // 304 Stainless steel vertical rod (telescoping upper & lower shafts)
  const rodGrad = ctx.createLinearGradient(rodX - 3.5, 0, rodX + 3.5, 0);
  rodGrad.addColorStop(0, '#64748b');
  rodGrad.addColorStop(0.45, '#e2e8f0');
  rodGrad.addColorStop(1, '#475569');
  ctx.fillStyle = rodGrad;
  ctx.fillRect(rodX - 3, top + 8, 6, h + extPx - 22);

  // Telescopic locking sleeve collar when extended
  if (extPx > 2) {
    ctx.fillStyle = isDark ? '#475569' : '#334155';
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.fillRect(rodX - 5.5, baseTop + 10, 11, 9);
    ctx.strokeRect(rodX - 5.5, baseTop + 10, 11, 9);
  }

  // Draggable finial cap handle at rod top (pull up/down to extend stand height)
  ctx.beginPath();
  ctx.arc(rodX, top + 8, 6.0, 0, Math.PI * 2);
  ctx.fillStyle = isSelected || extPx > 0 ? '#f59e0b' : '#94a3b8';
  ctx.strokeStyle = isDark ? '#0f172a' : '#ffffff';
  ctx.lineWidth = 1.4;
  ctx.fill();
  ctx.stroke();

  drawLabelPill(ctx, rodX, top - 16, extPx > 0 ? `${stand.label} · +${Math.round(extPx / 1.15)}mm` : stand.label, {
    pal,
    borderColor: isSelected ? '#3b82f6' : pal.badgeBorder,
    font: '600 10px system-ui, sans-serif',
    height: 17,
  });
  ctx.restore();
}

export function renderRetortClampJaw(ctx, stand, clampedItem, isDark) {
  if (!stand || !clampedItem || clampedItem.isShattered || clampedItem.isBroken) return;
  const stSpec = APPARATUS.retort_stand;
  const { rodX, rodSide, armDir } = getStandGeometry(stand);
  const extPx = Math.max(0, Math.min(200, stand.extendPx || 0));
  const standTop = stand.y - stSpec.height / 2 - extPx;
  const standBot = stand.y + stSpec.height / 2;
  const spec = APPARATUS[clampedItem.typeId];
  const isSyr = clampedItem.kind === 'gas_syringe';

  let attachX = clampedItem.x;
  let attachY = clampedItem.y + getClampNeckOffsetY(spec);
  if (isSyr) {
    const { barrelLeft, barrelRight } = getSyringeGeometry(clampedItem);
    // Grip rear/middle barrel section horizontally closest to stand rod without crossing the graduations
    attachX = Math.max(barrelLeft + 32, Math.min(barrelRight - 14, rodX + armDir * 24));
  }
  // Keep bosshead clamp strictly mounted along the stainless steel rod shaft
  attachY = Math.max(standTop + 14, Math.min(standBot - 22, attachY));

  ctx.save();
  // Bosshead block mounted on stainless steel rod
  ctx.fillStyle = isDark ? '#475569' : '#334155';
  ctx.strokeStyle = isDark ? '#94a3b8' : '#1e293b';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(rodX - 8, attachY - 9, 16, 18, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(rodSide > 0 ? rodX + 8 : rodX - 14, attachY - 3, 6, 6);

  // Horizontal stainless clamp extension rod (stops cleanly at barrel/neck grip edge)
  const jawRadius = isSyr ? (spec.barrelH || 54) / 2 + 2 : Math.max(13, (spec.neckRadius || 16) + 2);
  const armEndX = isSyr ? attachX : attachX + (rodX >= attachX ? jawRadius : -jawRadius);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(rodX, attachY);
  ctx.lineTo(armEndX, attachY);
  ctx.stroke();

  // Dual rubberized prong jaws clasping top/bottom (syringe) or left/right (vertical glassware neck)
  ctx.strokeStyle = isDark ? '#cbd5e1' : '#1e293b';
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  if (isSyr) {
    ctx.beginPath();
    ctx.arc(attachX, attachY, jawRadius, -Math.PI * 0.5 - 0.52, -Math.PI * 0.5 + 0.52);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(attachX, attachY, jawRadius, Math.PI * 0.5 - 0.52, Math.PI * 0.5 + 0.52);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.beginPath();
    ctx.arc(attachX, attachY, 4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(attachX, attachY, jawRadius, -0.58, 0.58);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(attachX, attachY, jawRadius, Math.PI - 0.58, Math.PI + 0.58);
    ctx.stroke();
  }
  ctx.restore();
}

export function renderGasSyringe(ctx, item, isSelected, isDark, env, langCode = 'vi', timeNow = 0) {
  const spec = APPARATUS.gas_syringe;
  const pal = getThemePalette(isDark);
  if (item.isBroken) {
    renderBrokenSyringe(ctx, item, pal, isSelected);
    return;
  }

  const { x, y } = item;
  const syrGeom = getSyringeGeometry(item);
  const { barrelDir, barrelW, barrelH, collarH, frontX, rearX, barrelLeft, barrelRight, nozzleX, travelStartX, travelSpan } = syrGeom;
  const barrelTop = y - barrelH / 2;

  const gasVolMl = computeSyringeGasVolumeMl(item, env);
  const syrTempK = item.tempK ?? env.tempK;
  const overflowL = computeLiquidVolumeL(item.overflowMoles || {}, syrTempK);
  const overflowMl = overflowL * 1000;
  const condensedWaterMl = ((item.condensedWaterMol || 0) * SPECIES.H2O_l.molarMass) / 0.997;
  const condensedEtOHMl = ((item.condensedEtOHMol || 0) * SPECIES.C2H5OH_l.molarMass) / SPECIES.C2H5OH_l.density;
  const condensedMl = condensedWaterMl + condensedEtOHMl;
  const nh4clMol = item.overflowMoles?.NH4Cl_s || 0;
  const frozenMl = computeSyringeFrozenVolumeMl(item);
  const totalLiqMl = overflowMl + condensedMl;
  const totalFluidMl = totalLiqMl + frozenMl;
  const totalVolMl = computeSyringeTotalVolumeMl(item, env);

  // Calibrate stroke: 0 mL tick aligns near front face; plunger advances along barrelDir
  const ratio = Math.max(0, Math.min(1, totalVolMl / spec.maxVolumeMl));
  const plungerFaceX = travelStartX + barrelDir * (ratio * travelSpan);
  const frontInnerX = frontX + barrelDir * 2;
  const minChamberFace = frontX + barrelDir * 3;
  const activeChamberFace =
    barrelDir > 0 ? Math.max(minChamberFace, plungerFaceX) : Math.min(minChamberFace, plungerFaceX);
  const chamberLeft = Math.min(frontInnerX, activeChamberFace);
  const chamberRight = Math.max(frontInnerX, activeChamberFace);
  const chamberW = Math.max(0, chamberRight - chamberLeft);

  const syrTempC = kelvinToCelsius(syrTempK);
  const overP = (item.internalPressureBar || env.pressureBar) - env.pressureBar;

  // Determine chamber gas tint dynamically from SPECIES.syringeFillColor (colored gases take precedence over steam)
  let gasChamberFill = 'rgba(186, 230, 253, 0.14)';
  for (const gId of ALL_GASES) {
    if ((item.gasMoles?.[gId] || 0) <= 1e-6) continue;
    const fill = SPECIES[gId]?.syringeFillColor;
    if (!fill) continue;
    gasChamberFill = typeof fill === 'string' ? fill : (isDark ? fill.dark : fill.light);
    if (gId !== 'H2O_g') break;
  }

  ctx.save();
  if (item.landingTilt) {
    ctx.translate(x, y);
    ctx.rotate(item.landingTilt * 0.45);
    ctx.translate(-x, -y);
  }
  if (isSelected) {
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 11;
  }

  // Ground puddle beneath if dropped and spilled liquid
  if (item.spilledPuddleColor && !item.clampedToId) {
    ctx.save();
    ctx.fillStyle = item.spilledPuddleColor;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(frontX - barrelDir * 8, barrelTop + barrelH + 10, 26, 3.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Stainless steel / Chrome Luer-Lock precision connector tip on nozzle end (left or right if flipped)
  const tipMinX = Math.min(nozzleX, frontX - barrelDir * 7);
  const collarMinX = Math.min(frontX, frontX - barrelDir * 8);
  ctx.fillStyle = '#94a3b8';
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1;
  ctx.fillRect(tipMinX, y - 3.5, 11, 7);
  ctx.strokeRect(tipMinX, y - 3.5, 11, 7);
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(collarMinX, y - 7, 8, 14);
  ctx.strokeRect(collarMinX, y - 7, 8, 14);

  // Interactive tubing port indicator ring on syringe nozzle tip
  ctx.save();
  const syrConnected = Boolean(item.connectedFromId);
  ctx.fillStyle = syrConnected ? '#0ea5e9' : pal.badgeBg;
  ctx.strokeStyle = '#0ea5e9';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(nozzleX, y, 4.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Borosilicate 3.3 Barrel (Ø 47.8 mm OD) + Rear Flared Flange (Ø 57 mm OD)
  ctx.fillStyle = pal.glassFill;
  ctx.strokeStyle =
    overP >= 0.35
      ? '#ef4444'
      : isSelected
      ? '#3b82f6'
      : syrTempC >= 60
      ? '#f59e0b'
      : pal.glassStroke;
  ctx.lineWidth = isSelected || overP >= 0.35 ? 2.2 : 1.7;
  ctx.beginPath();
  ctx.roundRect(barrelLeft, barrelTop, barrelW, barrelH, 5);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = pal.glassFill;
  ctx.beginPath();
  ctx.roundRect(rearX - (barrelDir > 0 ? 4 : 3), y - collarH / 2, 7, collarH, 3);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Inner chamber strictly clipped to [frontInnerX .. plungerFaceX]
  if (chamberW > 0.5) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(barrelLeft + 2, barrelTop + 2, barrelW - 4, barrelH - 4, 4);
    ctx.clip();
    ctx.beginPath();
    ctx.rect(chamberLeft, barrelTop + 2, chamberW, barrelH - 4);
    ctx.clip();

    const innerTop = barrelTop + 2;
    const innerH = barrelH - 4;
    const innerBot = innerTop + innerH;

    // 1. Gas phase color fill inside expanded chamber
    if (gasVolMl > 0.05) {
      ctx.fillStyle = gasChamberFill;
      ctx.fillRect(chamberLeft, innerTop, chamberW, innerH);
    }

    // 2. Unified aqueous liquid + condensate + frozen ice strictly confined ahead of plunger face!
    if (totalFluidMl > 0.002) {
      const combMoles = buildCombinedSyringeTotalMoles(item);
      const liqMoles = buildCombinedSyringeLiquidMoles(item);
      const combL = computeLiquidVolumeL(liqMoles, syrTempK);
      let liqColor = isDark ? 'rgba(56, 189, 248, 0.62)' : 'rgba(14, 165, 233, 0.55)';
      if (combL > 1e-8) {
        liqColor = computeSolutionVisuals(
          combMoles,
          combL,
          computePH(liqMoles, combL, syrTempK),
          4.29,
          item.overflowBleachFrac || 0
        ).css;
      }

      const iceFrac = frozenMl / Math.max(1e-6, totalFluidMl);
      const iceFill = isDark ? 'rgba(224, 242, 254, 0.78)' : 'rgba(186, 230, 253, 0.84)';
      const iceEdge = isDark ? 'rgba(248, 250, 252, 0.72)' : 'rgba(56, 189, 248, 0.65)';

      if (chamberW < 8) {
        const miniFrac = Math.max(0.16, Math.min(1, totalFluidMl / 2.2));
        const miniH = innerH * miniFrac;
        const poolY = innerBot - miniH;
        const iceH = miniH * iceFrac;
        if (totalLiqMl > 0.002) {
          ctx.fillStyle = liqColor;
          ctx.fillRect(chamberLeft, poolY + iceH, chamberW, miniH - iceH);
        }
        if (frozenMl > 0.002) {
          ctx.fillStyle = iceFill;
          ctx.fillRect(chamberLeft, poolY, chamberW, Math.max(2, iceH));
        }
        ctx.strokeStyle = frozenMl > 0.002 ? iceEdge : 'rgba(255, 255, 255, 0.68)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(chamberLeft, poolY);
        ctx.lineTo(chamberRight, poolY);
        ctx.stroke();
      } else {
        const areaFrac = totalFluidMl / Math.max(totalFluidMl + gasVolMl, 1e-6);
        const hFrac = cylinderFillHeightFraction(areaFrac);
        const poolH = Math.max(2.5, innerH * hFrac);
        const poolY = innerBot - poolH;
        const iceH = poolH * iceFrac;

        if (totalLiqMl > 0.002) {
          ctx.fillStyle = liqColor;
          ctx.fillRect(chamberLeft, poolY + iceH, chamberW, Math.max(0, poolH - iceH));
        }
        if (frozenMl > 0.002) {
          ctx.fillStyle = iceFill;
          ctx.fillRect(chamberLeft, poolY, chamberW, Math.max(2.2, iceH));
          ctx.strokeStyle = iceEdge;
          ctx.lineWidth = 0.85;
          ctx.beginPath();
          for (let k = 0; k < Math.min(6, Math.floor(chamberW / 14)); k++) {
            const cx = chamberLeft + 6 + k * 14;
            ctx.moveTo(cx, poolY + 1);
            ctx.lineTo(cx + 5, poolY + Math.min(iceH, 5));
          }
          ctx.stroke();
        }

        if (hFrac < 0.985) {
          ctx.strokeStyle = frozenMl > 0.002 ? iceEdge : 'rgba(255, 255, 255, 0.68)';
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(chamberLeft, poolY);
          ctx.lineTo(chamberRight, poolY);
          ctx.stroke();
        }
      }

      if (condensedMl > 0.002 && syrTempK >= 273.15 && chamberW >= 12) {
        ctx.fillStyle = 'rgba(186, 230, 253, 0.84)';
        const nDrops = Math.min(10, Math.max(3, Math.floor(chamberW / 12)));
        for (let i = 0; i < nDrops; i++) {
          const dx = chamberLeft + 4 + ((i * 0.618 + 0.13) % 1) * Math.max(4, chamberW - 8);
          const dy = innerTop + 4 + ((i * 0.37) % 1) * Math.max(6, innerH * 0.55);
          ctx.beginPath();
          ctx.arc(dx, dy, 1.1 + (i % 3) * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (nh4clMol > 1e-6 || (item.nh4clSmokeTimer || 0) > 0) {
        const sAlpha = Math.min(0.85, Math.max((item.nh4clSmokeTimer || 0) * 0.3, Math.min(1, nh4clMol * 250) * 0.72));
        if ((item.nh4clSmokeTimer || 0) > 0) {
          ctx.fillStyle = `rgba(248, 250, 252, ${(0.22 * Math.min(1, item.nh4clSmokeTimer)).toFixed(2)})`;
          ctx.fillRect(chamberLeft, innerTop, chamberW, innerH);
        }
        if (nh4clMol > 1e-6) {
          ctx.fillStyle = `rgba(248, 250, 252, ${sAlpha.toFixed(2)})`;
          const nSpecks = Math.min(18, Math.max(4, Math.floor(chamberW / 8)));
          for (let k = 0; k < nSpecks; k++) {
            const sx = chamberLeft + 4 + ((k * 0.618 + 0.11) % 1) * Math.max(4, chamberW - 8);
            const sy = innerBot - 2.5 - (k % 3) * 1.4;
            ctx.beginPath();
            ctx.arc(sx, sy, 1.3 + (k % 2) * 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // Outer/inner rime frost layer on cold syringe walls
    const syrFrost = Math.min(1, item.frostOpacity || 0);
    if (syrFrost > 0.03) {
      const fGrad = ctx.createLinearGradient(barrelLeft, barrelTop, barrelLeft, barrelTop + barrelH);
      fGrad.addColorStop(0, isDark ? `rgba(224, 242, 254, ${0.42 * syrFrost})` : `rgba(186, 230, 253, ${0.52 * syrFrost})`);
      fGrad.addColorStop(0.5, isDark ? `rgba(241, 245, 249, ${0.12 * syrFrost})` : `rgba(224, 242, 254, ${0.22 * syrFrost})`);
      fGrad.addColorStop(1, isDark ? `rgba(224, 242, 254, ${0.38 * syrFrost})` : `rgba(186, 230, 253, ${0.46 * syrFrost})`);
      ctx.fillStyle = fGrad;
      ctx.fillRect(chamberLeft, innerTop, chamberW, innerH);
      ctx.strokeStyle = isDark ? `rgba(248, 250, 252, ${0.55 * syrFrost})` : `rgba(14, 165, 233, ${0.45 * syrFrost})`;
      ctx.lineWidth = 0.85;
      for (let i = 0; i < 6; i++) {
        const fx = chamberLeft + 4 + ((i * 0.618 + 0.1) % 1) * Math.max(6, chamberW - 8);
        const fy = innerTop + 5 + ((i * 0.41) % 1) * Math.max(6, innerH - 10);
        ctx.beginPath();
        ctx.moveTo(fx - 2.6, fy);
        ctx.lineTo(fx + 2.6, fy);
        ctx.moveTo(fx, fy - 2.6);
        ctx.lineTo(fx, fy + 2.6);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  // Active inflow jet ripples spraying through Luer-Lock into barrel
  if ((item.inflowLiquidTimer || 0) > 0 && (item.inflowLiquidRateMlS || 0) > 0.05) {
    const jetCol = item.inflowLiquidColor || 'rgba(186, 230, 253, 0.9)';
    const pulse = (timeNow * 14) % 1;
    const endJet = frontX + barrelDir * (10 + pulse * 18);
    ctx.save();
    ctx.strokeStyle = jetCol;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(frontX - barrelDir * 14, y);
    ctx.lineTo(barrelDir > 0 ? Math.min(chamberRight, endJet) : Math.max(chamberLeft, endJet), y);
    ctx.stroke();
    ctx.restore();
  }

  // Rear collar spill stream when full 250 mL syringe overflows
  if ((item.overflowOutRateMlS || 0) > 0.5) {
    const rearEdgeX = rearX + barrelDir * 3;
    const wobble = Math.sin((timeNow || 0) * 18) * 1.8;
    ctx.save();
    ctx.strokeStyle = item.overflowOutColor || 'rgba(186, 230, 253, 0.88)';
    ctx.lineWidth = Math.min(6, 2.4 + Math.sqrt(item.overflowOutRateMlS) * 0.3);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(rearEdgeX, y + 10);
    ctx.quadraticCurveTo(rearEdgeX + barrelDir * 18 + wobble, y + 32, rearEdgeX + barrelDir * 24, y + 70);
    ctx.stroke();
    ctx.restore();
  }

  // Active parabolic water stream discharging from Luer nozzle downward!
  if ((item.dischargeLiquidRateMlS || 0) > 0.15 && item.dischargeArc && item.dischargeArc.points?.length >= 2) {
    const arcPts = item.dischargeArc.points;
    ctx.save();
    ctx.strokeStyle = item.dischargeColor || 'rgba(186, 230, 253, 0.9)';
    ctx.lineWidth = Math.min(5.2, 2.0 + Math.sqrt(item.dischargeLiquidRateMlS) * 0.32);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(arcPts[0].x, arcPts[0].y);
    for (let i = 1; i < arcPts.length; i++) {
      ctx.lineTo(arcPts[i].x, arcPts[i].y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  // Ground-glass frosted plunger piston + twin black PTFE O-ring seals + pull rod
  const pistonW = 16;
  const pistonMinX = Math.min(plungerFaceX, plungerFaceX + barrelDir * pistonW);
  const rodStartX = plungerFaceX + barrelDir * pistonW;
  const rodTailX = plungerFaceX + barrelDir * (travelSpan * 0.42 + 44);
  ctx.fillStyle = isDark ? 'rgba(203, 213, 225, 0.35)' : 'rgba(241, 245, 249, 0.72)';
  ctx.strokeStyle = pal.glassStroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(pistonMinX, barrelTop + 4, pistonW, barrelH - 8, 2);
  ctx.fill();
  ctx.stroke();
  // Dual PTFE Teflon sealing rings
  ctx.fillStyle = '#0f172a';
  const seal1 = plungerFaceX + barrelDir * 2;
  const seal2 = plungerFaceX + barrelDir * 10.5;
  ctx.fillRect(barrelDir > 0 ? seal1 : seal1 - 3.2, barrelTop + 3, 3.2, barrelH - 6);
  ctx.fillRect(barrelDir > 0 ? seal2 : seal2 - 3.2, barrelTop + 3, 3.2, barrelH - 6);
  // Frosted glass plunger rod + ring grip
  const rodSpan = Math.max(16, Math.abs(rodTailX - rodStartX));
  const rodRectX = barrelDir > 0 ? rodStartX : rodStartX - rodSpan;
  ctx.fillStyle = isDark ? 'rgba(148, 163, 184, 0.65)' : 'rgba(100, 116, 139, 0.6)';
  ctx.fillRect(rodRectX, y - 4.5, rodSpan, 9);
  ctx.strokeStyle = pal.glassStroke;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.roundRect(barrelDir > 0 ? rodTailX : rodTailX - 8, y - 16, 8, 32, 3);
  ctx.stroke();

  // Ceramic enamel graduations every 10 mL (0..250 mL) + major numeric ticks every 50 mL (never mirrored!)
  ctx.font = '600 7.5px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (let ml = 0; ml <= 250; ml += 10) {
    const tx = travelStartX + barrelDir * ((ml / 250) * travelSpan);
    const isMajor50 = ml % 50 === 0;
    const len = isMajor50 ? 11 : 6;
    ctx.strokeStyle = isMajor50 ? pal.tickStroke : pal.tickMinor;
    ctx.lineWidth = isMajor50 ? 1.15 : 0.8;
    ctx.beginPath();
    ctx.moveTo(tx, barrelTop);
    ctx.lineTo(tx, barrelTop + len);
    ctx.stroke();
    if (isMajor50) {
      ctx.fillStyle = pal.enamelText;
      ctx.fillText(String(ml), tx, barrelTop + 12);
    }
  }
  ctx.fillStyle = pal.enamelText;
  ctx.font = '600 7px system-ui, sans-serif';
  ctx.textAlign = barrelDir > 0 ? 'right' : 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('250 mL · ±1.5% · ID 42.9mm', barrelDir > 0 ? barrelRight - 10 : barrelLeft + 10, barrelTop + barrelH - 4);

  // Live Gas + Liquid + Temperature Badge below syringe
  const gasTag = getDominantSyringeGasFormula(item, langCode);
  const syrPhaseIcon = frozenMl > totalLiqMl ? '❄️' : '💧';
  let labelText;
  if (totalFluidMl > 0.2 && gasVolMl > 0.5) {
    labelText = `💨 ${gasTag} ${gasVolMl.toFixed(1)} + ${syrPhaseIcon} ${totalFluidMl.toFixed(1)} mL · ${syrTempC.toFixed(0)}°C`;
  } else if (overflowMl > 0.2 || frozenMl > 0.2) {
    labelText =
      langCode === 'vi'
        ? `${syrPhaseIcon} ${frozenMl > totalLiqMl ? 'Băng' : 'Tràn vào'}: ${totalFluidMl.toFixed(1)} mL · ${syrTempC.toFixed(0)}°C`
        : `${syrPhaseIcon} ${frozenMl > totalLiqMl ? 'Ice' : 'Liquid'}: ${totalFluidMl.toFixed(1)} mL · ${syrTempC.toFixed(0)}°C`;
  } else {
    labelText = `${gasTag}: ${gasVolMl.toFixed(1)} mL · ${syrTempC.toFixed(0)}°C`;
  }
  if (nh4clMol > 1e-6) {
    labelText += ` · 🧂 ${(nh4clMol * 1000).toFixed(2)}mmol NH₄Cl`;
  }
  if (overP > 0.08) {
    labelText += ` · +${overP.toFixed(2)} bar`;
  }
  const badgeTopY = y + collarH / 2 + 6;
  drawLabelPill(ctx, x, badgeTopY, labelText, {
    pal,
    borderColor: overP >= 0.35 ? '#ef4444' : isSelected ? '#3b82f6' : syrTempC >= 55 ? '#f59e0b' : pal.badgeBorder,
    font: '600 11.5px system-ui, sans-serif',
    height: 22,
  });

  // Condensation or Syringe 250mL-Overflow secondary status badge
  const isCondensing = (item.lastCondenseRateMolS || 0) > 1e-6;
  const isSpillingOut = (item.overflowOutRateMlS || 0) > 0.5;
  if (isSpillingOut) {
    const ovText =
      langCode === 'vi'
        ? '💧 Đầy 250 mL — Nước tràn khỏi xilanh!'
        : '💧 250 mL Full — Syringe overflowing!';
    drawLabelPill(ctx, x, badgeTopY + 26, ovText, {
      pal,
      borderColor: '#ef4444',
      font: '600 10.5px system-ui, sans-serif',
      height: 20,
    });
  } else if (condensedMl > 0.0005 || isCondensing) {
    const condSpeciesTag =
      condensedWaterMl > 0.0005 && condensedEtOHMl > 0.0005
        ? 'H₂O + C₂H₅OH'
        : condensedEtOHMl > 0.0005
        ? 'C₂H₅OH(l)'
        : 'H₂O(l)';
    const condText =
      langCode === 'vi'
        ? `💧 Ngưng tụ: ${condensedMl.toFixed(2)} mL ${condSpeciesTag}${isCondensing ? ' · Đang ngưng!' : ''}`
        : `💧 Condensed: ${condensedMl.toFixed(2)} mL ${condSpeciesTag}${isCondensing ? ' · Condensing!' : ''}`;
    drawLabelPill(ctx, x, badgeTopY + 26, condText, {
      pal,
      borderColor: isCondensing ? '#0ea5e9' : '#38bdf8',
      font: '600 10.5px system-ui, sans-serif',
      height: 20,
      alpha: isCondensing ? 0.96 + Math.sin(timeNow * 6) * 0.04 : 0.94,
    });
  }

  ctx.restore();
}

export function renderPipette(ctx, item, isSelected, isDark, langCode = 'vi', timeNow = 0) {
  const spec = APPARATUS.pipette_10;
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const h = spec.height;
  const top = y - h / 2;
  const bottom = y + h / 2;

  if (item.isBroken) {
    ctx.save();
    ctx.strokeStyle = isSelected ? '#3b82f6' : '#ef4444';
    ctx.lineWidth = 1.4;
    ctx.fillStyle = pal.glassFill;
    ctx.beginPath();
    ctx.moveTo(x - 16, bottom - 12);
    ctx.lineTo(x + 12, bottom - 6);
    ctx.lineTo(x + 6, bottom - 1);
    ctx.lineTo(x - 14, bottom - 1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    drawLabelPill(ctx, x, bottom - 32, `${item.label} · 💥`, {
      pal,
      borderColor: '#ef4444',
      font: '600 10px system-ui, sans-serif',
      height: 17,
    });
    ctx.restore();
    return;
  }

  const cap = item.capacityMl || 10.0;
  const volMl = Math.max(0, Math.min(cap, item.volumeMl || 0));
  const fillRatio = volMl / cap;
  const isSucking = (item.drawAnimTimer || 0) > 0;
  const isDripping = (item.dispenseAnimTimer || 0) > 0;
  const bulbPinch = isSucking
    ? Math.sin(((item.drawAnimTimer || 0) / 0.68) * Math.PI) * 2.8
    : isDripping
    ? -Math.sin(((item.dispenseAnimTimer || 0) / 0.48) * Math.PI) * 2.4
    : 0;

  ctx.save();
  if (isSelected) {
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 11;
  }

  // Tilted slight ergonomic angle while dragged or wobbling from impact
  const totTilt = (item.tiltAngle || 0) + (item.landingTilt || 0);
  if (totTilt) {
    ctx.translate(x, y);
    ctx.rotate(totTilt);
    ctx.translate(-x, -y);
  }

  // Top Silicone squeezing bulb
  const bulbW = 10 - bulbPinch;
  ctx.fillStyle = '#0284c7';
  ctx.strokeStyle = isSelected ? '#3b82f6' : '#0369a1';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x - 6, top + 28);
  ctx.quadraticCurveTo(x - bulbW - 2, top + 12, x, top + 2);
  ctx.quadraticCurveTo(x + bulbW + 2, top + 12, x + 6, top + 28);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Locking plastic collar
  ctx.fillStyle = '#334155';
  ctx.fillRect(x - 7, top + 26, 14, 6);

  // Graduated borosilicate glass barrel -> tapered capillary tip
  const bodyTop = top + 32;
  const taperTop = bottom - 34;
  ctx.beginPath();
  ctx.moveTo(x - 6, bodyTop);
  ctx.lineTo(x + 6, bodyTop);
  ctx.lineTo(x + 6, taperTop);
  ctx.lineTo(x + 1.8, bottom - 2);
  ctx.lineTo(x - 1.8, bottom - 2);
  ctx.lineTo(x - 6, taperTop);
  ctx.closePath();
  ctx.fillStyle = pal.glassFill;
  ctx.fill();

  // Internal liquid filled inside pipette tube
  if (fillRatio > 0.004) {
    ctx.save();
    ctx.clip();
    const usableH = taperTop - (bodyTop + 6);
    const liqTopY = taperTop - fillRatio * usableH;
    const liqCol = item.liquidColor || 'rgba(56, 189, 248, 0.78)';
    ctx.fillStyle = liqCol;
    ctx.fillRect(x - 8, liqTopY, 16, bottom - liqTopY);

    // Rising glow shimmer during suction
    if (isSucking) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      const waveY = bottom - ((timeNow * 180) % (bottom - bodyTop));
      ctx.fillRect(x - 6, waveY, 12, 6);
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - 6, liqTopY);
    ctx.quadraticCurveTo(x, liqTopY + 1.8, x + 6, liqTopY);
    ctx.stroke();
    ctx.restore();
  }

  // Outer glass stroke & graduated tick marks (2..10 mL)
  ctx.beginPath();
  ctx.moveTo(x - 6, bodyTop);
  ctx.lineTo(x + 6, bodyTop);
  ctx.lineTo(x + 6, taperTop);
  ctx.lineTo(x + 1.8, bottom - 2);
  ctx.lineTo(x - 1.8, bottom - 2);
  ctx.lineTo(x - 6, taperTop);
  ctx.closePath();
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = isSelected ? 2 : 1.5;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = pal.tickStroke;
  ctx.lineWidth = 0.9;
  for (let m = 2; m <= 10; m += 2) {
    const ty = taperTop - (m / 10) * (taperTop - (bodyTop + 6));
    ctx.beginPath();
    ctx.moveTo(x - 5.5, ty);
    ctx.lineTo(x + 0.5, ty);
    ctx.stroke();
  }

  // Floating status badge above silicone bulb
  const badgeText =
    item.hoveredActionLabel ||
    `${item.label} · ${volMl.toFixed(2)} mL`;
  drawLabelPill(ctx, x, top - 24, badgeText, {
    pal,
    borderColor: isSucking ? '#10b981' : isDripping ? '#38bdf8' : isSelected ? '#3b82f6' : pal.badgeBorder,
    font: '600 10.5px system-ui, sans-serif',
    height: 19,
  });

  ctx.restore();
}

export function renderTubingConnections(ctx, items, isDark, timeNow = 0, langCode = 'vi') {
  const pal = getThemePalette(isDark);
  for (const v of items) {
    const tid = v.connectedTargetId || v.connectedSyringeId;
    if (v.kind !== 'vessel' || !tid) continue;
    const target = items.find((it) => it.id === tid);
    if (!target) continue;

    const geom = computeTubingGeometry(v, target);
    const { p0, p1, p2, p3, points, arcLengthCm, capacityMl } = geom;

    ctx.save();
    // Outer translucent silicone/rubber tubing jacket
    ctx.strokeStyle = isDark ? 'rgba(71, 85, 105, 0.72)' : 'rgba(51, 65, 85, 0.62)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    ctx.stroke();

    // Inner bore dark contrast channel
    ctx.strokeStyle = isDark ? 'rgba(15, 23, 42, 0.62)' : 'rgba(241, 245, 249, 0.45)';
    ctx.lineWidth = 4.2;
    ctx.stroke();

    // Specular tubing highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Liquid column physically filling and moving inside the tube up to fillFraction
    const tubeVolMl = computeLiquidVolumeL(v.tubeMoles || {}, v.tubeTempK || v.tempK) * 1000;
    const fillFrac = Math.max(0, Math.min(1, tubeVolMl / Math.max(0.1, capacityMl)));
    if (fillFrac > 0.004 && points.length >= 2) {
      const exactIdx = fillFrac * (points.length - 1);
      const maxIdx = Math.min(points.length - 1, Math.floor(exactIdx));
      const fracTail = exactIdx - maxIdx;

      ctx.save();
      ctx.strokeStyle = v.tubeColor || 'rgba(186, 230, 253, 0.9)';
      ctx.lineWidth = 4.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i <= maxIdx; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      if (maxIdx < points.length - 1 && fracTail > 0.01) {
        const a = points[maxIdx];
        const b = points[maxIdx + 1];
        ctx.lineTo(a.x + (b.x - a.x) * fracTail, a.y + (b.y - a.y) * fracTail);
      }
      ctx.stroke();

      // Animated bright liquid flow slugs surging along filled length when pumping or sucking (Ammonia Fountain)
      const isFountainPull = (target.fountainFlowMlS || 0) > 0.5;
      if ((v.tubeLiquidFlowTimer || 0) > 0 || isFountainPull) {
        ctx.fillStyle = isFountainPull ? (target.fountainFlowColor || 'rgba(244, 114, 182, 0.85)') : 'rgba(255, 255, 255, 0.72)';
        const dir = isFountainPull ? -1 : 1;
        for (let k = 0; k < 5; k++) {
          const raw = (timeNow * (isFountainPull ? 2.2 : 1.4) * dir + k * 0.2) % 1;
          const tFlow = ((raw + 1) % 1) * (isFountainPull ? 1.0 : fillFrac);
          const fPt = cubicBezierPoint(tFlow, p0, p1, p2, p3);
          ctx.beginPath();
          ctx.arc(fPt.x, fPt.y, isFountainPull ? 2.6 : 1.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Pouring stream from tubing outlet into receiving Vessel B
    if ((v.tubeLiquidSpillRateMlS || 0) > 0.2 && target.kind === 'vessel' && !target.isShattered) {
      const tSpec = APPARATUS[target.typeId];
      const dstLiqMl = computeLiquidVolumeL(target.moles, target.tempK) * 1000;
      const dstGeom = computeVesselFluidGeometry(tSpec, target.y, dstLiqMl + computeSolidVolumeMl(target.moles));
      const wobble = Math.sin((timeNow || 0) * 18) * 1.8;
      ctx.save();
      ctx.strokeStyle = v.tubeLiquidSpillColor || v.tubeColor || 'rgba(186, 230, 253, 0.88)';
      ctx.lineWidth = Math.min(5, 2.2 + Math.sqrt(v.tubeLiquidSpillRateMlS) * 0.3);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p3.x, p3.y);
      ctx.quadraticCurveTo(p3.x + wobble, (p3.y + dstGeom.surfaceY) * 0.5, p3.x, Math.max(p3.y + 8, dstGeom.surfaceY + 2));
      ctx.stroke();
      ctx.restore();
    }

    // Animated steam/gas flow pulses & tubing geometry/temperature label
    const isGasFlowing = (v.tubeFlowBannerTimer || 0) > 0 && v.tubeFlowFormula;
    if (isGasFlowing) {
      const alpha = Math.min(1, v.tubeFlowBannerTimer / 0.45);
      const isSteamTube = v.tubeFlowFormula.includes('H₂O');
      const pulseCol = v.tubeFlowFormula.includes('Cl₂')
        ? 'rgba(217, 249, 157, 0.92)'
        : isSteamTube
        ? 'rgba(224, 242, 254, 0.95)'
        : 'rgba(125, 211, 252, 0.88)';
      for (let i = 0; i < 4; i++) {
        const tCurve = ((timeNow * 1.15) + i * 0.25) % 1;
        const pt = cubicBezierPoint(tCurve, p0, p1, p2, p3);
        ctx.globalAlpha = alpha * (0.55 + Math.sin(tCurve * Math.PI) * 0.4);
        ctx.fillStyle = pulseCol;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, isSteamTube ? 3.1 : 2.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    const midPt = cubicBezierPoint(0.48, p0, p1, p2, p3);
    if (tubeVolMl > 0.04 || (v.tubeLiquidFlowTimer || 0) > 0) {
      const liqText = `💧 Ø6mm·${arcLengthCm.toFixed(0)}cm: ${Math.min(tubeVolMl, capacityMl).toFixed(1)}/${capacityMl.toFixed(1)} mL`;
      drawLabelPill(ctx, midPt.x, midPt.y - 28, liqText, {
        pal,
        borderColor: '#38bdf8',
        font: '600 10.5px system-ui, sans-serif',
        height: 19,
        itemIds: [v.id, target.id],
      });
    } else if (isGasFlowing) {
      const tFlowC = kelvinToCelsius(v.tubeFlowTempK ?? v.tempK);
      const alpha = Math.min(1, v.tubeFlowBannerTimer / 0.45);
      drawLabelPill(ctx, midPt.x, midPt.y - 26, `→ ${v.tubeFlowFormula} · ${tFlowC.toFixed(0)}°C`, {
        pal,
        borderColor: tFlowC >= 95 ? '#f59e0b' : '#38bdf8',
        font: '600 10.5px system-ui, sans-serif',
        height: 19,
        alpha,
        itemIds: [v.id, target.id],
      });
    }

    ctx.restore();
  }

  // Render Liebig Condenser outlet delivery tubing into receiving vessel
  for (const cond of items) {
    if (cond.kind !== 'condenser' || cond.isBroken || !cond.outletTargetId) continue;
    const receiver = items.find((it) => it.id === cond.outletTargetId && !it.isShattered);
    if (!receiver) continue;
    const { p0, p1, p2, p3 } = computeCondenserOutletGeometry(cond, receiver);
    ctx.save();
    ctx.strokeStyle = isDark ? 'rgba(56, 189, 248, 0.72)' : 'rgba(14, 165, 233, 0.65)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    ctx.stroke();
    ctx.strokeStyle = isDark ? 'rgba(186, 230, 253, 0.55)' : 'rgba(241, 245, 249, 0.72)';
    ctx.lineWidth = 2.6;
    ctx.stroke();
    if (cond.activeDrop) {
      ctx.fillStyle = 'rgba(224, 242, 254, 0.92)';
      for (let k = 0; k < 3; k++) {
        const u = ((timeNow * 1.45 + k * 0.33) % 1);
        const dp = cubicBezierPoint(u, p0, p1, p2, p3);
        ctx.beginPath();
        ctx.arc(dp.x, dp.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

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

export function renderVessel(ctx, vessel, opts) {
  const { isSelected, isDropTarget, isDark, timeNow, langCode = 'vi' } = opts;
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

  // Drop target glow ring or Borosilicate high-T softening crimson thermal glow
  if (isDropTarget) {
    ctx.shadowColor = '#10b981';
    ctx.shadowBlur = 18;
  } else if ((vessel.softenGlowFrac || 0) > 0.08) {
    ctx.shadowColor = `rgba(249, 115, 22, ${Math.min(0.95, 0.35 + vessel.softenGlowFrac * 0.6).toFixed(2)})`;
    ctx.shadowBlur = 14 + vessel.softenGlowFrac * 12;
  } else if (isSelected) {
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 12;
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
    ctx.shadowBlur = 0;
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
    ((vessel.moles.H2O_l || 0) > 1e-7 || (vessel.moles.C2H5OH_l || 0) > 1e-7 || strat.totalLiqMl > 0.15);

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
      { phaseFilter: 'all', suspensionLevel: vessel.suspensionLevel || 0 }
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

      // Colored headspace gas tint (Cl2 pale green-yellow / NO2 amber) inside upper dome
      const hCl2 = vessel.headspaceGasMoles?.Cl2_g || 0;
      const hNO2 = vessel.headspaceGasMoles?.NO2_g || 0;
      if (hCl2 > 1e-6 || hNO2 > 1e-6) {
        ctx.fillStyle = hNO2 >= hCl2 ? 'rgba(217, 119, 6, 0.34)' : 'rgba(190, 242, 100, 0.32)';
        ctx.fillRect(x - w / 2, divY, w, interiorBottom - divY + 4);
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
        ctx.fillStyle = vis.css;
        ctx.fillRect(x - w / 2, surfaceY, w, interiorBottom - surfaceY + 4);
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
          // Concave meniscus (or deeper vortex funnel when magnetic stir bar spins rapidly)
          const vortexDip = (vessel.magStirRpm || 0) > 0 && vessel.hasStirBar && !vessel.isFrozenSolid
            ? 3.5 + Math.min(10, (vessel.magStirRpm / 1200) * 9) + Math.sin(timeNow * 24) * 1.2
            : 3.2;
          ctx.beginPath();
          ctx.moveTo(x - surfaceHalfWPx, surfaceY);
          ctx.quadraticCurveTo(x, surfaceY + vortexDip, x + surfaceHalfWPx, surfaceY);
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

  // Draw rotating PTFE magnetic stir bar on vessel bottom
  if (vessel.hasStirBar) {
    const spinHalf = 11 * Math.max(0.28, Math.abs(Math.cos(vessel.stirBarPhase || 0)));
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - spinHalf, interiorBottom - 7, spinHalf * 2, 5.5, 2.5);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Draw floating slush or solid frozen H2O(s) ice matrix with trapped solute tint & crystalline facets
  if (hasIce) {
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
  }

  // Draw solids, crystals, precipitates, and floating Na inside clipped region
  const currentWidthAtBottom = w - 6;
  const naInterfaceY = vessel.naInterfaceMl != null && strat.hasLightCover ? volumeMlToY(vessel.naInterfaceMl) : null;
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
    },
    hasWater,
    surfaceY
  );

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

  // Draw glass outer silhouette + ISO reinforced wall + red-orange thermal softening sag
  ctx.shadowBlur = 0;
  traceVesselPath(ctx, spec, x, y, sagFrac);
  const softenG = vessel.softenGlowFrac || 0;
  ctx.strokeStyle = vessel.isShattered
    ? '#ef4444'
    : softenG > 0.25
    ? `rgb(249, ${Math.max(60, Math.round(160 - softenG * 100))}, 22)`
    : isDropTarget
    ? '#10b981'
    : isSelected
    ? '#3b82f6'
    : pal.glassStroke;
  ctx.lineWidth = isSelected || isDropTarget ? 2.5 : spec.wallThicknessMm >= 1.1 || spec.shape === 'dish' || spec.shape === 'mortar' || spec.shape === 'crucible' ? 2.3 : 1.75;
  ctx.stroke();

  // Horizontal Fused Quartz Tube & U-Shaped Quartz Tube double-ended stoppers, phen cotton plugs & tubing ports
  if (spec.hasTwoEnds && !vessel.isShattered) {
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
      // Rolled glass lip caps at both open U-tube limbs
      ctx.strokeStyle = pal.glassStroke;
      ctx.lineWidth = 2.0;
      for (const armSign of [-1, 1]) {
        const cxArm = x + armSign * dxU;
        ctx.beginPath();
        ctx.ellipse(cxArm, topY, rOut + 1.5, 2.2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Curved outer specular highlights following U-arms smoothly into the lower bend (never cutting straight across bottom!)
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

  // Glass vertical specular highlight & bottom heavy-base tint (skip dual/horizontal tubes & opaque porcelain)
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
    // Frosted write-on enamel label patch
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
    ctx.fillText('mL', patchX + patchW / 2, patchY + 15);
  } else if (spec.shape === 'erlenmeyer') {
    // Non-linear conical graduations directly from VesselGeometry radial-volume slices
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
    // Frosted write-on enamel patch on slanted conical shoulder
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
    ctx.fillText('ISO', patchX + patchW / 2, patchY + 15.5);
  } else if (spec.shape === 'round_flask') {
    // NS 29/32 ground-glass joint neck band + ISO bulb graduations + non-overlapping capacity badge
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
    // U-Tube arm ceramic enamel graduations along outside of LEFT limb (never in center gap or colliding with docked electrode)
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
    // Sparse horizontal graduation marks along quartz combustion barrel (omit cramped 40 label)
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
    // Calibrated 1500 mL Glass Bath graduations every 250 mL (major ticks at 500 & 1000 mL)
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
    // ISO 4142 Test Tube ceramic enamel white graduations every 5 mL (10, 30, 50 mL labels for clean spacing)
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

      ctx.shadowColor = 'rgba(15, 23, 42, 0.22)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1.5;
      ctx.fillStyle = noteBg;
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.25)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.roundRect(nx, ny, noteW, noteH, 3);
      ctx.fill();
      ctx.shadowColor = 'transparent';
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
        ctx.fillText(lines[0], x, ny + noteH / 2 + 0.5, noteW - 8);
      } else {
        ctx.fillText(lines[0], x, ny + 8, noteW - 8);
        ctx.fillText(lines[1], x, ny + 18.5, noteW - 8);
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
  const ph = hasWater && !vessel.isFrozenSolid ? computePH(vessel.moles, liqL, vessel.tempK) : null;
  const pillParts = [vessel.isInverted ? `🙃 ${vessel.label}` : vessel.label];
  if (vessel.isInverted || Object.values(vessel.headspaceGasMoles || {}).some((n) => (n || 0) > 1e-6)) {
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
