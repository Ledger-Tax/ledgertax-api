import type { Label, LedgerEvent } from 'ledgertax-core';
import type { CostBasisResult, GainRow, IssueRow } from './costbasis.js';
import { DISCLAIMER, writeCsv } from './csv-write.js';
import type { Column } from './csv-write.js';
import { formatFiat, formatUnits } from './money.js';

/** What a report says about where it came from. Every report states its source and range. */
export interface ReportMeta {
  /** UTC ISO time the report was made. */
  generatedAt: string;
  address: string;
  /** For example "Horizon (https://horizon.example)". */
  source: string;
  /** Plain-language range of the history, for example "ledgers 59010481 to 65318314 (about one year)". */
  range: string;
}

const day = (iso: string): string => iso.slice(0, 10);
const units = (amount: bigint | undefined, decimals: number | undefined): string =>
  amount === undefined ? '' : formatUnits(amount, decimals ?? 7);

interface EventRow {
  event: LedgerEvent;
  label: Label | undefined;
}

const EVENT_COLUMNS: readonly Column<EventRow>[] = [
  { header: 'event_id', kind: 'text', value: (r) => r.event.id },
  { header: 'tx_hash', kind: 'text', value: (r) => r.event.txHash },
  { header: 'op_index', kind: 'number', value: (r) => String(r.event.opIndex) },
  { header: 'ledger', kind: 'number', value: (r) => String(r.event.ledger) },
  { header: 'time', kind: 'text', value: (r) => r.event.time },
  { header: 'type', kind: 'text', value: (r) => r.event.type },
  { header: 'op_type', kind: 'text', value: (r) => r.event.opType ?? '' },
  { header: 'direction', kind: 'text', value: (r) => r.event.direction ?? '' },
  { header: 'asset', kind: 'text', value: (r) => r.event.asset ?? '' },
  { header: 'amount', kind: 'number', value: (r) => units(r.event.amount, r.event.decimals) },
  { header: 'counter_asset', kind: 'text', value: (r) => r.event.counterAsset ?? '' },
  {
    header: 'counter_amount',
    kind: 'number',
    value: (r) => units(r.event.counterAmount, r.event.counterDecimals),
  },
  { header: 'counterparty', kind: 'text', value: (r) => r.event.counterparty ?? '' },
  { header: 'memo', kind: 'text', value: (r) => r.event.memo ?? '' },
  { header: 'label', kind: 'text', value: (r) => r.label?.label ?? '' },
  { header: 'label_note', kind: 'text', value: (r) => r.label?.note ?? '' },
  { header: 'raw_source', kind: 'text', value: (r) => r.event.raw.source },
  { header: 'raw_ref', kind: 'text', value: (r) => r.event.raw.ref },
];

function headerComments(meta: ReportMeta, extra: string[]): string[] {
  return [
    DISCLAIMER,
    `Generated: ${meta.generatedAt}`,
    `Address: ${meta.address}`,
    `Source: ${meta.source}`,
    `History range: ${meta.range}`,
    ...extra,
  ];
}

/**
 * `events.csv`: every classified event with its label. Memos, asset codes and labels are untrusted
 * text and are neutralised against formula injection. `unknown` events are included, never hidden.
 */
export function writeEventsCsv(
  events: readonly LedgerEvent[],
  labels: readonly Label[],
  meta: ReportMeta,
): string {
  const byId = new Map(labels.map((l) => [l.eventId, l]));
  const rows = events.map((event) => ({ event, label: byId.get(event.id) }));
  const unknown = events.filter((e) => e.type === 'unknown').length;
  return writeCsv(
    EVENT_COLUMNS,
    rows,
    headerComments(meta, [
      `Events: ${events.length}, of which unknown: ${unknown} (not understood, shown as is)`,
    ]),
  );
}

type GainsLine = { kind: 'gain'; row: GainRow } | { kind: 'issue'; row: IssueRow };

