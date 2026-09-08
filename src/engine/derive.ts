/**
 * The measurement chain — ENGINE-SPEC §2, §3 and §6.
 *
 * This is the part the handoff says to port exactly, "including the parts that
 * look wrong (the leap-year shift, the SAP term rounding). They are deliberate."
 */

import { isLeapYear, isThirty360, nextDay, termYears, yearOf, cmpDate, DayCount, DEFAULT_DAY_COUNT } from './dates';
import {
  Curve,
  TermConvention,
  curveTermOf,
  curveRateDetail,
} from './curve';
import {
  FrameworkPolicy,
  LayerPolicy,
  MeasurementLayer,
  frameworkPolicy,
  layerRateLookup,
  syncLayers,
  unitDiscounts,
  unitEscalates,
  weightedLayerRate,
} from './framework';

/** ENGINE-SPEC §2 — the cost build-up. Direct cost = Σ qty × rate. */
export interface CostLine {
  id: string;
  description: string;
  qty: number;
  rate: number;
  /** Provenance — INVARIANTS §6. Where this line came from. */
  source?: string;
}

/** A recorded revision. Cost revisions are entered *gross of contingency*. */
export interface Revision {
  id: string;
  kind: 'cost' | 'term';
  /** Set when kind is 'cost'. Gross of contingency, added to direct cost. */
  amount?: number;
  /** Set when kind is 'term'. The new expected settlement date. */
  to?: string;
  /** The date the revision arose — orders the revisions and dates the layer. */
  date: string;
  reason: string;
  evidence?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface Obligation {
  id: string;
  ref: string;
  description: string;
  /** `pk` in the spec — the price date of the cost build-up. */
  costEstimateDate: string;
  /** `st` in the spec — overridden by the latest timing revision. */
  settlementDate: string;
  lines: CostLine[];
  adj: Revision[];
  /** Stored when the framework locks a rate per layer. Absent under IFRS/PSAS. */
  layers?: MeasurementLayer[];
  /** Anything else the register carries. Not read by the engine. */
  [k: string]: unknown;
}

/** Per reporting unit — ENGINE-SPEC §2. */
export interface Assumptions {
  /** Inflation / escalation as a decimal, e.g. 0.025. */
  inflation: number;
  /** Contingency as a decimal of direct cost. Applied once, before escalation. */
  contingency: number;
  termConvention: TermConvention;
  /** Day count used to measure terms. Default 30/360 US. */
  dayCount?: DayCount;
  /** The reporting unit's financial year end, ISO. */
  fyEnd: string;
  /** Written by the year-end revaluation — ENGINE-SPEC §7. */
  priorInflation?: number;
  materialityUsd?: number;
  materialityPct?: number;
}

/** The four basis tags shown against every monetary figure (SCREENS.md). */
export type BasisTag = 'CURRENT' | 'ESCALATED' | 'FV@SETTLE' | 'PV@FY-END';

export interface PriceInputs {
  /** Direct cost, gross of contingency. */
  direct: number;
  contingency: number;
  /** `pk` — cost estimate date. */
  costEstimateDate: string;
  /** `st` — settlement date. */
  settlementDate: string;
  fyEnd: string;
  inflation: number;
  curve: Curve;
  termConvention: TermConvention;
  dayCount?: DayCount;
  /** Locked layer rate — skips the curve lookup for the PV step. */
  rate?: number;
  /** PSAS may dispense with discounting. Default true. */
  discount?: boolean;
  /** PSAS undiscounted: inflation drops out with the discount. Default true. */
  escalate?: boolean;
}

export interface Priced {
  direct: number;
  /** Direct × (1 + contingency), at CURRENT prices, at the cost estimate date. */
  cost: number;
  /** True when the cost estimate date falls in a leap year — ENGINE-SPEC §3. */
  leap: boolean;
  /** Modified cost estimate date: the leap-year shift. */
  mcd: string;
  /** Escalation leg 1: cost estimate date to FY end. */
  t1: number;
  /** Escalation leg 2: modified cost estimate date to settlement. */
  t2: number;
  /** Discount term: FY end to settlement. Unaffected by the leap-year shift. */
  tD: number;
  /** Cost escalated to the FY end. */
  cce: number;
  /** Future value at settlement. */
  fv: number;
  /** The term the curve was read at, after the term convention. */
  curveTerm: number;
  /** True when the term ran past the last published point. */
  beyond: boolean;
  /** How the rate was obtained — step, linear, flat-last and so on. */
  rateBasis: string;
  rate: number;
  /** Present value at the FY end. The reported provision. */
  pv: number;
}

/**
 * ENGINE-SPEC §3 — the chain, in order. One obligation, priced once, under one
 * set of assumptions. The bridge in §6 is this same function called five times.
 */
export function price(i: PriceInputs): Priced {
  const cost = i.direct * (1 + i.contingency);

  // The leap-year shift is deliberate. When the cost estimate date falls in a
  // leap year the second escalation leg starts the day *after* the year end, so
  // that the two legs sum to the implied term under 30/360. It matches a manual
  // adjustment in the client's Master Sheet. Discounting still runs from the
  // year end, so tD is unaffected. Do not "fix" it.
  const dayCount = i.dayCount ?? DEFAULT_DAY_COUNT;
  const y = yearOf(i.costEstimateDate);
  const leap = isThirty360(dayCount) && y !== null && isLeapYear(y);
  const mcd = leap ? nextDay(i.fyEnd) : i.fyEnd;

  const t1 = termYears(i.costEstimateDate, i.fyEnd, dayCount);
  const t2 = termYears(mcd, i.settlementDate, dayCount);
  const tD = termYears(i.fyEnd, i.settlementDate, dayCount);

  const escalate = i.escalate !== false;
  const cce = escalate ? cost * Math.pow(1 + i.inflation, t1) : cost;
  const fv = escalate ? cce * Math.pow(1 + i.inflation, t2) : cce;

  const lookup = curveTermOf(i.curve, tD, i.termConvention);
  const rateDetail = curveRateDetail(i.curve, lookup.term);
  const rate = i.rate ?? rateDetail.rate;
  const discount = i.discount !== false;

  const pv = discount && tD > 0 ? fv / Math.pow(1 + rate, tD) : fv;

  return {
    direct: i.direct,
    cost,
    leap,
    mcd,
    t1,
    t2,
    tD,
    cce,
    fv,
    curveTerm: lookup.term,
    beyond: lookup.beyond || rateDetail.beyond,
    rateBasis: i.discount === false ? 'not discounted' : i.rate != null ? 'locked layer rate' : rateDetail.basis,
    rate: i.discount === false ? 0 : rate,
    pv,
  };
}

/** Σ qty × rate over the build-up. */
export function directFromLines(lines: CostLine[]): number {
  return (lines ?? []).reduce((s, l) => s + num(l.qty) * num(l.rate), 0);
}

/** Σ of the recorded cost revisions. Gross of contingency by construction. */
export function costRevisions(adj: Revision[]): number {
  return (adj ?? []).filter((a) => a.kind === 'cost').reduce((s, a) => s + num(a.amount), 0);
}

/**
 * The settlement date in force: the obligation's own date unless a timing
 * revision has moved it, in which case the latest one wins.
 *
 * Pass `before` to read the date as it stood at the start of a fiscal year —
 * only revisions dated earlier than that day are applied.
 */
export function settlementAsAt(o: Obligation, before?: string): string {
  const terms = (o.adj ?? [])
    .filter((a) => a.kind === 'term' && a.to && (!before || cmpDate(a.date, before) < 0))
    .sort((a, b) => cmpDate(a.date, b.date));
  return terms.length ? (terms[terms.length - 1].to as string) : o.settlementDate;
}

export function settlementInForce(o: Obligation): string {
  return settlementAsAt(o);
}

export interface DeriveOptions {
  /** The closing curve. */
  curve: Curve;
  /** The curve in force before the year-end revaluation — ENGINE-SPEC §7. */
  priorCurve?: Curve;
  /** Defaults to IFRS when omitted — existing callers keep the single-rate chain. */
  framework?: string | FrameworkPolicy;
  /** PSAS only. Ignored when the framework requires discounting. Default true. */
  discount?: boolean;
  /** US GAAP / ASPE downward revisions. Default LIFO. */
  layerPolicy?: LayerPolicy;
}

export interface Bridge {
  pvBase: number;
  pvCostOnly: number;
  pvTimingOnly: number;
  pvRateOnly: number;
  costEffect: number;
  timingEffect: number;
  rateEffect: number;
  inflEffect: number;
  /** The four effects sum to this, exactly, with no residual. */
  movement: number;
}

export interface Derived extends Priced {
  obligationId: string;
  ref: string;
  /** Settlement date actually used, after any timing revision. */
  settlementUsed: string;
  /** True when a timing revision moved the settlement date. */
  timingRevised: boolean;
  costRevisions: number;
  bridge: Bridge;
  layers: MeasurementLayer[];
  discounted: boolean;
  ratePerLayer: boolean;
  frameworkId: string;
}

/**
 * Derive one obligation: the chain (§3) plus the remeasurement bridge (§6).
 *
 * Before a year-end revaluation has run, prior equals current, so the rate and
 * inflation legs read nil *because nothing moved* — not because they are
 * unimplemented.
 *
 * US GAAP / ASPE price each stored layer at its locked rate. A later closing
 * curve does not remeasure those layers — it only prices a newly created one.
 * PSAS may skip discounting (and then inflation) entirely.
 */
export function derive(o: Obligation, a: Assumptions, opt: DeriveOptions): Derived {
  const policy = typeof opt.framework === 'object' && opt.framework
    ? opt.framework
    : frameworkPolicy(typeof opt.framework === 'string' ? opt.framework : undefined);
  const discounted = unitDiscounts(policy, opt.discount);
  const escalate = unitEscalates(policy, discounted);
  const layerPolicy = opt.layerPolicy ?? policy.defaultLayerPolicy;

  const baseDirect = directFromLines(o.lines);
  const revisions = costRevisions(o.adj);
  const revisedDirect = baseDirect + revisions;

  const stOriginal = o.settlementDate;
  const stRevised = settlementInForce(o);

  const closingCurve = opt.curve;
  const priorCurve = opt.priorCurve ?? opt.curve;
  const closingInfl = a.inflation;
  const priorInfl = a.priorInflation ?? a.inflation;

  const common = {
    contingency: a.contingency,
    costEstimateDate: o.costEstimateDate,
    fyEnd: a.fyEnd,
    termConvention: a.termConvention,
    dayCount: a.dayCount ?? DEFAULT_DAY_COUNT,
    discount: discounted,
    escalate,
  };

  if (!policy.ratePerLayer) {
    const pvBase = price({ ...common, direct: baseDirect, settlementDate: stOriginal, inflation: priorInfl, curve: priorCurve });
    const pvCostOnly = price({ ...common, direct: revisedDirect, settlementDate: stOriginal, inflation: priorInfl, curve: priorCurve });
    const pvTimingOnly = price({ ...common, direct: revisedDirect, settlementDate: stRevised, inflation: priorInfl, curve: priorCurve });
    const pvRateOnly = price({ ...common, direct: revisedDirect, settlementDate: stRevised, inflation: priorInfl, curve: closingCurve });
    const final = price({ ...common, direct: revisedDirect, settlementDate: stRevised, inflation: closingInfl, curve: closingCurve });

    const layers: MeasurementLayer[] = baseDirect > 0 || revisions !== 0 ? [{
      id: `${o.id}-layer-initial`,
      aroseOn: o.costEstimateDate,
      direct: revisedDirect,
      rate: final.rate,
      lifeYears: final.curveTerm,
      method: discounted ? 'current-rate' : 'undiscounted',
    }] : [];

    return packDerived(o, final, stRevised, stOriginal, revisions, {
      pvBase: pvBase.pv,
      pvCostOnly: pvCostOnly.pv,
      pvTimingOnly: pvTimingOnly.pv,
      pvRateOnly: pvRateOnly.pv,
      costEffect: pvCostOnly.pv - pvBase.pv,
      timingEffect: pvTimingOnly.pv - pvCostOnly.pv,
      rateEffect: pvRateOnly.pv - pvTimingOnly.pv,
      inflEffect: final.pv - pvRateOnly.pv,
      movement: final.pv - pvBase.pv,
    }, layers, discounted, false, policy.id);
  }

  const stForLookup = stRevised;
  const closingLookup = layerRateLookup(closingCurve, stForLookup, a.termConvention, a.dayCount);
  const priorLookup = layerRateLookup(priorCurve, stForLookup, a.termConvention, a.dayCount);
  const layers = syncLayers(o, o.layers, closingLookup, layerPolicy);
  const baseLayers = syncLayers(
    { ...o, adj: (o.adj ?? []).filter((x) => x.kind !== 'cost') },
    o.layers,
    priorLookup,
    layerPolicy,
  );

  const priceSet = (set: MeasurementLayer[], settlementDate: string, inflation: number, curve: Curve) =>
    set.reduce((s, l) => s + price({
      ...common, direct: l.direct, settlementDate, inflation, curve, rate: l.rate,
    }).pv, 0);

  const pvBase = priceSet(baseLayers, stOriginal, priorInfl, priorCurve);
  const pvCostOnly = priceSet(layers, stOriginal, priorInfl, priorCurve);
  const pvTimingOnly = priceSet(layers, stRevised, priorInfl, priorCurve);
  // Locked rates: a later closing table does not remeasure existing layers.
  const pvRateOnly = pvTimingOnly;
  const pvFinal = priceSet(layers, stRevised, closingInfl, closingCurve);

  const layerPv = layers.map((l) => ({
    ...l,
    pv: price({
      ...common, direct: l.direct, settlementDate: stRevised, inflation: closingInfl, curve: closingCurve, rate: l.rate,
    }).pv,
  }));
  const cash = price({
    ...common, direct: revisedDirect, settlementDate: stRevised, inflation: closingInfl, curve: closingCurve,
    rate: weightedLayerRate(layerPv),
  });

  return packDerived(o, { ...cash, pv: pvFinal, rateBasis: 'locked layer rate' }, stRevised, stOriginal, revisions, {
    pvBase,
    pvCostOnly,
    pvTimingOnly,
    pvRateOnly,
    costEffect: pvCostOnly - pvBase,
    timingEffect: pvTimingOnly - pvCostOnly,
    rateEffect: 0,
    inflEffect: pvFinal - pvRateOnly,
    movement: pvFinal - pvBase,
  }, layers, discounted, true, policy.id);
}

function packDerived(
  o: Obligation,
  final: Priced,
  stRevised: string,
  stOriginal: string,
  revisions: number,
  bridge: Bridge,
  layers: MeasurementLayer[],
  discounted: boolean,
  ratePerLayer: boolean,
  frameworkId: string,
): Derived {
  return {
    ...final,
    obligationId: o.id,
    ref: o.ref,
    settlementUsed: stRevised,
    timingRevised: stRevised !== stOriginal,
    costRevisions: revisions,
    bridge,
    layers,
    discounted,
    ratePerLayer,
    frameworkId,
  };
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}
