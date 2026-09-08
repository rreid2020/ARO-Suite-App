/**
 * The exported workbook, and the Excel restatement behind the formula panel.
 *
 * ENGINE-SPEC §9: "Variance formulas in exports stay self-contained and
 * paste-ready." The tests that matter here are the ones that fail if a derived
 * figure is ever exported as a value — a workbook of hard numbers looks
 * identical on screen and is worthless as a working paper.
 */

import { describe, expect, it } from 'vitest';
import { recalcWorkbook } from '../recalcWorkbook';
import { BUILT_IN_CURVE, RecalcRegister } from '../../core/recalc';
import { formulasFor } from '../../core/recalcFormulas';
import { Cell, Sheet } from '../write';

const reg: RecalcRegister = {
  fyEnd: '2026-03-31',
  inflation: 0.02,
  materiality: { usd: 1000, pct: 0.1 },
  rows: [
    {
      id: '1104279',
      cost: 19546595.86,
      costEstimateDate: '1992-12-23',
      settlementDate: '2037-01-31',
      rateOverride: null,
      sourceFv: 46815157.32,
      sourcePv: 32685377.12,
    },
    {
      id: '1103206',
      cost: 15176150.94,
      costEstimateDate: '2026-01-01',
      settlementDate: '2049-08-28',
      rateOverride: 0.04,
      sourceFv: null,
      sourcePv: null,
    },
  ],
  curve: BUILT_IN_CURVE,
  curveSource: 'client-curve.xlsx · 30 terms',
  rep04: { files: ['REP04.xlsx'], summary: '1 extract · 2 obligations' },
  rep06: { files: ['REP06.xlsx'], summary: '1 extract · 1 matched' },
  trialBalancePv: 32685377.12,
  seeded: false,
  signedOff: { by: 'A. Reyes', at: '2026-08-21' },
};

const book = recalcWorkbook(reg, '2026-08-21 09:41 UTC');
const byName = (n: string): Sheet => book.find((s) => s.name === n)!;

/** The object form of a cell, whatever shorthand it was written in. */
const cell = (c: Cell) => (c && typeof c === 'object' ? c : { v: c as string | number });

describe('the workbook', () => {
  it('has the four sheets an auditor needs: figures, inputs, curve, method', () => {
    expect(book.map((s) => s.name)).toEqual(['Results', 'Assumptions', 'Curve', 'Method']);
  });

  it('freezes the header rows on Results', () => {
    expect(byName('Results').freeze).toBe(3);
  });

  it('gives every column a width, so nothing opens as ###', () => {
    expect(byName('Results').cols).toHaveLength(21);
  });
});

describe('Results — every derived figure is a formula', () => {
  const row = byName('Results').rows[3];

  it('starts the obligations at row 4, under title, note and headers', () => {
    expect(cell(row[0]).v).toBe('1104279');
  });

  it('exports the inputs as values', () => {
    // A, B, C, D and the reported figures at P and Q are what was imported.
    expect(cell(row[0]).v).toBe('1104279');
    expect(cell(row[1]).v).toBe(19546595.86);
    expect(cell(row[2])).toMatchObject({ v: '1992-12-23', t: 'd' });
    expect(cell(row[15]).v).toBe(46815157.32);
    expect(cell(row[16]).v).toBe(32685377.12);
  });

  it('exports every derived column as a formula and never as a value', () => {
    // E, G-O, R-U. If any of these ever ships as a number the workbook stops
    // being a recalculation and becomes a screenshot.
    for (const i of [4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 19, 20]) {
      const c = cell(row[i]);
      expect(c.f, `column index ${i} must be a formula`).toBeTruthy();
      expect(c.v).toBeUndefined();
    }
  });

  it('references its own row, not row 4, on the second obligation', () => {
    const second = byName('Results').rows[4];
    expect(cell(second[6]).f).toBe('DAYS360(Assumptions!$B$3,D5)/360');
  });

  it('reads the rate off the curve unless the row carries an override', () => {
    expect(cell(row[8]).f).toBe('IF(F4<>"",F4,VLOOKUP(H4,Curve!$A$2:$B$1000,2,FALSE))');
    // No override on the first row; the second carries 4%, written as percent.
    expect(row[5]).toBeNull();
    expect(cell(byName('Results').rows[4][5]).v).toBeCloseTo(4, 12);
  });

  it('applies the same floor and cap on the curve term that the engine does', () => {
    expect(cell(row[7]).f).toBe('MIN(MAX(ROUNDUP(G4,0),1),Curve!$E$1)');
  });

  it('leaves the reported columns blank when there is nothing to compare', () => {
    const second = byName('Results').rows[4];
    expect(second[15]).toBeNull();
    expect(second[16]).toBeNull();
    // And the variance formulas guard against the blank rather than reading 0.
    expect(cell(second[18]).f).toContain('IF(Q5=""');
  });

  it('totals the money columns over the obligation rows only', () => {
    const total = byName('Results').rows.at(-1)!;
    expect(cell(total[0]).v).toBe('Portfolio total');
    expect(cell(total[14]).f).toBe('SUM(O4:O5)');
    expect(cell(total[20]).f).toContain('COUNTIF(U4:U5,"VARIANCE")');
  });

  it('states the materiality test against the assumptions sheet, not a literal', () => {
    // Changing materiality in the workbook must re-flag the register.
    expect(cell(row[20]).f).toContain('Assumptions!$B$5');
    expect(cell(row[20]).f).toContain('Assumptions!$B$6');
  });
});

