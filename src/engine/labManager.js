import { APPARATUS } from '../data/apparatus.js';
import { CONSTANTS } from '../data/constants.js';
import { ParticleSystem } from '../canvas/particles.js';
import { LabSimulation, SIM_BENCH_FLOOR_Y } from './simulation.js';

/**
 * Orchestrates up to 10 concurrent active lab benches sharing a single UI viewport.
 * Active lab runs at 60 FPS with full Canvas particles; background labs advance smoothly at ~15 Hz
 * so reactions, heating, electrolysis and crystals progress live with near-zero CPU overhead.
 */
export class LabManager {
  constructor(hooks = {}) {
    this.maxLabs = CONSTANTS.MAX_LABS || 10;
    this.hooks = hooks; // { onAlert(labIndex, type, vessel, meta), onChange(), onActiveParticlesNeeded(vessel, metrics, dt) }
    this.labs = [];
    this.activeIndex = 0;
    this.nextLabNumber = 1;
    this.clipboard = null;
    this.tabClipboard = null;
    this.storageCabinet = []; // Infinite-capacity frozen storage locker ({ id, storedAt, apparatusId, speciesIds, hasChemicals, stickyLabel, snapshot })
    this.pasteSequence = 0;
    this._bgCursor = 0;
    this.addLab('starter', { silent: true });
  }

  getActiveLab() {
    return this.labs[this.activeIndex] || this.labs[0];
  }

  getActiveSim() {
    return this.getActiveLab().sim;
  }

  getActiveParticles() {
    return this.getActiveLab().particles;
  }

  _wireLabHooks(lab) {
    lab.sim.visualHooks.onParticlesNeeded = (vessel, metrics) => {
      if (this.labs[this.activeIndex] !== lab) return;
      this.hooks.onActiveParticlesNeeded?.(vessel, metrics);
    };
    lab.sim.visualHooks.onAlert = (type, vessel, meta) => {
      const idx = this.labs.indexOf(lab);
      if (idx === this.activeIndex) {
        this.hooks.onAlert?.(idx, type, vessel, meta);
      } else if (idx >= 0) {
        lab.unreadAlerts = (lab.unreadAlerts || 0) + 1;
        this.hooks.onBackgroundAlert?.(idx, type, vessel, meta);
      }
    };
    lab.sim.visualHooks.onReagentDispense = (v, reg, amt, opts) => {
      if (this.labs[this.activeIndex] !== lab) return;
      this.hooks.onReagentDispense?.(v, reg, amt, opts);
    };
  }

  addLab(presetName = 'starter', options = {}) {
    if (this.labs.length >= this.maxLabs) {
      return { ok: false, reason: 'max_labs' };
    }
    const labNum = this.nextLabNumber++;
    const sim = new LabSimulation();
    // Preserve current ambient atmosphere if spawned from active session
    const curEnv = this.labs[this.activeIndex]?.sim?.environment;
    if (curEnv && !options.defaultEnv) {
      sim.environment.atmosphereMode = curEnv.atmosphereMode;
      sim.environment.tempK = curEnv.tempK;
      sim.environment.pressureBar = curEnv.pressureBar;
      sim.environment.uvLight = curEnv.uvLight;
    }
    const lab = {
      id: `lab_${labNum}`,
      number: labNum,
      customName: options.customName ? String(options.customName).trim() : '',
      sim,
      particles: new ParticleSystem(),
      unreadAlerts: 0,
      bgAccum: -(this.labs.length * (0.066 / 9)),
    };
    this._wireLabHooks(lab);
    sim.setupPreset(presetName);
    sim.undoStack = [];
    sim.redoStack = [];
    this.labs.push(lab);
    const newIndex = this.labs.length - 1;
    if (!options.keepActive) {
      this.activeIndex = newIndex;
      lab.unreadAlerts = 0;
    }
    if (!options.silent) this.hooks.onChange?.();
    return { ok: true, index: newIndex, lab };
  }

  switchLab(index) {
    if (index < 0 || index >= this.labs.length || index === this.activeIndex) return false;
    this.activeIndex = index;
    this.labs[index].unreadAlerts = 0;
    this.hooks.onChange?.();
    return true;
  }

  hasActiveExamLab() {
    return this.labs.some((l) => Boolean(l.sim?.missionState?.examMode));
  }

