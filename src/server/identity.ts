import type { PrismaClient } from '@prisma/client';
import { HTTPException } from 'hono/http-exception';
import { canConfigureTenant, memberRemovalBlocker, roleById, ROLES } from '../core/authority';
import {
  clerkErrorLooksDuplicate,
  isValidEmail,
  normalizeEmail,
  planUserClaim,
  inviteRedirectUrl,
} from '../core/invite';
import { note } from '../core/writePath';
import { clerk } from './clerk';
import { prisma } from './db';
import { hydrateAppState } from './hydrate';
import { appendAudit } from './persist';

export async function resolveAppUser(
  db: PrismaClient,
  input: { clerkUserId: string; name: string; email: string },
) {
  const byClerk = await db.appUser.findUnique({ where: { clerkUserId: input.clerkUserId } });
  if (byClerk) {
    return db.appUser.update({
      where: { id: byClerk.id },
      data: { name: input.name, email: input.email || byClerk.email },
    });
  }

  const email = normalizeEmail(input.email);
  if (!email) {
    return db.appUser.create({
      data: { clerkUserId: input.clerkUserId, name: input.name, email: input.email },
    });
  }

  const pending = await db.appUser.findMany({
    where: { clerkUserId: null, email: { equals: email, mode: 'insensitive' } },
    include: { memberships: { select: { id: true, tenantId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const plan = planUserClaim(pending);
  if (!plan) {
    return db.appUser.create({
      data: { clerkUserId: input.clerkUserId, name: input.name, email: input.email },
    });
  }

  return db.$transaction(async (tx) => {
    for (const id of plan.dropMembershipIds) {
      await tx.membership.delete({ where: { id } });
    }
    for (const { membershipId } of plan.move) {
      await tx.membership.update({ where: { id: membershipId }, data: { userId: plan.keepId } });
    }
    for (const id of plan.deleteUserIds) {
      await tx.appUser.delete({ where: { id } });
    }
    return tx.appUser.update({
      where: { id: plan.keepId },
      data: {
        clerkUserId: input.clerkUserId,
        name: input.name || undefined,
        email: input.email || email,
      },
    });
  });
}

export async function findClerkUserIdByEmail(email: string): Promise<string | null> {
  try {
    const list = await clerk().users.getUserList({ emailAddress: [email], limit: 5 });
    const rows = Array.isArray(list) ? list : list.data;
    const match = rows.find((u) =>
      u.emailAddresses.some((e: { emailAddress: string }) => normalizeEmail(e.emailAddress) === normalizeEmail(email)),
    );
    return match?.id ?? null;
  } catch {
    return null;
  }
}

export async function sendClerkInvitation(email: string, redirectUrl: string): Promise<'sent' | 'already'> {
  try {
    await clerk().invitations.createInvitation({
      emailAddress: email,
      redirectUrl,
      notify: true,
      ignoreExisting: true,
      publicMetadata: { source: 'aro-suite-tenant-invite' },
    });
    return 'sent';
  } catch (err) {
    if (clerkErrorLooksDuplicate(err)) return 'already';
    throw err;
  }
}

export async function inviteToTenant(
  auth: { name: string; email: string; clerkUserId?: string; tenantIds: string[]; memberships: { tenantId: string; role: string }[] },
  tenantId: string,
  body: { name?: string; email?: string; role?: string },
  origin?: string,
): Promise<{ message: string; state: Awaited<ReturnType<typeof hydrateAppState>> }> {
  const membership = auth.memberships.find((m) => m.tenantId === tenantId);
  if (!membership) throw new HTTPException(403, { message: 'Not a member of this tenant' });
  if (!canConfigureTenant(membership.role)) {
    throw new HTTPException(403, { message: 'Only an engagement partner or firm admin can invite users.' });
  }

  const email = normalizeEmail(body.email ?? '');
  const name = (body.name ?? '').trim() || email.split('@')[0] || 'User';
  const role = (body.role ?? 'preparer').trim();
  if (!isValidEmail(email)) throw new HTTPException(400, { message: 'Enter a work email address.' });
  if (!ROLES.some((r) => r.id === role)) throw new HTTPException(400, { message: 'That role is not recognised.' });

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new HTTPException(404, { message: 'That tenant is not on this workspace.' });

  const clerkUserId = await findClerkUserIdByEmail(email);
  let existing = clerkUserId
    ? await prisma.appUser.findUnique({ where: { clerkUserId } })
    : null;
  if (!existing) {
    existing = await prisma.appUser.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      orderBy: { createdAt: 'asc' },
    });
  }

  const user = existing
    ? await prisma.appUser.update({
      where: { id: existing.id },
      data: {
        name: name || existing.name,
        email: email || existing.email,
        ...(clerkUserId && !existing.clerkUserId ? { clerkUserId } : {}),
      },
    })
    : await prisma.appUser.create({
      data: { name, email, clerkUserId: clerkUserId ?? undefined },
    });

  const already = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId: user.id } },
  });
  if (!already) {
    await prisma.membership.create({
      data: {
        tenantId,
        userId: user.id,
        role,
        mfa: 'Not enrolled',
        isOwner: false,
      },
    });
  } else if (already.role !== role) {
    await prisma.membership.update({
      where: { id: already.id },
      data: { role },
    });
  }

  const roleLabel = roleById(role).label;
  const hasAccount = Boolean(user.clerkUserId);
  let message: string;
  if (hasAccount) {
    message = already
      ? `${name} already has an account and is on ${tenant.name} as ${roleLabel}. They will see this tenant the next time they sign in.`
      : `${name} already has an account. Added to ${tenant.name} as ${roleLabel} — they will see this tenant the next time they sign in.`;
  } else {
    try {
      const outcome = await sendClerkInvitation(email, inviteRedirectUrl(origin, process.env.APP_ORIGIN));
      message = outcome === 'sent'
        ? `Invitation sent to ${email} as ${roleLabel} on ${tenant.name}.`
        : `${email} already has a pending Clerk invitation. They remain ${roleLabel} on ${tenant.name}.`;
    } catch (err) {
      const why = err instanceof Error ? err.message : 'Clerk could not send the email';
      message = `Added ${name} as ${roleLabel} on ${tenant.name}, but the invitation email could not be sent (${why}).`;
    }
  }

  await appendAudit(prisma, [
    note(tenantId, undefined, auth.name || auth.email, 'Invite user', 'admin', message),
  ]);

  const state = await hydrateAppState(prisma, auth.tenantIds, { currentClerkUserId: auth.clerkUserId });
  return { message, state };
}

