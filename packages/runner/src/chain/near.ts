/**
 * NearChainClient — real NEAR RPC views + ed25519 transaction signing.
 *
 * Keys are loaded from the configured credential directory (near CLI JSON
 * layout) or from an in-memory credentials map supplied by the caller (used by
 * tests). Keys are never logged or returned.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, SignedTransaction, actions, baseEncode, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { AccountDoesNotExistError, AccessKeyDoesNotExistError, UnknownTransactionError, InvalidTransactionError } from 'near-api-js/rpc-errors';
import type { RunnerConfig } from '../config.js';
import type {
  BalanceView,
  BuyerReceiptView,
  CommitmentView,
  ContractState,
  PendingWithdrawalView,
  QuestionView,
} from '../types.js';
import type { CallOutcome, ChainClient, PreparedCall, QuestionSpecArgs, TxFinalStatusView } from './types.js';

const DEFAULT_GAS = teraToGas('50');
const SETTLE_GAS = teraToGas('200');

function decodeSignedTransactionBytes(base64: string): SignedTransaction {
  return SignedTransaction.decode(new Uint8Array(Buffer.from(base64, 'base64')));
}

/**
 * Canonical NEAR transaction ID from a base64-encoded SIGNED transaction.
 * NEAR's transaction id = base58(sha256(UNSIGNED transaction bytes)) — the
 * signature is excluded. Decoding the signed bytes and re-encoding only its
 * inner `transaction` yields the canonical id.
 */
export function canonicalTxHashFromSignedBytes(signedBytesBase64: string): string {
  const signed = decodeSignedTransactionBytes(signedBytesBase64);
  const unsignedBytes = signed.transaction.encode();
  return baseEncode(createHash('sha256').update(unsignedBytes).digest());
}

interface Credential {
  account_id: string;
  public_key: string;
  private_key: string;
}

function loadCredentialFile(path: string): Credential {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Credential;
  if (typeof raw.private_key !== 'string' || !raw.private_key.startsWith('ed25519:')) {
    throw new Error(`credential at ${path} has no ed25519 private_key`);
  }
  return raw;
}

function failureMessageOf(status: unknown): string | null {
  if (typeof status !== 'object' || status === null || !('Failure' in status)) return null;
  const failure = status.Failure;
  if (typeof failure === 'object' && failure !== null && 'error_message' in failure) {
    const msg = failure.error_message;
    if (typeof msg === 'string') return msg;
  }
  return null;
}

function isSuccess(status: unknown): boolean {
  // Only a proven SuccessValue is success. Unknown/missing status is NOT success.
  if (typeof status === 'object' && status !== null && 'SuccessValue' in status) return true;
  return false;
}

/** A transient chain/RPC availability failure (distinct from a definitive no-proof). */
export class ChainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainUnavailableError';
  }
}

function extractError(status: unknown, receiptsOutcome: unknown): string | null {
  const top = failureMessageOf(status);
  if (top !== null) return top;
  if (!Array.isArray(receiptsOutcome)) return null;
  for (const r of receiptsOutcome) {
    if (typeof r !== 'object' || r === null || !('outcome' in r)) continue;
    const outcome = r.outcome;
    if (typeof outcome !== 'object' || outcome === null || !('status' in outcome)) continue;
    const msg = failureMessageOf(outcome.status);
    if (msg !== null) return msg;
  }
  return null;
}

export class NearChainClient implements ChainClient {
  readonly contractId: string;
  private provider: JsonRpcProvider;
  private config: RunnerConfig;
  private accounts = new Map<string, Account>();
  private storageCostPerByte: bigint | null = null;

  constructor(config: RunnerConfig) {
    this.contractId = config.contractId;
    this.config = config;
    this.provider = new JsonRpcProvider({ url: config.rpcUrl });
  }

