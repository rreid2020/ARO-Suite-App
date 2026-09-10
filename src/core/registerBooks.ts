/**
 * Period-as-at register books.
 *
 * Opening is always the fiscal-year opening: conversion, or the closing of the
 * prior year. In-year columns are cumulative event-ledger amounts through the
 * selected period — new ARO, cost and term adjustments post when recorded;
 * accretion and amortization post when month-end allocates them. Scheduled
 * (not yet allocated) charges do not move the register. Journal batches
 * package those events for the GL; they are not what fills these columns.
 * If nothing has posted since the prior period, closing equals that period's
 * closing.
 */

import type { ObligationEvent } from '../engine/rollforward';
import { classifyRevisionEvent, existedAtOpening } from './activity';
import type { Period } from './periods';
import type { JournalBatch, Obligation } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;

const PROVISION_IN_YEAR = new Set<ObligationEvent['type']>([
  'addition', 'expense-recognition', 'accretion', 'revision', 'revision-unproductive', 'downward-excess', 'settlement', 'disposal', 'fx',
]);

const ASSET_IN_YEAR = new Set<ObligationEvent['type']>([
  'addition', 'revision', 'depreciation',
]);

export interface RegisterBooks {
  openingProvision: number;
  settlement: number;
  accretionExisting: number;
  costAdjustments: number;
  termAdjustments: number;
  writeOffs: number;
  massUpdate: number;
  newAro: number;
  accretionNew: number;
  fx: number;
  closingProvision: number;
  openingArc: number;
  arcAdditions: number;
  amortization: number;
  closingArc: number;
}

export function postedEventIds(batches: JournalBatch[]): Set<string> {
  const ids = new Set<string>();
  for (const b of batches) {
    if (b.status !== 'Posted') continue;
    for (const l of b.lines) {
      if (l.eventId) ids.add(l.eventId);
    }
  }
  return ids;
}

function conversionProvision(o: Obligation, events: ObligationEvent[]): number {
  return round2(events.filter((e) => e.obligationId === o.id && e.type === 'opening').reduce((s, e) => s + e.amount, 0));
}

function conversionArc(o: Obligation, events: ObligationEvent[]): number {
  const converted = events.some((e) => e.obligationId === o.id && e.type === 'opening');
  if (!converted || typeof o.openingArc !== 'number') return 0;
  return round2(o.openingArc);
}

export function inYearEvents(
  o: Obligation,
  events: ObligationEvent[],
  periods: Period[],
  asAt: Period,
): ObligationEvent[] {
  const byId = new Map(periods.map((p) => [p.id, p]));
  return events.filter((e) => {
    if (e.obligationId !== o.id) return false;
    if (e.type === 'opening') return false;
    const p = byId.get(e.periodId);
    if (!p) return false;
    return p.fiscalYear === asAt.fiscalYear && p.no <= asAt.no;
  });
}

function sumType(events: ObligationEvent[], type: ObligationEvent['type']): number {
  return round2(events.filter((e) => e.type === type).reduce((s, e) => s + e.amount, 0));
}

function booksFrom(
  o: Obligation,
  events: ObligationEvent[],
  openingProvision: number,
  openingArc: number,
  inYear: ObligationEvent[],
): RegisterBooks {
  const existing = existedAtOpening(o, events, openingProvision);
  const newAro = round2(sumType(inYear, 'addition') + sumType(inYear, 'expense-recognition'));
  const settlement = round2(sumType(inYear, 'settlement') + sumType(inYear, 'disposal'));
  const fx = sumType(inYear, 'fx');
  const accretion = sumType(inYear, 'accretion');
  const amortization = sumType(inYear, 'depreciation');
  let costAdjustments = 0;
  let termAdjustments = 0;
  let writeOffs = 0;
  let massUpdate = 0;
  for (const e of inYear) {
    if (e.type !== 'revision' && e.type !== 'revision-unproductive') continue;
    const kind = classifyRevisionEvent(o, e);
    if (kind === 'term') termAdjustments = round2(termAdjustments + e.amount);
    else if (kind === 'writeOff') writeOffs = round2(writeOffs + e.amount);
    else if (kind === 'mass') massUpdate = round2(massUpdate + e.amount);
    else costAdjustments = round2(costAdjustments + e.amount);
  }
  costAdjustments = round2(costAdjustments + sumType(inYear, 'downward-excess'));
  const accretionExisting = existing ? accretion : 0;
  const accretionNew = existing ? 0 : accretion;
  const arcAdditions = round2(
    inYear.filter((e) => ASSET_IN_YEAR.has(e.type) && e.type !== 'depreciation').reduce((s, e) => s + e.amount, 0),
  );
  return {
    openingProvision,
    settlement,
    accretionExisting,
    costAdjustments,
    termAdjustments,
    writeOffs,
    massUpdate,
    newAro,
    accretionNew,
    fx,
    closingProvision: round2(
      openingProvision + settlement + accretionExisting + costAdjustments + termAdjustments
      + writeOffs + massUpdate + newAro + accretionNew + fx,
    ),
    openingArc,
    arcAdditions,
    amortization,
    closingArc: round2(openingArc + arcAdditions - amortization),
  };
}

function lastPeriodOf(periods: Period[], fiscalYear: number): Period | undefined {
  return periods.filter((p) => p.fiscalYear === fiscalYear).sort((a, b) => a.no - b.no).at(-1);
}

/**
 * Event-ledger books for one obligation as at a period. Opening is the FY
 * opening (prior-year closing when a prior year exists).
 */
export function registerBooks(
  o: Obligation,
  events: ObligationEvent[],
  periods: Period[],
  batches: JournalBatch[],
  asAt: Period,
): RegisterBooks {
  const priorYear = lastPeriodOf(periods, asAt.fiscalYear - 1);
  let openingProvision: number;
  let openingArc: number;
  if (priorYear) {
    const prior = registerBooks(o, events, periods, batches, priorYear);
    openingProvision = prior.closingProvision;
    openingArc = prior.closingArc;
  } else {
    openingProvision = conversionProvision(o, events);
    openingArc = conversionArc(o, events);
  }
  return booksFrom(o, events, openingProvision, openingArc, inYearEvents(o, events, periods, asAt));
}

export function registerBooksById(
  obligations: Obligation[],
  events: ObligationEvent[],
  periods: Period[],
  batches: JournalBatch[],
  asAt: Period,
): Map<string, RegisterBooks> {
  const m = new Map<string, RegisterBooks>();
  for (const o of obligations) m.set(o.id, registerBooks(o, events, periods, batches, asAt));
  return m;
}

export function unpostedInYearCount(
  events: ObligationEvent[],
  periods: Period[],
  batches: JournalBatch[],
  asAt: Period,
): number {
  const posted = postedEventIds(batches);
  const byId = new Map(periods.map((p) => [p.id, p]));
  let n = 0;
  for (const e of events) {
    if (e.type === 'opening') continue;
    if (!PROVISION_IN_YEAR.has(e.type) && !ASSET_IN_YEAR.has(e.type)) continue;
    if (posted.has(e.id)) continue;
    const p = byId.get(e.periodId);
    if (!p || p.fiscalYear !== asAt.fiscalYear || p.no > asAt.no) continue;
    n += 1;
  }
  return n;
}
