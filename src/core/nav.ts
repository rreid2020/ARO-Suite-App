/**
 * Navigation — SCREENS.md.
 *
 * Three scopes: install, tenant (firm), reporting unit. The reporting-unit
 * scope is a workflow in six phases, starting with Unit settings before Prepare.
 *
 * "An auditor tenancy sees seven of these: intake, normalisation, freeze,
 * event ledger, sampling, completeness pack, review. A firm does
 * not run the client's ARO process — it tests it."
 */

import { Domain } from './authority';
import { SetupStepId } from './types';
import type { AppState, ReportingUnit } from './types';
import { unitNeedsDiscountCurve, unitSetupComplete } from './createUnit';
import { unitHasUsableCurve } from './setup';
import { hasProvisionMapping, postingRulesReady } from './posting';

export interface StepDef {
  id: string;
  label: string;
  phase: 'Setup' | 'Prepare' | 'Measure' | 'Close' | 'Report' | 'Assure';
  /** The one-line purpose shown in the header strip. */
  purpose: string;
  /** The authority domain a write on this step lands in. */
  domain: Domain;
  /** Steps an auditor tenancy sees. */
  auditor?: boolean;
  /** When false, a reporting entity does not see this step. Default true. */
  firm?: boolean;
}

export const STEPS: StepDef[] = [
  // ── Setup ──────────────────────────────────────────────────────────────
  { id: 'unit-setup', label: 'Unit settings', phase: 'Setup', domain: 'assumptions',
    purpose: 'This reporting unit\'s framework, (for PSAS) whether it discounts, measurement assumptions and discount table. Company setup only names the entity, year end and currency.' },
  { id: 'unit-chart', label: 'Chart of accounts', phase: 'Setup', domain: 'journals',
    purpose: 'Import the organisation\'s GL for this reporting unit so posting scenarios can pick accounts. Extra columns from the file become coding-block segments.' },
  { id: 'unit-posting', label: 'Posting rules', phase: 'Setup', domain: 'journals',
    purpose: 'The engine posting cases (recognition, revision, accretion, settlement, sale) and the debit/credit roles they use. Asset classes each get a posting scenario where you assign this organisation\'s GLs to those roles.' },
  { id: 'periods', label: 'Periods & close', phase: 'Setup', domain: 'periods',
    purpose: 'This reporting unit\'s fiscal calendar and the status of every period in it. The calendar type is set on Unit settings; this step is the generated grid and late-data policy.' },
  { id: 'unit-opening', label: 'Opening register', phase: 'Setup', domain: 'register',
    purpose: 'Master TCA listing plus the obligation and ARO asset listing, linked by TCA asset number. Each obligation also carries an ARO asset number. Assets with a related obligation are in scope; mark every other asset In scope, Out of scope, or Undecided so there are no gaps. After the register agrees to the trial balance, lock opening balances. Later TCA listing changes belong on ARO scoping, not here.' },

  // ── Prepare ────────────────────────────────────────────────────────────
  { id: 'intake', label: 'Data intake', phase: 'Prepare', domain: 'register', auditor: true, firm: false,
    purpose: 'Files received, with who sent them, when, and the hash of what arrived.' },
  { id: 'normalise', label: 'Import normalisation', phase: 'Prepare', domain: 'register', auditor: true, firm: false,
    purpose: 'Map an extract onto the engine\'s vocabulary and turn it into period-stamped events.' },
  { id: 'recalc-import', label: 'Source extracts', phase: 'Prepare', domain: 'register', auditor: true, firm: false,
    purpose: 'Read the source system’s own extracts — REP04 cost estimates, REP06 settlement dates and reported FV/PV, and the client interest rate curve. Every file is mapped column by column and previewed before anything is written: the sheet, the header row and the column mapping are all guesses, and each one is a place a silent import puts the wrong number in front of a reviewer. REP04 merges by obligation number rather than replacing, because each obligation type is a separate run.' },
  { id: 'recalc-source', label: 'Imported data', phase: 'Prepare', domain: 'register', auditor: true, firm: false,
    purpose: 'The extracts as they were read, with the mapped columns marked, so a reader can tie every figure in the recalculation back to a row in the original workbook.' },
  { id: 'scope', label: 'ARO scoping', phase: 'Prepare', domain: 'register',
    purpose: 'After opening lock, this is the current master TCA listing. Load an updated listing and compare it both ways with the ARO register. New assets are scoped In, Out, or Undecided; in-scope assets get a new obligation and ARO asset. Disposed TCAs retire linked ARO rows; Unproductive TCAs flag the ARO asset so later estimate changes go to expense. Obligations whose TCA is missing, and remaining UL that no longer matches the listing, are actions too. These changes do not rewrite the opening register.' },

  // ── Measure ────────────────────────────────────────────────────────────
  { id: 'register', label: 'ARO register', phase: 'Measure', domain: 'register',
    purpose: 'Select a fiscal year and period. Opening is the prior-year closing; in-year columns are posted journal amounts through that period; closing is as at the period end. A period with no new postings carries the prior closing forward. Open a row to expand monthly accretion and amortization schedules, the discount curve, calculation details and adjustments.' },
  { id: 'layers', label: 'Layers & framework', phase: 'Measure', domain: 'assumptions',
    purpose: 'How the framework in force — set on Unit settings — shapes the measurement, and the layers it produces.' },
  { id: 'recalculation', label: 'Recalculation', phase: 'Measure', domain: 'register', auditor: true, firm: false,
    purpose: 'The independent recalculation, obligation by obligation: the cost estimate escalated to the year end, escalated again to settlement, then discounted back at the rate the curve gives for the rounded term. Open a row for the same calculation written as Excel — paste the column into a blank sheet and every figure here reproduces, unaided.' },
  { id: 'recalc-compare', label: 'Source comparison', phase: 'Measure', domain: 'register', auditor: true, firm: false,
    purpose: 'The recalculation against the figures the source system reported, obligation by obligation and in total, tested against tiered materiality. The trial-balance control total sits here too: agreeing the extract to an independently sourced total is what proves the population complete — without it a perfect recalculation of half the balance still reads clean.' },
  { id: 'ledger', label: 'Event ledger', phase: 'Measure', domain: 'register', auditor: true,
    purpose: 'The append-only record of everything that moved, period by period.' },

  // ── Close ──────────────────────────────────────────────────────────────
  { id: 'calendar', label: 'Close calendar', phase: 'Close', domain: 'periods',
    purpose: 'The close tasks for the period, who owns them and which working day they are due. Accretion and amortization are run from Month-end posting, not by ticking these rows.' },
  { id: 'month-end', label: 'Month-end posting', phase: 'Close', domain: 'journals',
    purpose: 'After in-period new ARO, cost and term postings, allocate accretion and amortization for the open period as two separate runs. Opening the period is not a posting trigger.' },
  { id: 'reval', label: 'Year-end revaluation', phase: 'Close', domain: 'assumptions',
    purpose: 'Apply the closing rate table to the whole population. A change in estimate, not accretion.' },
  { id: 'settle', label: 'Settlements', phase: 'Close', domain: 'estimates',
    purpose: 'True-up the estimate to actual spend, then consume the provision. Full or partial. Retire the ARO asset on a full settlement, or extinguish the obligation if the related asset was sold. Map Cash to cash or AP on the posting scenario.' },
  { id: 'journals', label: 'Journals', phase: 'Close', domain: 'journals',
    purpose: 'The entries the engine emits from the event ledger, and where each one posts.' },
  { id: 'batches', label: 'Journal batches', phase: 'Close', domain: 'journals',
    purpose: 'Package the open period\'s ledger into a batch after month-end accretion and amortization have been allocated. Open a batch to inspect the journal entry by GL account, then drill into obligation lines. A preparer approves; a reviewer or partner posts. Approving is not posting. A posted batch is immutable.' },
  { id: 'recon', label: 'GL reconciliation', phase: 'Close', domain: 'journals',
    purpose: 'The ARO sub-ledger against the provision accounts in the general ledger.' },

  // ── Report ─────────────────────────────────────────────────────────────
  { id: 'rollf', label: 'Roll-forward & disclosure', phase: 'Report', domain: 'register',
    purpose: 'Opening balances, then in-year activity: settlement, accretion on existing ARO, change of estimate on existing ARO (cost, term, write-offs, year-end mass update), new ARO and accretion on new ARO. The event-ledger identity still foots per period and for the year.' },
  { id: 'py', label: 'Comparatives', phase: 'Report', domain: 'register',
    purpose: 'This year against last, with the movement explained.' },
  { id: 'sens', label: 'Sensitivity', phase: 'Report', domain: 'assumptions',
    purpose: 'What the provision does when the discount rate, inflation or timing moves.' },

  // ── Assure ─────────────────────────────────────────────────────────────
  { id: 'freeze', label: 'Evidence & freeze', phase: 'Assure', domain: 'evidence', auditor: true,
    purpose: 'Freeze the dataset as a version. A re-import is a new version with a diff, never an edit.' },
  { id: 'sampling', label: 'Sampling & tickmarks', phase: 'Assure', domain: 'evidence', auditor: true,
    purpose: 'Select a sample with a logged method, size and seed, and tick off what has been tested.' },
  { id: 'complete', label: 'Completeness pack', phase: 'Assure', domain: 'evidence', auditor: true,
    purpose: 'The pack: population, roll-forward and the signed statement.' },
  { id: 'recalc-exceptions', label: 'Exceptions & clearance', phase: 'Assure', domain: 'evidence', auditor: true, firm: false,
    purpose: 'Everything standing between the register and a finalised recalculation. Nothing here is a checkbox: each item reads live state and computes its own pass/fail, so it clears when the data that caused it changes and not before. A blocker means the recalculation cannot be concluded; a review means it needs an explanation on file first.' },
  { id: 'recalc-variance', label: 'Variance & sign-off', phase: 'Assure', domain: 'evidence', auditor: true, firm: false,
    purpose: 'Why one obligation differs from what the source system reported, in two steps that sum to the variance exactly. The source publishes three figures and none of its assumptions, so its rates are back-solved over the recalculated terms — an implied rate absorbs everything in its leg, which is why the FV variance is reported separately.' },
  { id: 'review', label: 'Review & sign-off', phase: 'Assure', domain: 'evidence', auditor: true,
    purpose: 'Three-stage sign-off and the year-end lock sequence.' },
];

