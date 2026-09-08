import { describe, expect, it } from 'vitest';
import { emptyAppState } from '../emptyState';
import { addReportingUnit, updateReportingUnit } from '../createUnit';
import {
  accretionRateFor, allocateMonthEnd, createOrFillPeriodBatch, monthEndRefusal,
  periodBatchRefusal, periodYearFraction, planMonthEnd, postedSides, provisionCarried, remainingDiscountTerm,
  summariseByAccount,
} from '../periodClose';
import { ENGINE_POSTING_RULES } from '../../seed';
import type { Account, JournalLine, PostingRule, TenantSettings } from '../types';
import { postNewAro, postRevision } from '../inYear';
import { loadOpeningRegister, parseOpeningRegister } from '../openingLoad';
import { rollForward } from '../../engine/rollforward';
import type { Curve } from '../../engine/curve';

function settings(over: Partial<TenantSettings> = {}): TenantSettings {
  return {
    accounts: [],
    segments: [],
    postingRules: [],
    postingScenarios: [],
    aroAssetClasses: [],
    frameworks: [],
    defaults: {
      inflation: 0.02,
      contingency: 0,
      dayCount: '30/360 US (DAYS360)',
      termConvention: 'Round up to whole year (SAP)',
      calendarType: 'Monthly (12)',
      frameworkId: 'psas',
    },
    retentionYears: 7,
    legalHold: false,
    sso: false,
    scim: false,
    ...over,
  } as TenantSettings;
}

function acc(id: string, code: string, name: string, cls: string, engineRole: string): Account {
  return { id, tenantId: 't1', code, name, cls, engineRole, requiredSegments: [], columns: {} };
}

function engineRules(): PostingRule[] {
  return ENGINE_POSTING_RULES.map(([eventType, debitRole, creditRole], i) => ({
    id: `pr-${i}`, tenantId: 't1', eventType, debitRole, creditRole, engineEmitted: true,
  }));
}

function chart(): TenantSettings {
  return settings({
    postingRules: engineRules(),
    accounts: [
      acc('p', '21500', 'ARO provision', 'Liability', 'ARO provision'),
      acc('a', '16100', 'Retirement cost asset', 'Asset', 'Retirement cost asset'),
      acc('ad', '16190', 'Accumulated depreciation', 'Asset', 'Accumulated depreciation'),
      acc('ae', '74200', 'Accretion expense', 'Expense', 'Accretion expense'),
      acc('de', '74100', 'Depreciation expense', 'Expense', 'Depreciation expense'),
      acc('s', '99999', 'Suspense', 'Liability', 'Suspense'),
    ],
  });
}

function curve(over: Partial<Curve> = {}): Curve {
  return {
    id: 'cad',
    name: 'CAD zero',
    currency: 'CAD',
    source: 'test',
    basis: 'Zero-coupon, annual compounding',
    interpolation: 'step',
    extrapolation: 'flat-last',
    asAt: '2026-03-31',
    points: [
      { term: 1, rate: 0.03 },
      { term: 5, rate: 0.035 },
      { term: 10, rate: 0.038 },
      { term: 15, rate: 0.04 },
      { term: 25, rate: 0.042 },
    ],
    ...over,
  };
}

function ready(over: { discount?: boolean; open?: boolean } = {}) {
  const state = emptyAppState();
  state.settings['t1'] = chart();
  state.curves['t1'] = [curve()];
  const id = addReportingUnit(state, {
    tenantId: 't1', entity: 'Infrastructure', fyEnd: '2027-03-31', currency: 'CAD',
  });
  updateReportingUnit(state, 't1', id, {
    frameworkId: 'psas', discount: over.discount ?? true, curveId: 'cad',
    inflation: 0.02, calendarType: 'Monthly (12)',
    dayCount: '30/360 US (DAYS360)', termConvention: 'Round up to whole year (SAP)',
  });
  const data = state.data[id];
  if (over.open !== false) data.periods[0].status = 'Open';
  const parsed = parseOpeningRegister([
    'Obligation Number,Opening provision,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
    'ARO-0001,1200000,800000,400000,25,10,AS-10001',
  ].join('\n'));
  const loaded = loadOpeningRegister(state, 't1', id, parsed, { filename: 'open.csv', text: 'x' });
  expect(typeof loaded).not.toBe('string');
  return { state, id, unit: state.units['t1'][0], data };
}

