import { Curve } from '../curve';
import { Assumptions, Obligation } from '../derive';

/** A published curve at whole-year granularity. */
export const yearCurve: Curve = {
  id: 'c-year',
  name: 'USD govt zero — annual',
  currency: 'USD',
  source: 'Test fixture',
  basis: 'Zero-coupon, annual compounding',
  interpolation: 'step',
  extrapolation: 'flat-last',
  asAt: '2025-12-31',
  points: [
    { term: 1, rate: 0.0400 },
    { term: 2, rate: 0.0410 },
    { term: 3, rate: 0.0420 },
    { term: 5, rate: 0.0440 },
    { term: 7, rate: 0.0455 },
    { term: 10, rate: 0.0470 },
  ],
};

/**
 * The Bank of Canada shape — quarter-year points, which ENGINE-SPEC §5 calls a
 * first-class case rather than an awkward one.
 */
export const quarterCurve: Curve = {
  id: 'c-quarter',
  name: 'CAD bond yield curve — quarterly',
  currency: 'CAD',
  source: 'Bank of Canada (fixture)',
  basis: 'Zero-coupon, semi-annual compounding',
  interpolation: 'step',
  extrapolation: 'flat-last',
  asAt: '2025-12-31',
  points: Array.from({ length: 120 }, (_, i) => ({
    term: (i + 1) * 0.25,
    rate: 0.030 + (i / 119) * 0.020,
  })),
};

export const linearCurve: Curve = { ...yearCurve, id: 'c-lin', interpolation: 'linear' };

export function assumptions(over: Partial<Assumptions> = {}): Assumptions {
  return {
    inflation: 0.025,
    contingency: 0.10,
    termConvention: 'Round up to whole year (SAP)',
    fyEnd: '2025-12-31',
    ...over,
  };
}

let seq = 0;
export function obligation(over: Partial<Obligation> = {}): Obligation {
  seq += 1;
  return {
    id: `o-${seq}`,
    ref: `ARO-${String(seq).padStart(4, '0')}`,
    description: 'Wellhead abandonment',
    costEstimateDate: '2025-06-30',
    settlementDate: '2032-06-30',
    lines: [
      { id: 'l1', description: 'Rig days', qty: 12, rate: 45_000 },
      { id: 'l2', description: 'Cement', qty: 300, rate: 210 },
    ],
    adj: [],
    ...over,
  };
}

/** Deterministic PRNG so the random-population tests are reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
