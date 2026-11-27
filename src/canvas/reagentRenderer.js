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

function drawBottleMotifCanvas(ctx, motif, cx, cy) {
  if (!motif) return;
  ctx.save();
  ctx.translate(cx, cy);
  if (motif === 'grape') {
    ctx.strokeStyle = '#15803d';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.quadraticCurveTo(3, -13, 6, -11);
    ctx.stroke();
    const grapes = [[-3.5, -5], [0.5, -5.5], [4.5, -5], [-1.8, -1.5], [2.2, -1.5], [0.2, 2.5]];
    for (const [gx, gy] of grapes) {
      ctx.fillStyle = '#7c3aed';
      ctx.strokeStyle = '#c4b5fd';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.arc(gx, gy, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  } else if (motif === 'honey') {
    ctx.fillStyle = '#f59e0b';
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.roundRect(-5, -6, 10, 9, 3.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fde047';
    ctx.beginPath();
    ctx.ellipse(0, -6, 5.2, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(4, 5, 1.8, 0, Math.PI * 2);
    ctx.fill();
  } else if (motif === 'sugarcane') {
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 3.0;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-4, 6);
    ctx.lineTo(2, -9);
    ctx.moveTo(1, 7);
    ctx.lineTo(6.5, -7);
    ctx.stroke();
    ctx.strokeStyle = '#dcfce7';
    ctx.lineWidth = 1.0;
    for (const [nx, ny] of [[-2.2, 1.5], [-0.4, -3], [3, 2], [4.8, -2.5]]) {
      ctx.beginPath();
      ctx.moveTo(nx - 1.5, ny - 0.6);
      ctx.lineTo(nx + 1.5, ny + 0.6);
      ctx.stroke();
    }
  } else if (motif === 'benzene_ring') {
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 - Math.PI / 6;
      const px = Math.cos(a) * 6;
      const py = Math.sin(a) * 6;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 2.8, 0, Math.PI * 2);
    ctx.stroke();
  } else if (motif === 'skeletal_etoh') {
    // EtOH zig-zag skeletal formula: C-C-OH
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-10, 2.5);
    ctx.lineTo(-3, -2.5);
    ctx.lineTo(4, 2.5);
    ctx.stroke();
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 6.5px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('OH', 5, 2.5);
  } else if (motif === 'skeletal_methanol') {
    // MeOH skeletal bond + OH
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-9, 1.5);
    ctx.lineTo(-1, -2.5);
    ctx.stroke();
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 6.5px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('OH', 0, -2);
  } else if (motif === 'skeletal_ch3cooh') {
    // Acetic acid skeletal: C-C(=O)-OH
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-10, 3);
    ctx.lineTo(-2.5, -1);
    ctx.lineTo(4, 3);
    // Double bond =O up
    ctx.moveTo(-3.6, -1.2);
    ctx.lineTo(-3.6, -5.8);
    ctx.moveTo(-1.4, -1.2);
    ctx.lineTo(-1.4, -5.8);
    ctx.stroke();
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 6px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('O', -2.5, -7.8);
    ctx.textAlign = 'left';
    ctx.fillText('OH', 4.5, 3);
  } else if (motif === 'skeletal_hcooh') {
    // Formic acid H-C(=O)-OH
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-7, 2.5);
    ctx.lineTo(-1.5, -1);
    ctx.lineTo(4, 2.5);
    ctx.moveTo(-2.5, -1.2);
    ctx.lineTo(-2.5, -5.6);
    ctx.moveTo(-0.5, -1.2);
    ctx.lineTo(-0.5, -5.6);
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 6px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', -7.5, 2.5);
    ctx.fillStyle = '#dc2626';
    ctx.textAlign = 'center';
    ctx.fillText('O', -1.5, -7.6);
    ctx.textAlign = 'left';
    ctx.fillText('OH', 4.5, 2.5);
  } else if (motif === 'skeletal_hcho') {
    // Formaldehyde H2C=O
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-7, 3.5);
    ctx.lineTo(-1.5, -0.5);
    ctx.lineTo(4, 3.5);
    ctx.moveTo(-2.5, -0.8);
    ctx.lineTo(-2.5, -5.8);
    ctx.moveTo(-0.5, -0.8);
    ctx.lineTo(-0.5, -5.8);
    ctx.stroke();
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 6.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('O', -1.5, -7.6);
  } else if (motif === 'skeletal_glycerol') {
    // 3-carbon zig-zag with 3 -OH
    ctx.strokeStyle = '#0d9488';
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-8, 1);
    ctx.lineTo(-3, -3);
    ctx.lineTo(3, -3);
    ctx.lineTo(8, 1);
    ctx.moveTo(-8, 1);
    ctx.lineTo(-8, 4.5);
    ctx.moveTo(0, -3);
    ctx.lineTo(0, 1.5);
    ctx.moveTo(8, 1);
    ctx.lineTo(8, 4.5);
    ctx.stroke();
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 5.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('OH', -8, 7.2);
    ctx.fillText('OH', 0, 4.2);
    ctx.fillText('OH', 8, 7.2);
  } else if (motif === 'skeletal_glucose') {
    // 6-membered pyranose ring with ring O + C6-CH2OH branch
    ctx.strokeStyle = '#6d28d9';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(2, -5.2);
    ctx.lineTo(6.5, -2.5);
    ctx.lineTo(6.5, 3);
    ctx.lineTo(0, 6);
    ctx.lineTo(-6.5, 3);
    ctx.lineTo(-6.5, -2.5);
    ctx.lineTo(-2, -5.2);
    // -CH2OH substituent at C5 (-6.5, -2.5)
    ctx.moveTo(-6.5, -2.5);
    ctx.lineTo(-10.5, -6.5);
    ctx.stroke();
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 6px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('O', 0, -5.5);
    ctx.fillStyle = '#6d28d9';
    ctx.font = 'bold 5px system-ui, sans-serif';
    ctx.fillText('OH', -10.5, -8.2);
  } else if (motif === 'skeletal_fructose') {
    // 5-membered furanose ring with top ring O + CH2OH side arm
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(2.4, -4.5);
    ctx.lineTo(6.5, 0);
    ctx.lineTo(4, 5.2);
    ctx.lineTo(-4, 5.2);
    ctx.lineTo(-6.5, 0);
    ctx.lineTo(-2.4, -4.5);
    // -CH2OH at C5 (-6.5, 0)
    ctx.moveTo(-6.5, 0);
    ctx.lineTo(-10.5, -4);
    ctx.stroke();
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 6px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('O', 0, -5.4);
    ctx.fillStyle = '#b45309';
    ctx.font = 'bold 5px system-ui, sans-serif';
    ctx.fillText('OH', -10.5, -6.2);
  } else if (motif === 'skeletal_glycine') {
    // H2N-CH2-C(=O)OH skeletal
    ctx.strokeStyle = '#7e22ce';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-5.5, 2.5);
    ctx.lineTo(-0.5, -1);
    ctx.lineTo(4.5, 2.5);
    ctx.moveTo(-1.3, -1.2);
    ctx.lineTo(-1.3, -5.5);
    ctx.moveTo(0.4, -1.2);
    ctx.lineTo(0.4, -5.5);
    ctx.stroke();
    ctx.fillStyle = '#2563eb';
    ctx.font = 'bold 5.5px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('H₂N', -6, 2.5);
    ctx.fillStyle = '#dc2626';
    ctx.textAlign = 'center';
    ctx.fillText('O', -0.5, -7.3);
    ctx.textAlign = 'left';
    ctx.fillText('OH', 5, 2.5);
  } else if (motif === 'skeletal_alanine') {
    // CH3-CH(NH2)-C(=O)OH skeletal
    ctx.strokeStyle = '#6d28d9';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(-7.5, -1.5);
    ctx.lineTo(-2.5, 1.5);
    ctx.lineTo(2.5, -1.5);
    ctx.lineTo(6.8, 1.5);
    ctx.moveTo(-2.5, 1.5);
    ctx.lineTo(-2.5, 6.0);
    ctx.moveTo(1.8, -1.5);
    ctx.lineTo(1.8, -5.8);
    ctx.moveTo(3.3, -1.5);
    ctx.lineTo(3.3, -5.8);
    ctx.stroke();
    ctx.fillStyle = '#2563eb';
    ctx.font = 'bold 5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NH₂', -2.5, 8.2);
    ctx.fillStyle = '#dc2626';
    ctx.fillText('O', 2.5, -7.5);
    ctx.textAlign = 'left';
    ctx.fillText('OH', 7.3, 1.8);
  } else if (motif === 'skeletal_valine') {
    // (CH3)2CH-CH(NH2)-C(=O)OH isopropyl + alpha-amino acid skeletal
    ctx.strokeStyle = '#7e22ce';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-11.5, -4.5);
    ctx.lineTo(-7.8, -1.0);
    ctx.lineTo(-11.5, 3.0);
    ctx.moveTo(-7.8, -1.0);
    ctx.lineTo(-3.2, 1.6);
    ctx.lineTo(1.6, -1.2);
    ctx.lineTo(6.0, 1.6);
    ctx.moveTo(-3.2, 1.6);
    ctx.lineTo(-3.2, 5.8);
    ctx.moveTo(1.0, -1.2);
    ctx.lineTo(1.0, -5.2);
    ctx.moveTo(2.4, -1.2);
    ctx.lineTo(2.4, -5.2);
    ctx.stroke();
    ctx.fillStyle = '#2563eb';
    ctx.font = 'bold 4.8px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NH₂', -3.2, 7.8);
    ctx.fillStyle = '#dc2626';
    ctx.fillText('O', 1.7, -7.0);
    ctx.textAlign = 'left';
    ctx.fillText('OH', 6.4, 1.8);
  } else if (motif === 'skeletal_lysine') {
    // H2N-(CH2)4-CH(NH2)-C(=O)OH skeletal
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-9.5, 2.2);
    ctx.lineTo(-6.5, -1.0);
    ctx.lineTo(-3.5, 2.2);
    ctx.lineTo(-0.5, -1.0);
    ctx.lineTo(2.5, 2.2);
    ctx.lineTo(5.6, -1.0);
    ctx.lineTo(8.8, 2.0);
    ctx.moveTo(2.5, 2.2);
    ctx.lineTo(2.5, 6.0);
    ctx.moveTo(5.0, -1.0);
    ctx.lineTo(5.0, -5.0);
    ctx.moveTo(6.3, -1.0);
    ctx.lineTo(6.3, -5.0);
    ctx.stroke();
    ctx.fillStyle = '#2563eb';
    ctx.font = 'bold 4.6px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('H₂N', -9.8, 2.4);
    ctx.textAlign = 'center';
    ctx.fillText('NH₂', 2.5, 7.8);
    ctx.fillStyle = '#dc2626';
    ctx.fillText('O', 5.6, -6.8);
    ctx.textAlign = 'left';
    ctx.fillText('OH', 9.0, 2.2);
  } else if (motif === 'skeletal_glutamic') {
    // HOOC-(CH2)2-CH(NH2)-C(=O)OH skeletal
    ctx.strokeStyle = '#be123c';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-9.5, 1.8);
    ctx.lineTo(-6.2, -1.0);
    ctx.lineTo(-2.8, 1.8);
    ctx.lineTo(0.8, -1.0);
    ctx.lineTo(4.2, 1.8);
    ctx.lineTo(7.4, -1.0);
    ctx.lineTo(10.2, 1.6);
    ctx.moveTo(-6.8, -1.0);
    ctx.lineTo(-6.8, -4.8);
    ctx.moveTo(-5.5, -1.0);
    ctx.lineTo(-5.5, -4.8);
    ctx.moveTo(4.2, 1.8);
    ctx.lineTo(4.2, 5.8);
    ctx.moveTo(6.8, -1.0);
    ctx.lineTo(6.8, -4.8);
    ctx.moveTo(8.1, -1.0);
    ctx.lineTo(8.1, -4.8);
    ctx.stroke();
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 4.5px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('HO', -9.8, 2.0);
    ctx.textAlign = 'center';
    ctx.fillText('O', -6.2, -6.5);
    ctx.fillText('O', 7.4, -6.5);
    ctx.fillStyle = '#2563eb';
    ctx.fillText('NH₂', 4.2, 7.6);
    ctx.fillStyle = '#dc2626';
    ctx.textAlign = 'left';
    ctx.fillText('OH', 10.4, 1.8);
  } else if (motif === 'alcohol_flame') {
    ctx.fillStyle = '#0ea5e9';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.quadraticCurveTo(5, 0, 0, 6);
    ctx.quadraticCurveTo(-5, 0, 0, -7);
    ctx.fill();
  } else if (motif === 'glacial_ice') {
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 0);
    ctx.lineTo(0, 6);
    ctx.lineTo(-4.5, 0);
    ctx.closePath();
    ctx.fill();
  } else if (motif === 'oil_drop' || motif === 'triol_drop') {
    ctx.fillStyle = motif === 'oil_drop' ? '#eab308' : '#14b8a6';
    ctx.beginPath();
    ctx.moveTo(0, -6.5);
    ctx.quadraticCurveTo(5.5, 1, 0, 6);
    ctx.quadraticCurveTo(-5.5, 1, 0, -6.5);
    ctx.fill();
  } else if (motif === 'amino') {
    ctx.fillStyle = 'rgba(168, 85, 247, 0.75)';
    ctx.beginPath();
    ctx.moveTo(0, -5.5);
    ctx.lineTo(5, 0);
    ctx.lineTo(0, 5.5);
    ctx.lineTo(-5, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawRiceSackCanvas(ctx, style, uncapped, labelAlpha) {
  // Tied woven burlap rice sack
  ctx.save();
  // Sack top frill & cord
  if (!uncapped) {
    ctx.fillStyle = '#d97706';
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-16, -48);
    ctx.lineTo(-7, -34);
    ctx.lineTo(7, -34);
    ctx.lineTo(16, -48);
    ctx.quadraticCurveTo(0, -42, -16, -48);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // Main bulging burlap bag body
  const sackGrad = ctx.createLinearGradient(-34, -30, 34, 48);
  sackGrad.addColorStop(0, '#fef3c7');
  sackGrad.addColorStop(0.55, '#fde68a');
  sackGrad.addColorStop(1, '#d97706');
  ctx.fillStyle = sackGrad;
  ctx.strokeStyle = '#92400e';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(-14, -34);
  ctx.lineTo(14, -34);
  ctx.quadraticCurveTo(36, -12, 34, 34);
  ctx.quadraticCurveTo(32, 52, 16, 52);
  ctx.lineTo(-16, 52);
  ctx.quadraticCurveTo(-32, 52, -34, 34);
  ctx.quadraticCurveTo(-36, -12, -14, -34);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Twine tie around sack neck
  ctx.strokeStyle = '#78350f';
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(-15, -33);
  ctx.lineTo(15, -33);
  ctx.stroke();

  // Center stamped crest with rice grains
  if (labelAlpha > 0.05) {
    ctx.fillStyle = 'rgba(255, 251, 235, 0.92)';
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(0, 12, 22, 17, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Drawn white rice grains inside emblem
    for (const [rx, ry, ang] of [[-7, 6, -0.4], [0, 4, 0.1], [7, 7, 0.5]]) {
      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate(ang);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.ellipse(0, 0, 4.4, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = '#78350f';
    ctx.font = 'bold 9.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.shortLabel || 'STARCH', 0, 20);
  }
  ctx.restore();
}

function drawCottonPlantCanvas(ctx, style, pluckProgress = 0) {
  ctx.save();
  // Small terracotta flower pot / base stem
  ctx.fillStyle = '#b45309';
  ctx.strokeStyle = '#78350f';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-18, 30);
  ctx.lineTo(18, 30);
  ctx.lineTo(14, 52);
  ctx.lineTo(-14, 52);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Stems & branches
  ctx.strokeStyle = '#15803d';
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 30);
  ctx.lineTo(0, -24);
  ctx.moveTo(0, 8);
  ctx.quadraticCurveTo(-14, 0, -20, -10);
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(14, -8, 20, -18);
  ctx.stroke();

  // Leaves
  ctx.fillStyle = '#22c55e';
  for (const [lx, ly, rot] of [[-12, 16, -0.6], [12, 12, 0.6]]) {
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Fluffy cotton bolls at tips
  const bolls = [
    [-20, -12, 1.0],
    [20, -20, 1.0],
    [0, -28, Math.max(0.2, 1 - pluckProgress * 0.7)],
  ];
  for (const [bx, by, sc] of bolls) {
    ctx.save();
    ctx.translate(bx, by);
    ctx.scale(sc, sc);
    // Brown calyx bracts
    ctx.strokeStyle = '#65a30d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-9, 6);
    ctx.lineTo(0, 10);
    ctx.lineTo(9, 6);
    ctx.stroke();
    // Puffy cotton clouds
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    for (const [cx, cy, r] of [[-5, 1, 6.5], [5, 1, 6.5], [0, -4, 7.5], [0, 3, 6]]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

function drawEggCanvas(ctx, style, labelAlpha) {
  ctx.save();
  const eggGrad = ctx.createRadialGradient(-10, -16, 4, 0, 4, 46);
  eggGrad.addColorStop(0, '#fffbeb');
  eggGrad.addColorStop(0.55, '#fde68a');
  eggGrad.addColorStop(1, '#d97706');
  ctx.fillStyle = eggGrad;
  ctx.strokeStyle = '#92400e';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(0, -46);
  ctx.bezierCurveTo(22, -46, 32, -8, 30, 16);
  ctx.bezierCurveTo(28, 38, 15, 48, 0, 48);
  ctx.bezierCurveTo(-15, 48, -28, 38, -30, 16);
  ctx.bezierCurveTo(-32, -8, -22, -46, 0, -46);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Shell shine highlight
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.beginPath();
  ctx.ellipse(-11, -18, 5, 12, -0.25, 0, Math.PI * 2);
  ctx.fill();

  if (labelAlpha > 0.05) {
    ctx.fillStyle = 'rgba(255, 251, 235, 0.85)';
    ctx.beginPath();
    ctx.roundRect(-18, 6, 36, 17, 4);
    ctx.fill();
    ctx.fillStyle = '#78350f';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.shortLabel || 'Alb', 0, 14.5);
  }
  ctx.restore();
}

function drawChickenRoosterCanvas(ctx, style, labelAlpha = 1, anim = {}) {
  const { flap = 0, mouthOpen = 0, bodyTilt = 0 } = anim;
  ctx.save();
  ctx.rotate(bodyTilt);

  // Legs & feet
  ctx.strokeStyle = '#ea580c';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  const legKick = flap * 4;
  ctx.beginPath();
  ctx.moveTo(-5, 18);
  ctx.lineTo(-7 - legKick * 0.5, 34);
  ctx.lineTo(-13 - legKick * 0.5, 36);
  ctx.moveTo(-7 - legKick * 0.5, 34);
  ctx.lineTo(-2 - legKick * 0.5, 37);
  ctx.moveTo(8, 18);
  ctx.lineTo(10 + legKick * 0.5, 34);
  ctx.lineTo(4 + legKick * 0.5, 37);
  ctx.moveTo(10 + legKick * 0.5, 34);
  ctx.lineTo(15 + legKick * 0.5, 36);
  ctx.stroke();

  // Fluffy arched tail feathers (right side)
  const tailPlume = [
    { dx: 18, dy: -6, rot: -0.45, col: '#fef3c7' },
    { dx: 22, dy: -2, rot: -0.15, col: '#fde68a' },
    { dx: 20, dy: 4, rot: 0.22, col: '#fbbf24' },
  ];
  for (const tp of tailPlume) {
    ctx.save();
    ctx.translate(tp.dx, tp.dy);
    ctx.rotate(tp.rot + flap * 0.14);
    ctx.fillStyle = tp.col;
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(8, 0, 12, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Plump rooster body
  const bodyGrad = ctx.createRadialGradient(-4, 0, 3, 2, 6, 26);
  bodyGrad.addColorStop(0, '#ffffff');
  bodyGrad.addColorStop(0.6, '#fef9c3');
  bodyGrad.addColorStop(1, '#fcd34d');
  ctx.fillStyle = bodyGrad;
  ctx.strokeStyle = '#b45309';
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  ctx.ellipse(2, 8, 20, 15.5, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Head & neck (facing left toward target vessel)
  ctx.fillStyle = '#fffbeb';
  ctx.beginPath();
  ctx.arc(-13, -10, 11.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Red scalloped comb on top
  ctx.fillStyle = '#ef4444';
  ctx.strokeStyle = '#991b1b';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-21, -18);
  ctx.quadraticCurveTo(-19, -29, -14, -22);
  ctx.quadraticCurveTo(-11, -30, -7, -21);
  ctx.quadraticCurveTo(-2, -26, -3, -17);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Red wattle under chin
  ctx.beginPath();
  ctx.ellipse(-19, -1, 3.2, 4.8, 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Yellow beak (opens wide in comedic shock when plucked)
  ctx.fillStyle = '#f59e0b';
  ctx.strokeStyle = '#92400e';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-23, -12);
  ctx.lineTo(-33, -9 - mouthOpen * 3.5);
  ctx.lineTo(-22, -7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (mouthOpen > 0.15) {
    ctx.beginPath();
    ctx.moveTo(-22, -7);
    ctx.lineTo(-31, -3 + mouthOpen * 3.5);
    ctx.lineTo(-21, -4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Expressive eye
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(-16, -12, 2.7 + mouthOpen * 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.arc(-16.5, -12, mouthOpen > 0.3 ? 1.2 : 1.7, 0, Math.PI * 2);
  ctx.fill();

  // Animated flapping wing
  ctx.save();
  ctx.translate(2, 5);
  ctx.rotate(-0.12 + flap * 0.55);
  ctx.fillStyle = '#fde68a';
  ctx.strokeStyle = '#b45309';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.ellipse(2, 4, 11.5, 6.2, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  if (labelAlpha > 0.05) {
    ctx.fillStyle = 'rgba(255, 251, 235, 0.88)';
    ctx.beginPath();
    ctx.roundRect(-14, 24, 30, 15, 4);
    ctx.fill();
    ctx.fillStyle = '#78350f';
    ctx.font = 'bold 9.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.shortLabel || 'Ker', 1, 31.5);
  }
  ctx.restore();
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
  if (vesselForm === 'rice_sack') {
    drawRiceSackCanvas(ctx, style, uncapped, labelAlpha);
    ctx.restore();
    return;
  }
  if (vesselForm === 'cotton_plant') {
    drawCottonPlantCanvas(ctx, style, 0);
    ctx.restore();
    return;
  }
  if (vesselForm === 'chicken_egg') {
    drawEggCanvas(ctx, style, labelAlpha);
    ctx.restore();
    return;
  }
  if (vesselForm === 'chicken_rooster') {
    drawChickenRoosterCanvas(ctx, style, labelAlpha);
    ctx.restore();
    return;
  }
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

  // Printed Lab Chemical Label Band across center of bottle (+ botanical/hazard emblem if configured)
  if (labelAlpha > 0.05) {
    const labY = shoulderY + 18;
    const labH = 30;
    const labW = w - 10;
    ctx.fillStyle = 'rgba(248, 250, 252, 0.92)';
    ctx.fillRect(-labW / 2, labY, labW, labH);
    ctx.fillStyle = style.accentColor || '#0ea5e9';
    ctx.fillRect(-labW / 2, labY, labW, 5);
    const hasMotif = Boolean(style.bottleMotif);
    ctx.fillStyle = '#0f172a';
    ctx.font = `bold ${isDropper ? 9.5 : 11}px system-ui, sans-serif`;
    ctx.textAlign = hasMotif ? 'left' : 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.shortLabel || reg.formula, hasMotif ? -labW / 2 + 6 : 0, labY + 18);
    if (hasMotif) {
      drawBottleMotifCanvas(ctx, style.bottleMotif, labW / 2 - 14, labY + 17);
    }
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
  } else if (reg.bottleStyle?.vesselForm === 'rice_sack') {
    // STARCH: Tilt burlap rice sack above vessel mouth & pour white rice grains / flour directly in!
    const fadeAlpha = progress < 0.1 ? progress / 0.1 : progress > 0.88 ? (1 - progress) / 0.12 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, fadeAlpha));
    const sackTilt = -0.85 - Math.sin(progress * Math.PI) * 0.25;
    drawReagentBottle(ctx, reg, targetVessel.x + 38, rimY - 52, 0.86, {
      tiltRad: sackTilt,
      uncapped: true,
      isDark,
    });
    if (progress > 0.15 && progress < 0.92) {
      const p = (progress - 0.15) / 0.77;
      for (let i = 0; i < 12; i++) {
        const gp = (p * 1.6 + i * 0.08) % 1;
        const gx = targetVessel.x + 8 - gp * 12 + Math.sin(i * 2.1) * 4;
        const gy = rimY - 32 + gp * (bottomY - rimY + 18);
        ctx.save();
        ctx.translate(gx, gy);
        ctx.rotate(i * 0.55 + progress * 4);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.ellipse(0, 0, 3.6, 1.8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  } else if (reg.bottleStyle?.vesselForm === 'cotton_plant') {
    // CELLULOSE: Cotton plant beside vessel -> pluck cotton tuft from branch & drop into vessel!
    const fadeAlpha = progress < 0.1 ? progress / 0.1 : progress > 0.88 ? (1 - progress) / 0.12 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, fadeAlpha));
    const plantX = targetVessel.x + Math.max(82, spec.width * 0.72);
    const plantY = rimY - 12;
    ctx.save();
    ctx.translate(plantX, plantY);
    ctx.scale(0.9, 0.9);
    drawCottonPlantCanvas(ctx, reg.bottleStyle, Math.min(1, progress * 1.4));
    ctx.restore();

    let tuftX = plantX;
    let tuftY = plantY - 25;
    if (progress < 0.55) {
      const p = progress / 0.55;
      const ease = p * p * (3 - 2 * p);
      tuftX = plantX + (targetVessel.x - plantX) * ease;
      tuftY = (plantY - 25) * (1 - ease) + (rimY - 24) * ease - Math.sin(p * Math.PI) * 28;
    } else {
      const p = (progress - 0.55) / 0.45;
      tuftX = targetVessel.x + Math.sin(p * Math.PI * 3) * 4;
      tuftY = rimY - 24 + p * (bottomY - rimY + 10);
    }
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 0.9;
    for (const [cx, cy, r] of [[-4, 1, 5], [4, 1, 5], [0, -3, 5.8], [0, 2, 4.5]]) {
      ctx.beginPath();
      ctx.arc(tuftX + cx, tuftY + cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  } else if (reg.bottleStyle?.vesselForm === 'chicken_egg') {
    // ALBUMIN: Crack egg open in two shell halves -> stream translucent egg white (lòng trắng) while keeping golden yolk (lòng đỏ) inside!
    const fadeAlpha = progress < 0.1 ? progress / 0.1 : progress > 0.88 ? (1 - progress) / 0.12 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, fadeAlpha));
    const cxEgg = targetVessel.x;
    const cyEgg = rimY - 46;
    const crackOpen = Math.max(0, Math.min(1, (progress - 0.18) / 0.25));
    const tiltSep = crackOpen * 0.52;

    // Left cracked eggshell half holding the bright golden yolk cleanly!
    ctx.save();
    ctx.translate(cxEgg - 4 - crackOpen * 13, cyEgg - crackOpen * 2);
    ctx.rotate(-tiltSep);
    ctx.fillStyle = '#fde68a';
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-18, -14);
    ctx.quadraticCurveTo(-22, 16, 0, 18);
    ctx.lineTo(4, 10);
    ctx.lineTo(-3, 2);
    ctx.lineTo(3, -7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Intact bright orange-yellow yolk retained inside the left half shell!
    ctx.fillStyle = '#f59e0b';
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(-5, 6, 7.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(254, 240, 138, 0.75)';
    ctx.beginPath();
    ctx.arc(-7, 4, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Right cracked eggshell half
    ctx.save();
    ctx.translate(cxEgg + 4 + crackOpen * 13, cyEgg - crackOpen * 2);
    ctx.rotate(tiltSep);
    ctx.fillStyle = '#fde68a';
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(18, -14);
    ctx.quadraticCurveTo(22, 16, 0, 18);
    ctx.lineTo(-4, 10);
    ctx.lineTo(3, 2);
    ctx.lineTo(-3, -7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Viscous translucent cream egg white (albumen) pouring down cleanly into vessel
    if (progress > 0.25 && progress < 0.92) {
      const p = (progress - 0.25) / 0.67;
      const topStream = cyEgg + 12;
      const botStream = Math.min(bottomY - 6, topStream + p * (bottomY - topStream) * 1.45);
      ctx.strokeStyle = 'rgba(254, 249, 195, 0.88)';
      ctx.lineWidth = 5.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cxEgg, topStream);
      ctx.quadraticCurveTo(cxEgg + Math.sin(timeNow * 14) * 3, (topStream + botStream) * 0.5, cxEgg, botStream);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();
  } else if (reg.bottleStyle?.vesselForm === 'chicken_rooster') {
    // KERATIN: "Nhổ lông gà nhảy tung tóe" — tweezers pluck 4 feathers, rooster leaps parabolically + flaps wings + open beak!
    const fadeAlpha = progress < 0.08 ? progress / 0.08 : progress > 0.90 ? (1 - progress) / 0.10 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, fadeAlpha));

    const baseRoostX = targetVessel.x + Math.max(88, spec.width * 0.78);
    const baseRoostY = rimY - 12;
    const pluckT = 0.30;
    const jumped = progress >= pluckT;
    const jumpP = jumped ? Math.min(1, (progress - pluckT) / 0.64) : 0;

    // Parabolic startled leap + frantic recoil hop + frantic wing flapping!
    const leapArcY = jumped ? -Math.sin(jumpP * Math.PI) * 66 : 0;
    const hopBounce = jumped ? Math.abs(Math.sin(jumpP * Math.PI * 3.5)) * 10 : 0;
    const recoilX = jumped ? jumpP * 28 : 0;
    const roostX = baseRoostX + recoilX;
    const roostY = baseRoostY + leapArcY - hopBounce;
    const flap = jumped ? Math.sin(timeNow * 42) : Math.sin(timeNow * 4) * 0.08;
    const mouthOpen = jumped ? Math.max(0.25, Math.abs(Math.sin(timeNow * 24))) : 0;
    const bodyTilt = jumped ? Math.sin(jumpP * Math.PI) * 0.22 : 0;

    // 1. Draw the rooster (leaping when plucked!)
    ctx.save();
    ctx.translate(roostX, roostY);
    ctx.scale(0.86, 0.86);
    drawChickenRoosterCanvas(ctx, reg.bottleStyle, 0, { flap, mouthOpen, bodyTilt });
    if (jumped && jumpP < 0.65) {
      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('!!', -30, -28 - jumpP * 14);
    }
    ctx.restore();

    // 2. Plucking steel tweezers carrying 4 feathers into the vessel
    let bundleX = baseRoostX + 12;
    let bundleY = baseRoostY - 8;
    if (progress < pluckT) {
      const p = progress / pluckT;
      bundleX = targetVessel.x + (baseRoostX + 12 - targetVessel.x) * p;
      bundleY = (rimY - 56) + ((baseRoostY - 8) - (rimY - 56)) * p;
      // Draw tweezers pinching in
      ctx.strokeStyle = isDark ? '#cbd5e1' : '#334155';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bundleX + 18, bundleY - 28);
      ctx.lineTo(bundleX, bundleY);
      ctx.moveTo(bundleX + 24, bundleY - 25);
      ctx.lineTo(bundleX + 2, bundleY);
      ctx.stroke();
    } else {
      const p = Math.min(1, (progress - pluckT) / 0.66);
      // 4 plucked feathers flutter lazily into targetVessel
      for (let f = 0; f < 4; f++) {
        const delay = f * 0.06;
        const fp = Math.max(0, Math.min(1, (p - delay) / 0.85));
        const fx = (baseRoostX + 12) + (targetVessel.x + (f - 1.5) * 6 - (baseRoostX + 12)) * fp + Math.sin(fp * 7 + f) * 5;
        const fy = fp < 0.45
          ? (baseRoostY - 8) + ((rimY - 24) - (baseRoostY - 8)) * (fp / 0.45) - Math.sin((fp / 0.45) * Math.PI) * 26
          : (rimY - 24) + (bottomY - rimY + 12) * ((fp - 0.45) / 0.55);
        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate(Math.sin(fp * 9 + f * 1.4) * 0.55 + 0.3);
        ctx.fillStyle = f % 2 === 0 ? '#ffffff' : '#fef3c7';
        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.ellipse(0, 0, 7.5, 2.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      // Stray down-feathers puffing outward from the startled jump!
      for (let d = 0; d < 4; d++) {
        const dp = Math.min(1, p * 1.25);
        const angle = -0.9 + d * 0.65;
        const dx = baseRoostX + 10 + Math.cos(angle) * dp * 38;
        const dy = baseRoostY - 12 + Math.sin(angle) * dp * 28 - Math.sin(dp * Math.PI) * 14;
        ctx.save();
        ctx.globalAlpha = Math.max(0, (1 - dp) * 0.9);
        ctx.translate(dx, dy);
        ctx.rotate(dp * 4 + d);
        ctx.fillStyle = '#fffbeb';
        ctx.beginPath();
        ctx.ellipse(0, 0, 4.2, 1.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
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
