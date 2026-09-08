import { describe, expect, it } from 'vitest';
import { emptyAppState } from '../emptyState';
import { chartColumnNames, deleteAccount, deleteUnusedAccounts, importChartOfAccounts, parseChartText } from '../chartImport';
import { accountTypeOf } from '../accountType';
import type { Account, TenantSettings } from '../types';

function settings(): TenantSettings {
  return {
    accounts: [],
    segments: [],
    postingRules: [],
    postingScenarios: [],
    aroAssetClasses: [],
    frameworks: [],
    defaults: {
      inflation: 0.025,
      contingency: 0.1,
      dayCount: '30/360 US (DAYS360)',
      termConvention: 'Round up to whole year (SAP)',
      calendarType: 'Monthly (12)',
      frameworkId: 'ifrs',
    },
    retentionYears: 7,
    legalHold: false,
    sso: false,
    scim: false,
  };
}

function acc(over: Partial<Account> & Pick<Account, 'id' | 'code'>): Account {
  return {
    tenantId: 't1', name: over.name ?? over.code, cls: 'Liability', engineRole: '', requiredSegments: [], columns: {},
    ...over,
  };
}

describe('parseChartText', () => {
  it('reads a headed CSV and maps class aliases', () => {
    const parsed = parseChartText([
      'Code,Name,Type',
      '22500,ARO provision,Liab',
      '16100,Retirement cost asset,Asset',
      '74200,Accretion expense,Expense',
    ].join('\n'));
    expect(parsed.rows.map((r) => [r.code, r.cls])).toEqual([
      ['22500', 'Liability'],
      ['16100', 'Asset'],
      ['74200', 'Expense'],
    ]);
    expect(parsed.problems).toEqual([]);
  });

  it('reads tab-separated paste without headers', () => {
    const parsed = parseChartText('10100\tCash at bank\tAsset\n99999\tSuspense\tLiability');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].code).toBe('10100');
    expect(parsed.rows[0].name).toBe('Cash at bank');
  });

  it('keeps quoted commas inside a name', () => {
    const parsed = parseChartText('Code,Name,Class\n16100,"Retirement cost asset, net",Asset');
    expect(parsed.rows[0].name).toBe('Retirement cost asset, net');
  });

  it('skips a duplicate code and a row without a name', () => {
    const parsed = parseChartText([
      'Code,Name,Class',
      '16100,Retirement cost asset,Asset',
      '16100,Duplicate,Asset',
      ',No code,Asset',
      '22500,,Liability',
    ].join('\n'));
    expect(parsed.rows.map((r) => r.code)).toEqual(['16100']);
    expect(parsed.problems.some((p) => /duplicated/.test(p))).toBe(true);
    expect(parsed.problems.some((p) => /no account code/.test(p))).toBe(true);
    expect(parsed.problems.some((p) => /no name/.test(p))).toBe(true);
  });

  it('names extra columns as coding segments', () => {
    const parsed = parseChartText([
      'Code,Name,Class,Company,Cost centre',
      '22500,ARO provision,Liability,1000,CC-100',
      '16100,RCA,Asset,1000,CC-200',
    ].join('\n'));
    expect(parsed.segmentNames).toEqual(['Company', 'Cost centre']);
    expect(parsed.rows[0].segments).toEqual({ Company: '1000', 'Cost centre': 'CC-100' });
  });

  it('reads camelCase AccountType as an extra column, not a missing class', () => {
    const parsed = parseChartText([
      'Code,Name,AccountType',
      '27530,Discounted present value of contractual lease restoration obligations,Liability',
    ].join('\n'));
    expect(parsed.rows[0].cls).toBe('');
    expect(parsed.rows[0].segments.AccountType).toBe('Liability');
  });
});

