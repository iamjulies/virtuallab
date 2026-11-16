import { APPARATUS } from '../data/apparatus.js';
import { computeLiquidVolumeL, computePH, computeSolutionVisuals } from '../engine/equilibrium.js';
import {
  renderBurner,
  renderGasSyringe,
  renderScale,
  renderTubingConnections,
  renderVessel,
} from './vesselRenderer.js';

export const BENCH_LOGICAL_W = 1000;
export const BENCH_LOGICAL_H = 560;
export const BENCH_FLOOR_Y = 482;

export class LabWorkbenchCanvas {
  constructor(canvas, sim, particles, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = sim;
    this.particles = particles;
    this.callbacks = callbacks; // { onSelect, onRequestDosing, onDropApparatus }

    this.isDark = true;
    this.dragState = null; // { itemId, offsetX, offsetY, startX, startY, pourTargetId, pouredMl }
    this.hoverItemId = null;
    this.dropTargetVesselId = null;
    this.scaleX = 1;
    this.scaleY = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.shakeTimer = 0;
    this.shakeDuration = 0;
    this.shakeMagnitude = 0;
    this.lastRenderMs = performance.now();

    this.bindEvents();
    this.resize();
  }

  triggerShake(magnitude = 9, duration = 0.36) {
    this.shakeMagnitude = Math.max(this.shakeMagnitude, magnitude);
    this.shakeDuration = Math.max(this.shakeDuration, duration);
    this.shakeTimer = Math.max(this.shakeTimer, duration);
  }

  setTheme(isDark) {
    this.isDark = isDark;
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(300, Math.floor(rect.width));
    const h = Math.max(260, Math.floor(rect.height));

    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    // Uniform scale preserving aspect ratio centered inside container
    const scale = Math.min(w / BENCH_LOGICAL_W, h / BENCH_LOGICAL_H);
    this.viewScale = scale;
    this.viewOffsetX = (w - BENCH_LOGICAL_W * scale) / 2;
    this.viewOffsetY = (h - BENCH_LOGICAL_H * scale) / 2;
    this.dpr = dpr;
  }

  clientToLogical(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    return {
      x: (cx - this.viewOffsetX) / this.viewScale,
      y: (cy - this.viewOffsetY) / this.viewScale,
    };
  }

