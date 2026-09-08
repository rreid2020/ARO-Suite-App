/**
 * Resolve which imported GL an engine role posts to for a given obligation.
 *
 * The engine still posts by role (ARO provision, retirement cost asset, …).
 * The organisation's chart can hold many GLs for the same role. Distinct
 * asset classes each get a posting scenario that names one imported account
 * per role. An obligation's class selects that scenario; no class uses the default.
 */

import { ENGINE_EVENT_TYPES, ENGINE_POSTING_RULES, ENGINE_ROLE_GLS, ENGINE_ROLES } from '../seed';
import type { Account, AroAssetClass, Obligation, PostingScenario, TenantSettings } from './types';
import { accountTypeOf } from './accountType';
import { findAssetClass } from './assetClass';

export function defaultScenarioId(tenantId: string): string {
  return `${tenantId}-scn-default`;
}

export function scenarioFromEngineRoles(tenantId: string, accounts: Account[], name = 'Standard ARO'): PostingScenario {
  const map: Record<string, string> = {};
  for (const acc of accounts) {
    if (acc.engineRole) map[acc.engineRole] = acc.id;
  }
  return { id: defaultScenarioId(tenantId), tenantId, name, isDefault: true, accounts: map, completedRoles: [] };
}

/** Ensure at least a default scenario exists, synthesized from leftover account.engineRole rows. */
export function ensurePostingScenarios(settings: TenantSettings, tenantId: string): PostingScenario[] {
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

type PostingSubject = Pick<Obligation, 'id'> & { aroAssetClass?: unknown; type?: unknown };

export function defaultScenario(settings: TenantSettings, tenantId: string): PostingScenario {
  const list = ensurePostingScenarios(settings, tenantId);
  return list.find((s) => s.isDefault) ?? list[0];
}

export function scenarioForObligation(
  settings: TenantSettings,
  tenantId: string,
  obligation?: PostingSubject,
): PostingScenario {
  const fallback = defaultScenario(settings, tenantId);
  const explicit = typeof obligation?.aroAssetClass === 'string' ? obligation.aroAssetClass.trim() : '';
  const fromType = typeof obligation?.type === 'string' ? obligation.type.trim() : '';
  const className = explicit || fromType;
  if (!className) return fallback;
  const cls = findAssetClass(settings.aroAssetClasses, className);
  if (!cls) return fallback;
  return (settings.postingScenarios ?? []).find((s) => s.id === cls.scenarioId) ?? fallback;
}

export function accountInScenario(settings: TenantSettings, scenario: PostingScenario, role: string): Account | undefined {
  const id = scenario.accounts[role];
  if (id) {
    const hit = settings.accounts.find((a) => a.id === id);
    if (hit) return hit;
  }
  return settings.accounts.find((a) => a.engineRole === role);
}

export function accountForRole(
  settings: TenantSettings,
  tenantId: string,
  role: string,
  obligation?: PostingSubject,
): Account | undefined {
  return accountInScenario(settings, scenarioForObligation(settings, tenantId, obligation), role);
}

export function suspenseAccount(
  settings: TenantSettings,
  tenantId: string,
  obligation?: PostingSubject,
): Account | undefined {
  return accountForRole(settings, tenantId, 'Suspense', obligation);
}

export function hasProvisionMapping(settings: TenantSettings, tenantId: string): boolean {
  return Boolean(accountForRole(settings, tenantId, 'ARO provision'));
}

/** Append any missing engine event rules. Existing debit/credit mappings are left alone. */
export function ensureEnginePostingRules(settings: TenantSettings, tenantId: string): void {
  if (!settings.postingRules) settings.postingRules = [];
  for (const [eventType, debitRole, creditRole] of ENGINE_POSTING_RULES) {
    if (settings.postingRules.some((r) => r.eventType === eventType)) continue;
    settings.postingRules.push({
      id: `pr-${tenantId}-${eventType}`,
      tenantId,
      eventType,
      debitRole,
      creditRole,
      engineEmitted: true,
    });
  }
  const excess = settings.postingRules.find((r) => r.eventType === 'downward-excess');
  if (excess && excess.debitRole === 'Retirement cost asset') {
    excess.debitRole = 'Accretion expense';
    excess.creditRole = 'ARO provision';
  }
}

export function postingRulesReady(settings: TenantSettings): boolean {
  return ENGINE_EVENT_TYPES.every((t) =>
    (settings.postingRules ?? []).some((r) => r.eventType === t && r.debitRole && r.creditRole));
}

export function addPostingRule(
  settings: TenantSettings,
  tenantId: string,
  input: { eventType: string; debitRole: string; creditRole: string },
): string | null {
  const eventType = input.eventType.trim();
  if (!eventType) return 'A posting rule needs an event type.';
  if (!input.debitRole || !input.creditRole) return 'A posting rule needs a debit role and a credit role.';
  if ((settings.postingRules ?? []).some((r) => r.eventType.toLowerCase() === eventType.toLowerCase())) {
    return `A posting rule for ${eventType} already exists.`;
  }
  settings.postingRules.push({
    id: `pr-${tenantId}-${Date.now().toString(36)}-${settings.postingRules.length}`,
    tenantId,
    eventType,
    debitRole: input.debitRole,
    creditRole: input.creditRole,
    engineEmitted: ENGINE_EVENT_TYPES.includes(eventType),
  });
  return null;
}

export function renamePostingRuleEvent(settings: TenantSettings, id: string, eventType: string): string | null {
  const rule = (settings.postingRules ?? []).find((r) => r.id === id);
  if (!rule) return 'That posting rule is not on this tenant.';
  const next = eventType.trim();
  if (!next) return 'A posting rule needs an event type.';
  if (settings.postingRules.some((r) => r.id !== id && r.eventType.toLowerCase() === next.toLowerCase())) {
    return `A posting rule for ${next} already exists.`;
  }
  rule.eventType = next;
  rule.engineEmitted = ENGINE_EVENT_TYPES.includes(next);
  return null;
}

export function deletePostingRule(settings: TenantSettings, id: string): string | null {
  const i = (settings.postingRules ?? []).findIndex((r) => r.id === id);
  if (i < 0) return 'That posting rule is not on this tenant.';
  settings.postingRules.splice(i, 1);
  return null;
}

export function scenarioRoleGaps(scenario: PostingScenario, settings: TenantSettings): string[] {
  return ENGINE_ROLES.filter((role) => !accountInScenario(settings, scenario, role));
}

const ROLE_CLASS: Record<string, string[]> = {
  'ARO provision': ['Liability'],
  'Retirement cost asset': ['Asset'],
  'Accumulated depreciation': ['Asset'],
  'Accretion expense': ['Expense'],
  'Depreciation expense': ['Expense'],
  'Operating costs': ['Expense'],
  'Write-back to income': ['Income'],
  'Cash': ['Asset'],
  'Gain on disposal': ['Income'],
  'Loss on disposal': ['Expense'],
  'FX translation reserve': ['Equity'],
  'Suspense': ['Liability', 'Asset', 'Equity'],
};

const ROLE_NEEDLES: Record<string, string[]> = {
  'ARO provision': [
    'aro provision', 'aro liability', 'asset retirement obligation',
    'decommissioning provision', 'decommissioning liability', 'provision',
  ],
  'Retirement cost asset': [
    'retirement cost asset', 'aro asset', 'decommissioning asset',
    'asset retirement cost', 'retirement cost', 'capitalized',
  ],
  'Accumulated depreciation': [
    'accumulated depreciation', 'accum dep', 'accumulated amortisation',
    'accumulated amortization', 'contra asset', 'contra-asset',
  ],
  'Accretion expense': ['accretion', 'unwinding', 'unwind'],
  'Depreciation expense': [
    'depreciation expense', 'depreciation', 'amortization expense', 'amortisation expense',
    'systematic allocation',
  ],
  'Operating costs': [
    'operating cost', 'site restoration', 'restoration expense', 'settlement cost',
    'expensed as incurred', 'remediation', 'actual retirement cost paid',
  ],
  'Write-back to income': [
    'write back', 'write-back', 'writeback', 'surplus provision',
    'recorded obligation over actual',
  ],
  'Cash': ['cash at bank', 'cash', 'bank'],
  'Gain on disposal': ['gain on disposal', 'gain on sale', 'disposal gain'],
  'Loss on disposal': ['loss on disposal', 'loss on sale', 'disposal loss'],
  'FX translation reserve': ['translation reserve', 'foreign currency translation', 'fx translation', 'cta'],
  'Suspense': ['suspense'],
};

function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function accountFitForRole(acc: Account, role: string): number {
  const allowed = ROLE_CLASS[role];
  if (allowed && !allowed.includes(accountTypeOf(acc) || acc.cls)) return 0;
  const name = normKey(acc.name);
  const extra = normKey(Object.values(acc.columns ?? {}).join(' '));
  const hay = `${name} ${extra}`.trim();
  const roleN = normKey(role);
  if (!hay) return 0;
  if (role === 'Retirement cost asset' && /contra/.test(hay)) return 0;
  if (role === 'Operating costs' && /(accretion|unwind)/.test(hay)) return 0;
  if (role === 'Depreciation expense' && /(contra|accumulated)/.test(hay)) return 0;
  if (role === 'ARO provision' && /(twelve months|next year|near term|memo only|clearing|conditional)/.test(hay)) return 0;
  let best = 0;
  if (name === roleN) best = 900;
  else if (name.includes(roleN)) best = 800;
  for (const needle of ROLE_NEEDLES[role] ?? []) {
    if (hay.includes(needle)) best = Math.max(best, 100 + needle.length);
  }
  const roleWords = roleN.split(' ').filter((w) => w.length > 2);
  const nameWords = new Set(name.split(' '));
  const overlap = roleWords.filter((w) => nameWords.has(w)).length;
  if (overlap) best = Math.max(best, 50 * overlap);
  if (!best) return 0;
  if (acc.engineRole === role) best += 50;
  if (/\bparent\b/.test(hay) && /\bcontrol\b/.test(hay)) best += 250;
  return best;
}

/** Best imported GL for each engine role. Each account is used at most once. */
export function suggestRoleAccounts(accounts: Account[]): Record<string, string> {
  const result: Record<string, string> = {};
  const used = new Set<string>();
  const candidates: { role: string; id: string; score: number }[] = [];
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

/**
 * Add a seed GL for any engine role the imported chart cannot fill, so
 * posting rules can be tested. Existing codes are left alone.
 */
export function ensureRoleAccountsOnChart(settings: TenantSettings, tenantId: string): number {
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
      id, tenantId, code, name, cls, engineRole: '',
      requiredSegments: segs, columns: {},
    });
    codes.add(code);
    ids.add(id);
    added += 1;
  }
  return added;
}

