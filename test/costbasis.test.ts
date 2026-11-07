import { describe, expect, it } from 'vitest';
import type { Label, LedgerEvent } from '@veronicdev/ledgertax-core';
import { UnsupportedMethodError, computeCostBasis } from '../src/costbasis.js';
import { formatFiat, formatUnits } from '../src/money.js';
import { parsePriceCsv } from '../src/prices.js';

const ISSUER = `G${'A'.repeat(55)}`;
const TEST = `TEST:${ISSUER}`;
const U = 10_000_000n; // one whole unit in stroops

let counter = 0;
function ev(date: string, type: LedgerEvent['type'], extra: Partial<LedgerEvent>): LedgerEvent {
  counter += 1;
  return {
    id: extra.id ?? `tx${counter}:0:0`,
    txHash: `tx${counter}`,
    opIndex: 0,
    ledger: counter,
    time: `${date}T00:00:00Z`,
    type,
    address: ISSUER,
    decimals: 7,
    raw: { source: 'test', ref: String(counter) },
    ...extra,
  };
}
const inbound = (id: string, date: string, asset: string, units: bigint) =>
  ev(date, 'payment_in', { id, asset, amount: units * U });
const outbound = (id: string, date: string, asset: string, units: bigint) =>
  ev(date, 'payment_out', { id, asset, amount: units * U });
const trade = (
  id: string,
  date: string,
  sold: string,
  soldUnits: bigint,
  got: string,
  gotUnits: bigint,
) =>
  ev(date, 'trade', {
    id,
    asset: sold,
    amount: soldUnits * U,
    counterAsset: got,
    counterAmount: gotUnits * U,
    counterDecimals: 7,
  });

function prices(rows: string[]) {
  return parsePriceCsv(['asset,date,price,currency', ...rows].join('\n'));
}
function run(events: LedgerEvent[], labels: Label[], rows: string[]) {
  return computeCostBasis({
    events,
    labels,
    prices: prices(rows),
    currency: 'USD',
    method: 'fifo',
  });
}
const fmt = (v: bigint) => formatFiat(v, 2);

describe('computeCostBasis: the hand-calculated example (docs/EXAMPLE.md)', () => {
  const events = [
    inbound('e1', '2025-01-01', 'native', 100n),
    inbound('e2', '2025-01-15', 'native', 50n),
    trade('e3', '2025-02-01', 'native', 120n, TEST, 30n),
    outbound('e4', '2025-03-01', 'native', 30n),
    outbound('e5', '2025-03-02', 'native', 10n),
    trade('e6', '2025-03-10', TEST, 10n, 'native', 50n),
    inbound('e7', '2025-03-11', 'native', 5n),
    outbound('e8', '2025-03-12', 'native', 52n),
  ];
  const labels: Label[] = [
    { eventId: 'e1', label: 'income' },
    { eventId: 'e2', label: 'income' },
    { eventId: 'e4', label: 'disposal' },
    { eventId: 'e5', label: 'disposal' },
    { eventId: 'e7', label: 'income' },
    { eventId: 'e8', label: 'disposal' },
  ];
  const rows = [
    'native,2025-01-01,0.10,USD',
    'native,2025-01-15,0.12,USD',
    `${TEST},2025-02-01,1.00,USD`,
    'native,2025-03-01,0.15,USD',
    'native,2025-03-02,0.15,USD',
    'native,2025-03-10,0.15,USD',
    'native,2025-03-11,0,USD',
    'native,2025-03-12,0.20,USD',
  ];
  const result = run(events, labels, rows);

  it('produces exactly the rows worked out by hand', () => {
    expect(
      result.gains.map((g) => [
        g.disposalEventId,
        g.acquisitionEventId,
        formatUnits(g.quantity, 7).replace(/\.?0+$/, ''),
        fmt(g.proceeds),
        fmt(g.costBasis),
        fmt(g.gain),
        g.holdingDays,
      ]),
    ).toEqual([
      ['e3', 'e1', '100', '25.00', '10.00', '15.00', 31],
      ['e3', 'e2', '20', '5.00', '2.40', '2.60', 17],
      ['e4', 'e2', '30', '4.50', '3.60', '0.90', 45],
      ['e6', 'e3', '10', '7.50', '10.00', '-2.50', 37],
      ['e8', 'e6', '50', '10.00', '7.50', '2.50', 2],
      ['e8', 'e7', '2', '0.40', '0.00', '0.40', 1],
    ]);
  });

  it('totals +18.90 and reports the uncovered disposal as an error row', () => {
    expect(fmt(result.gains.reduce((sum, g) => sum + g.gain, 0n))).toBe('18.90');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      code: 'insufficient_lots',
      eventId: 'e5',
      asset: 'native',
      quantity: 10n * U,
    });
  });

  it('records the income at the supplied prices, including the zero-cost lot', () => {
    expect(result.incomes.map((i) => [i.eventId, fmt(i.value)])).toEqual([
      ['e1', '10.00'],
      ['e2', '6.00'],
      ['e7', '0.00'],
    ]);
  });

  it('is deterministic: the same input gives the same result', () => {
    expect(run(events, labels, rows)).toEqual(result);
  });
});

