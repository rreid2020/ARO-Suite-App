// src/server/vercel.ts
import { handle } from "hono/vercel";

// src/server/app.ts
import { Hono } from "hono";
import { cors } from "hono/cors";

// src/engine/dates.ts
var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseISO(s) {
  if (typeof s !== "string") return null;
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  if (d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}
function isLeapYear(y) {
  return y % 4 === 0 && y % 100 !== 0 || y % 400 === 0;
}
function daysInMonth(y, m) {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}
var pad = (n, w = 2) => String(n).padStart(w, "0");
function toISO(p) {
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}
function addMonths(s, n) {
  const p = parseISO(s);
  if (!p) return s;
  const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = total % 12 + 1;
  return toISO({ y, m, d: Math.min(p.d, daysInMonth(y, m)) });
}
function addDays(s, n) {
  const p = parseISO(s);
  if (!p) return s;
  const t = Date.UTC(p.y, p.m - 1, p.d) + n * 864e5;
  const d = new Date(t);
  return toISO({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
}

// src/core/authority.ts
var DOMAINS = [
  { id: "register", label: "Register & scoping", covers: "Which obligations exist, what is in scope, and why anything was scoped out." },
  { id: "estimates", label: "Estimates & revisions", covers: "The cost build-up, cost revisions and timing revisions." },
  { id: "assumptions", label: "Assumptions, curve & materiality", covers: "Inflation, contingency, the discount curve, the term convention and the materiality thresholds." },
  { id: "periods", label: "Periods, calendar & close", covers: "The accounting periods, their status, the close calendar and the year-end lock sequence." },
  { id: "journals", label: "Journals, postings & reconciliation", covers: "Journal batches, posting, suspense and the sub-ledger to GL reconciliation." },
  { id: "evidence", label: "Evidence, sampling & sign-off", covers: "Freezes, samples, tickmarks, exception memos and the signature record." }
];
var MODE_NOTE = {
  "We own it": "This tenant is the authority for this domain. Writes are accepted and recorded against it.",
  "Source-owned": "The source system is the authority. Writes are refused here; the figures are read and recalculated, and a difference is reported as a variance rather than corrected.",
  "Frozen copy": "This is a frozen copy taken at a point in time. Writes are refused; a re-import creates a new version with a diff rather than editing this one."
};
function defaultAuthority(kind) {
  if (kind === "Auditor") {
    return {
      register: "Source-owned",
      estimates: "Source-owned",
      assumptions: "We own it",
      periods: "Source-owned",
      journals: "Source-owned",
      evidence: "We own it"
    };
  }
  return {
    register: "We own it",
    estimates: "We own it",
    assumptions: "We own it",
    periods: "We own it",
    journals: "We own it",
    evidence: "We own it"
  };
}
var ROLES = [
  {
    id: "preparer",
    label: "Preparer",
    edit: true,
    sign: 0,
    createEng: false,
    admin: false,
    note: "Prepares and approves the work. Cannot post a journal batch."
  },
  {
    id: "reviewer",
    label: "Reviewer",
    edit: true,
    sign: 1,
    createEng: false,
    admin: false,
    note: "Reviews and posts. Cannot reverse a posted batch and cannot lock a period."
  },
  {
    id: "partner",
    label: "Engagement partner",
    edit: true,
    sign: 2,
    createEng: true,
    admin: false,
    note: "Signs off, posts, reverses and locks. The last partner on a tenant cannot be removed or demoted."
  },
  {
    id: "admin",
    label: "Firm admin",
    edit: true,
    sign: null,
    createEng: true,
    admin: true,
    note: "Administers the tenant, its users and its reference data. Cannot sign off \u2014 that is an engagement judgement."
  },
  {
    id: "readonly",
    label: "Read only",
    edit: false,
    sign: null,
    createEng: false,
    admin: false,
    note: "Reads everything in the tenant and writes nothing."
  },
  {
    id: "client",
    label: "Client contact",
    edit: false,
    sign: null,
    createEng: false,
    admin: false,
    note: "Sees the client portal request list only."
  }
];
var roleById = (id) => ROLES.find((r) => r.id === id) ?? ROLES[ROLES.length - 2];
var canEdit = (role) => roleById(role).edit;

// src/core/periods.ts
function addMonthsAnchored(s, n) {
  const p = parseISO(s);
  if (!p) return s;
  const shifted = addMonths(s, n);
  if (p.d !== daysInMonth(p.y, p.m)) return shifted;
  const q = parseISO(shifted);
  return q ? toISO({ ...q, d: daysInMonth(q.y, q.m) }) : shifted;
}
function buildCalendar(unitId, fyEnd, type = "Monthly (12)") {
  const end = parseISO(fyEnd);
  if (!end) return [];
  const fiscalYear = end.y;
  const count = type === "Quarterly (4)" ? 4 : 12;
  const monthsPer = 12 / count;
  const periods = [];
  for (let i = count; i >= 1; i--) {
    const ends = addMonthsAnchored(fyEnd, -monthsPer * (count - i));
    const starts = addDays(addMonthsAnchored(ends, -monthsPer), 1);
    periods.push({
      id: `${unitId}-FY${fiscalYear}-P${String(i).padStart(2, "0")}`,
      unitId,
      no: i,
      fiscalYear,
      code: `FY${fiscalYear} P${String(i).padStart(2, "0")}`,
      starts,
      ends,
      status: "Future"
    });
  }
  return periods.reverse();
}

// src/seed/index.ts
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = s * 1664525 + 1013904223 >>> 0;
    return s / 4294967296;
  };
}
var pick = (r, xs) => xs[Math.floor(r() * xs.length)];
var round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
var ACCOUNTS = [
  ["21500", "Provision \u2014 asset retirement obligations", "Liability", "ARO provision"],
  ["16100", "Retirement cost asset", "Asset", "Retirement cost asset"],
  ["16190", "Accumulated depreciation \u2014 retirement cost asset", "Asset", "Accumulated depreciation"],
  ["74200", "Accretion expense", "Expense", "Accretion expense"],
  ["74100", "Depreciation \u2014 retirement cost asset", "Expense", "Depreciation expense"],
  ["61000", "Site restoration operating costs", "Expense", "Operating costs"],
  ["48000", "Write-back of surplus provision", "Income", "Write-back to income"],
  ["10100", "Cash at bank", "Asset", "Cash"],
  ["32100", "Foreign currency translation reserve", "Equity", "FX translation reserve"],
  ["99999", "Suspense \u2014 unmapped ARO events", "Liability", "Suspense"]
];
var POSTING_RULES = [
  ["addition", "Retirement cost asset", "ARO provision"],
  ["accretion", "Accretion expense", "ARO provision"],
  ["revision", "Retirement cost asset", "ARO provision"],
  ["settlement", "ARO provision", "Cash"],
  ["overrun", "Operating costs", "Cash"],
  ["surplus", "ARO provision", "Write-back to income"],
  ["depreciation", "Depreciation expense", "Accumulated depreciation"],
  ["fx", "ARO provision", "FX translation reserve"]
];
var FRAMEWORKS = [
  {
    id: "ifrs",
    name: "IFRS (IAS 37)",
    wired: true,
    axes: {
      "Measurement basis": "Best estimate of the expenditure required to settle",
      "Discount rate": "Pre-tax rate reflecting current market assessments",
      "Rate per layer": "No \u2014 a single current rate is applied to the whole obligation",
      "Revisions": "Adjust the provision and the retirement cost asset",
      "Downward revision": "Reduces the asset; any excess to profit or loss",
      "Discounting": "Required where the effect is material",
      "Unwinding presented as": "Finance cost",
      "Inflation": "Consistent with the discount rate basis",
      "Constructive obligations": "In scope",
      "Change in estimate": "Prospective (IAS 8)"
    },
    engineEffects: [
      "A single discount rate, looked up on the closing curve, is applied to the whole obligation.",
      "Layers are derived for presentation only and do not carry their own rate."
    ]
  },
  {
    id: "usgaap",
    name: "US GAAP (ASC 410-20)",
    wired: false,
    axes: {
      "Measurement basis": "Fair value \u2014 expected present value technique",
      "Discount rate": "Credit-adjusted risk-free rate at the date the layer arose",
      "Rate per layer": "Yes \u2014 each upward revision carries the rate in force that day",
      "Revisions": "Upward revision creates a new layer; downward removes layers",
      "Downward revision": "Removes layers in the policy order",
      "Discounting": "Required",
      "Unwinding presented as": "Accretion expense (operating)",
      "Inflation": "Built into the expected cash flows",
      "Constructive obligations": "Narrower than IFRS",
      "Change in estimate": "Prospective (ASC 250)"
    },
    engineEffects: [
      "NOT YET WIRED \u2014 layers must be stored, each accreting at its own rate for the rest of its life.",
      "This is decision 2 in the README and it changes the obligation and layer tables."
    ]
  },
  {
    id: "psas",
    name: "PSAS (PS 3280)",
    wired: false,
    axes: {
      "Measurement basis": "Estimate of the cost directly attributable to the retirement",
      "Discount rate": "Entity-specific, or undiscounted where permitted",
      "Rate per layer": "No",
      "Revisions": "Adjust the liability and the related asset",
      "Downward revision": "Reduces the asset",
      "Discounting": "OPTIONAL \u2014 discounting may be dispensed with",
      "Unwinding presented as": "Not applicable where undiscounted",
      "Inflation": "Included where discounting is applied",
      "Constructive obligations": "In scope",
      "Change in estimate": "Prospective"
    },
    engineEffects: [
      "NOT YET WIRED \u2014 optional discounting. The engine currently always discounts."
    ]
  },
  {
    id: "aspe",
    name: "ASPE (Section 3110)",
    wired: false,
    axes: {
      "Measurement basis": "Fair value where determinable",
      "Discount rate": "Credit-adjusted risk-free rate at the date the layer arose",
      "Rate per layer": "Yes",
      "Revisions": "Layer-based, as US GAAP",
      "Downward revision": "Removes layers in the policy order",
      "Discounting": "Required where fair value is used",
      "Unwinding presented as": "Accretion expense",
      "Inflation": "Built into the expected cash flows",
      "Constructive obligations": "Legal obligations only",
      "Change in estimate": "Prospective"
    },
    engineEffects: ["NOT YET WIRED \u2014 layers with a rate per layer, as US GAAP."]
  }
];
var SCOPING_REASONS = [
  "Below the recognition threshold",
  "No legal or constructive obligation",
  "Asset already retired",
  "Covered by a third-party indemnity",
  "Held for sale",
  "Out of group scope"
];
var REMEASUREMENT_REASONS = [
  "Revised engineering estimate",
  "Contractor quotation received",
  "Licence extension",
  "Early abandonment decision",
  "Regulatory change",
  "Change in restoration standard",
  "Inflation reassessment",
  "Scope change"
];
var OBLIGATION_TYPES = ["Well abandonment", "Site restoration", "Plant decommissioning", "Pipeline removal", "Tailings closure", "Mine reclamation"];
var SITES = ["Kestrel North", "Kestrel South", "Bracken Field", "Marrow Creek", "Ollantay Ridge", "Fen Marsh"];
var REGIONS = ["UK North Sea", "Alberta", "Queensland", "Peru", "Norway"];
function boc() {
  return {
    id: "curve-boc",
    name: "Bank of Canada \u2014 bond yield curve",
    currency: "CAD",
    source: "Bank of Canada, published daily (synthetic values)",
    basis: "Zero-coupon, semi-annual compounding",
    interpolation: "step",
    extrapolation: "flat-last",
    asAt: "2025-12-31",
    points: Array.from({ length: 120 }, (_, i) => {
      const t = (i + 1) * 0.25;
      return { term: t, rate: round(0.0285 + 0.019 * (1 - Math.exp(-t / 7)), 6) };
    })
  };
}
function gbpCurve() {
  return {
    id: "curve-gbp",
    name: "GBP government zero-coupon",
    currency: "GBP",
    source: "Bank of England published curve (synthetic values)",
    basis: "Zero-coupon, annual compounding",
    interpolation: "linear",
    extrapolation: "flat-last",
    asAt: "2025-12-31",
    points: [1, 2, 3, 5, 7, 10, 15, 20, 25, 30].map((t) => ({
      term: t,
      rate: round(0.0395 + 0.0125 * (1 - Math.exp(-t / 9)), 6)
    }))
  };
}
function priorGbpCurve() {
  const c = gbpCurve();
  return { ...c, id: "curve-gbp-prior", name: "GBP government zero-coupon \u2014 prior year", asAt: "2024-12-31", points: c.points.map((p) => ({ ...p, rate: round(p.rate - 55e-4, 6) })) };
}
function settingsFor(tenantId) {
  const accounts = ACCOUNTS.map(([code, name, cls, engineRole], i) => ({
    id: `${tenantId}-acc-${i}`,
    tenantId,
    code,
    name,
    cls,
    engineRole,
    requiredSegments: ["Company", "Cost centre"]
  }));
  const segments = [
    { id: `${tenantId}-seg-1`, tenantId, ord: 1, name: "Company", required: true, permitted: ["1000", "1100", "2000"] },
    { id: `${tenantId}-seg-2`, tenantId, ord: 2, name: "Cost centre", required: true, permitted: ["CC-100", "CC-200", "CC-300"] },
    { id: `${tenantId}-seg-3`, tenantId, ord: 3, name: "Project", required: false, permitted: [] }
  ];
  const postingRules = POSTING_RULES.map(([eventType, debitRole, creditRole], i) => ({
    id: `${tenantId}-pr-${i}`,
    tenantId,
    eventType,
    debitRole,
    creditRole,
    engineEmitted: true
  }));
  return {
    accounts,
    segments,
    postingRules,
    frameworks: structuredClone(FRAMEWORKS),
    defaults: {
      inflation: 0.025,
      contingency: 0.1,
      dayCount: "30/360 US (DAYS360)",
      termConvention: "Round up to whole year (SAP)",
      calendarType: "Monthly (12)"
    },
    retentionYears: 7,
    legalHold: false,
    sso: true,
    scim: false
  };
}
function obligationsFor(unitId, n, seed) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const type = pick(r, OBLIGATION_TYPES);
    const adj = [];
    if (r() > 0.62) {
      adj.push({
        id: `${unitId}-adj-c${i}`,
        kind: "cost",
        amount: Math.round((r() - 0.25) * 9e5),
        date: "2025-06-30",
        reason: pick(r, REMEASUREMENT_REASONS),
        evidence: `EV-${1e3 + i}`,
        createdBy: "R. Achebe",
        createdAt: "2025-06-30T09:12:00Z"
      });
    }
    if (r() > 0.78) {
      adj.push({
        id: `${unitId}-adj-t${i}`,
        kind: "term",
        to: `${2033 + Math.floor(r() * 9)}-${pick(r, ["03", "06", "09", "12"])}-30`,
        date: "2025-09-30",
        reason: pick(r, ["Licence extension", "Early abandonment decision", "Regulatory change"]),
        evidence: `EV-${2e3 + i}`,
        createdBy: "R. Achebe",
        createdAt: "2025-09-30T14:02:00Z"
      });
    }
    return {
      id: `${unitId}-o-${i}`,
      ref: `ARO-${String(i + 1).padStart(4, "0")}`,
      description: `${type} \u2014 ${pick(r, SITES)}`,
      costEstimateDate: pick(r, ["2024-06-30", "2024-12-31", "2025-03-31", "2025-06-30"]),
      settlementDate: `${2029 + Math.floor(r() * 14)}-${pick(r, ["03", "06", "09", "12"])}-30`,
      lines: [
        { id: `l1-${i}`, description: "Rig / crew days", qty: 4 + Math.floor(r() * 40), rate: 38e3 + Math.floor(r() * 22e3), source: "Contractor rate card 2025" },
        { id: `l2-${i}`, description: "Cement and materials", qty: 120 + Math.floor(r() * 900), rate: 180 + Math.floor(r() * 120), source: "Engineering estimate" },
        { id: `l3-${i}`, description: "Site remediation", qty: 1, rate: 9e4 + Math.floor(r() * 5e5), source: "Third-party quotation" }
      ],
      adj,
      site: pick(r, SITES),
      region: pick(r, REGIONS),
      type,
      basis: r() > 0.2 ? "Legal" : "Constructive",
      assetId: `AS-${1e4 + i}`,
      status: r() > 0.06 ? "In scope" : "Scoped out",
      scopeReason: r() > 0.06 ? "" : pick(r, SCOPING_REASONS),
      /** The source figure this row is recalculated against — Mode 1. */
      sourcePv: 0,
      varianceCause: ""
    };
  });
}
function eventsFor(unitId, periods, obligations, seed) {
  const r = rng(seed);
  const out = [];
  let i = 0;
  for (const p of periods) {
    for (const o of obligations.slice(0, 24)) {
      out.push({
        id: `${unitId}-ev-${i++}`,
        obligationId: o.id,
        periodId: p,
        type: "accretion",
        date: "2025-01-31",
        amount: round(400 + r() * 2600),
        note: "Allocated by balance and by the rate in force for the period."
      });
    }
  }
  return out;
}
function unitData(unit, obligationCount, seed) {
  const periods = buildCalendar(unit.id, unit.fyEnd, unit.calendarType);
  periods.forEach((p, i) => {
    p.status = i < 10 ? "Closed" : i === 10 ? "Soft closed" : "Open";
  });
  const obligations = obligationsFor(unit.id, obligationCount, seed);
  return {
    obligations,
    events: eventsFor(unit.id, periods.slice(0, 11).map((p) => p.id), obligations, seed + 1),
    extracts: [
      {
        id: `${unit.id}-x1`,
        unitId: unit.id,
        kind: "ARO register extract",
        filename: "REP04_ARO_EXTRACT_2025.xlsx",
        hash: "sha256:9f2c\u2026a41b",
        rows: obligationCount,
        receivedAt: "2026-01-08T10:22:00Z",
        declared: "cumulative",
        targetPeriodId: periods[11].id,
        acceptedAt: "2026-01-08T11:03:00Z",
        template: "SAP S/4HANA \u2014 asset retirement",
        templateValidated: true
      },
      {
        id: `${unit.id}-x2`,
        unitId: unit.id,
        kind: "GL trial balance",
        filename: "REP06_TB_PROVISIONS_2025.xlsx",
        hash: "sha256:2d71\u2026c908",
        rows: 412,
        receivedAt: "2026-01-09T08:41:00Z",
        declared: "cumulative",
        targetPeriodId: periods[11].id,
        template: "Generic CSV \u2014 column mapped",
        templateValidated: false
      }
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
    yearLocked: false
  };
}
function seedState() {
  const tenants = [
    { id: "kestrel", name: "Kestrel Minerals plc", kind: "Reporting entity", env: "Production \xB7 EU-West", domain: "kestrelminerals.com", createdAt: "2024-03-11T09:00:00Z" },
    { id: "northgate", name: "Northgate Energy Ltd", kind: "Reporting entity", env: "Production \xB7 UK-South", domain: "northgate-energy.co.uk", createdAt: "2025-01-20T09:00:00Z" },
    { id: "halloran", name: "Halloran & Vance LLP", kind: "Auditor", env: "Production \xB7 EU-West", domain: "halloranvance.com", createdAt: "2024-09-02T09:00:00Z" }
  ];
  const users = [
    { id: "u-ka", tenantId: "kestrel", name: "R. Achebe", email: "r.achebe@kestrelminerals.com", role: "preparer", mfa: "Enrolled", lastSeen: "2026-01-12T16:40:00Z" },
    { id: "u-kb", tenantId: "kestrel", name: "M. Lindqvist", email: "m.lindqvist@kestrelminerals.com", role: "reviewer", mfa: "Enrolled", lastSeen: "2026-01-12T12:05:00Z" },
    { id: "u-kc", tenantId: "kestrel", name: "D. Okonjo", email: "d.okonjo@kestrelminerals.com", role: "partner", mfa: "Enforced by SSO", isOwner: true, lastSeen: "2026-01-11T18:22:00Z" },
    { id: "u-kd", tenantId: "kestrel", name: "S. Varga", email: "s.varga@kestrelminerals.com", role: "admin", mfa: "Enrolled", lastSeen: "2026-01-10T09:15:00Z" },
    { id: "u-na", tenantId: "northgate", name: "J. Farrow", email: "j.farrow@northgate-energy.co.uk", role: "partner", mfa: "Not enrolled", isOwner: true, lastSeen: "2026-01-06T10:00:00Z" },
    { id: "u-ha", tenantId: "halloran", name: "P. Vance", email: "p.vance@halloranvance.com", role: "partner", mfa: "Enforced by SSO", isOwner: true, lastSeen: "2026-01-12T08:30:00Z" },
    { id: "u-hb", tenantId: "halloran", name: "T. Adeyemi", email: "t.adeyemi@halloranvance.com", role: "preparer", mfa: "Enrolled", lastSeen: "2026-01-12T09:44:00Z" }
  ];
  const units = {
    kestrel: [
      mkUnit("kestrel", "ku1", "Kestrel Minerals plc (parent)", "Kestrel Minerals plc", "2025-12-31", "GBP", "Mining", "u-kc", "ifrs", "United Kingdom", "curve-gbp"),
      mkUnit("kestrel", "ku2", "Kestrel Canada Inc.", "Kestrel Minerals plc", "2025-12-31", "CAD", "Mining", "u-kc", "ifrs", "Canada", "curve-boc"),
      mkUnit("kestrel", "ku3", "Bracken Field Operations Ltd", "Kestrel Minerals plc", "2026-06-30", "GBP", "Oil & gas", "u-kc", "ifrs", "United Kingdom", "curve-gbp")
    ],
    northgate: [
      mkUnit("northgate", "nu1", "Northgate Energy Ltd", "Northgate Energy Ltd", "2025-12-31", "GBP", "Oil & gas", "u-na", "ifrs", "United Kingdom", "curve-gbp")
    ],
    halloran: [
      mkUnit("halloran", "hu1", "Kestrel Minerals plc \u2014 FY25 audit", "Kestrel Minerals plc", "2025-12-31", "GBP", "Mining", "u-ha", "ifrs", "United Kingdom", "curve-gbp")
    ]
  };
  const data = {
    ku1: unitData(units.kestrel[0], 46, 1001),
    ku2: unitData(units.kestrel[1], 28, 2002),
    ku3: unitData(units.kestrel[2], 12, 3003),
    nu1: unitData(units.northgate[0], 9, 4004),
    hu1: unitData(units.halloran[0], 46, 1001)
  };
  const r = rng(777);
  for (const o of data.ku1.obligations) {
    const wobble = r() > 0.82 ? 1 + (r() - 0.5) * 0.55 : 1 + (r() - 0.5) * 2e-3;
    o.sourcePv = wobble;
  }
  for (const o of data.hu1.obligations) {
    const wobble = r() > 0.82 ? 1 + (r() - 0.5) * 0.55 : 1 + (r() - 0.5) * 2e-3;
    o.sourcePv = wobble;
  }
  return {
    tenants,
    users,
    curves: {
      kestrel: [gbpCurve(), priorGbpCurve(), boc()],
      northgate: [gbpCurve()],
      halloran: [gbpCurve(), priorGbpCurve()]
    },
    units,
    data,
    settings: {
      kestrel: settingsFor("kestrel"),
      northgate: settingsFor("northgate"),
      halloran: settingsFor("halloran")
    },
    authority: {
      kestrel: defaultAuthority("Reporting entity"),
      northgate: defaultAuthority("Reporting entity"),
      halloran: defaultAuthority("Auditor")
    },
    chg: [],
    log: []
  };
}
function mkUnit(tenantId, id, entity, client, fyEnd, currency, sector, partnerUserId, frameworkId, jurisdiction, curveId) {
  return {
    id,
    tenantId,
    entity,
    client,
    fyEnd,
    currency,
    sector,
    partnerUserId,
    frameworkId,
    jurisdiction,
    calendarType: "Monthly (12)",
    latePolicy: "Prior-period adjustment",
    status: "In progress",
    stage: "Measure",
    inflation: 0.025,
    contingency: 0.1,
    curveId,
    priorCurveId: curveId === "curve-gbp" ? "curve-gbp-prior" : void 0,
    priorInflation: 0.021,
    termConvention: "Round up to whole year (SAP)",
    materialityUsd: 25e4,
    materialityPct: 0.02,
    extrapolationPolicy: "flat-last",
    dayCount: "30/360 US (DAYS360)"
  };
}
function emptyTenant(name, kind, userName, email) {
  const id = `t-${Date.now().toString(36)}`;
  return {
    tenant: { id, name, kind, env: "Production", domain: email.split("@")[1] ?? "", createdAt: (/* @__PURE__ */ new Date()).toISOString(), custom: true },
    // The creator becomes the first engagement partner because somebody has to
    // be able to sign off — README, "Install scope".
    user: { id: `${id}-u1`, tenantId: id, name: userName, email, role: "partner", mfa: "Not enrolled", isOwner: true },
    settings: settingsFor(id),
    authority: defaultAuthority(kind)
  };
}

// src/core/emptyState.ts
function emptyAppState() {
  return {
    tenants: [],
    users: [],
    curves: {},
    units: {},
    data: {},
    settings: {},
    authority: {},
    chg: [],
    log: []
  };
}

// src/server/auth.ts
import { createClerkClient, verifyToken } from "@clerk/backend";
import { HTTPException } from "hono/http-exception";

// src/server/loadEnv.ts
import { config } from "dotenv";
config({ path: ".env.local" });
config();

// src/server/db.ts
import { PrismaClient } from "@prisma/client";
var globalForPrisma = globalThis;
var prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// src/server/auth.ts
function clerk() {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) throw new Error("CLERK_SECRET_KEY is not set");
  return createClerkClient({ secretKey: key });
}
async function authenticate(authorization) {
  if (!authorization?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Sign in required" });
  }
  const token = authorization.slice(7);
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new HTTPException(500, { message: "CLERK_SECRET_KEY is not set" });
  let clerkUserId;
  try {
    const payload = await verifyToken(token, { secretKey });
    if (!payload.sub) throw new Error("missing sub");
    clerkUserId = payload.sub;
  } catch {
    throw new HTTPException(401, { message: "Invalid session" });
  }
  const user = await clerk().users.getUser(clerkUserId);
  const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email || "User";
  const appUser = await prisma.appUser.upsert({
    where: { clerkUserId },
    create: { clerkUserId, name, email },
    update: { name, email }
  });
  const memberships = await prisma.membership.findMany({ where: { userId: appUser.id } });
  return {
    clerkUserId,
    name,
    email,
    appUser,
    memberships,
    tenantIds: memberships.map((m) => m.tenantId)
  };
}
function assertTenant(auth, tenantId) {
  const m = auth.memberships.find((x) => x.tenantId === tenantId);
  if (!m) throw new HTTPException(403, { message: "Not a member of this tenant" });
  return m;
}

