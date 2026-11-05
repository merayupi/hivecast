/**
 * Genuine NEAR testnet wallet connector — official maintained adapter.
 *
 * Uses `@near-wallet-selector/core` + `@near-wallet-selector/meteor-wallet`
 * (the Meteor SDK drives its own wallet popup/postMessenger — no sandboxed
 * iframe executor, no private keys in the app bundle). The app only ever
 * receives `accountId`, `publicKey`, and NEP-413 signatures.
 */

import {
  setupWalletSelector,
  actionCreators,
  type WalletSelector,
  type InjectedWallet,
  type Account,
  type FinalExecutionOutcome,
} from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';

export interface WalletAccount {
  accountId: string;
  publicKey?: string;
}

export interface SignedProof {
  publicKey: string;
  signature: string;
}

/** A successful, finalized contract call: FINAL execution status + SuccessValue. */
export interface ConfirmedCall {
  txHash: string;
  result: string | null;
}

const RPC = 'https://test.rpc.fastnear.com';

function toAccount(a: Account): WalletAccount {
  return { accountId: a.accountId, publicKey: a.publicKey };
}

/** Decode a base64 string into bytes (the server nonce is 32 random bytes). */
function decodeBase64(value: string): Uint8Array {
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * The one place that decides whether a wallet transaction is *confirmed*.
 * `signAndSendTransaction` may return an included-but-not-finalized outcome;
 * only `final_execution_status === 'FINAL'` **and** a `SuccessValue` count as
 * done. A `Failure` throws; anything else is a *pending* state the caller must
 * keep polling, never a silent success.
 */
function classifyOutcome(outcome: FinalExecutionOutcome): ConfirmedCall {
  const status = outcome.status;
  if (typeof status === 'object' && status !== null && 'Failure' in status) {
    throw new Error(`transaction failed: ${JSON.stringify(status.Failure)}`);
  }
  const isFinal = outcome.final_execution_status === 'FINAL';
  const isSuccess = typeof status === 'object' && status !== null && 'SuccessValue' in status;
  if (!isFinal || !isSuccess) {
    throw new Error(
      `transaction not finalized (status ${outcome.final_execution_status ?? 'unknown'}); wait and refresh — it may still confirm`,
    );
  }
  let result: string | null = null;
  const sv = status.SuccessValue;
  if (typeof sv === 'string' && sv.length > 0) {
    result = new TextDecoder().decode(decodeBase64(sv));
  }
  return { txHash: outcome.transaction.hash, result };
}

export class WalletConnector {
  private selectorPromise: Promise<WalletSelector> | null = null;
  private current: InjectedWallet | null = null;

  private selector(): Promise<WalletSelector> {
    if (!this.selectorPromise) {
      this.selectorPromise = setupWalletSelector({
        network: 'testnet',
        modules: [setupMeteorWallet()],
      });
    }
    return this.selectorPromise;
  }

  /** Restore a previously selected wallet (returns [] when none stored). */
  async restore(): Promise<WalletAccount[]> {
    const sel = await this.selector();
    const wallet = (await sel.wallet()) as InjectedWallet | null;
    if (!wallet) return [];
    const accounts = await wallet.getAccounts();
    if (accounts.length === 0) return [];
    this.current = wallet;
    return accounts.map(toAccount);
  }

  /** Connect: opens the genuine Meteor wallet sign-in, returns the accounts. */
  async connect(contractId: string): Promise<WalletAccount[]> {
    const sel = await this.selector();
    const wallet = (await sel.wallet('meteor-wallet')) as InjectedWallet;
    const accounts = await wallet.signIn({ contractId });
    this.current = wallet;
    return accounts.map(toAccount);
  }

  async disconnect(): Promise<void> {
    if (this.current) {
      await this.current.signOut();
      this.current = null;
    }
  }

  async accounts(): Promise<WalletAccount[]> {
    const sel = await this.selector();
    const wallet = (await sel.wallet()) as InjectedWallet;
    return (await wallet.getAccounts()).map(toAccount);
  }

  /** NEP-413 sign the server challenge (nonce is the 32-byte base64 from the server). */
  async signMessage(params: {
    message: string;
    recipient: string;
    nonceBase64: string;
    accountId: string;
  }): Promise<SignedProof> {
    const wallet = this.current ?? ((await (await this.selector()).wallet()) as InjectedWallet);
    if (typeof wallet.signMessage !== 'function') {
      throw new Error('wallet does not support NEP-413 signMessage');
    }
    // The Meteor SDK validates `Buffer.isBuffer(nonce)`; nodePolyfills provides
    // the `Buffer` global in the browser, so build a real 32-byte Buffer.
    const nonce = Buffer.from(params.nonceBase64, 'base64');
    if (nonce.length !== 32) throw new Error('server nonce is not 32 bytes');
    const signed = await wallet.signMessage({
      message: params.message,
      recipient: params.recipient,
      nonce,
    });
    if (!signed) throw new Error('wallet did not return a signed message');
    return { publicKey: signed.publicKey, signature: signed.signature };
  }

  /** Sign + send one FunctionCall transaction; gas in gas units, deposit in yoctoNEAR. */
  async call(params: {
    accountId: string;
    methodName: string;
    args: Record<string, unknown>;
    gas: string;
    deposit: string;
    contractId: string;
  }): Promise<ConfirmedCall> {
    const wallet = this.current ?? ((await (await this.selector()).wallet()) as InjectedWallet);
    const outcome = await wallet.signAndSendTransaction({
      signerId: params.accountId,
      receiverId: params.contractId,
      actions: [actionCreators.functionCall(params.methodName, params.args, BigInt(params.gas), BigInt(params.deposit))],
    });
    return classifyOutcome(outcome);
  }
}

/** A single shared connector (created once). */
let shared: WalletConnector | null = null;
export function walletConnector(): WalletConnector {
  if (!shared) shared = new WalletConnector();
  return shared;
}
