/**
 * Teacher Studio & Classroom Assessment Manager (Prompt 93 Upgrade).
 * - Responsive scrollable .tb-studio-shell with pinned header & footer across Desktop/Tablet/Mobile.
 * - Left pane: Assignment configuration, 6 Archetypes, Proctoring & Shelf Rules.
 * - Right pane: Live isolated Interactive Authoring Bench (LabSimulation + LabWorkbenchCanvas)
 *   supporting Clone Active Lab, Spawn Archetype Preset, Quick Add/Dose, 2-way ?A/?B blind tagging,
 *   Student View Preview, Play/Pause, Test Run Exam, Publish CHEM-XXXX & Offline .vlab-exam export.
 */
import { APPARATUS, APPARATUS_ORDER } from '../data/apparatus.js';
import { isThemeDark } from '../data/constants.js';
import {
  MISSION_ARCHETYPES,
  MIXTURE_PRESETS,
  STANDARD_PREP_TARGETS,
  SYNTHESIS_PRODUCT_PRESETS,
} from '../data/missions.js';
import { STARTER_REAGENTS } from '../data/species.js';
import { LabSimulation } from '../engine/simulation.js';
import { exportSnapshotForSim, restoreSnapshotForSim } from '../engine/simSnapshot.js';
import { buildHashedAnswerMap } from '../engine/examProctor.js';
import { ParticleSystem } from '../canvas/particles.js';
import { LabWorkbenchCanvas } from '../canvas/workbench.js';
import { cloudSync, exportVlabExamFile } from '../storage/workspaceStorage.js';

const QUICK_AUTHOR_APPARATUS = [
  'beaker_250',
  'erlenmeyer_250',
  'round_flask_250',
  'test_tube',
  'cylinder_100',
  'burette_50',
  'pipette_10',
  'separatory_funnel',
  'filter_funnel',
  'gas_syringe',
  'scale',
  'burner',
  'retort_stand',
  'liebig_condenser',
  'rubber_stopper',
  'electrode_rod',
  'salt_bridge',
  'volt_ammeter',
  'dc_power',
];

export class TeacherBuilderModal {
  constructor(rootEl, labManager, getLang, callbacks = {}) {
    this.rootEl = rootEl;
    this.labManager = labManager;
    this.getLang = getLang;
    this.callbacks = callbacks; // { onNotify, onInspectSubmissionSnapshot, onTestRunAssignment }
    this.activeTab = 'design'; // 'design' | 'submissions'
    this.selectedArchetype = 'blind_id';
    this.selectedTier = 'medium';
    this.selectedExamCode = '';
    this.assignments = [];
    this.submissions = [];
    this.lastPublished = null;

    // Isolated interactive authoring bench state
    this.draftSim = new LabSimulation();
    this.draftSim.setupPreset('clean');
    this.draftSim.environment.paused = true;
    this.draftParticles = new ParticleSystem();
    this.draftWorkbench = null;
    this._draftRafId = 0;
    this._draftLastMs = 0;
    this._draftResizeObs = null;

    // Persistent form + 2-way blind vessel map so UI re-renders never wipe teacher edits
    this.blindTagToolActive = false;
    this.studentPreviewMode = false;
    this.blindDraftMap = {}; // vesselId -> { checked, blindLabel, trueName }
    this.formState = null;
  }

  _ensureFormState(t) {
    if (this.formState) return this.formState;
    this.formState = {
      title: t('teacherDefaultTitle'),
      goal: t('teacherDefaultGoal'),
      equation: '',
      mode: 'exam',
      time: 15,
      maxSw: 3,
      maxAway: 20,
      lockEnv: true,
      fullscreen: false,
      autoSubmit: false,
      blindDosing: true,
      limitShelf: this.selectedTier === 'medium',
      initialOnly: this.selectedTier === 'hard',
      prepSpecies: 'Cu2_aq',
      prepConc: 0.2,
      prepUnit: 'M',
      prepVol: 100,
      prepTol: 5,
      titrAnalyte: 'hcl',
      titrReagent: 'naoh',
      titrVid: '',
      titrMin: 0.08,
      titrMax: 0.18,
      titrTol: 2,
      synProduct: 'CH3COOC2H5_l',
      synMinMol: 0.005,
      synMinPur: 70,
      synTechs: [],
      mixPreset: 'fe_cu',
      mixVid: '',
      mixMin: 35,
      mixMax: 70,
      mixTol: 3,
      mixMass: 5.0,
      mixSyringe: true,
      ecPreset: 'voltaic_emf',
      ecVal: 1.1,
      ecExtra: '0.08',
      allowedApps: new Set(APPARATUS_ORDER),
      allowedRegs: new Set(STARTER_REAGENTS.map((r) => r.id)),
    };
    return this.formState;
  }

