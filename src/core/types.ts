/**
 * The domain model — DOMAIN-MODEL.md.
 *
 * "Engagement and reporting unit are the same object under two names — the
 * auditor tenancy calls it an engagement, the reporting entity calls it a
 * reporting unit. Keep one table; vary the label by tenant kind."
 */

import { Curve } from '../engine/curve';
import { CostLine, Obligation, Revision } from '../engine/derive';
import { ObligationEvent } from '../engine/rollforward';
import { AuthorityMode, Domain, TenantKind } from './authority';
import { AttestedGate } from './gates';
import { CalendarType, LatePolicy, Period } from './periods';
import { AuditEvent, ChangeEntry } from './writePath';

export type { CostLine, Obligation, Revision, ObligationEvent, Curve, Period };

export interface Tenant {
  id: string;
  name: string;
  kind: TenantKind;
  env: string;
  domain: string;
  createdAt: string;
  /** User-created tenants carry a delete; the seeded ones do not. */
  custom?: boolean;
}

export interface User {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: string;
  mfa: 'Enrolled' | 'Not enrolled' | 'Enforced by SSO';
  /** The person who provisioned the tenant. Administers it until they appoint
   *  a firm admin — INVARIANTS §7. */
  isOwner?: boolean;
  lastSeen?: string;
}

/** The four modelled frameworks — README decision 2. */
export interface Framework {
  id: string;
  name: string;
  /** Ten policy axes. */
  axes: Record<string, string>;
  /** What the engine actually does differently under this framework. */
  engineEffects: string[];
  /** Whether the engine currently reads the assignment for this axis. */
  wired: boolean;
}

export interface ReportingUnit {
  id: string;
  tenantId: string;
  entity: string;
  client: string;
  fyEnd: string;
  currency: string;
  sector: string;
  partnerUserId: string;
  frameworkId: string;
  jurisdiction: string;
  calendarType: CalendarType;
  latePolicy: LatePolicy;
  status: string;
  stage: string;
  /** Assumptions live with the unit — INVARIANTS §9. */
  inflation: number;
  contingency: number;
  curveId: string;
  priorCurveId?: string;
  priorInflation?: number;
  revaluedOn?: string;
  termConvention: string;
  materialityUsd: number;
  materialityPct: number;
  extrapolationPolicy: string;
  dayCount: string;
}

export interface Account {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  cls: string;
  /**
   * The join between the organisation's chart and the engine — DOMAIN-MODEL.
   * "The engine never posts to a hard-coded account code."
   */
  engineRole: string;
  requiredSegments: string[];
}

export interface CodingSegment {
  id: string;
  tenantId: string;
  ord: number;
  name: string;
  required: boolean;
  permitted: string[];
}

export interface PostingRule {
  id: string;
  tenantId: string;
  eventType: string;
  debitRole: string;
  creditRole: string;
  engineEmitted: boolean;
}

export interface Extract {
  id: string;
  unitId: string;
  kind: string;
  filename: string;
  hash: string;
  rows: number;
  receivedAt: string;
  /** Declared by the person loading it. Drives normalisation. */
  declared: 'cumulative' | 'incremental';
  targetPeriodId: string;
  acceptedAt?: string;
  /** The source-system template applied. Only SAP is validated against live data. */
  template: string;
  templateValidated: boolean;
}

export interface JournalBatch {
  id: string;
  unitId: string;
  periodId: string;
  number: string;
  status: 'Draft' | 'Approved' | 'Posted' | 'Reversed';
  approvedBy?: string;
  postedBy?: string;
  reversedBy?: string;
  postedAt?: string;
  lines: JournalLine[];
  /** A reversal names the batch it reverses. */
  reverses?: string;
}

export interface JournalLine {
  ord: number;
  accountId: string;
  coding: Record<string, string>;
  debit: number;
  credit: number;
  obligationId?: string;
  eventId?: string;
  /** True when no posting rule matched and the line fell to suspense. */
  suspense?: boolean;
}

export interface Freeze {
  id: string;
  unitId: string;
  version: number;
  hash: string;
  population: number;
  total: number;
  createdAt: string;
  createdBy: string;
  /** Snapshot of the obligations at the moment of the freeze. */
  rows: { obligationId: string; ref: string; pv: number }[];
}

export interface Sample {
  id: string;
  freezeId: string;
  method: 'MUS' | 'Stratified' | 'Random';
  size: number;
  seed: number;
  createdBy: string;
  createdAt: string;
  picked: string[];
}

export interface Tickmark {
  id: string;
  obligationId: string;
  freezeId: string;
  preparer?: string;
  reviewer?: string;
  markedAt?: string;
  note?: string;
}

export interface Signature {
  stage: 'Preparer' | 'Reviewer' | 'Partner';
  by: string;
  at: string;
  /** Hashed from the register, assumptions, curve and policy — INVARIANTS §6. */
  recalcStamp: string;
}

export interface Settlement {
  id: string;
  obligationId: string;
  kind: 'Full' | 'Partial';
  pct: number;
  actualCost: number;
  settledOn: string;
  posted: boolean;
}

/** Everything held for one reporting unit. */
export interface UnitData {
  obligations: Obligation[];
  events: ObligationEvent[];
  extracts: Extract[];
  batches: JournalBatch[];
  settlements: Settlement[];
  freezes: Freeze[];
  samples: Sample[];
  tickmarks: Tickmark[];
  signatures: Signature[];
  periods: Period[];
  attestedGates: AttestedGate[];
  /** GL balance received for the reconciliation. null = not received. */
  glTotal: number | null;
  conversionAgreed: boolean;
  noteGenerated: boolean;
  yearLocked: boolean;
}

export interface TenantSettings {
  accounts: Account[];
  segments: CodingSegment[];
  postingRules: PostingRule[];
  frameworks: Framework[];
  /** Step defaults applied to a new reporting unit. */
  defaults: {
    inflation: number;
    contingency: number;
    dayCount: string;
    termConvention: string;
    calendarType: CalendarType;
  };
  retentionYears: number;
  legalHold: boolean;
  sso: boolean;
  scim: boolean;
}

/** The whole application state. */
export interface AppState {
  tenants: Tenant[];
  users: User[];
  curves: Record<string, Curve[]>;
  units: Record<string, ReportingUnit[]>;
  data: Record<string, UnitData>;
  settings: Record<string, TenantSettings>;
  authority: Record<string, Record<Domain, AuthorityMode>>;
  /** Append-only. Write-once tables — INVARIANTS §2. */
  chg: ChangeEntry[];
  log: AuditEvent[];
}

/** Client UI state. Genuinely client-side — README's state mapping table. */
export interface UiState {
  signedIn: boolean;
  userName: string;
  role: string;
  tenantId: string | null;
  unitId: string | null;
  screen: string;
  tab: string;
  sub: string;
  /** The return banner — naming the unit and prerequisite you left to fix. */
  setupTrail: { unitId: string; screen: string; label: string; note: string } | null;
  toast: { kind: 'ok' | 'refused'; text: string } | null;
}
