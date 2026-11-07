import { classifyAccount, parseStellarAddress } from 'ledgertax-core';
import type { HistorySource, Label, LedgerEvent } from 'ledgertax-core';
import { computeCostBasis } from './costbasis.js';
import type { CostBasisMethod } from './costbasis.js';
import { HistoryTooLargeError } from './errors.js';
import { formatFiat, formatUnits } from './money.js';
import { parsePriceCsv } from './prices.js';
import { writeEventsCsv, writeGainsCsv } from './reports.js';

/** What the server says about its history source. Shown in every report. */
export interface SourceInfo {
  /** For example "Horizon (https://horizon.example)". */
  description: string;
  /** Plain-language range, for example "ledgers 100 to 200 as held by this server". */
  range: string;
}

/** Everything the service needs. */
export interface ServiceDeps {
  source: HistorySource;
  describeSource: () => Promise<SourceInfo>;
  maxEvents: number;
  maxPriceCsvBytes: number;
  now: () => Date;
}

/** A label as sent by the client. Labels live in the request or the browser, never on the server. */
export interface LabelInput {
  eventId: string;
  label: Label['label'];
  note?: string | undefined;
}

/** Input of {@link buildReport}. */
export interface ReportInput {
  address: string;
  since?: string | undefined;
  method: CostBasisMethod;
  currency: string;
  fiatDecimals: number;
  priceCsv?: string | undefined;
  labels: readonly LabelInput[];
}

/** JSON form of an event: bigints become decimal strings of the smallest unit. */
export interface EventDto {
  id: string;
  txHash: string;
  opIndex: number;
  ledger: number;
  time: string;
  type: LedgerEvent['type'];
  address: string;
  asset?: string;
  /** Smallest units, as a decimal string. Divide by 10^decimals to display. */
  amount?: string;
  decimals?: number;
  counterAsset?: string;
  counterAmount?: string;
  counterDecimals?: number;
  counterparty?: string;
  memo?: string;
  opType?: string;
  direction?: 'in' | 'out';
  raw: { source: string; ref: string };
}

/** Converts an event for JSON. */
export function toEventDto(e: LedgerEvent): EventDto {
  const dto: EventDto = {
    id: e.id,
    txHash: e.txHash,
    opIndex: e.opIndex,
    ledger: e.ledger,
    time: e.time,
    type: e.type,
    address: e.address,
    raw: { source: e.raw.source, ref: e.raw.ref },
  };
  if (e.asset !== undefined) dto.asset = e.asset;
  if (e.amount !== undefined) dto.amount = e.amount.toString();
  if (e.decimals !== undefined) dto.decimals = e.decimals;
  if (e.counterAsset !== undefined) dto.counterAsset = e.counterAsset;
  if (e.counterAmount !== undefined) dto.counterAmount = e.counterAmount.toString();
  if (e.counterDecimals !== undefined) dto.counterDecimals = e.counterDecimals;
  if (e.counterparty !== undefined) dto.counterparty = e.counterparty;
  if (e.memo !== undefined) dto.memo = e.memo;
  if (e.opType !== undefined) dto.opType = e.opType;
  if (e.direction !== undefined) dto.direction = e.direction;
  return dto;
}

/**
 * Streams the events of an address, failing if there are more than `maxEvents`.
 *
 * @throws HistoryTooLargeError when the limit is exceeded, plus whatever `classifyAccount` throws
 */
export async function* streamEvents(
  source: HistorySource,
  address: string,
  opts: { since?: string | undefined; maxEvents: number },
): AsyncGenerator<LedgerEvent> {
  const parsed = parseStellarAddress(address);
  if (!parsed.ok) throw parsed.error;
  let count = 0;
  for await (const event of classifyAccount(source, parsed.value.address, {
    ...(opts.since !== undefined ? { since: opts.since } : {}),
  })) {
    if (count >= opts.maxEvents) throw new HistoryTooLargeError(opts.maxEvents);
    count += 1;
    yield event;
  }
}