// src/server/hydrate.ts
async function hydrateAppState(prisma2, tenantIds) {
  const state = emptyAppState();
  if (!tenantIds.length) return state;
  const tenants = await prisma2.tenant.findMany({
    where: { id: { in: tenantIds } },
    include: {
      members: { include: { user: true } },
      settings: true,
      authority: true,
      accounts: true,
      segments: true,
      postingRules: true,
      curves: { include: { points: { orderBy: { termYears: "asc" } } } },
      units: {
        include: {
          assumptions: true,
          periods: { orderBy: [{ fiscalYear: "asc" }, { no: "asc" }] },
          obligations: { include: { costLines: true, revisions: true, events: true, settlements: true } },
          extracts: true,
          batches: { include: { lines: { orderBy: { ord: "asc" } } } },
          freezes: { include: { samples: true, tickmarks: true } },
          attestedGates: true,
          signatures: true
        }
      },
      changeLog: { orderBy: { at: "desc" }, take: 5e3 },
      auditEvents: { orderBy: { at: "desc" }, take: 5e3 }
    }
  });
  for (const t of tenants) {
    const tenant = {
      id: t.id,
      name: t.name,
      kind: t.kind,
      env: t.env,
      domain: t.domain,
      createdAt: t.createdAt.toISOString(),
      custom: t.custom
    };
    state.tenants.push(tenant);
    for (const m of t.members) {
      const user = {
        id: m.user.id,
        tenantId: t.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        mfa: m.mfa,
        isOwner: m.isOwner,
        lastSeen: m.lastSeen?.toISOString()
      };
      state.users.push(user);
    }
    const settings = t.settings ? {
      accounts: t.accounts.map(mapAccount),
      segments: t.segments.map(mapSegment),
      postingRules: t.postingRules.map(mapRule),
      frameworks: t.settings.frameworks,
      defaults: t.settings.defaults,
      retentionYears: t.settings.retentionYears,
      legalHold: t.settings.legalHold,
      sso: t.settings.sso,
      scim: t.settings.scim
    } : {
      accounts: t.accounts.map(mapAccount),
      segments: t.segments.map(mapSegment),
      postingRules: t.postingRules.map(mapRule),
      frameworks: [],
      defaults: {
        inflation: 0.025,
        contingency: 0.1,
        dayCount: "30/360 US (DAYS360)",
        termConvention: "Round up to whole year (SAP)",
        calendarType: "Monthly (12)"
      },
      retentionYears: 7,
      legalHold: false,
      sso: false,
      scim: false
    };
    state.settings[t.id] = settings;
    const auth = {};
    for (const d of DOMAINS) {
      const row = t.authority.find((a) => a.domain === d.id);
      auth[d.id] = row?.mode ?? "We own it";
    }
    state.authority[t.id] = auth;
    state.curves[t.id] = t.curves.map((c) => ({
      id: c.id,
      name: c.name,
      currency: c.currency,
      source: c.source,
      basis: c.basis,
      interpolation: c.interpolation,
      extrapolation: c.extrapolation,
      asAt: c.asAt,
      isDraft: c.isDraft,
      points: c.points.map((p) => ({ term: p.termYears, rate: p.rate }))
    }));
    const units = t.units.map((u) => {
      const a = u.assumptions;
      return {
        id: u.id,
        tenantId: u.tenantId,
        entity: u.entity,
        client: u.client,
        fyEnd: u.fyEnd,
        currency: u.currency,
        sector: u.sector,
        partnerUserId: u.partnerUserId,
        frameworkId: u.frameworkId,
        jurisdiction: u.jurisdiction,
        calendarType: u.calendarType,
        latePolicy: u.latePolicy,
        status: u.status,
        stage: u.stage,
        inflation: a?.inflation ?? 0.025,
        contingency: a?.contingency ?? 0.1,
        curveId: a?.curveId ?? "",
        priorCurveId: a?.priorCurveId ?? void 0,
        priorInflation: a?.priorInflation ?? void 0,
        revaluedOn: a?.revaluedOn ?? void 0,
        termConvention: a?.termConvention ?? "Round up to whole year (SAP)",
        materialityUsd: a?.materialityUsd ?? 0,
        materialityPct: a?.materialityPct ?? 0,
        extrapolationPolicy: a?.extrapolationPolicy ?? "flat-last",
        dayCount: u.dayCount
      };
    });
    state.units[t.id] = units;
    for (const u of t.units) {
      const freezeTickmarks = u.freezes.flatMap((f) => f.tickmarks);
      const data = {
        obligations: u.obligations.map(mapObligation),
        events: u.obligations.flatMap((o) => o.events.map(mapEvent)),
        extracts: u.extracts.map(mapExtract),
        batches: u.batches.map(mapBatch),
        settlements: u.obligations.flatMap((o) => o.settlements.map(mapSettlement)),
        freezes: u.freezes.map(mapFreeze),
        samples: u.freezes.flatMap((f) => f.samples.map(mapSample)),
        tickmarks: freezeTickmarks.map(mapTickmark),
        signatures: u.signatures.map(mapSignature),
        periods: u.periods.map(mapPeriod),
        attestedGates: u.attestedGates.map(mapGate),
        glTotal: u.glTotal,
        conversionAgreed: u.conversionAgreed,
        noteGenerated: u.noteGenerated,
        yearLocked: u.yearLocked
      };
      state.data[u.id] = data;
    }
    for (const c of t.changeLog) {
      state.chg.push({
        id: c.id,
        tenantId: c.tenantId,
        unitId: c.reportingUnitId ?? void 0,
        record: c.record,
        recordLabel: c.recordLabel,
        field: c.field,
        before: c.oldValue,
        after: c.newValue,
        actor: c.actor,
        at: c.at.toISOString(),
        restoredFrom: c.restoredFrom ?? void 0
      });
    }
    for (const a of t.auditEvents) {
      state.log.push({
        id: a.id,
        tenantId: a.tenantId,
        unitId: a.reportingUnitId ?? void 0,
        actor: a.actor,
        action: a.action,
        kind: a.kind,
        detail: a.detail,
        at: a.at.toISOString()
      });
    }
  }
  state.chg.sort((a, b) => b.at.localeCompare(a.at));
  state.log.sort((a, b) => b.at.localeCompare(a.at));
  return state;
}
function mapAccount(a) {
  return {
    id: a.id,
    tenantId: a.tenantId,
    code: a.code,
    name: a.name,
    cls: a.className,
    engineRole: a.engineRole,
    requiredSegments: a.requiredSegments
  };
}
function mapSegment(s) {
  return { id: s.id, tenantId: s.tenantId, ord: s.ord, name: s.name, required: s.required, permitted: s.permitted };
}
function mapRule(r) {
  return { id: r.id, tenantId: r.tenantId, eventType: r.eventType, debitRole: r.debitRole, creditRole: r.creditRole, engineEmitted: r.engineEmitted };
}
function mapObligation(o) {
  const extra = o.payload && typeof o.payload === "object" ? o.payload : {};
  const lines = o.costLines.map((l) => ({
    id: l.id,
    description: l.description,
    qty: l.qty,
    rate: l.unitRate,
    source: l.source ?? void 0
  }));
  const adj = o.revisions.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: r.amount ?? void 0,
    to: r.newDate ?? void 0,
    date: r.effectiveDate,
    reason: r.reason,
    evidence: r.evidenceRef ?? void 0,
    createdBy: r.createdBy ?? void 0,
    createdAt: r.createdAt.toISOString()
  }));
  return {
    ...extra,
    id: o.id,
    ref: o.ref,
    description: o.description,
    costEstimateDate: o.costEstimateDate,
    settlementDate: o.settlementDate,
    lines,
    adj
  };
}
function mapEvent(e) {
  return {
    id: e.id,
    obligationId: e.obligationId,
    periodId: e.periodId,
    type: e.type,
    date: e.eventDate,
    amount: e.amount,
    derived: e.derived || void 0,
    sourceRowRef: e.sourceRowRef ?? void 0,
    note: e.note ?? void 0
  };
}
function mapExtract(e) {
  return {
    id: e.id,
    unitId: e.reportingUnitId,
    kind: e.kind,
    filename: e.filename,
    hash: e.hash,
    rows: e.rows,
    receivedAt: e.receivedAt.toISOString(),
    declared: e.declared,
    targetPeriodId: e.targetPeriodId,
    acceptedAt: e.acceptedAt?.toISOString(),
    template: e.template,
    templateValidated: e.templateValidated
  };
}
function mapBatch(b) {
  const lines = b.lines.map((l) => ({
    ord: l.ord,
    accountId: l.accountId,
    coding: l.coding,
    debit: l.debit,
    credit: l.credit,
    obligationId: l.obligationId ?? void 0,
    eventId: l.eventId ?? void 0,
    suspense: l.suspense || void 0
  }));
  return {
    id: b.id,
    unitId: b.reportingUnitId,
    periodId: b.periodId,
    number: b.number,
    status: b.status,
    approvedBy: b.approvedBy ?? void 0,
    postedBy: b.postedBy ?? void 0,
    reversedBy: b.reversedBy ?? void 0,
    postedAt: b.postedAt?.toISOString(),
    lines,
    reverses: b.reverses ?? void 0
  };
}
function mapSettlement(s) {
  return { id: s.id, obligationId: s.obligationId, kind: s.kind, pct: s.pct, actualCost: s.actualCost, settledOn: s.settledOn, posted: s.posted };
}
function mapFreeze(f) {
  return {
    id: f.id,
    unitId: f.reportingUnitId,
    version: f.version,
    hash: f.hash,
    population: f.population,
    total: f.total,
    createdAt: f.createdAt.toISOString(),
    createdBy: f.createdBy,
    rows: f.rows
  };
}
function mapSample(s) {
  return {
    id: s.id,
    freezeId: s.freezeId,
    method: s.method,
    size: s.size,
    seed: s.seed,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    picked: s.picked
  };
}
function mapTickmark(t) {
  return {
    id: t.id,
    obligationId: t.obligationId,
    freezeId: t.freezeId,
    preparer: t.preparer ?? void 0,
    reviewer: t.reviewer ?? void 0,
    markedAt: t.markedAt?.toISOString(),
    note: t.note ?? void 0
  };
}
function mapSignature(s) {
  return { stage: s.stage, by: s.by, at: s.at.toISOString(), recalcStamp: s.recalcStamp };
}
function mapPeriod(p) {
  return { id: p.id, unitId: p.reportingUnitId, no: p.no, fiscalYear: p.fiscalYear, code: p.code, starts: p.starts, ends: p.ends, status: p.status };
}
function mapGate(g) {
  return {
    id: g.id,
    label: g.label,
    kind: "attested",
    attestedBy: g.attestedBy ?? void 0,
    attestedAt: g.attestedAt?.toISOString(),
    note: g.note
  };
}

