/**
 * The .xlsx reader.
 *
 * Every fixture here is a real workbook, built with `write.ts` and read back
 * through the zip and the sheet XML. A hand-written XML string would test the
 * regexes and nothing else; a round trip tests the format.
 */

import { describe, expect, it } from 'vitest';
import { COLUMN_HINTS, autoMap, cellToIso, findColumn, readSheet, serialToIso } from '../read';
import { Cell, Sheet, build } from '../write';

async function bytesOf(sheets: Sheet[]): Promise<Uint8Array> {
  return new Uint8Array(await build(sheets).arrayBuffer());
}

/** An extract shaped the way SAP exports one: title, blank line, then the grid. */
const REP04: Sheet = {
  name: 'REP04',
  rows: [
    ['ARO cost estimates — run 2026-04-02'],
    [],
    ['ARO obligation no.', 'Cost estimate', 'Cost estimate date', 'Cost centre'],
    ['1104279', 19546595.86, { v: '1992-12-23', t: 'd' }, 'CC-100'],
    ['1104240', 20004539.42, { v: '1994-02-24', t: 'd' }, 'CC-100'],
  ] as Cell[][],
};

describe('reading a workbook', () => {
  it('finds the header row below the title and the blank line', async () => {
    const sheet = await readSheet(await bytesOf([REP04]));
    expect(sheet.headerRow).toBe(2);
    expect(sheet.headers.map((h) => h.label)).toEqual([
      'ARO obligation no.',
      'Cost estimate',
      'Cost estimate date',
      'Cost centre',
    ]);
  });

  it('returns the data rows only, aligned to the headers by position', async () => {
    const sheet = await readSheet(await bytesOf([REP04]));
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0][0]).toBe('1104279');
    expect(sheet.rows[0][1]).toBe('19546595.86');
    expect(sheet.rows[0][3]).toBe('CC-100');
  });

  it('names the sheet it read', async () => {
    expect((await readSheet(await bytesOf([REP04]))).sheetName).toBe('REP04');
  });

  it('takes the sheet with the most rows, not the first one', async () => {
    // SAP leads with a parameter tab. Reading sheet 1 would import the run
    // parameters as if they were obligations.
    const cover: Sheet = {
      name: 'Selection',
      rows: [['Report', 'REP04'], ['Run by', 'M. Okafor'], ['Date', '2026-04-02']] as Cell[][],
    };
    const sheet = await readSheet(await bytesOf([cover, REP04]));
    expect(sheet.sheetName).toBe('REP04');
    expect(sheet.rows).toHaveLength(2);
  });

  it('fills the gaps left by empty cells rather than leaving holes', async () => {
    const sparse: Sheet = {
      name: 'S',
      rows: [
        ['Obligation', 'Cost', 'Date'],
        ['A1', null, { v: '2026-03-31', t: 'd' }],
      ] as Cell[][],
    };
    const sheet = await readSheet(await bytesOf([sparse]));
    expect(sheet.rows[0][1]).toBe('');
    expect(sheet.rows[0]).toHaveLength(3);
  });

  it('drops rows that are entirely empty', async () => {
    const gappy: Sheet = {
      name: 'S',
      rows: [['Obligation', 'Cost', 'Date'], ['A1', 1, 'x'], [], ['A2', 2, 'y']] as Cell[][],
    };
    expect((await readSheet(await bytesOf([gappy]))).rows).toHaveLength(2);
  });

  it('unescapes XML entities in labels and values', async () => {
    const odd: Sheet = {
      name: 'S',
      rows: [['Cost & fees', 'A<B', 'Third'], ['x & y', '<tag>', 'z']] as Cell[][],
    };
    const sheet = await readSheet(await bytesOf([odd]));
    expect(sheet.headers[0].label).toBe('Cost & fees');
    expect(sheet.rows[0][0]).toBe('x & y');
    expect(sheet.rows[0][1]).toBe('<tag>');
  });

  it('names an unlabelled column rather than leaving it blank', async () => {
    const unlabelled: Sheet = {
      name: 'S',
      rows: [['One', 'Two', 'Three', null, 'Five'], ['a', 'b', 'c', 'd', 'e']] as Cell[][],
    };
    const sheet = await readSheet(await bytesOf([unlabelled]));
    expect(sheet.headers[3].label).toBe('(column 4)');
  });

  it('stops at maxRows', async () => {
    const many: Sheet = {
      name: 'S',
      rows: [['A', 'B', 'C'], ...Array.from({ length: 50 }, (_, i) => [`r${i}`, i, 'x'])] as Cell[][],
    };
    const sheet = await readSheet(await bytesOf([many]), { maxRows: 10 });
    expect(sheet.rows.length).toBeLessThanOrEqual(9);
  });

  it('refuses something that is not a zip', async () => {
    await expect(readSheet(new TextEncoder().encode('this is a csv, not a workbook'))).rejects.toThrow(
      /not a zip file/i,
    );
  });
});

