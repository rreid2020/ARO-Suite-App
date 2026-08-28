/**
 * The calculation ladder.
 *
 * SCREENS.md: "the calculation ladder (one renderer, used in three places,
 * collapsed by default, each rung carrying operator, basis tag and Excel
 * formula)". Generating the rungs here rather than in a component is what lets
 * the register drawer, the recalculation screen and the Excel export show the
 * *same* ladder — and it is what makes INVARIANTS §9's "variance formulas in
 * exports stay self-contained and paste-ready" achievable, because the Excel
 * formula for a rung is written next to the number it produces.
 */

import { Assumptions, Derived, Obligation } from './derive';
import { Curve } from './curve';

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
  const r = (offset: number) => `B${startRow + offset}`;

  const rungs: Rung[] = [
    {
      key: 'direct',
      label: 'Direct cost',
      operator: 'Σ (qty × rate) over the build-up, plus recorded cost revisions',
      value: d.direct,
      basis: 'CURRENT',
      kind: 'money',
      formula: `=SUM(qty*rate) + ${fmt(d.costRevisions)}`,
      note:
        d.costRevisions !== 0
          ? `Includes ${fmt(d.costRevisions)} of cost revisions, entered gross of contingency.`
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
      operator: `30/360 term, cost estimate date ${o.costEstimateDate} → year end ${a.fyEnd}`,
      value: d.t1,
      basis: '',
      kind: 'term',
      formula: `=DAYS360(DATE(${dparts(o.costEstimateDate)}),DATE(${dparts(a.fyEnd)}),FALSE)/360`,
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
        ? `30/360 term, modified cost estimate date ${d.mcd} → settlement ${d.settlementUsed}`
        : `30/360 term, year end ${a.fyEnd} → settlement ${d.settlementUsed}`,
      value: d.t2,
      basis: '',
      kind: 'term',
      formula: `=DAYS360(DATE(${dparts(d.mcd)}),DATE(${dparts(d.settlementUsed)}),FALSE)/360`,
      note: d.leap
        ? 'The cost estimate date falls in a leap year, so this leg starts the day after the year end. The two legs then sum to the implied term under 30/360. Discounting is unaffected.'
        : undefined,
    },
    {
      key: 'fv',
      label: 'Fair value at settlement',
      operator: `Escalated cost × (1 + inflation ${pct(a.inflation)}) ^ leg 2`,
      value: d.fv,
      basis: 'FV@SETTLE',
      kind: 'money',
      formula: `=${r(3)}*(1+${a.inflation})^${r(4)}`,
    },
    {
      key: 'tD',
      label: 'Discount term',
      operator: `30/360 term, year end ${a.fyEnd} → settlement ${d.settlementUsed}`,
      value: d.tD,
      basis: '',
      kind: 'term',
      formula: `=DAYS360(DATE(${dparts(a.fyEnd)}),DATE(${dparts(d.settlementUsed)}),FALSE)/360`,
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
      operator: `Looked up on ${curve.name} (${curve.interpolation}) at ${num(d.curveTerm)} years — ${d.rateBasis}`,
      value: d.rate,
      basis: '',
      kind: 'rate',
      formula: `=LOOKUP on curve '${curve.name}' at ${r(7)}`,
      note: 'The rate is never entered per obligation. It is always looked up.',
    },
    {
      key: 'pv',
      label: 'Provision at year end',
      operator:
        d.tD > 0
          ? 'Fair value at settlement ÷ (1 + rate) ^ discount term'
          : 'Settlement falls on or before the year end, so no discounting applies',
      value: d.pv,
      basis: 'PV@FY-END',
      kind: 'money',
      formula: d.tD > 0 ? `=${r(5)}/(1+${r(8)})^${r(6)}` : `=${r(5)}`,
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
    { key: 'rate', label: 'Change in discount rate', operator: 'Reprice on the closing curve only', value: b.rateEffect, basis: 'PV@FY-END', kind: 'money', formula: `=${'pvRateOnly'} - ${'pvTimingOnly'}` },
    { key: 'infl', label: 'Change in inflation', operator: 'Reprice at the closing inflation rate only', value: b.inflEffect, basis: 'PV@FY-END', kind: 'money', formula: `=${'pv'} - ${'pvRateOnly'}` },
    { key: 'movement', label: 'Total movement', operator: 'The four effects, which sum without residual', value: b.movement, basis: 'PV@FY-END', kind: 'money', formula: '=SUM(effects)' },
  ];
}

function conventionWords(c: string, term: number): string {
  if (c === 'Round up to whole year (SAP)') return `Rounded up to the next whole year (SAP) — ${num(term)}`;
  if (c === 'Round up to the next curve point') return `Rounded up to the next published curve point — ${num(term)}`;
  return `Exact fractional years — ${num(term)}`;
}

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const num = (n: number) => (Math.round(n * 10000) / 10000).toString();
const dparts = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[1])},${Number(m[2])},${Number(m[3])}` : '1900,1,1';
};
