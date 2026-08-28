import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { emptyTenant, seedState } from '../seed';
import type { AppState } from '../core/types';
import type { WriteRequest } from '../core/writePath';
import { emptyAppState } from '../core/emptyState';
import { authenticate, assertTenant } from './auth';
import { prisma } from './db';
import { hydrateAppState } from './hydrate';
import { appendAudit, appendChanges, persistAppState } from './persist';
import { scopeState } from './scope';
import { prefixSeed } from './seedPrefix';
import { serverWrite } from './writeService';
import type { AuditEvent, ChangeEntry } from '../core/writePath';

type Env = { Variables: { auth: Awaited<ReturnType<typeof authenticate>> } };

export const app = new Hono<Env>();

app.use('/api/*', cors());

app.onError((err, c) => {
  const status = (err as { status?: number }).status ?? 500;
  return c.json({ error: err.message }, status as 400);
});

app.get('/api/health', (c) => c.json({ ok: true }));

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();
  const auth = await authenticate(c.req.header('Authorization'));
  c.set('auth', auth);
  await next();
});

app.get('/api/state', async (c) => {
  const auth = c.get('auth');
  const state = await hydrateAppState(prisma, auth.tenantIds);
  return c.json(state);
});

app.put('/api/state', async (c) => {
  const auth = c.get('auth');
  const state = await c.req.json<AppState>();
  const stripped = scopeState(state, auth.tenantIds);
  await persistAppState(prisma, stripped, auth.tenantIds, auth.appUser.id);
  return c.json({ ok: true });
});

app.post('/api/writes', async (c) => {
  const auth = c.get('auth');
  const req = await c.req.json<WriteRequest<unknown>>();
  const result = await serverWrite(auth, req);
  return c.json(result);
});

app.post('/api/changes', async (c) => {
  const auth = c.get('auth');
  const entries = await c.req.json<ChangeEntry[]>();
  const allowed = entries.filter((e) => auth.tenantIds.includes(e.tenantId));
  await appendChanges(prisma, allowed);
  return c.json({ ok: true, count: allowed.length });
});

app.post('/api/audit', async (c) => {
  const auth = c.get('auth');
  const entries = await c.req.json<AuditEvent[]>();
  const allowed = entries.filter((e) => auth.tenantIds.includes(e.tenantId));
  await appendAudit(prisma, allowed);
  return c.json({ ok: true, count: allowed.length });
});

app.post('/api/tenants', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<{ name: string; kind: 'Reporting entity' | 'Auditor' }>();
  if (!body.name?.trim()) return c.json({ error: 'Organisation name is required' }, 400);
  const made = emptyTenant(body.name.trim(), body.kind ?? 'Reporting entity', auth.name, auth.email);
  const state = emptyAppState();
  state.tenants = [made.tenant];
  state.users = [{ ...made.user, id: auth.appUser.id, name: auth.name, email: auth.email }];
  state.settings[made.tenant.id] = made.settings;
  state.authority[made.tenant.id] = made.authority;
  state.curves[made.tenant.id] = [];
  state.units[made.tenant.id] = [];
  await persistAppState(prisma, state, [made.tenant.id], auth.appUser.id);
  const next = await hydrateAppState(prisma, [...auth.tenantIds, made.tenant.id]);
  return c.json({ tenantId: made.tenant.id, state: next });
});

app.delete('/api/tenants/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const membership = assertTenant(auth, id);
  if (!membership.isOwner) return c.json({ error: 'Only the tenant owner can delete it' }, 403);
  await prisma.tenant.delete({ where: { id } });
  return c.json({ ok: true });
});

app.post('/api/seed', async (c) => {
  const auth = c.get('auth');
  const prefix = `s${auth.appUser.id.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}-`;
  const seeded = prefixSeed(seedState(), prefix);
  await persistAppState(prisma, seeded, seeded.tenants.map((t) => t.id), auth.appUser.id);
  const next = await hydrateAppState(prisma, [
    ...auth.tenantIds,
    ...seeded.tenants.map((t) => t.id),
  ]);
  return c.json(next);
});