describe('Assumptions — the inputs and the provenance', () => {
  const rows = byName('Assumptions').rows;
  const labelled = (label: string) => rows.find((r) => r[0] && cell(r[0]).v === label);

  it('carries the year end and the rates the Results sheet points at', () => {
    expect(cell(rows[2][1])).toMatchObject({ v: '2026-03-31', t: 'd' });
    expect(cell(rows[3][1]).v).toBeCloseTo(2, 12);
    expect(cell(rows[4][1]).v).toBe(1000);
    expect(cell(rows[5][1]).v).toBe(0.1);
  });

  it('names every file that was merged, not just the last one', () => {
    expect(cell(labelled('REP04 extracts')![1]).v).toBe('REP04.xlsx');
    expect(cell(labelled('REP06 source')![1]).v).toBe('1 extract · 1 matched');
  });

  it('states the day count and the leap-year adjustment in words', () => {
    expect(cell(labelled('Day count')![1]).v).toContain('DAYS360');
    expect(cell(labelled('Leap-year adjustment')![1]).v).toContain('day after the FY year end');
  });

  it('reconciles the control total inside the workbook, so it survives without the tool', () => {
    const tb = rows.findIndex((r) => r[0] && String(cell(r[0]).v).startsWith('Total ARO PV'));
    expect(cell(rows[tb][1]).v).toBe(32685377.12);
    expect(cell(rows[tb + 1][1]).f).toBe('SUM(Results!Q4:Q5)');
    expect(cell(rows[tb + 2][1]).f).toBe(`B${tb + 1}-B${tb + 2}`);
    expect(cell(rows[tb + 3][1]).f).toBe('SUM(Results!O4:O5)');
    expect(cell(rows[tb + 4][1]).f).toBe(`B${tb + 1}-B${tb + 4}`);
  });
});

describe('Curve — what the VLOOKUP reads', () => {
  const rows = byName('Curve').rows;

  it('publishes the table in percent, matching the rate column on Results', () => {
    expect(cell(rows[1][0]).v).toBe(1);
    expect(cell(rows[1][1]).v).toBeCloseTo(2.34012, 9);
    expect(rows).toHaveLength(31);
  });

  it('computes the max term the cap reads, rather than hard-coding 30', () => {
    expect(cell(rows[0][4]).f).toBe('MAX(A2:A1000)');
  });
});

describe('Method — the column-by-column explanation', () => {
  it('documents every derived column on Results', () => {
    const cols = byName('Method')
      .rows.slice(3)
      .map((r) => (r[0] ? cell(r[0]).v : null))
      .filter((v) => typeof v === 'string' && v.length <= 2);
    expect(cols).toEqual(['E', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'R', 'S', 'T', 'U']);
  });
});

describe('the formula panel', () => {
  const fx = formulasFor(reg.rows[0], { fyEnd: reg.fyEnd, inflation: reg.inflation }, BUILT_IN_CURVE, reg.materiality);
  const at = (ref: string) => fx.find((r) => r.ref === ref)!;

  it('is fifteen rows, A1 to A15, in order', () => {
    expect(fx.map((r) => r.ref)).toEqual(Array.from({ length: 15 }, (_, i) => `A${i + 1}`));
  });

  it('is self-contained — every reference points at a row above it', () => {
    for (const row of fx) {
      for (const ref of row.formula.match(/A(\d+)/g) ?? []) {
        expect(Number(ref.slice(1))).toBeLessThan(Number(row.ref.slice(1)));
      }
      // Nothing may reach for a sheet, a name or another workbook.
      expect(row.formula).not.toMatch(/!|\[/);
    }
  });

  it('states the curve term with the floor and the cap, so the pasted column agrees with the screen', () => {
    expect(at('A4').formula).toBe('=MIN(MAX(ROUNDUP(A3,0),1),30)');
    expect(at('A4').value).toBe('11');
  });

  it('writes the leap-year test as Excel, keyed on the cost estimate date', () => {
    expect(at('A5').formula).toContain('MOD(YEAR("1992-12-23"),400)=0');
    // 1992 is a leap year, so the boundary moves.
    expect(at('A5').value).toContain('leap-year adjustment applied');
  });

  it('states the materiality thresholds in the same units the register uses', () => {
    expect(at('A15').formula).toContain('>1000');
    expect(at('A15').formula).toContain('*100)>0.1');
    expect(at('A15').label).toContain('1,000.00 / 0.1%');
  });

  it('says which rate is in force when an override replaces the curve', () => {
    const over = formulasFor(reg.rows[1], { fyEnd: reg.fyEnd, inflation: reg.inflation }, BUILT_IN_CURVE, reg.materiality);
    expect(over.find((r) => r.ref === 'A2')!.label).toContain('manual override');
    expect(over.find((r) => r.ref === 'A2')!.formula).toBe('=4.00000/100');
  });

  it('reads NO SOURCE DATA rather than a nil variance when nothing was reported', () => {
    const none = formulasFor(reg.rows[1], { fyEnd: reg.fyEnd, inflation: reg.inflation }, BUILT_IN_CURVE, reg.materiality);
    expect(none.find((r) => r.ref === 'A15')!.value).toBe('NO SOURCE DATA');
    expect(none.find((r) => r.ref === 'A13')!.value).toBe('—');
  });
});
