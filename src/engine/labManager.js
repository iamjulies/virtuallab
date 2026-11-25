import { APPARATUS } from '../data/apparatus.js';
import { CONSTANTS } from '../data/constants.js';
import { MISSION_REGISTRY } from '../data/missions.js';
import { ParticleSystem } from '../canvas/particles.js';
import { LabSimulation, SIM_BENCH_FLOOR_Y } from './simulation.js';
import { STORAGE_SHELF_Y_LEVELS } from './simSnapshot.js';

export const LINK_REF_FIELDS = [
  'dockedToStandId',
  'clampedToId',
  'dockedVesselId',
  'restingOnId',
  'attachedToId',
  'connectedTargetId',
  'connectedSyringeId',
  'connectedFromId',
  'outletTargetId',
  'posElectrodeId',
  'negElectrodeId',
  'vesselAId',
  'vesselBId',
  'gasTargetId',
  'filtrateTargetId',
  'targetVesselId',
  'mountedOnVesselId',
  'inVesselId',
  'refluxVesselId',
  'contactVesselId',
  'sprayTargetId',
  'mountedOverElectrodeId',
];

/**
 * BFS over undirected apparatus relationships (stand clamps, tubing, stoppers, mounts, circuits)
 * so storing/withdrawing an assembly keeps all connected items together.
 */
export function collectConnectedAssemblyIds(sim, seedItemId) {
  if (!sim || !Array.isArray(sim.items) || !seedItemId) return [];
  const byId = new Map(sim.items.map((it) => [it.id, it]));
  if (!byId.has(seedItemId)) return [];

  const adj = new Map();
  const addEdge = (a, b) => {
    if (!a || !b || a === b || !byId.has(a) || !byId.has(b)) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };

  for (const it of sim.items) {
    for (const f of LINK_REF_FIELDS) {
      if (it[f]) addEdge(it.id, it[f]);
    }
  }

  const visited = new Set([seedItemId]);
  const q = [seedItemId];
  while (q.length > 0) {
    const cur = q.shift();
    for (const nb of adj.get(cur) || []) {
      if (!visited.has(nb)) {
        visited.add(nb);
        q.push(nb);
      }
    }
  }
  return sim.items.filter((it) => visited.has(it.id)).map((it) => it.id);
}

/**
 * Security check: forbid transferring items from external Storage into Exam tabs
 * or Shelf-Locked Mission tabs (shelfPolicy/shelfLimitMode !== 'unrestricted').
 */
export function isLabLockedFromExternalStorage(labOrSim) {
  const sim = labOrSim?.sim || labOrSim;
  const st = sim?.missionState;
  if (!st || !st.active) return false;
  if (st.examMode) return true;
  const def = st.missionId ? MISSION_REGISTRY[st.missionId] : null;
  const policy =
    st.customConfig?.shelfPolicy ||
    st.customConfig?.shelfLimitMode ||
    st.shelfPolicy ||
    st.shelfLimitMode ||
    def?.shelfPolicy ||
    'unrestricted';
  return policy !== 'unrestricted';
}

/**
 * Orchestrates up to 10 concurrent active lab benches + infinite physical Storage Shelf pages.
 */
export class LabManager {
  constructor(hooks = {}) {
    this.maxLabs = CONSTANTS.MAX_LABS || 10;
    this.hooks = hooks;
    this.labs = [];
    this.activeIndex = 0;
    this.nextLabNumber = 1;
    this.storageLabs = [];
    this.activeStorageIndex = 0;
    this.viewingStorage = false;
    this.nextStorageNumber = 1;
    this._lastWithdrawError = null;
    this.clipboard = null;
    this.tabClipboard = null;
    this.pasteSequence = 0;
    this._bgCursor = 0;
    this.addStoragePage({ silent: true, keepActive: true });
    this.addLab('starter', { silent: true });
  }

  getActiveWorkbenchLab() {
    return this.labs[this.activeIndex] || this.labs[0];
  }

  getActiveStorageLab() {
    if (this.storageLabs.length === 0) {
      this.addStoragePage({ silent: true, keepActive: false });
    }
    return this.storageLabs[this.activeStorageIndex] || this.storageLabs[0];
  }

