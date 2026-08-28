import type { AppState } from '../core/types';
import { emptyAppState } from '../core/emptyState';

export function scopeState(state: AppState, tenantIds: string[]): AppState {
  const allowed = new Set(tenantIds);
  const stripped: AppState = {
    ...emptyAppState(),
    tenants: state.tenants.filter((t) => allowed.has(t.id)),
    users: state.users.filter((u) => allowed.has(u.tenantId)),
    curves: pickRecord(state.curves, allowed),
    units: pickRecord(state.units, allowed),
    settings: pickRecord(state.settings, allowed),
    authority: pickRecord(state.authority, allowed),
    data: {},
    chg: state.chg.filter((x) => allowed.has(x.tenantId)),
    log: state.log.filter((x) => allowed.has(x.tenantId)),
  };
  for (const t of stripped.tenants) {
    for (const u of stripped.units[t.id] ?? []) {
      if (state.data[u.id]) stripped.data[u.id] = state.data[u.id];
    }
  }
  return stripped;
}

export function pickRecord<T>(rec: Record<string, T>, allowed: Set<string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) if (allowed.has(k)) out[k] = v;
  return out;
}
