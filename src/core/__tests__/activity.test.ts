import { describe, expect, it } from 'vitest';
import { activityByPeriod, activityStatement, classifyRevisionEvent, existedAtOpening, isExistingAro, isWriteOff, txHistoryEvents } from '../activity';
import type { Obligation } from '../types';
import type { ObligationEvent } from '../../engine/rollforward';

function o(over: Partial<Obligation> & Pick<Obligation, 'id' | 'ref'>): Obligation {
  return {
    description: over.ref,
    costEstimateDate: '2026-12-31',
    settlementDate: '2035-12-31',
    lines: [],
    adj: [],
    ...over,
  };
}

function ev(over: Partial<ObligationEvent> & Pick<ObligationEvent, 'id' | 'obligationId' | 'type' | 'amount'>): ObligationEvent {
  return {
    periodId: 'p1',
    date: '2027-01-31',
    ...over,
  };
}

describe('existing vs new ARO', () => {
  it('treats a row with an opening event as existing', () => {
    const existing = o({ id: 'a', ref: 'ARO-1' });
    const newbie = o({ id: 'b', ref: 'ARO-2' });
    const events = [ev({ id: 'e1', obligationId: 'a', type: 'opening', amount: 100 })];
    expect(isExistingAro(existing, events)).toBe(true);
    expect(isExistingAro(newbie, events)).toBe(false);
  });

  it('treats the whole population as existing when no opening events have been loaded', () => {
    const row = o({ id: 'a', ref: 'ARO-1' });
    expect(isExistingAro(row, [])).toBe(true);
  });
});

describe('classifyRevisionEvent', () => {
  it('splits cost, term, write-off and mass update from the event note', () => {
    const row = o({
      id: 'a', ref: 'ARO-1',
      adj: [
        { id: 'c1', kind: 'cost', amount: 50, date: '2027-06-30', reason: 'Scope change' },
        { id: 'w1', kind: 'cost', amount: -80, date: '2027-03-31', reason: 'Write-off' },
      ],
    });
    expect(classifyRevisionEvent(row, ev({ id: 'u-rev-c1', obligationId: 'a', type: 'revision', amount: 50, note: 'Cost adjustment in P01: Scope change.' }))).toBe('cost');
    expect(classifyRevisionEvent(row, ev({ id: 't', obligationId: 'a', type: 'revision', amount: 20, note: 'Term adjustment in P01: Licence extension.' }))).toBe('term');
    expect(classifyRevisionEvent(row, ev({ id: 'u-rev-w1', obligationId: 'a', type: 'revision', amount: -80, note: 'Cost adjustment in P01: Write-off.' }))).toBe('writeOff');
    expect(classifyRevisionEvent(row, ev({ id: 'm', obligationId: 'a', type: 'revision', amount: 12, note: 'Year-end revaluation onto the closing table.' }))).toBe('mass');
  });

  it('treats a converted row with a nil opening as existing', () => {
    const row = o({ id: 'a', ref: 'ARO-1' });
    const events = [ev({ id: 'o1', obligationId: 'a', type: 'opening', amount: 0 })];
    expect(existedAtOpening(row, events, 0)).toBe(true);
    expect(existedAtOpening(o({ id: 'b', ref: 'ARO-2' }), events, 0)).toBe(false);
  });
});

