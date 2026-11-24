/**
 * Inspector Analytical, Spectroscopy & Vessel Mole History Charts (Refactor 81).
 */
import { APPARATUS, getStandGeometry } from '../../data/apparatus.js';
import { CONSTANTS, formatNumber, kelvinToCelsius } from '../../data/constants.js';
import { GAS_DISPLAY_META, isSolidMoltenAtTemp, SPECIES, STARTER_REAGENTS } from '../../data/species.js';
import { ELECTRODE_MATERIALS, computeVesselRedoxAndCellMetrics } from '../../engine/electrochemistry.js';
import {
  computeAtmospherePartialPressures,
  computeBenchTelemetry,
  computeContentsMassG,
  computeLiquidSpeciesTableData,
  computeLiquidVolumeL,
  computePH,
  computePhaseStratification,
  computeSolidVolumeMl,
  computeVesselAroma,
  computeVesselElectrochemicalMetrics,
  estimateVesselEsterificationMetrics,
} from '../../engine/equilibrium.js';
import {
  computeSyringeDischargeArc,
  computeSyringeFrozenVolumeMl,
  computeSyringeGasVolumeMl,
  computeSyringeLiquidVolumeMl,
  computeSyringeTotalVolumeMl,
  computeTubingGeometry,
} from '../../engine/gasNetwork.js';
import { computeWashBottleStreamArc } from '../../engine/apparatusTools.js';
import {
  COLORIMETER_WAVELENGTHS,
  computeIrSpectrum,
  computeUvVisSpectrum,
  stepAnalyticalInstruments,
} from '../../engine/analyticalTools.js';
import { computeCaOOptimizationScore } from '../../engine/chemistry.js';
import { renderExportActionsBarHtml } from '../../storage/reportExport.js';
import { SPECTRO_CHART_PAD, CHART_PALETTE } from './inspectorUtils.js';

