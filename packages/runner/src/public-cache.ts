/**
 * Bounded public read cache (ticket #6 backend) — persistent public question
 * views + bounded fetch cursor, no data loss.
 *
 * Public leaderboard/economics projections must not re-walk the entire question
 * history or hit per-account RPC on every HTTP request. This cache:
 *
 *   - persists EVERY discovered public Question view in SQLite (never drops an
 *     active live-id — a bounded cursor advances only by the number of rows
 *     actually fetched, so an older still-active Round's committed Stake can
 *     never vanish from bankroll/locked/coverage);
 *   - fetches a bounded BATCH of new questions per refresh (the contract's
 *     sequential question ids), advancing the persistent cursor by the actual
 *     fetched count, never by the total when a page is short/unexpected;
 *   - re-reads the non-terminal "live" set with a short TTL (bounded by the
 *     number of currently open/closed/resolved Rounds, not by history);
 *   - materializes immutable terminal (settled/cancelled) rounds once;
 *   - coalesces concurrent balance/native/tx reads and caches FINAL receipts.
 *
 * `isFullyBootstrapped()` is true only when the cursor has reached the last
 * observed on-chain question count AND no live round's read is stale. Until
 * then callers report `coverage: 'partial'` (never "all history").
 */

import type { ChainClient } from './chain/types.js';
import type { BalanceView, CommitmentView, QuestionView } from './types.js';
import type { Store } from './store.js';

/** Read-only projection source — implemented by the cache over Chain+Store. */
export interface PublicReadSource {
  listAllQuestions(): Promise<QuestionView[]>;
  listAllCommitments(questionId: number): Promise<CommitmentView[]>;
  getBalance(accountId: string): Promise<BalanceView | null>;
  viewNativeBalance(accountId: string): Promise<bigint | null>;
  viewNativeAvailable(accountId: string): Promise<bigint | null>;
  viewTxTokensBurnt(txHash: string, accountId: string): Promise<string | null>;
  /** Durable local capital reservation for an account (throws on DB failure). */
  getLocalReserved(accountId: string): bigint;
  /** Coverage: whether full history has been bootstrapped and persisted. */
  isFullyBootstrapped(): boolean;
  /** Coverage info: on-chain total, fetched count, and completeness. */
  getCoverageInfo(): { totalQuestions: number; fetchedQuestions: number; complete: boolean };
}

interface TerminalData {
  question: QuestionView;
  commitments: CommitmentView[];
}

const BATCH_SIZE = 20; // bounded new-question fetch per refresh
const COMMITMENT_PAGE_LIMIT = 64;
const LIVE_READ_TTL_MS = 15_000;
const BALANCE_TTL_MS = 30_000;

export class PublicChainCache implements PublicReadSource {
  private chain: ChainClient;
  private store: Store;

  private liveCommitments = new Map<number, { at: number; rows: CommitmentView[] }>();
  private liveQuestionsCache: { at: number; rows: QuestionView[] } | null = null;
  private balanceCache = new Map<string, { at: number; value: BalanceView | null }>();
  private nativeCache = new Map<string, { at: number; total: bigint | null; available: bigint | null }>();
  private balanceInflight = new Map<string, Promise<BalanceView | null>>();
  private nativeInflight = new Map<string, Promise<{ total: bigint | null; available: bigint | null }>>();
  private txInflight = new Map<string, Promise<string | null>>();

  constructor(chain: ChainClient, store: Store) {
    this.chain = chain;
    this.store = store;
  }

  isFullyBootstrapped(): boolean {
    return this.getCoverageInfo().complete;
  }

  getCoverageInfo(): { totalQuestions: number; fetchedQuestions: number; complete: boolean } {
    const cursor = this.store.getPublicCursor();
    return {
      totalQuestions: this.lastObservedTotal,
      fetchedQuestions: cursor,
      complete: cursor >= this.lastObservedTotal,
    };
  }

  private lastObservedTotal = 0;

  private async refreshCursor(): Promise<void> {
    const state = await this.chain.getContractState();
    const total = state.question_count;
    this.lastObservedTotal = total;

    const cursor = this.store.getPublicCursor();
    if (cursor >= total) return;

    // Bounded batch: fetch at most BATCH_SIZE NEW questions from the cursor.
    const page = await this.chain.listQuestions(cursor, BATCH_SIZE);

    for (const q of page) {
      // Persist EVERY discovered view (no drop, no live-id loss).
      this.store.savePublicQuestion(q.question_id, q.phase, JSON.stringify(q));
      if (q.phase === 'settled' || q.phase === 'cancelled') {
        await this.materialize(q);
      }
    }

    // Advance the cursor only by the number of rows ACTUALLY fetched, never by
    // the total (a short/unexpected page must not skip unread rows).
    this.store.setPublicCursor(cursor + page.length);
  }

  private async materialize(q: QuestionView): Promise<TerminalData> {
    const existing = this.store.getPublicTerminalRound(q.question_id);
    if (existing) return JSON.parse(existing.dataJson) as TerminalData;
    const commitments = await this.fetchCommitments(q.question_id, q.participant_count);
    const data: TerminalData = { question: q, commitments };
    this.store.savePublicTerminalRound(q.question_id, q.phase as 'settled' | 'cancelled', JSON.stringify(data));
    return data;
  }

