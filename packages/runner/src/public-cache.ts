/**
 * Bounded public read cache (ticket #6 backend) — persistent terminal
 * materialization + incremental live tail + inflight coalescing.
 *
 * Public leaderboard/economics projections must not re-walk the entire question
 * history or hit per-account RPC on every HTTP request. This cache persists an
 * immutable materialization of every terminal (settled/cancelled) Round in the
 * private Store, keeps a bounded "live" set of non-terminal Round ids, and
 * coalesces concurrent reads, so:
 *
 *   - terminal rows are fetched from the chain exactly once, then served from
 *     SQLite forever (survives restart);
 *   - the first request bootstraps full history once; later requests only
 *     re-read the live set, throttled by a TTL;
 *   - per-account balance/native reads are coalesced (concurrent callers share
 *     one in-flight RPC), throttled, and failures surface as null (never a
 *     fabricated zero);
 *   - finalized transaction receipts (gas) are cached immutably in SQLite once
 *     observed FINAL;
 *   - pagination stays finite; the live set is bounded by a hard cap so an
 *     operator creating many future scheduled Questions cannot make each
 *     request walk unbounded history.
 */

import type { ChainClient, TxFinalStatusView } from './chain/types.js';
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
}

interface TerminalData {
  question: QuestionView;
  commitments: CommitmentView[];
}

const LIST_PAGE_LIMIT = 100;
const COMMITMENT_PAGE_LIMIT = 64;
const BOOTSTRAP_COUNT_KEY = 'public_bootstrapped_count';
const LIVE_IDS_KEY = 'public_live_ids';
const MAX_LIVE_ROUNDS = 256;

export class PublicChainCache implements PublicReadSource {
  private chain: ChainClient;
  private store: Store;
  private liveTtlMs: number;
  private balanceTtlMs: number;

  private liveCommitments = new Map<number, { at: number; rows: CommitmentView[] }>();
  private liveQuestionsCache: { at: number; rows: QuestionView[] } | null = null;

  private balanceCache = new Map<string, { at: number; value: BalanceView | null }>();
  private nativeCache = new Map<string, { at: number; total: bigint | null; available: bigint | null }>();

  // In-flight coalescing: concurrent callers share one pending RPC per key.
  private balanceInflight = new Map<string, Promise<BalanceView | null>>();
  private nativeInflight = new Map<string, Promise<{ total: bigint | null; available: bigint | null }>>();
  private txInflight = new Map<string, Promise<string | null>>();

  constructor(chain: ChainClient, store: Store, opts?: { liveTtlMs?: number; balanceTtlMs?: number }) {
    this.chain = chain;
    this.store = store;
    this.liveTtlMs = opts?.liveTtlMs ?? 15_000;
    this.balanceTtlMs = opts?.balanceTtlMs ?? 30_000;
  }

  private readLiveIds(): number[] {
    const raw = this.store.getMeta(LIVE_IDS_KEY);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw) as unknown[];
      return arr.filter((x): x is number => typeof x === 'number');
    } catch {
      return [];
    }
  }

  private writeLiveIds(ids: number[]): void {
    this.store.setMeta(LIVE_IDS_KEY, JSON.stringify(ids));
  }

  private readBootstrappedCount(): number {
    const raw = this.store.getMeta(BOOTSTRAP_COUNT_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  private writeBootstrappedCount(n: number): void {
    this.store.setMeta(BOOTSTRAP_COUNT_KEY, String(n));
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

  private async materialize(q: QuestionView): Promise<TerminalData> {
    const commitments = await this.fetchCommitments(q.question_id, q.participant_count);
    const data: TerminalData = { question: q, commitments };
    this.store.savePublicTerminalRound(q.question_id, q.phase as 'settled' | 'cancelled', JSON.stringify(data));
    return data;
  }

  private persistedTerminal(): TerminalData[] {
    return this.store
      .listPublicTerminalRounds()
      .map((r) => JSON.parse(r.dataJson) as TerminalData);
  }

  isFullyBootstrapped(): boolean {
    return this.readBootstrappedCount() > 0;
  }

  async listAllQuestions(): Promise<QuestionView[]> {
    // Incremental bootstrap: read only the NEW tail since the last bootstrap.
    // The tail is read from the chain exactly once and terminal rows are
    // materialized into SQLite; only the bounded live set is re-read.
    const state = await this.chain.getContractState();
    const total = state.question_count;
    const bootstrapped = this.readBootstrappedCount();

    if (bootstrapped < total) {
      const tail: QuestionView[] = [];
      for (let from = bootstrapped; from < total; from += LIST_PAGE_LIMIT) {
        const page = await this.chain.listQuestions(from, Math.min(LIST_PAGE_LIMIT, total - from));
        tail.push(...page);
        if (page.length < LIST_PAGE_LIMIT) break;
      }
      let liveIds = new Set(this.readLiveIds());
      for (const q of tail) {
        if (q.phase === 'settled' || q.phase === 'cancelled') {
          await this.materialize(q);
          liveIds.delete(q.question_id);
        } else {
          liveIds.add(q.question_id);
        }
      }
      this.writeBootstrappedCount(total);
      // Bound the live set (future scheduled Questions cannot grow it unbounded).
      this.writeLiveIds([...liveIds].sort((a, b) => a - b).slice(-MAX_LIVE_ROUNDS));
    }

    // Re-read only the bounded live set to catch phase transitions, throttled.
    const now = Date.now();
    let liveRows: QuestionView[];
    if (this.liveQuestionsCache && now - this.liveQuestionsCache.at < this.liveTtlMs) {
      liveRows = this.liveQuestionsCache.rows;
    } else {
      const liveIds = this.readLiveIds();
      const rows: QuestionView[] = [];
      for (const id of liveIds.sort((a, b) => a - b)) {
        const q = await this.chain.getQuestion(id);
        if (!q) continue;
        if (q.phase === 'settled' || q.phase === 'cancelled') {
          await this.materialize(q);
        } else {
          rows.push(q);
        }
      }
      this.writeLiveIds(rows.map((r) => r.question_id));
      this.liveQuestionsCache = { at: now, rows };
      liveRows = rows;
    }

    // Compose: persisted terminal rounds (ascending) + bounded live set.
    const terminal = this.persistedTerminal().map((t) => t.question);
    return [...terminal, ...liveRows].sort((a, b) => a.question_id - b.question_id);
  }

  async listAllCommitments(questionId: number): Promise<CommitmentView[]> {
    const persisted = this.store.getPublicTerminalRound(questionId);
    if (persisted) {
      return (JSON.parse(persisted.dataJson) as TerminalData).commitments;
    }
    // Live round: short TTL.
    const now = Date.now();
    const cached = this.liveCommitments.get(questionId);
    if (cached && now - cached.at < this.liveTtlMs) return cached.rows;
    const q = await this.chain.getQuestion(questionId);
    const rows = q ? await this.fetchCommitments(questionId, q.participant_count) : [];
    this.liveCommitments.set(questionId, { at: now, rows });
    return rows;
  }

  async getBalance(accountId: string): Promise<BalanceView | null> {
    const now = Date.now();
    const cached = this.balanceCache.get(accountId);
    if (cached && now - cached.at < this.balanceTtlMs) return cached.value;

    // Coalesce concurrent callers into one in-flight RPC.
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
    if (cached && now - cached.at < this.balanceTtlMs) return cached;

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
    // Immutable once FINAL: serve from SQLite when already cached.
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
    // A private-DB read failure MUST propagate (the caller reports the account
    // unavailable), never fabricate a zero reservation that overstates
    // spendable balance.
    return this.store.totalReserved(accountId);
  }
}
