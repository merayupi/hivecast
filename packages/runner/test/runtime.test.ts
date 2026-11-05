/**
 * Runner seam tests: CLI, HTTP, and real RPC.
 *
 * These exercise the approved public seams only:
 *   - the operator CLI entrypoint (`src/cli.ts`),
 *   - the public HTTP service (`createPublicService`),
 *   - the real NEAR testnet RPC view calls (finalized).
 *
 * No in-process helper (commitment encoder, Store row, schedule math) is
 * asserted directly; those are exercised through consumer behavior. No signing
 * key is required for any path here (read-only / empty-db operations only).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { NearChainClient } from '../src/chain/index.js';
import type { RunnerConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { Runtime } from '../src/runtime.js';
import { createPublicService } from '../src/service.js';
import { Store } from '../src/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'src', 'cli.ts');
const CONTRACT = process.env.HIVECAST_RUNNER_CONTRACT ?? 'hivecast-market-6c4d.testnet';
const RPC = process.env.HIVECAST_RUNNER_RPC ?? 'https://rpc.testnet.near.org';

function configJson(dbPath: string): string {
  const agentAccounts: Record<string, string> = {};
  for (const a of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) {
    agentAccounts[a] = `${a}.hivecast-1105-0548.testnet`;
  }
  return JSON.stringify({
    networkId: 'testnet',
    contractId: CONTRACT,
    operatorId: 'hivecast-1105-0548.testnet',
    resolverId: 'hivecast-1105-0548.testnet',
    rpcUrl: RPC,
    credentialDirectory: 'C:/Users/nobody/.near-credentials/testnet',
    databasePath: dbPath,
    seed: 42,
    pollIntervalMs: 60000,
    minStakeYocto: '100000000000000000000000',
    accessPriceYocto: '10000000000000000000000',
    operationalGasReserveYocto: '50000000000000000000000',
    binanceBaseUrl: 'https://api.binance.com',
    openMeteoBaseUrl: 'https://api.open-meteo.com',
    archiveBaseUrl: 'https://archive-api.open-meteo.com',
    kudusLatitude: '-6.8049',
    kudusLongitude: '110.8397',
    kudusTimezone: 'Asia/Jakarta',
    http: { enabled: false, host: '127.0.0.1', port: 8787 },
    access: {
      sessionTtlMs: 86400000,
      challengeTtlMs: 300000,
      cookieName: 'hivecast_session',
      cookieSecure: false,
      serviceDomain: 'hivecast',
      allowedOrigins: ['http://localhost:5173'],
    },
    agentAccounts,
  });
}

function buildConfig(dbPath: string): RunnerConfig {
  const agentAccounts = {} as Record<string, string>;
  for (const a of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) {
    agentAccounts[a] = `${a}.hivecast-1105-0548.testnet`;
  }
  return {
    networkId: 'testnet',
    contractId: CONTRACT,
    operatorId: 'hivecast-1105-0548.testnet',
    resolverId: 'hivecast-1105-0548.testnet',
    rpcUrl: RPC,
    credentialDirectory: 'C:/Users/nobody/.near-credentials/testnet',
    databasePath: dbPath,
    seed: 42,
    pollIntervalMs: 60_000,
    minStakeYocto: 10n ** 23n,
    accessPriceYocto: 10n ** 22n,
    agentAccounts: agentAccounts as RunnerConfig['agentAccounts'],
    binanceBaseUrl: 'https://api.binance.com',
    openMeteoBaseUrl: 'https://api.open-meteo.com',
    archiveBaseUrl: 'https://archive-api.open-meteo.com',
    kudusLatitude: '-6.8049',
    kudusLongitude: '110.8397',
    kudusTimezone: 'Asia/Jakarta',
    operationalGasReserveYocto: 0n,
    http: { enabled: false, host: '127.0.0.1', port: 8787 },
    access: {
      sessionTtlMs: 86_400_000,
      challengeTtlMs: 300_000,
      cookieName: 'hivecast_session',
      cookieSecure: false,
      serviceDomain: 'hivecast',
      allowedOrigins: ['http://localhost:5173'],
    },
  };
}

/** Spawn the real CLI entrypoint against a temp config + db. */
function runCli(args: string[], dbPath: string): { status: number; stdout: string; stderr: string } {
  const cfgPath = path.join(tmpdir(), `hc-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cfgPath, configJson(dbPath));
  const res = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: path.resolve(HERE, '..'),
    env: { ...process.env, HIVECAST_CONFIG: cfgPath },
    encoding: 'utf8',
    timeout: 30_000,
  });
  rmSync(cfgPath, { force: true });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

test('CLI: status on an empty database exits 0 without a signing key', () => {
  const dbPath = path.join(tmpdir(), `hc-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const { status, stderr } = runCli(['status'], dbPath);
  assert.equal(status, 0, `status should exit 0; stderr: ${stderr}`);
  rmSync(dbPath, { force: true });
});

test('CLI: snapshot on an empty database reports not-frozen', () => {
  const dbPath = path.join(tmpdir(), `hc-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const { status, stdout } = runCli(['snapshot', '0'], dbPath);
  assert.equal(status, 0);
  assert.match(stdout, /not-frozen/);
  rmSync(dbPath, { force: true });
});

test('CLI: unknown command exits non-zero', () => {
  const dbPath = path.join(tmpdir(), `hc-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const { status } = runCli(['definitely-not-a-command'], dbPath);
  assert.notEqual(status, 0);
  rmSync(dbPath, { force: true });
});

test('HTTP: /health and /config respond without secrets', async () => {
  const dbPath = path.join(tmpdir(), `hc-http-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const config = buildConfig(dbPath);
  const chain = new NearChainClient(config);
  const store = new Store(dbPath, config.networkId, config.contractId);
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner);
  const server = createPublicService(runtime);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const health = (await (await fetch(`${base}/health`)).json()) as { status: string; domain: string };
    assert.equal(health.status, 'ok');
    assert.equal(health.domain, 'hivecast-runner');

    const configResp = (await (await fetch(`${base}/config`)).json()) as { contractId: string };
    const serialized = JSON.stringify(configResp);
    assert.ok(!serialized.includes('credentialDirectory'));
    assert.ok(!serialized.includes('databasePath'));
    assert.ok(!serialized.includes('private_key'));
    assert.ok(!serialized.includes('salt'));
    assert.equal(configResp.contractId, CONTRACT);

    const notFound = await fetch(`${base}/nope`);
    assert.equal(notFound.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dbPath, { force: true });
  }
});

test('RPC: finalized read-only views work against the real endpoint', async () => {
  const dbPath = path.join(tmpdir(), `hc-rpc-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const config = buildConfig(dbPath);
  const chain = new NearChainClient(config);
  const state = await chain.getContractState();
  assert.equal(typeof state.operator, 'string');
  assert.equal(typeof state.question_count, 'number');
  const questions = await chain.listQuestions(0, 10);
  assert.ok(Array.isArray(questions));
  rmSync(dbPath, { force: true });
});
