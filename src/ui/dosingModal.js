import { APPARATUS } from '../data/apparatus.js';
import { SPECIES, STARTER_REAGENTS } from '../data/species.js';
import { computeLiquidVolumeL } from '../engine/equilibrium.js';
import { computeSyringeTotalVolumeMl, computeTubingGeometry } from '../engine/gasNetwork.js';

function formatReagentMolPreview(reg, amount) {
  if (!reg) return '';
  if (reg.kind === 'solid') {
    const sp = SPECIES[reg.speciesId];
    const mol = amount / sp.molarMass;
    return `${(mol * 1000).toFixed(2)} mmol (${mol.toFixed(5)} mol)`;
  }
  if (reg.previewMode === 'acid_hcl') {
    return `HCl: ${(reg.perMl.H_aq * amount * 1000).toFixed(2)} mmol (~12.06 M)`;
  }
  if (reg.previewMode === 'acid_hno3') {
    return `HNO₃: ${(reg.perMl.NO3_aq * amount * 1000).toFixed(2)} mmol (~15.17 M)`;
  }
  if (reg.previewMode === 'solvent_water') {
    return `H₂O: ${(reg.perMl.H2O_l * amount).toFixed(3)} mol (${(amount * reg.densityGPerMl).toFixed(2)} g)`;
  }
  if (reg.previewMode === 'indicator' || reg.isIndicator) {
    const molP = (reg.perMl.Phenolphthalein_aq || Object.values(reg.perMl || {})[0] || 0) * amount;
    return `${(molP * 1e6).toFixed(1)} µmol indicator`;
  }
  const entries = Object.entries(reg.perMl || {});
  const [firstId, perMlVal] = entries[0] || ['H2O_l', 0];
  const concNote = reg.molarityLabel ? ` (${reg.molarityLabel})` : '';
  return `${SPECIES[firstId]?.formula || firstId}: ${(perMlVal * amount * 1000).toFixed(2)} mmol${concNote}`;
}

export class DosingModal {
  constructor(container, sim, getLang, onStartBenchPick = null) {
    this.container = container;
    this.sim = sim;
    this.getLang = getLang;
    this.onStartBenchPick = onStartBenchPick;
    this.state = null; // { mode: 'reagent'|'transfer', reagentId, sourceVesselId, targetVesselId, amount, rateMlS, fine, includePpt, pouredLive }
    this.pourInterval = null;
  }

  setSim(sim) {
    this.sim = sim;
    if (this.state) this.close?.();
  }

  renderTargetPickRow(targetItem, candidateIds, t) {
    const targetName = targetItem
      ? `${t(APPARATUS[targetItem.typeId].i18nKey)} ${targetItem.label}`
      : '—';
    return `
      <div class="flex items-center justify-between gap-2">
        <label class="text-xs font-medium text-muted shrink-0">${t('targetVessel')}</label>
        <div class="flex items-center gap-1.5 min-w-0">
          <span id="dosing-target-badge" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-semibold truncate">${targetName}</span>
          ${
            candidateIds.length > 0 && this.onStartBenchPick
              ? `<button type="button" id="dosing-pick-target" data-cids="${candidateIds.join(',')}" class="px-2.5 py-1.5 rounded-lg border border-accent bg-accent/15 text-accent text-xs font-semibold hover:opacity-90 shrink-0">${t('btnPickOnBench')}</button>`
              : ''
          }
        </div>
      </div>
    `;
  }

  hideForPick() {
    this.stopContinuousPour();
    this.container.classList.add('hidden');
  }

  showAfterPick(pickedId = null) {
    if (!this.state) return;
    if (pickedId) this.state.targetVesselId = pickedId;
    this.render();
  }

