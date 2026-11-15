import { SPECIES } from '../data/species.js';

/**
 * Deterministic pseudo-random helper for stable grain placement.
 */
function seeded(i, salt = 17) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Draw precipitates, crystals, granules, and floating Sodium inside an already-clipped vessel interior.
 */
export function renderVesselSolids(ctx, vessel, bounds, hasWater, surfaceY) {
  const { left, right, bottom, top, width } = bounds;
  const moles = vessel.moles;

  // 1. Precipitates (settled layer + swirling flocculent cloud)
  const pptOrder = ['CuO_s', 'Ag2O_s', 'Cu_s', 'Ag_s', 'AgCl_s', 'CuOH2_s', 'ZnOH2_s'];
  let accumulatedSedimentH = 0;

  for (const spId of pptOrder) {
    const n = moles[spId] || 0;
    if (n <= 1e-8) continue;
    const sp = SPECIES[spId];
    const massG = n * sp.molarMass;
    const settle = vessel.precipitateSettle?.[spId] ?? 0.35;

    // Layer thickness scales naturally with precipitate mass
    const maxLayerH = Math.min(28, 3.5 + Math.sqrt(massG) * 6.5);
    const settledH = hasWater ? maxLayerH * (0.25 + 0.75 * settle) : maxLayerH;

    // Settled bed at bottom
    ctx.save();
    ctx.fillStyle = sp.color;
    ctx.globalAlpha = spId === 'ZnOH2_s' ? 0.78 : 0.94;
    const bedTop = bottom - accumulatedSedimentH - settledH;
    ctx.beginPath();
    ctx.moveTo(left, bottom - accumulatedSedimentH);
    ctx.lineTo(left, bedTop + 2);
    // Slightly bumpy natural sediment contour
    const steps = 8;
    for (let s = 1; s <= steps; s++) {
      const sx = left + (width * s) / steps;
      const bump = (seeded(s, spId.length) - 0.5) * 3.2;
      ctx.lineTo(sx, bedTop + bump);
    }
    ctx.lineTo(right, bottom - accumulatedSedimentH);
    ctx.closePath();
    ctx.fill();

    // Suspended swirling particles in liquid when not fully settled
    if (hasWater && surfaceY < bottom - 8) {
      const colH = bottom - surfaceY;
      const cloudHeight = colH * (1 - settle * 0.65);
      const count = Math.min(55, Math.max(8, Math.round(massG * 22)));
      for (let i = 0; i < count; i++) {
        const px = left + 5 + seeded(i, spId.charCodeAt(0)) * (width - 10);
        const py =
          bottom -
          accumulatedSedimentH -
          2 -
          seeded(i + 41, spId.charCodeAt(1)) * Math.max(8, cloudHeight);
        if (py < surfaceY + 2) continue;

        ctx.globalAlpha = spId === 'ZnOH2_s' ? 0.45 : 0.68;
        ctx.fillStyle = i % 3 === 0 ? sp.highlightColor : sp.color;
        ctx.beginPath();
        const r = spId === 'CuOH2_s' || spId === 'ZnOH2_s' ? 2.8 + seeded(i, 9) * 2.5 : 1.4 + seeded(i, 9) * 1.6;
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
    accumulatedSedimentH += settledH * 0.75;
  }

  // 2. Crystalline & Pelleted Starter Solids resting on bottom
  const bottomSolids = [
    { id: 'CuSO4_5H2O_s', kind: 'blue_crystal' },
    { id: 'CuSO4_s', kind: 'white_powder' },
    { id: 'AgNO3_s', kind: 'white_crystal' },
    { id: 'NaOH_s', kind: 'pellet' },
    { id: 'Zn_s', kind: 'zinc' },
  ];

  for (const item of bottomSolids) {
    const n = moles[item.id] || 0;
    if (n <= 1e-7) continue;
    const sp = SPECIES[item.id];
    const massG = n * sp.molarMass;

    if (item.kind === 'white_powder') {
      const heapH = Math.min(24, 3 + Math.sqrt(massG) * 5.5);
      ctx.save();
      ctx.fillStyle = '#f1f5f9';
      ctx.beginPath();
      ctx.moveTo(left + 4, bottom);
      ctx.quadraticCurveTo(left + width * 0.5, bottom - heapH * 1.6, right - 4, bottom);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.restore();
      continue;
    }

    const grainCount = Math.min(22, Math.max(2, Math.round(2 + Math.sqrt(massG) * 5)));
    const baseSize = Math.min(8.5, 3.2 + Math.cbrt(massG) * 2.2);

    for (let i = 0; i < grainCount; i++) {
      const gx = left + 10 + seeded(i, item.id.length * 13) * Math.max(8, width - 20);
      const gy = bottom - 3 - seeded(i, 97) * Math.min(12, 2 + massG * 1.1);
      const r = baseSize * (0.65 + seeded(i, 31) * 0.5);

      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(seeded(i, 53) * Math.PI);

      if (item.kind === 'pellet') {
        // NaOH opaque white rounded caustic pellets
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
        ctx.fillStyle = '#f8fafc';
        ctx.fill();
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 0.7;
        ctx.stroke();
      } else if (item.kind === 'blue_crystal') {
        // CuSO4·5H2O triclinic azure crystals
        ctx.beginPath();
        ctx.moveTo(-r, -r * 0.4);
        ctx.lineTo(r * 0.4, -r * 0.85);
        ctx.lineTo(r, r * 0.35);
        ctx.lineTo(-r * 0.3, r * 0.75);
        ctx.closePath();
        ctx.fillStyle = '#0284c7';
        ctx.fill();
        ctx.strokeStyle = '#7dd3fc';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      } else if (item.kind === 'white_crystal') {
        // AgNO3 clear/white orthorhombic crystals
        ctx.beginPath();
        ctx.rect(-r * 0.7, -r * 0.55, r * 1.4, r * 1.1);
        ctx.fillStyle = 'rgba(248, 250, 252, 0.92)';
        ctx.fill();
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      } else if (item.kind === 'zinc') {
        // Zn bluish-silver metallic granules (tinted if Cu or Ag plated!)
        const hasCuPlate = (moles.Cu_s || 0) > 1e-6;
        const hasAgPlate = (moles.Ag_s || 0) > 1e-6;
        ctx.beginPath();
        ctx.moveTo(-r, 0);
        ctx.lineTo(-r * 0.4, -r * 0.8);
        ctx.lineTo(r * 0.7, -r * 0.6);
        ctx.lineTo(r, r * 0.4);
        ctx.lineTo(-r * 0.2, r * 0.8);
        ctx.closePath();
        ctx.fillStyle = hasCuPlate ? '#b45309' : hasAgPlate ? '#e2e8f0' : '#94a3b8';
        ctx.fill();
        ctx.strokeStyle = hasCuPlate ? '#f59e0b' : hasAgPlate ? '#ffffff' : '#475569';
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  // 3. Sodium (Na) — floats & melts into glowing silvery sphere on water meniscus!
  const nNa = moles.Na_s || 0;
  if (nNa > 1e-7) {
    const massNa = nNa * SPECIES.Na_s.molarMass;
    const radius = Math.min(12, Math.max(3.8, 3.2 + Math.cbrt(massNa) * 5.2));
    ctx.save();

    if (hasWater && surfaceY < bottom - 4) {
      const nx = left + 8 + vessel.naPosRatio * Math.max(10, width - 16);
      const ny = surfaceY + 1;

      // Turbulent white reaction collar around Na
      ctx.beginPath();
      ctx.ellipse(nx, ny + 1, radius * 1.85, radius * 0.55, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.48)';
      ctx.fill();

      // Molten silvery sphere with metallic radial gradient
      const grad = ctx.createRadialGradient(nx - radius * 0.3, ny - radius * 0.35, 1, nx, ny, radius);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.55, '#cbd5e1');
      grad.addColorStop(1, '#64748b');
      ctx.beginPath();
      ctx.arc(nx, ny, radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    } else {
      // Dry cut Sodium block sitting on vessel bottom
      const nx = left + width * 0.5;
      const ny = bottom - radius - 1;
      ctx.fillStyle = '#cbd5e1';
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(nx - radius, ny - radius * 0.75, radius * 2, radius * 1.5);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}
