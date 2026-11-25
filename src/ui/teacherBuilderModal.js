/**
 * Teacher Studio & Classroom Assessment Manager (Prompt 84).
 * Tab 1: Configure & publish live workbench setup as CHEM-XXXX (Firestore + .vlab-exam).
 * Tab 2: Review student submissions, proctoring flags (Green/Yellow/Red), and inspect snapshots.
 */
import { APPARATUS, APPARATUS_ORDER } from '../data/apparatus.js';
import {
  MISSION_ARCHETYPES,
  MIXTURE_PRESETS,
  STANDARD_PREP_TARGETS,
  SYNTHESIS_PRODUCT_PRESETS,
} from '../data/missions.js';
import { STARTER_REAGENTS } from '../data/species.js';
import { exportSnapshotForSim } from '../engine/simSnapshot.js';
import { buildHashedAnswerMap } from '../engine/examProctor.js';
import { cloudSync, exportVlabExamFile } from '../storage/workspaceStorage.js';

export class TeacherBuilderModal {
  constructor(rootEl, labManager, getLang, callbacks = {}) {
    this.rootEl = rootEl;
    this.labManager = labManager;
    this.getLang = getLang;
    this.callbacks = callbacks; // { onNotify, onInspectSubmissionSnapshot }
    this.activeTab = 'design'; // 'design' | 'submissions'
    this.selectedArchetype = 'blind_id';
    this.selectedTier = 'medium';
    this.selectedExamCode = '';
    this.assignments = [];
    this.submissions = [];
    this.lastPublished = null;
  }

  close() {
    if (!this.rootEl) return;
    this.rootEl.className = 'hidden';
    this.rootEl.innerHTML = '';
  }

  async open(initialTab = 'design') {
    if (!this.rootEl) return;
    if (!cloudSync.isTeacher()) {
      this.callbacks.onNotify?.(`🔒 ${this.getLang()('teacherRoleRequiredMsg')}`);
      return;
    }
    this.activeTab = initialTab;
    this.render();
    if (initialTab === 'submissions') {
      await this.refreshTeacherData();
    }
  }

  async refreshTeacherData() {
    this.assignments = await cloudSync.listTeacherAssignments();
    if (!this.selectedExamCode && this.assignments.length > 0) {
      this.selectedExamCode = this.assignments[0].examCode;
    }
    if (this.selectedExamCode) {
      this.submissions = await cloudSync.listExamSubmissions(this.selectedExamCode);
    } else {
      this.submissions = [];
    }
    this.render();
  }

