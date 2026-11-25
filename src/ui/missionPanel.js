/**
 * Practical Lab & Assessment Mode UI (Prompt 83).
 * Docked collapsible Mission HUD card + Mission Selector Modal + Assessment Result Modal.
 */
import { MISSION_ARCHETYPES, MISSION_ORDER, getMissionById } from '../data/missions.js';
import {
  evaluateMission,
  loadMissionProgress,
  saveMissionAttempt,
} from '../engine/missionEvaluator.js';

function formatSecMmSs(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec || 0));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatElapsedMmSs(startedAtMs) {
  const sec = Math.max(0, Math.floor((Date.now() - (startedAtMs || Date.now())) / 1000));
  return formatSecMmSs(sec);
}

export class MissionDockPanel {
  constructor(container, sim, getLang, callbacks = {}) {
    this.container = container;
    this.sim = sim;
    this.getLang = getLang;
    this.callbacks = callbacks; // { onStartMission, onExitMission, onOpenSelector, onShowResult, onPrintResult, onNotify }
    this.collapsed = false;
    this.lastRenderSig = '';
    this.timerHandle = null;
  }

  setSim(sim) {
    this.sim = sim;
    this.lastRenderSig = '';
  }

  startTimerLoop() {
    if (this.timerHandle) return;
    this.timerHandle = setInterval(() => {
      const ms = this.sim?.missionState;
      if (!ms?.active) return;
      const el = this.container?.querySelector('#mission-timer-badge');
      if (el) {
        if (ms.timeLimitSec > 0) {
          const elapsed = (Date.now() - (ms.startedAtMs || Date.now())) / 1000;
          const rem = Math.max(0, Math.ceil(ms.timeLimitSec - elapsed));
          el.textContent = `⏳ ${formatSecMmSs(rem)}`;
          if (rem <= 0 && ms.examMode && !ms._autoSubmittedTimeout) {
            ms._autoSubmittedTimeout = true;
            this.callbacks.onTimeExpired?.();
          }
        } else {
          el.textContent = formatElapsedMmSs(ms.startedAtMs);
        }
      }
      const pEl = this.container?.querySelector('#mission-proctor-badge');
      if (pEl && this.callbacks.getIntegrityLog) {
        const il = this.callbacks.getIntegrityLog();
        if (il?.active) {
          const icon = il.flagLevel === 'red' ? '🔴' : il.flagLevel === 'yellow' ? '🟡' : '🟢';
          pEl.textContent = `${icon} ${il.tabSwitchCount || 0}sw`;
        }
      }
      if (ms.mode === 'practice') {
        this.updatePracticeChecklistLive();
      }
    }, 1000);
  }

  updatePracticeChecklistLive() {
    const ms = this.sim?.missionState;
    if (!ms?.active || ms.mode !== 'practice') return;
    const t = this.getLang();
    const res = evaluateMission(this.sim, ms, ms.draftAnswers || {}, { t });
    if (!res) return;
    for (const cr of res.criteriaResults) {
      const iconEl = this.container?.querySelector(`[data-mcrit-icon="${cr.id}"]`);
      const ptsEl = this.container?.querySelector(`[data-mcrit-pts="${cr.id}"]`);
      const detEl = this.container?.querySelector(`[data-mcrit-detail="${cr.id}"]`);
      if (iconEl) iconEl.textContent = cr.status === 'pass' ? '✅' : cr.status === 'partial' ? '🟨' : '⬜';
      if (ptsEl) ptsEl.textContent = `${cr.earned.toFixed(1)}/${cr.maxPoints.toFixed(1)}`;
      if (detEl) detEl.textContent = cr.detail || '';
    }
    const scoreEl = this.container?.querySelector('#mission-live-score');
    if (scoreEl) scoreEl.textContent = `${res.totalScore.toFixed(1)}/10`;
  }

  getSignature(t) {
    const ms = this.sim?.missionState;
    if (!ms?.active) return 'inactive';
    const practiceSig = ms.mode === 'practice' ? `${Math.round(this.sim.timeSec * 2)}:${this.sim.items.length}` : 'exam';
    return `${ms.missionId}|${ms.mode}|${ms.seed}|${ms.hintsUsed || 0}|${this.collapsed ? 1 : 0}|${practiceSig}|${t('missionSubmitBtn')}`;
  }

