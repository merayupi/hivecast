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
import type { RunnerConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { Store } from '../src/store.js';
import { SandboxChainBase } from './sandbox-chain.js';
import { wibDateOfUtcMs, msToNs, nsToMs, MS_PER_HOUR, MS_PER_DAY, MS_PER_MIN, computeWeatherSchedule, computePriceSchedule, hourFloorUtc } from '../src/schedule.js';
import type { LocalQuestion } from '../src/types.js';

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

type FixtureMode = 'weather-below' | 'weather-equal' | 'weather-above' | 'missing-resolve' | 'price-equal';

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

async function waitForRpc(rpcUrl: string, timeoutMs = 90_000, childExit?: () => number | null): Promise<void> {
  // neard exposes a plain HTTP `GET /status` endpoint AND a JSON-RPC `status`
  // method. Require BOTH before proceeding, so a follow-up `fetch` POST cannot
  // hit a half-started node and throw "fetch failed".
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (childExit) {
      const code = childExit();
      if (code !== null) throw new Error(`sandbox exited early with status ${code}`);
    }
    try {
      const status = await fetch(`${rpcUrl}/status`, { method: 'GET' });
      if (status.ok) {
        const rpc = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'ready', method: 'status', params: [] }),
        });
        if (rpc.ok) {
          const body = (await rpc.json()) as { result?: unknown };
          if (body && 'result' in body) return;
          lastError = 'JSON-RPC status returned no result';
        } else {
          lastError = `JSON-RPC status HTTP ${rpc.status}`;
        }
      } else {
        lastError = `GET /status HTTP ${status.status}`;
      }
    } catch (err) {
      const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
      lastError = `${(err as Error).message}${cause ? ` (cause: ${String(cause)})` : ''}`;
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
  process.stdout.write(`source-boundary: sandbox init (rpc ${rpcPort}, net ${netPort})\n`);

  execFileSync(SANDBOX_BIN, ['--home', homeDir, 'init', '--fast'], { stdio: 'ignore' });
  process.stdout.write('source-boundary: sandbox init done\n');

  const configPath = path.join(homeDir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  const rpc = (config.rpc ??= {}) as Record<string, unknown>;
  const limits = (rpc.limits_config ??= {}) as Record<string, unknown>;
  limits.json_payload_max_size = 1024 * 1024 * 1024;
  const storeCfg = (config.store ??= {}) as Record<string, unknown>;
  storeCfg.max_open_files = 3000;
  writeFileSync(configPath, JSON.stringify(config));

  const genesisPath = path.join(homeDir, 'genesis.json');
  const genesis = JSON.parse(readFileSync(genesisPath, 'utf8')) as {
    total_supply: string;
    records: unknown[];
    epoch_length?: number;
  };
  // `--fast` init generates a TINY epoch_length. sandbox_fast_forward must stop
  // `epoch_length - 3` blocks before each epoch boundary and produce the
  // boundary blocks PHYSICALLY (see nearcore client_actor sandbox_process_fast_
  // forward), so a multi-day leap across many short epochs forces thousands of
  // real blocks (the observed ~166s/20k-chunk stall). Set a large epoch_length
  // so a full 24h/48h jump stays within a handful of epochs.
  const originalEpochLength = typeof genesis.epoch_length === 'number' ? genesis.epoch_length : null;
  const newEpochLength = 1_000_000;
  genesis.epoch_length = newEpochLength;
  process.stdout.write(
    `source-boundary: genesis epoch_length ${originalEpochLength ?? 'unset'} → ${newEpochLength}\n`,
  );
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

/** Fast-forward in BOUNDED chunks (never one giant multi-day leap that can
 * exceed a single RPC deadline). Logs each chunk so a stall is observable. */
async function sandboxFastForwardChunked(rpcUrl: string, totalBlocks: number, chunkSize = 20_000): Promise<void> {
  let remaining = totalBlocks;
  while (remaining > 0) {
    const chunk = Math.min(chunkSize, remaining);
    await sandboxFastForward(rpcUrl, chunk);
    remaining -= chunk;
    if (remaining > 0) {
      process.stdout.write(`source-boundary: fast-forward ${chunk} blocks (${remaining} remaining)\n`);
    }
  }
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
    // Bound the fast-forward into chunks so a large leap never exceeds a single
    // RPC deadline; re-read the actual block timestamp after each chunk.
    await sandboxFastForwardChunked(rpcUrl, blocks);
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
    let priceOpenMs = 0;
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
        if (mode === 'missing-resolve') {
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
        rpcTimeoutMs: 30_000,
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

    async function weatherScenario(mode: 'weather-below' | 'weather-equal' | 'weather-above' | 'missing-resolve', expect: 'no' | 'yes' | 'cancel'): Promise<void> {
      // Fresh anchor from the ACTUAL current block time (the chain advanced in
      // every prior scenario). Target a WIB date at least 3 days ahead so the
      // full opening (prev-day 18:00 WIB) is still in the future.
      const curMs = nsToMs(await currentBlockNs(sb.rpcUrl));
      // Next WIB midnight strictly after (cur + 3 days).
      const wibMidnightMs = Date.parse(wibDateOfUtcMs(curMs + 3 * MS_PER_DAY) + 'T00:00:00+07:00');
      const targetDateWibMs = wibMidnightMs;
      const date = wibDateOfUtcMs(targetDateWibMs);
      // PRODUCTION weather schedule (opening prev-day 18:00 WIB, cutoff 23:55 WIB).
      const schedule = computeWeatherSchedule(targetDateWibMs);
      // For `missing-resolve`, the pre-cutoff INPUTS (forecast + archive
      // history) must be VALID so the specialists commit normally; the source
      // outage only begins at the RESOLUTION stage. Start with a valid mode for
      // the commit, then switch to `missing-resolve` before the resolve tick.
      const commitMode: FixtureMode = mode === 'missing-resolve' ? 'weather-above' : mode;
      fixture.setMode(commitMode);
      fixture.setDate(date);
      process.stdout.write(`source-boundary: ${mode} target=${date} open=${schedule.openTimeNs} commitMode=${commitMode}\n`);

      const config = buildConfig();
      const innerChain = new NearChainClient(config);
      const chain = new SandboxChainBase(innerChain, await currentBlockNs(sb.rpcUrl));
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
          open_time: schedule.openTimeNs.toString(),
          close_time: schedule.closeTimeNs.toString(),
          observation_start: schedule.observationStartNs.toString(),
          observation_end: schedule.observationEndNs.toString(),
          resolve_time: null,
          resolve_deadline: schedule.resolveDeadlineNs.toString(),
          reveal_window: schedule.revealWindowNs.toString(),
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
        openTimeNs: schedule.openTimeNs,
        closeTimeNs: schedule.closeTimeNs,
        observationStartNs: schedule.observationStartNs,
        observationEndNs: schedule.observationEndNs,
        resolveTimeNs: schedule.resolveTimeNs,
        resolveDeadlineNs: schedule.resolveDeadlineNs,
        revealWindowNs: schedule.revealWindowNs,
        accessPrice,
        minStake,
        participants: [
          { agentId: 'meteo', accountId: agentAccts.get('meteo')! },
          { agentId: 'climatology', accountId: agentAccts.get('climatology')! },
        ],
      };
      store.saveQuestion(local, `weather:${date}`);

      // Advance the sandbox into the commitment window and commit the meteo
      // agent via the production runner (fetches strategy inputs from the
      // fixture's /v1/forecast + archive history). At least one commitment
      // avoids the contract's zero-commitments cancel path and exercises real
      // resolution. A single tick after a large clock leap can prepare a tx
      // whose blockHash reference expires before broadcast; retry bounded with
      // fresh block timestamps (the production daemon ticks repeatedly).
      const openTimeNs = local.openTimeNs;
      await advanceTo(sb.rpcUrl, openTimeNs + 2n * NS_PER_BLOCK, blockTimeNs);
      chain.setNow(await currentBlockNs(sb.rpcUrl));
      const commitRunner = new Runner(config, chain, store);

      let commitsAfterOpen = await innerChain.listCommitments(questionId, 0, 64);
      for (let attempt = 0; attempt < 6 && commitsAfterOpen.length < 1; attempt++) {
        const landed = await advanceTo(sb.rpcUrl, openTimeNs + (2n + BigInt(attempt)) * NS_PER_BLOCK, blockTimeNs);
        chain.setNow(landed);
        const commitReport = await commitRunner.tick();
        process.stdout.write(
          `source-boundary: ${mode} commit attempt ${attempt} now=${landed} steps=${JSON.stringify(commitReport.steps)}\n`,
        );
        commitsAfterOpen = await innerChain.listCommitments(questionId, 0, 64);
      }
      assert.ok(commitsAfterOpen.length >= 1, `expected >=1 commitment, got ${commitsAfterOpen.length}`);

      // Begin the RESOLUTION-stage source outage only AFTER the commit is
      // accepted: switch the fixture so /v1/archive (the resolve fetch) 404s,
      // while the already-persisted inputs/forecast remain intact.
      if (mode === 'missing-resolve') {
        fixture.setMode('missing-resolve');
      }

      const obsEnd = local.observationEndNs;
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
        // Drive resolution with a bounded loop (the production daemon ticks
        // repeatedly; a single tick at the boundary may submit before the
        // block timestamp crosses resolve_time).
        let q = await innerChain.getQuestion(questionId);
        for (let i = 0; i < 8 && q?.phase !== 'resolved'; i++) {
          const landed = await advanceTo(sb.rpcUrl, obsEnd + (2n + BigInt(i)) * NS_PER_BLOCK, blockTimeNs);
          chain.setNow(landed);
          const report = await runner.tick();
          process.stdout.write(`source-boundary: ${mode} tick(${i}) steps=${JSON.stringify(report.steps)}\n`);
          q = await innerChain.getQuestion(questionId);
        }
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
    await weatherScenario('missing-resolve', 'cancel');
    process.stdout.write('source-boundary: missing source → timeout-cancel (public phase)\n');

    // P1. Price equal close → NO. The production price fetcher reads its "now"
    // from the injected chain clock (chain.nowNs()), so we anchor a fresh FULL
    // UTC hour in the sandbox FUTURE (via computePriceSchedule), fast-forward
    // through open→commit→observation end, and let resolveOutcome derive NO
    // from an equal open/close candle.
    {
      const curMs = nsToMs(await currentBlockNs(sb.rpcUrl));
      // A future full UTC hour (at least 2 hours ahead so open window is fresh).
      const priceOpenMs = hourFloorUtc(curMs) + 2 * MS_PER_HOUR;
      const schedule = computePriceSchedule(priceOpenMs);
      fixture.setMode('price-equal');
      fixture.setPriceOpenMs(priceOpenMs);
      process.stdout.write(`source-boundary: price-equal openMs=${priceOpenMs} open=${schedule.openTimeNs}\n`);

      const config = buildConfig();
      const innerChain = new NearChainClient(config);
      const chain = new SandboxChainBase(innerChain, await currentBlockNs(sb.rpcUrl));
      const store = new Store(config.databasePath, config.networkId, config.contractId);
      const sourceJson = JSON.stringify({ kind: 'price', instrument: 'NEARUSDT', interval: '1h' });

      const questionId = (await callFunction(operatorAccount, contractId, 'create_question', {
        spec: {
          text: 'Price boundary fixture',
          event_definition: 'Binance spot NEARUSDT 1h candle: YES means close > open',
          source: sourceJson,
          resolver: resolver.accountId,
          open_time: schedule.openTimeNs.toString(),
          close_time: schedule.closeTimeNs.toString(),
          observation_start: schedule.observationStartNs.toString(),
          observation_end: schedule.observationEndNs.toString(),
          resolve_time: null,
          resolve_deadline: schedule.resolveDeadlineNs.toString(),
          reveal_window: schedule.revealWindowNs.toString(),
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
        openTimeNs: schedule.openTimeNs,
        closeTimeNs: schedule.closeTimeNs,
        observationStartNs: schedule.observationStartNs,
        observationEndNs: schedule.observationEndNs,
        resolveTimeNs: schedule.resolveTimeNs,
        resolveDeadlineNs: schedule.resolveDeadlineNs,
        revealWindowNs: schedule.revealWindowNs,
        accessPrice,
        minStake,
        participants: [{ agentId: 'coinflip', accountId: agentAccts.get('coinflip')! }],
      };
      store.saveQuestion(local, `price:${priceOpenMs}`);

      // 1. Commit a coinflip agent (deterministic, no candle dependency) so the
      //    Round has a participant and cannot take the zero-commitments cancel.
      await advanceTo(sb.rpcUrl, local.openTimeNs + 2n * NS_PER_BLOCK, blockTimeNs);
      chain.setNow(await currentBlockNs(sb.rpcUrl));
      await new Runner(config, chain, store).tick();
      const commits = await innerChain.listCommitments(questionId, 0, 64);
      assert.ok(commits.length >= 1, `expected >=1 commitment, got ${commits.length}`);

      // 2. Fast-forward past observation end (resolve_time) so the injected
      //    chain clock makes the equal open/close candle "completed" → NO.
      await advanceTo(sb.rpcUrl, local.resolveTimeNs + 2n * NS_PER_BLOCK, blockTimeNs);
      chain.setNow(await currentBlockNs(sb.rpcUrl));
      const priceRunner = new Runner(config, chain, store);
      await priceRunner.tick();

      // Drive resolution with a bounded loop (production daemon ticks
      // repeatedly; a single tick may submit before the block time crosses
      // resolve_time).
      let q = await innerChain.getQuestion(questionId);
      for (let i = 0; i < 8 && q?.phase !== 'resolved'; i++) {
        const landed = await advanceTo(sb.rpcUrl, local.resolveTimeNs + (2n + BigInt(i)) * NS_PER_BLOCK, blockTimeNs);
        chain.setNow(landed);
        const report = await priceRunner.tick();
        process.stdout.write(`source-boundary: price tick(${i}) steps=${JSON.stringify(report.steps)}\n`);
        q = await innerChain.getQuestion(questionId);
      }
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
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    process.stderr.write(
      `source-boundary-sandbox failed: ${err.stack ?? err.message}${cause ? `\ncause: ${typeof cause === 'object' && cause !== null ? (cause as Error).stack ?? String(cause) : String(cause)}` : ''}\n`,
    );
  } else {
    process.stderr.write(`source-boundary-sandbox failed (non-Error): ${String(err)}\n`);
  }
  process.exit(1);
});
