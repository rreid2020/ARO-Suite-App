/**
 * Excel-style AutoFilter for spreadsheet tables: per-column sort, unique-value
 * checkboxes, search-in-list, and a simple condition (contains / equals /
 * greater / less / between).
 */

import { parseNumber } from '../core/format';

export type SheetKind = 'text' | 'number' | 'date';

export type SheetCondOp = 'any' | 'contains' | 'equals' | 'gt' | 'lt' | 'between';

export interface SheetCond {
  op: SheetCondOp;
  a: string;
  b: string;
}

export interface SheetFilter {
  /** `null` means every unique value is included. An array is an allow-list. */
  selected: string[] | null;
  cond: SheetCond;
}

export type SheetSort = { key: string; dir: 1 | -1 };

export const EMPTY_COND: SheetCond = { op: 'any', a: '', b: '' };

export function emptyFilter(): SheetFilter {
  return { selected: null, cond: { ...EMPTY_COND } };
}

export function valueKey(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : '';
  const s = String(raw);
  return s.trim() === '' ? '' : s;
}

export function valueLabel(key: string): string {
  return key === '' ? '(Blanks)' : key;
}

export function isFilterActive(f: SheetFilter | undefined): boolean {
  if (!f) return false;
  return f.selected !== null || f.cond.op !== 'any';
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const n = parseNumber(String(raw ?? ''));
  return Number.isFinite(n) ? n : null;
}

function compareRaw(a: unknown, b: unknown, kind: SheetKind): number {
  if (kind === 'number') {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (na === null && nb === null) return String(a ?? '').localeCompare(String(b ?? ''));
    if (na === null) return 1;
    if (nb === null) return -1;
    return na - nb;
  }
  if (kind === 'date') {
    const sa = valueKey(a);
    const sb = valueKey(b);
    if (!sa && !sb) return 0;
    if (!sa) return 1;
    if (!sb) return -1;
    return sa.localeCompare(sb);
  }
  return valueKey(a).localeCompare(valueKey(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function passesCond(raw: unknown, kind: SheetKind, cond: SheetCond): boolean {
  if (cond.op === 'any') return true;
  const key = valueKey(raw);
  const needle = cond.a.trim();
  switch (cond.op) {
    case 'contains':
      return key.toLowerCase().includes(needle.toLowerCase());
    case 'equals':
      return key.toLowerCase() === needle.toLowerCase();
    case 'gt':
    case 'lt': {
      if (kind === 'text') {
        const cmp = key.localeCompare(needle, undefined, { numeric: true, sensitivity: 'base' });
        return cond.op === 'gt' ? cmp > 0 : cmp < 0;
      }
      if (kind === 'date') {
        const cmp = key.localeCompare(needle);
        return cond.op === 'gt' ? cmp > 0 : cmp < 0;
      }
      const n = toNumber(raw);
      const m = toNumber(needle);
      if (n === null || m === null) return false;
      return cond.op === 'gt' ? n > m : n < m;
    }
    case 'between': {
      const lo = cond.a.trim();
      const hi = cond.b.trim();
      if (kind === 'number') {
        const n = toNumber(raw);
        const a = toNumber(lo);
        const b = toNumber(hi);
        if (n === null || a === null || b === null) return false;
        return n >= Math.min(a, b) && n <= Math.max(a, b);
      }
      return key >= lo && key <= hi;
    }
    default:
      return true;
  }
}

export interface SheetSpec<T> {
  key: string;
  kind?: SheetKind;
  value?: (row: T) => unknown;
}

function rowPasses<T>(row: T, col: SheetSpec<T>, filter: SheetFilter): boolean {
  if (!col.value) return true;
  const raw = col.value(row);
  if (filter.selected && !filter.selected.includes(valueKey(raw))) return false;
  return passesCond(raw, col.kind ?? 'text', filter.cond);
}

export function applySheet<T>(
  rows: T[],
  cols: SheetSpec<T>[],
  filters: Record<string, SheetFilter>,
  sort: SheetSort | null,
): T[] {
  const byKey = new Map(cols.map((c) => [c.key, c]));
  let out = rows;
  const active = Object.entries(filters).filter(([, f]) => isFilterActive(f));
  if (active.length) {
    out = rows.filter((row) => active.every(([key, f]) => {
      const col = byKey.get(key);
      return !col ? true : rowPasses(row, col, f);
    }));
  }
  if (!sort) return out === rows ? [...rows] : out;
  const col = byKey.get(sort.key);
  if (!col?.value) return out === rows ? [...rows] : out;
  const kind = col.kind ?? 'text';
  const dir = sort.dir;
  return [...out].sort((a, b) => compareRaw(col.value!(a), col.value!(b), kind) * dir);
}

/** Unique values for a column, after every *other* column's filter is applied. */
export function uniqueForColumn<T>(
  rows: T[],
  cols: SheetSpec<T>[],
  filters: Record<string, SheetFilter>,
  columnKey: string,
): { key: string; label: string; count: number }[] {
  const col = cols.find((c) => c.key === columnKey);
  if (!col?.value) return [];
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const others = Object.entries(filters).filter(([k, f]) => k !== columnKey && isFilterActive(f));
  const pool = others.length
    ? rows.filter((row) => others.every(([key, f]) => {
      const c = byKey.get(key);
      return !c ? true : rowPasses(row, c, f);
    }))
    : rows;
  const counts = new Map<string, number>();
  for (const row of pool) {
    const k = valueKey(col.value(row));
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const kind = col.kind ?? 'text';
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: valueLabel(key), count }))
    .sort((a, b) => {
      if (a.key === '' && b.key !== '') return 1;
      if (b.key === '' && a.key !== '') return -1;
      return compareRaw(a.key, b.key, kind);
    });
}

export function sortLabels(kind: SheetKind): { asc: string; desc: string } {
  if (kind === 'number') return { asc: 'Sort smallest to largest', desc: 'Sort largest to smallest' };
  if (kind === 'date') return { asc: 'Sort oldest to newest', desc: 'Sort newest to oldest' };
  return { asc: 'Sort A to Z', desc: 'Sort Z to A' };
}

export function condLabels(kind: SheetKind): { value: SheetCondOp; label: string }[] {
  const extra: { value: SheetCondOp; label: string }[] =
    kind === 'text'
      ? [
          { value: 'contains', label: 'Contains' },
          { value: 'equals', label: 'Equals' },
        ]
      : [
          { value: 'equals', label: 'Equals' },
          { value: 'gt', label: kind === 'date' ? 'After' : 'Greater than' },
          { value: 'lt', label: kind === 'date' ? 'Before' : 'Less than' },
          { value: 'between', label: 'Between' },
        ];
  if (kind !== 'text') extra.unshift({ value: 'contains', label: 'Contains' });
  return [{ value: 'any', label: 'No condition' }, ...extra];
}
