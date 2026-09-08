/**
 * Engine posting cases — the economic journals the measurement emits.
 *
 * These are not an organisation's GL map (that is a posting *scenario* on the
 * chart). Each case is a debit role and a credit role. The organisation assigns
 * imported accounts to those roles on its posting scenarios.
 *
 * Derived from a public-sector ARO posting workbook (initial recognition,
 * revisions by remaining life, accretion, settlement true-up, disposal and
 * sale). Departmental financial coding is not part of the engine.
 */

import type { EventType } from './rollforward';

export type PostingKind = 'recognition' | 'revision' | 'accretion' | 'settlement' | 'sale';

export interface PostingFacts {
  kind: PostingKind;
  /** Signed provision movement for recognition/revision (positive = increase). */
  provisionDelta?: number;
  remainingUlYears: number | null;
  assetNbv: number;
  assetGross?: number;
  assetAccum?: number;
  inProductiveUse?: boolean;
  expiredUlYears?: number | null;
  totalUlYears?: number | null;
  settlement?: {
    share: number;
    actualCost: number;
    provisionCarried: number;
    disposeAsset?: boolean;
  };
}

export interface PlannedEntry {
  eventType: EventType;
  amount: number;
  note: string;
}

export interface CaseCompanion {
  eventType: EventType;
  debitRole: string;
  creditRole: string;
  when: string;
}

export interface EnginePostingCase {
  id: string;
  label: string;
  /** Workbook cross-reference, not a product code. */
  refs: string[];
  trigger: string;
  kind: PostingKind;
  /** The primary provision (or accretion) posting. Companion asset lines are planned separately. */
  debitRole: string;
  creditRole: string;
  eventType: EventType;
  /** Extra journals this case may emit. They use their own event rules. */
  companions?: CaseCompanion[];
}

