/**
 * @hivecast/simulation
 *
 * Offline, deterministic historical replay of the two HiveCast experiments
 * (price and weather). Public API:
 *
 *  - runReplay(bundle, config) -> ReplayReport  (the pure engine)
 *  - defaultConfig(seed) -> ReplayConfig
 *  - loadBundle() -> Bundle                       (reads + verifies committed data)
 *  - renderTable(report), toJson(report)          (deterministic output)
 *
 * The CLI (`npm run sim`) is a thin wrapper around runReplay.
 */

export { runReplay, defaultConfig, DEFAULT_SEED, INITIAL_CAPITAL, STAKE_FLOOR_DENOM } from './replay.js';
export type {
  ReplayConfig,
  ReplayReport,
  DomainResult,
  AgentSummary,
  AggregateSummary,
  AgentRoundRecord,
} from './replay.js';
export { loadBundle, verifyChecksums, DATA_DIR } from './bundle.js';
export type { Bundle, Manifest, PriceBundle, WeatherBundle } from './bundle.js';
export { renderTable, toJson, formatNear } from './report.js';
