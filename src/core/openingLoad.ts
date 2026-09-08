/**
 * One-time opening register load.
 *
 * A reporting entity converts from a spreadsheet: each row is an obligation,
 * not a match candidate against a register that already exists. The file
 * carries opening provision and ARO-asset balances. The trial balance is
 * totals only — recon is the sum of those rows against the GL totals.
 *
 * Engine fields are mapped by heading alias. Every other column is kept on
 * the obligation under the organisation's own heading (JSON payload) and
 * shown on the register — the engine does not read those keys.
 *
 * New obligations after this load are created in the app, not by a second extract.
 */

import { isValidDate } from '../engine/dates';
import { CENT, type ObligationEvent } from '../engine/rollforward';
import { canonicalizeObligationClasses, classCodeOf, classNameOf } from './assetClass';
import { parseNumber } from './format';
import { applyLinkedObligationScope, assetNumberKey, openingObligations, openingTcaListing, syncTcaScopeFromObligations, tcaReconciled, tcaScopingGaps } from './tcaListing';
import type { AppState, AroAssetClass, Obligation, TcaAsset, UnitData } from './types';

export interface ParsedOpeningRow {
  line: number;
  ref: string;
  description: string;
  assetId: string;
  aroAssetNumber: string;
  assetDescription: string;
  assetAcquisitionDate: string;
  site: string;
  region: string;
  type: string;
  aroAssetClass: string;
  basis: string;
  costEstimateDate: string;
  settlementDate: string;
  estimatedCost: number | null;
  openingProvision: number | null;
  openingArc: number | null;
  openingAccumAmort: number | null;
  openingFv: number | null;
  totalUl: number | null;
  expiredUl: number | null;
  /** Extra file columns, keyed by the organisation's own headings. */
  columns: Record<string, string>;
}

export interface OpeningParseResult {
  rows: ParsedOpeningRow[];
  problems: string[];
  extraNames: string[];
}

const EXTRA_COL_PREFIX = 'col:';

