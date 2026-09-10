import { describe, expect, it } from 'vitest';
import { assetCalcLines, calcLineDrillable, calcLineSource, obligationCalcLines } from '../calcDetails';
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
    expect(byKey.accretion.group).toBe('Existing');
    expect(byKey.accretionNew.amount).toBe(0);
    expect(byKey.newAro.group).toBe('New');
    expect(byKey.accretionNew.group).toBe('New');
    expect(byKey.term.amount).toBe(20);
    expect(byKey.closing.amount).toBe(1_030);
  });

  it('puts accretion on a newly created ARO onto Accretion on new ARO, not the existing line', () => {
    const row = o({ id: 'n1', openingArc: undefined });
    const events = [
      ev({ id: 'add', obligationId: 'n1', type: 'addition', amount: 613_207.27 }),
      ev({ id: 'accr', obligationId: 'n1', type: 'accretion', amount: 1_948.17 }),
    ];
    const books = registerBooks(row, events, [p1], [batch(['accr'])], p1);
    const lines = obligationCalcLines(row, books, undefined, unit);
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
    expect(books.openingProvision).toBe(0);
    expect(byKey.accretion.amount).toBe(0);
    expect(byKey.newAro.amount).toBe(613_207.27);
    expect(byKey.accretionNew.amount).toBe(1_948.17);
    expect(byKey.closing.amount).toBe(615_155.44);
  });
});

describe('assetCalcLines', () => {
  it('shows useful life then the same ARO asset columns as the register, which foot', () => {
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
    expect(byKey.opening.amount).toBe(books.openingArc);
    expect(byKey.additions.amount).toBe(books.arcAdditions);
    expect(byKey.amort.amount).toBe(books.amortization);
    expect(byKey.closing.amount).toBe(books.closingArc);
    expect(byKey.opening.amount).toBe(800);
    expect(byKey.additions.amount).toBe(50);
    expect(byKey.amort.amount).toBe(40);
    expect(byKey.closing.amount).toBe(810);
    expect((byKey.opening.amount ?? 0) + (byKey.additions.amount ?? 0) - (byKey.amort.amount ?? 0))
      .toBe(byKey.closing.amount);
  });

  it('puts a new ARO addition onto Additions and closing, matching the register', () => {
    const row = o({ id: 'n1', openingArc: undefined, totalUl: 30, expiredUl: 0 });
    const events = [
      ev({ id: 'add', obligationId: 'n1', type: 'addition', amount: 613_207.27, periodId: 'p1' }),
    ];
    const books = registerBooks(row, events, [p1], [], p1);
    const life = usefulLifeAsAt(row, events, [p1], unit, p1);
    const lines = assetCalcLines(row, books, life);
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
    expect(books.newAro).toBe(613_207.27);
    expect(byKey.opening.amount).toBe(0);
    expect(byKey.additions.amount).toBe(613_207.27);
    expect(byKey.amort.amount).toBe(0);
    expect(byKey.closing.amount).toBe(613_207.27);
  });
});

describe('calcLineSource', () => {
  it('lists the addition and accretion events under New ARO and Accretion on new ARO', () => {
    const row = o({ id: 'n1', openingArc: undefined });
    const events = [
      ev({ id: 'add', obligationId: 'n1', type: 'addition', amount: 613_207.27 }),
      ev({ id: 'accr', obligationId: 'n1', type: 'accretion', amount: 1_948.17 }),
    ];
    const books = registerBooks(row, events, [p1], [], p1);
    expect(calcLineSource('newAro', 'obligation', row, books, events, [p1], p1).events.map((e) => e.id)).toEqual(['add']);
    expect(calcLineSource('accretion', 'obligation', row, books, events, [p1], p1).events).toEqual([]);
    expect(calcLineSource('accretionNew', 'obligation', row, books, events, [p1], p1).events.map((e) => e.id)).toEqual(['accr']);
    expect(calcLineSource('additions', 'asset', row, books, events, [p1], p1).events.map((e) => e.id)).toEqual(['add']);
  });

  it('puts existing-ARO accretion on the existing line, not the new line', () => {
    const row = o();
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_000 }),
      ev({ id: 'accr', type: 'accretion', amount: 10 }),
    ];
    const books = registerBooks(row, events, [p1], [], p1);
    expect(calcLineSource('opening', 'obligation', row, books, events, [p1], p1).events.map((e) => e.id)).toEqual(['open']);
    expect(calcLineSource('accretion', 'obligation', row, books, events, [p1], p1).events.map((e) => e.id)).toEqual(['accr']);
    expect(calcLineSource('accretionNew', 'obligation', row, books, events, [p1], p1).events).toEqual([]);
  });

  it('lets every calculation-details line open, with a note when there are no events', () => {
    const row = o();
    const events = [ev({ id: 'open', type: 'opening', amount: 1_000 })];
    const books = registerBooks(row, events, [p1], [], p1);
    const d = { cce: 1_020_000, tD: 14, settlementUsed: '2041-03-31' } as Derived;
    const life = usefulLifeAsAt(row, events, [p1], unit, p1);
    for (const line of obligationCalcLines(row, books, d, unit)) {
      expect(calcLineDrillable(line), line.key).toBe(true);
    }
    for (const line of assetCalcLines(row, books, life)) {
      expect(calcLineDrillable(line), line.key).toBe(true);
    }
    expect(calcLineSource('currentCost', 'obligation', row, books, events, [p1], p1).emptyNote).toMatch(/measurement fact/);
    expect(calcLineSource('accretionNew', 'obligation', row, books, events, [p1], p1).emptyNote).toMatch(/existed at opening/);
  });
});
