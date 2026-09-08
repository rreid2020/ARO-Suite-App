/**
 * The organisation's account type (Asset, Liability, …) as stored on a GL.
 *
 * Charts often carry that in an AccountType / Account Type column. A generic
 * Type column, or a missing class, used to leave engine `cls` as Asset while
 * the extra column held the real type.
 */

import { ACCOUNT_CLASSES } from '../seed';
import type { Account } from './types';

const CLASS_ALIASES: Record<string, string> = {
  asset: 'Asset', assets: 'Asset', a: 'Asset',
  liability: 'Liability', liabilities: 'Liability', l: 'Liability', liab: 'Liability',
  equity: 'Equity', capital: 'Equity', e: 'Equity',
  income: 'Income', revenue: 'Income', revenues: 'Income', i: 'Income', r: 'Income',
  expense: 'Expense', expenses: 'Expense', expenditure: 'Expense', x: 'Expense',
};

export function headerKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function compactKey(s: string): string {
  return headerKey(s).replace(/\s/g, '');
}

/** Headings that mean the GL's account type, including camelCase AccountType. */
export function isAccountTypeHeader(raw: string): boolean {
  const n = headerKey(raw);
  const c = compactKey(raw);
  return n === 'account type' || n === 'account class' || c === 'accounttype' || c === 'accountclass';
}

export function isLooseClassHeader(raw: string): boolean {
  const n = headerKey(raw);
  return n === 'class' || n === 'category' || n === 'nature' || n === 'type';
}

export function parseAccountClass(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if ((ACCOUNT_CLASSES as readonly string[]).includes(t)) return t;
  const n = compactKey(t);
  return CLASS_ALIASES[n] ?? CLASS_ALIASES[headerKey(t)] ?? null;
}

export function classFromColumns(columns: Record<string, string>): string {
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
  return '';
}

/** Account type shown on posting scenarios — same value as the chart's Account Type column. */
export function accountTypeOf(acc: Pick<Account, 'cls' | 'columns'> | null | undefined): string {
  if (!acc) return '';
  return classFromColumns(acc.columns ?? {}) || acc.cls || '';
}
