/**
 * Operator CLI — create Questions, advance the lifecycle, inspect state.
 *
 * Management stays here (operator-only). The public HTTP service (service.ts)
 * exposes only health/config/questions/leaderboard and the owner-safe runtime
 * interface; it never signs or exposes private forecasts.
 */

import { NearChainClient } from './chain/index.js';
import { loadConfig } from './config.js';
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
  wibDateOfUtcMs,
} from './schedule.js';
import { Store } from './store.js';

function buildRuntime() {
  const config = loadConfig(process.env.HIVECAST_CONFIG ?? 'hivecast.config.json');
  const chain = new NearChainClient(config);
  const store = new Store(config.databasePath, config.networkId, config.contractId);
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
      '  hivecast-runner run                            autonomous scheduler (watch + tick, graceful stop)',
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

/** Idempotent: ensure the price Question for the given UTC hour exists. */
async function ensurePriceQuestion(runner: Runner, hourStartMs: number): Promise<void> {
  const schedule = computePriceSchedule(hourStartMs);
  const label = priceTargetLabel(hourStartMs);
  const src = sourceDefinition('price', label);
  await runner.createQuestion({
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
}

/** Idempotent: ensure the weather Question for the given WIB date exists. */
async function ensureWeatherQuestion(runner: Runner, date: string): Promise<void> {
  const wibMidnight = Date.parse(`${date}T00:00:00+07:00`);
  const schedule = computeWeatherSchedule(wibMidnight);
  const src = sourceDefinition('weather', date);
  await runner.createQuestion({
    domain: 'weather',
    text: questionText('weather', date),
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
}

/** Autonomous scheduler: idempotent Question scheduling + lifecycle tick loop. */
async function run(): Promise<void> {
  const { config, runner, store } = buildRuntime();
  process.stdout.write(`[run] started contract=${config.contractId} network=${config.networkId} poll=${config.pollIntervalMs}ms\n`);

  let stopping = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('[run] draining in-flight work before shutdown…\n');
    // Wait for the current tick/broadcast to finish and persist, then close.
    inFlight.finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Idempotent scheduling INSIDE the loop so the daemon keeps creating the next
  // period's Question as time advances (hourly price, daily weather).
  while (!stopping) {
    try {
      const now = Date.now();
      const nextHour = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
      await ensurePriceQuestion(runner, nextHour);
      const date = wibDateOfUtcMs(now + 7 * 3_600_000 + 86_400_000);
      await ensureWeatherQuestion(runner, date);

      const report = await runner.tick();
      for (const step of report.steps) {
        if (step.sent || step.error) {
          process.stdout.write(`[run] ${step.kind} q=${step.questionId} acct=${step.accountId ?? '-'} ${step.reason}${step.error ? ` err=${step.error}` : ''}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[run] tick error: ${(err as Error).message}\n`);
    }
    inFlight = new Promise((r) => setTimeout(r, config.pollIntervalMs));
    await inFlight;
  }
}

async function status(): Promise<void> {
  const { runtime, store } = buildRuntime();
  const questions = await runtime.listLocalQuestions();
  for (const q of questions) {
    const s = await runtime.getLifecycleStatus(q.questionId);
    if (!s) continue;
    const chain = s.chain
      ? `phase=${s.chain.phase} snapshot=${s.chain.snapshotReady} outcome=${s.chain.outcome ?? 'null'} participants=${s.chain.participantCount}`
      : 'chain=unavailable';
    process.stdout.write(`#${q.questionId} [${s.domain}] ${chain}\n`);
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
    case 'run':
      return run();
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
