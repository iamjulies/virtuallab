/**
 * Unified piecewise conical-frustum vessel geometry profile.
 * Maps liquid volume (mL = cm^3) <-> fill height <-> meniscus radius <-> surface area (cm^2),
 * and provides matching profile coordinates for Canvas glass wall & clip rendering.
 */
export class VesselGeometry {
  /**
   * @param {Array<[number, number]>} profilePoints - Array of [yCm, rCm] from bottom (y=0) to rim (y=H)
   */
  constructor(profilePoints) {
    if (!Array.isArray(profilePoints) || profilePoints.length < 2) {
      throw new Error('VesselGeometry requires at least 2 profile points');
    }
    this.profilePoints = profilePoints.map(([y, r]) => [y, r]);
    this.slices = [];
    let cumVol = 0;

    for (let i = 0; i < this.profilePoints.length - 1; i++) {
      const [y0, r0] = this.profilePoints[i];
      const [y1, r1] = this.profilePoints[i + 1];
      const dy = Math.max(1e-6, y1 - y0);
      const dV = ((Math.PI * dy) / 3) * (r0 * r0 + r0 * r1 + r1 * r1);
      const slope = (r1 - r0) / dy;

      this.slices.push({
        y0,
        y1,
        r0,
        r1,
        dy,
        slope,
        vStart: cumVol,
        vEnd: cumVol + dV,
      });
      cumVol += dV;
    }

    this.maxVolumeMl = cumVol;
    this.maxHeightCm = this.profilePoints[this.profilePoints.length - 1][0];
    // Body max radius excludes only a top flared rim point on narrow/cylindrical vessels
    this.bodyMaxRadiusCm = this.profilePoints
      .slice(0, Math.max(2, this.profilePoints.length - 1))
      .reduce((acc, [, r]) => Math.max(acc, r), 0);
  }

  /**
   * Solve exact liquid surface state from volume (mL).
   */
  getLiquidState(volumeMl) {
    const V = Math.max(0, volumeMl || 0);
    if (V <= 1e-9) {
      const rBottom = this.slices[0].r0;
      return {
        heightCm: 0,
        fillRatio: 0,
        radiusCm: rBottom,
        surfaceAreaCm2: 0,
        maxHeightCm: this.maxHeightCm,
      };
    }

    const clampedV = Math.min(V, this.maxVolumeMl);
    const slice =
      this.slices.find((s) => clampedV <= s.vEnd + 1e-9) ||
      this.slices[this.slices.length - 1];
    const vRem = Math.max(0, clampedV - slice.vStart);

    let r;
    let h;
    if (Math.abs(slice.slope) < 1e-7) {
      r = slice.r0;
      h = slice.y0 + vRem / Math.max(1e-9, Math.PI * r * r);
    } else {
      const radicand = Math.max(
        0,
        Math.pow(slice.r0, 3) + (3 * slice.slope * vRem) / Math.PI
      );
      r = Math.cbrt(radicand);
      h = slice.y0 + (r - slice.r0) / slice.slope;
    }

    h = Math.max(0, Math.min(this.maxHeightCm, h));
    return {
      heightCm: h,
      fillRatio: h / this.maxHeightCm,
      radiusCm: r,
      surfaceAreaCm2: Math.PI * r * r,
      maxHeightCm: this.maxHeightCm,
    };
  }
}

/**
 * Sutherland-Hodgman polygon clipper retaining region below horizontal plane y = clipY (y >= clipY in Canvas coordinates).
 */
export function clipPolygonBelow(poly, clipY) {
  if (!Array.isArray(poly) || poly.length < 3) return [];
  const result = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const currIn = curr.y >= clipY;
    const prevIn = prev.y >= clipY;
    if (currIn !== prevIn) {
      const denom = curr.y - prev.y;
      const t = Math.abs(denom) < 1e-9 ? 0 : (clipY - prev.y) / denom;
      result.push({ x: prev.x + t * (curr.x - prev.x), y: clipY });
    }
    if (currIn) result.push(curr);
  }
  return result;
}

/**
 * Compute unsigned 2D polygon area using the Shoelace formula.
 */
export function polygonArea(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return Math.abs(area) / 2;
}

/**
 * Build closed clockwise 2D inner cross-section polygon centered around (0, 0) in Canvas pixel units.
 * First vertex is top-left mouth rim; last vertex is top-right pouring lip.
 */
