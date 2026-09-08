/**
 * Application store.
 *
 * The one rule this file exists to enforce: nothing outside `write()` may change
 * a domain record. Screens call `write()`, `write()` calls `mut()`, and `mut()`
 * decides. That is INVARIANTS §3's "single write path" expressed as the only
 * mutation API the UI is given.
 *
 * Domain writes are re-run on the server with the membership role, not the
 * role the client claimed.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth, useUser } from '@clerk/react';
import { AppState, UiState } from './types';
import { AuditEvent, ChangeEntry, Refusal, WriteRequest, WriteResult, mut, note, restore, setPath } from './writePath';
import { Domain } from './authority';
import { Repository } from './repository';
import { HttpRepository } from './httpRepository';
import { emptyAppState } from './emptyState';
import { stampLayeredUnits } from './createUnit';

interface WriteArgs<T> {
  domain: Domain;
  record: string;
  recordLabel: string;
  before: T;
  after: T;
  action: string;
  guarded?: Record<string, string>;
  apply: (s: AppState, value: T) => void;
}

export interface Store {
  state: AppState;
  ui: UiState;
  setUi: (patch: Partial<UiState>) => void;
  write: <T>(args: WriteArgs<T>) => WriteResult<T>;
  restoreChange: (entry: ChangeEntry) => void;
  record: (action: string, kind: AuditEvent['kind'], detail: string) => void;
  apply: (action: string, kind: AuditEvent['kind'], detail: string, fn: (s: AppState) => void) => void;
  reset: () => void;
  storageBytes: number;
  repo: Repository;
  ready: boolean;
  createTenant: (name: string, kind: string) => Promise<string>;
  loadSample: () => Promise<void>;
  deleteTenant: (id: string) => Promise<void>;
  inviteUser: (name: string, email: string, role: string) => Promise<void>;
  removeUser: (userId: string) => Promise<void>;
}

const Ctx = createContext<Store | null>(null);

const initialUi: UiState = {
  signedIn: false,
  userName: '',
  role: 'preparer',
  tenantId: null,
  unitId: null,
  screen: 'setup',
  tab: '',
  sub: '',
  setupTrail: null,
  toast: null,
};

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const { user } = useUser();
  const repo = useRef<HttpRepository>(new HttpRepository(() => getToken())).current;
  const [state, setState] = useState<AppState>(emptyAppState);
  const [ui, setUiState] = useState<UiState>(initialUi);
  const [bytes, setBytes] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setState(emptyAppState());
      setUiState(initialUi);
      setLoaded(false);
      return;
    }
    let live = true;
    repo.load().then((s) => {
      if (!live) return;
      if (s) setState(s);
      setLoaded(true);
      setBytes(repo.size());
    }).catch((err: Error) => {
      if (!live) return;
      setLoaded(true);
      setUiState((u) => ({ ...u, toast: { kind: 'refused', text: err.message } }));
    });
    return () => { live = false; };
  }, [repo, isLoaded, isSignedIn]);

  useEffect(() => {
    if (!loaded || !isSignedIn) return;
    repo.save(state).then(() => setBytes(repo.size())).catch(() => { /* next write retries */ });
  }, [state, loaded, repo, isSignedIn]);

  const setUi = useCallback((patch: Partial<UiState>) => {
    setUiState((u) => ({ ...u, ...patch }));
  }, []);

  const toastFor = (r: WriteResult<unknown>) => {
    if (!r.ok) return { kind: 'refused' as const, text: (r.refusal as Refusal).reason };
    if (r.refusedFields.length) {
      return {
        kind: 'refused' as const,
        text: `${r.changes.length} field${r.changes.length === 1 ? '' : 's'} written, ${r.refusedFields.length} refused: ${r.refusedFields.map((f) => `${f.field} — ${f.reason}`).join('; ')}`,
      };
    }
    return null;
  };

  const write = useCallback(
    <T,>(args: WriteArgs<T>): WriteResult<T> => {
      const tenantId = ui.tenantId!;
      const req: WriteRequest<T> = {
        domain: args.domain,
        tenantId,
        unitId: ui.unitId ?? undefined,
        record: args.record,
        recordLabel: args.recordLabel,
        before: args.before,
        after: args.after,
        actor: ui.userName || 'Unknown',
        role: ui.role,
        action: args.action,
        authority: state.authority[tenantId],
        guarded: args.guarded,
      };

      const result = mut(req);

      setState((s) => {
        const next = structuredClone(s);
        if (result.ok) args.apply(next, result.value);
        stampLayeredUnits(next);
        next.chg = [...result.changes, ...next.chg];
        next.log = [...result.audit, ...next.log];
        return next;
      });

      void repo.commitWrite(req).then((server) => {
        if (server.ok === result.ok) return;
        setUi({ toast: toastFor(server) });
        repo.load().then((s) => { if (s) setState(s); });
      }).catch((err: Error) => setUi({ toast: { kind: 'refused', text: err.message } }));

      setUi({ toast: toastFor(result) });
      return result;
    },
    [ui.tenantId, ui.unitId, ui.userName, ui.role, state.authority, repo, setUi],
  );

  const restoreChange = useCallback(
    (entry: ChangeEntry) => {
      const unitId = entry.unitId;
      const target = unitId
        ? state.data[unitId]?.obligations.find((o) => o.id === entry.record)
        : undefined;

      if (!target) {
        setUi({
          toast: {
            kind: 'refused',
            text: `"${entry.recordLabel}" is a summary of a bulk write, not a single record. Restore the individual fields from their own entries instead.`,
          },
        });
        return;
      }

      const after = structuredClone(target);
      setPath(after as object, entry.field, entry.before);

      const req = {
        domain: 'register' as const,
        tenantId: entry.tenantId,
        unitId,
        record: entry.record,
        recordLabel: entry.recordLabel,
        before: target,
        after,
        actor: ui.userName || 'Unknown',
        role: ui.role,
        authority: state.authority[entry.tenantId],
      };
      const result = restore(req, entry);

      setState((s) => {
        const next = structuredClone(s);
        if (result.ok && unitId) {
          const list = next.data[unitId].obligations;
          const i = list.findIndex((o) => o.id === entry.record);
          if (i >= 0) list[i] = result.value as typeof list[number];
        }
        next.chg = [...result.changes, ...next.chg];
        next.log = [...result.audit, ...next.log];
        return next;
      });
      void repo.commitWrite({ ...req, action: `Restore ${entry.field}` });
      setUi({ toast: toastFor(result) });
    },
    [state.data, state.authority, ui.userName, ui.role, repo, setUi],
  );

  const record = useCallback(
    (action: string, kind: AuditEvent['kind'], detail: string) => {
      const entry = note(ui.tenantId!, ui.unitId ?? undefined, ui.userName || 'Unknown', action, kind, detail);
      setState((s) => ({ ...s, log: [entry, ...s.log] }));
      void repo.appendAudit([entry]);
    },
    [ui.tenantId, ui.unitId, ui.userName, repo],
  );

  const apply = useCallback(
    (action: string, kind: AuditEvent['kind'], detail: string, fn: (s: AppState) => void) => {
      const entry = note(ui.tenantId ?? 'install', ui.unitId ?? undefined, ui.userName || 'Unknown', action, kind, detail);
      setState((s) => {
        const next = structuredClone(s);
        fn(next);
        stampLayeredUnits(next);
        next.log = [entry, ...next.log];
        return next;
      });
      void repo.appendAudit([entry]);
      setUi({ toast: { kind: 'ok', text: detail } });
    },
    [ui.tenantId, ui.unitId, ui.userName, repo, setUi],
  );

  const reset = useCallback(() => {
    setState(emptyAppState());
    setUiState(initialUi);
  }, []);

  const createTenant = useCallback(async (name: string, kind: string) => {
    const result = await repo.createTenant(name, kind);
    setState(result.state);
    setLoaded(true);
    return result.tenantId;
  }, [repo]);

  const loadSample = useCallback(async () => {
    const next = await repo.loadSample();
    setState(next);
    setLoaded(true);
  }, [repo]);

  const deleteTenant = useCallback(async (id: string) => {
    await repo.deleteTenant(id);
    const next = await repo.load();
    if (next) setState(next);
  }, [repo]);

  const inviteUser = useCallback(async (name: string, email: string, role: string) => {
    const tenantId = ui.tenantId;
    if (!tenantId) throw new Error('Choose a tenant first.');
    const result = await repo.inviteUser(tenantId, { name, email, role });
    setState(result.state);
    setLoaded(true);
    setUi({ toast: { kind: 'ok', text: result.message } });
  }, [repo, ui.tenantId, setUi]);

  const removeUser = useCallback(async (userId: string) => {
    const tenantId = ui.tenantId;
    if (!tenantId) throw new Error('Choose a tenant first.');
    const result = await repo.removeUser(tenantId, userId);
    setState(result.state);
    setLoaded(true);
    setUi({ toast: { kind: 'ok', text: result.message } });
  }, [repo, ui.tenantId, setUi]);

  const displayName = user?.fullName || user?.primaryEmailAddress?.emailAddress || ui.userName;

  const value = useMemo<Store>(
    () => ({
      state, ui, setUi, write, restoreChange, record, apply, reset, storageBytes: bytes, repo,
      ready: loaded || !isSignedIn,
      createTenant, loadSample, deleteTenant, inviteUser, removeUser,
    }),
    [state, ui, setUi, write, restoreChange, record, apply, reset, bytes, repo, loaded, isSignedIn, createTenant, loadSample, deleteTenant, inviteUser, removeUser],
  );

  // Keep the signed-in name in UI state for the audit actor without looping.
  const nameRef = useRef(displayName);
  if (displayName && displayName !== nameRef.current) {
    nameRef.current = displayName;
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore must be used inside a StoreProvider');
  return s;
}

export function useTenant() {
  const { state, ui } = useStore();
  return state.tenants.find((t) => t.id === ui.tenantId) ?? null;
}

export function useUnit() {
  const { state, ui } = useStore();
  if (!ui.tenantId || !ui.unitId) return null;
  return (state.units[ui.tenantId] ?? []).find((u) => u.id === ui.unitId) ?? null;
}

export function useUnitData() {
  const { state, ui } = useStore();
  return ui.unitId ? state.data[ui.unitId] ?? null : null;
}

export function useUnitWord() {
  const tenant = useTenant();
  return tenant?.kind === 'Auditor' ? 'Engagement' : 'Reporting unit';
}
