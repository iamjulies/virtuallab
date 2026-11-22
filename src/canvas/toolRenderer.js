import { APPARATUS, getCondenserPorts, getProbeTipPos, getSyringeGeometry, getTubeDestTipPos } from '../data/apparatus.js';
import { buildRigidTubePoints, samplePolylineAt } from '../engine/gasNetwork.js';
import { SPECIES } from '../data/species.js';
import { computeLiquidVolumeL, computePhaseStratification, computeSolidVolumeMl, computeSolutionVisuals, computePH } from '../engine/equilibrium.js';
import { ELECTRODE_MATERIALS } from '../engine/electrochemistry.js';
import { drawLabelPill, formatCanvasText, getCurrentCanvasTheme, getThemePalette, setCurrentLabelItemId } from './vesselRenderer.js';

function drawSelectionGlow(ctx, isSelected, isDropTarget) {
  if (isDropTarget) {
    ctx.shadowColor = '#10b981';
    ctx.shadowBlur = 16;
  } else if (isSelected) {
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 11;
  }
}

function renderBrokenToolShards(ctx, item, pal, isSelected, spanW = 48, height = 60) {
  const { x, y } = item;
  const bottom = y + height / 2;
  ctx.save();
  if (item.spilledPuddleColor) {
    ctx.fillStyle = item.spilledPuddleColor;
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.ellipse(x, bottom - 2, Math.max(24, spanW * 0.72), 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = pal.glassFill;
  ctx.strokeStyle = isSelected ? '#3b82f6' : '#ef4444';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 7; i++) {
    const sx = x + ((i - 3) * (spanW * 0.2));
    const sy = bottom - 3 - (i % 3) * 3;
    ctx.beginPath();
    ctx.moveTo(sx - 6, sy + 2);
    ctx.lineTo(sx + 2, sy - 6 - (i % 2) * 3);
    ctx.lineTo(sx + 7, sy + 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  drawLabelPill(ctx, x, bottom - 28, `${item.label} · 💥`, {
    pal,
    borderColor: '#ef4444',
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
  });
  ctx.restore();
}

export function renderFilterFunnel(ctx, item, isSelected, isDropTarget, isDark, langCode = 'vi', timeNow = 0) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const spec = APPARATUS.filter_funnel;
  if (item.isBroken) {
    renderBrokenToolShards(ctx, item, pal, isSelected, spec.width, spec.height);
    return;
  }
  const topY = y - spec.height / 2;
  const coneBotY = y + 8;
  const stemBotY = y + spec.height / 2;
  const rimHalfW = 31;

  ctx.save();
  if (Math.abs(item.tiltAngle || 0) > 0.01) {
    ctx.translate(x, y);
    ctx.rotate(item.tiltAngle || 0);
    ctx.translate(-x, -y);
  }
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

  // Retained solid precipitate residue mound on filter paper (plus Phenomenon #7 UV AgCl->Ag photo split)
  const nAgClSol = item.moles?.AgCl_s || 0;
  const nAgSol = item.moles?.Ag_s || 0;
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
    if (nAgSol > 1e-6 && nAgClSol > 1e-6) {
      // Exposed left half darkened silver Ag(s) + masked right half white AgCl(s)
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.moveTo(x - sH * 1.15, coneBotY - 4 - sH * 0.7);
      ctx.quadraticCurveTo(x - sH * 0.55, coneBotY - 6 - sH * 0.9, x, coneBotY - 5 - sH * 0.85);
      ctx.lineTo(x, coneBotY - 3);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.moveTo(x, coneBotY - 5 - sH * 0.85);
      ctx.quadraticCurveTo(x + sH * 0.55, coneBotY - 6 - sH * 0.9, x + sH * 1.15, coneBotY - 4 - sH * 0.7);
      ctx.lineTo(x, coneBotY - 3);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = nAgSol > 1e-6 && nAgClSol <= 1e-6 ? '#334155' : solColor;
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
  }

  // Opaque photographic half-mask shield over right side of filter paper
  if (item.uvMaskHalf) {
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, topY + 2);
    ctx.lineTo(x + rimHalfW - 2, topY + 2);
    ctx.lineTo(x, coneBotY - 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
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

export function renderSeparatoryFunnel(ctx, item, isSelected, isDropTarget, isDark, langCode = 'vi', timeNow = 0) {
  const pal = getThemePalette(isDark);
  const spec = APPARATUS.separatory_funnel || { width: 64, height: 276, maxVolumeMl: 100 };
  if (item.isBroken) {
    renderBrokenToolShards(ctx, item, pal, isSelected, spec.width, spec.height);
    return;
  }

  const isShaking = (item.emulsionTimer || 0) > 0.25;
  const shakeDx = isShaking ? Math.sin(timeNow * 34) * 3.2 : 0;
  const shakeTilt = isShaking ? Math.sin(timeNow * 26) * 0.08 : 0;
  const x = item.x + shakeDx;
  const y = item.y;
  const topY = y - spec.height / 2;
  const botY = y + spec.height / 2;

  const neckTopY = topY + 14;
  const neckBotY = topY + 32;
  const bulbMaxY = topY + 74;
  const taperEndY = topY + 114;
  const valveY = topY + 128;
  const stemEndY = botY - 2;
  const neckHalfW = 7.5;
  const bulbHalfW = 28.5;
  const stemHalfW = 3.6;

  ctx.save();
  const effTilt = (item.tiltAngle || 0) + shakeTilt;
  if (Math.abs(effTilt) > 0.005) {
    ctx.translate(x, y);
    ctx.rotate(effTilt);
    ctx.translate(-x, -y);
  }
  drawSelectionGlow(ctx, isSelected, isDropTarget);

  const tracePearBody = () => {
    ctx.beginPath();
    ctx.moveTo(x - neckHalfW - 2, neckTopY);
    ctx.lineTo(x + neckHalfW + 2, neckTopY);
    ctx.lineTo(x + neckHalfW, neckBotY);
    ctx.bezierCurveTo(x + bulbHalfW * 0.92, neckBotY + 16, x + bulbHalfW, bulbMaxY - 12, x + bulbHalfW * 0.92, bulbMaxY + 8);
    ctx.bezierCurveTo(x + bulbHalfW * 0.72, taperEndY - 12, x + 5.2, taperEndY - 4, x + stemHalfW, taperEndY + 4);
    ctx.lineTo(x + stemHalfW, stemEndY);
    ctx.lineTo(x - stemHalfW + 1, stemEndY - 3);
    ctx.lineTo(x - stemHalfW, taperEndY + 4);
    ctx.bezierCurveTo(x - 5.2, taperEndY - 4, x - bulbHalfW * 0.72, taperEndY - 12, x - bulbHalfW * 0.92, bulbMaxY + 8);
    ctx.bezierCurveTo(x - bulbHalfW, bulbMaxY - 12, x - bulbHalfW * 0.92, neckBotY + 16, x - neckHalfW, neckBotY);
    ctx.closePath();
  };

  // Outer Borosilicate 3.3 pear-shaped body
  tracePearBody();
  ctx.fillStyle = pal.glassFill;
  ctx.fill();
  ctx.strokeStyle = isDropTarget ? '#10b981' : isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = isSelected || isDropTarget ? 2.2 : 1.65;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Stratified liquid layers or emulsion inside pear bulb
  const solMl = computeSolidVolumeMl(item.moles);
  const strat = item.liquidStratification || computePhaseStratification(item.moles, item.tempK, spec, solMl);
  const totalLiqMl = strat?.totalLiqMl || 0;
  if (totalLiqMl > 0.05) {
    const liqTopSpan = taperEndY - (neckBotY + 12);
    const fillFrac = Math.min(0.95, Math.max(0.06, totalLiqMl / (spec.maxVolumeMl || 100)));
    const surfTopY = taperEndY - fillFrac * liqTopSpan;

    ctx.save();
    tracePearBody();
    ctx.clip();

    if (isShaking || !strat.layers || strat.layers.length <= 1) {
      const liqL = totalLiqMl / 1000;
      const vis = computeSolutionVisuals(
        item.moles,
        liqL,
        computePH(item.moles, liqL, item.tempK),
        3.5,
        item.phenBleachFrac || 0,
        item.phenIrrevFrac || 0
      );
      ctx.fillStyle = vis.css;
      ctx.fillRect(x - bulbHalfW - 4, surfTopY, (bulbHalfW + 4) * 2, taperEndY - surfTopY + 8);
      if (isShaking) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.36)';
        for (let b = 0; b < 10; b++) {
          const bx = x + Math.sin(timeNow * 14 + b * 1.9) * 15;
          const by = surfTopY + 8 + ((b * 13 + timeNow * 40) % Math.max(12, taperEndY - surfTopY - 6));
          ctx.beginPath();
          ctx.arc(bx, by, 1.8 + (b % 3) * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else {
      // Bottom-up stratified phases: [0] bottom (organic_heavy / aqueous) -> top (organic_light)
      let curBottomY = taperEndY + 2;
      const totalSpanH = Math.max(6, taperEndY - surfTopY);
      const layerColors = [];
      for (let li = 0; li < strat.layers.length; li++) {
        const layer = strat.layers[li];
        const lFrac = Math.max(0.04, layer.volMl / Math.max(0.1, totalLiqMl));
        const lH = lFrac * totalSpanH;
        const lTopY = curBottomY - lH;
        const layerMoles = {};
        for (const [spId, n] of Object.entries(item.moles || {})) {
          const sp = SPECIES[spId];
          if (!sp || n <= 0) continue;
          const grp = sp.phase === 'aq' ? 'aqueous' : sp.liquidGroup || 'aqueous';
          if (grp === layer.phaseKey) layerMoles[spId] = n;
        }
        const lL = Math.max(1e-5, layer.volMl / 1000);
        const lVis = computeSolutionVisuals(
          layerMoles,
          lL,
          computePH(layerMoles, lL, item.tempK),
          3.2,
          item.phenBleachFrac || 0,
          item.phenIrrevFrac || 0
        );
        ctx.fillStyle = lVis.css;
        ctx.fillRect(x - bulbHalfW - 4, lTopY, (bulbHalfW + 4) * 2, curBottomY - lTopY + 1);
        layerColors.push({ y: lTopY, phaseKey: layer.phaseKey });
        curBottomY = lTopY;
      }
      // Crisp refractive interface lines between immiscible phases
      ctx.strokeStyle = isDark ? 'rgba(248, 250, 252, 0.72)' : 'rgba(15, 23, 42, 0.45)';
      ctx.lineWidth = 1.25;
      for (let i = 0; i < layerColors.length - 1; i++) {
        const iy = layerColors[i].y;
        ctx.beginPath();
        ctx.moveTo(x - bulbHalfW, iy);
        ctx.quadraticCurveTo(x, iy + 1.8, x + bulbHalfW, iy);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ISO 4800 graduation marks & "100 mL" marking
  ctx.strokeStyle = isDark ? 'rgba(226, 232, 240, 0.45)' : 'rgba(71, 85, 105, 0.45)';
  ctx.lineWidth = 0.9;
  for (let g = 0; g < 4; g++) {
    const gy = neckBotY + 18 + g * 15;
    ctx.beginPath();
    ctx.moveTo(x - 6, gy);
    ctx.lineTo(x + 2, gy);
    ctx.stroke();
  }
  ctx.fillStyle = isDark ? 'rgba(226, 232, 240, 0.65)' : 'rgba(51, 65, 85, 0.68)';
  ctx.font = 'bold 7.5px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('100 mL', x, bulbMaxY + 2);

  // NS 19/26 Ground-glass stopper on top (when stoppered)
  if (item.isStoppered !== false) {
    ctx.fillStyle = isDark ? 'rgba(203, 213, 225, 0.55)' : 'rgba(148, 163, 184, 0.48)';
    ctx.strokeStyle = isDark ? '#e2e8f0' : '#475569';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - 6.5, neckTopY + 5);
    ctx.lineTo(x + 6.5, neckTopY + 5);
    ctx.lineTo(x + 8.5, neckTopY - 8);
    ctx.lineTo(x - 8.5, neckTopY - 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Flat hexagonal/coin grip head
    ctx.beginPath();
    ctx.roundRect(x - 10, neckTopY - 13, 20, 6, 2.5);
    ctx.fill();
    ctx.stroke();
  }

  // PTFE Stopcock assembly (collar + directional handle: horizontal=CLOSED, vertical=OPEN)
  ctx.fillStyle = '#e2e8f0';
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.roundRect(x - 8, valveY - 4, 16, 8, 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = item.valveOpen ? '#0ea5e9' : '#ef4444';
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  if (item.valveOpen) {
    ctx.roundRect(x + 5, valveY - 11, 5, 22, 2);
  } else {
    ctx.roundRect(x - 14, valveY - 2.5, 28, 5, 2);
  }
  ctx.fill();
  ctx.stroke();

  // Active draining stream / drops from stem tip
  if (item.activeDrop) {
    ctx.strokeStyle = item.drainColor || 'rgba(186, 230, 253, 0.88)';
    ctx.lineWidth = Math.max(1.4, (item.valveFlowFrac ?? 0.35) * 3.2);
    ctx.beginPath();
    ctx.moveTo(x, stemEndY);
    ctx.lineTo(x, stemEndY + 15 + ((timeNow * 28) % 9));
    ctx.stroke();
  }

  const layerBadge =
    strat?.layers?.length >= 2
      ? ` · ${strat.layers.length} ${langCode === 'en' ? 'layers' : 'lớp'}`
      : '';
  const valveTag = item.valveOpen ? '🔓' : '🔒';
  const tag = `${item.label} · ${valveTag} ${totalLiqMl.toFixed(1)} mL${layerBadge}`;
  drawLabelPill(ctx, x, topY - 10, tag, {
    pal,
    borderColor: isSelected ? '#3b82f6' : item.valveOpen ? '#0ea5e9' : null,
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
  });
  ctx.restore();
}

export function renderWashBottle(ctx, item, isSelected, isDark, langCode = 'vi', timeNow = 0) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const spec = APPARATUS.wash_bottle;
  const topY = y - spec.height / 2;
  const botY = y + spec.height / 2;
  const w = 40;
  const dir = item.flippedX ? 1 : -1; // -1: spout top-left (default), +1: flipped top-right

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Curved PTFE squeeze spout extending left or right
  ctx.strokeStyle = isDark ? '#e2e8f0' : '#475569';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, topY + 28);
  ctx.quadraticCurveTo(x + dir * 4, topY + 4, x + dir * 24, topY + 12);
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

  // Active parabolic distilled water stream shooting from curved PTFE spout!
  if (((item.squirtTimer || 0) > 0 || item.isSpraying) && item.squirtArc?.points?.length >= 2) {
    const pts = item.squirtArc.points;
    const fadeAlpha = item.isSpraying ? 1.0 : Math.min(1, (item.squirtTimer || 0) / 0.2);
    ctx.save();
    ctx.globalAlpha = fadeAlpha;
    ctx.strokeStyle = isDark ? 'rgba(125, 211, 252, 0.92)' : 'rgba(14, 165, 233, 0.85)';
    ctx.lineWidth = 2.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // Animated jet glint droplets & landing splash ring
    ctx.fillStyle = '#e0f2fe';
    for (let k = 0; k < 4; k++) {
      const idx = Math.min(pts.length - 1, Math.floor((((timeNow * 2.6 + k * 0.25) % 1)) * pts.length));
      const gp = pts[idx];
      ctx.beginPath();
      ctx.arc(gp.x, gp.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (item.squirtArc.hitX != null) {
      const rSplash = 3 + ((timeNow * 14) % 4);
      ctx.strokeStyle = isDark ? 'rgba(186, 230, 253, 0.65)' : 'rgba(2, 132, 199, 0.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(item.squirtArc.hitX, item.squirtArc.hitY, rSplash * 1.4, rSplash * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLabelPill(ctx, x, topY + 4, `💦 ${(item.waterMl || 0).toFixed(0)} mL`, {
    pal,
    borderColor: isSelected ? '#3b82f6' : null,
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
  });
  ctx.restore();
}

export function renderLiebigCondenser(ctx, item, isSelected, isDark, timeNow = 0, langCode = 'vi') {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const spec = APPARATUS.liebig_condenser;
  if (item.isBroken) {
    renderBrokenToolShards(ctx, item, pal, isSelected, spec.width * 0.7, spec.height);
    return;
  }
  const halfW = spec.width / 2;
  const ports = getCondenserPorts(item);

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Outer tilted glass water jacket (direction matches ports.tiltAngle: +0.14 or -0.14 when flipped)
  ctx.translate(x, y);
  ctx.rotate(ports.tiltAngle);

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

  // Water hose barbs mirrored around center when flipped
  ctx.fillStyle = '#0ea5e9';
  ctx.fillRect(ports.dir > 0 ? -halfW + 32 : halfW - 39, -23, 7, 7);
  ctx.fillRect(ports.dir > 0 ? halfW - 40 : -halfW + 33, 16, 7, 7);

  if (item.waterFlowOn) {
    const phase = (timeNow * 24) % 18;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
    ctx.lineWidth = 1.2;
    for (let px = -30 + phase; px < 35; px += 18) {
      ctx.beginPath();
      ctx.moveTo(px + ports.dir * 6, -10);
      ctx.lineTo(px, -10);
      ctx.stroke();
    }
  }

  // Ground-glass adapter cone & falling reflux condensate droplets inside bore when Reflux mode is ON
  if (item.refluxMode) {
    ctx.fillStyle = isDark ? 'rgba(203, 213, 225, 0.35)' : 'rgba(148, 163, 184, 0.38)';
    ctx.strokeStyle = pal.glassStroke;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-halfW + 4, -7);
    ctx.lineTo(-halfW - 6, -5);
    ctx.lineTo(-halfW - 6, 5);
    ctx.lineTo(-halfW + 4, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (item.activeDrop) {
      ctx.fillStyle = item.lastCondColor || 'rgba(186, 230, 253, 0.9)';
      for (let d = 0; d < 4; d++) {
        const dx = halfW - 22 - ((timeNow * 42 + d * 28) % (spec.width - 30));
        const dy = (d % 2 === 0 ? -1.8 : 1.8);
        ctx.beginPath();
        ctx.arc(dx, dy, 2.0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();

  // Intuitive Vapor Inlet & Condensate Outlet tube drag ports (in world coordinates matching rotated endpoints)
  const portIn = ports.inlet;
  const portOut = ports.outlet;
  for (const [port, connected, color] of [
    [portIn, Boolean(item.connectedFromId), '#f59e0b'],
    [portOut, Boolean(item.outletTargetId), '#0ea5e9'],
  ]) {
    ctx.save();
    ctx.fillStyle = connected ? color : pal.badgeBg;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(port.x, port.y, 5.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  if (item.activeDrop && !item.outletTargetId) {
    ctx.save();
    const dropY = ports.spout.y + 4 + ((timeNow * 45) % 22);
    ctx.fillStyle = item.lastCondColor || 'rgba(186, 230, 253, 0.9)';
    ctx.beginPath();
    ctx.arc(ports.spout.x, dropY, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const refluxTag = item.refluxMode ? (langCode === 'en' ? ' · ♻️ Reflux' : ' · ♻️ Hồi lưu') : '';
  const labelY = item.refluxMode ? y - halfW - 18 : y - 34;
  drawLabelPill(
    ctx,
    x,
    labelY,
    `${item.label}${refluxTag} · ❄️ ${item.waterFlowOn ? 'H₂O ON' : 'OFF'} · ${(item.totalCondensedMl || 0).toFixed(1)}mL`,
    { pal, borderColor: isSelected ? '#3b82f6' : item.refluxMode ? '#10b981' : null, font: '600 10.5px system-ui, sans-serif', height: 18 }
  );
}

export function renderBurette(ctx, item, isSelected, isDropTarget, isDark, timeNow = 0) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const spec = APPARATUS.burette_50;
  if (item.isBroken) {
    renderBrokenToolShards(ctx, item, pal, isSelected, 54, spec.height);
    return;
  }
  const topY = y - spec.height / 2;
  const botY = y + spec.height / 2;
  const colBotY = botY - 36;
  const colTopY = topY + 12;
  const halfW = 6.5;

  ctx.save();
  if (Math.abs(item.tiltAngle || 0) > 0.01) {
    ctx.translate(x, y);
    ctx.rotate(item.tiltAngle || 0);
    ctx.translate(-x, -y);
  }
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
  const tip = getProbeTipPos(item);
  const dir = tip.dir;
  ctx.fillStyle = '#d97706';
  ctx.strokeStyle = isSelected ? '#3b82f6' : '#92400e';
  ctx.lineWidth = isSelected ? 2 : 1;
  ctx.beginPath();
  ctx.roundRect(dir < 0 ? x - 46 : x - 50, y - 3, 96, 6, 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  const tipX = tip.visualTipX;
  const isO2Flare = item.mode === 'burning' && (item.o2FlareTimer || 0) > 0;
  if (item.mode === 'burning' || item.mode === 'glowing') {
    // Charred tip + glowing ember
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(tipX - 4, y - 3.2, 8, 6.4);
    const pulse = 0.78 + Math.sin(timeNow * 14) * 0.22;
    const haloR = isO2Flare ? 34 : item.mode === 'burning' ? 16 : 10;
    const g = ctx.createRadialGradient(tipX, y, 1, tipX, y, haloR);
    g.addColorStop(0, isO2Flare ? '#ffffff' : item.mode === 'burning' ? '#fef08a' : `rgba(249, 115, 22, ${0.95 * pulse})`);
    g.addColorStop(0.55, isO2Flare ? `rgba(253, 224, 71, ${0.85 * pulse})` : `rgba(239, 68, 68, ${0.65 * pulse})`);
    g.addColorStop(1, 'rgba(239, 68, 68, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(tipX, y, haloR, 0, Math.PI * 2);
    ctx.fill();

    if (item.mode === 'burning') {
      const fScale = isO2Flare ? 2.15 : 1.0;
      const wob = Math.sin(timeNow * (isO2Flare ? 28 : 20)) * (isO2Flare ? 3.8 : 2.0);
      const outerH = 19 * fScale;
      const outerW = 4.6 * fScale;
      const innerH = 11 * fScale;
      const innerW = 2.4 * fScale;
      if (getCurrentCanvasTheme() === 'ctrl') {
        const pxS = isO2Flare ? 4 : 3;
        const cols = Math.max(3, Math.round((outerW * 2) / pxS));
        const rows = Math.max(4, Math.round(outerH / pxS));
        const tick = Math.floor(timeNow * 12);
        for (let r = 0; r < rows; r++) {
          const rf = r / Math.max(1, rows - 1);
          const span = Math.max(1, Math.round(cols * (1 - rf * 0.65)));
          const half = Math.floor(span / 2);
          const sw = Math.round(Math.sin(tick + r * 0.8) * (rf > 0.4 ? 1 : 0));
          for (let c = -half; c <= half; c++) {
            const hash = Math.abs(Math.sin((r * 23 + c * 13 + tick) * 12.9898) * 43758.5453) % 1;
            if (rf > 0.68 && hash < 0.3) continue;
            ctx.fillStyle =
              r < rows * 0.55 && Math.abs(c) <= Math.max(0, half - 1)
                ? isO2Flare ? '#ffffff' : '#fef08a'
                : isO2Flare ? '#fbbf24' : '#fb923c';
            ctx.fillRect(Math.round(tipX + (c + sw) * pxS - pxS * 0.5), Math.round(y - (r + 1) * pxS), pxS - 0.5, pxS - 0.5);
          }
        }
      } else {
        ctx.fillStyle = isO2Flare ? 'rgba(251, 191, 36, 0.96)' : 'rgba(251, 146, 60, 0.90)';
        ctx.beginPath();
        ctx.moveTo(tipX - outerW, y);
        ctx.quadraticCurveTo(tipX + wob, y - outerH, tipX + outerW, y);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = isO2Flare ? '#ffffff' : 'rgba(254, 240, 138, 0.95)';
        ctx.beginPath();
        ctx.moveTo(tipX - innerW, y);
        ctx.quadraticCurveTo(tipX + wob * 0.5, y - innerH, tipX + innerW, y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  const badgeTxt =
    item.lastTestEvent === 'h2_pop'
      ? '💥 H₂ "Póc!"'
      : isO2Flare || item.lastTestEvent === 'o2_flare'
      ? '🔥 O₂ Bùng rực!'
      : item.lastTestEvent === 'o2_relight'
      ? '🔥 O₂ Bùng cháy!'
      : item.mode === 'burning'
      ? '🔥 Burning Splint'
      : item.mode === 'glowing'
      ? '🔴 Glowing Ember'
      : 'Unlit Splint';
  drawLabelPill(ctx, x, y - (isO2Flare ? 28 : 19), badgeTxt, {
    pal,
    borderColor: isO2Flare ? '#facc15' : isSelected ? '#3b82f6' : null,
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
  });
  ctx.restore();
}

export function renderFlameLoop(ctx, item, isSelected, isDark, timeNow = 0) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const tip = getProbeTipPos(item);
  const dir = tip.dir;
  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Borosilicate handle
  ctx.fillStyle = isDark ? 'rgba(186, 230, 253, 0.35)' : 'rgba(148, 163, 184, 0.45)';
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.roundRect(dir < 0 ? x - 6 : x - 52, y - 3.5, 58, 7, 3.5);
  ctx.fill();
  ctx.stroke();

  // Twisted Nichrome wire + sample loop at active tip
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x - dir * 6, y);
  ctx.lineTo(x + dir * 42, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(tip.loopCenterX, y, 5, 0, Math.PI * 2);
  ctx.stroke();

  if (item.sampledIon) {
    // Subtle wet solution film on wire loop — color reveals ONLY upon heating in burner flame!
    ctx.fillStyle =
      item.sampledIon === 'Cu²⁺'
        ? 'rgba(56, 189, 248, 0.42)'
        : item.sampledIon === 'Ca²⁺'
        ? 'rgba(239, 68, 68, 0.42)'
        : 'rgba(226, 232, 240, 0.42)';
    ctx.beginPath();
    ctx.arc(tip.loopCenterX, y, 4.0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawLabelPill(ctx, x, y - 18, item.sampledIon ? `🔬 ${item.sampledIon}` : `${item.label} · NiCr Wire`, {
    pal,
    borderColor: isSelected ? '#3b82f6' : null,
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
  });
  ctx.restore();
}

export function renderIndicatorStrip(ctx, item, isSelected, isDark, langCode = 'vi') {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const { dir } = getProbeTipPos(item);
  const isLit = item.stripKind === 'litmus';
  const dryBase = isLit ? '#8b5cf6' : '#facc15';
  const wetColor = item.tipColor || dryBase;

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Dry handle half
  ctx.fillStyle = dryBase;
  ctx.strokeStyle = isSelected ? '#3b82f6' : isDark ? '#475569' : '#94a3b8';
  ctx.lineWidth = isSelected ? 2 : 1.1;
  ctx.beginPath();
  ctx.roundRect(x - 28, y - 6, 56, 12, 2);
  ctx.fill();
  ctx.stroke();

  // Immersed / sampled tip half (left by default, right if flipped)
  ctx.fillStyle = wetColor;
  ctx.fillRect(dir < 0 ? x - 27.5 : x + 2.5, y - 5.5, 25, 11);
  ctx.shadowBlur = 0;

  let txt;
  if (item.isBleached) {
    txt = langCode === 'vi' ? 'Mất màu (Cl₂)' : 'Cl₂ Bleached';
  } else if (isLit) {
    if (item.sampledPH == null) {
      txt = langCode === 'vi' ? 'Quỳ tím' : 'Litmus Paper';
    } else if (item.sampledPH < 5.2) {
      txt = langCode === 'vi' ? 'Đỏ (Acid)' : 'Red (Acid)';
    } else if (item.sampledPH > 8.2) {
      txt = langCode === 'vi' ? 'Xanh (Base)' : 'Blue (Base)';
    } else {
      txt = langCode === 'vi' ? 'Tím (Trung tính)' : 'Purple (Neutral)';
    }
  } else if (item.sampledPH !== null && item.sampledPH !== undefined) {
    txt = `pH ≈ ${item.sampledPH.toFixed(1)}`;
  } else {
    txt = langCode === 'vi' ? 'Giấy đo pH' : 'Universal pH';
  }
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

export function renderSaltBridge(ctx, item, items = [], isSelected = false, isDark = true, timeNow = 0, langCode = 'vi') {
  const pal = getThemePalette(isDark);
  const spec = APPARATUS.salt_bridge;
  if (item.isBroken) {
    renderBrokenToolShards(ctx, item, pal, isSelected, spec.width * 0.72, spec.height);
    return;
  }

  let { x, y } = item;
  const vA = item.vesselAId ? items.find((i) => i.id === item.vesselAId && !i.isShattered) : null;
  const vB = item.vesselBId ? items.find((i) => i.id === item.vesselBId && !i.isShattered) : null;
  const bridged = Boolean(vA && vB);

  let lx = x - 44;
  let rx = x + 44;
  let lyBot = y + 32;
  let ryBot = y + 32;
  let archTopY = y - 34;

  if (bridged) {
    const leftV = vA.x <= vB.x ? vA : vB;
    const rightV = vA.x <= vB.x ? vB : vA;
    const spL = APPARATUS[leftV.typeId] || APPARATUS.beaker_250;
    const spR = APPARATUS[rightV.typeId] || APPARATUS.beaker_250;
    // Dip neatly inside the facing inner half of BOTH electrolyte solutions (avoiding centered electrodes cleanly)
    lx = leftV.x + Math.min(20, spL.width * 0.24);
    rx = rightV.x - Math.min(20, spR.width * 0.24);
    if (rx - lx < 36) {
      lx = leftV.x + 8;
      rx = rightV.x - 8;
    }
    lyBot = leftV.y + spL.height / 2 - 14;
    ryBot = rightV.y + spR.height / 2 - 14;
    const rimTop = Math.min(leftV.y - spL.height / 2, rightV.y - spR.height / 2);
    archTopY = rimTop - 22;
    x = 0.5 * (lx + rx);
    y = rimTop;
    if (!item.isDragging) {
      item.x = x;
      item.y = y;
    }
  }

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  const r = Math.max(18, (rx - lx) * 0.5);
  const midX = 0.5 * (lx + rx);
  const curveBaseY = archTopY + Math.min(34, r * 0.65);

  const traceU = () => {
    ctx.beginPath();
    ctx.moveTo(lx, lyBot);
    ctx.lineTo(lx, curveBaseY);
    ctx.quadraticCurveTo(lx, archTopY, midX, archTopY);
    ctx.quadraticCurveTo(rx, archTopY, rx, curveBaseY);
    ctx.lineTo(rx, ryBot);
  };

  // Outer Borosilicate U-tube wall
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = 10.5;
  ctx.lineCap = 'round';
  traceU();
  ctx.stroke();

  // Saturated agar Na2SO4 / KNO3 gel core
  ctx.strokeStyle = isDark ? 'rgba(224, 242, 254, 0.58)' : 'rgba(186, 230, 253, 0.86)';
  ctx.lineWidth = 6.8;
  traceU();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Porous cotton/agar end plugs clearly visible inside the solutions
  ctx.fillStyle = isDark ? '#f8fafc' : '#e2e8f0';
  ctx.strokeStyle = isDark ? '#94a3b8' : '#64748b';
  ctx.lineWidth = 0.9;
  for (const [px, py] of [[lx, lyBot], [rx, ryBot]]) {
    ctx.beginPath();
    ctx.roundRect(px - 4.2, py - 5, 8.4, 7, 2);
    ctx.fill();
    ctx.stroke();
  }

  // Subtle ion-migration shimmer along bridge when Galvanic current flows
  if (bridged && (item.activeCurrentA || 0) > 1e-4) {
    const p0 = { x: lx, y: curveBaseY };
    const p1 = { x: lx, y: archTopY };
    const p2 = { x: midX, y: archTopY };
    const p3 = { x: rx, y: archTopY };
    const p4 = { x: rx, y: curveBaseY };
    ctx.fillStyle = 'rgba(56, 189, 248, 0.92)';
    for (let k = 0; k < 4; k++) {
      const u = ((timeNow * 0.75 + k * 0.25) % 1);
      let ix;
      let iy;
      if (u < 0.5) {
        const s = u * 2;
        const m = 1 - s;
        ix = m * m * p0.x + 2 * m * s * p1.x + s * s * p2.x;
        iy = m * m * p0.y + 2 * m * s * p1.y + s * s * p2.y;
      } else {
        const s = (u - 0.5) * 2;
        const m = 1 - s;
        ix = m * m * p2.x + 2 * m * s * p3.x + s * s * p4.x;
        iy = m * m * p2.y + 2 * m * s * p3.y + s * s * p4.y;
      }
      ctx.beginPath();
      ctx.arc(ix, iy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const labelStr = bridged
    ? langCode === 'vi'
      ? `${item.label} · Cầu muối (${vA.label} ↔ ${vB.label})${(item.activeCurrentA || 0) > 1e-4 ? ' · ⚡' : ''}`
      : `${item.label} · Salt Bridge (${vA.label} ↔ ${vB.label})${(item.activeCurrentA || 0) > 1e-4 ? ' · ⚡' : ''}`
    : langCode === 'vi'
    ? `${item.label} · Cầu muối (Chưa nối)`
    : `${item.label} · Salt Bridge (Unbridged)`;

  drawLabelPill(ctx, midX, archTopY - 26, labelStr, {
    pal,
    borderColor: bridged ? '#10b981' : isSelected ? '#3b82f6' : null,
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
    itemIds: [item.id, item.vesselAId, item.vesselBId].filter(Boolean),
  });
  ctx.restore();
}

export function renderElectrodeRod(ctx, item, isSelected, isDark, timeNow = 0) {
  const pal = getThemePalette(isDark);
  const mat = ELECTRODE_MATERIALS[item.material] || ELECTRODE_MATERIALS.C;
  const { x, y } = item;
  const spec = APPARATUS.electrode_rod;
  const rodH = item.renderHeight || spec.height;
  const topY = y - rodH / 2;
  const botY = y + rodH / 2;
  const maxCoatH = Math.max(12, Math.min(rodH - 22, item.immersedHeightPx ?? (rodH - 20) * 0.56));

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Metal/graphite plate dipped vertically
  ctx.fillStyle = mat.color;
  ctx.strokeStyle = isSelected ? '#3b82f6' : item.cathodicProtectedActive ? '#10b981' : mat.stroke;
  ctx.lineWidth = isSelected || item.cathodicProtectedActive ? 2.1 : 1.4;
  ctx.beginPath();
  ctx.roundRect(x - 4.5, topY + 12, 9, rodH - 16, 2);
  ctx.fill();
  ctx.stroke();

  // Phenomenon #9A: Electroplated Cu(s) layer along immersed lower half (salmon-pink smooth vs dark burned)
  if (item.platedMaterial === 'Cu' && (item.platedCuMol || 0) > 1e-7) {
    const isBurned = item.platedQuality === 'burned';
    const coatH = maxCoatH;
    const coatTop = botY - 4 - coatH;
    ctx.save();
    if (isBurned) {
      ctx.fillStyle = '#451a03';
      ctx.fillRect(x - 5.2, coatTop, 10.4, coatH);
      ctx.fillStyle = '#1c1917';
      for (let g = 0; g < 8; g++) {
        ctx.beginPath();
        ctx.arc(x + ((g % 2 === 0 ? -1 : 1) * 3.8), coatTop + 6 + g * (coatH / 9), 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      const cuGrad = ctx.createLinearGradient(x - 5, 0, x + 5, 0);
      cuGrad.addColorStop(0, '#c2410c');
      cuGrad.addColorStop(0.45, '#fb923c');
      cuGrad.addColorStop(1, '#ea580c');
      ctx.fillStyle = cuGrad;
      ctx.fillRect(x - 5, coatTop, 10, coatH);
    }
    ctx.restore();
  }

  // Exp 19: Silver DLA Dendrite crystal tree branches growing cathode -> anode (& retracting on polarity reversal)
  if (item.platedMaterial === 'Ag' && (item.platedAgMol || 0) > 1e-7) {
    const growFrac = Math.min(1.0, Math.sqrt((item.platedAgMol || 0) / 0.0012));
    const dir = item.dendriteSide === -1 ? -1 : 1;
    const coatH = maxCoatH * 0.92;
    const baseTipY = botY - 6;
    ctx.save();
    // Bright specular metallic Silver coating sleeve
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(x - 5.2, baseTipY - coatH * growFrac * 0.65, 10.4, coatH * growFrac * 0.65);

    const boughCount = 4;
    for (let b = 0; b < boughCount; b++) {
      const fracB = Math.max(0, Math.min(1, growFrac * 1.25 - b * 0.14));
      if (fracB <= 0.05) continue;
      const sy = baseTipY - 4 - b * 9;
      const len1 = (8 + b * 2.2) * fracB;
      const tx = x + dir * len1;
      const ty = sy - 3.5 * fracB;

      ctx.strokeStyle = isDark ? '#f8fafc' : '#64748b';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + dir * 4, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      // Secondary crystalline twigs
      if (fracB > 0.35) {
        const subLen = len1 * 0.52;
        ctx.strokeStyle = isDark ? '#cbd5e1' : '#94a3b8';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(tx * 0.65 + (x + dir * 4) * 0.35, (sy + ty) * 0.5);
        ctx.lineTo(tx + dir * subLen * 0.4, ty - subLen * 0.65);
        ctx.moveTo(tx * 0.8 + (x + dir * 4) * 0.2, (sy + ty * 2) / 3);
        ctx.lineTo(tx + dir * subLen * 0.55, ty + subLen * 0.45);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Cathodic sacrificial protection emerald halo ring
  if (item.cathodicProtectedActive) {
    ctx.save();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.8)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x - 7, botY - maxCoatH, 14, maxCoatH);
    ctx.restore();
  }

  // Top binding terminal cap
  ctx.fillStyle = item.polarityLabel?.startsWith('+') ? '#ef4444' : item.polarityLabel?.startsWith('-') ? '#1e293b' : '#475569';
  ctx.beginPath();
  ctx.roundRect(x - 6, topY + 2, 12, 11, 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Gas micro-bubbles restricted to the submerged liquid zone during electrolysis
  if (item.gasBubbleType && (item.gasBubbleRate || 0) > 1e-7 && (!item.dockedVesselId || (item.immersedFrac ?? 1) > 0.01)) {
    const riseSpan = Math.max(10, Math.min(48, maxCoatH - 4));
    ctx.fillStyle = item.gasBubbleType === 'Cl2_g' ? 'rgba(163, 230, 53, 0.72)' : 'rgba(241, 245, 249, 0.85)';
    for (let i = 0; i < 6; i++) {
      const rise = (timeNow * 42 + i * 9) % riseSpan;
      const bx = x + ((i % 2 === 0 ? -1 : 1) * 5.5);
      const by = botY - 6 - rise;
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

export function renderElectrodeCollectorTubes(ctx, items, isDark, timeNow = 0) {
  for (const el of items) {
    if (el.kind !== 'electrode' || !el.gasTargetId) continue;
    const target = items.find((i) => i.id === el.gasTargetId && !i.isShattered && !i.isBroken);
    if (!target) continue;
    // Skip cable if it's already an inverted tube sitting physically directly over the electrode
    if (target.mountedOverElectrodeId === el.id) continue;

    const eSpec = APPARATUS.electrode_rod;
    const eH = el.renderHeight || eSpec.height;
    const tSpec = APPARATUS[target.typeId] || APPARATUS.gas_syringe;
    const p0 = { x: el.x, y: el.y - eH / 2 + 8 };
    const p3 =
      target.kind === 'gas_syringe'
        ? (() => {
            const g = getSyringeGeometry(target);
            return { x: g.nozzleX, y: g.nozzleY };
          })()
        : getTubeDestTipPos(el, target);

    const midY = Math.min(p0.y, p3.y) - 48;
    const p1 = { x: p0.x, y: midY };
    const p2 = { x: p3.x, y: midY };
    const points = buildRigidTubePoints(p0, p1, p2, p3, target, { archLift: 46 });

    ctx.save();
    // Small bell hood cap over electrode + translucent silicone delivery tubing
    ctx.fillStyle = isDark ? 'rgba(148, 163, 184, 0.38)' : 'rgba(100, 116, 139, 0.34)';
    ctx.beginPath();
    ctx.roundRect(el.x - 8, el.y - eH / 2 + 6, 16, 12, 3);
    ctx.fill();

    ctx.strokeStyle = isDark ? 'rgba(71, 85, 105, 0.78)' : 'rgba(51, 65, 85, 0.65)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (points.length >= 2) {
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    } else {
      ctx.moveTo(p0.x, p0.y);
      ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    }
    ctx.stroke();

    ctx.strokeStyle = isDark ? 'rgba(186, 230, 253, 0.45)' : 'rgba(226, 232, 240, 0.75)';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    if ((el.gasBubbleRate || 0) > 1.5e-7) {
      ctx.fillStyle = el.gasBubbleType === 'Cl2_g' ? 'rgba(217, 249, 157, 0.92)' : 'rgba(186, 230, 253, 0.9)';
      for (let k = 0; k < 3; k++) {
        const u = (timeNow * 1.25 + k * 0.33) % 1;
        const bp = samplePolylineAt(points, u);
        ctx.beginPath();
        ctx.arc(bp.x, bp.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (target.kind === 'vessel' && !target.isInverted && !target.isShattered) {
      const isSub = (el.tubeSubmersionRatio ?? 0.72) >= 0.4;
      ctx.fillStyle = isSub ? '#0284c7' : '#f59e0b';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(p3.x, p3.y, 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
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
      const eH = el.renderHeight || eSpec.height;
      const to = { x: el.x, y: el.y - eH / 2 + 5 };
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
    ctx.fillText(formatCanvasText(`${vStr} · ${aStr}`), x, topY + 28);
    ctx.font = '600 8.5px system-ui, sans-serif';
    const modeTag =
      sup.circuitMode === 'galvanic'
        ? 'BATTERY EMF'
        : sup.circuitMode === 'electrolysis'
        ? sup.powerOn
          ? 'ELECTROLYSIS ON'
          : 'STANDBY'
        : 'NO CIRCUIT';
    ctx.fillText(formatCanvasText(modeTag), x, topY + 40);

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
      itemId: sup.id,
    });
    ctx.restore();
  }
}

export function renderVoltAmmeterAndWires(ctx, items, selectedId, isDark) {
  const pal = getThemePalette(isDark);
  const meters = items.filter((i) => i.kind === 'volt_ammeter');
  const electrodes = items.filter((i) => i.kind === 'electrode');

  for (const meter of meters) {
    const { x, y } = meter;
    const spec = APPARATUS.volt_ammeter;
    const topY = y - spec.height / 2;
    const leftX = x - spec.width / 2;
    const isSelected = meter.id === selectedId;

    const posEl = electrodes.find((e) => e.id === meter.posElectrodeId);
    const negEl = electrodes.find((e) => e.id === meter.negElectrodeId);
    const postPos = { x: x - 24, y: y + 23 };
    const postNeg = { x: x + 24, y: y + 23 };

    const drawLead = (from, el, color) => {
      if (!el) return;
      const eSpec = APPARATUS.electrode_rod;
      const eH = el.renderHeight || eSpec.height;
      const to = { x: el.x, y: el.y - eH / 2 + 5 };
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo(from.x, Math.max(from.y, to.y) + 28, to.x, to.y - 40, to.x, to.y);
      ctx.stroke();
      ctx.restore();
    };
    drawLead(postPos, posEl, '#ef4444');
    drawLead(postNeg, negEl, isDark ? '#94a3b8' : '#1e293b');

    ctx.save();
    drawSelectionGlow(ctx, isSelected, false);
    // Iconic bench Multimeter Amber/Slate holster
    ctx.fillStyle = isDark ? '#b45309' : '#f59e0b';
    ctx.strokeStyle = isSelected ? '#3b82f6' : isDark ? '#f59e0b' : '#b45309';
    ctx.lineWidth = isSelected ? 2.2 : 1.7;
    ctx.beginPath();
    ctx.roundRect(leftX, topY, spec.width, spec.height, 9);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Inner dark bezel & LCD readout
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.roundRect(leftX + 7, topY + 7, spec.width - 14, spec.height - 14, 6);
    ctx.fill();

    ctx.fillStyle = pal.lcdBg;
    ctx.beginPath();
    ctx.roundRect(leftX + 11, topY + 11, spec.width - 22, 34, 4);
    ctx.fill();

    const vStr = `${(meter.measuredV || 0).toFixed(2)}V`;
    const aStr = `${(meter.measuredCurrentA || 0).toFixed(2)}A`;
    ctx.fillStyle = pal.lcdText;
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(formatCanvasText(meter.mode === 'voltmeter' ? vStr : `${vStr} · ${aStr}`), x, topY + 28);

    ctx.font = '600 8px system-ui, sans-serif';
    const modeLabel =
      meter.cathodicProtectedActive
        ? '🛡️ CATHODE PROT.'
        : meter.mode === 'short'
        ? 'SHORT WIRE'
        : meter.mode === 'ammeter'
        ? 'AMMETER (LOAD)'
        : meter.circuitMode === 'open_circuit'
        ? 'NO BRIDGE'
        : 'VOLTMETER (10MΩ)';
    ctx.fillText(formatCanvasText(modeLabel), x, topY + 40);

    // Banana jacks (+V/A Red / COM Black)
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(postPos.x, postPos.y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#334155';
    ctx.beginPath();
    ctx.arc(postNeg.x, postNeg.y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 8.5px system-ui, sans-serif';
    ctx.fillText('+', postPos.x, postPos.y + 3);
    ctx.fillText('−', postNeg.x, postNeg.y + 3);

    drawLabelPill(ctx, x, topY - 12, meter.cathodicProtectedActive ? `🛡️ ${meter.label} · Prot` : `${meter.label} · Volt-Ammeter`, {
      pal,
      borderColor: meter.cathodicProtectedActive ? '#10b981' : isSelected ? '#3b82f6' : null,
      font: '600 10.5px system-ui, sans-serif',
      height: 18,
      itemId: meter.id,
    });
    ctx.restore();
  }
}

export function renderDiffusionTube(ctx, item, isSelected, isDropTarget, isDark, langCode = 'vi') {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const spec = APPARATUS.diffusion_tube;
  const leftX = x - spec.width / 2;
  const rightX = x + spec.width / 2;
  const tubeHalfH = 12;
  const innerLeft = leftX + 16;
  const innerRight = rightX - 16;
  const innerW = innerRight - innerLeft;

  if (item.isBroken) {
    renderBrokenToolShards(ctx, item, pal, isSelected, spec.width * 0.7, spec.height);
    return;
  }

  ctx.save();
  if (Math.abs(item.tiltAngle || 0) > 0.01) {
    ctx.translate(x, y);
    ctx.rotate(item.tiltAngle || 0);
    ctx.translate(-x, -y);
  }
  drawSelectionGlow(ctx, isSelected, isDropTarget);

  // Bench rubber cradle stands supporting horizontal tube
  ctx.fillStyle = isDark ? '#334155' : '#475569';
  for (const sx of [x - 76, x + 76]) {
    ctx.beginPath();
    ctx.roundRect(sx - 9, y + tubeHalfH - 2, 18, spec.height / 2 - tubeHalfH + 2, 2);
    ctx.fill();
  }

  // Horizontal Borosilicate glass tube body
  ctx.fillStyle = pal.glassFill;
  ctx.strokeStyle = isDropTarget ? '#10b981' : isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = isSelected || isDropTarget ? 2.2 : 1.7;
  ctx.beginPath();
  ctx.roundRect(leftX, y - tubeHalfH, spec.width, tubeHalfH * 2, 6);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Advancing subtle vapor plumes inside bore before meeting
  ctx.save();
  ctx.beginPath();
  ctx.rect(innerLeft, y - tubeHalfH + 2, innerW, tubeHalfH * 2 - 4);
  ctx.clip();

  if (item.leftGasId && (item.leftFront || 0) > 0.01) {
    const fW = Math.min(1, item.leftFront) * innerW;
    const gradL = ctx.createLinearGradient(innerLeft, y, innerLeft + fW, y);
    gradL.addColorStop(0, item.leftGasId === 'NH3_g' ? 'rgba(56, 189, 248, 0.20)' : 'rgba(226, 232, 240, 0.22)');
    gradL.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradL;
    ctx.fillRect(innerLeft, y - tubeHalfH + 2, fW, tubeHalfH * 2 - 4);
  }
  if (item.rightGasId && (item.rightFront ?? 1) < 0.99) {
    const rX = innerLeft + Math.max(0, item.rightFront) * innerW;
    const fW = innerRight - rX;
    const gradR = ctx.createLinearGradient(innerRight, y, rX, y);
    gradR.addColorStop(0, item.rightGasId === 'NH3_g' ? 'rgba(56, 189, 248, 0.20)' : 'rgba(226, 232, 240, 0.22)');
    gradR.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradR;
    ctx.fillRect(rX, y - tubeHalfH + 2, fW, tubeHalfH * 2 - 4);
  }

  // Phenomenon #8: White crisp NH4Cl(s) smoke ring nucleating at Graham meeting coordinate!
  if (item.ringPosFrac != null && (item.ringGrowth || 0) > 0.02) {
    const rx = innerLeft + item.ringPosFrac * innerW;
    const gAmt = Math.min(1, item.ringGrowth);
    const ringGrad = ctx.createLinearGradient(rx - 10, y, rx + 10, y);
    ringGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
    ringGrad.addColorStop(0.5, `rgba(255, 255, 255, ${(0.95 * gAmt).toFixed(2)})`);
    ringGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = ringGrad;
    ctx.fillRect(rx - 10, y - tubeHalfH + 1, 20, tubeHalfH * 2 - 2);

    ctx.strokeStyle = isDark ? 'rgba(248, 250, 252, 0.92)' : 'rgba(148, 163, 184, 0.95)';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(rx, y - tubeHalfH + 2);
    ctx.lineTo(rx, y + tubeHalfH - 2);
    ctx.stroke();
  }
  ctx.restore();

  // Graduated centimeter ruler ticks (0, 25, 50 midpoint, 75, 100 cm)
  ctx.strokeStyle = pal.tickStroke;
  ctx.fillStyle = pal.enamelText;
  ctx.font = '600 7px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let cm = 0; cm <= 100; cm += 10) {
    const tx = innerLeft + (cm / 100) * innerW;
    const isMajor = cm % 50 === 0;
    ctx.lineWidth = isMajor ? 1.2 : 0.8;
    ctx.beginPath();
    ctx.moveTo(tx, y + tubeHalfH - (isMajor ? 6 : 3.5));
    ctx.lineTo(tx, y + tubeHalfH);
    ctx.stroke();
  }

  // Soaked cotton wool plugs at Left (0cm) and Right (100cm)
  const drawPlug = (px, gasId) => {
    ctx.fillStyle = gasId === 'NH3_g' ? '#bae6fd' : gasId === 'HCl_g' ? '#fef08a' : '#e2e8f0';
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(px - 6, y - tubeHalfH + 2, 12, tubeHalfH * 2 - 4, 4);
    ctx.fill();
    ctx.stroke();
  };
  drawPlug(leftX + 8, item.leftGasId);
  drawPlug(rightX - 8, item.rightGasId);

  // Floating tags for loaded ends & formed ring position
  let badge = `${item.label} · 100 cm`;
  if (item.ringPosFrac != null && (item.ringGrowth || 0) > 0.1) {
    const pctLeft = (item.ringPosFrac * 100).toFixed(1);
    badge = `${item.label} · NH₄Cl(s) @ ${pctLeft} cm`;
  } else if (item.leftGasId || item.rightGasId) {
    const lTag = item.leftGasId ? SPECIES[item.leftGasId]?.formula : '?';
    const rTag = item.rightGasId ? SPECIES[item.rightGasId]?.formula : '?';
    badge = `${lTag} ⟶ ⟵ ${rTag}`;
  }
  drawLabelPill(ctx, x, y - tubeHalfH - 16, badge, {
    pal,
    borderColor: (item.ringGrowth || 0) > 0.2 ? '#10b981' : isSelected ? '#3b82f6' : null,
    font: '600 10.5px system-ui, sans-serif',
    height: 18,
  });
  ctx.restore();
}

export function renderIronSpoon(ctx, item, isSelected, isDark, timeNow = 0) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const dir = item.flippedX ? 1 : -1;
  // Vertical deflagrating combustion spoon: hanging loop at TOP, vertical stem down to cup bowl at BOTTOM
  const stemX = x + dir * 2;
  const bowlX = stemX;
  const bowlY = y + 46;
  const topRingY = y - 50;
  const tilt = item.tiltAngle || 0;

  ctx.save();
  if (Math.abs(tilt) > 0.01) {
    ctx.translate(x, y);
    ctx.rotate(tilt);
    ctx.translate(-x, -y);
  }
  drawSelectionGlow(ctx, isSelected, false);

  // Top hanging ring & vertical steel rod down to cup neck
  ctx.strokeStyle = isSelected ? '#3b82f6' : isDark ? '#cbd5e1' : '#334155';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(stemX, topRingY, 5.5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 3.0;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(stemX, topRingY + 5.5);
  ctx.lineTo(stemX, bowlY - 3);
  ctx.quadraticCurveTo(stemX, bowlY + 1, bowlX - dir * 8.5, bowlY + 1);
  ctx.stroke();

  // Deep deflagrating spoon cup bowl (glows cherry-orange when heated > 720 K)
  const tempK = item.tempK || 298.15;
  const glowFrac = Math.max(0, Math.min(1, (tempK - 720) / 480));
  ctx.fillStyle =
    glowFrac > 0.08
      ? `rgb(${Math.round(148 + glowFrac * 105)}, ${Math.round(163 - glowFrac * 70)}, ${Math.round(184 - glowFrac * 150)})`
      : isDark
      ? '#64748b'
      : '#94a3b8';
  ctx.strokeStyle = glowFrac > 0.2 ? '#f97316' : isDark ? '#e2e8f0' : '#1e293b';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(bowlX, bowlY, 10.5, 0, Math.PI, false);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Solid contents mound inside the spoon bowl
  const entries = Object.entries(item.moles || {}).filter(([, n]) => n > 1e-9);
  const totalMol = entries.reduce((s, [, n]) => s + n, 0);
  if (totalMol > 1e-9) {
    entries.sort((a, b) => b[1] - a[1]);
    const topSpId = entries[0][0];
    const sp = SPECIES[topSpId];
    let moundCol =
      topSpId === 'ZnO_s' && tempK >= (sp?.hotColorTempK || 573.15)
        ? sp?.hotColor || '#fef08a'
        : sp?.meltTempK && tempK >= sp.meltTempK
        ? sp?.moltenColor || sp?.color || '#cbd5e1'
        : sp?.color || '#cbd5e1';
    if (topSpId === 'S_s' && tempK >= 493.15) {
      moundCol = '#7c2d12';
    } else if (topSpId === 'S_s' && tempK >= 433.15) {
      moundCol = '#b45309';
    }

    // Active combustion flame envelope above spoon bowl
    if ((item.burnTimer || 0) > 0.04) {
      const isFeSparks = item.flameColor === 'sparks_fe';
      const fCol =
        item.flameColor === 'white_mg' || item.flameColor === 'white_al'
          ? 'rgba(248, 250, 252, 0.98)'
          : item.flameColor === 'violet_k'
          ? 'rgba(192, 132, 252, 0.94)'
          : item.flameColor === 'cyan_zn'
          ? 'rgba(103, 232, 249, 0.92)'
          : item.flameColor === 'sulfur_blue'
          ? 'rgba(96, 165, 250, 0.90)'
          : item.flameColor === 'sulfur_violet'
          ? 'rgba(139, 92, 246, 0.94)'
          : item.flameColor === 'emerald_cu'
          ? 'rgba(52, 211, 153, 0.90)'
          : isFeSparks
          ? 'rgba(251, 146, 60, 0.95)'
          : 'rgba(253, 224, 71, 0.95)';
      const fGrad = ctx.createRadialGradient(bowlX, bowlY - 6, 2, bowlX, bowlY - 12, 26);
      fGrad.addColorStop(0, '#ffffff');
      fGrad.addColorStop(0.45, fCol);
      fGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = fGrad;
      ctx.beginPath();
      ctx.arc(bowlX, bowlY - 10, 23 + Math.sin(timeNow * 25) * 3, 0, Math.PI * 2);
      ctx.fill();
      if (isFeSparks) {
        ctx.strokeStyle = '#fef08a';
        ctx.lineWidth = 1.4;
        for (let k = 0; k < 9; k++) {
          const ang = -Math.PI + (k / 8) * Math.PI * 1.4 + Math.sin(timeNow * 19 + k) * 0.25;
          const r1 = 6;
          const r2 = 16 + ((timeNow * 58 + k * 6) % 15);
          ctx.beginPath();
          ctx.moveTo(bowlX + Math.cos(ang) * r1, bowlY - 2 + Math.sin(ang) * r1);
          ctx.lineTo(bowlX + Math.cos(ang) * r2, bowlY - 2 + Math.sin(ang) * r2);
          ctx.stroke();
        }
      }
    }

    const moundH = Math.min(8.5, 3.2 + Math.cbrt(totalMol * 80) * 3.5);
    ctx.fillStyle = moundCol;
    ctx.strokeStyle = sp?.highlightColor || '#475569';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bowlX - 8.5, bowlY + 0.5);
    ctx.quadraticCurveTo(bowlX, bowlY - moundH * 1.6, bowlX + 8.5, bowlY + 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  const labelFormula = entries.length > 0 ? entries.map(([k]) => SPECIES[k]?.formula || k).slice(0, 2).join('+') : '';
  const pillText = item.hoveredActionLabel
    ? item.hoveredActionLabel
    : labelFormula
    ? `${item.label} · ${labelFormula}`
    : item.label;
  drawLabelPill(ctx, x, y - 70, pillText, {
    pal,
    borderColor: item.hoveredActionLabel ? '#10b981' : isSelected ? '#3b82f6' : pal.badgeBorder,
    font: '600 10px system-ui, sans-serif',
    height: 17,
    itemId: item.id,
  });
  ctx.restore();
}

export function renderThermometer(ctx, item, isSelected, isDark, langCode = 'vi') {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const spec = APPARATUS.thermometer || { width: 24, height: 150 };
  if (item.isBroken) {
    renderBrokenToolShards(ctx, item, pal, isSelected, 34, spec.height);
    return;
  }
  const h = spec.height;
  const tilt = item.tiltAngle || 0;
  const tempK = Number.isFinite(item.measuredTempK) ? item.measuredTempK : item.tempK ?? 298.15;
  const tempC = tempK - 273.15;
  const frac = Math.max(0.05, Math.min(1, (tempC + 50) / 500)); // -50..450 C

  ctx.save();
  if (Math.abs(tilt) > 0.01) {
    ctx.translate(x, y);
    ctx.rotate(tilt);
    ctx.translate(-x, -y);
  }
  drawSelectionGlow(ctx, isSelected, false);

  const topY = y - h / 2 + 8;
  const botY = y + h / 2 - 12;
  const stemTop = topY + 6;
  const stemBot = botY - 8;

  // Outer glass sheath
  ctx.fillStyle = isDark ? 'rgba(226, 232, 240, 0.14)' : 'rgba(255, 255, 255, 0.72)';
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.roundRect(x - 5.5, stemTop, 11, stemBot - stemTop + 6, 5.5);
  ctx.fill();
  ctx.stroke();

  // Scale backing strip & crisp tick marks
  ctx.fillStyle = isDark ? 'rgba(248, 250, 252, 0.88)' : '#f8fafc';
  ctx.fillRect(x - 2.5, stemTop + 6, 5, stemBot - stemTop - 6);
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 0.8;
  for (let i = 0; i <= 10; i++) {
    const ty = stemBot - 6 - (i / 10) * (stemBot - stemTop - 16);
    ctx.beginPath();
    ctx.moveTo(x - 4.5, ty);
    ctx.lineTo(x + (i % 5 === 0 ? 4.2 : 1.8), ty);
    ctx.stroke();
  }

  // Red alcohol/spirit column & sensing bulb
  const fillCol = tempC >= 120 ? '#ef4444' : tempC <= 5 ? '#38bdf8' : '#e11d48';
  const colBot = stemBot - 4;
  const colTop = stemBot - 8 - frac * (stemBot - stemTop - 18);
  ctx.strokeStyle = fillCol;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, colBot);
  ctx.lineTo(x, colTop);
  ctx.stroke();

  // Sensing bulb at bottom
  ctx.fillStyle = fillCol;
  ctx.strokeStyle = isSelected ? '#3b82f6' : pal.glassStroke;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.arc(x, botY + 3, 6.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Live crisp temperature readout pill
  const tagText = `${item.label} · ${tempC.toFixed(1)}°C`;
  drawLabelPill(ctx, x, topY - 11, tagText, {
    pal,
    borderColor: isSelected ? '#3b82f6' : tempC >= 80 ? '#f97316' : tempC <= 5 ? '#38bdf8' : pal.badgeBorder,
    font: '700 10px ui-monospace, monospace',
    height: 17,
    itemId: item.id,
  });
  ctx.restore();
}

export function renderRubberStopper(ctx, item, isSelected, isDark, connectedFromVessel = null) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const orient = item._attachOrient || 'top';
  const mode = item.stopperMode || 'holed';
  const isSolid = mode === 'solid';
  const isDual = mode === 'dual_hole';

  // Dynamically match host vessel's actual glass neck inner width so large flasks (e.g. erlenmeyer_1000) seal flush
  let neckHalfPx = 10;
  if (connectedFromVessel) {
    const vSpec = APPARATUS[connectedFromVessel.typeId];
    if (vSpec) {
      if (vSpec.isHorizontalTube) {
        neckHalfPx = (vSpec.height || 30) * 0.42;
      } else if (vSpec.isUTube) {
        neckHalfPx = vSpec.tubeOuterR || 13;
      } else if (vSpec.geometry?.profilePoints?.length >= 2) {
        const pts = vSpec.geometry.profilePoints;
        const maxR = Math.max(...pts.map((p) => p[1]), 0.1);
        const neckCm = pts[pts.length - 2][1];
        neckHalfPx = Math.max(9.5, (neckCm / maxR) * (vSpec.width / 2 - 2));
      } else {
        neckHalfPx = Math.max(9.5, (vSpec.neckRadius || 14) - 1.5);
      }
    }
  }
  const botHalf = Math.max(10, neckHalfPx + 0.8);
  const topHalf = botHalf + 3.8;

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  ctx.save();
  ctx.translate(x, y);
  if (item._tiltRad) ctx.rotate(item._tiltRad);
  if (orient === 'left') ctx.rotate(-Math.PI / 2);
  else if (orient === 'right') ctx.rotate(Math.PI / 2);
  else if (orient === 'bottom') ctx.rotate(Math.PI);

  // Tapered EPDM rubber bung body
  ctx.fillStyle = isDark ? '#334155' : '#475569';
  ctx.strokeStyle = isSelected ? '#3b82f6' : '#0f172a';
  ctx.lineWidth = isSelected ? 2 : 1.25;
  ctx.beginPath();
  ctx.moveTo(-topHalf, -9);
  ctx.lineTo(topHalf, -9);
  ctx.lineTo(botHalf, 9);
  ctx.lineTo(-botHalf, 9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Top bevel rib
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-(topHalf - 1.5), -6.5);
  ctx.lineTo(topHalf - 1.5, -6.5);
  ctx.stroke();

  if (!isSolid) {
    const tubeX = isDual ? 6 : 0;
    if (isDual) {
      // Left bore sleeve for Separatory / Dropping Funnel stem
      ctx.fillStyle = connectedFromVessel?._hasMountedSepFunnel ? 'rgba(56, 189, 248, 0.35)' : pal.glassFill;
      ctx.strokeStyle = connectedFromVessel?._hasMountedSepFunnel ? '#38bdf8' : pal.glassStroke;
      ctx.lineWidth = 1.2;
      ctx.fillRect(-9, -11, 6, 20);
      ctx.strokeRect(-9, -11, 6, 20);
    }

    // Glass bore tube stub + amber tubing connector ring on outer crown
    ctx.fillStyle = pal.glassFill;
    ctx.strokeStyle = pal.glassStroke;
    ctx.lineWidth = 1.2;
    ctx.fillRect(tubeX - 3.2, -13, 6.4, 22);
    ctx.strokeRect(tubeX - 3.2, -13, 6.4, 22);

    const isConn = Boolean(
      connectedFromVessel &&
      (connectedFromVessel.connectedTargetId || connectedFromVessel.connectedSyringeId) &&
      (!item.attachedSide || item.attachedSide === 'main' || connectedFromVessel.connectedPortSide === item.attachedSide)
    );
    ctx.fillStyle = isConn ? '#f59e0b' : pal.badgeBg;
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(tubeX, -10, 4.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();

  const modeTag = isDual ? '2-Hole' : !isSolid ? '1-Hole' : 'Solid';
  drawLabelPill(ctx, x, y - 22, `${item.label} · ${modeTag}`, {
    pal,
    borderColor: isSelected ? '#3b82f6' : null,
    font: '600 10px system-ui, sans-serif',
    height: 17,
    itemId: item.id,
  });
  ctx.restore();
}

export function renderPhenCotton(ctx, item, isSelected, isDark) {
  const pal = getThemePalette(isDark);
  const { x, y } = item;
  const lvl = Math.max(0, Math.min(1, item.pinkLevel || 0));
  const r = Math.round(244 * lvl + 248 * (1 - lvl));
  const g = Math.round(114 * lvl + 250 * (1 - lvl));
  const b = Math.round(182 * lvl + 252 * (1 - lvl));

  ctx.save();
  if (item._tiltRad) {
    ctx.translate(x, y);
    ctx.rotate(item._tiltRad);
    ctx.translate(-x, -y);
  }
  drawSelectionGlow(ctx, isSelected, false);
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.strokeStyle = isSelected ? '#3b82f6' : lvl > 0.25 ? '#ec4899' : '#94a3b8';
  ctx.lineWidth = isSelected ? 2 : 1.15;

  // Scalloped fluffy cotton wad silhouette
  ctx.beginPath();
  ctx.arc(x - 6, y + 1, 6.5, Math.PI * 0.5, Math.PI * 1.6);
  ctx.arc(x, y - 3, 7.2, Math.PI * 1.0, Math.PI * 2.0);
  ctx.arc(x + 6, y + 1, 6.5, Math.PI * 1.4, Math.PI * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const statusTxt = lvl > 0.28 ? `${item.label} · 🌸 NH₃` : `${item.label} · ${Math.round((item.dampness ?? 0.85) * 100)}%`;
  drawLabelPill(ctx, x, y - 19, statusTxt, {
    pal,
    borderColor: isSelected ? '#3b82f6' : lvl > 0.28 ? '#ec4899' : null,
    font: '600 10px system-ui, sans-serif',
    height: 17,
    itemId: item.id,
  });
  ctx.restore();
}

const BATH_ASSET_IMG_CACHE = new Map();
function getBathMilestoneImage(tempC) {
  if (typeof Image === 'undefined') return null;
  const steps = APPARATUS.ice_bath?.bathTempSteps || [-20, -10, 0, 10, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200];
  let nearest = steps[0];
  let bestD = Infinity;
  for (const s of steps) {
    const d = Math.abs(s - tempC);
    if (d < bestD) { bestD = d; nearest = s; }
  }
  const key = `./assets/baths/bath_${nearest}.svg`;
  if (!BATH_ASSET_IMG_CACHE.has(key)) {
    const img = new Image();
    img.src = key;
    BATH_ASSET_IMG_CACHE.set(key, img);
  }
  const cached = BATH_ASSET_IMG_CACHE.get(key);
  return cached && cached.complete && cached.naturalWidth > 0 ? cached : null;
}

export function renderIceBath(ctx, item, isSelected, isDark, timeNow = 0, langCode = 'vi') {
  const pal = getThemePalette(isDark);
  const spec = APPARATUS[item.typeId] || { width: 146, height: 68 };
  const w = spec.width;
  const h = spec.height;
  if (item.isBroken) {
    renderBrokenToolShards(ctx, item, pal, isSelected, w, h);
    ctx.save();
    for (let i = 0; i < 4; i++) {
      const ix = item.x - 36 + i * 24;
      const iy = item.y + h / 2 - 5 + (i % 2) * 2;
      ctx.fillStyle = 'rgba(186, 230, 253, 0.78)';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(ix - 6, iy - 4, 12, 8, 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  const left = item.x - w / 2;
  const top = item.y - h / 2;
  const bathC = item.bathTargetC ?? (item.bathMode === 'ice_salt' ? -10 : 0);

  let borderCol = '#0ea5e9';
  let topCol = 'rgba(186, 230, 253, 0.56)';
  let botCol = 'rgba(125, 211, 252, 0.64)';
  let badgeTxtCol = isDark ? '#e0f2fe' : '#0369a1';
  let mediumTag = langCode === 'en' ? 'Ice Water' : 'Nước đá';
  if (bathC <= -15) {
    borderCol = '#6366f1';
    topCol = 'rgba(99, 102, 241, 0.62)';
    botCol = 'rgba(49, 46, 129, 0.76)';
    badgeTxtCol = '#c7d2fe';
    mediumTag = langCode === 'en' ? 'Cryostat' : 'Bể Cryo';
  } else if (bathC <= -5) {
    borderCol = '#38bdf8';
    topCol = 'rgba(56, 189, 248, 0.58)';
    botCol = 'rgba(30, 64, 175, 0.68)';
    badgeTxtCol = '#7dd3fc';
    mediumTag = langCode === 'en' ? 'Ice+NaCl' : 'Đá+Muối';
  } else if (bathC <= 5) {
    borderCol = '#0ea5e9';
    mediumTag = langCode === 'en' ? 'Pure Ice' : 'Nước đá';
  } else if (bathC <= 25) {
    borderCol = '#14b8a6';
    topCol = 'rgba(94, 234, 212, 0.42)';
    botCol = 'rgba(15, 118, 110, 0.56)';
    badgeTxtCol = isDark ? '#5eead4' : '#0f766e';
    mediumTag = langCode === 'en' ? 'Water Bath' : 'Bể nước';
  } else if (bathC <= 105) {
    const f = Math.min(1, (bathC - 25) / 75);
    borderCol = f > 0.5 ? '#f97316' : '#f59e0b';
    topCol = `rgba(251, 191, 36, ${(0.35 + f * 0.25).toFixed(2)})`;
    botCol = `rgba(217, 119, 6, ${(0.42 + f * 0.3).toFixed(2)})`;
    badgeTxtCol = isDark ? '#fde68a' : '#b45309';
    mediumTag = bathC >= 95 ? (langCode === 'en' ? 'Boiling H₂O' : 'Nước sôi') : (langCode === 'en' ? 'Warm H₂O' : 'Bể nước nóng');
  } else if (bathC <= 155) {
    borderCol = '#ea580c';
    topCol = 'rgba(245, 158, 11, 0.68)';
    botCol = 'rgba(146, 64, 14, 0.82)';
    badgeTxtCol = '#fed7aa';
    mediumTag = langCode === 'en' ? 'Silicone Oil' : 'Bể dầu Silicone';
  } else {
    borderCol = '#ef4444';
    topCol = 'rgba(249, 115, 22, 0.72)';
    botCol = 'rgba(124, 45, 18, 0.88)';
    badgeTxtCol = '#fecaca';
    mediumTag = langCode === 'en' ? 'Hot Oil' : 'Dầu cao nhiệt';
  }

  ctx.save();
  drawSelectionGlow(ctx, isSelected, false);

  // Outer insulated stainless / borosilicate tub
  const tubGrad = ctx.createLinearGradient(left, top, left + w, top);
  if (isDark) {
    tubGrad.addColorStop(0, '#1e293b');
    tubGrad.addColorStop(0.5, '#334155');
    tubGrad.addColorStop(1, '#1e293b');
  } else {
    tubGrad.addColorStop(0, '#cbd5e1');
    tubGrad.addColorStop(0.5, '#f1f5f9');
    tubGrad.addColorStop(1, '#cbd5e1');
  }

  ctx.fillStyle = tubGrad;
  ctx.strokeStyle = isSelected ? '#3b82f6' : borderCol;
  ctx.lineWidth = isSelected ? 2.4 : 1.75;
  ctx.beginPath();
  ctx.roundRect(left, top + 6, w, h - 6, [6, 6, 12, 12]);
  ctx.fill();
  ctx.stroke();

  // Inner thermal bath medium (fallback gradient + per-milestone SVG asset texture)
  const liqGrad = ctx.createLinearGradient(0, top + 12, 0, top + h - 4);
  liqGrad.addColorStop(0, topCol);
  liqGrad.addColorStop(1, botCol);
  ctx.fillStyle = liqGrad;
  ctx.beginPath();
  ctx.roundRect(left + 6, top + 12, w - 12, h - 18, [3, 3, 9, 9]);
  ctx.fill();

  const milestoneImg = getBathMilestoneImage(bathC);
  if (milestoneImg) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.roundRect(left + 6, top + 12, w - 12, h - 18, [3, 3, 9, 9]);
    ctx.clip();
    ctx.drawImage(milestoneImg, left, top - 4, w, h + 4);
    ctx.restore();
  }

  // Animated milestone-specific thermal features
  if (bathC <= 5) {
    const nCubes = bathC <= -15 ? 4 : 6;
    for (let i = 0; i < nCubes; i++) {
      const cx = left + 18 + i * 21 + Math.sin(timeNow * 1.4 + i) * 1.5;
      const cy = top + 17 + (i % 2) * 5 + Math.cos(timeNow * 1.1 + i * 2) * 1.2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((i % 3 - 1) * 0.22);
      ctx.fillStyle = bathC <= -5 ? 'rgba(224, 242, 254, 0.86)' : 'rgba(255, 255, 255, 0.84)';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(-7, -5, 14, 10, 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  } else if (bathC <= 55) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.lineWidth = 1.2;
    for (let r = 0; r < 2; r++) {
      const ry = top + 20 + r * 9 + Math.sin(timeNow * 2 + r) * 1.2;
      ctx.beginPath();
      ctx.moveTo(left + 14, ry);
      ctx.quadraticCurveTo(item.x, ry - 3, left + w - 14, ry);
      ctx.stroke();
    }
  } else {
    // Glowing immersion coil at bottom + bubbles (water 60-100C) or oil waves (>100C)
    const glowAlpha = Math.min(0.95, 0.4 + (bathC - 50) / 160);
    ctx.strokeStyle = bathC > 130 ? `rgba(239, 68, 68, ${glowAlpha})` : `rgba(249, 115, 22, ${glowAlpha})`;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(left + 20, top + h - 10);
    ctx.lineTo(left + w - 20, top + h - 10);
    ctx.stroke();

    if (bathC <= 105) {
      const nBub = Math.min(10, 2 + Math.floor((bathC - 55) / 8));
      ctx.fillStyle = 'rgba(255, 255, 255, 0.68)';
      for (let b = 0; b < nBub; b++) {
        const bx = left + 18 + ((b * 17) % (w - 36));
        const by = top + h - 12 - ((timeNow * (14 + b * 2) + b * 9) % (h - 24));
        ctx.beginPath();
        ctx.arc(bx, by, 1.5 + (b % 2) * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Silicone oil thermal convection shimmer
      ctx.strokeStyle = 'rgba(254, 240, 138, 0.55)';
      ctx.lineWidth = 1.3;
      for (let wv = 0; wv < 2; wv++) {
        const wy = top + 21 + wv * 10 + Math.sin(timeNow * 2.4 + wv) * 1.5;
        ctx.beginPath();
        ctx.moveTo(left + 15, wy);
        ctx.quadraticCurveTo(item.x, wy - 3.5, left + w - 15, wy);
        ctx.stroke();
      }
    }

    // Rising steam / thermal heat haze above rim
    ctx.strokeStyle = bathC > 105 ? 'rgba(251, 146, 60, 0.45)' : 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1.6;
    for (let s = 0; s < 4; s++) {
      const sx = left + 26 + s * 30 + Math.sin(timeNow * 2.2 + s) * 3;
      const sy = top + 2 - ((timeNow * 14 + s * 6) % 12);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(sx - 3, sy - 5, sx + 1, sy - 10);
      ctx.stroke();
    }
  }

  // Rim bevel highlight
  ctx.strokeStyle = isDark ? 'rgba(226, 232, 240, 0.45)' : 'rgba(100, 116, 139, 0.55)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.roundRect(left - 2, top + 3, w + 4, 8, 4);
  ctx.stroke();

  // Subzero condensation fog wisps & frost crystals
  if (bathC <= -5) {
    ctx.fillStyle = 'rgba(224, 242, 254, 0.28)';
    for (let f = 0; f < 4; f++) {
      const fx = left + 22 + f * 32 + Math.sin(timeNow * 0.9 + f) * 4;
      const fy = top + 4 - ((timeNow * 6 + f * 3) % 10);
      ctx.beginPath();
      ctx.arc(fx, fy, 8 + (f % 2) * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(240, 249, 255, 0.85)';
    ctx.lineWidth = 1.1;
    for (let c = 0; c < 4; c++) {
      const fx = left + 18 + c * 34;
      const fy = top + h - 10;
      ctx.beginPath();
      ctx.moveTo(fx - 3, fy);
      ctx.lineTo(fx + 3, fy);
      ctx.moveTo(fx, fy - 3);
      ctx.lineTo(fx, fy + 3);
      ctx.stroke();
    }
  }

  // Front digital thermostat badge
  ctx.fillStyle = isDark ? 'rgba(15, 23, 42, 0.86)' : 'rgba(15, 23, 42, 0.82)';
  ctx.strokeStyle = borderCol;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.roundRect(item.x - 36, item.y + 4, 72, 16, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = badgeTxtCol;
  ctx.font = 'bold 10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatCanvasText(`${bathC}°C · ${bathC > 105 ? 'OIL' : bathC <= 0 ? 'ICE' : 'H₂O'}`), item.x, item.y + 12);

  drawLabelPill(ctx, item.x, top - 14, `${item.label} · ${bathC}°C · ${mediumTag}`, {
    pal,
    borderColor: isSelected ? '#3b82f6' : borderCol,
    font: '600 10px system-ui, sans-serif',
    height: 17,
    itemId: item.id,
  });
  ctx.restore();
}
