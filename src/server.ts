import { CachedSource, MemoryHistoryStore, SqliteHistoryStore } from './cache.js';
import type { HistoryStore } from './cache.js';
import { HorizonSource } from '@veronicdev/ledgertax-core';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { SourceInfo } from './service.js';

/** Starts the HTTP server from environment variables (see .env.example). */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const horizon = new HorizonSource({ baseUrl: config.horizonUrl });
  const store: HistoryStore = config.cacheDb
    ? new SqliteHistoryStore(config.cacheDb)
    : new MemoryHistoryStore();
  const source = new CachedSource(horizon, store, config.horizonUrl);

  let cached: { at: number; info: SourceInfo } | undefined;
  const describeSource = async (): Promise<SourceInfo> => {
    if (cached && Date.now() - cached.at < 300_000) return cached.info;
    const c = await horizon.coverage();
    const info: SourceInfo = {
      description: `Horizon (${c.baseUrl}), network "${c.networkPassphrase}"`,
      range: `ledgers ${c.historyElderLedger} to ${c.historyLatestLedger}, the history this server still holds; anything older is not included and may affect cost basis`,
    };
    cached = { at: Date.now(), info };
    return info;
  };

  const app = createApp({
    source,
    describeSource,
    maxBodyBytes: config.maxBodyBytes,
    maxPriceCsvBytes: config.maxPriceCsvBytes,
    maxEvents: config.maxEvents,
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs,
    corsOrigins: config.corsOrigins,
    trustProxy: config.trustProxy,
    logStream: process.stdout,
  });

  const stop = async (): Promise<void> => {
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  // Configuration errors name the variables that are wrong, never their values.
  console.error(error instanceof Error ? error.message : 'Failed to start.');
  process.exit(1);
});
