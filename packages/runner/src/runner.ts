/**
 * Runner — autonomous lifecycle orchestration over a ChainClient + private
 * Store. All secrets (forecasts, salts) are persisted BEFORE the commit
 * transaction is sent; the transaction journal makes every send idempotent so
 * a restart never duplicates a send or regenerates a secret.
 *
 * Lifecycle per Question (driven by the chain's own phase, which is time-derived):
 *   open      → run strategies, persist forecast+salt, reserve capital, commit
 *   closed    → freeze the immutable Forecast Snapshot, publish readiness,
 *               then resolve (or cancel on timeout / missing outcome)
 *   resolved  → reveal each participant's forecast with its persisted salt
 *   settled   → withdraw each agent's claimable balance
 *   cancelled → withdraw each agent's refunded stake (no scoring)
 */

import { createHash } from 'node:crypto';
import { getStrategy, supportsDomain } from '@hivecast/core';
import type { AgentId, Domain, StrategyContext, StrategyInputs } from '@hivecast/core';
import { commitmentHash, generateSalt } from './commitment.js';
import type { ChainClient } from './chain/types.js';
import type { RunnerConfig } from './config.js';
import { nsToMs, priceTargetLabel, weatherTargetLabel, wibDateOfUtcMs } from './schedule.js';
import {
  fetchCompletedCandles,
  fetchPriceResolution,
  fetchWeatherForecast,
  fetchWeatherResolution,
} from './source.js';
import type { Store } from './store.js';
import type { ForecastRecord, JournalKind, LocalQuestion, SnapshotRecord } from './types.js';

export interface StepResult {
  kind: string;
  questionId: number | null;
  accountId: string | null;
  sent: boolean;
  reason: string;
  error: string | null;
}

export interface TickReport {
  steps: StepResult[];
}

/** Point-in-time strategy inputs and resolution outcomes, by Question. */
export interface SourceProvider {
  strategyInputs(q: LocalQuestion): Promise<StrategyInputs>;
  resolveOutcome(q: LocalQuestion): Promise<boolean>;
}

const STAKE_FLOOR_DENOM = 10n; // 10% of available balance
const PRICE_LOOKBACK_CANDLES = 48;
const WEATHER_HISTORY_DAYS = 30;

/** Real source provider: completed candles / forecast runs / archive resolution. */
export class LiveSourceProvider implements SourceProvider {
  constructor(private config: RunnerConfig) {}

  async strategyInputs(q: LocalQuestion): Promise<StrategyInputs> {
    if (q.domain === 'price') {
      const cutoffMs = nsToMs(q.closeTimeNs);
      const { candles } = await fetchCompletedCandles(this.config, cutoffMs, PRICE_LOOKBACK_CANDLES);
      return { kind: 'price', candles };
    }
    const targetDate = wibDateOfUtcMs(nsToMs(q.observationStartNs));
    const { forecastPrecipMm } = await fetchWeatherForecast(this.config, targetDate);
    const historyPrecipMm: string[] = [];
    for (let i = 1; i <= WEATHER_HISTORY_DAYS; i++) {
      const d = new Date(nsToMs(q.observationStartNs) - i * 86_400_000);
      const date = wibDateOfUtcMs(d.getTime());
      try {
        const res = await fetchWeatherResolution(this.config, date);
        historyPrecipMm.push(res.precipitationMm);
      } catch {
        // Leave a gap; strategies treat missing history as available-only.
      }
    }
    historyPrecipMm.reverse();
    return { kind: 'weather', forecastPrecipMm, historyPrecipMm };
  }

  async resolveOutcome(q: LocalQuestion): Promise<boolean> {
    if (q.domain === 'price') {
      const res = await fetchPriceResolution(this.config, nsToMs(q.observationStartNs));
      return res.outcome;
    }
    const res = await fetchWeatherResolution(this.config, wibDateOfUtcMs(nsToMs(q.observationStartNs)));
    return res.outcome;
  }
}

export class Runner {
  readonly config: RunnerConfig;
  readonly chain: ChainClient;
  readonly store: Store;
  private source: SourceProvider;

  constructor(config: RunnerConfig, chain: ChainClient, store: Store, source?: SourceProvider) {
    this.config = config;
    this.chain = chain;
    this.store = store;
    this.source = source ?? new LiveSourceProvider(config);
  }

