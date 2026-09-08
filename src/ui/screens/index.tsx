/**
 * Screen router.
 *
 * Deliberately a lookup rather than a URL router: the prototype is one page and
 * the port keeps that shape, but every screen is a plain component so dropping
 * in the target codebase's own router is a change to this file alone.
 */

import React from 'react';
import { useStore, useTenant, useUnitData } from '../../core/store';
import { stepById, resolveUnitScreen } from '../../core/nav';
import { DOMAINS } from '../../core/authority';
import { Empty, ReadOnlyBanner } from '../components';
import { Register } from './Register';
import { ChangeLog, AuditTrail, Portal } from './tenant';
import { Setup } from './setup';
import { UnitChart, UnitPosting, UnitSetup, UnitOpening } from './unitSetup';
import { Periods, Intake, Normalise } from './prepare';
import { Scope } from './scoping';
import { Layers, Ledger } from './measure';
import { Calendar, MonthEnd, Reval, Settle, Journals, Batches, Recon } from './close';
import { Rollf, Py, Sens } from './report';
import { Freeze, Sampling, Complete, Review } from './assure';
import { RecalcImport, RecalcSource, Recalculation, RecalcCompare, RecalcExceptions, RecalcVariance } from './recalc';

const SCREENS: Record<string, React.ComponentType> = {
  // Tenant scope. Former Firm screens (units, curves, users, company,
  // frameworks, authority) render Setup — FIRM_SETUP_ALIASES maps them to a step.
  units: Setup, setup: Setup,
  curves: Setup, users: Setup, company: Setup, frameworks: Setup, authority: Setup,
  changelog: ChangeLog, audit: AuditTrail, portal: Portal,
  'unit-setup': UnitSetup,
  'unit-chart': UnitChart,
  'unit-posting': UnitPosting,
  'unit-opening': UnitOpening,
  // Leftover Prepare ids: conversion and match are the old extract/match
  // flow. They open the Setup opening register rather than a second UI.
  conversion: UnitOpening, match: UnitOpening,
  // Leftover Measure ids `recalc`, `cost`, `adjust`, `arc` resolve to register.
  // Opening an obligation expands under the register row; there is no separate
  // obligation screen.
  // Prepare
  periods: Periods, intake: Intake,
  normalise: Normalise, scope: Scope,
  // Mode 1 — recalculation & completeness. Auditor tenancy only: a reporting
  // entity running this product as its module of record is the source system,
  // so it has nothing to recalculate against (see nav.ts, UNIT_SCREEN_ALIASES).
  'recalc-import': RecalcImport, 'recalc-source': RecalcSource,
  recalculation: Recalculation, 'recalc-compare': RecalcCompare,
  'recalc-exceptions': RecalcExceptions, 'recalc-variance': RecalcVariance,
  // Measure
  register: Register, layers: Layers, ledger: Ledger,
  // Close
  calendar: Calendar, 'month-end': MonthEnd, reval: Reval, settle: Settle,
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
  const screen = resolveUnitScreen(ui.screen);
  const Component = SCREENS[screen];

  if (!Component) return <Empty>That screen does not exist.</Empty>;

  const step = stepById(screen);
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
