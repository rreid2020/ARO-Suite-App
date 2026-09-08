/**
 * Monthly accretion and amortization schedules for one obligation.
 *
 * Allocated months read the event ledger. Later months are scheduled at the
 * rate (or remaining UL) in force, compounding on the prior row's closing, so
 * the year foots even when month-end has not yet been run.
 */

import type { Curve } from '../engine/curve';
import type { ObligationEvent } from '../engine/rollforward';
import { usefulLifeAsAt } from './usefulLife';
import { accretionRateFor, periodYearFraction } from './periodClose';
import type { Period } from './periods';
import { postedEventIds } from './registerBooks';
import type { JournalBatch, Obligation, ReportingUnit } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;

const PROVISION_BEFORE = new Set<ObligationEvent['type']>([
  'opening', 'addition', 'expense-recognition', 'accretion', 'revision', 'downward-excess', 'settlement', 'disposal', 'fx',
]);

const PROVISION_ACTIVITY = new Set<ObligationEvent['type']>([
  'addition', 'expense-recognition', 'revision', 'downward-excess', 'settlement', 'disposal', 'fx',
]);

export type ScheduleStatus = 'Posted' | 'Allocated' | 'Scheduled';

export interface ScheduleRow {
  periodId: string;
  code: string;
  no: number;
  starts: string;
  ends: string;
  periodStatus: Period['status'];
  opening: number;
  activity: number;
  rate: number;
  remainingUl: number | null;
  yearFraction: number;
  charge: number;
  closing: number;
  allocated: boolean;
  posted: boolean;
  status: ScheduleStatus;
}

function statusOf(allocated: boolean, posted: boolean): ScheduleStatus {
  if (posted) return 'Posted';
  if (allocated) return 'Allocated';
  return 'Scheduled';
}

function fyPeriods(periods: Period[], fiscalYear: number): Period[] {
  return periods.filter((p) => p.fiscalYear === fiscalYear).sort((a, b) => a.no - b.no);
}

function eventInPeriod(
  events: ObligationEvent[],
  obligationId: string,
  periodId: string,
  type: ObligationEvent['type'],
): ObligationEvent | undefined {
  return events.find((e) => e.obligationId === obligationId && e.periodId === periodId && e.type === type);
}

function sumActivity(
  events: ObligationEvent[],
  obligationId: string,
  periodId: string,
  types: Set<ObligationEvent['type']>,
): number {
  return round2(
    events
      .filter((e) => e.obligationId === obligationId && e.periodId === periodId && types.has(e.type))
      .reduce((s, e) => s + e.amount, 0),
  );
}

function provisionBeforeYear(
  events: ObligationEvent[],
  periods: Period[],
  obligationId: string,
  fiscalYear: number,
): number {
  const byId = new Map(periods.map((p) => [p.id, p]));
  let bal = 0;
  for (const e of events) {
    if (e.obligationId !== obligationId || !PROVISION_BEFORE.has(e.type)) continue;
    if (e.type === 'opening') {
      bal += e.amount;
      continue;
    }
    const p = byId.get(e.periodId);
    if (p && p.fiscalYear < fiscalYear) bal += e.amount;
  }
  return round2(bal);
}

function assetBeforeYear(
  events: ObligationEvent[],
  periods: Period[],
  o: Obligation,
  fiscalYear: number,
): number {
  const byId = new Map(periods.map((p) => [p.id, p]));
  const converted = events.some((e) => e.obligationId === o.id && e.type === 'opening');
  let nbv = converted && typeof o.openingArc === 'number' ? o.openingArc : 0;
  for (const e of events) {
    if (e.obligationId !== o.id) continue;
    const p = byId.get(e.periodId);
    if (!p || p.fiscalYear >= fiscalYear) continue;
    if (e.type === 'addition' || e.type === 'revision') nbv += e.amount;
    if (e.type === 'depreciation') nbv -= e.amount;
  }
  return round2(nbv);
}

export function accretionSchedule(
  o: Obligation,
  events: ObligationEvent[],
  periods: Period[],
  batches: JournalBatch[],
  unit: ReportingUnit,
  curve: Curve | null | undefined,
  fiscalYear: number,
): ScheduleRow[] {
  const posted = postedEventIds(batches);
  const rate = accretionRateFor(o, unit, curve);
  let bal = provisionBeforeYear(events, periods, o.id, fiscalYear);
  const rows: ScheduleRow[] = [];
  for (const p of fyPeriods(periods, fiscalYear)) {
    const yf = periodYearFraction(p, unit.dayCount);
    const activity = sumActivity(events, o.id, p.id, PROVISION_ACTIVITY);
    const opening = round2(bal);
    const base = round2(opening + activity);
    const actual = eventInPeriod(events, o.id, p.id, 'accretion');
    const planned = rate > 0 && yf > 0 && base > 0 ? round2(base * rate * yf) : 0;
    const charge = actual ? round2(actual.amount) : planned;
    const allocated = !!actual;
    const isPosted = !!actual && posted.has(actual.id);
    const closing = round2(base + charge);
    rows.push({
      periodId: p.id, code: p.code, no: p.no, starts: p.starts, ends: p.ends,
      periodStatus: p.status, opening, activity, rate, remainingUl: null, yearFraction: yf,
      charge, closing, allocated, posted: isPosted, status: statusOf(allocated, isPosted),
    });
    bal = closing;
  }
  return rows;
}

export function amortizationSchedule(
  o: Obligation,
  events: ObligationEvent[],
  periods: Period[],
  batches: JournalBatch[],
  unit: ReportingUnit,
  fiscalYear: number,
): ScheduleRow[] {
  const posted = postedEventIds(batches);
  const fy = fyPeriods(periods, fiscalYear);
  let rem = usefulLifeAsAt(o, events, periods, unit, fy[0], true).remainingYears;
  let bal = assetBeforeYear(events, periods, o, fiscalYear);
  const rows: ScheduleRow[] = [];
  for (const p of fy) {
    const yf = periodYearFraction(p, unit.dayCount);
    const activity = round2(
      events
        .filter((e) => e.obligationId === o.id && e.periodId === p.id && (e.type === 'addition' || e.type === 'revision'))
        .reduce((s, e) => s + e.amount, 0),
    );
    const opening = round2(bal);
    const base = round2(opening + activity);
    const actual = eventInPeriod(events, o.id, p.id, 'depreciation');
    const planned = rem != null && rem > 0 && yf > 0 && base > 0
      ? Math.min(base, round2((base / rem) * yf))
      : 0;
    const charge = actual ? round2(actual.amount) : planned;
    const allocated = !!actual;
    const isPosted = !!actual && posted.has(actual.id);
    const closing = round2(base - charge);
    rows.push({
      periodId: p.id, code: p.code, no: p.no, starts: p.starts, ends: p.ends,
      periodStatus: p.status, opening, activity, rate: 0, remainingUl: rem, yearFraction: yf,
      charge, closing, allocated, posted: isPosted, status: statusOf(allocated, isPosted),
    });
    bal = closing;
    if (rem != null) rem = Math.max(0, Math.round((rem - yf) * 10000) / 10000);
  }
  return rows;
}
