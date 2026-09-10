/**
 * Per-obligation calculation details for the register expand.
 *
 * Baseline (cost and term, or useful life) plus the same in-year split as
 * Roll-forward & disclosure, for one obligation as at the selected period.
 */

import { termYears } from '../engine/dates';
import { directFromLines, settlementInForce, type Derived } from '../engine/derive';
import type { RegisterBooks } from './registerBooks';
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
