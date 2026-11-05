/**
 * Offline replay CLI behavior tests (the approved external seam).
 *
 * These run against the committed bundle only — no network, no keys, no LLM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ONE_NEAR, QUERY_FEE } from '@hivecast/core';
import { loadBundle } from '../src/bundle.js';
import { runReplay, defaultConfig, INITIAL_CAPITAL } from '../src/replay.js';
import type { ReplayReport } from '../src/replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function run(): ReplayReport {
  return runReplay(loadBundle(), defaultConfig(42));
}

test('reproducibility: same bundle/config/seed yields identical reports', () => {
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
});

test('a different seed changes the seeded strategies but not the schedule', () => {
  const a = runReplay(loadBundle(), defaultConfig(42));
  const b = runReplay(loadBundle(), defaultConfig(7));
  assert.notDeepEqual(a, b);
  // schedule is seed-independent
  assert.equal(a.price.totalRounds, b.price.totalRounds);
  assert.equal(a.weather.totalRounds, b.weather.totalRounds);
});

test('fixed period: 1440 price rounds and 60 weather rounds', () => {
  const r = run();
  assert.equal(r.price.totalRounds, 1440);
  assert.equal(r.weather.totalRounds, 60);
  assert.equal(r.config.priceRounds, 1440);
  assert.equal(r.config.weatherRounds, 60);
});

test('six relevant strategies per domain', () => {
  const r = run();
  assert.deepEqual(r.price.participants.slice().sort(), [
    'coinflip',
    'meanrev',
    'momentum',
    'noisy-trend',
    'persistence',
    'yolo',
  ]);
  assert.deepEqual(r.weather.participants.slice().sort(), [
    'climatology',
    'coinflip',
    'meteo',
    'noisy-trend',
    'persistence',
    'yolo',
  ]);
});

test('no agent fabricates a bankroll: accounting is conserved to the last yocto', () => {
  const r = run();
  for (const domain of [r.price, r.weather]) {
    const start = 6n * INITIAL_CAPITAL;
    const feeIncome = BigInt(domain.roundsWithParticipants) * QUERY_FEE;
    let finalSum = 0n;
    let pnlSum = 0n;
    for (const a of domain.agents) {
      const bankroll = BigInt(a.finalBankroll);
      assert.ok(bankroll >= 0n, `${a.agentId} bankroll is non-negative`);
      finalSum += bankroll;
      pnlSum += BigInt(a.wageringPnl);
    }
    // wagering is zero-sum across participants; fee income is the only net inflow.
    assert.equal(pnlSum, 0n, `${domain.domain}: wagering P/L is zero-sum`);
    assert.equal(finalSum, start + feeIncome, `${domain.domain}: bankroll conserved`);
  }
});

test('initial capital is 100 NEAR and reset per domain', () => {
  const r = run();
  assert.equal(r.price.initialCapital, INITIAL_CAPITAL.toString());
  assert.equal(r.weather.initialCapital, INITIAL_CAPITAL.toString());
  assert.equal(r.config.initialCapitalNear, '100');
  assert.equal(r.config.minStakeNear, '0.1');
  assert.equal(r.config.queryFeeNear, '0.01');
});

test('abstention below minimum stake: tiny capital forces skip without rounding up', () => {
  const cfg = {
    seed: 42,
    initialCapital: ONE_NEAR / 2n, // 0.5 NEAR -> 10% = 0.05 < 0.1 min stake
    stakeFloorDenom: 10n,
    minStake: ONE_NEAR / 10n,
    queryFee: QUERY_FEE,
  };
  const r = runReplay(loadBundle(), cfg);
  for (const a of r.price.agents) {
    assert.equal(a.roundsParticipated, 0, `${a.agentId} does not stake below min`);
    assert.equal(a.roundsSkippedBelowMin, a.roundsForecast);
    assert.ok(a.roundsForecast > 0, `${a.agentId} still produces forecasts`);
  }
  assert.equal(r.price.roundsWithParticipants, 0);
});

test('unsupported specialist abstains: meteo absent from price, momentum absent from weather', () => {
  const r = run();
  assert.ok(!r.price.participants.includes('meteo'));
  assert.ok(!r.price.participants.includes('climatology'));
  assert.ok(!r.weather.participants.includes('momentum'));
  assert.ok(!r.weather.participants.includes('meanrev'));
});

test('availability disclosure is present and classifies meteo as inference', () => {
  const r = run();
  assert.ok(r.availability.length >= 4);
  const meteo = r.availability.find((a) => a.id === 'open-meteo-ifs-single-runs');
  assert.ok(meteo, 'meteo availability entry present');
  assert.equal(meteo!.availability, 'inference');
  const climatology = r.availability.find((a) => a.id === 'open-meteo-ifs-climatology-history');
  assert.ok(climatology, 'climatology availability entry present');
  assert.equal(climatology!.availability, 'retrospective');
});

test('CLI runs offline from the committed bundle and emits deterministic JSON', () => {
  const cli = path.resolve(HERE, '..', 'src', 'cli.ts');
  const out1 = execFileSync(
    process.execPath,
    ['--import', 'tsx', cli, '--json-only'],
    { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } },
  );
  const out2 = execFileSync(
    process.execPath,
    ['--import', 'tsx', cli, '--json-only'],
    { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } },
  );
  assert.equal(out1, out2);
  const report = JSON.parse(out1) as ReplayReport;
  assert.equal(report.price.totalRounds, 1440);
  assert.equal(report.weather.totalRounds, 60);
});

test('CLI rejects an unknown argument with a non-zero exit', () => {
  const cli = path.resolve(HERE, '..', 'src', 'cli.ts');
  assert.throws(() => {
    execFileSync(process.execPath, ['--import', 'tsx', cli, '--bogus'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  });
});