function gainsColumns(decimals: number): readonly Column<GainsLine>[] {
  const g = (l: GainsLine): GainRow | undefined => (l.kind === 'gain' ? l.row : undefined);
  const i = (l: GainsLine): IssueRow | undefined => (l.kind === 'issue' ? l.row : undefined);
  return [
    { header: 'status', kind: 'text', value: (l) => (l.kind === 'gain' ? 'ok' : 'error') },
    {
      header: 'acquired_date',
      kind: 'text',
      value: (l) => (g(l) ? day(g(l)?.acquiredAt ?? '') : ''),
    },
    {
      header: 'disposed_date',
      kind: 'text',
      value: (l) => day(g(l)?.disposedAt ?? i(l)?.time ?? ''),
    },
    { header: 'asset', kind: 'text', value: (l) => g(l)?.asset ?? i(l)?.asset ?? '' },
    {
      header: 'quantity',
      kind: 'number',
      value: (l) => {
        const q = g(l)?.quantity ?? i(l)?.quantity;
        return q === undefined ? '' : formatUnits(q, g(l)?.decimals ?? i(l)?.decimals ?? 7);
      },
    },
    {
      header: 'proceeds',
      kind: 'number',
      value: (l) => (g(l) ? formatFiat(g(l)?.proceeds ?? 0n, decimals) : ''),
    },
    {
      header: 'cost_basis',
      kind: 'number',
      value: (l) => (g(l) ? formatFiat(g(l)?.costBasis ?? 0n, decimals) : ''),
    },
    {
      header: 'gain',
      kind: 'number',
      value: (l) => (g(l) ? formatFiat(g(l)?.gain ?? 0n, decimals) : ''),
    },
    {
      header: 'holding_days',
      kind: 'number',
      value: (l) => (g(l) ? String(g(l)?.holdingDays) : ''),
    },
    { header: 'currency', kind: 'text', value: (l) => g(l)?.currency ?? '' },
    {
      header: 'event_ids',
      kind: 'text',
      value: (l) =>
        g(l) ? `${g(l)?.disposalEventId} ${g(l)?.acquisitionEventId}` : (i(l)?.eventId ?? ''),
    },
    { header: 'note', kind: 'text', value: (l) => (i(l) ? `${i(l)?.code}: ${i(l)?.message}` : '') },
  ];
}

/**
 * `gains.csv`: realised gains (rows with status `ok`) followed by error rows for everything that
 * could not be calculated (missing price, disposal larger than the lots held, unknown cost basis).
 * Error rows are never guesses.
 *
 * @param result - output of `computeCostBasis`
 * @param meta - source and range statement
 * @param fiatDecimals - decimals for fiat amounts, default 2
 */
export function writeGainsCsv(result: CostBasisResult, meta: ReportMeta, fiatDecimals = 2): string {
  const total = result.gains.reduce((sum, row) => sum + row.gain, 0n);
  const extra = [
    `Method: ${result.method.toUpperCase()}. Currency: ${result.currency}. Prices: supplied by the user.`,
    `Total gain of the ok rows: ${formatFiat(total, fiatDecimals)} ${result.currency} (sum of unrounded values; rows are rounded individually)`,
    `Rows with status error: ${result.issues.length}. They are not included in any total.`,
    ...result.shortfalls.map(
      (s) =>
        `Warning: ${formatUnits(s.quantity, s.decimals)} of ${s.asset} left through fees or transfers without known lots`,
    ),
  ];
  const lines: GainsLine[] = [
    ...result.gains.map((row): GainsLine => ({ kind: 'gain', row })),
    ...result.issues.map((row): GainsLine => ({ kind: 'issue', row })),
  ];
  return writeCsv(gainsColumns(fiatDecimals), lines, headerComments(meta, extra));
}

/**
 * Export-format registry. WAVE-ISSUE(api-2): another export format registers here.
 * Every format must start its output with the disclaimer and neutralise untrusted text.
 */
export const EXPORT_FORMATS = {
  'generic-csv': { events: writeEventsCsv, gains: writeGainsCsv },
} as const;
