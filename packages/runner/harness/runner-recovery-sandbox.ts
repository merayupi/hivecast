/**
 * Runner restart/recovery integration proof (ticket #5 → #7 dependency).
 *
 * Linux-only. Drives the PRODUCTION `Runner` (createQuestion/tick) against the
 * REAL contract WASM on a REAL `near-sandbox` node, with EPHEMERAL 8-identity
 * operator/resolver/agent accounts and a deterministic `SourceProvider`
 * (external source adapter). It fault-injects an RPC *transport response drop*
 * AFTER the node actually accepted each transaction — the prepared signed
 * transaction is durable before broadcast, so a restart must reconcile the
 * SAME on-chain state without re-signing, regenerating a salt, duplicating a
 * commitment, or double-paying.
 *
 * Proved at the public seam only (no private Store/Borsh helper assertion):
 *   - restart around Commit: ONE accepted commitment per agent, SAME hash
 *   - restart around frozen Snapshot: SAME published on-chain snapshot id
 *   - restart around Withdrawal: received balance exactly once, no double payout
 *
 * No in-process contract duplicate, no mock RPC success: every view/mutation
 * hits the real sandbox RPC. Sandbox fast-forward only (never testnet).
 *
 * Usage (Linux):
 *   HIVECAST_WASM=contracts/hivecast/target/wasm32-unknown-unknown/release/hivecast.wasm \
 *   NEAR_SANDBOX_BIN_PATH=$HOME/.near/near-sandbox-2.14.0-rc.5/near-sandbox \
 *   npm run sandbox:recovery --workspace @hivecast/runner
 */

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';

import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto } from 'near-api-js';
import type { AgentId, Candle } from '@hivecast/core';

import { NearChainClient } from '../src/chain/near.js';
import type { CallOutcome } from '../src/chain/types.js';
import type { RunnerConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import type { SourceProvider, StrategyInputResult, ResolutionResult } from '../src/runner.js';
import { Store } from '../src/store.js';
import { SandboxChainBase } from './sandbox-chain.js';
import type { LocalQuestion } from '../src/types.js';

const WASM_PATH = process.env.HIVECAST_WASM ?? 'contracts/hivecast/target/wasm32-unknown-unknown/release/hivecast.wasm';
const SANDBOX_BIN =
  process.env.NEAR_SANDBOX_BIN_PATH ?? `${process.env.HOME}/.near/near-sandbox-2.14.0-rc.5/near-sandbox`;

// Deterministic sandbox TEST fixture key (near-workspaces default genesis key).
const REGISTRAR_ACCOUNT = 'registrar';
const REGISTRAR_PRIVATE_KEY = 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB';
const REGISTRAR_PUBLIC_KEY = 'ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB';

const NS_PER_BLOCK = 1_000_000_000n; // nominal 1s; real per-block time measured at runtime
const SAND_ACCOUNT = 'sandbox';
const CLONE_ACCOUNT = 'clone';
const GENESIS_BALANCE = 10_000_000_000_000_000_000_000_000_000n; // 10,000 NEAR

const PRICE_AGENTS = ['persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip'] as const;

interface SandboxProc {
  rpcUrl: string;
  homeDir: string;
  stop: () => void;
}

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  if (port === 0) throw new Error('failed to allocate a concrete spare port');
  return port;
}

async function waitForRpc(rpcUrl: string, timeoutMs = 60_000, childExit?: () => number | null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (childExit) {
      const code = childExit();
      if (code !== null) throw new Error(`sandbox exited early with status ${code}`);
    }
    try {
      const res = await fetch(`${rpcUrl}/status`, { method: 'GET' });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`sandbox RPC did not become ready within ${timeoutMs}ms (last: ${lastError})`);
}

function appendGenesisAccount(records: unknown[], accountId: string): void {
  records.push({
    Account: {
      account_id: accountId,
      account: { amount: GENESIS_BALANCE.toString(), locked: '0', code_hash: '11111111111111111111111111111111', storage_usage: 182 },
    },
  });
  records.push({
    AccessKey: {
      account_id: accountId,
      public_key: REGISTRAR_PUBLIC_KEY,
      access_key: { nonce: 0, permission: 'FullAccess' },
    },
  });
}

