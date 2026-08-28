/**
 * BUILD-SEQUENCE Phase 1 acceptance:
 * "every invariant in INVARIANTS.md §2, §3, §7, §8 holds, tested."
 */

import { describe, expect, it } from 'vitest';
import { AuthorityMode, Domain, defaultAuthority, canPost, canReverse, canLockPeriod, signLevel } from '../authority';
import { diff, mut, restore, WriteRequest } from '../writePath';
import { buildCalendar, canPostInto, canTransition, Period } from '../periods';
import { YEAR_END_GATES, runGates, YearEndState, attestedResult, deleteGateWarning } from '../gates';

const owned = defaultAuthority('Reporting entity');
const auditor = defaultAuthority('Auditor');

interface Rec { ref: string; cost: number; settlementDate: string; nested: { site: string } }

const base = (over: Partial<WriteRequest<Rec>> = {}): WriteRequest<Rec> => ({
  domain: 'register' as Domain,
  tenantId: 't1',
  unitId: 'u1',
  record: 'o-1',
  recordLabel: 'ARO-0001 Wellhead abandonment',
  before: { ref: 'ARO-0001', cost: 100, settlementDate: '2032-06-30', nested: { site: 'Field A' } },
  after: { ref: 'ARO-0001', cost: 150, settlementDate: '2032-06-30', nested: { site: 'Field A' } },
  actor: 'R. Achebe',
  role: 'preparer',
  action: 'Edit obligation',
  authority: owned,
  ...over,
});

/* ── §3 · Authority is enforced at the data layer ───────────────────────── */

describe('INVARIANTS §3 — authority is enforced in the single write path', () => {
  it('accepts a write into a domain the tenant owns', () => {
    const r = mut(base());
    expect(r.ok).toBe(true);
    expect(r.value.cost).toBe(150);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].field).toBe('cost');
  });

  it('refuses a write into a source-owned domain, and the refusal names the domain and the mode', () => {
    const r = mut(base({ authority: auditor }));
    expect(r.ok).toBe(false);
    expect(r.value.cost).toBe(100); // unchanged
    expect(r.refusal!.domainLabel).toBe('Register & scoping');
    expect(r.refusal!.mode).toBe('Source-owned');
    expect(r.refusal!.reason).toContain('Register & scoping');
    expect(r.refusal!.reason).toContain('Source-owned');
  });

  it('logs the refusal itself', () => {
    const r = mut(base({ authority: auditor }));
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0].kind).toBe('refused');
    expect(r.audit[0].detail).toBe(r.refusal!.reason);
  });

  it('refuses a write on a frozen copy', () => {
    const frozen = { ...owned, register: 'Frozen copy' as AuthorityMode };
    const r = mut(base({ authority: frozen }));
    expect(r.ok).toBe(false);
    expect(r.refusal!.reason).toContain('new version with a diff');
  });

  it('an auditor owns its materiality and its conclusion and reads the rest', () => {
    expect(auditor.assumptions).toBe('We own it');
    expect(auditor.evidence).toBe('We own it');
    expect(auditor.register).toBe('Source-owned');
    expect(auditor.estimates).toBe('Source-owned');
    expect(auditor.journals).toBe('Source-owned');
    expect(auditor.periods).toBe('Source-owned');
  });

  it('a reporting entity owns everything', () => {
    expect(Object.values(owned).every((m) => m === 'We own it')).toBe(true);
  });

  it('refuses a write from a role that cannot edit, before it looks at authority', () => {
    const r = mut(base({ role: 'readonly' }));
    expect(r.ok).toBe(false);
    expect(r.refusal!.mode).toBe('role');
  });
});

/* ── §5 · Nothing is silently dropped ───────────────────────────────────── */

