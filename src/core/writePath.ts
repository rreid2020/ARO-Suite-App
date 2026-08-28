/**
 * The single write path — INVARIANTS §2, §3 and §5.
 *
 * README, "Interactions & behaviour":
 *   "Every write goes through one path (`mut()` in the prototype). It
 *    deep-diffs the record before and after, writes a field-level change entry,
 *    checks the authority mode of the domain being written, and refuses the
 *    write with a named reason if the domain is not owned. Reproduce this as a
 *    single server-side write path, not as per-endpoint checks."
 *
 * `mut` is deliberately PURE. It takes the record before and after and returns
 * the value to keep plus the entries to append; it does not touch the store, so
 * it is the same function on a server and in a test. The store applies the
 * result. Nothing else in the application may write a domain record.
 *
 * The change log and the audit trail are append-only. There is no update and no
 * delete anywhere in this file, and a restore is a *new* entry (see `restore`).
 */

import { AuthorityMode, Domain, DOMAINS, MODE_NOTE, canEdit } from './authority';

export interface ChangeEntry {
  id: string;
  tenantId: string;
  unitId?: string;
  /** Stable id of the record that changed. */
  record: string;
  /** Human label for the record, so the log reads without a join. */
  recordLabel: string;
  /** Dotted path of the field within the record. */
  field: string;
  before: unknown;
  after: unknown;
  actor: string;
  at: string;
  /** Set when this entry puts back a value a previous entry changed. */
  restoredFrom?: string;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  unitId?: string;
  actor: string;
  action: string;
  kind: 'write' | 'refused' | 'post' | 'reverse' | 'lock' | 'sign' | 'import' | 'export' | 'admin';
  detail: string;
  at: string;
}

export interface Refusal {
  domain: Domain;
  domainLabel: string;
  mode: AuthorityMode | 'role';
  /** Stated in the accounting, not in the UI — README, "Interactions". */
  reason: string;
}

export interface WriteRequest<T> {
  domain: Domain;
  tenantId: string;
  unitId?: string;
  record: string;
  recordLabel: string;
  before: T;
  after: T;
  actor: string;
  role: string;
  /** What the user was doing, for the audit trail. */
  action: string;
  /** The authority setting in force for this tenant. */
  authority: Record<Domain, AuthorityMode>;
  /** Fields this write is not allowed to touch, with the reason, by name. */
  guarded?: Record<string, string>;
}

export interface WriteResult<T> {
  ok: boolean;
  /** The value to keep. Equals `before` when the write was refused. */
  value: T;
  refusal?: Refusal;
  /** Fields refused by name — INVARIANTS §5. */
  refusedFields: { field: string; reason: string }[];
  changes: ChangeEntry[];
  audit: AuditEvent[];
}

let counter = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
const now = () => new Date().toISOString();

/**
 * Flatten a record to dotted leaf paths so the change log is field-level rather
 * than record-level. Arrays are compared as whole leaves when they hold
 * primitives, and per index when they hold objects.
 */