export async function removeUserFromTenant(
  auth: { name: string; email: string; clerkUserId?: string; appUserId: string; tenantIds: string[]; memberships: { tenantId: string; role: string }[] },
  tenantId: string,
  userId: string,
): Promise<{ message: string; state: Awaited<ReturnType<typeof hydrateAppState>> }> {
  const membership = auth.memberships.find((m) => m.tenantId === tenantId);
  if (!membership) throw new HTTPException(403, { message: 'Not a member of this tenant' });
  if (!canConfigureTenant(membership.role)) {
    throw new HTTPException(403, { message: 'Only an engagement partner or firm admin can remove users.' });
  }

  const target = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    include: { user: true, tenant: true },
  });
  if (!target) throw new HTTPException(404, { message: 'That person is not on this tenant.' });

  const partnerCount = await prisma.membership.count({ where: { tenantId, role: 'partner' } });
  const blocked = memberRemovalBlocker({
    targetUserId: target.userId,
    targetRole: target.role,
    actorUserId: auth.appUserId,
    partnerCount,
  });
  if (blocked) throw new HTTPException(400, { message: blocked });

  await prisma.membership.delete({ where: { id: target.id } });
  const message = `Removed ${target.user.name} from ${target.tenant.name}.`;
  await appendAudit(prisma, [
    note(tenantId, undefined, auth.name || auth.email, 'Remove user', 'admin', message),
  ]);
  const state = await hydrateAppState(prisma, auth.tenantIds, { currentClerkUserId: auth.clerkUserId });
  return { message, state };
}
