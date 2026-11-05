/**
 * Offline replay CLI behavior tests — the approved external seam.
 *
 * Every assertion runs the actual CLI in a subprocess (`node --import tsx
 * src/cli.ts`) against the committed bundle, with network actively denied via
 * a preload hook. No direct imports of runReplay/loadBundle helpers; the CLI
 * is the only interface under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'src', 'cli.ts');
const DENY_NETWORK = path.resolve(HERE, 'fixtures', 'deny-network.cjs');
const ONE_NEAR = 10n ** 24n;
const QUERY_FEE = ONE_NEAR / 100n; // 0.01 NEAR per round

interface ReportAgent {
  agentId: string;
  roundsForecast: number;
  roundsParticipated: number;
  roundsAbstained: number;
  roundsSkippedBelowMin: number;
  finalBankroll: string;
  totalStaked: string;
  wageringPnl: string;
  feeIncome: string;
  brierMean: number | null;
  brierRounds: number;
}
interface ReportDomain {
  domain: string;
  totalRounds: number;
  roundsWithParticipants: number;
  initialCapital: string;
  participants: string[];
  agents: ReportAgent[];
  aggregates: Array<{ kind: string; brierMean: number; logLossMean: number }>;
}
interface Report {
  seed: number;
  price: ReportDomain;
  weather: ReportDomain;
}

function runCli(args: string[], opts: { denyNetwork?: boolean } = {}): Report {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.denyNetwork !== false) {
    // NODE_OPTIONS must use forward slashes on Windows (backslashes are
    // stripped by Node's env parser).
    const preload = DENY_NETWORK.replace(/\\/g, '/');
    env.NODE_OPTIONS = `--require=${preload}`;
  }
  const out = execFileSync(process.execPath, ['--import', 'tsx', CLI, '--json-only', ...args], {
    encoding: 'utf8',
    env,
  });
  return JSON.parse(out) as Report;
}

test('CLI runs entirely offline with the network actively denied', () => {
  const report = runCli([], { denyNetwork: true });
  assert.equal(report.price.totalRounds, 1440);
  assert.equal(report.weather.totalRounds, 60);
});

test('reproducible: identical invocation yields byte-identical JSON', () => {
  const a = runCli([]);
  const b = runCli([]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a different seed changes seeded strategies but not the schedule', () => {
  const a = runCli(['--seed', '42']);
  const b = runCli(['--seed', '7']);
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.price.totalRounds, b.price.totalRounds);
  assert.equal(a.weather.totalRounds, b.weather.totalRounds);
});

test('fixed period: 1440 price rounds and 60 weather rounds with correct denominators', () => {
  const r = runCli([]);
  assert.equal(r.price.totalRounds, 1440);
  assert.equal(r.weather.totalRounds, 60);
  // brier denominator = every participated round
  for (const a of r.price.agents) assert.equal(a.brierRounds, a.roundsParticipated);
  for (const a of r.weather.agents) assert.equal(a.brierRounds, a.roundsParticipated);
});

test('six relevant strategies per domain; unsupported specialists abstain', () => {
  const r = runCli([]);
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
  assert.ok(!r.price.participants.includes('meteo'));
  assert.ok(!r.price.participants.includes('climatology'));
  assert.ok(!r.weather.participants.includes('momentum'));
  assert.ok(!r.weather.participants.includes('meanrev'));
});

test('accounting is conserved: no agent fabricates a bankroll', () => {
  const r = runCli([]);
  for (const domain of [r.price, r.weather]) {
    assert.equal(domain.initialCapital, (100n * ONE_NEAR).toString());
    const start = 6n * 100n * ONE_NEAR;
    const feeIncome = BigInt(domain.roundsWithParticipants) * QUERY_FEE;
    let finalSum = 0n;
    let pnlSum = 0n;
    for (const a of domain.agents) {
      const bankroll = BigInt(a.finalBankroll);
      assert.ok(bankroll >= 0n, `${a.agentId} bankroll non-negative`);
      finalSum += bankroll;
      pnlSum += BigInt(a.wageringPnl);
    }
    assert.equal(pnlSum, 0n, `${domain.domain}: wagering P/L is zero-sum`);
    assert.equal(finalSum, start + feeIncome, `${domain.domain}: bankroll conserved to the yocto`);
  }
});

test('below-minimum capital forces abstention without rounding up', () => {
  // 0.5 NEAR -> 10% = 0.05 NEAR < 0.1 minimum stake -> skip every round.
  const r = runCli(['--capital', '0.5']);
  for (const a of r.price.agents) {
    assert.equal(a.roundsParticipated, 0, `${a.agentId} does not stake below min`);
    assert.equal(a.roundsSkippedBelowMin, a.roundsForecast);
    assert.ok(a.roundsForecast > 0, `${a.agentId} still produces forecasts`);
  }
  assert.equal(r.price.roundsWithParticipants, 0);
});

test('Brier means lie in [0,1] and log-loss means are finite, non-negative, and bounded', () => {
  const r = runCli([]);
  // Log-loss (logarithmic scoring rule) is bounded by -log(clip) with clip
  // 1e-9 => ~20.72. A metric near this magnitude (e.g. a squared log-odds
  // difference ~430) is not a legitimate log-score.
  const LOG_LOSS_BOUND = 21;
  for (const domain of [r.price, r.weather]) {
    for (const a of domain.agents) {
      if (a.brierMean !== null) {
        assert.ok(a.brierMean >= 0 && a.brierMean <= 1, `${a.agentId} brier ${a.brierMean} in [0,1]`);
      }
    }
    for (const agg of domain.aggregates) {
      assert.ok(agg.brierMean >= 0 && agg.brierMean <= 1, `${agg.kind} brier ${agg.brierMean} in [0,1]`);
      assert.ok(
        Number.isFinite(agg.logLossMean) && agg.logLossMean >= 0 && agg.logLossMean <= LOG_LOSS_BOUND,
        `${agg.kind} log-loss ${agg.logLossMean} in [0, ${LOG_LOSS_BOUND}]`,
      );
    }
  }
});

test('capital reset is independent between domains', () => {
  const r = runCli([]);
  assert.equal(r.price.initialCapital, r.weather.initialCapital);
  assert.equal(r.price.initialCapital, (100n * ONE_NEAR).toString());
});

test('CLI rejects an unknown argument with a non-zero exit', () => {
  assert.throws(() => {
    execFileSync(process.execPath, ['--import', 'tsx', CLI, '--bogus'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  });
});
