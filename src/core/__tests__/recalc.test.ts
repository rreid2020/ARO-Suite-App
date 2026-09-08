/**
 * Mode 1 — the register, the exceptions and the extract merges.
 *
 * INVARIANTS §4 (gates are evaluated, never asserted) and §5 (nothing silently
 * dropped) as executable acceptance criteria.
 */

import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_CURVE,
  RecalcRegister,
  completeness,
  curveInForce,
  exceptions,
  mergeRep04,
  mergeRep06,
  portfolioTotals,
  vintageMatchesYearEnd,
  withFile,
} from '../recalc';
import { RecalcRow, recalculate } from '../../engine/recalc';

const row = (over: Partial<RecalcRow> = {}): RecalcRow => ({
  id: 'A1',
  cost: 1_000_000,
  costEstimateDate: '2021-06-30',
  settlementDate: '2036-06-30',
  rateOverride: null,
  sourceFv: null,
  sourcePv: null,
  ...over,
});

/** A register with every blocker already cleared, so a test can open one at a time. */
function clean(over: Partial<RecalcRegister> = {}): RecalcRegister {
  const rows = over.rows ?? [row()];
  const base: RecalcRegister = {
    fyEnd: '2026-03-31',
    inflation: 0.02,
    materiality: { usd: 1000, pct: 0.1 },
    rows,
    curve: BUILT_IN_CURVE,
    curveSource: 'test curve',
    rep04: { files: ['REP04.xlsx'], summary: '1 extract' },
    rep06: { files: ['REP06.xlsx'], summary: '1 extract' },
    trialBalancePv: 0,
    seeded: false,
    signedOff: { by: 'A. Reyes', at: '2026-08-21' },
    ...over,
  };
  // Agree the trial balance to whatever the register actually reports, so the
  // completeness blocker is closed unless a test deliberately opens it.
  if (over.trialBalancePv === undefined) {
    base.trialBalancePv = portfolioTotals(base).reportedPv;
  }
  return base;
}

/** A row whose reported figures agree with the recalculation exactly. */
function agreeing(reg: RecalcRegister, r: RecalcRow): RecalcRow {
  const k = recalculate(r, { fyEnd: reg.fyEnd, inflation: reg.inflation }, curveInForce(reg));
  return { ...r, sourceFv: k.fv, sourcePv: k.pv };
}

describe('the curve in force', () => {
  it('falls back to the built-in table until the client curve is imported', () => {
    expect(curveInForce({ curve: null })).toBe(BUILT_IN_CURVE);
    expect(curveInForce({ curve: { asAt: 'x', points: [] } })).toBe(BUILT_IN_CURVE);
  });

  it('the built-in table is quoted as decimals, 1 to 30 years', () => {
    expect(BUILT_IN_CURVE.points).toHaveLength(30);
    expect(BUILT_IN_CURVE.points[10]).toEqual({ term: 11, rate: 0.0337203 });
    for (const p of BUILT_IN_CURVE.points) expect(p.rate).toBeLessThan(1);
  });
});

describe('portfolio totals', () => {
  it('counts every row in the provision but only the compared ones in the variance', () => {
    const reg = clean({ trialBalancePv: null });
    const compared = agreeing(reg, row({ id: 'A1' }));
    const uncompared = row({ id: 'A2', cost: 500_000 });
    const t = portfolioTotals({ ...reg, rows: [compared, uncompared] });

    expect(t.count).toBe(2);
    expect(t.covered).toBe(1);
    // The untested row is in the provision but not in the comparison.
    expect(t.pv).toBeGreaterThan(t.comparedPv);
    expect(t.variance).toBeCloseTo(0, 6);
    expect(t.flag).toBe('PASS');
  });

  it('flags the rows that breach and totals the variance across them', () => {
    const reg = clean({ trialBalancePv: null });
    const base = agreeing(reg, row());
    const off = { ...base, sourcePv: (base.sourcePv as number) + 50_000 };
    const t = portfolioTotals({ ...reg, rows: [off] });
    expect(t.flagged).toBe(1);
    expect(t.variance).toBeCloseTo(50_000, 4);
    expect(t.flag).toBe('VARIANCE');
  });

  it('an empty register totals to nil rather than NaN', () => {
    const t = portfolioTotals(clean({ rows: [], trialBalancePv: null }));
    expect(t).toMatchObject({ count: 0, covered: 0, pv: 0, variance: 0, flag: 'PASS' });
  });
});

