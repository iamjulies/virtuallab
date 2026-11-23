import { APPARATUS } from '../data/apparatus.js';
import { SPECIES } from '../data/species.js';

export const WORKSPACE_SCHEMA_VERSION = '1.0.0';
export const LOCAL_STORAGE_KEY = 'chemlab_workspace_autosave_v1';
export const LOCAL_SHARED_PREFIX = 'chemlab_shared_bench_';

export const VLAB_SCOPES = {
  SINGLE_BENCH: 'SINGLE_BENCH',
  STORAGE_CABINET: 'STORAGE_CABINET',
  FULL_LAB: 'FULL_LAB',
};

/**
 * Format timestamp strictly as <MM.DD.YYYY>-<hh.mm.ss> per Prompt 28 filename spec.
 */
export function formatVlabTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const yyyy = date.getFullYear();
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${mm}.${dd}.${yyyy}-${hh}.${mi}.${ss}`;
}

/**
 * Strip Vietnamese accents, remove forbidden OS path chars (/ \ : * ? " < > |),
 * collapse whitespace into hyphens `-`, and normalize lowercase slug.
 */
export function sanitizeVlabSlug(rawName = '', fallback = 'ban-thi-nghiem') {
  let s = String(rawName || '').trim();
  if (!s) return fallback;
  s = s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (m) => (m === 'đ' ? 'd' : 'D'))
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/[^\w\s.-]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return s || fallback;
}

export function buildVlabFilename(scope = VLAB_SCOPES.SINGLE_BENCH, customName = '', langCode = 'vi', date = new Date()) {
  const stamp = formatVlabTimestamp(date);
  if (scope === VLAB_SCOPES.STORAGE_CABINET) {
    const prefix = langCode === 'en' ? 'storagecabinet' : 'tutrudo';
    return `${prefix}-${stamp}.vlab`;
  }
  if (scope === VLAB_SCOPES.FULL_LAB) {
    return `fulllab-${stamp}.vlab`;
  }
  const slug = sanitizeVlabSlug(customName, langCode === 'en' ? 'lab-bench' : 'ban-thi-nghiem');
  return `${slug}-${stamp}.vlab`;
}

function stripUndefinedDeep(val) {
  if (val === undefined) return null;
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    return val.map((el) => (el === undefined ? null : stripUndefinedDeep(el)));
  }
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (v !== undefined && typeof v !== 'function') {
      out[k] = stripUndefinedDeep(v);
    }
  }
  return out;
}

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBnda-JlqVtVkzVkmlc_xcc3DzjQ_Umm2Q',
  authDomain: 'sos-app-1c5ff.firebaseapp.com',
  projectId: 'sos-app-1c5ff',
  storageBucket: 'sos-app-1c5ff.firebasestorage.app',
  messagingSenderId: '756789964813',
  appId: '1:756789964813:web:994a618d94fb55b2b9a544',
  measurementId: 'G-7QWZWF16F6',
};

// Transient/derived fields that MUST NOT be persisted in snapshots (recomputed by engine on load)
const TRANSIENT_ITEM_KEYS = new Set([
  'isDragging',
  'hoveredActionLabel',
  'history',
  'renderColor',
  'computedPh',
  'reactionRate',
  'lastBubbleMs',
  'squirtTimer',
  'manualSprayHold',
  'isSpraying',
  'fallStartY',
]);

function mapTypeIdToCanonicalType(typeId = '') {
  if (typeId.startsWith('beaker')) return 'BEAKER';
  if (typeId.startsWith('erlenmeyer')) return 'ERLENMEYER';
  if (typeId.startsWith('round_flask')) return 'ROUND_FLASK';
  if (typeId.startsWith('test_tube')) return 'TEST_TUBE';
  if (typeId.startsWith('gas_jar')) return 'GAS_JAR';
  if (typeId.startsWith('volumetric')) return 'VOLUMETRIC_FLASK';
  if (typeId.startsWith('grad_cylinder')) return 'GRADUATED_CYLINDER';
  if (typeId.startsWith('crucible')) return 'CRUCIBLE';
  if (typeId.startsWith('evap_dish')) return 'EVAPORATING_DISH';
  if (typeId.startsWith('watch_glass')) return 'WATCH_GLASS';
  if (typeId.startsWith('woulff')) return 'WOULFF_BOTTLE';
  if (typeId.startsWith('kipp')) return 'KIPP_APPARATUS';
  return String(typeId).toUpperCase();
}

function resolveVesselTypeId(canonicalType = 'BEAKER', maxCapacity = 250) {
  const t = String(canonicalType || '').toUpperCase();
  const cap = Number(maxCapacity) || 250;
  if (t.includes('ERLENMEYER')) return cap >= 600 ? 'erlenmeyer_1000' : cap <= 150 ? 'erlenmeyer_100' : 'erlenmeyer_250';
  if (t.includes('ROUND_FLASK')) return cap >= 600 ? 'round_flask_1000' : 'round_flask_250';
  if (t.includes('BEAKER')) return cap >= 600 ? 'beaker_1000' : cap <= 150 ? 'beaker_100' : 'beaker_250';
  if (t.includes('TEST_TUBE')) return 'test_tube';
  if (t.includes('GAS_JAR')) return 'gas_jar';
  if (t.includes('CRUCIBLE')) return 'crucible';
  if (t.includes('EVAP')) return 'evap_dish';
  if (t.includes('WATCH')) return 'watch_glass';
  if (t.includes('WOULFF')) return 'woulff_bottle';
  if (t.includes('KIPP')) return 'kipp_apparatus';
  if (APPARATUS[canonicalType]) return canonicalType;
  return 'beaker_250';
}

function splitSpeciesIdToCanonical(speciesId) {
  const sp = SPECIES[speciesId];
  const m = String(speciesId).match(/^(.*)_(s|l|g|aq)$/);
  if (m) {
    return {
      chemicalId: m[1],
      phase: m[2],
    };
  }
  return {
    chemicalId: speciesId,
    phase: sp?.phase || 'aq',
  };
}

function resolveCanonicalToSpeciesId(chemicalId, phase = 'aq') {
  if (!chemicalId) return null;
  if (SPECIES[chemicalId]) return chemicalId;
  const candidate = `${chemicalId}_${phase}`;
  if (SPECIES[candidate]) return candidate;
  for (const suffix of ['s', 'l', 'aq', 'g']) {
    if (SPECIES[`${chemicalId}_${suffix}`]) return `${chemicalId}_${suffix}`;
  }
  return chemicalId;
}

/**
 * Strip transient/derived fields from an item and round floating-point moles cleanly.
 */
export function sanitizePhysicalItem(item) {
  const clean = {};
  for (const [k, v] of Object.entries(item)) {
    if (TRANSIENT_ITEM_KEYS.has(k)) continue;
    if (typeof v === 'function') continue;
    if (k === 'moles' && v && typeof v === 'object') {
      const cleanMoles = {};
      for (const [spId, mol] of Object.entries(v)) {
        const num = Number(mol);
        if (Number.isFinite(num) && num > 1e-12) {
          cleanMoles[spId] = Number(num.toPrecision(10));
        }
      }
      clean.moles = cleanMoles;
    } else if (v !== undefined) {
      clean[k] = JSON.parse(JSON.stringify(v));
    }
  }
  clean.tiltAngle = 0;
  return clean;
}

/**
 * Serialize a single LabSimulation bench into a pure physical JSON object.
 * Includes both canonical `vessels` + `connections` (matching Prompt 27 spec)
 * and full `items` array for lossless restoration of all lab apparatus.
 */
export function serializeBench(sim, benchMeta = {}) {
  if (!sim) return null;
  const cleanItems = (sim.items || []).map((it) => sanitizePhysicalItem(it));

  // Build canonical vessels & connections array per Prompt 27 schema
  const burnerList = cleanItems.filter((it) => it.kind === 'burner' && it.active);
  const vessels = cleanItems
    .filter((it) => it.kind === 'vessel')
    .map((v) => {
      const spec = APPARATUS[v.typeId] || {};
      const isHeating = burnerList.some(
        (b) => Math.abs(b.x - v.x) < 62 && b.y > v.y && b.y - v.y < 185
      );
      const speciesList = [];
      for (const [spId, mol] of Object.entries(v.moles || {})) {
        if (mol <= 1e-11) continue;
        const { chemicalId, phase } = splitSpeciesIdToCanonical(spId);
        const entry = {
          chemicalId,
          phase,
          moles: Number(mol.toPrecision(8)),
        };
        if (phase === 's') {
          entry.particleSize = v.solidForm === 'granules' || v.solidForm === 'chunks' ? 0.5 : 1.0;
        }
        speciesList.push(entry);
      }
      return {
        id: v.id,
        typeId: v.typeId,
        type: mapTypeIdToCanonicalType(v.typeId),
        maxCapacity: v.capacityMl || spec.capacityMl || 250,
        position: { x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100 },
        temperatureK: Math.round((v.tempK ?? 298.15) * 100) / 100,
        pressureAtm: Math.round(((v.pressureBar ?? 1.01325) / 1.01325) * 1000) / 1000,
        hasStopper: Boolean(v.isStoppered),
        isInverted: Boolean(v.isInverted),
        isHeating,
        stickyLabel: v.stickyLabel ? { ...v.stickyLabel } : null,
        silverMirrorLevel: Math.round((v.silverMirrorLevel || 0) * 1000) / 1000,
        nh4clFrostLevel: Math.round((v.nh4clFrostLevel || 0) * 1000) / 1000,
        wallResidueMap: v.wallResidueMap ? { ...v.wallResidueMap } : {},
        species: speciesList,
      };
    });

  const connections = [];
  for (const it of cleanItems) {
    if ((it.kind === 'vessel' || it.kind === 'electrode') && it.gasTargetId) {
      connections.push({
        type: 'DELIVERY_TUBE',
        fromVesselId: it.id,
        toVesselId: it.gasTargetId,
      });
    } else if (it.kind === 'salt_bridge' && (it.vesselAId || it.vesselBId)) {
      connections.push({
        type: 'SALT_BRIDGE',
        fromVesselId: it.vesselAId || null,
        toVesselId: it.vesselBId || null,
      });
    } else if (it.kind === 'dc_power' && (it.posElectrodeId || it.negElectrodeId)) {
      connections.push({
        type: 'WIRE',
        fromVesselId: it.posElectrodeId || null,
        toVesselId: it.negElectrodeId || null,
      });
    }
  }

  return {
    id: benchMeta.id || 'lab_1',
    number: benchMeta.number || 1,
    customName: benchMeta.customName || '',
    timeSec: Math.round((sim.timeSec || 0) * 100) / 100,
    nextId: sim.nextId || 1,
    environment: { ...(sim.environment || {}) },
    vessels,
    connections,
    items: cleanItems,
  };
}

/**
 * Restore a single LabSimulation bench from serialized data.
 */
export function deserializeBench(sim, benchData) {
  if (!sim || !benchData) return false;
  sim.withUndoSuppressed(() => {
    sim.timeSec = Number(benchData.timeSec) || 0;
    if (benchData.environment && typeof benchData.environment === 'object') {
      sim.environment = {
        ...sim.environment,
        ...JSON.parse(JSON.stringify(benchData.environment)),
      };
    }

    if (Array.isArray(benchData.items) && benchData.items.length > 0) {
      sim.items = benchData.items.map((raw) => {
        const copy = sanitizePhysicalItem(raw);
        copy.isDragging = false;
        copy.tiltAngle = 0;
        copy.hoveredActionLabel = null;
        copy.history = [];
        return copy;
      });
      sim.nextId = Number(benchData.nextId) || sim.items.length + 10;

      // Sync any direct edits made to canonical `vessels` array onto matching vessel items
      if (Array.isArray(benchData.vessels)) {
        for (const vSpec of benchData.vessels) {
          const item = sim.items.find((it) => it.id === vSpec.id && it.kind === 'vessel');
          if (!item) continue;
          if (vSpec.position && Number.isFinite(vSpec.position.x) && Number.isFinite(vSpec.position.y)) {
            item.x = Number(vSpec.position.x);
            item.y = Number(vSpec.position.y);
          }
          if (Number.isFinite(vSpec.temperatureK)) item.tempK = Number(vSpec.temperatureK);
          if (Number.isFinite(vSpec.pressureAtm)) item.pressureBar = Number(vSpec.pressureAtm) * 1.01325;
          if (typeof vSpec.hasStopper === 'boolean') item.isStoppered = vSpec.hasStopper;
          if (typeof vSpec.isInverted === 'boolean') item.isInverted = vSpec.isInverted;
          if (vSpec.stickyLabel && typeof vSpec.stickyLabel === 'object' && vSpec.stickyLabel.text) {
            item.stickyLabel = { text: String(vSpec.stickyLabel.text).slice(0, 30), bgColor: vSpec.stickyLabel.bgColor || '#fef08a' };
          }
          if (Array.isArray(vSpec.species)) {
            const newMoles = {};
            for (const sp of vSpec.species) {
              const spId = resolveCanonicalToSpeciesId(sp.chemicalId, sp.phase);
              const mol = Number(sp.moles);
              if (spId && Number.isFinite(mol) && mol > 1e-12) {
                newMoles[spId] = (newMoles[spId] || 0) + mol;
              }
            }
            item.moles = newMoles;
          }
        }
      }
    } else if (Array.isArray(benchData.vessels)) {
      // Pure canonical schema import (vessels + connections without internal items array)
      sim.items = [];
      sim.nextId = 1;
      const idMap = new Map();
      for (const vSpec of benchData.vessels) {
        const typeId = vSpec.typeId || resolveVesselTypeId(vSpec.type, vSpec.maxCapacity);
        const x = Number(vSpec.position?.x) || 400;
        const y = Number(vSpec.position?.y) || 420;
        const created = sim.createApparatus(typeId, x, y);
        if (!created) continue;
        if (vSpec.id) {
          created.id = vSpec.id;
          idMap.set(vSpec.id, created.id);
        }
        if (Number.isFinite(vSpec.temperatureK)) created.tempK = Number(vSpec.temperatureK);
        if (Number.isFinite(vSpec.pressureAtm)) created.pressureBar = Number(vSpec.pressureAtm) * 1.01325;
        created.isStoppered = Boolean(vSpec.hasStopper);
        created.isInverted = Boolean(vSpec.isInverted);
        if (Number.isFinite(vSpec.silverMirrorLevel)) created.silverMirrorLevel = vSpec.silverMirrorLevel;
        if (Number.isFinite(vSpec.nh4clFrostLevel)) created.nh4clFrostLevel = vSpec.nh4clFrostLevel;
        if (vSpec.wallResidueMap && typeof vSpec.wallResidueMap === 'object') created.wallResidueMap = { ...vSpec.wallResidueMap };
        created.moles = {};
        for (const sp of vSpec.species || []) {
          const spId = resolveCanonicalToSpeciesId(sp.chemicalId, sp.phase);
          const mol = Number(sp.moles);
          if (spId && Number.isFinite(mol) && mol > 1e-12) {
            created.moles[spId] = (created.moles[spId] || 0) + mol;
          }
        }
        if (vSpec.isHeating) {
          const burner = sim.createApparatus('bunsen_burner', x, Math.min(545, y + 95));
          if (burner) burner.active = true;
        }
      }
      if (Array.isArray(benchData.connections)) {
        for (const conn of benchData.connections) {
          const fromId = idMap.get(conn.fromVesselId) || conn.fromVesselId;
          const toId = idMap.get(conn.toVesselId) || conn.toVesselId;
          const fromItem = sim.getItem(fromId);
          const toItem = sim.getItem(toId);
          if (conn.type === 'DELIVERY_TUBE' && fromItem && toItem) {
            fromItem.gasTargetId = toItem.id;
          } else if (conn.type === 'SALT_BRIDGE' && fromItem && toItem) {
            const sb = sim.createApparatus('salt_bridge', (fromItem.x + toItem.x) / 2, Math.min(fromItem.y, toItem.y) - 40);
            if (sb) {
              sb.vesselAId = fromItem.id;
              sb.vesselBId = toItem.id;
            }
          }
        }
      }
      sim.nextId = Math.max(sim.nextId, sim.items.length + 15);
    }

    sim.selectedId = null;
    sim.selectedIds = new Set();
    sim.activePourStream = null;
    sim.activeReagentTransfer = null;
    sim.timedTransfers = [];
    sim.updateSupportAttachments();
    sim.recomputeScaleReadings();
    sim.emitChange();
  });
  return true;
}

/**
 * Serialize either a full LabManager (all benches) or a single LabSimulation.
 */
export function serializeWorkspace(target) {
  if (!target) return null;

  // Support passing either LabManager or a single LabSimulation directly
  if (Array.isArray(target.labs)) {
    const benches = target.labs.map((lab) =>
      serializeBench(lab.sim, { id: lab.id, number: lab.number, customName: lab.customName || '' })
    );
    const activeBench = benches[target.activeIndex] || benches[0] || { vessels: [], connections: [], items: [] };
    const storageCabinet = Array.isArray(target.storageCabinet)
      ? stripUndefinedDeep(target.storageCabinet)
      : [];
    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      scope: VLAB_SCOPES.FULL_LAB,
      savedAt: Date.now(),
      activeBenchIndex: target.activeIndex || 0,
      nextLabNumber: target.nextLabNumber || benches.length + 1,
      // Top-level canonical fields for active bench compatibility with Prompt 27 schema
      vessels: activeBench.vessels,
      connections: activeBench.connections,
      benches,
      storageCabinet,
    };
  }

  // Single LabSimulation instance
  const singleBench = serializeBench(target, { id: 'lab_1', number: 1 });
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    scope: VLAB_SCOPES.FULL_LAB,
    savedAt: Date.now(),
    activeBenchIndex: 0,
    nextLabNumber: 2,
    vessels: singleBench.vessels,
    connections: singleBench.connections,
    benches: [singleBench],
    storageCabinet: [],
  };
}

/**
 * Deserialize workspace JSON into a LabManager or single LabSimulation.
 */
export function deserializeWorkspace(target, rawData) {
  if (!target || !rawData) return false;
  const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  if (!data || typeof data !== 'object') return false;

  // Determine benches list (either multi-bench `data.benches` or single-bench top-level `vessels`/`items`)
  const benchList =
    Array.isArray(data.benches) && data.benches.length > 0
      ? data.benches.slice(0, 10)
      : [data];

  // Top-level `vessels`/`connections` override on active bench if edited directly
  const activeIdx = Math.max(0, Math.min(benchList.length - 1, Number(data.activeBenchIndex) || 0));
  if (Array.isArray(data.vessels) && benchList[activeIdx] && data.benches) {
    benchList[activeIdx] = {
      ...benchList[activeIdx],
      vessels: data.vessels,
      connections: data.connections || benchList[activeIdx].connections || [],
    };
  }

  if (Array.isArray(target.labs)) {
    // Target is LabManager
    while (target.labs.length < benchList.length && target.labs.length < target.maxLabs) {
      target.addLab('empty', { silent: true, keepActive: true });
    }
    while (target.labs.length > benchList.length && target.labs.length > 1) {
      target.labs.pop();
    }
    for (let i = 0; i < benchList.length; i++) {
      const bData = benchList[i];
      const lab = target.labs[i];
      if (!lab) continue;
      lab.id = bData.id || `lab_${i + 1}`;
      lab.number = Number(bData.number) || i + 1;
      lab.customName = bData.customName ? String(bData.customName).trim() : '';
      lab.unreadAlerts = 0;
      deserializeBench(lab.sim, bData);
    }
    if (Array.isArray(data.storageCabinet)) {
      target.storageCabinet = JSON.parse(JSON.stringify(data.storageCabinet));
    }
    target.activeIndex = activeIdx;
    target.nextLabNumber =
      Number(data.nextLabNumber) ||
      Math.max(...target.labs.map((l) => l.number || 1), 0) + 1;
    target.hooks?.onChange?.();
    return true;
  }

  // Target is a single LabSimulation
  return deserializeBench(target, benchList[activeIdx] || benchList[0]);
}

// ============================================================================
// LAYER 1: Browser LocalStorage Auto-Save (Debounced + Periodic Active Sync)
// ============================================================================

export function saveToLocalStorage(labManager) {
  try {
    if (typeof localStorage === 'undefined') return false;
    const payload = serializeWorkspace(labManager);
    if (!payload) return false;
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn('[WorkspaceStorage] LocalStorage save failed:', err);
    return false;
  }
}

export function loadFromLocalStorage(labManager) {
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || (!Array.isArray(data.benches) && !Array.isArray(data.vessels) && !Array.isArray(data.items))) {
      return false;
    }
    return deserializeWorkspace(labManager, data);
  } catch (err) {
    console.warn('[WorkspaceStorage] LocalStorage restore failed:', err);
    return false;
  }
}

export function clearLocalStorageWorkspace() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  } catch {}
}

/**
 * Reset all lab benches back to a clean initial starter bench and clear LocalStorage auto-save.
 */
export function resetAllBenches(labManager) {
  clearLocalStorageWorkspace();
  if (!labManager) return false;
  if (Array.isArray(labManager.labs)) {
    while (labManager.labs.length > 1) {
      labManager.labs.pop();
    }
    const first = labManager.labs[0];
    if (first) {
      first.id = 'lab_1';
      first.number = 1;
      first.customName = '';
      first.unreadAlerts = 0;
      first.sim.setupPreset('starter');
      first.sim.undoStack = [];
    }
    labManager.activeIndex = 0;
    labManager.nextLabNumber = 2;
    labManager.hooks?.onChange?.();
    saveToLocalStorage(labManager);
    return true;
  }
  if (typeof labManager.setupPreset === 'function') {
    labManager.setupPreset('starter');
    return true;
  }
  return false;
}

// ============================================================================
// LAYER 2: Standardized Scoped File Export/Import (.vlab)
// ============================================================================

export function serializeActiveBench(target, customName = '') {
  if (!target) return null;
  const activeLab = Array.isArray(target.labs) ? target.getActiveLab() : { id: 'lab_1', number: 1, sim: target };
  const activeSim = activeLab?.sim || target;
  const resolvedName = customName || activeLab?.customName || '';
  const single = serializeBench(activeSim, {
    id: activeLab?.id || 'lab_1',
    number: activeLab?.number || 1,
    customName: resolvedName,
  });
  if (!single) return null;
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    scope: VLAB_SCOPES.SINGLE_BENCH,
    savedAt: Date.now(),
    benchNumber: single.number,
    customName: resolvedName,
    timeSec: single.timeSec,
    nextId: single.nextId,
    environment: single.environment,
    vessels: single.vessels,
    connections: single.connections,
    items: single.items,
  };
}

export function serializeStorageCabinet(labManager) {
  const entries = Array.isArray(labManager?.storageCabinet)
    ? stripUndefinedDeep(labManager.storageCabinet)
    : [];
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    scope: VLAB_SCOPES.STORAGE_CABINET,
    savedAt: Date.now(),
    storageCabinet: entries,
  };
}

export function serializeFullLab(labManager) {
  const payload = serializeWorkspace(labManager);
  if (!payload) return null;
  payload.scope = VLAB_SCOPES.FULL_LAB;
  return payload;
}

export function overwriteBenchAtIndex(target, benchIndex, rawData) {
  if (!target || !rawData || !Array.isArray(target.labs)) return null;
  const idx = Math.max(0, Math.min(target.labs.length - 1, Number(benchIndex) || 0));
  const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  const benchPayload = data.bench || data;
  const lab = target.labs[idx];
  if (!lab) return null;
  if (benchPayload.customName !== undefined) {
    lab.customName = String(benchPayload.customName || '').trim();
  }
  deserializeBench(lab.sim, benchPayload);
  lab.unreadAlerts = 0;
  target.activeIndex = idx;
  target.hooks?.onChange?.();
  saveToLocalStorage(target);
  return { ok: true, openedNewTab: false, overwrittenIndex: idx, labNumber: lab.number, benchIndex: idx, lab };
}

/**
 * Import a single-bench `.vlab` / `.json` payload by OPENING A NEW LAB BENCH TAB.
 * If 10/10 tabs are already open and opts.allowOverwriteChooser is true, returns `{ needsOverwriteChoice: true, data }`
 * so the UI can let the user pick which bench to overwrite or cancel cleanly.
 */
export function importBenchIntoNewTab(target, rawData, opts = {}) {
  if (!target || !rawData) return null;
  const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  if (!data || typeof data !== 'object') return null;

  let benchPayload = data.bench || data;
  if (Array.isArray(data.benches) && data.benches.length > 0) {
    const idx = Math.max(0, Math.min(data.benches.length - 1, Number(data.activeBenchIndex) || 0));
    benchPayload = {
      ...data.benches[idx],
      vessels: data.vessels || data.benches[idx].vessels,
      connections: data.connections || data.benches[idx].connections,
    };
  }

  if (!Array.isArray(benchPayload.items) && !Array.isArray(benchPayload.vessels)) {
    return null;
  }

  if (Array.isArray(target.labs)) {
    if (target.labs.length >= (target.maxLabs || 10)) {
      if (opts.allowOverwriteChooser) {
        return { ok: false, needsOverwriteChoice: true, scope: VLAB_SCOPES.SINGLE_BENCH, benchPayload };
      }
      const targetLab = target.getActiveLab();
      deserializeBench(targetLab.sim, benchPayload);
      if (benchPayload.customName) targetLab.customName = String(benchPayload.customName).trim();
      targetLab.unreadAlerts = 0;
      target.hooks?.onChange?.();
      saveToLocalStorage(target);
      return {
        ok: true,
        openedNewTab: false,
        labNumber: targetLab.number,
        benchIndex: target.labs.indexOf(targetLab),
        lab: targetLab,
      };
    }

    const added = target.addLab('clean', {
      silent: true,
      customName: benchPayload.customName ? String(benchPayload.customName).trim() : '',
    });
    const targetLab = added?.ok ? added.lab : target.getActiveLab();
    deserializeBench(targetLab.sim, benchPayload);
    if (benchPayload.customName) targetLab.customName = String(benchPayload.customName).trim();
    targetLab.unreadAlerts = 0;
    target.hooks?.onChange?.();
    saveToLocalStorage(target);
    return {
      ok: true,
      openedNewTab: Boolean(added?.ok),
      labNumber: targetLab.number,
      benchIndex: target.labs.indexOf(targetLab),
      lab: targetLab,
    };
  }

  const ok = deserializeBench(target, benchPayload);
  return ok ? { ok: true, openedNewTab: false, labNumber: 1, benchIndex: 0 } : null;
}

export function classifyVlabData(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.scope === VLAB_SCOPES.STORAGE_CABINET || (Array.isArray(data.storageCabinet) && !Array.isArray(data.benches) && !Array.isArray(data.items) && !Array.isArray(data.vessels))) {
    return VLAB_SCOPES.STORAGE_CABINET;
  }
  if (data.scope === VLAB_SCOPES.FULL_LAB || (Array.isArray(data.benches) && data.benches.length >= 1)) {
    return VLAB_SCOPES.FULL_LAB;
  }
  if (Array.isArray(data.items) || Array.isArray(data.vessels) || data.bench) {
    return VLAB_SCOPES.SINGLE_BENCH;
  }
  return null;
}

export function exportScopedVlabFile(scope, labManager, options = {}) {
  let payload = null;
  if (scope === VLAB_SCOPES.STORAGE_CABINET) {
    payload = serializeStorageCabinet(labManager);
  } else if (scope === VLAB_SCOPES.FULL_LAB) {
    payload = serializeFullLab(labManager);
  } else {
    payload = serializeActiveBench(labManager, options.customName || '');
  }
  if (!payload) return false;
  const jsonString = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const filename =
    options.exactFilename ||
    buildVlabFilename(scope, options.customName || payload.customName || '', options.langCode || 'vi');

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return filename;
}

export function exportWorkspaceToFile(labManager, customNameOrFilename = null, langCode = 'vi') {
  const isRawFile = typeof customNameOrFilename === 'string' && /\.vlab$/i.test(customNameOrFilename);
  return Boolean(
    exportScopedVlabFile(VLAB_SCOPES.SINGLE_BENCH, labManager, {
      customName: isRawFile ? '' : customNameOrFilename || '',
      exactFilename: isRawFile ? customNameOrFilename : null,
      langCode,
    })
  );
}

export function readVlabFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No file provided'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = String(e.target?.result || '');
        const data = JSON.parse(text);
        const scope = classifyVlabData(data);
        if (!scope) {
          reject(new Error('Invalid .vlab schema'));
          return;
        }
        resolve({ scope, data });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

export function importWorkspaceFromFile(file, labManager) {
  return readVlabFile(file).then(({ scope, data }) => {
    if (scope === VLAB_SCOPES.STORAGE_CABINET) {
      const added = labManager?.mergeStorageCabinet?.(data.storageCabinet || []) || 0;
      saveToLocalStorage(labManager);
      return { ok: true, scope, addedCount: added };
    }
    if (scope === VLAB_SCOPES.FULL_LAB) {
      const ok = deserializeWorkspace(labManager, data);
      if (!ok) throw new Error('Invalid FULL_LAB schema');
      saveToLocalStorage(labManager);
      return { ok: true, scope, benchCount: labManager.labs?.length || 1 };
    }
    const res = importBenchIntoNewTab(labManager, data);
    if (!res || !res.ok) throw new Error('Invalid SINGLE_BENCH schema');
    return { ...res, scope };
  });
}

// ============================================================================
// LAYER 3: Firebase Cloud Sync (Auth + Firestore + Classroom Share Code)
// ============================================================================

const FIREBASE_CDN_VERSION = '11.4.0';

class CloudSyncController {
  constructor() {
    this.sdkPromise = null;
    this.app = null;
    this.auth = null;
    this.db = null;
    this.modules = null;
    this.user = null;
    this.status = 'idle'; // 'idle' | 'loading' | 'ready' | 'offline' | 'error'
    this.lastCloudSaveMs = 0;
    this.dirtySinceCloudSave = false;
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch {}
    }
  }

  markDirty() {
    this.dirtySinceCloudSave = true;
  }

  async ensureFirebaseLoaded() {
    if (this.modules) return this.modules;
    if (this.sdkPromise) return this.sdkPromise;

    this.status = 'loading';
    this._notify();

    this.sdkPromise = (async () => {
      try {
        const base = `https://www.gstatic.com/firebasejs/${FIREBASE_CDN_VERSION}`;
        const [appMod, authMod, firestoreMod] = await Promise.all([
          import(`${base}/firebase-app.js`),
          import(`${base}/firebase-auth.js`),
          import(`${base}/firebase-firestore.js`),
        ]);
        this.app = appMod.getApps().length
          ? appMod.getApp()
          : appMod.initializeApp(FIREBASE_CONFIG);
        this.auth = authMod.getAuth(this.app);
        this.db = firestoreMod.getFirestore(this.app);
        this.modules = { ...appMod, ...authMod, ...firestoreMod };

        authMod.onAuthStateChanged(this.auth, (u) => {
          this.user = u || null;
          this.status = 'ready';
          this._notify();
        });
        if (typeof this.auth.authStateReady === 'function') {
          await this.auth.authStateReady();
          this.user = this.auth.currentUser || null;
        }

        this.status = 'ready';
        this._notify();
        return this.modules;
      } catch (err) {
        this.status = 'offline';
        this.sdkPromise = null;
        this._notify();
        throw err;
      }
    })();

    return this.sdkPromise;
  }

  async signInWithGoogle() {
    const mods = await this.ensureFirebaseLoaded();
    const provider = new mods.GoogleAuthProvider();
    const res = await mods.signInWithPopup(this.auth, provider);
    this.user = res.user;
    this._notify();
    return res.user;
  }

  async signInWithEmail(email, password, isRegister = false) {
    const mods = await this.ensureFirebaseLoaded();
    const cleanEmail = String(email || '').trim();
    const res = isRegister
      ? await mods.createUserWithEmailAndPassword(this.auth, cleanEmail, password)
      : await mods.signInWithEmailAndPassword(this.auth, cleanEmail, password);
    this.user = res.user;
    this._notify();
    return res.user;
  }

  async signOutUser() {
    if (!this.auth || !this.modules) return;
    await this.modules.signOut(this.auth);
    this.user = null;
    this._notify();
  }

  async saveWorkspaceToCloud(labManager) {
    const mods = await this.ensureFirebaseLoaded();
    if (!this.user) {
      throw new Error('AUTH_REQUIRED');
    }
    const payload = stripUndefinedDeep(serializeWorkspace(labManager));
    const docRef = mods.doc(this.db, 'users', this.user.uid, 'workspace', 'current');
    const cabRef = mods.doc(this.db, 'users', this.user.uid, 'storage_cabinet', 'current');
    try {
      await mods.setDoc(docRef, {
        ...payload,
        updatedByEmail: this.user.email || null,
        cloudSavedAt: Date.now(),
      });
      await mods.setDoc(cabRef, stripUndefinedDeep({
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        items: payload.storageCabinet || [],
        updatedAt: Date.now(),
      }));
    } catch (err) {
      if (err?.code === 'permission-denied' || String(err?.message || '').toLowerCase().includes('insufficient permissions')) {
        const permErr = new Error('CLOUD_PERMISSION_DENIED');
        permErr.code = 'permission-denied';
        permErr.original = err;
        throw permErr;
      }
      throw err;
    }
    this.lastCloudSaveMs = Date.now();
    this.dirtySinceCloudSave = false;
    this._notify();
    return payload;
  }

  async loadWorkspaceFromCloud(labManager) {
    const mods = await this.ensureFirebaseLoaded();
    if (!this.user) {
      throw new Error('AUTH_REQUIRED');
    }
    const docRef = mods.doc(this.db, 'users', this.user.uid, 'workspace', 'current');
    const cabRef = mods.doc(this.db, 'users', this.user.uid, 'storage_cabinet', 'current');
    let snap;
    try {
      snap = await mods.getDoc(docRef);
    } catch (err) {
      if (err?.code === 'permission-denied' || String(err?.message || '').toLowerCase().includes('insufficient permissions')) {
        const permErr = new Error('CLOUD_PERMISSION_DENIED');
        permErr.code = 'permission-denied';
        permErr.original = err;
        throw permErr;
      }
      throw err;
    }
    if (!snap.exists()) {
      throw new Error('NO_CLOUD_WORKSPACE');
    }
    const data = snap.data();
    try {
      const cabSnap = await mods.getDoc(cabRef);
      if (cabSnap.exists() && Array.isArray(cabSnap.data()?.items) && (!Array.isArray(data.storageCabinet) || data.storageCabinet.length === 0)) {
        data.storageCabinet = cabSnap.data().items;
      }
    } catch {}
    const ok = deserializeWorkspace(labManager, data);
    if (ok) {
      saveToLocalStorage(labManager);
      this.dirtySinceCloudSave = false;
      this._notify();
    }
    return data;
  }

  /**
   * Generate a 6-character classroom Share Code (e.g., LAB-842) for the current active bench.
   * Saves to Firestore `shared_benches/{code}` when signed in & online, and always caches locally.
   */
  async createBenchShareCode(labManager) {
    const activeSim = labManager?.getActiveSim ? labManager.getActiveSim() : labManager;
    const activeLab = labManager?.getActiveLab ? labManager.getActiveLab() : { id: 'lab_1', number: 1 };
    const benchPayload = stripUndefinedDeep(
      serializeBench(activeSim, {
        id: activeLab.id,
        number: activeLab.number,
        customName: activeLab.customName || '',
      })
    );
    const digits = String(Math.floor(100 + Math.random() * 900));
    const shareCode = `LAB-${digits}`;
    const record = stripUndefinedDeep({
      shareCode,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      createdAt: Date.now(),
      createdBy: this.user?.email || 'anonymous',
      createdByUid: this.user?.uid || 'local',
      bench: benchPayload,
    });

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${LOCAL_SHARED_PREFIX}${shareCode}`, JSON.stringify(record));
      }
    } catch {}

    // Sync to Firestore if signed in (required by Firestore owner rules)
    if (this.user?.uid) {
      try {
        const mods = this.modules || (await this.ensureFirebaseLoaded());
        const docRef = mods.doc(this.db, 'shared_benches', shareCode);
        await mods.setDoc(docRef, record);
      } catch (err) {
        console.warn('[CloudSync] Shared bench Firestore write skipped/denied:', err?.message || err);
      }
    }

    return shareCode;
  }

  /**
   * Load a shared bench by its code (e.g., `LAB-842` or `842`) into the active bench.
   */
  async loadBenchByShareCode(rawCode, labManager) {
    const normalized = String(rawCode || '')
      .trim()
      .toUpperCase();
    const shareCode = normalized.startsWith('LAB-') ? normalized : `LAB-${normalized}`;
    let record = null;

    // 1. Check instant local share cache first
    if (typeof localStorage !== 'undefined') {
      const rawLocal = localStorage.getItem(`${LOCAL_SHARED_PREFIX}${shareCode}`);
      if (rawLocal) {
        try {
          record = JSON.parse(rawLocal);
        } catch {}
      }
    }

    // 2. Query Firestore if not found locally
    if (!record) {
      try {
        const mods = await this.ensureFirebaseLoaded();
        const docRef = mods.doc(this.db, 'shared_benches', shareCode);
        const snap = await mods.getDoc(docRef);
        if (snap.exists()) {
          record = snap.data();
        }
      } catch {}
    }

    if (!record || !record.bench) {
      throw new Error('SHARE_CODE_NOT_FOUND');
    }

    const res = importBenchIntoNewTab(labManager, record.bench);
    return { shareCode, record, importResult: res };
  }
}

export const cloudSync = new CloudSyncController();

/**
 * Attach automatic Layer-1 debounced LocalStorage persistence + periodic active-reaction saving
 * + Layer-3 cloud dirty tracking on bench switch.
 */
export function initWorkspacePersistence(labManager, options = {}) {
  let debounceTimer = null;
  let idleHandle = 0;

  const cancelScheduled = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (idleHandle && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(idleHandle);
      idleHandle = 0;
    }
  };

  const runSave = () => {
    if (options.shouldDefer?.()) {
      debounceTimer = setTimeout(scheduleIdleSave, 250);
      return;
    }
    saveToLocalStorage(labManager);
    options.onAutoSaved?.(Date.now());
  };

  const scheduleIdleSave = () => {
    debounceTimer = null;
    if (options.shouldDefer?.()) {
      debounceTimer = setTimeout(scheduleIdleSave, 250);
      return;
    }
    if (typeof requestIdleCallback === 'function') {
      idleHandle = requestIdleCallback(() => {
        idleHandle = 0;
        runSave();
      }, { timeout: 1200 });
    } else {
      runSave();
    }
  };

  const triggerDebouncedSave = () => {
    cloudSync.markDirty();
    cancelScheduled();
    debounceTimer = setTimeout(scheduleIdleSave, 600);
  };

  // Periodic 5-second save when any burner, power supply, or reaction is actively running
  const periodicInterval = setInterval(() => {
    if (!labManager || !Array.isArray(labManager.labs)) return;
    if (options.shouldDefer?.()) return;
    const hasActiveProcess = labManager.labs.some((lab) =>
      lab.sim.items.some(
        (it) =>
          (it.kind === 'burner' && it.active) ||
          (it.kind === 'power_supply' && it.active) ||
          (it.kind === 'vessel' && Math.abs((it.tempK || 298.15) - (lab.sim.environment?.tempK || 298.15)) > 1.5)
      )
    );
    if (hasActiveProcess) {
      saveToLocalStorage(labManager);
      options.onAutoSaved?.(Date.now());
    }
  }, 5000);

  return {
    triggerDebouncedSave,
    dispose() {
      cancelScheduled();
      clearInterval(periodicInterval);
    },
  };
}
