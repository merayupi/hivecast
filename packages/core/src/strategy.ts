/**
 * The eight algorithmic strategies (spec §8).
 *
 * Every probability transform, lookback window and parameter below is DECLARED
 * and fixed before evaluation. None of them are tuned on the evaluation period
 * and none read news/sentiment. Probabilities are integer bps (0..=10000).
 *
 * Domain relevance (spec §8) — six strategies per domain:
 *   price  : persistence, momentum, meanrev, noisy-trend, yolo, coinflip
 *   weather: meteo, climatology, persistence, noisy-trend, yolo, coinflip
 * Unsupported specialists abstain (handled by the caller via supportsDomain).
 */

import { seededDraw } from './rng.js';
import {
  compareDecimalStrings,
  gteDec,
  scaleDecimal,
} from './decimal.js';
import type {
  AgentId,
  Candle,
  ForecastResult,
  PriceInputs,
  Strategy,
  StrategyContext,
  WeatherInputs,
} from './types.js';

// ---------------------------------------------------------------------------
// Declared constants
// ---------------------------------------------------------------------------

/** meteo: logistic slope (mm) around the 1.0 mm threshold. */
const METEO_THRESHOLD_MM = 1.0;
const METEO_SCALE_MM = 1.5;

/** persistence: probability of repeating the last known outcome. */
const PERSIST_REPEAT_BPS = 8000;
const PERSIST_FLIP_BPS = 2000;

/** momentum: continuation signal mapped to a fixed probability. */
const MOMENTUM_UP_BPS = 7500;
const MOMENTUM_DOWN_BPS = 2500;
const MOMENTUM_FLAT_BPS = 5000;
/** momentum lookback: compare the freshest close with the close 24h earlier. */
const MOMENTUM_LOOKBACK = 24;

/** meanrev: reversion toward the 24h mean mapped to a fixed probability. */
const MEANREV_UP_BPS = 7500;
const MEANREV_DOWN_BPS = 2500;
const MEANREV_FLAT_BPS = 5000;
const MEANREV_WINDOW = 24;

/** noisy-trend: seeded uniform noise added to a declared trend base (bps). */
const NOISY_NOISE_HALF_RANGE = 2500;
const NOISY_MIN_BPS = 100;
const NOISY_MAX_BPS = 9900;

/** climatology: rolling window (days) over which event frequency is measured. */
const CLIMATOLOGY_WINDOW_DAYS = 365;

const clampBps = (v: number): number => Math.max(0, Math.min(10_000, v));

