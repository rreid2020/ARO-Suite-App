/**
 * In-year ARO activity after conversion.
 *
 * Opening is the locked converted provision. In-year activity is classified as
 * settlement, accretion on existing ARO, change of estimate on existing ARO
 * (cost, term, write-off, year-end mass update), new ARO, and accretion on new
 * ARO. Both the consolidated statement and the period breakdown are this same
 * classification of the event ledger — the year is the sum of the periods.
 */

import { CENT, type ObligationEvent } from '../engine/rollforward';
import { openingArcTotal } from './openingLoad';
import type { Period } from './periods';
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

export interface PeriodActivity extends ActivityStatement {
  periodId: string;
  code: string;
}

/** One disclosure line: the consolidated table’s rows, the period table’s columns. */
export const ACTIVITY_COLUMNS: {
  key: keyof Pick<ActivityStatement,
    | 'openingProvision' | 'settlement' | 'accretionExisting'
    | 'costAdjustments' | 'termAdjustments' | 'writeOffs' | 'massUpdate'
    | 'newAro' | 'accretionNew' | 'fx' | 'closing'>;
  label: string;
  group: ActivityLine['group'];
}[] = [
  { key: 'openingProvision', label: 'Opening balances', group: 'Opening' },
  { key: 'settlement', label: 'Settlement', group: 'Existing' },
  { key: 'accretionExisting', label: 'Accretion on existing ARO', group: 'Existing' },
  { key: 'costAdjustments', label: 'Change of estimate — cost adjustments', group: 'Existing' },
  { key: 'termAdjustments', label: 'Change of estimate — term adjustments', group: 'Existing' },
  { key: 'writeOffs', label: 'Change of estimate — write-offs', group: 'Existing' },
  { key: 'massUpdate', label: 'Change of estimate — year-end mass update (inflation and interest rates)', group: 'Existing' },
  { key: 'newAro', label: 'New ARO', group: 'New' },
  { key: 'accretionNew', label: 'Accretion on new ARO', group: 'New' },
  { key: 'fx', label: 'Exchange differences', group: 'New' },
  { key: 'closing', label: 'Closing', group: 'Closing' },
];

const WRITE_OFF = /write[\s-]?off/i;
const round2 = (n: number) => Math.round(n * 100) / 100;

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

