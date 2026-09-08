import { describe, expect, it } from 'vitest';
import {
  addReportingUnit, assignMissingCurves, completeUnitSetup, curveDeleteBlocker, deleteCurve, deleteReportingUnit, pickCurveForUnit, publishedCurves,
  suggestedClosingCurve, unitNeedsDiscountCurve, unitsMissingPublishedCurve, unitsUsingCurve,
  updateReportingUnit, unitIdentityLocked, unitSetupComplete,
} from '../createUnit';
import { emptyAppState } from '../emptyState';
import { ENGINE_POSTING_RULES } from '../../seed';
import type { Account, PostingRule, TenantSettings } from '../types';
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

function provisionAccount(): Account {
  return {
    id: 'a1', tenantId: 't1', code: '21500', name: 'ARO provision', cls: 'Liability',
    engineRole: 'ARO provision', requiredSegments: [], columns: {},
  };
}

function engineRules(): PostingRule[] {
  return ENGINE_POSTING_RULES.map(([eventType, debitRole, creditRole], i) => ({
    id: `pr-${i}`, tenantId: 't1', eventType, debitRole, creditRole, engineEmitted: true,
  }));
}

function chartReady(): TenantSettings {
  return settings({ accounts: [provisionAccount()], postingRules: engineRules() });
}

function curve(over: Partial<Curve> & Pick<Curve, 'id'>): Curve {
  return {
    name: over.name ?? over.id,
    currency: over.currency ?? 'CAD',
    source: 'test',
    basis: 'Zero-coupon, annual compounding',
    interpolation: 'linear',
    extrapolation: 'flat-last',
    asAt: over.asAt ?? '2025-03-31',
    isDraft: over.isDraft,
    points: over.points ?? [{ term: 1, rate: 0.03 }],
    ...over,
  };
}