  /** Bound a read-only RPC call so a hanging/rate-limited endpoint surfaces as
   * unavailable (503) within the configured timeout instead of blocking
   * unbounded. */
  private async withReadTimeout<T>(label: string, op: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        op(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ChainUnavailableError(`${label} timed out after ${this.config.rpcTimeoutMs}ms (${this.config.rpcUrl})`)),
            this.config.rpcTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  nowNs(): bigint {
    return BigInt(Date.now()) * 1_000_000n;
  }

  private privateKeyFor(accountId: string): string {
    if (this.config.credentials?.[accountId]) return this.config.credentials[accountId]!;
    const path = `${this.config.credentialDirectory}/${accountId}.json`;
    return loadCredentialFile(path).private_key;
  }

  private account(accountId: string): Account {
    let acc = this.accounts.get(accountId);
    if (!acc) {
      acc = new Account(accountId, this.provider, this.privateKeyFor(accountId) as KeyPairString);
      this.accounts.set(accountId, acc);
    }
    return acc;
  }

  private async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    let result: T | undefined;
    try {
      result = (await this.withReadTimeout(`RPC view ${method}`, () =>
        this.provider.callFunction({
          contractId: this.contractId,
          method,
          args,
          blockQuery: { finality: 'final' },
        }),
      )) as T;
    } catch (err) {
      // Tag transport/view failures clearly so the daemon can report "RPC
      // unavailable" instead of a misleading contract error. No fallback: the
      // caller must retry or wait; state is never invented.
      throw new Error(
        `RPC view ${method} unavailable (${this.config.rpcUrl}): ${(err as Error).message}`,
        { cause: err },
      );
    }
    return result as T;
  }

