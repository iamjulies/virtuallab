/**
 * Zero-dependency Multi-Sheet OOXML (.xlsx) workbook generator + ChemLab data extractors.
 * Uses uncompressed ZIP (Store method 0) + CRC32 readable by Excel, LibreOffice Calc & Google Sheets.
 */
import { APPARATUS } from '../data/apparatus.js';
import { CONSTANTS, kelvinToCelsius } from '../data/constants.js';
import { isSolidMoltenAtTemp, SPECIES } from '../data/species.js';
import {
  computeContentsMassG,
  computeLiquidSpeciesTableData,
  computeLiquidVolumeL,
  computePH,
  computeVesselElectrochemicalMetrics,
} from '../engine/equilibrium.js';
import { computeVesselRedoxAndCellMetrics } from '../engine/electrochemistry.js';
import { computeIrSpectrum, computeUvVisSpectrum } from '../engine/analyticalTools.js';
import {
  computeSyringeFrozenVolumeMl,
  computeSyringeGasVolumeMl,
  computeSyringeLiquidVolumeMl,
  computeSyringeTotalVolumeMl,
} from '../engine/gasNetwork.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colRef(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function sanitizeSheetName(rawName, usedSet = null) {
  let base = String(rawName || 'Sheet')
    .replace(/[\\/*?:\[\]]/g, '_')
    .replace(/[\r\n\t]/g, ' ')
    .trim();
  if (!base) base = 'Sheet';
  base = base.slice(0, 31).trim() || 'Sheet';
  if (!usedSet) return base;

  let candidate = base;
  let seq = 2;
  while (usedSet.has(candidate.toLowerCase())) {
    const suffix = `_${seq++}`;
    candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
  }
  usedSet.add(candidate.toLowerCase());
  return candidate;
}

function buildSheetXml(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const rowXml = safeRows
    .map((cells, rIdx) => {
      const rNum = rIdx + 1;
      const cellList = Array.isArray(cells) ? cells : [cells];
      const cellXml = cellList
        .map((val, cIdx) => {
          const ref = `${colRef(cIdx)}${rNum}`;
          if (typeof val === 'number' && Number.isFinite(val)) {
            return `<c r="${ref}"><v>${val}</v></c>`;
          }
          if (typeof val === 'boolean') {
            return `<c r="${ref}" t="b"><v>${val ? 1 : 0}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(val)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rNum}">${cellXml}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

/**
 * Build uncompressed multi-sheet OOXML (.xlsx) bytes.
 * Accepts either:
 *   1) Array of sheets: [{ name: 'Sheet1', rows: [[...], ...] }, ...]
 *   2) Single sheet 2D array of rows: [[...], ...] (backward-compatible)
 */
export function buildXlsxBytes(sheetsOrRows, fallbackSheetName = 'Composition') {
  const enc = new TextEncoder();
  const isSheetList =
    Array.isArray(sheetsOrRows) &&
    sheetsOrRows.length > 0 &&
    typeof sheetsOrRows[0] === 'object' &&
    sheetsOrRows[0] !== null &&
    !Array.isArray(sheetsOrRows[0]) &&
    Array.isArray(sheetsOrRows[0].rows);

  const rawSheets = isSheetList
    ? sheetsOrRows
    : [{ name: fallbackSheetName || 'Composition', rows: Array.isArray(sheetsOrRows) ? sheetsOrRows : [] }];

  const usedNames = new Set();
  const normSheets = (rawSheets.length > 0 ? rawSheets : [{ name: fallbackSheetName || 'Sheet1', rows: [[]] }]).map(
    (sh, idx) => ({
      sheetId: idx + 1,
      rId: `rId${idx + 1}`,
      path: `worksheets/sheet${idx + 1}.xml`,
      partPath: `/xl/worksheets/sheet${idx + 1}.xml`,
      zipName: `xl/worksheets/sheet${idx + 1}.xml`,
      safeName: sanitizeSheetName(sh?.name || `Sheet${idx + 1}`, usedNames),
      rows: Array.isArray(sh?.rows) ? sh.rows : [],
    })
  );

  const contentTypeOverrides = normSheets
    .map(
      (s) =>
        `  <Override PartName="${s.partPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('\n');
  const relEntries = normSheets
    .map(
      (s) =>
        `  <Relationship Id="${s.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${s.path}"/>`
    )
    .join('\n');
  const sheetNodes = normSheets
    .map((s) => `    <sheet name="${xmlEscape(s.safeName)}" sheetId="${s.sheetId}" r:id="${s.rId}"/>`)
    .join('\n');

  const files = [
    {
      name: '[Content_Types].xml',
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${contentTypeOverrides}
</Types>`
      ),
    },
    {
      name: '_rels/.rels',
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relEntries}
</Relationships>`
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${sheetNodes}
  </sheets>
</workbook>`
      ),
    },
    ...normSheets.map((s) => ({
      name: s.zipName,
      data: enc.encode(buildSheetXml(s.rows)),
    })),
  ];

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const dataBytes = f.data;
    const sumCrc = crc32(dataBytes);

    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0x0800, true);
    ldv.setUint16(8, 0, true);
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, 0x5421, true);
    ldv.setUint32(14, sumCrc, true);
    ldv.setUint32(18, dataBytes.length, true);
    ldv.setUint32(22, dataBytes.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x5421, true);
    cdv.setUint32(16, sumCrc, true);
    cdv.setUint32(20, dataBytes.length, true);
    cdv.setUint32(24, dataBytes.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);

    localParts.push(lh, dataBytes);
    centralParts.push(ch);
    offset += lh.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);

  const totalLen = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);
  return out;
}

