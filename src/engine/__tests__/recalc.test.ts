/**
 * Mode 1 — the recalculation chain.
 *
 * The figures asserted here are computed from the chain in ENGINE-SPEC §3, not
 * copied from the prototype's rendering: the point of a golden test is that it
 * fails when the arithmetic moves, and a fixture lifted from the same code it
 * is testing cannot do that. Where a value is stated to the cent it was derived
 * independently from the formula in the assertion's own comment.
 */

import { describe, expect, it } from 'vitest';
import {
  RecalcAssumptions,
  RecalcCurve,
  RecalcRow,
  accretionSchedule,
  curveMaxTerm,
  modifiedCostEstimateDate,
  normaliseCurveRates,
  recalcBridge,
  recalcCurveRate,
  recalcCurveTerm,
  recalculate,
  sourceFigures,
  varianceFlag,
} from '../recalc';
import { term360 } from '../dates';

/** A 30-year whole-year curve, rates as decimals. */
const curve: RecalcCurve = {
  asAt: '31.03.2026',
  points: [
    2.34012, 2.51457, 2.63207, 2.73938, 2.844, 2.94689, 3.04639, 3.14023, 3.22647, 3.3039,
    3.37203, 3.43101, 3.4815, 3.52442, 3.5609, 3.59206, 3.61897, 3.6426, 3.66373, 3.683,
    3.70084, 3.71757, 3.73335, 3.74822, 3.76215, 3.77501, 3.78666, 3.79691, 3.80556, 3.81243,
  ].map((rate, i) => ({ term: i + 1, rate: rate / 100 })),
};

const assumptions: RecalcAssumptions = { fyEnd: '2026-03-31', inflation: 0.02 };

const row = (over: Partial<RecalcRow> = {}): RecalcRow => ({
  id: '1104279',
  cost: 19546595.86,
  costEstimateDate: '1992-12-23',
  settlementDate: '2037-01-31',
  rateOverride: null,
  sourceFv: null,
  sourcePv: null,
  ...over,
});

describe('the term convention — ENGINE-SPEC §4, rounded up, per SAP', () => {
  it('rounds a part year up to the next whole year', () => {
    // 2026-03-31 → 2049-08-28 is 23.41 years; SAP takes the next full year.
    expect(recalcCurveTerm(curve, term360('2026-03-31', '2049-08-28')).raw).toBe(24);
  });

  it('leaves an exact whole year alone rather than rounding it up', () => {
    // The tolerance exists for this: ceil() on a whole year must not reach 11.
    expect(recalcCurveTerm(curve, 10).raw).toBe(10);
    expect(recalcCurveTerm(curve, 10 + 1e-12).raw).toBe(10);
    expect(recalcCurveTerm(curve, 10.000001).raw).toBe(11);
  });

  it('floors at one year when the obligation settles on or before the year end', () => {
    expect(recalcCurveTerm(curve, 0).term).toBe(1);
    expect(recalcCurveTerm(curve, -4.5).term).toBe(1);
  });

  it('caps at the end of the curve and says that it did', () => {
    const beyond = recalcCurveTerm(curve, 41.2);
    expect(beyond).toEqual({ raw: 42, term: 30, beyond: true });
    expect(recalcCurveTerm(curve, 29.5).beyond).toBe(false);
  });

  it('an empty curve caps nothing — there is no last point to fall back on', () => {
    expect(recalcCurveTerm({ asAt: '', points: [] }, 12.3)).toEqual({ raw: 13, term: 13, beyond: false });
    expect(curveMaxTerm({ asAt: '', points: [] })).toBe(0);
  });
});

describe('the curve lookup — §5', () => {
  it('reads the published rate at a whole-year term', () => {
    expect(recalcCurveRate(curve, 11)).toBeCloseTo(0.0337203, 12);
  });

  it('applies the last rate flat past the end of the table', () => {
    expect(recalcCurveRate(curve, 45)).toBeCloseTo(0.0381243, 12);
  });

  it('an empty curve reads nil rather than throwing', () => {
    expect(recalcCurveRate({ asAt: '', points: [] }, 5)).toBe(0);
  });
});

describe('curve rate normalisation', () => {
  it('divides a table quoted in percent', () => {
    expect(normaliseCurveRates([{ term: 1, rate: 3.37 }])).toEqual([{ term: 1, rate: 0.0337 }]);
  });

  it('leaves a table already quoted in decimals alone', () => {
    const pts = [{ term: 1, rate: 0.0337 }, { term: 2, rate: 0.0343 }];
    expect(normaliseCurveRates(pts)).toEqual(pts);
  });
});

