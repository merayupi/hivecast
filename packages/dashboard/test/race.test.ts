/**
 * Season Replay model over the recorded offline replay report
 * (`/simulation/report`, fixtures/simulation-report.json).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { advance, bankrollAt, buildRace, isBankruptAt, leaderAt, logX, nearToYocto, sampleLabel, yoctoToNear } from '../src/arena/race';
import type { ReplayReport } from '../src/lib/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'simulation-report.json'), 'utf8')) as ReplayReport;
const price = buildRace(report.price.series!, report.config.minStakeNear);
const weather = buildRace(report.weather.series!, report.config.minStakeNear);
const last = (m: typeof price) => m.labels.length - 1;

test('race is built from the sampled series only, with decade axis bounds covering every value', () => {
  assert.deepEqual(price.agents.sort(), ['coinflip', 'meanrev', 'momentum', 'noisy-trend', 'persistence', 'yolo']);
  assert.equal(price.labels.length, report.price.series!.labels.length);
  for (const a of price.agents) for (const v of price.near[a]!) if (v > 0) {
    assert.ok(Math.log10(v) >= price.lo - 1e-9 && Math.log10(v) <= price.hi + 1e-9, `${a} ${v}`);
  }
});

test('positions: exact at samples, log-interpolated between them, monotone log axis', () => {
  const a = 'meanrev';
  assert.equal(bankrollAt(price, a, 10), price.near[a]![10]);
  const mid = bankrollAt(price, a, 10.5);
  const lo = Math.min(price.near[a]![10]!, price.near[a]![11]!);
  const hi = Math.max(price.near[a]![10]!, price.near[a]![11]!);
  assert.ok(mid >= lo - 1e-9 && mid <= hi + 1e-9);
  assert.ok(logX(price, 1) < logX(price, 10) && logX(price, 10) < logX(price, 100));
  assert.equal(logX(price, 0), 0);
});

test('the leader at the final sample is the agent with the largest final bankroll in the report', () => {
  for (const [m, d] of [[price, report.price], [weather, report.weather]] as const) {
    const richest = [...d.agents].sort((x, y) => (BigInt(y.finalBankroll) > BigInt(x.finalBankroll) ? 1 : -1))[0]!.agentId;
    assert.equal(leaderAt(m, last(m)), richest);
  }
  assert.equal(leaderAt(price, last(price)), 'meanrev');
});

test('bankrupt = cannot fund the minimum stake (bankroll < 10 × 0.1 NEAR): Yolo collapses in the price replay', () => {
  assert.equal(nearToYocto('0.1'), 10n ** 23n);
  assert.equal(price.bankruptBelowYocto, 10n ** 24n);
  assert.equal(isBankruptAt(price, 'yolo', last(price)), true, 'yolo ends below 1 NEAR');
  assert.equal(isBankruptAt(price, 'yolo', 0), false, 'everyone starts solvent');
  assert.equal(isBankruptAt(price, 'meanrev', last(price)), false);
  const yoloFinal = report.price.agents.find((a) => a.agentId === 'yolo')!.finalBankroll;
  assert.ok(BigInt(yoloFinal) < 10n ** 24n, 'matches the report summary');
});

test('playback: 1× = 4 samples/s, 16× is 16 times faster, clamps at the end', () => {
  assert.deepEqual(advance(0, 1000, 1, 240), { t: 4, ended: false });
  assert.deepEqual(advance(0, 1000, 16, 240), { t: 64, ended: false });
  assert.deepEqual(advance(239, 1000, 4, 240), { t: 240, ended: true });
  assert.equal(sampleLabel('start'), 'start');
  assert.equal(sampleLabel('2026-08-01T05:00:00.000Z'), '2026-08-01 05:00 UTC');
  assert.equal(sampleLabel('2026-08-02'), '2026-08-02');
  assert.equal(yoctoToNear('1500000000000000000000000'), 1.5);
});
