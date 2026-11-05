/**
 * EmulatedChainClient — an in-process faithful re-implementation of the
 * HiveCast contract state machine for cross-platform sandbox scenarios.
 *
 * This is NOT a mock-success stub. It enforces the same phase windows,
 * one-final-commit-per-account, reveal hash matching, exactly-once withdrawal
 * (pending → delivered/restored), and refund rules as the deployed contract, so
 * lifecycle and restart behavior can be exercised on any platform (the real
 * Linux sandbox requires near-vm-runner tooling absent on Windows).
 *
 * A mutable clock (`nowNs`) drives phase transitions; `failWithdrawals` makes
 * the async transfer fail so pending → restored recovery can be tested.
 */

import { createHash } from 'node:crypto';
import { commitmentHash as computeHash } from '../commitment.js';
import type {
  BalanceView,
  BuyerReceiptView,
  CommitmentView,
  ContractState,
  PendingWithdrawalView,
  QuestionView,
} from '../types.js';
import type { CallOutcome, ChainClient, QuestionSpecArgs } from './types.js';

interface QuestionState {
  question_id: number;
  text: string;
  event_definition: string;
  source: string;
  resolver: string;
  open_time: bigint;
  close_time: bigint;
  observation_start: bigint;
  observation_end: bigint;
  resolve_time: bigint;
  resolve_deadline: bigint;
  reveal_window: bigint;
  access_price: bigint;
  min_stake: bigint;
  outcome: boolean | null;
  resolved_at: bigint | null;
  reveal_deadline: bigint | null;
  snapshot_ready: boolean;
  snapshot_id: string | null;
  fee_pool: bigint;
  settled: boolean;
  cancelled: boolean;
}

interface CommitmentState {
  question_id: number;
  account_id: string;
  stake: bigint;
  hash: string;
  revealed: number | null;
}

interface BuyerState {
  question_id: number;
  account_id: string;
  price: bigint;
  refunded: boolean;
}

interface OwnerBalance {
  claimable: bigint;
  pending: bigint;
  received: bigint;
}

interface PendingState {
  nonce: number;
  account_id: string;
  amount: bigint;
  status: 'pending' | 'delivered' | 'restored';
}

const MAX_PARTICIPANTS = 64;

export interface EmulatedOptions {
  /** Account ids that may act as operator (create_question / publish_snapshot). */
  operator: string;
  /** Clock in UTC ns; advance with `setNow`. */
  nowNs?: bigint;
  /** When true, async withdrawal transfers fail → pending restored. */
  failWithdrawals?: boolean;
  /** Native balances for `viewAccountBalance` (yoctoNEAR), seeded per account. */
  nativeBalances?: Record<string, bigint>;
}

export class EmulatedChainClient implements ChainClient {
  readonly mode = 'emulated' as const;
  readonly contractId: string;
  private operator: string;
  private _nowNs: bigint;
  private failWithdrawals: boolean;
  private nativeBalances: Map<string, bigint>;

  private nextQuestionId = 0;
  private nextNonce = 0;
  private questions = new Map<number, QuestionState>();
  private commitments = new Map<string, CommitmentState>();
  private buyers = new Map<string, BuyerState>();
  private balances = new Map<string, OwnerBalance>();
  private pendings = new Map<number, PendingState>();

  constructor(contractId: string, options: EmulatedOptions) {
    this.contractId = contractId;
    this.operator = options.operator;
    this._nowNs = options.nowNs ?? 0n;
    this.failWithdrawals = options.failWithdrawals ?? false;
    this.nativeBalances = new Map(Object.entries(options.nativeBalances ?? {}));
  }

  nowNs(): bigint {
    return this._nowNs;
  }

  setNow(ns: bigint): void {
    this._nowNs = ns;
  }

  setFailWithdrawals(v: boolean): void {
    this.failWithdrawals = v;
  }

  private key(qid: number, accountId: string): string {
    return `${qid}:${accountId}`;
  }

  private commitmentsFor(qid: number): CommitmentState[] {
    return [...this.commitments.values()]
      .filter((c) => c.question_id === qid)
      .sort((a, b) => a.account_id.localeCompare(b.account_id));
  }

  private buyersFor(qid: number): BuyerState[] {
    return [...this.buyers.values()]
      .filter((b) => b.question_id === qid)
      .sort((a, b) => a.account_id.localeCompare(b.account_id));
  }

  private balance(accountId: string): OwnerBalance {
    let b = this.balances.get(accountId);
    if (!b) {
      b = { claimable: 0n, pending: 0n, received: 0n };
      this.balances.set(accountId, b);
    }
    return b;
  }