export interface OpeningLoadResult {
  added: number;
  updated: number;
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

function parseMoney(raw: string): number | null {
  const n = parseNumber(raw);
  return Number.isFinite(n) ? n : null;
}

/** Columns every opening-balances file must have. Aliases still match on load. */
const REQUIRED_OPENING_COLUMNS: { key: string; heading: string; aliases: string; fix: string }[] = [
  {
    key: 'ref', heading: 'Obligation Number', aliases: 'Reference, Ref, Obligation reference, ARO ref',
    fix: 'Put that heading on the first row. Export the template for the accepted headings.',
  },
  {
    key: 'openingProvision', heading: 'Opening provision', aliases: 'Provision, PV, Opening balance',
    fix: 'Add that heading and fill each row with the converted liability as a number (0 is allowed).',
  },
  {
    key: 'openingArc', heading: 'ARO asset', aliases: 'NBV, ARC, Retirement cost asset',
    fix: 'Add that heading and fill each row with the converted retirement-cost-asset net book value as a number (0 is allowed).',
  },
  {
    key: 'openingAccumAmort', heading: 'Accumulated amortization', aliases: 'Accumulated depreciation, Accum amort',
    fix: 'Add that heading and fill each row with the contra to the retirement cost asset as a number (0 is allowed).',
  },
  {
    key: 'totalUl', heading: 'Total UL', aliases: 'Total useful life, Useful life, UL',
    fix: 'Add that heading and fill each row with total useful life in years (0 or more).',
  },
  {
    key: 'expiredUl', heading: 'Expired UL', aliases: 'Expired useful life, Elapsed UL',
    fix: 'Add that heading and fill each row with useful life already consumed, in years (0 is allowed).',
  },
  {
    key: 'assetId', heading: 'TCA asset number', aliases: 'Asset number, Asset, Asset id, TCA asset, PPE asset number, ANLN1',
    fix: 'Add that heading and fill each row with the related TCA asset number from the master listing.',
  },
];

function readNumber(
  raw: string,
  problems: string[],
  who: string,
  label: string,
  opts: { required?: boolean; nonNegative?: boolean; unit?: string } = {},
): number | null {
  const t = raw.trim();
  if (!t) {
    if (opts.required) {
      problems.push(`${who}: ${label} is missing. Enter ${opts.unit ?? 'a number'} (0 is allowed).`);
    }
    return null;
  }
  const n = parseMoney(t);
  if (n == null) {
    problems.push(`${who}: ${label} "${t}" is not a number. Enter a number${opts.unit ? ` in ${opts.unit}` : ''} — currency symbols and commas are allowed.`);
    return null;
  }
  if (opts.nonNegative && n < 0) {
    problems.push(`${who}: ${label} cannot be negative. Enter ${opts.unit ?? 'a number'} of 0 or more.`);
    return null;
  }
  return n;
}

function classifyHeader(cells: string[]): { map: Record<string, number>; extras: { i: number; name: string }[] } {
  const map: Record<string, number> = {};
  cells.forEach((raw, i) => {
    const n = norm(raw);
    if (map.ref == null && /^(ref|reference|obligation|obligation ref|obligation reference|obligation number|obligation no|obligation num|aro ref|aro no|aro number)$/.test(n)) map.ref = i;
    else if (map.assetDescription == null && /^(aro asset description|asset description|ppe description|related asset description)$/.test(n)) map.assetDescription = i;
    else if (map.aroAssetNumber == null && /^(aro asset number|aro asset no|aro asset num|aro asset id|retirement cost asset number|retirement cost asset no|anln2)$/.test(n)) map.aroAssetNumber = i;
    else if (map.assetAcquisitionDate == null && /^(asset acquisition date|acquisition date|acquired on|date acquired|in service date|placed in service)$/.test(n)) map.assetAcquisitionDate = i;
    else if (map.description == null && /^(description|desc|name|obligation description)$/.test(n)) map.description = i;
    else if (map.assetId == null && /^(tca asset number|tca asset no|tca asset num|tca asset id|tca asset|ppe asset number|ppe asset|related asset number|asset|asset id|asset no|asset number)$/.test(n)) map.assetId = i;
    else if (map.site == null && /^(site|location)$/.test(n)) map.site = i;
    else if (map.region == null && /^(region|area|jurisdiction)$/.test(n)) map.region = i;
    else if (map.type == null && /^(type|obligation type|aro type)$/.test(n)) map.type = i;
    else if (map.aroAssetClassCode == null && /^(aro asset class code|asset class code|class code|anlkl)$/.test(n)) map.aroAssetClassCode = i;
    else if (map.aroAssetClassName == null && /^(aro asset class name|asset class name|class name)$/.test(n)) map.aroAssetClassName = i;
    else if (map.aroAssetClass == null && /^(aro asset class|asset class|class)$/.test(n)) map.aroAssetClass = i;
    else if (map.basis == null && /^(basis|legal constructive)$/.test(n)) map.basis = i;
    else if (map.costEstimateDate == null && /^(cost estimate date|cost date|price date|estimate date)$/.test(n)) map.costEstimateDate = i;
    else if (map.settlementDate == null && /^(settlement date|expected settlement|retirement date|planned retirement|settlement)$/.test(n)) map.settlementDate = i;
    else if (map.estimatedCost == null && /^(estimated cost|direct cost|cost|current cost)$/.test(n)) map.estimatedCost = i;
    else if (map.openingProvision == null && /^(opening provision|provision|provision balance|opening balance|liability|pv|source pv)$/.test(n)) map.openingProvision = i;
    else if (map.openingAccumAmort == null && /accumulat/.test(n) && /(amorti[sz]ation|depreciation)/.test(n)) map.openingAccumAmort = i;
    else if (map.openingFv == null && /^(opening future value|opening fv|future value|fv at settlement|undiscounted|fv)$/.test(n)) map.openingFv = i;
    else if (map.expiredUl == null && /^(expired ul|expired useful life|elapsed ul|used ul|expired life|elapsed life)$/.test(n)) map.expiredUl = i;
    else if (map.totalUl == null && /^(total ul|total useful life|useful life|asset life|total life|ul)$/.test(n)) map.totalUl = i;
    else if (map.remainingUl == null && /^(remaining ul|remaining useful life|remaining life)$/.test(n)) map.remainingUl = i;
    else if (map.openingAroCost == null && /^(aro acquisition cost|aro asset cost|aro asset acquisition cost|retirement cost acquisition cost)$/.test(n)) map.openingAroCost = i;
    else if (map.openingArc == null && /^(opening aro asset|aro asset|retirement cost asset|arc|nbv|asset balance|opening asset|aro asset nbv)$/.test(n)) map.openingArc = i;
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
  return hit.ref != null || hit.openingProvision != null || hit.description != null;
}

export function extraColumnKey(name: string): string {
  return `${EXTRA_COL_PREFIX}${name}`;
}

export function extraColumnName(key: string): string | null {
  return key.startsWith(EXTRA_COL_PREFIX) ? key.slice(EXTRA_COL_PREFIX.length) : null;
}

export function obligationColumns(o: Obligation): Record<string, string> {
  const raw = o.columns;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k) continue;
    out[k] = v == null ? '' : String(v);
  }
  return out;
}

export function obligationColumnNames(obligations: Obligation[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const o of obligations) {
    for (const k of Object.keys(obligationColumns(o))) {
      if (seen.has(k)) continue;
      seen.add(k);
      ordered.push(k);
    }
  }
  return ordered;
}

export function obligationField(o: Obligation, key: string): string {
  const extra = extraColumnName(key);
  if (extra != null) return obligationColumns(o)[extra] ?? '';
  if (key === 'inProductiveUse') return o.inProductiveUse === false ? 'No' : 'Yes';
  const v = o[key];
  return v == null ? '' : String(v);
}

export function patchObligationField(o: Obligation, key: string, value: unknown): Obligation {
  const extra = extraColumnName(key);
  if (extra != null) {
    return { ...o, columns: { ...obligationColumns(o), [extra]: value == null ? '' : String(value) } };
  }
  if (key === 'inProductiveUse') {
    const normalized = String(value ?? '').trim().toLowerCase();
    return { ...o, inProductiveUse: normalized !== 'no' && normalized !== 'false' };
  }
  return { ...o, [key]: value };
}

export function parseOpeningRegister(text: string): OpeningParseResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const problems: string[] = [];
  if (!lines.length) {
    return {
      rows: [],
      problems: ['The file is empty. Export the template, fill the Obligation & ARO Asset Listing sheet, save it as CSV, and load that file.'],
      extraNames: [],
    };
  }

