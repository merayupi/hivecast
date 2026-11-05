/**
 * ChainClient — the runner's only dependency on chain state and mutation.
 *
 * Two implementations exist:
 *   - `NearChainClient`  : real NEAR RPC + ed25519 signing (production).
 *   - `EmulatedChainClient` : an in-process, faithful re-implementation of the
 *     contract's public state machine, used as the cross-platform sandbox for
 *     lifecycle/restart scenarios. It is NOT a mock-success stub: it enforces
 *     phase windows, one-commit-per-account, reveal hash matching, exactly-once
 *     withdrawal via pending→delivered/restored, and can be told to fail
 *     transfers.
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
  readonly mode: 'rpc' | 'emulated';
  /** Current time in UTC ns (emulated clock for sandbox, wall clock otherwise). */
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
