/**
 * Real near-sandbox Forecast Access integration proof (ticket #5).
 *
 * Linux-only. This deploys the REAL contract WASM to a REAL `near-sandbox`
 * node (the same binary + RPC that near-workspaces drives) and exercises the
 * authenticated Forecast Access path end-to-end over the PUBLIC HTTP service,
 * with EPHEMERAL keys and NO in-process contract duplicate and NO mocked chain
 * success.
 *
 * Covered (all through the public HTTP/auth seam + the real contract):
 *   1. real purchase (create_question → commit → publish_snapshot → buy_forecast)
 *   2. valid NEP-413 login → frozen Snapshot payload
 *   3. repeat access returns the same frozen payload (no new charge)
 *   4. a non-purchasing account is denied (real has_bought=false)
 *   5. no session cookie → 401 (a public account id / tx hash is not proof)
 *   6. replay of a consumed challenge → 401 challenge_consumed
 *   7. expiry → 401 challenge_expired (controllable wall clock)
 *   8. wrong service context (network/contract) → 401 account_mismatch
 *   9. wrong recipient (signature over a different recipient) → invalid_signature
 *  10. a function-call key (not FullAccess) → 401 not_full_access
 *  11. concurrent challenge consumption admits exactly one verifier
 *  12. missing private snapshot → 503 snapshot_unavailable (no fabricated data)
 *
 * Usage (Linux; wasm built + near-sandbox binary present):
 *   HIVECAST_WASM=contracts/hivecast/target/wasm32-unknown-unknown/release/hivecast.wasm \
 *   NEAR_SANDBOX_BIN_PATH=$HOME/.near/near-sandbox-2.14.0-rc.5/near-sandbox \
 *   npm run sandbox:access --workspace @hivecast/runner
 */

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';

import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, nearToYocto } from 'near-api-js';

import { NearChainClient } from '../src/chain/near.js';
import { commitmentHash, generateSalt } from '../src/commitment.js';
import type { RunnerConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { Runtime } from '../src/runtime.js';
import { createPublicService } from '../src/service.js';
import { Store } from '../src/store.js';
import type { AccessClock } from '../src/access/index.js';

const WASM_PATH = process.env.HIVECAST_WASM ?? 'contracts/hivecast/target/wasm32-unknown-unknown/release/hivecast.wasm';
const SANDBOX_BIN =
  process.env.NEAR_SANDBOX_BIN_PATH ?? `${process.env.HOME}/.near/near-sandbox-2.14.0-rc.5/near-sandbox`;

// Deterministic sandbox TEST fixture key (near-workspaces `registrar` account).
// Published test-only key, never a user credential; it funds the sandbox so
// ephemeral accounts can be created.
const REGISTRAR_ACCOUNT = 'registrar';
const REGISTRAR_PRIVATE_KEY = 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB';
const REGISTRAR_PUBLIC_KEY = 'ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB';

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

  execFileSync(SANDBOX_BIN, ['--home', homeDir, 'init', '--fast'], { stdio: 'ignore' });

  // Patch genesis.json exactly like near-workspaces: add a funded `registrar`
  // FullAccess account so ephemeral accounts can be created.
  const genesisPath = path.join(homeDir, 'genesis.json');
  const genesis = JSON.parse(readFileSync(genesisPath, 'utf8')) as { total_supply: string; records: unknown[] };
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
    JSON.stringify({ account_id: REGISTRAR_ACCOUNT, public_key: REGISTRAR_PUBLIC_KEY, private_key: REGISTRAR_PRIVATE_KEY }),
  );

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
    body: JSON.stringify({ jsonrpc: '2.0', id: 'ff', method: 'sandbox_fast_forward', params: { delta_height: deltaHeight } }),
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
  const blocks = Number((targetNs - cur) / NS_PER_BLOCK) + 2;
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

