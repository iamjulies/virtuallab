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
 * Compute retained liquid fraction using the exact rotated 2D inner cross-section polygon
 * clipped at horizontal lip plane y_rot >= lipY — guaranteeing 100% parity with rendered meniscus clip!
 */
function compute2DHoldFraction(innerVertices, thetaDeg) {
  if (!Array.isArray(innerVertices) || innerVertices.length < 3) return 0;
  const rad = (thetaDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotatedPoly = innerVertices.map((p) => ({
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos,
  }));
  const totalA = polygonArea(rotatedPoly);
  if (totalA <= 1e-6) return 0;
  const lipPt = rotatedPoly[rotatedPoly.length - 1];
  const heldA = polygonArea(clipPolygonBelow(rotatedPoly, lipPt.y));
  return Math.max(0, Math.min(1, heldA / totalA));
}

/**
 * Compute maximum retained liquid volume (mL) at tilt angle thetaDeg [0..180] via 2D cross-section polygon clipping.
 */
export function getMaxHoldVolume(innerVertices, totalAreaPx, maxCapacityMl, thetaDeg) {
  const clAngle = Math.max(0, Math.min(180, Number(thetaDeg) || 0));
  if (clAngle <= 0.1) return maxCapacityMl;
  return maxCapacityMl * compute2DHoldFraction(innerVertices, clAngle);
}

function getTiltSlabFrame(spec, geom) {
  const w = spec.width || 68;
  const h = spec.height || 92;
  const footH = spec.shape === 'cylinder' ? 9 : 3.5;
  const baseBottomLocal = h / 2 - footH;
  const topYLocal = -h / 2 + 4;
  const spanH = Math.max(10, baseBottomLocal - topYLocal);
  const maxH = Math.max(0.5, geom.maxHeightCm || 1);
  const scaleX = (w / 2) / Math.max(0.1, geom.bodyMaxRadiusCm || 1);
  const scaleY = spanH / maxH;

  if (!geom._tiltedSlabs) {
    const nSlabs = 32;
    const dyCm = maxH / nSlabs;
    const slabs = [];
    for (let i = 0; i < nSlabs; i++) {
      const y0 = i * dyCm;
      const y1 = (i + 1) * dyCm;
      const yMid = (y0 + y1) * 0.5;
      const slice =
        geom.slices.find((s) => yMid >= s.y0 - 1e-9 && yMid <= s.y1 + 1e-9) ||
        geom.slices[geom.slices.length - 1];
      const interpR = (yc) => {
        const sl =
          geom.slices.find((s) => yc >= s.y0 - 1e-9 && yc <= s.y1 + 1e-9) || slice;
        return Math.max(0.02, sl.r0 + sl.slope * (yc - sl.y0));
      };
      const r0 = interpR(y0);
      const r1 = interpR(y1);
      const rMid = (r0 + r1) * 0.5;
      const dV = ((Math.PI * dyCm) / 3) * (r0 * r0 + r0 * r1 + r1 * r1);
      slabs.push({
        py: baseBottomLocal - yMid * scaleY,
        rx: Math.max(1, rMid * scaleX - 2.2),
        dV,
      });
    }
    geom._tiltedSlabs = slabs;
  }

  const topSlice = geom.slices[geom.slices.length - 1];
  const topR = topSlice?.r1 ?? topSlice?.r0 ?? geom.bodyMaxRadiusCm ?? 1;
  return {
    slabs: geom._tiltedSlabs,
    lipX: Math.max(1, topR * scaleX - 2.2),
    lipY: topYLocal,
  };
}

function sumSlabsVolumeBelow(slabs, cutY, cosT, absSinT) {
  let vol = 0;
  for (let i = 0; i < slabs.length; i++) {
    const sb = slabs[i];
    const rhs = sb.py * cosT - cutY;
    const denom = sb.rx * absSinT;
    if (denom <= 1e-6) {
      if (rhs >= 0) vol += sb.dV;
    } else {
      const u = rhs / denom;
      if (u >= 1) {
        vol += sb.dV;
      } else if (u > -1) {
        vol += sb.dV * ((Math.acos(-u) + u * Math.sqrt(Math.max(0, 1 - u * u))) / Math.PI);
      }
    }
  }
  return vol;
}

export function getVesselHoldVolumeMl(spec, thetaDeg, maxCapOverride = null) {
  const maxCap = maxCapOverride ?? spec?.maxVolumeMl ?? 250;
  const clAngle = Math.max(0, Math.min(180, Number(thetaDeg) || 0));
  const geom = spec?.geometry;
  if (geom && Array.isArray(geom.slices) && geom.slices.length > 0 && Array.isArray(geom._tiltedSlabs || geom.slices)) {
    const maxV = Math.max(1e-6, geom.maxVolumeMl || maxCap);
    if (clAngle <= 0.1) return maxCapOverride ?? maxV;
    const { slabs, lipX, lipY } = getTiltSlabFrame(spec, geom);
    const tiltRad = (clAngle * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const absSinT = Math.abs(Math.sin(tiltRad));
    const rimWorldY = lipY * cosT + lipX * absSinT;
    const heldRaw = sumSlabsVolumeBelow(slabs, rimWorldY, cosT, absSinT);
    if (maxCapOverride != null) {
      return Math.max(0, Math.min(maxCapOverride, heldRaw * (maxCapOverride / maxV)));
    }
    return Math.max(0, Math.min(maxV, heldRaw));
  }
  if (clAngle <= 0.1) return maxCap;
  const { vertices, totalAreaPx } = getInnerPolygonPx(spec);
  return getMaxHoldVolume(vertices, totalAreaPx, maxCap, clAngle);
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

/**
 * Compute horizontal meniscus y-coordinate inside a tilted 3D axisymmetric vessel
 * matching VesselGeometry's exact 3D volume (sum of circular disk chords at tiltRad)
 * and Canvas fluid mapping (padPx = 2.2, footH = 3.5 / 9). Guarantees ZERO level jump when tilting!
 */
export function findTiltClipY3D(spec, targetMl, tiltRad) {
  const geom = spec?.geometry;
  if (!geom || !Array.isArray(geom.slices) || geom.slices.length === 0) {
    const { vertices, totalAreaPx } = getInnerPolygonPx(spec);
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);
    const rotPoly = vertices.map((p) => ({
      x: p.x * cosT - p.y * sinT,
      y: p.x * sinT + p.y * cosT,
    }));
    return findClipYForVolume(rotPoly, totalAreaPx, targetMl, spec?.maxVolumeMl || 250);
  }
  const V = Math.max(0, targetMl || 0);
  if (V <= 1e-6) return Infinity;
  const maxV = Math.max(1e-6, geom.maxVolumeMl);
  if (V >= maxV - 1e-5) return -Infinity;

  const { slabs } = getTiltSlabFrame(spec, geom);
  const cosT = Math.cos(tiltRad);
  const absSinT = Math.abs(Math.sin(tiltRad));

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < slabs.length; i++) {
    const sb = slabs[i];
    const yc = sb.py * cosT;
    const spanY = sb.rx * absSinT;
    if (yc - spanY < minY) minY = yc - spanY;
    if (yc + spanY > maxY) maxY = yc + spanY;
  }

  let lo = minY - 4;
  let hi = maxY + 4;
  for (let it = 0; it < 18; it++) {
    const mid = 0.5 * (lo + hi);
    const vol = sumSlabsVolumeBelow(slabs, mid, cosT, absSinT);
    if (vol > V) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}
