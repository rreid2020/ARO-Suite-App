/**
 * Excel-style column filter/sort on spreadsheet tables.
 *
 * One menu per header: sort, a condition, search-in-list, and unique-value
 * checkboxes. Filter state is view-local — it does not rewrite the records.
 */

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  applySheet, condLabels, emptyFilter, isFilterActive, sortLabels, uniqueForColumn,
  SheetCond, SheetFilter, SheetKind, SheetSort, SheetSpec, valueKey,
} from '../sheet';

export interface SheetColumn<T> extends SheetSpec<T> {
  header: React.ReactNode;
  kind?: SheetKind;
  cell: (row: T) => React.ReactNode;
  thClassName?: string;
  tdClassName?: string | ((row: T) => string | undefined);
  thStyle?: React.CSSProperties;
  tdStyle?: React.CSSProperties | ((row: T) => React.CSSProperties);
  width?: number | string;
}

export interface SheetHandle<T> {
  rows: T[];
  source: T[];
  filters: Record<string, SheetFilter>;
  setFilters: React.Dispatch<React.SetStateAction<Record<string, SheetFilter>>>;
  sort: SheetSort | null;
  setSort: React.Dispatch<React.SetStateAction<SheetSort | null>>;
  cols: SheetSpec<T>[];
  clear: () => void;
  filtered: boolean;
  resorted: boolean;
}

export function useSheet<T>(
  rows: T[],
  cols: SheetSpec<T>[],
  defaultSort?: SheetSort | null,
): SheetHandle<T> {
  const [filters, setFilters] = useState<Record<string, SheetFilter>>({});
  const [sort, setSort] = useState<SheetSort | null>(defaultSort ?? null);

  const visible = useMemo(
    () => applySheet(rows, cols, filters, sort),
    [rows, cols, filters, sort],
  );

  const filtered = Object.values(filters).some(isFilterActive);
  const resorted = !!sort && (!defaultSort || sort.key !== defaultSort.key || sort.dir !== defaultSort.dir);

  const clear = () => {
    setFilters({});
    setSort(defaultSort ?? null);
  };

  return { rows: visible, source: rows, filters, setFilters, sort, setSort, cols, clear, filtered, resorted };
}

export function SheetTh<T>({
  col, sheet, className, style, width,
}: {
  col: SheetSpec<T> & { header?: React.ReactNode };
  sheet: SheetHandle<T>;
  className?: string;
  style?: React.CSSProperties;
  width?: number | string;
}) {
  const filterable = !!col.value;
  const active = isFilterActive(sheet.filters[col.key]);
  const sorted = sheet.sort?.key === col.key ? sheet.sort.dir : 0;
  const header = 'header' in col ? col.header : col.key;

  if (!filterable) {
    return <th className={className} style={{ ...style, width }}>{header}</th>;
  }

  return (
    <th className={`sheet-th ${className ?? ''}`} style={{ ...style, width }}>
      <div className="sheet-th-inner">
        <span className="sheet-th-label">{header}</span>
        {sorted !== 0 && <span className="sheet-th-sort" aria-hidden>{sorted === 1 ? '▲' : '▼'}</span>}
      <SheetMenu col={col} sheet={sheet} active={active} label={typeof header === 'string' ? header : col.key} />
      </div>
    </th>
  );
}

