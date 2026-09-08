import { describe, expect, it } from 'vitest';
import { deleteAssetClass, importAssetClassesFromListing, parseAssetListing, patchAssetClass, renameAssetClass } from '../assetListing';
import { defaultScenario } from '../posting';
import { emptyAppState } from '../emptyState';
import type { Account, TenantSettings } from '../types';

function acc(id: string, code: string, role: string): Account {
  return { id, tenantId: 't1', code, name: code, cls: 'Liability', engineRole: role, requiredSegments: [], columns: {} };
}

function settings(): TenantSettings {
  const accounts = [
    acc('p', '21500', 'ARO provision'),
    acc('a', '16100', 'Retirement cost asset'),
  ];
  return {
    accounts,
    segments: [],
    postingRules: [],
    postingScenarios: [{
      id: 't1-scn-default', tenantId: 't1', name: 'Standard ARO', isDefault: true,
      accounts: { 'ARO provision': 'p', 'Retirement cost asset': 'a' },
      completedRoles: [],
    }],
    aroAssetClasses: [],
    frameworks: [],
    defaults: {
      inflation: 0.025, contingency: 0.1, dayCount: '30/360 US (DAYS360)',
      termConvention: 'Round up to whole year (SAP)', calendarType: 'Monthly (12)', frameworkId: 'ifrs',
    },
    retentionYears: 7, legalHold: false, sso: false, scim: false,
  };
}

describe('parseAssetListing', () => {
  it('reads distinct classes from a headed SAP-style extract', () => {
    const parsed = parseAssetListing([
      'Asset,Description,Asset class,Asset class name',
      '1000001,Well 12,1000,Wells',
      '1000002,Well 13,1000,Wells',
      '2000001,Plant A,3100,Plant',
    ].join('\n'));
    expect(parsed.classes.map((c) => c.label)).toEqual(['1000 — Wells', '3100 — Plant']);
    expect(parsed.rows).toBe(3);
    expect(parsed.problems).toEqual([]);
  });

  it('reads a simple list of class names', () => {
    const parsed = parseAssetListing('Wells\nPlant\nWells\nPipelines');
    expect(parsed.classes.map((c) => c.label)).toEqual(['Pipelines', 'Plant', 'Wells']);
  });

  it('reads ANLKL without a name column', () => {
    const parsed = parseAssetListing('ANLKL\n1000\n1000\n3100');
    expect(parsed.classes.map((c) => c.label)).toEqual(['1000', '3100']);
  });

  it('reads a two-column code and name list', () => {
    const parsed = parseAssetListing('1000,Wells\n3100,Plant');
    expect(parsed.classes.map((c) => c.label)).toEqual(['1000 — Wells', '3100 — Plant']);
  });

  it('does not treat a full asset listing as a class list', () => {
    const parsed = parseAssetListing('1000001,Well 12,1000,Wells\n2000001,Plant A,3100,Plant');
    expect(parsed.classes).toEqual([]);
    expect(parsed.problems[0]).toMatch(/asset classes only/i);
  });
});

