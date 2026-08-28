/** ENGINE-SPEC §9.5 — curve edges. */

import { describe, expect, it } from 'vitest';
import { Curve, curveRateDetail, curveTermOf } from '../curve';
import { linearCurve, yearCurve } from './fixtures';

const empty: Curve = { ...yearCurve, id: 'c-empty', points: [] };

describe('curve lookup — ENGINE-SPEC §5, §9.5', () => {
  it('below the first point, the first point rate applies', () => {
    const r = curveRateDetail(yearCurve, 0.25);
    expect(r.rate).toBeCloseTo(0.0400, 12);
    expect(r.basis).toBe('below-first');
    expect(r.beyond).toBe(false);
  });

  it('exactly on a point returns that point', () => {
    const r = curveRateDetail(yearCurve, 5);
    expect(r.rate).toBeCloseTo(0.0440, 12);
    expect(r.basis).toBe('exact');
  });

  it('step takes the first point at or beyond the term', () => {
    // Between 3 (4.20%) and 5 (4.40%) — step reaches for 5.
    expect(curveRateDetail(yearCurve, 4).rate).toBeCloseTo(0.0440, 12);
    expect(curveRateDetail(yearCurve, 4).basis).toBe('step');
  });

  it('linear draws a straight line between the bracketing pair', () => {
    const r = curveRateDetail(linearCurve, 4);
    // Halfway between 3y 4.20% and 5y 4.40%.
    expect(r.rate).toBeCloseTo(0.0430, 12);
    expect(r.basis).toBe('linear');
  });

  describe('beyond the last point, the extrapolation policy applies and is stamped', () => {
    const at = (extrapolation: Curve['extrapolation']) =>
      curveRateDetail({ ...yearCurve, extrapolation }, 15);

    it('flat-last holds the closing rate', () => {
      const r = at('flat-last');
      expect(r.rate).toBeCloseTo(0.0470, 12);
      expect(r.basis).toBe('flat-last');
      expect(r.beyond).toBe(true);
    });

    it('linear continues the slope of the closing pair', () => {
      const r = at('linear');
      // 7y 4.55% → 10y 4.70% is +0.05%/yr; five years past 10y adds 0.25%.
      expect(r.rate).toBeCloseTo(0.0495, 12);
      expect(r.basis).toBe('linear');
      expect(r.beyond).toBe(true);
    });

    it('log-linear continues the slope through the logs', () => {
      const r = at('log-linear');
      const slope = (Math.log(0.0470) - Math.log(0.0455)) / 3;
      expect(r.rate).toBeCloseTo(Math.exp(Math.log(0.0470) + slope * 5), 12);
      expect(r.basis).toBe('log-linear');
      expect(r.beyond).toBe(true);
    });
  });

  it('the term convention flags beyond so the policy can be disclosed', () => {
    const t = curveTermOf(yearCurve, 12.3, 'Round up to whole year (SAP)');
    expect(t.term).toBe(13);
    expect(t.capped).toBe(10);
    expect(t.beyond).toBe(true);
  });

  it('an empty curve returns nil rather than throwing — ENGINE-SPEC §9.9', () => {
    expect(() => curveRateDetail(empty, 5)).not.toThrow();
    const r = curveRateDetail(empty, 5);
    expect(r.rate).toBe(0);
    expect(r.basis).toBe('empty-curve');
  });

  it('points pasted out of order are sorted before lookup', () => {
    const shuffled: Curve = { ...yearCurve, points: [...yearCurve.points].reverse() };
    expect(curveRateDetail(shuffled, 5).rate).toBeCloseTo(0.0440, 12);
    expect(curveRateDetail(shuffled, 0.5).basis).toBe('below-first');
  });
});