  private nowNs(): bigint {
    return this.chain.nowNs();
  }

  private agentAccount(agentId: AgentId): string {
    return this.config.agentAccounts[agentId];
  }

  /** Domain-relevant agents (spec §8), deterministic order. */
  private participantsFor(domain: Domain): { agentId: AgentId; accountId: string }[] {
    const out: { agentId: AgentId; accountId: string }[] = [];
    for (const id of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip'] as AgentId[]) {
      if (supportsDomain(id, domain)) out.push({ agentId: id, accountId: this.agentAccount(id) });
    }
    return out;
  }

  private strategyContext(
    q: LocalQuestion,
    agentId: AgentId,
    inputs: StrategyInputs,
  ): StrategyContext {
    const targetTime =
      q.domain === 'price'
        ? priceTargetLabel(nsToMs(q.observationStartNs))
        : weatherTargetLabel(wibDateOfUtcMs(nsToMs(q.observationStartNs)));
    return {
      agentId,
      domain: q.domain,
      targetTime,
      roundKey: `${q.domain}:${q.questionId}`,
      inputs,
      seed: this.config.seed,
    };
  }

  // -------------------------------------------------------------------------
  // Capital sizing
  // -------------------------------------------------------------------------

  /** Available balance for a new stake: native − outstanding reservations − gas. */
  private async availableForStake(accountId: string): Promise<bigint> {
    const native = await this.chain.viewAccountBalance(accountId);
    const reserved = this.store.totalReserved(accountId);
    const available = native - reserved - this.config.operationalGasReserveYocto;
    return available < 0n ? 0n : available;
  }

  // -------------------------------------------------------------------------
  // Journal helper (idempotent send)
  // -------------------------------------------------------------------------

  private async runOnce(
    dedupKey: string,
    kind: JournalKind,
    questionId: number | null,
    accountId: string | null,
    payload: unknown,
    send: () => Promise<{ success: boolean; error: string | null }>,
    verify: () => Promise<boolean>,
  ): Promise<StepResult> {
    const { alreadyConfirmed } = this.store.upsertJournal({
      dedupKey,
      kind,
      questionId,
      accountId,
      payloadJson: JSON.stringify(payload),
    });
    if (alreadyConfirmed) {
      return { kind, questionId, accountId, sent: false, reason: 'already-confirmed', error: null };
    }
    // Reconcile a previously submitted (crash-orphaned) entry against the chain.
    const submitted = this.store.getJournal(dedupKey);
    if (submitted?.status === 'submitted' && (await verify())) {
      this.store.markConfirmed(dedupKey);
      return { kind, questionId, accountId, sent: false, reason: 'reconciled', error: null };
    }
    const outcome = await send();
    if (outcome.success) {
      this.store.markConfirmed(dedupKey);
      return { kind, questionId, accountId, sent: true, reason: 'sent', error: null };
    }
    this.store.markFailed(dedupKey, outcome.error ?? 'unknown error');
    return { kind, questionId, accountId, sent: false, reason: 'failed', error: outcome.error };
  }

  // -------------------------------------------------------------------------
  // Lifecycle steps
  // -------------------------------------------------------------------------

  private async commitAgent(q: LocalQuestion, agentId: AgentId, accountId: string, inputs: StrategyInputs): Promise<StepResult> {
    const result = getStrategy(agentId)(this.strategyContext(q, agentId, inputs));
    const dedupKey = `commit:${q.questionId}:${accountId}`;
    const verify = async () => {
      const c = await this.chain.getCommitment(q.questionId, accountId);
      const f = this.store.getForecast(q.questionId, accountId);
      return c !== null && f !== null && c.hash === f.commitmentHash;
    };
    if (result.kind === 'abstain') {
      return { kind: 'commit', questionId: q.questionId, accountId, sent: false, reason: `abstain:${result.reason}`, error: null };
    }
    const probBps = result.probabilityBps;
    const available = await this.availableForStake(accountId);
    const stake = available / STAKE_FLOOR_DENOM;
    if (stake < this.config.minStakeYocto) {
      return { kind: 'commit', questionId: q.questionId, accountId, sent: false, reason: 'below-minimum-stake', error: null };
    }
    // Persist forecast + salt BEFORE sending (never regenerate on restart).
    let forecast = this.store.getForecast(q.questionId, accountId);
    if (!forecast) {
      const salt = generateSalt();
      forecast = {
        questionId: q.questionId,
        agentId,
        accountId,
        probBps,
        salt,
        stakeYocto: stake,
        commitmentHash: commitmentHash({
          contractId: this.chain.contractId,
          questionId: q.questionId,
          accountId,
          stakeYocto: stake,
          probBps,
          salt,
        }),
      };
      this.store.saveForecast(forecast);
    }
    this.store.reserve(accountId, q.questionId, forecast.stakeYocto);
    return this.runOnce(
      dedupKey,
      'commit',
      q.questionId,
      accountId,
      { probBps: forecast.probBps, stake: forecast.stakeYocto.toString() },
      async () => {
        const outcome = await this.chain.commit(q.questionId, forecast!.commitmentHash, forecast!.stakeYocto, accountId);
        if (!outcome.success) this.store.releaseReservation(accountId, q.questionId);
        return outcome;
      },
      verify,
    );
  }

