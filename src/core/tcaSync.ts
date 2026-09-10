/**
 * Go-forward sync of the current master TCA listing and the ARO register.
 *
 * After opening lock the listing is compared both ways. New in-scope assets
 * need a linked obligation. Unproductive / Disposed TCA status must land on
 * the ARO asset (productive-use flag, or retirement). The reverse pass finds
 * obligations whose TCA is missing, and remaining UL that no longer matches
 * the listing after a life change on the PPE.
 */

import { settlementInForce } from '../engine/derive';
import { termYears } from '../engine/dates';
import { years as formatYears } from './format';
import { postNewAro, postSettlement, type NewAroInput } from './inYear';
import { assetBooks, openPeriod, provisionCarried } from './periodClose';
import {
  assetNumberKey,
  obligationsForAsset,
  tcaAssetStatusOf,
} from './tcaListing';
import type { AppState, Obligation, ReportingUnit, TcaAsset, UnitData } from './types';
import { tcaAroUlGap } from './usefulLife';

export type TcaSyncKind =
  | 'scope-undecided'
  | 'create-obligation'
  | 'mark-unproductive'
  | 'mark-productive'
  | 'dispose-aro'
  | 'dropped'
  | 'orphan-obligation'
  | 'ul-mismatch';

/** Where the planner found the gap. */
export type TcaSyncFoundOn = 'listing' | 'register';

export interface TcaSyncAction {
  id: string;
  kind: TcaSyncKind;
  foundOn: TcaSyncFoundOn;
  assetNumber: string;
  description: string;
  detail: string;
  obligationIds: string[];
}

export type TcaSyncUnit = Pick<ReportingUnit, 'dayCount' | 'calendarType'>;

export function uniqueObligationRef(obligations: Obligation[], base: string): string {
  const used = new Set(obligations.map((o) => o.ref.trim().toLowerCase()));
  const stem = base.trim() || 'ARO';
  if (!used.has(stem.toLowerCase())) return stem;
  let i = 2;
  while (used.has(`${stem}-${i}`.toLowerCase())) i++;
  return `${stem}-${i}`;
}

export function suggestedAroAssetNumber(obligations: Obligation[], assetNumber: string): string {
  const used = new Set(
    obligations.map((o) => String(o.aroAssetNumber ?? '').trim().toLowerCase()).filter(Boolean),
  );
  const stem = `ARC-${assetNumber}`;
  if (!used.has(stem.toLowerCase())) return stem;
  let i = 2;
  while (used.has(`${stem}-${i}`.toLowerCase())) i++;
  return `${stem}-${i}`;
}

function booksStillOpen(data: UnitData, o: Obligation, period: ReturnType<typeof openPeriod>): boolean {
  if (!period) return true;
  const carried = provisionCarried(data.events, data.periods, o.id, period);
  const books = assetBooks(data.events, data.periods, o, period);
  return carried > 0.005 || Math.abs(books.nbv) > 0.005;
}

