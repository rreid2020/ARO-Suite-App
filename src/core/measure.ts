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

export function unitAssumptions(unit: ReportingUnit): Assumptions {
  return {
    inflation: unit.inflation,
    contingency: unit.contingency,
    termConvention: unit.termConvention as TermConvention,
    dayCount: unit.dayCount as DayCount,
    fyEnd: unit.fyEnd,
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

export function measureObligation(s: AppState, unit: ReportingUnit, o: Obligation): Derived {
  return derive(o, unitAssumptions(unit), unitDeriveOptions(s, unit));
}
