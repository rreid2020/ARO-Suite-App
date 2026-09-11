/**
 * Month-end accretion and amortization, plus packaging the ledger into
 * journal batches.
 *
 * Sequence for an open period:
 *   1. User posts new ARO, cost/term adjustments, settlements and retirements
 *      as they arise. Each of those writes a draft journal batch immediately.
 *   2. At month end, after those postings, the user allocates accretion.
 *   3. Separately, the user allocates amortization of the retirement cost asset.
 *   4. Create batch from the ledger packages whatever is still unbatched —
 *      typically those month-end runs. It does not invent either run.
 *
 * Opening the month and assigning a curve is not a posting trigger.
 *
 * Accretion is the unwinding of the discount for this period:
 *   provision after in-period postings × rate in force × year fraction
 * not the year-end remeasurement dumped into one month (ENGINE-SPEC §7).
 *
 * Amortization is the period charge on the ARO asset after those same
 * in-period postings: carrying amount × year fraction / remaining useful life.
 */

import { curveRate, curveTermOf, isPublishedCurve, type Curve, type TermConvention } from '../engine/curve';
import { nextDay, termYears, type DayCount } from '../engine/dates';
import { settlementInForce, type Obligation } from '../engine/derive';
import { frameworkPolicy, unitDiscounts } from '../engine/framework';
import type { ObligationEvent } from '../engine/rollforward';
import { unitCurve } from './measure';
import { remainingUl } from './openingLoad';
import { usefulLifeAsAt } from './usefulLife';
import { accountForRole, defaultCoding, suspenseAccount } from './posting';
import type { Period } from './periods';
import type { AppState, JournalBatch, JournalLine, ReportingUnit, UnitData } from './types';

export type MonthEndRun = 'accretion' | 'amortization';

export const CLOSE_EVENT_TYPES = ['accretion', 'depreciation'] as const;
export type CloseEventType = (typeof CLOSE_EVENT_TYPES)[number];

/** Events a journal batch may pick up. Opening is conversion, not an in-year post. */
export const BATCH_EVENT_TYPES = [
  'addition', 'expense-recognition', 'revision', 'revision-unproductive', 'accretion', 'depreciation',
  'settlement', 'disposal', 'asset-retirement', 'downward-excess', 'fx',
] as const;

const PROVISION_TYPES = new Set<ObligationEvent['type']>([
  'opening', 'addition', 'expense-recognition', 'accretion', 'revision', 'downward-excess', 'settlement', 'disposal', 'fx',
]);

const round2 = (n: number) => Math.round(n * 100) / 100;

const RUN_LABEL: Record<MonthEndRun, string> = {
  accretion: 'accretion',
  amortization: 'amortization',
};

export function periodYearFraction(period: Pick<Period, 'starts' | 'ends'>, dayCount: string): number {
  return termYears(period.starts, nextDay(period.ends), dayCount);
}

export function remainingDiscountTerm(o: Obligation, unit: Pick<ReportingUnit, 'fyEnd' | 'dayCount'>): number {
  const rem = remainingUl(o);
  if (rem != null && rem > 0) return rem;
  const settle = settlementInForce(o);
  const tD = termYears(unit.fyEnd, settle, unit.dayCount as DayCount);
  return tD > 0 ? tD : 0;
}

export function accretionRateFor(
  o: Obligation,
  unit: ReportingUnit,
  curve: Curve | null | undefined,
): number {
  if (!unitDiscounts(frameworkPolicy(unit.frameworkId), unit.discount)) return 0;
  if (!curve || !isPublishedCurve(curve)) return 0;
  const tD = remainingDiscountTerm(o, unit);
  if (tD <= 0) return 0;
  const lookup = curveTermOf(curve, tD, unit.termConvention as TermConvention);
  return curveRate(curve, lookup.term);
}

/**
 * Provision on which month-end accretion runs: opening, earlier periods, and
 * this period's new ARO / revisions / settlements — not this period's accretion.
 */
export function provisionCarried(
  events: ObligationEvent[],
  periods: Period[],
  obligationId: string,
  period: Period,
): number {
  const byId = new Map(periods.map((p) => [p.id, p]));
  let bal = 0;
  for (const e of events) {
    if (e.obligationId !== obligationId) continue;
    if (!PROVISION_TYPES.has(e.type)) continue;
    if (e.type === 'opening') {
      bal += e.amount;
      continue;
    }
    const ep = byId.get(e.periodId);
    if (!ep) continue;
    if (ep.no < period.no) {
      bal += e.amount;
      continue;
    }
    if (ep.no === period.no && e.type !== 'accretion') bal += e.amount;
  }
  return round2(bal);
}

/**
 * ARO-asset carrying amount on which month-end amortization runs: conversion
 * NBV (if this row was loaded as opening), plus additions and revisions through
 * this period, less prior-period amortization. A new ARO is counted from its
 * addition event, not twice via openingArc.
 */
