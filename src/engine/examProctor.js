/**
 * Exam Proctoring Telemetry, Anti-Cheat Locks & Answer Hashing (Prompt 84).
 * Tracks visibilitychange / blur / fullscreenexit, computes strike penalties,
 * blocks DevTools/right-click during examMode, and hashes blind answer keys.
 */

const ACTIVE_ATTEMPT_CACHE_KEY = 'virlab_active_exam_attempt_v1';

export function fnv1aHash32(input) {
  const str = String(input ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export async function sha256Hex(input) {
  const str = String(input ?? '');
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
      const bytes = new TextEncoder().encode(str);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Fallback below in restricted non-secure contexts
  }
  // Deterministic dual-round 64-bit FNV fallback if subtle crypto unavailable
  const h1 = fnv1aHash32(str).toString(16).padStart(8, '0');
  const h2 = fnv1aHash32(`salt:${str}:v84`).toString(16).padStart(8, '0');
  return `${h1}${h2}${h1}${h2}`;
}

export function normalizeAnswerForHash(val) {
  return String(val ?? '').trim();
}

export async function hashAnswerToken(seed, fieldKey, answerVal) {
  const payload = `v84|${Number(seed) || 0}|${String(fieldKey || '')}|${normalizeAnswerForHash(answerVal)}`;
  return sha256Hex(payload);
}

export async function buildHashedAnswerMap(seed, answerKeyObj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(answerKeyObj || {})) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    out[k] = await hashAnswerToken(seed, k, v);
  }
  return out;
}

export async function verifyHashedAnswer(seed, fieldKey, userVal, expectedHash) {
  if (!expectedHash) return false;
  const h = await hashAnswerToken(seed, fieldKey, userVal);
  return h === expectedHash;
}

