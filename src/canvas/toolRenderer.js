import { APPARATUS } from '../data/apparatus.js';
import { SPECIES } from '../data/species.js';
import { computeLiquidVolumeL, computeSolidVolumeMl, computeSolutionVisuals, computePH } from '../engine/equilibrium.js';
import { ELECTRODE_MATERIALS } from '../engine/electrochemistry.js';
import { drawLabelPill, getThemePalette } from './vesselRenderer.js';

function drawSelectionGlow(ctx, isSelected, isDropTarget) {
  if (isDropTarget) {
    ctx.shadowColor = '#10b981';
    ctx.shadowBlur = 16;
  } else if (isSelected) {
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 11;
  }
}

export function renderFilterFunnel(ctx, item, isSelected, isDropTarget, isDark, langCode = 'vi', timeNow = 0) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const spec = APPARATUS.filter_funnel;
  const topY = y - spec.height / 2;
  const coneBotY = y + 8;
  const stemBotY = y + spec.height / 2;
  const rimHalfW = 31;

  ctx.save();
  drawSelectionGlow(ctx, isSelected, isDropTarget);

  // Outer Borosilicate 60-deg cone + stem
  ctx.beginPath();
  ctx.moveTo(x - rimHalfW, topY + 6);
  ctx.lineTo(x + rimHalfW, topY + 6);
  ctx.lineTo(x + 4.5, coneBotY);
  ctx.lineTo(x + 4.5, stemBotY - 2);
  ctx.lineTo(x - 4.5, stemBotY - 5);
  ctx.lineTo(x - 4.5, coneBotY);
  ctx.closePath();
  ctx.fillStyle = pal.glassFill;
  ctx.fill();
  ctx.strokeStyle = isDropTarget ? '#10b981' : isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = isSelected || isDropTarget ? 2.2 : 1.7;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Folded cellulose filter paper inside cone
  ctx.beginPath();
  ctx.moveTo(x - rimHalfW + 3, topY + 3);
  ctx.lineTo(x, coneBotY - 3);
  ctx.lineTo(x + rimHalfW - 3, topY + 3);
  ctx.closePath();
  ctx.fillStyle = isDark ? 'rgba(241, 245, 249, 0.88)' : 'rgba(255, 255, 255, 0.96)';
  ctx.fill();
  ctx.strokeStyle = isDark ? '#cbd5e1' : '#94a3b8';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Trapped liquid inside filter cone
  const liqL = computeLiquidVolumeL(item.moles, item.tempK);
  const liqMl = liqL * 1000;
  if (liqMl > 0.1) {
    const fFrac = Math.min(1, liqMl / 55);
    const lY = coneBotY - 4 - fFrac * (coneBotY - topY - 12);
    const lHalf = 4 + fFrac * (rimHalfW - 9);
    const vis = computeSolutionVisuals(item.moles, liqL, computePH(item.moles, liqL, item.tempK), 2.5, item.phenBleachFrac || 0);
    ctx.fillStyle = vis.css;
    ctx.beginPath();
    ctx.moveTo(x - lHalf, lY);
    ctx.lineTo(x + lHalf, lY);
    ctx.lineTo(x, coneBotY - 4);
    ctx.closePath();
    ctx.fill();
  }

  // Retained solid precipitate residue mound on filter paper
  let solMol = 0;
  let solColor = '#f8fafc';
  for (const [id, n] of Object.entries(item.moles || {})) {
    const sp = SPECIES[id];
    if (sp && sp.phase === 's' && n > 1e-7) {
      solMol += n;
      if (sp.color) solColor = sp.color;
    }
  }
  if (solMol > 1e-6) {
    const sMl = computeSolidVolumeMl(item.moles);
    const sH = Math.min(16, 4 + Math.cbrt(sMl) * 3.8);
    ctx.fillStyle = solColor;
    ctx.strokeStyle = isDark ? 'rgba(148,163,184,0.65)' : 'rgba(71,85,105,0.55)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x - sH * 1.15, coneBotY - 4 - sH * 0.7);
    ctx.quadraticCurveTo(x, coneBotY - 6 - sH * 0.9, x + sH * 1.15, coneBotY - 4 - sH * 0.7);
    ctx.lineTo(x, coneBotY - 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Active filtrate stream dripping from stem tip
  if (item.isFiltering) {
    ctx.strokeStyle = item.filtrateColor || 'rgba(186, 230, 253, 0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, stemBotY - 2);
    ctx.lineTo(x, stemBotY + 14 + ((timeNow * 24) % 8));
    ctx.stroke();
  }

  const tag = solMol > 1e-6 ? `${item.label} · 🧱 ${solMol.toFixed(3)}mol` : `${item.label} · Filter`;
  drawLabelPill(ctx, x, topY - 12, tag, { pal, borderColor: isSelected ? '#3b82f6' : null, font: '600 10.5px system-ui, sans-serif', height: 18 });
  ctx.restore();
}

export function renderWashBottle(ctx, item, isSelected, isDark, langCode = 'vi') {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const spec = APPARATUS.wash_bottle;
  const topY = y - spec.height / 2;
  const botY = y + spec.height / 2;
  const w = 40;

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Curved PTFE squeeze spout extending top-left
  ctx.strokeStyle = isDark ? '#e2e8f0' : '#475569';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, topY + 28);
  ctx.quadraticCurveTo(x - 4, topY + 4, x - 24, topY + 12);
  ctx.stroke();

  // Blue polypropylene cap collar
  ctx.fillStyle = '#0284c7';
  ctx.beginPath();
  ctx.roundRect(x - 10, topY + 26, 20, 10, 2);
  ctx.fill();

  // Translucent LDPE cylindrical body
  ctx.fillStyle = isDark ? 'rgba(226, 232, 240, 0.22)' : 'rgba(241, 245, 249, 0.72)';
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = isSelected ? 2.2 : 1.6;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, topY + 36, w, botY - topY - 36, 7);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Distilled water level inside wash bottle
  const fillFrac = Math.max(0, Math.min(1, (item.waterMl || 0) / 250));
  if (fillFrac > 0.01) {
    const innerH = botY - topY - 42;
    const wH = innerH * fillFrac;
    ctx.fillStyle = isDark ? 'rgba(56, 189, 248, 0.42)' : 'rgba(14, 165, 233, 0.38)';
    ctx.fillRect(x - w / 2 + 2, botY - 3 - wH, w - 4, wH);
  }

  ctx.fillStyle = pal.textPrimary;
  ctx.font = 'bold 8.5px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('H₂O', x, y + 18);

  drawLabelPill(ctx, x, topY + 4, `💦 ${(item.waterMl || 0).toFixed(0)} mL`, {
    pal,
    borderColor: isSelected ? '#3b82f6' : null,
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
  });
  ctx.restore();
}

