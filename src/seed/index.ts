/**
 * Synthetic seed data.
 *
 * README, "Assets": "Numbers, entity names and extract data in the prototype are
 * synthetic seed data, generated per tenant — none of it is client data and none
 * of it should ship." Everything below is generated from a fixed PRNG seed so
 * the demo is reproducible; nothing here came from the client workbook.
 */

import { Curve } from '../engine/curve';
import { buildCalendar } from '../core/periods';
import { defaultAuthority } from '../core/authority';
import {
  Account, AppState, CodingSegment, Framework, Obligation, ObligationEvent,
  PostingRule, ReportingUnit, Tenant, TenantSettings, UnitData, User,
} from '../core/types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/* ── Reference data ─────────────────────────────────────────────────────── */

/** Engine roles the chart of accounts must fill — DOMAIN-MODEL. */
export const ENGINE_ROLES = [
  'ARO provision', 'Retirement cost asset', 'Accumulated depreciation',
  'Accretion expense', 'Depreciation expense', 'Operating costs',
  'Write-back to income', 'Cash', 'FX translation reserve', 'Suspense',
];

const ACCOUNTS: [string, string, string, string][] = [
  ['21500', 'Provision — asset retirement obligations', 'Liability', 'ARO provision'],
  ['16100', 'Retirement cost asset', 'Asset', 'Retirement cost asset'],
  ['16190', 'Accumulated depreciation — retirement cost asset', 'Asset', 'Accumulated depreciation'],
  ['74200', 'Accretion expense', 'Expense', 'Accretion expense'],
  ['74100', 'Depreciation — retirement cost asset', 'Expense', 'Depreciation expense'],
  ['61000', 'Site restoration operating costs', 'Expense', 'Operating costs'],
  ['48000', 'Write-back of surplus provision', 'Income', 'Write-back to income'],
  ['10100', 'Cash at bank', 'Asset', 'Cash'],
  ['32100', 'Foreign currency translation reserve', 'Equity', 'FX translation reserve'],
  ['99999', 'Suspense — unmapped ARO events', 'Liability', 'Suspense'],
];

const POSTING_RULES: [string, string, string][] = [
  ['addition', 'Retirement cost asset', 'ARO provision'],
  ['accretion', 'Accretion expense', 'ARO provision'],
  ['revision', 'Retirement cost asset', 'ARO provision'],
  ['settlement', 'ARO provision', 'Cash'],
  ['overrun', 'Operating costs', 'Cash'],
  ['surplus', 'ARO provision', 'Write-back to income'],
  ['depreciation', 'Depreciation expense', 'Accumulated depreciation'],
  ['fx', 'ARO provision', 'FX translation reserve'],
];