  render(t, force = false) {
    if (!this.container) return;
    const ms = this.sim?.missionState;
    if (!ms?.active) {
      this.container.innerHTML = '';
      this.container.classList.add('hidden');
      this.lastRenderSig = 'inactive';
      return;
    }
    const sig = this.getSignature(t);
    if (!force && sig === this.lastRenderSig) return;
    const activeId = document.activeElement?.id || '';
    if (!force && activeId.startsWith('mission-ans-')) {
      this.updatePracticeChecklistLive();
      return;
    }
    this.lastRenderSig = sig;
    this.container.classList.remove('hidden');

    const mission = ms.customAssignment ? ms : getMissionById(ms.missionId);
    if (!mission) return;
    const isPractice = ms.mode === 'practice';
    const isExam = Boolean(ms.examMode);
    const titleStr = mission.titleText || t(mission.titleKey);
    const goalStr = mission.goalText || t(mission.goalKey);
    const hintsList = mission.hints || [];
    const rubricList = mission.rubric || [];
    const submitFields = mission.submitFields || [];
    const evalNow = isPractice ? evaluateMission(this.sim, ms, ms.draftAnswers || {}, { t }) : null;
    const hintsUsed = ms.hintsUsed || 0;
    const draft = ms.draftAnswers || {};
    const il = this.callbacks.getIntegrityLog?.();
    const proctorBadgeHtml = isExam
      ? `<span id="mission-proctor-badge" class="text-[10.5px] font-mono px-1.5 py-0.5 rounded border border-theme bg-surface" title="${t('proctorActiveTip')}">${
          il?.flagLevel === 'red' ? '🔴' : il?.flagLevel === 'yellow' ? '🟡' : '🟢'
        } ${il?.tabSwitchCount || 0}sw</span>`
      : '';
    const timerInit = ms.timeLimitSec > 0
      ? `⏳ ${formatSecMmSs(Math.max(0, ms.timeLimitSec - (Date.now() - (ms.startedAtMs || Date.now())) / 1000))}`
      : formatElapsedMmSs(ms.startedAtMs);

    this.container.innerHTML = `
      <div class="mission-dock-card rounded-xl border border-accent/45 bg-surface-alt p-2.5 flex flex-col gap-2 mb-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-[10.5px] font-bold px-1.5 py-0.5 rounded-full ${
                isPractice ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/40' : 'bg-amber-500/15 text-amber-300 border border-amber-500/40'
              }">${isPractice ? `🎯 ${t('missionModePractice')}` : `📝 ${ms.examCode || t('missionModeExam')}`}</span>
              ${(() => {
                const archObj = MISSION_ARCHETYPES.find((a) => a.id === (mission.archetype || ms.archetype));
                return archObj ? `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded border ${archObj.badgeClass}">${t(archObj.i18nKey)}</span>` : '';
              })()}
              ${ms.shelfPolicy === 'initial_only' ? `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/10 text-red-300">🔒 ${t('tier_hard')}</span>` : ''}
              ${ms.blindDosingMode ? `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-sky-500/40 bg-sky-500/10 text-sky-300">🙈 Blind Dose</span>` : ''}
              <span id="mission-timer-badge" class="text-[11px] font-mono text-muted">${timerInit}</span>
              ${proctorBadgeHtml}
              ${isPractice && evalNow ? `<span id="mission-live-score" class="text-[11px] font-mono font-bold text-accent">${evalNow.totalScore.toFixed(1)}/10</span>` : ''}
            </div>
            <div class="text-xs font-bold truncate mt-0.5" title="${titleStr}">${titleStr}</div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button type="button" id="btn-mission-toggle-collapse" class="px-1.5 py-0.5 rounded border border-theme bg-surface text-xs hover:border-accent" title="Toggle">${this.collapsed ? '▾' : '▴'}</button>
            <button type="button" id="btn-mission-exit" class="px-1.5 py-0.5 rounded border border-theme bg-surface text-[11px] text-red-400 hover:bg-red-500/10" title="${t('missionExitBtn')}">✕</button>
          </div>
        </div>

        ${
          this.collapsed
            ? ''
            : `
          <p class="text-[11px] text-muted leading-snug">${goalStr}</p>
          <div class="grid ${ms.customAssignment ? 'grid-cols-1' : 'grid-cols-2'} gap-1.5">
            ${ms.customAssignment ? '' : `<button type="button" id="btn-mission-reseed" class="px-2 py-1 rounded-lg border border-theme bg-surface text-[11px] font-semibold hover:border-accent transition">🔄 ${t('missionNewSeed')}</button>`}
            ${hintsList.length > 0 ? `<button type="button" id="btn-mission-hint" class="px-2 py-1 rounded-lg border border-theme bg-surface text-[11px] font-semibold hover:border-accent transition" ${hintsUsed >= hintsList.length ? 'disabled' : ''}>💡 ${t('missionHintBtn')} (${hintsUsed}/${hintsList.length})</button>` : ''}
          </div>

          ${
            hintsUsed > 0 && hintsList.length > 0
              ? `<div class="p-2 rounded-lg border border-sky-500/35 bg-sky-500/10 flex flex-col gap-1 text-[11px]">
                  ${hintsList.slice(0, hintsUsed).map((hk, hi) => `<div><strong>#${hi + 1}:</strong> ${t(hk)}</div>`).join('')}
                </div>`
              : ''
          }

          <div class="p-2 rounded-lg border border-theme bg-surface flex flex-col gap-1">
            <div class="flex items-center justify-between text-[11px] font-semibold text-muted mb-0.5">
              <span>${t('missionChecklistTitle')}</span>
              ${!isPractice ? `<span class="text-amber-400">🔒 ${t('missionExamHiddenTag')}</span>` : ''}
            </div>
            ${
              isPractice && evalNow
                ? evalNow.criteriaResults
                    .map(
                      (cr) => `<div class="flex flex-col gap-0.5 text-[11px] py-0.5">
                        <div class="flex items-center justify-between gap-1.5">
                          <div class="flex items-center gap-1 min-w-0">
                            <span data-mcrit-icon="${cr.id}">${cr.status === 'pass' ? '✅' : cr.status === 'partial' ? '🟨' : '⬜'}</span>
                            <span class="truncate font-medium">${t(cr.labelKey)}</span>
                          </div>
                          <span class="font-mono text-muted shrink-0" data-mcrit-pts="${cr.id}">${cr.earned.toFixed(1)}/${cr.maxPoints.toFixed(1)}</span>
                        </div>
                        ${cr.detail ? `<div class="text-[10px] text-muted pl-4 leading-tight" data-mcrit-detail="${cr.id}">${cr.detail}</div>` : `<div class="text-[10px] text-muted pl-4 leading-tight" data-mcrit-detail="${cr.id}"></div>`}
                      </div>`
                    )
                    .join('')
                : rubricList
                    .map((cr) => {
                      const ruleKey =
                        cr.category === 'process'
                          ? 'rubricRuleProcess'
                          : cr.category === 'quantitative'
                          ? 'rubricRuleQuant'
                          : cr.category === 'identification'
                          ? 'rubricRuleIdent'
                          : 'rubricRuleSafe';
                      const ruleTxt = t(ruleKey);
                      return `<div class="flex flex-col gap-0.5 text-[11px] text-muted py-0.5" title="${ruleTxt}">
                        <div class="flex items-center justify-between gap-1.5">
                          <span class="truncate font-medium">• ${t(cr.labelKey)}</span>
                          <span class="font-mono shrink-0">${cr.maxPoints.toFixed(1)} pt</span>
                        </div>
                        <div class="text-[10px] opacity-80 pl-2.5 leading-tight">${ruleTxt}</div>
                      </div>`;
                    })
                    .join('')
            }
          </div>

          <div class="p-2 rounded-lg border border-theme bg-surface flex flex-col gap-1.5">
            <div class="text-[11px] font-semibold text-muted">${t('missionAnswerFormTitle')}</div>
            <div class="grid grid-cols-2 gap-1.5">
              ${submitFields
                .map((f) => {
                  const val = draft[f.id] ?? '';
                  const fldLbl = f.labelText || t(f.labelKey);
                  if (f.type === 'select') {
                    return `<label class="flex flex-col gap-0.5 text-[11px]">
                      <span class="text-muted font-medium truncate">${fldLbl}</span>
                      <select id="mission-ans-${f.id}" data-mfield="${f.id}" class="mission-answer-input px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                        <option value="">—</option>
                        ${(f.options || []).map((op) => `<option value="${op}" ${val === op ? 'selected' : ''}>${op}</option>`).join('')}
                      </select>
                    </label>`;
                  }
                  return `<label class="flex flex-col gap-0.5 text-[11px]">
                    <span class="text-muted font-medium truncate">${fldLbl}</span>
                    <input type="number" id="mission-ans-${f.id}" data-mfield="${f.id}" min="${f.min ?? 0}" max="${f.max ?? 999}" step="${f.step ?? 0.001}" placeholder="${f.placeholder || ''}" value="${val}" class="mission-answer-input px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
                  </label>`;
                })
                .join('')}
            </div>
            <button type="button" id="btn-mission-submit" class="mt-1 w-full py-1.5 px-3 rounded-lg bg-accent text-white text-xs font-bold hover:opacity-90 transition">
              ✅ ${t('missionSubmitBtn')}
            </button>
          </div>
        `
        }
      </div>
    `;

    this.container.querySelector('#btn-mission-toggle-collapse')?.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.render(this.getLang(), true);
    });
    this.container.querySelector('#btn-mission-exit')?.addEventListener('click', () => {
      this.callbacks.onExitMission?.();
    });
    this.container.querySelector('#btn-mission-reseed')?.addEventListener('click', () => {
      this.callbacks.onStartMission?.(ms.missionId, ms.mode);
    });
    this.container.querySelector('#btn-mission-hint')?.addEventListener('click', () => {
      this.sim.useMissionHint();
      this.render(this.getLang(), true);
    });
    this.container.querySelectorAll('.mission-answer-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        if (!ms.draftAnswers) ms.draftAnswers = {};
        ms.draftAnswers[inp.dataset.mfield] = inp.value;
      });
      inp.addEventListener('change', () => {
        if (!ms.draftAnswers) ms.draftAnswers = {};
        ms.draftAnswers[inp.dataset.mfield] = inp.value;
        if (ms.mode === 'practice') this.updatePracticeChecklistLive();
      });
    });
    this.container.querySelector('#btn-mission-submit')?.addEventListener('click', async () => {
      const answers = { ...(ms.draftAnswers || {}) };
      if (this.callbacks.onSubmitMission) {
        await this.callbacks.onSubmitMission(answers);
      } else {
        const res = await this.sim.submitMissionAsync(answers, { t: this.getLang() });
        if (res) {
          saveMissionAttempt(res);
          this.callbacks.onShowResult?.(res);
        }
      }
    });
  }
}

export function openMissionSelectorModal(modalRootEl, sim, t, callbacks = {}) {
  if (!modalRootEl) return;
  const progress = loadMissionProgress();
  let selectedMode = sim?.missionState?.mode === 'exam' ? 'exam' : 'practice';
  const curId = sim?.missionState?.active ? sim.missionState.missionId : null;

  const renderModal = () => {
    modalRootEl.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3';
    modalRootEl.innerHTML = `
      <div class="w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-2xl border border-theme bg-surface p-4 sm:p-5 shadow-2xl flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2 border-b border-theme pb-2.5">
          <div>
            <h2 class="text-base font-bold">🎯 ${t('missionHubTitle')}</h2>
            <p class="text-xs text-muted">${t('missionHubSubtitle')}</p>
          </div>
          <button type="button" id="btn-mhub-close" class="px-2.5 py-1 rounded-lg border border-theme bg-surface-alt text-xs font-semibold hover:border-accent">✕</button>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl border border-theme bg-surface-alt">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-semibold text-muted">${t('missionPlayModeLabel')}:</span>
            <button type="button" data-mmode="practice" class="mhub-mode-btn px-2.5 py-1 rounded-lg border text-xs font-semibold ${
              selectedMode === 'practice' ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300' : 'border-theme bg-surface text-muted'
            }">🎯 ${t('missionModePractice')}</button>
            <button type="button" data-mmode="exam" class="mhub-mode-btn px-2.5 py-1 rounded-lg border text-xs font-semibold ${
              selectedMode === 'exam' ? 'border-amber-500 bg-amber-500/20 text-amber-300' : 'border-theme bg-surface text-muted'
            }">📝 ${t('missionModeExam')}</button>
          </div>
          <button type="button" id="btn-mhub-free" class="px-3 py-1 rounded-lg border ${
            !curId ? 'border-accent bg-accent/15 text-accent font-bold' : 'border-theme bg-surface text-muted hover:text-main'
          } text-xs">⚗️ ${t('modeFreeSandbox')}</button>
        </div>

        <div class="p-2.5 rounded-xl border border-accent/40 bg-accent/10 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div class="flex items-center gap-1.5 flex-wrap flex-1 min-w-[210px]">
            <span class="font-bold">🎓 ${t('examEnterCodeLabel')}:</span>
            <input id="mhub-exam-code" type="text" placeholder="CHEM-1234" class="px-2 py-1 rounded-lg border border-theme bg-surface font-mono uppercase text-xs w-32" />
            <button type="button" id="btn-mhub-join-code" class="px-3 py-1 rounded-lg bg-accent text-white font-bold text-xs hover:opacity-90">🚀 ${t('examJoinBtn')}</button>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" id="btn-mhub-load-examfile" class="px-2.5 py-1 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent">📁 .vlab-exam</button>
            <input type="file" id="input-mhub-examfile" accept=".vlab-exam,.json,application/json" class="hidden" />
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          ${MISSION_ORDER.map((id) => {
            const m = getMissionById(id);
            const rec = progress[id];
            const bestStr = rec ? `${'⭐'.repeat(rec.bestStars || 0)} ${rec.bestScore.toFixed(1)}/10` : t('missionNotAttempted');
            const tierKey = m.difficultyTier || (m.difficulty === 'basic' ? 'easy' : m.difficulty === 'intermediate' ? 'medium' : 'hard');
            const diffBadge = tierKey === 'easy'
              ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
              : tierKey === 'medium'
              ? 'text-sky-400 border-sky-500/40 bg-sky-500/10'
              : 'text-amber-300 border-amber-500/40 bg-amber-500/10';
            const archObj = MISSION_ARCHETYPES.find((a) => a.id === m.archetype);
            return `
              <div class="p-3 rounded-xl border ${curId === id ? 'border-accent bg-accent/10' : 'border-theme bg-surface-alt'} flex flex-col justify-between gap-2">
                <div>
                  <div class="flex items-center justify-between gap-1.5 mb-1 flex-wrap">
                    <div class="flex items-center gap-1 flex-wrap">
                      <span class="text-[10.5px] font-semibold px-1.5 py-0.5 rounded border ${diffBadge}">${t(`tier_${tierKey}`)}</span>
                      ${archObj ? `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded border ${archObj.badgeClass}">${t(archObj.i18nKey)}</span>` : ''}
                    </div>
                    <span class="text-[11px] font-mono text-muted">${bestStr}</span>
                  </div>
                  <h3 class="text-sm font-bold leading-snug">${t(m.titleKey)}</h3>
                  <p class="text-xs text-muted mt-1 leading-relaxed">${t(m.summaryKey)}</p>
                </div>
                <div class="flex items-center justify-between gap-2 pt-2 border-t border-theme/50">
                  <span class="text-[10.5px] font-mono text-muted truncate">${m.equationText}</span>
                  <button type="button" data-start-mission="${id}" class="mhub-start-btn px-3 py-1 rounded-lg bg-accent text-white text-xs font-bold shrink-0 hover:opacity-90 transition">
                    ${curId === id ? t('missionRestartBtn') : t('missionStartBtn')}
                  </button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    modalRootEl.querySelector('#btn-mhub-close')?.addEventListener('click', () => {
      modalRootEl.className = 'hidden';
      modalRootEl.innerHTML = '';
    });
    modalRootEl.querySelectorAll('.mhub-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedMode = btn.dataset.mmode;
        renderModal();
      });
    });
    modalRootEl.querySelector('#btn-mhub-free')?.addEventListener('click', () => {
      modalRootEl.className = 'hidden';
      modalRootEl.innerHTML = '';
      callbacks.onExitMission?.();
    });
    modalRootEl.querySelectorAll('.mhub-start-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mid = btn.dataset.startMission;
        modalRootEl.className = 'hidden';
        modalRootEl.innerHTML = '';
        callbacks.onStartMission?.(mid, selectedMode);
      });
    });
    modalRootEl.querySelector('#btn-mhub-join-code')?.addEventListener('click', async () => {
      const code = modalRootEl.querySelector('#mhub-exam-code')?.value?.trim()?.toUpperCase();
      if (!code) return;
      modalRootEl.className = 'hidden';
      modalRootEl.innerHTML = '';
      await callbacks.onJoinExamCode?.(code);
    });
    const examFileInp = modalRootEl.querySelector('#input-mhub-examfile');
    modalRootEl.querySelector('#btn-mhub-load-examfile')?.addEventListener('click', () => examFileInp?.click());
    examFileInp?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      modalRootEl.className = 'hidden';
      modalRootEl.innerHTML = '';
      await callbacks.onImportExamFile?.(file);
    });
  };
  renderModal();
}

