/**
 * Framework policy the engine actually reads.
 *
 * IFRS is a single current rate on the whole obligation. US GAAP (ASC 410-20)
 * and ASPE lock a credit-adjusted rate onto each layer. PSAS (PS 3280) may
 * dispense with discounting; inflation then drops out with it.
 */

import { Curve, TermConvention, curveTermOf, curveRateDetail } from './curve';
import { DayCount, DEFAULT_DAY_COUNT, cmpDate, termYears } from './dates';

export type FrameworkId = 'ifrs' | 'usgaap' | 'psas' | 'aspe';

export type LayerPolicy = 'LIFO' | 'FIFO' | 'Pro-rata';

export const LAYER_POLICIES: LayerPolicy[] = ['LIFO', 'FIFO', 'Pro-rata'];

export interface FrameworkPolicy {
  id: FrameworkId;
  name: string;
  /** US GAAP / ASPE: each upward revision carries the rate in force that day. */
  ratePerLayer: boolean;
  discounting: 'required' | 'optional';
  /** PSAS: inflation is included only where the liability is discounted. */
  inflateOnlyIfDiscounted: boolean;
  defaultLayerPolicy: LayerPolicy;
}

export const FRAMEWORK_POLICIES: Record<FrameworkId, FrameworkPolicy> = {
  ifrs: {
    id: 'ifrs',
    name: 'IFRS (IAS 37)',
    ratePerLayer: false,
    discounting: 'required',
    inflateOnlyIfDiscounted: false,
    defaultLayerPolicy: 'LIFO',
  },
  usgaap: {
    id: 'usgaap',
    name: 'US GAAP (ASC 410-20)',
    ratePerLayer: true,
    discounting: 'required',
    inflateOnlyIfDiscounted: false,
    defaultLayerPolicy: 'LIFO',
  },
  psas: {
    id: 'psas',
    name: 'PSAS (PS 3280)',
    ratePerLayer: false,
    discounting: 'optional',
    inflateOnlyIfDiscounted: true,
    defaultLayerPolicy: 'LIFO',
  },
  aspe: {
    id: 'aspe',
    name: 'ASPE (Section 3110)',
    ratePerLayer: true,
    discounting: 'required',
    inflateOnlyIfDiscounted: false,
    defaultLayerPolicy: 'LIFO',
  },
};

export function frameworkPolicy(id: string | undefined | null): FrameworkPolicy {
  if (id && id in FRAMEWORK_POLICIES) return FRAMEWORK_POLICIES[id as FrameworkId];
  return FRAMEWORK_POLICIES.ifrs;
}

/** Whether this unit discounts. Required frameworks always do; PSAS is a choice. */
export function unitDiscounts(policy: FrameworkPolicy, discount: boolean | undefined): boolean {
  if (policy.discounting === 'required') return true;
  return discount !== false;
}

export function unitEscalates(policy: FrameworkPolicy, discounted: boolean): boolean {
  if (policy.inflateOnlyIfDiscounted && !discounted) return false;
  return true;
}

/**
 * A stored measurement layer — DOMAIN-MODEL. Amount is the cost increment at
 * CURRENT prices, gross of contingency, same as a cost revision. Rate is locked
 * at the date the layer arose and is not rewritten by a later curve.
 */
export interface MeasurementLayer {
  id: string;
  aroseOn: string;
  direct: number;
  rate: number;
  lifeYears: number;
  method: string;
}

export function isLayerPolicy(v: string | undefined): v is LayerPolicy {
  return v === 'LIFO' || v === 'FIFO' || v === 'Pro-rata';
}