describe('computeCostBasis: missing information is reported, never guessed', () => {
  it('reports a disposal without a price and still uses up the lots', () => {
    const events = [
      inbound('a', '2025-01-01', 'native', 10n),
      outbound('b', '2025-01-05', 'native', 4n),
      outbound('c', '2025-01-06', 'native', 6n),
    ];
    const labels: Label[] = [
      { eventId: 'a', label: 'income' },
      { eventId: 'b', label: 'disposal' },
      { eventId: 'c', label: 'disposal' },
    ];
    const r = run(events, labels, ['native,2025-01-01,1,USD', 'native,2025-01-06,2,USD']);
    expect(r.issues.map((i) => [i.code, i.eventId])).toEqual([['missing_price', 'b']]);
    // c used the remaining 6 units (cost 6.00 of 10.00 at 0.6 each): the 4 used by b are gone.
    expect(r.gains).toHaveLength(1);
    expect(fmt(r.gains[0]?.costBasis ?? 0n)).toBe('6.00');
    expect(fmt(r.gains[0]?.proceeds ?? 0n)).toBe('12.00');
  });

  it('values a trade with the sold asset price when the received asset has none', () => {
    const events = [
      inbound('a', '2025-01-01', 'native', 10n),
      trade('t', '2025-01-02', 'native', 10n, TEST, 5n),
    ];
    const r = run(
      events,
      [{ eventId: 'a', label: 'income' }],
      ['native,2025-01-01,1,USD', 'native,2025-01-02,3,USD'],
    );
    expect(fmt(r.gains[0]?.proceeds ?? 0n)).toBe('30.00');
    expect(fmt(r.gains[0]?.gain ?? 0n)).toBe('20.00');
  });

  it('reports a trade with no price for either asset', () => {
    const events = [
      inbound('a', '2025-01-01', 'native', 10n),
      trade('t', '2025-01-02', 'native', 10n, TEST, 5n),
    ];
    const r = run(events, [{ eventId: 'a', label: 'income' }], ['native,2025-01-01,1,USD']);
    expect(r.issues.map((i) => i.code)).toEqual(['missing_price']);
    expect(r.gains).toEqual([]);
  });

  it('reports income without a price and treats the lot as unknown cost', () => {
    const events = [
      inbound('a', '2025-01-01', 'native', 10n),
      outbound('b', '2025-01-02', 'native', 10n),
    ];
    const r = run(
      events,
      [
        { eventId: 'a', label: 'income' },
        { eventId: 'b', label: 'disposal' },
      ],
      ['native,2025-01-02,1,USD'],
    );
    expect(r.issues.map((i) => i.code)).toEqual(['missing_price', 'unknown_cost_basis']);
    expect(r.gains).toEqual([]);
  });

  it('does not invent a cost basis for an unlabelled incoming payment', () => {
    const events = [
      inbound('a', '2025-01-01', 'native', 10n),
      outbound('b', '2025-01-02', 'native', 10n),
    ];
    const r = run(events, [{ eventId: 'b', label: 'disposal' }], ['native,2025-01-02,1,USD']);
    expect(r.gains).toEqual([]);
    expect(r.issues.map((i) => [i.code, i.quantity])).toEqual([['unknown_cost_basis', 10n * U]]);
  });
});

