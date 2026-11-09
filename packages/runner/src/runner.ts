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
import { forecastWithLlm } from './llm.js';
import type { FetchLike } from './llm.js';
import type { AgentId, Domain, StrategyContext, StrategyInputs } from '@hivecast/core';
import { commitmentHash, generateSalt } from './commitment.js';
import type { ChainClient, TxFinalStatusView } from './chain/types.js';
import { ChainUnavailableError } from './chain/index.js';
import type { RunnerConfig } from './config.js';
import {
  nsToMs,
  parseSourceSpec,
  priceTargetLabel,
  weatherTargetLabel,
  localDateOfUtcMs,
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

/** A weather Question's target date in its own city's time zone. */
function weatherLocalDate(q: LocalQuestion): string {
  const spec = parseSourceSpec(q.sourceJson);
  const tz = spec.kind === 'weather' ? spec.timezone : 'UTC';
  return localDateOfUtcMs(nsToMs(q.observationStartNs) + 3_600_000, tz);
}

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
  private config: RunnerConfig;
  private nowProvider: () => bigint;

  constructor(config: RunnerConfig, nowNs?: () => bigint) {
    this.config = config;
    this.nowProvider = nowNs ?? (() => BigInt(Date.now()) * 1_000_000n);
  }

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
    // Local calendar date in the city's own time zone (+1 h guards the exact midnight instant).
    const obsStartMs = nsToMs(q.observationStartNs);
    const targetDate = localDateOfUtcMs(obsStartMs + 3_600_000, spec.timezone);
    const { forecastPrecipMm, evidence } = await fetchWeatherForecast(bases, spec, targetDate);
    const historyPrecipMm: string[] = [];
    const missing: string[] = [];
    // History = past local days whose observation window FULLY ended before the
    // commitment cutoff. The most recent completed day is the day before the
    // target day's predecessor (target D, cutoff D-1 23:55 local, so D-1 has not
    // ended yet); therefore start at i=2 (D-2 and older), never the still-open
    // local day.
    for (let i = 2; i <= WEATHER_HISTORY_DAYS + 1; i++) {
      const date = localDateOfUtcMs(obsStartMs - i * 86_400_000 + 12 * 3_600_000, spec.timezone);
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
    const res = await fetchWeatherResolution(bases, spec, localDateOfUtcMs(nsToMs(q.observationStartNs) + 3_600_000, spec.timezone));
    return { outcome: res.outcome, evidenceJson: JSON.stringify(res.evidence), evidenceHash: res.evidence.hash };
  }

  private nowNs(): bigint {
    return this.nowProvider();
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
    this.source = source ?? new LiveSourceProvider(config, () => chain.nowNs());
  }

  private nowNs(): bigint {
    return this.chain.nowNs();
  }

  private agentAccount(agentId: AgentId): string {
    const account = this.config.agentAccounts[agentId];
    if (!account) throw new Error(`no account configured for agent ${agentId}`);
    return account;
  }

  /** The live-only LLM agent joins only when it has both an account and an LLM config. */
  private llmEnabled(): boolean {
    return Boolean(this.config.llm && this.config.agentAccounts['llm-news']);
  }

  /** Domain-relevant agents (spec §8), deterministic order. */
  private participantsFor(domain: Domain): { agentId: AgentId; accountId: string }[] {
    const order = ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip'] as AgentId[];
    if (this.llmEnabled()) order.push('llm-news');
    return order.filter((id) => supportsDomain(id, domain)).map((id) => ({ agentId: id, accountId: this.agentAccount(id) }));
  }

  /** Injectable for tests; defaults to global fetch. */
  fetchFn: FetchLike = (url, init) => fetch(url, init);

  /**
   * llm-news forecast: sized BEFORE the (paid) LLM call so a broke agent never
   * spends credits, capped at `maxAttempts` per Round, and every attempt is
   * stored privately before anything is committed.
   */
  private async llmForecast(
    q: LocalQuestion,
    accountId: string,
    inputs: StrategyInputs,
  ): Promise<{ kind: 'forecast'; probabilityBps: number } | { kind: 'abstain'; reason: string }> {
    const cfg = this.config.llm;
    if (!cfg) return { kind: 'abstain', reason: 'llm-not-configured' };
    if (inputs.kind !== 'price') return { kind: 'abstain', reason: 'unsupported-domain' };
    if (this.store.countLlmRuns(q.questionId, accountId) >= cfg.maxAttempts) {
      return { kind: 'abstain', reason: 'llm-attempts-exhausted' };
    }
    const available = await this.availableForStake(accountId);
    if (available / STAKE_FLOOR_DENOM < this.config.minStakeYocto) {
      return { kind: 'abstain', reason: 'below-minimum-stake' };
    }
    const nowMs = Number(this.nowNs() / 1_000_000n);
    const result = await forecastWithLlm(this.fetchFn, cfg, q.text, inputs.candles, nowMs);
    const r = result.record;
    this.store.saveLlmRun({
      questionId: q.questionId,
      accountId,
      model: r.model,
      promptSha256: r.promptSha256,
      headlines: r.headlines,
      probBps: r.probabilityBps,
      rationale: r.rationale,
      promptTokens: r.usage?.promptTokens ?? null,
      completionTokens: r.usage?.completionTokens ?? null,
      error: r.error,
      createdAtMs: nowMs,
    });
    const tokens = r.usage ? ` tokens=${r.usage.promptTokens}+${r.usage.completionTokens}` : '';
    process.stdout.write(
      `[llm-news] q${q.questionId} ${result.kind === 'forecast' ? `p=${result.probabilityBps}bps` : `abstain:${result.reason} ${r.error ?? ''}`}${tokens}\n`,
    );
    return result.kind === 'forecast' ? { kind: 'forecast', probabilityBps: result.probabilityBps } : { kind: 'abstain', reason: result.reason };
  }

  private strategyContext(q: LocalQuestion, agentId: AgentId, inputs: StrategyInputs): StrategyContext {
    const targetTime =
      q.domain === 'price'
        ? priceTargetLabel(nsToMs(q.observationStartNs))
        : weatherTargetLabel(weatherLocalDate(q));
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

  /** Reconcile a persisted signed tx's OLD canonical receipt against the chain.
   * Returns the definitive decision on whether the original already landed,
   * failed, is still pending, or is unknown — BEFORE any fresh re-sign. */
  private async checkOldReceipt(
    txHash: string,
    signer: string,
  ): Promise<'final-success' | 'final-failure' | 'pending' | 'unknown' | 'unavailable'> {
    let view: TxFinalStatusView | null;
    try {
      view = await this.chain.viewTxFinalStatus(txHash, signer);
    } catch (err) {
      // RPC/chain unavailable: preserve unknown, do NOT re-sign.
      if (err instanceof ChainUnavailableError) return 'unavailable';
      // Any other definitive not-found → unknown.
      return 'unknown';
    }
    if (view === null) return 'unknown'; // not found / not yet queryable
    if (view.final_execution_status === 'FINAL') {
      return view.success_value ? 'final-success' : 'final-failure';
    }
    // Known but not FINAL (Started/NotStarted/EXECUTED_OPTIMISTIC/…) → still in
    // flight; preserve the exact signed bytes and wait, never re-sign.
    return 'pending';
  }

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
      // Business postcondition landed already (fast path).
      if (await verify()) {
        this.store.markConfirmed(dedupKey, signed.txHash);
        this.store.deleteSignedTx(dedupKey);
        return { kind, questionId, accountId, sent: false, reason: 'reconciled', error: null };
      }

      // Reconcile the OLD canonical receipt BEFORE any rebroadcast/re-sign.
      const signerId = action().signer;
      const oldReceipt = await this.checkOldReceipt(signed.txHash, signerId);
      if (oldReceipt === 'final-success') {
        // The original tx actually landed (lost response): confirm, no re-sign.
        this.store.markConfirmed(dedupKey, signed.txHash);
        this.store.deleteSignedTx(dedupKey);
        return { kind, questionId, accountId, sent: false, reason: 'reconciled', error: null };
      }
      if (oldReceipt === 'pending') {
        // Known but not FINAL: preserve the exact signed bytes, wait (no new nonce).
        this.store.markSubmitted(dedupKey, signed.txHash);
        return { kind, questionId, accountId, sent: false, reason: 'old-receipt-pending', error: null };
      }
      if (oldReceipt === 'unavailable') {
        // RPC unavailable: preserve unknown, do NOT re-sign.
        this.store.markSubmitted(dedupKey, signed.txHash);
        return { kind, questionId, accountId, sent: false, reason: 'rebroadcast-uncertain', error: 'chain unavailable' };
      }
      // 'unknown' or 'final-failure': the old tx did NOT definitively land.
      // Only a DEFINITIVE pre-inclusion rejection (stale nonce / expired
      // blockHash) or a FINAL failure permits a FRESH re-sign of the SAME
      // intent. A mere timeout/unknown keeps the same signed tx and re-broadcasts.
      if (oldReceipt === 'final-failure') {
        // Definitive failure: safe to re-prepare fresh for the same intent.
        return this.prepareFreshAndBroadcast(dedupKey, kind, questionId, accountId, action);
      }
      // 'unknown': rebroadcast the SAME signed tx (NEAR dedupes by hash) to
      // learn the definitive status; if it comes back nonceStale/expired, the
      // caller path below handles the fresh re-prepare.
      const outcome = await this.chain.broadcastCall(signed.signedBytesBase64);
      if (outcome.status === 'success') {
        this.store.markConfirmed(dedupKey, outcome.txHash ?? signed.txHash);
        this.store.deleteSignedTx(dedupKey);
        return { kind, questionId, accountId, sent: true, reason: 'rebroadcast-sent', error: null };
      }
      if (outcome.nonceStale || outcome.txExpired) {
        // DEFINITIVE pre-inclusion rejection: the old tx was NOT included and
        // will never be accepted. Reconcile postcondition then re-prepare fresh.
        if (await verify()) {
          this.store.markConfirmed(dedupKey, signed.txHash);
          this.store.deleteSignedTx(dedupKey);
          return { kind, questionId, accountId, sent: false, reason: 'reconciled', error: null };
        }
        return this.prepareFreshAndBroadcast(dedupKey, kind, questionId, accountId, action);
      }
      if (outcome.status === 'failure') {
        // Included-but-failed (e.g. contract assert): did not apply; safe to
        // retry the same intent fresh.
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
    return this.prepareFreshAndBroadcast(dedupKey, kind, questionId, accountId, action);
  }

  /** Prepare a FRESH signed tx (evicting any stale nonce cache), persist it,
   * then broadcast. Reconciles the postcondition first on a stale nonce. */
  private async prepareFreshAndBroadcast(
    dedupKey: string,
    kind: JournalKind,
    questionId: number | null,
    accountId: string | null,
    action: () => { methodName: string; args: Record<string, unknown>; signer: string; deposit: bigint; gas?: bigint },
  ): Promise<StepResult> {
    const a = action();
    // Evict the account's nonce cache so prepareCall re-fetches the real nonce
    // (a previous stale-nonce rejection left the cache wrong).
    this.chain.evictAccountNonceCache(a.signer);
    const prepared = await this.chain.prepareCall(a.methodName, a.args, a.signer, a.deposit, a.gas);
    this.store.saveSignedTx(dedupKey, prepared.signedBytesBase64, prepared.txHash, prepared.nonce);
    this.store.markSubmitted(dedupKey, prepared.txHash);
    const outcome = await this.chain.broadcastCall(prepared.signedBytesBase64);
    if (outcome.status === 'success') {
      this.store.markConfirmed(dedupKey, outcome.txHash ?? prepared.txHash);
      this.store.deleteSignedTx(dedupKey);
      return { kind, questionId, accountId, sent: true, reason: 'sent', error: null };
    }
    if (outcome.nonceStale || outcome.txExpired) {
      // Still stale/expired after eviction (a concurrent signer keeps racing, or
      // the chain keeps advancing). Keep the freshly prepared bytes and let the
      // next tick reconcile/re-prepare.
      this.store.markSubmitted(dedupKey, prepared.txHash);
      return { kind, questionId, accountId, sent: false, reason: 'nonce-stale-retry', error: outcome.error };
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
      const result =
        agentId === 'llm-news'
          ? await this.llmForecast(q, accountId, inputs)
          : getStrategy(agentId)(this.strategyContext(q, agentId, inputs));
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
      if (!accountId || seen.has(accountId)) continue;
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
        // Terminal phase actually observed: retire durably and stop per-Round
        // work. Claimable/pending balances are drained by the global account
        // sweep, so this is independent of retirement.
        this.store.markRetired(q.questionId, chainQuestion.phase as 'settled' | 'cancelled');
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

  /** One pass: reconcile creates, advance non-retired rounds, drain global balances. */
  async tick(): Promise<TickReport> {
    await this.reconcileCreates();
    const steps: StepResult[] = [];
    for (const q of this.store.listQuestions()) {
      // Retire ONLY when the finalized terminal phase was actually observed and
      // persisted. Never skip by age: unresolved/resolved Rounds must still be
      // cancelled/settled after arbitrary downtime.
      if (this.store.isRetired(q.questionId)) continue;
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
      // Reconcile the OLD canonical receipt BEFORE any rebroadcast/re-sign.
      const oldReceipt = await this.checkOldReceipt(signed.txHash, this.config.operatorId);
      if (oldReceipt === 'final-success') {
        // The original create_question landed (lost response): recover + confirm.
        const landed = await this.listAllChainQuestions().then((qs) => qs.find((q) => this.matchesSpec(q, params)));
        if (landed) {
          this.store.markConfirmed(dedupKey, signed.txHash);
          this.store.deleteSignedTx(dedupKey);
          this.store.saveQuestion(this.toLocalQuestion(landed.question_id, params, participants), params.targetKey);
          return { questionId: landed.question_id, alreadyExists: true, error: null };
        }
        // receipt says success but business view not yet visible: reconcile next tick.
        return { questionId: null, alreadyExists: false, error: 'create_question receipt final but business view pending' };
      }
      if (oldReceipt === 'pending' || oldReceipt === 'unavailable') {
        // Preserve exact signed bytes, wait (no fresh nonce / no re-sign).
        return { questionId: null, alreadyExists: false, error: 'create_question old receipt pending/unavailable; will reconcile' };
      }
      if (oldReceipt === 'final-failure') {
        // Definitive failure: safe to re-prepare fresh for the same spec.
        return this.reconcileOrRecreate(dedupKey, params, participants);
      }
      // 'unknown': rebroadcast the SAME signed tx to learn the definitive status.
      const outcome = await this.chain.broadcastCall(signed.signedBytesBase64);
      if (outcome.status === 'success' && typeof outcome.result === 'number') {
        const questionId = outcome.result as number;
        this.store.markConfirmed(dedupKey, outcome.txHash ?? signed.txHash);
        this.store.deleteSignedTx(dedupKey);
        const local = this.toLocalQuestion(questionId, params, participants);
        this.store.saveQuestion(local, params.targetKey);
        return { questionId, alreadyExists: false, error: null };
      }
      if (outcome.nonceStale || outcome.txExpired) {
        // DEFINITIVE pre-inclusion rejection: reconcile spec match then re-prepare.
        return this.reconcileOrRecreate(dedupKey, params, participants);
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
    return this.reconcileOrRecreate(dedupKey, params, participants);
  }

  /** Prepare + persist + broadcast a create_question, handling stale-nonce
   * rejection by reconciling the on-chain postcondition and re-preparing. */
  private async reconcileOrRecreate(
    dedupKey: string,
    params: CreateQuestionSpec,
    participants: { agentId: AgentId; accountId: string }[],
  ): Promise<{ questionId: number | null; alreadyExists: boolean; error: string | null }> {
    // A create_question is context-bound to targetKey + full spec; check whether
    // it already landed before (re)signing anything.
    const all = await this.listAllChainQuestions();
    const onChain = all.find((q) => this.matchesSpec(q, params));
    if (onChain) {
      this.store.markConfirmed(dedupKey);
      this.store.deleteSignedTx(dedupKey);
      const local = this.toLocalQuestion(onChain.question_id, params, participants);
      this.store.saveQuestion(local, params.targetKey);
      return { questionId: onChain.question_id, alreadyExists: true, error: null };
    }

    // Evict any stale nonce cache, then prepare a FRESH signed tx for the SAME
    // spec and persist it BEFORE broadcast.
    this.chain.evictAccountNonceCache(this.config.operatorId);
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
      this.store.markConfirmed(dedupKey, outcome.txHash ?? prepared.txHash);
      this.store.deleteSignedTx(dedupKey);
      const local = this.toLocalQuestion(questionId, params, participants);
      this.store.saveQuestion(local, params.targetKey);
      return { questionId, alreadyExists: false, error: null };
    }
    if (outcome.nonceStale || outcome.txExpired) {
      // Still stale/expired: keep the freshly prepared bytes; the next tick reconciles.
      return { questionId: null, alreadyExists: false, error: 'create_question nonce stale/expired; will retry same intent' };
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
