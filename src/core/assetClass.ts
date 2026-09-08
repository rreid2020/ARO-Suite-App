/**
 * ARO asset class identity — code and name as separate fields, matched so
 * an obligation posts through the class's posting scenario whether the
 * register holds the code, the name, or the combined label.
 */

import type { AroAssetClass, Obligation, TenantSettings } from './types';

export function splitClassLabel(label: string): { code: string; name: string } {
  const t = label.trim();
  if (!t) return { code: '', name: '' };
  if (/^\d+$/.test(t)) return { code: t, name: '' };
  const dash = t.match(/^(\S+)\s+[—–-]\s+(.+)$/);
  if (dash) return { code: dash[1].trim(), name: dash[2].trim() };
  const numbered = t.match(/^(\d+)\s+(.+)$/);
  if (numbered) return { code: numbered[1], name: numbered[2].trim() };
  return { code: '', name: t };
}

export function classLabel(cls: Pick<AroAssetClass, 'name'> & { code?: string }): string {
  const code = (cls.code ?? '').trim();
  const name = cls.name.trim();
  if (code && name && code !== name) return `${code} — ${name}`;
  return name || code;
}

/** Value stored on the obligation — code when the class has one, otherwise name. */
export function classKey(cls: Pick<AroAssetClass, 'name'> & { code?: string }): string {
  return ((cls.code ?? '').trim() || cls.name.trim());
}

export function findAssetClass(
  classes: AroAssetClass[] | undefined,
  raw: string | undefined,
): AroAssetClass | undefined {
  const t = (raw ?? '').trim();
  if (!t || !classes?.length) return undefined;
  const lower = t.toLowerCase();
  const parts = splitClassLabel(t);

  const hit = (c: AroAssetClass) => {
    const code = (c.code ?? '').trim().toLowerCase();
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

export function classCodeOf(raw: string | undefined, classes: AroAssetClass[] | undefined): string {
  const hit = findAssetClass(classes, raw);
  if (hit?.code?.trim()) return hit.code.trim();
  return splitClassLabel(raw ?? '').code;
}

export function classNameOf(raw: string | undefined, classes: AroAssetClass[] | undefined): string {
  const hit = findAssetClass(classes, raw);
  if (hit) return hit.name;
  const parts = splitClassLabel(raw ?? '');
  return parts.name || (parts.code ? '' : (raw ?? '').trim());
}

/** Split a combined "11010 Buildings" name onto code + name when code is empty. */
export function normalizeAroAssetClasses(settings: TenantSettings): void {
  for (const c of settings.aroAssetClasses ?? []) {
    let split = false;
    if (!(c.code ?? '').trim()) {
      const parts = splitClassLabel(c.name);
      if (parts.code && parts.name) {
        c.code = parts.code;
        c.name = parts.name;
        split = true;
      } else if (c.code == null) {
        c.code = '';
      }
    }
    if (!split) continue;
    const siblings = (settings.aroAssetClasses ?? []).filter((x) => x.scenarioId === c.scenarioId);
    const scn = (settings.postingScenarios ?? []).find((s) => s.id === c.scenarioId);
    if (scn && !scn.isDefault && siblings.length === 1) scn.name = classLabel(c);
  }
}

export function canonicalizeObligationClasses(
  settings: TenantSettings,
  data: { obligations: Obligation[] },
): void {
  for (const o of data.obligations) {
    const raw = typeof o.aroAssetClass === 'string' ? o.aroAssetClass : undefined;
    const cls = findAssetClass(settings.aroAssetClasses, raw);
    if (cls) o.aroAssetClass = classKey(cls);
  }
}
