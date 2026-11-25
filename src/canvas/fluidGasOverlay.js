import { APPARATUS } from '../data/apparatus.js';
import { CONSTANTS } from '../data/constants.js';
import { getGasRelativeAirDensity } from '../data/species.js';
import { computeLiquidVolumeL } from '../engine/equilibrium.js';
import { computeVesselFluidGeometry, getVesselAeroProfile, traceVesselInteriorClip, traceVesselPath } from './equipmentRenderer.js';

const SIM_W = 320;
const SIM_H = 180;
const BENCH_LOGICAL_W = 1000;
const BENCH_LOGICAL_H = 560;
const BENCH_FLOOR_Y = 482;

const BASE_VS = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTarget;
uniform sampler2D uObs;
uniform vec2 uPoint;
uniform float uRadius;
uniform vec4 uValue;
uniform vec2 uAspect;
uniform int uRespectObs;
out vec4 fragColor;
void main() {
  vec4 base = texture(uTarget, vUv);
  if (uRespectObs == 1 && texture(uObs, vUv).r > 0.5) {
    fragColor = base;
    return;
  }
  vec2 d = (vUv - uPoint) * uAspect;
  float falloff = exp(-dot(d, d) / max(1e-5, uRadius));
  fragColor = base + uValue * falloff;
}`;

const BUOYANCY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVel;
uniform sampler2D uTempBuoy;
uniform sampler2D uObs;
uniform float uDt;
uniform float uCurlAmp;
uniform vec2 uTexel;
out vec4 fragColor;
float sampleCurl(vec2 uv) {
  vec2 vL = texture(uVel, uv - vec2(uTexel.x, 0.0)).xy;
  vec2 vR = texture(uVel, uv + vec2(uTexel.x, 0.0)).xy;
  vec2 vB = texture(uVel, uv - vec2(0.0, uTexel.y)).xy;
  vec2 vT = texture(uVel, uv + vec2(0.0, uTexel.y)).xy;
  return 0.5 * ((vR.y - vL.y) - (vT.x - vB.x));
}
void main() {
  if (texture(uObs, vUv).r > 0.5) {
    fragColor = vec4(0.0);
    return;
  }
  vec2 vel = texture(uVel, vUv).xy;
  vec4 tb = texture(uTempBuoy, vUv);
  float tempDelta = tb.r;
  float heavyForce = tb.g;
  float fy = tempDelta * 0.90 - heavyForce * 0.96;
  float tL = texture(uTempBuoy, vUv - vec2(uTexel.x, 0.0)).g + texture(uTempBuoy, vUv - vec2(uTexel.x, 0.0)).r;
  float tR = texture(uTempBuoy, vUv + vec2(uTexel.x, 0.0)).g + texture(uTempBuoy, vUv + vec2(uTexel.x, 0.0)).r;
  float fx = (tL - tR) * uCurlAmp;

  // Lightweight vorticity confinement to restore crisp plume swirl edges
  float cL = abs(sampleCurl(vUv - vec2(uTexel.x, 0.0)));
  float cR = abs(sampleCurl(vUv + vec2(uTexel.x, 0.0)));
  float cB = abs(sampleCurl(vUv - vec2(0.0, uTexel.y)));
  float cT = abs(sampleCurl(vUv + vec2(0.0, uTexel.y)));
  vec2 grad = 0.5 * vec2(cR - cL, cT - cB);
  float gLen = length(grad);
  if (gLen > 1e-4) {
    vec2 nGrad = grad / gLen;
    float wC = sampleCurl(vUv);
    vec2 vortForce = vec2(nGrad.y, -nGrad.x) * wC * 0.24;
    vel += vortForce * uDt * 18.0;
  }

  vel += vec2(fx, fy) * uDt;
  float spd = length(vel);
  if (spd > 0.85) vel = (vel / spd) * 0.85;
  fragColor = vec4(vel, 0.0, 1.0);
}`;

