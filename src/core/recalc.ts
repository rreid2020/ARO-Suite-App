/**
 * Mode 1 — the recalculation register.
 *
 * The engine (`src/engine/recalc.ts`) prices one row. This is everything that
 * happens across the register: the portfolio totals, the completeness control
 * total, the exception list that decides whether the recalculation may be
 * finalised, and the two extract merges that build the register in the first
 * place.
 *
 * Pure — no React, no storage, no dates-of-today. Every function takes the
 * register and returns a value, so the same code runs in a test, on a server
 * and in the screen.
 */

import {
  Materiality,
  RecalcAssumptions,
  RecalcCurve,
  RecalcRow,
  curveMaxTerm,
  recalcCurveTerm,
  recalculate,
  sourceFigures,
  varianceFlag,
} from '../engine/recalc';
import { money } from './format';

/* ══ The built-in curve ════════════════════════════════════════════════ */

/**
 * The FY26 curve the tool falls back on until the client's own table is
 * imported. Whole-year terms 1-30, rates as decimals.
 *
 * Running on it is a REVIEW exception, never a silent default: the rates are a
 * plausible sovereign curve, not this client's, and every figure derived from
 * them is illustrative.
 */
const BUILT_IN_RATES = [
  2.34012, 2.51457, 2.63207, 2.73938, 2.844, 2.94689, 3.04639, 3.14023, 3.22647, 3.3039,
  3.37203, 3.43101, 3.4815, 3.52442, 3.5609, 3.59206, 3.61897, 3.6426, 3.66373, 3.683,
  3.70084, 3.71757, 3.73335, 3.74822, 3.76215, 3.77501, 3.78666, 3.79691, 3.80556, 3.81243,
];

export const BUILT_IN_CURVE: RecalcCurve = {
  asAt: '31.03.2026 (built-in FY26 curve)',
  points: BUILT_IN_RATES.map((rate, i) => ({ term: i + 1, rate: rate / 100 })),
};

/* ══ State ═════════════════════════════════════════════════════════════ */

/** Where an extract came from — INVARIANTS §6. Shown on every export. */
export interface ExtractProvenance {
  /** Every file merged into this extract, in the order they were applied. */
  files: string[];
  /** One line describing what the last merge did. */
  summary: string;
}

export interface RecalcRegister {
  fyEnd: string;
  /** Inflation / escalation, decimal. */
  inflation: number;
  materiality: Materiality;
  rows: RecalcRow[];
  /** The client's imported curve, or null while the built-in one applies. */
  curve: RecalcCurve | null;
  curveSource: string;
  rep04: ExtractProvenance | null;
  rep06: ExtractProvenance | null;
  /**
   * Total ARO present value per the source system's trial balance — the
   * completeness control total. Null until it is entered; nothing is derived
   * from it, which is the point.
   */
  trialBalancePv: number | null;
  /** True while the register still holds illustrative rows rather than an extract. */
  seeded: boolean;
  /** Who concluded on the variance analysis, or null while it is outstanding. */
  signedOff: { by: string; at: string } | null;
}

/**
 * A new register for a reporting unit.
 *
 * It starts empty and **seeded false with no rows**, not with illustrative
 * figures. The prototype shipped three obligations lifted from the client's
 * Master Sheet so the demo had something to show; those are real client
 * numbers, and the handoff README is explicit that none of the bundle's data
 * should ship. An empty register reads its way to the same place — the REP04
 * and REP06 blockers are open until the extracts arrive.
 */
export function emptyRecalcRegister(fyEnd: string): RecalcRegister {
  return {
    fyEnd,
    inflation: 0.02,
    materiality: { usd: 1000, pct: 0.1 },
    rows: [],
    curve: null,
    curveSource: '',
    rep04: null,
    rep06: null,
    trialBalancePv: null,
    seeded: false,
    signedOff: null,
  };
}

/** The curve in force: the client's when one is loaded, else the built-in. */
export function curveInForce(reg: Pick<RecalcRegister, 'curve'>): RecalcCurve {
  return reg.curve && reg.curve.points.length ? reg.curve : BUILT_IN_CURVE;
}

export function assumptionsOf(reg: RecalcRegister): RecalcAssumptions {
  return { fyEnd: reg.fyEnd, inflation: reg.inflation };
}

/* ══ Portfolio totals ══════════════════════════════════════════════════ */

