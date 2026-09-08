import { describe, expect, it } from 'vitest';
import { memberRemovalBlocker } from '../authority';
import {
  clerkErrorLooksDuplicate,
  inviteRedirectUrl,
  isValidEmail,
  normalizeEmail,
  planUserClaim,
  userSignInLabel,
} from '../invite';

describe('invite email matching', () => {
  it('normalises work email for matching', () => {
    expect(normalizeEmail('  Ali@Forces.gc.ca ')).toBe('ali@forces.gc.ca');
    expect(isValidEmail('MUHAMMADALI.NASIR@forces.gc.ca')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
  });

  it('keeps the oldest stub and moves unique memberships onto it', () => {
    const plan = planUserClaim([
      { id: 'u-old', memberships: [{ id: 'm1', tenantId: 'axiom' }] },
      { id: 'u-new', memberships: [{ id: 'm2', tenantId: 'kestrel' }, { id: 'm3', tenantId: 'axiom' }] },
    ]);
    expect(plan).toEqual({
      keepId: 'u-old',
      move: [{ membershipId: 'm2' }],
      dropMembershipIds: ['m3'],
      deleteUserIds: ['u-new'],
    });
  });

  it('returns null when there is no pending stub to claim', () => {
    expect(planUserClaim([])).toBeNull();
  });

  it('treats Clerk duplicate/pending invitation errors as already invited', () => {
    expect(clerkErrorLooksDuplicate(new Error('There is already a pending invitation for this email address'))).toBe(true);
    expect(clerkErrorLooksDuplicate(new Error('network down'))).toBe(false);
  });
});

describe('invitation redirect', () => {
  it('lands on the in-app sign-up page', () => {
    expect(inviteRedirectUrl('http://localhost:5173')).toBe('http://localhost:5173/?auth=signup');
    expect(inviteRedirectUrl('https://aro-suite-app.vercel.app/')).toBe('https://aro-suite-app.vercel.app/?auth=signup');
  });
});

describe('sign-in column', () => {
  it('uses live session, not merely having an account', () => {
    expect(userSignInLabel({ pendingInvite: true })).toBe('Invitation pending');
    expect(userSignInLabel({ sessionActive: true })).toBe('Signed in');
    expect(userSignInLabel({})).toBe('Signed out');
  });
});

describe('member removal', () => {
  it('refuses self-removal and the last partner', () => {
    expect(memberRemovalBlocker({
      targetUserId: 'u-me', targetRole: 'preparer', actorUserId: 'u-me', partnerCount: 2,
    })).toMatch(/yourself/);
    expect(memberRemovalBlocker({
      targetUserId: 'u-p', targetRole: 'partner', actorUserId: 'u-me', partnerCount: 1,
    })).toMatch(/last engagement partner/);
    expect(memberRemovalBlocker({
      targetUserId: 'u-r', targetRole: 'preparer', actorUserId: 'u-me', partnerCount: 1,
    })).toBeNull();
  });
});
