import { APPARATUS } from '../data/apparatus.js';
import { CONSTANTS, waterBoilingPointK } from '../data/constants.js';
import { computeLiquidVolumeL, computeSolidVolumeMl } from '../engine/equilibrium.js';

const STORAGE_SOUND_KEY = 'virlab_sound_enabled';

/**
 * Real-time Physical & Procedural Web Audio Synthesizer for ChemLab Studio.
 * Zero external MP3/WAV dependencies — works 100% offline in PWA / GitHub Pages.
 * Synthesizes:
 *  - Continuous physics-modulated loops: liquid pouring (pitch rises with vessel fill level),
 *    gas effervescence (stochastic Minnaert bubble pops), rolling boil + steam hiss,
 *    Bunsen yellow vs roaring blue Venturi flame, Sodium skittering fizz, wash-bottle spray,
 *    magnetic stirrer motor whirl, and DC electrolysis hum.
 *  - Discrete interaction & chemical alert sounds: Borosilicate/porcelain/metal modal clinks,
 *    single droplet plink, crystal granule cascade, glass rod stir swirl, mortar grinding crunch,
 *    water rinse flush, rubber stopper pop/thunk, silicone tubing snap, retort clamp latch,
 *    analytical scale tare beep, H2 test-tube squeaky-pop, O2 flare-up, glass shatter & Na blast.
 */
