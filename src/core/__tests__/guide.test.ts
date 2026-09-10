import { describe, expect, it } from 'vitest';
import { FIRM_NAV, STEPS, resolveFirmNavId, stepsFor } from '../nav';
import {
  guideFor,
  openToolTarget,
  startWalkthroughTarget,
  tourIndexForScreen,
  walkthroughFor,
  walkthroughGaps,
} from '../guide';
import { emptyAppState } from '../emptyState';
import type { ReportingUnit } from '../types';

const unit = (id: string) => ({ id, tenantId: 't1' }) as ReportingUnit;

describe('How to use it', () => {
  it('is a firm screen, not a numbered unit step', () => {
    expect(FIRM_NAV.some((n) => n.id === 'howto')).toBe(true);
    expect(STEPS.some((s) => s.id === 'howto')).toBe(false);
    expect(resolveFirmNavId('howto')).toBe('howto');
  });

  it('gives each tenant kind a walkthrough on screens that kind can open', () => {
    expect(walkthroughFor('Auditor').length).toBe(8);
    expect(walkthroughFor('Reporting entity').length).toBe(9);
    for (const kind of ['Auditor', 'Reporting entity'] as const) {
      expect(walkthroughGaps(kind), kind).toEqual([]);
      const allowed = new Set(stepsFor(kind).map((s) => s.id));
      for (const step of walkthroughFor(kind)) {
        expect(allowed.has(step.screen), `${kind} ${step.screen}`).toBe(true);
      }
    }
  });

  it('starts an auditor on Source extracts and a reporting entity on its own landing', () => {
    expect(walkthroughFor('Auditor')[0].screen).toBe('recalc-import');
    expect(guideFor('Auditor').kicker).toMatch(/recalculation/i);
    expect(openToolTarget('Auditor', emptyAppState(), 't1', null)).toEqual({
      unitId: null, screen: 'setup',
    });
  });

  it('opens the first reporting unit when launching the tool or the walkthrough', () => {
    const state = emptyAppState();
    state.units.t1 = [unit('u1')];
    expect(openToolTarget('Auditor', state, 't1', null)).toEqual({
      unitId: 'u1', screen: 'recalc-import',
    });
    expect(startWalkthroughTarget('Auditor', state, 't1', null)).toEqual({
      unitId: 'u1', screen: 'recalc-import', tour: 0,
    });
    expect(startWalkthroughTarget('Auditor', emptyAppState(), 't1', null)).toEqual({
      needUnit: true,
    });
  });

  it('keeps the current walkthrough index when two steps share a screen', () => {
    expect(tourIndexForScreen('Auditor', 'recalc-import', 1)).toBe(1);
    expect(tourIndexForScreen('Auditor', 'recalc-import', null)).toBe(0);
    expect(tourIndexForScreen('Auditor', 'recalc-source', 0)).toBe(2);
    expect(tourIndexForScreen('Auditor', 'changelog', 3)).toBe(null);
  });

  it('teaches a reporting entity to post from the register row and open calculation-details lines', () => {
    const guide = guideFor('Reporting entity');
    const measure = guide.fiveMinute.find((item) => item.title === 'Measure');
    expect(measure?.body).toMatch(/register row/i);
    expect(measure?.body).toMatch(/calculation-details/i);
    const section = guide.sections.find((s) => s.id === 'register');
    expect(section?.title).toMatch(/register or on Transactions/i);
    expect(section?.body.join(' ')).toMatch(/Transactions tabs/i);
    expect(section?.body.join(' ')).toMatch(/calculation-details line/i);
    const registerStep = walkthroughFor('Reporting entity').find((s) => s.screen === 'register');
    expect(registerStep?.body).toMatch(/calculation-details line/i);
    expect(registerStep?.body).toMatch(/cost or term adjustment or a settlement/i);
    const txStep = walkthroughFor('Reporting entity').find((s) => s.screen === 'transactions');
    expect(txStep?.body).toMatch(/expanded register row/i);
  });
});
