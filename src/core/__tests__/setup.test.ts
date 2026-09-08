import { describe, expect, it } from 'vitest';
import { emptyAppState } from '../emptyState';
import { emptySetup, landingScreen, nextSetupStep, setupProgress, unitSetupBlockers, patchSetup } from '../setup';
import { unitLandingScreen } from '../nav';
import { FRAMEWORKS, ENGINE_POSTING_RULES } from '../../seed';
import { defaultAuthority } from '../authority';
import type { Account, PostingRule, TenantSettings } from '../types';

function settings(over: Partial<TenantSettings> = {}): TenantSettings {
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
    ...over,
  };
}

function provisionAccount(tenantId: string): Account {
  return {
    id: 'a1', tenantId, code: '21500', name: 'ARO provision', cls: 'Liability',
    engineRole: 'ARO provision', requiredSegments: [], columns: {},
  };
}

function engineRules(tenantId: string): PostingRule[] {
  return ENGINE_POSTING_RULES.map(([eventType, debitRole, creditRole], i) => ({
    id: `pr-${i}`, tenantId, eventType, debitRole, creditRole, engineEmitted: true,
  }));
}

function withPeople(state: ReturnType<typeof emptyAppState>, tenantId = 't1') {
  state.users.push({
    id: 'u-partner', tenantId, name: 'Pat Partner', email: 'pat@example.com',
    role: 'partner', mfa: 'Enrolled',
  });
  state.authority[tenantId] = defaultAuthority('Reporting entity');
}

describe('tenant company setup', () => {
  it('lands a new tenant on reporting units, the first company-setup step', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings({
      frameworks: FRAMEWORKS,
      postingRules: engineRules('t1'),
    });
    withPeople(state);
    const p = setupProgress(state, 't1');
    expect(p.complete).toBe(false);
    expect(p.current).toBe('unit');
    expect(p.firstIncomplete).toBe('unit');
    expect(landingScreen(state, 't1')).toBe('setup');
  });

  it('treats a unit without a published curve as present for sequencing, not Ready', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings({
      frameworks: FRAMEWORKS,
      postingRules: engineRules('t1'),
    });
    withPeople(state);
    state.units['t1'] = [{ id: 'u1', curveId: '' } as never];
    const p = setupProgress(state, 't1');
    expect(p.ready.unit).toBe(false);
    expect(p.complete).toBe(false);
    expect(p.firstIncomplete).toBe('defaults');
  });

  it('does not treat stock defaults as confirmed until the user says so', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings({ frameworks: FRAMEWORKS, postingRules: engineRules('t1') });
    withPeople(state);
    expect(setupProgress(state, 't1').ready.defaults).toBe(false);
  });

  it('does not mark setup complete just because a reporting unit exists', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings({
      accounts: [provisionAccount('t1')],
      frameworks: FRAMEWORKS,
      postingRules: engineRules('t1'),
      setup: { ...emptySetup(), completedAt: '2026-01-02T00:00:00Z' },
    });
    withPeople(state);
    state.curves['t1'] = [{ id: 'c1', points: [{ term: 1, rate: 0.04 }] } as never];
    state.units['t1'] = [{ id: 'u1', curveId: 'c1' } as never];
    const p = setupProgress(state, 't1');
    expect(p.ready.defaults).toBe(false);
    expect(p.complete).toBe(false);
    expect(landingScreen(state, 't1')).toBe('setup');
  });

  it('walks reporting units first, then people, and the curve last', () => {
    expect(nextSetupStep('unit')).toBe('users');
    expect(nextSetupStep('users')).toBe('authority');
    expect(nextSetupStep('defaults')).toBe('estimates');
    expect(nextSetupStep('estimates')).toBe('curve');
    expect(nextSetupStep('curve')).toBe(null);
  });

  it('resumes at the first incomplete step after a unit exists and defaults are confirmed', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings({
      accounts: [provisionAccount('t1')],
      frameworks: FRAMEWORKS,
      postingRules: engineRules('t1'),
      setup: patchSetup(emptySetup(), { defaultsConfirmedAt: '2026-01-01T00:00:00Z', current: 'accounts' }),
    });
    withPeople(state);
    state.units['t1'] = [{ id: 'u1', curveId: '' } as never];
    const p = setupProgress(state, 't1');
    expect(p.ready.defaults).toBe(true);
    expect(p.current).toBe('curve');
    expect(p.firstIncomplete).toBe('curve');
  });

  it('still blocks measurement when a unit has no assigned published curve', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings({ accounts: [provisionAccount('t1')] });
    state.curves['t1'] = [{ id: 'c1', points: [{ term: 1, rate: 0.04 }] } as never];
    state.units['t1'] = [{ id: 'u1', curveId: '' } as never];
    expect(setupProgress(state, 't1').ready.unit).toBe(false);
    expect(setupProgress(state, 't1').complete).toBe(false);
    expect(unitSetupBlockers(state, 't1', { curveId: '' })).toEqual([
      'No discount curve assigned',
      'Engine posting rules incomplete',
    ]);
  });

  it('does not mark the curve step ready on a draft table', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings({
      accounts: [provisionAccount('t1')],
      frameworks: FRAMEWORKS,
      postingRules: engineRules('t1'),
      setup: patchSetup(emptySetup(), { defaultsConfirmedAt: '2026-01-01T00:00:00Z' }),
    });
    withPeople(state);
    state.units['t1'] = [{ id: 'u1', curveId: 'c-draft' } as never];
    state.curves['t1'] = [{ id: 'c-draft', points: [{ term: 1, rate: 0.04 }], isDraft: true } as never];
    const p = setupProgress(state, 't1');
    expect(p.ready.curve).toBe(false);
    expect(p.ready.unit).toBe(false);
    expect(unitSetupBlockers(state, 't1', { curveId: 'c-draft' })).toEqual(['No discount curve assigned']);
  });

  it('lands a fully set-up tenant on the reporting-units step of company setup', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings({
      accounts: [provisionAccount('t1')],
      frameworks: FRAMEWORKS,
      postingRules: engineRules('t1'),
      setup: patchSetup(emptySetup(), { defaultsConfirmedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z' }),
    });
    withPeople(state);
    state.curves['t1'] = [{ id: 'c1', points: [{ term: 1, rate: 0.04 }] } as never];
    state.units['t1'] = [{ id: 'u1', curveId: 'c1' } as never];
    const p = setupProgress(state, 't1');
    expect(p.complete).toBe(true);
    expect(landingScreen(state, 't1')).toBe('units');
  });
});