describe('importChartOfAccounts', () => {
  it('adds new GLs and updates name and class on a matching code without stealing its engine role', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].accounts = [
      acc({ id: 'a1', code: '22500', name: 'Old provision', cls: 'Liability', engineRole: 'ARO provision' }),
    ];
    const parsed = parseChartText('Code,Name,Class\n22500,Provision — ARO,Liability\n10100,Cash at bank,Asset');
    const result = importChartOfAccounts(state, 't1', parsed);
    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    expect(state.settings['t1'].accounts.find((a) => a.code === '22500')).toMatchObject({
      id: 'a1', name: 'Provision — ARO', engineRole: 'ARO provision',
    });
    expect(state.settings['t1'].accounts.find((a) => a.code === '10100')?.name).toBe('Cash at bank');
  });

  it('drops leftover seed accounts that are not in the file and not on a journal', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].accounts = [
      acc({ id: 'seed', code: '99999', name: 'Seed suspense', engineRole: 'Suspense' }),
      acc({ id: 'keep', code: '22500', name: 'Provision', engineRole: 'ARO provision' }),
    ];
    const parsed = parseChartText('Code,Name,Class\n22500,ARO liability,Liability');
    const result = importChartOfAccounts(state, 't1', parsed);
    expect(result.removed).toBe(1);
    expect(state.settings['t1'].accounts.map((a) => a.code)).toEqual(['22500']);
    expect(state.settings['t1'].accounts[0].engineRole).toBe('ARO provision');
  });

  it('keeps an account a journal still posts to even when the file omits it', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].accounts = [
      acc({ id: 'posted', code: '74200', name: 'Accretion', engineRole: 'Accretion expense' }),
    ];
    state.units['t1'] = [{ id: 'u1' }] as never;
    state.data['u1'] = { batches: [{ lines: [{ accountId: 'posted' }] }] } as never;
    const parsed = parseChartText('Code,Name,Class\n10100,Cash,Asset');
    const result = importChartOfAccounts(state, 't1', parsed);
    expect(result.removed).toBe(0);
    expect(state.settings['t1'].accounts.map((a) => a.code).sort()).toEqual(['10100', '74200']);
    expect(result.problems.some((p) => /journal/.test(p))).toBe(true);
  });

  it('applies an engine-role column and moves the role off the previous holder', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].accounts = [
      acc({ id: 'old', code: '21500', name: 'Old', engineRole: 'ARO provision' }),
    ];
    const parsed = parseChartText('Code,Name,Class,Engine role\n22500,New provision,Liability,ARO provision');
    importChartOfAccounts(state, 't1', parsed);
    expect(state.settings['t1'].accounts.find((a) => a.code === '22500')?.engineRole).toBe('ARO provision');
    expect(state.settings['t1'].accounts.find((a) => a.code === '21500')).toBeUndefined();
  });

  it('creates coding segments from extra columns and unions permitted values on a re-import', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].segments = [
      { id: 's1', tenantId: 't1', ord: 1, name: 'Company', required: true, permitted: ['1000'] },
    ];
    const parsed = parseChartText([
      'Code,Name,Class,Company,Cost centre',
      '22500,ARO,Liability,1000,CC-100',
      '16100,RCA,Asset,1100,CC-100',
    ].join('\n'));
    const result = importChartOfAccounts(state, 't1', parsed);
    expect(result.segmentsUpdated.sort()).toEqual(['Company', 'Cost centre']);
    const company = state.settings['t1'].segments.find((s) => s.name === 'Company')!;
    expect(company.permitted.sort()).toEqual(['1000', '1100']);
    const cc = state.settings['t1'].segments.find((s) => s.name === 'Cost centre')!;
    expect(cc.permitted).toEqual(['CC-100']);
    expect(cc.required).toBe(true);
    expect(state.settings['t1'].accounts.find((a) => a.code === '22500')?.columns).toEqual({
      Company: '1000', 'Cost centre': 'CC-100',
    });
    expect(state.settings['t1'].accounts.find((a) => a.code === '16100')?.columns).toEqual({
      Company: '1100', 'Cost centre': 'CC-100',
    });
  });

  it('sets engine class from AccountType even when a Type column disagrees', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const parsed = parseChartText([
      'Code,Name,Type,AccountType',
      '27530,Lease restoration obligations,Asset,Liability',
    ].join('\n'));
    importChartOfAccounts(state, 't1', parsed);
    const acc = state.settings['t1'].accounts.find((a) => a.code === '27530')!;
    expect(acc.cls).toBe('Liability');
    expect(acc.columns.AccountType).toBe('Liability');
  });
});

