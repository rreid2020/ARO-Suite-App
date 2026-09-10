import { describe, expect, it } from 'vitest';
import { emptyAppState } from '../emptyState';
import { addReportingUnit } from '../createUnit';
import { loadOpeningRegister, lockOpeningBlocked, parseOpeningRegister } from '../openingLoad';
import {
  loadCurrentTcaListing, loadTcaListing, lockOpeningBalances, obligationsForAsset, openingTcaListing, parseTcaListing, setTcaScope, syncTcaScopeFromObligations, tcaAcquisitionDateOf, tcaFieldsFromPayload, tcaForObligation, tcaPayloadOf, tcaScopingGaps,
  tcaTemplateDataRows, tcaTemplateHeaders, tcaTemplateNotes,
} from '../tcaListing';
import type { TenantSettings } from '../types';

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

function unit() {
  const state = emptyAppState();
  state.settings['t1'] = settings();
  const id = addReportingUnit(state, {
    tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
  });
  return { state, id };
}

describe('parseTcaListing', () => {
  it('reads a headed spreadsheet of assets', () => {
    const parsed = parseTcaListing([
      'Asset number,Description,Asset class,Acquisition date,Site',
      'AS-10001,Well 14-23 pad,Wells,2008-06-15,North',
      'AS-10002,Plant west,Plant,1999-03-31,South',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].assetNumber).toBe('AS-10001');
    expect(parsed.rows[0].description).toBe('Well 14-23 pad');
    expect(parsed.rows[1].assetClass).toBe('Plant');
  });

  it('reads TCA asset number and TCA asset class headings', () => {
    const parsed = parseTcaListing([
      'TCA asset number,Description,TCA asset class,Acquisition date,Site',
      'AS-10001,Well 14-23 pad,Buildings,2008-06-15,North',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows[0].assetNumber).toBe('AS-10001');
    expect(parsed.rows[0].assetClass).toBe('Buildings');
  });

  it('reads acquisition cost and accumulated amortization', () => {
    const parsed = parseTcaListing([
      'TCA asset number,Description,Acquisition cost,Accumulated amortization',
      'AS-10001,Well 14-23 pad,2100000,800000',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.hasCostColumn).toBe(true);
    expect(parsed.hasAccumColumn).toBe(true);
    expect(parsed.rows[0].acquisitionCost).toBe(2100000);
    expect(parsed.rows[0].accumAmort).toBe(800000);
  });

  it('refuses a duplicate Asset number and a missing Asset number column', () => {
    const dup = parseTcaListing([
      'Asset number,Description',
      'AS-1,Well',
      'AS-1,Plant',
    ].join('\n'));
    expect(dup.rows).toEqual([]);
    expect(dup.problems.some((p) => /already used/i.test(p))).toBe(true);

    const missing = parseTcaListing([
      'Description,Site',
      'Well,North',
    ].join('\n'));
    expect(missing.rows).toEqual([]);
    expect(missing.problems.some((p) => /Asset number/i.test(p))).toBe(true);
  });

  it('reads an optional Scope column', () => {
    const parsed = parseTcaListing([
      'Asset number,Description,Scope,Reason if out',
      'AS-1,Well,In scope,',
      'AS-2,Retired pad,Out of scope,Asset already retired',
      'AS-3,Review,Undecided,',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.hasScopeColumn).toBe(true);
    expect(parsed.rows.map((r) => r.scope)).toEqual(['In scope', 'Scoped out', 'Undecided']);
    expect(parsed.rows[1].scopeReason).toBe('Asset already retired');
  });

  it('reads an optional Asset status column', () => {
    const parsed = parseTcaListing([
      'TCA asset number,Description,Asset status',
      'AS-1,Well pad,Active',
      'AS-2,Idle tank,Unproductive',
      'AS-3,Sold plant,Disposed',
      'AS-4,Blank status,',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.hasStatusColumn).toBe(true);
    expect(parsed.rows.map((r) => r.assetStatus)).toEqual(['Active', 'Unproductive', 'Disposed', null]);
  });

  it('treats Productive as Active for older extracts', () => {
    const parsed = parseTcaListing([
      'TCA asset number,Description,Asset status',
      'AS-1,Well pad,Productive',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows[0].assetStatus).toBe('Active');
  });

  it('refuses an unrecognised Asset status', () => {
    const parsed = parseTcaListing([
      'TCA asset number,Description,Asset status',
      'AS-1,Well pad,Held for sale',
    ].join('\n'));
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.some((p) => /Active, Unproductive or Disposed/i.test(p))).toBe(true);
  });

  it('reads optional Total UL and Expired UL', () => {
    const parsed = parseTcaListing([
      'TCA asset number,Description,Total UL,Expired UL',
      'AS-1,Well pad,25,10',
      'AS-2,Spare tank,20,',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.hasTotalUlColumn).toBe(true);
    expect(parsed.hasExpiredUlColumn).toBe(true);
    expect(parsed.rows[0].totalUl).toBe(25);
    expect(parsed.rows[0].expiredUl).toBe(10);
    expect(parsed.rows[1].totalUl).toBe(20);
    expect(parsed.rows[1].expiredUl).toBeNull();
  });

  it('reads Total UL as years and leftover months and ignores Remaining UL on load', () => {
    const parsed = parseTcaListing([
      'TCA asset number,Description,Total UL,Expired UL,Remaining UL',
      'AS-1,Well pad,17 yr · 9 mo,5 yr · 3 mo,12 yr · 6 mo',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.extraNames).toEqual([]);
    expect(parsed.rows[0].totalUl).toBe(17.75);
    expect(parsed.rows[0].expiredUl).toBe(5.25);
  });

  it('refuses Expired UL greater than Total UL', () => {
    const parsed = parseTcaListing([
      'TCA asset number,Total UL,Expired UL',
      'AS-1,15,20',
    ].join('\n'));
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.some((p) => /cannot exceed Total UL/i.test(p))).toBe(true);
  });
});

describe('loadTcaListing and scoping', () => {
  it('marks assets with a related obligation in scope and leaves the rest Undecided', () => {
    const { state, id } = unit();
    const obl = [
      'Obligation Number,Opening provision,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      'ARO-1,100,40,10,25,10,AS-1',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(obl), { filename: 'open.csv', text: obl });
    const tca = [
      'Asset number,Description',
      'AS-1,Well pad',
      'AS-2,Spare tank',
    ].join('\n');
    const result = loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
    expect(result).toEqual({ added: 2, updated: 0, dropped: 0, problems: [] });
    const byNo = Object.fromEntries(state.data[id].tcaAssets.map((a) => [a.assetNumber, a]));
    expect(byNo['AS-1'].scope).toBe('In scope');
    expect(byNo['AS-2'].scope).toBe('Undecided');
    expect(obligationsForAsset(state.data[id].obligations, 'AS-1')).toHaveLength(1);
  });

  it('loads Asset status and defaults blank or missing to Active', () => {
    const { state, id } = unit();
    const tca = [
      'TCA asset number,Description,Asset status',
      'AS-1,Well pad,Unproductive',
      'AS-2,Spare tank,',
      'AS-3,Old plant,Disposed',
    ].join('\n');
    const result = loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
    expect(result).toEqual({ added: 3, updated: 0, dropped: 0, problems: [] });
    const byNo = Object.fromEntries(state.data[id].tcaAssets.map((a) => [a.assetNumber, a]));
    expect(byNo['AS-1'].assetStatus).toBe('Unproductive');
    expect(byNo['AS-2'].assetStatus).toBe('Active');
    expect(byNo['AS-3'].assetStatus).toBe('Disposed');
  });

  it('stores Total UL and Expired UL from the listing', () => {
    const { state, id } = unit();
    const tca = [
      'TCA asset number,Description,Total UL,Expired UL',
      'AS-1,Well pad,25,10',
    ].join('\n');
    loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
    expect(state.data[id].tcaAssets[0].totalUl).toBe(25);
    expect(state.data[id].tcaAssets[0].expiredUl).toBe(10);
  });

  it('will not let a linked asset be scoped out', () => {
    const { state, id } = unit();
    const obl = [
      'Obligation Number,Opening provision,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      'ARO-1,100,40,10,25,10,AS-1',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(obl), { filename: 'open.csv', text: obl });
    const tca = ['Asset number,Description', 'AS-1,Well pad'].join('\n');
    loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
    const asset = state.data[id].tcaAssets[0];
    const next = setTcaScope(asset, 'Scoped out', 'No legal or constructive obligation', state.data[id].obligations);
    expect(typeof next).toBe('string');
    expect(String(next)).toMatch(/in scope/i);
  });

  it('records Out of scope with a reason on an unlinked asset', () => {
    const { state, id } = unit();
    const tca = ['Asset number,Description', 'AS-2,Spare tank'].join('\n');
    loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
    const asset = state.data[id].tcaAssets[0];
    const next = setTcaScope(asset, 'Scoped out', '', []);
    expect(next).toMatch(/Record why/);
    const marked = setTcaScope(asset, 'Scoped out', 'Asset already retired', []);
    expect(typeof marked).not.toBe('string');
    if (typeof marked === 'string') return;
    expect(marked.scope).toBe('Scoped out');
    expect(marked.scopeReason).toBe('Asset already retired');
  });

  it('blocks lock while an obligation names an asset that is not on the listing', () => {
    const { state, id } = unit();
    const obl = [
      'Obligation Number,Opening provision,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      'ARO-1,100,40,10,25,10,AS-MISSING',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(obl), { filename: 'open.csv', text: obl });
    const tca = ['Asset number,Description', 'AS-OTHER,Other'].join('\n');
    loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
    state.data[id].openingGlProvision = 100;
    state.data[id].openingGlArc = 40;
    expect(lockOpeningBlocked(state.data[id])).toMatch(/not on the master TCA listing/i);
    const gaps = tcaScopingGaps(state.data[id].tcaAssets, state.data[id].obligations);
    expect(gaps.orphanObligations.map((o) => o.ref)).toEqual(['ARO-1']);
  });

  it('refuses an obligation extract when the master listing is already loaded and the asset is missing', () => {
    const { state, id } = unit();
    const tca = ['Asset number,Description', 'AS-1,Well pad'].join('\n');
    loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
    const obl = [
      'Obligation Number,Opening provision,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      'ARO-1,100,40,10,25,10,AS-MISSING',
    ].join('\n');
    const result = loadOpeningRegister(state, 't1', id, parseOpeningRegister(obl), { filename: 'open.csv', text: obl });
    expect(typeof result).toBe('string');
    expect(String(result)).toMatch(/not on the master TCA listing/i);
    expect(state.data[id].obligations).toHaveLength(0);
  });

  it('sync forces linked assets in scope even if the file said otherwise', () => {
    const assets = [
      { id: 'a1', assetNumber: 'AS-1', description: 'Well', assetClass: '', acquisitionDate: '', site: '', acquisitionCost: null, accumAmort: null, totalUl: null, expiredUl: null, assetStatus: 'Active' as const, scope: 'Scoped out' as const, scopeReason: 'Held for sale', columns: {} },
      { id: 'a2', assetNumber: 'AS-2', description: 'Tank', assetClass: '', acquisitionDate: '', site: '', acquisitionCost: null, accumAmort: null, totalUl: null, expiredUl: null, assetStatus: 'Active' as const, scope: 'Undecided' as const, scopeReason: '', columns: {} },
    ];
    const next = syncTcaScopeFromObligations(assets, [{ id: 'o1', ref: 'ARO-1', assetId: 'AS-1' } as never]);
    expect(next[0].scope).toBe('In scope');
    expect(next[0].scopeReason).toBe('');
    expect(next[1].scope).toBe('Undecided');
  });

  it('joins an obligation to its TCA listing row by TCA asset number', () => {
    const assets = [
      { id: 'a1', assetNumber: 'AS-1', description: 'Well pad', assetClass: 'Buildings', acquisitionDate: '2008-06-15', site: 'North', acquisitionCost: 2_100_000, accumAmort: 800_000, totalUl: 25, expiredUl: 10, assetStatus: 'Active' as const, scope: 'In scope' as const, scopeReason: '', columns: { Licence: 'L-9' } },
    ];
    const hit = tcaForObligation(assets, { assetId: 'AS-1' });
    expect(hit?.assetClass).toBe('Buildings');
    expect(hit?.description).toBe('Well pad');
    expect(tcaForObligation(assets, { assetId: 'AS-MISSING' })).toBeUndefined();
  });

  it('reads the ARO asset acquisition date from the master TCA listing', () => {
    const assets = [
      { id: 'a1', assetNumber: 'AS-1', description: 'Well pad', assetClass: 'Buildings', acquisitionDate: '2008-06-15', site: 'North', acquisitionCost: 2_100_000, accumAmort: 800_000, totalUl: 25, expiredUl: 10, assetStatus: 'Active' as const, scope: 'In scope' as const, scopeReason: '', columns: {} },
    ];
    expect(tcaAcquisitionDateOf(assets, 'AS-1')).toBe('2008-06-15');
    expect(tcaAcquisitionDateOf(assets, 'AS-MISSING')).toBe('');
  });
});

describe('master TCA listing Excel template', () => {
  it('includes acquisition cost, accum, NBV, asset status, scope and site', () => {
    const headers = tcaTemplateHeaders();
    expect(headers).toEqual([
      'TCA asset number',
      'Description',
      'TCA asset class',
      'Acquisition date',
      'Acquisition cost',
      'Accumulated amortization',
      'Net book value',
      'Total UL',
      'Expired UL',
      'Remaining UL',
      'Site',
      'Asset status',
      'Scope',
      'Reason if out',
    ]);
    const example = tcaTemplateNotes().find((r) => r[0] === 'AS-10001');
    expect(example).toHaveLength(headers.length);
    expect(example?.[headers.indexOf('Acquisition cost')]).toBe('2100000');
    expect(example?.[headers.indexOf('Accumulated amortization')]).toBe('800000');
    expect(example?.[headers.indexOf('Net book value')]).toBe('1300000');
    expect(example?.[headers.indexOf('Total UL')]).toBe('25');
    expect(example?.[headers.indexOf('Expired UL')]).toBe('10');
    expect(example?.[headers.indexOf('Remaining UL')]).toBe('15');
    expect(example?.[headers.indexOf('Asset status')]).toBe('Active');
  });

  it('maps Net book value as a calculated heading, not an extra', () => {
    const parsed = parseTcaListing([
      'TCA asset number,Description,Acquisition cost,Accumulated amortization,Net book value',
      'AS-10001,Well 14-23 pad,2100000,800000,1300000',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.extraNames).toEqual([]);
    expect(parsed.rows[0].acquisitionCost).toBe(2_100_000);
    expect(parsed.rows[0].accumAmort).toBe(800_000);
  });

  it('writes net book value on export as cost minus accum', () => {
    const rows = tcaTemplateDataRows([
      {
        id: 'a1', assetNumber: 'AS-1', description: 'Well pad', assetClass: 'Wells',
        acquisitionDate: '2008-06-15', site: 'North', acquisitionCost: 2_100_000,
        accumAmort: 800_000, totalUl: 25, expiredUl: 10, assetStatus: 'Unproductive', scope: 'In scope', scopeReason: '', columns: {},
      },
    ]);
    const headers = tcaTemplateHeaders();
    expect(rows[0][headers.indexOf('Acquisition cost')]).toBe(2_100_000);
    expect(rows[0][headers.indexOf('Accumulated amortization')]).toBe(800_000);
    expect(rows[0][headers.indexOf('Net book value')]).toBe(1_300_000);
    expect(rows[0][headers.indexOf('Total UL')]).toBe(25);
    expect(rows[0][headers.indexOf('Expired UL')]).toBe(10);
    expect(rows[0][headers.indexOf('Remaining UL')]).toBe(15);
    expect(rows[0][headers.indexOf('Asset status')]).toBe('Unproductive');
  });

  it('round-trips Total UL and Expired UL through the JSON payload', () => {
    const payload = tcaPayloadOf({
      id: 'a1', assetNumber: 'AS-1', description: 'Well pad', assetClass: 'Wells',
      acquisitionDate: '2008-06-15', site: 'North', acquisitionCost: 2_100_000,
      accumAmort: 800_000, totalUl: 25, expiredUl: 10, assetStatus: 'Active',
      scope: 'In scope', scopeReason: '', columns: { Licence: 'L-9' },
    });
    expect(payload._totalUl).toBe(25);
    expect(payload._expiredUl).toBe(10);
    const fields = tcaFieldsFromPayload(Object.fromEntries(
      Object.entries(payload).map(([k, v]) => [k, String(v)]),
    ));
    expect(fields.totalUl).toBe(25);
    expect(fields.expiredUl).toBe(10);
    expect(fields.columns.Licence).toBe('L-9');
    expect(fields.columns._totalUl).toBeUndefined();
  });
});

describe('go-forward TCA listing after opening lock', () => {
  it('freezes the conversion listing on lock and keeps later loads off it', () => {
    const { state, id } = unit();
    const obl = [
      'Obligation Number,Opening provision,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      'ARO-1,100,40,10,25,10,AS-1',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(obl), { filename: 'open.csv', text: obl });
    const tca = [
      'TCA asset number,Description,Asset status',
      'AS-1,Well pad,Active',
      'AS-2,Spare tank,Active',
    ].join('\n');
    loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
    const data = state.data[id];
    data.openingGlProvision = 100;
    data.openingGlAroCost = 50;
    data.openingGlAroAccum = 10;
    data.openingGlTcaCost = 0;
    data.openingGlTcaAccum = 0;
    lockOpeningBalances(data, '2026-04-01T00:00:00Z');
    expect(data.conversionAgreed).toBe(true);
    expect(openingTcaListing(data)).toHaveLength(2);

    const updated = [
      'TCA asset number,Description,Asset status,Scope',
      'AS-1,Well pad,Active,In scope',
      'AS-2,Spare tank,Unproductive,Scoped out',
      'AS-3,New plant,Active,Undecided',
    ].join('\n');
    const result = loadCurrentTcaListing(state, 't1', id, parseTcaListing(updated), { filename: 'tca-2.csv', text: updated });
    expect(result).toEqual({ added: 1, updated: 2, dropped: 0, problems: [] });
    expect(data.tcaAssets.map((a) => a.assetNumber)).toEqual(['AS-1', 'AS-2', 'AS-3']);
    expect(data.tcaAssets.find((a) => a.assetNumber === 'AS-3')?.scope).toBe('Undecided');
    expect(openingTcaListing(data).map((a) => a.assetNumber)).toEqual(['AS-1', 'AS-2']);
    expect(openingTcaListing(data).find((a) => a.assetNumber === 'AS-2')?.assetStatus).toBe('Active');
    expect(loadTcaListing(state, 't1', id, parseTcaListing(updated), { filename: 'tca-3.csv', text: updated })).toMatch(/frozen/i);
  });

  it('refuses a go-forward load before opening lock', () => {
    const { state, id } = unit();
    const tca = ['TCA asset number,Description', 'AS-1,Well pad'].join('\n');
    expect(loadCurrentTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca })).toMatch(/Lock opening balances/i);
  });
});
