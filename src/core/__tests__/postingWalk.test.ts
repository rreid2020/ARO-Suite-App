import { describe, expect, it } from 'vitest';
import { derive } from '../../engine/derive';
import { assumptions, obligation, yearCurve } from '../../engine/__tests__/fixtures';
import { matchedRevision } from '../activity';
import { costIncrementFormula, revisionWalk, revisionsThrough } from '../postingWalk';
import type { ObligationEvent } from '../../engine/rollforward';

const opt = { curve: yearCurve };

describe('revisionWalk', () => {
  it('turns a gross cost adjustment into the PV movement through the chain', () => {
    const rev = { id: 'c1', kind: 'cost' as const, amount: 50_000, date: '2025-09-30', reason: 'Revised engineering estimate' };
    const row = obligation({ adj: [rev] });
    const a = assumptions();
    const walk = revisionWalk(row, rev, a, opt);
    const before = derive({ ...row, adj: [] }, a, opt);
    const after = derive(row, a, opt);
    expect(walk.kind).toBe('cost');
    expect(walk.recorded).toBe(50_000);
    expect(walk.posted).toBeCloseTo(after.pv - before.pv, 2);
    expect(walk.foots).toBe(true);
    expect(walk.rungs[0]?.label).toBe('Recorded cost adjustment');
    expect(walk.rungs[0]?.value).toBe(50_000);
    expect(walk.rungs.at(-1)?.key).toBe('pv');
    expect(walk.rungs.at(-1)?.value).toBeCloseTo(walk.posted, 2);
    expect(walk.formula).toMatch(/^=50000\*\(1\+0\.1\)/);
    expect(walk.formula).toContain('/(1+');
    expect(walk.formula).toBe(costIncrementFormula(50_000, a, derive({
      ...row,
      lines: [{ id: 'inc', description: 'Cost adjustment', qty: 1, rate: 50_000 }],
      adj: [],
      settlementDate: after.settlementUsed,
    }, a, opt)));
  });

  it('reprices the whole obligation for a term adjustment', () => {
    const rev = { id: 't1', kind: 'term' as const, to: '2035-06-30', date: '2025-09-30', reason: 'Deferred retirement' };
    const row = obligation({ adj: [rev] });
    const walk = revisionWalk(row, rev, assumptions(), opt);
    expect(walk.kind).toBe('term');
    expect(walk.recordedDate).toBe('2035-06-30');
    expect(walk.before.settlement).toBe(row.settlementDate);
    expect(walk.after.settlement).toBe('2035-06-30');
    expect(walk.posted).toBeCloseTo(walk.after.pv - walk.before.pv, 2);
    expect(walk.rungs).toEqual([]);
  });

  it('ignores later revisions when walking an earlier cost adjustment', () => {
    const cost = { id: 'c1', kind: 'cost' as const, amount: 50_000, date: '2025-03-31', reason: 'Scope' };
    const later = { id: 't1', kind: 'term' as const, to: '2040-06-30', date: '2025-09-30', reason: 'Later term' };
    const row = obligation({ adj: [cost, later] });
    expect(revisionsThrough(row, cost).map((a) => a.id)).toEqual(['c1']);
    const withLater = revisionWalk({ ...row, adj: [cost, later] }, cost, assumptions(), opt);
    const without = revisionWalk({ ...row, adj: [cost] }, cost, assumptions(), opt);
    expect(withLater.posted).toBe(without.posted);
    expect(withLater.after.settlement).toBe(without.after.settlement);
  });
});

describe('matchedRevision', () => {
  it('matches a posted event id that suffixes the revision id with the planned-entry index', () => {
    const row = obligation({
      adj: [{ id: 'adj-abc', kind: 'cost', amount: 50_000, date: '2025-09-30', reason: 'Scope' }],
    });
    const e: ObligationEvent = {
      id: 'u1-rev-adj-abc-0', obligationId: row.id, type: 'revision', amount: 30_000,
      periodId: 'p1', date: '2025-09-30', note: 'Cost adjustment in P01: Scope.',
    };
    expect(matchedRevision(row, e)?.id).toBe('adj-abc');
  });
});
