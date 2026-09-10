/**
 * Per-obligation calculation details for the register expand.
 *
 * Baseline (cost and term, or useful life) plus the same in-year split as
 * Roll-forward & disclosure, for one obligation as at the selected period.
 */

import { termYears } from '../engine/dates';
import { directFromLines, settlementInForce, type Derived } from '../engine/derive';
import type { ObligationEvent } from '../engine/rollforward';
import { classifyRevisionEvent, existedAtOpening } from './activity';
import type { Period } from './periods';
import { inYearEvents, type RegisterBooks } from './registerBooks';
import type { Obligation, ReportingUnit } from './types';
import type { UsefulLife } from './usefulLife';

export type CalcDetailGroup = 'Baseline' | 'Opening' | 'Existing' | 'New' | 'Activity' | 'Closing';
export type CalcDetailKind = 'money' | 'years';

export interface CalcDetailLine {
  key: string;
  label: string;
  group: CalcDetailGroup;
  kind: CalcDetailKind;
  amount: number | null;
  detail?: string;
}

function money(key: string, label: string, group: CalcDetailGroup, amount: number | null): CalcDetailLine {
  return { key, label, group, kind: 'money', amount };
}

function yearsLine(
  key: string,
  label: string,
  amount: number | null,
  detail?: string,
): CalcDetailLine {
  return { key, label, group: 'Baseline', kind: 'years', amount, detail };
}

function initialCost(o: Obligation): number {
  const fromLines = directFromLines(o.lines);
  if (fromLines) return fromLines;
  return typeof o.estimatedCost === 'number' ? o.estimatedCost : 0;
}

function termFromFyEnd(unit: ReportingUnit, settlement: string): number | null {
  if (!settlement) return null;
  return termYears(unit.fyEnd, settlement, unit.dayCount);
}

/** Provision statement: baseline, then event-ledger books through the selected period. */
export function obligationCalcLines(
  o: Obligation,
  books: RegisterBooks,
  d: Derived | undefined,
  unit: ReportingUnit,
): CalcDetailLine[] {
  const originalSettle = o.settlementDate;
  const adjustedSettle = d?.settlementUsed ?? settlementInForce(o);
  return [
    money('initialCost', 'Initial cost estimate', 'Baseline', initialCost(o)),
    money('currentCost', 'Cost estimate in current year dollars', 'Baseline', d?.cce ?? null),
    yearsLine('initialTerm', 'Initial term', termFromFyEnd(unit, originalSettle), originalSettle ? `settlement ${originalSettle}` : undefined),
    yearsLine('adjustedTerm', 'Adjusted term', d?.tD ?? termFromFyEnd(unit, adjustedSettle), adjustedSettle ? `settlement ${adjustedSettle}` : undefined),
    money('opening', 'Opening provision', 'Opening', books.openingProvision),
    money('settlement', 'Settlement', 'Existing', books.settlement),
    money('accretion', 'Accretion on existing ARO', 'Existing', books.accretionExisting),
    money('cost', 'Change of estimate — cost adjustments', 'Existing', books.costAdjustments),
    money('term', 'Change of estimate — term adjustments', 'Existing', books.termAdjustments),
    money('writeOff', 'Change of estimate — write-offs', 'Existing', books.writeOffs),
    money('mass', 'Change of estimate — year-end mass update (inflation and interest rates)', 'Existing', books.massUpdate),
    money('newAro', 'New ARO', 'New', books.newAro),
    money('accretionNew', 'Accretion on new ARO', 'New', books.accretionNew),
    money('fx', 'Exchange differences', 'New', books.fx),
    money('closing', 'Closing provision', 'Closing', books.closingProvision),
  ];
}

/**
 * ARO asset statement: useful life as at the selected period, then the same
 * opening / additions / amortization / closing as the register ARO asset columns.
 * Additions are the capitalized events (new ARO and revisions), not the
 * provision disclosure split.
 */
export function assetCalcLines(o: Obligation, books: RegisterBooks, life: UsefulLife): CalcDetailLine[] {
  return [
    yearsLine('totalUl', 'Total useful life', life.totalYears),
    yearsLine('expiredUl', 'Expired useful life', life.expiredYears),
    yearsLine('remainingUl', 'Remaining useful life', life.remainingYears),
    money('opening', 'Opening ARO asset', 'Opening', books.openingArc),
    money('additions', 'Additions', 'Activity', books.arcAdditions),
    money('amort', 'Amortization', 'Activity', books.amortization),
    money('closing', 'Closing ARO asset', 'Closing', books.closingArc),
  ];
}

export interface CalcLineSource {
  events: ObligationEvent[];
  emptyNote?: string;
  /** Shown above the event list when opening was carried rather than posted. */
  note?: string;
}