/**
 * Map Standard ARO onto the best chart GLs for each engine role. A role the
 * user has marked complete is left as they set it.
 */
export function alignDefaultScenarioFromChart(settings: TenantSettings, tenantId: string): number {
  ensurePostingScenarios(settings, tenantId);
  ensureRoleAccountsOnChart(settings, tenantId);
  const def = defaultScenario(settings, tenantId);
  const suggestions = suggestRoleAccounts(settings.accounts);
  const done = new Set(def.completedRoles ?? []);
  let changed = 0;
  for (const role of ENGINE_ROLES) {
    if (done.has(role) && def.accounts[role]) continue;
    const current = def.accounts[role];
    const held = current ? settings.accounts.find((a) => a.id === current) : undefined;
    if (held && accountFitForRole(held, role) > 0) continue;
    const suggested = suggestions[role];
    if (!suggested || current === suggested) continue;
    assignScenarioRole(settings, def.id, role, suggested);
    changed += 1;
  }
  return changed;
}

function classGlSuffix(label: string, ordinal: number): number {
  const digits = label.replace(/\D/g, '');
  if (digits.length >= 2) {
    const n = parseInt(digits.slice(-2), 10);
    if (n > 0 && n < 90) return n;
  }
  return ordinal + 1;
}

function preferredClassCode(base: string, suffix: number): string {
  if (base === '99999') return String(99800 + suffix);
  return String(parseInt(base, 10) + suffix);
}