  const delim = detectDelim(lines[0]);
  const first = splitLine(lines[0], delim);
  const classified = classifyHeader(first);
  if (!looksLikeHeader(first) || classified.map.ref == null) {
    return {
      rows: [],
      problems: ['The first row must be column headings, including Obligation Number. Export the template, keep those headings on the Obligation & ARO Asset Listing sheet, save as CSV, and load that file.'],
      extraNames: [],
    };
  }

  const map = classified.map;
  const extras = classified.extras;
  const extraNames = extras.map((e) => e.name);

  for (const col of REQUIRED_OPENING_COLUMNS) {
    if (map[col.key] != null) continue;
    problems.push(`The file has no ${col.heading} column. ${col.fix} Aliases that also load: ${col.aliases}.`);
  }
  if (problems.length) return { rows: [], problems, extraNames };

  if (lines.length < 2) {
    return {
      rows: [],
      problems: ['The file has headings but no obligation rows. Add one row per obligation under the heading row, then load the file again.'],
      extraNames,
    };
  }

  const rows: ParsedOpeningRow[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const line = i + 1;
    const cell = (k: string) => (map[k] != null ? (cells[map[k]] ?? '').trim() : '');
    const before = problems.length;
    const ref = cell('ref');
    const who = ref ? `Line ${line} (${ref})` : `Line ${line}`;

    if (!ref) {
      problems.push(`${who}: Obligation Number is missing. Every row needs a unique Obligation Number.`);
    } else {
      const key = ref.toLowerCase();
      if (seen.has(key)) {
        problems.push(`${who}: Obligation Number ${ref} is already used on an earlier row. Each Obligation Number must be unique.`);
      } else {
        seen.add(key);
      }
    }

    const assetId = cell('assetId');
    if (!assetId) {
      problems.push(`${who}: TCA asset number is missing. Every obligation must name the related asset on the master TCA listing.`);
    }

    const costEstimateDate = cell('costEstimateDate');
    const settlementDate = cell('settlementDate');
    const assetAcquisitionDate = cell('assetAcquisitionDate');
    if (costEstimateDate && !isValidDate(costEstimateDate)) {
      problems.push(`${who}: Cost estimate date "${costEstimateDate}" is not a date. Use YYYY-MM-DD, for example 2026-12-31.`);
    }
    if (settlementDate && !isValidDate(settlementDate)) {
      problems.push(`${who}: Expected settlement "${settlementDate}" is not a date. Use YYYY-MM-DD, for example 2038-06-30.`);
    }
    if (assetAcquisitionDate && !isValidDate(assetAcquisitionDate)) {
      problems.push(`${who}: Asset acquisition date "${assetAcquisitionDate}" is not a date. Use YYYY-MM-DD, for example 2008-06-15.`);
    }

    const estimatedCost = readNumber(cell('estimatedCost'), problems, who, 'Estimated cost');
    const openingProvision = readNumber(cell('openingProvision'), problems, who, 'Opening provision', { required: true });
    const openingArc = readNumber(cell('openingArc'), problems, who, 'ARO asset', { required: true });
    const openingAccumAmort = readNumber(cell('openingAccumAmort'), problems, who, 'Accumulated amortization', { required: true });
    const openingFv = readNumber(cell('openingFv'), problems, who, 'Opening future value');
    const totalUl = readNumber(cell('totalUl'), problems, who, 'Total UL', { required: true, nonNegative: true, unit: 'years' });
    const expiredUl = readNumber(cell('expiredUl'), problems, who, 'Expired UL', { required: true, nonNegative: true, unit: 'years' });
    if (totalUl != null && expiredUl != null && expiredUl > totalUl) {
      problems.push(`${who}: Expired UL ${expiredUl} is greater than Total UL ${totalUl}. Expired UL cannot exceed Total UL.`);
    }

    const basisRaw = cell('basis');
    let basis = 'Legal';
    if (basisRaw) {
      if (/^constructive$/i.test(basisRaw)) basis = 'Constructive';
      else if (/^legal$/i.test(basisRaw)) basis = 'Legal';
      else {
        problems.push(`${who}: Basis "${basisRaw}" is not Legal or Constructive. Enter Legal or Constructive.`);
      }
    }

    if (problems.length > before) continue;

    const columns: Record<string, string> = {};
    for (const extra of extras) {
      columns[extra.name] = (cells[extra.i] ?? '').trim();
    }

    rows.push({
      line,
      ref,
      description: cell('description') || ref,
      assetId,
      aroAssetNumber: cell('aroAssetNumber'),
      assetDescription: cell('assetDescription'),
      assetAcquisitionDate: isValidDate(assetAcquisitionDate) ? assetAcquisitionDate : '',
      site: cell('site'),
      region: cell('region'),
      type: cell('type'),
      aroAssetClass: cell('aroAssetClassCode') || cell('aroAssetClass') || cell('aroAssetClassName'),
      basis,
      costEstimateDate: isValidDate(costEstimateDate) ? costEstimateDate : '',
      settlementDate: isValidDate(settlementDate) ? settlementDate : '',
      estimatedCost,
      openingProvision,
      openingArc,
      openingAccumAmort,
      openingFv,
      totalUl,
      expiredUl,
      columns,
    });
  }

