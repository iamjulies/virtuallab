import {
  isSolidMoltenAtTemp,
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

  // 0. Molten Salt / Hydroxide / Metal Melt Pool when T >= sp.meltTempK (dry anhydrous melt!)
  const moltenIds = new Set();
  let moltenMassG = 0;
  let moltenPrimary = null;
  for (const [spId, n] of Object.entries(moles)) {
    if (n <= 1e-7) continue;
    const sp = SPECIES[spId];
    if (isSolidMoltenAtTemp(sp, vessel.tempK, moles)) {
      moltenIds.add(spId);
      const mG = n * sp.molarMass;
      moltenMassG += mG;
      if (!moltenPrimary || mG > moltenPrimary.massG) {
        moltenPrimary = { sp, massG: mG };
      }
    }
  }
  if (moltenMassG > 0 && moltenPrimary) {
    const meltH = Math.min(28, 5.5 + Math.sqrt(moltenMassG) * 4.9);
    const poolTop = bottom - meltH;
    let baseCol = moltenPrimary.sp.moltenColor || moltenPrimary.sp.color || '#f1f5f9';
    let botCol = moltenPrimary.sp.highlightColor || baseCol;
    if (moltenPrimary.sp.id === 'S_s') {
      // Sulfur melt thermochromism + polymerization viscosity shift (~160-200 C darkens & thickens dramatically)
      if (vessel.tempK >= 493.15) {
        baseCol = '#7c2d12';
        botCol = '#451a03';
      } else if (vessel.tempK >= 433.15) {
        baseCol = '#b45309';
        botCol = '#78350f';
      } else {
        baseCol = '#eab308';
        botCol = '#facc15';
      }
    }
    ctx.save();
    const mGrad = ctx.createLinearGradient(0, poolTop, 0, bottom);
    mGrad.addColorStop(0, baseCol);
    mGrad.addColorStop(1, botCol);
    ctx.globalAlpha = 0.86;
    ctx.fillStyle = mGrad;
    ctx.beginPath();
    ctx.moveTo(left + 2, bottom);
    ctx.lineTo(left + 2, poolTop + 1.5);
    ctx.quadraticCurveTo(left + width * 0.5, poolTop + 4.0, right - 2, poolTop + 1.5);
    ctx.lineTo(right - 2, bottom);
    ctx.closePath();
    ctx.fill();

    // Glossy molten meniscus + warm thermal glow rim
    ctx.globalAlpha = 0.78;
    ctx.strokeStyle = vessel.tempK >= 700 ? '#fb923c' : '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(left + 2, poolTop + 1.5);
    ctx.quadraticCurveTo(left + width * 0.5, poolTop + 4.0, right - 2, poolTop + 1.5);
    ctx.stroke();

    // Specular liquid shimmer highlights across molten surface
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(left + width * 0.36, poolTop + meltH * 0.36, Math.max(4, width * 0.16), 2.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 1. Precipitates & Metallic Alloys (settled layer + swirling flocculent cloud)
  let accumulatedSedimentH = 0;

  for (const sp of SORTED_PRECIPITATE_SPECIES) {
    const spId = sp.id;
    if (moltenIds.has(spId)) continue;
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
  const totalBottomBulkMl = SORTED_BOTTOM_SOLID_SPECIES.reduce((sum, sp) => {
    if (moltenIds.has(sp.id) || sp.visualType === 'water_ice') return sum;
    const n = moles[sp.id] || 0;
    if (n <= 1e-7) return sum;
    return sum + ((n * sp.molarMass) / (sp.density || 2.5)) * 1.25;
  }, 0);
  const availH = Math.max(12, bottom - (bounds.top ?? bottom - 80) - 2);
  const totalSolidPileH =
    bounds.solidPileTopY != null
      ? Math.max(0, Math.min(availH, bottom - bounds.solidPileTopY))
      : Math.min(availH, 3 + Math.sqrt(totalBottomBulkMl) * 5.5);

  for (const sp of SORTED_BOTTOM_SOLID_SPECIES) {
    const spId = sp.id;
    if (moltenIds.has(spId)) continue;
    const n = moles[spId] || 0;
    if (n <= 1e-7) continue;
    const massG = n * sp.molarMass;
    const vType = sp.visualType || 'white_powder';
    if (vType === 'water_ice') continue; // Rendered as translucent crystalline ice matrix in vesselRenderer.js

    const thisBulkMl = ((massG) / (sp.density || 2.5)) * 1.25;
    const volShare = totalBottomBulkMl > 1e-6 ? thisBulkMl / totalBottomBulkMl : 1;
    const scaledPileH = Math.min(availH, Math.max(4.5, totalSolidPileH * volShare));
    const pCntSp = vessel.particleCounts?.[spId] || 0;
    const isFlattenedMetal = Boolean(vessel.flattenedMetalMap?.[spId]);
    const isGroundPowder =
      !isFlattenedMetal &&
      (Boolean(vessel.groundPowderMap?.[spId]) || pCntSp >= 120);

    if (
      isGroundPowder ||
      vType === 'white_powder' ||
      vType === 'yellow_powder' ||
      vType === 'red_powder' ||
      vType === 'green_powder' ||
      vType === 'brown_powder' ||
      vType === 'black_powder' ||
      vType === 'gray_white_powder' ||
      vType === 'gray_white_solid' ||
      vType === 'porous_lime' ||
      vType === 'powder'
    ) {
      const heapH = Math.min(availH * 0.96, Math.max(3.5 + Math.sqrt(massG) * 3.8, scaledPileH));
      const peakY = Math.max((bounds.top ?? bottom - 80) + 2, bottom - heapH * 1.18);
      const isNeutralWhite =
        (vType === 'white_powder' || isGroundPowder) &&
        (sp.color === '#e2e8f0' || sp.color === '#f8fafc' || sp.color === '#f1f5f9');
      let fillCol =
        spId === 'Fe_s'
          ? '#475569'
          : spId === 'Zn_s'
          ? '#94a3b8'
          : spId === 'Mg_s'
          ? '#e2e8f0'
          : spId === 'Al_s'
          ? '#dce4ee'
          : spId === 'CaCO3_s'
          ? '#f8fafc'
          : isNeutralWhite
          ? '#f1f5f9'
          : sp.color || '#f1f5f9';
      const hotThreshK = sp.hotColorTempK || 460;
      if (sp.hotColor && vessel.tempK > hotThreshK) {
        const hotFrac = Math.min(1, (vessel.tempK - hotThreshK) / 140);
        if (hotFrac > 0.15) fillCol = sp.hotColor;
      }
      if (spId === 'Fe_s' && vessel.tempK >= 773.15) {
        // Fine Iron powder blackbody glow: 500 °C dull red -> 760 °C orange -> 1100 °C bright yellow-white
        if (vessel.tempK >= 1373.15) fillCol = '#fef08a';
        else if (vessel.tempK >= 1033.15) fillCol = '#fb923c';
        else fillCol = '#ef4444';
      }
      const strokeCol =
        spId === 'Fe_s'
          ? '#94a3b8'
          : isNeutralWhite && sp.highlightColor === '#ffffff'
          ? '#cbd5e1'
          : sp.highlightColor || '#cbd5e1';

      ctx.save();
      ctx.fillStyle = fillCol;
      ctx.beginPath();
      ctx.moveTo(left + 3, bottom);
      if (heapH >= availH * 0.52) {
        const flatTop = Math.max((bounds.top ?? bottom - 80) + 4, bottom - heapH);
        ctx.lineTo(left + 3, flatTop + 4);
        ctx.quadraticCurveTo(left + width * 0.5, flatTop - 6, right - 3, flatTop + 4);
        ctx.lineTo(right - 3, bottom);
      } else {
        ctx.quadraticCurveTo(left + width * 0.5, peakY, right - 3, bottom);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = 0.8;
      ctx.stroke();

      // Fine crystalline micro-powder / metallic filings / porous quicklime pores overlay for zoomed detail!
      if (isGroundPowder || vType === 'porous_lime' || vType === 'yellow_powder' || vType === 'red_powder') {
        const speckCount = Math.min(140, Math.max(24, Math.round(20 + scaledPileH * 1.4 + massG * 4)));
        const spanW = Math.max(10, width - 12);
        const effPeakH = Math.max(3, bottom - peakY);
        for (let k = 0; k < speckCount; k++) {
          const ux = seeded(k, spId.length * 19 + 7);
          const archMaxH =
            heapH >= availH * 0.52
              ? Math.max(3, heapH * 0.94)
              : Math.max(2, effPeakH * 0.62 * (1 - Math.abs(ux - 0.5) * 1.45));
          const sx = left + 6 + ux * spanW;
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
              : vType === 'red_powder'
              ? k % 2 === 0
                ? '#9f1239'
                : '#b91c1c'
              : k % 3 === 0
              ? strokeCol
              : 'rgba(255, 255, 255, 0.58)';
          ctx.beginPath();
          ctx.arc(sx, sy, sr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
      continue;
    }

    const grainCount =
      vType === 'iron_solid'
        ? Math.min(48, Math.max(1, Math.round(massG / 4.0), Math.min(12, pCntSp || 1)))
        : vType === 'magnesium_ribbon'
        ? Math.min(26, Math.max(3, Math.round(3 + Math.sqrt(massG) * 4.5)))
        : vType === 'aluminium_foil'
        ? Math.min(26, Math.max(3, Math.round(3 + Math.sqrt(massG) * 4.5)))
        : Math.min(isFlattenedMetal ? 32 : 42, Math.max(2, Math.round(2 + Math.sqrt(massG) * 5.2)));
    const baseSize = Math.min(9.5, 3.4 + Math.cbrt(massG) * 2.1);
    const maxStackY = Math.max(4, Math.min(availH - 4, scaledPileH));

    for (let i = 0; i < grainCount; i++) {
      const gx = left + 9 + seeded(i, spId.length * 13) * Math.max(8, width - 18);
      const gy = bottom - 3.5 - seeded(i, 97) * maxStackY;
      const r = baseSize * (0.65 + seeded(i, 31) * 0.5);

      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(isFlattenedMetal ? (seeded(i, 53) - 0.5) * 0.35 : seeded(i, 53) * Math.PI);
      if (isFlattenedMetal) ctx.scale(1.38, 0.52);

      if (vType === 'iron_solid') {
        const nailLen = Math.min(width * 0.42, Math.max(15, 14 + Math.cbrt(Math.min(massG, 30)) * 4.5));
        const hasCuCoat = (moles.Cu_s || 0) > 1e-6;
        const tempC = (vessel.tempK || 298.15) - 273.15;
        const nailGrad = ctx.createLinearGradient(-nailLen * 0.5, -3, nailLen * 0.5, 3);
        if (tempC >= 1100) {
          // 1100–1300 °C bright yellow-white incandescence (above 1538 °C molten bright orange-white)
          nailGrad.addColorStop(0, '#ffffff');
          nailGrad.addColorStop(0.55, '#fef08a');
          nailGrad.addColorStop(1, '#fb923c');
        } else if (tempC >= 760) {
          // 760–930 °C bright orange glow without sparks in air
          nailGrad.addColorStop(0, '#fed7aa');
          nailGrad.addColorStop(0.5, '#fb923c');
          nailGrad.addColorStop(1, '#ea580c');
        } else if (tempC >= 550) {
          // 550–700 °C dark red -> bright cherry red glow
          const rFrac = Math.min(1, (tempC - 550) / 150);
          nailGrad.addColorStop(0, rFrac > 0.5 ? '#fca5a5' : '#ef4444');
          nailGrad.addColorStop(0.5, rFrac > 0.5 ? '#ef4444' : '#dc2626');
          nailGrad.addColorStop(1, '#7f1d1d');
        } else if (hasCuCoat) {
          nailGrad.addColorStop(0, '#d97706');
          nailGrad.addColorStop(0.55, '#b45309');
          nailGrad.addColorStop(1, '#92400e');
        } else {
          nailGrad.addColorStop(0, '#cbd5e1');
          nailGrad.addColorStop(0.5, '#64748b');
          nailGrad.addColorStop(1, '#334155');
        }
        ctx.fillStyle = nailGrad;
        ctx.strokeStyle = tempC >= 550 ? '#f97316' : hasCuCoat ? '#f59e0b' : '#475569';
        ctx.lineWidth = 0.85;
        // Nail head
        ctx.fillRect(-nailLen * 0.5 - 2, -4.0, 3.0, 8.0);
        // Tapered shaft & sharp tip
        ctx.beginPath();
        ctx.moveTo(-nailLen * 0.5 + 1, -2.1);
        ctx.lineTo(nailLen * 0.32, -1.7);
        ctx.lineTo(nailLen * 0.55, 0);
        ctx.lineTo(nailLen * 0.32, 1.7);
        ctx.lineTo(-nailLen * 0.5 + 1, 2.1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (vType === 'magnesium_ribbon') {
        // Distinct curled bright silver Magnesium ribbon coils / wavy spiral strips
        const ribGrad = ctx.createLinearGradient(-r * 1.4, -r, r * 1.4, r);
        ribGrad.addColorStop(0, '#ffffff');
        ribGrad.addColorStop(0.5, '#e2e8f0');
        ribGrad.addColorStop(1, '#94a3b8');
        ctx.strokeStyle = ribGrad;
        ctx.lineWidth = Math.max(2.0, r * 0.42);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-r * 1.35, r * 0.35);
        ctx.bezierCurveTo(-r * 0.75, -r * 1.15, r * 0.25, r * 1.05, r * 1.35, -r * 0.32);
        ctx.stroke();
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 0.75;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(-r * 1.1, r * 0.15);
        ctx.bezierCurveTo(-r * 0.6, -r * 0.8, r * 0.2, r * 0.75, r * 1.05, -r * 0.25);
        ctx.stroke();
        if ((vessel.mgCombustionTimer || 0) > 0.02) {
          const flareR = r * (5.2 + Math.min(3.5, vessel.mgCombustionTimer * 2.4));
          const mgGrad = ctx.createRadialGradient(0, -r * 0.35, r * 0.35, 0, -r * 0.35, flareR);
          mgGrad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
          mgGrad.addColorStop(0.32, 'rgba(248, 250, 252, 0.96)');
          mgGrad.addColorStop(0.62, 'rgba(186, 230, 253, 0.52)');
          mgGrad.addColorStop(1, 'rgba(224, 242, 254, 0)');
          ctx.fillStyle = mgGrad;
          ctx.beginPath();
          ctx.arc(0, -r * 0.35, flareR, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (vType === 'aluminium_foil') {
        // Distinct crinkled thin shiny silver Aluminium foil leaf sheets
        const foilW = r * 1.65;
        const foilH = r * 0.78;
        const fGrad = ctx.createLinearGradient(-foilW, -foilH, foilW, foilH);
        fGrad.addColorStop(0, '#f8fafc');
        fGrad.addColorStop(0.45, '#cbd5e1');
        fGrad.addColorStop(0.7, '#ffffff');
        fGrad.addColorStop(1, '#94a3b8');
        ctx.fillStyle = fGrad;
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 0.65;
        ctx.beginPath();
        ctx.moveTo(-foilW, -foilH * 0.4);
        ctx.lineTo(-foilW * 0.15, -foilH);
        ctx.lineTo(foilW * 0.85, -foilH * 0.65);
        ctx.lineTo(foilW, foilH * 0.45);
        ctx.lineTo(foilW * 0.12, foilH * 0.92);
        ctx.lineTo(-foilW * 0.78, foilH * 0.35);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Diagonal foil crinkle crease highlight
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(-foilW * 0.55, -foilH * 0.1);
        ctx.lineTo(0, foilH * 0.35);
        ctx.lineTo(foilW * 0.6, -foilH * 0.35);
        ctx.stroke();
        if ((vessel.alCombustionTimer || 0) > 0.02) {
          const flareR = r * (3.6 + Math.min(2.6, vessel.alCombustionTimer * 1.8));
          const alGrad = ctx.createRadialGradient(0, -r * 0.3, r * 0.25, 0, -r * 0.3, flareR);
          alGrad.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
          alGrad.addColorStop(0.45, 'rgba(253, 224, 71, 0.80)');
          alGrad.addColorStop(0.75, 'rgba(251, 146, 60, 0.35)');
          alGrad.addColorStop(1, 'rgba(251, 146, 60, 0)');
          ctx.fillStyle = alGrad;
          ctx.beginPath();
          ctx.arc(0, -r * 0.3, flareR, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (vType === 'white_pellet' || vType === 'pellet') {
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
      } else if (vType === 'blue_crystal' || vType === 'brown_crystal' || vType === 'purple_crystal' || vType === 'green_crystal') {
        const cGrad = ctx.createLinearGradient(-r, -r, r, r);
        cGrad.addColorStop(
          0,
          vType === 'brown_crystal'
            ? '#fbbf24'
            : vType === 'purple_crystal'
            ? '#a855f7'
            : vType === 'green_crystal'
            ? '#10b981'
            : '#38bdf8'
        );
        cGrad.addColorStop(
          0.55,
          vType === 'brown_crystal'
            ? '#d97706'
            : vType === 'purple_crystal'
            ? '#4c1d95'
            : vType === 'green_crystal'
            ? '#065f46'
            : sp.color || '#0284c7'
        );
        cGrad.addColorStop(
          1,
          vType === 'brown_crystal'
            ? '#78350f'
            : vType === 'purple_crystal'
            ? '#1e1b4b'
            : vType === 'green_crystal'
            ? '#022c22'
            : '#0369a1'
        );
        ctx.beginPath();
        ctx.moveTo(-r, -r * 0.42);
        ctx.lineTo(r * 0.38, -r * 0.88);
        ctx.lineTo(r * 0.96, r * 0.28);
        ctx.lineTo(r * 0.15, r * 0.82);
        ctx.lineTo(-r * 0.75, r * 0.48);
        ctx.closePath();
        ctx.fillStyle = cGrad;
        ctx.fill();
        ctx.strokeStyle =
          vType === 'brown_crystal'
            ? '#fde68a'
            : vType === 'purple_crystal'
            ? '#c084fc'
            : vType === 'green_crystal'
            ? '#34d399'
            : '#bae6fd';
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
      } else if (vType === 'carbide_lump') {
        // Commercial Calcium carbide (CaC2) pebbles: gray-black-brown with faint metallic-violet sheen
        const cGrad = ctx.createLinearGradient(-r, -r, r, r);
        cGrad.addColorStop(0, '#52495a');
        cGrad.addColorStop(0.55, '#3b353c');
        cGrad.addColorStop(1, '#1f1c22');
        ctx.beginPath();
        ctx.moveTo(-r * 0.85, -r * 0.2);
        ctx.lineTo(-r * 0.25, -r * 0.82);
        ctx.lineTo(r * 0.72, -r * 0.55);
        ctx.lineTo(r * 0.9, r * 0.35);
        ctx.lineTo(r * 0.05, r * 0.78);
        ctx.lineTo(-r * 0.78, r * 0.5);
        ctx.closePath();
        ctx.fillStyle = cGrad;
        ctx.fill();
        ctx.strokeStyle = '#7e738c';
        ctx.lineWidth = 0.85;
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
        if (sp.id === 'Mg_s' && (vessel.mgCombustionTimer || 0) > 0.02) {
          // Blinding brightWhiteFlash UV-white Magnesium combustion bloom
          const flareR = r * (5.2 + Math.min(3.5, vessel.mgCombustionTimer * 2.4));
          const mgGrad = ctx.createRadialGradient(0, -r * 0.35, r * 0.35, 0, -r * 0.35, flareR);
          mgGrad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
          mgGrad.addColorStop(0.32, 'rgba(248, 250, 252, 0.96)');
          mgGrad.addColorStop(0.62, 'rgba(186, 230, 253, 0.52)');
          mgGrad.addColorStop(1, 'rgba(224, 242, 254, 0)');
          ctx.fillStyle = mgGrad;
          ctx.beginPath();
          ctx.arc(0, -r * 0.35, flareR, 0, Math.PI * 2);
          ctx.fill();
        }
        if (sp.id === 'Al_s' && (vessel.alCombustionTimer || 0) > 0.02) {
          const flareR = r * (3.6 + Math.min(2.6, vessel.alCombustionTimer * 1.8));
          const alGrad = ctx.createRadialGradient(0, -r * 0.3, r * 0.25, 0, -r * 0.3, flareR);
          alGrad.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
          alGrad.addColorStop(0.45, 'rgba(253, 224, 71, 0.80)');
          alGrad.addColorStop(0.75, 'rgba(251, 146, 60, 0.35)');
          alGrad.addColorStop(1, 'rgba(251, 146, 60, 0)');
          ctx.fillStyle = alGrad;
          ctx.beginPath();
          ctx.arc(0, -r * 0.3, flareR, 0, Math.PI * 2);
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

  // 2b. Pale-blue / bright violet-blue Sulfur combustion flame over burning S(s/l)
  if ((vessel.sulfurFlameTimer || 0) > 0.02) {
    const flIntensity = Math.min(1, vessel.sulfurFlameTimer);
    const flR = Math.min(24, 9 + width * 0.24) * (vessel.sulfurO2Flame ? 1.35 : 0.9);
    const cx = left + width * 0.5;
    const cy = bottom - 6;
    ctx.save();
    const sGrad = ctx.createRadialGradient(cx, cy - flR * 0.35, flR * 0.1, cx, cy - flR * 0.35, flR);
    sGrad.addColorStop(0, vessel.sulfurO2Flame ? `rgba(199, 210, 254, ${0.92 * flIntensity})` : `rgba(186, 230, 253, ${0.72 * flIntensity})`);
    sGrad.addColorStop(0.45, vessel.sulfurO2Flame ? `rgba(99, 102, 241, ${0.75 * flIntensity})` : `rgba(56, 189, 248, ${0.50 * flIntensity})`);
    sGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx.fillStyle = sGrad;
    ctx.beginPath();
    ctx.arc(cx, cy - flR * 0.35, flR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 2b-bis. Bright yellow-white Phosphorus combustion flame + dense white P4O10 smoke
  if ((vessel.phosphorusFlameTimer || 0) > 0.02) {
    const flIntensity = Math.min(1, vessel.phosphorusFlameTimer);
    const flR = Math.min(28, 12 + width * 0.28);
    const cx = left + width * 0.5;
    const cy = bottom - 6;
    ctx.save();
    const isCl = vessel.phosphorusFlameColor === 'cl2_green';
    const pGrad = ctx.createRadialGradient(cx, cy - flR * 0.4, flR * 0.1, cx, cy - flR * 0.4, flR);
    pGrad.addColorStop(0, isCl ? `rgba(236, 253, 245, ${0.9 * flIntensity})` : `rgba(255, 255, 255, ${0.98 * flIntensity})`);
    pGrad.addColorStop(0.45, isCl ? `rgba(163, 230, 53, ${0.65 * flIntensity})` : `rgba(253, 224, 71, ${0.85 * flIntensity})`);
    pGrad.addColorStop(1, 'rgba(254, 240, 138, 0)');
    ctx.fillStyle = pGrad;
    ctx.beginPath();
    ctx.arc(cx, cy - flR * 0.4, flR, 0, Math.PI * 2);
    ctx.fill();
    if (!isCl) {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.52 * flIntensity})`;
      for (let i = 0; i < 6; i++) {
        const sx = cx + Math.sin(timeNow * 4 + i * 1.1) * flR * 0.55;
        const sy = cy - flR * (0.7 + ((timeNow * 1.8 + i * 0.23) % 1) * 1.1);
        ctx.beginPath();
        ctx.arc(sx, sy, 4.5 + (i % 3) * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // 2c. Osmotic Chemical Garden: hollow vertical blue Cu(OH)2 coral spires growing upwards!
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

  // 3. Sodium (Na) & Potassium (K) — Marangoni skittering droplets, wake trails & characteristic 589nm yellow / 766nm lilac flames
  const drawAlkaliMetalVisual = (cfg) => {
    const wakeTrail = vessel[cfg.wakeKey];
    const interfaceAnchorY =
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
        const wy = interfaceAnchorY + 2 + (1 - lifeFrac) * 6 + Math.sin(i * 1.4) * 1.5;
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

    const nMet = moles[cfg.speciesId] || 0;
    if (nMet <= 1e-7) return;
    const massMet = nMet * SPECIES[cfg.speciesId].molarMass;
    const radius = Math.min(12, Math.max(3.8, 3.2 + Math.cbrt(massMet) * 5.2));
    const hasIceSurface = (moles.H2O_s || 0) > 1e-6;
    ctx.save();

    if ((hasWater || hasIceSurface) && surfaceY < bottom - 4) {
      const mx = left + 8 + (vessel[cfg.posKey] ?? 0.5) * Math.max(10, width - 16);
      const dropY =
        bounds.naInterfaceY ??
        (vessel.naLayerHeightFrac != null && vessel.naLayerHeightFrac < 0.99
          ? surfaceY + Math.max(0, bottom - surfaceY - radius - 2) * (1 - vessel.naLayerHeightFrac)
          : surfaceY);
      const my = dropY + (hasWater ? cfg.floatOffsetY : -radius * 0.35);
      const tMet = vessel[cfg.tempKey] ?? vessel.tempK;

      if (hasWater || tMet > 273.15) {
        ctx.beginPath();
        ctx.ellipse(mx, my + 1, radius * 1.85, radius * 0.55, 0, 0, Math.PI * 2);
        ctx.fillStyle = hasWater ? 'rgba(255, 255, 255, 0.48)' : 'rgba(186, 230, 253, 0.62)';
        ctx.fill();
      }

      const isIgnited = Boolean(vessel[cfg.ignitedKey]);
      if (tMet >= cfg.haloMinK || isIgnited) {
        const heatFrac = Math.min(1, Math.max(0.25, (tMet - cfg.haloBaseK) / 220));
        const haloR = radius * (isIgnited ? 3.4 : 2.2 + heatFrac * 1.5);
        const haloGrad = ctx.createRadialGradient(mx, my, radius * 0.35, mx, my, haloR);
        haloGrad.addColorStop(0, isIgnited ? cfg.haloCore : cfg.haloWarm(heatFrac));
        haloGrad.addColorStop(0.5, isIgnited ? cfg.haloMid : cfg.haloWarmMid(heatFrac));
        haloGrad.addColorStop(1, cfg.haloEdge);
        ctx.fillStyle = haloGrad;
        ctx.beginPath();
        ctx.arc(mx, my, haloR, 0, Math.PI * 2);
        ctx.fill();
      }

      const grad = ctx.createRadialGradient(mx - radius * 0.3, my - radius * 0.35, 1, mx, my, radius);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.55, isIgnited ? cfg.sphereHotMid : '#cbd5e1');
      grad.addColorStop(1, isIgnited ? cfg.sphereHotEdge : '#64748b');
      ctx.beginPath();
      ctx.arc(mx, my, radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = isIgnited ? cfg.strokeHot : '#f8fafc';
      ctx.lineWidth = 0.85;
      ctx.stroke();
    } else {
      const mx = left + width * cfg.dryAnchorX;
      const flatMet = Boolean(vessel.flattenedMetalMap?.[cfg.speciesId]);
      const isAlkaliPowder = !flatMet && Boolean(vessel.groundPowderMap?.[cfg.speciesId]);
      const tarnish = vessel[cfg.tarnishKey] || 0;
      const isDryBurn = (vessel[cfg.dryBurnKey] || 0) > 0.02;
      if (isAlkaliPowder) {
        const availHMet = Math.max(10, bottom - (bounds.top ?? bottom - 80) - 2);
        const thisMetBulkMl = (massMet / (SPECIES[cfg.speciesId]?.density || 0.9)) * 1.25;
        const heapH = Math.min(availHMet * 0.92, Math.max(4 + Math.sqrt(massMet) * 5.2, (thisMetBulkMl / Math.max(1e-6, bounds.solidBulkMl || thisMetBulkMl)) * (bounds.solidPileTopY != null ? bottom - bounds.solidPileTopY : 18)));
        const powderCol = isDryBurn
          ? cfg.dryFill
          : cfg.speciesId === 'K_s'
          ? tarnish > 0.45 ? '#a78bfa' : '#ede9fe'
          : tarnish > 0.45 ? '#94a3b8' : '#f1f5f9';
        if (isDryBurn) {
          const dryGlow = ctx.createRadialGradient(mx, bottom - heapH * 0.45, radius * 0.4, mx, bottom - heapH * 0.45, radius * 3.8);
          dryGlow.addColorStop(0, cfg.dryCore);
          dryGlow.addColorStop(0.45, cfg.dryMid);
          dryGlow.addColorStop(1, cfg.haloEdge);
          ctx.fillStyle = dryGlow;
          ctx.beginPath();
          ctx.arc(mx, bottom - heapH * 0.45, radius * 3.8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = powderCol;
        ctx.strokeStyle = isDryBurn ? cfg.sphereHotEdge : cfg.speciesId === 'K_s' ? '#a78bfa' : '#94a3b8';
        ctx.lineWidth = 0.85;
        ctx.beginPath();
        ctx.moveTo(left + 4, bottom);
        ctx.quadraticCurveTo(mx, Math.max((bounds.top ?? bottom - 80) + 3, bottom - heapH * 1.25), right - 4, bottom);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        const specks = Math.min(80, Math.max(18, Math.round(16 + heapH * 1.8)));
        for (let k = 0; k < specks; k++) {
          const ux = seeded(k, cfg.speciesId.charCodeAt(0) * 11 + 3);
          const sx = left + 7 + ux * Math.max(8, width - 14);
          const sy = bottom - 1.5 - seeded(k, 73) * Math.max(2, heapH * 0.72 * (1 - Math.abs(ux - 0.5) * 1.45));
          ctx.fillStyle = k % 2 === 0 ? '#ffffff' : cfg.speciesId === 'K_s' ? '#c4b5fd' : '#cbd5e1';
          ctx.beginPath();
          ctx.arc(sx, sy, 0.7 + seeded(k, 29) * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        const scaleVol = Math.min(2.6, Math.max(1.0, Math.cbrt(Math.max(0.2, massMet)) * 0.85));
        const rectW = Math.min(width - 8, (flatMet ? radius * 2.75 : radius * 2) * scaleVol);
        const rectH = Math.min(Math.max(12, bottom - (bounds.top ?? bottom - 80) - 4), (flatMet ? radius * 0.72 : radius * 1.45) * scaleVol);
        const my = bottom - rectH * 0.5 - 1;
        if (isDryBurn) {
          const dryGlow = ctx.createRadialGradient(mx, my, radius * 0.4, mx, my, radius * 3.6);
          dryGlow.addColorStop(0, cfg.dryCore);
          dryGlow.addColorStop(0.45, cfg.dryMid);
          dryGlow.addColorStop(1, cfg.haloEdge);
          ctx.fillStyle = dryGlow;
          ctx.beginPath();
          ctx.arc(mx, my, radius * 3.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = isDryBurn ? cfg.dryFill : tarnish > 0.55 ? '#94a3b8' : tarnish > 0.2 ? '#b6c2cf' : '#e2e8f0';
        ctx.strokeStyle = isDryBurn ? cfg.sphereHotEdge : tarnish > 0.3 ? '#475569' : '#94a3b8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(mx - rectW * 0.5, my - rectH * 0.5, rectW, rectH, flatMet ? 3 : 1);
        ctx.fill();
        ctx.stroke();
        if (tarnish > 0.25) {
          ctx.fillStyle = `rgba(71, 85, 105, ${(0.35 * tarnish).toFixed(2)})`;
          ctx.fillRect(mx - rectW * 0.44, my - rectH * 0.44, rectW * 0.88, rectH * 0.32);
        }
      }
    }
    ctx.restore();
  };

  drawAlkaliMetalVisual({
    speciesId: 'Na_s',
    wakeKey: 'naWakeTrail',
    posKey: 'naPosRatio',
    tempKey: 'naTempK',
    ignitedKey: 'naIgnited',
    tarnishKey: 'naTarnishFrac',
    dryBurnKey: 'naDryBurnTimer',
    floatOffsetY: 1,
    dryAnchorX: 0.5,
    haloMinK: 520,
    haloBaseK: 500,
    haloCore: 'rgba(253, 224, 71, 0.92)',
    haloMid: 'rgba(249, 115, 22, 0.55)',
    haloWarm: (f) => `rgba(251, 146, 60, ${(0.45 * f).toFixed(2)})`,
    haloWarmMid: (f) => `rgba(249, 115, 22, ${(0.22 * f).toFixed(2)})`,
    haloEdge: 'rgba(249, 115, 22, 0)',
    sphereHotMid: '#fde68a',
    sphereHotEdge: '#ea580c',
    strokeHot: '#fef08a',
    dryCore: 'rgba(254, 249, 195, 0.98)',
    dryMid: 'rgba(250, 204, 21, 0.85)',
    dryFill: '#fde047',
  });

  drawAlkaliMetalVisual({
    speciesId: 'K_s',
    wakeKey: 'kWakeTrail',
    posKey: 'kPosRatio',
    tempKey: 'kTempK',
    ignitedKey: 'kIgnited',
    tarnishKey: 'kTarnishFrac',
    dryBurnKey: 'kDryBurnTimer',
    floatOffsetY: 0, // Lower density (0.862 g/cm3) rides distinctly higher on the water meniscus than Na (0.968)
    dryAnchorX: 0.56,
    haloMinK: 390,
    haloBaseK: 370,
    haloCore: 'rgba(255, 255, 255, 0.96)',
    haloMid: 'rgba(192, 132, 252, 0.82)',
    haloWarm: (f) => `rgba(192, 132, 252, ${(0.55 * f).toFixed(2)})`,
    haloWarmMid: (f) => `rgba(155, 89, 182, ${(0.35 * f).toFixed(2)})`,
    haloEdge: 'rgba(155, 89, 182, 0)',
    sphereHotMid: '#e9d5ff',
    sphereHotEdge: '#9b59b6',
    strokeHot: '#c084fc',
    dryCore: 'rgba(250, 245, 255, 0.98)',
    dryMid: 'rgba(192, 132, 252, 0.88)',
    dryFill: '#d8b4fe',
  });
}