  private async fetchCommitments(questionId: number, count: number): Promise<CommitmentView[]> {
    const out: CommitmentView[] = [];
    for (let from = 0; from < count; from += COMMITMENT_PAGE_LIMIT) {
      const page = await this.chain.listCommitments(questionId, from, COMMITMENT_PAGE_LIMIT);
      out.push(...page);
      if (page.length < COMMITMENT_PAGE_LIMIT) break;
    }
    return out;
  }

  private async readLiveQuestions(): Promise<QuestionView[]> {
    const now = Date.now();
    if (this.liveQuestionsCache && now - this.liveQuestionsCache.at < LIVE_READ_TTL_MS) {
      return this.liveQuestionsCache.rows;
    }
    // Re-read only the currently non-terminal persisted questions (bounded by
    // the number of live Rounds, never by history). Each terminal transition is
    // materialized once and replaced by its immutable copy.
    const live: QuestionView[] = [];
    for (const row of this.store.listPublicQuestions()) {
      if (row.phase === 'settled' || row.phase === 'cancelled') continue;
      const q = await this.chain.getQuestion(row.questionId);
      if (!q) continue;
      if (q.phase === 'settled' || q.phase === 'cancelled') {
        // Refresh the persisted phase and materialize commitments.
        this.store.savePublicQuestion(q.question_id, q.phase, JSON.stringify(q));
        await this.materialize(q);
      } else {
        this.store.savePublicQuestion(q.question_id, q.phase, JSON.stringify(q));
        live.push(q);
      }
    }
    this.liveQuestionsCache = { at: now, rows: live };
    return live;
  }

  async listAllQuestions(): Promise<QuestionView[]> {
    await this.refreshCursor();
    const terminal = this.store
      .listPublicTerminalRounds()
      .map((r) => (JSON.parse(r.dataJson) as TerminalData).question);
    const live = await this.readLiveQuestions();
    return [...terminal, ...live].sort((a, b) => a.question_id - b.question_id);
  }

  async listAllCommitments(questionId: number): Promise<CommitmentView[]> {
    const persisted = this.store.getPublicTerminalRound(questionId);
    if (persisted) return (JSON.parse(persisted.dataJson) as TerminalData).commitments;
    const now = Date.now();
    const cached = this.liveCommitments.get(questionId);
    if (cached && now - cached.at < LIVE_READ_TTL_MS) return cached.rows;
    const q = await this.chain.getQuestion(questionId);
    const rows = q ? await this.fetchCommitments(questionId, q.participant_count) : [];
    this.liveCommitments.set(questionId, { at: now, rows });
    return rows;
  }

  async getBalance(accountId: string): Promise<BalanceView | null> {
    const now = Date.now();
    const cached = this.balanceCache.get(accountId);
    if (cached && now - cached.at < BALANCE_TTL_MS) return cached.value;
    const pending = this.balanceInflight.get(accountId);
    if (pending) return pending;
    const p = (async () => {
      let value: BalanceView | null;
      try {
        value = await this.chain.getBalance(accountId);
      } catch {
        value = null;
      }
      this.balanceCache.set(accountId, { at: Date.now(), value });
      this.balanceInflight.delete(accountId);
      return value;
    })();
    this.balanceInflight.set(accountId, p);
    return p;
  }

  private async nativesFor(accountId: string): Promise<{ total: bigint | null; available: bigint | null }> {
    const now = Date.now();
    const cached = this.nativeCache.get(accountId);
    if (cached && now - cached.at < BALANCE_TTL_MS) return cached;
    const pending = this.nativeInflight.get(accountId);
    if (pending) return pending;
    const p = (async () => {
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
      this.nativeCache.set(accountId, { at: Date.now(), ...value });
      this.nativeInflight.delete(accountId);
      return value;
    })();
    this.nativeInflight.set(accountId, p);
    return p;
  }

  async viewNativeBalance(accountId: string): Promise<bigint | null> {
    return (await this.nativesFor(accountId)).total;
  }

  async viewNativeAvailable(accountId: string): Promise<bigint | null> {
    return (await this.nativesFor(accountId)).available;
  }

  async viewTxTokensBurnt(txHash: string, accountId: string): Promise<string | null> {
    // Immutable once FINAL (success OR failure): serve from SQLite.
    const cached = this.store.getPublicTxGas(txHash);
    if (cached && cached.finalStatus === 'FINAL') return cached.tokensBurnt;
    const pending = this.txInflight.get(txHash);
    if (pending) return pending;
    const p = (async () => {
      const view = await this.chain.viewTxFinalStatus(txHash, accountId);
      if (view && view.final_execution_status === 'FINAL' && view.tokens_burnt !== null) {
        this.store.savePublicTxGas(txHash, accountId, view.final_execution_status, view.success_value, view.tokens_burnt);
        this.txInflight.delete(txHash);
        return view.tokens_burnt;
      }
      this.txInflight.delete(txHash);
      return view?.tokens_burnt ?? null;
    })();
    this.txInflight.set(txHash, p);
    return p;
  }

  getLocalReserved(accountId: string): bigint {
    return this.store.totalReserved(accountId);
  }
}
