/**
 * Real-chain lifecycle harness (Linux CI / operator machine).
 *
 * Drives a REAL testnet price Round end-to-end through the Runner (the same
 * code path as production): create_question → commit → publish_snapshot →
 * resolve → reveal → settle → withdraw, printing each transaction hash.
 *
 * NOT accelerated and NOT mocked: it creates a Question for the next full UTC
 * hour and polls the real chain until the Round is terminal and withdrawals are
 * drained. A full price Round spans ~1h15m of wall clock; a weather Round
 * spans ~48h. Run this only against the CORRECTED contract account id (see
 * local://hivecast-testnet-context.json — pending_corrected_contract_account_id).
 *
 * Usage (from repo root):
 *   HIVECAST_CONFIG=./hivecast.config.json \
 *     npm run harness:testnet --workspace @hivecast/runner -- price
 *
 * Preconditions:
 *   - corrected contract deployed + initialized (operator = config.operatorId)
 *   - credentialDirectory holds each signer's key
 *   - agent accounts funded so floor-10% sizing clears min_stake (plus gas)
 *
 * Remaining real-chain proof this does NOT claim on its own (requires the
 * Linux near-sandbox / corrected testnet deployment, tracked by ticket #7):
 *   gas measurement of 64-participant settlement, NEP-297 event receipts,
 *   buyer receipt challenge auth (ticket #5).
 */

import { NearChainClient } from '../src/chain/near.js';
import { loadConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import {
  computePriceSchedule,
  computeWeatherSchedule,
  hourFloorUtc,
  priceTargetKey,
  priceTargetLabel,
  questionText,
  sourceDefinition,
  weatherTargetKey,
  wibDateOfUtcMs,
} from '../src/schedule.js';
import { Store } from '../src/store.js';

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const domain = process.argv[2] === 'weather' ? 'weather' : 'price';
  const config = loadConfig(process.env.HIVECAST_CONFIG ?? 'hivecast.config.json');

  const chain = new NearChainClient(config);
  const store = new Store(config.databasePath, config.networkId, config.contractId);
  const runner = new Runner(config, chain, store);

  // Pick the next full target window.
  const nowMs = Date.now();
  let params: Parameters<Runner['createQuestion']>[0];
  if (domain === 'price') {
    const hourStart = hourFloorUtc(nowMs) + 3_600_000; // next full UTC hour
    const schedule = computePriceSchedule(hourStart);
    const label = priceTargetLabel(hourStart);
    const src = sourceDefinition('price', label);
    params = {
      domain: 'price',
      text: questionText('price', label),
      eventDefinition: src.label,
      sourceJson: src.json,
      sourceLabel: src.label,
      targetKey: priceTargetKey(hourStart),
      openTimeNs: schedule.openTimeNs,
      closeTimeNs: schedule.closeTimeNs,
      observationStartNs: schedule.observationStartNs,
      observationEndNs: schedule.observationEndNs,
      resolveTimeNs: schedule.resolveTimeNs,
      resolveDeadlineNs: schedule.resolveDeadlineNs,
      revealWindowNs: schedule.revealWindowNs,
    };
  } else {
    // Next WIB day (00:00 WIB).
    const date = wibDateOfUtcMs(Date.now() + 7 * 3_600_000 + 86_400_000);
    const wibMidnight = Date.parse(`${date}T00:00:00+07:00`);
    const schedule = computeWeatherSchedule(wibMidnight);
    const src = sourceDefinition('weather', date);
    params = {
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
    };
  }

  const created = await runner.createQuestion(params);
  if (created.error) throw new Error(`create_question: ${created.error}`);
  const questionId = created.questionId!;
  process.stdout.write(`[harness] created question_id=${questionId} already_exists=${created.alreadyExists}\n`);

  // Poll until terminal + withdrawals drained. Each iteration is isolated so a
  // transient RPC outage is reported and retried, never treated as fatal: the
  // journal/signed-tx state is already durably persisted before any broadcast,
  // so pausing here preserves all pending work.
  const started = Date.now();
  const MAX_MS = domain === 'price' ? 3 * 3_600_000 : 60 * 3_600_000;
  while (Date.now() - started < MAX_MS) {
    try {
      const report = await runner.tick();
      for (const s of report.steps) {
        if (s.sent) {
          process.stdout.write(`[harness] ${s.kind} q=${s.questionId} acct=${s.accountId ?? '-'} sent\n`);
        } else if (s.error) {
          process.stdout.write(`[harness] ${s.kind} q=${s.questionId} acct=${s.accountId ?? '-'} NOT-SENT ${s.reason} err=${s.error}\n`);
        }
      }
      const view = await chain.getQuestion(questionId);
      const terminal = view?.phase === 'settled' || view?.phase === 'cancelled';
      if (terminal) {
        process.stdout.write(`[harness] terminal phase=${view!.phase}\n`);
        // Drain withdrawals once more.
        await runner.tick();
        break;
      }
    } catch (err) {
      // RPC unavailable / transient failure: report, keep the loop alive, and
      // retry next poll. Pending journal/signed-tx work is preserved on disk.
      process.stderr.write(`[harness] non-fatal error (will retry): ${(err as Error).message}\n`);
    }
    await sleep(config.pollIntervalMs);
  }

  const view = await chain.getQuestion(questionId);
  process.stdout.write(`[harness] final phase=${view?.phase} outcome=${view?.outcome ?? 'null'}\n`);
  store.close();
}

main().catch((err) => {
  process.stderr.write(`[harness] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
