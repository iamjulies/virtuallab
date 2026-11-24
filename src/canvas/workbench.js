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
  renderBurner,
  renderGasSyringe,
  renderPipette,
  renderRetortClampJaw,
  renderRetortStand,
  renderScale,
  renderTubingConnections,
  renderVessel,
  setCurrentLabelItemId,
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

  setTheme(isDark, themeName = isDark ? 'dark' : 'light') {
    this.isDark = isDark;
    this.themeName = themeName || (isDark ? 'dark' : 'light');
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

  handleCanvasWheel(pt, deltaY, shiftKey = false) {
    const heldItem = this.dragState ? this.sim.getItem(this.dragState.itemId) : null;
    const hit = heldItem || this.hitTestItem(pt.x, pt.y);
    if (!hit) {
      if (!this.dragState) this.resetWheelTiltedVessel(null);
      return false;
    }
    if (!this.dragState && this._wheelTiltVesselId && this._wheelTiltVesselId !== hit.id) {
      this.resetWheelTiltedVessel(hit.id);
    }

    const clamp = (lo, hi, val) => Math.max(lo, Math.min(hi, val));
    const stepDiscrete = (key, dy, cb) => {
      if (this._wheelAccum.key !== key) this._wheelAccum = { key, sum: 0 };
      this._wheelAccum.sum += dy;
      if (Math.abs(this._wheelAccum.sum) < 80) return true;
      const dir = this._wheelAccum.sum > 0 ? 1 : -1;
      this._wheelAccum.sum = 0;
      cb(dir);
      return true;
    };

    if (hit.kind === 'bath') {
      return stepDiscrete(`bath:${hit.id}`, deltaY, (dir) => {
        soundEngine.playUiClick();
        const steps = APPARATUS.ice_bath?.bathTempSteps || [-20, -10, 0, 10, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200];
        const curC = hit.bathTargetC ?? (hit.bathMode === 'ice_salt' ? -10 : 0);
        let idx = steps.indexOf(curC);
        if (idx < 0) {
          idx = steps.reduce((best, v, i) => (Math.abs(v - curC) < Math.abs(steps[best] - curC) ? i : best), 0);
        }
        // Scroll up (deltaY < 0, dir < 0) increases temperature; scroll down decreases
        const nextIdx = Math.max(0, Math.min(steps.length - 1, idx + (dir < 0 ? 1 : -1)));
        this.sim.setBathTargetTempC(hit.id, steps[nextIdx]);
      });
    }

    if (hit.kind === 'electrode') {
      return stepDiscrete(`el:${hit.id}`, deltaY, (dir) => {
        const order = ['C', 'Cu', 'Zn'];
        const curIdx = Math.max(0, order.indexOf(hit.material));
        const nextMat = order[(curIdx + (dir > 0 ? 1 : order.length - 1)) % order.length];
        soundEngine.playUiClick();
        this.sim.setElectrodeMaterial(hit.id, nextMat);
      });
    }

    if (hit.kind === 'volt_ammeter') {
      return stepDiscrete(`vm:${hit.id}`, deltaY, (dir) => {
        const modes = ['voltmeter', 'ammeter', 'short'];
        const curIdx = Math.max(0, modes.indexOf(hit.mode));
        const nextMode = modes[(curIdx + (dir > 0 ? 1 : modes.length - 1)) % modes.length];
        soundEngine.playUiClick();
        this.sim.setVoltAmmeterState(hit.id, { mode: nextMode });
      });
    }

    if (hit.kind === 'stir_bar') {
      if (!hit.inVesselId) return false;
      const host = this.sim.getItem(hit.inVesselId);
      const curRpm = host?.magStirRpm || 0;
      const nextRpm = clamp(0, 1200, curRpm + (deltaY < 0 ? 100 : -100));
      this.sim.toggleMagneticStir(hit.inVesselId, nextRpm);
      return true;
    }

    if (hit.kind === 'dc_power') {
      if (shiftKey) {
        const curR = hit.rheostatOhm ?? 2.0;
        const nextR = Math.round(clamp(0.5, 25, curR + (deltaY < 0 ? 0.5 : -0.5)) * 2) / 2;
        this.sim.setDcPowerState(hit.id, { rheostatOhm: nextR });
      } else {
        const curV = hit.voltageV ?? 6;
        const nextV = Math.round(clamp(0, 12, curV + (deltaY < 0 ? 0.5 : -0.5)) * 2) / 2;
        this.sim.setDcPowerState(hit.id, { voltageV: nextV });
      }
      return true;
    }

    if (hit.kind === 'stand') {
      if (shiftKey) {
        return stepDiscrete(`stand-flip:${hit.id}`, deltaY, () => {
          soundEngine.playUiClick();
          this.sim.flipItemLR(hit.id);
        });
      }
      const curExt = hit.extendPx || 0;
      const nextExt = clamp(0, 200, Math.round(curExt + (deltaY < 0 ? 10 : -10)));
      this.sim.setStandExtension(hit.id, nextExt);
      return true;
    }

    if (hit.kind === 'wash_bottle') {
      if (shiftKey) {
        return stepDiscrete(`wb-flip:${hit.id}`, deltaY, () => {
          soundEngine.playUiClick();
          this.sim.flipItemLR(hit.id);
        });
      }
      const nextAng = clamp(-45, 45, Math.round((hit.sprayAngleDeg || 0) + (deltaY > 0 ? 5 : -5)));
      this.sim.setWashBottleAngle(hit.id, nextAng);
      return true;
    }

    if (hit.kind === 'condenser') {
      if (shiftKey) {
        return stepDiscrete(`cond-water:${hit.id}`, deltaY, () => {
          soundEngine.playUiClick();
          hit.waterFlowOn = !hit.waterFlowOn;
          this.sim.emitChange();
        });
      }
      const nextRot = clamp(-45, 45, Math.round((hit.rotationDeg || 0) + (deltaY > 0 ? 5 : -5)));
      this.sim.setCondenserRotation(hit.id, nextRot);
      // Keep rotated Liebig condenser above bench floor cleanly
      const cSpec = APPARATUS[hit.typeId] || APPARATUS.liebig_condenser;
      const maxCY = BENCH_FLOOR_Y - getItemRotatedHalfExtentY(cSpec, hit) + 2;
      if (hit.y > maxCY) {
        hit.y = maxCY;
        this.sim.emitChange();
      }
      return true;
    }

    if (hit.kind === 'burette') {
      const curRate = hit.valveRateMlS || 0;
      const nextRate = Math.round(clamp(0, 5.0, curRate + (deltaY > 0 ? 0.25 : -0.25)) * 100) / 100;
      this.sim.setBuretteValveRate(hit.id, nextRate);
      return true;
    }

    if (hit.kind === 'splint') {
      return stepDiscrete(`splint-mode:${hit.id}`, deltaY, (dir) => {
        const order = ['unlit', 'glowing', 'burning'];
        const curIdx = Math.max(0, order.indexOf(hit.mode || 'unlit'));
        hit.mode = order[(curIdx + (dir > 0 ? 1 : order.length - 1)) % order.length];
        soundEngine.playUiClick();
        this.sim.emitChange();
      });
    }

    if (hit.kind === 'indicator_strip') {
      return stepDiscrete(`strip:${hit.id}:${shiftKey ? 's' : 'n'}`, deltaY, () => {
        soundEngine.playUiClick();
        if (shiftKey) {
          // Swap for fresh indicator strip
          hit.sampledPH = null;
          hit.tipColor = hit.stripKind === 'universal' ? '#eab308' : '#8b5cf6';
          hit.isBleached = false;
          hit.sampledFrom = '';
          this.sim.emitChange();
        } else {
          this.sim.flipItemLR(hit.id);
        }
      });
    }

    if (hit.kind === 'phen_cotton') {
      return stepDiscrete(`cotton-refresh:${hit.id}`, deltaY, () => {
        soundEngine.playUiClick();
        hit.pinkLevel = 0;
        hit.dampness = 0.85;
        if (hit.attachedToId) {
          const hv = this.sim.getItem(hit.attachedToId);
          if (hv) {
            if (hit.attachedSide === 'left') hv.phenCottonLeftLevel = 0;
            else if (hit.attachedSide === 'right') hv.phenCottonRightLevel = 0;
            else hv.phenCottonLevel = 0;
          }
        }
        this.sim.emitChange();
      });
    }

    if (hit.kind === 'rubber_stopper') {
      return stepDiscrete(`stopper-mode:${hit.id}`, deltaY, (dir) => {
        soundEngine.playUiClick();
        const order = ['holed', 'dual_hole', 'solid'];
        const curIdx = Math.max(0, order.indexOf(hit.stopperMode || 'holed'));
        const nextMode = order[(curIdx + (dir > 0 ? 1 : order.length - 1)) % order.length];
        this.sim.setStopperMode(hit.id, nextMode);
      });
    }

    if (hit.kind === 'burner') {
      if (hit.typeId === 'bunsen_burner' && shiftKey) {
        return stepDiscrete(`bunsen-air:${hit.id}`, deltaY, () => {
          soundEngine.playFlameWhoosh(!hit.airHoleOpen);
          this.sim.toggleBurnerAirHole(hit.id);
        });
      }
      const bSpec = APPARATUS[hit.typeId] || APPARATUS.burner;
      const airOpen = hit.typeId === 'bunsen_burner' ? hit.airHoleOpen !== false : true;
      const maxW = hit.typeId === 'bunsen_burner' && !airOpen ? (bSpec.yellowPowerLevelsW?.[3] || 820) : (bSpec.maxPowerW || 650);
      const nextW = clamp(0, maxW, Math.round((hit.powerW ?? 0) + (deltaY < 0 ? 40 : -40)));
      this.sim.setBurnerPower(hit.id, nextW);
      return true;
    }

    if (hit.kind === 'pipette') {
      if (shiftKey) {
        return stepDiscrete(`pip-dose:${hit.id}`, deltaY, (dir) => {
          const steps = [0.05, 0.25, 0.5, 1.0, 2.0, 5.0];
          let bestIdx = 0;
          let bestDiff = Infinity;
          steps.forEach((v, i) => {
            const d = Math.abs(v - (hit.dropDoseMl || 1.0));
            if (d < bestDiff) { bestDiff = d; bestIdx = i; }
          });
          const nextDose = steps[clamp(0, steps.length - 1, bestIdx + (dir < 0 ? 1 : -1))];
          soundEngine.playUiClick();
          this.sim.setPipetteDropDose(hit.id, nextDose);
        });
      }
      const now = performance.now();
      if (now - this._pipetteWheelTs < 150) return true;
      this._pipetteWheelTs = now;
      const doseMl = hit.dropDoseMl || 1.0;
      const spec = APPARATUS[hit.typeId] || APPARATUS.pipette_10;
      const tgt = this.findVesselAt(hit.x, hit.y + spec.height / 2 + 24, hit.id, true);
      const syrTgt = !tgt ? this.findSyringeAt(hit.x, hit.y + spec.height / 2 + 24) : null;
      const validPipContainer =
        tgt &&
        !tgt.isShattered &&
        !tgt.isBroken &&
        (tgt.kind === 'vessel' || tgt.kind === 'separatory_funnel' || tgt.kind === 'filter_funnel' || tgt.kind === 'burette') &&
        (tgt.kind === 'burette' ? true : !tgt.isStoppered);
      if (validPipContainer) {
        if (deltaY > 0) {
          if ((hit.volumeMl || 0) > 0.005) {
            soundEngine.playDropPlink(0.95);
            this.sim.pipetteDispenseToVessel(tgt.id, doseMl, hit);
          }
        } else {
          soundEngine.playDropPlink(0.85);
          this.sim.pipetteDrawFromVessel(tgt.id, doseMl, hit);
        }
      } else if (deltaY < 0 && syrTgt && !syrTgt.isBroken) {
        soundEngine.playDropPlink(0.85);
        this.sim.pipetteDrawFromSyringe(syrTgt.id, doseMl, hit);
      }
      return true;
    }

    if (hit.kind === 'gas_syringe') {
      if (shiftKey) {
        return stepDiscrete(`syr-flip:${hit.id}`, deltaY, () => {
          soundEngine.playUiClick();
          this.sim.flipItemLR(hit.id);
        });
      }
      if (deltaY > 0) {
        const arc = computeSyringeDischargeArc(hit, this.sim.items, BENCH_FLOOR_Y, CONSTANTS.GRAVITY_PX_S2 || 1800);
        if (arc?.hitTargetVessel) {
          this.sim.pumpSyringeToVessel(hit.id, arc.hitTargetVessel.id, 5.0);
        } else if (!hit.connectedFromId) {
          hit.autoDischargeTimer = 0.22;
          this.sim.setSyringeDischarge(hit.id, true, 'both');
        }
      } else {
        this.sim.setSyringeDischarge(hit.id, false);
        hit.autoDischargeTimer = 0;
        hit.wheelRetractMl = Math.min(100, (hit.wheelRetractMl || 0) + 5);
        this.sim.emitChange();
      }
      return true;
    }

    if (hit.kind === 'vessel' || hit.kind === 'filter_funnel' || hit.kind === 'separatory_funnel' || hit.kind === 'spoon') {
      if (hit.kind === 'separatory_funnel' && shiftKey) {
        return stepDiscrete(`sep-valve:${hit.id}`, deltaY, () => {
          soundEngine.playUiClick();
          this.sim.toggleSeparatoryValve(hit.id);
        });
      }
      const spec = APPARATUS[hit.typeId] || {};
      const isHeld = this.dragState?.itemId === hit.id;
      if (hit.kind === 'vessel' && spec.hasLid && shiftKey && !isHeld) {
        return stepDiscrete(`lid:${hit.id}`, deltaY, () => {
          soundEngine.playGlassClink(hit.typeId, 0.7);
          this.sim.cycleCrucibleLid(hit.id);
        });
      }
      if (hit.kind === 'vessel' && spec.isMortar && shiftKey && !isHeld) {
        return stepDiscrete(`mortar:${hit.id}`, deltaY, () => {
          soundEngine.playMortarGrind();
          this.sim.grindMortar(hit.id);
        });
      }
      // Forward scroll (deltaY > 0) -> tilt RIGHT (+), reverse scroll (deltaY < 0) -> tilt LEFT (-)
      const deltaDeg = (deltaY > 0 ? 1 : -1) * Math.min(14, Math.max(5, Math.abs(deltaY) * 0.09));
      const curSigned = (hit.tiltDir < 0 ? -1 : 1) * (hit.tiltDeg || 0);
      const nextSigned = clamp(-180, 180, curSigned + deltaDeg);
      const nextAbs = Math.abs(nextSigned);
      const nextDir = nextSigned < 0 ? -1 : 1;
      this.sim.setVesselTiltDeg(hit.id, nextAbs, nextDir);
      // Keep rotated horizontal quartz tubes cleanly above the bench floor
      if (spec.isHorizontalTube) {
        const maxQY = BENCH_FLOOR_Y - getItemRotatedHalfExtentY(spec, hit) + 2;
        if (hit.y > maxQY) hit.y = maxQY;
      }
      this._wheelTiltVesselId = nextAbs > 0 && !spec.isHorizontalTube ? hit.id : null;
      return true;
    }

    return false;
  }

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
  setExternalDropPreview(clientX, clientY, payloadType, payloadId) {
    if (!payloadType) {
      this._externalDragActive = false;
      this._canvasRect = null;
      this.dropTargetVesselId = null;
      return;
    }
    this._externalDragActive = true;
    const rect = this._getCanvasRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      this.dropTargetVesselId = null;
      return;
    }
    const pt = this.clientToLogical(clientX, clientY);
    if (payloadType === 'reagent') {
      const tgt = this.findVesselAt(pt.x, pt.y, null, true);
      this.dropTargetVesselId = tgt ? tgt.id : null;
    } else if (payloadId === 'pipette_10' || payloadId === 'stir_bar' || payloadId === 'boiling_chips' || payloadId === 'electrode_rod' || payloadId === 'filter_funnel' || payloadId === 'separatory_funnel') {
      const tgt = this.findVesselAt(pt.x, pt.y, null, false);
      const tSpec = tgt ? APPARATUS[tgt.typeId] : null;
      const valid = tgt && (payloadId !== 'electrode_rod' || !tSpec?.isHorizontalTube);
      this.dropTargetVesselId = valid ? tgt.id : null;
    } else if (payloadId === 'rubber_stopper') {
      const mTgt = this.findMouthTargetAt(pt.x, pt.y, 'stopper');
      this.dropTargetVesselId = mTgt ? mTgt.vessel.id : null;
    } else if (payloadId === 'phen_cotton') {
      const mTgt = this.findMouthTargetAt(pt.x, pt.y, 'cotton');
      this.dropTargetVesselId = mTgt ? mTgt.vessel.id : null;
    } else {
      this.dropTargetVesselId = null;
    }
  }

  /**
   * Unified drop handler called by BOTH native HTML5 Drag&Drop and pointer-drag fallback.
   */
  dropFromShelf(clientX, clientY, payloadType, payloadId) {
    const pt = this.clientToLogical(clientX, clientY);
    this._externalDragActive = false;
    this._canvasRect = null;
    if (payloadType === 'apparatus' && payloadId) {
      const spec = APPARATUS[payloadId];
      if (!spec) {
        this.dropTargetVesselId = null;
        return null;
      }
      const hoverVessel = this.findVesselAt(pt.x, pt.y, null, payloadId === 'pipette_10');
      const hoverSyr = payloadId === 'pipette_10' && !hoverVessel ? this.findSyringeAt(pt.x, pt.y) : null;
      const clampedX = Math.max(60, Math.min(BENCH_LOGICAL_W - 60, pt.x));
      const clampedY = Math.min(BENCH_FLOOR_Y - (spec.height || 80) / 2 + 2, Math.max(65, pt.y));
      this.sim.recordUndo?.();
      const created = this.sim.createApparatus(payloadId, clampedX, clampedY, { silentUndo: true });

      if (created) {
        if (created.kind === 'rubber_stopper') {
          const mTgt = this.findMouthTargetAt(pt.x, pt.y, 'stopper');
          if (mTgt) {
            this.sim.attachRubberStopper(created.id, mTgt.vessel.id, mTgt.side);
          } else {
            created.fallStartY = created.y;
          }
        } else if (created.kind === 'phen_cotton') {
          const mTgt = this.findMouthTargetAt(pt.x, pt.y, 'cotton');
          if (mTgt) {
            this.sim.attachPhenCotton(created.id, mTgt.vessel.id, mTgt.side);
          } else {
            created.fallStartY = created.y;
          }
        } else if (created.kind === 'stir_bar' && hoverVessel && !hoverVessel.isStoppered) {
          this.sim.insertStirBarIntoVessel(created.id, hoverVessel.id, 800);
        } else if (created.kind === 'boiling_chips' && hoverVessel && !hoverVessel.isStoppered) {
          this.sim.insertBoilingChipsIntoVessel(created.id, hoverVessel.id);
        } else if (created.kind === 'electrode' && hoverVessel) {
          const hvSpec = APPARATUS[hoverVessel.typeId];
          const side = clampedX >= hoverVessel.x ? 'right' : 'left';
          if (!hvSpec?.isHorizontalTube) {
            created.dockedVesselId = hoverVessel.id;
            created.dockSide = side;
            syncDockedToolPositions(this.sim);
          } else {
            created.fallStartY = created.y;
          }
        } else if (created.kind === 'filter_funnel' && hoverVessel && !hoverVessel.isStoppered) {
          created.mountedOnVesselId = hoverVessel.id;
          syncDockedToolPositions(this.sim);
        } else if (created.kind === 'separatory_funnel' && hoverVessel && !hoverVessel.isInverted) {
          this.sim.mountSeparatoryFunnel(created.id, hoverVessel.id);
        } else if (spec.supportsClamp) {
          const nearStand = this.findStandNear(created);
          const clampFloorLimit = BENCH_FLOOR_Y - (created.kind === 'burette' ? spec.height / 2 + 6 : (spec.height || 80) / 2 + 12);
          if (nearStand && created.y <= clampFloorLimit) {
            if (created.kind === 'burette' || created.kind === 'filter_funnel' || created.kind === 'separatory_funnel' || created.kind === 'condenser') {
              created.x = nearStand.x + 8;
            }
            this.sim.attachToStand(created.id, nearStand.id);
          } else {
            created.fallStartY = created.y;
          }
        } else {
          created.fallStartY = created.y;
        }
      }

      if (created && hoverVessel && payloadId === 'pipette_10' && !hoverVessel.isShattered && !hoverVessel.isBroken && (hoverVessel.kind === 'burette' || !hoverVessel.isStoppered) && hoverVessel.kind !== 'spoon') {
        const drew = this.sim.pipetteDrawFromVessel(hoverVessel.id, created.capacityMl || 10.0, created);
        if (drew > 0) {
          const hSpec = APPARATUS[hoverVessel.typeId];
          const parkRightX = hoverVessel.x + hSpec.width / 2 + 26;
          const parkLeftX = hoverVessel.x - hSpec.width / 2 - 26;
          created.x = parkRightX <= BENCH_LOGICAL_W - 45 ? parkRightX : Math.max(45, parkLeftX);
          created.y = BENCH_FLOOR_Y - spec.height / 2 + 2;
          created.fallStartY = null;
        }
      } else if (created && hoverSyr && payloadId === 'pipette_10' && !hoverSyr.isBroken) {
        const drew = this.sim.pipetteDrawFromSyringe(hoverSyr.id, created.capacityMl || 10.0, created);
        if (drew > 0) {
          const syrG = getSyringeGeometry(hoverSyr);
          created.x = Math.max(45, Math.min(BENCH_LOGICAL_W - 45, syrG.nozzleX - syrG.barrelDir * 24));
          created.y = BENCH_FLOOR_Y - spec.height / 2 + 2;
          created.fallStartY = null;
        }
      }
      if (created && this.callbacks.onSelect) this.callbacks.onSelect(created);
      this.sim.updateSupportAttachments();
      this.sim.emitChange();
      this.dropTargetVesselId = null;
      return created;
    }

    if (payloadType === 'reagent' && payloadId) {
      if (payloadId === 'nh3_25' || payloadId === 'hcl_37') {
        const diffTube = this.sim.items.find(
          (t) => t.kind === 'diffusion_tube' && !t.isBroken && Math.abs(pt.x - t.x) <= 145 && Math.abs(pt.y - t.y) <= 48
        );
        if (diffTube) {
          this.sim.dropDiffusionReagent(
            diffTube.id,
            pt.x < diffTube.x ? 'left' : 'right',
            payloadId === 'nh3_25' ? 'NH3_g' : 'HCl_g'
          );
          this.sim.selectedId = diffTube.id;
          this.dropTargetVesselId = null;
          return diffTube;
        }
      }
      let target = this.findVesselAt(pt.x, pt.y, null, true);
      if (!target) {
        // Snap gracefully to nearest open container within 105 px if dropped right next to it
        let bestD = 105;
        for (const it of this.sim.items) {
          if ((it.kind === 'vessel' || it.kind === 'filter_funnel' || it.kind === 'separatory_funnel' || it.kind === 'burette' || it.kind === 'spoon') && !it.isShattered && !it.isBroken) {
            const d = Math.hypot(it.x - pt.x, it.y - pt.y);
            if (d < bestD) {
              bestD = d;
              target = it;
            }
          }
        }
      }
      if (!target) {
        // Auto-place a 250 mL Beaker at drop spot if bench has no nearby/existing vessel so reagent drops always succeed
        const existing = this.sim.items.find((i) => i.kind === 'vessel' && !i.isShattered);
        target = existing || this.sim.createApparatus('beaker_250', Math.max(80, Math.min(BENCH_LOGICAL_W - 80, pt.x)), BENCH_FLOOR_Y - APPARATUS.beaker_250.height / 2 + 2);
      }
      if (target && this.callbacks.onRequestDosing) {
        this.sim.selectedId = target.id;
        this.callbacks.onRequestDosing(payloadId, target.id);
      }
      this.dropTargetVesselId = null;
      return target;
    }

    this.dropTargetVesselId = null;
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

  bindEvents() {
    this.ro = new ResizeObserver(() => this.resize());
    if (this.canvas.parentElement) this.ro.observe(this.canvas.parentElement);
    window.addEventListener('scroll', () => {
      this._canvasRect = null;
    }, { passive: true, capture: true });

    // Unified pointer events for Mouse + Touch + Pen
    this.canvas.addEventListener('pointerdown', (e) => {
      this._canvasRect = this.canvas.getBoundingClientRect();
      const pt = this.clientToLogical(e.clientX, e.clientY);

      if (this.pickState) {
        const picked = this.hitTestItem(pt.x, pt.y, null, (it) => this.pickState.candidateIds.has(it.id));
        if (picked) {
          const onPick = this.pickState.onPick;
          this.pickState = null;
          this.hoverItemId = null;
          this.canvas.style.cursor = 'default';
          this.callbacks.onPickStateChange?.(null);
          onPick?.(picked, pt);
        }
        return;
      }

      // 0A. Check Retort Stand top finial cap handle for telescopic rod extension
      const standTip = this.findStandTipAt(pt.x, pt.y);
      if (standTip) {
        this.sim.recordUndo?.();
        this.setSelection([standTip.id], standTip.id);
        this.standResizeState = {
          standId: standTip.id,
          startY: pt.y,
          startExtendPx: standTip.extendPx || 0,
        };
        this.canvas.style.cursor = 'ns-resize';
        this._trySetPointerCapture(e.pointerId);
        soundEngine.playClampClick();
        if (this.callbacks.onSelect) this.callbacks.onSelect(standTip);
        return;
      }

      // 0B. Check draggable submerged tubing tip handle inside upright receiving vessel
      const tubeTipHit = this.findTubeTipHandleAt(pt.x, pt.y);
      if (tubeTipHit) {
        this.setSelection([tubeTipHit.srcVessel.id], tubeTipHit.srcVessel.id);
        this.tubeTipDragState = {
          srcVesselId: tubeTipHit.srcVessel.id,
          dstVesselId: tubeTipHit.dstVessel.id,
        };
        this.canvas.style.cursor = 'ns-resize';
        this._trySetPointerCapture(e.pointerId);
        if (this.callbacks.onSelect) this.callbacks.onSelect(tubeTipHit.srcVessel);
        return;
      }

      // 0. Check direct tubing port handles on Liebig Condenser (Inlet Left / Outlet Right)
      const portHit = this.findCondenserPortAt(pt.x, pt.y);
      if (portHit) {
        this.setSelection([portHit.cond.id], portHit.cond.id);
        this.portDragState = {
          condId: portHit.cond.id,
          port: portHit.port,
          side: portHit.side || null,
          startX: portHit.origin.x,
          startY: portHit.origin.y,
          x: pt.x,
          y: pt.y,
          moved: false,
        };
        this._trySetPointerCapture(e.pointerId);
        if (this.callbacks.onSelect) this.callbacks.onSelect(portHit.cond);
        return;
      }

      const hit = this.hitTestItem(pt.x, pt.y);
      this.hoverItemId = hit ? hit.id : null;
      const isCtrl = Boolean(e.ctrlKey || e.metaKey);

      // In Magnifier Loupe mode at 1x, clicking zooms straight to 2.8x onto the inspected detail
      if (this.zoomMode && this.zoomScale <= 1.02) {
        if (hit) {
          this.setSelection([hit.id], hit.id);
          if (this.callbacks.onSelect) this.callbacks.onSelect(hit);
        }
        this.setZoomView(2.8, pt.x, pt.y);
        return;
      }

      if (isCtrl && !hit) {
        // Ctrl+Drag on empty canvas starts Marquee Multi-Select Rectangle
        this.marqueeState = {
          startX: pt.x,
          startY: pt.y,
          x: pt.x,
          y: pt.y,
          baseSet: new Set(this.getSelectedIdSet()),
        };
        this._trySetPointerCapture(e.pointerId);
        return;
      }

      if (hit) {
        const curSel = this.getSelectedIdSet();
        if (isCtrl) {
          if (curSel.has(hit.id)) {
            curSel.delete(hit.id);
            const rem = Array.from(curSel);
            this.setSelection(rem, rem[rem.length - 1] || null);
            if (this.callbacks.onSelect) this.callbacks.onSelect(this.sim.getItem(this.sim.selectedId));
            return;
          }
          curSel.add(hit.id);
          this.setSelection(curSel, hit.id);
        } else if (!curSel.has(hit.id) || curSel.size <= 1) {
          this.setSelection([hit.id], hit.id);
        } else {
          // Clicking inside existing multi-selection keeps group intact so drag moves all selected items together
          this.sim.selectedId = hit.id;
        }
        const activeGroupIds = Array.from(this.getSelectedIdSet());
        const activeIdSet = new Set(activeGroupIds);
        const groupMembers = activeGroupIds
          .map((gid) => this.sim.getItem(gid))
          .filter(Boolean)
          .map((g) => ({ item: g, startX: g.x, startY: g.y }));
        for (const member of groupMembers) {
          const g = member.item;
          g.isDragging = true;
          g.vy = 0;
          g.fallStartY = g.y;
          g.restingOnId = null;
          if (g.kind === 'spoon') {
            g.spoonAnim = null;
            g.tiltAngle = 0;
          }
          if (g.kind === 'electrode' && (!g.dockedVesselId || !activeIdSet.has(g.dockedVesselId))) {
            g.dockedVesselId = null;
          }
          if ((g.kind === 'filter_funnel' || g.kind === 'separatory_funnel') && g.id !== hit.id && (!g.mountedOnVesselId || !activeIdSet.has(g.mountedOnVesselId))) {
            g.mountedOnVesselId = null;
          }
        }
        const wasMountedId = (hit.kind === 'filter_funnel' || hit.kind === 'separatory_funnel') ? hit.mountedOnVesselId : null;
        if (hit.kind === 'filter_funnel' || hit.kind === 'separatory_funnel') hit.mountedOnVesselId = null;
        if (hit.kind === 'wash_bottle' && (hit.waterMl || 0) > 0.1) {
          hit.isSpraying = true;
        }
        const preDragSnap = this.sim.exportPositionSnapshot ? this.sim.exportPositionSnapshot() : null;
        // Bring dragged item to front visually unless it's a support base (scale/burner/stand)
        if (
          hit.kind === 'vessel' ||
          hit.kind === 'pipette' ||
          hit.kind === 'gas_syringe' ||
          hit.kind === 'filter_funnel' ||
          hit.kind === 'separatory_funnel' ||
          hit.kind === 'wash_bottle' ||
          hit.kind === 'burette' ||
          hit.kind === 'condenser' ||
          hit.kind === 'rubber_stopper' ||
          hit.kind === 'phen_cotton' ||
          hit.kind === 'splint' ||
          hit.kind === 'flame_loop' ||
          hit.kind === 'indicator_strip' ||
          hit.kind === 'spoon' ||
          hit.kind === 'stir_bar' ||
          hit.kind === 'electrode' ||
          hit.kind === 'thermometer'
        ) {
          this.sim.items = this.sim.items.filter((i) => i.id !== hit.id);
          this.sim.items.push(hit);
        }
        this.dragState = {
          itemId: hit.id,
          offsetX: pt.x - hit.x,
          offsetY: pt.y - hit.y,
          prevX: hit.x,
          prevY: hit.y,
          startX: hit.x,
          startY: hit.y,
          preDragSnap,
          undoRecorded: false,
          fullUndoRecorded: false,
          unmountHoldoffId: wasMountedId,
          pourTargetId: null,
          pipetteTargetId: null,
          clampStandId: hit.clampedToId || null,
          targetTilt: 0,
          pourAlignFactor: 1.0,
          pouredMl: 0,
          groupMembers,
        };
        if (hit.kind === 'wash_bottle' && hit.isSpraying) {
          this._upgradeDragToFullUndo();
        }
        this._trySetPointerCapture(e.pointerId);
        soundEngine.playGlassClink(hit.typeId, 0.55);
        if (this.callbacks.onSelect) this.callbacks.onSelect(hit);
      } else if (this.zoomScale > 1.02) {
        this.panDragState = {
          startClientX: e.clientX,
          startClientY: e.clientY,
          startCenterX: this.zoomCenterX,
          startCenterY: this.zoomCenterY,
        };
        this.canvas.style.cursor = 'grabbing';
        this._trySetPointerCapture(e.pointerId);
      } else {
        this.setSelection([], null);
        if (this.callbacks.onSelect) this.callbacks.onSelect(null);
      }
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const pt = this.clientToLogical(e.clientX, e.clientY);
      const hit = this.hitTestItem(pt.x, pt.y);
      if (hit && hit.kind === 'electrode') {
        const order = ['C', 'Cu', 'Zn'];
        const nextMat = order[(order.indexOf(hit.material) + 1) % order.length];
        soundEngine.playUiClick();
        this.sim.setElectrodeMaterial(hit.id, nextMat);
      } else if (hit && hit.kind === 'vessel' && APPARATUS[hit.typeId]?.hasLid) {
        soundEngine.playGlassClink(hit.typeId, 0.7);
        this.sim.cycleCrucibleLid(hit.id);
      } else if (hit && hit.kind === 'rubber_stopper') {
        soundEngine.playStopperPop(hit.stopperMode === 'solid');
        const order = ['holed', 'dual_hole', 'solid'];
        const nextMode = order[(order.indexOf(hit.stopperMode || 'holed') + 1) % order.length];
        this.sim.setStopperMode(hit.id, nextMode);
      } else if (hit && hit.typeId === 'bunsen_burner') {
        soundEngine.playFlameWhoosh(!hit.airHoleOpen);
        this.sim.toggleBurnerAirHole(hit.id);
      } else if (hit && hit.kind === 'vessel' && hit.hasStirBar) {
        soundEngine.playUiClick();
        this.sim.toggleMagneticStir(hit.id);
      } else if (hit && hit.kind === 'stir_bar' && hit.inVesselId) {
        soundEngine.playUiClick();
        this.sim.toggleMagneticStir(hit.inVesselId);
      } else if (!hit && this.zoomScale > 1.02) {
        this.resetZoom();
      }
    });

    this.canvas.addEventListener('pointerleave', () => {
      this.pointerLogical = null;
      this.hoveredTubeInfo = null;
      this.resetWheelTiltedVessel(null);
      if (!this.dragState && !this.portDragState && !this.panDragState) {
        this.hoverItemId = null;
        this._canvasRect = null;
      }
    });

    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.pickState) return;
      const pt = this.clientToLogical(e.clientX, e.clientY);
      this.pointerLogical = { x: pt.x, y: pt.y };
      const hitItem = this.hitTestItem(pt.x, pt.y);
      if (hitItem && !this.sim.selectedIds?.has(hitItem.id)) {
        this.setSelection(new Set([hitItem.id]), hitItem.id);
      }
      this.callbacks.onContextMenu?.(e.clientX, e.clientY, pt, hitItem);
    });

    const runPointerMove = (clientX, clientY) => {
      const pt = this.clientToLogical(clientX, clientY);
      this.pointerLogical = { x: pt.x, y: pt.y };
      if (this.panDragState) {
        const dxPx = clientX - this.panDragState.startClientX;
        const dyPx = clientY - this.panDragState.startClientY;
        const dxWorld = dxPx / (this.viewScale * this.zoomScale);
        const dyWorld = dyPx / (this.viewScale * this.zoomScale);
        this.setZoomView(
          this.zoomScale,
          this.panDragState.startCenterX - dxWorld,
          this.panDragState.startCenterY - dyWorld
        );
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      if (this.standResizeState) {
        const dy = this.standResizeState.startY - pt.y;
        const nextExt = Math.max(0, Math.min(200, Math.round(this.standResizeState.startExtendPx + dy)));
        this.sim.setStandExtension(this.standResizeState.standId, nextExt);
        this.canvas.style.cursor = 'ns-resize';
        return;
      }
      if (this.tubeTipDragState) {
        const dstV = this.sim.getItem(this.tubeTipDragState.dstVesselId);
        const dstSpec = dstV ? APPARATUS[dstV.typeId] : null;
        if (dstV && dstSpec) {
          if (dstV.isInverted) {
            const botMouthY = dstV.y + dstSpec.height / 2 - 2;
            const topDomeY = dstV.y - dstSpec.height / 2 + 10;
            const ratio = Math.max(0, Math.min(1, (botMouthY - pt.y) / Math.max(12, botMouthY - topDomeY)));
            this.sim.setTubeSubmersionRatio(this.tubeTipDragState.srcVesselId, ratio);
          } else {
            const topY = dstV.y - dstSpec.height / 2 + 6;
            const botY = dstV.y + dstSpec.height / 2 - 14;
            const ratio = Math.max(0, Math.min(1, (pt.y - topY) / Math.max(12, botY - topY)));
            this.sim.setTubeSubmersionRatio(this.tubeTipDragState.srcVesselId, ratio);
          }
        }
        this.canvas.style.cursor = 'ns-resize';
        return;
      }
      if (this.pickState) {
        const candHover = this.hitTestItem(pt.x, pt.y, null, (it) => this.pickState.candidateIds.has(it.id));
        this.hoverItemId = candHover ? candHover.id : null;
        this.canvas.style.cursor = candHover ? 'pointer' : 'crosshair';
        return;
      }
      if (this.portDragState) {
        this.portDragState.x = pt.x;
        this.portDragState.y = pt.y;
        if (Math.hypot(pt.x - this.portDragState.startX, pt.y - this.portDragState.startY) > 6) {
          this.portDragState.moved = true;
        }
        const pd = this.portDragState;
        const vTgt = this.findVesselAt(pt.x, pt.y, pd.condId, false);
        const syrTgt = this.findSyringeAt(pt.x, pt.y);
        if (pd.port === 'stopper') {
          this.dropTargetVesselId = syrTgt ? syrTgt.id : vTgt ? vTgt.id : null;
        } else if (pd.port === 'nozzle') {
          this.dropTargetVesselId = vTgt && APPARATUS[vTgt.typeId]?.stopperable ? vTgt.id : null;
        } else {
          this.dropTargetVesselId = vTgt ? vTgt.id : null;
        }
        this.canvas.style.cursor = 'crosshair';
        return;
      }

      if (this.marqueeState) {
        this.marqueeState.x = pt.x;
        this.marqueeState.y = pt.y;
        const minX = Math.min(this.marqueeState.startX, pt.x);
        const maxX = Math.max(this.marqueeState.startX, pt.x);
        const minY = Math.min(this.marqueeState.startY, pt.y);
        const maxY = Math.max(this.marqueeState.startY, pt.y);
        const picked = new Set(this.marqueeState.baseSet || []);
        for (const it of this.sim.items) {
          const sp = APPARATUS[it.typeId] || { width: 48, height: 48 };
          const hw = sp.width / 2;
          const hh = (it.renderHeight || sp.height) / 2;
          if (it.x + hw >= minX && it.x - hw <= maxX && it.y + hh >= minY && it.y - hh <= maxY) {
            picked.add(it.id);
          }
        }
        this.setSelection(picked);
        this.canvas.style.cursor = 'crosshair';
        return;
      }
      if (!this.dragState) {
        this.hoveredTubeInfo = this.findTubeHoverAt(pt.x, pt.y);
        const tubeTipHover = this.findTubeTipHandleAt(pt.x, pt.y);
        if (tubeTipHover) {
          this.hoverItemId = tubeTipHover.srcVessel.id;
          this.canvas.style.cursor = 'ns-resize';
          return;
        }
        const standTipHover = this.findStandTipAt(pt.x, pt.y);
        if (standTipHover) {
          this.hoverItemId = standTipHover.id;
          this.canvas.style.cursor = 'ns-resize';
          return;
        }
        const portHover = this.findCondenserPortAt(pt.x, pt.y);
        if (portHover) {
          this.hoverItemId = portHover.cond.id;
          this.canvas.style.cursor = this.zoomMode && this.zoomScale <= 1.02 ? 'zoom-in' : 'crosshair';
          return;
        }
        const hit = this.hitTestItem(pt.x, pt.y);
        this.hoverItemId = hit ? hit.id : null;
        if (!hit || hit.id !== this._wheelTiltVesselId) {
          this.resetWheelTiltedVessel(null);
        }
        if (this.zoomMode && this.zoomScale <= 1.02) {
          this.canvas.style.cursor = 'zoom-in';
        } else if (this.zoomScale > 1.02) {
          this.canvas.style.cursor = hit ? 'grab' : 'grab';
        } else {
          this.canvas.style.cursor = hit ? 'grab' : 'default';
        }
        return;
      }

      this.canvas.style.cursor = 'grabbing';
      const item = this.sim.getItem(this.dragState.itemId);
      if (!item) return;

      if (
        !this.dragState.undoRecorded &&
        this.dragState.preDragSnap &&
        Math.hypot(pt.x - this.dragState.offsetX - this.dragState.startX, pt.y - this.dragState.offsetY - this.dragState.startY) > 3
      ) {
        this.dragState.undoRecorded = true;
        this.sim.pushUndoSnapshot?.(this.dragState.preDragSnap);
      }

      // Once user actually drags a docked stir bar (>6 px), undock it cleanly so simple clicks still inspect without ejecting!
      if (
        (item.kind === 'stir_bar' || item.kind === 'boiling_chips') &&
        item.inVesselId &&
        Math.hypot(pt.x - this.dragState.offsetX - this.dragState.startX, pt.y - this.dragState.offsetY - this.dragState.startY) > 6
      ) {
        const prevV = this.sim.getItem(item.inVesselId);
        if (prevV) {
          if (item.kind === 'stir_bar') {
            prevV.hasStirBar = false;
            prevV.magStirRpm = 0;
          } else {
            prevV.hasBoilingChips = this.sim.items.some((i) => i.kind === 'boiling_chips' && i.id !== item.id && i.inVesselId === prevV.id);
          }
        }
        item.inVesselId = null;
      }

      const spec = APPARATUS[item.typeId];
      const minStandY = item.kind === 'stand' ? spec.height / 2 + 24 : 65;
      const halfExtY = getItemRotatedHalfExtentY(spec, item);
      const nextX = Math.max(60, Math.min(BENCH_LOGICAL_W - 60, pt.x - this.dragState.offsetX));
      const nextY = Math.max(minStandY, Math.min(BENCH_FLOOR_Y - halfExtY + 4, pt.y - this.dragState.offsetY));
      const dxMove = nextX - item.x;
      const dyMove = nextY - item.y;
      item.x = nextX;
      item.y = nextY;
      item.vy = 0;
      item.fallStartY = item.y;

      // Move all multi-selected peers along with dragged item when dragging a multi-selection
      if (this.dragState.groupMembers && this.dragState.groupMembers.length > 1) {
        const activeIdSet = new Set(this.dragState.groupMembers.map((m) => m.item?.id).filter(Boolean));
        for (const member of this.dragState.groupMembers) {
          const peer = member.item;
          if (!peer || peer.id === item.id) continue;
          peer.isDragging = true;
          peer.vy = 0;
          peer.restingOnId = null;
          if (peer.clampedToId && activeIdSet.has(peer.clampedToId)) {
            peer.fallStartY = null;
            continue;
          }
          if (peer.dockedVesselId && activeIdSet.has(peer.dockedVesselId)) {
            peer.fallStartY = null;
            continue;
          }
          if (peer.mountedOnVesselId && activeIdSet.has(peer.mountedOnVesselId)) {
            peer.fallStartY = null;
            continue;
          }
          if (peer.attachedToId && activeIdSet.has(peer.attachedToId)) {
            peer.fallStartY = null;
            continue;
          }
          const pSpec = APPARATUS[peer.typeId] || { height: 60 };
          const pHalfY = getItemRotatedHalfExtentY(pSpec, peer);
          peer.x = Math.max(40, Math.min(BENCH_LOGICAL_W - 40, peer.x + dxMove));
          peer.y = Math.max(45, Math.min(BENCH_FLOOR_Y - pHalfY + 4, peer.y + dyMove));
          peer.fallStartY = peer.y;
          if (peer.kind === 'stand') {
            for (const child of this.sim.items) {
              if (child.clampedToId !== peer.id || child.id === item.id) continue;
              const cSpec = APPARATUS[child.typeId];
              child.x = Math.max(50, Math.min(BENCH_LOGICAL_W - 50, child.x + dxMove));
              child.y = clampItemToStandY(cSpec, peer, BENCH_FLOOR_Y, child.y + dyMove, 4);
              child.vy = 0;
              child.fallStartY = null;
            }
          }
        }
      }

      // Detach Rubber Stopper or Phen Cotton when pulled away from its vessel mouth (>16px)
      if ((item.kind === 'rubber_stopper' || item.kind === 'phen_cotton') && item.attachedToId) {
        if (Math.hypot(nextX - this.dragState.startX, nextY - this.dragState.startY) > 16) {
          if (item.kind === 'rubber_stopper') this.sim.detachRubberStopper(item.id, { keepPos: true });
          else this.sim.detachPhenCotton(item.id);
        }
      }
      if (
        item.kind === 'vessel' &&
        item.mountedOverElectrodeId &&
        Math.hypot(nextX - this.dragState.startX, nextY - this.dragState.startY) > 12
      ) {
        item.mountedOverElectrodeId = null;
      }

      // Move clamped items rigidly along with stand when dragging a Retort Stand
      if (item.kind === 'stand') {
        for (const child of this.sim.items) {
          if (child.clampedToId !== item.id) continue;
          if (child.isShattered || child.isBroken) {
            child.clampedToId = null;
            child.fallStartY = child.y;
            continue;
          }
          const cSpec = APPARATUS[child.typeId];
          child.x = Math.max(50, Math.min(BENCH_LOGICAL_W - 50, child.x + dxMove));
          child.y = clampItemToStandY(cSpec, item, BENCH_FLOOR_Y, child.y + dyMove, 4);
          child.vy = 0;
          child.fallStartY = null;
        }
      }

      // Check Retort Stand clamp snap/release for clamp-capable apparatus (including burette, condenser, funnel)
      if (spec?.supportsClamp) {
        if (item.isShattered || item.isBroken) {
          this.dragState.clampStandId = null;
          item.clampedToId = null;
        } else {
          const stand = this.findStandNear(item);
          const clampFloorLimit = BENCH_FLOOR_Y - (item.kind === 'burette' ? spec.height / 2 + 6 : spec.height / 2 + 12);
          if (stand && item.y <= clampFloorLimit) {
            this.dragState.clampStandId = stand.id;
            item.clampedToId = stand.id;
            if (item.kind === 'burette' || item.kind === 'condenser' || item.kind === 'filter_funnel' || item.kind === 'separatory_funnel') {
              const snapX = getStandGeometry(stand).clampTargetX(item.kind);
              if (Math.abs(item.x - snapX) < 32) item.x = snapX;
            }
          } else {
            this.dragState.clampStandId = null;
            item.clampedToId = null;
          }
        }
      }

      // Live interactions while dragging Splint, Flame Loop, Indicator Strip, Wash Bottle, Stir Bar, Electrode, Filter Funnel
      if (item.kind === 'splint') {
        checkSplintInteractions(this.sim, item);
      } else if (item.kind === 'flame_loop') {
        checkFlameLoopInteractions(this.sim, item);
      } else if (item.kind === 'indicator_strip') {
        checkIndicatorStripInteractions(this.sim, item);
      } else if (item.kind === 'thermometer') {
        checkThermometerInteractions(this.sim, item, 0.08);
      } else if (item.kind === 'ph_conductometer' || item.kind === 'colorimeter' || item.kind === 'tlc_plate') {
        stepAnalyticalInstruments(this.sim, item, 0.08);
      } else if (item.kind === 'wash_bottle') {
        const arc = computeWashBottleStreamArc(item, this.sim.items, BENCH_FLOOR_Y, CONSTANTS.GRAVITY_PX_S2 || 1800);
        this.dropTargetVesselId = arc.hitTarget ? arc.hitTarget.id : null;
      } else if (item.kind === 'stir_bar' || item.kind === 'boiling_chips' || item.kind === 'electrode' || item.kind === 'filter_funnel') {
        const tgt = this.findVesselAt(item.x, item.y + 18, item.id, false);
        this.dropTargetVesselId = tgt && !tgt.isStoppered ? tgt.id : null;
      } else if (item.kind === 'separatory_funnel') {
        const tgt = this.findVesselAt(item.x, item.y + 82, item.id, false);
        this.dropTargetVesselId = tgt && !tgt.isInverted ? tgt.id : null;
      } else if (item.kind === 'rubber_stopper' && !item.attachedToId) {
        const mTgt = this.findMouthTargetAt(item.x, item.y, 'stopper');
        this.dropTargetVesselId = mTgt ? mTgt.vessel.id : null;
      } else if (item.kind === 'phen_cotton' && !item.attachedToId) {
        const mTgt = this.findMouthTargetAt(item.x, item.y, 'cotton');
        this.dropTargetVesselId = mTgt ? mTgt.vessel.id : null;
      } else if (item.kind === 'spoon') {
        const tip = getProbeTipPos(item);
        const tgt = this.findVesselAt(tip.x, tip.y + 10, null, false);
        const spoonMol = Object.values(item.moles || {}).reduce((s, n) => s + (n > 0 ? n : 0), 0);
        if (tgt && !tgt.isShattered && !tgt.isStoppered) {
          const tSpec = APPARATUS[tgt.typeId] || APPARATUS.beaker_250;
          const rimY = tgt.y - tSpec.height / 2;
          const tgtHasSolid = Object.entries(tgt.moles || {}).some(([k, n]) => SPECIES[k]?.phase === 's' && n > 1e-8);
          const tgtHasLiq = computeLiquidVolumeL(tgt.moles, tgt.tempK) > 1e-5;
          const isInGasJarBody = (tgt.headspaceGasMoles?.O2_g || 0) > 8e-5 && !tgtHasLiq && tip.y > rimY + 14;
          if (spoonMol > 1e-8 && !isInGasJarBody) {
            this.dragState.spoonAction = 'pour';
            this.dragState.spoonTargetId = tgt.id;
            this.dropTargetVesselId = tgt.id;
            if ((item.tiltDeg || 0) <= 0.1) item.tiltAngle = item.x >= tgt.x ? -0.35 : 0.35;
            item.hoveredActionLabel = this.langCode === 'vi' ? '🥄 Thả để đổ vào bình' : '🥄 Release to dump';
          } else if (spoonMol <= 1e-8 && tgtHasSolid) {
            this.dragState.spoonAction = 'scoop';
            this.dragState.spoonTargetId = tgt.id;
            this.dropTargetVesselId = tgt.id;
            if ((item.tiltDeg || 0) <= 0.1) item.tiltAngle = 0;
            item.hoveredActionLabel = this.langCode === 'vi' ? '🥄 Thả để múc chất rắn' : '🥄 Release to scoop';
          } else {
            this.dragState.spoonAction = null;
            this.dragState.spoonTargetId = null;
            this.dropTargetVesselId = null;
            if ((item.tiltDeg || 0) <= 0.1) item.tiltAngle = 0;
            item.hoveredActionLabel = null;
          }
        } else {
          this.dragState.spoonAction = null;
          this.dragState.spoonTargetId = null;
          this.dropTargetVesselId = null;
          if ((item.tiltDeg || 0) <= 0.1) item.tiltAngle = 0;
          item.hoveredActionLabel = null;
        }
      }

      // Disabled automatic proximity drag-pour: user aims vessel/funnel and scrolls wheel to tilt & pour cleanly
      if ((item.kind === 'vessel' || item.kind === 'filter_funnel') && !item.isStoppered && !item.isShattered) {
        this.dragState.pourTargetId = null;
        this.dragState.targetTilt = 0;
        if (item.kind !== 'filter_funnel') this.dropTargetVesselId = null;
      } else if (item.kind === 'pipette' && !item.isBroken) {
        const tgt = this.findVesselAt(item.x, item.y + spec.height * 0.28, item.id, true);
        const syrTgt = !tgt ? this.findSyringeAt(item.x, item.y + spec.height * 0.28) : null;
        const validPipTgt =
          tgt &&
          !tgt.isShattered &&
          !tgt.isBroken &&
          (tgt.kind === 'vessel' || tgt.kind === 'separatory_funnel' || tgt.kind === 'filter_funnel' || tgt.kind === 'burette') &&
          (tgt.kind === 'burette' ? true : !tgt.isStoppered);
        if (validPipTgt) {
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

      const rect = this._getCanvasRect();
      const isOutsideCanvas =
        clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
      if (isOutsideCanvas) {
        this._extHoverWasOutside = true;
        const dragItemsList = this.dragState?.groupMembers?.length > 1
          ? this.dragState.groupMembers.map((m) => m.item).filter(Boolean)
          : [item];
        this.callbacks.onExternalTabDragHover?.(clientX, clientY, item, dragItemsList);
      } else if (this._extHoverWasOutside) {
        this._extHoverWasOutside = false;
        this.callbacks.onExternalTabDragHover?.(0, 0, null, null);
      }
      this.sim.recomputeScaleReadings();
    };

    this.canvas.addEventListener('pointermove', (e) => {
      this._pendingPointerMove = { clientX: e.clientX, clientY: e.clientY };
      if (!this._moveRafId) {
        // Leading-edge execution once per frame, coalescing extra high-Hz moves to the next rAF
        const pm = this._pendingPointerMove;
        this._pendingPointerMove = null;
        runPointerMove(pm.clientX, pm.clientY);
        this._moveRafId = requestAnimationFrame(() => {
          this._moveRafId = 0;
          const queued = this._pendingPointerMove;
          this._pendingPointerMove = null;
          if (queued) runPointerMove(queued.clientX, queued.clientY);
        });
      }
    });

    const endDrag = (e) => {
      if (this._moveRafId) {
        cancelAnimationFrame(this._moveRafId);
        this._moveRafId = 0;
      }
      const queuedMove = this._pendingPointerMove;
      this._pendingPointerMove = null;
      if (
        queuedMove &&
        (this.dragState || this.marqueeState || this.panDragState || this.portDragState || this.standResizeState || this.tubeTipDragState)
      ) {
        runPointerMove(queuedMove.clientX, queuedMove.clientY);
      }
      this._canvasRect = null;
      if (this._extHoverWasOutside) {
        this._extHoverWasOutside = false;
        this.callbacks.onExternalTabDragHover?.(0, 0, null, null);
      }
      if (this.standResizeState) {
        this.standResizeState = null;
        this.canvas.style.cursor = 'default';
        if (e?.pointerId != null && this.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            this.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        this.sim.emitChange();
        return;
      }
      if (this.tubeTipDragState) {
        this.tubeTipDragState = null;
        this.canvas.style.cursor = 'default';
        if (e?.pointerId != null && this.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            this.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        this.sim.emitChange();
        return;
      }
      if (this.marqueeState) {
        this.marqueeState = null;
        this.canvas.style.cursor = 'default';
        if (e?.pointerId != null && this.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            this.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        this.callbacks.onSelect?.(this.sim.getItem(this.sim.selectedId));
        return;
      }
      if (this.panDragState) {
        this.panDragState = null;
        this.canvas.style.cursor = this.zoomScale > 1.02 ? 'grab' : this.zoomMode ? 'zoom-in' : 'default';
        if (e?.pointerId != null && this.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            this.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        return;
      }
      if (this.portDragState) {
        const pd = this.portDragState;
        this.portDragState = null;
        this.dropTargetVesselId = null;
        this.canvas.style.cursor = 'default';
        const src = this.sim.getItem(pd.condId);
        const vTgt = this.findVesselAt(pd.x, pd.y, pd.condId, false);
        const syrTgt = this.findSyringeAt(pd.x, pd.y);
        if (src) {
          if (src.kind === 'condenser') {
            if (vTgt && !vTgt.isShattered) {
              if (pd.port === 'inlet') {
                this.sim.connectTube(vTgt.id, src.id);
              } else if (pd.port === 'outlet') {
                this.sim.connectCondenserOutlet(src.id, vTgt.id);
              }
            } else if (!pd.moved) {
              if (pd.port === 'inlet' && src.connectedFromId) {
                this.sim.disconnectSyringe(src.connectedFromId);
              } else if (pd.port === 'outlet' && src.outletTargetId) {
                this.sim.connectCondenserOutlet(src.id, null);
              }
            }
          } else if (src.kind === 'gas_syringe' && !src.isBroken) {
            if (pd.moved && vTgt && !vTgt.isShattered && APPARATUS[vTgt.typeId]?.stopperable) {
              this.sim.connectTube(vTgt.id, src.id);
            } else if (!pd.moved && src.connectedFromId) {
              this.sim.disconnectSyringe(src.connectedFromId);
            }
          } else if (src.kind === 'vessel' && !src.isShattered) {
            const condTgt = this.sim.items.find(
              (c) => c.kind === 'condenser' && !c.isBroken && Math.hypot(pd.x - c.x, pd.y - c.y) <= 85
            );
            if (pd.moved) {
              const tSpec = vTgt ? APPARATUS[vTgt.typeId] : null;
              const tgtSide = tSpec?.hasTwoEnds && vTgt ? (pd.x < vTgt.x ? 'left' : 'right') : null;
              if (syrTgt && !syrTgt.isBroken) {
                this.sim.connectTube(src.id, syrTgt.id, { side: pd.side });
              } else if (condTgt) {
                this.sim.connectTube(src.id, condTgt.id, { side: pd.side });
              } else if (vTgt && !vTgt.isShattered && vTgt.id !== src.id) {
                this.sim.connectTube(src.id, vTgt.id, { side: pd.side, targetSide: tgtSide });
              }
            } else if (src.connectedTargetId || src.connectedSyringeId) {
              this.sim.disconnectSyringe(src.id);
            }
          }
        }
        if (e?.pointerId != null && this.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            this.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        this.sim.emitChange();
        return;
      }

      if (!this.dragState) return;
      let didStateChange = false;
      try {
        const item = this.sim.getItem(this.dragState.itemId);
        const pipTargetId = this.dragState.pipetteTargetId;
        const dragDist = item ? Math.hypot(item.x - this.dragState.startX, item.y - this.dragState.startY) : 0;
        didStateChange = Boolean(
          this.dragState.undoRecorded ||
          this.dragState.fullUndoRecorded ||
          (this.dragState.pouredMl || 0) > 0 ||
          dragDist > 1
        );
        const dropItemsList = this.dragState.groupMembers?.length > 1
          ? this.dragState.groupMembers.map((m) => m.item).filter(Boolean)
          : item ? [item] : [];
        if (item && this.callbacks.onDropToLabTab?.(e.clientX, e.clientY, item, dropItemsList)) {
          didStateChange = true;
          for (const member of this.dragState.groupMembers || []) {
            if (member.item) member.item.isDragging = false;
          }
          item.isDragging = false;
          if (item.tiltAngle !== undefined) item.tiltAngle = 0;
          return;
        }
        for (const member of this.dragState.groupMembers || []) {
          const mItem = member.item;
          if (!mItem || mItem.id === item?.id) continue;
          mItem.isDragging = false;
          mItem.vy = 0;
          mItem.fallStartY =
            mItem.clampedToId || mItem.dockedVesselId || mItem.inVesselId || mItem.mountedOnVesselId || mItem.attachedToId
              ? null
              : mItem.y;
        }
        if (item) {
          item.isDragging = false;
          if (item.kind === 'rubber_stopper' && !item.attachedToId) {
            const mTgt = this.findMouthTargetAt(item.x, item.y, 'stopper');
            if (mTgt) {
              this._upgradeDragToFullUndo();
              this.sim.attachRubberStopper(item.id, mTgt.vessel.id, mTgt.side);
              didStateChange = true;
            }
          } else if (item.kind === 'phen_cotton' && !item.attachedToId) {
            const mTgt = this.findMouthTargetAt(item.x, item.y, 'cotton');
            if (mTgt) {
              this._upgradeDragToFullUndo();
              this.sim.attachPhenCotton(item.id, mTgt.vessel.id, mTgt.side);
              didStateChange = true;
            }
          } else if (item.kind === 'stir_bar') {
            const tgt = this.findVesselAt(item.x, item.y + 10, null, false);
            if (tgt && !tgt.isStoppered) {
              this._upgradeDragToFullUndo();
              this.sim.insertStirBarIntoVessel(item.id, tgt.id, 800);
              didStateChange = true;
            }
          } else if (item.kind === 'boiling_chips') {
            const tgt = this.findVesselAt(item.x, item.y + 10, null, false);
            if (tgt && !tgt.isStoppered) {
              this._upgradeDragToFullUndo();
              this.sim.insertBoilingChipsIntoVessel(item.id, tgt.id);
              didStateChange = true;
            }
          } else if (item.kind === 'electrode') {
            const tgt = this.findVesselAt(item.x, item.y + 10, null, false);
            const tSpec = tgt ? APPARATUS[tgt.typeId] : null;
            const side = tgt && item.x >= tgt.x ? 'right' : 'left';
            if (tgt && !tSpec?.isHorizontalTube) {
              item.dockedVesselId = tgt.id;
              item.dockSide = side;
              syncDockedToolPositions(this.sim);
              didStateChange = true;
            }
          } else if (item.kind === 'filter_funnel' && !this.dragState.pourTargetId) {
            const dragMoved = Math.hypot(item.x - this.dragState.startX, item.y - this.dragState.startY);
            const tgt = this.findVesselAt(item.x, item.y + 38, null, false);
            if (tgt && !tgt.isStoppered && Math.abs(item.x - tgt.x) <= 28) {
              // Remount if clicked in place or dropped onto a rim deliberately
              if (dragMoved <= 6 || tgt.id !== this.dragState.unmountHoldoffId || Math.abs(item.y - (tgt.y - APPARATUS[tgt.typeId].height / 2)) <= 30) {
                item.mountedOnVesselId = tgt.id;
                syncDockedToolPositions(this.sim);
                if (this.dragState.unmountHoldoffId !== tgt.id) didStateChange = true;
              }
            }
          } else if (item.kind === 'separatory_funnel' && !this.dragState.pourTargetId) {
            const dragMoved = Math.hypot(item.x - this.dragState.startX, item.y - this.dragState.startY);
            const tgt = this.findVesselAt(item.x, item.y + 82, item.id, false);
            if (tgt && !tgt.isInverted && Math.abs(item.x - tgt.x) <= 30) {
              const mountY = tgt.y + getSepFunnelMountY(APPARATUS[tgt.typeId], APPARATUS.separatory_funnel);
              if (dragMoved <= 6 || tgt.id !== this.dragState.unmountHoldoffId || Math.abs(item.y - mountY) <= 56) {
                this.sim.mountSeparatoryFunnel(item.id, tgt.id);
                if (this.dragState.unmountHoldoffId !== tgt.id) didStateChange = true;
              }
            }
          }
          if (this.dragState.unmountHoldoffId && !item.mountedOnVesselId) {
            didStateChange = true;
          }
          item.fallStartY =
            item.clampedToId || item.dockedVesselId || item.inVesselId || item.mountedOnVesselId || item.attachedToId
              ? null
              : item.y;
          item.vy = 0;
          if (this.dragState.undoRecorded) {
            if (item.clampedToId) soundEngine.playClampClick();
            else if (item.attachedToId && item.kind === 'rubber_stopper') soundEngine.playStopperPop(false);
            else soundEngine.playGlassClink(item.typeId, 0.72);
          }
        }
        if (item && (item.kind === 'vessel' || item.kind === 'filter_funnel' || item.kind === 'separatory_funnel' || item.kind === 'pipette' || item.kind === 'spoon')) {
          if (!APPARATUS[item.typeId]?.isHorizontalTube) {
            item.tiltAngle = 0;
            item.tiltDeg = 0;
            item.tiltDir = 1;
          }
        }
        this.resetWheelTiltedVessel(null);
        if (item && item.kind === 'wash_bottle') {
          item.isSpraying = false;
          item.manualSprayHold = false;
          item.squirtTimer = 0;
        }
        if (item && item.kind === 'spoon') {
          item.hoveredActionLabel = null;
          const spAct = this.dragState.spoonAction;
          const spTgtId = this.dragState.spoonTargetId;
          if (spTgtId && spAct === 'pour') {
            this._upgradeDragToFullUndo();
            this.sim.spoonPourIntoVessel(item.id, spTgtId);
            didStateChange = true;
          } else if (spTgtId && spAct === 'scoop') {
            this._upgradeDragToFullUndo();
            this.sim.spoonScoopFromVessel(item.id, spTgtId);
            didStateChange = true;
          }
        }
        if (item && item.kind === 'pipette' && !item.isBroken) {
          item.hoveredActionLabel = null;
          if (pipTargetId) {
            const tgt = this.sim.getItem(pipTargetId);
            const isValidPip =
              tgt &&
              !tgt.isShattered &&
              !tgt.isBroken &&
              (tgt.kind === 'vessel' || tgt.kind === 'separatory_funnel' || tgt.kind === 'filter_funnel' || tgt.kind === 'burette') &&
              (tgt.kind === 'burette' ? true : !tgt.isStoppered);
            if (isValidPip) {
              this._upgradeDragToFullUndo();
              soundEngine.playDropPlink(0.95);
              if ((item.volumeMl || 0) <= 0.05) {
                this.sim.pipetteDrawFromVessel(tgt.id, item.capacityMl || 10.0, item);
              } else {
                this.sim.pipetteDispenseToVessel(tgt.id, item.dropDoseMl || 1.0, item);
              }
              didStateChange = true;
              const tSpec = APPARATUS[tgt.typeId];
              const pSpec = APPARATUS[item.typeId];
              const parkRightX = tgt.x + tSpec.width / 2 + 26;
              const parkLeftX = tgt.x - tSpec.width / 2 - 26;
              item.x = parkRightX <= BENCH_LOGICAL_W - 45 ? parkRightX : Math.max(45, parkLeftX);
              item.y = BENCH_FLOOR_Y - pSpec.height / 2 + 2;
              item.fallStartY = null;
            } else if (tgt && tgt.kind === 'gas_syringe' && !tgt.isBroken && (item.volumeMl || 0) <= 0.05) {
              this._upgradeDragToFullUndo();
              this.sim.pipetteDrawFromSyringe(tgt.id, item.capacityMl || 10.0, item);
              didStateChange = true;
              const pSpec = APPARATUS[item.typeId];
              const syrG = getSyringeGeometry(tgt);
              item.x = Math.max(45, Math.min(BENCH_LOGICAL_W - 45, syrG.nozzleX - syrG.barrelDir * 24));
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
        if (didStateChange) {
          this.sim.updateSupportAttachments();
          this.sim.emitChange();
        }
      }
    };

    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('lostpointercapture', endDrag);
    window.addEventListener('blur', endDrag);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.pickState) {
          this.cancelItemPick();
        } else if (this.zoomMode || this.zoomScale > 1.02) {
          this.toggleZoomMode(false);
        }
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        const pt = this.clientToLogical(e.clientX, e.clientY);
        if (e.ctrlKey && !e.metaKey) {
          const heldItem = this.dragState ? this.sim.getItem(this.dragState.itemId) : null;
          const hit = heldItem || this.hitTestItem(pt.x, pt.y);
          const hSpec = hit ? APPARATUS[hit.typeId] : null;
          if (hit && (hSpec?.invertible || hSpec?.flippable)) {
            e.preventDefault();
            if (this._wheelAccum.key !== `ctrl-flip:${hit.id}`) this._wheelAccum = { key: `ctrl-flip:${hit.id}`, sum: 0 };
            this._wheelAccum.sum += e.deltaY;
            if (Math.abs(this._wheelAccum.sum) >= 60) {
              this._wheelAccum.sum = 0;
              soundEngine.playUiClick();
              if (hSpec.invertible) {
                this.sim.toggleVesselInverted(hit.id);
              } else {
                this.sim.flipItemLR(hit.id);
              }
            }
            return;
          }
        }
        if (!this.zoomMode && this.zoomScale <= 1.01 && !e.ctrlKey && !e.metaKey) {
          if (this.handleCanvasWheel(pt, e.deltaY, Boolean(e.shiftKey))) {
            e.preventDefault();
          }
          return;
        }
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        const nextScale = Math.max(1.0, Math.min(4.2, this.zoomScale * factor));
        const rect = this.canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const baseX = (cx - this.viewOffsetX) / this.viewScale;
        const baseY = (cy - this.viewOffsetY) / this.viewScale;
        const nextCx = pt.x - (baseX - BENCH_LOGICAL_W * 0.5) / nextScale;
        const nextCy = pt.y - (baseY - BENCH_LOGICAL_H * 0.5) / nextScale;
        if (nextScale > 1.01 && !this.zoomMode) this.zoomMode = true;
        this.setZoomView(nextScale, nextCx, nextCy);
      },
      { passive: false }
    );

    // HTML5 Drag & Drop from Shelf onto Bench (always accept dropEffect copy; zero 'none' blocks)
    this.canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const pt = this.clientToLogical(e.clientX, e.clientY);
      const v = this.findVesselAt(pt.x, pt.y, null, true);
      this.dropTargetVesselId = v ? v.id : null;
    });

    this.canvas.addEventListener('dragleave', () => {
      this.dropTargetVesselId = null;
    });

    this.canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      const dt = e.dataTransfer;
      let reagentId = dt?.getData('text/reagent-id') || '';
      let apparatusId = dt?.getData('text/apparatus-id') || '';
      if (!reagentId && !apparatusId) {
        const plain = dt?.getData('text/plain') || '';
        if (plain.startsWith('reagent:')) reagentId = plain.slice(8);
        else if (plain.startsWith('apparatus:')) apparatusId = plain.slice(10);
      }
      if (apparatusId) {
        this.dropFromShelf(e.clientX, e.clientY, 'apparatus', apparatusId);
      } else if (reagentId) {
        this.dropFromShelf(e.clientX, e.clientY, 'reagent', reagentId);
      } else {
        this.dropTargetVesselId = null;
      }
    });
  }

  /**
   * Process smooth wrist-tilt ramp & flow-rate-calibrated interactive drag-pour between vessels.
   */
  tickInteractivePour(realDeltaSec) {
    if (!this.dragState) return;
    const src = this.sim.getItem(this.dragState.itemId);
    if (!src) return;

    // Smoothly track user's wheel tilt angle while holding tool/vessel (condenser uses rotationDeg independently)
    if (src.kind === 'vessel' || src.kind === 'filter_funnel' || src.kind === 'spoon') {
      const targetTilt =
        this.dragState.pourTargetId
          ? this.dragState.targetTilt || 0
          : (src.tiltDir < 0 ? -1 : 1) * (((src.tiltDeg || 0) * Math.PI) / 180);
      if (src.kind !== 'spoon' || (src.tiltDeg || 0) > 0.1 || !this.dragState.spoonAction) {
        src.tiltAngle = targetTilt;
      }
    }

    if (!this.dragState.pourTargetId) return;
    const dst = this.sim.getItem(this.dragState.pourTargetId);
    if (!dst) return;

    const absTilt = Math.abs(src.tiltAngle || 0);
    if (absTilt <= 0.10) return;

    const srcSpec = APPARATUS[src.typeId] || APPARATUS.beaker_250;
    const srcLiqMl = computeLiquidVolumeL(src.moles, src.tempK) * 1000;
    const hasDrySolids =
      srcSpec.isMortar &&
      srcLiqMl <= 0.05 &&
      Object.values(src.moles || {}).some((n) => n > 1e-8);
    if (srcLiqMl <= 0.02 && !hasDrySolids) return;
    if (hasDrySolids && dst.kind === 'vessel') {
      this._upgradeDragToFullUndo();
      this.sim.transferSolidsToVessel(src.id, dst.id, 1.0);
      this.dragState.pourTargetId = null;
      return;
    }

    // Steady realistic gravity flow calibrated to neck width, tilt progression & smooth low-volume tail
    const isNarrowNeck =
      srcSpec.shape === 'erlenmeyer' || srcSpec.shape === 'round_flask' || srcSpec.shape === 'test_tube' || srcSpec.shape === 'cylinder';
    const baseMaxRateMlS = isNarrowNeck ? 8.5 : 12.0;
    const tiltFrac = Math.pow(Math.min(1, (absTilt - 0.10) / 0.46), 1.35);
    const tailFactor = srcLiqMl < 5.0 ? Math.max(0.18, srcLiqMl / 5.0) : 1.0;
    const alignFactor = this.dragState.pourAlignFactor ?? 1.0;
    const flowRateMlS = baseMaxRateMlS * tiltFrac * tailFactor * alignFactor;

    // Physical hand-tilted decanting: settled dense solids remain behind unless previously stirred
    this._upgradeDragToFullUndo();
    const poured = this.sim.pourBetweenVessels(src.id, dst.id, flowRateMlS * realDeltaSec, false, { silentUndo: true });
    if (poured > 0) {
      this.dragState.pouredMl += poured;
      const srcLiqL = computeLiquidVolumeL(src.moles, src.tempK);
      const color = computeSolutionVisuals(
        src.moles,
        srcLiqL,
        computePH(src.moles, srcLiqL, src.tempK),
        srcSpec.opticalPathCm || 6.5,
        src.phenBleachFrac,
        src.phenIrrevFrac || 0
      ).css;
      const dstSpec = APPARATUS[dst.typeId] || APPARATUS.beaker_250;
      const tiltDir = (src.tiltAngle || 0) < 0 ? -1 : 1;
      const lipSpan = Math.min(28, (srcSpec.neckRadius || srcSpec.width * 0.35) * 0.85);
      this.sim.activePourStream = {
        fromX: src.x + tiltDir * lipSpan,
        fromY: src.y - srcSpec.height * 0.34,
        toX: dst.x,
        toY: dst.y - dstSpec.height * 0.25,
        color,
        rateMlS: flowRateMlS,
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
        : this.themeName === 'sos'
        ? 'rgba(91, 181, 201, 0.14)'
        : this.themeName === 'petal'
        ? 'rgba(242, 242, 245, 0.06)'
        : this.isDark
        ? 'rgba(148, 163, 184, 0.08)'
        : 'rgba(15, 23, 42, 0.06)';
    bCtx.fillStyle = bgGrid;
    for (let gx = 40; gx < BENCH_LOGICAL_W; gx += 40) {
      for (let gy = 40; gy < BENCH_FLOOR_Y; gy += 40) {
        bCtx.fillRect(gx - 1, gy - 1, 2, 2);
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

    bCtx.strokeStyle =
      this.themeName === 'olivia'
        ? '#221F20'
        : this.themeName === 'ctrl'
        ? '#4F6358'
        : this.themeName === 'sos'
        ? '#5BB5C9'
        : this.themeName === 'petal'
        ? '#33333A'
        : this.isDark
        ? '#334155'
        : '#64748b';
    bCtx.lineWidth = this.themeName === 'olivia' || this.themeName === 'ctrl' ? 1.6 : 2;
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
        renderIceBath(ctx, item, isSelected, this.isDark, timeNow, this.langCode);
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
        const compText = flow?.composition?.length
          ? flow.composition.map((c) => `${c.formula} ${c.pct}%`).join(', ')
          : this.langCode === 'en'
          ? 'No active flow'
          : 'Chưa có dòng khí';
        const rateTxt = `${(flow?.rateMlS || 0).toFixed(2)} mL/s · ${(flow?.tempC ?? 25).toFixed(1)}°C`;
        const line1 = formatCanvasText(`${ht.srcVessel.label} → ${ht.dstVessel.label}: ${compText}`);
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

    const drawFlowStreamline = (pts, color, width = 1.4, dashOffset = 0, label = '', arrowSize = 4.0) => {
      if (pts.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = dashOffset;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) * 0.5;
        const my = (pts[i].y + pts[i + 1].y) * 0.5;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const ang = Math.atan2(last.y - prev.y, last.x - prev.x);
      drawArrowHead(last.x, last.y, ang, color, arrowSize);
      if (label) {
        const mid = pts[Math.floor(pts.length * 0.5)];
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
        C2H4_g: { rgba: 'rgba(56, 189, 248, 0.26)', core: 'rgba(186, 230, 253, 0.62)', stroke: '#38bdf8', formula: 'C₂H₄ (M=28 ↓)' },
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

      let hasActiveFlow = false;
      for (const v of this.sim.items) {
        if (v.kind !== 'vessel' || v.isShattered) continue;
        const spec = APPARATUS[v.typeId] || APPARATUS.beaker_250;
        const entries = Object.entries({ ...(v.headspaceGasMoles || {}), ...(v.lastGasRateMap || {}) })
          .map(([g]) => [g, (v.headspaceGasMoles?.[g] || 0) + (v.lastGasRateMap?.[g] || 0) * 0.45])
          .filter(([g, val]) => g !== 'H2O_g' && val > 1e-6);
        if (entries.length === 0) continue;
        hasActiveFlow = true;
        entries.sort((a, b) => b[1] - a[1]);
        const [domGas] = entries[0];
        const pal = getGasPal(domGas);
        const molarMass = SPECIES[domGas]?.molarMass || 30;
        const isHeavy = molarMass >= 29;
        const dirSign = v.tiltDir < 0 ? -1 : 1;
        const effRad = (v.tiltAngle || 0) + (v.landingTilt || 0);
        const rimX = v.x - Math.sin(effRad) * (-spec.height * 0.44);
        const rimY = v.y + Math.cos(effRad) * (-spec.height * 0.44);
        const scrollPhase = -(timeNow * 40);
        const hasOutTube = Boolean(v.connectedTargetId || v.connectedSyringeId || v.connectedFromId);
        const isSealedStopper = Boolean(v.isStoppered && (v.stopperMode === 'solid' || hasOutTube));
        const isOneHoleVent = Boolean(v.isStoppered && v.stopperMode !== 'solid' && !hasOutTube);

        if (isHeavy && (v.tiltDeg || 0) >= 12 && !v.isStoppered) {
          const spreadG = ctx.createLinearGradient(rimX, rimY, rimX + dirSign * 44, BENCH_FLOOR_Y);
          spreadG.addColorStop(0, pal.core);
          spreadG.addColorStop(0.65, pal.rgba);
          spreadG.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = spreadG;
          ctx.beginPath();
          ctx.moveTo(rimX - 10, rimY);
          ctx.lineTo(rimX + 12, rimY);
          ctx.bezierCurveTo(rimX + dirSign * 44, rimY + 38, rimX + dirSign * 78, BENCH_FLOOR_Y - 22, rimX + dirSign * 140, BENCH_FLOOR_Y);
          ctx.lineTo(rimX - dirSign * 70, BENCH_FLOOR_Y);
          ctx.bezierCurveTo(rimX - dirSign * 18, BENCH_FLOOR_Y - 16, rimX - 14, rimY + 35, rimX - 10, rimY);
          ctx.closePath();
          ctx.fill();

          for (let s = -3; s <= 3; s++) {
            const u = s / 3;
            const sway = Math.sin(timeNow * 2.2 + s * 0.9) * 3.5;
            const pts = [
              { x: rimX + s * 2.2, y: rimY + 2 },
              { x: rimX + dirSign * (14 + u * 8) + sway * 0.4, y: rimY + 30 },
              { x: rimX + dirSign * (32 + u * 26) + sway, y: Math.min(BENCH_FLOOR_Y - 16, (rimY + BENCH_FLOOR_Y) * 0.56) },
              { x: rimX + dirSign * (46 + u * 58), y: BENCH_FLOOR_Y - 10 - Math.abs(s) * 2 },
            ];
            drawFlowStreamline(pts, pal.stroke, s === 0 ? 1.6 : 1.2, scrollPhase + s * 6, s === 0 ? pal.formula : '', 3.8);
          }
        } else if (isHeavy) {
          // Rigid-wall gas containment + dense internal streamlines inside gradient plume & rim spillover jets
          const topMouthY = v.y - spec.height * 0.45;
          const mouthSpan = Math.max(10, spec.neckRadius || spec.width * 0.34);
          ctx.save();
          ctx.beginPath();
          ctx.rect(v.x - spec.width * 0.44, topMouthY, spec.width * 0.88, spec.height * 0.88);
          ctx.clip();
          const plumeY = v.y + spec.height * 0.12;
          const pg = ctx.createRadialGradient(v.x, plumeY, 4, v.x, plumeY, spec.width * 0.42);
          pg.addColorStop(0, pal.core);
          pg.addColorStop(0.65, pal.rgba);
          pg.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = pg;
          ctx.beginPath();
          ctx.ellipse(v.x, plumeY, spec.width * 0.38, spec.height * 0.36, 0, 0, Math.PI * 2);
          ctx.fill();
          for (let k = -2; k <= 2; k++) {
            const xOff = k * (spec.width * 0.12);
            const sw = Math.sin(timeNow * 2.4 + k) * 3;
            drawFlowStreamline(
              [
                { x: v.x + xOff * 0.55, y: topMouthY + spec.height * 0.14 },
                { x: v.x + xOff + sw, y: plumeY },
                { x: v.x + xOff * 1.15, y: v.y + spec.height * 0.36 },
              ],
              pal.stroke,
              1.15,
              scrollPhase + k * 5,
              '',
              3.4
            );
          }
          ctx.restore();

          if (!v.isStoppered && !v.isInverted) {
            const spillFloorY = Math.min(BENCH_FLOOR_Y - 8, v.y + spec.height * 0.42);
            for (const side of [-1, 1]) {
              const sideG = ctx.createLinearGradient(v.x + side * mouthSpan * 0.4, topMouthY, v.x + side * (spec.width * 0.65), spillFloorY);
              sideG.addColorStop(0, pal.core);
              sideG.addColorStop(0.7, pal.rgba);
              sideG.addColorStop(1, 'rgba(0,0,0,0)');
              ctx.fillStyle = sideG;
              ctx.beginPath();
              ctx.moveTo(v.x + side * (mouthSpan * 0.15), topMouthY + 4);
              ctx.quadraticCurveTo(v.x + side * (mouthSpan + 18), topMouthY - 10, v.x + side * (spec.width * 0.64 + 14), spillFloorY);
              ctx.lineTo(v.x + side * (spec.width * 0.46), spillFloorY);
              ctx.quadraticCurveTo(v.x + side * (mouthSpan + 6), topMouthY + 4, v.x + side * (mouthSpan * 0.05), topMouthY + 10);
              ctx.closePath();
              ctx.fill();

              for (let f = 0; f < 3; f++) {
                const frac = (f - 1) * 4.5;
                const wv = Math.sin(timeNow * 2.3 + side + f) * 2.8;
                drawFlowStreamline(
                  [
                    { x: v.x + side * (mouthSpan * (0.28 + f * 0.14)), y: topMouthY + 8 },
                    { x: v.x + side * (mouthSpan + 7 + f * 4.5), y: topMouthY - 6 + wv },
                    { x: v.x + side * (spec.width * 0.56 + 6 + frac), y: spillFloorY - 4 },
                  ],
                  pal.stroke,
                  1.25,
                  scrollPhase + f * 6,
                  side === 1 && f === 1 ? pal.formula : '',
                  3.7
                );
              }
            }
          } else {
            drawFlowStreamline(
              [
                { x: v.x, y: v.y - spec.height * 0.25 },
                { x: v.x, y: v.y + spec.height * 0.22 },
              ],
              pal.stroke,
              1.6,
              scrollPhase,
              pal.formula,
              4.0
            );
          }
        } else if (isSealedStopper) {
          // Sealed or tubed stoppered flask: trap gas circulation strictly INSIDE flask glass bounds
          const topMouthY = v.y - spec.height * 0.42;
          const domeY = v.y - spec.height * 0.14;
          ctx.save();
          ctx.beginPath();
          ctx.rect(v.x - spec.width * 0.42, topMouthY + 6, spec.width * 0.84, spec.height * 0.82);
          ctx.clip();
          const inG = ctx.createRadialGradient(v.x, domeY, 4, v.x, domeY, spec.width * 0.40);
          inG.addColorStop(0, pal.core);
          inG.addColorStop(0.65, pal.rgba);
          inG.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = inG;
          ctx.beginPath();
          ctx.ellipse(v.x, domeY, spec.width * 0.34, spec.height * 0.28, 0, 0, Math.PI * 2);
          ctx.fill();
          for (let k = -1; k <= 1; k++) {
            const xOff = k * (spec.width * 0.11);
            const sw = Math.sin(timeNow * 2.6 + k) * 3;
            drawFlowStreamline(
              [
                { x: v.x + xOff, y: v.y + spec.height * 0.14 },
                { x: v.x + xOff * 0.7 + sw, y: domeY },
                { x: v.x + xOff * 0.35, y: topMouthY + 14 },
              ],
              pal.stroke,
              k === 0 ? 1.4 : 1.05,
              scrollPhase + k * 5,
              k === 0 ? pal.formula : '',
              3.2
            );
          }
          ctx.restore();
        } else {
          // Open mouth (or minor trickle from unplugged 1-hole stopper)
          const ventScale = isOneHoleVent ? 0.28 : 1.0;
          const basePlumeX = rimX;
          const basePlumeY = rimY;
          const domeRadius = Math.max(20, spec.width * 0.58 * ventScale);
          const domeH = 82 * ventScale;
          const domeG = ctx.createRadialGradient(basePlumeX, basePlumeY - 38 * ventScale, 6, basePlumeX, basePlumeY - 48 * ventScale, 102 * ventScale);
          domeG.addColorStop(0, pal.core);
          domeG.addColorStop(0.58, pal.rgba);
          domeG.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = domeG;
          ctx.beginPath();
          ctx.ellipse(basePlumeX, basePlumeY - 42 * ventScale, domeRadius, domeH, 0, 0, Math.PI * 2);
          ctx.fill();

          const sLim = isOneHoleVent ? 0 : 2;
          for (let s = -sLim; s <= sLim; s++) {
            const u = sLim === 0 ? 0 : s / sLim;
            const sw = Math.sin(timeNow * 2.8 + s * 1.1) * 5 * ventScale;
            const pts = [
              { x: basePlumeX + u * Math.min(12, spec.neckRadius || 12), y: basePlumeY + 12 },
              { x: basePlumeX + u * (domeRadius * 0.42) + sw * 0.5, y: basePlumeY - 18 * ventScale },
              { x: basePlumeX + u * (domeRadius * 0.65) - sw * 0.4, y: Math.max(24, basePlumeY - 62 * ventScale) },
              { x: basePlumeX + u * (domeRadius * 0.78), y: Math.max(16, basePlumeY - 102 * ventScale + Math.abs(s) * 4) },
            ];
            drawFlowStreamline(pts, pal.stroke, s === 0 ? 1.65 : 1.25, scrollPhase + s * 6, s === 0 ? pal.formula : '', 3.8);
          }
        }
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
          const bC = it.bathMode === 'ice_salt' ? -10 : 0;
          obsMinC = Math.min(obsMinC, bC);
          splatHeat(it.x, it.y, 92, 52, bC, 0.94);
          splatHeat(it.x, BENCH_FLOOR_Y + 6, 125, 22, (bC + ambC) * 0.5, 0.55);
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
      const spanLow = -15;
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
