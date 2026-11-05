/**
 * HiveCast core domain types.
 *
 * These types are the public contract shared by the offline replay
 * (`@hivecast/simulation`) and the durable runner (`@hivecast/runner`).
 * Keep them free of runtime coupling so both consumers use one vocabulary.
 */

/** Forecast domain. */
export type Domain = 'price' | 'weather';

/** Eight algorithmic agent identities (per spec §8). */
export type AgentId =
  | 'meteo'
  | 'climatology'
  | 'persistence'
  | 'momentum'
  | 'meanrev'
  | 'noisy-trend'
  | 'yolo'
  | 'coinflip';

/** Forecast probability expressed in basis points: integer 0..=10000. */
export type ProbabilityBps = number;

/**
 * A completed Binance 1h spot candle. All numeric fields are decimal strings so
 * no floating-point representation can alter an up/down comparison around ties.
 */
export interface Candle {
  /** Kline open time, ms UTC (decimal string). */
  openTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Kline close time, ms UTC (period end, not publication time). */
  closeTime: string;
  volume: string;
  quoteVolume: string;
  trades: string;
  takerBaseVolume: string;
  takerQuoteVolume: string;
}

/** Inputs available strictly before the commitment cutoff for a price Round. */
export interface PriceInputs {
  kind: 'price';
  /**
   * Completed candles whose `closeTime < cutoff`, chronologically ascending.
   * The most recent entry is the freshest completed candle the strategy may use.
   */
  candles: Candle[];
}

/** Inputs available strictly before the commitment cutoff for a weather Round. */
export interface WeatherInputs {
  kind: 'weather';
  /**
   * Forecast precipitation (mm) for the target day from a single model run
   * initialised before the cutoff. A decimal string; `null` when unavailable
   * (reported as an input abstention, never silently filled).
   */
  forecastPrecipMm: string | null;
  /**
   * Daily precipitation (mm) for days whose observation window ended before the
   * cutoff, chronologically ascending. Decimal strings (grid model analysis).
   */
  historyPrecipMm: string[];
}

export type StrategyInputs = PriceInputs | WeatherInputs;

/** Everything a pure strategy needs to produce a forecast for one Round. */
export interface StrategyContext {
  agentId: AgentId;
  domain: Domain;
  /** Observation start, ISO 8601 (UTC for price, WIB for weather). Display only. */
  targetTime: string;
  /** Stable Round key used to derive deterministic seeded draws. */
  roundKey: string;
  inputs: StrategyInputs;
  /** Global seed; seeded strategies derive per-(agent, round) draws from it. */
  seed: number;
}

/** A forecast, or an abstention with a declared reason. */
export type ForecastResult =
  | { kind: 'forecast'; probabilityBps: ProbabilityBps }
  | { kind: 'abstain'; reason: string };

/** Pure strategy: inputs → probability, no state, no I/O, no randomness except via seed. */
export type Strategy = (ctx: StrategyContext) => ForecastResult;

/** Domains each identity supports (spec §8). Unsupported specialists abstain. */
export const STRATEGY_DOMAINS: Readonly<Record<AgentId, readonly Domain[]>> = {
  meteo: ['weather'],
  climatology: ['weather'],
  persistence: ['price', 'weather'],
  momentum: ['price'],
  meanrev: ['price'],
  'noisy-trend': ['price', 'weather'],
  yolo: ['price', 'weather'],
  coinflip: ['price', 'weather'],
} as const;

/** All eight identities. */
export const AGENT_IDS: readonly AgentId[] = [
  'meteo',
  'climatology',
  'persistence',
  'momentum',
  'meanrev',
  'noisy-trend',
  'yolo',
  'coinflip',
] as const;

export function supportsDomain(agentId: AgentId, domain: Domain): boolean {
  return (STRATEGY_DOMAINS[agentId] as readonly Domain[]).includes(domain);
}

/** Probability endpoints, in bps. */
export const PROB_MIN_BPS = 0;
export const PROB_MAX_BPS = 10_000;

export function isValidProbabilityBps(v: number): v is ProbabilityBps {
  return Number.isInteger(v) && v >= PROB_MIN_BPS && v <= PROB_MAX_BPS;
}
