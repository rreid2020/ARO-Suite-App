import { describe, expect, it } from 'vitest';
import {
  accountFitForRole, accountForRole, addPostingRule, alignDefaultScenarioFromChart, assignScenarioRole, completedRoleCount, defaultScenario, deletePostingRule,
  ensureClassScenarioAccounts, ensureEnginePostingRules, ensurePostingScenarios, ensureRoleAccountsOnChart, hasProvisionMapping, prefillUnassignedFromChart, renamePostingRuleEvent,
  scenarioForObligation, setRoleComplete, suggestRoleAccounts, syncDefaultScenarioFromRoles,
} from '../posting';
import type { Account, AroAssetClass, PostingScenario, TenantSettings } from '../types';

function acc(over: Partial<Account> & Pick<Account, 'id' | 'code' | 'engineRole'>): Account {
  return { tenantId: 't1', name: over.name ?? over.code, cls: 'Asset', requiredSegments: [], columns: {}, ...over };
}

function settings(over: Partial<TenantSettings> = {}): TenantSettings {
  return {
    accounts: [],
    segments: [],
    postingRules: [],
    postingScenarios: [],
    aroAssetClasses: [],
    frameworks: [],
    defaults: {
      inflation: 0.025, contingency: 0.1, dayCount: '30/360 US (DAYS360)',
      termConvention: 'Round up to whole year (SAP)', calendarType: 'Monthly (12)', frameworkId: 'ifrs',
    },
    retentionYears: 7, legalHold: false, sso: false, scim: false,
    ...over,
  };
}

