/**
 * api.allQuestions pages through every Question: a single first page stops
 * showing new Rounds once the contract has more than 100.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { api } from '../src/lib/api';

function stubQuestions(total: number) {
  const calls: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = g.fetch;
  g.fetch = async (url: string) => {
    calls.push(url);
    const u = new URL(url, 'http://x');
    const from = Number(u.searchParams.get('from_index'));
    const limit = Number(u.searchParams.get('limit'));
    const questions = Array.from({ length: Math.max(0, Math.min(limit, total - from)) }, (_, i) => ({ question_id: from + i }));
    return new Response(JSON.stringify({ questions }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => (g.fetch = saved) };
}

test('allQuestions returns every Question across pages, including the newest', async () => {
  const s = stubQuestions(250);
  try {
    const all = await api.allQuestions();
    assert.equal(all.length, 250);
    assert.equal(all[all.length - 1]!.question_id, 249);
    assert.equal(s.calls.length, 3);
  } finally {
    s.restore();
  }
});

test('allQuestions stops after a short page (exactly 100 → one extra empty read)', async () => {
  const s = stubQuestions(100);
  try {
    assert.equal((await api.allQuestions()).length, 100);
    assert.equal(s.calls.length, 2);
  } finally {
    s.restore();
  }
});
