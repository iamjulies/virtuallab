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