describe('importAssetClassesFromListing', () => {
  it('creates a posting scenario per new class with its own GLs', () => {
    const st = settings();
    const parsed = parseAssetListing('Asset class,Asset class name\n1000,Wells\n3100,Plant');
    const result = importAssetClassesFromListing(st, 't1', parsed);
    expect(result.added).toBe(2);
    expect(st.aroAssetClasses.map((c) => `${c.code}:${c.name}`).sort()).toEqual(['1000:Wells', '3100:Plant']);
    const wells = st.postingScenarios.find((s) => s.name === '1000 — Wells')!;
    const plant = st.postingScenarios.find((s) => s.name === '3100 — Plant')!;
    const def = defaultScenario(st, 't1');
    expect(wells.isDefault).toBe(false);
    expect(wells.accounts['ARO provision']).not.toBe(def.accounts['ARO provision']);
    expect(plant.accounts['ARO provision']).not.toBe(wells.accounts['ARO provision']);
    expect(st.accounts.find((a) => a.id === wells.accounts['ARO provision'])?.name).toMatch(/1000 — Wells/);
    expect(st.aroAssetClasses.find((c) => c.code === '1000' && c.name === 'Wells')?.scenarioId).toBe(wells.id);
    expect(def.name).toBe('Standard ARO');
    expect(def.accounts['ARO provision']).toBe('p');
  });

  it('splits a class that still shares the default scenario onto its own copy', () => {
    const st = settings();
    st.aroAssetClasses.push({ id: 'c1', tenantId: 't1', name: 'Wells', scenarioId: 't1-scn-default' });
    const result = importAssetClassesFromListing(st, 't1', parseAssetListing('Wells\nPlant'));
    expect(result.split).toBe(1);
    expect(result.added).toBe(1);
    const wells = st.aroAssetClasses.find((c) => c.name === 'Wells')!;
    expect(wells.scenarioId).not.toBe('t1-scn-default');
    expect(st.postingScenarios.find((s) => s.id === wells.scenarioId)?.name).toBe('Wells');
  });

  it('keeps a class that already has a dedicated scenario', () => {
    const st = settings();
    st.postingScenarios.push({
      id: 'scn-wells', tenantId: 't1', name: 'Wells', isDefault: false, accounts: { 'ARO provision': 'p' }, completedRoles: [],
    });
    st.aroAssetClasses.push({ id: 'c1', tenantId: 't1', name: 'Wells', scenarioId: 'scn-wells' });
    const result = importAssetClassesFromListing(st, 't1', parseAssetListing('Wells'));
    expect(result.kept).toBe(1);
    expect(result.added).toBe(0);
    expect(result.split).toBe(0);
    expect(st.postingScenarios.filter((s) => s.name === 'Wells')).toHaveLength(1);
  });

  it('matches an existing class by name when the listing also has a code', () => {
    const st = settings();
    st.aroAssetClasses.push({ id: 'c1', tenantId: 't1', name: 'Wells', scenarioId: 't1-scn-default' });
    const result = importAssetClassesFromListing(
      st, 't1', parseAssetListing('Asset class,Asset class name\n1000,Wells\n3100,Plant'),
    );
    expect(result.split).toBe(1);
    expect(result.added).toBe(1);
    expect(st.aroAssetClasses.find((c) => c.name === 'Wells')?.scenarioId).not.toBe('t1-scn-default');
    expect(st.aroAssetClasses.find((c) => c.name === 'Wells')?.code).toBe('1000');
    expect(st.aroAssetClasses.map((c) => c.name).sort()).toEqual(['Plant', 'Wells']);
  });
});

describe('asset class CRUD', () => {
  it('renames a dedicated class, its scenario, and matching obligations', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    importAssetClassesFromListing(state.settings['t1'], 't1', parseAssetListing('Wells'));
    const cls = state.settings['t1'].aroAssetClasses[0];
    state.units['t1'] = [{ id: 'u1', tenantId: 't1' } as never];
    state.data['u1'] = { obligations: [{ id: 'o1', aroAssetClass: 'Wells' }, { id: 'o2', aroAssetClass: 'Plant' }] } as never;
    expect(renameAssetClass(state, 't1', cls.id, 'Oil wells')).toBeNull();
    expect(state.settings['t1'].aroAssetClasses[0].name).toBe('Oil wells');
    expect(state.settings['t1'].postingScenarios.find((s) => s.id === cls.scenarioId)?.name).toBe('Oil wells');
    expect(state.data['u1'].obligations[0].aroAssetClass).toBe('Oil wells');
    expect(state.data['u1'].obligations[1].aroAssetClass).toBe('Plant');
  });

  it('refuses a duplicate class name', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    importAssetClassesFromListing(state.settings['t1'], 't1', parseAssetListing('Wells\nPlant'));
    const wells = state.settings['t1'].aroAssetClasses.find((c) => c.name === 'Wells')!;
    expect(renameAssetClass(state, 't1', wells.id, 'plant')).toMatch(/already an asset class/);
  });

  it('refuses a duplicate class code', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    importAssetClassesFromListing(state.settings['t1'], 't1', parseAssetListing('Asset class,Asset class name\n1000,Wells\n3100,Plant'));
    const plant = state.settings['t1'].aroAssetClasses.find((c) => c.name === 'Plant')!;
    expect(patchAssetClass(state, 't1', plant.id, { code: '1000' })).toMatch(/already used/);
  });

  it('deletes a class and its dedicated scenario, keeping Standard ARO', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    importAssetClassesFromListing(state.settings['t1'], 't1', parseAssetListing('Wells'));
    const cls = state.settings['t1'].aroAssetClasses[0];
    const scnId = cls.scenarioId;
    expect(deleteAssetClass(state, 't1', cls.id)).toBeNull();
    expect(state.settings['t1'].aroAssetClasses).toEqual([]);
    expect(state.settings['t1'].postingScenarios.find((s) => s.id === scnId)).toBeUndefined();
    expect(defaultScenario(state.settings['t1'], 't1').name).toBe('Standard ARO');
  });
});