describe('posting scenarios', () => {
  it('synthesizes a default scenario from leftover engine-role assignments', () => {
    const st = settings({
      accounts: [
        acc({ id: 'p', code: '21500', engineRole: 'ARO provision', cls: 'Liability' }),
        acc({ id: 'a', code: '16100', engineRole: 'Retirement cost asset' }),
      ],
    });
    const def = defaultScenario(st, 't1');
    expect(def.isDefault).toBe(true);
    expect(def.accounts['ARO provision']).toBe('p');
    expect(hasProvisionMapping(st, 't1')).toBe(true);
  });

  it('resolves GLs from the asset class scenario, not a global role', () => {
    const wells: PostingScenario = {
      id: 'scn-wells', tenantId: 't1', name: 'Wells', isDefault: false,
      accounts: { 'ARO provision': 'p-wells', 'Retirement cost asset': 'a-wells' },
      completedRoles: [],
    };
    const plant: PostingScenario = {
      id: 'scn-plant', tenantId: 't1', name: 'Plant', isDefault: true,
      accounts: { 'ARO provision': 'p-plant', 'Retirement cost asset': 'a-plant' },
      completedRoles: [],
    };
    const classes: AroAssetClass[] = [
      { id: 'c1', tenantId: 't1', name: 'Well abandonment', scenarioId: 'scn-wells' },
      { id: 'c2', tenantId: 't1', name: 'Plant decommissioning', scenarioId: 'scn-plant' },
    ];
    const st = settings({
      accounts: [
        acc({ id: 'p-wells', code: '22100', engineRole: '', cls: 'Liability' }),
        acc({ id: 'a-wells', code: '16200', engineRole: '' }),
        acc({ id: 'p-plant', code: '22200', engineRole: '', cls: 'Liability' }),
        acc({ id: 'a-plant', code: '16300', engineRole: '' }),
      ],
      postingScenarios: [wells, plant],
      aroAssetClasses: classes,
    });
    expect(accountForRole(st, 't1', 'ARO provision', { id: 'o1', aroAssetClass: 'Well abandonment' })?.code).toBe('22100');
    expect(accountForRole(st, 't1', 'ARO provision', { id: 'o2', aroAssetClass: 'Plant decommissioning' })?.code).toBe('22200');
    expect(accountForRole(st, 't1', 'ARO provision', { id: 'o3' })?.code).toBe('22200');
    expect(accountForRole(st, 't1', 'ARO provision', { id: 'o4', type: 'Well abandonment' })?.code).toBe('22100');
  });

  it('resolves GLs by asset class code, name, or combined label', () => {
    const buildings: PostingScenario = {
      id: 'scn-b', tenantId: 't1', name: '11010 — Buildings', isDefault: false,
      accounts: { 'ARO provision': 'p-b' },
      completedRoles: [],
    };
    const fallback: PostingScenario = {
      id: 'scn-d', tenantId: 't1', name: 'Standard ARO', isDefault: true,
      accounts: { 'ARO provision': 'p-d' },
      completedRoles: [],
    };
    const st = settings({
      accounts: [
        acc({ id: 'p-b', code: '21510', engineRole: '', cls: 'Liability' }),
        acc({ id: 'p-d', code: '27500', engineRole: '', cls: 'Liability' }),
      ],
      postingScenarios: [buildings, fallback],
      aroAssetClasses: [
        { id: 'c-b', tenantId: 't1', code: '11010', name: 'Buildings', scenarioId: 'scn-b' },
      ],
    });
    expect(scenarioForObligation(st, 't1', { id: 'o1', aroAssetClass: '11010' }).id).toBe('scn-b');
    expect(accountForRole(st, 't1', 'ARO provision', { id: 'o1', aroAssetClass: '11010' })?.code).toBe('21510');
    expect(accountForRole(st, 't1', 'ARO provision', { id: 'o2', aroAssetClass: 'Buildings' })?.code).toBe('21510');
    expect(accountForRole(st, 't1', 'ARO provision', { id: 'o3', aroAssetClass: '11010 Buildings' })?.code).toBe('21510');
    expect(accountForRole(st, 't1', 'ARO provision', { id: 'o4', aroAssetClass: '11010 — Buildings' })?.code).toBe('21510');
    expect(accountForRole(st, 't1', 'ARO provision', { id: 'o5' })?.code).toBe('27500');
  });

  it('assigning a GL on the default scenario moves the leftover engine role', () => {
    const st = settings({
      accounts: [
        acc({ id: 'p1', code: '21500', engineRole: 'ARO provision', cls: 'Liability' }),
        acc({ id: 'p2', code: '21600', engineRole: '', cls: 'Liability' }),
      ],
    });
    ensurePostingScenarios(st, 't1');
    assignScenarioRole(st, defaultScenario(st, 't1').id, 'ARO provision', 'p2');
    expect(st.accounts.find((a) => a.id === 'p2')?.engineRole).toBe('ARO provision');
    expect(st.accounts.find((a) => a.id === 'p1')?.engineRole).toBe('');
    expect(defaultScenario(st, 't1').accounts['ARO provision']).toBe('p2');
  });

  it('rebuilds the default scenario after a chart import changes holders', () => {
    const st = settings({
      accounts: [acc({ id: 'old', code: '21500', engineRole: 'ARO provision', cls: 'Liability' })],
    });
    ensurePostingScenarios(st, 't1');
    st.accounts = [acc({ id: 'new', code: '22500', engineRole: 'ARO provision', cls: 'Liability' })];
    syncDefaultScenarioFromRoles(st, 't1');
    expect(defaultScenario(st, 't1').accounts['ARO provision']).toBe('new');
  });

  it('records a completed role and clears it when the GL is unassigned', () => {
    const st = settings({
      accounts: [acc({ id: 'p1', code: '21500', engineRole: 'ARO provision', cls: 'Liability' })],
    });
    ensurePostingScenarios(st, 't1');
    const id = defaultScenario(st, 't1').id;
    setRoleComplete(st, id, 'ARO provision', true);
    expect(completedRoleCount(defaultScenario(st, 't1'))).toBe(1);
    assignScenarioRole(st, id, 'ARO provision', '');
    expect(defaultScenario(st, 't1').completedRoles).not.toContain('ARO provision');
    expect(completedRoleCount(defaultScenario(st, 't1'))).toBe(0);
  });
});

