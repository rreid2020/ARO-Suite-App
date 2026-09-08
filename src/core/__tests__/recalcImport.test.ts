/**
 * Staging an extract: vintages, the curve table, and the lines the merges read.
 */

import { describe, expect, it } from 'vitest';
import {
  StagedExtract,
  curveFromStage,
  pickVintage,
  previewRows,
  rep04Lines,
  rep06Lines,
  vintagesOf,
} from '../recalcImport';
import { ReadSheet } from '../../xlsx/read';

function sheet(headers: string[], rows: string[][]): ReadSheet {
  return {
    sheetName: 'Sheet1',
    headers: headers.map((label, index) => ({ index, label })),
    headerRow: 0,
    rows,
  };
}

const curveStage = (rows: string[][]): StagedExtract => ({
  kind: 'curve',
  file: 'curve.xlsx',
  sheet: sheet(['Valid on', 'Term', 'Interest rate'], rows),
  map: { validOn: 0, term: 1, rate: 2 },
});

describe('curve vintages', () => {
  const stage = curveStage([
    ['31.03.2026', '1', '2.34'],
    ['31.03.2026', '2', '2.51'],
    ['31.03.2026', '3', '2.63'],
    ['31.03.2025', '1', '1.90'],
  ]);

  it('lists the distinct vintages, most rows first', () => {
    expect(vintagesOf(stage)).toEqual([
      { value: '31.03.2026', rows: 3 },
      { value: '31.03.2025', rows: 1 },
    ]);
  });

  it('offers the vintage matching the year end, however the file spells it', () => {
    expect(pickVintage(stage, '2026-03-31')).toBe('31.03.2026');
    expect(pickVintage(stage, '2025-03-31')).toBe('31.03.2025');
  });

  it('recognises an ISO or a US-slashed vintage too', () => {
    expect(pickVintage(curveStage([['2026-03-31', '1', '2.34']]), '2026-03-31')).toBe('2026-03-31');
    expect(pickVintage(curveStage([['03/31/2026', '1', '2.34']]), '2026-03-31')).toBe('03/31/2026');
  });

  it('recognises a bare Excel serial', () => {
    expect(pickVintage(curveStage([['46112', '1', '2.34']]), '2026-03-31')).toBe('46112');
  });

  it('falls back to the fullest table when no vintage matches the year end', () => {
    expect(pickVintage(stage, '2030-06-30')).toBe('31.03.2026');
  });

  it('has no vintages to offer when the column is unmapped', () => {
    expect(vintagesOf({ ...stage, map: { ...stage.map, validOn: -1 } })).toEqual([]);
    expect(pickVintage({ ...stage, map: { ...stage.map, validOn: -1 } }, '2026-03-31')).toBe('');
  });
});

describe('building the curve table', () => {
  it('takes only the chosen vintage, and converts percent to decimals', () => {
    const points = curveFromStage(
      curveStage([
        ['31.03.2026', '1', '2.34'],
        ['31.03.2026', '2', '2.51'],
        ['31.03.2025', '1', '1.90'],
      ]),
      '31.03.2026',
    );
    expect(points.map((p) => p.term)).toEqual([1, 2]);
    expect(points[0].rate).toBeCloseTo(0.0234, 12);
    expect(points[1].rate).toBeCloseTo(0.0251, 12);
  });

  it('leaves a table already quoted in decimals alone', () => {
    const points = curveFromStage(
      curveStage([['31.03.2026', '1', '0.0234'], ['31.03.2026', '2', '0.0251']]),
      '31.03.2026',
    );
    expect(points[0].rate).toBeCloseTo(0.0234, 12);
  });

  it('sorts by term and keeps the first of a duplicate pair', () => {
    const points = curveFromStage(
      curveStage([
        ['31.03.2026', '3', '2.63'],
        ['31.03.2026', '1', '2.34'],
        ['31.03.2026', '1', '9.99'],
      ]),
      '31.03.2026',
    );
    expect(points.map((p) => p.term)).toEqual([1, 3]);
    expect(points[0].rate).toBeCloseTo(0.0234, 12);
  });

  it('drops the subtotal and note rows a published curve file carries', () => {
    const points = curveFromStage(
      curveStage([
        ['31.03.2026', 'Total', '2.34'],
        ['31.03.2026', '0', '2.34'],
        ['31.03.2026', '250', '2.34'],
        ['31.03.2026', '5', ''],
        ['31.03.2026', '5', '2.844'],
      ]),
      '31.03.2026',
    );
    expect(points.map((p) => p.term)).toEqual([5]);
    expect(points[0].rate).toBeCloseTo(0.02844, 12);
  });

  it('takes every row when the file holds one vintage and no column for it', () => {
    const stage: StagedExtract = {
      kind: 'curve',
      file: 'c.xlsx',
      sheet: sheet(['Term', 'Rate'], [['1', '2.34'], ['2', '2.51']]),
      map: { validOn: -1, term: 0, rate: 1 },
    };
    expect(curveFromStage(stage, '')).toHaveLength(2);
  });
});