export const FRAMEWORKS: Framework[] = [
  {
    id: 'ifrs', name: 'IFRS (IAS 37)', wired: true,
    axes: {
      'Measurement basis': 'Best estimate of the expenditure required to settle',
      'Discount rate': 'Pre-tax rate reflecting current market assessments',
      'Rate per layer': 'No — a single current rate is applied to the whole obligation',
      'Revisions': 'Adjust the provision and the retirement cost asset',
      'Downward revision': 'Reduces the asset; any excess to profit or loss',
      'Discounting': 'Required where the effect is material',
      'Unwinding presented as': 'Finance cost',
      'Inflation': 'Consistent with the discount rate basis',
      'Constructive obligations': 'In scope',
      'Change in estimate': 'Prospective (IAS 8)',
    },
    engineEffects: [
      'A single discount rate, looked up on the closing curve, is applied to the whole obligation.',
      'Layers are derived for presentation only and do not carry their own rate.',
    ],
  },
  {
    id: 'usgaap', name: 'US GAAP (ASC 410-20)', wired: false,
    axes: {
      'Measurement basis': 'Fair value — expected present value technique',
      'Discount rate': 'Credit-adjusted risk-free rate at the date the layer arose',
      'Rate per layer': 'Yes — each upward revision carries the rate in force that day',
      'Revisions': 'Upward revision creates a new layer; downward removes layers',
      'Downward revision': 'Removes layers in the policy order',
      'Discounting': 'Required',
      'Unwinding presented as': 'Accretion expense (operating)',
      'Inflation': 'Built into the expected cash flows',
      'Constructive obligations': 'Narrower than IFRS',
      'Change in estimate': 'Prospective (ASC 250)',
    },
    engineEffects: [
      'NOT YET WIRED — layers must be stored, each accreting at its own rate for the rest of its life.',
      'This is decision 2 in the README and it changes the obligation and layer tables.',
    ],
  },
  {
    id: 'psas', name: 'PSAS (PS 3280)', wired: false,
    axes: {
      'Measurement basis': 'Estimate of the cost directly attributable to the retirement',
      'Discount rate': 'Entity-specific, or undiscounted where permitted',
      'Rate per layer': 'No',
      'Revisions': 'Adjust the liability and the related asset',
      'Downward revision': 'Reduces the asset',
      'Discounting': 'OPTIONAL — discounting may be dispensed with',
      'Unwinding presented as': 'Not applicable where undiscounted',
      'Inflation': 'Included where discounting is applied',
      'Constructive obligations': 'In scope',
      'Change in estimate': 'Prospective',
    },
    engineEffects: [
      'NOT YET WIRED — optional discounting. The engine currently always discounts.',
    ],
  },
  {
    id: 'aspe', name: 'ASPE (Section 3110)', wired: false,
    axes: {
      'Measurement basis': 'Fair value where determinable',
      'Discount rate': 'Credit-adjusted risk-free rate at the date the layer arose',
      'Rate per layer': 'Yes',
      'Revisions': 'Layer-based, as US GAAP',
      'Downward revision': 'Removes layers in the policy order',
      'Discounting': 'Required where fair value is used',
      'Unwinding presented as': 'Accretion expense',
      'Inflation': 'Built into the expected cash flows',
      'Constructive obligations': 'Legal obligations only',
      'Change in estimate': 'Prospective',
    },
    engineEffects: ['NOT YET WIRED — layers with a rate per layer, as US GAAP.'],
  },
];

export const SOURCE_TEMPLATES = [
  { name: 'SAP S/4HANA — asset retirement', validated: true },
  { name: 'SAP ECC — AA/AM extract', validated: false },
  { name: 'Oracle Fusion — FA retirement', validated: false },
  { name: 'Microsoft Dynamics 365 F&O', validated: false },
  { name: 'NetSuite — fixed assets', validated: false },
  { name: 'Workday Financials', validated: false },
  { name: 'Infor LN', validated: false },
  { name: 'Generic CSV — column mapped', validated: false },
];

export const VARIANCE_CAUSES = [
  'Discount rate differs from source', 'Inflation differs from source',
  'Cost estimate not reflected in source', 'Timing revision not reflected in source',
  'Term convention differs (SAP rounding)', 'Obligation missing from source',
  'Obligation missing from register', 'Rounding', 'Under investigation',
];

export const SCOPING_REASONS = [
  'Below the recognition threshold', 'No legal or constructive obligation',
  'Asset already retired', 'Covered by a third-party indemnity',
  'Held for sale', 'Out of group scope',
];

export const REMEASUREMENT_REASONS = [
  'Revised engineering estimate', 'Contractor quotation received',
  'Licence extension', 'Early abandonment decision', 'Regulatory change',
  'Change in restoration standard', 'Inflation reassessment', 'Scope change',
];

const OBLIGATION_TYPES = ['Well abandonment', 'Site restoration', 'Plant decommissioning', 'Pipeline removal', 'Tailings closure', 'Mine reclamation'];
const SITES = ['Kestrel North', 'Kestrel South', 'Bracken Field', 'Marrow Creek', 'Ollantay Ridge', 'Fen Marsh'];
const REGIONS = ['UK North Sea', 'Alberta', 'Queensland', 'Peru', 'Norway'];

/* ── Curves ─────────────────────────────────────────────────────────────── */