export const PHASES = ['Setup', 'Prepare', 'Measure', 'Close', 'Report', 'Assure'] as const;

export function stepsFor(kind: string): StepDef[] {
  return kind === 'Auditor' ? STEPS.filter((s) => s.auditor) : STEPS.filter((s) => s.firm !== false);
}

/** First step when opening a unit: unfinished Setup (including periods), then Prepare. */
export function unitLandingScreen(kind: string, state?: AppState, unit?: ReportingUnit): string {
  const steps = stepsFor(kind);
  if (kind === 'Auditor') return steps.find((s) => s.phase === 'Prepare')?.id ?? steps[0]?.id ?? 'intake';
  if (unit && state && !unitSetupComplete(state, unit)) {
    const settings = state.settings[unit.tenantId];
    if (unitNeedsDiscountCurve(unit) && !unitHasUsableCurve(state, unit.tenantId, unit.curveId)) return 'unit-setup';
    if (!settings || !hasProvisionMapping(settings, unit.tenantId)) return 'unit-chart';
    if (!postingRulesReady(settings)) return 'unit-posting';
    return 'unit-opening';
  }
  return steps.find((s) => s.phase === 'Prepare')?.id ?? steps[0]?.id ?? 'scope';
}

export const stepById = (id: string) => STEPS.find((s) => s.id === id);

