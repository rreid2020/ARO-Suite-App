/**
 * Persistence seam.
 *
 * README, "State management": the prototype held everything in one component
 * state object persisted to `localStorage` under a 2 MB cap, and says plainly
 * "Do not reproduce that. It is a demo affordance and it is the thing the
 * backend replaces."
 *
 * So it is not reproduced. Persistence lives behind this one interface, the
 * application never touches storage directly, and the only implementation that
 * knows about `localStorage` is at the bottom of this file. Swapping in an HTTP
 * repository against the schema in DOMAIN-MODEL.md changes this file and
 * nothing else.
 *
 * Note what the interface does NOT offer: no update and no delete for `chg` and
 * `log`. Those are write-once tables (INVARIANTS §2), so the only operation is
 * append.
 */

import { AppState } from './types';
import { AuditEvent, ChangeEntry } from './writePath';

export interface Repository {
  load(): Promise<AppState | null>;
  /** Persist the domain state. Append-only tables are handed over separately. */
  save(state: AppState): Promise<void>;
  /** Append-only — INVARIANTS §2. There is no update and no delete. */
  appendChanges(entries: ChangeEntry[]): Promise<void>;
  appendAudit(entries: AuditEvent[]): Promise<void>;
  clear(): Promise<void>;
  /** Bytes currently held, for the session-size control on Authority & security. */
  size(): number;
}

const KEY = 'aro-suite/state/v1';

/**
 * Browser-local implementation. Correct for a single-user demo and for offline
 * work; it is not the product's storage story and it is not multi-tenant safe,
 * which is exactly why it is isolated here.
 */
export class LocalStorageRepository implements Repository {
  async load(): Promise<AppState | null> {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as AppState) : null;
    } catch {
      // A quota error, a private window, or a half-written value. Start clean
      // rather than failing to boot.
      return null;
    }
  }

  async save(state: AppState): Promise<void> {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Over quota. The in-memory state is still correct for this session; the
      // Authority & security screen reports the size and offers a clear.
    }
  }

  /**
   * Both append methods are no-ops here because `chg` and `log` live inside the
   * same state blob for a browser-only build. They exist so that the call sites
   * are already shaped for a server that writes them to their own tables — the
   * application already treats them as append-only and never edits an entry.
   */
  async appendChanges(): Promise<void> {}
  async appendAudit(): Promise<void> {}

  async clear(): Promise<void> {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing to clear */
    }
  }

  size(): number {
    try {
      return (localStorage.getItem(KEY) ?? '').length;
    } catch {
      return 0;
    }
  }
}