function boc(): Curve {
  // 120 quarter-year points over 30 years, the Bank of Canada shape.
  return {
    id: 'curve-boc', name: 'Bank of Canada — bond yield curve', currency: 'CAD',
    source: 'Bank of Canada, published daily (synthetic values)',
    basis: 'Zero-coupon, semi-annual compounding',
    interpolation: 'step', extrapolation: 'flat-last', asAt: '2025-12-31',
    points: Array.from({ length: 120 }, (_, i) => {
      const t = (i + 1) * 0.25;
      return { term: t, rate: round(0.0285 + 0.019 * (1 - Math.exp(-t / 7)), 6) };
    }),
  };
}

function gbpCurve(): Curve {
  return {
    id: 'curve-gbp', name: 'GBP government zero-coupon', currency: 'GBP',
    source: 'Bank of England published curve (synthetic values)',
    basis: 'Zero-coupon, annual compounding',
    interpolation: 'linear', extrapolation: 'flat-last', asAt: '2025-12-31',
    points: [1, 2, 3, 5, 7, 10, 15, 20, 25, 30].map((t) => ({
      term: t, rate: round(0.0395 + 0.0125 * (1 - Math.exp(-t / 9)), 6),
    })),
  };
}

function priorGbpCurve(): Curve {
  const c = gbpCurve();
  return { ...c, id: 'curve-gbp-prior', name: 'GBP government zero-coupon — prior year', asAt: '2024-12-31', points: c.points.map((p) => ({ ...p, rate: round(p.rate - 0.0055, 6) })) };
}

/* ── Tenant construction ────────────────────────────────────────────────── */

function settingsFor(tenantId: string): TenantSettings {
  const accounts: Account[] = ACCOUNTS.map(([code, name, cls, engineRole], i) => ({
    id: `${tenantId}-acc-${i}`, tenantId, code, name, cls, engineRole,
    requiredSegments: ['Company', 'Cost centre'],
  }));
  const segments: CodingSegment[] = [
    { id: `${tenantId}-seg-1`, tenantId, ord: 1, name: 'Company', required: true, permitted: ['1000', '1100', '2000'] },
    { id: `${tenantId}-seg-2`, tenantId, ord: 2, name: 'Cost centre', required: true, permitted: ['CC-100', 'CC-200', 'CC-300'] },
    { id: `${tenantId}-seg-3`, tenantId, ord: 3, name: 'Project', required: false, permitted: [] },
  ];
  const postingRules: PostingRule[] = POSTING_RULES.map(([eventType, debitRole, creditRole], i) => ({
    id: `${tenantId}-pr-${i}`, tenantId, eventType, debitRole, creditRole, engineEmitted: true,
  }));
  return {
    accounts, segments, postingRules,
    frameworks: structuredClone(FRAMEWORKS),
    defaults: {
      inflation: 0.025, contingency: 0.10, dayCount: '30/360 US (DAYS360)',
      termConvention: 'Round up to whole year (SAP)', calendarType: 'Monthly (12)',
    },
    retentionYears: 7, legalHold: false, sso: true, scim: false,
  };
}

