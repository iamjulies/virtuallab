import {
  SORTED_BOTTOM_SOLID_SPECIES,
  SORTED_PRECIPITATE_SPECIES,
  SPECIES,
} from '../data/species.js';

/**
 * Deterministic pseudo-random helper for stable grain placement.
 */
function seeded(i, salt = 17) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Draw precipitates, crystals, granules, and floating Sodium inside an already-clipped vessel interior.
 * Driven purely by SPECIES registry ordering and `visualType` metadata.
 */
export function renderVesselSolids(ctx, vessel, bounds, hasWater, surfaceY) {
  const { left, right, bottom, width } = bounds;
  const moles = vessel.moles;

  // 1. Precipitates & Metallic Alloys (settled layer + swirling flocculent cloud)
  let accumulatedSedimentH = 0;

  for (const sp of SORTED_PRECIPITATE_SPECIES) {
    const spId = sp.id;
    const n = moles[spId] || 0;
    if (n <= 1e-8) continue;
    const massG = n * sp.molarMass;
    const settle = vessel.precipitateSettle?.[spId] ?? 0.35;

    // Layer thickness scales naturally with precipitate mass
    const maxLayerH = Math.min(28, 3.5 + Math.sqrt(massG) * 6.5);
    const settledH = hasWater ? maxLayerH * (0.25 + 0.75 * settle) : maxLayerH;

    // Settled bed at bottom
    ctx.save();
    ctx.fillStyle = sp.color;
    ctx.globalAlpha = sp.settledAlpha ?? 0.94;
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
      const [baseR, varR] = sp.particleSizeRange || [1.4, 1.6];
      const cloudAlpha = sp.cloudAlpha ?? 0.68;
      for (let i = 0; i < count; i++) {
        const px = left + 5 + seeded(i, spId.charCodeAt(0)) * (width - 10);
        const py =
          bottom -
          accumulatedSedimentH -
          2 -
          seeded(i + 41, spId.charCodeAt(1)) * Math.max(8, cloudHeight);
        if (py < surfaceY + 2) continue;

        ctx.globalAlpha = cloudAlpha;
        ctx.fillStyle = i % 3 === 0 ? sp.highlightColor : sp.color;
        ctx.beginPath();
        const r = baseR + seeded(i, 9) * varR;
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
    accumulatedSedimentH += settledH * 0.75;
  }

  // 2. Crystalline & Pelleted Starter / Evaporated Solids resting on bottom
  for (const sp of SORTED_BOTTOM_SOLID_SPECIES) {
    const spId = sp.id;
    const n = moles[spId] || 0;
    if (n <= 1e-7) continue;
    const massG = n * sp.molarMass;
    const vType = sp.visualType || 'white_powder';
    if (vType === 'water_ice') continue; // Rendered as translucent crystalline ice matrix in vesselRenderer.js

    const pCntSp = vessel.particleCounts?.[spId] || 0;
    const isLimestoneChips = spId === 'CaCO3_s' && !vessel.groundPowderMap?.[spId] && pCntSp > 0 && pCntSp < 45;
    const isGroundPowder =
      !isLimestoneChips &&
      !sp.isDenseMetal &&
      spId !== 'Na_s' &&
      (Boolean(vessel.groundPowderMap?.[spId]) || pCntSp >= 120 || (spId === 'CaCO3_s' && pCntSp === 0));
    const isFlattenedMetal = Boolean(vessel.flattenedMetalMap?.[spId]);

    if (
      isGroundPowder ||
      vType === 'white_powder' ||
      vType === 'yellow_powder' ||
      vType === 'brown_powder' ||
      vType === 'gray_white_powder' ||
      vType === 'gray_white_solid' ||
      vType === 'porous_lime' ||
      vType === 'powder'
    ) {
      const heapH = Math.min(24, 3 + Math.sqrt(massG) * 5.5);
      const isNeutralWhite =
        (vType === 'white_powder' || isGroundPowder) &&
        (sp.color === '#e2e8f0' || sp.color === '#f8fafc' || sp.color === '#f1f5f9');
      let fillCol = isNeutralWhite ? '#f1f5f9' : sp.color || '#f1f5f9';
      if (sp.hotColor && vessel.tempK > 460) {
        const hotFrac = Math.min(1, (vessel.tempK - 460) / 140);
        if (hotFrac > 0.25) fillCol = sp.hotColor;
      }
      const strokeCol =
        isNeutralWhite && sp.highlightColor === '#ffffff' ? '#cbd5e1' : sp.highlightColor || '#cbd5e1';

      ctx.save();
      ctx.fillStyle = fillCol;
      ctx.beginPath();
      ctx.moveTo(left + 4, bottom);
      ctx.quadraticCurveTo(left + width * 0.5, bottom - heapH * 1.6, right - 4, bottom);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = 0.8;
      ctx.stroke();

      // Fine crystalline micro-powder / porous quicklime pores overlay for zoomed detail!
      if (isGroundPowder || vType === 'porous_lime' || vType === 'yellow_powder') {
        const speckCount = Math.min(64, Math.max(22, Math.round(20 + massG * 10)));
        const spanW = Math.max(10, width - 14);
        for (let k = 0; k < speckCount; k++) {
          const ux = seeded(k, spId.length * 19 + 7);
          const archMaxH = Math.max(2, heapH * 0.85 * (1 - Math.abs(ux - 0.5) * 1.55));
          const sx = left + 7 + ux * spanW;
          const sy = bottom - 1.5 - seeded(k, 89) * archMaxH;
          const sr = 0.65 + seeded(k, 43) * 0.78;
          ctx.fillStyle =
            vType === 'porous_lime'
              ? k % 3 === 0
                ? 'rgba(100, 116, 139, 0.42)'
                : 'rgba(255, 255, 255, 0.72)'
              : vType === 'yellow_powder'
              ? k % 2 === 0
                ? '#fde047'
                : '#fef9c3'
              : k % 3 === 0
              ? strokeCol
              : 'rgba(255, 255, 255, 0.52)';
          ctx.beginPath();
          ctx.arc(sx, sy, sr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
      continue;
    }

    const grainCount = Math.min(isFlattenedMetal ? 28 : 22, Math.max(2, Math.round(2 + Math.sqrt(massG) * 5)));
    const baseSize = Math.min(8.5, 3.2 + Math.cbrt(massG) * 2.2);

    for (let i = 0; i < grainCount; i++) {
      const gx = left + 10 + seeded(i, spId.length * 13) * Math.max(8, width - 20);
      const gy = bottom - 3 - seeded(i, 97) * Math.min(12, 2 + massG * 1.1);
      const r = baseSize * (0.65 + seeded(i, 31) * 0.5);

      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(isFlattenedMetal ? (seeded(i, 53) - 0.5) * 0.35 : seeded(i, 53) * Math.PI);
      if (isFlattenedMetal) ctx.scale(1.38, 0.52);

      if (vType === 'white_pellet' || vType === 'pellet') {
        if (sp.id === 'NaOH_s' && (vessel.naohDeliquesceFrac || 0) > 0.08) {
          ctx.beginPath();
          ctx.arc(0, 0, r * (1.1 + vessel.naohDeliquesceFrac * 0.45), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(186, 230, 253, ${(0.38 * vessel.naohDeliquesceFrac).toFixed(2)})`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
        ctx.fillStyle = sp.id === 'NaOH_s' && (vessel.naohDeliquesceFrac || 0) > 0.35 ? '#e0f2fe' : sp.color || '#f8fafc';
        ctx.fill();
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 0.7;
        ctx.stroke();
      } else if (vType === 'blue_crystal' || vType === 'brown_crystal') {
        const cGrad = ctx.createLinearGradient(-r, -r, r, r);
        cGrad.addColorStop(0, vType === 'brown_crystal' ? '#fbbf24' : '#38bdf8');
        cGrad.addColorStop(0.55, vType === 'brown_crystal' ? '#d97706' : sp.color || '#0284c7');
        cGrad.addColorStop(1, vType === 'brown_crystal' ? '#78350f' : '#0369a1');
        ctx.beginPath();
        ctx.moveTo(-r, -r * 0.42);
        ctx.lineTo(r * 0.38, -r * 0.88);
        ctx.lineTo(r * 0.96, r * 0.28);
        ctx.lineTo(r * 0.15, r * 0.82);
        ctx.lineTo(-r * 0.75, r * 0.48);
        ctx.closePath();
        ctx.fillStyle = cGrad;
        ctx.fill();
        ctx.strokeStyle = vType === 'brown_crystal' ? '#fde68a' : '#bae6fd';
        ctx.lineWidth = 0.75;
        ctx.stroke();
        // Crystalline internal cleavage rib highlight
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.lineWidth = 0.65;
        ctx.beginPath();
        ctx.moveTo(-r * 0.65, -r * 0.18);
        ctx.lineTo(r * 0.35, -r * 0.62);
        ctx.lineTo(r * 0.15, r * 0.62);
        ctx.stroke();
      } else if (vType === 'limestone_solid') {
        // Faceted angular marble/limestone mineral chips
        const lGrad = ctx.createLinearGradient(-r, -r, r, r);
        lGrad.addColorStop(0, '#ffffff');
        lGrad.addColorStop(0.65, '#f1f5f9');
        lGrad.addColorStop(1, '#cbd5e1');
        ctx.beginPath();
        ctx.moveTo(-r * 0.9, -r * 0.15);
        ctx.lineTo(-r * 0.35, -r * 0.78);
        ctx.lineTo(r * 0.65, -r * 0.62);
        ctx.lineTo(r * 0.95, r * 0.25);
        ctx.lineTo(r * 0.1, r * 0.75);
        ctx.lineTo(-r * 0.72, r * 0.55);
        ctx.closePath();
        ctx.fillStyle = lGrad;
        ctx.fill();
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.42)';
        ctx.beginPath();
        ctx.moveTo(-r * 0.25, -r * 0.62);
        ctx.lineTo(r * 0.1, r * 0.48);
        ctx.stroke();
      } else if (vType === 'white_crystal') {
        ctx.beginPath();
        ctx.moveTo(-r * 0.78, -r * 0.45);
        ctx.lineTo(r * 0.2, -r * 0.72);
        ctx.lineTo(r * 0.82, 0);
        ctx.lineTo(r * 0.25, r * 0.68);
        ctx.lineTo(-r * 0.68, r * 0.48);
        ctx.closePath();
        ctx.fillStyle = 'rgba(248, 250, 252, 0.94)';
        ctx.fill();
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        ctx.moveTo(-r * 0.4, -r * 0.25);
        ctx.lineTo(r * 0.35, 0);
        ctx.stroke();
      } else if (vType === 'zinc_granule' || vType === 'zinc') {
        const hasAlphaBrass = (moles.Cu3Zn_alpha_s || 0) > 1e-6;
        const hasGammaBrass = (moles.Cu3Zn_gamma_s || 0) > 1e-6;
        const hasCuPlate = (moles.Cu_s || 0) > 1e-6;
        const hasAgPlate = (moles.Ag_s || 0) > 1e-6;
        const znPassiv = sp.id === 'Zn_s' ? vessel.znPassivationFrac || 0 : 0;
        ctx.beginPath();
        ctx.moveTo(-r, 0);
        ctx.lineTo(-r * 0.4, -r * 0.8);
        ctx.lineTo(r * 0.7, -r * 0.6);
        ctx.lineTo(r, r * 0.4);
        ctx.lineTo(-r * 0.2, r * 0.8);
        ctx.closePath();
        ctx.fillStyle = hasAlphaBrass
          ? '#eab308'
          : hasGammaBrass
          ? '#f1f5f9'
          : hasCuPlate
          ? '#b45309'
          : hasAgPlate
          ? '#e2e8f0'
          : znPassiv > 0.25
          ? '#cbd5e1'
          : sp.color || '#94a3b8';
        ctx.fill();
        ctx.strokeStyle = hasAlphaBrass
          ? '#fef08a'
          : hasGammaBrass
          ? '#ffffff'
          : hasCuPlate
          ? '#f59e0b'
          : hasAgPlate
          ? '#ffffff'
          : znPassiv > 0.25
          ? `rgba(248, 250, 252, ${Math.min(0.95, 0.35 + znPassiv * 0.6).toFixed(2)})`
          : '#475569';
        ctx.lineWidth = znPassiv > 0.25 ? 1.5 : 0.9;
        ctx.stroke();
        if (sp.id === 'Zn_s' && (vessel.znCombustionTimer || 0) > 0.02) {
          const flareR = r * (2.8 + Math.min(2.2, vessel.znCombustionTimer * 1.5));
          const flareGrad = ctx.createRadialGradient(0, -r * 0.35, r * 0.25, 0, -r * 0.35, flareR);
          flareGrad.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
          flareGrad.addColorStop(0.42, 'rgba(103, 232, 249, 0.85)');
          flareGrad.addColorStop(0.75, 'rgba(34, 211, 238, 0.35)');
          flareGrad.addColorStop(1, 'rgba(34, 211, 238, 0)');
          ctx.fillStyle = flareGrad;
          ctx.beginPath();
          ctx.arc(0, -r * 0.35, flareR, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // Fallback polygon crystal/grain for any future solid visualType
        ctx.beginPath();
        ctx.rect(-r * 0.65, -r * 0.65, r * 1.3, r * 1.3);
        ctx.fillStyle = sp.color || '#e2e8f0';
        ctx.fill();
        ctx.strokeStyle = sp.highlightColor || '#94a3b8';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  // 2b. Osmotic Chemical Garden: hollow vertical blue Cu(OH)2 coral spires growing upwards!
  if (hasWater && vessel.gardenActive && (vessel.gardenGrowth || 0) > 0.02 && surfaceY < bottom - 12) {
    const growth = Math.max(0.02, Math.min(1, vessel.gardenGrowth || 0));
    const colH = Math.max(12, bottom - surfaceY - 4);
    const spireCount = 6;
    ctx.save();
    for (let i = 0; i < spireCount; i++) {
      const baseX = left + 12 + ((i + 0.5) / spireCount) * Math.max(12, width - 24);
      const maxSpireH = colH * (0.48 + seeded(i, 71) * 0.44) * growth;
      const tipX = baseX + (seeded(i, 83) - 0.5) * 14;
      const tipY = bottom - maxSpireH;
      const midX = (baseX + tipX) * 0.5 + (seeded(i, 91) - 0.5) * 8;
      const midY = bottom - maxSpireH * 0.55;

      // Hollow cerulean coral outer stalk
      ctx.lineCap = 'round';
      ctx.strokeStyle = i % 2 === 0 ? '#0284c7' : '#0ea5e9';
      ctx.lineWidth = 4.2 + seeded(i, 63) * 2.2;
      ctx.beginPath();
      ctx.moveTo(baseX, bottom - 2);
      ctx.quadraticCurveTo(midX, midY, tipX, tipY);
      ctx.stroke();

      // Translucent brighter central hollow lumen channel
      ctx.strokeStyle = '#7dd3fc';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(baseX, bottom - 4);
      ctx.quadraticCurveTo(midX, midY, tipX, tipY + 1);
      ctx.stroke();

      // Glowing bulbous osmotic vesicle tip
      ctx.fillStyle = '#bae6fd';
      ctx.beginPath();
      ctx.arc(tipX, tipY, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // 3. Sodium (Na) — Marangoni skittering droplet + Phenolphthalein wake trail on meniscus or oil-water interface
  const wakeTrail = vessel.naWakeTrail;
  const naAnchorY =
    bounds.naInterfaceY ??
    (vessel.naLayerHeightFrac != null && vessel.naLayerHeightFrac < 0.99
      ? surfaceY + Math.max(0, bottom - surfaceY - 8) * (1 - vessel.naLayerHeightFrac)
      : surfaceY);
  if (hasWater && Array.isArray(wakeTrail) && wakeTrail.length > 1 && surfaceY < bottom - 4) {
    const hasPhenTrail = (moles.Phenolphthalein_aq || 0) > 1e-9;
    ctx.save();
    for (let i = 1; i < wakeTrail.length; i++) {
      const pA = wakeTrail[i - 1];
      const pB = wakeTrail[i];
      const lifeFrac = Math.max(0, 1 - pB.age / Math.max(0.1, pB.maxLife));
      if (lifeFrac <= 0.02) continue;
      const wxA = left + 8 + pA.pos * Math.max(10, width - 16);
      const wxB = left + 8 + pB.pos * Math.max(10, width - 16);
      const wy = naAnchorY + 2 + (1 - lifeFrac) * 6 + Math.sin(i * 1.4) * 1.5;
      ctx.strokeStyle = hasPhenTrail
        ? `rgba(236, 72, 153, ${(0.72 * lifeFrac).toFixed(2)})`
        : `rgba(226, 232, 240, ${(0.45 * lifeFrac).toFixed(2)})`;
      ctx.lineWidth = hasPhenTrail ? 2.6 * lifeFrac + 1.0 : 1.8 * lifeFrac + 0.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(wxA, wy);
      ctx.lineTo(wxB, wy);
      ctx.stroke();
    }
    ctx.restore();
  }

  const nNa = moles.Na_s || 0;
  if (nNa > 1e-7) {
    const massNa = nNa * SPECIES.Na_s.molarMass;
    const radius = Math.min(12, Math.max(3.8, 3.2 + Math.cbrt(massNa) * 5.2));
    const hasIceSurface = (moles.H2O_s || 0) > 1e-6;
    ctx.save();

    if ((hasWater || hasIceSurface) && surfaceY < bottom - 4) {
      const nx = left + 8 + vessel.naPosRatio * Math.max(10, width - 16);
      const naDropY =
        bounds.naInterfaceY ??
        (vessel.naLayerHeightFrac != null && vessel.naLayerHeightFrac < 0.99
          ? surfaceY + Math.max(0, bottom - surfaceY - radius - 2) * (1 - vessel.naLayerHeightFrac)
          : surfaceY);
      const ny = naDropY + (hasWater ? 1 : -radius * 0.35);

      const tNa = vessel.naTempK ?? vessel.tempK;
      if (hasWater || tNa > 273.15) {
        // Turbulent white / local melt-film reaction collar around Na
        ctx.beginPath();
        ctx.ellipse(nx, ny + 1, radius * 1.85, radius * 0.55, 0, 0, Math.PI * 2);
        ctx.fillStyle = hasWater ? 'rgba(255, 255, 255, 0.48)' : 'rgba(186, 230, 253, 0.62)';
        ctx.fill();
      }

      // Thermal sodium halo when molten -> incandescent -> ignited (>= 680 K)
      if (tNa >= 520 || vessel.naIgnited) {
        const heatFrac = Math.min(1, (tNa - 500) / 220);
        const haloGrad = ctx.createRadialGradient(nx, ny, radius * 0.4, nx, ny, radius * (2.2 + heatFrac * 1.5));
        haloGrad.addColorStop(0, vessel.naIgnited ? 'rgba(253, 224, 71, 0.92)' : `rgba(251, 146, 60, ${0.45 * heatFrac})`);
        haloGrad.addColorStop(1, 'rgba(249, 115, 22, 0)');
        ctx.fillStyle = haloGrad;
        ctx.beginPath();
        ctx.arc(nx, ny, radius * (2.2 + heatFrac * 1.5), 0, Math.PI * 2);
        ctx.fill();
      }

      // Molten silvery sphere (shifts slightly warm amber-white at high T_Na)
      const grad = ctx.createRadialGradient(nx - radius * 0.3, ny - radius * 0.35, 1, nx, ny, radius);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.55, vessel.naIgnited ? '#fde68a' : '#cbd5e1');
      grad.addColorStop(1, vessel.naIgnited ? '#ea580c' : '#64748b');
      ctx.beginPath();
      ctx.arc(nx, ny, radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    } else {
      // Dry cut Sodium block sitting on vessel bottom (burns vivid 589nm yellow on dry ignition!)
      const nx = left + width * 0.5;
      const flatNa = Boolean(vessel.flattenedMetalMap?.Na_s);
      const tarnish = vessel.naTarnishFrac || 0;
      const isDryBurn = (vessel.naDryBurnTimer || 0) > 0.02;
      const rectW = flatNa ? radius * 2.75 : radius * 2;
      const rectH = flatNa ? radius * 0.72 : radius * 1.5;
      const ny = bottom - rectH * 0.5 - 1;
      if (isDryBurn) {
        const yGlow = ctx.createRadialGradient(nx, ny, radius * 0.4, nx, ny, radius * 3.6);
        yGlow.addColorStop(0, 'rgba(254, 249, 195, 0.98)');
        yGlow.addColorStop(0.45, 'rgba(250, 204, 21, 0.85)');
        yGlow.addColorStop(1, 'rgba(249, 115, 22, 0)');
        ctx.fillStyle = yGlow;
        ctx.beginPath();
        ctx.arc(nx, ny, radius * 3.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = isDryBurn ? '#fde047' : tarnish > 0.55 ? '#94a3b8' : tarnish > 0.2 ? '#b6c2cf' : '#e2e8f0';
      ctx.strokeStyle = isDryBurn ? '#ea580c' : tarnish > 0.3 ? '#475569' : '#94a3b8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(nx - rectW * 0.5, ny - rectH * 0.5, rectW, rectH, flatNa ? 3 : 1);
      ctx.fill();
      ctx.stroke();
      if (tarnish > 0.25) {
        ctx.fillStyle = `rgba(71, 85, 105, ${(0.35 * tarnish).toFixed(2)})`;
        ctx.fillRect(nx - rectW * 0.44, ny - rectH * 0.44, rectW * 0.88, rectH * 0.32);
      }
    }
    ctx.restore();
  }
}
