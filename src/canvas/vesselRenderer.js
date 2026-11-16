import { APPARATUS } from '../data/apparatus.js';
import { kelvinToCelsius } from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import {
  computeLiquidVolumeL,
  computePH,
  computeSolidVolumeMl,
  computeSolutionVisuals,
} from '../engine/equilibrium.js';
import {
  ALL_GASES,
  buildCombinedSyringeLiquidMoles,
  computeSyringeGasVolumeMl,
  computeSyringeLiquidVolumeMl,
  computeSyringeTotalVolumeMl,
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

function getThemePalette(isDark) {
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

function drawLabelPill(ctx, cx, cy, text, opts = {}) {
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

function getDominantSyringeGasFormula(syringe, langCode) {
  let bestKey = null;
  let bestMol = 1e-8;
  for (const g of ALL_GASES) {
    const n = syringe.gasMoles[g] || 0;
    if (n > bestMol) {
      bestMol = n;
      bestKey = g;
    }
  }
  if (!bestKey) return langCode === 'vi' ? 'Khí' : 'Gas';
  return SPECIES[bestKey]?.formula || bestKey;
}

/**
 * Trace the outer glass silhouette path directly from VesselGeometry profilePoints.
 */
function traceVesselPath(ctx, spec, x, y) {
  const { pts, bottom, baseBottom } = mapProfileToCanvas(spec, x, y, 0);
  const lastIdx = pts.length - 1;
  const spoutLeftExtra = spec.shape === 'beaker' || spec.shape === 'cylinder' ? 3.5 : 0;

  ctx.beginPath();
  // Top-left rim -> descend left wall across bottom fillet -> cross base -> ascend right wall
  ctx.moveTo(x - pts[lastIdx].rx - spoutLeftExtra, pts[lastIdx].cy);
  for (let i = lastIdx - 1; i >= 0; i--) {
    ctx.lineTo(x - pts[i].rx, pts[i].cy);
  }
  if (spec.shape === 'test_tube') {
    // Smooth curve through rounded pole at i = 0
    ctx.lineTo(x + pts[0].rx, pts[0].cy);
  } else {
    ctx.lineTo(x + pts[0].rx, pts[0].cy);
  }
  for (let i = 1; i <= lastIdx; i++) {
    ctx.lineTo(x + pts[i].rx, pts[i].cy);
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
function traceVesselInteriorClip(ctx, spec, x, y) {
  const pad = spec.shape === 'beaker' ? 2.6 : 2.1;
  const { pts } = mapProfileToCanvas(spec, x, y, pad);
  const lastIdx = pts.length - 1;

  ctx.beginPath();
  ctx.moveTo(x - pts[lastIdx].rx, pts[lastIdx].cy);
  for (let i = lastIdx - 1; i >= 0; i--) {
    ctx.lineTo(x - pts[i].rx, pts[i].cy);
  }
  ctx.lineTo(x + pts[0].rx, pts[0].cy);
  for (let i = 1; i <= lastIdx; i++) {
    ctx.lineTo(x + pts[i].rx, pts[i].cy);
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
  const spec = APPARATUS.burner;
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const powerW = item.powerW ?? (spec.powerLevelsW[item.flameLevel || 0] || 0);
  const powerFrac = Math.max(0, Math.min(1, powerW / (spec.maxPowerW || 650)));
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

  // Tripod stand + wire gauze
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

    const outerGrad = ctx.createRadialGradient(x, fBaseY - fH * 0.35, 2, x, fBaseY - fH * 0.35, fH * 0.8);
    outerGrad.addColorStop(0, 'rgba(253, 224, 71, 0.95)');
    outerGrad.addColorStop(0.55, 'rgba(249, 115, 22, 0.78)');
    outerGrad.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

    ctx.beginPath();
    ctx.moveTo(x - fW, fBaseY);
    ctx.quadraticCurveTo(x - fW * 1.1, fBaseY - fH * 0.5, x + wobble, fBaseY - fH);
    ctx.quadraticCurveTo(x + fW * 1.1, fBaseY - fH * 0.5, x + fW, fBaseY);
    ctx.closePath();
    ctx.fillStyle = outerGrad;
    ctx.fill();

    // Inner blue cone
    ctx.beginPath();
    ctx.moveTo(x - fW * 0.5, fBaseY);
    ctx.quadraticCurveTo(x, fBaseY - fH * 0.55, x + fW * 0.5, fBaseY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.88)';
    ctx.fill();

    // Compact live power badge on burner base
    drawLabelPill(ctx, x, bottom + 6, `🔥 ${Math.round(powerW)} W`, {
      pal,
      borderColor: powerFrac > 0.6 ? '#f97316' : '#f59e0b',
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
    ctx.ellipse(x - 10, bottom - 1, 78, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Cracked Luer tip + shattered barrel base fragments
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(x - 110, bottom - 14, 16, 7);
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
  const top = y - h / 2;
  const bottom = y + h / 2;
  const rodX = x + 36;

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

  // 304 Stainless steel vertical rod
  const rodGrad = ctx.createLinearGradient(rodX - 3.5, 0, rodX + 3.5, 0);
  rodGrad.addColorStop(0, '#64748b');
  rodGrad.addColorStop(0.45, '#e2e8f0');
  rodGrad.addColorStop(1, '#475569');
  ctx.fillStyle = rodGrad;
  ctx.fillRect(rodX - 3, top + 8, 6, h - 22);

  // Finial cap at rod top
  ctx.beginPath();
  ctx.arc(rodX, top + 8, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = '#94a3b8';
  ctx.fill();
  ctx.stroke();

  drawLabelPill(ctx, rodX, top - 16, stand.label, {
    pal,
    borderColor: isSelected ? '#3b82f6' : pal.badgeBorder,
    font: '600 10px system-ui, sans-serif',
    height: 17,
  });
  ctx.restore();
}

export function renderRetortClampJaw(ctx, stand, clampedItem, isDark) {
  if (!stand || !clampedItem) return;
  const rodX = stand.x + 36;
  const spec = APPARATUS[clampedItem.typeId];
  const isSyr = clampedItem.kind === 'gas_syringe';

  let attachX = clampedItem.x;
  let attachY = clampedItem.y;
  if (isSyr) {
    const barrelLeft = clampedItem.x - spec.width / 2 + (spec.barrelLeftOffset || 20);
    const barrelRight = barrelLeft + (spec.barrelW || 192);
    // Grip rear collar/barrel section horizontally closest to stand rod without crossing the graduations
    attachX = Math.max(barrelLeft + 32, Math.min(barrelRight - 14, rodX - 24));
    attachY = clampedItem.y;
  } else {
    attachY = clampedItem.y - spec.height / 2 + (spec.shape === 'erlenmeyer' ? 24 : 26);
  }

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
  ctx.fillRect(rodX + 8, attachY - 3, 6, 6);

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
  const w = spec.width;
  const barrelW = spec.barrelW || 192;
  const barrelH = spec.barrelH || 54;
  const collarH = spec.collarH || 64;
  const barrelLeft = x - w / 2 + (spec.barrelLeftOffset || 20);
  const barrelTop = y - barrelH / 2;

  const gasVolMl = computeSyringeGasVolumeMl(item, env);
  const syrTempK = item.tempK ?? env.tempK;
  const overflowL = computeLiquidVolumeL(item.overflowMoles || {}, syrTempK);
  const overflowMl = overflowL * 1000;
  const condensedMl = ((item.condensedWaterMol || 0) * SPECIES.H2O_l.molarMass) / 0.997;
  const totalLiqMl = overflowMl + condensedMl;
  const totalVolMl = computeSyringeTotalVolumeMl(item, env);

  // Calibrate stroke: 0 mL tick aligns directly with chamber front face; travel span = 166 px
  const travelStart = barrelLeft + 8;
  const travelSpan = barrelW - 26;
  const ratio = Math.max(0, Math.min(1, totalVolMl / spec.maxVolumeMl));
  const plungerFaceX = travelStart + ratio * travelSpan;
  const activeChamberRight = Math.max(barrelLeft + 3, plungerFaceX);

  const hasSteam = (item.gasMoles?.H2O_g || 0) > 1e-6;
  const hasCl2 = (item.gasMoles?.Cl2_g || 0) > 1e-6;
  const syrTempC = kelvinToCelsius(syrTempK);
  const overP = (item.internalPressureBar || env.pressureBar) - env.pressureBar;

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
    ctx.ellipse(barrelLeft - 8, barrelTop + barrelH + 10, 26, 3.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Stainless steel / Chrome Luer-Lock precision connector tip on left
  ctx.fillStyle = '#94a3b8';
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1;
  ctx.fillRect(barrelLeft - 18, y - 3.5, 11, 7);
  ctx.strokeRect(barrelLeft - 18, y - 3.5, 11, 7);
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(barrelLeft - 8, y - 7, 8, 14);
  ctx.strokeRect(barrelLeft - 8, y - 7, 8, 14);

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
  ctx.roundRect(barrelLeft + barrelW - 4, y - collarH / 2, 7, collarH, 3);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Inner chamber strictly clipped to [barrelLeft + 2 .. plungerFaceX] — NEVER bleeds behind piston!
  const chamberW = Math.max(0, activeChamberRight - (barrelLeft + 2));
  if (chamberW > 0.5) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(barrelLeft + 2, barrelTop + 2, barrelW - 4, barrelH - 4, 4);
    ctx.clip();
    ctx.beginPath();
    ctx.rect(barrelLeft + 2, barrelTop + 2, chamberW, barrelH - 4);
    ctx.clip();

    const innerTop = barrelTop + 2;
    const innerH = barrelH - 4;
    const innerBot = innerTop + innerH;

    // 1. Gas phase color fill inside expanded chamber
    if (gasVolMl > 0.05) {
      ctx.fillStyle = hasCl2
        ? 'rgba(190, 242, 100, 0.34)'
        : hasSteam
        ? isDark
          ? 'rgba(226, 232, 240, 0.26)'
          : 'rgba(148, 163, 184, 0.26)'
        : 'rgba(186, 230, 253, 0.14)';
      ctx.fillRect(barrelLeft + 2, innerTop, chamberW, innerH);
    }

    // 2. Unified aqueous liquid + condensate strictly confined ahead of plunger face!
    if (totalLiqMl > 0.002) {
      const combMoles = buildCombinedSyringeLiquidMoles(item);
      const combL = computeLiquidVolumeL(combMoles, syrTempK);
      let liqColor = isDark ? 'rgba(56, 189, 248, 0.62)' : 'rgba(14, 165, 233, 0.55)';
      if (combL > 1e-8) {
        liqColor = computeSolutionVisuals(
          combMoles,
          combL,
          computePH(combMoles, combL, syrTempK),
          4.29,
          item.overflowBleachFrac || 0
        ).css;
      }

      if (chamberW < 8) {
        // Tiny condensate volume near 0 mL (e.g. 0.90 mL water with 0.0 mL gas):
        // pool proportionally in the front nose gap strictly inside [barrelLeft+2 .. plungerFaceX]
        const miniFrac = Math.max(0.16, Math.min(1, totalLiqMl / 2.2));
        const miniH = innerH * miniFrac;
        ctx.fillStyle = liqColor;
        ctx.fillRect(barrelLeft + 2, innerBot - miniH, chamberW, miniH);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.68)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(barrelLeft + 2, innerBot - miniH);
        ctx.lineTo(activeChamberRight, innerBot - miniH);
        ctx.stroke();
      } else {
        // Horizontal cylinder pool: height derived from cross-section volume fraction V_liq / (V_liq + V_gas)
        const areaFrac = totalLiqMl / Math.max(totalLiqMl + gasVolMl, 1e-6);
        const hFrac = cylinderFillHeightFraction(areaFrac);
        const poolH = Math.max(2.5, innerH * hFrac);
        const poolY = innerBot - poolH;

        ctx.fillStyle = liqColor;
        ctx.fillRect(barrelLeft + 2, poolY, chamberW, poolH);

        if (hFrac < 0.985) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.68)';
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(barrelLeft + 2, poolY);
          ctx.lineTo(activeChamberRight, poolY);
          ctx.stroke();
        }
      }

      // Condensation micro-droplets strictly inside active gas chamber above pool
      if (condensedMl > 0.002 && chamberW >= 12) {
        ctx.fillStyle = 'rgba(186, 230, 253, 0.84)';
        const nDrops = Math.min(10, Math.max(3, Math.floor(chamberW / 12)));
        for (let i = 0; i < nDrops; i++) {
          const dx = barrelLeft + 6 + ((i * 0.618 + 0.13) % 1) * Math.max(4, chamberW - 8);
          const dy = innerTop + 4 + ((i * 0.37) % 1) * Math.max(6, innerH * 0.55);
          ctx.beginPath();
          ctx.arc(dx, dy, 1.1 + (i % 3) * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    ctx.restore();
  }

  // Active inflow jet ripples spraying through Luer-Lock into barrel
  if ((item.inflowLiquidTimer || 0) > 0 && (item.inflowLiquidRateMlS || 0) > 0.05) {
    const jetCol = item.inflowLiquidColor || 'rgba(186, 230, 253, 0.9)';
    const pulse = (timeNow * 14) % 1;
    ctx.save();
    ctx.strokeStyle = jetCol;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(barrelLeft - 14, y);
    ctx.lineTo(Math.min(activeChamberRight, barrelLeft + 10 + pulse * 18), y);
    ctx.stroke();
    ctx.restore();
  }

  // Rear collar spill stream when full 250 mL syringe overflows
  if ((item.overflowOutRateMlS || 0) > 0.5) {
    const rearX = barrelLeft + barrelW + 3;
    const wobble = Math.sin((timeNow || 0) * 18) * 1.8;
    ctx.save();
    ctx.strokeStyle = item.overflowOutColor || 'rgba(186, 230, 253, 0.88)';
    ctx.lineWidth = Math.min(6, 2.4 + Math.sqrt(item.overflowOutRateMlS) * 0.3);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(rearX, y + 10);
    ctx.quadraticCurveTo(rearX + 18 + wobble, y + 32, rearX + 24, y + 70);
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
  // Front piston sealing face sits cleanly AT plungerFaceX!
  const pistonW = 16;
  const rodTailX = plungerFaceX + travelSpan * 0.42 + 44;
  ctx.fillStyle = isDark ? 'rgba(203, 213, 225, 0.35)' : 'rgba(241, 245, 249, 0.72)';
  ctx.strokeStyle = pal.glassStroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(plungerFaceX, barrelTop + 4, pistonW, barrelH - 8, 2);
  ctx.fill();
  ctx.stroke();
  // Dual PTFE Teflon sealing rings
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(plungerFaceX + 2, barrelTop + 3, 3.2, barrelH - 6);
  ctx.fillRect(plungerFaceX + 10.5, barrelTop + 3, 3.2, barrelH - 6);
  // Frosted glass plunger rod + ring grip
  ctx.fillStyle = isDark ? 'rgba(148, 163, 184, 0.65)' : 'rgba(100, 116, 139, 0.6)';
  ctx.fillRect(plungerFaceX + pistonW, y - 4.5, Math.max(16, rodTailX - (plungerFaceX + pistonW)), 9);
  ctx.strokeStyle = pal.glassStroke;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.roundRect(rodTailX, y - 16, 8, 32, 3);
  ctx.stroke();

  // Ceramic enamel graduations every 10 mL (0..250 mL) + major numeric ticks every 50 mL
  ctx.font = '600 7.5px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (let ml = 0; ml <= 250; ml += 10) {
    const tx = travelStart + (ml / 250) * travelSpan;
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
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('250 mL · ±1.5% · ID 42.9mm', barrelLeft + barrelW - 10, barrelTop + barrelH - 4);

  // Live Gas + Liquid + Temperature Badge below syringe
  const gasTag = getDominantSyringeGasFormula(item, langCode);
  let labelText;
  if (totalLiqMl > 0.2 && gasVolMl > 0.5) {
    labelText = `💨 ${gasVolMl.toFixed(1)} + 💧 ${totalLiqMl.toFixed(1)} mL · ${syrTempC.toFixed(0)}°C`;
  } else if (overflowMl > 0.2) {
    labelText =
      langCode === 'vi'
        ? `💧 Tràn vào: ${totalLiqMl.toFixed(1)} mL · ${syrTempC.toFixed(0)}°C`
        : `💧 Liquid: ${totalLiqMl.toFixed(1)} mL · ${syrTempC.toFixed(0)}°C`;
  } else {
    labelText = `${gasTag}: ${gasVolMl.toFixed(1)} mL · ${syrTempC.toFixed(0)}°C`;
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
    const condText =
      langCode === 'vi'
        ? `💧 Ngưng tụ: ${condensedMl.toFixed(2)} mL H₂O${isCondensing ? ' · Đang ngưng!' : ''}`
        : `💧 Condensed: ${condensedMl.toFixed(2)} mL H₂O${isCondensing ? ' · Condensing!' : ''}`;
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

      // Animated bright liquid flow slugs surging along filled length when pumping
      if ((v.tubeLiquidFlowTimer || 0) > 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
        for (let k = 0; k < 4; k++) {
          const tFlow = ((timeNow * 1.4 + k * 0.25) % 1) * fillFrac;
          const fPt = cubicBezierPoint(tFlow, p0, p1, p2, p3);
          ctx.beginPath();
          ctx.arc(fPt.x, fPt.y, 1.9, 0, Math.PI * 2);
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
      });
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

  // Apply pour tilt + impact drop wobble around vessel center
  const effTilt = (vessel.tiltAngle || 0) + (vessel.landingTilt || 0);
  if (effTilt) {
    ctx.translate(x, y);
    ctx.rotate(effTilt);
    ctx.translate(-x, -y);
  }

  // Drop target glow ring
  if (isDropTarget) {
    ctx.shadowColor = '#10b981';
    ctx.shadowBlur = 18;
  } else if (isSelected) {
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 12;
  }

  // Draw subtle glass interior fill first
  ctx.save();
  traceVesselInteriorClip(ctx, spec, x, y);
  ctx.fillStyle = pal.glassFill;
  ctx.fill();
  ctx.clip();

  // Compute liquid & solid levels calibrated to VesselGeometry slice profile
  const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
  const liqMl = liqL * 1000;
  const solMl = computeSolidVolumeMl(vessel.moles);
  const geom = computeVesselFluidGeometry(spec, y, liqMl + solMl);
  const { interiorBottom, scaleY, neckHalf, surfaceY, surfaceHalfWPx, volumeMlToY, volumeMlToState } = geom;
  const hasWater = (vessel.moles.H2O_l || 0) > 1e-7 && liqMl > 0.15;

  // Draw liquid body using Beer-Lambert + Phenolphthalein color
  if (hasWater) {
    const ph = computePH(vessel.moles, liqL, vessel.tempK);
    const vis = computeSolutionVisuals(
      vessel.moles,
      liqL,
      ph,
      spec.opticalPathCm,
      vessel.phenBleachFrac
    );

    ctx.fillStyle = vis.css;
    ctx.fillRect(x - w / 2, surfaceY, w, interiorBottom - surfaceY + 4);

    // Concave meniscus highlight sized accurately to the vessel's radial slice width
    ctx.beginPath();
    ctx.moveTo(x - surfaceHalfWPx, surfaceY);
    ctx.quadraticCurveTo(x, surfaceY + 3.2, x + surfaceHalfWPx, surfaceY);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // Draw solids, crystals, precipitates, and floating Na inside clipped region
  const currentWidthAtBottom = w - 6;
  renderVesselSolids(
    ctx,
    vessel,
    {
      left: x - currentWidthAtBottom / 2,
      right: x + currentWidthAtBottom / 2,
      bottom: interiorBottom,
      top,
      width: currentWidthAtBottom,
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
      const halfSpan = spec.shape === 'erlenmeyer' ? Math.max(8, (spec.neckRadius || 18) * 1.1) : w * 0.38;
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

  // Draw glass outer silhouette + ISO reinforced wall feel
  ctx.shadowBlur = 0;
  traceVesselPath(ctx, spec, x, y);
  ctx.strokeStyle = vessel.isShattered
    ? '#ef4444'
    : isDropTarget
    ? '#10b981'
    : isSelected
    ? '#3b82f6'
    : pal.glassStroke;
  ctx.lineWidth = isSelected || isDropTarget ? 2.5 : spec.wallThicknessMm >= 1.1 ? 2.1 : 1.75;
  ctx.stroke();

  // Glass vertical specular highlight & bottom heavy-base tint
  ctx.strokeStyle = pal.glassHighlight;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (spec.shape === 'erlenmeyer') {
    const shoulderY = interiorBottom - spec.geometry.profilePoints[3][0] * scaleY;
    ctx.moveTo(x - neckHalf + 4, shoulderY + 2);
    ctx.lineTo(x - w * 0.36, bottom - 15);
  } else {
    ctx.moveTo(x - w * 0.33, top + 12);
    ctx.lineTo(x - w * 0.33, bottom - 14);
  }
  ctx.stroke();

  // White ceramic enamel ISO graduations + frosted write-on patch
  ctx.textBaseline = 'middle';
  ctx.font = '600 8px system-ui, sans-serif';
  if (spec.shape === 'beaker') {
    const marks = [25, 50, 75, 100, 125, 150, 175, 200, 225, 250];
    for (const ml of marks) {
      const ty = volumeMlToY(ml);
      const isMajor = ml % 50 === 0;
      const tickX = x - w * 0.32;
      const tickLen = isMajor ? 9 : 5;
      ctx.strokeStyle = isMajor ? pal.tickStroke : pal.tickMinor;
      ctx.lineWidth = isMajor ? 1.1 : 0.8;
      ctx.beginPath();
      ctx.moveTo(tickX, ty);
      ctx.lineTo(tickX + tickLen, ty);
      ctx.stroke();
      if (isMajor && ml < 250) {
        ctx.fillStyle = pal.enamelText;
        ctx.textAlign = 'left';
        ctx.fillText(String(ml), tickX + 11, ty + 0.5);
      }
    }
    // Frosted write-on enamel label patch
    const patchW = spec.formVariant === 'tall' ? 17 : 19;
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
    ctx.fillText('250', patchX + patchW / 2, patchY + 7);
    ctx.font = '600 6.5px system-ui, sans-serif';
    ctx.fillText('mL', patchX + patchW / 2, patchY + 15);
  } else if (spec.shape === 'erlenmeyer') {
    // Non-linear conical graduations directly from VesselGeometry radial-volume slices
    const marks = [50, 100, 150, 200, 250];
    for (const ml of marks) {
      const st = volumeMlToState(ml);
      const ty = st.cy;
      const tickX = x - st.halfWPx * 0.72;
      const tickLen = ml === 250 ? 6 : ml === 100 || ml === 200 ? 9 : 5.5;
      ctx.strokeStyle = pal.tickStroke;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(tickX, ty);
      ctx.lineTo(tickX + tickLen, ty);
      ctx.stroke();
      if (ml === 100 || ml === 200 || ml === 250) {
        ctx.fillStyle = pal.enamelText;
        ctx.textAlign = 'left';
        ctx.fillText(String(ml), tickX + tickLen + 2, ty + 0.5);
      }
    }
    // Frosted write-on enamel patch on slanted conical shoulder
    const patchW = 20;
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
    ctx.fillText('250', patchX + patchW / 2, patchY + 7.5);
    ctx.font = '600 6.5px system-ui, sans-serif';
    ctx.fillText('ISO', patchX + patchW / 2, patchY + 15.5);
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
  } else {
    // ISO 4142 / DIN 12395 Ceramic enamel white graduations every 5 mL (10..50 mL)
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
      if (isMajor && ml % 20 === 0 || ml === 50) {
        ctx.fillStyle = pal.enamelText;
        ctx.textAlign = 'left';
        ctx.font = '600 6.8px system-ui, sans-serif';
        ctx.fillText(String(ml), tickX + 8.5, ty + 0.5);
      }
    }
  }

  // Rubber stopper on narrow-neck vessels sized proportionally to neck ID
  if (vessel.isStoppered && !vessel.isShattered) {
    const stopTop = Math.max(12, (spec.neckRadius || 18) + 1.5);
    const stopBot = Math.max(9, (spec.neckRadius || 18) - 2.5);
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

  // Floating Vessel Status Pill below/above vessel (Temp + pH + Volume)
  const tempC = kelvinToCelsius(vessel.tempK);
  const ph = hasWater ? computePH(vessel.moles, liqL, vessel.tempK) : null;
  const pillParts = [vessel.label];
  if (liqMl > 0.05) pillParts.push(`${liqMl.toFixed(1)}mL`);
  if (ph !== null) pillParts.push(`pH ${ph.toFixed(1)}`);
  pillParts.push(`${tempC.toFixed(0)}°C`);

  const pillText = pillParts.join(' · ');
  ctx.save();
  ctx.font = '600 11.5px system-ui, sans-serif';
  const textW = ctx.measureText(pillText).width + 14;
  const py = top - 24;
  ctx.fillStyle = pal.badgeBg;
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.badgeBorder;
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
    });
  }
}