function SheetMenu<T>({
  col, sheet, active, label,
}: {
  col: SheetSpec<T>;
  sheet: SheetHandle<T>;
  active: boolean;
  label: string;
}) {
  const uid = useId();
  const panelId = `sheet-filter-${uid.replace(/:/g, '')}`;
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const kind: SheetKind = col.kind ?? 'text';
  const filter = sheet.filters[col.key] ?? emptyFilter();
  const labels = sortLabels(kind);

  const uniques = useMemo(
    () => uniqueForColumn(sheet.source, sheet.cols, sheet.filters, col.key),
    [sheet.source, sheet.cols, sheet.filters, col.key],
  );

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return uniques;
    return uniques.filter((u) => u.label.toLowerCase().includes(q));
  }, [uniques, search]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onPtr = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPtr);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPtr);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !panelRef.current || !btnRef.current) return;
    const panel = panelRef.current;
    const r = btnRef.current.getBoundingClientRect();
    const width = 264;
    const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
    let top = r.bottom + 4;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    const box = panel.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8) {
      top = Math.max(8, r.top - box.height - 4);
      panel.style.top = `${top}px`;
    }
  }, [open, shown.length, filter.cond.op]);

  const setFilter = (next: SheetFilter) => {
    sheet.setFilters((prev) => {
      const copy = { ...prev };
      if (!isFilterActive(next)) delete copy[col.key];
      else copy[col.key] = next;
      return copy;
    });
  };

  const selected = filter.selected;
  const allShownChecked = shown.length > 0 && shown.every((u) => selected === null || selected.includes(u.key));
  const someShownChecked = shown.some((u) => selected === null || selected.includes(u.key));

  const toggleAllShown = (on: boolean) => {
    if (on) {
      if (!search.trim()) {
        setFilter({ ...filter, selected: null });
        return;
      }
      const next = new Set(selected ?? uniques.map((u) => u.key));
      shown.forEach((u) => next.add(u.key));
      setFilter({ ...filter, selected: next.size === uniques.length ? null : [...next] });
    } else if (!search.trim()) {
      setFilter({ ...filter, selected: [] });
    } else {
      const remove = new Set(shown.map((u) => u.key));
      const base = selected ?? uniques.map((u) => u.key);
      setFilter({ ...filter, selected: base.filter((k) => !remove.has(k)) });
    }
  };

  const toggleOne = (key: string, on: boolean) => {
    const current = selected ?? uniques.map((u) => u.key);
    const next = on ? [...new Set([...current, key])] : current.filter((k) => k !== key);
    setFilter({ ...filter, selected: next.length === uniques.length ? null : next });
  };

  const applyCond = (cond: SheetCond) => setFilter({ ...filter, cond });

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sheet-filter-btn${active ? ' is-on' : ''}`}
        aria-label={`Filter ${label}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>▾</span>
      </button>
      {open && createPortal(
        <div ref={panelRef} id={panelId} className="sheet-filter" role="dialog" aria-label="Column filter">
          <button type="button" className={`sheet-filter-cmd${sheet.sort?.key === col.key && sheet.sort.dir === 1 ? ' is-current' : ''}`}
            onClick={() => { sheet.setSort({ key: col.key, dir: 1 }); setOpen(false); }}>
            {labels.asc}
          </button>
          <button type="button" className={`sheet-filter-cmd${sheet.sort?.key === col.key && sheet.sort.dir === -1 ? ' is-current' : ''}`}
            onClick={() => { sheet.setSort({ key: col.key, dir: -1 }); setOpen(false); }}>
            {labels.desc}
          </button>
          {sheet.sort?.key === col.key && (
            <button type="button" className="sheet-filter-cmd" onClick={() => { sheet.setSort(null); setOpen(false); }}>
              Clear sort
            </button>
          )}
          <div className="sheet-filter-rule" />
          <label className="sheet-filter-field">
            <span>Condition</span>
            <select className="input" value={filter.cond.op}
              onChange={(e) => applyCond({ ...filter.cond, op: e.target.value as SheetCond['op'] })}>
              {condLabels(kind).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          {filter.cond.op !== 'any' && (
            <input className="input" value={filter.cond.a} placeholder={kind === 'date' ? 'YYYY-MM-DD' : 'Value'}
              onChange={(e) => applyCond({ ...filter.cond, a: e.target.value })} />
          )}
          {filter.cond.op === 'between' && (
            <input className="input" value={filter.cond.b} placeholder={kind === 'date' ? 'YYYY-MM-DD' : 'And'}
              onChange={(e) => applyCond({ ...filter.cond, b: e.target.value })} />
          )}
          <div className="sheet-filter-rule" />
          <input className="input" value={search} placeholder="Search values"
            onChange={(e) => setSearch(e.target.value)} />
          <label className="sheet-filter-check">
            <input type="checkbox" checked={allShownChecked}
              ref={(el) => { if (el) el.indeterminate = someShownChecked && !allShownChecked; }}
              onChange={(e) => toggleAllShown(e.target.checked)} />
            Select all
          </label>
          <div className="sheet-filter-list">
            {shown.length === 0 ? (
              <div className="muted" style={{ padding: '6px 4px', fontSize: 12 }}>No values match the search.</div>
            ) : shown.map((u) => (
              <label key={u.key || '(blank)'} className="sheet-filter-check">
                <input type="checkbox"
                  checked={selected === null || selected.includes(u.key)}
                  onChange={(e) => toggleOne(u.key, e.target.checked)} />
                <span className="sheet-filter-val">{u.label}</span>
                <span className="muted">{u.count}</span>
              </label>
            ))}
          </div>
          <div className="sheet-filter-rule" />
          <button type="button" className="sheet-filter-cmd" disabled={!active}
            onClick={() => { setFilter(emptyFilter()); setSearch(''); }}>
            Clear filter from this column
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

export function SheetStatus<T>({ sheet, noun = 'rows' }: { sheet: SheetHandle<T>; noun?: string }) {
  if (!sheet.filtered && !sheet.resorted) return null;
  return (
    <div className="sheet-status">
      Showing {sheet.rows.length} of {sheet.source.length} {noun}
      {sheet.sort && sheet.resorted && <> · sorted {sheet.sort.dir === 1 ? 'ascending' : 'descending'}</>}
      <button type="button" className="btn btn-ghost btn-sm" onClick={sheet.clear}>Clear sort &amp; filters</button>
    </div>
  );
}

export function SheetTable<T>({
  rows, rowKey, columns, empty, leading, groupHeader, footer, tableRef, defaultSort, noun, rowClassName, expand,
}: {
  rows: T[];
  rowKey: (row: T) => string;
  columns: SheetColumn<T>[];
  empty?: React.ReactNode;
  leading?: { header: React.ReactNode; cell: (row: T) => React.ReactNode; width?: number | string };
  groupHeader?: React.ReactNode;
  footer?: React.ReactNode;
  tableRef?: React.Ref<HTMLTableElement>;
  defaultSort?: SheetSort | null;
  noun?: string;
  rowClassName?: (row: T) => string | undefined;
  expand?: (row: T) => React.ReactNode;
}) {
  const specs = useMemo(() => columns.map((c) => ({ key: c.key, kind: c.kind, value: c.value })), [columns]);
  const sheet = useSheet(rows, specs, defaultSort);
  const colSpan = (leading ? 1 : 0) + columns.length;

  return (
    <>
      <div className="scroll-x">
        <table className="table" ref={tableRef}>
          <thead>
            {groupHeader}
            <tr>
              {leading && <th style={{ width: leading.width }}>{leading.header}</th>}
              {columns.map((c) => (
                <SheetTh key={c.key} col={c} sheet={sheet} className={c.thClassName} style={c.thStyle} width={c.width} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="muted">
                  {empty ?? (sheet.filtered ? 'No rows match the current filter.' : 'Nothing to list.')}
                </td>
              </tr>
            ) : sheet.rows.map((row) => {
              const extra = expand?.(row);
              const expanded = extra != null && extra !== false;
              const className = [expanded ? 'is-expanded' : '', rowClassName?.(row)].filter(Boolean).join(' ') || undefined;
              const cells = (
                <tr className={className}>
                  {leading && <td>{leading.cell(row)}</td>}
                  {columns.map((c) => {
                    const tdClass = typeof c.tdClassName === 'function' ? c.tdClassName(row) : c.tdClassName;
                    const tdStyle = typeof c.tdStyle === 'function' ? c.tdStyle(row) : c.tdStyle;
                    return <td key={c.key} className={tdClass} style={tdStyle}>{c.cell(row)}</td>;
                  })}
                </tr>
              );
              if (!expanded) return <React.Fragment key={rowKey(row)}>{cells}</React.Fragment>;
              return (
                <React.Fragment key={rowKey(row)}>
                  {cells}
                  <tr className="sheet-expand-row">
                    <td className="sheet-expand" colSpan={colSpan}>{extra}</td>
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
          {footer && <tfoot>{footer}</tfoot>}
        </table>
      </div>
      <SheetStatus sheet={sheet} noun={noun} />
    </>
  );
}

export function displayKey(raw: unknown): string {
  return valueKey(raw);
}
