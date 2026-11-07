import { describe, expect, it } from 'vitest';
import {
  FIAT_SCALE,
  divRound,
  fiatValue,
  formatFiat,
  formatUnits,
  parsePrice,
  proportion,
} from '../src/money.js';

describe('parsePrice', () => {
  it('parses plain decimals into 12-decimal scaled bigints', () => {
    expect(parsePrice('0')).toBe(0n);
    expect(parsePrice('1')).toBe(1_000_000_000_000n);
    expect(parsePrice('0.1234')).toBe(123_400_000_000n);
    expect(parsePrice('0.000000000001')).toBe(1n);
    expect(parsePrice('123456.789')).toBe(123_456_789_000_000_000n);
  });
  it('rejects signs, exponents, separators, whitespace, empty and too many decimals', () => {
    for (const bad of [
      '-1',
      '+1',
      '1e5',
      '1,5',
      '1 ',
      ' 1',
      '',
      '.5',
      '1.',
      '0.0000000000001',
      'abc',
      '١',
    ]) {
      expect(parsePrice(bad), bad).toBeUndefined();
    }
  });
});

describe('divRound and proportion', () => {
  it('rounds half away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(-4n, 3n)).toBe(-1n);
    expect(divRound(0n, 7n)).toBe(0n);
  });
  it('refuses a non-positive denominator', () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
    expect(() => divRound(1n, -1n)).toThrow(RangeError);
  });
  it('computes proportions exactly', () => {
    expect(proportion(3000n, 100n, 120n)).toBe(2500n);
    expect(proportion(1n, 1n, 3n)).toBe(0n);
    expect(proportion(2n, 1n, 3n)).toBe(1n);
  });
});

describe('fiat values and formatting', () => {
  it('multiplies units by price exactly at scale 1e19', () => {
    // 100 units (7 decimals) at 0.10 = 10.00
    const v = fiatValue(100n * 10_000_000n, 7, parsePrice('0.10') as bigint);
    expect(v).toBe(10n * 10n ** BigInt(FIAT_SCALE));
    expect(formatFiat(v)).toBe('10.00');
  });
  it('rounds half away from zero when formatting, never earlier', () => {
    expect(formatFiat(1_005n * 10n ** 17n)).toBe('10.05'); // 10.05 exactly
    expect(formatFiat(10_005n * 10n ** 16n)).toBe('10.01'); // 10.005 -> 10.01
    expect(formatFiat(-10_005n * 10n ** 16n)).toBe('-10.01');
    expect(formatFiat(0n)).toBe('0.00');
    expect(formatFiat(15n * 10n ** 18n, 0)).toBe('2'); // 1.5 -> 2
  });
  it('rejects unreasonable decimals', () => {
    expect(() => formatFiat(0n, 9)).toThrow(RangeError);
    expect(() => formatFiat(0n, -1)).toThrow(RangeError);
    expect(() => formatFiat(0n, 1.5)).toThrow(RangeError);
  });
  it('formats asset units', () => {
    expect(formatUnits(15_000_000n)).toBe('1.5000000');
    expect(formatUnits(1n)).toBe('0.0000001');
    expect(formatUnits(0n)).toBe('0.0000000');
    expect(formatUnits(-25n, 2)).toBe('-0.25');
    expect(formatUnits(5n, 0)).toBe('5');
  });
  it('adjusts for assets with other decimals', () => {
    // 1.5 tokens with 2 decimals at price 2 = 3.00
    expect(formatFiat(fiatValue(150n, 2, parsePrice('2') as bigint))).toBe('3.00');
  });
});