  private async commitPhase(q: LocalQuestion): Promise<StepResult[]> {
    const steps: StepResult[] = [];
    let inputs: StrategyInputs;
    try {
      inputs = await this.source.strategyInputs(q);
    } catch (err) {
      return [{ kind: 'commit', questionId: q.questionId, accountId: null, sent: false, reason: 'inputs-unavailable', error: (err as Error).message }];
    }
    for (const p of q.participants) {
      steps.push(await this.commitAgent(q, p.agentId, p.accountId, inputs));
    }
    return steps;
  }

  private computeAggregateBps(entries: { probBps: number; stakeYocto: bigint }[]): number {
    let num = 0n;
    let denom = 0n;
    for (const e of entries) {
      num += BigInt(e.probBps) * e.stakeYocto;
      denom += e.stakeYocto;
    }
    if (denom === 0n) return 0;
    // Round-half-up to the nearest basis point.
    return Number((num + denom / 2n) / denom);
  }

  private snapshotIdFor(entries: SnapshotRecord['entries'], questionId: number): string {
    const canon = JSON.stringify(
      entries
        .map((e) => [e.accountId, e.probBps, e.stakeYocto])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
    );
    const digest = createHash('sha256').update(canon).digest('hex');
    return `snapshot-${questionId}-${digest.slice(0, 16)}`;
  }

  private async freezeSnapshot(q: LocalQuestion): Promise<StepResult[]> {
    const existing = this.store.getSnapshot(q.questionId);
    if (existing) {
      return [{ kind: 'publish_snapshot', questionId: q.questionId, accountId: null, sent: false, reason: 'snapshot-already-frozen', error: null }];
    }
    // Match every private forecast against its chain commitment.
    const chainCommitments = await this.chain.listCommitments(q.questionId, 0, 64);
    const bigEntries: { accountId: string; probBps: number; stakeYocto: bigint }[] = [];
    for (const c of chainCommitments) {
      const f = this.store.getForecast(q.questionId, c.account_id);
      if (!f || f.commitmentHash !== c.hash) {
        return [{ kind: 'publish_snapshot', questionId: q.questionId, accountId: c.account_id, sent: false, reason: 'forecast-commitment-mismatch', error: null }];
      }
      bigEntries.push({ accountId: c.account_id, probBps: f.probBps, stakeYocto: f.stakeYocto });
    }
    if (bigEntries.length === 0) {
      return [{ kind: 'publish_snapshot', questionId: q.questionId, accountId: null, sent: false, reason: 'no-commitments', error: null }];
    }
    const aggregateBps = this.computeAggregateBps(bigEntries);
    const totalStakeYocto = bigEntries.reduce((s, e) => s + e.stakeYocto, 0n);
    const entries: SnapshotRecord['entries'] = bigEntries.map((e) => ({
      accountId: e.accountId,
      probBps: e.probBps,
      stakeYocto: e.stakeYocto.toString(),
    }));
    const snapshotId = this.snapshotIdFor(entries, q.questionId);
    const snapshot: SnapshotRecord = {
      questionId: q.questionId,
      snapshotId,
      aggregateBps,
      totalStakeYocto,
      participantCount: entries.length,
      entries,
    };
    this.store.saveSnapshot(snapshot);
    return [
      await this.runOnce(
        `publish_snapshot:${q.questionId}`,
        'publish_snapshot',
        q.questionId,
        null,
        { snapshotId },
        () => this.chain.publishSnapshot(q.questionId, snapshotId, this.config.operatorId).then((o) => ({ success: o.success, error: o.error })),
        async () => (await this.chain.getQuestion(q.questionId))?.snapshot_id === snapshotId,
      ),
    ];
  }

