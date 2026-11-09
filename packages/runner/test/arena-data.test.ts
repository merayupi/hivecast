/**
 * Arena data seams: the public `/activity` feed (runner-signed finalized
 * transactions with on-chain block time) and per-Round payouts in the
 * Question comparison (exact core `settle`, labelled `computed: true`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { Store } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { createPublicService } from '../src/service.js';
import { computeQuestionComparison } from '../src/public-data.js';
import { ChainUnavailableError } from '../src/chain/index.js';
import type { CommitmentView, QuestionView } from '../src/types.js';

const NEAR = 10n ** 24n;
const SALT = 'f'.repeat(64);

function question(over: Partial<QuestionView>): QuestionView {
  return {
    question_id: 1,
    text: 'Will NEAR/USDT close above its open?',
    event_definition: 'close > open',
    source: '{"kind":"price"}',
    resolver: 'o.testnet',
    open_time: '1',
    close_time: '2',
    observation_start: '3',
    observation_end: '4',
    resolve_time: '4',
    resolve_deadline: '5',
    reveal_window: '1',
    access_price: (NEAR / 100n).toString(),
    min_stake: (NEAR / 10n).toString(),
    phase: 'settled',
    outcome: true,
    resolved_at: '4',
    reveal_deadline: '5',
    snapshot_ready: true,
    snapshot_id: 'abc',
    total_stake: (2n * NEAR).toString(),
    fee_pool: (NEAR / 100n).toString(),
    participant_count: 2,
    buyer_count: 1,
    ...over,
  } as QuestionView;
}

function sourceFor(q: QuestionView, commitments: CommitmentView[]) {
  return {
    listAllQuestions: async () => [q],
    listAllCommitments: async () => commitments,
  } as unknown as Parameters<typeof computeQuestionComparison>[0];
}

const COMMITS: CommitmentView[] = [
  { question_id: 1, account_id: 'a.testnet', stake: NEAR.toString(), hash: '1'.repeat(64), revealed: 10_000 },
  { question_id: 1, account_id: 'b.testnet', stake: NEAR.toString(), hash: '2'.repeat(64), revealed: 0 },
];

test('comparison: settled Round carries exact per-participant payouts labelled computed', async () => {
  const c = await computeQuestionComparison(sourceFor(question({}), COMMITS), 1);
  assert.ok(c);
  assert.equal(c.payouts?.computed, true);
  // Hand-checked: W = 2 NEAR, s_a = S, s_b = 0, A = S·1NEAR.
  // base_a = 1·(2S + 2S − S)/(2S) = 1.5 NEAR; base_b = 0.5 NEAR.
  // Fee 0.01 NEAR split by stake among both valid revealers.
  const a = c.participants.find((p) => p.account_id === 'a.testnet')!;
  const b = c.participants.find((p) => p.account_id === 'b.testnet')!;
  assert.equal(a.base_payout, ((3n * NEAR) / 2n).toString());
  assert.equal(b.base_payout, (NEAR / 2n).toString());
  assert.equal(a.fee_payout, (NEAR / 200n).toString());
  assert.equal(b.fee_payout, (NEAR / 200n).toString());
  const sumBase = c.participants.reduce((s, p) => s + BigInt(p.base_payout!), 0n);
  assert.equal(sumBase, 2n * NEAR, 'Σ base = W exactly');
});

test('comparison: a non-revealer earns no fee share and its stake still counts', async () => {
  const commits = [COMMITS[0]!, { ...COMMITS[1]!, revealed: null }];
  const c = await computeQuestionComparison(sourceFor(question({}), commits), 1);
  const b = c!.participants.find((p) => p.account_id === 'b.testnet')!;
  assert.equal(b.fee_payout, '0');
  assert.equal(b.valid_revealer, false);
  const a = c!.participants.find((p) => p.account_id === 'a.testnet')!;
  assert.equal(a.fee_payout, (NEAR / 100n).toString());
});

test('comparison: payouts are null before settlement (resolved, cancelled, open)', async () => {
  for (const over of [
    { phase: 'resolved' as const },
    { phase: 'cancelled' as const, outcome: null },
    { phase: 'open' as const, outcome: null, resolved_at: null },
  ]) {
    const c = await computeQuestionComparison(sourceFor(question(over), COMMITS), 1);
    assert.equal(c!.payouts, null, over.phase);
    for (const p of c!.participants) {
      assert.equal(p.base_payout, null);
      assert.equal(p.fee_payout, null);
    }
  }
});

// ---------------------------------------------------------------------------
// /activity
// ---------------------------------------------------------------------------

function seedJournal(store: Store): void {
  const rows: [string, 'create_question' | 'commit' | 'reveal' | 'settle', number, string, string | null][] = [
    ['create:1', 'create_question', 1, 'o.testnet', 'tx-create'],
    ['commit:1:a', 'commit', 1, 'a.testnet', 'tx-commit-a'],
    ['commit:1:b', 'commit', 1, 'b.testnet', null], // never confirmed
    ['reveal:1:a', 'reveal', 1, 'a.testnet', 'tx-reveal-a'],
    ['settle:1', 'settle', 1, 'o.testnet', 'tx-settle'],
  ];
  for (const [key, kind, qid, account, tx] of rows) {
    store.upsertJournal({ dedupKey: key, kind, questionId: qid, accountId: account, payloadJson: JSON.stringify({ salt: SALT, probBps: 7300 }) });
    if (tx) store.markConfirmed(key, tx);
    else store.markSubmitted(key, 'tx-pending-b');
  }
}

function makeRuntime(store: Store, blockTime: (tx: string) => Promise<{ blockHash: string; timestampNs: string } | null>) {
  let calls = 0;
  const chain = {
    contractId: 'c.testnet',
    nowNs: () => 0n,
    viewTxBlockTime: async (tx: string) => {
      calls += 1;
      return blockTime(tx);
    },
  };
  const config = {
    networkId: 'testnet',
    contractId: 'c.testnet',
    agentAccounts: {},
    llm: null,
    access: { sessionTtlMs: 1, challengeTtlMs: 1, cookieName: 'c', cookieSecure: false, serviceDomain: 'd', allowedOrigins: [] },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runtime = new Runtime(config as any, chain as any, store, {} as any);
  return { runtime, calls: () => calls };
}

const TIMES: Record<string, string> = {
  'tx-create': '1762000000000000000',
  'tx-commit-a': '1762000060000000000',
  'tx-reveal-a': '1762003600000000000',
  'tx-settle': '1762004500000000000',
};

test('activity: confirmed runner txs only, newest first, mapped kinds, block time, no private data', async () => {
  const store = new Store(':memory:');
  seedJournal(store);
  const { runtime, calls } = makeRuntime(store, async (tx) => ({ blockHash: `b-${tx}`, timestampNs: TIMES[tx]! }));

  const page = await runtime.getActivity(null, 50);
  assert.deepEqual(
    page.items.map((i) => [i.kind, i.tx_hash, i.account_id, i.question_id, i.finalized_at]),
    [
      ['settle', 'tx-settle', 'o.testnet', 1, TIMES['tx-settle']],
      ['reveal', 'tx-reveal-a', 'a.testnet', 1, TIMES['tx-reveal-a']],
      ['commit', 'tx-commit-a', 'a.testnet', 1, TIMES['tx-commit-a']],
      ['create', 'tx-create', 'o.testnet', 1, TIMES['tx-create']],
    ],
  );
  assert.equal(page.next_cursor, null);
  assert.match(page.coverage_note, /buy\/refund/);
  const json = JSON.stringify(page);
  assert.ok(!json.includes(SALT), 'never serves a salt');
  assert.ok(!json.includes('7300'), 'never serves a probability from the journal payload');
  assert.ok(!json.includes('tx-pending-b'), 'unconfirmed txs are excluded');

  // Block time is immutable once known: a second read is served from SQLite.
  const before = calls();
  await runtime.getActivity(null, 50);
  assert.equal(calls(), before);
  store.close();
});

test('activity: cursor pagination walks older pages without overlap', async () => {
  const store = new Store(':memory:');
  seedJournal(store);
  const { runtime } = makeRuntime(store, async (tx) => ({ blockHash: 'b', timestampNs: TIMES[tx]! }));
  const p1 = await runtime.getActivity(null, 2);
  assert.deepEqual(p1.items.map((i) => i.tx_hash), ['tx-settle', 'tx-reveal-a']);
  assert.ok(p1.next_cursor);
  const p2 = await runtime.getActivity(Number(p1.next_cursor), 2);
  assert.deepEqual(p2.items.map((i) => i.tx_hash), ['tx-commit-a', 'tx-create']);
  assert.equal(p2.next_cursor, null);
  store.close();
});

test('activity: an unobservable block time is null (never guessed) and is retried later', async () => {
  const store = new Store(':memory:');
  seedJournal(store);
  let down = true;
  const { runtime } = makeRuntime(store, async (tx) => {
    if (down) throw new ChainUnavailableError('rpc down');
    return { blockHash: 'b', timestampNs: TIMES[tx]! };
  });
  const p = await runtime.getActivity(null, 50);
  assert.ok(p.items.every((i) => i.finalized_at === null));
  down = false;
  const q = await runtime.getActivity(null, 50);
  assert.equal(q.items[0]!.finalized_at, TIMES['tx-settle']);
  store.close();
});

test('HTTP /activity validates limit and cursor and serves the page', async () => {
  const store = new Store(':memory:');
  seedJournal(store);
  const { runtime } = makeRuntime(store, async (tx) => ({ blockHash: 'b', timestampNs: TIMES[tx]! }));
  const server = createPublicService(runtime);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'before=-1', 'before=x1']) {
      const res = await fetch(`${base}/activity?${bad}`);
      assert.equal(res.status, 400, bad);
    }
    const res = await fetch(`${base}/activity?limit=1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: { kind: string }[]; next_cursor: string | null };
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!.kind, 'settle');
    assert.ok(body.next_cursor);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
