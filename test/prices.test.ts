import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv-read.js';
import { CsvSyntaxError, PriceCsvError, PriceCsvTooLargeError } from '../src/errors.js';
import { parsePriceCsv } from '../src/prices.js';

const ISSUER = `G${'A'.repeat(55)}`;
const HEADER = 'asset,date,price,currency';

function issuesOf(text: string, limits = {}) {
  try {
    parsePriceCsv(text, limits);
  } catch (error) {
    if (error instanceof PriceCsvError) return error.issues;
    throw error;
  }
  return [];
}

describe('parseCsv', () => {
  it('parses quotes, commas, doubled quotes, embedded newlines, CRLF and a BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\n"two\nlines",z\n\n');
    expect(rows).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['x,1', 'he said "hi"'] },
      { line: 3, fields: ['two\nlines', 'z'] },
    ]);
  });
  it('keeps empty fields', () => {
    expect(parseCsv('a,,c\n,,\n')).toEqual([
      { line: 1, fields: ['a', '', 'c'] },
      { line: 2, fields: ['', '', ''] },
    ]);
  });
  it('rejects an unterminated quote and text after a closing quote', () => {
    expect(() => parseCsv('a,"b\nc')).toThrow(CsvSyntaxError);
    expect(() => parseCsv('"a"b,c')).toThrow(CsvSyntaxError);
    expect(() => parseCsv('a"b,c')).toThrow(CsvSyntaxError);
  });
});

describe('parsePriceCsv', () => {
  it('accepts a valid file and looks prices up by asset, UTC day and currency', () => {
    const table = parsePriceCsv(
      [
        '# comment lines are ignored',
        HEADER,
        'native,2025-01-01,0.10,USD',
        `TEST:${ISSUER},2025-01-01,1.5,USD`,
        'native,2025-01-02,0,USD',
        'native,2025-01-01,0.09,EUR',
      ].join('\n'),
    );
    expect(table.size).toBe(4);
    expect(table.get('native', '2025-01-01', 'USD')).toBe(100_000_000_000n);
    expect(table.get(`TEST:${ISSUER}`, '2025-01-01', 'USD')).toBe(1_500_000_000_000n);
    expect(table.get('native', '2025-01-02', 'USD')).toBe(0n); // zero is allowed
    expect(table.get('native', '2025-01-01', 'EUR')).toBe(90_000_000_000n);
    expect(table.get('native', '2025-01-03', 'USD')).toBeUndefined(); // never guessed
  });

  it('rejects a bad header with a clear message', () => {
    for (const header of [
      'asset,date,price',
      'Asset,Date,Price,Currency',
      'date,asset,price,currency',
      '',
    ]) {
      const issues = issuesOf(`${header}\nnative,2025-01-01,1,USD`);
      expect(issues[0]?.message, header).toContain('header must be exactly');
    }
  });

  it('reports every bad row with its line number and column', () => {
    const issues = issuesOf(
      [
        HEADER,
        'native,2025-13-01,1,USD', // line 2: bad month
        'native,2025-02-30,1,USD', // line 3: not a real date
        'native,2025-01-01,-1,USD', // line 4: negative price
        'native,2025-01-01,abc,USD', // line 5
        'native,2025-01-01,1,usd', // line 6: currency
        'BAD,2025-01-01,1,USD', // line 7: asset
        'native,2025-01-01', // line 8: columns
        'native,2025-01-01,1,USD', // line 9: fine
      ].join('\n'),
    );
    expect(issues.map((i) => [i.row, i.column])).toEqual([
      [2, 'date'],
      [3, 'date'],
      [4, 'price'],
      [5, 'price'],
      [6, 'currency'],
      [7, 'asset'],
      [8, undefined],
    ]);
  });

  it('rejects duplicate rows, on the second occurrence', () => {
    const issues = issuesOf(
      [HEADER, 'native,2025-01-01,1,USD', 'native,2025-01-01,2,USD'].join('\n'),
    );
    expect(issues).toEqual([
      { row: 3, message: 'Duplicate row for the same asset, date and currency' },
    ]);
  });

  it('rejects a file over the size limit, and one with too many rows', () => {
    const rows = Array.from(
      { length: 50 },
      (_, i) => `native,2025-01-${String((i % 28) + 1).padStart(2, '0')},1,USD`,
    );
    const text = [HEADER, ...rows].join('\n');
    expect(() => parsePriceCsv(text, { maxBytes: 100 })).toThrow(PriceCsvTooLargeError);
    expect(() => parsePriceCsv(text, { maxRows: 10 })).toThrow(PriceCsvTooLargeError);
    expect(() => parsePriceCsv('x'.repeat(2_000_000))).toThrow(PriceCsvTooLargeError); // default 1 MiB
  });

  it('turns a CSV syntax error into a row-numbered issue', () => {
    const issues = issuesOf(`${HEADER}\nnative,"2025-01-01,1,USD`);
    expect(issues[0]?.row).toBe(2);
  });

  it('does not treat a spreadsheet formula in a cell as anything but an invalid value', () => {
    const issues = issuesOf(`${HEADER}\n=1+1,2025-01-01,1,USD`);
    expect(issues[0]).toMatchObject({ row: 2, column: 'asset' });
  });
});
