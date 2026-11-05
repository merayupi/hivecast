/**
 * Runtime + HTTP seam tests against the real RPC endpoint (read-only).
 *
 * These exercise the public surface the Forecast Access server will consume,
 * and verify that no secret (salt, private forecast, per-agent probability)
 * is reachable through public DTOs. No signing key is required for any path
 * exercised here; the chain client only touches read-only RPC / store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';

import { NearChainClient } from '../src/chain/index.js';
import type { RunnerConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { SnapshotRecord } from '../src/types.js';

const ONE_NEAR = 10n ** 24n;
const CONTRACT = process.env.HIVECAST_RUNNER_CONTRACT ?? 'hivecast-market-6c4d.testnet';
const RPC = process.env.HIVECAST_RUNNER_RPC ?? 'https://rpc.testnet.near.org';

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
    credentialDirectory: '/unused',
    databasePath: dbPath,
    seed: 42,
    pollIntervalMs: 60_000,
    minStakeYocto: ONE_NEAR / 10n,
    accessPriceYocto: ONE_NEAR / 100n,
    agentAccounts: agentAccounts as RunnerConfig['agentAccounts'],
    binanceBaseUrl: 'https://api.binance.com',
    openMeteoBaseUrl: 'https://api.open-meteo.com',
    archiveBaseUrl: 'https://archive-api.open-meteo.com',
    kudusLatitude: '-6.8049',
    kudusLongitude: '110.8397',
    kudusTimezone: 'Asia/Jakarta',
    operationalGasReserveYocto: 0n,
    http: { enabled: false, host: '127.0.0.1', port: 8787 },
  };
}

test('public config never carries credential directory, db path, or keys', () => {
  const dbPath = path.join(tmpdir(), `hc-rt-${Date.now()}.sqlite`);
  const config = buildConfig(dbPath);
  const chain = new NearChainClient(config);
  const store = new Store(dbPath, config.networkId, config.contractId);
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner);

  const cfg = runtime.getPublicConfig();
  const serialized = JSON.stringify(cfg);
  assert.ok(!serialized.includes('credentialDirectory'));
  assert.ok(!serialized.includes('databasePath'));
  assert.ok(!serialized.includes('private_key'));
  assert.ok(!serialized.includes('salt'));

  store.close();
  rmSync(dbPath, { force: true });
});

test('snapshot DTO exposes aggregate only, never per-agent secrets', () => {
  const dbPath = path.join(tmpdir(), `hc-rt-${Date.now()}.sqlite`);
  const config = buildConfig(dbPath);
  const chain = new NearChainClient(config);
  const store = new Store(dbPath, config.networkId, config.contractId);
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner);

  // Write a frozen snapshot directly through the public Store interface, then
  // assert the DTO strips per-agent entries.
  const snapshot: SnapshotRecord = {
    questionId: 1,
    snapshotId: 'snapshot-1-abc',
    aggregateBps: 5000,
    totalStakeYocto: 6n * ONE_NEAR,
    participantCount: 2,
    entries: [
      { accountId: 'a.testnet', probBps: 4000, stakeYocto: ONE_NEAR.toString() },
      { accountId: 'b.testnet', probBps: 6000, stakeYocto: (5n * ONE_NEAR).toString() },
    ],
  };
  store.saveSnapshot(snapshot);

  const dto = runtime.getSnapshotDto(1);
  assert.ok(dto);
  assert.equal(typeof dto.aggregateBps, 'number');
  assert.equal(dto.participantCount, 2);
  const serialized = JSON.stringify(dto);
  assert.ok(!serialized.includes('salt'));
  assert.ok(!serialized.includes('probBps'));
  assert.ok(!serialized.includes('entries'));
  assert.ok(!serialized.includes('accountId'));
  assert.ok(!serialized.includes('stakeYocto'), 'per-agent stakes not exposed');

  store.close();
  rmSync(dbPath, { force: true });
});

test('store is bound to one network/contract and refuses cross-deployment reuse', () => {
  const dbPath = path.join(tmpdir(), `hc-rt-${Date.now()}.sqlite`);
  const config = buildConfig(dbPath);
  const store1 = new Store(dbPath, 'testnet', CONTRACT);
  store1.close();

  assert.throws(
    () => new Store(dbPath, 'mainnet', 'other.testnet'),
    /refusing to mix deployments/,
  );
  rmSync(dbPath, { force: true });
});

test('read-only RPC views work against the real endpoint (get_contract_state, list_questions)', async () => {
  const dbPath = path.join(tmpdir(), `hc-rt-${Date.now()}.sqlite`);
  const config = buildConfig(dbPath);
  const chain = new NearChainClient(config);
  const state = await chain.getContractState();
  assert.equal(typeof state.operator, 'string');
  assert.equal(typeof state.question_count, 'number');
  const questions = await chain.listQuestions(0, 10);
  assert.ok(Array.isArray(questions));
  rmSync(dbPath, { force: true });
});
