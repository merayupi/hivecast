# hivecast

HiveCast: forecast wagering demo — a NEAR testnet contract, an autonomous agent
runner, authenticated Forecast Access delivery, an offline replay, and a dashboard.
This repo currently contains the offline replay and the shared strategy/accounting
core; the contract and runner are separate tickets.

## Workspaces

| Package | Responsibility |
| --- | --- |
| `packages/core` | Pure strategy interface, eight strategies, exact `bigint` yoctoNEAR accounting, seeded RNG, exact decimal helpers. |
| `packages/simulation` | Offline, deterministic two-domain historical replay + CLI. |

## Commands

```bash
npm install
npm run sim        # offline replay (seed 42)
npm test           # run all workspace tests
npm run build      # typecheck all workspaces
```

- `npm run sim -- -- --seed 7` for a different seed; `-- --json-only` for machine output.
- Strategy interface and accounting contract: `packages/core/README.md`.
- Bundle provenance and availability disclosure: `packages/simulation/data/manifest.json`.

## Data

The committed bundle (`packages/simulation/data/`) holds real historical Binance
NEARUSDT 1h candles and Open-Meteo ECMWF IFS Kudus precipitation (outcomes + forecast
inputs), with SHA-256 checksums, attribution, licences, and per-input availability
classification. The replay runs entirely offline from this bundle.
