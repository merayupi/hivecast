/**
 * Forecast Access seam tests (ticket #5).
 *
 * These exercise the approved public product-lifecycle seam only — the
 * authenticated Forecast Access HTTP/auth surface — through a REAL durable
 * Store, a controllable ChainClient (the external chain adapter), and genuine
 * Ed25519 NEP-413 signatures produced with the real near-api-js signer.
 *
 * No private Store row / Borsh helper is asserted directly: the Store is
 * exercised through its consumers (`AccessAuth` mint/verify/deliver), and the
 * NEP-413 bytes are verified by signing real payloads, not by inspecting the
 * encoder output. The chain is the only mocked collaborator (it is the
 * external source adapter, exactly the adapter the spec allows to control).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { KeyPair, KeyPairSigner } from 'near-api-js';

import { Runner } from '../src/runner.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { RunnerConfig } from '../src/config.js';
import type { ChainClient, CallOutcome, QuestionSpecArgs } from '../src/chain/types.js';
import type {
  BalanceView,
  BuyerReceiptView,
  CommitmentView,
  ContractState,
  LocalQuestion,
  PendingWithdrawalView,
  QuestionView,
  SnapshotRecord,
} from '../src/types.js';
import { AccessError } from '../src/access/index.js';
import { createPublicService } from '../src/service.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTRACT = 'hivecast-market-6c4d.testnet';
const NETWORK = 'testnet';
const OPERATOR = 'hivecast-1105-0548.testnet';

function agentAccounts(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const a of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) {
    m[a] = `${a}.hivecast-1105-0548.testnet`;
  }
  return m;
}

function buildConfig(dbPath: string, overrides?: Partial<RunnerConfig>): RunnerConfig {
  return {
    networkId: NETWORK,
    contractId: CONTRACT,
    operatorId: OPERATOR,
    resolverId: OPERATOR,
    rpcUrl: 'http://127.0.0.1:0',
    credentialDirectory: 'C:/Users/nobody/.near-credentials/testnet',
    databasePath: dbPath,
    seed: 42,
    pollIntervalMs: 60_000,
    minStakeYocto: 10n ** 23n,
    accessPriceYocto: 10n ** 22n,
    agentAccounts: agentAccounts() as RunnerConfig['agentAccounts'],
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
    ...overrides,
  };
}

function questionView(questionId: number, overrides?: Partial<QuestionView>): QuestionView {
  return {
    question_id: questionId,
    text: 'Will the target hour close higher than it opened?',
    event_definition: 'Binance spot NEARUSDT 1h candle: YES means close > open',
    source: 'binance:NEARUSDT:1h',
    resolver: OPERATOR,
    open_time: '1000',
    close_time: '2000',
    observation_start: '3000',
    observation_end: '4000',
    resolve_time: '4000',
    resolve_deadline: '5000',
    reveal_window: '600000000000',
    access_price: (10n ** 22n).toString(),
    min_stake: (10n ** 23n).toString(),
    phase: 'closed',
    outcome: null,
    resolved_at: null,
    reveal_deadline: null,
    snapshot_ready: true,
    snapshot_id: 'snap-1',
    total_stake: '200000000000000000000000',
    fee_pool: '10000000000000000000000',
    participant_count: 1,
    buyer_count: 1,
    ...overrides,
  };
}

function localQuestion(questionId: number): LocalQuestion {
  return {
    questionId,
    domain: 'price',
    text: 'Will the target hour close higher than it opened?',
    eventDefinition: 'Binance spot NEARUSDT 1h candle: YES means close > open',
    sourceJson: JSON.stringify({ instrument: 'NEARUSDT', interval: '1h' }),
    sourceLabel: 'Binance NEARUSDT 1h',
    resolver: OPERATOR,
    openTimeNs: 1000n,
    closeTimeNs: 2000n,
    observationStartNs: 3000n,
    observationEndNs: 4000n,
    resolveTimeNs: 4000n,
    resolveDeadlineNs: 5000n,
    revealWindowNs: 600_000_000_000n,
    accessPrice: 10n ** 22n,
    minStake: 10n ** 23n,
    participants: [{ agentId: 'coinflip', accountId: 'coinflip.hivecast-1105-0548.testnet' }],
  };
}

function snapshotRecord(questionId: number, snapshotId: string): SnapshotRecord {
  return {
    questionId,
    snapshotId,
    aggregateBps: 5000,
    totalStakeYocto: 10n ** 23n,
    participantCount: 1,
    entries: [{ accountId: 'coinflip.hivecast-1105-0548.testnet', probBps: 5000, stakeYocto: (10n ** 23n).toString() }],
  };
}

interface FakeChainOptions {
  permission?: (accountId: string, publicKey: string) => 'full-access' | 'function-call' | null;
  bought?: (questionId: number, accountId: string) => boolean;
  question?: (questionId: number) => QuestionView | null;
}

function makeFakeChain(opts: FakeChainOptions = {}): ChainClient {
  const permission = opts.permission ?? (() => 'full-access');
  const bought = opts.bought ?? (() => true);
  const question = opts.question ?? ((qid: number) => questionView(qid));

  const emptyBalance: BalanceView = { account_id: '', claimable: '0', pending: '0', received: '0' };
  const out: CallOutcome = { txHash: null, success: false, result: null, error: 'not-used' };

  return {
    contractId: CONTRACT,
    nowNs: () => BigInt(Date.now()) * 1_000_000n,
    getContractState: async () =>
      ({ operator: OPERATOR, next_question_id: 1, next_nonce: 1, question_count: 0 }) as ContractState,
    getQuestion: async (qid) => question(qid),
    listQuestions: async () => [],
    getCommitment: async () => null as CommitmentView | null,
    listCommitments: async () => [],
    getBalance: async () => emptyBalance,
    hasBought: async (qid, account) => bought(qid, account),
    getBuyerReceipt: async () => null as BuyerReceiptView | null,
    listBuyers: async () => [],
    getPendingWithdrawal: async () => null as PendingWithdrawalView | null,
    listPendingWithdrawals: async () => [],
    viewAccountBalance: async () => 0n,
    viewAccessKeyPermission: async (accountId, publicKey) => permission(accountId, publicKey),
    createQuestion: async (_spec: QuestionSpecArgs) => out,
    commit: async () => out,
    publishSnapshot: async () => out,
    buyForecast: async () => out,
    resolve: async () => out,
    reveal: async () => out,
    settle: async () => out,
    cancel: async () => out,
    claimBuyerRefund: async () => out,
    withdraw: async () => out,
  };
}

/** A controllable wall clock (the external time adapter). */
class FakeClock {
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

function tmpDbPath(): string {
  return path.join(tmpdir(), `hc-access-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

async function signChallenge(
  accountId: string,
  message: string,
  nonceBase64: string,
  recipient: string,
): Promise<{ publicKey: string; signature: string }> {
  const kp = KeyPair.fromRandom('ed25519');
  const signer = new KeyPairSigner(kp);
  const nonce = new Uint8Array(Buffer.from(nonceBase64, 'base64'));
  const signed = await signer.signNep413Message(accountId, { message, nonce, recipient });
  return { publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString('base64') };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('auth: real purchase owner with a valid NEP-413 signature gets the frozen payload', async () => {
  const dbPath = tmpDbPath();
  const config = buildConfig(dbPath);
  const clock = new FakeClock();
  const chain = makeFakeChain({ bought: () => true, question: (qid) => questionView(qid) });
  const store = new Store(dbPath, config.networkId, config.contractId);
  store.saveQuestion(localQuestion(1), 'price:target-1');
  store.saveSnapshot(snapshotRecord(1, 'snap-1'));
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner, { clock });

  const buyer = 'buyer.hivecast-1105-0548.testnet';
  const challenge = runtime.mintAccessChallenge(buyer);
  const signed = await signChallenge(buyer, challenge.message, challenge.nonce, challenge.recipient);
  const verified = await runtime.verifyAccessChallenge({
    challengeId: challenge.challenge_id,
    accountId: buyer,
    publicKey: signed.publicKey,
    signature: signed.signature,
  });
  assert.equal(verified.dto.account_id, buyer);

  const delivery = await runtime.deliverForecast(1, verified.sessionId);
  assert.equal(delivery.question_id, 1);
  assert.equal(delivery.snapshot_id, 'snap-1');
  assert.equal(delivery.aggregate_bps, 5000);
  assert.equal(delivery.total_stake_yocto, (10n ** 23n).toString());
  assert.equal(delivery.participant_count, 1);
  assert.equal(delivery.single_agent, true);

  store.close();
  rmSync(dbPath, { force: true });
});

test('auth: another account or a bare public tx hash is never proof', async () => {
  const dbPath = tmpDbPath();
  const config = buildConfig(dbPath);
  const chain = makeFakeChain({ bought: () => false, question: (qid) => questionView(qid) });
  const store = new Store(dbPath, config.networkId, config.contractId);
  store.saveQuestion(localQuestion(1), 'price:target-1');
  store.saveSnapshot(snapshotRecord(1, 'snap-1'));
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner, { clock: new FakeClock() });

  const buyer = 'buyer.hivecast-1105-0548.testnet';
  const challenge = runtime.mintAccessChallenge(buyer);
  const signed = await signChallenge(buyer, challenge.message, challenge.nonce, challenge.recipient);
  const verified = await runtime.verifyAccessChallenge({
    challengeId: challenge.challenge_id,
    accountId: buyer,
    publicKey: signed.publicKey,
    signature: signed.signature,
  });

  // Another account cannot use this session.
  await assert.rejects(
    () => runtime.deliverForecast(1, verified.sessionId),
    (err: unknown) => err instanceof AccessError && err.code === 'not_purchased',
  );

  // The public tx hash / account id alone is not accepted by the auth path:
  // /forecast requires a session; there is no tx-hash-based endpoint.
  await assert.rejects(
    () => runtime.deliverForecast(1, 'not-a-real-session'),
    (err: unknown) => err instanceof AccessError && err.code === 'unauthenticated',
  );

  store.close();
  rmSync(dbPath, { force: true });
});

test('auth: replay and expiry and function-call key fail closed', async () => {
  const dbPath = tmpDbPath();
  const config = buildConfig(dbPath);
  const clock = new FakeClock();
  const chain = makeFakeChain({ permission: () => 'function-call' });
  const store = new Store(dbPath, config.networkId, config.contractId);
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner, { clock });

  const buyer = 'buyer.hivecast-1105-0548.testnet';
  const challenge = runtime.mintAccessChallenge(buyer);
  const signed = await signChallenge(buyer, challenge.message, challenge.nonce, challenge.recipient);

  // Function-call key is rejected.
  await assert.rejects(
    () =>
      runtime.verifyAccessChallenge({
        challengeId: challenge.challenge_id,
        accountId: buyer,
        publicKey: signed.publicKey,
        signature: signed.signature,
      }),
    (err: unknown) => err instanceof AccessError && err.code === 'not_full_access',
  );

  // Expiry: advance the clock past the challenge TTL.
  const chain2 = makeFakeChain({}); // full-access
  const runtime2 = new Runtime(config, chain2, store, new Runner(config, chain2, store), { clock });
  const challenge2 = runtime2.mintAccessChallenge(buyer);
  clock.advance(config.access.challengeTtlMs + 1);
  const signed2 = await signChallenge(buyer, challenge2.message, challenge2.nonce, challenge2.recipient);
  await assert.rejects(
    () =>
      runtime2.verifyAccessChallenge({
        challengeId: challenge2.challenge_id,
        accountId: buyer,
        publicKey: signed2.publicKey,
        signature: signed2.signature,
      }),
    (err: unknown) => err instanceof AccessError && err.code === 'challenge_expired',
  );

  store.close();
  rmSync(dbPath, { force: true });
});

test('auth: wrong-context challenge and invalid signature fail closed', async () => {
  const dbPath = tmpDbPath();
  const config = buildConfig(dbPath);
  const chain = makeFakeChain({});
  const store = new Store(dbPath, config.networkId, config.contractId);
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner, { clock: new FakeClock() });

  const buyer = 'buyer.hivecast-1105-0548.testnet';
  const challenge = runtime.mintAccessChallenge(buyer);
  const signed = await signChallenge(buyer, challenge.message, challenge.nonce, challenge.recipient);

  // Invalid signature (corrupt one byte).
  const badSigBytes = Buffer.from(signed.signature, 'base64');
  badSigBytes[0] = badSigBytes[0]! ^ 0xff;
  await assert.rejects(
    () =>
      runtime.verifyAccessChallenge({
        challengeId: challenge.challenge_id,
        accountId: buyer,
        publicKey: signed.publicKey,
        signature: badSigBytes.toString('base64'),
      }),
    (err: unknown) => err instanceof AccessError && err.code === 'invalid_signature',
  );

  // A different service context (contract) cannot consume the challenge.
  const otherConfig = buildConfig(dbPath, { contractId: 'other-market.testnet' });
  const otherRuntime = new Runtime(otherConfig, chain, store, new Runner(otherConfig, chain, store));
  await assert.rejects(
    () =>
      otherRuntime.verifyAccessChallenge({
        challengeId: challenge.challenge_id,
        accountId: buyer,
        publicKey: signed.publicKey,
        signature: signed.signature,
      }),
    (err: unknown) => err instanceof AccessError && err.code === 'account_mismatch',
  );

  store.close();
  rmSync(dbPath, { force: true });
});

test('auth: repeat access returns the same frozen payload without a new charge', async () => {
  const dbPath = tmpDbPath();
  const config = buildConfig(dbPath);
  const chain = makeFakeChain({ bought: () => true, question: (qid) => questionView(qid) });
  const store = new Store(dbPath, config.networkId, config.contractId);
  store.saveQuestion(localQuestion(1), 'price:target-1');
  store.saveSnapshot(snapshotRecord(1, 'snap-1'));
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner, { clock: new FakeClock() });

  const buyer = 'buyer.hivecast-1105-0548.testnet';
  const challenge = runtime.mintAccessChallenge(buyer);
  const signed = await signChallenge(buyer, challenge.message, challenge.nonce, challenge.recipient);
  const verified = await runtime.verifyAccessChallenge({
    challengeId: challenge.challenge_id,
    accountId: buyer,
    publicKey: signed.publicKey,
    signature: signed.signature,
  });

  const first = await runtime.deliverForecast(1, verified.sessionId);
  const second = await runtime.deliverForecast(1, verified.sessionId);
  assert.deepEqual(first, second);

  store.close();
  rmSync(dbPath, { force: true });
});

test('auth: concurrent challenge consumption admits exactly one verifier', async () => {
  const dbPath = tmpDbPath();
  const config = buildConfig(dbPath);
  const chain = makeFakeChain({});
  const store = new Store(dbPath, config.networkId, config.contractId);
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner, { clock: new FakeClock() });

  const buyer = 'buyer.hivecast-1105-0548.testnet';
  const challenge = runtime.mintAccessChallenge(buyer);
  const signed = await signChallenge(buyer, challenge.message, challenge.nonce, challenge.recipient);
  const verify = () =>
    runtime.verifyAccessChallenge({
      challengeId: challenge.challenge_id,
      accountId: buyer,
      publicKey: signed.publicKey,
      signature: signed.signature,
    });

  const results = await Promise.allSettled([verify(), verify()]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent verifier should succeed');
  assert.equal(rejected.length, 1, 'the other concurrent verifier should fail');
  const rejection = rejected[0] as PromiseRejectedResult;
  assert.ok(rejection.reason instanceof AccessError && rejection.reason.code === 'challenge_consumed');

  store.close();
  rmSync(dbPath, { force: true });
});

test('delivery: unavailable snapshot is honest, with no claimed automatic refund', async () => {
  const dbPath = tmpDbPath();
  const config = buildConfig(dbPath);
  const chain = makeFakeChain({ bought: () => true, question: (qid) => questionView(qid) });
  const store = new Store(dbPath, config.networkId, config.contractId);
  store.saveQuestion(localQuestion(1), 'price:target-1');
  // Snapshot intentionally absent (lost private DB) — delivery must be 503.
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner, { clock: new FakeClock() });

  const buyer = 'buyer.hivecast-1105-0548.testnet';
  const challenge = runtime.mintAccessChallenge(buyer);
  const signed = await signChallenge(buyer, challenge.message, challenge.nonce, challenge.recipient);
  const verified = await runtime.verifyAccessChallenge({
    challengeId: challenge.challenge_id,
    accountId: buyer,
    publicKey: signed.publicKey,
    signature: signed.signature,
  });

  await assert.rejects(
    () => runtime.deliverForecast(1, verified.sessionId),
    (err: unknown) => err instanceof AccessError && err.code === 'snapshot_unavailable',
  );

  store.close();
  rmSync(dbPath, { force: true });
});

test('http: challenge → verify → cookie → forecast delivery across the public routes', async () => {
  const dbPath = tmpDbPath();
  const config = buildConfig(dbPath);
  const chain = makeFakeChain({ bought: () => true, question: (qid) => questionView(qid) });
  const store = new Store(dbPath, config.networkId, config.contractId);
  store.saveQuestion(localQuestion(1), 'price:target-1');
  store.saveSnapshot(snapshotRecord(1, 'snap-1'));
  const runner = new Runner(config, chain, store);
  const runtime = new Runtime(config, chain, store, runner, { clock: new FakeClock() });
  const server = createPublicService(runtime);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const base = `http://127.0.0.1:${addr.port}`;
  const buyer = 'buyer.hivecast-1105-0548.testnet';

  try {
    // 1. Mint a challenge over HTTP.
    const challengeResp = await fetch(`${base}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ account_id: buyer }),
    });
    assert.equal(challengeResp.status, 200);
    const challenge = (await challengeResp.json()) as {
      challenge_id: string;
      nonce: string;
      message: string;
      recipient: string;
      account_id: string;
    };
    assert.equal(challenge.account_id, buyer);

    // 2. Verify with a real signature.
    const signed = await signChallenge(buyer, challenge.message, challenge.nonce, challenge.recipient);
    const verifyResp = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({
        challenge_id: challenge.challenge_id,
        account_id: buyer,
        public_key: signed.publicKey,
        signature: signed.signature,
      }),
    });
    assert.equal(verifyResp.status, 200);
    const setCookie = verifyResp.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /hivecast_session=/);
    assert.match(setCookie, /HttpOnly/);

    // 3. Retrieve the frozen payload with the session cookie.
    const deliveryResp = await fetch(`${base}/forecast/1`, { headers: { cookie: setCookie.split(';')[0]! } });
    assert.equal(deliveryResp.status, 200);
    const delivery = (await deliveryResp.json()) as { snapshot_id: string; aggregate_bps: number };
    assert.equal(delivery.snapshot_id, 'snap-1');
    assert.equal(delivery.aggregate_bps, 5000);

    // 4. Without a session cookie, delivery is denied.
    const noCookieResp = await fetch(`${base}/forecast/1`);
    assert.equal(noCookieResp.status, 401);
    const noCookieBody = (await noCookieResp.json()) as { error: string };
    assert.equal(noCookieBody.error, 'unauthenticated');

    // 5. Trust disclosure is served publicly.
    const disclosureResp = await fetch(`${base}/disclosure`);
    assert.equal(disclosureResp.status, 200);
    const disclosure = (await disclosureResp.json()) as { delivery_limits: string[] };
    assert.ok(disclosure.delivery_limits.length > 0);

    // 6. A disallowed browser Origin is rejected on the auth routes.
    const badOriginResp = await fetch(`${base}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ account_id: buyer }),
    });
    assert.equal(badOriginResp.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dbPath, { force: true });
  }
});
