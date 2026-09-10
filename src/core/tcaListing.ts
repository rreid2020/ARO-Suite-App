/**
 * Master TCA listing — the other half of the opening register.
 *
 * Asset number is the TCA link to the obligation listing. An asset that has a
 * related obligation is in scope. Every other row is marked In scope, Out of
 * scope, or Undecided so the listing has no unmarked gaps.
 */

import { isValidDate } from '../engine/dates';
import { CENT } from '../engine/rollforward';
import { parseNumber } from './format';
import { parseUlYears, remainingUlYears } from './usefulLife';
import type { Obligation, OpeningSnapshot, TcaAsset, TcaAssetStatus, TcaScope, AppState, UnitData } from './types';

export interface ParsedTcaRow {
  line: number;
  assetNumber: string;
  description: string;
  assetClass: string;
  acquisitionDate: string;
  site: string;
  acquisitionCost: number | null;
  accumAmort: number | null;
  totalUl: number | null;
  expiredUl: number | null;
  assetStatus: TcaAssetStatus | null;
  scope: TcaScope | null;
  scopeReason: string;
  columns: Record<string, string>;
}

export interface TcaParseResult {
  rows: ParsedTcaRow[];
  problems: string[];
  extraNames: string[];
  hasScopeColumn: boolean;
  hasStatusColumn: boolean;
  hasCostColumn: boolean;
  hasAccumColumn: boolean;
  hasTotalUlColumn: boolean;
  hasExpiredUlColumn: boolean;
}

export interface TcaLoadResult {
  added: number;
  updated: number;
  dropped: number;
  problems: string[];
}

export interface TcaScopingGaps {
  noListing: boolean;
  noObligations: boolean;
  undecided: TcaAsset[];
  orphanObligations: Obligation[];
  linkedNotInScope: TcaAsset[];
}

const EXTRA_COL_PREFIX = 'col:';

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

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `sha256:${(h >>> 0).toString(16).padStart(8, '0')}…`;
}

export function assetNumberKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function parseTcaScope(raw: string): TcaScope | null {
  const n = norm(raw);
  if (!n) return null;
  if (/^(in scope|scoped in|in)$/.test(n)) return 'In scope';
  if (/^(scoped out|out of scope|out)$/.test(n)) return 'Scoped out';
  if (/^(undecided|review|not decided|unmarked)$/.test(n)) return 'Undecided';
  return null;
}

export const TCA_ASSET_STATUSES: TcaAssetStatus[] = ['Active', 'Unproductive', 'Disposed'];

export function parseTcaAssetStatus(raw: string): TcaAssetStatus | null {
  const n = norm(raw);
  if (!n) return null;
  if (/^(active|productive|in use|in productive use|productive use|yes)$/.test(n)) return 'Active';
  if (/^(unproductive|not in use|not in productive use|idle)$/.test(n)) return 'Unproductive';
  if (/^(disposed|disposed of|retired|sold)$/.test(n)) return 'Disposed';
  return null;
}

export function tcaAssetStatusOf(a: Pick<TcaAsset, 'assetStatus'>): TcaAssetStatus {
  if (a.assetStatus === 'Unproductive' || a.assetStatus === 'Disposed') return a.assetStatus;
  return 'Active';
}

export function cloneTcaAssets(assets: TcaAsset[]): TcaAsset[] {
  return assets.map((a) => ({ ...a, columns: { ...(a.columns ?? {}) } }));
}

export function captureOpeningSnapshot(data: Pick<UnitData, 'tcaAssets' | 'obligations'>, now: string): OpeningSnapshot {
  return {
    tcaAssets: cloneTcaAssets(data.tcaAssets ?? []),
    obligationIds: (data.obligations ?? []).map((o) => o.id),
    lockedAt: now,
  };
}

export function parseOpeningSnapshot(raw: unknown): OpeningSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (!Array.isArray(v.tcaAssets) || !Array.isArray(v.obligationIds)) return null;
  const tcaAssets: TcaAsset[] = v.tcaAssets.map((row) => {
    const a = (row && typeof row === 'object') ? row as Partial<TcaAsset> : {};
    const fromPayload = tcaFieldsFromPayload(
      a.columns && typeof a.columns === 'object' ? { ...a.columns as Record<string, string> } : {},
    );
    return {
      id: String(a.id ?? ''),
      assetNumber: String(a.assetNumber ?? ''),
      description: String(a.description ?? ''),
      assetClass: String(a.assetClass ?? ''),
      acquisitionDate: String(a.acquisitionDate ?? ''),
      site: String(a.site ?? ''),
      acquisitionCost: typeof a.acquisitionCost === 'number' ? a.acquisitionCost : fromPayload.acquisitionCost,
      accumAmort: typeof a.accumAmort === 'number' ? a.accumAmort : fromPayload.accumAmort,
      totalUl: typeof a.totalUl === 'number' ? a.totalUl : fromPayload.totalUl,
      expiredUl: typeof a.expiredUl === 'number' ? a.expiredUl : fromPayload.expiredUl,
      assetStatus: a.assetStatus ? tcaAssetStatusOf({ assetStatus: a.assetStatus }) : fromPayload.assetStatus,
      scope: a.scope === 'In scope' || a.scope === 'Scoped out' ? a.scope : 'Undecided',
      scopeReason: String(a.scopeReason ?? ''),
      columns: fromPayload.columns,
    };
  });
  return {
    tcaAssets,
    obligationIds: v.obligationIds.map((id) => String(id)),
    lockedAt: typeof v.lockedAt === 'string' ? v.lockedAt : '',
    tcaFileKeys: Array.isArray(v.tcaFileKeys) ? v.tcaFileKeys.map((k) => String(k)) : undefined,
  };
}

