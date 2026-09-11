/**
 * The ARO register — SCREENS.md, "The register".
 *
 * "It renders from a column definition with a group header row (Identity ·
 * Provision · ARO asset · Dates · Calculated · Movement), tinted derived cells,
 * column sets, saved views (column set + filter + sort, named, per reporting
 * unit), a selection column with select-all-on-page and select-all-filtered,
 * bulk edit as a single logged change, in-grid select cells for pick-list
 * columns, keyboard navigation (Enter/↓ down the column, ↑ up, Tab across),
 * and Excel block paste that fills down and right and reports what would not
 * take."
 *
 * The default set is posted books as at a chosen fiscal year and period.
 * Opening is the prior-year closing. In-year columns are event-ledger amounts
 * through that period. Post a new obligation from this page, or open a row to
 * post a cost or term adjustment or a settlement. Open a calculation-details
 * line for the events in that total. Transactions remains the whole-period
 * posting step. Journal batches package those amounts for the GL.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit } from '../../core/authority';
import { extraColumnKey, extraColumnName, isOpeningBalanceField, obligationColumnNames, obligationColumns, obligationField, openingLocked, patchObligationField, remainingUl } from '../../core/openingLoad';
import { tcaAssetStatusOf, tcaByObligationId, tcaColumnNames } from '../../core/tcaListing';
import { classCodeOf, classKey, classNameOf, findAssetClass } from '../../core/assetClass';
import { formatUl, parseUlYears, ulAlignmentPending, usefulLifeAsAt, termToSettlementAtYearStart } from '../../core/usefulLife';
import { fiscalYearStart } from '../../core/periods';
import { assetBooks, openPeriod, type AssetBooks } from '../../core/periodClose';
import { registerBooksById, unpostedInYearCount, type RegisterBooks } from '../../core/registerBooks';
import { Obligation, TcaAsset } from '../../core/types';
import { isValidDate } from '../../engine/dates';
import { SCOPING_REASONS, VARIANCE_CAUSES } from '../../seed';
import { Block, UlYmInputs, currency, num, parseNumber, pct, SheetStatus, SheetTable, SheetTh, Stats, Tag, useSheet } from '../components';
import { SheetFilter } from '../sheet';
import { download, S } from '../../xlsx/write';
import { groupToneClass } from '../groupTone';
import { ObligationExpand } from './measure';
import { NewObligationForm } from './transactions';

type ColKind = 'text' | 'number' | 'date' | 'select' | 'derived';
type ColGroup = 'Identity' | 'Asset' | 'TCA' | 'Opening' | 'Existing' | 'New' | 'Closing' | 'ARO asset' | 'Dates' | 'Calculated' | 'Movement' | 'Source';

interface ColDef {
  key: string;
  label: string;
  group: ColGroup;
  kind: ColKind;
  width?: number;
  options?: string[];
  /** Derived columns read the engine, never the record. */
  value?: (o: Obligation, d: ReturnType<typeof useDerived> extends infer _ ? any : never) => string;
  align?: 'right';
  basis?: string;
}

const COLUMNS: ColDef[] = [
  { key: 'ref', label: 'Obligation Number', group: 'Identity', kind: 'text', width: 140 },
  { key: 'description', label: 'Description', group: 'Identity', kind: 'text', width: 240 },
  { key: 'status', label: 'Scope', group: 'Identity', kind: 'select', options: ['In scope', 'Scoped out'], width: 100 },
  { key: 'scopeReason', label: 'Reason if out of scope', group: 'Identity', kind: 'select', options: ['', ...SCOPING_REASONS], width: 200 },
  { key: 'type', label: 'Type', group: 'Identity', kind: 'text', width: 160 },
  { key: 'basis', label: 'Basis', group: 'Identity', kind: 'select', options: ['Legal', 'Constructive'], width: 110 },
  { key: 'site', label: 'Site', group: 'Identity', kind: 'text', width: 130 },
  { key: 'region', label: 'Region', group: 'Identity', kind: 'text', width: 120 },
  { key: 'openingFv', label: 'Opening future value', group: 'Identity', kind: 'number', align: 'right', width: 150 },
  { key: 'costEstimateDate', label: 'Cost estimate date', group: 'Dates', kind: 'date', width: 130 },
  { key: 'settlementDate', label: 'Expected settlement', group: 'Dates', kind: 'date', width: 130 },
  { key: 'assetId', label: 'TCA asset number', group: 'TCA', kind: 'text', width: 130 },
  { key: 'aroAssetNumber', label: 'ARO asset number', group: 'Asset', kind: 'text', width: 130 },
  { key: 'assetDescription', label: 'ARO asset description', group: 'Asset', kind: 'text', width: 200 },
  { key: 'assetAcquisitionDate', label: 'Asset acquisition date', group: 'Asset', kind: 'date', width: 150 },
  { key: '_tca_description', label: 'TCA description', group: 'TCA', kind: 'derived', width: 200 },
  { key: '_tca_class', label: 'TCA asset class', group: 'TCA', kind: 'derived', width: 140 },
  { key: '_tca_acq', label: 'TCA acquisition date', group: 'TCA', kind: 'derived', width: 150 },
  { key: '_tca_site', label: 'TCA site', group: 'TCA', kind: 'derived', width: 120 },
  { key: '_tca_status', label: 'TCA asset status', group: 'TCA', kind: 'derived', width: 140 },
  { key: '_tca_scope', label: 'TCA scope', group: 'TCA', kind: 'derived', width: 110 },
  { key: '_tca_reason', label: 'Reason if out', group: 'TCA', kind: 'derived', width: 180 },
  { key: 'aroAssetClassCode', label: 'ARO asset class code', group: 'Asset', kind: 'select', options: [''], width: 140 },
  { key: 'aroAssetClassName', label: 'ARO asset class name', group: 'Asset', kind: 'select', options: [''], width: 180 },
  { key: 'inProductiveUse', label: 'ARO asset in productive use', group: 'Asset', kind: 'select', options: ['Yes', 'No'], width: 170 },
  { key: '_open_term', label: 'Term to settlement', group: 'Identity', kind: 'derived', align: 'right', width: 150 },
  { key: 'openingArc', label: 'Opening ARO asset', group: 'Asset', kind: 'number', align: 'right', width: 140 },
  { key: 'openingAccumAmort', label: 'Opening accumulated amortization', group: 'Asset', kind: 'number', align: 'right', width: 190 },
  { key: 'totalUl', label: 'Total UL', group: 'Asset', kind: 'number', align: 'right', width: 168 },
  { key: 'expiredUl', label: 'Expired UL', group: 'Asset', kind: 'number', align: 'right', width: 140 },
  { key: 'remainingUl', label: 'Remaining UL', group: 'Asset', kind: 'derived', align: 'right', width: 140 },
  { key: '_arc_gross', label: 'ARO asset gross', group: 'Asset', kind: 'derived', align: 'right', width: 140 },
  { key: '_arc_accum', label: 'Accumulated amortization', group: 'Asset', kind: 'derived', align: 'right', width: 170 },
  { key: '_arc_nbv', label: 'ARO asset', group: 'Asset', kind: 'derived', align: 'right', width: 130 },
  { key: '_direct', label: 'Direct cost', group: 'Calculated', kind: 'derived', align: 'right', basis: 'CURRENT', width: 120 },
  { key: '_cost', label: 'Cost + contingency', group: 'Calculated', kind: 'derived', align: 'right', basis: 'CURRENT', width: 130 },
  { key: '_cce', label: 'Escalated to FY end', group: 'Calculated', kind: 'derived', align: 'right', basis: 'ESCALATED', width: 140 },
  { key: '_fv', label: 'Future value at settlement', group: 'Calculated', kind: 'derived', align: 'right', basis: 'FV@SETTLE', width: 160 },
  { key: '_term', label: 'Curve term', group: 'Calculated', kind: 'derived', align: 'right', width: 100 },
  { key: '_rate', label: 'Discount rate', group: 'Calculated', kind: 'derived', align: 'right', width: 110 },
  { key: '_pv', label: 'Provision', group: 'Calculated', kind: 'derived', align: 'right', basis: 'PV@FY-END', width: 130 },
  { key: '_cost_eff', label: 'Cost effect', group: 'Movement', kind: 'derived', align: 'right', width: 110 },
  { key: '_timing_eff', label: 'Timing effect', group: 'Movement', kind: 'derived', align: 'right', width: 110 },
  { key: '_rate_eff', label: 'Rate effect', group: 'Movement', kind: 'derived', align: 'right', width: 110 },
  { key: '_infl_eff', label: 'Inflation effect', group: 'Movement', kind: 'derived', align: 'right', width: 120 },
  { key: '_movement', label: 'Total movement', group: 'Movement', kind: 'derived', align: 'right', width: 130 },
  { key: 'varianceCause', label: 'Variance cause', group: 'Movement', kind: 'select', options: ['', ...VARIANCE_CAUSES], width: 200 },
];