  hitTestItem(lx, ly, excludeId = null) {
    // Reverse draw order so top-most item wins
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const it = this.sim.items[i];
      if (it.id === excludeId) continue;
      const spec = APPARATUS[it.typeId];
      const hw = spec.width / 2 + 8;
      const hh = spec.height / 2 + 10;
      if (lx >= it.x - hw && lx <= it.x + hw && ly >= it.y - hh && ly <= it.y + hh) {
        return it;
      }
    }
    return null;
  }

  findVesselAt(lx, ly, excludeId = null) {
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const it = this.sim.items[i];
      if (it.kind !== 'vessel' || it.id === excludeId) continue;
      const spec = APPARATUS[it.typeId];
      const hw = spec.width / 2 + 24;
      const hh = spec.height / 2 + 36;
      if (lx >= it.x - hw && lx <= it.x + hw && ly >= it.y - hh && ly <= it.y + hh) {
        return it;
      }
    }
    return null;
  }

  bindEvents() {
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas.parentElement);

    // Unified pointer events for Mouse + Touch + Pen
    this.canvas.addEventListener('pointerdown', (e) => {
      const pt = this.clientToLogical(e.clientX, e.clientY);
      const hit = this.hitTestItem(pt.x, pt.y);
      if (hit) {
        this.sim.selectedId = hit.id;
        // Bring dragged item to front visually unless it's a support base (scale/burner)
        if (hit.kind === 'vessel') {
          this.sim.items = this.sim.items.filter((i) => i.id !== hit.id);
          this.sim.items.push(hit);
        }
        this.dragState = {
          itemId: hit.id,
          offsetX: pt.x - hit.x,
          offsetY: pt.y - hit.y,
          pourTargetId: null,
          pouredMl: 0,
        };
        this.canvas.setPointerCapture(e.pointerId);
        if (this.callbacks.onSelect) this.callbacks.onSelect(hit);
        this.sim.emitChange();
      } else {
        this.sim.selectedId = null;
        if (this.callbacks.onSelect) this.callbacks.onSelect(null);
        this.sim.emitChange();
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const pt = this.clientToLogical(e.clientX, e.clientY);
      if (!this.dragState) {
        const hit = this.hitTestItem(pt.x, pt.y);
        this.hoverItemId = hit ? hit.id : null;
        this.canvas.style.cursor = hit ? 'grab' : 'default';
        return;
      }

      this.canvas.style.cursor = 'grabbing';
      const item = this.sim.getItem(this.dragState.itemId);
      if (!item) return;

      const spec = APPARATUS[item.typeId];
      item.x = Math.max(60, Math.min(BENCH_LOGICAL_W - 60, pt.x - this.dragState.offsetX));
      item.y = Math.max(65, Math.min(BENCH_FLOOR_Y - spec.height / 2 + 4, pt.y - this.dragState.offsetY));

      // If dragging a vessel, check if hovering above another vessel's rim to auto-tilt & pour
      if (item.kind === 'vessel' && !item.isStoppered && !item.isShattered) {
        const liqMl = computeLiquidVolumeL(item.moles, item.tempK) * 1000;
        let target = null;
        if (liqMl > 0.1) {
          for (const other of this.sim.items) {
            if (other.kind !== 'vessel' || other.id === item.id || other.isShattered || other.isStoppered) continue;
            const oSpec = APPARATUS[other.typeId];
            const rimY = other.y - oSpec.height / 2;
            if (Math.abs(item.x - other.x) < 78 && item.y < rimY + 28 && item.y > rimY - 125) {
              target = other;
              break;
            }
          }
        }
        if (target) {
          this.dragState.pourTargetId = target.id;
          this.dropTargetVesselId = target.id;
          item.tiltAngle = item.x >= target.x ? -0.52 : 0.52;
        } else {
          this.dragState.pourTargetId = null;
          this.dropTargetVesselId = null;
          item.tiltAngle = 0;
        }
      }

      this.sim.recomputeScaleReadings();
    });

    const endDrag = () => {
      if (!this.dragState) return;
      const item = this.sim.getItem(this.dragState.itemId);
      if (item && item.kind === 'vessel') {
        item.tiltAngle = 0;
      }
      this.dragState = null;
      this.dropTargetVesselId = null;
      this.sim.updateSupportAttachments();
      this.sim.emitChange();
    };

    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);

    // HTML5 Drag & Drop from Shelf onto Bench
    this.canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      const pt = this.clientToLogical(e.clientX, e.clientY);
      const dragType = e.dataTransfer.types.includes('text/reagent-id') ? 'reagent' : 'unknown';
      const v = this.findVesselAt(pt.x, pt.y);
      this.dropTargetVesselId = v ? v.id : null;
      if (dragType === 'reagent') {
        e.dataTransfer.dropEffect = v ? 'copy' : 'none';
      }
    });

    this.canvas.addEventListener('dragleave', () => {
      this.dropTargetVesselId = null;
    });

    this.canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      const pt = this.clientToLogical(e.clientX, e.clientY);
      const reagentId = e.dataTransfer.getData('text/reagent-id');
      const apparatusId = e.dataTransfer.getData('text/apparatus-id');

      if (apparatusId) {
        const spec = APPARATUS[apparatusId];
        const clampedX = Math.max(70, Math.min(BENCH_LOGICAL_W - 70, pt.x));
        const clampedY = Math.min(BENCH_FLOOR_Y - (spec?.height || 100) / 2, Math.max(80, pt.y));
        const created = this.sim.createApparatus(apparatusId, clampedX, clampedY);
        if (created && this.callbacks.onSelect) this.callbacks.onSelect(created);
      } else if (reagentId) {
        const target = this.findVesselAt(pt.x, pt.y);
        if (target && this.callbacks.onRequestDosing) {
          this.sim.selectedId = target.id;
          this.callbacks.onRequestDosing(reagentId, target.id);
        }
      }

      this.dropTargetVesselId = null;
    });
  }

  /**
   * Process continuous drag-pour transfer each frame if user holds tilted vessel above target.
   */
  tickInteractivePour(realDeltaSec) {
    if (!this.dragState || !this.dragState.pourTargetId) return;
    const src = this.sim.getItem(this.dragState.itemId);
    const dst = this.sim.getItem(this.dragState.pourTargetId);
    if (!src || !dst) return;

    const transferRateMlS = 22.0;
    const poured = this.sim.pourBetweenVessels(src.id, dst.id, transferRateMlS * realDeltaSec, true);
    if (poured > 0) {
      this.dragState.pouredMl += poured;
      const srcLiqL = computeLiquidVolumeL(src.moles, src.tempK);
      const color = computeSolutionVisuals(
        src.moles,
        srcLiqL,
        computePH(src.moles, srcLiqL, src.tempK)
      ).css;
      const dstSpec = APPARATUS[dst.typeId];
      this.sim.activePourStream = {
        fromX: src.x + (src.x >= dst.x ? -28 : 28),
        fromY: src.y - 18,
        toX: dst.x,
        toY: dst.y - dstSpec.height * 0.25,
        color,
        timer: 0.12,
        pouredMl: this.dragState.pouredMl,
      };
    }
  }

  render(timeNow) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // Apply DPR + responsive aspect-fit transform + damped shockwave shake
    const nowMs = performance.now();
    const realDt = Math.min(0.05, Math.max(0.001, (nowMs - this.lastRenderMs) / 1000));
    this.lastRenderMs = nowMs;
    let shakeX = 0;
    let shakeY = 0;
    if (this.shakeTimer > 0) {
      this.shakeTimer = Math.max(0, this.shakeTimer - realDt);
      const decay = this.shakeDuration > 0 ? this.shakeTimer / this.shakeDuration : 0;
      const amp = this.shakeMagnitude * decay * decay;
      shakeX = (Math.random() - 0.5) * 2 * amp;
      shakeY = (Math.random() - 0.5) * 2 * amp;
      if (this.shakeTimer === 0) {
        this.shakeMagnitude = 0;
        this.shakeDuration = 0;
      }
    }

    ctx.scale(this.dpr, this.dpr);
    ctx.translate(this.viewOffsetX + shakeX * this.viewScale, this.viewOffsetY + shakeY * this.viewScale);
    ctx.scale(this.viewScale, this.viewScale);

    // 1. Background subtle grid & lab bench surface
    const bgGrid = this.isDark ? 'rgba(148, 163, 184, 0.08)' : 'rgba(15, 23, 42, 0.06)';
    ctx.fillStyle = bgGrid;
    for (let gx = 40; gx < BENCH_LOGICAL_W; gx += 40) {
      for (let gy = 40; gy < BENCH_FLOOR_Y; gy += 40) {
        ctx.fillRect(gx - 1, gy - 1, 2, 2);
      }
    }

    // Lab Bench Table Edge
    const benchGrad = ctx.createLinearGradient(0, BENCH_FLOOR_Y, 0, BENCH_LOGICAL_H);
    if (this.isDark) {
      benchGrad.addColorStop(0, '#1e293b');
      benchGrad.addColorStop(1, '#0f172a');
    } else {
      benchGrad.addColorStop(0, '#cbd5e1');
      benchGrad.addColorStop(1, '#94a3b8');
    }
    ctx.fillStyle = benchGrad;
    ctx.fillRect(0, BENCH_FLOOR_Y, BENCH_LOGICAL_W, BENCH_LOGICAL_H - BENCH_FLOOR_Y);

    ctx.strokeStyle = this.isDark ? '#334155' : '#64748b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, BENCH_FLOOR_Y);
    ctx.lineTo(BENCH_LOGICAL_W, BENCH_FLOOR_Y);
    ctx.stroke();

    // 2. Render rubber tubing behind/between vessels
    renderTubingConnections(ctx, this.sim.items, this.isDark);

    // 3. Render supports first (Scales & Burners), then Syringes, then Vessels on top
    const ordered = [
      ...this.sim.items.filter((i) => i.kind === 'scale' || i.kind === 'burner'),
      ...this.sim.items.filter((i) => i.kind === 'gas_syringe'),
      ...this.sim.items.filter((i) => i.kind === 'vessel'),
    ];

    for (const item of ordered) {
      const isSelected = item.id === this.sim.selectedId;
      if (item.kind === 'scale') {
        renderScale(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'burner') {
        renderBurner(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'gas_syringe') {
        renderGasSyringe(ctx, item, isSelected, this.isDark, this.sim.environment);
      } else if (item.kind === 'vessel') {
        renderVessel(ctx, item, {
          isSelected,
          isDropTarget: item.id === this.dropTargetVesselId,
          isDark: this.isDark,
          timeNow,
        });
      }
    }

    // 4. Render active pouring stream
    if (this.sim.activePourStream) {
      const st = this.sim.activePourStream;
      ctx.save();
      ctx.strokeStyle = st.color || 'rgba(186, 230, 253, 0.8)';
      ctx.lineWidth = 4.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(st.fromX, st.fromY);
      ctx.quadraticCurveTo((st.fromX + st.toX) * 0.5, st.fromY + 25, st.toX, st.toY);
      ctx.stroke();

      if (st.pouredMl > 0) {
        ctx.fillStyle = this.isDark ? '#0f172a' : '#ffffff';
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(st.fromX - 36, st.fromY - 28, 72, 20, 6);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = this.isDark ? '#f8fafc' : '#0f172a';
        ctx.font = 'bold 11.5px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`+${st.pouredMl.toFixed(1)} mL`, st.fromX, st.fromY - 18);
      }
      ctx.restore();
    }

    // 5. Render particles (bubbles, steam, Na yellow flame, sparks, glass shards)
    this.particles.render(ctx);

    ctx.restore();
  }
}
