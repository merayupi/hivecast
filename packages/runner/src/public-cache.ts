/**
 * Bounded public read cache + materialization (ticket #6 backend).
 *
 * The public leaderboard/economics projections previously walked the FULL
 * question history and hit per-account native/balance RPC on every HTTP
 * request, which rate-limits a shared testnet RPC. This module materializes
 * immutable terminal Rounds (settled/cancelled — their Question + Commitments
 * never change) and coalesces the mutable per-account balance reads behind a
 * short TTL, so:
 *
 *   - stable terminal rows are fetched exactly once and never refetched;
 *   - only the bounded set of live (open/closed/resolved) Rounds is re-read;
 *   - current balances are throttled (failures surface as null, never fake 0);
 *   - pagination remains finite and bounded by the contract's own question count.
 */

import type { ChainClient } from './chain/types.js';
import type { BalanceView, CommitmentView, QuestionView } from './types.js';

/** Read-only projection source — implemented by the cache over a ChainClient. */
export interface PublicReadSource {
  listAllQuestions(): Promise<QuestionView[]>;
  listAllCommitments(questionId: number): Promise<CommitmentView[]>;
  getBalance(accountId: string): Promise<BalanceView | null>;
  viewNativeBalance(accountId: string): Promise<bigint | null>;
  viewNativeAvailable(accountId: string): Promise<bigint | null>;
  viewTxTokensBurnt(txHash: string, accountId: string): Promise<string | null>;
}

interface TerminalRound {
  question: QuestionView;
  commitments: CommitmentView[];
}

const LIST_PAGE_LIMIT = 100;
const COMMITMENT_PAGE_LIMIT = 64;

export class PublicChainCache implements PublicReadSource {
  private chain: ChainClient;
  private liveTtlMs: number;
  private balanceTtlMs: number;

  private terminal = new Map<number, TerminalRound>();
  private liveQuestions: { at: number; rows: QuestionView[] } | null = null;
  private liveCommitments = new Map<number, { at: number; rows: CommitmentView[] }>();
  private balances = new Map<string, { at: number; value: BalanceView | null }>();
  private natives = new Map<string, { at: number; total: bigint | null; available: bigint | null }>();

  constructor(chain: ChainClient, opts?: { liveTtlMs?: number; balanceTtlMs?: number }) {
    this.chain = chain;
    this.liveTtlMs = opts?.liveTtlMs ?? 15_000;
    this.balanceTtlMs = opts?.balanceTtlMs ?? 30_000;
  }

  private static pageAll<T>(count: number, pageSize: number, fetch: (from: number, limit: number) => Promise<T[]>): Promise<T[]> {
    return (async () => {
      const out: T[] = [];
      for (let from = 0; from < count; from += pageSize) {
        const page = await fetch(from, pageSize);
        out.push(...page);
        if (page.length < pageSize) break;
      }
      return out;
    })();
  }

  async listAllQuestions(): Promise<QuestionView[]> {
    const state = await this.chain.getContractState();
    const total = state.question_count;

    // Fetch the full live list only when stale; terminal rows are then
    // replaced by materialized copies (immutable, never refetched).
    const now = Date.now();
    let rows: QuestionView[];
    if (this.liveQuestions && now - this.liveQuestions.at < this.liveTtlMs) {
      rows = this.liveQuestions.rows;
    } else {
      rows = await PublicChainCache.pageAll(total, LIST_PAGE_LIMIT, (from, limit) => this.chain.listQuestions(from, limit));
      this.liveQuestions = { at: now, rows };
    }

    const out: QuestionView[] = [];
    for (const q of rows) {
      if (q.phase === 'settled' || q.phase === 'cancelled') {
        const mat = await this.materializeTerminal(q);
        out.push(mat.question);
      } else {
        out.push(q);
      }
    }
    return out;
  }

  async listAllCommitments(questionId: number): Promise<CommitmentView[]> {
    const q = await this.chain.getQuestion(questionId);
    if (q && (q.phase === 'settled' || q.phase === 'cancelled')) {
      const mat = await this.materializeTerminal(q);
      return mat.commitments;
    }
    // Live round: short TTL.
    const now = Date.now();
    const cached = this.liveCommitments.get(questionId);
    if (cached && now - cached.at < this.liveTtlMs) return cached.rows;
    const rows = await PublicChainCache.pageAll(64, COMMITMENT_PAGE_LIMIT, (from, limit) => this.chain.listCommitments(questionId, from, limit));
    this.liveCommitments.set(questionId, { at: now, rows });
    return rows;
  }

  private async materializeTerminal(q: QuestionView): Promise<TerminalRound> {
    const existing = this.terminal.get(q.question_id);
    if (existing) return existing;
    const commitments = await PublicChainCache.pageAll(q.participant_count, COMMITMENT_PAGE_LIMIT, (from, limit) =>
      this.chain.listCommitments(q.question_id, from, limit),
    );
    const round: TerminalRound = { question: q, commitments };
    this.terminal.set(q.question_id, round);
    return round;
  }

  async getBalance(accountId: string): Promise<BalanceView | null> {
    const now = Date.now();
    const cached = this.balances.get(accountId);
    if (cached && now - cached.at < this.balanceTtlMs) return cached.value;
    let value: BalanceView | null;
    try {
      value = await this.chain.getBalance(accountId);
    } catch {
      value = null;
    }
    this.balances.set(accountId, { at: now, value });
    return value;
  }

  private async nativesFor(accountId: string): Promise<{ total: bigint | null; available: bigint | null }> {
    const now = Date.now();
    const cached = this.natives.get(accountId);
    if (cached && now - cached.at < this.balanceTtlMs) return cached;
    let total: bigint | null = null;
    let available: bigint | null = null;
    try {
      total = await this.chain.viewNativeBalance(accountId);
    } catch {
      total = null;
    }
    try {
      available = await this.chain.viewNativeAvailable(accountId);
    } catch {
      available = null;
    }
    const value = { total, available };
    this.natives.set(accountId, { at: now, ...value });
    return value;
  }

  async viewNativeBalance(accountId: string): Promise<bigint | null> {
    return (await this.nativesFor(accountId)).total;
  }

  async viewNativeAvailable(accountId: string): Promise<bigint | null> {
    return (await this.nativesFor(accountId)).available;
  }

  async viewTxTokensBurnt(txHash: string, accountId: string): Promise<string | null> {
    // Gas reads are per-finalized-transaction and only cover the journal's own
    // hashes (bounded); they are not coalesced (each tx has one immutable cost).
    return this.chain.viewTxTokensBurnt(txHash, accountId);
  }
}