  _captureFormToState() {
    if (!this.rootEl || !this.formState) return;
    const q = (sel) => this.rootEl.querySelector(sel);
    const fs = this.formState;
    if (q('#ts-title')) fs.title = q('#ts-title').value;
    if (q('#ts-goal')) fs.goal = q('#ts-goal').value;
    if (q('#ts-eq')) fs.equation = q('#ts-eq').value;
    if (q('#ts-mode')) fs.mode = q('#ts-mode').value;
    if (q('#ts-time')) fs.time = Number(q('#ts-time').value) || 0;
    if (q('#ts-max-sw')) fs.maxSw = Number(q('#ts-max-sw').value) || 3;
    if (q('#ts-max-away')) fs.maxAway = Number(q('#ts-max-away').value) || 20;
    if (q('#ts-lock-env')) fs.lockEnv = Boolean(q('#ts-lock-env').checked);
    if (q('#ts-fullscreen')) fs.fullscreen = Boolean(q('#ts-fullscreen').checked);
    if (q('#ts-autosubmit')) fs.autoSubmit = Boolean(q('#ts-autosubmit').checked);
    if (q('#ts-blind-dosing')) fs.blindDosing = Boolean(q('#ts-blind-dosing').checked);
    if (q('#ts-limit-shelf')) fs.limitShelf = Boolean(q('#ts-limit-shelf').checked);
    if (q('#ts-initial-only')) fs.initialOnly = Boolean(q('#ts-initial-only').checked);

    if (q('#ts-prep-species')) fs.prepSpecies = q('#ts-prep-species').value;
    if (q('#ts-prep-conc')) fs.prepConc = Number(q('#ts-prep-conc').value) || 0.2;
    if (q('#ts-prep-unit')) fs.prepUnit = q('#ts-prep-unit').value;
    if (q('#ts-prep-vol')) fs.prepVol = Number(q('#ts-prep-vol').value) || 100;
    if (q('#ts-prep-tol')) fs.prepTol = Number(q('#ts-prep-tol').value) || 5;

    if (q('#ts-titr-analyte')) fs.titrAnalyte = q('#ts-titr-analyte').value;
    if (q('#ts-titr-reagent')) fs.titrReagent = q('#ts-titr-reagent').value;
    if (q('#ts-titr-vid')) fs.titrVid = q('#ts-titr-vid').value;
    if (q('#ts-titr-min')) fs.titrMin = Number(q('#ts-titr-min').value) || 0.08;
    if (q('#ts-titr-max')) fs.titrMax = Number(q('#ts-titr-max').value) || 0.18;
    if (q('#ts-titr-tol')) fs.titrTol = Number(q('#ts-titr-tol').value) || 2;

    if (q('#ts-syn-product')) fs.synProduct = q('#ts-syn-product').value;
    if (q('#ts-syn-minmol')) fs.synMinMol = Number(q('#ts-syn-minmol').value) || 0.005;
    if (q('#ts-syn-minpur')) fs.synMinPur = Number(q('#ts-syn-minpur').value) || 70;
    const synChks = this.rootEl.querySelectorAll('.ts-syn-tech');
    if (synChks.length > 0) {
      fs.synTechs = Array.from(synChks).filter((el) => el.checked).map((el) => el.value);
    }

    if (q('#ts-mix-preset')) fs.mixPreset = q('#ts-mix-preset').value;
    if (q('#ts-mix-vid')) fs.mixVid = q('#ts-mix-vid').value;
    if (q('#ts-mix-min')) fs.mixMin = Number(q('#ts-mix-min').value) || 35;
    if (q('#ts-mix-max')) fs.mixMax = Number(q('#ts-mix-max').value) || 70;
    if (q('#ts-mix-tol')) fs.mixTol = Number(q('#ts-mix-tol').value) || 3;
    if (q('#ts-mix-mass')) fs.mixMass = Number(q('#ts-mix-mass').value) || 5.0;
    if (q('#ts-mix-syringe')) fs.mixSyringe = Boolean(q('#ts-mix-syringe').checked);

    if (q('#ts-ec-preset')) fs.ecPreset = q('#ts-ec-preset').value;
    if (q('#ts-ec-val')) fs.ecVal = Number(q('#ts-ec-val').value) || 1.1;
    if (q('#ts-ec-extra')) fs.ecExtra = q('#ts-ec-extra').value;

    const appChks = this.rootEl.querySelectorAll('.ts-allow-app');
    if (appChks.length > 0) {
      fs.allowedApps = new Set(Array.from(appChks).filter((el) => el.checked).map((el) => el.value));
    }
    const regChks = this.rootEl.querySelectorAll('.ts-allow-reg');
    if (regChks.length > 0) {
      fs.allowedRegs = new Set(Array.from(regChks).filter((el) => el.checked).map((el) => el.value));
    }

    this.rootEl.querySelectorAll('.ts-blind-chk').forEach((chk) => {
      const vid = chk.dataset.vid;
      if (!vid) return;
      const lbl = this.rootEl.querySelector(`.ts-blind-lbl[data-vid="${vid}"]`)?.value?.trim() || '?A';
      const ans = this.rootEl.querySelector(`.ts-blind-ans[data-vid="${vid}"]`)?.value?.trim() || '';
      this.blindDraftMap[vid] = { checked: chk.checked, blindLabel: lbl, trueName: ans };
    });
    this._syncBlindFlagsOnDraftSim();
  }

  _syncBlindFlagsOnDraftSim() {
    const vessels = (this.draftSim?.items || []).filter((i) => i.kind === 'vessel' && !i.isShattered);
    let nextIdx = 0;
    for (const v of vessels) {
      if (!this.blindDraftMap[v.id]) {
        const defaultChar = String.fromCharCode(65 + (nextIdx % 26));
        this.blindDraftMap[v.id] = {
          checked: nextIdx < 4,
          blindLabel: v.blindLabel || `?${defaultChar}`,
          trueName: '',
        };
      }
      nextIdx++;
      const meta = this.blindDraftMap[v.id];
      if (this.studentPreviewMode && this.selectedArchetype === 'blind_id' && meta.checked) {
        v.hideComposition = true;
        v.blindLabel = meta.blindLabel || '?A';
      } else {
        v.hideComposition = false;
        if (meta.checked && meta.blindLabel) {
          v.blindLabel = meta.blindLabel;
          if (!v.stickyLabel?.text || /^\?[A-Z]/.test(v.stickyLabel.text)) {
            v.stickyLabel = { text: meta.blindLabel, bgColor: '#fde68a' };
          }
        }
      }
    }
  }

  _nextBlindLetter() {
    const used = new Set(
      Object.values(this.blindDraftMap || {})
        .filter((m) => m.checked && m.blindLabel)
        .map((m) => m.blindLabel.trim())
    );
    for (let i = 0; i < 26; i++) {
      const cand = `?${String.fromCharCode(65 + i)}`;
      if (!used.has(cand)) return cand;
    }
    return `?${used.size + 1}`;
  }

  _cloneMainBenchIntoDraft() {
    const mainSim = this.labManager?.getActiveWorkbenchLab?.()?.sim || this.labManager?.getActiveSim?.();
    if (!mainSim) return;
    const snap = exportSnapshotForSim(mainSim);
    restoreSnapshotForSim(this.draftSim, snap);
    this.draftSim.environment.paused = true;
    this.blindDraftMap = {};
    this._syncBlindFlagsOnDraftSim();
  }