function allocateAccountCode(taken: Set<string>, preferred: string): string {
  if (/^\d{5}$/.test(preferred) && !taken.has(preferred)) return preferred;
  let n = parseInt((preferred.match(/\d{5}/) ?? ['18000'])[0], 10);
  if (!Number.isFinite(n) || n < 10000 || n > 98999) n = 18000;
  while (taken.has(String(n)) || String(n).length !== 5) n += 1;
  return String(n);
}

/**
 * Give each asset-class scenario its own GLs. Scenarios that still share
 * Standard ARO's accounts get a dedicated set named for that class. Roles
 * already mapped to a different GL, or marked complete, are left alone.
 */
export function ensureClassScenarioAccounts(settings: TenantSettings, tenantId: string): number {
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
      const tagged = `${name} — ${scn.name}`;
      let acc = settings.accounts.find((a) => a.code === preferred)
        ?? settings.accounts.find((a) => a.name === tagged);
      if (!acc) {
        const code = allocateAccountCode(codes, preferred);
        let id = `${tenantId}-acc-${code}`;
        if (ids.has(id)) id = `acc-${tenantId}-${code}`;
        acc = {
          id, tenantId, code, name: tagged, cls, engineRole: '',
          requiredSegments: segs, columns: {},
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

/**
 * Fill unassigned engine roles on every posting scenario from the imported
 * chart. Existing picks are left alone.
 */
export function prefillUnassignedFromChart(settings: TenantSettings, tenantId: string): number {
  const list = settings.postingScenarios ?? [];
  if (!list.length || !settings.accounts.length) return 0;
  const suggestions = suggestRoleAccounts(settings.accounts);
  let filled = 0;
  const ordered = [...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  for (const scn of ordered) {
    const taken = new Set(Object.values(scn.accounts).filter(Boolean));
    for (const role of ENGINE_ROLES) {
      if (scn.accounts[role]) continue;
      const id = suggestions[role];
      if (!id || taken.has(id)) continue;
      assignScenarioRole(settings, scn.id, role, id);
      taken.add(id);
      filled += 1;
    }
  }
  return filled;
}

/** Keep the default scenario's maps in step with account.engineRole after an import. */
export function syncDefaultScenarioFromRoles(settings: TenantSettings, tenantId: string): void {
  const def = defaultScenario(settings, tenantId);
  const next: Record<string, string> = {};
  for (const [role, id] of Object.entries(def.accounts)) {
    if (settings.accounts.some((a) => a.id === id)) next[role] = id;
  }
  for (const acc of settings.accounts) {
    if (acc.engineRole) next[acc.engineRole] = acc.id;
  }
  def.accounts = next;
  prefillUnassignedFromChart(settings, tenantId);
}

/** Drop a GL from every posting scenario when it is removed from the chart. */
export function unmapAccountFromScenarios(settings: TenantSettings, accountId: string): void {
  for (const scn of settings.postingScenarios ?? []) {
    for (const [role, id] of Object.entries(scn.accounts)) {
      if (id !== accountId) continue;
      delete scn.accounts[role];
      scn.completedRoles = (scn.completedRoles ?? []).filter((r) => r !== role);
    }
  }
  for (const acc of settings.accounts) {
    if (acc.id === accountId) acc.engineRole = '';
  }
}

/** Assign a GL to a role on a scenario. On the default scenario, also move account.engineRole. */
export function assignScenarioRole(
  settings: TenantSettings,
  scenarioId: string,
  role: string,
  accountId: string,
): void {
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
    else if (acc.engineRole === role) acc.engineRole = '';
  }
}

export function defaultCoding(settings: TenantSettings): Record<string, string> {
  const coding: Record<string, string> = {};
  for (const seg of settings.segments) {
    if (seg.required) coding[seg.name] = seg.permitted[0] ?? '';
  }
  return coding;
}

export function completedRoleCount(scenario: PostingScenario): number {
  const done = new Set(scenario.completedRoles ?? []);
  return ENGINE_ROLES.filter((role) => done.has(role)).length;
}

export function setRoleComplete(settings: TenantSettings, scenarioId: string, role: string, complete: boolean): void {
  const scenario = (settings.postingScenarios ?? []).find((s) => s.id === scenarioId);
  if (!scenario) return;
  const next = new Set(scenario.completedRoles ?? []);
  if (complete) {
    if (!scenario.accounts[role]) return;
    next.add(role);
  } else {
    next.delete(role);
  }
  scenario.completedRoles = ENGINE_ROLES.filter((r) => next.has(r));
}

export function emptyAssetClass(tenantId: string, name: string, scenarioId: string): AroAssetClass {
  return { id: `cls-${Date.now().toString(36)}`, tenantId, code: '', name, scenarioId };
}