export const ENGINE_POSTING_CASES: EnginePostingCase[] = [
  {
    id: 'initial-recognition',
    label: 'Initial recognition — capitalize',
    refs: ['ARO1'],
    kind: 'recognition',
    trigger: 'A new obligation is recognised while the related asset still has remaining useful life.',
    debitRole: 'Retirement cost asset',
    creditRole: 'ARO provision',
    eventType: 'addition',
  },
  {
    id: 'catch-up-recognition',
    label: 'Initial recognition after the asset is already in service',
    refs: ['ARO19'],
    kind: 'recognition',
    trigger: 'Recognition is recorded in a later period than the asset was placed in service. Capitalize, then catch up amortization for life already expired.',
    debitRole: 'Retirement cost asset',
    creditRole: 'ARO provision',
    eventType: 'addition',
    companions: [{
      eventType: 'depreciation',
      debitRole: 'Depreciation expense',
      creditRole: 'Accumulated depreciation',
      when: 'Catch-up amortization for life already expired (PV × expired UL / total UL).',
    }],
  },
  {
    id: 'expense-recognition',
    label: 'Initial recognition — charge to expense',
    refs: ['ARO20'],
    kind: 'recognition',
    trigger: 'A new obligation on an asset that is fully amortized and not in productive use. No retirement-cost asset is capitalized.',
    debitRole: 'Operating costs',
    creditRole: 'ARO provision',
    eventType: 'expense-recognition',
  },
  {
    id: 'upward-revision',
    label: 'Upward change of estimate',
    refs: ['ARO2', 'ARO3', 'ARO4', 'ARO5', 'ARO7', 'ARO9'],
    kind: 'revision',
    trigger: 'Cost, inflation, discount rate or expected settlement increases the provision while remaining useful life is positive. Same journal regardless of the cause.',
    debitRole: 'Retirement cost asset',
    creditRole: 'ARO provision',
    eventType: 'revision',
  },
  {
    id: 'revision-unproductive',
    label: 'Change of estimate on unproductive ARO asset',
    refs: ['ARO2', 'ARO3', 'ARO4', 'ARO5', 'ARO6', 'ARO8', 'ARO9'],
    kind: 'revision',
    trigger: 'A change of estimate after the related ARO asset is no longer in productive use. The provision moves, but the offset is operating expense instead of the ARO asset.',
    debitRole: 'Operating costs',
    creditRole: 'ARO provision',
    eventType: 'revision-unproductive',
  },
  {
    id: 'downward-revision-active',
    label: 'Downward change of estimate',
    refs: ['ARO6', 'ARO8'],
    kind: 'revision',
    trigger: 'A downward revision debits the provision and credits the retirement-cost asset by the full change. If that would take NBV below zero, accumulated amortization is reversed against amortization expense until NBV is zero. If accumulated amortization is not enough, the remainder of the provision reduction is credited to accretion expense.',
    debitRole: 'ARO provision',
    creditRole: 'Retirement cost asset',
    eventType: 'revision',
    companions: [
      {
        eventType: 'depreciation',
        debitRole: 'Accumulated depreciation',
        creditRole: 'Depreciation expense',
        when: 'Only when the full reduction would take NBV below zero. Reverse accumulated amortization against amortization expense until NBV is zero.',
      },
      {
        eventType: 'downward-excess',
        debitRole: 'ARO provision',
        creditRole: 'Accretion expense',
        when: 'Only when accumulated amortization cannot restore NBV to zero. The leftover provision reduction is credited to accretion expense rather than the asset.',
      },
    ],
  },
  {
    id: 'upward-revision-fully-amortized',
    label: 'Upward change of estimate — fully amortized',
    refs: ['ARO10', 'ARO11'],
    kind: 'revision',
    trigger: 'An upward revision when remaining useful life is nil. Capitalize the increment, then amortize it immediately.',
    debitRole: 'Retirement cost asset',
    creditRole: 'ARO provision',
    eventType: 'revision',
    companions: [{
      eventType: 'depreciation',
      debitRole: 'Depreciation expense',
      creditRole: 'Accumulated depreciation',
      when: 'Immediate amortization of the increment — no remaining useful life.',
    }],
  },
  {
    id: 'accretion',
    label: 'Period accretion',
    refs: ['ARO16'],
    kind: 'accretion',
    trigger: 'Month-end unwinding of the discount on the provision carried after in-period postings.',
    debitRole: 'Accretion expense',
    creditRole: 'ARO provision',
    eventType: 'accretion',
  },
  {
    id: 'settlement-over-partial',
    label: 'Partial settlement — actual above carrying amount',
    refs: ['ARO13'],
    kind: 'settlement',
    trigger: 'Part of the obligation is settled for more than the carrying amount. True-up the estimate first; the retirement-cost asset continues to amortize.',
    debitRole: 'ARO provision',
    creditRole: 'Cash',
    eventType: 'settlement',
  },
  {
    id: 'settlement-under-partial',
    label: 'Partial settlement — actual below carrying amount',
    refs: ['ARO15'],
    kind: 'settlement',
    trigger: 'Part of the obligation is settled for less than the carrying amount. True-up the estimate first; the retirement-cost asset continues to amortize.',
    debitRole: 'ARO provision',
    creditRole: 'Cash',
    eventType: 'settlement',
  },
  {
    id: 'settlement-over-full-amortized',
    label: 'Full settlement — actual above carrying amount, fully amortized',
    refs: ['ARO12'],
    kind: 'settlement',
    trigger: 'Full settlement for more than the carrying amount when remaining useful life is nil. True-up, amortize the increment immediately, then consume the provision against spend.',
    debitRole: 'ARO provision',
    creditRole: 'Cash',
    eventType: 'settlement',
  },
  {
    id: 'settlement-under-full-amortized',
    label: 'Full settlement — actual below carrying amount, fully amortized',
    refs: ['ARO14'],
    kind: 'settlement',
    trigger: 'Full settlement for less than the carrying amount when remaining useful life is nil. True-up (and reverse amortization on the reduction), then consume the remaining provision against spend.',
    debitRole: 'ARO provision',
    creditRole: 'Cash',
    eventType: 'settlement',
  },
  {
    id: 'settlement-dispose-over',
    label: 'Full settlement and retire the ARO asset — actual above',
    refs: ['ARO21'],
    kind: 'settlement',
    trigger: 'The obligation is fully settled and the retirement-cost asset is taken off the books. Actual spend exceeds the carrying amount.',
    debitRole: 'ARO provision',
    creditRole: 'Cash',
    eventType: 'settlement',
  },
  {
    id: 'settlement-dispose-under',
    label: 'Full settlement and retire the ARO asset — actual below',
    refs: ['ARO22'],
    kind: 'settlement',
    trigger: 'The obligation is fully settled and the retirement-cost asset is taken off the books. Actual spend is below the carrying amount.',
    debitRole: 'ARO provision',
    creditRole: 'Cash',
    eventType: 'settlement',
  },
  {
    id: 'sale',
    label: 'Related asset sold — extinguish the obligation',
    refs: ['ARO17', 'ARO18'],
    kind: 'sale',
    trigger: 'The related tangible capital asset is sold and restoration will not be performed by this entity. Extinguish the provision to gain or loss on disposal and retire the retirement-cost asset. Sale proceeds of the TCA are the organisation\'s PPE journal, not this engine.',
    debitRole: 'ARO provision',
    creditRole: 'Gain on disposal',
    eventType: 'disposal',
  },
];

