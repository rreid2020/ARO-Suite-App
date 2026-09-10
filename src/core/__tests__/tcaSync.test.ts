import { describe, expect, it } from 'vitest';
import { emptyAppState } from '../emptyState';
import { addReportingUnit, updateReportingUnit } from '../createUnit';
import { loadOpeningRegister, parseOpeningRegister } from '../openingLoad';
import { loadCurrentTcaListing, loadTcaListing, lockOpeningBalances, parseTcaListing, setTcaAssetStatus, setTcaScope } from '../tcaListing';
import {
  applyCreateObligation,
  applyDisposeLinkedAro,
  applyListingExpiredUl,
  applyTcaStatusToAro,
  applyUlFromTca,
  planTcaSync,
  uniqueObligationRef,
} from '../tcaSync';
import { expiredUlFromAcquisition, remainingUlYears, tcaListingAsAt } from '../usefulLife';
import type { Account, PostingRule, TenantSettings } from '../types';
import type { Curve } from '../../engine/curve';

function settings(): TenantSettings {
  return {
    accounts: [],
    segments: [],
    postingRules: [
      ['addition', 'Retirement cost asset', 'ARO provision'],
      ['disposal', 'ARO provision', 'Gain on disposal'],
      ['asset-retirement', 'Accumulated depreciation', 'Retirement cost asset'],
      ['depreciation', 'Depreciation expense', 'Accumulated depreciation'],
    ].map(([eventType, debitRole, creditRole], i) => ({
      id: `pr-${i}`, tenantId: 't1', eventType, debitRole, creditRole, engineEmitted: true,
    } as PostingRule)),
    postingScenarios: [],
    aroAssetClasses: [],
    frameworks: [],
    defaults: {
      inflation: 0.02, contingency: 0, dayCount: '30/360 US (DAYS360)',
      termConvention: 'Round up to whole year (SAP)', calendarType: 'Monthly (12)', frameworkId: 'psas',
    },
    retentionYears: 7, legalHold: false, sso: false, scim: false,
  };
}

function curve(): Curve {
  return {
    id: 'cad', name: 'CAD zero', currency: 'CAD', source: 'test',
    basis: 'Zero-coupon', interpolation: 'step', extrapolation: 'flat-last',
    asAt: '2026-03-31',
    points: [{ term: 1, rate: 0.03 }, { term: 15, rate: 0.04 }, { term: 25, rate: 0.042 }],
  };
}

function acc(id: string, code: string, engineRole: string): Account {
  return { id, tenantId: 't1', code, name: code, cls: 'Asset', engineRole, requiredSegments: [], columns: {} };
}

function ready() {
  const state = emptyAppState();
  state.settings['t1'] = {
    ...settings(),
    accounts: [
      acc('p', '21500', 'ARO provision'),
      acc('a', '16100', 'Retirement cost asset'),
      acc('d', '16190', 'Accumulated depreciation'),
      acc('g', '42400', 'Gain on disposal'),
    ],
  };
  state.curves['t1'] = [curve()];
  const id = addReportingUnit(state, {
    tenantId: 't1', entity: 'Infrastructure', fyEnd: '2027-03-31', currency: 'CAD',
  });
  updateReportingUnit(state, 't1', id, {
    frameworkId: 'psas', discount: true, curveId: 'cad',
  });
  const data = state.data[id];
  data.periods[0].status = 'Open';
  const parsed = parseOpeningRegister([
    'Obligation Number,Opening provision,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
    'ARO-0001,1200000,800000,400000,25,10,AS-10001',
  ].join('\n'));
  loadOpeningRegister(state, 't1', id, parsed, { filename: 'open.csv', text: 'x' });
  const tca = [
    'TCA asset number,Description,Asset status,Scope,Acquisition date',
    'AS-10001,Well pad,Active,In scope,2008-06-15',
    'AS-10002,Spare tank,Active,Undecided,2019-06-30',
  ].join('\n');
  loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
  data.openingGlProvision = 1_200_000;
  data.openingGlAroCost = 1_200_000;
  data.openingGlAroAccum = 400_000;
  data.openingGlTcaCost = 0;
  data.openingGlTcaAccum = 0;
  lockOpeningBalances(data);
  return { state, id, data };
}

const ulUnit = { dayCount: '30/360 US (DAYS360)', calendarType: 'Monthly (12)' as const, fyEnd: '2027-03-31' };

