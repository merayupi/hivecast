/**
 * Real-testnet Forecast Access auth smoke (ticket #5).
 *
 * Proves the NEP-413 ownership login path against REAL testnet RPC with the
 * task buyer's REAL FullAccess key (loaded from `credentialDirectory`, never
 * printed). It does NOT purchase anything and does NOT prove a purchase:
 * after a successful login it attempts delivery and reports the honest
 * `not_purchased` result — there is no fabricated purchase proof.
 *
 * Usage (from repo root, operator machine with the buyer key present):
 *   HIVECAST_CONFIG=./hivecast.config.json \
 *     npm run smoke:auth --workspace @hivecast/runner
 *
 * The buyer key is read at sign time only; key contents are never logged.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KeyPair, KeyPairSigner } from 'near-api-js';

import { NearChainClient } from '../src/chain/near.js';
import { loadConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { Runtime } from '../src/runtime.js';
import { createPublicService } from '../src/service.js';
import { Store } from '../src/store.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env.HIVECAST_CONFIG ?? 'hivecast.config.json');
  if (config.networkId !== 'testnet') {
    throw new Error('smoke is testnet-only');
  }
  const buyer = process.env.HIVECAST_BUYER_ACCOUNT ?? 'buyer.hivecast-1105-0548.testnet';

  // Isolated DB: never reuse the operator's durable store.
  const dbPath = path.join(tmpdir(), `hc-auth-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

  // Load the buyer's private key (never logged).
  const credPath = `${config.credentialDirectory}/${buyer}.json`;
  const cred = JSON.parse(readFileSync(credPath, 'utf8')) as { private_key?: string; public_key?: string };
  if (!cred.private_key || !cred.private_key.startsWith('ed25519:')) {
    throw new Error(`no ed25519 private key at ${credPath}`);
  }
  const keyPair = KeyPair.fromString(cred.private_key as never);

  const chain = new NearChainClient(config);
  const store = new Store(dbPath, config.networkId, config.contractId);
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner);
  const server = createPublicService(runtime);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('failed to bind');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // Finalized FullAccess sanity check on the real key.
    const permission = await chain.viewAccessKeyPermission(buyer, keyPair.getPublicKey().toString());
    process.stdout.write(`fullaccess(finalized)=${permission}\n`);

    // 1. Mint a challenge.
    const challengeResp = await fetch(`${base}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ account_id: buyer }),
    });
    if (challengeResp.status !== 200) {
      throw new Error(`challenge failed: ${challengeResp.status} ${await challengeResp.text()}`);
    }
    const challenge = (await challengeResp.json()) as {
      challenge_id: string;
      nonce: string;
      message: string;
      recipient: string;
      account_id: string;
    };

    // 2. Sign with the real buyer FullAccess key (callbackUrl = None).
    const signer = new KeyPairSigner(keyPair);
    const nonce = new Uint8Array(Buffer.from(challenge.nonce, 'base64'));
    const signed = await signer.signNep413Message(buyer, {
      message: challenge.message,
      nonce,
      recipient: challenge.recipient,
    });

    // 3. Verify over HTTP → session cookie.
    const verifyResp = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({
        challenge_id: challenge.challenge_id,
        account_id: buyer,
        public_key: signed.publicKey.toString(),
        signature: Buffer.from(signed.signature).toString('base64'),
      }),
    });
    const verifyBody = (await verifyResp.json()) as { account_id?: string; error?: string; message?: string };
    if (verifyResp.status !== 200) {
      throw new Error(`verify failed: ${verifyResp.status} ${JSON.stringify(verifyBody)}`);
    }
    const cookie = (verifyResp.headers.get('set-cookie') ?? '').split(';')[0]!;

    process.stdout.write(`auth/login ok account=${verifyBody.account_id} network=${config.networkId} contract=${config.contractId}\n`);

    // 4. Attempt delivery (honest not_purchased: no purchase exists).
    const deliveryResp = await fetch(`${base}/forecast/0`, { headers: { cookie } });
    const deliveryBody = (await deliveryResp.json()) as { error?: string };
    process.stdout.write(`forecast/delivery status=${deliveryResp.status} result=${deliveryBody.error ?? 'delivered'}\n`);
    if (deliveryResp.status !== 403 || deliveryBody.error !== 'not_purchased') {
      throw new Error(`expected not_purchased (no purchase), got ${deliveryResp.status} ${JSON.stringify(deliveryBody)}`);
    }
    process.stdout.write('smoke: real-testnet FullAccess HTTP login proven; purchase not performed (honest not_purchased)\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
}

main().catch((err) => {
  process.stderr.write(`auth-smoke failed: ${(err as Error).message}\n`);
  process.exit(1);
});