export function assetCarried(
  events: ObligationEvent[],
  periods: Period[],
  o: Obligation,
  period: Period,
): number {
  const byId = new Map(periods.map((p) => [p.id, p]));
  const converted = events.some((e) => e.obligationId === o.id && e.type === 'opening');
  let nbv = converted && typeof o.openingArc === 'number' ? o.openingArc : 0;
  for (const e of events) {
    if (e.obligationId !== o.id) continue;
    const ep = byId.get(e.periodId);
    if (!ep) continue;
    if (e.type === 'depreciation') {
      if (ep.no < period.no) nbv -= e.amount;
      continue;
    }
    if (e.type === 'addition' || e.type === 'revision') {
      if (ep.no <= period.no) nbv += e.amount;
    }
  }
  return round2(nbv);
}

export interface AssetBooks {
  openingNbv: number;
  openingAccum: number;
  additions: number;
  amortization: number;
  gross: number;
  accum: number;
  nbv: number;
}

/**
 * Linked ARO-asset books for the register: conversion NBV and accum, plus
 * in-year additions/revisions and amortization through the named period.
 * A new cost estimate has no openingArc — it appears here from its addition.
 */
export function assetBooks(
  events: ObligationEvent[],
  periods: Period[],
  o: Obligation,
  period: Period,
): AssetBooks {
  const byId = new Map(periods.map((p) => [p.id, p]));
  const converted = events.some((e) => e.obligationId === o.id && e.type === 'opening');
  const openingNbv = converted && typeof o.openingArc === 'number' ? o.openingArc : 0;
  const openingAccum = converted && typeof o.openingAccumAmort === 'number' ? o.openingAccumAmort : 0;
  let additions = 0;
  let amortization = 0;
  for (const e of events) {
    if (e.obligationId !== o.id) continue;
    const ep = byId.get(e.periodId);
    if (!ep || ep.no > period.no) continue;
    if (e.type === 'addition' || e.type === 'revision') additions = round2(additions + e.amount);
    if (e.type === 'depreciation') amortization = round2(amortization + e.amount);
  }
  const gross = round2(openingNbv + openingAccum + additions);
  const accum = round2(openingAccum + amortization);
  return {
    openingNbv, openingAccum, additions, amortization, gross, accum,
    nbv: round2(gross - accum),
  };
}

function inScope(o: Obligation): boolean {
  return o.status !== 'Scoped out';
}

function closeEventId(unitId: string, type: CloseEventType, obligationId: string, periodId: string): string {
  const tag = type === 'accretion' ? 'accr' : 'depr';
  return `${unitId}-${tag}-${obligationId}-${periodId}`;
}

export interface MonthEndPlan {
  period: Period;
  run: MonthEndRun;
  newEvents: ObligationEvent[];
  already: number;
  amount: number;
}

export function planMonthEnd(
  unit: ReportingUnit,
  data: UnitData,
  curve: Curve | null | undefined,
  period: Period,
  run: MonthEndRun,
): MonthEndPlan {
  const yf = periodYearFraction(period, unit.dayCount);
  const newEvents: ObligationEvent[] = [];
  let amount = 0;
  let already = 0;
  const have = new Map(data.events.map((e) => [e.id, e]));

  const push = (draft: ObligationEvent) => {
    if (Math.abs(draft.amount) < 0.005) return;
    const existing = have.get(draft.id);
    if (existing) {
      already = round2(already + existing.amount);
      return;
    }
    newEvents.push(draft);
    amount = round2(amount + draft.amount);
  };

  for (const o of data.obligations) {
    if (!inScope(o)) continue;

    if (run === 'accretion') {
      const rate = accretionRateFor(o, unit, curve);
      if (rate <= 0 || yf <= 0) continue;
      const balance = provisionCarried(data.events, data.periods, o.id, period);
      if (balance <= 0) continue;
      push({
        id: closeEventId(unit.id, 'accretion', o.id, period.id),
        obligationId: o.id,
        periodId: period.id,
        type: 'accretion',
        date: period.ends,
        amount: round2(balance * rate * yf),
        note: `Month-end accretion at ${(rate * 100).toFixed(4)}% after in-period postings.`,
      });
      continue;
    }

    const rem = usefulLifeAsAt(o, data.events, data.periods, unit, period, true).remainingYears;
    const nbv = assetCarried(data.events, data.periods, o, period);
    if (rem == null || rem <= 0 || nbv <= 0 || yf <= 0) continue;
    push({
      id: closeEventId(unit.id, 'depreciation', o.id, period.id),
      obligationId: o.id,
      periodId: period.id,
      type: 'depreciation',
      date: period.ends,
      amount: Math.min(nbv, round2((nbv / rem) * yf)),
      note: `Month-end amortization of the retirement cost asset over ${rem} remaining years, after in-period postings.`,
    });
  }

  return { period, run, newEvents, already, amount };
}