describe('completeness — the control total', () => {
  it('is not entered until it is entered, and nothing is derived from it', () => {
    const c = completeness(clean({ trialBalancePv: null }));
    expect(c.status).toBe('NOT ENTERED');
  });

  it('agrees when the trial balance matches the reported population', () => {
    const reg = clean({ trialBalancePv: null });
    const rows = [agreeing(reg, row())];
    const reported = portfolioTotals({ ...reg, rows }).reportedPv;
    expect(completeness({ ...reg, rows, trialBalancePv: reported }).status).toBe('AGREES');
  });

  it('is struck against the reported total, not the recalculated one', () => {
    const reg = clean({ trialBalancePv: null });
    const base = agreeing(reg, row());
    // A row whose reported PV is 50k above the recalculation. The trial balance
    // agrees with the source system, so completeness passes — the difference is
    // a variance, which is a separate exception.
    const rows = [{ ...base, sourcePv: (base.sourcePv as number) + 50_000 }];
    const t = portfolioTotals({ ...reg, rows });
    const c = completeness({ ...reg, rows, trialBalancePv: t.reportedPv });
    expect(c.status).toBe('AGREES');
    expect(c.vsReported).toBeCloseTo(0, 6);
    expect(c.vsRecalculated).toBeCloseTo(50_000, 4);
  });

  it('reports a difference when obligations are missing from the extract', () => {
    const reg = clean({ trialBalancePv: null });
    const rows = [agreeing(reg, row())];
    const reported = portfolioTotals({ ...reg, rows }).reportedPv;
    const c = completeness({ ...reg, rows, trialBalancePv: reported + 250_000 });
    expect(c.status).toBe('DIFFERENCE');
    expect(c.vsReported).toBeCloseTo(250_000, 4);
  });

  it('tolerates a difference inside the absolute materiality threshold', () => {
    const reg = clean({ trialBalancePv: null });
    const rows = [agreeing(reg, row())];
    const reported = portfolioTotals({ ...reg, rows }).reportedPv;
    expect(completeness({ ...reg, rows, trialBalancePv: reported + 999 }).status).toBe('AGREES');
    expect(completeness({ ...reg, rows, trialBalancePv: reported + 1001 }).status).toBe('DIFFERENCE');
  });
});

