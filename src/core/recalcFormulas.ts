/**
 * The calculation, written as Excel.
 *
 * Not documentation of the engine — the engine *restated*, so an auditor can
 * paste the formula column into A1 of a blank sheet and reproduce every figure
 * the screen shows, unaided and offline. Each row references the rows above it
 * exactly as the chain chains its steps, and every date and rate is a literal,
 * so nothing else needs wiring up.
 *
 * That is the point of the whole tool: a recalculation nobody can reproduce is
 * an assertion, not evidence.
 */

import {
  Materiality,
  RecalcAssumptions,
  RecalcCurve,
  RecalcRow,
  curveMaxTerm,
  recalculate,
  sourceFigures,
  varianceFlag,
} from '../engine/recalc';
import { money } from './format';

export interface FormulaRow {
  /** The cell the formula belongs in. */
  ref: string;
  label: string;
  formula: string;
  /** What that formula evaluates to, formatted as the screen shows it. */
  value: string;
}

const q = (s: string) => `"${s}"`;
const signedMoney = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return (r > 0 ? '+' : r < 0 ? '-' : '') + money(Math.abs(r));
};
const signedPct = (n: number) => {
  const r = Math.round(n * 1e4) / 1e4;
  return `${r > 0 ? '+' : ''}${r.toFixed(4)}%`;
};

/**
 * The fifteen rows that reproduce one obligation.
 *
 * Two things differ from the prototype's panel, both so the pasted column
 * actually reproduces what the screen shows:
 *
 * - the curve term applies the same floor and cap the engine does
 *   (`MIN(MAX(ROUNDUP(…),1),max)`), where the prototype printed a bare
 *   `ROUNDUP` that disagreed with its own output for a capped term;
 * - the materiality test's percentage threshold is stated in percent, matching
 *   the register's own thresholds rather than silently switching to a fraction.
 */
export function formulasFor(
  row: RecalcRow,
  a: RecalcAssumptions,
  curve: RecalcCurve,
  m: Materiality,
): FormulaRow[] {
  const k = recalculate(row, a, curve);
  const s = sourceFigures(row);
  const inflPct = a.inflation * 100;
  const ratePct = k.rate * 100;
  const maxTerm = curveMaxTerm(curve);

  const termExpr = `DAYS360(${q(a.fyEnd)},${q(row.settlementDate)})/360`;
  const year = `YEAR(${q(row.costEstimateDate)})`;
  const leapTest = `OR(MOD(${year},400)=0,AND(MOD(${year},4)=0,MOD(${year},100)<>0))`;

  const rows: [string, string, string, string][] = [
    ['A1', 'Inflation rate (assumptions)', `=${inflPct.toFixed(2)}/100`, `${inflPct.toFixed(2)}%`],
    [
      'A2',
      `Discount rate — ${k.overridden ? 'manual override' : `curve term ${k.curveTerm}`}`,
      `=${ratePct.toFixed(5)}/100`,
      `${ratePct.toFixed(5)}%`,
    ],
    ['A3', 'Discount term, FY year end to settlement, 30/360', `=${termExpr}`, k.tD.toFixed(4)],
    [
      'A4',
      `Curve term — rounded up, floored at 1, capped at the end of the curve (${maxTerm} yrs)`,
      `=MIN(MAX(ROUNDUP(A3,0),1),${maxTerm})`,
      String(k.curveTerm),
    ],
    [
      'A5',
      'Modified cost estimate date — the day after the FY year end when the cost estimate date falls in a leap year',
      `=IF(${leapTest},DATEVALUE(${q(a.fyEnd)})+1,DATEVALUE(${q(a.fyEnd)}))`,
      k.mcd + (k.leap ? ' — leap-year adjustment applied' : ''),
    ],
    [
      'A6',
      'Escalation term, modified cost estimate date to settlement, 30/360',
      `=DAYS360(A5,${q(row.settlementDate)})/360`,
      k.t2.toFixed(4),
    ],
    [
      'A7',
      'Cost estimate at FY year end',
      `=${row.cost.toFixed(2)}*(1+A1)^(DAYS360(${q(row.costEstimateDate)},${q(a.fyEnd)})/360)`,
      money(k.cce),
    ],
    ['A8', 'FV at settlement', '=A7*(1+A1)^A6', money(k.fv)],
    ['A9', 'PV at FY year end', '=A8/(1+A2)^A3', money(k.pv)],
    ['A10', 'FV per source system (REP06)', `=${s.has ? s.fv.toFixed(2) : '0'}`, s.has ? money(s.fv) : '—'],
    ['A11', 'PV per source system (REP06)', `=${s.has ? s.pv.toFixed(2) : '0'}`, s.has ? money(s.pv) : '—'],
    ['A12', 'FV variance (reported less re-calculated)', '=A10-A8', s.has ? signedMoney(s.fv - k.fv) : '—'],
    ['A13', 'PV variance (reported less re-calculated)', '=A11-A9', s.has ? signedMoney(s.pv - k.pv) : '—'],
    [
      'A14',
      'PV variance as % of the reported balance',
      '=IF(A11=0,"",(A11-A9)/A11*100)',
      s.has && s.pv ? signedPct(((s.pv - k.pv) / s.pv) * 100) : '—',
    ],
    [
      'A15',
      `Materiality test — thresholds ${money(m.usd)} / ${m.pct}%`,
      `=IF(OR(ABS(ROUND(A13,2))>${m.usd},AND(A11<>0,ABS(ROUND(A13,2)/A11*100)>${m.pct})),"VARIANCE","PASS")`,
      s.has ? varianceFlag(s.pv - k.pv, s.pv, m) : 'NO SOURCE DATA',
    ],
  ];

  return rows.map(([ref, label, formula, value]) => ({ ref, label, formula, value }));
}
