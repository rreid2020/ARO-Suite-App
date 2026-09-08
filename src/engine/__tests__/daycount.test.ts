/**
 * ENGINE-SPEC §9.3 — month-end day count, asserted against Excel's
 * `DAYS360(a, b, FALSE)` (the US/NASD method), in both directions.
 *
 * Note on the spec text: §9.3 says "against DAYS360(...,TRUE) from Excel".
 * `TRUE` selects Excel's *European* method, which folds a 31st to a 30th
 * unconditionally. The pseudocode given in §1 — which the spec calls the
 * reference implementation and which the README says to reproduce exactly — is
 * the US method. The pseudocode wins; the expected values below are Excel's US
 * results. The two methods disagree on exactly the rows marked EU≠US.
 */

import { describe, expect, it } from 'vitest';
import { days360, days360eu, term360, termYears, actualDays, isLeapYear, nextDay, parseISO, isValidDate, maskDateInput, addMonths, addDays, priorYearEnd } from '../dates';

describe('days360 — US/NASD, matching Excel DAYS360(a,b,FALSE)', () => {
  const cases: [string, string, number, string][] = [
    ['2025-01-31', '2025-02-28', 28, '31st start folds to 30th'],
    ['2025-01-30', '2025-03-31', 60, '31st end folds to 30th because the start is a 30th'],
    ['2025-01-15', '2025-03-31', 76, 'EU≠US: 31st end stands because the start is before the 30th'],
    ['2025-02-28', '2025-03-31', 33, 'EU≠US: end-of-February start is not folded by Excel'],
    ['2024-02-29', '2025-02-28', 359, '29 Feb to 28 Feb is 359, not 360 — Excel omits the NASD Feb rule'],
    ['2025-03-31', '2025-01-31', -60, 'reverse direction is the negation'],
    ['2025-01-31', '2025-01-31', 0, 'same day is nil'],
    ['2024-02-29', '2024-03-31', 32, 'EU≠US: leap-day start to a 31st'],
    ['2025-01-31', '2025-03-30', 60, '31st start folds to 30th, so a 30th end is two clean months'],
    ['2025-12-31', '2026-12-31', 360, 'whole year across a year end'],
  ];

  it.each(cases)('%s → %s = %i (%s)', (a, b, expected) => {
    expect(days360(a, b)).toBe(expected);
  });

  it('term360 is days360 over 360', () => {
    expect(term360('2024-12-31', '2029-12-31')).toBeCloseTo(5, 12);
    expect(term360('2024-12-31', '2025-06-30')).toBeCloseTo(0.5, 12);
  });
});

describe('days360eu — European, matching Excel DAYS360(a,b,TRUE)', () => {
  it('folds a 31st on both ends, so it disagrees with US where the start is before the 30th', () => {
    expect(days360eu('2025-01-15', '2025-03-31')).toBe(75);
    expect(days360('2025-01-15', '2025-03-31')).toBe(76);
    expect(days360eu('2025-02-28', '2025-03-31')).toBe(32);
    expect(days360('2025-02-28', '2025-03-31')).toBe(33);
  });

  it('agrees with US when both ends already fold the same way', () => {
    expect(days360eu('2025-01-31', '2025-02-28')).toBe(28);
    expect(days360eu('2025-12-31', '2026-12-31')).toBe(360);
  });
});

describe('termYears — selectable day-count conventions', () => {
  it('defaults to 30/360 US, matching term360', () => {
    expect(termYears('2024-12-31', '2029-12-31')).toBe(term360('2024-12-31', '2029-12-31'));
    expect(termYears('2025-01-15', '2025-03-31', '30/360 US (DAYS360)')).toBe(76 / 360);
  });

  it('30E/360 uses the European day count', () => {
    expect(termYears('2025-01-15', '2025-03-31', '30E/360 (European)')).toBe(75 / 360);
  });

  it('Actual/365 and Actual/360 divide calendar days by the named year length', () => {
    expect(actualDays('2025-01-01', '2026-01-01')).toBe(365);
    expect(termYears('2025-01-01', '2026-01-01', 'Actual/365')).toBeCloseTo(1, 12);
    expect(termYears('2025-01-01', '2026-01-01', 'Actual/360')).toBeCloseTo(365 / 360, 12);
    expect(termYears('2024-01-01', '2025-01-01', 'Actual/365')).toBeCloseTo(366 / 365, 12);
  });

  it('Actual/Actual slices each calendar year by that year\'s length', () => {
    expect(termYears('2024-01-01', '2025-01-01', 'Actual/Actual')).toBeCloseTo(1, 12);
    expect(termYears('2025-01-01', '2026-01-01', 'Actual/Actual')).toBeCloseTo(1, 12);
    const mixed = termYears('2024-07-01', '2025-07-01', 'Actual/Actual');
    expect(mixed).toBeCloseTo(actualDays('2024-07-01', '2025-01-01') / 366 + actualDays('2025-01-01', '2025-07-01') / 365, 12);
  });
});

describe('date helpers are total — ENGINE-SPEC §8', () => {
  it('returns the input unchanged for a half-typed date, never NaN and never a throw', () => {
    for (const bad of ['2026-1', '', 'not-a-date', '2026-13-01', '2026-02-30', '20260101']) {
      expect(() => nextDay(bad)).not.toThrow();
      expect(nextDay(bad)).toBe(bad);
      expect(addMonths(bad, 3)).toBe(bad);
      expect(addDays(bad, 3)).toBe(bad);
      expect(isValidDate(bad)).toBe(false);
      expect(parseISO(bad)).toBeNull();
    }
  });

  it('days360 with a malformed date is 0 rather than NaN', () => {
    expect(days360('2026-1', '2026-12-31')).toBe(0);
    expect(Number.isNaN(days360('x', 'y'))).toBe(false);
  });

  it('nextDay rolls month and year ends, including the leap day', () => {
    expect(nextDay('2024-02-28')).toBe('2024-02-29');
    expect(nextDay('2025-02-28')).toBe('2025-03-01');
    expect(nextDay('2024-12-31')).toBe('2025-01-01');
    expect(nextDay('2024-06-30')).toBe('2024-07-01');
  });

  it('isLeapYear follows the Gregorian rule', () => {
    expect([2024, 2000, 2020].every(isLeapYear)).toBe(true);
    expect([2023, 1900, 2100, 2025].some(isLeapYear)).toBe(false);
  });

  it('the input mask only ever emits a partial date — ENGINE-SPEC §8 layer 3', () => {
    expect(maskDateInput('2')).toBe('2');
    expect(maskDateInput('2026')).toBe('2026');
    expect(maskDateInput('20261')).toBe('2026-1');
    expect(maskDateInput('202612')).toBe('2026-12');
    expect(maskDateInput('20261231')).toBe('2026-12-31');
    expect(maskDateInput('2026/12/31')).toBe('2026-12-31');
    expect(maskDateInput('202612319999')).toBe('2026-12-31');
  });

  it('priorYearEnd is the same month-day one year earlier', () => {
    expect(priorYearEnd('2027-03-31')).toBe('2026-03-31');
    expect(priorYearEnd('2024-02-29')).toBe('2023-02-28');
  });
});