  if (problems.length) return { rows: [], problems, extraNames };
  return { rows, problems, extraNames };
}

export function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `sha256:${(h >>> 0).toString(16).padStart(8, '0')}…`;
}

export function openingProvisionTotal(events: ObligationEvent[]): number {
  return events.filter((e) => e.type === 'opening').reduce((s, e) => s + e.amount, 0);
}

export function openingArcTotal(obligations: Obligation[]): number {
  return obligations.reduce((s, o) => s + (typeof o.openingArc === 'number' ? o.openingArc : 0), 0);
}

export function openingAccumAmortTotal(obligations: Obligation[]): number {
  return obligations.reduce((s, o) => s + (typeof o.openingAccumAmort === 'number' ? o.openingAccumAmort : 0), 0);
}

/** Gross ARO (retirement-cost) asset = converted NBV plus accumulated amortization. */
export function openingAroCostOf(o: Obligation): number {
  return (typeof o.openingArc === 'number' ? o.openingArc : 0)
    + (typeof o.openingAccumAmort === 'number' ? o.openingAccumAmort : 0);
}

export function openingAroCostTotal(obligations: Obligation[]): number {
  return obligations.reduce((s, o) => s + openingAroCostOf(o), 0);
}

export function remainingUl(o: Obligation): number | null {
  const total = typeof o.totalUl === 'number' ? o.totalUl : null;
  const expired = typeof o.expiredUl === 'number' ? o.expiredUl : null;
  if (total == null) return null;
  return total - (expired ?? 0);
}

/** Conversion fields that must not move once opening balances are locked. */
export const OPENING_BALANCE_FIELDS = [
  'openingArc', 'openingAccumAmort', 'openingFv', 'totalUl', 'expiredUl',
] as const;

export function isOpeningBalanceField(key: string): boolean {
  return (OPENING_BALANCE_FIELDS as readonly string[]).includes(key);
}

export function openingLocked(data: { conversionAgreed?: boolean } | null | undefined): boolean {
  return !!data?.conversionAgreed;
}

export function obligationReconciled(
  data: {
    obligations: Obligation[];
    events: ObligationEvent[];
    openingGlProvision: number | null;
    openingGlArc?: number | null;
    openingGlAroCost?: number | null;
    openingGlAroAccum?: number | null;
  },
): { ok: boolean; detail: string } {
  if (!data.obligations.length) {
    return { ok: false, detail: 'Load the opening extract before reconciling.' };
  }
  if (data.openingGlProvision == null || data.openingGlAroCost == null || data.openingGlAroAccum == null) {
    return { ok: false, detail: 'Record opening GL totals for the provision, ARO acquisition cost and accumulated amortization, then agree the listing to them.' };
  }
  const provDiff = openingProvisionTotal(data.events) - data.openingGlProvision;
  const costDiff = openingAroCostTotal(data.obligations) - data.openingGlAroCost;
  const accumDiff = openingAccumAmortTotal(data.obligations) - data.openingGlAroAccum;
  const nbvDiff = openingArcTotal(data.obligations) - (data.openingGlAroCost - data.openingGlAroAccum);
  if (Math.abs(provDiff) > CENT || Math.abs(costDiff) > CENT || Math.abs(accumDiff) > CENT || Math.abs(nbvDiff) > CENT) {
    return {
      ok: false,
      detail: 'The obligation and ARO asset listing does not agree to the opening GL provision, ARO acquisition cost and accumulated amortization. Clear the differences before locking.',
    };
  }
  return { ok: true, detail: 'The obligation and ARO asset listing agrees to the opening GL provision, ARO acquisition cost, accumulated amortization and net book value.' };
}