export function ensureOpeningSnapshot(data: UnitData, now = ''): void {
  if (data.openingSnapshot) return;
  if (!data.conversionAgreed) return;
  data.openingSnapshot = captureOpeningSnapshot(data, now);
}

export function lockOpeningBalances(data: UnitData, now = new Date().toISOString()): void {
  if (!data.openingSnapshot) data.openingSnapshot = captureOpeningSnapshot(data, now);
  data.conversionAgreed = true;
  syncAroProductiveUse(data);
}

export function openingTcaListing(data: { tcaAssets?: TcaAsset[]; openingSnapshot?: OpeningSnapshot | null } | null | undefined): TcaAsset[] {
  if (data?.openingSnapshot) return data.openingSnapshot.tcaAssets ?? [];
  return data?.tcaAssets ?? [];
}

export function openingObligations(data: { obligations?: Obligation[]; openingSnapshot?: OpeningSnapshot | null } | null | undefined): Obligation[] {
  const ids = data?.openingSnapshot?.obligationIds;
  if (!ids) return data?.obligations ?? [];
  const set = new Set(ids);
  return (data?.obligations ?? []).filter((o) => set.has(o.id));
}

export function conversionListingsFrozen(data: Pick<UnitData, 'openingSnapshot' | 'conversionAgreed'> | null | undefined): boolean {
  return !!data?.openingSnapshot || !!data?.conversionAgreed;
}

/**
 * TCA Unproductive → ARO asset not in productive use (later estimate changes
 * go to operating expense). TCA Active → restore productive use. Disposed is
 * handled by retiring the obligation, not by this flag.
 */
export function syncAroProductiveUse(data: Pick<UnitData, 'tcaAssets' | 'obligations'>): number {
  let n = 0;
  for (const asset of data.tcaAssets ?? []) {
    const status = tcaAssetStatusOf(asset);
    if (status === 'Disposed') continue;
    const productive = status !== 'Unproductive';
    for (const o of obligationsForAsset(data.obligations ?? [], asset.assetNumber)) {
      const now = o.inProductiveUse !== false;
      if (now === productive) continue;
      o.inProductiveUse = productive;
      n++;
    }
  }
  return n;
}

function classifyHeader(cells: string[]): { map: Record<string, number>; extras: { i: number; name: string }[] } {
  const map: Record<string, number> = {};
  cells.forEach((raw, i) => {
    const n = norm(raw);
    if (map.assetNumber == null && /^(tca asset number|tca asset no|tca asset num|tca asset id|ppe asset number|ppe asset|asset|asset id|asset no|asset number|asset num|anlnr|anln1|equipment|floc)$/.test(n)) map.assetNumber = i;
    else if (map.description == null && /^(description|desc|name|asset description|tca description|ppe description)$/.test(n)) map.description = i;
    else if (map.assetClass == null && /^(tca asset class|ppe asset class|asset class|class|anlkl|asset type)$/.test(n)) map.assetClass = i;
    else if (map.acquisitionDate == null && /^(acquisition date|acquired on|date acquired|in service date|placed in service|capitalized on)$/.test(n)) map.acquisitionDate = i;
    else if (map.acquisitionCost == null && /^(acquisition cost|acquired cost|capitalized cost|gross book value|gross|cost|tca cost|ppe cost)$/.test(n)) map.acquisitionCost = i;
    else if (map.accumAmort == null && /accumulat/.test(n) && /(amorti[sz]ation|depreciation)/.test(n)) map.accumAmort = i;
    else if (map.nbv == null && /^(net book value|nbv|net carrying amount)$/.test(n)) map.nbv = i;
    else if (map.expiredUl == null && /^(expired ul|expired useful life|elapsed ul|used ul|expired life|elapsed life)$/.test(n)) map.expiredUl = i;
    else if (map.totalUl == null && /^(total ul|total useful life|useful life|asset life|total life|ul)$/.test(n)) map.totalUl = i;
    else if (map.remainingUl == null && /^(remaining ul|remaining useful life|remaining life)$/.test(n)) map.remainingUl = i;
    else if (map.site == null && /^(site|location)$/.test(n)) map.site = i;
    else if (map.assetStatus == null && /^(asset status|tca asset status|tca status|ppe status|status)$/.test(n)) map.assetStatus = i;
    else if (map.scope == null && /^(scope|scoping|in scope|aro scope)$/.test(n)) map.scope = i;
    else if (map.scopeReason == null && /^(scope reason|reason|reason if out)$/.test(n)) map.scopeReason = i;
  });
  const used = new Set(Object.values(map));
  const extras: { i: number; name: string }[] = [];
  cells.forEach((raw, i) => {
    if (used.has(i)) return;
    extras.push({ i, name: raw.trim() || `Column ${i + 1}` });
  });
  return { map, extras };
}

