import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file loads ledgertax-core and with it the Stellar SDK, which is slow on a cold
    // start, especially when several workers do it at once.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
