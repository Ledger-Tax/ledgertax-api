import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classifyAccount } from 'ledgertax-core';
import type { RawRecord } from 'ledgertax-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CachedSource,
  MemoryHistoryStore,
  SQLITE_SCHEMA,
  SqliteHistoryStore,
} from '../src/cache.js';
import type { HistoryStore } from '../src/cache.js';
import { RecordingSource, W, collect, fixtureEvents, fixtureRecords } from './helpers.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ledgertax-cache-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const records = fixtureRecords();
const stores: [string, () => HistoryStore][] = [
  ['memory', () => new MemoryHistoryStore()],
  ['sqlite', () => new SqliteHistoryStore(':memory:')],
];

describe.each(stores)('%s store', (_name, make) => {
  it('stores records in order and reports the last cursor', async () => {
    const store = make();
    expect(await store.lastCursor('s', W)).toBeUndefined();
    expect(await collect(store.read('s', W))).toEqual([]);
    await store.append('s', W, records.slice(0, 3));
    await store.append('s', W, records.slice(3, 7));
    expect(await collect(store.read('s', W))).toEqual(records.slice(0, 7));
    expect(await store.lastCursor('s', W)).toBe(records[6]?.cursor);
    await store.close();
  });

  it('keeps sources and addresses apart', async () => {
    const store = make();
    await store.append('s1', W, records.slice(0, 2));
    await store.append('s2', W, records.slice(2, 5));
    expect((await collect(store.read('s1', W))).length).toBe(2);
    expect((await collect(store.read('s2', W))).length).toBe(3);
    expect(await collect(store.read('s1', 'GOTHER'))).toEqual([]);
    await store.close();
  });

  it('reads more than one page of records', async () => {
    const store = make();
    const many: RawRecord[] = Array.from({ length: 1200 }, (_, i) => ({
      ...(records[0] as RawRecord),
      cursor: `c${i}`,
      ref: `r${i}`,
    }));
    await store.append('s', W, many);
    expect((await collect(store.read('s', W))).length).toBe(1200);
    await store.close();
  });
});

describe('SqliteHistoryStore', () => {
  it('survives a restart', async () => {
    const path = join(dir, 'restart.sqlite');
    const first = new SqliteHistoryStore(path);
    await first.append('s', W, records.slice(0, 10));
    await first.close();
    const second = new SqliteHistoryStore(path);
    expect((await collect(second.read('s', W))).length).toBe(10);
    expect(await second.lastCursor('s', W)).toBe(records[9]?.cursor);
    await second.close();
  });

  it('rolls back a failed append and refuses a corrupted row on read', async () => {
    const path = join(dir, 'corrupt.sqlite');
    const store = new SqliteHistoryStore(path);
    await store.append('s', W, records.slice(0, 2));
    // a duplicate cursor is allowed, but a record that cannot be stored must not leave half a batch
    await expect(
      store.append('s', W, [records[2] as RawRecord, { circular: 1n } as unknown as RawRecord]),
    ).rejects.toThrow();
    expect((await collect(store.read('s', W))).length).toBe(2);
    await store.close();

    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE history_records SET record = \'{"nope":true}\' WHERE seq = 0').run();
    raw.close();
    const reopened = new SqliteHistoryStore(path);
    await expect(collect(reopened.read('s', W))).rejects.toThrow();
    await reopened.close();
  });

  it('stores nothing but public history: one table with record columns only', async () => {
    const path = join(dir, 'schema.sqlite');
    const store = new SqliteHistoryStore(path);
    await store.append('s', W, records.slice(0, 5));
    await store.close();
    const raw = new DatabaseSync(path);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).toEqual(['history_records']);
    const columns = raw.prepare('PRAGMA table_info(history_records)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual(['source', 'address', 'seq', 'cursor', 'record']);
    raw.close();
    expect(SQLITE_SCHEMA).not.toMatch(/label|price|note|currency/i);
  });
});

