# @hivecast/core — strategy interface and exact accounting

Shared core consumed by the offline replay (`@hivecast/simulation`) and, in a later
ticket, the durable runner (`@hivecast/runner`). Everything here is pure and
side-effect-free: no I/O, no network, no floating-point money.

## Public entrypoint

```ts
import {
  getStrategy, STRATEGIES, STRATEGY_DOMAINS, AGENT_IDS,
  settle, apportion, brierScore,
  compareDecimalStrings, gteDec, scaleDecimal, formatScaled,
  seededDraw, seededInt,
  ONE_NEAR, MIN_STAKE, QUERY_FEE, SCORE_SCALE,
} from '@hivecast/core';
```

The package is consumed through `exports: { ".": "./src/index.ts" }` and re-exports
`types.ts`, `strategy.ts`, `accounting.ts`, `decimal.ts`, and `rng.ts`.

## The pure strategy contract

A `Strategy` is a function from declared inputs to a probability or an abstention:

```ts
type Strategy = (ctx: StrategyContext) => ForecastResult;

type ForecastResult =
  | { kind: 'forecast'; probabilityBps: number }   // 0..=10000
  | { kind: 'abstain'; reason: string };
```

`StrategyContext` carries `agentId`, `domain`, `targetTime`, a stable `roundKey`, the
`inputs` (see below), and the global `seed`. A strategy MUST:

- read only the inputs available before the commitment cutoff (the caller filters them);
- never read the target Outcome;
- produce randomness only via `seed` + `roundKey` (see `rng.ts`), never `Math.random`;
- abstain with a declared reason instead of inventing a probability when its inputs
  are unavailable or insufficient.

### Inputs

- Price: `{ kind: 'price', candles: Candle[] }` — completed candles with `closeTime`
  strictly before the cutoff, ascending. `Candle` prices are decimal strings so ties
  are exact.
- Weather: `{ kind: 'weather', forecastPrecipMm: string | null, historyPrecipMm: string[] }`
  — `forecastPrecipMm` is a single pre-cutoff forecast run value (`null` when absent);
  `historyPrecipMm` are past daily precipitation values (ascending).

### Domain relevance

`STRATEGY_DOMAINS` declares which domains each identity supports. Unsupported
specialists abstain. Six strategies per domain:

| Domain | Strategies |
| --- | --- |
| price | persistence, momentum, meanrev, noisy-trend, yolo, coinflip |
| weather | meteo, climatology, persistence, noisy-trend, yolo, coinflip |

`STRATEGY_DESCRIPTIONS` documents each transform, lookback, and parameter (frozen
before evaluation; never tuned on the evaluation period).

## Exact wagering accounting

`settle(participants, outcomeBps, feePool)` implements the spec formulas in
`bigint` yoctoNEAR:

- `S = 100_000_000`; score `s_i = S - (p_i - o)^2` for valid Revealers, else `0`.
- Base payout `b_i = w_i * (W*S + W*s_i - A) / (W*S)` (exact, then apportioned).
- Fee share `fee_i = F * w_i / V` among valid Revealers (`V` = their total stake).
- Each pool is floored and the remainder distributed to largest fractional
  remainders (ties by account id ascending), so every pool is conserved to the
  last yocto.

Money is always `bigint` yoctoNEAR internally and decimal strings at JSON boundaries.
`ONE_NEAR = 10^24`, `MIN_STAKE = 0.1 NEAR`, `QUERY_FEE = 0.01 NEAR`.

## Runner integration pointer

The runner reuses the same `STRATEGIES` registry and `StrategyContext` shape, then
feeds each forecast into its commitment pipeline. Because strategies are pure and
seeded, a runner can reproduce any replay forecast from `(agentId, domain, roundKey,
inputs, seed)` alone. See `packages/simulation/src/replay.ts` for the reference
evaluation loop.
