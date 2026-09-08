/**
 * Display and parse numbers.
 *
 * Monetary amounts are currency format: a symbol, comma thousands, and
 * two decimal places ($1,234.56). Other numbers use the same grouping, with a
 * decimal point only when the value is not a whole number (15, 1,234.5).
 */

const GROUP = ',';

const DOLLAR_CODES = new Set(['USD', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'MXN']);

const ISO_CODES = /\b(CAD|USD|GBP|EUR|CHF|AUD|NZD|HKD|SGD|JPY|CNY)\b/gi;

export function parseNumber(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') return raw;
  let s = String(raw ?? '').trim();
  if (!s) return NaN;
  const paren = s.startsWith('(') && s.endsWith(')');
  s = s.replace(/[()]/g, '');
  s = s.replace(ISO_CODES, '');
  s = s.replace(/[$£€¥]/g, '');
  s = s.replace(/[\s'’`,]/g, '');
  if (!s || s === '+' || s === '-' || s === '.' || s === '+.' || s === '-.') return NaN;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return paren ? -Math.abs(n) : n;
}

function groupInt(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
}

function signed(neg: boolean, body: string): string {
  return neg ? `-${body}` : body;
}

/** Comma thousands; decimals only when the value is not a whole number. */
export function num(n: number | null | undefined, maxDp = 6): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const neg = n < 0 || Object.is(n, -0);
  const abs = Math.abs(n);
  const factor = 10 ** maxDp;
  const rounded = Math.round(abs * factor) / factor;
  if (maxDp <= 0 || Number.isInteger(rounded)) {
    return signed(neg, groupInt(String(Math.round(rounded))));
  }
  const [int, frac = ''] = rounded.toFixed(maxDp).split('.');
  const trimmed = frac.replace(/0+$/, '');
  return signed(neg, trimmed ? `${groupInt(int)}.${trimmed}` : groupInt(int));
}

/** Comma thousands and a fixed number of decimal places (default 2). */
export function money(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const neg = n < 0 || Object.is(n, -0);
  const abs = Math.abs(n);
  const [int, frac] = abs.toFixed(dp).split('.');
  const body = dp > 0 ? `${groupInt(int)}.${frac}` : groupInt(int);
  return signed(neg, body);
}

export const money2 = (n: number | null | undefined) => money(n, 2);

export function currencySymbol(code: string): string {
  const c = (code ?? '').trim().toUpperCase();
  if (DOLLAR_CODES.has(c)) return '$';
  if (c === 'GBP') return '£';
  if (c === 'EUR') return '€';
  if (c === 'JPY' || c === 'CNY') return '¥';
  if (!c) return '$';
  return `${c} `;
}

export function currency(n: number | null | undefined, code: string, dp = 2): string {
  const m = money(n, dp);
  if (m === '—') return '—';
  const neg = m.startsWith('-');
  const body = neg ? m.slice(1) : m;
  return signed(neg, `${currencySymbol(code)}${body}`);
}

export const pct = (n: number, dp = 2) => `${num(n * 100, dp)}%`;
export const years = (n: number) => `${num(n, 4)} yr`;
