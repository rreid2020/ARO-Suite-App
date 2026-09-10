import { describe, expect, it } from 'vitest';
import { combinedGroupOf } from '../screens/openingListings';
import { listingSheet, listingWorkbookName } from '../screens/listingExport';

describe('combined listing groups', () => {
  it('splits obligation, ARO asset, extras and master TCA columns', () => {
    expect(combinedGroupOf('ref')).toBe('Obligation');
    expect(combinedGroupOf('prov')).toBe('Obligation');
    expect(combinedGroupOf('assetId')).toBe('ARO asset');
    expect(combinedGroupOf('remainingUl')).toBe('ARO asset');
    expect(combinedGroupOf('col:UWI')).toBe('Extra columns');
    expect(combinedGroupOf('tcaDescription')).toBe('Master TCA listing');
    expect(combinedGroupOf('tca:Operator')).toBe('Master TCA listing');
  });
});

describe('listing export', () => {
  it('names the workbook with an .xlsx extension', () => {
    expect(listingWorkbookName('North Unit', 'opening-listings')).toBe('North-Unit-opening-listings.xlsx');
  });

  it('writes a group heading row and a total row', () => {
    const sheet = listingSheet({
      name: 'Combined listing',
      title: 'Demo — Combined listing',
      columns: [
        { key: 'ref', header: 'Obligation Number', group: 'Obligation', value: (r: { ref: string; cost: number }) => r.ref },
        { key: 'cost', header: 'Estimated cost', group: 'Obligation', kind: 'number', value: (r: { ref: string; cost: number }) => r.cost },
        { key: 'tcaNbv', header: 'TCA net book value', group: 'Master TCA listing', kind: 'number', value: (r: { ref: string; cost: number }) => r.cost },
      ],
      rows: [{ ref: 'ARO-1', cost: 100 }, { ref: 'ARO-2', cost: 50 }],
      totals: { cost: 150, tcaNbv: 150 },
    });
    expect(sheet.freeze).toBe(3);
    expect(sheet.rows[0][0]).toEqual({ v: 'Demo — Combined listing', s: 7 });
    expect(sheet.rows[1][0]).toEqual({ v: 'Obligation', s: 4 });
    expect(sheet.rows[1][2]).toEqual({ v: 'Master TCA listing', s: 4 });
    expect(sheet.merges).toEqual(expect.arrayContaining([
      { r1: 1, c1: 0, r2: 1, c2: 1 },
    ]));
    expect(sheet.rows[sheet.rows.length - 1][0]).toEqual({ v: 'Total', s: 5 });
  });
});