export function openMissionResultModal(modalRootEl, sim, evalResult, t, callbacks = {}) {
  if (!modalRootEl || !evalResult) return;
  const statusBadge = (st) =>
    st === 'pass'
      ? `<span class="text-emerald-400 font-semibold">✅ ${t('critPass')}</span>`
      : st === 'partial'
      ? `<span class="text-amber-300 font-semibold">🟨 ${t('critPartial')}</span>`
      : `<span class="text-red-400 font-semibold">❌ ${t('critFail')}</span>`;

  modalRootEl.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3';
  modalRootEl.innerHTML = `
    <div class="w-full max-w-xl max-h-[88vh] overflow-y-auto rounded-2xl border border-theme bg-surface p-4 sm:p-5 shadow-2xl flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2 border-b border-theme pb-2.5">
        <div class="flex items-center gap-2.5">
          <span class="text-3xl">${evalResult.medal}</span>
          <div>
            <h2 class="text-base font-bold">${t('missionResultTitle')} — ${evalResult.titleText || t(evalResult.titleKey)}</h2>
            <div class="text-xs text-muted font-mono">${'⭐'.repeat(evalResult.stars || 0)}${'☆'.repeat(Math.max(0, 3 - (evalResult.stars || 0)))} · ${t('gradeLabel')} ${evalResult.grade} · ${evalResult.elapsedSec}s</div>
          </div>
        </div>
        <div class="text-right">
          <div class="text-xl font-black font-mono text-accent">${evalResult.totalScore.toFixed(1)}<span class="text-xs text-muted font-normal"> / 10</span></div>
          ${evalResult.hintPenalty > 0 ? `<div class="text-[10.5px] text-amber-400 font-mono">-${evalResult.hintPenalty.toFixed(1)} hints</div>` : ''}
          ${evalResult.integrityPenalty > 0 ? `<div class="text-[10.5px] text-red-400 font-mono">-${evalResult.integrityPenalty.toFixed(1)} ${t('proctorPenaltyTag')}</div>` : ''}
        </div>
      </div>

      ${evalResult.processAnomaly ? `<div class="p-2 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300 font-semibold">⚠️ ${t('examProcessAnomalyWarn')}</div>` : ''}

      <div class="space-y-1.5">
        ${evalResult.criteriaResults
          .map(
            (cr) => `
          <div class="p-2.5 rounded-xl border border-theme bg-surface-alt flex items-start justify-between gap-2 text-xs">
            <div class="min-w-0">
              <div class="font-semibold">${t(cr.labelKey)}</div>
              <div class="text-[11px] text-muted font-mono mt-0.5">${cr.detail || ''}</div>
            </div>
            <div class="text-right shrink-0">
              <div>${statusBadge(cr.status)}</div>
              <div class="text-[11px] font-mono font-bold mt-0.5">${cr.earned.toFixed(1)} / ${cr.maxPoints.toFixed(1)}</div>
            </div>
          </div>`
          )
          .join('')}
      </div>

      <div class="p-2.5 rounded-xl border border-sky-500/35 bg-sky-500/10 text-xs">
        <div class="font-semibold text-sky-400 mb-0.5">${t('missionEquationsTitle')}</div>
        <div class="font-mono text-[11.5px]">${evalResult.equationText}</div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
        <button type="button" id="btn-mres-retry" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface-alt text-xs font-semibold hover:border-accent">🔄 ${t('missionRetryBtn')}</button>
        <button type="button" id="btn-mres-print" class="py-1.5 px-2.5 rounded-lg border border-accent bg-accent/15 text-accent text-xs font-bold hover:opacity-90">🖨️ ${t('missionPrintBtn')}</button>
        <button type="button" id="btn-mres-free" class="py-1.5 px-2.5 rounded-lg border border-theme bg-surface-alt text-xs font-semibold hover:border-accent">⚗️ ${t('modeFreeSandbox')}</button>
        <button type="button" id="btn-mres-close" class="py-1.5 px-2.5 rounded-lg bg-accent text-white text-xs font-bold hover:opacity-90">${t('close')}</button>
      </div>
    </div>
  `;

  const close = () => {
    modalRootEl.className = 'hidden';
    modalRootEl.innerHTML = '';
  };
  modalRootEl.querySelector('#btn-mres-close')?.addEventListener('click', close);
  modalRootEl.querySelector('#btn-mres-retry')?.addEventListener('click', () => {
    close();
    callbacks.onStartMission?.(evalResult.missionId, evalResult.mode);
  });
  modalRootEl.querySelector('#btn-mres-free')?.addEventListener('click', () => {
    close();
    callbacks.onExitMission?.();
  });
  modalRootEl.querySelector('#btn-mres-print')?.addEventListener('click', () => {
    callbacks.onPrintResult?.(evalResult);
  });
}