export function matchedRevision(o: Obligation, e: ObligationEvent) {
  const adjs = o.adj ?? [];
  return adjs.find((a) =>
    e.id.includes(`-rev-${a.id}`) || e.id.endsWith(`-${a.id}`) || e.id.includes(`-${a.id}-`)
  )
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

export type TxHistoryKind = 'cost' | 'term' | 'settle';

function byDate(events: ObligationEvent[]): ObligationEvent[] {
  return [...events].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** Posted in-year events that make up one obligation’s cost, term or settlement history. */
export function txHistoryEvents(o: Obligation, events: ObligationEvent[], kind: TxHistoryKind): ObligationEvent[] {
  const mine = events.filter((e) => e.obligationId === o.id);
  if (kind === 'settle') {
    return byDate(mine.filter((e) => e.type === 'settlement' || e.type === 'disposal'));
  }
  return byDate(mine.filter((e) => {
    if (kind === 'cost' && e.type === 'downward-excess') return true;
    if (e.type !== 'revision' && e.type !== 'revision-unproductive') return false;
    return classifyRevisionEvent(o, e) === kind;
  }));
}

function existingObligationIds(events: ObligationEvent[]): Set<string> | null {
  const ids = new Set(events.filter((e) => e.type === 'opening').map((e) => e.obligationId));
  return ids.size ? ids : null;
}

function isExistingId(obligationId: string, existingIds: Set<string> | null): boolean {
  if (!existingIds) return true;
  return existingIds.has(obligationId);
}

function linesFrom(stmt: ActivityStatement): ActivityLine[] {
  return ACTIVITY_COLUMNS.map((c) => ({
    key: c.key,
    label: c.label,
    group: c.group,
    amount: stmt[c.key],
  }));
}

function finish(
  amounts: Omit<ActivityStatement, 'closing' | 'measuredClosing' | 'residual' | 'foots' | 'lines'>,
  measuredClosing: number | null,
): ActivityStatement {
  const closing = round2(
    amounts.openingProvision
    + amounts.settlement
    + amounts.accretionExisting
    + amounts.costAdjustments
    + amounts.termAdjustments
    + amounts.writeOffs
    + amounts.massUpdate
    + amounts.newAro
    + amounts.accretionNew
    + amounts.fx,
  );
  const residual = measuredClosing === null ? 0 : round2(measuredClosing - closing);
  const stmt: ActivityStatement = {
    ...amounts,
    closing,
    measuredClosing: measuredClosing ?? closing,
    residual,
    foots: Math.abs(residual) <= CENT,
    lines: [],
  };
  stmt.lines = linesFrom(stmt);
  return stmt;
}

/**
 * Classify a slice of the event ledger into the disclosure lines. Existing vs
 * new ARO is taken from the full ledger (opening events), so a later period’s
 * accretion on a new obligation stays on New ARO.
 */
export function activityFromEvents(
  obligations: Obligation[],
  allEvents: ObligationEvent[],
  slice: ObligationEvent[],
  measuredClosing: number | null,
): ActivityStatement {
  const byId = new Map(obligations.map((o) => [o.id, o]));
  const existingIds = existingObligationIds(allEvents);

  let openingProvision = 0;
  let settlement = 0;
  let accretionExisting = 0;
  let costAdjustments = 0;
  let termAdjustments = 0;
  let writeOffs = 0;
  let massUpdate = 0;
  let newAro = 0;
  let accretionNew = 0;
  let fx = 0;

  for (const e of slice) {
    switch (e.type) {
      case 'opening':
        openingProvision = round2(openingProvision + e.amount);
        break;
      case 'settlement':
      case 'disposal':
        settlement = round2(settlement + e.amount);
        break;
      case 'accretion':
        if (isExistingId(e.obligationId, existingIds)) accretionExisting = round2(accretionExisting + e.amount);
        else accretionNew = round2(accretionNew + e.amount);
        break;
      case 'addition':
      case 'expense-recognition':
        newAro = round2(newAro + e.amount);
        break;
      case 'fx':
        fx = round2(fx + e.amount);
        break;
      case 'downward-excess':
        costAdjustments = round2(costAdjustments + e.amount);
        break;
      case 'revision':
      case 'revision-unproductive': {
        const o = byId.get(e.obligationId);
        const kind = o ? classifyRevisionEvent(o, e) : 'cost';
        if (kind === 'term') termAdjustments = round2(termAdjustments + e.amount);
        else if (kind === 'writeOff') writeOffs = round2(writeOffs + e.amount);
        else if (kind === 'mass') massUpdate = round2(massUpdate + e.amount);
        else costAdjustments = round2(costAdjustments + e.amount);
        break;
      }
      default:
        break;
    }
  }

  return finish({
    openingProvision,
    openingArc: openingArcTotal(obligations),
    settlement,
    accretionExisting,
    costAdjustments,
    termAdjustments,
    writeOffs,
    massUpdate,
    newAro,
    accretionNew,
    fx,
  }, measuredClosing);
}

export function activityStatement(
  obligations: Obligation[],
  events: ObligationEvent[],
  measuredTotal: number,
): ActivityStatement {
  return activityFromEvents(obligations, events, events, measuredTotal);
}

/** Period slices of the same statement. Year totals equal the consolidated view. */
export function activityByPeriod(
  obligations: Obligation[],
  events: ObligationEvent[],
  periods: Pick<Period, 'id' | 'code'>[],
  measuredTotal: number,
): { periods: PeriodActivity[]; year: ActivityStatement } {
  const ids = new Set(periods.map((p) => p.id));
  const inYear = events.filter((e) => ids.has(e.periodId));
  const year = activityFromEvents(obligations, events, inYear, measuredTotal);
  return {
    year,
    periods: periods.map((p) => ({
      periodId: p.id,
      code: p.code,
      ...activityFromEvents(obligations, events, inYear.filter((e) => e.periodId === p.id), null),
    })),
  };
}