describe('suggestRoleAccounts', () => {
  it('matches imported GLs by name and class without an engine-role column', () => {
    const accounts = [
      acc({ id: 'p', code: '22500', name: 'ARO liability', engineRole: '', cls: 'Liability' }),
      acc({ id: 'a', code: '16100', name: 'Retirement cost asset', engineRole: '', cls: 'Asset' }),
      acc({ id: 'ad', code: '16190', name: 'Accumulated depreciation — retirement cost asset', engineRole: '', cls: 'Asset' }),
      acc({ id: 'ac', code: '74200', name: 'Accretion expense', engineRole: '', cls: 'Expense' }),
      acc({ id: 'de', code: '74100', name: 'Depreciation — retirement cost asset', engineRole: '', cls: 'Expense' }),
      acc({ id: 'op', code: '45000', name: 'Site restoration', engineRole: '', cls: 'Expense' }),
      acc({ id: 'w', code: '48000', name: 'Write-back of surplus provision', engineRole: '', cls: 'Income' }),
      acc({ id: 'c', code: '10100', name: 'Cash at bank', engineRole: '', cls: 'Asset' }),
      acc({ id: 'fx', code: '32100', name: 'Foreign currency translation reserve', engineRole: '', cls: 'Equity' }),
      acc({ id: 's', code: '99999', name: 'Suspense — unmapped ARO events', engineRole: '', cls: 'Liability' }),
    ];
    const map = suggestRoleAccounts(accounts);
    expect(map['ARO provision']).toBe('p');
    expect(map['Retirement cost asset']).toBe('a');
    expect(map['Accumulated depreciation']).toBe('ad');
    expect(map['Accretion expense']).toBe('ac');
    expect(map['Depreciation expense']).toBe('de');
    expect(map['Operating costs']).toBe('op');
    expect(map['Write-back to income']).toBe('w');
    expect(map['Cash']).toBe('c');
    expect(map['FX translation reserve']).toBe('fx');
    expect(map['Suspense']).toBe('s');
  });

  it('scores a parent contra as accumulated depreciation', () => {
    const parent = acc({ id: 'accumP', code: '15690', name: 'Parent contra-asset control account for depreciation of capitalized asset retirement costs.', engineRole: '', cls: 'Asset' });
    const child = acc({ id: 'accumC', code: '15692', name: 'Contra-asset for depreciation of storage tank asset retirement cost.', engineRole: 'Accumulated depreciation', cls: 'Asset' });
    expect(accountFitForRole(parent, 'Accumulated depreciation')).toBeGreaterThan(accountFitForRole(child, 'Accumulated depreciation'));
    expect(accountFitForRole(parent, 'Retirement cost asset')).toBe(0);
  });

  it('does not treat a contra-asset as the retirement-cost asset', () => {
    const map = suggestRoleAccounts([
      acc({ id: 'gross', code: '15600', name: 'Parent control account for asset retirement costs capitalized to the related long-lived asset.', engineRole: '', cls: 'Asset' }),
      acc({ id: 'contra', code: '15695', name: 'Contra-asset for depreciation of plant decommissioning asset retirement cost.', engineRole: 'Retirement cost asset', cls: 'Asset' }),
    ]);
    expect(map['Retirement cost asset']).toBe('gross');
    expect(map['Accumulated depreciation']).toBe('contra');
  });

  it('does not treat accretion as operating cost, and prefers parent control accounts', () => {
    const map = suggestRoleAccounts([
      acc({ id: 'prov', code: '27500', name: 'Parent control account for the long-term portion of asset retirement obligations.', engineRole: '', cls: 'Liability' }),
      acc({ id: 'lease', code: '27530', name: 'Discounted present value of contractual lease restoration obligations.', engineRole: 'ARO provision', cls: 'Liability' }),
      acc({ id: 'arc', code: '15600', name: 'Parent control account for asset retirement costs capitalized to the related long-lived asset.', engineRole: '', cls: 'Asset' }),
      acc({ id: 'accumP', code: '15690', name: 'Parent contra-asset control account for depreciation of capitalized asset retirement costs.', engineRole: '', cls: 'Asset' }),
      acc({ id: 'accumC', code: '15692', name: 'Contra-asset for depreciation of storage tank asset retirement cost.', engineRole: 'Accumulated depreciation', cls: 'Asset' }),
      acc({ id: 'accP', code: '65100', name: 'Parent control account for the periodic unwinding of the ARO discount.', engineRole: '', cls: 'Expense' }),
      acc({ id: 'accC', code: '65150', name: 'Accretion of plant decommissioning and site restoration obligations.', engineRole: 'Operating costs', cls: 'Expense' }),
      acc({ id: 'dep', code: '65200', name: 'Systematic allocation of capitalized asset retirement cost over the useful life of the asset.', engineRole: '', cls: 'Expense' }),
      acc({ id: 'over', code: '65300', name: 'Excess of actual retirement cost paid over the recorded obligation at settlement date.', engineRole: '', cls: 'Expense' }),
      acc({ id: 'surplus', code: '65310', name: 'Excess of the recorded obligation over actual retirement cost paid at settlement date.', engineRole: '', cls: 'Income' }),
      acc({ id: 'cash', code: '12500', name: 'Cash held in trust and legally restricted for funding future asset retirement activities.', engineRole: '', cls: 'Asset' }),
    ]);
    expect(map['ARO provision']).toBe('prov');
    expect(map['Retirement cost asset']).toBe('arc');
    expect(map['Accumulated depreciation']).toBe('accumP');
    expect(map['Accretion expense']).toBe('accP');
    expect(map['Depreciation expense']).toBe('dep');
    expect(map['Operating costs']).toBe('over');
    expect(map['Write-back to income']).toBe('surplus');
    expect(map.Cash).toBe('cash');
  });

  it('does not assign a cash GL to an expense role', () => {
    const map = suggestRoleAccounts([
      acc({ id: 'c', code: '10100', name: 'Cash at bank', engineRole: '', cls: 'Asset' }),
    ]);
    expect(map.Cash).toBe('c');
    expect(map['Operating costs']).toBeUndefined();
  });
});

