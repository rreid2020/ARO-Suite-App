/**
 * Read the organisation's asset classes — a list of names, or a two-column
 * code/name extract. Each class gets its own posting scenario so journals
 * can use different GLs for wells vs plant.
 */

import type { AppState, TenantSettings } from './types';
import { classKey, classLabel, findAssetClass, normalizeAroAssetClasses, splitClassLabel } from './assetClass';
import { defaultScenario, ensureClassScenarioAccounts, ensurePostingScenarios, prefillUnassignedFromChart } from './posting';

export interface ParsedAssetClass {
  label: string;
  code: string;
  name: string;
}

export interface AssetListingParseResult {
  classes: ParsedAssetClass[];
  rows: number;
  problems: string[];
}

export interface AssetClassImportResult {
  added: number;
  split: number;
  kept: number;
  problems: string[];
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function detectDelim(header: string): string {
  if (header.includes('\t')) return '\t';
  const semi = (header.match(/;/g) ?? []).length;
  const comma = (header.match(/,/g) ?? []).length;
  return semi > comma ? ';' : ',';
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function looksLikeHeader(cells: string[]): boolean {
  return cells.some((c) => {
    const n = norm(c);
    return /asset class/.test(n)
      || /^(anlkl|class|class code|class name|asset type)$/.test(n);
  });
}

function labelFor(code: string, name: string): string {
  if (code && name && code !== name) return `${code} — ${name}`;
  return name || code;
}

function classifyHeader(cells: string[]): { code: number; name: number } {
  let code = -1;
  let name = -1;
  cells.forEach((raw, i) => {
    const n = norm(raw);
    if (code < 0 && /^(asset class|asset class code|anlkl|class code|class)$/.test(n)) { code = i; return; }
    if (name < 0 && /^(asset class name|class name|asset class description|class description|asset type)$/.test(n)) { name = i; return; }
  });
  return { code, name };
}

export function parseAssetListing(text: string): AssetListingParseResult {
  const problems: string[] = [];
  const cleaned = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
  const rawLines = cleaned.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!rawLines.length) return { classes: [], rows: 0, problems: ['No asset classes were entered.'] };

  const delim = detectDelim(rawLines[0]);
  let rows = rawLines.map((l) => splitLine(l, delim));
  let cols = { code: -1, name: -1 };
  if (looksLikeHeader(rows[0])) {
    cols = classifyHeader(rows[0]);
    rows = rows.slice(1);
  } else if ((rows[0]?.length ?? 0) > 2) {
    return {
      classes: [],
      rows: 0,
      problems: ['Paste asset classes only — one name per line, or two columns (code, name). A full asset listing is not needed here.'],
    };
  } else if ((rows[0]?.length ?? 0) === 2) {
    cols = { code: 0, name: 1 };
  } else {
    cols = { code: 0, name: -1 };
  }
  if (cols.code < 0 && cols.name < 0) cols = { code: 0, name: -1 };

  const seen = new Map<string, ParsedAssetClass>();
  let dataRows = 0;
  for (const cells of rows) {
    const code = cols.code >= 0 ? (cells[cols.code] ?? '').trim() : '';
    const name = cols.name >= 0 ? (cells[cols.name] ?? '').trim() : '';
    let parsedCode = code;
    let parsedName = name;
    if (!name && code) {
      const parts = splitClassLabel(code);
      parsedCode = parts.code;
      parsedName = parts.name;
    } else if (!parsedName) {
      parsedName = parsedCode;
      parsedCode = '';
    }
    const label = labelFor(parsedCode, parsedName);
    if (!label) continue;
    dataRows += 1;
    const key = label.toLowerCase();
    if (!seen.has(key)) seen.set(key, { label, code: parsedCode, name: parsedName || parsedCode });
  }

  const classes = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  if (!classes.length) problems.push('No asset class names could be read. Enter one class per line, or two columns: code and name.');
  return { classes, rows: dataRows, problems };
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'class';
}

function uniqueId(prefix: string, tenantId: string, label: string, taken: Set<string>): string {
  const base = `${prefix}-${tenantId}-${slug(label)}`;
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

/**
 * Create a posting scenario per distinct class in the listing. Existing
 * classes that still share the default (or another) scenario are split onto
 * their own copy so GLs can differ. Classes not in the file are kept.
 */
export function importAssetClassesFromListing(
  settings: TenantSettings,
  tenantId: string,
  parsed: AssetListingParseResult,
): AssetClassImportResult {
  const problems = [...parsed.problems];
  ensurePostingScenarios(settings, tenantId);
  normalizeAroAssetClasses(settings);
  if (!parsed.classes.length) return { added: 0, split: 0, kept: 0, problems };

  const fallback = { ...defaultScenario(settings, tenantId).accounts };
  const classByLabel = new Map(settings.aroAssetClasses.map((c) => [c.name.toLowerCase(), c]));
  for (const c of settings.aroAssetClasses) {
    if (c.code) classByLabel.set(c.code.toLowerCase(), c);
    classByLabel.set(classLabel(c).toLowerCase(), c);
  }
  const takenScn = new Set(settings.postingScenarios.map((s) => s.id));
  const takenCls = new Set(settings.aroAssetClasses.map((c) => c.id));
  let added = 0;
  let split = 0;
  let kept = 0;

  const dedicatedCount = (scenarioId: string) =>
    settings.aroAssetClasses.filter((c) => c.scenarioId === scenarioId).length;

  const findExisting = (row: ParsedAssetClass) =>
    findAssetClass(settings.aroAssetClasses, row.label)
    ?? findAssetClass(settings.aroAssetClasses, row.code)
    ?? findAssetClass(settings.aroAssetClasses, row.name);

  for (const row of parsed.classes) {
    const existing = findExisting(row);
    if (existing) {
      if (row.code && !(existing.code ?? '').trim()) existing.code = row.code;
      const scn = settings.postingScenarios.find((s) => s.id === existing.scenarioId);
      const shared = !scn || scn.isDefault || dedicatedCount(existing.scenarioId) > 1;
      if (!shared) { kept += 1; continue; }
      const id = uniqueId('scn', tenantId, row.label, takenScn);
      takenScn.add(id);
      settings.postingScenarios.push({
        id, tenantId, name: row.label, isDefault: false, accounts: { ...(scn?.accounts ?? fallback) }, completedRoles: [],
      });
      existing.scenarioId = id;
      split += 1;
      continue;
    }
    const scnId = uniqueId('scn', tenantId, row.label, takenScn);
    const clsId = uniqueId('cls', tenantId, row.label, takenCls);
    takenScn.add(scnId);
    takenCls.add(clsId);
    settings.postingScenarios.push({
      id: scnId, tenantId, name: row.label, isDefault: false, accounts: { ...fallback }, completedRoles: [],
    });
    settings.aroAssetClasses.push({
      id: clsId, tenantId, code: row.code, name: row.name, scenarioId: scnId,
    });
    const addedCls = settings.aroAssetClasses[settings.aroAssetClasses.length - 1];
    classByLabel.set(row.label.toLowerCase(), addedCls);
    if (row.code) classByLabel.set(row.code.toLowerCase(), addedCls);
    classByLabel.set(row.name.toLowerCase(), addedCls);
    added += 1;
  }

  prefillUnassignedFromChart(settings, tenantId);
  ensureClassScenarioAccounts(settings, tenantId);
  return { added, split, kept, problems };
}

export function renameAssetClass(s: AppState, tenantId: string, classId: string, nextName: string): string | null {
  return patchAssetClass(s, tenantId, classId, { name: nextName });
}

export function patchAssetClass(
  s: AppState,
  tenantId: string,
  classId: string,
  next: { code?: string; name?: string },
): string | null {
  const settings = s.settings[tenantId];
  const cls = (settings?.aroAssetClasses ?? []).find((c) => c.id === classId);
  if (!cls) return 'That asset class is not on this tenant.';
  const prevKey = classKey(cls);
  const prevLabel = classLabel(cls);
  const prevCode = (cls.code ?? '').trim();
  const prevName = cls.name;

  if (next.code != null) cls.code = next.code.trim();
  if (next.name != null) {
    const name = next.name.trim();
    if (!name) return 'An asset class needs a name.';
    if (settings.aroAssetClasses.some((c) => c.id !== classId && c.name.toLowerCase() === name.toLowerCase())) {
      return `${name} is already an asset class.`;
    }
    cls.name = name;
  }
  const code = (cls.code ?? '').trim();
  if (code) {
    const clash = settings.aroAssetClasses.find(
      (c) => c.id !== classId && (c.code ?? '').trim().toLowerCase() === code.toLowerCase(),
    );
    if (clash) {
      cls.code = prevCode;
      cls.name = prevName;
      return `Class code ${code} is already used by ${classLabel(clash)}.`;
    }
  }

  if (prevKey === classKey(cls) && prevLabel === classLabel(cls) && prevCode === code && prevName === cls.name) {
    return null;
  }

  const siblings = settings.aroAssetClasses.filter((c) => c.scenarioId === cls.scenarioId);
  const scn = settings.postingScenarios.find((x) => x.id === cls.scenarioId);
  if (scn && !scn.isDefault && siblings.length === 1) scn.name = classLabel(cls);

  const previous = new Set(
    [prevKey, prevLabel, prevCode, prevName].map((v) => v.trim().toLowerCase()).filter(Boolean),
  );
  for (const u of s.units[tenantId] ?? []) {
    const data = s.data[u.id];
    if (!data) continue;
    for (const o of data.obligations) {
      const held = typeof o.aroAssetClass === 'string' ? o.aroAssetClass.trim().toLowerCase() : '';
      if (held && previous.has(held)) o.aroAssetClass = classKey(cls);
    }
  }
  return null;
}

export function deleteAssetClass(s: AppState, tenantId: string, classId: string): string | null {
  const settings = s.settings[tenantId];
  const cls = (settings?.aroAssetClasses ?? []).find((c) => c.id === classId);
  if (!cls) return 'That asset class is not on this tenant.';
  const scenarioId = cls.scenarioId;
  settings.aroAssetClasses = settings.aroAssetClasses.filter((c) => c.id !== classId);
  const scn = settings.postingScenarios.find((x) => x.id === scenarioId);
  const remaining = settings.aroAssetClasses.filter((c) => c.scenarioId === scenarioId);
  if (scn && !scn.isDefault && remaining.length === 0) {
    settings.postingScenarios = settings.postingScenarios.filter((x) => x.id !== scenarioId);
    if (!settings.postingScenarios.some((x) => x.isDefault) && settings.postingScenarios[0]) {
      settings.postingScenarios[0].isDefault = true;
    }
  }
  return null;
}
