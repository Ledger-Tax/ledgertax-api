import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureSource, classifyAccount } from 'ledgertax-core';
import type { FetchOptions, HistorySource, LedgerEvent, RawRecord } from 'ledgertax-core';

/** Folder with the recorded testnet fixtures (copied from ledgertax-core). */
export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface Manifest {
  counterparties: { B: string; issuer: string };
  files: { address: string; file: string; role: string }[];
}
const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as Manifest;

/** The watched testnet account of the fixtures, and its counterparties. */
export const W = manifest.files.find((f) => f.role === 'main watched account')?.address ?? '';
export const B = manifest.counterparties.B;
export const ISSUER = manifest.counterparties.issuer;
export const TEST_ASSET = `TEST:${ISSUER}`;

/** All records of the main fixture, in order. */
export function fixtureRecords(): RawRecord[] {
  const file = manifest.files.find((f) => f.address === W)?.file ?? '';
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as RawRecord[];
}

/** All events of the main fixture, from core's classifier. */
export async function fixtureEvents(): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  for await (const e of classifyAccount(new FixtureSource(FIXTURE_DIR), W)) out.push(e);
  return out;
}

/** The fixtures as a source. */
export function fixtureSource(): HistorySource {
  return new FixtureSource(FIXTURE_DIR);
}

/**
 * A source over the main fixture that records how it was called and can fail after N records.
 * `calls` holds the options of every `fetch`.
 */
export class RecordingSource implements HistorySource {
  readonly name = 'fixture';
  readonly calls: FetchOptions[] = [];
  pulled = 0;

  constructor(
    private readonly inner: HistorySource = fixtureSource(),
    public failAfter?: number,
  ) {}

  async *fetch(address: string, opts: FetchOptions = {}): AsyncIterable<RawRecord> {
    this.calls.push(opts);
    let served = 0;
    for await (const record of this.inner.fetch(address, opts)) {
      if (this.failAfter !== undefined && served >= this.failAfter) {
        throw new Error('connection reset');
      }
      served += 1;
      this.pulled += 1;
      yield record;
    }
  }
}

/** Collects an async iterable. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
