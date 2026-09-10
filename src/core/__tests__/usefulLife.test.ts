import { describe, expect, it } from 'vitest';
import {
  applyUlAlignment, dismissUlAlignment, evaluateNewAroLifeDraft, expiredUlFromAcquisition, formatUl,
  newObligationUlIssue, nextUlDraftFromTca, proposeUlAlignment, remainingUlYears, suggestedSettlementDate,
  tcaAroUlGap, ulAlignmentPending, ulOutOfLine, usefulLifeAsAt, yearsToPeriods, yearsToSettlement, termToSettlementAtYearStart,
  withSettlementFromRemaining,
} from '../usefulLife';
import type { Obligation, ReportingUnit } from '../types';
import type { Period } from '../periods';
import type { ObligationEvent } from '../../engine/rollforward';

function period(over: Partial<Period> & Pick<Period, 'id' | 'no'>): Period {
  return {
    unitId: 'u', fiscalYear: 2027, code: `FY2027 P${String(over.no).padStart(2, '0')}`,
    starts: '2026-04-01', ends: '2026-04-30', status: 'Open',
    ...over,
  };
}

function o(over: Partial<Obligation> = {}): Obligation {
  return {
    id: 'o1', ref: 'ARO-1', description: 'Well', costEstimateDate: '2026-03-31',
    settlementDate: '2041-03-31', lines: [], adj: [], status: 'In scope',
    openingArc: 800, totalUl: 20, expiredUl: 0,
    ...over,
  };
}

const unit = {
  fyEnd: '2027-03-31',
  dayCount: '30/360 US (DAYS360)',
  calendarType: 'Monthly (12)',
} as ReportingUnit;

const p1 = period({ id: 'p1', no: 1, status: 'Closed' });
const p2 = period({ id: 'p2', no: 2, status: 'Open', starts: '2026-05-01', ends: '2026-05-31' });
const periods = [p1, p2];

describe('formatUl', () => {
  it('shows years and months on a monthly calendar', () => {
    expect(formatUl(20, 'Monthly (12)')).toBe('20 yr · 240 mo');
    expect(yearsToPeriods(15, 'Monthly (12)')).toBe(180);
  });

  it('shows years and quarters on a quarterly calendar', () => {
    expect(formatUl(20, 'Quarterly (4)')).toBe('20 yr · 80 qtr');
  });
});

describe('usefulLifeAsAt', () => {
  it('starts from conversion expired and remaining', () => {
    const life = usefulLifeAsAt(o({ totalUl: 25, expiredUl: 10 }), [], periods, unit, p1);
    expect(life.totalYears).toBe(25);
    expect(life.expiredYears).toBe(10);
    expect(life.remainingYears).toBe(15);
    expect(life.remainingPeriods).toBe(180);
  });

  it('adds posted months to expired and reduces remaining', () => {
    const events: ObligationEvent[] = [
      { id: 'd1', obligationId: 'o1', periodId: 'p1', type: 'depreciation', date: '2026-04-30', amount: 40 },
    ];
    const atP1 = usefulLifeAsAt(o(), events, periods, unit, p1);
    expect(atP1.expiredYears).toBeCloseTo(1 / 12, 4);
    expect(atP1.remainingYears).toBeCloseTo(20 - 1 / 12, 4);
    const startP2 = usefulLifeAsAt(o(), events, periods, unit, p2, true);
    expect(startP2.expiredYears).toBeCloseTo(1 / 12, 4);
    const atP2 = usefulLifeAsAt(o(), events, periods, unit, p2);
    expect(atP2.expiredYears).toBeCloseTo(1 / 12, 4);
  });
});

