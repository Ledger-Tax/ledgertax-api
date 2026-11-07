import type { DatabaseSync } from 'node:sqlite';
import { rawRecordSchema } from '@veronicdev/ledgertax-core';
import type { FetchOptions, HistorySource, RawRecord } from '@veronicdev/ledgertax-core';

/**
 * Store for PUBLIC chain history only: raw records per (source, address). It has no place for labels,
 * prices or anything a user supplied (decision D3), and no method accepts them.
 *
 * WAVE-ISSUE(api-3): another store (for example Postgres) implements this interface.
 */
export interface HistoryStore {
  /** Cached records for the key, oldest first. */
  read(source: string, address: string): AsyncIterable<RawRecord>;
  /** Cursor of the last cached record, or undefined if nothing is cached. */
  lastCursor(source: string, address: string): Promise<string | undefined>;
  /** Appends records. Callers only append whole transactions, so the last cursor is a safe resume point. */
  append(source: string, address: string, records: readonly RawRecord[]): Promise<void>;
  /** Releases resources. */
  close(): Promise<void>;
}

/** In-memory store: the default, and what tests use. Lost on restart. */
export class MemoryHistoryStore implements HistoryStore {
  private readonly data = new Map<string, RawRecord[]>();

  async *read(source: string, address: string): AsyncIterable<RawRecord> {
    for (const record of this.data.get(`${source}|${address}`) ?? []) yield record;
  }

  async lastCursor(source: string, address: string): Promise<string | undefined> {
    return this.data.get(`${source}|${address}`)?.at(-1)?.cursor;
  }

  async append(source: string, address: string, records: readonly RawRecord[]): Promise<void> {
    const key = `${source}|${address}`;
    this.data.set(key, [...(this.data.get(key) ?? []), ...structuredClone(records)]);
  }

  async close(): Promise<void> {
    this.data.clear();
  }
}

/** The only table the SQLite store creates. Exported so a test can prove nothing else is stored. */
export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS history_records (
  source TEXT NOT NULL,
  address TEXT NOT NULL,
  seq INTEGER NOT NULL,
  cursor TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (source, address, seq)
) WITHOUT ROWID;
`;

/** SQLite store using Node's built-in `node:sqlite`. Persists across restarts. */
export class SqliteHistoryStore implements HistoryStore {
  private readonly db: DatabaseSync;

  /** @param path - database file, or `:memory:` */
  constructor(path: string) {
    // Loaded with getBuiltinModule, not `import`, because bundlers (tsup/esbuild) rewrite the
    // prefix-only built-in `node:sqlite` to a bare `sqlite` package that does not exist. This also
    // means SQLite is only loaded when a SQLite store is actually created.
    const sqlite = process.getBuiltinModule('node:sqlite');
    if (!sqlite)
      throw new Error(
        'node:sqlite is not available in this Node.js version (need 22.13 or newer).',
      );
    this.db = new sqlite.DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SQLITE_SCHEMA);
  }

  async *read(source: string, address: string): AsyncIterable<RawRecord> {
    const page = this.db.prepare(
      'SELECT seq, record FROM history_records WHERE source = ? AND address = ? AND seq > ? ORDER BY seq LIMIT 500',
    );
    let after = -1;
    for (;;) {
      const rows = page.all(source, address, after) as { seq: number; record: string }[];
      for (const row of rows) {
        after = row.seq;
        yield rawRecordSchema.parse(JSON.parse(row.record));
      }
      if (rows.length < 500) return;
    }
  }

  async lastCursor(source: string, address: string): Promise<string | undefined> {
    const row = this.db
      .prepare(
        'SELECT cursor FROM history_records WHERE source = ? AND address = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(source, address) as { cursor: string } | undefined;
    return row?.cursor;
  }

  async append(source: string, address: string, records: readonly RawRecord[]): Promise<void> {
    if (records.length === 0) return;
    const max = this.db
      .prepare(
        'SELECT COALESCE(MAX(seq), -1) AS m FROM history_records WHERE source = ? AND address = ?',
      )
      .get(source, address) as { m: number };
    const insert = this.db.prepare(
      'INSERT INTO history_records (source, address, seq, cursor, record) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      records.forEach((record, i) => {
        insert.run(source, address, max.m + 1 + i, record.cursor, JSON.stringify(record));
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * Wraps a {@link HistorySource} with a {@link HistoryStore}. A request first replays what is cached,
 * then asks the real source only for what comes after the last cached record, and caches that. New
 * records are stored one whole transaction at a time, so a failure part-way leaves the cache at a
 * clean transaction boundary and the next request carries on from there.
 *
 * Reading `since` and `limit` are applied to what is returned, never to what is fetched or stored, so
 * the cache never has holes. Asking for a specific `cursor` bypasses the cache.
 */
export class CachedSource implements HistorySource {
  readonly name: string;
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * @param inner - the real source
   * @param store - where public history is kept
   * @param namespace - separates networks and servers, for example the Horizon base URL
   */
  constructor(
    private readonly inner: HistorySource,
    private readonly store: HistoryStore,
    private readonly namespace: string,
  ) {
    this.name = inner.name;
  }

  async *fetch(address: string, opts: FetchOptions = {}): AsyncIterable<RawRecord> {
    if (opts.cursor !== undefined) {
      yield* this.inner.fetch(address, opts);
      return;
    }
    const key = `${this.namespace}|${this.inner.name}`;
    const release = await this.acquire(`${key}|${address}`);
    try {
      const sinceMs = opts.since === undefined ? undefined : Date.parse(opts.since);
      let yielded = 0;
      const wanted = (r: RawRecord): boolean =>
        sinceMs === undefined || r.time === undefined || Date.parse(r.time) >= sinceMs;
      const full = (): boolean => opts.limit !== undefined && yielded >= opts.limit;

      for await (const record of this.store.read(key, address)) {
        if (full()) return;
        if (wanted(record)) {
          yielded += 1;
          yield record;
        }
      }

      const last = await this.store.lastCursor(key, address);
      let group: RawRecord[] = [];
      for await (const record of this.inner.fetch(
        address,
        last === undefined ? {} : { cursor: last },
      )) {
        if (record.kind === 'transaction' && group.length > 0) {
          await this.store.append(key, address, group);
          group = [];
        }
        group.push(record);
        if (full()) return; // the unfinished group is dropped, never cached
        if (wanted(record)) {
          yielded += 1;
          yield record;
        }
      }
      if (group.length > 0) await this.store.append(key, address, group);
    } finally {
      release();
    }
  }

  /** Serialises requests for the same key so two cold requests cannot both store the same records. */
  private async acquire(key: string): Promise<() => void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => mine);
    this.locks.set(key, chain);
    await previous;
    return () => {
      release();
      if (this.locks.get(key) === chain) this.locks.delete(key);
    };
  }
}
