import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('reads required and optional settings and applies defaults', () => {
    const c = loadConfig({
      HORIZON_URL: 'https://horizon.example',
      CORS_ORIGINS: 'https://a.example, https://b.example',
      CACHE_DB: './cache.sqlite',
      TRUST_PROXY: 'true',
      PORT: '9000',
    });
    expect(c).toMatchObject({
      horizonUrl: 'https://horizon.example',
      port: 9000,
      host: '127.0.0.1',
      maxEvents: 20_000,
      rateLimitMax: 30,
      corsOrigins: ['https://a.example', 'https://b.example'],
      cacheDb: './cache.sqlite',
      trustProxy: true,
    });
  });

  it('treats empty values as unset', () => {
    const c = loadConfig({
      HORIZON_URL: 'https://h.example',
      PORT: '',
      CACHE_DB: '',
      CORS_ORIGINS: '',
    });
    expect(c.port).toBe(8787);
    expect(c.cacheDb).toBeUndefined();
    expect(c.corsOrigins).toEqual([]);
  });

  it('has no default network: HORIZON_URL is required', () => {
    expect(() => loadConfig({})).toThrow('HORIZON_URL');
  });

  it('names the wrong variables without printing their values', () => {
    try {
      loadConfig({ HORIZON_URL: 'not-a-url-SECRETISH', PORT: 'abc-SECRETISH', MAX_EVENTS: '0' });
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('HORIZON_URL');
      expect(message).toContain('PORT');
      expect(message).toContain('MAX_EVENTS');
      expect(message).not.toContain('SECRETISH');
    }
  });
});