function looksLikeHeader(cells: string[]): boolean {
  const hit = classifyHeader(cells).map;
  return hit.assetNumber != null || hit.description != null;
}

export function tcaColumnNames(assets: TcaAsset[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const a of assets) {
    for (const k of Object.keys(a.columns ?? {})) {
      if (seen.has(k)) continue;
      seen.add(k);
      ordered.push(k);
    }
  }
  return ordered;
}

export function extraTcaColumnKey(name: string): string {
  return `${EXTRA_COL_PREFIX}${name}`;
}

export const TCA_TEMPLATE_COLUMNS: { header: string; field: keyof ParsedTcaRow | 'nbv' | 'remainingUl' }[] = [
  { header: 'TCA asset number', field: 'assetNumber' },
  { header: 'Description', field: 'description' },
  { header: 'TCA asset class', field: 'assetClass' },
  { header: 'Acquisition date', field: 'acquisitionDate' },
  { header: 'Acquisition cost', field: 'acquisitionCost' },
  { header: 'Accumulated amortization', field: 'accumAmort' },
  { header: 'Net book value', field: 'nbv' },
  { header: 'Total UL', field: 'totalUl' },
  { header: 'Expired UL', field: 'expiredUl' },
  { header: 'Remaining UL', field: 'remainingUl' },
  { header: 'Site', field: 'site' },
  { header: 'Asset status', field: 'assetStatus' },
  { header: 'Scope', field: 'scope' },
  { header: 'Reason if out', field: 'scopeReason' },
];