export interface PortfolioTotals {
  /** Rows in the register. */
  count: number;
  /** Rows carrying both source figures — the tested population. */
  covered: number;
  cce: number;
  fv: number;
  /** Recalculated PV across every row, compared or not. */
  pv: number;
  /** Recalculated PV across the compared rows only. */
  comparedPv: number;
  /** Reported PV across the compared rows. */
  reportedPv: number;
  /** Reported less recalculated, over the compared rows. */
  variance: number;
  flagged: number;
  flag: 'PASS' | 'VARIANCE';
}

/**
 * The portfolio, totalled.
 *
 * `pv` and `comparedPv` are both here on purpose. The variance is only
 * meaningful over the rows that carry a reported figure, so it is struck
 * against `comparedPv`; but the provision the register measures is `pv`, over
 * every row. Netting one against the other would understate the variance by
 * exactly the balances that were never tested.
 */
export function portfolioTotals(reg: RecalcRegister, rows: RecalcRow[] = reg.rows): PortfolioTotals {
  const a = assumptionsOf(reg);
  const curve = curveInForce(reg);
  const t: PortfolioTotals = {
    count: rows.length,
    covered: 0,
    cce: 0,
    fv: 0,
    pv: 0,
    comparedPv: 0,
    reportedPv: 0,
    variance: 0,
    flagged: 0,
    flag: 'PASS',
  };

  for (const row of rows) {
    const k = recalculate(row, a, curve);
    const s = sourceFigures(row);
    t.cce += k.cce;
    t.fv += k.fv;
    t.pv += k.pv;
    if (!s.has) continue;
    t.covered += 1;
    t.comparedPv += k.pv;
    t.reportedPv += s.pv;
    if (varianceFlag(s.pv - k.pv, s.pv, reg.materiality) === 'VARIANCE') t.flagged += 1;
  }

  t.variance = t.reportedPv - t.comparedPv;
  t.flag = varianceFlag(t.variance, t.reportedPv, reg.materiality);
  return t;
}

/* ══ Completeness ══════════════════════════════════════════════════════ */

export type CompletenessStatus = 'NOT ENTERED' | 'AGREES' | 'DIFFERENCE';

export interface Completeness {
  status: CompletenessStatus;
  /** Σ reported PV across the register. */
  reportedPv: number;
  /** Σ recalculated PV across the register. */
  recalculatedPv: number;
  /** Trial balance less reported. The completeness test. */
  vsReported: number;
  /** Trial balance less recalculated. Context, not the test. */
  vsRecalculated: number;
  covered: number;
  count: number;
  note: string;
}

/**
 * The completeness test — INVARIANTS §5, nothing silently dropped.
 *
 * The recalculation can only conclude on the obligations it was given. Agreeing
 * the extract to an independently-sourced trial balance total is what proves
 * the population was whole; without it a perfect recalculation of half the
 * balance still reads as a clean result.
 *
 * The test is struck against the *reported* total, not the recalculated one. A
 * difference against reported means obligations are missing from the extract; a
 * difference against recalculated would just be the variance again, measured
 * twice.
 */
export function completeness(reg: RecalcRegister): Completeness {
  const t = portfolioTotals(reg);
  const entered = reg.trialBalancePv !== null && Number.isFinite(reg.trialBalancePv);
  const tb = entered ? (reg.trialBalancePv as number) : 0;
  const vsReported = tb - t.reportedPv;
  const vsRecalculated = tb - t.pv;
  const agrees = Math.abs(Math.round(vsReported * 100) / 100) <= reg.materiality.usd;

  return {
    status: !entered ? 'NOT ENTERED' : agrees ? 'AGREES' : 'DIFFERENCE',
    reportedPv: t.reportedPv,
    recalculatedPv: t.pv,
    vsReported,
    vsRecalculated,
    covered: t.covered,
    count: t.count,
    note: !entered
      ? 'Enter the total ARO present value carried on the source trial balance to prove the extract population is complete. Nothing is derived from it — it is your independent control total.'
      : agrees
        ? 'The reported population agrees to the trial balance within materiality, so the obligations tested are complete.'
        : 'The reported population does not agree to the trial balance. Obligations may be missing from the extract, or the trial balance may carry balances outside this register — resolve before concluding on the recalculation.',
  };
}

/* ══ Exceptions ════════════════════════════════════════════════════════ */

export type Severity = 'BLOCKER' | 'REVIEW' | 'INFO';

export interface Exception {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** How many obligations it covers. 0 for a register-wide matter. */
  count: number;
  /** The step that resolves it. */
  screen: string;
  action: string;
}

