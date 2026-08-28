/**
 * Application store.
 *
 * The one rule this file exists to enforce: nothing outside `write()` may change
 * a domain record. Screens call `write()`, `write()` calls `mut()`, and `mut()`
 * decides. That is INVARIANTS §3's "single write path" expressed as the only
 * mutation API the UI is given.
 *
 * UI state (`ui`) is separate and moves freely — README's state mapping table
 * calls `sel`, `views`, `sort`, `filters` and `page` genuine client state.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, UiState } from './types';
import { AuditEvent, ChangeEntry, Refusal, WriteRequest, WriteResult, mut, note, restore, setPath } from './writePath';
import { Domain } from './authority';
import { LocalStorageRepository, Repository } from './repository';
import { seedState } from '../seed';

interface WriteArgs<T> {
  domain: Domain;
  record: string;
  recordLabel: string;
  before: T;
  after: T;
  action: string;
  /** Fields this write may not touch, with the reason, by name. */
  guarded?: Record<string, string>;
  /** Applies the accepted value back into the state tree. */
  apply: (s: AppState, value: T) => void;
}

export interface Store {
  state: AppState;
  ui: UiState;
  setUi: (patch: Partial<UiState>) => void;
  /** The only way to change a domain record. */
  write: <T>(args: WriteArgs<T>) => WriteResult<T>;
  /** INVARIANTS §2 — a restore is a new logged change, never an edit. */
  restoreChange: (entry: ChangeEntry) => void;
  /** Record an action that is not a field edit — a post, a lock, an export. */
  record: (action: string, kind: AuditEvent['kind'], detail: string) => void;
  /** Escape hatch for non-domain state (freezes, samples) that still logs. */
  apply: (action: string, kind: AuditEvent['kind'], detail: string, fn: (s: AppState) => void) => void;
  reset: () => void;
  storageBytes: number;
  repo: Repository;
}

const Ctx = createContext<Store | null>(null);

const initialUi: UiState = {
  signedIn: false,
  userName: '',
  role: 'preparer',
  tenantId: null,
  unitId: null,
  screen: 'units',
  tab: '',
  sub: '',
  setupTrail: null,
  toast: null,
};

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const repo = useRef<Repository>(new LocalStorageRepository()).current;
  const [state, setState] = useState<AppState>(() => seedState());
  const [ui, setUiState] = useState<UiState>(initialUi);
  const [bytes, setBytes] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    repo.load().then((s) => {
      if (!live) return;
      if (s) setState(s);
      setLoaded(true);
    });
    return () => { live = false; };
  }, [repo]);

  useEffect(() => {
    if (!loaded) return;
    repo.save(state).then(() => setBytes(repo.size()));
  }, [state, loaded, repo]);

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
        // Append-only — INVARIANTS §2. Never edited, never removed.
        next.chg = [...result.changes, ...next.chg];
        next.log = [...result.audit, ...next.log];
        return next;
      });

      repo.appendChanges(result.changes);
      repo.appendAudit(result.audit);
      setUi({ toast: toastFor(result) });
      return result;
    },
    [ui.tenantId, ui.unitId, ui.userName, ui.role, state.authority, repo, setUi],
  );

  /**
   * A restore actually puts the old value back, as an ordinary write that
   * carries `restoredFrom`. It goes through `mut()` like everything else, so a
   * restore into a domain the tenant does not own is refused exactly as the
   * original edit would have been. The original entry stands untouched —
   * history reads forward and is never rewritten.
   */
  const restoreChange = useCallback(
    (entry: ChangeEntry) => {
      const unitId = entry.unitId;
      const target = unitId
        ? state.data[unitId]?.obligations.find((o) => o.id === entry.record)
        : undefined;

      if (!target) {
        // Bulk-edit and paste entries are summaries of a write, not a record
        // that can be put back field by field. Say so rather than pretending.
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

      const result = restore(
        {
          domain: 'register',
          tenantId: entry.tenantId,
          unitId,
          record: entry.record,
          recordLabel: entry.recordLabel,
          before: target,
          after,
          actor: ui.userName || 'Unknown',
          role: ui.role,
          authority: state.authority[entry.tenantId],
        },
        entry,
      );

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
      setUi({ toast: toastFor(result) });
    },
    [state.data, state.authority, ui.userName, ui.role, setUi],
  );

  const record = useCallback(
    (action: string, kind: AuditEvent['kind'], detail: string) => {
      setState((s) => ({
        ...s,
        log: [note(ui.tenantId!, ui.unitId ?? undefined, ui.userName || 'Unknown', action, kind, detail), ...s.log],
      }));
    },
    [ui.tenantId, ui.unitId, ui.userName],
  );

  const apply = useCallback(
    (action: string, kind: AuditEvent['kind'], detail: string, fn: (s: AppState) => void) => {
      setState((s) => {
        const next = structuredClone(s);
        fn(next);
        next.log = [note(ui.tenantId!, ui.unitId ?? undefined, ui.userName || 'Unknown', action, kind, detail), ...next.log];
        return next;
      });
      setUi({ toast: { kind: 'ok', text: detail } });
    },
    [ui.tenantId, ui.unitId, ui.userName, setUi],
  );

  const reset = useCallback(() => {
    repo.clear().then(() => {
      setState(seedState());
      setUiState(initialUi);
    });
  }, [repo]);

  const value = useMemo<Store>(
    () => ({ state, ui, setUi, write, restoreChange, record, apply, reset, storageBytes: bytes, repo }),
    [state, ui, setUi, write, restoreChange, record, apply, reset, bytes, repo],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore must be used inside a StoreProvider');
  return s;
}

/* ── Selectors ──────────────────────────────────────────────────────────── */

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

/** "Engagement" and "reporting unit" are one object under two names. */
export function useUnitWord() {
  const tenant = useTenant();
  return tenant?.kind === 'Auditor' ? 'Engagement' : 'Reporting unit';
}
