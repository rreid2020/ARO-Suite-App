import { describe, expect, it } from 'vitest';
import { groupToneClass, groupToneSlug } from '../groupTone';

describe('groupTone', () => {
  it('slugs group names used on the register', () => {
    expect(groupToneSlug('ARO asset')).toBe('aro-asset');
    expect(groupToneSlug('Identity')).toBe('identity');
    expect(groupToneSlug('Opening')).toBe('opening');
  });

  it('adds the start rule and extra classes', () => {
    expect(groupToneClass('Existing', true, 'num')).toBe('g-tone g-existing g-start num');
    expect(groupToneClass('New')).toBe('g-tone g-new');
  });
});