// src/server/persist.ts
var CORE_OBLIGATION = /* @__PURE__ */ new Set([
  "id",
  "ref",
  "description",
  "costEstimateDate",
  "settlementDate",
  "lines",
  "adj"
]);
async function persistAppState(prisma2, state, allowedTenantIds, ownerUserId) {
  const allowed = new Set(allowedTenantIds);
  const persistable = state.tenants.filter((t) => allowed.has(t.id));
  const persistIds = new Set(persistable.map((t) => t.id));
  await prisma2.$transaction(async (tx) => {
    for (const tenant of persistable) {
      await tx.tenant.upsert({
        where: { id: tenant.id },
        create: {
          id: tenant.id,
          name: tenant.name,
          kind: tenant.kind,
          env: tenant.env,
          domain: tenant.domain,
          custom: tenant.custom ?? false,
          createdAt: new Date(tenant.createdAt)
        },
        update: { name: tenant.name, kind: tenant.kind, env: tenant.env, domain: tenant.domain, custom: tenant.custom ?? false }
      });
      const settings = state.settings[tenant.id];
      if (settings) {
        await tx.tenantSettings.upsert({
          where: { tenantId: tenant.id },
          create: {
            tenantId: tenant.id,
            defaults: settings.defaults,
            frameworks: settings.frameworks,
            retentionYears: settings.retentionYears,
            legalHold: settings.legalHold,
            sso: settings.sso,
            scim: settings.scim
          },
          update: {
            defaults: settings.defaults,
            frameworks: settings.frameworks,
            retentionYears: settings.retentionYears,
            legalHold: settings.legalHold,
            sso: settings.sso,
            scim: settings.scim
          }
        });
        await replaceAccounts(tx, tenant.id, settings.accounts);
        await replaceSegments(tx, tenant.id, settings.segments);
        await replaceRules(tx, tenant.id, settings.postingRules);
      }
      const authority = state.authority[tenant.id];
      if (authority) {
        for (const d of DOMAINS) {
          await tx.authority.upsert({
            where: { tenantId_domain: { tenantId: tenant.id, domain: d.id } },
            create: { tenantId: tenant.id, domain: d.id, mode: authority[d.id] },
            update: { mode: authority[d.id] }
          });
        }
      }
      const tenantUsers = state.users.filter((u) => u.tenantId === tenant.id);
      for (const u of tenantUsers) {
        await tx.appUser.upsert({
          where: { id: u.id },
          create: { id: u.id, name: u.name, email: u.email },
          update: { name: u.name, email: u.email }
        });
        await tx.membership.upsert({
          where: { tenantId_userId: { tenantId: tenant.id, userId: u.id } },
          create: {
            tenantId: tenant.id,
            userId: u.id,
            role: u.role,
            mfa: u.mfa,
            isOwner: u.isOwner ?? false,
            lastSeen: u.lastSeen ? new Date(u.lastSeen) : null
          },
          update: {
            role: u.role,
            mfa: u.mfa,
            isOwner: u.isOwner ?? false,
            lastSeen: u.lastSeen ? new Date(u.lastSeen) : null
          }
        });
      }
      if (ownerUserId) {
        const already = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: tenant.id, userId: ownerUserId } }
        });
        if (!already) {
          await tx.membership.create({
            data: { tenantId: tenant.id, userId: ownerUserId, role: "partner", isOwner: true }
          });
        }
      }
      await replaceCurves(tx, tenant.id, state.curves[tenant.id] ?? []);
      await replaceUnits(tx, tenant.id, state.units[tenant.id] ?? [], state.data);
    }
    await appendChanges(tx, state.chg.filter((c) => persistIds.has(c.tenantId)));
    await appendAudit(tx, state.log.filter((a) => persistIds.has(a.tenantId)));
  }, { timeout: 12e4, maxWait: 15e3 });
}
async function replaceAccounts(tx, tenantId, accounts) {
  const keep = new Set(accounts.map((a) => a.id));
  await tx.account.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });
  for (const a of accounts) {
    await tx.account.upsert({
      where: { id: a.id },
      create: {
        id: a.id,
        tenantId,
        code: a.code,
        name: a.name,
        className: a.cls,
        engineRole: a.engineRole,
        requiredSegments: a.requiredSegments
      },
      update: {
        code: a.code,
        name: a.name,
        className: a.cls,
        engineRole: a.engineRole,
        requiredSegments: a.requiredSegments
      }
    });
  }
}
async function replaceSegments(tx, tenantId, segments) {
  const keep = new Set(segments.map((s) => s.id));
  await tx.codingSegment.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });
  for (const s of segments) {
    await tx.codingSegment.upsert({
      where: { id: s.id },
      create: { id: s.id, tenantId, ord: s.ord, name: s.name, required: s.required, permitted: s.permitted },
      update: { ord: s.ord, name: s.name, required: s.required, permitted: s.permitted }
    });
  }
}
async function replaceRules(tx, tenantId, rules) {
  const keep = new Set(rules.map((r) => r.id));
  await tx.postingRule.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });
  for (const r of rules) {
    await tx.postingRule.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        tenantId,
        eventType: r.eventType,
        debitRole: r.debitRole,
        creditRole: r.creditRole,
        engineEmitted: r.engineEmitted
      },
      update: { eventType: r.eventType, debitRole: r.debitRole, creditRole: r.creditRole, engineEmitted: r.engineEmitted }
    });
  }
}
async function replaceCurves(tx, tenantId, curves) {
  const keep = new Set(curves.map((c) => c.id));
  await tx.curve.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });
  for (const c of curves) {
    await tx.curve.upsert({
      where: { tenantId_id: { tenantId, id: c.id } },
      create: {
        tenantId,
        id: c.id,
        name: c.name,
        currency: c.currency,
        source: c.source,
        basis: c.basis,
        interpolation: c.interpolation,
        extrapolation: c.extrapolation,
        asAt: c.asAt,
        isDraft: c.isDraft ?? false
      },
      update: {
        name: c.name,
        currency: c.currency,
        source: c.source,
        basis: c.basis,
        interpolation: c.interpolation,
        extrapolation: c.extrapolation,
        asAt: c.asAt,
        isDraft: c.isDraft ?? false
      }
    });
    await tx.curvePoint.deleteMany({ where: { tenantId, curveId: c.id } });
    if (c.points.length) {
      await tx.curvePoint.createMany({
        data: c.points.map((p) => ({ tenantId, curveId: c.id, termYears: p.term, rate: p.rate }))
      });
    }
  }
}
async function replaceUnits(tx, tenantId, units, data) {
  const keep = new Set(units.map((u) => u.id));
  await tx.reportingUnit.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });
  for (const u of units) {
    await tx.reportingUnit.upsert({
      where: { id: u.id },
      create: {
        id: u.id,
        tenantId,
        entity: u.entity,
        client: u.client,
        fyEnd: u.fyEnd,
        currency: u.currency,
        sector: u.sector,
        partnerUserId: u.partnerUserId,
        frameworkId: u.frameworkId,
        jurisdiction: u.jurisdiction,
        calendarType: u.calendarType,
        latePolicy: u.latePolicy,
        status: u.status,
        stage: u.stage,
        dayCount: u.dayCount,
        glTotal: data[u.id]?.glTotal ?? null,
        conversionAgreed: data[u.id]?.conversionAgreed ?? false,
        noteGenerated: data[u.id]?.noteGenerated ?? false,
        yearLocked: data[u.id]?.yearLocked ?? false
      },
      update: {
        entity: u.entity,
        client: u.client,
        fyEnd: u.fyEnd,
        currency: u.currency,
        sector: u.sector,
        partnerUserId: u.partnerUserId,
        frameworkId: u.frameworkId,
        jurisdiction: u.jurisdiction,
        calendarType: u.calendarType,
        latePolicy: u.latePolicy,
        status: u.status,
        stage: u.stage,
        dayCount: u.dayCount,
        glTotal: data[u.id]?.glTotal ?? null,
        conversionAgreed: data[u.id]?.conversionAgreed ?? false,
        noteGenerated: data[u.id]?.noteGenerated ?? false,
        yearLocked: data[u.id]?.yearLocked ?? false
      }
    });
    await tx.assumptions.upsert({
      where: { reportingUnitId: u.id },
      create: {
        reportingUnitId: u.id,
        inflation: u.inflation,
        contingency: u.contingency,
        curveId: u.curveId,
        priorCurveId: u.priorCurveId ?? null,
        priorInflation: u.priorInflation ?? null,
        revaluedOn: u.revaluedOn ?? null,
        termConvention: u.termConvention,
        materialityUsd: u.materialityUsd,
        materialityPct: u.materialityPct,
        extrapolationPolicy: u.extrapolationPolicy
      },
      update: {
        inflation: u.inflation,
        contingency: u.contingency,
        curveId: u.curveId,
        priorCurveId: u.priorCurveId ?? null,
        priorInflation: u.priorInflation ?? null,
        revaluedOn: u.revaluedOn ?? null,
        termConvention: u.termConvention,
        materialityUsd: u.materialityUsd,
        materialityPct: u.materialityPct,
        extrapolationPolicy: u.extrapolationPolicy
      }
    });
    await persistUnitData(tx, u.id, data[u.id]);
  }
}
async function persistUnitData(tx, unitId, unit) {
  if (!unit) return;
  const keepPeriods = unit.periods.map((p) => p.id);
  await tx.period.deleteMany({ where: { reportingUnitId: unitId, id: { notIn: keepPeriods } } });
  for (const p of unit.periods) {
    await tx.period.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        reportingUnitId: unitId,
        no: p.no,
        fiscalYear: p.fiscalYear,
        code: p.code,
        starts: p.starts,
        ends: p.ends,
        status: p.status
      },
      update: { no: p.no, fiscalYear: p.fiscalYear, code: p.code, starts: p.starts, ends: p.ends, status: p.status }
    });
  }
  const keepObl = unit.obligations.map((o) => o.id);
  await tx.obligation.deleteMany({ where: { reportingUnitId: unitId, id: { notIn: keepObl } } });
  for (const o of unit.obligations) await upsertObligation(tx, unitId, o);
  const existingEvents = await tx.obligationEvent.findMany({
    where: { obligation: { reportingUnitId: unitId } },
    select: { id: true }
  });
  const haveEvent = new Set(existingEvents.map((e) => e.id));
  const newEvents = unit.events.filter((e) => !haveEvent.has(e.id));
  if (newEvents.length) {
    await tx.obligationEvent.createMany({
      data: newEvents.map((e) => ({
        id: e.id,
        obligationId: e.obligationId,
        periodId: e.periodId,
        type: e.type,
        eventDate: e.date,
        amount: e.amount,
        derived: e.derived ?? false,
        sourceRowRef: e.sourceRowRef ?? null,
        note: e.note ?? null
      })),
      skipDuplicates: true
    });
  }
  await tx.settlement.deleteMany({
    where: { obligation: { reportingUnitId: unitId }, id: { notIn: unit.settlements.map((s) => s.id) } }
  });
  for (const s of unit.settlements) {
    await tx.settlement.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        obligationId: s.obligationId,
        kind: s.kind,
        pct: s.pct,
        actualCost: s.actualCost,
        settledOn: s.settledOn,
        posted: s.posted
      },
      update: { kind: s.kind, pct: s.pct, actualCost: s.actualCost, settledOn: s.settledOn, posted: s.posted }
    });
  }
  await tx.extract.deleteMany({
    where: { reportingUnitId: unitId, id: { notIn: unit.extracts.map((e) => e.id) } }
  });
  for (const e of unit.extracts) {
    await tx.extract.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        reportingUnitId: unitId,
        kind: e.kind,
        filename: e.filename,
        hash: e.hash,
        rows: e.rows,
        receivedAt: new Date(e.receivedAt),
        declared: e.declared,
        targetPeriodId: e.targetPeriodId,
        acceptedAt: e.acceptedAt ? new Date(e.acceptedAt) : null,
        template: e.template,
        templateValidated: e.templateValidated
      },
      update: {
        kind: e.kind,
        filename: e.filename,
        hash: e.hash,
        rows: e.rows,
        receivedAt: new Date(e.receivedAt),
        declared: e.declared,
        targetPeriodId: e.targetPeriodId,
        acceptedAt: e.acceptedAt ? new Date(e.acceptedAt) : null,
        template: e.template,
        templateValidated: e.templateValidated
      }
    });
  }
  const posted = await tx.journalBatch.findMany({
    where: { reportingUnitId: unitId, status: "Posted" },
    select: { id: true }
  });
  const postedIds = new Set(posted.map((b) => b.id));
  await tx.journalBatch.deleteMany({
    where: {
      reportingUnitId: unitId,
      id: { notIn: unit.batches.map((b) => b.id) },
      status: { not: "Posted" }
    }
  });
  for (const b of unit.batches) {
    if (postedIds.has(b.id)) continue;
    await tx.journalBatch.upsert({
      where: { id: b.id },
      create: {
        id: b.id,
        reportingUnitId: unitId,
        periodId: b.periodId,
        number: b.number,
        status: b.status,
        approvedBy: b.approvedBy ?? null,
        postedBy: b.postedBy ?? null,
        reversedBy: b.reversedBy ?? null,
        postedAt: b.postedAt ? new Date(b.postedAt) : null,
        reverses: b.reverses ?? null
      },
      update: {
        periodId: b.periodId,
        number: b.number,
        status: b.status,
        approvedBy: b.approvedBy ?? null,
        postedBy: b.postedBy ?? null,
        reversedBy: b.reversedBy ?? null,
        postedAt: b.postedAt ? new Date(b.postedAt) : null,
        reverses: b.reverses ?? null
      }
    });
    await tx.journalLine.deleteMany({ where: { batchId: b.id } });
    if (b.lines.length) {
      await tx.journalLine.createMany({
        data: b.lines.map((l) => ({
          batchId: b.id,
          ord: l.ord,
          accountId: l.accountId,
          coding: l.coding,
          debit: l.debit,
          credit: l.credit,
          obligationId: l.obligationId ?? null,
          eventId: l.eventId ?? null,
          suspense: l.suspense ?? false
        }))
      });
    }
  }
  await tx.freeze.deleteMany({
    where: { reportingUnitId: unitId, id: { notIn: unit.freezes.map((f) => f.id) } }
  });
  for (const f of unit.freezes) {
    await tx.freeze.upsert({
      where: { id: f.id },
      create: {
        id: f.id,
        reportingUnitId: unitId,
        version: f.version,
        hash: f.hash,
        population: f.population,
        total: f.total,
        createdAt: new Date(f.createdAt),
        createdBy: f.createdBy,
        rows: f.rows
      },
      update: {
        version: f.version,
        hash: f.hash,
        population: f.population,
        total: f.total,
        createdBy: f.createdBy,
        rows: f.rows
      }
    });
  }
  await tx.sample.deleteMany({
    where: { freeze: { reportingUnitId: unitId }, id: { notIn: unit.samples.map((s) => s.id) } }
  });
  for (const s of unit.samples) {
    await tx.sample.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        freezeId: s.freezeId,
        method: s.method,
        size: s.size,
        seed: s.seed,
        createdBy: s.createdBy,
        createdAt: new Date(s.createdAt),
        picked: s.picked
      },
      update: { method: s.method, size: s.size, seed: s.seed, createdBy: s.createdBy, picked: s.picked }
    });
  }
  await tx.tickmark.deleteMany({
    where: { freeze: { reportingUnitId: unitId }, id: { notIn: unit.tickmarks.map((t) => t.id) } }
  });
  for (const t of unit.tickmarks) {
    await tx.tickmark.upsert({
      where: { id: t.id },
      create: {
        id: t.id,
        obligationId: t.obligationId,
        freezeId: t.freezeId,
        preparer: t.preparer ?? null,
        reviewer: t.reviewer ?? null,
        markedAt: t.markedAt ? new Date(t.markedAt) : null,
        note: t.note ?? null
      },
      update: {
        preparer: t.preparer ?? null,
        reviewer: t.reviewer ?? null,
        markedAt: t.markedAt ? new Date(t.markedAt) : null,
        note: t.note ?? null
      }
    });
  }
  await tx.signature.deleteMany({ where: { reportingUnitId: unitId } });
  if (unit.signatures.length) {
    await tx.signature.createMany({
      data: unit.signatures.map((s) => ({
        reportingUnitId: unitId,
        stage: s.stage,
        by: s.by,
        at: new Date(s.at),
        recalcStamp: s.recalcStamp
      }))
    });
  }
  await tx.attestedGate.deleteMany({
    where: { reportingUnitId: unitId, id: { notIn: unit.attestedGates.map((g) => g.id) } }
  });
  for (const g of unit.attestedGates) {
    await tx.attestedGate.upsert({
      where: { id: g.id },
      create: {
        id: g.id,
        reportingUnitId: unitId,
        label: g.label,
        attestedBy: g.attestedBy ?? null,
        attestedAt: g.attestedAt ? new Date(g.attestedAt) : null,
        note: g.note
      },
      update: {
        label: g.label,
        attestedBy: g.attestedBy ?? null,
        attestedAt: g.attestedAt ? new Date(g.attestedAt) : null,
        note: g.note
      }
    });
  }
}
async function upsertObligation(tx, unitId, o) {
  const payload = {};
  for (const [k, v] of Object.entries(o)) {
    if (!CORE_OBLIGATION.has(k)) payload[k] = v;
  }
  await tx.obligation.upsert({
    where: { id: o.id },
    create: {
      id: o.id,
      reportingUnitId: unitId,
      ref: o.ref,
      description: o.description,
      costEstimateDate: o.costEstimateDate,
      settlementDate: o.settlementDate,
      payload
    },
    update: {
      ref: o.ref,
      description: o.description,
      costEstimateDate: o.costEstimateDate,
      settlementDate: o.settlementDate,
      payload
    }
  });
  await tx.costLine.deleteMany({ where: { obligationId: o.id } });
  if (o.lines?.length) {
    await tx.costLine.createMany({
      data: o.lines.map((l) => ({
        id: l.id.startsWith(o.id) ? l.id : `${o.id}-${l.id}`,
        obligationId: o.id,
        description: l.description,
        qty: l.qty,
        unitRate: l.rate,
        source: l.source ?? null
      }))
    });
  }
  await tx.revision.deleteMany({ where: { obligationId: o.id } });
  if (o.adj?.length) {
    await tx.revision.createMany({
      data: o.adj.map((r) => ({
        id: r.id,
        obligationId: o.id,
        kind: r.kind,
        amount: r.amount ?? null,
        newDate: r.to ?? null,
        effectiveDate: r.date,
        reason: r.reason,
        evidenceRef: r.evidence ?? null,
        createdBy: r.createdBy ?? null,
        createdAt: r.createdAt ? new Date(r.createdAt) : void 0
      }))
    });
  }
}
async function appendChanges(tx, entries) {
  if (!entries.length) return;
  await tx.changeLog.createMany({
    data: entries.map((c) => ({
      id: c.id,
      tenantId: c.tenantId,
      reportingUnitId: c.unitId ?? null,
      record: c.record,
      recordLabel: c.recordLabel,
      field: c.field,
      oldValue: c.before ?? null,
      newValue: c.after ?? null,
      actor: c.actor,
      at: new Date(c.at),
      restoredFrom: c.restoredFrom ?? null
    })),
    skipDuplicates: true
  });
}
async function appendAudit(tx, entries) {
  if (!entries.length) return;
  await tx.auditEvent.createMany({
    data: entries.map((a) => ({
      id: a.id,
      tenantId: a.tenantId,
      reportingUnitId: a.unitId ?? null,
      actor: a.actor,
      action: a.action,
      kind: a.kind,
      detail: a.detail,
      at: new Date(a.at)
    })),
    skipDuplicates: true
  });
}