describe('discount curve assignment', () => {
  it('ignores drafts and empty shells when picking a table for a new unit', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.curves['t1'] = [
      curve({ id: 'draft', isDraft: true, currency: 'CAD' }),
      curve({ id: 'empty', points: [], currency: 'CAD' }),
      curve({ id: 'cad', currency: 'CAD' }),
      curve({ id: 'gbp', currency: 'GBP' }),
    ];
    expect(publishedCurves(state, 't1').map((c) => c.id)).toEqual(['cad', 'gbp']);
    expect(pickCurveForUnit(state, 't1', 'CAD')).toBe('cad');
    expect(pickCurveForUnit(state, 't1', 'GBP')).toBe('gbp');
    expect(pickCurveForUnit(state, 't1', 'EUR')).toBe('cad');
  });

  it('creates a unit with no curveId when the library has nothing published', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.curves['t1'] = [curve({ id: 'draft', isDraft: true })];
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Materials Management', fyEnd: '2027-03-31', currency: 'CAD',
    });
    expect(state.units['t1'].find((u) => u.id === id)!.curveId).toBe('');
  });

  it('assigns a published matching-currency table to a unit created after the library exists', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.curves['t1'] = [curve({ id: 'cad', currency: 'CAD' })];
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Materials Management', fyEnd: '2027-03-31', currency: 'CAD',
    });
    expect(state.units['t1'].find((u) => u.id === id)!.curveId).toBe('cad');
  });

  it('heals an empty or draft pointer without rewriting inflation', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.curves['t1'] = [curve({ id: 'cad', currency: 'CAD', asAt: '2025-03-31' })];
    state.units['t1'] = [{
      id: 'u1', tenantId: 't1', entity: 'Materials Management', client: 'Materials Management',
      fyEnd: '2027-03-31', currency: 'CAD', sector: 'Mining', partnerUserId: '', frameworkId: 'ifrs',
      jurisdiction: '', calendarType: 'Monthly (12)', latePolicy: 'Prior-period adjustment',
      status: 'Not started', stage: 'Prepare', inflation: 0.04, contingency: 0.1, curveId: '',
      termConvention: 'Round up to whole year (SAP)', materialityUsd: 0, materialityPct: 0,
      extrapolationPolicy: 'flat-last', dayCount: '30/360 US (DAYS360)',
    }];
    state.data['u1'] = { obligations: [{ id: 'o1' }] } as never;
    expect(unitsMissingPublishedCurve(state, 't1').map((u) => u.id)).toEqual(['u1']);
    expect(assignMissingCurves(state, 't1')).toEqual(['Materials Management']);
    expect(state.units['t1'][0].curveId).toBe('cad');
    expect(state.units['t1'][0].inflation).toBe(0.04);
    expect(assignMissingCurves(state, 't1')).toEqual([]);
  });

  it('does not treat an undiscounted PSAS unit as missing a curve', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.curves['t1'] = [curve({ id: 'cad', currency: 'CAD' })];
    state.units['t1'] = [{
      id: 'u1', tenantId: 't1', entity: 'Infrastructure and Environment', client: 'IE',
      fyEnd: '2027-03-31', currency: 'CAD', sector: 'Mining', partnerUserId: '', frameworkId: 'psas',
      jurisdiction: '', calendarType: 'Monthly (12)', latePolicy: 'Prior-period adjustment',
      status: 'Not started', stage: 'Prepare', inflation: 0.02, contingency: 0, curveId: '',
      termConvention: 'Round up to whole year (SAP)', materialityUsd: 0, materialityPct: 0,
      extrapolationPolicy: 'flat-last', dayCount: '30/360 US (DAYS360)', discount: false,
    }];
    expect(unitNeedsDiscountCurve(state.units['t1'][0])).toBe(false);
    expect(unitsMissingPublishedCurve(state, 't1')).toEqual([]);
    expect(assignMissingCurves(state, 't1')).toEqual([]);
  });

  it('does not copy company defaults onto a unit that already has obligations', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].defaults.inflation = 0.01;
    state.curves['t1'] = [curve({ id: 'cad', currency: 'CAD' })];
    state.units['t1'] = [{
      id: 'u1', tenantId: 't1', entity: 'Materials Management', client: 'MM',
      fyEnd: '2027-03-31', currency: 'CAD', sector: 'Mining', partnerUserId: '', frameworkId: 'ifrs',
      jurisdiction: '', calendarType: 'Monthly (12)', latePolicy: 'Prior-period adjustment',
      status: 'Not started', stage: 'Prepare', inflation: 0.04, contingency: 0.2, curveId: '',
      termConvention: 'Round up to whole year (SAP)', materialityUsd: 0, materialityPct: 0,
      extrapolationPolicy: 'flat-last', dayCount: '30/360 US (DAYS360)',
    }];
    state.data['u1'] = { obligations: [{ id: 'o1' }] } as never;
    expect(state.units['t1'][0].inflation).toBe(0.04);
    expect(state.settings['t1'].defaults.inflation).toBe(0.01);
  });

  it('suggests the published table whose as-at matches this year end, not the table already in force', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.curves['t1'] = [
      curve({ id: 'cad-2026', currency: 'CAD', asAt: '2026-03-31', name: 'Zero Coupon Bond Yield Curve' }),
      curve({ id: 'cad-2027', currency: 'CAD', asAt: '2027-03-31', name: 'Zero Coupon Bond Yield Curve' }),
    ];
    const unit = { currency: 'CAD', fyEnd: '2027-03-31', curveId: 'cad-2026' };
    expect(suggestedClosingCurve(state, 't1', unit)?.id).toBe('cad-2027');
    expect(suggestedClosingCurve(state, 't1', { ...unit, curveId: 'cad-2027' })?.id).toBe('cad-2027');
    expect(suggestedClosingCurve(state, 't1', { currency: 'GBP', fyEnd: '2027-03-31', curveId: 'cad-2026' })).toBeUndefined();
  });

  it('deletes a library table that no reporting unit points at, and refuses one that is in force or prior', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.curves['t1'] = [
      curve({ id: 'cad-2026', currency: 'CAD', asAt: '2026-03-31' }),
      curve({ id: 'cad-2027', currency: 'CAD', asAt: '2027-03-31' }),
    ];
    state.units['t1'] = [{
      id: 'u1', tenantId: 't1', entity: 'Materials Management', client: 'MM',
      fyEnd: '2027-03-31', currency: 'CAD', sector: 'Mining', partnerUserId: '', frameworkId: 'ifrs',
      jurisdiction: '', calendarType: 'Monthly (12)', latePolicy: 'Prior-period adjustment',
      status: 'Not started', stage: 'Prepare', inflation: 0.04, contingency: 0.1, curveId: 'cad-2026',
      priorCurveId: undefined, termConvention: 'Round up to whole year (SAP)', materialityUsd: 0, materialityPct: 0,
      extrapolationPolicy: 'flat-last', dayCount: '30/360 US (DAYS360)',
    }];
    expect(unitsUsingCurve(state, 't1', 'cad-2026')).toEqual([{ entity: 'Materials Management', how: 'in force' }]);
    expect(curveDeleteBlocker(state, 't1', 'cad-2026')).toMatch(/in force on Materials Management/);
    expect(deleteCurve(state, 't1', 'cad-2026')).toBe(false);
    expect(state.curves['t1']).toHaveLength(2);
    expect(curveDeleteBlocker(state, 't1', 'cad-2027')).toBeNull();
    expect(deleteCurve(state, 't1', 'cad-2027')).toBe(true);
    expect(state.curves['t1'].map((c) => c.id)).toEqual(['cad-2026']);
    state.units['t1'][0].priorCurveId = 'cad-2026';
    state.units['t1'][0].curveId = 'other';
    expect(curveDeleteBlocker(state, 't1', 'cad-2026')).toMatch(/prior on Materials Management/);
    expect(deleteCurve(state, 't1', 'cad-2026')).toBe(false);
  });
});