function byDate(events: ObligationEvent[]): ObligationEvent[] {
  return [...events].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

function openingEvents(o: Obligation, events: ObligationEvent[]): ObligationEvent[] {
  return events.filter((e) => e.obligationId === o.id && e.type === 'opening');
}

function revisionsOf(
  o: Obligation,
  year: ObligationEvent[],
  kind: 'cost' | 'term' | 'writeOff' | 'mass',
): ObligationEvent[] {
  const rows = year.filter((e) => {
    if (e.type !== 'revision' && e.type !== 'revision-unproductive') return false;
    return classifyRevisionEvent(o, e) === kind;
  });
  if (kind === 'cost') {
    return [...rows, ...year.filter((e) => e.type === 'downward-excess')];
  }
  return rows;
}

/** Every calc-detail row can be opened: events for posted totals, estimate lines or a note otherwise. */
export function calcLineDrillable(_line: CalcDetailLine): boolean {
  return true;
}

/**
 * Event-ledger rows that foot to a calculation-details line as at the selected
 * period. Baseline years and current-year dollars are not posted events.
 */
export function calcLineSource(
  key: string,
  side: 'obligation' | 'asset',
  o: Obligation,
  books: RegisterBooks,
  events: ObligationEvent[],
  periods: Period[],
  asAt: Period,
): CalcLineSource {
  const year = inYearEvents(o, events, periods, asAt);
  const existing = existedAtOpening(o, events, books.openingProvision);
  const opened = openingEvents(o, events);

  if (key === 'currentCost') {
    return { events: [], emptyNote: 'Current-year dollars escalate the recorded estimate to the year end. That is a measurement fact, not a posted event.' };
  }
  if (key === 'initialTerm' || key === 'adjustedTerm') {
    return { events: [], emptyNote: 'Term is the years and months from the year end to settlement. That is a measurement fact, not a posted event.' };
  }
  if (key === 'totalUl' || key === 'expiredUl' || key === 'remainingUl') {
    return { events: [], emptyNote: 'Useful life is a measurement fact on the ARO asset, not a posted event.' };
  }
  if (key === 'initialCost') {
    return { events: [], emptyNote: 'The recorded estimate. Cost-estimate lines, when present, are listed on this row.' };
  }

  if (side === 'asset') {
    if (key === 'opening') {
      return {
        events: [],
        emptyNote: opened.length
          ? 'Opening ARO asset is the conversion NBV, not a posted in-year event.'
          : 'Carried from the prior fiscal year closing.',
      };
    }
    if (key === 'additions') {
      return { events: byDate(year.filter((e) => e.type === 'addition' || e.type === 'revision')) };
    }
    if (key === 'amort') {
      const rows = byDate(year.filter((e) => e.type === 'depreciation'));
      return {
        events: rows,
        emptyNote: rows.length ? undefined : 'No amortization allocated through this period. Month-end posting writes that event.',
      };
    }
    if (key === 'closing') {
      const rows = byDate(year.filter((e) => e.type === 'addition' || e.type === 'revision' || e.type === 'depreciation'));
      return {
        events: rows,
        emptyNote: rows.length ? undefined : 'No in-year ARO asset postings. Closing is the opening NBV.',
        note: rows.length && books.openingArc
          ? 'Opening NBV is carried. The events below are in-year additions and amortization through this period.'
          : undefined,
      };
    }
    return { events: [] };
  }

  if (key === 'opening') {
    if (opened.length) return { events: byDate(opened) };
    return { events: [], emptyNote: 'Carried from the prior fiscal year closing.' };
  }
  if (key === 'settlement') {
    return { events: byDate(year.filter((e) => e.type === 'settlement' || e.type === 'disposal')) };
  }
  if (key === 'accretion') {
    const rows = existing ? byDate(year.filter((e) => e.type === 'accretion')) : [];
    return {
      events: rows,
      emptyNote: existing
        ? (rows.length ? undefined : 'No accretion allocated through this period. Month-end posting writes that event.')
        : 'This obligation did not exist at opening. Accretion sits on Accretion on new ARO.',
    };
  }
  if (key === 'accretionNew') {
    const rows = existing ? [] : byDate(year.filter((e) => e.type === 'accretion'));
    return {
      events: rows,
      emptyNote: existing
        ? 'This obligation existed at opening. Accretion sits on Accretion on existing ARO.'
        : (rows.length ? undefined : 'No accretion allocated through this period. Month-end posting writes that event.'),
    };
  }
  if (key === 'cost') return { events: byDate(revisionsOf(o, year, 'cost')) };
  if (key === 'term') return { events: byDate(revisionsOf(o, year, 'term')) };
  if (key === 'writeOff') return { events: byDate(revisionsOf(o, year, 'writeOff')) };
  if (key === 'mass') return { events: byDate(revisionsOf(o, year, 'mass')) };
  if (key === 'newAro') {
    return { events: byDate(year.filter((e) => e.type === 'addition' || e.type === 'expense-recognition')) };
  }
  if (key === 'fx') return { events: byDate(year.filter((e) => e.type === 'fx')) };
  if (key === 'closing') {
    const provision = year.filter((e) =>
      e.type === 'addition' || e.type === 'expense-recognition' || e.type === 'accretion'
      || e.type === 'revision' || e.type === 'revision-unproductive' || e.type === 'downward-excess'
      || e.type === 'settlement' || e.type === 'disposal' || e.type === 'fx',
    );
    const rows = byDate([...opened, ...provision]);
    return {
      events: rows,
      emptyNote: rows.length ? undefined : 'No conversion opening event and no in-year provision postings. Closing is the carried opening.',
      note: opened.length || !rows.length
        ? undefined
        : 'Opening was carried from the prior fiscal year. The events below are in-year movement through this period.',
    };
  }
  return { events: [] };
}
