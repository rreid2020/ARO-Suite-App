/** ENGINE-SPEC §9.6 — bridge sums, over random populations. */

import { describe, expect, it } from 'vitest';
import { derive, Obligation, Revision } from '../derive';
import { Curve } from '../curve';
import { assumptions, obligation, rng, yearCurve } from './fixtures';

/** The closing curve after a year-end revaluation moved rates up 60bp. */
const closingCurve: Curve = {
  ...yearCurve,
  id: 'c-closing',
  points: yearCurve.points.map((p) => ({ ...p, rate: p.rate + 0.006 })),
};

function population(seed: number, n: number): Obligation[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const adj: Revision[] = [];
    if (r() > 0.4) {
      adj.push({
        id: `c${i}`, kind: 'cost',
        amount: Math.round((r() - 0.3) * 400_000),
        date: '2025-06-30', reason: 'Scope change',
      });
    }
    if (r() > 0.5) {
      adj.push({
        id: `t${i}`, kind: 'term',
        to: `${2030 + Math.floor(r() * 8)}-06-30`,
        date: '2025-09-30', reason: 'Licence extension',
      });
    }
    return obligation({
      costEstimateDate: r() > 0.5 ? '2024-06-30' : '2025-03-31',
      settlementDate: `${2029 + Math.floor(r() * 6)}-12-31`,
      lines: [
        { id: 'l1', description: 'Rig days', qty: Math.ceil(r() * 30), rate: 45_000 },
        { id: 'l2', description: 'Cement', qty: Math.ceil(r() * 900), rate: 210 },
      ],
      adj,
    });
  });
}

describe('remeasurement bridge — ENGINE-SPEC §6, §9.6', () => {
  it('the four effects sum to the movement, with no residual, over 300 obligations', () => {
    const a = assumptions({ priorInflation: 0.020 });
    for (const o of population(20260828, 300)) {
      const d = derive(o, a, { curve: closingCurve, priorCurve: yearCurve });
      const sum =
        d.bridge.costEffect + d.bridge.timingEffect + d.bridge.rateEffect + d.bridge.inflEffect;
      // Floating point only — the identity is exact by construction.
      expect(sum).toBeCloseTo(d.bridge.movement, 8);
      expect(d.pv).toBeCloseTo(d.bridge.pvBase + d.bridge.movement, 8);
    }
  });

  it('each leg moves exactly one thing', () => {
    const o = obligation({
      costEstimateDate: '2025-03-31',
      settlementDate: '2032-12-31',
      adj: [
        { id: 'a1', kind: 'cost', amount: 250_000, date: '2025-06-30', reason: 'Scope increase' },
        { id: 'a2', kind: 'term', to: '2034-12-31', date: '2025-09-30', reason: 'Licence extension' },
      ],
    });
    const d = derive(o, assumptions({ priorInflation: 0.020 }), {
      curve: closingCurve,
      priorCurve: yearCurve,
    });

    expect(d.bridge.costEffect).toBeGreaterThan(0);   // cost went up
    expect(d.bridge.timingEffect).toBeLessThan(0);    // settlement pushed out, discounted further
    expect(d.bridge.rateEffect).toBeLessThan(0);      // rates up 60bp, PV down
    expect(d.bridge.inflEffect).toBeGreaterThan(0);   // inflation 2.0% → 2.5%
  });

  /**
   * ENGINE-SPEC §6: before a revaluation has run, prior equals current, so the
   * rate and inflation legs read nil *because nothing moved* — not because they
   * are unimplemented. This test is the difference between those two claims.
   */
  it('reads nil on the rate and inflation legs before a revaluation has run', () => {
    const o = obligation({
      adj: [{ id: 'a1', kind: 'cost', amount: 90_000, date: '2025-06-30', reason: 'Scope increase' }],
    });
    const d = derive(o, assumptions(), { curve: yearCurve }); // no priorCurve, no priorInflation
    expect(d.bridge.rateEffect).toBe(0);
    expect(d.bridge.inflEffect).toBe(0);
    expect(d.bridge.costEffect).toBeGreaterThan(0);
    expect(d.bridge.costEffect).toBeCloseTo(d.bridge.movement, 8);
  });

  it('an obligation with no revisions and no revaluation has a nil bridge', () => {
    const d = derive(obligation(), assumptions(), { curve: yearCurve });
    expect(d.bridge.movement).toBeCloseTo(0, 10);
    expect(d.pv).toBeCloseTo(d.bridge.pvBase, 10);
  });
});
