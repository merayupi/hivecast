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
  /**
   * True when the chain DEFINITIVELY rejected this transaction with an
   * InvalidNonceError (stale nonce — another signer/process consumed the
   * cached nonce). The transaction was NOT included. The caller must evict the
   * account's nonce cache and re-prepare a FRESH signed transaction for the
   * SAME business intent (never re-sign an arbitrary timeout).
   */
  nonceStale?: boolean;
  /**
   * True when the chain DEFINITIVELY rejected this transaction with a
   * TransactionExpiredError (the signed tx's blockHash reference went stale —
   * e.g. a sandbox fast-forward produced many blocks between prepare and
   * rebroadcast). The transaction was NOT included and will NEVER be accepted
   * on rebroadcast of the same signed bytes. The caller must re-prepare a
   * FRESH signed tx (new blockHash) for the SAME intent.
   */
  txExpired?: boolean;
}

/** A prepared, signed-but-not-broadcast transaction. */
export interface PreparedCall {
  signedBytesBase64: string;
  txHash: string;
  nonce: string;
}

/** Finalized public transaction receipt projection (read-only). */
export interface TxFinalStatusView {
  tx_hash: string;
  /** Raw chain `final_execution_status` (only meaningful when `FINAL`). */
  final_execution_status: string;
  /** True only when the call produced a proven `SuccessValue`. */
  success_value: boolean;
  /** yoctoNEAR gas cost as a decimal string, or null when unobservable. */
  tokens_burnt: string | null;
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

  /** Public (keyless) native NEAR balance via `view_account` — no signing key
   * required, suitable for read-only projections over arbitrary accounts. */
  viewNativeBalance(accountId: string): Promise<bigint>;

  /**
   * Public (keyless) native SPENDABLE balance (`amount − locked` storage), the
   * same figure the runner uses as its native base for stake sizing before
   * subtracting operational reserve and private reservations.
   */
  viewNativeAvailable(accountId: string): Promise<bigint>;
  /**
   * Finalized permission of an account access key: `full-access` | `function-call`,
   * or `null` when the account or key definitively does not exist (fail-closed,
   * not ownership proof). Throws `ChainUnavailableError` when the RPC/chain is
   * transiently unavailable — the caller must map that to unavailable, never to
   * a silently-suppressed "no proof".
   */
  viewAccessKeyPermission(accountId: string, publicKey: string): Promise<'full-access' | 'function-call' | null>;

  /**
   * Actual gas cost of a finalized transaction, as `tokens_burnt` yoctoNEAR
   * (decimal string), or `null` when the transaction is not found/finalized.
   * This is the observed chain gas cost — distinct from wagering profit and
   * Query-Fee income.
   */
  viewTxTokensBurnt(txHash: string, signer: string): Promise<string | null>;

  /**
   * Finalized public transaction receipt projection (read-only, keyless):
   * `final_execution_status` is the raw chain status (only meaningful when
   * `FINAL`), `successValue` is true only when the function-call produced a
   * proven `SuccessValue`, and `tokensBurnt` is the yoctoNEAR gas cost (null
   * when not yet finalized/observable). Returns null when the tx is unknown.
   */
  viewTxFinalStatus(txHash: string, accountId: string): Promise<TxFinalStatusView | null>;

  /**
   * Finalized on-chain time of a transaction: the hash and `timestamp_nanosec`
   * (UTC ns decimal string) of the block that includes it. Returns null when
   * the transaction is unknown or not yet FINAL; throws `ChainUnavailableError`
   * on a transient RPC failure (never a guessed time).
   */
  viewTxBlockTime(txHash: string, accountId: string): Promise<{ blockHash: string; timestampNs: string } | null>;

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

  /**
   * Evict the account's cached nonce manager so the next `prepareCall` re-fetches
   * the access-key nonce from chain. Called only after a DEFINITIVE
   * InvalidNonceError rejection (never a timeout/uncertain send).
   */
  evictAccountNonceCache(accountId: string): void;

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
