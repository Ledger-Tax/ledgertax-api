import { describe, expect, it } from 'vitest';
import type { Label, LedgerEvent } from '@veronicdev/ledgertax-core';
import { computeCostBasis } from '../src/costbasis.js';
import {
  DISCLAIMER,
  csvComment,
  csvNumber,
  csvText,
  neutralize,
  writeCsv,
} from '../src/csv-write.js';
import { parseCsv } from '../src/csv-read.js';
import { parsePriceCsv } from '../src/prices.js';
import { EXPORT_FORMATS, writeEventsCsv, writeGainsCsv } from '../src/reports.js';
import type { ReportMeta } from '../src/reports.js';

const ADDR = `G${'B'.repeat(55)}`;
const META: ReportMeta = {
  generatedAt: '2026-01-01T00:00:00Z',
  address: ADDR,
  source: 'Horizon (https://horizon.example)',
  range: 'ledgers 100 to 200',
};
const rowsOf = (csv: string) => parseCsv(csv).filter((r) => !r.fields[0]?.startsWith('#'));

function event(extra: Partial<LedgerEvent>): LedgerEvent {
  return {
    id: 'tx:0:0',
    txHash: 'tx',
    opIndex: 0,
    ledger: 1,
    time: '2025-01-01T00:00:00Z',
    type: 'payment_in',
    address: ADDR,
    decimals: 7,
    raw: { source: 'horizon', ref: '1' },
    ...extra,
  };
}

describe('neutralize', () => {
  it('prefixes every formula starter, including after spaces and full-width forms', () => {
    for (const bad of [
      '=1+1',
      '+1',
      '-1+2',
      '@SUM(A1)',
      '\t=1',
      '\r',
      '\n=1',
      '  =1',
      '＝1',
      '＋1',
      '－1',
      '＠x',
      '=HYPERLINK("http://x","y")',
    ]) {
      expect(neutralize(bad), JSON.stringify(bad)).toBe(`'${bad}`);
    }
  });
  it('leaves ordinary text alone', () => {
    for (const ok of [
      '',
      'hello',
      'a=b',
      'USDC:GA..',
      '1+1',
      "'quoted",
      'résumé',
      '日本語',
      '😀',
    ]) {
      expect(neutralize(ok), ok).toBe(ok);
    }
  });
});

describe('csvText, csvNumber, csvComment, writeCsv', () => {
  it('quotes commas, quotes, CR and LF, and keeps unicode', () => {
    expect(csvText('a,b')).toBe('"a,b"');
    expect(csvText('say "hi"')).toBe('"say ""hi"""');
    expect(csvText('two\nlines')).toBe('"two\nlines"');
    expect(csvText('crlf\r\nx')).toBe('"crlf\r\nx"');
    expect(csvText('plain')).toBe('plain');
    expect(csvText('日本語 😀 שלום')).toBe('日本語 😀 שלום');
  });
  it('neutralises before quoting', () => {
    expect(csvText('=A1,2')).toBe(`"'=A1,2"`);
  });
  it('accepts plain numbers (also negative and empty) and refuses anything else', () => {
    for (const ok of ['', '0', '12.50', '-2.50', '10000000']) expect(csvNumber(ok)).toBe(ok);
    for (const bad of ['=1', '1e5', '1,5', 'abc', ' 1', '-', '1.', '+1']) {
      expect(() => csvNumber(bad), bad).toThrow(TypeError);
    }
  });
  it('keeps a comment on one line', () => {
    expect(csvComment('a\nb\r\nc')).toBe('# a b c');
  });
  it('writes comments, header and rows', () => {
    const csv = writeCsv(
      [
        { header: 'n', kind: 'number', value: (r: { n: string; t: string }) => r.n },
        { header: 't', kind: 'text', value: (r) => r.t },
      ],
      [{ n: '-1.5', t: '=x' }],
      ['first', 'second'],
    );
    expect(csv).toBe("# first\n# second\nn,t\n-1.5,'=x\n");
  });
});

describe('events.csv', () => {
  const hostile = [
    event({
      id: 'a:0:0',
      memo: '=HYPERLINK("http://evil","click")',
      asset: 'EVIL:' + 'G'.repeat(55),
      amount: 15_000_000n,
      counterparty: ADDR,
    }),
    event({ id: 'b:0:0', type: 'payment_out', memo: '+cmd|calc', amount: 1n }),
    event({ id: 'c:0:0', memo: '-2+3', amount: 5n }),
    event({ id: 'd:0:0', memo: '@SUM(1)', amount: 5n }),
    event({ id: 'e:0:0', memo: 'quote " and, comma\nand newline', amount: 5n }),
    event({ id: 'f:0:0', memo: '😀 日本語', amount: 5n }),
    event({ id: 'g:0:0', type: 'unknown', opType: 'change_trust' }),
  ];
  const labels: Label[] = [{ eventId: 'a:0:0', label: 'income', note: '=1+1' }];
  const csv = writeEventsCsv(hostile, labels, META);

  it('starts with the disclaimer and states source and range', () => {
    expect(csv.split('\n')[0]).toBe(`# ${DISCLAIMER}`);
    expect(csv).toContain('# Source: Horizon (https://horizon.example)');
    expect(csv).toContain('# History range: ledgers 100 to 200');
    expect(csv).toContain('of which unknown: 1');
  });

  it('neutralises hostile memos and notes, and keeps odd text intact when read back', () => {
    const [header, ...rows] = rowsOf(csv).map((r) => r.fields);
    const memo = header?.indexOf('memo') ?? -1;
    const note = header?.indexOf('label_note') ?? -1;
    expect(rows.map((r) => r[memo])).toEqual([
      `'=HYPERLINK("http://evil","click")`,
      "'+cmd|calc",
      "'-2+3",
      "'@SUM(1)",
      'quote " and, comma\nand newline',
      '😀 日本語',
      '',
    ]);
    expect(rows[0]?.[note]).toBe("'=1+1");
    expect(rows[0]?.[header?.indexOf('label') ?? -1]).toBe('income');
  });

  it('writes amounts as plain decimals and never prefixes numbers', () => {
    const [header, ...rows] = rowsOf(csv).map((r) => r.fields);
    const amount = header?.indexOf('amount') ?? -1;
    expect(rows[0]?.[amount]).toBe('1.5000000');
    expect(rows[6]?.[amount]).toBe('');
    // every row has as many columns as the header, even with commas and newlines in memos
    for (const r of rows) expect(r.length).toBe(header?.length);
  });

  it('includes unknown events with their operation type', () => {
    const [header, ...rows] = rowsOf(csv).map((r) => r.fields);
    const last = rows[6];
    expect(last?.[header?.indexOf('type') ?? -1]).toBe('unknown');
    expect(last?.[header?.indexOf('op_type') ?? -1]).toBe('change_trust');
  });
});