// src/server/scope.ts
function scopeState(state, tenantIds) {
  const allowed = new Set(tenantIds);
  const stripped = {
    ...emptyAppState(),
    tenants: state.tenants.filter((t) => allowed.has(t.id)),
    users: state.users.filter((u) => allowed.has(u.tenantId)),
    curves: pickRecord(state.curves, allowed),
    units: pickRecord(state.units, allowed),
    settings: pickRecord(state.settings, allowed),
    authority: pickRecord(state.authority, allowed),
    data: {},
    chg: state.chg.filter((x) => allowed.has(x.tenantId)),
    log: state.log.filter((x) => allowed.has(x.tenantId))
  };
  for (const t of stripped.tenants) {
    for (const u of stripped.units[t.id] ?? []) {
      if (state.data[u.id]) stripped.data[u.id] = state.data[u.id];
    }
  }
  return stripped;
}
function pickRecord(rec, allowed) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) if (allowed.has(k)) out[k] = v;
  return out;
}

// src/server/seedPrefix.ts
function prefixSeed(state, prefix) {
  const raw = JSON.stringify(state);
  const ids = [
    "kestrel",
    "northgate",
    "halloran",
    "ku1",
    "ku2",
    "ku3",
    "nu1",
    "hu1",
    "u-ka",
    "u-kb",
    "u-kc",
    "u-kd",
    "u-na",
    "u-ha",
    "u-hb"
  ];
  let out = raw;
  for (const id of ["ku1", "ku2", "ku3", "nu1", "hu1"]) {
    out = out.replaceAll(`${id}-`, `${prefix}${id}-`);
  }
  for (const id of ids) {
    const re = new RegExp(`"${id}"`, "g");
    out = out.replace(re, `"${prefix}${id}"`);
  }
  return JSON.parse(out);
}

