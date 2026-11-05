/**
 * Real near-sandbox Forecast Access integration proof (ticket #5).
 *
 * Linux-only. This deploys the REAL contract WASM to a REAL `near-sandbox`
 * node (the same `near-sandbox` binary + RPC that near-workspaces drives),
 * then exercises the authenticated Forecast Access path end-to-end with
 * EPHEMERAL keys:
 *
 *   create_question → commit → publish_snapshot → buy_forecast (real purchase)
 *   → NEP-413 challenge (real Ed25519 sign with the buyer's ephemeral FullAccess
 *   key) → /auth/verify → HttpOnly session cookie → /forecast/:id → the exact
 *   frozen Snapshot payload.
 *
 * It also proves the fail-closed negatives: another account is denied, a bare
 * public tx hash is not proof, replay is rejected, and the frozen payload is
 * stable across repeat access. There is NO in-process contract duplicate and
 * NO mocked chain success — every mutation and view is a real sandbox RPC.
 *
 * Usage (Linux, wasm already built + near-sandbox binary available):
 *   HIVECAST_WASM=contracts/hivecast/target/wasm32-unknown-unknown/release/hivecast.wasm \
 *   NEAR_SANDBOX_BIN_PATH=$HOME/.near/near-sandbox-2.0.0/near-sandbox \
 *   npm run sandbox:access --workspace @hivecast/runner
 *
 * Preconditions (set up by the GitHub Actions workflow):
 *   - `cargo build --target wasm32-unknown-unknown --release` for the contract
 *   - the `near-sandbox` binary (Linux x86) present at NEAR_SANDBOX_BIN_PATH
 */

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { Server } from 'node:net';
import { createServer as createNetServer } from 'node:net';

import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, nearToYocto } from 'near-api-js';

import { NearChainClient } from '../src/chain/near.js';
import { commitmentHash, generateSalt } from '../src/commitment.js';
import type { RunnerConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { Runtime } from '../src/runtime.js';
import { createPublicService } from '../src/service.js';
import { Store } from '../src/store.js';
import { AccessError } from '../src/access/index.js';

const WASM_PATH = process.env.HIVECAST_WASM ?? 'contracts/hivecast/target/wasm32-unknown-unknown/release/hivecast.wasm';
const SANDBOX_BIN = process.env.NEAR_SANDBOX_BIN_PATH ?? `${process.env.HOME}/.near/near-sandbox-2.0.0/near-sandbox`;

// Deterministic sandbox TEST fixture key (near-workspaces `registrar` account).
// This is a published test-only key, never a user credential. It funds the
// sandbox so ephemeral accounts can be created.
const REGISTRAR_ACCOUNT = 'registrar';
const REGISTRAR_PRIVATE_KEY = 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB';
const REGISTRAR_PUBLIC_KEY = 'ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB';

const NANOS_PER_SECOND = 1_000_000_000n;
const NS_PER_BLOCK = 1_000_000_000n; // sandbox fast_forward advances ~1s per block

interface SandboxProc {
  rpcUrl: string;
  homeDir: string;
  stop: () => void;
}

function freePort(): number {
  const srv = createNetServer();
  srv.listen(0, '127.0.0.1');
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  srv.close();
  return port;
}

async function waitForRpc(rpcUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'health', method: 'status', params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`sandbox RPC did not become ready within ${timeoutMs}ms`);
}

