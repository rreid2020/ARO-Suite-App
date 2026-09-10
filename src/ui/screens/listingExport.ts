/**
 * Excel workbooks for Opening register and ARO scoping listings.
 * Combined sheets keep the same section headings as the on-screen groups.
 */

import type { ReactNode } from 'react';
import { isValidDate } from '../../engine/dates';
import type { SheetKind } from '../sheet';
import { columnGroupSpans } from '../groupTone';
import { Cell, Sheet, S } from '../../xlsx/write';

export interface ListingExportCol<T> {
  key: string;
  header: ReactNode;
  group?: string;
  kind?: SheetKind;
  value?: (row: T) => unknown;
}

function headerText(header: ReactNode, fallback: string): string {
  return typeof header === 'string' ? header : fallback;
}

function exportCell(raw: unknown, kind: SheetKind | undefined, money: boolean): Cell {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return money ? { v: raw, s: S.money } : raw;
  }
  const text = String(raw);
  if ((kind === 'date' || isValidDate(text)) && isValidDate(text)) {
    return { v: text, t: 'd' };
  }
  return text;
}

export function listingSheet<T>(opts: {
  name: string;
  title: string;
  columns: ListingExportCol<T>[];
  rows: T[];
  totals?: Record<string, number>;
}): Sheet {
  const { name, title, columns, rows, totals } = opts;
  const groups = columnGroupSpans(columns.map((c) => c.group));
  const showGroups = columns.some((c) => c.group);
  const merges: Sheet['merges'] = [];
  const head: Cell[][] = [[{ v: title, s: S.title }]];
  merges.push({ r1: 0, c1: 0, r2: 0, c2: Math.max(0, columns.length - 1) });

  if (showGroups) {
    const groupRow: Cell[] = columns.map(() => '');
    let col = 0;
    for (const g of groups) {
      groupRow[col] = { v: g.group, s: S.head };
      if (g.span > 1) merges.push({ r1: 1, c1: col, r2: 1, c2: col + g.span - 1 });
      col += g.span;
    }
    head.push(groupRow);
  }

  head.push(columns.map((c) => ({ v: headerText(c.header, c.key), s: S.head })));

  const data: Cell[][] = rows.map((row) => columns.map((c) => {
    const raw = c.value?.(row);
    return exportCell(raw, c.kind, !!(totals && c.key in totals));
  }));

  if (totals && rows.length > 0) {
    data.push(columns.map((c, i) => {
      if (i === 0) return { v: 'Total', s: S.bold };
      if (c.key in totals) return { v: totals[c.key], s: S.money };
      return '';
    }));
  }

  return {
    name,
    freeze: head.length,
    cols: columns.map((c, i) => (i === 0 ? 22 : Math.min(28, Math.max(14, headerText(c.header, c.key).length + 3)))),
    merges,
    rows: [...head, ...data],
  };
}

export function listingWorkbookName(entity: string, stub: string): string {
  return `${entity.replace(/\W+/g, '-')}-${stub}.xlsx`;
}
