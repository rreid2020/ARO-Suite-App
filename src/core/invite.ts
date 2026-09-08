/**
 * Tenant invitation helpers — email matching and claim planning.
 *
 * Clerk identity is attached on first sign-in. Until then the roster row is a
 * stub keyed by work email (case-insensitive).
 */

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

export interface PendingMembership {
  id: string;
  tenantId: string;
}

export interface PendingUser {
  id: string;
  memberships: PendingMembership[];
}

export interface UserClaimPlan {
  keepId: string;
  move: { membershipId: string }[];
  dropMembershipIds: string[];
  deleteUserIds: string[];
}

/** Oldest pending stub keeps the Clerk id; extra stubs donate unique memberships. */
export function planUserClaim(pending: PendingUser[]): UserClaimPlan | null {
  if (!pending.length) return null;
  const keep = pending[0];
  const keepTenants = new Set(keep.memberships.map((m) => m.tenantId));
  const move: { membershipId: string }[] = [];
  const dropMembershipIds: string[] = [];
  const deleteUserIds: string[] = [];
  for (const extra of pending.slice(1)) {
    deleteUserIds.push(extra.id);
    for (const m of extra.memberships) {
      if (keepTenants.has(m.tenantId)) dropMembershipIds.push(m.id);
      else {
        move.push({ membershipId: m.id });
        keepTenants.add(m.tenantId);
      }
    }
  }
  return { keepId: keep.id, move, dropMembershipIds, deleteUserIds };
}

export function clerkErrorLooksDuplicate(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '');
  const blob = text.toLowerCase();
  return /already|duplicate|exist|pending invitation/.test(blob);
}

export function inviteRedirectUrl(origin: string | undefined, envOrigin = ''): string {
  const fromEnv = envOrigin.replace(/\/$/, '');
  const base = (origin ?? '').replace(/\/$/, '') || fromEnv || 'https://aro-suite-app.vercel.app';
  return `${base}/?auth=signup`;
}

export function userSignInLabel(u: { pendingInvite?: boolean; sessionActive?: boolean }): string {
  if (u.pendingInvite) return 'Invitation pending';
  if (u.sessionActive) return 'Signed in';
  return 'Signed out';
}