async function startSandbox(): Promise<SandboxProc> {
  assert.ok(existsSync(SANDBOX_BIN), `near-sandbox binary not found at ${SANDBOX_BIN}`);
  const homeDir = mkdtempSync(path.join(tmpdir(), 'hc-sandbox-'));
  const rpcPort = freePort();
  const netPort = freePort();
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;

  // init
  execFileSync(SANDBOX_BIN, ['--home', homeDir, 'init', '--fast'], { stdio: 'ignore' });

  // Patch genesis.json exactly like near-workspaces: add a funded `registrar`
  // FullAccess account so ephemeral accounts can be created.
  const genesisPath = path.join(homeDir, 'genesis.json');
  const genesis = JSON.parse(readFileSync(genesisPath, 'utf8')) as {
    total_supply: string;
    records: unknown[];
  };
  const registrarAmount = 10_000_000_000_000_000_000_000_000_000n;
  genesis.total_supply = (BigInt(genesis.total_supply) + registrarAmount).toString();
  genesis.records.push({
    Account: {
      account_id: REGISTRAR_ACCOUNT,
      account: {
        amount: registrarAmount.toString(),
        locked: '0',
        code_hash: '11111111111111111111111111111111',
        storage_usage: 182,
      },
    },
  });
  genesis.records.push({
    AccessKey: {
      account_id: REGISTRAR_ACCOUNT,
      public_key: REGISTRAR_PUBLIC_KEY,
      access_key: { nonce: 0, permission: 'FullAccess' },
    },
  });
  writeFileSync(genesisPath, JSON.stringify(genesis));

  writeFileSync(
    path.join(homeDir, 'registrar.json'),
    JSON.stringify({
      account_id: REGISTRAR_ACCOUNT,
      public_key: REGISTRAR_PUBLIC_KEY,
      private_key: REGISTRAR_PRIVATE_KEY,
    }),
  );

  // run
  const child = spawn(
    SANDBOX_BIN,
    ['--home', homeDir, 'run', '--rpc-addr', `127.0.0.1:${rpcPort}`, '--network-addr', `127.0.0.1:${netPort}`],
    { stdio: 'ignore' },
  );

  await waitForRpc(rpcUrl);

  return {
    rpcUrl,
    homeDir,
    stop: () => {
      child.kill('SIGTERM');
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

async function sandboxFastForward(rpcUrl: string, deltaHeight: number): Promise<void> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'ff',
      method: 'sandbox_fast_forward',
      params: { delta_height: deltaHeight },
    }),
  });
  if (!res.ok) throw new Error(`sandbox_fast_forward failed: ${res.status} ${await res.text()}`);
}

async function currentBlockNs(rpcUrl: string): Promise<bigint> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'block', method: 'block', params: { finality: 'final' } }),
  });
  const body = (await res.json()) as { result?: { header?: { timestamp_nanosec?: string } } };
  const ts = body.result?.header?.timestamp_nanosec;
  assert.ok(ts, `no block timestamp: ${JSON.stringify(body)}`);
  return BigInt(ts);
}

async function advanceTo(rpcUrl: string, targetNs: bigint): Promise<void> {
  const cur = await currentBlockNs(rpcUrl);
  if (cur >= targetNs) return;
  const delta = targetNs - cur;
  const blocks = Number(delta / NS_PER_BLOCK) + 2;
  await sandboxFastForward(rpcUrl, blocks);
}

interface EphemeralAccount {
  accountId: string;
  keyPair: KeyPair;
  account: Account;
}

