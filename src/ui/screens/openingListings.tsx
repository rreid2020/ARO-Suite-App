/**
 * Opening-register listing columns shared by Obligation and ARO Asset Listing,
 * Register, and Grouped Postings. Currency footers total the source rows, not the
 * current filter. TCA money on the merged view counts each linked asset once.
 */

import React from 'react';
import { classCodeOf, classKey, classNameOf, findAssetClass } from '../../core/assetClass';
import { estimatedCostOf, obligationColumns, openingAroCostOf, remainingUl } from '../../core/openingLoad';
import { obligationsForAsset, tcaAssetStatusOf, tcaNbv } from '../../core/tcaListing';
import { formatUl, remainingUlYears } from '../../core/usefulLife';
import type { AroAssetClass, Obligation, TcaAsset, TcaAssetStatus } from '../../core/types';
import type { ObligationEvent } from '../../engine/rollforward';
import { currency, SheetColumn } from '../components';
import { SCOPING_REASONS } from '../../seed';

export function cellDash(v: unknown): React.ReactNode {
  const s = v == null ? '' : String(v);
  return s || '—';
}

export function moneyFooter(keys: string[], money: Record<string, number>, code: string) {
  return (
    <tr>
      {keys.map((k, i) => (
        <td
          key={k}
          className={k in money ? 'num' : undefined}
          style={i === 0 ? { fontFamily: 'var(--font-heading)', fontWeight: 800 } : undefined}
        >
          {i === 0 ? 'Total' : k in money ? currency(money[k], code) : ''}
        </td>
      ))}
    </tr>
  );
}

function estimatedCostNumber(o: Obligation): number {
  const v = estimatedCostOf(o);
  return typeof v === 'number' ? v : 0;
}

function openingOf(events: ObligationEvent[], id: string): number {
  return events.find((e) => e.obligationId === id && e.type === 'opening')?.amount ?? 0;
}

export function obligationMoneyTotals(rows: Obligation[], events: ObligationEvent[]) {
  return {
    estimatedCost: rows.reduce((s, o) => s + estimatedCostNumber(o), 0),
    fv: rows.reduce((s, o) => s + (typeof o.openingFv === 'number' ? o.openingFv : 0), 0),
    prov: rows.reduce((s, o) => s + openingOf(events, o.id), 0),
    aroCost: rows.reduce((s, o) => s + openingAroCostOf(o), 0),
    arc: rows.reduce((s, o) => s + (typeof o.openingArc === 'number' ? o.openingArc : 0), 0),
    accum: rows.reduce((s, o) => s + (typeof o.openingAccumAmort === 'number' ? o.openingAccumAmort : 0), 0),
  };
}

export function uniqueLinkedTca(rows: Obligation[], tcaByObl: Map<string, TcaAsset>): TcaAsset[] {
  const seen = new Set<string>();
  const out: TcaAsset[] = [];
  for (const o of rows) {
    const tca = tcaByObl.get(o.id);
    if (!tca || seen.has(tca.id)) continue;
    seen.add(tca.id);
    out.push(tca);
  }
  return out;
}

export function registerMoneyTotals(rows: Obligation[], events: ObligationEvent[], tcaByObl: Map<string, TcaAsset>) {
  const linked = uniqueLinkedTca(rows, tcaByObl);
  return {
    ...obligationMoneyTotals(rows, events),
    tcaCost: linked.reduce((s, a) => s + (typeof a.acquisitionCost === 'number' ? a.acquisitionCost : 0), 0),
    tcaAccum: linked.reduce((s, a) => s + (typeof a.accumAmort === 'number' ? a.accumAmort : 0), 0),
    tcaNbv: linked.reduce((s, a) => s + tcaNbv(a), 0),
  };
}