  openReagent(reagentId, targetVesselId) {
    const reg = STARTER_REAGENTS.find((r) => r.id === reagentId);
    if (!reg) return;
    const containers = this.sim.items.filter(
      (i) =>
        !i.isShattered &&
        !i.isBroken &&
        (i.kind === 'vessel' ||
          i.kind === 'filter_funnel' ||
          (i.kind === 'burette' && reg.kind === 'liquid') ||
          (i.kind === 'spoon' && reg.kind === 'solid'))
    );
    const target = containers.find((v) => v.id === targetVesselId) || containers[0];
    if (!target) return;

    this.state = {
      mode: 'reagent',
      reagentId,
      targetVesselId: target.id,
      amount: reg.defaultDose,
      rateMlS: reg.isIndicator ? 0.5 : 10,
      fine: false,
      pouredLive: 0,
    };
    this.render();
  }

  openTransfer(sourceVesselId, preferredTargetId = null) {
    const src = this.sim.getItem(sourceVesselId);
    if (!src || (src.kind !== 'vessel' && src.kind !== 'filter_funnel')) return;
    const others = this.sim.items.filter(
      (i) =>
        i.id !== sourceVesselId &&
        !i.isShattered &&
        !i.isBroken &&
        (i.kind === 'vessel' || i.kind === 'filter_funnel' || i.kind === 'burette')
    );
    if (others.length === 0) return;

    const liqMl = computeLiquidVolumeL(src.moles, src.tempK) * 1000;
    const hasSolidsOnly = liqMl <= 0.05 && Object.values(src.moles || {}).some((n) => n > 1e-8);
    const chosenTarget =
      others.find((o) => o.id === preferredTargetId) ||
      others.find((o) => o.kind === 'vessel') ||
      others[0];
    this.state = {
      mode: hasSolidsOnly ? 'solid_transfer' : 'transfer',
      sourceVesselId,
      targetVesselId: chosenTarget.id,
      amount: Math.min(25, Math.max(0.5, Number((liqMl * 0.5).toFixed(2)))),
      rateMlS: 10,
      includePpt: false, // Default to physical Decantation (Gạn), unchecked "Shake before pour"
      pouredLive: 0,
    };
    this.render();
  }

