import { describe, expect, it } from 'vitest';
import { activityStatement, classifyRevisionEvent, existedAtOpening, isExistingAro, isWriteOff, txHistoryEvents } from '../activity';
import type { Derived } from '../../engine/derive';
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

function d(id: string, pv: number, bridge: Partial<Derived['bridge']> = {}): Derived {
  return {
    obligationId: id,
    ref: id,
    settlementUsed: '2035-12-31',
    timingRevised: false,
    costRevisions: 0,
    direct: pv,
    cost: pv,
    leap: false,
    mcd: '2026-12-31',
    t1: 0, t2: 1, tD: 1,
    cce: pv, fv: pv, curveTerm: 1, beyond: false, rateBasis: 'test', rate: 0.04, pv,
    layers: [],
    discounted: true,
    ratePerLayer: false,
    frameworkId: 'ifrs',
    bridge: {
      pvBase: pv, pvCostOnly: pv, pvTimingOnly: pv, pvRateOnly: pv,
      costEffect: 0, timingEffect: 0, rateEffect: 0, inflEffect: 0, movement: 0,
      ...bridge,
    },
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
  it('opens from locked conversion events and splits in-year activity', () => {
    const existing = o({ id: 'old', ref: 'ARO-1', adj: [{ id: 'c1', kind: 'cost', amount: 50, date: '2027-06-30', reason: 'Scope change' }] });
    const newbie = o({ id: 'new', ref: 'ARO-2', status: 'In scope' });
    const writtenOff = o({ id: 'wo', ref: 'ARO-3', adj: [{ id: 'w1', kind: 'cost', amount: -80, date: '2027-03-31', reason: 'Write-off' }] });
    const events: ObligationEvent[] = [
      ev({ id: 'o1', obligationId: 'old', type: 'opening', amount: 1_000 }),
      ev({ id: 'o2', obligationId: 'wo', type: 'opening', amount: 200 }),
      ev({ id: 's1', obligationId: 'old', type: 'settlement', amount: -100 }),
      ev({ id: 'a1', obligationId: 'old', type: 'accretion', amount: 40 }),
      ev({ id: 'a2', obligationId: 'new', type: 'accretion', amount: 5 }),
    ];
    const byId = new Map<string, Derived>([
      ['old', d('old', 1_090, { costEffect: 50, timingEffect: 20, rateEffect: 10, inflEffect: 15, movement: 95 })],
      ['wo', d('wo', 120, { costEffect: -80, movement: -80 })],
      ['new', d('new', 55, {})],
    ]);
    const stmt = activityStatement([existing, newbie, writtenOff], events, byId, 1_265);
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
    expect(isWriteOff(writtenOff)).toBe(true);
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
