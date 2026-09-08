/**
 * Create a reporting unit from tenant defaults.
 *
 * Inflation, contingency, day count and the term convention are copied onto
 * the unit at creation — INVARIANTS §9. After that they belong to the unit.
 *
 * The discount curve is a library table with an as-at date. The unit holds a
 * pointer (`curveId`) to the table currently in force — it does not own the
 * points. A later year end is a new published table plus a revaluation, not an
 * edit of last year's rates.
 */

import { roleById } from './authority';
import { isValidDate } from '../engine/dates';
import { isPublishedCurve, TermConvention } from '../engine/curve';
import { DayCount } from '../engine/dates';
import { frameworkPolicy, layerRateLookup, syncLayers, unitDiscounts } from '../engine/framework';
import { settlementInForce } from '../engine/derive';
import { buildCalendar, CalendarType } from './periods';
import { hasProvisionMapping, postingRulesReady } from './posting';
import { AppState, ReportingUnit } from './types';
import { emptyRecalcRegister } from './recalc';

export function publishedCurves(s: AppState, tenantId: string) {
  return (s.curves[tenantId] ?? []).filter((c) => isPublishedCurve(c));
}

/** Prefer a published table in the unit's currency; never a draft or an empty shell. */
export function pickCurveForUnit(s: AppState, tenantId: string, currency: string): string {
  const published = publishedCurves(s, tenantId);
  return published.find((c) => c.currency === currency)?.id ?? published[0]?.id ?? '';
}

/**
 * The closing table for year-end revaluation is the published table in this
 * unit's currency whose as-at equals the unit's year end — not "whichever row
 * is first" and not the table already in force for in-year accretion.
 */
export function suggestedClosingCurve(
  s: AppState,
  tenantId: string,
  unit: { currency: string; fyEnd: string; curveId: string },
) {
  const published = publishedCurves(s, tenantId).filter((c) => c.currency === unit.currency && c.asAt === unit.fyEnd);
  return published.find((c) => c.id !== unit.curveId) ?? published[0];
}

export function unitsUsingCurve(s: AppState, tenantId: string, curveId: string): { entity: string; how: 'in force' | 'prior' }[] {
  const hits: { entity: string; how: 'in force' | 'prior' }[] = [];
  for (const u of s.units[tenantId] ?? []) {
    if (u.curveId === curveId) hits.push({ entity: u.entity, how: 'in force' });
    if (u.priorCurveId === curveId) hits.push({ entity: u.entity, how: 'prior' });
  }
  return hits;
}

export function curveDeleteBlocker(s: AppState, tenantId: string, curveId: string): string | null {
  const hits = unitsUsingCurve(s, tenantId, curveId);
  if (!hits.length) return null;
  return `Held as ${hits.map((h) => `${h.how} on ${h.entity}`).join(', ')}. Reassign those reporting units first.`;
}

export function deleteCurve(s: AppState, tenantId: string, curveId: string): boolean {
  if (curveDeleteBlocker(s, tenantId, curveId)) return false;
  const list = s.curves[tenantId] ?? [];
  const next = list.filter((c) => c.id !== curveId);
  if (next.length === list.length) return false;
  s.curves[tenantId] = next;
  return true;
}

export function unitsMissingPublishedCurve(s: AppState, tenantId: string): ReportingUnit[] {
  const published = publishedCurves(s, tenantId);
  if (!published.length) return [];
  return (s.units[tenantId] ?? []).filter((u) =>
    unitNeedsDiscountCurve(u) && !published.some((c) => c.id === u.curveId));
}

/** True when the engine will look a discount rate up for this unit. PSAS may opt out. */
export function unitNeedsDiscountCurve(unit: Pick<ReportingUnit, 'frameworkId' | 'discount'>): boolean {
  return unitDiscounts(frameworkPolicy(unit.frameworkId), unit.discount);
}

/**
 * Point a unit at a published table when it has none, or when the id it holds
 * is missing, a draft, or has no points. Does not rewrite inflation or other
 * unit-level assumptions.
 */
export function assignMissingCurves(s: AppState, tenantId: string): string[] {
  const published = publishedCurves(s, tenantId);
  const updated: string[] = [];
  for (const u of unitsMissingPublishedCurve(s, tenantId)) {
    const id = published.find((c) => c.currency === u.currency)?.id ?? published[0]?.id ?? '';
    if (!id || id === u.curveId) continue;
    u.curveId = id;
    updated.push(u.entity);
  }
  return updated;
}