export function planTcaSync(data: UnitData, unit?: TcaSyncUnit): TcaSyncAction[] {
  const actions: TcaSyncAction[] = [];
  const assets = data.tcaAssets ?? [];
  const obligations = data.obligations ?? [];
  const period = openPeriod(data);
  const fileKeys = new Set((data.openingSnapshot?.tcaFileKeys ?? []).filter(Boolean));
  const listed = new Set(assets.map((a) => assetNumberKey(a.assetNumber)).filter(Boolean));

  for (const asset of assets) {
    const linked = obligationsForAsset(obligations, asset.assetNumber);
    const status = tcaAssetStatusOf(asset);
    const ids = linked.map((o) => o.id);

    if (asset.scope === 'Undecided' || !asset.scope) {
      actions.push({
        id: `undecided:${asset.id}`,
        kind: 'scope-undecided',
        foundOn: 'listing',
        assetNumber: asset.assetNumber,
        description: asset.description,
        detail: 'Mark In scope, Out of scope, or Undecided. A reason is required when it is out of scope.',
        obligationIds: ids,
      });
    }

    if (asset.scope === 'In scope' && linked.length === 0) {
      actions.push({
        id: `create:${asset.id}`,
        kind: 'create-obligation',
        foundOn: 'listing',
        assetNumber: asset.assetNumber,
        description: asset.description,
        detail: 'This TCA is in scope and has no linked obligation. Create an obligation and ARO asset, then post initial recognition into the open period.',
        obligationIds: [],
      });
    }

    if (status === 'Unproductive') {
      const still = linked.filter((o) => o.inProductiveUse !== false);
      if (still.length) {
        actions.push({
          id: `unprod:${asset.id}`,
          kind: 'mark-unproductive',
          foundOn: 'listing',
          assetNumber: asset.assetNumber,
          description: asset.description,
          detail: `${still.length} linked ARO asset${still.length === 1 ? ' is' : 's are'} still in productive use. Flag them unproductive so later changes of estimate post to operating expense, not the ARO asset.`,
          obligationIds: still.map((o) => o.id),
        });
      }
    }

    if (status === 'Active') {
      const idle = linked.filter((o) => o.inProductiveUse === false);
      if (idle.length) {
        actions.push({
          id: `prod:${asset.id}`,
          kind: 'mark-productive',
          foundOn: 'listing',
          assetNumber: asset.assetNumber,
          description: asset.description,
          detail: `${idle.length} linked ARO asset${idle.length === 1 ? ' is' : 's are'} flagged unproductive while the TCA is Active. Restore productive use so later estimate changes go to the ARO asset.`,
          obligationIds: idle.map((o) => o.id),
        });
      }
    }

    if (status === 'Disposed' && linked.length) {
      const pending = linked.filter((o) => booksStillOpen(data, o, period));
      if (pending.length) {
        actions.push({
          id: `dispose:${asset.id}`,
          kind: 'dispose-aro',
          foundOn: 'listing',
          assetNumber: asset.assetNumber,
          description: asset.description,
          detail: period
            ? `The TCA is disposed. Retire ${pending.length} linked obligation${pending.length === 1 ? '' : 's'} and ARO asset${pending.length === 1 ? '' : 's'} (related-asset-sold) in the open period.`
            : 'The TCA is disposed. Open a period before retiring the linked ARO obligation and ARO asset.',
          obligationIds: pending.map((o) => o.id),
        });
      }
    }

    if (fileKeys.size && !fileKeys.has(assetNumberKey(asset.assetNumber))) {
      actions.push({
        id: `dropped:${asset.id}`,
        kind: 'dropped',
        foundOn: 'listing',
        assetNumber: asset.assetNumber,
        description: asset.description,
        detail: linked.length
          ? 'This asset was not on the latest master TCA file and still has linked ARO rows. Review whether the file omitted it or the TCA was disposed.'
          : 'This asset was not on the latest master TCA file. Review whether the file omitted it or it should be marked Disposed.',
        obligationIds: ids,
      });
    }

    if (unit && status !== 'Disposed' && linked.length) {
      const mismatched = linked.filter((o) => booksStillOpen(data, o, period) && tcaAroUlGap(asset, o, data.events, data.periods, unit, period));
      if (mismatched.length) {
        const sample = tcaAroUlGap(asset, mismatched[0], data.events, data.periods, unit, period)!;
        const listingRem = formatYears(sample.tcaRemaining);
        const aroBits = mismatched.map((o) => {
          const gap = tcaAroUlGap(asset, o, data.events, data.periods, unit, period)!;
          const aroRem = gap.aroRemaining == null ? 'no UL' : formatYears(gap.aroRemaining);
          return `${o.ref} remaining ${aroRem}`;
        });
        actions.push({
          id: `ul:${asset.id}`,
          kind: 'ul-mismatch',
          foundOn: 'register',
          assetNumber: asset.assetNumber,
          description: asset.description,
          detail: sample.kind === 'missing-aro-ul'
            ? `The master TCA remaining UL is ${listingRem}, but ${mismatched.length === 1 ? mismatched[0].ref : `${mismatched.length} linked obligations`} ${mismatched.length === 1 ? 'has' : 'have'} no ARO useful life. Apply the listing so Total UL and Expired UL (and remaining) match the TCA.`
            : `The master TCA remaining UL is ${listingRem}. ${aroBits.join('; ')}. Apply the listing remaining to the ARO asset — Total UL becomes expired as-at plus listing remaining. Opening expired UL is not rewritten.`,
          obligationIds: mismatched.map((o) => o.id),
        });
      }
    }
  }

  const orphans = new Map<string, Obligation[]>();
  for (const o of obligations) {
    const raw = String(o.assetId ?? '').trim();
    const key = assetNumberKey(raw);
    if (key && listed.has(key)) continue;
    const group = key || '(none)';
    const list = orphans.get(group) ?? [];
    list.push(o);
    orphans.set(group, list);
  }
  for (const [key, rows] of orphans) {
    const label = key === '(none)' ? '(no TCA asset number)' : rows[0] ? String(rows[0].assetId ?? key) : key;
    const refs = rows.map((o) => o.ref).join(', ');
    actions.push({
      id: `orphan:${key}`,
      kind: 'orphan-obligation',
      foundOn: 'register',
      assetNumber: label,
      description: rows.map((o) => o.description).filter(Boolean)[0] ?? refs,
      detail: key === '(none)'
        ? `${refs} ${rows.length === 1 ? 'has' : 'have'} no TCA asset number. Put the related asset on the current master TCA listing, or retire the ARO if the related TCA is gone.`
        : `${refs} ${rows.length === 1 ? 'names' : 'name'} ${label}, which is not on the current master TCA listing. Add that asset to the listing, or retire the ARO if the TCA was disposed and omitted from the file.`,
      obligationIds: rows.map((o) => o.id),
    });
  }

  return actions;
}

