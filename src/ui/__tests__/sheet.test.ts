import { describe, expect, it } from 'vitest';
import {
  applySheet, emptyFilter, isFilterActive, uniqueForColumn, valueKey, passesCond,
  SheetFilter,
} from '../sheet';

type Row = { ref: string; site: string; pv: number; date: string };

const rows: Row[] = [
  { ref: 'ARO-01', site: 'Pit A', pv: 100, date: '2025-01-01' },
  { ref: 'ARO-02', site: 'Pit A', pv: 250, date: '2026-06-30' },
  { ref: 'ARO-03', site: 'Plant', pv: 250, date: '2027-12-31' },
  { ref: 'ARO-04', site: '', pv: 40, date: '2024-03-15' },
];

const cols = [
  { key: 'ref', kind: 'text' as const, value: (r: Row) => r.ref },
  { key: 'site', kind: 'text' as const, value: (r: Row) => r.site },
  { key: 'pv', kind: 'number' as const, value: (r: Row) => r.pv },
  { key: 'date', kind: 'date' as const, value: (r: Row) => r.date },
];

describe('Excel-style sheet filter', () => {
  it('treats empty string as the blank key', () => {
    expect(valueKey('')).toBe('');
    expect(valueKey(null)).toBe('');
    expect(valueKey(250)).toBe('250');
  });

  it('sorts A to Z and Z to A', () => {
    const az = applySheet(rows, cols, {}, { key: 'ref', dir: 1 }).map((r) => r.ref);
    const za = applySheet(rows, cols, {}, { key: 'ref', dir: -1 }).map((r) => r.ref);
    expect(az).toEqual(['ARO-01', 'ARO-02', 'ARO-03', 'ARO-04']);
    expect(za).toEqual(['ARO-04', 'ARO-03', 'ARO-02', 'ARO-01']);
  });

  it('sorts numbers smallest to largest', () => {
    const sorted = applySheet(rows, cols, {}, { key: 'pv', dir: 1 }).map((r) => r.pv);
    expect(sorted).toEqual([40, 100, 250, 250]);
  });

  it('filters to checked unique values', () => {
    const filters: Record<string, SheetFilter> = {
      site: { selected: ['Pit A'], cond: emptyFilter().cond },
    };
    expect(applySheet(rows, cols, filters, null).map((r) => r.ref)).toEqual(['ARO-01', 'ARO-02']);
  });

  it('an empty allow-list shows no rows', () => {
    const filters: Record<string, SheetFilter> = {
      site: { selected: [], cond: emptyFilter().cond },
    };
    expect(applySheet(rows, cols, filters, null)).toEqual([]);
  });

  it('contains is case-insensitive', () => {
    expect(passesCond('Pit A', 'text', { op: 'contains', a: 'pit', b: '' })).toBe(true);
    expect(passesCond('Plant', 'text', { op: 'contains', a: 'pit', b: '' })).toBe(false);
  });

  it('greater-than on numbers', () => {
    const filters: Record<string, SheetFilter> = {
      pv: { selected: null, cond: { op: 'gt', a: '100', b: '' } },
    };
    expect(applySheet(rows, cols, filters, null).map((r) => r.pv)).toEqual([250, 250]);
  });

  it('between on dates is inclusive', () => {
    const filters: Record<string, SheetFilter> = {
      date: { selected: null, cond: { op: 'between', a: '2025-01-01', b: '2026-12-31' } },
    };
    expect(applySheet(rows, cols, filters, null).map((r) => r.ref)).toEqual(['ARO-01', 'ARO-02']);
  });

  it('unique values for a column ignore that column\'s own checkbox filter', () => {
    const filters: Record<string, SheetFilter> = {
      site: { selected: ['Pit A'], cond: emptyFilter().cond },
      pv: { selected: ['250'], cond: emptyFilter().cond },
    };
    const sites = uniqueForColumn(rows, cols, filters, 'site');
    expect(sites.map((s) => s.key).sort()).toEqual(['Pit A', 'Plant']);
    const pvs = uniqueForColumn(rows, cols, filters, 'pv');
    expect(pvs.map((s) => s.key)).toEqual(['100', '250']);
  });

  it('blanks sort last in the unique list', () => {
    const sites = uniqueForColumn(rows, cols, {}, 'site');
    expect(sites[sites.length - 1].key).toBe('');
    expect(sites[sites.length - 1].label).toBe('(Blanks)');
  });

  it('isFilterActive is false for the empty filter', () => {
    expect(isFilterActive(emptyFilter())).toBe(false);
    expect(isFilterActive({ selected: ['x'], cond: emptyFilter().cond })).toBe(true);
  });
});
