import { APPARATUS } from '../data/apparatus.js';
import { CONSTANTS, isThemeDark } from '../data/constants.js';
import { I18N } from '../data/i18n.js';
import { SPECIES } from '../data/species.js';
import { computeLiquidVolumeL, computePH } from '../engine/equilibrium.js';
import { renderExportActionsBarHtml, exportCompareChartAsset } from '../storage/reportExport.js';

const COMPARE_SLOT_TAGS = ['A', 'B', 'C'];
const COMPARE_SLOT_COLORS = ['#38bdf8', '#f472b6', '#34d399'];

function escHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getVesselLabel(sim, v, tFn) {
  if (!v) return '';
  if (v.label && v.label.startsWith('#')) return v.label.slice(1);
  if (v.label) return v.label;
  const spec = APPARATUS[v.typeId];
  return spec ? tFn(spec.i18nKey || spec.nameKey) : v.typeId;
}

function computeVesselSolidMassG(vessel) {
  let massG = 0;
  for (const [spId, n] of Object.entries(vessel?.moles || {})) {
    if (n <= 1e-12) continue;
    const sp = SPECIES[spId];
    if (sp?.state === 'solid') {
      massG += n * (sp.molarMass || 0);
    }
  }
  return massG;
}

function getVesselMetricValue(vessel, metric) {
  const tempK = vessel.tempK ?? CONSTANTS.T_STD_K;
  if (metric === 'temp') return tempK - 273.15;
  if (metric === 'ph') {
    const liqL = computeLiquidVolumeL(vessel.moles, tempK);
    return liqL > 1e-6 ? computePH(vessel.moles, liqL, tempK) : 7.0;
  }
  if (metric === 'gas') return (vessel.cumulativeGasMol || 0) * 1000;
  if (metric === 'solid') return computeVesselSolidMassG(vessel);
  return (vessel.lastTotalRateMolS || 0) * 1000; // 'rate' (mmol/s)
}

function getHistoryMetricValue(entry, metric) {
  if (!entry) return 0;
  if (metric === 'temp') return (entry.tempK ?? CONSTANTS.T_STD_K) - 273.15;
  if (metric === 'ph') return Number.isFinite(entry.ph) ? entry.ph : 7.0;
  if (metric === 'gas') return (entry.cumGasMol || 0) * 1000;
  if (metric === 'solid') return entry.solidMassG || 0;
  return (entry.rateMolS || 0) * 1000;
}

export class ComparisonPanel {
  constructor(rootEl, sim, getTranslatorOrOpts = null, maybeOpts = {}) {
    this.rootEl = rootEl;
    this.sim = sim;
    if (typeof getTranslatorOrOpts === 'function') {
      this.getTranslator = getTranslatorOrOpts;
      this.onClose = maybeOpts?.onClose || null;
    } else {
      this.getTranslator = null;
      this.onClose = getTranslatorOrOpts?.onClose || maybeOpts?.onClose || null;
    }
    this.isOpen = false;
    this.metric = 'rate';
    this.lastStructSig = '';
    this.chartCanvas = null;
  }

  getLangAndTranslator() {
    if (this.getTranslator) {
      const tFn = this.getTranslator();
      const lang = typeof localStorage !== 'undefined' ? localStorage.getItem('virlab_lang') || 'vi' : 'vi';
      return { lang, t: tFn };
    }
    const lang = typeof localStorage !== 'undefined' ? localStorage.getItem('virlab_lang') || 'vi' : 'vi';
    const dict = I18N[lang] || I18N.vi;
    return { lang, t: (k) => dict[k] ?? k };
  }

  setSim(nextSim) {
    this.sim = nextSim;
    this.lastStructSig = '';
    if (this.isOpen) this.render(true);
  }

  setOpen(open) {
    const next = Boolean(open);
    if (this.isOpen === next) return;
    this.isOpen = next;
    this.rootEl.classList.toggle('hidden', !next);
    if (next) {
      this.ensureDefaultSelection();
      this.lastStructSig = '';
      this.render(true);
    }
  }

  toggleOpen() {
    this.setOpen(!this.isOpen);
    return this.isOpen;
  }