describe('prefillUnassignedFromChart', () => {
  it('fills empty scenario roles and leaves existing picks', () => {
    const st = settings({
      accounts: [
        acc({ id: 'p', code: '22500', name: 'ARO liability', engineRole: '', cls: 'Liability' }),
        acc({ id: 'c', code: '10100', name: 'Cash at bank', engineRole: '', cls: 'Asset' }),
      ],
      postingScenarios: [{
        id: 't1-scn-default', tenantId: 't1', name: 'Standard ARO', isDefault: true,
        accounts: { 'ARO provision': 'p' }, completedRoles: [],
      }],
    });
    const n = prefillUnassignedFromChart(st, 't1');
    expect(n).toBe(1);
    expect(st.postingScenarios[0].accounts['ARO provision']).toBe('p');
    expect(st.postingScenarios[0].accounts.Cash).toBe('c');
    expect(prefillUnassignedFromChart(st, 't1')).toBe(0);
  });
});

describe('ensureRoleAccountsOnChart', () => {
  it('adds seed GLs only for roles the imported chart cannot fill', () => {
    const st = settings({
      accounts: [
        acc({ id: 'p', code: '27500', name: 'Parent control account for the long-term portion of asset retirement obligations.', engineRole: '', cls: 'Liability' }),
        acc({ id: 'a', code: '15600', name: 'Parent control account for asset retirement costs capitalized to the related long-lived asset.', engineRole: '', cls: 'Asset' }),
      ],
    });
    const n = ensureRoleAccountsOnChart(st, 't1');
    expect(n).toBeGreaterThan(0);
    expect(st.accounts.some((a) => a.code === '27500')).toBe(true);
    expect(st.accounts.some((a) => a.code === '15600')).toBe(true);
    expect(st.accounts.find((a) => a.code === '21500')).toBeUndefined();
    expect(st.accounts.find((a) => a.code === '42400')?.name).toMatch(/Gain on disposal/);
    expect(st.accounts.find((a) => a.code === '51500')?.name).toMatch(/Loss on disposal/);
    expect(st.accounts.find((a) => a.code === '32100')?.name).toMatch(/translation/);
    expect(st.accounts.find((a) => a.code === '99999')?.name).toMatch(/Suspense/);
    expect(ensureRoleAccountsOnChart(st, 't1')).toBe(0);
  });
});

