/**
 * Mode 1 — recalculation against a source system.
 *
 * BUILD-SEQUENCE Phase 2. This is the chain from `ARO Recalculation.dc.html`:
 * a flat register of extract rows (REP04 cost estimates, REP06 settlement dates
 * and SAP FV/PV) recalculated independently and compared against the figures
 * the source system reported.
 *
 * It is a *different shape* from `derive.ts`, not a different calculation.
 * `derive()` measures an obligation the app owns — cost lines, revisions,
 * layers, a remeasurement bridge against the prior year. Here there is no
 * build-up and no prior year: one cost estimate, one settlement date, one
 * escalation, one discount, and a variance against a number somebody else
 * produced. The arithmetic below is the same §3 chain and reuses the same day
 * count; only the inputs and the comparison are Mode 1's own.
 *
 * Pure and dependency-free, like the rest of `src/engine/`.
 */

import { days360, isLeapYear, nextDay, parseISO, term360, toISO, yearOf } from './dates';

/* ══ The curve ═════════════════════════════════════════════════════════ */

/**
 * The recalculation curve: whole-year terms as the client publishes them.
 *
 * `rate` is a **decimal** (0.0337203 for 3.37203%), matching `CurvePoint` in
 * `curve.ts`. The extracts quote percent; `normaliseCurveRates` converts on the
 * way in so the engine only ever sees one convention.
 */
export interface RecalcCurvePoint {
  term: number;
  rate: number;
}

export interface RecalcCurve {
  /** The vintage the client's file states, e.g. "31.03.2026". Provenance only. */
  asAt: string;
  points: RecalcCurvePoint[];
}

/** Points sorted by term, defensively — an imported table may arrive in any order. */
export function sortedCurve(curve: RecalcCurve): RecalcCurvePoint[] {
  return [...(curve.points ?? [])].sort((a, b) => a.term - b.term);
}

/** The last published term. 0 for an empty table. */
export function curveMaxTerm(curve: RecalcCurve): number {
  const pts = sortedCurve(curve);
  return pts.length ? pts[pts.length - 1].term : 0;
}

export interface RecalcTermLookup {
  /** The term the SAP convention produced, before the cap. */
  raw: number;
  /** The term actually read off the curve. */
  term: number;
  /** True when `raw` runs past the last published point. */
  beyond: boolean;
}

/**
 * The SAP term convention — ENGINE-SPEC §4 as Mode 1 applies it.
 *
 * The whole-year term off the FY year end, **rounded up**: SAP is the source of
 * truth and takes the next full year, so 23.41 years reads term 24. Two guards
 * come with it, both from the prototype and both load-bearing:
 *
 * - `Math.max(1, …)` — an obligation settling on or before the year end has a
 *   term of nil or less. Term 0 would fall off the bottom of the table and read
 *   the 1-year rate anyway; flooring at 1 says so out loud instead.
 * - the 1e-9 tolerance — an exact whole year must not round up to the next one
 *   on a floating-point crumb.
 *
 * This deliberately does *not* call `curveTermOf` from `curve.ts`. That function
 * serves Mode 2, offers three conventions, and carries neither guard; its
 * behaviour is pinned by existing tests. Mode 1 has one convention and needs
 * both guards, so it keeps its own three lines rather than adding flags to a
 * function the rest of the engine depends on.
 */
export function recalcCurveTerm(curve: RecalcCurve, tD: number): RecalcTermLookup {
  const raw = Math.max(1, Math.ceil(tD - 1e-9));
  const max = curveMaxTerm(curve);
  if (!max) return { raw, term: raw, beyond: false };
  return { raw, term: Math.min(raw, max), beyond: raw > max };
}

/**
 * The rate at a whole-year term. The curve is published at whole years, so this
 * is an exact hit; past the end of the table the last rate is applied flat, and
 * the row that used it is marked `beyond` so the policy can be disclosed
 * (INVARIANTS §6) rather than silently swallowed.
 */