// src/core/writePath.ts
var counter = 0;
var nextId = (p) => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
var now = () => (/* @__PURE__ */ new Date()).toISOString();
function flatten(v, prefix = "", out = {}) {
  if (v === null || v === void 0 || typeof v !== "object") {
    out[prefix] = v;
    return out;
  }
  if (Array.isArray(v)) {
    if (!v.length) out[prefix] = "[]";
    v.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return out;
  }
  const entries = Object.entries(v);
  if (!entries.length) out[prefix] = "{}";
  for (const [k, val] of entries) flatten(val, prefix ? `${prefix}.${k}` : k, out);
  return out;
}
function diff(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  const fields = /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const f of fields) {
    if (!same(a[f], b[f])) out.push({ field: f, before: a[f], after: b[f] });
  }
  return out.sort((x, y) => x.field.localeCompare(y.field));
}
var same = (x, y) => x === y || typeof x === "number" && typeof y === "number" && Number.isNaN(x) && Number.isNaN(y);
function mut(req) {
  const at = now();
  const domainDef = DOMAINS.find((d) => d.id === req.domain);
  const mode = req.authority[req.domain];
  const refuse = (refusal) => ({
    ok: false,
    value: req.before,
    refusal,
    refusedFields: [],
    changes: [],
    audit: [
      {
        id: nextId("a"),
        tenantId: req.tenantId,
        unitId: req.unitId,
        actor: req.actor,
        action: req.action,
        kind: "refused",
        detail: refusal.reason,
        at
      }
    ]
  });
  if (!canEdit(req.role)) {
    return refuse({
      domain: req.domain,
      domainLabel: domainDef.label,
      mode: "role",
      reason: `The write was refused: this role cannot edit ${domainDef.label.toLowerCase()}. ${domainDef.covers}`
    });
  }
  if (mode !== "We own it") {
    return refuse({
      domain: req.domain,
      domainLabel: domainDef.label,
      mode,
      reason: `The write was refused: ${domainDef.label} is set to "${mode}" for this tenant. ` + MODE_NOTE[mode]
    });
  }
  const all = diff(req.before, req.after);
  const refusedFields = [];
  const accepted = [];
  for (const d of all) {
    const guard = req.guarded?.[d.field] ?? req.guarded?.[d.field.split("[")[0]];
    if (guard) refusedFields.push({ field: d.field, reason: guard });
    else accepted.push(d);
  }
  let value = req.after;
  if (refusedFields.length) {
    value = structuredClone(req.after);
    for (const r of refusedFields) setPath(value, r.field, getPath(req.before, r.field));
  }
  const changes = accepted.map((d) => ({
    id: nextId("c"),
    tenantId: req.tenantId,
    unitId: req.unitId,
    record: req.record,
    recordLabel: req.recordLabel,
    field: d.field,
    before: d.before,
    after: d.after,
    actor: req.actor,
    at
  }));
  const audit = [];
  if (changes.length) {
    audit.push({
      id: nextId("a"),
      tenantId: req.tenantId,
      unitId: req.unitId,
      actor: req.actor,
      action: req.action,
      kind: "write",
      detail: `${req.recordLabel} \u2014 ${changes.length} field${changes.length === 1 ? "" : "s"} changed.`,
      at
    });
  }
  if (refusedFields.length) {
    audit.push({
      id: nextId("a"),
      tenantId: req.tenantId,
      unitId: req.unitId,
      actor: req.actor,
      action: req.action,
      kind: "refused",
      detail: `${req.recordLabel} \u2014 ${changes.length} written, ${refusedFields.length} refused: ` + refusedFields.map((r) => `${r.field} (${r.reason})`).join("; "),
      at
    });
  }
  return { ok: true, value, refusedFields, changes, audit };
}
function tokens(path) {
  const out = [];
  for (const part of path.split(".")) {
    const m = /^([^[]*)((\[\d+\])*)$/.exec(part);
    if (!m) {
      out.push(part);
      continue;
    }
    if (m[1]) out.push(m[1]);
    for (const idx of m[2].match(/\d+/g) ?? []) out.push(Number(idx));
  }
  return out;
}
function getPath(obj, path) {
  let cur = obj;
  for (const t of tokens(path)) {
    if (cur === null || cur === void 0) return void 0;
    cur = cur[t];
  }
  return cur;
}
function setPath(obj, path, value) {
  const ts = tokens(path);
  let cur = obj;
  for (let i = 0; i < ts.length - 1; i++) {
    const t = ts[i];
    if (cur[t] === null || typeof cur[t] !== "object") cur[t] = typeof ts[i + 1] === "number" ? [] : {};
    cur = cur[t];
  }
  cur[ts[ts.length - 1]] = value;
}

// src/server/writeService.ts
async function serverWrite(auth, req) {
  const membership = assertTenant(auth, req.tenantId);
  const secured = {
    ...req,
    actor: auth.name || req.actor,
    role: membership.role
  };
  const result = mut(secured);
  if (result.changes.length) await appendChanges(prisma, result.changes);
  if (result.audit.length) await appendAudit(prisma, result.audit);
  return result;
}

// src/server/app.ts
var app = new Hono();
app.use("/api/*", cors());
app.onError((err, c) => {
  const status = err.status ?? 500;
  return c.json({ error: err.message }, status);
});
app.get("/api/health", (c) => c.json({ ok: true }));
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const auth = await authenticate(c.req.header("Authorization"));
  c.set("auth", auth);
  await next();
});
app.get("/api/state", async (c) => {
  const auth = c.get("auth");
  const state = await hydrateAppState(prisma, auth.tenantIds);
  return c.json(state);
});
app.put("/api/state", async (c) => {
  const auth = c.get("auth");
  const state = await c.req.json();
  const stripped = scopeState(state, auth.tenantIds);
  await persistAppState(prisma, stripped, auth.tenantIds, auth.appUser.id);
  return c.json({ ok: true });
});
app.post("/api/writes", async (c) => {
  const auth = c.get("auth");
  const req = await c.req.json();
  const result = await serverWrite(auth, req);
  return c.json(result);
});
app.post("/api/changes", async (c) => {
  const auth = c.get("auth");
  const entries = await c.req.json();
  const allowed = entries.filter((e) => auth.tenantIds.includes(e.tenantId));
  await appendChanges(prisma, allowed);
  return c.json({ ok: true, count: allowed.length });
});
app.post("/api/audit", async (c) => {
  const auth = c.get("auth");
  const entries = await c.req.json();
  const allowed = entries.filter((e) => auth.tenantIds.includes(e.tenantId));
  await appendAudit(prisma, allowed);
  return c.json({ ok: true, count: allowed.length });
});
app.post("/api/tenants", async (c) => {
  const auth = c.get("auth");
  const body = await c.req.json();
  if (!body.name?.trim()) return c.json({ error: "Organisation name is required" }, 400);
  const made = emptyTenant(body.name.trim(), body.kind ?? "Reporting entity", auth.name, auth.email);
  const state = emptyAppState();
  state.tenants = [made.tenant];
  state.users = [{ ...made.user, id: auth.appUser.id, name: auth.name, email: auth.email }];
  state.settings[made.tenant.id] = made.settings;
  state.authority[made.tenant.id] = made.authority;
  state.curves[made.tenant.id] = [];
  state.units[made.tenant.id] = [];
  await persistAppState(prisma, state, [made.tenant.id], auth.appUser.id);
  const next = await hydrateAppState(prisma, [...auth.tenantIds, made.tenant.id]);
  return c.json({ tenantId: made.tenant.id, state: next });
});
app.delete("/api/tenants/:id", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const membership = assertTenant(auth, id);
  if (!membership.isOwner) return c.json({ error: "Only the tenant owner can delete it" }, 403);
  await prisma.tenant.delete({ where: { id } });
  return c.json({ ok: true });
});
app.post("/api/seed", async (c) => {
  const auth = c.get("auth");
  const prefix = `s${auth.appUser.id.replace(/[^a-zA-Z0-9]/g, "").slice(-10)}-`;
  const seeded = prefixSeed(seedState(), prefix);
  await persistAppState(prisma, seeded, seeded.tenants.map((t) => t.id), auth.appUser.id);
  const next = await hydrateAppState(prisma, [
    ...auth.tenantIds,
    ...seeded.tenants.map((t) => t.id)
  ]);
  return c.json(next);
});

// src/server/vercel.ts
var handler = handle(app);
var vercel_default = handler;
var GET = handler;
var POST = handler;
var PUT = handler;
var DELETE = handler;
var PATCH = handler;
var config2 = { runtime: "nodejs" };
export {
  DELETE,
  GET,
  PATCH,
  POST,
  PUT,
  config2 as config,
  vercel_default as default
};