  _spawnArchetypeTemplateOnDraft() {
    const sim = this.draftSim;
    sim.setupPreset('clean');
    sim.environment.paused = true;
    this.blindDraftMap = {};
    const a = this.selectedArchetype || 'blind_id';
    if (a === 'blind_id') {
      const vA = sim.createApparatus('beaker_250', 220, 420, { silentUndo: true });
      sim.addReagentToVessel(vA.id, 'hcl_37', 15, { silentAnim: true });
      const vB = sim.createApparatus('beaker_250', 440, 420, { silentUndo: true });
      sim.addReagentToVessel(vB.id, 'naoh', 15, { silentAnim: true });
      const vC = sim.createApparatus('beaker_250', 660, 420, { silentUndo: true });
      sim.addReagentToVessel(vC.id, 'bacl2_2h2o', 4, { silentAnim: true });
      sim.addReagentToVessel(vC.id, 'h2o', 25, { silentAnim: true });
      this.blindDraftMap[vA.id] = { checked: true, blindLabel: '?A', trueName: 'HCl' };
      this.blindDraftMap[vB.id] = { checked: true, blindLabel: '?B', trueName: 'NaOH' };
      this.blindDraftMap[vC.id] = { checked: true, blindLabel: '?C', trueName: 'BaCl₂' };
    } else if (a === 'standard_prep') {
      const b = sim.createApparatus('beaker_250', 360, 420, { silentUndo: true });
      b.label = 'Prep-100mL';
      sim.createApparatus('scale', 210, 442, { silentUndo: true });
      sim.createApparatus('cylinder_100', 520, 420, { silentUndo: true });
      sim.createApparatus('wash_bottle', 660, 415, { silentUndo: true });
    } else if (a === 'titration') {
      const st = sim.createApparatus('retort_stand', 380, 345, { silentUndo: true });
      const bur = sim.createApparatus('burette_50', 380, 210, { silentUndo: true });
      bur.clampedToId = st.id;
      const erl = sim.createApparatus('erlenmeyer_250', 380, 430, { silentUndo: true });
      erl.moles = { H2O_l: 1.4, H_aq: 0.003, Cl_aq: 0.003, Phenolphthalein_aq: 0.0002 };
      erl.label = '?X';
      if (this.formState) this.formState.titrVid = erl.id;
    } else if (a === 'synthesis') {
      sim.createApparatus('burner', 320, 445, { silentUndo: true });
      sim.createApparatus('round_flask_250', 320, 345, { silentUndo: true });
      sim.createApparatus('separatory_funnel', 540, 345, { silentUndo: true });
      sim.createApparatus('beaker_250', 720, 420, { silentUndo: true });
    } else if (a === 'mixture_analysis') {
      const fl = sim.createApparatus('erlenmeyer_250', 300, 415, { silentUndo: true });
      fl.moles = { Fe_s: 0.045, Cu_s: 0.039 };
      fl.label = 'Mix (5.0 g)';
      sim.createApparatus('gas_syringe', 560, 405, { silentUndo: true });
      sim.createApparatus('rubber_stopper', 420, 440, { silentUndo: true });
      if (this.formState) this.formState.mixVid = fl.id;
    } else if (a === 'electrochem') {
      const bL = sim.createApparatus('beaker_250', 270, 420, { silentUndo: true });
      bL.moles = { H2O_l: 5.5, Zn2_aq: 0.1, SO4_2_aq: 0.1 };
      const bR = sim.createApparatus('beaker_250', 510, 420, { silentUndo: true });
      bR.moles = { H2O_l: 5.5, Cu2_aq: 0.1, SO4_2_aq: 0.1 };
      const eL = sim.createApparatus('electrode_rod', 270, 360, { silentUndo: true });
      sim.setElectrodeMaterial(eL.id, 'Zn');
      eL.dockedVesselId = bL.id;
      const eR = sim.createApparatus('electrode_rod', 510, 360, { silentUndo: true });
      sim.setElectrodeMaterial(eR.id, 'Cu');
      eR.dockedVesselId = bR.id;
      const sb = sim.createApparatus('salt_bridge', 390, 378, { silentUndo: true });
      sb.vesselAId = bL.id;
      sb.vesselBId = bR.id;
      const dmm = sim.createApparatus('volt_ammeter', 390, 235, { silentUndo: true });
      dmm.mode = 'voltmeter';
      dmm.posElectrodeId = eR.id;
      dmm.negElectrodeId = eL.id;
    }
    sim.updateSupportAttachments();
    sim.recomputeScaleReadings();
    this._syncBlindFlagsOnDraftSim();
  }

  _stopDraftLoop() {
    if (this._draftRafId) {
      cancelAnimationFrame(this._draftRafId);
      this._draftRafId = 0;
    }
    if (this._draftResizeObs) {
      this._draftResizeObs.disconnect();
      this._draftResizeObs = null;
    }
    this.draftWorkbench = null;
  }

  _mountDraftCanvas(t) {
    this._stopDraftLoop();
    const cvs = this.rootEl?.querySelector('#ts-author-canvas');
    if (!cvs) return;
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const isDark = isThemeDark(theme);
    const langCode = document.documentElement.lang === 'en' ? 'en' : 'vi';
    this.draftParticles.setTheme(isDark);
    this.draftWorkbench = new LabWorkbenchCanvas(cvs, this.draftSim, this.draftParticles, {
      onSelect: (selectedItem) => {
        if (this.blindTagToolActive && selectedItem?.kind === 'vessel') {
          const cur = this.blindDraftMap[selectedItem.id];
          if (cur?.checked) {
            cur.checked = false;
            selectedItem.hideComposition = false;
            delete selectedItem.stickyLabel;
          } else {
            this.blindDraftMap[selectedItem.id] = {
              checked: true,
              blindLabel: cur?.blindLabel || this._nextBlindLetter(),
              trueName: cur?.trueName || '',
            };
          }
          this._syncBlindFlagsOnDraftSim();
          this._captureFormToState();
          this.render();
          this.callbacks.onNotify?.(
            this.blindDraftMap[selectedItem.id]?.checked
              ? `🏷️ ${this.blindDraftMap[selectedItem.id].blindLabel}`
              : '🏷️ Untapped'
          );
        } else {
          this._updateQuickDraftSelectionBadge(t);
        }
      },
    });
    this.draftWorkbench.setTheme(isDark, theme);
    this.draftWorkbench.setLang(langCode);
    this.draftWorkbench.resize();

    if (typeof ResizeObserver !== 'undefined' && cvs.parentElement) {
      this._draftResizeObs = new ResizeObserver(() => {
        this.draftWorkbench?.resize();
      });
      this._draftResizeObs.observe(cvs.parentElement);
    }

    this._draftLastMs = performance.now();
    const tick = (now) => {
      if (!this.rootEl || this.rootEl.classList.contains('hidden') || this.activeTab !== 'design' || !this.draftWorkbench) {
        this._draftRafId = 0;
        return;
      }
      const dt = Math.min(0.05, Math.max(0.001, (now - this._draftLastMs) / 1000));
      this._draftLastMs = now;
      if (!this.draftSim.environment.paused) {
        this.draftSim.step(dt);
        this.draftParticles.update(dt * (this.draftSim.environment.speed || 1));
      } else {
        // Still run lightweight gravity/drag alignment while paused during authoring
        this.draftSim.stepGravityPhysics?.(dt, dt);
        this.draftSim.syncAttachedMouthTools?.();
      }
      this.draftWorkbench.render(now / 1000);
      this._draftRafId = requestAnimationFrame(tick);
    };
    this._draftRafId = requestAnimationFrame(tick);
  }

  _updateQuickDraftSelectionBadge(t) {
    const badge = this.rootEl?.querySelector('#ts-draft-sel-badge');
    if (!badge) return;
    const sel = this.draftSim.getItem(this.draftSim.selectedId);
    if (!sel) {
      badge.textContent = t('teacherNoVesselsHint').split('.')[0];
      return;
    }
    const spec = APPARATUS[sel.typeId];
    badge.textContent = `${spec ? t(spec.i18nKey) : sel.typeId} ${sel.label}`;
  }

