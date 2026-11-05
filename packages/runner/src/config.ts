/**
 * Runner configuration: loading and validation.
 *
 * Account keys are referenced by file path (`credentialDirectory`), never
 * embedded. Monetary and timestamp defaults follow the wire contract (decimal
 * strings at the JSON boundary).
 */

import { readFileSync } from 'node:fs';
import { AGENT_IDS } from '@hivecast/core';
import type { AgentId } from '@hivecast/core';
import {
  DEFAULT_ACCESS_PRICE,
  DEFAULT_MIN_STAKE,
  KUDUS_LAT,
  KUDUS_LON,
  WEATHER_TIMEZONE,
} from './schedule.js';

export interface RunnerConfig {
  networkId: string;
  contractId: string;
  operatorId: string;
  resolverId: string;
  rpcUrl: string;
  credentialDirectory: string;
  databasePath: string;
  seed: number;
  pollIntervalMs: number;
  minStakeYocto: bigint;
  accessPriceYocto: bigint;
  agentAccounts: Record<AgentId, string>;
  binanceBaseUrl: string;
  openMeteoBaseUrl: string;
  archiveBaseUrl: string;
  kudusLatitude: string;
  kudusLongitude: string;
  kudusTimezone: string;
  /** In-flight gas reserve kept out of stake sizing (yoctoNEAR). */
  operationalGasReserveYocto: bigint;
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

const REQUIRED_AGENTS = AGENT_IDS;

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
  const accounts: Record<AgentId, string> = {} as Record<AgentId, string>;
  for (const id of REQUIRED_AGENTS) {
    const v = agentAccounts[id];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`config.agentAccounts.${id} must be a non-empty account id`);
    }
    accounts[id] = v;
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
    binanceBaseUrl: requireString(c.binanceBaseUrl ?? 'https://api.binance.com', 'binanceBaseUrl'),
    openMeteoBaseUrl: requireString(c.openMeteoBaseUrl ?? 'https://api.open-meteo.com', 'openMeteoBaseUrl'),
    archiveBaseUrl: requireString(c.archiveBaseUrl ?? 'https://archive-api.open-meteo.com', 'archiveBaseUrl'),
    kudusLatitude: requireString(c.kudusLatitude ?? KUDUS_LAT, 'kudusLatitude'),
    kudusLongitude: requireString(c.kudusLongitude ?? KUDUS_LON, 'kudusLongitude'),
    kudusTimezone: requireString(c.kudusTimezone ?? WEATHER_TIMEZONE, 'kudusTimezone'),
    operationalGasReserveYocto: c.operationalGasReserveYocto === undefined
      ? 50_000_000_000_000_000_000_000n // 0.05 NEAR
      : parseNonNegativeBigInt(c.operationalGasReserveYocto, 'operationalGasReserveYocto'),
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