function obligationsFor(unitId: string, n: number, seed: number): Obligation[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const type = pick(r, OBLIGATION_TYPES);
    const adj: Obligation['adj'] = [];
    if (r() > 0.62) {
      adj.push({
        id: `${unitId}-adj-c${i}`, kind: 'cost',
        amount: Math.round((r() - 0.25) * 900_000),
        date: '2025-06-30', reason: pick(r, REMEASUREMENT_REASONS),
        evidence: `EV-${1000 + i}`, createdBy: 'R. Achebe', createdAt: '2025-06-30T09:12:00Z',
      });
    }
    if (r() > 0.78) {
      adj.push({
        id: `${unitId}-adj-t${i}`, kind: 'term',
        to: `${2033 + Math.floor(r() * 9)}-${pick(r, ['03', '06', '09', '12'])}-30`,
        date: '2025-09-30', reason: pick(r, ['Licence extension', 'Early abandonment decision', 'Regulatory change']),
        evidence: `EV-${2000 + i}`, createdBy: 'R. Achebe', createdAt: '2025-09-30T14:02:00Z',
      });
    }
    return {
      id: `${unitId}-o-${i}`,
      ref: `ARO-${String(i + 1).padStart(4, '0')}`,
      description: `${type} — ${pick(r, SITES)}`,
      costEstimateDate: pick(r, ['2024-06-30', '2024-12-31', '2025-03-31', '2025-06-30']),
      settlementDate: `${2029 + Math.floor(r() * 14)}-${pick(r, ['03', '06', '09', '12'])}-30`,
      lines: [
        { id: `l1-${i}`, description: 'Rig / crew days', qty: 4 + Math.floor(r() * 40), rate: 38_000 + Math.floor(r() * 22_000), source: 'Contractor rate card 2025' },
        { id: `l2-${i}`, description: 'Cement and materials', qty: 120 + Math.floor(r() * 900), rate: 180 + Math.floor(r() * 120), source: 'Engineering estimate' },
        { id: `l3-${i}`, description: 'Site remediation', qty: 1, rate: 90_000 + Math.floor(r() * 500_000), source: 'Third-party quotation' },
      ],
      adj,
      site: pick(r, SITES),
      region: pick(r, REGIONS),
      type,
      basis: r() > 0.2 ? 'Legal' : 'Constructive',
      assetId: `AS-${10_000 + i}`,
      status: r() > 0.06 ? 'In scope' : 'Scoped out',
      scopeReason: r() > 0.06 ? '' : pick(r, SCOPING_REASONS),
      /** The source figure this row is recalculated against — Mode 1. */
      sourcePv: 0,
      varianceCause: '',
    } as Obligation;
  });
}

function eventsFor(unitId: string, periods: string[], obligations: Obligation[], seed: number): ObligationEvent[] {
  const r = rng(seed);
  const out: ObligationEvent[] = [];
  let i = 0;
  for (const p of periods) {
    for (const o of obligations.slice(0, 24)) {
      out.push({
        id: `${unitId}-ev-${i++}`, obligationId: o.id, periodId: p,
        type: 'accretion', date: '2025-01-31',
        amount: round(400 + r() * 2600),
        note: 'Allocated by balance and by the rate in force for the period.',
      });
    }
  }
  return out;
}

function unitData(unit: ReportingUnit, obligationCount: number, seed: number): UnitData {
  const periods = buildCalendar(unit.id, unit.fyEnd, unit.calendarType);
  // Periods 1-10 closed, 11 soft closed, 12 open — a unit mid-close.
  periods.forEach((p, i) => {
    p.status = i < 10 ? 'Closed' : i === 10 ? 'Soft closed' : 'Open';
  });
  const obligations = obligationsFor(unit.id, obligationCount, seed);
  return {
    obligations,
    events: eventsFor(unit.id, periods.slice(0, 11).map((p) => p.id), obligations, seed + 1),
    extracts: [
      {
        id: `${unit.id}-x1`, unitId: unit.id, kind: 'ARO register extract',
        filename: 'REP04_ARO_EXTRACT_2025.xlsx', hash: 'sha256:9f2c…a41b', rows: obligationCount,
        receivedAt: '2026-01-08T10:22:00Z', declared: 'cumulative',
        targetPeriodId: periods[11].id, acceptedAt: '2026-01-08T11:03:00Z',
        template: 'SAP S/4HANA — asset retirement', templateValidated: true,
      },
      {
        id: `${unit.id}-x2`, unitId: unit.id, kind: 'GL trial balance',
        filename: 'REP06_TB_PROVISIONS_2025.xlsx', hash: 'sha256:2d71…c908', rows: 412,
        receivedAt: '2026-01-09T08:41:00Z', declared: 'cumulative',
        targetPeriodId: periods[11].id,
        template: 'Generic CSV — column mapped', templateValidated: false,
      },
    ],
    batches: [],
    settlements: [],
    freezes: [],
    samples: [],
    tickmarks: [],
    signatures: [],
    periods,
    attestedGates: [],
    glTotal: null,
    conversionAgreed: false,
    noteGenerated: false,
    yearLocked: false,
  };
}