export function tcaTemplateHeaders(extraNames: string[] = []): string[] {
  const seen = new Set(TCA_TEMPLATE_COLUMNS.map((c) => c.header.trim().toLowerCase()));
  const extras = extraNames.filter((n) => {
    const t = n.trim();
    if (!t) return false;
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...TCA_TEMPLATE_COLUMNS.map((c) => c.header), ...extras];
}

export function tcaTemplateDataRows(assets: TcaAsset[], extraNames: string[] = []): (string | number)[][] {
  const extras = tcaTemplateHeaders(extraNames).slice(TCA_TEMPLATE_COLUMNS.length);
  return assets.map((a) => {
    const mapped = TCA_TEMPLATE_COLUMNS.map((c) => {
      if (c.field === 'scope') return a.scope;
      if (c.field === 'scopeReason') return a.scopeReason;
      if (c.field === 'assetNumber') return a.assetNumber;
      if (c.field === 'description') return a.description;
      if (c.field === 'assetClass') return a.assetClass;
      if (c.field === 'acquisitionDate') return a.acquisitionDate;
      if (c.field === 'acquisitionCost') return typeof a.acquisitionCost === 'number' ? a.acquisitionCost : '';
      if (c.field === 'accumAmort') return typeof a.accumAmort === 'number' ? a.accumAmort : '';
      if (c.field === 'nbv') return tcaNbv(a);
      if (c.field === 'totalUl') return typeof a.totalUl === 'number' ? a.totalUl : '';
      if (c.field === 'expiredUl') return typeof a.expiredUl === 'number' ? a.expiredUl : '';
      if (c.field === 'remainingUl') return remainingUlYears(a.totalUl, a.expiredUl) ?? '';
      if (c.field === 'site') return a.site;
      if (c.field === 'assetStatus') return tcaAssetStatusOf(a);
      return '';
    });
    return [...mapped, ...extras.map((name) => a.columns[name] ?? '')];
  });
}

export function tcaTemplateNotes(): string[][] {
  return [
    ['Master TCA listing template'],
    ['Use the Master TCA listing sheet for the organisation\'s tangible-capital-asset population. Do not load this Notes sheet.'],
    [],
    ['How to load'],
    ['Save the Master TCA listing sheet as CSV (UTF-8), then Choose file. Or copy the sheet (including the header row) and paste it on Opening register (conversion) or ARO scoping (go-forward).'],
    ['An .xlsx workbook is not loaded as-is — save that sheet as CSV, or paste it.'],
    [],
    ['What the listing is'],
    ['The opening register is this listing plus the obligation and ARO asset listing, frozen at conversion. After lock, load an updated listing on ARO scoping; that does not change the opening register.'],
    ['Every obligation must name a TCA asset number that appears here. Those assets are in scope.'],
    ['Mark every other asset In scope, Out of scope, or Undecided so there are no unmarked rows.'],
    [],
    ['What each row needs'],
    ['Nothing is loaded until every error is fixed. Partial files are refused.'],
    ['TCA asset number is required and must be unique on the listing. Alias: Asset number.'],
    ['Description, TCA asset class, acquisition date, acquisition cost, accumulated amortization, Total UL, Expired UL, site and asset status are optional. Extra columns are optional.'],
    ['Net book value is acquisition cost minus accumulated amortization. Leave it blank on load — the listing calculates it.'],
    ['Total UL and Expired UL, when present, default the ARO asset useful life when a new obligation is created for that TCA. Enter years, or years and leftover months (17 yr · 9 mo). Remaining UL is Total UL minus Expired UL — leave it blank on load; the listing calculates it. You can change UL on the ARO asset; do not edit UL on this listing except to correct Expired UL that does not match acquisition through conversion.'],
    ['Asset status is Active, Unproductive or Disposed. Blank loads as Active. Unproductive means the TCA is no longer in use; flag the related ARO asset on the ARO Register so later changes of estimate go to operating expense. Disposed means the TCA has left the books.'],
    ['Scope and Reason if out can be filled here or marked in the app after load.'],
    ['Dates, if present, as YYYY-MM-DD (for example 2008-06-15).'],
    [],
    ['Example row (do not leave this on the sheet you load)'],
    ['AS-10001', 'Well 14-23 pad', 'Wells', '2008-06-15', '2100000', '800000', '1300000', '25', '10', '15', 'North', 'Active', 'Undecided', ''],
  ];
}

export function parseTcaListing(text: string): TcaParseResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const problems: string[] = [];
  const emptyFlags = {
    hasScopeColumn: false,
    hasStatusColumn: false,
    hasCostColumn: false,
    hasAccumColumn: false,
    hasTotalUlColumn: false,
    hasExpiredUlColumn: false,
  };
  if (!lines.length) {
    return {
      rows: [],
      problems: ['The file is empty. Export the master TCA template, fill the listing, save it as CSV, and load that file.'],
      extraNames: [],
      ...emptyFlags,
    };
  }

  const delim = detectDelim(lines[0]);
  const first = splitLine(lines[0], delim);
  const classified = classifyHeader(first);
  if (!looksLikeHeader(first) || classified.map.assetNumber == null) {
    return {
      rows: [],
      problems: ['The first row must be column headings, including TCA asset number. Export the template, keep those headings on the Master TCA listing sheet, save as CSV, and load that file.'],
      extraNames: [],
      ...emptyFlags,
    };
  }

  const map = classified.map;
  const extras = classified.extras;
  const extraNames = extras.map((e) => e.name);
  const hasScopeColumn = map.scope != null;
  const hasStatusColumn = map.assetStatus != null;
  const hasCostColumn = map.acquisitionCost != null;
  const hasAccumColumn = map.accumAmort != null;
  const hasTotalUlColumn = map.totalUl != null;
  const hasExpiredUlColumn = map.expiredUl != null;
  const flags = { hasScopeColumn, hasStatusColumn, hasCostColumn, hasAccumColumn, hasTotalUlColumn, hasExpiredUlColumn };

  if (lines.length < 2) {
    return {
      rows: [],
      problems: ['The file has headings but no asset rows. Add one row per tangible capital asset under the heading row, then load the file again.'],
      extraNames,
      ...flags,
    };
  }

  const rows: ParsedTcaRow[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const line = i + 1;
    const cell = (k: string) => (map[k] != null ? (cells[map[k]] ?? '').trim() : '');
    const before = problems.length;
    const assetNumber = cell('assetNumber');
    const who = assetNumber ? `Line ${line} (${assetNumber})` : `Line ${line}`;

    if (!assetNumber) {
      problems.push(`${who}: TCA asset number is missing. Every row needs a unique TCA asset number that obligations can link to.`);
    } else {
      const key = assetNumberKey(assetNumber);
      if (seen.has(key)) {
        problems.push(`${who}: TCA asset number ${assetNumber} is already used on an earlier row. Each TCA asset number must be unique.`);
      } else {
        seen.add(key);
      }
    }

    const acquisitionDate = cell('acquisitionDate');
    if (acquisitionDate && !isValidDate(acquisitionDate)) {
      problems.push(`${who}: Acquisition date "${acquisitionDate}" is not a date. Use YYYY-MM-DD, for example 2008-06-15.`);
    }

    const acquisitionCostRaw = cell('acquisitionCost');
    let acquisitionCost: number | null = null;
    if (acquisitionCostRaw) {
      const n = parseNumber(acquisitionCostRaw);
      if (!Number.isFinite(n)) {
        problems.push(`${who}: Acquisition cost "${acquisitionCostRaw}" is not a number.`);
      } else {
        acquisitionCost = n;
      }
    }

    const accumAmortRaw = cell('accumAmort');
    let accumAmort: number | null = null;
    if (accumAmortRaw) {
      const n = parseNumber(accumAmortRaw);
      if (!Number.isFinite(n)) {
        problems.push(`${who}: Accumulated amortization "${accumAmortRaw}" is not a number.`);
      } else {
        accumAmort = n;
      }
    }

    const totalUlRaw = cell('totalUl');
    let totalUl: number | null = null;
    if (totalUlRaw) {
      const n = parseUlYears(totalUlRaw);
      if (!Number.isFinite(n) || n < 0) {
        problems.push(`${who}: Total UL "${totalUlRaw}" is not a non-negative number of years (years and leftover months are allowed, for example 17 yr · 9 mo).`);
      } else {
        totalUl = n;
      }
    }

    const expiredUlRaw = cell('expiredUl');
    let expiredUl: number | null = null;
    if (expiredUlRaw) {
      const n = parseUlYears(expiredUlRaw);
      if (!Number.isFinite(n) || n < 0) {
        problems.push(`${who}: Expired UL "${expiredUlRaw}" is not a non-negative number of years (years and leftover months are allowed, for example 17 yr · 9 mo).`);
      } else {
        expiredUl = n;
      }
    }
    if (totalUl != null && expiredUl != null && expiredUl > totalUl) {
      problems.push(`${who}: Expired UL ${expiredUl} is greater than Total UL ${totalUl}. Expired UL cannot exceed Total UL.`);
    }

    let scope: TcaScope | null = null;
    const scopeRaw = cell('scope');
    if (hasScopeColumn && scopeRaw) {
      scope = parseTcaScope(scopeRaw);
      if (!scope) {
        problems.push(`${who}: Scope "${scopeRaw}" is not In scope, Out of scope, or Undecided.`);
      }
    }

    let assetStatus: TcaAssetStatus | null = null;
    const statusRaw = cell('assetStatus');
    if (hasStatusColumn && statusRaw) {
      assetStatus = parseTcaAssetStatus(statusRaw);
      if (!assetStatus) {
        problems.push(`${who}: Asset status "${statusRaw}" is not Active, Unproductive or Disposed.`);
      }
    }

    if (problems.length > before) continue;

    const columns: Record<string, string> = {};
    for (const extra of extras) {
      columns[extra.name] = (cells[extra.i] ?? '').trim();
    }

    rows.push({
      line,
      assetNumber,
      description: cell('description') || assetNumber,
      assetClass: cell('assetClass'),
      acquisitionDate: isValidDate(acquisitionDate) ? acquisitionDate : '',
      site: cell('site'),
      acquisitionCost,
      accumAmort,
      totalUl,
      expiredUl,
      assetStatus,
      scope,
      scopeReason: cell('scopeReason'),
      columns,
    });
  }

  if (problems.length) return { rows: [], problems, extraNames, ...flags };
  return { rows, problems, extraNames, ...flags };
}

