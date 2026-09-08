/**
 * The calculation ladder.
 *
 * SCREENS.md: "the calculation ladder (one renderer, used in three places,
 * collapsed by default, each rung carrying operator, basis tag and Excel
 * formula)". Generating the rungs here rather than in a component is what lets
 * the register drawer and the Excel export show the
 * *same* ladder — and it is what makes INVARIANTS §9's "variance formulas in
 * exports stay self-contained and paste-ready" achievable, because the Excel
 * formula for a rung is written next to the number it produces.
 */

import { Assumptions, Derived, Obligation } from './derive';
import { Curve } from './curve';
import { DayCount, DEFAULT_DAY_COUNT } from './dates';
import { money, num } from '../core/format';

function termFormula(from: string, to: string, dayCount: DayCount | string): string {
  const a = `DATE(${dparts(from)})`;
  const b = `DATE(${dparts(to)})`;
  switch (dayCount) {
    case '30E/360 (European)':
      return `=DAYS360(${a},${b},TRUE)/360`;
    case 'Actual/365':
      return `=YEARFRAC(${a},${b},3)`;
    case 'Actual/360':
      return `=YEARFRAC(${a},${b},2)`;
    case 'Actual/Actual':
      return `=YEARFRAC(${a},${b},1)`;
    default:
      return `=DAYS360(${a},${b},FALSE)/360`;
  }
}

function termOperator(fromLabel: string, from: string, toLabel: string, to: string, dayCount: string): string {
  return `${dayCount} term, ${fromLabel} ${from} → ${toLabel} ${to}`;
}

export interface Rung {
  key: string;
  label: string;
  /** The arithmetic that got here, in words. */
  operator: string;
  value: number;
  /** Empty for the term rungs, which are years rather than money. */
  basis: '' | 'CURRENT' | 'ESCALATED' | 'FV@SETTLE' | 'PV@FY-END';
  /** 'money' | 'term' | 'rate' — drives formatting. */
  kind: 'money' | 'term' | 'rate';
  /**
   * A self-contained Excel formula for this rung, referencing only the cells of
   * the rungs above it in the exported ladder block. `row` is substituted by the
   * exporter; in the UI it is shown as written.
   */
  formula: string;
  /** Flagged rungs carry a note the UI renders beneath them. */
  note?: string;
}

/**
 * Build the ladder for one derived obligation. Row references in the formulas
 * assume the ladder is written as a contiguous block with `direct` on `startRow`.
 */