const ADVECT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVel;
uniform sampler2D uSource;
uniform sampler2D uObs;
uniform float uDt;
uniform float uDissipate;
uniform vec2 uTexel;
out vec4 fragColor;
void main() {
  if (texture(uObs, vUv).r > 0.5) {
    fragColor = vec4(0.0);
    return;
  }
  vec2 vel = texture(uVel, vUv).xy;
  vec2 prevUv = clamp(vUv - vel * uDt * vec2(0.45, 0.45 * (16.0 / 9.0)), uTexel, 1.0 - uTexel);
  if (texture(uObs, prevUv).r > 0.5) {
    prevUv = vUv;
  }
  vec4 val = texture(uSource, prevUv) * uDissipate;
  fragColor = val;
}`;

const DIVERGENCE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVel;
uniform sampler2D uObs;
uniform vec2 uTexel;
out vec4 fragColor;
void main() {
  vec2 vC = texture(uVel, vUv).xy;
  vec2 vL = texture(uObs, vUv - vec2(uTexel.x, 0.0)).r > 0.5 ? -vC : texture(uVel, vUv - vec2(uTexel.x, 0.0)).xy;
  vec2 vR = texture(uObs, vUv + vec2(uTexel.x, 0.0)).r > 0.5 ? -vC : texture(uVel, vUv + vec2(uTexel.x, 0.0)).xy;
  vec2 vB = texture(uObs, vUv - vec2(0.0, uTexel.y)).r > 0.5 ? -vC : texture(uVel, vUv - vec2(0.0, uTexel.y)).xy;
  vec2 vT = texture(uObs, vUv + vec2(0.0, uTexel.y)).r > 0.5 ? -vC : texture(uVel, vUv + vec2(0.0, uTexel.y)).xy;
  float div = 0.5 * ((vR.x - vL.x) + (vT.y - vB.y));
  fragColor = vec4(div, 0.0, 0.0, 1.0);
}`;

const PRESSURE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPress;
uniform sampler2D uDiv;
uniform sampler2D uObs;
uniform vec2 uTexel;
out vec4 fragColor;
void main() {
  float pC = texture(uPress, vUv).r;
  float pL = texture(uObs, vUv - vec2(uTexel.x, 0.0)).r > 0.5 ? pC : texture(uPress, vUv - vec2(uTexel.x, 0.0)).r;
  float pR = texture(uObs, vUv + vec2(uTexel.x, 0.0)).r > 0.5 ? pC : texture(uPress, vUv + vec2(uTexel.x, 0.0)).r;
  float pB = texture(uObs, vUv - vec2(0.0, uTexel.y)).r > 0.5 ? pC : texture(uPress, vUv - vec2(0.0, uTexel.y)).r;
  float pT = texture(uObs, vUv + vec2(0.0, uTexel.y)).r > 0.5 ? pC : texture(uPress, vUv + vec2(0.0, uTexel.y)).r;
  float div = texture(uDiv, vUv).r;
  float pNew = (pL + pR + pB + pT - div) * 0.25;
  fragColor = vec4(pNew, 0.0, 0.0, 1.0);
}`;

const GRADIENT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPress;
uniform sampler2D uVel;
uniform sampler2D uObs;
uniform vec2 uTexel;
out vec4 fragColor;
void main() {
  if (texture(uObs, vUv).r > 0.5) {
    fragColor = vec4(0.0);
    return;
  }
  float pC = texture(uPress, vUv).r;
  float pL = texture(uObs, vUv - vec2(uTexel.x, 0.0)).r > 0.5 ? pC : texture(uPress, vUv - vec2(uTexel.x, 0.0)).r;
  float pR = texture(uObs, vUv + vec2(uTexel.x, 0.0)).r > 0.5 ? pC : texture(uPress, vUv + vec2(uTexel.x, 0.0)).r;
  float pB = texture(uObs, vUv - vec2(0.0, uTexel.y)).r > 0.5 ? pC : texture(uPress, vUv - vec2(0.0, uTexel.y)).r;
  float pT = texture(uObs, vUv + vec2(0.0, uTexel.y)).r > 0.5 ? pC : texture(uPress, vUv + vec2(0.0, uTexel.y)).r;
  vec2 vel = texture(uVel, vUv).xy - 0.5 * vec2(pR - pL, pT - pB);
  fragColor = vec4(vel, 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uDye;
uniform sampler2D uTempBuoy;
uniform int uModeThermal; // 0 = natural gas colors, 1 = FLIR thermal plumes
uniform float uIsDark;
out vec4 fragColor;

vec3 ironbowLut(float t) {
  float x = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.06, 0.04, 0.24);
  vec3 c1 = vec3(0.45, 0.06, 0.54);
  vec3 c2 = vec3(0.88, 0.20, 0.14);
  vec3 c3 = vec3(0.98, 0.68, 0.10);
  vec3 c4 = vec3(1.00, 0.98, 0.78);
  if (x < 0.25) return mix(c0, c1, x * 4.0);
  if (x < 0.55) return mix(c1, c2, (x - 0.25) / 0.30);
  if (x < 0.82) return mix(c2, c3, (x - 0.55) / 0.27);
  return mix(c3, c4, (x - 0.82) / 0.18);
}

void main() {
  if (uModeThermal == 1) {
    float temp = clamp(texture(uTempBuoy, vUv).r, 0.0, 1.0);
    float dyeMag = clamp(texture(uDye, vUv).a, 0.0, 1.0);
    float signal = max(temp, dyeMag * temp * 3.5);
    if (signal < 0.006) {
      fragColor = vec4(0.0);
      return;
    }
    vec3 col = ironbowLut(clamp(pow(signal, 0.62) * 1.18, 0.14, 1.0));
    float alpha = smoothstep(0.006, 0.28, signal) * 0.72;
    fragColor = vec4(col * alpha, alpha);
    return;
  }
  vec4 d = texture(uDye, vUv);
  float mag = clamp(d.a, 0.0, 1.0);
  if (mag < 0.012) {
    fragColor = vec4(0.0);
    return;
  }
  vec3 rgb = d.rgb / max(0.02, mag);
  // Subtle light/dark readability tuning
  rgb = mix(rgb * 0.90, rgb, uIsDark);
  float alpha = smoothstep(0.012, 0.65, mag) * 0.62;
  fragColor = vec4(rgb * alpha, alpha);
}`;

