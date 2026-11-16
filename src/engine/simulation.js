import { CONSTANTS } from '../data/constants.js';
import { SPECIES, STARTER_REAGENTS } from '../data/species.js';
import { APPARATUS } from '../data/apparatus.js';
import {
  computeContentsMassG,
  computeLiquidVolumeL,
  computePH,
  computePhenolphthaleinBleachEq,
  computeSolidVolumeMl,
  computeSolutionVisuals,
} from './equilibrium.js';
import { enforceDryPhaseBoundary, stepVesselChemistry } from './chemistry.js';
import { computeHeatCapacityJK, stepVesselThermodynamics } from './thermodynamics.js';
import {
  ALL_GASES,
  NON_STEAM_GASES,
  computeSyringeGasVolumeMl,
  stepVesselGasAndPressure,
} from './gasNetwork.js';

function createEmptyGasMap() {
  const obj = {};
  for (const g of ALL_GASES) obj[g] = 0;
  return obj;
}

export class LabSimulation {
  constructor() {
    this.timeSec = 0;
    this.nextId = 1;
    this.environment = {
      tempK: CONSTANTS.T_STD_K,     // 298.15 K
      pressureBar: CONSTANTS.P_STD_BAR, // 1.00 bar
      speed: 1.0,
      paused: false,
    };
    this.items = [];
    this.selectedId = null;
    this.logs = [];
    this.pipette = {
      capacityMl: 10.0,
      volumeMl: 0,
      moles: {},
      tempK: CONSTANTS.T_STD_K,
      sourceLabel: '',
    };
    this.activePourStream = null; // { fromX, fromY, toX, toY, color, timer }
    this.listeners = new Set();
    this.sampleAccum = 0;
    this.visualHooks = {
      onParticlesNeeded: null,
      onAlert: null,
    };
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emitChange() {
    for (const fn of this.listeners) fn(this);
  }

  addLog(entry) {
    this.logs.unshift({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timeSec: this.timeSec,
      ...entry,
    });
    if (this.logs.length > 60) this.logs.length = 60;
  }

  getItem(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  createApparatus(typeId, x = 280, y = 380) {
    const spec = APPARATUS[typeId];
    if (!spec) return null;
    const id = `${typeId}_${this.nextId++}`;
    const base = {
      id,
      typeId,
      kind: spec.kind,
      label: `#${this.nextId - 1}`,
      x,
      y,
      restingOnId: null,
    };

    if (spec.kind === 'vessel') {
      Object.assign(base, {
        moles: {},
        particleCounts: {},
        tempK: this.environment.tempK,
        internalPressureBar: this.environment.pressureBar,
        isStoppered: false,
        connectedSyringeId: null,
        sealedAirMoles: null,
        headspaceGasMoles: createEmptyGasMap(),
        escapedGasMoles: createEmptyGasMap(),
        isShattered: false,
        stirTimer: 0,
        tiltAngle: 0,
        activeReactions: [],
        seenReactions: {},
        history: [], // [{ t, moles: {...}, tempK, ph }]
        precipitateSettle: {}, // speciesId -> 0..1 settled fraction
        phenBleachFrac: 0, // 0..1 fraction converted to colorless carbinol In(OH)^3-
        naVisualPhase: Math.random() * 6.28,
        naPosRatio: 0.5,
        naVel: 0.9,
        wasBoiling: false,
      });
    } else if (spec.kind === 'scale') {
      Object.assign(base, {
        tareG: 0,
        measuredG: 0,
      });
    } else if (spec.kind === 'burner') {
      Object.assign(base, {
        flameLevel: 0, // 0=off, 1=low, 2=med, 3=high
      });
    } else if (spec.kind === 'gas_syringe') {
      Object.assign(base, {
        gasMoles: createEmptyGasMap(),
        connectedFromId: null,
        isBroken: false,
      });
    }

    this.items.push(base);
    this.selectedId = id;
    this.updateSupportAttachments();
    this.emitChange();
    return base;
  }

  removeApparatus(id) {
    const item = this.getItem(id);
    if (!item) return;
    // Clean up connections
    for (const other of this.items) {
      if (other.connectedSyringeId === id) {
        other.connectedSyringeId = null;
      }
      if (other.connectedFromId === id) {
        other.connectedFromId = null;
      }
      if (other.restingOnId === id) {
        other.restingOnId = null;
      }
    }
    this.items = this.items.filter((it) => it.id !== id);
    if (this.selectedId === id) {
      this.selectedId = this.items[0]?.id || null;
    }
    this.emitChange();
  }

  setupPreset(presetName) {
    this.items = [];
    this.logs = [];
    this.timeSec = 0;
    this.nextId = 1;

    if (presetName === 'gas_collect') {
      const flask = this.createApparatus('erlenmeyer_250', 300, 482 - APPARATUS.erlenmeyer_250.height / 2 + 2);
      const syringe = this.createApparatus('gas_syringe', 620, 345);
      const burner = this.createApparatus('burner', 140, 482 - APPARATUS.burner.height / 2 + 2);
      this.connectSyringe(flask.id, syringe.id);
      this.selectedId = flask.id;
    } else {
      // Default clean bench: Scale + ISO Beaker + Burner + ISO Erlenmeyer
      const scale = this.createApparatus('scale', 220, 482 - APPARATUS.scale.height / 2);
      const beaker = this.createApparatus('beaker_250', 220, 482 - APPARATUS.scale.height - APPARATUS.beaker_250.height / 2 + 2);
      const burner = this.createApparatus('burner', 560, 482 - APPARATUS.burner.height / 2 + 2);
      const flask = this.createApparatus('erlenmeyer_250', 760, 482 - APPARATUS.erlenmeyer_250.height / 2 + 2);
      this.updateSupportAttachments();
      this.selectedId = beaker.id;
    }
    this.emitChange();
  }

  /**
   * Automatically snap vessels onto scales or burners below them,
   * and align resting Y coordinates.
   */
  updateSupportAttachments() {
    for (const it of this.items) {
      if (it.kind !== 'vessel') continue;
      it.restingOnId = null;
      const spec = APPARATUS[it.typeId];
      const vesselBottom = it.y + spec.height / 2;

      for (const sup of this.items) {
        if (sup.kind !== 'scale' && sup.kind !== 'burner') continue;
        const supSpec = APPARATUS[sup.typeId];
        const dx = Math.abs(it.x - sup.x);
        const supTop = sup.y - supSpec.height / 2;

        if (sup.kind === 'scale' && dx < 72 && Math.abs(vesselBottom - supTop) < 56) {
          it.restingOnId = sup.id;
          it.x = sup.x;
          it.y = supTop - spec.height / 2 + 2;
          break;
        }
        if (sup.kind === 'burner' && spec.heatable && dx < 68 && Math.abs(vesselBottom - (supTop + 10)) < 64) {
          it.restingOnId = sup.id;
          it.x = sup.x;
          it.y = supTop + 10 - spec.height / 2;
          break;
        }
      }
    }
    this.recomputeScaleReadings();
  }

  recomputeScaleReadings() {
    for (const sc of this.items) {
      if (sc.kind !== 'scale') continue;
      let loadG = 0;
      for (const v of this.items) {
        if (v.kind === 'vessel' && v.restingOnId === sc.id) {
          const spec = APPARATUS[v.typeId];
          loadG += spec.tareMassG + computeContentsMassG(v.moles);
        }
      }
      sc.measuredG = loadG - sc.tareG;
    }
  }

  tareScale(scaleId) {
    const sc = this.getItem(scaleId);
    if (!sc || sc.kind !== 'scale') return;
    let rawG = 0;
    for (const v of this.items) {
      if (v.kind === 'vessel' && v.restingOnId === sc.id) {
        const spec = APPARATUS[v.typeId];
        rawG += spec.tareMassG + computeContentsMassG(v.moles);
      }
    }
    sc.tareG = rawG;
    this.recomputeScaleReadings();
    this.emitChange();
  }

  clearTare(scaleId) {
    const sc = this.getItem(scaleId);
    if (!sc || sc.kind !== 'scale') return;
    sc.tareG = 0;
    this.recomputeScaleReadings();
    this.emitChange();
  }

  setBurnerFlame(burnerId, level) {
    const b = this.getItem(burnerId);
    if (!b || b.kind !== 'burner') return;
    b.flameLevel = Math.max(0, Math.min(3, level));
    this.emitChange();
  }

  toggleStopper(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered) return false;
    const spec = APPARATUS[v.typeId];
    if (!spec.stopperable) return false;

    if (v.isStoppered) {
      v.isStoppered = false;
      this.disconnectSyringe(v.id);
      for (const g of ['H2_g', 'O2_g', 'H2O_g']) {
        v.escapedGasMoles[g] = (v.escapedGasMoles[g] || 0) + (v.headspaceGasMoles[g] || 0);
        v.headspaceGasMoles[g] = 0;
      }
      v.sealedAirMoles = null;
      v.internalPressureBar = this.environment.pressureBar;
    } else {
      v.isStoppered = true;
      v.sealedAirMoles = null;
    }
    this.emitChange();
    return true;
  }

  connectSyringe(vesselId, syringeId = null) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered) return { ok: false, reason: 'invalid' };
    const spec = APPARATUS[v.typeId];
    if (!spec.stopperable) return { ok: false, reason: 'not_stopperable' };