export function sanitizeLabFilenameSlug(name) {
  const raw = String(name || 'lab-1')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || 'lab-1';
}

/**
 * Exam / Anonymous vessel security check: blocks quantitative .xlsx exports when
 * viewing a blind (?A/?B) vessel, blind-dosing assignment, or exam bench containing blind vessels.
 */
export function isQuantitativeExportBlocked(sim, item = null) {
  if (item?.hideComposition) return true;
  if (!sim) return false;
  const st = sim.missionState;
  if (st?.active && st.blindDosingMode) return true;
  const hasAnyBlind = (sim.items || []).some((it) => Boolean(it?.hideComposition));
  if (!item && hasAnyBlind) return true;
  if (st?.active && (st.examMode || st.mode === 'exam') && hasAnyBlind) return true;
  return false;
}

export function downloadXlsxWorkbook({ filename, sheets }) {
  const xlsxBytes = buildXlsxBytes(sheets, sheets?.[0]?.name || 'Sheet1');
  if (typeof document === 'undefined' || typeof Blob === 'undefined') {
    return { filename, bytes: xlsxBytes, sheets };
  }
  const blob = new Blob([xlsxBytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return { filename, bytes: xlsxBytes, sheets };
}

function getTranslateFn(t) {
  return typeof t === 'function' ? t : (k) => String(k ?? '');
}

export function extractLiquidSheetRows(item, tempKOrEnv = CONSTANTS.T_STD_K, t = null) {
  const tr = getTranslateFn(t);
  const argTemp = typeof tempKOrEnv === 'object' && tempKOrEnv !== null ? tempKOrEnv.tempK : tempKOrEnv;
  const T = Number(item?.tempK ?? argTemp ?? CONSTANTS.T_STD_K);
  const data = computeLiquidSpeciesTableData(item?.moles || {}, T);
  const totalMl = Number(data?.totalLiqMl ?? 0);
  const mixDensity = Number(data?.mixDensity ?? 0);
  const header = ['Species ID', 'Name', 'Formula', 'Moles (mol)', 'Mass (g)', 'Volume (mL)', 'Conc. (M) / % / State'];
  const rows = [
    [
      `${item?.label || item?.id || 'Container'} — Liquid & Solution`,
      `T = ${kelvinToCelsius(T).toFixed(2)} °C`,
      `Total V = ${totalMl.toFixed(3)} mL`,
      mixDensity > 0 ? `Density = ${mixDensity.toFixed(4)} g/mL` : '',
    ],
    header,
    ...(data?.rows || []).map((r) => {
      const id = r.spId || r.id || '';
      const sp = r.sp || SPECIES[id] || {};
      const stateTag =
        id === 'H2O_l'
          ? 'Solvent'
          : isSolidMoltenAtTemp(sp, T, item?.moles)
          ? tr('moltenStateTag')
          : r.cM > 0
          ? `${r.cM.toFixed(4)} M (${(r.cPct || 0).toFixed(2)}%)`
          : sp.phase || '';
      return [
        id,
        sp.name || id,
        sp.formula || id,
        Number((r.mol || 0).toFixed(6)),
        Number((r.massG || 0).toFixed(4)),
        r.volMl != null ? Number(r.volMl.toFixed(4)) : '',
        stateTag,
      ];
    }),
  ];
  return rows;
}

export function extractSolidSheetRows(item, tempKOrEnv = CONSTANTS.T_STD_K, t = null) {
  const tr = getTranslateFn(t);
  const argTemp = typeof tempKOrEnv === 'object' && tempKOrEnv !== null ? tempKOrEnv.tempK : tempKOrEnv;
  const T = Number(item?.tempK ?? argTemp ?? CONSTANTS.T_STD_K);
  const entries = Object.entries(item?.moles || {})
    .filter(([id, n]) => n > 1e-10 && (SPECIES[id]?.phase === 's' || item?.kind === 'spoon'))
    .sort((a, b) => b[1] - a[1]);

  const rows = [
    [`${item?.label || item?.id || 'Container'} — Solids & Precipitates`, `T = ${kelvinToCelsius(T).toFixed(2)} °C`],
    ['Species ID', 'Name', 'Formula', 'Moles (mol)', 'Mass (g)', 'Physical State', 'T_melt (°C)', 'T_boil (°C)', 'T_decomp (°C)'],
    ...entries.map(([id, n]) => {
      const sp = SPECIES[id] || {};
      const massG = n * (sp.molarMass || 0);
      const molten = isSolidMoltenAtTemp(sp, T, item?.moles);
      const st = molten ? tr('moltenStateTag') || 'Molten' : id === 'H2O_s' ? 'Ice (Solid)' : 'Solid / Precipitate';
      return [
        id,
        sp.name || id,
        sp.formula || id,
        Number(n.toFixed(6)),
        Number(massG.toFixed(4)),
        st,
        sp.meltTempK ? Number(kelvinToCelsius(sp.meltTempK).toFixed(1)) : '',
        sp.boilTempK ? Number(kelvinToCelsius(sp.boilTempK).toFixed(1)) : '',
        sp.decompTempK ? Number(kelvinToCelsius(sp.decompTempK).toFixed(1)) : '',
      ];
    }),
  ];
  return rows;
}

export function extractGasSheetRows(item, env = null) {
  const e = env || { tempK: CONSTANTS.T_STD_K, pressureBar: CONSTANTS.P_STD_BAR };
  const T = item?.tempK ?? e.tempK ?? CONSTANTS.T_STD_K;
  const pBar = item?.internalPressureBar ?? e.pressureBar ?? CONSTANTS.P_STD_BAR;
  const spec = APPARATUS[item?.typeId] || {};

  if (item?.kind === 'gas_syringe') {
    const gasEntries = Object.entries(item.gasMoles || {})
      .filter(([, n]) => n > 1e-9)
      .sort((a, b) => b[1] - a[1]);
    const totGas = gasEntries.reduce((s, [, n]) => s + n, 0);
    const gasVolMl = computeSyringeGasVolumeMl(item, e);
    const liqVolMl = computeSyringeLiquidVolumeMl(item, e);
    const frozenVolMl = computeSyringeFrozenVolumeMl(item, e);
    const totVolMl = computeSyringeTotalVolumeMl(item, e);
    return [
      [
        `${item.label || 'Syringe'} — Gas Syringe Breakdown`,
        `T = ${kelvinToCelsius(T).toFixed(2)} °C`,
        `P = ${pBar.toFixed(3)} bar`,
        `Total V = ${totVolMl.toFixed(2)} mL`,
      ],
      ['Component / Gas', 'Formula', 'Phase', 'Moles (mmol)', 'Volume PV=nRT (mL)', 'Share (%)', 'd/Air (M/28.97)'],
      ...gasEntries.map(([gId, n]) => {
        const sp = SPECIES[gId] || {};
        const vMl = totGas > 1e-12 ? gasVolMl * (n / totGas) : (n * CONSTANTS.R_BAR_L * T / Math.max(0.05, pBar)) * 1000;
        const pct = totGas > 1e-12 ? (n / totGas) * 100 : 0;
        const relAir = sp.molarMass ? sp.molarMass / 28.97 : '';
        return [
          gId,
          sp.formula || gId,
          'Headspace Gas',
          Number((n * 1000).toFixed(4)),
          Number(vMl.toFixed(3)),
          Number(pct.toFixed(2)),
          relAir === '' ? '' : Number(relAir.toFixed(3)),
        ];
      }),
      ['Condensed Water', 'H₂O(l)', 'Condensed Liquid', Number(((item.condensedWaterMol || 0) * 1000).toFixed(4)), Number(liqVolMl.toFixed(3)), '', ''],
      ['Condensed Ethanol', 'C₂H₅OH(l)', 'Condensed Liquid', Number(((item.condensedEtOHMol || 0) * 1000).toFixed(4)), '', '', ''],
      ['Frozen Ice / Gas Solid', 'Solid', 'Cryo Solid', Number(((item.frozenWaterMol || 0) * 1000).toFixed(4)), Number(frozenVolMl.toFixed(3)), '', ''],
    ];
  }

  const headEntries = Object.entries(item?.headspaceGasMoles || {})
    .filter(([g, n]) => n > 1e-9 && (g !== 'H2O_g' || spec.stopperable))
    .sort((a, b) => b[1] - a[1]);
  const escEntries = Object.entries(item?.escapedGasMoles || {})
    .filter(([, n]) => n > 1e-9)
    .sort((a, b) => b[1] - a[1]);
  const totHead = headEntries.reduce((s, [, n]) => s + n, 0);
  const totEsc = escEntries.reduce((s, [, n]) => s + n, 0);

  const mapRow = (location, gId, n, totGroup) => {
    const sp = SPECIES[gId] || {};
    const vMl = (n * CONSTANTS.R_BAR_L * T / Math.max(0.05, pBar)) * 1000;
    const pct = totGroup > 1e-12 ? (n / totGroup) * 100 : 0;
    const relAir = sp.molarMass ? sp.molarMass / 28.97 : '';
    const rateMmolS = location === 'Escaped' ? (item?.lastGasRates?.[gId] || 0) * 1000 : 0;
    return [
      location,
      gId,
      sp.formula || gId,
      Number((n * 1000).toFixed(4)),
      Number(vMl.toFixed(3)),
      Number(pct.toFixed(2)),
      relAir === '' ? '' : Number(relAir.toFixed(3)),
      Number(rateMmolS.toFixed(4)),
    ];
  };

  return [
    [`${item?.label || item?.id || 'Vessel'} — Headspace & Escaped Gases`, `T = ${kelvinToCelsius(T).toFixed(2)} °C`, `P = ${pBar.toFixed(3)} bar`],
    ['Location', 'Gas ID', 'Formula', 'Moles (mmol)', 'Volume PV=nRT (mL)', 'Share (%)', 'd/Air (M/28.97)', 'Evolution Rate (mmol/s)'],
    ...headEntries.map(([gId, n]) => mapRow('Headspace', gId, n, totHead)),
    ...escEntries.map(([gId, n]) => mapRow('Escaped', gId, n, totEsc)),
  ];
}

export function extractThermoElectroRxnRows(item, sim) {
  const e = sim?.environment || { tempK: CONSTANTS.T_STD_K, pressureBar: CONSTANTS.P_STD_BAR };
  const T = item?.tempK ?? e.tempK ?? CONSTANTS.T_STD_K;
  const pBar = item?.internalPressureBar ?? e.pressureBar ?? CONSTANTS.P_STD_BAR;
  const liqL = computeLiquidVolumeL(item?.moles || {}, T);
  const ph = item?.isFrozenSolid ? null : computePH(item?.moles || {}, liqL, T);
  const electro = computeVesselElectrochemicalMetrics(item || { moles: {}, tempK: T }, ph, liqL);
  const redox = item?.kind === 'vessel' && sim ? computeVesselRedoxAndCellMetrics(item, sim.items || [], liqL, ph) : { hasElectroLink: false, ehMv: null, ePinV: null };
  const vRate = liqL > 1e-5 ? (item?.lastTotalRateMolS || 0) / liqL : 0;

  const rows = [
    [`${item?.label || item?.id || 'Vessel'} — Thermodynamics, Electrochemistry & Kinetics`],
    ['Metric', 'Value', 'Unit'],
    ['Temperature (C)', Number(kelvinToCelsius(T).toFixed(2)), '°C'],
    ['Temperature (K)', Number(T.toFixed(2)), 'K'],
    ['Pressure', Number(pBar.toFixed(4)), 'bar'],
    ['Liquid Volume', Number((liqL * 1000).toFixed(3)), 'mL'],
    ['pH', ph === null ? 'N/A' : Number(ph.toFixed(3)), 'pH'],
    ['Ionic Strength (I)', Number(electro.ionicStrengthM.toFixed(4)), 'M'],
    ['Electrical Conductivity (σ)', Number(electro.conductivityMSCm.toFixed(3)), 'mS/cm'],
    ['Cumulative Reaction Heat (Q)', Number(((item?.cumulativeReactionHeatJ || 0) / 1000).toFixed(4)), 'kJ'],
    ['Reaction Rate (v)', Number(vRate.toFixed(5)), 'mol/(L·s)'],
    ['Conversion Yield (H)', item?.conversionYieldPct != null ? Number(item.conversionYieldPct.toFixed(2)) : 'N/A', '%'],
    ['Half-Cell Potential (Eh)', redox.ehMv != null ? Number(redox.ehMv.toFixed(2)) : 'N/A', 'mV'],
    ['Cell EMF (E_pin)', redox.ePinV != null ? Number(redox.ePinV.toFixed(4)) : 'N/A', 'V'],
    [],
    ['Active Reactions', 'Equation', 'Rate (mmol/s)'],
    ...((item?.activeReactions || []).map((r) => [r.id || r.nameEn || r.nameVi || 'rxn', r.equation || '', Number(((r.rateMolS || 0) * 1000).toFixed(4))])),
  ];
  return rows;
}

export function extractInstrumentSheetData(item, sim) {
  if (!item) return { sheetName: 'Instrument', rows: [['Empty']] };
  if (item.kind === 'ph_conductometer') {
    const hist = Array.isArray(item.history) ? item.history : [];
    const rows = [
      [`pH-Conductivity Probe ${item.label || ''}`, `Live pH: ${item.measuredPH != null ? item.measuredPH.toFixed(2) : 'N/A'}`, `Live σ: ${item.measuredConductivity != null ? item.measuredConductivity.toFixed(3) : 'N/A'} mS/cm`],
      ['t (s)', 'pH', 'Conductivity (mS/cm)', 'Temp (°C)'],
      ...hist.map((pt) => [
        Number((pt.t || 0).toFixed(2)),
        pt.ph != null ? Number(pt.ph.toFixed(3)) : '',
        pt.ec != null ? Number(pt.ec.toFixed(3)) : '',
        pt.tempC != null ? Number(pt.tempC.toFixed(2)) : '',
      ]),
    ];
    return { sheetName: 'pH_EC_History', rows };
  }
  if (item.kind === 'colorimeter') {
    const mode = item.spectroMode || 'uvvis_kinetics';
    const contactV = item.contactVesselId && sim ? sim.getItem(item.contactVesselId) : null;
    if (mode === 'uvvis_spectrum') {
      const uv = computeUvVisSpectrum(contactV);
      const pts = uv?.points || [];
      return {
        sheetName: 'UVVis_Spectrum',
        rows: [
          [`UV-Vis Spectrum ${item.label || ''}`, `Sample: ${contactV?.label || 'None'}`, `lambdaMax: ${uv?.lambdaMaxNm || 'N/A'} nm`, `Amax: ${(uv?.maxA || 0).toFixed(4)}`],
          ['Wavelength (nm)', 'Absorbance (A)', 'Transmittance (%T)'],
          ...pts.map((p) => [p.nm, Number(p.absorbance.toFixed(4)), Number((100 * Math.pow(10, -p.absorbance)).toFixed(2))]),
        ],
      };
    }
    if (mode === 'ir_spectrum') {
      const ir = computeIrSpectrum(contactV, { subtractWater: item.irSubtractWater !== false });
      const pts = ir?.points || [];
      return {
        sheetName: 'IR_Spectrum',
        rows: [
          [`ATR FT-IR ${item.label || ''}`, `Sample: ${contactV?.label || 'None'}`, `Subtract H2O: ${item.irSubtractWater !== false}`],
          ['Wavenumber (cm^-1)', 'Transmittance (%T)'],
          ...pts.map((p) => [p.cm, Number((p.transmittance ?? p.T ?? 100).toFixed(3))]),
        ],
      };
    }
    const hist = Array.isArray(item.history) ? item.history : [];
    return {
      sheetName: 'Kinetics_Abs',
      rows: [
        [`Beer-Lambert Kinetics ${item.label || ''}`, `Wavelength: ${item.wavelengthNm || 525} nm`],
        ['t (s)', 'Wavelength (nm)', 'Absorbance (A)', 'Transmittance (%T)'],
        ...hist.map((pt) => [
          Number((pt.t || 0).toFixed(2)),
          pt.wl || item.wavelengthNm || 525,
          Number((pt.abs || 0).toFixed(4)),
          Number((100 * Math.pow(10, -(pt.abs || 0))).toFixed(2)),
        ]),
      ],
    };
  }
  if (item.kind === 'tlc_plate') {
    const spots = Array.isArray(item.spots) ? item.spots : [];
    return {
      sheetName: 'TLC_Chromatography',
      rows: [
        [`TLC Plate ${item.label || ''}`, `Solvent: ${item.eluentName || 'Hexane/EtOAc'}`, `Solvent Front: ${((item.solventFront || 0) * 100).toFixed(1)}%`],
        ['Species ID', 'Formula', 'Rf', 'UV-254 Active', 'Spot Color'],
        ...spots.map((sp) => [
          sp.id || '',
          sp.formula || SPECIES[sp.id]?.formula || sp.id || '',
          Number((sp.rf || 0).toFixed(3)),
          Boolean(sp.uvActive || SPECIES[sp.id]?.uvActive),
          sp.color || '',
        ]),
      ],
    };
  }
  if (item.kind === 'electrophoresis') {
    const lanes = Array.isArray(item.lanes) ? item.lanes : [];
    const ph = Number(item.bufferPH ?? 6.0);
    const polLabel = item.polarityReversed ? 'Left (-) Cathode | Right (+) Anode' : 'Left (+) Anode | Right (-) Cathode';
    return {
      sheetName: 'Electrophoresis',
      rows: [
        [`Electrophoresis Cell ${item.label || ''}`, `pH ${ph.toFixed(2)}`, `${item.powerOn ? `${Number(item.voltageV || 0).toFixed(1)} V ON` : 'OFF'}`, polLabel, `Ninhydrin: ${item.ninhydrinDeveloped ? 'YES' : 'NO'}`],
        ['Sample', 'Formula', 'pI', 'q_eff(pH)', 'Migration Target', 'Distance d (mm)'],
        ...lanes.map((ln) => {
          const q = Number(ln.qEff ?? 0);
          const dir = Math.abs(q) < 0.08 ? 'Stationary (pI)' : q < 0 ? 'Anode (+)' : 'Cathode (-)';
          return [
            ln.name || ln.shortLabel || ln.id,
            ln.formula || '',
            ln.pI != null ? Number(Number(ln.pI).toFixed(2)) : '',
            Number(q.toFixed(3)),
            dir,
            Number((ln.posMm || 0).toFixed(2)),
          ];
        }),
      ],
    };
  }
  if (item.kind === 'scale') {
    const netG = Number(item.measuredG ?? item.measuredMassG ?? 0);
    const tareG = Number(item.tareG ?? 0);
    return {
      sheetName: 'Scale_Balance',
      rows: [
        [`Analytical Balance ${item.label || ''}`],
        ['Reading', 'Value (g)'],
        ['Net Mass (Displayed)', Number(netG.toFixed(4))],
        ['Tare Offset', Number(tareG.toFixed(4))],
        ['Gross Load', Number((netG + tareG).toFixed(4))],
      ],
    };
  }
  return {
    sheetName: item.kind || 'Apparatus',
    rows: [
      [`Apparatus ${item.label || item.id}`],
      ['Property', 'Value'],
      ['Type ID', item.typeId],
      ['Kind', item.kind],
      ['Temp (C)', item.tempK != null ? Number(kelvinToCelsius(item.tempK).toFixed(2)) : 'N/A'],
    ],
  };
}

export function buildItemMultiSheetWorkbook(item, sim, t = null, labName = 'Lab 1') {
  const tr = getTranslateFn(t);
  const env = sim?.environment || { tempK: CONSTANTS.T_STD_K, pressureBar: CONSTANTS.P_STD_BAR };
  const T = item?.tempK ?? env.tempK ?? CONSTANTS.T_STD_K;
  const spec = APPARATUS[item?.typeId] || {};
  const sheets = [];

  sheets.push({
    name: 'Overview',
    rows: [
      ['ChemLab Studio — Multi-Sheet Item Workbook', labName],
      ['Label', item?.label || item?.id || ''],
      ['Apparatus', spec.i18nKey ? tr(spec.i18nKey) : item?.typeId || ''],
      ['Kind', item?.kind || ''],
      ['Temperature (°C)', Number(kelvinToCelsius(T).toFixed(2))],
      ['Pressure (bar)', Number((item?.internalPressureBar ?? env.pressureBar ?? CONSTANTS.P_STD_BAR).toFixed(4))],
      ['Sticky Note', item?.stickyLabel?.text || ''],
    ],
  });

  if (item?.kind === 'vessel' || item?.kind === 'pipette' || item?.kind === 'burette' || item?.kind === 'separatory_funnel') {
    sheets.push({ name: 'Liquid', rows: extractLiquidSheetRows(item, T, tr) });
  }
  if (item?.kind === 'vessel' || item?.kind === 'spoon') {
    sheets.push({ name: 'Solid', rows: extractSolidSheetRows(item, T, tr) });
  }
  if (item?.kind === 'vessel' || item?.kind === 'gas_syringe') {
    sheets.push({ name: 'Gas', rows: extractGasSheetRows(item, env) });
  }
  if (item?.kind === 'vessel') {
    sheets.push({ name: 'Thermo_Electro_Rxns', rows: extractThermoElectroRxnRows(item, sim) });
  }
  if (['ph_conductometer', 'colorimeter', 'tlc_plate', 'scale'].includes(item?.kind)) {
    const inst = extractInstrumentSheetData(item, sim);
    sheets.push({ name: inst.sheetName, rows: inst.rows });
  }
  return sheets;
}

export function buildBenchMultiSheetWorkbook(sim, t = null, labName = 'Lab 1') {
  const tr = getTranslateFn(t);
  const env = sim?.environment || { tempK: CONSTANTS.T_STD_K, pressureBar: CONSTANTS.P_STD_BAR };
  const items = Array.isArray(sim?.items) ? sim.items : [];

  const overviewRows = [
    [`ChemLab Studio — Bench Workbook (${labName})`, `Env T = ${kelvinToCelsius(env.tempK ?? CONSTANTS.T_STD_K).toFixed(1)} °C`, `Env P = ${(env.pressureBar ?? CONSTANTS.P_STD_BAR).toFixed(3)} bar`, `Atmosphere: ${env.atmosphereMode || 'air'}`],
    ['Item Label', 'Type', 'Kind', 'Temp (°C)', 'Pressure (bar)', 'Liquid V (mL)', 'Total Chem Mass (g)', 'pH', 'Sticky Label'],
  ];
  const liquidRows = [['Item', 'Species ID', 'Formula', 'Moles (mol)', 'Mass (g)', 'Volume (mL)', 'Conc / State']];
  const solidRows = [['Item', 'Species ID', 'Formula', 'Moles (mol)', 'Mass (g)', 'State']];
  const gasRows = [['Item', 'Location', 'Gas ID', 'Formula', 'Moles (mmol)', 'Volume PV=nRT (mL)', 'Rate (mmol/s)']];
  const rxnRows = [['Item', 'Reaction ID', 'Equation', 'Rate (mmol/s)']];
  const instRows = [['Item', 'Instrument Kind', 'Summary Metric', 'Value']];

  for (const it of items) {
    const spec = APPARATUS[it.typeId] || {};
    const T = it.tempK ?? env.tempK ?? CONSTANTS.T_STD_K;
    const pBar = it.internalPressureBar ?? env.pressureBar ?? CONSTANTS.P_STD_BAR;
    const liqL = it.moles ? computeLiquidVolumeL(it.moles, T) : 0;
    const massG = it.moles ? computeContentsMassG(it.moles) : 0;
    const ph = it.kind === 'vessel' && !it.isFrozenSolid ? computePH(it.moles || {}, liqL, T) : null;
    overviewRows.push([
      it.label || it.id,
      spec.i18nKey ? tr(spec.i18nKey) : it.typeId,
      it.kind,
      Number(kelvinToCelsius(T).toFixed(2)),
      Number(pBar.toFixed(4)),
      Number((liqL * 1000).toFixed(3)),
      Number(massG.toFixed(4)),
      ph === null ? 'N/A' : Number(ph.toFixed(2)),
      it.stickyLabel?.text || '',
    ]);

    if (it.kind === 'vessel' || it.kind === 'pipette' || it.kind === 'burette' || it.kind === 'separatory_funnel') {
      const liqData = computeLiquidSpeciesTableData(it.moles || {}, T);
      for (const r of liqData.rows) {
        const spId = r.spId || r.id || '';
        const sp = r.sp || SPECIES[spId] || {};
        liquidRows.push([
          it.label || it.id,
          spId,
          sp.formula || spId,
          Number((r.mol || 0).toFixed(6)),
          Number((r.massG || 0).toFixed(4)),
          r.volMl != null ? Number(r.volMl.toFixed(4)) : '',
          r.cM > 0 ? `${r.cM.toFixed(3)} M` : spId === 'H2O_l' ? 'Solvent' : '',
        ]);
      }
    }
    if (it.kind === 'vessel' || it.kind === 'spoon') {
      for (const [id, n] of Object.entries(it.moles || {})) {
        if (n > 1e-10 && (SPECIES[id]?.phase === 's' || it.kind === 'spoon')) {
          const sp = SPECIES[id] || {};
          solidRows.push([it.label || it.id, id, sp.formula || id, Number(n.toFixed(6)), Number((n * (sp.molarMass || 0)).toFixed(4)), isSolidMoltenAtTemp(sp, T, it.moles) ? 'Molten' : 'Solid']);
        }
      }
    }
    if (it.kind === 'vessel' || it.kind === 'gas_syringe') {
      const gasPairs = [
        ...Object.entries(it.headspaceGasMoles || {}).filter(([g, n]) => g !== 'H2O_g' && n > 1e-9).map(([g, n]) => ['Headspace', g, n]),
        ...Object.entries(it.escapedGasMoles || {}).filter(([, n]) => n > 1e-9).map(([g, n]) => ['Escaped', g, n]),
        ...Object.entries(it.gasMoles || {}).filter(([, n]) => n > 1e-9).map(([g, n]) => ['Syringe', g, n]),
      ];
      for (const [loc, gId, n] of gasPairs) {
        const sp = SPECIES[gId] || {};
        const vMl = (n * CONSTANTS.R_BAR_L * T / Math.max(0.05, pBar)) * 1000;
        const rateMmol = loc === 'Escaped' ? (it.lastGasRates?.[gId] || 0) * 1000 : 0;
        gasRows.push([it.label || it.id, loc, gId, sp.formula || gId, Number((n * 1000).toFixed(4)), Number(vMl.toFixed(3)), Number(rateMmol.toFixed(4))]);
      }
    }
    if (it.kind === 'vessel') {
      for (const rxn of it.activeReactions || []) {
        rxnRows.push([it.label || it.id, rxn.id || rxn.nameEn || '', rxn.equation || '', Number(((rxn.rateMolS || 0) * 1000).toFixed(4))]);
      }
    }
    if (it.kind === 'ph_conductometer') {
      instRows.push([it.label || it.id, 'pH/EC', 'pH / sigma (mS/cm)', `${it.measuredPH != null ? it.measuredPH.toFixed(2) : 'N/A'} | ${it.measuredConductivity != null ? it.measuredConductivity.toFixed(2) : 'N/A'}`]);
    } else if (it.kind === 'colorimeter') {
      instRows.push([it.label || it.id, `Spectrometer (${it.spectroMode || 'uvvis_kinetics'})`, `wl=${it.wavelengthNm || 525}nm`, `A=${(it.measuredAbsorbance ?? 0).toFixed(3)}`]);
    } else if (it.kind === 'tlc_plate') {
      instRows.push([it.label || it.id, 'TLC Plate', `Front=${((it.solventFront || 0) * 100).toFixed(0)}%`, `${(it.spots || []).length} spots`]);
    } else if (it.kind === 'electrophoresis') {
      instRows.push([it.label || it.id, 'Electrophoresis', `pH=${Number(it.bufferPH ?? 6.0).toFixed(2)} | ${it.powerOn ? `${Number(it.voltageV || 0).toFixed(0)}V` : 'OFF'}`, `${(it.lanes || []).length} lanes`]);
    } else if (it.kind === 'scale') {
      instRows.push([it.label || it.id, 'Scale', 'Net Mass (g)', Number((it.measuredG ?? it.measuredMassG ?? 0).toFixed(4))]);
    }
  }

  return [
    { name: 'Bench_Overview', rows: overviewRows },
    { name: 'Liquids_All', rows: liquidRows },
    { name: 'Solids_All', rows: solidRows },
    { name: 'Gases_All', rows: gasRows },
    { name: 'Reactions_All', rows: rxnRows },
    { name: 'Instruments_All', rows: instRows },
  ];
}

export function downloadCompositionXlsx({ labName, vesselLabel, tempK, ph, pressureBar, rowsData }) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${sanitizeLabFilenameSlug(labName)}-composition-${dateStr}.xlsx`;
  const sheetRows = [
    ['ChemLab Studio — Composition Export', vesselLabel || '', `Lab: ${labName || ''}`, `Date: ${dateStr}`],
    [
      'Temperature (K)',
      Number((tempK || 298.15).toFixed(2)),
      'pH',
      ph === null || ph === undefined ? 'N/A' : Number(ph.toFixed(2)),
      'Pressure (bar)',
      Number((pressureBar || 1.01325).toFixed(3)),
    ],
    [],
    ['Species ID', 'Formula', 'Phase / State', 'Moles (mol)', 'Mass (g)', 'Concentration / State Tag'],
    ...(rowsData || []).map((r) => [r.id, r.formula, r.phase, Number((r.mol || 0).toFixed(6)), Number((r.massG || 0).toFixed(4)), r.concLabel]),
  ];

  return downloadXlsxWorkbook({
    filename,
    sheets: [{ name: 'Composition', rows: sheetRows }],
  });
}