export interface ExceptionReport {
  items: Exception[];
  blockers: number;
  reviews: number;
  infos: number;
  /** True when nothing bars finalising. Anything left is a matter to explain. */
  clear: boolean;
}

/** "1104279, 1104240, … +4 more" — enough to recognise, not a wall of ids. */
function list(ids: string[]): string {
  return ids.slice(0, 6).join(', ') + (ids.length > 6 ? ` +${ids.length - 6} more` : '');
}

/**
 * Everything standing between the register and a finalised recalculation —
 * INVARIANTS §4: evaluated, never asserted.
 *
 * Nothing here is a checkbox. Each item reads live state and computes its own
 * pass/fail, so an exception cannot be ticked away — it goes when the data that
 * caused it changes. The severities are a hierarchy of consequence, not of
 * annoyance:
 *
 * - **BLOCKER** — the recalculation cannot be concluded. Either the data has no
 *   answer in it, or the tested population is not proven complete.
 * - **REVIEW** — it can be concluded, but the matter needs an explanation on
 *   file before it is.
 * - **INFO** — context a reviewer should have seen.
 */
export function exceptions(reg: RecalcRegister): ExceptionReport {
  const items: Exception[] = [];
  const add = (
    id: string,
    severity: Severity,
    title: string,
    detail: string,
    count: number,
    screen: string,
    action: string,
  ) => items.push({ id, severity, title, detail, count, screen, action });

  const a = assumptionsOf(reg);
  const curve = curveInForce(reg);
  const maxTerm = curveMaxTerm(curve);
  const m = reg.materiality;

  const noCost: string[] = [];
  const noSettlement: string[] = [];
  const noSource: string[] = [];
  const pvVariance: string[] = [];
  const fvVariance: string[] = [];
  const beyond: string[] = [];
  const overridden: string[] = [];
  const seen: Record<string, true> = {};
  const duplicates: Record<string, true> = {};
  let pvVarianceTotal = 0;

  for (const row of reg.rows) {
    const k = recalculate(row, a, curve);
    const s = sourceFigures(row);
    const id = String(row.id);

    if (seen[id]) duplicates[id] = true;
    else seen[id] = true;

    if (!row.cost) noCost.push(id);
    if (!row.settlementDate) noSettlement.push(id);
    if (row.rateOverride !== null && row.rateOverride !== undefined) overridden.push(id);
    // Measured on the uncapped term: an obligation is past the end of the curve
    // whether or not the cap has already quietly pulled it back.
    if (recalcCurveTerm(curve, k.tD).beyond) beyond.push(id);

    if (!s.has) {
      noSource.push(id);
      continue;
    }
    if (varianceFlag(s.pv - k.pv, s.pv, m) === 'VARIANCE') {
      pvVariance.push(id);
      pvVarianceTotal += s.pv - k.pv;
    }
    if (varianceFlag(s.fv - k.fv, s.fv, m) === 'VARIANCE') fvVariance.push(id);
  }

  if (!reg.rep04)
    add('rep04-missing', 'BLOCKER', 'REP04 not imported',
      'Cost estimates and cost estimate dates are illustrative figures, not client data.',
      0, 'recalc-import', 'Import REP04');

  if (!reg.rep06)
    add('rep06-missing', 'BLOCKER', 'REP06 not imported',
      'There are no source figures to compare the recalculation against.',
      0, 'recalc-import', 'Import REP06');

  const dupes = Object.keys(duplicates);
  if (dupes.length)
    add('duplicate-ids', 'BLOCKER', 'Duplicate obligation numbers',
      `The same obligation appears more than once, so it is counted twice in every total: ${list(dupes)}`,
      dupes.length, 'recalculation', 'Open register');

  if (noCost.length)
    add('no-cost', 'BLOCKER', 'Obligations with no cost estimate',
      `Reported by the source system but absent from REP04, so nothing can be escalated: ${list(noCost)}`,
      noCost.length, 'recalculation', 'Open register');

  if (noSettlement.length)
    add('no-settlement', 'BLOCKER', 'Obligations with no settlement date',
      `REP06 supplied no current end date, so the term and the discount rate cannot be determined: ${list(noSettlement)}`,
      noSettlement.length, 'recalculation', 'Open register');

  const comp = completeness(reg);
  if (comp.status === 'NOT ENTERED')
    add('tb-missing', 'BLOCKER', 'Trial balance total not entered',
      'The completeness control total has not been captured, so the reported population is unproven.',
      0, 'recalc-compare', 'Enter total');
  else if (comp.status === 'DIFFERENCE')
    add('tb-difference', 'BLOCKER', 'Reported figures do not agree to the trial balance',
      `Difference of ${signed(comp.vsReported)} between the trial balance and the sum of reported present values — obligations may be missing from the extracts.`,
      0, 'recalc-compare', 'Reconcile');

  if (pvVariance.length)
    add('pv-variance', 'BLOCKER', 'PV variances above materiality',
      `${pvVariance.length.toLocaleString('en-US')} obligations breach ${money(m.usd)} / ${m.pct}%, ${signed(pvVarianceTotal)} in aggregate: ${list(pvVariance)}`,
      pvVariance.length, 'recalc-compare', 'Investigate');

  if (fvVariance.length)
    add('fv-variance', 'REVIEW', 'FV variances above materiality',
      `The future value at settlement does not agree, which points at the cost estimate, the inflation rate or the dates rather than the discount rate: ${list(fvVariance)}`,
      fvVariance.length, 'recalc-compare', 'Investigate');

  if (noSource.length)
    add('no-source', 'REVIEW', 'Obligations with no source figures',
      `Recalculated but never compared, so they are outside the tested population: ${list(noSource)}`,
      noSource.length, 'recalc-compare', 'Review');

  if (!reg.curve)
    add('curve-missing', 'REVIEW', 'Interest rate curve not imported',
      'Discount rates come from the built-in FY26 curve rather than the client curve for this year end.',
      0, 'recalc-import', 'Import curve');
  else if (reg.curve.asAt && !vintageMatchesYearEnd(reg.curve.asAt, reg.fyEnd))
    add('curve-vintage', 'REVIEW', 'Curve vintage may not match the year end',
      `Curve valid on ${reg.curve.asAt} against an FY year end of ${reg.fyEnd}.`,
      0, 'recalc-import', 'Check curve');

  if (beyond.length)
    add('beyond-curve', 'REVIEW', 'Terms beyond the end of the curve',
      `The longest curve term is ${maxTerm} years and these settle later, so that final rate is applied flat: ${list(beyond)}`,
      beyond.length, 'recalc-import', 'Check policy');

  if (overridden.length)
    add('rate-override', 'REVIEW', 'Manual discount rate overrides in use',
      `The curve lookup has been overridden, which needs an explanation on file: ${list(overridden)}`,
      overridden.length, 'recalculation', 'Open register');

  if (m.usd === 0 && m.pct === 0)
    add('materiality-nil', 'INFO', 'Materiality set to nil',
      'Every difference other than an exact match is flagged. Raise the thresholds to work to a materiality level.',
      0, 'recalc-compare', 'Set materiality');

  if (!reg.signedOff)
    add('unsigned', 'INFO', 'Variance conclusion not signed off',
      'The reviewer sign-off on the variance analysis is outstanding.',
      0, 'recalc-variance', 'Sign off');

  const blockers = items.filter((i) => i.severity === 'BLOCKER').length;
  return {
    items,
    blockers,
    reviews: items.filter((i) => i.severity === 'REVIEW').length,
    infos: items.filter((i) => i.severity === 'INFO').length,
    clear: blockers === 0,
  };
}