export function applyTcaStatusToAro(data: UnitData, asset: TcaAsset): number {
  const status = tcaAssetStatusOf(asset);
  if (status === 'Disposed') return 0;
  const productive = status !== 'Unproductive';
  let n = 0;
  for (const o of obligationsForAsset(data.obligations ?? [], asset.assetNumber)) {
    const now = o.inProductiveUse !== false;
    if (now === productive) continue;
    o.inProductiveUse = productive;
    n++;
  }
  return n;
}

export function applyUnproductiveFlags(data: UnitData, action: TcaSyncAction): string {
  const productive = action.kind === 'mark-productive';
  if (action.kind !== 'mark-unproductive' && action.kind !== 'mark-productive') {
    return 'That action does not change productive use.';
  }
  let n = 0;
  for (const id of action.obligationIds) {
    const o = data.obligations.find((x) => x.id === id);
    if (!o) continue;
    o.inProductiveUse = productive;
    n++;
  }
  return n
    ? `Flagged ${n} ARO asset${n === 1 ? '' : 's'} ${productive ? 'in' : 'not in'} productive use.`
    : 'Nothing to flag.';
}

export function applyUlFromTca(
  data: UnitData,
  action: TcaSyncAction,
  unit: TcaSyncUnit,
): string {
  if (action.kind !== 'ul-mismatch') return 'That action does not change useful life.';
  const asset = tcaAssetByNumber(data.tcaAssets ?? [], action.assetNumber);
  if (!asset) return `${action.assetNumber} is not on the current listing.`;
  const period = openPeriod(data);
  let n = 0;
  const short: string[] = [];
  for (const id of action.obligationIds) {
    const o = data.obligations.find((x) => x.id === id);
    if (!o) continue;
    const gap = tcaAroUlGap(asset, o, data.events, data.periods, unit, period);
    if (!gap) continue;
    o.totalUl = gap.proposedTotalUl;
    if (gap.proposedExpiredUl != null) o.expiredUl = gap.proposedExpiredUl;
    n++;
    const settle = settlementInForce(o);
    const from = period?.ends;
    if (from && settle && termYears(from, settle, unit.dayCount) + 1e-9 < gap.tcaRemaining) {
      short.push(o.ref);
    }
  }
  if (!n) return 'Nothing to align.';
  const extra = short.length
    ? ` ${short.join(', ')} now have remaining UL longer than the term to settlement — revise expected settlement on the ARO register.`
    : '';
  return `Applied master TCA remaining UL to ${n} obligation${n === 1 ? '' : 's'}.${extra}`;
}

export function applyCreateObligation(
  s: AppState,
  tenantId: string,
  unitId: string,
  asset: TcaAsset,
  input: Omit<NewAroInput, 'assetId' | 'site' | 'inProductiveUse'>,
): ReturnType<typeof postNewAro> {
  return postNewAro(s, tenantId, unitId, {
    ...input,
    assetId: asset.assetNumber,
    site: asset.site,
    assetAcquisitionDate: input.assetAcquisitionDate || asset.acquisitionDate,
    inProductiveUse: tcaAssetStatusOf(asset) !== 'Unproductive',
    description: input.description.trim() || asset.description,
  });
}

export function applyDisposeLinkedAro(
  s: AppState,
  tenantId: string,
  unitId: string,
  action: TcaSyncAction,
  settledOn: string,
): string {
  const data = s.data[unitId];
  if (!data) return 'That reporting unit is not on this tenant.';
  if (!action.obligationIds.length) return 'There is no linked ARO to retire.';
  const posted: string[] = [];
  const skipped: string[] = [];
  for (const id of action.obligationIds) {
    const o = data.obligations.find((x) => x.id === id);
    const result = postSettlement(s, tenantId, unitId, {
      obligationId: id,
      pct: 1,
      actualCost: 0,
      settledOn,
      relatedAssetSold: true,
      disposeAroAsset: true,
    });
    if (typeof result === 'string') {
      skipped.push(`${o?.ref ?? id}: ${result}`);
      continue;
    }
    posted.push(o?.ref ?? id);
  }
  if (!posted.length) return skipped[0] ?? 'Nothing was retired.';
  const extra = skipped.length ? ` ${skipped.length} already clear or refused.` : '';
  const why = action.kind === 'orphan-obligation'
    ? 'the related TCA is not on the current listing.'
    : 'the related TCA was disposed.';
  return `Retired ${posted.length} obligation${posted.length === 1 ? '' : 's'} (${posted.join(', ')}) because ${why}${extra}`;
}

export function tcaAssetByNumber(assets: TcaAsset[], assetNumber: string): TcaAsset | undefined {
  const key = assetNumberKey(assetNumber);
  return assets.find((a) => assetNumberKey(a.assetNumber) === key);
}
