import {
  APPARATUS,
  clampItemToStandY,
  getCondenserPorts,
  getProbeTipPos,
  getStandGeometry,
  getSyringeGeometry,
  getVesselEndPorts,
  getVesselTubingPort,
} from '../data/apparatus.js';
import { CONSTANTS } from '../data/constants.js';
import { SPECIES } from '../data/species.js';
import { computeLiquidVolumeL, computePH, computeSolutionVisuals } from '../engine/equilibrium.js';
import { computeSyringeDischargeArc, computeSyringeLiquidVolumeMl } from '../engine/gasNetwork.js';
import {
  checkFlameLoopInteractions,
  checkIndicatorStripInteractions,
  checkSplintInteractions,
  computeWashBottleStreamArc,
  syncDockedToolPositions,
} from '../engine/apparatusTools.js';
import { renderActiveReagentTransfer } from './reagentRenderer.js';
import {
  beginCanvasLabelFrame,
  flushCanvasLabelFrame,
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
  renderCrucibleTongs,
  renderDcPowerAndWires,
  renderDiffusionTube,
  renderElectrodeCollectorTubes,
  renderElectrodeRod,
  renderFilterFunnel,
  renderFlameLoop,
  renderIndicatorStrip,
  renderIronSpoon,
  renderLiebigCondenser,
  renderPhenCotton,
  renderRubberStopper,
  renderSaltBridge,
  renderSplint,
  renderStirBar,
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
    this.langCode = 'vi';
    this.dragState = null; // { itemId, offsetX, offsetY, startX, startY, pourTargetId, pouredMl }
    this.portDragState = null;
    this.marqueeState = null;
    this.pickState = null; // { candidateIds: Set<string>, promptText, onPick, onCancel }
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

  setTheme(isDark) {
    this.isDark = isDark;
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

  clientToLogical(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
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
      it.kind === 'stir_bar' ||
      it.kind === 'salt_bridge' ||
      it.kind === 'pipette' ||
      it.kind === 'splint' ||
      it.kind === 'flame_loop' ||
      it.kind === 'indicator_strip' ||
      it.kind === 'tongs' ||
      it.kind === 'spoon' ||
      it.kind === 'burette' ||
      it.kind === 'condenser' ||
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
      const hw = spec.width / 2 + padX;
      const hh = (it.renderHeight || spec.height) / 2 + 10;
      return lx >= it.x - hw && lx <= it.x + hw && ly >= it.y - hh && ly <= it.y + hh;
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

  findVesselAt(lx, ly, excludeId = null, includeTools = false) {
    if (includeTools) {
      for (let i = this.sim.items.length - 1; i >= 0; i--) {
        const it = this.sim.items[i];
        if (it.id === excludeId || it.isShattered || it.isBroken) continue;
        if (it.kind !== 'filter_funnel' && it.kind !== 'burette' && it.kind !== 'spoon') continue;
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
      this.dropTargetVesselId = null;
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      this.dropTargetVesselId = null;
      return;
    }
    const pt = this.clientToLogical(clientX, clientY);
    if (payloadType === 'reagent') {
      const tgt = this.findVesselAt(pt.x, pt.y, null, true);
      this.dropTargetVesselId = tgt ? tgt.id : null;
    } else if (payloadId === 'pipette_10' || payloadId === 'stir_bar' || payloadId === 'electrode_rod' || payloadId === 'filter_funnel') {
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
    if (payloadType === 'apparatus' && payloadId) {
      const spec = APPARATUS[payloadId];
      if (!spec) {
        this.dropTargetVesselId = null;
        return null;
      }
      const hoverVessel = this.findVesselAt(pt.x, pt.y, null, false);
      const hoverSyr = payloadId === 'pipette_10' && !hoverVessel ? this.findSyringeAt(pt.x, pt.y) : null;
      const clampedX = Math.max(60, Math.min(BENCH_LOGICAL_W - 60, pt.x));
      const clampedY = Math.min(BENCH_FLOOR_Y - (spec.height || 80) / 2 + 2, Math.max(65, pt.y));
      const created = this.sim.createApparatus(payloadId, clampedX, clampedY);

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
        } else if (created.kind === 'electrode' && hoverVessel) {
          const hvSpec = APPARATUS[hoverVessel.typeId];
          const side = clampedX >= hoverVessel.x ? 'right' : 'left';
          const sideBlocked = hvSpec?.hasTwoEnds
            ? side === 'left'
              ? hoverVessel.leftStoppered
              : hoverVessel.rightStoppered
            : hoverVessel.isStoppered;
          if (!hvSpec?.isHorizontalTube && !sideBlocked) {
            created.dockedVesselId = hoverVessel.id;
            created.dockSide = side;
            syncDockedToolPositions(this.sim);
          } else {
            created.fallStartY = created.y;
          }
        } else if (created.kind === 'filter_funnel' && hoverVessel && !hoverVessel.isStoppered) {
          created.mountedOnVesselId = hoverVessel.id;
          syncDockedToolPositions(this.sim);
        } else if (spec.supportsClamp) {
          const nearStand = this.findStandNear(created);
          const clampFloorLimit = BENCH_FLOOR_Y - (created.kind === 'burette' ? spec.height / 2 + 6 : (spec.height || 80) / 2 + 12);
          if (nearStand && created.y <= clampFloorLimit) {
            if (created.kind === 'burette' || created.kind === 'filter_funnel' || created.kind === 'condenser') {
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

      if (created && hoverVessel && payloadId === 'pipette_10' && !hoverVessel.isShattered && !hoverVessel.isStoppered) {
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
          if ((it.kind === 'vessel' || it.kind === 'filter_funnel' || it.kind === 'burette' || it.kind === 'spoon') && !it.isShattered && !it.isBroken) {
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
      const standTop = stand.y - sSpec.height / 2;
      const targetX = getStandGeometry(stand).clampTargetX(item.kind);
      const distX = Math.abs(item.x - targetX);
      const maxPullDist = item.kind === 'gas_syringe' ? 88 : item.kind === 'burette' || item.kind === 'condenser' ? 68 : 58;
      if (distX <= maxPullDist && item.y >= standTop + 8 && item.y <= BENCH_FLOOR_Y - 10) {
        return stand;
      }
    }
    return null;
  }

  bindEvents() {
    this.ro = new ResizeObserver(() => this.resize());
    if (this.canvas.parentElement) this.ro.observe(this.canvas.parentElement);

    // Unified pointer events for Mouse + Touch + Pen
    this.canvas.addEventListener('pointerdown', (e) => {
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
        this.canvas.setPointerCapture(e.pointerId);
        if (this.callbacks.onSelect) this.callbacks.onSelect(portHit.cond);
        this.sim.emitChange();
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
          this.sim.emitChange();
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
        this.canvas.setPointerCapture(e.pointerId);
        this.sim.emitChange();
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
            this.sim.emitChange();
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
          if (g.kind === 'filter_funnel' && g.id !== hit.id && (!g.mountedOnVesselId || !activeIdSet.has(g.mountedOnVesselId))) {
            g.mountedOnVesselId = null;
          }
        }
        const wasMountedId = hit.kind === 'filter_funnel' ? hit.mountedOnVesselId : null;
        if (hit.kind === 'filter_funnel') hit.mountedOnVesselId = null;
        if (hit.kind === 'wash_bottle' && (hit.waterMl || 0) > 0.1) {
          hit.isSpraying = true;
        }
        // Bring dragged item to front visually unless it's a support base (scale/burner/stand)
        if (
          hit.kind === 'vessel' ||
          hit.kind === 'pipette' ||
          hit.kind === 'gas_syringe' ||
          hit.kind === 'filter_funnel' ||
          hit.kind === 'wash_bottle' ||
          hit.kind === 'burette' ||
          hit.kind === 'condenser' ||
          hit.kind === 'rubber_stopper' ||
          hit.kind === 'phen_cotton' ||
          hit.kind === 'splint' ||
          hit.kind === 'flame_loop' ||
          hit.kind === 'indicator_strip' ||
          hit.kind === 'tongs' ||
          hit.kind === 'spoon' ||
          hit.kind === 'stir_bar' ||
          hit.kind === 'electrode'
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
          unmountHoldoffId: wasMountedId,
          pourTargetId: null,
          pipetteTargetId: null,
          clampStandId: hit.clampedToId || null,
          targetTilt: 0,
          pourAlignFactor: 1.0,
          pouredMl: 0,
          groupMembers,
        };
        this.canvas.setPointerCapture(e.pointerId);
        if (this.callbacks.onSelect) this.callbacks.onSelect(hit);
        this.sim.emitChange();
      } else if (this.zoomScale > 1.02) {
        this.panDragState = {
          startClientX: e.clientX,
          startClientY: e.clientY,
          startCenterX: this.zoomCenterX,
          startCenterY: this.zoomCenterY,
        };
        this.canvas.style.cursor = 'grabbing';
        this.canvas.setPointerCapture(e.pointerId);
      } else {
        this.setSelection([], null);
        if (this.callbacks.onSelect) this.callbacks.onSelect(null);
        this.sim.emitChange();
      }
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const pt = this.clientToLogical(e.clientX, e.clientY);
      const hit = this.hitTestItem(pt.x, pt.y);
      if (hit && hit.kind === 'electrode') {
        const order = ['C', 'Cu', 'Zn'];
        const nextMat = order[(order.indexOf(hit.material) + 1) % order.length];
        this.sim.setElectrodeMaterial(hit.id, nextMat);
      } else if (hit && hit.kind === 'vessel' && APPARATUS[hit.typeId]?.hasLid) {
        this.sim.cycleCrucibleLid(hit.id);
      } else if (hit && hit.kind === 'rubber_stopper') {
        this.sim.setStopperMode(hit.id, hit.stopperMode === 'solid' ? 'holed' : 'solid');
      } else if (hit && hit.typeId === 'bunsen_burner') {
        this.sim.toggleBurnerAirHole(hit.id);
      } else if (hit && hit.kind === 'tongs') {
        this.sim.tongsToggleGripVessel(hit.id);
      } else if (hit && hit.kind === 'vessel' && hit.hasStirBar) {
        this.sim.toggleMagneticStir(hit.id);
      } else if (hit && hit.kind === 'stir_bar' && hit.inVesselId) {
        this.sim.toggleMagneticStir(hit.inVesselId);
      } else if (!hit && this.zoomScale > 1.02) {
        this.resetZoom();
      }
    });

    this.canvas.addEventListener('pointerleave', () => {
      this.pointerLogical = null;
      if (!this.dragState && !this.portDragState && !this.panDragState) {
        this.hoverItemId = null;
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const pt = this.clientToLogical(e.clientX, e.clientY);
      this.pointerLogical = { x: pt.x, y: pt.y };
      if (this.panDragState) {
        const dxPx = e.clientX - this.panDragState.startClientX;
        const dyPx = e.clientY - this.panDragState.startClientY;
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
          this.dropTargetVesselId =
            vTgt && !vTgt.isStoppered ? vTgt.id : vTgt && pd.port === 'inlet' ? vTgt.id : null;
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
        const portHover = this.findCondenserPortAt(pt.x, pt.y);
        if (portHover) {
          this.hoverItemId = portHover.cond.id;
          this.canvas.style.cursor = this.zoomMode && this.zoomScale <= 1.02 ? 'zoom-in' : 'crosshair';
          return;
        }
        const hit = this.hitTestItem(pt.x, pt.y);
        this.hoverItemId = hit ? hit.id : null;
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

      // Once user actually drags a docked stir bar (>6 px), undock it cleanly so simple clicks still inspect without ejecting!
      if (
        item.kind === 'stir_bar' &&
        item.inVesselId &&
        Math.hypot(pt.x - this.dragState.offsetX - this.dragState.startX, pt.y - this.dragState.offsetY - this.dragState.startY) > 6
      ) {
        const prevV = this.sim.getItem(item.inVesselId);
        if (prevV) {
          prevV.hasStirBar = false;
          prevV.magStirRpm = 0;
        }
        item.inVesselId = null;
      }

      const spec = APPARATUS[item.typeId];
      const minStandY = item.kind === 'stand' ? spec.height / 2 + 24 : 65;
      const nextX = Math.max(60, Math.min(BENCH_LOGICAL_W - 60, pt.x - this.dragState.offsetX));
      const nextY = Math.max(minStandY, Math.min(BENCH_FLOOR_Y - spec.height / 2 + 4, pt.y - this.dragState.offsetY));
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
          peer.x = Math.max(40, Math.min(BENCH_LOGICAL_W - 40, peer.x + dxMove));
          peer.y = Math.max(45, Math.min(BENCH_FLOOR_Y - (pSpec.height || 60) / 2 + 4, peer.y + dyMove));
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
            if (item.kind === 'burette' || item.kind === 'condenser' || item.kind === 'filter_funnel') {
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
      } else if (item.kind === 'wash_bottle') {
        const arc = computeWashBottleStreamArc(item, this.sim.items, BENCH_FLOOR_Y, CONSTANTS.GRAVITY_PX_S2 || 1800);
        this.dropTargetVesselId = arc.hitTarget ? arc.hitTarget.id : null;
      } else if (item.kind === 'stir_bar' || item.kind === 'electrode' || item.kind === 'filter_funnel') {
        const tgt = this.findVesselAt(item.x, item.y + 18, item.id, false);
        this.dropTargetVesselId = tgt && !tgt.isStoppered ? tgt.id : null;
      } else if (item.kind === 'rubber_stopper' && !item.attachedToId) {
        const mTgt = this.findMouthTargetAt(item.x, item.y, 'stopper');
        this.dropTargetVesselId = mTgt ? mTgt.vessel.id : null;
      } else if (item.kind === 'phen_cotton' && !item.attachedToId) {
        const mTgt = this.findMouthTargetAt(item.x, item.y, 'cotton');
        this.dropTargetVesselId = mTgt ? mTgt.vessel.id : null;
      } else if (item.kind === 'tongs') {
        const tip = getProbeTipPos(item);
        if (item.grippedVesselId) {
          const gv = this.sim.getItem(item.grippedVesselId);
          if (gv && !gv.isShattered) {
            gv.x = tip.x;
            gv.y = tip.y;
            gv.vy = 0;
            gv.restingOnId = null;
          }
          this.dropTargetVesselId = null;
        } else {
          const tgt = this.findVesselAt(tip.x, tip.y, null, false);
          this.dropTargetVesselId = tgt && !tgt.isShattered ? tgt.id : null;
        }
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
            item.tiltAngle = item.x >= tgt.x ? -0.35 : 0.35;
            item.hoveredActionLabel = this.langCode === 'vi' ? '🥄 Thả để đổ vào bình' : '🥄 Release to dump';
          } else if (spoonMol <= 1e-8 && tgtHasSolid) {
            this.dragState.spoonAction = 'scoop';
            this.dragState.spoonTargetId = tgt.id;
            this.dropTargetVesselId = tgt.id;
            item.tiltAngle = 0;
            item.hoveredActionLabel = this.langCode === 'vi' ? '🥄 Thả để múc chất rắn' : '🥄 Release to scoop';
          } else {
            this.dragState.spoonAction = null;
            this.dragState.spoonTargetId = null;
            this.dropTargetVesselId = null;
            item.tiltAngle = 0;
            item.hoveredActionLabel = null;
          }
        } else {
          this.dragState.spoonAction = null;
          this.dragState.spoonTargetId = null;
          this.dropTargetVesselId = null;
          item.tiltAngle = 0;
          item.hoveredActionLabel = null;
        }
      }

      // If dragging a vessel/mortar/filter_funnel, check if hovering above another container rim to tilt & pour
      if ((item.kind === 'vessel' || item.kind === 'filter_funnel') && !item.isStoppered && !item.isShattered) {
        const liqMl = computeLiquidVolumeL(item.moles, item.tempK) * 1000;
        const dragDistFromStart = Math.hypot(item.x - this.dragState.startX, item.y - this.dragState.startY);
        const allowFunnelPour =
          item.kind !== 'filter_funnel' || (dragDistFromStart > 56 && liqMl > 0.05);
        const hasDryMovableSolids =
          APPARATUS[item.typeId]?.isMortar && Object.values(item.moles || {}).some((n) => n > 1e-8);
        let target = null;
        if ((liqMl > 0.05 && allowFunnelPour) || hasDryMovableSolids) {
          // Prioritize mounted Filter Funnels & Burettes BEFORE bare receiving vessels underneath!
          const pourCands = [
            ...this.sim.items.filter((o) => (o.kind === 'filter_funnel' || o.kind === 'burette') && !o.isBroken),
            ...this.sim.items.filter((o) => o.kind === 'vessel' && !o.isShattered && !o.isStoppered),
          ];
          for (const other of pourCands) {
            if (other.id === item.id) continue;
            if (item.kind === 'filter_funnel' && other.id === this.dragState.unmountHoldoffId) continue;
            const oSpec = APPARATUS[other.typeId];
            const rimY = other.y - oSpec.height / 2;
            const reachY = other.kind === 'filter_funnel' ? 42 : 28;
            if (Math.abs(item.x - other.x) < 78 && item.y < rimY + reachY && item.y > rimY - 125) {
              // Redirect pour targeting an open vessel that currently wears a mounted Filter Funnel -> funnel first!
              if (other.kind === 'vessel' && item.kind !== 'filter_funnel') {
                const mountedFunnel = this.getMountedFunnelOnVessel(other.id);
                target = mountedFunnel || other;
              } else {
                target = other;
              }
              break;
            }
          }
        }
        if (target) {
          this.dragState.pourTargetId = target.id;
          this.dropTargetVesselId = target.id;
          this.dragState.targetTilt = item.x >= target.x ? -0.56 : 0.56;
          this.dragState.pourAlignFactor = Math.max(0.45, 1.0 - Math.abs(item.x - target.x) / 110);
        } else {
          this.dragState.pourTargetId = null;
          if (item.kind !== 'filter_funnel') this.dropTargetVesselId = null;
          this.dragState.targetTilt = 0;
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

      const dragItemsList = this.dragState?.groupMembers?.length > 1
        ? this.dragState.groupMembers.map((m) => m.item).filter(Boolean)
        : [item];
      this.callbacks.onExternalTabDragHover?.(e.clientX, e.clientY, item, dragItemsList);
      this.sim.recomputeScaleReadings();
    });

    const endDrag = (e) => {
      this.callbacks.onExternalTabDragHover?.(0, 0, null, null);
      if (this.marqueeState) {
        this.marqueeState = null;
        this.canvas.style.cursor = 'default';
        if (e?.pointerId != null && this.canvas.hasPointerCapture?.(e.pointerId)) {
          try {
            this.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
        this.callbacks.onSelect?.(this.sim.getItem(this.sim.selectedId));
        this.sim.emitChange();
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
              } else if (pd.port === 'outlet' && !vTgt.isStoppered) {
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
      try {
        const item = this.sim.getItem(this.dragState.itemId);
        const pipTargetId = this.dragState.pipetteTargetId;
        const dropItemsList = this.dragState.groupMembers?.length > 1
          ? this.dragState.groupMembers.map((m) => m.item).filter(Boolean)
          : item ? [item] : [];
        if (item && this.callbacks.onDropToLabTab?.(e.clientX, e.clientY, item, dropItemsList)) {
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
              this.sim.attachRubberStopper(item.id, mTgt.vessel.id, mTgt.side);
            }
          } else if (item.kind === 'phen_cotton' && !item.attachedToId) {
            const mTgt = this.findMouthTargetAt(item.x, item.y, 'cotton');
            if (mTgt) {
              this.sim.attachPhenCotton(item.id, mTgt.vessel.id, mTgt.side);
            }
          } else if (item.kind === 'stir_bar') {
            const tgt = this.findVesselAt(item.x, item.y + 10, null, false);
            if (tgt && !tgt.isStoppered) {
              this.sim.insertStirBarIntoVessel(item.id, tgt.id, 800);
            }
          } else if (item.kind === 'electrode') {
            const tgt = this.findVesselAt(item.x, item.y + 10, null, false);
            const tSpec = tgt ? APPARATUS[tgt.typeId] : null;
            const side = tgt && item.x >= tgt.x ? 'right' : 'left';
            const sideBlocked =
              tSpec?.hasTwoEnds ? (side === 'left' ? tgt.leftStoppered : tgt.rightStoppered) : tgt?.isStoppered;
            if (tgt && !tSpec?.isHorizontalTube && !sideBlocked) {
              item.dockedVesselId = tgt.id;
              item.dockSide = side;
              syncDockedToolPositions(this.sim);
            }
          } else if (item.kind === 'filter_funnel' && !this.dragState.pourTargetId) {
            const dragMoved = Math.hypot(item.x - this.dragState.startX, item.y - this.dragState.startY);
            const tgt = this.findVesselAt(item.x, item.y + 38, null, false);
            if (tgt && !tgt.isStoppered && Math.abs(item.x - tgt.x) <= 28) {
              // Remount if clicked in place or dropped onto a rim deliberately
              if (dragMoved <= 6 || tgt.id !== this.dragState.unmountHoldoffId || Math.abs(item.y - (tgt.y - APPARATUS[tgt.typeId].height / 2)) <= 30) {
                item.mountedOnVesselId = tgt.id;
                syncDockedToolPositions(this.sim);
              }
            }
          }
          item.fallStartY =
            item.clampedToId || item.dockedVesselId || item.inVesselId || item.mountedOnVesselId || item.attachedToId
              ? null
              : item.y;
          item.vy = 0;
        }
        if (item && (item.kind === 'vessel' || item.kind === 'pipette' || item.kind === 'spoon')) {
          item.tiltAngle = 0;
        }
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
            this.sim.spoonPourIntoVessel(item.id, spTgtId);
          } else if (spTgtId && spAct === 'scoop') {
            this.sim.spoonScoopFromVessel(item.id, spTgtId);
          }
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
        this.sim.updateSupportAttachments();
        this.sim.emitChange();
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
        if (!this.zoomMode && this.zoomScale <= 1.01 && !e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        const nextScale = Math.max(1.0, Math.min(4.2, this.zoomScale * factor));
        const rect = this.canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const baseX = (cx - this.viewOffsetX) / this.viewScale;
        const baseY = (cy - this.viewOffsetY) / this.viewScale;
        const pt = this.clientToLogical(e.clientX, e.clientY);
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

    // Smoothly tilt toward target angle (~2.1 rad/s) or relax upright when away from pour target
    if (src.kind === 'vessel' || src.kind === 'filter_funnel') {
      const targetTilt = this.dragState.pourTargetId ? this.dragState.targetTilt || 0 : 0;
      const curTilt = src.tiltAngle || 0;
      const maxDelta = 2.1 * realDeltaSec;
      if (Math.abs(targetTilt - curTilt) <= maxDelta) {
        src.tiltAngle = targetTilt;
      } else {
        src.tiltAngle = curTilt + Math.sign(targetTilt - curTilt) * maxDelta;
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
      this.sim.transferSolidsToVessel(src.id, dst.id, 1.0);
      this.dragState.pourTargetId = null;
      return;
    }

    // Steady realistic gravity flow calibrated to neck width, tilt progression & smooth low-volume tail
    const isNarrowNeck =
      srcSpec.shape === 'erlenmeyer' || srcSpec.shape === 'test_tube' || srcSpec.shape === 'cylinder';
    const baseMaxRateMlS = isNarrowNeck ? 8.5 : 12.0;
    const tiltFrac = Math.pow(Math.min(1, (absTilt - 0.10) / 0.46), 1.35);
    const tailFactor = srcLiqMl < 5.0 ? Math.max(0.18, srcLiqMl / 5.0) : 1.0;
    const alignFactor = this.dragState.pourAlignFactor ?? 1.0;
    const flowRateMlS = baseMaxRateMlS * tiltFrac * tailFactor * alignFactor;

    // Physical hand-tilted decanting: settled dense solids remain behind unless previously stirred
    const poured = this.sim.pourBetweenVessels(src.id, dst.id, flowRateMlS * realDeltaSec, false);
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
    ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 5;
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

  renderWorldScene(ctx, timeNow, { includeLabels = true } = {}) {
    // 1. Background subtle grid & lab bench surface (plus optional UV Lamp spotlight)
    if (this.sim.environment.uvLight) {
      const uvGrad = ctx.createRadialGradient(BENCH_LOGICAL_W * 0.5, 10, 20, BENCH_LOGICAL_W * 0.5, 250, 520);
      uvGrad.addColorStop(0, this.isDark ? 'rgba(139, 92, 246, 0.24)' : 'rgba(139, 92, 246, 0.14)');
      uvGrad.addColorStop(1, 'rgba(139, 92, 246, 0)');
      ctx.fillStyle = uvGrad;
      ctx.fillRect(0, 0, BENCH_LOGICAL_W, BENCH_FLOOR_Y);
    }
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
    beginCanvasLabelFrame(activeTooltipIds);

    renderTubingConnections(ctx, this.sim.items, this.isDark, timeNow, this.langCode);
    renderElectrodeCollectorTubes(ctx, this.sim.items, this.isDark, timeNow);

    const compareIds = Array.isArray(this.sim.compareVesselIds) ? this.sim.compareVesselIds : [];
    const compareTags = ['A', 'B', 'C'];
    const compareColors = ['#38bdf8', '#f472b6', '#34d399'];

    const ordered = [
      ...this.sim.items.filter((i) => i.kind === 'stand' || i.kind === 'dc_power' || i.kind === 'volt_ammeter'),
      ...this.sim.items.filter((i) => i.kind === 'scale' || i.kind === 'burner' || i.kind === 'diffusion_tube'),
      ...this.sim.items.filter((i) => i.kind === 'gas_syringe' || i.kind === 'condenser' || i.kind === 'burette'),
      ...this.sim.items.filter((i) => i.kind === 'vessel'),
      ...this.sim.items.filter((i) => i.kind === 'rubber_stopper' || i.kind === 'phen_cotton'),
      ...this.sim.items.filter((i) => i.kind === 'filter_funnel' || i.kind === 'electrode' || i.kind === 'salt_bridge' || i.kind === 'stir_bar'),
      ...this.sim.items.filter((i) => i.kind === 'pipette' || i.kind === 'wash_bottle' || i.kind === 'splint' || i.kind === 'flame_loop' || i.kind === 'indicator_strip' || i.kind === 'tongs' || i.kind === 'spoon'),
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
          timeNow,
          langCode: this.langCode,
        });
      } else if (item.kind === 'pipette') {
        renderPipette(ctx, item, isSelected, this.isDark, this.langCode, timeNow);
      } else if (item.kind === 'filter_funnel') {
        renderFilterFunnel(ctx, item, isSelected, isDropTgt, this.isDark, this.langCode, timeNow);
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
      } else if (item.kind === 'tongs') {
        renderCrucibleTongs(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'spoon') {
        renderIronSpoon(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'stir_bar') {
        renderStirBar(ctx, item, isSelected, this.isDark);
      } else if (item.kind === 'electrode') {
        renderElectrodeRod(ctx, item, isSelected, this.isDark, timeNow);
      } else if (item.kind === 'salt_bridge') {
        renderSaltBridge(ctx, item, this.sim.items, isSelected, this.isDark, timeNow, this.langCode);
      } else if (item.kind === 'rubber_stopper') {
        const hostV = item.attachedToId ? this.sim.getItem(item.attachedToId) : null;
        renderRubberStopper(ctx, item, isSelected, this.isDark, hostV);
      } else if (item.kind === 'phen_cotton') {
        renderPhenCotton(ctx, item, isSelected, this.isDark);
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

    // 5. Render particles (bubbles, steam, Na yellow flame, sparks, glass shards)
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

    // 7. Render hovered/dragged Canvas tooltip pills on the very top layer above vapor/steam/smoke!
    if (includeLabels) {
      flushCanvasLabelFrame(ctx);
    }
  }
}
