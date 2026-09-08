import { describe, expect, it } from 'vitest';
import { assetCalcLines, obligationCalcLines } from '../calcDetails';
import { registerBooks } from '../registerBooks';
import { usefulLifeAsAt } from '../usefulLife';
import type { JournalBatch, Obligation, ReportingUnit } from '../types';
import type { Period } from '../periods';
import type { ObligationEvent } from '../../engine/rollforward';
import type { Derived } from '../../engine/derive';

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
    settlementDate: '2041-03-31',
    lines: [{ id: 'l1', description: 'Opening estimated cost', qty: 1, rate: 1_000_000, source: 'pasted block' }],
    adj: [], status: 'In scope',
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

const unit = {
  fyEnd: '2027-03-31',
  dayCount: '30/360 US (DAYS360)',
  calendarType: 'Monthly (12)',
} as ReportingUnit;

const p1 = period({ id: 'p1', no: 1, status: 'Closed' });

describe('obligationCalcLines', () => {
  it('puts baseline cost and term above the disclosure roll-forward', () => {
    const row = o({
      adj: [{ id: 't1', kind: 'term', to: '2045-03-31', date: '2026-04-16', reason: 'Deferred retirement' }],
    });
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_000 }),
      ev({ id: 'accr', type: 'accretion', amount: 10 }),
      ev({ id: 'u-rev-t1', type: 'revision', amount: 20, note: 'Term adjustment in FY2027 P01: Deferred retirement.', date: '2026-04-16' }),
    ];
    const books = registerBooks(row, events, [p1], [batch(['accr', 'u-rev-t1'])], p1);
    const d = { cce: 1_020_000, tD: 18, settlementUsed: '2045-03-31' } as Derived;
    const lines = obligationCalcLines(row, books, d, unit);
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
    expect(byKey.initialCost.amount).toBe(1_000_000);
    expect(byKey.currentCost.amount).toBe(1_020_000);
    expect(byKey.initialTerm.amount).toBe(14);
    expect(byKey.initialTerm.detail).toBe('settlement 2041-03-31');
    expect(byKey.adjustedTerm.amount).toBe(18);
    expect(byKey.adjustedTerm.detail).toBe('settlement 2045-03-31');
    expect(byKey.opening.amount).toBe(1_000);
    expect(byKey.accretion.amount).toBe(10);
    expect(byKey.term.amount).toBe(20);
    expect(byKey.closing.amount).toBe(1_030);
  });
});

describe('assetCalcLines', () => {
  it('shows useful life then the asset roll-forward, which foots', () => {
    const row = o();
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_000 }),
      ev({ id: 'u-rev-c1', type: 'revision', amount: 50, note: 'Cost adjustment in FY2027 P01: Scope change.' }),
      ev({ id: 'depr', type: 'depreciation', amount: 40 }),
    ];
    const books = registerBooks(row, events, [p1], [batch(['u-rev-c1', 'depr'])], p1);
    const life = usefulLifeAsAt(row, events, [p1], unit, p1);
    const lines = assetCalcLines(row, books, life);
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
    expect(byKey.totalUl.amount).toBe(25);
    expect(byKey.expiredUl.amount).toBeCloseTo(10 + 1 / 12, 4);
    expect(byKey.remainingUl.amount).toBeCloseTo(15 - 1 / 12, 4);
    expect(byKey.opening.amount).toBe(800);
    expect(byKey.cost.amount).toBe(50);
    expect(byKey.amort.amount).toBe(-40);
    expect(byKey.closing.amount).toBe(810);
    const activity = lines.filter((l) => l.group === 'Activity').reduce((s, l) => s + (l.amount ?? 0), 0);
    expect(800 + activity).toBe(810);
  });
});