describe('deleteAccount', () => {
  it('removes an unused GL and clears it from posting scenarios', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].accounts = [
      acc({ id: 'a1', code: '22500', name: 'ARO provision', engineRole: 'ARO provision' }),
    ];
    state.settings['t1'].postingScenarios = [{
      id: 't1-scn-default', tenantId: 't1', name: 'Standard ARO', isDefault: true,
      accounts: { 'ARO provision': 'a1' }, completedRoles: ['ARO provision'],
    }];
    const result = deleteAccount(state, 't1', 'a1');
    expect(result).toEqual({ ok: true });
    expect(state.settings['t1'].accounts).toEqual([]);
    expect(state.settings['t1'].postingScenarios[0].accounts).toEqual({});
    expect(state.settings['t1'].postingScenarios[0].completedRoles).toEqual([]);
  });

  it('refuses when a journal still posts to the GL', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].accounts = [
      acc({ id: 'posted', code: '74200', name: 'Accretion' }),
    ];
    state.units['t1'] = [{ id: 'u1' }] as never;
    state.data['u1'] = { batches: [{ lines: [{ accountId: 'posted' }] }] } as never;
    const result = deleteAccount(state, 't1', 'posted');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refuse');
    expect(result.reason).toMatch(/journal/);
    expect(state.settings['t1'].accounts).toHaveLength(1);
  });
});

describe('deleteUnusedAccounts', () => {
  it('drops unused GLs and keeps ones a journal still posts to', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].accounts = [
      acc({ id: 'posted', code: '74200', name: 'Accretion' }),
      acc({ id: 'spare', code: '99999', name: 'Seed suspense' }),
    ];
    state.settings['t1'].postingScenarios = [{
      id: 't1-scn-wells', tenantId: 't1', name: 'Wells', isDefault: false,
      accounts: { Suspense: 'spare' }, completedRoles: ['Suspense'],
    }];
    state.units['t1'] = [{ id: 'u1' }] as never;
    state.data['u1'] = { batches: [{ lines: [{ accountId: 'posted' }] }] } as never;
    const result = deleteUnusedAccounts(state, 't1');
    expect(result).toEqual({ removed: 1, kept: 1 });
    expect(state.settings['t1'].accounts.map((a) => a.id)).toEqual(['posted']);
    expect(state.settings['t1'].postingScenarios[0].accounts).toEqual({});
  });

  it('removes the whole chart when no journal posts to any GL', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].accounts = [
      acc({ id: 'a1', code: '22500', name: 'ARO provision' }),
      acc({ id: 'a2', code: '16100', name: 'Retirement cost asset' }),
    ];
    expect(deleteUnusedAccounts(state, 't1')).toEqual({ removed: 2, kept: 0 });
    expect(state.settings['t1'].accounts).toEqual([]);
  });
});

describe('chartColumnNames', () => {
  it('orders extra headings by the coding block, then any other keys from the file', () => {
    const accounts = [
      acc({ id: 'a1', code: '1', columns: { Company: '1000', ParentAccount: '12000', 'Cost centre': 'CC-100' } }),
    ];
    expect(chartColumnNames(accounts, [
      { id: 's1', tenantId: 't1', ord: 1, name: 'Company', required: true, permitted: [] },
      { id: 's2', tenantId: 't1', ord: 2, name: 'Cost centre', required: true, permitted: [] },
    ])).toEqual(['Company', 'Cost centre', 'ParentAccount']);
  });

  it('falls back to coding-block names when no per-GL columns are stored yet', () => {
    expect(chartColumnNames(
      [acc({ id: 'a1', code: '1' })],
      [{ id: 's1', tenantId: 't1', ord: 1, name: 'Company', required: true, permitted: [] }],
    )).toEqual(['Company']);
  });
});

describe('accountTypeOf', () => {
  it('prefers the chart AccountType column over a defaulted engine class', () => {
    expect(accountTypeOf(acc({
      id: 'a1', code: '27530', cls: 'Asset',
      columns: { AccountType: 'Liability' },
    }))).toBe('Liability');
  });
});
