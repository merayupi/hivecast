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

import type { ChainClient } from './chain/types.js';
import type { RunnerConfig } from './config.js';
import type { Runner, TickReport } from './runner.js';
import type { Store } from './store.js';
import type { LocalQuestion, Phase, QuestionView } from './types.js';

/** Snapshot aggregate DTO — the product sold via Forecast Access. No secrets. */
export interface SnapshotDto {
  questionId: number;
  snapshotId: string;
  aggregateBps: number;
  totalStakeYocto: string;
  participantCount: number;
}

/** Owner-safe question DTO (public + local metadata, no salts/forecasts). */
export interface QuestionDto {
  questionId: number;
  domain: LocalQuestion['domain'];
  text: string;
  eventDefinition: string;
  sourceLabel: string;
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
  phase: Phase;
  snapshotReady: boolean;
  snapshotId: string | null;
  outcome: boolean | null;
  participantCount: number;
  buyerCount: number;
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

  constructor(config: RunnerConfig, chain: ChainClient, store: Store, runner: Runner) {
    this.config = config;
    this.chain = chain;
    this.store = store;
    this.runner = runner;
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
    return {
      questionId: q.questionId,
      domain: q.domain,
      text: q.text,
      eventDefinition: q.eventDefinition,
      sourceLabel: q.sourceLabel,
      phase: view?.phase ?? 'open',
      snapshotReady: view?.snapshot_ready ?? false,
      snapshotId: view?.snapshot_id ?? null,
      outcome: view?.outcome ?? null,
      participantCount: view?.participant_count ?? 0,
      buyerCount: view?.buyer_count ?? 0,
      totalStake: view?.total_stake ?? '0',
      feePool: view?.fee_pool ?? '0',
      minStake: view?.min_stake ?? '0',
      accessPrice: view?.access_price ?? '0',
      observationStart: view?.observation_start ?? q.observationStartNs.toString(),
      observationEnd: view?.observation_end ?? q.observationEndNs.toString(),
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
      phase: view?.phase ?? 'open',
      snapshotReady: view?.snapshot_ready ?? false,
      snapshotId: view?.snapshot_id ?? null,
      outcome: view?.outcome ?? null,
      participantCount: view?.participant_count ?? 0,
      buyerCount: view?.buyer_count ?? 0,
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
}
