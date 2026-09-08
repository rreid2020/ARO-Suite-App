/**
 * Cost-estimate build-up drafts and tenant templates.
 *
 * Direct cost is the product of every factor column on a line (qty × unit rate
 * × any extra numbers or percents), then summed. A one-line template fills
 * single-line mode; two or more lines fill multi-line mode.
 */

import { currency, parseNumber } from './format';
import type {
  CostEstimateTemplate,
  CostEstimateTemplateLine,
  EstimateColumn,
  EstimateColumnKind,
} from './types';

export type EstimateMode = 'single' | 'multi';

export const DESCRIPTION_COLUMN: EstimateColumn = {
  id: 'description', label: 'Description', kind: 'text', role: 'label',
};
export const QTY_COLUMN: EstimateColumn = {
  id: 'qty', label: 'Qty', kind: 'number', role: 'factor',
};
export const RATE_COLUMN: EstimateColumn = {
  id: 'rate', label: 'Unit rate', kind: 'currency', role: 'factor',
};
export const DEFAULT_ESTIMATE_COLUMNS: EstimateColumn[] = [
  DESCRIPTION_COLUMN, QTY_COLUMN, RATE_COLUMN,
];

const SYSTEM_IDS = new Set(DEFAULT_ESTIMATE_COLUMNS.map((c) => c.id));
const KINDS = new Set<EstimateColumnKind>(['text', 'number', 'percent', 'currency']);

export interface EstimateLineDraft {
  description: string;
  qty: string;
  rate: string;
  extra?: Record<string, string>;
}

export function isSystemEstimateColumn(id: string): boolean {
  return SYSTEM_IDS.has(id);
}

export function emptyEstimateLine(columns?: EstimateColumn[]): EstimateLineDraft {
  const extra: Record<string, string> = {};
  for (const c of columns ?? []) {
    if (!isSystemEstimateColumn(c.id)) extra[c.id] = '';
  }
  return { description: '', qty: '1', rate: '', extra: Object.keys(extra).length ? extra : undefined };
}

export function columnValue(l: EstimateLineDraft, id: string): string {
  if (id === 'description') return l.description;
  if (id === 'qty') return l.qty;
  if (id === 'rate') return l.rate;
  return l.extra?.[id] ?? '';
}

export function patchEstimateLine(
  l: EstimateLineDraft,
  id: string,
  value: string,
): EstimateLineDraft {
  if (id === 'description') return { ...l, description: value };
  if (id === 'qty') return { ...l, qty: value };
  if (id === 'rate') return { ...l, rate: value };
  return { ...l, extra: { ...l.extra, [id]: value } };
}

export function parseFactor(raw: string, kind: EstimateColumnKind): number {
  const n = parseNumber(String(raw ?? '').replace(/%/g, ''));
  if (!Number.isFinite(n)) return NaN;
  if (kind === 'percent') return n / 100;
  return n;
}

export function lineAmount(
  l: EstimateLineDraft,
  columns: EstimateColumn[] = DEFAULT_ESTIMATE_COLUMNS,
): number {
  const cols = columns.length ? columns : DEFAULT_ESTIMATE_COLUMNS;
  let product = 1;
  let factors = 0;
  for (const c of cols) {
    if (c.role !== 'factor') continue;
    const n = parseFactor(columnValue(l, c.id), c.kind);
    if (!Number.isFinite(n)) return NaN;
    product *= n;
    factors += 1;
  }
  return factors ? product : NaN;
}

export function estimateHasCost(
  lines: EstimateLineDraft[],
  columns: EstimateColumn[] = DEFAULT_ESTIMATE_COLUMNS,
): boolean {
  return lines.some((l) => {
    const a = lineAmount(l, columns);
    return Number.isFinite(a) && Math.abs(a) >= 0.005;
  });
}

