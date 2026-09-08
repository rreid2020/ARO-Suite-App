/**
 * Roll-forward — INVARIANTS §1.
 *
 *   opening + additions + accretion + revisions + settlements + FX = closing
 *
 * Per period, footing to the cent, and the periods summing to the annual
 * roll-forward. This single identity is three things at once: the completeness
 * test, the close control and the audit assertion.
 *
 * It is computed here from the *event ledger*, deliberately independently of the
 * journals. The check that a batch's net movement to the provision accounts
 * equals closing less opening is only falsifiable if the two are derived
 * separately — so nothing in this file may read a journal.
 */

export type EventType =
  | 'opening'
  | 'addition'
  | 'accretion'
  | 'revision'
  | 'revision-unproductive'
  | 'settlement'
  | 'fx'
  /** Asset-side amortization. Not a provision movement — ignored by the identity. */
  | 'depreciation'
  /** New obligation charged to expense (no ARO asset). Counts as an addition on the identity. */
  | 'expense-recognition'
  /** Provision extinguished because the related TCA was sold. Counts as a settlement on the identity. */
  | 'disposal'
  /** Take the retirement-cost asset off the books against accumulated amortization. Not a provision movement. */
  | 'asset-retirement'
  /** Slice of a downward revision that cannot hit the asset without taking NBV below zero. Credits accretion; reduces the provision. */
  | 'downward-excess';

/** Provision movements that enter the roll-forward identity. */
export const PROVISION_EVENT_TYPES: EventType[] = [
  'opening', 'addition', 'expense-recognition', 'accretion', 'revision', 'revision-unproductive', 'downward-excess', 'settlement', 'disposal', 'fx',
];

/** Every event type the ledger can hold. Asset-side types are omitted from the provision identity. */
export const LEDGER_EVENT_TYPES: EventType[] = [
  ...PROVISION_EVENT_TYPES, 'depreciation', 'asset-retirement',
];

export interface ObligationEvent {
  id: string;
  obligationId: string;
  periodId: string;
  type: EventType;
  date: string;
  amount: number;
  /** INVARIANTS §6 — an event inferred by diffing a cumulative snapshot. */
  derived?: boolean;
  sourceRowRef?: string;
  note?: string;
}

export interface RollForward {
  periodId: string;
  opening: number;
  additions: number;
  accretion: number;
  revisions: number;
  settlements: number;
  fx: number;
  /** Opening plus the five movements. */
  closing: number;
  /** Closing as the engine measures it, independently of the ledger. */
  measuredClosing: number | null;
  /** measuredClosing − closing. Must be nil to the cent for the period to close. */
  residual: number;
  foots: boolean;
}

/** Cent tolerance. Anything at or below this is treated as footing. */
export const CENT = 0.005;

export function rollForward(
  events: ObligationEvent[],
  periodId: string,
  measuredClosing: number | null = null,
): RollForward {
  const inPeriod = events.filter((e) => e.periodId === periodId);
  const bucket = (t: EventType) =>
    inPeriod.filter((e) => e.type === t).reduce((s, e) => s + e.amount, 0);

  const opening = bucket('opening');
  const additions = bucket('addition') + bucket('expense-recognition');
  const accretion = bucket('accretion');
  const revisions = bucket('revision') + bucket('revision-unproductive') + bucket('downward-excess');
  const settlements = bucket('settlement') + bucket('disposal');
  const fx = bucket('fx');
  const closing = opening + additions + accretion + revisions + settlements + fx;
  const residual = measuredClosing === null ? 0 : measuredClosing - closing;

  return {
    periodId,
    opening,
    additions,
    accretion,
    revisions,
    settlements,
    fx,
    closing,
    measuredClosing,
    residual,
    foots: Math.abs(residual) <= CENT,
  };
}

/** The annual roll-forward. The periods must sum to it — INVARIANTS §1. */
export function annualRollForward(periods: RollForward[]): RollForward {
  const sum = (k: keyof RollForward) =>
    periods.reduce((s, p) => s + (p[k] as number), 0);

  const opening = periods.length ? periods[0].opening : 0;
  const additions = sum('additions');
  const accretion = sum('accretion');
  const revisions = sum('revisions');
  const settlements = sum('settlements');
  const fx = sum('fx');
  const closing = opening + additions + accretion + revisions + settlements + fx;
  const measuredClosing = periods.length ? periods[periods.length - 1].measuredClosing : null;
  const residual = measuredClosing === null ? 0 : measuredClosing - closing;

  return {
    periodId: 'FY',
    opening,
    additions,
    accretion,
    revisions,
    settlements,
    fx,
    closing,
    measuredClosing,
    residual,
    foots: Math.abs(residual) <= CENT,
  };
}

/**
 * ENGINE-SPEC §7 — accretion is allocated across periods weighted by balance
 * *and* by the rate in force for that period. A rate table loaded during period
 * n governs the periods after it, so period 12 accretes on the period 11 table.
 */
export interface AccretionSlice {
  periodId: string;
  /** Provision balance carried through the period. */
  balance: number;
  /** The rate in force for this period, from the period-stamped rate table. */
  rate: number;
  /** Fraction of the year this period covers, on the 30/360 basis. */
  yearFraction: number;
}

export function allocateAccretion(total: number, slices: AccretionSlice[]): Map<string, number> {
  const weights = slices.map((s) => s.balance * s.rate * s.yearFraction);
  const denom = weights.reduce((a, b) => a + b, 0);
  const out = new Map<string, number>();

  if (denom === 0) {
    slices.forEach((s) => out.set(s.periodId, 0));
    return out;
  }

  // Allocate to the cent and put the rounding difference on the last slice, so
  // the allocation sums to the total exactly rather than nearly.
  let running = 0;
  slices.forEach((s, i) => {
    if (i === slices.length - 1) {
      out.set(s.periodId, round2(total - running));
    } else {
      const share = round2((weights[i] / denom) * total);
      out.set(s.periodId, share);
      running += share;
    }
  });
  return out;
}

/**
 * ENGINE-SPEC §9.8 — settlement.
 *
 * Released equals the provision carried × the share settled. An overrun goes to
 * operating costs; a surplus is written back. A posted full settlement removes
 * the obligation from the balance sheet.
 */
export interface SettlementResult {
  /** Provision released from the balance sheet. */
  released: number;
  /** Cash actually spent. */
  actualCost: number;
  /** Positive when the spend exceeded the provision — charged to operating costs. */
  overrun: number;
  /** Positive when the provision exceeded the spend — written back to income. */
  surplus: number;
  /** Provision remaining against the obligation after this settlement. */
  remaining: number;
  full: boolean;
}

export function settle(
  provisionCarried: number,
  share: number,
  actualCost: number,
): SettlementResult {
  const pct = clamp(share, 0, 1);
  const released = round2(provisionCarried * pct);
  const diff = round2(actualCost - released);
  return {
    released,
    actualCost,
    overrun: diff > 0 ? diff : 0,
    surplus: diff < 0 ? -diff : 0,
    remaining: round2(provisionCarried - released),
    full: pct >= 1,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
