import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = readFileSync(join(root, 'openapi.yaml'), 'utf8');
const app = readFileSync(join(root, 'src', 'app.ts'), 'utf8');
const service = readFileSync(join(root, 'src', 'service.ts'), 'utf8');

describe('openapi.yaml stays in step with the code', () => {
  it('documents every route the app registers, with its method', () => {
    const routes = [...app.matchAll(/app\.(get|post)\('([^']+)'/g)].map((m) => [m[1], m[2]]);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const [method, path] of routes) {
      const block = new RegExp(`^  ${path}:\\n(?:    .*\\n|\\n)*?    ${method}:`, 'm');
      expect(spec, `${method} ${path}`).toMatch(block);
    }
  });

  it('lists every error code the app can return', () => {
    const codes = new Set<string>();
    for (const m of app.matchAll(/(?:fail\(\s*\d+,\s*|code: )'([a-z_]+)'/g)) codes.add(m[1] ?? '');
    expect(codes.size).toBeGreaterThan(10);
    for (const code of codes) expect(spec, code).toContain(`- ${code}`);
  });

  it('lists every issue code the cost basis can produce', () => {
    const costbasis = readFileSync(join(root, 'src', 'costbasis.ts'), 'utf8');
    const union = /export type IssueCode =([^;]+);/.exec(costbasis)?.[1] ?? '';
    const codes = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBe(5);
    for (const code of codes) expect(spec, code).toContain(code ?? '');
  });

  it('documents every field of the event and report JSON', () => {
    const dto = /export interface EventDto \{([\s\S]*?)\n\}/.exec(service)?.[1] ?? '';
    const fields = [...dto.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(10);
    for (const f of fields) expect(spec, f).toContain(`${f}:`);
  });

  it('carries the disclaimer', () => {
    expect(spec).toContain('Accounting export, not tax advice.');
  });
});
