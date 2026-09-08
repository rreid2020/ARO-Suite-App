/**
 * Turning a staged extract into register rows.
 *
 * The import is deliberately two-step: read the file, show what was found and
 * which column each field was mapped to, and only write to the register once
 * somebody has looked. `readSheet` guesses the sheet, the header row and the
 * column mapping; every one of those guesses is a place a silent import would
 * put the wrong number in front of an auditor.
 *
 * Pure. `readSheet` does the I/O; everything here is a function of the staged
 * sheet and the mapping.
 */

import { RecalcCurvePoint, normaliseCurveRates } from '../engine/recalc';
import { ReadSheet, cellToIso } from '../xlsx/read';
import { Rep04Line, Rep06Line } from './recalc';
import { parseNumber } from './format';

export interface StagedExtract {
  kind: 'rep04' | 'rep06' | 'curve';
  file: string;
  sheet: ReadSheet;
  /** Field → column index. -1 means unmapped. */
  map: Record<string, number>;
  /** Curve only: which "valid on" vintage to take. */
  vintage?: string;
}

/** The raw text of a mapped cell, or '' when the field is unmapped. */
function cell(row: string[], map: Record<string, number>, key: string): string {
  const i = map[key];
  if (i === undefined || i < 0) return '';
  const v = row[i];
  return v == null ? '' : String(v).trim();
}

/* ══ Curve vintages ════════════════════════════════════════════════════ */

export interface Vintage {
  value: string;
  rows: number;
}

/**
 * The distinct "valid on" values in a staged curve file, most rows first.
 *
 * A client curve export usually carries every vintage the system holds, not
 * just the one wanted — often a decade of month ends in one sheet. Picking a
 * vintage is therefore part of the import, not a detail of it.
 */
export function vintagesOf(stage: StagedExtract): Vintage[] {
  const i = stage.map.validOn;
  if (i === undefined || i < 0) return [];
  const counts: Record<string, number> = {};
  for (const row of stage.sheet.rows) {
    const v = String(row[i] == null ? '' : row[i]).trim();
    if (v) counts[v] = (counts[v] || 0) + 1;
  }
  return Object.keys(counts)
    .map((value) => ({ value, rows: counts[value] }))
    .sort((a, b) => b.rows - a.rows || (a.value < b.value ? 1 : -1));
}

/**
 * The vintage to offer first: the one matching the FY year end, however the
 * file spells the date — ISO, dotted European, US slashes, or a bare Excel
 * serial. Falls back to the vintage with the most rows, which is nearly always
 * the full published curve rather than a stub.
 */
