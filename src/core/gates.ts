/**
 * Gates — INVARIANTS §4.
 *
 * "Every gate reads live state and computes its own result. The eight year-end
 * lock gates run in order; a gate below an unpassed gate reads *not reached*.
 * The sequence cannot be skipped and the lock is partner-only.
 *
 * A tenant may add its own gates. Those are labelled **attested** rather than
 * **evaluated**, because they are ticked by a person and not computed."
 *
 * The distinction is the whole point, so it is in the type, not in a label: an
 * evaluated gate carries a `check` function and cannot be ticked; an attested
 * gate carries no check and must be.
 */

export type GateState = 'pass' | 'fail' | 'not reached';

export interface GateResult {
  id: string;
  label: string;
  /** Evaluated gates compute their result. Attested gates are ticked by a person. */
  kind: 'evaluated' | 'attested';
  state: GateState;
  /** What the gate found, in the accounting. */
  detail: string;
}

export interface EvaluatedGate {
  id: string;
  label: string;
  kind: 'evaluated';
  /** Reads live state and computes its own pass/fail with a reason. */
  check: (s: YearEndState) => { pass: boolean; detail: string };
}

export interface AttestedGate {
  id: string;
  label: string;
  kind: 'attested';
  /** Ticked by a person. Never computed. */
  attestedBy?: string;
  attestedAt?: string;
  note: string;
}

export type Gate = EvaluatedGate | AttestedGate;

/** The live state the eight year-end gates read. Nothing here is a stored flag. */
export interface YearEndState {
  periods: { code: string; status: string }[];
  /** Annual roll-forward residual against the sum of the periods. */
  annualResidual: number;
  periodResiduals: { code: string; residual: number }[];
  conversionAgreed: boolean;
  conversionNote: string;
  batches: { number: string; status: string }[];
  subLedgerTotal: number;
  glTotal: number | null;
  packSigned: { stage: string; by: string; at: string }[];
  noteGenerated: boolean;
  yearLocked: boolean;
}

const CENT = 0.005;

/**
 * The eight year-end lock gates, in order — INVARIANTS §4.
 *
 * All periods closed · annual roll-forward foots to the sum of the periods ·
 * conversion agreed · every batch posted · sub-ledger tied · pack signed ·
 * note generated · year locked.
 */
