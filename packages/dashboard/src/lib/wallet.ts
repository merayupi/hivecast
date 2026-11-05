/**
 * Genuine NEAR testnet wallet connector (@hot-labs/near-connect 0.12.0).
 * No private keys enter the app: the wallet holds the full-access key and the
 * app only ever receives accountId, publicKey, and signatures.
 */

import { NearConnector, type NearWalletBase } from '@hot-labs/near-connect';

export interface WalletAccount {
  accountId: string;
  publicKey?: string;
}

export interface SignedProof {
  publicKey: string;
  signature: string;
}

/** The configured network/contract binding — comes from the runner /config. */
export interface WalletBinding {
  networkId: 'testnet' | 'mainnet';
  contractId: string;
}

const RPC = 'https://test.rpc.fastnear.com';

function createConnector(): NearConnector {
  return new NearConnector({
    network: 'testnet',
    providers: { testnet: [RPC] },
    features: {
      signMessage: true,
      signInAndSignMessage: true,
      signAndSendTransaction: true,
      signAndSendTransactions: true,
    },
    footerBranding: null,
  });
}

export class WalletConnector {
  readonly connector: NearConnector;

  constructor() {
    this.connector = createConnector();
  }

  /** Restore a previously selected wallet (throws when none stored). */
  async restore(): Promise<WalletAccount[]> {
    const { accounts } = await this.connector.getConnectedWallet();
    return accounts.map((a) => ({ accountId: a.accountId, publicKey: a.publicKey }));
  }

  async connect(): Promise<WalletAccount[]> {
    const wallet = await this.connector.connect();
    const accounts = await wallet.getAccounts();
    return accounts.map((a) => ({ accountId: a.accountId, publicKey: a.publicKey }));
  }

  async disconnect(): Promise<void> {
    await this.connector.disconnect();
  }

  async accounts(): Promise<WalletAccount[]> {
    const wallet = await this.connector.wallet();
    const accounts = await wallet.getAccounts();
    return accounts.map((a) => ({ accountId: a.accountId, publicKey: a.publicKey }));
  }

  /** NEP-413 sign the server challenge (nonce is the 32-byte base64 from the server). */
  async signMessage(params: {
    message: string;
    recipient: string;
    nonceBase64: string;
    accountId: string;
  }): Promise<SignedProof> {
    const wallet = await this.connector.wallet();
    const nonce = Uint8Array.from(atob(params.nonceBase64), (c) => c.charCodeAt(0));
    if (nonce.length !== 32) throw new Error('server nonce is not 32 bytes');
    const signed = await wallet.signMessage({
      message: params.message,
      recipient: params.recipient,
      nonce,
      signerId: params.accountId,
    });
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
    const wallet = await this.connector.wallet();
    const outcome = await wallet.signAndSendTransaction({
      signerId: params.accountId,
      receiverId: params.contractId,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: params.methodName,
            args: params.args,
            gas: params.gas,
            deposit: params.deposit,
          },
        },
      ],
    });
    return classifyOutcome(outcome);
  }
}

/** A successful, finalized contract call: FINAL execution status + SuccessValue. */
export interface ConfirmedCall {
  txHash: string;
  result: string | null;
}

/**
 * The one place that decides whether a wallet transaction is *confirmed*.
 * near-connect does not expose `waitUntil`; a wallet may return an included-but
 * not-finalized outcome, and `status` can be `NotStarted`/`Started`/
 * `SuccessReceiptId`/`Unknown` for a still-pending call. Only
 * `final_execution_status === 'FINAL'` **and** a `SuccessValue` count as done;
 * a `Failure` throws; anything else is a *pending* state the caller must keep
 * polling, never a silent success.
 */
function classifyOutcome(outcome: unknown): ConfirmedCall {
  const o = outcome as {
    final_execution_status?: string;
    status?: unknown;
    transaction?: { hash?: string };
  };
  const status = o.status;

  if (typeof status === 'object' && status !== null && 'Failure' in status) {
    throw new Error(`transaction failed: ${JSON.stringify(status.Failure)}`);
  }

  const isFinal = o.final_execution_status === 'FINAL';
  const isSuccess = typeof status === 'object' && status !== null && 'SuccessValue' in status;
  if (!isFinal || !isSuccess) {
    throw new Error(
      `transaction not finalized (status ${o.final_execution_status ?? 'unknown'}); wait and refresh — it may still confirm`,
    );
  }

  let result: string | null = null;
  const sv = status.SuccessValue;
  if (typeof sv === 'string' && sv.length > 0) {
    const bytes = Uint8Array.from(atob(sv), (c) => c.charCodeAt(0));
    result = new TextDecoder().decode(bytes);
  }
  return { txHash: o.transaction?.hash ?? '', result };
}

/** A single shared connector (created once, as near-connect requires). */
let shared: WalletConnector | null = null;
export function walletConnector(): WalletConnector {
  if (!shared) shared = new WalletConnector();
  return shared;
}

export type { NearWalletBase };
