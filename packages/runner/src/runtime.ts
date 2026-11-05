/**
 * Public runtime interface.
 *
 * This is the seam the Forecast Access server (ticket #5) will consume to:
 *   - retrieve a frozen Forecast Snapshot privately (aggregate + metadata only,
 *     never per-account private forecasts or salts),
 *   - read finalized purchase/config/public views,
 *   - generate owner-safe DTOs (no secrets),
 *   - inspect lifecycle status,
 *   - continue actions after restart (reconcile + tick).
 *
 * Administrative signing and private forecasts are NOT exposed here; management
 * remains in the operator CLI (cli.ts) and Runner.
 */

import { AGENT_IDS, STRATEGY_DOMAINS } from '@hivecast/core';
import type { AgentId } from '@hivecast/core';
import type { ChainClient, TxFinalStatusView } from './chain/types.js';
import type { RunnerConfig } from './config.js';
import type { Runner, TickReport } from './runner.js';
import type { Store } from './store.js';
import type { LocalQuestion, Phase, QuestionView } from './types.js';
import { AccessAuth, type AccessClock } from './access/index.js';
import type { ForecastDeliveryDto, SessionDto, ChallengeDto } from './access/types.js';
import type { VerifyChallengeInput } from './access/auth.js';
import type { BalanceView, BuyerReceiptView, PendingWithdrawalView } from './types.js';
import {
  computeGlobalLeaderboard,
  computeQuestionComparison,
  computeSimulationReport,
  computeAccountEconomics,
} from './public-data.js';
import { PublicChainCache } from './public-cache.js';
import type { GlobalLeaderboard, QuestionComparison, EconomicsReport } from './public-data.js';
import type { ReplayReport } from '@hivecast/simulation';

/** Public Agent roster entry: identity, supported domains, and account. */
export interface AgentRosterEntry {
  agentId: AgentId;
  accountId: string;
  domains: readonly string[];
  role: string;
}

/** Snapshot aggregate DTO — the product sold via Forecast Access. No secrets. */
export interface SnapshotDto {
  questionId: number;
  snapshotId: string;
  aggregateBps: number;
  totalStakeYocto: string;
  participantCount: number;
}

/** Owner-safe question DTO. Chain-backed fields are `null` when the view is
 * unavailable (explicit missing, never fabricated). */
export interface QuestionDto {
  questionId: number;
  domain: LocalQuestion['domain'];
  text: string;
  eventDefinition: string;
  sourceLabel: string;
  /** `null` means the on-chain view is unavailable; not a fabricated phase. */
  chain: {
    phase: Phase;
    snapshotReady: boolean;
    snapshotId: string | null;
    outcome: boolean | null;
    participantCount: number;
    buyerCount: number;
    totalStake: string;
    feePool: string;
    minStake: string;
    accessPrice: string;
    observationStart: string;
    observationEnd: string;
  } | null;
}

export interface JournalSummary {
  kind: string;
  questionId: number | null;
  accountId: string | null;
  status: string;
  txHash: string | null;
}

export interface LifecycleStatus {
  questionId: number;
  domain: LocalQuestion['domain'];
  /** `null` means the on-chain view is unavailable; not a fabricated phase. */
  chain: {
    phase: Phase;
    snapshotReady: boolean;
    snapshotId: string | null;
    outcome: boolean | null;
    participantCount: number;
    buyerCount: number;
  } | null;
  journal: JournalSummary[];
}

export interface PublicConfig {
  networkId: string;
  contractId: string;
  operatorId: string;
  resolverId: string;
  rpcUrl: string;
  seed: number;
  minStakeYocto: string;
  accessPriceYocto: string;
  domain: 'runner';
}

export interface LeaderboardEntry {
  accountId: string;
  stake: string;
  revealed: number | null;
}

export class Runtime {
  readonly config: RunnerConfig;
  readonly chain: ChainClient;
  readonly store: Store;
  readonly runner: Runner;
  readonly access: AccessAuth;
  /** Bounded public read cache (terminal materialization + balance throttle). */
  private publicReads: PublicChainCache;

  constructor(
    config: RunnerConfig,
    chain: ChainClient,
    store: Store,
    runner: Runner,
    options?: { clock?: AccessClock },
  ) {
    this.config = config;
    this.chain = chain;
    this.store = store;
    this.runner = runner;
    this.access = new AccessAuth(config, chain, store, options?.clock);
    this.publicReads = new PublicChainCache(chain, store);
  }

