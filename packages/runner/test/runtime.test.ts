/**
 * Runtime interface tests: the public surface the Forecast Access server will
 * consume. Verifies no secret (salt, private forecast, per-agent probability)
 * is reachable through the public DTOs and that config never carries keys.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';

import { EmulatedChainClient } from '../src/chain/emulated.js';
import type { RunnerConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';

const ONE_NEAR = 10n ** 24n;
const NS_PER_MS = 1_000_000n;
const MS_PER_HOUR = 3_600_000;

function accountId(agentId: string): string {
  return `${agentId}.hivecast.testnet`;
}

function buildConfig(dbPath: string): RunnerConfig {
  const agentAccounts = {} as Record<string, string>;
  for (const a of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) {
    agentAccounts[a] = accountId(a);
  }
  return {
    networkId: 'testnet',
    contractId: 'hivecast.testnet',
    operatorId: 'hivecast.testnet',
    resolverId: 'hivecast.testnet',
    rpcUrl: 'https://unused.invalid',
    credentialDirectory: '/unused',
    databasePath: dbPath,
    seed: 42,
    pollIntervalMs: 60_000,
    minStakeYocto: ONE_NEAR / 10n,
    accessPriceYocto: ONE_NEAR / 100n,
    agentAccounts: agentAccounts as RunnerConfig['agentAccounts'],
    binanceBaseUrl: 'https://unused.invalid',
    openMeteoBaseUrl: 'https://unused.invalid',
    kudusLatitude: '-6.8049',
    kudusLongitude: '110.8397',
    kudusTimezone: 'Asia/Jakarta',
    weatherModel: 'ecmwf_ifs04',
    chainMode: 'emulated',
    operationalGasReserveYocto: 0n,
    http: { enabled: false, host: '127.0.0.1', port: 8787 },
  };
}

test('public config never carries credential directory or keys', () => {
  const dbPath = path.join(tmpdir(), `hc-rt-${Date.now()}.sqlite`);
  const config = buildConfig(dbPath);
  const chain = new EmulatedChainClient('hivecast.testnet', { operator: 'hivecast.testnet' });
  const store = new Store(dbPath);
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

test('snapshot DTO exposes aggregate only, never per-agent secrets', async () => {
  const dbPath = path.join(tmpdir(), `hc-rt-${Date.now()}.sqlite`);
  const config = buildConfig(dbPath);
  const nativeBalances: Record<string, bigint> = {};
  for (const a of ['persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) {
    nativeBalances[accountId(a)] = 10n * ONE_NEAR;
  }
  const chain = new EmulatedChainClient('hivecast.testnet', {
    operator: 'hivecast.testnet',
    nowNs: BigInt(Date.UTC(2026, 10, 5, 10, 0, 0)) * NS_PER_MS,
    nativeBalances,
  });
  const store = new Store(dbPath);
  const runner = new Runner(config, chain, store, {
    async strategyInputs(q) {
      const closes: { openTime: string; open: string; high: string; low: string; close: string; closeTime: string; volume: string; quoteVolume: string; trades: string; takerBaseVolume: string; takerQuoteVolume: string }[] = [];
      const endMs = Number(q.closeTimeNs) / 1_000_000;
      for (let i = 0; i < 48; i++) {
        const t = endMs - (48 - i) * MS_PER_HOUR;
        closes.push({
          openTime: String(t), open: '4.0', high: '4.2', low: '3.9', close: '4.1',
          closeTime: String(t + MS_PER_HOUR), volume: '100', quoteVolume: '410',
          trades: '50', takerBaseVolume: '50', takerQuoteVolume: '205',
        });
      }
      return { kind: 'price', candles: closes };
    },
    async resolveOutcome() {
      return true;
    },
  });
  const runtime = new Runtime(config, chain, store, runner);

  const baseMs = Date.UTC(2026, 10, 5, 10, 0, 0);
  const obsStart = baseMs + 2 * MS_PER_HOUR;
  await runner.createQuestion({
    domain: 'price',
    text: 'price up?',
    eventDefinition: 'Binance NEARUSDT 1h candle',
    sourceJson: '{"kind":"price"}',
    sourceLabel: 'Binance NEARUSDT 1h',
    targetKey: `price:${obsStart}`,
    openTimeNs: BigInt(baseMs - 15 * 60_000) * NS_PER_MS,
    closeTimeNs: BigInt(baseMs + 30 * 60_000) * NS_PER_MS,
    observationStartNs: BigInt(obsStart) * NS_PER_MS,
    observationEndNs: BigInt(obsStart + MS_PER_HOUR) * NS_PER_MS,
    resolveTimeNs: BigInt(obsStart + MS_PER_HOUR) * NS_PER_MS,
    resolveDeadlineNs: BigInt(obsStart + MS_PER_HOUR + 15 * 60_000) * NS_PER_MS,
    revealWindowNs: 15n * 60n * 1_000_000_000n,
  });
  await runner.tick(); // commit
  chain.setNow(BigInt(baseMs + 40 * 60_000) * NS_PER_MS);
  await runner.tick(); // freeze snapshot

  const dto = runtime.getSnapshotDto(0)!;
  assert.ok(dto);
  assert.equal(typeof dto.aggregateBps, 'number');
  assert.equal(dto.participantCount, 6);
  const serialized = JSON.stringify(dto);
  assert.ok(!serialized.includes('salt'));
  assert.ok(!serialized.includes('probBps'));
  assert.ok(!serialized.includes('entries'), 'per-agent entries not exposed');
  assert.ok(!serialized.includes('accountId'));

  store.close();
  rmSync(dbPath, { force: true });
});

test('lifecycle status includes journal but no secrets', async () => {
  const dbPath = path.join(tmpdir(), `hc-rt-${Date.now()}.sqlite`);
  const config = buildConfig(dbPath);
  const chain = new EmulatedChainClient('hivecast.testnet', { operator: 'hivecast.testnet' });
  const store = new Store(dbPath);
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner);

  const status = await runtime.getLifecycleStatus(999);
  assert.equal(status, null, 'unknown question returns null');

  store.close();
  rmSync(dbPath, { force: true });
});
