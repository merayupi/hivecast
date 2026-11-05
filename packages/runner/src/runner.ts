/**
 * Runner — autonomous lifecycle orchestration over the real NEAR ChainClient
 * and a private Store. All secrets (forecasts, salts) are persisted BEFORE the
 * commit transaction is sent; the transaction journal makes every send
 * idempotent so a restart never duplicates a send or regenerates a secret.
 *
 * Lifecycle per Question (driven by the chain's own phase, which is
 * time-derived):
 *   open      → run strategies, persist forecast+salt, reserve capital, commit
 *   closed    → freeze the immutable Forecast Snapshot (best-effort SALE), then
 *               resolve independently (or cancel: immediately on zero commits,
 *               or at resolve_deadline on a missing outcome)
 *   resolved  → reveal each participant's forecast with its persisted salt
 *   settled   → withdraw each agent's claimable balance
 *   cancelled → withdraw each agent's refunded stake (no scoring)
 */

import { createHash, randomBytes } from 'node:crypto';
import { getStrategy, supportsDomain } from '@hivecast/core';
import type { AgentId, Domain, StrategyContext, StrategyInputs } from '@hivecast/core';
import { commitmentHash, generateSalt } from './commitment.js';
import type { ChainClient, CallOutcome } from './chain/types.js';
import type { RunnerConfig } from './config.js';
import {
  nsToMs,
  parseSourceSpec,
  priceTargetLabel,
  weatherTargetLabel,
  wibDateOfUtcMs,
} from './schedule.js';
import {
  fetchCompletedCandles,
  fetchPriceResolution,
  fetchWeatherForecast,
  fetchWeatherHistoryDay,
  fetchWeatherResolution,
  type FetchBases,
  type Evidence,
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

export interface StrategyInputResult {
  inputs: StrategyInputs;
  disclosure: string;
}

export interface ResolutionResult {
  outcome: boolean;
  evidenceJson: string;
  evidenceHash: string;
}

/** Point-in-time strategy inputs and resolution outcomes, by Question. */
export interface SourceProvider {
  strategyInputs(q: LocalQuestion): Promise<StrategyInputResult>;
  resolveOutcome(q: LocalQuestion): Promise<ResolutionResult>;
}

const STAKE_FLOOR_DENOM = 10n; // 10% of available balance
const PRICE_LOOKBACK_CANDLES = 48;
const WEATHER_HISTORY_DAYS = 30;

/** Real source provider: completed candles / forecast runs / archive resolution. */
export class LiveSourceProvider implements SourceProvider {
  constructor(private config: RunnerConfig) {}

  private bases(): FetchBases {
    return {
      binanceBaseUrl: this.config.binanceBaseUrl,
      openMeteoBaseUrl: this.config.openMeteoBaseUrl,
      archiveBaseUrl: this.config.archiveBaseUrl,
    };
  }

  async strategyInputs(q: LocalQuestion): Promise<StrategyInputResult> {
    const spec = parseSourceSpec(q.sourceJson);
    const bases = this.bases();
    if (spec.kind === 'price') {
      const cutoffMs = nsToMs(q.closeTimeNs);
      const { candles, evidence } = await fetchCompletedCandles(bases, spec, cutoffMs, PRICE_LOOKBACK_CANDLES);
      return {
        inputs: { kind: 'price', candles },
        disclosure: JSON.stringify(evidence),
      };
    }
    const targetDate = wibDateOfUtcMs(nsToMs(q.observationStartNs));
    const { forecastPrecipMm, evidence } = await fetchWeatherForecast(bases, spec, targetDate);
    const historyPrecipMm: string[] = [];
    const missing: string[] = [];
    // History = past WIB days whose observation window FULLY ended before the
    // commitment cutoff. The most recent completed day is the day before the
    // target day's predecessor (target D, cutoff D-1 23:55 WIB, so D-1 has not
    // ended yet); therefore start at i=2 (D-2 and older), never the still-open
    // local day.
    for (let i = 2; i <= WEATHER_HISTORY_DAYS + 1; i++) {
      const d = new Date(nsToMs(q.observationStartNs) - i * 86_400_000);
      const date = wibDateOfUtcMs(d.getTime());
      try {
        const res = await fetchWeatherHistoryDay(bases, spec, date);
        historyPrecipMm.push(res.precipitationMm);
      } catch {
        // Do not silently drop the gap: record it in the disclosure.
        missing.push(date);
      }
    }
    historyPrecipMm.reverse();
    return {
      inputs: { kind: 'weather', forecastPrecipMm, historyPrecipMm },
      disclosure: JSON.stringify({ forecast: evidence, missingHistoryDays: missing, excludedIncompleteDay: true }),
    };
  }

  async resolveOutcome(q: LocalQuestion): Promise<ResolutionResult> {
    const spec = parseSourceSpec(q.sourceJson);
    const bases = this.bases();
    if (spec.kind === 'price') {
      const res = await fetchPriceResolution(bases, spec, nsToMs(q.observationStartNs), nsToMs(this.nowNs()));
      return { outcome: res.outcome, evidenceJson: JSON.stringify(res.evidence), evidenceHash: res.evidence.hash };
    }
    const res = await fetchWeatherResolution(bases, spec, wibDateOfUtcMs(nsToMs(q.observationStartNs)));
    return { outcome: res.outcome, evidenceJson: JSON.stringify(res.evidence), evidenceHash: res.evidence.hash };
  }

  private nowNs(): bigint {
    return BigInt(Date.now()) * 1_000_000n;
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
    const order = ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip'] as AgentId[];
    return order.filter((id) => supportsDomain(id, domain)).map((id) => ({ agentId: id, accountId: this.agentAccount(id) }));
  }

  private strategyContext(q: LocalQuestion, agentId: AgentId, inputs: StrategyInputs): StrategyContext {
    const targetTime =
      q.domain === 'price'
        ? priceTargetLabel(nsToMs(q.observationStartNs))
        : weatherTargetLabel(wibDateOfUtcMs(nsToMs(q.observationStartNs)));
    return { agentId, domain: q.domain, targetTime, roundKey: `${q.domain}:${q.questionId}`, inputs, seed: this.config.seed };
  }

  // -------------------------------------------------------------------------
  // Capital sizing
  // -------------------------------------------------------------------------

  /**
   * Available balance for a new stake = native − outstanding (unconfirmed)
   * reservations − gas. Confirmed commitments release their reservation (the
   * deposit already left the wallet), so they are NOT double-debited.
   */
  private async availableForStake(accountId: string): Promise<bigint> {
    const native = await this.chain.viewAccountBalance(accountId);
    const reserved = this.store.totalReserved(accountId);
    const available = native - reserved - this.config.operationalGasReserveYocto;
    return available < 0n ? 0n : available;
  }

  // -------------------------------------------------------------------------
  // Journal helper (durable intent → broadcast → reconcile)
  // -------------------------------------------------------------------------

  private async runOnce(
    dedupKey: string,
    kind: JournalKind,
    questionId: number | null,
    accountId: string | null,
    payload: unknown,
    send: () => Promise<{ outcome: CallOutcome }>,
    verify: () => Promise<boolean>,
  ): Promise<StepResult> {
    // Persist intent BEFORE broadcast.
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
    // Reconcile any pending/submitted entry against the chain before resending.
    const existing = this.store.getJournal(dedupKey);
    if (existing && (existing.status === 'pending' || existing.status === 'submitted')) {
      if (await verify()) {
        this.store.markConfirmed(dedupKey);
        return { kind, questionId, accountId, sent: false, reason: 'reconciled', error: null };
      }
    }
    const { outcome } = await send();
    if (outcome.success) {
      if (outcome.txHash) this.store.markSubmitted(dedupKey, outcome.txHash);
      this.store.markConfirmed(dedupKey);
      return { kind, questionId, accountId, sent: true, reason: 'sent', error: null };
    }
    if (outcome.txHash) {
      // Included but unproven execution: record the hash so a restart
      // reconciles by re-verifying against the chain before any resend.
      this.store.markSubmitted(dedupKey, outcome.txHash);
      return { kind, questionId, accountId, sent: false, reason: 'submitted-unconfirmed', error: outcome.error };
    }
    this.store.markFailed(dedupKey, outcome.error ?? 'unknown error');
    return { kind, questionId, accountId, sent: false, reason: 'failed', error: outcome.error };
  }

  // -------------------------------------------------------------------------
  // Lifecycle steps
  // -------------------------------------------------------------------------

  private async commitAgent(q: LocalQuestion, agentId: AgentId, accountId: string, inputs: StrategyInputs | null): Promise<StepResult> {
    const dedupKey = `commit:${q.questionId}:${accountId}`;
    const verify = async () => {
      const c = await this.chain.getCommitment(q.questionId, accountId);
      const f = this.store.getForecast(q.questionId, accountId);
      return c !== null && f !== null && c.hash === f.commitmentHash;
    };
    // Reuse the persisted forecast/stake BEFORE rerunning strategy or sizing.
    let forecast = this.store.getForecast(q.questionId, accountId);
    if (!forecast) {
      if (inputs === null) {
        // No durable forecast and no available source: cannot commit now.
        return { kind: 'commit', questionId: q.questionId, accountId, sent: false, reason: 'inputs-unavailable', error: null };
      }
      const result = getStrategy(agentId)(this.strategyContext(q, agentId, inputs));
      if (result.kind === 'abstain') {
        return { kind: 'commit', questionId: q.questionId, accountId, sent: false, reason: `abstain:${result.reason}`, error: null };
      }
      const available = await this.availableForStake(accountId);
      const stake = available / STAKE_FLOOR_DENOM;
      if (stake < this.config.minStakeYocto) {
        return { kind: 'commit', questionId: q.questionId, accountId, sent: false, reason: 'below-minimum-stake', error: null };
      }
      const salt = generateSalt();
      forecast = {
        questionId: q.questionId,
        agentId,
        accountId,
        probBps: result.probabilityBps,
        salt,
        stakeYocto: stake,
        commitmentHash: commitmentHash({
          contractId: this.chain.contractId,
          questionId: q.questionId,
          accountId,
          stakeYocto: stake,
          probBps: result.probabilityBps,
          salt,
        }),
      };
      this.store.saveForecast(forecast);
      this.store.reserve(accountId, q.questionId, forecast.stakeYocto);
    }
    const step = await this.runOnce(
      dedupKey,
      'commit',
      q.questionId,
      accountId,
      { probBps: forecast.probBps, stake: forecast.stakeYocto.toString() },
      async () => ({ outcome: await this.chain.commit(q.questionId, forecast!.commitmentHash, forecast!.stakeYocto, accountId) }),
      verify,
    );
    // On confirmed commit the deposit has left the wallet: release reservation.
    if (step.sent || step.reason === 'reconciled' || step.reason === 'already-confirmed') {
      this.store.releaseReservation(accountId, q.questionId);
    }
    return step;
  }

  private async commitPhase(q: LocalQuestion): Promise<StepResult[]> {
    // Determine which participants still lack a durable forecast. Source is
    // fetched only when at least one participant needs it, so durable forecasts
    // remain sendable even if the external source is currently unavailable,
    // and the 30-day weather history is not re-fetched every tick.
    const missing: { agentId: AgentId; accountId: string }[] = [];
    for (const p of q.participants) {
      if (!this.store.getForecast(q.questionId, p.accountId)) missing.push(p);
    }
    let inputs: StrategyInputs | null = null;
    if (missing.length > 0) {
      try {
        const inputsResult = await this.source.strategyInputs(q);
        // Persist input evidence (disclosure of availability + missing history).
        this.store.saveEvidence(q.questionId, 'input', inputsResult.disclosure, createHash('sha256').update(inputsResult.disclosure).digest('hex'));
        inputs = inputsResult.inputs;
      } catch (err) {
        // If NO participant has a durable forecast, we cannot commit at all.
        if (missing.length === q.participants.length) {
          return [{ kind: 'commit', questionId: q.questionId, accountId: null, sent: false, reason: 'inputs-unavailable', error: (err as Error).message }];
        }
        // Otherwise proceed: participants with durable forecasts still send.
      }
    }
    const steps: StepResult[] = [];
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
    return Number((num + denom / 2n) / denom);
  }

  /** Freeze an immutable snapshot; publication is idempotent and retried. */
  private async freezeSnapshot(q: LocalQuestion): Promise<StepResult[]> {
    // Reuse the frozen snapshot if present; never regenerate its id/entries.
    let snapshot = this.store.getSnapshot(q.questionId);
    if (!snapshot) {
      const chainCommitments = await this.chain.listCommitments(q.questionId, 0, 64);
      const bigEntries: { accountId: string; probBps: number; stakeYocto: bigint }[] = [];
      for (const c of chainCommitments) {
        const f = this.store.getForecast(q.questionId, c.account_id);
        if (!f || f.commitmentHash !== c.hash) {
          // Missing/mismatched private forecast blocks SALE only, not the Round.
          return [{ kind: 'publish_snapshot', questionId: q.questionId, accountId: c.account_id, sent: false, reason: 'forecast-commitment-mismatch', error: null }];
        }
        bigEntries.push({ accountId: c.account_id, probBps: f.probBps, stakeYocto: f.stakeYocto });
      }
      if (bigEntries.length === 0) {
        return [{ kind: 'publish_snapshot', questionId: q.questionId, accountId: null, sent: false, reason: 'no-commitments', error: null }];
      }
      const aggregateBps = this.computeAggregateBps(bigEntries);
      const totalStakeYocto = bigEntries.reduce((s, e) => s + e.stakeYocto, 0n);
      const entries: SnapshotRecord['entries'] = bigEntries.map((e) => ({ accountId: e.accountId, probBps: e.probBps, stakeYocto: e.stakeYocto.toString() }));
      snapshot = {
        questionId: q.questionId,
        snapshotId: randomBytes(16).toString('hex'), // independent CSPRNG id, persisted once
        aggregateBps,
        totalStakeYocto,
        participantCount: entries.length,
        entries,
      };
      this.store.saveSnapshot(snapshot);
    }
    // Retry publication until the chain confirms this snapshot id.
    return [
      await this.runOnce(
        `publish_snapshot:${q.questionId}`,
        'publish_snapshot',
        q.questionId,
        null,
        { snapshotId: snapshot.snapshotId },
        async () => ({ outcome: await this.chain.publishSnapshot(q.questionId, snapshot!.snapshotId, this.config.operatorId) }),
        async () => (await this.chain.getQuestion(q.questionId))?.snapshot_id === snapshot!.snapshotId,
      ),
    ];
  }

  private async resolvePhase(q: LocalQuestion): Promise<StepResult[]> {
    const now = this.nowNs();
    let resolution: ResolutionResult;
    try {
      resolution = await this.source.resolveOutcome(q);
    } catch (err) {
      if (now >= q.resolveDeadlineNs) {
        return [
          await this.runOnce(
            `cancel:${q.questionId}`,
            'cancel',
            q.questionId,
            null,
            { reason: 'timeout' },
            async () => ({ outcome: await this.chain.cancel(q.questionId, this.config.operatorId) }),
            async () => (await this.chain.getQuestion(q.questionId))?.phase === 'cancelled',
          ),
        ];
      }
      return [{ kind: 'resolve', questionId: q.questionId, accountId: null, sent: false, reason: 'outcome-unavailable', error: (err as Error).message }];
    }
    // Persist exact resolution evidence before posting the outcome.
    this.store.saveEvidence(q.questionId, 'resolve', resolution.evidenceJson, resolution.evidenceHash);
    return [
      await this.runOnce(
        `resolve:${q.questionId}`,
        'resolve',
        q.questionId,
        null,
        { outcome: resolution.outcome },
        async () => ({ outcome: await this.chain.resolve(q.questionId, resolution.outcome, this.config.resolverId) }),
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
          async () => ({ outcome: await this.chain.reveal(q.questionId, f.probBps, f.salt, p.accountId) }),
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
      return { kind: 'withdraw', questionId: q.questionId, accountId, sent: false, reason: 'nothing-claimable', error: null };
    }
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
      async () => ({ outcome: await this.chain.withdraw(amount, accountId) }),
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

  async advance(q: LocalQuestion): Promise<StepResult[]> {
    const chainQuestion = await this.chain.getQuestion(q.questionId);
    if (!chainQuestion) {
      return [{ kind: 'advance', questionId: q.questionId, accountId: null, sent: false, reason: 'not-on-chain', error: null }];
    }
    switch (chainQuestion.phase) {
      case 'open':
        return this.commitPhase(q);
      case 'closed': {
        const steps: StepResult[] = [];
        const commits = await this.chain.listCommitments(q.questionId, 0, 64);
        // Zero commitments → cancel immediately at close (no waiting).
        if (commits.length === 0) {
          steps.push(
            await this.runOnce(
              `cancel:${q.questionId}`,
              'cancel',
              q.questionId,
              null,
              { reason: 'zero-commitments' },
              async () => ({ outcome: await this.chain.cancel(q.questionId, this.config.operatorId) }),
              async () => (await this.chain.getQuestion(q.questionId))?.phase === 'cancelled',
            ),
          );
          return steps;
        }
        // Best-effort snapshot publication (SALE) — never blocks resolution.
        if (!chainQuestion.snapshot_ready) {
          steps.push(...(await this.freezeSnapshot(q)));
        }
        // Resolution is independent of snapshot readiness.
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

  /** Reconcile any create_question intents whose broadcast crashed before local save. */
  private async reconcileCreates(): Promise<void> {
    const entries = this.store.listJournal('create_question').filter((j) => j.status === 'pending' || j.status === 'submitted');
    for (const e of entries) {
      const payload = JSON.parse(e.payloadJson) as { observation_start?: string };
      const obsStart = payload.observation_start;
      if (!obsStart) continue;
      const questions = await this.chain.listQuestions(0, 100);
      const match = questions.find((q) => q.observation_start === obsStart);
      if (match) {
        this.store.markConfirmed(e.dedupKey);
      }
    }
  }

  /** One pass over all locally-tracked questions. */
  async tick(): Promise<TickReport> {
    await this.reconcileCreates();
    const steps: StepResult[] = [];
    const questions = this.store.listQuestions();
    for (const q of questions) {
      steps.push(...(await this.advance(q)));
    }
    return { steps };
  }

  /**
   * Operator action: create a Question on-chain and persist it locally.
   * The intent is journaled (keyed by targetKey) BEFORE broadcast so a restart
   * never double-creates; reconciliation is by durable targetKey + pinned
   * on-chain observation_start.
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
    const dedupKey = `create_question:${params.targetKey}`;
    const intent = this.store.upsertJournal({
      dedupKey,
      kind: 'create_question',
      questionId: null,
      accountId: this.config.operatorId,
      payloadJson: JSON.stringify({ observation_start: params.observationStartNs.toString() }),
    });
    if (intent.alreadyConfirmed) {
      // Recovered on a prior run but local row missing: rebuild from chain.
      const questions = await this.chain.listQuestions(0, 100);
      const match = questions.find((qq) => qq.observation_start === params.observationStartNs.toString());
      if (match) {
        const local = this.toLocalQuestion(match.question_id, params, participants);
        this.store.saveQuestion(local, params.targetKey);
        return { questionId: match.question_id, alreadyExists: true, error: null };
      }
      return { questionId: null, alreadyExists: false, error: 'create_question marked confirmed but question not found on chain' };
    }
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
    if (outcome.success && typeof outcome.result === 'number') {
      if (outcome.txHash) this.store.markSubmitted(dedupKey, outcome.txHash);
      this.store.markConfirmed(dedupKey);
      const questionId = outcome.result as number;
      const local = this.toLocalQuestion(questionId, params, participants);
      this.store.saveQuestion(local, params.targetKey);
      return { questionId, alreadyExists: false, error: null };
    }
    if (outcome.txHash) {
      this.store.markSubmitted(dedupKey, outcome.txHash);
    } else {
      this.store.markFailed(dedupKey, outcome.error ?? 'create_question failed');
    }
    return { questionId: null, alreadyExists: false, error: outcome.error ?? 'create_question returned no id' };
  }

  private toLocalQuestion(
    questionId: number,
    params: { domain: Domain; text: string; eventDefinition: string; sourceJson: string; sourceLabel: string; openTimeNs: bigint; closeTimeNs: bigint; observationStartNs: bigint; observationEndNs: bigint; resolveTimeNs: bigint; resolveDeadlineNs: bigint; revealWindowNs: bigint },
    participants: { agentId: AgentId; accountId: string }[],
  ): LocalQuestion {
    return {
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
  }
}
