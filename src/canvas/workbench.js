/**
 * Lab Workbench Interactive Canvas & Render Coordinator (Refactor 81).
 * Input, drop & pour handlers live in ./workbenchInput.js
 */
import {
  APPARATUS,
  clampItemToStandY,
  getCondenserPorts,
  getItemRotatedHalfExtentY,
  getProbeTipPos,
  getSepFunnelMountY,
  getStandGeometry,
  getSyringeGeometry,
  getTubeDestTipPos,
  getVesselEndPorts,
  getVesselTubingPort,
} from '../data/apparatus.js';
import { CONSTANTS } from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { computeLiquidVolumeL, computePH, computeSolutionVisuals } from '../engine/equilibrium.js';
import {
  buildRigidTubePoints,
  computeCondenserOutletGeometry,
  computeSyringeDischargeArc,
  computeSyringeLiquidVolumeMl,
  computeTubingGeometry,
  samplePolylineAt,
} from '../engine/gasNetwork.js';
import {
  checkFlameLoopInteractions,
  checkIndicatorStripInteractions,
  checkSplintInteractions,
  checkThermometerInteractions,
  computeWashBottleStreamArc,
  syncDockedToolPositions,
} from '../engine/apparatusTools.js';
import { stepAnalyticalInstruments } from '../engine/analyticalTools.js';
import { renderActiveReagentTransfer } from './reagentRenderer.js';
import { soundEngine } from '../audio/soundEngine.js';
import { FluidGasOverlay } from './fluidGasOverlay.js';
import {
  beginCanvasLabelFrame,
  flushCanvasLabelFrame,
  formatCanvasText,
  getVesselAeroProfile,
  renderBurner,
  renderGasSyringe,
  renderPipette,
  renderRetortClampJaw,
  renderRetortStand,
  renderScale,
  renderTubingConnections,
  renderVessel,
  setCurrentLabelItemId,
  traceVesselInteriorClip,
} from './vesselRenderer.js';
import {
  renderBurette,
  renderDcPowerAndWires,
  renderDiffusionTube,
  renderElectrodeCollectorTubes,
  renderElectrodeRod,
  renderFilterFunnel,
  renderFlameLoop,
  renderIceBath,
  renderIndicatorStrip,
  renderIronSpoon,
  renderLiebigCondenser,
  renderPhenCotton,
  renderPhConductometer,
  renderColorimeter,
  renderTlcPlate,
  renderRubberStopper,
  renderSaltBridge,
  renderSeparatoryFunnel,
  renderSplint,
  renderStirBar,
  renderBoilingChips,
  renderThermometer,
  renderVoltAmmeterAndWires,
  renderWashBottle,
} from './toolRenderer.js';

import { BENCH_LOGICAL_W, BENCH_LOGICAL_H, BENCH_FLOOR_Y, handleCanvasWheelImpl, setExternalDropPreviewImpl, dropFromShelfImpl, bindWorkbenchEventsImpl, tickInteractivePourImpl } from './workbenchInput.js';
export { BENCH_LOGICAL_W, BENCH_LOGICAL_H, BENCH_FLOOR_Y };

export class LabWorkbenchCanvas {
  constructor(canvas, sim, particles, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = sim;
    this.particles = particles;
    this.callbacks = callbacks; // { onSelect, onRequestDosing, onDropApparatus }

    this.isDark = true;
    this.themeName = 'dark';
    this.langCode = 'vi';
    this.dragState = null; // { itemId, offsetX, offsetY, startX, startY, pourTargetId, pouredMl }
    this.portDragState = null;
    this.tubeTipDragState = null;
    this.hoveredTubeInfo = null;
    this.marqueeState = null;
    this.pickState = null; // { candidateIds: Set<string>, promptText, onPick, onCancel }
    this.hoverItemId = null;
    this._wheelAccum = { key: '', sum: 0 };
    this._pipetteWheelTs = 0;
    this._wheelTiltVesselId = null;
    this.dropTargetVesselId = null;
    this.scaleX = 1;
    this.scaleY = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.shakeTimer = 0;
    this.shakeDuration = 0;
    this.shakeMagnitude = 0;
    this.lastRenderMs = performance.now();
    this.fluidGasOverlay = new FluidGasOverlay();
    this._canvasRect = null;
    this._externalDragActive = false;
    this._extHoverWasOutside = false;
    this._moveRafId = 0;
    this._pendingPointerMove = null;
    this._bgCacheCanvas = null;
    this._bgCacheCtx = null;
    this._bgCacheKey = '';

    // Magnifier / Camera Zoom & Loupe state
    this.zoomMode = false;
    this.zoomScale = 1.0;
    this.zoomCenterX = BENCH_LOGICAL_W * 0.5;
    this.zoomCenterY = BENCH_LOGICAL_H * 0.5;
    this.pointerLogical = null;
    this.panDragState = null;

    this.bindEvents();
    this.resize();
  }

  triggerShake(magnitude = 9, duration = 0.36) {
    this.shakeMagnitude = Math.max(this.shakeMagnitude, magnitude);
    this.shakeDuration = Math.max(this.shakeDuration, duration);
    this.shakeTimer = Math.max(this.shakeTimer, duration);
  }

  triggerHteStorm(strength = 1.0) {
    this._hteStormSurge = Math.max(this._hteStormSurge || 0, Math.min(1.0, strength));
  }

  setTheme(isDark, themeName = isDark ? 'dark' : 'light') {
    this.isDark = isDark;
    this.themeName = themeName || (isDark ? 'dark' : 'light');
    if (this.themeName !== 'hte') {
      this._hteStormLevel = 0;
      this._hteStormSurge = 0;
    }
    this._bgCacheKey = '';
  }

  setLang(langCode) {
    this.langCode = langCode || 'vi';
  }

  setSim(sim, particles = null) {
    this.sim = sim;
    if (particles) this.particles = particles;
    this.dragState = null;
    this.portDragState = null;
    this.pickState = null;
    this.hoverItemId = null;
    this.dropTargetVesselId = null;
    this.fluidGasOverlay?.reset?.();
    this.callbacks.onPickStateChange?.(null);
  }

  startItemPick({ candidateIds = [], promptText = '', onPick = null, onCancel = null } = {}) {
    const idSet = candidateIds instanceof Set ? candidateIds : new Set(candidateIds);
    this.dragState = null;
    this.portDragState = null;
    this.dropTargetVesselId = null;
    this.pickState = {
      candidateIds: idSet,
      promptText,
      onPick,
      onCancel,
    };
    this.callbacks.onPickStateChange?.(this.pickState);
  }

  cancelItemPick() {
    if (!this.pickState) return;
    const cancelFn = this.pickState.onCancel;
    this.pickState = null;
    this.hoverItemId = null;
    this.canvas.style.cursor = 'default';
    this.callbacks.onPickStateChange?.(null);
    cancelFn?.();
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
    this._canvasRect = null;
    this._bgCacheKey = '';
  }

  getZoomState() {
    return {
      zoomMode: this.zoomMode,
      zoomScale: this.zoomScale,
      zoomCenterX: this.zoomCenterX,
      zoomCenterY: this.zoomCenterY,
    };
  }

  toggleZoomMode(forceState = null) {
    const next = forceState === null ? !this.zoomMode : Boolean(forceState);
    this.zoomMode = next;
    if (!next) {
      this.zoomScale = 1.0;
      this.zoomCenterX = BENCH_LOGICAL_W * 0.5;
      this.zoomCenterY = BENCH_LOGICAL_H * 0.5;
      this.panDragState = null;
      this.canvas.style.cursor = 'default';
    } else {
      this.canvas.style.cursor = this.zoomScale > 1.02 ? 'grab' : 'zoom-in';
    }
    this.callbacks.onZoomChange?.(this.getZoomState());
    return this.zoomMode;
  }

  setZoomView(scale, centerX = this.zoomCenterX, centerY = this.zoomCenterY) {
    const nextScale = Math.max(1.0, Math.min(4.2, Number(scale) || 1.0));
    this.zoomScale = nextScale;
    if (nextScale <= 1.01) {
      this.zoomScale = 1.0;
      this.zoomCenterX = BENCH_LOGICAL_W * 0.5;
      this.zoomCenterY = BENCH_LOGICAL_H * 0.5;
    } else {
      const halfW = (BENCH_LOGICAL_W * 0.5) / nextScale;
      const halfH = (BENCH_LOGICAL_H * 0.5) / nextScale;
      this.zoomCenterX = Math.max(halfW * 0.72, Math.min(BENCH_LOGICAL_W - halfW * 0.72, centerX));
      this.zoomCenterY = Math.max(halfH * 0.72, Math.min(BENCH_LOGICAL_H - halfH * 0.72, centerY));
    }
    this.callbacks.onZoomChange?.(this.getZoomState());
  }

  resetZoom() {
    this.setZoomView(1.0, BENCH_LOGICAL_W * 0.5, BENCH_LOGICAL_H * 0.5);
  }

  _upgradeDragToFullUndo() {
    if (!this.dragState || this.dragState.fullUndoRecorded || !this.sim.exportSnapshot) return;
    const fullSnap = this.sim.exportSnapshot();
    const posSnap = this.dragState.preDragSnap;
    if (posSnap?.type === 'positions' && Array.isArray(posSnap.items)) {
      const posById = new Map(posSnap.items.map((p) => [p.id, p]));
      for (const sIt of fullSnap.items || []) {
        const prev = posById.get(sIt.id);
        if (!prev) continue;
        sIt.x = prev.x;
        sIt.y = prev.y;
        sIt.restingOnId = prev.restingOnId;
        sIt.clampedToId = prev.clampedToId;
        sIt.dockedVesselId = prev.dockedVesselId;
        if (prev.dockSide !== undefined) sIt.dockSide = prev.dockSide;
        sIt.mountedOnVesselId = prev.mountedOnVesselId;
        sIt.inVesselId = prev.inVesselId;
        sIt.attachedToId = prev.attachedToId;
        if (prev.attachedSide !== undefined) sIt.attachedSide = prev.attachedSide;
        sIt.fallStartY = prev.fallStartY;
        sIt.tiltAngle = prev.tiltAngle;
        sIt.tiltDeg = prev.tiltDeg;
        sIt.tiltDir = prev.tiltDir;
      }
    }
    const stack = this.sim.undoStack;
    if (this.dragState.undoRecorded && Array.isArray(stack) && stack.length > 0 && stack[stack.length - 1] === posSnap) {
      stack[stack.length - 1] = fullSnap;
    } else {
      this.sim.pushUndoSnapshot?.(fullSnap);
    }
    this.dragState.fullUndoRecorded = true;
    this.dragState.undoRecorded = true;
  }

  _trySetPointerCapture(pointerId) {
    if (pointerId == null || !this.canvas.setPointerCapture) return;
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {}
  }

  _getCanvasRect() {
    if (this._canvasRect) return this._canvasRect;
    const rect = this.canvas.getBoundingClientRect();
    if (
      this.dragState ||
      this.marqueeState ||
      this.panDragState ||
      this.portDragState ||
      this.standResizeState ||
      this.tubeTipDragState ||
      this._externalDragActive
    ) {
      this._canvasRect = rect;
    }
    return rect;
  }

  clientToLogical(clientX, clientY) {
    const rect = this._getCanvasRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const baseX = (cx - this.viewOffsetX) / this.viewScale;
    const baseY = (cy - this.viewOffsetY) / this.viewScale;
    if (this.zoomScale > 1.001) {
      return {
        x: this.zoomCenterX + (baseX - BENCH_LOGICAL_W * 0.5) / this.zoomScale,
        y: this.zoomCenterY + (baseY - BENCH_LOGICAL_H * 0.5) / this.zoomScale,
      };
    }
    return {
      x: baseX,
      y: baseY,
    };
  }