  render() {
    if (!this.rootEl) return;
    const t = this.getLang();
    const sim = this.labManager.getActiveSim();
    const vessels = (sim?.items || []).filter((i) => i.kind === 'vessel' && !i.isShattered);

    this.rootEl.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3';
    this.rootEl.innerHTML = `
      <div class="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl border border-theme bg-surface p-4 sm:p-5 shadow-2xl flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-theme pb-2.5">
          <div>
            <h2 class="text-base font-bold">🎓 ${t('teacherStudioTitle')}</h2>
            <p class="text-xs text-muted">${cloudSync.user?.email || ''} · <span class="text-emerald-400 font-semibold">teacher</span></p>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" data-ts-tab="design" class="ts-tab-btn px-3 py-1 rounded-lg border text-xs font-semibold ${
              this.activeTab === 'design' ? 'border-accent bg-accent text-white' : 'border-theme bg-surface-alt text-muted'
            }">🧪 ${t('teacherTabDesign')}</button>
            <button type="button" data-ts-tab="submissions" class="ts-tab-btn px-3 py-1 rounded-lg border text-xs font-semibold ${
              this.activeTab === 'submissions' ? 'border-accent bg-accent text-white' : 'border-theme bg-surface-alt text-muted'
            }">📊 ${t('teacherTabSubmissions')}</button>
            <button type="button" id="btn-ts-close" class="px-2.5 py-1 rounded-lg border border-theme bg-surface-alt text-xs font-semibold hover:border-accent">✕</button>
          </div>
        </div>

        ${this.activeTab === 'design' ? this._renderDesignTab(t, vessels) : this._renderSubmissionsTab(t)}
      </div>
    `;

    this.rootEl.querySelector('#btn-ts-close')?.addEventListener('click', () => this.close());
    this.rootEl.querySelectorAll('.ts-tab-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        this.activeTab = btn.dataset.tsTab;
        if (this.activeTab === 'submissions') {
          await this.refreshTeacherData();
        } else {
          this.render();
        }
      });
    });

    if (this.activeTab === 'design') {
      this._bindDesignEvents(t, sim, vessels);
    } else {
      this._bindSubmissionEvents(t);
    }
  }

  _renderArchetypePanel(t, vessels) {
    const a = this.selectedArchetype;
    if (a === 'blind_id') {
      return `
        <div class="grid grid-cols-3 gap-1.5">
          ${['easy', 'medium', 'hard']
            .map(
              (tier) => `<button type="button" data-ts-tier="${tier}" class="ts-tier-btn px-2 py-1 rounded-lg border text-[11px] font-semibold transition ${
                this.selectedTier === tier ? 'border-accent bg-accent/15 text-accent' : 'border-theme bg-surface text-muted'
              }">${t(`tier_${tier}`)}</button>`
            )
            .join('')}
        </div>
        <div class="text-[11px] text-muted">${t(`tierDesc_${this.selectedTier}`)}</div>
        <div class="font-bold text-xs">${t('teacherBlindVesselsTitle')} (${vessels.length})</div>
        <div class="space-y-1.5 max-h-36 overflow-y-auto pr-1">
          ${
            vessels.length === 0
              ? `<p class="text-muted">${t('teacherNoVesselsHint')}</p>`
              : vessels
                  .map(
                    (v, idx) => `
                <div class="p-1.5 rounded-lg border border-theme bg-surface flex items-center gap-2">
                  <input type="checkbox" class="ts-blind-chk" data-vid="${v.id}" ${idx < 4 ? 'checked' : ''} />
                  <span class="font-mono font-bold shrink-0">${t(APPARATUS[v.typeId]?.i18nKey || v.typeId)} ${v.label}</span>
                  <input type="text" class="ts-blind-lbl w-12 px-1.5 py-0.5 rounded border border-theme bg-surface-alt font-mono text-xs" data-vid="${v.id}" value="?${String.fromCharCode(65 + idx)}" />
                  <input type="text" class="ts-blind-ans flex-1 min-w-0 px-1.5 py-0.5 rounded border border-theme bg-surface-alt text-xs" data-vid="${v.id}" placeholder="${t('teacherTrueNamePlaceholder')}" />
                </div>`
                  )
                  .join('')
          }
        </div>`;
    }
    if (a === 'standard_prep') {
      return `
        <div class="p-2 rounded-lg border border-theme bg-surface flex flex-col gap-2">
          <label class="inline-flex items-center gap-1.5 cursor-pointer font-semibold text-sky-300">
            <input id="ts-blind-dosing" type="checkbox" checked />
            <span>🙈 ${t('teacherBlindDosingLabel')}</span>
          </label>
          <div class="grid grid-cols-2 gap-1.5">
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherTargetSoluteLabel')}</span>
              <select id="ts-prep-species" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                ${STANDARD_PREP_TARGETS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherPrepConcLabel')}</span>
              <div class="flex gap-1">
                <input id="ts-prep-conc" type="number" step="0.01" value="0.20" class="w-full px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
                <select id="ts-prep-unit" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                  <option value="M">M</option>
                  <option value="w%">%w/w</option>
                </select>
              </div>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherPrepVolLabel')}</span>
              <input id="ts-prep-vol" type="number" step="5" value="100" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherToleranceLabel')}</span>
              <input id="ts-prep-tol" type="number" step="0.5" value="5" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
            </label>
          </div>
        </div>`;
    }
    if (a === 'titration') {
      return `
        <div class="p-2 rounded-lg border border-theme bg-surface flex flex-col gap-1.5">
          <div class="grid grid-cols-2 gap-1.5">
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherTitrAnalyteLabel')}</span>
              <select id="ts-titr-analyte" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                <option value="hcl">HCl (?X)</option>
                <option value="ch3cooh">CH₃COOH (?X)</option>
                <option value="h2so4">H₂SO₄ (?X)</option>
                <option value="fe2_redox">Fe²⁺ / H₂SO₄ (Redox)</option>
                <option value="i2_redox">I₂ / KI (Redox)</option>
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherTitrBuretteLabel')}</span>
              <select id="ts-titr-reagent" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                <option value="naoh">NaOH (Burette)</option>
                <option value="hcl">HCl (Burette)</option>
                <option value="kmno4_h2so4">KMnO₄ / H⁺ (Redox)</option>
              </select>
            </label>
          </div>
          <div class="grid grid-cols-4 gap-1.5">
            <select id="ts-titr-vid" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
              ${vessels.length ? vessels.map((v) => `<option value="${v.id}">${v.label}</option>`).join('') : '<option value="">—</option>'}
            </select>
            <input id="ts-titr-min" type="number" step="0.01" value="0.08" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" title="Min M" />
            <input id="ts-titr-max" type="number" step="0.01" value="0.18" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" title="Max M" />
            <input id="ts-titr-tol" type="number" step="0.5" value="2" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" title="Tol %" />
          </div>
        </div>`;
    }
    if (a === 'synthesis') {
      return `
        <div class="p-2 rounded-lg border border-theme bg-surface flex flex-col gap-2">
          <div class="grid grid-cols-3 gap-1.5">
            <label class="col-span-3 flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherSynthProductLabel')}</span>
              <select id="ts-syn-product" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                ${SYNTHESIS_PRODUCT_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherMinMolLabel')}</span>
              <input id="ts-syn-minmol" type="number" step="0.001" value="0.005" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherMinPurLabel')}</span>
              <input id="ts-syn-minpur" type="number" step="5" value="70" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
            </label>
          </div>
          <div class="flex flex-wrap gap-2 text-[11px]">
            <label class="inline-flex items-center gap-1"><input type="checkbox" class="ts-syn-tech" value="filter" /> <span>${t('techFilter')}</span></label>
            <label class="inline-flex items-center gap-1"><input type="checkbox" class="ts-syn-tech" value="sep_funnel" /> <span>${t('techSepFunnel')}</span></label>
            <label class="inline-flex items-center gap-1"><input type="checkbox" class="ts-syn-tech" value="condenser" /> <span>${t('techCondenser')}</span></label>
            <label class="inline-flex items-center gap-1"><input type="checkbox" class="ts-syn-tech" value="calcine" /> <span>${t('techCalcine')}</span></label>
            <label class="inline-flex items-center gap-1"><input type="checkbox" class="ts-syn-tech" value="gas_dry" /> <span>${t('techGasDry')}</span></label>
          </div>
        </div>`;
    }
    if (a === 'mixture_analysis') {
      return `
        <div class="p-2 rounded-lg border border-theme bg-surface flex flex-col gap-2">
          <div class="grid grid-cols-2 gap-1.5">
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherMixPresetLabel')}</span>
              <select id="ts-mix-preset" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                ${MIXTURE_PRESETS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('')}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherMixVesselLabel')}</span>
              <select id="ts-mix-vid" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                ${vessels.length ? vessels.map((v) => `<option value="${v.id}">${v.label}</option>`).join('') : '<option value="">—</option>'}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">% min / max (A)</span>
              <div class="flex gap-1">
                <input id="ts-mix-min" type="number" value="35" class="w-full px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
                <input id="ts-mix-max" type="number" value="70" class="w-full px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
              </div>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherToleranceLabel')} / g</span>
              <div class="flex gap-1">
                <input id="ts-mix-tol" type="number" step="0.5" value="3" class="w-full px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
                <input id="ts-mix-mass" type="number" step="0.5" value="5.0" class="w-full px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
              </div>
            </label>
          </div>
          <label class="inline-flex items-center gap-1.5 text-[11px] cursor-pointer text-amber-300">
            <input id="ts-mix-syringe" type="checkbox" checked />
            <span>⚠️ ${t('teacherMixSyringeWarn')}</span>
          </label>
        </div>`;
    }
    return `
      <div class="p-2 rounded-lg border border-theme bg-surface flex flex-col gap-2">
        <div class="grid grid-cols-2 gap-1.5">
          <label class="flex flex-col gap-0.5 col-span-2">
            <span class="text-muted">${t('teacherEcPresetLabel')}</span>
            <select id="ts-ec-preset" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
              <option value="voltaic_emf">🔋 ${t('teacherEcVoltaicOpt')}</option>
              <option value="dc_faraday">⚡ ${t('teacherEcFaradayOpt')}</option>
            </select>
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-muted">${t('teacherEcTargetVOrMol')}</span>
            <input id="ts-ec-val" type="number" step="0.01" value="1.10" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-muted">${t('teacherEcTolOrMetal')}</span>
            <input id="ts-ec-extra" type="text" value="0.08" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" placeholder="0.08V or Cu/Ni/H2_g" />
          </label>
        </div>
      </div>`;
  }

  _renderDesignTab(t, vessels) {
    return `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div class="p-3 rounded-xl border border-theme bg-surface-alt flex flex-col gap-2">
          <div class="font-bold text-sm">${t('teacherConfigSection')}</div>
          <div class="flex flex-col gap-1">
            <span class="text-muted">${t('teacherArchetypeLabel')}</span>
            <div class="grid grid-cols-2 gap-1" id="ts-arch-pills">
              ${MISSION_ARCHETYPES.map((ar) => `<button type="button" data-ts-arch="${ar.id}" class="ts-arch-btn px-2 py-1 rounded-lg border text-left text-[11px] font-semibold truncate transition ${
                this.selectedArchetype === ar.id ? 'border-accent bg-accent/15 text-accent' : 'border-theme bg-surface text-muted hover:text-main'
              }">${t(ar.i18nKey)}</button>`).join('')}
            </div>
          </div>
          <label class="flex flex-col gap-0.5">
            <span class="text-muted">${t('teacherTitleLabel')}</span>
            <input id="ts-title" type="text" value="${t('teacherDefaultTitle')}" class="px-2 py-1.5 rounded border border-theme bg-surface text-xs" />
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-muted">${t('teacherGoalLabel')}</span>
            <textarea id="ts-goal" rows="2" class="px-2 py-1 rounded border border-theme bg-surface text-xs">${t('teacherDefaultGoal')}</textarea>
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-muted">${t('teacherEquationLabel')}</span>
            <input id="ts-eq" type="text" placeholder="HCl + NaOH → NaCl + H₂O" class="px-2 py-1 rounded border border-theme bg-surface text-xs font-mono" />
          </label>
          <div class="grid grid-cols-2 gap-2">
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherModeLabel')}</span>
              <select id="ts-mode" class="px-2 py-1 rounded border border-theme bg-surface text-xs">
                <option value="exam">📝 ${t('missionModeExam')}</option>
                <option value="practice">🎯 ${t('missionModePractice')}</option>
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherTimeLimitLabel')}</span>
              <input id="ts-time" type="number" min="0" max="180" value="15" class="px-2 py-1 rounded border border-theme bg-surface text-xs font-mono" />
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherMaxSwitchLabel')}</span>
              <input id="ts-max-sw" type="number" min="1" max="20" value="3" class="px-2 py-1 rounded border border-theme bg-surface text-xs font-mono" />
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherMaxAwayLabel')}</span>
              <input id="ts-max-away" type="number" min="5" max="300" value="20" class="px-2 py-1 rounded border border-theme bg-surface text-xs font-mono" />
            </label>
          </div>
          <div class="flex flex-wrap gap-3 pt-1">
            <label class="inline-flex items-center gap-1.5 cursor-pointer">
              <input id="ts-lock-env" type="checkbox" checked />
              <span>${t('teacherLockEnvLabel')}</span>
            </label>
            <label class="inline-flex items-center gap-1.5 cursor-pointer">
              <input id="ts-fullscreen" type="checkbox" />
              <span>${t('teacherFullscreenLabel')}</span>
            </label>
            <label class="inline-flex items-center gap-1.5 cursor-pointer">
              <input id="ts-autosubmit" type="checkbox" />
              <span>${t('teacherAutoSubmitLabel')}</span>
            </label>
          </div>
        </div>

        <div class="p-3 rounded-xl border border-theme bg-surface-alt flex flex-col gap-2">
          ${this._renderArchetypePanel(t, vessels)}

          <div class="grid grid-cols-2 gap-2 pt-1 border-t border-theme/50">
            <label class="inline-flex items-center gap-1.5 cursor-pointer">
              <input id="ts-limit-shelf" type="checkbox" ${this.selectedArchetype === 'blind_id' && this.selectedTier === 'medium' ? 'checked' : ''} />
              <span>${t('teacherLimitShelfLabel')}</span>
            </label>
            <label class="inline-flex items-center gap-1.5 cursor-pointer">
              <input id="ts-initial-only" type="checkbox" ${this.selectedArchetype === 'blind_id' && this.selectedTier === 'hard' ? 'checked' : ''} />
              <span>🔒 ${t('teacherInitialOnlyLabel')}</span>
            </label>
          </div>
          <div id="ts-shelf-scope-box" class="${this.selectedArchetype === 'blind_id' && this.selectedTier === 'medium' ? '' : 'hidden'} grid grid-cols-2 gap-2 max-h-28 overflow-y-auto p-2 rounded-lg border border-theme bg-surface">
            <div>
              <div class="font-semibold mb-1 text-muted">${t('equipmentTitle')}</div>
              ${APPARATUS_ORDER.slice(0, 16)
                .map((id) => `<label class="flex items-center gap-1 text-[11px]"><input type="checkbox" class="ts-allow-app" value="${id}" checked /> <span class="truncate">${t(APPARATUS[id]?.i18nKey || id)}</span></label>`)
                .join('')}
            </div>
            <div>
              <div class="font-semibold mb-1 text-muted">${t('reagentsTitle')}</div>
              ${STARTER_REAGENTS.slice(0, 16)
                .map((r) => `<label class="flex items-center gap-1 text-[11px]"><input type="checkbox" class="ts-allow-reg" value="${r.id}" checked /> <span class="truncate">${t(r.i18nKey)}</span></label>`)
                .join('')}
            </div>
          </div>
        </div>
      </div>

      ${
        this.lastPublished
          ? `<div class="p-3 rounded-xl border border-emerald-500/45 bg-emerald-500/10 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div>
                <div class="font-bold text-emerald-400">✅ ${t('teacherPublishedBanner')}: <span class="font-mono text-sm">${this.lastPublished.examCode}</span></div>
                <div class="text-[11px] text-muted font-mono">?exam=${this.lastPublished.examCode}</div>
              </div>
              <div class="flex items-center gap-1.5">
                <button type="button" id="btn-ts-copy-link" class="px-2.5 py-1 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent">🔗 ${t('teacherCopyLinkBtn')}</button>
                <button type="button" id="btn-ts-export-exam" class="px-2.5 py-1 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent">💾 .vlab-exam</button>
              </div>
            </div>`
          : ''
      }

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1 border-t border-theme">
        <button type="button" id="btn-ts-download-offline" class="px-3 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-semibold hover:border-accent">💾 ${t('teacherDownloadOfflineBtn')}</button>
        <button type="button" id="btn-ts-publish" class="px-4 py-1.5 rounded-lg bg-accent text-white text-xs font-bold hover:opacity-90">🚀 ${t('teacherPublishBtn')}</button>
      </div>
    `;
  }

  _bindDesignEvents(t, sim, vessels) {
    this.rootEl.querySelectorAll('.ts-arch-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedArchetype = btn.dataset.tsArch;
        this.render();
      });
    });
    this.rootEl.querySelectorAll('.ts-tier-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedTier = btn.dataset.tsTier;
        this.render();
      });
    });
    this.rootEl.querySelector('#ts-limit-shelf')?.addEventListener('change', (e) => {
      this.rootEl.querySelector('#ts-shelf-scope-box')?.classList.toggle('hidden', !e.target.checked);
    });

    const collectSpec = async () => {
      const archetype = this.selectedArchetype || 'blind_id';
      const difficultyTier = this.selectedTier || 'medium';
      const title = this.rootEl.querySelector('#ts-title')?.value?.trim() || 'Practical Exam';
      const goalText = this.rootEl.querySelector('#ts-goal')?.value?.trim() || '';
      const equationText = this.rootEl.querySelector('#ts-eq')?.value?.trim() || '';
      const mode = this.rootEl.querySelector('#ts-mode')?.value || 'exam';
      const timeLimitMin = Math.max(0, Number(this.rootEl.querySelector('#ts-time')?.value) || 0);
      const maxSwitches = Math.max(1, Number(this.rootEl.querySelector('#ts-max-sw')?.value) || 3);
      const maxAwaySec = Math.max(5, Number(this.rootEl.querySelector('#ts-max-away')?.value) || 20);
      const lockEnvironment = Boolean(this.rootEl.querySelector('#ts-lock-env')?.checked);
      const requireFullscreen = Boolean(this.rootEl.querySelector('#ts-fullscreen')?.checked);
      const autoSubmitOnViolation = Boolean(this.rootEl.querySelector('#ts-autosubmit')?.checked);
      const blindDosingMode = archetype === 'standard_prep' ? Boolean(this.rootEl.querySelector('#ts-blind-dosing')?.checked) : false;

      const blindVesselSpecs = [];
      const submitFields = [];
      const rawAnswers = {};
      let titrationConfig = null;
      let standardPrepConfig = null;
      let synthesisConfig = null;
      let mixtureConfig = null;
      let electrochemConfig = null;

      if (archetype === 'blind_id') {
        const chkEls = Array.from(this.rootEl.querySelectorAll('.ts-blind-chk'));
        const optionsPool = [];
        for (const chk of chkEls) {
          if (!chk.checked) continue;
          const vid = chk.dataset.vid;
          const lbl = this.rootEl.querySelector(`.ts-blind-lbl[data-vid="${vid}"]`)?.value?.trim() || '?A';
          const trueName = this.rootEl.querySelector(`.ts-blind-ans[data-vid="${vid}"]`)?.value?.trim() || '';
          blindVesselSpecs.push({ origItemId: vid, blindLabel: lbl, trueName });
          if (trueName && !optionsPool.includes(trueName)) optionsPool.push(trueName);
          rawAnswers[`ans_${lbl}`] = trueName;
        }
        for (const sp of blindVesselSpecs) {
          submitFields.push({
            id: `ans_${sp.blindLabel}`,
            labelKey: sp.blindLabel,
            labelText: sp.blindLabel,
            type: 'select',
            options: optionsPool.length > 0 ? optionsPool : ['HCl', 'NaOH', 'BaCl₂', 'Na₂SO₄'],
          });
        }
      } else if (archetype === 'standard_prep') {
        const targetSpeciesId = this.rootEl.querySelector('#ts-prep-species')?.value || 'Cu2_aq';
        const targetMolarityM = Number(this.rootEl.querySelector('#ts-prep-conc')?.value) || 0.20;
        const concUnit = this.rootEl.querySelector('#ts-prep-unit')?.value || 'M';
        const targetVolumeMl = Number(this.rootEl.querySelector('#ts-prep-vol')?.value) || 100;
        const tolerancePct = Number(this.rootEl.querySelector('#ts-prep-tol')?.value) || 5.0;
        standardPrepConfig = { targetSpeciesId, targetMolarityM, concUnit, targetVolumeMl, tolerancePct };
        submitFields.push({ id: 'ans_mass_g', labelKey: 'm7FieldMassG', type: 'number', min: 0.01, max: 500, step: 0.01, placeholder: '4.99' });
      } else if (archetype === 'titration') {
        const vid = this.rootEl.querySelector('#ts-titr-vid')?.value;
        const analyteKind = this.rootEl.querySelector('#ts-titr-analyte')?.value || 'hcl';
        const titrantReagent = this.rootEl.querySelector('#ts-titr-reagent')?.value || 'naoh';
        const minM = Number(this.rootEl.querySelector('#ts-titr-min')?.value) || 0.08;
        const maxM = Number(this.rootEl.querySelector('#ts-titr-max')?.value) || 0.18;
        const tolerancePct = Number(this.rootEl.querySelector('#ts-titr-tol')?.value) || 2.0;
        if (vid) {
          titrationConfig = { itemId: vid, analyteKind, titrantReagent, minM, maxM, tolerancePct };
          submitFields.push({ id: 'ans_molarity', labelKey: 'm2FieldMolarity', type: 'number', min: 0.01, max: 2.0, step: 0.001, placeholder: '0.120' });
        }
      } else if (archetype === 'synthesis') {
        const targetProductId = this.rootEl.querySelector('#ts-syn-product')?.value || 'CH3COOC2H5_l';
        const minYieldMol = Number(this.rootEl.querySelector('#ts-syn-minmol')?.value) || 0.005;
        const minPurityPct = Number(this.rootEl.querySelector('#ts-syn-minpur')?.value) || 70;
        const techniques = Array.from(this.rootEl.querySelectorAll('.ts-syn-tech:checked')).map((el) => el.value);
        synthesisConfig = { targetProductId, minYieldMol, minPurityPct, techniques };
        submitFields.push({ id: 'ans_product', labelKey: 'm3FieldProduct', type: 'select', options: SYNTHESIS_PRODUCT_PRESETS.map((p) => p.label) });
      } else if (archetype === 'mixture_analysis') {
        const presetId = this.rootEl.querySelector('#ts-mix-preset')?.value || 'fe_cu';
        const preset = MIXTURE_PRESETS.find((m) => m.id === presetId) || MIXTURE_PRESETS[0];
        const vesselId = this.rootEl.querySelector('#ts-mix-vid')?.value || vessels[0]?.id || '';
        const minPctA = Number(this.rootEl.querySelector('#ts-mix-min')?.value) || preset.minPctA;
        const maxPctA = Number(this.rootEl.querySelector('#ts-mix-max')?.value) || preset.maxPctA;
        const tolerancePct = Number(this.rootEl.querySelector('#ts-mix-tol')?.value) || 3.0;
        const totalMassG = Number(this.rootEl.querySelector('#ts-mix-mass')?.value) || preset.defaultMassG;
        const requireGasSyringe = Boolean(this.rootEl.querySelector('#ts-mix-syringe')?.checked);
        mixtureConfig = { vesselId, presetId, spA: preset.spA, spB: preset.spB, minPctA, maxPctA, tolerancePct, totalMassG, requireGasSyringe };
        submitFields.push(
          { id: 'ans_pct_a', labelKey: 'm8FieldPctA', labelText: `%m ${preset.nameA}`, type: 'number', min: 0, max: 100, step: 0.1, placeholder: '50.0' },
          { id: 'ans_pct_b', labelKey: 'm8FieldPctB', labelText: `%m ${preset.nameB}`, type: 'number', min: 0, max: 100, step: 0.1, placeholder: '50.0' }
        );
      } else if (archetype === 'electrochem') {
        const preset = this.rootEl.querySelector('#ts-ec-preset')?.value || 'voltaic_emf';
        const val = Number(this.rootEl.querySelector('#ts-ec-val')?.value) || 1.10;
        const extra = this.rootEl.querySelector('#ts-ec-extra')?.value?.trim() || '0.08';
        electrochemConfig = preset === 'voltaic_emf'
          ? { preset, targetEmfV: val, tolV: Number(extra) || 0.08 }
          : { preset, targetAmountMol: val, targetPlateMetal: ['Cu', 'Ni', 'Ag'].includes(extra) ? extra : null, targetGasId: extra.endsWith('_g') ? extra : null };
        submitFields.push(
          { id: 'ans_anode', labelKey: 'm5FieldAnode', type: 'select', options: ['Zn', 'Fe', 'Ni', 'Cu', 'Ag', 'SHE (Pt|H₂)'] },
          { id: 'ans_emf', labelKey: 'm5FieldEmf', type: 'number', min: 0, max: 12, step: 0.01, placeholder: String(val) }
        );
      }

      const initialOnly = Boolean(this.rootEl.querySelector('#ts-initial-only')?.checked);
      const limitShelf = Boolean(this.rootEl.querySelector('#ts-limit-shelf')?.checked);
      const shelfPolicy = initialOnly ? 'initial_only' : limitShelf ? 'scoped' : 'open';
      const allowedApparatus = initialOnly
        ? []
        : limitShelf
        ? Array.from(this.rootEl.querySelectorAll('.ts-allow-app:checked')).map((el) => el.value)
        : null;
      const allowedReagents = initialOnly
        ? []
        : limitShelf
        ? Array.from(this.rootEl.querySelectorAll('.ts-allow-reg:checked')).map((el) => el.value)
        : null;

      const examCode = `CHEM-${Math.floor(1000 + Math.random() * 9000)}`;
      const benchTemplate = exportSnapshotForSim(sim);
      const answerHashes = await buildHashedAnswerMap(0, rawAnswers);

      const publicDoc = {
        examCode,
        archetype,
        difficultyTier,
        shelfPolicy,
        blindDosingMode,
        title,
        goalText,
        equationText,
        mode,
        timeLimitMin,
        lockEnvironment,
        proctorConfig: { maxSwitches, maxAwaySec, requireFullscreen, autoSubmitOnViolation },
        blindVesselSpecs,
        titrationConfig,
        standardPrepConfig,
        synthesisConfig,
        mixtureConfig,
        electrochemConfig,
        allowedApparatus,
        allowedReagents,
        submitFields,
        answerHashes,
        rubric: [
          { id: 'c_proc', category: 'process', maxPoints: 3.0, labelKey: 'teacherRubProc' },
          { id: 'c_quant', category: 'quantitative', maxPoints: 2.0, labelKey: 'teacherRubQuant' },
          { id: 'c_ident', category: 'identification', maxPoints: 4.0, labelKey: 'teacherRubIdent' },
          { id: 'c_safe', category: 'safety', maxPoints: 1.0, labelKey: 'teacherRubSafe' },
        ],
        benchTemplate,
      };
      return { publicDoc, rawAnswers };
    };

    this.rootEl.querySelector('#btn-ts-publish')?.addEventListener('click', async () => {
      try {
        const { publicDoc, rawAnswers } = await collectSpec();
        const published = await cloudSync.publishAssignment(publicDoc, rawAnswers);
        this.lastPublished = published;
        this.selectedExamCode = published.examCode;
        this.callbacks.onNotify?.(`🚀 ${t('teacherPublishedBanner')}: ${published.examCode}`);
        this.render();
      } catch (err) {
        this.callbacks.onNotify?.(`⚠️ ${err.message || err}`);
      }
    });

    this.rootEl.querySelector('#btn-ts-download-offline')?.addEventListener('click', async () => {
      const { publicDoc } = await collectSpec();
      const fname = exportVlabExamFile(publicDoc);
      if (fname) this.callbacks.onNotify?.(`💾 ${fname}`);
    });

    this.rootEl.querySelector('#btn-ts-copy-link')?.addEventListener('click', () => {
      if (!this.lastPublished) return;
      const url = `${window.location.origin}${window.location.pathname}?exam=${this.lastPublished.examCode}`;
      navigator.clipboard?.writeText(url).catch(() => {});
      this.callbacks.onNotify?.(`🔗 ${url}`);
    });

    this.rootEl.querySelector('#btn-ts-export-exam')?.addEventListener('click', () => {
      if (!this.lastPublished) return;
      const fname = exportVlabExamFile(this.lastPublished);
      if (fname) this.callbacks.onNotify?.(`💾 ${fname}`);
    });
  }

  _renderSubmissionsTab(t) {
    const flagBadge = (sub) => {
      const il = sub.integrityLog || {};
      const lvl = il.flagLevel || 'green';
      const icon = lvl === 'red' ? '🔴' : lvl === 'yellow' ? '🟡' : '🟢';
      const anom = sub.score?.processAnomaly ? ' · ⚠️0P' : '';
      return `<span class="font-mono">${icon} ${il.tabSwitchCount || 0}sw / ${(il.totalAwaySec || 0).toFixed(0)}s${anom}</span>`;
    };
    return `
      <div class="flex flex-col gap-2.5 text-xs">
        <div class="flex flex-wrap items-center gap-2">
          <select id="ts-sub-select" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-mono">
            ${
              this.assignments.length === 0
                ? `<option value="">${t('teacherNoAssignments')}</option>`
                : this.assignments.map((a) => `<option value="${a.examCode}" ${this.selectedExamCode === a.examCode ? 'selected' : ''}>${a.examCode} — ${a.title}</option>`).join('')
            }
          </select>
          <input id="ts-sub-code-inp" type="text" placeholder="CHEM-XXXX" value="${this.selectedExamCode || ''}" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-mono w-32" />
          <button type="button" id="btn-ts-sub-load" class="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-semibold">${t('teacherLoadSubsBtn')}</button>
        </div>

        <div class="overflow-x-auto rounded-xl border border-theme bg-surface-alt">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="border-b border-theme text-muted">
                <th class="p-2">${t('teacherColStudent')}</th>
                <th class="p-2">${t('teacherColScore')}</th>
                <th class="p-2">${t('teacherColProctor')}</th>
                <th class="p-2 text-right">${t('teacherColAction')}</th>
              </tr>
            </thead>
            <tbody>
              ${
                this.submissions.length === 0
                  ? `<tr><td colspan="4" class="p-3 text-center text-muted">${t('teacherNoSubmissions')}</td></tr>`
                  : this.submissions
                      .map((sub, idx) => {
                        const sc = typeof sub.score === 'object' ? sub.score?.totalScore : sub.score;
                        return `<tr class="border-b border-theme/40">
                          <td class="p-2 font-mono">${sub.studentEmail || sub.studentUid}</td>
                          <td class="p-2 font-mono font-bold text-accent">${sc != null ? Number(sc).toFixed(1) : '—'}/10</td>
                          <td class="p-2">${flagBadge(sub)}</td>
                          <td class="p-2 text-right">
                            ${
                              sub.finalSnapshot
                                ? `<button type="button" data-sub-idx="${idx}" class="btn-ts-inspect-sub px-2 py-1 rounded border border-theme bg-surface text-[11px] font-semibold hover:border-accent">🔍 ${t('teacherInspectBenchBtn')}</button>`
                                : '—'
                            }
                          </td>
                        </tr>`;
                      })
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  _bindSubmissionEvents(t) {
    this.rootEl.querySelector('#ts-sub-select')?.addEventListener('change', async (e) => {
      this.selectedExamCode = e.target.value;
      await this.refreshTeacherData();
    });
    this.rootEl.querySelector('#btn-ts-sub-load')?.addEventListener('click', async () => {
      const code = this.rootEl.querySelector('#ts-sub-code-inp')?.value?.trim()?.toUpperCase() || '';
      if (code) {
        this.selectedExamCode = code.startsWith('CHEM-') ? code : `CHEM-${code}`;
        await this.refreshTeacherData();
      }
    });
    this.rootEl.querySelectorAll('.btn-ts-inspect-sub').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sub = this.submissions[Number(btn.dataset.subIdx)];
        if (sub?.finalSnapshot) {
          this.close();
          this.callbacks.onInspectSubmissionSnapshot?.(sub.finalSnapshot, sub);
        }
      });
    });
  }
}
