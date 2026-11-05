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
import type { ChainClient } from './chain/types.js';
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
} from './source.js';
import type { Store } from './store.js';
import type { ForecastRecord, JournalKind, LocalQuestion, QuestionView, SnapshotRecord } from './types.js';

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

/** Immutable operator create-question spec, persisted in full BEFORE broadcast. */
export interface CreateQuestionSpec {
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
}

/**
 * Grace past the latest possible reveal deadline after which a Question needs
 * no more per-question runner phase work (commit/freeze/resolve/reveal/settle).
 * Withdrawal is account-scoped and handled globally, so historical Rounds are
 * never re-walked. Default price life ≈ open(15m)+obs(1h)+resolve/reveal(30m);
 * 6h grace covers settle retries and daemon restarts while keeping the per-tick
 * horizon bounded to a handful of Rounds.
 */
const LIFECYCLE_GRACE_NS = 6n * 3_600n * 1_000_000_000n;

function serializeCreateSpec(spec: CreateQuestionSpec): string {
  return JSON.stringify({
    domain: spec.domain,
    text: spec.text,
    eventDefinition: spec.eventDefinition,
    sourceJson: spec.sourceJson,
    sourceLabel: spec.sourceLabel,
    targetKey: spec.targetKey,
    openTimeNs: spec.openTimeNs.toString(),
    closeTimeNs: spec.closeTimeNs.toString(),
    observationStartNs: spec.observationStartNs.toString(),
    observationEndNs: spec.observationEndNs.toString(),
    resolveTimeNs: spec.resolveTimeNs.toString(),
    resolveDeadlineNs: spec.resolveDeadlineNs.toString(),
    revealWindowNs: spec.revealWindowNs.toString(),
  });
}

