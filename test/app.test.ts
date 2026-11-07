import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { AccountNotFoundError, StrKey_forTests } from './strkey.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppOptions } from '../src/app.js';
import { CachedSource, SqliteHistoryStore } from '../src/cache.js';
import { RecordingSource, W, fixtureEvents, fixtureSource } from './helpers.js';
import type { EventDto } from '../src/service.js';

const secretShaped = StrKey_forTests();
const INFO = { description: 'Horizon (https://horizon.example)', range: 'ledgers 1 to 2' };

function make(overrides: Partial<AppOptions> = {}) {
  return createApp({
    source: fixtureSource(),
    describeSource: async () => INFO,
    maxBodyBytes: 1_000_000,
    maxPriceCsvBytes: 100_000,
    maxEvents: 10_000,
    rateLimitMax: 1000,
    rateLimitWindowMs: 60_000,
    corsOrigins: [],
    trustProxy: false,
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
}
const errorOf = (res: { json: () => unknown }) =>
  (res.json() as { error: { code: string; message: string; details?: unknown; cursor?: string } })
    .error;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ledgertax-app-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GET /health', () => {
  it('answers ok', async () => {
    const res = await make().inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
  it('answers 404 with a typed error for unknown routes', async () => {
    const res = await make().inject('/nope');
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
  });
});

describe('GET /events', () => {
  it('returns the classified events of an address as JSON with bigints as strings', async () => {
    const res = await make().inject(`/events?address=${W}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      address: string;
      source: unknown;
      count: number;
      events: EventDto[];
    };
    const expected = await fixtureEvents();
    expect(body.count).toBe(expected.length);
    expect(body.source).toEqual(INFO);
    expect(body.events[0]).toMatchObject({
      type: 'account_funded',
      asset: 'native',
      amount: '100000000000',
      decimals: 7,
    });
    expect(body.events.map((e) => e.id)).toEqual(expected.map((e) => e.id));
  });

  it('streams NDJSON events and ends with a done line', async () => {
    const res = await make().inject(`/events?address=${W}&format=ndjson`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const expected = await fixtureEvents();
    expect(lines.slice(0, -1).every((l) => 'event' in l)).toBe(true);
    expect(lines.at(-1)).toEqual({ done: true, count: expected.length });
  });

  it('reports a mid-stream failure as the last NDJSON line, with a resume cursor', async () => {
    const source = new RecordingSource(undefined, 40);
    const res = await make({ source }).inject(`/events?address=${W}&format=ndjson`);
    expect(res.statusCode).toBe(200);
    const last = JSON.parse(res.body.trim().split('\n').at(-1) ?? '{}') as {
      error?: { code: string; cursor?: string };
    };
    expect(last.error?.code).toBe('upstream_failed');
    expect(last.error?.cursor).toBeDefined();
  });

  it('turns a failure before any event into a normal HTTP error', async () => {
    const source = new RecordingSource(undefined, 0);
    for (const format of ['json', 'ndjson']) {
      const res = await make({ source }).inject(`/events?address=${W}&format=${format}`);
      expect(res.statusCode, format).toBe(502);
      expect(errorOf(res).code).toBe('upstream_failed');
    }
  });

  it('answers 404 for an account that does not exist', async () => {
    const missing = {
      name: 'x',
      fetch(): AsyncIterable<never> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              throw new AccountNotFoundError();
            },
          }),
        };
      },
    };
    const res = await make({ source: missing }).inject(`/events?address=${W}`);
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('account_not_found');
  });

  it('refuses histories above the limit and says how to narrow them', async () => {
    const json = await make({ maxEvents: 5 }).inject(`/events?address=${W}`);
    expect(json.statusCode).toBe(422);
    expect(errorOf(json).code).toBe('history_too_large');
    expect(errorOf(json).message).toContain('since');
    const nd = await make({ maxEvents: 5 }).inject(`/events?address=${W}&format=ndjson`);
    const last = JSON.parse(nd.body.trim().split('\n').at(-1) ?? '{}') as {
      error?: { code: string };
    };
    expect(last.error?.code).toBe('history_too_large');
  });

  it('rejects an invalid address, and never echoes the input', async () => {
    const res = await make().inject('/events?address=not-an-address-xyz');
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('invalid_address');
    expect(res.body).not.toContain('not-an-address-xyz');
  });

  it('rejects a secret-key-shaped address and never echoes it', async () => {
    const res = await make().inject(`/events?address=${secretShaped}`);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('secret_key_rejected');
    expect(res.body).not.toContain(secretShaped);
  });

  it('rejects unknown parameters, a bad format and a bad since date', async () => {
    for (const q of ['extra=1', 'format=xml', 'since=yesterday', 'since=2025-02-30']) {
      const res = await make().inject(`/events?address=${W}&${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(errorOf(res).code).toBe('invalid_request');
    }
    expect((await make().inject('/events')).statusCode).toBe(400);
  });

  it('applies since to the history', async () => {
    const res = await make().inject(`/events?address=${W}&since=2030-01-01`);
    expect((res.json() as { count: number }).count).toBe(0);
  });
});

describe('POST /reports', () => {
  async function labelsFor() {
    const events = await fixtureEvents();
    const funded = events.find((e) => e.type === 'account_funded');
    return [{ eventId: funded?.id ?? '', label: 'income' as const, note: 'my note' }];
  }
  const prices = 'asset,date,price,currency\nnative,2026-11-06,0.10,USD\n';

  it('builds a report with gains, error rows and both CSV files', async () => {
    const res = await make().inject({
      method: 'POST',
      url: '/reports',
      payload: { address: W, currency: 'USD', priceCsv: prices, labels: await labelsFor() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      address: string;
      method: string;
      counts: { events: number; unknownEvents: number; gains: number; issues: number };
      totals: { gain: string };
      issues: { code: string }[];
      files: { eventsCsv: string; gainsCsv: string };
      source: unknown;
      generatedAt: string;
    };
    expect(body).toMatchObject({
      address: W,
      method: 'fifo',
      source: INFO,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(body.counts.events).toBe((await fixtureEvents()).length);
    expect(body.counts.unknownEvents).toBeGreaterThan(0);
    // the 10000 XLM income lot gives the XLM sales a cost basis; the TEST lots arrived by plain payment, so selling them is an error row
    expect(body.issues.map((i) => i.code)).toContain('unknown_cost_basis');
    expect(body.counts.gains).toBeGreaterThan(0);
    expect(body.totals.gain).toMatch(/^-?\d+\.\d{2}$/);
    for (const file of [body.files.eventsCsv, body.files.gainsCsv]) {
      expect(file.split('\n')[0]).toBe('# Accounting export, not tax advice.');
      expect(file).toContain('# Source: Horizon (https://horizon.example)');
    }
    expect(body.files.eventsCsv).toContain('my note');
  });

  it('works without prices or labels (everything unpriced is an error row, nothing is guessed)', async () => {
    const res = await make().inject({
      method: 'POST',
      url: '/reports',
      payload: { address: W, currency: 'EUR' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { gains: unknown[] }).gains).toEqual([]);
  });

  it('rejects a bad price file with row numbers', async () => {
    const res = await make().inject({
      method: 'POST',
      url: '/reports',
      payload: {
        address: W,
        currency: 'USD',
        priceCsv: 'asset,date,price,currency\nnative,2026-13-01,1,USD\nnative,2026-01-01,-1,USD',
      },
    });
    expect(res.statusCode).toBe(422);
    const e = errorOf(res);
    expect(e.code).toBe('invalid_price_csv');
    expect((e.details as { row: number }[]).map((d) => d.row)).toEqual([2, 3]);
  });

  it('rejects an oversize price file and an oversize body', async () => {
    const big = `asset,date,price,currency\n${'#'.repeat(5000)}\n`;
    const a = await make({ maxPriceCsvBytes: 1000 }).inject({
      method: 'POST',
      url: '/reports',
      payload: { address: W, currency: 'USD', priceCsv: big },
    });
    expect(a.statusCode).toBe(413);
    expect(errorOf(a).code).toBe('price_csv_too_large');
    const b = await make({ maxBodyBytes: 2000 }).inject({
      method: 'POST',
      url: '/reports',
      payload: { address: W, currency: 'USD', priceCsv: big },
    });
    expect(b.statusCode).toBe(413);
    expect(errorOf(b).code).toBe('payload_too_large');
  });

  it('validates every field', async () => {
    const bad: unknown[] = [
      { address: W },
      { address: W, currency: 'usd' },
      { address: W, currency: 'USD', method: 'lifo' },
      { address: W, currency: 'USD', fiatDecimals: 12 },
      { address: W, currency: 'USD', labels: [{ eventId: 'x', label: 'sale' }] },
      { address: W, currency: 'USD', surprise: true },
      { address: 5, currency: 'USD' },
    ];
    for (const payload of bad) {
      const res = await make().inject({
        method: 'POST',
        url: '/reports',
        payload: payload as object,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errorOf(res).code).toBe('invalid_request');
    }
  });

  it('rejects an invalid address and a secret key anywhere in the body, without echoing it', async () => {
    const invalid = await make().inject({
      method: 'POST',
      url: '/reports',
      payload: { address: 'nope', currency: 'USD' },
    });
    expect(errorOf(invalid).code).toBe('invalid_address');
    for (const payload of [
      { address: secretShaped, currency: 'USD' },
      {
        address: W,
        currency: 'USD',
        labels: [{ eventId: 'x', label: 'ignore', note: secretShaped }],
      },
      { address: W, currency: 'USD', priceCsv: `asset,date,price,currency\n# ${secretShaped}\n` },
    ]) {
      const res = await make().inject({ method: 'POST', url: '/reports', payload });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('secret_key_rejected');
      expect(res.body).not.toContain(secretShaped);
    }
  });

  it('rejects invalid JSON and a wrong content type', async () => {
    const bad = await make().inject({
      method: 'POST',
      url: '/reports',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('invalid_json');
    const type = await make().inject({
      method: 'POST',
      url: '/reports',
      headers: { 'content-type': 'application/xml' },
      payload: 'x',
    });
    expect(type.statusCode).toBe(415);
    expect(errorOf(type).code).toBe('unsupported_media_type');
  });

  it('reports a source failure as 502 and hides unexpected internal errors', async () => {
    const down = await make({ source: new RecordingSource(undefined, 0) }).inject({
      method: 'POST',
      url: '/reports',
      payload: { address: W, currency: 'USD' },
    });
    expect(down.statusCode).toBe(502);
    const broken = await make({
      describeSource: async () => {
        throw new Error('boom: internal detail');
      },
    }).inject({
      method: 'POST',
      url: '/reports',
      payload: { address: W, currency: 'USD' },
    });
    expect(broken.statusCode).toBe(500);
    expect(errorOf(broken).code).toBe('internal_error');
    expect(broken.body).not.toContain('boom');
  });
});

describe('rate limit and CORS', () => {
  it('limits requests per IP with Retry-After, but never limits /health', async () => {
    const app = make({ rateLimitMax: 3 });
    for (let i = 0; i < 3; i += 1)
      expect((await app.inject(`/events?address=${W}&since=2030-01-01`)).statusCode).toBe(200);
    const limited = await app.inject(`/events?address=${W}`);
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('allows only configured origins', async () => {
    const app = make({ corsOrigins: ['https://app.example'] });
    const ok = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.example' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example');
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/reports',
      headers: { origin: 'https://app.example' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toContain('POST');
    const other = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      (
        await make().inject({
          method: 'GET',
          url: '/health',
          headers: { origin: 'https://app.example' },
        })
      ).headers['access-control-allow-origin'],
    ).toBeUndefined();
  });
});

describe('privacy', () => {
  it('logs no address, query string, body, label or price', async () => {
    let logs = '';
    const logStream = new Writable({
      write(chunk, _enc, done) {
        logs += String(chunk);
        done();
      },
    });
    const app = make({ logStream });
    await app.inject(`/events?address=${W}&since=2030-01-01`);
    await app.inject({
      method: 'POST',
      url: '/reports',
      payload: {
        address: W,
        currency: 'USD',
        priceCsv: 'asset,date,price,currency\n# SENTINEL-PRICE\n',
        labels: [{ eventId: 'x', label: 'ignore', note: 'SENTINEL-LABEL-NOTE' }],
      },
    });
    await app.inject(`/events?address=nope`);
    expect(logs).toContain('/events');
    for (const secret of [W, 'since=', 'SENTINEL', 'priceCsv', 'currency']) {
      expect(logs, secret).not.toContain(secret);
    }
  });

  it('writes no label or price data to the cache file through a full report request', async () => {
    const path = join(dir, 'e2e-privacy.sqlite');
    const store = new SqliteHistoryStore(path);
    const source = new CachedSource(fixtureSource(), store, 'ns');
    const app = make({ source });
    const res = await app.inject({
      method: 'POST',
      url: '/reports',
      payload: {
        address: W,
        currency: 'USD',
        priceCsv:
          'asset,date,price,currency\n# SENTINEL-PRICE-FILE\nnative,2026-11-06,0.1234567,USD\n',
        labels: [{ eventId: 'x', label: 'income', note: 'SENTINEL-LABEL-NOTE' }],
      },
    });
    expect(res.statusCode).toBe(200);
    await store.close();
    const bytes = (await readFile(path)).toString('latin1');
    for (const sentinel of ['SENTINEL-LABEL-NOTE', 'SENTINEL-PRICE-FILE', '0.1234567']) {
      expect(bytes).not.toContain(sentinel);
    }
    expect(bytes).toContain(W); // the public history itself is cached
  });
});
