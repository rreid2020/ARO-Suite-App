/**
 * Go-forward sync of the current master TCA listing to the ARO register.
 *
 * After opening lock, an updated TCA listing is compared to existing
 * obligations and ARO assets. New in-scope assets need a linked obligation.
 * Unproductive TCAs flag the ARO asset so later estimate changes go to
 * expense. Disposed TCAs retire remaining provision and the ARO asset.
 */

import { postNewAro, postSettlement, type NewAroInput } from './inYear';
import { assetBooks, openPeriod, provisionCarried } from './periodClose';
import {
  assetNumberKey,
  obligationsForAsset,
  tcaAssetStatusOf,
} from './tcaListing';
import type { AppState, Obligation, TcaAsset, UnitData } from './types';

export type TcaSyncKind =
  | 'scope-undecided'
  | 'create-obligation'
  | 'mark-unproductive'
  | 'mark-productive'
  | 'dispose-aro'
  | 'dropped';

export interface TcaSyncAction {
  id: string;
  kind: TcaSyncKind;
  assetNumber: string;
  description: string;
  detail: string;
  obligationIds: string[];
}

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

export function planTcaSync(data: UnitData): TcaSyncAction[] {
  const actions: TcaSyncAction[] = [];
  const assets = data.tcaAssets ?? [];
  const obligations = data.obligations ?? [];
  const period = openPeriod(data);
  const fileKeys = new Set((data.openingSnapshot?.tcaFileKeys ?? []).filter(Boolean));

  for (const asset of assets) {
    const linked = obligationsForAsset(obligations, asset.assetNumber);
    const status = tcaAssetStatusOf(asset);
    const ids = linked.map((o) => o.id);

    if (asset.scope === 'Undecided' || !asset.scope) {
      actions.push({
        id: `undecided:${asset.id}`,
        kind: 'scope-undecided',
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
          assetNumber: asset.assetNumber,
          description: asset.description,
          detail: `${idle.length} linked ARO asset${idle.length === 1 ? ' is' : 's are'} flagged unproductive while the TCA is Active. Restore productive use so later estimate changes go to the ARO asset.`,
          obligationIds: idle.map((o) => o.id),
        });
      }
    }

    if (status === 'Disposed' && linked.length) {
      const pending = linked.filter((o) => {
        if (!period) return true;
        const carried = provisionCarried(data.events, data.periods, o.id, period);
        const books = assetBooks(data.events, data.periods, o, period);
        return carried > 0.005 || Math.abs(books.nbv) > 0.005;
      });
      if (pending.length) {
        actions.push({
          id: `dispose:${asset.id}`,
          kind: 'dispose-aro',
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
        assetNumber: asset.assetNumber,
        description: asset.description,
        detail: linked.length
          ? 'This asset was not on the latest master TCA file and still has linked ARO rows. Review whether the file omitted it or the TCA was disposed.'
          : 'This asset was not on the latest master TCA file. Review whether the file omitted it or it should be marked Disposed.',
        obligationIds: ids,
      });
    }
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
  return `Retired ${posted.length} obligation${posted.length === 1 ? '' : 's'} (${posted.join(', ')}) because the related TCA was disposed.${extra}`;
}

export function tcaAssetByNumber(assets: TcaAsset[], assetNumber: string): TcaAsset | undefined {
  const key = assetNumberKey(assetNumber);
  return assets.find((a) => assetNumberKey(a.assetNumber) === key);
}