export function openPeriod(data: Pick<UnitData, 'periods'>): Period | undefined {
  return data.periods.find((p) => p.status === 'Open');
}

function coveredEventIds(batches: JournalBatch[]): Set<string> {
  const ids = new Set<string>();
  for (const b of batches) {
    if (b.status === 'Reversed') continue;
    for (const l of b.lines) {
      if (l.eventId) ids.add(l.eventId);
    }
  }
  return ids;
}

function batchDebits(b: JournalBatch): number {
  return b.lines.reduce((s, l) => s + l.debit, 0);
}

export interface AccountJournalTotal {
  accountId: string;
  debit: number;
  credit: number;
  count: number;
  suspense: boolean;
}

/** Roll journal lines into one debit/credit total per GL account. */
export function summariseByAccount(lines: JournalLine[]): AccountJournalTotal[] {
  const map = new Map<string, AccountJournalTotal>();
  for (const l of lines) {
    const row = map.get(l.accountId) ?? {
      accountId: l.accountId, debit: 0, credit: 0, count: 0, suspense: false,
    };
    row.debit = round2(row.debit + l.debit);
    row.credit = round2(row.credit + l.credit);
    row.count += 1;
    if (l.suspense) row.suspense = true;
    map.set(l.accountId, row);
  }
  return [...map.values()];
}