  getPublicConfig(): PublicConfig {
    return {
      networkId: this.config.networkId,
      contractId: this.config.contractId,
      operatorId: this.config.operatorId,
      resolverId: this.config.resolverId,
      rpcUrl: this.config.rpcUrl,
      seed: this.config.seed,
      minStakeYocto: this.config.minStakeYocto.toString(),
      accessPriceYocto: this.config.accessPriceYocto.toString(),
      domain: 'runner',
    };
  }

  // -------------------------------------------------------------------------
  // Public chain views
  // -------------------------------------------------------------------------

  async getPublicQuestion(questionId: number): Promise<QuestionView | null> {
    return this.chain.getQuestion(questionId);
  }

  async listPublicQuestions(fromIndex: number, limit: number): Promise<QuestionView[]> {
    return this.chain.listQuestions(fromIndex, limit);
  }

  /** Finalized public leaderboard: stake and revealed probability per participant. */
  async listLeaderboard(questionId: number): Promise<LeaderboardEntry[]> {
    const commitments = await this.chain.listCommitments(questionId, 0, 64);
    return commitments.map((c) => ({
      accountId: c.account_id,
      stake: c.stake,
      revealed: c.revealed,
    }));
  }

  /**
   * The eight algorithmic identities with their supported domains and account
   * ids. Account ids are on-chain public; no keys, salts, or forecasts.
   */
  getAgentRoster(): AgentRosterEntry[] {
    return (AGENT_IDS as readonly AgentId[]).map((agentId) => ({
      agentId,
      accountId: this.config.agentAccounts[agentId] ?? '',
      domains: STRATEGY_DOMAINS[agentId],
      role:
        agentId === 'meteo' || agentId === 'climatology'
          ? 'weather'
          : agentId === 'momentum' || agentId === 'meanrev'
            ? 'price'
            : 'both',
    }));
  }

  // -------------------------------------------------------------------------
  // Public analytics / comparison / provenance (ticket #6)
  // -------------------------------------------------------------------------

  /** Global Brier leaderboard over finalized public chain state. */
  async getGlobalLeaderboard(): Promise<GlobalLeaderboard> {
    return computeGlobalLeaderboard(this.publicReads, this.config.networkId, this.config.contractId);
  }

  /** Per-Question public comparison (scores only once the Outcome is final). */
  async getQuestionComparison(questionId: number): Promise<QuestionComparison | null> {
    return computeQuestionComparison(this.publicReads, questionId);
  }

  /** Deterministic offline simulation report (reused from @hivecast/simulation). */
  getSimulationReport(): ReplayReport {
    return computeSimulationReport();
  }

  /**
   * Live account economics (bankroll/available/locked/claimable/pending/
   * received, wagering P&L, Query-Fee income, actual gas) for the bounded
   * Operator-controlled account set + any journal participants. Reuses the
   * shared core `settle` accounting; gas comes from finalized journal hashes.
   */
  async getEconomics(): Promise<EconomicsReport> {
    const accounts = new Set<string>([
      this.config.operatorId,
      this.config.resolverId,
      ...Object.values(this.config.agentAccounts),
    ]);
    return computeAccountEconomics(
      this.publicReads,
      this.config.networkId,
      this.config.contractId,
      [...accounts],
      this.store.listPublicJournal(),
      this.config.operationalGasReserveYocto,
    );
  }

  /**
   * Finalized public transaction receipt projection (read-only, keyless):
   * `final_execution_status`, whether the call produced a proven SuccessValue,
   * and the yoctoNEAR `tokens_burnt` gas cost (null when not yet observable).
   */
  async getTxFinalStatus(txHash: string, accountId: string): Promise<TxFinalStatusView | null> {
    return this.chain.viewTxFinalStatus(txHash, accountId);
  }

  // -------------------------------------------------------------------------
  // Private snapshot (caller must authenticate before exposing to a buyer)
  // -------------------------------------------------------------------------

  /** Frozen aggregate snapshot for a Question, or null if not yet frozen. */
  getSnapshotDto(questionId: number): SnapshotDto | null {
    const s = this.store.getSnapshot(questionId);
    if (!s) return null;
    return {
      questionId: s.questionId,
      snapshotId: s.snapshotId,
      aggregateBps: s.aggregateBps,
      totalStakeYocto: s.totalStakeYocto.toString(),
      participantCount: s.participantCount,
    };
  }

