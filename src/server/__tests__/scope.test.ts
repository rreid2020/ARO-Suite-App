import { describe, expect, it } from 'vitest';
import { emptyAppState } from '../../core/emptyState';
import { mut } from '../../core/writePath';
import { prefixSeed } from '../seedPrefix';
import { seedState } from '../../seed';
import { scopeState } from '../scope';

describe('tenant scoping', () => {
  it('strips tenants the caller does not belong to', () => {
    const state = seedState();
    const scoped = scopeState(state, ['kestrel']);
    expect(scoped.tenants.map((t) => t.id)).toEqual(['kestrel']);
    expect(scoped.users.every((u) => u.tenantId === 'kestrel')).toBe(true);
    expect(scoped.units.northgate).toBeUndefined();
    expect(scoped.units.kestrel?.length).toBeGreaterThan(0);
    expect(scoped.data.nu1).toBeUndefined();
    expect(scoped.data.ku1).toBeDefined();
    expect(scoped.chg.every((c) => c.tenantId === 'kestrel')).toBe(true);
    expect(scoped.log.every((l) => l.tenantId === 'kestrel')).toBe(true);
  });

  it('returns an empty workspace when the caller has no memberships', () => {
    const scoped = scopeState(seedState(), []);
    expect(scoped).toEqual(emptyAppState());
  });
});

describe('sample seed prefixing', () => {
  it('does not share ids with the global demo seed', () => {
    const prefixed = prefixSeed(seedState(), 'u1-');
    expect(prefixed.tenants.map((t) => t.id)).toEqual(['u1-kestrel', 'u1-northgate', 'u1-halloran']);
    expect(prefixed.units['u1-kestrel']?.[0].id).toBe('u1-ku1');
    expect(prefixed.data['u1-ku1']).toBeDefined();
    expect(prefixed.data.ku1).toBeUndefined();
  });
});

describe('append-only write path', () => {
  it('logs a refusal and does not emit change rows', () => {
    const result = mut({
      domain: 'register',
      tenantId: 't1',
      record: 'o1',
      recordLabel: 'ARO-1',
      before: { ref: 'A' },
      after: { ref: 'B' },
      actor: 'A. User',
      role: 'preparer',
      action: 'Edit',
      authority: {
        register: 'Source-owned',
        estimates: 'We own it',
        assumptions: 'We own it',
        periods: 'We own it',
        journals: 'We own it',
        evidence: 'We own it',
      },
    });
    expect(result.ok).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.audit).toHaveLength(1);
    expect(result.audit[0].kind).toBe('refused');
  });
});