const GAS_COLOR_MAP = {
  NO2_g: [0.85, 0.42, 0.08],
  Br2_g: [0.92, 0.34, 0.05],
  I2_g: [0.64, 0.20, 0.78],
  Cl2_g: [0.76, 0.92, 0.34],
  SO2_g: [0.88, 0.91, 0.96],
  SO3_g: [0.93, 0.95, 0.98],
  HCl_g: [0.90, 0.94, 0.98],
  HBr_g: [0.90, 0.94, 0.98],
  HI_g: [0.82, 0.78, 0.94],
  NH3_g: [0.84, 0.94, 0.96],
  H2O_g: [0.91, 0.95, 0.99],
  H2S_g: [0.85, 0.88, 0.78],
  NO_g: [0.82, 0.86, 0.92],
  H2_g: [0.78, 0.92, 1.0],
  CO2_g: [0.84, 0.89, 0.95],
  CO_g: [0.78, 0.88, 0.96],
  C2H2_g: [0.86, 0.92, 0.98],
  CH4_g: [0.80, 0.94, 0.98],
  PH3_g: [0.88, 0.88, 0.72],
  P4_g: [0.95, 0.92, 0.78],
  CrO2Cl2_g: [0.76, 0.16, 0.12],
  C2H4_g: [0.84, 0.93, 0.99],
  CH3COOH_g: [0.91, 0.95, 0.98],
};

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function createFBO(gl, w, h, internalFormat, format, type, filter) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, ok };
}

function createDoubleFBO(gl, w, h, internalFormat, format, type, filter) {
  let a = createFBO(gl, w, h, internalFormat, format, type, filter);
  let b = createFBO(gl, w, h, internalFormat, format, type, filter);
  if (!a.ok || !b.ok) return null;
  return {
    get read() { return a; },
    get write() { return b; },
    swap() { const t = a; a = b; b = t; },
  };
}

/**
 * Lightweight GPU WebGL2 Stable Fluids 2D Gas & Thermal Field Solver (256x144).
 */
export class FluidGasOverlay {
  constructor() {
    this.enabled = false;
    this.canvas = null;
    this.gl = null;
    this.obsCanvas = null;
    this.obsCtx = null;
    this.obsTex = null;
    this._obsSig = '';
    this._lastObsMs = 0;
    this._stepAccumDt = 0;
    this.isSleeping = false;
    this._idleSec = 0;
    this._hasPlumeEnergy = false;
    this.init();
  }

  init() {
    if (typeof document === 'undefined') return;
    try {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const gl = c.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
      if (!gl) return;
      const extFloat = gl.getExtension('EXT_color_buffer_float');
      const extHalf = gl.getExtension('EXT_color_buffer_half_float');
      gl.getExtension('OES_texture_half_float_linear');
      gl.getExtension('OES_texture_float_linear');
      if (!extFloat && !extHalf) return;

      const useHalf = Boolean(extHalf && gl.HALF_FLOAT);
      const texType = useHalf ? gl.HALF_FLOAT : gl.FLOAT;
      const intFmt = useHalf ? gl.RGBA16F : gl.RGBA32F;

      const quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      this.programs = {
        splat: createProgram(gl, BASE_VS, SPLAT_FS),
        buoyancy: createProgram(gl, BASE_VS, BUOYANCY_FS),
        advect: createProgram(gl, BASE_VS, ADVECT_FS),
        divergence: createProgram(gl, BASE_VS, DIVERGENCE_FS),
        pressure: createProgram(gl, BASE_VS, PRESSURE_FS),
        gradient: createProgram(gl, BASE_VS, GRADIENT_FS),
        display: createProgram(gl, BASE_VS, DISPLAY_FS),
      };
      if (Object.values(this.programs).some((p) => !p)) return;

      this.vel = createDoubleFBO(gl, SIM_W, SIM_H, intFmt, gl.RGBA, texType, gl.LINEAR);
      this.dye = createDoubleFBO(gl, SIM_W, SIM_H, intFmt, gl.RGBA, texType, gl.LINEAR);
      this.tempBuoy = createDoubleFBO(gl, SIM_W, SIM_H, intFmt, gl.RGBA, texType, gl.LINEAR);
      this.pressure = createDoubleFBO(gl, SIM_W, SIM_H, intFmt, gl.RGBA, texType, gl.NEAREST);
      this.divergence = createFBO(gl, SIM_W, SIM_H, intFmt, gl.RGBA, texType, gl.NEAREST);
      if (!this.vel || !this.dye || !this.tempBuoy || !this.pressure || !this.divergence.ok) return;

      this.obsCanvas = document.createElement('canvas');
      this.obsCanvas.width = SIM_W;
      this.obsCanvas.height = SIM_H;
      this.obsCtx = this.obsCanvas.getContext('2d');
      this.obsTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.obsTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.gl = gl;
      this.canvas = c;
      this.quadBuf = quadBuf;
      this.enabled = true;
    } catch {
      this.enabled = false;
    }
  }