/**
 * Whether a curve's stated vintage plausibly belongs to this year end.
 *
 * Client curve files spell the date however their system exports it, so this
 * matches on the year and, when the file gives a recognisable day and month, on
 * those too. It is deliberately permissive: the exception it raises is a REVIEW
 * asking a human to look, so a false negative wastes a glance while a false
 * positive hides a curve from the wrong year.
 */
export function vintageMatchesYearEnd(vintage: string, fyEnd: string): boolean {
  const [y, m, d] = fyEnd.split('-');
  if (!y) return true;
  if (vintage.indexOf(y) < 0) return false;
  const digits = vintage.replace(/\D/g, '');
  // A vintage carrying the year alone is as much as some files state.
  if (digits.length <= 4) return true;
  return digits.indexOf(d + m) >= 0 || digits.indexOf(m + d) >= 0 || digits.indexOf(y + m + d) >= 0;
}

function signed(n: number): string {
  const r = Math.round(n * 100) / 100;
  return (r > 0 ? '+' : r < 0 ? '-' : '') + money(Math.abs(r));
}

/* ══ Extract merges ════════════════════════════════════════════════════ */

/** One row as read out of an extract, before it is merged. */
export interface Rep04Line {
  id: string;
  cost: number;
  costEstimateDate: string;
}