describe('alignDefaultScenarioFromChart', () => {
  it('maps Standard ARO onto parent GLs and adds missing test accounts', () => {
    const st = settings({
      accounts: [
        acc({ id: 'lease', code: '27530', name: 'Discounted present value of contractual lease restoration obligations.', engineRole: 'ARO provision', cls: 'Liability' }),
        acc({ id: 'prov', code: '27500', name: 'Parent control account for the long-term portion of asset retirement obligations.', engineRole: '', cls: 'Liability' }),
        acc({ id: 'contra', code: '15695', name: 'Contra-asset for depreciation of plant decommissioning asset retirement cost.', engineRole: 'Retirement cost asset', cls: 'Asset' }),
        acc({ id: 'arc', code: '15600', name: 'Parent control account for asset retirement costs capitalized to the related long-lived asset.', engineRole: '', cls: 'Asset' }),
        acc({ id: 'accumP', code: '15690', name: 'Parent contra-asset control account for depreciation of capitalized asset retirement costs.', engineRole: '', cls: 'Asset' }),
        acc({ id: 'accP', code: '65100', name: 'Parent control account for the periodic unwinding of the ARO discount.', engineRole: '', cls: 'Expense' }),
        acc({ id: 'accC', code: '65150', name: 'Accretion of plant decommissioning and site restoration obligations.', engineRole: 'Operating costs', cls: 'Expense' }),
        acc({ id: 'dep', code: '65200', name: 'Systematic allocation of capitalized asset retirement cost over the useful life of the asset.', engineRole: 'Depreciation expense', cls: 'Expense' }),
        acc({ id: 'over', code: '65300', name: 'Excess of actual retirement cost paid over the recorded obligation at settlement date.', engineRole: '', cls: 'Expense' }),
        acc({ id: 'surplus', code: '65310', name: 'Excess of the recorded obligation over actual retirement cost paid at settlement date.', engineRole: '', cls: 'Income' }),
        acc({ id: 'cash', code: '12500', name: 'Cash held in trust and legally restricted for funding future asset retirement activities.', engineRole: 'Cash', cls: 'Asset' }),
      ],
      postingScenarios: [{
        id: 't1-scn-default', tenantId: 't1', name: 'Standard ARO', isDefault: true,
        accounts: {
          'ARO provision': 'lease',
          'Retirement cost asset': 'contra',
          'Operating costs': 'accC',
          Cash: 'cash',
          'Depreciation expense': 'dep',
        },
        completedRoles: [],
      }],
    });
    alignDefaultScenarioFromChart(st, 't1');
    const def = defaultScenario(st, 't1');
    expect(def.accounts['ARO provision']).toBe('prov');
    expect(def.accounts['Retirement cost asset']).toBe('arc');
    expect(def.accounts['Accumulated depreciation']).toBe('accumP');
    expect(def.accounts['Accretion expense']).toBe('accP');
    expect(def.accounts['Depreciation expense']).toBe('dep');
    expect(def.accounts['Operating costs']).toBe('over');
    expect(def.accounts['Write-back to income']).toBe('surplus');
    expect(def.accounts.Cash).toBe('cash');
    expect(st.accounts.find((a) => a.id === def.accounts['Gain on disposal'])?.code).toBe('42400');
    expect(st.accounts.find((a) => a.id === def.accounts['Loss on disposal'])?.code).toBe('51500');
    expect(st.accounts.find((a) => a.id === def.accounts['FX translation reserve'])?.code).toBe('32100');
    expect(st.accounts.find((a) => a.id === def.accounts.Suspense)?.code).toBe('99999');
  });

  it('does not overwrite a role the user marked complete', () => {
    const st = settings({
      accounts: [
        acc({ id: 'lease', code: '27530', name: 'Discounted present value of contractual lease restoration obligations.', engineRole: '', cls: 'Liability' }),
        acc({ id: 'prov', code: '27500', name: 'Parent control account for the long-term portion of asset retirement obligations.', engineRole: '', cls: 'Liability' }),
      ],
      postingScenarios: [{
        id: 't1-scn-default', tenantId: 't1', name: 'Standard ARO', isDefault: true,
        accounts: { 'ARO provision': 'lease' }, completedRoles: ['ARO provision'],
      }],
    });
    alignDefaultScenarioFromChart(st, 't1');
    expect(defaultScenario(st, 't1').accounts['ARO provision']).toBe('lease');
  });
});

