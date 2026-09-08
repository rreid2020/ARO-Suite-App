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
function days360(a, b) {
  const pa = parseISO(a);
  const pb = parseISO(b);
  if (!pa || !pb) return 0;
  let d1 = pa.d;
  let d2 = pb.d;
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;
  return (pb.y - pa.y) * 360 + (pb.m - pa.m) * 30 + (d2 - d1);
}
function days360eu(a, b) {
  const pa = parseISO(a);
  const pb = parseISO(b);
  if (!pa || !pb) return 0;
  const d1 = pa.d === 31 ? 30 : pa.d;
  const d2 = pb.d === 31 ? 30 : pb.d;
  return (pb.y - pa.y) * 360 + (pb.m - pa.m) * 30 + (d2 - d1);
}
function actualDays(a, b) {
  const pa = parseISO(a);
  const pb = parseISO(b);
  if (!pa || !pb) return 0;
  return (Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 864e5;
}
var DEFAULT_DAY_COUNT = "30/360 US (DAYS360)";
function termYears(a, b, dayCount = DEFAULT_DAY_COUNT) {
  switch (dayCount) {
    case "30E/360 (European)":
      return days360eu(a, b) / 360;
    case "Actual/365":
      return actualDays(a, b) / 365;
    case "Actual/360":
      return actualDays(a, b) / 360;
    case "Actual/Actual":
      return termActualActual(a, b);
    default:
      return term360(a, b);
  }
}
function termActualActual(a, b) {
  const pa = parseISO(a);
  const pb = parseISO(b);
  if (!pa || !pb) return 0;
  if (a === b) return 0;
  const sign = a < b ? 1 : -1;
  const start = sign === 1 ? a : b;
  const end = sign === 1 ? b : a;
  const startP = sign === 1 ? pa : pb;
  const endP = sign === 1 ? pb : pa;
  let sum = 0;
  for (let y = startP.y; y <= endP.y; y++) {
    const sliceStart = y === startP.y ? start : toISO({ y, m: 1, d: 1 });
    const sliceEnd = y === endP.y ? end : toISO({ y: y + 1, m: 1, d: 1 });
    const dim = isLeapYear(y) ? 366 : 365;
    sum += actualDays(sliceStart, sliceEnd) / dim;
  }
  return sign * sum;
}
function term360(a, b) {
  return days360(a, b) / 360;
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
function cmpDate(a, b) {
  const pa = parseISO(a);
  const pb = parseISO(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/core/authority.ts
var DOMAINS = [
  { id: "register", label: "Register & scoping", covers: "Which obligations exist, what is in scope, and why anything was scoped out." },
  { id: "estimates", label: "Estimates & revisions", covers: "The cost build-up, cost revisions and timing revisions." },
  { id: "assumptions", label: "Assumptions, curve & materiality", covers: "Inflation, contingency, the discount curve, the term convention and the materiality thresholds." },
  { id: "periods", label: "Periods, calendar & close", covers: "The accounting periods, their status, the close calendar and the year-end lock sequence." },
  { id: "journals", label: "Journals, postings & reconciliation", covers: "Month-end accretion and amortization, journal batches, posting, suspense and the sub-ledger to GL reconciliation." },
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
var canAdmin = (role) => roleById(role).admin;
var signLevel = (role) => roleById(role).sign;
var canConfigureTenant = (role) => canAdmin(role) || signLevel(role) === 2;

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
var ENGINE_ROLES = [
  "ARO provision",
  "Retirement cost asset",
  "Accumulated depreciation",
  "Accretion expense",
  "Depreciation expense",
  "Operating costs",
  "Write-back to income",
  "Cash",
  "Gain on disposal",
  "Loss on disposal",
  "FX translation reserve",
  "Suspense"
];
var ENGINE_ROLE_GLS = [
  ["21500", "Provision \u2014 asset retirement obligations", "Liability", "ARO provision"],
  ["16100", "Retirement cost asset", "Asset", "Retirement cost asset"],
  ["16190", "Accumulated depreciation \u2014 retirement cost asset", "Asset", "Accumulated depreciation"],
  ["74200", "Accretion expense", "Expense", "Accretion expense"],
  ["74100", "Depreciation \u2014 retirement cost asset", "Expense", "Depreciation expense"],
  ["61000", "Site restoration operating costs", "Expense", "Operating costs"],
  ["48000", "Write-back of surplus provision", "Income", "Write-back to income"],
  ["10100", "Cash at bank", "Asset", "Cash"],
  ["42400", "Gain on disposal of ARO", "Income", "Gain on disposal"],
  ["51500", "Loss on disposal of ARO", "Expense", "Loss on disposal"],
  ["32100", "Foreign currency translation reserve", "Equity", "FX translation reserve"],
  ["99999", "Suspense \u2014 unmapped ARO events", "Liability", "Suspense"]
];
var ENGINE_POSTING_RULES = [
  ["addition", "Retirement cost asset", "ARO provision"],
  ["expense-recognition", "Operating costs", "ARO provision"],
  ["accretion", "Accretion expense", "ARO provision"],
  ["revision", "Retirement cost asset", "ARO provision"],
  ["revision-unproductive", "Operating costs", "ARO provision"],
  ["downward-excess", "Accretion expense", "ARO provision"],
  ["settlement", "ARO provision", "Cash"],
  ["overrun", "Operating costs", "Cash"],
  ["surplus", "ARO provision", "Write-back to income"],
  ["depreciation", "Depreciation expense", "Accumulated depreciation"],
  ["disposal", "ARO provision", "Gain on disposal"],
  ["asset-retirement", "Accumulated depreciation", "Retirement cost asset"],
  ["fx", "ARO provision", "FX translation reserve"]
];
var ENGINE_EVENT_TYPES = ENGINE_POSTING_RULES.map(([eventType]) => eventType);
var ACCOUNT_CLASSES = ["Asset", "Liability", "Equity", "Income", "Expense"];
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
      "Layers are derived for presentation only and do not carry their own rate.",
      "A year-end revaluation reprices the whole population onto the closing table. That movement is a change in estimate."
    ]
  },
  {
    id: "usgaap",
    name: "US GAAP (ASC 410-20)",
    wired: true,
    axes: {
      "Measurement basis": "Expected present value technique",
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
      "Each layer is stored. An upward cost revision creates a new layer at the rate in force that day; that rate is locked for the rest of the layer's life.",
      "A downward cost revision consumes layers in the unit's policy order (LIFO, FIFO or pro-rata).",
      "A later closing curve does not remeasure existing layers. It becomes the lookup for layers that arise after it is in force."
    ]
  },
  {
    id: "psas",
    name: "PSAS (PS 3280)",
    wired: true,
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
      "A single current rate, as IFRS, when this reporting unit discounts.",
      "Discounting may be turned off on the unit. When it is, inflation is not applied either, and the provision is the cost at current prices."
    ]
  },
  {
    id: "aspe",
    name: "ASPE (Section 3110)",
    wired: true,
    axes: {
      "Measurement basis": "Present value where determinable",
      "Discount rate": "Credit-adjusted risk-free rate at the date the layer arose",
      "Rate per layer": "Yes",
      "Revisions": "Layer-based, as US GAAP",
      "Downward revision": "Removes layers in the policy order",
      "Discounting": "Required where a present value is used",
      "Unwinding presented as": "Accretion expense",
      "Inflation": "Built into the expected cash flows",
      "Constructive obligations": "Legal obligations only",
      "Change in estimate": "Prospective"
    },
    engineEffects: [
      "Layers with a rate per layer, as US GAAP. Each upward revision locks the rate in force that day.",
      "A downward revision consumes layers in the unit's policy order. Existing layers are not remeasured onto a later curve."
    ]
  }
];
var REMEASUREMENT_REASONS = [
  "Revised engineering estimate",
  "Contractor quotation received",
  "Licence extension",
  "Early abandonment decision",
  "Regulatory change",
  "Change in restoration standard",
  "Inflation reassessment",
  "Scope change",
  "Write-off"
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
function settingsFor(tenantId, complete = false) {
  const accounts = ENGINE_ROLE_GLS.map(([code, name, cls, engineRole], i) => ({
    id: `${tenantId}-acc-${i}`,
    tenantId,
    code,
    name,
    cls,
    engineRole,
    requiredSegments: ["Company", "Cost centre"],
    columns: { Company: "1000", "Cost centre": "CC-100" }
  }));
  const segments = [
    { id: `${tenantId}-seg-1`, tenantId, ord: 1, name: "Company", required: true, permitted: ["1000", "1100", "2000"] },
    { id: `${tenantId}-seg-2`, tenantId, ord: 2, name: "Cost centre", required: true, permitted: ["CC-100", "CC-200", "CC-300"] },
    { id: `${tenantId}-seg-3`, tenantId, ord: 3, name: "Project", required: false, permitted: [] }
  ];
  const postingRules = ENGINE_POSTING_RULES.map(([eventType, debitRole, creditRole], i) => ({
    id: `${tenantId}-pr-${i}`,
    tenantId,
    eventType,
    debitRole,
    creditRole,
    engineEmitted: true
  }));
  const postingScenarios = [{
    id: `${tenantId}-scn-default`,
    tenantId,
    name: "Standard ARO",
    isDefault: true,
    accounts: Object.fromEntries(accounts.filter((a) => a.engineRole).map((a) => [a.engineRole, a.id])),
    completedRoles: []
  }];
  return {
    accounts,
    segments,
    postingRules,
    postingScenarios,
    aroAssetClasses: [],
    costEstimateTemplates: [],
    frameworks: structuredClone(FRAMEWORKS),
    defaults: {
      inflation: 0.025,
      contingency: 0.1,
      dayCount: "30/360 US (DAYS360)",
      termConvention: "Round up to whole year (SAP)",
      calendarType: "Monthly (12)",
      frameworkId: "ifrs"
    },
    setup: complete ? {
      current: "unit",
      savedAt: "2025-01-01T00:00:00Z",
      defaultsConfirmedAt: "2025-01-01T00:00:00Z",
      completedAt: "2025-01-01T00:00:00Z"
    } : {
      current: "unit",
      savedAt: (/* @__PURE__ */ new Date()).toISOString(),
      defaultsConfirmedAt: null,
      completedAt: null
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
      aroAssetClass: type,
      basis: r() > 0.2 ? "Legal" : "Constructive",
      assetId: `AS-${1e4 + i}`,
      aroAssetNumber: `ARO-${1e4 + i}`,
      status: "In scope",
      scopeReason: "",
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
function tcaAssetsFor(unitId, obligations) {
  const assets = [];
  const seen = /* @__PURE__ */ new Set();
  for (const o of obligations) {
    const assetNumber = String(o.assetId ?? "");
    const key = assetNumber.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    assets.push({
      id: `${unitId}-tca-${assets.length}`,
      assetNumber,
      description: String(o.assetDescription || o.description),
      assetClass: String(o.aroAssetClass || o.type || ""),
      acquisitionDate: String(o.assetAcquisitionDate || ""),
      site: String(o.site || ""),
      acquisitionCost: typeof o.openingArc === "number" && typeof o.openingAccumAmort === "number" ? o.openingArc + o.openingAccumAmort : null,
      accumAmort: typeof o.openingAccumAmort === "number" ? o.openingAccumAmort : null,
      assetStatus: "Active",
      scope: "In scope",
      scopeReason: "",
      columns: {}
    });
  }
  assets.push({
    id: `${unitId}-tca-out`,
    assetNumber: `AS-OUT-${unitId}`,
    description: "Retired pad \u2014 no remaining obligation",
    assetClass: "Well abandonment",
    acquisitionDate: "2001-03-31",
    site: SITES[0],
    acquisitionCost: 0,
    accumAmort: 0,
    assetStatus: "Disposed",
    scope: "Scoped out",
    scopeReason: "Asset already retired",
    columns: {}
  });
  assets.push({
    id: `${unitId}-tca-und`,
    assetNumber: `AS-UND-${unitId}`,
    description: "Awaiting scoping review",
    assetClass: "Site restoration",
    acquisitionDate: "2019-06-30",
    site: SITES[1],
    acquisitionCost: 0,
    accumAmort: 0,
    assetStatus: "Active",
    scope: "Undecided",
    scopeReason: "",
    columns: {}
  });
  return assets;
}
function unitData(unit, obligationCount, seed) {
  const periods = buildCalendar(unit.id, unit.fyEnd, unit.calendarType);
  periods.forEach((p, i) => {
    p.status = i < 10 ? "Closed" : i === 10 ? "Soft closed" : "Open";
  });
  const obligations = obligationsFor(unit.id, obligationCount, seed);
  const tcaAssets = tcaAssetsFor(unit.id, obligations);
  return {
    tcaAssets,
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
    openingGlProvision: null,
    openingGlArc: null,
    openingGlAroCost: null,
    openingGlAroAccum: null,
    openingGlTcaCost: null,
    openingGlTcaAccum: null,
    openingSnapshot: null,
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
      kestrel: settingsFor("kestrel", true),
      northgate: settingsFor("northgate", true),
      halloran: settingsFor("halloran", true)
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
function mkUnit(tenantId, id, entity, client, fyEnd, currency2, sector, partnerUserId, frameworkId, jurisdiction, curveId) {
  return {
    id,
    tenantId,
    entity,
    client,
    fyEnd,
    currency: currency2,
    sector,
    partnerUserId,
    frameworkId,
    jurisdiction,
    calendarType: "Monthly (12)",
    latePolicy: "Prior-period adjustment",
    status: "In progress",
    stage: "Measure",
    setupCompletedAt: "2025-01-01T00:00:00Z",
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
import { verifyToken } from "@clerk/backend";
import { HTTPException as HTTPException2 } from "hono/http-exception";

// src/server/clerk.ts
import { createClerkClient } from "@clerk/backend";
function clerk() {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) throw new Error("CLERK_SECRET_KEY is not set");
  return createClerkClient({ secretKey: key });
}

// src/server/loadEnv.ts
import { config as loadEnvFile } from "dotenv";
loadEnvFile({ path: ".env.local" });
loadEnvFile();

// src/server/db.ts
import { PrismaClient } from "@prisma/client";
var globalForPrisma = globalThis;
var prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// src/server/identity.ts
import { HTTPException } from "hono/http-exception";

// src/core/invite.ts
function normalizeEmail(raw) {
  return raw.trim().toLowerCase();
}
function isValidEmail(raw) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}
function planUserClaim(pending) {
  if (!pending.length) return null;
  const keep = pending[0];
  const keepTenants = new Set(keep.memberships.map((m) => m.tenantId));
  const move = [];
  const dropMembershipIds = [];
  const deleteUserIds = [];
  for (const extra of pending.slice(1)) {
    deleteUserIds.push(extra.id);
    for (const m of extra.memberships) {
      if (keepTenants.has(m.tenantId)) dropMembershipIds.push(m.id);
      else {
        move.push({ membershipId: m.id });
        keepTenants.add(m.tenantId);
      }
    }
  }
  return { keepId: keep.id, move, dropMembershipIds, deleteUserIds };
}
function clerkErrorLooksDuplicate(err) {
  const text = err instanceof Error ? err.message : String(err ?? "");
  const blob = text.toLowerCase();
  return /already|duplicate|exist|pending invitation/.test(blob);
}
function inviteRedirectUrl(origin, envOrigin = "") {
  const fromEnv = envOrigin.replace(/\/$/, "");
  const base = (origin ?? "").replace(/\/$/, "") || fromEnv || "https://aro-suite-app.vercel.app";
  return `${base}/?auth=signup`;
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
function note(tenantId, unitId, actor, action, kind, detail) {
  return { id: nextId("a"), tenantId, unitId, actor, action, kind, detail, at: now() };
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

// src/core/accountType.ts
var CLASS_ALIASES = {
  asset: "Asset",
  assets: "Asset",
  a: "Asset",
  liability: "Liability",
  liabilities: "Liability",
  l: "Liability",
  liab: "Liability",
  equity: "Equity",
  capital: "Equity",
  e: "Equity",
  income: "Income",
  revenue: "Income",
  revenues: "Income",
  i: "Income",
  r: "Income",
  expense: "Expense",
  expenses: "Expense",
  expenditure: "Expense",
  x: "Expense"
};
function headerKey(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function compactKey(s) {
  return headerKey(s).replace(/\s/g, "");
}
function isAccountTypeHeader(raw) {
  const n = headerKey(raw);
  const c = compactKey(raw);
  return n === "account type" || n === "account class" || c === "accounttype" || c === "accountclass";
}
function isLooseClassHeader(raw) {
  const n = headerKey(raw);
  return n === "class" || n === "category" || n === "nature" || n === "type";
}
function parseAccountClass(raw) {
  const t = raw.trim();
  if (!t) return null;
  if (ACCOUNT_CLASSES.includes(t)) return t;
  const n = compactKey(t);
  return CLASS_ALIASES[n] ?? CLASS_ALIASES[headerKey(t)] ?? null;
}
function classFromColumns(columns) {
  const entries = Object.entries(columns);
  for (const [k, v] of entries) {
    if (!isAccountTypeHeader(k)) continue;
    const parsed = parseAccountClass(v);
    if (parsed) return parsed;
  }
  for (const [k, v] of entries) {
    if (!isLooseClassHeader(k)) continue;
    const parsed = parseAccountClass(v);
    if (parsed) return parsed;
  }
  return "";
}
function accountTypeOf(acc) {
  if (!acc) return "";
  return classFromColumns(acc.columns ?? {}) || acc.cls || "";
}

// src/core/assetClass.ts
function splitClassLabel(label) {
  const t = label.trim();
  if (!t) return { code: "", name: "" };
  if (/^\d+$/.test(t)) return { code: t, name: "" };
  const dash = t.match(/^(\S+)\s+[—–-]\s+(.+)$/);
  if (dash) return { code: dash[1].trim(), name: dash[2].trim() };
  const numbered = t.match(/^(\d+)\s+(.+)$/);
  if (numbered) return { code: numbered[1], name: numbered[2].trim() };
  return { code: "", name: t };
}
function classLabel(cls) {
  const code = (cls.code ?? "").trim();
  const name = cls.name.trim();
  if (code && name && code !== name) return `${code} \u2014 ${name}`;
  return name || code;
}
function classKey(cls) {
  return (cls.code ?? "").trim() || cls.name.trim();
}
function findAssetClass(classes, raw) {
  const t = (raw ?? "").trim();
  if (!t || !classes?.length) return void 0;
  const lower = t.toLowerCase();
  const parts = splitClassLabel(t);
  const hit = (c) => {
    const code = (c.code ?? "").trim().toLowerCase();
    const name = c.name.trim().toLowerCase();
    const fromName = splitClassLabel(c.name);
    const fromNameCode = fromName.code.toLowerCase();
    if (name === lower || classLabel(c).toLowerCase() === lower) return true;
    if (code && code === lower) return true;
    if (fromNameCode && fromNameCode === lower) return true;
    const codeHit = !!(parts.code && (code === parts.code.toLowerCase() || fromNameCode === parts.code.toLowerCase()));
    const nameHit = !!(parts.name && name === parts.name.toLowerCase());
    if (parts.code && parts.name) return codeHit && nameHit;
    if (parts.code) return codeHit;
    return nameHit;
  };
  return classes.find(hit);
}
function normalizeAroAssetClasses(settings) {
  for (const c of settings.aroAssetClasses ?? []) {
    let split = false;
    if (!(c.code ?? "").trim()) {
      const parts = splitClassLabel(c.name);
      if (parts.code && parts.name) {
        c.code = parts.code;
        c.name = parts.name;
        split = true;
      } else if (c.code == null) {
        c.code = "";
      }
    }
    if (!split) continue;
    const siblings = (settings.aroAssetClasses ?? []).filter((x) => x.scenarioId === c.scenarioId);
    const scn = (settings.postingScenarios ?? []).find((s) => s.id === c.scenarioId);
    if (scn && !scn.isDefault && siblings.length === 1) scn.name = classLabel(c);
  }
}
function canonicalizeObligationClasses(settings, data) {
  for (const o of data.obligations) {
    const raw = typeof o.aroAssetClass === "string" ? o.aroAssetClass : void 0;
    const cls = findAssetClass(settings.aroAssetClasses, raw);
    if (cls) o.aroAssetClass = classKey(cls);
  }
}

// src/core/format.ts
var ISO_CODES = /\b(CAD|USD|GBP|EUR|CHF|AUD|NZD|HKD|SGD|JPY|CNY)\b/gi;
function parseNumber(raw) {
  if (typeof raw === "number") return raw;
  let s = String(raw ?? "").trim();
  if (!s) return NaN;
  const paren = s.startsWith("(") && s.endsWith(")");
  s = s.replace(/[()]/g, "");
  s = s.replace(ISO_CODES, "");
  s = s.replace(/[$£€¥]/g, "");
  s = s.replace(/[\s'’`,]/g, "");
  if (!s || s === "+" || s === "-" || s === "." || s === "+." || s === "-.") return NaN;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return paren ? -Math.abs(n) : n;
}

// src/core/costEstimate.ts
var DESCRIPTION_COLUMN = {
  id: "description",
  label: "Description",
  kind: "text",
  role: "label"
};
var QTY_COLUMN = {
  id: "qty",
  label: "Qty",
  kind: "number",
  role: "factor"
};
var RATE_COLUMN = {
  id: "rate",
  label: "Unit rate",
  kind: "currency",
  role: "factor"
};
var DEFAULT_ESTIMATE_COLUMNS = [
  DESCRIPTION_COLUMN,
  QTY_COLUMN,
  RATE_COLUMN
];
var SYSTEM_IDS = new Set(DEFAULT_ESTIMATE_COLUMNS.map((c) => c.id));
var KINDS = /* @__PURE__ */ new Set(["text", "number", "percent", "currency"]);
function isSystemEstimateColumn(id) {
  return SYSTEM_IDS.has(id);
}
function parseEstimateColumn(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  const id = String(r.id ?? "").trim();
  if (!id) return null;
  const kind = KINDS.has(r.kind) ? r.kind : "number";
  const role = r.role === "label" || kind === "text" ? "label" : "factor";
  return {
    id,
    label: String(r.label ?? "").trim() || id,
    kind: role === "label" ? "text" : kind,
    role
  };
}
function normalizeEstimateColumns(raw) {
  const parsed = Array.isArray(raw) ? raw.map(parseEstimateColumn).filter((c) => c != null) : [];
  const byId = new Map(parsed.map((c) => [c.id, c]));
  const system = DEFAULT_ESTIMATE_COLUMNS.map((d) => ({
    ...d,
    label: byId.get(d.id)?.label?.trim() || d.label
  }));
  const extras = parsed.filter((c) => !isSystemEstimateColumn(c.id));
  return [...system, ...extras];
}
function parseTemplateLine(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  const qty = typeof r.qty === "number" ? r.qty : parseNumber(r.qty);
  const rateRaw = r.rate;
  const rate = rateRaw == null || rateRaw === "" ? null : typeof rateRaw === "number" ? rateRaw : parseNumber(rateRaw);
  const extra = {};
  if (r.extra && typeof r.extra === "object" && !Array.isArray(r.extra)) {
    for (const [k, v] of Object.entries(r.extra)) {
      if (!k || isSystemEstimateColumn(k)) continue;
      extra[k] = v == null ? "" : String(v);
    }
  }
  return {
    description: String(r.description ?? ""),
    qty: Number.isFinite(qty) && qty !== 0 ? qty : 1,
    rate: rate != null && Number.isFinite(rate) ? rate : null,
    extra: Object.keys(extra).length ? extra : void 0
  };
}
function parseCostEstimateTemplates(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row;
    const id = String(r.id ?? "").trim();
    if (!id) continue;
    const parsed = Array.isArray(r.lines) ? r.lines.map(parseTemplateLine).filter((l) => l != null) : [];
    out.push({
      id,
      tenantId: String(r.tenantId ?? ""),
      name: String(r.name ?? "").trim() || "Untitled template",
      columns: normalizeEstimateColumns(r.columns),
      lines: parsed.length ? parsed : [{ description: "", qty: 1, rate: null }]
    });
  }
  return out;
}

// src/core/posting.ts
function defaultScenarioId(tenantId) {
  return `${tenantId}-scn-default`;
}
function scenarioFromEngineRoles(tenantId, accounts, name = "Standard ARO") {
  const map = {};
  for (const acc of accounts) {
    if (acc.engineRole) map[acc.engineRole] = acc.id;
  }
  return { id: defaultScenarioId(tenantId), tenantId, name, isDefault: true, accounts: map, completedRoles: [] };
}
function ensurePostingScenarios(settings, tenantId) {
  if (!settings.postingScenarios) settings.postingScenarios = [];
  if (!settings.aroAssetClasses) settings.aroAssetClasses = [];
  if (!settings.postingScenarios.length) {
    settings.postingScenarios.push(scenarioFromEngineRoles(tenantId, settings.accounts));
  }
  if (!settings.postingScenarios.some((s) => s.isDefault)) {
    settings.postingScenarios[0].isDefault = true;
  }
  for (const s of settings.postingScenarios) {
    if (!s.completedRoles) s.completedRoles = [];
  }
  return settings.postingScenarios;
}
function defaultScenario(settings, tenantId) {
  const list = ensurePostingScenarios(settings, tenantId);
  return list.find((s) => s.isDefault) ?? list[0];
}
function ensureEnginePostingRules(settings, tenantId) {
  if (!settings.postingRules) settings.postingRules = [];
  for (const [eventType, debitRole, creditRole] of ENGINE_POSTING_RULES) {
    if (settings.postingRules.some((r) => r.eventType === eventType)) continue;
    settings.postingRules.push({
      id: `pr-${tenantId}-${eventType}`,
      tenantId,
      eventType,
      debitRole,
      creditRole,
      engineEmitted: true
    });
  }
  const excess = settings.postingRules.find((r) => r.eventType === "downward-excess");
  if (excess && excess.debitRole === "Retirement cost asset") {
    excess.debitRole = "Accretion expense";
    excess.creditRole = "ARO provision";
  }
}
var ROLE_CLASS = {
  "ARO provision": ["Liability"],
  "Retirement cost asset": ["Asset"],
  "Accumulated depreciation": ["Asset"],
  "Accretion expense": ["Expense"],
  "Depreciation expense": ["Expense"],
  "Operating costs": ["Expense"],
  "Write-back to income": ["Income"],
  "Cash": ["Asset"],
  "Gain on disposal": ["Income"],
  "Loss on disposal": ["Expense"],
  "FX translation reserve": ["Equity"],
  "Suspense": ["Liability", "Asset", "Equity"]
};
var ROLE_NEEDLES = {
  "ARO provision": [
    "aro provision",
    "aro liability",
    "asset retirement obligation",
    "decommissioning provision",
    "decommissioning liability",
    "provision"
  ],
  "Retirement cost asset": [
    "retirement cost asset",
    "aro asset",
    "decommissioning asset",
    "asset retirement cost",
    "retirement cost",
    "capitalized"
  ],
  "Accumulated depreciation": [
    "accumulated depreciation",
    "accum dep",
    "accumulated amortisation",
    "accumulated amortization",
    "contra asset",
    "contra-asset"
  ],
  "Accretion expense": ["accretion", "unwinding", "unwind"],
  "Depreciation expense": [
    "depreciation expense",
    "depreciation",
    "amortization expense",
    "amortisation expense",
    "systematic allocation"
  ],
  "Operating costs": [
    "operating cost",
    "site restoration",
    "restoration expense",
    "settlement cost",
    "expensed as incurred",
    "remediation",
    "actual retirement cost paid"
  ],
  "Write-back to income": [
    "write back",
    "write-back",
    "writeback",
    "surplus provision",
    "recorded obligation over actual"
  ],
  "Cash": ["cash at bank", "cash", "bank"],
  "Gain on disposal": ["gain on disposal", "gain on sale", "disposal gain"],
  "Loss on disposal": ["loss on disposal", "loss on sale", "disposal loss"],
  "FX translation reserve": ["translation reserve", "foreign currency translation", "fx translation", "cta"],
  "Suspense": ["suspense"]
};
function normKey(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function accountFitForRole(acc, role) {
  const allowed = ROLE_CLASS[role];
  if (allowed && !allowed.includes(accountTypeOf(acc) || acc.cls)) return 0;
  const name = normKey(acc.name);
  const extra = normKey(Object.values(acc.columns ?? {}).join(" "));
  const hay = `${name} ${extra}`.trim();
  const roleN = normKey(role);
  if (!hay) return 0;
  if (role === "Retirement cost asset" && /contra/.test(hay)) return 0;
  if (role === "Operating costs" && /(accretion|unwind)/.test(hay)) return 0;
  if (role === "Depreciation expense" && /(contra|accumulated)/.test(hay)) return 0;
  if (role === "ARO provision" && /(twelve months|next year|near term|memo only|clearing|conditional)/.test(hay)) return 0;
  let best = 0;
  if (name === roleN) best = 900;
  else if (name.includes(roleN)) best = 800;
  for (const needle of ROLE_NEEDLES[role] ?? []) {
    if (hay.includes(needle)) best = Math.max(best, 100 + needle.length);
  }
  const roleWords = roleN.split(" ").filter((w) => w.length > 2);
  const nameWords = new Set(name.split(" "));
  const overlap = roleWords.filter((w) => nameWords.has(w)).length;
  if (overlap) best = Math.max(best, 50 * overlap);
  if (!best) return 0;
  if (acc.engineRole === role) best += 50;
  if (/\bparent\b/.test(hay) && /\bcontrol\b/.test(hay)) best += 250;
  return best;
}
function suggestRoleAccounts(accounts) {
  const result = {};
  const used = /* @__PURE__ */ new Set();
  const candidates = [];
  for (const role of ENGINE_ROLES) {
    for (const acc of accounts) {
      const score = accountFitForRole(acc, role);
      if (score >= 80) candidates.push({ role, id: acc.id, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));
  for (const c of candidates) {
    if (result[c.role] || used.has(c.id)) continue;
    result[c.role] = c.id;
    used.add(c.id);
  }
  return result;
}
function ensureRoleAccountsOnChart(settings, tenantId) {
  const suggestions = suggestRoleAccounts(settings.accounts);
  const codes = new Set(settings.accounts.map((a) => a.code));
  const ids = new Set(settings.accounts.map((a) => a.id));
  const segs = (settings.segments ?? []).filter((s) => s.required).map((s) => s.name);
  let added = 0;
  for (const [code, name, cls, role] of ENGINE_ROLE_GLS) {
    if (suggestions[role]) continue;
    if (settings.accounts.some((a) => a.engineRole === role)) continue;
    if (codes.has(code)) continue;
    let id = `${tenantId}-acc-${code}`;
    if (ids.has(id)) id = `acc-${tenantId}-${code}`;
    settings.accounts.push({
      id,
      tenantId,
      code,
      name,
      cls,
      engineRole: "",
      requiredSegments: segs,
      columns: {}
    });
    codes.add(code);
    ids.add(id);
    added += 1;
  }
  return added;
}
function alignDefaultScenarioFromChart(settings, tenantId) {
  ensurePostingScenarios(settings, tenantId);
  ensureRoleAccountsOnChart(settings, tenantId);
  const def = defaultScenario(settings, tenantId);
  const suggestions = suggestRoleAccounts(settings.accounts);
  const done = new Set(def.completedRoles ?? []);
  let changed = 0;
  for (const role of ENGINE_ROLES) {
    if (done.has(role) && def.accounts[role]) continue;
    const current = def.accounts[role];
    const held = current ? settings.accounts.find((a) => a.id === current) : void 0;
    if (held && accountFitForRole(held, role) > 0) continue;
    const suggested = suggestions[role];
    if (!suggested || current === suggested) continue;
    assignScenarioRole(settings, def.id, role, suggested);
    changed += 1;
  }
  return changed;
}
function classGlSuffix(label, ordinal) {
  const digits = label.replace(/\D/g, "");
  if (digits.length >= 2) {
    const n = parseInt(digits.slice(-2), 10);
    if (n > 0 && n < 90) return n;
  }
  return ordinal + 1;
}
function preferredClassCode(base, suffix) {
  if (base === "99999") return String(99800 + suffix);
  return String(parseInt(base, 10) + suffix);
}
function allocateAccountCode(taken, preferred) {
  if (/^\d{5}$/.test(preferred) && !taken.has(preferred)) return preferred;
  let n = parseInt((preferred.match(/\d{5}/) ?? ["18000"])[0], 10);
  if (!Number.isFinite(n) || n < 1e4 || n > 98999) n = 18e3;
  while (taken.has(String(n)) || String(n).length !== 5) n += 1;
  return String(n);
}
function ensureClassScenarioAccounts(settings, tenantId) {
  ensurePostingScenarios(settings, tenantId);
  const def = defaultScenario(settings, tenantId);
  const segs = (settings.segments ?? []).filter((s) => s.required).map((s) => s.name);
  const codes = new Set(settings.accounts.map((a) => a.code));
  const ids = new Set(settings.accounts.map((a) => a.id));
  const classScenarios = settings.postingScenarios.filter((s) => !s.isDefault);
  let changed = 0;
  classScenarios.forEach((scn, ordinal) => {
    const suffix = classGlSuffix(scn.name, ordinal);
    const done = new Set(scn.completedRoles ?? []);
    for (const [base, name, cls, role] of ENGINE_ROLE_GLS) {
      if (done.has(role) && scn.accounts[role]) continue;
      const current = scn.accounts[role];
      const shared = !current || current === def.accounts[role];
      if (!shared) continue;
      const preferred = preferredClassCode(base, suffix);
      const tagged = `${name} \u2014 ${scn.name}`;
      let acc = settings.accounts.find((a) => a.code === preferred) ?? settings.accounts.find((a) => a.name === tagged);
      if (!acc) {
        const code = allocateAccountCode(codes, preferred);
        let id = `${tenantId}-acc-${code}`;
        if (ids.has(id)) id = `acc-${tenantId}-${code}`;
        acc = {
          id,
          tenantId,
          code,
          name: tagged,
          cls,
          engineRole: "",
          requiredSegments: segs,
          columns: {}
        };
        settings.accounts.push(acc);
        codes.add(code);
        ids.add(id);
      }
      if (scn.accounts[role] !== acc.id) {
        assignScenarioRole(settings, scn.id, role, acc.id);
        changed += 1;
      }
    }
  });
  return changed;
}
function assignScenarioRole(settings, scenarioId, role, accountId) {
  const scenario = (settings.postingScenarios ?? []).find((s) => s.id === scenarioId);
  if (!scenario) return;
  if (!accountId) {
    delete scenario.accounts[role];
    scenario.completedRoles = (scenario.completedRoles ?? []).filter((r) => r !== role);
  } else {
    for (const [held, id] of Object.entries(scenario.accounts)) {
      if (held !== role && id === accountId) {
        delete scenario.accounts[held];
        scenario.completedRoles = (scenario.completedRoles ?? []).filter((r) => r !== held);
      }
    }
    scenario.accounts[role] = accountId;
  }
  if (!scenario.isDefault) return;
  for (const acc of settings.accounts) {
    if (acc.id === accountId) acc.engineRole = role;
    else if (acc.engineRole === role) acc.engineRole = "";
  }
}

// src/engine/rollforward.ts
var PROVISION_EVENT_TYPES = [
  "opening",
  "addition",
  "expense-recognition",
  "accretion",
  "revision",
  "revision-unproductive",
  "downward-excess",
  "settlement",
  "disposal",
  "fx"
];
var LEDGER_EVENT_TYPES = [
  ...PROVISION_EVENT_TYPES,
  "depreciation",
  "asset-retirement"
];

// src/core/tcaListing.ts
function norm(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function parseTcaAssetStatus(raw) {
  const n = norm(raw);
  if (!n) return null;
  if (/^(active|productive|in use|in productive use|productive use|yes)$/.test(n)) return "Active";
  if (/^(unproductive|not in use|not in productive use|idle)$/.test(n)) return "Unproductive";
  if (/^(disposed|disposed of|retired|sold)$/.test(n)) return "Disposed";
  return null;
}
function tcaAssetStatusOf(a) {
  if (a.assetStatus === "Unproductive" || a.assetStatus === "Disposed") return a.assetStatus;
  return "Active";
}
function cloneTcaAssets(assets) {
  return assets.map((a) => ({ ...a, columns: { ...a.columns ?? {} } }));
}
function captureOpeningSnapshot(data, now2) {
  return {
    tcaAssets: cloneTcaAssets(data.tcaAssets ?? []),
    obligationIds: (data.obligations ?? []).map((o) => o.id),
    lockedAt: now2
  };
}
function parseOpeningSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const v = raw;
  if (!Array.isArray(v.tcaAssets) || !Array.isArray(v.obligationIds)) return null;
  const tcaAssets = v.tcaAssets.map((row) => {
    const a = row && typeof row === "object" ? row : {};
    const fromPayload = tcaFieldsFromPayload(
      a.columns && typeof a.columns === "object" ? { ...a.columns } : {}
    );
    return {
      id: String(a.id ?? ""),
      assetNumber: String(a.assetNumber ?? ""),
      description: String(a.description ?? ""),
      assetClass: String(a.assetClass ?? ""),
      acquisitionDate: String(a.acquisitionDate ?? ""),
      site: String(a.site ?? ""),
      acquisitionCost: typeof a.acquisitionCost === "number" ? a.acquisitionCost : fromPayload.acquisitionCost,
      accumAmort: typeof a.accumAmort === "number" ? a.accumAmort : fromPayload.accumAmort,
      assetStatus: a.assetStatus ? tcaAssetStatusOf({ assetStatus: a.assetStatus }) : fromPayload.assetStatus,
      scope: a.scope === "In scope" || a.scope === "Scoped out" ? a.scope : "Undecided",
      scopeReason: String(a.scopeReason ?? ""),
      columns: fromPayload.columns
    };
  });
  return {
    tcaAssets,
    obligationIds: v.obligationIds.map((id) => String(id)),
    lockedAt: typeof v.lockedAt === "string" ? v.lockedAt : "",
    tcaFileKeys: Array.isArray(v.tcaFileKeys) ? v.tcaFileKeys.map((k) => String(k)) : void 0
  };
}
function ensureOpeningSnapshot(data, now2 = "") {
  if (data.openingSnapshot) return;
  if (!data.conversionAgreed) return;
  data.openingSnapshot = captureOpeningSnapshot(data, now2);
}
var TCA_COST_PAYLOAD_KEY = "_acquisitionCost";
var TCA_ACCUM_PAYLOAD_KEY = "_accumAmort";
var TCA_STATUS_PAYLOAD_KEY = "_assetStatus";
function takePayloadNumber(columns, key) {
  if (!(key in columns)) return null;
  const n = parseNumber(columns[key]);
  delete columns[key];
  return Number.isFinite(n) ? n : null;
}
function takePayloadStatus(columns) {
  if (!(TCA_STATUS_PAYLOAD_KEY in columns)) return "Active";
  const raw = columns[TCA_STATUS_PAYLOAD_KEY];
  delete columns[TCA_STATUS_PAYLOAD_KEY];
  return parseTcaAssetStatus(raw) ?? "Active";
}
function tcaFieldsFromPayload(payload) {
  const columns = { ...payload };
  return {
    acquisitionCost: takePayloadNumber(columns, TCA_COST_PAYLOAD_KEY),
    accumAmort: takePayloadNumber(columns, TCA_ACCUM_PAYLOAD_KEY),
    assetStatus: takePayloadStatus(columns),
    columns
  };
}
function tcaPayloadOf(a) {
  const payload = { ...a.columns ?? {} };
  delete payload[TCA_COST_PAYLOAD_KEY];
  delete payload[TCA_ACCUM_PAYLOAD_KEY];
  delete payload[TCA_STATUS_PAYLOAD_KEY];
  if (typeof a.acquisitionCost === "number") payload[TCA_COST_PAYLOAD_KEY] = a.acquisitionCost;
  if (typeof a.accumAmort === "number") payload[TCA_ACCUM_PAYLOAD_KEY] = a.accumAmort;
  payload[TCA_STATUS_PAYLOAD_KEY] = tcaAssetStatusOf(a);
  return payload;
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
      postingScenarios: true,
      aroAssetClasses: true,
      curves: { include: { points: { orderBy: { termYears: "asc" } } } },
      units: {
        include: {
          assumptions: true,
          periods: { orderBy: [{ fiscalYear: "asc" }, { no: "asc" }] },
          tcaAssets: true,
          obligations: { include: { costLines: true, revisions: true, layers: true, events: true, settlements: true } },
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
        lastSeen: m.lastSeen?.toISOString(),
        pendingInvite: !m.user.clerkUserId && !m.lastSeen
      };
      state.users.push(user);
    }
    const postingScenarios = t.postingScenarios.map(mapScenario);
    const aroAssetClasses = t.aroAssetClasses.map(mapAssetClass);
    const rawDefaults = t.settings?.defaults ?? {};
    const nestedTemplates = rawDefaults.costEstimateTemplates;
    const { costEstimateTemplates: _nested, ...defaultFields } = rawDefaults;
    const defaultsBase = defaultFields;
    const columnTemplates = t.settings ? parseCostEstimateTemplates(t.settings.costEstimateTemplates) : [];
    const settings = t.settings ? {
      accounts: t.accounts.map(mapAccount),
      segments: t.segments.map(mapSegment),
      postingRules: t.postingRules.map(mapRule),
      postingScenarios,
      aroAssetClasses,
      costEstimateTemplates: columnTemplates.length ? columnTemplates : parseCostEstimateTemplates(nestedTemplates),
      frameworks: FRAMEWORKS.map((f) => ({ ...f })),
      defaults: {
        ...defaultsBase,
        frameworkId: defaultsBase.frameworkId || "ifrs"
      },
      setup: t.settings.setup ?? null,
      retentionYears: t.settings.retentionYears,
      legalHold: t.settings.legalHold,
      sso: t.settings.sso,
      scim: t.settings.scim
    } : {
      accounts: t.accounts.map(mapAccount),
      segments: t.segments.map(mapSegment),
      postingRules: t.postingRules.map(mapRule),
      postingScenarios,
      aroAssetClasses,
      costEstimateTemplates: [],
      frameworks: FRAMEWORKS.map((f) => ({ ...f })),
      defaults: {
        inflation: 0.025,
        contingency: 0.1,
        dayCount: "30/360 US (DAYS360)",
        termConvention: "Round up to whole year (SAP)",
        calendarType: "Monthly (12)",
        frameworkId: "ifrs"
      },
      setup: null,
      retentionYears: 7,
      legalHold: false,
      sso: false,
      scim: false
    };
    ensureEnginePostingRules(settings, t.id);
    ensurePostingScenarios(settings, t.id);
    normalizeAroAssetClasses(settings);
    alignDefaultScenarioFromChart(settings, t.id);
    ensureClassScenarioAccounts(settings, t.id);
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
      locked: c.locked,
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
        setupCompletedAt: u.setupCompletedAt ? u.setupCompletedAt.toISOString() : null,
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
        dayCount: u.dayCount,
        layerPolicy: a?.layerPolicy ?? "LIFO",
        discount: a?.discount !== false
      };
    });
    state.units[t.id] = units;
    for (const u of t.units) {
      const freezeTickmarks = u.freezes.flatMap((f) => f.tickmarks);
      const data = {
        tcaAssets: u.tcaAssets.map(mapTcaAsset),
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
        openingGlProvision: u.openingGlProvision ?? null,
        openingGlArc: u.openingGlArc ?? null,
        openingGlAroCost: u.openingGlAroCost ?? null,
        openingGlAroAccum: u.openingGlAroAccum ?? null,
        openingGlTcaCost: u.openingGlTcaCost ?? null,
        openingGlTcaAccum: u.openingGlTcaAccum ?? null,
        openingSnapshot: parseOpeningSnapshot(u.openingSnapshot),
        conversionAgreed: u.conversionAgreed,
        noteGenerated: u.noteGenerated,
        yearLocked: u.yearLocked
      };
      state.data[u.id] = data;
      canonicalizeObligationClasses(settings, data);
      ensureOpeningSnapshot(data);
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
function mapColumns(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k) continue;
    if (typeof v === "string") out[k] = v;
    else if (v != null && typeof v !== "object") out[k] = String(v);
  }
  return out;
}
function mapAccount(a) {
  const columns = mapColumns(a.columns);
  return {
    id: a.id,
    tenantId: a.tenantId,
    code: a.code,
    name: a.name,
    cls: classFromColumns(columns) || a.className,
    engineRole: a.engineRole,
    requiredSegments: a.requiredSegments,
    columns
  };
}
function mapSegment(s) {
  return { id: s.id, tenantId: s.tenantId, ord: s.ord, name: s.name, required: s.required, permitted: s.permitted };
}
function mapRule(r) {
  return { id: r.id, tenantId: r.tenantId, eventType: r.eventType, debitRole: r.debitRole, creditRole: r.creditRole, engineEmitted: r.engineEmitted };
}
function mapScenario(s) {
  const raw = s.roleAccounts && typeof s.roleAccounts === "object" ? s.roleAccounts : {};
  const accounts = {};
  for (const [role, id] of Object.entries(raw)) {
    if (typeof id === "string" && id) accounts[role] = id;
  }
  const completedRoles = Array.isArray(s.completedRoles) ? s.completedRoles.filter((r) => typeof r === "string" && r.length > 0) : [];
  return { id: s.id, tenantId: s.tenantId, name: s.name, isDefault: s.isDefault, accounts, completedRoles };
}
function mapAssetClass(c) {
  return { id: c.id, tenantId: c.tenantId, code: c.code ?? "", name: c.name, scenarioId: c.scenarioId };
}
function mapTcaAsset(a) {
  const fromPayload = tcaFieldsFromPayload(mapColumns(a.payload));
  return {
    id: a.id,
    assetNumber: a.assetNumber,
    description: a.description,
    assetClass: a.assetClass,
    acquisitionDate: a.acquisitionDate,
    site: a.site,
    acquisitionCost: fromPayload.acquisitionCost,
    accumAmort: fromPayload.accumAmort,
    assetStatus: fromPayload.assetStatus,
    scope: a.scope === "In scope" || a.scope === "Scoped out" ? a.scope : "Undecided",
    scopeReason: a.scopeReason,
    columns: fromPayload.columns
  };
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
  const layers = o.layers.map((l) => ({
    id: l.id,
    aroseOn: l.aroseOn,
    direct: l.amount,
    rate: l.rate,
    lifeYears: l.lifeYears,
    method: l.method
  }));
  return {
    ...extra,
    id: o.id,
    ref: o.ref,
    description: o.description,
    costEstimateDate: o.costEstimateDate,
    settlementDate: o.settlementDate,
    lines,
    adj,
    layers: layers.length ? layers : void 0
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
  return {
    id: s.id,
    obligationId: s.obligationId,
    kind: s.kind,
    pct: s.pct,
    actualCost: s.actualCost,
    settledOn: s.settledOn,
    posted: s.posted,
    disposeAroAsset: s.disposeAroAsset ?? false,
    relatedAssetSold: s.relatedAssetSold ?? false
  };
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

// src/engine/curve.ts
var DEFAULT_TERM_CONVENTION = "Round up to whole year (SAP)";
function sortedPoints(curve) {
  return [...curve.points ?? []].sort((a, b) => a.term - b.term);
}
function curveTermOf(curve, tD, convention = DEFAULT_TERM_CONVENTION) {
  const pts = sortedPoints(curve);
  const last = pts.length ? pts[pts.length - 1].term : 0;
  let term;
  switch (convention) {
    case "Round up to whole year (SAP)":
      term = Math.ceil(tD);
      break;
    case "Round up to the next curve point": {
      const hit = pts.find((p) => p.term >= tD);
      term = hit ? hit.term : last;
      break;
    }
    case "Exact fractional years":
    default:
      term = tD;
      break;
  }
  return {
    term,
    capped: pts.length ? Math.min(term, last) : term,
    beyond: pts.length > 0 && term > last,
    convention
  };
}
function curveRateDetail(curve, term) {
  const pts = sortedPoints(curve);
  if (!pts.length) return { rate: 0, basis: "empty-curve", beyond: false };
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (term <= first.term) {
    return {
      rate: first.rate,
      basis: term === first.term ? "exact" : "below-first",
      beyond: false
    };
  }
  if (term > last.term) {
    return { ...extrapolate(pts, term, curve.extrapolation), beyond: true };
  }
  const exact = pts.find((p) => p.term === term);
  if (exact) return { rate: exact.rate, basis: "exact", beyond: false };
  if (curve.interpolation === "linear") {
    let lo = first;
    let hi = last;
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i].term <= term && term <= pts[i + 1].term) {
        lo = pts[i];
        hi = pts[i + 1];
        break;
      }
    }
    const span = hi.term - lo.term;
    const rate = span === 0 ? lo.rate : lo.rate + (term - lo.term) / span * (hi.rate - lo.rate);
    return { rate, basis: "linear", beyond: false };
  }
  const hit = pts.find((p) => p.term >= term) ?? last;
  return { rate: hit.rate, basis: "step", beyond: false };
}
function extrapolate(pts, term, policy) {
  const last = pts[pts.length - 1];
  if (pts.length < 2 || policy === "flat-last") {
    return { rate: last.rate, basis: "flat-last" };
  }
  const prev = pts[pts.length - 2];
  const span = last.term - prev.term;
  if (span === 0) return { rate: last.rate, basis: "flat-last" };
  if (policy === "log-linear") {
    if (prev.rate > 0 && last.rate > 0) {
      const slope2 = (Math.log(last.rate) - Math.log(prev.rate)) / span;
      return { rate: Math.exp(Math.log(last.rate) + slope2 * (term - last.term)), basis: "log-linear" };
    }
  }
  const slope = (last.rate - prev.rate) / span;
  return { rate: last.rate + slope * (term - last.term), basis: policy === "log-linear" ? "log-linear" : "linear" };
}

// src/engine/framework.ts
var FRAMEWORK_POLICIES = {
  ifrs: {
    id: "ifrs",
    name: "IFRS (IAS 37)",
    ratePerLayer: false,
    discounting: "required",
    inflateOnlyIfDiscounted: false,
    defaultLayerPolicy: "LIFO"
  },
  usgaap: {
    id: "usgaap",
    name: "US GAAP (ASC 410-20)",
    ratePerLayer: true,
    discounting: "required",
    inflateOnlyIfDiscounted: false,
    defaultLayerPolicy: "LIFO"
  },
  psas: {
    id: "psas",
    name: "PSAS (PS 3280)",
    ratePerLayer: false,
    discounting: "optional",
    inflateOnlyIfDiscounted: true,
    defaultLayerPolicy: "LIFO"
  },
  aspe: {
    id: "aspe",
    name: "ASPE (Section 3110)",
    ratePerLayer: true,
    discounting: "required",
    inflateOnlyIfDiscounted: false,
    defaultLayerPolicy: "LIFO"
  }
};
function frameworkPolicy(id) {
  if (id && id in FRAMEWORK_POLICIES) return FRAMEWORK_POLICIES[id];
  return FRAMEWORK_POLICIES.ifrs;
}
function num(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
function directOf(o) {
  return (o.lines ?? []).reduce((s, l) => s + num(l.qty) * num(l.rate), 0);
}
function consumeLayers(layers, reduction, policy) {
  let remaining = reduction;
  if (remaining <= 0) return layers;
  if (policy === "Pro-rata") {
    const total = layers.reduce((s, l) => s + l.direct, 0);
    if (total <= 0) return [];
    const take = Math.min(remaining, total);
    return layers.map((l) => ({ ...l, direct: l.direct - take * (l.direct / total) })).filter((l) => l.direct > 1e-9);
  }
  const next = layers.map((l) => ({ ...l }));
  const seq = policy === "FIFO" ? next : [...next].reverse();
  for (const l of seq) {
    if (remaining <= 0) break;
    const take = Math.min(l.direct, remaining);
    l.direct -= take;
    remaining -= take;
  }
  return next.filter((l) => l.direct > 1e-9);
}
function syncLayers(o, existing, lookupRate, policy) {
  const byId = new Map((existing ?? o.layers ?? []).map((l) => [l.id, l]));
  const base = directOf(o);
  let layers = [];
  if (base > 0) {
    const id = `${o.id}-layer-initial`;
    const prev = byId.get(id);
    const look = lookupRate(o.costEstimateDate);
    layers = [{
      id,
      aroseOn: o.costEstimateDate,
      direct: base,
      rate: prev?.rate ?? look.rate,
      lifeYears: prev?.lifeYears ?? look.lifeYears,
      method: "interest-method"
    }];
  }
  const costRevs = (o.adj ?? []).filter((a) => a.kind === "cost").sort((a, b) => {
    const c = cmpDate(a.date, b.date);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });
  for (const rev of costRevs) {
    const n = num(rev.amount);
    if (n > 0) {
      const id = `${rev.id}-layer`;
      const prev = byId.get(id);
      const look = lookupRate(rev.date);
      layers.push({
        id,
        aroseOn: rev.date,
        direct: n,
        rate: prev?.rate ?? look.rate,
        lifeYears: prev?.lifeYears ?? look.lifeYears,
        method: "interest-method"
      });
    } else if (n < 0) {
      layers = consumeLayers(layers, -n, policy);
    }
  }
  return layers;
}
function layerRateLookup(curve, settlementDate, convention, dayCount) {
  const dc = dayCount ?? DEFAULT_DAY_COUNT;
  return (aroseOn) => {
    const life = termYears(aroseOn, settlementDate, dc);
    const term = curveTermOf(curve, life, convention);
    const rate = curveRateDetail(curve, term.term);
    return { rate: rate.rate, lifeYears: term.term };
  };
}

// src/engine/derive.ts
function settlementAsAt(o, before) {
  const terms = (o.adj ?? []).filter((a) => a.kind === "term" && a.to && (!before || cmpDate(a.date, before) < 0)).sort((a, b) => cmpDate(a.date, b.date));
  return terms.length ? terms[terms.length - 1].to : o.settlementDate;
}
function settlementInForce(o) {
  return settlementAsAt(o);
}

// src/server/persist.ts
var CORE_OBLIGATION = /* @__PURE__ */ new Set([
  "id",
  "ref",
  "description",
  "costEstimateDate",
  "settlementDate",
  "lines",
  "adj",
  "layers"
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
            frameworks: FRAMEWORKS,
            setup: settings.setup ?? null,
            costEstimateTemplates: settings.costEstimateTemplates ?? [],
            retentionYears: settings.retentionYears,
            legalHold: settings.legalHold,
            sso: settings.sso,
            scim: settings.scim
          },
          update: {
            defaults: settings.defaults,
            frameworks: FRAMEWORKS,
            setup: settings.setup ?? null,
            costEstimateTemplates: settings.costEstimateTemplates ?? [],
            retentionYears: settings.retentionYears,
            legalHold: settings.legalHold,
            sso: settings.sso,
            scim: settings.scim
          }
        });
        alignDefaultScenarioFromChart(settings, tenant.id);
        ensureClassScenarioAccounts(settings, tenant.id);
        normalizeAroAssetClasses(settings);
        ensureEnginePostingRules(settings, tenant.id);
        await replaceAccounts(tx, tenant.id, settings.accounts);
        await replaceSegments(tx, tenant.id, settings.segments);
        await replaceRules(tx, tenant.id, settings.postingRules);
        await replaceScenarios(tx, tenant.id, settings.postingScenarios ?? [], settings.aroAssetClasses ?? []);
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
        const email = u.email.trim();
        let userId = u.id;
        const byId = await tx.appUser.findUnique({ where: { id: u.id } });
        if (!byId && email) {
          const twin = await tx.appUser.findFirst({
            where: { email: { equals: email, mode: "insensitive" } },
            orderBy: { createdAt: "asc" }
          });
          if (twin) userId = twin.id;
        }
        await tx.appUser.upsert({
          where: { id: userId },
          create: { id: userId, name: u.name, email: u.email },
          update: { name: u.name, email: u.email }
        });
        await tx.membership.upsert({
          where: { tenantId_userId: { tenantId: tenant.id, userId } },
          create: {
            tenantId: tenant.id,
            userId,
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
      await replaceUnits(tx, tenant.id, state.units[tenant.id] ?? [], state.data, state.curves[tenant.id] ?? []);
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
        requiredSegments: a.requiredSegments,
        columns: a.columns ?? {}
      },
      update: {
        code: a.code,
        name: a.name,
        className: a.cls,
        engineRole: a.engineRole,
        requiredSegments: a.requiredSegments,
        columns: a.columns ?? {}
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
async function replaceScenarios(tx, tenantId, scenarios, classes) {
  const keepScn = new Set(scenarios.map((s) => s.id));
  const keepCls = new Set(classes.map((c) => c.id));
  await tx.aroAssetClass.deleteMany({ where: { tenantId, id: { notIn: [...keepCls] } } });
  await tx.postingScenario.deleteMany({ where: { tenantId, id: { notIn: [...keepScn] } } });
  for (const s of scenarios) {
    await tx.postingScenario.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        tenantId,
        name: s.name,
        isDefault: s.isDefault,
        roleAccounts: s.accounts,
        completedRoles: s.completedRoles ?? []
      },
      update: {
        name: s.name,
        isDefault: s.isDefault,
        roleAccounts: s.accounts,
        completedRoles: s.completedRoles ?? []
      }
    });
  }
  for (const c of classes) {
    await tx.aroAssetClass.upsert({
      where: { id: c.id },
      create: { id: c.id, tenantId, code: c.code ?? "", name: c.name, scenarioId: c.scenarioId },
      update: { code: c.code ?? "", name: c.name, scenarioId: c.scenarioId }
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
        isDraft: c.isDraft ?? false,
        locked: c.locked ?? false
      },
      update: {
        name: c.name,
        currency: c.currency,
        source: c.source,
        basis: c.basis,
        interpolation: c.interpolation,
        extrapolation: c.extrapolation,
        asAt: c.asAt,
        isDraft: c.isDraft ?? false,
        locked: c.locked ?? false
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
async function replaceUnits(tx, tenantId, units, data, curves) {
  const keep = new Set(units.map((u) => u.id));
  if (keep.size === 0) {
    await tx.reportingUnit.deleteMany({ where: { tenantId } });
  } else {
    await tx.reportingUnit.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });
  }
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
        setupCompletedAt: u.setupCompletedAt ? new Date(u.setupCompletedAt) : null,
        glTotal: data[u.id]?.glTotal ?? null,
        openingGlProvision: data[u.id]?.openingGlProvision ?? null,
        openingGlArc: data[u.id]?.openingGlArc ?? null,
        openingGlAroCost: data[u.id]?.openingGlAroCost ?? null,
        openingGlAroAccum: data[u.id]?.openingGlAroAccum ?? null,
        openingGlTcaCost: data[u.id]?.openingGlTcaCost ?? null,
        openingGlTcaAccum: data[u.id]?.openingGlTcaAccum ?? null,
        openingSnapshot: data[u.id]?.openingSnapshot ?? null,
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
        setupCompletedAt: u.setupCompletedAt ? new Date(u.setupCompletedAt) : null,
        glTotal: data[u.id]?.glTotal ?? null,
        openingGlProvision: data[u.id]?.openingGlProvision ?? null,
        openingGlArc: data[u.id]?.openingGlArc ?? null,
        openingGlAroCost: data[u.id]?.openingGlAroCost ?? null,
        openingGlAroAccum: data[u.id]?.openingGlAroAccum ?? null,
        openingGlTcaCost: data[u.id]?.openingGlTcaCost ?? null,
        openingGlTcaAccum: data[u.id]?.openingGlTcaAccum ?? null,
        openingSnapshot: data[u.id]?.openingSnapshot ?? null,
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
        extrapolationPolicy: u.extrapolationPolicy,
        layerPolicy: u.layerPolicy ?? "LIFO",
        discount: u.discount !== false
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
        extrapolationPolicy: u.extrapolationPolicy,
        layerPolicy: u.layerPolicy ?? "LIFO",
        discount: u.discount !== false
      }
    });
    await persistUnitData(tx, u, data[u.id], curves);
  }
}
async function persistUnitData(tx, reportingUnit, data, curves) {
  if (!data) return;
  const unitId = reportingUnit.id;
  const unit = data;
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
  const keepTca = (unit.tcaAssets ?? []).map((a) => a.id);
  await tx.tcaAsset.deleteMany({ where: { reportingUnitId: unitId, id: { notIn: keepTca } } });
  for (const a of unit.tcaAssets ?? []) await upsertTcaAsset(tx, unitId, a);
  const keepObl = unit.obligations.map((o) => o.id);
  await tx.obligation.deleteMany({ where: { reportingUnitId: unitId, id: { notIn: keepObl } } });
  for (const o of unit.obligations) await upsertObligation(tx, reportingUnit, o, curves);
  const existingEvents = await tx.obligationEvent.findMany({
    where: { obligation: { reportingUnitId: unitId } },
    select: { id: true }
  });
  const haveEvent = new Set(existingEvents.map((e) => e.id));
  const opening = unit.events.filter((e) => e.type === "opening");
  const openingIds = opening.map((e) => e.id);
  if (openingIds.length === 0) {
    await tx.obligationEvent.deleteMany({
      where: { type: "opening", obligation: { reportingUnitId: unitId } }
    });
  } else {
    await tx.obligationEvent.deleteMany({
      where: {
        type: "opening",
        obligation: { reportingUnitId: unitId },
        id: { notIn: openingIds }
      }
    });
  }
  for (const e of opening) {
    await tx.obligationEvent.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        obligationId: e.obligationId,
        periodId: e.periodId,
        type: e.type,
        eventDate: e.date,
        amount: e.amount,
        derived: e.derived ?? false,
        sourceRowRef: e.sourceRowRef ?? null,
        note: e.note ?? null
      },
      update: {
        periodId: e.periodId,
        eventDate: e.date,
        amount: e.amount,
        derived: e.derived ?? false,
        sourceRowRef: e.sourceRowRef ?? null,
        note: e.note ?? null
      }
    });
  }
  const newEvents = unit.events.filter((e) => e.type !== "opening" && !haveEvent.has(e.id));
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
        posted: s.posted,
        disposeAroAsset: s.disposeAroAsset ?? false,
        relatedAssetSold: s.relatedAssetSold ?? false
      },
      update: {
        kind: s.kind,
        pct: s.pct,
        actualCost: s.actualCost,
        settledOn: s.settledOn,
        posted: s.posted,
        disposeAroAsset: s.disposeAroAsset ?? false,
        relatedAssetSold: s.relatedAssetSold ?? false
      }
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
async function upsertTcaAsset(tx, reportingUnitId, a) {
  const payload = tcaPayloadOf(a);
  await tx.tcaAsset.upsert({
    where: { id: a.id },
    create: {
      id: a.id,
      reportingUnitId,
      assetNumber: a.assetNumber,
      description: a.description,
      assetClass: a.assetClass,
      acquisitionDate: a.acquisitionDate,
      site: a.site,
      scope: a.scope,
      scopeReason: a.scopeReason,
      payload
    },
    update: {
      assetNumber: a.assetNumber,
      description: a.description,
      assetClass: a.assetClass,
      acquisitionDate: a.acquisitionDate,
      site: a.site,
      scope: a.scope,
      scopeReason: a.scopeReason,
      payload
    }
  });
}
async function upsertObligation(tx, unit, o, curves) {
  const payload = {};
  for (const [k, v] of Object.entries(o)) {
    if (!CORE_OBLIGATION.has(k)) payload[k] = v;
  }
  await tx.obligation.upsert({
    where: { id: o.id },
    create: {
      id: o.id,
      reportingUnitId: unit.id,
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
  const policy = frameworkPolicy(unit.frameworkId);
  const curve = curves.find((c) => c.id === unit.curveId);
  await tx.layer.deleteMany({ where: { obligationId: o.id } });
  if (policy.ratePerLayer && curve) {
    const layers = syncLayers(
      o,
      o.layers,
      layerRateLookup(curve, settlementInForce(o), unit.termConvention, unit.dayCount),
      unit.layerPolicy ?? policy.defaultLayerPolicy
    );
    if (layers.length) {
      await tx.layer.createMany({
        data: layers.map((l) => ({
          id: l.id,
          obligationId: o.id,
          aroseOn: l.aroseOn,
          amount: l.direct,
          rate: l.rate,
          lifeYears: l.lifeYears,
          method: l.method
        }))
      });
    }
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

// src/server/identity.ts
async function resolveAppUser(db, input) {
  const byClerk = await db.appUser.findUnique({ where: { clerkUserId: input.clerkUserId } });
  if (byClerk) {
    return db.appUser.update({
      where: { id: byClerk.id },
      data: { name: input.name, email: input.email || byClerk.email }
    });
  }
  const email = normalizeEmail(input.email);
  if (!email) {
    return db.appUser.create({
      data: { clerkUserId: input.clerkUserId, name: input.name, email: input.email }
    });
  }
  const pending = await db.appUser.findMany({
    where: { clerkUserId: null, email: { equals: email, mode: "insensitive" } },
    include: { memberships: { select: { id: true, tenantId: true } } },
    orderBy: { createdAt: "asc" }
  });
  const plan = planUserClaim(pending);
  if (!plan) {
    return db.appUser.create({
      data: { clerkUserId: input.clerkUserId, name: input.name, email: input.email }
    });
  }
  return db.$transaction(async (tx) => {
    for (const id of plan.dropMembershipIds) {
      await tx.membership.delete({ where: { id } });
    }
    for (const { membershipId } of plan.move) {
      await tx.membership.update({ where: { id: membershipId }, data: { userId: plan.keepId } });
    }
    for (const id of plan.deleteUserIds) {
      await tx.appUser.delete({ where: { id } });
    }
    return tx.appUser.update({
      where: { id: plan.keepId },
      data: {
        clerkUserId: input.clerkUserId,
        name: input.name || void 0,
        email: input.email || email
      }
    });
  });
}
async function findClerkUserIdByEmail(email) {
  try {
    const list = await clerk().users.getUserList({ emailAddress: [email], limit: 5 });
    const rows = Array.isArray(list) ? list : list.data;
    const match = rows.find(
      (u) => u.emailAddresses.some((e) => normalizeEmail(e.emailAddress) === normalizeEmail(email))
    );
    return match?.id ?? null;
  } catch {
    return null;
  }
}
async function sendClerkInvitation(email, redirectUrl) {
  try {
    await clerk().invitations.createInvitation({
      emailAddress: email,
      redirectUrl,
      notify: true,
      ignoreExisting: true,
      publicMetadata: { source: "aro-suite-tenant-invite" }
    });
    return "sent";
  } catch (err) {
    if (clerkErrorLooksDuplicate(err)) return "already";
    throw err;
  }
}
async function inviteToTenant(auth, tenantId, body, origin) {
  const membership = auth.memberships.find((m) => m.tenantId === tenantId);
  if (!membership) throw new HTTPException(403, { message: "Not a member of this tenant" });
  if (!canConfigureTenant(membership.role)) {
    throw new HTTPException(403, { message: "Only an engagement partner or firm admin can invite users." });
  }
  const email = normalizeEmail(body.email ?? "");
  const name = (body.name ?? "").trim() || email.split("@")[0] || "User";
  const role = (body.role ?? "preparer").trim();
  if (!isValidEmail(email)) throw new HTTPException(400, { message: "Enter a work email address." });
  if (!ROLES.some((r) => r.id === role)) throw new HTTPException(400, { message: "That role is not recognised." });
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new HTTPException(404, { message: "That tenant is not on this workspace." });
  const clerkUserId = await findClerkUserIdByEmail(email);
  let existing = clerkUserId ? await prisma.appUser.findUnique({ where: { clerkUserId } }) : null;
  if (!existing) {
    existing = await prisma.appUser.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      orderBy: { createdAt: "asc" }
    });
  }
  const user = existing ? await prisma.appUser.update({
    where: { id: existing.id },
    data: {
      name: name || existing.name,
      email: email || existing.email,
      ...clerkUserId && !existing.clerkUserId ? { clerkUserId } : {}
    }
  }) : await prisma.appUser.create({
    data: { name, email, clerkUserId: clerkUserId ?? void 0 }
  });
  const already = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId: user.id } }
  });
  if (!already) {
    await prisma.membership.create({
      data: {
        tenantId,
        userId: user.id,
        role,
        mfa: "Not enrolled",
        isOwner: false
      }
    });
  } else if (already.role !== role) {
    await prisma.membership.update({
      where: { id: already.id },
      data: { role }
    });
  }
  const roleLabel = roleById(role).label;
  const hasAccount = Boolean(user.clerkUserId);
  let message;
  if (hasAccount) {
    message = already ? `${name} already has an account and is on ${tenant.name} as ${roleLabel}. They will see this tenant the next time they sign in.` : `${name} already has an account. Added to ${tenant.name} as ${roleLabel} \u2014 they will see this tenant the next time they sign in.`;
  } else {
    try {
      const outcome = await sendClerkInvitation(email, inviteRedirectUrl(origin, process.env.APP_ORIGIN));
      message = outcome === "sent" ? `Invitation sent to ${email} as ${roleLabel} on ${tenant.name}.` : `${email} already has a pending Clerk invitation. They remain ${roleLabel} on ${tenant.name}.`;
    } catch (err) {
      const why = err instanceof Error ? err.message : "Clerk could not send the email";
      message = `Added ${name} as ${roleLabel} on ${tenant.name}, but the invitation email could not be sent (${why}).`;
    }
  }
  await appendAudit(prisma, [
    note(tenantId, void 0, auth.name || auth.email, "Invite user", "admin", message)
  ]);
  const state = await hydrateAppState(prisma, auth.tenantIds);
  return { message, state };
}

// src/server/auth.ts
async function authenticate(authorization) {
  if (!authorization?.startsWith("Bearer ")) {
    throw new HTTPException2(401, { message: "Sign in required" });
  }
  const token = authorization.slice(7);
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new HTTPException2(500, { message: "CLERK_SECRET_KEY is not set" });
  let clerkUserId;
  try {
    const payload = await verifyToken(token, { secretKey });
    if (!payload.sub) throw new Error("missing sub");
    clerkUserId = payload.sub;
  } catch {
    throw new HTTPException2(401, { message: "Invalid session" });
  }
  const user = await clerk().users.getUser(clerkUserId);
  const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email || "User";
  const appUser = await resolveAppUser(prisma, { clerkUserId, name, email });
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
  if (!m) throw new HTTPException2(403, { message: "Not a member of this tenant" });
  return m;
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
app.post("/api/tenants/:id/invites", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = await c.req.json();
  const result = await inviteToTenant(auth, id, body, c.req.header("Origin") ?? void 0);
  return c.json(result);
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
var GET = app.fetch.bind(app);
var POST = app.fetch.bind(app);
var PUT = app.fetch.bind(app);
var DELETE = app.fetch.bind(app);
var PATCH = app.fetch.bind(app);
var OPTIONS = app.fetch.bind(app);
var HEAD = app.fetch.bind(app);
var runtime = "nodejs";
var maxDuration = 30;
export {
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PATCH,
  POST,
  PUT,
  maxDuration,
  runtime
};
