import { describe, expect, it } from 'vitest';
import { emptyAppState } from '../emptyState';
import { addReportingUnit } from '../createUnit';
import { OPENING_TEMPLATE_COLUMNS, loadOpeningRegister, lockOpeningBlocked, measureOpeningBalances, obligationColumnNames, obligationReconciled, openingArcTotal, openingAroCostTotal, openingLocked, openingProvisionTotal, openingReconciled, openingTemplateDataRows, openingTemplateHeaders, openingTemplateNotes, parseOpeningRegister, remainingUl } from '../openingLoad';
import { loadTcaListing, parseTcaListing } from '../tcaListing';
import { obligationExtractColumns } from '../../ui/screens/openingListings';
import { measureObligation } from '../measure';
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

const REQUIRED_HEADER = 'Obligation Number,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number';
const requiredRow = (ref: string, extra = '') => `${ref},100,40,10,25,10,AS-${ref}${extra}`;

describe('parseOpeningRegister', () => {
  it('reads a headed spreadsheet of obligations with opening provision and ARO asset', () => {
    const parsed = parseOpeningRegister([
      'Reference,Description,Asset class,Opening provision,ARO asset,Accumulated amortization,Estimated cost,Site,Total UL,Expired UL,Asset number',
      'ARO-0001,Well abandonment,Wells,1200000,800000,400000,1500000,North,25,10,AS-10001',
      'ARO-0002,Plant decommissioning,Plant,400000,250000,100000,500000,South,40,12,AS-10002',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].ref).toBe('ARO-0001');
    expect(parsed.rows[0].openingProvision).toBe(1_200_000);
    expect(parsed.rows[0].openingArc).toBe(800_000);
    expect(parsed.rows[0].aroAssetClass).toBe('Wells');
    expect(parsed.rows[1].estimatedCost).toBe(500_000);
  });

  it('reads ARO asset number separately from TCA asset number', () => {
    const parsed = parseOpeningRegister([
      'Obligation Number,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,TCA asset number,ARO asset number',
      'ARO-0001,1200000,800000,400000,25,10,AS-10001,ARO-10001',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.extraNames).toEqual([]);
    expect(parsed.rows[0].assetId).toBe('AS-10001');
    expect(parsed.rows[0].aroAssetNumber).toBe('ARO-10001');
  });

  it('reads asset class code and name as separate columns', () => {
    const parsed = parseOpeningRegister([
      'Reference,Description,ARO asset class code,ARO asset class name,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      'ARO-0001,Building retirement,11010,Buildings,1200000,800000,400000,25,10,AS-10001',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows[0].aroAssetClass).toBe('11010');
  });

  it('maps accumulated amortization and opening future value as conversion fields, not extras', () => {
    const parsed = parseOpeningRegister([
      'Reference,Estimated cost,ARO asset,Accumulated depreciation,Opening FV,Total UL,Expired UL,Asset number',
      'ARO-0001,1200000,800000,400000,2100000,25,10,AS-1',
    ].join('\n'));
    expect(parsed.extraNames).toEqual([]);
    expect(parsed.rows[0].openingAccumAmort).toBe(400_000);
    expect(parsed.rows[0].openingFv).toBe(2_100_000);
  });

  it('maps total UL and expired UL as conversion fields and remaining UL is not an extra', () => {
    const parsed = parseOpeningRegister([
      'Obligation Number,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,Remaining UL,Asset number',
      'ARO-0001,1200000,800000,400000,25,10,15,AS-1',
    ].join('\n'));
    expect(parsed.extraNames).toEqual([]);
    expect(parsed.rows[0].totalUl).toBe(25);
    expect(parsed.rows[0].expiredUl).toBe(10);
    expect(remainingUl({ totalUl: 25, expiredUl: 10 } as never)).toBe(15);
    expect(remainingUl({ totalUl: 25 } as never)).toBe(25);
    expect(remainingUl({ expiredUl: 10 } as never)).toBeNull();
  });

  it('reads Total UL and Expired UL as years and leftover months', () => {
    const parsed = parseOpeningRegister([
      'Obligation Number,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      'ARO-0001,1200000,800000,400000,17 yr · 9 mo,5 yr · 3 mo,AS-1',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows[0].totalUl).toBe(17.75);
    expect(parsed.rows[0].expiredUl).toBe(5.25);
  });

  it('maps ARO acquisition cost as a calculated heading, not an extra', () => {
    const parsed = parseOpeningRegister([
      'Obligation Number,Estimated cost,ARO asset,Accumulated amortization,ARO acquisition cost,Total UL,Expired UL,Asset number',
      'ARO-0001,1200000,800000,400000,1200000,25,10,AS-1',
    ].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.extraNames).toEqual([]);
    expect(parsed.rows[0].openingArc).toBe(800_000);
    expect(parsed.rows[0].openingAccumAmort).toBe(400_000);
  });

  it('maps ARO asset description and asset acquisition date as conversion fields, not extras', () => {
    const parsed = parseOpeningRegister([
      'Obligation Number,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,ARO Asset Description,Asset acquisition date,Asset number',
      'ARO-0001,1200000,800000,400000,25,10,Well 14-23 pad,2008-06-15,AS-1',
    ].join('\n'));
    expect(parsed.extraNames).toEqual([]);
    expect(parsed.rows[0].assetDescription).toBe('Well 14-23 pad');
    expect(parsed.rows[0].assetAcquisitionDate).toBe('2008-06-15');
  });

  it('refuses the file when expired UL is greater than total UL', () => {
    const parsed = parseOpeningRegister([
      `${REQUIRED_HEADER}`,
      'ARO-0001,1200000,800000,400000,10,25,AS-1',
    ].join('\n'));
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.some((p) => /Expired UL cannot exceed Total UL/i.test(p))).toBe(true);
  });

  it('keeps extra columns under the organisation\'s own headings', () => {
    const parsed = parseOpeningRegister([
      `${REQUIRED_HEADER},Licence,UWI,Operator`,
      `${requiredRow('ARO-0001')},ABC-12,100/01-02-003-04W5/00,North Co`,
    ].join('\n'));
    expect(parsed.extraNames).toEqual(['Licence', 'UWI', 'Operator']);
    expect(parsed.rows[0].columns).toEqual({
      Licence: 'ABC-12',
      UWI: '100/01-02-003-04W5/00',
      Operator: 'North Co',
    });
  });

  it('refuses a duplicate Obligation Number and a row with missing opening balances', () => {
    const parsed = parseOpeningRegister([
      REQUIRED_HEADER,
      requiredRow('ARO-1'),
      requiredRow('ARO-1').replace(',100,', ',200,'),
      'ARO-2,,,,,',
    ].join('\n'));
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.some((p) => /already used/i.test(p))).toBe(true);
    expect(parsed.problems.some((p) => /ARO-2/.test(p) && /Estimated cost is missing/i.test(p))).toBe(true);
  });

  it('refuses the whole file when a required column is missing', () => {
    const parsed = parseOpeningRegister([
      'Obligation Number,Estimated cost,ARO asset',
      'ARO-0001,1200000,800000',
    ].join('\n'));
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.some((p) => /Accumulated amortization/i.test(p))).toBe(true);
    expect(parsed.problems.some((p) => /Total UL/i.test(p))).toBe(true);
    expect(parsed.problems.some((p) => /Expired UL/i.test(p))).toBe(true);
    expect(parsed.problems.some((p) => /Asset number/i.test(p))).toBe(true);
  });

  it('refuses a row with no Asset number', () => {
    const parsed = parseOpeningRegister([
      REQUIRED_HEADER,
      'ARO-0001,100,40,10,25,10,',
    ].join('\n'));
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.some((p) => /Asset number is missing/i.test(p))).toBe(true);
  });

  it('refuses the whole file when one row is incomplete, even if others are complete', () => {
    const parsed = parseOpeningRegister([
      REQUIRED_HEADER,
      requiredRow('ARO-0001'),
      'ARO-0002,250,90,,,',
    ].join('\n'));
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.some((p) => /ARO-0002/.test(p))).toBe(true);
  });

  it('refuses a file with no heading row', () => {
    const parsed = parseOpeningRegister('ARO-0001,100,40,10,25,10');
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.some((p) => /column headings/i.test(p))).toBe(true);
  });
});

