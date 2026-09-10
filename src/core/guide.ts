/**
 * How-to copy and the guided walkthrough.
 *
 * The page is a firm-scope screen so it stays reachable with or without a
 * reporting unit open. The walkthrough is not a second router: each step
 * opens an existing unit screen and the overlay sits on top. Skip, the
 * sidebar, and How to use it all leave it.
 */

import { stepById, stepsFor, unitLandingScreen } from './nav';
import type { AppState, ReportingUnit } from './types';

export interface GuidePillar {
  title: string;
  body: string;
}

export interface GuideMinute {
  title: string;
  body: string;
}

export interface GuideSection {
  id: string;
  title: string;
  body: string[];
}

export interface GuideFaq {
  q: string;
  a: string;
}

export interface WalkthroughStep {
  title: string;
  body: string;
  screen: string;
}

export interface Guide {
  kicker: string;
  intro: string[];
  pillars: GuidePillar[];
  fiveMinuteLead: string;
  fiveMinute: GuideMinute[];
  sections: GuideSection[];
  faq: GuideFaq[];
  data: string[];
  walkthrough: WalkthroughStep[];
}

const AUDITOR: Guide = {
  kicker: 'ARO recalculation',
  intro: [
    'Spreadsheet recalculations of asset retirement obligations bury the method in a thousand rows of DAYS360 and VLOOKUP. This tool does the same measurement in the browser: cost estimate escalated to the year end, escalated again to settlement, discounted back on the curve, compared to what was reported, and held until the exceptions are actually clear.',
    'It is not tied to a particular source system. Any workbook with the required columns can be imported — an extract you already have, or a sheet you fill yourself. The filename does not matter; the column mapping does.',
  ],
  pillars: [
    {
      title: 'What it is',
      body: 'An independent recalculation of ARO present and future values over the population in your extracts, with a completeness test against a trial-balance control total.',
    },
    {
      title: 'Why use it',
      body: 'Every derived figure is reproducible as Excel, the exception list reads live state rather than checkboxes, and nothing is written to the register until the mapping has been looked at.',
    },
    {
      title: 'How it works',
      body: 'Three workbooks in — cost estimates (REP04), reported FV/PV and settlement dates (REP06), interest rate curve — then the steps from import to sign-off. Seeded demo data is already in the register so you can click around before you import.',
    },
  ],
  fiveMinuteLead: 'If you only read one thing',
  fiveMinute: [
    {
      title: 'Templates',
      body: 'On Source extracts, choose each workbook — or use your own files if the columns are there. Confirm the column mapping. Nothing enters the register until you say so.',
    },
    {
      title: 'Imported data',
      body: 'The extracts as they were read, with the mapped columns marked, so every figure in the recalculation ties back to a row.',
    },
    {
      title: 'Results',
      body: 'Each obligation is escalated and discounted independently. Open a row for the Excel form of the same calc.',
    },
    {
      title: 'Compare',
      body: 'Reported FV and PV sit beside the recalculation. Enter the trial-balance total so the population is proven complete.',
    },
    {
      title: 'Clear',
      body: 'Blockers on Exceptions & clearance go when the data changes. Sign off on Variance & sign-off when they are gone, then Review & sign-off.',
    },
  ],
  sections: [
    {
      id: 'templates',
      title: '1. Get the templates',
      body: [
        'Three files, one job each. The names on the download are for you — the importer never looks at the filename. Save as .xlsx — older binary .xls files cannot be opened here. Use the organisation’s own extracts if the columns are already there.',
        'Cost estimates (REP04): obligation number, cost estimate, and cost estimate date.',
        'Reported values (REP06): obligation number, settlement date, and the FV and PV as reported.',
        'Interest rate curve: valid-on vintage, term in years, and rate. A client export often carries every vintage the system holds; the vintage matching the year end is offered first.',
      ],
    },
    {
      id: 'import',
      title: '2. Import any matching workbook',
      body: [
        'The file is opened in Source extracts and mapped column by column before anything is written. The sheet, the header row and every column are guesses, and each one is a place a silent import puts the wrong number in front of a reviewer.',
        'REP04 merges by obligation number rather than replacing, because each obligation type is a separate run. Cancel leaves the register untouched.',
      ],
    },
    {
      id: 'results',
      title: '3. Read the recalculation',
      body: [
        'Each obligation is cost estimate escalated to the year end, escalated again to settlement, then discounted back at the rate the curve gives for the rounded term.',
        'Open a row for the same calculation written as Excel — paste the column into a blank sheet and every figure here reproduces, unaided. Export the live workbook when you want working papers that stand on their own.',
      ],
    },
    {
      id: 'compare',
      title: '4. Compare and prove completeness',
      body: [
        'Source comparison puts the recalculation against the figures the source system reported, obligation by obligation and in total, tested against tiered materiality.',
        'The trial-balance control total sits here too. Agreeing the extract to an independently sourced total is what proves the population complete — without it a perfect recalculation of half the balance still reads clean.',
      ],
    },
    {
      id: 'clear',
      title: '5. Clear exceptions',
      body: [
        'Nothing on Exceptions & clearance is a checkbox. Each item reads live state and computes its own pass/fail, so it clears when the data that caused it changes and not before. A blocker means the recalculation cannot be concluded; a review means it needs an explanation on file first.',
        'Variance & sign-off explains why one obligation differs, in two steps that sum to the variance exactly. Review & sign-off is the three-stage conclusion once the blockers are gone.',
      ],
    },
  ],
  faq: [
    {
      q: 'Do I have to finish the walkthrough?',
      a: 'No. Skip, How to use it, or any sidebar step leaves it. Nothing here is a wizard you cannot leave.',
    },
    {
      q: 'Where do Data intake and Import normalisation sit?',
      a: 'Before Source extracts, when the engagement needs a received-file log and a mapped event stream. The recalculation itself starts when the extracts are mapped.',
    },
    {
      q: 'Does the filename or the source system matter?',
      a: 'No. Required fields are in the header row. Map the columns you have.',
    },
  ],
  data: [
    'The workbook is read in this page. Figures are written to this engagement’s register only when you import, and they stay on this tenant.',
    'Seeded obligations are illustrative until the real extracts replace them. A built-in curve is used until a client curve is imported; every figure derived from it is marked as such on the exception list.',
  ],
  walkthrough: [
    {
      title: 'The ten steps',
      body: 'Prepare, Measure, Assure — extracts in, independent recalculation, then exceptions and sign-off. You can jump to any step; nothing here is a wizard you cannot leave.',
      screen: 'recalc-import',
    },
    {
      title: 'Source extracts',
      body: 'Choose each workbook. Confirm the sheet, the header row and the column mapping. Nothing is written to the register until you import.',
      screen: 'recalc-import',
    },
    {
      title: 'Imported data',
      body: 'The extracts as they were read, with the mapped columns marked, so a reader can tie every figure in the recalculation back to a row.',
      screen: 'recalc-source',
    },
    {
      title: 'Recalculation',
      body: 'Each obligation is escalated and discounted independently. Open a row for the Excel form of the same calc.',
      screen: 'recalculation',
    },
    {
      title: 'Source comparison',
      body: 'Reported FV and PV sit beside the recalculation. The trial-balance total is what proves the population complete.',
      screen: 'recalc-compare',
    },
    {
      title: 'Exceptions & clearance',
      body: 'Blockers go when the data changes, not when a box is ticked. A blocker means the recalculation cannot be concluded.',
      screen: 'recalc-exceptions',
    },
    {
      title: 'Variance & sign-off',
      body: 'Why one obligation differs from what the source system reported, in two steps that sum to the variance exactly.',
      screen: 'recalc-variance',
    },
    {
      title: 'Review & sign-off',
      body: 'Three-stage sign-off once the blockers are gone. You can walk back through any step; the overlay is only a guide.',
      screen: 'review',
    },
  ],
};

