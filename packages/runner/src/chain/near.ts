/**
 * NearChainClient — real NEAR RPC views + ed25519 transaction signing.
 *
 * Keys are loaded from the configured credential directory (near CLI JSON
 * layout) or from an in-memory credentials map supplied by the caller (used by
 * tests). Keys are never logged or returned.
 */

import { readFileSync } from 'node:fs';
import { Account, JsonRpcProvider, actions, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { AccountDoesNotExistError, AccessKeyDoesNotExistError } from 'near-api-js/rpc-errors';
import type { RunnerConfig } from '../config.js';
import type {
  BalanceView,
  BuyerReceiptView,
  CommitmentView,
  ContractState,
  PendingWithdrawalView,
  QuestionView,
} from '../types.js';
import type { CallOutcome, ChainClient, QuestionSpecArgs } from './types.js';

const DEFAULT_GAS = teraToGas('50');
const SETTLE_GAS = teraToGas('200');

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

  constructor(config: RunnerConfig) {
    this.contractId = config.contractId;
    this.config = config;
    this.provider = new JsonRpcProvider({ url: config.rpcUrl });
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
    const result = await this.provider.callFunction({
      contractId: this.contractId,
      method,
      args,
      blockQuery: { finality: 'final' },
    });
    return result as T;
  }

  private async call(
    methodName: string,
    args: Record<string, unknown> | Uint8Array,
    signer: string,
    deposit: bigint,
    gas: bigint = DEFAULT_GAS,
  ): Promise<CallOutcome> {
    const account = this.account(signer);
    try {
      const outcome = await account.signAndSendTransaction({
        receiverId: this.contractId,
        actions: [actions.functionCall(methodName, args, gas, deposit)],
        waitUntil: 'FINAL',
        throwOnFailure: false,
      });
      const status = 'status' in outcome ? outcome.status : undefined;
      const receiptsOutcome = 'receipts_outcome' in outcome ? outcome.receipts_outcome : undefined;
      const txHash =
        'transaction' in outcome &&
        typeof outcome.transaction === 'object' &&
        outcome.transaction !== null &&
        'hash' in outcome.transaction &&
        typeof outcome.transaction.hash === 'string'
          ? outcome.transaction.hash
          : null;
      const success = isSuccess(status);
      if (!success && txHash !== null) {
        // The transaction is included but the execution did not produce a proven
        // SuccessValue. Distinguish a definitive failure from an unproven state.
        const failErr = extractError(status, receiptsOutcome);
        if (failErr !== null) {
          return { txHash, success: false, result: null, error: failErr };
        }
        // Included but no SuccessValue observed: do NOT claim success, but keep
        // the txHash so the journal can reconcile against the chain.
        return { txHash, success: false, result: null, error: 'execution status unconfirmed (no SuccessValue)' };
      }
      const error = success ? null : extractError(status, receiptsOutcome);
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
      return { txHash, success, result, error };
    } catch (err) {
      // Rejected before inclusion (RPC error, invalid nonce after retries, etc.).
      // Uncertain network errors must not be treated as proof that nothing was
      // included; the journal reconciles by re-verifying before any resend.
      return { txHash: null, success: false, result: null, error: (err as Error).message };
    }
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

  async viewAccountBalance(accountId: string): Promise<bigint> {
    const acc = this.account(accountId);
    const state = await acc.getState();
    return state.balance.available;
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