export function renderLiebigCondenser(ctx, item, isSelected, isDark, timeNow = 0) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const spec = APPARATUS.liebig_condenser;
  const halfW = spec.width / 2;

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Outer tilted glass water jacket
  ctx.translate(x, y);
  ctx.rotate(0.14);

  // Inner vapor bore tube
  ctx.fillStyle = isDark ? 'rgba(226, 232, 240, 0.25)' : 'rgba(148, 163, 184, 0.35)';
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.roundRect(-halfW + 4, -5, spec.width - 8, 10, 3);
  ctx.fill();
  ctx.stroke();

  // Outer cold water jacket
  ctx.fillStyle = item.waterFlowOn
    ? isDark
      ? 'rgba(56, 189, 248, 0.26)'
      : 'rgba(14, 165, 233, 0.22)'
    : pal.glassFill;
  ctx.beginPath();
  ctx.roundRect(-halfW + 24, -16, spec.width - 48, 32, 5);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Water inlet (bottom right) & outlet (top left) hose barbs
  ctx.fillStyle = '#0ea5e9';
  ctx.fillRect(-halfW + 32, -23, 7, 7);
  ctx.fillRect(halfW - 40, 16, 7, 7);

  if (item.waterFlowOn) {
    const phase = (timeNow * 24) % 18;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
    ctx.lineWidth = 1.2;
    for (let px = -30 + phase; px < 35; px += 18) {
      ctx.beginPath();
      ctx.moveTo(px + 6, -10);
      ctx.lineTo(px, -10);
      ctx.stroke();
    }
  }

  ctx.setTransform(ctx.getTransform()); // keep aligned for drop below? No, undo local rotation safely
  ctx.restore();

  if (item.activeDrop) {
    ctx.save();
    const dropY = y + 18 + ((timeNow * 45) % 24);
    ctx.fillStyle = 'rgba(186, 230, 253, 0.9)';
    ctx.beginPath();
    ctx.arc(x + 68, dropY, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawLabelPill(
    ctx,
    x,
    y - 32,
    `${item.label} · ❄️ ${item.waterFlowOn ? 'H₂O ON' : 'OFF'} · ${(item.totalCondensedMl || 0).toFixed(1)}mL`,
    { pal, borderColor: isSelected ? '#3b82f6' : null, font: '600 10.5px system-ui, sans-serif', height: 18 }
  );
}

export function renderBurette(ctx, item, isSelected, isDropTarget, isDark, timeNow = 0) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const spec = APPARATUS.burette_50;
  const topY = y - spec.height / 2;
  const botY = y + spec.height / 2;
  const colBotY = botY - 36;
  const colTopY = topY + 12;
  const halfW = 6.5;

  ctx.save();
  drawSelectionGlow(ctx, isSelected, isDropTarget);

  // Top flared funnel neck & graduated glass barrel + tapered stopcock tip
  ctx.fillStyle = pal.glassFill;
  ctx.strokeStyle = isDropTarget ? '#10b981' : isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = isSelected || isDropTarget ? 2.1 : 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 10, topY + 2);
  ctx.lineTo(x + 10, topY + 2);
  ctx.lineTo(x + halfW, colTopY);
  ctx.lineTo(x + halfW, colBotY);
  ctx.lineTo(x + 2, botY - 4);
  ctx.lineTo(x - 2, botY - 4);
  ctx.lineTo(x - halfW, colBotY);
  ctx.lineTo(x - halfW, colTopY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Liquid column inside burette
  const liqL = computeLiquidVolumeL(item.moles, item.tempK);
  const liqMl = Math.min(50, liqL * 1000);
  if (liqMl > 0.02) {
    const colH = colBotY - colTopY;
    const fillH = colH * (liqMl / 50);
    const vis = computeSolutionVisuals(item.moles, liqL, computePH(item.moles, liqL, item.tempK), 1.4, item.phenBleachFrac || 0);
    ctx.fillStyle = vis.css;
    ctx.fillRect(x - halfW + 1.5, colBotY - fillH, halfW * 2 - 3, fillH);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - halfW + 1.5, colBotY - fillH);
    ctx.lineTo(x + halfW - 1.5, colBotY - fillH);
    ctx.stroke();
  }

  // Enamel 0..50 mL graduation marks
  ctx.strokeStyle = pal.tickStroke;
  ctx.lineWidth = 0.8;
  for (let i = 0; i <= 10; i++) {
    const ty = colTopY + (i / 10) * (colBotY - colTopY - 8);
    ctx.beginPath();
    ctx.moveTo(x - halfW + 1, ty);
    ctx.lineTo(x - halfW + (i % 2 === 0 ? 6 : 3.5), ty);
    ctx.stroke();
  }

  // PTFE stopcock key (horizontal when valve closed = 0, tilted/vertical when dripping)
  const stopY = botY - 24;
  const open = (item.valveRateMlS || 0) > 0;
  ctx.fillStyle = '#0284c7';
  ctx.fillRect(x - 8, stopY - 4, 16, 8);
  ctx.fillStyle = open ? '#34d399' : '#e2e8f0';
  if (open) {
    ctx.fillRect(x - 2, stopY - 10, 4, 20);
  } else {
    ctx.fillRect(x - 13, stopY - 2, 26, 4);
  }

  // Streaming droplets below tip
  if (item.streamingNow) {
    ctx.fillStyle = item.streamColor || 'rgba(186, 230, 253, 0.9)';
    const dy = (timeNow * 90) % 24;
    ctx.beginPath();
    ctx.arc(x, botY + dy * 0.7, 2.3, 0, Math.PI * 2);
    ctx.fill();
  }

  drawLabelPill(ctx, x, topY - 12, `${item.label} · ${liqMl.toFixed(1)} mL (Δ${(item.dispensedMl || 0).toFixed(2)})`, {
    pal,
    borderColor: isSelected ? '#3b82f6' : null,
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
  });
  ctx.restore();
}

