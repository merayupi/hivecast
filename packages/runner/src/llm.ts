/**
 * llm-news: the live-only LLM agent.
 *
 * One forecast = (1) read crypto headlines published before the call from
 * public RSS feeds, (2) summarise the last 24 completed NEARUSDT 1h candles,
 * (3) ask an OpenAI-compatible chat endpoint (NEAR AI Cloud by default, private
 * TEE inference) for a probability and a short rationale, (4) validate it
 * strictly. Anything invalid or late is an abstention, never a guessed number.
 *
 * Everything here is pure or takes `fetch` as a dependency, so it is unit
 * tested without the network. The runner persists the full record privately
 * BEFORE committing; the rationale becomes public only after the agent's
 * on-chain Reveal (see Runtime.getLlmRationale).
 */

import { createHash } from 'node:crypto';
import type { Candle } from '@hivecast/core';
import type { LlmConfig } from './config.js';

export interface Headline {
  title: string;
  source: string;
  publishedAtMs: number;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmForecastRecord {
  model: string;
  promptSha256: string;
  headlines: Headline[];
  probabilityBps: number | null;
  rationale: string | null;
  usage: LlmUsage | null;
  error: string | null;
}

export type LlmForecastResult =
  | { kind: 'forecast'; probabilityBps: number; record: LlmForecastRecord }
  | { kind: 'abstain'; reason: string; record: LlmForecastRecord };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// RSS / Atom
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeText(raw: string): string {
  let s = raw.trim();
  const cdata = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) s = cdata[1]!;
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s.replace(/\s+/g, ' ').trim();
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1]! : null;
}

/** Parse RSS 2.0 `<item>` or Atom `<entry>` elements. Items without a parseable date are dropped. */
export function parseFeed(xml: string, source: string): Headline[] {
  const out: Headline[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    const date = tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date');
    if (!title || !date) continue;
    const ms = Date.parse(decodeText(date));
    const text = decodeText(title);
    if (!Number.isFinite(ms) || text === '') continue;
    out.push({ title: text.slice(0, 240), source, publishedAtMs: ms });
  }
  return out;
}

/**
 * Point-in-time selection: published strictly before `nowMs`, within the
 * window, de-duplicated by title, newest first.
 */
