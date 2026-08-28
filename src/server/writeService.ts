import type { WriteRequest, WriteResult } from '../core/writePath';
import { mut } from '../core/writePath';
import type { Authed } from './auth';
import { assertTenant } from './auth';
import { prisma } from './db';
import { appendAudit, appendChanges } from './persist';

export async function serverWrite<T>(auth: Authed, req: WriteRequest<T>): Promise<WriteResult<T>> {
  const membership = assertTenant(auth, req.tenantId);
  const secured: WriteRequest<T> = {
    ...req,
    actor: auth.name || req.actor,
    role: membership.role,
  };
  const result = mut(secured);
  if (result.changes.length) await appendChanges(prisma, result.changes);
  if (result.audit.length) await appendAudit(prisma, result.audit);
  return result;
}