/** A controllable wall clock (the external time adapter). */
class ControllableClock implements AccessClock {
  private ms: number;
  constructor(startMs = Date.now()) {
    this.ms = startMs;
  }
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

interface SignedChallenge {
  publicKey: string;
  signature: string;
}

async function signChallenge(
  keyPair: KeyPair,
  accountId: string,
  message: string,
  nonceBase64: string,
  recipient: string,
): Promise<SignedChallenge> {
  const signer = new KeyPairSigner(keyPair);
  const nonce = new Uint8Array(Buffer.from(nonceBase64, 'base64'));
  // NEP-413 sign via the reference signer (callbackUrl = None).
  const signed = await signer.signNep413Message(accountId, { message, nonce, recipient });
  return { publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString('base64') };
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
    await contractAccount.deployContract(new Uint8Array(readFileSync(WASM_PATH)));

    const operator = await createEphemeralAccount(registrar, provider, 'operator');
    const resolver = await createEphemeralAccount(registrar, provider, 'resolver');
    const agent = await createEphemeralAccount(registrar, provider, 'agent');
    const buyer = await createEphemeralAccount(registrar, provider, 'buyer');
    const nonBuyer = await createEphemeralAccount(registrar, provider, 'nonbuyer');

    await callFunction(contractAccount, contractId, 'new', { operator: operator.accountId });

    const t0 = await currentBlockNs(sb.rpcUrl);
    const openTime = t0 + 200n * NS_PER_BLOCK;
    const closeTime = t0 + 600n * NS_PER_BLOCK;
    const obsStart = t0 + 700n * NS_PER_BLOCK;
    const obsEnd = t0 + 720n * NS_PER_BLOCK;
    const resolveDeadline = t0 + 1000n * NS_PER_BLOCK;
    const revealWindow = 600n * NS_PER_BLOCK;
    const accessPrice = nearToYocto('0.01');
    const minStake = nearToYocto('0.1');

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

    await advanceTo(sb.rpcUrl, closeTime + 2n * NS_PER_BLOCK);
    await callFunction(operator.account, contractId, 'publish_snapshot', { question_id: questionId, snapshot_id: 'snapshot-1' });
    await callFunction(buyer.account, contractId, 'buy_forecast', { question_id: questionId }, accessPrice);

    const snapshotId = 'snapshot-1';
    const dbPath = path.join(tmpdir(), `hc-access-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

    function baseConfig(): RunnerConfig {
      return {
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
    }

    // Persist the frozen snapshot privately (participant count 1, aggregate =
    // the single agent's 5000 bps, stake = min_stake).
    const store = new Store(dbPath, 'sandbox', contractId);
    store.saveSnapshot({
      questionId,
      snapshotId,
      aggregateBps: 5000,
      totalStakeYocto: minStake,
      participantCount: 1,
      entries: [{ accountId: agent.accountId, probBps: 5000, stakeYocto: minStake.toString() }],
    });

    const clock = new ControllableClock();
    const config = baseConfig();
    const chain = new NearChainClient(config);
    const runner = new Runner(config, chain, store);
    const runtime = new Runtime(config, chain, store, runner, { clock });
    const server = createPublicService(runtime);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const base = `http://127.0.0.1:${addr.port}`;

    async function mintChallenge(accountId: string): Promise<{ challenge_id: string; nonce: string; message: string; recipient: string; account_id: string }> {
      const res = await fetch(`${base}/auth/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
        body: JSON.stringify({ account_id: accountId }),
      });
      assert.equal(res.status, 200, `mint failed: ${await res.text()}`);
      return (await res.json()) as { challenge_id: string; nonce: string; message: string; recipient: string; account_id: string };
    }

    async function verifyOverHttp(params: {
      challengeId: string;
      accountId: string;
      publicKey: string;
      signature: string;
    }): Promise<{ status: number; body: Record<string, unknown>; cookie: string }> {
      const res = await fetch(`${base}/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
        body: JSON.stringify({
          challenge_id: params.challengeId,
          account_id: params.accountId,
          public_key: params.publicKey,
          signature: params.signature,
        }),
      });
      return {
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
        cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!,
      };
    }

    async function deliver(cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(`${base}/forecast/${questionId}`, { headers: { cookie } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    const steps: string[] = [];

    // 2. Valid login + frozen payload.
    const c1 = await mintChallenge(buyer.accountId);
    const s1 = await signChallenge(buyer.keyPair, buyer.accountId, c1.message, c1.nonce, c1.recipient);
    const v1 = await verifyOverHttp({ challengeId: c1.challenge_id, accountId: buyer.accountId, publicKey: s1.publicKey, signature: s1.signature });
    assert.equal(v1.status, 200, `verify failed: ${JSON.stringify(v1.body)}`);
    assert.match(v1.cookie, /hivecast_session=/);
    const d1 = await deliver(v1.cookie);
    assert.equal(d1.status, 200, `delivery failed: ${JSON.stringify(d1.body)}`);
    assert.equal(d1.body.snapshot_id, snapshotId);
    assert.equal(d1.body.aggregate_bps, 5000);
    assert.equal(d1.body.single_agent, true);
    steps.push('purchase+login+delivery');

    // 3. Repeat access — same frozen payload, no new charge.
    const d2 = await deliver(v1.cookie);
    assert.equal(d2.status, 200);
    assert.equal(d2.body.snapshot_id, snapshotId);
    steps.push('repeat-access-same-payload');

    // 4. A non-purchasing account is denied (real has_bought=false).
    const cNonBuyer = await mintChallenge(nonBuyer.accountId);
    const sNonBuyer = await signChallenge(nonBuyer.keyPair, nonBuyer.accountId, cNonBuyer.message, cNonBuyer.nonce, cNonBuyer.recipient);
    const vNonBuyer = await verifyOverHttp({ challengeId: cNonBuyer.challenge_id, accountId: nonBuyer.accountId, publicKey: sNonBuyer.publicKey, signature: sNonBuyer.signature });
    assert.equal(vNonBuyer.status, 200);
    const dNonBuyer = await deliver(vNonBuyer.cookie);
    assert.equal(dNonBuyer.status, 403);
    assert.equal(dNonBuyer.body.error, 'not_purchased');
    steps.push('non-purchaser-denied');

    // 5. No session cookie → 401 (public account id / tx hash is not proof).
    const dNoCookie = await deliver('');
    assert.equal(dNoCookie.status, 401);
    assert.equal(dNoCookie.body.error, 'unauthenticated');
    steps.push('no-session-denied');

    // 6. Replay of a consumed challenge → 401.
    const vReplay = await verifyOverHttp({ challengeId: c1.challenge_id, accountId: buyer.accountId, publicKey: s1.publicKey, signature: s1.signature });
    assert.equal(vReplay.status, 401);
    assert.equal(vReplay.body.error, 'challenge_consumed');
    steps.push('replay-denied');

    // 7. Expiry (controllable clock).
    const cExp = await mintChallenge(buyer.accountId);
    clock.advance(config.access.challengeTtlMs + 1);
    const sExp = await signChallenge(buyer.keyPair, buyer.accountId, cExp.message, cExp.nonce, cExp.recipient);
    const vExp = await verifyOverHttp({ challengeId: cExp.challenge_id, accountId: buyer.accountId, publicKey: sExp.publicKey, signature: sExp.signature });
    assert.equal(vExp.status, 401);
    assert.equal(vExp.body.error, 'challenge_expired');
    steps.push('expiry-denied');

    // 8. Wrong service context (different network/contract) → account_mismatch.
    // A challenge minted by THIS service is verified against a server whose
    // configured network/contract differs → the bound context must fail closed.
    const wrongConfig = baseConfig();
    wrongConfig.networkId = 'wrong-net';
    wrongConfig.contractId = 'wrong.contract.registrar';
    const wrongServer = createPublicService(new Runtime(wrongConfig, chain, store, runner, { clock }));
    await new Promise<void>((resolve) => wrongServer.listen(0, '127.0.0.1', resolve));
    const wrongAddr = wrongServer.address();
    assert.ok(wrongAddr && typeof wrongAddr === 'object');
    const wrongBase = `http://127.0.0.1:${wrongAddr.port}`;
    const cReal = await mintChallenge(buyer.accountId); // minted by the correct service
    const sReal = await signChallenge(buyer.keyPair, buyer.accountId, cReal.message, cReal.nonce, cReal.recipient);
    const wrongVerifyRes = await fetch(`${wrongBase}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({
        challenge_id: cReal.challenge_id,
        account_id: buyer.accountId,
        public_key: sReal.publicKey,
        signature: sReal.signature,
      }),
    });
    const wrongVerifyBody = (await wrongVerifyRes.json()) as { error: string };
    assert.equal(wrongVerifyRes.status, 401);
    assert.equal(wrongVerifyBody.error, 'account_mismatch');
    await new Promise<void>((resolve) => wrongServer.close(() => resolve()));
    steps.push('wrong-context-denied');

    // 9. Wrong recipient (signature over a different recipient) → invalid_signature.
    const cRec = await mintChallenge(buyer.accountId);
    const sRec = await signChallenge(buyer.keyPair, buyer.accountId, cRec.message, cRec.nonce, 'evil.recipient.registrar');
    const vRec = await verifyOverHttp({ challengeId: cRec.challenge_id, accountId: buyer.accountId, publicKey: sRec.publicKey, signature: sRec.signature });
    assert.equal(vRec.status, 401);
    assert.equal(vRec.body.error, 'invalid_signature');
    steps.push('wrong-recipient-denied');

    // 10. Function-call key (not FullAccess) → not_full_access.
    const fnKey = KeyPair.fromRandom('ed25519');
    await buyer.account.signAndSendTransaction({
      receiverId: buyer.accountId,
      actions: [actions.addFunctionCallAccessKey(fnKey.getPublicKey(), contractId, [])],
      waitUntil: 'FINAL',
      throwOnFailure: true,
    });
    const cFn = await mintChallenge(buyer.accountId);
    const sFn = await signChallenge(fnKey, buyer.accountId, cFn.message, cFn.nonce, cFn.recipient);
    const vFn = await verifyOverHttp({ challengeId: cFn.challenge_id, accountId: buyer.accountId, publicKey: sFn.publicKey, signature: sFn.signature });
    assert.equal(vFn.status, 401);
    assert.equal(vFn.body.error, 'not_full_access');
    steps.push('function-call-key-denied');

    // 11. Concurrent consumption admits exactly one verifier.
    const cConc = await mintChallenge(buyer.accountId);
    const sConc = await signChallenge(buyer.keyPair, buyer.accountId, cConc.message, cConc.nonce, cConc.recipient);
    const concReq = () =>
      verifyOverHttp({ challengeId: cConc.challenge_id, accountId: buyer.accountId, publicKey: sConc.publicKey, signature: sConc.signature });
    const concResults = await Promise.allSettled([concReq(), concReq()]);
    const okCount = concResults.filter((r) => r.status === 'fulfilled' && (r.value as { status: number }).status === 200).length;
    const consumedCount = concResults.filter(
      (r) => r.status === 'fulfilled' && (r.value as { body: { error?: string } }).body.error === 'challenge_consumed',
    ).length;
    assert.equal(okCount, 1, 'exactly one concurrent verifier succeeds');
    assert.equal(consumedCount, 1, 'the other concurrent verifier is consumed');
    steps.push('concurrent-single-consumption');

    // 12. Missing private snapshot → 503 (no fabricated data, no auto refund).
    const emptyDbPath = path.join(tmpdir(), `hc-access-empty-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const emptyStore = new Store(emptyDbPath, 'sandbox', contractId);
    const emptyChain = new NearChainClient(baseConfig());
    const emptyRunner = new Runner(baseConfig(), emptyChain, emptyStore);
    const emptyRuntime = new Runtime(baseConfig(), emptyChain, emptyStore, emptyRunner, { clock });
    const emptyServer = createPublicService(emptyRuntime);
    await new Promise<void>((resolve) => emptyServer.listen(0, '127.0.0.1', resolve));
    const emptyAddr = emptyServer.address();
    assert.ok(emptyAddr && typeof emptyAddr === 'object');
    const emptyBase = `http://127.0.0.1:${emptyAddr.port}`;
    const cEmpty = (await (await fetch(`${emptyBase}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ account_id: buyer.accountId }),
    })).json()) as { challenge_id: string; nonce: string; message: string; recipient: string };
    const sEmpty = await signChallenge(buyer.keyPair, buyer.accountId, cEmpty.message, cEmpty.nonce, cEmpty.recipient);
    const vEmptyRes = await fetch(`${emptyBase}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ challenge_id: cEmpty.challenge_id, account_id: buyer.accountId, public_key: sEmpty.publicKey, signature: sEmpty.signature }),
    });
    const vEmptyCookie = (vEmptyRes.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.equal(vEmptyRes.status, 200);
    const dEmpty = await fetch(`${emptyBase}/forecast/${questionId}`, { headers: { cookie: vEmptyCookie } });
    const dEmptyBody = (await dEmpty.json()) as { error: string };
    assert.equal(dEmpty.status, 503);
    assert.equal(dEmptyBody.error, 'snapshot_unavailable');
    await new Promise<void>((resolve) => emptyServer.close(() => resolve()));
    emptyStore.close();
    rmSync(emptyDbPath, { force: true });
    steps.push('missing-snapshot-unavailable');

    process.stdout.write(`access-sandbox OK (${steps.length} checks): ${steps.join(', ')}\n`);
    process.stdout.write(
      `  contract=${contractId} buyer=${buyer.accountId} nonBuyer=${nonBuyer.accountId} snapshot=${snapshotId}\n`,
    );

    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dbPath, { force: true });
  } finally {
    sb.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`access-sandbox failed: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