  openIsolatedExamTab(options = {}) {
    const label = options.customName || `📝 ${options.examCode || 'Exam'}`;
    // Reuse existing isolated exam tab for the same examCode if already open
    if (options.examCode) {
      const existingIdx = this.labs.findIndex((l) => l.sim?.missionState?.examCode === options.examCode);
      if (existingIdx >= 0) {
        this.switchLab(existingIdx);
        return { ok: true, index: existingIdx, lab: this.labs[existingIdx], reused: true };
      }
    }
    if (this.labs.length < this.maxLabs) {
      const res = this.addLab('clean', { customName: label, defaultEnv: true });
      if (res.ok && res.lab) res.lab.isExamTab = true;
      return res;
    }
    // If all 10 tabs are full, replace a non-exam active lab
    const cur = this.getActiveLab();
    if (!cur?.sim?.missionState?.examMode) {
      cur.customName = label;
      cur.isExamTab = true;
      cur.sim.setupPreset('clean');
      this.hooks.onChange?.();
      return { ok: true, index: this.activeIndex, lab: cur };
    }
    return { ok: false, reason: 'max_labs' };
  }

  removeLab(index) {
    if (this.labs.length <= 1 || index < 0 || index >= this.labs.length) return false;
    this.labs.splice(index, 1);
    if (this.activeIndex >= this.labs.length) {
      this.activeIndex = this.labs.length - 1;
    } else if (index < this.activeIndex) {
      this.activeIndex -= 1;
    }
    this.labs[this.activeIndex].unreadAlerts = 0;
    this.hooks.onChange?.();
    return true;
  }

  /**
   * Atomically relocate an apparatus (preserving full chemical, thermal, plating, and gas state)
   * from srcLabIndex to dstLabIndex with clean disconnect and guaranteed unique destination ID.
   */
  moveItemBetweenLabs(itemId, srcIndex, dstIndex) {
    if (
      srcIndex < 0 ||
      srcIndex >= this.labs.length ||
      dstIndex < 0 ||
      dstIndex >= this.labs.length ||
      srcIndex === dstIndex
    ) {
      return null;
    }
    const srcLab = this.labs[srcIndex];
    const dstLab = this.labs[dstIndex];
    if (srcLab.sim?.missionState?.examMode || dstLab.sim?.missionState?.examMode) {
      this.hooks.onExamTransferBlocked?.(srcLab, dstLab);
      return null;
    }
    const srcSim = srcLab.sim;
    const dstSim = dstLab.sim;
    const item = srcSim.getItem(itemId);
    if (!item) return null;

    srcSim.detachItemRelations(item);
    srcSim.items = srcSim.items.filter((it) => it.id !== item.id);
    if (srcSim.selectedId === item.id) {
      srcSim.selectedId = srcSim.items[0]?.id || null;
    }
    srcSim.updateSupportAttachments();
    srcSim.recomputeScaleReadings();

    const spec = APPARATUS[item.typeId] || APPARATUS.beaker_250;
    const newId = `${item.typeId}_${dstSim.nextId++}`;
    item.id = newId;
    item.label = `#${dstSim.nextId - 1}`;
    item.isDragging = false;
    item.vy = 0;
    item.fallStartY = null;
    if (item.tiltAngle !== undefined) item.tiltAngle = 0;

    // Place in a clean unobstructed horizontal slot on destination bench
    const slotCount = dstSim.items.length;
    item.x = 140 + ((slotCount * 125) % 680);
    item.y = SIM_BENCH_FLOOR_Y - (spec.height || 80) / 2 + 2;

    if (item.kind === 'vessel' && dstSim.environment.atmosphereMode === 'inert' && !item.isStoppered) {
      item.airO2PurgeFrac = 0;
    }

    dstSim.items.push(item);
    dstSim.updateSupportAttachments();
    dstSim.recomputeScaleReadings();
    dstSim.selectedId = item.id;

    if (dstIndex !== this.activeIndex) {
      dstLab.unreadAlerts = (dstLab.unreadAlerts || 0) + 1;
    }
    srcSim.emitChange();
    dstSim.emitChange();
    this.hooks.onChange?.();
    return { item, srcLab, dstLab };
  }

  renameLab(index, customName = '') {
    const lab = this.labs[index];
    if (!lab) return false;
    lab.customName = String(customName || '').trim().slice(0, 40);
    this.hooks.onChange?.();
    return true;
  }

  getLabDisplayName(lab, fallbackPrefix = 'Bàn') {
    if (!lab) return `${fallbackPrefix} 1`;
    return lab.customName && lab.customName.trim() ? lab.customName.trim() : `${fallbackPrefix} ${lab.number}`;
  }