describe('updateReportingUnit', () => {
  function ready() {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.settings['t1'].frameworks = [
      { id: 'ifrs', name: 'IFRS (IAS 37)', axes: {}, engineEffects: [], wired: true },
      { id: 'usgaap', name: 'US GAAP (ASC 410)', axes: {}, engineEffects: [], wired: true },
    ];
    state.curves['t1'] = [
      curve({ id: 'cad', currency: 'CAD', asAt: '2026-03-31', name: 'CAD zeros' }),
      curve({ id: 'gbp', currency: 'GBP', asAt: '2026-03-31', name: 'GBP zeros' }),
    ];
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Materials Management', fyEnd: '2027-03-31', currency: 'CAD',
    });
    return { state, id };
  }

  it('rewrites identity while the unit has not started', () => {
    const { state, id } = ready();
    expect(updateReportingUnit(state, 't1', id, { entity: 'Axiom Materials' })).toBeNull();
    const u = state.units['t1'].find((x) => x.id === id)!;
    expect(u.entity).toBe('Axiom Materials');
    expect(u.client).toBe('Axiom Materials');
    expect(updateReportingUnit(state, 't1', id, { frameworkId: 'usgaap' })).toBeNull();
    expect(u.frameworkId).toBe('usgaap');
    expect(updateReportingUnit(state, 't1', id, { curveId: 'cad' })).toBeNull();
    expect(u.curveId).toBe('cad');
  });

  it('rebuilds the fiscal calendar when the year end changes', () => {
    const { state, id } = ready();
    expect(state.data[id].periods.some((p) => p.id.includes('FY2027'))).toBe(true);
    expect(updateReportingUnit(state, 't1', id, { fyEnd: '2028-06-30' })).toBeNull();
    expect(state.units['t1'][0].fyEnd).toBe('2028-06-30');
    const after = state.data[id].periods;
    expect(after).toHaveLength(12);
    expect(after.every((p) => p.id.includes('FY2028'))).toBe(true);
    expect(after.find((p) => p.no === 12)?.ends).toBe('2028-06-30');
  });

  it('reassigns the curve when currency no longer matches the table in force', () => {
    const { state, id } = ready();
    expect(state.units['t1'][0].curveId).toBe('cad');
    expect(updateReportingUnit(state, 't1', id, { currency: 'GBP' })).toBeNull();
    expect(state.units['t1'][0].currency).toBe('GBP');
    expect(state.units['t1'][0].curveId).toBe('gbp');
  });

  it('refuses an empty name, a bad date, and a draft curve', () => {
    const { state, id } = ready();
    state.curves['t1'].push(curve({ id: 'draft', isDraft: true, currency: 'CAD' }));
    const u = state.units['t1'][0];
    expect(updateReportingUnit(state, 't1', id, { entity: '  ' })).toMatch(/empty/);
    expect(u.entity).toBe('Materials Management');
    expect(updateReportingUnit(state, 't1', id, { fyEnd: 'not-a-date' })).toMatch(/not a date/);
    expect(u.fyEnd).toBe('2027-03-31');
    expect(updateReportingUnit(state, 't1', id, { curveId: 'draft' })).toMatch(/published/);
    expect(u.curveId).toBe('cad');
  });

  it('locks identity once the unit has started or holds obligations', () => {
    const { state, id } = ready();
    state.units['t1'][0].status = 'In progress';
    expect(unitIdentityLocked(state, state.units['t1'][0])).toBe(true);
    expect(updateReportingUnit(state, 't1', id, { entity: 'Nope' })).toMatch(/has started/);
    expect(state.units['t1'][0].entity).toBe('Materials Management');
    state.units['t1'][0].status = 'Not started';
    state.data[id].obligations = [{ id: 'o1' }] as never;
    expect(unitIdentityLocked(state, state.units['t1'][0])).toBe(true);
    expect(updateReportingUnit(state, 't1', id, { fyEnd: '2028-03-31' })).toMatch(/has started/);
    expect(state.units['t1'][0].fyEnd).toBe('2027-03-31');
  });
});

