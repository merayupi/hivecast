/**
 * Source-boundary resolution proof (ticket #7 dependency).
 *
 * Linux-only. Proves the PRODUCTION source parsers choose the correct public
 * Outcome/Cancellation, by pointing the production `LiveSourceProvider` (the
 * default source inside `Runner`) at LOCAL HTTP fixtures via `binanceBaseUrl` /
 * `openMeteoBaseUrl` / `archiveBaseUrl`. No source.ts replacement and no
 * handwritten boolean: every Outcome comes from the real `resolveOutcome`
 * parsing a real HTTP response, lands on the real contract WASM, and is
 * asserted via the PUBLIC `get_question`.
 *
 * Scenarios (each a fresh on-chain Question, driven by the production Runner):
 *   W1. weather archive precipitation < 1.0 mm  → public outcome NO (false)
 *   W2. weather archive precipitation == 1.0 mm → public outcome YES (true)
 *   W3. weather archive precipitation > 1.0 mm  → public outcome YES (true)
 *   M1. missing source response                 → wait then timeout-cancel
 *        (public phase `cancelled`)
 *   P1. price target candle close == open       → public outcome NO (false)
 *
 * No in-process contract duplicate, no mock RPC success. Sandbox fast-forward
 * only (never testnet). Usage (Linux):
 *   HIVECAST_WASM=contracts/hivecast/target/wasm32-unknown-unknown/release/hivecast.wasm \
 *   NEAR_SANDBOX_BIN_PATH=$HOME/.near/near-sandbox-2.14.0-rc.5/near-sandbox \
 *   npm run sandbox:source --workspace @hivecast/runner
 */

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';

import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto } from 'near-api-js';
import type { AgentId } from '@hivecast/core';

