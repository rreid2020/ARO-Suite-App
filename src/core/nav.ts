/**
 * Navigation — SCREENS.md.
 *
 * Three scopes: install, tenant (firm), reporting unit. The reporting-unit
 * scope is a 26-step workflow in five phases.
 *
 * "An auditor tenancy sees eight of these: intake, normalisation, freeze,
 * recalculation, event ledger, sampling, completeness pack, review. A firm does
 * not run the client's ARO process — it tests it."
 */

import { Domain } from './authority';

export interface StepDef {
  id: string;
  label: string;
  phase: 'Prepare' | 'Measure' | 'Close' | 'Report' | 'Assure';
  /** The one-line purpose shown in the header strip. */
  purpose: string;
  /** The authority domain a write on this step lands in. */
  domain: Domain;
  /** Steps an auditor tenancy sees. */
  auditor?: boolean;
}

export const STEPS: StepDef[] = [
  // ── Prepare ────────────────────────────────────────────────────────────
  { id: 'periods', label: 'Periods & close', phase: 'Prepare', domain: 'periods',
    purpose: 'The reporting unit\'s own fiscal calendar and the status of every period in it.' },
  { id: 'intake', label: 'Data intake', phase: 'Prepare', domain: 'register', auditor: true,
    purpose: 'Files received, with who sent them, when, and the hash of what arrived.' },
  { id: 'conversion', label: 'Opening balances', phase: 'Prepare', domain: 'register',
    purpose: 'Load the legacy closing balance onto the obligations it belongs to, and agree it.' },
  { id: 'normalise', label: 'Import normalisation', phase: 'Prepare', domain: 'register', auditor: true,
    purpose: 'Map an extract onto the engine\'s vocabulary and turn it into period-stamped events.' },
  { id: 'match', label: 'Match & link', phase: 'Prepare', domain: 'register',
    purpose: 'Link incoming rows to obligations by rule, and hold anything ambiguous for a person.' },
  { id: 'scope', label: 'ARO scoping', phase: 'Prepare', domain: 'register',
    purpose: 'Which obligations are in scope for measurement, and the recorded reason for anything that is not.' },

  // ── Measure ────────────────────────────────────────────────────────────
  { id: 'register', label: 'ARO register', phase: 'Measure', domain: 'register',
    purpose: 'Every obligation, its inputs and what the engine makes of them.' },
  { id: 'cost', label: 'Cost estimates', phase: 'Measure', domain: 'estimates',
    purpose: 'The cost build-up behind one obligation, line by line, and the ladder from it to the provision.' },
  { id: 'adjust', label: 'Adjustments', phase: 'Measure', domain: 'estimates',
    purpose: 'Recorded revisions to cost and to expected timing, each with its reason and evidence.' },
  { id: 'layers', label: 'Layers & framework', phase: 'Measure', domain: 'assumptions',
    purpose: 'The framework in force and what it does to the measurement.' },
  { id: 'arc', label: 'Retirement cost asset', phase: 'Measure', domain: 'estimates',
    purpose: 'The asset recognised alongside the provision, and its depreciation.' },
  { id: 'ledger', label: 'Event ledger', phase: 'Measure', domain: 'register', auditor: true,
    purpose: 'The append-only record of everything that moved, period by period.' },
  { id: 'recalc', label: 'Recalculation', phase: 'Measure', domain: 'assumptions', auditor: true,
    purpose: 'The engine\'s figure against the source figure, obligation by obligation, with the cause of every difference.' },

  // ── Close ──────────────────────────────────────────────────────────────
  { id: 'calendar', label: 'Close calendar', phase: 'Close', domain: 'periods',
    purpose: 'The close tasks for the period, who owns them and which working day they are due.' },
  { id: 'reval', label: 'Year-end revaluation', phase: 'Close', domain: 'assumptions',
    purpose: 'Apply the closing rate table to the whole population. A change in estimate, not accretion.' },
  { id: 'settle', label: 'Settlements', phase: 'Close', domain: 'estimates',
    purpose: 'Provisions released against actual spend, full or partial, with the overrun or write-back.' },
  { id: 'journals', label: 'Journals', phase: 'Close', domain: 'journals',
    purpose: 'The entries the engine emits from the event ledger, and where each one posts.' },
  { id: 'batches', label: 'Journal batches', phase: 'Close', domain: 'journals',
    purpose: 'Batches per period: approve, post, and reverse. A posted batch is immutable.' },
  { id: 'recon', label: 'GL reconciliation', phase: 'Close', domain: 'journals',
    purpose: 'The ARO sub-ledger against the provision accounts in the general ledger.' },

  // ── Report ─────────────────────────────────────────────────────────────
  { id: 'rollf', label: 'Roll-forward & disclosure', phase: 'Report', domain: 'register',
    purpose: 'Opening to closing, per period and for the year, and the note generated from it.' },
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
    purpose: 'The pack: population, recalculation, variance, roll-forward and the signed statement.' },
  { id: 'review', label: 'Review & sign-off', phase: 'Assure', domain: 'evidence', auditor: true,
    purpose: 'Three-stage sign-off and the year-end lock sequence.' },
];

export const PHASES = ['Prepare', 'Measure', 'Close', 'Report', 'Assure'] as const;

export function stepsFor(kind: string): StepDef[] {
  return kind === 'Auditor' ? STEPS.filter((s) => s.auditor) : STEPS;
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
  { id: 'units', label: 'Reporting units', purpose: 'The list, with status, stage and outstanding prerequisites.' },
  { id: 'curves', label: 'Curve library', purpose: 'Discount curves, their published points, and where each one came from.' },
  { id: 'users', label: 'Users & roles', purpose: 'Who can do what in this tenant. The role list is fixed.' },
  { id: 'company', label: 'Company settings', purpose: 'Reference data the organisation owns: accounts, coding, posting rules, templates.' },
  { id: 'frameworks', label: 'Frameworks', purpose: 'The four reporting frameworks, their policy axes and what the engine does with each.' },
  { id: 'authority', label: 'Authority & security', purpose: 'Which of the six domains this tenant is the authority for, and the security posture.' },
  { id: 'changelog', label: 'Change log', purpose: 'Field-level history: field, record, before and after, with restore.' },
  { id: 'audit', label: 'Audit trail', purpose: 'Actor, action, kind, detail and timestamp — including every refused write.' },
  { id: 'portal', label: 'Client portal', purpose: 'The read-only request list the client sees.' },
];
