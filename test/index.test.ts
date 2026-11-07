import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('skeleton', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('ledgertax-api');
  });
  it('does not export a different name', () => {
    expect(PACKAGE_NAME).not.toBe('other');
  });
});
