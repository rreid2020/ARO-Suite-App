/**
 * ENGINE-SPEC §9.2 (leap-year boundary) and §9.4 (term convention), plus the
 * chain itself.
 */

import { describe, expect, it } from 'vitest';
import { price, derive } from '../derive';
import { curveTermOf, TERM_CONVENTIONS } from '../curve';
import { term360 } from '../dates';
import { assumptions, obligation, quarterCurve, yearCurve } from './fixtures';

describe('the chain — ENGINE-SPEC §3', () => {
  it('applies contingency once, before escalation', () => {
    const p = price({
      direct: 1_000_000,
      contingency: 0.10,
      costEstimateDate: '2025-12-31',
      settlementDate: '2030-12-31',
      fyEnd: '2025-12-31',
      inflation: 0.025,
      curve: yearCurve,
      termConvention: 'Round up to whole year (SAP)',
    });
    expect(p.cost).toBeCloseTo(1_100_000, 6);
    // t1 is nil — the cost estimate date is the year end — so cce equals cost.
    expect(p.t1).toBe(0);
    expect(p.cce).toBeCloseTo(1_100_000, 6);
    // tD = 5 years, SAP rounding leaves 5, rate = 4.40%.
    expect(p.tD).toBeCloseTo(5, 12);
    expect(p.curveTerm).toBe(5);
    expect(p.rate).toBeCloseTo(0.0440, 12);
    expect(p.fv).toBeCloseTo(1_100_000 * Math.pow(1.025, 5), 6);
    expect(p.pv).toBeCloseTo(p.fv / Math.pow(1.044, 5), 6);
  });

  it('cost revisions are added to direct cost, so contingency applies to the revised figure', () => {
    const o = obligation({
      adj: [{ id: 'a1', kind: 'cost', amount: 100_000, date: '2025-09-30', reason: 'Scope increase' }],
    });
    const d = derive(o, assumptions(), { curve: yearCurve });
    // Build-up is 12×45,000 + 300×210 = 603,000. Plus the 100,000 revision.
    expect(d.direct).toBeCloseTo(703_000, 6);
    expect(d.cost).toBeCloseTo(703_000 * 1.10, 6);
  });

  it('a timing revision moves the settlement date, latest wins', () => {
    const o = obligation({
      adj: [
        { id: 'a1', kind: 'term', to: '2034-06-30', date: '2025-03-31', reason: 'Licence extension' },
        { id: 'a2', kind: 'term', to: '2035-06-30', date: '2025-09-30', reason: 'Further extension' },
      ],
    });
    const d = derive(o, assumptions(), { curve: yearCurve });
    expect(d.settlementUsed).toBe('2035-06-30');
    expect(d.timingRevised).toBe(true);
  });
});

