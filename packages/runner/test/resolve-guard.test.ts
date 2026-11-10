/**
 * A Round is not resolved before its observation is over: the runner neither
 * asks the outcome source nor signs a resolve while `now < resolve_time`.
 * In-memory fakes: no chain, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Runner } from '../src/runner.js';
import type { SourceProvider } from '../src/runner.js';
import { Store } from '../src/store.js';
import type { ChainClient } from '../src/chain/types.js';
import type { RunnerConfig } from '../src/config.js';
import type { LocalQuestion } from '../src/types.js';
import { DEFAULT_WEATHER_CITIES, computeWeatherSchedule, sourceDefinition, zonedMidnightUtc, nextDate, nsToMs } from '../src/schedule.js';

const OPERATOR = 'op.testnet';
const tokyo = DEFAULT_WEATHER_CITIES.find((c) => c.id === 'tokyo')!;
const start = zonedMidnightUtc('2026-11-11', tokyo.timezone);
const schedule = computeWeatherSchedule(start, zonedMidnightUtc(nextDate('2026-11-11'), tokyo.timezone));

const question: LocalQuestion = {
  questionId: 11,
  domain: 'weather',
  text: 'Will Tokyo (Japan) receive at least 1.0 mm of rain on 2026-11-11?',
  eventDefinition: 'fixture',
  sourceJson: sourceDefinition('weather', '2026-11-11', tokyo).json,
  sourceLabel: 'fixture',
  resolver: OPERATOR,
  ...schedule,
  accessPrice: 10n ** 22n,
  minStake: 10n ** 23n,
  participants: [{ agentId: 'meteo', accountId: 'meteo.op.testnet' }],
};

const config = { contractId: 'c.testnet', operatorId: OPERATOR, resolverId: OPERATOR, minStakeYocto: 10n ** 23n } as unknown as RunnerConfig;

/** A closed Round with one commitment and a published snapshot; any other chain call fails the test. */
function fakeChain(nowNs: () => bigint): { chain: ChainClient; calls: string[] } {
  const calls: string[] = [];
  const known: Record<string, (...args: unknown[]) => unknown> = {
    nowNs,
    getQuestion: async () => ({ phase: 'closed', snapshot_ready: true, outcome: null, reveal_deadline: null }),
    listCommitments: async () => [{ account_id: 'meteo.op.testnet', stake: '1', hash: 'h', revealed: null }],
  };
  const chain = new Proxy({ contractId: 'c.testnet' } as object, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      return (...args: unknown[]) => {
        calls.push(prop);
        const fn = known[prop];
        if (!fn) throw new Error(`unexpected chain call: ${prop}`);
        return fn(...args);
      };
    },
  }) as ChainClient;
  return { chain, calls };
}

function fakeSource(onResolve: () => never): { source: SourceProvider; asked: () => number } {
  let asked = 0;
  return {
    asked: () => asked,
    source: {
      strategyInputs: async () => {
        throw new Error('not used');
      },
      resolveOutcome: async () => {
        asked += 1;
        return onResolve();
      },
    },
  };
}

test('resolve: during the observed day the source is not asked and nothing is signed', async () => {
  // 02:00 UTC on the observed day: Tokyo's day is 11 hours in, 13 hours from over.
  const now = BigInt(Date.parse('2026-11-11T02:00:00Z')) * 1_000_000n;
  assert.ok(now > question.observationStartNs && now < question.resolveTimeNs);
  const { chain, calls } = fakeChain(() => now);
  const { source, asked } = fakeSource(() => {
    throw new Error('the outcome source must not be asked before the observation ends');
  });
  const store = new Store(':memory:', 'testnet', 'c.testnet');
  const steps = await new Runner(config, chain, store, source).advance(question);
  store.close();

  assert.deepEqual(steps, [
    { kind: 'resolve', questionId: 11, accountId: null, sent: false, reason: 'observation-not-ended', error: null },
  ]);
  assert.equal(asked(), 0);
  assert.deepEqual(calls.filter((c) => c !== 'nowNs').sort(), ['getQuestion', 'listCommitments'], 'no prepare, no broadcast');
});

test('resolve: once the observation is over the source is asked again', async () => {
  const now = question.resolveTimeNs; // the first instant the contract accepts a resolve
  const { chain } = fakeChain(() => now);
  const { source, asked } = fakeSource(() => {
    throw new Error('archive has no value for 2026-11-11 yet');
  });
  const store = new Store(':memory:', 'testnet', 'c.testnet');
  const steps = await new Runner(config, chain, store, source).advance(question);
  store.close();

  assert.equal(asked(), 1);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.reason, 'outcome-unavailable');
  assert.match(steps[0]!.error ?? '', /no value for 2026-11-11/);
  assert.equal(new Date(nsToMs(now)).toISOString(), '2026-11-11T15:00:00.000Z', 'Tokyo local midnight ending the observed day');
});
