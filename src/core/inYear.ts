/**
 * In-year transactions the user records during an open period.
 *
 * New ARO, cost adjustments and term adjustments each post when the user
 * creates them. Accretion is a separate month-end run — see periodClose —
 * after those postings have been processed. Opening the month and assigning
 * a curve is not a posting trigger.
 */

import { isValidDate } from '../engine/dates';
import type { CostLine, Obligation, Revision } from '../engine/derive';
import { planCaseEntries, selectPostingCase, type PostingFacts } from '../engine/postingCases';
import type { ObligationEvent } from '../engine/rollforward';
import { measureObligation } from './measure';
import { remainingUl, suggestedAroAssetNumber } from './openingLoad';
import { applyLinkedObligationScope, syncTcaScopeFromObligations, tcaForObligation } from './tcaListing';
import { assetBooks, openPeriod, provisionCarried } from './periodClose';
import { newObligationUlIssue, proposeUlAlignment, resolveNewAroUl, ulAlignmentOf, ulAlignmentPending, usefulLifeAsAt, yearsToSettlement } from './usefulLife';
import type { Period } from './periods';
import type { AppState, ReportingUnit, UnitData } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;

export function periodContaining(periods: Period[], date: string): Period | undefined {
  return periods.find((p) => p.starts <= date && date <= p.ends);
}

/** The open period, and (when a date is given) that date must fall in it. */
export function requireOpenPeriod(data: { periods: Period[] }, date?: string): Period | string {
  const open = openPeriod(data);
  if (!open) {
    return 'Open a period before posting. New ARO, cost adjustments and term adjustments post into the open period when you record them.';
  }
  if (date) {
    if (!isValidDate(date)) return 'The effective date is not a date.';
    if (date < open.starts || date > open.ends) {
      return `The effective date must fall in the open period (${open.code}, ${open.starts} to ${open.ends}).`;
    }
  }
  return open;
}

export interface NewAroCostLine {
  description: string;
  qty: number;
  rate: number;
}

export interface NewAroInput {
  ref: string;
  description: string;
  /** Used when `lines` is omitted: one build-up row of qty 1 at this rate. */
  estimatedCost?: number;
  /** Multi-line cost build-up. Direct cost is Σ qty × rate. */
  lines?: NewAroCostLine[];
  costEstimateDate: string;
  settlementDate: string;
  aroseOn: string;
  /**
   * Date the obligating event occurred. Defaults from the linked TCA's
   * acquisition date on the master listing when omitted.
   */
  assetAcquisitionDate?: string;
  assetClass?: string;
  assetId?: string;
  aroAssetNumber?: string;
  site?: string;
  region?: string;
  totalUl?: number;
  expiredUl?: number;
  /** When remaining UL is nil: capitalize + immediate amort if still in use; otherwise charge to expense. */
  inProductiveUse?: boolean;
}

export interface SettlementInput {
  obligationId: string;
  pct: number;
  actualCost: number;
  settledOn: string;
  disposeAroAsset?: boolean;
  relatedAssetSold?: boolean;
}

export interface PostedTransaction {
  obligationId: string;
  eventId: string | null;
  amount: number;
  periodCode: string;
  caseId?: string;
}

function emitPlanned(
  data: UnitData,
  unitId: string,
  obligationId: string,
  period: Period,
  date: string,
  planned: ReturnType<typeof planCaseEntries>,
  idBase: string,
): ObligationEvent[] {
  const out: ObligationEvent[] = [];
  planned.forEach((p, i) => {
    const event: ObligationEvent = {
      id: `${idBase}-${i}`,
      obligationId,
      periodId: period.id,
      type: p.eventType,
      date,
      amount: p.amount,
      note: p.note,
    };
    data.events.push(event);
    out.push(event);
  });
  return out;
}