  getActiveLab() {
    return this.viewingStorage ? this.getActiveStorageLab() : this.getActiveWorkbenchLab();
  }

  getActiveSim() {
    return this.getActiveLab().sim;
  }

  getActiveParticles() {
    return this.getActiveLab().particles;
  }

  getTotalStorageItemCount() {
    return this.storageLabs.reduce((s, pg) => s + (pg?.sim?.items?.length || 0), 0);
  }

  get storageCabinet() {
    return this._serializeStorageCabinetEntries();
  }

  set storageCabinet(entries) {
    this.storageLabs = [];
    this.activeStorageIndex = 0;
    this.nextStorageNumber = 1;
    this.addStoragePage({ silent: true, keepActive: false });
    if (Array.isArray(entries) && entries.length > 0) {
      this.mergeStorageCabinet(entries, { silent: true });
    }
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
    const wasStorage = Boolean(sim.isStorageCabinet);
    sim.recordUndo?.();
    sim.setupPreset('clean');
    if (wasStorage) sim.isStorageCabinet = true;
    lab?.particles?.clear?.();
    sim.emitChange?.();
    this.hooks.onChange?.();
    return true;
  }

  setViewingStorage(flag) {
    const next = Boolean(flag);
    if (next && this.storageLabs.length === 0) {
      this.addStoragePage({ silent: true, keepActive: false });
    }
    this.viewingStorage = next;
    this.hooks.onChange?.();
    return this.viewingStorage;
  }

  addStoragePage(opts = {}) {
    const num = this.nextStorageNumber++;
    const sim = new LabSimulation();
    sim.setupPreset('clean');
    sim.isStorageCabinet = true;
    sim.undoStack = [];
    sim.redoStack = [];
    const page = {
      id: `storage_${num}`,
      number: num,
      customName: opts.customName ? String(opts.customName).trim() : '',
      sim,
      particles: new ParticleSystem(),
      unreadAlerts: 0,
      bgAccum: 0,
    };
    this.storageLabs.push(page);
    const idx = this.storageLabs.length - 1;
    if (!opts.keepActive) {
      this.activeStorageIndex = idx;
    }
    if (!opts.silent) this.hooks.onChange?.();
    return { ok: true, index: idx, page };
  }

  switchStoragePage(index) {
    if (this.storageLabs.length === 0) return false;
    const clamped = Math.max(0, Math.min(this.storageLabs.length - 1, Number(index) || 0));
    this.activeStorageIndex = clamped;
    this.hooks.onChange?.();
    return true;
  }

  removeEmptyStoragePage(index = this.activeStorageIndex) {
    if (this.storageLabs.length <= 1 || index < 0 || index >= this.storageLabs.length) return false;
    if ((this.storageLabs[index]?.sim?.items?.length || 0) > 0) return false;
    this.storageLabs.splice(index, 1);
    if (this.activeStorageIndex >= this.storageLabs.length) {
      this.activeStorageIndex = this.storageLabs.length - 1;
    }
    this.hooks.onChange?.();
    return true;
  }

