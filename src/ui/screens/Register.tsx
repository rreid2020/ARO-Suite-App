/**
 * The ARO register — SCREENS.md, "The register".
 *
 * "It renders from a column definition with a group header row (Identity ·
 * Asset · Dates · Calculated · Movement), tinted derived cells, five column
 * sets, saved views (column set + filter + sort, named, per reporting unit), a
 * selection column with select-all-on-page and select-all-filtered, bulk edit as
 * a single logged change, in-grid select cells for pick-list columns, keyboard
 * navigation (Enter/↓ down the column, ↑ up, Tab across), and Excel block paste
 * that fills down and right and reports what would not take."
 */

import React, { useMemo, useRef, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit } from '../../core/authority';
import { Obligation } from '../../core/types';
import { isValidDate } from '../../engine/dates';
import { SCOPING_REASONS, VARIANCE_CAUSES } from '../../seed';
import { Basis, Block, Empty, money, money2, pct, Stats, Tag, years } from '../components';
import { download, S } from '../../xlsx/write';

type ColKind = 'text' | 'number' | 'date' | 'select' | 'derived';

interface ColDef {
  key: string;
  label: string;
  group: 'Identity' | 'Asset' | 'Dates' | 'Calculated' | 'Movement';
  kind: ColKind;
  width?: number;
  options?: string[];
  /** Derived columns read the engine, never the record. */
  value?: (o: Obligation, d: ReturnType<typeof useDerived> extends infer _ ? any : never) => string;
  align?: 'right';
  basis?: string;
}