const FIRM: Guide = {
  kicker: 'ARO Suite',
  intro: [
    'This product is the module of record for asset retirement obligations — not a recalculation against a figure some other system reported. Cost estimates, revisions, accretion, settlement and disclosure all live on the register for the reporting unit you have open.',
    'Company setup names the entity, the people and the reference data. Open a reporting unit to finish measurement, chart, posting and the opening register before Prepare.',
  ],
  pillars: [
    {
      title: 'What it is',
      body: 'The ARO sub-ledger: scoping, measurement, month-end posting and roll-forward, with an append-only change log and a three-stage sign-off.',
    },
    {
      title: 'Why use it',
      body: 'Opening agrees to the trial balance and is locked. Later TCA listing changes belong on ARO scoping, not a rewrite of opening. Journals come from the event ledger, not from a spreadsheet.',
    },
    {
      title: 'How it works',
      body: 'Setup the unit, load the opening register, scope the current population, measure in the period, post month-end accretion and amortization, then disclose the roll-forward.',
    },
  ],
  fiveMinuteLead: 'If you only read one thing',
  fiveMinute: [
    {
      title: 'Setup',
      body: 'Company setup names the unit. On the unit: measurement, chart of accounts, posting rules, then the opening TCA and obligation listings. Lock opening when it agrees to the trial balance.',
    },
    {
      title: 'Scope',
      body: 'On ARO scoping: current master TCA listing, current obligation listing, actions that keep the two in step, then the combined go-forward listing. New assets are In, Out, or Undecided; in-scope assets get a new obligation.',
    },
    {
      title: 'Measure',
      body: 'The ARO register is opening, in-year postings through the selected period, and closing. Open a row for schedules, the curve and calculation details.',
    },
    {
      title: 'Close',
      body: 'Month-end posting allocates accretion and amortization for the open period as two separate runs. Package the ledger into a batch; approving is not posting.',
    },
    {
      title: 'Disclose',
      body: 'Roll-forward & disclosure foots opening to closing by in-year activity. Comparatives and sensitivity sit beside it.',
    },
  ],
  sections: [
    {
      id: 'setup',
      title: '1. Set up the unit',
      body: [
        'Company setup is the tenant: reporting units, people, authority, frameworks, measurement defaults, cost-estimate templates and the curve library.',
        'On the unit itself: Unit settings (framework and whether it discounts), Chart of accounts, Posting rules, then Periods. Export the TCA and opening-register templates, fill them, and load them on Opening register. Lock opening when the register agrees to the trial balance.',
      ],
    },
    {
      id: 'scope',
      title: '2. Scope the current population',
      body: [
        'After opening lock, ARO scoping shows the current master TCA listing, the current obligation listing, the actions that keep those two listings in step, and the combined go-forward listing.',
        'New assets are scoped In, Out, or Undecided. In-scope assets get a new obligation and ARO asset. Total UL, Expired UL and Remaining UL are years and leftover months. Listing UL defaults onto the ARO asset; you can change those numbers on the ARO asset only. Remaining useful life is used after listing Expired UL matches life from the acquisition date to conversion; a newly acquired asset at conversion has zero expired UL. Expected settlement is suggested from remaining life and cannot be shorter.',
      ],
    },
    {
      id: 'register',
      title: '3. Read the register',
      body: [
        'Select a fiscal year and period. Opening is the prior-year closing; in-year columns are event-ledger amounts through that period — new ARO when you record it, accretion after month-end allocation. Closing is as at the period end.',
        'Open a row to expand monthly accretion and amortization, the discount curve, calculation details and adjustments. Cost estimates, revisions and the ARO asset live on the row — there is not a second screen for them.',
      ],
    },
    {
      id: 'close',
      title: '4. Close the period',
      body: [
        'After in-period new ARO, cost and term postings, Month-end posting allocates accretion and amortization as two separate runs. Opening the period is not a posting trigger.',
        'Package the open period’s ledger into a batch. A preparer approves; a reviewer or partner posts. A posted batch is immutable.',
      ],
    },
    {
      id: 'disclose',
      title: '5. Disclose the movement',
      body: [
        'Roll-forward & disclosure: opening, then settlement, accretion on existing ARO, change of estimate, new ARO and accretion on new ARO. The event-ledger identity still foots per period and for the year.',
      ],
    },
  ],
  faq: [
    {
      q: 'Do I have to finish the walkthrough?',
      a: 'No. Skip, How to use it, or any sidebar step leaves it. Nothing here is a wizard you cannot leave.',
    },
    {
      q: 'Where did Recalculation go?',
      a: 'A reporting entity running this product as its module of record has nothing to recalculate against — it is the source system. Independent recalculation of a client extract is an auditor-tenancy workflow.',
    },
    {
      q: 'Can I change opening after lock?',
      a: 'No. Later TCA listing changes belong on ARO scoping. Opening stays the agreed starting point.',
    },
  ],
  data: [
    'Writes go through a single path and are kept on this tenant’s register, change log and audit trail. A refused write is logged; it does not land.',
    'Authority is set per domain in Company setup. When a domain is not “We own it”, the screen says so before you try a write, and the write path still refuses it.',
  ],
  walkthrough: [
    {
      title: 'The work in order',
      body: 'Setup, Prepare, Measure, Close, Report — the register is the source, not a recalculation against someone else’s figure. You can jump to any step; nothing here is a wizard you cannot leave.',
      screen: 'unit-setup',
    },
    {
      title: 'Unit settings',
      body: 'This reporting unit’s framework, whether it discounts, measurement assumptions and discount table. Company setup only named the entity.',
      screen: 'unit-setup',
    },
    {
      title: 'Opening register',
      body: 'Master TCA listing plus the obligation and ARO asset listing, linked by TCA asset number. Lock opening when it agrees to the trial balance.',
      screen: 'unit-opening',
    },
    {
      title: 'ARO scoping',
      body: 'Current master TCA listing, current obligation listing, actions to keep the two in step, then the combined go-forward listing.',
      screen: 'scope',
    },
    {
      title: 'ARO register',
      body: 'Opening, in-year postings through the selected period, and closing. Open a row for schedules and calculation details.',
      screen: 'register',
    },
    {
      title: 'Month-end posting',
      body: 'Allocate accretion and amortization for the open period as two separate runs. Opening the period is not a posting trigger.',
      screen: 'month-end',
    },
    {
      title: 'Journal batches',
      body: 'Package the open period’s ledger after month-end has been allocated. Approving is not posting. A posted batch is immutable.',
      screen: 'batches',
    },
    {
      title: 'Roll-forward & disclosure',
      body: 'Opening, then in-year activity, footing to closing. You can walk back through any step; the overlay is only a guide.',
      screen: 'rollf',
    },
  ],
};

