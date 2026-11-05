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
export type { RunnerConfig } from './config.js';

// Schedule + source definitions
export * from './schedule.js';

// Chain client (RPC only; real sandbox = configurable RPC endpoint + WASM)
export { NearChainClient } from './chain/index.js';
export type { ChainClient, CallOutcome, PreparedCall, QuestionSpecArgs } from './chain/types.js';

// Persistence
export { Store } from './store.js';
export type { JournalRow, ReservationRow } from './store.js';

// Orchestration
export { Runner, LiveSourceProvider } from './runner.js';
export type {
  StepResult,
  TickReport,
  SourceProvider,
  StrategyInputResult,
  ResolutionResult,
  CreateQuestionSpec,
} from './runner.js';

// Public runtime interface
export { Runtime } from './runtime.js';
export type {
  SnapshotDto,
  QuestionDto,
  JournalSummary,
  LifecycleStatus,
  PublicConfig,
  LeaderboardEntry,
  AgentRosterEntry,
} from './runtime.js';

// Public analytics / comparison / provenance (ticket #6)
export {
  listAllQuestions,
  computeGlobalLeaderboard,
  computeQuestionComparison,
  computeSimulationReport,
  formatNearYocto,
} from './public-data.js';
export type {
  GlobalLeaderboard,
  LeaderboardEntry as GlobalLeaderboardEntry,
  QuestionComparison,
  ComparisonParticipant,
} from './public-data.js';

// Forecast Access auth + delivery (ticket #5)
export { AccessAuth, TRUST_DISCLOSURE, AccessError, ACCESS_HTTP_STATUS } from './access/index.js';
export type {
  AccessClock,
  VerifyChallengeInput,
  AccessErrorCode,
  ChallengeDto,
  ForecastDeliveryDto,
  SessionDto,
} from './access/index.js';

// Source fetchers
export {
  fetchCompletedCandles,
  fetchPriceResolution,
  fetchWeatherForecast,
  fetchWeatherResolution,
  fetchWeatherHistoryDay,
} from './source.js';
export type { FetchedCandles, FetchedForecast, FetchedResolution, Evidence, FetchBases } from './source.js';

// Domain types
export type * from './types.js';