describe('CachedSource', () => {
  it('fills the cache on the first request and serves it on the second, asking only for newer history', async () => {
    const inner = new RecordingSource();
    const cached = new CachedSource(inner, new MemoryHistoryStore(), 'ns');
    const first = await collect(classifyAccount(cached, W));
    expect(first).toEqual(await fixtureEvents());
    expect(inner.calls).toEqual([{}]);
    const pulledAfterFirst = inner.pulled;

    const second = await collect(classifyAccount(cached, W));
    expect(second).toEqual(first);
    // the second request only asked for what came after the last cached record
    expect(inner.calls[1]).toEqual({ cursor: records[records.length - 1]?.cursor });
    expect(inner.pulled).toBe(pulledAfterFirst);
  });

  it('resumes after a restart, from a clean transaction boundary, losing and repeating nothing', async () => {
    const path = join(dir, 'resume.sqlite');
    const flaky = new RecordingSource(undefined, Math.floor(records.length / 2));
    const firstStore = new SqliteHistoryStore(path);
    await expect(collect(new CachedSource(flaky, firstStore, 'ns').fetch(W))).rejects.toThrow(
      'connection reset',
    );
    await firstStore.close();

    // "restart": a new store on the same file and a healthy source
    const secondStore = new SqliteHistoryStore(path);
    const healthy = new RecordingSource();
    const cached = new CachedSource(healthy, secondStore, 'ns');
    const events = await collect(classifyAccount(cached, W));
    expect(events).toEqual(await fixtureEvents());
    const resumeCursor = healthy.calls[0]?.cursor;
    expect(resumeCursor).toBeDefined();
    // the cursor it resumed from is the end of a whole transaction, so the next record starts one
    const at = records.findIndex((r) => r.cursor === resumeCursor);
    expect(records[at + 1]?.kind).toBe('transaction');
    // and everything is stored exactly once
    expect((await collect(secondStore.read(`ns|fixture`, W))).length).toBe(records.length);
    await secondStore.close();
  });

  it('keeps different namespaces apart', async () => {
    const store = new MemoryHistoryStore();
    const a = new RecordingSource();
    const b = new RecordingSource();
    await collect(new CachedSource(a, store, 'mainnet').fetch(W));
    await collect(new CachedSource(b, store, 'testnet').fetch(W));
    expect(b.calls).toEqual([{}]); // testnet did not see mainnet's cache
  });

  it('applies since and limit to the output without damaging the cache', async () => {
    const store = new MemoryHistoryStore();
    const inner = new RecordingSource();
    const cached = new CachedSource(inner, store, 'ns');
    const limited = await collect(cached.fetch(W, { limit: 5 }));
    expect(limited).toHaveLength(5);
    // an unfinished transaction is never cached, so a later full request still gets everything once
    const all = await collect(cached.fetch(W));
    expect(all.map((r) => r.cursor)).toEqual(records.map((r) => r.cursor));

    const later = records.filter((r) => r.kind === 'transaction')[10]?.time as string;
    const since = await collect(cached.fetch(W, { since: later }));
    expect(since.length).toBeLessThan(records.length);
    expect(since.every((r) => r.time === undefined || r.time >= later)).toBe(true);
    expect((await collect(cached.fetch(W))).length).toBe(records.length);
  });

  it('bypasses the cache when asked for a specific cursor', async () => {
    const inner = new RecordingSource();
    const cached = new CachedSource(inner, new MemoryHistoryStore(), 'ns');
    const rest = await collect(cached.fetch(W, { cursor: records[20]?.cursor }));
    expect(rest.length).toBe(records.length - 21);
    expect(inner.calls).toEqual([{ cursor: records[20]?.cursor }]);
  });

  it('does not store a half-finished transaction when the source fails', async () => {
    const store = new MemoryHistoryStore();
    const flaky = new RecordingSource(undefined, 25);
    await expect(collect(new CachedSource(flaky, store, 'ns').fetch(W))).rejects.toThrow();
    const stored = await collect(store.read('ns|fixture', W));
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(25);
    // ends where a transaction ends: the next record in the source starts a new transaction
    const next = records[stored.length];
    expect(next?.kind).toBe('transaction');
  });

  it('gives two simultaneous cold requests the same history and stores it once', async () => {
    const store = new MemoryHistoryStore();
    const inner = new RecordingSource();
    const cached = new CachedSource(inner, store, 'ns');
    const [a, b] = await Promise.all([collect(cached.fetch(W)), collect(cached.fetch(W))]);
    expect(a).toEqual(b);
    expect(a.length).toBe(records.length);
    expect((await collect(store.read('ns|fixture', W))).length).toBe(records.length);
  });

  it('never writes user data: a label or price sentinel does not appear in the database file', async () => {
    const path = join(dir, 'privacy.sqlite');
    const store = new SqliteHistoryStore(path);
    const cached = new CachedSource(new RecordingSource(), store, 'ns');
    await collect(classifyAccount(cached, W));
    await store.close();
    const bytes = (await readFile(path)).toString('latin1');
    for (const sentinel of ['SENTINEL-LABEL-NOTE', 'SENTINEL-PRICE']) {
      expect(bytes).not.toContain(sentinel);
    }
  });
});
