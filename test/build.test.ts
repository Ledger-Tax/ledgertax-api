import { createRequire } from 'node:module';
import { readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'node_modules', '.cache', 'ledgertax-api-build-test');
/** tsup matches files with forward slashes only, even on Windows. */
const slash = (p: string): string => p.replaceAll('\\', '/');

describe('the built package', () => {
  beforeAll(async () => {
    await build({
      entry: [slash(join(root, 'src', 'index.ts')), slash(join(root, 'src', 'server.ts'))],
      format: ['esm', 'cjs'],
      outDir: slash(outDir),
      dts: false,
      clean: true,
      silent: true,
      config: false,
      tsconfig: slash(join(root, 'tsconfig.json')),
    });
  }, 120_000);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('never imports a bare "sqlite" package (a bundler once rewrote node:sqlite to it)', async () => {
    const files = (await readdir(outDir)).filter((f) => /\.(js|cjs)$/.test(f));
    const text = (await Promise.all(files.map((f) => readFile(join(outDir, f), 'utf8')))).join(
      '\n',
    );
    expect(text).not.toMatch(
      /from\s+["']sqlite["']|require\(["']sqlite["']\)|import\(["']sqlite["']\)/,
    );
    expect(text).toContain('getBuiltinModule("node:sqlite")');
  });

  it('loads as ESM and CommonJS, exports the same API, and can create a SQLite store', async () => {
    const esm = (await import(pathToFileURL(join(outDir, 'index.js')).href)) as Record<
      string,
      unknown
    >;
    const cjs = createRequire(import.meta.url)(join(outDir, 'index.cjs')) as Record<
      string,
      unknown
    >;
    for (const name of [
      'createApp',
      'computeCostBasis',
      'parsePriceCsv',
      'SqliteHistoryStore',
      'writeGainsCsv',
    ]) {
      expect(typeof esm[name], `esm ${name}`).toBe('function');
      expect(typeof cjs[name], `cjs ${name}`).toBe('function');
    }
    expect(Object.keys(cjs).sort()).toEqual(Object.keys(esm).sort());
    for (const api of [esm, cjs]) {
      const Store = api['SqliteHistoryStore'] as new (path: string) => {
        close: () => Promise<void>;
      };
      const store = new Store(':memory:'); // would throw if node:sqlite could not be loaded
      await store.close();
    }
    // loading the bundle pulls in the Stellar SDK, which is slow on a cold start
  }, 90_000);
});
