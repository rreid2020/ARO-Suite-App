/**
 * How a recorded cost or term adjustment became the posted provision.
 *
 * Cost adjustments are entered gross of contingency. The posted amount is the
 * change in present value: contingency, then inflation to settlement, then
 * discounting to the reporting date. Term adjustments reprice the whole obligation
 * at the new settlement date. The walk uses the assumptions and curve in force
 * now, reconstructed through the revision that produced the event.
 */

import { derive, type Assumptions, type DeriveOptions, type Derived, type Obligation, type Revision } from '../engine/derive';
import { ladderFor, type Rung } from '../engine/ladder';
import { matchedRevision } from './activity';
import { unitAssumptions, unitDeriveOptions } from './measure';
import type { AppState, ObligationEvent, ReportingUnit } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface WalkSnapshot {
  settlement: string;
  tD: number;
  rate: number;
  pv: number;
}

export interface RevisionWalk {
  kind: 'cost' | 'term';
  recorded: number | null;
  recordedDate?: string;
  posted: number;
  formula: string;
  rungs: Rung[];
  before: WalkSnapshot;
  after: WalkSnapshot;
  /** True when the increment chain foots to the PV movement. */
  foots: boolean;
}

function snap(d: Derived): WalkSnapshot {
  return { settlement: d.settlementUsed, tD: d.tD, rate: d.rate, pv: d.pv };
}

export function revisionsThrough(o: Obligation, rev: Revision): Revision[] {
  const all = o.adj ?? [];
  const i = all.findIndex((a) => a.id === rev.id);
  if (i >= 0) return all.slice(0, i + 1);
  return [...all, rev];
}

export function costIncrementFormula(recorded: number, a: Assumptions, d: Derived): string {
  let formula = `=${recorded}*(1+${a.contingency})`;
  if (Math.abs(d.fv - d.cost) > 1e-9) {
    formula += `*(1+${a.inflation})^${d.t1}*(1+${a.inflation})^${d.t2}`;
  }
  if (d.discounted !== false && d.tD > 0) {
    formula += `/(1+${d.rate})^${d.tD}`;
  }
  return formula;
}

function costSlice(o: Obligation, amount: number, settlement: string): Obligation {
  return {
    ...o,
    lines: [{ id: 'inc', description: 'Cost adjustment', qty: 1, rate: amount }],
    adj: [],
    settlementDate: settlement,
  };
}

export function revisionWalk(
  o: Obligation,
  rev: Revision,
  a: Assumptions,
  opt: DeriveOptions,
): RevisionWalk {
  const through = revisionsThrough(o, rev);
  const before = derive({ ...o, adj: through.slice(0, -1) }, a, opt);
  const after = derive({ ...o, adj: through }, a, opt);
  const posted = round2(after.pv - before.pv);

  if (rev.kind === 'term') {
    return {
      kind: 'term',
      recorded: null,
      recordedDate: rev.to,
      posted,
      formula: `=${after.pv}-${before.pv}`,
      rungs: [],
      before: snap(before),
      after: snap(after),
      foots: true,
    };
  }

  const amount = rev.amount ?? 0;
  const slice = costSlice(o, amount, after.settlementUsed);
  const inc = derive(slice, a, opt);
  const foots = Math.abs(round2(inc.pv) - posted) < 0.02;
  const rungs = foots
    ? ladderFor(slice, a, inc, opt.curve).map((rung, i) => (
      i === 0
        ? {
            ...rung,
            label: 'Recorded cost adjustment',
            operator: 'Entered gross of contingency',
            formula: `=${amount}`,
          }
        : rung
    ))
    : [];

  return {
    kind: 'cost',
    recorded: amount,
    posted,
    formula: costIncrementFormula(amount, a, inc),
    rungs,
    before: snap(before),
    after: snap(after),
    foots,
  };
}

export function revisionWalkForEvent(
  s: AppState,
  unit: ReportingUnit,
  o: Obligation,
  e: ObligationEvent,
): RevisionWalk | null {
  const rev = matchedRevision(o, e);
  if (!rev) return null;
  const period = (s.data[unit.id]?.periods ?? []).find((p) => p.id === e.periodId);
  return revisionWalk(o, rev, unitAssumptions(unit, period?.ends ?? e.date), unitDeriveOptions(s, unit));
}
