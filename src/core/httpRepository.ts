import type { AppState } from './types';
import type { AuditEvent, ChangeEntry, WriteRequest, WriteResult } from './writePath';
import type { Repository } from './repository';

export class HttpRepository implements Repository {
  private bytes = 0;

  constructor(private getToken: () => Promise<string | null>) {}

  private async headers(): Promise<HeadersInit> {
    const token = await this.getToken();
    if (!token) throw new Error('Sign in required');
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  private async parse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(body.error || res.statusText);
    }
    return res.json() as Promise<T>;
  }

  async load(): Promise<AppState | null> {
    const res = await fetch('/api/state', { headers: await this.headers() });
    const state = await this.parse<AppState>(res);
    this.bytes = JSON.stringify(state).length;
    return state;
  }

  async save(state: AppState): Promise<void> {
    const payload = JSON.stringify(state);
    this.bytes = payload.length;
    const res = await fetch('/api/state', { method: 'PUT', headers: await this.headers(), body: payload });
    await this.parse(res);
  }

  async appendChanges(entries: ChangeEntry[]): Promise<void> {
    if (!entries.length) return;
    const res = await fetch('/api/changes', { method: 'POST', headers: await this.headers(), body: JSON.stringify(entries) });
    await this.parse(res);
  }

  async appendAudit(entries: AuditEvent[]): Promise<void> {
    if (!entries.length) return;
    const res = await fetch('/api/audit', { method: 'POST', headers: await this.headers(), body: JSON.stringify(entries) });
    await this.parse(res);
  }

  async commitWrite<T>(req: WriteRequest<T>): Promise<WriteResult<T>> {
    const res = await fetch('/api/writes', { method: 'POST', headers: await this.headers(), body: JSON.stringify(req) });
    return this.parse<WriteResult<T>>(res);
  }

  async createTenant(name: string, kind: string): Promise<{ tenantId: string; state: AppState }> {
    const res = await fetch('/api/tenants', {
      method: 'POST', headers: await this.headers(),
      body: JSON.stringify({ name, kind }),
    });
    return this.parse(res);
  }

  async deleteTenant(id: string): Promise<void> {
    const res = await fetch(`/api/tenants/${id}`, { method: 'DELETE', headers: await this.headers() });
    await this.parse(res);
  }

  async loadSample(): Promise<AppState> {
    const res = await fetch('/api/seed', { method: 'POST', headers: await this.headers() });
    return this.parse<AppState>(res);
  }

  async clear(): Promise<void> {
    /* Tenants are deleted individually. */
  }

  size(): number {
    return this.bytes;
  }
}