export function guideFor(kind: string): Guide {
  return kind === 'Auditor' ? AUDITOR : FIRM;
}

export function walkthroughFor(kind: string): WalkthroughStep[] {
  return guideFor(kind).walkthrough;
}

/** First walkthrough index that lives on this screen, keeping the current one if it already matches. */
export function tourIndexForScreen(kind: string, screen: string, current: number | null): number | null {
  const steps = walkthroughFor(kind);
  const matches: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].screen === screen) matches.push(i);
  }
  if (!matches.length) return null;
  if (current != null && matches.includes(current)) return current;
  return matches[0];
}

export function unitForGuide(
  state: AppState,
  tenantId: string,
  unitId: string | null,
): ReportingUnit | null {
  const units = state.units[tenantId] ?? [];
  return (unitId && units.find((u) => u.id === unitId)) || units[0] || null;
}

/** Open the documented tool — Source extracts for an auditor, the unit landing for a reporting entity. */
export function openToolTarget(
  kind: string,
  state: AppState,
  tenantId: string,
  unitId: string | null,
): { unitId: string | null; screen: string } {
  const unit = unitForGuide(state, tenantId, unitId);
  if (!unit) return { unitId: null, screen: 'setup' };
  const screen = kind === 'Auditor' ? 'recalc-import' : unitLandingScreen(kind, state, unit);
  return { unitId: unit.id, screen };
}

export function startWalkthroughTarget(
  kind: string,
  state: AppState,
  tenantId: string,
  unitId: string | null,
): { unitId: string; screen: string; tour: number } | { needUnit: true } {
  const unit = unitForGuide(state, tenantId, unitId);
  const first = walkthroughFor(kind)[0];
  if (!unit || !first) return { needUnit: true };
  return { unitId: unit.id, screen: first.screen, tour: 0 };
}

/** Every walkthrough screen must be a real step this tenant kind can open. */
export function walkthroughGaps(kind: string): string[] {
  const allowed = new Set(stepsFor(kind).map((s) => s.id));
  return walkthroughFor(kind)
    .filter((step) => !allowed.has(step.screen) || !stepById(step.screen))
    .map((step) => step.screen);
}