describe('the leap-year shift — §3, reproduced including where it looks wrong', () => {
  it('moves the escalation boundary on a day when the cost estimate falls in a leap year', () => {
    expect(modifiedCostEstimateDate('2024-06-30', '2026-03-31')).toBe('2026-04-01');
  });

  it('leaves it on the year end otherwise', () => {
    expect(modifiedCostEstimateDate('2025-06-30', '2026-03-31')).toBe('2026-03-31');
  });

  it('is keyed on the leap year, not the day of the month — 1900 is not a leap year', () => {
    expect(modifiedCostEstimateDate('1900-06-30', '2026-03-31')).toBe('2026-03-31');
    expect(modifiedCostEstimateDate('2000-06-30', '2026-03-31')).toBe('2026-04-01');
  });

  it('never disturbs the discount term', () => {
    const leap = recalculate(row({ costEstimateDate: '2024-06-30' }), assumptions, curve);
    const not = recalculate(row({ costEstimateDate: '2025-06-30' }), assumptions, curve);
    expect(leap.leap).toBe(true);
    expect(not.leap).toBe(false);
    // The §9.2 assertion that holds unconditionally: discounting runs from the
    // year end itself, so the shift cannot reach tD.
    expect(leap.tD).toBe(not.tD);
  });

  /**
   * The shift moves the escalation leg by a day *on the calendar* but not
   * always *on the 30/360 grid*, because 30/360 folds a 31st itself.
   *
   * Against a 31 March year end and a 31 January settlement the two cancel
   * exactly — the unshifted leg folds 31→30 at both ends and loses the same day
   * the shift would have added — so a leap-year cost estimate prices identically
   * to a non-leap one. Move the settlement off a 31st and the fold no longer
   * applies, and the shift lands as its rationale describes.
   *
   * This is the §9.2 divergence recorded in the project README: the shift is
   * keyed on the leap year rather than on the day of the month, so it corrects
   * the 30/360 mismatch for some date pairs and not others. Pinned as it
   * behaves, not as the spec wishes it behaved.
   */
  it('moves the escalation leg only when the day count has not already folded the day away', () => {
    const cancelled = {
      leap: recalculate(row({ costEstimateDate: '2024-06-30' }), assumptions, curve),
      not: recalculate(row({ costEstimateDate: '2025-06-30' }), assumptions, curve),
    };
    // 31 Mar → 31 Jan folds to 30 → 30; 1 Apr → 31 Jan does not fold. Both 3900.
    expect(cancelled.not.t2).toBeCloseTo(3900 / 360, 12);
    expect(cancelled.leap.t2).toBeCloseTo(3900 / 360, 12);

    const lands = {
      leap: recalculate(row({ costEstimateDate: '2024-06-30', settlementDate: '2037-01-15' }), assumptions, curve),
      not: recalculate(row({ costEstimateDate: '2025-06-30', settlementDate: '2037-01-15' }), assumptions, curve),
    };
    expect(lands.not.t2 - lands.leap.t2).toBeCloseTo(1 / 360, 12);
  });
});

describe('the chain — §3', () => {
  const k = recalculate(row(), assumptions, curve);

  it('reads the discount rate off the curve at the rounded term', () => {
    // 2026-03-31 → 2037-01-31 is 3900/360 = 10.8333 yrs, so term 11.
    expect(k.tD).toBeCloseTo(3900 / 360, 12);
    expect(k.curveTerm).toBe(11);
    expect(k.rate).toBeCloseTo(0.0337203, 12);
    expect(k.overridden).toBe(false);
  });

  it('escalates to the year end, escalates to settlement, then discounts back', () => {
    // t1 = DAYS360(1992-12-23, 2026-03-31)/360: 34*360 - 9*30 + (31-23) = 11978
    expect(k.t1).toBeCloseTo(11978 / 360, 12);
    expect(k.cce).toBeCloseTo(19546595.86 * Math.pow(1.02, 11978 / 360), 6);
    expect(k.fv).toBeCloseTo(k.cce * Math.pow(1.02, k.t2), 6);
    expect(k.pv).toBeCloseTo(k.fv / Math.pow(1.0337203, k.tD), 6);
  });

  it('the cost estimate is not escalated twice — cce is the first leg alone', () => {
    expect(k.cce).toBeLessThan(k.fv);
    expect(k.fv / k.cce).toBeCloseTo(Math.pow(1.02, k.t2), 12);
  });

  it('an override replaces the curve lookup and says so', () => {
    const over = recalculate(row({ rateOverride: 0.05 }), assumptions, curve);
    expect(over.rate).toBe(0.05);
    expect(over.overridden).toBe(true);
    // The curve term is still computed — the override is a rate, not a term.
    expect(over.curveTerm).toBe(11);
  });

  it('an override of nil is a real rate, not an absent one', () => {
    const zero = recalculate(row({ rateOverride: 0 }), assumptions, curve);
    expect(zero.overridden).toBe(true);
    expect(zero.pv).toBeCloseTo(zero.fv, 6);
  });

  it('a settlement date on the year end prices at cost, undiscounted', () => {
    const now = recalculate(
      row({ costEstimateDate: '2026-03-31', settlementDate: '2026-03-31' }),
      assumptions,
      curve,
    );
    expect(now.tD).toBe(0);
    expect(now.pv).toBeCloseTo(19546595.86, 6);
  });

  it('a malformed date does not produce NaN — dates.ts is total', () => {
    const bad = recalculate(row({ settlementDate: '2037-13-99' }), assumptions, curve);
    expect(Number.isFinite(bad.pv)).toBe(true);
  });
});