export function getInnerPolygonPx(spec) {
  const w = spec?.width || 68;
  const h = spec?.height || 92;
  const geom = spec?.geometry;
  if (!geom || !Array.isArray(geom.profilePoints) || geom.profilePoints.length < 2) {
    const hw = w * 0.42;
    const hh = h * 0.44;
    const verts = [
      { x: -hw, y: -hh },
      { x: -hw, y: hh },
      { x: hw, y: hh },
      { x: hw, y: -hh },
    ];
    return { vertices: verts, totalAreaPx: polygonArea(verts) };
  }
  const pts = geom.profilePoints;
  const maxR = Math.max(geom.bodyMaxRadiusCm || 1, ...pts.map(([, r]) => r));
  const maxH = Math.max(0.5, geom.maxHeightCm || 1);
  const padX = 4;
  const padY = 4;
  const halfW = Math.max(8, w / 2 - padX);
  const innerH = Math.max(12, h - 2 * padY);

  const toLocal = (yCm, rSigned) => ({
    x: (rSigned / maxR) * halfW,
    y: h / 2 - padY - (yCm / maxH) * innerH,
  });

  const vertices = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    vertices.push(toLocal(pts[i][0], -pts[i][1]));
  }
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 && pts[0][1] < 0.05) continue;
    vertices.push(toLocal(pts[i][0], pts[i][1]));
  }
  return { vertices, totalAreaPx: Math.max(1, polygonArea(vertices)) };
}

/**
 * Compute axisymmetric 3D volume fraction retained below horizontal lip plane y_rot >= lipY
 * by integrating circular chord thickness 2*sqrt(R(y)^2 - x^2) over the inner meridian polygon.
 */
function compute3DHoldFraction(innerVertices, thetaDeg, isNeckedFlask = false) {
  if (!Array.isArray(innerVertices) || innerVertices.length < 3) return 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of innerVertices) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanY = maxY - minY;
  if (spanY <= 1e-6) return 0;

  const rad = (thetaDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lipPt = innerVertices[innerVertices.length - 1];
  const lipY = lipPt.x * sin + lipPt.y * cos;

  const ny = 36;
  const nx = 24;
  const dy = spanY / ny;
  let totalV = 0;
  let heldV = 0;

  for (let iy = 0; iy < ny; iy++) {
    const yl = minY + (iy + 0.5) * dy;
    let rAtY = 0;
    for (let i = 0; i < innerVertices.length; i++) {
      const a = innerVertices[i];
      const b = innerVertices[(i + 1) % innerVertices.length];
      if ((a.y <= yl && b.y > yl) || (b.y <= yl && a.y > yl)) {
        const xHit = a.x + ((yl - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (Math.abs(xHit) > rAtY) rAtY = Math.abs(xHit);
      }
    }
    if (rAtY <= 1e-4) continue;
    const dx = (2 * rAtY) / nx;
    for (let ix = 0; ix < nx; ix++) {
      const xl = -rAtY + (ix + 0.5) * dx;
      const chordZ = Math.sqrt(Math.max(0, rAtY * rAtY - xl * xl));
      const dV = chordZ * dx * dy;
      totalV += dV;
      const yRot = xl * sin + yl * cos;
      if (yRot >= lipY) heldV += dV;
    }
  }
  if (totalV <= 1e-9) return 0;
  const workingFill = isNeckedFlask ? 0.44 : 0.94;
  return Math.max(0, Math.min(1, (heldV / totalV) / workingFill));
}

/**
 * Compute maximum retained liquid volume (mL) at tilt angle thetaDeg [0..180] via 2D/3D cross-section polygon clipping.
 */
export function getMaxHoldVolume(innerVertices, totalAreaPx, maxCapacityMl, thetaDeg) {
  const clAngle = Math.max(0, Math.min(180, Number(thetaDeg) || 0));
  if (clAngle <= 0.1) return maxCapacityMl;
  const topWidth = Math.abs((innerVertices[innerVertices.length - 1]?.x || 0) - (innerVertices[0]?.x || 0));
  let maxHalfW = 0;
  for (const p of innerVertices) {
    if (Math.abs(p.x) > maxHalfW) maxHalfW = Math.abs(p.x);
  }
  const isNeckedFlask = maxHalfW > 1e-3 && topWidth * 0.5 < maxHalfW * 0.65;
  const frac3D = compute3DHoldFraction(innerVertices, clAngle, isNeckedFlask);
  return maxCapacityMl * frac3D;
}

export function getVesselHoldVolumeMl(spec, thetaDeg, maxCapOverride = null) {
  const maxCap = maxCapOverride ?? spec?.maxVolumeMl ?? 250;
  const { vertices, totalAreaPx } = getInnerPolygonPx(spec);
  return getMaxHoldVolume(vertices, totalAreaPx, maxCap, thetaDeg);
}

/**
 * Binary-search horizontal meniscus y-coordinate inside a tilted vessel polygon matching target volume.
 */
export function findClipYForVolume(rotatedPoly, totalAreaPx, targetMl, maxCapacityMl) {
  if (!Array.isArray(rotatedPoly) || rotatedPoly.length < 3 || targetMl <= 1e-6) return Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of rotatedPoly) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const frac = Math.max(0, Math.min(1, targetMl / Math.max(1e-6, maxCapacityMl)));
  const goalArea = frac * totalAreaPx;
  let lo = minY;
  let hi = maxY;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) * 0.5;
    const area = polygonArea(clipPolygonBelow(rotatedPoly, mid));
    if (area > goalArea) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) * 0.5;
}