describe('ensureClassScenarioAccounts', () => {
  it('gives Buildings and Works their own GLs and leaves Standard ARO on the parents', () => {
    const st = settings({
      accounts: [
        acc({ id: 'prov', code: '27500', name: 'Parent control account for the long-term portion of asset retirement obligations.', engineRole: 'ARO provision', cls: 'Liability' }),
        acc({ id: 'arc', code: '15600', name: 'Parent control account for asset retirement costs capitalized to the related long-lived asset.', engineRole: 'Retirement cost asset', cls: 'Asset' }),
      ],
      postingScenarios: [
        {
          id: 't1-scn-default', tenantId: 't1', name: 'Standard ARO', isDefault: true,
          accounts: { 'ARO provision': 'prov', 'Retirement cost asset': 'arc' }, completedRoles: [],
        },
        {
          id: 'scn-b', tenantId: 't1', name: '11010 Buildings', isDefault: false,
          accounts: { 'ARO provision': 'prov', 'Retirement cost asset': 'arc' }, completedRoles: [],
        },
        {
          id: 'scn-w', tenantId: 't1', name: '11040 Works', isDefault: false,
          accounts: { 'ARO provision': 'prov', 'Retirement cost asset': 'arc' }, completedRoles: [],
        },
      ],
    });
    ensureClassScenarioAccounts(st, 't1');
    const buildings = st.postingScenarios.find((s) => s.id === 'scn-b')!;
    const works = st.postingScenarios.find((s) => s.id === 'scn-w')!;
    const def = defaultScenario(st, 't1');
    expect(def.accounts['ARO provision']).toBe('prov');
    expect(def.accounts['Retirement cost asset']).toBe('arc');
    expect(buildings.accounts['ARO provision']).not.toBe('prov');
    expect(works.accounts['ARO provision']).not.toBe(buildings.accounts['ARO provision']);
    expect(st.accounts.find((a) => a.id === buildings.accounts['ARO provision'])).toMatchObject({
      code: '21510', name: 'Provision — asset retirement obligations — 11010 Buildings',
    });
    expect(st.accounts.find((a) => a.id === works.accounts['Retirement cost asset'])).toMatchObject({
      code: '16140', name: 'Retirement cost asset — 11040 Works',
    });
    expect(ensureClassScenarioAccounts(st, 't1')).toBe(0);
  });

  it('does not overwrite a completed class mapping', () => {
    const st = settings({
      accounts: [
        acc({ id: 'prov', code: '27500', engineRole: 'ARO provision', cls: 'Liability' }),
        acc({ id: 'custom', code: '27560', name: 'Buildings provision', engineRole: '', cls: 'Liability' }),
      ],
      postingScenarios: [
        {
          id: 't1-scn-default', tenantId: 't1', name: 'Standard ARO', isDefault: true,
          accounts: { 'ARO provision': 'prov' }, completedRoles: [],
        },
        {
          id: 'scn-b', tenantId: 't1', name: '11010 Buildings', isDefault: false,
          accounts: { 'ARO provision': 'custom' }, completedRoles: ['ARO provision'],
        },
      ],
    });
    ensureClassScenarioAccounts(st, 't1');
    expect(st.postingScenarios.find((s) => s.id === 'scn-b')!.accounts['ARO provision']).toBe('custom');
  });
});