export function saveExamAttemptRecovery(entry) {
  try {
    if (typeof localStorage === 'undefined' || !entry?.examCode) return;
    const raw = localStorage.getItem(ACTIVE_ATTEMPT_CACHE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    const uidKey = `${entry.examCode}::${entry.studentUid || 'anon'}`;
    map[uidKey] = {
      examCode: entry.examCode,
      studentUid: entry.studentUid || 'anon',
      seed: entry.seed,
      startedAtMs: entry.startedAtMs,
      draftAnswers: entry.draftAnswers || {},
    };
    localStorage.setItem(ACTIVE_ATTEMPT_CACHE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export function loadExamAttemptRecovery(examCode, studentUid = 'anon') {
  try {
    if (typeof localStorage === 'undefined' || !examCode) return null;
    const raw = localStorage.getItem(ACTIVE_ATTEMPT_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[`${examCode}::${studentUid || 'anon'}`] || null;
  } catch {
    return null;
  }
}

export function clearExamAttemptRecovery(examCode, studentUid = 'anon') {
  try {
    if (typeof localStorage === 'undefined' || !examCode) return;
    const raw = localStorage.getItem(ACTIVE_ATTEMPT_CACHE_KEY);
    if (!raw) return;
    const map = JSON.parse(raw);
    delete map[`${examCode}::${studentUid || 'anon'}`];
    localStorage.setItem(ACTIVE_ATTEMPT_CACHE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export function createInitialIntegrityLog(config = {}) {
  return {
    active: Boolean(config.active),
    examCode: config.examCode || null,
    studentUid: config.studentUid || 'local',
    seed: config.seed || 1,
    startedAtMs: config.startedAtMs || Date.now(),
    timeLimitSec: Number(config.timeLimitSec) || 0,
    maxSwitches: Math.max(1, Number(config.maxSwitches) || 3),
    maxAwaySec: Math.max(5, Number(config.maxAwaySec) || 20),
    autoSubmitOnViolation: Boolean(config.autoSubmitOnViolation),
    requireFullscreen: Boolean(config.requireFullscreen),
    tabSwitchCount: 0,
    totalAwaySec: 0,
    maxSingleAwaySec: 0,
    devToolsAttemptCount: 0,
    fullscreenExitCount: 0,
    penaltyPoints: 0,
    flagLevel: 'green', // 'green' | 'yellow' | 'red'
    forceSubmitted: false,
    events: [],
    _awayStartMs: null,
    _lastLeaveEventMs: 0,
  };
}

export class ExamProctorController {
  constructor(callbacks = {}) {
    this.callbacks = callbacks; // { onStrikeWarn, onAutoSubmit, onBlockedShortcut, onUpdate }
    this.log = createInitialIntegrityLog();
    this._attached = false;
    this._onVisibility = null;
    this._onBlur = null;
    this._onFocus = null;
    this._onFullscreen = null;
    this._onKeyDown = null;
    this._onContextMenu = null;
  }

  startSession(config = {}) {
    this.log = createInitialIntegrityLog({ ...config, active: true });
    this.attachDomListeners();
    return this.log;
  }

  stopSession() {
    this.detachDomListeners();
    this.log.active = false;
  }

  getRemainingSec(nowMs = Date.now()) {
    if (!this.log.active || !this.log.timeLimitSec) return null;
    const elapsed = (nowMs - (this.log.startedAtMs || nowMs)) / 1000;
    return Math.max(0, Math.round(this.log.timeLimitSec - elapsed));
  }

  recordAwayStart(reason = 'blur', nowMs = Date.now()) {
    if (!this.log.active) return;
    // Deduplicate blur + visibilitychange firing together within 350 ms
    if (this.log._awayStartMs != null || nowMs - (this.log._lastLeaveEventMs || 0) < 350) {
      return;
    }
    this.log._awayStartMs = nowMs;
    this.log._lastLeaveEventMs = nowMs;
    this.log.tabSwitchCount += 1;
    this.log.events.push({ type: reason, atMs: nowMs });
    if (this.log.events.length > 40) this.log.events.shift();
    this._evaluateStrikes();
    this.callbacks.onUpdate?.(this.log);
  }

  recordReturn(nowMs = Date.now()) {
    if (!this.log.active || this.log._awayStartMs == null) return;
    const awaySec = Math.max(0.1, (nowMs - this.log._awayStartMs) / 1000);
    this.log._awayStartMs = null;
    this.log.totalAwaySec = +(this.log.totalAwaySec + awaySec).toFixed(1);
    this.log.maxSingleAwaySec = +Math.max(this.log.maxSingleAwaySec, awaySec).toFixed(1);
    this.log.events.push({ type: 'return', awaySec: +awaySec.toFixed(1), atMs: nowMs });
    if (this.log.events.length > 40) this.log.events.shift();
    this._evaluateStrikes();
    this.callbacks.onUpdate?.(this.log);
  }

  recordDevToolsAttempt(combo = 'F12', nowMs = Date.now()) {
    if (!this.log.active) return;
    this.log.devToolsAttemptCount += 1;
    this.log.events.push({ type: 'devtools_blocked', combo, atMs: nowMs });
    if (this.log.events.length > 40) this.log.events.shift();
    this._evaluateStrikes();
    this.callbacks.onBlockedShortcut?.(combo, this.log);
  }

  _evaluateStrikes() {
    const { tabSwitchCount, maxSwitches, maxSingleAwaySec, totalAwaySec, maxAwaySec, devToolsAttemptCount } = this.log;
    const severe =
      tabSwitchCount > maxSwitches ||
      maxSingleAwaySec > maxAwaySec ||
      totalAwaySec > maxAwaySec * 2.5 ||
      devToolsAttemptCount >= 3;

    if (severe) {
      this.log.flagLevel = 'red';
      const excessSwitches = Math.max(0, tabSwitchCount - maxSwitches);
      this.log.penaltyPoints = Math.min(2.5, +(0.5 + excessSwitches * 0.5 + (devToolsAttemptCount >= 3 ? 0.5 : 0)).toFixed(1));
      if (this.log.autoSubmitOnViolation && !this.log.forceSubmitted) {
        this.log.forceSubmitted = true;
        this.callbacks.onAutoSubmit?.('proctor_violation', this.log);
      } else {
        this.callbacks.onStrikeWarn?.('red', this.log);
      }
    } else if (tabSwitchCount > 0 || devToolsAttemptCount > 0 || this.log.fullscreenExitCount > 0) {
      this.log.flagLevel = 'yellow';
      this.log.penaltyPoints = tabSwitchCount >= 2 ? 0.5 : 0;
      this.callbacks.onStrikeWarn?.('yellow', this.log);
    } else {
      this.log.flagLevel = 'green';
      this.log.penaltyPoints = 0;
    }
  }

  attachDomListeners() {
    if (this._attached || typeof document === 'undefined' || typeof window === 'undefined') return;
    this._attached = true;

    this._onVisibility = () => {
      if (document.hidden) this.recordAwayStart('visibility_hidden', Date.now());
      else this.recordReturn(Date.now());
    };
    this._onBlur = () => this.recordAwayStart('window_blur', Date.now());
    this._onFocus = () => this.recordReturn(Date.now());
    this._onFullscreen = () => {
      if (this.log.active && this.log.requireFullscreen && !document.fullscreenElement) {
        this.log.fullscreenExitCount += 1;
        this.log.events.push({ type: 'fullscreen_exit', atMs: Date.now() });
        this._evaluateStrikes();
        this.callbacks.onStrikeWarn?.(this.log.flagLevel, this.log);
      }
    };
    this._onKeyDown = (e) => {
      if (!this.log.active) return;
      const key = String(e.key || '').toUpperCase();
      const isF12 = key === 'F12';
      const isInspect = (e.ctrlKey || e.metaKey) && e.shiftKey && ['I', 'J', 'C'].includes(key);
      const isViewSrc = (e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'U';
      if (isF12 || isInspect || isViewSrc) {
        e.preventDefault();
        e.stopPropagation();
        this.recordDevToolsAttempt(isF12 ? 'F12' : isViewSrc ? 'Ctrl+U' : `Ctrl+Shift+${key}`, Date.now());
      }
    };
    this._onContextMenu = (e) => {
      if (!this.log.active) return;
      // Allow inside text/number inputs if needed, block on bench/inspector to deter element inspection
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      e.stopPropagation();
    };

    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('focus', this._onFocus);
    document.addEventListener('fullscreenchange', this._onFullscreen);
    window.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('contextmenu', this._onContextMenu, true);
  }

  detachDomListeners() {
    if (!this._attached || typeof document === 'undefined' || typeof window === 'undefined') return;
    this._attached = false;
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('focus', this._onFocus);
    document.removeEventListener('fullscreenchange', this._onFullscreen);
    window.removeEventListener('keydown', this._onKeyDown, true);
    window.removeEventListener('contextmenu', this._onContextMenu, true);
  }
}