/* ── The seeded install ─────────────────────────────────────────────────── */

export function seedState(): AppState {
  const tenants: Tenant[] = [
    { id: 'kestrel', name: 'Kestrel Minerals plc', kind: 'Reporting entity', env: 'Production · EU-West', domain: 'kestrelminerals.com', createdAt: '2024-03-11T09:00:00Z' },
    { id: 'northgate', name: 'Northgate Energy Ltd', kind: 'Reporting entity', env: 'Production · UK-South', domain: 'northgate-energy.co.uk', createdAt: '2025-01-20T09:00:00Z' },
    { id: 'halloran', name: 'Halloran & Vance LLP', kind: 'Auditor', env: 'Production · EU-West', domain: 'halloranvance.com', createdAt: '2024-09-02T09:00:00Z' },
  ];

  const users: User[] = [
    { id: 'u-ka', tenantId: 'kestrel', name: 'R. Achebe', email: 'r.achebe@kestrelminerals.com', role: 'preparer', mfa: 'Enrolled', lastSeen: '2026-01-12T16:40:00Z' },
    { id: 'u-kb', tenantId: 'kestrel', name: 'M. Lindqvist', email: 'm.lindqvist@kestrelminerals.com', role: 'reviewer', mfa: 'Enrolled', lastSeen: '2026-01-12T12:05:00Z' },
    { id: 'u-kc', tenantId: 'kestrel', name: 'D. Okonjo', email: 'd.okonjo@kestrelminerals.com', role: 'partner', mfa: 'Enforced by SSO', isOwner: true, lastSeen: '2026-01-11T18:22:00Z' },
    { id: 'u-kd', tenantId: 'kestrel', name: 'S. Varga', email: 's.varga@kestrelminerals.com', role: 'admin', mfa: 'Enrolled', lastSeen: '2026-01-10T09:15:00Z' },
    { id: 'u-na', tenantId: 'northgate', name: 'J. Farrow', email: 'j.farrow@northgate-energy.co.uk', role: 'partner', mfa: 'Not enrolled', isOwner: true, lastSeen: '2026-01-06T10:00:00Z' },
    { id: 'u-ha', tenantId: 'halloran', name: 'P. Vance', email: 'p.vance@halloranvance.com', role: 'partner', mfa: 'Enforced by SSO', isOwner: true, lastSeen: '2026-01-12T08:30:00Z' },
    { id: 'u-hb', tenantId: 'halloran', name: 'T. Adeyemi', email: 't.adeyemi@halloranvance.com', role: 'preparer', mfa: 'Enrolled', lastSeen: '2026-01-12T09:44:00Z' },
  ];

  const units: Record<string, ReportingUnit[]> = {
    kestrel: [
      mkUnit('kestrel', 'ku1', 'Kestrel Minerals plc (parent)', 'Kestrel Minerals plc', '2025-12-31', 'GBP', 'Mining', 'u-kc', 'ifrs', 'United Kingdom', 'curve-gbp'),
      mkUnit('kestrel', 'ku2', 'Kestrel Canada Inc.', 'Kestrel Minerals plc', '2025-12-31', 'CAD', 'Mining', 'u-kc', 'ifrs', 'Canada', 'curve-boc'),
      mkUnit('kestrel', 'ku3', 'Bracken Field Operations Ltd', 'Kestrel Minerals plc', '2026-06-30', 'GBP', 'Oil & gas', 'u-kc', 'ifrs', 'United Kingdom', 'curve-gbp'),
    ],
    northgate: [
      mkUnit('northgate', 'nu1', 'Northgate Energy Ltd', 'Northgate Energy Ltd', '2025-12-31', 'GBP', 'Oil & gas', 'u-na', 'ifrs', 'United Kingdom', 'curve-gbp'),
    ],
    halloran: [
      mkUnit('halloran', 'hu1', 'Kestrel Minerals plc — FY25 audit', 'Kestrel Minerals plc', '2025-12-31', 'GBP', 'Mining', 'u-ha', 'ifrs', 'United Kingdom', 'curve-gbp'),
    ],
  };

  const data: Record<string, UnitData> = {
    ku1: unitData(units.kestrel[0], 46, 1001),
    ku2: unitData(units.kestrel[1], 28, 2002),
    ku3: unitData(units.kestrel[2], 12, 3003),
    nu1: unitData(units.northgate[0], 9, 4004),
    hu1: unitData(units.halloran[0], 46, 1001),
  };

  // Give the parent unit a source figure per row so Mode 1 has something to
  // recalculate against, with a handful of deliberate divergences.
  // Most rows agree to within a rounding difference. A handful diverge by
  // enough to breach materiality, so the variance-cause workflow has something
  // real to work on rather than a screen of immaterial noise.
  const r = rng(777);
  for (const o of data.ku1.obligations) {
    const wobble = r() > 0.82 ? 1 + (r() - 0.5) * 0.55 : 1 + (r() - 0.5) * 0.002;
    (o as Record<string, unknown>).sourcePv = wobble;
  }
  for (const o of data.hu1.obligations) {
    const wobble = r() > 0.82 ? 1 + (r() - 0.5) * 0.55 : 1 + (r() - 0.5) * 0.002;
    (o as Record<string, unknown>).sourcePv = wobble;
  }

  return {
    tenants,
    users,
    curves: {
      kestrel: [gbpCurve(), priorGbpCurve(), boc()],
      northgate: [gbpCurve()],
      halloran: [gbpCurve(), priorGbpCurve()],
    },
    units,
    data,
    settings: {
      kestrel: settingsFor('kestrel'),
      northgate: settingsFor('northgate'),
      halloran: settingsFor('halloran'),
    },
    authority: {
      kestrel: defaultAuthority('Reporting entity'),
      northgate: defaultAuthority('Reporting entity'),
      halloran: defaultAuthority('Auditor'),
    },
    chg: [],
    log: [],
  };
}