export function flatten(v: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (v === null || v === undefined || typeof v !== 'object') {
    out[prefix] = v;
    return out;
  }
  if (Array.isArray(v)) {
    if (!v.length) out[prefix] = '[]';
    v.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return out;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) out[prefix] = '{}';
  for (const [k, val] of entries) flatten(val, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/** Field-level diff between two versions of a record. */
export function diff(before: unknown, after: unknown): { field: string; before: unknown; after: unknown }[] {
  const a = flatten(before);
  const b = flatten(after);
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: { field: string; before: unknown; after: unknown }[] = [];
  for (const f of fields) {
    if (!same(a[f], b[f])) out.push({ field: f, before: a[f], after: b[f] });
  }
  return out.sort((x, y) => x.field.localeCompare(y.field));
}

const same = (x: unknown, y: unknown) =>
  x === y || (typeof x === 'number' && typeof y === 'number' && Number.isNaN(x) && Number.isNaN(y));

/**
 * The write path. Every mutation of a domain record goes through here.
 *
 * Order matters: role, then authority, then guarded fields, then the diff. A
 * refusal is logged before it is returned — INVARIANTS §3, "the refusal is
 * itself logged".
 */
export function mut<T>(req: WriteRequest<T>): WriteResult<T> {
  const at = now();
  const domainDef = DOMAINS.find((d) => d.id === req.domain)!;
  const mode = req.authority[req.domain];

  const refuse = (refusal: Refusal): WriteResult<T> => ({
    ok: false,
    value: req.before,
    refusal,
    refusedFields: [],
    changes: [],
    audit: [
      {
        id: nextId('a'),
        tenantId: req.tenantId,
        unitId: req.unitId,
        actor: req.actor,
        action: req.action,
        kind: 'refused',
        detail: refusal.reason,
        at,
      },
    ],
  });

  if (!canEdit(req.role)) {
    return refuse({
      domain: req.domain,
      domainLabel: domainDef.label,
      mode: 'role',
      reason: `The write was refused: this role cannot edit ${domainDef.label.toLowerCase()}. ${domainDef.covers}`,
    });
  }

  if (mode !== 'We own it') {
    return refuse({
      domain: req.domain,
      domainLabel: domainDef.label,
      mode,
      reason:
        `The write was refused: ${domainDef.label} is set to "${mode}" for this tenant. ` +
        MODE_NOTE[mode],
    });
  }

  // INVARIANTS §5 — a write that hits a guarded field is refused *by name*, and
  // the counts written and refused are both reported. The rest of the write
  // still lands; silently dropping it would be a completeness claim nobody made.
  const all = diff(req.before, req.after);
  const refusedFields: { field: string; reason: string }[] = [];
  const accepted: typeof all = [];
  for (const d of all) {
    const guard = req.guarded?.[d.field] ?? req.guarded?.[d.field.split('[')[0]];
    if (guard) refusedFields.push({ field: d.field, reason: guard });
    else accepted.push(d);
  }

  // Roll back the refused fields so the kept value never contains them.
  let value = req.after;
  if (refusedFields.length) {
    value = structuredClone(req.after);
    for (const r of refusedFields) setPath(value as object, r.field, getPath(req.before as object, r.field));
  }

  const changes: ChangeEntry[] = accepted.map((d) => ({
    id: nextId('c'),
    tenantId: req.tenantId,
    unitId: req.unitId,
    record: req.record,
    recordLabel: req.recordLabel,
    field: d.field,
    before: d.before,
    after: d.after,
    actor: req.actor,
    at,
  }));

  const audit: AuditEvent[] = [];
  if (changes.length) {
    audit.push({
      id: nextId('a'),
      tenantId: req.tenantId,
      unitId: req.unitId,
      actor: req.actor,
      action: req.action,
      kind: 'write',
      detail: `${req.recordLabel} — ${changes.length} field${changes.length === 1 ? '' : 's'} changed.`,
      at,
    });
  }
  if (refusedFields.length) {
    audit.push({
      id: nextId('a'),
      tenantId: req.tenantId,
      unitId: req.unitId,
      actor: req.actor,
      action: req.action,
      kind: 'refused',
      detail:
        `${req.recordLabel} — ${changes.length} written, ${refusedFields.length} refused: ` +
        refusedFields.map((r) => `${r.field} (${r.reason})`).join('; '),
      at,
    });
  }

  return { ok: true, value, refusedFields, changes, audit };
}

/**
 * INVARIANTS §2 — "A restore writes the old value back as a *new* logged change;
 * the original entry stays and is marked restored. History reads forward and is
 * never rewritten."
 *
 * So restoring is an ordinary write that carries `restoredFrom`. It is not an
 * undo, and it does not delete anything.
 */
export function restore<T>(
  req: Omit<WriteRequest<T>, 'action'>,
  entry: ChangeEntry,
): WriteResult<T> {
  const result = mut({ ...req, action: `Restore ${entry.field}` });
  if (result.ok) {
    result.changes = result.changes.map((c) => ({ ...c, restoredFrom: entry.id }));
    result.audit.push({
      id: nextId('a'),
      tenantId: req.tenantId,
      unitId: req.unitId,
      actor: req.actor,
      action: `Restore ${entry.field}`,
      kind: 'write',
      detail: `Restored ${entry.field} on ${entry.recordLabel} to the value it held before ${entry.at}. The original entry stands and is marked restored.`,
      at: now(),
    });
  }
  return result;
}

/** Record an action that is not a field edit — a post, a lock, an export. */
export function note(
  tenantId: string,
  unitId: string | undefined,
  actor: string,
  action: string,
  kind: AuditEvent['kind'],
  detail: string,
): AuditEvent {
  return { id: nextId('a'), tenantId, unitId, actor, action, kind, detail, at: now() };
}

/* ── dotted-path helpers, for rolling back a refused field ──────────────── */

function tokens(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of path.split('.')) {
    const m = /^([^[]*)((\[\d+\])*)$/.exec(part);
    if (!m) { out.push(part); continue; }
    if (m[1]) out.push(m[1]);
    for (const idx of m[2].match(/\d+/g) ?? []) out.push(Number(idx));
  }
  return out;
}

export function getPath(obj: object, path: string): unknown {
  let cur: unknown = obj;
  for (const t of tokens(path)) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[t];
  }
  return cur;
}

export function setPath(obj: object, path: string, value: unknown): void {
  const ts = tokens(path);
  let cur: Record<string | number, unknown> = obj as Record<string | number, unknown>;
  for (let i = 0; i < ts.length - 1; i++) {
    const t = ts[i];
    if (cur[t] === null || typeof cur[t] !== 'object') cur[t] = typeof ts[i + 1] === 'number' ? [] : {};
    cur = cur[t] as Record<string | number, unknown>;
  }
  cur[ts[ts.length - 1]] = value;
}
