/**
 * RPC failover: availability failures move to the next endpoint, definitive
 * chain answers never do, the working endpoint stays active, and the primary
 * is retried after a while. No network: the endpoints are in-memory fakes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';

import { TypedError } from 'near-api-js';
import { InvalidNonceError, UnknownTransactionError, AccountDoesNotExistError, InternalRpcError } from 'near-api-js/rpc-errors';
import { failover, isTransportError, rpcHost } from '../src/chain/failover.js';
import { loadConfig } from '../src/config.js';

/** An instance of a typed RPC error without depending on its constructor arguments. */
function typed<T extends Error>(cls: abstract new (...args: never[]) => T, message: string): T {
  return Object.assign(Object.create(cls.prototype) as T, { message });
}

/** What near-api-js throws for an HTTP 429 / 5xx answer: an Error with the status in `cause`. */
function httpError(status: number, body = 'error'): Error {
  return Object.assign(new Error(body), { cause: status });
}

interface FakeRpc {
  name: string;
  calls: number;
  view(arg: string): Promise<string | null>;
}

function fake(name: string, behave: (arg: string, call: number) => string | null | Error): FakeRpc {
  return {
    name,
    calls: 0,
    async view(arg: string) {
      this.calls += 1;
      const out = behave(arg, this.calls);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

test('isTransportError: rate limits, 5xx, network failures and exhausted retries are availability failures', () => {
  assert.equal(isTransportError(httpError(429, '{"error":{"code":-429,"message":"Rate limits exceeded"}}')), true);
  assert.equal(isTransportError(httpError(503)), true);
  assert.equal(isTransportError(httpError(408)), true);
  assert.equal(isTransportError(new TypeError('fetch failed')), true);
  assert.equal(isTransportError(new SyntaxError('Unexpected token < in JSON')), true);
  assert.equal(isTransportError(new TypedError('Exceeded 3 attempts for request', 'RetriesExceeded')), true);
  assert.equal(isTransportError(typed(InternalRpcError, 'node is syncing')), true);
});

test('isTransportError: a definitive answer from the chain is never an availability failure', () => {
  assert.equal(isTransportError(typed(InvalidNonceError, 'nonce 5 must be larger than 9')), false);
  assert.equal(isTransportError(typed(UnknownTransactionError, 'Transaction X does not exist')), false);
  assert.equal(isTransportError(typed(AccountDoesNotExistError, 'account a.testnet does not exist')), false);
  assert.equal(isTransportError(new Error('some unexpected bug')), false);
  assert.equal(isTransportError('not an error'), false);
});

test('failover: the primary answers, the fallback is never called', async () => {
  const a = fake('a', () => 'from-a');
  const b = fake('b', () => 'from-b');
  const rpc = failover([a, b]);
  assert.equal(await rpc.view('x'), 'from-a');
  assert.equal(b.calls, 0);
  assert.equal(rpc.name, 'a', 'non-function properties come from the active endpoint');
});

test('failover: a rate-limited primary falls through to the fallback, which then stays active', async () => {
  const a = fake('a', () => httpError(429, 'Rate limits exceeded'));
  const b = fake('b', (arg) => `b:${arg}`);
  const switches: string[] = [];
  const rpc = failover([a, b], { onSwitch: (from, to) => switches.push(`${from}->${to}`) });
  assert.equal(await rpc.view('one'), 'b:one');
  assert.equal(await rpc.view('two'), 'b:two');
  assert.equal(a.calls, 1, 'the rate-limited primary is not hit again on the next call');
  assert.equal(b.calls, 2);
  assert.deepEqual(switches, ['0->1']);
  assert.equal(rpc.name, 'b');
});

test('failover: a null result is a valid answer, not a failure', async () => {
  const a = fake('a', () => null);
  const b = fake('b', () => 'from-b');
  const rpc = failover([a, b]);
  assert.equal(await rpc.view('missing'), null);
  assert.equal(b.calls, 0);
});

test('failover: a definitive chain error is rethrown as is, without trying another endpoint', async () => {
  const stale = typed(InvalidNonceError, 'nonce is stale');
  const a = fake('a', () => stale);
  const b = fake('b', () => 'from-b');
  const rpc = failover([a, b]);
  await assert.rejects(rpc.view('tx'), (err) => err === stale && err instanceof InvalidNonceError);
  assert.equal(b.calls, 0);
});

test('failover: when every endpoint is unavailable the last error surfaces', async () => {
  const a = fake('a', () => httpError(429, 'a limited'));
  const b = fake('b', () => httpError(503, 'b down'));
  const rpc = failover([a, b]);
  await assert.rejects(rpc.view('x'), /b down/);
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 1);
});

test('failover: the primary is tried again after the retry interval, and kept if it recovered', async () => {
  let clock = 0;
  let primaryDown = true;
  const a = fake('a', () => (primaryDown ? httpError(429) : 'from-a'));
  const b = fake('b', () => 'from-b');
  const rpc = failover([a, b], { retryPrimaryAfterMs: 1000, now: () => clock });

  assert.equal(await rpc.view('1'), 'from-b');
  clock = 500;
  assert.equal(await rpc.view('2'), 'from-b');
  assert.equal(a.calls, 1, 'inside the interval the primary is left alone');

  // Interval over, primary still down: one probe, then back on the fallback for a full interval.
  clock = 1200;
  assert.equal(await rpc.view('3'), 'from-b');
  assert.equal(a.calls, 2);
  clock = 1900;
  assert.equal(await rpc.view('4'), 'from-b');
  assert.equal(a.calls, 2, 'a failed probe restarts the interval');

  // Primary recovered: the next probe succeeds and it becomes active again.
  primaryDown = false;
  clock = 2300;
  assert.equal(await rpc.view('5'), 'from-a');
  assert.equal(await rpc.view('6'), 'from-a');
  assert.equal(b.calls, 4);
});

test('rpcHost: logs and public error messages carry the host only, never a key in the path or query', () => {
  assert.equal(rpcHost('https://rpc.testnet.fastnear.com?apiKey=SECRET'), 'rpc.testnet.fastnear.com');
  assert.equal(rpcHost('https://lb.example.org/near/SECRETKEY'), 'lb.example.org');
  assert.equal(rpcHost('not a url'), 'invalid-rpc-url');
});

function cfgFile(extra: Record<string, unknown>): string {
  const agentAccounts: Record<string, string> = {};
  for (const a of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) agentAccounts[a] = `${a}.x.testnet`;
  const file = path.join(tmpdir(), `hivecast-rpc-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({
    networkId: 'testnet', contractId: 'c.testnet', operatorId: 'o.testnet', resolverId: 'o.testnet',
    rpcUrl: 'https://primary.invalid', credentialDirectory: '/x', databasePath: ':memory:', agentAccounts, ...extra,
  }));
  return file;
}

test('config: rpcFallbackUrls is optional and validated', () => {
  const none = cfgFile({});
  assert.deepEqual(loadConfig(none).rpcFallbackUrls, []);
  rmSync(none);

  const two = cfgFile({ rpcFallbackUrls: ['https://b.invalid', 'https://c.invalid'] });
  assert.deepEqual(loadConfig(two).rpcFallbackUrls, ['https://b.invalid', 'https://c.invalid']);
  rmSync(two);

  const notArray = cfgFile({ rpcFallbackUrls: 'https://b.invalid' });
  assert.throws(() => loadConfig(notArray), /must be an array/);
  rmSync(notArray);

  const notUrl = cfgFile({ rpcFallbackUrls: ['ftp://b.invalid'] });
  assert.throws(() => loadConfig(notUrl), /http\(s\) URL/);
  rmSync(notUrl);

  const repeatsPrimary = cfgFile({ rpcFallbackUrls: ['https://primary.invalid'] });
  assert.throws(() => loadConfig(repeatsPrimary), /repeats/);
  rmSync(repeatsPrimary);
});