describe('deleteReportingUnit', () => {
  function ready() {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.curves['t1'] = [curve({ id: 'cad', currency: 'CAD' })];
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Materials Management', fyEnd: '2027-03-31', currency: 'CAD',
    });
    return { state, id };
  }

  it('removes a unit that has not started and drops its calendar', () => {
    const { state, id } = ready();
    expect(state.data[id]?.periods.length).toBe(12);
    expect(deleteReportingUnit(state, 't1', id)).toBeNull();
    expect(state.units['t1']).toEqual([]);
    expect(state.data[id]).toBeUndefined();
  });

  it('refuses once the unit has started or holds obligations', () => {
    const { state, id } = ready();
    state.units['t1'][0].status = 'In progress';
    expect(deleteReportingUnit(state, 't1', id)).toMatch(/has started/);
    expect(state.units['t1']).toHaveLength(1);
    state.units['t1'][0].status = 'Not started';
    state.data[id].obligations = [{ id: 'o1' }] as never;
    expect(deleteReportingUnit(state, 't1', id)).toMatch(/has started/);
    expect(state.units['t1']).toHaveLength(1);
    expect(state.data[id]).toBeDefined();
  });

  it('refuses a unit that is not on this tenant', () => {
    const { state } = ready();
    expect(deleteReportingUnit(state, 't1', 'missing')).toMatch(/not on this tenant/);
  });
});

describe('unit settings', () => {
  it('lets two unstarted units keep different assumptions', () => {
    const state = emptyAppState();
    state.settings['t1'] = chartReady();
    state.curves['t1'] = [curve({ id: 'cad', currency: 'CAD' })];
    const a = addReportingUnit(state, {
      tenantId: 't1', entity: 'Materials Management', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const b = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    expect(updateReportingUnit(state, 't1', a, { inflation: 0.03, frameworkId: 'ifrs' })).toBeNull();
    expect(updateReportingUnit(state, 't1', b, { inflation: 0.05 })).toBeNull();
    expect(state.units['t1'].find((u) => u.id === a)!.inflation).toBe(0.03);
    expect(state.units['t1'].find((u) => u.id === b)!.inflation).toBe(0.05);
    expect(unitSetupComplete(state, state.units['t1'].find((u) => u.id === a)!)).toBe(false);
    expect(completeUnitSetup(state, 't1', a)).toBeNull();
    expect(unitSetupComplete(state, state.units['t1'].find((u) => u.id === a)!)).toBe(true);
    expect(unitSetupComplete(state, state.units['t1'].find((u) => u.id === b)!)).toBe(false);
  });

  it('still allows assumption edits after the unit has started', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.curves['t1'] = [curve({ id: 'cad', currency: 'CAD' })];
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Materials Management', fyEnd: '2027-03-31', currency: 'CAD',
    });
    state.units['t1'][0].status = 'In progress';
    expect(updateReportingUnit(state, 't1', id, { inflation: 0.04 })).toBeNull();
    expect(state.units['t1'][0].inflation).toBe(0.04);
    expect(updateReportingUnit(state, 't1', id, { entity: 'Nope' })).toMatch(/has started/);
  });

  it('stores PSAS discounting on the reporting unit', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    expect(updateReportingUnit(state, 't1', id, { frameworkId: 'psas', discount: false })).toBeNull();
    expect(state.units['t1'][0].frameworkId).toBe('psas');
    expect(state.units['t1'][0].discount).toBe(false);
    expect(unitNeedsDiscountCurve(state.units['t1'][0])).toBe(false);
  });

  it('refuses to confirm unit settings without a published curve', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Materials Management', fyEnd: '2027-03-31', currency: 'CAD',
    });
    expect(completeUnitSetup(state, 't1', id)).toMatch(/discount curve/);
    expect(state.units['t1'][0].setupCompletedAt).toBeNull();
  });

  it('confirms an undiscounted PSAS unit without a published curve', () => {
    const state = emptyAppState();
    state.settings['t1'] = chartReady();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    state.units['t1'][0].frameworkId = 'psas';
    state.units['t1'][0].discount = false;
    state.units['t1'][0].curveId = '';
    expect(completeUnitSetup(state, 't1', id)).toBeNull();
    expect(state.units['t1'][0].setupCompletedAt).not.toBeNull();
  });

  it('refuses to confirm unit settings without ARO provision mapped', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings({ postingRules: engineRules() });
    state.curves['t1'] = [curve({ id: 'cad', currency: 'CAD' })];
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Materials Management', fyEnd: '2027-03-31', currency: 'CAD',
    });
    expect(completeUnitSetup(state, 't1', id)).toMatch(/ARO provision/);
    expect(state.units['t1'][0].setupCompletedAt).toBeNull();
  });

  it('refuses to confirm unit settings without engine posting rules', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings({ accounts: [provisionAccount()] });
    state.curves['t1'] = [curve({ id: 'cad', currency: 'CAD' })];
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Materials Management', fyEnd: '2027-03-31', currency: 'CAD',
    });
    expect(completeUnitSetup(state, 't1', id)).toMatch(/posting rules/);
    expect(state.units['t1'][0].setupCompletedAt).toBeNull();
  });
});