describe('exceptions — evaluated, never asserted (INVARIANTS §4)', () => {
  it('a fully reconciled register is clear to finalise', () => {
    const reg = clean({ trialBalancePv: null });
    const rows = [agreeing(reg, row())];
    const ready = { ...reg, rows, trialBalancePv: portfolioTotals({ ...reg, rows }).reportedPv };
    const e = exceptions(ready);
    expect(e.blockers).toBe(0);
    expect(e.clear).toBe(true);
  });

  it('holds the recalculation while an extract has not been imported', () => {
    const e = exceptions(clean({ rep04: null, rep06: null }));
    const ids = e.items.map((i) => i.id);
    expect(ids).toContain('rep04-missing');
    expect(ids).toContain('rep06-missing');
    expect(e.clear).toBe(false);
  });

  it('a duplicate obligation number is a blocker — it is counted twice in every total', () => {
    const e = exceptions(clean({ rows: [row({ id: 'A1' }), row({ id: 'A1' })] }));
    const dupe = e.items.find((i) => i.id === 'duplicate-ids');
    expect(dupe?.severity).toBe('BLOCKER');
    expect(dupe?.count).toBe(1);
  });

  it('a row with no cost estimate or no settlement date blocks', () => {
    const e = exceptions(clean({ rows: [row({ cost: 0 }), row({ id: 'A2', settlementDate: '' })] }));
    const ids = e.items.map((i) => i.id);
    expect(ids).toContain('no-cost');
    expect(ids).toContain('no-settlement');
  });

  it('separates the PV variance (a blocker) from the FV variance (a review)', () => {
    const reg = clean({ trialBalancePv: null });
    const base = agreeing(reg, row());
    // Move only the reported FV: the discounting agrees, the escalation does not.
    const rows = [{ ...base, sourceFv: (base.sourceFv as number) * 1.2 }];
    const e = exceptions({ ...reg, rows, trialBalancePv: portfolioTotals({ ...reg, rows }).reportedPv });
    expect(e.items.find((i) => i.id === 'fv-variance')?.severity).toBe('REVIEW');
    expect(e.items.find((i) => i.id === 'pv-variance')).toBeUndefined();
  });

  it('an uncompared row is a review, not a silent omission (INVARIANTS §5)', () => {
    const reg = clean({ trialBalancePv: null });
    const rows = [agreeing(reg, row()), row({ id: 'A2' })];
    const e = exceptions({ ...reg, rows, trialBalancePv: portfolioTotals({ ...reg, rows }).reportedPv });
    const noSource = e.items.find((i) => i.id === 'no-source');
    expect(noSource?.severity).toBe('REVIEW');
    expect(noSource?.count).toBe(1);
  });

  it('running on the built-in curve is disclosed', () => {
    expect(exceptions(clean({ curve: null })).items.map((i) => i.id)).toContain('curve-missing');
  });

  it('a term past the end of the curve is disclosed rather than swallowed', () => {
    // 2026-03-31 → 2070-06-30 is 44 years against a 30-year curve.
    const e = exceptions(clean({ rows: [row({ settlementDate: '2070-06-30' })] }));
    const beyond = e.items.find((i) => i.id === 'beyond-curve');
    expect(beyond?.severity).toBe('REVIEW');
    expect(beyond?.count).toBe(1);
  });

  it('a manual rate override needs an explanation on file', () => {
    const e = exceptions(clean({ rows: [row({ rateOverride: 0.05 })] }));
    expect(e.items.find((i) => i.id === 'rate-override')?.severity).toBe('REVIEW');
  });

  it('nil materiality is reported as a setting, not treated as unset', () => {
    const e = exceptions(clean({ materiality: { usd: 0, pct: 0 } }));
    expect(e.items.find((i) => i.id === 'materiality-nil')?.severity).toBe('INFO');
  });

  it('an outstanding sign-off is information, not a bar to finalising', () => {
    const reg = clean({ trialBalancePv: null, signedOff: null });
    const rows = [agreeing(reg, row())];
    const e = exceptions({ ...reg, rows, trialBalancePv: portfolioTotals({ ...reg, rows }).reportedPv });
    expect(e.items.find((i) => i.id === 'unsigned')?.severity).toBe('INFO');
    expect(e.clear).toBe(true);
  });

  it('every exception names a step that can resolve it', () => {
    for (const item of exceptions(clean({ rep04: null, curve: null })).items) {
      expect(item.screen).not.toBe('');
      expect(item.action).not.toBe('');
    }
  });

  it('cannot be ticked away — clearing the data is what clears the exception', () => {
    const withDupe = clean({ rows: [row({ id: 'A1' }), row({ id: 'A1' })] });
    expect(exceptions(withDupe).items.some((i) => i.id === 'duplicate-ids')).toBe(true);
    const fixed = { ...withDupe, rows: [row({ id: 'A1' }), row({ id: 'A2' })] };
    expect(exceptions(fixed).items.some((i) => i.id === 'duplicate-ids')).toBe(false);
  });
});

describe('curve vintage against the year end', () => {
  it('accepts the year end however the file spells it', () => {
    expect(vintageMatchesYearEnd('2026-03-31', '2026-03-31')).toBe(true);
    expect(vintageMatchesYearEnd('31.03.2026', '2026-03-31')).toBe(true);
    expect(vintageMatchesYearEnd('03/31/2026', '2026-03-31')).toBe(true);
  });

  it('accepts a vintage that states the year alone', () => {
    expect(vintageMatchesYearEnd('FY2026', '2026-03-31')).toBe(true);
  });

  it('rejects a curve from the wrong year', () => {
    expect(vintageMatchesYearEnd('31.03.2025', '2026-03-31')).toBe(false);
  });

  it('rejects the right year at the wrong date', () => {
    expect(vintageMatchesYearEnd('30.09.2026', '2026-03-31')).toBe(false);
  });
});