describe('period year fraction', () => {
  it('gives 1/12 for a 30/360 monthly period', () => {
    expect(periodYearFraction({ starts: '2026-04-01', ends: '2026-04-30' }, '30/360 US (DAYS360)')).toBeCloseTo(1 / 12, 12);
  });
});

describe('remaining discount term', () => {
  it('uses remaining UL when settlement was defaulted to the year end', () => {
    const { unit, data } = ready();
    const o = data.obligations[0];
    expect(o.settlementDate).toBe('2027-03-31');
    expect(remainingDiscountTerm(o, unit)).toBe(15);
    expect(accretionRateFor(o, unit, curve())).toBe(0.04);
  });
});

describe('allocate accretion at month end', () => {
  it('does not write accretion merely because a period is open and a curve is assigned', () => {
    const { state, id, data } = ready();
    expect(data.periods[0].status).toBe('Open');
    expect(createOrFillPeriodBatch(state, 't1', id)).toMatch(/Nothing on the ledger/);
    expect(data.events.some((e) => e.type === 'accretion')).toBe(false);
    expect(data.events.some((e) => e.type === 'depreciation')).toBe(false);
  });

  it('writes monthly accretion on the carried opening provision, not a full-year dump', () => {
    const { state, id, data } = ready();
    const plan = allocateMonthEnd(state, 't1', id, 'accretion');
    expect(typeof plan).not.toBe('string');
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.amount).toBe(4_000);
    expect(data.events.filter((e) => e.type === 'accretion')).toHaveLength(1);
    expect(data.events.some((e) => e.type === 'depreciation')).toBe(false);
  });

  it('accretes on opening plus in-period revisions, because accretion runs last', () => {
    const { state, id, data } = ready();
    const o = data.obligations[0];
    postRevision(state, 't1', id, o.id, {
      id: 'rev-1', kind: 'cost', amount: 100_000, date: '2026-04-15', reason: 'Scope change',
    });
    const carried = provisionCarried(data.events, data.periods, o.id, data.periods[0]);
    expect(carried).toBeGreaterThan(1_200_000);
    const plan = allocateMonthEnd(state, 't1', id, 'accretion');
    expect(typeof plan).not.toBe('string');
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.amount).toBe(Math.round(carried * 0.04 / 12 * 100) / 100);
  });

  it('does not duplicate events on a second allocate', () => {
    const { state, id } = ready();
    allocateMonthEnd(state, 't1', id, 'accretion');
    const events = state.data[id].events.length;
    expect(monthEndRefusal(state, 't1', id, 'accretion')).toMatch(/already allocated/);
    expect(state.data[id].events).toHaveLength(events);
  });

  it('writes no accretion when PSAS is undiscounted', () => {
    const { unit, data } = ready({ discount: false });
    unit.discount = false;
    const plan = planMonthEnd(unit, data, curve(), data.periods[0], 'accretion');
    expect(plan.amount).toBe(0);
    expect(plan.newEvents).toHaveLength(0);
  });

  it('accretes P02 on opening plus P01 accretion', () => {
    const { state, id, unit, data } = ready();
    allocateMonthEnd(state, 't1', id, 'accretion');
    data.periods[0].status = 'Closed';
    data.periods[1].status = 'Open';
    const carried = provisionCarried(data.events, data.periods, data.obligations[0].id, data.periods[1]);
    expect(carried).toBe(1_204_000);
    const plan = planMonthEnd(unit, data, curve(), data.periods[1], 'accretion');
    expect(plan.amount).toBe(4_013.33);
  });
});

describe('allocate amortization at month end', () => {
  it('does not write amortization merely because a period is open', () => {
    const { data } = ready();
    expect(data.events.some((e) => e.type === 'depreciation')).toBe(false);
  });

  it('amortizes the opening ARO asset over remaining useful life, without writing accretion', () => {
    const { state, id, data } = ready();
    const plan = allocateMonthEnd(state, 't1', id, 'amortization');
    expect(typeof plan).not.toBe('string');
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.amount).toBe(4_444.44);
    expect(data.events.filter((e) => e.type === 'depreciation')).toHaveLength(1);
    expect(data.events.some((e) => e.type === 'accretion')).toBe(false);
  });

  it('amortizes after in-period revisions, because amortization runs last', () => {
    const { state, id, data } = ready();
    const o = data.obligations[0];
    postRevision(state, 't1', id, o.id, {
      id: 'rev-1', kind: 'cost', amount: 100_000, date: '2026-04-15', reason: 'Scope change',
    });
    const plan = allocateMonthEnd(state, 't1', id, 'amortization');
    expect(typeof plan).not.toBe('string');
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.amount).toBeGreaterThan(4_444.44);
  });

  it('does not duplicate amortization on a second allocate', () => {
    const { state, id } = ready();
    allocateMonthEnd(state, 't1', id, 'amortization');
    const events = state.data[id].events.length;
    expect(monthEndRefusal(state, 't1', id, 'amortization')).toMatch(/already allocated/);
    expect(state.data[id].events).toHaveLength(events);
  });

  it('keeps depreciation off the provision roll-forward', () => {
    const { state, id, data } = ready();
    allocateMonthEnd(state, 't1', id, 'accretion');
    allocateMonthEnd(state, 't1', id, 'amortization');
    const rf = rollForward(data.events, data.periods[0].id);
    expect(rf.opening).toBe(1_200_000);
    expect(rf.accretion).toBe(4_000);
    expect(rf.closing).toBe(1_204_000);
  });
});

