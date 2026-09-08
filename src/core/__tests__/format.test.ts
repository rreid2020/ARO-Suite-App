import { describe, expect, it } from 'vitest';
import { currency, money, money2, num, parseNumber, pct, years } from '../format';

describe('number display', () => {
  it('formats currency with a symbol, commas and two decimals', () => {
    expect(currency(1234.5, 'CAD')).toBe('$1,234.50');
    expect(currency(5_120_000, 'USD')).toBe('$5,120,000.00');
    expect(currency(-166803.55, 'CAD')).toBe('-$166,803.55');
    expect(currency(0, 'CAD')).toBe('$0.00');
    expect(currency(99.1, 'GBP')).toBe('£99.10');
    expect(currency(10, 'EUR')).toBe('€10.00');
    expect(currency(null, 'CAD')).toBe('—');
  });

  it('formats money amounts with commas and two decimals', () => {
    expect(money(5120000)).toBe('5,120,000.00');
    expect(money2(166803.55)).toBe('166,803.55');
    expect(money(12)).toBe('12.00');
  });

  it('formats other numbers with commas and decimals only when needed', () => {
    expect(num(15)).toBe('15');
    expect(num(15.5)).toBe('15.5');
    expect(num(1234.5)).toBe('1,234.5');
    expect(num(1_234_567)).toBe('1,234,567');
    expect(num(12.3456, 4)).toBe('12.3456');
    expect(num(undefined)).toBe('—');
  });

  it('formats percentages and terms from the same grouping', () => {
    expect(pct(0.02)).toBe('2%');
    expect(pct(0.025, 2)).toBe('2.5%');
    expect(years(12)).toBe('12 yr');
    expect(years(12.5)).toBe('12.5 yr');
  });
});

describe('parseNumber', () => {
  it('reads currency, commas, apostrophes and accounting negatives', () => {
    expect(parseNumber('$1,234.50')).toBe(1234.5);
    expect(parseNumber("$1'234.50")).toBe(1234.5);
    expect(parseNumber('CAD 5,120,000.00')).toBe(5_120_000);
    expect(parseNumber('(166803.55)')).toBe(-166803.55);
    expect(parseNumber('15.5')).toBe(15.5);
    expect(parseNumber('')).toBeNaN();
  });
});