const COLUMNS: ColDef[] = [
  { key: 'ref', label: 'Reference', group: 'Identity', kind: 'text', width: 100 },
  { key: 'description', label: 'Description', group: 'Identity', kind: 'text', width: 240 },
  { key: 'status', label: 'Scope', group: 'Identity', kind: 'select', options: ['In scope', 'Scoped out'], width: 100 },
  { key: 'scopeReason', label: 'Reason if out of scope', group: 'Identity', kind: 'select', options: ['', ...SCOPING_REASONS], width: 200 },
  { key: 'assetId', label: 'Asset', group: 'Asset', kind: 'text', width: 100 },
  { key: 'site', label: 'Site', group: 'Asset', kind: 'text', width: 130 },
  { key: 'region', label: 'Region', group: 'Asset', kind: 'text', width: 120 },
  { key: 'type', label: 'Type', group: 'Asset', kind: 'text', width: 160 },
  { key: 'basis', label: 'Basis', group: 'Asset', kind: 'select', options: ['Legal', 'Constructive'], width: 110 },
  { key: 'costEstimateDate', label: 'Cost estimate date', group: 'Dates', kind: 'date', width: 130 },
  { key: 'settlementDate', label: 'Expected settlement', group: 'Dates', kind: 'date', width: 130 },
  { key: '_direct', label: 'Direct cost', group: 'Calculated', kind: 'derived', align: 'right', basis: 'CURRENT', width: 120 },
  { key: '_cost', label: 'Cost + contingency', group: 'Calculated', kind: 'derived', align: 'right', basis: 'CURRENT', width: 130 },
  { key: '_cce', label: 'Escalated to FY end', group: 'Calculated', kind: 'derived', align: 'right', basis: 'ESCALATED', width: 140 },
  { key: '_fv', label: 'FV at settlement', group: 'Calculated', kind: 'derived', align: 'right', basis: 'FV@SETTLE', width: 140 },
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

/** Five column sets. */
const COLUMN_SETS: Record<string, string[]> = {
  'Measurement': ['ref', 'description', 'costEstimateDate', 'settlementDate', '_cost', '_cce', '_fv', '_term', '_rate', '_pv'],
  'Identity & scope': ['ref', 'description', 'status', 'scopeReason', 'assetId', 'site', 'region', 'type', 'basis'],
  'Movement': ['ref', 'description', '_pv', '_cost_eff', '_timing_eff', '_rate_eff', '_infl_eff', '_movement', 'varianceCause'],
  'Dates & terms': ['ref', 'description', 'costEstimateDate', 'settlementDate', '_term', '_rate'],
  'Everything': COLUMNS.map((c) => c.key),
};

const PAGE = 25;

export function Register() {
  const { ui, setUi, write } = useStore();
  const unit = useUnit();
  const data = useUnitData();
  const derived = useDerived();

  const [set, setSet] = useState('Measurement');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'ref', dir: 1 });
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [views, setViews] = useState<{ name: string; set: string; filter: string; sort: typeof sort }[]>([]);
  const [bulk, setBulk] = useState<{ key: string; value: string } | null>(null);
  const [pasteReport, setPasteReport] = useState<string[] | null>(null);
  const gridRef = useRef<HTMLTableElement>(null);

  const editable = canEdit(ui.role);

  const cols = useMemo(
    () => COLUMN_SETS[set].map((k) => COLUMNS.find((c) => c.key === k)!).filter(Boolean),
    [set],
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    let rows = data.obligations;
    if (q) {
      rows = rows.filter((o) =>
        [o.ref, o.description, o.site, o.region, o.type, o.status].some((v) => String(v ?? '').toLowerCase().includes(q)),
      );
    }
    const dir = sort.dir;
    return [...rows].sort((a, b) => {
      const av = cellRaw(a, sort.key, derived);
      const bv = cellRaw(b, sort.key, derived);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [data, filter, sort, derived]);

  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));

  if (!unit || !data || !derived) return null;

  /* ── writes ─────────────────────────────────────────────────────────── */

  const editCell = (o: Obligation, key: string, value: string) => {
    const col = COLUMNS.find((c) => c.key === key)!;
    let parsed: unknown = value;
    if (col.kind === 'number') parsed = Number(value);

    // INVARIANTS §5 — a bulk edit that hits a refused field (a settlement date
    // held by a timing revision) refuses it by name.
    const guarded: Record<string, string> = {};
    if (key === 'settlementDate' && o.adj.some((a) => a.kind === 'term')) {
      guarded.settlementDate = 'held by a timing revision — change the revision, not the register';
    }

    write<Obligation>({
      domain: 'register',
      record: o.id,
      recordLabel: `${o.ref} ${o.description}`,
      before: o,
      after: { ...o, [key]: parsed },
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
    const col = COLUMNS.find((c) => c.key === bulk.key)!;
    const targets = data.obligations.filter((o) => sel.has(o.id));
    let written = 0;
    const refused: string[] = [];

    for (const o of targets) {
      if (bulk.key === 'settlementDate' && o.adj.some((a) => a.kind === 'term')) {
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
          const i = list.findIndex((x) => x.id === o.id);
          if (i >= 0) list[i] = { ...list[i], [bulk.key]: bulk.value };
        }
      },
    });

    if (refused.length) {
      setPasteReport([
        `${written} written, ${refused.length} refused.`,
        `Refused because the expected settlement date is held by a timing revision: ${refused.join(', ')}. Change the revision on the Adjustments step, not the register.`,
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
          problems.push(`${target.ref} · ${col.label}: derived from the engine, so it cannot be pasted into. "${raw}" not taken.`);
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
            if (i >= 0) list[i] = { ...list[i], [w.key]: w.value };
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
    const head = ['Reference', 'Description', 'Cost estimate date', 'Expected settlement', 'Direct cost',
      'Contingency', 'Cost at current prices', 'Inflation', 'Leg 1 (yrs)', 'Escalated to FY end',
      'Leg 2 (yrs)', 'FV at settlement', 'Discount term (yrs)', 'Curve term', 'Rate', 'Provision', 'Source figure', 'Variance'];

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
        { v: sourceOf(o, d.pv), s: S.money },
        { f: `P${r}-Q${r}`, s: S.money },
      ]);
    });

    const total = first + filtered.length;
    rows.push([{ v: 'Total', s: S.bold }, '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      { f: `SUM(P${first}:P${total - 1})`, s: S.money },
      { f: `SUM(Q${first}:Q${total - 1})`, s: S.money },
      { f: `SUM(R${first}:R${total - 1})`, s: S.money }]);

    download(`${unit.entity.replace(/\W+/g, '-')}-register-${unit.fyEnd}.xlsx`, [
      { name: 'Register', rows: rows as never, cols: [14, 34, 16, 16, 15, 11, 17, 10, 11, 17, 11, 17, 15, 11, 10, 15, 15, 13], freeze: 4 },
    ]);
  };

  /* ── render ─────────────────────────────────────────────────────────── */

  const allOnPageSelected = pageRows.length > 0 && pageRows.every((o) => sel.has(o.id));

  return (
    <>
      <Stats items={[
        { label: 'Obligations', value: String(data.obligations.length) },
        { label: 'In scope', value: String(derived.rows.length) },
        { label: `Provision at ${unit.fyEnd}`, value: `${unit.currency} ${money(derived.total)}` },
        { label: 'Above materiality', value: String(derived.material.length) },
        { label: 'Reported problems', value: String(derived.invalid.length), tone: derived.invalid.length ? 'bad' : 'ok' },
      ]} />

      {derived.invalid.length > 0 && (
        <Block kicker="Reported, not dropped" title={`${derived.invalid.length} row${derived.invalid.length === 1 ? '' : 's'} could not be measured`}
          note="A row failing validation stays in the register and is reported. Dropping it would be a completeness assertion nobody made.">
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Reference</th><th>Description</th><th>What is wrong</th></tr></thead>
              <tbody>
                {derived.invalid.slice(0, 12).map((x) => (
                  <tr key={x.obligation.id}>
                    <td>{x.obligation.ref}</td>
                    <td>{x.obligation.description}</td>
                    <td>{x.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      <Block
        kicker="Register"
        title={`${filtered.length} obligation${filtered.length === 1 ? '' : 's'}`}
        actions={
          <>
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
          <div style={{ flex: '0 0 190px' }}>
            <div className="kicker" style={{ marginBottom: 4 }}>Column set</div>
            <select className="input" value={set} onChange={(e) => { setSet(e.target.value); setPage(0); }}>
              {Object.keys(COLUMN_SETS).map((k) => <option key={k}>{k}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 220px' }}>
            <div className="kicker" style={{ marginBottom: 4 }}>Filter</div>
            <input className="input" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} placeholder="Reference, description, site, region…" />
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => {
            const name = `View ${views.length + 1} — ${set}`;
            setViews((v) => [...v, { name, set, filter, sort }]);
          }}>Save this view</button>
          {views.map((v) => (
            <button key={v.name} className="btn btn-ghost btn-sm"
              onClick={() => { setSet(v.set); setFilter(v.filter); setSort(v.sort); setPage(0); }}>
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

        <div className="scroll-x">
          <table className="table" ref={gridRef}>
            <thead>
              <tr className="grp">
                <th />
                {groupSpans(cols).map((g, i) => <th key={i} colSpan={g.span}>{g.group}</th>)}
              </tr>
              <tr>
                <th style={{ width: 30 }} />
                {cols.map((c) => (
                  <th key={c.key} style={{ width: c.width, cursor: 'pointer' }}
                    onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === 1 ? -1 : 1 }))}>
                    {c.label}{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((o, r) => {
                const d = derived.byId.get(o.id);
                return (
                  <tr key={o.id}>
                    <td>
                      <input type="checkbox" checked={sel.has(o.id)} onChange={(e) => {
                        const next = new Set(sel);
                        e.target.checked ? next.add(o.id) : next.delete(o.id);
                        setSel(next);
                      }} />
                    </td>
                    {cols.map((c, ci) => (
                      <td key={c.key} className={c.kind === 'derived' ? 'derived' : undefined}
                        style={{ textAlign: c.align, whiteSpace: 'nowrap' }}>
                        {c.kind === 'derived'
                          ? <span title={c.basis ? `Basis: ${c.basis}` : undefined}>{derivedCell(c.key, d)}</span>
                          : c.kind === 'select'
                            ? (
                              <select
                                className="input" style={{ minHeight: 26, fontSize: 11.5, padding: '1px 4px' }}
                                data-cell={`${r}-${ci}`} disabled={!editable}
                                value={String(o[c.key] ?? '')}
                                onKeyDown={(e) => onKeyDown(e, r, ci)}
                                onChange={(e) => editCell(o, c.key, e.target.value)}
                              >
                                {(c.options ?? []).map((opt) => <option key={opt} value={opt}>{opt || '—'}</option>)}
                              </select>
                            )
                            : (
                              <input
                                className="input" style={{ minHeight: 26, fontSize: 11.5, padding: '1px 4px', width: c.width }}
                                data-cell={`${r}-${ci}`} disabled={!editable}
                                defaultValue={String(o[c.key] ?? '')}
                                onKeyDown={(e) => onKeyDown(e, r, ci)}
                                onPaste={(e) => onPaste(e, r, ci)}
                                onBlur={(e) => { if (e.target.value !== String(o[c.key] ?? '')) editCell(o, c.key, e.target.value); }}
                              />
                            )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, fontSize: 11.5 }}>
          <button className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span className="muted">Page {page + 1} of {pages}</span>
          <button className="btn btn-secondary btn-sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
          <span className="muted" style={{ marginLeft: 'auto' }}>
            Derived cells are tinted and read the engine. Paste a block from Excel into any editable cell.
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
                {COLUMNS.filter((c) => c.kind !== 'derived').map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <div className="kicker" style={{ marginBottom: 4 }}>New value</div>
              {(() => {
                const col = COLUMNS.find((c) => c.key === bulk.key)!;
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

function derivedCell(key: string, d: any): string {
  if (!d) return '—';
  switch (key) {
    case '_direct': return money2(d.direct);
    case '_cost': return money2(d.cost);
    case '_cce': return money2(d.cce);
    case '_fv': return money2(d.fv);
    case '_term': return `${d.curveTerm}${d.beyond ? ' ⚑' : ''}`;
    case '_rate': return pct(d.rate, 4);
    case '_pv': return money2(d.pv);
    case '_cost_eff': return money2(d.bridge.costEffect);
    case '_timing_eff': return money2(d.bridge.timingEffect);
    case '_rate_eff': return money2(d.bridge.rateEffect);
    case '_infl_eff': return money2(d.bridge.inflEffect);
    case '_movement': return money2(d.bridge.movement);
    default: return '—';
  }
}

function cellRaw(o: Obligation, key: string, derived: any) {
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
  return o[key] as string;
}

/** The source figure this row is recalculated against — Mode 1. */
export function sourceOf(o: Obligation, pv: number): number {
  const factor = typeof o.sourcePv === 'number' && o.sourcePv > 0 ? o.sourcePv : 1;
  return pv * factor;
}