describe('summarise journal lines by GL account', () => {
  it('rolls debits, credits and suspense onto one row per account', () => {
    const lines: JournalLine[] = [
      { ord: 1, accountId: 'ae', coding: {}, debit: 100, credit: 0 },
      { ord: 2, accountId: 'p', coding: {}, debit: 0, credit: 100 },
      { ord: 3, accountId: 'ae', coding: {}, debit: 50.55, credit: 0 },
      { ord: 4, accountId: 'p', coding: {}, debit: 0, credit: 50.55, suspense: true },
    ];
    const rows = summariseByAccount(lines);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.accountId === 'ae')).toMatchObject({ debit: 150.55, credit: 0, count: 2, suspense: false });
    expect(rows.find((r) => r.accountId === 'p')).toMatchObject({ debit: 0, credit: 150.55, count: 2, suspense: true });
  });
});

describe('create batch from the ledger', () => {
  it('refuses when no period is open rather than posting to P12', () => {
    const { state, id, data } = ready({ open: false });
    expect(periodBatchRefusal(state, 't1', id)).toMatch(/Open a period/);
    expect(createOrFillPeriodBatch(state, 't1', id)).toMatch(/Open a period/);
    expect(data.batches).toHaveLength(0);
  });

  it('fills a blank draft after accretion has been allocated', () => {
    const { state, id, data } = ready();
    data.batches.push({
      id: 'jb-empty', unitId: id, periodId: data.periods[0].id,
      number: 'JB-002', status: 'Draft', lines: [],
    });
    allocateMonthEnd(state, 't1', id, 'accretion');
    allocateMonthEnd(state, 't1', id, 'amortization');
    const result = createOrFillPeriodBatch(state, 't1', id);
    expect(result).toMatchObject({ number: 'JB-002', filled: true });
    if (typeof result === 'string') throw new Error(result);
    expect(result.amount).toBe(8_444.44);
    expect(data.batches).toHaveLength(1);
  });

  it('can batch a new ARO posting without waiting for accretion', () => {
    const { state, id, data } = ready();
    const posted = postNewAro(state, 't1', id, {
      ref: 'ARO-NEW', description: 'New site', estimatedCost: 500_000,
      costEstimateDate: '2026-04-01', settlementDate: '2041-04-01', aroseOn: '2026-04-10',
      assetAcquisitionDate: '2026-04-01',
      totalUl: 15,
    });
    expect(typeof posted).not.toBe('string');
    const result = createOrFillPeriodBatch(state, 't1', id);
    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') throw new Error(result);
    expect(data.batches[0].lines.some((l) => l.accountId === 'a')).toBe(true);
    expect(data.events.some((e) => e.type === 'accretion')).toBe(false);
  });
});

describe('negative amounts swap the GLs', () => {
  it('keeps the rule as written when the amount is positive', () => {
    expect(postedSides(100, 'Retirement cost asset', 'ARO provision')).toEqual({
      debit: 'Retirement cost asset', credit: 'ARO provision',
    });
  });

  it('debits the credit account and credits the debit account when the amount is negative', () => {
    expect(postedSides(-100, 'Retirement cost asset', 'ARO provision')).toEqual({
      debit: 'ARO provision', credit: 'Retirement cost asset',
    });
    expect(postedSides(-50, 'Depreciation expense', 'Accumulated depreciation')).toEqual({
      debit: 'Accumulated depreciation', credit: 'Depreciation expense',
    });
    expect(postedSides(-20, 'Accretion expense', 'ARO provision')).toEqual({
      debit: 'ARO provision', credit: 'Accretion expense',
    });
  });
});