export function recalcCurveRate(curve: RecalcCurve, term: number): number {
  const pts = sortedCurve(curve);
  if (!pts.length) return 0;
  const hit = pts.find((p) => p.term === term);
  return hit ? hit.rate : pts[pts.length - 1].rate;
}

/**
 * A table quoted in percent (3.37) rather than decimals (0.0337).
 *
 * The heuristic is the prototype's, inverted to this module's convention: if any
 * rate is above 1 the file is quoting percent. A curve of genuine rates above
 * 100% is not a thing, and one below 1% across every tenor would already be
 * indistinguishable from decimals to a human reader.
 */
export function normaliseCurveRates(points: RecalcCurvePoint[]): RecalcCurvePoint[] {
  const max = points.reduce((n, p) => Math.max(n, Math.abs(p.rate)), 0);
  return max > 1 ? points.map((p) => ({ term: p.term, rate: p.rate / 100 })) : points;
}

/* ══ The register row ══════════════════════════════════════════════════ */

/**
 * One obligation as the extracts describe it. Money is held as a number —
 * the prototype held display strings and stripped the formatting on every read;
 * the port formats at the UI edge instead.
 */
export interface RecalcRow {
  /** ARO obligation no. — the key both extracts are matched on. */
  id: string;
  /** Cost estimate per REP04. */
  cost: number;
  /** `pk` — the cost estimate date per REP04. */
  costEstimateDate: string;
  /** `st` — the settlement (current end) date per REP06. */
  settlementDate: string;
  /** Manual discount rate override, decimal. Null when the curve applies. */
  rateOverride?: number | null;
  /** FV of obligation per REP06. Null when SAP reported none. */
  sourceFv?: number | null;
  /** PV of obligation per REP06. Null when SAP reported none. */
  sourcePv?: number | null;
}

export interface RecalcAssumptions {
  /** The reporting unit's financial year end — the valuation date. */
  fyEnd: string;
  /** Inflation / escalation, decimal. One rate, all obligations. */
  inflation: number;
}

export interface RecalcResult {
  /** Escalation leg 1: cost estimate date → FY year end. */
  t1: number;
  /** Escalation leg 2: modified cost estimate date → settlement. */
  t2: number;
  /** Discount term: FY year end → settlement. Unaffected by the leap-year shift. */
  tD: number;
  /** The modified cost estimate date — the escalation boundary. */
  mcd: string;
  /** True when the leap-year shift moved it. */
  leap: boolean;
  /** Cost estimate escalated to the FY year end. */
  cce: number;
  /** Future value at settlement. */
  fv: number;
  /** Present value at the FY year end — the recalculated provision. */
  pv: number;
  /** The rate applied, decimal. */
  rate: number;
  /** True when the rate came from an override rather than the curve. */
  overridden: boolean;
  /** The term the curve was read at, after the cap. */
  curveTerm: number;
  /** The term before the cap. */
  rawTerm: number;
  /** True when the term ran past the end of the curve. */
  beyond: boolean;
}

/**
 * The modified cost estimate date — ENGINE-SPEC §3, the leap-year shift.
 *
 * A cost estimate dated in a leap year carries one day more than the 30/360
 * grid allows, so the Master Sheet moves the escalation boundary on by a day.
 * Discounting still runs from the year end itself, so `tD` is unaffected.
 *
 * Reproduced exactly, including the part that looks wrong: the shift is keyed
 * on the leap year rather than on the day of the month, so the two escalation
 * legs sum to the implied term for some date combinations and miss it by ±1/360
 * for others. That is a conversation with whoever owns the Master Sheet, not a
 * code change — see the project README, "Findings".
 */
export function modifiedCostEstimateDate(costEstimateDate: string, fyEnd: string): string {
  const y = yearOf(costEstimateDate);
  return y !== null && isLeapYear(y) ? nextDay(fyEnd) : fyEnd;
}

