/**
 * Date helpers — ENGINE-SPEC §1 (day count) and §8 (totality).
 *
 * Every helper here is TOTAL: given a malformed or half-typed string it returns
 * the input unchanged. It never returns NaN and it never throws. A user typing
 * "2026-1" into a year-end field must not be able to reach `toISOString()` on an
 * Invalid Date and throw out of render.
 *
 * All dates are ISO `YYYY-MM-DD` and all arithmetic is UTC.
 */

export type ISODate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parsed calendar parts. `null` when the input is not a real ISO date. */
export interface DateParts {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

/**
 * Strict ISO parse. Rejects anything that is not `YYYY-MM-DD` naming a real
 * calendar day — "2026-02-30" and "2026-13-01" are not dates.
 */
export function parseISO(s: unknown): DateParts | null {
  if (typeof s !== 'string') return null;
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  if (d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

/** True when `s` is a real ISO calendar date. */
export function isValidDate(s: unknown): s is ISODate {
  return parseISO(s) !== null;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function toISO(p: DateParts): ISODate {
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

/**
 * The day after `s`. Total: a malformed input is returned unchanged.
 * Used for the leap-year shift in ENGINE-SPEC §3.
 */
export function nextDay(s: string): string {
  const p = parseISO(s);
  if (!p) return s;
  if (p.d < daysInMonth(p.y, p.m)) return toISO({ ...p, d: p.d + 1 });
  if (p.m < 12) return toISO({ y: p.y, m: p.m + 1, d: 1 });
  return toISO({ y: p.y + 1, m: 1, d: 1 });
}

/** Calendar year of an ISO date, or `null` if it is not one. */
export function yearOf(s: string): number | null {
  const p = parseISO(s);
  return p ? p.y : null;
}

/**
 * 30/360 US (NASD) day count — ENGINE-SPEC §1.
 *
 *   d1 = day(a); d2 = day(b)
 *   if d1 == 31: d1 = 30
 *   if d2 == 31 and d1 == 30: d2 = 30
 *   return (year(b)-year(a))*360 + (month(b)-month(a))*30 + (d2-d1)
 *
 * This is the pseudocode from the spec, implemented verbatim. It agrees with
 * Excel's `DAYS360(a, b, FALSE)` (the US/NASD method), including Excel's
 * omission of the strict-NASD end-of-February rule: Excel does not fold the
 * last day of February to 30, and neither do we.
 *
 * The `d2 == 31 && d1 < 30` case is deliberately left with d2 = 31. That is
 * arithmetically identical to NASD's "roll d2 to the 1st of the next month"
 * (+30 +1 = +31) under this formula.
 *
 * Total: returns 0 if either date is malformed.
 */
export function days360(a: string, b: string): number {
  const pa = parseISO(a);
  const pb = parseISO(b);
  if (!pa || !pb) return 0;
  let d1 = pa.d;
  let d2 = pb.d;
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;
  return (pb.y - pa.y) * 360 + (pb.m - pa.m) * 30 + (d2 - d1);
}

/**
 * 30E/360 European — Excel DAYS360(a, b, TRUE). A 31st folds to a 30th on
 * both ends, unconditionally.
 */
export function days360eu(a: string, b: string): number {
  const pa = parseISO(a);
  const pb = parseISO(b);
  if (!pa || !pb) return 0;
  const d1 = pa.d === 31 ? 30 : pa.d;
  const d2 = pb.d === 31 ? 30 : pb.d;
  return (pb.y - pa.y) * 360 + (pb.m - pa.m) * 30 + (d2 - d1);
}

/** Calendar days between two ISO dates. Total: 0 if either date is malformed. */
export function actualDays(a: string, b: string): number {
  const pa = parseISO(a);
  const pb = parseISO(b);
  if (!pa || !pb) return 0;
  return (Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000;
}

export type DayCount =
  | '30/360 US (DAYS360)'
  | '30E/360 (European)'
  | 'Actual/365'
  | 'Actual/360'
  | 'Actual/Actual';

export const DAY_COUNTS: DayCount[] = [
  '30/360 US (DAYS360)',
  '30E/360 (European)',
  'Actual/365',
  'Actual/360',
  'Actual/Actual',
];

export const DEFAULT_DAY_COUNT: DayCount = '30/360 US (DAYS360)';

export function isThirty360(dayCount: string): boolean {
  return dayCount.startsWith('30');
}

/**
 * Term in years under the selected day count. Default remains 30/360 US.
 */
export function termYears(a: string, b: string, dayCount: DayCount | string = DEFAULT_DAY_COUNT): number {
  switch (dayCount) {
    case '30E/360 (European)':
      return days360eu(a, b) / 360;
    case 'Actual/365':
      return actualDays(a, b) / 365;
    case 'Actual/360':
      return actualDays(a, b) / 360;
    case 'Actual/Actual':
      return termActualActual(a, b);
    default:
      return term360(a, b);
  }
}

/** ISDA actual/actual: each calendar-year slice is divided by that year's length. */
function termActualActual(a: string, b: string): number {
  const pa = parseISO(a);
  const pb = parseISO(b);
  if (!pa || !pb) return 0;
  if (a === b) return 0;
  const sign = a < b ? 1 : -1;
  const start = sign === 1 ? a : b;
  const end = sign === 1 ? b : a;
  const startP = sign === 1 ? pa : pb;
  const endP = sign === 1 ? pb : pa;
  let sum = 0;
  for (let y = startP.y; y <= endP.y; y++) {
    const sliceStart = y === startP.y ? start : toISO({ y, m: 1, d: 1 });
    const sliceEnd = y === endP.y ? end : toISO({ y: y + 1, m: 1, d: 1 });
    const dim = isLeapYear(y) ? 366 : 365;
    sum += actualDays(sliceStart, sliceEnd) / dim;
  }
  return sign * sum;
}

/**
 * Term in years on the 30/360 US basis.
 */
export function term360(a: string, b: string): number {
  return days360(a, b) / 360;
}

/**
 * The prior financial year end — same month-day, one year earlier.
 * FY ending 2027-03-31 returns 2026-03-31.
 */
export function priorYearEnd(fyEnd: string): string {
  return addMonths(fyEnd, -12);
}

/**
 * Add whole months, clamping the day to the end of the target month.
 * Used to build fiscal calendars, not by the measurement chain.
 */
export function addMonths(s: string, n: number): string {
  const p = parseISO(s);
  if (!p) return s;
  const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return toISO({ y, m, d: Math.min(p.d, daysInMonth(y, m)) });
}

/** Add whole days. Total. */
export function addDays(s: string, n: number): string {
  const p = parseISO(s);
  if (!p) return s;
  const t = Date.UTC(p.y, p.m - 1, p.d) + n * 86400000;
  const d = new Date(t);
  return toISO({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
}

/** Chronological compare. Malformed dates sort last, stably. */
export function cmpDate(a: string, b: string): number {
  const pa = parseISO(a);
  const pb = parseISO(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Digits-only input mask for standalone date fields — ENGINE-SPEC §8, layer 3.
 * Inserts dashes as the user types and only ever returns a partial string;
 * the caller commits when `isValidDate` accepts it.
 */
export function maskDateInput(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}