export function selectHeadlines(items: Headline[], nowMs: number, windowHours: number, max: number): Headline[] {
  const from = nowMs - windowHours * 3_600_000;
  const seen = new Set<string>();
  return items
    .filter((h) => h.publishedAtMs < nowMs && h.publishedAtMs >= from)
    .sort((a, b) => b.publishedAtMs - a.publishedAtMs)
    .filter((h) => {
      const k = h.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, max);
}

function feedSource(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Fetch every feed; a failing feed is skipped, not fatal. */
export async function fetchHeadlines(
  fetchFn: FetchLike,
  feeds: string[],
  nowMs: number,
  windowHours: number,
  max: number,
  timeoutMs = 15_000,
): Promise<{ headlines: Headline[]; failedFeeds: string[] }> {
  const all: Headline[] = [];
  const failedFeeds: string[] = [];
  await Promise.all(
    feeds.map(async (url) => {
      try {
        const res = await fetchFn(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        all.push(...parseFeed(await res.text(), feedSource(url)));
      } catch {
        failedFeeds.push(url);
      }
    }),
  );
  return { headlines: selectHeadlines(all, nowMs, windowHours, max), failedFeeds };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = [
  'You are a careful, calibrated forecaster in a forecasting market.',
  'You are scored with the Brier score and you stake money on every forecast, so overconfidence is expensive.',
  'Hourly crypto price moves are close to random: stay near 50% unless the evidence is genuinely strong.',
  'Reply with ONE JSON object and nothing else:',
  '{"probability": <integer 0-100, chance the answer is YES>, "rationale": "<at most 60 words>"}',
].join('\n');

function pctChange(from: string, to: string): string {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return 'n/a';
  const p = ((b - a) / a) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}

export function buildUserPrompt(question: string, candles: Candle[], headlines: Headline[], nowMs: number): string {
  const recent = candles.slice(-24);
  const lines: string[] = [];
  lines.push(`Question: ${question}`);
  lines.push(`Current time (UTC): ${new Date(nowMs).toISOString().slice(0, 16)}`);
  lines.push('');
  if (recent.length > 0) {
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    const ups = recent.filter((c) => Number(c.close) > Number(c.open)).length;
    lines.push(`Last ${recent.length} completed NEARUSDT 1h candles (Binance):`);
    lines.push(`- close moved ${pctChange(first.open, last.close)} over the window; ${ups}/${recent.length} candles closed up`);
    lines.push(`- last candle: open ${last.open}, close ${last.close} (${pctChange(last.open, last.close)})`);
    lines.push(`- closes oldest→newest: ${recent.map((c) => c.close).join(', ')}`);
  } else {
    lines.push('No recent candles available.');
  }
  lines.push('');
  if (headlines.length > 0) {
    lines.push('Crypto headlines published before now (newest first):');
    for (const h of headlines) {
      lines.push(`- [${new Date(h.publishedAtMs).toISOString().slice(0, 16)} ${h.source}] ${h.title}`);
    }
  } else {
    lines.push('No headlines available in the window.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Accepts the first JSON object in the reply (tolerates code fences and stray
 * prose). `probability` must be an integer 0..100 (percent); it is converted to
 * bps. Anything else is rejected with a reason.
 */
export function parseLlmReply(content: string | null): { probabilityBps: number; rationale: string } | { error: string } {
  if (!content || content.trim() === '') return { error: 'empty-reply' };
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: 'no-json' };
  let obj: unknown;
  try {
    obj = JSON.parse(content.slice(start, end + 1));
  } catch {
    return { error: 'invalid-json' };
  }
  if (typeof obj !== 'object' || obj === null) return { error: 'invalid-json' };
  const o = obj as Record<string, unknown>;
  const p = typeof o.probability === 'string' ? Number(o.probability) : o.probability;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) return { error: 'probability-out-of-range' };
  const rationale = typeof o.rationale === 'string' ? o.rationale.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
  if (rationale === '') return { error: 'missing-rationale' };
  return { probabilityBps: Math.round(p * 100), rationale };
}

// ---------------------------------------------------------------------------
// Chat call
// ---------------------------------------------------------------------------

export async function callChat(
  fetchFn: FetchLike,
  cfg: Pick<LlmConfig, 'baseUrl' | 'apiKey' | 'model' | 'maxTokens' | 'timeoutMs'>,
  system: string,
  user: string,
): Promise<{ content: string | null; usage: LlmUsage | null; finishReason: string | null }> {
  const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    // Never echo the request (it carries the key); only status + provider message.
    const body = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? null,
    finishReason: choice?.finish_reason ?? null,
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 }
      : null,
  };
}

/** End-to-end forecast for one price Round. Never throws: failures are abstentions with a recorded error. */
export async function forecastWithLlm(
  fetchFn: FetchLike,
  cfg: LlmConfig,
  question: string,
  candles: Candle[],
  nowMs: number,
): Promise<LlmForecastResult> {
  const { headlines } = await fetchHeadlines(fetchFn, cfg.newsFeeds, nowMs, cfg.headlineWindowHours, cfg.maxHeadlines);
  const user = buildUserPrompt(question, candles, headlines, nowMs);
  const promptSha256 = createHash('sha256').update(`${SYSTEM_PROMPT}\n---\n${user}`).digest('hex');
  const record: LlmForecastRecord = {
    model: cfg.model,
    promptSha256,
    headlines,
    probabilityBps: null,
    rationale: null,
    usage: null,
    error: null,
  };
  try {
    const reply = await callChat(fetchFn, cfg, SYSTEM_PROMPT, user);
    record.usage = reply.usage;
    const parsed = parseLlmReply(reply.content);
    if ('error' in parsed) {
      record.error = reply.finishReason === 'length' ? `${parsed.error} (hit max_tokens)` : parsed.error;
      return { kind: 'abstain', reason: `llm-${parsed.error}`, record };
    }
    record.probabilityBps = parsed.probabilityBps;
    record.rationale = parsed.rationale;
    return { kind: 'forecast', probabilityBps: parsed.probabilityBps, record };
  } catch (err) {
    record.error = (err as Error).message.slice(0, 300);
    return { kind: 'abstain', reason: 'llm-unavailable', record };
  }
}
