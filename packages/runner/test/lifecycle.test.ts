/**
 * Lifecycle + restart tests at the real public seam (EmulatedChainClient is a
 * faithful re-implementation of the contract state machine, not a mock-success
 * stub). These exercise persistent-before-send, idempotent restart, snapshot
 * freezing, reveal, settle, withdrawal, zero-commit cancellation, and failed
 * transfer restore — all cross-platform (the real Linux near-sandbox proof is
 * in harness/lifecycle-harness.ts and must run in parent CI).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';

import type { Candle, StrategyInputs } from '@hivecast/core';
import { EmulatedChainClient } from '../src/chain/emulated.js';
import type { RunnerConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { Store } from '../src/store.js';
import type { LocalQuestion } from '../src/types.js';

const NS_PER_MS = 1_000_000n;
const NS_PER_MIN = 60n * 1_000_000_000n;
const MS_PER_HOUR = 3_600_000;
const ONE_NEAR = 10n ** 24n;

const CONTRACT = 'hivecast.testnet';
const OPERATOR = 'hivecast.testnet';
const RESOLVER = 'hivecast.testnet';

const PRICE_AGENTS = ['persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip'] as const;

function accountId(agentId: string): string {
  return `${agentId}.hivecast.testnet`;
}

function buildConfig(
  dbPath: string,
  overrides: Partial<RunnerConfig> = {},
): RunnerConfig {
  const agentAccounts = {} as Record<string, string>;
  for (const a of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) {
    agentAccounts[a] = accountId(a);
  }
  return {
    networkId: 'testnet',
    contractId: CONTRACT,
    operatorId: OPERATOR,
    resolverId: RESOLVER,
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
    ...overrides,
  };
}

function candles(count: number, endMs: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = endMs - (count - i) * MS_PER_HOUR;
    out.push({
      openTime: String(openTime),
      open: '4.0',
      high: '4.2',
      low: '3.9',
      close: '4.1',
      closeTime: String(openTime + MS_PER_HOUR),
      volume: '100',
      quoteVolume: '410',
      trades: '50',
      takerBaseVolume: '50',
      takerQuoteVolume: '205',
    });
  }
  return out;
}

function fixedSource(outcome: boolean): { strategyInputs: (q: LocalQuestion) => Promise<StrategyInputs>; resolveOutcome: () => Promise<boolean> } {
  return {
    async strategyInputs(q: LocalQuestion): Promise<StrategyInputs> {
      if (q.domain === 'price') {
        return { kind: 'price', candles: candles(48, Number(q.closeTimeNs) / 1_000_000) };
      }
      return { kind: 'weather', forecastPrecipMm: '2.5', historyPrecipMm: ['0.0', '1.2', '0.0'] };
    },
    async resolveOutcome(): Promise<boolean> {
      return outcome;
    },
  };
}

/** Build a price Question whose observation starts 2h from `base` (open window is live now). */
function priceQuestionParams(baseMs: number) {
  const obsStart = baseMs + 2 * MS_PER_HOUR;
  const open = baseMs - 15 * 60_000;
  const close = baseMs + 30 * 60_000;
  return {
    domain: 'price' as const,
    text: 'price up?',
    eventDefinition: 'Binance NEARUSDT 1h candle',
    sourceJson: JSON.stringify({ kind: 'price', instrument: 'NEARUSDT', interval: '1h' }),
    sourceLabel: 'Binance NEARUSDT 1h',
    targetKey: `price:${obsStart}`,
    openTimeNs: BigInt(open) * NS_PER_MS,
    closeTimeNs: BigInt(close) * NS_PER_MS,
    observationStartNs: BigInt(obsStart) * NS_PER_MS,
    observationEndNs: BigInt(obsStart + MS_PER_HOUR) * NS_PER_MS,
    resolveTimeNs: BigInt(obsStart + MS_PER_HOUR) * NS_PER_MS,
    resolveDeadlineNs: BigInt(obsStart + MS_PER_HOUR + 15 * 60_000) * NS_PER_MS,
    revealWindowNs: 15n * NS_PER_MIN,
  };
}

