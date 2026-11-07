/**
 * Money is never a floating-point number.
 *
 * - Asset amounts are `bigint` in the asset's smallest unit (stroops for classic assets: 7 decimals).
 * - A price is a decimal string with up to {@link PRICE_SCALE} decimals, held as a scaled bigint.
 * - A fiat value is `units * price`, kept exact at scale {@link FIAT_SCALE} (7 + 12 decimals) and
 *   rounded only when written out, half away from zero.
 */

/** Decimal places kept in a price. */
export const PRICE_SCALE = 12;
/** Decimal places of an exact fiat value (7 asset decimals + 12 price decimals). */
export const FIAT_SCALE = 19;
/** Decimals of classic Stellar assets. */
export const STROOP_DECIMALS = 7;

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/**
 * Parses a non-negative decimal price such as `0.1234` into a bigint scaled by 10^12.
 *
 * @returns the scaled price, or `undefined` if the text is not a plain non-negative decimal with at
 * most 12 decimals (no sign, exponent, thousands separator or whitespace)
 */
export function parsePrice(text: string): bigint | undefined {
  const m = /^(\d{1,24})(?:\.(\d{1,12}))?$/.exec(text);
  if (!m) return undefined;
  return BigInt(m[1] ?? '0') * pow10(PRICE_SCALE) + BigInt((m[2] ?? '').padEnd(PRICE_SCALE, '0'));
}

/**
 * Exact fiat value of `units` of an asset with `decimals` decimals at a scaled price, at scale 10^19.
 * Exact for assets with up to 7 decimals; for more decimals the result is rounded.
 */
export function fiatValue(units: bigint, decimals: number, priceScaled: bigint): bigint {
  const raw = units * priceScaled; // scale: decimals + 12
  const shift = FIAT_SCALE - (decimals + PRICE_SCALE);
  return shift >= 0 ? raw * pow10(shift) : divRound(raw, pow10(-shift));
}

/** Integer division rounding half away from zero. `den` must be positive. */
export function divRound(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('divRound: denominator must be positive');
  const neg = num < 0n;
  const abs = neg ? -num : num;
  const q = (abs * 2n + den) / (den * 2n);
  return neg ? -q : q;
}

/** `round(total * part / whole)`, half away from zero. */
export function proportion(total: bigint, part: bigint, whole: bigint): bigint {
  return divRound(total * part, whole);
}

/**
 * Formats a scale-10^19 fiat value with `decimals` places (default 2), rounding half away from zero.
 */
export function formatFiat(value19: bigint, decimals = 2): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    throw new RangeError('decimals must be an integer from 0 to 8');
  }
  return formatScaled(divRound(value19, pow10(FIAT_SCALE - decimals)), decimals);
}

/** Formats an amount in smallest units with `decimals` places, for example 15000000n -> "1.5000000". */
export function formatUnits(units: bigint, decimals = STROOP_DECIMALS): string {
  return formatScaled(units, decimals);
}

function formatScaled(scaled: bigint, decimals: number): string {
  const neg = scaled < 0n;
  const abs = (neg ? -scaled : scaled).toString().padStart(decimals + 1, '0');
  const whole = abs.slice(0, abs.length - decimals);
  const frac = abs.slice(abs.length - decimals);
  return `${neg ? '-' : ''}${whole}${decimals > 0 ? `.${frac}` : ''}`;
}