  private phase(q: QuestionState): QuestionView['phase'] {
    if (q.cancelled) return 'cancelled';
    if (q.settled) return 'settled';
    if (q.outcome !== null) return 'resolved';
    if (this._nowNs >= q.close_time) return 'closed';
    return 'open';
  }

  private view(q: QuestionState): QuestionView {
    const commits = this.commitmentsFor(q.question_id);
    const totalStake = commits.reduce((s, c) => s + c.stake, 0n);
    const participantCount = commits.length;
    const buyerCount = this.buyersFor(q.question_id).length;
    return {
      question_id: q.question_id,
      text: q.text,
      event_definition: q.event_definition,
      source: q.source,
      resolver: q.resolver,
      open_time: q.open_time.toString(),
      close_time: q.close_time.toString(),
      observation_start: q.observation_start.toString(),
      observation_end: q.observation_end.toString(),
      resolve_time: q.resolve_time.toString(),
      resolve_deadline: q.resolve_deadline.toString(),
      reveal_window: q.reveal_window.toString(),
      access_price: q.access_price.toString(),
      min_stake: q.min_stake.toString(),
      phase: this.phase(q),
      outcome: q.outcome,
      resolved_at: q.resolved_at === null ? null : q.resolved_at.toString(),
      reveal_deadline: q.reveal_deadline === null ? null : q.reveal_deadline.toString(),
      snapshot_ready: q.snapshot_ready,
      snapshot_id: q.snapshot_id,
      total_stake: totalStake.toString(),
      fee_pool: q.fee_pool.toString(),
      participant_count: participantCount,
      buyer_count: buyerCount,
    };
  }

  private ok(result: unknown): CallOutcome {
    return { txHash: null, success: true, result, error: null };
  }

  private fail(error: string): CallOutcome {
    return { txHash: null, success: false, result: null, error };
  }

  private requireOperator(signer: string): string | null {
    if (signer !== this.operator) return 'Only the operator may call this method';
    return null;
  }

  getContractState(): Promise<ContractState> {
    return Promise.resolve({
      operator: this.operator,
      next_question_id: this.nextQuestionId,
      next_nonce: this.nextNonce,
      question_count: this.questions.size,
    });
  }

  getQuestion(questionId: number): Promise<QuestionView | null> {
    const q = this.questions.get(questionId);
    return Promise.resolve(q ? this.view(q) : null);
  }

  listQuestions(fromIndex: number, limit: number): Promise<QuestionView[]> {
    const all = [...this.questions.keys()].sort((a, b) => a - b);
    const page = all.slice(fromIndex, fromIndex + Math.max(1, Math.min(100, limit)));
    return Promise.resolve(page.map((id) => this.view(this.questions.get(id)!)));
  }

  getCommitment(questionId: number, accountId: string): Promise<CommitmentView | null> {
    const c = this.commitments.get(this.key(questionId, accountId));
    return Promise.resolve(
      c
        ? {
            question_id: c.question_id,
            account_id: c.account_id,
            stake: c.stake.toString(),
            hash: c.hash,
            revealed: c.revealed,
          }
        : null,
    );
  }

  listCommitments(questionId: number, fromIndex: number, limit: number): Promise<CommitmentView[]> {
    const rows = [...this.commitments.values()]
      .filter((c) => c.question_id === questionId)
      .sort((a, b) => a.account_id.localeCompare(b.account_id));
    const page = rows.slice(fromIndex, fromIndex + Math.max(1, Math.min(64, limit)));
    return Promise.resolve(
      page.map((c) => ({
        question_id: c.question_id,
        account_id: c.account_id,
        stake: c.stake.toString(),
        hash: c.hash,
        revealed: c.revealed,
      })),
    );
  }

  getBalance(accountId: string): Promise<BalanceView> {
    const b = this.balance(accountId);
    return Promise.resolve({
      account_id: accountId,
      claimable: b.claimable.toString(),
      pending: b.pending.toString(),
      received: b.received.toString(),
    });
  }

  hasBought(questionId: number, accountId: string): Promise<boolean> {
    return Promise.resolve(this.buyers.has(this.key(questionId, accountId)));
  }

  getBuyerReceipt(questionId: number, accountId: string): Promise<BuyerReceiptView | null> {
    const b = this.buyers.get(this.key(questionId, accountId));
    return Promise.resolve(
      b
        ? { question_id: b.question_id, account_id: b.account_id, price: b.price.toString(), refunded: b.refunded }
        : null,
    );
  }