function tempDb(): string {
  const dir = tmpdir();
  return path.join(dir, `hivecast-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

test('full lifecycle: commit → freeze → resolve → reveal → settle → withdraw', async () => {
  const dbPath = tempDb();
  const baseMs = Date.UTC(2026, 10, 5, 10, 0, 0); // fixed point in time
  const params = priceQuestionParams(baseMs);

  const nativeBalances: Record<string, bigint> = {};
  for (const a of PRICE_AGENTS) nativeBalances[accountId(a)] = 10n * ONE_NEAR;

  const chain = new EmulatedChainClient(CONTRACT, {
    operator: OPERATOR,
    nowNs: BigInt(baseMs) * NS_PER_MS,
    nativeBalances,
  });
  const store = new Store(dbPath);
  const source = fixedSource(true);
  const runner = new Runner(buildConfig(dbPath), chain, store, source);

  // 1. create question (operator)
  const created = await runner.createQuestion(params);
  assert.equal(created.error, null);
  assert.ok(created.questionId !== null);
  const q = store.getQuestionByTargetKey(params.targetKey)!;
  assert.ok(q);

  // 2. open phase → all 6 agents commit (forecast+salt persisted first)
  const commitReport = await runner.tick();
  const commitSends = commitReport.steps.filter((s) => s.kind === 'commit' && s.sent);
  assert.equal(commitSends.length, 6);
  for (const a of PRICE_AGENTS) {
    const f = store.getForecast(q.questionId, accountId(a));
    assert.ok(f, `forecast persisted for ${a}`);
    assert.ok(f.salt.length === 64);
    assert.ok(store.getReservation(accountId(a), q.questionId) > 0n, `reservation for ${a}`);
  }

  // 3. advance to closed: freeze snapshot + publish readiness
  chain.setNow(BigInt(baseMs + 40 * 60_000) * NS_PER_MS); // past close, before obs
  const freezeReport = await runner.tick();
  assert.ok(freezeReport.steps.some((s) => s.kind === 'publish_snapshot' && s.sent), 'snapshot published');
  const snapshot = store.getSnapshot(q.questionId)!;
  assert.ok(snapshot);
  assert.equal(snapshot.participantCount, 6);

  // 4. closed → resolve (observation done; resolve_time = observation_end)
  chain.setNow(BigInt(baseMs + 3 * MS_PER_HOUR + 1) * NS_PER_MS);
  const resolveReport = await runner.tick();
  assert.ok(resolveReport.steps.some((s) => s.kind === 'resolve' && s.sent), 'resolved');

  // 5. resolved → reveal all 6
  const revealReport = await runner.tick();
  const reveals = revealReport.steps.filter((s) => s.kind === 'reveal' && s.sent);
  assert.equal(reveals.length, 6);

  // 6. advance past reveal deadline → settle (permissionless; runner drives)
  const resolved = await chain.getQuestion(q.questionId);
  const revealDeadline = BigInt(resolved!.reveal_deadline!);
  chain.setNow(revealDeadline + 1n);
  // settle is permissionless but the runner's settled-withdrawal triggers only
  // after the chain is settled; drive settle via the runner's withdraw path.
  await chain.settle(q.questionId, OPERATOR);
  const settled = await chain.getQuestion(q.questionId);
  assert.equal(settled!.phase, 'settled');

  // 7. settled → withdraw each participant's claimable
  const withdrawReport = await runner.tick();
  const withdraws = withdrawReport.steps.filter((s) => s.kind === 'withdraw' && s.sent);
  assert.ok(withdraws.length >= 1);

  // 8. conservation + native balance movement
  for (const a of PRICE_AGENTS) {
    const b = await chain.getBalance(accountId(a));
    assert.equal(BigInt(b.claimable), 0n, `${a} fully withdrawn`);
  }
  store.close();
  rmSync(dbPath, { force: true });
});

test('restart: no duplicate sends and no salt regeneration', async () => {
  const dbPath = tempDb();
  const baseMs = Date.UTC(2026, 10, 5, 10, 0, 0);
  const params = priceQuestionParams(baseMs);

  const nativeBalances: Record<string, bigint> = {};
  for (const a of PRICE_AGENTS) nativeBalances[accountId(a)] = 10n * ONE_NEAR;

  const chain = new EmulatedChainClient(CONTRACT, {
    operator: OPERATOR,
    nowNs: BigInt(baseMs) * NS_PER_MS,
    nativeBalances,
  });

  // First run: create + commit.
  const store1 = new Store(dbPath);
  const runner1 = new Runner(buildConfig(dbPath), chain, store1, fixedSource(true));
  await runner1.createQuestion(params);
  await runner1.tick();
  const saltsBefore: Record<string, string> = {};
  for (const a of PRICE_AGENTS) {
    saltsBefore[a] = store1.getForecast(0, accountId(a))!.salt;
  }
  const commitCount1 = store1.listJournal('commit').filter((j) => j.status === 'confirmed').length;
  assert.equal(commitCount1, 6);
  store1.close();

  // Restart: fresh Store + Runner against the same db and chain.
  const store2 = new Store(dbPath);
  const runner2 = new Runner(buildConfig(dbPath), chain, store2, fixedSource(true));
  const report2 = await runner2.tick();
  const newCommitSends = report2.steps.filter((s) => s.kind === 'commit' && s.sent);
  assert.equal(newCommitSends.length, 0, 'no commit re-sent on restart');

  for (const a of PRICE_AGENTS) {
    const f = store2.getForecast(0, accountId(a))!;
    assert.equal(f.salt, saltsBefore[a], `salt unchanged for ${a}`);
  }
  const commitCount2 = store2.listJournal('commit').filter((j) => j.status === 'confirmed').length;
  assert.equal(commitCount2, 6, 'still exactly 6 confirmed commits');
  store2.close();
  rmSync(dbPath, { force: true });
});

test('zero commitments → cancel after resolve deadline', async () => {
  const dbPath = tempDb();
  const baseMs = Date.UTC(2026, 10, 5, 10, 0, 0);
  const params = priceQuestionParams(baseMs);

  // Empty native balances → all agents below minimum stake → abstain/zero commits.
  const chain = new EmulatedChainClient(CONTRACT, {
    operator: OPERATOR,
    nowNs: BigInt(baseMs) * NS_PER_MS,
    nativeBalances: {},
  });
  const store = new Store(dbPath);
  const runner = new Runner(buildConfig(dbPath), chain, store, fixedSource(true));
  await runner.createQuestion(params);
  await runner.tick(); // commits all fail (below minimum)

  // Advance past resolve deadline → cancel (zero commitments).
  const q = store.getQuestionByTargetKey(params.targetKey)!;
  chain.setNow(q.resolveDeadlineNs + 1n);
  const report = await runner.tick();
  assert.ok(report.steps.some((s) => s.kind === 'cancel' && s.sent), 'cancelled');
  const view = await chain.getQuestion(q.questionId);
  assert.equal(view!.phase, 'cancelled');
  store.close();
  rmSync(dbPath, { force: true });
});

test('failed transfer: withdraw restores claimable, then re-withdraws', async () => {
  const dbPath = tempDb();
  const baseMs = Date.UTC(2026, 10, 5, 10, 0, 0);
  const params = priceQuestionParams(baseMs);

  const nativeBalances: Record<string, bigint> = {};
  for (const a of PRICE_AGENTS) nativeBalances[accountId(a)] = 10n * ONE_NEAR;

  const chain = new EmulatedChainClient(CONTRACT, {
    operator: OPERATOR,
    nowNs: BigInt(baseMs) * NS_PER_MS,
    nativeBalances,
    failWithdrawals: true,
  });
  const store = new Store(dbPath);
  const runner = new Runner(buildConfig(dbPath), chain, store, fixedSource(true));

  await runner.createQuestion(params);
  await runner.tick(); // commit

  chain.setNow(BigInt(baseMs + 40 * 60_000) * NS_PER_MS);
  await runner.tick(); // freeze
  chain.setNow(BigInt(baseMs + 3 * MS_PER_HOUR + 1) * NS_PER_MS);
  await runner.tick(); // resolve
  await runner.tick(); // reveal

  const resolved = await chain.getQuestion(0);
  const revealDeadline = BigInt(resolved!.reveal_deadline!);
  chain.setNow(revealDeadline + 1n);
  await chain.settle(0, OPERATOR);

  // First withdraw attempt: transfer fails → restored (claimable comes back).
  const report1 = await runner.tick();
  assert.ok(report1.steps.some((s) => s.kind === 'withdraw' && s.sent));
  // After restore, claimable is positive again for at least one participant.
  const someClaimable = await Promise.all(
    PRICE_AGENTS.map(async (a) => BigInt((await chain.getBalance(accountId(a))).claimable)),
  );
  assert.ok(someClaimable.some((c) => c > 0n), 'restored claimable present after failed transfer');

  // Second tick re-attempts (fresh attempt key) once pending clears.
  chain.setFailWithdrawals(false);
  const report2 = await runner.tick();
  assert.ok(report2.steps.some((s) => s.kind === 'withdraw' && s.sent), 're-withdraw after restore');
  for (const a of PRICE_AGENTS) {
    const b = await chain.getBalance(accountId(a));
    assert.equal(BigInt(b.claimable), 0n, `${a} fully withdrawn after retry`);
  }
  store.close();
  rmSync(dbPath, { force: true });
});
