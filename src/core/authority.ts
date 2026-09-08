/**
 * Authority and roles — INVARIANTS §3 and §7.
 *
 * "Enforcement lives in the single write path, not in the UI and not per
 * endpoint. This is what makes the three modes one product instead of three."
 *
 * Nothing in this file renders anything. It decides, and `writePath.ts` obeys.
 */

/** The six authority domains — INVARIANTS §3. */
export type Domain =
  | 'register'
  | 'estimates'
  | 'assumptions'
  | 'periods'
  | 'journals'
  | 'evidence';

export interface DomainDef {
  id: Domain;
  label: string;
  /** What a write into this domain actually touches, in the accounting. */
  covers: string;
}

export const DOMAINS: DomainDef[] = [
  { id: 'register', label: 'Register & scoping', covers: 'Which obligations exist, what is in scope, and why anything was scoped out.' },
  { id: 'estimates', label: 'Estimates & revisions', covers: 'The cost build-up, cost revisions and timing revisions.' },
  { id: 'assumptions', label: 'Assumptions, curve & materiality', covers: 'Inflation, contingency, the discount curve, the term convention and the materiality thresholds.' },
  { id: 'periods', label: 'Periods, calendar & close', covers: 'The accounting periods, their status, the close calendar and the year-end lock sequence.' },
  { id: 'journals', label: 'Journals, postings & reconciliation', covers: 'Month-end accretion and amortization, journal batches, posting, suspense and the sub-ledger to GL reconciliation.' },
  { id: 'evidence', label: 'Evidence, sampling & sign-off', covers: 'Freezes, samples, tickmarks, exception memos and the signature record.' },
];

/** The three modes a domain can be in. */
export type AuthorityMode = 'We own it' | 'Source-owned' | 'Frozen copy';

export const AUTHORITY_MODES: AuthorityMode[] = ['We own it', 'Source-owned', 'Frozen copy'];

export const MODE_NOTE: Record<AuthorityMode, string> = {
  'We own it':
    'This tenant is the authority for this domain. Writes are accepted and recorded against it.',
  'Source-owned':
    'The source system is the authority. Writes are refused here; the figures are read and recalculated, and a difference is reported as a variance rather than corrected.',
  'Frozen copy':
    'This is a frozen copy taken at a point in time. Writes are refused; a re-import creates a new version with a diff rather than editing this one.',
};

export type TenantKind = 'Reporting entity' | 'Auditor';

export const TENANT_KINDS: TenantKind[] = ['Reporting entity', 'Auditor'];

/**
 * Defaults by tenant kind — INVARIANTS §3: "a reporting entity owns everything;
 * an auditor owns its materiality and its conclusion and reads the rest."
 *
 * For the auditor, "its materiality" is the assumptions domain and "its
 * conclusion" is the evidence domain. That is coherent because Mode 3 holds the
 * firm's independent assumptions alongside the client's, attributed input by
 * input, rather than overwriting them.
 */
export function defaultAuthority(kind: TenantKind): Record<Domain, AuthorityMode> {
  if (kind === 'Auditor') {
    return {
      register: 'Source-owned',
      estimates: 'Source-owned',
      assumptions: 'We own it',
      periods: 'Source-owned',
      journals: 'Source-owned',
      evidence: 'We own it',
    };
  }
  return {
    register: 'We own it',
    estimates: 'We own it',
    assumptions: 'We own it',
    periods: 'We own it',
    journals: 'We own it',
    evidence: 'We own it',
  };
}

/* ── Roles ──────────────────────────────────────────────────────────────── */

/**
 * Role gating is by capability, not by screen — README, "Interactions".
 *
 * `sign` is 0 / 1 / 2 = preparer / reviewer / partner. The role list itself is
 * engine vocabulary and deliberately fixed (DOMAIN-MODEL: "a custom role would
 * be a permission that silently does nothing").
 */
export interface RoleDef {
  id: string;
  label: string;
  edit: boolean;
  /** null = cannot sign at all. */
  sign: 0 | 1 | 2 | null;
  createEng: boolean;
  admin: boolean;
  note: string;
}

export const ROLES: RoleDef[] = [
  {
    id: 'preparer', label: 'Preparer', edit: true, sign: 0, createEng: false, admin: false,
    note: 'Prepares and approves the work. Cannot post a journal batch.',
  },
  {
    id: 'reviewer', label: 'Reviewer', edit: true, sign: 1, createEng: false, admin: false,
    note: 'Reviews and posts. Cannot reverse a posted batch and cannot lock a period.',
  },
  {
    id: 'partner', label: 'Engagement partner', edit: true, sign: 2, createEng: true, admin: false,
    note: 'Signs off, posts, reverses and locks. The last partner on a tenant cannot be removed or demoted.',
  },
  {
    id: 'admin', label: 'Firm admin', edit: true, sign: null, createEng: true, admin: true,
    note: 'Administers the tenant, its users and its reference data. Cannot sign off — that is an engagement judgement.',
  },
  {
    id: 'readonly', label: 'Read only', edit: false, sign: null, createEng: false, admin: false,
    note: 'Reads everything in the tenant and writes nothing.',
  },
  {
    id: 'client', label: 'Client contact', edit: false, sign: null, createEng: false, admin: false,
    note: 'Sees the client portal request list only.',
  },
];

export const roleById = (id: string): RoleDef =>
  ROLES.find((r) => r.id === id) ?? ROLES[ROLES.length - 2];

export const canEdit = (role: string) => roleById(role).edit;
export const canAdmin = (role: string) => roleById(role).admin;
export const canCreateUnit = (role: string) => roleById(role).createEng;
export const signLevel = (role: string) => roleById(role).sign;
/** Firm admin or engagement partner — they own tenant reference data and company setup. */
export const canConfigureTenant = (role: string) => canAdmin(role) || signLevel(role) === 2;

/** Why a roster Remove must be refused. Null means the membership can go. */
export function memberRemovalBlocker(opts: {
  targetUserId: string;
  targetRole: string;
  actorUserId: string;
  partnerCount: number;
}): string | null {
  if (opts.targetUserId === opts.actorUserId) return 'You cannot remove yourself.';
  if (signLevel(opts.targetRole) === 2 && opts.partnerCount <= 1) {
    return 'The last engagement partner cannot be removed — with none, nothing could ever be signed off.';
  }
  return null;
}

/** INVARIANTS §7: "preparer approves, reviewer or partner posts". */
export const canPost = (role: string) => {
  const s = signLevel(role);
  return s !== null && s >= 1;
};

/** INVARIANTS §7 and §8: reversal and period lock are partner-only. */
export const canReverse = (role: string) => signLevel(role) === 2;
export const canLockPeriod = (role: string) => signLevel(role) === 2;