export class LabSoundEngine {
  constructor() {
    let saved = true;
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_SOUND_KEY) : null;
      if (raw !== null) saved = raw !== 'false' && raw !== '0';
    } catch {}
    this.enabled = saved;
    this.masterVolume = 0.65;
    this.ctx = null;
    this.masterGain = null;
    this.noiseBuffer = null;
    this.loops = null;
    this._unlocked = false;
    this._bubbleAccum = 0;
    this._buretteDropAccum = 0;
    this._prevBurnerPower = new Map();
    this._prevStoppered = new Map();
    this.lastPlayedEvent = null;
    this.eventHistory = [];
    this.activeChannels = {
      flame: 0,
      pour: 0,
      boil: 0,
      bubbleRate: 0,
      naFizz: 0,
      stirHum: 0,
    };

    if (typeof window !== 'undefined') {
      const unlock = () => this.unlock();
      window.addEventListener('pointerdown', unlock, { passive: true });
      window.addEventListener('keydown', unlock, { passive: true });
    }
  }

  _recordEvent(name, meta = {}) {
    this.lastPlayedEvent = { name, timeMs: Date.now(), ...meta };
    this.eventHistory.push(this.lastPlayedEvent);
    if (this.eventHistory.length > 40) this.eventHistory.shift();
  }

  isEnabled() {
    return Boolean(this.enabled);
  }

  setEnabled(flag) {
    this.enabled = Boolean(flag);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_SOUND_KEY, this.enabled ? 'true' : 'false');
      }
    } catch {}
    if (this.enabled) {
      this.unlock();
      this.playUiClick();
    } else if (this.masterGain && this.ctx) {
      try {
        this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      } catch {}
    }
    return this.enabled;
  }

  toggleEnabled() {
    return this.setEnabled(!this.enabled);
  }

  unlock() {
    if (!this.enabled) return false;
    if (typeof window === 'undefined') return false;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    try {
      if (!this.ctx) {
        this.ctx = new AudioCtx();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.masterVolume;
        this.masterGain.connect(this.ctx.destination);
        this._buildNoiseBuffer();
        this._initContinuousLoops();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      if (this.masterGain) {
        this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.03);
      }
      this._unlocked = true;
      return true;
    } catch {
      return false;
    }
  }

  _buildNoiseBuffer() {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate || 44100;
    const len = sr * 2;
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      // Paul Kellet pink-white hybrid noise for natural fluid/flame texture
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
      b6 = white * 0.115926;
      data[i] = Math.max(-1, Math.min(1, pink * 0.65 + white * 0.35));
    }
    this.noiseBuffer = buf;
  }

  _createLoopingNoiseNode() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.start(0);
    return src;
  }

  _initContinuousLoops() {
    if (!this.ctx || !this.noiseBuffer || this.loops) return;
    const now = this.ctx.currentTime;

    // 1. Burner Flame Loop (low rumble + high Venturi jet hiss for blue flame)
    const flameSrc = this._createLoopingNoiseNode();
    const flameLowFilter = this.ctx.createBiquadFilter();
    flameLowFilter.type = 'bandpass';
    flameLowFilter.frequency.setValueAtTime(185, now);
    flameLowFilter.Q.setValueAtTime(1.8, now);

    const flameJetFilter = this.ctx.createBiquadFilter();
    flameJetFilter.type = 'bandpass';
    flameJetFilter.frequency.setValueAtTime(1180, now);
    flameJetFilter.Q.setValueAtTime(2.4, now);

    const flameLowGain = this.ctx.createGain();
    flameLowGain.gain.setValueAtTime(0, now);
    const flameJetGain = this.ctx.createGain();
    flameJetGain.gain.setValueAtTime(0, now);

    flameSrc.connect(flameLowFilter);
    flameLowFilter.connect(flameLowGain);
    flameLowGain.connect(this.masterGain);

    flameSrc.connect(flameJetFilter);
    flameJetFilter.connect(flameJetGain);
    flameJetGain.connect(this.masterGain);

    // 2. Pouring / Spray Stream Loop (pitch-tracking resonant cavity bandpass)
    const pourSrc = this._createLoopingNoiseNode();
    const pourFilter = this.ctx.createBiquadFilter();
    pourFilter.type = 'bandpass';
    pourFilter.frequency.setValueAtTime(480, now);
    pourFilter.Q.setValueAtTime(3.2, now);
    const pourGain = this.ctx.createGain();
    pourGain.gain.setValueAtTime(0, now);
    pourSrc.connect(pourFilter);
    pourFilter.connect(pourGain);
    pourGain.connect(this.masterGain);

    // 3. Boiling & Steam Hiss Loop
    const boilSrc = this._createLoopingNoiseNode();
    const boilFilter = this.ctx.createBiquadFilter();
    boilFilter.type = 'lowpass';
    boilFilter.frequency.setValueAtTime(310, now);
    const boilGain = this.ctx.createGain();
    boilGain.gain.setValueAtTime(0, now);
    boilSrc.connect(boilFilter);
    boilFilter.connect(boilGain);
    boilGain.connect(this.masterGain);

    // 4. Sodium Skittering Sizzle Loop
    const fizzSrc = this._createLoopingNoiseNode();
    const fizzFilter = this.ctx.createBiquadFilter();
    fizzFilter.type = 'bandpass';
    fizzFilter.frequency.setValueAtTime(2950, now);
    fizzFilter.Q.setValueAtTime(1.6, now);
    const fizzGain = this.ctx.createGain();
    fizzGain.gain.setValueAtTime(0, now);
    fizzSrc.connect(fizzFilter);
    fizzFilter.connect(fizzGain);
    fizzGain.connect(this.masterGain);

    // 5. Magnetic Stirrer / Electrolysis Motor Hum
    const humOsc = this.ctx.createOscillator();
    humOsc.type = 'triangle';
    humOsc.frequency.setValueAtTime(120, now);
    const humFilter = this.ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.setValueAtTime(260, now);
    const humGain = this.ctx.createGain();
    humGain.gain.setValueAtTime(0, now);
    humOsc.connect(humFilter);
    humFilter.connect(humGain);
    humGain.connect(this.masterGain);
    humOsc.start(0);

    this.loops = {
      flameLowFilter,
      flameJetFilter,
      flameLowGain,
      flameJetGain,
      pourFilter,
      pourGain,
      boilFilter,
      boilGain,
      fizzFilter,
      fizzGain,
      humOsc,
      humGain,
    };
  }

  _ready() {
    if (!this.enabled) return false;
    if (!this.ctx) this.unlock();
    return Boolean(this.ctx && this.masterGain);
  }

  // =========================================================
  // DISCRETE ONE-SHOT SOUND EFFECTS
  // =========================================================

  /**
   * Modal glassware / ceramic / metal clink when picking up, placing, or colliding apparatus.
   */
  playGlassClink(typeId = 'beaker_250', intensity = 0.85) {
    this._recordEvent('glass_clink', { typeId, intensity });
    if (!this._ready()) return;
    const spec = APPARATUS[typeId];
    const now = this.ctx.currentTime;
    const vol = Math.max(0.05, Math.min(1.0, intensity)) * 0.22;

    const isPorcelain =
      typeId === 'crucible_porcelain' || typeId === 'porcelain_dish' || typeId === 'mortar_pestle';
    const isMetal =
      spec?.kind === 'stand' ||
      spec?.kind === 'burner' ||
      spec?.kind === 'tongs' ||
      spec?.kind === 'spoon' ||
      spec?.kind === 'scale';
    const isLarge = (spec?.maxVolumeMl || 250) >= 900;
    const isSmall = (spec?.maxVolumeMl || 250) <= 60 || spec?.kind === 'pipette' || spec?.kind === 'rubber_stopper';

    const modes = isPorcelain
      ? [690, 1280, 2140]
      : isMetal
      ? [540, 1620, 3480]
      : isLarge
      ? [960, 1840, 3050]
      : isSmall
      ? [1920, 3540, 5120]
      : [1420, 2740, 4260];
    const decay = isPorcelain ? 0.065 : isMetal ? 0.09 : isLarge ? 0.16 : 0.11;

    modes.forEach((baseF, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = idx === 0 ? 'sine' : 'triangle';
      const jitter = 1 + (Math.random() - 0.5) * 0.03;
      osc.frequency.setValueAtTime(baseF * jitter, now);
      const amp = vol * (idx === 0 ? 1.0 : idx === 1 ? 0.45 : 0.22);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(amp, now + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + decay * (1 - idx * 0.2));
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + decay + 0.02);
    });
  }

  /**
   * Single liquid droplet plink (pipette drop, burette drip, or Minnaert gas bubble pop).
   */
  playDropPlink(pitchScale = 1.0, volumeScale = 1.0) {
    this._recordEvent('drop_plink', { pitchScale });
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const fStart = (620 + Math.random() * 140) * pitchScale;
    const fEnd = fStart * (1.75 + Math.random() * 0.2);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fStart, now);
    osc.frequency.exponentialRampToValueAtTime(fEnd, now + 0.042);

    const peak = 0.14 * Math.max(0.1, Math.min(1.5, volumeScale));
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.048);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.055);
  }

  /**
   * Granular solid crystals / pellets / powder cascade into a glass vessel.
   */
  playGranuleCascade(count = 7) {
    this._recordEvent('granule_cascade', { count });
    if (!this._ready()) return;
    const baseNow = this.ctx.currentTime;
    const n = Math.max(3, Math.min(14, count));
    for (let i = 0; i < n; i++) {
      const t0 = baseNow + i * (0.024 + Math.random() * 0.018);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1850 + Math.random() * 2100, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(0.065, t0 + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.022);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.026);
    }
  }

  /**
   * Glass stirring rod swirl: 3 quick glass chimes + soft water swish.
   */
  playStirSwirl() {
    this._recordEvent('stir_swirl');
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    [0, 0.085, 0.175].forEach((offset, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1620 + i * 190, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.linearRampToValueAtTime(0.11, now + offset + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.065);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now + offset);
      osc.stop(now + offset + 0.075);
    });
    this._playFilteredNoiseBurst(0.26, 480, 780, 1.8, 0.12);
  }

  /**
   * Mortar & Pestle porcelain grinding crunch.
   */
  playMortarGrind() {
    this._recordEvent('mortar_grind');
    if (!this._ready() || !this.noiseBuffer) return;
    [0, 0.11, 0.22, 0.33].forEach((offset, idx) => {
      const start = this.ctx.currentTime + offset;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(920 + (idx % 2) * 340, start);
      filter.Q.setValueAtTime(2.6, start);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.095);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      src.start(start);
      src.stop(start + 0.105);
    });
  }

  /**
   * Rinsing & emptying a vessel with distilled water.
   */
  playWaterRinse() {
    this._recordEvent('water_rinse');
    if (!this._ready()) return;
    this._playFilteredNoiseBurst(0.38, 920, 340, 2.0, 0.20);
  }

  /**
   * Rubber stopper insert thunk or unplug hollow cork pop.
   */
  playStopperPop(isOpen = true) {
    this._recordEvent('stopper_pop_action', { isOpen });
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    if (isOpen) {
      osc.frequency.setValueAtTime(210, now);
      osc.frequency.exponentialRampToValueAtTime(610, now + 0.055);
    } else {
      osc.frequency.setValueAtTime(380, now);
      osc.frequency.exponentialRampToValueAtTime(145, now + 0.055);
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.24, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.068);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.075);
  }

  /**
   * Silicone tubing connect / disconnect slip-snap.
   */
  playTubeSnap(connect = true) {
    this._recordEvent('tube_snap', { connect });
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(connect ? 420 : 760, now);
    osc.frequency.exponentialRampToValueAtTime(connect ? 820 : 360, now + 0.04);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.14, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.046);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.052);
  }

  /**
   * Retort stand clamp metallic latch click.
   */
  playClampClick() {
    this._recordEvent('clamp_click');
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    [1180, 2760].forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, now + idx * 0.014);
      gain.gain.setValueAtTime(0.0001, now + idx * 0.014);
      gain.gain.linearRampToValueAtTime(0.075, now + idx * 0.014 + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.014 + 0.025);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now + idx * 0.014);
      osc.stop(now + idx * 0.014 + 0.03);
    });
  }

  /**
   * Analytical digital scale Tare piezo beep.
   */
  playTareBeep() {
    this._recordEvent('tare_beep');
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2680, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.082);
  }

  /**
   * Gas burner ignition or collar mode switch whoosh.
   */
  playFlameWhoosh(isBlue = false) {
    this._recordEvent('flame_whoosh', { isBlue });
    if (!this._ready()) return;
    this._playFilteredNoiseBurst(0.24, isBlue ? 360 : 190, isBlue ? 1280 : 520, 1.5, 0.20);
  }

  /**
   * Crisp UI / instrument button click.
   */
  playUiClick() {
    this._recordEvent('ui_click');
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(980, now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.016);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.018);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.022);
  }

  /**
   * Soft ascending chime when Ctrl+Z Undo restores state.
   */
  playUndoWhoosh() {
    this._recordEvent('undo_whoosh');
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(460, now);
    osc.frequency.exponentialRampToValueAtTime(740, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.11, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.10);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.11);
  }

  /**
   * Soft discard / delete thud when removing apparatus.
   */
  playTrashCrumple() {
    this._recordEvent('trash_delete');
    if (!this._ready()) return;
    this._playFilteredNoiseBurst(0.12, 640, 210, 1.4, 0.15);
  }

  /**
   * Chemical & physical hazard alert sounds (shatter, explosion, H2 pop, O2 relight, stopper pop, etc.).
   */
  playAlertSound(type) {
    this._recordEvent(`alert_${type}`, { type });
    if (!this._ready()) return;
    const now = this.ctx.currentTime;

    if (type === 'explosion') {
      // Sub-bass shockwave boom + broadband crack + scattering glass shards
      const subOsc = this.ctx.createOscillator();
      const subGain = this.ctx.createGain();
      subOsc.type = 'sawtooth';
      subOsc.frequency.setValueAtTime(115, now);
      subOsc.frequency.exponentialRampToValueAtTime(34, now + 0.55);
      subGain.gain.setValueAtTime(0.0001, now);
      subGain.gain.linearRampToValueAtTime(0.45, now + 0.008);
      subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);
      subOsc.connect(subGain);
      subGain.connect(this.masterGain);
      subOsc.start(now);
      subOsc.stop(now + 0.65);

      this._playFilteredNoiseBurst(0.55, 850, 160, 0.8, 0.42);
      this._playGlassShardCascade(10, 0.06);
      return;
    }

    if (type === 'shatter' || type === 'thermal_shock' || type === 'implosion') {
      this._playFilteredNoiseBurst(0.18, 2200, 680, 1.2, 0.30);
      this._playGlassShardCascade(14, 0.01);
      return;
    }

    if (type === 'stopper_pop') {
      this.playStopperPop(true);
      this._playFilteredNoiseBurst(0.22, 1800, 620, 1.8, 0.22);
      return;
    }

    if (type === 'h2_pop' || type === 'unpurged_h2') {
      // Classic laboratory H2 test-tube squeaky-pop bark!
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(480, now);
      osc.frequency.exponentialRampToValueAtTime(1280, now + 0.032);
      osc.frequency.exponentialRampToValueAtTime(340, now + 0.11);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.36, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.125);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.135);
      this._playFilteredNoiseBurst(0.09, 1400, 520, 1.5, 0.22);
      return;
    }

    if (type === 'o2_relight' || type === 'solvent_ignition' || type === 'zn_burn_o2') {
      this._playFilteredNoiseBurst(0.32, 320, 1450, 1.4, 0.26);
      return;
    }

    if (type === 'co2_extinguish' || type === 'cl2_extinguish') {
      this._playFilteredNoiseBurst(0.16, 1600, 420, 2.2, 0.14);
      return;
    }

    // Default soft notification chime (syringe_max, glass_soften_melt, overflow)
    this.playGlassClink('beaker_250', 0.65);
  }

  _playFilteredNoiseBurst(durationSec, freqStart, freqEnd, qVal, peakGain) {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freqStart, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), now + durationSec);
    filter.Q.setValueAtTime(qVal, now);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start(now);
    src.stop(now + durationSec + 0.02);
  }

  _playGlassShardCascade(shardCount = 12, delayOffset = 0.01) {
    if (!this.ctx) return;
    const baseNow = this.ctx.currentTime + delayOffset;
    for (let i = 0; i < shardCount; i++) {
      const t0 = baseNow + i * (0.018 + Math.random() * 0.025);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = i % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(1950 + Math.random() * 4200, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(0.11 * Math.pow(0.9, i), t0 + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.055 + Math.random() * 0.05);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.12);
    }
  }

  // =========================================================
  // CONTINUOUS 60 FPS PHYSICS-DRIVEN AUDIO MODULATION
  // =========================================================

  stepContinuous(sim, dt) {
    if (!sim) return;
    const paused = Boolean(sim.environment?.paused);
    const items = sim.items || [];

    // Compute physical intensities even when audio is locked so tests can inspect activeChannels
    let totalBurnerW = 0;
    let hasBlueBunsen = false;
    let maxPourFillFrac = 0;
    let isPouringLiquid = false;
    let isSprayingWash = false;
    let totalGasRateMolS = 0;
    let anyBoiling = false;
    let anyNaFizz = false;
    let maxStirRpm = 0;
    let maxElectrolysisA = 0;

    for (const it of items) {
      if (it.kind === 'burner') {
        const pw = it.powerW || 0;
        const prevPw = this._prevBurnerPower.get(it.id) || 0;
        if (pw > 0 && prevPw === 0 && !paused) {
          this.playFlameWhoosh(it.typeId === 'bunsen_burner' && it.airHoleOpen !== false);
        }
        this._prevBurnerPower.set(it.id, pw);
        if (pw > 0) {
          totalBurnerW += pw;
          if (it.typeId === 'bunsen_burner' && it.airHoleOpen !== false) {
            hasBlueBunsen = true;
          }
        }
      } else if (it.kind === 'wash_bottle' && it.isSpraying && (it.waterMl || 0) > 0.05) {
        isSprayingWash = true;
      } else if (it.kind === 'burette' && (it.stopcockRateMlS || 0) > 0) {
        const bLiqMl = computeLiquidVolumeL(it.moles || {}, it.tempK || 298.15) * 1000;
        if (bLiqMl > 0.05) {
          if (it.stopcockRateMlS <= 0.45) {
            this._buretteDropAccum += dt * (it.stopcockRateMlS / 0.05);
            if (this._buretteDropAccum >= 1.0 && !paused) {
              this._buretteDropAccum = 0;
              this.playDropPlink(1.1, 0.65);
            }
          } else {
            isPouringLiquid = true;
            maxPourFillFrac = Math.max(maxPourFillFrac, 0.5);
          }
        }
      } else if (it.kind === 'dc_power' && it.powerOn && (it.measuredCurrentA || 0) > 0.05) {
        maxElectrolysisA = Math.max(maxElectrolysisA, it.measuredCurrentA);
        totalGasRateMolS += it.measuredCurrentA * 0.0004;
      } else if (it.kind === 'vessel' && !it.isShattered) {
        const prevStop = this._prevStoppered.get(it.id);
        const curStop = Boolean(it.isStoppered || it.leftStoppered || it.rightStoppered);
        if (prevStop !== undefined && prevStop !== curStop && !paused) {
          this.playStopperPop(!curStop);
        }
        this._prevStoppered.set(it.id, curStop);

        totalGasRateMolS += it.lastTotalRateMolS || 0;
        const liqL = computeLiquidVolumeL(it.moles || {}, it.tempK || 298.15);
        const tBoil = waterBoilingPointK(sim.environment?.pressureBar || CONSTANTS.P_STD_BAR);
        if (liqL > 0.001 && (it.tempK || 298.15) >= tBoil - 0.5 && (it.moles?.H2O_l || 0) > 0.01) {
          anyBoiling = true;
        }
        if ((it.moles?.Na_s || 0) > 1e-6 && (it.moles?.H2O_l || 0) > 1e-4 && !it.isFrozenSolid) {
          anyNaFizz = true;
        }
        if ((it.magStirRpm || 0) > 0 && it.hasStirBar) {
          maxStirRpm = Math.max(maxStirRpm, it.magStirRpm);
        }
      }
    }

    if (sim.activePourStream) {
      isPouringLiquid = true;
      maxPourFillFrac = Math.max(maxPourFillFrac, 0.45);
    }
    if (sim.activeReagentTransfer && !sim.activeReagentTransfer.isSolid) {
      isPouringLiquid = true;
      const dst = sim.getItem(sim.activeReagentTransfer.vesselId);
      if (dst) {
        const spec = APPARATUS[dst.typeId];
        const totMl = computeLiquidVolumeL(dst.moles || {}, dst.tempK || 298.15) * 1000 + computeSolidVolumeMl(dst.moles || {});
        maxPourFillFrac = Math.max(0.05, Math.min(0.98, totMl / Math.max(10, spec?.maxVolumeMl || 250)));
      }
    }

    this.activeChannels = {
      flame: paused ? 0 : Math.min(1, totalBurnerW / 600),
      pour: paused ? 0 : isSprayingWash ? 0.55 : isPouringLiquid ? 0.75 : 0,
      boil: paused ? 0 : anyBoiling ? 0.85 : 0,
      bubbleRate: paused ? 0 : totalGasRateMolS,
      naFizz: paused ? 0 : anyNaFizz ? 0.85 : 0,
      stirHum: paused ? 0 : maxStirRpm > 0 ? Math.min(1, maxStirRpm / 1200) : maxElectrolysisA > 0 ? 0.35 : 0,
    };

    if (!this.enabled || !this.ctx || !this.loops || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    const tau = 0.045;

    // 1. Modulate Burner Flame
    const flameTarget = this.activeChannels.flame;
    this.loops.flameLowGain.gain.setTargetAtTime(flameTarget * 0.16, now, tau);
    this.loops.flameJetGain.gain.setTargetAtTime(hasBlueBunsen ? flameTarget * 0.14 : 0, now, tau);
    this.loops.flameJetFilter.frequency.setTargetAtTime(950 + flameTarget * 420, now, tau);

    // 2. Modulate Liquid Pour / Wash Bottle Spray (pitch rises with fill level!)
    const pourTarget = this.activeChannels.pour;
    const pourFreq = isSprayingWash ? 2450 : 340 + maxPourFillFrac * 480;
    this.loops.pourFilter.frequency.setTargetAtTime(pourFreq, now, tau);
    this.loops.pourGain.gain.setTargetAtTime(pourTarget * 0.16, now, tau);

    // 3. Modulate Boiling Rumble & Stochastic Bubble Pops
    this.loops.boilGain.gain.setTargetAtTime(this.activeChannels.boil * 0.15, now, tau);

    const effBubbleIntensity =
      (totalGasRateMolS > 2e-5 ? Math.min(28, 3.5 + Math.sqrt(totalGasRateMolS * 18000)) : 0) +
      (anyBoiling ? 14 : 0);
    if (!paused && effBubbleIntensity > 0) {
      this._bubbleAccum += dt * effBubbleIntensity;
      if (this._bubbleAccum >= 1.0) {
        this._bubbleAccum = Math.min(0.5, this._bubbleAccum - 1.0);
        const pitch = anyBoiling && totalGasRateMolS <= 2e-5 ? 0.62 + Math.random() * 0.35 : 0.85 + Math.random() * 0.55;
        this.playDropPlink(pitch, 0.38);
      }
    }

    // 4. Modulate Sodium Skittering Fizz
    this.loops.fizzGain.gain.setTargetAtTime(this.activeChannels.naFizz * 0.15, now, tau);

    // 5. Modulate Magnetic Stirrer / Electrolysis Hum
    const humFreq = maxStirRpm > 0 ? 95 + (maxStirRpm / 1500) * 90 : 100;
    this.loops.humOsc.frequency.setTargetAtTime(humFreq, now, tau);
    this.loops.humGain.gain.setTargetAtTime(this.activeChannels.stirHum * 0.045, now, tau);
  }
}

export const soundEngine = new LabSoundEngine();
