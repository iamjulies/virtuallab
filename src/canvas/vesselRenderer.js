import { APPARATUS } from '../data/apparatus.js';
import { kelvinToCelsius } from '../data/constants.js';
import {
  computeLiquidVolumeL,
  computePH,
  computeSolidVolumeMl,
  computeSolutionVisuals,
} from '../engine/equilibrium.js';
import { computeSyringeGasVolumeMl } from '../engine/gasNetwork.js';
import { renderVesselSolids } from './chemicalVisuals.js';

function getThemePalette(isDark) {
  return isDark
    ? {
        glassStroke: 'rgba(148, 163, 184, 0.78)',
        glassHighlight: 'rgba(255, 255, 255, 0.22)',
        glassFill: 'rgba(148, 163, 184, 0.08)',
        tickStroke: 'rgba(226, 232, 240, 0.5)',
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
        glassStroke: 'rgba(71, 85, 105, 0.72)',
        glassHighlight: 'rgba(255, 255, 255, 0.58)',
        glassFill: 'rgba(226, 232, 240, 0.22)',
        tickStroke: 'rgba(51, 65, 85, 0.45)',
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
 * Trace the interior clipping path for each vessel shape.
 */
function traceVesselPath(ctx, shape, x, y, w, h) {
  const halfW = w / 2;
  const top = y - h / 2;
  const bottom = y + h / 2;

  ctx.beginPath();
  if (shape === 'beaker') {
    const r = 10;
    ctx.moveTo(x - halfW - 5, top);
    ctx.lineTo(x - halfW, top + 8);
    ctx.lineTo(x - halfW, bottom - r);
    ctx.quadraticCurveTo(x - halfW, bottom, x - halfW + r, bottom);
    ctx.lineTo(x + halfW - r, bottom);
    ctx.quadraticCurveTo(x + halfW, bottom, x + halfW, bottom - r);
    ctx.lineTo(x + halfW, top + 8);
    ctx.lineTo(x + halfW + 4, top);
  } else if (shape === 'erlenmeyer') {
    const neckHalf = 16;
    const neckEnd = top + h * 0.28;
    const r = 14;
    ctx.moveTo(x - neckHalf - 4, top);
    ctx.lineTo(x - neckHalf, top + 6);
    ctx.lineTo(x - neckHalf, neckEnd);
    ctx.lineTo(x - halfW, bottom - r);
    ctx.quadraticCurveTo(x - halfW, bottom, x - halfW + r, bottom);
    ctx.lineTo(x + halfW - r, bottom);
    ctx.quadraticCurveTo(x + halfW, bottom, x + halfW, bottom - r);
    ctx.lineTo(x + neckHalf, neckEnd);
    ctx.lineTo(x + neckHalf, top + 6);
    ctx.lineTo(x + neckHalf + 4, top);
  } else if (shape === 'test_tube') {
    const r = halfW;
    ctx.moveTo(x - halfW - 4, top);
    ctx.lineTo(x - halfW, top + 5);
    ctx.lineTo(x - halfW, bottom - r);
    ctx.arc(x, bottom - r, r, Math.PI, 0, true);
    ctx.lineTo(x + halfW, top + 5);
    ctx.lineTo(x + halfW + 4, top);
  } else if (shape === 'cylinder') {
    const r = 4;
    ctx.moveTo(x - halfW - 3, top);
    ctx.lineTo(x - halfW, top + 5);
    ctx.lineTo(x - halfW, bottom - 8);
    ctx.lineTo(x + halfW, bottom - 8);
    ctx.lineTo(x + halfW, top + 5);
    ctx.lineTo(x + halfW + 3, top);
    ctx.moveTo(x - halfW - 14, bottom);
    ctx.lineTo(x + halfW + 14, bottom);
    ctx.lineTo(x + halfW, bottom - 8);
    ctx.lineTo(x - halfW, bottom - 8);
    ctx.closePath();
    return;
  }
}

/**
 * Trace closed interior liquid-clipping area.
 */
function traceVesselInteriorClip(ctx, shape, x, y, w, h) {
  const pad = 2.5;
  const halfW = w / 2 - pad;
  const top = y - h / 2 + 4;
  const bottom = y + h / 2 - (shape === 'cylinder' ? 9 : 2.5);

  ctx.beginPath();
  if (shape === 'beaker') {
    const r = 8;
    ctx.moveTo(x - halfW, top);
    ctx.lineTo(x - halfW, bottom - r);
    ctx.quadraticCurveTo(x - halfW, bottom, x - halfW + r, bottom);
    ctx.lineTo(x + halfW - r, bottom);
    ctx.quadraticCurveTo(x + halfW, bottom, x + halfW, bottom - r);
    ctx.lineTo(x + halfW, top);
    ctx.closePath();
  } else if (shape === 'erlenmeyer') {
    const neckHalf = 14;
    const neckEnd = top + h * 0.26;
    const r = 12;
    ctx.moveTo(x - neckHalf, top);
    ctx.lineTo(x - neckHalf, neckEnd);
    ctx.lineTo(x - halfW, bottom - r);
    ctx.quadraticCurveTo(x - halfW, bottom, x - halfW + r, bottom);
    ctx.lineTo(x + halfW - r, bottom);
    ctx.quadraticCurveTo(x + halfW, bottom, x + halfW, bottom - r);
    ctx.lineTo(x + neckHalf, neckEnd);
    ctx.lineTo(x + neckHalf, top);
    ctx.closePath();
  } else if (shape === 'test_tube') {
    const r = halfW;
    ctx.moveTo(x - halfW, top);
    ctx.lineTo(x - halfW, bottom - r);
    ctx.arc(x, bottom - r, r, Math.PI, 0, true);
    ctx.lineTo(x + halfW, top);
    ctx.closePath();
  } else if (shape === 'cylinder') {
    ctx.rect(x - halfW, top, halfW * 2, bottom - top);
  }
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
  const { x, y, flameLevel } = item;
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

  // Ceramic gauze center
  ctx.fillStyle = flameLevel > 0 ? 'rgba(249, 115, 22, 0.35)' : 'rgba(148, 163, 184, 0.35)';
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

  // Flickering flame
  if (flameLevel > 0) {
    const scale = 0.65 + flameLevel * 0.42;
    const wobble = Math.sin(timeNow * 16 + x) * 2.2;
    const fBaseY = bottom - 46;
    const fH = 34 * scale;
    const fW = 11 * scale;

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
  }

  ctx.restore();
}

export function renderGasSyringe(ctx, item, isSelected, isDark, env) {
  const spec = APPARATUS.gas_syringe;
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const w = spec.width;
  const h = spec.height;
  const barrelW = 136;
  const barrelH = 38;
  const barrelLeft = x - w / 2 + 16;
  const barrelTop = y - barrelH / 2;

  const volMl = computeSyringeGasVolumeMl(item, env);
  const ratio = Math.max(0, Math.min(1, volMl / spec.maxVolumeMl));
  const plungerX = barrelLeft + 10 + ratio * (barrelW - 22);

  ctx.save();
  if (isSelected) {
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 10;
  }

  // Nozzle on left
  ctx.fillStyle = pal.glassStroke;
  ctx.fillRect(barrelLeft - 14, y - 4, 14, 8);

  // Glass barrel
  ctx.fillStyle = pal.glassFill;
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = isSelected ? 2.2 : 1.6;
  ctx.beginPath();
  ctx.roundRect(barrelLeft, barrelTop, barrelW, barrelH, 4);
  ctx.fill();
  ctx.stroke();

  ctx.shadowBlur = 0;

  // Gas tint inside chamber
  if (ratio > 0.005) {
    ctx.fillStyle = 'rgba(186, 230, 253, 0.16)';
    ctx.fillRect(barrelLeft + 2, barrelTop + 2, plungerX - barrelLeft - 2, barrelH - 4);
  }

  // Plunger rubber head + rod
  ctx.fillStyle = '#334155';
  ctx.fillRect(plungerX - 5, barrelTop + 3, 10, barrelH - 6);
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(plungerX + 5, y - 4, barrelLeft + barrelW + 32 - plungerX, 8);
  ctx.fillRect(barrelLeft + barrelW + 32, y - 14, 6, 28);

  // Tick marks (0..250 mL)
  ctx.strokeStyle = pal.tickStroke;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const tx = barrelLeft + 10 + (i / 10) * (barrelW - 22);
    const len = i % 2 === 0 ? 9 : 5;
    ctx.beginPath();
    ctx.moveTo(tx, barrelTop);
    ctx.lineTo(tx, barrelTop + len);
    ctx.stroke();
  }

  // Live mL label below syringe
  ctx.fillStyle = pal.badgeBg;
  ctx.strokeStyle = pal.badgeBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x - 58, barrelTop + barrelH + 8, 116, 22, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = pal.textPrimary;
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Gas: ${volMl.toFixed(1)} mL`, x, barrelTop + barrelH + 19);

  ctx.restore();
}

export function renderTubingConnections(ctx, items, isDark) {
  const pal = getThemePalette(isDark);
  for (const v of items) {
    if (v.kind !== 'vessel' || !v.connectedSyringeId) continue;
    const syr = items.find((it) => it.id === v.connectedSyringeId);
    if (!syr) continue;

    const vSpec = APPARATUS[v.typeId];
    const syrSpec = APPARATUS.gas_syringe;
    const startX = v.x;
    const startY = v.y - vSpec.height / 2 - 8;
    const endX = syr.x - syrSpec.width / 2 + 2;
    const endY = syr.y;

    const cp1X = startX;
    const cp1Y = Math.min(startY, endY) - 70;
    const cp2X = (startX + endX) * 0.5;
    const cp2Y = Math.min(startY, endY) - 45;

    ctx.save();
    ctx.strokeStyle = pal.tubeColor;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }
}

export function renderVessel(ctx, vessel, opts) {
  const { isSelected, isDropTarget, isDark, timeNow } = opts;
  const spec = APPARATUS[vessel.typeId];
  const pal = getThemePalette(isDark);
  const { x, y } = vessel;
  const w = spec.width;
  const h = spec.height;
  const top = y - h / 2;
  const bottom = y + h / 2;

  ctx.save();

  // Apply pour tilt around vessel center
  if (vessel.tiltAngle) {
    ctx.translate(x, y);
    ctx.rotate(vessel.tiltAngle);
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
  traceVesselInteriorClip(ctx, spec.shape, x, y, w, h);
  ctx.fillStyle = pal.glassFill;
  ctx.fill();
  ctx.clip();

  // Compute liquid & solid levels
  const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
  const liqMl = liqL * 1000;
  const solMl = computeSolidVolumeMl(vessel.moles);
  const totalFillFrac = Math.min(0.92, (liqMl + solMl) / spec.maxVolumeMl);

  const interiorBottom = bottom - (spec.shape === 'cylinder' ? 9 : 3);
  const interiorHeight = h - (spec.shape === 'cylinder' ? 18 : 14);
  const surfaceY = interiorBottom - totalFillFrac * interiorHeight;
  const hasWater = (vessel.moles.H2O_l || 0) > 1e-7 && liqMl > 0.15;

  // Draw liquid body using Beer-Lambert + Phenolphthalein color
  if (hasWater) {
    const ph = computePH(vessel.moles, liqL, vessel.tempK);
    const vis = computeSolutionVisuals(vessel.moles, liqL, ph, spec.opticalPathCm);

    ctx.fillStyle = vis.css;
    ctx.fillRect(x - w / 2, surfaceY, w, interiorBottom - surfaceY + 4);

    // Concave meniscus highlight along surface
    ctx.beginPath();
    ctx.moveTo(x - w / 2, surfaceY);
    ctx.quadraticCurveTo(x, surfaceY + 3.5, x + w / 2, surfaceY);
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

  // Draw glass outer silhouette
  ctx.shadowBlur = 0;
  traceVesselPath(ctx, spec.shape, x, y, w, h);
  ctx.strokeStyle = vessel.isShattered
    ? '#ef4444'
    : isDropTarget
    ? '#10b981'
    : isSelected
    ? '#3b82f6'
    : pal.glassStroke;
  ctx.lineWidth = isSelected || isDropTarget ? 2.4 : 1.8;
  ctx.stroke();

  // Glass vertical specular highlight
  ctx.strokeStyle = pal.glassHighlight;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (spec.shape === 'erlenmeyer') {
    ctx.moveTo(x - 10, top + h * 0.32);
    ctx.lineTo(x - w * 0.36, bottom - 16);
  } else {
    ctx.moveTo(x - w * 0.35, top + 14);
    ctx.lineTo(x - w * 0.35, bottom - 14);
  }
  ctx.stroke();

  // Graduation tick marks
  ctx.strokeStyle = pal.tickStroke;
  ctx.lineWidth = 1;
  const ticks = spec.shape === 'cylinder' ? 5 : 4;
  for (let i = 1; i <= ticks; i++) {
    const ty = interiorBottom - (i / (ticks + 0.5)) * interiorHeight;
    const tw = i % 2 === 0 ? 12 : 7;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.22, ty);
    ctx.lineTo(x - w * 0.22 + tw, ty);
    ctx.stroke();
  }

  // Rubber stopper on narrow-neck vessels
  if (vessel.isStoppered && !vessel.isShattered) {
    ctx.fillStyle = '#334155';
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - 18, top - 9);
    ctx.lineTo(x + 18, top - 9);
    ctx.lineTo(x + 14, top + 9);
    ctx.lineTo(x - 14, top + 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Shatter cracks overlay
  if (vessel.isShattered) {
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x - 15, y - 10);
    ctx.lineTo(x + 2, y + 6);
    ctx.lineTo(x - 10, y + 28);
    ctx.moveTo(x + 2, y + 6);
    ctx.lineTo(x + 18, y - 4);
    ctx.stroke();
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
}
