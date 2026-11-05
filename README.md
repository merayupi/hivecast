# hivecast

HiveCast: forecast wagering demo — a NEAR testnet contract, an autonomous agent
runner, authenticated Forecast Access delivery, an offline replay, and a dashboard.

## Workspaces

| Package | Responsibility |
| --- | --- |
| `packages/core` | Pure strategy interface, eight strategies, exact `bigint` yoctoNEAR accounting, seeded RNG, exact decimal helpers. |
| `packages/simulation` | Offline, deterministic two-domain historical replay + CLI. |
| `packages/runner` | Durable runner: real NEAR RPC/signing, commitment pipeline, private SQLite persistence, source fetchers, the public HTTP service, and Forecast Access auth/delivery. |
| `packages/dashboard` | Vite + React + Tailwind + Lucide buyer/evaluator dashboard (wallet connect, buy/read/claim/withdraw, leaderboard, comparison, simulation, trust disclosure). |

## Commands

```bash
npm install
npm run sim        # offline replay (seed 42)
npm test           # run all workspace tests
npm run build      # typecheck/build all workspaces
```

- `npm run sim -- -- --seed 7` for a different seed; `-- --json-only` for machine output.

### Dashboard

```bash
cd packages/dashboard
HIVECAST_API=http://127.0.0.1:8787 npm run dev
```

- Vite serves `http://localhost:5173` and proxies `/api/*` to `HIVECAST_API`
  (default `http://127.0.0.1:8787`), so browser requests are same-origin and the
  Forecast Access session cookie works without CORS. The runner's
  `access.allowedOrigins` must include `http://localhost:5173` (the default).
- The dashboard is an honest read of finalized chain state: it never fabricates
  an Outcome, probability, score, or a chart row. Monetary amounts are yoctoNEAR
  decimal strings; timestamps are UTC nanoseconds; probability is bps.

### Runner (public HTTP service + agent daemon)

```bash
cd packages/runner
npm run service     # public HTTP (health/config/questions/leaderboard/economics/forecast)
npm run cli -- run  # autonomous scheduler (graceful stop)
npm run cli -- status
```

- Configuration comes from `hivecast.config.json` (git-ignored; see
  `packages/runner/hivecast.config.example.json` for the strict-JSON shape).
  Signing keys are referenced by credential-directory path only — never embedded,
  never committed. The private SQLite database, forecasts, salts, and keys are
  out of the repository.
- See `packages/runner/README.md` for the full public HTTP route table, the
  Forecast Access NEP-413 auth contract, and the exact source semantics.

## Contracts

The NEAR contract (`contracts/hivecast/`) is Rust (`near-sdk 5.5.0`, WASM target).
Its canonical JSON wire contract (commitment encoding, change/view methods,
events, authorization matrix) is `contracts/hivecast/docs/contract-interface.md`.
All money/timestamps cross the JSON boundary as decimal strings; never `number`.

## Environments (distinct, never blurred)

- **Live testnet** — the real contract on NEAR testnet (`networkId: testnet`), the
  runner daemon, and genuine wallet transactions. Actual gas is reported
  separately from wagering profit and Query-Fee income.
- **Sandbox** — a real `near-sandbox` node + WASM for deterministic lifecycle
  proof (Linux; see the contract/runner harnesses). Not a live event.
- **Simulation** — the offline replay (`npm run sim`), deterministic and
  network-free; its balances are simulated and never presented as chain activity.

## Requirements

- Node.js 20+ (development uses `node:sqlite`, which requires Node 22.5+ for the
  runner's private store; the core/simulation/dashboard need 20+).
- Rust + `wasm32-unknown-unknown` only to build the contract WASM.

## Trust boundary

The Operator knows private forecasts, records the final Outcome, serves delivery,
and holds the testnet deploy key. Forecast Access is earlier information, not
exclusivity or permanent secrecy; there is no automatic endpoint-failure refund
(automatic refunds cover Cancellation and zero Valid Revealer only). See the
`/disclosure` endpoint and `packages/dashboard/DESIGN.md` for the surfaced form.
