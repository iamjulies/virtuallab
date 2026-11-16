import { APPARATUS } from '../data/apparatus.js';
import { CONSTANTS } from '../data/constants.js';
import { computeLiquidVolumeL, computePH, computeSolutionVisuals } from '../engine/equilibrium.js';
import { computeSyringeDischargeArc, computeSyringeLiquidVolumeMl } from '../engine/gasNetwork.js';
import {
  renderBurner,
  renderGasSyringe,
  renderPipette,
  renderRetortClampJaw,
  renderRetortStand,
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
    this.langCode = 'vi';
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

  setLang(langCode) {
    this.langCode = langCode || 'vi';
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

  findSyringeAt(lx, ly) {
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const it = this.sim.items[i];
      if (it.kind !== 'gas_syringe' || it.isBroken) continue;
      const spec = APPARATUS[it.typeId];
      const hw = spec.width / 2 + 12;
      const hh = spec.height / 2 + 18;
      if (lx >= it.x - hw && lx <= it.x + hw && ly >= it.y - hh && ly <= it.y + hh) {
        return it;
      }
    }
    return null;
  }

  findStandNear(item) {
    if (!item || (item.kind !== 'vessel' && item.kind !== 'gas_syringe')) return null;
    for (const stand of this.sim.items) {
      if (stand.kind !== 'stand') continue;
      const sSpec = APPARATUS.retort_stand;
      const standTop = stand.y - sSpec.height / 2;
      const rodX = stand.x + 36;
      const distX = Math.abs(item.x - (item.kind === 'gas_syringe' ? rodX - 45 : rodX - 28));
      const maxPullDist = item.kind === 'gas_syringe' ? 88 : 54;
      if (distX <= maxPullDist && item.y >= standTop + 10 && item.y <= BENCH_FLOOR_Y - 30) {
        return stand;
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
        hit.isDragging = true;
        hit.vy = 0;
        hit.fallStartY = hit.y;
        hit.restingOnId = null;
        // Bring dragged item to front visually unless it's a support base (scale/burner/stand)
        if (hit.kind === 'vessel' || hit.kind === 'pipette' || hit.kind === 'gas_syringe') {
          this.sim.items = this.sim.items.filter((i) => i.id !== hit.id);
          this.sim.items.push(hit);
        }
        this.dragState = {
          itemId: hit.id,
          offsetX: pt.x - hit.x,
          offsetY: pt.y - hit.y,
          prevX: hit.x,
          prevY: hit.y,
          pourTargetId: null,
          pipetteTargetId: null,
          clampStandId: hit.clampedToId || null,
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
      const nextX = Math.max(60, Math.min(BENCH_LOGICAL_W - 60, pt.x - this.dragState.offsetX));
      const nextY = Math.max(65, Math.min(BENCH_FLOOR_Y - spec.height / 2 + 4, pt.y - this.dragState.offsetY));
      const dxMove = nextX - item.x;
      const dyMove = nextY - item.y;
      item.x = nextX;
      item.y = nextY;
      item.vy = 0;
      item.fallStartY = item.y;

      // Move clamped items along with stand when dragging a Retort Stand
      if (item.kind === 'stand') {
        for (const child of this.sim.items) {
          if (child.clampedToId === item.id) {
            child.x = Math.max(60, Math.min(BENCH_LOGICAL_W - 60, child.x + dxMove));
            child.y = Math.max(65, Math.min(BENCH_FLOOR_Y - APPARATUS[child.typeId].height / 2 - 4, child.y + dyMove));
          }
        }
      }

      // Check Retort Stand clamp snap/release for vessels & syringes
      if ((item.kind === 'vessel' && !item.isShattered) || (item.kind === 'gas_syringe' && !item.isBroken)) {
        const stand = this.findStandNear(item);
        if (stand && item.y < BENCH_FLOOR_Y - spec.height / 2 - 20) {
          this.dragState.clampStandId = stand.id;
          item.clampedToId = stand.id;
        } else {
          this.dragState.clampStandId = null;
          item.clampedToId = null;
        }
      }

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
      } else if (item.kind === 'pipette' && !item.isBroken) {
        const tgt = this.findVesselAt(item.x, item.y + spec.height * 0.28);
        const syrTgt = !tgt ? this.findSyringeAt(item.x, item.y + spec.height * 0.28) : null;
        if (tgt && !tgt.isShattered && !tgt.isStoppered) {
          this.dragState.pipetteTargetId = tgt.id;
          this.dropTargetVesselId = tgt.id;
          item.tiltAngle = -0.14;
          const hasVol = (item.volumeMl || 0) > 0.05;
          item.hoveredActionLabel = hasVol
            ? this.langCode === 'vi'
              ? `💧 Thả nhỏ (${(item.dropDoseMl || 1).toFixed(2)} mL)`
              : `💧 Drop (${(item.dropDoseMl || 1).toFixed(2)} mL)`
            : this.langCode === 'vi'
            ? '🧪 Thả hút (≤10 mL)'
            : '🧪 Drop to draw (≤10 mL)';
        } else if (syrTgt && (item.volumeMl || 0) <= 0.05 && computeSyringeLiquidVolumeMl(syrTgt, this.sim.environment) > 0.02) {
          this.dragState.pipetteTargetId = syrTgt.id;
          this.dropTargetVesselId = syrTgt.id;
          item.tiltAngle = -0.14;
          item.hoveredActionLabel =
            this.langCode === 'vi' ? '🧪 Hút từ Syringe (≤10 mL)' : '🧪 Draw from Syringe';
        } else {
          this.dragState.pipetteTargetId = null;
          this.dropTargetVesselId = null;
          item.tiltAngle = 0;
          item.hoveredActionLabel = null;
        }
      }

      this.sim.recomputeScaleReadings();
    });

    const endDrag = (e) => {
      if (!this.dragState) return;
      try {
        const item = this.sim.getItem(this.dragState.itemId);
        const pipTargetId = this.dragState.pipetteTargetId;
        if (item) {
          item.isDragging = false;
          item.fallStartY = item.clampedToId ? null : item.y;
          item.vy = 0;
        }
        if (item && (item.kind === 'vessel' || item.kind === 'pipette')) {
          item.tiltAngle = 0;
        }
        if (item && item.kind === 'pipette' && !item.isBroken) {
          item.hoveredActionLabel = null;
          if (pipTargetId) {
            const tgt = this.sim.getItem(pipTargetId);
            if (tgt && tgt.kind === 'vessel' && !tgt.isShattered && !tgt.isStoppered) {
              if ((item.volumeMl || 0) <= 0.05) {
                this.sim.pipetteDrawFromVessel(tgt.id, item.capacityMl || 10.0, item);
              } else {
                this.sim.pipetteDispenseToVessel(tgt.id, item.dropDoseMl || 1.0, item);
              }
              const tSpec = APPARATUS[tgt.typeId];
              const pSpec = APPARATUS[item.typeId];
              const parkRightX = tgt.x + tSpec.width / 2 + 26;
              const parkLeftX = tgt.x - tSpec.width / 2 - 26;
              item.x = parkRightX <= BENCH_LOGICAL_W - 45 ? parkRightX : Math.max(45, parkLeftX);
              item.y = BENCH_FLOOR_Y - pSpec.height / 2 + 2;
              item.fallStartY = null;
            } else if (tgt && tgt.kind === 'gas_syringe' && !tgt.isBroken && (item.volumeMl || 0) <= 0.05) {
              this.sim.pipetteDrawFromSyringe(tgt.id, item.capacityMl || 10.0, item);
              const pSpec = APPARATUS[item.typeId];
              item.x = Math.max(45, tgt.x - APPARATUS.gas_syringe.width / 2 - 24);
              item.y = BENCH_FLOOR_Y - pSpec.height / 2 + 2;
              item.fallStartY = null;
            }
          }
        }
      } finally {
        this.dragState = null;
        this.dropTargetVesselId = null;
        this.canvas.style.cursor = 'default';
        if (e?.pointerId != null && this.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            this.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        this.sim.updateSupportAttachments();
        this.sim.emitChange();
      }
    };

    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('lostpointercapture', endDrag);
    window.addEventListener('blur', endDrag);

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
        const hoverVessel = apparatusId === 'pipette_10' ? this.findVesselAt(pt.x, pt.y) : null;
        const hoverSyr = apparatusId === 'pipette_10' && !hoverVessel ? this.findSyringeAt(pt.x, pt.y) : null;
        const clampedX = Math.max(70, Math.min(BENCH_LOGICAL_W - 70, pt.x));
        const clampedY = Math.min(BENCH_FLOOR_Y - (spec?.height || 100) / 2 + 2, Math.max(80, pt.y));
        const created = this.sim.createApparatus(apparatusId, clampedX, clampedY);
        if (created) {
          const nearStand = this.findStandNear(created);
          if (nearStand && created.y < BENCH_FLOOR_Y - (spec?.height || 100) / 2 - 20) {
            this.sim.attachToStand(created.id, nearStand.id);
          } else {
            created.fallStartY = created.y;
          }
        }
        if (created && hoverVessel && !hoverVessel.isShattered && !hoverVessel.isStoppered) {
          const drew = this.sim.pipetteDrawFromVessel(hoverVessel.id, created.capacityMl || 10.0, created);
          if (drew > 0) {
            const hSpec = APPARATUS[hoverVessel.typeId];
            const parkRightX = hoverVessel.x + hSpec.width / 2 + 26;
            const parkLeftX = hoverVessel.x - hSpec.width / 2 - 26;
            created.x = parkRightX <= BENCH_LOGICAL_W - 45 ? parkRightX : Math.max(45, parkLeftX);
            created.y = BENCH_FLOOR_Y - spec.height / 2 + 2;
            created.fallStartY = null;
          }
        } else if (created && hoverSyr && !hoverSyr.isBroken) {
          const drew = this.sim.pipetteDrawFromSyringe(hoverSyr.id, created.capacityMl || 10.0, created);
          if (drew > 0) {
            created.x = Math.max(45, hoverSyr.x - APPARATUS.gas_syringe.width / 2 - 24);
            created.y = BENCH_FLOOR_Y - spec.height / 2 + 2;
            created.fallStartY = null;
          }
        }
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

    // 2. Render supports & stands behind, clamp jaws, then Syringes, Vessels, and Pipettes on top
    renderTubingConnections(ctx, this.sim.items, this.isDark, timeNow, this.langCode);

    const ordered = [
      ...this.sim.items.filter((i) => i.kind === 'stand'),
      ...this.sim.items.filter((i) => i.kind === 'scale' || i.kind === 'burner'),
      ...this.sim.items.filter((i) => i.kind === 'gas_syringe'),
      ...this.sim.items.filter((i) => i.kind === 'vessel'),
      ...this.sim.items.filter((i) => i.kind === 'pipette'),
    ];

    for (const item of ordered) {
      const isSelected = item.id === this.sim.selectedId;
      if (item.kind === 'stand') {
        renderRetortStand(ctx, item, isSelected, this.isDark);
      } else if (item.kind === 'scale') {
        renderScale(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'burner') {
        renderBurner(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'gas_syringe') {
        renderGasSyringe(ctx, item, isSelected, this.isDark, this.sim.environment, this.langCode, timeNow);
      } else if (item.kind === 'vessel') {
        renderVessel(ctx, item, {
          isSelected,
          isDropTarget: item.id === this.dropTargetVesselId,
          isDark: this.isDark,
          timeNow,
          langCode: this.langCode,
        });
      } else if (item.kind === 'pipette') {
        renderPipette(ctx, item, isSelected, this.isDark, this.langCode, timeNow);
      }

      if (item.clampedToId) {
        const st = this.sim.getItem(item.clampedToId);
        if (st && st.kind === 'stand') {
          renderRetortClampJaw(ctx, st, item, this.isDark);
        }
      }
    }

    // Show parabolic aim trajectory guide when selecting a Gas Syringe containing liquid (so user can align a catching vessel below)
    const selItem = this.sim.getItem(this.sim.selectedId);
    if (
      selItem &&
      selItem.kind === 'gas_syringe' &&
      !selItem.isBroken &&
      !selItem.connectedFromId &&
      computeSyringeLiquidVolumeMl(selItem, this.sim.environment) > 0.05 &&
      (selItem.dischargeLiquidRateMlS || 0) <= 0.15
    ) {
      const aimArc = computeSyringeDischargeArc(
        selItem,
        this.sim.items,
        BENCH_FLOOR_Y,
        CONSTANTS.GRAVITY_PX_S2 || 1800
      );
      if (aimArc.points.length >= 2) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = aimArc.hitTargetVessel ? 'rgba(16, 185, 129, 0.72)' : 'rgba(148, 163, 184, 0.36)';
        ctx.lineWidth = aimArc.hitTargetVessel ? 2.0 : 1.3;
        ctx.beginPath();
        ctx.moveTo(aimArc.points[0].x, aimArc.points[0].y);
        for (let i = 1; i < aimArc.points.length; i++) {
          ctx.lineTo(aimArc.points[i].x, aimArc.points[i].y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        if (aimArc.hitTargetVessel) {
          ctx.fillStyle = 'rgba(16, 185, 129, 0.85)';
          ctx.beginPath();
          ctx.arc(aimArc.hitX, aimArc.hitY, 4.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
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