describe('useful-life alignment', () => {
  it('flags when remaining UL is shorter than the new settlement term by more than a period', () => {
    expect(ulOutOfLine(15, 18, 1 / 12)).toBe(true);
    expect(ulOutOfLine(15, 15.04, 1 / 12)).toBe(false);
  });

  it('proposes a total UL that restores remaining life to the settlement term', () => {
    const row = o({ totalUl: 25, expiredUl: 10, settlementDate: '2027-03-31' });
    const flag = proposeUlAlignment(row, [], periods, unit, p1, 'rev-1', '2045-03-31', 'Ada');
    expect(flag).toBeDefined();
    expect(flag!.status).toBe('Pending review');
    expect(flag!.proposedRemainingUl).toBeGreaterThan(15);
    expect(flag!.proposedTotalUl).toBeCloseTo(10 + flag!.proposedRemainingUl, 4);
    const pending = { ...row, ulAlignment: flag };
    expect(ulAlignmentPending(pending)).toBe(true);
    const approved = applyUlAlignment(pending, 'Bea');
    expect(approved.totalUl).toBe(flag!.proposedTotalUl);
    expect(ulAlignmentPending(approved)).toBe(false);
  });

  it('does not raise a flag when remaining UL already matches the settlement term', () => {
    const row = o({ totalUl: 20, expiredUl: 0, settlementDate: '2046-04-30' });
    expect(proposeUlAlignment(row, [], periods, unit, p1, 'rev-1', '2046-04-30')).toBeUndefined();
  });

  it('leaves total UL unchanged when the flag is dismissed', () => {
    const row = o({ totalUl: 20, expiredUl: 0 });
    const flag = proposeUlAlignment(row, [], periods, unit, p1, 'rev-1', '2045-03-31')!;
    const dismissed = dismissUlAlignment({ ...row, ulAlignment: flag }, 'Bea');
    expect(dismissed.totalUl).toBe(20);
    expect(ulAlignmentOfStatus(dismissed)).toBe('Dismissed');
  });
});

describe('term to settlement at fiscal-year start', () => {
  it('is one year shorter when the next fiscal year begins', () => {
    const row = o({ settlementDate: '2041-04-01' });
    const y0 = termToSettlementAtYearStart(row, unit, '2026-04-01');
    const y1 = termToSettlementAtYearStart(row, unit, '2027-04-01');
    expect(y0).toBeCloseTo(15, 6);
    expect(y1).toBeCloseTo(14, 6);
    expect(y0! - y1!).toBeCloseTo(1, 6);
  });

  it('ignores a term revision dated on or after the year start', () => {
    const row = o({
      settlementDate: '2041-04-01',
      adj: [{ id: 't1', kind: 'term', to: '2046-04-01', date: '2026-04-16', reason: 'Deferred' }],
    });
    expect(termToSettlementAtYearStart(row, unit, '2026-04-01')).toBeCloseTo(15, 6);
    expect(termToSettlementAtYearStart(row, unit, '2027-04-01')).toBeCloseTo(19, 6);
  });
});

describe('expiredUlFromAcquisition', () => {
  it('measures life already consumed from in-service to the price date, capped at total UL', () => {
    expect(expiredUlFromAcquisition('2006-04-01', '2026-04-01', 25)).toBe(20);
    expect(expiredUlFromAcquisition('2006-04-01', '2026-04-01', 15)).toBe(15);
    expect(expiredUlFromAcquisition('2026-04-01', '2026-04-01', 25)).toBe(0);
  });
});