export function openingReconciled(
  data: {
    obligations: Obligation[];
    events: ObligationEvent[];
    openingGlProvision: number | null;
    openingGlArc?: number | null;
    openingGlAroCost?: number | null;
    openingGlAroAccum?: number | null;
    tcaAssets?: TcaAsset[];
    openingGlTcaCost?: number | null;
    openingGlTcaAccum?: number | null;
  },
): { ok: boolean; detail: string } {
  const obligations = obligationReconciled(data);
  if (!obligations.ok) return obligations;
  return tcaReconciled({
    tcaAssets: data.tcaAssets ?? [],
    openingGlTcaCost: data.openingGlTcaCost ?? null,
    openingGlTcaAccum: data.openingGlTcaAccum ?? null,
  });
}

export function lockOpeningBlocked(
  data: {
    obligations: Obligation[];
    events: ObligationEvent[];
    openingGlProvision: number | null;
    openingGlArc?: number | null;
    openingGlAroCost?: number | null;
    openingGlAroAccum?: number | null;
    conversionAgreed: boolean;
    tcaAssets?: TcaAsset[];
    openingSnapshot?: UnitData['openingSnapshot'];
    openingGlTcaCost?: number | null;
    openingGlTcaAccum?: number | null;
  },
): string {
  if (openingLocked(data)) return 'Opening balances are already locked.';
  const tca = openingTcaListing(data);
  const obls = openingObligations(data);
  const gaps = tcaScopingGaps(tca, obls);
  if (gaps.noObligations) return 'Load the opening obligations extract before locking.';
  if (gaps.noListing) {
    return 'Load the master TCA listing before locking. Every obligation names a TCA asset number on that listing; those assets are in scope.';
  }
  if (gaps.orphanObligations.length) {
    const sample = gaps.orphanObligations.slice(0, 4).map((o) => `${o.ref} (${String(o.assetId ?? '').trim() || 'no TCA asset number'})`);
    const more = gaps.orphanObligations.length > 4 ? `, and ${gaps.orphanObligations.length - 4} more` : '';
    return `${gaps.orphanObligations.length} obligation${gaps.orphanObligations.length === 1 ? '' : 's'} name a TCA asset number that is not on the master TCA listing: ${sample.join(', ')}${more}. Add those assets to the listing, then lock.`;
  }
  if (gaps.linkedNotInScope.length) {
    return `${gaps.linkedNotInScope.length} asset${gaps.linkedNotInScope.length === 1 ? '' : 's'} on the master listing ${gaps.linkedNotInScope.length === 1 ? 'has' : 'have'} a related obligation and must be in scope.`;
  }
  const recon = openingReconciled({
    ...data,
    tcaAssets: tca,
    obligations: obls,
  });
  return recon.ok ? '' : recon.detail;
}

/**
 * Canonical headings for the opening-register Excel template. Each maps to an
 * engine field (aliases on load still work). Extra organisation columns are
 * appended after these.
 */
export const OPENING_TEMPLATE_COLUMNS: { header: string; field: keyof ParsedOpeningRow | 'aroAssetClassCode' | 'aroAssetClassName' | 'openingAroCost' | 'remainingUl' }[] = [
  { header: 'Obligation Number', field: 'ref' },
  { header: 'Description', field: 'description' },
  { header: 'Obligation type', field: 'type' },
  { header: 'Basis', field: 'basis' },
  { header: 'Site', field: 'site' },
  { header: 'Region', field: 'region' },
  { header: 'Cost estimate date', field: 'costEstimateDate' },
  { header: 'Expected settlement', field: 'settlementDate' },
  { header: 'Estimated cost', field: 'estimatedCost' },
  { header: 'Opening future value', field: 'openingFv' },
  { header: 'Opening provision', field: 'openingProvision' },
  { header: 'TCA asset number', field: 'assetId' },
  { header: 'ARO asset number', field: 'aroAssetNumber' },
  { header: 'ARO Asset Description', field: 'assetDescription' },
  { header: 'Asset acquisition date', field: 'assetAcquisitionDate' },
  { header: 'ARO asset class code', field: 'aroAssetClassCode' },
  { header: 'ARO asset class name', field: 'aroAssetClassName' },
  { header: 'ARO acquisition cost', field: 'openingAroCost' },
  { header: 'Accumulated amortization', field: 'openingAccumAmort' },
  { header: 'ARO asset', field: 'openingArc' },
  { header: 'Total UL', field: 'totalUl' },
  { header: 'Expired UL', field: 'expiredUl' },
  { header: 'Remaining UL', field: 'remainingUl' },
];

