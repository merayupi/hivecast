/**
 * @hivecast/runner
 *
 * Durable autonomous runner: real NEAR RPC/signing, canonical commitment
 * encoding, private SQLite persistence (forecasts/salts before commit, capital
 * reservations, immutable snapshots, transaction journal), and the public
 * runtime interface consumed by the Forecast Access server.
 */

// Canonical commitment encoding
export * from './commitment.js';
export * from './borsh.js';

// Configuration
export { loadConfig, credentialPath } from './config.js';
export type { RunnerConfig, ChainMode } from './config.js';

// Schedule + source definitions
export * from './schedule.js';

// Chain clients
export { NearChainClient, EmulatedChainClient } from './chain/index.js';
export type { ChainClient, CallOutcome, QuestionSpecArgs } from './chain/types.js';

// Persistence
export { Store } from './store.js';
export type { JournalRow, ReservationRow } from './store.js';

// Orchestration
export { Runner, LiveSourceProvider } from './runner.js';
export type { StepResult, TickReport, SourceProvider } from './runner.js';

// Public runtime interface
export { Runtime } from './runtime.js';
export type {
  SnapshotDto,
  QuestionDto,
  JournalSummary,
  LifecycleStatus,
  PublicConfig,
  LeaderboardEntry,
} from './runtime.js';

// Source fetchers
export {
  fetchCompletedCandles,
  fetchPriceResolution,
  fetchWeatherForecast,
  fetchWeatherResolution,
} from './source.js';
export type { FetchedCandles, FetchedForecast, FetchedResolution } from './source.js';

// Domain types
export type * from './types.js';
