import { LedgerTaxError } from 'ledgertax-core';
import type { Label, LedgerEvent } from 'ledgertax-core';
import { fiatValue, formatUnits, proportion } from './money.js';
import type { PriceTable } from './prices.js';

/** Cost-basis methods. WAVE-ISSUE(api-1): LIFO and average cost are added here. */
export type CostBasisMethod = 'fifo';

/** The requested cost-basis method is not implemented. */
export class UnsupportedMethodError extends LedgerTaxError {
  constructor(method: string) {
    super('unsupported_method', `Cost-basis method "${method}" is not supported. Supported: fifo.`);
  }
}

/** One realised gain or loss: the part of a disposal that consumed (part of) one lot. */
export interface GainRow {
  /** When the consumed lot was acquired (UTC ISO). */
  acquiredAt: string;
  /** When the disposal happened (UTC ISO). */
  disposedAt: string;
  asset: string;
  /** Quantity in the asset's smallest unit. */
  quantity: bigint;
  decimals: number;
  /** Exact fiat values at scale 10^19 (format with `formatFiat`). */
  proceeds: bigint;
  costBasis: bigint;
  gain: bigint;
  /** Whole UTC days between acquisition and disposal. */
  holdingDays: number;
  currency: string;
  disposalEventId: string;
  acquisitionEventId: string;
}

/** Why a row is reported as a problem instead of a result. Nothing is guessed. */
export type IssueCode =
  'missing_price' | 'insufficient_lots' | 'unknown_cost_basis' | 'invalid_label' | 'missing_amount';

/** A problem the user has to resolve: it is shown as an error row in the report. */
export interface IssueRow {
  code: IssueCode;
  eventId: string;
  time: string;
  asset?: string;
  /** Quantity affected, when it applies. */
  quantity?: bigint;
  decimals?: number;
  message: string;
}

/** An acquisition the user labelled as income, at the supplied price. */
export interface IncomeRow {
  eventId: string;
  time: string;
  asset: string;
  quantity: bigint;
  decimals: number;
  value: bigint;
  currency: string;
}

/** Quantity that left a wallet but was not backed by known lots (fees and transfers). */
export interface Shortfall {
  asset: string;
  quantity: bigint;
  decimals: number;
}

/** Everything {@link computeCostBasis} produced. */
export interface CostBasisResult {
  method: CostBasisMethod;
  currency: string;
  gains: GainRow[];
  issues: IssueRow[];
  incomes: IncomeRow[];
  shortfalls: Shortfall[];
}

/** Input of {@link computeCostBasis}. */
export interface CostBasisInput {
  events: readonly LedgerEvent[];
  labels: readonly Label[];
  prices: PriceTable;
  currency: string;
  method: CostBasisMethod;
}

interface Lot {
  eventId: string;
  acquiredAt: string;
  remaining: bigint;
  /** Cost of the remaining quantity at scale 10^19, or null if unknown. */
  cost: bigint | null;
  decimals: number;
}

const INFLOW = new Set(['payment_in', 'account_funded', 'claimable_claimed']);
const DAY_MS = 86_400_000;

/**
 * Computes realised gains with FIFO lots, per asset, from classified events and user labels.
 *
 * Rules (decision D6: the tool never decides taxable meaning on its own):
 *  - a `trade` disposes of the sold asset and acquires the bought asset. Its value is the received
 *    asset's price times the received quantity, or, if that asset has no price that day, the sold
 *    asset's price times the sold quantity. No price for either gives an error row.
 *  - a `payment_out` is a disposal only if labelled `disposal` (proceeds = amount x price). Unlabelled,
 *    `transfer` or `gift` payments out use up lots without creating a gain, since the asset left.
 *  - a `payment_in` (and funding, claims, merges in) is an acquisition with UNKNOWN cost unless labelled
 *    `income`, which makes the lot cost the supplied price. Disposing of an unknown-cost lot gives an
 *    error row, not a guess.
 *  - fees use up native lots without a gain. `unknown` events are ignored (they are listed in the
 *    events report). `ignore` removes an event from the calculation.
 *  - a disposal larger than the lots held gives an error row for the uncovered quantity; the covered
 *    part still produces gain rows.
 * Proceeds are split across lots without losing a unit: the parts always add up to the total.
 *
 * @param input - events, labels, prices, currency and method
 * @throws UnsupportedMethodError for any method other than `fifo`
 */
