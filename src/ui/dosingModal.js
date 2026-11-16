import { APPARATUS } from '../data/apparatus.js';
import { SPECIES, STARTER_REAGENTS } from '../data/species.js';
import { computeLiquidVolumeL } from '../engine/equilibrium.js';
import { computeSyringeTotalVolumeMl, computeTubingGeometry } from '../engine/gasNetwork.js';

export class DosingModal {
  constructor(container, sim, getLang) {
    this.container = container;
    this.sim = sim;
    this.getLang = getLang;
    this.state = null; // { mode: 'reagent'|'transfer', reagentId, sourceVesselId, targetVesselId, amount, rateMlS, fine, includePpt, pouredLive }
    this.pourInterval = null;
  }

  openReagent(reagentId, targetVesselId) {
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
    if (!reg) return;
    const vessels = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered);
    const target = vessels.find((v) => v.id === targetVesselId) || vessels[0];
    if (!target) return;

    this.state = {
      mode: 'reagent',
      reagentId,
      targetVesselId: target.id,
      amount: reg.defaultDose,
      rateMlS: reg.id === 'phen' ? 0.5 : 10,
      fine: false,
      pouredLive: 0,
    };
    this.render();
  }

  openTransfer(sourceVesselId) {
    const src = this.sim.getItem(sourceVesselId);
    if (!src || src.kind !== 'vessel') return;
    const others = this.sim.items.filter(
      (i) => i.kind === 'vessel' && i.id !== sourceVesselId && !i.isShattered
    );
    if (others.length === 0) return;

    const liqMl = computeLiquidVolumeL(src.moles, src.tempK) * 1000;
    this.state = {
      mode: 'transfer',
      sourceVesselId,
      targetVesselId: others[0].id,
      amount: Math.min(25, Math.max(0.5, Number((liqMl * 0.5).toFixed(2)))),
      rateMlS: 10,
      includePpt: false, // Default to physical Decantation (Gạn), unchecked "Shake before pour"
      pouredLive: 0,
    };
    this.render();
  }

  openTubeTarget(sourceVesselId) {
    const src = this.sim.getItem(sourceVesselId);
    if (!src || src.kind !== 'vessel') return;
    const targets = this.sim.getTubeTargetsForVessel(sourceVesselId);
    if (targets.length === 0) return;

    this.state = {
      mode: 'tube_target',
      sourceVesselId,
      targetVesselId: targets[0].id,
    };
    this.render();
  }

  openSyringeTransfer(syringeId) {
    const syr = this.sim.getItem(syringeId);
    if (!syr || syr.kind !== 'gas_syringe' || syr.isBroken) return;
    const vessels = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered);
    if (vessels.length === 0) return;

    const totMl = computeSyringeTotalVolumeMl(syr, this.sim.environment);
    this.state = {
      mode: 'syringe_transfer',
      sourceSyringeId: syringeId,
      targetVesselId: vessels[0].id,
      amount: Math.max(0.1, Number(totMl.toFixed(1))),
    };
    this.render();
  }

  close() {
    this.stopContinuousPour();
    this.state = null;
    this.container.innerHTML = '';
    this.container.classList.add('hidden');
  }

  stopContinuousPour() {
    if (this.pourInterval) {
      clearInterval(this.pourInterval);
      this.pourInterval = null;
    }
  }

  render() {
    if (!this.state) {
      this.container.classList.add('hidden');
      return;
    }
    const t = this.getLang();
    this.container.classList.remove('hidden');

    const vessels = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered);
    const st = this.state;

    if (st.mode === 'reagent') {
      const reg = STARTER_REAGENTS.find((r) => r.id === st.reagentId);
      const isSolid = reg.kind === 'solid';
      const title = isSolid ? t('dosingTitleSolid') : t('dosingTitleLiquid');

      let molPreview = '';
      if (isSolid) {
        const sp = SPECIES[reg.speciesId];
        const mol = st.amount / sp.molarMass;
        molPreview = `${(mol * 1000).toFixed(2)} mmol (${mol.toFixed(5)} mol)`;
      } else if (reg.id === 'hcl_37') {
        const molHCl = reg.perMl.H_aq * st.amount;
        molPreview = `HCl: ${(molHCl * 1000).toFixed(2)} mmol (~12.06 M)`;
      } else if (reg.id === 'h2o') {
        const molW = reg.perMl.H2O_l * st.amount;
        molPreview = `H₂O: ${molW.toFixed(3)} mol (${(st.amount * reg.densityGPerMl).toFixed(2)} g)`;
      } else {
        const molP = reg.perMl.Phenolphthalein_aq * st.amount;
        molPreview = `${(molP * 1e6).toFixed(1)} µmol indicator`;
      }

      const presets = isSolid
        ? reg.id === 'na'
          ? [0.05, 0.15, 0.25, 0.5, 1.0]
          : [0.25, 0.5, 1.0, 2.5, 5.0]
        : reg.id === 'phen'
        ? [0.05, 0.15, 0.5, 1.0]
        : [1, 5, 10, 25, 50, 100];

      this.container.innerHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" id="dosing-backdrop">
          <div class="w-full max-w-md rounded-2xl border border-theme bg-surface p-5 shadow-2xl flex flex-col gap-3.5 text-main">
            <div class="flex items-start justify-between gap-2">
              <div>
                <h3 class="text-sm font-bold">${title}: <span class="text-accent">${t(reg.i18nKey)}</span></h3>
                <p class="text-xs text-muted">${t(reg.descKey)}</p>
              </div>
              <button type="button" id="dosing-close-x" class="px-2 py-1 rounded text-xs text-muted hover:text-main border border-theme">✕</button>
            </div>

            <!-- Target vessel selector -->
            <div class="flex items-center justify-between gap-2">
              <label class="text-xs font-medium text-muted">${t('targetVessel')}</label>
              <select id="dosing-target-select" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-medium">
                ${vessels
                  .map(
                    (v) =>
                      `<option value="${v.id}" ${v.id === st.targetVesselId ? 'selected' : ''}>${t(
                        APPARATUS[v.typeId].i18nKey
                      )} ${v.label}</option>`
                  )
                  .join('')}
              </select>
            </div>

            <!-- Exact Mass / Volume Input -->
            <div class="p-3 rounded-xl border border-theme bg-surface-alt flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <label class="text-xs font-semibold">${isSolid ? t('massLabel') : t('volumeLabel')}</label>
                <div class="flex items-center gap-1.5">
                  <input id="dosing-num" type="number" min="0.01" max="${reg.maxDose}" step="${reg.step}" value="${st.amount}"
                    class="w-24 px-2 py-1 rounded border border-theme bg-surface text-xs font-mono font-bold text-right" />
                  <span class="text-xs font-semibold">${isSolid ? 'g' : 'mL'}</span>
                </div>
              </div>
              <input id="dosing-slider" type="range" min="${reg.minDose}" max="${reg.maxDose}" step="${reg.step}" value="${st.amount}" class="w-full accent-blue-500" />
              <div class="flex flex-wrap gap-1.5 mt-1">
                ${presets
                  .map(
                    (p) =>
                      `<button type="button" class="dose-preset px-2 py-1 rounded border border-theme bg-surface text-xs font-mono hover:border-accent" data-val="${p}">${p} ${
                        isSolid ? 'g' : 'mL'
                      }</button>`
                  )
                  .join('')}
              </div>
              <div class="text-xs text-muted pt-1 border-t border-theme flex justify-between">
                <span>${t('molesPreview')}</span>
                <span id="dosing-mol-preview" class="font-mono font-semibold text-main">${molPreview}</span>
              </div>
            </div>

            ${
              isSolid
                ? `
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="text-muted">${t('solidParticleCount')}</span>
                <div class="flex gap-1.5">
                  <button type="button" id="gran-coarse" class="px-2.5 py-1 rounded border ${
                    !st.fine ? 'border-accent bg-accent/15 font-semibold' : 'border-theme bg-surface-alt text-muted'
                  }">${t('coarseLump')}</button>
                  <button type="button" id="gran-fine" class="px-2.5 py-1 rounded border ${
                    st.fine ? 'border-accent bg-accent/15 font-semibold' : 'border-theme bg-surface-alt text-muted'
                  }">${t('fineGranules')}</button>
                </div>
              </div>
              `
                : `
              <!-- Liquid Flow Rate & Hold-to-Pour -->
              <div class="p-3 rounded-xl border border-theme bg-surface-alt flex flex-col gap-2">
                <div class="flex items-center justify-between text-xs">
                  <span class="text-muted">${t('flowRateLabel')}</span>
                  <span class="font-mono font-semibold text-accent" id="live-poured-counter">+${st.pouredLive.toFixed(2)} mL</span>
                </div>
                <div class="grid grid-cols-3 gap-1.5 text-xs">
                  <button type="button" class="rate-opt py-1 rounded border ${
                    st.rateMlS === 2 ? 'border-accent bg-accent/15 font-semibold' : 'border-theme bg-surface'
                  }" data-rate="2">${t('rateSlow')}</button>
                  <button type="button" class="rate-opt py-1 rounded border ${
                    st.rateMlS === 10 ? 'border-accent bg-accent/15 font-semibold' : 'border-theme bg-surface'
                  }" data-rate="10">${t('rateMed')}</button>
                  <button type="button" class="rate-opt py-1 rounded border ${
                    st.rateMlS === 25 ? 'border-accent bg-accent/15 font-semibold' : 'border-theme bg-surface'
                  }" data-rate="25">${t('rateFast')}</button>
                </div>
                <div class="grid grid-cols-2 gap-2 mt-1">
                  <button type="button" id="btn-hold-pour" class="py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-500 active:scale-[0.98] transition select-none">
                    💧 ${t('btnHoldPour')}
                  </button>
                  <button type="button" id="btn-single-drop" class="py-2 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent transition">
                    + ${t('btnAddDrop')}
                  </button>
                </div>
              </div>
              `
            }

            <div class="flex items-center justify-end gap-2 pt-1">
              ${
                !isSolid
                  ? `<button type="button" id="btn-draw-pipette" class="mr-auto px-3 py-2 rounded-lg border border-theme bg-surface-alt text-xs font-medium hover:border-accent transition">🧪 +2 mL Pipette</button>`
                  : ''
              }
              <button type="button" id="dosing-cancel" class="px-3 py-2 rounded-lg border border-theme text-xs font-medium text-muted hover:text-main">${t('btnClose')}</button>
              <button type="button" id="dosing-confirm" class="px-4 py-2 rounded-lg bg-accent text-white text-xs font-semibold hover:opacity-90 transition">
                ${reg.id === 'na' ? t('btnCutDropNa') : t('btnAddExact')}
              </button>
            </div>
          </div>
        </div>
      `;
    } else if (st.mode === 'transfer') {
      const src = this.sim.getItem(st.sourceVesselId);
      const srcLiqMl = computeLiquidVolumeL(src.moles, src.tempK) * 1000;
      const others = vessels.filter((v) => v.id !== st.sourceVesselId);

      this.container.innerHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" id="dosing-backdrop">
          <div class="w-full max-w-md rounded-2xl border border-theme bg-surface p-5 shadow-2xl flex flex-col gap-3.5 text-main">
            <div class="flex items-start justify-between gap-2">
              <div>
                <h3 class="text-sm font-bold">${t('dosingTitleTransfer')}</h3>
                <p class="text-xs text-muted">${t(APPARATUS[src.typeId].i18nKey)} ${src.label} (${srcLiqMl.toFixed(1)} mL) →</p>
              </div>
              <button type="button" id="dosing-close-x" class="px-2 py-1 rounded text-xs text-muted hover:text-main border border-theme">✕</button>
            </div>

            <div class="flex items-center justify-between gap-2">
              <label class="text-xs font-medium text-muted">${t('targetVessel')}</label>
              <select id="dosing-target-select" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-medium">
                ${others
                  .map(
                    (v) =>
                      `<option value="${v.id}" ${v.id === st.targetVesselId ? 'selected' : ''}>${t(
                        APPARATUS[v.typeId].i18nKey
                      )} ${v.label}</option>`
                  )
                  .join('')}
              </select>
            </div>

            <div class="p-3 rounded-xl border border-theme bg-surface-alt flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <label class="text-xs font-semibold">${t('volumeLabel')}</label>
                <div class="flex items-center gap-1.5">
                  <input id="dosing-num" type="number" min="0.05" max="${Math.max(0.1, srcLiqMl.toFixed(2))}" step="0.5" value="${st.amount}"
                    class="w-24 px-2 py-1 rounded border border-theme bg-surface text-xs font-mono font-bold text-right" />
                  <span class="text-xs font-semibold">mL</span>
                </div>
              </div>
              <input id="dosing-slider" type="range" min="0.05" max="${Math.max(0.1, srcLiqMl.toFixed(2))}" step="0.5" value="${st.amount}" class="w-full accent-blue-500" />
              <label class="flex items-center gap-2 text-xs font-medium text-main pt-1 cursor-pointer">
                <input type="checkbox" id="chk-include-ppt" ${st.includePpt ? 'checked' : ''} class="accent-blue-500" />
                <span>${t('transferShakeBeforePour')}</span>
              </label>
              <div class="text-[11px] text-muted leading-snug pt-0.5">
                ${
                  st.includePpt
                    ? t('shakeModeHint')
                    : `${t('decantModeHint')} (${
                        APPARATUS[src.typeId]?.shape === 'erlenmeyer'
                          ? 'Erlenmeyer: ~98%'
                          : 'Beaker: ~88%'
                      })`
                }
              </div>
            </div>

            <div class="p-3 rounded-xl border border-theme bg-surface-alt flex flex-col gap-2">
              <div class="flex items-center justify-between text-xs">
                <span class="text-muted">${t('flowRateLabel')}</span>
                <span class="font-mono font-semibold text-accent" id="live-poured-counter">+${st.pouredLive.toFixed(2)} mL</span>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <button type="button" id="btn-hold-pour" class="py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-500 transition select-none">
                  💧 ${t('btnHoldPour')}
                </button>
                <button type="button" id="btn-single-drop" class="py-2 rounded-lg border border-theme bg-surface text-xs font-semibold hover:border-accent transition">
                  + ${t('btnAddDrop')}
                </button>
              </div>
            </div>

            <div class="flex items-center justify-end gap-2">
              <button type="button" id="dosing-cancel" class="px-3 py-2 rounded-lg border border-theme text-xs font-medium text-muted hover:text-main">${t('btnClose')}</button>
              <button type="button" id="dosing-confirm" class="px-4 py-2 rounded-lg bg-accent text-white text-xs font-semibold hover:opacity-90 transition">${t('btnAddExact')}</button>
            </div>
          </div>
        </div>
      `;
    } else if (st.mode === 'tube_target') {
      const src = this.sim.getItem(st.sourceVesselId);
      const targets = this.sim.getTubeTargetsForVessel(st.sourceVesselId);
      this.container.innerHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" id="dosing-backdrop">
          <div class="w-full max-w-md rounded-2xl border border-theme bg-surface p-5 shadow-2xl flex flex-col gap-3.5 text-main">
            <div class="flex items-start justify-between gap-2">
              <div>
                <h3 class="text-sm font-bold">${t('tubeTargetTitle')}</h3>
                <p class="text-xs text-muted mt-0.5">${t('tubeTargetHint')}</p>
              </div>
              <button type="button" id="dosing-close-x" class="px-2 py-1 rounded text-xs text-muted hover:text-main border border-theme">✕</button>
            </div>
            <div class="flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
              ${targets
                .map((tgt) => {
                  const tSpec = APPARATUS[tgt.typeId];
                  const geom = computeTubingGeometry(src, tgt);
                  const icon = tgt.kind === 'gas_syringe' ? '💉' : '🧪';
                  return `
                    <button type="button" class="tube-pick-btn w-full p-2.5 rounded-xl border border-theme bg-surface-alt hover:border-accent flex items-center justify-between text-left transition" data-tid="${tgt.id}">
                      <span class="text-xs font-semibold">${icon} ${t(tSpec.i18nKey)} ${tgt.label}</span>
                      <span class="text-[11px] font-mono text-sky-400">Ø6mm · ${geom.arcLengthCm.toFixed(1)} cm (${geom.capacityMl.toFixed(1)} mL)</span>
                    </button>
                  `;
                })
                .join('')}
            </div>
            <div class="flex justify-end">
              <button type="button" id="dosing-cancel" class="px-3 py-1.5 rounded-lg border border-theme text-xs font-medium text-muted hover:text-main">${t('btnClose')}</button>
            </div>
          </div>
        </div>
      `;
    } else if (st.mode === 'syringe_transfer') {
      const syr = this.sim.getItem(st.sourceSyringeId);
      const totMl = syr ? computeSyringeTotalVolumeMl(syr, this.sim.environment) : 0;
      this.container.innerHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" id="dosing-backdrop">
          <div class="w-full max-w-md rounded-2xl border border-theme bg-surface p-5 shadow-2xl flex flex-col gap-3.5 text-main">
            <div class="flex items-start justify-between gap-2">
              <div>
                <h3 class="text-sm font-bold">💉 ${t('dosingTitleSyringeTransfer')}</h3>
                <p class="text-xs text-muted">${t('eq_gas_syringe')} ${syr?.label || ''} (${totMl.toFixed(1)} mL) →</p>
              </div>
              <button type="button" id="dosing-close-x" class="px-2 py-1 rounded text-xs text-muted hover:text-main border border-theme">✕</button>
            </div>
            <div class="flex items-center justify-between gap-2">
              <label class="text-xs font-medium text-muted">${t('targetVessel')}</label>
              <select id="dosing-target-select" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-medium">
                ${vessels
                  .map(
                    (v) =>
                      `<option value="${v.id}" ${v.id === st.targetVesselId ? 'selected' : ''}>${t(
                        APPARATUS[v.typeId].i18nKey
                      )} ${v.label}</option>`
                  )
                  .join('')}
              </select>
            </div>
            <div class="p-3 rounded-xl border border-theme bg-surface-alt flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <label class="text-xs font-semibold">${t('volumeLabel')}</label>
                <div class="flex items-center gap-1.5">
                  <input id="dosing-num" type="number" min="0.1" max="${Math.max(0.1, totMl.toFixed(1))}" step="0.5" value="${st.amount}"
                    class="w-24 px-2 py-1 rounded border border-theme bg-surface text-xs font-mono font-bold text-right" />
                  <span class="text-xs font-semibold">mL</span>
                </div>
              </div>
              <input id="dosing-slider" type="range" min="0.1" max="${Math.max(0.1, totMl.toFixed(1))}" step="0.5" value="${st.amount}" class="w-full accent-blue-500" />
            </div>
            <div class="flex items-center justify-end gap-2">
              <button type="button" id="dosing-cancel" class="px-3 py-2 rounded-lg border border-theme text-xs font-medium text-muted hover:text-main">${t('btnClose')}</button>
              <button type="button" id="dosing-confirm" class="px-4 py-2 rounded-lg bg-accent text-white text-xs font-semibold hover:opacity-90 transition">${t('btnAddExact')}</button>
            </div>
          </div>
        </div>
      `;
    }

    this.bindModalEvents();
  }

  bindModalEvents() {
    const closeFn = () => this.close();
    this.container.querySelector('#dosing-close-x')?.addEventListener('click', closeFn);
    this.container.querySelector('#dosing-cancel')?.addEventListener('click', closeFn);
    this.container.querySelector('#dosing-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'dosing-backdrop') closeFn();
    });

    this.container.querySelector('#dosing-target-select')?.addEventListener('change', (e) => {
      this.state.targetVesselId = e.target.value;
    });

    const numInput = this.container.querySelector('#dosing-num');
    const slider = this.container.querySelector('#dosing-slider');
    const syncAmt = (val) => {
      this.state.amount = Math.max(0.01, Number(val) || 0.05);
      if (numInput) numInput.value = this.state.amount;
      if (slider) slider.value = this.state.amount;
      const preview = this.container.querySelector('#dosing-mol-preview');
      if (preview && this.state.mode === 'reagent') {
        const reg = STARTER_REAGENTS.find((r) => r.id === this.state.reagentId);
        if (reg.kind === 'solid') {
          const mol = this.state.amount / SPECIES[reg.speciesId].molarMass;
          preview.textContent = `${(mol * 1000).toFixed(2)} mmol (${mol.toFixed(5)} mol)`;
        } else if (reg.id === 'hcl_37') {
          preview.textContent = `HCl: ${(reg.perMl.H_aq * this.state.amount * 1000).toFixed(2)} mmol (~12.06 M)`;
        } else if (reg.id === 'h2o') {
          preview.textContent = `H₂O: ${(reg.perMl.H2O_l * this.state.amount).toFixed(3)} mol (${(this.state.amount * reg.densityGPerMl).toFixed(2)} g)`;
        } else {
          preview.textContent = `${(reg.perMl.Phenolphthalein_aq * this.state.amount * 1e6).toFixed(1)} µmol indicator`;
        }
      }
    };

    numInput?.addEventListener('input', (e) => syncAmt(e.target.value));
    slider?.addEventListener('input', (e) => syncAmt(e.target.value));

    this.container.querySelectorAll('.dose-preset').forEach((btn) => {
      btn.addEventListener('click', () => syncAmt(btn.dataset.val));
    });

    this.container.querySelector('#gran-coarse')?.addEventListener('click', () => {
      this.state.fine = false;
      this.render();
    });
    this.container.querySelector('#gran-fine')?.addEventListener('click', () => {
      this.state.fine = true;
      this.render();
    });

    this.container.querySelector('#chk-include-ppt')?.addEventListener('change', (e) => {
      this.state.includePpt = e.target.checked;
      this.render();
    });

    this.container.querySelectorAll('.rate-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.rateMlS = Number(btn.dataset.rate);
        this.render();
      });
    });

    const addIncrement = (volMl) => {
      if (this.state.mode === 'reagent') {
        this.sim.addReagentToVessel(this.state.targetVesselId, this.state.reagentId, volMl);
        this.state.pouredLive += volMl;
      } else {
        const moved = this.sim.pourBetweenVessels(
          this.state.sourceVesselId,
          this.state.targetVesselId,
          volMl,
          this.state.includePpt
        );
        this.state.pouredLive += moved;
      }
      const counter = this.container.querySelector('#live-poured-counter');
      if (counter) counter.textContent = `+${this.state.pouredLive.toFixed(2)} mL`;
    };

    this.container.querySelector('#btn-single-drop')?.addEventListener('click', () => addIncrement(0.05));

    const holdBtn = this.container.querySelector('#btn-hold-pour');
    if (holdBtn) {
      const startPour = (e) => {
        e.preventDefault();
        this.stopContinuousPour();
        const stepMs = 50;
        this.pourInterval = setInterval(() => {
          addIncrement(this.state.rateMlS * (stepMs / 1000));
        }, stepMs);
      };
      holdBtn.addEventListener('pointerdown', startPour);
      holdBtn.addEventListener('pointerup', () => this.stopContinuousPour());
      holdBtn.addEventListener('pointerleave', () => this.stopContinuousPour());
      holdBtn.addEventListener('pointercancel', () => this.stopContinuousPour());
    }

    this.container.querySelector('#btn-draw-pipette')?.addEventListener('click', () => {
      this.sim.pipetteDrawFromReagent(this.state.reagentId, 2.0);
      this.close();
    });

    this.container.querySelectorAll('.tube-pick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.sim.connectTube(this.state.sourceVesselId, btn.dataset.tid);
        this.close();
      });
    });

    this.container.querySelector('#dosing-confirm')?.addEventListener('click', () => {
      if (this.state.mode === 'reagent') {
        this.sim.addReagentToVessel(this.state.targetVesselId, this.state.reagentId, this.state.amount, {
          fine: this.state.fine,
        });
      } else if (this.state.mode === 'syringe_transfer') {
        this.sim.pumpSyringeToVessel(
          this.state.sourceSyringeId,
          this.state.targetVesselId,
          this.state.amount
        );
      } else {
        this.sim.pourBetweenVessels(
          this.state.sourceVesselId,
          this.state.targetVesselId,
          this.state.amount,
          this.state.includePpt
        );
      }
      this.close();
    });
  }
}