export const YEAR_END_GATES: EvaluatedGate[] = [
  {
    id: 'periods-closed',
    label: 'All periods closed',
    kind: 'evaluated',
    check: (s) => {
      const open = s.periods.filter((p) => p.status !== 'Closed' && p.status !== 'Locked');
      return {
        pass: open.length === 0,
        detail: open.length
          ? `${open.length} period${open.length === 1 ? ' is' : 's are'} still open: ${open.map((p) => p.code).join(', ')}.`
          : `All ${s.periods.length} periods are closed or locked.`,
      };
    },
  },
  {
    id: 'rollforward-foots',
    label: 'Annual roll-forward foots to the sum of the periods',
    kind: 'evaluated',
    check: (s) => {
      const bad = s.periodResiduals.filter((p) => Math.abs(p.residual) > CENT);
      if (bad.length) {
        return {
          pass: false,
          detail: `${bad.length} period${bad.length === 1 ? '' : 's'} do not foot: ${bad.map((b) => `${b.code} out by ${b.residual.toFixed(2)}`).join(', ')}.`,
        };
      }
      return {
        pass: Math.abs(s.annualResidual) <= CENT,
        detail:
          Math.abs(s.annualResidual) <= CENT
            ? 'Opening + additions + accretion + revisions + settlements + FX equals closing, per period and for the year.'
            : `The annual roll-forward is out by ${s.annualResidual.toFixed(2)} against the sum of the periods.`,
      };
    },
  },
  {
    id: 'conversion-agreed',
    label: 'Opening balances locked',
    kind: 'evaluated',
    check: (s) => ({ pass: s.conversionAgreed, detail: s.conversionNote }),
  },
  {
    id: 'batches-posted',
    label: 'Every journal batch posted',
    kind: 'evaluated',
    check: (s) => {
      const unposted = s.batches.filter((b) => b.status !== 'Posted' && b.status !== 'Reversed');
      return {
        pass: unposted.length === 0,
        detail: unposted.length
          ? `${unposted.length} batch${unposted.length === 1 ? '' : 'es'} not posted: ${unposted.map((b) => `${b.number} (${b.status.toLowerCase()})`).join(', ')}.`
          : `All ${s.batches.length} batches are posted.`,
      };
    },
  },
  {
    id: 'subledger-tied',
    label: 'Sub-ledger tied to the general ledger',
    kind: 'evaluated',
    check: (s) => {
      // INVARIANTS §5 — an incomplete reconciliation is reported as incomplete,
      // never as a pass.
      if (s.glTotal === null) {
        return { pass: false, detail: 'No GL balance received, so the reconciliation is incomplete. It is not a pass.' };
      }
      const diff = s.subLedgerTotal - s.glTotal;
      return {
        pass: Math.abs(diff) <= CENT,
        detail:
          Math.abs(diff) <= CENT
            ? 'The ARO sub-ledger agrees to the provision accounts in the general ledger.'
            : `The sub-ledger is out by ${diff.toFixed(2)} against the general ledger.`,
      };
    },
  },
  {
    id: 'pack-signed',
    label: 'Completeness pack signed',
    kind: 'evaluated',
    check: (s) => ({
      pass: s.packSigned.length >= 3,
      detail: s.packSigned.length
        ? `Signed at ${s.packSigned.length} of 3 stages: ${s.packSigned.map((p) => `${p.stage} (${p.by})`).join(', ')}.`
        : 'The pack has not been signed. Sign-off is three-stage: preparer, reviewer, partner.',
    }),
  },
  {
    id: 'note-generated',
    label: 'Disclosure note generated',
    kind: 'evaluated',
    check: (s) => ({
      pass: s.noteGenerated,
      detail: s.noteGenerated
        ? 'The roll-forward and the disclosure note have been generated from the closing population.'
        : 'The disclosure note has not been generated from the closing population.',
    }),
  },
  {
    id: 'year-locked',
    label: 'Year locked',
    kind: 'evaluated',
    check: (s) => ({
      pass: s.yearLocked,
      detail: s.yearLocked
        ? 'The financial year is locked. Nothing further posts into it.'
        : 'The year is not locked. Locking is an engagement partner action and is the last gate.',
    }),
  },
];

/**
 * Run the sequence. A gate below an unpassed gate reads *not reached* — it is
 * not evaluated, because its inputs are not yet meaningful.
 */
export function runGates(gates: EvaluatedGate[], s: YearEndState): GateResult[] {
  let blocked = false;
  return gates.map((g) => {
    if (blocked) {
      return { id: g.id, label: g.label, kind: 'evaluated' as const, state: 'not reached' as const, detail: 'Not reached — an earlier gate has not passed.' };
    }
    const r = g.check(s);
    if (!r.pass) blocked = true;
    return { id: g.id, label: g.label, kind: 'evaluated' as const, state: (r.pass ? 'pass' : 'fail') as GateState, detail: r.detail };
  });
}

export function attestedResult(g: AttestedGate): GateResult {
  return {
    id: g.id,
    label: g.label,
    kind: 'attested',
    state: g.attestedBy ? 'pass' : 'fail',
    detail: g.attestedBy
      ? `Attested by ${g.attestedBy} on ${(g.attestedAt ?? '').slice(0, 10)}. This gate is ticked by a person, not computed.`
      : `${g.note} This gate is attested, not evaluated — it is ticked by a person and the product does not check it.`,
  };
}

/**
 * INVARIANTS §4 — "Deleting an evaluated gate must state that it removes a
 * control." This is the sentence to show before the deletion is accepted.
 */
export function deleteGateWarning(g: Gate): string {
  return g.kind === 'evaluated'
    ? `"${g.label}" is an evaluated gate: it reads live state and computes its own result. Deleting it removes a control, and the year-end lock will no longer test this condition.`
    : `"${g.label}" is an attested gate. Deleting it removes a prompt, not a control — nothing was being computed.`;
}