export function obligationsForAsset(obligations: Obligation[], assetNumber: string): Obligation[] {
  const key = assetNumberKey(assetNumber);
  if (!key) return [];
  return obligations.filter((o) => assetNumberKey(String(o.assetId ?? '')) === key);
}

/** The master-listing row this obligation names, if any. */
export function tcaForObligation(assets: TcaAsset[] | undefined, obligation: { assetId?: unknown }): TcaAsset | undefined {
  const key = assetNumberKey(String(obligation.assetId ?? ''));
  if (!key) return undefined;
  return (assets ?? []).find((a) => assetNumberKey(a.assetNumber) === key);
}

/** In-service date on the master TCA listing for this asset number. */
export function tcaAcquisitionDateOf(assets: TcaAsset[] | undefined, assetId: unknown): string {
  const tca = tcaForObligation(assets, { assetId });
  return tca && isValidDate(tca.acquisitionDate) ? tca.acquisitionDate : '';
}

/**
 * ARO asset acquisition date: the linked TCA's listing date when present,
 * otherwise the date stored on the obligation (conversion load).
 */
export function aroAssetAcquisitionDate(
  obligation: { assetId?: unknown; assetAcquisitionDate?: unknown },
  assets?: TcaAsset[],
): string {
  const fromListing = tcaAcquisitionDateOf(assets, obligation.assetId);
  if (fromListing) return fromListing;
  const stored = String(obligation.assetAcquisitionDate ?? '');
  return isValidDate(stored) ? stored : stored;
}

/** Obligation id → linked TCA row, for a listing join. */
export function tcaByObligationId(assets: TcaAsset[] | undefined, obligations: Obligation[]): Map<string, TcaAsset> {
  const index = new Map((assets ?? []).map((a) => [assetNumberKey(a.assetNumber), a]));
  const out = new Map<string, TcaAsset>();
  for (const o of obligations) {
    const tca = index.get(assetNumberKey(String(o.assetId ?? '')));
    if (tca) out.set(o.id, tca);
  }
  return out;
}

