import { STARTER_REAGENTS } from '../data/species.js';

const _dragGhostCache = new Map();
let _ghostHostEl = null;

function getGhostHost() {
  if (typeof document === 'undefined') return null;
  if (!_ghostHostEl) {
    _ghostHostEl = document.createElement('div');
    _ghostHostEl.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:200px;height:200px;pointer-events:none;opacity:0.99;overflow:visible;';
    document.body.appendChild(_ghostHostEl);
  }
  return _ghostHostEl;
}

/**
 * Draw detailed, realistically sized, color-accurate stock chemical bottle/jar centered at (cx, cy).
 * Base dimensions at scale=1 match ISO 70-85mm bench vessels (~78x126 px).
 */
export function drawReagentBottle(ctx, reg, cx, cy, scale = 1.0, opts = {}) {
  if (!reg) return;
  const { tiltRad = 0, uncapped = false, labelAlpha = 1.0, isDark = true } = opts;

  ctx.save();
  ctx.translate(cx, cy);
  if (tiltRad) ctx.rotate(tiltRad);
  ctx.scale(scale, scale);

  const style = reg.bottleStyle || {};
  const isLiquid = reg.kind === 'liquid';
  const vesselForm = style.vesselForm || (isLiquid ? 'winchester' : 'jar');
  const glassMat = style.glassMaterial || 'clear';
  const isDropper = vesselForm === 'dropper';
  const isAmber = glassMat === 'amber';
  const isHDPE = glassMat === 'hdpe';

  const w = isDropper ? 52 : isLiquid ? 76 : 78;
  const h = isDropper ? 106 : isLiquid ? 132 : 114;
  const left = -w / 2;
  const top = -h / 2;
  const bottom = h / 2;

  // Body dimensions
  const shoulderY = top + (isLiquid ? 34 : 22);
  const neckW = isDropper ? 16 : isLiquid ? 22 : 42;

  // 1. Bottle / Jar Glass or HDPE Silhouette
  ctx.beginPath();
  if (vesselForm === 'winchester') {
    // Classic narrow-mouth sloped shoulder Winchester reagent bottle
    ctx.moveTo(-neckW / 2, top + 12);
    ctx.lineTo(neckW / 2, top + 12);
    ctx.lineTo(neckW / 2, shoulderY - 12);
    ctx.quadraticCurveTo(w * 0.48, shoulderY - 2, w / 2, shoulderY + 12);
    ctx.lineTo(w / 2, bottom - 8);
    ctx.quadraticCurveTo(w / 2, bottom, w / 2 - 8, bottom);
    ctx.lineTo(left + 8, bottom);
    ctx.quadraticCurveTo(left, bottom, left, bottom - 8);
    ctx.lineTo(left, shoulderY + 12);
    ctx.quadraticCurveTo(left * 0.96, shoulderY - 2, -neckW / 2, shoulderY - 12);
    ctx.closePath();
  } else {
    // Cylindrical dropper bottle or wide-mouth solid reagent jar
    ctx.moveTo(-neckW / 2, top + 12);
    ctx.lineTo(neckW / 2, top + 12);
    ctx.lineTo(neckW / 2, shoulderY - 4);
    ctx.lineTo(w / 2, shoulderY + 4);
    ctx.lineTo(w / 2, bottom - 8);
    ctx.quadraticCurveTo(w / 2, bottom, w / 2 - 8, bottom);
    ctx.lineTo(left + 8, bottom);
    ctx.quadraticCurveTo(left, bottom, left, bottom - 8);
    ctx.lineTo(left, shoulderY + 4);
    ctx.lineTo(-neckW / 2, shoulderY - 4);
    ctx.closePath();
  }

  // Fill material (amber glass, milky caustic HDPE, or clear borosilicate)
  if (isAmber) {
    const ambGrad = ctx.createLinearGradient(left, 0, w / 2, 0);
    ambGrad.addColorStop(0, 'rgba(120, 53, 15, 0.88)');
    ambGrad.addColorStop(0.35, 'rgba(180, 83, 9, 0.72)');
    ambGrad.addColorStop(0.75, 'rgba(146, 64, 14, 0.80)');
    ambGrad.addColorStop(1, 'rgba(92, 40, 12, 0.92)');
    ctx.fillStyle = ambGrad;
  } else if (isHDPE) {
    const hdpeGrad = ctx.createLinearGradient(left, 0, w / 2, 0);
    hdpeGrad.addColorStop(0, 'rgba(226, 232, 240, 0.82)');
    hdpeGrad.addColorStop(0.35, 'rgba(248, 250, 252, 0.94)');
    hdpeGrad.addColorStop(0.85, 'rgba(203, 213, 225, 0.85)');
    hdpeGrad.addColorStop(1, 'rgba(148, 163, 184, 0.90)');
    ctx.fillStyle = hdpeGrad;
  } else {
    const glassGrad = ctx.createLinearGradient(left, 0, w / 2, 0);
    glassGrad.addColorStop(0, 'rgba(224, 242, 254, 0.22)');
    glassGrad.addColorStop(0.28, 'rgba(255, 255, 255, 0.14)');
    glassGrad.addColorStop(0.75, 'rgba(186, 230, 253, 0.18)');
    glassGrad.addColorStop(1, 'rgba(148, 163, 184, 0.28)');
    ctx.fillStyle = glassGrad;
  }
  ctx.fill();

  // Clip interior for chemical contents
  ctx.save();
  ctx.clip();

  const fillTop = bottom - (bottom - shoulderY) * 0.68;
  const contentsKind = style.contentsKind || (isLiquid ? 'liquid' : 'pellets');
  if (isLiquid) {
    const liqGrad = ctx.createLinearGradient(0, fillTop, 0, bottom);
    liqGrad.addColorStop(0, style.liquidGradTop || 'rgba(125, 211, 252, 0.42)');
    liqGrad.addColorStop(1, style.liquidGradBottom || 'rgba(56, 189, 248, 0.62)');
    ctx.fillStyle = liqGrad;
    ctx.fillRect(left, fillTop, w, bottom - fillTop);
    if (style.isFuming) {
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = 'rgba(248, 250, 252, 0.28)';
        ctx.beginPath();
        ctx.arc(-10 + i * 7, fillTop - 10 - (i % 2) * 5, 5 + i * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (style.hasDropperTube) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(0, shoulderY - 4);
      ctx.lineTo(0, bottom - 12);
      ctx.stroke();
    } else {
      ctx.strokeStyle = style.isFuming ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.65)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(left + 4, fillTop);
      ctx.quadraticCurveTo(0, fillTop + 3, w / 2 - 4, fillTop);
      ctx.stroke();
    }
  } else if (contentsKind === 'oil_blocks') {
    const oilTop = shoulderY + 14;
    const oilGrad = ctx.createLinearGradient(0, oilTop, 0, bottom);
    oilGrad.addColorStop(0, 'rgba(254, 240, 138, 0.34)');
    oilGrad.addColorStop(1, 'rgba(234, 179, 8, 0.44)');
    ctx.fillStyle = oilGrad;
    ctx.fillRect(left, oilTop, w, bottom - oilTop);
    ctx.fillStyle = '#e2e8f0';
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.rect(-14, bottom - 28, 17, 17);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = style.solidColor || '#cbd5e1';
    ctx.beginPath();
    ctx.rect(2, bottom - 22, 14, 13);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(254, 249, 195, 0.72)';
    ctx.beginPath();
    ctx.moveTo(left + 4, oilTop);
    ctx.lineTo(w / 2 - 4, oilTop);
    ctx.stroke();
  } else if (contentsKind === 'blue_crystals') {
    const crystals = [
      [-18, bottom - 14, 11, style.solidColor || '#0284c7'],
      [-3, bottom - 18, 13, '#0369a1'],
      [14, bottom - 13, 10, '#0ea5e9'],
      [-10, bottom - 28, 9, '#38bdf8'],
      [7, bottom - 27, 10, style.solidColor || '#0284c7'],
      [0, bottom - 8, 12, '#0369a1'],
    ];
    for (const [gx, gy, r, col] of crystals) {
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(gx * 0.12);
      ctx.beginPath();
      ctx.moveTo(-r, -r * 0.35);
      ctx.lineTo(r * 0.35, -r * 0.85);
      ctx.lineTo(r, r * 0.35);
      ctx.lineTo(-r * 0.25, r * 0.75);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = '#bae6fd';
      ctx.lineWidth = 1.0;
      ctx.stroke();
      ctx.restore();
    }
  } else if (contentsKind === 'granules') {
    const granules = [
      [-17, bottom - 12, 8],
      [-5, bottom - 16, 10],
      [9, bottom - 13, 9],
      [19, bottom - 10, 7],
      [-11, bottom - 25, 8],
      [4, bottom - 24, 9],
    ];
    for (const [gx, gy, r] of granules) {
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(gx * 0.2);
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.lineTo(-r * 0.4, -r * 0.8);
      ctx.lineTo(r * 0.7, -r * 0.5);
      ctx.lineTo(r, r * 0.45);
      ctx.lineTo(-r * 0.2, r * 0.78);
      ctx.closePath();
      ctx.fillStyle = style.solidColor || '#94a3b8';
      ctx.fill();
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.restore();
    }
  } else if (contentsKind === 'white_crystals') {
    for (let i = 0; i < 9; i++) {
      const gx = -20 + (i % 4) * 12 + (i > 4 ? 4 : 0);
      const gy = bottom - 10 - Math.floor(i / 4) * 11;
      ctx.fillStyle = 'rgba(248, 250, 252, 0.72)';
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 0.8;
      ctx.fillRect(gx - 4, gy - 4, 8, 7);
      ctx.strokeRect(gx - 4, gy - 4, 8, 7);
    }
  } else {
    // Pellets / granular solid silhouette
    for (let i = 0; i < 10; i++) {
      const gx = -18 + (i % 4) * 12;
      const gy = bottom - 10 - Math.floor(i / 4) * 10;
      ctx.fillStyle = style.solidColor || '#ffffff';
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(gx, gy, 5.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Printed Lab Chemical Label Band across center of bottle
  if (labelAlpha > 0.05) {
    const labY = shoulderY + 18;
    const labH = 30;
    const labW = w - 10;
    ctx.fillStyle = 'rgba(248, 250, 252, 0.92)';
    ctx.fillRect(-labW / 2, labY, labW, labH);
    ctx.fillStyle = style.accentColor || '#0ea5e9';
    ctx.fillRect(-labW / 2, labY, labW, 5);
    ctx.fillStyle = '#0f172a';
    ctx.font = `bold ${isDropper ? 9.5 : 11}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.shortLabel || reg.formula, 0, labY + 18);
  }

  // Vertical glass specular reflection highlight
  if (!isHDPE) {
    const specGrad = ctx.createLinearGradient(left + 5, 0, left + 16, 0);
    specGrad.addColorStop(0, 'rgba(255,255,255,0)');
    specGrad.addColorStop(0.5, 'rgba(255,255,255,0.42)');
    specGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = specGrad;
    ctx.fillRect(left + 5, shoulderY + 2, 11, bottom - shoulderY - 8);
  }
  ctx.restore();

  // 2. Outer Rim Stroke
  ctx.strokeStyle = style.rimStrokeColor || (isAmber ? '#b45309' : isHDPE || isDark ? '#94a3b8' : '#475569');
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  if (vesselForm === 'winchester') {
    ctx.moveTo(-neckW / 2, top + 12);
    ctx.lineTo(neckW / 2, top + 12);
    ctx.lineTo(neckW / 2, shoulderY - 12);
    ctx.quadraticCurveTo(w * 0.48, shoulderY - 2, w / 2, shoulderY + 12);
    ctx.lineTo(w / 2, bottom - 8);
    ctx.quadraticCurveTo(w / 2, bottom, w / 2 - 8, bottom);
    ctx.lineTo(left + 8, bottom);
    ctx.quadraticCurveTo(left, bottom, left, bottom - 8);
    ctx.lineTo(left, shoulderY + 12);
    ctx.quadraticCurveTo(left * 0.96, shoulderY - 2, -neckW / 2, shoulderY - 12);
    ctx.closePath();
  } else {
    ctx.moveTo(-neckW / 2, top + 12);
    ctx.lineTo(neckW / 2, top + 12);
    ctx.lineTo(neckW / 2, shoulderY - 4);
    ctx.lineTo(w / 2, shoulderY + 4);
    ctx.lineTo(w / 2, bottom - 8);
    ctx.quadraticCurveTo(w / 2, bottom, w / 2 - 8, bottom);
    ctx.lineTo(left + 8, bottom);
    ctx.quadraticCurveTo(left, bottom, left, bottom - 8);
    ctx.lineTo(left, shoulderY + 4);
    ctx.lineTo(-neckW / 2, shoulderY - 4);
    ctx.closePath();
  }
  ctx.stroke();

  // 3. Screw Cap or Dropper Pipette Bulb (omitted if uncapped during scooping/pouring!)
  if (!uncapped) {
    if (isDropper) {
      ctx.fillStyle = '#334155';
      ctx.fillRect(-neckW / 2 - 2, top + 8, neckW + 4, 8);
      ctx.fillStyle = style.capColor || '#ec4899';
      ctx.beginPath();
      ctx.roundRect(-6, top - 6, 12, 15, 6);
      ctx.fill();
    } else {
      ctx.fillStyle = style.capColor || '#334155';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(-neckW / 2 - 2, top - 2, neckW + 4, 15, 3);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      for (let rx = -neckW / 2 + 2; rx <= neckW / 2 - 2; rx += 5) {
        ctx.beginPath();
        ctx.moveTo(rx, top);
        ctx.lineTo(rx, top + 11);
        ctx.stroke();
      }
    }
  } else {
    ctx.fillStyle = 'rgba(224, 242, 254, 0.5)';
    ctx.strokeStyle = isAmber ? '#b45309' : '#94a3b8';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(-neckW / 2 - 3, top + 9, neckW + 6, 5, 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Create/return high-DPI offscreen canvas showing full-size reagent bottle for cursor drag ghost.
 */
export function getReagentDragCanvas(reagentId) {
  const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
  if (!reg) return null;
  if (_dragGhostCache.has(reagentId)) {
    return _dragGhostCache.get(reagentId);
  }
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  const cssW = 96;
  const cssH = 148;
  canvas.width = cssW * 2;
  canvas.height = cssH * 2;
  canvas.style.cssText = `width:${cssW}px;height:${cssH}px;display:block;`;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  drawReagentBottle(ctx, reg, cssW / 2, cssH / 2 + 2, 1.0, {
    tiltRad: -0.18,
    uncapped: true,
    isDark: true,
  });

  const host = getGhostHost();
  if (host) host.appendChild(canvas);
  _dragGhostCache.set(reagentId, canvas);
  return canvas;
}

/**
 * Render active dispensing animation above target vessel:
 * - Liquids: Full-size tilted bottle pouring gently down an inclined glass stirring rod (đũa thủy tinh)
 * - Solids: Full-size open bottle/jar + glass lab spoon (thìa thủy tinh) dipping, scooping & dropping solids
 */
export function renderActiveReagentTransfer(ctx, anim, targetVessel, spec, bottomY, isDark, timeNow) {
  if (!anim || !targetVessel || targetVessel.isShattered) return;
  const reg = STARTER_REAGENTS.find((r) => r.id === anim.reagentId);
  if (!reg) return;

  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const progress = Math.max(0, Math.min(1, (nowMs - anim.startMs) / Math.max(1, anim.durationMs)));

  const rimY = targetVessel.y - spec.height / 2;
  const mouthHalf = Math.max(10, spec.neckRadius || spec.width * 0.4);
  const rodBottomX = targetVessel.x - Math.min(12, mouthHalf * 0.35);
  const rodBottomY = Math.min(bottomY - 8, targetVessel.y + spec.height * 0.32);
  const rodTopX = targetVessel.x + Math.min(18, mouthHalf * 0.65) + 12;
  const rodTopY = rimY - 36;

  ctx.save();

  if (!anim.isSolid) {
    // 1) Draw inclined Borosilicate glass stirring rod resting down into the vessel
    const rodAlpha = progress < 0.12 ? progress / 0.12 : progress > 0.85 ? (1 - progress) / 0.15 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, rodAlpha));

    // Glass rod outer body & bright refraction core
    ctx.lineCap = 'round';
    ctx.strokeStyle = isDark ? 'rgba(224, 242, 254, 0.55)' : 'rgba(100, 116, 139, 0.55)';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(rodTopX, rodTopY);
    ctx.lineTo(rodBottomX, rodBottomY);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(rodTopX - 0.6, rodTopY + 1);
    ctx.lineTo(rodBottomX - 0.6, rodBottomY - 2);
    ctx.stroke();

    // 2) Full-size reagent bottle tilted nicely just above glass rod upper shaft
    const pourAngle = -0.68 - Math.sin(progress * Math.PI) * 0.18;
    const bottleCx = rodTopX + 52;
    const bottleCy = rodTopY - 22;
    drawReagentBottle(ctx, reg, bottleCx, bottleCy, 0.86, {
      tiltRad: pourAngle,
      uncapped: true,
      isDark,
    });

    // 3) Smooth laminar stream pouring from bottle neck onto glass rod & gliding down rod shaft!
    if (progress > 0.12 && progress < 0.90) {
      const flowAlpha = Math.min(1, Math.sin(((progress - 0.12) / 0.78) * Math.PI) * 1.4);
      const lipX = rodTopX + 10;
      const lipY = rodTopY - 6;
      const hitRodX = rodTopX * 0.78 + rodBottomX * 0.22;
      const hitRodY = rodTopY * 0.78 + rodBottomY * 0.22;
      const style = reg.bottleStyle || {};
      const streamCol = style.streamColor || 'rgba(125, 211, 252, 0.84)';

      ctx.globalAlpha = flowAlpha * 0.9;
      ctx.strokeStyle = streamCol;
      ctx.lineWidth = style.streamWidth || 3.4;
      ctx.beginPath();
      // Curve from lip to rod, then track cleanly along the rod shaft to bottom!
      ctx.moveTo(lipX, lipY);
      ctx.quadraticCurveTo(lipX - 4, lipY + 10, hitRodX, hitRodY);
      ctx.lineTo(rodBottomX, rodBottomY);
      ctx.stroke();

      // Glint bead sliding gently down the glass rod
      const beadT = ((timeNow * 2.8) % 1);
      const bx = hitRodX + (rodBottomX - hitRodX) * beadT;
      const by = hitRodY + (rodBottomY - hitRodY) * beadT;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(bx, by, 2.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else {
    // SOLID REAGENT: Full-size open jar nearby + Glass Laboratory Spoon scooping & dispensing!
    const fadeAlpha = progress < 0.1 ? progress / 0.1 : progress > 0.88 ? (1 - progress) / 0.12 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, fadeAlpha));

    const jarCx = targetVessel.x + Math.max(84, spec.width * 0.72);
    const jarCy = rimY - 12;
    drawReagentBottle(ctx, reg, jarCx, jarCy, 0.88, {
      tiltRad: -0.08,
      uncapped: true,
      isDark,
    });

    // Double-beat scoop animation: 0..0.42 dip/scoop from jar, 0.42..0.72 carry to mouth, 0.72..1.0 tilt & drop
    let spoonTipX = jarCx;
    let spoonTipY = jarCy - 40;
    let spoonTilt = 0.25;
    let hasLoad = true;
    if (progress < 0.42) {
      const p = progress / 0.42;
      const dip = Math.sin(p * Math.PI);
      spoonTipX = jarCx - 4 * (1 - p);
      spoonTipY = jarCy - 52 + dip * 44;
      spoonTilt = 0.35 - dip * 0.55;
      hasLoad = p > 0.45;
    } else if (progress < 0.74) {
      const p = (progress - 0.42) / 0.32;
      const ease = p * p * (3 - 2 * p);
      spoonTipX = jarCx + (targetVessel.x - jarCx) * ease;
      spoonTipY = (jarCy - 52) * (1 - ease) + (rimY - 26) * ease - Math.sin(p * Math.PI) * 28;
      spoonTilt = -0.15;
      hasLoad = true;
    } else {
      const p = (progress - 0.74) / 0.26;
      spoonTipX = targetVessel.x;
      spoonTipY = rimY - 26;
      spoonTilt = -0.15 - Math.sin(p * Math.PI) * 1.15;
      hasLoad = p < 0.45;
    }

    // Draw Glass Lab Spoon / Micro-Scoopula
    ctx.save();
    ctx.translate(spoonTipX, spoonTipY);
    ctx.rotate(spoonTilt);
    // Long borosilicate spoon handle + bowl
    ctx.strokeStyle = isDark ? 'rgba(224, 242, 254, 0.78)' : 'rgba(71, 85, 105, 0.78)';
    ctx.fillStyle = isDark ? 'rgba(186, 230, 253, 0.32)' : 'rgba(148, 163, 184, 0.28)';
    ctx.lineWidth = 1.8;
    // Spoon handle extending upward-right
    ctx.beginPath();
    ctx.moveTo(8, -2);
    ctx.lineTo(68, -32);
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    // Spoon bowl
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(0, 0, 10, 4.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Solid crystals / metal / pellets scooped inside the glass spoon bowl
    const style = reg.bottleStyle || {};
    if (hasLoad) {
      ctx.fillStyle = style.solidColor || '#f8fafc';
      ctx.strokeStyle = style.solidStrokeColor || '#64748b';
      ctx.lineWidth = 0.8;
      const dotR = style.solidRadius || 3.0;
      for (let g = -1; g <= 1; g++) {
        ctx.beginPath();
        ctx.arc(g * 3.5, -2.5 - (1 - Math.abs(g)) * 1.5, dotR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    // Falling solid granules/crystals cascading down into vessel after spoon tilts
    if (progress >= 0.76) {
      const p = (progress - 0.76) / 0.24;
      const dropCol = style.solidDropColor || style.solidColor || '#f8fafc';
      const count = style.solidDropCount || 6;
      const isSquare = style.solidShape === 'square';
      for (let i = 0; i < count; i++) {
        const gp = Math.max(0, Math.min(1, p * 1.3 - i * 0.08));
        const gx = targetVessel.x + ((i - count / 2) * 4.5) * (0.4 + gp * 0.6);
        const gy = rimY - 18 + gp * (bottomY - rimY - 8);
        ctx.fillStyle = dropCol;
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        if (isSquare) {
          ctx.rect(gx - 4.5, gy - 4.5, 9, 9);
        } else {
          ctx.arc(gx, gy, 2.8, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  ctx.restore();
}
