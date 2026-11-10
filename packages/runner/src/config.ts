/**
 * Runner configuration: loading and validation.
 *
 * Account keys are referenced by file path (`credentialDirectory`), never
 * embedded. Monetary and timestamp defaults follow the wire contract (decimal
 * strings at the JSON boundary).
 */

import { readFileSync } from 'node:fs';
import { AGENT_IDS } from '@hivecast/core';
import type { AlgoAgentId, LiveAgentId } from '@hivecast/core';
import {
  DEFAULT_ACCESS_PRICE,
  DEFAULT_MIN_STAKE,
  DEFAULT_WEATHER_CITIES,
  localDateOfUtcMs,
} from './schedule.js';
import type { WeatherCity } from './schedule.js';

export interface RunnerConfig {
  networkId: string;
  contractId: string;
  operatorId: string;
  resolverId: string;
  rpcUrl: string;
  /**
   * Further RPC endpoints, tried in order when `rpcUrl` is rate-limited or
   * unreachable. Optional: with none, `rpcUrl` is the only endpoint.
   */
  rpcFallbackUrls?: readonly string[];
  credentialDirectory: string;
  databasePath: string;
  seed: number;
  pollIntervalMs: number;
  minStakeYocto: bigint;
  accessPriceYocto: bigint;
  /** The eight algorithmic agents are required; live-only agents are optional. */
  agentAccounts: Record<AlgoAgentId, string> & Partial<Record<LiveAgentId, string>>;
  /** Live-only LLM agent (`llm-news`). `null` when not configured. */
  llm?: LlmConfig | null;
  binanceBaseUrl: string;
  openMeteoBaseUrl: string;
  archiveBaseUrl: string;
  /** Cities whose daily rain gets one weather Question per local day. */
  weatherCities: WeatherCity[];
  /** In-flight gas reserve kept out of stake sizing (yoctoNEAR). */
  operationalGasReserveYocto: bigint;
  /** Per-RPC-request timeout (ms) for read-only public views. A hanging/rate-
   * limited endpoint must surface as unavailable, never block a request
   * unbounded. Applied to view/native/tx/access-key reads. */
  rpcTimeoutMs: number;
  http: { enabled: boolean; host: string; port: number };
  /** Forecast Access authentication + delivery (ticket #5). */
  access: {
    /** HttpOnly session lifetime (ms). */
    sessionTtlMs: number;
    /** One-use NEP-413 challenge lifetime (ms). */
    challengeTtlMs: number;
    /** Session cookie name. */
    cookieName: string;
    /** Set the Secure flag (true when served over https). */
    cookieSecure: boolean;
    /** Service identity embedded in the signed challenge message. */
    serviceDomain: string;
    /** Allowed browser Origins (CORS + CSRF binding for the Vite proxy). */
    allowedOrigins: string[];
  };
  /** Deterministic credential override map (secret keys injected, not files). */
  credentials?: Record<string, string>;
}

/**
 * LLM agent settings. The API key is resolved at load time from the env var
 * named by `apiKeyEnv` (default NEARAI_API_KEY), else from `apiKey` in the
 * git-ignored config file. It is never logged or served.
 */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Shown on the dashboard next to each rationale, e.g. "NEAR AI Cloud · private TEE inference". */
  providerLabel: string;
  maxTokens: number;
  timeoutMs: number;
  /** LLM attempts per Round before the agent abstains for that Round. */
  maxAttempts: number;
  newsFeeds: string[];
  maxHeadlines: number;
  /** Only headlines published within this many hours before the call are used. */
  headlineWindowHours: number;
}

const DEFAULT_NEWS_FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
  'https://decrypt.co/feed',
];