describe('extract lines', () => {
  const rep04: StagedExtract = {
    kind: 'rep04',
    file: 'REP04.xlsx',
    sheet: sheet(
      ['Obligation no.', 'Cost estimate', 'Cost estimate date'],
      [
        ['1104279', '19,546,595.86', '46112'],
        ['1104240', '$20,004,539.42', '1994-02-24'],
        ['', '', ''],
      ],
    ),
    map: { id: 0, cost: 1, costEstimateDate: 2 },
  };

  it('strips the formatting a source system exports money with', () => {
    expect(rep04Lines(rep04)[0].cost).toBeCloseTo(19546595.86, 6);
    expect(rep04Lines(rep04)[1].cost).toBeCloseTo(20004539.42, 6);
  });

  it('interprets Excel serials and passes ISO dates through', () => {
    expect(rep04Lines(rep04)[0].costEstimateDate).toBe('2026-03-31');
    expect(rep04Lines(rep04)[1].costEstimateDate).toBe('1994-02-24');
  });

  it('passes an unusable row through for the merge to count, rather than filtering here', () => {
    const lines = rep04Lines(rep04);
    expect(lines).toHaveLength(3);
    expect(lines[2].id).toBe('');
    expect(Number.isNaN(lines[2].cost)).toBe(true);
  });

  it('reads REP06 figures, and tells a blank apart from a nil', () => {
    const rep06: StagedExtract = {
      kind: 'rep06',
      file: 'REP06.xlsx',
      sheet: sheet(
        ['Obligation', 'Settlement date', 'FV', 'PV'],
        [['1104279', '2037-01-31', '46,815,157.32', '32,685,377.12'], ['1104240', '2038-03-31', '', '0']],
      ),
      map: { id: 0, settlementDate: 1, fv: 2, pv: 3 },
    };
    const lines = rep06Lines(rep06);
    expect(lines[0]).toEqual({
      id: '1104279',
      settlementDate: '2037-01-31',
      fv: 46815157.32,
      pv: 32685377.12,
    });
    expect(lines[1].fv).toBeNull();
    expect(lines[1].pv).toBe(0);
  });

  it('reads an unmapped field as empty rather than reaching for column -1', () => {
    const lines = rep04Lines({ ...rep04, map: { id: 0, cost: 1, costEstimateDate: -1 } });
    expect(lines[0].costEstimateDate).toBe('');
  });
});

describe('the mapping preview', () => {
  const rep04: StagedExtract = {
    kind: 'rep04',
    file: 'REP04.xlsx',
    sheet: sheet(
      ['Obligation no.', 'Cost estimate', 'Cost estimate date'],
      [['1104279', '19546595.86', '46112'], ['1104240', '20004539.42', 'not a date']],
    ),
    map: { id: 0, cost: 1, costEstimateDate: 2 },
  };

  it('shows a date interpreted, with the raw serial alongside', () => {
    const [first] = previewRows(rep04);
    expect(first[2]).toEqual({ shown: '2026-03-31', raw: '46112' });
  });

  it('marks a column that does not hold dates', () => {
    expect(previewRows(rep04)[1][2].shown).toBe('⚠ not a date');
  });

  it('does not repeat the raw value when it was already ISO', () => {
    const iso = { ...rep04, sheet: sheet(rep04.sheet.headers.map((h) => h.label), [['A', '1', '2026-03-31']]) };
    expect(previewRows(iso)[0][2]).toEqual({ shown: '2026-03-31', raw: '' });
  });

  it('shows an unmapped field as a dash', () => {
    const unmapped = { ...rep04, map: { ...rep04.map, cost: -1 } };
    expect(previewRows(unmapped)[0][1].shown).toBe('—');
  });

  it('previews a curve as the table it would import, not as raw rows', () => {
    const rows = previewRows({ ...curveStage([['31.03.2026', '1', '2.34']]), vintage: '31.03.2026' });
    expect(rows[0].map((c) => c.shown)).toEqual(['31.03.2026', '1', '2.34000%']);
  });

  it('stops at the row limit', () => {
    const many = {
      ...rep04,
      sheet: sheet(
        rep04.sheet.headers.map((h) => h.label),
        Array.from({ length: 20 }, (_, i) => [`A${i}`, '1', '2026-03-31']),
      ),
    };
    expect(previewRows(many)).toHaveLength(5);
    expect(previewRows(many, 2)).toHaveLength(2);
  });
});