export function computeCostBasis(input: CostBasisInput): CostBasisResult {
  if (input.method !== 'fifo') throw new UnsupportedMethodError(String(input.method));
  const { prices, currency } = input;
  const labels = new Map(input.labels.map((l) => [l.eventId, l.label]));

  const gains: GainRow[] = [];
  const issues: IssueRow[] = [];
  const incomes: IncomeRow[] = [];
  const shortfalls = new Map<string, Shortfall>();
  const lots = new Map<string, Lot[]>();

  const lotsOf = (asset: string): Lot[] => {
    let list = lots.get(asset);
    if (!list) lots.set(asset, (list = []));
    return list;
  };
  const priceOf = (asset: string, time: string): bigint | undefined =>
    prices.get(asset, time.slice(0, 10), currency);
  const issue = (e: LedgerEvent, code: IssueCode, message: string, extra: Partial<IssueRow> = {}) =>
    issues.push({ code, eventId: e.id, time: e.time, message, ...extra });

  /** Removes `quantity` from the oldest lots first; returns what could not be covered. */
  const consume = (
    asset: string,
    quantity: bigint,
    onSlice: (lot: Lot, take: bigint, cost: bigint | null) => void,
  ): bigint => {
    const list = lotsOf(asset);
    let left = quantity;
    while (left > 0n) {
      const lot = list[0];
      if (!lot) break;
      const take = left < lot.remaining ? left : lot.remaining;
      let cost: bigint | null = null;
      if (lot.cost !== null) {
        cost = take === lot.remaining ? lot.cost : proportion(lot.cost, take, lot.remaining);
        lot.cost -= cost;
      }
      lot.remaining -= take;
      left -= take;
      onSlice(lot, take, cost);
      if (lot.remaining === 0n) list.shift();
    }
    return left;
  };

  const useUp = (asset: string, quantity: bigint, decimals: number): void => {
    const missing = consume(asset, quantity, () => undefined);
    if (missing > 0n) {
      const s = shortfalls.get(asset) ?? { asset, quantity: 0n, decimals };
      s.quantity += missing;
      shortfalls.set(asset, s);
    }
  };

  const dispose = (
    e: LedgerEvent,
    asset: string,
    quantity: bigint,
    decimals: number,
    proceeds: bigint,
  ): void => {
    let taken = 0n;
    let allocated = 0n;
    const uncovered = consume(asset, quantity, (lot, take, cost) => {
      taken += take;
      const cumulative = proportion(proceeds, taken, quantity);
      const part = cumulative - allocated;
      allocated = cumulative;
      if (cost === null) {
        issue(
          e,
          'unknown_cost_basis',
          `The cost basis of ${formatUnits(take, decimals)} ${asset} is unknown (they arrived by a plain payment or transfer). Label the incoming payment as income if it was income.`,
          { asset, quantity: take, decimals },
        );
        return;
      }
      gains.push({
        acquiredAt: lot.acquiredAt,
        disposedAt: e.time,
        asset,
        quantity: take,
        decimals,
        proceeds: part,
        costBasis: cost,
        gain: part - cost,
        holdingDays: Math.floor((Date.parse(e.time) - Date.parse(lot.acquiredAt)) / DAY_MS),
        currency,
        disposalEventId: e.id,
        acquisitionEventId: lot.eventId,
      });
    });
    if (uncovered > 0n) {
      issue(
        e,
        'insufficient_lots',
        `Disposed of more ${asset} than the history shows as held: ${formatUnits(uncovered, decimals)} are not covered by any acquisition (the history may start after they were bought).`,
        { asset, quantity: uncovered, decimals },
      );
    }
  };

  const acquire = (
    e: LedgerEvent,
    asset: string,
    quantity: bigint,
    decimals: number,
    cost: bigint | null,
  ): void => {
    if (quantity > 0n)
      lotsOf(asset).push({
        eventId: e.id,
        acquiredAt: e.time,
        remaining: quantity,
        cost,
        decimals,
      });
  };

  const sorted = input.events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.ledger - b.e.ledger || a.i - b.i)
    .map((x) => x.e);

  for (const e of sorted) {
    const label = labels.get(e.id);
    if (label === 'ignore') continue;
    const decimals = e.decimals ?? 7;
    const isInflow = INFLOW.has(e.type) || (e.type === 'account_merged' && e.direction === 'in');
    const isOutflow =
      e.type === 'payment_out' || (e.type === 'account_merged' && e.direction === 'out');
    const allowed: readonly string[] = isInflow
      ? ['income', 'transfer', 'gift']
      : isOutflow
        ? ['disposal', 'transfer', 'gift']
        : [];
    if (label !== undefined && !allowed.includes(label)) {
      issue(
        e,
        'invalid_label',
        `The label "${label}" cannot be applied to a ${e.type} event, so it was ignored.`,
      );
    }
    const applied = label !== undefined && allowed.includes(label) ? label : undefined;

    if (e.type === 'fee') {
      if (e.asset !== undefined && e.amount !== undefined) useUp(e.asset, e.amount, decimals);
      continue;
    }

    if (e.type === 'trade') {
      if (
        e.asset === undefined ||
        e.amount === undefined ||
        e.counterAsset === undefined ||
        e.counterAmount === undefined
      ) {
        issue(e, 'missing_amount', 'The trade has no amounts, so it was not calculated.');
        continue;
      }
      const counterDecimals = e.counterDecimals ?? 7;
      const gotPrice = priceOf(e.counterAsset, e.time);
      const soldPrice = priceOf(e.asset, e.time);
      const value =
        gotPrice !== undefined
          ? fiatValue(e.counterAmount, counterDecimals, gotPrice)
          : soldPrice !== undefined
            ? fiatValue(e.amount, decimals, soldPrice)
            : undefined;
      if (value === undefined) {
        issue(
          e,
          'missing_price',
          `No ${currency} price on ${e.time.slice(0, 10)} for ${e.counterAsset} or ${e.asset}, so this trade was not valued.`,
          { asset: e.counterAsset },
        );
        useUp(e.asset, e.amount, decimals);
        acquire(e, e.counterAsset, e.counterAmount, counterDecimals, null);
      } else {
        dispose(e, e.asset, e.amount, decimals, value);
        acquire(e, e.counterAsset, e.counterAmount, counterDecimals, value);
      }
      continue;
    }

    if (isInflow || isOutflow) {
      if (e.asset === undefined || e.amount === undefined) {
        issue(e, 'missing_amount', `The ${e.type} event has no amount, so it was not calculated.`);
        continue;
      }
      const price = priceOf(e.asset, e.time);
      if (isInflow) {
        if (applied === 'income') {
          if (price === undefined) {
            issue(
              e,
              'missing_price',
              `No ${currency} price on ${e.time.slice(0, 10)} for ${e.asset}, so this income was not valued.`,
              { asset: e.asset },
            );
            acquire(e, e.asset, e.amount, decimals, null);
          } else {
            const value = fiatValue(e.amount, decimals, price);
            incomes.push({
              eventId: e.id,
              time: e.time,
              asset: e.asset,
              quantity: e.amount,
              decimals,
              value,
              currency,
            });
            acquire(e, e.asset, e.amount, decimals, value);
          }
        } else {
          acquire(e, e.asset, e.amount, decimals, null);
        }
        continue;
      }
      if (applied === 'disposal') {
        if (price === undefined) {
          issue(
            e,
            'missing_price',
            `No ${currency} price on ${e.time.slice(0, 10)} for ${e.asset}, so this disposal was not valued.`,
            { asset: e.asset },
          );
          useUp(e.asset, e.amount, decimals);
        } else {
          dispose(e, e.asset, e.amount, decimals, fiatValue(e.amount, decimals, price));
        }
      } else {
        useUp(e.asset, e.amount, decimals);
      }
    }
    // `unknown` and any other type: nothing to calculate; they stay visible in the events report.
  }

  return { method: 'fifo', currency, gains, issues, incomes, shortfalls: [...shortfalls.values()] };
}