  private async resolvePhase(q: LocalQuestion): Promise<StepResult[]> {
    const now = this.nowNs();
    let outcome: boolean;
    try {
      outcome = await this.source.resolveOutcome(q);
    } catch (err) {
      if (now >= q.resolveDeadlineNs) {
        return [
          await this.runOnce(
            `cancel:${q.questionId}`,
            'cancel',
            q.questionId,
            null,
            { reason: 'timeout' },
            () => this.chain.cancel(q.questionId, this.config.operatorId).then((o) => ({ success: o.success, error: o.error })),
            async () => (await this.chain.getQuestion(q.questionId))?.phase === 'cancelled',
          ),
        ];
      }
      return [{ kind: 'resolve', questionId: q.questionId, accountId: null, sent: false, reason: 'outcome-unavailable', error: (err as Error).message }];
    }
    return [
      await this.runOnce(
        `resolve:${q.questionId}`,
        'resolve',
        q.questionId,
        null,
        { outcome },
        () => this.chain.resolve(q.questionId, outcome, this.config.resolverId).then((o) => ({ success: o.success, error: o.error })),
        async () => (await this.chain.getQuestion(q.questionId))?.outcome !== null,
      ),
    ];
  }

  private async revealPhase(q: LocalQuestion): Promise<StepResult[]> {
    const steps: StepResult[] = [];
    for (const p of q.participants) {
      const f = this.store.getForecast(q.questionId, p.accountId);
      if (!f) continue;
      const chainC = await this.chain.getCommitment(q.questionId, p.accountId);
      if (chainC && chainC.revealed !== null) continue;
      steps.push(
        await this.runOnce(
          `reveal:${q.questionId}:${p.accountId}`,
          'reveal',
          q.questionId,
          p.accountId,
          { probBps: f.probBps },
          () => this.chain.reveal(q.questionId, f.probBps, f.salt, p.accountId).then((o) => ({ success: o.success, error: o.error })),
          async () => (await this.chain.getCommitment(q.questionId, p.accountId))?.revealed === f.probBps,
        ),
      );
    }
    return steps;
  }

  private async withdrawForAccount(q: LocalQuestion, accountId: string): Promise<StepResult> {
    const balance = await this.chain.getBalance(accountId);
    const claimable = BigInt(balance.claimable);
    if (claimable <= 0n) {
      this.store.releaseReservation(accountId, q.questionId);
      return { kind: 'withdraw', questionId: q.questionId, accountId, sent: false, reason: 'nothing-claimable', error: null };
    }
    // Skip while an earlier request is still in flight (avoid double-withdraw).
    if (BigInt(balance.pending) > 0n) {
      return { kind: 'withdraw', questionId: q.questionId, accountId, sent: false, reason: 'pending-in-flight', error: null };
    }
    const amount = claimable;
    const attempt = this.store.nextWithdrawAttempt(accountId, amount);
    const dedupKey = `withdraw:${accountId}:${amount.toString()}:${attempt}`;
    return this.runOnce(
      dedupKey,
      'withdraw',
      q.questionId,
      accountId,
      { amount: amount.toString() },
      () => this.chain.withdraw(amount, accountId).then((o) => ({ success: o.success, error: o.error })),
      async () => BigInt((await this.chain.getBalance(accountId)).claimable) < amount,
    );
  }

  private async terminalWithdrawals(q: LocalQuestion): Promise<StepResult[]> {
    const steps: StepResult[] = [];
    for (const p of q.participants) {
      steps.push(await this.withdrawForAccount(q, p.accountId));
    }
    return steps;
  }

  // -------------------------------------------------------------------------
  // Public orchestration
  // -------------------------------------------------------------------------

