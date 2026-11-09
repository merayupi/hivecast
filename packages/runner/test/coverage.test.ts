/**
 * Public read coverage: 'complete' once the question history is caught up and
 * the live set was walked within the live TTL -- not only on the request that
 * happened to do the walk (the dashboard polls leaderboard + economics
 * together, which made every second report 'partial' and hid bankroll).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store.js';
import { PublicChainCache } from '../src/public-cache.js';
import type { QuestionView } from '../src/types.js';

function q(id: number, phase: QuestionView['phase']): QuestionView {
  return {
    question_id: id, text: '', event_definition: '', source: '{"kind":"price"}', resolver: 'o',
    open_time: '1', close_time: '2', observation_start: '3', observation_end: '4', resolve_time: '4',
    resolve_deadline: '5', reveal_window: '1', access_price: '1', min_stake: '1', phase,
    outcome: phase === 'settled' ? true : null, resolved_at: null, reveal_deadline: null,
    snapshot_ready: false, snapshot_id: null, total_stake: '0', fee_pool: '0', participant_count: 0, buyer_count: 0,
  } as QuestionView;
}

function chainWith(questions: QuestionView[]) {
  let walks = 0;
  const chain = {
    getContractState: async () => ({ question_count: questions.length }),
    listQuestions: async (from: number, limit: number) => questions.slice(from, from + limit),
    getQuestion: async (id: number) => {
      walks += 1;
      return questions.find((x) => x.question_id === id) ?? null;
    },
    listCommitments: async () => [],
  };
  return { chain, walks: () => walks };
}

test('coverage stays complete for back-to-back reports served from the live cache', async () => {
  const store = new Store(':memory:');
  const { chain, walks } = chainWith([q(0, 'settled'), q(1, 'open')]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = new PublicChainCache(chain as any, store);
  await cache.listAllQuestions();
  assert.equal(cache.getCoverageInfo().complete, true, 'first report walks the live set');
  const before = walks();
  await cache.listAllQuestions();
  assert.equal(walks(), before, 'second report is served from the live cache (no extra RPC)');
  assert.equal(cache.getCoverageInfo().complete, true, 'and is still complete');
  store.close();
});

test('coverage is partial while the history is still bootstrapping or the live set is older than the TTL', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const store = new Store(':memory:');
  const many = Array.from({ length: 25 }, (_, i) => q(i, i === 24 ? 'open' : 'settled'));
  const { chain } = chainWith(many);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = new PublicChainCache(chain as any, store);
  assert.equal(cache.getCoverageInfo().complete, false, 'never walked');
  await cache.listAllQuestions();
  assert.equal(cache.getCoverageInfo().complete, false, 'only 20 of 25 questions fetched');
  await cache.listAllQuestions();
  assert.equal(cache.getCoverageInfo().fetchedQuestions, 25);
  assert.equal(cache.getCoverageInfo().complete, true);
  t.mock.timers.tick(16_000);
  assert.equal(cache.getCoverageInfo().complete, false, 'a live set older than 15 s is not complete');
  store.close();
});
