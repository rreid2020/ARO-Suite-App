import { describe, expect, it } from 'vitest';
import { accretionSchedule, amortizationSchedule } from '../schedules';
import type { JournalBatch, Obligation, ReportingUnit } from '../types';
import type { Period } from '../periods';
import type { ObligationEvent } from '../../engine/rollforward';
import type { Curve } from '../../engine/curve';

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
    openingArc: 800, totalUl: 25, expiredUl: 10,
    ...over,
  };
}

function ev(over: Partial<ObligationEvent> & Pick<ObligationEvent, 'id' | 'type' | 'amount'>): ObligationEvent {
  return { obligationId: 'o1', periodId: 'p1', date: '2026-04-30', ...over };
}

function batch(eventIds: string[]): JournalBatch {
  return {
    id: 'b1', unitId: 'u', periodId: 'p1', number: 'JB-001', status: 'Posted',
    lines: eventIds.map((eventId, i) => ({
      ord: i + 1, accountId: 'a', coding: {}, debit: 0, credit: 0, eventId, obligationId: 'o1',
    })),
  };
}

const unit: ReportingUnit = {
  id: 'u', tenantId: 't1', entity: 'Infra', fyEnd: '2027-03-31', currency: 'CAD',
  inflation: 0.02, contingency: 0, dayCount: '30/360 US (DAYS360)',
  termConvention: 'Round up to whole year (SAP)', calendarType: 'Monthly (12)',
  frameworkId: 'psas', discount: true, curveId: 'cad',
} as ReportingUnit;

const curve: Curve = {
  id: 'cad', name: 'CAD', currency: 'CAD', source: 'test', basis: 'zero',
  interpolation: 'step', extrapolation: 'flat-last', asAt: '2026-03-31',
  points: [{ term: 1, rate: 0.03 }, { term: 15, rate: 0.12 }, { term: 25, rate: 0.12 }],
};

const p1 = period({ id: 'p1', no: 1, status: 'Closed' });
const p2 = period({ id: 'p2', no: 2, status: 'Open', starts: '2026-05-01', ends: '2026-05-31' });
const periods = [p1, p2];

describe('accretionSchedule', () => {
  it('schedules unwinding on the opening provision when nothing has been allocated', () => {
    const row = o();
    const events = [ev({ id: 'open', type: 'opening', amount: 1_200 })];
    const sched = accretionSchedule(row, events, periods, [], unit, curve, 2027);
    expect(sched).toHaveLength(2);
    expect(sched[0].opening).toBe(1_200);
    expect(sched[0].charge).toBe(12);
    expect(sched[0].closing).toBe(1_212);
    expect(sched[0].status).toBe('Scheduled');
    expect(sched[1].opening).toBe(1_212);
    expect(sched[1].charge).toBe(12.12);
    expect(sched[1].status).toBe('Scheduled');
  });

  it('accretes on opening plus in-period activity, without folding activity into opening', () => {
    const row = o();
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_200 }),
      ev({ id: 'add', type: 'addition', amount: 300, periodId: 'p1', date: '2026-04-15' }),
    ];
    const sched = accretionSchedule(row, events, periods, [], unit, curve, 2027);
    expect(sched[0].opening).toBe(1_200);
    expect(sched[0].activity).toBe(300);
    expect(sched[0].charge).toBe(15);
    expect(sched[0].closing).toBe(1_515);
  });

  it('uses the allocated amount when month-end has been run, and marks it posted', () => {
    const row = o();
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_200 }),
      ev({ id: 'accr', type: 'accretion', amount: 12 }),
    ];
    const sched = accretionSchedule(row, events, periods, [batch(['accr'])], unit, curve, 2027);
    expect(sched[0].charge).toBe(12);
    expect(sched[0].status).toBe('Posted');
    expect(sched[1].opening).toBe(1_212);
    expect(sched[1].status).toBe('Scheduled');
  });
});

describe('amortizationSchedule', () => {
  it('schedules the period charge on opening NBV over remaining UL', () => {
    const row = o();
    const events = [ev({ id: 'open', type: 'opening', amount: 1_200 })];
    const sched = amortizationSchedule(row, events, periods, [], unit, 2027);
    expect(sched[0].opening).toBe(800);
    expect(sched[0].charge).toBeCloseTo(roundExpected(800, 15), 10);
    expect(sched[0].closing).toBeCloseTo(800 - sched[0].charge, 10);
    expect(sched[0].remainingUl).toBe(15);
    expect(sched[1].opening).toBeCloseTo(sched[0].closing, 10);
    expect(sched[1].remainingUl).toBeCloseTo(15 - 1 / 12, 4);
  });

  it('uses allocated amortization when present', () => {
    const row = o();
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_200 }),
      ev({ id: 'depr', type: 'depreciation', amount: 40 }),
    ];
    const sched = amortizationSchedule(row, events, periods, [batch(['depr'])], unit, 2027);
    expect(sched[0].charge).toBe(40);
    expect(sched[0].closing).toBe(760);
    expect(sched[0].status).toBe('Posted');
  });
});

function roundExpected(nbv: number, rem: number) {
  return Math.min(nbv, Math.round((nbv / rem) * (1 / 12) * 100) / 100);
}
