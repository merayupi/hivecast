/**
 * Operator CLI — create Questions, advance the lifecycle, inspect state.
 *
 * Management stays here (operator-only). The public HTTP service (service.ts)
 * exposes only health/config/questions/leaderboard and the owner-safe runtime
 * interface; it never signs or exposes private forecasts.
 */

import { EmulatedChainClient, NearChainClient } from './chain/index.js';
import type { ChainClient } from './chain/types.js';
import { loadConfig } from './config.js';
import type { RunnerConfig } from './config.js';
import { Runner } from './runner.js';
import { Runtime } from './runtime.js';
import {
  computePriceSchedule,
  computeWeatherSchedule,
  priceTargetKey,
  priceTargetLabel,
  questionText,
  sourceDefinition,
  weatherTargetKey,
  weatherTargetLabel,
} from './schedule.js';
import { Store } from './store.js';

function buildChain(config: RunnerConfig): ChainClient {
  if (config.chainMode === 'emulated') {
    return new EmulatedChainClient(config.contractId, { operator: config.operatorId });
  }
  return new NearChainClient(config);
}

function buildRuntime() {
  const config = loadConfig(process.env.HIVECAST_CONFIG ?? 'hivecast.config.json');
  const chain = buildChain(config);
  const store = new Store(config.databasePath);
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner);
  return { config, chain, store, runner, runtime };
}

function usage(): never {
  process.stderr.write(
    [
      'Usage:',
      '  hivecast-runner create-price <hourStartMs>     create a price Question for a UTC hour',
      '  hivecast-runner create-weather <date>          create a weather Question for a WIB date',
      '  hivecast-runner tick                           advance all tracked Questions once',
      '  hivecast-runner status                         list lifecycle status',
      '  hivecast-runner snapshot <questionId>          print frozen snapshot aggregate (private)',
      '',
      'Env: HIVECAST_CONFIG (default ./hivecast.config.json)',
    ].join('\n'),
  );
  process.exit(2);
}

async function createPrice(args: string[]): Promise<void> {
  const hourStartMs = Number(args[0]);
  if (!Number.isFinite(hourStartMs)) usage();
  const { runner, store } = buildRuntime();
  const schedule = computePriceSchedule(hourStartMs);
  const label = priceTargetLabel(hourStartMs);
  const src = sourceDefinition('price', label);
  const res = await runner.createQuestion({
    domain: 'price',
    text: questionText('price', label),
    eventDefinition: src.label,
    sourceJson: src.json,
    sourceLabel: src.label,
    targetKey: priceTargetKey(hourStartMs),
    openTimeNs: schedule.openTimeNs,
    closeTimeNs: schedule.closeTimeNs,
    observationStartNs: schedule.observationStartNs,
    observationEndNs: schedule.observationEndNs,
    resolveTimeNs: schedule.resolveTimeNs,
    resolveDeadlineNs: schedule.resolveDeadlineNs,
    revealWindowNs: schedule.revealWindowNs,
  });
  if (res.error) {
    process.stderr.write(`create_question failed: ${res.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`question_id=${res.questionId} already_exists=${res.alreadyExists}\n`);
  store.close();
}

async function createWeather(args: string[]): Promise<void> {
  const date = args[0] ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) usage();
  const { runner, store } = buildRuntime();
  const dateUtcMs = Date.parse(`${date}T00:00:00+07:00`);
  const schedule = computeWeatherSchedule(dateUtcMs);
  const label = weatherTargetLabel(date);
  const src = sourceDefinition('weather', date);
  const res = await runner.createQuestion({
    domain: 'weather',
    text: questionText('weather', label),
    eventDefinition: src.label,
    sourceJson: src.json,
    sourceLabel: src.label,
    targetKey: weatherTargetKey(date),
    openTimeNs: schedule.openTimeNs,
    closeTimeNs: schedule.closeTimeNs,
    observationStartNs: schedule.observationStartNs,
    observationEndNs: schedule.observationEndNs,
    resolveTimeNs: schedule.resolveTimeNs,
    resolveDeadlineNs: schedule.resolveDeadlineNs,
    revealWindowNs: schedule.revealWindowNs,
  });
  if (res.error) {
    process.stderr.write(`create_question failed: ${res.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`question_id=${res.questionId} already_exists=${res.alreadyExists}\n`);
  store.close();
}

async function tick(): Promise<void> {
  const { runner, store } = buildRuntime();
  const report = await runner.tick();
  for (const step of report.steps) {
    process.stdout.write(
      `${step.kind} q=${step.questionId} acct=${step.accountId ?? '-'} sent=${step.sent} ${step.reason}${step.error ? ` err=${step.error}` : ''}\n`,
    );
  }
  store.close();
}

async function status(): Promise<void> {
  const { runtime, store } = buildRuntime();
  const questions = await runtime.listLocalQuestions();
  for (const q of questions) {
    const s = await runtime.getLifecycleStatus(q.questionId);
    process.stdout.write(
      `#${q.questionId} [${s?.domain}] phase=${s?.phase} snapshot=${s?.snapshotReady} outcome=${s?.outcome ?? 'null'} participants=${s?.participantCount}\n`,
    );
  }
  store.close();
}

async function snapshotCmd(args: string[]): Promise<void> {
  const questionId = Number(args[0]);
  if (!Number.isInteger(questionId)) usage();
  const { runtime, store } = buildRuntime();
  const dto = runtime.getSnapshotDto(questionId);
  if (!dto) {
    process.stdout.write('not-frozen\n');
  } else {
    process.stdout.write(JSON.stringify(dto, null, 2) + '\n');
  }
  store.close();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case 'create-price':
      return createPrice(rest);
    case 'create-weather':
      return createWeather(rest);
    case 'tick':
      return tick();
    case 'status':
      return status();
    case 'snapshot':
      return snapshotCmd(rest);
    default:
      usage();
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
