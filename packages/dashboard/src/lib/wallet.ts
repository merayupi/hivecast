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
  }): Promise<string> {
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
    if (typeof outcome.status === 'object' && outcome.status !== null && 'Failure' in outcome.status) {
      throw new Error(`transaction failed: ${JSON.stringify(outcome.status.Failure)}`);
    }
    return outcome.transaction.hash;
  }
}

/** A single shared connector (created once, as near-connect requires). */
let shared: WalletConnector | null = null;
export function walletConnector(): WalletConnector {
  if (!shared) shared = new WalletConnector();
  return shared;
}

export type { NearWalletBase };