  listBuyers(questionId: number, fromIndex: number, limit: number): Promise<BuyerReceiptView[]> {
    const rows = [...this.buyers.values()]
      .filter((b) => b.question_id === questionId)
      .sort((a, b) => a.account_id.localeCompare(b.account_id));
    const page = rows.slice(fromIndex, fromIndex + Math.max(1, Math.min(100, limit)));
    return Promise.resolve(
      page.map((b) => ({
        question_id: b.question_id,
        account_id: b.account_id,
        price: b.price.toString(),
        refunded: b.refunded,
      })),
    );
  }

  getPendingWithdrawal(nonce: number): Promise<PendingWithdrawalView | null> {
    const p = this.pendings.get(nonce);
    return Promise.resolve(
      p
        ? { nonce: p.nonce, account_id: p.account_id, amount: p.amount.toString(), status: p.status }
        : null,
    );
  }

  listPendingWithdrawals(accountId: string, fromIndex: number, limit: number): Promise<PendingWithdrawalView[]> {
    const rows = [...this.pendings.values()]
      .filter((p) => p.account_id === accountId)
      .sort((a, b) => a.nonce - b.nonce);
    const page = rows.slice(fromIndex, fromIndex + Math.max(1, Math.min(100, limit)));
    return Promise.resolve(
      page.map((p) => ({ nonce: p.nonce, account_id: p.account_id, amount: p.amount.toString(), status: p.status })),
    );
  }

  async viewAccountBalance(accountId: string): Promise<bigint> {
    return this.nativeBalances.get(accountId) ?? 0n;
  }

  async createQuestion(spec: QuestionSpecArgs, signer: string): Promise<CallOutcome> {
    const err = this.requireOperator(signer);
    if (err) return this.fail(err);
    const open = BigInt(spec.open_time);
    const close = BigInt(spec.close_time);
    const obsStart = BigInt(spec.observation_start);
    const obsEnd = BigInt(spec.observation_end);
    const resolveTime = spec.resolve_time === null ? obsEnd : BigInt(spec.resolve_time);
    const resolveDeadline = BigInt(spec.resolve_deadline);
    const revealWindow = BigInt(spec.reveal_window);
    if (!(open < close && close < obsStart && obsStart < obsEnd && obsEnd <= resolveTime && resolveTime < resolveDeadline)) {
      return this.fail('Invalid schedule ordering');
    }
    if (revealWindow <= 0n) return this.fail('Reveal window must be positive');
    const qid = this.nextQuestionId++;
    this.questions.set(qid, {
      question_id: qid,
      text: spec.text,
      event_definition: spec.event_definition,
      source: spec.source,
      resolver: spec.resolver,
      open_time: open,
      close_time: close,
      observation_start: obsStart,
      observation_end: obsEnd,
      resolve_time: resolveTime,
      resolve_deadline: resolveDeadline,
      reveal_window: revealWindow,
      access_price: BigInt(spec.access_price),
      min_stake: BigInt(spec.min_stake),
      outcome: null,
      resolved_at: null,
      reveal_deadline: null,
      snapshot_ready: false,
      snapshot_id: null,
      fee_pool: 0n,
      settled: false,
      cancelled: false,
    });
    return this.ok(qid);
  }

  async commit(questionId: number, hash: string, stakeYocto: bigint, signer: string): Promise<CallOutcome> {
    const q = this.questions.get(questionId);
    if (!q) return this.fail('Question not found');
    if (q.outcome !== null || q.settled || q.cancelled) return this.fail('Round is not accepting commitments');
    if (this._nowNs < q.open_time || this._nowNs >= q.close_time) return this.fail('Commitment outside open window');
    if (stakeYocto < q.min_stake) return this.fail('Stake below minimum');
    if (this.commitments.has(this.key(questionId, signer))) return this.fail('Account already committed');
    if (this.commitmentsFor(questionId).length >= MAX_PARTICIPANTS) {
      return this.fail('Participant cap reached');
    }
    this.commitments.set(this.key(questionId, signer), {
      question_id: questionId,
      account_id: signer,
      stake: stakeYocto,
      hash,
      revealed: null,
    });
    return this.ok(null);
  }

  async publishSnapshot(questionId: number, snapshotId: string, signer: string): Promise<CallOutcome> {
    const err = this.requireOperator(signer);
    if (err) return this.fail(err);
    const q = this.questions.get(questionId);
    if (!q) return this.fail('Question not found');
    if (q.outcome !== null || q.settled || q.cancelled) return this.fail('Round is not open for snapshot');
    if (this._nowNs < q.close_time || this._nowNs >= q.observation_start) return this.fail('Snapshot outside window');
    if (this.commitmentsFor(questionId).length === 0) return this.fail('Empty round');
    q.snapshot_ready = true;
    q.snapshot_id = snapshotId;
    return this.ok(null);
  }

