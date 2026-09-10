import { describe, expect, it } from 'vitest';
import { registerBooks, unpostedInYearCount } from '../registerBooks';
import type { JournalBatch, Obligation } from '../types';
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
    openingArc: 800,
    ...over,
  };
}

function ev(over: Partial<ObligationEvent> & Pick<ObligationEvent, 'id' | 'type' | 'amount'>): ObligationEvent {
  return { obligationId: 'o1', periodId: 'p1', date: '2026-04-30', ...over };
}

function batch(status: JournalBatch['status'], eventIds: string[]): JournalBatch {
  return {
    id: `b-${status}`, unitId: 'u', periodId: 'p1', number: 'JB-001', status,
    lines: eventIds.map((eventId, i) => ({
      ord: i + 1, accountId: 'a', coding: {}, debit: 0, credit: 0, eventId, obligationId: 'o1',
    })),
  };
}

const p1 = period({ id: 'p1', no: 1, status: 'Closed', starts: '2026-04-01', ends: '2026-04-30' });
const p2 = period({ id: 'p2', no: 2, status: 'Open', starts: '2026-05-01', ends: '2026-05-31' });
const periods = [p1, p2];

describe('registerBooks', () => {
  it('opens from conversion and includes event-ledger amounts before a journal batch is posted', () => {
    const row = o();
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_000 }),
      ev({ id: 'accr', type: 'accretion', amount: 10 }),
    ];
    const books = registerBooks(row, events, periods, [batch('Draft', ['accr'])], p1);
    expect(books.openingProvision).toBe(1_000);
    expect(books.accretionExisting).toBe(10);
    expect(books.accretionNew).toBe(0);
    expect(books.closingProvision).toBe(1_010);
    expect(books.openingArc).toBe(800);
    expect(books.closingArc).toBe(800);
    expect(unpostedInYearCount(events, periods, [batch('Draft', ['accr'])], p1)).toBe(1);
  });

  it('does not invent scheduled accretion that has not been allocated', () => {
    const row = o();
    const events = [ev({ id: 'open', type: 'opening', amount: 1_000 })];
    const books = registerBooks(row, events, periods, [], p1);
    expect(books.accretionExisting).toBe(0);
    expect(books.closingProvision).toBe(1_000);
  });

  it('includes posted in-year activity in closing', () => {
    const row = o();
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_000 }),
      ev({ id: 'accr', type: 'accretion', amount: 10 }),
      ev({ id: 'amort', type: 'depreciation', amount: 5 }),
    ];
    const posted = [batch('Posted', ['accr', 'amort'])];
    const books = registerBooks(row, events, periods, posted, p1);
    expect(books.accretionExisting).toBe(10);
    expect(books.accretionNew).toBe(0);
    expect(books.closingProvision).toBe(1_010);
    expect(books.amortization).toBe(5);
    expect(books.closingArc).toBe(795);
  });

  it('keeps closing equal to the prior period when nothing new has posted', () => {
    const row = o();
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_000 }),
      ev({ id: 'accr', type: 'accretion', amount: 10 }),
    ];
    const posted = [batch('Posted', ['accr'])];
    const p1Books = registerBooks(row, events, periods, posted, p1);
    const p2Books = registerBooks(row, events, periods, posted, p2);
    expect(p2Books.openingProvision).toBe(1_000);
    expect(p2Books.accretionExisting).toBe(10);
    expect(p2Books.closingProvision).toBe(p1Books.closingProvision);
  });

  it('follows the event ledger even when the journal batch is only approved or reversed', () => {
    const row = o();
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_000 }),
      ev({ id: 'accr', type: 'accretion', amount: 10 }),
    ];
    expect(registerBooks(row, events, periods, [batch('Approved', ['accr'])], p1).accretionExisting).toBe(10);
    const books = registerBooks(row, events, periods, [batch('Reversed', ['accr'])], p1);
    expect(books.accretionExisting).toBe(10);
    expect(books.closingProvision).toBe(1_010);
  });

  it('opens a new ARO at nil and recognises it from the addition event without a journal batch', () => {
    const row = o({ id: 'n1', openingArc: undefined });
    const events = [
      ev({ id: 'add', obligationId: 'n1', type: 'addition', amount: 200, periodId: 'p2' }),
    ];
    const books = registerBooks(row, events, periods, [], p2);
    expect(books.openingProvision).toBe(0);
    expect(books.newAro).toBe(200);
    expect(books.accretionExisting).toBe(0);
    expect(books.accretionNew).toBe(0);
    expect(books.closingProvision).toBe(200);
    expect(books.openingArc).toBe(0);
    expect(books.arcAdditions).toBe(200);
    expect(books.closingArc).toBe(200);
  });

  it('takes FY opening from the prior year posted closing', () => {
    const p12 = period({ id: 'p12', no: 12, fiscalYear: 2027, code: 'FY2027 P12', status: 'Closed' });
    const n1 = period({ id: 'n1', no: 1, fiscalYear: 2028, code: 'FY2028 P01', status: 'Open' });
    const row = o();
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_000 }),
      ev({ id: 'accr', type: 'accretion', amount: 40, periodId: 'p12' }),
    ];
    const posted = [{ ...batch('Posted', ['accr']), periodId: 'p12' }];
    const next = registerBooks(row, events, [p12, n1], posted, n1);
    expect(next.openingProvision).toBe(1_040);
    expect(next.accretionExisting).toBe(0);
    expect(next.closingProvision).toBe(1_040);
  });

  it('splits accretion onto existing vs new ARO', () => {
    const newbie = o({ id: 'n1', openingArc: undefined });
    const events = [
      ev({ id: 'add', obligationId: 'n1', type: 'addition', amount: 200 }),
      ev({ id: 'accr', obligationId: 'n1', type: 'accretion', amount: 8 }),
    ];
    const posted = [batch('Posted', ['add', 'accr'])];
    const books = registerBooks(newbie, events, periods, posted, p1);
    expect(books.newAro).toBe(200);
    expect(books.accretionNew).toBe(8);
    expect(books.accretionExisting).toBe(0);
    expect(books.closingProvision).toBe(208);
  });

  it('classifies posted revisions into the disclosure change-of-estimate lines', () => {
    const row = o({
      adj: [
        { id: 'c1', kind: 'cost', amount: 50, date: '2026-04-15', reason: 'Scope change' },
        { id: 't1', kind: 'term', to: '2045-03-31', date: '2026-04-16', reason: 'Deferred retirement' },
        { id: 'w1', kind: 'cost', amount: -80, date: '2026-04-17', reason: 'Write-off' },
      ],
    });
    const events = [
      ev({ id: 'open', type: 'opening', amount: 1_000 }),
      ev({ id: 'u-rev-c1', type: 'revision', amount: 50, note: 'Cost adjustment in FY2027 P01: Scope change.', date: '2026-04-15' }),
      ev({ id: 'u-rev-t1', type: 'revision', amount: 20, note: 'Term adjustment in FY2027 P01: Deferred retirement.', date: '2026-04-16' }),
      ev({ id: 'u-rev-w1', type: 'revision', amount: -80, note: 'Cost adjustment in FY2027 P01: Write-off.', date: '2026-04-17' }),
      ev({ id: 'mass', type: 'revision', amount: 25, note: 'Year-end revaluation onto the closing table.' }),
      ev({ id: 'setl', type: 'settlement', amount: -100 }),
    ];
    const posted = [batch('Posted', ['u-rev-c1', 'u-rev-t1', 'u-rev-w1', 'mass', 'setl'])];
    const books = registerBooks(row, events, periods, posted, p1);
    expect(books.settlement).toBe(-100);
    expect(books.costAdjustments).toBe(50);
    expect(books.termAdjustments).toBe(20);
    expect(books.writeOffs).toBe(-80);
    expect(books.massUpdate).toBe(25);
    expect(books.closingProvision).toBe(915);
  });
});
