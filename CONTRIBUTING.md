# Contributing to ledgertax-api

Accounting export, not tax advice.

ledgertax-api is the backend that calculates cost basis from user-supplied prices, writes the CSV reports and serves the HTTP API. It is **read-only**: it never holds keys, signs or sends a transaction. Thank you for helping.

## Set up

You need Node.js 22.13 or newer (the cache uses the built-in `node:sqlite`) and [pnpm](https://pnpm.io).

- `pnpm install --frozen-lockfile`
- Core comes from npm (`@veronicdev/ledgertax-core`). To test against an unreleased core change, install a tarball made with `pnpm pack` in the core repository, and do not commit it.

## Check your work

Run this before every pull request. It must pass:

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Rules that matter here

- **No secrets, ever.** Never put a secret key, seed phrase or API key in code, tests, logs, commits or issues. Use public addresses and testnet only; never target mainnet in tests.
- **No personal data.** Do not commit the history of a real person's account.
- **Do not guess.** Unknown things stay unknown; a missing price is an error row, not a guess. Documentation describes only what exists and is tested.
- **Money is not a float.** Use `bigint` or decimal strings.
- **Every public function** has JSDoc, one test for success and at least one for failure.
- **Ask before adding a dependency** (open an issue first). New dependencies must be justified.
- TypeScript is `strict`, with no `any`.
- `openapi.yaml` must stay in step with the code; a test fails if a route or error code is missing from it.
- Money is never a floating-point number: amounts are `bigint`, prices are scaled integers.
- Anything that comes from the chain and is written to CSV must go through the neutralising writer in `src/csv-write.ts`.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/) with `api` as the scope, for example `feat(api): add something` or `fix(api): handle an edge case`. Keep one logical change per commit.

## Claiming an issue

1. Pick an issue and comment that you would like to work on it. Wait for a maintainer to assign it to you.
2. Look for the marker named in the issue (for example `WAVE-ISSUE(...)`) in the code: it shows where your change plugs in.
3. Open a pull request that links the issue, states what you changed and shows the output of the check above.

Good first areas: another cost-basis method, another export format, another cache store, a price-source adapter, or OpenAPI examples.

By contributing you agree that your contribution is licensed under the MIT license of this repository.
