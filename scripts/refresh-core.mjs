// Refreshes the committed copy of ledgertax-core used by this package.
//
// Monorepo-only maintenance helper: it builds and packs the sibling `ledgertax-core` folder and
// copies the tarball into `vendor/`. After the repos are split, or once core is published to npm,
// delete this script and the `vendor/` folder and depend on core with a semver range instead.
//
// Usage: pnpm core:refresh <path-to-ledgertax-core>   (default: ../ledgertax-core)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const core = resolve(process.argv[2] ?? '../ledgertax-core');
const vendor = resolve('vendor');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const shell = process.platform === 'win32';

mkdirSync(vendor, { recursive: true });
for (const f of readdirSync(vendor))
  if (f.startsWith('ledgertax-core-')) rmSync(resolve(vendor, f));
execFileSync(pnpm, ['install', '--frozen-lockfile'], { cwd: core, stdio: 'inherit', shell });
execFileSync(pnpm, ['build'], { cwd: core, stdio: 'inherit', shell });
execFileSync(pnpm, ['pack', '--pack-destination', vendor], { cwd: core, stdio: 'inherit', shell });
console.log(
  'Packed. Update the "ledgertax-core" file: path in package.json if the version changed, then run pnpm install.',
);