export function syncTcaScopeFromObligations(assets: TcaAsset[], obligations: Obligation[]): TcaAsset[] {
  const linked = new Set<string>();
  for (const o of obligations) {
    const key = assetNumberKey(String(o.assetId ?? ''));
    if (key) linked.add(key);
  }
  return assets.map((a) => {
    if (!linked.has(assetNumberKey(a.assetNumber))) return a;
    if (a.scope === 'In scope' && !a.scopeReason) return a;
    return { ...a, scope: 'In scope', scopeReason: '' };
  });
}

export function applyLinkedObligationScope(obligations: Obligation[], assets: TcaAsset[]): void {
  const onListing = new Set(assets.map((a) => assetNumberKey(a.assetNumber)).filter(Boolean));
  for (const o of obligations) {
    const key = assetNumberKey(String(o.assetId ?? ''));
    if (key && onListing.has(key)) {
      o.status = 'In scope';
      o.scopeReason = '';
    }
  }
}

export function tcaScopingGaps(assets: TcaAsset[], obligations: Obligation[]): TcaScopingGaps {
  const byAsset = new Map(assets.map((a) => [assetNumberKey(a.assetNumber), a]));
  const orphanObligations = obligations.filter((o) => {
    const key = assetNumberKey(String(o.assetId ?? ''));
    return !key || !byAsset.has(key);
  });
  const linkedKeys = new Set(
    obligations.map((o) => assetNumberKey(String(o.assetId ?? ''))).filter(Boolean),
  );
  return {
    noListing: assets.length === 0,
    noObligations: obligations.length === 0,
    undecided: assets.filter((a) => a.scope === 'Undecided' || !a.scope),
    orphanObligations,
    linkedNotInScope: assets.filter((a) => linkedKeys.has(assetNumberKey(a.assetNumber)) && a.scope !== 'In scope'),
  };
}

export function tcaScopingComplete(gaps: TcaScopingGaps): boolean {
  return !gaps.noListing && !gaps.noObligations && gaps.orphanObligations.length === 0 && gaps.linkedNotInScope.length === 0;
}

export function setTcaScope(
  asset: TcaAsset,
  scope: TcaScope,
  reason: string,
  obligations: Obligation[],
): TcaAsset | string {
  const linked = obligationsForAsset(obligations, asset.assetNumber);
  if (linked.length && scope !== 'In scope') {
    return `${asset.assetNumber} has ${linked.length} related obligation${linked.length === 1 ? '' : 's'} on the ARO register, so it is in scope.`;
  }
  if (scope === 'Scoped out' && !reason.trim()) {
    return `Record why ${asset.assetNumber} is out of scope.`;
  }
  return {
    ...asset,
    scope,
    scopeReason: scope === 'Scoped out' ? reason.trim() : '',
  };
}

export function setTcaAssetStatus(asset: TcaAsset, status: TcaAssetStatus): TcaAsset {
  return { ...asset, assetStatus: status };
}

function mergeParsedTcaRows(
  data: UnitData,
  unitId: string,
  parsed: TcaParseResult,
): { added: number; updated: number; dropped: number } {
  data.tcaAssets ??= [];
  const priorKeys = new Set(data.tcaAssets.map((a) => assetNumberKey(a.assetNumber)));
  const fileKeys = new Set(parsed.rows.map((r) => assetNumberKey(r.assetNumber)));
  const dropped = [...priorKeys].filter((k) => k && !fileKeys.has(k)).length;
  const byNumber = new Map(data.tcaAssets.map((a) => [assetNumberKey(a.assetNumber), a]));
  let added = 0;
  let updated = 0;
  const n = data.tcaAssets.length;

  for (const row of parsed.rows) {
    const existing = byNumber.get(assetNumberKey(row.assetNumber));
    const id = existing?.id ?? `tca-${unitId}-${n + added}`;
    const scope: TcaScope = parsed.hasScopeColumn
      ? (row.scope ?? existing?.scope ?? 'Undecided')
      : (existing?.scope ?? 'Undecided');
    const next: TcaAsset = {
      id,
      assetNumber: row.assetNumber,
      description: row.description || existing?.description || row.assetNumber,
      assetClass: row.assetClass || existing?.assetClass || '',
      acquisitionDate: row.acquisitionDate || existing?.acquisitionDate || '',
      site: row.site || existing?.site || '',
      acquisitionCost: parsed.hasCostColumn ? row.acquisitionCost : (existing?.acquisitionCost ?? null),
      accumAmort: parsed.hasAccumColumn ? row.accumAmort : (existing?.accumAmort ?? null),
      totalUl: parsed.hasTotalUlColumn ? row.totalUl : (existing?.totalUl ?? null),
      expiredUl: parsed.hasExpiredUlColumn ? row.expiredUl : (existing?.expiredUl ?? null),
      assetStatus: parsed.hasStatusColumn
        ? (row.assetStatus ?? tcaAssetStatusOf({ assetStatus: existing?.assetStatus ?? 'Active' }))
        : tcaAssetStatusOf({ assetStatus: existing?.assetStatus ?? 'Active' }),
      scope,
      scopeReason: parsed.hasScopeColumn
        ? (scope === 'Scoped out' ? (row.scopeReason || existing?.scopeReason || '') : '')
        : (existing?.scopeReason ?? ''),
      columns: { ...(existing?.columns ?? {}), ...row.columns },
    };
    if (existing) {
      const i = data.tcaAssets.findIndex((a) => a.id === existing.id);
      data.tcaAssets[i] = next;
      byNumber.set(assetNumberKey(next.assetNumber), next);
      updated++;
    } else {
      data.tcaAssets.push(next);
      byNumber.set(assetNumberKey(next.assetNumber), next);
      added++;
    }
  }

  data.tcaAssets = syncTcaScopeFromObligations(data.tcaAssets, data.obligations);
  applyLinkedObligationScope(data.obligations, data.tcaAssets);
  return { added, updated, dropped };
}

