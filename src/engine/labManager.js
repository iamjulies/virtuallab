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
      sim,
      particles: new ParticleSystem(),
      unreadAlerts: 0,
      bgAccum: 0,
    };
    this._wireLabHooks(lab);
    sim.setupPreset(presetName);
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

  /**
   * Step active lab at frame rate and background labs in ~15 Hz batches for zero lag across up to 10 active labs.
   */
  stepAllLabs(dt, onBgAlertChange = null) {
    const active = this.labs[this.activeIndex];
    if (active) {
      active.sim.step(dt);
      active.particles.update(dt * (active.sim.environment.paused ? 0 : active.sim.environment.speed));
    }

    let bgNotified = false;
    for (let i = 0; i < this.labs.length; i++) {
      if (i === this.activeIndex) continue;
      const lab = this.labs[i];
      if (lab.sim.environment.paused) continue;
      const prevAlert = lab.unreadAlerts || 0;
      lab.bgAccum += dt;
      if (lab.bgAccum >= 0.066) {
        const batchDt = Math.min(0.25, lab.bgAccum);
        lab.bgAccum = 0;
        lab.sim.step(batchDt);
        if ((lab.unreadAlerts || 0) !== prevAlert) bgNotified = true;
      }
    }
    if (bgNotified) onBgAlertChange?.();
  }
}