export function ladderFor(
  o: Obligation,
  a: Assumptions,
  d: Derived,
  curve: Curve,
  startRow = 1,
): Rung[] {
  const dc = a.dayCount ?? DEFAULT_DAY_COUNT;
  const r = (offset: number) => `B${startRow + offset}`;

  const rungs: Rung[] = [
    {
      key: 'direct',
      label: 'Direct cost',
      operator: 'Σ (qty × rate) over the build-up, plus recorded cost revisions',
      value: d.direct,
      basis: 'CURRENT',
      kind: 'money',
      formula: `=SUM(qty*rate) + ${d.costRevisions.toFixed(2)}`,
      note:
        d.costRevisions !== 0
          ? `Includes ${money(d.costRevisions)} of cost revisions, entered gross of contingency.`
          : undefined,
    },
    {
      key: 'cost',
      label: 'Cost at current prices',
      operator: `Direct × (1 + contingency ${pct(a.contingency)})`,
      value: d.cost,
      basis: 'CURRENT',
      kind: 'money',
      formula: `=${r(0)}*(1+${a.contingency})`,
      note: 'Contingency is applied once, before escalation, so it applies to the revised figure.',
    },
    {
      key: 't1',
      label: 'Escalation leg 1',
      operator: termOperator('cost estimate date', o.costEstimateDate, 'year end', a.fyEnd, dc),
      value: d.t1,
      basis: '',
      kind: 'term',
      formula: termFormula(o.costEstimateDate, a.fyEnd, dc),
    },
    {
      key: 'cce',
      label: 'Cost escalated to year end',
      operator: `Cost × (1 + inflation ${pct(a.inflation)}) ^ leg 1`,
      value: d.cce,
      basis: 'ESCALATED',
      kind: 'money',
      formula: `=${r(1)}*(1+${a.inflation})^${r(2)}`,
    },
    {
      key: 't2',
      label: 'Escalation leg 2',
      operator: d.leap
        ? termOperator('modified cost estimate date', d.mcd, 'settlement', d.settlementUsed, dc)
        : termOperator('year end', a.fyEnd, 'settlement', d.settlementUsed, dc),
      value: d.t2,
      basis: '',
      kind: 'term',
      formula: termFormula(d.mcd, d.settlementUsed, dc),
      note: d.leap
        ? `The cost estimate date falls in a leap year, so this leg starts the day after the year end. The two legs then sum to the implied term under ${dc}. Discounting is unaffected.`
        : undefined,
    },
    {
      key: 'fv',
      label: 'Future value at settlement',
      operator: `Escalated cost × (1 + inflation ${pct(a.inflation)}) ^ leg 2`,
      value: d.fv,
      basis: 'FV@SETTLE',
      kind: 'money',
      formula: `=${r(3)}*(1+${a.inflation})^${r(4)}`,
    },
    {
      key: 'tD',
      label: 'Discount term',
      operator: termOperator('year end', a.fyEnd, 'settlement', d.settlementUsed, dc),
      value: d.tD,
      basis: '',
      kind: 'term',
      formula: termFormula(a.fyEnd, d.settlementUsed, dc),
    },
    {
      key: 'curveTerm',
      label: 'Term the curve is read at',
      operator: conventionWords(a.termConvention, d.curveTerm),
      value: d.curveTerm,
      basis: '',
      kind: 'term',
      formula:
        a.termConvention === 'Round up to whole year (SAP)'
          ? `=CEILING(${r(6)},1)`
          : a.termConvention === 'Exact fractional years'
            ? `=${r(6)}`
            : `=MATCH — first published point at or beyond ${r(6)}`,
      note: d.beyond
        ? `The term runs past the last published point on ${curve.name}. The ${curve.extrapolation} extrapolation policy applies and is stamped on this row.`
        : undefined,
    },
    {
      key: 'rate',
      label: 'Discount rate',
      operator: d.ratePerLayer
        ? `Carrying-weighted average of locked layer rates — ${d.rateBasis}`
        : d.discounted === false
          ? 'Discounting is not applied on this reporting unit'
          : `Looked up on ${curve.name} (${curve.interpolation}) at ${num(d.curveTerm)} years — ${d.rateBasis}`,
      value: d.rate,
      basis: '',
      kind: 'rate',
      formula: d.ratePerLayer || d.discounted === false
        ? `=${d.rate}`
        : `=LOOKUP on curve '${curve.name}' at ${r(7)}`,
      note: d.ratePerLayer
        ? 'Each layer keeps the rate locked on the day it arose. This figure is the carrying-weighted average.'
        : d.discounted === false
          ? 'PS 3280: this unit is measured undiscounted, so the rate is nil and the provision is the cost at current prices.'
          : 'The rate is never entered per obligation. It is always looked up.',
    },
    {
      key: 'pv',
      label: 'Provision at year end',
      operator:
        d.discounted === false
          ? 'Discounting is not applied, so the provision equals cost at current prices'
          : d.tD > 0
            ? (d.ratePerLayer
              ? 'Sum of each layer\'s future value at settlement ÷ (1 + locked rate) ^ remaining term'
              : 'Future value at settlement ÷ (1 + rate) ^ discount term')
            : 'Settlement falls on or before the year end, so no discounting applies',
      value: d.pv,
      basis: 'PV@FY-END',
      kind: 'money',
      formula: d.discounted === false || d.tD <= 0 ? `=${r(5)}` : `=${r(5)}/(1+${r(8)})^${r(6)}`,
    },
  ];

  return rungs;
}

/** The bridge, as a ladder. The four effects must sum to the movement. */
export function bridgeRungs(d: Derived): Rung[] {
  const b = d.bridge;
  return [
    { key: 'pvBase', label: 'Opening measurement', operator: 'Original cost, original timing, prior rate, prior inflation', value: b.pvBase, basis: 'PV@FY-END', kind: 'money', formula: '' },
    { key: 'cost', label: 'Change in cost estimate', operator: 'Reprice with the revised cost only', value: b.costEffect, basis: 'PV@FY-END', kind: 'money', formula: `=${'pvCostOnly'} - ${'pvBase'}` },
    { key: 'timing', label: 'Change in expected timing', operator: 'Reprice with the revised settlement date only', value: b.timingEffect, basis: 'PV@FY-END', kind: 'money', formula: `=${'pvTimingOnly'} - ${'pvCostOnly'}` },
    { key: 'rate', label: 'Change in discount rate', operator: d.ratePerLayer ? 'Existing layers keep their locked rates — a later curve does not remeasure them' : 'Reprice on the closing curve only', value: b.rateEffect, basis: 'PV@FY-END', kind: 'money', formula: `=${'pvRateOnly'} - ${'pvTimingOnly'}` },
    { key: 'infl', label: 'Change in inflation', operator: 'Reprice at the closing inflation rate only', value: b.inflEffect, basis: 'PV@FY-END', kind: 'money', formula: `=${'pv'} - ${'pvRateOnly'}` },
    { key: 'movement', label: 'Total movement', operator: 'The four effects, which sum without residual', value: b.movement, basis: 'PV@FY-END', kind: 'money', formula: '=SUM(effects)' },
  ];
}

function conventionWords(c: string, term: number): string {
  if (c === 'Round up to whole year (SAP)') return `Rounded up to the next whole year (SAP) — ${num(term)}`;
  if (c === 'Round up to the next curve point') return `Rounded up to the next published curve point — ${num(term)}`;
  return `Exact fractional years — ${num(term)}`;
}

const pct = (n: number) => `${num(n * 100, 2)}%`;
const dparts = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[1])},${Number(m[2])},${Number(m[3])}` : '1900,1,1';
};