  async buyForecast(questionId: number, priceYocto: bigint, signer: string): Promise<CallOutcome> {
    const q = this.questions.get(questionId);
    if (!q) return this.fail('Question not found');
    if (q.outcome !== null || q.settled || q.cancelled) return this.fail('Round is not open for purchase');
    if (!q.snapshot_ready) return this.fail('Snapshot not ready');
    if (this._nowNs < q.close_time || this._nowNs >= q.observation_start) return this.fail('Purchase outside window');
    if (priceYocto !== q.access_price) return this.fail('Incorrect access price');
    if (this.buyers.has(this.key(questionId, signer))) return this.fail('Already bought');
    this.buyers.set(this.key(questionId, signer), {
      question_id: questionId,
      account_id: signer,
      price: priceYocto,
      refunded: false,
    });
    q.fee_pool += priceYocto;
    return this.ok(null);
  }

  async resolve(questionId: number, outcome: boolean, signer: string): Promise<CallOutcome> {
    const q = this.questions.get(questionId);
    if (!q) return this.fail('Question not found');
    if (signer !== q.resolver) return this.fail('Only the resolver may resolve');
    if (q.outcome !== null || q.settled || q.cancelled) return this.fail('Already resolved or terminal');
    if (this._nowNs < q.resolve_time || this._nowNs >= q.resolve_deadline) return this.fail('Resolve outside window');
    q.outcome = outcome;
    q.resolved_at = this._nowNs;
    q.reveal_deadline = this._nowNs + q.reveal_window;
    return this.ok(null);
  }

  async reveal(questionId: number, probBps: number, salt: string, signer: string): Promise<CallOutcome> {
    const q = this.questions.get(questionId);
    if (!q) return this.fail('Question not found');
    if (q.outcome === null) return this.fail('Round not resolved');
    if (q.settled || q.cancelled) return this.fail('Round is terminal');
    const revealDeadline = q.reveal_deadline;
    if (revealDeadline === null || this._nowNs >= revealDeadline) return this.fail('Reveal deadline passed');
    if (probBps < 0 || probBps > 10_000) return this.fail('Probability out of range');
    const c = this.commitments.get(this.key(questionId, signer));
    if (!c) return this.fail('No commitment for this account');
    if (c.revealed !== null) return this.fail('Already revealed');
    const expected = computeHash({
      contractId: this.contractId,
      questionId,
      accountId: signer,
      stakeYocto: c.stake,
      probBps,
      salt,
    });
    if (expected !== c.hash) return this.fail('Reveal does not match commitment');
    c.revealed = probBps;
    return this.ok(null);
  }