/** Engine lines: qty from the qty column; unit rate is amount ÷ qty so extras fold in. */
export function estimatePayload(
  lines: EstimateLineDraft[],
  columns: EstimateColumn[] = DEFAULT_ESTIMATE_COLUMNS,
): { lines: { description: string; qty: number; rate: number }[] } {
  return {
    lines: lines.map((l) => {
      const amount = lineAmount(l, columns);
      const qty = parseFactor(l.qty, 'number');
      const rate = Number.isFinite(qty) && qty !== 0 ? amount / qty : amount;
      return { description: l.description, qty, rate };
    }),
  };
}

export function linesForMode(
  mode: EstimateMode,
  lines: EstimateLineDraft[],
  columns?: EstimateColumn[],
): EstimateLineDraft[] {
  if (mode === 'single') return [(lines[0] ?? emptyEstimateLine(columns))];
  return lines.length > 0 ? lines : [emptyEstimateLine(columns)];
}

export function amountFormula(columns: EstimateColumn[]): string {
  const factors = (columns.length ? columns : DEFAULT_ESTIMATE_COLUMNS)
    .filter((c) => c.role === 'factor');
  if (!factors.length) return 'Direct cost';
  return factors.map((c) => c.label).join(' × ');
}

function parseEstimateColumn(raw: unknown): EstimateColumn | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? '').trim();
  if (!id) return null;
  const kind = KINDS.has(r.kind as EstimateColumnKind) ? r.kind as EstimateColumnKind : 'number';
  const role: EstimateColumn['role'] = r.role === 'label' || kind === 'text' ? 'label' : 'factor';
  return {
    id,
    label: String(r.label ?? '').trim() || id,
    kind: role === 'label' ? 'text' : kind,
    role,
  };
}

export function normalizeEstimateColumns(raw: unknown): EstimateColumn[] {
  const parsed = Array.isArray(raw)
    ? raw.map(parseEstimateColumn).filter((c): c is EstimateColumn => c != null)
    : [];
  const byId = new Map(parsed.map((c) => [c.id, c]));
  const system = DEFAULT_ESTIMATE_COLUMNS.map((d) => ({
    ...d,
    label: byId.get(d.id)?.label?.trim() || d.label,
  }));
  const extras = parsed.filter((c) => !isSystemEstimateColumn(c.id));
  return [...system, ...extras];
}