describe('opening a reporting unit', () => {
  it('lands on Unit settings until that unit is confirmed, then Prepare', () => {
    const state = emptyAppState();
    const unit = {
      id: 'u1', tenantId: 't1', entity: 'Materials Management', client: 'MM',
      fyEnd: '2027-03-31', currency: 'CAD', sector: 'Mining', partnerUserId: '', frameworkId: 'ifrs',
      jurisdiction: '', calendarType: 'Monthly (12)' as const, latePolicy: 'Prior-period adjustment' as const,
      status: 'Not started', stage: 'Prepare', setupCompletedAt: null as string | null, inflation: 0.025, contingency: 0.1, curveId: 'c1',
      termConvention: 'Round up to whole year (SAP)', materialityUsd: 0, materialityPct: 0,
      extrapolationPolicy: 'flat-last', dayCount: '30/360 US (DAYS360)',
    };
    state.units['t1'] = [unit];
    state.data['u1'] = { obligations: [] } as never;
    expect(unitLandingScreen('Reporting entity', state, unit)).toBe('unit-setup');
    unit.setupCompletedAt = '2026-08-30T00:00:00Z';
    expect(unitLandingScreen('Reporting entity', state, unit)).toBe('scope');
  });

  it('lands on chart when a published curve is assigned but ARO provision is not mapped', () => {
    const state = emptyAppState();
    const unit = {
      id: 'u1', tenantId: 't1', entity: 'Materials Management', client: 'MM',
      fyEnd: '2027-03-31', currency: 'CAD', sector: 'Mining', partnerUserId: '', frameworkId: 'ifrs',
      jurisdiction: '', calendarType: 'Monthly (12)' as const, latePolicy: 'Prior-period adjustment' as const,
      status: 'Not started', stage: 'Prepare', setupCompletedAt: null as string | null, inflation: 0.025, contingency: 0.1, curveId: 'c1',
      termConvention: 'Round up to whole year (SAP)', materialityUsd: 0, materialityPct: 0,
      extrapolationPolicy: 'flat-last', dayCount: '30/360 US (DAYS360)',
    };
    state.units['t1'] = [unit];
    state.data['u1'] = { obligations: [] } as never;
    state.curves['t1'] = [{ id: 'c1', points: [{ term: 1, rate: 0.04 }] } as never];
    state.settings['t1'] = settings();
    expect(unitLandingScreen('Reporting entity', state, unit)).toBe('unit-chart');
  });

  it('lands on posting when the chart is mapped but engine rules are missing', () => {
    const state = emptyAppState();
    const unit = {
      id: 'u1', tenantId: 't1', entity: 'Materials Management', client: 'MM',
      fyEnd: '2027-03-31', currency: 'CAD', sector: 'Mining', partnerUserId: '', frameworkId: 'ifrs',
      jurisdiction: '', calendarType: 'Monthly (12)' as const, latePolicy: 'Prior-period adjustment' as const,
      status: 'Not started', stage: 'Prepare', setupCompletedAt: null as string | null, inflation: 0.025, contingency: 0.1, curveId: 'c1',
      termConvention: 'Round up to whole year (SAP)', materialityUsd: 0, materialityPct: 0,
      extrapolationPolicy: 'flat-last', dayCount: '30/360 US (DAYS360)',
    };
    state.units['t1'] = [unit];
    state.data['u1'] = { obligations: [] } as never;
    state.curves['t1'] = [{ id: 'c1', points: [{ term: 1, rate: 0.04 }] } as never];
    state.settings['t1'] = settings({ accounts: [provisionAccount('t1')] });
    expect(unitLandingScreen('Reporting entity', state, unit)).toBe('unit-posting');
  });

  it('lands on the opening register when chart and posting are ready but the unit is not yet confirmed', () => {
    const state = emptyAppState();
    const unit = {
      id: 'u1', tenantId: 't1', entity: 'Materials Management', client: 'MM',
      fyEnd: '2027-03-31', currency: 'CAD', sector: 'Mining', partnerUserId: '', frameworkId: 'ifrs',
      jurisdiction: '', calendarType: 'Monthly (12)' as const, latePolicy: 'Prior-period adjustment' as const,
      status: 'Not started', stage: 'Prepare', setupCompletedAt: null as string | null, inflation: 0.025, contingency: 0.1, curveId: 'c1',
      termConvention: 'Round up to whole year (SAP)', materialityUsd: 0, materialityPct: 0,
      extrapolationPolicy: 'flat-last', dayCount: '30/360 US (DAYS360)',
    };
    state.units['t1'] = [unit];
    state.data['u1'] = { obligations: [] } as never;
    state.curves['t1'] = [{ id: 'c1', points: [{ term: 1, rate: 0.04 }] } as never];
    state.settings['t1'] = settings({ accounts: [provisionAccount('t1')], postingRules: engineRules('t1') });
    expect(unitLandingScreen('Reporting entity', state, unit)).toBe('unit-opening');
  });

  it('skips the curve gate for an undiscounted PSAS unit and lands on chart', () => {
    const state = emptyAppState();
    const unit = {
      id: 'u1', tenantId: 't1', entity: 'Infrastructure and Environment', client: 'IE',
      fyEnd: '2027-03-31', currency: 'CAD', sector: 'Mining', partnerUserId: '', frameworkId: 'psas',
      jurisdiction: '', calendarType: 'Monthly (12)' as const, latePolicy: 'Prior-period adjustment' as const,
      status: 'Not started', stage: 'Prepare', setupCompletedAt: null as string | null, inflation: 0.02, contingency: 0, curveId: '',
      termConvention: 'Round up to whole year (SAP)', materialityUsd: 0, materialityPct: 0,
      extrapolationPolicy: 'flat-last', dayCount: '30/360 US (DAYS360)', discount: false,
    };
    state.units['t1'] = [unit];
    state.data['u1'] = { obligations: [] } as never;
    expect(unitLandingScreen('Reporting entity', state, unit)).toBe('unit-chart');
  });

  it('lands an auditor engagement on intake, not Unit settings', () => {
    expect(unitLandingScreen('Auditor')).toBe('intake');
  });
});