function recordTcaExtract(
  data: UnitData,
  unitId: string,
  periodId: string,
  parsed: TcaParseResult,
  source: { filename: string; text: string },
  kind: string,
  now: string,
) {
  data.extracts.push({
    id: `x-${unitId}-tca-${Date.now().toString(36)}`,
    unitId,
    kind,
    filename: source.filename,
    hash: hashText(source.text),
    rows: parsed.rows.length,
    receivedAt: now,
    declared: 'cumulative',
    targetPeriodId: periodId,
    acceptedAt: now,
    template: 'Master TCA listing — column mapped',
    templateValidated: false,
  });
}

/**
 * Write the conversion master TCA listing onto the unit. Existing rows with
 * the same asset number are updated; other assets are left alone. Linked
 * assets are then forced in scope. After opening lock this is refused — load
 * an updated listing on ARO scoping instead.
 */
export function loadTcaListing(
  s: AppState,
  tenantId: string,
  unitId: string,
  parsed: TcaParseResult,
  source: { filename: string; text: string },
  now = new Date().toISOString(),
): TcaLoadResult | string {
  const data = s.data[unitId];
  const unit = (s.units[tenantId] ?? []).find((u) => u.id === unitId);
  if (!data || !unit) return 'That reporting unit is not on this tenant.';
  if (data.openingSnapshot) {
    return 'The conversion master TCA listing is frozen. Load an updated listing on ARO scoping.';
  }
  if (data.conversionAgreed) {
    return 'Opening balances are locked. Unlock them on Opening register before loading another master TCA listing.';
  }
  if (parsed.problems.length) return parsed.problems[0];
  if (!parsed.rows.length) return 'The file has no asset rows. Fix the errors and load the file again.';

  const period = data.periods[0];
  if (!period) return `${unit.entity} needs a fiscal calendar before the master TCA listing can load.`;

  const merged = mergeParsedTcaRows(data, unitId, parsed);
  recordTcaExtract(data, unitId, period.id, parsed, source, 'Master TCA listing', now);
  return { ...merged, problems: parsed.problems };
}

/**
 * Load an updated master TCA listing after conversion is locked. Writes the
 * current listing only; the frozen opening snapshot is not changed.
 */
export function loadCurrentTcaListing(
  s: AppState,
  tenantId: string,
  unitId: string,
  parsed: TcaParseResult,
  source: { filename: string; text: string },
  now = new Date().toISOString(),
): TcaLoadResult | string {
  const data = s.data[unitId];
  const unit = (s.units[tenantId] ?? []).find((u) => u.id === unitId);
  if (!data || !unit) return 'That reporting unit is not on this tenant.';
  ensureOpeningSnapshot(data, now);
  if (!data.openingSnapshot) {
    return 'Lock opening balances before loading an updated master TCA listing. Conversion population is loaded on Opening register.';
  }
  if (parsed.problems.length) return parsed.problems[0];
  if (!parsed.rows.length) return 'The file has no asset rows. Fix the errors and load the file again.';

  const period = data.periods[0];
  if (!period) return `${unit.entity} needs a fiscal calendar before the master TCA listing can load.`;

  const merged = mergeParsedTcaRows(data, unitId, parsed);
  data.openingSnapshot = {
    ...data.openingSnapshot,
    tcaFileKeys: parsed.rows.map((r) => assetNumberKey(r.assetNumber)),
  };
  syncAroProductiveUse(data);
  recordTcaExtract(data, unitId, period.id, parsed, source, 'Current master TCA listing', now);
  return { ...merged, problems: parsed.problems };
}

/** Reserved JSON payload keys so extras stay organisation headings only. */
export const TCA_COST_PAYLOAD_KEY = '_acquisitionCost';
export const TCA_ACCUM_PAYLOAD_KEY = '_accumAmort';
export const TCA_STATUS_PAYLOAD_KEY = '_assetStatus';
export const TCA_TOTAL_UL_PAYLOAD_KEY = '_totalUl';
export const TCA_EXPIRED_UL_PAYLOAD_KEY = '_expiredUl';