export function addReportingUnit(
  s: AppState,
  args: { tenantId: string; entity: string; fyEnd: string; currency: string; sector?: string },
): string {
  const n = (s.units[args.tenantId] ?? []).length;
  const id = `u-${Date.now().toString(36)}-${n}`;
  const partner = s.users.find((x) => x.tenantId === args.tenantId && roleById(x.role).sign === 2);
  const defaults = s.settings[args.tenantId].defaults;
  const curveId = pickCurveForUnit(s, args.tenantId, args.currency);
  const unit: ReportingUnit = {
    id,
    tenantId: args.tenantId,
    entity: args.entity.trim(),
    client: args.entity.trim(),
    fyEnd: args.fyEnd,
    currency: args.currency,
    sector: args.sector ?? 'Mining',
    partnerUserId: partner?.id ?? '',
    frameworkId: defaults.frameworkId || 'ifrs',
    jurisdiction: '',
    calendarType: defaults.calendarType,
    latePolicy: 'Prior-period adjustment',
    status: 'Not started',
    stage: 'Prepare',
    setupCompletedAt: null,
    inflation: defaults.inflation,
    contingency: defaults.contingency,
    curveId,
    termConvention: defaults.termConvention,
    materialityUsd: 0,
    materialityPct: 0,
    extrapolationPolicy: 'flat-last',
    dayCount: defaults.dayCount,
    layerPolicy: 'LIFO',
    discount: true,
  };
  (s.units[args.tenantId] ??= []).push(unit);
  s.data[id] = {
    recalc: emptyRecalcRegister(unit.fyEnd),
    tcaAssets: [],
    obligations: [], events: [], extracts: [], batches: [], settlements: [],
    freezes: [], samples: [], tickmarks: [], signatures: [],
    periods: buildCalendar(id, args.fyEnd, unit.calendarType),
    attestedGates: [], glTotal: null, openingGlProvision: null, openingGlArc: null,
    openingGlAroCost: null, openingGlAroAccum: null,
    openingGlTcaCost: null, openingGlTcaAccum: null, openingSnapshot: null, conversionAgreed: false,
    noteGenerated: false, yearLocked: false,
  };
  return id;
}

/** True when company setup may still rewrite the unit's legal identity. */
export function unitIdentityLocked(s: AppState, unit: ReportingUnit): boolean {
  if (unit.status !== 'Not started') return true;
  return (s.data[unit.id]?.obligations.length ?? 0) > 0;
}

/** True when Open should skip Unit settings and land on Prepare. */
export function unitSetupComplete(s: AppState, unit: ReportingUnit): boolean {
  if (unit.setupCompletedAt) return true;
  return unitIdentityLocked(s, unit);
}

export interface ReportingUnitIdentity {
  entity?: string;
  fyEnd?: string;
  currency?: string;
  frameworkId?: string;
  curveId?: string;
  calendarType?: CalendarType;
  inflation?: number;
  contingency?: number;
  dayCount?: string;
  termConvention?: string;
  /** PSAS: false dispenses with discounting. Required frameworks ignore this. */
  discount?: boolean;
}

/**
 * Rewrite identity on a unit that has not started. A started unit keeps the
 * year end, currency and legal name it was created with — those drive the
 * fiscal calendar and the measurement already in play.
 */