async function startSandbox(): Promise<SandboxProc> {
  assert.ok(existsSync(SANDBOX_BIN), `near-sandbox binary not found at ${SANDBOX_BIN}`);
  const homeDir = mkdtempSync(path.join(tmpdir(), 'hc-recovery-'));
  const rpcPort = await freePort();
  const netPort = await freePort();
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;

  execFileSync(SANDBOX_BIN, ['--home', homeDir, 'init', '--fast'], { stdio: 'ignore' });

  const configPath = path.join(homeDir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  const rpc = (config.rpc ??= {}) as Record<string, unknown>;
  const limits = (rpc.limits_config ??= {}) as Record<string, unknown>;
  limits.json_payload_max_size = 1024 * 1024 * 1024;
  const storeCfg = (config.store ??= {}) as Record<string, unknown>;
  storeCfg.max_open_files = 3000;
  writeFileSync(configPath, JSON.stringify(config));

  const genesisPath = path.join(homeDir, 'genesis.json');
  const genesis = JSON.parse(readFileSync(genesisPath, 'utf8')) as { total_supply: string; records: unknown[] };
  let totalSupply = BigInt(genesis.total_supply);
  for (const accountId of [SAND_ACCOUNT, CLONE_ACCOUNT, REGISTRAR_ACCOUNT]) {
    totalSupply += GENESIS_BALANCE;
    appendGenesisAccount(genesis.records, accountId);
  }
  genesis.total_supply = totalSupply.toString();
  writeFileSync(genesisPath, JSON.stringify(genesis));

  const keyJson = (accountId: string) =>
    JSON.stringify({ account_id: accountId, public_key: REGISTRAR_PUBLIC_KEY, private_key: REGISTRAR_PRIVATE_KEY });
  writeFileSync(path.join(homeDir, 'sandbox.json'), keyJson(SAND_ACCOUNT));
  writeFileSync(path.join(homeDir, 'registrar.json'), keyJson(REGISTRAR_ACCOUNT));

  const child = spawn(
    SANDBOX_BIN,
    ['--home', homeDir, 'run', '--rpc-addr', `127.0.0.1:${rpcPort}`, '--network-addr', `127.0.0.1:${netPort}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdoutBuf = '';
  let stderrBuf = '';
  let exitCode: number | null = null;
  child.stdout?.on('data', (d: Buffer) => {
    stdoutBuf += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderrBuf += d.toString();
  });
  child.on('exit', (code) => {
    exitCode = code;
  });

  try {
    await waitForRpc(rpcUrl, 60_000, () => exitCode);
  } catch (err) {
    const reason = `\n--- sandbox stdout (tail) ---\n${stdoutBuf.slice(-4000)}\n--- sandbox stderr (tail) ---\n${stderrBuf.slice(-8000)}\n--- exit status: ${exitCode === null ? 'still running' : exitCode} ---`;
    throw new Error(`sandbox startup failed: ${(err as Error).message}${reason}`);
  }

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

async function measureBlockTimeNs(rpcUrl: string): Promise<bigint> {
  const before = await currentBlockNs(rpcUrl);
  await sandboxFastForward(rpcUrl, 10);
  const after = await currentBlockNs(rpcUrl);
  const perBlock = (after - before) / 10n;
  return perBlock > 0n ? perBlock : NS_PER_BLOCK;
}

async function advanceTo(rpcUrl: string, targetNs: bigint, blockTimeNs: bigint): Promise<bigint> {
  while (true) {
    const cur = await currentBlockNs(rpcUrl);
    if (cur >= targetNs) return cur;
    const delta = targetNs - cur;
    const blocks = Number((delta + blockTimeNs - 1n) / blockTimeNs) + 1;
    await sandboxFastForward(rpcUrl, blocks);
  }
}

interface EphemeralAccount {
  accountId: string;
  keyPair: KeyPair;
}

async function createEphemeralAccount(registrar: Account, provider: JsonRpcProvider, prefix: string): Promise<EphemeralAccount> {
  const accountId = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.registrar`;
  const keyPair = KeyPair.fromRandom('ed25519');
  await registrar.createAccount({
    newAccountId: accountId,
    publicKey: keyPair.getPublicKey(),
    nearToTransfer: nearToYocto('100'),
  });
  return { accountId, keyPair };
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

// ---------------------------------------------------------------------------
// Thin spec-allowed adapters: a sandbox-block-time clock + transport-drop fault
// injection, delegating EVERY view/mutation to the real NearChainClient.
// ---------------------------------------------------------------------------

class SandboxRunnerChain extends SandboxChainBase {
  private dropNextBroadcasts = 0;
  private staleNonceArmed = false;
  private externalOperatorSigner: Account | null = null;
  private externalOperatorId = '';

  dropBroadcastResponses(n: number): void {
    this.dropNextBroadcasts = n;
  }

  /**
   * Arm a REAL stale-nonce trigger: on the next broadcast, a SEPARATE external
   * signer (its own Account/nonceManager) consumes the operator's current
   * on-chain nonce with a benign native Transfer BEFORE the daemon's prepared
   * signed tx is broadcast, so the daemon's cached nonce is stale.
   */
  armStaleNonce(operatorId: string, externalAccount: Account): void {
    this.externalOperatorId = operatorId;
    this.externalOperatorSigner = externalAccount;
    this.staleNonceArmed = true;
  }

  override async broadcastCall(signedBytesBase64: string): Promise<CallOutcome> {
    // If armed, first consume the operator's current on-chain nonce via the
    // SEPARATE external signer (a real native Transfer), making the daemon's
    // cached nonce stale before its prepared tx is broadcast.
    if (this.staleNonceArmed && this.externalOperatorSigner) {
      this.staleNonceArmed = false;
      await this.externalOperatorSigner.transfer({
        receiverId: this.externalOperatorId,
        amount: 1n,
      });
    }
    // Broadcast for REAL (the node accepts the tx), then optionally drop the
    // RESPONSE to simulate a transport failure after acceptance. The prepared
    // signed tx was persisted before this call, so the runner reconciles
    // without re-signing.
    const outcome = await this.inner.broadcastCall(signedBytesBase64);
    if (this.dropNextBroadcasts > 0) {
      this.dropNextBroadcasts--;
      return {
        txHash: outcome.txHash,
        success: false,
        result: null,
        error: 'simulated transport response drop (transaction already broadcast)',
        status: 'uncertain',
      };
    }
    return outcome;
  }
}

/** Deterministic external-source adapter (spec-allowed): fixed completed price
 * candles (all up) + a fixed resolution Outcome, so the six price strategies
 * commit and the resolver resolves without live Binance/Open-Meteo. */
class FixedPriceSourceProvider implements SourceProvider {
  async strategyInputs(_q: LocalQuestion): Promise<StrategyInputResult> {
    const candles: Candle[] = Array.from({ length: 25 }, (_, i) => {
      const openTime = 1_700_000_000_000 - (25 - i) * 3_600_000;
      const closeTime = openTime + 3_599_999;
      return {
        openTime: String(openTime),
        open: '100',
        high: '102',
        low: '99',
        close: '101',
        closeTime: String(closeTime),
        volume: '1000',
        quoteVolume: '101000',
        trades: '100',
        takerBaseVolume: '500',
        takerQuoteVolume: '50500',
      };
    });
    return { inputs: { kind: 'price', candles }, disclosure: JSON.stringify({ kind: 'fixed-price-fixture' }) };
  }

  async resolveOutcome(_q: LocalQuestion): Promise<ResolutionResult> {
    return { outcome: true, evidenceJson: JSON.stringify({ kind: 'fixed-price-fixture', outcome: true }), evidenceHash: 'fixture' };
  }
}

function buildAgentAccounts(accts: Map<string, string>): Record<AgentId, string> {
  return {
    meteo: accts.get('meteo')!,
    climatology: accts.get('climatology')!,
    persistence: accts.get('persistence')!,
    momentum: accts.get('momentum')!,
    meanrev: accts.get('meanrev')!,
    'noisy-trend': accts.get('noisy-trend')!,
    yolo: accts.get('yolo')!,
    coinflip: accts.get('coinflip')!,
  };
}

async function main(): Promise<void> {
  const sb = await startSandbox();
  try {
    const provider = new JsonRpcProvider({ url: sb.rpcUrl });
    const registrar = new Account(REGISTRAR_ACCOUNT, provider, REGISTRAR_PRIVATE_KEY);

    // Deploy the real WASM to a fresh contract account.
    const contractId = `contract-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.registrar`;
    const contractKey = KeyPair.fromRandom('ed25519');
    await registrar.createAccount({ newAccountId: contractId, publicKey: contractKey.getPublicKey(), nearToTransfer: nearToYocto('500') });
    const contractAccount = new Account(contractId, provider, contractKey.toString());
    await contractAccount.deployContract(new Uint8Array(readFileSync(WASM_PATH)));

    // Ephemeral operator, resolver, and 8 agent identities (all funded 100 NEAR).
    const operator = await createEphemeralAccount(registrar, provider, 'operator');
    const resolver = await createEphemeralAccount(registrar, provider, 'resolver');
    const agentAccts = new Map<string, string>();
    const agentKeys = new Map<string, KeyPair>();
    for (const id of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) {
      const acct = await createEphemeralAccount(registrar, provider, id.replace(/-/g, ''));
      agentAccts.set(id, acct.accountId);
      agentKeys.set(id, acct.keyPair);
    }

    await callFunction(contractAccount, contractId, 'new', { operator: operator.accountId });

    const blockTimeNs = await measureBlockTimeNs(sb.rpcUrl);

    // Generous schedule anchored AFTER all account setup.
    const t0 = await currentBlockNs(sb.rpcUrl);
    const openTime = t0 + 300n * NS_PER_BLOCK;
    const closeTime = t0 + 900n * NS_PER_BLOCK;
    const obsStart = t0 + 1100n * NS_PER_BLOCK;
    const obsEnd = t0 + 1400n * NS_PER_BLOCK;
    const resolveDeadline = t0 + 2000n * NS_PER_BLOCK;
    const revealWindow = 600n * NS_PER_BLOCK;
    const accessPrice = nearToYocto('0.01');
    const minStake = nearToYocto('0.1');

    const dbPath = path.join(tmpdir(), `hc-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

    const credentials: Record<string, string> = {
      [operator.accountId]: operator.keyPair.toString(),
      [resolver.accountId]: resolver.keyPair.toString(),
    };
    for (const [id, kp] of agentKeys) {
      credentials[agentAccts.get(id)!] = kp.toString();
    }

    function buildConfig(): RunnerConfig {
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
        agentAccounts: buildAgentAccounts(agentAccts),
        binanceBaseUrl: 'https://api.binance.com',
        openMeteoBaseUrl: 'https://api.open-meteo.com',
        archiveBaseUrl: 'https://archive-api.open-meteo.com',
        kudusLatitude: '-6.8049',
        kudusLongitude: '110.8397',
        kudusTimezone: 'Asia/Jakarta',
        operationalGasReserveYocto: 0n,
        rpcTimeoutMs: 30_000,
        http: { enabled: false, host: '127.0.0.1', port: 8787 },
        access: {
          sessionTtlMs: 86_400_000,
          challengeTtlMs: 300_000,
          cookieName: 'hivecast_session',
          cookieSecure: false,
          serviceDomain: 'hivecast',
          allowedOrigins: ['http://localhost:5173'],
        },
        credentials,
      };
    }

    const config = buildConfig();
    const innerChain = new NearChainClient(config);
    const chain = new SandboxRunnerChain(innerChain, t0);
    const source = new FixedPriceSourceProvider();
    const store = new Store(dbPath, config.networkId, config.contractId);

    function freshRunner(): Runner {
      return new Runner(config, chain, store, source);
    }

    // 1. Create the Question via the PRODUCTION runner (full immutable spec
    // journaled before broadcast).
    let runner = freshRunner();
    const created = await runner.createQuestion({
      domain: 'price',
      text: 'Will the target hour close higher than it opened?',
      eventDefinition: 'Binance spot NEARUSDT 1h candle: YES means close > open',
      sourceJson: JSON.stringify({ instrument: 'NEARUSDT', interval: '1h' }),
      sourceLabel: 'Binance NEARUSDT 1h',
      targetKey: 'price:recovery-fixture',
      openTimeNs: openTime,
      closeTimeNs: closeTime,
      observationStartNs: obsStart,
      observationEndNs: obsEnd,
      resolveTimeNs: obsEnd,
      resolveDeadlineNs: resolveDeadline,
      revealWindowNs: revealWindow,
    });
    assert.ok(typeof created.questionId === 'number', `create_question failed: ${JSON.stringify(created)}`);
    const questionId = created.questionId!;

    // 2. Commit with ONE transport response drop after acceptance, then
    // restart and reconcile → exactly one commitment per agent, SAME hash.
    const openLanded = await advanceTo(sb.rpcUrl, openTime, blockTimeNs);
    chain.setNow(openLanded);
    chain.dropBroadcastResponses(1);
    await runner.tick();
    const hashesAfterFirstCommit = (await innerChain.listCommitments(questionId, 0, 64)).map((c) => c.hash).sort();

    // Restart: recreate the Runner from the SAME durable Store.
    runner = freshRunner();
    chain.setNow(openLanded);
    await runner.tick();

    const commitmentsAfterRestart = await innerChain.listCommitments(questionId, 0, 64);
    const hashesAfterRestart = commitmentsAfterRestart.map((c) => c.hash).sort();
    assert.equal(commitmentsAfterRestart.length, PRICE_AGENTS.length, 'exactly one commitment per price agent');
    assert.deepEqual(hashesAfterRestart, hashesAfterFirstCommit, 'commit hashes must not change after restart (no fresh salt)');
    for (const id of PRICE_AGENTS) {
      const c = await innerChain.getCommitment(questionId, agentAccts.get(id)!);
      assert.ok(c && c.hash, `commitment missing for ${id}`);
    }
    // Canonical prepared-hash assertion (the consumer check that the durable
    // prepared tx hash is the REAL NEAR transaction id, not the old signed-bytes
    // hash): each commit journal entry's tx_hash must resolve via the public
    // finalized-status view to the SAME canonical hash with a proven SuccessValue.
    {
      const commitJournal = store.listJournal('commit').filter((j) => j.questionId === questionId && j.txHash !== null);
      assert.ok(commitJournal.length >= PRICE_AGENTS.length, `expected >=${PRICE_AGENTS.length} commit journal entries with a tx hash, got ${commitJournal.length}`);
      // The committed tx's are already finalized (sandbox produced blocks for
      // each commit); poll once more past a block so `viewTxFinalStatus` is
      // non-null for every entry.
      await advanceTo(sb.rpcUrl, (await currentBlockNs(sb.rpcUrl)) + 2n * NS_PER_BLOCK, blockTimeNs);
      for (const entry of commitJournal) {
        const signer = entry.accountId ?? agentAccts.get('persistence')!;
        const view = await innerChain.viewTxFinalStatus(entry.txHash!, signer);
        assert.ok(view, `prepared tx hash ${entry.txHash} not found on chain (canonical hash lookup failed)`);
        assert.equal(view.tx_hash, entry.txHash, 'prepared tx hash must match the on-chain canonical hash');
        assert.equal(view.success_value, true, `commit tx ${entry.txHash} must have a proven SuccessValue`);
      }
      process.stdout.write('recovery: canonical prepared-hash lookup OK (real NEAR tx id resolves)\n');
    }
    process.stdout.write('recovery: commit-reconcile OK (one commitment per agent, same hash)\n');

    // 3. Freeze + publish the snapshot with ONE transport response drop, then
    // restart → the SAME on-chain snapshot id (no regeneration).
    const closeLanded = await advanceTo(sb.rpcUrl, closeTime + 2n * NS_PER_BLOCK, blockTimeNs);
    chain.setNow(closeLanded);
    chain.dropBroadcastResponses(1);
    await runner.tick();
    const snapshotIdAfterPublish = (await innerChain.getQuestion(questionId))?.snapshot_id ?? null;
    assert.ok(snapshotIdAfterPublish, 'snapshot not published');

    runner = freshRunner();
    chain.setNow(closeLanded);
    await runner.tick();
    const snapshotIdAfterRestart = (await innerChain.getQuestion(questionId))?.snapshot_id ?? null;
    assert.equal(snapshotIdAfterRestart, snapshotIdAfterPublish, 'snapshot id must not change after restart');
    const qAfterSnapshot = await innerChain.getQuestion(questionId);
    assert.equal(qAfterSnapshot?.snapshot_ready, true);
    process.stdout.write('recovery: snapshot-reconcile OK (same snapshot id)\n');

    // 4. Resolve + reveal + settle (production runner), then withdraw with ONE
    // transport response drop, restart, and assert no double payout.
    //
    // The production daemon ticks repeatedly; a single tick at a phase
    // boundary may submit a transition that the contract only accepts once the
    // block timestamp has actually crossed the boundary. Drive each transition
    // with a bounded loop that re-advances + re-ticks until the public phase
    // is observed (never a narrowed assertion: the exact phase/outcome is still
    // required, and every tick report is logged).

    async function driveUntilPhase(
      expectedPhase: 'resolved' | 'settled',
      targetNs: bigint,
      maxTicks: number,
    ): Promise<void> {
      for (let i = 0; i < maxTicks; i++) {
        const landed = await advanceTo(sb.rpcUrl, targetNs + BigInt(i) * NS_PER_BLOCK, blockTimeNs);
        chain.setNow(landed);
        const report = await runner.tick();
        process.stdout.write(`recovery: tick(${i}) now=${landed} steps=${JSON.stringify(report.steps)}\n`);
        const q = await innerChain.getQuestion(questionId);
        if (q?.phase === expectedPhase) return;
      }
      const final = await innerChain.getQuestion(questionId);
      throw new Error(`driveUntilPhase(${expectedPhase}) did not reach phase: ${JSON.stringify(final)}`);
    }

    // 4a. Resolve within [resolve_time, resolve_deadline).
    await driveUntilPhase('resolved', obsEnd + 2n * NS_PER_BLOCK, 8);
    const resolvedQ = await innerChain.getQuestion(questionId);
    assert.equal(resolvedQ?.phase, 'resolved', `expected resolved: ${JSON.stringify(resolvedQ)}`);
    assert.equal(resolvedQ?.outcome, true);

    // 4b. Reveal within [resolved_at, reveal_deadline) — a SEPARATE tick from
    // settle, so every agent reveals before the window closes.
    const revealTarget = resolvedQ!.resolved_at
      ? BigInt(resolvedQ!.resolved_at) + 2n * NS_PER_BLOCK
      : obsEnd + 4n * NS_PER_BLOCK;
    {
      const landed = await advanceTo(sb.rpcUrl, revealTarget, blockTimeNs);
      chain.setNow(landed);
      const revealReport = await runner.tick();
      process.stdout.write(`recovery: reveal tick steps=${JSON.stringify(revealReport.steps)}\n`);
    }

    // 4c. Settle (permissionless) AFTER the reveal deadline — do it DIRECTLY
    // via the chain so the Runner's auto-withdraw does NOT run in the same
    // operation. Then read the EXACT public claimable baseline BEFORE the
    // Runner's actual withdrawal (no duplicate accounting).
    const revealDeadline = resolvedQ!.reveal_deadline ? BigInt(resolvedQ!.reveal_deadline) : revealTarget + revealWindow;
    const settleLanded = await advanceTo(sb.rpcUrl, revealDeadline + 2n * NS_PER_BLOCK, blockTimeNs);
    chain.setNow(settleLanded);
    const settleOutcome = await chain.settle(questionId, operator.accountId);
    assert.equal(settleOutcome.success, true, `settle failed: ${settleOutcome.error}`);
    const settledQ = await innerChain.getQuestion(questionId);
    assert.equal(settledQ?.phase, 'settled', `expected settled: ${JSON.stringify(settledQ)}`);

    // EXACT public pre-withdraw entitlement baseline (claimable + native).
    const claimableBefore = new Map<string, string>();
    const nativeBefore = new Map<string, bigint>();
    for (const id of PRICE_AGENTS) {
      const b = await innerChain.getBalance(agentAccts.get(id)!);
      claimableBefore.set(id, b.claimable);
      nativeBefore.set(id, await innerChain.viewNativeBalance(agentAccts.get(id)!));
    }
    const positiveClaimable = [...claimableBefore.values()].filter((c) => BigInt(c) > 0n);
    assert.ok(positiveClaimable.length > 0, 'expected positive claimable entitlement before withdraw');

    // Withdraw with ONE transport response drop (the first agent's broadcast).
    chain.dropBroadcastResponses(1);
    chain.setNow(settleLanded);
    await runner.tick(); // withdrawAllAgents drains the entitlement

    // Restart and tick again — must NOT re-withdraw or double-pay.
    runner = freshRunner();
    chain.setNow(settleLanded);
    await runner.tick();

    // Let the withdraw callbacks finalize (a few more blocks).
    await advanceTo(sb.rpcUrl, settleLanded + 5n * NS_PER_BLOCK, blockTimeNs);
    chain.setNow(await currentBlockNs(sb.rpcUrl));
    await runner.tick();

    for (const id of PRICE_AGENTS) {
      const b = await innerChain.getBalance(agentAccts.get(id)!);
      const claimed = BigInt(claimableBefore.get(id)!);
      assert.equal(b.claimable, '0', `${id} claimable not drained`);
      assert.equal(b.pending, '0', `${id} still pending`);
      assert.equal(b.received, claimed.toString(), `${id} received must equal exactly its claimable (no double payout)`);
      const nativeAfter = await innerChain.viewNativeBalance(agentAccts.get(id)!);
      assert.ok(nativeAfter > nativeBefore.get(id)!, `${id} native balance did not increase after withdraw`);
    }
    process.stdout.write('recovery: withdraw-reconcile OK (exact single payout, no double)\n');

    // 5. Stale-nonce recovery: a REAL concurrent external signer (a second
    // Account for the operator, its own nonceManager) consumes the operator's
    // on-chain nonce before the daemon broadcasts a prepared create_question.
    // The daemon's cached nonce is then stale → InvalidNonceError → nonceStale
    // → runOnce reconciles + evicts the nonce cache + re-prepares a FRESH
    // signed tx for the SAME intent. Assert exactly ONE on-chain question (no
    // duplicate) with the matching spec, and a confirmed journal.
    {
      // A separate external signer for the operator (independent nonce cache).
      const externalOperator = new Account(operator.accountId, provider, operator.keyPair.toString());
      chain.armStaleNonce(operator.accountId, externalOperator);

      const q2Spec = {
        domain: 'price' as const,
        text: 'Second recovery fixture',
        eventDefinition: 'Binance spot NEARUSDT 1h candle: YES means close > open',
        sourceJson: JSON.stringify({ instrument: 'NEARUSDT', interval: '1h' }),
        sourceLabel: 'Binance NEARUSDT 1h',
        targetKey: 'price:recovery-fixture-2',
        openTimeNs: openTime + 1n,
        closeTimeNs: closeTime + 1n,
        observationStartNs: obsStart + 1n,
        observationEndNs: obsEnd + 1n,
        resolveTimeNs: obsEnd + 1n,
        resolveDeadlineNs: resolveDeadline + 1n,
        revealWindowNs: revealWindow,
      };

      // The daemon's FIRST prepared tx is definitively rejected with a stale
      // nonce (the external signer consumed it). `createQuestion` correctly
      // reports "will retry same intent" on that call; recovery happens on the
      // NEXT attempt, which re-broadcasts the stale signed tx, then evicts the
      // nonce cache and re-prepares a FRESH signed tx for the SAME spec. Drive
      // the real recovery with a bounded loop (production daemon retries).
      let q2Id: number | null = null;
      for (let attempt = 0; attempt < 6 && q2Id === null; attempt++) {
        const attemptResult = await runner.createQuestion(q2Spec);
        process.stdout.write(
          `recovery: stale-nonce createQuestion attempt ${attempt} = ${JSON.stringify(attemptResult)}\n`,
        );
        if (typeof attemptResult.questionId === 'number') {
          q2Id = attemptResult.questionId;
          break;
        }
        // Not yet recovered: advance a block + retry so the nonce cache is
        // fresh and the chain blockHash has moved (no infinite rebroadcast of a
        // stale signed tx).
        const landed = await advanceTo(sb.rpcUrl, (await currentBlockNs(sb.rpcUrl)) + 2n * NS_PER_BLOCK, blockTimeNs);
        chain.setNow(landed);
        const report = await runner.tick();
        process.stdout.write(
          `recovery: stale-nonce reconcile tick ${attempt} = ${JSON.stringify(report.steps)}\n`,
        );
      }
      assert.ok(q2Id !== null, 'stale-nonce create_question did not recover to a question id');

      // Exactly one on-chain question with the matching spec (no duplicate).
      const allQuestions = await innerChain.listQuestions(0, 100);
      const matches = allQuestions.filter(
        (q) => q.source === q2Spec.sourceJson && q.observation_start === q2Spec.observationStartNs.toString(),
      );
      assert.equal(matches.length, 1, `expected exactly one stale-nonce create_question, got ${matches.length}`);
      assert.equal(matches[0]!.question_id, q2Id);

      // The journal intent is confirmed with a canonical tx hash.
      const journal = store.getJournal(`create_question:${q2Spec.targetKey}`);
      assert.ok(journal, 'create_question journal missing');
      assert.equal(journal.status, 'confirmed');
      assert.ok(journal.txHash, 'confirmed create_question missing tx hash');
      process.stdout.write('recovery: stale-nonce external-signer reconcile OK (single fresh tx, same intent)\n');
    }

    store.close();
    rmSync(dbPath, { force: true });
    process.stdout.write('recovery-sandbox OK: commit/snapshot/withdraw + stale-nonce restart reconciliation proven at the public seam\n');
  } finally {
    sb.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`recovery-sandbox failed: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