/** The rate in force: the override when one is entered, else the curve. */
export function recalcRate(
  row: RecalcRow,
  curve: RecalcCurve,
  tD: number,
): { rate: number; overridden: boolean; lookup: RecalcTermLookup } {
  const lookup = recalcCurveTerm(curve, tD);
  const override = row.rateOverride;
  if (override !== null && override !== undefined && Number.isFinite(override)) {
    return { rate: override, overridden: true, lookup };
  }
  return { rate: recalcCurveRate(curve, lookup.term), overridden: false, lookup };
}

/**
 * The chain — ENGINE-SPEC §3. Escalate the cost estimate to the FY year end,
 * escalate again to settlement, discount back. All terms on 30/360 US.
 */
export function recalculate(row: RecalcRow, a: RecalcAssumptions, curve: RecalcCurve): RecalcResult {
  const mcd = modifiedCostEstimateDate(row.costEstimateDate, a.fyEnd);
  const t1 = term360(row.costEstimateDate, a.fyEnd);
  const t2 = term360(mcd, row.settlementDate);
  const tD = term360(a.fyEnd, row.settlementDate);

  const { rate, overridden, lookup } = recalcRate(row, curve, tD);

  const i = 1 + a.inflation;
  const cce = row.cost * Math.pow(i, t1);
  const fv = cce * Math.pow(i, t2);
  const pv = fv / Math.pow(1 + rate, tD);

  return {
    t1,
    t2,
    tD,
    mcd,
    leap: mcd !== a.fyEnd,
    cce,
    fv,
    pv,
    rate,
    overridden,
    curveTerm: lookup.term,
    rawTerm: lookup.raw,
    beyond: lookup.beyond,
  };
}

/* ══ The comparison ════════════════════════════════════════════════════ */

export interface SourceFigures {
  fv: number;
  pv: number;
  cost: number;
  /** True when SAP reported both an FV and a PV — the row is in the tested population. */
  has: boolean;
}

/**
 * What the source system reported. A row is only comparable when *both* figures
 * are present and positive; one without the other cannot be bridged, so it
 * counts as no data rather than as a variance of the whole balance.
 */
export function sourceFigures(row: RecalcRow): SourceFigures {
  const fv = num(row.sourceFv);
  const pv = num(row.sourcePv);
  return { fv, pv, cost: num(row.cost), has: fv > 0 && pv > 0 };
}

export interface Materiality {
  /** Absolute threshold, currency units. */
  usd: number;
  /** Relative threshold, **percent** — 0.1 means one tenth of one percent. */
  pct: number;
}

export type VarianceFlag = 'PASS' | 'VARIANCE';

/**
 * The materiality test — tiered, absolute *or* relative, either one breaches.
 *
 * The difference is rounded to the cent before it is measured, so float noise
 * cannot flag a nil variance when the thresholds are set to zero. A zero
 * threshold is a real setting, not an unset one: it flags every difference that
 * is not an exact match.
 */
export function varianceFlag(delta: number, base: number, m: Materiality): VarianceFlag {
  const v = Math.abs(Math.round(delta * 100) / 100);
  const relative = base ? (v / Math.abs(base)) * 100 > m.pct : false;
  return v > m.usd || relative ? 'VARIANCE' : 'PASS';
}

/* ══ The variance bridge ═══════════════════════════════════════════════ */

export interface BridgeStep {
  label: string;
  amount: number;
}

export interface RecalcBridge {
  steps: BridgeStep[];
  /** The recalculated PV — where the walk starts. */
  start: number;
  /** The reported PV — where it ends. */
  end: number;
  /** The rates back-solved out of the source system's own three figures. */
  implied: { inflation: number; rate: number; tE: number; tD: number };
}

/**
 * Why the two numbers differ, in two steps that sum to the variance exactly.
 *
 * SAP publishes three figures and none of its assumptions, so its rates are
 * back-solved over the recalculated terms: the escalation rate that turns its
 * cost estimate into its FV, and the discount rate that turns its FV into its
 * PV. Substituting them one at a time walks recalculated PV → reported PV with
 * no residual, and the steps are signed as the Master Sheet states the variance
 * (AM = AL − AI, SAP less re-calculated).
 *
 * A back-solved rate is an *implied* rate, not a discovered one: it absorbs
 * every difference in that leg, including a wrong cost estimate or a wrong
 * date. That is why the two steps are labelled by leg rather than by cause, and
 * why the FV variance is reported separately — an FV that does not agree points
 * at the cost estimate, the inflation rate or the dates, not at the discounting.
 */