function deserializeCreateSpec(json: string): CreateQuestionSpec {
  const r = JSON.parse(json) as Record<string, unknown>;
  return {
    domain: r.domain as Domain,
    text: r.text as string,
    eventDefinition: r.eventDefinition as string,
    sourceJson: r.sourceJson as string,
    sourceLabel: r.sourceLabel as string,
    targetKey: r.targetKey as string,
    openTimeNs: BigInt(r.openTimeNs as string),
    closeTimeNs: BigInt(r.closeTimeNs as string),
    observationStartNs: BigInt(r.observationStartNs as string),
    observationEndNs: BigInt(r.observationEndNs as string),
    resolveTimeNs: BigInt(r.resolveTimeNs as string),
    resolveDeadlineNs: BigInt(r.resolveDeadlineNs as string),
    revealWindowNs: BigInt(r.revealWindowNs as string),
  };
}

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
    action: () => { methodName: string; args: Record<string, unknown>; signer: string; deposit: bigint; gas?: bigint },
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
      this.store.deleteSignedTx(dedupKey);
      return { kind, questionId, accountId, sent: false, reason: 'already-confirmed', error: null };
    }

    // Reconcile a previously prepared/submitted transaction against the chain
    // BEFORE any new broadcast. While the outcome is uncertain, we rebroadcast
    // the SAME signed transaction (same nonce/signature), never re-sign.
    const signed = this.store.getSignedTx(dedupKey);
    if (signed) {
      if (await verify()) {
        this.store.markConfirmed(dedupKey);
        this.store.deleteSignedTx(dedupKey);
        return { kind, questionId, accountId, sent: false, reason: 'reconciled', error: null };
      }
      const outcome = await this.chain.broadcastCall(signed.signedBytesBase64);
      if (outcome.status === 'success') {
        this.store.markConfirmed(dedupKey);
        this.store.deleteSignedTx(dedupKey);
        return { kind, questionId, accountId, sent: true, reason: 'rebroadcast-sent', error: null };
      }
      if (outcome.status === 'failure') {
        // Definitively rejected/failed: it did not apply, so a fresh attempt is
        // safe after this is cleared.
        this.store.markFailed(dedupKey, outcome.error ?? 'unknown error');
        this.store.deleteSignedTx(dedupKey);
        return { kind, questionId, accountId, sent: false, reason: 'failed', error: outcome.error };
      }
      // Uncertain: keep the signed tx for the next reconcile; do NOT re-sign.
      if (outcome.txHash) this.store.markSubmitted(dedupKey, outcome.txHash);
      return { kind, questionId, accountId, sent: false, reason: 'rebroadcast-uncertain', error: outcome.error };
    }

    // No persisted signed tx: still reconcile a legacy 'submitted' entry.
    const existing = this.store.getJournal(dedupKey);
    if (existing && existing.status === 'submitted') {
      if (await verify()) {
        this.store.markConfirmed(dedupKey);
        return { kind, questionId, accountId, sent: false, reason: 'reconciled', error: null };
      }
    }

    // Fresh attempt: prepare the signed tx, persist it, THEN broadcast.
    const a = action();
    const prepared = await this.chain.prepareCall(a.methodName, a.args, a.signer, a.deposit, a.gas);
    this.store.saveSignedTx(dedupKey, prepared.signedBytesBase64, prepared.txHash, prepared.nonce);
    this.store.markSubmitted(dedupKey, prepared.txHash);
    const outcome = await this.chain.broadcastCall(prepared.signedBytesBase64);
    if (outcome.status === 'success') {
      this.store.markConfirmed(dedupKey);
      this.store.deleteSignedTx(dedupKey);
      return { kind, questionId, accountId, sent: true, reason: 'sent', error: null };
    }
    if (outcome.status === 'failure') {
      this.store.markFailed(dedupKey, outcome.error ?? 'unknown error');
      this.store.deleteSignedTx(dedupKey);
      return { kind, questionId, accountId, sent: false, reason: 'failed', error: outcome.error };
    }
    // Uncertain: keep the signed tx so the next reconcile rebroadcasts it.
    return { kind, questionId, accountId, sent: false, reason: 'submitted-unconfirmed', error: outcome.error };
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
      () => ({
        methodName: 'commit',
        args: { question_id: q.questionId, hash: forecast!.commitmentHash },
        signer: accountId,
        deposit: forecast!.stakeYocto,
      }),
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
        () => ({
          methodName: 'publish_snapshot',
          args: { question_id: q.questionId, snapshot_id: snapshot!.snapshotId },
          signer: this.config.operatorId,
          deposit: 0n,
        }),
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
            () => ({
              methodName: 'cancel',
              args: { question_id: q.questionId },
              signer: this.config.operatorId,
              deposit: 0n,
            }),
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
        () => ({
          methodName: 'resolve',
          args: { question_id: q.questionId, outcome: resolution.outcome },
          signer: this.config.resolverId,
          deposit: 0n,
        }),
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
          () => ({
            methodName: 'reveal',
            args: { question_id: q.questionId, prob_bps: f.probBps, salt: f.salt },
            signer: p.accountId,
            deposit: 0n,
          }),
          async () => (await this.chain.getCommitment(q.questionId, p.accountId))?.revealed === f.probBps,
        ),
      );
    }
    return steps;
  }

  private async withdrawAccount(accountId: string): Promise<StepResult | null> {
    const balance = await this.chain.getBalance(accountId);
    const claimable = BigInt(balance.claimable);
    if (claimable <= 0n) return null;
    if (BigInt(balance.pending) > 0n) return null; // in-flight; wait for callback
    const amount = claimable;
    const attempt = this.store.nextWithdrawAttempt(accountId, amount);
    const dedupKey = `withdraw:${accountId}:${amount.toString()}:${attempt}`;
    return this.runOnce(
      dedupKey,
      'withdraw',
      null,
      accountId,
      { amount: amount.toString() },
      () => ({
        methodName: 'withdraw',
        args: { amount: amount.toString() },
        signer: accountId,
        deposit: 0n,
      }),
      async () => BigInt((await this.chain.getBalance(accountId)).claimable) < amount,
    );
  }

  /**
   * Global bounded withdrawal sweep: poll the 8 agent accounts once per tick
   * (not one full ledger walk per historical Round). Claimable balance is
   * account-scoped in the contract, so this drains every settled/cancelled
   * Round's entitlement without revisiting each Round.
   */
  private async withdrawAllAgents(): Promise<StepResult[]> {
    const steps: StepResult[] = [];
    const seen = new Set<string>();
    for (const id of Object.keys(this.config.agentAccounts) as AgentId[]) {
      const accountId = this.config.agentAccounts[id];
      if (seen.has(accountId)) continue;
      seen.add(accountId);
      const step = await this.withdrawAccount(accountId);
      if (step) steps.push(step);
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
      case 'open': {
        // The contract reports `open` for a scheduled Question too (before
        // open_time). Do not fetch source or sign until the window actually
        // opens, or the daemon would burn agent gas committing too early.
        if (now < q.openTimeNs) {
          return [{ kind: 'commit', questionId: q.questionId, accountId: null, sent: false, reason: 'not-open-yet', error: null }];
        }
        return this.commitPhase(q);
      }
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
              () => ({
                methodName: 'cancel',
                args: { question_id: q.questionId },
                signer: this.config.operatorId,
                deposit: 0n,
              }),
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
      case 'resolved': {
        const steps: StepResult[] = [];
        steps.push(...(await this.revealPhase(q)));
        // Settle once the reveal deadline has passed (permissionless).
        const revealDeadline = chainQuestion.reveal_deadline;
        if (revealDeadline !== null && now >= BigInt(revealDeadline)) {
          steps.push(
            await this.runOnce(
              `settle:${q.questionId}`,
              'settle',
              q.questionId,
              null,
              {},
              () => ({
                methodName: 'settle',
                args: { question_id: q.questionId },
                signer: this.config.operatorId,
                deposit: 0n,
              }),
              async () => (await this.chain.getQuestion(q.questionId))?.phase === 'settled',
            ),
          );
        }
        return steps;
      }
      case 'settled':
      case 'cancelled':
        // Claimable balances are drained by the global account sweep, not here.
        return [];
      default:
        return [];
    }
  }

  /** Walk the full (paginated) on-chain question list. */
  private async listAllChainQuestions(): Promise<QuestionView[]> {
    const out: QuestionView[] = [];
    const pageSize = 100;
    for (let from = 0; ; from += pageSize) {
      const page = await this.chain.listQuestions(from, pageSize);
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  }

  /** Exact on-chain match for a create spec (domain/source + observation window). */
  private matchesSpec(q: QuestionView, spec: CreateQuestionSpec): boolean {
    return (
      q.source === spec.sourceJson &&
      q.observation_start === spec.observationStartNs.toString() &&
      q.observation_end === spec.observationEndNs.toString()
    );
  }

  /** Reconcile create_question intents against the FULL paginated chain history. */
  private async reconcileCreates(): Promise<void> {
    const entries = this.store
      .listJournal('create_question')
      .filter((j) => j.status === 'pending' || j.status === 'submitted' || j.status === 'failed');
    if (entries.length === 0) return;

    // Fetch the full history once, then resolve every pending/submitted/failed
    // intent by exact domain/source/spec match (not just time).
    const all = await this.listAllChainQuestions();
    for (const e of entries) {
      let spec: CreateQuestionSpec;
      try {
        spec = deserializeCreateSpec(e.payloadJson);
      } catch {
        continue; // malformed legacy intent; leave untouched
      }
      const match = all.find((q) => this.matchesSpec(q, spec));
      if (!match) continue;
      // Recover the local record AND the question id, then confirm.
      const participants = this.participantsFor(spec.domain);
      this.store.saveQuestion(this.toLocalQuestion(match.question_id, spec, participants), spec.targetKey);
      this.store.markConfirmed(e.dedupKey);
      this.store.deleteSignedTx(e.dedupKey);
    }
  }

  /** One pass: reconcile creates, advance active rounds, drain global balances. */
  async tick(): Promise<TickReport> {
    await this.reconcileCreates();
    const steps: StepResult[] = [];
    const now = this.nowNs();
    for (const q of this.store.listQuestions()) {
      // Historical (durable-finalized) Rounds are inactive: skip anything whose
      // last possible reveal/settle deadline has passed. Withdrawal is global.
      if (now >= q.resolveDeadlineNs + q.revealWindowNs + LIFECYCLE_GRACE_NS) continue;
      steps.push(...(await this.advance(q)));
    }
    steps.push(...(await this.withdrawAllAgents()));
    return { steps };
  }

  /**
   * Operator action: create a Question on-chain and persist it locally.
   * The full immutable spec is journaled (keyed by targetKey) BEFORE broadcast
   * so a restart never double-creates; the prepared signed transaction is
   * persisted before broadcast and rebroadcast-same-signed-tx while uncertain.
   */
  async createQuestion(
    params: CreateQuestionSpec,
  ): Promise<{ questionId: number | null; alreadyExists: boolean; error: string | null }> {
    const existingLocal = this.store.getQuestionByTargetKey(params.targetKey);
    if (existingLocal) {
      return { questionId: existingLocal.questionId, alreadyExists: true, error: null };
    }
    const participants = this.participantsFor(params.domain);
    const dedupKey = `create_question:${params.targetKey}`;

    // If a previous broadcast is already on-chain (full spec match), recover the
    // local record before doing anything else.
    const all = await this.listAllChainQuestions();
    const onChain = all.find((q) => this.matchesSpec(q, params));
    if (onChain) {
      const local = this.toLocalQuestion(onChain.question_id, params, participants);
      this.store.saveQuestion(local, params.targetKey);
      this.store.markConfirmed(dedupKey);
      this.store.deleteSignedTx(dedupKey);
      return { questionId: onChain.question_id, alreadyExists: true, error: null };
    }

    const intent = this.store.upsertJournal({
      dedupKey,
      kind: 'create_question',
      questionId: null,
      accountId: this.config.operatorId,
      payloadJson: serializeCreateSpec(params),
    });
    if (intent.alreadyConfirmed) {
      // Recover local row from chain (already matched above).
      return { questionId: null, alreadyExists: false, error: 'create_question confirmed but question not found on chain' };
    }

    // Reconcile a previously prepared signed tx before any new signing.
    const signed = this.store.getSignedTx(dedupKey);
    if (signed) {
      const outcome = await this.chain.broadcastCall(signed.signedBytesBase64);
      if (outcome.status === 'success' && typeof outcome.result === 'number') {
        const questionId = outcome.result as number;
        this.store.markConfirmed(dedupKey);
        this.store.deleteSignedTx(dedupKey);
        const local = this.toLocalQuestion(questionId, params, participants);
        this.store.saveQuestion(local, params.targetKey);
        return { questionId, alreadyExists: false, error: null };
      }
      if (outcome.status === 'failure') {
        this.store.markFailed(dedupKey, outcome.error ?? 'unknown error');
        this.store.deleteSignedTx(dedupKey);
        return { questionId: null, alreadyExists: false, error: outcome.error };
      }
      // Uncertain: keep signed tx; do NOT re-sign. Reconcile will rebroadcast.
      return { questionId: null, alreadyExists: false, error: 'create_question broadcast uncertain; will rebroadcast same signed tx' };
    }

    // Fresh attempt: prepare + persist the signed tx, then broadcast.
    const prepared = await this.chain.prepareCall(
      'create_question',
      { spec: {
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
        } },
      this.config.operatorId,
      0n,
    );
    this.store.saveSignedTx(dedupKey, prepared.signedBytesBase64, prepared.txHash, prepared.nonce);
    this.store.markSubmitted(dedupKey, prepared.txHash);

    const outcome = await this.chain.broadcastCall(prepared.signedBytesBase64);
    if (outcome.status === 'success' && typeof outcome.result === 'number') {
      const questionId = outcome.result as number;
      this.store.markConfirmed(dedupKey);
      this.store.deleteSignedTx(dedupKey);
      const local = this.toLocalQuestion(questionId, params, participants);
      this.store.saveQuestion(local, params.targetKey);
      return { questionId, alreadyExists: false, error: null };
    }
    if (outcome.status === 'failure') {
      this.store.markFailed(dedupKey, outcome.error ?? 'create_question failed');
      this.store.deleteSignedTx(dedupKey);
      return { questionId: null, alreadyExists: false, error: outcome.error };
    }
    // Uncertain: keep the signed tx so the next tick/restart rebroadcasts it.
    return { questionId: null, alreadyExists: false, error: 'create_question broadcast uncertain; will rebroadcast same signed tx' };
  }

  private toLocalQuestion(
    questionId: number,
    params: CreateQuestionSpec,
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
