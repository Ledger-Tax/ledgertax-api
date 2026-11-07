/** Package name, used by the smoke test to prove the build and test pipeline works. */
export const PACKAGE_NAME = 'ledgertax-api' as const;

export { createApp } from './app.js';
export type { AppOptions, ErrorBody } from './app.js';
export { CachedSource, MemoryHistoryStore, SqliteHistoryStore } from './cache.js';
export type { HistoryStore } from './cache.js';
export { loadConfig } from './config.js';
export type { ServerConfig } from './config.js';
export { computeCostBasis, UnsupportedMethodError } from './costbasis.js';
export type {
  CostBasisInput,
  CostBasisMethod,
  CostBasisResult,
  GainRow,
  IssueRow,
} from './costbasis.js';
export { DISCLAIMER, neutralize } from './csv-write.js';
export {
  CsvSyntaxError,
  HistoryTooLargeError,
  PriceCsvError,
  PriceCsvTooLargeError,
} from './errors.js';
export type { PriceCsvIssue } from './errors.js';
export { fiatValue, formatFiat, formatUnits, parsePrice } from './money.js';
export { PriceTable, parsePriceCsv } from './prices.js';
export { EXPORT_FORMATS, writeEventsCsv, writeGainsCsv } from './reports.js';
export type { ReportMeta } from './reports.js';
export { buildReport, streamEvents, toEventDto } from './service.js';
export type { EventDto, ReportDto, ReportInput, ServiceDeps, SourceInfo } from './service.js';
