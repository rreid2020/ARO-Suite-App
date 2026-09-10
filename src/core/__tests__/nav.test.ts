import { describe, expect, it } from 'vitest';
import { FIRM_NAV, resolveFirmNavId, resolveUnitScreen, STEPS, stepsFor } from '../nav';

describe('reporting-unit navigation', () => {
  it('does not expose Recalculation — this product is the source system', () => {
    expect(STEPS.some((s) => s.id === 'recalc')).toBe(false);
    expect(stepsFor('Reporting entity').some((s) => s.id === 'recalc')).toBe(false);
    expect(stepsFor('Auditor').some((s) => s.id === 'recalc')).toBe(false);
    expect(resolveUnitScreen('recalc')).toBe('register');
    expect(resolveUnitScreen('register')).toBe('register');
  });

  it('keeps cost estimates, adjustments and the ARO asset on the register', () => {
    const measure = stepsFor('Reporting entity').filter((s) => s.phase === 'Measure').map((s) => s.id);
    expect(measure).toEqual(['register', 'layers', 'ledger']);
    expect(resolveUnitScreen('cost')).toBe('register');
    expect(resolveUnitScreen('adjust')).toBe('register');
    expect(resolveUnitScreen('arc')).toBe('register');
  });

  it('puts month-end posting in Close for a reporting entity', () => {
    const close = stepsFor('Reporting entity').filter((s) => s.phase === 'Close').map((s) => s.id);
    expect(close).toContain('month-end');
    expect(close.indexOf('month-end')).toBeGreaterThan(close.indexOf('calendar'));
    expect(close.indexOf('month-end')).toBeLessThan(close.indexOf('batches'));
    expect(stepsFor('Auditor').some((s) => s.id === 'month-end')).toBe(false);
  });

  /**
   * Mode 1 recalculates the provision against a figure some *other* system
   * reported. A reporting entity running this product as its module of record
   * has nothing to recalculate against — it is the source system, which is why
   * the old `recalc` step was retired. An auditor is the opposite case: the
   * numbers belong to the client, and testing them is the whole engagement.
   *
   * So Mode 1 sits in the auditor tenancy, alongside intake and normalisation,
   * which are auditor-only for the same reason.
   */
  it('gives Mode 1 to the auditor tenancy and not to a reporting entity', () => {
    const MODE_1 = ['recalc-import', 'recalc-source', 'recalculation', 'recalc-compare',
      'recalc-exceptions', 'recalc-variance'];
    const auditor = stepsFor('Auditor').map((s) => s.id);
    const firm = stepsFor('Reporting entity').map((s) => s.id);
    for (const id of MODE_1) {
      expect(auditor, `auditor should see ${id}`).toContain(id);
      expect(firm, `a reporting entity should not see ${id}`).not.toContain(id);
    }
  });

  it('lists How to use it as a firm screen, not a numbered unit step', () => {
    expect(FIRM_NAV[0].id).toBe('howto');
    expect(STEPS.some((s) => s.id === 'howto')).toBe(false);
    expect(resolveFirmNavId('howto')).toBe('howto');
    expect(resolveUnitScreen('howto')).toBe('howto');
  });

  it('does not resurrect the retired `recalc` id', () => {
    // It is still an alias onto the register, and a persisted one must keep
    // opening the register rather than the new recalculation screen.
    expect(STEPS.some((s) => s.id === 'recalc')).toBe(false);
    expect(resolveUnitScreen('recalc')).toBe('register');
    expect(resolveUnitScreen('recalculation')).toBe('recalculation');
  });
});