describe('new obligation UL vs settlement', () => {
  it('measures years to settlement from the cost estimate date', () => {
    expect(yearsToSettlement('2026-04-01', '2041-04-01')).toBe(15);
    expect(remainingUlYears(25, 10)).toBe(15);
  });

  it('refuses settlement shorter than remaining UL and explains why', () => {
    const issue = newObligationUlIssue({ totalUl: 25, expiredUl: 10, yearsToSettlement: 10 });
    expect(issue?.field).toBe('settlement');
    expect(issue?.message).toMatch(/shorter than remaining UL/);
    expect(issue?.message).toMatch(/15 yr/);
  });

  it('allows settlement equal to or longer than remaining UL', () => {
    expect(newObligationUlIssue({ totalUl: 25, expiredUl: 10, yearsToSettlement: 15 })).toBeNull();
    expect(newObligationUlIssue({ totalUl: 25, expiredUl: 10, yearsToSettlement: 20 })).toBeNull();
  });

  it('defaults UL from the TCA listing on the create form', () => {
    const life = evaluateNewAroLifeDraft({
      totalUlText: '',
      expiredUlText: '',
      tca: { totalUl: 25, expiredUl: 10 },
      assetAcquisitionDate: '2006-04-01',
      costEstimateDate: '2026-03-31',
      settlementDate: '2046-03-31',
      dayCount: '30/360 US (DAYS360)',
    });
    expect(life.totalUl).toBe(25);
    expect(life.expiredUl).toBe(10);
    expect(life.remainingUl).toBe(15);
    expect(life.yearsToSettlement).toBe(20);
    expect(life.issue).toBeNull();
  });

  it('keeps a typed UL override when the linked TCA changes', () => {
    const next = nextUlDraftFromTca({
      formTotal: '20',
      formExpired: '4',
      prevTca: { totalUl: 25, expiredUl: 10 },
      nextTca: { totalUl: 30, expiredUl: 5 },
    });
    expect(next.totalUl).toBe('20');
    expect(next.expiredUl).toBe('4');
    const fromListing = nextUlDraftFromTca({
      formTotal: '25',
      formExpired: '10',
      prevTca: { totalUl: 25, expiredUl: 10 },
      nextTca: { totalUl: 30, expiredUl: 5 },
    });
    expect(fromListing.totalUl).toBe('30');
    expect(fromListing.expiredUl).toBe('5');
  });

  it('defaults expected settlement from remaining UL after the cost estimate date', () => {
    expect(suggestedSettlementDate('2026-04-01', 15, '30/360 US (DAYS360)')).toBe('2041-04-01');
    const draft = {
      totalUl: '25', expiredUl: '10', assetAcquisitionDate: '2006-04-01',
      costEstimateDate: '2026-03-31', settlementDate: '',
    };
    const next = withSettlementFromRemaining(draft, draft, '30/360 US (DAYS360)');
    expect(next.settlementDate).toBe('2041-03-31');
    const later = withSettlementFromRemaining(
      next,
      { ...next, totalUl: '20' },
      '30/360 US (DAYS360)',
    );
    expect(later.settlementDate).toBe('2036-03-31');
    const kept = withSettlementFromRemaining(
      { ...next, settlementDate: '2051-03-31' },
      { ...next, totalUl: '20', settlementDate: '2051-03-31' },
      '30/360 US (DAYS360)',
    );
    expect(kept.settlementDate).toBe('2051-03-31');
  });
});

describe('tcaAroUlGap', () => {
  const tca = { totalUl: 25, expiredUl: 10 };

  it('is silent when listing remaining matches ARO remaining as-at', () => {
    expect(tcaAroUlGap(tca, o({ totalUl: 25, expiredUl: 10 }), [], periods, unit, p1)).toBeNull();
  });

  it('is silent for a sub-period drift', () => {
    expect(tcaAroUlGap({ totalUl: 25, expiredUl: 10.04 }, o({ totalUl: 25, expiredUl: 10 }), [], periods, unit, p1)).toBeNull();
  });

  it('flags when listing remaining has moved and proposes a total that restores it', () => {
    const gap = tcaAroUlGap({ totalUl: 40, expiredUl: 10 }, o({ totalUl: 25, expiredUl: 10 }), [], periods, unit, p1);
    expect(gap?.kind).toBe('remaining-diff');
    expect(gap?.tcaRemaining).toBe(30);
    expect(gap?.aroRemaining).toBe(15);
    expect(gap?.proposedTotalUl).toBe(40);
    expect(gap?.proposedExpiredUl).toBeNull();
  });

  it('flags an obligation with no UL and copies the listing figures', () => {
    const gap = tcaAroUlGap(tca, o({ totalUl: undefined, expiredUl: undefined }), [], periods, unit, p1);
    expect(gap?.kind).toBe('missing-aro-ul');
    expect(gap?.proposedTotalUl).toBe(25);
    expect(gap?.proposedExpiredUl).toBe(10);
  });

  it('does not compare when the listing has no Total UL', () => {
    expect(tcaAroUlGap({ totalUl: null, expiredUl: 10 }, o(), [], periods, unit, p1)).toBeNull();
  });
});

function ulAlignmentOfStatus(row: Obligation) {
  const raw = row.ulAlignment;
  if (!raw || typeof raw !== 'object') return undefined;
  return (raw as { status: string }).status;
}