function parseLlm(raw: unknown, hasAccount: boolean): LlmConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new Error('config.llm must be an object');
  const l = raw as Record<string, unknown>;
  if (l.enabled === false) return null;
  if (!hasAccount) {
    throw new Error('config.llm is set but config.agentAccounts["llm-news"] is missing');
  }
  const envName = typeof l.apiKeyEnv === 'string' && l.apiKeyEnv ? l.apiKeyEnv : 'NEARAI_API_KEY';
  const apiKey = process.env[envName] ?? (typeof l.apiKey === 'string' ? l.apiKey : '');
  if (!apiKey) {
    throw new Error(`config.llm: no API key (set env ${envName} or llm.apiKey in the git-ignored config)`);
  }
  const num = (v: unknown, d: number, field: string): number => {
    if (v === undefined) return d;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`config.llm.${field} must be a positive number`);
    return v;
  };
  return {
    baseUrl: requireString(l.baseUrl ?? 'https://cloud-api.near.ai/v1', 'llm.baseUrl').replace(/\/+$/, ''),
    apiKey,
    model: requireString(l.model ?? 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'llm.model'),
    providerLabel: typeof l.providerLabel === 'string' ? l.providerLabel : 'NEAR AI Cloud · private TEE inference',
    maxTokens: num(l.maxTokens, 2000, 'maxTokens'),
    timeoutMs: num(l.timeoutMs, 90_000, 'timeoutMs'),
    maxAttempts: num(l.maxAttempts, 3, 'maxAttempts'),
    newsFeeds: Array.isArray(l.newsFeeds) ? (l.newsFeeds as unknown[]).map(String) : DEFAULT_NEWS_FEEDS,
    maxHeadlines: num(l.maxHeadlines, 15, 'maxHeadlines'),
    headlineWindowHours: num(l.headlineWindowHours, 12, 'headlineWindowHours'),
  };
}

/** Validate `weatherCities` (defaults to Jakarta, Singapore, London, Dubai, Tokyo). */
function parseCities(raw: unknown): WeatherCity[] {
  if (raw === undefined) return DEFAULT_WEATHER_CITIES.map((c) => ({ ...c }));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('config.weatherCities must be a non-empty array');
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const field = (k: string) => requireString(o[k], `weatherCities[${i}].${k}`);
    const city: WeatherCity = {
      id: field('id'),
      name: field('name'),
      country: field('country'),
      latitude: field('latitude'),
      longitude: field('longitude'),
      timezone: field('timezone'),
    };
    if (!/^[a-z0-9-]+$/.test(city.id)) throw new Error(`weatherCities[${i}].id must be lowercase letters, digits or dashes`);
    if (seen.has(city.id)) throw new Error(`duplicate weatherCities id ${city.id}`);
    seen.add(city.id);
    const lat = Number(city.latitude);
    const lon = Number(city.longitude);
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) throw new Error(`weatherCities[${i}] has invalid coordinates`);
    try {
      localDateOfUtcMs(0, city.timezone);
    } catch {
      throw new Error(`weatherCities[${i}].timezone ${city.timezone} is not a valid IANA time zone`);
    }
    return city;
  });
}

const REQUIRED_AGENTS = AGENT_IDS;

/** Optional list of extra RPC endpoints: http(s) URLs, no duplicates, none equal to `rpcUrl`. */
function parseRpcFallbackUrls(raw: unknown, primary: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('config.rpcFallbackUrls must be an array of URLs');
  const seen = new Set([primary]);
  return raw.map((value, i) => {
    if (typeof value !== 'string' || !/^https?:\/\/\S+$/.test(value)) {
      throw new Error(`config.rpcFallbackUrls[${i}] must be an http(s) URL`);
    }
    if (seen.has(value)) throw new Error(`config.rpcFallbackUrls[${i}] repeats another RPC endpoint`);
    seen.add(value);
    return value;
  });
}

function parsePositiveBigInt(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`config.${field} must be a decimal string, got ${JSON.stringify(value)}`);
  }
  const v = BigInt(value);
  if (v <= 0n) throw new Error(`config.${field} must be > 0`);
  return v;
}