  ensureDefaultSelection() {
    const vessels = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered);
    const valid = (this.sim.compareVesselIds || []).filter((id) => vessels.some((v) => v.id === id));
    if (valid.length >= 2) {
      this.sim.compareVesselIds = valid.slice(0, 3);
      return;
    }
    const seeded = [...valid];
    for (const v of vessels) {
      if (!seeded.includes(v.id)) seeded.push(v.id);
      if (seeded.length >= Math.min(3, vessels.length)) break;
    }
    this.sim.compareVesselIds = seeded;
  }

  getStructureSignature() {
    const vessels = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered);
    const { lang, t } = this.getLangAndTranslator();
    const sel = (this.sim.compareVesselIds || []).join(',');
    const vList = vessels.map((v) => `${v.id}:${getVesselLabel(this.sim, v, t)}`).join('|');
    return `${lang}::${this.isOpen}::${this.metric}::${sel}::${vList}`;
  }

  render(forceRebuild = false) {
    if (!this.rootEl) return;
    if (!this.isOpen) {
      this.rootEl.classList.add('hidden');
      return;
    }
    this.rootEl.classList.remove('hidden');

    const { t } = this.getLangAndTranslator();
    const sig = this.getStructureSignature();
    if (!forceRebuild && sig === this.lastStructSig) {
      this.updateLiveData();
      return;
    }
    this.lastStructSig = sig;

    const vessels = this.sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered);
    const compareVessels = (this.sim.compareVesselIds || [])
      .map((id) => vessels.find((v) => v.id === id))
      .filter(Boolean)
      .slice(0, 3);

    const metrics = [
      { id: 'rate', label: t('compareMetricRate') },
      { id: 'gas', label: t('compareMetricGas') },
      { id: 'temp', label: t('compareMetricTemp') },
      { id: 'ph', label: t('compareMetricPh') },
      { id: 'solid', label: t('compareMetricSolid') },
    ];

    const vesselChipsHtml = vessels
      .map((v) => {
        const idx = (this.sim.compareVesselIds || []).indexOf(v.id);
        const active = idx >= 0;
        const tag = active ? COMPARE_SLOT_TAGS[idx] : '';
        const color = active ? COMPARE_SLOT_COLORS[idx] : '';
        return `<button type="button" class="compare-chip ${active ? 'active' : ''}" data-compare-toggle="${escHtml(v.id)}" ${
          active ? `style="--slot-color:${color}"` : ''
        }>${active ? `<span class="compare-badge" style="background:${color}">${tag}</span>` : ''}<span>${escHtml(
          getVesselLabel(this.sim, v, t)
        )}</span></button>`;
      })
      .join('');

    const metricTabsHtml = metrics
      .map(
        (m) =>
          `<button type="button" class="compare-metric-btn ${this.metric === m.id ? 'active' : ''}" data-compare-metric="${m.id}">${escHtml(
            m.label
          )}</button>`
      )
      .join('');

    const cardsHtml =
      compareVessels.length >= 1
        ? compareVessels
            .map((v, idx) => {
              const color = COMPARE_SLOT_COLORS[idx] || '#38bdf8';
              const tag = COMPARE_SLOT_TAGS[idx] || String(idx + 1);
              return `
          <div class="compare-card" style="border-top: 3px solid ${color}">
            <div class="flex items-center justify-between gap-1.5 mb-1">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="compare-badge" style="background:${color}">${tag}</span>
                <span class="text-xs font-bold truncate">${escHtml(getVesselLabel(this.sim, v, t))}</span>
              </div>
              <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-alt border border-theme" data-compare-ratio="${escHtml(
                v.id
              )}"></span>
            </div>
            <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
              <div class="text-muted">${escHtml(t('compareShortRate'))}: <span class="font-mono font-semibold text-main" data-compare-rate="${escHtml(
                v.id
              )}">0.00</span></div>
              <div class="text-muted">${escHtml(t('compareShortGas'))}: <span class="font-mono font-semibold text-main" data-compare-gas="${escHtml(
                v.id
              )}">0.00</span></div>
              <div class="text-muted">${escHtml(t('compareShortTemp'))}: <span class="font-mono font-semibold text-main" data-compare-temp="${escHtml(
                v.id
              )}">25.0°C</span></div>
              <div class="text-muted">${escHtml(t('compareShortPh'))}: <span class="font-mono font-semibold text-main" data-compare-ph="${escHtml(
                v.id
              )}">7.00</span> · <span class="font-mono font-semibold text-main" data-compare-solid="${escHtml(
                v.id
              )}">0.00g</span></div>
            </div>
          </div>`;
            })
            .join('')
        : `<div class="text-xs text-muted py-2">${escHtml(t('compareEmptyHint'))}</div>`;

    this.rootEl.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-xs font-bold">⚖️ ${escHtml(t('compareTitle'))}</span>
          <span class="text-[11px] text-muted hidden sm:inline">${escHtml(t('compareSubHint'))}</span>
        </div>
        <div class="flex items-center gap-1 flex-wrap">
          ${metricTabsHtml}
          <button type="button" id="btn-compare-close" class="px-2 py-0.5 rounded border border-theme bg-surface-alt text-[11px] font-semibold hover:border-accent">✕</button>
        </div>
      </div>
      <div class="flex items-center gap-1.5 flex-wrap mb-2">
        ${vesselChipsHtml || `<span class="text-xs text-muted">${escHtml(t('compareEmptyHint'))}</span>`}
      </div>
      <div class="compare-body-grid">
        <div class="compare-cards-col">
          ${cardsHtml}
        </div>
        <div class="compare-chart-wrap flex flex-col gap-1.5">
          <canvas id="compare-chart-canvas" class="compare-chart-canvas"></canvas>
          ${renderExportActionsBarHtml({ idPrefix: 'cmp', label: t('exportImageCsvLabel') })}
        </div>
      </div>
    `;

    this.chartCanvas = this.rootEl.querySelector('#compare-chart-canvas');

    this.rootEl.querySelector('#btn-compare-close')?.addEventListener('click', () => {
      this.setOpen(false);
      this.onClose?.();
    });

    this.rootEl.querySelectorAll('[data-compare-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const vid = btn.getAttribute('data-compare-toggle');
        this.sim.toggleCompareVessel(vid);
        this.render(true);
      });
    });

    this.rootEl.querySelectorAll('[data-compare-metric]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.metric = btn.getAttribute('data-compare-metric') || 'rate';
        this.render(true);
      });
    });

    this.rootEl.querySelectorAll('.exp-act-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fmt = btn.dataset.expFmt || 'png';
        const lang = this.sim?.environment?.lang || document?.documentElement?.lang || 'vi';
        const labName = this.callbacks?.getLabName?.() || 'Lab';
        exportCompareChartAsset({ format: fmt, sim: this.sim, metric: this.metric, t, lang, labName });
      });
    });

    this.updateLiveData();
  }

  updateLiveData() {
    if (!this.isOpen) return;
    const compareVessels = (this.sim.compareVesselIds || [])
      .map((id) => this.sim.getItem(id))
      .filter((v) => v && !v.isShattered)
      .slice(0, 3);

    const rates = compareVessels.map((v) => (v.lastTotalRateMolS || 0) * 1000);
    const positiveRates = rates.filter((r) => r > 1e-4);
    const minRate = positiveRates.length ? Math.min(...positiveRates) : 0;

    for (const v of compareVessels) {
      const tempK = v.tempK ?? CONSTANTS.T_STD_K;
      const liqL = computeLiquidVolumeL(v.moles, tempK);
      const ph = liqL > 1e-6 ? computePH(v.moles, liqL, tempK) : 7.0;
      const rateMmolS = (v.lastTotalRateMolS || 0) * 1000;
      const gasMmol = (v.cumulativeGasMol || 0) * 1000;
      const solidG = computeVesselSolidMassG(v);

      const elRate = this.rootEl.querySelector(`[data-compare-rate="${v.id}"]`);
      const elGas = this.rootEl.querySelector(`[data-compare-gas="${v.id}"]`);
      const elTemp = this.rootEl.querySelector(`[data-compare-temp="${v.id}"]`);
      const elPh = this.rootEl.querySelector(`[data-compare-ph="${v.id}"]`);
      const elSolid = this.rootEl.querySelector(`[data-compare-solid="${v.id}"]`);
      const elRatio = this.rootEl.querySelector(`[data-compare-ratio="${v.id}"]`);

      if (elRate) elRate.textContent = rateMmolS.toFixed(rateMmolS >= 10 ? 1 : 2);
      if (elGas) elGas.textContent = gasMmol.toFixed(gasMmol >= 10 ? 1 : 2);
      if (elTemp) elTemp.textContent = `${(tempK - 273.15).toFixed(1)}°C`;
      if (elPh) elPh.textContent = ph.toFixed(2);
      if (elSolid) elSolid.textContent = `${solidG.toFixed(2)}g`;
      if (elRatio) {
        if (rateMmolS > 1e-4 && minRate > 1e-4 && positiveRates.length >= 2) {
          const factor = rateMmolS / minRate;
          elRatio.textContent = `×${factor >= 10 ? factor.toFixed(0) : factor.toFixed(1)}`;
          elRatio.classList.remove('hidden');
        } else {
          elRatio.textContent = rateMmolS > 1e-4 ? 'LIVE' : 'IDLE';
        }
      }
    }

    this.drawChart(compareVessels);
  }

  drawChart(compareVessels) {
    const canvas = this.chartCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const wCss = Math.max(220, Math.round(rect.width || 320));
    const hCss = Math.max(105, Math.round(rect.height || 130));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== wCss * dpr || canvas.height !== hCss * dpr) {
      canvas.width = wCss * dpr;
      canvas.height = hCss * dpr;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const isDark = isThemeDark(document.documentElement.getAttribute('data-theme'));

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, wCss, hCss);

    const padL = 38;
    const padR = 12;
    const padT = 14;
    const padB = 20;
    const plotW = Math.max(40, wCss - padL - padR);
    const plotH = Math.max(30, hCss - padT - padB);

    // Collect series
    let minT = Infinity;
    let maxT = -Infinity;
    let minY = this.metric === 'ph' ? 0 : this.metric === 'temp' ? 15 : 0;
    let maxY = this.metric === 'ph' ? 14 : this.metric === 'temp' ? 100 : 1.0;

    const series = compareVessels.map((v, idx) => {
      const hist = Array.isArray(v.history) ? v.history : [];
      const pts = hist.map((h) => ({
        t: h.t ?? 0,
        y: getHistoryMetricValue(h, this.metric),
      }));
      if (pts.length === 0) {
        pts.push({ t: this.sim.timeSec, y: getVesselMetricValue(v, this.metric) });
      }
      for (const p of pts) {
        if (p.t < minT) minT = p.t;
        if (p.t > maxT) maxT = p.t;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return {
        tag: COMPARE_SLOT_TAGS[idx] || String(idx + 1),
        color: COMPARE_SLOT_COLORS[idx] || '#38bdf8',
        pts,
      };
    });

    if (!Number.isFinite(minT)) {
      minT = 0;
      maxT = 10;
    }
    if (maxT - minT < 2) maxT = minT + 2;
    if (maxY - minY < 0.5) maxY = minY + 1;
    else maxY += (maxY - minY) * 0.1;

    // Grid & axes
    ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.18)' : 'rgba(100, 116, 139, 0.22)';
    ctx.lineWidth = 1;
    ctx.fillStyle = isDark ? '#94a3b8' : '#475569';
    ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= 3; i++) {
      const f = i / 3;
      const py = padT + plotH - f * plotH;
      const val = minY + f * (maxY - minY);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + plotW, py);
      ctx.stroke();
      ctx.fillText(val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2), padL - 4, py);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${minT.toFixed(0)}s`, padL + 8, padT + plotH + 4);
    ctx.fillText(`${maxT.toFixed(0)}s`, padL + plotW - 10, padT + plotH + 4);

    // Draw lines
    for (const s of series) {
      if (s.pts.length === 0) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      s.pts.forEach((p, i) => {
        const px = padL + ((p.t - minT) / Math.max(0.01, maxT - minT)) * plotW;
        const py = padT + plotH - ((p.y - minY) / Math.max(0.01, maxY - minY)) * plotH;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      const last = s.pts[s.pts.length - 1];
      const lx = padL + ((last.t - minT) / Math.max(0.01, maxT - minT)) * plotW;
      const ly = padT + plotH - ((last.y - minY) / Math.max(0.01, maxY - minY)) * plotH;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(lx, ly, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
