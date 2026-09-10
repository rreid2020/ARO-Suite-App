/**
 * ARO-asset useful life: years and periods, rolled forward as months post,
 * and a review-and-approve alignment when a term adjustment leaves remaining
 * life out of line with the settlement date.
 *
 * Conversion stores total and expired UL in years. Expired and remaining as at
 * a period add the year fractions of amortization already on the event ledger.
 * A term revision does not silently change UL — it raises a pending flag.
 */

import { isValidDate, nextDay, priorYearEnd, termYears, addTermYears, type DayCount } from '../engine/dates';
import { settlementAsAt, settlementInForce, type Obligation } from '../engine/derive';
import type { ObligationEvent } from '../engine/rollforward';
import { years as formatYears, num, parseNumber } from './format';
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

export interface UlParts {
  years: number;
  months: number;
}

/** Whole years and leftover months. 17.75 years is 17 yr · 9 mo. */
export function splitUlYears(yearsVal: number): UlParts {
  const sign = yearsVal < 0 || Object.is(yearsVal, -0) ? -1 : 1;
  const abs = Math.abs(yearsVal);
  const monthsTotal = round4(abs * 12);
  let years = Math.floor(monthsTotal / 12 + 1e-9);
  let months = round4(monthsTotal - years * 12);
  if (months >= 12 - 1e-9) {
    years += 1;
    months = 0;
  }
  if (Math.abs(months) < 1e-9) months = 0;
  return { years: sign * years, months: sign * months };
}

export function yearsFromUlParts(years: number, months: number): number {
  return round4(years + months / 12);
}

/**
 * Years from a listing or form value. "30", "17.75", and "17 yr · 9 mo" all load.
 */
export function parseUlYears(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (/yr|year|mo|month|·/i.test(s)) {
    const compact = s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const m = compact.match(/^(-?\d+(?:\.\d+)?)\s*(?:yr|yrs|y|year|years)?\s*(?:[·;]|and)?\s*(-?\d+(?:\.\d+)?)?\s*(?:mo|mos|m|month|months)?$/i);
    if (m) {
      const y = Number(m[1]);
      const mo = m[2] != null && m[2] !== '' ? Number(m[2]) : 0;
      if (Number.isFinite(y) && Number.isFinite(mo)) return yearsFromUlParts(y, mo);
    }
    return NaN;
  }
  return parseNumber(s);
}

