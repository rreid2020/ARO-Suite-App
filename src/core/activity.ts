/**
 * In-year ARO activity after conversion.
 *
 * Opening is the locked converted provision. In-year activity is classified as
 * settlement, accretion on existing ARO, change of estimate on existing ARO
 * (cost, term, write-off, year-end mass update), new ARO, and accretion on new
 * ARO. The identity roll-forward on Report stays the event-ledger control;
 * this statement is the go-forward disclosure split.
 */

import type { Derived } from '../engine/derive';
import { CENT, type ObligationEvent } from '../engine/rollforward';
import { openingArcTotal, openingProvisionTotal } from './openingLoad';
import type { Obligation } from './types';

export interface ActivityLine {
  key: string;
  label: string;
  group: 'Opening' | 'Existing' | 'New' | 'Closing';
  amount: number;
}

export interface ActivityStatement {
  openingProvision: number;
  openingArc: number;
  settlement: number;
  accretionExisting: number;
  costAdjustments: number;
  termAdjustments: number;
  writeOffs: number;
  massUpdate: number;
  newAro: number;
  accretionNew: number;
  fx: number;
  closing: number;
  measuredClosing: number;
  residual: number;
  foots: boolean;
  lines: ActivityLine[];
}

const WRITE_OFF = /write[\s-]?off/i;

export function isExistingAro(o: Obligation, events: ObligationEvent[]): boolean {
  const openingIds = new Set(events.filter((e) => e.type === 'opening').map((e) => e.obligationId));
  if (openingIds.size) return openingIds.has(o.id);
  return true;
}

export function isWriteOff(o: Obligation): boolean {
  return (o.adj ?? []).some((a) => WRITE_OFF.test(a.reason));
}

/** Existed at FY opening: a conversion opening event, or a non-nil opening balance. */
export function existedAtOpening(o: Obligation, events: ObligationEvent[], openingProvision: number): boolean {
  if (events.some((e) => e.obligationId === o.id && e.type === 'opening')) return true;
  return Math.abs(openingProvision) > 0.005;
}

export type EstimateKind = 'cost' | 'term' | 'writeOff' | 'mass';

function matchedRevision(o: Obligation, e: ObligationEvent) {
  const adjs = o.adj ?? [];
  return adjs.find((a) => e.id.endsWith(`-rev-${a.id}`) || e.id.endsWith(`-${a.id}`))
    ?? adjs.find((a) => a.date === e.date && (
      (a.kind === 'term' && /term/i.test(e.note ?? ''))
      || (a.kind === 'cost' && /cost/i.test(e.note ?? ''))
    ));
}

/** Classify a posted revision into the disclosure change-of-estimate line. */
export function classifyRevisionEvent(o: Obligation, e: ObligationEvent): EstimateKind {
  const note = e.note ?? '';
  if (/mass update|year-end revaluat|closing (curve|table)|inflation and interest/i.test(note)) return 'mass';
  const adj = matchedRevision(o, e);
  const reason = `${adj?.reason ?? ''} ${note}`;
  if (WRITE_OFF.test(reason)) return 'writeOff';
  if (adj?.kind === 'term' || /term adjustment/i.test(note)) return 'term';
  return 'cost';
}

function sum(events: ObligationEvent[], type: ObligationEvent['type'], ids?: Set<string>): number {
  return events
    .filter((e) => e.type === type && (!ids || ids.has(e.obligationId)))
    .reduce((s, e) => s + e.amount, 0);
}

export function activityStatement(
  obligations: Obligation[],
  events: ObligationEvent[],
  derivedById: Map<string, Derived>,
  measuredTotal: number,
): ActivityStatement {
  const existing = obligations.filter((o) => isExistingAro(o, events));
  const existingIds = new Set(existing.map((o) => o.id));
  const newcomers = obligations.filter((o) => o.status !== 'Scoped out' && !existingIds.has(o.id));
  const newIds = new Set(newcomers.map((o) => o.id));

  const openingProvision = openingProvisionTotal(events);
  const openingArc = openingArcTotal(obligations);
  const settlement = sum(events, 'settlement') + sum(events, 'disposal');
  const accretionExisting = sum(events, 'accretion', existingIds);
  const accretionNew = sum(events, 'accretion', newIds);
  const fx = sum(events, 'fx');

  let costAdjustments = 0;
  let termAdjustments = 0;
  let writeOffs = 0;
  let massUpdate = 0;
  for (const o of existing) {
    const d = derivedById.get(o.id);
    if (!d) continue;
    if (isWriteOff(o)) writeOffs += d.bridge.costEffect;
    else costAdjustments += d.bridge.costEffect;
    termAdjustments += d.bridge.timingEffect;
    massUpdate += d.bridge.rateEffect + d.bridge.inflEffect;
  }

  let newAro = 0;
  for (const o of newcomers) {
    const d = derivedById.get(o.id);
    const pv = d?.pv ?? 0;
    const accretion = events.filter((e) => e.obligationId === o.id && e.type === 'accretion').reduce((s, e) => s + e.amount, 0);
    const settled = events.filter((e) => e.obligationId === o.id && e.type === 'settlement').reduce((s, e) => s + e.amount, 0);
    newAro += pv - accretion - settled;
  }

  const closing = openingProvision
    + settlement
    + accretionExisting
    + costAdjustments
    + termAdjustments
    + writeOffs
    + massUpdate
    + newAro
    + accretionNew
    + fx;
  const residual = measuredTotal - closing;

  const lines: ActivityLine[] = [
    { key: 'opening', label: 'Opening balances', group: 'Opening', amount: openingProvision },
    { key: 'settlement', label: 'Settlement', group: 'Existing', amount: settlement },
    { key: 'accretionExisting', label: 'Accretion on existing ARO', group: 'Existing', amount: accretionExisting },
    { key: 'cost', label: 'Change of estimate — cost adjustments', group: 'Existing', amount: costAdjustments },
    { key: 'term', label: 'Change of estimate — term adjustments', group: 'Existing', amount: termAdjustments },
    { key: 'writeOff', label: 'Change of estimate — write-offs', group: 'Existing', amount: writeOffs },
    { key: 'mass', label: 'Change of estimate — year-end mass update (inflation and interest rates)', group: 'Existing', amount: massUpdate },
    { key: 'newAro', label: 'New ARO', group: 'New', amount: newAro },
    { key: 'accretionNew', label: 'Accretion on new ARO', group: 'New', amount: accretionNew },
    { key: 'fx', label: 'Exchange differences', group: 'New', amount: fx },
    { key: 'closing', label: 'Closing', group: 'Closing', amount: closing },
  ];

  return {
    openingProvision,
    openingArc,
    settlement,
    accretionExisting,
    costAdjustments,
    termAdjustments,
    writeOffs,
    massUpdate,
    newAro,
    accretionNew,
    fx,
    closing,
    measuredClosing: measuredTotal,
    residual,
    foots: Math.abs(residual) <= CENT,
    lines,
  };
}