function parseNonNegativeBigInt(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`config.${field} must be a decimal string, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`config.${field} must be a non-empty string`);
  }
  return value;
}

/** Load and validate a runner config from a JSON file path. */
export function loadConfig(path: string): RunnerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`failed to read config ${path}: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('config must be a JSON object');
  const c = raw as Record<string, unknown>;

  const agentAccounts = c.agentAccounts as Record<string, unknown> | undefined;
  if (!agentAccounts || typeof agentAccounts !== 'object') {
    throw new Error('config.agentAccounts must map each agent id to an account id');
  }
  const accounts = {} as RunnerConfig['agentAccounts'];
  for (const id of REQUIRED_AGENTS) {
    const v = agentAccounts[id];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`config.agentAccounts.${id} must be a non-empty account id`);
    }
    accounts[id] = v;
  }
  const llmAccount = agentAccounts['llm-news'];
  if (llmAccount !== undefined) {
    if (typeof llmAccount !== 'string' || llmAccount.trim() === '') {
      throw new Error('config.agentAccounts.llm-news must be a non-empty account id when present');
    }
    accounts['llm-news'] = llmAccount;
  }

  const httpRaw = (c.http ?? {}) as Record<string, unknown>;
  const credentials = c.credentials as Record<string, string> | undefined;
  const accessRaw = (c.access ?? {}) as Record<string, unknown>;
  const allowedOrigins = Array.isArray(accessRaw.allowedOrigins)
    ? (accessRaw.allowedOrigins as unknown[]).map((o) => String(o))
    : ['http://localhost:5173'];

  return {
    networkId: requireString(c.networkId, 'networkId'),
    contractId: requireString(c.contractId, 'contractId'),
    operatorId: requireString(c.operatorId, 'operatorId'),
    resolverId: requireString(c.resolverId, 'resolverId'),
    rpcUrl: requireString(c.rpcUrl, 'rpcUrl'),
    rpcFallbackUrls: parseRpcFallbackUrls(c.rpcFallbackUrls, requireString(c.rpcUrl, 'rpcUrl')),
    credentialDirectory: requireString(c.credentialDirectory, 'credentialDirectory'),
    databasePath: requireString(c.databasePath, 'databasePath'),
    seed: typeof c.seed === 'number' ? c.seed : 42,
    pollIntervalMs: typeof c.pollIntervalMs === 'number' ? c.pollIntervalMs : 60_000,
    minStakeYocto: c.minStakeYocto === undefined
      ? DEFAULT_MIN_STAKE
      : parsePositiveBigInt(c.minStakeYocto, 'minStakeYocto'),
    accessPriceYocto: c.accessPriceYocto === undefined
      ? DEFAULT_ACCESS_PRICE
      : parsePositiveBigInt(c.accessPriceYocto, 'accessPriceYocto'),
    agentAccounts: accounts,
    llm: parseLlm(c.llm, accounts['llm-news'] !== undefined),
    binanceBaseUrl: requireString(c.binanceBaseUrl ?? 'https://api.binance.com', 'binanceBaseUrl'),
    openMeteoBaseUrl: requireString(c.openMeteoBaseUrl ?? 'https://api.open-meteo.com', 'openMeteoBaseUrl'),
    archiveBaseUrl: requireString(c.archiveBaseUrl ?? 'https://archive-api.open-meteo.com', 'archiveBaseUrl'),
    weatherCities: parseCities(c.weatherCities),
    operationalGasReserveYocto: c.operationalGasReserveYocto === undefined
      ? 50_000_000_000_000_000_000_000n // 0.05 NEAR
      : parseNonNegativeBigInt(c.operationalGasReserveYocto, 'operationalGasReserveYocto'),
    rpcTimeoutMs: typeof c.rpcTimeoutMs === 'number' && c.rpcTimeoutMs > 0 ? c.rpcTimeoutMs : 15_000,
    http: {
      enabled: httpRaw.enabled === true,
      host: typeof httpRaw.host === 'string' ? httpRaw.host : '127.0.0.1',
      port: typeof httpRaw.port === 'number' ? httpRaw.port : 8787,
    },
    access: {
      sessionTtlMs: typeof accessRaw.sessionTtlMs === 'number' ? accessRaw.sessionTtlMs : 86_400_000,
      challengeTtlMs: typeof accessRaw.challengeTtlMs === 'number' ? accessRaw.challengeTtlMs : 300_000,
      cookieName: typeof accessRaw.cookieName === 'string' ? accessRaw.cookieName : 'hivecast_session',
      cookieSecure: accessRaw.cookieSecure === true,
      serviceDomain: typeof accessRaw.serviceDomain === 'string' ? accessRaw.serviceDomain : 'hivecast',
      allowedOrigins,
    },
    credentials,
  };
}

/** Resolve the credential JSON path for an account id (near CLI layout). */
export function credentialPath(config: RunnerConfig, accountId: string): string {
  return `${config.credentialDirectory}/${accountId}.json`;
}