function proveListingExpired(asset: { acquisitionDate?: string; totalUl?: number | null; expiredUl?: number | null }, totalUl: number) {
  asset.totalUl = totalUl;
  const asAt = tcaListingAsAt(ulUnit);
  asset.expiredUl = expiredUlFromAcquisition(asset.acquisitionDate ?? '', asAt, totalUl, ulUnit.dayCount);
}

function plan(data: ReturnType<typeof ready>['data']) {
  return planTcaSync(data, ulUnit);
}

describe('planTcaSync', () => {
  it('asks for scoping on undecided rows and a new obligation when scoped in', () => {
    const { data } = ready();
    const undecided = planTcaSync(data).filter((a) => a.kind === 'scope-undecided');
    expect(undecided.map((a) => a.assetNumber)).toEqual(['AS-10002']);

    const spare = data.tcaAssets.find((a) => a.assetNumber === 'AS-10002')!;
    const next = setTcaScope(spare, 'In scope', '', data.obligations);
    if (typeof next === 'string') throw new Error(next);
    data.tcaAssets[data.tcaAssets.findIndex((a) => a.id === spare.id)] = next;
    expect(planTcaSync(data).some((a) => a.kind === 'create-obligation' && a.assetNumber === 'AS-10002')).toBe(true);
  });

  it('flags unproductive ARO assets when the TCA is unproductive', () => {
    const { data } = ready();
    const well = data.tcaAssets.find((a) => a.assetNumber === 'AS-10001')!;
    data.tcaAssets[0] = setTcaAssetStatus(well, 'Unproductive');
    const actions = planTcaSync(data).filter((a) => a.kind === 'mark-unproductive');
    expect(actions).toHaveLength(1);
    expect(actions[0].obligationIds).toEqual([data.obligations[0].id]);
    applyTcaStatusToAro(data, data.tcaAssets[0]);
    expect(data.obligations[0].inProductiveUse).toBe(false);
    expect(planTcaSync(data).some((a) => a.kind === 'mark-unproductive')).toBe(false);
  });

  it('asks to retire linked ARO when the TCA is disposed', () => {
    const { data } = ready();
    data.tcaAssets[0] = setTcaAssetStatus(data.tcaAssets[0], 'Disposed');
    const actions = planTcaSync(data).filter((a) => a.kind === 'dispose-aro');
    expect(actions).toHaveLength(1);
    expect(actions[0].obligationIds).toEqual([data.obligations[0].id]);
  });
});