export function groupOpeningRows(
  rows: Obligation[],
  mode: 'class' | 'type',
  classes: AroAssetClass[],
): { key: string; label: string; rows: Obligation[] }[] {
  const m = new Map<string, { label: string; rows: Obligation[] }>();
  for (const o of rows) {
    let key: string;
    let label: string;
    if (mode === 'class') {
      const raw = typeof o.aroAssetClass === 'string' ? o.aroAssetClass.trim() : '';
      const cls = findAssetClass(classes, raw);
      key = cls ? classKey(cls) : (raw || '__none__');
      const code = cls ? (cls.code ?? '') : classCodeOf(raw, classes);
      const name = cls ? cls.name : (classNameOf(raw, classes) || 'No class');
      label = code && name ? `${code} · ${name}` : (name || code || 'No class');
    } else {
      const raw = String(o.type ?? '').trim();
      key = raw.toLowerCase() || '__none__';
      label = raw || 'No type';
    }
    const prev = m.get(key) ?? { label, rows: [] };
    prev.rows.push(o);
    m.set(key, prev);
  }
  return [...m.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function obligationExtractColumns(args: {
  events: ObligationEvent[];
  extras: string[];
  classes: AroAssetClass[];
  currency: string;
  calendarType: string;
  tcaByObl?: Map<string, TcaAsset>;
}): SheetColumn<Obligation>[] {
  const { events, extras, classes, currency: code, calendarType, tcaByObl } = args;
  return [
    { key: 'ref', header: 'Obligation Number', value: (o) => o.ref, cell: (o) => o.ref },
    { key: 'description', header: 'Description', value: (o) => o.description, tdStyle: { whiteSpace: 'normal' as const, maxWidth: 240 }, cell: (o) => o.description },
    { key: 'type', header: 'Obligation type', value: (o) => String(o.type ?? ''), cell: (o) => cellDash(o.type) },
    { key: 'basis', header: 'Basis', value: (o) => String(o.basis ?? ''), cell: (o) => cellDash(o.basis) },
    { key: 'site', header: 'Site', value: (o) => String(o.site ?? ''), cell: (o) => cellDash(o.site) },
    { key: 'region', header: 'Region', value: (o) => String(o.region ?? ''), cell: (o) => cellDash(o.region) },
    { key: 'costEstimateDate', header: 'Cost estimate date', value: (o) => o.costEstimateDate, cell: (o) => cellDash(o.costEstimateDate) },
    { key: 'settlementDate', header: 'Expected settlement', value: (o) => o.settlementDate, cell: (o) => cellDash(o.settlementDate) },
    { key: 'estimatedCost', header: 'Estimated cost', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => estimatedCostNumber(o), cell: (o) => currency(estimatedCostNumber(o), code) },
    { key: 'fv', header: 'Opening future value', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => typeof o.openingFv === 'number' ? o.openingFv : 0, cell: (o) => currency(typeof o.openingFv === 'number' ? o.openingFv : 0, code) },
    { key: 'prov', header: 'Opening provision', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => openingOf(events, o.id), cell: (o) => currency(openingOf(events, o.id), code) },
    { key: 'assetId', header: 'TCA asset number', value: (o) => String(o.assetId ?? ''), cell: (o) => cellDash(o.assetId) },
    { key: 'aroAssetNumber', header: 'ARO asset number', value: (o) => String(o.aroAssetNumber ?? ''), cell: (o) => cellDash(o.aroAssetNumber) },
    { key: 'assetDescription', header: 'ARO Asset Description', value: (o) => String(o.assetDescription ?? ''), tdStyle: { whiteSpace: 'normal' as const, maxWidth: 200 }, cell: (o) => cellDash(o.assetDescription) },
    { key: 'assetAcquisitionDate', header: 'Asset acquisition date', value: (o) => String(o.assetAcquisitionDate ?? ''), cell: (o) => cellDash(o.assetAcquisitionDate) },
    { key: 'classCode', header: 'ARO asset class code', value: (o) => classCodeOf(String(o.aroAssetClass ?? ''), classes), cell: (o) => cellDash(classCodeOf(String(o.aroAssetClass ?? ''), classes)) },
    { key: 'className', header: 'ARO asset class name', value: (o) => classNameOf(String(o.aroAssetClass ?? ''), classes), cell: (o) => cellDash(classNameOf(String(o.aroAssetClass ?? ''), classes)) },
    { key: 'aroCost', header: 'ARO acquisition cost', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => openingAroCostOf(o), cell: (o) => currency(openingAroCostOf(o), code) },
    { key: 'accum', header: 'Accumulated amortization', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => typeof o.openingAccumAmort === 'number' ? o.openingAccumAmort : 0, cell: (o) => currency(typeof o.openingAccumAmort === 'number' ? o.openingAccumAmort : 0, code) },
    { key: 'arc', header: 'ARO asset', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => typeof o.openingArc === 'number' ? o.openingArc : 0, cell: (o) => currency(typeof o.openingArc === 'number' ? o.openingArc : 0, code) },
    { key: 'totalUl', header: 'Total UL', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => typeof o.totalUl === 'number' ? o.totalUl : 0, cell: (o) => formatUl(typeof o.totalUl === 'number' ? o.totalUl : null, calendarType) },
    { key: 'expiredUl', header: 'Expired UL', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => typeof o.expiredUl === 'number' ? o.expiredUl : 0, cell: (o) => formatUl(typeof o.expiredUl === 'number' ? o.expiredUl : null, calendarType) },
    { key: 'remainingUl', header: 'Remaining UL', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => remainingUl(o) ?? 0, cell: (o) => formatUl(remainingUl(o), calendarType) },
    ...extras.map((name) => ({
      key: `col:${name}`,
      header: name,
      value: (o: Obligation) => obligationColumns(o)[name] ?? '',
      tdStyle: { maxWidth: 180, whiteSpace: 'normal' as const },
      cell: (o: Obligation) => obligationColumns(o)[name] || <span className="muted">—</span>,
    })),
  ];
}

export function registerColumns(args: {
  events: ObligationEvent[];
  extras: string[];
  tcaExtras: string[];
  tcaByObl: Map<string, TcaAsset>;
  classes: AroAssetClass[];
  currency: string;
  calendarType: string;
}): SheetColumn<Obligation>[] {
  const { tcaByObl, tcaExtras, currency: code } = args;
  return [
    ...obligationExtractColumns(args),
    { key: 'tcaDescription', header: 'TCA description', value: (o) => tcaByObl.get(o.id)?.description ?? '', tdStyle: { whiteSpace: 'normal' as const, maxWidth: 200 }, cell: (o) => cellDash(tcaByObl.get(o.id)?.description) },
    { key: 'tcaClass', header: 'TCA asset class', value: (o) => tcaByObl.get(o.id)?.assetClass ?? '', cell: (o) => cellDash(tcaByObl.get(o.id)?.assetClass) },
    { key: 'tcaAcq', header: 'TCA acquisition date', value: (o) => tcaByObl.get(o.id)?.acquisitionDate ?? '', cell: (o) => cellDash(tcaByObl.get(o.id)?.acquisitionDate) },
    { key: 'tcaSite', header: 'TCA site', value: (o) => tcaByObl.get(o.id)?.site ?? '', cell: (o) => cellDash(tcaByObl.get(o.id)?.site) },
    { key: 'tcaStatus', header: 'TCA asset status', value: (o) => tcaByObl.get(o.id) ? tcaAssetStatusOf(tcaByObl.get(o.id)!) : '', cell: (o) => cellDash(tcaByObl.get(o.id) ? tcaAssetStatusOf(tcaByObl.get(o.id)!) : '') },
    { key: 'tcaScope', header: 'TCA scope', value: (o) => tcaByObl.get(o.id)?.scope ?? '', cell: (o) => cellDash(tcaByObl.get(o.id)?.scope) },
    { key: 'tcaReason', header: 'TCA reason if out', value: (o) => tcaByObl.get(o.id)?.scopeReason ?? '', cell: (o) => cellDash(tcaByObl.get(o.id)?.scopeReason) },
    { key: 'tcaCost', header: 'TCA acquisition cost', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => tcaByObl.get(o.id)?.acquisitionCost ?? 0, cell: (o) => {
      const n = tcaByObl.get(o.id)?.acquisitionCost;
      return typeof n === 'number' ? currency(n, code) : '—';
    } },
    { key: 'tcaAccum', header: 'TCA accumulated amortization', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => tcaByObl.get(o.id)?.accumAmort ?? 0, cell: (o) => {
      const n = tcaByObl.get(o.id)?.accumAmort;
      return typeof n === 'number' ? currency(n, code) : '—';
    } },
    { key: 'tcaNbv', header: 'TCA net book value', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (o) => {
      const tca = tcaByObl.get(o.id);
      return tca ? tcaNbv(tca) : 0;
    }, cell: (o) => {
      const tca = tcaByObl.get(o.id);
      return tca ? currency(tcaNbv(tca), code) : '—';
    } },
    ...tcaExtras.map((name) => ({
      key: `tca:${name}`,
      header: `TCA · ${name}`,
      value: (o: Obligation) => tcaByObl.get(o.id)?.columns[name] ?? '',
      tdStyle: { maxWidth: 180, whiteSpace: 'normal' as const },
      cell: (o: Obligation) => tcaByObl.get(o.id)?.columns[name] || <span className="muted">—</span>,
    })),
  ];
}

export function tcaListingColumns(args: {
  extras: string[];
  obligations: Obligation[];
  currency: string;
  calendarType?: string;
  editable: boolean;
  locked: boolean;
  onScope: (asset: TcaAsset, status: string, reason: string) => void;
  onStatus?: (asset: TcaAsset, status: TcaAssetStatus) => void;
}): SheetColumn<TcaAsset>[] {
  const { extras, obligations, currency: code, calendarType, editable, locked, onScope, onStatus } = args;
  return [
    { key: 'assetNumber', header: 'TCA asset number', value: (a) => a.assetNumber, cell: (a) => a.assetNumber },
    { key: 'description', header: 'Description', value: (a) => a.description, tdStyle: { whiteSpace: 'normal' as const, maxWidth: 240 }, cell: (a) => a.description },
    { key: 'assetClass', header: 'TCA asset class', value: (a) => a.assetClass, cell: (a) => cellDash(a.assetClass) },
    { key: 'acq', header: 'Acquisition date', value: (a) => a.acquisitionDate, cell: (a) => cellDash(a.acquisitionDate) },
    { key: 'cost', header: 'Acquisition cost', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (a) => a.acquisitionCost ?? 0, cell: (a) => typeof a.acquisitionCost === 'number' ? currency(a.acquisitionCost, code) : '—' },
    { key: 'accum', header: 'Accumulated amortization', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (a) => a.accumAmort ?? 0, cell: (a) => typeof a.accumAmort === 'number' ? currency(a.accumAmort, code) : '—' },
    { key: 'nbv', header: 'Net book value', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (a) => tcaNbv(a), cell: (a) => currency(tcaNbv(a), code) },
    { key: 'totalUl', header: 'Total UL', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (a) => a.totalUl ?? 0, cell: (a) => formatUl(typeof a.totalUl === 'number' ? a.totalUl : null, calendarType) },
    { key: 'expiredUl', header: 'Expired UL', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (a) => a.expiredUl ?? 0, cell: (a) => formatUl(typeof a.expiredUl === 'number' ? a.expiredUl : null, calendarType) },
    { key: 'remainingUl', header: 'Remaining UL', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (a) => remainingUlYears(a.totalUl, a.expiredUl) ?? 0, cell: (a) => formatUl(remainingUlYears(a.totalUl, a.expiredUl), calendarType) },
    { key: 'site', header: 'Site', value: (a) => a.site, cell: (a) => cellDash(a.site) },
    { key: 'assetStatus', header: 'Asset status', width: 140, value: (a) => tcaAssetStatusOf(a), cell: (a) => (
      <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} disabled={!editable || !onStatus}
        title="When a TCA is unproductive, flag the related ARO asset on the ARO Register so later changes of estimate go to operating expense."
        value={tcaAssetStatusOf(a)}
        onChange={(e) => onStatus?.(a, e.target.value as TcaAssetStatus)}>
        <option>Active</option>
        <option>Unproductive</option>
        <option>Disposed</option>
      </select>
    ) },
    { key: 'linked', header: 'Obligations', kind: 'number' as const, thClassName: 'num', tdClassName: 'num', value: (a) => obligationsForAsset(obligations, a.assetNumber).length, cell: (a) => {
      const n = obligationsForAsset(obligations, a.assetNumber).length;
      return n ? String(n) : '—';
    } },
    { key: 'scope', header: 'Scope', width: 140, value: (a) => a.scope, cell: (a) => {
      const linked = obligationsForAsset(obligations, a.assetNumber).length > 0;
      return (
        <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} disabled={!editable || locked || linked} value={a.scope}
          onChange={(e) => onScope(a, e.target.value, a.scopeReason || SCOPING_REASONS[0])}>
          <option>In scope</option>
          <option>Scoped out</option>
          <option>Undecided</option>
        </select>
      );
    } },
    { key: 'reason', header: 'Reason if out', width: 220, value: (a) => a.scopeReason, cell: (a) => (
      a.scope === 'Scoped out' ? (
        <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} disabled={!editable || locked} value={a.scopeReason}
          onChange={(e) => onScope(a, 'Scoped out', e.target.value)}>
          <option value="">— none recorded —</option>
          {SCOPING_REASONS.map((r) => <option key={r}>{r}</option>)}
        </select>
      ) : (obligationsForAsset(obligations, a.assetNumber).length ? 'Linked obligation' : null)
    ) },
    ...extras.map((name) => ({
      key: `tca:${name}`,
      header: name,
      value: (a: TcaAsset) => a.columns[name] ?? '',
      tdStyle: { maxWidth: 180, whiteSpace: 'normal' as const },
      cell: (a: TcaAsset) => a.columns[name] || <span className="muted">—</span>,
    })),
  ];
}

export function tcaMoneyTotals(assets: TcaAsset[]) {
  return {
    cost: assets.reduce((s, a) => s + (typeof a.acquisitionCost === 'number' ? a.acquisitionCost : 0), 0),
    accum: assets.reduce((s, a) => s + (typeof a.accumAmort === 'number' ? a.accumAmort : 0), 0),
    nbv: assets.reduce((s, a) => s + tcaNbv(a), 0),
  };
}

export function obligationColumnKeys(cols: SheetColumn<Obligation>[]): string[] {
  return cols.map((c) => c.key);
}