export interface Rep06Line {
  id: string;
  settlementDate: string;
  fv: number | null;
  pv: number | null;
}

export interface MergeResult {
  rows: RecalcRow[];
  added: number;
  updated: number;
  /** Rows the extract carried that could not be used. */
  skipped: number;
  summary: string;
}

/**
 * Merge a REP04 extract into the register.
 *
 * Each obligation type is a separate run in the source system, so REP04 arrives
 * as several files and they **merge by obligation number** rather than
 * replacing the register. The first real extract clears the illustrative rows;
 * after that every file adds to what is already there.
 *
 * A row without an id, a date or a usable cost is skipped and counted. It is
 * counted rather than dropped because INVARIANTS §5 does not allow a silent
 * loss — the count is what tells a reviewer to go and look at the file.
 */
export function mergeRep04(rows: RecalcRow[], seeded: boolean, lines: Rep04Line[], file: string): MergeResult {
  const base = seeded ? [] : rows.slice();
  const at: Record<string, number> = {};
  base.forEach((r, i) => {
    at[String(r.id)] = i;
  });

  const seen: Record<string, true> = {};
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const line of lines) {
    if (!line.id || seen[line.id] || !line.costEstimateDate || !Number.isFinite(line.cost)) {
      skipped += 1;
      continue;
    }
    seen[line.id] = true;
    const i = at[line.id];
    if (i === undefined) {
      at[line.id] = base.length;
      base.push({
        id: line.id,
        cost: line.cost,
        costEstimateDate: line.costEstimateDate,
        settlementDate: '',
        rateOverride: null,
        sourceFv: null,
        sourcePv: null,
      });
      added += 1;
    } else {
      base[i] = { ...base[i], cost: line.cost, costEstimateDate: line.costEstimateDate };
      updated += 1;
    }
  }

  return {
    rows: base,
    added,
    updated,
    skipped,
    summary: `${base.length.toLocaleString('en-US')} obligations · last: ${file} (${added.toLocaleString('en-US')} new, ${updated.toLocaleString('en-US')} updated${skipped ? `, ${skipped.toLocaleString('en-US')} skipped` : ''})`,
  };
}

/**
 * Merge a REP06 extract into the register.
 *
 * REP06 is the source of the settlement (current end) date as well as the
 * figures to compare against, so it writes both.
 *
 * An obligation the source system reports that is **absent from REP04** is
 * carried into the register rather than dropped. It has no cost estimate, so it
 * cannot be recalculated — and that is exactly the point: it surfaces as a "no
 * cost estimate" blocker instead of quietly shrinking the population the
 * completeness total is measured against.
 */
export function mergeRep06(rows: RecalcRow[], lines: Rep06Line[], file: string): MergeResult {
  const by: Record<string, Rep06Line> = {};
  for (const line of lines) if (line.id) by[line.id] = line;

  const usable = (l: Rep06Line) =>
    l.fv !== null && l.pv !== null && Number.isFinite(l.fv) && Number.isFinite(l.pv);

  const hit: Record<string, true> = {};
  let matched = 0;
  const next = rows.map((row) => {
    const line = by[String(row.id)];
    if (!line) return row;
    hit[String(row.id)] = true;
    matched += 1;
    const out = { ...row };
    if (line.settlementDate) out.settlementDate = line.settlementDate;
    if (usable(line)) {
      out.sourceFv = line.fv;
      out.sourcePv = line.pv;
    }
    return out;
  });

  let brought = 0;
  for (const id of Object.keys(by)) {
    if (hit[id]) continue;
    const line = by[id];
    next.push({
      id,
      cost: 0,
      costEstimateDate: '',
      settlementDate: line.settlementDate || '',
      rateOverride: null,
      sourceFv: usable(line) ? line.fv : null,
      sourcePv: usable(line) ? line.pv : null,
    });
    brought += 1;
  }

  const total = Object.keys(by).length;
  return {
    rows: next,
    added: brought,
    updated: matched,
    skipped: 0,
    summary: `${matched.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} matched · last: ${file}${brought ? ` (${brought.toLocaleString('en-US')} not in REP04)` : ''}`,
  };
}

/** Append a file to an extract's provenance. */
export function withFile(prior: ExtractProvenance | null, file: string, summary: string): ExtractProvenance {
  const files = (prior?.files ?? []).concat([file]);
  const label = files.length === 1 ? 'extract' : 'extracts';
  return { files, summary: `${files.length} ${label} · ${summary}` };
}
