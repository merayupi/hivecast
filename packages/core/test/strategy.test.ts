import test from 'node:test';
import assert from 'node:assert/strict';
import { getStrategy } from '../src/strategy.js';
import { supportsDomain, AGENT_IDS, STRATEGY_DOMAINS } from '../src/types.js';
import { isValidProbabilityBps } from '../src/types.js';
import type { StrategyContext, AgentId } from '../src/types.js';

function priceCtx(overrides: Record<string, unknown> = {}): StrategyContext {
  return {
    agentId: 'coinflip',
    domain: 'price',
    targetTime: '2026-08-01T00:00:00Z',
    roundKey: 'r',
    seed: 42,
    inputs: {
      kind: 'price',
      candles: Array.from({ length: 30 }, (_, i) => ({
        openTime: `${i}`,
        open: '2.30',
        high: '2.35',
        low: '2.25',
        close: '2.32',
        closeTime: `${i}`,
        volume: '1',
        quoteVolume: '1',
        trades: '1',
        takerBaseVolume: '1',
        takerQuoteVolume: '1',
      })),
    },
    ...overrides,
  } as StrategyContext;
}

function weatherCtx(overrides: Record<string, unknown> = {}): StrategyContext {
  return {
    agentId: 'coinflip',
    domain: 'weather',
    targetTime: '2026-08-01',
    roundKey: 'r',
    seed: 42,
    inputs: {
      kind: 'weather',
      forecastPrecipMm: '2.0',
      historyPrecipMm: ['0.0', '0.5', '1.2', '0.0'],
    },
    ...overrides,
  } as StrategyContext;
}

function forecastBps(agentId: AgentId, ctx: StrategyContext): number {
  const res = getStrategy(agentId)(ctx);
  if (res.kind === 'abstain') throw new Error(`expected forecast, got abstain: ${res.reason}`);
  return res.probabilityBps;
}

test('domain relevance: six strategies per domain, specialists abstain', () => {
  const price = AGENT_IDS.filter((a) => supportsDomain(a, 'price')).sort();
  const weather = AGENT_IDS.filter((a) => supportsDomain(a, 'weather')).sort();
  assert.deepEqual(price, ['coinflip', 'meanrev', 'momentum', 'noisy-trend', 'persistence', 'yolo']);
  assert.deepEqual(weather, ['climatology', 'coinflip', 'meteo', 'noisy-trend', 'persistence', 'yolo']);
  assert.equal(STRATEGY_DOMAINS.meteo.includes('price'), false);
});

test('meteo abstains on the price domain (unsupported specialist)', () => {
  const ctx = { ...priceCtx({ agentId: 'meteo' }), agentId: 'meteo' } as StrategyContext;
  const res = getStrategy('meteo')(ctx);
  assert.equal(res.kind, 'abstain');
});

test('coinflip and yolo are deterministic for the same seed', () => {
  const a = forecastBps('coinflip', priceCtx());
  const b = forecastBps('coinflip', priceCtx());
  assert.equal(a, b);
  const y = getStrategy('yolo')(priceCtx());
  assert.equal(y.kind, 'forecast');
  if (y.kind === 'forecast') {
    assert.ok([0, 10_000].includes(y.probabilityBps));
  }
});

test('meteo abstains without forecast run, uses logistic otherwise', () => {
  const absent = getStrategy(
    'meteo',
  )(weatherCtx({ inputs: { kind: 'weather', forecastPrecipMm: null, historyPrecipMm: [] } }));
  assert.equal(absent.kind, 'abstain');
  const p = forecastBps('meteo', weatherCtx());
  assert.ok(isValidProbabilityBps(p));
  // 2.0 mm > 1.0 threshold => P(rain) > 50%
  assert.ok(p > 5000);
});

test('climatology computes frequency from history, abstains on empty', () => {
  const empty = getStrategy(
    'climatology',
  )(weatherCtx({ inputs: { kind: 'weather', forecastPrecipMm: null, historyPrecipMm: [] } }));
  assert.equal(empty.kind, 'abstain');
  // history: 0.0, 0.5, 1.2, 0.0 -> 1 of 4 >= 1.0 -> 25%
  assert.equal(forecastBps('climatology', weatherCtx()), 2500);
});

test('momentum abstains on short history, otherwise fixed-sign probability', () => {
  const short = getStrategy('momentum')(priceCtx({ inputs: { kind: 'price', candles: [] } }));
  assert.equal(short.kind, 'abstain');
  const p = forecastBps('momentum', priceCtx());
  assert.ok([7500, 2500, 5000].includes(p));
});