export function openingTemplateHeaders(extraNames: string[] = []): string[] {
  const seen = new Set(OPENING_TEMPLATE_COLUMNS.map((c) => c.header.trim().toLowerCase()));
  const extras = extraNames.filter((n) => {
    const t = n.trim();
    if (!t) return false;
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...OPENING_TEMPLATE_COLUMNS.map((c) => c.header), ...extras];
}

export function estimatedCostOf(o: Obligation): number | '' {
  if (!o.lines?.length) return '';
  return o.lines.reduce((s, l) => s + l.qty * l.rate, 0);
}

export function openingTemplateDataRows(
  obligations: Obligation[],
  events: ObligationEvent[],
  extraNames: string[] = [],
  classes?: AroAssetClass[],
): (string | number)[][] {
  const extras = openingTemplateHeaders(extraNames).slice(OPENING_TEMPLATE_COLUMNS.length);
  return obligations.map((o) => {
    const opening = events.find((e) => e.obligationId === o.id && e.type === 'opening');
    const cols = obligationColumns(o);
    const held = typeof o.aroAssetClass === 'string' ? o.aroAssetClass : '';
    const mapped = OPENING_TEMPLATE_COLUMNS.map((c) => {
      if (c.field === 'openingProvision') return opening?.amount ?? '';
      if (c.field === 'openingArc') return typeof o.openingArc === 'number' ? o.openingArc : '';
      if (c.field === 'openingAccumAmort') return typeof o.openingAccumAmort === 'number' ? o.openingAccumAmort : '';
      if (c.field === 'openingFv') return typeof o.openingFv === 'number' ? o.openingFv : '';
      if (c.field === 'totalUl') return typeof o.totalUl === 'number' ? o.totalUl : '';
      if (c.field === 'expiredUl') return typeof o.expiredUl === 'number' ? o.expiredUl : '';
      if (c.field === 'estimatedCost') return estimatedCostOf(o);
      if (c.field === 'aroAssetClassCode') return classCodeOf(held, classes);
      if (c.field === 'aroAssetClassName') return classNameOf(held, classes);
      if (c.field === 'aroAssetNumber') return String(o.aroAssetNumber ?? '');
      if (c.field === 'openingAroCost') return openingAroCostOf(o);
      if (c.field === 'remainingUl') return remainingUl(o) ?? '';
      const v = o[c.field];
      return v == null ? '' : (v as string | number);
    });
    return [...mapped, ...extras.map((name) => cols[name] ?? '')];
  });
}

export function openingTemplateNotes(): string[][] {
  return [
    ['Obligation and ARO Asset Listing template'],
    ['Use the Obligation & ARO Asset Listing sheet to organise and clean the conversion extract before you load it. Do not load this Notes sheet.'],
    [],
    ['How to load'],
    ['Save the Obligation & ARO Asset Listing sheet as CSV (UTF-8), then Choose file. Or copy the sheet (including the header row) and paste it on Opening register.'],
    ['An .xlsx workbook is not loaded as-is — save that sheet as CSV, or paste it.'],
    [],
    ['What each row needs'],
    ['Nothing is loaded until every error is fixed. Partial files are refused.'],
    ['Obligation Number is required and must be unique.'],
    ['TCA asset number is required. It is the link to the master TCA listing; that asset is in scope. Alias: Asset number.'],
    ['ARO asset number is optional. It is the retirement-cost asset identifier, distinct from the TCA asset number.'],
    ['Opening provision, ARO asset (NBV) and Accumulated amortization are required numbers (0 is allowed).'],
    ['ARO acquisition cost is NBV plus accumulated amortization. Leave it blank on load — the listing calculates it.'],
    ['Total UL and Expired UL are required (years, 0 or more). Expired UL cannot exceed Total UL. Remaining UL is Total UL minus Expired UL; leave it blank on load.'],
    ['Dates, if present, as YYYY-MM-DD (for example 2027-03-31).'],
    ['Estimated cost and Opening future value are optional. Extra columns are optional.'],
    [],
    ['Obligation columns'],
    ['Obligation Number', 'Unique id for the obligation. Headings Reference, Ref, Obligation reference and ARO ref still load into this column.'],
    ['Description', 'What is being retired.'],
    ['Obligation type', 'Reporting slice (wells, plant, …). Aliases: Type, ARO type. Kept on the register; the engine does not use it to measure.'],
    ['Basis', 'Legal or Constructive.'],
    ['Site', 'Alias: Location.'],
    ['Region', 'Aliases: Area, Jurisdiction.'],
    ['Cost estimate date', 'Price date of the cost. Alias: Estimate date.'],
    ['Expected settlement', 'Planned retirement date. Aliases: Settlement date, Retirement date.'],
    ['Estimated cost', 'Current-price cost. Aliases: Direct cost, Cost.'],
    ['Opening future value', 'Converted undiscounted amount at settlement. Aliases: Opening FV, Future value, FV. Distinct from the engine\'s future value at settlement.'],
    ['Opening provision', 'Converted liability (PV). Aliases: Provision, PV, Opening balance.'],
    [],
    ['ARO and TCA asset columns'],
    ['TCA asset number', 'Required. The related tangible-capital-asset identifier on the master listing. Aliases: Asset number, Asset, Asset id, ANLN1.'],
    ['ARO asset number', 'The retirement-cost asset identifier. Distinct from the TCA asset number. Aliases: ARO asset no, ARO asset id, ANLN2.'],
    ['ARO Asset Description', 'What the retirement-cost asset is. Aliases: Asset description, PPE description. TCA description comes from the master listing after load.'],
    ['Asset acquisition date', 'Optional on this extract. The master listing\'s acquisition date is shown on the obligation and ARO asset listing after load. Aliases: Acquisition date, In service date.'],
    ['ARO asset class code', 'Organisation class code (ANLKL). Stored on the obligation and used to pick the posting scenario. Aliases: Asset class code, Class code, ANLKL.'],
    ['ARO asset class name', 'Class name that goes with the code — the same pair as on the register. Aliases: Asset class name, Class name.'],
    ['ARO asset class', 'A combined label still loads (code, name, or "11010 Buildings"). Prefer the two columns above.'],
    ['ARO acquisition cost', 'Gross retirement-cost asset (NBV + accumulated amortization). Calculated on the listing and on export. Optional on load.'],
    ['Accumulated amortization', 'Contra to the retirement cost asset. Aliases: Accumulated depreciation, Accum amort.'],
    ['ARO asset', 'Converted NBV. Aliases: NBV, ARC, Retirement cost asset.'],
    ['Total UL', 'Total useful life of the related asset, in years. Aliases: Total useful life, Useful life, UL.'],
    ['Expired UL', 'Useful life already consumed, in years. Remaining UL = Total UL − Expired UL. Aliases: Expired useful life, Elapsed UL.'],
    ['Remaining UL', 'Calculated. Total UL minus Expired UL. Leave blank on load.'],
    [],
    ['Extra columns'],
    ['Add any further heading to the right of Remaining UL — licence, UWI, operator, cost centre, and so on. Those columns stay on the register under your headings and can be used in reporting. The engine does not read them.'],
    [],
    ['Example row (do not leave this on the sheet you load)'],
    ['ARO-0001', 'Well abandonment', 'Wells', 'Legal', 'North', 'Alberta', '2026-12-31', '2038-06-30', '1500000', '2100000', '1200000', 'AS-10001', 'ARO-10001', 'Well 14-23 pad', '2008-06-15', '1000', 'Wells', '1200000', '400000', '800000', '25', '10', '15'],
  ];
}

function openingEventId(unitId: string, obligationId: string): string {
  return `${unitId}-open-${obligationId}`;
}

/**
 * Write the extract onto the unit: each row becomes an obligation with an
 * opening provision event and an opening ARO-asset carrying amount. Existing
 * rows with the same reference are updated; other obligations are left alone.
 */
export function loadOpeningRegister(
  s: AppState,
  tenantId: string,
  unitId: string,
  parsed: OpeningParseResult,
  source: { filename: string; text: string },
  now = new Date().toISOString(),
): OpeningLoadResult | string {
  const data = s.data[unitId];
  const unit = (s.units[tenantId] ?? []).find((u) => u.id === unitId);
  if (!data || !unit) return 'That reporting unit is not on this tenant.';
  if (openingLocked(data)) {
    return 'Opening balances are locked. Unlock them on Opening register before loading another extract.';
  }
  if (data.openingSnapshot) {
    return 'The conversion extract is frozen. Load an updated master TCA listing on ARO scoping.';
  }
  if (parsed.problems.length) return parsed.problems[0];
  if (!parsed.rows.length) return 'The file has no obligation rows. Fix the errors and load the file again.';

  const listing = data.tcaAssets ?? [];
  if (listing.length) {
    const known = new Set(listing.map((a) => assetNumberKey(a.assetNumber)));
    const missing = parsed.rows.filter((r) => !known.has(assetNumberKey(r.assetId)));
    if (missing.length) {
      const sample = missing.slice(0, 4).map((r) => `${r.ref} (${r.assetId})`).join(', ');
      const more = missing.length > 4 ? `, and ${missing.length - 4} more` : '';
      return `${missing.length} obligation${missing.length === 1 ? '' : 's'} name a TCA asset number that is not on the master TCA listing: ${sample}${more}. Add those assets to the listing, then load this extract again.`;
    }
  }

  const period = data.periods[0];
  if (!period) return `${unit.entity} needs a fiscal calendar before the opening register can load.`;

  const fyEnd = unit.fyEnd;
  const byRef = new Map(data.obligations.map((o) => [o.ref.trim().toLowerCase(), o]));
  let added = 0;
  let updated = 0;
  const n = data.obligations.length;

  for (const row of parsed.rows) {
    const existing = byRef.get(row.ref.toLowerCase());
    const id = existing?.id ?? `o-${unitId}-${n + added}`;
    const cost = row.estimatedCost ?? row.openingProvision ?? 0;
    const costDate = row.costEstimateDate || fyEnd;
    const settle = row.settlementDate || fyEnd;
    const lines = [{
      id: `${id}-open-cost`,
      description: 'Opening estimated cost',
      qty: 1,
      rate: cost,
      source: source.filename,
    }];
    const next: Obligation = {
      ...(existing ?? { adj: [] }),
      id,
      ref: row.ref,
      description: row.description,
      costEstimateDate: costDate,
      settlementDate: settle,
      lines: existing?.lines?.length ? existing.lines : lines,
      adj: existing?.adj ?? [],
      assetId: row.assetId || existing?.assetId || '',
      aroAssetNumber: row.aroAssetNumber || existing?.aroAssetNumber || '',
      assetDescription: row.assetDescription || existing?.assetDescription || '',
      assetAcquisitionDate: row.assetAcquisitionDate || existing?.assetAcquisitionDate || '',
      site: row.site || existing?.site || '',
      region: row.region || existing?.region || '',
      type: row.type || existing?.type || '',
      aroAssetClass: row.aroAssetClass || existing?.aroAssetClass || '',
      basis: row.basis,
      status: (existing?.status as string) || 'In scope',
      scopeReason: existing?.scopeReason || '',
      openingArc: row.openingArc ?? existing?.openingArc ?? 0,
      openingAccumAmort: row.openingAccumAmort ?? existing?.openingAccumAmort ?? 0,
      openingFv: row.openingFv ?? existing?.openingFv ?? 0,
      totalUl: row.totalUl ?? existing?.totalUl,
      expiredUl: row.expiredUl ?? existing?.expiredUl,
      varianceCause: existing?.varianceCause || '',
      columns: { ...(existing ? obligationColumns(existing) : {}), ...row.columns },
    };

    if (existing) {
      const i = data.obligations.findIndex((o) => o.id === existing.id);
      data.obligations[i] = next;
      updated++;
    } else {
      data.obligations.push(next);
      byRef.set(row.ref.toLowerCase(), next);
      added++;
    }

    const amount = row.openingProvision ?? 0;
    const evId = openingEventId(unitId, id);
    const ev: ObligationEvent = {
      id: evId,
      obligationId: id,
      periodId: period.id,
      type: 'opening',
      date: period.starts,
      amount,
      sourceRowRef: row.ref,
      note: `Opening provision from ${source.filename}.`,
    };
    const ei = data.events.findIndex((e) => e.id === evId);
    if (ei >= 0) data.events[ei] = ev;
    else data.events.push(ev);
  }

  data.tcaAssets = syncTcaScopeFromObligations(data.tcaAssets ?? [], data.obligations);
  applyLinkedObligationScope(data.obligations, data.tcaAssets);

  if (s.settings[tenantId]) canonicalizeObligationClasses(s.settings[tenantId], data);

  data.extracts.push({
    id: `x-${unitId}-${Date.now().toString(36)}`,
    unitId,
    kind: 'Opening register',
    filename: source.filename,
    hash: hashText(source.text),
    rows: parsed.rows.length,
    receivedAt: now,
    declared: 'cumulative',
    targetPeriodId: period.id,
    acceptedAt: now,
    template: 'Opening register — column mapped',
    templateValidated: false,
  });

  return { added, updated, problems: parsed.problems };
}
