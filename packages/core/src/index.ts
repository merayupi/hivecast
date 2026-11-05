/**
 * @hivecast/core
 *
 * Shared HiveCast core: the pure strategy interface, the eight algorithmic
 * strategies, exact BigInt yoctoNEAR wagering accounting, and deterministic
 * seeded randomness. Consumed by the offline replay (`@hivecast/simulation`)
 * and by the durable runner (`@hivecast/runner`).
 *
 * Public API (see each module for details):
 *  - types        : Domain, AgentId, Strategy, StrategyContext, ForecastResult, ...
 *  - strategy     : STRATEGIES, getStrategy, STRATEGY_DOMAINS, STRATEGY_DESCRIPTIONS
 *  - accounting   : settle, apportion, brierScore, SCORE_SCALE, ONE_NEAR, MIN_STAKE, QUERY_FEE
 *  - decimal      : compareDecimalStrings, gteDec, scaleDecimal, formatScaled
 *  - rng          : seededDraw, seededInt, mulberry32, hashStringToUint32
 */

export * from './types.js';
export * from './strategy.js';
export * from './accounting.js';
export * from './decimal.js';
export * from './rng.js';