  clearBench(simOverride = null) {
    const lab = this.getActiveLab();
    const sim = simOverride || lab?.sim;
    if (!sim) return false;
    sim.recordUndo?.();
    sim.setupPreset('clean');
    lab?.particles?.clear?.();
    sim.emitChange?.();
    this.hooks.onChange?.();
    return true;
  }

  _cloneItemSnapshot(it) {
    const clone = JSON.parse(JSON.stringify(it));
    delete clone.isDragging;
    delete clone.hoveredActionLabel;
    delete clone.history;
    delete clone.renderColor;
    delete clone.computedPh;
    delete clone.reactionRate;
    delete clone.lastBubbleMs;
    delete clone.squirtTimer;
    delete clone.manualSprayHold;
    delete clone.isSpraying;
    delete clone.fallStartY;
    clone.tiltAngle = 0;
    return clone;
  }

  /**
   * Store a bench apparatus/vessel (frozen cleanly in time — zero reactions/evaporation/cooling)
   * into the infinite-capacity Storage Cabinet.
   */
  storeItemToCabinet(itemId, simOverride = null, opts = {}) {
    const sim = simOverride || this.getActiveSim();
    if (!sim) return null;
    const it = sim.getItem(itemId);
    if (!it) return null;
    if (!opts.silentUndo) sim.recordUndo?.();

    const snap = this._cloneItemSnapshot(it);
    // Detach spatial relationships so stored copy is standalone
    delete snap.dockedToStandId;
    delete snap.dockedVesselId;
    delete snap.restingOnId;
    delete snap.attachedToId;
    delete snap.connectedTargetId;
    delete snap.connectedSyringeId;
    delete snap.connectedFromId;
    delete snap.outletTargetId;
    delete snap.posElectrodeId;
    delete snap.negElectrodeId;

    const speciesIds = Object.entries(snap.moles || {})
      .filter(([, n]) => Number(n) > 1e-12)
      .map(([spId]) => spId);
    const gasIds = [
      ...Object.entries(snap.headspaceGasMoles || {})
        .filter(([g, n]) => g !== 'H2O_g' && Number(n) > 1e-10)
        .map(([g]) => g),
      ...Object.entries(snap.gasMoles || {})
        .filter(([g, n]) => g !== 'H2O_g' && Number(n) > 1e-10)
        .map(([g]) => g),
    ];

    const entry = {
      id: `cab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      storedAt: Date.now(),
      apparatusId: snap.typeId,
      kind: snap.kind,
      speciesIds: Array.from(new Set([...speciesIds, ...gasIds])),
      hasChemicals:
        speciesIds.length > 0 ||
        gasIds.length > 0 ||
        (snap.volumeMl || 0) > 0 ||
        (snap.condensedWaterMol || 0) > 1e-6 ||
        (snap.condensedEtOHMol || 0) > 1e-6 ||
        (snap.frozenWaterMol || 0) > 1e-6,
      stickyLabel: snap.stickyLabel ? { ...snap.stickyLabel } : null,
      tempK: snap.tempK ?? CONSTANTS.T_STD_K,
      snapshot: snap,
    };
    this.storageCabinet.unshift(entry);

    if (!opts.keepOnBench) {
      sim.removeApparatus(it.id);
    }
    this.hooks.onChange?.();
    return entry;
  }

  withdrawFromCabinet(entryId, opts = {}) {
    const idx = this.storageCabinet.findIndex((e) => e.id === entryId);
    if (idx < 0) return null;
    const entry = this.storageCabinet[idx];
    const sim = opts.simOverride || this.getActiveSim();
    if (!sim || !entry?.snapshot?.typeId) return null;
    const spec = APPARATUS[entry.snapshot.typeId];
    if (!spec) return null;

    sim.recordUndo?.();
    const dropX = Number.isFinite(opts.targetX)
      ? Math.max(60, Math.min(940, opts.targetX))
      : 160 + ((sim.items.length * 115) % 660);
    const dropY = Number.isFinite(opts.targetY)
      ? Math.max(65, Math.min(SIM_BENCH_FLOOR_Y - (spec.height || 80) / 2 + 2, opts.targetY))
      : SIM_BENCH_FLOOR_Y - (spec.height || 80) / 2 + 2;

    const item = sim.createApparatus(entry.snapshot.typeId, dropX, dropY, { silentUndo: true });
    if (!item) return null;

    const s = JSON.parse(JSON.stringify(entry.snapshot));
    const keepId = item.id;
    const keepLabel = item.label;
    Object.assign(item, s);
    item.id = keepId;
    item.label = keepLabel;
    item.x = dropX;
    item.y = dropY;
    item.isDragging = false;
    item.vy = 0;
    item.fallStartY = dropY;
    item.tiltAngle = 0;
    if (item.stickyLabel?.text) item.stickyLabel = { ...item.stickyLabel };

    if (opts.mode !== 'clone') {
      this.storageCabinet.splice(idx, 1);
    }
    sim.selectedIds = new Set([item.id]);
    sim.selectedId = item.id;
    sim.updateSupportAttachments();
    sim.recomputeScaleReadings();
    sim.emitChange();
    this.hooks.onChange?.();
    return item;
  }

  removeFromCabinet(entryId) {
    const idx = this.storageCabinet.findIndex((e) => e.id === entryId);
    if (idx < 0) return false;
    this.storageCabinet.splice(idx, 1);
    this.hooks.onChange?.();
    return true;
  }

  mergeStorageCabinet(entries = []) {
    if (!Array.isArray(entries)) return 0;
    let added = 0;
    const seen = new Set(this.storageCabinet.map((e) => e.id));
    for (const raw of entries) {
      if (!raw || !raw.snapshot?.typeId) continue;
      const copy = JSON.parse(JSON.stringify(raw));
      if (!copy.id || seen.has(copy.id)) {
        copy.id = `cab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      }
      seen.add(copy.id);
      this.storageCabinet.push(copy);
      added++;
    }
    if (added > 0) this.hooks.onChange?.();
    return added;
  }

  /**
   * Copy selected apparatus onto clipboard WITH full chemical, thermal, stopper & stickyLabel state.
   */
  copyItems(itemIds = null, simOverride = null) {
    const sim = simOverride || this.getActiveSim();
    if (!sim) return 0;
    const rawIds =
      Array.isArray(itemIds) || itemIds instanceof Set
        ? Array.from(itemIds)
        : sim.selectedIds?.size > 0
        ? Array.from(sim.selectedIds)
        : sim.selectedId
        ? [sim.selectedId]
        : [];
    const selected = sim.items.filter((it) => rawIds.includes(it.id));
    if (selected.length === 0) return 0;
    const avgX = selected.reduce((s, it) => s + it.x, 0) / selected.length;
    const avgY = selected.reduce((s, it) => s + it.y, 0) / selected.length;
    this.clipboard = selected.map((it) => {
      const snap = this._cloneItemSnapshot(it);
      return {
        ...snap,
        dx: it.x - avgX,
        dy: it.y - avgY,
        anchorX: avgX,
        anchorY: avgY,
        mode: it.kind === 'volt_ammeter' ? it.mode : it.kind === 'splint' ? 'unlit' : it.mode,
      };
    });
    this.pasteSequence = 0;
    return this.clipboard.length;
  }

  cutItems(itemIds = null, simOverride = null) {
    const sim = simOverride || this.getActiveSim();
    if (!sim) return 0;
    const n = this.copyItems(itemIds, sim);
    if (n <= 0) return 0;
    const ids = sim.selectedIds?.size > 0 ? Array.from(sim.selectedIds) : sim.selectedId ? [sim.selectedId] : [];
    sim.recordUndo?.();
    sim.withUndoSuppressed?.(() => {
      for (const id of ids) {
        sim.removeApparatus(id);
      }
    });
    this.hooks.onChange?.();
    return n;
  }

  /**
   * Paste apparatus from clipboard onto active bench.
   * - includeChemicals: true (Ctrl+V, default) preserves full chemical/thermal/gas/stickyLabel state.
   * - includeChemicals: false (Ctrl+Shift+V) pastes empty shell ONLY while still keeping stickyLabel!
   * - targetX/targetY: paste centered at mouse cursor inside canvas when provided.
   */
  pasteItems(simOverride = null, opts = {}) {
    const sim = simOverride || this.getActiveSim();
    if (!sim || !Array.isArray(this.clipboard) || this.clipboard.length === 0) return [];
    const includeChemicals = opts.includeChemicals !== false;
    const hasCursor = Number.isFinite(opts.targetX) && Number.isFinite(opts.targetY);
    sim.recordUndo?.();
    this.pasteSequence = hasCursor ? 0 : (this.pasteSequence || 0) + 1;
    const stepShiftX = hasCursor ? 0 : 32 * this.pasteSequence;
    const stepShiftY = hasCursor ? 0 : -16 * (this.pasteSequence % 3);
    const createdList = [];
    for (const entry of this.clipboard) {
      const spec = APPARATUS[entry.typeId];
      if (!spec) continue;
      const baseX = hasCursor ? opts.targetX : (entry.anchorX ?? 420);
      const baseY = hasCursor ? opts.targetY : (entry.anchorY ?? 360);
      const targetX = Math.max(60, Math.min(940, baseX + stepShiftX + (entry.dx || 0)));
      const targetY = Math.max(
        65,
        Math.min(SIM_BENCH_FLOOR_Y - (spec.height || 80) / 2 + 2, baseY + stepShiftY + (entry.dy || 0))
      );
      const item = sim.createApparatus(entry.typeId, targetX, targetY, { silentUndo: true });
      if (!item) continue;

      if (includeChemicals) {
        const keepId = item.id;
        const keepLabel = item.label;
        const cloned = JSON.parse(JSON.stringify(entry));
        delete cloned.dx;
        delete cloned.dy;
        delete cloned.anchorX;
        delete cloned.anchorY;
        delete cloned.dockedToStandId;
        delete cloned.dockedVesselId;
        delete cloned.restingOnId;
        delete cloned.attachedToId;
        delete cloned.connectedTargetId;
        delete cloned.connectedSyringeId;
        delete cloned.connectedFromId;
        delete cloned.outletTargetId;
        delete cloned.posElectrodeId;
        delete cloned.negElectrodeId;
        Object.assign(item, cloned);
        item.id = keepId;
        item.label = keepLabel;
        item.x = targetX;
        item.y = targetY;
      } else {
        // Shell-only paste: preserve structural geometry/settings + stickyLabel, strip all chemicals & attachments
        item.flippedX = Boolean(entry.flippedX);
        if (entry.isInverted && item.kind === 'vessel') item.isInverted = true;
        if (entry.material && item.kind === 'electrode') item.material = entry.material;
        if (entry.mode !== undefined && (item.kind === 'volt_ammeter' || item.kind === 'splint')) item.mode = entry.mode;
        if (entry.stripKind && item.kind === 'indicator_strip') item.stripKind = entry.stripKind;
        if (entry.stopperMode && item.kind === 'rubber_stopper') item.stopperMode = entry.stopperMode;
        if (entry.dampness !== undefined && item.kind === 'phen_cotton') item.dampness = entry.dampness;
        if (entry.airHoleOpen !== undefined && item.typeId === 'bunsen_burner') item.airHoleOpen = entry.airHoleOpen;
        if (entry.lidState !== undefined && item.kind === 'vessel') item.lidState = entry.lidState;
        if (entry.dropDoseMl !== undefined && item.kind === 'pipette') item.dropDoseMl = entry.dropDoseMl;
        if (entry.voltage !== undefined && item.kind === 'dc_power') item.voltage = entry.voltage;
        if (item.moles) item.moles = {};
        if (item.headspaceGasMoles) item.headspaceGasMoles = {};
        if (item.particleCounts) item.particleCounts = {};
        if (item.groundPowderMap) item.groundPowderMap = {};
        if (item.flattenedMetalMap) item.flattenedMetalMap = {};
        if (item.kind === 'pipette') {
          item.volumeMl = 0;
          item.moles = {};
        }
        if (item.kind === 'wash_bottle') {
          item.waterMl = 0;
        }
        if (item.kind === 'vessel') {
          item.isStoppered = false;
          item.leftStoppered = false;
          item.rightStoppered = false;
          item.hasPhenCotton = false;
          item.phenCottonLevel = 0;
          item.sealedAirMoles = null;
          item.sealedAirO2Moles = null;
        }
      }
      if (entry.stickyLabel?.text) {
        item.stickyLabel = { ...entry.stickyLabel };
      }
      item.isDragging = false;
      item.vy = 0;
      item.tiltAngle = 0;
      item.fallStartY = item.y;
      createdList.push(item);
    }
    if (createdList.length > 0) {
      sim.selectedIds = new Set(createdList.map((c) => c.id));
      sim.selectedId = createdList[createdList.length - 1].id;
      sim.updateSupportAttachments();
      sim.recomputeScaleReadings();
      sim.emitChange();
    }
    return createdList;
  }

  copyLab(index = this.activeIndex) {
    const lab = this.labs[index];
    if (!lab) return false;
    this.tabClipboard = {
      customName: lab.customName || '',
      timeSec: lab.sim.timeSec || 0,
      nextId: lab.sim.nextId || 1,
      environment: JSON.parse(JSON.stringify(lab.sim.environment || {})),
      items: (lab.sim.items || []).map((it) => this._cloneItemSnapshot(it)),
    };
    return true;
  }

  cutLab(index = this.activeIndex) {
    if (!this.copyLab(index)) return false;
    if (this.labs.length > 1) {
      return this.removeLab(index);
    }
    const lab = this.labs[index];
    if (lab) {
      lab.customName = '';
      lab.sim.setupPreset('clean');
      lab.particles?.clear?.();
      this.hooks.onChange?.();
    }
    return true;
  }

  pasteLab() {
    if (!this.tabClipboard) return { ok: false, reason: 'empty_clipboard' };
    if (this.labs.length >= this.maxLabs) return { ok: false, reason: 'max_labs' };
    const snap = this.tabClipboard;
    const baseName = snap.customName ? `${snap.customName} (copy)` : '';
    const res = this.addLab('clean', { silent: true, customName: baseName });
    if (!res?.ok || !res.lab) return { ok: false, reason: 'add_failed' };
    const sim = res.lab.sim;
    if (snap.environment) sim.environment = { ...sim.environment, ...JSON.parse(JSON.stringify(snap.environment)) };
    sim.timeSec = snap.timeSec || 0;
    sim.nextId = snap.nextId || 1;
    sim.items = JSON.parse(JSON.stringify(snap.items || []));
    sim.updateSupportAttachments();
    sim.recomputeScaleReadings();
    sim.emitChange();
    this.hooks.onChange?.();
    return { ok: true, index: res.index, lab: res.lab };
  }

  recordUndo(simOverride = null, meta = null) {
    const sim = simOverride || this.getActiveSim();
    return sim?.recordUndo?.(meta) || false;
  }

  undo(simOverride = null) {
    const lab = this.getActiveLab();
    const sim = simOverride || lab?.sim;
    if (!sim?.undo) return false;
    const ok = sim.undo();
    if (ok && lab?.particles) {
      lab.particles.clear();
    }
    if (ok) this.hooks.onChange?.();
    return ok;
  }

  redo(simOverride = null) {
    const lab = this.getActiveLab();
    const sim = simOverride || lab?.sim;
    if (!sim?.redo) return false;
    const ok = sim.redo();
    if (ok && lab?.particles) {
      lab.particles.clear();
    }
    if (ok) this.hooks.onChange?.();
    return ok;
  }

  /**
   * Step active lab at frame rate and distribute background labs across frames via Round-Robin
   * (max 2 background labs or ~4 ms/frame time budget) with staggered phase accumulation.
   */
  stepAllLabs(dt, onBgAlertChange = null) {
    const active = this.labs[this.activeIndex];
    if (active) {
      active.sim.step(dt);
      active.particles.update(dt * (active.sim.environment.paused ? 0 : active.sim.environment.speed));
    }

    const nLabs = this.labs.length;
    if (nLabs <= 1) return;

    for (let i = 0; i < nLabs; i++) {
      if (i === this.activeIndex) continue;
      const lab = this.labs[i];
      if (!lab.sim.environment.paused) {
        lab.bgAccum += dt;
      }
    }

    const nowFn = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
    const tStart = nowFn();
    let bgNotified = false;
    let steppedCount = 0;
    let checked = 0;

    while (checked < nLabs) {
      const idx = this._bgCursor % nLabs;
      this._bgCursor = (idx + 1) % nLabs;
      checked++;
      if (idx === this.activeIndex) continue;

      const lab = this.labs[idx];
      if (lab.sim.environment.paused || lab.bgAccum < 0.033) continue;

      const prevAlert = lab.unreadAlerts || 0;
      const batchDt = Math.min(0.25, lab.bgAccum);
      lab.bgAccum = 0;
      lab.sim.step(batchDt, { isBackground: true, maxSubsteps: 2 });
      if ((lab.unreadAlerts || 0) !== prevAlert) bgNotified = true;
      steppedCount++;

      if (steppedCount >= 2 || (steppedCount >= 1 && nowFn() - tStart >= 4.0)) {
        break;
      }
    }

    if (bgNotified) onBgAlertChange?.();
  }
}