describe('computeCostBasis: labels and default meaning', () => {
  it('treats unlabelled and transfer/gift payments out as no gain, but they use up lots', () => {
    const events = [
      inbound('a', '2025-01-01', 'native', 10n),
      outbound('b', '2025-01-02', 'native', 3n),
      outbound('c', '2025-01-03', 'native', 2n),
      outbound('d', '2025-01-04', 'native', 5n),
    ];
    const r = run(
      events,
      [
        { eventId: 'a', label: 'income' },
        { eventId: 'c', label: 'transfer' },
        { eventId: 'd', label: 'gift' },
      ],
      ['native,2025-01-01,1,USD'],
    );
    expect(r.gains).toEqual([]);
    expect(r.issues).toEqual([]);
    expect(r.shortfalls).toEqual([]);
  });

  it('skips events labelled ignore entirely', () => {
    const events = [
      inbound('a', '2025-01-01', 'native', 10n),
      outbound('b', '2025-01-02', 'native', 10n),
    ];
    const r = run(
      events,
      [
        { eventId: 'a', label: 'income' },
        { eventId: 'b', label: 'ignore' },
        { eventId: 'x', label: 'ignore' },
      ],
      ['native,2025-01-01,1,USD'],
    );
    expect(r.incomes).toHaveLength(1);
    expect(r.gains).toEqual([]);
  });

  it('reports a label that does not fit the event and ignores it', () => {
    const events = [
      inbound('a', '2025-01-01', 'native', 1n),
      outbound('b', '2025-01-02', 'native', 1n),
    ];
    const r = run(
      events,
      [
        { eventId: 'a', label: 'disposal' },
        { eventId: 'b', label: 'income' },
      ],
      [],
    );
    expect(r.issues.map((i) => [i.code, i.eventId])).toEqual([
      ['invalid_label', 'a'],
      ['invalid_label', 'b'],
    ]);
    expect(r.gains).toEqual([]);
  });

  it('uses up native lots for fees and records a shortfall instead of failing', () => {
    const first = inbound('a', '2025-01-01', 'native', 1n);
    const fee = ev('2025-01-02', 'fee', { id: 'f', asset: 'native', amount: 3n * U });
    const r = run([first, fee], [], []);
    expect(r.shortfalls).toEqual([{ asset: 'native', quantity: 2n * U, decimals: 7 }]);
    expect(r.issues).toEqual([]);
  });

  it('ignores unknown events but reports events without amounts', () => {
    const unknown = ev('2025-01-01', 'unknown', { id: 'u', opType: 'change_trust' });
    const merge = ev('2025-01-02', 'account_merged', { id: 'm', direction: 'in' });
    const r = run([unknown, merge], [], []);
    expect(r.issues.map((i) => [i.code, i.eventId])).toEqual([['missing_amount', 'm']]);
  });

  it('treats a merge in as an acquisition and a merge out as a payment out', () => {
    const into = ev('2025-01-01', 'account_merged', {
      id: 'm1',
      direction: 'in',
      asset: 'native',
      amount: 5n * U,
    });
    const out = ev('2025-01-02', 'account_merged', {
      id: 'm2',
      direction: 'out',
      asset: 'native',
      amount: 5n * U,
    });
    const r = run(
      [into, out],
      [
        { eventId: 'm1', label: 'income' },
        { eventId: 'm2', label: 'disposal' },
      ],
      ['native,2025-01-01,1,USD', 'native,2025-01-02,2,USD'],
    );
    expect(fmt(r.gains[0]?.gain ?? 0n)).toBe('5.00');
  });
});

describe('computeCostBasis: method', () => {
  it('rejects a method that is not implemented', () => {
    expect(() =>
      computeCostBasis({
        events: [],
        labels: [],
        prices: prices([]),
        currency: 'USD',
        method: 'lifo' as 'fifo',
      }),
    ).toThrow(UnsupportedMethodError);
  });
  it('returns an empty result for no events', () => {
    expect(run([], [], [])).toMatchObject({ gains: [], issues: [], incomes: [], shortfalls: [] });
  });
});
