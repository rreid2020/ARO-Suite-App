/**
 * Screen router.
 *
 * Deliberately a lookup rather than a URL router: the prototype is one page and
 * the port keeps that shape, but every screen is a plain component so dropping
 * in the target codebase's own router is a change to this file alone.
 */

import React from 'react';
import { useStore, useTenant, useUnitData } from '../../core/store';
import { stepById } from '../../core/nav';
import { DOMAINS } from '../../core/authority';
import { Empty, ReadOnlyBanner } from '../components';
import { Register } from './Register';
import { Units, Curves, Users, Company, Frameworks, Authority, ChangeLog, AuditTrail, Portal } from './tenant';
import { Periods, Intake, Normalise, Match, Conversion, Scope } from './prepare';
import { Cost, Adjust, Layers, Arc, Ledger, Recalc } from './measure';
import { Calendar, Reval, Settle, Journals, Batches, Recon } from './close';
import { Rollf, Py, Sens } from './report';
import { Freeze, Sampling, Complete, Review } from './assure';

const SCREENS: Record<string, React.ComponentType> = {
  // Tenant scope
  units: Units, curves: Curves, users: Users, company: Company,
  frameworks: Frameworks, authority: Authority, changelog: ChangeLog,
  audit: AuditTrail, portal: Portal,
  // Prepare
  periods: Periods, intake: Intake, conversion: Conversion,
  normalise: Normalise, match: Match, scope: Scope,
  // Measure
  register: Register, cost: Cost, adjust: Adjust, layers: Layers,
  arc: Arc, ledger: Ledger, recalc: Recalc,
  // Close
  calendar: Calendar, reval: Reval, settle: Settle,
  journals: Journals, batches: Batches, recon: Recon,
  // Report
  rollf: Rollf, py: Py, sens: Sens,
  // Assure
  freeze: Freeze, sampling: Sampling, complete: Complete, review: Review,
};

export function Screen() {
  const { state, ui } = useStore();
  const tenant = useTenant();
  const data = useUnitData();
  const Component = SCREENS[ui.screen];

  if (!Component) return <Empty>That screen does not exist.</Empty>;

  const step = stepById(ui.screen);
  // A step needs a reporting unit; a firm screen does not.
  if (step && !data) return <Empty>Open a reporting unit to reach this step.</Empty>;

  // The authority mode is surfaced before the screen renders, so a user knows
  // why a write will be refused before they attempt it. The refusal itself
  // still comes from the write path — this is a courtesy, not the control.
  let banner: string | null = null;
  if (step && tenant) {
    const mode = state.authority[tenant.id][step.domain];
    if (mode !== 'We own it') {
      const d = DOMAINS.find((x) => x.id === step.domain)!;
      banner = `${d.label} is set to "${mode}" for ${tenant.name}, so writes on this step are refused at the data layer. ${d.covers}`;
    }
  }

  return (
    <>
      {banner && <ReadOnlyBanner reason={banner} />}
      <Component />
    </>
  );
}