/** Tenant-scope screens — SCREENS.md, "Tenant scope". */
export interface FirmNavDef {
  id: string;
  label: string;
  purpose: string;
  /** Only a firm admin reaches these. */
  adminOnly?: boolean;
}

export const FIRM_NAV: FirmNavDef[] = [
  { id: 'howto', label: 'How to use it', purpose: 'The five-minute path through this tenant’s workflow, and a 30-second walkthrough on the live screens. Skip whenever you like — it is not a wizard you cannot leave.' },
  { id: 'setup', label: 'Company setup', purpose: 'Name each reporting unit (entity, year end, currency), then people, authority, the framework catalogue, measurement defaults, cost-estimate templates and the curve library. Open a unit to set measurement, chart, posting, the fiscal calendar and the opening register before Prepare.' },
  { id: 'changelog', label: 'Change log', purpose: 'Field-level history: field, record, before and after, with restore.' },
  { id: 'audit', label: 'Audit trail', purpose: 'Actor, action, kind, detail and timestamp — including every refused write.' },
  { id: 'portal', label: 'Client portal', purpose: 'The read-only request list the client sees.' },
];

/**
 * Former Firm screens now live inside company setup. A leftover screen id
 * (persisted UI, an old deep link) opens the wizard at the matching step
 * rather than a second settings UI.
 */
export const FIRM_SETUP_ALIASES: Record<string, SetupStepId> = {
  units: 'unit',
  users: 'users',
  authority: 'authority',
  frameworks: 'frameworks',
  company: 'unit',
  curves: 'curve',
};

export function resolveFirmNavId(screen: string): string {
  return FIRM_SETUP_ALIASES[screen] ? 'setup' : screen;
}

/** Leftover reporting-unit screen ids. Recalculation compared the engine to an
 *  external source figure; this product is the source system, so that step is
 *  gone. Cost estimates, adjustments and the retirement-cost sub-ledger now
 *  expand under the register row. A persisted id opens the register rather
 *  than a second UI. */
export const UNIT_SCREEN_ALIASES: Record<string, string> = {
  recalc: 'register',
  cost: 'register',
  adjust: 'register',
  arc: 'register',
};

export function resolveUnitScreen(screen: string): string {
  return UNIT_SCREEN_ALIASES[screen] ?? screen;
}