/** Posted books as at the selected period — FY opening, cumulative event-ledger in-year, closing. */
const POSTED_COLUMNS: ColDef[] = [
  { key: '_ob_open', label: 'Opening balances', group: 'Opening', kind: 'derived', align: 'right', width: 104 },
  { key: '_ob_settle', label: 'Settlement', group: 'Existing', kind: 'derived', align: 'right', width: 96 },
  { key: '_ob_accr_ex', label: 'Accretion on existing ARO', group: 'Existing', kind: 'derived', align: 'right', width: 108 },
  { key: '_ob_cost', label: 'Change of estimate — cost adjustments', group: 'Existing', kind: 'derived', align: 'right', width: 112 },
  { key: '_ob_term', label: 'Change of estimate — term adjustments', group: 'Existing', kind: 'derived', align: 'right', width: 112 },
  { key: '_ob_writeoff', label: 'Change of estimate — write-offs', group: 'Existing', kind: 'derived', align: 'right', width: 108 },
  { key: '_ob_mass', label: 'Change of estimate — year-end mass update (inflation and interest rates)', group: 'Existing', kind: 'derived', align: 'right', width: 124 },
  { key: '_ob_new', label: 'New ARO', group: 'New', kind: 'derived', align: 'right', width: 96 },
  { key: '_ob_accr_new', label: 'Accretion on new ARO', group: 'New', kind: 'derived', align: 'right', width: 108 },
  { key: '_ob_fx', label: 'Exchange differences', group: 'New', kind: 'derived', align: 'right', width: 104 },
  { key: '_ob_close', label: 'Closing', group: 'Closing', kind: 'derived', align: 'right', width: 104 },
  { key: '_arc_open', label: 'Opening ARO asset', group: 'ARO asset', kind: 'derived', align: 'right', width: 104 },
  { key: '_arc_add', label: 'Additions', group: 'ARO asset', kind: 'derived', align: 'right', width: 96 },
  { key: '_arc_amort', label: 'Amortization', group: 'ARO asset', kind: 'derived', align: 'right', width: 104 },
  { key: '_arc_close', label: 'Closing ARO asset', group: 'ARO asset', kind: 'derived', align: 'right', width: 104 },
];

const POSTED_KEYS = new Set(POSTED_COLUMNS.map((c) => c.key));

const POSTED_BOOKS_KEYS = [
  'ref', 'description', 'site', 'aroAssetClassCode', 'aroAssetClassName', '_open_term',
  '_ob_open', '_ob_settle', '_ob_accr_ex', '_ob_cost', '_ob_term', '_ob_writeoff', '_ob_mass',
  '_ob_new', '_ob_accr_new', '_ob_fx', '_ob_close', '_fv',
  'remainingUl', '_arc_open', '_arc_add', '_arc_amort', '_arc_close',
];

const COLUMN_SETS: Record<string, string[]> = {
  'Posted books': POSTED_BOOKS_KEYS,
  'Measurement': ['ref', 'description', 'costEstimateDate', 'settlementDate', '_cost', '_cce', '_fv', 'openingFv', '_term', '_rate', '_pv', '_arc_nbv'],
      'Identity & scope': ['ref', 'description', 'status', 'scopeReason', 'type', 'basis', 'site', 'region', 'openingFv', 'aroAssetNumber', 'assetDescription', 'aroAssetClassCode', 'aroAssetClassName', 'inProductiveUse', 'assetId', '_tca_description', '_tca_class', '_tca_acq', '_tca_site', '_tca_status', '_tca_scope', '_tca_reason', '_open_term', 'openingArc', 'openingAccumAmort', 'totalUl', 'expiredUl', 'remainingUl'],
      'ARO asset': ['ref', 'description', 'aroAssetNumber', 'aroAssetClassCode', 'aroAssetClassName', 'inProductiveUse', 'openingArc', 'openingAccumAmort', 'remainingUl', '_arc_gross', '_arc_accum', '_arc_nbv', '_pv'],
  'Movement': ['ref', 'description', '_pv', '_cost_eff', '_timing_eff', '_rate_eff', '_infl_eff', '_movement', 'varianceCause'],
  'Dates & terms': ['ref', 'description', 'costEstimateDate', 'settlementDate', '_open_term', '_term', '_rate'],
  'Everything': [...COLUMNS.map((c) => c.key), ...POSTED_COLUMNS.map((c) => c.key)],
};

const PAGE = 25;