interface LayerSource {
  id: string;
  costEstimateDate: string;
  lines?: { qty: number; rate: number }[];
  adj?: { id: string; kind: string; amount?: number; date: string }[];
  layers?: MeasurementLayer[];
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function directOf(o: LayerSource): number {
  return (o.lines ?? []).reduce((s, l) => s + num(l.qty) * num(l.rate), 0);
}

/** Consume `reduction` of CURRENT-price direct from layers in policy order. */
export function consumeLayers(
  layers: MeasurementLayer[],
  reduction: number,
  policy: LayerPolicy,
): MeasurementLayer[] {
  let remaining = reduction;
  if (remaining <= 0) return layers;

  if (policy === 'Pro-rata') {
    const total = layers.reduce((s, l) => s + l.direct, 0);
    if (total <= 0) return [];
    const take = Math.min(remaining, total);
    return layers
      .map((l) => ({ ...l, direct: l.direct - take * (l.direct / total) }))
      .filter((l) => l.direct > 1e-9);
  }

  const next = layers.map((l) => ({ ...l }));
  const seq = policy === 'FIFO' ? next : [...next].reverse();
  for (const l of seq) {
    if (remaining <= 0) break;
    const take = Math.min(l.direct, remaining);
    l.direct -= take;
    remaining -= take;
  }
  return next.filter((l) => l.direct > 1e-9);
}

export interface LayerRateLookup {
  rate: number;
  lifeYears: number;
}

/**
 * Rebuild layers from the build-up and recorded cost revisions. Existing rows
 * keep their locked rates; only a newly appeared increment looks the curve up.
 */
export function syncLayers(
  o: LayerSource,
  existing: MeasurementLayer[] | undefined,
  lookupRate: (aroseOn: string) => LayerRateLookup,
  policy: LayerPolicy,
): MeasurementLayer[] {
  const byId = new Map((existing ?? o.layers ?? []).map((l) => [l.id, l]));
  const base = directOf(o);
  let layers: MeasurementLayer[] = [];

  if (base > 0) {
    const id = `${o.id}-layer-initial`;
    const prev = byId.get(id);
    const look = lookupRate(o.costEstimateDate);
    layers = [{
      id,
      aroseOn: o.costEstimateDate,
      direct: base,
      rate: prev?.rate ?? look.rate,
      lifeYears: prev?.lifeYears ?? look.lifeYears,
      method: 'interest-method',
    }];
  }

  const costRevs = (o.adj ?? [])
    .filter((a) => a.kind === 'cost')
    .sort((a, b) => {
      const c = cmpDate(a.date, b.date);
      return c !== 0 ? c : a.id.localeCompare(b.id);
    });

  for (const rev of costRevs) {
    const n = num(rev.amount);
    if (n > 0) {
      const id = `${rev.id}-layer`;
      const prev = byId.get(id);
      const look = lookupRate(rev.date);
      layers.push({
        id,
        aroseOn: rev.date,
        direct: n,
        rate: prev?.rate ?? look.rate,
        lifeYears: prev?.lifeYears ?? look.lifeYears,
        method: 'interest-method',
      });
    } else if (n < 0) {
      layers = consumeLayers(layers, -n, policy);
    }
  }

  return layers;
}

/** Rate locked on a new layer: looked up at the remaining life on the day it arose. */
export function layerRateLookup(
  curve: Curve,
  settlementDate: string,
  convention: TermConvention,
  dayCount: DayCount | undefined,
): (aroseOn: string) => LayerRateLookup {
  const dc = dayCount ?? DEFAULT_DAY_COUNT;
  return (aroseOn: string) => {
    const life = termYears(aroseOn, settlementDate, dc);
    const term = curveTermOf(curve, life, convention);
    const rate = curveRateDetail(curve, term.term);
    return { rate: rate.rate, lifeYears: term.term };
  };
}

/** Carrying-weighted average of locked layer rates. */
export function weightedLayerRate(layers: Array<{ pv: number; rate: number }>): number {
  const pv = layers.reduce((s, l) => s + l.pv, 0);
  if (pv === 0) return layers[0]?.rate ?? 0;
  return layers.reduce((s, l) => s + l.pv * l.rate, 0) / pv;
}