describe('gains.csv', () => {
  const ISSUER = `G${'A'.repeat(55)}`;
  const U = 10_000_000n;
  const events = [
    event({ id: 'a', type: 'payment_in', asset: 'native', amount: 10n * U, ledger: 1 }),
    event({
      id: 'b',
      type: 'payment_out',
      asset: 'native',
      amount: 4n * U,
      time: '2025-01-05T00:00:00Z',
      ledger: 2,
    }),
    event({
      id: 'c',
      type: 'payment_out',
      asset: 'native',
      amount: 6n * U,
      time: '2025-01-06T00:00:00Z',
      ledger: 3,
    }),
    event({
      id: 'd',
      type: 'payment_out',
      asset: `X:${ISSUER}`,
      amount: U,
      time: '2025-01-07T00:00:00Z',
      ledger: 4,
    }),
  ];
  const result = computeCostBasis({
    events,
    labels: [
      { eventId: 'a', label: 'income' },
      { eventId: 'b', label: 'disposal' },
      { eventId: 'c', label: 'disposal' },
      { eventId: 'd', label: 'disposal' },
    ],
    prices: parsePriceCsv(
      'asset,date,price,currency\nnative,2025-01-01,1,USD\nnative,2025-01-05,2,USD\nnative,2025-01-06,3,USD',
    ),
    currency: 'USD',
    method: 'fifo',
  });
  const csv = writeGainsCsv(result, META);

  it('starts with the disclaimer, and states method, currency, source and range', () => {
    expect(csv.split('\n')[0]).toBe(`# ${DISCLAIMER}`);
    expect(csv).toContain('# Method: FIFO. Currency: USD. Prices: supplied by the user.');
    expect(csv).toContain('# History range: ledgers 100 to 200');
  });

  it('has ok rows with exact, rounded figures and error rows for what could not be calculated', () => {
    const [header, ...rows] = rowsOf(csv).map((r) => r.fields);
    const col = (name: string) => header?.indexOf(name) ?? -1;
    expect(header).toEqual([
      'status',
      'acquired_date',
      'disposed_date',
      'asset',
      'quantity',
      'proceeds',
      'cost_basis',
      'gain',
      'holding_days',
      'currency',
      'event_ids',
      'note',
    ]);
    // b: 4 units, proceeds 8.00, cost 4.00 ; c: 6 units, proceeds 18.00, cost 6.00
    expect(rows[0]?.slice(0, 11)).toEqual([
      'ok',
      '2025-01-01',
      '2025-01-05',
      'native',
      '4.0000000',
      '8.00',
      '4.00',
      '4.00',
      '4',
      'USD',
      'b a',
    ]);
    expect(rows[1]?.[col('gain')]).toBe('12.00');
    const error = rows[2];
    expect(error?.[col('status')]).toBe('error');
    expect(error?.[col('note')]).toContain('missing_price');
    expect(error?.[col('proceeds')]).toBe('');
    expect(csv).toContain('# Total gain of the ok rows: 16.00 USD');
    expect(csv).toContain('# Rows with status error: 1.');
  });

  it('writes a negative gain as a plain number, not as text', () => {
    const loss = computeCostBasis({
      events: [
        event({ id: 'a', asset: 'native', amount: U, ledger: 1 }),
        event({
          id: 'b',
          type: 'payment_out',
          asset: 'native',
          amount: U,
          time: '2025-01-02T00:00:00Z',
          ledger: 2,
        }),
      ],
      labels: [
        { eventId: 'a', label: 'income' },
        { eventId: 'b', label: 'disposal' },
      ],
      prices: parsePriceCsv(
        'asset,date,price,currency\nnative,2025-01-01,5,USD\nnative,2025-01-02,2,USD',
      ),
      currency: 'USD',
      method: 'fifo',
    });
    const [header, row] = rowsOf(writeGainsCsv(loss, META)).map((r) => r.fields);
    expect(row?.[header?.indexOf('gain') ?? -1]).toBe('-3.00');
  });

  it('neutralises an asset code from the chain that starts with a formula character', () => {
    const odd = computeCostBasis({
      events: [event({ id: 'z', type: 'payment_out', asset: `=X:${ISSUER}`, amount: U })],
      labels: [{ eventId: 'z', label: 'disposal' }],
      prices: parsePriceCsv('asset,date,price,currency'),
      currency: 'USD',
      method: 'fifo',
    });
    expect(writeGainsCsv(odd, META)).toContain(`'=X:${ISSUER}`);
  });

  it('is listed in the export-format registry', () => {
    expect(Object.keys(EXPORT_FORMATS)).toEqual(['generic-csv']);
  });
});
