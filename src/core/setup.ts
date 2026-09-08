/**
 * Tenant company setup — a guided, persisted workflow that precedes the
 * reporting-unit measurement steps.
 *
 * Completion is derived from live data so a refresh cannot lose progress.
 * The one exception is measurement defaults, which always have values: the
 * user must confirm them once.
 *
 * Reporting units come first: name the legal entity, then the people, authority,
 * cost-estimate templates and curve library. Chart of accounts and posting rules
 * are confirmed on the reporting unit before Prepare. The GL itself is the
 * organisation's, shared across units on the tenant.
 */

import { DOMAINS, roleById } from './authority';
import { unitNeedsDiscountCurve } from './createUnit';
import { hasProvisionMapping, postingRulesReady } from './posting';
import { AppState, SetupStepId, TenantSetup } from './types';

export type { SetupStepId };

export const SETUP_STEPS: { id: SetupStepId; label: string; purpose: string }[] = [
  {
    id: 'unit',
    label: 'Reporting units',
    purpose: 'The legal entity, its year end and currency. Open a unit to set measurement, chart, posting, the fiscal calendar and the opening register before Prepare.',
  },
  {
    id: 'users',
    label: 'Users & roles',
    purpose: 'Who can prepare, review, sign off and administer this tenant. The role list is fixed.',
  },
  {
    id: 'authority',
    label: 'Authority & security',
    purpose: 'Which of the six domains this tenant writes, and how long the append-only history is kept.',
  },
  {
    id: 'frameworks',
    label: 'Frameworks',
    purpose: 'The default reporting framework copied onto a new reporting unit. Policy axes are engine vocabulary and are not editable.',
  },
  {
    id: 'defaults',
    label: 'Measurement defaults',
    purpose: 'Inflation, contingency, day count and settlement term rounding applied to a new reporting unit.',
  },
  {
    id: 'estimates',
    label: 'Cost estimate templates',
    purpose: 'Reusable cost build-ups applied when posting a new ARO. Add factor columns so the amount is their product (for example Rate / SQ.M × area × contamination %). Optional — a template can be one line or many.',
  },
  {
    id: 'curve',
    label: 'Discount curve',
    purpose: 'A published curve with points, so a reporting unit has a discount rate to look up.',
  },
];

export interface SetupProgress {
  complete: boolean;
  current: SetupStepId;
  firstIncomplete: SetupStepId | null;
  ready: Record<SetupStepId, boolean>;
}

export function emptySetup(now = new Date().toISOString()): TenantSetup {
  return {
    current: 'unit',
    savedAt: now,
    defaultsConfirmedAt: null,
    completedAt: null,
  };
}

export function patchSetup(
  existing: TenantSetup | null | undefined,
  patch: Partial<Omit<TenantSetup, 'current'>> & { current?: string },
  now = new Date().toISOString(),
): TenantSetup {
  const next: TenantSetup = {
    ...(existing ?? emptySetup(now)),
    ...patch,
    current: coerceSetupStep(patch.current ?? existing?.current),
    savedAt: now,
  };
  return next;
}

/** Leftover company-setup ids from when chart and posting lived on the tenant wizard. */
function coerceSetupStep(id: string | undefined): SetupStepId {
  if (id === 'accounts' || id === 'posting') return 'curve';
  if (id && SETUP_STEPS.some((s) => s.id === id)) return id as SetupStepId;
  return 'unit';
}

export function nextSetupStep(id: SetupStepId): SetupStepId | null {
  const i = SETUP_STEPS.findIndex((s) => s.id === id);
  return SETUP_STEPS[i + 1]?.id ?? null;
}

export function setupProgress(state: AppState, tenantId: string): SetupProgress {
  const settings = state.settings[tenantId];
  const units = state.units[tenantId] ?? [];
  const curves = state.curves[tenantId] ?? [];
  const saved = settings?.setup;
  const frameworkId = settings?.defaults.frameworkId || 'ifrs';

  const hasUnit = units.length > 0;
  const ready: Record<SetupStepId, boolean> = {
    // Ready on this step means a unit can actually be measured — a unit with a
    // published curve assigned — not merely that a row exists. The wizard can
    // still continue once a unit exists (`walkable` below).
    unit: units.some((u) => unitHasUsableCurve(state, tenantId, u.curveId)),
    users: state.users.some((u) => u.tenantId === tenantId && roleById(u.role).sign === 2),
    authority: DOMAINS.every((d) => Boolean(state.authority[tenantId]?.[d.id])),
    frameworks: (settings?.frameworks ?? []).some((f) => f.id === frameworkId),
    defaults: Boolean(saved?.defaultsConfirmedAt),
    estimates: true,
    curve: curves.some((c) => unitHasUsableCurve(state, tenantId, c.id)),
  };

  // Sequencing must not trap on reporting units until a curve exists; the curve
  // is a later step. A unit with no assigned table is still enough to walk on.
  const walkable: Record<SetupStepId, boolean> = { ...ready, unit: hasUnit };
  const measurable = ready.unit;
  const complete = SETUP_STEPS.every((s) => walkable[s.id]) && measurable;
  const firstIncomplete = SETUP_STEPS.find((s) => !walkable[s.id])?.id
    ?? (measurable ? null : 'curve');
  const current = firstIncomplete ?? coerceSetupStep(saved?.current);

  return { complete, current, firstIncomplete, ready };
}

export function unitHasUsableCurve(state: AppState, tenantId: string, curveId: string): boolean {
  if (!curveId) return false;
  const curve = (state.curves[tenantId] ?? []).find((c) => c.id === curveId);
  return Boolean(curve && !curve.isDraft && curve.points.length > 0);
}

/** Company-level blockers on a reporting unit — not the empty register. */
export function unitSetupBlockers(
  state: AppState,
  tenantId: string,
  unit: { curveId: string; frameworkId?: string; discount?: boolean },
): string[] {
  const blockers: string[] = [];
  if (unitNeedsDiscountCurve({ frameworkId: unit.frameworkId ?? 'ifrs', discount: unit.discount })
    && !unitHasUsableCurve(state, tenantId, unit.curveId)) {
    blockers.push('No discount curve assigned');
  }
  const st = state.settings[tenantId];
  if (!st || !hasProvisionMapping(st, tenantId)) {
    blockers.push('ARO provision account not mapped');
  } else if (!postingRulesReady(st)) {
    blockers.push('Engine posting rules incomplete');
  }
  return blockers;
}

/** Company setup is the only Firm home. A leftover `units` screen id opens the reporting-units step. */
export function landingScreen(state: AppState, tenantId: string): string {
  return setupProgress(state, tenantId).complete ? 'units' : 'setup';
}

export function stepIndex(id: SetupStepId): number {
  return SETUP_STEPS.findIndex((s) => s.id === id);
}

/** Steps stay reachable so a unit created early can still be finished in the wizard. */
export function canOpenStep(_progress: SetupProgress, _id: SetupStepId): boolean {
  return true;
}