describe('Excel date serials', () => {
  it('reads a serial as the date Excel shows', () => {
    // Excel's own value for 2026-03-31.
    expect(serialToIso(46112)).toBe('2026-03-31');
  });

  /**
   * Excel believes 29 Feb 1900 existed, so its serial 60 names a day that never
   * did. Anchoring the epoch at 30 Dec 1899 rather than 31 Dec absorbs that
   * phantom day, which makes every serial from 61 on agree with Excel exactly —
   * and every serial below 60 land one day early.
   *
   * That trade is the standard one, and it is the right way round: the wrong
   * half is January and February 1900, and the right half is every date a cost
   * estimate or a settlement can carry. `dateSerial` in `write.ts` anchors
   * identically, so a workbook written and read back round-trips regardless.
   */
  it('agrees with Excel from 1 March 1900 on, at the cost of the two months before it', () => {
    expect(serialToIso(61)).toBe('1900-03-01');
    expect(serialToIso(46112)).toBe('2026-03-31');
    // Below the phantom day, one behind Excel — 1900-01-01 there, not here.
    expect(serialToIso(1)).toBe('1899-12-31');
  });

  it('rejects anything outside the serial range, so a numeric text column is not read as dates', () => {
    expect(serialToIso(0)).toBe('');
    expect(serialToIso(-5)).toBe('');
    expect(serialToIso(1e9)).toBe('');
    expect(serialToIso('not a number')).toBe('');
  });

  it('passes an ISO date through untouched', () => {
    expect(cellToIso('2026-03-31')).toBe('2026-03-31');
    expect(cellToIso('2026-03-31T00:00:00Z')).toBe('2026-03-31');
    expect(cellToIso('46112')).toBe('2026-03-31');
    expect(cellToIso('')).toBe('');
  });
});

describe('column matching', () => {
  const headers = [
    { index: 0, label: 'ARO obligation no.' },
    { index: 1, label: 'Cost centre' },
    { index: 2, label: 'Cost estimate (REP04)' },
    { index: 3, label: 'Settlement date last changed by' },
    { index: 4, label: 'Settlement date' },
  ];

  it('prefers an earlier keyword group over a later one', () => {
    // [['cost','estimate'], ['cost']] must not settle for "Cost centre".
    expect(findColumn(headers, [['cost', 'estimate'], ['cost']])).toBe(2);
  });

  it('falls back to a later group when nothing better exists', () => {
    expect(findColumn(headers, [['direct', 'cost'], ['cost']])).toBe(1);
  });

  it('breaks a tie on the shortest label', () => {
    expect(findColumn(headers, [['settlement', 'date']])).toBe(4);
  });

  it('reports -1 rather than guessing when nothing matches', () => {
    expect(findColumn(headers, [['currency']])).toBe(-1);
  });

  it('auto-maps a REP04 extract', () => {
    expect(autoMap('rep04', headers)).toMatchObject({ id: 0, cost: 2 });
  });

  it('leaves an unmappable field at -1 for the import screen to ask about', () => {
    expect(autoMap('rep06', [{ index: 0, label: 'Widget' }])).toEqual({
      id: -1,
      settlementDate: -1,
      fv: -1,
      pv: -1,
    });
  });

  it('covers every field each extract needs', () => {
    expect(Object.keys(COLUMN_HINTS.rep04)).toEqual(['id', 'cost', 'costEstimateDate']);
    expect(Object.keys(COLUMN_HINTS.rep06)).toEqual(['id', 'settlementDate', 'fv', 'pv']);
    expect(Object.keys(COLUMN_HINTS.curve)).toEqual(['validOn', 'term', 'rate']);
  });
});
