/**
 * Unified Zero-Dependency Report, Chart, Spectrum, TLC & Workbench Exporter (Prompt 80).
 * Supports crisp 2× PNG, opaque-white JPG, standalone pure-JS PDF 1.4 (DCTDecode), UTF-8 CSV,
 * and vector @media print Laboratory Reports.
 */

import { SPECIES, GAS_DISPLAY_META } from '../data/species.js';
import { APPARATUS } from '../data/apparatus.js';
import { CONSTANTS, kelvinToCelsius } from '../data/constants.js';
import {
  computeUvVisSpectrum,
  computeIrSpectrum,
  COLORIMETER_WAVELENGTHS,
} from '../engine/analyticalTools.js';
import {
  computeLiquidSpeciesTableData,
  computeLiquidVolumeL,
  computePH,
  computeContentsMassG,
} from '../engine/equilibrium.js';
import { sanitizeLabFilenameSlug } from './xlsxExport.js';

const CHART_SERIES_COLORS = ['#0284c7', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0d9488'];

export function buildExportFilename(labName, kindSlug, ext) {
  const labSlug = sanitizeLabFilenameSlug(labName || 'lab');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const cleanKind = String(kindSlug || 'export')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'export';
  return `chemlab_${labSlug}_${cleanKind}_${stamp}.${ext}`;
}

export function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1500);
}