  findCondenserPortAt(lx, ly) {
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const it = this.sim.items[i];
      if (it.isBroken || it.isShattered) continue;
      if (it.kind === 'condenser') {
        const { inlet: portIn, outlet: portOut } = getCondenserPorts(it);
        if (Math.hypot(lx - portIn.x, ly - portIn.y) <= 14) {
          return { cond: it, item: it, kind: 'condenser', port: 'inlet', origin: portIn };
        }
        if (Math.hypot(lx - portOut.x, ly - portOut.y) <= 14) {
          return { cond: it, item: it, kind: 'condenser', port: 'outlet', origin: portOut };
        }
      } else if (it.kind === 'gas_syringe') {
        const { nozzleX, nozzleY } = getSyringeGeometry(it);
        if (Math.hypot(lx - nozzleX, ly - nozzleY) <= 14) {
          return { cond: it, item: it, kind: 'gas_syringe', port: 'nozzle', origin: { x: nozzleX, y: nozzleY } };
        }
      } else if (it.kind === 'vessel') {
        const spec = APPARATUS[it.typeId];
        if (spec?.hasTwoEnds) {
          const ends = getVesselEndPorts(it);
          for (const side of ['left', 'right']) {
            const ep = ends?.[side];
            if (!ep || !ep.stoppered) continue;
            const attachedSt = this.sim.items.find(
              (s) => s.kind === 'rubber_stopper' && s.attachedToId === it.id && (s.attachedSide || 'right') === side
            );
            const isSolid = attachedSt ? attachedSt.stopperMode === 'solid' : it.stopperMode === 'solid';
            if (isSolid) continue;
            if (Math.hypot(lx - ep.x, ly - ep.y) <= 14) {
              return { cond: it, item: it, kind: 'vessel', port: 'stopper', side, origin: ep };
            }
          }
        } else if (it.isStoppered) {
          const attachedSt = this.sim.items.find(
            (s) => s.kind === 'rubber_stopper' && s.attachedToId === it.id
          );
          const isSolid = attachedSt ? attachedSt.stopperMode === 'solid' : it.stopperMode === 'solid';
          if (!isSolid) {
            const vPort = getVesselTubingPort(it);
            if (vPort && Math.hypot(lx - vPort.x, ly - vPort.y) <= 14) {
              return { cond: it, item: it, kind: 'vessel', port: 'stopper', side: 'main', origin: vPort };
            }
          }
        }
      }
    }
    return null;
  }

  findMouthTargetAt(lx, ly, mode = 'stopper') {
    let best = null;
    let bestD = Infinity;
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const v = this.sim.items[i];
      if (v.kind !== 'vessel' || v.isShattered) continue;
      const spec = APPARATUS[v.typeId];
      if (!spec) continue;
      if (mode === 'stopper' && !spec.stopperable) continue;
      if (spec.hasTwoEnds) {
        const ends = getVesselEndPorts(v);
        for (const side of ['left', 'right']) {
          const ep = ends?.[side];
          if (!ep) continue;
          const isSideStoppered = side === 'left' ? v.leftStoppered : v.rightStoppered;
          if (mode === 'cotton' && isSideStoppered) continue;
          const d = Math.hypot(lx - ep.mouthX, ly - ep.mouthY);
          if (d <= 32 && d < bestD) {
            bestD = d;
            best = { vessel: v, side, slot: ep };
          }
        }
      } else {
        if (mode === 'cotton' && v.isStoppered) continue;
        const mouthY = v.isInverted ? v.y + spec.height / 2 : v.y - spec.height / 2;
        const dx = Math.abs(lx - v.x);
        const dy = Math.abs(ly - mouthY);
        const maxDx = Math.max(24, (spec.neckRadius || spec.width * 0.42) + 10);
        if (dx <= maxDx && dy <= 34) {
          const d = Math.hypot(dx, dy);
          if (d < bestD) {
            bestD = d;
            best = { vessel: v, side: 'main', slot: { mouthX: v.x, mouthY } };
          }
        }
      }
    }
    return best;
  }

  getSelectedIdSet() {
    if (!(this.sim.selectedIds instanceof Set)) {
      this.sim.selectedIds = new Set(this.sim.selectedId ? [this.sim.selectedId] : []);
    }
    if (this.sim.selectedId && this.sim.selectedIds.size === 0) {
      this.sim.selectedIds.add(this.sim.selectedId);
    }
    return this.sim.selectedIds;
  }

  setSelection(ids, primaryId = null) {
    const arr = Array.from(ids).filter((id) => Boolean(this.sim.getItem(id)));
    this.sim.selectedIds = new Set(arr);
    this.sim.selectedId =
      primaryId && this.sim.selectedIds.has(primaryId)
        ? primaryId
        : arr.length > 0
        ? arr[arr.length - 1]
        : null;
  }

  getMountedFunnelOnVessel(vesselId) {
    return (
      this.sim.items.find(
        (f) => f.kind === 'filter_funnel' && !f.isBroken && (f.mountedOnVesselId === vesselId || f.restingOnId === vesselId)
      ) || null
    );
  }

  hitTestItem(lx, ly, excludeId = null, filterFn = null) {
    // Check compact/docked foreground tools BEFORE enclosing vessels so electrodes & funnels remain directly clickable
    const isPriorityTool = (it) =>
      it.kind === 'rubber_stopper' ||
      it.kind === 'phen_cotton' ||
      it.kind === 'electrode' ||
      it.kind === 'filter_funnel' ||
      it.kind === 'separatory_funnel' ||
      it.kind === 'stir_bar' ||
      it.kind === 'boiling_chips' ||
      it.kind === 'salt_bridge' ||
      it.kind === 'pipette' ||
      it.kind === 'splint' ||
      it.kind === 'flame_loop' ||
      it.kind === 'indicator_strip' ||
      it.kind === 'spoon' ||
      it.kind === 'burette' ||
      it.kind === 'condenser' ||
      it.kind === 'thermometer' ||
      it.kind === 'ph_conductometer' ||
      it.kind === 'colorimeter' ||
      it.kind === 'tlc_plate' ||
      it.kind === 'wash_bottle';

    const matchItem = (it) => {
      if (it.id === excludeId) return false;
      if (filterFn && !filterFn(it)) return false;
      const spec = APPARATUS[it.typeId];
      if (it.isShattered || it.isBroken) {
        const hw = Math.max(spec.width / 2 + 20, 48);
        const topEdge = it.y + spec.height / 2 - 48;
        const botEdge = it.y + spec.height / 2 + 12;
        return lx >= it.x - hw && lx <= it.x + hw && ly >= topEdge && ly <= botEdge;
      }
      const padX = it.kind === 'electrode' && it.dockedVesselId ? 4 : 8;
      const isRefluxCond = it.kind === 'condenser' && it.refluxMode;
      const hw = (isRefluxCond ? spec.height : spec.width) / 2 + padX;
      const extTop = it.kind === 'stand' ? Math.max(0, it.extendPx || 0) : 0;
      const hh = (isRefluxCond ? spec.width : (it.renderHeight || spec.height)) / 2 + 10;
      return lx >= it.x - hw && lx <= it.x + hw && ly >= it.y - hh - extTop && ly <= it.y + hh;
    };

    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const it = this.sim.items[i];
      if (isPriorityTool(it) && matchItem(it)) return it;
    }
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const it = this.sim.items[i];
      if (!isPriorityTool(it) && matchItem(it)) return it;
    }
    return null;
  }

  findStandTipAt(lx, ly) {
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const it = this.sim.items[i];
      if (it.kind !== 'stand') continue;
      const { rodX, rodTopY } = getStandGeometry(it);
      if (Math.hypot(lx - rodX, ly - rodTopY) <= 15) {
        return it;
      }
    }
    return null;
  }

  logicalToClient(lx, ly) {
    const rect = this.canvas.getBoundingClientRect();
    let vx = lx;
    let vy = ly;
    if (this.zoomScale > 1.001) {
      vx = BENCH_LOGICAL_W * 0.5 + (lx - this.zoomCenterX) * this.zoomScale;
      vy = BENCH_LOGICAL_H * 0.5 + (ly - this.zoomCenterY) * this.zoomScale;
    }
    return {
      x: rect.left + this.viewOffsetX + vx * this.viewScale,
      y: rect.top + this.viewOffsetY + vy * this.viewScale,
      scale: this.viewScale * this.zoomScale,
    };
  }

  findTubeTipHandleAt(lx, ly) {
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const src = this.sim.items[i];
      if (src.isShattered || src.isBroken) continue;
      if (src.kind === 'vessel' && src.connectedTargetId) {
        const dst = this.sim.getItem(src.connectedTargetId);
        if (!dst || dst.kind !== 'vessel' || dst.isShattered) continue;
        const geom = computeTubingGeometry(src, dst);
        if (geom?.p3 && Math.hypot(lx - geom.p3.x, ly - geom.p3.y) <= 14) {
          return { srcVessel: src, dstVessel: dst, p3: geom.p3 };
        }
      } else if (src.kind === 'electrode' && src.gasTargetId) {
        const dst = this.sim.getItem(src.gasTargetId);
        if (!dst || dst.kind !== 'vessel' || dst.isShattered || dst.mountedOverElectrodeId === src.id) continue;
        const p3 = getTubeDestTipPos(src, dst);
        if (Math.hypot(lx - p3.x, ly - p3.y) <= 14) {
          return { srcVessel: src, dstVessel: dst, p3 };
        }
      } else if (src.kind === 'condenser' && src.outletTargetId) {
        const dst = this.sim.getItem(src.outletTargetId);
        if (!dst || dst.kind !== 'vessel' || dst.isShattered) continue;
        const p3 = getTubeDestTipPos(src, dst);
        if (Math.hypot(lx - p3.x, ly - p3.y) <= 14) {
          return { srcVessel: src, dstVessel: dst, p3 };
        }
      }
    }
    return null;
  }

  findTubeHoverAt(lx, ly) {
    const ptSegDist = (px, py, ax, ay, bx, by) => {
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 <= 1e-6) return Math.hypot(px - ax, py - ay);
      const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
      return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
    };
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const v = this.sim.items[i];
      if (v.kind !== 'vessel' || v.isShattered) continue;
      const tid = v.connectedTargetId || v.connectedSyringeId;
      if (!tid) continue;
      const dst = this.sim.getItem(tid);
      if (!dst || dst.isShattered || dst.isBroken) continue;
      const geom = computeTubingGeometry(v, dst);
      const pts = geom?.points || [];
      let minDist = Infinity;
      for (let k = 0; k < pts.length - 1; k++) {
        const d = ptSegDist(lx, ly, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y);
        if (d < minDist) minDist = d;
      }
      if (minDist <= 12) {
        return { srcVessel: v, dstVessel: dst, x: lx, y: ly, flow: v._liveTubeFlow || null };
      }
    }
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const el = this.sim.items[i];
      if (el.kind !== 'electrode' || !el.gasTargetId) continue;
      const target = this.sim.getItem(el.gasTargetId);
      if (!target || target.isShattered || target.isBroken || target.mountedOverElectrodeId === el.id) continue;
      const eSpec = APPARATUS.electrode_rod;
      const eH = el.renderHeight || eSpec.height;
      const tSpec = APPARATUS[target.typeId] || APPARATUS.gas_syringe;
      const p0 = { x: el.x, y: el.y - eH / 2 + 8 };
      const p3 = getTubeDestTipPos(el, target);
      const midY = Math.min(p0.y, p3.y) - 48;
      const p1 = { x: p0.x, y: midY };
      const p2 = { x: p3.x, y: midY };
      const rPts = buildRigidTubePoints(p0, p1, p2, p3, target, { archLift: 46 });
      let minDist = Infinity;
      for (let s = 1; s < rPts.length; s++) {
        const d = ptSegDist(lx, ly, rPts[s - 1].x, rPts[s - 1].y, rPts[s].x, rPts[s].y);
        if (d < minDist) minDist = d;
      }
      if (minDist <= 12) {
        return { srcVessel: el, dstVessel: target, x: lx, y: ly, flow: el._liveTubeFlow || null };
      }
    }
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const cond = this.sim.items[i];
      if (cond.kind !== 'condenser' || !cond.outletTargetId) continue;
      const target = this.sim.getItem(cond.outletTargetId);
      if (!target || target.isShattered || target.isBroken) continue;
      const { points = [] } = computeCondenserOutletGeometry(cond, target);
      let minDist = Infinity;
      for (let s = 1; s < points.length; s++) {
        const d = ptSegDist(lx, ly, points[s - 1].x, points[s - 1].y, points[s].x, points[s].y);
        if (d < minDist) minDist = d;
      }
      if (minDist <= 12) {
        return { srcVessel: cond, dstVessel: target, x: lx, y: ly, flow: cond._liveTubeFlow || null };
      }
    }
    return null;
  }

  resetWheelTiltedVessel(exceptId = null) {
    if (!this._wheelTiltVesselId || this._wheelTiltVesselId === exceptId) return;
    const prev = this.sim.getItem(this._wheelTiltVesselId);
    if (prev && !APPARATUS[prev.typeId]?.isHorizontalTube && (prev.tiltDeg || 0) > 0) {
      this.sim.setVesselTiltDeg(prev.id, 0);
    }
    this._wheelTiltVesselId = null;
  }

  handleCanvasWheel(pt, deltaY, shiftKey = false, ctrlKey = false) { return handleCanvasWheelImpl(this, pt, deltaY, shiftKey, ctrlKey); }

  findVesselAt(lx, ly, excludeId = null, includeTools = false) {
    if (includeTools) {
      for (let i = this.sim.items.length - 1; i >= 0; i--) {
        const it = this.sim.items[i];
        if (it.id === excludeId || it.isShattered || it.isBroken) continue;
        if (it.kind !== 'filter_funnel' && it.kind !== 'separatory_funnel' && it.kind !== 'burette' && it.kind !== 'spoon') continue;
        const spec = APPARATUS[it.typeId];
        const hw = spec.width / 2 + 22;
        const hh = spec.height / 2 + 28;
        if (lx >= it.x - hw && lx <= it.x + hw && ly >= it.y - hh && ly <= it.y + hh) {
          return it;
        }
      }
    }
    for (let i = this.sim.items.length - 1; i >= 0; i--) {
      const it = this.sim.items[i];
      if (it.id === excludeId || it.isShattered || it.isBroken || it.kind !== 'vessel') continue;
      const spec = APPARATUS[it.typeId];
      const hw = spec.width / 2 + 26;
      const hh = spec.height / 2 + 38;
      if (lx >= it.x - hw && lx <= it.x + hw && ly >= it.y - hh && ly <= it.y + hh) {
        if (includeTools) {
          const mountedFunnel = this.getMountedFunnelOnVessel(it.id);
          if (mountedFunnel && mountedFunnel.id !== excludeId) return mountedFunnel;
        }
        return it;
      }
    }
    return null;
  }

  /**
   * Public external drag-over highlight used by ShelfPanel unified pointer drag.
   */
  setExternalDropPreview(clientX, clientY, payloadType, payloadId) { return setExternalDropPreviewImpl(this, clientX, clientY, payloadType, payloadId); }

  /**
   * Unified drop handler called by BOTH native HTML5 Drag&Drop and pointer-drag fallback.
   */
  dropFromShelf(clientX, clientY, payloadType, payloadId) { return dropFromShelfImpl(this, clientX, clientY, payloadType, payloadId); }

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
    if (!item) return null;
    const spec = APPARATUS[item.typeId];
    if (!spec?.supportsClamp) return null;
    for (const stand of this.sim.items) {
      if (stand.kind !== 'stand') continue;
      const sSpec = APPARATUS.retort_stand;
      const standTop = stand.y - sSpec.height / 2 - (stand.extendPx || 0);
      const targetX = getStandGeometry(stand).clampTargetX(item.kind);
      const isProbeTool = item.kind === 'ph_conductometer' || item.kind === 'colorimeter' || item.kind === 'tlc_plate';
      const distX = isProbeTool ? Math.abs(item.x - stand.x) : Math.abs(item.x - targetX);
      const maxPullDist = isProbeTool ? 125 : item.kind === 'gas_syringe' ? 88 : item.kind === 'burette' || item.kind === 'condenser' ? 68 : 58;
      if (distX <= maxPullDist && item.y >= standTop + 8 && item.y <= BENCH_FLOOR_Y - 10) {
        return stand;
      }
    }
    return null;
  }

  bindEvents() { return bindWorkbenchEventsImpl(this); }

  /**
   * Process smooth wrist-tilt ramp & flow-rate-calibrated interactive drag-pour between vessels.
   */
  tickInteractivePour(realDeltaSec) { return tickInteractivePourImpl(this, realDeltaSec); }

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

    ctx.save();
    if (this.zoomScale > 1.001) {
      ctx.translate(BENCH_LOGICAL_W * 0.5, BENCH_LOGICAL_H * 0.5);
      ctx.scale(this.zoomScale, this.zoomScale);
      ctx.translate(-this.zoomCenterX, -this.zoomCenterY);
    }
    this.renderWorldScene(ctx, timeNow, { includeLabels: true });
    ctx.restore();

    if (
      this.zoomMode &&
      this.zoomScale <= 1.02 &&
      this.pointerLogical &&
      !this.dragState &&
      !this.portDragState &&
      !this.panDragState
    ) {
      this.renderLoupeLens(ctx, timeNow, this.pointerLogical.x, this.pointerLogical.y);
    }

    ctx.restore();
  }

  renderLoupeLens(ctx, timeNow, lx, ly) {
    const r = 84;
    const zoomF = 2.6;
    const clampX = Math.max(r + 12, Math.min(BENCH_LOGICAL_W - r - 12, lx));
    const clampY = Math.max(r + 12, Math.min(BENCH_LOGICAL_H - r - 12, ly));

    ctx.save();
    for (let s = 3; s >= 1; s--) {
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.055 * (4 - s)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(clampX, clampY + 4 + s * 1.2, r + s * 4.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(clampX, clampY, r, 0, Math.PI * 2);
    ctx.fillStyle = this.isDark ? '#0f172a' : '#f8fafc';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(clampX, clampY, r - 2, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = this.isDark ? '#0f172a' : '#f1f5f9';
    ctx.fillRect(clampX - r, clampY - r, r * 2, r * 2);

    ctx.translate(clampX, clampY);
    ctx.scale(zoomF, zoomF);
    ctx.translate(-lx, -ly);
    this.renderWorldScene(ctx, timeNow, { includeLabels: false });
    ctx.restore();

    // Specular optical lens bevel + crosshair + badge
    ctx.save();
    ctx.strokeStyle = this.isDark ? '#38bdf8' : '#0284c7';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(clampX, clampY, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(clampX, clampY, r - 6, -2.55, -1.65);
    ctx.stroke();

    ctx.strokeStyle = this.isDark ? 'rgba(56, 189, 248, 0.35)' : 'rgba(2, 132, 199, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(clampX - 9, clampY);
    ctx.lineTo(clampX + 9, clampY);
    ctx.moveTo(clampX, clampY - 9);
    ctx.lineTo(clampX, clampY + 9);
    ctx.stroke();

    ctx.fillStyle = this.isDark ? 'rgba(15, 23, 42, 0.88)' : 'rgba(255, 255, 255, 0.92)';
    ctx.strokeStyle = this.isDark ? '#38bdf8' : '#0284c7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(clampX - 24, clampY + r - 12, 48, 18, 9);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = this.isDark ? '#e0f2fe' : '#0369a1';
    ctx.font = 'bold 10.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`🔍 ${zoomF.toFixed(1)}×`, clampX, clampY + r - 3);
    ctx.restore();
  }

  _ensureBgCache() {
    const uvOn = Boolean(this.sim?.environment?.uvLight);
    const cacheScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const key = `${this.themeName}|${this.isDark ? 1 : 0}|${uvOn ? 1 : 0}|${cacheScale}`;
    if (this._bgCacheCanvas && this._bgCacheKey === key) {
      return this._bgCacheCanvas;
    }

    if (!this._bgCacheCanvas) {
      this._bgCacheCanvas = document.createElement('canvas');
      this._bgCacheCtx = this._bgCacheCanvas.getContext('2d');
    }
    const targetW = Math.round(BENCH_LOGICAL_W * cacheScale);
    const targetH = Math.round(BENCH_LOGICAL_H * cacheScale);
    if (this._bgCacheCanvas.width !== targetW || this._bgCacheCanvas.height !== targetH) {
      this._bgCacheCanvas.width = targetW;
      this._bgCacheCanvas.height = targetH;
    }

    const bCtx = this._bgCacheCtx;
    bCtx.save();
    bCtx.setTransform(1, 0, 0, 1, 0, 0);
    bCtx.clearRect(0, 0, targetW, targetH);
    bCtx.scale(cacheScale, cacheScale);

    // Theme sky/noir backdrop
    if (this.themeName === 'olivia') {
      const skyGrad = bCtx.createLinearGradient(0, 0, 0, BENCH_FLOOR_Y);
      skyGrad.addColorStop(0, '#72AEE0');
      skyGrad.addColorStop(1, '#CBE5FA');
      bCtx.fillStyle = skyGrad;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
    } else if (this.themeName === 'ctrl') {
      const ctrlGrad = bCtx.createLinearGradient(0, 0, 0, BENCH_FLOOR_Y);
      ctrlGrad.addColorStop(0, '#B9DEF2');
      ctrlGrad.addColorStop(0.55, '#DCEEFB');
      ctrlGrad.addColorStop(1, '#EAF5FC');
      bCtx.fillStyle = ctrlGrad;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
      bCtx.strokeStyle = 'rgba(79, 99, 88, 0.12)';
      bCtx.lineWidth = 1;
      for (let gx = 40; gx < BENCH_LOGICAL_W; gx += 40) {
        bCtx.beginPath();
        bCtx.moveTo(gx, 0);
        bCtx.lineTo(gx, BENCH_FLOOR_Y);
        bCtx.stroke();
      }
      for (let gy = 40; gy < BENCH_FLOOR_Y; gy += 40) {
        bCtx.beginPath();
        bCtx.moveTo(0, gy);
        bCtx.lineTo(BENCH_LOGICAL_W, gy);
        bCtx.stroke();
      }
      bCtx.strokeStyle = 'rgba(180, 83, 9, 0.24)';
      bCtx.lineWidth = 1.4;
      bCtx.beginPath();
      bCtx.moveTo(52, 0);
      bCtx.lineTo(52, BENCH_FLOOR_Y);
      bCtx.stroke();
    } else if (this.themeName === 'hte') {
      // Old Hollywood golden room gradient + warm amber overhead lamp glow
      const hteGrad = bCtx.createLinearGradient(0, 0, 0, BENCH_FLOOR_Y);
      hteGrad.addColorStop(0, '#E8D7BC');
      hteGrad.addColorStop(0.55, '#EFE1C8');
      hteGrad.addColorStop(1, '#F6ECDA');
      bCtx.fillStyle = hteGrad;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
      const lampGrad = bCtx.createRadialGradient(BENCH_LOGICAL_W * 0.5, 24, 18, BENCH_LOGICAL_W * 0.5, 110, 460);
      lampGrad.addColorStop(0, 'rgba(253, 230, 138, 0.42)');
      lampGrad.addColorStop(0.5, 'rgba(217, 160, 72, 0.16)');
      lampGrad.addColorStop(1, 'rgba(217, 160, 72, 0)');
      bCtx.fillStyle = lampGrad;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
    } else if (this.themeName === 'guts') {
      // Midnight Violet Pop-Punk backdrop + scattered faint silver 4-point Y2K stars
      const gutsGrad = bCtx.createLinearGradient(0, 0, 0, BENCH_FLOOR_Y);
      gutsGrad.addColorStop(0, '#150A26');
      gutsGrad.addColorStop(0.58, '#261442');
      gutsGrad.addColorStop(1, '#1E1133');
      bCtx.fillStyle = gutsGrad;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
      const crimsonGlow = bCtx.createRadialGradient(BENCH_LOGICAL_W * 0.52, BENCH_FLOOR_Y - 12, 20, BENCH_LOGICAL_W * 0.52, BENCH_FLOOR_Y - 30, 420);
      crimsonGlow.addColorStop(0, 'rgba(225, 29, 72, 0.16)');
      crimsonGlow.addColorStop(1, 'rgba(225, 29, 72, 0)');
      bCtx.fillStyle = crimsonGlow;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
      for (let si = 0; si < 18; si++) {
        const sx = ((si * 197 + 43) % 940) + 30;
        const sy = ((si * 83 + 22) % (BENCH_FLOOR_Y - 70)) + 20;
        const sr = 2.6 + (si % 3) * 1.1;
        bCtx.fillStyle = si % 4 === 0 ? 'rgba(225, 29, 72, 0.28)' : 'rgba(226, 232, 240, 0.26)';
        bCtx.beginPath();
        for (let k = 0; k < 8; k++) {
          const rad = k % 2 === 0 ? sr : sr * 0.25;
          const a = (Math.PI / 4) * k;
          const px = sx + Math.cos(a) * rad;
          const py = sy + Math.sin(a) * rad;
          if (k === 0) bCtx.moveTo(px, py);
          else bCtx.lineTo(px, py);
        }
        bCtx.closePath();
        bCtx.fill();
      }
    } else if (this.themeName === 'sos') {
      const sosGrad = bCtx.createLinearGradient(0, 0, 0, BENCH_FLOOR_Y);
      sosGrad.addColorStop(0, '#071728');
      sosGrad.addColorStop(0.55, '#0A2540');
      sosGrad.addColorStop(1, '#103554');
      bCtx.fillStyle = sosGrad;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
      const mistG = bCtx.createRadialGradient(BENCH_LOGICAL_W * 0.5, BENCH_FLOOR_Y - 10, 30, BENCH_LOGICAL_W * 0.5, BENCH_FLOOR_Y - 40, 460);
      mistG.addColorStop(0, 'rgba(91, 181, 201, 0.18)');
      mistG.addColorStop(1, 'rgba(91, 181, 201, 0)');
      bCtx.fillStyle = mistG;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
    } else if (this.themeName === 'petal') {
      bCtx.fillStyle = '#111113';
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
      const beamGrad = bCtx.createLinearGradient(120, 0, 740, BENCH_FLOOR_Y);
      beamGrad.addColorStop(0, 'rgba(242, 242, 245, 0.08)');
      beamGrad.addColorStop(0.55, 'rgba(242, 242, 245, 0.035)');
      beamGrad.addColorStop(1, 'rgba(242, 242, 245, 0)');
      bCtx.fillStyle = beamGrad;
      bCtx.beginPath();
      bCtx.moveTo(90, 0);
      bCtx.lineTo(390, 0);
      bCtx.lineTo(820, BENCH_FLOOR_Y);
      bCtx.lineTo(520, BENCH_FLOOR_Y);
      bCtx.closePath();
      bCtx.fill();
      bCtx.fillStyle = 'rgba(242, 242, 245, 0.03)';
      for (let gi = 0; gi < 64; gi++) {
        const gx = ((gi * 173 + 29) % 980) + 10;
        const gy = ((gi * 97 + 41) % (BENCH_FLOOR_Y - 20)) + 10;
        bCtx.fillRect(gx, gy, 2, 2);
      }
    } else if (this.themeName === 'homogenic') {
      // Cold Metallic Silver gradient + McQueen Cobalt upper glint
      const homGrad = bCtx.createLinearGradient(0, 0, 0, BENCH_FLOOR_Y);
      homGrad.addColorStop(0, '#D5DFEB');
      homGrad.addColorStop(0.55, '#E4ECF5');
      homGrad.addColorStop(1, '#EEF3F9');
      bCtx.fillStyle = homGrad;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
      const cobaltGlint = bCtx.createRadialGradient(BENCH_LOGICAL_W * 0.82, 26, 12, BENCH_LOGICAL_W * 0.78, 80, 420);
      cobaltGlint.addColorStop(0, 'rgba(29, 78, 216, 0.14)');
      cobaltGlint.addColorStop(0.6, 'rgba(217, 119, 6, 0.05)');
      cobaltGlint.addColorStop(1, 'rgba(29, 78, 216, 0)');
      bCtx.fillStyle = cobaltGlint;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
    } else if (this.themeName === 'anti') {
      // Stark Monochrome Obsidian + Roy Nachum red oil paint slash at upper left
      const antiGrad = bCtx.createLinearGradient(0, 0, 0, BENCH_FLOOR_Y);
      antiGrad.addColorStop(0, '#0B0B0E');
      antiGrad.addColorStop(0.6, '#121216');
      antiGrad.addColorStop(1, '#16161B');
      bCtx.fillStyle = antiGrad;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
      const redSlash = bCtx.createLinearGradient(0, 0, 420, 260);
      redSlash.addColorStop(0, 'rgba(220, 38, 38, 0.24)');
      redSlash.addColorStop(0.6, 'rgba(220, 38, 38, 0.08)');
      redSlash.addColorStop(1, 'rgba(220, 38, 38, 0)');
      bCtx.fillStyle = redSlash;
      bCtx.beginPath();
      bCtx.moveTo(0, 0);
      bCtx.lineTo(440, 0);
      bCtx.lineTo(175, 290);
      bCtx.lineTo(0, 240);
      bCtx.closePath();
      bCtx.fill();
    }

    if (uvOn) {
      const uvGrad = bCtx.createRadialGradient(BENCH_LOGICAL_W * 0.5, 10, 20, BENCH_LOGICAL_W * 0.5, 250, 520);
      uvGrad.addColorStop(0, this.isDark ? 'rgba(139, 92, 246, 0.24)' : 'rgba(139, 92, 246, 0.14)');
      uvGrad.addColorStop(1, 'rgba(139, 92, 246, 0)');
      bCtx.fillStyle = uvGrad;
      bCtx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
    }

    const bgGrid =
      this.themeName === 'olivia'
        ? 'rgba(250, 243, 227, 0.72)'
        : this.themeName === 'ctrl'
        ? 'rgba(79, 99, 88, 0.24)'
        : this.themeName === 'hte'
        ? 'rgba(120, 99, 80, 0.14)'
        : this.themeName === 'homogenic'
        ? 'rgba(71, 85, 105, 0.16)'
        : this.themeName === 'anti'
        ? 'rgba(248, 250, 252, 0.11)'
        : this.themeName === 'guts'
        ? 'rgba(196, 181, 253, 0.11)'
        : this.themeName === 'sos'
        ? 'rgba(91, 181, 201, 0.14)'
        : this.themeName === 'petal'
        ? 'rgba(242, 242, 245, 0.06)'
        : this.isDark
        ? 'rgba(148, 163, 184, 0.08)'
        : 'rgba(15, 23, 42, 0.06)';
    bCtx.fillStyle = bgGrid;
    if (this.themeName === 'anti') {
      // Tactile 2x3 Braille dot cells across background canvas (ANTI album cover Braille poetry)
      for (let cellIdx = 0, gx = 56; gx < BENCH_LOGICAL_W - 40; gx += 84) {
        for (let gy = 52; gy < BENCH_FLOOR_Y - 40; gy += 64, cellIdx++) {
          for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 2; c++) {
              const bit = (cellIdx * 7 + r * 3 + c * 5) % 3 !== 0;
              if (!bit) continue;
              bCtx.beginPath();
              bCtx.arc(gx + c * 5, gy + r * 5, 1.15, 0, Math.PI * 2);
              bCtx.fill();
            }
          }
        }
      }
    } else {
      for (let gx = 40; gx < BENCH_LOGICAL_W; gx += 40) {
        for (let gy = 40; gy < BENCH_FLOOR_Y; gy += 40) {
          bCtx.fillRect(gx - 1, gy - 1, 2, 2);
        }
      }
    }

    // Lab Bench Table Edge
    const benchGrad = bCtx.createLinearGradient(0, BENCH_FLOOR_Y, 0, BENCH_LOGICAL_H);
    if (this.themeName === 'olivia') {
      benchGrad.addColorStop(0, '#F8F0DF');
      benchGrad.addColorStop(1, '#F4A5B8');
    } else if (this.themeName === 'ctrl') {
      benchGrad.addColorStop(0, '#EAF5FC');
      benchGrad.addColorStop(1, '#B9DEF2');
    } else if (this.themeName === 'hte') {
      benchGrad.addColorStop(0, '#C9A679');
      benchGrad.addColorStop(1, '#A88255');
    } else if (this.themeName === 'homogenic') {
      benchGrad.addColorStop(0, '#475569');
      benchGrad.addColorStop(1, '#1E293B');
    } else if (this.themeName === 'anti') {
      benchGrad.addColorStop(0, '#18181B');
      benchGrad.addColorStop(1, '#09090B');
    } else if (this.themeName === 'guts') {
      benchGrad.addColorStop(0, '#170C29');
      benchGrad.addColorStop(1, '#0D0618');
    } else if (this.themeName === 'sos') {
      benchGrad.addColorStop(0, '#13293D');
      benchGrad.addColorStop(1, '#0B131E');
    } else if (this.themeName === 'petal') {
      benchGrad.addColorStop(0, '#1B1B1F');
      benchGrad.addColorStop(1, '#101012');
    } else if (this.isDark) {
      benchGrad.addColorStop(0, '#1e293b');
      benchGrad.addColorStop(1, '#0f172a');
    } else {
      benchGrad.addColorStop(0, '#cbd5e1');
      benchGrad.addColorStop(1, '#94a3b8');
    }
    bCtx.fillStyle = benchGrad;
    bCtx.fillRect(0, BENCH_FLOOR_Y, BENCH_LOGICAL_W, BENCH_LOGICAL_H - BENCH_FLOOR_Y);

    if (this.themeName === 'hte') {
      bCtx.strokeStyle = 'rgba(120, 99, 80, 0.22)';
      bCtx.lineWidth = 1;
      for (let wi = 0; wi < 6; wi++) {
        const wy = BENCH_FLOOR_Y + 9 + wi * 11;
        bCtx.beginPath();
        bCtx.moveTo(0, wy);
        bCtx.bezierCurveTo(280, wy - 2, 680, wy + 2, BENCH_LOGICAL_W, wy);
        bCtx.stroke();
      }
    } else if (this.themeName === 'guts') {
      const refGrad = bCtx.createLinearGradient(0, BENCH_FLOOR_Y, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
      refGrad.addColorStop(0, 'rgba(124, 58, 237, 0.24)');
      refGrad.addColorStop(0.5, 'rgba(225, 29, 72, 0.26)');
      refGrad.addColorStop(1, 'rgba(124, 58, 237, 0.24)');
      bCtx.fillStyle = refGrad;
      bCtx.fillRect(0, BENCH_FLOOR_Y, BENCH_LOGICAL_W, 5);
    } else if (this.themeName === 'homogenic') {
      const sheen = bCtx.createLinearGradient(0, BENCH_FLOOR_Y, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
      sheen.addColorStop(0, 'rgba(29, 78, 216, 0.16)');
      sheen.addColorStop(0.5, 'rgba(226, 232, 240, 0.18)');
      sheen.addColorStop(1, 'rgba(217, 119, 6, 0.16)');
      bCtx.fillStyle = sheen;
      bCtx.fillRect(0, BENCH_FLOOR_Y, BENCH_LOGICAL_W, 4);
    }

    bCtx.strokeStyle =
      this.themeName === 'olivia'
        ? '#221F20'
        : this.themeName === 'ctrl'
        ? '#4F6358'
        : this.themeName === 'hte'
        ? '#786350'
        : this.themeName === 'homogenic'
        ? '#64748B'
        : this.themeName === 'anti'
        ? '#F8FAFC'
        : this.themeName === 'guts'
        ? '#09090B'
        : this.themeName === 'sos'
        ? '#5BB5C9'
        : this.themeName === 'petal'
        ? '#33333A'
        : this.isDark
        ? '#334155'
        : '#64748b';
    bCtx.lineWidth = this.themeName === 'olivia' || this.themeName === 'ctrl' || this.themeName === 'guts' ? 2.0 : 2;
    bCtx.beginPath();
    bCtx.moveTo(0, BENCH_FLOOR_Y);
    bCtx.lineTo(BENCH_LOGICAL_W, BENCH_FLOOR_Y);
    bCtx.stroke();
    bCtx.restore();

    this._bgCacheKey = key;
    return this._bgCacheCanvas;
  }

  renderWorldScene(ctx, timeNow, { includeLabels = true } = {}) {
    // 1. Blit pre-rendered static theme backdrop, dot grid, UV tint, and lab bench surface
    const bgCanvas = this._ensureBgCache();
    ctx.drawImage(bgCanvas, 0, 0, BENCH_LOGICAL_W, BENCH_LOGICAL_H);
    if (this.themeName === 'sos') {
      const sonarPulse = 0.72 + Math.sin(performance.now() * 0.0016) * 0.28;
      ctx.save();
      ctx.strokeStyle = `rgba(91, 181, 201, ${(0.095 * sonarPulse).toFixed(3)})`;
      ctx.lineWidth = 1.25;
      for (const rad of [140, 260, 380]) {
        ctx.beginPath();
        ctx.arc(BENCH_LOGICAL_W * 0.5, BENCH_FLOOR_Y + 38, rad, Math.PI, 0);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 2. Render supports & stands behind, clamp jaws, then Syringes, Vessels, and Pipettes on top.
    // Floating Canvas label pills auto-hide by default: show only hovered/dragged apparatus, drawn on the top layer.
    const activeTooltipIds = new Set();
    if (includeLabels) {
      if (this.hoverItemId) activeTooltipIds.add(this.hoverItemId);
      if (this.dragState?.itemId) activeTooltipIds.add(this.dragState.itemId);
      if (this.dragState?.pourTargetId) activeTooltipIds.add(this.dragState.pourTargetId);
      if (this.dragState?.pipetteTargetId) activeTooltipIds.add(this.dragState.pipetteTargetId);
      if (this.portDragState?.condId) activeTooltipIds.add(this.portDragState.condId);
    }
    const labelCaseMode =
      this.themeName === 'olivia' || this.themeName === 'petal'
        ? 'lower'
        : this.themeName === 'sos'
        ? 'upper'
        : false;
    beginCanvasLabelFrame(activeTooltipIds, labelCaseMode, this.themeName);

    renderTubingConnections(ctx, this.sim.items, this.isDark, timeNow, this.langCode);
    renderElectrodeCollectorTubes(ctx, this.sim.items, this.isDark, timeNow);

    const compareIds = Array.isArray(this.sim.compareVesselIds) ? this.sim.compareVesselIds : [];
    const compareTags = ['A', 'B', 'C'];
    const compareColors = ['#38bdf8', '#f472b6', '#34d399'];

    const ordered = [
      ...this.sim.items.filter((i) => i.kind === 'stand' || i.kind === 'dc_power' || i.kind === 'volt_ammeter'),
      ...this.sim.items.filter((i) => i.kind === 'scale' || i.kind === 'burner' || i.kind === 'bath' || i.kind === 'diffusion_tube'),
      ...this.sim.items.filter((i) => i.kind === 'gas_syringe' || i.kind === 'condenser' || i.kind === 'burette'),
      ...this.sim.items.filter((i) => i.kind === 'vessel'),
      ...this.sim.items.filter((i) => i.kind === 'rubber_stopper' || i.kind === 'phen_cotton'),
      ...this.sim.items.filter((i) => i.kind === 'filter_funnel' || i.kind === 'separatory_funnel' || i.kind === 'electrode' || i.kind === 'salt_bridge' || i.kind === 'stir_bar' || i.kind === 'boiling_chips'),
      ...this.sim.items.filter((i) => i.kind === 'pipette' || i.kind === 'wash_bottle' || i.kind === 'splint' || i.kind === 'flame_loop' || i.kind === 'indicator_strip' || i.kind === 'spoon' || i.kind === 'thermometer' || i.kind === 'ph_conductometer' || i.kind === 'colorimeter' || i.kind === 'tlc_plate'),
    ];

    renderDcPowerAndWires(ctx, this.sim.items, this.sim.selectedId, this.isDark);
    renderVoltAmmeterAndWires(ctx, this.sim.items, this.sim.selectedId, this.isDark);

    const selectedSet = this.getSelectedIdSet();
    for (const item of ordered) {
      const isSelected = item.id === this.sim.selectedId || selectedSet.has(item.id);
      const isPickCandidate = Boolean(this.pickState?.candidateIds?.has(item.id));
      const isDropTgt = item.id === this.dropTargetVesselId || (isPickCandidate && item.id === this.hoverItemId);
      setCurrentLabelItemId(item.id);
      if (item.kind === 'stand') {
        renderRetortStand(ctx, item, isSelected, this.isDark);
      } else if (item.kind === 'scale') {
        renderScale(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'burner') {
        renderBurner(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'bath') {
        renderIceBath(ctx, item, isSelected, this.isDark, timeNow, this.langCode, this.sim.environment?.opticsMode || 'normal');
      } else if (item.kind === 'diffusion_tube') {
        renderDiffusionTube(ctx, item, isSelected, isDropTgt, this.isDark, this.langCode);
      } else if (item.kind === 'gas_syringe') {
        renderGasSyringe(ctx, item, isSelected, this.isDark, this.sim.environment, this.langCode, timeNow);
      } else if (item.kind === 'vessel') {
        const cIdx = compareIds.indexOf(item.id);
        item.compareTag = cIdx >= 0 ? compareTags[cIdx] : null;
        item.compareColor = cIdx >= 0 ? compareColors[cIdx] : null;
        renderVessel(ctx, item, {
          isSelected,
          isDropTarget: isDropTgt,
          isDark: this.isDark,
          themeName: this.themeName,
          timeNow,
          langCode: this.langCode,
        });
      } else if (item.kind === 'pipette') {
        renderPipette(ctx, item, isSelected, this.isDark, this.langCode, timeNow);
      } else if (item.kind === 'filter_funnel') {
        renderFilterFunnel(ctx, item, isSelected, isDropTgt, this.isDark, this.langCode, timeNow);
      } else if (item.kind === 'separatory_funnel') {
        renderSeparatoryFunnel(ctx, item, isSelected, isDropTgt, this.isDark, this.langCode, timeNow);
      } else if (item.kind === 'wash_bottle') {
        renderWashBottle(ctx, item, isSelected, this.isDark, this.langCode, timeNow);
      } else if (item.kind === 'condenser') {
        renderLiebigCondenser(ctx, item, isSelected, this.isDark, timeNow, this.langCode);
      } else if (item.kind === 'burette') {
        renderBurette(ctx, item, isSelected, isDropTgt, this.isDark, timeNow);
      } else if (item.kind === 'splint') {
        renderSplint(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'flame_loop') {
        renderFlameLoop(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'indicator_strip') {
        renderIndicatorStrip(ctx, item, isSelected, this.isDark, this.langCode);
      } else if (item.kind === 'spoon') {
        renderIronSpoon(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'stir_bar') {
        renderStirBar(ctx, item, isSelected, this.isDark);
      } else if (item.kind === 'boiling_chips') {
        renderBoilingChips(ctx, item, isSelected, this.isDark);
      } else if (item.kind === 'electrode') {
        renderElectrodeRod(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'salt_bridge') {
        renderSaltBridge(ctx, item, this.sim.items, isSelected, this.isDark, timeNow, this.langCode);
      } else if (item.kind === 'rubber_stopper') {
        const hostV = item.attachedToId ? this.sim.getItem(item.attachedToId) : null;
        renderRubberStopper(ctx, item, isSelected, this.isDark, hostV);
      } else if (item.kind === 'phen_cotton') {
        renderPhenCotton(ctx, item, isSelected, this.isDark);
      } else if (item.kind === 'thermometer') {
        renderThermometer(ctx, item, isSelected, this.isDark, this.langCode);
      } else if (item.kind === 'ph_conductometer') {
        renderPhConductometer(ctx, item, isSelected, this.isDark, this.langCode);
      } else if (item.kind === 'colorimeter') {
        renderColorimeter(ctx, item, isSelected, this.isDark);
      } else if (item.kind === 'tlc_plate') {
        renderTlcPlate(ctx, item, isSelected, this.isDark, Boolean(this.sim.environment?.uvLight));
      }

      if (item.clampedToId) {
        const st = this.sim.getItem(item.clampedToId);
        if (st && st.kind === 'stand') {
          renderRetortClampJaw(ctx, st, item, this.isDark);
        }
      }
    }
    setCurrentLabelItemId(null);

    if (this.portDragState) {
      const pd = this.portDragState;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = pd.port === 'inlet' ? '#f59e0b' : '#0ea5e9';
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pd.startX, pd.startY);
      const midX = 0.5 * (pd.startX + pd.x);
      ctx.quadraticCurveTo(midX, Math.min(pd.startY, pd.y) - 36, pd.x, pd.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
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

    // Show parabolic aim trajectory guide when selecting/dragging a Wash Bottle with water
    if (
      selItem &&
      selItem.kind === 'wash_bottle' &&
      (selItem.waterMl || 0) > 0.1 &&
      !selItem.isSpraying &&
      (selItem.squirtTimer || 0) <= 0
    ) {
      const wbArc = computeWashBottleStreamArc(
        selItem,
        this.sim.items,
        BENCH_FLOOR_Y,
        CONSTANTS.GRAVITY_PX_S2 || 1800
      );
      if (wbArc.points.length >= 2) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = wbArc.hitTarget ? 'rgba(14, 165, 233, 0.85)' : 'rgba(148, 163, 184, 0.42)';
        ctx.lineWidth = wbArc.hitTarget ? 2.0 : 1.3;
        ctx.beginPath();
        ctx.moveTo(wbArc.points[0].x, wbArc.points[0].y);
        for (let i = 1; i < wbArc.points.length; i++) {
          ctx.lineTo(wbArc.points[i].x, wbArc.points[i].y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        if (wbArc.hitTarget) {
          ctx.fillStyle = 'rgba(14, 165, 233, 0.9)';
          ctx.beginPath();
          ctx.arc(wbArc.hitX, wbArc.hitY, 4.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // 4. Render active pouring stream & animated reagent bottle / glass rod / glass spoon transfer
    if (this.sim.activePourStream) {
      const st = this.sim.activePourStream;
      const rateNorm = Math.max(0, Math.min(1, (st.rateMlS || 10) / 14));
      const ctrlX = (st.fromX + st.toX) * 0.5;
      const ctrlY = st.fromY + 25;
      ctx.save();
      ctx.strokeStyle = st.color || 'rgba(186, 230, 253, 0.8)';
      ctx.lineWidth = 2.2 + rateNorm * 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(st.fromX, st.fromY);
      ctx.quadraticCurveTo(ctrlX, ctrlY, st.toX, st.toY);
      ctx.stroke();

      // Glint droplets flowing downward along stream proportional to live rate
      ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
      for (let i = 0; i < 3; i++) {
        const u = ((timeNow * (1.8 + rateNorm * 1.4) + i * 0.33) % 1);
        const omt = 1 - u;
        const bx = omt * omt * st.fromX + 2 * omt * u * ctrlX + u * u * st.toX;
        const by = omt * omt * st.fromY + 2 * omt * u * ctrlY + u * u * st.toY;
        ctx.beginPath();
        ctx.arc(bx, by, 1.4 + rateNorm * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }

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

    if (this.sim.activeReagentTransfer) {
      const tgtV = this.sim.getItem(this.sim.activeReagentTransfer.vesselId);
      const tSpec = tgtV ? APPARATUS[tgtV.typeId] : null;
      if (tgtV && tSpec && !tgtV.isShattered) {
        renderActiveReagentTransfer(
          ctx,
          this.sim.activeReagentTransfer,
          tgtV,
          tSpec,
          tgtV.y + tSpec.height / 2 - 4,
          this.isDark,
          timeNow
        );
      }
    }

    // 5. Render WebGL2 Eulerian Stable Fluids gas/thermal field + discrete particles
    // In Thermal FLIR mode, step WebGL2 field now and composite AFTER _thermalCanvas so hot plumes glow visibly over cool sky!
    if (this.fluidGasOverlay?.enabled) {
      if (this._prevFluidTime !== timeNow) {
        const fluidDt = Math.max(0.008, Math.min(0.05, timeNow - (this._prevFluidTime ?? timeNow - 0.016)));
        this._prevFluidTime = timeNow;
        this.fluidGasOverlay.stepAndRender(this.sim, fluidDt, this.isDark);
      }
      if (!this.fluidGasOverlay.isSleeping && (this.sim.environment?.opticsMode || 'normal') !== 'thermal') {
        ctx.save();
        ctx.drawImage(this.fluidGasOverlay.canvas, 0, 0, BENCH_LOGICAL_W, BENCH_LOGICAL_H);
        ctx.restore();
      }
    }
    if (this.themeName === 'hte') {
      let targetStorm = this._hteStormSurge || 0;
      for (const it of this.sim.items) {
        if (it.kind !== 'vessel' || it.isShattered) continue;
        if (it.isBoiling || (it.tempK || 298.15) >= 368) {
          targetStorm = Math.max(targetStorm, 0.88);
        } else if ((it.lastExothermicJ || 0) > 25) {
          targetStorm = Math.max(targetStorm, Math.min(0.95, 0.35 + (it.lastExothermicJ || 0) / 380));
        } else {
          const gasTotal = Object.values(it.lastGasRateMap || {}).reduce((s, v) => s + (v || 0), 0);
          if (gasTotal > 0.002) targetStorm = Math.max(targetStorm, Math.min(0.8, 0.28 + gasTotal * 35));
        }
      }
      const hteDt = Math.max(0.008, Math.min(0.05, timeNow - (this._prevHteTime ?? timeNow - 0.016)));
      this._prevHteTime = timeNow;
      this._hteStormSurge = Math.max(0, (this._hteStormSurge || 0) - hteDt * 0.28);
      const curStorm = this._hteStormLevel || 0;
      const rampRate = targetStorm > curStorm ? 1.65 : 0.38;
      this._hteStormLevel = Math.max(0, Math.min(1, curStorm + (targetStorm - curStorm) * Math.min(1, rampRate * hteDt)));
      if (this._hteStormLevel > 0.02) {
        ctx.save();
        ctx.fillStyle = `rgba(15, 23, 42, ${(0.34 * this._hteStormLevel).toFixed(3)})`;
        ctx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
        ctx.restore();
        this.particles?.emitHteDownpour?.(hteDt, this._hteStormLevel, this.sim.items, BENCH_FLOOR_Y);
      }
    } else if (this.themeName === 'homogenic') {
      const geyserDt = Math.max(0.008, Math.min(0.05, timeNow - (this._prevHomTime ?? timeNow - 0.016)));
      this._prevHomTime = timeNow;
      for (const it of this.sim.items) {
        if (it.kind !== 'vessel' || it.isShattered) continue;
        if (it.isBoiling || (it.tempK || 298.15) >= 358.15 || (it.lastExothermicJ || 0) > 25) {
          if (Math.random() < geyserDt * 4.5) {
            const sp = APPARATUS[it.typeId] || { height: 90 };
            this.particles?.emitHomogenicGeyserSpark?.(it.x, it.y + sp.height * 0.5 - 2);
          }
        }
      }
    } else if (this.themeName === 'anti') {
      const antiDt = Math.max(0.008, Math.min(0.05, timeNow - (this._prevAntiTime ?? timeNow - 0.016)));
      this._prevAntiTime = timeNow;
      this._antiBalloonTimer = (this._antiBalloonTimer || 0) + antiDt;
      if (this._antiBalloonTimer >= 1.15) {
        for (const it of this.sim.items) {
          if (it.kind !== 'vessel' || it.isShattered || it.isStoppered) continue;
          const gasTotal = Object.values(it.lastGasRateMap || {}).reduce((s, v) => s + (v || 0), 0);
          if (it.isBoiling || gasTotal > 0.002) {
            this._antiBalloonTimer = 0;
            const sp = APPARATUS[it.typeId] || { height: 90 };
            this.particles?.emitAntiBalloons?.(it.x, it.y - sp.height * 0.45, 1);
            break;
          }
        }
      }
    }
    this.particles.render(ctx);

    // 6. Render visual pick target rings when awaiting user direct click on bench
    if (this.pickState && this.pickState.candidateIds.size > 0) {
      const pulse = 0.55 + Math.sin(timeNow * 5.2) * 0.35;
      ctx.save();
      for (const it of this.sim.items) {
        if (!this.pickState.candidateIds.has(it.id)) continue;
        const sp = APPARATUS[it.typeId] || { width: 64, height: 80 };
        const isHov = it.id === this.hoverItemId;
        ctx.strokeStyle = isHov ? '#34d399' : `rgba(16, 185, 129, ${pulse.toFixed(2)})`;
        ctx.fillStyle = isHov ? 'rgba(16, 185, 129, 0.16)' : 'rgba(16, 185, 129, 0.06)';
        ctx.lineWidth = isHov ? 3 : 2;
        ctx.setLineDash(isHov ? [] : [6, 4]);
        ctx.beginPath();
        ctx.roundRect(it.x - sp.width / 2 - 8, it.y - sp.height / 2 - 8, sp.width + 16, sp.height + 16, 10);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // 6b. Marquee Multi-Select Rectangle Overlay (Ctrl+Drag)
    if (this.marqueeState) {
      const mx = Math.min(this.marqueeState.startX, this.marqueeState.x);
      const my = Math.min(this.marqueeState.startY, this.marqueeState.y);
      const mw = Math.abs(this.marqueeState.x - this.marqueeState.startX);
      const mh = Math.abs(this.marqueeState.y - this.marqueeState.startY);
      ctx.save();
      ctx.fillStyle = 'rgba(59, 130, 246, 0.14)';
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 3]);
      ctx.fillRect(mx, my, mw, mh);
      ctx.strokeRect(mx, my, mw, mh);
      ctx.restore();
    }

    // 6c. Multi-Spectral Optics Overlay ('aerodynamics' | 'thermal')
    const opticsMode = this.sim.environment?.opticsMode || 'normal';
    if (opticsMode !== 'normal') {
      this.renderMultiSpectralOpticsOverlay(ctx, timeNow, opticsMode);
    }

    // 7. Render hovered/dragged Canvas tooltip pills & live gas-tubing hover telemetry on top layer
    if (includeLabels) {
      flushCanvasLabelFrame(ctx);
      if (this.hoveredTubeInfo && !this.dragState) {
        const ht = this.hoveredTubeInfo;
        const flow = ht.srcVessel?._liveTubeFlow || ht.flow;
        const isBlindFlow = Boolean(ht.srcVessel?.hideComposition);
        const compText = isBlindFlow
          ? (this.langCode === 'en' ? 'Unknown gas (?)' : 'Khí ẩn danh (?)')
          : flow?.composition?.length
          ? flow.composition.map((c) => `${c.formula} ${c.pct}%`).join(', ')
          : this.langCode === 'en'
          ? 'No active flow'
          : 'Chưa có dòng khí';
        const srcTag = ht.srcVessel?.hideComposition ? (ht.srcVessel.blindLabel || ht.srcVessel.label) : ht.srcVessel.label;
        const rateTxt = `${(flow?.rateMlS || 0).toFixed(2)} mL/s · ${(flow?.tempC ?? 25).toFixed(1)}°C`;
        const line1 = formatCanvasText(`${srcTag} → ${ht.dstVessel.label}: ${compText}`);
        const line2 = formatCanvasText(`${rateTxt}`);
        ctx.save();
        ctx.font = '600 11px system-ui, sans-serif';
        const boxW = Math.max(175, Math.min(340, Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 22));
        const boxH = 40;
        const bx = Math.max(8, Math.min(BENCH_LOGICAL_W - boxW - 8, ht.x + 12));
        const by = Math.max(8, ht.y - boxH - 12);
        ctx.fillStyle = this.isDark ? 'rgba(15, 23, 42, 0.94)' : 'rgba(255, 255, 255, 0.96)';
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.roundRect(bx, by, boxW, boxH, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = this.isDark ? '#e0f2fe' : '#0f172a';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(line1, bx + 10, by + 6);
        ctx.fillStyle = this.isDark ? '#38bdf8' : '#0369a1';
        ctx.font = '600 10.5px ui-monospace, monospace';
        ctx.fillText(line2, bx + 10, by + 22);
        ctx.restore();
      }
    }
  }

  /**
   * Render Multi-Spectral Optics:
   * - 'aerodynamics': Flowing reaction-gas vector streamlines & continuous volumetric plumes (ignores ambient air).
   * - 'thermal': Whole-bench FLIR false-color thermal imaging heatmap (-15°C indigo -> 1000°C white-hot) with MSX silhouettes.
   */
  renderMultiSpectralOpticsOverlay(ctx, timeNow, mode) {
    const drawArrowHead = (tipX, tipY, ang, color, size = 4.0) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - size * Math.cos(ang - 0.5), tipY - size * Math.sin(ang - 0.5));
      ctx.lineTo(tipX - size * Math.cos(ang + 0.5), tipY - size * Math.sin(ang + 0.5));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const sampleSplinePt = (pts, u) => {
      if (pts.length === 0) return { x: 0, y: 0, ang: 0 };
      if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, ang: 0 };
      const scaled = Math.max(0, Math.min(1, u)) * (pts.length - 1);
      const i = Math.min(pts.length - 2, Math.floor(scaled));
      const f = scaled - i;
      const pA = pts[i];
      const pB = pts[i + 1];
      return {
        x: pA.x + (pB.x - pA.x) * f,
        y: pA.y + (pB.y - pA.y) * f,
        ang: Math.atan2(pB.y - pA.y, pB.x - pA.x),
      };
    };

    const drawFlowStreamline = (pts, color, width = 1.5, phaseShift = 0, label = '', arrowSize = 4.2, glowCore = null) => {
      if (pts.length < 2) return;
      ctx.save();
      const first = pts[0];
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];

      // Smooth gradient flow ribbon (fades gently at tail instead of jagged raw dashes)
      const grad = ctx.createLinearGradient(first.x, first.y, last.x, last.y);
      grad.addColorStop(0, glowCore || color);
      grad.addColorStop(0.7, color);
      grad.addColorStop(1, 'rgba(255,255,255,0.12)');
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.72;
      ctx.lineWidth = width * 1.45;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) * 0.5;
        const my = (pts[i].y + pts[i + 1].y) * 0.5;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(last.x, last.y);
      ctx.stroke();

      // Continuous animated micro-flow tracer beads gliding smoothly along streamline
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = glowCore || color;
      const beadCount = 3;
      for (let b = 0; b < beadCount; b++) {
        const u = ((timeNow * 0.65 + phaseShift * 0.13 + b / beadCount) % 1 + 1) % 1;
        const bp = sampleSplinePt(pts, u);
        const r = Math.max(1.2, width * 0.95) * (0.65 + 0.55 * Math.sin(u * Math.PI));
        ctx.beginPath();
        ctx.arc(bp.x, bp.y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      const ang = Math.atan2(last.y - prev.y, last.x - prev.x);
      drawArrowHead(last.x, last.y, ang, color, arrowSize);
      if (label) {
        const mid = pts[Math.floor(pts.length * 0.5)];
        ctx.globalAlpha = 0.96;
        ctx.font = 'bold 9.5px ui-monospace, monospace';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.fillText(formatCanvasText(label), mid.x, mid.y - 7);
      }
      ctx.restore();
    };

    if (mode === 'aerodynamics') {
      const GAS_PAL = {
        CO2_g: { rgba: 'rgba(139, 92, 246, 0.34)', core: 'rgba(167, 139, 250, 0.72)', stroke: '#a78bfa', formula: 'CO₂ (M=44 ↓)' },
        Cl2_g: { rgba: 'rgba(132, 204, 22, 0.34)', core: 'rgba(163, 230, 53, 0.72)', stroke: '#a3e635', formula: 'Cl₂ (M=71 ↓)' },
        Br2_g: { rgba: 'rgba(185, 28, 28, 0.42)', core: 'rgba(220, 38, 38, 0.78)', stroke: '#ef4444', formula: 'Br₂ (M=160 ↓)' },
        I2_g: { rgba: 'rgba(147, 51, 234, 0.42)', core: 'rgba(192, 132, 252, 0.78)', stroke: '#c084fc', formula: 'I₂ (M=254 ↓)' },
        S_g: { rgba: 'rgba(245, 158, 11, 0.36)', core: 'rgba(251, 191, 36, 0.72)', stroke: '#f59e0b', formula: 'S(g) (↓)' },
        HBr_g: { rgba: 'rgba(16, 185, 129, 0.30)', core: 'rgba(52, 211, 153, 0.68)', stroke: '#34d399', formula: 'HBr (M=81 ↓)' },
        HI_g: { rgba: 'rgba(16, 185, 129, 0.30)', core: 'rgba(52, 211, 153, 0.68)', stroke: '#34d399', formula: 'HI (M=128 ↓)' },
        HCl_g: { rgba: 'rgba(16, 185, 129, 0.30)', core: 'rgba(52, 211, 153, 0.68)', stroke: '#34d399', formula: 'HCl (M=36.5 ↓)' },
        HNO3_g: { rgba: 'rgba(244, 63, 94, 0.28)', core: 'rgba(251, 113, 133, 0.64)', stroke: '#fb7185', formula: 'HNO₃ (M=63 ↓)' },
        NO2_g: { rgba: 'rgba(249, 115, 22, 0.34)', core: 'rgba(251, 146, 60, 0.72)', stroke: '#fb923c', formula: 'NO₂ (M=46 ↓)' },
        NO_g: { rgba: 'rgba(245, 158, 11, 0.30)', core: 'rgba(251, 191, 36, 0.68)', stroke: '#fbbf24', formula: 'NO (M=30 ↓)' },
        O2_g: { rgba: 'rgba(14, 165, 233, 0.28)', core: 'rgba(56, 189, 248, 0.64)', stroke: '#38bdf8', formula: 'O₂ (M=32 ↓)' },
        H2_g: { rgba: 'rgba(6, 182, 212, 0.34)', core: 'rgba(34, 211, 238, 0.75)', stroke: '#22d3ee', formula: 'H₂ (M=2 ↑)' },
        NH3_g: { rgba: 'rgba(236, 72, 153, 0.34)', core: 'rgba(244, 114, 182, 0.75)', stroke: '#f472b6', formula: 'NH₃ (M=17 ↑)' },
        SO3_g: { rgba: 'rgba(244, 63, 94, 0.32)', core: 'rgba(251, 113, 133, 0.70)', stroke: '#fb7185', formula: 'SO₃ (M=80 ↓)' },
        SO2_g: { rgba: 'rgba(148, 163, 184, 0.34)', core: 'rgba(203, 213, 225, 0.72)', stroke: '#94a3b8', formula: 'SO₂ (M=64 ↓)' },
        H2S_g: { rgba: 'rgba(234, 179, 8, 0.30)', core: 'rgba(250, 204, 21, 0.68)', stroke: '#eab308', formula: 'H₂S (M=34 ↓)' },
        C2H5OH_g: { rgba: 'rgba(56, 189, 248, 0.26)', core: 'rgba(125, 211, 252, 0.60)', stroke: '#7dd3fc', formula: 'C₂H₅OH (M=46 ↓)' },
        C2H5Cl_g: { rgba: 'rgba(168, 85, 247, 0.28)', core: 'rgba(192, 132, 252, 0.62)', stroke: '#c084fc', formula: 'C₂H₅Cl (M=64.5 ↓)' },
        CO_g: { rgba: 'rgba(148, 163, 184, 0.28)', core: 'rgba(226, 232, 240, 0.66)', stroke: '#cbd5e1', formula: 'CO (M=28 ↑)' },
        C2H2_g: { rgba: 'rgba(56, 189, 248, 0.30)', core: 'rgba(186, 230, 253, 0.68)', stroke: '#38bdf8', formula: 'C₂H₂ (M=26 ↑)' },
        CH4_g: { rgba: 'rgba(16, 185, 129, 0.28)', core: 'rgba(110, 231, 183, 0.68)', stroke: '#34d399', formula: 'CH₄ (M=16 ↑)' },
        PH3_g: { rgba: 'rgba(234, 179, 8, 0.30)', core: 'rgba(254, 240, 138, 0.68)', stroke: '#eab308', formula: 'PH₃ (M=34 ↓)' },
        P4_g: { rgba: 'rgba(245, 158, 11, 0.28)', core: 'rgba(254, 243, 199, 0.68)', stroke: '#f59e0b', formula: 'P₄(g) (M=124 ↓)' },
        CrO2Cl2_g: { rgba: 'rgba(185, 28, 28, 0.42)', core: 'rgba(220, 38, 38, 0.78)', stroke: '#dc2626', formula: 'CrO₂Cl₂ (M=155 ↓)' },
        C2H4_g: { rgba: 'rgba(56, 189, 248, 0.26)', core: 'rgba(186, 230, 253, 0.62)', stroke: '#38bdf8', formula: 'C₂H₄ (M=28 ↑)' },
        CH3COOH_g: { rgba: 'rgba(148, 163, 184, 0.28)', core: 'rgba(241, 245, 249, 0.64)', stroke: '#cbd5e1', formula: 'CH₃COOH (M=60 ↓)' },
      };
      const getGasPal = (spId) => {
        if (GAS_PAL[spId]) return GAS_PAL[spId];
        const sp = SPECIES[spId];
        const mm = sp?.molarMass || 30;
        const sym = sp?.formula || spId.replace(/_g$/, '');
        return {
          rgba: 'rgba(148, 163, 184, 0.30)',
          core: 'rgba(203, 213, 225, 0.66)',
          stroke: '#cbd5e1',
          formula: `${sym} (M=${Math.round(mm)} ${mm >= 29 ? '↓' : '↑'})`,
        };
      };
      ctx.save();
      ctx.fillStyle = this.isDark ? 'rgba(2, 6, 23, 0.26)' : 'rgba(15, 23, 42, 0.14)';
      ctx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);

      const scrollPhase = -(timeNow * 40);
      let hasActiveFlow = false;

      // Helper to clip strictly to the rotated/inverted vessel physical interior path
      const clipToVesselInterior = (v, spec) => {
        const aero = getVesselAeroProfile(v, spec);
        ctx.save();
        ctx.translate(v.x, v.y);
        ctx.rotate(aero.effRad);
        if (v.isInverted) ctx.scale(1, -1);
        traceVesselInteriorClip(ctx, spec, 0, 0, v.softenSagFrac || 0);
        ctx.clip();
      };

      // Step A: Electrodes — independent open plumes at el.x OR routed tubing streamlines along buildRigidTubePoints!
      const electrodesByVessel = new Map();
      for (const el of this.sim.items) {
        if (el.kind !== 'electrode' || !el.dockedVesselId) continue;
        if (!electrodesByVessel.has(el.dockedVesselId)) electrodesByVessel.set(el.dockedVesselId, []);
        electrodesByVessel.get(el.dockedVesselId).push(el);
        if (!el.gasBubbleType || (el.gasBubbleRate || 0) <= 1e-7) continue;

        const mountedTube = this.sim.items.find((tIt) => tIt.kind === 'vessel' && tIt.mountedOverElectrodeId === el.id && !tIt.isShattered);
        const pal = getGasPal(el.gasBubbleType);
        if (el.gasTargetId && mountedTube?.id !== el.gasTargetId) {
          const target = this.sim.getItem(el.gasTargetId);
          if (target && !target.isShattered && !target.isBroken) {
            hasActiveFlow = true;
            const eH = el.renderHeight || APPARATUS.electrode_rod.height;
            const p0 = { x: el.x, y: el.y - eH / 2 + 8 };
            const p3 =
              target.kind === 'gas_syringe'
                ? (() => { const g = getSyringeGeometry(target); return { x: g.nozzleX, y: g.nozzleY }; })()
                : getTubeDestTipPos(el, target);
            const midY = Math.min(p0.y, p3.y) - 48;
            const pts = buildRigidTubePoints(p0, { x: p0.x, y: midY }, { x: p3.x, y: midY }, p3, target, { archLift: 46 });
            const sampled = [];
            for (let s = 0; s <= 12; s++) sampled.push(samplePolylineAt(pts, s / 12));
            drawFlowStreamline(sampled, pal.stroke, 1.8, scrollPhase, pal.formula, 4.2, pal.core);
          }
          continue;
        }
        if (mountedTube) {
          hasActiveFlow = true;
          continue;
        }

        // Open uncollected electrode: render vertical column centered right at el.x!
        const hostV = this.sim.getItem(el.dockedVesselId);
        if (hostV && !hostV.isShattered && !hostV.isStoppered) {
          hasActiveFlow = true;
          const hSpec = APPARATUS[hostV.typeId] || APPARATUS.beaker_250;
          const aero = getVesselAeroProfile(hostV, hSpec);
          const isHeavy = (SPECIES[el.gasBubbleType]?.molarMass || 30) >= 29;
          const startY = aero.mouthY + 4;
          if (isHeavy) {
            // Heavy gas (e.g. Cl2) pours out near the electrode edge and cascades down onto the bench floor
            const spillSide = el.x >= hostV.x ? 1 : -1;
            const spillPts = [
              { x: el.x, y: startY + 6 },
              { x: hostV.x + spillSide * (aero.mouthHalfPx + 10), y: aero.mouthY - 6 },
              { x: hostV.x + spillSide * (aero.bodyMaxRx + 16), y: Math.min(BENCH_FLOOR_Y - 8, hostV.y + hSpec.height * 0.44) },
            ];
            drawFlowStreamline(spillPts, pal.stroke, 1.5, scrollPhase, pal.formula, 4.0, pal.core);
          } else {
            // Light gas (e.g. H2) rises crisply straight upward at el.x
            for (let s = -1; s <= 1; s++) {
              const pts = [
                { x: el.x + s * 3, y: startY + 12 },
                { x: el.x + s * 6 + Math.sin(timeNow * 2.5 + s) * 3, y: startY - 26 },
                { x: el.x + s * 9, y: Math.max(18, startY - 82) },
              ];
              drawFlowStreamline(pts, pal.stroke, s === 0 ? 1.65 : 1.15, scrollPhase + s * 4, s === 0 ? pal.formula : '', 3.8, pal.core);
            }
          }
        }
      }

      // Helper to render one gas species behavior for a vessel across all 4 physical scenarios
      const renderSingleVesselGas = (v, spec, aero, gasId, idxInVessel, isSealedStopper, isOneHoleVent, hotBuoyant) => {
        const pal = getGasPal(gasId);
        const molarMass = SPECIES[gasId]?.molarMass || 30;
        const isHeavy = molarMass >= 29 && !hotBuoyant;
        const layerShift = idxInVessel * 7;

        if (isSealedStopper) {
          // Scenario 4: Sealed or tubed — internal recirculation clipped strictly inside exact vessel profile
          clipToVesselInterior(v, spec);
          const domeY = v.y - spec.height * (isHeavy ? -0.10 : 0.14);
          const inG = ctx.createRadialGradient(v.x, domeY, 4, v.x, domeY, aero.bodyMaxRx * 0.9);
          inG.addColorStop(0, pal.core);
          inG.addColorStop(0.65, pal.rgba);
          inG.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = inG;
          ctx.fillRect(v.x - aero.bodyMaxRx - 8, v.y - spec.height, aero.bodyMaxRx * 2 + 16, spec.height * 2);
          for (let k = -1; k <= 1; k++) {
            const xOff = k * (aero.bodyMaxRx * 0.36);
            const sw = Math.sin(timeNow * 2.6 + k) * 3;
            drawFlowStreamline(
              [
                { x: v.x + xOff, y: v.y + spec.height * 0.16 },
                { x: v.x + xOff * 0.7 + sw, y: domeY },
                { x: v.x + xOff * 0.35, y: aero.mouthY + (v.isInverted ? -14 : 14) },
              ],
              pal.stroke,
              k === 0 ? 1.45 : 1.1,
              scrollPhase + k * 5 + layerShift,
              k === 0 ? pal.formula : '',
              3.2,
              pal.core
            );
          }
          ctx.restore();
          return;
        }

        if (aero.isInvertedEffective && !isHeavy) {
          // Scenario 3A: Inverted vessel holding LIGHT gas (e.g. H2 / NH3 trapped in upper closed dome!)
          clipToVesselInterior(v, spec);
          const domeY = v.y - spec.height * 0.24;
          const domeG = ctx.createRadialGradient(v.x, domeY, 4, v.x, domeY, aero.bodyMaxRx * 0.95);
          domeG.addColorStop(0, pal.core);
          domeG.addColorStop(0.68, pal.rgba);
          domeG.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = domeG;
          ctx.fillRect(v.x - aero.bodyMaxRx - 8, v.y - spec.height, aero.bodyMaxRx * 2 + 16, spec.height * 2);

          // Internal toroidal recirculation trapped near closed upper dome
          for (const side of [-1, 1]) {
            drawFlowStreamline(
              [
                { x: v.x, y: v.y - spec.height * 0.05 },
                { x: v.x + side * aero.bodyMaxRx * 0.45, y: domeY - 6 },
                { x: v.x + side * aero.bodyMaxRx * 0.18, y: v.y - spec.height * 0.36 },
              ],
              pal.stroke,
              1.35,
              scrollPhase + side * 4,
              side === 1 ? pal.formula : '',
              3.4,
              pal.core
            );
          }
          ctx.restore();
          // Minor perimeter spillover looping upward around inverted bottom rim if bubbling vigorously
          if (!v.isStoppered && (v.lastGasRateMap?.[gasId] || 0) > 1e-4) {
            for (const side of [-1, 1]) {
              const rim = side < 0 ? aero.leftRim : aero.rightRim;
              drawFlowStreamline(
                [
                  { x: rim.x, y: rim.y - 2 },
                  { x: rim.x + side * 14, y: rim.y - 16 },
                  { x: rim.x + side * 18, y: rim.y - 44 },
                ],
                pal.stroke,
                1.05,
                scrollPhase + side * 6,
                '',
                3.0,
                pal.core
              );
            }
          }
          return;
        }

        if (aero.isInvertedEffective && isHeavy) {
          // Scenario 3B: Inverted vessel with HEAVY gas -> plunges straight downward out of downward mouth onto bench floor!
          const startX = aero.mouthX;
          const startY = aero.mouthY;
          const floorY = Math.min(BENCH_FLOOR_Y - 6, startY + 95);
          const fallG = ctx.createLinearGradient(startX, startY, startX, floorY);
          fallG.addColorStop(0, pal.core);
          fallG.addColorStop(0.75, pal.rgba);
          fallG.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = fallG;
          ctx.beginPath();
          ctx.moveTo(aero.leftRim.x, aero.leftRim.y);
          ctx.lineTo(aero.rightRim.x, aero.rightRim.y);
          ctx.lineTo(startX + Math.max(46, aero.mouthHalfPx * 3.2), BENCH_FLOOR_Y);
          ctx.lineTo(startX - Math.max(46, aero.mouthHalfPx * 3.2), BENCH_FLOOR_Y);
          ctx.closePath();
          ctx.fill();

          for (let s = -2; s <= 2; s++) {
            const u = s / 2;
            const sway = Math.sin(timeNow * 2.2 + s) * 3;
            drawFlowStreamline(
              [
                { x: startX + u * aero.mouthHalfPx * 0.65, y: startY - 6 },
                { x: startX + u * (aero.mouthHalfPx + 10) + sway * 0.4, y: (startY + BENCH_FLOOR_Y) * 0.52 },
                { x: startX + u * (aero.mouthHalfPx + 42), y: BENCH_FLOOR_Y - 8 - Math.abs(s) * 2 },
              ],
              pal.stroke,
              s === 0 ? 1.65 : 1.2,
              scrollPhase + s * 5,
              s === 0 ? pal.formula : '',
              3.8,
              pal.core
            );
          }
          return;
        }

        if (isHeavy) {
          // Scenario 2: Heavy gas inside upright/tilted vessel -> contoured fill + exclusive lowRim cascade when tilted or full
          clipToVesselInterior(v, spec);
          const plumeY = v.y + spec.height * 0.14;
          const pg = ctx.createRadialGradient(v.x, plumeY, 4, v.x, plumeY, aero.bodyMaxRx * 1.15);
          pg.addColorStop(0, pal.core);
          pg.addColorStop(0.68, pal.rgba);
          pg.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = pg;
          ctx.fillRect(v.x - aero.bodyMaxRx - 8, v.y - spec.height, aero.bodyMaxRx * 2 + 16, spec.height * 2);
          for (let k = -1; k <= 1; k++) {
            const xOff = k * (aero.bodyMaxRx * 0.34);
            const sw = Math.sin(timeNow * 2.4 + k) * 2.5;
            drawFlowStreamline(
              [
                { x: aero.mouthX + xOff * 0.4, y: aero.mouthY + 14 },
                { x: v.x + xOff + sw, y: plumeY },
                { x: v.x + xOff * 1.1, y: v.y + spec.height * 0.34 },
              ],
              pal.stroke,
              1.2,
              scrollPhase + k * 5 + layerShift,
              '',
              3.3,
              pal.core
            );
          }
          ctx.restore();

          if (!v.isStoppered) {
            const spillFloorY = Math.min(BENCH_FLOOR_Y - 6, v.y + spec.height * 0.44);
            if (aero.tiltDegEff >= 4) {
              // Tilted: cascade cleanly exclusively over lowRim!
              const lowRim = aero.lowRim;
              const dirSign = lowRim.x >= v.x ? 1 : -1;
              const spreadG = ctx.createLinearGradient(lowRim.x, lowRim.y, lowRim.x + dirSign * 44, BENCH_FLOOR_Y);
              spreadG.addColorStop(0, pal.core);
              spreadG.addColorStop(0.68, pal.rgba);
              spreadG.addColorStop(1, 'rgba(0,0,0,0)');
              ctx.fillStyle = spreadG;
              ctx.beginPath();
              ctx.moveTo(lowRim.x - dirSign * 6, lowRim.y);
              ctx.lineTo(lowRim.x + dirSign * 10, lowRim.y);
              ctx.bezierCurveTo(lowRim.x + dirSign * 42, lowRim.y + 34, lowRim.x + dirSign * 72, BENCH_FLOOR_Y - 22, lowRim.x + dirSign * 124, BENCH_FLOOR_Y);
              ctx.lineTo(lowRim.x - dirSign * 40, BENCH_FLOOR_Y);
              ctx.closePath();
              ctx.fill();

              for (let s = -2; s <= 2; s++) {
                const u = s / 2;
                const sway = Math.sin(timeNow * 2.2 + s * 0.9) * 3;
                drawFlowStreamline(
                  [
                    { x: lowRim.x + u * 4, y: lowRim.y + 2 },
                    { x: lowRim.x + dirSign * (16 + u * 8) + sway * 0.4, y: lowRim.y + 28 },
                    { x: lowRim.x + dirSign * (34 + u * 22) + sway, y: Math.min(BENCH_FLOOR_Y - 14, (lowRim.y + BENCH_FLOOR_Y) * 0.56) },
                    { x: lowRim.x + dirSign * (48 + u * 48), y: BENCH_FLOOR_Y - 8 - Math.abs(s) * 2 },
                  ],
                  pal.stroke,
                  s === 0 ? 1.65 : 1.2,
                  scrollPhase + s * 6 + layerShift,
                  s === 0 ? pal.formula : '',
                  3.8,
                  pal.core
                );
              }
            } else {
              // Upright overflow cascade down both edges outside real rim
              for (const side of [-1, 1]) {
                const rim = side < 0 ? aero.leftRim : aero.rightRim;
                const xWall = v.x + side * (aero.bodyMaxRx + 14);
                const sideG = ctx.createLinearGradient(rim.x, rim.y, xWall, spillFloorY);
                sideG.addColorStop(0, pal.core);
                sideG.addColorStop(0.72, pal.rgba);
                sideG.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = sideG;
                ctx.beginPath();
                ctx.moveTo(rim.x - side * 3, rim.y + 2);
                ctx.quadraticCurveTo(xWall + side * 8, rim.y - 8, xWall + side * 12, spillFloorY);
                ctx.lineTo(xWall - side * 10, spillFloorY);
                ctx.quadraticCurveTo(rim.x + side * 4, rim.y + 4, rim.x - side * 3, rim.y + 8);
                ctx.closePath();
                ctx.fill();

                for (let f = 0; f < 2; f++) {
                  const wv = Math.sin(timeNow * 2.3 + side + f) * 2.5;
                  drawFlowStreamline(
                    [
                      { x: rim.x - side * 2, y: rim.y + 6 },
                      { x: xWall - side * (4 - f * 4), y: rim.y - 4 + wv },
                      { x: xWall + side * (2 + f * 6), y: spillFloorY - 4 },
                    ],
                    pal.stroke,
                    1.25,
                    scrollPhase + f * 6 + layerShift,
                    side === 1 && f === 0 ? pal.formula : '',
                    3.6,
                    pal.core
                  );
                }
              }
            }
          }
          return;
        }

        // Scenario 1: Open upright / tilted LIGHT or HOT buoyant gas -> Venturi jet along exitDir curving vertically up
        const ventScale = isOneHoleVent ? 0.30 : 1.0;
        const startRim = aero.tiltDegEff >= 4 ? aero.highRim : { x: aero.mouthX, y: aero.mouthY };
        const jetLen = (24 + 12 * aero.throatRatio) * ventScale;
        const plumeCx = startRim.x + aero.exitDir.x * (jetLen * 1.15);
        const plumeCy = startRim.y + aero.exitDir.y * (jetLen * 1.15) - 24 * ventScale;
        const domeRadius = Math.max(18, Math.max(aero.mouthHalfPx * 1.8, spec.width * 0.44) * ventScale);
        const domeH = 78 * ventScale;
        const domeG = ctx.createRadialGradient(plumeCx, plumeCy, 4, plumeCx, plumeCy - 8 * ventScale, domeH * 1.15);
        domeG.addColorStop(0, pal.core);
        domeG.addColorStop(0.58, pal.rgba);
        domeG.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = domeG;
        ctx.beginPath();
        ctx.ellipse(plumeCx, plumeCy, domeRadius, domeH, 0, 0, Math.PI * 2);
        ctx.fill();

        const sLim = isOneHoleVent ? 0 : 2;
        for (let s = -sLim; s <= sLim; s++) {
          const u = sLim === 0 ? 0 : s / sLim;
          const sw = Math.sin(timeNow * 2.8 + s * 1.1) * 4.5 * ventScale;
          const mSpread = u * Math.min(12, aero.mouthHalfPx * 0.8);
          const pts = [
            { x: startRim.x + mSpread, y: startRim.y + 8 },
            { x: startRim.x + mSpread * 0.7 + aero.exitDir.x * jetLen * 0.65, y: startRim.y + aero.exitDir.y * jetLen * 0.65 },
            { x: plumeCx + u * (domeRadius * 0.45) + sw * 0.5, y: plumeCy - 18 * ventScale },
            { x: plumeCx + u * (domeRadius * 0.68), y: Math.max(16, plumeCy - 72 * ventScale + Math.abs(s) * 4) },
          ];
          drawFlowStreamline(pts, pal.stroke, s === 0 ? 1.65 : 1.25, scrollPhase + s * 6 + layerShift, s === 0 ? pal.formula : '', 3.8, pal.core);
        }
      };

      // Step B: Process every vessel & optional stoppered vessel tubing streamlines
      for (const v of this.sim.items) {
        if (v.kind !== 'vessel' || v.isShattered) continue;
        const spec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
        const aero = getVesselAeroProfile(v, spec);
        const vesselEls = electrodesByVessel.get(v.id) || [];
        const entries = Object.entries({ ...(v.headspaceGasMoles || {}), ...(v.lastGasRateMap || {}) })
          .map(([g]) => [g, (v.headspaceGasMoles?.[g] || 0) + (v.lastGasRateMap?.[g] || 0) * 0.45])
          .filter(([g, val]) => g !== 'H2O_g' && val > 1e-6);
        if (entries.length === 0) continue;
        entries.sort((a, b) => b[1] - a[1]);

        const hasOutTube = Boolean(v.connectedTargetId || v.connectedSyringeId || v.connectedFromId);
        const isSealedStopper = Boolean(v.isStoppered && (v.stopperMode === 'solid' || hasOutTube));
        const isOneHoleVent = Boolean(v.isStoppered && v.stopperMode !== 'solid' && !hasOutTube);

        // Draw colored gas streamline inside vessel delivery tubing if sending gas to another vessel/syringe
        if (v.connectedTargetId && isSealedStopper) {
          const dst = this.sim.getItem(v.connectedTargetId);
          if (dst && !dst.isBroken && !dst.isShattered) {
            const p0 = getVesselTubingPort(v);
            const p3 =
              dst.kind === 'gas_syringe'
                ? (() => { const g = getSyringeGeometry(dst); return { x: g.nozzleX, y: g.nozzleY }; })()
                : getTubeDestTipPos(v, dst);
            const midY = Math.min(p0.y, p3.y) - 44;
            const pts = buildRigidTubePoints(p0, { x: p0.x, y: midY }, { x: p3.x, y: midY }, p3, dst, { archLift: 44 });
            const pal = getGasPal(entries[0][0]);
            const sampled = [];
            for (let s = 0; s <= 12; s++) sampled.push(samplePolylineAt(pts, s / 12));
            drawFlowStreamline(sampled, pal.stroke, 1.75, scrollPhase, pal.formula, 4.0, pal.core);
          }
        }

        // Skip gases whose active evolution is already handled independently at open electrode(s) with no bulk headspace
        const filteredEntries = entries.filter(([g]) => {
          const matchedEl = vesselEls.find((el) => el.gasBubbleType === g && (el.gasBubbleRate || 0) > 1e-7);
          if (!matchedEl) return true;
          return (v.headspaceGasMoles?.[g] || 0) > 1e-5;
        });
        if (filteredEntries.length === 0) continue;

        hasActiveFlow = true;
        const hotBuoyant = (v.tempK || 298.15) > 353.15;
        // Pick Top-2 stratified gases if secondary gas is substantial & has opposite density tier
        const topList = [filteredEntries[0]];
        if (filteredEntries.length > 1 && filteredEntries[1][1] > filteredEntries[0][1] * 0.18) {
          const m0 = SPECIES[filteredEntries[0][0]]?.molarMass || 30;
          const m1 = SPECIES[filteredEntries[1][0]]?.molarMass || 30;
          if ((m0 >= 29) !== (m1 >= 29)) {
            topList.push(filteredEntries[1]);
          }
        }
        topList.forEach(([gId], idx) => {
          renderSingleVesselGas(v, spec, aero, gId, idx, isSealedStopper, isOneHoleVent, hotBuoyant);
        });
      }

      ctx.fillStyle = 'rgba(2, 6, 23, 0.78)';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(10, 10, 224, 24, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        formatCanvasText(
          hasActiveFlow
            ? this.langCode === 'en'
              ? 'Aero: Reaction Gas Flow Only'
              : 'Bá khí: Luồng khí phản ứng'
            : this.langCode === 'en'
            ? 'Aero: No Active Gas Evolution'
            : 'Bá khí: Chưa có khí sinh ra'
        ),
        18,
        22
      );
      ctx.restore();
      return;
    }

    if (mode === 'thermal') {
      // High-sharpness 480 x 270 thermal diffusion field -> Ironbow/Rainbow FLIR LUT
      const GW = 480;
      const GH = 270;
      if (!this._thermalCanvas || this._thermalCanvas.width !== GW || this._thermalCanvas.height !== GH) {
        this._thermalCanvas = document.createElement('canvas');
        this._thermalCanvas.width = GW;
        this._thermalCanvas.height = GH;
        this._thermalCtx = this._thermalCanvas.getContext('2d');
        this._thermalImgData = this._thermalCtx.createImageData(GW, GH);
        this._thermalGrid = new Float32Array(GW * GH);
        this._thermalGridTmp = new Float32Array(GW * GH);
        this._flirLut = new Uint8Array(256 * 3);
        const stops = [
          [0.0, [14, 16, 128]],
          [0.18, [29, 78, 216]],
          [0.34, [6, 182, 212]],
          [0.48, [34, 197, 94]],
          [0.64, [250, 204, 21]],
          [0.80, [249, 115, 22]],
          [0.92, [239, 68, 68]],
          [1.0, [255, 255, 255]],
        ];
        for (let i = 0; i < 256; i++) {
          const u = i / 255;
          let s0 = stops[0];
          let s1 = stops[stops.length - 1];
          for (let k = 0; k < stops.length - 1; k++) {
            if (u >= stops[k][0] && u <= stops[k + 1][0]) {
              s0 = stops[k];
              s1 = stops[k + 1];
              break;
            }
          }
          const span = Math.max(1e-5, s1[0] - s0[0]);
          const f = (u - s0[0]) / span;
          this._flirLut[i * 3] = Math.round(s0[1][0] + (s1[1][0] - s0[1][0]) * f);
          this._flirLut[i * 3 + 1] = Math.round(s0[1][1] + (s1[1][1] - s0[1][1]) * f);
          this._flirLut[i * 3 + 2] = Math.round(s0[1][2] + (s1[1][2] - s0[1][2]) * f);
        }
      }

      const grid = this._thermalGrid;
      const tmp = this._thermalGridTmp;
      const ambC = (this.sim.environment?.tempK ?? 298.15) - 273.15;
      for (let gy = 0; gy < GH; gy++) {
        const wy = (gy / GH) * BENCH_LOGICAL_H;
        const baseC = wy >= BENCH_FLOOR_Y ? ambC - 7.5 : ambC - (1 - gy / GH) * 3.5;
        for (let gx = 0; gx < GW; gx++) {
          grid[gy * GW + gx] = baseC;
        }
      }

      const splatHeat = (cx, cy, rx, ry, targetC, strength = 0.85) => {
        const minX = Math.max(0, Math.floor(((cx - rx * 1.5) / BENCH_LOGICAL_W) * GW));
        const maxX = Math.min(GW - 1, Math.ceil(((cx + rx * 1.5) / BENCH_LOGICAL_W) * GW));
        const minY = Math.max(0, Math.floor(((cy - ry * 1.5) / BENCH_LOGICAL_H) * GH));
        const maxY = Math.min(GH - 1, Math.ceil(((cy + ry * 1.5) / BENCH_LOGICAL_H) * GH));
        for (let gy = minY; gy <= maxY; gy++) {
          const wy = ((gy + 0.5) / GH) * BENCH_LOGICAL_H;
          const dy = (wy - cy) / Math.max(12, ry);
          for (let gx = minX; gx <= maxX; gx++) {
            const wx = ((gx + 0.5) / GW) * BENCH_LOGICAL_W;
            const dx = (wx - cx) / Math.max(12, rx);
            const d2 = dx * dx + dy * dy;
            if (d2 > 2.25) continue;
            const w = strength * Math.exp(-d2 * 1.45);
            const idx = gy * GW + gx;
            grid[idx] = grid[idx] * (1 - w) + targetC * w;
          }
        }
      };

      let obsMinC = ambC - 4;
      let obsMaxC = ambC + 10;
      for (const it of this.sim.items) {
        if (it.isShattered || it.isBroken) continue;
        if (it.kind === 'bath') {
          const bC = it.bathTargetC ?? (it.bathMode === 'ice_salt' ? -10 : 0);
          obsMinC = Math.min(obsMinC, bC);
          obsMaxC = Math.max(obsMaxC, bC);
          splatHeat(it.x, it.y, 92, 52, bC, 0.96);
          splatHeat(it.x, BENCH_FLOOR_Y + 6, 125, 22, (bC + ambC) * 0.5, 0.55);
          if (bC > ambC + 8) {
            const plumeC = ambC + (bC - ambC) * 0.52;
            splatHeat(it.x, it.y - 44, 72, 38, plumeC, 0.58);
          } else if (bC < ambC - 8) {
            splatHeat(it.x, it.y - 26, 72, 24, (bC + ambC) * 0.5, 0.42);
          }
        } else if (it.kind === 'burner' && (it.powerW || 0) > 0) {
          const isBlue = it.typeId === 'bunsen_burner' && it.airHoleOpen !== false;
          const peakC = isBlue ? 1350 : 920;
          obsMaxC = Math.max(obsMaxC, peakC);
          const plumeH = 85 + ((it.powerW || 0) / 1100) * 115;
          splatHeat(it.x, it.y - 12, 34, 34, peakC, 0.95);
          splatHeat(it.x, it.y - plumeH * 0.55, 56, plumeH * 0.65, peakC * 0.55, 0.72);
          splatHeat(it.x, it.y - plumeH * 1.05, 84, plumeH * 0.5, ambC + 180, 0.42);
        } else if (it.kind === 'vessel') {
          const spec = APPARATUS[it.typeId] || APPARATUS.beaker_250;
          const vC = (it.tempK ?? 298.15) - 273.15;
          obsMinC = Math.min(obsMinC, vC);
          obsMaxC = Math.max(obsMaxC, vC);
          splatHeat(it.x, it.y + 4, spec.width * 0.62, spec.height * 0.62, vC, 0.9);
          if ((it.lastExothermicJ || 0) > 20) {
            obsMaxC = Math.max(obsMaxC, vC + 95);
            splatHeat(it.x, it.y + spec.height * 0.18, 36, 32, vC + 110, 0.85);
          }
        } else if (it.kind === 'spoon' && (it.tempK || 298.15) > 315) {
          const sC = (it.tempK || 298.15) - 273.15;
          obsMaxC = Math.max(obsMaxC, sC);
          splatHeat(it.x, it.y, 44, 24, sC, 0.88);
        } else if (it.kind === 'splint' && (it.mode === 'burning' || it.mode === 'glowing')) {
          const tip = getProbeTipPos(it);
          const splC = it.mode === 'burning' ? 680 : 520;
          obsMaxC = Math.max(obsMaxC, splC);
          splatHeat(tip.x, tip.y, 18, 18, splC, 0.96);
          splatHeat(tip.x, tip.y - 14, 24, 22, splC * 0.55, 0.58);
        } else if (it.kind === 'condenser' && it.waterFlowOn) {
          const ports = getCondenserPorts(it);
          const coolC = 6;
          obsMinC = Math.min(obsMinC, coolC);
          for (let s = 0; s < 5; s++) {
            const u = s / 4;
            const px = ports.inlet.x + (ports.outlet.x - ports.inlet.x) * u;
            const py = ports.inlet.y + (ports.outlet.y - ports.inlet.y) * u;
            splatHeat(px, py, 26, 20, coolC, 0.94);
          }
          splatHeat(it.x, it.y, 38, 22, coolC + 2, 0.88);
        }
      }

      for (let pass = 0; pass < 2; pass++) {
        for (let gy = 0; gy < GH; gy++) {
          for (let gx = 0; gx < GW; gx++) {
            const c = grid[gy * GW + gx];
            const l = grid[gy * GW + Math.max(0, gx - 1)];
            const r = grid[gy * GW + Math.min(GW - 1, gx + 1)];
            const u = grid[Math.max(0, gy - 1) * GW + gx];
            const d = grid[Math.min(GH - 1, gy + 1) * GW + gx];
            tmp[gy * GW + gx] = c * 0.44 + (l + r + u + d) * 0.14;
          }
        }
        grid.set(tmp);
      }

      const pixels = this._thermalImgData.data;
      const spanLow = Math.min(-20, obsMinC);
      const spanHigh = Math.max(120, obsMaxC);
      const mapTempNorm = (c) => {
        if (c <= 28) {
          return Math.max(0.02, Math.min(0.28, ((c - spanLow) / (28 - spanLow)) * 0.28));
        }
        const hotFrac = Math.max(0, Math.min(1, (c - 28) / (spanHigh - 28)));
        return 0.28 + Math.pow(hotFrac, 0.44) * 0.72;
      };

      for (let i = 0; i < GW * GH; i++) {
        const idxLut = Math.max(0, Math.min(255, Math.round(mapTempNorm(grid[i]) * 255))) * 3;
        const p = i * 4;
        pixels[p] = this._flirLut[idxLut];
        pixels[p + 1] = this._flirLut[idxLut + 1];
        pixels[p + 2] = this._flirLut[idxLut + 2];
        pixels[p + 3] = 212;
      }
      this._thermalCtx.putImageData(this._thermalImgData, 0, 0);

      ctx.save();
      const padV = Math.max(0, (this.viewOffsetY || 0) / Math.max(0.1, this.viewScale || 1)) + 8;
      const padH = Math.max(0, (this.viewOffsetX || 0) / Math.max(0.1, this.viewScale || 1)) + 8;
      const ambLut = Math.max(0, Math.min(255, Math.round(mapTempNorm(ambC - 2) * 255))) * 3;
      ctx.fillStyle = `rgba(${this._flirLut[ambLut]}, ${this._flirLut[ambLut + 1]}, ${this._flirLut[ambLut + 2]}, 0.84)`;
      ctx.fillRect(-padH, -padV, BENCH_LOGICAL_W + padH * 2, BENCH_LOGICAL_H + padV * 2);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this._thermalCanvas, 0, 0, BENCH_LOGICAL_W, BENCH_LOGICAL_H);

      // Composite WebGL2 buoyant thermal gas plumes directly OVER the background FLIR map
      if (this.fluidGasOverlay?.enabled && !this.fluidGasOverlay.isSleeping && this.fluidGasOverlay?.canvas) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.94;
        ctx.drawImage(this.fluidGasOverlay.canvas, 0, 0, BENCH_LOGICAL_W, BENCH_LOGICAL_H);
        ctx.restore();
      }

      // Draw soft warm FLIR convective gas plume columns above vessels actively venting hot gases (> ambC + 5 C)
      for (const v of this.sim.items) {
        if (v.kind !== 'vessel' || v.isShattered) continue;
        const hasTube = Boolean(v.connectedTargetId || v.connectedSyringeId || v.connectedFromId);
        if (v.isStoppered && (v.stopperMode === 'solid' || hasTube)) continue;
        const dC = (v.tempK || 298.15) - 273.15 - ambC;
        if (dC < 5) continue;
        const head = v.headspaceGasMoles || {};
        const rates = v.lastGasRateMap || {};
        let gasSig = 0;
        for (const k of Object.keys(head)) gasSig += head[k] || 0;
        for (const k of Object.keys(rates)) gasSig += (rates[k] || 0) * 0.25;
        if (gasSig <= 1e-5 && (v.tempK || 298.15) < 345) continue;
        const sp = APPARATUS[v.typeId] || APPARATUS.beaker_250;
        const mouthY = v.y - sp.height * 0.44;
        const plumeH = Math.min(115, 36 + dC * 0.95);
        const plumeW = Math.max(16, (sp.neckRadius || sp.width * 0.3) * 1.15);
        const warmCol = dC >= 90 ? 'rgba(255, 215, 90, 0.56)' : dC >= 20 ? 'rgba(249, 115, 22, 0.52)' : 'rgba(56, 189, 248, 0.42)';
        const gPlume = ctx.createRadialGradient(v.x, mouthY - plumeH * 0.38, 4, v.x, mouthY - plumeH * 0.48, plumeH);
        gPlume.addColorStop(0, warmCol);
        gPlume.addColorStop(0.55, 'rgba(6, 182, 212, 0.26)');
        gPlume.addColorStop(1, 'rgba(6, 182, 212, 0)');
        ctx.fillStyle = gPlume;
        ctx.beginPath();
        ctx.ellipse(v.x + Math.sin(timeNow * 3 + v.x) * 2.5, mouthY - plumeH * 0.45, plumeW, plumeH * 0.58, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.52)';
      ctx.lineWidth = 1.4;
      for (const it of this.sim.items) {
        const sp = APPARATUS[it.typeId];
        if (!sp || it.isShattered || it.isBroken) continue;
        const rad = (it.tiltAngle || 0) + (it.landingTilt || 0);
        ctx.save();
        if (rad) {
          ctx.translate(it.x, it.y);
          ctx.rotate(rad);
          ctx.translate(-it.x, -it.y);
        }
        ctx.beginPath();
        ctx.roundRect(it.x - sp.width * 0.46, it.y - sp.height * 0.46, sp.width * 0.92, sp.height * 0.92, 6);
        ctx.stroke();
        ctx.restore();
      }

      const barX = BENCH_LOGICAL_W - 26;
      const barTop = 58;
      const barH = 190;
      const vg = ctx.createLinearGradient(0, barTop, 0, barTop + barH);
      vg.addColorStop(0.0, '#ffffff');
      vg.addColorStop(0.14, '#ef4444');
      vg.addColorStop(0.32, '#f97316');
      vg.addColorStop(0.50, '#facc15');
      vg.addColorStop(0.68, '#22c55e');
      vg.addColorStop(0.84, '#06b6d4');
      vg.addColorStop(1.0, '#0e1080');

      ctx.fillStyle = 'rgba(2, 6, 23, 0.72)';
      ctx.beginPath();
      ctx.roundRect(barX - 24, barTop - 22, 42, barH + 44, 7);
      ctx.fill();
      ctx.fillStyle = vg;
      ctx.fillRect(barX, barTop, 10, barH);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.lineWidth = 1;
      ctx.strokeRect(barX, barTop, 10, barH);

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('+', barX + 5, barTop - 9);
      ctx.fillText('-', barX + 5, barTop + barH + 13);

      if (this.pointerLogical) {
        const gx = Math.max(0, Math.min(GW - 1, Math.floor((this.pointerLogical.x / BENCH_LOGICAL_W) * GW)));
        const gy = Math.max(0, Math.min(GH - 1, Math.floor((this.pointerLogical.y / BENCH_LOGICAL_H) * GH)));
        const spotC = grid[gy * GW + gx];
        const spotTxt = formatCanvasText(`${spotC.toFixed(1)}°C`);
        ctx.fillStyle = 'rgba(2, 6, 23, 0.84)';
        ctx.strokeStyle = '#facc15';
        ctx.beginPath();
        ctx.roundRect(10, 10, 118, 24, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fde047';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatCanvasText(`FLIR ${obsMaxC.toFixed(0)}°C | ${spotTxt}`), 16, 22);
      }
      ctx.restore();
    }
  }
}
