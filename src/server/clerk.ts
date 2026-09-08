import { createClerkClient } from '@clerk/backend';

export function clerk() {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) throw new Error('CLERK_SECRET_KEY is not set');
  return createClerkClient({ secretKey: key });
}

/** Clerk session list is per user; empty input skips the API. */
export async function clerkUserIdsWithActiveSession(clerkUserIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(clerkUserIds.filter(Boolean))];
  const active = new Set<string>();
  await Promise.all(unique.map(async (userId) => {
    try {
      const list = await clerk().sessions.getSessionList({ userId, status: 'active', limit: 1 });
      if (list.data.length) active.add(userId);
    } catch {
      /* Presence is best-effort; a Clerk miss must not fail hydrate. */
    }
  }));
  return active;
}