function isBatchEvent(type: ObligationEvent['type']): boolean {
  return (BATCH_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Positive amount posts the rule as written (debitRole → creditRole).
 * Negative amount swaps the two GLs: the rule's credit account is debited and
 * its debit account is credited. The absolute amount is unchanged.
 */
export function postedSides<T>(amount: number, debit: T, credit: T): { debit: T; credit: T } {
  return amount >= 0 ? { debit, credit } : { debit: credit, credit: debit };
}

function linesFromEvents(
  s: AppState,
  tenantId: string,
  data: UnitData,
  events: ObligationEvent[],
): JournalLine[] {
  const settings = s.settings[tenantId];
  const coding = defaultCoding(settings);
  const lines: JournalLine[] = [];
  let ord = 1;
  for (const e of events) {
    const o = data.obligations.find((x) => x.id === e.obligationId);
    const rule = settings.postingRules.find((r) => r.eventType === e.type);
    const dr = (rule ? accountForRole(settings, tenantId, rule.debitRole, o) : undefined)
      ?? suspenseAccount(settings, tenantId, o);
    const cr = (rule ? accountForRole(settings, tenantId, rule.creditRole, o) : undefined)
      ?? suspenseAccount(settings, tenantId, o);
    if (!dr || !cr) continue;
    const abs = Math.abs(e.amount);
    const sides = postedSides(e.amount, dr, cr);
    lines.push({
      ord: ord++, accountId: sides.debit.id, coding: { ...coding }, debit: abs, credit: 0,
      obligationId: e.obligationId, eventId: e.id, suspense: !rule || sides.debit.engineRole === 'Suspense',
    });
    lines.push({
      ord: ord++, accountId: sides.credit.id, coding: { ...coding }, debit: 0, credit: abs,
      obligationId: e.obligationId, eventId: e.id, suspense: !rule || sides.credit.engineRole === 'Suspense',
    });
  }
  return lines;
}

export function monthEndRefusal(s: AppState, tenantId: string, unitId: string, run: MonthEndRun): string | null {
  const unit = (s.units[tenantId] ?? []).find((u) => u.id === unitId);
  const data = s.data[unitId];
  if (!unit || !data) return 'That reporting unit is not on this tenant.';

  const period = openPeriod(data);
  const label = RUN_LABEL[run];
  if (!period) {
    return `Open a period before allocating ${label}. ${label[0].toUpperCase()}${label.slice(1)} runs at month end, after new ARO, cost and term postings for that period.`;
  }

  if (run === 'accretion' && unitDiscounts(frameworkPolicy(unit.frameworkId), unit.discount) && !isPublishedCurve(unitCurve(s, unit))) {
    return `${unit.entity} needs a published discount curve before accretion can be allocated.`;
  }

  const plan = planMonthEnd(unit, data, unitCurve(s, unit), period, run);
  if (!plan.newEvents.length && plan.already > 0) {
    return `${label[0].toUpperCase()}${label.slice(1)} for ${period.code} is already allocated.`;
  }
  if (!plan.newEvents.length) {
    return run === 'accretion'
      ? `Nothing to allocate in ${period.code}. Accretion needs remaining useful life on the opening register (or a settlement date after the year end) and a published discount curve.`
      : `Nothing to allocate in ${period.code}. Amortization needs an ARO-asset carrying amount and remaining useful life.`;
  }
  return null;
}

export function allocateMonthEnd(s: AppState, tenantId: string, unitId: string, run: MonthEndRun): MonthEndPlan | string {
  const blocked = monthEndRefusal(s, tenantId, unitId, run);
  if (blocked) return blocked;
  const unit = (s.units[tenantId] ?? []).find((u) => u.id === unitId)!;
  const data = s.data[unitId];
  const period = openPeriod(data)!;
  const plan = planMonthEnd(unit, data, unitCurve(s, unit), period, run);
  for (const e of plan.newEvents) data.events.push(e);
  return plan;
}

export interface PeriodBatchResult {
  number: string;
  periodCode: string;
  amount: number;
  filled: boolean;
}

function unbatchedPeriodEvents(data: UnitData, periodId: string): ObligationEvent[] {
  const covered = coveredEventIds(data.batches);
  return data.events.filter((e) => e.periodId === periodId && isBatchEvent(e.type) && !covered.has(e.id) && Math.abs(e.amount) >= 0.005);
}

export function periodBatchRefusal(s: AppState, tenantId: string, unitId: string): string | null {
  const unit = (s.units[tenantId] ?? []).find((u) => u.id === unitId);
  const data = s.data[unitId];
  if (!unit || !data) return 'That reporting unit is not on this tenant.';

  const period = openPeriod(data);
  if (!period) {
    return 'Open a period before creating a batch. A batch posts the open period; it does not fall back to year-end.';
  }

  const toPost = unbatchedPeriodEvents(data, period.id);
  if (!toPost.length) {
    const covering = data.batches.find((b) => b.periodId === period.id && b.status !== 'Reversed' && batchDebits(b) >= 0.005);
    if (covering) {
      return `${covering.number} already covers ${period.code}. Approve or reverse it before creating another.`;
    }
    return `Nothing unbatched on the ledger for ${period.code}. In-year postings create their own journal when you record them. Allocate accretion and amortization at month end, then create a batch for those remaining events.`;
  }
  return null;
}

function writeBatch(
  s: AppState,
  tenantId: string,
  unitId: string,
  data: UnitData,
  period: Period,
  toPost: ObligationEvent[],
  existing?: JournalBatch,
): PeriodBatchResult {
  const lines = linesFromEvents(s, tenantId, data, toPost);
  const amount = round2(toPost.reduce((sum, e) => sum + Math.abs(e.amount), 0));
  if (existing) {
    existing.lines = lines;
    return { number: existing.number, periodCode: period.code, amount, filled: true };
  }
  const batch: JournalBatch = {
    id: `jb-${Date.now().toString(36)}-${data.batches.length}`,
    unitId,
    periodId: period.id,
    number: `JB-${String(data.batches.length + 1).padStart(3, '0')}`,
    status: 'Draft',
    lines,
  };
  data.batches.push(batch);
  return { number: batch.number, periodCode: period.code, amount, filled: false };
}

/**
 * Package one in-year transaction's events into their own draft journal.
 * Does not scoop leftover month-end accretion or amortization.
 */
export function createBatchForEvents(
  s: AppState,
  tenantId: string,
  unitId: string,
  events: ObligationEvent[],
): PeriodBatchResult | string {
  const unit = (s.units[tenantId] ?? []).find((u) => u.id === unitId);
  const data = s.data[unitId];
  if (!unit || !data) return 'That reporting unit is not on this tenant.';
  const period = openPeriod(data);
  if (!period) {
    return 'Open a period before creating a batch. A batch posts the open period; it does not fall back to year-end.';
  }
  const covered = coveredEventIds(data.batches);
  const toPost = events.filter((e) => (
    e.periodId === period.id && isBatchEvent(e.type) && !covered.has(e.id) && Math.abs(e.amount) >= 0.005
  ));
  if (!toPost.length) return 'Nothing to package for that transaction.';
  const lines = linesFromEvents(s, tenantId, data, toPost);
  if (!lines.length) return 'Those events could not be mapped to posting accounts.';
  return writeBatch(s, tenantId, unitId, data, period, toPost);
}

/**
 * Package unbatched events for the Open period into a journal batch.
 * Typically month-end accretion and amortization still sitting on the ledger.
 * Does not write those runs — they are allocated separately.
 */
export function createOrFillPeriodBatch(s: AppState, tenantId: string, unitId: string): PeriodBatchResult | string {
  const blocked = periodBatchRefusal(s, tenantId, unitId);
  if (blocked) return blocked;

  const data = s.data[unitId];
  const period = openPeriod(data)!;
  const toPost = unbatchedPeriodEvents(data, period.id);
  const draft = data.batches.find((b) => b.periodId === period.id && b.status === 'Draft');
  const emptyDraft = Boolean(draft && batchDebits(draft) < 0.005);
  return writeBatch(s, tenantId, unitId, data, period, toPost, emptyDraft ? draft : undefined);
}