/** JSON form of a finished report. */
export interface ReportDto {
  address: string;
  generatedAt: string;
  method: CostBasisMethod;
  currency: string;
  fiatDecimals: number;
  source: SourceInfo;
  counts: { events: number; unknownEvents: number; gains: number; issues: number };
  totals: { gain: string };
  gains: {
    acquiredAt: string;
    disposedAt: string;
    asset: string;
    quantity: string;
    proceeds: string;
    costBasis: string;
    gain: string;
    holdingDays: number;
    currency: string;
    disposalEventId: string;
    acquisitionEventId: string;
  }[];
  issues: {
    code: string;
    eventId: string;
    time: string;
    asset?: string;
    quantity?: string;
    message: string;
  }[];
  warnings: { asset: string; quantity: string }[];
  /** The two downloadable files. Both start with "Accounting export, not tax advice." */
  files: { eventsCsv: string; gainsCsv: string };
}

/**
 * Builds a report: classified events, FIFO gains from the user's prices and labels, and both CSV files.
 * Nothing the user supplied (prices, labels) is stored.
 *
 * @throws PriceCsvError / PriceCsvTooLargeError for a bad price file, UnsupportedMethodError,
 * HistoryTooLargeError, and the errors of the history source
 */
export async function buildReport(deps: ServiceDeps, input: ReportInput): Promise<ReportDto> {
  const parsed = parseStellarAddress(input.address);
  if (!parsed.ok) throw parsed.error;
  const address = parsed.value.address;

  // WAVE-ISSUE(api-4): a price-source adapter replaces the user-supplied CSV here.
  // Validate the price file before touching the network, so a bad file fails fast.
  const prices = parsePriceCsv(input.priceCsv ?? 'asset,date,price,currency', {
    maxBytes: deps.maxPriceCsvBytes,
  });

  const events: LedgerEvent[] = [];
  for await (const e of streamEvents(deps.source, address, {
    since: input.since,
    maxEvents: deps.maxEvents,
  })) {
    events.push(e);
  }

  const labels: Label[] = input.labels.map((l) => ({
    eventId: l.eventId,
    label: l.label,
    ...(l.note !== undefined ? { note: l.note } : {}),
  }));
  const result = computeCostBasis({
    events,
    labels,
    prices,
    currency: input.currency,
    method: input.method,
  });

  const info = await deps.describeSource();
  const generatedAt = deps.now().toISOString();
  const meta = { generatedAt, address, source: info.description, range: info.range };
  const d = input.fiatDecimals;
  const total = result.gains.reduce((sum, g) => sum + g.gain, 0n);

  return {
    address,
    generatedAt,
    method: result.method,
    currency: input.currency,
    fiatDecimals: d,
    source: info,
    counts: {
      events: events.length,
      unknownEvents: events.filter((e) => e.type === 'unknown').length,
      gains: result.gains.length,
      issues: result.issues.length,
    },
    totals: { gain: formatFiat(total, d) },
    gains: result.gains.map((g) => ({
      acquiredAt: g.acquiredAt,
      disposedAt: g.disposedAt,
      asset: g.asset,
      quantity: formatUnits(g.quantity, g.decimals),
      proceeds: formatFiat(g.proceeds, d),
      costBasis: formatFiat(g.costBasis, d),
      gain: formatFiat(g.gain, d),
      holdingDays: g.holdingDays,
      currency: g.currency,
      disposalEventId: g.disposalEventId,
      acquisitionEventId: g.acquisitionEventId,
    })),
    issues: result.issues.map((i) => ({
      code: i.code,
      eventId: i.eventId,
      time: i.time,
      ...(i.asset !== undefined ? { asset: i.asset } : {}),
      ...(i.quantity !== undefined ? { quantity: formatUnits(i.quantity, i.decimals ?? 7) } : {}),
      message: i.message,
    })),
    warnings: result.shortfalls.map((s) => ({
      asset: s.asset,
      quantity: formatUnits(s.quantity, s.decimals),
    })),
    files: {
      eventsCsv: writeEventsCsv(events, labels, meta),
      gainsCsv: writeGainsCsv(result, meta, d),
    },
  };
}