  _bindQuad(prog) {
    const gl = this.gl;
    gl.useProgram(prog);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  _blit(fbo, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _updateObstacles(items) {
    const gl = this.gl;
    const octx = this.obsCtx;
    const sx = SIM_W / BENCH_LOGICAL_W;
    const sy = SIM_H / BENCH_LOGICAL_H;

    let sig = '';
    for (const it of items) {
      if (it.kind === 'vessel' || it.kind === 'rubber_stopper') {
        const liqQ = it.kind === 'vessel' ? Math.round(computeLiquidVolumeL(it.moles || {}, it.tempK || 298.15) * 2000) : 0;
        sig += `${it.id}:${Math.round(it.x)},${Math.round(it.y)},${Math.round(it.tiltDeg || 0)},${it.isInverted ? 1 : 0},${it.isStoppered ? 1 : 0},${it.lidState || ''},${liqQ};`;
      }
    }
    if (sig === this._obsSig) return;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this._obsSig && nowMs - this._lastObsMs < 75) return;
    this._obsSig = sig;
    this._lastObsMs = nowMs;

    octx.clearRect(0, 0, SIM_W, SIM_H);
    octx.fillStyle = '#ff0000';
    const floorY = Math.floor(BENCH_FLOOR_Y * sy);
    octx.fillRect(0, floorY, SIM_W, SIM_H - floorY);

    for (const v of items) {
      if (v.kind !== 'vessel' || v.isShattered) continue;
      const spec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
      const aero = getVesselAeroProfile(v, spec);
      const effRad = (v.tiltAngle || 0) + (v.landingTilt || 0);
      octx.save();
      octx.scale(sx, sy);
      octx.translate(v.x, v.y);
      octx.rotate(effRad);
      if (v.isInverted) octx.scale(1, -1);

      // Rasterize true VesselGeometry curve with crisp ~1.25-texel wall so narrow necks stay open
      octx.lineWidth = Math.max(3.6, 1.32 / Math.min(sx, sy));
      octx.lineJoin = 'round';
      octx.lineCap = 'round';
      octx.strokeStyle = '#ff0000';
      traceVesselPath(octx, spec, 0, 0, v.softenSagFrac || 0);
      octx.stroke();

      // Rasterize current liquid body inside interior clip so gas circulates strictly in headspace above liquid
      const liqMl = computeLiquidVolumeL(v.moles || {}, v.tempK || 298.15) * 1000;
      if (liqMl > 0.25 && spec.geometry && !spec.isHorizontalTube && !spec.isUTube) {
        const fg = computeVesselFluidGeometry(spec, 0, liqMl);
        const surfY = fg.surfaceY;
        const botY = fg.bottom + 4;
        if (botY > surfY + 1) {
          octx.save();
          traceVesselInteriorClip(octx, spec, 0, 0, v.softenSagFrac || 0);
          octx.clip();
          octx.fillRect(-spec.width, surfY, spec.width * 2, botY - surfY);
          octx.restore();
        }
      }

      // If stoppered or closed lid, seal the true geometry mouth in obstacle mask
      if (v.isStoppered || (spec.hasLid && v.lidState === 'closed')) {
        octx.fillRect(-aero.mouthHalfPx - 2, aero.topLocalY - 2, aero.mouthHalfPx * 2 + 4, 4.5);
      }
      octx.restore();
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.obsTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.obsCanvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  _splat(targetDFBO, uvX, uvY, radius, val4, respectObs = 1) {
    const gl = this.gl;
    const prog = this.programs.splat;
    this._bindQuad(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targetDFBO.read.tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTarget'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.obsTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uObs'), 1);
    gl.uniform2f(gl.getUniformLocation(prog, 'uPoint'), uvX, uvY);
    gl.uniform1f(gl.getUniformLocation(prog, 'uRadius'), radius);
    gl.uniform4f(gl.getUniformLocation(prog, 'uValue'), val4[0], val4[1], val4[2], val4[3]);
    gl.uniform2f(gl.getUniformLocation(prog, 'uAspect'), 16 / 9, 1.0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uRespectObs'), respectObs);
    this._blit(targetDFBO.write.fbo, SIM_W, SIM_H);
    targetDFBO.swap();
  }

  _clearAllTargets() {
    const gl = this.gl;
    if (!gl || !this.canvas) return;
    const clearFbo = (fbo, w, h) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    };
    if (this.vel) {
      clearFbo(this.vel.read.fbo, SIM_W, SIM_H);
      clearFbo(this.vel.write.fbo, SIM_W, SIM_H);
    }
    if (this.dye) {
      clearFbo(this.dye.read.fbo, SIM_W, SIM_H);
      clearFbo(this.dye.write.fbo, SIM_W, SIM_H);
    }
    if (this.tempBuoy) {
      clearFbo(this.tempBuoy.read.fbo, SIM_W, SIM_H);
      clearFbo(this.tempBuoy.write.fbo, SIM_W, SIM_H);
    }
    clearFbo(null, this.canvas.width, this.canvas.height);
  }

  reset() {
    this._idleSec = 0;
    this._stepAccumDt = 0;
    this._obsSig = '';
    this._lastObsMs = 0;
    this._hasPlumeEnergy = false;
    if (this.enabled) {
      this._clearAllTargets();
      this.isSleeping = true;
    }
  }

  _collectEmitters(items, envT, opticsMode) {
    const burners = [];
    const heatVessels = [];
    const plumeVessels = [];
    const electrodeEmitters = [];

    // Identify uncollected bubbling electrodes so their open-air plumes spawn at el.x rather than host v.x
    const electrodesByVessel = new Map();
    for (const it of items) {
      if (it.kind === 'electrode' && it.dockedVesselId) {
        if (!electrodesByVessel.has(it.dockedVesselId)) electrodesByVessel.set(it.dockedVesselId, []);
        electrodesByVessel.get(it.dockedVesselId).push(it);
      }
    }

    for (const it of items) {
      if (it.kind === 'burner' && (it.powerW || 0) > 0) {
        burners.push(it);
        continue;
      }
      if (it.kind === 'bath' && !it.isBroken) {
        const bathC = it.bathTargetC ?? (it.bathMode === 'ice_salt' ? -10 : 0);
        const bathK = bathC + 273.15;
        const dTK = bathK - envT;
        if (dTK > 5) {
          const dTNorm = Math.min(1.0, Math.pow(dTK / 145, 0.72));
          heatVessels.push({ it, dTNorm, isBath: true, bathC });
        } else if (opticsMode === 'thermal' && dTK < -5) {
          heatVessels.push({ it, dTNorm: 0, isBath: true, isColdBath: true, bathC });
        }
        continue;
      }
      if (it.kind !== 'vessel' || it.isShattered) continue;
      const spec = APPARATUS[it.typeId] || APPARATUS.beaker_250;
      const head = it.headspaceGasMoles || {};
      const rateMap = it.lastGasRateMap || {};
      const hasTubing = Boolean(it.connectedTargetId || it.connectedSyringeId || it.connectedFromId);
      const isSealedStopper = Boolean(it.isStoppered && (it.stopperMode === 'solid' || hasTubing));
      const isOneHoleVent = Boolean(it.isStoppered && it.stopperMode !== 'solid' && !hasTubing);

      // Collect independent open electrode gas plumes inside unstoppered vessels
      const vesselEls = electrodesByVessel.get(it.id) || [];
      const activeOpenEls = [];
      let hasAnyElectrodeRate = 0;
      if (!isSealedStopper && !it.isStoppered) {
        for (const el of vesselEls) {
          if (!el.gasBubbleType || (el.gasBubbleRate || 0) <= 1e-7) continue;
          const mountedTube = items.find((tIt) => tIt.kind === 'vessel' && tIt.mountedOverElectrodeId === el.id && !tIt.isShattered);
          if (el.gasTargetId || mountedTube) continue;
          const elRate = el.gasBubbleRate || 0;
          hasAnyElectrodeRate += elRate;
          activeOpenEls.push(el);
          const rgb = GAS_COLOR_MAP[el.gasBubbleType] || [0.85, 0.92, 0.98];
          const aero = getVesselAeroProfile(it, spec);
          const emitY = aero.mouthY - 2;
          electrodeEmitters.push({
            el,
            gasId: el.gasBubbleType,
            rgb,
            rate: elRate,
            x: el.x,
            y: emitY,
            relD: getGasRelativeAirDensity(el.gasBubbleType),
          });
        }
      }

      let sumColor = [0, 0, 0];
      let totalVisMol = 0;
      let weightedRelD = 0;

      for (const [gId, rgb] of Object.entries(GAS_COLOR_MAP)) {
        const mHead = head[gId] || 0;
        const mRate = (rateMap[gId] || 0) * 0.24;
        const weight = mHead + mRate;
        if (weight <= 1e-6) continue;
        // Avoid double-emitting at vessel center if open electrodes already account for the vessel's gas evolution
        if (activeOpenEls.some((el) => el.gasBubbleType === gId) && mHead <= 1e-6) continue;
        const isColored = gId === 'NO2_g' || gId === 'Br2_g' || gId === 'I2_g' || gId === 'Cl2_g';
        const visScale = isColored
          ? 220
          : opticsMode === 'aerodynamics'
          ? 145
          : gId === 'H2O_g' || gId === 'HCl_g'
          ? 85
          : 26;
        const w = Math.min(0.68, weight * visScale);
        sumColor[0] += rgb[0] * w;
        sumColor[1] += rgb[1] * w;
        sumColor[2] += rgb[2] * w;
        totalVisMol += w;
        weightedRelD += w * getGasRelativeAirDensity(gId);
      }

      const dTK = Math.max(0, (it.tempK || envT) - envT);
      const dTNorm = dTK > 3 ? Math.min(1.0, Math.pow(dTK / 145, 0.72)) : 0;
      if (dTNorm > 0.04) {
        heatVessels.push({ it, dTNorm });
      }

      if (isSealedStopper) continue;

      const hasThermalGasOut = opticsMode === 'thermal' && dTNorm > 0.05 && totalVisMol > 0.002;
      if (totalVisMol > 0.015 || hasThermalGasOut) {
        plumeVessels.push({ it, spec, sumColor, totalVisMol, weightedRelD, dTNorm, isOneHoleVent, hasThermalGasOut });
      }
    }
    return { burners, heatVessels, plumeVessels, electrodeEmitters };
  }

  stepAndRender(sim, dtRaw, isDark) {
    if (!this.enabled || !sim) return;
    const gl = this.gl;
    const dt = Math.max(0.008, Math.min(0.035, dtRaw || 0.016));
    const items = sim.items || [];
    const envT = sim.environment?.tempK || CONSTANTS.T_STD_K;
    const opticsMode = sim.environment?.opticsMode || 'normal';

    const { burners, heatVessels, plumeVessels, electrodeEmitters } = this._collectEmitters(items, envT, opticsMode);
    const hasActiveEmitter = burners.length > 0 || heatVessels.length > 0 || plumeVessels.length > 0 || electrodeEmitters.length > 0;

    if (!hasActiveEmitter) {
      if (this.isSleeping) return;
      if (!this._hasPlumeEnergy || this._idleSec >= 2.6) {
        this._clearAllTargets();
        this._hasPlumeEnergy = false;
        this._stepAccumDt = 0;
        this.isSleeping = true;
        return;
      }
      this._idleSec += dt;
    } else {
      if (this.isSleeping) this._stepAccumDt = 1 / 30;
      this.isSleeping = false;
      this._idleSec = 0;
      this._hasPlumeEnergy = true;
    }

    // Throttle WebGL2 FBO solver steps to ~30 Hz; on skipped frames keep last canvas frame intact (zero flicker)
    this._stepAccumDt += dt;
    if (this._stepAccumDt < 1 / 30) return;
    const simDt = Math.min(0.05, this._stepAccumDt);
    this._stepAccumDt = 0;

    this._updateObstacles(items);

    // 1. Splat emitters from open/inverted/sealed vessels, electrodes and burners
    for (const it of burners) {
      const bSpec = APPARATUS[it.typeId] || APPARATUS.burner;
      const uvX = it.x / BENCH_LOGICAL_W;
      const nozzleY = it.typeId === 'bunsen_burner' ? it.y + bSpec.height / 2 - 68 : it.y + bSpec.height / 2 - 48;
      const uvY = 1.0 - nozzleY / BENCH_LOGICAL_H;
      const normT = Math.min(1.0, (it.powerW / 1400) * 0.85);
      this._splat(this.tempBuoy, uvX, uvY, 0.0011, [normT * simDt * 6.0, 0, 0, 0], 1);
      this._splat(this.vel, uvX, uvY, 0.0011, [0, 0.25 * simDt * 6.0, 0, 0], 1);
    }

    for (const { it, dTNorm, isBath, isColdBath } of heatVessels) {
      const cx = it.x / BENCH_LOGICAL_W;
      const cy = 1.0 - (isBath ? it.y - 10 : it.y) / BENCH_LOGICAL_H;
      if (isBath && !isColdBath) {
        this._splat(this.tempBuoy, cx, cy, 0.0026, [Math.min(0.92, dTNorm) * simDt * 4.5, 0, 0, 0], 1);
        this._splat(this.vel, cx, cy, 0.0022, [0, 0.14 * dTNorm * simDt * 4.5, 0, 0], 1);
      } else if (isColdBath) {
        this._splat(this.tempBuoy, cx, cy, 0.0024, [0, 0.25 * simDt * 3.5, 0, 0], 1);
        this._splat(this.vel, cx, cy, 0.0018, [0, -0.08 * simDt * 3.0, 0, 0], 1);
      } else {
        this._splat(this.tempBuoy, cx, cy, 0.0018, [Math.min(0.85, dTNorm) * simDt * 4.2, 0, 0, 0], 1);
      }
    }

    for (const em of electrodeEmitters) {
      const uvX = em.x / BENCH_LOGICAL_W;
      const uvY = 1.0 - em.y / BENCH_LOGICAL_H;
      const str = Math.min(0.32, Math.max(0.08, em.rate * 420) * simDt * 2.6);
      const isHeavy = em.relD >= 1.0;
      const buoyDrive = isHeavy ? Math.min(1.6, (em.relD - 1.0) * 1.1) : -Math.min(1.8, (1.0 - em.relD) * 1.9);
      this._splat(this.dye, uvX, uvY, 0.0009, [em.rgb[0] * str, em.rgb[1] * str, em.rgb[2] * str, str], 1);
      this._splat(this.tempBuoy, uvX, uvY, 0.0011, [0, buoyDrive * simDt * 4.5, 0, 0], 1);
      this._splat(this.vel, uvX, uvY, 0.0009, [0, (isHeavy ? -0.18 : 0.34) * simDt * 5.0, 0, 0], 1);
    }

    for (const { it, spec, sumColor, totalVisMol, weightedRelD, dTNorm, isOneHoleVent, hasThermalGasOut } of plumeVessels) {
      const avgRelD = totalVisMol > 1e-5 ? weightedRelD / totalVisMol : 1.0;
      const aero = getVesselAeroProfile(it, spec);
      const isHeavy = avgRelD >= 1.0 && dTNorm < 0.35;
      const emitPt =
        aero.tiltDegEff >= 5 && !aero.isInvertedEffective
          ? isHeavy
            ? aero.lowRim
            : aero.highRim
          : { x: aero.mouthX, y: aero.mouthY };
      // Push emission slightly past rim/mouth outside obstacle stroke so Venturi jet shoots unobstructed
      const nOffset = aero.isInvertedEffective ? 3.5 : 2.5;
      const mx = emitPt.x + aero.exitDir.x * nOffset;
      const my = emitPt.y + aero.exitDir.y * nOffset;
      const uvX = mx / BENCH_LOGICAL_W;
      const uvY = 1.0 - my / BENCH_LOGICAL_H;

      const effVis = Math.max(totalVisMol, hasThermalGasOut ? 0.16 : 0);
      const ventScale = isOneHoleVent ? 0.18 : 1.0;
      const cR = totalVisMol > 1e-5 ? sumColor[0] / totalVisMol : 0.92;
      const cG = totalVisMol > 1e-5 ? sumColor[1] / totalVisMol : 0.55;
      const cB = totalVisMol > 1e-5 ? sumColor[2] / totalVisMol : 0.25;
      const strength = Math.min(0.36, effVis * simDt * 2.5) * ventScale;
      const splatRadius = Math.max(0.0008, Math.min(0.0020, 0.0008 + (aero.mouthHalfPx / 32) * 0.0009));
      this._splat(this.dye, uvX, uvY, splatRadius, [cR * strength, cG * strength, cB * strength, strength], 1);

      // Venturi exit velocity jet proportional to gas flux & throat constriction ratio (WebGL +Y = canvas -Y)
      const jetMag = Math.min(0.55, (0.14 + 0.16 * aero.throatRatio) * Math.max(0.3, effVis)) * ventScale;
      this._splat(
        this.vel,
        uvX,
        uvY,
        splatRadius * 1.15,
        [aero.exitDir.x * jetMag * simDt * 6.0, -aero.exitDir.y * jetMag * simDt * 6.0, 0, 0],
        1
      );

      // Buoyancy weight: heavy gas > 1 sinks (-Y), light or thermally hot gas rises (+Y)
      const buoyDrive = avgRelD >= 1.0 ? Math.min(1.8, (avgRelD - 1.0) * 1.15) : -Math.min(1.6, (1.0 - avgRelD) * 1.8);
      const thermalDrive = Math.min(0.95, dTNorm * (opticsMode === 'thermal' ? 2.4 : 1.25));
      this._splat(
        this.tempBuoy,
        uvX,
        uvY,
        hasThermalGasOut ? 0.0022 : splatRadius * 1.2,
        [thermalDrive * simDt * 3.8 * ventScale, (buoyDrive - dTNorm * 0.9) * simDt * 4.5 * ventScale, 0, 0],
        1
      );
    }

    // 2. Buoyancy & thermal vortex force
    {
      const p = this.programs.buoyancy;
      this._bindQuad(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.vel.read.tex);
      gl.uniform1i(gl.getUniformLocation(p, 'uVel'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.tempBuoy.read.tex);
      gl.uniform1i(gl.getUniformLocation(p, 'uTempBuoy'), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.obsTex);
      gl.uniform1i(gl.getUniformLocation(p, 'uObs'), 2);
      gl.uniform1f(gl.getUniformLocation(p, 'uDt'), simDt);
      gl.uniform1f(gl.getUniformLocation(p, 'uCurlAmp'), 1.35);
      gl.uniform2f(gl.getUniformLocation(p, 'uTexel'), 1 / SIM_W, 1 / SIM_H);
      this._blit(this.vel.write.fbo, SIM_W, SIM_H);
      this.vel.swap();
    }

    // 3. Divergence & Jacobi pressure projection (14 iterations)
    {
      const p = this.programs.divergence;
      this._bindQuad(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.vel.read.tex);
      gl.uniform1i(gl.getUniformLocation(p, 'uVel'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.obsTex);
      gl.uniform1i(gl.getUniformLocation(p, 'uObs'), 1);
      gl.uniform2f(gl.getUniformLocation(p, 'uTexel'), 1 / SIM_W, 1 / SIM_H);
      this._blit(this.divergence.fbo, SIM_W, SIM_H);
    }
    {
      const p = this.programs.pressure;
      this._bindQuad(p);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.divergence.tex);
      gl.uniform1i(gl.getUniformLocation(p, 'uDiv'), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.obsTex);
      gl.uniform1i(gl.getUniformLocation(p, 'uObs'), 2);
      gl.uniform2f(gl.getUniformLocation(p, 'uTexel'), 1 / SIM_W, 1 / SIM_H);
      for (let i = 0; i < 14; i++) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.tex);
        gl.uniform1i(gl.getUniformLocation(p, 'uPress'), 0);
        this._blit(this.pressure.write.fbo, SIM_W, SIM_H);
        this.pressure.swap();
      }
    }
    {
      const p = this.programs.gradient;
      this._bindQuad(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.tex);
      gl.uniform1i(gl.getUniformLocation(p, 'uPress'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.vel.read.tex);
      gl.uniform1i(gl.getUniformLocation(p, 'uVel'), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.obsTex);
      gl.uniform1i(gl.getUniformLocation(p, 'uObs'), 2);
      gl.uniform2f(gl.getUniformLocation(p, 'uTexel'), 1 / SIM_W, 1 / SIM_H);
      this._blit(this.vel.write.fbo, SIM_W, SIM_H);
      this.vel.swap();
    }

    // 4. Advect Velocity, Dye, and Temp/Buoyancy
    const advectField = (dfbo, diss) => {
      const p = this.programs.advect;
      this._bindQuad(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.vel.read.tex);
      gl.uniform1i(gl.getUniformLocation(p, 'uVel'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dfbo.read.tex);
      gl.uniform1i(gl.getUniformLocation(p, 'uSource'), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.obsTex);
      gl.uniform1i(gl.getUniformLocation(p, 'uObs'), 2);
      gl.uniform1f(gl.getUniformLocation(p, 'uDt'), simDt);
      gl.uniform1f(gl.getUniformLocation(p, 'uDissipate'), diss);
      gl.uniform2f(gl.getUniformLocation(p, 'uTexel'), 1 / SIM_W, 1 / SIM_H);
      this._blit(dfbo.write.fbo, SIM_W, SIM_H);
      dfbo.swap();
    };
    advectField(this.vel, 0.985);
    advectField(this.dye, 0.986);
    advectField(this.tempBuoy, 0.982);

    // 5. Render smooth upsampled gas or FLIR thermal plume texture to overlay canvas
    const dp = this.programs.display;
    this._bindQuad(dp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dye.read.tex);
    gl.uniform1i(gl.getUniformLocation(dp, 'uDye'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tempBuoy.read.tex);
    gl.uniform1i(gl.getUniformLocation(dp, 'uTempBuoy'), 1);
    gl.uniform1i(gl.getUniformLocation(dp, 'uModeThermal'), opticsMode === 'thermal' ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(dp, 'uIsDark'), isDark ? 1.0 : 0.0);
    this._blit(null, this.canvas.width, this.canvas.height);
  }
}
