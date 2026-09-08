/**
 * Mode 1, end to end.
 *
 * A real .xlsx goes in, the register is built by the same functions the screens
 * call, and a workbook comes out. The unit tests cover each step in isolation;
 * this one covers the joins between them — the column mapping feeding the merge,
 * the merge feeding the exceptions, the exceptions clearing as the data lands.
 *
 * Everything here is pure, so it runs without React, a store or a database.
 */

import { describe, expect, it } from 'vitest';
import {
  RecalcRegister,
  completeness,
  curveInForce,
  emptyRecalcRegister,
  exceptions,
  mergeRep04,
  mergeRep06,
  portfolioTotals,
  withFile,
} from '../recalc';
import { StagedExtract, curveFromStage, pickVintage, rep04Lines, rep06Lines } from '../recalcImport';
import { assumptionsOf } from '../recalc';
import { recalculate } from '../../engine/recalc';
import { autoMap, readSheet } from '../../xlsx/read';
import { Cell, Sheet, build } from '../../xlsx/write';
import { recalcWorkbook } from '../../xlsx/recalcWorkbook';

const FY_END = '2026-03-31';

/** Three obligations, dated to exercise the leap-year shift and the curve cap. */
const OBLIGATIONS = [
  { id: 'OB-1001', cost: 4_500_000, pk: '2024-06-30', st: '2037-01-31' },
  { id: 'OB-1002', cost: 2_750_000, pk: '2023-09-30', st: '2031-06-30' },
  { id: 'OB-1003', cost: 9_100_000, pk: '2025-01-15', st: '2070-06-30' },
];

async function stage(kind: 'rep04' | 'rep06' | 'curve', sheet: Sheet, file: string): Promise<StagedExtract> {
  const read = await readSheet(new Uint8Array(await build([sheet]).arrayBuffer()));
  return { kind, file, sheet: read, map: autoMap(kind, read.headers) };
}

/** REP04 as a source system exports it: a title row, then the grid. */
const rep04Sheet: Sheet = {
  name: 'REP04',
  rows: [
    ['ARO cost estimates — run 2026-04-02'],
    ['ARO obligation no.', 'Cost estimate', 'Cost estimate date', 'Cost centre'],
    ...OBLIGATIONS.map((o) => [o.id, o.cost, { v: o.pk, t: 'd' }, 'CC-100']),
  ] as Cell[][],
};

/** A curve file carrying two vintages, quoted in percent. */
const curveSheet: Sheet = {
  name: 'Yield curves',
  rows: [
    ['Valid on', 'Term', 'Interest rate'],
    ...Array.from({ length: 30 }, (_, i) => ['31.03.2026', i + 1, 2.3 + i * 0.05]),
    ...Array.from({ length: 30 }, (_, i) => ['31.03.2025', i + 1, 1.8 + i * 0.04]),
  ] as Cell[][],
};