const byId = new Map(ENGINE_POSTING_CASES.map((c) => [c.id, c]));

export function postingCaseById(id: string): EnginePostingCase | undefined {
  return byId.get(id);
}

function rem(facts: PostingFacts): number {
  return facts.remainingUlYears ?? 0;
}

export function selectPostingCase(facts: PostingFacts): EnginePostingCase {
  if (facts.kind === 'accretion') return byId.get('accretion')!;
  if (facts.kind === 'sale') return byId.get('sale')!;

  if (facts.kind === 'recognition') {
    const life = rem(facts);
    const productive = facts.inProductiveUse !== false;
    if (life <= 0 && !productive) return byId.get('expense-recognition')!;
    const expired = facts.expiredUlYears ?? 0;
    if (life > 0 && expired > 0) return byId.get('catch-up-recognition')!;
    return byId.get('initial-recognition')!;
  }

  if (facts.kind === 'revision') {
    const delta = facts.provisionDelta ?? 0;
    if (facts.inProductiveUse === false) return byId.get('revision-unproductive')!;
    if (delta < 0) return byId.get('downward-revision-active')!;
    if (delta > 0 && rem(facts) <= 0) return byId.get('upward-revision-fully-amortized')!;
    return byId.get('upward-revision')!;
  }

  const s = facts.settlement;
  const actual = s?.actualCost ?? 0;
  const carried = s?.provisionCarried ?? 0;
  const share = s?.share ?? 1;
  const released = carried * Math.min(1, Math.max(0, share));
  const over = actual > released + 0.005;
  const full = share >= 1 - 1e-9;
  if (s?.disposeAsset && full) {
    return byId.get(over ? 'settlement-dispose-over' : 'settlement-dispose-under')!;
  }
  if (full && rem(facts) <= 0) {
    return byId.get(over ? 'settlement-over-full-amortized' : 'settlement-under-full-amortized')!;
  }
  return byId.get(over ? 'settlement-over-partial' : 'settlement-under-partial')!;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * When a downward cut of `take` would drive NBV negative: reverse accum
 * against amortization expense until NBV is zero; any remainder is credited
 * to accretion expense (and put back on the asset so gross/NBV do not go negative).
 */
export function nbvFloor(take: number, nbv: number, accum: number): { reverseAccum: number; excessToAccretion: number } {
  const cut = Math.max(0, take);
  const carrying = Math.max(0, nbv);
  const held = Math.max(0, accum);
  if (cut <= carrying + 0.005) return { reverseAccum: 0, excessToAccretion: 0 };
  const overNbv = round2(cut - carrying);
  const reverseAccum = round2(Math.min(overNbv, held));
  return { reverseAccum, excessToAccretion: round2(Math.max(0, overNbv - reverseAccum)) };
}

function pushFloor(
  push: (eventType: EventType, amount: number, note: string) => void,
  take: number,
  nbv: number,
  accum: number,
): { reverseAccum: number; excessToAccretion: number } {
  const floor = nbvFloor(take, nbv, accum);
  if (floor.reverseAccum) {
    push('depreciation', -floor.reverseAccum, 'Reverse accumulated amortization against amortization expense so the retirement-cost asset does not go below nil NBV.');
  }
  if (floor.excessToAccretion) {
    push('downward-excess', -floor.excessToAccretion, 'The leftover provision reduction is credited to accretion expense; it is not taken through the asset.');
  }
  return floor;
}

/**
 * Journals the engine should emit for a selected case. Amounts are signed
 * provision / asset movements (positive increases the provision or the asset).
 */
export function planCaseEntries(
  posted: EnginePostingCase,
  facts: PostingFacts,
): PlannedEntry[] {
  const out: PlannedEntry[] = [];
  const push = (eventType: EventType, amount: number, note: string) => {
    if (Math.abs(amount) < 0.005) return;
    out.push({ eventType, amount: round2(amount), note });
  };

  if (posted.kind === 'accretion') {
    push('accretion', facts.provisionDelta ?? 0, posted.label);
    return out;
  }

  if (posted.kind === 'recognition') {
    const pv = facts.provisionDelta ?? 0;
    push(posted.eventType, pv, posted.label);
    if (posted.id === 'catch-up-recognition') {
      const total = facts.totalUlYears ?? 0;
      const expired = facts.expiredUlYears ?? 0;
      if (total > 0 && expired > 0) {
        push('depreciation', pv * Math.min(1, expired / total), 'Catch-up amortization of the retirement-cost asset for life already expired.');
      }
    } else if (posted.id === 'initial-recognition' && rem(facts) <= 0) {
      push('depreciation', pv, 'Immediate amortization — no remaining useful life.');
    }
    return out;
  }

  if (posted.kind === 'revision') {
    const delta = facts.provisionDelta ?? 0;
    if (posted.id === 'downward-revision-active' && delta < 0) {
      const floor = nbvFloor(-delta, facts.assetNbv, facts.assetAccum ?? 0);
      push(posted.eventType, round2(delta + floor.excessToAccretion), posted.label);
      pushFloor(push, -delta, facts.assetNbv, facts.assetAccum ?? 0);
    } else {
      push(posted.eventType, delta, posted.label);
      if (posted.id === 'upward-revision-fully-amortized' && delta > 0) {
        push('depreciation', delta, 'Immediate amortization of the increment — no remaining useful life.');
      }
    }
    return out;
  }

  if (posted.kind === 'sale') {
    const carried = facts.settlement?.provisionCarried ?? facts.provisionDelta ?? 0;
    push('disposal', -Math.abs(carried), posted.label);
    const nbv = Math.max(0, facts.assetNbv);
    if (nbv > 0) push('depreciation', nbv, 'Write off remaining retirement-cost-asset net book value.');
    const gross = Math.max(0, facts.assetGross ?? 0);
    if (gross > 0) push('asset-retirement', gross, 'Retire the retirement-cost asset against accumulated amortization.');
    return out;
  }

  const s = facts.settlement;
  if (!s) return out;
  const share = Math.min(1, Math.max(0, s.share));
  const released = round2(s.provisionCarried * share);
  const trueUp = round2(s.actualCost - released);
  let nbv = Math.max(0, facts.assetNbv);
  let accum = Math.max(0, facts.assetAccum ?? 0);
  let gross = Math.max(0, facts.assetGross ?? nbv + accum);
  const life = rem(facts);

  if (trueUp) {
    if (trueUp < 0) {
      const beforeNbv = nbv;
      const floor = nbvFloor(-trueUp, beforeNbv, accum);
      push('revision', round2(trueUp + floor.excessToAccretion), 'True-up the estimate down to actual spend before settlement.');
      const applied = pushFloor(push, -trueUp, beforeNbv, accum);
      nbv = round2(nbv + trueUp + applied.excessToAccretion + applied.reverseAccum);
      gross = round2(gross + trueUp + applied.excessToAccretion);
      accum = round2(accum - applied.reverseAccum);
    } else {
      push('revision', trueUp, 'True-up the estimate to actual spend before settlement.');
      nbv = round2(nbv + trueUp);
      gross = round2(gross + trueUp);
      if (life <= 0) {
        push('depreciation', trueUp, 'Immediate amortization of the settlement true-up — no remaining useful life.');
        accum = round2(accum + trueUp);
        nbv = round2(nbv - trueUp);
      }
    }
  }
  push('settlement', -s.actualCost, `${posted.label}. Consume the provision against spend.`);
  if (posted.id.startsWith('settlement-dispose') || s.disposeAsset) {
    if (nbv > 0.005) {
      push('depreciation', nbv, 'Catch-up amortization so the retirement-cost asset can be taken off the books.');
      accum = round2(accum + nbv);
      nbv = 0;
    }
    if (gross > 0.005) push('asset-retirement', gross, 'Retire the retirement-cost asset against accumulated amortization.');
  }
  return out;
}