  /** Build + sign a contract call WITHOUT broadcasting. */
  async prepareCall(
    methodName: string,
    args: Record<string, unknown>,
    signer: string,
    deposit: bigint,
    gas: bigint = DEFAULT_GAS,
  ): Promise<PreparedCall> {
    const account = this.account(signer);
    const signedTx = await account.createSignedTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall(methodName, args, gas, deposit)],
    });
    const signedBytes = signedTx.encode();
    // Canonical NEAR transaction ID = base58(sha256(UNSIGNED transaction
    // bytes)). The signature is EXCLUDED from the hash (a signed transaction
    // encodes signature, so hashing signedBytes would produce a non-canonical
    // id that does not match the chain's transaction hash).
    const txHash = canonicalTxHashFromSignedBytes(Buffer.from(signedBytes).toString('base64'));
    const nonce = String(signedTx.transaction.nonce);
    return {
      signedBytesBase64: Buffer.from(signedBytes).toString('base64'),
      txHash,
      nonce,
    };
  }

  /** Broadcast a previously prepared (signed) transaction and await FINAL. */
  async broadcastCall(signedBytesBase64: string): Promise<CallOutcome> {
    const signedTx = decodeSignedTransactionBytes(signedBytesBase64);
    const canonicalHash = canonicalTxHashFromSignedBytes(signedBytesBase64);
    try {
      const outcome = await this.provider.sendTransactionUntil(signedTx, 'FINAL');
      return this.parseOutcome(outcome as unknown as Record<string, unknown>, canonicalHash);
    } catch (err) {
      // Uncertain network error: inclusion status is unknown. Keep the
      // CANONICAL hash so the journal/receipt lookup stays correct while the
      // runner rebroadcasts the same signed transaction (never re-sign).
      return { txHash: canonicalHash, success: false, result: null, error: (err as Error).message, status: 'uncertain' };
    }
  }

  private parseOutcome(outcome: Record<string, unknown>, canonicalHash?: string): CallOutcome {
    const status = 'status' in outcome ? outcome.status : undefined;
    const receiptsOutcome = 'receipts_outcome' in outcome ? outcome.receipts_outcome : undefined;
    const chainHash =
      'transaction' in outcome &&
      typeof outcome.transaction === 'object' &&
      outcome.transaction !== null &&
      'hash' in outcome.transaction &&
      typeof outcome.transaction.hash === 'string'
        ? outcome.transaction.hash
        : null;
    // Prefer the chain's own hash; fall back to the canonical prepared hash
    // (they must agree for a finalized transaction).
    const txHash = chainHash ?? canonicalHash ?? null;
    const success = isSuccess(status);
    const failErr = extractError(status, receiptsOutcome);
    let result: unknown = null;
    if (success && typeof status === 'object' && status !== null && 'SuccessValue' in status) {
      const sv = status.SuccessValue;
      if (typeof sv === 'string' && sv.length > 0) {
        const bytes = Buffer.from(sv, 'base64').toString('utf8');
        try {
          result = JSON.parse(bytes);
        } catch {
          result = bytes;
        }
      }
    }
    if (success) {
      return { txHash, success: true, result, error: null, status: 'success' };
    }
    if (failErr !== null) {
      return { txHash, success: false, result: null, error: failErr, status: 'failure' };
    }
    // Included but no proven SuccessValue/Failure → uncertain.
    return { txHash, success: false, result: null, error: 'execution status unconfirmed (no SuccessValue)', status: 'uncertain' };
  }

  private async call(
    methodName: string,
    args: Record<string, unknown>,
    signer: string,
    deposit: bigint,
    gas: bigint = DEFAULT_GAS,
  ): Promise<CallOutcome> {
    const prepared = await this.prepareCall(methodName, args, signer, deposit, gas);
    return this.broadcastCall(prepared.signedBytesBase64);
  }

  getContractState(): Promise<ContractState> {
    return this.view<ContractState>('get_contract_state', {});
  }

  async getQuestion(questionId: number): Promise<QuestionView | null> {
    return this.view<QuestionView | null>('get_question', { question_id: questionId });
  }

  async listQuestions(fromIndex: number, limit: number): Promise<QuestionView[]> {
    return this.view<QuestionView[]>('list_questions', { from_index: fromIndex, limit });
  }

  async getCommitment(questionId: number, accountId: string): Promise<CommitmentView | null> {
    return this.view<CommitmentView | null>('get_commitment', { question_id: questionId, account_id: accountId });
  }

  async listCommitments(questionId: number, fromIndex: number, limit: number): Promise<CommitmentView[]> {
    return this.view<CommitmentView[]>('list_commitments', { question_id: questionId, from_index: fromIndex, limit });
  }

  async getBalance(accountId: string): Promise<BalanceView> {
    return this.view<BalanceView>('get_balance', { account_id: accountId });
  }

  async hasBought(questionId: number, accountId: string): Promise<boolean> {
    return this.view<boolean>('has_bought', { question_id: questionId, account_id: accountId });
  }

  async getBuyerReceipt(questionId: number, accountId: string): Promise<BuyerReceiptView | null> {
    return this.view<BuyerReceiptView | null>('get_buyer_receipt', { question_id: questionId, account_id: accountId });
  }

  async listBuyers(questionId: number, fromIndex: number, limit: number): Promise<BuyerReceiptView[]> {
    return this.view<BuyerReceiptView[]>('list_buyers', { question_id: questionId, from_index: fromIndex, limit });
  }

  async getPendingWithdrawal(nonce: number): Promise<PendingWithdrawalView | null> {
    return this.view<PendingWithdrawalView | null>('get_pending_withdrawal', { nonce });
  }

  async listPendingWithdrawals(accountId: string, fromIndex: number, limit: number): Promise<PendingWithdrawalView[]> {
    return this.view<PendingWithdrawalView[]>('list_pending_withdrawals', {
      account_id: accountId,
      from_index: fromIndex,
      limit,
    });
  }

  /** Fetch + cache the protocol storage cost per byte (yoctoNEAR/byte). */
  private async storageCost(): Promise<bigint> {
    if (this.storageCostPerByte !== null) return this.storageCostPerByte;
    const config = await this.provider.experimental_protocolConfig({ finality: 'final' });
    const rc = (config as { runtime_config?: { storage_amount_per_byte?: string | number | bigint } }).runtime_config;
    if (typeof rc !== 'object' || rc === null || rc.storage_amount_per_byte === undefined) {
      throw new Error('protocol runtime_config.storage_amount_per_byte unavailable');
    }
    this.storageCostPerByte = BigInt(rc.storage_amount_per_byte);
    return this.storageCostPerByte;
  }

  /** One keyless `view_account` + protocol cost, returning total + spendable. */
  private async accountNativeState(accountId: string): Promise<{ total: bigint; available: bigint }> {
    const [costPerByte, state] = await Promise.all([
      this.storageCost(),
      this.provider.viewAccount({ accountId, blockQuery: { finality: 'final' } }),
    ]);
    const usedOnStorage = BigInt(state.storage_usage) * costPerByte;
    const locked = BigInt(state.locked);
    const total = BigInt(state.amount) + locked;
    const available = total - (locked > usedOnStorage ? locked : usedOnStorage);
    return { total, available: available < 0n ? 0n : available };
  }

  async viewAccountBalance(accountId: string): Promise<bigint> {
    const acc = this.account(accountId);
    const state = await acc.getState();
    return state.balance.available;
  }

  /** Public keyless native total balance (`amount` + validator `locked`). */
  async viewNativeBalance(accountId: string): Promise<bigint> {
    return (await this.accountNativeState(accountId)).total;
  }

  /** Public keyless native spendable = total − max(validator locked, storage cost). */
  async viewNativeAvailable(accountId: string): Promise<bigint> {
    return (await this.accountNativeState(accountId)).available;
  }

  async viewAccessKeyPermission(accountId: string, publicKey: string): Promise<'full-access' | 'function-call' | null> {
    try {
      const key = await this.provider.viewAccessKey({
        accountId,
        publicKey,
        finalityQuery: { finality: 'final' },
      });
      if (key.permission === 'FullAccess') return 'full-access';
      return 'function-call';
    } catch (err) {
      // Definitive, queryable answers: the account or the key does not exist.
      // These are a definitive "no ownership proof" (null), NOT an outage.
      if (err instanceof AccountDoesNotExistError || err instanceof AccessKeyDoesNotExistError) {
        return null;
      }
      // Any other failure (RPC unreachable, timeout, transient) is a chain
      // availability problem and must surface as unavailable, never as a
      // silently-suppressed "no proof".
      throw new ChainUnavailableError(
        `viewAccessKeyPermission unavailable for ${accountId}: ${(err as Error).message}`,
      );
    }
  }

  /** Actual gas cost (tokens_burnt) of a finalized transaction, or null. */
  async viewTxTokensBurnt(txHash: string, signer: string): Promise<string | null> {
    const view = await this.viewTxFinalStatus(txHash, signer);
    return view?.tokens_burnt ?? null;
  }

  /** Finalized public transaction receipt projection (read-only, keyless). */
  async viewTxFinalStatus(txHash: string, accountId: string): Promise<TxFinalStatusView | null> {
    let res: unknown;
    try {
      res = await this.provider.viewTransactionStatus({ txHash, accountId });
    } catch (err) {
      // Definitive, queryable "does not exist" answers → null (404).
      if (err instanceof UnknownTransactionError || err instanceof InvalidTransactionError) {
        return null;
      }
      // Transient RPC/chain availability → surface as unavailable (503), never
      // conflated with "no such transaction".
      throw new ChainUnavailableError(
        `viewTxFinalStatus unavailable for ${txHash}: ${(err as Error).message}`,
      );
    }

    if (typeof res !== 'object' || res === null || !('final_execution_status' in res)) {
      // Not yet queryable (no final_execution_status) → honest null.
      return null;
    }

    const finalExecutionStatus =
      typeof res.final_execution_status === 'string' ? res.final_execution_status : '';

    // Top-level `status` is the FINAL function-call result (SuccessValue or
    // Failure). Only a FINAL transaction with a proven SuccessValue is success.
    let successValue = false;
    if (finalExecutionStatus === 'FINAL' && 'status' in res) {
      const status = res.status;
      if (typeof status === 'object' && status !== null && 'SuccessValue' in status) {
        successValue = true;
      }
    }

    // Gas = transaction_outcome.tokens_burnt + every receipt's tokens_burnt.
    let tokensBurntSum = 0n;
    const outcomes: unknown[] = [];
    if ('transaction_outcome' in res && typeof res.transaction_outcome === 'object' && res.transaction_outcome !== null) {
      const to = res.transaction_outcome;
      if ('outcome' in to && typeof to.outcome === 'object' && to.outcome !== null) outcomes.push(to.outcome);
    }
    if ('receipts_outcome' in res && Array.isArray(res.receipts_outcome)) {
      for (const ro of res.receipts_outcome) {
        if (typeof ro === 'object' && ro !== null && 'outcome' in ro) outcomes.push(ro.outcome);
      }
    }
    let tokensBurnt: string | null = null;
    let anyFinalized = finalExecutionStatus === 'FINAL';
    for (const o of outcomes) {
      if (typeof o === 'object' && o !== null && 'tokens_burnt' in o) {
        const tb = o.tokens_burnt;
        if (typeof tb === 'string' || typeof tb === 'bigint' || typeof tb === 'number') {
          tokensBurntSum += BigInt(tb);
        }
      }
    }
    if (anyFinalized) tokensBurnt = tokensBurntSum.toString();

    return {
      tx_hash: txHash,
      final_execution_status: finalExecutionStatus,
      success_value: successValue,
      tokens_burnt: tokensBurnt,
    };
  }

  createQuestion(spec: QuestionSpecArgs, signer: string): Promise<CallOutcome> {
    // Actual wire shape: create_question(&mut self, spec: QuestionSpec).
    return this.call('create_question', { spec }, signer, 0n);
  }

  commit(questionId: number, hash: string, stakeYocto: bigint, signer: string): Promise<CallOutcome> {
    return this.call('commit', { question_id: questionId, hash }, signer, stakeYocto);
  }

  publishSnapshot(questionId: number, snapshotId: string, signer: string): Promise<CallOutcome> {
    return this.call('publish_snapshot', { question_id: questionId, snapshot_id: snapshotId }, signer, 0n);
  }

  buyForecast(questionId: number, priceYocto: bigint, signer: string): Promise<CallOutcome> {
    return this.call('buy_forecast', { question_id: questionId }, signer, priceYocto);
  }

  resolve(questionId: number, outcome: boolean, signer: string): Promise<CallOutcome> {
    return this.call('resolve', { question_id: questionId, outcome }, signer, 0n);
  }

  reveal(questionId: number, probBps: number, salt: string, signer: string): Promise<CallOutcome> {
    return this.call('reveal', { question_id: questionId, prob_bps: probBps, salt }, signer, 0n);
  }

  settle(questionId: number, signer: string): Promise<CallOutcome> {
    return this.call('settle', { question_id: questionId }, signer, 0n, SETTLE_GAS);
  }

  cancel(questionId: number, signer: string): Promise<CallOutcome> {
    return this.call('cancel', { question_id: questionId }, signer, 0n, SETTLE_GAS);
  }

  claimBuyerRefund(questionId: number, signer: string): Promise<CallOutcome> {
    return this.call('claim_buyer_refund', { question_id: questionId }, signer, 0n);
  }

  withdraw(amountYocto: bigint, signer: string): Promise<CallOutcome> {
    return this.call('withdraw', { amount: amountYocto.toString() }, signer, 0n);
  }
}
