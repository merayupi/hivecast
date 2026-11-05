/**
 * Shared sandbox environmental ChainClient adapter (test support only, not a
 * production abstraction).
 *
 * Linux-only sandbox harnesses drive the PRODUCTION `Runner` against the real
 * contract WASM on a real `near-sandbox` node. Both harnesses need the SAME
 * mechanical adapter: a block-time clock (`nowNs`/`setNow`) that forwards every
 * view/mutation to the real `NearChainClient` unchanged, so no harness ever
 * fakes contract success. This base owns that forwarding exactly once; each
 * harness subclasses it only to add its scenario-specific behavior (recovery
 * overrides `broadcastCall` to fault-inject a post-acceptance response drop).
 */

import type { NearChainClient } from '../src/chain/near.js';
import type {
  ChainClient,
  CallOutcome,
  PreparedCall,
  QuestionSpecArgs,
  TxFinalStatusView,
} from '../src/chain/types.js';
import type {
  BalanceView,
  BuyerReceiptView,
  CommitmentView,
  ContractState,
  PendingWithdrawalView,
  QuestionView,
} from '../src/types.js';

export class SandboxChainBase implements ChainClient {
  readonly contractId: string;
  protected readonly inner: NearChainClient;
  protected currentNs: bigint;

  constructor(inner: NearChainClient, initialNs: bigint) {
    this.inner = inner;
    this.contractId = inner.contractId;
    this.currentNs = initialNs;
  }

  setNow(ns: bigint): void {
    this.currentNs = ns;
  }

  nowNs(): bigint {
    return this.currentNs;
  }

  getContractState(): Promise<ContractState> {
    return this.inner.getContractState();
  }

  getQuestion(questionId: number): Promise<QuestionView | null> {
    return this.inner.getQuestion(questionId);
  }

  listQuestions(fromIndex: number, limit: number): Promise<QuestionView[]> {
    return this.inner.listQuestions(fromIndex, limit);
  }

  getCommitment(questionId: number, accountId: string): Promise<CommitmentView | null> {
    return this.inner.getCommitment(questionId, accountId);
  }

  listCommitments(questionId: number, fromIndex: number, limit: number): Promise<CommitmentView[]> {
    return this.inner.listCommitments(questionId, fromIndex, limit);
  }

  getBalance(accountId: string): Promise<BalanceView> {
    return this.inner.getBalance(accountId);
  }

  hasBought(questionId: number, accountId: string): Promise<boolean> {
    return this.inner.hasBought(questionId, accountId);
  }

  getBuyerReceipt(questionId: number, accountId: string): Promise<BuyerReceiptView | null> {
    return this.inner.getBuyerReceipt(questionId, accountId);
  }

  listBuyers(questionId: number, fromIndex: number, limit: number): Promise<BuyerReceiptView[]> {
    return this.inner.listBuyers(questionId, fromIndex, limit);
  }

  getPendingWithdrawal(nonce: number): Promise<PendingWithdrawalView | null> {
    return this.inner.getPendingWithdrawal(nonce);
  }

  listPendingWithdrawals(accountId: string, fromIndex: number, limit: number): Promise<PendingWithdrawalView[]> {
    return this.inner.listPendingWithdrawals(accountId, fromIndex, limit);
  }

  viewAccountBalance(accountId: string): Promise<bigint> {
    return this.inner.viewAccountBalance(accountId);
  }

  viewNativeBalance(accountId: string): Promise<bigint> {
    return this.inner.viewNativeBalance(accountId);
  }

  viewNativeAvailable(accountId: string): Promise<bigint> {
    return this.inner.viewNativeAvailable(accountId);
  }

  viewAccessKeyPermission(accountId: string, publicKey: string): Promise<'full-access' | 'function-call' | null> {
    return this.inner.viewAccessKeyPermission(accountId, publicKey);
  }

  viewTxTokensBurnt(txHash: string, signer: string): Promise<string | null> {
    return this.inner.viewTxTokensBurnt(txHash, signer);
  }

  viewTxFinalStatus(txHash: string, accountId: string): Promise<TxFinalStatusView | null> {
    return this.inner.viewTxFinalStatus(txHash, accountId);
  }

  prepareCall(
    methodName: string,
    args: Record<string, unknown>,
    signer: string,
    deposit: bigint,
    gas?: bigint,
  ): Promise<PreparedCall> {
    return this.inner.prepareCall(methodName, args, signer, deposit, gas);
  }

  broadcastCall(signedBytesBase64: string): Promise<CallOutcome> {
    return this.inner.broadcastCall(signedBytesBase64);
  }

  evictAccountNonceCache(accountId: string): void {
    this.inner.evictAccountNonceCache(accountId);
  }

  createQuestion(spec: QuestionSpecArgs, signer: string): Promise<CallOutcome> {
    return this.inner.createQuestion(spec, signer);
  }

  commit(questionId: number, hash: string, stakeYocto: bigint, signer: string): Promise<CallOutcome> {
    return this.inner.commit(questionId, hash, stakeYocto, signer);
  }

  publishSnapshot(questionId: number, snapshotId: string, signer: string): Promise<CallOutcome> {
    return this.inner.publishSnapshot(questionId, snapshotId, signer);
  }

  buyForecast(questionId: number, priceYocto: bigint, signer: string): Promise<CallOutcome> {
    return this.inner.buyForecast(questionId, priceYocto, signer);
  }

  resolve(questionId: number, outcome: boolean, signer: string): Promise<CallOutcome> {
    return this.inner.resolve(questionId, outcome, signer);
  }

  reveal(questionId: number, probBps: number, salt: string, signer: string): Promise<CallOutcome> {
    return this.inner.reveal(questionId, probBps, salt, signer);
  }

  settle(questionId: number, signer: string): Promise<CallOutcome> {
    return this.inner.settle(questionId, signer);
  }

  cancel(questionId: number, signer: string): Promise<CallOutcome> {
    return this.inner.cancel(questionId, signer);
  }

  claimBuyerRefund(questionId: number, signer: string): Promise<CallOutcome> {
    return this.inner.claimBuyerRefund(questionId, signer);
  }

  withdraw(amountYocto: bigint, signer: string): Promise<CallOutcome> {
    return this.inner.withdraw(amountYocto, signer);
  }
}
