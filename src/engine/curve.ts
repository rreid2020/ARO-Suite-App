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

/** ENGINE-SPEC §4. The product default is the first option; tenants may choose another. */
export type TermConvention =
  | 'Round up to whole year (SAP)'
  | 'Round up to the next curve point'
  | 'Exact fractional years';

export const TERM_CONVENTIONS: TermConvention[] = [
  'Round up to whole year (SAP)',
  'Round up to the next curve point',
  'Exact fractional years',
];

/** The product default term convention. */
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
  /** Published tables can be locked so points cannot be rewritten. Copies start unlocked. */
  locked?: boolean;
  points: CurvePoint[];
}

/** Label for assignment and revaluation pickers — name, currency and as-at must all be visible. */
export function curveOptionLabel(curve: Pick<Curve, 'name' | 'currency' | 'asAt' | 'isDraft'>): string {
  const asAt = curve.asAt ? `, as at ${curve.asAt}` : '';
  const draft = curve.isDraft ? ' — draft' : '';
  return `${curve.name} (${curve.currency}${asAt})${draft}`;
}

/** A published table the engine can look a rate up from. Drafts and empty shells are not. */
export function isPublishedCurve(curve: Pick<Curve, 'points' | 'isDraft'> | undefined | null): boolean {
  return Boolean(curve && !curve.isDraft && (curve.points?.length ?? 0) > 0);
}

/** True when two tables still hold the same term/rate pairs — a copy that has not yet been updated. */
export function pointsMatch(a: Pick<Curve, 'points'>, b: Pick<Curve, 'points'>): boolean {
  if (!a.points.length || a.points.length !== b.points.length) return false;
  const other = new Map(b.points.map((p) => [p.term, p.rate]));
  return a.points.every((p) => other.get(p.term) === p.rate);
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

export type CurveSourceRole = 'source' | 'bracket';

export interface CurveSource {
  point: CurvePoint;
  role: CurveSourceRole;
}

/**
 * The published tenors that produced `curveRateDetail(curve, term)`.
 * Exact, step, below-first and flat-last yield one source row. Linear
 * interpolation and sloping extrapolation also return the other bracketing tenor.
 */
export function curveSourcePoints(curve: Curve, term: number): CurveSource[] {
  const pts = sortedPoints(curve);
  if (!pts.length) return [];

  const first = pts[0];
  const last = pts[pts.length - 1];

  if (term <= first.term) return [{ point: first, role: 'source' }];

  if (term > last.term) {
    if (pts.length < 2 || curve.extrapolation === 'flat-last') {
      return [{ point: last, role: 'source' }];
    }
    return [
      { point: pts[pts.length - 2], role: 'bracket' },
      { point: last, role: 'source' },
    ];
  }

  const exact = pts.find((p) => p.term === term);
  if (exact) return [{ point: exact, role: 'source' }];

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
    return [
      { point: lo, role: 'source' },
      { point: hi, role: 'source' },
    ];
  }

  const hit = pts.find((p) => p.term >= term) ?? last;
  return [{ point: hit, role: 'source' }];
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
