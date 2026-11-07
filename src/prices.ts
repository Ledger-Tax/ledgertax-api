import { parseCsv } from './csv-read.js';
import { PriceCsvError, PriceCsvTooLargeError } from './errors.js';
import type { PriceCsvIssue } from './errors.js';
import { parsePrice } from './money.js';

/** Header every price file must start with, exactly. */
export const PRICE_HEADER = ['asset', 'date', 'price', 'currency'] as const;

/** Limits for {@link parsePriceCsv}. */
export interface PriceCsvLimits {
  /** Maximum file size in bytes (UTF-8). Default 1 MiB. */
  maxBytes?: number;
  /** Maximum number of data rows. Default 50000. */
  maxRows?: number;
}

/** Prices by asset, UTC day and currency. A price is for 1 whole unit of the asset. */
export class PriceTable {
  private readonly rows = new Map<string, bigint>();

  /** @internal */
  set(asset: string, day: string, currency: string, price: bigint): void {
    this.rows.set(`${asset}|${day}|${currency}`, price);
  }

  /** True if the table already has this entry. @internal */
  has(asset: string, day: string, currency: string): boolean {
    return this.rows.has(`${asset}|${day}|${currency}`);
  }

  /**
   * Price of one whole unit of `asset` on UTC day `day` (`YYYY-MM-DD`) in `currency`, scaled by 10^12.
   * Returns `undefined` if the file has no such row. Prices are never guessed or interpolated.
   */
  get(asset: string, day: string, currency: string): bigint | undefined {
    return this.rows.get(`${asset}|${day}|${currency}`);
  }

  /** Number of price rows. */
  get size(): number {
    return this.rows.size;
  }
}

const ASSET = /^(native|[A-Za-z0-9]{1,12}:G[A-Z2-7]{55})$/;
const CURRENCY = /^[A-Z]{3}$/;

function isRealDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * Parses and strictly validates a price file with the header `asset,date,price,currency`.
 *
 * Rules: `asset` is `native` or `CODE:ISSUER`; `date` is a real `YYYY-MM-DD` date; `price` is a
 * non-negative decimal with at most 12 decimals (zero is allowed); `currency` is three capital
 * letters; the same asset, date and currency may appear only once. Lines starting with `#` are
 * comments. Every problem is reported with its line number.
 *
 * @param text - the file contents
 * @param limits - size and row limits
 * @throws PriceCsvTooLargeError if over the limits, PriceCsvError (with row-numbered issues) for bad content
 */
export function parsePriceCsv(text: string, limits: PriceCsvLimits = {}): PriceTable {
  const maxBytes = limits.maxBytes ?? 1_048_576;
  const maxRows = limits.maxRows ?? 50_000;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new PriceCsvTooLargeError(`more than ${maxBytes} bytes`);
  }

  let records;
  try {
    records = parseCsv(text).filter((r) => !r.fields[0]?.startsWith('#'));
  } catch (error) {
    const line = (error as { line?: number }).line ?? 0;
    throw new PriceCsvError([
      { row: line, message: error instanceof Error ? error.message : 'invalid CSV' },
    ]);
  }

  const [header, ...rows] = records;
  if (!header || header.fields.join(',') !== PRICE_HEADER.join(',')) {
    throw new PriceCsvError([
      {
        row: header?.line ?? 0,
        message: `The header must be exactly: ${PRICE_HEADER.join(',')}`,
      },
    ]);
  }
  if (rows.length > maxRows) throw new PriceCsvTooLargeError(`more than ${maxRows} rows`);

  const issues: PriceCsvIssue[] = [];
  const table = new PriceTable();
  for (const { line, fields } of rows) {
    if (fields.length !== PRICE_HEADER.length) {
      issues.push({ row: line, message: `Expected 4 columns, found ${fields.length}` });
      continue;
    }
    const [asset = '', date = '', price = '', currency = ''] = fields;
    let ok = true;
    const bad = (column: string, message: string): void => {
      issues.push({ row: line, column, message });
      ok = false;
    };
    if (!ASSET.test(asset)) bad('asset', 'Must be "native" or CODE:ISSUER');
    if (!isRealDate(date)) bad('date', 'Must be a real date as YYYY-MM-DD');
    const scaled = parsePrice(price);
    if (scaled === undefined)
      bad('price', 'Must be a non-negative decimal with at most 12 decimals');
    if (!CURRENCY.test(currency)) bad('currency', 'Must be three capital letters, for example USD');
    if (!ok || scaled === undefined) continue;
    if (table.has(asset, date, currency)) {
      issues.push({ row: line, message: 'Duplicate row for the same asset, date and currency' });
      continue;
    }
    table.set(asset, date, currency, scaled);
  }
  if (issues.length > 0) throw new PriceCsvError(issues);
  return table;
}
