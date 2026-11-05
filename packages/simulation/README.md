# @hivecast/simulation — offline replay

Deterministic, offline historical replay of the two HiveCast experiments. Reads
only the committed data bundle; no network, no API key, no LLM.

## Run

```bash
npm run sim                      # terminal tables, seed 42
npm run sim -- -- --seed 7       # different seed
npm run sim -- -- --json-only    # deterministic JSON to stdout
```

The root `npm run sim` forwards to this workspace. Options: `--seed N`,
`--json` (append JSON after the tables), `--json-only` (JSON only).

## What it evaluates

Two independent experiments, each starting every agent at 100 NEAR:

- **Price** — 1440 hourly Binance `NEARUSDT` candles, 2026-08-01..2026-09-29 UTC.
  Outcome YES when `close > open` (exact decimal compare). 168-candle (7-day) warm-up.
- **Weather** — 60 daily Kudus precipitation outcomes (Open-Meteo ECMWF IFS 9 km,
  `Asia/Jakarta`), threshold 1.0 mm. 365-day warm-up.

Six relevant strategies per domain (see `@hivecast/core`); unsupported specialists
abstain. Stake sizing is `floor(10% × Available Balance)`, skipped without rounding
up when below the 0.1 NEAR minimum. Settlement uses the shared exact accounting
module. Deterministic for a fixed `(bundle, config, seed)`.

## Report

Per domain: Brier error (with its denominator), coverage/round counts, active
cohort, final Bankroll, peak locked Stake, total wagered, wagering P/L, and fee
income — plus equal-weight and stake-weighted aggregate Brier on the same rounds,
and a labelled log-odds comparison (probabilities clipped to `[1e-9, 1-1e-9]`).

## Data bundle and provenance

Committed under `data/` and verified by SHA-256 + byte count on load:

- `price.json` — Binance Vision `NEARUSDT` 1h klines (1608 candles), decimal strings throughout.
- `weather.json` — IFS daily precipitation (425 days) + 60 Single-Runs forecast inputs.
- `manifest.json` — sources, model/instrument/grid, validity, observed fetch time, checksums,
  attribution, licences, and per-input `availability` classification.

Availability is disclosed honestly per input (see `manifest.json` and the report):

- Binance candles — `retrospective`. The monthly archive is published after each month ends and
  fetched post-evaluation, so no per-candle publication/availability timestamp is recorded. A
  candle's period end is NOT publication evidence; the price experiment is a labelled
  retrospective benchmark. Completed Binance kline values are immutable (no future-data leakage
  into the close>open outcome), which is a weaker property than point-in-time availability.
- IFS precipitation Outcome — `retrospective`: IFS analysis may be revised after the fact, so a
  value fetched today is not proven to equal the value at resolution time (grid model, not a
  station observation).
- Meteo forecast input — `inference`: a real Single-Runs IFS run initialised before cutoff, but
  Open-Meteo does not record per-run publication time.
- Climatology history input — `retrospective`: reanalysis of past days may be revised.

## Regenerate the bundle

```bash
npm run fetch-data --workspace @hivecast/simulation   # requires network
```

Fetching downloads and SHA-256-verifies each Binance Vision monthly archive against its
published `.CHECKSUM` file, validates completeness/contiguity/dates/units, and regenerates
`manifest.json` with the observed fetch time and fresh checksums. The replay itself never
fetches.