import { NearChainClient } from '../src/chain/near.js';
import type { ChainClient, CallOutcome, PreparedCall, QuestionSpecArgs, TxFinalStatusView } from '../src/chain/types.js';
import type { RunnerConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { Store } from '../src/store.js';
import { wibDateOfUtcMs, msToNs, nsToMs, MS_PER_HOUR, MS_PER_DAY, MS_PER_MIN } from '../src/schedule.js';
import type {
  BalanceView,
  BuyerReceiptView,
  CommitmentView,
  ContractState,
  LocalQuestion,
  PendingWithdrawalView,
  QuestionView,
} from '../src/types.js';

const WASM_PATH = process.env.HIVECAST_WASM ?? 'contracts/hivecast/target/wasm32-unknown-unknown/release/hivecast.wasm';
const SANDBOX_BIN =
  process.env.NEAR_SANDBOX_BIN_PATH ?? `${process.env.HOME}/.near/near-sandbox-2.14.0-rc.5/near-sandbox`;

const REGISTRAR_ACCOUNT = 'registrar';
const REGISTRAR_PRIVATE_KEY = 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB';
const REGISTRAR_PUBLIC_KEY = 'ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB';

const NS_PER_BLOCK = 1_000_000_000n;
const SAND_ACCOUNT = 'sandbox';
const CLONE_ACCOUNT = 'clone';
const GENESIS_BALANCE = 10_000_000_000_000_000_000_000_000_000n; // 10,000 NEAR

type FixtureMode = 'weather-below' | 'weather-equal' | 'weather-above' | 'price-equal' | 'missing';

interface HttpFixture {
  base: string;
  setMode(m: FixtureMode): void;
  setDate(d: string): void;
  setPriceOpenMs(ms: number): void;
  close: () => Promise<void>;
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

async function startSandbox(): Promise<{ rpcUrl: string; stop: () => void }> {
  assert.ok(existsSync(SANDBOX_BIN), `near-sandbox binary not found at ${SANDBOX_BIN}`);
  const homeDir = mkdtempSync(path.join(tmpdir(), 'hc-source-'));
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
// Block-time adapter (spec-allowed): delegate everything, override nowNs().
// ---------------------------------------------------------------------------
class SandboxClockChain implements ChainClient {
  readonly contractId: string;
  private readonly inner: NearChainClient;
  private currentNs: bigint;
  constructor(inner: NearChainClient, initialNs: bigint) {
    this.inner = inner;
    this.contractId = inner.contractId;
    this.currentNs = initialNs;
  }
  setNow(ns: bigint): void {
    this.currentNs = ns;
  }
  nowNs(): bigint {
    return this.currentNs;
  }
  getContractState(): Promise<ContractState> {
    return this.inner.getContractState();
  }
  getQuestion(q: number): Promise<QuestionView | null> {
    return this.inner.getQuestion(q);
  }
  listQuestions(f: number, l: number): Promise<QuestionView[]> {
    return this.inner.listQuestions(f, l);
  }
  getCommitment(q: number, a: string): Promise<CommitmentView | null> {
    return this.inner.getCommitment(q, a);
  }
  listCommitments(q: number, f: number, l: number): Promise<CommitmentView[]> {
    return this.inner.listCommitments(q, f, l);
  }
  getBalance(a: string): Promise<BalanceView> {
    return this.inner.getBalance(a);
  }
  hasBought(q: number, a: string): Promise<boolean> {
    return this.inner.hasBought(q, a);
  }
  getBuyerReceipt(q: number, a: string): Promise<BuyerReceiptView | null> {
    return this.inner.getBuyerReceipt(q, a);
  }
  listBuyers(q: number, f: number, l: number): Promise<BuyerReceiptView[]> {
    return this.inner.listBuyers(q, f, l);
  }
  getPendingWithdrawal(n: number): Promise<PendingWithdrawalView | null> {
    return this.inner.getPendingWithdrawal(n);
  }
  listPendingWithdrawals(a: string, f: number, l: number): Promise<PendingWithdrawalView[]> {
    return this.inner.listPendingWithdrawals(a, f, l);
  }
  viewAccountBalance(a: string): Promise<bigint> {
    return this.inner.viewAccountBalance(a);
  }
  viewNativeBalance(a: string): Promise<bigint> {
    return this.inner.viewNativeBalance(a);
  }
  viewNativeAvailable(a: string): Promise<bigint> {
    return this.inner.viewNativeAvailable(a);
  }
  viewAccessKeyPermission(a: string, pk: string): Promise<'full-access' | 'function-call' | null> {
    return this.inner.viewAccessKeyPermission(a, pk);
  }
  viewTxTokensBurnt(h: string, s: string): Promise<string | null> {
    return this.inner.viewTxTokensBurnt(h, s);
  }
  viewTxFinalStatus(h: string, a: string): Promise<TxFinalStatusView | null> {
    return this.inner.viewTxFinalStatus(h, a);
  }
  prepareCall(m: string, args: Record<string, unknown>, s: string, d: bigint, g?: bigint): Promise<PreparedCall> {
    return this.inner.prepareCall(m, args, s, d, g);
  }
  broadcastCall(b: string): Promise<CallOutcome> {
    return this.inner.broadcastCall(b);
  }
  createQuestion(spec: QuestionSpecArgs, signer: string): Promise<CallOutcome> {
    return this.inner.createQuestion(spec, signer);
  }
  commit(q: number, h: string, stake: bigint, signer: string): Promise<CallOutcome> {
    return this.inner.commit(q, h, stake, signer);
  }
  publishSnapshot(q: number, sid: string, signer: string): Promise<CallOutcome> {
    return this.inner.publishSnapshot(q, sid, signer);
  }
  buyForecast(q: number, price: bigint, signer: string): Promise<CallOutcome> {
    return this.inner.buyForecast(q, price, signer);
  }
  resolve(q: number, o: boolean, signer: string): Promise<CallOutcome> {
    return this.inner.resolve(q, o, signer);
  }
  reveal(q: number, p: number, salt: string, signer: string): Promise<CallOutcome> {
    return this.inner.reveal(q, p, salt, signer);
  }
  settle(q: number, signer: string): Promise<CallOutcome> {
    return this.inner.settle(q, signer);
  }
  cancel(q: number, signer: string): Promise<CallOutcome> {
    return this.inner.cancel(q, signer);
  }
  claimBuyerRefund(q: number, signer: string): Promise<CallOutcome> {
    return this.inner.claimBuyerRefund(q, signer);
  }
  withdraw(amount: bigint, signer: string): Promise<CallOutcome> {
    return this.inner.withdraw(amount, signer);
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

function startFixture(): Promise<HttpFixture> {
  return new Promise((resolveFixture) => {
    let mode: FixtureMode = 'weather-below';
    let targetDate = '';
    let priceOpenMs = 1_758_000_000_000;
    const server: HttpServer = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('content-type', 'application/json; charset=utf-8');
      if (url.pathname === '/api/v3/klines') {
        const closeTime = priceOpenMs + MS_PER_HOUR - 1;
        const open = '100';
        const close = mode === 'price-equal' ? '100' : '101';
        res.end(JSON.stringify([[priceOpenMs, open, '102', '99', close, '1000', closeTime, '101000', '100', '500', '50500']]));
        return;
      }
      if (url.pathname === '/v1/archive') {
        if (mode === 'missing') {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        const value = mode === 'weather-below' ? 0.5 : mode === 'weather-equal' ? 1.0 : 2.0;
        res.end(JSON.stringify({ daily: { time: [targetDate], precipitation_sum: [value] } }));
        return;
      }
      if (url.pathname === '/v1/forecast') {
        res.end(JSON.stringify({ daily: { time: [targetDate], precipitation_sum: [1.5] } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'no route' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      assert.ok(a && typeof a === 'object');
      resolveFixture({
        base: `http://127.0.0.1:${a.port}`,
        setMode: (m) => {
          mode = m;
        },
        setDate: (d) => {
          targetDate = d;
        },
        setPriceOpenMs: (ms) => {
          priceOpenMs = ms;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main(): Promise<void> {
  const fixture = await startFixture();
  const sb = await startSandbox();
  try {
    const provider = new JsonRpcProvider({ url: sb.rpcUrl });
    const registrar = new Account(REGISTRAR_ACCOUNT, provider, REGISTRAR_PRIVATE_KEY);

    const contractId = `contract-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.registrar`;
    const contractKey = KeyPair.fromRandom('ed25519');
    await registrar.createAccount({ newAccountId: contractId, publicKey: contractKey.getPublicKey(), nearToTransfer: nearToYocto('500') });
    const contractAccount = new Account(contractId, provider, contractKey.toString());
    await contractAccount.deployContract(new Uint8Array(readFileSync(WASM_PATH)));

    const operator = await createEphemeralAccount(registrar, provider, 'operator');
    const resolver = await createEphemeralAccount(registrar, provider, 'resolver');
    const operatorAccount = new Account(operator.accountId, provider, operator.keyPair.toString());
    const agentAccts = new Map<string, string>();
    const agentKeys = new Map<string, KeyPair>();
    for (const id of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) {
      const acct = await createEphemeralAccount(registrar, provider, id.replace(/-/g, ''));
      agentAccts.set(id, acct.accountId);
      agentKeys.set(id, acct.keyPair);
    }

    await callFunction(contractAccount, contractId, 'new', { operator: operator.accountId });

    const credentials: Record<string, string> = {
      [operator.accountId]: operator.keyPair.toString(),
      [resolver.accountId]: resolver.keyPair.toString(),
    };
    for (const [id, kp] of agentKeys) credentials[agentAccts.get(id)!] = kp.toString();

    const blockTimeNs = await measureBlockTimeNs(sb.rpcUrl);
    const t0 = await currentBlockNs(sb.rpcUrl);

    function buildConfig(): RunnerConfig {
      return {
        networkId: 'sandbox',
        contractId,
        operatorId: operator.accountId,
        resolverId: resolver.accountId,
        rpcUrl: sb.rpcUrl,
        credentialDirectory: path.join(tmpdir(), 'no-credentials'),
        databasePath: path.join(tmpdir(), `hc-source-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`),
        seed: 42,
        pollIntervalMs: 60_000,
        minStakeYocto: nearToYocto('0.1'),
        accessPriceYocto: nearToYocto('0.01'),
        agentAccounts: buildAgentAccounts(agentAccts),
        binanceBaseUrl: fixture.base,
        openMeteoBaseUrl: fixture.base,
        archiveBaseUrl: fixture.base,
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
        credentials,
      };
    }

    const minStake = nearToYocto('0.1');
    const accessPrice = nearToYocto('0.01');

    async function weatherScenario(mode: 'weather-below' | 'weather-equal' | 'weather-above' | 'missing', expect: 'no' | 'yes' | 'cancel'): Promise<void> {
      const targetDateWibMs = nsToMs(t0) + 4 * MS_PER_DAY;
      const date = wibDateOfUtcMs(targetDateWibMs);
      fixture.setMode(mode);
      fixture.setDate(date);

      const config = buildConfig();
      const innerChain = new NearChainClient(config);
      const chain = new SandboxClockChain(innerChain, t0);
      const store = new Store(config.databasePath, config.networkId, config.contractId);

      const sourceJson = JSON.stringify({
        kind: 'weather',
        model: 'ecmwf_ifs',
        latitude: '-6.8049',
        longitude: '110.8397',
        timezone: 'Asia/Jakarta',
        threshold_mm: '1.0',
      });

      const questionId = (await callFunction(operatorAccount, contractId, 'create_question', {
        spec: {
          text: 'Weather boundary fixture',
          event_definition: 'Open-Meteo ECMWF IFS 9km daily precipitation_sum >= 1.0 mm',
          source: sourceJson,
          resolver: resolver.accountId,
          open_time: msToNs(targetDateWibMs - MS_PER_DAY + 18 * MS_PER_HOUR).toString(),
          close_time: msToNs(targetDateWibMs - MS_PER_DAY + 23 * MS_PER_HOUR + 55 * MS_PER_MIN).toString(),
          observation_start: msToNs(targetDateWibMs).toString(),
          observation_end: msToNs(targetDateWibMs + MS_PER_DAY).toString(),
          resolve_time: null,
          resolve_deadline: msToNs(targetDateWibMs + MS_PER_DAY + 48 * MS_PER_HOUR).toString(),
          reveal_window: msToNs(15 * MS_PER_MIN).toString(),
          access_price: accessPrice.toString(),
          min_stake: minStake.toString(),
        },
      })) as number;
      assert.ok(typeof questionId === 'number');

      const local: LocalQuestion = {
        questionId,
        domain: 'weather',
        text: 'Weather boundary fixture',
        eventDefinition: 'Open-Meteo ECMWF IFS 9km daily precipitation_sum >= 1.0 mm',
        sourceJson,
        sourceLabel: 'Open-Meteo ECMWF IFS 9km Kudus',
        resolver: resolver.accountId,
        openTimeNs: msToNs(targetDateWibMs - MS_PER_DAY + 18 * MS_PER_HOUR),
        closeTimeNs: msToNs(targetDateWibMs - MS_PER_DAY + 23 * MS_PER_HOUR + 55 * MS_PER_MIN),
        observationStartNs: msToNs(targetDateWibMs),
        observationEndNs: msToNs(targetDateWibMs + MS_PER_DAY),
        resolveTimeNs: msToNs(targetDateWibMs + MS_PER_DAY),
        resolveDeadlineNs: msToNs(targetDateWibMs + MS_PER_DAY + 48 * MS_PER_HOUR),
        revealWindowNs: msToNs(15 * MS_PER_MIN),
        accessPrice,
        minStake,
        participants: [
          { agentId: 'meteo', accountId: agentAccts.get('meteo')! },
          { agentId: 'climatology', accountId: agentAccts.get('climatology')! },
        ],
      };
      store.saveQuestion(local, `weather:${date}`);

      const obsEnd = msToNs(targetDateWibMs + MS_PER_DAY);
      await advanceTo(sb.rpcUrl, obsEnd + 2n * NS_PER_BLOCK, blockTimeNs);
      chain.setNow(await currentBlockNs(sb.rpcUrl));

      const runner = new Runner(config, chain, store);
      await runner.tick();

      if (expect === 'cancel') {
        await advanceTo(sb.rpcUrl, local.resolveDeadlineNs + 2n * NS_PER_BLOCK, blockTimeNs);
        chain.setNow(await currentBlockNs(sb.rpcUrl));
        await runner.tick();
        const q2 = await innerChain.getQuestion(questionId);
        assert.equal(q2?.phase, 'cancelled', `expected cancelled, got ${JSON.stringify(q2)}`);
      } else {
        const q = await innerChain.getQuestion(questionId);
        assert.equal(q?.phase, 'resolved', `expected resolved, got ${JSON.stringify(q)}`);
        assert.equal(q?.outcome, expect === 'yes', `outcome mismatch for ${mode}`);
      }
      store.close();
      rmSync(config.databasePath, { force: true });
    }

    await weatherScenario('weather-below', 'no');
    process.stdout.write('source-boundary: weather < 1.0mm → NO (public outcome)\n');
    await weatherScenario('weather-equal', 'yes');
    process.stdout.write('source-boundary: weather == 1.0mm → YES (public outcome)\n');
    await weatherScenario('weather-above', 'yes');
    process.stdout.write('source-boundary: weather > 1.0mm → YES (public outcome)\n');
    await weatherScenario('missing', 'cancel');
    process.stdout.write('source-boundary: missing source → timeout-cancel (public phase)\n');

    // P1. Price equal close → NO. The production price fetcher derives
    // "completed" from real Date.now(), so anchor the price target in the real
    // past; the contract resolve window spans [obsEnd, resolveDeadline) with a
    // resolveDeadline in the FUTURE so the sandbox (t0 ≈ real now) is inside it.
    {
      const nowMs = Date.now();
      const priceOpenMs = nowMs - 2 * MS_PER_HOUR; // fully-completed past hour
      const resolveDeadlineMs = nowMs + 30 * MS_PER_MIN; // future
      fixture.setMode('price-equal');
      fixture.setPriceOpenMs(priceOpenMs);

      const config = buildConfig();
      const innerChain = new NearChainClient(config);
      const chain = new SandboxClockChain(innerChain, await currentBlockNs(sb.rpcUrl));
      const store = new Store(config.databasePath, config.networkId, config.contractId);
      const sourceJson = JSON.stringify({ kind: 'price', instrument: 'NEARUSDT', interval: '1h' });

      const questionId = (await callFunction(operatorAccount, contractId, 'create_question', {
        spec: {
          text: 'Price boundary fixture',
          event_definition: 'Binance spot NEARUSDT 1h candle: YES means close > open',
          source: sourceJson,
          resolver: resolver.accountId,
          open_time: msToNs(priceOpenMs - 15 * MS_PER_MIN).toString(),
          close_time: msToNs(priceOpenMs - 5 * MS_PER_MIN).toString(),
          observation_start: msToNs(priceOpenMs).toString(),
          observation_end: msToNs(priceOpenMs + MS_PER_HOUR).toString(),
          resolve_time: null,
          resolve_deadline: msToNs(resolveDeadlineMs).toString(),
          reveal_window: msToNs(15 * MS_PER_MIN).toString(),
          access_price: accessPrice.toString(),
          min_stake: minStake.toString(),
        },
      })) as number;
      assert.ok(typeof questionId === 'number');

      const local: LocalQuestion = {
        questionId,
        domain: 'price',
        text: 'Price boundary fixture',
        eventDefinition: 'Binance spot NEARUSDT 1h candle: YES means close > open',
        sourceJson,
        sourceLabel: 'Binance NEARUSDT 1h',
        resolver: resolver.accountId,
        openTimeNs: msToNs(priceOpenMs - 15 * MS_PER_MIN),
        closeTimeNs: msToNs(priceOpenMs - 5 * MS_PER_MIN),
        observationStartNs: msToNs(priceOpenMs),
        observationEndNs: msToNs(priceOpenMs + MS_PER_HOUR),
        resolveTimeNs: msToNs(priceOpenMs + MS_PER_HOUR),
        resolveDeadlineNs: msToNs(resolveDeadlineMs),
        revealWindowNs: msToNs(15 * MS_PER_MIN),
        accessPrice,
        minStake,
        participants: [{ agentId: 'coinflip', accountId: agentAccts.get('coinflip')! }],
      };
      store.saveQuestion(local, `price:${priceOpenMs}`);

      // The chain block time (sandbox t0 ≈ real now) is inside the resolve
      // window; do NOT fast-forward. The production resolveOutcome sees a
      // completed past candle (Date.now()) and derives close==open → NO.
      chain.setNow(await currentBlockNs(sb.rpcUrl));
      const runner = new Runner(config, chain, store);
      await runner.tick();

      const q = await innerChain.getQuestion(questionId);
      assert.equal(q?.phase, 'resolved', `expected resolved, got ${JSON.stringify(q)}`);
      assert.equal(q?.outcome, false, 'equal-close must resolve NO');
      store.close();
      rmSync(config.databasePath, { force: true });
      process.stdout.write('source-boundary: price equal close → NO (public outcome)\n');
    }

    process.stdout.write('source-boundary-sandbox OK\n');
  } finally {
    await fixture.close();
    sb.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`source-boundary-sandbox failed: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