function escapeCsvCell(val) {
  const s = String(val ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportCsvFile(headers, rows, filename) {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(','));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  triggerBlobDownload(blob, filename);
}

/**
 * Pure-JS 1-page PDF 1.4 generator embedding a high-res JPEG canvas image via DCTDecode.
 * Because all typography (Vietnamese, subscripts, cm^-1, ΔH_rxn) is pre-rasterized at 2x-2.5x,
 * Unicode renders losslessly across all PDF viewers with zero font-embedding glitches.
 */
export function buildPdfBytesFromCanvas(canvas) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
  const b64 = dataUrl.split(',')[1] || '';
  const binStr = atob(b64);
  const jpegBytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) jpegBytes[i] = binStr.charCodeAt(i);

  const pxW = Math.max(1, canvas.width);
  const pxH = Math.max(1, canvas.height);
  const isLandscape = pxW >= pxH;
  const pageW = isLandscape ? 842 : 595;
  const pageH = isLandscape ? 595 : 842;
  const margin = 28;
  const maxW = pageW - margin * 2;
  const maxH = pageH - margin * 2;
  const fitScale = Math.min(maxW / pxW, maxH / pxH);
  const drawW = +(pxW * fitScale).toFixed(2);
  const drawH = +(pxH * fitScale).toFixed(2);
  const drawX = +((pageW - drawW) / 2).toFixed(2);
  const drawY = +((pageH - drawH) / 2).toFixed(2);

  const contentStream = `q\n${drawW} 0 0 ${drawH} ${drawX} ${drawY} cm\n/Im0 Do\nQ\n`;
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [0];

  const pushStr = (s) => {
    const b = enc.encode(s);
    chunks.push(b);
    offset += b.length;
  };
  const pushBytes = (b) => {
    chunks.push(b);
    offset += b.length;
  };
  const startObj = (id) => {
    offsets[id] = offset;
    pushStr(`${id} 0 obj\n`);
  };

  pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  startObj(1);
  pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  startObj(2);
  pushStr('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  startObj(3);
  pushStr(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`);

  startObj(4);
  pushStr(`<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`);

  startObj(5);
  pushStr(`<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  pushBytes(jpegBytes);
  pushStr('\nendstream\nendobj\n');

  const xrefPos = offset;
  pushStr('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) {
    pushStr(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export function exportCanvasInFormat(canvas, format, filename) {
  const fmt = String(format || 'png').toLowerCase();
  if (fmt === 'pdf') {
    const pdfBytes = buildPdfBytesFromCanvas(canvas);
    triggerBlobDownload(new Blob([pdfBytes], { type: 'application/pdf' }), filename);
    return;
  }
  if (fmt === 'jpg' || fmt === 'jpeg') {
    canvas.toBlob(
      (blob) => {
        if (blob) triggerBlobDownload(blob, filename);
      },
      'image/jpeg',
      0.95
    );
    return;
  }
  canvas.toBlob((blob) => {
    if (blob) triggerBlobDownload(blob, filename);
  }, 'image/png');
}

function createHiResReportCanvas({ width = 920, height = 540, scale = 2, title = '', subtitle = '', footer = '' }, drawBody) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Solid bright paper background prevents transparent black-background artifacts in JPG/PDF
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(12, 12, width - 24, height - 24);

  const headerH = 54;
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(13, 13, width - 26, headerH);
  ctx.strokeStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.moveTo(13, 13 + headerH);
  ctx.lineTo(width - 13, 13 + headerH);
  ctx.stroke();

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 16px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title, 26, 22);

  if (subtitle) {
    ctx.fillStyle = '#475569';
    ctx.font = '11.5px ui-monospace, monospace';
    ctx.fillText(subtitle, 26, 44);
  }

  const stampText = footer || `ChemLab Studio · ${new Date().toLocaleString()}`;
  ctx.fillStyle = '#64748b';
  ctx.font = '10.5px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(stampText, width - 24, height - 18);

  const box = {
    x: 26,
    y: 13 + headerH + 14,
    w: width - 52,
    h: height - (13 + headerH + 14) - 34,
  };
  drawBody(ctx, box);
  return canvas;
}

export function renderExportActionsBarHtml({ idPrefix, hasCsv = true, label = 'Export' }) {
  return `
    <div class="flex flex-wrap items-center justify-between gap-1 pt-1.5 border-t border-theme/40">
      <span class="text-[10.5px] font-medium text-muted">${label}:</span>
      <div class="flex items-center gap-1 flex-wrap">
        <button type="button" class="exp-act-btn px-1.5 py-0.5 rounded border border-theme bg-surface text-[10.5px] font-mono font-semibold hover:border-accent" data-exp-prefix="${idPrefix}" data-exp-fmt="png">PNG</button>
        <button type="button" class="exp-act-btn px-1.5 py-0.5 rounded border border-theme bg-surface text-[10.5px] font-mono font-semibold hover:border-accent" data-exp-prefix="${idPrefix}" data-exp-fmt="jpg">JPG</button>
        <button type="button" class="exp-act-btn px-1.5 py-0.5 rounded border border-theme bg-surface text-[10.5px] font-mono font-semibold hover:border-accent" data-exp-prefix="${idPrefix}" data-exp-fmt="pdf">PDF</button>
        ${hasCsv ? `<button type="button" class="exp-act-btn px-1.5 py-0.5 rounded border border-theme bg-surface text-[10.5px] font-mono font-semibold text-emerald-400 hover:border-emerald-500" data-exp-prefix="${idPrefix}" data-exp-fmt="csv">CSV</button>` : ''}
      </div>
    </div>
  `;
}

export function exportSpectrometerAsset({ format, item, vessel, t, lang, labName }) {
  const mode = item.spectroMode || 'uvvis_spectrum';
  const isIr = mode === 'ir_spectrum';
  const isEn = lang === 'en';
  const sampleName = vessel ? `${t(APPARATUS[vessel.typeId].i18nKey)} ${vessel.label}` : (isEn ? 'Empty Cell (Air)' : 'Buồng đo trống');

  if (format === 'csv') {
    if (isIr) {
      const ir = computeIrSpectrum(vessel, { subtractWater: item.irSubtractWater !== false, stepCm: 10 });
      const filename = buildExportFilename(labName, `ftir-${vessel?.label || 'cell'}`, 'csv');
      exportCsvFile(['Wavenumber (cm^-1)', 'Transmittance (%T)', 'Absorbance (A)'], ir.points.map((p) => [p.wn, +p.T.toFixed(2), +p.A.toFixed(4)]), filename);
    } else {
      const uv = computeUvVisSpectrum(vessel, 2);
      const filename = buildExportFilename(labName, `uvvis-${vessel?.label || 'cell'}`, 'csv');
      exportCsvFile(['Wavelength (nm)', 'Absorbance (A)', 'Transmittance (%T)'], uv.points.map((p) => [p.nm, +p.A.toFixed(4), +p.T.toFixed(2)]), filename);
    }
    return;
  }

  const title = isIr
    ? (isEn ? `ATR FT-IR Spectrum — ${sampleName}` : `Phổ hồng ngoại ATR FT-IR — ${sampleName}`)
    : (isEn ? `UV–Vis Absorption Spectrum — ${sampleName}` : `Phổ hấp thụ UV–Vis — ${sampleName}`);

  const canvas = createHiResReportCanvas(
    {
      width: 960,
      height: 540,
      scale: 2,
      title,
      subtitle: isIr
        ? `4000 → 400 cm⁻¹ (%T) · ${item.irSubtractWater !== false ? (isEn ? 'H₂O subtracted' : 'Đã trừ nền H₂O') : 'With H₂O'}`
        : `220 – 750 nm · Absorbance A(λ)`,
    },
    (ctx, box) => {
      const padL = 54;
      const padR = 22;
      const padT = 18;
      const padB = 56;
      const plotX = box.x + padL;
      const plotY = box.y + padT;
      const plotW = box.w - padL - padR;
      const plotH = box.h - padT - padB;

      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1;
      ctx.strokeRect(plotX, plotY, plotW, plotH);

      if (isIr) {
        const ir = computeIrSpectrum(vessel, { subtractWater: item.irSubtractWater !== false, stepCm: 10 });
        const xToPx = (wn) => plotX + ((4000 - wn) / 3600) * plotW;
        const yToPx = (T) => plotY + ((100 - Math.max(0, Math.min(100, T))) / 100) * plotH;

        for (let g = 0; g <= 4; g++) {
          const val = 100 - g * 25;
          const gy = yToPx(val);
          ctx.strokeStyle = '#e2e8f0';
          ctx.beginPath();
          ctx.moveTo(plotX, gy);
          ctx.lineTo(plotX + plotW, gy);
          ctx.stroke();
          ctx.fillStyle = '#475569';
          ctx.font = '11px ui-monospace, monospace';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${val}%`, plotX - 8, gy);
        }

        for (const tick of [4000, 3500, 3000, 2500, 2000, 1750, 1500, 1000, 500]) {
          const tx = xToPx(tick);
          ctx.strokeStyle = '#e2e8f0';
          ctx.beginPath();
          ctx.moveTo(tx, plotY);
          ctx.lineTo(tx, plotY + plotH);
          ctx.stroke();
          ctx.fillStyle = '#475569';
          ctx.font = '11px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(String(tick), tx, plotY + plotH + 8);
        }
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText(isEn ? 'Wavenumber (cm⁻¹)' : 'Số sóng (cm⁻¹)', plotX + plotW / 2, plotY + plotH + 28);

        if (ir.points.length > 1) {
          ctx.strokeStyle = '#ea580c';
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ir.points.forEach((pt, idx) => {
            const px = xToPx(pt.wn);
            const py = yToPx(pt.T);
            if (idx === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.stroke();
        }

        const placed = [];
        for (const pk of ir.peaks.slice(0, 6)) {
          const px = xToPx(pk.wn);
          const py = yToPx(pk.T);
          ctx.fillStyle = '#0284c7';
          ctx.beginPath();
          ctx.arc(px, py, 3.6, 0, Math.PI * 2);
          ctx.fill();
          const tag = `${String(isEn ? pk.labelEn : pk.labelVi)} (${pk.wn})`;
          let lx = Math.max(plotX + 64, Math.min(plotX + plotW - 64, px));
          let ly = Math.min(plotY + plotH - 10, py + 15);
          for (const b of placed) {
            if (Math.abs(lx - b.x) < 120 && Math.abs(ly - b.y) < 16) ly = Math.max(plotY + 14, py - 14);
          }
          placed.push({ x: lx, y: ly });
          ctx.fillStyle = '#0f172a';
          ctx.font = '600 10.5px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(tag, lx, ly);
        }
      } else {
        const uv = computeUvVisSpectrum(vessel, 2);
        const maxScaleA = Math.max(0.5, Math.min(3.5, Math.ceil((uv.maxA || 0.4) * 4) / 4));
        const xToPx = (nm) => plotX + ((nm - 220) / 530) * plotW;
        const yToPx = (A) => plotY + plotH - (Math.min(maxScaleA, Math.max(0, A)) / maxScaleA) * plotH;

        const x380 = xToPx(380);
        ctx.fillStyle = 'rgba(139, 92, 246, 0.08)';
        ctx.fillRect(plotX, plotY, Math.max(0, x380 - plotX), plotH);
        const visGrad = ctx.createLinearGradient(x380, 0, plotX + plotW, 0);
        visGrad.addColorStop(0, '#7c3aed');
        visGrad.addColorStop(0.2, '#2563eb');
        visGrad.addColorStop(0.4, '#10b981');
        visGrad.addColorStop(0.6, '#eab308');
        visGrad.addColorStop(0.8, '#f97316');
        visGrad.addColorStop(1, '#ef4444');
        ctx.fillStyle = visGrad;
        ctx.fillRect(x380, plotY + plotH + 1, plotX + plotW - x380, 4);

        for (let g = 0; g <= 4; g++) {
          const val = (maxScaleA * (4 - g)) / 4;
          const gy = yToPx(val);
          ctx.strokeStyle = '#e2e8f0';
          ctx.beginPath();
          ctx.moveTo(plotX, gy);
          ctx.lineTo(plotX + plotW, gy);
          ctx.stroke();
          ctx.fillStyle = '#475569';
          ctx.font = '11px ui-monospace, monospace';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(val.toFixed(2), plotX - 8, gy);
        }
        for (const tick of [220, 300, 380, 450, 525, 600, 700, 750]) {
          const tx = xToPx(tick);
          ctx.strokeStyle = '#e2e8f0';
          ctx.beginPath();
          ctx.moveTo(tx, plotY);
          ctx.lineTo(tx, plotY + plotH);
          ctx.stroke();
          ctx.fillStyle = '#475569';
          ctx.font = '11px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(String(tick), tx, plotY + plotH + 10);
        }
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText(isEn ? 'Wavelength λ (nm)' : 'Bước sóng λ (nm)', plotX + plotW / 2, plotY + plotH + 30);

        if (uv.points.length > 1) {
          ctx.beginPath();
          uv.points.forEach((pt, idx) => {
            const px = xToPx(pt.nm);
            const py = yToPx(pt.A);
            if (idx === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.strokeStyle = '#0284c7';
          ctx.lineWidth = 2.4;
          ctx.stroke();
          ctx.lineTo(plotX + plotW, plotY + plotH);
          ctx.lineTo(plotX, plotY + plotH);
          ctx.closePath();
          ctx.fillStyle = 'rgba(2, 132, 199, 0.12)';
          ctx.fill();
        }
        for (const pk of uv.peaks.slice(0, 5)) {
          const px = xToPx(pk.nm);
          const py = yToPx(pk.A);
          ctx.fillStyle = '#d97706';
          ctx.beginPath();
          ctx.arc(px, py, 3.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#0f172a';
          ctx.font = '600 10.5px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`${pk.nm} nm · ${isEn ? pk.labelEn : pk.labelVi}`, Math.max(plotX + 60, Math.min(plotX + plotW - 60, px)), Math.max(plotY + 12, py - 10));
        }
      }
    }
  );
  const kind = isIr ? `ftir-${vessel?.label || 'cell'}` : `uvvis-${vessel?.label || 'cell'}`;
  exportCanvasInFormat(canvas, format, buildExportFilename(labName, kind, format));
}

export function exportAnalyticalProbeAsset({ format, item, t, lang, labName }) {
  const isEn = lang === 'en';
  const hist = item.history || [];
  const isPh = item.kind === 'ph_conductometer';

  if (format === 'csv') {
    if (isPh) {
      const fn = buildExportFilename(labName, `ph-ec-${item.label}`, 'csv');
      exportCsvFile(['Time (s)', 'Titrant Volume (mL)', 'pH', 'Conductivity (mS/cm)'], hist.map((p) => [+p.t.toFixed(2), +(p.ml || 0).toFixed(3), p.pH == null ? '' : +p.pH.toFixed(3), +(p.kappa || 0).toFixed(3)]), fn);
    } else {
      const fn = buildExportFilename(labName, `kinetics-${item.label}`, 'csv');
      const wl = item.wavelengthNm || 525;
      exportCsvFile(['Time (s)', 'Absorbance (A)', 'Transmittance (%T)', 'Wavelength (nm)'], hist.map((p) => [+p.t.toFixed(2), +(p.A || 0).toFixed(4), +(100 * Math.pow(10, -(p.A || 0))).toFixed(2), wl]), fn);
    }
    return;
  }

  const title = isPh
    ? `${isEn ? 'Titration / pH & Conductivity Curve' : 'Đường cong chuẩn độ pH(V) & Độ dẫn σ'} — ${item.label}`
    : `${isEn ? 'Beer–Lambert Kinetics A(t)' : 'Động học hấp thụ quang A(t)'} — ${item.label} (${item.wavelengthNm || 525} nm)`;

  const canvas = createHiResReportCanvas(
    { width: 900, height: 520, scale: 2, title, subtitle: `${hist.length} ${isEn ? 'recorded points' : 'điểm đo'}` },
    (ctx, box) => {
      const padL = 56;
      const padR = isPh ? 56 : 24;
      const padT = 16;
      const padB = 56;
      const plotX = box.x + padL;
      const plotY = box.y + padT;
      const plotW = box.w - padL - padR;
      const plotH = box.h - padT - padB;

      ctx.strokeStyle = '#cbd5e1';
      ctx.strokeRect(plotX, plotY, plotW, plotH);

      if (hist.length < 2) {
        ctx.fillStyle = '#64748b';
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(isEn ? 'Not enough data points yet' : 'Chưa có đủ điểm dữ liệu đo', plotX + plotW / 2, plotY + plotH / 2);
        return;
      }

      if (isPh) {
        const useVol = (hist[hist.length - 1].ml || 0) > (hist[0].ml || 0) + 0.05;
        const xMin = useVol ? hist[0].ml : hist[0].t;
        const xMax = Math.max(xMin + 0.1, useVol ? hist[hist.length - 1].ml : hist[hist.length - 1].t);
        const maxK = Math.max(1, ...hist.map((p) => p.kappa || 0));

        for (let g = 0; g <= 4; g++) {
          const gy = plotY + (plotH * g) / 4;
          ctx.strokeStyle = '#e2e8f0';
          ctx.beginPath();
          ctx.moveTo(plotX, gy);
          ctx.lineTo(plotX + plotW, gy);
          ctx.stroke();
          ctx.fillStyle = '#059669';
          ctx.font = '11px ui-monospace, monospace';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(`pH ${(14 - g * 3.5).toFixed(1)}`, plotX - 8, gy);
          ctx.fillStyle = '#0284c7';
          ctx.textAlign = 'left';
          ctx.fillText(`${((maxK * (4 - g)) / 4).toFixed(1)}`, plotX + plotW + 8, gy);
        }

        // pH line
        ctx.strokeStyle = '#059669';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        hist.forEach((pt, i) => {
          const xv = useVol ? pt.ml : pt.t;
          const px = plotX + ((xv - xMin) / (xMax - xMin)) * plotW;
          const py = plotY + plotH - (Math.max(0, Math.min(14, pt.pH ?? 7)) / 14) * plotH;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();

        // Conductivity line
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        hist.forEach((pt, i) => {
          const xv = useVol ? pt.ml : pt.t;
          const px = plotX + ((xv - xMin) / (xMax - xMin)) * plotW;
          const py = plotY + plotH - ((pt.kappa || 0) / maxK) * plotH;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();

        ctx.fillStyle = '#475569';
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${xMin.toFixed(1)}${useVol ? ' mL' : ' s'}`, plotX, plotY + plotH + 12);
        ctx.textAlign = 'right';
        ctx.fillText(`${xMax.toFixed(1)}${useVol ? ' mL' : ' s'}`, plotX + plotW, plotY + plotH + 12);

        // Legend
        ctx.fillStyle = '#059669';
        ctx.fillRect(plotX + 8, plotY + plotH + 34, 14, 3.5);
        ctx.fillStyle = '#0f172a';
        ctx.textAlign = 'left';
        ctx.font = '600 11.5px system-ui, sans-serif';
        ctx.fillText('pH', plotX + 28, plotY + plotH + 36);
        ctx.fillStyle = '#0284c7';
        ctx.fillRect(plotX + 86, plotY + plotH + 34, 14, 3.5);
        ctx.fillStyle = '#0f172a';
        ctx.fillText(isEn ? 'Conductivity σ (mS/cm)' : 'Độ dẫn điện σ (mS/cm)', plotX + 106, plotY + plotH + 36);
      } else {
        const tMin = hist[0].t;
        const tMax = Math.max(tMin + 0.2, hist[hist.length - 1].t);
        const maxA = Math.max(0.2, ...hist.map((p) => p.A || 0));
        for (let g = 0; g <= 4; g++) {
          const gy = plotY + (plotH * g) / 4;
          ctx.strokeStyle = '#e2e8f0';
          ctx.beginPath();
          ctx.moveTo(plotX, gy);
          ctx.lineTo(plotX + plotW, gy);
          ctx.stroke();
          ctx.fillStyle = '#475569';
          ctx.font = '11px ui-monospace, monospace';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(((maxA * (4 - g)) / 4).toFixed(2), plotX - 8, gy);
        }
        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        hist.forEach((pt, i) => {
          const px = plotX + ((pt.t - tMin) / (tMax - tMin)) * plotW;
          const py = plotY + plotH - ((pt.A || 0) / maxA) * plotH;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.fillStyle = '#475569';
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(isEn ? `Time t (${tMin.toFixed(1)} – ${tMax.toFixed(1)} s)` : `Thời gian t (${tMin.toFixed(1)} – ${tMax.toFixed(1)} s)`, plotX + plotW / 2, plotY + plotH + 14);
      }
    }
  );
  exportCanvasInFormat(canvas, format, buildExportFilename(labName, `${item.kind}-${item.label}`, format));
}

export function exportVesselMoleChartAsset({ format, vessel, t, lang, labName }) {
  const isEn = lang === 'en';
  const hist = vessel?.history || [];
  const totals = {};
  for (const pt of hist) {
    for (const [k, v] of Object.entries(pt.moles || {})) {
      if (k === 'H2O_l') continue;
      totals[k] = Math.max(totals[k] || 0, v);
    }
  }
  const keys = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
  const gasLabels = { H2_g_total: 'H₂↑', HCl_g_total: 'HCl↑', Cl2_g_total: 'Cl₂↑', NO2_g_total: 'NO₂↑', NO_g_total: 'NO↑', N2O_g_total: 'N₂O↑', N2_g_total: 'N₂↑' };
  const labelOf = (k) => gasLabels[k] || SPECIES[k]?.formula || k;

  if (format === 'csv') {
    const fn = buildExportFilename(labName, `moles-${vessel?.label || 'vessel'}`, 'csv');
    const headers = ['Time (s)', ...keys.map((k) => `${labelOf(k)} (mol)`)];
    const rows = hist.map((pt) => [+pt.t.toFixed(2), ...keys.map((k) => +(pt.moles?.[k] || 0).toFixed(6))]);
    exportCsvFile(headers, rows, fn);
    return;
  }

  const vesselTitle = `${t(APPARATUS[vessel.typeId].i18nKey)} ${vessel.label}`;
  const canvas = createHiResReportCanvas(
    {
      width: 900,
      height: 540,
      scale: 2,
      title: isEn ? `Real-Time Moles n(t) — ${vesselTitle}` : `Diễn biến số mol n(t) — ${vesselTitle}`,
      subtitle: `${hist.length} pts · T = ${kelvinToCelsius(vessel.tempK).toFixed(1)}°C`,
    },
    (ctx, box) => {
      const padL = 62;
      const padR = 22;
      const padT = 16;
      const padB = 82;
      const plotX = box.x + padL;
      const plotY = box.y + padT;
      const plotW = box.w - padL - padR;
      const plotH = box.h - padT - padB;
      ctx.strokeStyle = '#cbd5e1';
      ctx.strokeRect(plotX, plotY, plotW, plotH);

      if (hist.length < 2 || keys.length === 0) {
        ctx.fillStyle = '#64748b';
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(isEn ? 'Not enough kinetic data' : 'Chưa có đủ dữ liệu động học', plotX + plotW / 2, plotY + plotH / 2);
        return;
      }

      const tMin = hist[0].t;
      const tMax = Math.max(tMin + 1, hist[hist.length - 1].t);
      const maxMol = Math.max(1e-5, ...keys.map((k) => totals[k]));
      for (let g = 0; g <= 4; g++) {
        const gy = plotY + (plotH * g) / 4;
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(plotX, gy);
        ctx.lineTo(plotX + plotW, gy);
        ctx.stroke();
        ctx.fillStyle = '#475569';
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(((maxMol * (4 - g)) / 4).toFixed(3), plotX - 8, gy);
      }

      keys.forEach((k, idx) => {
        const col = CHART_SERIES_COLORS[idx % CHART_SERIES_COLORS.length];
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        hist.forEach((pt, pi) => {
          const px = plotX + ((pt.t - tMin) / (tMax - tMin)) * plotW;
          const py = plotY + plotH - ((pt.moles?.[k] || 0) / maxMol) * plotH;
          if (pi === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });

      ctx.fillStyle = '#475569';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${tMin.toFixed(1)} s`, plotX, plotY + plotH + 10);
      ctx.textAlign = 'right';
      ctx.fillText(`${tMax.toFixed(1)} s`, plotX + plotW, plotY + plotH + 10);

      // Legend swatches below chart
      let lx = plotX;
      let ly = plotY + plotH + 34;
      keys.forEach((k, idx) => {
        const col = CHART_SERIES_COLORS[idx % CHART_SERIES_COLORS.length];
        const lbl = labelOf(k);
        if (lx + 120 > plotX + plotW) {
          lx = plotX;
          ly += 20;
        }
        ctx.fillStyle = col;
        ctx.fillRect(lx, ly, 14, 4);
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 11.5px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(lbl, lx + 20, ly + 2);
        lx += Math.max(92, lbl.length * 8 + 44);
      });
    }
  );
  exportCanvasInFormat(canvas, format, buildExportFilename(labName, `moles-${vessel.label}`, format));
}

export function exportCompareChartAsset({ format, sim, metric, t, lang, labName }) {
  const isEn = lang === 'en';
  const compareVessels = (sim.compareVesselIds || []).map((id) => sim.getItem(id)).filter((v) => v && !v.isShattered).slice(0, 3);
  const slotColors = ['#0284c7', '#d97706', '#059669'];
  const slotTags = ['A', 'B', 'C'];
  const valField = metric === 'temp' ? 'tempC' : metric === 'gas' ? 'gasMmol' : metric === 'ph' ? 'ph' : 'rateMmolS';
  const metricLabel =
    metric === 'temp' ? 'Temp (°C)' : metric === 'gas' ? 'Gas (mmol)' : metric === 'ph' ? 'pH' : (isEn ? 'Rate (mmol/s)' : 'Tốc độ (mmol/s)');

  if (format === 'csv') {
    const fn = buildExportFilename(labName, `compare-${metric}`, 'csv');
    const maxLen = Math.max(0, ...compareVessels.map((v) => (v.compareHistory || []).length));
    const headers = ['Index', ...compareVessels.flatMap((v, idx) => [`${slotTags[idx]}_${v.label}_t(s)`, `${slotTags[idx]}_${v.label}_${valField}`])];
    const rows = [];
    for (let i = 0; i < maxLen; i++) {
      const r = [i];
      for (const v of compareVessels) {
        const pt = v.compareHistory?.[i];
        r.push(pt ? +pt.t.toFixed(2) : '', pt ? +(pt[valField] ?? 0).toFixed(4) : '');
      }
      rows.push(r);
    }
    exportCsvFile(headers, rows, fn);
    return;
  }

  const canvas = createHiResReportCanvas(
    {
      width: 900,
      height: 540,
      scale: 2,
      title: isEn ? `Multi-Vessel Kinetic Comparison — ${metricLabel}` : `So sánh đa bình — ${metricLabel}`,
      subtitle: compareVessels.map((v, idx) => `[${slotTags[idx]}] ${v.label}`).join('  ·  ') || '—',
    },
    (ctx, box) => {
      const padL = 58;
      const padR = 22;
      const padT = 16;
      const padB = 72;
      const plotX = box.x + padL;
      const plotY = box.y + padT;
      const plotW = box.w - padL - padR;
      const plotH = box.h - padT - padB;
      ctx.strokeStyle = '#cbd5e1';
      ctx.strokeRect(plotX, plotY, plotW, plotH);

      let minT = Infinity;
      let maxT = -Infinity;
      let minY = metric === 'ph' ? 0 : 0;
      let maxY = metric === 'ph' ? 14 : 1;
      const series = compareVessels.map((v, idx) => {
        const pts = (v.compareHistory || []).map((pt) => {
          const y = Number(pt[valField] ?? 0);
          minT = Math.min(minT, pt.t);
          maxT = Math.max(maxT, pt.t);
          maxY = Math.max(maxY, y);
          if (y < minY) minY = y;
          return { t: pt.t, y };
        });
        return { v, tag: slotTags[idx], color: slotColors[idx], pts };
      });
      if (!Number.isFinite(minT)) { minT = 0; maxT = 10; }
      if (maxT - minT < 2) maxT = minT + 2;
      if (maxY - minY < 0.5) maxY = minY + 1;
      else maxY += (maxY - minY) * 0.1;

      for (let g = 0; g <= 4; g++) {
        const f = g / 4;
        const gy = plotY + plotH - f * plotH;
        const val = minY + f * (maxY - minY);
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(plotX, gy);
        ctx.lineTo(plotX + plotW, gy);
        ctx.stroke();
        ctx.fillStyle = '#475569';
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2), plotX - 8, gy);
      }

      for (const s of series) {
        if (s.pts.length === 0) continue;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        s.pts.forEach((p, idx) => {
          const px = plotX + ((p.t - minT) / (maxT - minT)) * plotW;
          const py = plotY + plotH - ((p.y - minY) / (maxY - minY)) * plotH;
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
      ctx.fillStyle = '#475569';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${minT.toFixed(0)}s`, plotX, plotY + plotH + 10);
      ctx.textAlign = 'right';
      ctx.fillText(`${maxT.toFixed(0)}s`, plotX + plotW, plotY + plotH + 10);

      let lx = plotX;
      series.forEach((s) => {
        ctx.fillStyle = s.color;
        ctx.fillRect(lx, plotY + plotH + 34, 14, 4);
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const lbl = `[${s.tag}] ${t(APPARATUS[s.v.typeId].i18nKey)} ${s.v.label}`;
        ctx.fillText(lbl, lx + 20, plotY + plotH + 36);
        lx += Math.max(170, lbl.length * 7 + 36);
      });
    }
  );
  exportCanvasInFormat(canvas, format, buildExportFilename(labName, `compare-${metric}`, format));
}

export function exportTlcPlateAsset({ format, plate, uvLight, t, lang, labName }) {
  const isEn = lang === 'en';
  const spots = plate?.spots || [];
  if (format === 'csv') {
    const fn = buildExportFilename(labName, `tlc-${plate.label}`, 'csv');
    exportCsvFile(
      ['Species ID', 'Formula', 'Name', 'Rf', 'UV-254 Active', 'Spot Color'],
      spots.map((sp) => [sp.id, sp.formula, sp.name, +sp.rf.toFixed(3), sp.uvActive ? 'YES' : 'NO', sp.color]),
      fn
    );
    return;
  }

  const canvas = createHiResReportCanvas(
    {
      width: 840,
      height: 480,
      scale: 2,
      title: isEn ? `Thin-Layer Chromatography (TLC) — ${plate.label}` : `Sắc ký lớp mỏng (TLC Silica F254) — ${plate.label}`,
      subtitle: `${uvLight ? 'UV-254 nm ON' : (isEn ? 'Normal Ambient Light' : 'Ánh sáng thường')} · Solvent front: ${((plate.solventFront || 0) * 100).toFixed(0)}%`,
    },
    (ctx, box) => {
      // Left panel: Plate visual
      const plateW = 148;
      const plateH = box.h - 28;
      const plateX = box.x + 36;
      const plateY = box.y + 14;
      ctx.fillStyle = uvLight ? '#16a34a' : '#f8fafc';
      ctx.strokeStyle = uvLight ? '#14532d' : '#64748b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(plateX, plateY, plateW, plateH, 6);
      ctx.fill();
      ctx.stroke();

      const originY = plateY + plateH - 28;
      const topLimY = plateY + 24;
      const maxRun = originY - topLimY;
      const sfFrac = Math.max(0, Math.min(1, plate.solventFront || 0));
      const sfY = originY - sfFrac * maxRun;

      if (sfFrac > 0.02) {
        ctx.fillStyle = uvLight ? 'rgba(20, 83, 45, 0.32)' : 'rgba(186, 230, 253, 0.42)';
        ctx.fillRect(plateX + 2, sfY, plateW - 4, plateY + plateH - sfY - 2);
        ctx.strokeStyle = uvLight ? '#86efac' : '#0284c7';
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(plateX + 4, sfY);
        ctx.lineTo(plateX + plateW - 4, sfY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Origin line
      ctx.strokeStyle = uvLight ? '#dcfce7' : '#475569';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(plateX + 10, originY);
      ctx.lineTo(plateX + plateW - 10, originY);
      ctx.stroke();

      spots.forEach((sp, idx) => {
        if (uvLight && !sp.uvActive) return;
        const laneCount = Math.min(3, Math.max(1, spots.length));
        const laneX = plateX + 28 + ((idx % laneCount) / Math.max(1, laneCount - 1)) * (plateW - 56);
        const curRf = Math.min(sp.rf, sfFrac);
        const sy = originY - curRf * maxRun;
        ctx.fillStyle = uvLight ? '#052e16' : sp.color || '#38bdf8';
        ctx.beginPath();
        ctx.ellipse(spots.length === 1 ? plateX + plateW / 2 : laneX, sy, 9.5, 7.2, 0, 0, Math.PI * 2);
        ctx.fill();
      });

      // Right panel: Spots Rf table
      const tblX = plateX + plateW + 46;
      const tblW = box.x + box.w - tblX;
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(tblX, plateY, tblW, 30);
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(isEn ? 'Analyte Spot' : 'Chất phân tích', tblX + 12, plateY + 15);
      ctx.fillText('UV-254', tblX + tblW - 150, plateY + 15);
      ctx.textAlign = 'right';
      ctx.fillText('Rf', tblX + tblW - 16, plateY + 15);

      if (spots.length === 0) {
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'left';
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillText(isEn ? 'No spots separated.' : 'Chưa có vết sắc ký.', tblX + 12, plateY + 56);
        return;
      }

      spots.forEach((sp, idx) => {
        const ry = plateY + 34 + idx * 34;
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(tblX, ry + 32);
        ctx.lineTo(tblX + tblW, ry + 32);
        ctx.stroke();

        ctx.fillStyle = uvLight ? (sp.uvActive ? '#052e16' : '#cbd5e1') : sp.color;
        ctx.beginPath();
        ctx.arc(tblX + 18, ry + 16, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 12px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${sp.formula}`, tblX + 32, ry + 16);

        ctx.fillStyle = sp.uvActive ? '#059669' : '#64748b';
        ctx.font = '11.5px ui-monospace, monospace';
        ctx.fillText(sp.uvActive ? 'Active (Quench)' : (isEn ? 'Hidden' : 'Không bắt UV'), tblX + tblW - 150, ry + 16);

        ctx.fillStyle = '#0284c7';
        ctx.font = 'bold 12.5px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(sp.rf.toFixed(2), tblX + tblW - 16, ry + 16);
      });
    }
  );
  exportCanvasInFormat(canvas, format, buildExportFilename(labName, `tlc-${plate.label}`, format));
}

export function composeWorkbenchSnapshotCanvas({ workbenchCanvas, isDark, sim, labName, lang }) {
  const isEn = lang === 'en';
  const tempC = kelvinToCelsius(sim.environment?.tempK ?? CONSTANTS.T_STD_K).toFixed(1);
  const pBar = (sim.environment?.pressureBar ?? CONSTANTS.P_STD_BAR).toFixed(2);
  const atmMode = sim.environment?.atmosphereMode || 'air';
  const srcW = Math.max(320, workbenchCanvas?.width || 1000);
  const srcH = Math.max(200, workbenchCanvas?.height || 640);
  const targetW = Math.min(1800, srcW);
  const scale = targetW / srcW;
  const imgH = Math.round(srcH * scale);
  const headerH = 56;
  const footerH = 30;

  const canvas = document.createElement('canvas');
  canvas.width = targetW + 32;
  canvas.height = headerH + imgH + footerH + 16;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`ChemLab Studio — ${labName || 'Workbench'}`, 16, 12);

  ctx.fillStyle = '#475569';
  ctx.font = '12.5px ui-monospace, monospace';
  ctx.fillText(`T = ${tempC}°C · P = ${pBar} bar · Atm: ${atmMode.toUpperCase()}`, 16, 36);

  // Fill active bench theme color behind the transparent workbench canvas so colors & glass shine cleanly
  ctx.fillStyle = isDark ? '#0b1220' : '#f1f5f9';
  ctx.fillRect(16, headerH, targetW, imgH);
  if (workbenchCanvas && workbenchCanvas.width > 0 && workbenchCanvas.height > 0) {
    ctx.drawImage(workbenchCanvas, 16, headerH, targetW, imgH);
  }
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(16, headerH, targetW, imgH);

  ctx.fillStyle = '#64748b';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${isEn ? 'Captured' : 'Chụp lúc'}: ${new Date().toLocaleString()}`, canvas.width - 16, headerH + imgH + 18);
  return canvas;
}

export function exportWorkbenchSnapshotAsset({ format, workbenchCanvas, isDark, sim, labName, lang }) {
  const canvas = composeWorkbenchSnapshotCanvas({ workbenchCanvas, isDark, sim, labName, lang });
  exportCanvasInFormat(canvas, format, buildExportFilename(labName, 'bench-snapshot', format));
}

function escPrintHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function openPrintableLabReport({ sim, workbenchCanvas, isDark, labName, t, lang, reportRootEl, missionResult = null }) {
  if (!reportRootEl) return;
  const isEn = lang === 'en';
  const benchCanvas = composeWorkbenchSnapshotCanvas({ workbenchCanvas, isDark, sim, labName, lang });
  const benchImgUrl = benchCanvas.toDataURL('image/png');
  const vessels = sim.items.filter((i) => i.kind === 'vessel' && !i.isShattered);
  const env = sim.environment || {};
  const mEval = missionResult || sim.missionState?.lastEvaluation || null;

  const missionHtml = mEval
    ? `
      <section class="print-mission-card">
        <h2>${escPrintHtml(isEn ? 'Practical Assessment Sheet' : 'Phiếu Thực hành & Chấm điểm')} — ${escPrintHtml(t(mEval.titleKey))}</h2>
        <div class="print-metrics-grid">
          <span><strong>${escPrintHtml(isEn ? 'Score' : 'Điểm số')}:</strong> ${mEval.totalScore.toFixed(1)} / 10</span>
          <span><strong>${escPrintHtml(isEn ? 'Grade' : 'Xếp loại')}:</strong> ${escPrintHtml(mEval.medal)} ${escPrintHtml(mEval.grade)}</span>
          <span><strong>${escPrintHtml(isEn ? 'Mode' : 'Chế độ')}:</strong> ${escPrintHtml(mEval.mode === 'exam' ? t('missionModeExam') : t('missionModePractice'))}</span>
          <span><strong>${escPrintHtml(isEn ? 'Time' : 'Thời gian')}:</strong> ${mEval.elapsedSec}s</span>
        </div>
        <table>
          <thead><tr><th>${escPrintHtml(isEn ? 'Criterion' : 'Tiêu chí')}</th><th>${escPrintHtml(isEn ? 'Detail' : 'Chi tiết')}</th><th>${escPrintHtml(isEn ? 'Points' : 'Điểm')}</th></tr></thead>
          <tbody>
            ${mEval.criteriaResults
              .map(
                (cr) => `<tr><td>${escPrintHtml(t(cr.labelKey))}</td><td>${escPrintHtml(cr.detail || cr.status)}</td><td><strong>${cr.earned.toFixed(1)} / ${cr.maxPoints.toFixed(1)}</strong></td></tr>`
              )
              .join('')}
          </tbody>
        </table>
        <p style="font-size:10.5px;margin:6px 0 0 0;"><strong>${escPrintHtml(t('missionEquationsTitle'))}:</strong> <code>${escPrintHtml(mEval.equationText)}</code></p>
      </section>
    `
    : '';

  const vesselsHtml = vessels
    .map((v) => {
      const spec = APPARATUS[v.typeId] || {};
      const isBlind = Boolean(v.hideComposition) && !mEval;
      const liqL = computeLiquidVolumeL(v.moles, v.tempK);
      const ph = v.isFrozenSolid || isBlind ? null : computePH(v.moles, liqL, v.tempK);
      const localPBar = v.internalPressureBar ?? env.pressureBar ?? CONSTANTS.P_STD_BAR;
      const massG = computeContentsMassG(v.moles);
      const liqData = computeLiquidSpeciesTableData(v.moles, v.tempK);
      const solids = isBlind
        ? []
        : Object.entries(v.moles || {})
            .filter(([id, n]) => n > 1e-8 && SPECIES[id]?.phase === 's')
            .map(([id, n]) => `${SPECIES[id].formula}: ${n.toFixed(4)} mol (${(n * SPECIES[id].molarMass).toFixed(2)} g)`);
      const gases = isBlind
        ? []
        : GAS_DISPLAY_META.map((g) => {
            const tot = (v.headspaceGasMoles?.[g.id] || 0) + (v.escapedGasMoles?.[g.id] || 0);
            return tot > 1e-6 ? `${g.formula}: ${(tot * 1000).toFixed(2)} mmol` : '';
          }).filter(Boolean);

      return `
        <section class="print-vessel-card">
          <h3>${escPrintHtml(t(spec.i18nKey || v.typeId))} ${escPrintHtml(isBlind ? (v.blindLabel || v.label) : v.label)}</h3>
          <div class="print-metrics-grid">
            <span>T = ${kelvinToCelsius(v.tempK).toFixed(1)}°C</span>
            <span>P = ${localPBar.toFixed(2)} bar</span>
            <span>pH = ${ph === null ? '—' : ph.toFixed(2)}</span>
            <span>V = ${(liqL * 1000).toFixed(2)} mL</span>
            <span>m = ${isBlind ? '🔒' : `${massG.toFixed(2)} g`}</span>
            <span>ρ = ${isBlind ? '🔒' : liqData.mixDensity > 0 ? liqData.mixDensity.toFixed(3) : '—'} g/mL</span>
          </div>
          ${
            isBlind
              ? `<p class="print-muted">🔒 ${escPrintHtml(t('blindUnknownBadge'))}</p>`
              : liqData.rows.length > 0
              ? `<table><thead><tr><th>${escPrintHtml(t('colSpecies'))}</th><th>mol</th><th>g</th><th>M</th></tr></thead><tbody>
                  ${liqData.rows.map((r) => {
                    const fStr = r.sp?.formula || r.formula || r.spId || '—';
                    const cVal = Number.isFinite(r.cM) && r.cM > 0 ? r.cM.toFixed(3) : r.molarityM != null ? r.molarityM.toFixed(3) : '—';
                    return `<tr><td>${escPrintHtml(fStr)}</td><td>${r.mol.toFixed(4)}</td><td>${r.massG.toFixed(3)}</td><td>${cVal}</td></tr>`;
                  }).join('')}
                </tbody></table>`
              : `<p class="print-muted">${escPrintHtml(t('emptyLiquidMsg'))}</p>`
          }
          ${solids.length > 0 ? `<p><strong>${escPrintHtml(t('solidTableTitle'))}:</strong> ${escPrintHtml(solids.join(' · '))}</p>` : ''}
          ${gases.length > 0 ? `<p><strong>${escPrintHtml(t('gasTableTitle'))}:</strong> ${escPrintHtml(gases.join(' · '))}</p>` : ''}
        </section>
      `;
    })
    .join('');

  const logItems = (sim.logs || [])
    .slice(0, 40)
    .map((l) => `<li><code>[${escPrintHtml(l.timeStr || '')}]</code> ${escPrintHtml(t(l.key, l.params))}</li>`);

  if (mEval && logItems.length < 4 && sim.missionTelemetry) {
    const tel = sim.missionTelemetry;
    const summarySteps = [];
    if (tel.usedPipetteTransfer) {
      const lbls = (tel.sampledBlindLabels || []).length ? ` (${tel.sampledBlindLabels.join(', ')})` : '';
      summarySteps.push(isEn ? `Pipette / sampling transfers recorded${lbls}` : `Đã thực hiện lấy mẫu bằng Pipette / ống nghiệm${lbls}`);
    }
    if (tel.usedLitmusOrPh) {
      summarySteps.push(isEn ? 'Used Litmus paper / pH indicator or pH-EC meter on solution' : 'Đã sử dụng Giấy quỳ tím / Chỉ thị pH hoặc Máy đo pH·EC');
    }
    if ((tel.usedBuretteDrops || 0) > 0) {
      summarySteps.push(isEn ? `Burette titration executed (${tel.usedBuretteDrops} drop steps)` : `Đã nhỏ giọt chuẩn độ bằng Burette (${tel.usedBuretteDrops} lượt nhỏ giọt)`);
    }
    if (tel.mortarGroundCaCO3) {
      summarySteps.push(isEn ? 'Ground solid CaCO₃ finely with Mortar & Pestle' : 'Đã nghiền mịn CaCO₃ bằng Cối chày');
    }
    if (tel.bunsenBlueUsed) {
      summarySteps.push(isEn ? 'Heated with roaring blue Bunsen burner flame' : 'Đã đun bằng ngọn lửa xanh Bunsen');
    }
    if (tel.gasDriedViaH2SO4 || tel.gasConnectedToSyringe) {
      summarySteps.push(
        isEn
          ? `Gas assembly verified (Drying H₂SO₄=${tel.gasDriedViaH2SO4 ? 'Yes' : 'No'}, Syringe=${tel.gasConnectedToSyringe ? 'Linked' : 'No'})`
          : `Hệ thống thu khí (Bình làm khô H₂SO₄=${tel.gasDriedViaH2SO4 ? 'Có' : 'Không'}, Gas Syringe=${tel.gasConnectedToSyringe ? 'Đã nối' : 'Chưa'})`
      );
    }
    if (tel.esterFormed || (tel.sepFunnelTaps || 0) > 0) {
      summarySteps.push(
        isEn
          ? `Organic synthesis/extraction trace (Ester=${tel.esterFormed ? 'Formed' : 'No'}, SepFunnel=${tel.sepFunnelTaps > 0 ? 'Opened' : 'No'})`
          : `Thao tác tổng hợp/chiết ester (Tạo ester=${tel.esterFormed ? 'Có' : 'Chưa'}, Phễu chiết=${tel.sepFunnelTaps > 0 ? 'Đã tách lớp' : 'Chưa'})`
      );
    }
    if ((tel.contaminatedBlindIds || []).length === 0 && (tel.shatteredCount || 0) === 0 && (tel.toxicLeakCount || 0) === 0 && (tel.overflowCount || 0) === 0) {
      summarySteps.push(isEn ? 'Lab safety & stock bottle integrity maintained (0 incidents)' : 'Tuân thủ an toàn phòng thí nghiệm & bảo toàn bình gốc (0 sự cố)');
    } else {
      summarySteps.push(
        isEn
          ? `Safety / contamination events: shatter=${tel.shatteredCount || 0}, spill=${tel.overflowCount || 0}, toxicLeak=${tel.toxicLeakCount || 0}, contaminated=${(tel.contaminatedBlindIds || []).length}`
          : `Ghi nhận sự cố / nhiễm bẩn mẫu: vỡ bình=${tel.shatteredCount || 0}, tràn=${tel.overflowCount || 0}, rò khí độc=${tel.toxicLeakCount || 0}, lẫn mẫu gốc=${(tel.contaminatedBlindIds || []).length}`
      );
    }
    for (const s of summarySteps) {
      logItems.push(`<li><code>[Telemetry]</code> ${escPrintHtml(s)}</li>`);
    }
  }
  const logsHtml = logItems.join('');

  reportRootEl.innerHTML = `
    <div class="print-report-page">
      <header class="print-report-hdr">
        <h1>ChemLab Studio — ${escPrintHtml(mEval ? (isEn ? 'Practical Assessment Sheet' : 'Phiếu Thực hành & Chấm điểm') : isEn ? 'Laboratory Report' : 'Báo cáo Thực hành Hóa học')}</h1>
        <p>${escPrintHtml(labName || 'Lab 1')} · ${new Date().toLocaleString()} · T = ${kelvinToCelsius(env.tempK ?? 298.15).toFixed(1)}°C · P = ${(env.pressureBar ?? 1.01325).toFixed(2)} bar</p>
      </header>
      ${missionHtml}
      <div class="print-bench-img-wrap">
        <img src="${benchImgUrl}" alt="Workbench Snapshot" />
      </div>
      <h2>${escPrintHtml(isEn ? 'Active Vessels & 3-Phase Composition' : 'Bình phản ứng & Thành phần 3 pha')}</h2>
      ${vesselsHtml || `<p class="print-muted">—</p>`}
      <h2>${escPrintHtml(t('reactionLogTitle'))}</h2>
      <ul class="print-log-list">${logsHtml || '<li>—</li>'}</ul>
    </div>
  `;

  if (typeof window !== 'undefined' && typeof window.print === 'function') {
    window.print();
  }
}