export function Register() {
  const { state, ui, write, apply, setUi } = useStore();
  const unit = useUnit();
  const data = useUnitData();

  const [set, setSet] = useState('Posted books');
  const [asAtId, setAsAtId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [views, setViews] = useState<{ name: string; set: string; filter: string; sort: { key: string; dir: 1 | -1 } | null; colFilters: Record<string, SheetFilter> }[]>([]);
  const [bulk, setBulk] = useState<{ key: string; value: string } | null>(null);
  const [pasteReport, setPasteReport] = useState<string[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newAroOpen, setNewAroOpen] = useState(false);
  const open = openPeriod(data ?? { periods: [] });
  const asAt = useMemo(() => {
    if (!data?.periods.length) return undefined;
    const picked = asAtId ? data.periods.find((p) => p.id === asAtId) : undefined;
    return picked ?? openPeriod(data) ?? data.periods[data.periods.length - 1];
  }, [data, asAtId]);
  const derived = useDerived(asAt?.ends);
  const gridRef = useRef<HTMLTableElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const editable = canEdit(ui.role);
  const locked = openingLocked(data);

  const assetClasses = useMemo(
    () => (unit ? (state.settings[unit.tenantId]?.aroAssetClasses ?? []) : []),
    [state.settings, unit],
  );
  const classCodes = useMemo(
    () => ['', ...[...new Set(assetClasses.map((c) => (c.code ?? '').trim()).filter(Boolean))]],
    [assetClasses],
  );
  const classNames = useMemo(
    () => ['', ...[...new Set(assetClasses.map((c) => c.name.trim()).filter(Boolean))]],
    [assetClasses],
  );

  const extraNames = useMemo(() => obligationColumnNames(data?.obligations ?? []), [data]);
  const tcaExtras = useMemo(() => tcaColumnNames(data?.tcaAssets ?? []), [data]);
  const tcaByObl = useMemo(() => tcaByObligationId(data?.tcaAssets, data?.obligations ?? []), [data]);
  const extraColDefs = useMemo((): ColDef[] => extraNames.map((name) => ({
    key: extraColumnKey(name),
    label: name,
    group: 'Source',
    kind: 'text',
    width: Math.min(220, Math.max(120, name.length * 8 + 24)),
  })), [extraNames]);
  const tcaExtraColDefs = useMemo((): ColDef[] => tcaExtras.map((name) => ({
    key: `_tca_col:${name}`,
    label: `TCA · ${name}`,
    group: 'TCA',
    kind: 'derived',
    width: Math.min(220, Math.max(120, name.length * 8 + 24)),
  })), [tcaExtras]);
  const allColumns = useMemo(() => [...COLUMNS, ...POSTED_COLUMNS, ...extraColDefs, ...tcaExtraColDefs], [extraColDefs, tcaExtraColDefs]);
  const columnSets = useMemo(() => {
    const extraKeys = extraColDefs.map((c) => c.key);
    const tcaExtraKeys = tcaExtraColDefs.map((c) => c.key);
    const sets: Record<string, string[]> = {
      'Posted books': COLUMN_SETS['Posted books'],
      Measurement: COLUMN_SETS.Measurement,
      'Identity & scope': [...COLUMN_SETS['Identity & scope'], ...extraKeys, ...tcaExtraKeys],
      'ARO asset': COLUMN_SETS['ARO asset'],
      Movement: COLUMN_SETS.Movement,
      'Dates & terms': COLUMN_SETS['Dates & terms'],
      Everything: [...COLUMNS.map((c) => c.key), ...POSTED_COLUMNS.map((c) => c.key), ...extraKeys, ...tcaExtraKeys],
    };
    if (extraKeys.length) sets['Source extract'] = ['ref', 'description', ...extraKeys];
    return sets;
  }, [extraColDefs, tcaExtraColDefs]);

  const fiscalYears = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.periods.map((p) => p.fiscalYear))].sort((a, b) => a - b);
  }, [data]);

  const periodsInFy = useMemo(() => {
    if (!data || !asAt) return [];
    return data.periods.filter((p) => p.fiscalYear === asAt.fiscalYear).sort((a, b) => a.no - b.no);
  }, [data, asAt]);

  const cols = useMemo(
    () => (columnSets[set] ?? COLUMN_SETS['Posted books']).map((k) => {
      const c = allColumns.find((col) => col.key === k);
      if (!c) return undefined as never;
      if (c.key === 'aroAssetClassCode') {
        return set === 'Posted books'
          ? { ...c, options: classCodes, group: 'Identity' as const, width: 120 }
          : { ...c, options: classCodes };
      }
      if (c.key === 'aroAssetClassName') {
        return set === 'Posted books'
          ? { ...c, options: classNames, group: 'Identity' as const, width: 140 }
          : { ...c, options: classNames };
      }
      if (set === 'Posted books' && c.key === 'remainingUl') return { ...c, group: 'ARO asset' as const, width: 140 };
      if (set === 'Posted books' && c.key === '_fv') return { ...c, group: 'Closing' as const, label: 'FV', width: 120 };
      if (set === 'Posted books' && c.key === 'ref') return { ...c, width: 108 };
      if (set === 'Posted books' && c.key === 'description') return { ...c, width: 168 };
      if (set === 'Posted books' && c.key === 'site') return { ...c, width: 96 };
      return c;
    }).filter(Boolean),
    [set, classCodes, classNames, allColumns, columnSets],
  );

  const booksById = useMemo(() => {
    const m = new Map<string, ReturnType<typeof assetBooks>>();
    if (!data || !asAt) return m;
    for (const o of data.obligations) m.set(o.id, assetBooks(data.events, data.periods, o, asAt));
    return m;
  }, [data, asAt]);

  const postedById = useMemo(() => {
    if (!data || !asAt) return new Map<string, RegisterBooks>();
    return registerBooksById(data.obligations, data.events, data.periods, data.batches, asAt);
  }, [data, asAt]);

  const ulById = useMemo(() => {
    const m = new Map<string, ReturnType<typeof usefulLifeAsAt>>();
    if (!data || !unit) return m;
    for (const o of data.obligations) m.set(o.id, usefulLifeAsAt(o, data.events, data.periods, unit, asAt));
    return m;
  }, [data, unit, asAt]);

  const openTermById = useMemo(() => {
    const m = new Map<string, number | null>();
    if (!data || !unit || !asAt) return m;
    const start = fiscalYearStart(data.periods, asAt.fiscalYear);
    for (const o of data.obligations) m.set(o.id, termToSettlementAtYearStart(o, unit, start));
    return m;
  }, [data, unit, asAt]);

  const unposted = useMemo(() => {
    if (!data || !asAt) return 0;
    return unpostedInYearCount(data.events, data.periods, data.batches, asAt);
  }, [data, asAt]);

  const postedTotals = useMemo(() => {
    let openingProvision = 0, closingProvision = 0, openingArc = 0, closingArc = 0;
    for (const b of postedById.values()) {
      openingProvision += b.openingProvision;
      closingProvision += b.closingProvision;
      openingArc += b.openingArc;
      closingArc += b.closingArc;
    }
    return { openingProvision, closingProvision, openingArc, closingArc };
  }, [postedById]);

  const specs = useMemo(() => cols.map((c) => ({
    key: c.key,
    kind: (c.kind === 'date' ? 'date' : c.kind === 'derived' || c.kind === 'number' ? 'number' : 'text') as 'text' | 'number' | 'date',
    value: (o: Obligation) => cellRaw(o, c.key, derived, booksById.get(o.id), postedById.get(o.id), ulById.get(o.id), openTermById.get(o.id), tcaByObl.get(o.id)),
  })), [cols, derived, booksById, postedById, ulById, openTermById, tcaByObl]);

  const searched = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return data.obligations;
    return data.obligations.filter((o) => {
      const tca = tcaByObl.get(o.id);
      return [o.ref, o.description, o.site, o.region, o.type, o.aroAssetClass, o.status, o.assetId, o.aroAssetNumber, tca?.assetNumber, tca?.description, tca?.assetClass, tca?.scope, tca ? tcaAssetStatusOf(tca) : '', ...Object.values(obligationColumns(o)), ...Object.values(tca?.columns ?? {})]
        .some((v) => String(v ?? '').toLowerCase().includes(q));
    });
  }, [data, filter, tcaByObl]);

  const sheet = useSheet(searched, specs, { key: 'ref', dir: 1 });
  const filtered = sheet.rows;
  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      const room = window.innerHeight - el.getBoundingClientRect().top - 96;
      const next = `${Math.max(240, room)}px`;
      if (el.style.maxHeight !== next) el.style.maxHeight = next;
      el.style.setProperty('--register-port', `${el.clientWidth}px`);
      const row = el.querySelector('tbody tr:not(.register-expand-row)') as HTMLTableRowElement | null;
      if (!row?.cells[0]) return;
      el.style.setProperty('--register-lead-1', `${row.cells[0].offsetWidth}px`);
      if (row.cells[1]) {
        el.style.setProperty('--register-lead-2', `${row.cells[0].offsetWidth + row.cells[1].offsetWidth}px`);
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    if (gridRef.current) ro.observe(gridRef.current);
    window.addEventListener('resize', sync);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [cols.length, pageRows.length, expandedId, newAroOpen]);

  useEffect(() => { setPage(0); }, [filter, set, asAtId, sheet.filters, sheet.sort]);

  if (!unit || !data || !derived) return null;

  /* ── writes ─────────────────────────────────────────────────────────── */

  const editCell = (o: Obligation, key: string, value: string) => {
    const col = allColumns.find((c) => c.key === key);
    if (!col) return;
    let parsed: unknown = value;
    if (key === 'totalUl') {
      parsed = value.trim() === '' ? null : parseUlYears(value);
      if (value.trim() && (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0)) {
        apply('Edit Total UL', 'refused', `${o.ref}: Total UL must be years, or years and leftover months.`, () => {});
        return;
      }
    } else if (col.kind === 'number') parsed = parseNumber(value);
    let after = patchObligationField(o, key, parsed);
    if (key === 'aroAssetClassCode' || key === 'aroAssetClassName') {
      const cls = findAssetClass(assetClasses, value);
      after = { ...o, aroAssetClass: cls ? classKey(cls) : value };
    }

    // INVARIANTS §5 — a bulk edit that hits a refused field (a settlement date
    // held by a timing revision) refuses it by name.
    const guarded: Record<string, string> = {};
    if (key === 'settlementDate' && o.adj.some((a) => a.kind === 'term')) {
      guarded.settlementDate = 'held by a timing revision — change the revision, not the register';
    }
    if (locked && isOpeningBalanceField(key)) {
      guarded[key] = 'opening balances are locked — unlock them on Opening register';
    }

    write<Obligation>({
      domain: 'register',
      record: o.id,
      recordLabel: `${o.ref} ${o.description}`,
      before: o,
      after,
      action: `Edit ${col.label}`,
      guarded,
      apply: (s, v) => {
        const list = s.data[unit.id].obligations;
        const i = list.findIndex((x) => x.id === o.id);
        if (i >= 0) list[i] = v;
      },
    });
  };

  /** Bulk edit is ONE logged change across the selection. */
  const applyBulk = () => {
    if (!bulk) return;
    const col = allColumns.find((c) => c.key === bulk.key);
    if (!col) return;
    const targets = data.obligations.filter((o) => sel.has(o.id));
    let written = 0;
    const refused: string[] = [];

    for (const o of targets) {
      if (bulk.key === 'settlementDate' && o.adj.some((a) => a.kind === 'term')) {
        refused.push(o.ref);
        continue;
      }
      if (locked && isOpeningBalanceField(bulk.key)) {
        refused.push(o.ref);
        continue;
      }
      written += 1;
    }

    const before = { field: col.label, rows: targets.length, value: '', written: 0, refused: 0 };
    write({
      domain: 'register',
      record: `bulk-${Date.now()}`,
      recordLabel: `Bulk edit — ${col.label} across ${targets.length} obligations`,
      before,
      after: { ...before, value: bulk.value, written, refused: refused.length },
      action: `Bulk edit ${col.label}`,
      apply: (s) => {
        const list = s.data[unit.id].obligations;
        for (const o of targets) {
          if (bulk.key === 'settlementDate' && o.adj.some((a) => a.kind === 'term')) continue;
          if (locked && isOpeningBalanceField(bulk.key)) continue;
          const i = list.findIndex((x) => x.id === o.id);
          if (i < 0) continue;
          if (bulk.key === 'aroAssetClassCode' || bulk.key === 'aroAssetClassName') {
            const cls = findAssetClass(assetClasses, bulk.value);
            list[i] = { ...list[i], aroAssetClass: cls ? classKey(cls) : bulk.value };
          } else {
            list[i] = patchObligationField(list[i], bulk.key, bulk.value);
          }
        }
      },
    });

    if (refused.length) {
      setPasteReport([
        `${written} written, ${refused.length} refused.`,
        `Refused because the expected settlement date is held by a timing revision: ${refused.join(', ')}. Record a term adjustment on Transactions, rather than editing the register cell.`,
      ]);
    }
    setBulk(null);
  };

  /**
   * Excel block paste — fills down and right from the anchor cell and reports,
   * cell by cell, anything that would not take. INVARIANTS §5: "A paste that
   * will not take is reported cell by cell, not truncated."
   */
  const onPaste = (e: React.ClipboardEvent, rowIdx: number, colIdx: number) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return;
    e.preventDefault();

    const block = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((r) => r.split('\t'));
    const problems: string[] = [];
    const writes: { o: Obligation; key: string; value: string }[] = [];

    block.forEach((line, dr) => {
      const target = pageRows[rowIdx + dr];
      if (!target) {
        problems.push(`Row ${rowIdx + dr + 1}: no obligation on this page to paste into — ${line.length} value${line.length === 1 ? '' : 's'} not taken.`);
        return;
      }
      line.forEach((raw, dc) => {
        const col = cols[colIdx + dc];
        if (!col) {
          problems.push(`${target.ref}: no column to the right of ${cols[cols.length - 1].label} — "${raw}" not taken.`);
          return;
        }
        if (col.kind === 'derived') {
          problems.push(col.key === 'remainingUl'
            ? `${target.ref} · ${col.label}: remaining UL is Total UL minus Expired UL, so it cannot be pasted into. "${raw}" not taken.`
            : col.key === '_open_term'
              ? `${target.ref} · ${col.label}: term to settlement is years from the start of this fiscal year to expected settlement, so it cannot be pasted into. "${raw}" not taken.`
              : `${target.ref} · ${col.label}: derived from the engine, so it cannot be pasted into. "${raw}" not taken.`);
          return;
        }
        if (col.kind === 'date' && raw.trim() && !isValidDate(raw.trim())) {
          problems.push(`${target.ref} · ${col.label}: "${raw}" is not a date in YYYY-MM-DD form. Not taken.`);
          return;
        }
        if (col.kind === 'select' && col.options && !col.options.includes(raw.trim())) {
          problems.push(`${target.ref} · ${col.label}: "${raw}" is not one of the permitted values. Not taken.`);
          return;
        }
        if (col.key === 'settlementDate' && target.adj.some((a) => a.kind === 'term')) {
          problems.push(`${target.ref} · ${col.label}: held by a timing revision. Not taken.`);
          return;
        }
        if (locked && isOpeningBalanceField(col.key)) {
          problems.push(`${target.ref} · ${col.label}: opening balances are locked. Unlock them on Opening register. "${raw}" not taken.`);
          return;
        }
        writes.push({ o: target, key: col.key, value: raw.trim() });
      });
    });

    if (writes.length) {
      write({
        domain: 'register',
        record: `paste-${Date.now()}`,
        recordLabel: `Paste — ${writes.length} cells across ${new Set(writes.map((w) => w.o.id)).size} obligations`,
        before: { cells: 0 },
        after: { cells: writes.length, refused: problems.length },
        action: 'Paste block into register',
        apply: (s) => {
          const list = s.data[unit.id].obligations;
          for (const w of writes) {
            const i = list.findIndex((x) => x.id === w.o.id);
            if (i < 0) continue;
            let value: unknown = w.value;
            if (w.key === 'totalUl') value = w.value === '' ? null : parseUlYears(w.value);
            list[i] = patchObligationField(list[i], w.key, value);
          }
        },
      });
    }
    setPasteReport(
      problems.length
        ? [`${writes.length} cell${writes.length === 1 ? '' : 's'} written, ${problems.length} not taken.`, ...problems]
        : [`${writes.length} cell${writes.length === 1 ? '' : 's'} written. Everything in the block took.`],
    );
  };

  /** Enter / ↓ move down the column, ↑ up, Tab across. */
  const onKeyDown = (e: React.KeyboardEvent, r: number, c: number) => {
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const next = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${r + dr}-${c + dc}"]`);
      next?.focus();
    };
    if (e.key === 'Enter' || e.key === 'ArrowDown') move(1, 0);
    else if (e.key === 'ArrowUp') move(-1, 0);
  };

  /* ── export ─────────────────────────────────────────────────────────── */

  const exportXlsx = () => {
    const head = ['Obligation Number', 'Description', 'Cost estimate date', 'Expected settlement', 'Direct cost',
      'Contingency', 'Cost at current prices', 'Inflation', 'Leg 1 (yrs)', 'Escalated to FY end',
      'Leg 2 (yrs)', 'Future value at settlement', 'Discount term (yrs)', 'Curve term', 'Rate', 'Provision'];

    const rows: (string | number | { v?: string | number; f?: string; s?: number; t?: 'd' })[][] = [
      [{ v: `${unit.entity} — ARO register`, s: S.title }],
      [`Financial year end ${unit.fyEnd}`, `Day count ${unit.dayCount}`, `Term convention ${unit.termConvention}`,
        `Curve ${derived.curve?.name ?? 'none'}`, `Inflation ${pct(unit.inflation)}`, `Contingency ${pct(unit.contingency)}`],
      [],
      head.map((h) => ({ v: h, s: S.head })),
    ];

    const first = rows.length + 1;
    filtered.forEach((o, i) => {
      const d = derived.byId.get(o.id)!;
      const r = first + i;
      // Every derived cell is a live formula referring only to cells in this
      // sheet, so the workbook recalculates in Excel with no external reference.
      rows.push([
        o.ref, o.description,
        { v: o.costEstimateDate, t: 'd' }, { v: d.settlementUsed, t: 'd' },
        { v: d.direct, s: S.money },
        { v: unit.contingency, s: S.rate },
        { f: `E${r}*(1+F${r})`, s: S.money },
        { v: unit.inflation, s: S.rate },
        { f: `DAYS360(C${r},DATE(${unit.fyEnd.slice(0, 4)},${Number(unit.fyEnd.slice(5, 7))},${Number(unit.fyEnd.slice(8, 10))}),FALSE)/360`, s: S.term },
        { f: `G${r}*(1+H${r})^I${r}`, s: S.money },
        { v: d.t2, s: S.term },
        { f: `J${r}*(1+H${r})^K${r}`, s: S.money },
        { f: `DAYS360(DATE(${unit.fyEnd.slice(0, 4)},${Number(unit.fyEnd.slice(5, 7))},${Number(unit.fyEnd.slice(8, 10))}),D${r},FALSE)/360`, s: S.term },
        { v: d.curveTerm, s: S.term },
        { v: d.rate, s: S.rate },
        { f: `IF(M${r}>0,L${r}/(1+O${r})^M${r},L${r})`, s: S.money },
      ]);
    });

    const total = first + filtered.length;
    rows.push([{ v: 'Total', s: S.bold }, '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      { f: `SUM(P${first}:P${total - 1})`, s: S.money }]);

    download(`${unit.entity.replace(/\W+/g, '-')}-register-${unit.fyEnd}.xlsx`, [
      { name: 'Register', rows: rows as never, cols: [14, 34, 16, 16, 15, 11, 17, 10, 11, 17, 11, 17, 15, 11, 10, 15], freeze: 4 },
    ]);
  };

  /* ── render ─────────────────────────────────────────────────────────── */

  const allOnPageSelected = pageRows.length > 0 && pageRows.every((o) => sel.has(o.id));

  const pickFy = (fy: number) => {
    const inFy = data.periods.filter((p) => p.fiscalYear === fy).sort((a, b) => a.no - b.no);
    const sameNo = asAt ? inFy.find((p) => p.no === asAt.no) : undefined;
    const openInFy = open && open.fiscalYear === fy ? open : undefined;
    const next = sameNo ?? openInFy ?? inFy[inFy.length - 1];
    if (next) setAsAtId(next.id);
  };

  return (
    <>
      <Stats items={[
        { label: 'Obligations', value: String(data.obligations.length) },
        { label: 'In scope', value: String(derived.rows.length) },
        { label: asAt ? `Opening balances FY${asAt.fiscalYear}` : 'Opening balances', value: currency(postedTotals.openingProvision, unit.currency) },
        { label: asAt ? `Closing ${asAt.code}` : 'Closing', value: currency(postedTotals.closingProvision, unit.currency) },
        { label: 'Opening ARO asset', value: currency(postedTotals.openingArc, unit.currency) },
        { label: asAt ? `Closing ARO asset ${asAt.code}` : 'Closing ARO asset', value: currency(postedTotals.closingArc, unit.currency) },
        { label: 'Reported problems', value: String(derived.invalid.length), tone: derived.invalid.length ? 'bad' : 'ok' },
        ...(unposted ? [{ label: 'Not yet in a posted journal batch', value: String(unposted), tone: 'warn' as const }] : []),
      ]} />

        {derived.invalid.length === 0 ? null : (
        <Block kicker="Reported, not dropped" title={`${derived.invalid.length} row${derived.invalid.length === 1 ? '' : 's'} could not be measured`}
          note="A row failing validation stays in the register and is reported. Dropping it would be a completeness assertion nobody made.">
            <SheetTable
              rows={derived.invalid}
              rowKey={(x) => x.obligation.id}
              noun="problems"
              columns={[
                { key: 'ref', header: 'Obligation Number', value: (x) => x.obligation.ref, cell: (x) => x.obligation.ref },
                { key: 'description', header: 'Description', value: (x) => x.obligation.description, cell: (x) => x.obligation.description },
                { key: 'reason', header: 'What is wrong', value: (x) => x.reason, cell: (x) => x.reason },
              ]}
            />
        </Block>
        )}

      {editable && newAroOpen && (
        <Block
          kicker="Transactions"
          title="New obligation and ARO asset"
          note={open
            ? `Posts into ${open.code} (${open.starts} to ${open.ends}). Cost, term and settlement on an existing obligation are on that row — open it and use the Transactions tabs.`
            : 'Open a period on Periods & close before posting a new obligation.'}
          actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => setNewAroOpen(false)}>Cancel</button>}
        >
          {open
            ? <NewObligationForm />
            : <p className="muted" style={{ margin: 0 }}>Open a period on Periods & close before posting.</p>}
        </Block>
      )}

      <Block
        kicker="Register"
        title={`${filtered.length} obligation${filtered.length === 1 ? '' : 's'}`}
        note={asAt
          ? `As at ${asAt.code} (${asAt.starts} to ${asAt.ends}). Opening is the prior fiscal year's closing, or the conversion opening in the first year. Existing and new columns are event-ledger amounts through this period. Post a new obligation here, or open a row for a cost adjustment, term adjustment or settlement. The Transactions step lists every posting in the open period. Accretion and amortization follow month-end allocation.`
          : 'Generate a fiscal calendar on Periods & close to view posted books as at a period.'}
        actions={
          <>
            {editable && (
              <button className="btn btn-primary btn-sm" onClick={() => setNewAroOpen((v) => !v)}>
                {newAroOpen ? 'Close new obligation' : 'New obligation'}
              </button>
            )}
            {editable && (
              <button className="btn btn-secondary btn-sm" onClick={() => setUi({ screen: 'transactions', tab: 'new', sub: '' })}>
                Transactions
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={exportXlsx}>Export to Excel</button>
            {sel.size > 0 && editable && (
              <button className="btn btn-primary btn-sm" onClick={() => setBulk({ key: 'site', value: '' })}>
                Bulk edit {sel.size} selected
              </button>
            )}
          </>
        }
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <div style={{ flex: '0 0 140px' }}>
            <div className="kicker" style={{ marginBottom: 4 }}>Fiscal year</div>
            <select className="input" value={asAt?.fiscalYear ?? ''} disabled={!fiscalYears.length}
              onChange={(e) => pickFy(Number(e.target.value))}>
              {fiscalYears.map((fy) => <option key={fy} value={fy}>FY{fy}</option>)}
            </select>
          </div>
          <div style={{ flex: '0 0 260px' }}>
            <div className="kicker" style={{ marginBottom: 4 }}>Period</div>
            <select className="input" value={asAt?.id ?? ''} disabled={!periodsInFy.length}
              onChange={(e) => setAsAtId(e.target.value)}>
              {periodsInFy.map((p) => (
                <option key={p.id} value={p.id}>{p.code} · {p.status} · {p.ends}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: '0 0 190px' }}>
            <div className="kicker" style={{ marginBottom: 4 }}>Column set</div>
            <select className="input" value={set} onChange={(e) => { setSet(e.target.value); setPage(0); }}>
              {Object.keys(columnSets).map((k) => <option key={k}>{k}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 220px' }}>
            <div className="kicker" style={{ marginBottom: 4 }}>Find in identity fields</div>
            <input className="input" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} placeholder="Obligation number, description, site, loaded columns…" />
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => {
            const name = `View ${views.length + 1} — ${set}`;
            setViews((v) => [...v, { name, set, filter, sort: sheet.sort, colFilters: sheet.filters }]);
          }}>Save this view</button>
          {views.map((v) => (
            <button key={v.name} className="btn btn-ghost btn-sm"
              onClick={() => {
                setSet(v.set); setFilter(v.filter); sheet.setSort(v.sort); sheet.setFilters(v.colFilters); setPage(0);
              }}>
              {v.name}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, fontSize: 11.5 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={allOnPageSelected}
              onChange={(e) => {
                const next = new Set(sel);
                pageRows.forEach((o) => (e.target.checked ? next.add(o.id) : next.delete(o.id)));
                setSel(next);
              }} />
            Select all on this page ({pageRows.length})
          </label>
          <button className="btn btn-ghost btn-sm" onClick={() => setSel(new Set(filtered.map((o) => o.id)))}>
            Select all {filtered.length} matching the filter
          </button>
          {sel.size > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setSel(new Set())}>Clear selection ({sel.size})</button>}
        </div>

        <div className="register-scroll" ref={scrollRef}>
          <table className="table register-grid" ref={gridRef}>
            <thead>
              <tr className="grp">
                <th className={groupToneClass('lead')} />
                <th className={groupToneClass('lead')} />
                {groupSpans(cols).map((g, i) => (
                  <th key={i} className={groupToneClass(g.group, true)} colSpan={g.span}>{g.group}</th>
                ))}
              </tr>
              <tr>
                <th className={groupToneClass('lead')} style={{ width: 30 }} />
                <th className={groupToneClass('lead')} style={{ width: 56 }} />
                {cols.map((c, i) => (
                  <SheetTh key={c.key} col={{ ...c, kind: c.kind === 'date' ? 'date' : c.kind === 'derived' || c.kind === 'number' ? 'number' : 'text', value: (o: Obligation) => cellRaw(o, c.key, derived, booksById.get(o.id), postedById.get(o.id), ulById.get(o.id), openTermById.get(o.id), tcaByObl.get(o.id)), header: c.label }}
                    sheet={sheet}
                    className={groupToneClass(c.group, i === 0 || cols[i - 1].group !== c.group)}
                    style={{ width: c.width, minWidth: c.width, maxWidth: c.width }} />
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((o, r) => {
                const d = derived.byId.get(o.id);
                const expanded = expandedId === o.id;
                return (
                  <React.Fragment key={o.id}>
                  <tr className={expanded ? 'is-expanded' : undefined}>
                    <td className={groupToneClass('lead')}>
                      <input type="checkbox" checked={sel.has(o.id)} onChange={(e) => {
                        const next = new Set(sel);
                        e.target.checked ? next.add(o.id) : next.delete(o.id);
                        setSel(next);
                      }} />
                    </td>
                    <td className={groupToneClass('lead')}>
                      <button type="button" className="btn btn-ghost btn-sm"
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : o.id)}>
                        {expanded ? 'Close' : 'Open'}
                      </button>
                    </td>
                    {cols.map((c, ci) => (
                      <td key={c.key} className={[
                        c.kind === 'derived' ? 'derived' : '',
                        groupToneClass(c.group, ci === 0 || cols[ci - 1].group !== c.group),
                      ].filter(Boolean).join(' ')}
                        style={{ textAlign: c.align, whiteSpace: 'nowrap' }}>
                        {c.key === 'totalUl'
                          ? (
                            <UlYmInputs
                              valueYears={typeof o.totalUl === 'number' ? o.totalUl : null}
                              disabled={!editable}
                              onCommit={(n) => {
                                const cur = typeof o.totalUl === 'number' ? o.totalUl : null;
                                if (n == null && cur == null) return;
                                if (n != null && cur != null && Math.abs(n - cur) < 1e-9) return;
                                editCell(o, 'totalUl', n == null ? '' : String(n));
                              }}
                            />
                          )
                          : c.key === 'remainingUl' || c.key === 'expiredUl' || c.key === '_open_term'
                          ? (
                            <span title={
                              c.key === 'remainingUl' ? 'Total UL minus expired UL as at this period, in years and leftover months. Expired rises as amortization is posted. Change Total UL on this ARO asset if remaining life should move.'
                                : c.key === 'expiredUl' ? 'Life already consumed as at this period, in years and leftover months. Conversion Expired UL is locked with opening balances.'
                                : c.key === '_open_term' ? 'Years from the start of this fiscal year to expected settlement as it stood that morning. The next fiscal year is one year shorter.'
                                  : undefined
                            }>
                              {formatUl(
                                c.key === 'expiredUl' ? ulById.get(o.id)?.expiredYears
                                  : c.key === '_open_term' ? openTermById.get(o.id)
                                    : ulById.get(o.id)?.remainingYears,
                                unit.calendarType,
                              )}
                              {c.key === 'remainingUl' && ulAlignmentPending(o) ? <Tag kind="warn">UL review</Tag> : null}
                            </span>
                          )
                          : c.key.startsWith('_tca_')
                          ? <span>{tcaJoinDisplay(c.key, tcaByObl.get(o.id))}</span>
                          : c.kind === 'derived'
                          ? <span title={c.key === '_fv' ? 'Future value at settlement, measured from estimated cost, dates, inflation, contingency and the discount curve.' : c.basis ? `Basis: ${c.basis}` : POSTED_KEYS.has(c.key) ? 'Event-ledger amounts through the selected period' : undefined}>{derivedCell(c.key, d, unit.currency, booksById.get(o.id), postedById.get(o.id))}</span>
                          : c.key === 'inProductiveUse'
                            ? (
                              <select
                                className="input" style={{ minHeight: 26, fontSize: 11.5, padding: '1px 4px', width: '100%' }}
                                data-cell={`${r}-${ci}`} disabled={!editable}
                                value={obligationField(o, c.key)}
                                title="When set to No, future changes of estimate hit operating expense instead of the ARO asset."
                                onKeyDown={(e) => onKeyDown(e, r, ci)}
                                onChange={(e) => editCell(o, c.key, e.target.value)}
                              >
                                {(c.options ?? []).map((opt) => <option key={opt} value={opt}>{opt || '—'}</option>)}
                              </select>
                            )
                          : c.kind === 'select'
                            ? (
                              <select
                                className="input" style={{ minHeight: 26, fontSize: 11.5, padding: '1px 4px', width: '100%' }}
                                data-cell={`${r}-${ci}`} disabled={!editable || (locked && isOpeningBalanceField(c.key))}
                                value={
                                  c.key === 'aroAssetClassCode' ? classCodeOf(typeof o.aroAssetClass === 'string' ? o.aroAssetClass : '', assetClasses)
                                    : c.key === 'aroAssetClassName' ? classNameOf(typeof o.aroAssetClass === 'string' ? o.aroAssetClass : '', assetClasses)
                                      : obligationField(o, c.key)
                                }
                                onKeyDown={(e) => onKeyDown(e, r, ci)}
                                onChange={(e) => editCell(o, c.key, e.target.value)}
                              >
                                {(c.options ?? []).map((opt) => <option key={opt} value={opt}>{opt || '—'}</option>)}
                              </select>
                            )
                            : (
                              <input
                                className={`input${c.kind === 'number' ? ' num' : ''}`} style={{ minHeight: 26, fontSize: 11.5, padding: '1px 4px', width: '100%' }}
                                data-cell={`${r}-${ci}`} disabled={!editable || (locked && isOpeningBalanceField(c.key))}
                                key={`${o.id}:${c.key}:${String(obligationField(o, c.key))}`}
                                defaultValue={c.kind === 'number' ? formatRegisterNumber(c.key, obligationField(o, c.key), unit.currency) : obligationField(o, c.key)}
                                onKeyDown={(e) => onKeyDown(e, r, ci)}
                                onPaste={(e) => onPaste(e, r, ci)}
                                onBlur={(e) => {
                                  const shown = c.kind === 'number'
                                    ? formatRegisterNumber(c.key, obligationField(o, c.key), unit.currency)
                                    : String(obligationField(o, c.key) ?? '');
                                  if (e.target.value !== shown) editCell(o, c.key, e.target.value);
                                }}
                              />
                            )}
                      </td>
                    ))}
                  </tr>
                  {expanded && asAt && (
                    <tr className="register-expand-row">
                      <td className="register-expand" colSpan={cols.length + 2}>
                        <div className="register-expand-pin">
                          <ObligationExpand
                            obligation={o}
                            fiscalYear={asAt.fiscalYear}
                            asAtPeriodId={asAt.id}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
            {set === 'Posted books' && (
              <tfoot>
                <tr>
                  <td className={groupToneClass('lead')} />
                  <td className={groupToneClass('lead')} />
                  {cols.map((c, i) => (
                    <td key={c.key} className={[
                      c.kind === 'derived' ? 'derived' : '',
                      groupToneClass(c.group, i === 0 || cols[i - 1].group !== c.group),
                    ].filter(Boolean).join(' ')}
                      style={{ textAlign: c.align, whiteSpace: 'nowrap' }}>
                      {c.key === 'ref'
                        ? 'Total'
                        : POSTED_KEYS.has(c.key)
                          ? currency(filtered.reduce((s, o) => s + (postedAmount(c.key, postedById.get(o.id)) ?? 0), 0), unit.currency)
                          : c.key === '_fv'
                            ? currency(filtered.reduce((s, o) => {
                                const fv = derived.byId.get(o.id)?.fv;
                                return s + (typeof fv === 'number' && Number.isFinite(fv) ? fv : 0);
                              }, 0), unit.currency)
                            : ''}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, fontSize: 11.5 }}>
          <button className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span className="muted">Page {page + 1} of {pages}</span>
          <button className="btn btn-secondary btn-sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
          <SheetStatus sheet={sheet} noun="obligations" />
          <span className="muted" style={{ marginLeft: 'auto' }}>
            Derived cells are tinted. Posted books follow the event ledger through the selected period. Open a row for schedules, calculation details, and to post a cost or term adjustment or a settlement. Open a calculation-details line to see the events in that total. Paste a block from Excel into any editable cell.
          </span>
        </div>
      </Block>

      {bulk && (
        <Block kicker="Bulk edit" title={`${sel.size} obligations, one logged change`}
          note="A bulk edit is written as a single change with the counts of what was written and what was refused. A field held by a revision is refused by name.">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '0 0 200px' }}>
              <div className="kicker" style={{ marginBottom: 4 }}>Field</div>
              <select className="input" value={bulk.key} onChange={(e) => setBulk({ ...bulk, key: e.target.value })}>
                {allColumns.filter((c) => c.kind !== 'derived').map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <div className="kicker" style={{ marginBottom: 4 }}>New value</div>
              {(() => {
                const col = allColumns.find((c) => c.key === bulk.key) ?? COLUMNS[0];
                return col.kind === 'select'
                  ? <select className="input" value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })}>
                      {(col.options ?? []).map((o) => <option key={o} value={o}>{o || '—'}</option>)}
                    </select>
                  : <input className="input" value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })} />;
              })()}
            </div>
            <button className="btn btn-primary btn-sm" onClick={applyBulk}>Apply to {sel.size}</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setBulk(null)}>Cancel</button>
          </div>
        </Block>
      )}

      {pasteReport && (
        <Block kicker="Reported cell by cell" title="What took and what did not"
          actions={<button className="btn btn-secondary btn-sm" onClick={() => setPasteReport(null)}>Dismiss</button>}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
            {pasteReport.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </Block>
      )}
    </>
  );
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function groupSpans(cols: ColDef[]) {
  const out: { group: string; span: number }[] = [];
  for (const c of cols) {
    const last = out[out.length - 1];
    if (last && last.group === c.group) last.span += 1;
    else out.push({ group: c.group, span: 1 });
  }
  return out;
}

function derivedCell(key: string, d: any, code: string, books?: AssetBooks, posted?: RegisterBooks): string {
  const postedAmt = postedAmount(key, posted);
  if (postedAmt !== undefined) return currency(postedAmt, code);
  if (key === '_arc_gross') return books ? currency(books.gross, code) : '—';
  if (key === '_arc_accum') return books ? currency(books.accum, code) : '—';
  if (key === '_arc_nbv') return books ? currency(books.nbv, code) : '—';
  if (!d) return '—';
  switch (key) {
    case '_direct': return currency(d.direct, code);
    case '_cost': return currency(d.cost, code);
    case '_cce': return currency(d.cce, code);
    case '_fv': return currency(d.fv, code);
    case '_term': return `${num(d.curveTerm)}${d.beyond ? ' ⚑' : ''}`;
    case '_rate': return pct(d.rate, 4);
    case '_pv': return currency(d.pv, code);
    case '_cost_eff': return currency(d.bridge.costEffect, code);
    case '_timing_eff': return currency(d.bridge.timingEffect, code);
    case '_rate_eff': return currency(d.bridge.rateEffect, code);
    case '_infl_eff': return currency(d.bridge.inflEffect, code);
    case '_movement': return currency(d.bridge.movement, code);
    default: return '—';
  }
}

const MONEY_FIELDS = new Set(['openingFv', 'openingArc', 'openingAccumAmort']);

function formatRegisterNumber(key: string, raw: unknown, code: string): string {
  if (raw === '' || raw === null || raw === undefined) return '';
  const n = typeof raw === 'number' ? raw : parseNumber(String(raw));
  if (!Number.isFinite(n)) return String(raw ?? '');
  return MONEY_FIELDS.has(key) ? currency(n, code) : num(n);
}

function postedAmount(key: string, books?: RegisterBooks): number | undefined {
  if (!books) return POSTED_KEYS.has(key) ? 0 : undefined;
  switch (key) {
    case '_ob_open': return books.openingProvision;
    case '_ob_settle': return books.settlement;
    case '_ob_accr_ex': return books.accretionExisting;
    case '_ob_cost': return books.costAdjustments;
    case '_ob_term': return books.termAdjustments;
    case '_ob_writeoff': return books.writeOffs;
    case '_ob_mass': return books.massUpdate;
    case '_ob_new': return books.newAro;
    case '_ob_accr_new': return books.accretionNew;
    case '_ob_fx': return books.fx;
    case '_ob_close': return books.closingProvision;
    case '_arc_open': return books.openingArc;
    case '_arc_add': return books.arcAdditions;
    case '_arc_amort': return books.amortization;
    case '_arc_close': return books.closingArc;
    default: return undefined;
  }
}

function tcaJoinRaw(key: string, tca?: TcaAsset): string {
  if (!tca) return '';
  if (key === '_tca_description') return tca.description;
  if (key === '_tca_class') return tca.assetClass;
  if (key === '_tca_acq') return tca.acquisitionDate;
  if (key === '_tca_site') return tca.site;
  if (key === '_tca_status') return tcaAssetStatusOf(tca);
  if (key === '_tca_scope') return tca.scope;
  if (key === '_tca_reason') return tca.scopeReason;
  if (key.startsWith('_tca_col:')) return tca.columns[key.slice('_tca_col:'.length)] ?? '';
  return '';
}

function tcaJoinDisplay(key: string, tca?: TcaAsset): string {
  return tcaJoinRaw(key, tca) || '—';
}

function cellRaw(o: Obligation, key: string, derived: any, books?: AssetBooks, posted?: RegisterBooks, life?: { totalYears: number | null; expiredYears: number | null; remainingYears: number | null }, openTerm?: number | null, tca?: TcaAsset) {
  if (key.startsWith('_tca_')) return tcaJoinRaw(key, tca);
  const postedAmt = postedAmount(key, posted);
  if (postedAmt !== undefined) return postedAmt;
  if (key === 'remainingUl') return life?.remainingYears ?? remainingUl(o) ?? '';
  if (key === 'expiredUl') return life?.expiredYears ?? (typeof o.expiredUl === 'number' ? o.expiredUl : '');
  if (key === 'totalUl') return life?.totalYears ?? (typeof o.totalUl === 'number' ? o.totalUl : '');
  if (key === '_open_term') return openTerm ?? '';
  if (key === '_arc_gross') return books?.gross ?? 0;
  if (key === '_arc_accum') return books?.accum ?? 0;
  if (key === '_arc_nbv') return books?.nbv ?? 0;
  if (key.startsWith('_')) {
    const d = derived?.byId.get(o.id);
    if (!d) return 0;
    const map: Record<string, number> = {
      _direct: d.direct, _cost: d.cost, _cce: d.cce, _fv: d.fv, _term: d.curveTerm,
      _rate: d.rate, _pv: d.pv, _cost_eff: d.bridge.costEffect, _timing_eff: d.bridge.timingEffect,
      _rate_eff: d.bridge.rateEffect, _infl_eff: d.bridge.inflEffect, _movement: d.bridge.movement,
    };
    return map[key] ?? 0;
  }
  if (extraColumnName(key)) return obligationField(o, key);
  return o[key as keyof Obligation] as string;
}

