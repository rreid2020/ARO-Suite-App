import { describe, expect, it } from 'vitest';
import { emptyAppState } from '../emptyState';
import { addReportingUnit, updateReportingUnit } from '../createUnit';
import { postNewAro, postRevision, postSettlement, requireOpenPeriod } from '../inYear';
import { loadOpeningRegister, openingArcTotal, parseOpeningRegister } from '../openingLoad';
import { assetBooks } from '../periodClose';
import type { Account, PostingRule, TenantSettings } from '../types';
import type { Curve } from '../../engine/curve';

function settings(): TenantSettings {
  return {
    accounts: [],
    segments: [],
    postingRules: [
      ['addition', 'Retirement cost asset', 'ARO provision'],
      ['revision', 'Retirement cost asset', 'ARO provision'],
      ['revision-unproductive', 'Operating costs', 'ARO provision'],
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

function ready(open = true) {
  const state = emptyAppState();
  state.settings['t1'] = {
    ...settings(),
    accounts: [
      acc('p', '21500', 'ARO provision'),
      acc('a', '16100', 'Retirement cost asset'),
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
  if (open) data.periods[0].status = 'Open';
  const parsed = parseOpeningRegister([
    'Obligation Number,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
    'ARO-0001,1200000,800000,400000,25,10,AS-10001',
  ].join('\n'));
  loadOpeningRegister(state, 't1', id, parsed, { filename: 'open.csv', text: 'x' });
  return { state, id, data };
}

describe('requireOpenPeriod', () => {
  it('refuses posting when no period is open', () => {
    const { data } = ready(false);
    expect(requireOpenPeriod(data, '2026-04-15')).toMatch(/Open a period/);
  });

  it('refuses a date outside the open period', () => {
    const { data } = ready();
    expect(requireOpenPeriod(data, '2026-05-15')).toMatch(/must fall in the open period/);
  });
});

describe('post new ARO', () => {
  it('writes an addition event when the user creates the obligation', () => {
    const { state, id, data } = ready();
    const posted = postNewAro(state, 't1', id, {
      ref: 'ARO-100', description: 'New pad', estimatedCost: 400_000,
      costEstimateDate: '2026-04-01', settlementDate: '2041-04-01', aroseOn: '2026-04-12',
      assetAcquisitionDate: '2026-04-01',
      totalUl: 15,
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    expect(posted.periodCode).toBe('FY2027 P01');
    expect(posted.amount).toBeGreaterThan(0);
    expect(data.obligations.some((o) => o.ref === 'ARO-100')).toBe(true);
    expect(data.events.some((e) => e.type === 'addition' && e.obligationId === posted.obligationId)).toBe(true);
    const created = data.obligations.find((o) => o.ref === 'ARO-100')!;
    expect(created.openingArc).toBeUndefined();
    expect(created.aroAssetNumber).toBe('ARC-ARO-100');
    expect(openingArcTotal(data.obligations)).toBe(800_000);
    const books = assetBooks(data.events, data.periods, created, data.periods[0]);
    expect(books.nbv).toBe(posted.amount);
    expect(books.additions).toBe(posted.amount);
  });

  it('charges a new obligation to expense when remaining UL is nil and the asset is not in use', () => {
    const { state, id, data } = ready();
    const posted = postNewAro(state, 't1', id, {
      ref: 'ARO-EXP', description: 'Closed site', estimatedCost: 200_000,
      costEstimateDate: '2026-04-01', settlementDate: '2026-09-01', aroseOn: '2026-04-12',
      assetAcquisitionDate: '2016-04-01',
      totalUl: 10, expiredUl: 10, inProductiveUse: false,
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    expect(posted.caseId).toBe('expense-recognition');
    expect(data.events.some((e) => e.type === 'expense-recognition' && e.obligationId === posted.obligationId)).toBe(true);
    expect(data.events.some((e) => e.type === 'addition' && e.obligationId === posted.obligationId)).toBe(false);
    const created = data.obligations.find((o) => o.ref === 'ARO-EXP')!;
    const books = assetBooks(data.events, data.periods, created, data.periods[0]);
    expect(books.nbv).toBe(0);
  });

  it('catches up amortization when expired UL is positive', () => {
    const { state, id, data } = ready();
    const posted = postNewAro(state, 't1', id, {
      ref: 'ARO-CU', description: 'Late recognition', estimatedCost: 400_000,
      costEstimateDate: '2026-04-01', settlementDate: '2046-04-01', aroseOn: '2026-04-12',
      assetAcquisitionDate: '2022-04-01',
      totalUl: 20, expiredUl: 4,
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    expect(posted.caseId).toBe('catch-up-recognition');
    const depr = data.events.find((e) => e.type === 'depreciation' && e.obligationId === posted.obligationId);
    expect(depr).toBeTruthy();
    expect(depr!.amount).toBeCloseTo(posted.amount * 0.2, 2);
  });

  it('refuses without an open period', () => {
    const { state, id } = ready(false);
    expect(postNewAro(state, 't1', id, {
      ref: 'ARO-100', description: 'New pad', estimatedCost: 400_000,
      costEstimateDate: '2026-04-01', settlementDate: '2041-04-01', aroseOn: '2026-04-12',
      assetAcquisitionDate: '2026-04-01',
    })).toMatch(/Open a period/);
  });

  it('refuses without an asset acquisition date', () => {
    const { state, id } = ready();
    expect(postNewAro(state, 't1', id, {
      ref: 'ARO-100', description: 'New pad', estimatedCost: 400_000,
      costEstimateDate: '2026-04-01', settlementDate: '2041-04-01', aroseOn: '2026-04-12',
      assetAcquisitionDate: '',
    })).toMatch(/date the obligating event occurred/);
  });

  it('sums multi-line quantity × unit rate into the cost build-up', () => {
    const { state, id, data } = ready();
    const posted = postNewAro(state, 't1', id, {
      ref: 'ARO-ML', description: 'Pad with labour',
      costEstimateDate: '2026-04-01', settlementDate: '2041-04-01', aroseOn: '2026-04-12',
      assetAcquisitionDate: '2026-04-01',
      totalUl: 15,
      lines: [
        { description: 'Labour', qty: 40, rate: 2_500 },
        { description: 'Materials', qty: 1, rate: 50_000 },
      ],
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    const created = data.obligations.find((o) => o.ref === 'ARO-ML')!;
    expect(created.lines).toHaveLength(2);
    expect(created.lines.reduce((s, l) => s + l.qty * l.rate, 0)).toBe(150_000);
  });

  it('measures expired UL from acquisition to the cost estimate date for post-cap catch-up', () => {
    const { state, id, data } = ready();
    const posted = postNewAro(state, 't1', id, {
      ref: 'ARO-POSTCAP', description: 'Recognised late',
      estimatedCost: 400_000,
      costEstimateDate: '2026-04-01', settlementDate: '2031-04-01', aroseOn: '2026-04-12',
      assetAcquisitionDate: '2006-04-01',
      totalUl: 25,
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    expect(posted.caseId).toBe('catch-up-recognition');
    const created = data.obligations.find((o) => o.ref === 'ARO-POSTCAP')!;
    expect(created.assetAcquisitionDate).toBe('2006-04-01');
    expect(created.expiredUl).toBe(20);
    const depr = data.events.find((e) => e.type === 'depreciation' && e.obligationId === posted.obligationId);
    expect(depr).toBeTruthy();
    expect(depr!.amount).toBeCloseTo(posted.amount * 20 / 25, 2);
  });

  it('defaults the ARO asset acquisition date from the master TCA listing when the form omits it', () => {
    const { state, id, data } = ready();
    data.tcaAssets = [{
      id: 'tca-041', assetNumber: 'ASSET041', description: 'Unit41', assetClass: '',
      acquisitionDate: '2006-04-01', site: '', acquisitionCost: null, accumAmort: null,
      totalUl: null, expiredUl: null,
      assetStatus: 'Active', scope: 'In scope', scopeReason: '', columns: {},
    }];
    const posted = postNewAro(state, 't1', id, {
      ref: 'ARO-ASSET041', description: 'Unit41', estimatedCost: 400_000,
      costEstimateDate: '2026-03-31', settlementDate: '2046-03-31', aroseOn: '2026-04-12',
      assetId: 'ASSET041',
      totalUl: 25,
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    const created = data.obligations.find((o) => o.ref === 'ARO-ASSET041')!;
    expect(created.assetAcquisitionDate).toBe('2006-04-01');
    expect(posted.caseId).toBe('catch-up-recognition');
  });

  it('keeps a different obligating-event date than the TCA acquisition date', () => {
    const { state, id, data } = ready();
    data.tcaAssets = [{
      id: 'tca-041', assetNumber: 'ASSET041', description: 'Unit41', assetClass: '',
      acquisitionDate: '2006-04-01', site: '', acquisitionCost: null, accumAmort: null,
      totalUl: null, expiredUl: null,
      assetStatus: 'Active', scope: 'In scope', scopeReason: '', columns: {},
    }];
    const posted = postNewAro(state, 't1', id, {
      ref: 'ARO-LATE', description: 'Obligation arose later', estimatedCost: 400_000,
      costEstimateDate: '2026-03-31', settlementDate: '2051-03-31', aroseOn: '2026-04-12',
      assetId: 'ASSET041',
      assetAcquisitionDate: '2026-04-01',
      totalUl: 25,
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    const created = data.obligations.find((o) => o.ref === 'ARO-LATE')!;
    expect(created.assetAcquisitionDate).toBe('2026-04-01');
    expect(posted.caseId).not.toBe('catch-up-recognition');
  });

  it('refuses when there is no obligating-event date and the listing has none to default from', () => {
    const { state, id, data } = ready();
    data.tcaAssets = [{
      id: 'tca-x', assetNumber: 'AS-X', description: 'No date', assetClass: '',
      acquisitionDate: '', site: '', acquisitionCost: null, accumAmort: null,
      totalUl: null, expiredUl: null,
      assetStatus: 'Active', scope: 'In scope', scopeReason: '', columns: {},
    }];
    expect(postNewAro(state, 't1', id, {
      ref: 'ARO-X', description: 'No date', estimatedCost: 100_000,
      costEstimateDate: '2026-04-01', settlementDate: '2041-04-01', aroseOn: '2026-04-12',
      assetId: 'AS-X',
      totalUl: 15,
    })).toMatch(/date the obligating event occurred/);
  });

  it('defaults Total UL and Expired UL from the master TCA listing when the form omits them', () => {
    const { state, id, data } = ready();
    data.tcaAssets = [{
      id: 'tca-041', assetNumber: 'ASSET041', description: 'Unit41', assetClass: '',
      acquisitionDate: '2006-04-01', site: '', acquisitionCost: null, accumAmort: null,
      totalUl: 25, expiredUl: 10,
      assetStatus: 'Active', scope: 'In scope', scopeReason: '', columns: {},
    }];
    const posted = postNewAro(state, 't1', id, {
      ref: 'ARO-ASSET041', description: 'Unit41', estimatedCost: 400_000,
      costEstimateDate: '2026-03-31', settlementDate: '2046-03-31', aroseOn: '2026-04-12',
      assetId: 'ASSET041',
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    const created = data.obligations.find((o) => o.ref === 'ARO-ASSET041')!;
    expect(created.totalUl).toBe(25);
    expect(created.expiredUl).toBe(10);
  });

  it('refuses a settlement date shorter than remaining UL', () => {
    const { state, id } = ready();
    expect(postNewAro(state, 't1', id, {
      ref: 'ARO-SHORT', description: 'Too soon', estimatedCost: 400_000,
      costEstimateDate: '2026-04-01', settlementDate: '2031-04-01', aroseOn: '2026-04-12',
      assetAcquisitionDate: '2026-04-01',
      totalUl: 15, expiredUl: 0,
    })).toMatch(/shorter than remaining UL/);
  });

  it('keeps a user Total UL that differs from the TCA listing', () => {
    const { state, id, data } = ready();
    data.tcaAssets = [{
      id: 'tca-041', assetNumber: 'ASSET041', description: 'Unit41', assetClass: '',
      acquisitionDate: '2020-04-01', site: '', acquisitionCost: null, accumAmort: null,
      totalUl: 25, expiredUl: 5,
      assetStatus: 'Active', scope: 'In scope', scopeReason: '', columns: {},
    }];
    const posted = postNewAro(state, 't1', id, {
      ref: 'ARO-OVR', description: 'Override', estimatedCost: 400_000,
      costEstimateDate: '2026-03-31', settlementDate: '2046-03-31', aroseOn: '2026-04-12',
      assetId: 'ASSET041',
      totalUl: 20, expiredUl: 4,
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    const created = data.obligations.find((o) => o.ref === 'ARO-OVR')!;
    expect(created.totalUl).toBe(20);
    expect(created.expiredUl).toBe(4);
  });
});

describe('post cost and term adjustments', () => {
  it('writes a revision event for a cost adjustment', () => {
    const { state, id, data } = ready();
    const o = data.obligations[0];
    const posted = postRevision(state, 't1', id, o.id, {
      id: 'rev-cost', kind: 'cost', amount: 50_000, date: '2026-04-20', reason: 'Scope change',
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    expect(posted.amount).not.toBe(0);
    expect(data.events.some((e) => e.type === 'revision' && e.note?.includes('Cost'))).toBe(true);
    expect(o.adj).toHaveLength(0);
    expect(data.obligations[0].adj).toHaveLength(1);
  });

  it('writes a revision event for a term adjustment', () => {
    const { state, id, data } = ready();
    const o = data.obligations[0];
    const posted = postRevision(state, 't1', id, o.id, {
      id: 'rev-term', kind: 'term', to: '2045-03-31', date: '2026-04-20', reason: 'Deferred retirement',
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    expect(data.events.some((e) => e.type === 'revision' && e.note?.includes('Term'))).toBe(true);
    expect(data.obligations[0].ulAlignment).toMatchObject({ status: 'Pending review' });
  });

  it('writes future revisions to operating expense when the ARO asset is not in productive use', () => {
    const { state, id, data } = ready();
    data.obligations[0] = { ...data.obligations[0], inProductiveUse: false };
    const o = data.obligations[0];
    const posted = postRevision(state, 't1', id, o.id, {
      id: 'rev-unprod', kind: 'cost', amount: 50_000, date: '2026-04-20', reason: 'Estimate update after asset became unproductive',
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    expect(posted.caseId).toBe('revision-unproductive');
    expect(data.events.some((e) => e.type === 'revision-unproductive' && e.obligationId === o.id)).toBe(true);
    expect(data.events.some((e) => e.type === 'revision' && e.obligationId === o.id)).toBe(false);
    expect(data.events.some((e) => e.type === 'depreciation' && e.obligationId === o.id)).toBe(false);
  });

  it('refuses a revision whose date is not in the open period', () => {
    const { state, id, data } = ready();
    expect(postRevision(state, 't1', id, data.obligations[0].id, {
      id: 'rev-late', kind: 'cost', amount: 10, date: '2026-05-02', reason: 'Too late',
    })).toMatch(/must fall in the open period/);
  });
});

describe('post settlement', () => {
  it('writes a true-up revision and a settlement consume on the event ledger', () => {
    const { state, id, data } = ready();
    const o = data.obligations[0];
    const posted = postSettlement(state, 't1', id, {
      obligationId: o.id,
      pct: 1,
      actualCost: 1_500_000,
      settledOn: '2026-04-20',
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    expect(data.events.some((e) => e.type === 'revision' && e.obligationId === o.id && e.amount > 0)).toBe(true);
    expect(data.events.some((e) => e.type === 'settlement' && e.obligationId === o.id && e.amount < 0)).toBe(true);
    expect(data.settlements).toHaveLength(1);
    expect(data.settlements[0].posted).toBe(true);
  });

  it('extinguishes the provision on sale of the related asset', () => {
    const { state, id, data } = ready();
    const o = data.obligations[0];
    const posted = postSettlement(state, 't1', id, {
      obligationId: o.id,
      pct: 1,
      actualCost: 0,
      settledOn: '2026-04-20',
      relatedAssetSold: true,
    });
    expect(typeof posted).not.toBe('string');
    if (typeof posted === 'string') throw new Error(posted);
    expect(posted.caseId).toBe('sale');
    expect(data.events.some((e) => e.type === 'disposal' && e.obligationId === o.id)).toBe(true);
    expect(data.events.some((e) => e.type === 'settlement' && e.obligationId === o.id)).toBe(false);
  });
});
