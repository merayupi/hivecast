/**
 * llm-news unit tests: feed parsing, point-in-time headline selection, strict
 * reply parsing, the end-to-end forecast with a fake fetch (no network, no
 * key), and config validation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import type { Candle } from '@hivecast/core';

import { parseFeed, selectHeadlines, parseLlmReply, forecastWithLlm, buildUserPrompt } from '../src/llm.js';
import type { FetchLike } from '../src/llm.js';
import { loadConfig } from '../src/config.js';
import type { LlmConfig } from '../src/config.js';

const NOW = Date.parse('2026-11-10T09:55:00Z');

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[NEAR rallies 5% as AI tokens bid]]></title><pubDate>Tue, 10 Nov 2026 09:30:00 GMT</pubDate></item>
<item><title>Bitcoin &amp; ETH flat ahead of CPI</title><pubDate>Tue, 10 Nov 2026 08:00:00 GMT</pubDate></item>
<item><title>Future story leaked</title><pubDate>Tue, 10 Nov 2026 10:30:00 GMT</pubDate></item>
<item><title>Old news</title><pubDate>Sun, 08 Nov 2026 08:00:00 GMT</pubDate></item>
<item><title>No date here</title></item>
</channel></rss>`;

const ATOM = `<feed><entry><title type="html">NEAR rallies 5% as AI tokens bid</title><published>2026-11-10T09:31:00Z</published></entry>
<entry><title>Solana outage resolved</title><updated>2026-11-10T07:00:00Z</updated></entry></feed>`;

function candles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: String(NOW - (n - i) * 3_600_000),
    open: (2 + i * 0.01).toFixed(4),
    high: '0',
    low: '0',
    close: (2 + i * 0.01 + 0.005).toFixed(4),
    closeTime: String(NOW - (n - i - 1) * 3_600_000 - 1),
    volume: '0',
    quoteVolume: '0',
    trades: '0',
    takerBaseVolume: '0',
    takerQuoteVolume: '0',
  }));
}

const CFG: LlmConfig = {
  baseUrl: 'https://llm.invalid/v1',
  apiKey: 'test-key',
  model: 'test/model',
  providerLabel: 'test',
  maxTokens: 500,
  timeoutMs: 5_000,
  maxAttempts: 3,
  newsFeeds: ['https://feed-a.invalid/rss', 'https://feed-b.invalid/atom', 'https://feed-down.invalid/rss'],
  maxHeadlines: 10,
  headlineWindowHours: 12,
};

function fakeFetch(chat: (body: Record<string, unknown>) => Response): { fn: FetchLike; calls: string[]; bodies: Record<string, unknown>[] } {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push(url);
    if (url.includes('feed-a')) return new Response(RSS, { status: 200 });
    if (url.includes('feed-b')) return new Response(ATOM, { status: 200 });
    if (url.includes('feed-down')) return new Response('nope', { status: 503 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return chat(body);
  };
  return { fn, calls, bodies };
}

const chatOk = (content: string | null, finish = 'stop') =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finish }],
      usage: { prompt_tokens: 420, completion_tokens: 180 },
    }),
    { status: 200 },
  );

test('parseFeed reads RSS and Atom, decodes entities/CDATA, drops undated items', () => {
  const rss = parseFeed(RSS, 'a');
  assert.deepEqual(rss.map((h) => h.title), [
    'NEAR rallies 5% as AI tokens bid',
    'Bitcoin & ETH flat ahead of CPI',
    'Future story leaked',
    'Old news',
  ]);
  const atom = parseFeed(ATOM, 'b');
  assert.equal(atom.length, 2);
  assert.equal(atom[1]!.publishedAtMs, Date.parse('2026-11-10T07:00:00Z'));
});

test('selectHeadlines is point-in-time: no future items, window-bounded, de-duplicated, newest first', () => {
  const all = [...parseFeed(RSS, 'a'), ...parseFeed(ATOM, 'b')];
  const picked = selectHeadlines(all, NOW, 12, 10);
  const titles = picked.map((h) => h.title);
  assert.ok(!titles.includes('Future story leaked'), 'published after now is excluded');
  assert.ok(!titles.includes('Old news'), 'outside the 12h window is excluded');
  assert.equal(titles.filter((t) => t.startsWith('NEAR rallies')).length, 1, 'duplicate title kept once');
  for (let i = 1; i < picked.length; i++) assert.ok(picked[i - 1]!.publishedAtMs >= picked[i]!.publishedAtMs);
});

test('parseLlmReply accepts fenced JSON and converts percent to bps', () => {
  assert.deepEqual(parseLlmReply('```json\n{"probability": 57, "rationale": "Mild momentum."}\n```'), {
    probabilityBps: 5700,
    rationale: 'Mild momentum.',
  });
  assert.deepEqual(parseLlmReply('{"probability": "42.5", "rationale": "x"}'), { probabilityBps: 4250, rationale: 'x' });
});

test('parseLlmReply rejects empty, non-JSON, out-of-range, and missing rationale', () => {
  assert.deepEqual(parseLlmReply(null), { error: 'empty-reply' });
  assert.deepEqual(parseLlmReply('I think it goes up'), { error: 'no-json' });
  assert.deepEqual(parseLlmReply('{"probability": 140, "rationale": "x"}'), { error: 'probability-out-of-range' });
  assert.deepEqual(parseLlmReply('{"probability": -1, "rationale": "x"}'), { error: 'probability-out-of-range' });
  assert.deepEqual(parseLlmReply('{"probability": 60}'), { error: 'missing-rationale' });
  assert.deepEqual(parseLlmReply('{"probability": 60, rationale: }'), { error: 'invalid-json' });
});

test('forecastWithLlm: success records model, headlines, usage and a prompt hash; a failing feed is skipped', async () => {
  const f = fakeFetch(() => chatOk('{"probability": 55, "rationale": "Headlines lean positive but hourly moves are noisy."}'));
  const r = await forecastWithLlm(f.fn, CFG, 'Will NEARUSDT close higher?', candles(30), NOW);
  assert.equal(r.kind, 'forecast');
  assert.equal(r.kind === 'forecast' && r.probabilityBps, 5500);
  assert.equal(r.record.model, 'test/model');
  assert.match(r.record.promptSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.record.usage, { promptTokens: 420, completionTokens: 180 });
  assert.ok(r.record.headlines.length >= 2);
  const body = f.bodies[0]!;
  assert.equal(body.model, 'test/model');
  assert.equal(body.max_tokens, 500);
  const user = (body.messages as Array<{ role: string; content: string }>)[1]!.content;
  assert.ok(!user.includes('Future story leaked'), 'prompt never contains post-cutoff news');
  assert.ok(user.includes('Last 24 completed NEARUSDT 1h candles'));
});

test('forecastWithLlm: content null at max_tokens is an abstention, not a number', async () => {
  const f = fakeFetch(() => chatOk(null, 'length'));
  const r = await forecastWithLlm(f.fn, CFG, 'Q', candles(5), NOW);
  assert.equal(r.kind, 'abstain');
  assert.equal(r.kind === 'abstain' && r.reason, 'llm-empty-reply');
  assert.match(r.record.error ?? '', /max_tokens/);
  assert.equal(r.record.probabilityBps, null);
});

test('forecastWithLlm: provider error is an abstention and the error never contains the key', async () => {
  const f = fakeFetch(() => new Response('{"error":"overloaded"}', { status: 503 }));
  const r = await forecastWithLlm(f.fn, CFG, 'Q', candles(5), NOW);
  assert.equal(r.kind, 'abstain');
  assert.equal(r.kind === 'abstain' && r.reason, 'llm-unavailable');
  assert.match(r.record.error ?? '', /503/);
  assert.ok(!(r.record.error ?? '').includes('test-key'));
});

test('buildUserPrompt handles no candles and no headlines', () => {
  const p = buildUserPrompt('Q?', [], [], NOW);
  assert.match(p, /No recent candles available/);
  assert.match(p, /No headlines available/);
});

function writeConfig(extra: Record<string, unknown>): string {
  const agentAccounts: Record<string, string> = {};
  for (const a of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) {
    agentAccounts[a] = `${a}.x.testnet`;
  }
  const file = path.join(tmpdir(), `hivecast-llm-cfg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      networkId: 'testnet',
      contractId: 'c.testnet',
      operatorId: 'o.testnet',
      resolverId: 'o.testnet',
      rpcUrl: 'https://unused.invalid',
      credentialDirectory: '/nonexistent',
      databasePath: ':memory:',
      agentAccounts,
      ...extra,
    }),
  );
  return file;
}

test('config: llm is optional; when set it needs the llm-news account and a key from env', () => {
  const plain = writeConfig({});
  assert.equal(loadConfig(plain).llm, null);
  rmSync(plain);

  const noAccount = writeConfig({ llm: { model: 'm' } });
  assert.throws(() => loadConfig(noAccount), /llm-news/);
  rmSync(noAccount);

  const agentAccounts: Record<string, string> = {};
  for (const a of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip', 'llm-news']) {
    agentAccounts[a] = `${a}.x.testnet`;
  }
  const withEnv = writeConfig({ agentAccounts, llm: { apiKeyEnv: 'HIVECAST_TEST_LLM_KEY' } });
  delete process.env.HIVECAST_TEST_LLM_KEY;
  assert.throws(() => loadConfig(withEnv), /HIVECAST_TEST_LLM_KEY/);
  process.env.HIVECAST_TEST_LLM_KEY = 'from-env';
  const cfg = loadConfig(withEnv);
  assert.equal(cfg.llm?.apiKey, 'from-env');
  assert.equal(cfg.llm?.baseUrl, 'https://cloud-api.near.ai/v1');
  assert.equal(cfg.llm?.model, 'deepseek-ai/DeepSeek-V4.1-Flash-1017');
  assert.equal(cfg.agentAccounts['llm-news'], 'llm-news.x.testnet');
  delete process.env.HIVECAST_TEST_LLM_KEY;
  rmSync(withEnv);
});

test('rationale stays private until the on-chain Reveal, then matches the revealed probability', async () => {
  const { Store } = await import('../src/store.js');
  const { Runtime } = await import('../src/runtime.js');
  const store = new Store(':memory:');
  store.saveLlmRun({
    questionId: 7,
    accountId: 'llm-news.x.testnet',
    model: 'test/model',
    promptSha256: 'a'.repeat(64),
    headlines: [{ title: 'NEAR rallies', source: 'coindesk.com', publishedAtMs: NOW - 60_000 }],
    probBps: 5500,
    rationale: 'Lean up.',
    promptTokens: 400,
    completionTokens: 120,
    error: null,
    createdAtMs: NOW,
  });
  let revealed: number | null = null;
  const chain = {
    contractId: 'c.testnet',
    nowNs: () => BigInt(NOW) * 1_000_000n,
    getCommitment: async () => ({ question_id: 7, account_id: 'llm-news.x.testnet', stake: '1', hash: 'h', revealed }),
  };
  const agentAccounts: Record<string, string> = { 'llm-news': 'llm-news.x.testnet' };
  for (const a of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) agentAccounts[a] = `${a}.x.testnet`;
  const config = { networkId: 'testnet', contractId: 'c.testnet', agentAccounts, llm: CFG, access: { sessionTtlMs: 1, challengeTtlMs: 1, cookieName: 'c', cookieSecure: false, serviceDomain: 'd', allowedOrigins: [] } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runtime = new Runtime(config as any, chain as any, store, {} as any);

  assert.deepEqual(await runtime.getLlmRationale(7), { status: 'not_revealed' });
  revealed = 5500;
  const r = await runtime.getLlmRationale(7);
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') {
    assert.equal(r.rationale.revealed_prob_bps, 5500);
    assert.equal(r.rationale.matches_reveal, true);
    assert.equal(r.rationale.rationale, 'Lean up.');
    assert.equal(r.rationale.headlines[0]!.source, 'coindesk.com');
    assert.ok(!JSON.stringify(r.rationale).includes('test-key'), 'never serves the API key');
  }
  assert.equal(runtime.getAgentRoster().find((a) => a.agentId === 'llm-news')?.liveOnly, true);
  store.close();
});
