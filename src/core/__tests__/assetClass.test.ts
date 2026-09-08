import { describe, expect, it } from 'vitest';
import {
  canonicalizeObligationClasses,
  classCodeOf,
  classKey,
  classLabel,
  classNameOf,
  findAssetClass,
  normalizeAroAssetClasses,
  splitClassLabel,
} from '../assetClass';
import type { AroAssetClass, TenantSettings } from '../types';

const buildings: AroAssetClass = {
  id: 'c-b', tenantId: 't1', code: '11010', name: 'Buildings', scenarioId: 'scn-b',
};
const works: AroAssetClass = {
  id: 'c-w', tenantId: 't1', code: '11040', name: 'Works', scenarioId: 'scn-w',
};
const wells: AroAssetClass = {
  id: 'c-wells', tenantId: 't1', code: '', name: 'Wells', scenarioId: 'scn-wells',
};

describe('splitClassLabel', () => {
  it('splits a numbered label, an em-dash label, and a bare code', () => {
    expect(splitClassLabel('11010 Buildings')).toEqual({ code: '11010', name: 'Buildings' });
    expect(splitClassLabel('11010 — Buildings')).toEqual({ code: '11010', name: 'Buildings' });
    expect(splitClassLabel('11010')).toEqual({ code: '11010', name: '' });
    expect(splitClassLabel('Buildings')).toEqual({ code: '', name: 'Buildings' });
  });
});

describe('findAssetClass', () => {
  const classes = [buildings, works, wells];

  it('matches by code, name, or combined label so posting follows the register class', () => {
    expect(findAssetClass(classes, '11010')?.id).toBe('c-b');
    expect(findAssetClass(classes, 'Buildings')?.id).toBe('c-b');
    expect(findAssetClass(classes, '11010 Buildings')?.id).toBe('c-b');
    expect(findAssetClass(classes, '11010 — Buildings')?.id).toBe('c-b');
    expect(findAssetClass(classes, '11040')?.id).toBe('c-w');
    expect(findAssetClass(classes, 'Wells')?.id).toBe('c-wells');
    expect(findAssetClass(classes, '')).toBeUndefined();
    expect(findAssetClass(classes, '99999')).toBeUndefined();
  });
});

describe('class display helpers', () => {
  it('prefers the class catalog over the raw stored value', () => {
    expect(classKey(buildings)).toBe('11010');
    expect(classLabel(buildings)).toBe('11010 — Buildings');
    expect(classCodeOf('11010', [buildings])).toBe('11010');
    expect(classNameOf('11010', [buildings])).toBe('Buildings');
    expect(classCodeOf('11010 Buildings', [buildings])).toBe('11010');
    expect(classNameOf('11010 Buildings', [buildings])).toBe('Buildings');
  });
});

describe('normalizeAroAssetClasses', () => {
  it('splits a combined name onto code and name and retitles the dedicated scenario', () => {
    const settings = {
      aroAssetClasses: [
        { id: 'c1', tenantId: 't1', code: '', name: '11010 Buildings', scenarioId: 'scn-b' },
      ],
      postingScenarios: [
        { id: 'scn-b', tenantId: 't1', name: '11010 Buildings', isDefault: false, accounts: {}, completedRoles: [] },
      ],
    } as unknown as TenantSettings;
    normalizeAroAssetClasses(settings);
    expect(settings.aroAssetClasses[0]).toMatchObject({ code: '11010', name: 'Buildings' });
    expect(settings.postingScenarios[0].name).toBe('11010 — Buildings');
  });
});

describe('canonicalizeObligationClasses', () => {
  it('stores the class key (code when present) on each obligation', () => {
    const settings = {
      aroAssetClasses: [buildings],
      postingScenarios: [],
    } as unknown as TenantSettings;
    const data = {
      obligations: [
        { aroAssetClass: '11010 Buildings' },
        { aroAssetClass: 'Buildings' },
        { aroAssetClass: 'Unknown' },
      ],
    };
    canonicalizeObligationClasses(settings, data as unknown as { obligations: import('../types').Obligation[] });
    expect(data.obligations.map((o) => o.aroAssetClass)).toEqual(['11010', '11010', 'Unknown']);
  });
});
