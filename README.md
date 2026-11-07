# ledgertax-api

Backend for Stellar Ledger Tax: reads the public history of a Stellar address, classifies it into events, calculates FIFO gains from **prices and labels you supply**, and produces two CSV reports. Read-only: it never holds keys, signs or sends anything.

**Accounting export, not tax advice.** Tax rules differ by country, classification can be wrong, and a wrong price gives a wrong result.

**Status:** early. It works against the Horizon server you configure; it is not published or deployed.

## What it does

- `GET /health`, `GET /events?address=`, `POST /reports` (see [openapi.yaml](openapi.yaml)).
- History comes through [ledgertax-core](https://github.com/Ledger-Tax/ledgertax-core) (a `HorizonSource`, wrapped by a cache of public history).
- Cost basis: **FIFO only**. A `trade` disposes of one asset and acquires another. Payments in/out are plain transfers unless you label them (`income`, `disposal`, `transfer`, `gift`, `ignore`). Rules and a hand-calculated example: [docs/EXAMPLE.md](docs/EXAMPLE.md).
- Prices: a CSV you supply with the header `asset,date,price,currency` (one price per asset per UTC day). A missing price is an **error row**, never a guess.
- Reports: `events.csv` and `gains.csv`, each starting with `# Accounting export, not tax advice.` and stating the source and the history range. Text from the chain (memos, asset codes) and your labels are neutralised against spreadsheet formula injection.

## Run it

```bash
pnpm install --frozen-lockfile && pnpm build
HORIZON_URL=https://horizon-testnet.stellar.org node dist/server.js
```

Configuration is by environment variables (copy `.env.example`; there are no keys or secrets of any kind):

| Variable                                 | Default         | Meaning                                                         |
| ---------------------------------------- | --------------- | --------------------------------------------------------------- |
| `HORIZON_URL`                            | **required**    | Horizon base URL. Chooses the network; there is no default.     |
| `PORT`, `HOST`                           | 8787, 127.0.0.1 | Where to listen                                                 |
| `CORS_ORIGINS`                           | none            | Comma-separated origins allowed from a browser. Empty: no CORS. |
| `CACHE_DB`                               | in-memory       | SQLite file for the public-history cache                        |
| `MAX_BODY_BYTES`, `MAX_PRICE_CSV_BYTES`  | 2 MB, 1 MiB     | Request limits                                                  |
| `MAX_EVENTS`                             | 20000           | Most events one request may produce                             |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | 30 per 60000 ms | Per-IP rate limit (`/health` is exempt)                         |
| `TRUST_PROXY`                            | false           | `true` only behind a proxy you control                          |

## Limits and long histories

- Histories larger than `MAX_EVENTS` are refused with `history_too_large`; narrow the range with `since`.
- `GET /events?format=ndjson` streams events as they are classified (one JSON line each, ending with a `done` or `error` line with a resume cursor) so a client can show progress. `POST /reports` is synchronous.
- The history is only as complete as the Horizon server's. The public SDF Horizon keeps about one year, so older purchases are missing and affect cost basis. Every report states the range the server holds.

## Privacy

- **Stored:** only public chain history (in the cache, if `CACHE_DB` is set, otherwise in memory). A test checks the SQLite file for any label or price content after a full report.
- **Not stored:** labels and prices. They travel in the request and are discarded with it.
- **Logged:** only method, path (without the query string), status and timing, and only when the server runs with logging on (the bundled server does). Never an address, body, label or price. A test checks this.
- **Secrets:** anything shaped like a Stellar secret key (in the query, the body, a label note or a price file) is rejected with `secret_key_rejected` and never echoed.
- The server operator can still see which addresses are requested through network-level logs outside this program; say so in any hosted deployment.

## What is not covered

Liquidity pools, Soroban contract events, linked addresses, cost-basis methods other than FIFO, external price sources, formats other than the two CSVs, other stores than SQLite. Fees and transfers use up lots without producing a gain. `create_claimable_balance` is `unknown` and carries no amount. See [ledgertax-core docs](https://github.com/Ledger-Tax/ledgertax-core/blob/main/docs/CLASSIFICATION.md).

## Develop

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Until `ledgertax-core` is published, this package uses a **committed tarball** in `vendor/` so it builds on its own. After changing core, refresh it from the monorepo with `pnpm core:refresh` and then `pnpm install`; once core is published, replace the `file:` dependency by a version range and delete `vendor/` and `scripts/refresh-core.mjs`.

Test fixtures in `test/fixtures/` are real testnet history copied from core (see the README there).