  openSolidTransfer(sourceId, preferredTargetId = null) {
    const src = this.sim.getItem(sourceId);
    const vessels = this.sim.items.filter((i) => i.id !== sourceId && i.kind === 'vessel' && !i.isShattered);
    if (!src || vessels.length === 0) return;
    const chosenTarget = vessels.find((v) => v.id === preferredTargetId) || vessels[0];
    this.state = {
      mode: 'solid_transfer',
      sourceVesselId: sourceId,
      targetVesselId: chosenTarget.id,
      amount: 100,
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
    const vessels = this.sim.items.filter(
      (i) => !i.isShattered && !i.isBroken && i.kind === 'vessel'
    );
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
    const st = this.state;
    this.container.classList.remove('hidden');

    const regForTarget = st.mode === 'reagent' ? STARTER_REAGENTS.find((r) => r.id === st.reagentId) : null;
    const vessels = this.sim.items.filter(
      (i) =>
        !i.isShattered &&
        !i.isBroken &&
        (i.kind === 'vessel' ||
          ((st.mode === 'reagent' || st.mode === 'transfer') &&
            (i.kind === 'filter_funnel' || (i.kind === 'burette' && (!regForTarget || regForTarget.kind === 'liquid')))))
    );

    if (st.mode === 'reagent') {
      const reg = STARTER_REAGENTS.find((r) => r.id === st.reagentId);
      const isSolid = reg.kind === 'solid';
      const title = isSolid ? t('dosingTitleSolid') : t('dosingTitleLiquid');
      const molPreview = formatReagentMolPreview(reg, st.amount);
      const presets =
        reg.dosePresets || (isSolid ? [0.25, 0.5, 1.0, 2.5, 5.0] : [1, 5, 10, 25, 50, 100]);

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

            <!-- Visual on-bench Target vessel selector -->
            ${this.renderTargetPickRow(
              vessels.find((v) => v.id === st.targetVesselId) || vessels[0],
              vessels.map((v) => v.id),
              t
            )}

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
                  }">${st.reagentId === 'fe' ? t('ironNailForm') : t('coarseLump')}</button>
                  <button type="button" id="gran-fine" class="px-2.5 py-1 rounded border ${
                    st.fine ? 'border-accent bg-accent/15 font-semibold' : 'border-theme bg-surface-alt text-muted'
                  }">${st.reagentId === 'fe' ? t('ironPowderForm') : t('fineGranules')}</button>
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
                ${reg.confirmKey ? t(reg.confirmKey) : t('btnAddExact')}
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

            ${this.renderTargetPickRow(
              others.find((v) => v.id === st.targetVesselId) || others[0],
              others.map((v) => v.id),
              t
            )}

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
    } else if (st.mode === 'solid_transfer') {
      const src = this.sim.getItem(st.sourceVesselId);
      const validVessels = this.sim.items.filter((i) => i.id !== st.sourceVesselId && i.kind === 'vessel' && !i.isShattered);
      this.container.innerHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" id="dosing-backdrop">
          <div class="w-full max-w-md rounded-2xl border border-theme bg-surface p-5 shadow-2xl flex flex-col gap-3.5 text-main">
            <div class="flex items-start justify-between gap-2">
              <h3 class="text-sm font-bold">${t('actionTransferSolid')}</h3>
              <button type="button" id="dosing-close-x" class="px-2 py-1 rounded text-xs text-muted hover:text-main border border-theme">✕</button>
            </div>
            ${this.renderTargetPickRow(
              validVessels.find((v) => v.id === st.targetVesselId) || validVessels[0],
              validVessels.map((v) => v.id),
              t
            )}
            <div class="flex items-center justify-end gap-2 pt-2">
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
                  const icon = tgt.kind === 'gas_syringe' ? '💉' : tgt.kind === 'condenser' ? '❄️' : '🧪';
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
            ${this.renderTargetPickRow(
              vessels.find((v) => v.id === st.targetVesselId) || vessels[0],
              vessels.filter((v) => v.kind === 'vessel').map((v) => v.id),
              t
            )}
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

    const t = this.getLang();
    const pickBtn = this.container.querySelector('#dosing-pick-target');
    if (pickBtn && this.onStartBenchPick) {
      pickBtn.addEventListener('click', () => {
        const cids = (pickBtn.dataset.cids || '').split(',').filter(Boolean);
        if (cids.length === 0) return;
        this.hideForPick();
        this.onStartBenchPick({
          candidateIds: cids,
          promptText: t('pickBenchPrompt'),
          onPick: (picked) => this.showAfterPick(picked.id),
          onCancel: () => this.showAfterPick(null),
        });
      });
    }

    const numInput = this.container.querySelector('#dosing-num');
    const slider = this.container.querySelector('#dosing-slider');
    const syncAmt = (val) => {
      this.state.amount = Math.max(0.01, Number(val) || 0.05);
      if (numInput) numInput.value = this.state.amount;
      if (slider) slider.value = this.state.amount;
      const preview = this.container.querySelector('#dosing-mol-preview');
      if (preview && this.state.mode === 'reagent') {
        const reg = STARTER_REAGENTS.find((r) => r.id === this.state.reagentId);
        preview.textContent = formatReagentMolPreview(reg, this.state.amount);
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
        this.sim.addReagentToVessel(this.state.targetVesselId, this.state.reagentId, volMl, {
          silentAnim: true,
        });
        this.state.pouredLive += volMl;
      } else {
        const moved = this.sim.pourBetweenVessels(
          this.state.sourceVesselId,
          this.state.targetVesselId,
          volMl,
          this.state.includePpt,
          { rateMlS: Math.max(4, volMl / 0.05), pouredMlTotal: this.state.pouredLive + volMl }
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
        this.sim.startTimedReagentPour(this.state.targetVesselId, this.state.reagentId, this.state.amount, {
          fine: this.state.fine,
        });
      } else if (this.state.mode === 'syringe_transfer') {
        this.sim.pumpSyringeToVessel(
          this.state.sourceSyringeId,
          this.state.targetVesselId,
          this.state.amount
        );
      } else if (this.state.mode === 'solid_transfer') {
        this.sim.transferSolidsToVessel(this.state.sourceVesselId, this.state.targetVesselId, 1.0);
      } else {
        this.sim.startTimedVesselPour(
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
