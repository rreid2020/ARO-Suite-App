/**
 * ARO-asset useful life: years and periods, rolled forward as months post,
 * and a review-and-approve alignment when a term adjustment leaves remaining
 * life out of line with the settlement date.
 *
 * Conversion stores total and expired UL in years. Expired and remaining as at
 * a period add the year fractions of amortization already on the event ledger.
 * A term revision does not silently change UL — it raises a pending flag.
 */

import { isValidDate, nextDay, termYears, type DayCount } from '../engine/dates';
import { settlementAsAt, settlementInForce, type Obligation } from '../engine/derive';
import type { ObligationEvent } from '../engine/rollforward';
import { years as formatYears, num, parseNumber } from './format';
import { remainingUl } from './openingLoad';
import type { CalendarType, Period } from './periods';
import type { ReportingUnit } from './types';

const round4 = (n: number) => Math.round(n * 10000) / 10000;

function periodYf(period: Pick<Period, 'starts' | 'ends'>, dayCount: string): number {
  return termYears(period.starts, nextDay(period.ends), dayCount);
}

export type UlAlignmentStatus = 'Pending review' | 'Approved' | 'Dismissed';

export interface UlAlignment {
  status: UlAlignmentStatus;
  revisionId: string;
  settlementDate: string;
  remainingUl: number;
  settlementTerm: number;
  proposedTotalUl: number;
  proposedRemainingUl: number;
  raisedAt: string;
  raisedBy?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface UsefulLife {
  totalYears: number | null;
  expiredYears: number | null;
  remainingYears: number | null;
  totalPeriods: number | null;
  expiredPeriods: number | null;
  remainingPeriods: number | null;
}

export function periodsPerYear(calendar: CalendarType | string | undefined): number {
  return calendar === 'Quarterly (4)' ? 4 : 12;
}

export function periodUnit(calendar: CalendarType | string | undefined): 'mo' | 'qtr' {
  return calendar === 'Quarterly (4)' ? 'qtr' : 'mo';
}

export function yearsToPeriods(yearsVal: number, calendar: CalendarType | string | undefined): number {
  return round4(yearsVal * periodsPerYear(calendar));
}

/** "15 yr · 180 mo" — years and the calendar's periods. */
export function formatUl(
  yearsVal: number | null | undefined,
  calendar: CalendarType | string | undefined,
): string {
  if (yearsVal == null || !Number.isFinite(yearsVal)) return '—';
  return `${formatYears(yearsVal)} · ${num(yearsToPeriods(yearsVal, calendar), 2)} ${periodUnit(calendar)}`;
}

function openingExpired(o: Obligation): number | null {
  if (typeof o.totalUl !== 'number') return null;
  return typeof o.expiredUl === 'number' ? o.expiredUl : 0;
}

function amortYearsOnLedger(
  o: Obligation,
  events: ObligationEvent[],
  periods: Period[],
  unit: Pick<ReportingUnit, 'dayCount'>,
  asAt: Period | undefined,
  exclusive: boolean,
): number {
  if (!asAt) return 0;
  const byId = new Map(periods.map((p) => [p.id, p]));
  let yearsVal = 0;
  for (const e of events) {
    if (e.obligationId !== o.id || e.type !== 'depreciation') continue;
    const p = byId.get(e.periodId);
    if (!p) continue;
    if (p.fiscalYear < asAt.fiscalYear) {
      yearsVal += periodYf(p, unit.dayCount);
      continue;
    }
    if (p.fiscalYear !== asAt.fiscalYear) continue;
    if (exclusive ? p.no < asAt.no : p.no <= asAt.no) {
      yearsVal += periodYf(p, unit.dayCount);
    }
  }
  return yearsVal;
}

/**
 * Useful life as at a period end. Opening expired is the conversion figure;
 * later months add the year fraction of each amortization event on the ledger.
 * Pass exclusive to get remaining at the start of `asAt` (for that period's charge).
 */
export function usefulLifeAsAt(
  o: Obligation,
  events: ObligationEvent[],
  periods: Period[],
  unit: Pick<ReportingUnit, 'dayCount' | 'calendarType'>,
  asAt: Period | undefined,
  exclusive = false,
): UsefulLife {
  const calendar = unit.calendarType;
  const total = typeof o.totalUl === 'number' ? o.totalUl : null;
  const openExpired = openingExpired(o);
  if (total == null || openExpired == null) {
    return {
      totalYears: total, expiredYears: openExpired, remainingYears: remainingUl(o),
      totalPeriods: total == null ? null : yearsToPeriods(total, calendar),
      expiredPeriods: openExpired == null ? null : yearsToPeriods(openExpired, calendar),
      remainingPeriods: remainingUl(o) == null ? null : yearsToPeriods(remainingUl(o)!, calendar),
    };
  }
  const expired = round4(Math.min(total, Math.max(0, openExpired + amortYearsOnLedger(o, events, periods, unit, asAt, exclusive))));
  const remaining = round4(Math.max(0, total - expired));
  return {
    totalYears: total,
    expiredYears: expired,
    remainingYears: remaining,
    totalPeriods: yearsToPeriods(total, calendar),
    expiredPeriods: yearsToPeriods(expired, calendar),
    remainingPeriods: yearsToPeriods(remaining, calendar),
  };
}

export function ulAlignmentOf(o: Obligation): UlAlignment | undefined {
  const raw = o.ulAlignment;
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as UlAlignment;
}

export function ulAlignmentPending(o: Obligation): boolean {
  return ulAlignmentOf(o)?.status === 'Pending review';
}

/** Remaining UL is out of line with the term to settlement by more than one period. */
export function ulOutOfLine(remainingUlYears: number | null, settlementTerm: number, periodYearFraction: number): boolean {
  if (remainingUlYears == null || !Number.isFinite(remainingUlYears) || !Number.isFinite(settlementTerm)) return false;
  const tol = Math.max(periodYearFraction, 0);
  return Math.abs(remainingUlYears - settlementTerm) > tol + 1e-9;
}

export function proposeUlAlignment(
  o: Obligation,
  events: ObligationEvent[],
  periods: Period[],
  unit: Pick<ReportingUnit, 'dayCount' | 'calendarType' | 'fyEnd'>,
  period: Period,
  revisionId: string,
  settlementDate: string,
  raisedBy?: string,
): UlAlignment | undefined {
  const yf = periodYf(period, unit.dayCount);
  const life = usefulLifeAsAt(o, events, periods, unit, period, true);
  const settlementTerm = round4(Math.max(0, termYears(period.ends, settlementDate, unit.dayCount as DayCount)));
  const remaining = life.remainingYears;
  if (!ulOutOfLine(remaining, settlementTerm, yf)) return undefined;
  const expired = life.expiredYears ?? 0;
  const proposedRemaining = settlementTerm;
  const proposedTotal = round4(expired + proposedRemaining);
  return {
    status: 'Pending review',
    revisionId,
    settlementDate,
    remainingUl: remaining ?? 0,
    settlementTerm,
    proposedTotalUl: proposedTotal,
    proposedRemainingUl: proposedRemaining,
    raisedAt: new Date().toISOString(),
    raisedBy,
  };
}

export function applyUlAlignment(o: Obligation, reviewedBy: string, at = new Date().toISOString()): Obligation {
  const flag = ulAlignmentOf(o);
  if (!flag || flag.status !== 'Pending review') return o;
  return {
    ...o,
    totalUl: flag.proposedTotalUl,
    ulAlignment: { ...flag, status: 'Approved', reviewedBy, reviewedAt: at },
  };
}

export function dismissUlAlignment(o: Obligation, reviewedBy: string, at = new Date().toISOString()): Obligation {
  const flag = ulAlignmentOf(o);
  if (!flag || flag.status !== 'Pending review') return o;
  return {
    ...o,
    ulAlignment: { ...flag, status: 'Dismissed', reviewedBy, reviewedAt: at },
  };
}

/** Settlement term from a period end (or the year end) to the date in force. */
export function settlementTermYears(
  o: Obligation,
  unit: Pick<ReportingUnit, 'fyEnd' | 'dayCount'>,
  from = unit.fyEnd,
): number {
  return Math.max(0, termYears(from, settlementInForce(o), unit.dayCount as DayCount));
}

/**
 * Remaining years from the start of a fiscal year to expected settlement as
 * it stood that morning. The next fiscal year is one year shorter; a term
 * revision dated on or after the year start does not rewrite last year's opening.
 */
export function termToSettlementAtYearStart(
  o: Obligation,
  unit: Pick<ReportingUnit, 'dayCount'>,
  fyStart: string | undefined,
): number | null {
  if (!fyStart) return null;
  const settle = settlementAsAt(o, fyStart);
  if (!settle) return null;
  const t = termYears(fyStart, settle, unit.dayCount as DayCount);
  return t > 0 ? t : 0;
}

/**
 * Life already consumed from the TCA acquisition (in-service) date to the
 * cost-estimate / price date. Used for post-capitalization catch-up
 * amortization when a new ARO is recognised on an asset already in service.
 */
export function expiredUlFromAcquisition(
  acquisitionDate: string,
  asAt: string,
  totalUl: number | null | undefined,
  dayCount: DayCount | string = '30/360 US (DAYS360)',
): number | null {
  if (!isValidDate(acquisitionDate) || !isValidDate(asAt)) return null;
  const elapsed = round4(Math.max(0, termYears(acquisitionDate, asAt, dayCount)));
  if (totalUl == null || !Number.isFinite(totalUl) || totalUl < 0) return elapsed;
  return round4(Math.min(totalUl, elapsed));
}

function asYears(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Form text for a listing UL figure, or blank when the listing has none. */
export function tcaUlText(n: number | null | undefined): string {
  return asYears(n) == null ? '' : num(n);
}

export function remainingUlYears(
  totalUl: number | null | undefined,
  expiredUl: number | null | undefined,
): number | null {
  const total = asYears(totalUl);
  if (total == null) return null;
  const expired = asYears(expiredUl) ?? 0;
  return round4(total - expired);
}

/** Years from the cost-estimate (price) date to expected settlement. */
export function yearsToSettlement(
  fromDate: string,
  settlementDate: string,
  dayCount: DayCount | string = '30/360 US (DAYS360)',
): number | null {
  if (!isValidDate(fromDate) || !isValidDate(settlementDate)) return null;
  return round4(termYears(fromDate, settlementDate, dayCount));
}

export type NewObligationUlField = 'totalUl' | 'expiredUl' | 'settlement';

export interface NewObligationUlIssue {
  field: NewObligationUlField;
  message: string;
}

/**
 * Resolve Total / Expired UL for a new ARO: typed values first, then the
 * linked TCA on the master listing, then elapsed life from the obligating
 * event to the cost estimate date when Expired UL is still blank.
 */
export function resolveNewAroUl(opts: {
  inputTotalUl?: number | null;
  inputExpiredUl?: number | null;
  tca?: { totalUl?: number | null; expiredUl?: number | null } | null;
  assetAcquisitionDate: string;
  costEstimateDate: string;
  dayCount: DayCount | string;
}): { totalUl: number | null; expiredUl: number | null } {
  const totalUl = asYears(opts.inputTotalUl) ?? asYears(opts.tca?.totalUl);
  let expiredUl = asYears(opts.inputExpiredUl);
  if (expiredUl == null) expiredUl = asYears(opts.tca?.expiredUl);
  if (expiredUl == null && totalUl != null) {
    expiredUl = expiredUlFromAcquisition(
      opts.assetAcquisitionDate, opts.costEstimateDate, totalUl, opts.dayCount,
    );
  }
  return { totalUl, expiredUl };
}

/**
 * New-obligation rule: years to settlement must be at least remaining UL
 * (Total UL − Expired UL). Longer settlement is allowed; shorter is not.
 */
export function newObligationUlIssue(opts: {
  totalUl: number | null;
  expiredUl: number | null;
  yearsToSettlement: number | null;
}): NewObligationUlIssue | null {
  const totalUl = asYears(opts.totalUl);
  if (totalUl == null || totalUl < 0) {
    return {
      field: 'totalUl',
      message: 'Enter Total UL (years) so remaining life can be compared with years to settlement.',
    };
  }
  const expiredUl = asYears(opts.expiredUl) ?? 0;
  if (expiredUl < 0) {
    return { field: 'expiredUl', message: 'Expired UL cannot be negative.' };
  }
  if (expiredUl > totalUl + 1e-9) {
    return {
      field: 'expiredUl',
      message: `Expired UL (${formatYears(expiredUl)}) is greater than Total UL (${formatYears(totalUl)}). Expired UL cannot exceed Total UL.`,
    };
  }
  const remaining = round4(totalUl - expiredUl);
  const yts = asYears(opts.yearsToSettlement);
  if (yts == null) {
    return {
      field: 'settlement',
      message: 'Enter an expected settlement date so years to settlement can be compared with remaining UL.',
    };
  }
  if (yts < -1e-9) {
    return {
      field: 'settlement',
      message: 'Expected settlement cannot fall before the cost estimate date.',
    };
  }
  if (yts + 1e-9 < remaining) {
    return {
      field: 'settlement',
      message: `Years to settlement (${formatYears(yts)}) is shorter than remaining UL (${formatYears(remaining)}). Expected settlement must be far enough out that time to settlement is at least remaining UL (Total UL − Expired UL).`,
    };
  }
  return null;
}

/** Parse a Total UL / Expired UL draft field. Empty is omitted; non-numeric is invalid. */
export function parseUlDraft(s: string): number | null | 'invalid' {
  if (!s.trim()) return null;
  const n = parseNumber(s);
  return Number.isFinite(n) ? n : 'invalid';
}

/** Resolve listing defaults and run the new-obligation UL gate from form text. */
export function evaluateNewAroLifeDraft(opts: {
  totalUlText: string;
  expiredUlText: string;
  tca?: { totalUl?: number | null; expiredUl?: number | null } | null;
  assetAcquisitionDate: string;
  costEstimateDate: string;
  settlementDate: string;
  dayCount: DayCount | string;
}): {
  totalUl: number | null;
  expiredUl: number | null;
  remainingUl: number | null;
  yearsToSettlement: number | null;
  issue: NewObligationUlIssue | null;
} {
  const yts = yearsToSettlement(opts.costEstimateDate, opts.settlementDate, opts.dayCount);
  const parsedTotal = parseUlDraft(opts.totalUlText);
  if (parsedTotal === 'invalid') {
    return {
      totalUl: null, expiredUl: null, remainingUl: null, yearsToSettlement: yts,
      issue: { field: 'totalUl', message: 'Total UL is not a number of years.' },
    };
  }
  const parsedExpired = parseUlDraft(opts.expiredUlText);
  if (parsedExpired === 'invalid') {
    return {
      totalUl: parsedTotal, expiredUl: null, remainingUl: remainingUlYears(parsedTotal, null), yearsToSettlement: yts,
      issue: { field: 'expiredUl', message: 'Expired UL is not a number of years.' },
    };
  }
  const resolved = resolveNewAroUl({
    inputTotalUl: parsedTotal,
    inputExpiredUl: parsedExpired,
    tca: opts.tca,
    assetAcquisitionDate: opts.assetAcquisitionDate,
    costEstimateDate: opts.costEstimateDate,
    dayCount: opts.dayCount,
  });
  return {
    ...resolved,
    remainingUl: remainingUlYears(resolved.totalUl, resolved.expiredUl),
    yearsToSettlement: yts,
    issue: newObligationUlIssue({
      totalUl: resolved.totalUl,
      expiredUl: resolved.expiredUl,
      yearsToSettlement: yts,
    }),
  };
}

/** Keep a user's UL override when the linked TCA changes; otherwise take the listing. */
export function nextUlDraftFromTca(opts: {
  formTotal: string;
  formExpired: string;
  prevTca?: { totalUl?: number | null; expiredUl?: number | null } | null;
  nextTca?: { totalUl?: number | null; expiredUl?: number | null } | null;
}): { totalUl: string; expiredUl: string } {
  const prevTotal = tcaUlText(opts.prevTca?.totalUl);
  const prevExpired = tcaUlText(opts.prevTca?.expiredUl);
  return {
    totalUl: opts.formTotal && opts.formTotal !== prevTotal ? opts.formTotal : tcaUlText(opts.nextTca?.totalUl),
    expiredUl: opts.formExpired && opts.formExpired !== prevExpired ? opts.formExpired : tcaUlText(opts.nextTca?.expiredUl),
  };
}