export function renderSplint(ctx, item, isSelected, isDark, timeNow = 0) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Wooden birch body
  ctx.fillStyle = '#d97706';
  ctx.strokeStyle = isSelected ? '#3b82f6' : '#92400e';
  ctx.lineWidth = isSelected ? 2 : 1;
  ctx.beginPath();
  ctx.roundRect(x - 46, y - 3, 96, 6, 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  const tipX = x - 48;
  if (item.mode === 'burning' || item.mode === 'glowing') {
    // Charred tip + glowing ember
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(tipX - 2, y - 3.2, 8, 6.4);
    const pulse = 0.75 + Math.sin(timeNow * 14) * 0.25;
    const g = ctx.createRadialGradient(tipX, y, 1, tipX, y, item.mode === 'burning' ? 18 : 11);
    g.addColorStop(0, item.mode === 'burning' ? '#fef08a' : `rgba(249, 115, 22, ${0.95 * pulse})`);
    g.addColorStop(0.55, `rgba(239, 68, 68, ${0.65 * pulse})`);
    g.addColorStop(1, 'rgba(239, 68, 68, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(tipX, y, item.mode === 'burning' ? 18 : 11, 0, Math.PI * 2);
    ctx.fill();

    if (item.mode === 'burning') {
      const wob = Math.sin(timeNow * 20) * 2.2;
      ctx.fillStyle = 'rgba(251, 146, 60, 0.92)';
      ctx.beginPath();
      ctx.moveTo(tipX - 5, y);
      ctx.quadraticCurveTo(tipX + wob, y - 22, tipX + 5, y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(254, 240, 138, 0.96)';
      ctx.beginPath();
      ctx.moveTo(tipX - 2.5, y);
      ctx.quadraticCurveTo(tipX + wob * 0.5, y - 13, tipX + 2.5, y);
      ctx.closePath();
      ctx.fill();
    }
  }

  const badgeTxt =
    item.lastTestEvent === 'h2_pop'
      ? '💥 H₂ "Póc!"'
      : item.lastTestEvent === 'o2_relight'
      ? '🔥 O₂ Bùng!'
      : item.mode === 'burning'
      ? '🔥 Burning Splint'
      : item.mode === 'glowing'
      ? '🔴 Glowing Ember'
      : 'Unlit Splint';
  drawLabelPill(ctx, x, y - 19, badgeTxt, { pal, borderColor: isSelected ? '#3b82f6' : null, font: '600 10.5px system-ui, sans-serif', height: 18 });
  ctx.restore();
}

export function renderFlameLoop(ctx, item, isSelected, isDark, timeNow = 0) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Borosilicate handle (right half)
  ctx.fillStyle = isDark ? 'rgba(186, 230, 253, 0.35)' : 'rgba(148, 163, 184, 0.45)';
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.roundRect(x - 6, y - 3.5, 58, 7, 3.5);
  ctx.fill();
  ctx.stroke();

  // Twisted Nichrome wire + sample loop at left tip
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x - 6, y);
  ctx.lineTo(x - 42, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x - 47, y, 5, 0, Math.PI * 2);
  ctx.stroke();

  if (item.sampledColor) {
    ctx.fillStyle = item.sampledColor;
    ctx.globalAlpha = 0.72 + Math.sin(timeNow * 8) * 0.18;
    ctx.beginPath();
    ctx.arc(x - 47, y, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  drawLabelPill(ctx, x, y - 18, item.sampledIon ? `🔬 ${item.sampleLabel}` : `${item.label} · NiCr Wire`, {
    pal,
    borderColor: item.sampledColor || (isSelected ? '#3b82f6' : null),
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
  });
  ctx.restore();
}

export function renderIndicatorStrip(ctx, item, isSelected, isDark) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const isLit = item.stripKind === 'litmus';
  const dryBase = isLit ? '#8b5cf6' : '#facc15';
  const wetColor = item.tipColor || dryBase;

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Dry right handle half
  ctx.fillStyle = dryBase;
  ctx.strokeStyle = isSelected ? '#3b82f6' : isDark ? '#475569' : '#94a3b8';
  ctx.lineWidth = isSelected ? 2 : 1.1;
  ctx.beginPath();
  ctx.roundRect(x - 28, y - 6, 56, 12, 2);
  ctx.fill();
  ctx.stroke();

  // Immersed / sampled left half
  ctx.fillStyle = wetColor;
  ctx.fillRect(x - 27.5, y - 5.5, 25, 11);
  ctx.shadowBlur = 0;

  const txt =
    item.isBleached
      ? 'Cl₂ Bleached'
      : item.sampledPH !== null && item.sampledPH !== undefined
      ? `pH ≈ ${item.sampledPH.toFixed(1)}`
      : isLit
      ? 'Litmus Paper'
      : 'Universal pH';
  drawLabelPill(ctx, x, y - 18, txt, { pal, borderColor: item.sampledPH != null ? wetColor : null, font: '600 10.5px system-ui, sans-serif', height: 18 });
  ctx.restore();
}

export function renderStirBar(ctx, item, isSelected, isDark) {
  if (item.inVesselId) return; // Rendered directly rotating inside host vessel
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);
  ctx.fillStyle = '#f8fafc';
  ctx.strokeStyle = isSelected ? '#3b82f6' : '#64748b';
  ctx.lineWidth = isSelected ? 2 : 1.2;
  ctx.beginPath();
  ctx.roundRect(x - 13, y - 4.5, 26, 9, 4.5);
  ctx.fill();
  ctx.stroke();
  drawLabelPill(ctx, x, y - 16, `${item.label} · PTFE Magnet`, { pal, font: '600 10px system-ui, sans-serif', height: 16 });
  ctx.restore();
}

