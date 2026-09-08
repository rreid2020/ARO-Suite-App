/**
 * Accounting periods — INVARIANTS §8.
 *
 * "The fiscal calendar belongs to the reporting unit, not the session: a June
 * year-end subsidiary and a December parent coexist in one tenant. Period codes
 * carry the fiscal year, not the calendar year the period end falls in."
 */

import { addDays, addMonths, daysInMonth, parseISO, isValidDate, toISO } from '../engine/dates';
import { canLockPeriod, signLevel } from './authority';

/**
 * Add months, keeping a month end a month end.
 *
 * A 30 June year end must produce a 31 July period end, not a 30 July one:
 * plain day-clamping drifts a short month onto every later period and the
 * roll-forward then straddles a day. If the anchor is not its own month end
 * (a 25 December year end, say) the day of the month is kept instead.
 */
function addMonthsAnchored(s: string, n: number): string {
  const p = parseISO(s);
  if (!p) return s;
  const shifted = addMonths(s, n);
  if (p.d !== daysInMonth(p.y, p.m)) return shifted;
  const q = parseISO(shifted);
  return q ? toISO({ ...q, d: daysInMonth(q.y, q.m) }) : shifted;
}

/** Future → Open → Soft closed → Closed → Locked. */
export type PeriodStatus = 'Future' | 'Open' | 'Soft closed' | 'Closed' | 'Locked';

export const PERIOD_STATUSES: PeriodStatus[] = ['Future', 'Open', 'Soft closed', 'Closed', 'Locked'];

export interface Period {
  id: string;
  unitId: string;
  /** 1-based period number within the fiscal year. */
  no: number;
  /** The FISCAL year, not the calendar year the period end falls in. */
  fiscalYear: number;
  /** e.g. "FY2026 P07". */
  code: string;
  starts: string;
  ends: string;
  status: PeriodStatus;
}

export type CalendarType = 'Monthly (12)' | 'Quarterly (4)' | '4-4-5 (12)';

export const CALENDAR_TYPES: CalendarType[] = ['Monthly (12)', 'Quarterly (4)', '4-4-5 (12)'];

/**
 * Build a unit's fiscal calendar working backwards from its year end.
 *
 * The fiscal year is named for the year end. A unit with a 30 June 2026 year end
 * has FY2026 P01 starting 1 July 2025 — the period code carries 2026 even though
 * the period ends in 2025.
 */
export function buildCalendar(
  unitId: string,
  fyEnd: string,
  type: CalendarType = 'Monthly (12)',
): Period[] {
  const end = parseISO(fyEnd);
  if (!end) return [];
  const fiscalYear = end.y;
  const count = type === 'Quarterly (4)' ? 4 : 12;
  const monthsPer = 12 / count;

  const periods: Period[] = [];
  for (let i = count; i >= 1; i--) {
    const ends = addMonthsAnchored(fyEnd, -monthsPer * (count - i));
    const starts = addDays(addMonthsAnchored(ends, -monthsPer), 1);
    periods.push({
      id: `${unitId}-FY${fiscalYear}-P${String(i).padStart(2, '0')}`,
      unitId,
      no: i,
      fiscalYear,
      code: `FY${fiscalYear} P${String(i).padStart(2, '0')}`,
      starts,
      ends,
      status: 'Future',
    });
  }
  return periods.reverse();
}

/** First day of the named fiscal year, from the unit calendar. */
export function fiscalYearStart(periods: Period[], fiscalYear: number): string | undefined {
  const first = periods.filter((p) => p.fiscalYear === fiscalYear).sort((a, b) => a.no - b.no)[0];
  return first?.starts;
}

export interface TransitionCheck {
  allowed: boolean;
  /** Stated in the accounting, not in the UI — README, "Interactions". */
  reason: string;
}

const ORDER: PeriodStatus[] = ['Future', 'Open', 'Soft closed', 'Closed', 'Locked'];

/**
 * Can `role` move `period` to `to`?
 *
 * Close is preparer/reviewer; lock and reopen are partner-only. Every allowed
 * transition is logged by the caller through the write path.
 */
export function canTransition(period: Period, to: PeriodStatus, role: string): TransitionCheck {
  const from = period.status;
  if (from === to) return { allowed: false, reason: `${period.code} is already ${to.toLowerCase()}.` };

  const fromIdx = ORDER.indexOf(from);
  const toIdx = ORDER.indexOf(to);
  const reopening = toIdx < fromIdx;

  if (from === 'Locked' && !canLockPeriod(role)) {
    return {
      allowed: false,
      reason: `${period.code} is locked. Only an engagement partner can reopen a locked period.`,
    };
  }

  if (to === 'Locked' && !canLockPeriod(role)) {
    return {
      allowed: false,
      reason: `Locking ${period.code} is an engagement partner action. A lock is what makes the period evidence rather than a working figure.`,
    };
  }

  if (reopening && signLevel(role) !== 2) {
    return {
      allowed: false,
      reason: `Reopening ${period.code} from ${from.toLowerCase()} is an engagement partner action, because it puts a closed figure back in play.`,
    };
  }

  if (!reopening && toIdx > fromIdx + 1) {
    return {
      allowed: false,
      reason: `${period.code} cannot go straight from ${from.toLowerCase()} to ${to.toLowerCase()}. The sequence is Future → Open → Soft closed → Closed → Locked and it cannot be skipped.`,
    };
  }

  if (signLevel(role) === null) {
    return { allowed: false, reason: `This role cannot change the status of ${period.code}.` };
  }

  return { allowed: true, reason: `${period.code} moves from ${from.toLowerCase()} to ${to.toLowerCase()}.` };
}

/** INVARIANTS §8 — "Posting into a locked period is refused." */
export function canPostInto(period: Period | undefined): TransitionCheck {
  if (!period) {
    return { allowed: false, reason: 'The batch names no accounting period, so there is nothing to post it into.' };
  }
  if (period.status === 'Locked') {
    return { allowed: false, reason: `The batch cannot post because ${period.code} is locked.` };
  }
  if (period.status === 'Closed') {
    return { allowed: false, reason: `The batch cannot post because ${period.code} is closed. Reopen it, or record the entry as a prior-period adjustment in the open period.` };
  }
  if (period.status === 'Future') {
    return { allowed: false, reason: `The batch cannot post because ${period.code} has not opened yet.` };
  }
  return { allowed: true, reason: `${period.code} is ${period.status.toLowerCase()} and will accept the batch.` };
}

/**
 * Late-arriving data is handled by a per-unit policy, not ad hoc — INVARIANTS §8.
 */
export type LatePolicy = 'Prior-period adjustment' | 'Reopen the period';

export const LATE_POLICIES: LatePolicy[] = ['Prior-period adjustment', 'Reopen the period'];

export function latePolicyNote(policy: LatePolicy): string {
  return policy === 'Prior-period adjustment'
    ? 'Data arriving after a period has closed is recorded in the current open period as a prior-period adjustment, and the roll-forward shows it as such.'
    : 'Data arriving after a period has closed reopens that period. Reopening is an engagement partner action and every reopen is logged.';
}

export const periodFor = (periods: Period[], date: string): Period | undefined =>
  isValidDate(date) ? periods.find((p) => p.starts <= date && date <= p.ends) : undefined;