function takePayloadNumber(columns: Record<string, string>, key: string): number | null {
  if (!(key in columns)) return null;
  const n = parseNumber(columns[key]);
  delete columns[key];
  return Number.isFinite(n) ? n : null;
}

function takePayloadStatus(columns: Record<string, string>): TcaAssetStatus {
  if (!(TCA_STATUS_PAYLOAD_KEY in columns)) return 'Active';
  const raw = columns[TCA_STATUS_PAYLOAD_KEY];
  delete columns[TCA_STATUS_PAYLOAD_KEY];
  return parseTcaAssetStatus(raw) ?? 'Active';
}

export function tcaFieldsFromPayload(payload: Record<string, string>): {
  acquisitionCost: number | null;
  accumAmort: number | null;
  assetStatus: TcaAssetStatus;
  totalUl: number | null;
  expiredUl: number | null;
  columns: Record<string, string>;
} {
  const columns = { ...payload };
  return {
    acquisitionCost: takePayloadNumber(columns, TCA_COST_PAYLOAD_KEY),
    accumAmort: takePayloadNumber(columns, TCA_ACCUM_PAYLOAD_KEY),
    assetStatus: takePayloadStatus(columns),
    totalUl: takePayloadNumber(columns, TCA_TOTAL_UL_PAYLOAD_KEY),
    expiredUl: takePayloadNumber(columns, TCA_EXPIRED_UL_PAYLOAD_KEY),
    columns,
  };
}

export function tcaPayloadOf(a: TcaAsset): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...(a.columns ?? {}) };
  delete payload[TCA_COST_PAYLOAD_KEY];
  delete payload[TCA_ACCUM_PAYLOAD_KEY];
  delete payload[TCA_STATUS_PAYLOAD_KEY];
  delete payload[TCA_TOTAL_UL_PAYLOAD_KEY];
  delete payload[TCA_EXPIRED_UL_PAYLOAD_KEY];
  if (typeof a.acquisitionCost === 'number') payload[TCA_COST_PAYLOAD_KEY] = a.acquisitionCost;
  if (typeof a.accumAmort === 'number') payload[TCA_ACCUM_PAYLOAD_KEY] = a.accumAmort;
  payload[TCA_STATUS_PAYLOAD_KEY] = tcaAssetStatusOf(a);
  if (typeof a.totalUl === 'number') payload[TCA_TOTAL_UL_PAYLOAD_KEY] = a.totalUl;
  if (typeof a.expiredUl === 'number') payload[TCA_EXPIRED_UL_PAYLOAD_KEY] = a.expiredUl;
  return payload;
}

export function tcaNbv(a: Pick<TcaAsset, 'acquisitionCost' | 'accumAmort'>): number {
  return (typeof a.acquisitionCost === 'number' ? a.acquisitionCost : 0)
    - (typeof a.accumAmort === 'number' ? a.accumAmort : 0);
}

export function tcaAcquisitionCostTotal(assets: TcaAsset[]): number {
  return assets.reduce((s, a) => s + (typeof a.acquisitionCost === 'number' ? a.acquisitionCost : 0), 0);
}

export function tcaAccumAmortTotal(assets: TcaAsset[]): number {
  return assets.reduce((s, a) => s + (typeof a.accumAmort === 'number' ? a.accumAmort : 0), 0);
}

export function tcaNbvTotal(assets: TcaAsset[]): number {
  return assets.reduce((s, a) => s + tcaNbv(a), 0);
}

export function tcaReconciled(
  data: { tcaAssets: TcaAsset[]; openingGlTcaCost: number | null; openingGlTcaAccum: number | null },
): { ok: boolean; detail: string } {
  if (!data.tcaAssets.length) {
    return { ok: false, detail: 'Load the master TCA listing before reconciling.' };
  }
  if (data.openingGlTcaCost == null || data.openingGlTcaAccum == null) {
    return { ok: false, detail: 'Record both opening GL totals for TCA acquisition cost and accumulated amortization, then agree the listing to them.' };
  }
  const costDiff = tcaAcquisitionCostTotal(data.tcaAssets) - data.openingGlTcaCost;
  const accumDiff = tcaAccumAmortTotal(data.tcaAssets) - data.openingGlTcaAccum;
  const nbvDiff = tcaNbvTotal(data.tcaAssets) - (data.openingGlTcaCost - data.openingGlTcaAccum);
  if (Math.abs(costDiff) > CENT || Math.abs(accumDiff) > CENT || Math.abs(nbvDiff) > CENT) {
    return {
      ok: false,
      detail: 'The master TCA listing does not agree to the opening GL cost and accumulated amortization. Clear the differences before locking.',
    };
  }
  return { ok: true, detail: 'The master TCA listing agrees to the opening GL cost, accumulated amortization and net book value.' };
}