  close() {
    this._stopDraftLoop();
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
    this._ensureFormState(this.getLang());
    // Seed draft bench from active bench on initial open if draft bench is empty
    if ((this.draftSim.items || []).length === 0) {
      this._cloneMainBenchIntoDraft();
    }
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
    const fs = this._ensureFormState(t);
    this._syncBlindFlagsOnDraftSim();
    const vessels = (this.draftSim?.items || []).filter((i) => i.kind === 'vessel' && !i.isShattered);

    this.rootEl.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-2 sm:p-3';
    this.rootEl.innerHTML = `
      <div class="tb-studio-shell" role="dialog" aria-modal="true">
        <div class="tb-studio-header">
          <div>
            <h2 class="text-base font-bold leading-tight">🎓 ${t('teacherStudioTitle')}</h2>
            <p class="text-[11px] text-muted">${cloudSync.user?.email || ''} · <span class="text-emerald-400 font-semibold">teacher</span></p>
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

        <div class="tb-studio-body ${this.activeTab === 'design' ? 'tb-mode-design' : ''}">
          ${this.activeTab === 'design' ? this._renderDesignTab(t, fs, vessels) : this._renderSubmissionsTab(t)}
        </div>

        ${
          this.activeTab === 'design'
            ? `<div class="tb-studio-footer">
                <div class="flex flex-wrap items-center gap-2 text-xs">
                  ${
                    this.lastPublished
                      ? `<span class="px-2 py-1 rounded-lg border border-emerald-500/45 bg-emerald-500/10 text-emerald-400 font-mono font-bold">✅ ${this.lastPublished.examCode}</span>
                         <button type="button" id="btn-ts-copy-link" class="px-2 py-1 rounded-lg border border-theme bg-surface-alt text-xs font-semibold hover:border-accent">🔗 ${t('teacherCopyLinkBtn')}</button>
                         <button type="button" id="btn-ts-export-exam" class="px-2 py-1 rounded-lg border border-theme bg-surface-alt text-xs font-semibold hover:border-accent">💾 .vlab-exam</button>`
                      : `<span class="text-[11px] text-muted">${vessels.length} vessels · ${(this.draftSim?.items || []).length} items</span>`
                  }
                </div>
                <div class="flex flex-wrap items-center gap-2 ml-auto">
                  <button type="button" id="btn-ts-test-run" class="px-3 py-1.5 rounded-lg border border-sky-500/50 bg-sky-500/15 text-sky-400 text-xs font-bold hover:opacity-90">▶ ${t('teacherTestRunBtn')}</button>
                  <button type="button" id="btn-ts-download-offline" class="px-3 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-semibold hover:border-accent">💾 ${t('teacherDownloadOfflineBtn')}</button>
                  <button type="button" id="btn-ts-publish" class="px-4 py-1.5 rounded-lg bg-accent text-white text-xs font-bold hover:opacity-90">🚀 ${t('teacherPublishBtn')}</button>
                </div>
              </div>`
            : ''
        }
      </div>
    `;

    this.rootEl.querySelector('#btn-ts-close')?.addEventListener('click', () => this.close());
    this.rootEl.querySelectorAll('.ts-tab-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (this.activeTab === 'design') this._captureFormToState();
        this.activeTab = btn.dataset.tsTab;
        if (this.activeTab === 'submissions') {
          this._stopDraftLoop();
          await this.refreshTeacherData();
        } else {
          this.render();
        }
      });
    });

    if (this.activeTab === 'design') {
      this._bindDesignEvents(t, vessels);
      this._mountDraftCanvas(t);
    } else {
      this._bindSubmissionEvents(t);
    }
  }

  _renderArchetypePanel(t, fs, vessels) {
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
              ? `<p class="text-[11px] text-muted">${t('teacherNoVesselsHint')}</p>`
              : vessels
                  .map((v, idx) => {
                    const meta = this.blindDraftMap[v.id] || { checked: idx < 4, blindLabel: `?${String.fromCharCode(65 + idx)}`, trueName: '' };
                    const esc = (s) => String(s || '').replace(/"/g, '&quot;');
                    return `
                <div class="p-1.5 rounded-lg border border-theme bg-surface flex items-center gap-1.5">
                  <input type="checkbox" class="ts-blind-chk" data-vid="${v.id}" ${meta.checked ? 'checked' : ''} />
                  <span class="font-mono text-[11px] font-bold shrink-0">${t(APPARATUS[v.typeId]?.i18nKey || v.typeId)} ${v.label}</span>
                  <input type="text" class="ts-blind-lbl w-12 px-1 py-0.5 rounded border border-theme bg-surface-alt font-mono text-xs" data-vid="${v.id}" value="${esc(meta.blindLabel)}" />
                  <input type="text" class="ts-blind-ans flex-1 min-w-0 px-1.5 py-0.5 rounded border border-theme bg-surface-alt text-xs" data-vid="${v.id}" value="${esc(meta.trueName)}" placeholder="${t('teacherTrueNamePlaceholder')}" />
                </div>`;
                  })
                  .join('')
          }
        </div>`;
    }
    if (a === 'standard_prep') {
      return `
        <div class="p-2 rounded-lg border border-theme bg-surface flex flex-col gap-2">
          <label class="inline-flex items-center gap-1.5 cursor-pointer font-semibold text-sky-400">
            <input id="ts-blind-dosing" type="checkbox" ${fs.blindDosing ? 'checked' : ''} />
            <span>🙈 ${t('teacherBlindDosingLabel')}</span>
          </label>
          <div class="grid grid-cols-2 gap-1.5">
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherTargetSoluteLabel')}</span>
              <select id="ts-prep-species" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                ${STANDARD_PREP_TARGETS.map((s) => `<option value="${s.id}" ${fs.prepSpecies === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherPrepConcLabel')}</span>
              <div class="flex gap-1">
                <input id="ts-prep-conc" type="number" step="0.01" value="${fs.prepConc}" class="w-full px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
                <select id="ts-prep-unit" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                  <option value="M" ${fs.prepUnit === 'M' ? 'selected' : ''}>M</option>
                  <option value="w%" ${fs.prepUnit === 'w%' ? 'selected' : ''}>%w/w</option>
                </select>
              </div>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherPrepVolLabel')}</span>
              <input id="ts-prep-vol" type="number" step="5" value="${fs.prepVol}" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherToleranceLabel')}</span>
              <input id="ts-prep-tol" type="number" step="0.5" value="${fs.prepTol}" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
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
                ${[
                  ['hcl', 'HCl (?X)'],
                  ['ch3cooh', 'CH₃COOH (?X)'],
                  ['h2so4', 'H₂SO₄ (?X)'],
                  ['fe2_redox', 'Fe²⁺ / H₂SO₄ (Redox)'],
                  ['i2_redox', 'I₂ / KI (Redox)'],
                ]
                  .map(([v, lbl]) => `<option value="${v}" ${fs.titrAnalyte === v ? 'selected' : ''}>${lbl}</option>`)
                  .join('')}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherTitrBuretteLabel')}</span>
              <select id="ts-titr-reagent" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                ${[
                  ['naoh', 'NaOH (Burette)'],
                  ['hcl', 'HCl (Burette)'],
                  ['kmno4_h2so4', 'KMnO₄ / H⁺ (Redox)'],
                ]
                  .map(([v, lbl]) => `<option value="${v}" ${fs.titrReagent === v ? 'selected' : ''}>${lbl}</option>`)
                  .join('')}
              </select>
            </label>
          </div>
          <div class="grid grid-cols-4 gap-1.5">
            <select id="ts-titr-vid" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
              ${vessels.length ? vessels.map((v) => `<option value="${v.id}" ${fs.titrVid === v.id ? 'selected' : ''}>${v.label}</option>`).join('') : '<option value="">—</option>'}
            </select>
            <input id="ts-titr-min" type="number" step="0.01" value="${fs.titrMin}" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" title="Min M" />
            <input id="ts-titr-max" type="number" step="0.01" value="${fs.titrMax}" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" title="Max M" />
            <input id="ts-titr-tol" type="number" step="0.5" value="${fs.titrTol}" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" title="Tol %" />
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
                ${SYNTHESIS_PRODUCT_PRESETS.map((p) => `<option value="${p.id}" ${fs.synProduct === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherMinMolLabel')}</span>
              <input id="ts-syn-minmol" type="number" step="0.001" value="${fs.synMinMol}" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherMinPurLabel')}</span>
              <input id="ts-syn-minpur" type="number" step="5" value="${fs.synMinPur}" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
            </label>
          </div>
          <div class="flex flex-wrap gap-2 text-[11px]">
            ${[
              ['filter', 'techFilter'],
              ['sep_funnel', 'techSepFunnel'],
              ['condenser', 'techCondenser'],
              ['calcine', 'techCalcine'],
              ['gas_dry', 'techGasDry'],
            ]
              .map(
                ([val, key]) => `<label class="inline-flex items-center gap-1"><input type="checkbox" class="ts-syn-tech" value="${val}" ${fs.synTechs.includes(val) ? 'checked' : ''} /> <span>${t(key)}</span></label>`
              )
              .join('')}
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
                ${MIXTURE_PRESETS.map((m) => `<option value="${m.id}" ${fs.mixPreset === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherMixVesselLabel')}</span>
              <select id="ts-mix-vid" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono">
                ${vessels.length ? vessels.map((v) => `<option value="${v.id}" ${fs.mixVid === v.id ? 'selected' : ''}>${v.label}</option>`).join('') : '<option value="">—</option>'}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">% min / max (A)</span>
              <div class="flex gap-1">
                <input id="ts-mix-min" type="number" value="${fs.mixMin}" class="w-full px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
                <input id="ts-mix-max" type="number" value="${fs.mixMax}" class="w-full px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
              </div>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-muted">${t('teacherToleranceLabel')} / g</span>
              <div class="flex gap-1">
                <input id="ts-mix-tol" type="number" step="0.5" value="${fs.mixTol}" class="w-full px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
                <input id="ts-mix-mass" type="number" step="0.5" value="${fs.mixMass}" class="w-full px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
              </div>
            </label>
          </div>
          <label class="inline-flex items-center gap-1.5 text-[11px] cursor-pointer text-amber-400">
            <input id="ts-mix-syringe" type="checkbox" ${fs.mixSyringe ? 'checked' : ''} />
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
              <option value="voltaic_emf" ${fs.ecPreset === 'voltaic_emf' ? 'selected' : ''}>🔋 ${t('teacherEcVoltaicOpt')}</option>
              <option value="dc_faraday" ${fs.ecPreset === 'dc_faraday' ? 'selected' : ''}>⚡ ${t('teacherEcFaradayOpt')}</option>
            </select>
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-muted">${t('teacherEcTargetVOrMol')}</span>
            <input id="ts-ec-val" type="number" step="0.01" value="${fs.ecVal}" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" />
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-muted">${t('teacherEcTolOrMetal')}</span>
            <input id="ts-ec-extra" type="text" value="${String(fs.ecExtra || '').replace(/"/g, '&quot;')}" class="px-1.5 py-1 rounded border border-theme bg-surface-alt text-xs font-mono" placeholder="0.08V or Cu/Ni/H2_g" />
          </label>
        </div>
      </div>`;
  }

  _renderDesignTab(t, fs, vessels) {
    const esc = (s) => String(s ?? '').replace(/"/g, '&quot;');
    const isPaused = Boolean(this.draftSim?.environment?.paused);
    const shelfPolicyTxt = fs.initialOnly ? 'initial_only' : fs.limitShelf ? 'scoped' : 'open';

    return `
      <div class="tb-studio-split text-xs">
        <!-- LEFT PANE: Assignment Rules & Archetype Config -->
        <div class="tb-studio-left">
          <details open class="tb-section-card">
            <summary>📋 ${t('teacherConfigSection')} <span class="text-[10.5px] font-mono text-accent">${this.selectedArchetype}</span></summary>
            <div class="flex flex-col gap-2 pt-2">
              <div class="grid grid-cols-2 gap-1" id="ts-arch-pills">
                ${MISSION_ARCHETYPES.map((ar) => `<button type="button" data-ts-arch="${ar.id}" class="ts-arch-btn px-2 py-1 rounded-lg border text-left text-[11px] font-semibold truncate transition ${
                  this.selectedArchetype === ar.id ? 'border-accent bg-accent/15 text-accent' : 'border-theme bg-surface text-muted hover:text-main'
                }">${t(ar.i18nKey)}</button>`).join('')}
              </div>
              <label class="flex flex-col gap-0.5">
                <span class="text-muted">${t('teacherTitleLabel')}</span>
                <input id="ts-title" type="text" value="${esc(fs.title)}" class="px-2 py-1 rounded border border-theme bg-surface text-xs" />
              </label>
              <label class="flex flex-col gap-0.5">
                <span class="text-muted">${t('teacherGoalLabel')}</span>
                <textarea id="ts-goal" rows="2" class="px-2 py-1 rounded border border-theme bg-surface text-xs">${fs.goal}</textarea>
              </label>
              <label class="flex flex-col gap-0.5">
                <span class="text-muted">${t('teacherEquationLabel')}</span>
                <input id="ts-eq" type="text" value="${esc(fs.equation)}" placeholder="HCl + NaOH → NaCl + H₂O" class="px-2 py-1 rounded border border-theme bg-surface text-xs font-mono" />
              </label>
            </div>
          </details>

          <details open class="tb-section-card">
            <summary>🔬 ${t(MISSION_ARCHETYPES.find((x) => x.id === this.selectedArchetype)?.i18nKey || 'teacherArchetypeLabel')}</summary>
            <div class="flex flex-col gap-2 pt-2">
              ${this._renderArchetypePanel(t, fs, vessels)}
            </div>
          </details>

          <details class="tb-section-card" open>
            <summary>🛡️ ${t('teacherSectionModeProctor')} <span class="text-[10.5px] font-mono text-muted">${fs.mode} · ${fs.time}m</span></summary>
            <div class="flex flex-col gap-2 pt-2">
              <div class="grid grid-cols-2 gap-1.5">
                <label class="flex flex-col gap-0.5">
                  <span class="text-muted">${t('teacherModeLabel')}</span>
                  <select id="ts-mode" class="px-2 py-1 rounded border border-theme bg-surface text-xs">
                    <option value="exam" ${fs.mode === 'exam' ? 'selected' : ''}>📝 ${t('missionModeExam')}</option>
                    <option value="practice" ${fs.mode === 'practice' ? 'selected' : ''}>🎯 ${t('missionModePractice')}</option>
                  </select>
                </label>
                <label class="flex flex-col gap-0.5">
                  <span class="text-muted">${t('teacherTimeLimitLabel')}</span>
                  <input id="ts-time" type="number" min="0" max="180" value="${fs.time}" class="px-2 py-1 rounded border border-theme bg-surface text-xs font-mono" />
                </label>
                <label class="flex flex-col gap-0.5">
                  <span class="text-muted">${t('teacherMaxSwitchLabel')}</span>
                  <input id="ts-max-sw" type="number" min="1" max="20" value="${fs.maxSw}" class="px-2 py-1 rounded border border-theme bg-surface text-xs font-mono" />
                </label>
                <label class="flex flex-col gap-0.5">
                  <span class="text-muted">${t('teacherMaxAwayLabel')}</span>
                  <input id="ts-max-away" type="number" min="5" max="300" value="${fs.maxAway}" class="px-2 py-1 rounded border border-theme bg-surface text-xs font-mono" />
                </label>
              </div>
              <div class="flex flex-wrap gap-2.5 pt-0.5">
                <label class="inline-flex items-center gap-1 cursor-pointer"><input id="ts-lock-env" type="checkbox" ${fs.lockEnv ? 'checked' : ''} /> <span>${t('teacherLockEnvLabel')}</span></label>
                <label class="inline-flex items-center gap-1 cursor-pointer"><input id="ts-fullscreen" type="checkbox" ${fs.fullscreen ? 'checked' : ''} /> <span>${t('teacherFullscreenLabel')}</span></label>
                <label class="inline-flex items-center gap-1 cursor-pointer"><input id="ts-autosubmit" type="checkbox" ${fs.autoSubmit ? 'checked' : ''} /> <span>${t('teacherAutoSubmitLabel')}</span></label>
              </div>
            </div>
          </details>

          <details class="tb-section-card" ${fs.limitShelf || fs.initialOnly ? 'open' : ''}>
            <summary>🔒 ${t('teacherSectionShelfLimit')} <span class="text-[10.5px] font-mono text-amber-400">${shelfPolicyTxt}</span></summary>
            <div class="flex flex-col gap-2 pt-2">
              <div class="flex flex-wrap gap-3">
                <label class="inline-flex items-center gap-1.5 cursor-pointer">
                  <input id="ts-limit-shelf" type="checkbox" ${fs.limitShelf ? 'checked' : ''} />
                  <span>${t('teacherLimitShelfLabel')}</span>
                </label>
                <label class="inline-flex items-center gap-1.5 cursor-pointer">
                  <input id="ts-initial-only" type="checkbox" ${fs.initialOnly ? 'checked' : ''} />
                  <span>🔒 ${t('teacherInitialOnlyLabel')}</span>
                </label>
              </div>
              <div id="ts-shelf-scope-box" class="${fs.limitShelf ? '' : 'hidden'} grid grid-cols-2 gap-2 max-h-36 overflow-y-auto p-2 rounded-lg border border-theme bg-surface">
                <div>
                  <div class="font-semibold mb-1 text-muted">${t('equipmentTitle')}</div>
                  ${APPARATUS_ORDER.map(
                    (id) => `<label class="flex items-center gap-1 text-[11px]"><input type="checkbox" class="ts-allow-app" value="${id}" ${fs.allowedApps.has(id) ? 'checked' : ''} /> <span class="truncate">${t(APPARATUS[id]?.i18nKey || id)}</span></label>`
                  ).join('')}
                </div>
                <div>
                  <div class="font-semibold mb-1 text-muted">${t('reagentsTitle')}</div>
                  ${STARTER_REAGENTS.map(
                    (r) => `<label class="flex items-center gap-1 text-[11px]"><input type="checkbox" class="ts-allow-reg" value="${r.id}" ${fs.allowedRegs.has(r.id) ? 'checked' : ''} /> <span class="truncate">${t(r.i18nKey)}</span></label>`
                  ).join('')}
                </div>
              </div>
            </div>
          </details>
        </div>

        <!-- RIGHT PANE: Interactive Isolated Authoring Bench -->
        <div class="tb-studio-right">
          <div class="flex flex-wrap items-center justify-between gap-1.5 p-2 rounded-xl border border-theme bg-surface-alt">
            <div class="flex flex-wrap items-center gap-1">
              <span class="font-bold text-xs mr-1">⚗️ ${t('teacherAuthorBenchTitle')}</span>
              <span class="px-1.5 py-0.5 rounded border border-theme bg-surface font-mono text-[10px] ${isPaused ? 'text-sky-400' : 'text-emerald-400'}">
                ${isPaused ? t('teacherDraftPausedTag') : t('teacherDraftRunningTag')}
              </span>
            </div>
            <div class="flex flex-wrap items-center gap-1">
              <button type="button" id="btn-ts-clone-main" class="px-2 py-1 rounded-lg border border-theme bg-surface text-[11px] font-semibold hover:border-accent">📥 ${t('teacherCloneMainBenchBtn')}</button>
              <button type="button" id="btn-ts-spawn-template" class="px-2 py-1 rounded-lg border border-accent/50 bg-accent/15 text-accent text-[11px] font-semibold hover:opacity-90">⚡ ${t('teacherSpawnArchetypeBtn')}</button>
              <button type="button" id="btn-ts-clear-draft" class="px-2 py-1 rounded-lg border border-theme bg-surface text-[11px] font-semibold hover:border-accent">↺ ${t('teacherClearDraftBtn')}</button>
              <button type="button" id="btn-ts-playpause" class="px-2 py-1 rounded-lg border ${isPaused ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-400' : 'border-amber-500/50 bg-amber-500/15 text-amber-400'} text-[11px] font-bold">
                ${isPaused ? '▶️ Play' : '⏸️ Pause'}
              </button>
              <button type="button" id="btn-ts-blind-tool" class="px-2 py-1 rounded-lg border ${
                this.blindTagToolActive ? 'border-amber-500 bg-amber-500/20 text-amber-300 font-bold' : 'border-theme bg-surface text-muted hover:text-main'
              } text-[11px]">🏷️ ${t('teacherMarkBlindBtn')}</button>
              <button type="button" id="btn-ts-student-preview" class="px-2 py-1 rounded-lg border ${
                this.studentPreviewMode ? 'border-sky-500 bg-sky-500/20 text-sky-400 font-bold' : 'border-theme bg-surface text-muted hover:text-main'
              } text-[11px]">👁️ ${t('teacherStudentPreviewBtn')}</button>
            </div>
          </div>

          ${
            this.blindTagToolActive
              ? `<div class="px-2.5 py-1 rounded-lg border border-amber-500/45 bg-amber-500/10 text-amber-300 text-[11px] font-medium">${t('teacherMarkBlindHint')}</div>`
              : ''
          }
          ${
            this.studentPreviewMode
              ? `<div class="px-2.5 py-1 rounded-lg border border-sky-500/45 bg-sky-500/10 text-sky-400 text-[11px] font-semibold flex items-center justify-between gap-2">
                   <span>${t('teacherStudentPreviewBanner')}</span>
                   <span class="font-mono">T/P 🔒 · ${shelfPolicyTxt}</span>
                 </div>`
              : ''
          }

          <div class="tb-studio-canvas-wrap">
            <canvas id="ts-author-canvas"></canvas>
          </div>

          <div class="p-2 rounded-xl border border-theme bg-surface-alt flex flex-wrap items-center gap-1.5">
            <select id="ts-quick-app" class="px-2 py-1 rounded border border-theme bg-surface text-[11px] max-w-[165px]">
              ${QUICK_AUTHOR_APPARATUS.map((id) => `<option value="${id}">${t(APPARATUS[id]?.i18nKey || id)}</option>`).join('')}
            </select>
            <button type="button" id="btn-ts-quick-add-app" class="px-2 py-1 rounded-lg border border-theme bg-surface text-[11px] font-semibold hover:border-accent">${t('teacherQuickAddAppBtn')}</button>
            <select id="ts-quick-reg" class="px-2 py-1 rounded border border-theme bg-surface text-[11px] flex-1 min-w-[140px]">
              ${STARTER_REAGENTS.map((r) => `<option value="${r.id}">${t(r.i18nKey)} (${r.kind === 'solid' ? 'g' : 'mL'})</option>`).join('')}
            </select>
            <input id="ts-quick-amt" type="number" min="0.1" max="500" step="1" value="20" class="w-16 px-1.5 py-1 rounded border border-theme bg-surface text-[11px] font-mono" />
            <button type="button" id="btn-ts-quick-dose" class="px-2.5 py-1 rounded-lg bg-accent text-white text-[11px] font-bold hover:opacity-90">${t('teacherQuickDoseBtn')}</button>
            <span id="ts-draft-sel-badge" class="text-[10.5px] font-mono text-muted ml-auto truncate"></span>
          </div>
        </div>
      </div>
    `;
  }

  _bindDesignEvents(t, vessels) {
    this._updateQuickDraftSelectionBadge(t);

    this.rootEl.querySelectorAll('.ts-arch-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._captureFormToState();
        this.selectedArchetype = btn.dataset.tsArch;
        this.render();
      });
    });
    this.rootEl.querySelectorAll('.ts-tier-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._captureFormToState();
        this.selectedTier = btn.dataset.tsTier;
        if (this.formState) {
          this.formState.limitShelf = this.selectedTier === 'medium';
          this.formState.initialOnly = this.selectedTier === 'hard';
        }
        this.render();
      });
    });
    this.rootEl.querySelector('#ts-limit-shelf')?.addEventListener('change', (e) => {
      this.rootEl.querySelector('#ts-shelf-scope-box')?.classList.toggle('hidden', !e.target.checked);
    });
    this.rootEl.querySelector('#ts-initial-only')?.addEventListener('change', () => {
      this._captureFormToState();
    });

    // Two-way blind table listeners
    this.rootEl.querySelectorAll('.ts-blind-chk, .ts-blind-lbl, .ts-blind-ans').forEach((el) => {
      el.addEventListener('change', () => {
        this._captureFormToState();
      });
    });

    // Authoring bench toolbar actions
    this.rootEl.querySelector('#btn-ts-clone-main')?.addEventListener('click', () => {
      this._captureFormToState();
      this._cloneMainBenchIntoDraft();
      this.render();
    });
    this.rootEl.querySelector('#btn-ts-spawn-template')?.addEventListener('click', () => {
      this._captureFormToState();
      this._spawnArchetypeTemplateOnDraft();
      this.render();
    });
    this.rootEl.querySelector('#btn-ts-clear-draft')?.addEventListener('click', () => {
      this._captureFormToState();
      this.draftSim.setupPreset('clean');
      this.draftSim.environment.paused = true;
      this.blindDraftMap = {};
      this.render();
    });
    this.rootEl.querySelector('#btn-ts-playpause')?.addEventListener('click', () => {
      this._captureFormToState();
      this.draftSim.environment.paused = !this.draftSim.environment.paused;
      this.render();
    });
    this.rootEl.querySelector('#btn-ts-blind-tool')?.addEventListener('click', () => {
      this._captureFormToState();
      this.blindTagToolActive = !this.blindTagToolActive;
      this.render();
    });
    this.rootEl.querySelector('#btn-ts-student-preview')?.addEventListener('click', () => {
      this._captureFormToState();
      this.studentPreviewMode = !this.studentPreviewMode;
      this._syncBlindFlagsOnDraftSim();
      this.render();
    });

    this.rootEl.querySelector('#btn-ts-quick-add-app')?.addEventListener('click', () => {
      this._captureFormToState();
      const typeId = this.rootEl.querySelector('#ts-quick-app')?.value || 'beaker_250';
      const cnt = (this.draftSim.items || []).length;
      const it = this.draftSim.createApparatus(typeId, 200 + ((cnt * 105) % 580), 390, { silentUndo: true });
      if (it) {
        this.draftSim.selectedId = it.id;
        this.draftSim.selectedIds = new Set([it.id]);
      }
      this.render();
    });
    this.rootEl.querySelector('#btn-ts-quick-dose')?.addEventListener('click', () => {
      this._captureFormToState();
      const regId = this.rootEl.querySelector('#ts-quick-reg')?.value || 'h2o';
      const amt = Math.max(0.1, Number(this.rootEl.querySelector('#ts-quick-amt')?.value) || 20);
      let tgt = this.draftSim.getItem(this.draftSim.selectedId);
      if (!tgt || tgt.kind !== 'vessel' || tgt.isShattered) {
        tgt = this.draftSim.items.find((i) => i.kind === 'vessel' && !i.isShattered)
          || this.draftSim.createApparatus('beaker_250', 340, 415, { silentUndo: true });
      }
      if (tgt) {
        this.draftSim.selectedId = tgt.id;
        this.draftSim.selectedIds = new Set([tgt.id]);
        this.draftSim.addReagentToVessel(tgt.id, regId, amt, { silentAnim: true });
      }
      this.render();
    });

    const collectSpec = async () => {
      this._captureFormToState();
      const fs = this._ensureFormState(t);
      const archetype = this.selectedArchetype || 'blind_id';
      const difficultyTier = this.selectedTier || 'medium';
      const title = fs.title?.trim() || 'Practical Exam';
      const goalText = fs.goal?.trim() || '';
      const equationText = fs.equation?.trim() || '';
      const mode = fs.mode || 'exam';
      const timeLimitMin = Math.max(0, Number(fs.time) || 0);
      const maxSwitches = Math.max(1, Number(fs.maxSw) || 3);
      const maxAwaySec = Math.max(5, Number(fs.maxAway) || 20);
      const lockEnvironment = Boolean(fs.lockEnv);
      const requireFullscreen = Boolean(fs.fullscreen);
      const autoSubmitOnViolation = Boolean(fs.autoSubmit);
      const blindDosingMode = archetype === 'standard_prep' ? Boolean(fs.blindDosing) : false;

      const blindVesselSpecs = [];
      const submitFields = [];
      const rawAnswers = {};
      let titrationConfig = null;
      let standardPrepConfig = null;
      let synthesisConfig = null;
      let mixtureConfig = null;
      let electrochemConfig = null;

      if (archetype === 'blind_id') {
        const curVessels = (this.draftSim?.items || []).filter((i) => i.kind === 'vessel' && !i.isShattered);
        const optionsPool = [];
        for (const v of curVessels) {
          const meta = this.blindDraftMap[v.id];
          if (!meta?.checked) continue;
          const lbl = meta.blindLabel?.trim() || '?A';
          const trueName = meta.trueName?.trim() || '';
          blindVesselSpecs.push({ origItemId: v.id, blindLabel: lbl, trueName });
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
        standardPrepConfig = {
          targetSpeciesId: fs.prepSpecies || 'Cu2_aq',
          targetMolarityM: Number(fs.prepConc) || 0.2,
          concUnit: fs.prepUnit || 'M',
          targetVolumeMl: Number(fs.prepVol) || 100,
          tolerancePct: Number(fs.prepTol) || 5.0,
        };
        submitFields.push({ id: 'ans_mass_g', labelKey: 'm7FieldMassG', type: 'number', min: 0.01, max: 500, step: 0.01, placeholder: '4.99' });
      } else if (archetype === 'titration') {
        const vid = fs.titrVid || vessels[0]?.id;
        if (vid) {
          titrationConfig = {
            itemId: vid,
            analyteKind: fs.titrAnalyte || 'hcl',
            titrantReagent: fs.titrReagent || 'naoh',
            minM: Number(fs.titrMin) || 0.08,
            maxM: Number(fs.titrMax) || 0.18,
            tolerancePct: Number(fs.titrTol) || 2.0,
          };
          submitFields.push({ id: 'ans_molarity', labelKey: 'm2FieldMolarity', type: 'number', min: 0.01, max: 2.0, step: 0.001, placeholder: '0.120' });
        }
      } else if (archetype === 'synthesis') {
        synthesisConfig = {
          targetProductId: fs.synProduct || 'CH3COOC2H5_l',
          minYieldMol: Number(fs.synMinMol) || 0.005,
          minPurityPct: Number(fs.synMinPur) || 70,
          techniques: [...(fs.synTechs || [])],
        };
        submitFields.push({ id: 'ans_product', labelKey: 'm3FieldProduct', type: 'select', options: SYNTHESIS_PRODUCT_PRESETS.map((p) => p.label) });
      } else if (archetype === 'mixture_analysis') {
        const presetId = fs.mixPreset || 'fe_cu';
        const preset = MIXTURE_PRESETS.find((m) => m.id === presetId) || MIXTURE_PRESETS[0];
        mixtureConfig = {
          vesselId: fs.mixVid || vessels[0]?.id || '',
          presetId,
          spA: preset.spA,
          spB: preset.spB,
          minPctA: Number(fs.mixMin) || preset.minPctA,
          maxPctA: Number(fs.mixMax) || preset.maxPctA,
          tolerancePct: Number(fs.mixTol) || 3.0,
          totalMassG: Number(fs.mixMass) || preset.defaultMassG,
          requireGasSyringe: Boolean(fs.mixSyringe),
        };
        submitFields.push(
          { id: 'ans_pct_a', labelKey: 'm8FieldPctA', labelText: `%m ${preset.nameA}`, type: 'number', min: 0, max: 100, step: 0.1, placeholder: '50.0' },
          { id: 'ans_pct_b', labelKey: 'm8FieldPctB', labelText: `%m ${preset.nameB}`, type: 'number', min: 0, max: 100, step: 0.1, placeholder: '50.0' }
        );
      } else if (archetype === 'electrochem') {
        const preset = fs.ecPreset || 'voltaic_emf';
        const val = Number(fs.ecVal) || 1.1;
        const extra = String(fs.ecExtra || '0.08').trim();
        electrochemConfig = preset === 'voltaic_emf'
          ? { preset, targetEmfV: val, tolV: Number(extra) || 0.08 }
          : { preset, targetAmountMol: val, targetPlateMetal: ['Cu', 'Ni', 'Ag'].includes(extra) ? extra : null, targetGasId: extra.endsWith('_g') ? extra : null };
        submitFields.push(
          { id: 'ans_anode', labelKey: 'm5FieldAnode', type: 'select', options: ['Zn', 'Fe', 'Ni', 'Cu', 'Ag', 'SHE (Pt|H₂)'] },
          { id: 'ans_emf', labelKey: 'm5FieldEmf', type: 'number', min: 0, max: 12, step: 0.01, placeholder: String(val) }
        );
      }

      const initialOnly = Boolean(fs.initialOnly);
      const limitShelf = Boolean(fs.limitShelf);
      const shelfPolicy = initialOnly ? 'initial_only' : limitShelf ? 'scoped' : 'open';
      const allowedApparatus = initialOnly ? [] : limitShelf ? Array.from(fs.allowedApps || []) : null;
      const allowedReagents = initialOnly ? [] : limitShelf ? Array.from(fs.allowedRegs || []) : null;

      // Capture clean unmasked benchTemplate from isolated draftSim without clobbering teacher preview state
      const prevPreview = this.studentPreviewMode;
      this.studentPreviewMode = false;
      this._syncBlindFlagsOnDraftSim();
      const benchTemplate = exportSnapshotForSim(this.draftSim);
      this.studentPreviewMode = prevPreview;
      this._syncBlindFlagsOnDraftSim();

      const examCode = `CHEM-${Math.floor(1000 + Math.random() * 9000)}`;
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

    this.rootEl.querySelector('#btn-ts-test-run')?.addEventListener('click', async () => {
      const { publicDoc } = await collectSpec();
      this.close();
      this.callbacks.onTestRunAssignment?.(publicDoc);
    });

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