describe('posting rule CRUD', () => {
  it('adds a custom event and marks engine-emitted types', () => {
    const st = settings();
    expect(addPostingRule(st, 't1', { eventType: 'impairment', debitRole: 'Operating costs', creditRole: 'ARO provision' })).toBeNull();
    expect(st.postingRules).toHaveLength(1);
    expect(st.postingRules[0].engineEmitted).toBe(false);
    expect(addPostingRule(st, 't1', { eventType: 'accretion', debitRole: 'Accretion expense', creditRole: 'ARO provision' })).toBeNull();
    expect(st.postingRules[1].engineEmitted).toBe(true);
  });

  it('refuses a duplicate event type', () => {
    const st = settings();
    expect(addPostingRule(st, 't1', { eventType: 'accretion', debitRole: 'Accretion expense', creditRole: 'ARO provision' })).toBeNull();
    expect(addPostingRule(st, 't1', { eventType: 'Accretion', debitRole: 'Accretion expense', creditRole: 'ARO provision' })).toMatch(/already exists/);
  });

  it('renames an event and deletes a rule', () => {
    const st = settings();
    addPostingRule(st, 't1', { eventType: 'accretion', debitRole: 'Accretion expense', creditRole: 'ARO provision' });
    const id = st.postingRules[0].id;
    expect(renamePostingRuleEvent(st, id, 'unwind')).toBeNull();
    expect(st.postingRules[0].eventType).toBe('unwind');
    expect(st.postingRules[0].engineEmitted).toBe(false);
    expect(deletePostingRule(st, id)).toBeNull();
    expect(st.postingRules).toEqual([]);
  });

  it('appends missing engine event rules without rewriting existing mappings', () => {
    const st = settings({
      postingRules: [{
        id: 'pr-old', tenantId: 't1', eventType: 'addition',
        debitRole: 'Operating costs', creditRole: 'ARO provision', engineEmitted: true,
      }],
    });
    ensureEnginePostingRules(st, 't1');
    const addition = st.postingRules.find((r) => r.eventType === 'addition')!;
    expect(addition.debitRole).toBe('Operating costs');
    expect(st.postingRules.some((r) => r.eventType === 'expense-recognition')).toBe(true);
    expect(st.postingRules.find((r) => r.eventType === 'revision-unproductive')).toMatchObject({
      debitRole: 'Operating costs', creditRole: 'ARO provision',
    });
    expect(st.postingRules.some((r) => r.eventType === 'downward-excess')).toBe(true);
    expect(st.postingRules.find((r) => r.eventType === 'downward-excess')).toMatchObject({
      debitRole: 'Accretion expense', creditRole: 'ARO provision',
    });
    expect(st.postingRules.some((r) => r.eventType === 'disposal')).toBe(true);
    expect(st.postingRules.some((r) => r.eventType === 'asset-retirement')).toBe(true);
  });

  it('turns a downward-excess rule that still hits the asset into a provision credit to accretion', () => {
    const st = settings({
      postingRules: [{
        id: 'pr-ex', tenantId: 't1', eventType: 'downward-excess',
        debitRole: 'Retirement cost asset', creditRole: 'Accretion expense', engineEmitted: true,
      }],
    });
    ensureEnginePostingRules(st, 't1');
    expect(st.postingRules.find((r) => r.eventType === 'downward-excess')).toMatchObject({
      debitRole: 'Accretion expense', creditRole: 'ARO provision',
    });
  });
});