describe('apply go-forward actions', () => {
  it('creates a linked obligation and ARO asset for a newly scoped-in TCA', () => {
    const { state, id, data } = ready();
    const updated = [
      'TCA asset number,Description,Asset status,Scope,Acquisition date',
      'AS-10001,Well pad,Active,In scope,2008-06-15',
      'AS-10002,Spare tank,Active,In scope,2019-06-30',
    ].join('\n');
    loadCurrentTcaListing(state, 't1', id, parseTcaListing(updated), { filename: 'tca-2.csv', text: updated });
    const asset = data.tcaAssets.find((a) => a.assetNumber === 'AS-10002')!;
    const posted = applyCreateObligation(state, 't1', id, asset, {
      ref: uniqueObligationRef(data.obligations, 'ARO-AS-10002'),
      description: asset.description,
      estimatedCost: 250_000,
      costEstimateDate: '2026-04-01',
      settlementDate: '2041-04-01',
      aroseOn: '2026-04-12',
      aroAssetNumber: 'ARC-AS-10002',
      totalUl: 15,
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    const created = data.obligations.find((o) => o.ref === 'ARO-AS-10002')!;
    expect(created.assetId).toBe('AS-10002');
    expect(created.aroAssetNumber).toBe('ARC-AS-10002');
    expect(created.assetAcquisitionDate).toBe('2019-06-30');
    expect(data.openingSnapshot?.tcaAssets.some((a) => a.assetNumber === 'AS-10002' && a.scope === 'Undecided')).toBe(true);
    expect(planTcaSync(data).some((a) => a.kind === 'create-obligation' && a.assetNumber === 'AS-10002')).toBe(false);
  });

  it('retires remaining provision and the ARO asset when the TCA is disposed', () => {
    const { state, id, data } = ready();
    data.tcaAssets[0] = setTcaAssetStatus(data.tcaAssets[0], 'Disposed');
    const action = planTcaSync(data).find((a) => a.kind === 'dispose-aro')!;
    const msg = applyDisposeLinkedAro(state, 't1', id, action, '2026-04-12');
    expect(msg).toMatch(/^Retired /);
    expect(data.events.some((e) => e.type === 'disposal' && e.obligationId === data.obligations[0].id)).toBe(true);
    expect(planTcaSync(data).some((a) => a.kind === 'dispose-aro')).toBe(false);
  });
});

describe('register → listing gaps', () => {
  it('raises an orphan obligation whose TCA is not on the listing', () => {
    const { data } = ready();
    data.obligations.push({
      ...data.obligations[0],
      id: 'orphan-1',
      ref: 'ARO-ORPH',
      assetId: 'AS-GONE',
      aroAssetNumber: 'ARC-GONE',
    });
    const orphans = plan(data).filter((a) => a.kind === 'orphan-obligation');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].foundOn).toBe('register');
    expect(orphans[0].assetNumber).toBe('AS-GONE');
    expect(orphans[0].obligationIds).toEqual(['orphan-1']);
  });

  it('corrects listing expired UL when acquisition is the conversion date and does not copy it onto the ARO', () => {
    const { data } = ready();
    const well = data.tcaAssets.find((a) => a.assetNumber === 'AS-10001')!;
    well.acquisitionDate = '2026-03-31';
    well.totalUl = 30;
    well.expiredUl = 5;
    const openingExpired = data.obligations[0].expiredUl;
    const openingTotal = data.obligations[0].totalUl;
    const listing = plan(data).filter((a) => a.kind === 'listing-ul');
    expect(listing).toHaveLength(1);
    expect(listing[0].foundOn).toBe('listing');
    expect(listing[0].detail).toMatch(/Expired UL should be 0 yr/);
    expect(plan(data).some((a) => a.kind === 'ul-mismatch')).toBe(false);
    const msg = applyListingExpiredUl(data, listing[0], ulUnit);
    expect(msg).toMatch(/^Corrected Expired UL on AS-10001 to 0 yr/);
    expect(well.expiredUl).toBe(0);
    expect(data.obligations[0].expiredUl).toBe(openingExpired);
    expect(data.obligations[0].totalUl).toBe(openingTotal);
    expect(plan(data).some((a) => a.kind === 'listing-ul')).toBe(false);
  });

  it('aligns ARO remaining UL when the master TCA remaining life has moved on a consistent listing', () => {
    const { data } = ready();
    const well = data.tcaAssets.find((a) => a.assetNumber === 'AS-10001')!;
    proveListingExpired(well, 40);
    expect(plan(data).some((a) => a.kind === 'listing-ul')).toBe(false);
    const actions = plan(data).filter((a) => a.kind === 'ul-mismatch');
    expect(actions).toHaveLength(1);
    expect(actions[0].foundOn).toBe('register');
    expect(actions[0].obligationIds).toEqual([data.obligations[0].id]);
    const listingRemaining = remainingUlYears(well.totalUl, well.expiredUl)!;
    const msg = applyUlFromTca(data, actions[0], ulUnit);
    expect(msg).toMatch(/^Applied master TCA remaining UL/);
    expect(data.obligations[0].expiredUl).toBe(10);
    expect(data.obligations[0].totalUl).toBeCloseTo(10 + listingRemaining, 4);
    expect(plan(data).some((a) => a.kind === 'ul-mismatch')).toBe(false);
  });

  it('copies listing UL onto an obligation that has none after listing expired is proved', () => {
    const { data } = ready();
    const o = data.obligations[0];
    delete o.totalUl;
    delete o.expiredUl;
    const well = data.tcaAssets.find((a) => a.assetNumber === 'AS-10001')!;
    proveListingExpired(well, 25);
    const action = plan(data).find((a) => a.kind === 'ul-mismatch')!;
    expect(action.detail).toMatch(/no ARO useful life/);
    applyUlFromTca(data, action, ulUnit);
    expect(o.totalUl).toBe(25);
    expect(o.expiredUl).toBe(well.expiredUl);
    expect(plan(data).some((a) => a.kind === 'ul-mismatch')).toBe(false);
  });

  it('does not raise remaining-UL drift for a disposed TCA — retirement is the action', () => {
    const { data } = ready();
    data.tcaAssets[0] = { ...setTcaAssetStatus(data.tcaAssets[0], 'Disposed'), totalUl: 40, expiredUl: 10 };
    expect(plan(data).some((a) => a.kind === 'ul-mismatch')).toBe(false);
    expect(plan(data).some((a) => a.kind === 'listing-ul')).toBe(false);
    expect(plan(data).some((a) => a.kind === 'dispose-aro')).toBe(true);
  });
});