  async settle(questionId: number, _signer: string): Promise<CallOutcome> {
    const q = this.questions.get(questionId);
    if (!q) return this.fail('Question not found');
    if (q.outcome === null) return this.fail('Not resolved yet');
    if (q.settled || q.cancelled) return this.fail('Round is terminal');
    const revealDeadline = q.reveal_deadline;
    if (revealDeadline === null || this._nowNs < revealDeadline) return this.fail('Reveal deadline not reached');

    // Faithful payout allocation (mirrors scoring.rs + core/accounting.ts).
    const commitments = this.commitmentsFor(questionId);
    const S = 100_000_000n;
    const W = commitments.reduce((s, c) => s + BigInt(c.stake), 0n);
    const outcomeBps = q.outcome ? 10_000 : 0;
    const scored = commitments.map((c) => {
      const stake = BigInt(c.stake);
      const valid = c.revealed !== null;
      const prob = valid ? (c.revealed as number) : 0;
      const diff = BigInt(prob) - BigInt(outcomeBps);
      const score = valid ? S - diff * diff : 0n;
      return { accountId: c.account_id, stake, valid, score, prob };
    });
    const A = scored.reduce((s, p) => s + p.stake * p.score, 0n);
    const denom = W * S;

    const basePayout = new Map<string, bigint>();
    const baseFloor = new Map<string, bigint>();
    const baseFrac = new Map<string, { frac: bigint; denom: bigint }>();
    let baseAllocated = 0n;
    for (const p of scored) {
      const num = p.stake * (W * S + W * p.score - A);
      const floor = num / denom;
      baseFloor.set(p.accountId, floor);
      baseFrac.set(p.accountId, { frac: num % denom, denom });
      baseAllocated += floor;
    }
    let baseRemainder = W - baseAllocated;
    const baseSorted = [...scored].sort((a, b) => {
      const fa = baseFrac.get(a.accountId)!;
      const fb = baseFrac.get(b.accountId)!;
      if (fa.frac !== fb.frac) return fa.frac > fb.frac ? -1 : 1;
      return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
    });
    for (const p of baseSorted) basePayout.set(p.accountId, baseFloor.get(p.accountId)!);
    for (let i = 0; i < Number(baseRemainder) && i < baseSorted.length; i++) {
      const acc = baseSorted[i]!.accountId;
      basePayout.set(acc, (basePayout.get(acc) ?? 0n) + 1n);
    }

    const revealers = scored.filter((p) => p.valid);
    const V = revealers.reduce((s, p) => s + p.stake, 0n);
    let feePayout = new Map<string, bigint>();
    if (V > 0n) {
      const feeFloor = new Map<string, bigint>();
      const feeFrac = new Map<string, bigint>();
      let feeAllocated = 0n;
      for (const p of revealers) {
        const num = q.fee_pool * p.stake;
        const floor = num / V;
        feeFloor.set(p.accountId, floor);
        feeFrac.set(p.accountId, num % V);
        feeAllocated += floor;
      }
      let feeRemainder = q.fee_pool - feeAllocated;
      const feeSorted = [...revealers].sort((a, b) => {
        const fa = feeFrac.get(a.accountId)!;
        const fb = feeFrac.get(b.accountId)!;
        if (fa !== fb) return fa > fb ? -1 : 1;
        return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
      });
      for (const p of feeSorted) feePayout.set(p.accountId, feeFloor.get(p.accountId)!);
      for (let i = 0; i < Number(feeRemainder) && i < feeSorted.length; i++) {
        const acc = feeSorted[i]!.accountId;
        feePayout.set(acc, (feePayout.get(acc) ?? 0n) + 1n);
      }
    }

    for (const p of scored) {
      const b = this.balance(p.accountId);
      b.claimable += basePayout.get(p.accountId) ?? 0n;
      b.claimable += feePayout.get(p.accountId) ?? 0n;
    }
    q.settled = true;
    return this.ok(null);
  }

  async cancel(questionId: number, _signer: string): Promise<CallOutcome> {
    const q = this.questions.get(questionId);
    if (!q) return this.fail('Question not found');
    if (q.settled || q.cancelled) return this.fail('Round is terminal');
    const commitments = this.commitmentsFor(questionId);
    const eligible =
      commitments.length === 0 && this._nowNs >= q.close_time;
    const timeout = q.outcome === null && this._nowNs >= q.resolve_deadline;
    if (!eligible && !timeout) return this.fail('Round not eligible for cancellation');

    for (const c of commitments) {
      const b = this.balance(c.account_id);
      b.claimable += BigInt(c.stake);
    }
    // Buyers' fee becomes claimable via claim_buyer_refund (not auto-credited).
    q.cancelled = true;
    return this.ok(null);
  }

  async claimBuyerRefund(questionId: number, signer: string): Promise<CallOutcome> {
    const q = this.questions.get(questionId);
    if (!q) return this.fail('Question not found');
    const buyer = this.buyers.get(this.key(questionId, signer));
    if (!buyer) return this.fail('No buyer receipt for this account');
    if (buyer.refunded) return this.fail('Refund already claimed');
    if (!q.cancelled && !(q.settled && this.commitmentsFor(questionId).every((c) => c.revealed === null))) {
      return this.fail('Refund not eligible');
    }
    buyer.refunded = true;
    const b = this.balance(signer);
    b.claimable += buyer.price;
    return this.ok(null);
  }

  async withdraw(amountYocto: bigint, signer: string): Promise<CallOutcome> {
    const b = this.balance(signer);
    if (amountYocto <= 0n) return this.fail('Amount must be positive');
    if (amountYocto > b.claimable) return this.fail('Amount exceeds claimable balance');
    const nonce = this.nextNonce++;
    b.claimable -= amountYocto;
    b.pending += amountYocto;
    const pending: PendingState = { nonce, account_id: signer, amount: amountYocto, status: 'pending' };
    this.pendings.set(nonce, pending);
    if (this.failWithdrawals) {
      // Simulate the private callback reporting transfer failure.
      pending.status = 'restored';
      b.pending -= amountYocto;
      b.claimable += amountYocto;
    } else {
      pending.status = 'delivered';
      b.pending -= amountYocto;
      b.received += amountYocto;
      const native = this.nativeBalances.get(signer) ?? 0n;
      this.nativeBalances.set(signer, native + amountYocto);
    }
    return this.ok(null);
  }
}