export function pickVintage(stage: StagedExtract, fyEnd: string): string {
  const list = vintagesOf(stage);
  if (!list.length) return '';
  const [y, m, d] = fyEnd.split('-');
  const wanted = [fyEnd, `${d}.${m}.${y}`, `${m}/${d}/${y}`];
  const serial = String(Math.round((Date.parse(`${fyEnd}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 864e5));
  const hit = list.find((v) => wanted.indexOf(v.value) >= 0 || v.value === serial);
  return hit ? hit.value : list[0].value;
}

/**
 * The curve points for one vintage: whole-year terms, rates as decimals,
 * sorted, de-duplicated, and with junk rows dropped.
 *
 * Terms outside 1-100 years and rows with no rate are discarded rather than
 * imported — a published curve file carries subtotal and note rows that would
 * otherwise land in the table as term 0.
 */
export function curveFromStage(stage: StagedExtract, vintage?: string): RecalcCurvePoint[] {
  const map = stage.map;
  const rows: RecalcCurvePoint[] = [];

  for (const row of stage.sheet.rows) {
    if (map.validOn >= 0 && vintage && cell(row, map, 'validOn') !== vintage) continue;
    const term = Math.round(parseNumber(cell(row, map, 'term')));
    const rate = parseNumber(cell(row, map, 'rate'));
    if (!Number.isFinite(term) || term < 1 || term > 100 || !Number.isFinite(rate) || !rate) continue;
    rows.push({ term, rate });
  }

  rows.sort((a, b) => a.term - b.term);
  const seen: Record<number, true> = {};
  const out: RecalcCurvePoint[] = [];
  for (const p of rows) {
    if (seen[p.term]) continue;
    seen[p.term] = true;
    out.push(p);
  }
  return normaliseCurveRates(out);
}

/* ══ REP04 / REP06 ═════════════════════════════════════════════════════ */

/**
 * REP04 lines out of a staged sheet.
 *
 * Nothing is filtered here — a row with no id or an unreadable cost is passed
 * through as it was read, and `mergeRep04` counts what it could not use. Two
 * places deciding what "usable" means is one place too many.
 */
export function rep04Lines(stage: StagedExtract): Rep04Line[] {
  return stage.sheet.rows.map((row) => {
    const cost = cell(row, stage.map, 'cost');
    return {
      id: cell(row, stage.map, 'id'),
      cost: cost === '' ? NaN : parseNumber(cost),
      costEstimateDate: cellToIso(cell(row, stage.map, 'costEstimateDate')),
    };
  });
}

export function rep06Lines(stage: StagedExtract): Rep06Line[] {
  return stage.sheet.rows.map((row) => {
    const fv = cell(row, stage.map, 'fv');
    const pv = cell(row, stage.map, 'pv');
    return {
      id: cell(row, stage.map, 'id'),
      settlementDate: cellToIso(cell(row, stage.map, 'settlementDate')),
      fv: fv === '' ? null : parseNumber(fv),
      pv: pv === '' ? null : parseNumber(pv),
    };
  });
}

/* ══ Preview ═══════════════════════════════════════════════════════════ */

export interface PreviewCell {
  shown: string;
  /** The raw text, when the preview interpreted it into something else. */
  raw: string;
}

/** The fields shown in each extract's mapping preview, in column order. */
export const PREVIEW_FIELDS: Record<StagedExtract['kind'], { key: string; label: string }[]> = {
  rep04: [
    { key: 'id', label: 'ARO obligation no.' },
    { key: 'cost', label: 'Cost estimate' },
    { key: 'costEstimateDate', label: 'Cost estimate date' },
  ],
  rep06: [
    { key: 'id', label: 'ARO obligation no.' },
    { key: 'settlementDate', label: 'Settlement date' },
    { key: 'fv', label: 'FV of obligation' },
    { key: 'pv', label: 'PV of obligation' },
  ],
  curve: [
    { key: 'validOn', label: 'Valid on (vintage)' },
    { key: 'term', label: 'Term in years' },
    { key: 'rate', label: 'Interest rate' },
  ],
};

const DATE_FIELDS = new Set(['costEstimateDate', 'settlementDate']);

/**
 * The first few rows as the mapping would read them.
 *
 * Dates are shown **interpreted**, with the raw value alongside when it
 * differed. Auto-detect is most likely to get a date column wrong, and an Excel
 * serial like 46112 tells a reviewer nothing — seeing "2026-03-31" next to it
 * is what makes a mis-mapped column obvious before it is imported.
 */
export function previewRows(stage: StagedExtract, limit = 5): PreviewCell[][] {
  if (stage.kind === 'curve') {
    return curveFromStage(stage, stage.vintage)
      .slice(0, limit)
      .map((p) => [
        { shown: stage.vintage || '—', raw: '' },
        { shown: String(p.term), raw: '' },
        { shown: `${(p.rate * 100).toFixed(5)}%`, raw: '' },
      ]);
  }

  return stage.sheet.rows.slice(0, limit).map((row) =>
    PREVIEW_FIELDS[stage.kind].map(({ key }) => {
      const i = stage.map[key];
      if (i === undefined || i < 0) return { shown: '—', raw: '' };
      const raw = String(row[i] == null ? '' : row[i]).trim();
      if (DATE_FIELDS.has(key)) {
        const iso = cellToIso(raw);
        return { shown: iso || '⚠ not a date', raw: iso && iso !== raw ? raw : '' };
      }
      return { shown: raw || '—', raw: '' };
    }),
  );
}