export function updateReportingUnit(
  s: AppState,
  tenantId: string,
  unitId: string,
  patch: ReportingUnitIdentity,
): string | null {
  const u = (s.units[tenantId] ?? []).find((x) => x.id === unitId);
  if (!u) return 'That reporting unit is not on this tenant.';
  const identityPatch = patch.entity !== undefined || patch.fyEnd !== undefined || patch.currency !== undefined;
  if (identityPatch && unitIdentityLocked(s, u)) {
    return `${u.entity} has started. Its legal name, year end and currency cannot change from company setup.`;
  }
  if (patch.entity !== undefined) {
    const name = patch.entity.trim();
    if (!name) return 'The entity name cannot be empty.';
    u.entity = name;
    u.client = name;
  }
  if (patch.fyEnd !== undefined) {
    if (!isValidDate(patch.fyEnd)) return 'The financial year end is not a date.';
    if (patch.fyEnd !== u.fyEnd) {
      u.fyEnd = patch.fyEnd;
      const data = s.data[u.id];
      if (data) data.periods = buildCalendar(u.id, u.fyEnd, u.calendarType);
    }
  }
  if (patch.currency !== undefined && patch.currency !== u.currency) {
    u.currency = patch.currency;
    const current = (s.curves[tenantId] ?? []).find((c) => c.id === u.curveId);
    if (!current || current.currency !== u.currency) {
      u.curveId = pickCurveForUnit(s, tenantId, u.currency);
    }
  }
  if (patch.frameworkId !== undefined) u.frameworkId = patch.frameworkId;
  if (patch.discount !== undefined) u.discount = patch.discount;
  if (patch.inflation !== undefined) u.inflation = patch.inflation;
  if (patch.contingency !== undefined) u.contingency = patch.contingency;
  if (patch.dayCount !== undefined) u.dayCount = patch.dayCount;
  if (patch.termConvention !== undefined) u.termConvention = patch.termConvention;
  if (patch.calendarType !== undefined && patch.calendarType !== u.calendarType) {
    u.calendarType = patch.calendarType;
    const data = s.data[u.id];
    if (data) data.periods = buildCalendar(u.id, u.fyEnd, u.calendarType);
  }
  if (patch.curveId !== undefined) {
    if (patch.curveId) {
      const published = publishedCurves(s, tenantId).find((c) => c.id === patch.curveId);
      if (!published) return 'That table is not a published curve in the library.';
    }
    u.curveId = patch.curveId;
  }
  return null;
}

/** Mark this unit's own settings confirmed so Open proceeds to Prepare. */
export function completeUnitSetup(s: AppState, tenantId: string, unitId: string, now = new Date().toISOString()): string | null {
  const u = (s.units[tenantId] ?? []).find((x) => x.id === unitId);
  if (!u) return 'That reporting unit is not on this tenant.';
  if (unitNeedsDiscountCurve(u)) {
    const curve = (s.curves[tenantId] ?? []).find((c) => c.id === u.curveId);
    if (!curve || curve.isDraft || !curve.points.length) {
      return `${u.entity} needs a published discount curve before Prepare.`;
    }
  }
  const settings = s.settings[tenantId];
  if (!settings || !hasProvisionMapping(settings, tenantId)) {
    return `${u.entity} needs ARO provision mapped on a posting scenario before Prepare.`;
  }
  if (!postingRulesReady(settings)) {
    return `${u.entity} needs engine posting rules before Prepare.`;
  }
  u.setupCompletedAt = now;
  return null;
}

/**
 * Remove a unit that has not started. A started unit — or one that already
 * holds obligations — keeps its records; those are the measurement, not a
 * draft of company setup.
 */
export function deleteReportingUnit(s: AppState, tenantId: string, unitId: string): string | null {
  const list = s.units[tenantId] ?? [];
  const u = list.find((x) => x.id === unitId);
  if (!u) return 'That reporting unit is not on this tenant.';
  if (unitIdentityLocked(s, u)) {
    return `${u.entity} has started. It cannot be deleted from company setup.`;
  }
  s.units[tenantId] = list.filter((x) => x.id !== unitId);
  delete s.data[unitId];
  return null;
}

/**
 * Lock rates onto stored layers for US GAAP / ASPE, and clear stored layers
 * when the unit is back on a single-rate framework. Existing layer rates are
 * kept; only a newly appeared increment looks the in-force curve up.
 */
export function stampUnitLayers(s: AppState, unit: ReportingUnit): void {
  const data = s.data[unit.id];
  if (!data) return;
  const policy = frameworkPolicy(unit.frameworkId);
  if (!policy.ratePerLayer) {
    for (const o of data.obligations) o.layers = undefined;
    return;
  }
  const curve = (s.curves[unit.tenantId] ?? []).find((c) => c.id === unit.curveId);
  if (!curve) return;
  for (const o of data.obligations) {
    o.layers = syncLayers(
      o,
      o.layers,
      layerRateLookup(curve, settlementInForce(o), unit.termConvention as TermConvention, unit.dayCount as DayCount),
      unit.layerPolicy ?? policy.defaultLayerPolicy,
    );
  }
}

export function stampLayeredUnits(s: AppState): void {
  for (const t of s.tenants) {
    for (const u of s.units[t.id] ?? []) stampUnitLayers(s, u);
  }
}