describe('leap-year shift — ENGINE-SPEC §9.2', () => {
  const fyEnd = '2025-12-31';

  it('shifts the second escalation leg to the day after the year end when the cost estimate date is in a leap year', () => {
    const leap = price({
      direct: 1_000_000, contingency: 0, costEstimateDate: '2024-06-30',
      settlementDate: '2030-06-30', fyEnd: '2024-12-31', inflation: 0.025,
      curve: yearCurve, termConvention: 'Round up to whole year (SAP)',
    });
    expect(leap.leap).toBe(true);
    expect(leap.mcd).toBe('2025-01-01');

    const notLeap = price({
      direct: 1_000_000, contingency: 0, costEstimateDate: '2025-06-30',
      settlementDate: '2031-06-30', fyEnd: '2025-12-31', inflation: 0.025,
      curve: yearCurve, termConvention: 'Round up to whole year (SAP)',
    });
    expect(notLeap.leap).toBe(false);
    expect(notLeap.mcd).toBe('2025-12-31');
  });

  /**
   * §9.2 asks to "assert `t1 + t2` equals the implied term and that `tD` is
   * unchanged". The `tD` half holds unconditionally and is asserted below.
   *
   * The `t1 + t2` half does NOT hold unconditionally under the implementation
   * §3 specifies, and this test pins the real behaviour rather than the claim.
   * The reason is that 30/360 is not additive through a mid-point: the year end
   * is folded as `d2` in leg 1 (a 31st folds only when the start is a 30th) but
   * as `d1` in leg 2 (a 31st always folds). The shift corrects that mismatch
   * when the cost estimate date is not itself a 30th or 31st, and introduces one
   * when it is. It is keyed on the leap year, not on the day of the month, which
   * is why it lands both ways. The README says to reproduce this exactly and not
   * to "fix" it, so the divergence is recorded here rather than corrected.
   */
  const additivity: [string, string, string, boolean, number][] = [
    // pk, fyEnd, st, leap, (t1 + t2) − implied, in 30/360 days
    ['2024-06-30', '2024-12-31', '2030-12-31', true, 0],
    ['2023-06-30', '2023-12-31', '2029-12-31', false, 0],
    ['2024-06-30', '2024-12-31', '2030-06-30', true, -1],
    ['2023-06-30', '2023-12-31', '2030-06-30', false, 0],
    ['2024-03-15', '2024-12-31', '2032-09-30', true, 0],
    ['2025-03-15', '2025-12-31', '2033-09-30', false, 1],
  ];

  it.each(additivity)(
    'pk=%s fy=%s st=%s → legs differ from the implied term by %i/360 (documented, not corrected)',
    (pk, fy, st, _leap, diffDays) => {
      const p = price({
        direct: 1, contingency: 0, costEstimateDate: pk, settlementDate: st,
        fyEnd: fy, inflation: 0.025, curve: yearCurve,
        termConvention: 'Round up to whole year (SAP)',
      });
      const implied = term360(pk, st);
      expect(Math.round((p.t1 + p.t2 - implied) * 360)).toBe(diffDays);
    },
  );

  it('tD is unaffected by the shift — discounting still runs from the year end', () => {
    for (const [pk, fy, st] of additivity) {
      const p = price({
        direct: 1, contingency: 0, costEstimateDate: pk, settlementDate: st,
        fyEnd: fy, inflation: 0.025, curve: yearCurve,
        termConvention: 'Round up to whole year (SAP)',
      });
      expect(p.tD).toBeCloseTo(term360(fy, st), 12);
    }
  });
});

describe('term convention — ENGINE-SPEC §9.4', () => {
  // 6.5 years to settlement, on a quarter-year curve.
  const tD = term360('2025-12-31', '2032-06-30');

  it('the three conventions give three different terms on a quarter-year curve', () => {
    const sap = curveTermOf(quarterCurve, tD, 'Round up to whole year (SAP)');
    const next = curveTermOf(quarterCurve, tD, 'Round up to the next curve point');
    const exact = curveTermOf(quarterCurve, tD, 'Exact fractional years');

    expect(sap.term).toBe(7);
    expect(next.term).toBe(6.5);
    expect(exact.term).toBeCloseTo(6.5, 12);
    expect(sap.term).not.toBe(next.term);
  });

  it('the difference is material enough to be worth the setting', () => {
    const o = obligation({ costEstimateDate: '2025-12-31', settlementDate: '2032-06-30' });
    const runs = TERM_CONVENTIONS.map((c) =>
      derive(o, assumptions({ termConvention: c }), { curve: quarterCurve }).pv,
    );
    const spread = Math.max(...runs) - Math.min(...runs);
    expect(spread).toBeGreaterThan(0);
    // SAP rounds the term *up*, which discounts harder, so it is the lowest PV.
    expect(runs[0]).toBeLessThan(runs[1]);
  });

  it('SAP rounding is the default and never changes — INVARIANTS §9', () => {
    expect(curveTermOf(yearCurve, 4.2).term).toBe(5);
    expect(curveTermOf(yearCurve, 4.0).term).toBe(4);
  });
});
