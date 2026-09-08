/**
 * Import the organisation's chart of accounts.
 *
 * Journals this product produces are posted into the organisation's own
 * financial management system, so the chart here must be theirs — codes,
 * names and classes — not a hard-coded engine chart. Engine roles are then
 * assigned onto those GLs. Extra columns (company, cost centre, …) become
 * coding segments with permitted values taken from the file.
 */

import { ENGINE_ROLES } from '../seed';
import type { Account, AppState, CodingSegment } from './types';
import { classFromColumns, isAccountTypeHeader, isLooseClassHeader, parseAccountClass } from './accountType';
import { syncDefaultScenarioFromRoles, unmapAccountFromScenarios } from './posting';

export interface ParsedAccountRow {
  code: string;
  name: string;
  cls: string;
  engineRole: string;
  segments: Record<string, string>;
  line: number;
}

export interface ChartParseResult {
  rows: ParsedAccountRow[];
  problems: string[];
  segmentNames: string[];
}

export interface ChartImportResult {
  added: number;
  updated: number;
  removed: number;
  segmentsUpdated: string[];
  problems: string[];
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function detectDelim(header: string): string {
  if (header.includes('\t')) return '\t';
  const semi = (header.match(/;/g) ?? []).length;
  const comma = (header.match(/,/g) ?? []).length;
  return semi > comma ? ';' : ',';
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function looksLikeHeader(cells: string[]): boolean {
  return cells.some((c) => {
    const n = norm(c);
    return /^(code|account|acct|gl|name|description|title|class|type|category)$/.test(n)
      || /account (code|number|no|name|type|class)/.test(n)
      || /gl (account|code)/.test(n)
      || isAccountTypeHeader(c);
  });
}

function classifyHeader(cells: string[]): { code: number; name: number; cls: number; role: number; extras: { i: number; name: string }[] } {
  let code = -1;
  let name = -1;
  let role = -1;
  cells.forEach((raw, i) => {
    const n = norm(raw);
    if (code < 0 && /^(code|account code|account no|account number|acct|gl|gl account|gl code)$/.test(n)) { code = i; return; }
    if (name < 0 && /^(name|account name|description|title)$/.test(n)) { name = i; return; }
    if (role < 0 && /^(engine role|role|aro role|mapping)$/.test(n)) { role = i; return; }
  });
  let cls = cells.findIndex((c, i) => i !== code && i !== name && i !== role && isLooseClassHeader(c));
  const extras: { i: number; name: string }[] = [];
  cells.forEach((raw, i) => {
    if (i === code || i === name || i === cls || i === role) return;
    extras.push({ i, name: raw.trim() || `Segment ${extras.length + 1}` });
  });
  if (code < 0) code = 0;
  if (name < 0) name = cells.length > 1 ? 1 : 0;
  return { code, name, cls, role, extras };
}

function parseRole(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  const hit = ENGINE_ROLES.find((r) => r.toLowerCase() === t.toLowerCase());
  return hit ?? '';
}

export function parseChartText(text: string): ChartParseResult {
  const problems: string[] = [];
  const cleaned = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
  const lines = cleaned.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return { rows: [], problems: ['The file has no rows.'], segmentNames: [] };

  const delim = detectDelim(lines[0]);
  const first = splitLine(lines[0], delim);
  const headed = looksLikeHeader(first);
  const cols = headed ? classifyHeader(first) : {
    code: 0,
    name: first.length > 1 ? 1 : 0,
    cls: first.length > 2 ? 2 : -1,
    role: -1,
    extras: first.length > 3
      ? first.slice(3).map((_, i) => ({ i: i + 3, name: `Segment ${i + 1}` }))
      : [],
  };

  const body = headed ? lines.slice(1) : lines;
  const seen = new Set<string>();
  const rows: ParsedAccountRow[] = [];

  body.forEach((line, idx) => {
    const lineNo = (headed ? idx + 2 : idx + 1);
    const cells = splitLine(line, delim);
    const code = (cells[cols.code] ?? '').trim();
    const name = (cells[cols.name] ?? '').trim();
    if (!code) { problems.push(`Line ${lineNo}: no account code. Not taken.`); return; }
    if (!name) { problems.push(`Line ${lineNo}: ${code} has no name. Not taken.`); return; }
    if (seen.has(code)) { problems.push(`Line ${lineNo}: ${code} is duplicated in the file. First row kept.`); return; }
    seen.add(code);

    const rawClass = cols.cls >= 0 ? (cells[cols.cls] ?? '') : '';
    const cls = parseAccountClass(rawClass) ?? '';
    if (rawClass.trim() && !cls) {
      problems.push(`Line ${lineNo}: "${rawClass.trim()}" is not an account class for ${code}. Class left blank to set on the row.`);
    }
    const engineRole = cols.role >= 0 ? parseRole(cells[cols.role] ?? '') : '';
    if (cols.role >= 0 && (cells[cols.role] ?? '').trim() && !engineRole) {
      problems.push(`Line ${lineNo}: "${(cells[cols.role] ?? '').trim()}" is not an engine role for ${code}. Role not taken.`);
    }

    const segments: Record<string, string> = {};
    for (const extra of cols.extras) {
      const v = (cells[extra.i] ?? '').trim();
      if (v) segments[extra.name] = v;
    }
    rows.push({ code, name, cls, engineRole, segments, line: lineNo });
  });

  const segmentNames = cols.extras.map((e) => e.name);
  if (!rows.length && !problems.length) problems.push('No account rows could be read.');
  return { rows, problems, segmentNames };
}

/** Extra chart headings to show, in coding-block order when names match. */
export function chartColumnNames(accounts: Account[], segments: CodingSegment[] = []): string[] {
  const present = new Set<string>();
  for (const a of accounts) {
    for (const k of Object.keys(a.columns ?? {})) if (k) present.add(k);
  }
  if (!present.size) {
    return [...segments].sort((a, b) => a.ord - b.ord).map((s) => s.name);
  }
  const ordered: string[] = [];
  for (const seg of [...segments].sort((a, b) => a.ord - b.ord)) {
    if (!present.has(seg.name)) continue;
    ordered.push(seg.name);
    present.delete(seg.name);
  }
  ordered.push(...[...present].sort());
  return ordered;
}

function columnsFromRow(row: ParsedAccountRow, names: string[]): Record<string, string> {
  const columns: Record<string, string> = {};
  for (const name of names) columns[name] = row.segments[name] ?? '';
  return columns;
}

export function accountIdsInUse(s: AppState, tenantId: string): Set<string> {
  const ids = new Set<string>();
  for (const u of s.units[tenantId] ?? []) {
    for (const b of s.data[u.id]?.batches ?? []) {
      for (const l of b.lines) if (l.accountId) ids.add(l.accountId);
    }
  }
  return ids;
}

export function accountInUse(s: AppState, tenantId: string, accountId: string): boolean {
  return accountIdsInUse(s, tenantId).has(accountId);
}

/**
 * Remove a GL that no journal posts to. Mapped posting-scenario roles are
 * cleared so pickers do not point at a missing account.
 */
export function deleteAccount(s: AppState, tenantId: string, accountId: string): { ok: true } | { ok: false; reason: string } {
  const settings = s.settings[tenantId];
  const acc = settings.accounts.find((a) => a.id === accountId);
  if (!acc) return { ok: false, reason: 'That account is not on this chart.' };
  if (accountInUse(s, tenantId, accountId)) {
    return { ok: false, reason: `${acc.code} ${acc.name} is on a journal and cannot be deleted.` };
  }
  unmapAccountFromScenarios(settings, accountId);
  settings.accounts = settings.accounts.filter((a) => a.id !== accountId);
  syncDefaultScenarioFromRoles(settings, tenantId);
  return { ok: true };
}

/** Remove every GL that no journal posts to. Accounts on a journal are kept. */
export function deleteUnusedAccounts(s: AppState, tenantId: string): { removed: number; kept: number } {
  const settings = s.settings[tenantId];
  const used = accountIdsInUse(s, tenantId);
  const drop = settings.accounts.filter((a) => !used.has(a.id));
  for (const acc of drop) unmapAccountFromScenarios(settings, acc.id);
  settings.accounts = settings.accounts.filter((a) => used.has(a.id));
  syncDefaultScenarioFromRoles(settings, tenantId);
  return { removed: drop.length, kept: settings.accounts.length };
}

function mergeSegments(
  existing: CodingSegment[],
  tenantId: string,
  rows: ParsedAccountRow[],
  names: string[],
): { next: CodingSegment[]; updated: string[] } {
  if (!names.length) return { next: existing, updated: [] };
  const usable = names.filter((name) => {
    const values = new Set(rows.map((r) => r.segments[name]).filter(Boolean));
    if (values.size === 0) return false;
    // A column unique on every row is a label, not a coding dimension.
    if (values.size > Math.max(30, Math.floor(rows.length * 0.4))) return false;
    return true;
  });
  const next = [...existing];
  const updated: string[] = [];
  let ord = Math.max(0, ...next.map((s) => s.ord));
  for (const name of usable) {
    const values = [...new Set(rows.map((r) => r.segments[name]).filter(Boolean))].sort();
    const found = next.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (found) {
      const union = [...new Set([...found.permitted, ...values])];
      if (union.length !== found.permitted.length) {
        found.permitted = union.sort();
        updated.push(found.name);
      }
    } else {
      ord += 1;
      next.push({
        id: `seg-${Date.now().toString(36)}-${ord}`,
        tenantId,
        ord,
        name,
        required: true,
        permitted: values,
      });
      updated.push(name);
    }
  }
  return { next, updated };
}

/**
 * Merge a parsed chart into the tenant. Existing engine-role assignments are
 * kept on matching codes. Accounts not in the file are dropped unless a
 * journal line still points at them.
 */
export function importChartOfAccounts(
  s: AppState,
  tenantId: string,
  parsed: ChartParseResult,
): ChartImportResult {
  const settings = s.settings[tenantId];
  const problems = [...parsed.problems];
  if (!parsed.rows.length) {
    return { added: 0, updated: 0, removed: 0, segmentsUpdated: [], problems };
  }

  const used = accountIdsInUse(s, tenantId);
  const incoming = new Map(parsed.rows.map((r) => [r.code, r]));
  const byCode = new Map(settings.accounts.map((a) => [a.code, a]));
  const requiredNames = settings.segments.filter((seg) => seg.required).map((seg) => seg.name);

  let added = 0;
  let updated = 0;
  const kept: Account[] = [];
  const takenRoles = new Map<string, string>();

  for (const row of parsed.rows) {
    const prev = byCode.get(row.code);
    const columns = columnsFromRow(row, parsed.segmentNames);
    const cls = classFromColumns(columns) || row.cls || prev?.cls || 'Asset';
    if (!row.cls && !classFromColumns(columns) && !prev) {
      problems.push(`${row.code}: no class in the file; set to Asset. Change it on the row if that is wrong.`);
    }
    let role = row.engineRole || prev?.engineRole || '';
    if (role) {
      const holder = takenRoles.get(role);
      if (holder && holder !== row.code) {
        problems.push(`Engine role "${role}" was on ${holder}; ${row.code} takes it.`);
      }
      takenRoles.set(role, row.code);
    }
    if (prev) {
      prev.name = row.name;
      prev.cls = cls;
      prev.engineRole = role;
      prev.columns = columns;
      kept.push(prev);
      updated += 1;
    } else {
      kept.push({
        id: `acc-${Date.now().toString(36)}-${added}`,
        tenantId,
        code: row.code,
        name: row.name,
        cls,
        engineRole: role,
        requiredSegments: [...requiredNames],
        columns,
      });
      added += 1;
    }
  }

  // A role may still sit on an account we are about to drop; clear it from
  // accounts that are not the incoming holder.
  for (const acc of kept) {
    if (acc.engineRole && takenRoles.get(acc.engineRole) !== acc.code) acc.engineRole = '';
  }

  let removed = 0;
  for (const acc of settings.accounts) {
    if (incoming.has(acc.code)) continue;
    if (used.has(acc.id)) {
      if (acc.engineRole && takenRoles.get(acc.engineRole) === acc.code) {
        /* kept below */
      } else if (acc.engineRole && takenRoles.has(acc.engineRole)) {
        acc.engineRole = '';
      }
      kept.push(acc);
      problems.push(`${acc.code} ${acc.name} is on a journal and was kept even though it is not in the file.`);
      continue;
    }
    unmapAccountFromScenarios(settings, acc.id);
    removed += 1;
  }

  settings.accounts = kept;
  const segs = mergeSegments(settings.segments, tenantId, parsed.rows, parsed.segmentNames);
  settings.segments = segs.next;
  syncDefaultScenarioFromRoles(settings, tenantId);
  return { added, updated, removed, segmentsUpdated: segs.updated, problems };
}
