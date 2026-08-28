/**
 * Running the engine over a reporting unit.
 *
 * The engine is pure and knows nothing about the store, so this is the one
 * adapter between them: it assembles the unit's assumptions and curve, derives
 * every obligation, and memoises the result.
 */

import { useMemo } from 'react';
import { Curve, TermConvention } from '../engine/curve';
import { Assumptions, Derived, derive, Obligation } from '../engine/derive';
import { rollForward, annualRollForward, RollForward } from '../engine/rollforward';
import { useStore, useUnit, useUnitData } from './store';

export interface DerivedUnit {
  assumptions: Assumptions;
  curve: Curve | null;
  priorCurve: Curve | null;
  /** In-scope obligations only — a scoped-out row is not measured. */
  rows: Derived[];
  /** Every row, including scoped-out, keyed by obligation id. */
  byId: Map<string, Derived>;
  total: number;
  /** Rows whose provision exceeds the unit's materiality. */
  material: Derived[];
  periods: RollForward[];
  annual: RollForward;
  /** Rows where an input could not be read — reported, never dropped. */
  invalid: { obligation: Obligation; reason: string }[];
}

export function useDerived(): DerivedUnit | null {
  const { state } = useStore();
  const unit = useUnit();
  const data = useUnitData();

  return useMemo(() => {
    if (!unit || !data) return null;

    const curves = state.curves[unit.tenantId] ?? [];
    const curve = curves.find((c) => c.id === unit.curveId) ?? null;
    const priorCurve = curves.find((c) => c.id === unit.priorCurveId) ?? null;

    const assumptions: Assumptions = {
      inflation: unit.inflation,
      contingency: unit.contingency,
      termConvention: unit.termConvention as TermConvention,
      fyEnd: unit.fyEnd,
      priorInflation: unit.priorInflation,
      materialityUsd: unit.materialityUsd,
      materialityPct: unit.materialityPct,
    };

    const blank: Curve = {
      id: '', name: 'No curve assigned', currency: unit.currency,
      source: '', basis: '', interpolation: 'step', extrapolation: 'flat-last',
      asAt: unit.fyEnd, points: [],
    };

    const invalid: DerivedUnit['invalid'] = [];
    const byId = new Map<string, Derived>();
    const rows: Derived[] = [];

    for (const o of data.obligations) {
      const d = derive(o, assumptions, { curve: curve ?? blank, priorCurve: priorCurve ?? undefined });
      byId.set(o.id, d);

      // INVARIANTS §5 — a row failing validation stays in the register and is
      // reported. Dropping it would be a completeness assertion nobody made.
      if (!Number.isFinite(d.pv)) {
        invalid.push({ obligation: o, reason: 'The provision could not be measured from the inputs given.' });
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.settlementDate))) {
        invalid.push({ obligation: o, reason: 'The expected settlement date is not a date.' });
      } else if (!curve) {
        invalid.push({ obligation: o, reason: 'No discount curve is assigned to this reporting unit, so the rate could not be looked up.' });
      }

      if (o.status !== 'Scoped out') rows.push(d);
    }

    const total = rows.reduce((s, d) => s + (Number.isFinite(d.pv) ? d.pv : 0), 0);
    const threshold = Math.max(unit.materialityUsd, total * unit.materialityPct);
    const material = rows.filter((d) => Math.abs(d.pv) >= threshold);

    const periods = data.periods.map((p, i) =>
      rollForward(data.events, p.id, i === data.periods.length - 1 ? total : null),
    );

    return {
      assumptions, curve, priorCurve, rows, byId, total, material,
      periods, annual: annualRollForward(periods), invalid,
    };
  }, [state.curves, unit, data]);
}
