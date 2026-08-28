/**
 * Discount curve — ENGINE-SPEC §4 (term convention) and §5 (lookup).
 *
 * INVARIANTS §9: the discount rate is *looked up from the curve*, never entered
 * per obligation, and points live on the curve at the publisher's granularity —
 * the Bank of Canada 120-point quarter-year curve is a first-class case, not an
 * awkward one.
 */

/** Interpolation between published points. */
export type Interpolation = 'step' | 'linear';

/** What to do past the last published point. Stamped on every row that uses it. */
export type Extrapolation = 'flat-last' | 'linear' | 'log-linear';

/** ENGINE-SPEC §4. The default is the first and INVARIANTS §9 says never change it. */
export type TermConvention =
  | 'Round up to whole year (SAP)'
  | 'Round up to the next curve point'
  | 'Exact fractional years';

export const TERM_CONVENTIONS: TermConvention[] = [
  'Round up to whole year (SAP)',
  'Round up to the next curve point',
  'Exact fractional years',
];

/** INVARIANTS §9 — the default term convention. Never change it. */
export const DEFAULT_TERM_CONVENTION: TermConvention = 'Round up to whole year (SAP)';

export interface CurvePoint {
  /** Term in years, at the publisher's granularity (0.25, 0.5, … 30). */
  term: number;
  /** Rate as a decimal, e.g. 0.0432 for 4.32%. */
  rate: number;
}

export interface Curve {
  id: string;
  name: string;
  currency: string;
  /** Provenance — INVARIANTS §6. Where the points came from. */
  source: string;
  /** e.g. "Government bond zero-coupon, semi-annual compounding". */
  basis: string;
  interpolation: Interpolation;
  extrapolation: Extrapolation;
  asAt: string;
  isDraft?: boolean;
  points: CurvePoint[];
}

/** Points sorted by term, defensively — callers may paste them in any order. */
export function sortedPoints(curve: Curve): CurvePoint[] {
  return [...(curve.points ?? [])].sort((a, b) => a.term - b.term);
}

export function lastTerm(curve: Curve): number {
  const pts = sortedPoints(curve);
  return pts.length ? pts[pts.length - 1].term : 0;
}

export interface TermLookup {
  /** The term the convention produced. Not capped — see `beyond`. */
  term: number;
  /** The term actually used against the published points (capped at the last). */
  capped: number;
  /** True when the convention term runs past the last published point. */
  beyond: boolean;
  convention: TermConvention;
}

/**
 * ENGINE-SPEC §4 — turn a raw discount term into the term the curve is read at.
 *
 * `beyond` is carried on the row rather than silently swallowed so that the
 * extrapolation policy can be applied *and disclosed* (INVARIANTS §6).
 */
export function curveTermOf(
  curve: Curve,
  tD: number,
  convention: TermConvention = DEFAULT_TERM_CONVENTION,
): TermLookup {
  const pts = sortedPoints(curve);
  const last = pts.length ? pts[pts.length - 1].term : 0;
  let term: number;

  switch (convention) {
    case 'Round up to whole year (SAP)':
      term = Math.ceil(tD);
      break;
    case 'Round up to the next curve point': {
      const hit = pts.find((p) => p.term >= tD);
      term = hit ? hit.term : last;
      break;
    }
    case 'Exact fractional years':
    default:
      term = tD;
      break;
  }

  return {
    term,
    capped: pts.length ? Math.min(term, last) : term,
    beyond: pts.length > 0 && term > last,
    convention,
  };
}

export interface RateLookup {
  rate: number;
  /** Which rule produced the rate — stamped onto exports and the ladder. */
  basis: 'step' | 'linear' | 'below-first' | 'exact' | Extrapolation | 'empty-curve';
  beyond: boolean;
}

/**
 * ENGINE-SPEC §5 — read a rate off the curve at `term`.
 *
 * - Below the first point, the first point's rate applies.
 * - `step` takes the first point at or beyond the term (correct for a curve
 *   published as discrete tenors).
 * - `linear` draws a straight line between the bracketing pair.
 * - Beyond the last point the extrapolation policy applies and is stamped.
 */
export function curveRateDetail(curve: Curve, term: number): RateLookup {
  const pts = sortedPoints(curve);
  if (!pts.length) return { rate: 0, basis: 'empty-curve', beyond: false };

  const first = pts[0];
  const last = pts[pts.length - 1];

  if (term <= first.term) {
    return {
      rate: first.rate,
      basis: term === first.term ? 'exact' : 'below-first',
      beyond: false,
    };
  }

  if (term > last.term) {
    return { ...extrapolate(pts, term, curve.extrapolation), beyond: true };
  }

  const exact = pts.find((p) => p.term === term);
  if (exact) return { rate: exact.rate, basis: 'exact', beyond: false };

  if (curve.interpolation === 'linear') {
    let lo = first;
    let hi = last;
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i].term <= term && term <= pts[i + 1].term) {
        lo = pts[i];
        hi = pts[i + 1];
        break;
      }
    }
    const span = hi.term - lo.term;
    const rate = span === 0 ? lo.rate : lo.rate + ((term - lo.term) / span) * (hi.rate - lo.rate);
    return { rate, basis: 'linear', beyond: false };
  }

  // step — the first published point at or beyond the term
  const hit = pts.find((p) => p.term >= term) ?? last;
  return { rate: hit.rate, basis: 'step', beyond: false };
}

function extrapolate(
  pts: CurvePoint[],
  term: number,
  policy: Extrapolation,
): { rate: number; basis: Extrapolation } {
  const last = pts[pts.length - 1];
  if (pts.length < 2 || policy === 'flat-last') {
    return { rate: last.rate, basis: 'flat-last' };
  }
  const prev = pts[pts.length - 2];
  const span = last.term - prev.term;
  if (span === 0) return { rate: last.rate, basis: 'flat-last' };

  if (policy === 'log-linear') {
    // Straight line through the logs of the two closing points. Falls back to
    // the linear slope if either rate is non-positive, where the log is undefined.
    if (prev.rate > 0 && last.rate > 0) {
      const slope = (Math.log(last.rate) - Math.log(prev.rate)) / span;
      return { rate: Math.exp(Math.log(last.rate) + slope * (term - last.term)), basis: 'log-linear' };
    }
  }
  const slope = (last.rate - prev.rate) / span;
  return { rate: last.rate + slope * (term - last.term), basis: policy === 'log-linear' ? 'log-linear' : 'linear' };
}

/** Convenience wrapper when only the number is wanted. */
export function curveRate(curve: Curve, term: number): number {
  return curveRateDetail(curve, term).rate;
}