describe('the source comparison', () => {
  it('needs both figures before a row joins the tested population', () => {
    expect(sourceFigures(row({ sourceFv: 100, sourcePv: 50 })).has).toBe(true);
    expect(sourceFigures(row({ sourceFv: 100, sourcePv: null })).has).toBe(false);
    expect(sourceFigures(row({ sourceFv: null, sourcePv: 50 })).has).toBe(false);
    expect(sourceFigures(row()).has).toBe(false);
  });
});

describe('the materiality test', () => {
  const m = { usd: 1000, pct: 0.1 };

  it('breaches on the absolute threshold', () => {
    expect(varianceFlag(1000.01, 100_000_000, m)).toBe('VARIANCE');
    expect(varianceFlag(1000, 100_000_000, m)).toBe('PASS');
  });

  it('breaches on the relative threshold even when the absolute passes', () => {
    // 900 on a base of 500,000 is 0.18% — inside $1,000, outside 0.1%.
    expect(varianceFlag(900, 500_000, m)).toBe('VARIANCE');
  });

  it('rounds to the cent first, so float noise is not a variance', () => {
    expect(varianceFlag(0.0000001, 1_000_000, { usd: 0, pct: 0 })).toBe('PASS');
  });

  it('nil thresholds flag every difference that is not an exact match', () => {
    expect(varianceFlag(0.01, 1_000_000, { usd: 0, pct: 0 })).toBe('VARIANCE');
    expect(varianceFlag(0, 1_000_000, { usd: 0, pct: 0 })).toBe('PASS');
  });

  it('a nil base skips the relative test rather than dividing by zero', () => {
    expect(varianceFlag(500, 0, m)).toBe('PASS');
    expect(varianceFlag(1500, 0, m)).toBe('VARIANCE');
  });

  it('is symmetric — an overstatement and an understatement are the same size', () => {
    expect(varianceFlag(-1500, 1_000_000, m)).toBe(varianceFlag(1500, 1_000_000, m));
  });
});

describe('the variance bridge', () => {
  const compared = row({ sourceFv: 46815157.32, sourcePv: 32685377.12 });

  it('walks recalculated PV to reported PV with no residual', () => {
    const b = recalcBridge(compared, assumptions, curve);
    const walked = b.start + b.steps.reduce((s, x) => s + x.amount, 0);
    expect(walked).toBeCloseTo(b.end, 6);
  });

  it('starts at the recalculated PV', () => {
    const b = recalcBridge(compared, assumptions, curve);
    expect(b.start).toBeCloseTo(recalculate(compared, assumptions, curve).pv, 6);
  });

  it('back-solves the rates the source system must have used', () => {
    const b = recalcBridge(compared, assumptions, curve);
    // Reported cost → reported FV over the escalation term, and reported FV →
    // reported PV over the discount term, both by construction.
    expect(compared.cost * Math.pow(1 + b.implied.inflation, b.implied.tE)).toBeCloseTo(46815157.32, 4);
    expect(46815157.32 / Math.pow(1 + b.implied.rate, b.implied.tD)).toBeCloseTo(32685377.12, 4);
  });

  it('reads nil steps when the source agrees exactly', () => {
    const k = recalculate(row(), assumptions, curve);
    const agreeing = row({ sourceFv: k.fv, sourcePv: k.pv });
    const b = recalcBridge(agreeing, assumptions, curve);
    for (const step of b.steps) expect(step.amount).toBeCloseTo(0, 6);
  });

  it('reads nil rather than NaN when there is nothing to bridge', () => {
    const b = recalcBridge(row(), assumptions, curve);
    expect(b.implied.inflation).toBe(0);
    expect(b.implied.rate).toBe(0);
    for (const step of b.steps) expect(Number.isFinite(step.amount)).toBe(true);
  });
});

describe('the accretion schedule', () => {
  const sch = accretionSchedule(row(), assumptions, curve);

  it('unwinds the discount from the recalculated PV to the FV at settlement', () => {
    const k = recalculate(row(), assumptions, curve);
    expect(sch.periods[0].opening).toBeCloseTo(k.pv, 6);
    expect(sch.periods[sch.periods.length - 1].closing).toBeCloseTo(k.fv, 4);
    expect(sch.total).toBeCloseTo(k.fv - k.pv, 4);
  });

  it('runs to settlement, then stops', () => {
    expect(sch.periods[sch.periods.length - 1].to).toBe('2037-01-31');
    expect(sch.truncated).toBe(false);
  });

  it('each period opens where the last one closed', () => {
    for (let i = 1; i < sch.periods.length; i++) {
      expect(sch.periods[i].opening).toBeCloseTo(sch.periods[i - 1].closing, 9);
    }
  });

  it('an obligation already settled has no schedule at all', () => {
    const past = accretionSchedule(row({ settlementDate: '2020-01-01' }), assumptions, curve);
    expect(past.periods).toEqual([]);
    expect(past.total).toBe(0);
  });
});
