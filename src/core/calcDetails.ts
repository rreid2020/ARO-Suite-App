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

export type CalcDetailGroup = 'Baseline' | 'Opening' | 'Activity' | 'Closing';
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

/** Provision statement: baseline, then posted books through the selected period. */
export function obligationCalcLines(
  o: Obligation,
  books: RegisterBooks,
  d: Derived | undefined,
  unit: ReportingUnit,
): CalcDetailLine[] {
  const originalSettle = o.settlementDate;
  const adjustedSettle = d?.settlementUsed ?? settlementInForce(o);
  const accretion = books.accretionExisting + books.accretionNew;
  return [
    money('initialCost', 'Initial cost estimate', 'Baseline', initialCost(o)),
    money('currentCost', 'Cost estimate in current year dollars', 'Baseline', d?.cce ?? null),
    yearsLine('initialTerm', 'Initial term', termFromFyEnd(unit, originalSettle), originalSettle ? `settlement ${originalSettle}` : undefined),
    yearsLine('adjustedTerm', 'Adjusted term', d?.tD ?? termFromFyEnd(unit, adjustedSettle), adjustedSettle ? `settlement ${adjustedSettle}` : undefined),
    money('opening', 'Opening provision', 'Opening', books.openingProvision),
    money('settlement', 'Settlement', 'Activity', books.settlement),
    money('accretion', 'Accretion expense', 'Activity', accretion),
    money('cost', 'Change of estimate — cost adjustments', 'Activity', books.costAdjustments),
    money('term', 'Change of estimate — term adjustments', 'Activity', books.termAdjustments),
    money('writeOff', 'Change of estimate — write-offs', 'Activity', books.writeOffs),
    money('mass', 'Change of estimate — year-end mass update (inflation and interest rates)', 'Activity', books.massUpdate),
    money('newAro', 'New ARO', 'Activity', books.newAro),
    money('fx', 'Exchange differences', 'Activity', books.fx),
    money('closing', 'Closing provision', 'Closing', books.closingProvision),
  ];
}

/** ARO asset statement: useful life as at the selected period, then posted books. */
export function assetCalcLines(o: Obligation, books: RegisterBooks, life: UsefulLife): CalcDetailLine[] {
  return [
    yearsLine('totalUl', 'Total useful life', life.totalYears),
    yearsLine('expiredUl', 'Expired useful life', life.expiredYears),
    yearsLine('remainingUl', 'Remaining useful life', life.remainingYears),
    money('opening', 'Opening ARO asset', 'Opening', books.openingArc),
    money('additions', 'Additions', 'Activity', books.newAro),
    money('cost', 'Change of estimate — cost adjustments', 'Activity', books.costAdjustments),
    money('term', 'Change of estimate — term adjustments', 'Activity', books.termAdjustments),
    money('writeOff', 'Change of estimate — write-offs', 'Activity', books.writeOffs),
    money('mass', 'Change of estimate — year-end mass update (inflation and interest rates)', 'Activity', books.massUpdate),
    money('amort', 'Amortization expense', 'Activity', -books.amortization),
    money('closing', 'Closing ARO asset', 'Closing', books.closingArc),
  ];
}