export function renderSaltBridge(ctx, item, isSelected, isDark) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 44, y + 32);
  ctx.lineTo(x - 44, y - 12);
  ctx.arc(x, y - 12, 44, Math.PI, 0, false);
  ctx.lineTo(x + 44, y + 32);
  ctx.stroke();

  // Agar-Na2SO4 gel core inside U-tube
  ctx.strokeStyle = isDark ? 'rgba(224, 242, 254, 0.58)' : 'rgba(186, 230, 253, 0.84)';
  ctx.lineWidth = 6.5;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const active = Boolean(item.vesselAId && item.vesselBId);
  drawLabelPill(ctx, x, y - 68, `${item.label} · ${active ? '⚡ Bridged' : 'Salt Bridge'}`, {
    pal,
    borderColor: active ? '#10b981' : isSelected ? '#3b82f6' : null,
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
  });
  ctx.restore();
}

export function renderElectrodeRod(ctx, item, isSelected, isDark, timeNow = 0) {
  const pal = getThemePalette(isDark);
  const mat = ELECTRODE_MATERIALS[item.material] || ELECTRODE_MATERIALS.C;
  const { x, y } = item;
  const spec = APPARATUS.electrode_rod;
  const topY = y - spec.height / 2;
  const botY = y + spec.height / 2;

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Metal/graphite plate dipped vertically
  ctx.fillStyle = mat.color;
  ctx.strokeStyle = isSelected ? '#3b82f6' : mat.stroke;
  ctx.lineWidth = isSelected ? 2.1 : 1.4;
  ctx.beginPath();
  ctx.roundRect(x - 4.5, topY + 12, 9, spec.height - 16, 2);
  ctx.fill();
  ctx.stroke();

  // Top binding terminal cap
  ctx.fillStyle = item.polarityLabel?.startsWith('+') ? '#ef4444' : item.polarityLabel?.startsWith('-') ? '#1e293b' : '#475569';
  ctx.beginPath();
  ctx.roundRect(x - 6, topY + 2, 12, 11, 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Gas micro-bubbles along immersed lower surface during electrolysis
  if (item.gasBubbleType && (item.gasBubbleRate || 0) > 1e-7) {
    ctx.fillStyle = item.gasBubbleType === 'Cl2_g' ? 'rgba(163, 230, 53, 0.72)' : 'rgba(241, 245, 249, 0.85)';
    for (let i = 0; i < 6; i++) {
      const rise = (timeNow * 42 + i * 9) % 46;
      const bx = x + ((i % 2 === 0 ? -1 : 1) * 5.5);
      const by = botY - 8 - rise;
      ctx.beginPath();
      ctx.arc(bx, by, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawLabelPill(ctx, x, topY - 12, item.polarityLabel ? `${mat.id} ${item.polarityLabel}` : `${item.label} (${mat.id})`, {
    pal,
    borderColor: item.polarityLabel?.startsWith('+') ? '#ef4444' : isSelected ? '#3b82f6' : null,
    font: '600 10px system-ui, sans-serif',
    height: 17,
  });
  ctx.restore();
}

export function renderDcPowerAndWires(ctx, items, selectedId, isDark) {
  const pal = getThemePalette(isDark);
  const supplies = items.filter((i) => i.kind === 'dc_power');
  const electrodes = items.filter((i) => i.kind === 'electrode');

  for (const sup of supplies) {
    const { x, y } = sup;
    const spec = APPARATUS.dc_power;
    const topY = y - spec.height / 2;
    const leftX = x - spec.width / 2;
    const isSelected = sup.id === selectedId;

    // 1. Render flexible Red (+) & Black (-) alligator wire leads first
    const posEl = electrodes.find((e) => e.id === sup.posElectrodeId);
    const negEl = electrodes.find((e) => e.id === sup.negElectrodeId);
    const postPos = { x: x - 26, y: y + 22 };
    const postNeg = { x: x + 26, y: y + 22 };

    const drawWire = (from, el, color) => {
      if (!el) return;
      const eSpec = APPARATUS.electrode_rod;
      const to = { x: el.x, y: el.y - eSpec.height / 2 + 5 };
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo(from.x, Math.max(from.y, to.y) + 32, to.x, to.y - 44, to.x, to.y);
      ctx.stroke();
      ctx.restore();
    };
    drawWire(postPos, posEl, '#ef4444');
    drawWire(postNeg, negEl, isDark ? '#94a3b8' : '#1e293b');

    // 2. Render DC Supply Chassis & Dual LCD Readout
    ctx.save();
    drawSelectionGlow(ctx, isSelected, false);
    ctx.fillStyle = pal.scaleBody;
    ctx.strokeStyle = isSelected ? '#3b82f6' : pal.scaleBorder;
    ctx.lineWidth = isSelected ? 2.2 : 1.7;
    ctx.beginPath();
    ctx.roundRect(leftX, topY, spec.width, spec.height, 8);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Digital LCD screen
    ctx.fillStyle = pal.lcdBg;
    ctx.beginPath();
    ctx.roundRect(leftX + 10, topY + 10, spec.width - 20, 34, 4);
    ctx.fill();

    const vStr = `${(sup.measuredV || 0).toFixed(2)}V`;
    const aStr = `${(sup.measuredCurrentA || 0).toFixed(2)}A`;
    ctx.fillStyle = pal.lcdText;
    ctx.font = 'bold 12.5px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${vStr} · ${aStr}`, x, topY + 28);
    ctx.font = '600 8.5px system-ui, sans-serif';
    const modeTag =
      sup.circuitMode === 'galvanic'
        ? 'BATTERY EMF'
        : sup.circuitMode === 'electrolysis'
        ? sup.powerOn
          ? 'ELECTROLYSIS ON'
          : 'STANDBY'
        : 'NO CIRCUIT';
    ctx.fillText(modeTag, x, topY + 40);

    // Binding posts (+ Red / - Black)
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(postPos.x, postPos.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(postNeg.x, postNeg.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.fillText('+', postPos.x, postPos.y + 3);
    ctx.fillText('−', postNeg.x, postNeg.y + 3);

    drawLabelPill(ctx, x, topY - 12, `${sup.label} · DC Supply`, {
      pal,
      borderColor: sup.powerOn ? '#10b981' : isSelected ? '#3b82f6' : null,
      font: '600 10.5px system-ui, sans-serif',
      height: 18,
    });
    ctx.restore();
  }
}