describe('loadOpeningRegister', () => {
  it('creates obligations and opening events, and recon totals the file not the trial balance', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [
      'Reference,Description,Estimated cost,ARO asset,Accumulated amortization,Asset class,Total UL,Expired UL,Asset number',
      'ARO-0001,Well,100,40,10,Wells,25,10,AS-10001',
      'ARO-0002,Plant,250,90,20,Plant,40,12,AS-10002',
    ].join('\n');
    const parsed = parseOpeningRegister(text);
    const result = loadOpeningRegister(state, 't1', id, parsed, { filename: 'opening.csv', text });
    expect(result).toEqual({ added: 2, updated: 0, problems: [] });
    const data = state.data[id];
    expect(data.obligations.map((o) => o.ref)).toEqual(['ARO-0001', 'ARO-0002']);
    expect(data.obligations[0].openingArc).toBe(40);
    expect(data.obligations[0].totalUl).toBe(25);
    expect(data.obligations[0].expiredUl).toBe(10);
    expect(remainingUl(data.obligations[0])).toBe(15);
    expect(data.events.filter((e) => e.type === 'opening')).toHaveLength(2);
    expect(openingProvisionTotal(data.events)).toBe(385);
    expect(data.obligations[0].openingFv).toBe(110);
    expect(data.obligations[1].openingFv).toBe(275);
    expect(openingArcTotal(data.obligations)).toBe(130);
    expect(data.extracts[0].kind).toBe('Opening register');
    expect(data.extracts[0].acceptedAt).toBeTruthy();
  });

  it('measures opening future value and opening provision from estimated cost', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [`${REQUIRED_HEADER}`, requiredRow('ARO-1')].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    const unit = state.units['t1'][0];
    const o = state.data[id].obligations[0];
    const measured = measureOpeningBalances(state, unit, o);
    expect(o.openingFv).toBe(measured.fv);
    expect(openingProvisionTotal(state.data[id].events)).toBe(measured.pv);
    expect(measured.fv).toBe(110);
    expect(measured.pv).toBe(110);
  });

  it('measures opening as at conversion, without rolling estimated cost to this year end', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    state.curves['t1'] = [{
      id: 'cad', name: 'CAD zero', currency: 'CAD', source: 'test',
      basis: 'Zero-coupon', interpolation: 'step', extrapolation: 'flat-last',
      asAt: '2026-03-31',
      points: [{ term: 1, rate: 0.03 }, { term: 15, rate: 0.04 }, { term: 25, rate: 0.042 }],
    }];
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [
      'Estimated cost,Cost estimate date,Expected settlement,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      '1000000,2026-03-31,2041-03-31,40,10,25,10,AS-1',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    const unit = state.units['t1'][0];
    const o = state.data[id].obligations[0];
    const atConversion = measureObligation(state, unit, o, '2026-03-31');
    const atYearEnd = measureObligation(state, unit, o, unit.fyEnd);
    expect(atConversion.t1).toBeCloseTo(0, 12);
    expect(atConversion.cce).toBe(atConversion.cost);
    expect(atConversion.cce).toBe(1_100_000);
    expect(atYearEnd.cce).toBeGreaterThan(atConversion.cce);
    const measured = measureOpeningBalances(state, unit, o);
    expect(o.openingFv).toBe(measured.fv);
    expect(openingProvisionTotal(state.data[id].events)).toBe(measured.pv);
    expect(measured.pv).toBe(Math.round(atConversion.pv * 100) / 100);
    expect(measured.pv).not.toBe(Math.round(atYearEnd.pv * 100) / 100);
  });

  it('ignores Opening future value and Opening provision on a legacy extract', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [
      'Estimated cost,Opening future value,Opening provision,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      '100,9999,8888,40,10,25,10,AS-1',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'legacy.csv', text });
    const o = state.data[id].obligations[0];
    expect(o.openingFv).toBe(110);
    expect(openingProvisionTotal(state.data[id].events)).toBe(110);
    expect(state.data[id].events[0].note).toMatch(/measured on load from legacy.csv/);
  });

  it('stores extra extract columns on the obligation so they survive reload', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [
      'Reference,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number,Licence,Cost centre',
      'ARO-1,100,40,10,25,10,AS-1,L-9,CC-100',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    const o = state.data[id].obligations[0];
    expect(o.columns).toEqual({ Licence: 'L-9', 'Cost centre': 'CC-100' });
    expect(obligationColumnNames(state.data[id].obligations)).toEqual(['Licence', 'Cost centre']);
    const reload = [
      'Reference,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number,Licence,Cost centre',
      'ARO-1,180,55,12,25,10,AS-1,L-9A,CC-200',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(reload), { filename: 'opening-2.csv', text: reload });
    expect(state.data[id].obligations[0].columns).toEqual({ Licence: 'L-9A', 'Cost centre': 'CC-200' });
  });

  it('loads ARO asset description and asset acquisition date onto the obligation', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [
      'Reference,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,ARO Asset Description,Asset acquisition date,Asset number',
      'ARO-1,100,40,10,25,10,Well 14-23 pad,2008-06-15,AS-1',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    const o = state.data[id].obligations[0];
    expect(o.assetDescription).toBe('Well 14-23 pad');
    expect(o.assetAcquisitionDate).toBe('2008-06-15');
    const headers = openingTemplateHeaders();
    const exported = openingTemplateDataRows(state.data[id].obligations, state.data[id].events)[0];
    expect(exported[headers.indexOf('ARO Asset Description')]).toBe('Well 14-23 pad');
    expect(exported[headers.indexOf('Asset acquisition date')]).toBe('2008-06-15');
  });

  it('stores a supplied ARO asset number on load even though the template no longer asks for one', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [
      'Reference,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number,ARO asset number',
      'ARO-1,100,40,10,25,10,AS-1,ARO-AS-1',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    expect(state.data[id].obligations[0].aroAssetNumber).toBe('ARO-AS-1');
    expect(openingTemplateHeaders()).not.toContain('ARO asset number');
    expect(openingTemplateHeaders()).not.toContain('Obligation Number');
    expect(openingTemplateDataRows(state.data[id].obligations, state.data[id].events)[0][openingTemplateHeaders().indexOf('TCA asset number')]).toBe('AS-1');
  });

  it('assigns an ARO asset number from the TCA asset number when the extract leaves it blank', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [
      'Reference,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      'ARO-1,100,40,10,25,10,AS-1',
      'ARO-2,80,30,8,20,8,AS-1',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    expect(state.data[id].obligations.map((o) => o.aroAssetNumber).sort()).toEqual(['ARC-AS-1', 'ARC-AS-1-2']);
    expect(openingTemplateHeaders()).not.toContain('ARO asset number');
  });

  it('updates an existing reference on reload instead of duplicating it', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const first = parseOpeningRegister(`${REQUIRED_HEADER}\n${requiredRow('ARO-1')}`);
    loadOpeningRegister(state, 't1', id, first, { filename: 'a.csv', text: 'a' });
    const second = parseOpeningRegister(`${REQUIRED_HEADER}\nARO-1,180,55,12,25,10,AS-ARO-1`);
    const result = loadOpeningRegister(state, 't1', id, second, { filename: 'b.csv', text: 'b' });
    expect(result).toEqual({ added: 0, updated: 1, problems: [] });
    expect(state.data[id].obligations).toHaveLength(1);
    expect(openingProvisionTotal(state.data[id].events)).toBe(198);
    expect(state.data[id].obligations[0].openingArc).toBe(55);
    expect(state.data[id].events.filter((e) => e.type === 'opening')).toHaveLength(1);
  });

  it('does not write any obligations when the parse reported problems', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const parsed = parseOpeningRegister([REQUIRED_HEADER, requiredRow('ARO-0001'), 'ARO-0002,250,90,,,'].join('\n'));
    const result = loadOpeningRegister(state, 't1', id, parsed, { filename: 'opening.csv', text: 'x' });
    expect(typeof result).toBe('string');
    expect(state.data[id].obligations).toHaveLength(0);
    expect(state.data[id].events.filter((e) => e.type === 'opening')).toHaveLength(0);
  });

  it('refuses a second load once opening balances are locked', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [`${REQUIRED_HEADER}`, requiredRow('ARO-1')].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    const tca = ['Asset number,Description', 'AS-ARO-1,Well pad'].join('\n');
    loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
    state.data[id].openingGlProvision = 110;
    state.data[id].openingGlAroCost = 50;
    state.data[id].openingGlAroAccum = 10;
    state.data[id].openingGlTcaCost = 0;
    state.data[id].openingGlTcaAccum = 0;
    expect(openingReconciled(state.data[id]).ok).toBe(true);
    expect(lockOpeningBlocked(state.data[id])).toBe('');
    state.data[id].conversionAgreed = true;
    expect(openingLocked(state.data[id])).toBe(true);
    const again = loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening-2.csv', text });
    expect(again).toMatch(/locked/i);
    expect(state.data[id].obligations).toHaveLength(1);
  });

  it('will not lock until the register agrees to both GL totals', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [`${REQUIRED_HEADER}`, requiredRow('ARO-1')].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    expect(lockOpeningBlocked(state.data[id])).toMatch(/master TCA listing/i);
    const tca = ['Asset number,Description', 'AS-ARO-1,Well pad'].join('\n');
    loadTcaListing(state, 't1', id, parseTcaListing(tca), { filename: 'tca.csv', text: tca });
    expect(lockOpeningBlocked(state.data[id])).toMatch(/GL totals/i);
    state.data[id].openingGlProvision = 999;
    state.data[id].openingGlAroCost = 50;
    state.data[id].openingGlAroAccum = 10;
    expect(lockOpeningBlocked(state.data[id])).toMatch(/does not agree/i);
    state.data[id].openingGlProvision = 110;
    expect(lockOpeningBlocked(state.data[id])).toMatch(/TCA acquisition cost/i);
    state.data[id].openingGlTcaCost = 0;
    state.data[id].openingGlTcaAccum = 0;
    expect(lockOpeningBlocked(state.data[id])).toBe('');
  });
});