  /** Advance one locally-tracked question through its current lifecycle step. */
  async advance(q: LocalQuestion): Promise<StepResult[]> {
    const chainQuestion = await this.chain.getQuestion(q.questionId);
    if (!chainQuestion) {
      return [{ kind: 'advance', questionId: q.questionId, accountId: null, sent: false, reason: 'not-on-chain', error: null }];
    }
    const now = this.nowNs();
    switch (chainQuestion.phase) {
      case 'open':
        return this.commitPhase(q);
      case 'closed': {
        const steps: StepResult[] = [];
        // Freeze snapshot first, then resolve (or cancel on timeout).
        if (!chainQuestion.snapshot_ready) {
          const freeze = await this.freezeSnapshot(q);
          steps.push(...freeze);
          const blocked =
            freeze.some((s) => s.reason === 'forecast-commitment-mismatch') ||
            freeze.some((s) => s.reason === 'no-commitments');
          if (blocked) {
            if (now >= q.resolveDeadlineNs) {
              steps.push(
                await this.runOnce(
                  `cancel:${q.questionId}`,
                  'cancel',
                  q.questionId,
                  null,
                  { reason: 'no-outcome' },
                  () => this.chain.cancel(q.questionId, this.config.operatorId).then((o) => ({ success: o.success, error: o.error })),
                  async () => (await this.chain.getQuestion(q.questionId))?.phase === 'cancelled',
                ),
              );
            }
            return steps;
          }
        }
        steps.push(...(await this.resolvePhase(q)));
        return steps;
      }
      case 'resolved':
        return this.revealPhase(q);
      case 'settled':
      case 'cancelled':
        return this.terminalWithdrawals(q);
      default:
        return [];
    }
  }

  /** One pass over all locally-tracked questions. */
  async tick(): Promise<TickReport> {
    const steps: StepResult[] = [];
    const questions = this.store.listQuestions();
    for (const q of questions) {
      steps.push(...(await this.advance(q)));
    }
    return { steps };
  }

  /**
   * Operator action: create a Question on-chain and persist it locally.
   * `targetKey` is a stable identity (see schedule.ts target keys).
   */
  async createQuestion(params: {
    domain: Domain;
    text: string;
    eventDefinition: string;
    sourceJson: string;
    sourceLabel: string;
    targetKey: string;
    openTimeNs: bigint;
    closeTimeNs: bigint;
    observationStartNs: bigint;
    observationEndNs: bigint;
    resolveTimeNs: bigint;
    resolveDeadlineNs: bigint;
    revealWindowNs: bigint;
  }): Promise<{ questionId: number | null; alreadyExists: boolean; error: string | null }> {
    const existingLocal = this.store.getQuestionByTargetKey(params.targetKey);
    if (existingLocal) {
      return { questionId: existingLocal.questionId, alreadyExists: true, error: null };
    }
    const participants = this.participantsFor(params.domain);
    const outcome = await this.chain.createQuestion(
      {
        text: params.text,
        event_definition: params.eventDefinition,
        source: params.sourceJson,
        resolver: this.config.resolverId,
        open_time: params.openTimeNs.toString(),
        close_time: params.closeTimeNs.toString(),
        observation_start: params.observationStartNs.toString(),
        observation_end: params.observationEndNs.toString(),
        resolve_time: params.resolveTimeNs.toString(),
        resolve_deadline: params.resolveDeadlineNs.toString(),
        reveal_window: params.revealWindowNs.toString(),
        access_price: this.config.accessPriceYocto.toString(),
        min_stake: this.config.minStakeYocto.toString(),
      },
      this.config.operatorId,
    );
    if (!outcome.success || typeof outcome.result !== 'number') {
      return { questionId: null, alreadyExists: false, error: outcome.error ?? 'create_question returned no id' };
    }
    const questionId = outcome.result as number;
    const local: LocalQuestion = {
      questionId,
      domain: params.domain,
      text: params.text,
      eventDefinition: params.eventDefinition,
      sourceJson: params.sourceJson,
      sourceLabel: params.sourceLabel,
      resolver: this.config.resolverId,
      openTimeNs: params.openTimeNs,
      closeTimeNs: params.closeTimeNs,
      observationStartNs: params.observationStartNs,
      observationEndNs: params.observationEndNs,
      resolveTimeNs: params.resolveTimeNs,
      resolveDeadlineNs: params.resolveDeadlineNs,
      revealWindowNs: params.revealWindowNs,
      accessPrice: this.config.accessPriceYocto,
      minStake: this.config.minStakeYocto,
      participants,
    };
    this.store.saveQuestion(local, params.targetKey);
    return { questionId, alreadyExists: false, error: null };
  }
}