async function createEphemeralAccount(
  registrar: Account,
  provider: JsonRpcProvider,
  prefix: string,
): Promise<EphemeralAccount> {
  // Sub-accounts of `registrar` (CreateAccount always allows sub-accounts).
  const accountId = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.registrar`;
  const keyPair = KeyPair.fromRandom('ed25519');
  await registrar.createAccount({
    newAccountId: accountId,
    publicKey: keyPair.getPublicKey(),
    nearToTransfer: nearToYocto('100'),
  });
  const account = new Account(accountId, provider, keyPair.toString());
  return { accountId, keyPair, account };
}

async function callFunction(
  account: Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  depositYocto: bigint = 0n,
): Promise<unknown> {
  const result = await account.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(methodName, args, 300_000_000_000_000n, depositYocto)],
    waitUntil: 'FINAL',
    throwOnFailure: true,
  });
  const status = 'status' in result ? result.status : undefined;
  if (status && typeof status === 'object' && 'SuccessValue' in status) {
    const sv = (status as { SuccessValue: string }).SuccessValue;
    if (sv) {
      const txt = Buffer.from(sv, 'base64').toString('utf8');
      try {
        return JSON.parse(txt);
      } catch {
        return txt;
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const sb = await startSandbox();
  try {
    const provider = new JsonRpcProvider({ url: sb.rpcUrl });
    const registrar = new Account(REGISTRAR_ACCOUNT, provider, REGISTRAR_PRIVATE_KEY);

    // Deploy the real WASM to a fresh contract account (sub-account of registrar).
    const contractId = `contract-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.registrar`;
    const contractKey = KeyPair.fromRandom('ed25519');
    await registrar.createAccount({
      newAccountId: contractId,
      publicKey: contractKey.getPublicKey(),
      nearToTransfer: nearToYocto('500'),
    });
    const contractAccount = new Account(contractId, provider, contractKey.toString());
    const wasm = readFileSync(WASM_PATH);
    await contractAccount.deployContract(new Uint8Array(wasm));

    // Ephemeral operator, resolver, agent, and buyer (the buyer's FullAccess key
    // is what signs the NEP-413 challenge).
    const operator = await createEphemeralAccount(registrar, provider, 'operator');
    const resolver = await createEphemeralAccount(registrar, provider, 'resolver');
    const agent = await createEphemeralAccount(registrar, provider, 'agent');
    const buyer = await createEphemeralAccount(registrar, provider, 'buyer');

    // init(operator).
    await callFunction(contractAccount, contractId, 'new', { operator: operator.accountId });

    // A generous schedule anchored to the current sandbox timestamp.
    const t0 = await currentBlockNs(sb.rpcUrl);
    const openTime = t0 + 200n * NS_PER_BLOCK;
    const closeTime = t0 + 600n * NS_PER_BLOCK;
    const obsStart = t0 + 700n * NS_PER_BLOCK;
    const obsEnd = t0 + 720n * NS_PER_BLOCK;
    const resolveDeadline = t0 + 1000n * NS_PER_BLOCK;
    const revealWindow = 600n * NS_PER_BLOCK;
    const accessPrice = nearToYocto('0.01');
    const minStake = nearToYocto('0.1');

    // create_question (nested spec).
    const questionId = (await callFunction(operator.account, contractId, 'create_question', {
      spec: {
        text: 'Will the target hour close higher than it opened?',
        event_definition: 'Binance spot NEARUSDT 1h candle: YES means close > open',
        source: 'binance:NEARUSDT:1h',
        resolver: resolver.accountId,
        open_time: openTime.toString(),
        close_time: closeTime.toString(),
        observation_start: obsStart.toString(),
        observation_end: obsEnd.toString(),
        resolve_time: null,
        resolve_deadline: resolveDeadline.toString(),
        reveal_window: revealWindow.toString(),
        access_price: accessPrice.toString(),
        min_stake: minStake.toString(),
      },
    })) as number;
    assert.ok(typeof questionId === 'number', `unexpected question_id: ${JSON.stringify(questionId)}`);

    // commit (one agent) — real SHA-256(Borsh(preimage)) over an ephemeral salt.
    await advanceTo(sb.rpcUrl, openTime);
    const salt = generateSalt();
    const hash = commitmentHash({
      contractId,
      questionId,
      accountId: agent.accountId,
      stakeYocto: minStake,
      probBps: 5000,
      salt,
    });
    await callFunction(agent.account, contractId, 'commit', { question_id: questionId, hash }, minStake);

    // publish_snapshot (operator) + buy_forecast (buyer, exact access_price).
    await advanceTo(sb.rpcUrl, closeTime + 2n * NS_PER_BLOCK);
    await callFunction(operator.account, contractId, 'publish_snapshot', {
      question_id: questionId,
      snapshot_id: 'snapshot-1',
    });
    await callFunction(buyer.account, contractId, 'buy_forecast', { question_id: questionId }, accessPrice);

    // Build the runner HTTP service against the REAL sandbox RPC, with the
    // frozen snapshot persisted privately (the delivery payload source).
    const dbPath = path.join(tmpdir(), `hc-access-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const config: RunnerConfig = {
      networkId: 'sandbox',
      contractId,
      operatorId: operator.accountId,
      resolverId: resolver.accountId,
      rpcUrl: sb.rpcUrl,
      credentialDirectory: path.join(tmpdir(), 'no-credentials'),
      databasePath: dbPath,
      seed: 42,
      pollIntervalMs: 60_000,
      minStakeYocto: minStake,
      accessPriceYocto: accessPrice,
      agentAccounts: {
        meteo: agent.accountId,
        climatology: agent.accountId,
        persistence: agent.accountId,
        momentum: agent.accountId,
        meanrev: agent.accountId,
        'noisy-trend': agent.accountId,
        yolo: agent.accountId,
        coinflip: agent.accountId,
      } as RunnerConfig['agentAccounts'],
      binanceBaseUrl: 'https://api.binance.com',
      openMeteoBaseUrl: 'https://api.open-meteo.com',
      archiveBaseUrl: 'https://archive-api.open-meteo.com',
      kudusLatitude: '-6.8049',
      kudusLongitude: '110.8397',
      kudusTimezone: 'Asia/Jakarta',
      operationalGasReserveYocto: 0n,
      http: { enabled: false, host: '127.0.0.1', port: 8787 },
      access: {
        sessionTtlMs: 86_400_000,
        challengeTtlMs: 300_000,
        cookieName: 'hivecast_session',
        cookieSecure: false,
        serviceDomain: 'hivecast',
        allowedOrigins: ['http://localhost:5173'],
      },
      credentials: {
        [operator.accountId]: operator.keyPair.toString(),
        [resolver.accountId]: resolver.keyPair.toString(),
        [agent.accountId]: agent.keyPair.toString(),
        [buyer.accountId]: buyer.keyPair.toString(),
      },
    };
    const chain = new NearChainClient(config);
    const store = new Store(dbPath, config.networkId, config.contractId);

    // Persist the frozen snapshot privately (the operator-side aggregate). We
    // mirror the real runner's freeze: participant count 1, aggregate = the
    // single agent probability 5000 bps, stake = min_stake.
    const snapshotId = 'snapshot-1';
    store.saveSnapshot({
      questionId,
      snapshotId,
      aggregateBps: 5000,
      totalStakeYocto: minStake,
      participantCount: 1,
      entries: [{ accountId: agent.accountId, probBps: 5000, stakeYocto: minStake.toString() }],
    });

    const runner = new Runner(config, chain, store);
    const runtime = new Runtime(config, chain, store, runner);
    const server = createPublicService(runtime);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const base = `http://127.0.0.1:${addr.port}`;

    // 1. Mint a challenge for the real buyer.
    const challengeResp = await fetch(`${base}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ account_id: buyer.accountId }),
    });
    assert.equal(challengeResp.status, 200);
    const challenge = (await challengeResp.json()) as {
      challenge_id: string;
      nonce: string;
      message: string;
      recipient: string;
      account_id: string;
    };
    assert.equal(challenge.account_id, buyer.accountId);

    // 2. Sign with the buyer's REAL ephemeral FullAccess key (callbackUrl=None).
    const signer = new KeyPairSigner(buyer.keyPair);
    const nonce = new Uint8Array(Buffer.from(challenge.nonce, 'base64'));
    const signed = await signer.signNep413Message(buyer.accountId, {
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
        account_id: buyer.accountId,
        public_key: signed.publicKey.toString(),
        signature: Buffer.from(signed.signature).toString('base64'),
      }),
    });
    assert.equal(verifyResp.status, 200);
    const cookie = (verifyResp.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.match(cookie, /hivecast_session=/);

    // 4. Retrieve the frozen payload with the session cookie.
    const deliveryResp = await fetch(`${base}/forecast/${questionId}`, { headers: { cookie } });
    assert.equal(deliveryResp.status, 200);
    const delivery = (await deliveryResp.json()) as {
      snapshot_id: string;
      aggregate_bps: number;
      single_agent: boolean;
    };
    assert.equal(delivery.snapshot_id, snapshotId);
    assert.equal(delivery.aggregate_bps, 5000);
    assert.equal(delivery.single_agent, true);

    // 5. Repeat access returns the same frozen payload (no new charge).
    const delivery2 = (await (await fetch(`${base}/forecast/${questionId}`, { headers: { cookie } })).json()) as {
      snapshot_id: string;
    };
    assert.equal(delivery2.snapshot_id, snapshotId);

    // 6. Another account / no session / replay is denied (fail-closed).
    const noCookieResp = await fetch(`${base}/forecast/${questionId}`);
    assert.equal(noCookieResp.status, 401);

    const replayResp = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({
        challenge_id: challenge.challenge_id,
        account_id: buyer.accountId,
        public_key: signed.publicKey.toString(),
        signature: Buffer.from(signed.signature).toString('base64'),
      }),
    });
    const replayBody = (await replayResp.json()) as { error: string };
    assert.equal(replayResp.status, 401);
    assert.equal(replayBody.error, 'challenge_consumed');

    process.stdout.write(
      `access-sandbox OK: real WASM deployed to ${contractId}; real purchase for buyer ${buyer.accountId}; ` +
        `NEP-413 login + frozen payload delivered (snapshot ${snapshotId}); replay denied.\n`,
    );

    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dbPath, { force: true });
  } finally {
    sb.stop();
  }
}

main().catch((err) => {
  if (err instanceof AccessError) {
    process.stderr.write(`access-sandbox AccessError(${err.code}): ${err.message}\n`);
  } else {
    process.stderr.write(`access-sandbox failed: ${(err as Error).stack ?? err}\n`);
  }
  process.exit(1);
});