  // -------------------------------------------------------------------------
  // Owner-safe DTOs
  // -------------------------------------------------------------------------

  async toOwnerSafeQuestionDto(q: LocalQuestion): Promise<QuestionDto> {
    const view = await this.chain.getQuestion(q.questionId);
    if (!view) {
      return {
        questionId: q.questionId,
        domain: q.domain,
        text: q.text,
        eventDefinition: q.eventDefinition,
        sourceLabel: q.sourceLabel,
        chain: null,
      };
    }
    return {
      questionId: q.questionId,
      domain: q.domain,
      text: q.text,
      eventDefinition: q.eventDefinition,
      sourceLabel: q.sourceLabel,
      chain: {
        phase: view.phase,
        snapshotReady: view.snapshot_ready,
        snapshotId: view.snapshot_id,
        outcome: view.outcome,
        participantCount: view.participant_count,
        buyerCount: view.buyer_count,
        totalStake: view.total_stake,
        feePool: view.fee_pool,
        minStake: view.min_stake,
        accessPrice: view.access_price,
        observationStart: view.observation_start,
        observationEnd: view.observation_end,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle status + resume
  // -------------------------------------------------------------------------

  async getLifecycleStatus(questionId: number): Promise<LifecycleStatus | null> {
    const local = this.store.getQuestion(questionId);
    if (!local) return null;
    const view = await this.chain.getQuestion(questionId);
    const journal = this.store
      .listJournal()
      .filter((j) => j.questionId === questionId)
      .map((j) => ({
        kind: j.kind,
        questionId: j.questionId,
        accountId: j.accountId,
        status: j.status,
        txHash: j.txHash,
      }));
    return {
      questionId,
      domain: local.domain,
      chain: view
        ? {
            phase: view.phase,
            snapshotReady: view.snapshot_ready,
            snapshotId: view.snapshot_id,
            outcome: view.outcome,
            participantCount: view.participant_count,
            buyerCount: view.buyer_count,
          }
        : null,
      journal,
    };
  }

  async listLocalQuestions(): Promise<LocalQuestion[]> {
    return this.store.listQuestions();
  }

  /** Reconcile pending sends against the chain, then advance one pass. */
  async resume(): Promise<TickReport> {
    // The journal's runOnce already reconciles 'submitted' entries against the
    // chain on the next tick; tick() is the idempotent continue-after-restart.
    return this.runner.tick();
  }

  async tick(): Promise<TickReport> {
    return this.runner.tick();
  }

  // -------------------------------------------------------------------------
  // Forecast Access authentication + delivery (ticket #5)
  // -------------------------------------------------------------------------

  mintAccessChallenge(accountId: string): ChallengeDto {
    return this.access.mintChallenge(accountId);
  }

  verifyAccessChallenge(input: VerifyChallengeInput): Promise<{ sessionId: string; dto: SessionDto }> {
    return this.access.verifyChallenge(input);
  }

  resolveAccessSession(sessionId: string): string {
    return this.access.resolveSession(sessionId);
  }

  deliverForecast(questionId: number, sessionId: string): Promise<ForecastDeliveryDto> {
    return this.access.deliverForecast(questionId, sessionId);
  }

  getAccessDisclosure() {
    return this.access.getDisclosure();
  }

  // -------------------------------------------------------------------------
  // Public finalized wallet views (claim/withdraw remain wallet-signed)
  // -------------------------------------------------------------------------

  async getAccountBalance(accountId: string): Promise<BalanceView | null> {
    return this.chain.getBalance(accountId);
  }

  async listPendingWithdrawals(accountId: string, fromIndex: number, limit: number): Promise<PendingWithdrawalView[]> {
    return this.chain.listPendingWithdrawals(accountId, fromIndex, limit);
  }

  async getBuyerReceipt(questionId: number, accountId: string): Promise<BuyerReceiptView | null> {
    return this.chain.getBuyerReceipt(questionId, accountId);
  }

  async listBuyers(questionId: number, fromIndex: number, limit: number): Promise<BuyerReceiptView[]> {
    return this.chain.listBuyers(questionId, fromIndex, limit);
  }
}