describe('REP04 merge', () => {
  const line = (id: string, cost: number, date = '2021-06-30') => ({
    id,
    cost,
    costEstimateDate: date,
  });

  it('clears the illustrative rows on the first real extract', () => {
    const out = mergeRep04([row({ id: 'SEED' })], true, [line('A1', 100)], 'REP04.xlsx');
    expect(out.rows.map((r) => r.id)).toEqual(['A1']);
    expect(out.added).toBe(1);
  });

  it('merges a second extract by obligation number rather than replacing', () => {
    const first = mergeRep04([], true, [line('A1', 100)], 'one.xlsx');
    const second = mergeRep04(first.rows, false, [line('A2', 200)], 'two.xlsx');
    expect(second.rows.map((r) => r.id)).toEqual(['A1', 'A2']);
    expect(second).toMatchObject({ added: 1, updated: 0 });
  });

  it('updates an obligation a later extract restates', () => {
    const first = mergeRep04([], true, [line('A1', 100)], 'one.xlsx');
    const second = mergeRep04(first.rows, false, [line('A1', 999, '2022-01-31')], 'two.xlsx');
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]).toMatchObject({ cost: 999, costEstimateDate: '2022-01-31' });
    expect(second).toMatchObject({ added: 0, updated: 1 });
  });

  it('preserves the reported figures an earlier REP06 already wrote', () => {
    const seeded = [row({ id: 'A1', sourceFv: 500, sourcePv: 400 })];
    const out = mergeRep04(seeded, false, [line('A1', 999)], 'REP04.xlsx');
    expect(out.rows[0]).toMatchObject({ cost: 999, sourceFv: 500, sourcePv: 400 });
  });

  it('counts what it could not use rather than dropping it silently', () => {
    const out = mergeRep04([], true, [
      line('A1', 100),
      line('', 100),
      line('A2', NaN),
      { id: 'A3', cost: 100, costEstimateDate: '' },
    ], 'REP04.xlsx');
    expect(out.rows).toHaveLength(1);
    expect(out.skipped).toBe(3);
    expect(out.summary).toContain('3 skipped');
  });

  it('takes the first of two rows for the same obligation in one file', () => {
    const out = mergeRep04([], true, [line('A1', 100), line('A1', 200)], 'REP04.xlsx');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].cost).toBe(100);
    expect(out.skipped).toBe(1);
  });
});

describe('REP06 merge', () => {
  const line = (id: string, fv: number | null, pv: number | null, st = '2036-06-30') => ({
    id,
    settlementDate: st,
    fv,
    pv,
  });

  it('writes the settlement date and the reported figures onto a matched row', () => {
    const out = mergeRep06([row({ id: 'A1', settlementDate: '' })], [line('A1', 500, 400)], 'REP06.xlsx');
    expect(out.rows[0]).toMatchObject({ settlementDate: '2036-06-30', sourceFv: 500, sourcePv: 400 });
    expect(out.updated).toBe(1);
  });

  it('carries in an obligation the source system reports but REP04 never had', () => {
    const out = mergeRep06([row({ id: 'A1' })], [line('A1', 500, 400), line('A2', 900, 800)], 'REP06.xlsx');
    expect(out.rows.map((r) => r.id)).toEqual(['A1', 'A2']);
    // It arrives with no cost estimate, so it surfaces as a blocker rather than
    // quietly shrinking the population the control total is measured against.
    expect(out.rows[1]).toMatchObject({ cost: 0, costEstimateDate: '', sourcePv: 800 });
    expect(out.added).toBe(1);
    expect(out.summary).toContain('1 not in REP04');
  });

  it('takes the settlement date even when the figures are unusable', () => {
    const out = mergeRep06([row({ id: 'A1', settlementDate: '' })], [line('A1', null, 400)], 'REP06.xlsx');
    expect(out.rows[0].settlementDate).toBe('2036-06-30');
    expect(out.rows[0].sourceFv).toBeNull();
  });

  it('leaves an unmatched register row untouched', () => {
    const before = row({ id: 'A1', sourceFv: 1, sourcePv: 2 });
    const out = mergeRep06([before], [line('B9', 500, 400)], 'REP06.xlsx');
    expect(out.rows[0]).toBe(before);
  });
});

describe('extract provenance', () => {
  it('accumulates every file, in the order they were applied', () => {
    const one = withFile(null, 'a.xlsx', 'first');
    const two = withFile(one, 'b.xlsx', 'second');
    expect(two.files).toEqual(['a.xlsx', 'b.xlsx']);
    expect(one.summary).toBe('1 extract · first');
    expect(two.summary).toBe('2 extracts · second');
  });
});
