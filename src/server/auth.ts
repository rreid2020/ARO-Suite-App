import { verifyToken } from '@clerk/backend';
import { HTTPException } from 'hono/http-exception';
import type { AppUser, Membership } from '@prisma/client';
import { clerk } from './clerk';
import { prisma } from './db';
import { resolveAppUser } from './identity';

export interface Authed {
  clerkUserId: string;
  name: string;
  email: string;
  appUser: AppUser;
  memberships: (Membership & { tenantId: string })[];
  tenantIds: string[];
}

export async function authenticate(authorization: string | undefined): Promise<Authed> {
  if (!authorization?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Sign in required' });
  }
  const token = authorization.slice(7);
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new HTTPException(500, { message: 'CLERK_SECRET_KEY is not set' });

  let clerkUserId: string;
  try {
    const payload = await verifyToken(token, { secretKey });
    if (!payload.sub) throw new Error('missing sub');
    clerkUserId = payload.sub;
  } catch {
    throw new HTTPException(401, { message: 'Invalid session' });
  }

  const user = await clerk().users.getUser(clerkUserId);
  const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? '';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || email || 'User';

  const appUser = await resolveAppUser(prisma, { clerkUserId, name, email });

  const memberships = await prisma.membership.findMany({ where: { userId: appUser.id } });
  return {
    clerkUserId,
    name,
    email,
    appUser,
    memberships,
    tenantIds: memberships.map((m) => m.tenantId),
  };
}

export function assertTenant(auth: Authed, tenantId: string): Membership {
  const m = auth.memberships.find((x) => x.tenantId === tenantId);
  if (!m) throw new HTTPException(403, { message: 'Not a member of this tenant' });
  return m;
}