function mkUnit(
  tenantId: string, id: string, entity: string, client: string, fyEnd: string,
  currency: string, sector: string, partnerUserId: string, frameworkId: string,
  jurisdiction: string, curveId: string,
): ReportingUnit {
  return {
    id, tenantId, entity, client, fyEnd, currency, sector, partnerUserId,
    frameworkId, jurisdiction,
    calendarType: 'Monthly (12)',
    latePolicy: 'Prior-period adjustment',
    status: 'In progress',
    stage: 'Measure',
    inflation: 0.025,
    contingency: 0.10,
    curveId,
    priorCurveId: curveId === 'curve-gbp' ? 'curve-gbp-prior' : undefined,
    priorInflation: 0.021,
    termConvention: 'Round up to whole year (SAP)',
    materialityUsd: 250_000,
    materialityPct: 0.02,
    extrapolationPolicy: 'flat-last',
    dayCount: '30/360 US (DAYS360)',
  };
}

/** A new tenant starts genuinely empty — README, "Install scope". */
export function emptyTenant(name: string, kind: Tenant['kind'], userName: string, email: string): {
  tenant: Tenant; user: User; settings: TenantSettings; authority: ReturnType<typeof defaultAuthority>;
} {
  const id = `t-${Date.now().toString(36)}`;
  return {
    tenant: { id, name, kind, env: 'Production', domain: email.split('@')[1] ?? '', createdAt: new Date().toISOString(), custom: true },
    // The creator becomes the first engagement partner because somebody has to
    // be able to sign off — README, "Install scope".
    user: { id: `${id}-u1`, tenantId: id, name: userName, email, role: 'partner', mfa: 'Not enrolled', isOwner: true },
    settings: settingsFor(id),
    authority: defaultAuthority(kind),
  };
}