function logistic(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priceCloses(inputs: PriceInputs): string[] {
  return inputs.candles.map((c: Candle) => c.close);
}

function outcomeOfCandle(c: Candle): boolean {
  return compareDecimalStrings(c.close, c.open) > 0;
}

function lastOutcomePrice(inputs: PriceInputs): boolean | null {
  const candles = inputs.candles;
  const last = candles[candles.length - 1];
  return last ? outcomeOfCandle(last) : null;
}

function lastOutcomeWeather(inputs: WeatherInputs): boolean | null {
  const history = inputs.historyPrecipMm;
  const last = history[history.length - 1];
  return last === undefined ? null : gteDec(last, '1.0');
}

function trendSignalPrice(inputs: PriceInputs): number {
  const closes = priceCloses(inputs);
  if (closes.length < MOMENTUM_LOOKBACK + 1) return 0;
  const now = closes[closes.length - 1]!;
  const prev = closes[closes.length - 1 - MOMENTUM_LOOKBACK]!;
  return compareDecimalStrings(now, prev);
}

function reversionSignalPrice(inputs: PriceInputs): number {
  const closes = priceCloses(inputs);
  if (closes.length < MEANREV_WINDOW) return 0;
  const window = closes.slice(-MEANREV_WINDOW);
  let sum = 0n;
  for (const c of window) sum += scaleDecimal(c, 8);
  const last = window[window.length - 1]!;
  const lastScaled = scaleDecimal(last, 8);
  // mean > last  <=>  sum/24 > last  <=>  sum > 24*last
  const meanVsLast = sum - 24n * lastScaled;
  return meanVsLast > 0n ? 1 : meanVsLast < 0n ? -1 : 0;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

function meteo(ctx: StrategyContext): ForecastResult {
  const inputs = ctx.inputs as WeatherInputs;
  if (inputs.forecastPrecipMm == null) {
    return { kind: 'abstain', reason: 'no pre-cutoff forecast run available' };
  }
  const mm = Number(inputs.forecastPrecipMm);
  if (!Number.isFinite(mm)) {
    return { kind: 'abstain', reason: 'invalid forecast precipitation value' };
  }
  const z = (mm - METEO_THRESHOLD_MM) / METEO_SCALE_MM;
  const p = clampBps(Math.round(logistic(z) * 10_000));
  return { kind: 'forecast', probabilityBps: p };
}

function climatology(ctx: StrategyContext): ForecastResult {
  const inputs = ctx.inputs as WeatherInputs;
  const window = inputs.historyPrecipMm.slice(-CLIMATOLOGY_WINDOW_DAYS);
  if (window.length === 0) {
    return { kind: 'abstain', reason: 'no historical precipitation available' };
  }
  let rainy = 0;
  for (const d of window) if (gteDec(d, '1.0')) rainy++;
  const p = clampBps(Math.round((rainy / window.length) * 10_000));
  return { kind: 'forecast', probabilityBps: p };
}

function persistence(ctx: StrategyContext): ForecastResult {
  const lastOutcome =
    ctx.domain === 'price'
      ? lastOutcomePrice(ctx.inputs as PriceInputs)
      : lastOutcomeWeather(ctx.inputs as WeatherInputs);
  if (lastOutcome == null) {
    return { kind: 'abstain', reason: 'no known prior outcome' };
  }
  return {
    kind: 'forecast',
    probabilityBps: lastOutcome ? PERSIST_REPEAT_BPS : PERSIST_FLIP_BPS,
  };
}

function momentum(ctx: StrategyContext): ForecastResult {
  const inputs = ctx.inputs as PriceInputs;
  const closes = priceCloses(inputs);
  if (closes.length < MOMENTUM_LOOKBACK + 1) {
    return { kind: 'abstain', reason: 'insufficient price history for lookback' };
  }
  const sig = trendSignalPrice(inputs);
  const p = sig > 0 ? MOMENTUM_UP_BPS : sig < 0 ? MOMENTUM_DOWN_BPS : MOMENTUM_FLAT_BPS;
  return { kind: 'forecast', probabilityBps: p };
}

function meanrev(ctx: StrategyContext): ForecastResult {
  const inputs = ctx.inputs as PriceInputs;
  const closes = priceCloses(inputs);
  if (closes.length < MEANREV_WINDOW) {
    return { kind: 'abstain', reason: 'insufficient price history for mean window' };
  }
  const sig = reversionSignalPrice(inputs);
  const p = sig > 0 ? MEANREV_UP_BPS : sig < 0 ? MEANREV_DOWN_BPS : MEANREV_FLAT_BPS;
  return { kind: 'forecast', probabilityBps: p };
}

function noisyTrend(ctx: StrategyContext): ForecastResult {
  const base =
    ctx.domain === 'price'
      ? (() => {
          const sig = trendSignalPrice(ctx.inputs as PriceInputs);
          return sig > 0 ? MOMENTUM_UP_BPS : sig < 0 ? MOMENTUM_DOWN_BPS : MOMENTUM_FLAT_BPS;
        })()
      : (() => {
          const lo = lastOutcomeWeather(ctx.inputs as WeatherInputs);
          if (lo == null) return -1; // signal abstain
          return lo ? PERSIST_REPEAT_BPS : PERSIST_FLIP_BPS;
        })();
  if (base < 0) {
    return { kind: 'abstain', reason: 'no known prior outcome for trend signal' };
  }
  const draw = seededDraw(ctx.seed, ['noisy-trend', ctx.agentId, ctx.roundKey]);
  const noise = Math.floor(draw * (NOISY_NOISE_HALF_RANGE * 2 + 1)) - NOISY_NOISE_HALF_RANGE;
  const p = clampBps(Math.max(NOISY_MIN_BPS, Math.min(NOISY_MAX_BPS, base + noise)));
  return { kind: 'forecast', probabilityBps: p };
}

function yolo(ctx: StrategyContext): ForecastResult {
  const draw = seededDraw(ctx.seed, ['yolo', ctx.agentId, ctx.roundKey]);
  return { kind: 'forecast', probabilityBps: draw < 0.5 ? 0 : 10_000 };
}

function coinflip(ctx: StrategyContext): ForecastResult {
  const draw = seededDraw(ctx.seed, ['coinflip', ctx.agentId, ctx.roundKey]);
  return { kind: 'forecast', probabilityBps: Math.floor(draw * 10_001) };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const STRATEGIES: Readonly<Record<AgentId, Strategy>> = {
  meteo,
  climatology,
  persistence,
  momentum,
  meanrev,
  'noisy-trend': noisyTrend,
  yolo,
  coinflip,
} as const;

/** Return the strategy for an identity. */
export function getStrategy(agentId: AgentId): Strategy {
  return STRATEGIES[agentId];
}

/** Declared strategy descriptions, for reports and documentation. */
export const STRATEGY_DESCRIPTIONS: Readonly<Record<AgentId, string>> = {
  meteo:
    'Logistic transform of a single pre-cutoff forecast run precipitation (threshold 1.0 mm, scale 1.5 mm). No calibration claim.',
  climatology:
    'Historical event frequency (>= 1.0 mm) over a rolling 365-day window of available days.',
  persistence: 'Favors repetition of the last known Outcome (8000 bps repeat, 2000 bps flip).',
  momentum:
    'Price-trend continuation: freshest completed close vs close 24h earlier (7500/2500/5000 bps).',
  meanrev:
    'Reversion toward the 24h mean of completed closes (7500/2500/5000 bps by sign).',
  'noisy-trend':
    'Declared trend signal (momentum for price, persistence for weather) plus seeded uniform noise in [-2500, 2500] bps, clipped to [100, 9900].',
  yolo: 'Extreme probability of exactly 0% or 100%, seeded 50/50.',
  coinflip: 'Seeded uniform probability in [0, 10000] bps.',
} as const;
