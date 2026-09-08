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
import type { RecalcRegister } from './recalc';

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
  /** True until they have signed in with Clerk and claimed this email. */
  pendingInvite?: boolean;
  /** True when Clerk currently has an active session for this user. */
  sessionActive?: boolean;
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
  /**
   * When this reporting unit's own settings (framework, assumptions, curve)
   * were confirmed. Until then, Open lands on Unit settings rather than Prepare.
   * A unit that has already started is treated as complete even if this is empty.
   */
  setupCompletedAt?: string | null;
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
  /** US GAAP / ASPE: how a downward cost revision consumes stored layers. Default LIFO. */
  layerPolicy?: 'LIFO' | 'FIFO' | 'Pro-rata';
  /** PSAS: false dispenses with discounting (and then inflation). Default true. */
  discount?: boolean;
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
  /**
   * Extra columns from the organisation's chart file, keyed by the file's
   * own headings. Shape varies by tenant — there is no fixed coding layout.
   */
  columns: Record<string, string>;
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

/**
 * A named mapping of engine roles onto imported GLs. One organisation can
 * hold several (wells vs plant) because their chart often has more than one
 * provision and more than one retirement-cost asset.
 */
export interface PostingScenario {
  id: string;
  tenantId: string;
  name: string;
  isDefault: boolean;
  /** engineRole → account id from the imported chart. */
  accounts: Record<string, string>;
  /** Engine roles the user has marked complete on this scenario. Survives leaving the step. */
  completedRoles: string[];
}

/** Organisation asset class. Each class has its own posting scenario. */
export interface AroAssetClass {
  id: string;
  tenantId: string;
  /** Organisation class code (ANLKL / asset class code). Empty when the class is name-only. */
  code?: string;
  name: string;
  scenarioId: string;
}

/** Scope of a row on the master TCA listing. Completeness is at asset level. */
export type TcaScope = 'In scope' | 'Scoped out' | 'Undecided';

/** Operational status of a tangible capital asset. */
export type TcaAssetStatus = 'Active' | 'Unproductive' | 'Disposed';

/**
 * One row on the master tangible-capital-asset listing. Obligation `assetId`
 * is the TCA asset number and matches `assetNumber`. `aroAssetNumber` on the
 * obligation is the retirement-cost asset identifier, a different number.
 */
export interface TcaAsset {
  id: string;
  assetNumber: string;
  description: string;
  assetClass: string;
  acquisitionDate: string;
  site: string;
  /** Gross acquisition / capitalized cost of the TCA. */
  acquisitionCost: number | null;
  /** Accumulated amortization of the TCA (not the ARO asset). */
  accumAmort: number | null;
  /** Total useful life of the TCA, in years. Defaults the ARO asset Total UL on a new obligation. */
  totalUl: number | null;
  /** Life already consumed on the TCA, in years. Defaults the ARO asset Expired UL on a new obligation. */
  expiredUl: number | null;
  /** Active until marked Unproductive or Disposed. Independent of ARO-asset inProductiveUse. */
  assetStatus: TcaAssetStatus;
  scope: TcaScope;
  scopeReason: string;
  /** Extra file columns, keyed by the organisation's own headings. */
  columns: Record<string, string>;
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
  /** Take the retirement-cost asset off the books after a full settlement. */
  disposeAroAsset?: boolean;
  /** Related TCA sold — extinguish the provision; skip restoration spend. */
  relatedAssetSold?: boolean;
}

/**
 * Conversion listings frozen when opening balances are locked. Go-forward
 * TCA loads write `tcaAssets` and must not mutate this snapshot.
 */
export interface OpeningSnapshot {
  tcaAssets: TcaAsset[];
  obligationIds: string[];
  lockedAt: string;
  /** Asset-number keys present on the latest go-forward TCA file. */
  tcaFileKeys?: string[];
}

/** Everything held for one reporting unit. */
export interface UnitData {
  /** Current master TCA / PPE listing. Linked to obligations by asset number. */
  tcaAssets: TcaAsset[];
  /** Frozen conversion TCA listing and obligation ids. Set on lock. */
  openingSnapshot?: OpeningSnapshot | null;
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
  /** Year-end GL provision balance for close recon. null = not received. */
  glTotal: number | null;
  /** Opening trial-balance totals. The TB is not per obligation. */
  openingGlProvision: number | null;
  openingGlArc: number | null;
  /** Opening GL gross retirement-cost-asset (acquisition cost) and accum. NBV is cost minus accum. */
  openingGlAroCost: number | null;
  openingGlAroAccum: number | null;
  /** Opening GL totals for the master TCA listing recon. */
  openingGlTcaCost: number | null;
  openingGlTcaAccum: number | null;
  conversionAgreed: boolean;
  noteGenerated: boolean;
  yearLocked: boolean;
  /**
   * Mode 1 — the independent recalculation against the source system's own
   * figures. It sits alongside the obligations rather than inside them: the
   * register is what the *extracts* said, and the obligations are what this
   * unit measures. Reconciling the two is the product.
   */
  recalc: RecalcRegister;
}

export type SetupStepId =
  | 'users'
  | 'authority'
  | 'frameworks'
  | 'defaults'
  | 'estimates'
  | 'curve'
  | 'unit';

/** Persisted tenant onboarding — resumable across sessions. */
export interface TenantSetup {
  /** Last step the user was working on. */
  current: SetupStepId;
  savedAt: string;
  /** Accepting the measurement defaults is the only step that cannot be inferred from data. */
  defaultsConfirmedAt: string | null;
  completedAt: string | null;
}

export type EstimateColumnKind = 'text' | 'number' | 'percent' | 'currency';
export type EstimateColumnRole = 'label' | 'factor';

/** A template (or one-off estimate) column. Factors multiply into line amount. */
export interface EstimateColumn {
  id: string;
  label: string;
  kind: EstimateColumnKind;
  role: EstimateColumnRole;
}

export interface CostEstimateTemplateLine {
  description: string;
  qty: number;
  /** Blank at use when omitted. */
  rate: number | null;
  /** Values for custom columns, keyed by column id. */
  extra?: Record<string, string>;
}

/** Tenant-owned cost build-up reused when posting a new ARO. */
export interface CostEstimateTemplate {
  id: string;
  tenantId: string;
  name: string;
  /** When omitted, description / qty / unit rate. */
  columns?: EstimateColumn[];
  lines: CostEstimateTemplateLine[];
}

export interface TenantSettings {
  accounts: Account[];
  segments: CodingSegment[];
  postingRules: PostingRule[];
  postingScenarios: PostingScenario[];
  aroAssetClasses: AroAssetClass[];
  costEstimateTemplates?: CostEstimateTemplate[];
  frameworks: Framework[];
  /** Step defaults applied to a new reporting unit. */
  defaults: {
    inflation: number;
    contingency: number;
    dayCount: string;
    termConvention: string;
    calendarType: CalendarType;
    /** Framework copied onto a new reporting unit. Policy axes stay engine vocabulary. */
    frameworkId: string;
  };
  /** Company setup progress. Absent on tenants that predate the wizard — derived from live data. */
  setup?: TenantSetup | null;
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