export function emptyEstimateColumn(
  kind: Exclude<EstimateColumnKind, 'currency'>,
  label: string,
  now = Date.now(),
): EstimateColumn {
  const trimmed = label.trim();
  return {
    id: `col-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: trimmed || (kind === 'percent' ? 'Percent' : kind === 'text' ? 'Note' : 'Factor'),
    kind,
    role: kind === 'text' ? 'label' : 'factor',
  };
}

export function renameEstimateColumn(
  columns: EstimateColumn[],
  id: string,
  label: string,
): EstimateColumn[] {
  const trimmed = label.trim();
  return columns.map((c) => (c.id === id ? { ...c, label: trimmed || c.label } : c));
}

export function addEstimateColumn(
  columns: EstimateColumn[],
  column: EstimateColumn,
  lines: EstimateLineDraft[],
): { columns: EstimateColumn[]; lines: EstimateLineDraft[] } {
  if (columns.some((c) => c.id === column.id) || isSystemEstimateColumn(column.id)) {
    return { columns, lines };
  }
  return {
    columns: [...columns, column],
    lines: lines.map((l) => ({ ...l, extra: { ...l.extra, [column.id]: l.extra?.[column.id] ?? '' } })),
  };
}

export function removeEstimateColumn(
  columns: EstimateColumn[],
  id: string,
  lines: EstimateLineDraft[],
): { columns: EstimateColumn[]; lines: EstimateLineDraft[] } {
  if (isSystemEstimateColumn(id)) return { columns, lines };
  return {
    columns: columns.filter((c) => c.id !== id),
    lines: lines.map((l) => {
      if (!l.extra || !(id in l.extra)) return l;
      const extra = { ...l.extra };
      delete extra[id];
      return { ...l, extra: Object.keys(extra).length ? extra : undefined };
    }),
  };
}

function parseTemplateLine(raw: unknown): CostEstimateTemplateLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const qty = typeof r.qty === 'number' ? r.qty : parseNumber(r.qty as string);
  const rateRaw = r.rate;
  const rate = rateRaw == null || rateRaw === ''
    ? null
    : (typeof rateRaw === 'number' ? rateRaw : parseNumber(rateRaw as string));
  const extra: Record<string, string> = {};
  if (r.extra && typeof r.extra === 'object' && !Array.isArray(r.extra)) {
    for (const [k, v] of Object.entries(r.extra as Record<string, unknown>)) {
      if (!k || isSystemEstimateColumn(k)) continue;
      extra[k] = v == null ? '' : String(v);
    }
  }
  return {
    description: String(r.description ?? ''),
    qty: Number.isFinite(qty) && qty !== 0 ? qty : 1,
    rate: rate != null && Number.isFinite(rate) ? rate : null,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

export function parseCostEstimateTemplates(raw: unknown): CostEstimateTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: CostEstimateTemplate[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? '').trim();
    if (!id) continue;
    const parsed = Array.isArray(r.lines)
      ? r.lines.map(parseTemplateLine).filter((l): l is CostEstimateTemplateLine => l != null)
      : [];
    out.push({
      id,
      tenantId: String(r.tenantId ?? ''),
      name: String(r.name ?? '').trim() || 'Untitled template',
      columns: normalizeEstimateColumns(r.columns),
      lines: parsed.length ? parsed : [{ description: '', qty: 1, rate: null }],
    });
  }
  return out;
}

export function emptyCostEstimateTemplate(tenantId: string, now = Date.now()): CostEstimateTemplate {
  return {
    id: `cet-${now.toString(36)}`,
    tenantId,
    name: '',
    columns: DEFAULT_ESTIMATE_COLUMNS.map((c) => ({ ...c })),
    lines: [{ description: '', qty: 1, rate: null }],
  };
}

export function draftToTemplateLine(
  l: EstimateLineDraft,
  columns?: EstimateColumn[],
): CostEstimateTemplateLine {
  const qty = parseNumber(l.qty);
  const rate = parseNumber(l.rate);
  const extraIds = (columns ?? [])
    .map((c) => c.id)
    .filter((id) => !isSystemEstimateColumn(id));
  const keys = extraIds.length ? extraIds : Object.keys(l.extra ?? {});
  const extra: Record<string, string> = {};
  for (const id of keys) extra[id] = String(l.extra?.[id] ?? '').trim();
  return {
    description: l.description.trim(),
    qty: Number.isFinite(qty) && qty !== 0 ? qty : 1,
    rate: Number.isFinite(rate) ? rate : null,
    extra: Object.values(extra).some((v) => v !== '') || extraIds.length ? extra : undefined,
  };
}

export function templateLineToDraft(
  l: CostEstimateTemplateLine,
  currencyCode?: string,
  columns?: EstimateColumn[],
): EstimateLineDraft {
  const extra: Record<string, string> = { ...l.extra };
  for (const c of columns ?? []) {
    if (!isSystemEstimateColumn(c.id) && extra[c.id] == null) extra[c.id] = '';
  }
  return {
    description: l.description,
    qty: Number.isFinite(l.qty) ? String(l.qty) : '1',
    rate: l.rate != null && Number.isFinite(l.rate)
      ? (currencyCode ? currency(l.rate, currencyCode) : String(l.rate))
      : '',
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

export function applyCostEstimateTemplate(
  template: CostEstimateTemplate,
  currencyCode?: string,
): { mode: EstimateMode; lines: EstimateLineDraft[]; columns: EstimateColumn[] } {
  const columns = normalizeEstimateColumns(template.columns);
  const fallback: CostEstimateTemplateLine = { description: '', qty: 1, rate: null };
  const lines = (template.lines.length ? template.lines : [fallback])
    .map((l) => templateLineToDraft(l, currencyCode, columns));
  if (lines.length <= 1) {
    return { mode: 'single', lines: [lines[0] ?? emptyEstimateLine(columns)], columns };
  }
  return { mode: 'multi', lines, columns };
}