    let syr = syringeId ? this.getItem(syringeId) : null;
    if (!syr) {
      syr = this.items.find((it) => it.kind === 'gas_syringe' && !it.connectedFromId);
      if (!syr) syr = this.items.find((it) => it.kind === 'gas_syringe');
    }
    if (!syr) return { ok: false, reason: 'no_syringe' };

    // Disconnect old link on syringe if any
    if (syr.connectedFromId && syr.connectedFromId !== v.id) {
      const prev = this.getItem(syr.connectedFromId);
      if (prev) prev.connectedSyringeId = null;
    }

    v.isStoppered = true;
    v.connectedSyringeId = syr.id;
    syr.connectedFromId = v.id;
    // Vent sealed headspace equilibrium when opened into syringe
    for (const g of NON_STEAM_GASES) {
      if (v.headspaceGasMoles[g] > 0) {
        syr.gasMoles[g] = (syr.gasMoles[g] || 0) + v.headspaceGasMoles[g];
        v.headspaceGasMoles[g] = 0;
      }
    }
    v.internalPressureBar = this.environment.pressureBar;
    this.emitChange();
    return { ok: true };
  }

  disconnectSyringe(vesselId) {
    const v = this.getItem(vesselId);
    if (!v) return;
    if (v.connectedSyringeId) {
      const syr = this.getItem(v.connectedSyringeId);
      if (syr && syr.connectedFromId === v.id) {
        syr.connectedFromId = null;
      }
      v.connectedSyringeId = null;
    }
    this.emitChange();
  }

  ventSyringe(syringeId) {
    const syr = this.getItem(syringeId);
    if (!syr || syr.kind !== 'gas_syringe') return;
    syr.gasMoles = createEmptyGasMap();
    this.emitChange();
  }

  stirVessel(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel' || v.isShattered) return;
    v.stirTimer = 3.0;
    // Re-suspend precipitates when stirred
    for (const key of Object.keys(v.precipitateSettle)) {
      v.precipitateSettle[key] = Math.min(v.precipitateSettle[key], 0.15);
    }
    this.emitChange();
  }

  rinseVessel(vesselId) {
    const v = this.getItem(vesselId);
    if (!v || v.kind !== 'vessel') return;
    v.moles = {};
    v.particleCounts = {};
    v.tempK = this.environment.tempK;
    v.internalPressureBar = this.environment.pressureBar;
    v.isStoppered = false;
    this.disconnectSyringe(v.id);
    v.sealedAirMoles = null;
    v.headspaceGasMoles = createEmptyGasMap();
    v.escapedGasMoles = createEmptyGasMap();
    v.isShattered = false;
    v.activeReactions = [];
    v.seenReactions = {};
    v.history = [];
    v.precipitateSettle = {};
    v.phenBleachFrac = 0;
    v.wasBoiling = false;
    this.recomputeScaleReadings();
    this.emitChange();
  }

  /**
   * Add a pure reagent from the shelf into a vessel with exact mass (g) or volume (mL).
   */
  addReagentToVessel(vesselId, reagentId, amount, options = {}) {
    const v = this.getItem(vesselId);
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
    if (!v || v.kind !== 'vessel' || !reg || v.isShattered) return false;

    const amt = Math.max(0, Number(amount) || 0);
    if (amt <= 0) return false;

    // Thermal capacity before addition
    const cOld = computeHeatCapacityJK(v);
    const tOld = v.tempK;

    let addedHeatCap = 0;
    let dilutionHeatJ = 0;

    if (reg.kind === 'liquid') {
      const oldPhen = v.moles.Phenolphthalein_aq || 0;
      const oldBleach = v.phenBleachFrac || 0;
      // Check HCl heat of dilution before adding (diluting from ~12 M downwards is exothermic)
      if (reg.id === 'hcl_37') {
        const nH2OExisting = v.moles.H2O_l || 0;
        const nHAdded = reg.perMl.H_aq * amt;
        if (nH2OExisting > 0.05) {
          // Approx enthalpy of dilution from 37% (~3.5:1 H2O:HCl) toward dilute: up to ~18 kJ/mol HCl
          const dilutionExtent = Math.min(1, nH2OExisting / (nHAdded * 20 + 0.1));
          dilutionHeatJ += 17500 * nHAdded * dilutionExtent;
        }
      } else if (reg.id === 'h2o' && (v.moles.H_aq || 0) > 0.05) {
        const liqL = computeLiquidVolumeL(v.moles, v.tempK);
        const cH = (v.moles.H_aq || 0) / Math.max(1e-4, liqL);
        if (cH > 3.0) {
          dilutionHeatJ += Math.min(3500, 1200 * (cH - 3.0) * (amt / 50));
        }
      }

      for (const [spId, molPerMl] of Object.entries(reg.perMl)) {
        const addMol = molPerMl * amt;
        v.moles[spId] = (v.moles[spId] || 0) + addMol;
        const sp = SPECIES[spId];
        if (sp) addedHeatCap += addMol * Math.max(0, sp.cp || 0);
      }
      if (reg.perMl.Phenolphthalein_aq) {
        const newPhen = v.moles.Phenolphthalein_aq || 0;
        // Fresh indicator starts unbleached (In^2-) so dropping into conc. NaOH flashes pink first
        v.phenBleachFrac = newPhen > 1e-14 ? (oldPhen * oldBleach) / newPhen : 0;
      }
    } else if (reg.kind === 'solid') {
      const sp = SPECIES[reg.speciesId];
      const addMol = amt / sp.molarMass;
      v.moles[reg.speciesId] = (v.moles[reg.speciesId] || 0) + addMol;
      addedHeatCap += addMol * (sp.cp || 30);

      const particleCount = options.fine ? 30 : reg.id === 'na' ? 1 : 6;
      v.particleCounts[reg.speciesId] =
        (v.particleCounts[reg.speciesId] || 0) + particleCount;
    }

    // Mix thermal energy with reagent starting at ambient T_env
    const tAdd = this.environment.tempK;
    if (cOld + addedHeatCap > 0) {
      v.tempK = (cOld * tOld + addedHeatCap * tAdd + dilutionHeatJ) / (cOld + addedHeatCap);
    }

    this.checkOverflow(v);
    this.recomputeScaleReadings();
    this.recordHistorySnapshot(v, true);
    this.emitChange();
    return true;
  }

  /**
   * Pour solution from source vessel into target vessel.
   */
  pourBetweenVessels(sourceId, targetId, volumeMl, includePrecipitate = true) {
    const src = this.getItem(sourceId);
    const dst = this.getItem(targetId);
    if (!src || !dst || src.id === dst.id || src.isShattered || dst.isShattered) return 0;

    const srcLiqL = computeLiquidVolumeL(src.moles, src.tempK);
    const srcLiqMl = srcLiqL * 1000;
    if (srcLiqMl <= 0.01) return 0;

    const actualMl = Math.min(srcLiqMl, Math.max(0, volumeMl));
    const frac = Math.min(1, actualMl / srcLiqMl);
    if (frac <= 0) return 0;

    const cDstBefore = computeHeatCapacityJK(dst);
    const oldDstPhen = dst.moles.Phenolphthalein_aq || 0;
    const oldDstBleach = dst.phenBleachFrac || 0;
    let movedPhen = 0;
    let cMoved = 0;

    for (const [spId, n] of Object.entries(src.moles)) {
      if (n <= 0) continue;
      const sp = SPECIES[spId];
      if (!sp) continue;

      const isTransferable =
        sp.phase === 'l' ||
        sp.phase === 'aq' ||
        (includePrecipitate && sp.isPrecipitate && sp.id !== 'Cu_s' && sp.id !== 'Ag_s');

      if (!isTransferable) continue;

      const moveMol = n * frac;
      if (spId === 'Phenolphthalein_aq') movedPhen = moveMol;
      src.moles[spId] = n - moveMol;
      if (src.moles[spId] < 1e-13) delete src.moles[spId];
      dst.moles[spId] = (dst.moles[spId] || 0) + moveMol;
      cMoved += moveMol * Math.max(0, sp.cp || 0);

      if (sp.isPrecipitate) {
        dst.precipitateSettle[spId] = 0.05; // Newly poured precipitate swirls
      }
    }

    if (movedPhen > 0) {
      const totalPhen = oldDstPhen + movedPhen;
      dst.phenBleachFrac =
        totalPhen > 1e-14 ? (oldDstPhen * oldDstBleach + movedPhen * (src.phenBleachFrac || 0)) / totalPhen : 0;
    }

    if (cDstBefore + cMoved > 0) {
      dst.tempK = (cDstBefore * dst.tempK + cMoved * src.tempK) / (cDstBefore + cMoved);
    }

    // Trigger subtle pour stream visual
    const dstSpec = APPARATUS[dst.typeId];
    this.activePourStream = {
      fromX: src.x,
      fromY: src.y - 40,
      toX: dst.x,
      toY: dst.y - dstSpec.height * 0.25,
      color: computeSolutionVisuals(
        src.moles,
        srcLiqL,
        computePH(src.moles, srcLiqL, src.tempK),
        APPARATUS[src.typeId].opticalPathCm,
        src.phenBleachFrac
      ).css,
      timer: 0.25,
    };

    this.checkOverflow(dst);
    this.recomputeScaleReadings();
    this.emitChange();
    return actualMl;
  }

  /**
   * Pipette operations: draw from vessel or liquid reagent, dispense to vessel.
   */
  pipetteDrawFromVessel(vesselId, drawMl = 1.0) {
    const src = this.getItem(vesselId);
    if (!src || src.kind !== 'vessel' || src.isShattered) return 0;
    const availRoom = this.pipette.capacityMl - this.pipette.volumeMl;
    if (availRoom <= 0.01) return 0;

    const srcLiqMl = computeLiquidVolumeL(src.moles, src.tempK) * 1000;
    if (srcLiqMl <= 0.01) return 0;

    const actual = Math.min(availRoom, srcLiqMl, drawMl);
    const frac = actual / srcLiqMl;

    for (const [spId, n] of Object.entries(src.moles)) {
      const sp = SPECIES[spId];
      if (!sp || (sp.phase !== 'l' && sp.phase !== 'aq')) continue;
      const move = n * frac;
      src.moles[spId] = n - move;
      if (src.moles[spId] < 1e-13) delete src.moles[spId];
      this.pipette.moles[spId] = (this.pipette.moles[spId] || 0) + move;
    }
    this.pipette.volumeMl += actual;
    this.pipette.tempK = src.tempK;
    this.pipette.sourceLabel = `${APPARATUS[src.typeId].id} ${src.label}`;
    this.recomputeScaleReadings();
    this.emitChange();
    return actual;
  }

  pipetteDrawFromReagent(reagentId, drawMl = 2.0) {
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId && r.kind === 'liquid');
    if (!reg) return 0;
    const availRoom = this.pipette.capacityMl - this.pipette.volumeMl;
    const actual = Math.min(availRoom, drawMl);
    if (actual <= 0.01) return 0;

    for (const [spId, molPerMl] of Object.entries(reg.perMl)) {
      this.pipette.moles[spId] = (this.pipette.moles[spId] || 0) + molPerMl * actual;
    }
    this.pipette.volumeMl += actual;
    this.pipette.tempK = this.environment.tempK;
    this.pipette.sourceLabel = reg.formula;
    this.emitChange();
    return actual;
  }

  pipetteDispenseToVessel(vesselId, dropMl = 0.05) {
    const dst = this.getItem(vesselId);
    if (!dst || dst.kind !== 'vessel' || dst.isShattered) return 0;
    if (this.pipette.volumeMl <= 1e-5) return 0;

    const actual = Math.min(this.pipette.volumeMl, dropMl);
    const frac = actual / this.pipette.volumeMl;
    const cOld = computeHeatCapacityJK(dst);
    const oldDstPhen = dst.moles.Phenolphthalein_aq || 0;
    const oldDstBleach = dst.phenBleachFrac || 0;
    let movedPhen = 0;
    let cAdd = 0;

    for (const [spId, n] of Object.entries(this.pipette.moles)) {
      const move = n * frac;
      if (spId === 'Phenolphthalein_aq') movedPhen = move;
      this.pipette.moles[spId] = n - move;
      if (this.pipette.moles[spId] < 1e-14) delete this.pipette.moles[spId];
      dst.moles[spId] = (dst.moles[spId] || 0) + move;
      const sp = SPECIES[spId];
      if (sp) cAdd += move * Math.max(0, sp.cp || 0);
    }

    if (movedPhen > 0) {
      const totalPhen = oldDstPhen + movedPhen;
      dst.phenBleachFrac = totalPhen > 1e-14 ? (oldDstPhen * oldDstBleach) / totalPhen : 0;
    }

    if (cOld + cAdd > 0) {
      dst.tempK = (cOld * dst.tempK + cAdd * this.pipette.tempK) / (cOld + cAdd);
    }

    this.pipette.volumeMl = Math.max(0, this.pipette.volumeMl - actual);
    if (this.pipette.volumeMl < 1e-4) {
      this.pipette.volumeMl = 0;
      this.pipette.moles = {};
      this.pipette.sourceLabel = '';
    }

    this.checkOverflow(dst);
    this.recomputeScaleReadings();
    this.emitChange();
    return actual;
  }

  clearPipette() {
    this.pipette.volumeMl = 0;
    this.pipette.moles = {};
    this.pipette.sourceLabel = '';
    this.emitChange();
  }

  checkOverflow(vessel) {
    const spec = APPARATUS[vessel.typeId];
    const liqMl = computeLiquidVolumeL(vessel.moles, vessel.tempK) * 1000;
    const solMl = computeSolidVolumeMl(vessel.moles);
    const totalMl = liqMl + solMl;

    if (totalMl > spec.maxVolumeMl * 1.02 && liqMl > 0.1) {
      const targetLiqMl = Math.max(0, spec.maxVolumeMl - solMl);
      const keepFrac = Math.max(0, Math.min(1, targetLiqMl / liqMl));
      for (const [spId, n] of Object.entries(vessel.moles)) {
        const sp = SPECIES[spId];
        if (sp && (sp.phase === 'l' || sp.phase === 'aq')) {
          vessel.moles[spId] = n * keepFrac;
          if (vessel.moles[spId] < 1e-13) delete vessel.moles[spId];
        }
      }
      this.addLog({
        type: 'alert',
        key: 'alertOverflow',
        vesselLabel: `${spec.id} ${vessel.label}`,
      });
    }
  }

  recordHistorySnapshot(vessel, force = false) {
    const last = vessel.history[vessel.history.length - 1];
    if (!force && last && this.timeSec - last.t < 0.25) return;

    // Record key tracked species moles (mmol) for live chart
    const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
    const ph = computePH(vessel.moles, liqL, vessel.tempK);
    const snap = {};
    for (const [spId, n] of Object.entries(vessel.moles)) {
      if (n > 1e-7) snap[spId] = n;
    }
    // Track total permanent/acidic gases generated (escaped + syringe + headspace)
    const syr = vessel.connectedSyringeId ? this.getItem(vessel.connectedSyringeId) : null;
    for (const [gId, snapKey] of [
      ['H2_g', 'H2_g_total'],
      ['HCl_g', 'HCl_g_total'],
      ['Cl2_g', 'Cl2_g_total'],
    ]) {
      const tot =
        (vessel.escapedGasMoles[gId] || 0) +
        (vessel.headspaceGasMoles[gId] || 0) +
        (syr?.gasMoles[gId] || 0);
      if (tot > 1e-7) snap[snapKey] = tot;
    }

    vessel.history.push({
      t: this.timeSec,
      moles: snap,
      tempK: vessel.tempK,
      ph,
    });
    if (vessel.history.length > 140) {
      vessel.history.shift();
    }
  }

  /**
   * Shatter a vessel from overpressure or thermal/H2 explosion and spill all contents.
   */
  shatterVessel(vessel, logKey, alertKind) {
    const liqL = computeLiquidVolumeL(vessel.moles, vessel.tempK);
    const hadLiquid = liqL > 1e-6;
    const vis = hadLiquid
      ? computeSolutionVisuals(vessel.moles, liqL, computePH(vessel.moles, liqL, vessel.tempK))
      : null;
    const burstMeta = {
      hadLiquid,
      liquidColor: vis ? vis.css : null,
      liquidMl: liqL * 1000,
    };

    for (const [gId, n] of Object.entries(vessel.headspaceGasMoles || {})) {
      if (n > 0) {
        vessel.escapedGasMoles[gId] = (vessel.escapedGasMoles[gId] || 0) + n;
      }
    }

    vessel.isShattered = true;
    vessel.isStoppered = false;
    this.disconnectSyringe(vessel.id);
    vessel.moles = {};
    vessel.headspaceGasMoles = {};
    vessel.precipitateSettle = {};
    vessel.phenBleachFrac = 0;
    vessel.activeReactions = [];
    vessel.wasBoiling = false;
    vessel.internalPressureBar = this.environment.pressureBar;

    this.addLog({ type: 'alert', key: logKey, vesselLabel: vessel.label });
    this.recordHistorySnapshot(vessel, true);
    if (this.visualHooks.onAlert) {
      this.visualHooks.onAlert(alertKind, vessel, burstMeta);
    }
  }

  /**
   * Main simulation tick called by animation loop (realDeltaSec).
   */
  step(realDeltaSec) {
    if (this.environment.paused) return;

    const scaledDt = Math.min(0.25, realDeltaSec * this.environment.speed);
    this.timeSec += scaledDt;

    if (this.activePourStream) {
      this.activePourStream.timer -= realDeltaSec;
      if (this.activePourStream.timer <= 0) this.activePourStream = null;
    }

    // Sub-step for numerical accuracy & smooth fast ionic kinetics
    const numSteps = Math.max(1, Math.ceil(scaledDt / CONSTANTS.SUBSTEP_MAX_DT));
    const dt = scaledDt / numSteps;

    const getApp = (id) => this.getItem(id);

    for (const v of this.items) {
      if (v.kind !== 'vessel') continue;

      if (v.stirTimer > 0) {
        v.stirTimer = Math.max(0, v.stirTimer - realDeltaSec);
      }

      if (v.isShattered) {
        v.activeReactions = [];
        for (let s = 0; s < numSteps; s++) {
          stepVesselThermodynamics(v, dt, this.environment, 0, 0);
        }
        continue;
      }

      // Check burner power & flame level if resting on an active burner
      let burnerPowerW = 0;
      let burnerFlameLevel = 0;
      if (v.restingOnId) {
        const sup = this.getItem(v.restingOnId);
        if (sup && sup.kind === 'burner') {
          const bSpec = APPARATUS.burner;
          burnerFlameLevel = sup.flameLevel || 0;
          burnerPowerW = bSpec.powerLevelsW[burnerFlameLevel] || 0;
        }
      }

      let frameGasH2 = 0;
      let frameGasO2 = 0;
      let frameGasHCl = 0;
      let frameGasCl2 = 0;
      let frameSteam = 0;
      let frameBoiling = false;
      const frameActiveMap = new Map();

      for (let s = 0; s < numSteps; s++) {
        const chemRes = stepVesselChemistry(v, dt);
        const thermRes = stepVesselThermodynamics(
          v,
          dt,
          this.environment,
          chemRes.reactionHeatJ,
          burnerPowerW,
          burnerFlameLevel
        );
        const dryRes = enforceDryPhaseBoundary(v);

        const combinedGas = {
          H2_g: chemRes.gasProduced.H2_g || 0,
          O2_g: chemRes.gasProduced.O2_g || 0,
          HCl_g:
            (chemRes.gasProduced.HCl_g || 0) +
            (thermRes.hclProducedMol || 0) +
            (dryRes.gasProduced.HCl_g || 0),
          Cl2_g: chemRes.gasProduced.Cl2_g || 0,
          HNO3_g: (chemRes.gasProduced.HNO3_g || 0) + (dryRes.gasProduced.HNO3_g || 0),
          H2O_g: (chemRes.gasProduced.H2O_g || 0) + (dryRes.gasProduced.H2O_g || 0),
        };

        const gasEvents = stepVesselGasAndPressure(
          v,
          combinedGas,
          thermRes.steamProducedMol,
          this.environment,
          getApp
        );

        frameGasH2 += combinedGas.H2_g;
        frameGasO2 += combinedGas.O2_g;
        frameGasHCl += combinedGas.HCl_g;
        frameGasCl2 += combinedGas.Cl2_g;
        frameSteam += combinedGas.H2O_g + (thermRes.steamProducedMol || 0);
        if (thermRes.isBoiling) frameBoiling = true;

        for (const rxn of chemRes.activeReactions) {
          const prev = frameActiveMap.get(rxn.id);
          if (!prev) {
            frameActiveMap.set(rxn.id, { ...rxn });
          } else {
            prev.dXi += rxn.dXi;
            prev.rateMolS = rxn.rateMolS;
          }

          // Log first occurrence or re-trigger after pause
          const lastSeen = v.seenReactions[rxn.id] ?? -99;
          if (this.timeSec - lastSeen > 4.0) {
            this.addLog({
              type: 'reaction',
              equation: rxn.equation,
              nameVi: rxn.nameVi,
              nameEn: rxn.nameEn,
              descVi: rxn.descVi,
              descEn: rxn.descEn,
              vesselLabel: v.label,
            });
          }
          v.seenReactions[rxn.id] = this.timeSec;
        }

        for (const ev of gasEvents) {
          if (ev.type === 'stopper_pop') {
            this.addLog({ type: 'alert', key: 'alertOverpressurePop', vesselLabel: v.label });
            if (this.visualHooks.onAlert) this.visualHooks.onAlert('pop', v);
          } else if (ev.type === 'shatter') {
            this.shatterVessel(v, 'alertOverpressureShatter', 'shatter');
            break;
          }
        }
        if (v.isShattered) break;
      }

      if (v.isShattered) continue;

      // Advance reversible phenolphthalein carbinol fading / recovery kinetics
      if ((v.moles.Phenolphthalein_aq || 0) > 1e-12) {
        const liqL = computeLiquidVolumeL(v.moles, v.tempK);
        if (liqL > 1e-7) {
          const cOH = (v.moles.OH_aq || 0) / liqL;
          const cH = (v.moles.H_aq || 0) / liqL;
          const eqBleach = computePhenolphthaleinBleachEq(cOH);
          const curBleach = v.phenBleachFrac || 0;
          const tempFactor = Math.exp(Math.max(-1.5, Math.min(1.5, 0.025 * (v.tempK - CONSTANTS.T_STD_K))));
          const rate =
            curBleach < eqBleach
              ? 0.28 * Math.max(0.2, cOH) * tempFactor
              : (0.55 + Math.min(3.0, cH * 1.5)) * tempFactor;
          v.phenBleachFrac = eqBleach + (curBleach - eqBleach) * Math.exp(-rate * scaledDt);
        }
      } else {
        v.phenBleachFrac = 0;
      }

      v.activeReactions = Array.from(frameActiveMap.values());

      // Check runaway Sodium + H2 ignition / thermal shock explosion (large > ~3.5g Na reacting violently at high temp)
      const naReactionRate =
        (frameActiveMap.get('na_water')?.rateMolS || 0) +
        (frameActiveMap.get('na_acid')?.rateMolS || 0);
      if (
        !v.isShattered &&
        naReactionRate > 0.045 &&
        (v.moles.Na_s || 0) > 0.15 &&
        v.tempK >= 365.0
      ) {
        this.shatterVessel(v, 'alertNaExplosion', 'explosion');
        continue;
      }

      // Boiling alert
      if (frameBoiling && !v.wasBoiling) {
        this.addLog({ type: 'alert', key: 'alertBoiling', vesselLabel: v.label });
      }
      v.wasBoiling = frameBoiling;

      // Update precipitate settling & Sodium skitter physics for renderer
      for (const [spId, n] of Object.entries(v.moles)) {
        const sp = SPECIES[spId];
        if (sp && sp.isPrecipitate && n > 1e-8) {
          const prev = v.precipitateSettle[spId] ?? 0.0;
          // Precipitates settle downward gradually unless stirred or vigorously bubbling
          const agitation = v.stirTimer > 0 || frameGasH2 > 1e-5 ? -0.35 : 0.14;
          v.precipitateSettle[spId] = Math.max(0.05, Math.min(1.0, prev + agitation * realDeltaSec));
        }
      }
      for (const spId of Object.keys(v.precipitateSettle)) {
        if (!v.moles[spId] || v.moles[spId] < 1e-9) {
          delete v.precipitateSettle[spId];
        }
      }

      // Sodium motion on meniscus
      const naActive = frameActiveMap.has('na_water') || frameActiveMap.has('na_acid');
      if (naActive && (v.moles.Na_s || 0) > 1e-7) {
        v.naVisualPhase += realDeltaSec * 8.5;
        v.naPosRatio += v.naVel * realDeltaSec * (0.8 + Math.sin(v.naVisualPhase) * 0.6);
        if (v.naPosRatio > 0.84) {
          v.naPosRatio = 0.84;
          v.naVel = -Math.abs(v.naVel);
        } else if (v.naPosRatio < 0.16) {
          v.naPosRatio = 0.16;
          v.naVel = Math.abs(v.naVel);
        }
      }

      // Emit visual particle request
      if (this.visualHooks.onParticlesNeeded) {
        this.visualHooks.onParticlesNeeded(v, {
          gasRateH2: frameGasH2 / Math.max(1e-4, scaledDt),
          gasRateO2: frameGasO2 / Math.max(1e-4, scaledDt),
          gasRateHCl: frameGasHCl / Math.max(1e-4, scaledDt),
          gasRateCl2: frameGasCl2 / Math.max(1e-4, scaledDt),
          steamRate: frameSteam / Math.max(1e-4, scaledDt),
          isBoiling: frameBoiling,
          naActive,
          naRate:
            (frameActiveMap.get('na_water')?.rateMolS || 0) +
            (frameActiveMap.get('na_acid')?.rateMolS || 0),
        });
      }

      this.recordHistorySnapshot(v, false);
    }

    this.recomputeScaleReadings();
  }
}

export { computeSyringeGasVolumeMl };