describe('INVARIANTS §5 — a refused field is refused by name, and the counts are reported', () => {
  it('writes the accepted fields, rolls back the guarded one, and names it', () => {
    const r = mut(
      base({
        after: { ref: 'ARO-0001', cost: 150, settlementDate: '2040-01-31', nested: { site: 'Field B' } },
        guarded: { settlementDate: 'held by a timing revision' },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.value.cost).toBe(150);
    expect(r.value.nested.site).toBe('Field B');
    expect(r.value.settlementDate).toBe('2032-06-30'); // rolled back
    expect(r.refusedFields).toEqual([{ field: 'settlementDate', reason: 'held by a timing revision' }]);
    expect(r.changes.map((c) => c.field).sort()).toEqual(['cost', 'nested.site']);

    const refusedAudit = r.audit.find((a) => a.kind === 'refused')!;
    expect(refusedAudit.detail).toContain('2 written, 1 refused');
    expect(refusedAudit.detail).toContain('settlementDate');
  });
});

/* ── §2 · Append-only history ───────────────────────────────────────────── */

describe('INVARIANTS §2 — append-only history', () => {
  it('diffs to field level, including nested paths', () => {
    const d = diff(
      { a: 1, n: { x: 'p', y: 2 }, list: [{ v: 1 }] },
      { a: 1, n: { x: 'q', y: 2 }, list: [{ v: 2 }] },
    );
    expect(d.map((e) => e.field)).toEqual(['list[0].v', 'n.x']);
  });

  it('a restore is a NEW logged change carrying restoredFrom, not an edit of the original', () => {
    const first = mut(base());
    const original = first.changes[0];

    const back = restore(
      base({ before: first.value, after: { ...first.value, cost: 100 } }),
      original,
    );

    expect(back.ok).toBe(true);
    expect(back.value.cost).toBe(100);
    expect(back.changes).toHaveLength(1);
    expect(back.changes[0].restoredFrom).toBe(original.id);
    // The original entry is a separate object and is untouched.
    expect(original.after).toBe(150);
    expect(back.changes[0].id).not.toBe(original.id);
  });

  it('mut never mutates the record it was given', () => {
    const req = base();
    const beforeSnapshot = JSON.stringify(req.before);
    mut(req);
    expect(JSON.stringify(req.before)).toBe(beforeSnapshot);
  });
});

/* ── §7 · Segregation of duties ─────────────────────────────────────────── */

describe('INVARIANTS §7 — segregation of duties', () => {
  it('preparer approves, reviewer or partner posts, partner only reverses', () => {
    expect(canPost('preparer')).toBe(false);
    expect(canPost('reviewer')).toBe(true);
    expect(canPost('partner')).toBe(true);

    expect(canReverse('preparer')).toBe(false);
    expect(canReverse('reviewer')).toBe(false);
    expect(canReverse('partner')).toBe(true);
  });

  it('sign-off is three-stage', () => {
    expect(signLevel('preparer')).toBe(0);
    expect(signLevel('reviewer')).toBe(1);
    expect(signLevel('partner')).toBe(2);
    expect(signLevel('admin')).toBeNull();
    expect(signLevel('readonly')).toBeNull();
  });

  it('period lock is partner-only', () => {
    expect(canLockPeriod('reviewer')).toBe(false);
    expect(canLockPeriod('partner')).toBe(true);
  });
});

/* ── §8 · Period integrity ──────────────────────────────────────────────── */

describe('INVARIANTS §8 — period integrity', () => {
  const cal = buildCalendar('u1', '2026-06-30', 'Monthly (12)');

  it('the fiscal calendar belongs to the reporting unit and carries the FISCAL year', () => {
    expect(cal).toHaveLength(12);
    expect(cal[0].code).toBe('FY2026 P01');
    expect(cal[0].starts).toBe('2025-07-01');
    expect(cal[0].ends).toBe('2025-07-31');
    // P01 ends in calendar 2025 but the code says FY2026.
    expect(cal[0].fiscalYear).toBe(2026);
    expect(cal[11].ends).toBe('2026-06-30');
  });

  it('a June year-end subsidiary and a December parent coexist', () => {
    const dec = buildCalendar('u2', '2026-12-31', 'Monthly (12)');
    expect(dec[0].starts).toBe('2026-01-01');
    expect(dec[11].ends).toBe('2026-12-31');
    expect(cal[11].ends).toBe('2026-06-30');
  });

  const p = (status: Period['status']): Period => ({ ...cal[5], status });

  it('the sequence cannot be skipped', () => {
    const r = canTransition(p('Open'), 'Closed', 'partner');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('cannot be skipped');
  });

  it('close is preparer or reviewer', () => {
    expect(canTransition(p('Open'), 'Soft closed', 'preparer').allowed).toBe(true);
    expect(canTransition(p('Soft closed'), 'Closed', 'reviewer').allowed).toBe(true);
  });

  it('lock and reopen are partner-only', () => {
    expect(canTransition(p('Closed'), 'Locked', 'reviewer').allowed).toBe(false);
    expect(canTransition(p('Closed'), 'Locked', 'partner').allowed).toBe(true);
    expect(canTransition(p('Closed'), 'Soft closed', 'reviewer').allowed).toBe(false);
    expect(canTransition(p('Closed'), 'Soft closed', 'partner').allowed).toBe(true);
    expect(canTransition(p('Locked'), 'Closed', 'reviewer').reason).toContain('Only an engagement partner');
  });

  it('posting into a locked period is refused, and the refusal explains itself in the accounting', () => {
    const r = canPostInto(p('Locked'));
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cannot post because FY2026 P06 is locked/);
    expect(r.reason).not.toMatch(/unavailable|not allowed/i);
  });

  it('posting into a closed period is refused and names the two ways out', () => {
    const r = canPostInto(p('Closed'));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('prior-period adjustment');
  });

  it('an open or soft-closed period accepts a batch', () => {
    expect(canPostInto(p('Open')).allowed).toBe(true);
    expect(canPostInto(p('Soft closed')).allowed).toBe(true);
  });
});

/* ── §4 · Gates are evaluated, not asserted ─────────────────────────────── */

describe('INVARIANTS §4 — gates are evaluated, not asserted', () => {
  const clean: YearEndState = {
    periods: Array.from({ length: 12 }, (_, i) => ({ code: `FY2026 P${i + 1}`, status: 'Closed' })),
    annualResidual: 0,
    periodResiduals: [],
    conversionAgreed: true,
    conversionNote: 'Conversion agreed to the legacy balance.',
    batches: [{ number: 'JB-001', status: 'Posted' }],
    subLedgerTotal: 5_000_000,
    glTotal: 5_000_000,
    packSigned: [
      { stage: 'Preparer', by: 'A', at: '2026-07-01' },
      { stage: 'Reviewer', by: 'B', at: '2026-07-02' },
      { stage: 'Partner', by: 'C', at: '2026-07-03' },
    ],
    noteGenerated: true,
    yearLocked: true,
  };

  it('passes all eight when the state is clean', () => {
    const r = runGates(YEAR_END_GATES, clean);
    expect(r).toHaveLength(8);
    expect(r.every((g) => g.state === 'pass')).toBe(true);
  });

  it('a gate below an unpassed gate reads "not reached", not "fail"', () => {
    const s = { ...clean, periods: [{ code: 'FY2026 P12', status: 'Open' }] };
    const r = runGates(YEAR_END_GATES, s);
    expect(r[0].state).toBe('fail');
    expect(r[0].detail).toContain('FY2026 P12');
    expect(r.slice(1).every((g) => g.state === 'not reached')).toBe(true);
  });

  it('an incomplete reconciliation is reported as incomplete, never as a pass', () => {
    const r = runGates(YEAR_END_GATES, { ...clean, glTotal: null });
    const tie = r.find((g) => g.id === 'subledger-tied')!;
    expect(tie.state).toBe('fail');
    expect(tie.detail).toContain('No GL balance received');
    expect(tie.detail).toContain('not a pass');
  });

  it('an attested gate says it is ticked by a person and not computed', () => {
    const g = attestedResult({ id: 'x', label: 'Local statutory review done', kind: 'attested', note: 'Confirm the local team has reviewed.' });
    expect(g.kind).toBe('attested');
    expect(g.detail).toContain('attested, not evaluated');
  });

  it('deleting an evaluated gate states that it removes a control', () => {
    expect(deleteGateWarning(YEAR_END_GATES[0])).toContain('removes a control');
    expect(deleteGateWarning({ id: 'x', label: 'Y', kind: 'attested', note: '' })).toContain('not a control');
  });
});

describe('fiscal calendars are contiguous and cover the year exactly', () => {
  const shapes: [string, 'Monthly (12)' | 'Quarterly (4)', number][] = [
    ['2026-06-30', 'Monthly (12)', 12],
    ['2026-12-31', 'Monthly (12)', 12],
    ['2026-02-28', 'Monthly (12)', 12],
    ['2026-06-30', 'Quarterly (4)', 4],
    ['2026-12-31', 'Quarterly (4)', 4],
  ];

  it.each(shapes)('%s %s has %i contiguous periods ending on the year end', (fyEnd, type, n) => {
    const cal = buildCalendar('u', fyEnd, type);
    expect(cal).toHaveLength(n);
    expect(cal[n - 1].ends).toBe(fyEnd);
    for (let i = 1; i < cal.length; i++) {
      // No gap and no overlap: each period starts the day after the last ended.
      const prevEnd = new Date(`${cal[i - 1].ends}T00:00:00Z`).getTime();
      const thisStart = new Date(`${cal[i].starts}T00:00:00Z`).getTime();
      expect(thisStart - prevEnd).toBe(86400000);
    }
  });

  it('a month-end year end keeps every period on a month end', () => {
    const cal = buildCalendar('u', '2026-06-30', 'Monthly (12)');
    expect(cal.map((p) => p.ends)).toEqual([
      '2025-07-31', '2025-08-31', '2025-09-30', '2025-10-31', '2025-11-30', '2025-12-31',
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
    ]);
  });
});