describe('Mode 1 end to end', () => {
  it('imports a curve, picks the right vintage and converts it to decimals', async () => {
    const s = await stage('curve', curveSheet, 'curves.xlsx');
    const vintage = pickVintage(s, FY_END);
    expect(vintage).toBe('31.03.2026');

    const points = curveFromStage(s, vintage);
    expect(points).toHaveLength(30);
    expect(points[0]).toMatchObject({ term: 1 });
    expect(points[0].rate).toBeCloseTo(0.023, 12);
    // The 2025 vintage is left behind entirely.
    expect(points[29].rate).toBeCloseTo(0.0375, 12);
  });

  it('walks an empty register to a concluded recalculation', async () => {
    let reg: RecalcRegister = emptyRecalcRegister(FY_END);

    // ── Nothing imported: both extracts block. ──────────────────────────
    let report = exceptions(reg);
    expect(report.items.map((i) => i.id)).toEqual(
      expect.arrayContaining(['rep04-missing', 'rep06-missing', 'tb-missing', 'curve-missing']),
    );
    expect(report.clear).toBe(false);

    // ── The curve. ─────────────────────────────────────────────────────
    const curveStage = await stage('curve', curveSheet, 'curves.xlsx');
    const vintage = pickVintage(curveStage, FY_END);
    reg = {
      ...reg,
      curve: { asAt: vintage, points: curveFromStage(curveStage, vintage) },
      curveSource: 'curves.xlsx · 30 terms',
    };
    expect(exceptions(reg).items.some((i) => i.id === 'curve-missing')).toBe(false);

    // ── REP04. The mapping is found without being told. ────────────────
    const s04 = await stage('rep04', rep04Sheet, 'REP04.xlsx');
    expect(s04.map).toMatchObject({ id: 0, cost: 1, costEstimateDate: 2 });

    const m04 = mergeRep04(reg.rows, reg.seeded, rep04Lines(s04), 'REP04.xlsx');
    expect(m04).toMatchObject({ added: 3, updated: 0, skipped: 0 });
    reg = { ...reg, rows: m04.rows, seeded: false, rep04: withFile(null, 'REP04.xlsx', m04.summary) };

    // Every row has a cost estimate but no settlement date yet — REP06 owns it.
    expect(exceptions(reg).items.find((i) => i.id === 'no-settlement')?.count).toBe(3);

    // ── REP06, built so the reported figures agree with the recalculation
    //    on two rows and differ materially on the third. ────────────────
    const a = assumptionsOf(reg);
    const curve = curveInForce(reg);
    const withDates = reg.rows.map((r) => ({
      ...r,
      settlementDate: OBLIGATIONS.find((o) => o.id === r.id)!.st,
    }));
    const priced = withDates.map((r) => recalculate(r, a, curve));

    const rep06Sheet: Sheet = {
      name: 'REP06',
      rows: [
        ['Obligation no.', 'Current end date', 'FV of obligation', 'PV of obligation'],
        ...withDates.map((r, i) => {
          const drift = r.id === 'OB-1002' ? 1.03 : 1;
          return [r.id, { v: r.settlementDate, t: 'd' }, priced[i].fv * drift, priced[i].pv * drift];
        }),
      ] as Cell[][],
    };

    const s06 = await stage('rep06', rep06Sheet, 'REP06.xlsx');
    expect(s06.map).toMatchObject({ id: 0, settlementDate: 1, fv: 2, pv: 3 });

    const m06 = mergeRep06(reg.rows, rep06Lines(s06), 'REP06.xlsx');
    expect(m06).toMatchObject({ updated: 3, added: 0 });
    reg = { ...reg, rows: m06.rows, rep06: withFile(null, 'REP06.xlsx', m06.summary) };

    // The settlement dates came in with it, so that blocker closes.
    expect(exceptions(reg).items.some((i) => i.id === 'no-settlement')).toBe(false);

    // ── The variance is exactly the one row that was drifted. ──────────
    const totals = portfolioTotals(reg);
    expect(totals.count).toBe(3);
    expect(totals.covered).toBe(3);
    expect(totals.flagged).toBe(1);

    const pvVariance = exceptions(reg).items.find((i) => i.id === 'pv-variance');
    expect(pvVariance?.severity).toBe('BLOCKER');
    expect(pvVariance?.detail).toContain('OB-1002');

    // ── The control total. It agrees with what REP06 reported, so the
    //    population is complete even though one row disagrees. ──────────
    reg = { ...reg, trialBalancePv: totals.reportedPv };
    expect(completeness(reg).status).toBe('AGREES');
    expect(exceptions(reg).items.some((i) => i.id === 'tb-missing')).toBe(false);

    // ── What is left is the real finding, not import noise. ────────────
    const open = exceptions(reg).items.filter((i) => i.severity === 'BLOCKER');
    expect(open.map((i) => i.id)).toEqual(['pv-variance']);

    // OB-1003 settles in 2070, past the end of a 30-year curve, and says so.
    const beyond = exceptions(reg).items.find((i) => i.id === 'beyond-curve');
    expect(beyond?.severity).toBe('REVIEW');
    expect(beyond?.detail).toContain('OB-1003');

    // ── Resolving the variance clears the last blocker. ────────────────
    const corrected = {
      ...reg,
      rows: reg.rows.map((r, i) => (r.id === 'OB-1002' ? { ...r, sourceFv: priced[i].fv, sourcePv: priced[i].pv } : r)),
    };
    const settled = { ...corrected, trialBalancePv: portfolioTotals(corrected).reportedPv };
    expect(exceptions(settled).clear).toBe(true);

    // ── And the workbook exports what the screen showed. ───────────────
    const book = recalcWorkbook(settled, '2026-04-02 09:00 UTC');
    expect(book.map((s) => s.name)).toEqual(['Results', 'Assumptions', 'Curve', 'Method']);
    // Three obligations, under the three header rows, plus a blank and a total.
    expect(book[0].rows).toHaveLength(3 + 3 + 2);
    expect(book[2].rows).toHaveLength(31);
  });

  it('carries an obligation REP06 reports but REP04 never had, as a blocker', async () => {
    let reg: RecalcRegister = emptyRecalcRegister(FY_END);
    const s04 = await stage('rep04', rep04Sheet, 'REP04.xlsx');
    const m04 = mergeRep04(reg.rows, reg.seeded, rep04Lines(s04), 'REP04.xlsx');
    reg = { ...reg, rows: m04.rows, seeded: false, rep04: withFile(null, 'REP04.xlsx', m04.summary) };

    const orphanSheet: Sheet = {
      name: 'REP06',
      rows: [
        ['Obligation no.', 'Current end date', 'FV of obligation', 'PV of obligation'],
        ['OB-9999', { v: '2040-06-30', t: 'd' }, 1_000_000, 600_000],
      ] as Cell[][],
    };
    const s06 = await stage('rep06', orphanSheet, 'REP06.xlsx');
    const m06 = mergeRep06(reg.rows, rep06Lines(s06), 'REP06.xlsx');
    reg = { ...reg, rows: m06.rows, rep06: withFile(null, 'REP06.xlsx', m06.summary) };

    // It is in the register, in the reported total, and blocking — not dropped.
    expect(reg.rows).toHaveLength(4);
    expect(portfolioTotals(reg).reportedPv).toBe(600_000);
    const noCost = exceptions(reg).items.find((i) => i.id === 'no-cost');
    expect(noCost?.severity).toBe('BLOCKER');
    expect(noCost?.detail).toContain('OB-9999');
  });
});