/** "17 yr · 9 mo" — whole years and leftover months so a partial year is readable. */
export function formatUl(
  yearsVal: number | null | undefined,
  _calendar?: CalendarType | string,
): string {
  if (yearsVal == null || !Number.isFinite(yearsVal)) return '—';
  const { years, months } = splitUlYears(yearsVal);
  return `${num(years)} yr · ${num(months, 2)} mo`;
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
      totalYears: total, expiredYears: openExpired, remainingYears: remainingUlYears(total, openExpired),
      totalPeriods: total == null ? null : yearsToPeriods(total, calendar),
      expiredPeriods: openExpired == null ? null : yearsToPeriods(openExpired, calendar),
      remainingPeriods: remainingUlYears(total, openExpired) == null ? null : yearsToPeriods(remainingUlYears(total, openExpired)!, calendar),
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

/** One calendar period in years — the same tolerance used for UL review. */
export function periodYearFraction(calendar: CalendarType | string | undefined): number {
  return 1 / periodsPerYear(calendar);
}

export type TcaAroUlGapKind = 'missing-aro-ul' | 'remaining-diff';

/**
 * Master TCA remaining life versus the linked ARO remaining as-at.
 * Call this only after listing Expired UL has been proved from acquisition
 * to conversion. Listing remaining is Total UL − Expired UL on the TCA.
 * ARO remaining rolls opening expired plus posted amortization.
 */
export interface TcaAroUlGap {
  kind: TcaAroUlGapKind;
  tcaTotal: number | null;
  tcaExpired: number | null;
  tcaRemaining: number;
  aroTotal: number | null;
  aroExpired: number | null;
  aroRemaining: number | null;
  /** Total UL that restores ARO remaining as-at to the listing remaining. */
  proposedTotalUl: number;
  /** Set when the obligation has no UL yet — copy expired from the listing. */
  proposedExpiredUl: number | null;
}

export function tcaAroUlGap(
  tca: { totalUl?: number | null; expiredUl?: number | null },
  o: Obligation,
  events: ObligationEvent[],
  periods: Period[],
  unit: Pick<ReportingUnit, 'dayCount' | 'calendarType'>,
  asAt: Period | undefined,
): TcaAroUlGap | null {
  const tcaRemaining = remainingUlYears(tca.totalUl, tca.expiredUl);
  if (tcaRemaining == null) return null;
  const tcaTotal = asYears(tca.totalUl);
  const tcaExpired = asYears(tca.expiredUl) ?? 0;
  const life = usefulLifeAsAt(o, events, periods, unit, asAt);
  if (life.totalYears == null) {
    return {
      kind: 'missing-aro-ul',
      tcaTotal, tcaExpired, tcaRemaining,
      aroTotal: null, aroExpired: openingExpired(o), aroRemaining: remainingUlYears(asYears(o.totalUl), openingExpired(o)),
      proposedTotalUl: tcaTotal ?? tcaRemaining,
      proposedExpiredUl: tcaExpired,
    };
  }
  if (!ulOutOfLine(tcaRemaining, life.remainingYears ?? 0, periodYearFraction(unit.calendarType))) return null;
  const expiredAsAt = life.expiredYears ?? 0;
  return {
    kind: 'remaining-diff',
    tcaTotal, tcaExpired, tcaRemaining,
    aroTotal: life.totalYears, aroExpired: expiredAsAt, aroRemaining: life.remainingYears,
    proposedTotalUl: round4(expiredAsAt + tcaRemaining),
    proposedExpiredUl: null,
  };
}

/**
 * Opening of the current fiscal year (prior year end / conversion as-at).
 * Listing Expired UL is life consumed from the TCA acquisition date to this date.
 * A same-day acquisition and conversion has zero expired UL.
 */
export function tcaListingAsAt(unit: Pick<ReportingUnit, 'fyEnd'>): string {
  return priorYearEnd(unit.fyEnd);
}

export interface ListingExpiredUlIssue {
  asAt: string;
  expectedExpired: number;
  listedExpired: number;
  expectedRemaining: number | null;
}

/**
 * Expired UL on the master TCA listing must equal elapsed life from acquisition
 * to the listing as-at (conversion date, or the open period end). A newly
 * acquired asset at conversion has zero expired UL. A wrong listing figure is
 * corrected on the listing — it is not copied onto the ARO.
 */
export function listingExpiredUlIssue(
  tca: { acquisitionDate?: string; totalUl?: number | null; expiredUl?: number | null },
  asAt: string,
  dayCount: DayCount | string,
  calendar?: CalendarType | string,
): ListingExpiredUlIssue | null {
  const total = asYears(tca.totalUl);
  if (total == null || !isValidDate(tca.acquisitionDate) || !isValidDate(asAt)) return null;
  const expectedExpired = expiredUlFromAcquisition(tca.acquisitionDate, asAt, total, dayCount);
  if (expectedExpired == null) return null;
  const listedExpired = asYears(tca.expiredUl) ?? 0;
  if (!ulOutOfLine(expectedExpired, listedExpired, periodYearFraction(calendar))) return null;
  return {
    asAt,
    expectedExpired,
    listedExpired,
    expectedRemaining: remainingUlYears(total, expectedExpired),
  };
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
  const n = parseUlYears(s);
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

/** Cost-estimate date plus remaining UL years under the unit day count. */
export function suggestedSettlementDate(
  costEstimateDate: string,
  remainingUl: number | null | undefined,
  dayCount: DayCount | string,
): string {
  const rem = asYears(remainingUl);
  if (rem == null || rem < 0 || !isValidDate(costEstimateDate)) return '';
  return addTermYears(costEstimateDate, rem, dayCount);
}

export type NewAroLifeForm = {
  totalUl: string;
  expiredUl: string;
  assetAcquisitionDate: string;
  costEstimateDate: string;
  settlementDate: string;
};

function lifeFromForm(
  form: NewAroLifeForm,
  tca: { totalUl?: number | null; expiredUl?: number | null } | null | undefined,
  dayCount: DayCount | string,
) {
  return evaluateNewAroLifeDraft({
    totalUlText: form.totalUl,
    expiredUlText: form.expiredUl,
    tca,
    assetAcquisitionDate: form.assetAcquisitionDate,
    costEstimateDate: form.costEstimateDate,
    settlementDate: form.settlementDate,
    dayCount,
  });
}

/**
 * Follow remaining UL into expected settlement until the user types a
 * different date. An empty field, or one that still matches the previous
 * suggestion, updates when Total UL, Expired UL, or the cost estimate date change.
 */
export function withSettlementFromRemaining<T extends NewAroLifeForm>(
  previous: T,
  next: T,
  dayCount: DayCount | string,
  previousTca?: { totalUl?: number | null; expiredUl?: number | null } | null,
  nextTca?: { totalUl?: number | null; expiredUl?: number | null } | null,
): T {
  const prevSuggested = suggestedSettlementDate(
    previous.costEstimateDate, lifeFromForm(previous, previousTca, dayCount).remainingUl, dayCount,
  );
  const nextSuggested = suggestedSettlementDate(
    next.costEstimateDate, lifeFromForm(next, nextTca ?? previousTca, dayCount).remainingUl, dayCount,
  );
  const follow = !next.settlementDate.trim() || next.settlementDate === prevSuggested;
  return { ...next, settlementDate: follow ? nextSuggested : next.settlementDate };
}