function asYears(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function lifeFacts(
  o: Obligation,
  data: UnitData,
  unit: ReportingUnit,
  period: Period,
): Pick<PostingFacts, 'remainingUlYears' | 'assetNbv' | 'assetGross' | 'assetAccum' | 'expiredUlYears' | 'totalUlYears' | 'inProductiveUse'> {
  const life = usefulLifeAsAt(o, data.events, data.periods, unit, period, true);
  const books = assetBooks(data.events, data.periods, o, period);
  return {
    remainingUlYears: life.remainingYears ?? remainingUl(o),
    expiredUlYears: life.expiredYears ?? asYears(o.expiredUl) ?? 0,
    totalUlYears: life.totalYears ?? asYears(o.totalUl),
    assetNbv: books.nbv,
    assetGross: books.gross,
    assetAccum: books.accum,
    inProductiveUse: o.inProductiveUse !== false,
  };
}

function buildNewAroLines(id: string, input: NewAroInput): CostLine[] | string {
  const fromLines = (input.lines ?? [])
    .map((l, i) => ({
      id: `${id}-cost-${i}`,
      description: (l.description || '').trim() || `Cost line ${i + 1}`,
      qty: l.qty,
      rate: l.rate,
      source: 'New ARO',
    }))
    .filter((l) => Number.isFinite(l.qty) && Number.isFinite(l.rate) && Math.abs(l.qty * l.rate) >= 0.005);
  if (fromLines.length) return fromLines;
  if (Number.isFinite(input.estimatedCost) && (input.estimatedCost as number) > 0) {
    return [{
      id: `${id}-cost`,
      description: 'Initial estimated cost',
      qty: 1,
      rate: input.estimatedCost as number,
      source: 'New ARO',
    }];
  }
  return 'Estimated cost must be a positive amount, or enter at least one cost line with quantity and unit rate.';
}

function acquisitionDateForNewAro(data: UnitData, input: NewAroInput): string | { error: string } {
  if (isValidDate(input.assetAcquisitionDate)) return input.assetAcquisitionDate;
  const tca = tcaForObligation(data.tcaAssets, { assetId: input.assetId });
  if (tca && isValidDate(tca.acquisitionDate)) return tca.acquisitionDate;
  return { error: 'The ARO asset acquisition date is the date the obligating event occurred. It defaults from the linked TCA on the master listing. Enter YYYY-MM-DD.' };
}

export function postNewAro(
  s: AppState,
  tenantId: string,
  unitId: string,
  input: NewAroInput,
): PostedTransaction | string {
  const unit = (s.units[tenantId] ?? []).find((u) => u.id === unitId);
  const data = s.data[unitId];
  if (!unit || !data) return 'That reporting unit is not on this tenant.';

  const ref = input.ref.trim();
  if (!ref) return 'The obligation number cannot be empty.';
  if (data.obligations.some((o) => o.ref.trim().toLowerCase() === ref.toLowerCase())) {
    return `${ref} is already on this register.`;
  }
  const assetAcquisitionDate = acquisitionDateForNewAro(data, input);
  if (typeof assetAcquisitionDate !== 'string') return assetAcquisitionDate.error;
  if (!isValidDate(input.costEstimateDate)) return 'The cost estimate date is not a date.';
  if (!isValidDate(input.settlementDate)) return 'The expected settlement date is not a date.';
  if (input.settlementDate < input.costEstimateDate) {
    return 'Expected settlement cannot fall before the cost estimate date.';
  }

  const period = requireOpenPeriod(data, input.aroseOn);
  if (typeof period === 'string') return period;

  const id = `o-${unitId}-n-${Date.now().toString(36)}`;
  const lines = buildNewAroLines(id, input);
  if (typeof lines === 'string') return lines;

  const tca = tcaForObligation(data.tcaAssets, { assetId: input.assetId });
  const resolved = resolveNewAroUl({
    inputTotalUl: input.totalUl,
    inputExpiredUl: input.expiredUl,
    tca,
    assetAcquisitionDate,
    costEstimateDate: input.costEstimateDate,
    dayCount: unit.dayCount,
  });
  const yts = yearsToSettlement(input.costEstimateDate, input.settlementDate, unit.dayCount);
  const ulIssue = newObligationUlIssue({
    totalUl: resolved.totalUl,
    expiredUl: resolved.expiredUl,
    yearsToSettlement: yts,
  });
  if (ulIssue) return ulIssue.message;

  const totalUl = resolved.totalUl ?? undefined;
  const expiredUl = resolved.expiredUl;

  const o: Obligation = {
    id,
    ref,
    description: input.description.trim() || ref,
    costEstimateDate: input.costEstimateDate,
    settlementDate: input.settlementDate,
    lines,
    adj: [],
    status: 'In scope',
    scopeReason: '',
    type: '',
    basis: 'Legal',
    site: input.site ?? '',
    region: input.region ?? '',
    aroAssetClass: input.assetClass ?? '',
    assetId: input.assetId ?? '',
    aroAssetNumber: (input.aroAssetNumber ?? '').trim()
      || suggestedAroAssetNumber(data.obligations, (input.assetId ?? '').trim() || ref),
    assetAcquisitionDate,
    totalUl,
    expiredUl: expiredUl ?? 0,
    inProductiveUse: input.inProductiveUse !== false,
  };

  const measured = measureObligation(s, unit, o, period.ends);
  if (!Number.isFinite(measured.pv)) {
    return 'The provision could not be measured from the inputs given.';
  }
  const amount = round2(measured.pv);

  const rem = remainingUl(o);
  if (rem == null) {
    const life = measured.tD > 0 ? measured.tD : undefined;
    if (life != null) o.totalUl = Math.round(life * 10000) / 10000;
  }

  const facts: PostingFacts = {
    kind: 'recognition',
    provisionDelta: amount,
    remainingUlYears: remainingUl(o),
    assetNbv: 0,
    inProductiveUse: input.inProductiveUse !== false,
    expiredUlYears: asYears(o.expiredUl) ?? 0,
    totalUlYears: asYears(o.totalUl),
  };
  const posted = selectPostingCase(facts);
  const planned = planCaseEntries(posted, facts);

  data.obligations.push(o);
  if (input.assetId) {
    data.tcaAssets = syncTcaScopeFromObligations(data.tcaAssets ?? [], data.obligations);
    applyLinkedObligationScope(data.obligations, data.tcaAssets);
  }
  const events = emitPlanned(data, unitId, id, period, input.aroseOn, planned, `${unitId}-add-${id}`);
  return {
    obligationId: id,
    eventId: events[0]?.id ?? null,
    amount,
    periodCode: period.code,
    caseId: posted.id,
  };
}

export function postRevision(
  s: AppState,
  tenantId: string,
  unitId: string,
  obligationId: string,
  rev: Revision,
  raisedBy?: string,
): PostedTransaction | string {
  const unit = (s.units[tenantId] ?? []).find((u) => u.id === unitId);
  const data = s.data[unitId];
  if (!unit || !data) return 'That reporting unit is not on this tenant.';
  const o = data.obligations.find((x) => x.id === obligationId);
  if (!o) return 'That obligation is not on this reporting unit.';
  if (o.status === 'Scoped out') return `${o.ref} is scoped out, so it cannot take a revision.`;

  const period = requireOpenPeriod(data, rev.date);
  if (typeof period === 'string') return period;

  if (rev.kind === 'cost' && (rev.amount == null || !Number.isFinite(rev.amount))) {
    return 'A cost revision needs an amount.';
  }
  if (rev.kind === 'term') {
    if (!rev.to || !isValidDate(rev.to)) return 'A timing revision needs a new settlement date.';
  }

  const before = measureObligation(s, unit, o, period.ends);
  let next: Obligation = { ...o, adj: [...(o.adj ?? []), rev] };
  const after = measureObligation(s, unit, next, period.ends);
  const amount = round2(after.pv - before.pv);

  if (rev.kind === 'term' && rev.to) {
    const flag = proposeUlAlignment(next, data.events, data.periods, unit, period, rev.id, rev.to, raisedBy);
    if (flag) next = { ...next, ulAlignment: flag };
    else if (ulAlignmentPending(next)) {
      const prior = ulAlignmentOf(next);
      if (prior) next = { ...next, ulAlignment: { ...prior, status: 'Dismissed' } };
    }
  }

  const i = data.obligations.findIndex((x) => x.id === obligationId);
  data.obligations[i] = next;

  if (Math.abs(amount) < 0.005) {
    return { obligationId, eventId: null, amount: 0, periodCode: period.code };
  }

  const facts: PostingFacts = {
    kind: 'revision',
    provisionDelta: amount,
    ...lifeFacts(next, data, unit, period),
  };
  const posted = selectPostingCase(facts);
  const planned = planCaseEntries(posted, facts).map((p) => (
    p.eventType === 'revision'
      ? {
          ...p,
          note: rev.kind === 'cost'
            ? `Cost adjustment in ${period.code}: ${rev.reason}.`
            : `Term adjustment in ${period.code}: ${rev.reason}.`,
        }
      : p
  ));
  const events = emitPlanned(data, unitId, obligationId, period, rev.date, planned, `${unitId}-rev-${rev.id}`);
  return {
    obligationId,
    eventId: events[0]?.id ?? null,
    amount,
    periodCode: period.code,
    caseId: posted.id,
  };
}

export function postSettlement(
  s: AppState,
  tenantId: string,
  unitId: string,
  input: SettlementInput,
): PostedTransaction | string {
  const unit = (s.units[tenantId] ?? []).find((u) => u.id === unitId);
  const data = s.data[unitId];
  if (!unit || !data) return 'That reporting unit is not on this tenant.';
  const o = data.obligations.find((x) => x.id === input.obligationId);
  if (!o) return 'That obligation is not on this reporting unit.';
  if (o.status === 'Scoped out') return `${o.ref} is scoped out, so it cannot be settled.`;

  const period = requireOpenPeriod(data, input.settledOn);
  if (typeof period === 'string') return period;

  const share = input.pct;
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    return 'The share settled must be greater than 0% and not more than 100%.';
  }
  const sold = Boolean(input.relatedAssetSold);
  if (!sold && (!Number.isFinite(input.actualCost) || input.actualCost <= 0)) {
    return 'Actual cost must be a positive amount, unless the related asset was sold.';
  }

  const carried = provisionCarried(data.events, data.periods, o.id, period);
  const books = assetBooks(data.events, data.periods, o, period);
  const assetLeft = Math.abs(books.nbv) > 0.005 || Math.abs(books.gross) > 0.005;
  if (carried <= 0.005) {
    if (!sold) return `${o.ref} has no provision to settle in this period.`;
    if (!assetLeft) {
      return {
        obligationId: o.id,
        eventId: null,
        amount: 0,
        periodCode: period.code,
        caseId: 'sale',
      };
    }
  }

  const life = lifeFacts(o, data, unit, period);
  const facts: PostingFacts = sold
    ? {
        kind: 'sale',
        ...life,
        settlement: { share: 1, actualCost: 0, provisionCarried: carried, disposeAsset: true },
      }
    : {
        kind: 'settlement',
        ...life,
        settlement: {
          share,
          actualCost: input.actualCost,
          provisionCarried: carried,
          disposeAsset: Boolean(input.disposeAroAsset) && share >= 1 - 1e-9,
        },
      };
  const posted = selectPostingCase(facts);
  const planned = planCaseEntries(posted, facts);
  if (!planned.length) return 'Nothing to post for that settlement.';

  const id = `st-${unitId}-${Date.now().toString(36)}-${o.id.slice(-6)}`;
  data.settlements.push({
    id,
    obligationId: o.id,
    kind: sold || share >= 1 - 1e-9 ? 'Full' : 'Partial',
    pct: sold ? 1 : share,
    actualCost: sold ? 0 : input.actualCost,
    settledOn: input.settledOn,
    posted: true,
    disposeAroAsset: Boolean(input.disposeAroAsset) || sold,
    relatedAssetSold: sold,
  });
  const events = emitPlanned(data, unitId, o.id, period, input.settledOn, planned, `${unitId}-st-${id}`);
  const provisionMove = planned
    .filter((p) => p.eventType === 'revision' || p.eventType === 'settlement' || p.eventType === 'disposal')
    .reduce((n, p) => n + p.amount, 0);
  return {
    obligationId: o.id,
    eventId: events[0]?.id ?? null,
    amount: round2(provisionMove),
    periodCode: period.code,
    caseId: posted.id,
  };
}
