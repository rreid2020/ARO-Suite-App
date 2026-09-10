import { describe, expect, it } from 'vitest';
import { columnGroupSpans, groupToneClass, groupToneSlug } from '../groupTone';

describe('groupTone', () => {
  it('slugs group names used on the register', () => {
    expect(groupToneSlug('ARO asset')).toBe('aro-asset');
    expect(groupToneSlug('Identity')).toBe('identity');
    expect(groupToneSlug('Opening')).toBe('opening');
    expect(groupToneSlug('Master TCA listing')).toBe('master-tca-listing');
  });

  it('adds the start rule and extra classes', () => {
    expect(groupToneClass('Existing', true, 'num')).toBe('g-tone g-existing g-start num');
    expect(groupToneClass('New')).toBe('g-tone g-new');
  });

  it('spans consecutive columns that share a group', () => {
    expect(columnGroupSpans(['Obligation', 'Obligation', 'ARO asset', 'Master TCA listing', 'Master TCA listing']))
      .toEqual([
        { group: 'Obligation', span: 2 },
        { group: 'ARO asset', span: 1 },
        { group: 'Master TCA listing', span: 2 },
      ]);
  });
});
