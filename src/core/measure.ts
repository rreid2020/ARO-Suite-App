/**
 * Assemble the engine inputs for a reporting unit from application state.
 *
 * useDerived memoises a whole-unit run; in-year posting measures one
 * obligation at the moment the user records the transaction.
 */

import { Curve, TermConvention } from '../engine/curve';
import { DayCount } from '../engine/dates';
import { Assumptions, DeriveOptions, Derived, Obligation, derive } from '../engine/derive';
import type { AppState, ReportingUnit } from './types';

/**
 * Engine assumptions for one measurement. `asAt` is the valuation date the
 * chain calls fyEnd: opening uses conversion (prior year end), in-year posting
 * uses the period end, and year-end processes use the unit's financial year end.
 */
export function unitAssumptions(unit: ReportingUnit, asAt?: string): Assumptions {
  return {
    inflation: unit.inflation,
    contingency: unit.contingency,
    termConvention: unit.termConvention as TermConvention,
    dayCount: unit.dayCount as DayCount,
    fyEnd: asAt || unit.fyEnd,
    priorInflation: unit.priorInflation,
    materialityUsd: unit.materialityUsd,
    materialityPct: unit.materialityPct,
  };
}

export function unitCurve(s: AppState, unit: ReportingUnit): Curve | undefined {
  return (s.curves[unit.tenantId] ?? []).find((c) => c.id === unit.curveId);
}

export function unitPriorCurve(s: AppState, unit: ReportingUnit): Curve | undefined {
  return (s.curves[unit.tenantId] ?? []).find((c) => c.id === unit.priorCurveId);
}

function blankCurve(unit: ReportingUnit): Curve {
  return {
    id: '', name: 'No curve assigned', currency: unit.currency,
    source: '', basis: '', interpolation: 'step', extrapolation: 'flat-last',
    asAt: unit.fyEnd, points: [],
  };
}

export function unitDeriveOptions(s: AppState, unit: ReportingUnit): DeriveOptions {
  const curve = unitCurve(s, unit);
  const priorCurve = unitPriorCurve(s, unit);
  return {
    curve: curve ?? blankCurve(unit),
    priorCurve: priorCurve ?? undefined,
    framework: unit.frameworkId,
    discount: unit.discount,
    layerPolicy: unit.layerPolicy,
  };
}

export function measureObligation(s: AppState, unit: ReportingUnit, o: Obligation, asAt?: string): Derived {
  return derive(o, unitAssumptions(unit, asAt), unitDeriveOptions(s, unit));
}

/** Future value at settlement of the given population, as at `asAt` (or the unit year end). */
export function populationFv(s: AppState, unit: ReportingUnit, obligations: Obligation[], asAt?: string): number {
  const assumptions = unitAssumptions(unit, asAt);
  const opts = unitDeriveOptions(s, unit);
  let fv = 0;
  for (const o of obligations) {
    const d = derive(o, assumptions, opts);
    if (Number.isFinite(d.fv)) fv += d.fv;
  }
  return Math.round(fv * 100) / 100;
}