  _buildStorageEntryMeta(snap, pageIndex = 0) {
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
    return {
      id: snap.id,
      cabinetPageIndex: pageIndex,
      x: snap.x,
      y: snap.y,
      storedAt: snap._storedAt || Date.now(),
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
  }

  _serializeStorageCabinetEntries() {
    const out = [];
    for (let p = 0; p < this.storageLabs.length; p++) {
      const pg = this.storageLabs[p];
      for (const it of pg?.sim?.items || []) {
        const snap = this._cloneItemSnapshot(it);
        snap._storedAt = it._storedAt || Date.now();
        out.push(this._buildStorageEntryMeta(snap, p));
      }
    }
    return out;
  }

  _findOpenShelfSlot(dstSim, spec, clusterOffsetX = 0) {
    const h = spec?.height || 80;
    const tiers = [STORAGE_SHELF_Y_LEVELS[2], STORAGE_SHELF_Y_LEVELS[1], STORAGE_SHELF_Y_LEVELS[0]];
    const items = dstSim.items || [];
    for (const shelfY of tiers) {
      const centerY = shelfY - h / 2 + 2;
      for (let x = 130; x <= 870; x += 110) {
        const occupied = items.some(
          (other) => Math.abs((other.x || 0) - x) < 76 && Math.abs((other.y || 0) - centerY) < 70
        );
        if (!occupied) return { x, y: centerY };
      }
    }
    const idx = items.length;
    return {
      x: Math.max(90, Math.min(910, 140 + ((idx * 105) % 720) + clusterOffsetX)),
      y: STORAGE_SHELF_Y_LEVELS[2] - h / 2 + 2,
    };
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

  _insertClusterSnapshots(rawSnaps, dstSim, opts = {}) {
    if (!dstSim || !Array.isArray(rawSnaps) || rawSnaps.length === 0) return [];
    const preserveCoords = Boolean(opts.preserveCoords);
    const snaps = rawSnaps.map((s) => this._cloneItemSnapshot(s));
    const idSet = new Set(snaps.map((s) => s.id));

    // Anchor offsets relative to bounding centroid / min baseline
    const minX = Math.min(...snaps.map((s) => Number(s.x) || 200));
    const maxX = Math.max(...snaps.map((s) => Number(s.x) || 200));
    const centerX = (minX + maxX) * 0.5;
    const maxBottomY = Math.max(
      ...snaps.map((s) => (Number(s.y) || 400) + (APPARATUS[s.typeId]?.height || 80) / 2 - 2)
    );

    let anchorX = centerX;
    let floorAnchorY = maxBottomY;
    if (!preserveCoords) {
      if (dstSim.isStorageCabinet && snaps.length === 1) {
        const spec0 = APPARATUS[snaps[0].typeId] || APPARATUS.beaker_250;
        const slot = Number.isFinite(opts.targetX) && Number.isFinite(opts.targetY)
          ? { x: opts.targetX, y: opts.targetY }
          : this._findOpenShelfSlot(dstSim, spec0);
        anchorX = slot.x;
        floorAnchorY = slot.y + (spec0.height || 80) / 2 - 2;
      } else if (Number.isFinite(opts.targetX) && Number.isFinite(opts.targetY)) {
        anchorX = Math.max(80, Math.min(920, opts.targetX));
        const spec0 = APPARATUS[snaps[0].typeId] || APPARATUS.beaker_250;
        floorAnchorY = Math.min(SIM_BENCH_FLOOR_Y, opts.targetY + (spec0.height || 80) / 2 - 2);
      } else if (dstSim.isStorageCabinet) {
        // Multi-item assembly stored on bench-level floor shelf so clamp heights align safely
        const spanW = maxX - minX;
        const baseSlotX = Math.max(90 + spanW * 0.5, Math.min(910 - spanW * 0.5, 220 + ((dstSim.items.length * 140) % 520)));
        anchorX = baseSlotX;
        floorAnchorY = SIM_BENCH_FLOOR_Y;
      } else {
        const slotCount = dstSim.items.length;
        anchorX = 180 + ((slotCount * 115) % 620);
        floorAnchorY = SIM_BENCH_FLOOR_Y;
      }
    }

    const idMap = new Map();
    const pairs = [];
    // Pass 1: Create destination apparatus shells first so intermediate updateSupportAttachments() inside createApparatus never wipes unremapped links
    for (const s of snaps) {
      const spec = APPARATUS[s.typeId];
      if (!spec) continue;
      let targetX = preserveCoords && Number.isFinite(s.x) ? s.x : anchorX + ((Number(s.x) || centerX) - centerX);
      let targetY = preserveCoords && Number.isFinite(s.y) ? s.y : floorAnchorY + ((Number(s.y) || maxBottomY) - maxBottomY);
      targetX = Math.max(50, Math.min(950, targetX));
      targetY = Math.max(55, Math.min(SIM_BENCH_FLOOR_Y - (spec.height || 80) / 2 + 2, targetY));

      const item = dstSim.createApparatus(s.typeId, targetX, targetY, { silentUndo: true });
      if (!item) continue;
      idMap.set(s.id, item.id);
      pairs.push({ item, snap: s, targetX, targetY });
    }

    // Pass 2: Apply cloned state & remap all internal cluster link IDs atomically
    const created = [];
    for (const { item, snap, targetX, targetY } of pairs) {
      const keepId = item.id;
      const keepLabel = snap.label || item.label;
      Object.assign(item, snap);
      item.id = keepId;
      item.label = keepLabel;
      item.x = targetX;
      item.y = targetY;
      item.isDragging = false;
      item.vy = 0;
      item.fallStartY = targetY;
      item.tiltAngle = 0;
      if (item.stickyLabel?.text) item.stickyLabel = { ...item.stickyLabel };

      for (const f of LINK_REF_FIELDS) {
        const ref = item[f];
        if (!ref) continue;
        if (idSet.has(ref) && idMap.has(ref)) {
          item[f] = idMap.get(ref);
        } else {
          delete item[f];
        }
      }
      created.push(item);
    }

    dstSim.updateSupportAttachments();
    dstSim.recomputeScaleReadings();
    dstSim.emitChange();
    return created;
  }

  /**
   * Store a bench apparatus/vessel (or its full connected assembly when opts.assembly === true)
   * into the physical Frozen Storage Shelf.
   */
  storeItemToCabinet(itemId, simOverride = null, opts = {}) {
    const sim = simOverride || this.getActiveWorkbenchLab()?.sim;
    if (!sim || !itemId) return null;
    const it = sim.getItem(itemId);
    if (!it) return null;

    const targetPageIdx = Number.isInteger(opts.pageIndex)
      ? Math.max(0, Math.min(this.storageLabs.length - 1, opts.pageIndex))
      : this.activeStorageIndex;
    const storagePage = this.storageLabs[targetPageIdx] || this.getActiveStorageLab();
    const dstSim = storagePage.sim;

    const idsToStore = opts.assembly ? collectConnectedAssemblyIds(sim, itemId) : [itemId];
    const srcItems = idsToStore.map((id) => sim.getItem(id)).filter(Boolean);
    if (srcItems.length === 0) return null;

    if (!opts.silentUndo) sim.recordUndo?.();
    const created = this._insertClusterSnapshots(srcItems, dstSim, {
      targetX: opts.targetX,
      targetY: opts.targetY,
      preserveCoords: Boolean(opts.preserveCoords),
    });
    if (created.length === 0) return null;
    for (const ci of created) ci._storedAt = Date.now();
    dstSim.selectedIds = new Set(created.map((c) => c.id));
    dstSim.selectedId = created[0].id;

    if (!opts.keepOnBench) {
      sim.withUndoSuppressed?.(() => {
        for (const id of idsToStore) {
          sim.removeApparatus(id);
        }
      });
    }
    this.hooks.onChange?.();
    return this._buildStorageEntryMeta(this._cloneItemSnapshot(created[0]), this.storageLabs.indexOf(storagePage));
  }

  storeAssemblyToCabinet(itemId, simOverride = null, opts = {}) {
    return this.storeItemToCabinet(itemId, simOverride, { ...opts, assembly: true });
  }

  _findItemAcrossStorage(entryId) {
    for (let p = 0; p < this.storageLabs.length; p++) {
      const pg = this.storageLabs[p];
      const it = pg?.sim?.getItem?.(entryId);
      if (it) return { pageIndex: p, page: pg, item: it };
    }
    return null;
  }

  withdrawFromCabinet(entryId, opts = {}) {
    this._lastWithdrawError = null;
    const found = this._findItemAcrossStorage(entryId);
    if (!found) return null;
    const { page: storagePage, item: srcItem } = found;
    const srcSim = storagePage.sim;

    const dstLab = opts.simOverride
      ? null
      : this.labs[Number.isInteger(opts.targetLabIndex) ? opts.targetLabIndex : this.activeIndex] || this.getActiveWorkbenchLab();
    const dstSim = opts.simOverride || dstLab?.sim;
    if (!dstSim) return null;

    // Security policy check: block external storage transfers into Exam / Shelf-Locked missions
    if (!opts.bypassLock && isLabLockedFromExternalStorage(dstLab || dstSim)) {
      this._lastWithdrawError = 'exam_locked';
      this.hooks.onExamTransferBlocked?.(storagePage, dstLab || dstSim);
      return null;
    }

    const idsToMove = opts.assembly ? collectConnectedAssemblyIds(srcSim, entryId) : [entryId];
    const srcCluster = idsToMove.map((id) => srcSim.getItem(id)).filter(Boolean);
    if (srcCluster.length === 0) return null;

    dstSim.recordUndo?.();
    const created = this._insertClusterSnapshots(srcCluster, dstSim, {
      targetX: opts.targetX,
      targetY: opts.targetY,
    });
    if (created.length === 0) return null;

    if (opts.mode !== 'clone') {
      srcSim.recordUndo?.();
      srcSim.withUndoSuppressed?.(() => {
        for (const id of idsToMove) {
          srcSim.removeApparatus(id);
        }
      });
    }
    dstSim.selectedIds = new Set(created.map((c) => c.id));
    dstSim.selectedId = created[0].id;
    dstSim.emitChange();
    this.hooks.onChange?.();
    return created[0];
  }

  removeFromCabinet(entryId) {
    const found = this._findItemAcrossStorage(entryId);
    if (!found) return false;
    found.page.sim.recordUndo?.();
    found.page.sim.removeApparatus(entryId);
    this.hooks.onChange?.();
    return true;
  }

  mergeStorageCabinet(entries = [], opts = {}) {
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    if (this.storageLabs.length === 0) {
      this.addStoragePage({ silent: true, keepActive: false });
    }
    let added = 0;

    // Group entries by explicit cabinetPageIndex if present (Build 32+), or pack legacy entries cleanly across 3 tiers
    const maxExistingPage = Math.max(0, ...entries.map((e) => (Number.isInteger(e?.cabinetPageIndex) ? e.cabinetPageIndex : 0)));
    while (this.storageLabs.length <= maxExistingPage) {
      this.addStoragePage({ silent: true, keepActive: true });
    }

    const byPage = new Map();
    for (const raw of entries) {
      if (!raw || !raw.snapshot?.typeId) continue;
      const pIdx = Number.isInteger(raw.cabinetPageIndex) && raw.cabinetPageIndex >= 0 ? raw.cabinetPageIndex : 0;
      if (!byPage.has(pIdx)) byPage.set(pIdx, []);
      byPage.get(pIdx).push(raw);
    }

    for (const [pIdx, list] of byPage.entries()) {
      const dstSim = (this.storageLabs[pIdx] || this.storageLabs[0]).sim;
      const withCoords = [];
      const legacyNoCoords = [];
      for (const raw of list) {
        const snap = this._cloneItemSnapshot(raw.snapshot);
        if (Number.isFinite(raw.x) && Number.isFinite(raw.y) && Number.isInteger(raw.cabinetPageIndex)) {
          snap.x = raw.x;
          snap.y = raw.y;
          withCoords.push(snap);
        } else {
          legacyNoCoords.push(snap);
        }
      }

      if (withCoords.length > 0) {
        const created = this._insertClusterSnapshots(withCoords, dstSim, { preserveCoords: true });
        added += created.length;
      }

      if (legacyNoCoords.length > 0) {
        // Place each legacy entry cleanly across open 3-tier shelf slots
        for (const snap of legacyNoCoords) {
          const created = this._insertClusterSnapshots([snap], dstSim, { preserveCoords: false });
          added += created.length;
        }
      }
    }

    if (added > 0 && !opts.silent) this.hooks.onChange?.();
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
    if (this.viewingStorage) {
      const sLab = this.getActiveStorageLab();
      sLab?.sim?.step(dt);
    }
    const active = this.labs[this.activeIndex];
    if (active) {
      active.sim.step(dt);
      if (!this.viewingStorage) {
        active.particles.update(dt * (active.sim.environment.paused ? 0 : active.sim.environment.speed));
      }
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