describe('activityStatement', () => {
  const existing = o({ id: 'old', ref: 'ARO-1', adj: [{ id: 'c1', kind: 'cost', amount: 50, date: '2027-06-30', reason: 'Scope change' }] });
  const newbie = o({ id: 'new', ref: 'ARO-2', status: 'In scope' });
  const writtenOff = o({ id: 'wo', ref: 'ARO-3', adj: [{ id: 'w1', kind: 'cost', amount: -80, date: '2027-03-31', reason: 'Write-off' }] });
  const events: ObligationEvent[] = [
    ev({ id: 'o1', obligationId: 'old', type: 'opening', amount: 1_000, periodId: 'p1' }),
    ev({ id: 'o2', obligationId: 'wo', type: 'opening', amount: 200, periodId: 'p1' }),
    ev({ id: 's1', obligationId: 'old', type: 'settlement', amount: -100, periodId: 'p1' }),
    ev({ id: 'a1', obligationId: 'old', type: 'accretion', amount: 40, periodId: 'p1' }),
    ev({ id: 'rev-c1', obligationId: 'old', type: 'revision', amount: 50, note: 'Cost adjustment in P01: Scope change.' }),
    ev({ id: 'rev-t', obligationId: 'old', type: 'revision', amount: 20, note: 'Term adjustment in P01: Licence extension.' }),
    ev({ id: 'rev-w1', obligationId: 'wo', type: 'revision', amount: -80, note: 'Cost adjustment in P01: Write-off.' }),
    ev({ id: 'rev-m', obligationId: 'old', type: 'revision', amount: 25, note: 'Year-end revaluation onto the closing table.' }),
    ev({ id: 'add', obligationId: 'new', type: 'addition', amount: 50, periodId: 'p2' }),
    ev({ id: 'a2', obligationId: 'new', type: 'accretion', amount: 5, periodId: 'p2' }),
  ];

  it('opens from locked conversion events and splits in-year activity from the ledger', () => {
    const stmt = activityStatement([existing, newbie, writtenOff], events, 1_210);
    expect(stmt.openingProvision).toBe(1_200);
    expect(stmt.settlement).toBe(-100);
    expect(stmt.accretionExisting).toBe(40);
    expect(stmt.costAdjustments).toBe(50);
    expect(stmt.termAdjustments).toBe(20);
    expect(stmt.writeOffs).toBe(-80);
    expect(stmt.massUpdate).toBe(25);
    expect(stmt.newAro).toBe(50);
    expect(stmt.accretionNew).toBe(5);
    expect(stmt.closing).toBe(1_210);
    expect(stmt.foots).toBe(true);
    expect(isWriteOff(writtenOff)).toBe(true);
  });

  it('the period breakdown totals to the consolidated statement', () => {
    const { periods, year } = activityByPeriod(
      [existing, newbie, writtenOff],
      events,
      [{ id: 'p1', code: 'FY2027 P01' }, { id: 'p2', code: 'FY2027 P02' }],
      1_210,
    );
    expect(year.openingProvision).toBe(1_200);
    expect(year.newAro).toBe(50);
    expect(year.accretionNew).toBe(5);
    expect(year.closing).toBe(1_210);
    expect(periods[0].openingProvision).toBe(1_200);
    expect(periods[0].newAro).toBe(0);
    expect(periods[1].openingProvision).toBe(0);
    expect(periods[1].newAro).toBe(50);
    expect(periods[0].settlement + periods[1].settlement).toBe(year.settlement);
    expect(periods[0].accretionExisting + periods[1].accretionExisting).toBe(year.accretionExisting);
    expect(periods[0].costAdjustments + periods[1].costAdjustments).toBe(year.costAdjustments);
    expect(periods[0].closing + periods[1].closing).toBe(year.closing);
    expect(year.lines.map((l) => l.amount)).toEqual([
      year.openingProvision, year.settlement, year.accretionExisting,
      year.costAdjustments, year.termAdjustments, year.writeOffs, year.massUpdate,
      year.newAro, year.accretionNew, year.fx, year.closing,
    ]);
  });
});

describe('txHistoryEvents', () => {
  it('lists cost, term and settlement events separately for one obligation', () => {
    const row = o({
      id: 'o1', ref: 'ARO-1',
      adj: [
        { id: 'c1', kind: 'cost', amount: 50_000, date: '2027-01-15', reason: 'Revised engineering estimate' },
        { id: 't1', kind: 'term', to: '2040-12-31', date: '2027-01-20', reason: 'Deferred retirement' },
      ],
    });
    const events = [
      ev({ id: 'e-c1', obligationId: 'o1', type: 'revision', amount: 48_000, date: '2027-01-15', note: 'Cost adjustment in FY2027 P01: Revised engineering estimate.' }),
      ev({ id: 'e-ex', obligationId: 'o1', type: 'downward-excess', amount: -2_000, date: '2027-01-16' }),
      ev({ id: 'e-t1', obligationId: 'o1', type: 'revision', amount: 12_000, date: '2027-01-20', note: 'Term adjustment in FY2027 P01: Deferred retirement.' }),
      ev({ id: 'e-s1', obligationId: 'o1', type: 'settlement', amount: -10_000, date: '2027-02-28' }),
      ev({ id: 'e-d1', obligationId: 'o1', type: 'disposal', amount: -5_000, date: '2027-03-31' }),
      ev({ id: 'e-other', obligationId: 'o2', type: 'revision', amount: 1, note: 'Cost adjustment.' }),
    ];
    expect(txHistoryEvents(row, events, 'cost').map((e) => e.id)).toEqual(['e-c1', 'e-ex']);
    expect(txHistoryEvents(row, events, 'term').map((e) => e.id)).toEqual(['e-t1']);
    expect(txHistoryEvents(row, events, 'settle').map((e) => e.id)).toEqual(['e-s1', 'e-d1']);
  });
});