export function drawAnalyticalChartView(panel, item) {
    const canvas = panel.container.querySelector('#analytical-chart');
    if (!canvas || !item) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (item.kind === 'colorimeter' && (item.spectroMode === 'uvvis_spectrum' || item.spectroMode === 'ir_spectrum')) {
      drawSpectroscopyScanChart(panel, canvas, ctx, item);
      return;
    }

    const hist = item.history || [];
    if (hist.length < 2) {
      ctx.fillStyle = panel.isDark ? '#64748b' : '#94a3b8';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(item.kind === 'colorimeter' ? 'A(t)' : 'pH / σ', w / 2, h / 2 + 4);
      return;
    }

    ctx.strokeStyle = panel.isDark ? 'rgba(148,163,184,0.12)' : 'rgba(15,23,42,0.08)';
    ctx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      const gy = (h * g) / 4;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    const padX = 8;
    const padY = 8;
    if (item.kind === 'ph_conductometer') {
      const useVol = (hist[hist.length - 1].ml || 0) > (hist[0].ml || 0) + 0.05;
      const xMin = useVol ? hist[0].ml : hist[0].t;
      const xMax = Math.max(xMin + 0.1, useVol ? hist[hist.length - 1].ml : hist[hist.length - 1].t);
      const maxK = Math.max(1, ...hist.map((p) => p.kappa || 0));

      // pH curve (emerald)
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 2;
      ctx.beginPath();
      hist.forEach((pt, idx) => {
        const xv = useVol ? pt.ml : pt.t;
        const px = padX + ((xv - xMin) / (xMax - xMin)) * (w - padX * 2);
        const py = h - padY - (Math.max(0, Math.min(14, pt.pH ?? 7)) / 14) * (h - padY * 2);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Conductivity curve (sky blue)
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      hist.forEach((pt, idx) => {
        const xv = useVol ? pt.ml : pt.t;
        const px = padX + ((xv - xMin) / (xMax - xMin)) * (w - padX * 2);
        const py = h - padY - ((pt.kappa || 0) / maxK) * (h - padY * 2);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    } else if (item.kind === 'colorimeter') {
      const tMin = hist[0].t;
      const tMax = Math.max(tMin + 0.2, hist[hist.length - 1].t);
      const maxA = Math.max(0.2, ...hist.map((p) => p.A || 0));
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.beginPath();
      hist.forEach((pt, idx) => {
        const px = padX + ((pt.t - tMin) / (tMax - tMin)) * (w - padX * 2);
        const py = h - padY - ((pt.A || 0) / maxA) * (h - padY * 2);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
}

export function drawSpectroscopyScanChart(panel, canvas, ctx, item) {
    const w = canvas.width;
    const h = canvas.height;
    const isDark = panel.isDark;
    const mode = item.spectroMode || 'uvvis_spectrum';
    const isIr = mode === 'ir_spectrum';
    const t = panel.getLang();
    const lang = panel.sim?.environment?.lang || document?.documentElement?.lang || 'vi';
    const isEn = lang === 'en' || t('specModeIr') === 'FT-IR Scan';
    const contactV = item.contactVesselId ? panel.sim.getItem(item.contactVesselId) : null;

    const padL = SPECTRO_CHART_PAD.L;
    const padR = SPECTRO_CHART_PAD.R;
    const padT = SPECTRO_CHART_PAD.T;
    const padB = SPECTRO_CHART_PAD.B;
    const plotW = Math.max(20, w - padL - padR);
    const plotH = Math.max(20, h - padT - padB);

    // Chart background
    ctx.fillStyle = isDark ? '#090f1d' : '#f8fafc';
    ctx.fillRect(0, 0, w, h);

    // Horizontal grid lines
    ctx.strokeStyle = isDark ? 'rgba(148,163,184,0.14)' : 'rgba(15,23,42,0.10)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const gy = padT + (plotH * g) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(padL + plotW, gy);
      ctx.stroke();
    }

    const hoverEl = panel.container.querySelector('#live-col-hover');
    const peaksEl = panel.container.querySelector('#live-col-peaks');

    if (isIr) {
      // FT-IR 4000 -> 400 cm^-1 (reversed X-axis) vs %T (0..100%)
      const ir = computeIrSpectrum(contactV, { subtractWater: item.irSubtractWater !== false, stepCm: 15 });
      const xToPx = (wn) => padL + ((4000 - wn) / 3600) * plotW;
      const yToPx = (T) => padT + ((100 - Math.max(0, Math.min(100, T))) / 100) * plotH;

      // Wavenumber vertical grid & axis labels
      ctx.fillStyle = isDark ? '#94a3b8' : '#475569';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      for (const tick of [4000, 3500, 3000, 2500, 2000, 1750, 1500, 1000, 500]) {
        const tx = xToPx(tick);
        ctx.strokeStyle = isDark ? 'rgba(148,163,184,0.10)' : 'rgba(15,23,42,0.08)';
        ctx.beginPath();
        ctx.moveTo(tx, padT);
        ctx.lineTo(tx, padT + plotH);
        ctx.stroke();
        if (tick === 4000 || tick === 3000 || tick === 2000 || tick === 1500 || tick === 1000 || tick === 500) {
          ctx.fillText(String(tick), tx, h - 6);
        }
      }
      ctx.textAlign = 'right';
      ctx.fillText('100', padL - 3, padT + 4);
      ctx.fillText('50', padL - 3, padT + plotH / 2 + 3);
      ctx.fillText('0%', padL - 3, padT + plotH + 2);

      // %T curve
      if (ir.points.length > 1) {
        ctx.strokeStyle = ir.hasAnalyte ? (isDark ? '#fb923c' : '#ea580c') : isDark ? '#475569' : '#94a3b8';
        ctx.lineWidth = 1.75;
        ctx.beginPath();
        ir.points.forEach((pt, idx) => {
          const px = xToPx(pt.wn);
          const py = yToPx(pt.T);
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }

      // Auto peak trough annotations directly on peaks (collision-avoidance)
      const placedBoxes = [];
      ctx.font = '600 8.5px system-ui, sans-serif';
      for (const pk of ir.peaks.slice(0, 4)) {
        const px = xToPx(pk.wn);
        const py = yToPx(pk.T);
        ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
        ctx.beginPath();
        ctx.arc(px, py, 2.3, 0, Math.PI * 2);
        ctx.fill();

        const shortTag = String(isEn ? pk.labelEn : pk.labelVi).split('(')[0].trim();
        const label = `${shortTag} ${pk.wn}`;
        const labelX = Math.max(padL + 26, Math.min(w - 28, px));
        let labelY = Math.min(padT + plotH - 5, py + 11);
        for (const bx of placedBoxes) {
          if (Math.abs(labelX - bx.x) < 54 && Math.abs(labelY - bx.y) < 10) {
            labelY = Math.max(padT + 9, py - 8);
          }
        }
        placedBoxes.push({ x: labelX, y: labelY });
        ctx.fillStyle = isDark ? '#e2e8f0' : '#0f172a';
        ctx.textAlign = 'center';
        ctx.fillText(label, labelX, labelY);
      }

      // Hover crosshair + exact cursor-aligned interpolated readout
      if (panel._spectroHoverFrac != null && ir.points.length > 0) {
        const targetWn = 4000 - panel._spectroHoverFrac * 3600;
        let nearest = ir.points[0];
        for (const pt of ir.points) {
          if (Math.abs(pt.wn - targetWn) < Math.abs(nearest.wn - targetWn)) nearest = pt;
        }
        let interpT = nearest.T;
        for (let i = 0; i < ir.points.length - 1; i++) {
          const p0 = ir.points[i];
          const p1 = ir.points[i + 1];
          if (p0.wn >= targetWn && p1.wn <= targetWn && p0.wn !== p1.wn) {
            const u = (p0.wn - targetWn) / (p0.wn - p1.wn);
            interpT = p0.T + (p1.T - p0.T) * u;
            break;
          }
        }
        const hx = xToPx(targetWn);
        const hy = yToPx(interpT);
        ctx.strokeStyle = isDark ? 'rgba(56,189,248,0.65)' : 'rgba(2,132,199,0.65)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, padT);
        ctx.lineTo(hx, padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
        ctx.fill();

        const dispWn = Math.round(targetWn);
        const nearPeak = ir.peaks.find((pk) => Math.abs(pk.wn - dispWn) <= 85);
        const pkTxt = nearPeak ? ` · ${isEn ? nearPeak.labelEn : nearPeak.labelVi}` : '';
        if (hoverEl) hoverEl.textContent = `${dispWn} cm⁻¹ · ${interpT.toFixed(1)}% T${pkTxt}`;
      } else if (hoverEl) {
        hoverEl.textContent = contactV ? t('specHoverHint') : t('specNoVessel');
      }

      if (peaksEl) {
        peaksEl.innerHTML =
          ir.peaks.length > 0
            ? ir.peaks
                .map(
                  (pk) =>
                    `<span class="px-1.5 py-0.5 rounded bg-orange-500/15 border border-orange-500/30 text-orange-400 font-mono">${pk.wn} cm⁻¹: ${isEn ? pk.labelEn : pk.labelVi}</span>`
                )
                .join('')
            : `<span class="text-muted">${contactV ? (isEn ? 'No strong IR organic bands' : 'Chưa thấy dải IR hữu cơ rõ') : ''}</span>`;
      }
      return;
    }

    // UV–Vis Full Spectrum (220 -> 750 nm) vs Absorbance A
    const uv = computeUvVisSpectrum(contactV, 5);
    const maxScaleA = Math.max(0.5, Math.min(3.5, Math.ceil((uv.maxA || 0.4) * 4) / 4));
    const xToPx = (nm) => padL + ((nm - 220) / 530) * plotW;
    const yToPx = (A) => padT + plotH - (Math.min(maxScaleA, Math.max(0, A)) / maxScaleA) * plotH;

    // UV region highlight (220-380 nm) + Visible rainbow bar along bottom axis (380-750 nm)
    const x380 = xToPx(380);
    ctx.fillStyle = isDark ? 'rgba(139, 92, 246, 0.08)' : 'rgba(139, 92, 246, 0.07)';
    ctx.fillRect(padL, padT, Math.max(0, x380 - padL), plotH);
    const visGrad = ctx.createLinearGradient(x380, 0, padL + plotW, 0);
    visGrad.addColorStop(0.0, '#7c3aed');
    visGrad.addColorStop(0.18, '#2563eb');
    visGrad.addColorStop(0.38, '#10b981');
    visGrad.addColorStop(0.58, '#eab308');
    visGrad.addColorStop(0.78, '#f97316');
    visGrad.addColorStop(1.0, '#ef4444');
    ctx.fillStyle = visGrad;
    ctx.fillRect(x380, padT + plotH + 1, padL + plotW - x380, 3);

    // Axis ticks
    ctx.fillStyle = isDark ? '#94a3b8' : '#475569';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (const tick of [220, 300, 400, 500, 600, 700]) {
      const tx = xToPx(tick);
      ctx.fillText(String(tick), tx, h - 6);
    }
    ctx.textAlign = 'right';
    ctx.fillText(maxScaleA.toFixed(1), padL - 3, padT + 5);
    ctx.fillText('0', padL - 3, padT + plotH + 2);

    // Spectrum fill + stroke
    if (uv.points.length > 1) {
      ctx.beginPath();
      uv.points.forEach((pt, idx) => {
        const px = xToPx(pt.nm);
        const py = yToPx(pt.A);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = isDark ? '#38bdf8' : '#0284c7';
      ctx.lineWidth = 1.8;
      ctx.stroke();

      ctx.lineTo(padL + plotW, padT + plotH);
      ctx.lineTo(padL, padT + plotH);
      ctx.closePath();
      ctx.fillStyle = isDark ? 'rgba(56,189,248,0.16)' : 'rgba(2,132,199,0.14)';
      ctx.fill();
    }

    // Annotate λmax / UV–Vis peaks
    ctx.font = '600 8.5px system-ui, sans-serif';
    for (const pk of uv.peaks.slice(0, 3)) {
      const px = xToPx(pk.nm);
      const py = yToPx(pk.A);
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
      ctx.textAlign = 'center';
      ctx.fillText(`${pk.nm}nm`, Math.max(padL + 18, Math.min(w - 22, px)), Math.max(padT + 9, py - 5));
    }

    if (panel._spectroHoverFrac != null && uv.points.length > 0) {
      const targetNm = 220 + panel._spectroHoverFrac * 530;
      let nearest = uv.points[0];
      for (const pt of uv.points) {
        if (Math.abs(pt.nm - targetNm) < Math.abs(nearest.nm - targetNm)) nearest = pt;
      }
      let interpA = nearest.A;
      let interpT = nearest.T;
      for (let i = 0; i < uv.points.length - 1; i++) {
        const p0 = uv.points[i];
        const p1 = uv.points[i + 1];
        if (p0.nm <= targetNm && p1.nm >= targetNm && p1.nm !== p0.nm) {
          const u = (targetNm - p0.nm) / (p1.nm - p0.nm);
          interpA = p0.A + (p1.A - p0.A) * u;
          interpT = p0.T + (p1.T - p0.T) * u;
          break;
        }
      }
      const hx = xToPx(targetNm);
      const hy = yToPx(interpA);
      ctx.strokeStyle = isDark ? 'rgba(251,191,36,0.7)' : 'rgba(217,119,6,0.7)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
      ctx.fill();

      const dispNm = Math.round(targetNm);
      const nearPeak = uv.peaks.find((pk) => Math.abs(pk.nm - dispNm) <= 22);
      const pkTxt = nearPeak ? ` · ${isEn ? nearPeak.labelEn : nearPeak.labelVi}` : '';
      if (hoverEl) hoverEl.textContent = `${dispNm} nm (${dispNm < 380 ? 'UV' : 'Vis'}) · A=${interpA.toFixed(3)} · ${interpT.toFixed(1)}% T${pkTxt}`;
    } else if (hoverEl) {
      hoverEl.textContent = contactV ? t('specHoverHint') : t('specNoVessel');
    }

    if (peaksEl) {
      peaksEl.innerHTML =
        uv.peaks.length > 0
          ? uv.peaks
              .map(
                (pk) =>
                  `<span class="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-400 font-mono">${pk.nm} nm: ${isEn ? pk.labelEn : pk.labelVi}</span>`
              )
              .join('')
          : `<span class="text-muted">${contactV ? (isEn ? 'Transparent in 220–750 nm' : 'Không hấp thụ vùng 220–750 nm') : ''}</span>`;
    }
}

export function drawVesselMoleChart(panel) {
    const canvas = panel.container.querySelector('#vessel-mole-chart');
    const legendEl = panel.container.querySelector('#chart-legend');
    const item = panel.sim.getItem(panel.sim.selectedId);
    if (!canvas || !item || item.kind !== 'vessel') return;

    const w = canvas.width;
    const h = canvas.height;
    const hist = item.history;
    if (!hist || hist.length < 2) {
      const placeholderKey = `${w}x${h}|${panel.isDark ? 1 : 0}`;
      if (canvas.dataset.placeholderKey === placeholderKey) return;
      canvas.dataset.placeholderKey = placeholderKey;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = panel.isDark ? '#64748b' : '#94a3b8';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('n(t)', w / 2, h / 2 + 4);
      if (legendEl) legendEl.innerHTML = '';
      return;
    }
    delete canvas.dataset.placeholderKey;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    // Pick top reactive / non-water species present in history
    const totals = {};
    for (const pt of hist) {
      for (const [k, v] of Object.entries(pt.moles)) {
        if (k === 'H2O_l') continue;
        totals[k] = Math.max(totals[k] || 0, v);
      }
    }
    const keys = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k]) => k);

    if (keys.length === 0) {
      if (legendEl) legendEl.innerHTML = '';
      return;
    }

    const tMin = hist[0].t;
    const tMax = Math.max(tMin + 1, hist[hist.length - 1].t);
    let maxMol = 1e-5;
    for (const k of keys) maxMol = Math.max(maxMol, totals[k]);

    // Grid lines
    ctx.strokeStyle = panel.isDark ? 'rgba(148,163,184,0.12)' : 'rgba(15,23,42,0.08)';
    ctx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      const gy = (h * g) / 4;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    const padX = 8;
    const padY = 10;
    keys.forEach((k, idx) => {
      const col = CHART_PALETTE[idx % CHART_PALETTE.length];
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      hist.forEach((pt, pIdx) => {
        const val = pt.moles[k] || 0;
        const px = padX + ((pt.t - tMin) / (tMax - tMin)) * (w - padX * 2);
        const py = h - padY - (val / maxMol) * (h - padY * 2);
        if (pIdx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    });

    if (legendEl) {
      const gasLabels = {
        H2_g_total: 'H₂↑',
        HCl_g_total: 'HCl↑',
        Cl2_g_total: 'Cl₂↑',
        NO2_g_total: 'NO₂↑',
        NO_g_total: 'NO↑',
        N2O_g_total: 'N₂O↑',
        N2_g_total: 'N₂↑',
      };
      legendEl.innerHTML = keys
        .map((k, idx) => {
          const label = gasLabels[k] || SPECIES[k]?.formula || k;
          const col = CHART_PALETTE[idx % CHART_PALETTE.length];
          return `<span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full inline-block" style="background:${col}"></span><span>${label}</span></span>`;
        })
        .join('');
    }
}