describe('opening register Excel template', () => {
  it('uses headings the loader recognises, including obligation type', () => {
    const headers = openingTemplateHeaders();
    expect(headers).toEqual([
      'Description',
      'Obligation type',
      'Basis',
      'Site',
      'Region',
      'Cost estimate date',
      'Expected settlement',
      'Estimated cost',
      'TCA asset number',
      'ARO Asset Description',
      'Asset acquisition date',
      'ARO asset class code',
      'ARO asset class name',
      'ARO acquisition cost',
      'Accumulated amortization',
      'ARO asset',
      'Total UL',
      'Expired UL',
      'Remaining UL',
    ]);
    const row = ['Well', 'Wells', 'Legal', 'North', 'AB', '2026-12-31', '2038-06-30', '1500000', 'AS-1', 'Well 14-23 pad', '2008-06-15', '1000', 'Wells', '1200000', '400000', '800000', '25', '10', '15'];
    const parsed = parseOpeningRegister([headers.join(','), row.join(',')].join('\n'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows[0].ref).toBe('');
    expect(parsed.rows[0].type).toBe('Wells');
    expect(parsed.rows[0].aroAssetClass).toBe('1000');
    expect(parsed.rows[0].estimatedCost).toBe(1_500_000);
    expect(parsed.rows[0].openingArc).toBe(800_000);
    expect(parsed.rows[0].openingAccumAmort).toBe(400_000);
    expect(parsed.rows[0].openingFv).toBeNull();
    expect(parsed.rows[0].openingProvision).toBeNull();
    expect(parsed.rows[0].totalUl).toBe(25);
    expect(parsed.rows[0].expiredUl).toBe(10);
    expect(parsed.rows[0].assetId).toBe('AS-1');
    expect(parsed.rows[0].aroAssetNumber).toBe('');
    expect(parsed.rows[0].assetDescription).toBe('Well 14-23 pad');
    expect(parsed.rows[0].assetAcquisitionDate).toBe('2008-06-15');
    const example = openingTemplateNotes().find((r) => r[0] === 'Well abandonment');
    expect(example).toHaveLength(headers.length);
    expect(example?.[headers.indexOf('ARO Asset Description')]).toBe('Well 14-23 pad');
    expect(example?.[headers.indexOf('Asset acquisition date')]).toBe('2008-06-15');
    expect(example?.[headers.indexOf('ARO acquisition cost')]).toBe('1200000');
    expect(example?.[headers.indexOf('ARO asset')]).toBe('800000');
    expect(example?.[headers.indexOf('Remaining UL')]).toBe('15');
    expect(headers).not.toContain('Obligation Number');
    expect(headers).not.toContain('ARO asset number');
    expect(headers).not.toContain('Opening future value');
    expect(headers).not.toContain('Opening provision');
  });

  it('appends extra organisation headings and fills them from loaded rows', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [
      'Reference,Estimated cost,ARO asset,Accumulated amortization,Obligation type,Total UL,Expired UL,Asset number,Licence',
      'ARO-1,100,40,10,Wells,25,10,AS-1,L-9',
    ].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    const extras = obligationColumnNames(state.data[id].obligations);
    const headers = openingTemplateHeaders(extras);
    expect(headers[headers.length - 1]).toBe('Licence');
    expect(headers).not.toContain('Obligation Number');
    expect(headers).not.toContain('ARO asset number');
    expect(state.data[id].obligations[0].ref).toBe('ARO-1');
    const rows = openingTemplateDataRows(state.data[id].obligations, state.data[id].events, extras);
    expect(rows[0][headers.indexOf('Estimated cost')]).toBe(100);
    expect(rows[0][headers.indexOf('Licence')]).toBe('L-9');
  });

  it('shows every extract ARO asset column on the listing, plus calculated acquisition cost', () => {
    const headers = obligationExtractColumns({
      events: [], extras: [], classes: [], currency: 'CAD', calendarType: 'Monthly (12)',
    }).map((c) => c.header);
    const start = OPENING_TEMPLATE_COLUMNS.findIndex((c) => c.header === 'ARO Asset Description');
    expect(start).toBeGreaterThanOrEqual(0);
    for (const c of OPENING_TEMPLATE_COLUMNS.slice(start)) {
      expect(headers).toContain(c.header);
    }
    expect(headers).toContain('ARO acquisition cost');
    expect(headers).toContain('Opening future value');
    expect(headers).toContain('Opening provision');
  });

  it('writes ARO acquisition cost and remaining UL on the export template', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [`${REQUIRED_HEADER}`, requiredRow('ARO-1')].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    const tpl = openingTemplateHeaders();
    const exported = openingTemplateDataRows(state.data[id].obligations, state.data[id].events);
    expect(exported[0][tpl.indexOf('ARO acquisition cost')]).toBe(50);
    expect(exported[0][tpl.indexOf('ARO asset')]).toBe(40);
    expect(exported[0][tpl.indexOf('Accumulated amortization')]).toBe(10);
    expect(exported[0][tpl.indexOf('Remaining UL')]).toBe(15);
  });

  it('assigns Obligation Number and ARO asset number when the extract omits them', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [
      'Description,Estimated cost,ARO asset,Accumulated amortization,Total UL,Expired UL,Asset number',
      'Well pad,100,40,10,25,10,AS-1',
      'Plant,80,30,8,20,8,AS-1',
    ].join('\n');
    const result = loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    expect(result).toEqual({ added: 2, updated: 0, problems: [] });
    expect(state.data[id].obligations.map((o) => o.ref).sort()).toEqual(['ARO-AS-1', 'ARO-AS-1-2']);
    expect(state.data[id].obligations.map((o) => o.aroAssetNumber).sort()).toEqual(['ARC-AS-1', 'ARC-AS-1-2']);
    const again = loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening-2.csv', text });
    expect(again).toEqual({ added: 0, updated: 2, problems: [] });
    expect(state.data[id].obligations).toHaveLength(2);
    expect(state.data[id].obligations.map((o) => o.ref).sort()).toEqual(['ARO-AS-1', 'ARO-AS-1-2']);
  });
});

describe('obligation recon', () => {
  it('agrees ARO acquisition cost and accum to the trial balance, not only NBV', () => {
    const state = emptyAppState();
    state.settings['t1'] = settings();
    const id = addReportingUnit(state, {
      tenantId: 't1', entity: 'Infrastructure and Environment', fyEnd: '2027-03-31', currency: 'CAD',
    });
    const text = [`${REQUIRED_HEADER}`, requiredRow('ARO-1')].join('\n');
    loadOpeningRegister(state, 't1', id, parseOpeningRegister(text), { filename: 'opening.csv', text });
    expect(openingAroCostTotal(state.data[id].obligations)).toBe(50);
    state.data[id].openingGlProvision = 110;
    state.data[id].openingGlArc = 40;
    expect(obligationReconciled(state.data[id]).ok).toBe(false);
    state.data[id].openingGlAroCost = 40;
    state.data[id].openingGlAroAccum = 10;
    expect(obligationReconciled(state.data[id]).ok).toBe(false);
    state.data[id].openingGlAroCost = 50;
    expect(obligationReconciled(state.data[id]).ok).toBe(true);
  });
});
