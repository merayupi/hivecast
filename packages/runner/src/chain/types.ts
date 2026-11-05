/**
 * ChainClient — the runner's only dependency on chain state and mutation.
 *
 * The single execution implementation is `NearChainClient` (real NEAR RPC +
 * ed25519 signing). A "real sandbox" is an actual `near-sandbox` RPC endpoint +
 * WASM, reachable by pointing `rpcUrl` at it; there is no in-process duplicate
 * of the contract. Transaction finality waits for `FINAL` and only a proven
 * `SuccessValue` is treated as success.
 */

import type {
  BalanceView,
  BuyerReceiptView,
  CommitmentView,
  ContractState,
  PendingWithdrawalView,
  QuestionView,
} from '../types.js';

export interface CallOutcome {
  /** Transaction hash (base58) when one was produced, else null. */
  txHash: string | null;
  success: boolean;
  /** Parsed JSON return value (e.g. question_id from create_question). */
  result: unknown;
  error: string | null;
  /**
   * 'success' — proven SuccessValue; 'failure' — included and definitively
   * failed; 'uncertain' — included with no proven SuccessValue/Failure, or a
   * network error whose inclusion status is unknown. `uncertain` must NOT be
   * treated as "nothing happened" (see the runner's rebroadcast-same-signed-tx
   * reconciliation).
   */
  status: 'success' | 'failure' | 'uncertain';
}

/** A prepared, signed-but-not-broadcast transaction. */
export interface PreparedCall {
  signedBytesBase64: string;
  txHash: string;
  nonce: string;
}

/** `create_question` wire args (decimal strings per the contract). */
export interface QuestionSpecArgs {
  text: string;
  event_definition: string;
  source: string;
  resolver: string;
  open_time: string;
  close_time: string;
  observation_start: string;
  observation_end: string;
  resolve_time: string | null;
  resolve_deadline: string;
  reveal_window: string;
  access_price: string;
  min_stake: string;
}

export interface ChainClient {
  readonly contractId: string;
  /** Current time in UTC ns (wall clock). */
  nowNs(): bigint;

  // Views
  getContractState(): Promise<ContractState>;
  getQuestion(questionId: number): Promise<QuestionView | null>;
  listQuestions(fromIndex: number, limit: number): Promise<QuestionView[]>;
  getCommitment(questionId: number, accountId: string): Promise<CommitmentView | null>;
  listCommitments(questionId: number, fromIndex: number, limit: number): Promise<CommitmentView[]>;
  getBalance(accountId: string): Promise<BalanceView>;
  hasBought(questionId: number, accountId: string): Promise<boolean>;
  getBuyerReceipt(questionId: number, accountId: string): Promise<BuyerReceiptView | null>;
  listBuyers(questionId: number, fromIndex: number, limit: number): Promise<BuyerReceiptView[]>;
  getPendingWithdrawal(nonce: number): Promise<PendingWithdrawalView | null>;
  listPendingWithdrawals(accountId: string, fromIndex: number, limit: number): Promise<PendingWithdrawalView[]>;
  /** Native NEAR balance of an account (yoctoNEAR). */
  viewAccountBalance(accountId: string): Promise<bigint>;

  /**
   * Build + sign a contract call WITHOUT broadcasting. Persisting its bytes
   * before `broadcastCall` makes every mutation crash-safe: while the outcome
   * is uncertain, the runner rebroadcasts THIS same signed transaction instead
   * of re-signing (which could double-spend a fresh nonce).
   */
  prepareCall(
    methodName: string,
    args: Record<string, unknown>,
    signer: string,
    deposit: bigint,
    gas?: bigint,
  ): Promise<PreparedCall>;

  /** Broadcast a previously prepared (signed) transaction. */
  broadcastCall(signedBytesBase64: string): Promise<CallOutcome>;

  // Mutations (sign + send). `signer` is an account id.
  createQuestion(spec: QuestionSpecArgs, signer: string): Promise<CallOutcome>;
  commit(questionId: number, hash: string, stakeYocto: bigint, signer: string): Promise<CallOutcome>;
  publishSnapshot(questionId: number, snapshotId: string, signer: string): Promise<CallOutcome>;
  buyForecast(questionId: number, priceYocto: bigint, signer: string): Promise<CallOutcome>;
  resolve(questionId: number, outcome: boolean, signer: string): Promise<CallOutcome>;
  reveal(questionId: number, probBps: number, salt: string, signer: string): Promise<CallOutcome>;
  settle(questionId: number, signer: string): Promise<CallOutcome>;
  cancel(questionId: number, signer: string): Promise<CallOutcome>;
  claimBuyerRefund(questionId: number, signer: string): Promise<CallOutcome>;
  withdraw(amountYocto: bigint, signer: string): Promise<CallOutcome>;
}
