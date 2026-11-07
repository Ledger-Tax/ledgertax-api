import { LedgerTaxError } from 'ledgertax-core';
import { z } from 'zod';

/** Settings of the HTTP server. Network and endpoints always come from here, never from code. */
export interface ServerConfig {
  /** Horizon base URL (required, no default: the operator chooses the network). */
  horizonUrl: string;
  port: number;
  host: string;
  /** Maximum request body, in bytes. */
  maxBodyBytes: number;
  /** Maximum size of an uploaded price CSV, in bytes. */
  maxPriceCsvBytes: number;
  /** Maximum events one request may produce. */
  maxEvents: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  /** Origins allowed by CORS. Empty means no CORS headers are sent. */
  corsOrigins: string[];
  /** SQLite file for the public-history cache. Empty means an in-memory cache. */
  cacheDb: string | undefined;
  /** Trust X-Forwarded-For (only behind a proxy you control). */
  trustProxy: boolean;
}

const int = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const envSchema = z.object({
  HORIZON_URL: z.string().url(),
  PORT: int(8787, 1, 65535),
  HOST: z.string().min(1).default('127.0.0.1'),
  MAX_BODY_BYTES: int(2_000_000, 1_000, 50_000_000),
  MAX_PRICE_CSV_BYTES: int(1_048_576, 100, 10_000_000),
  MAX_EVENTS: int(20_000, 1, 1_000_000),
  RATE_LIMIT_MAX: int(30, 1, 100_000),
  RATE_LIMIT_WINDOW_MS: int(60_000, 1_000, 86_400_000),
  CORS_ORIGINS: z.string().default(''),
  CACHE_DB: z.string().default(''),
  TRUST_PROXY: z.enum(['true', 'false', '']).default('false'),
});

/**
 * Reads the server configuration from environment variables. Empty values count as unset.
 *
 * @param env - usually `process.env`
 * @throws LedgerTaxError (code `invalid_config`) naming the variables that are wrong, without their values
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new LedgerTaxError('invalid_config', `Invalid or missing configuration: ${names}`);
  }
  const e = parsed.data;
  return {
    horizonUrl: e.HORIZON_URL,
    port: e.PORT,
    host: e.HOST,
    maxBodyBytes: e.MAX_BODY_BYTES,
    maxPriceCsvBytes: e.MAX_PRICE_CSV_BYTES,
    maxEvents: e.MAX_EVENTS,
    rateLimitMax: e.RATE_LIMIT_MAX,
    rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    cacheDb: e.CACHE_DB === '' ? undefined : e.CACHE_DB,
    trustProxy: e.TRUST_PROXY === 'true',
  };
}