export function recalcBridge(row: RecalcRow, a: RecalcAssumptions, curve: RecalcCurve): RecalcBridge {
  const k = recalculate(row, a, curve);
  const s = sourceFigures(row);
  const tE = k.t1 + k.t2;
  const tD = k.tD;

  const impliedInflation = s.cost > 0 && s.fv > 0 && tE > 0 ? Math.pow(s.fv / s.cost, 1 / tE) - 1 : 0;
  const impliedRate = s.pv > 0 && s.fv > 0 && tD > 0 ? Math.pow(s.fv / s.pv, 1 / tD) - 1 : 0;

  const pvAt = (inflation: number, rate: number) =>
    (s.cost * Math.pow(1 + inflation, tE)) / Math.pow(1 + rate, tD);

  const start = pvAt(a.inflation, k.rate);
  const afterInflation = pvAt(impliedInflation, k.rate);
  const afterRate = pvAt(impliedInflation, impliedRate);

  return {
    steps: [
      { label: 'Inflation / escalation', amount: afterInflation - start },
      { label: 'Discount rate', amount: afterRate - afterInflation },
    ],
    start,
    end: s.pv,
    implied: { inflation: impliedInflation, rate: impliedRate, tE, tD },
  };
}

/* ══ Accretion ═════════════════════════════════════════════════════════ */

export interface AccretionPeriod {
  /** The date the period closes. */
  to: string;
  opening: number;
  accretion: number;
  closing: number;
  /** Closing balance as a proportion of the FV at settlement, 0-1. */
  ofFv: number;
}

export interface AccretionSchedule {
  periods: AccretionPeriod[];
  /** Total unwinding from the FY year end to settlement. */
  total: number;
  /** True when the walk hit the 60-period cap before reaching settlement. */
  truncated: boolean;
}

/**
 * The unwinding of the discount, year by year, from the FY year end to
 * settlement. Presentational — nothing is posted from it in Mode 1; it is here
 * so a reviewer can see the discount unwind to the FV they are comparing.
 *
 * Capped at 60 periods: an obligation settling further out than that is
 * conceivable, but the cap is what keeps a malformed date from spinning the
 * loop, and `truncated` says when it bit.
 */
export function accretionSchedule(
  row: RecalcRow,
  a: RecalcAssumptions,
  curve: RecalcCurve,
): AccretionSchedule {
  const k = recalculate(row, a, curve);
  const periods: AccretionPeriod[] = [];
  let balance = k.pv;
  let cursor = a.fyEnd;
  let n = 0;

  for (; n < 60 && days360(cursor, row.settlementDate) > 0; n++) {
    let next = anniversaryOf(cursor);
    if (days360(next, row.settlementDate) < 0) next = row.settlementDate;
    const closing = balance * Math.pow(1 + k.rate, term360(cursor, next));
    periods.push({
      to: next,
      opening: balance,
      accretion: closing - balance,
      closing,
      ofFv: k.fv ? closing / k.fv : 0,
    });
    balance = closing;
    cursor = next;
  }

  return {
    periods,
    total: balance - k.pv,
    truncated: n >= 60 && days360(cursor, row.settlementDate) > 0,
  };
}

/**
 * The same day next year, with JavaScript's own overflow.
 *
 * `Date.setUTCFullYear` turns 29 Feb into 1 Mar of a non-leap year rather than
 * clamping to 28 Feb, and the prototype's schedule walks on that behaviour.
 * `addMonths` in `dates.ts` clamps instead, which is right for building a fiscal
 * calendar and wrong here, so this walk keeps its own three lines.
 */
function anniversaryOf(iso: string): string {
  const p = parseISO(iso);
  if (!p) return iso;
  const d = new Date(Date.UTC(p.y + 1, p.m - 1, p.d));
  return toISO({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}
