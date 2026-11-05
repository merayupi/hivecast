/**
 * Public analytics boundary tests (ticket #6) — NOT real-chain proof.
 *
 * These assert the leaderboard/comparison computation against a controllable
 * chain adapter: Brier is lower-better, coverage counts valid Reveals only,
 * unrevealed probabilities and non-final Outcomes are never fabricated, and
 * the simulation report is deterministic. The real-chain proof lives in the
 * live browser flow (ticket #7), not here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeGlobalLeaderboard, computeQuestionComparison, computeSimulationReport } from '../src/public-data.js';
import type { ChainClient } from '../src/chain/types.js';
import type { BalanceView, CommitmentView, ContractState, QuestionView } from '../src/types.js';

const NETWORK = 'testnet';
const CONTRACT = 'hivecast-market-6c4d.testnet';

function commitment(accountId: string, stake: string, revealed: number | null): CommitmentView {
  return {
    question_id: 1,
    account_id: accountId,
    stake,
    hash: 'a'.repeat(64),
    revealed,
  };
}

function qview(id: number, phase: QuestionView['phase'], outcome: boolean | null, participantCount: number): QuestionView {
  return {
    question_id: id,
    text: 'Q',
    event_definition: 'E',
    source: 'binance:NEARUSDT:1h',
    resolver: 'op.testnet',
    open_time: '1',
    close_time: '2',
    observation_start: '3',
    observation_end: '4',
    resolve_time: '4',
    resolve_deadline: '5',
    reveal_window: '600000000000',
    access_price: '10000000000000000000000',
    min_stake: '100000000000000000000000',
    phase,
    outcome,
    resolved_at: outcome === null ? null : '4500',
    reveal_deadline: outcome === null ? null : '5100',
    snapshot_ready: false,
    snapshot_id: null,
    total_stake: '300000000000000000000000',
    fee_pool: '10000000000000000000000',
    participant_count: participantCount,
    buyer_count: 0,
  };
}

function fakeChain(questions: QuestionView[], byQid: Map<number, CommitmentView[]>): ChainClient {
  const state: ContractState = { operator: 'op.testnet', next_question_id: questions.length, next_nonce: 0, question_count: questions.length };
  return {
    contractId: CONTRACT,
    nowNs: () => 0n,
    getContractState: async () => state,
    getQuestion: async (id: number) => questions.find((q) => q.question_id === id) ?? null,
    listQuestions: async (from: number, limit: number) => questions.slice(from, from + limit),
    getCommitment: async () => null,
    listCommitments: async (id: number) => byQid.get(id) ?? [],
    getBalance: async (): Promise<BalanceView> => ({ account_id: 'a.testnet', claimable: '1', pending: '2', received: '3' }),
    hasBought: async () => false,
    getBuyerReceipt: async () => null,
    listBuyers: async () => [],
    getPendingWithdrawal: async () => null,
    listPendingWithdrawals: async () => [],
    viewAccountBalance: async () => 10n ** 24n,
    viewAccessKeyPermission: async () => null,
    prepareCall: async () => { throw new Error('not used'); },
    broadcastCall: async () => { throw new Error('not used'); },
    createQuestion: async () => { throw new Error('not used'); },
    commit: async () => { throw new Error('not used'); },
    publishSnapshot: async () => { throw new Error('not used'); },
    buyForecast: async () => { throw new Error('not used'); },
    resolve: async () => { throw new Error('not used'); },
    reveal: async () => { throw new Error('not used'); },
    settle: async () => { throw new Error('not used'); },
    cancel: async () => { throw new Error('not used'); },
    claimBuyerRefund: async () => { throw new Error('not used'); },
    withdraw: async () => { throw new Error('not used'); },
  } as unknown as ChainClient;
}

test('leaderboard: Brier is lower-better, coverage counts valid Reveals only, non-reveal has no score', async () => {
  // Two resolved questions, outcome YES (10000 bps).
  const q1 = qview(1, 'settled', true, 3);
  const q2 = qview(2, 'settled', false, 2);
  // q1: alice reveals 10000 (perfect, brier 0), bob reveals 0 (brier 1), carol no reveal.
  // q2: alice reveals 0 (perfect for NO, brier 0), dave reveals 10000 (brier 1).
  const byQid = new Map<number, CommitmentView[]>();
  byQid.set(1, [commitment('alice.testnet', '100000000000000000000000', 10000), commitment('bob.testnet', '100000000000000000000000', 0), commitment('carol.testnet', '100000000000000000000000', null)]);
  byQid.set(2, [commitment('alice.testnet', '100000000000000000000000', 0), commitment('dave.testnet', '100000000000000000000000', 10000)]);

  const board = await computeGlobalLeaderboard(fakeChain([q1, q2], byQid), NETWORK, CONTRACT);
  const byId = new Map(board.entries.map((e) => [e.account_id, e]));

  const alice = byId.get('alice.testnet')!;
  assert.equal(alice.rounds_participated, 2);
  assert.equal(alice.rounds_revealed, 2);
  assert.equal(alice.brier_mean, 0); // perfect on both

  const bob = byId.get('bob.testnet')!;
  assert.equal(bob.rounds_participated, 1);
  assert.equal(bob.rounds_revealed, 1);
  assert.equal(bob.brier_mean, 1); // (0 - 10000)^2 / 1e8

  const carol = byId.get('carol.testnet')!;
  assert.equal(carol.rounds_participated, 1);
  assert.equal(carol.rounds_revealed, 0); // no reveal -> not coverage
  assert.equal(carol.brier_mean, null); // no score, not invented

  // alice (brier 0) sorts before bob/dave (brier 1) before carol (null).
  assert.equal(board.entries[0]!.account_id, 'alice.testnet');
  assert.equal(board.resolved_questions, 2);
});

test('leaderboard: locked stake counts only non-terminal rounds', async () => {
  const open = qview(1, 'open', null, 1);
  const resolved = qview(2, 'resolved', true, 1);
  const settled = qview(3, 'settled', false, 1);
  const byQid = new Map<number, CommitmentView[]>();
  byQid.set(1, [commitment('alice.testnet', '500000000000000000000000', null)]);
  byQid.set(2, [commitment('alice.testnet', '500000000000000000000000', 10000)]);
  byQid.set(3, [commitment('alice.testnet', '500000000000000000000000', 0)]);

  const board = await computeGlobalLeaderboard(fakeChain([open, resolved, settled], byQid), NETWORK, CONTRACT);
  const alice = board.entries.find((e) => e.account_id === 'alice.testnet')!;
  // open + resolved are non-terminal; settled is terminal.
  assert.equal(alice.locked_stake, (10n ** 24n).toString());
  assert.equal(alice.total_stake, (15n * 10n ** 23n).toString());
});

test('comparison: scores are public only once the Outcome is final', async () => {
  // Open round: commitment with no Reveal yet (revealed null on-chain).
  const openByQid = new Map<number, CommitmentView[]>();
  openByQid.set(7, [commitment('alice.testnet', '100000000000000000000000', null)]);

  const open = (await computeQuestionComparison(fakeChain([qview(7, 'open', null, 1)], openByQid), 7))!;
  assert.equal(open.scores_public, false);
  assert.equal(open.outcome, null);
  assert.equal(open.participants[0]!.revealed_prob_bps, null);
  assert.equal(open.participants[0]!.brier, null);

  // Settled round: Reveal is on-chain, so the probability is public.
  const settledByQid = new Map<number, CommitmentView[]>();
  settledByQid.set(7, [commitment('alice.testnet', '100000000000000000000000', 10000)]);
  const settled = (await computeQuestionComparison(fakeChain([qview(7, 'settled', true, 1)], settledByQid), 7))!;
  assert.equal(settled.scores_public, true);
  assert.equal(settled.single_agent, true);
  assert.equal(settled.participants[0]!.revealed_prob_bps, 10000);
  assert.equal(settled.participants[0]!.brier, 0);
});

test('simulation report: deterministic and labelled log-odds comparison', () => {
  const a = computeSimulationReport();
  const b = computeSimulationReport();
  assert.deepEqual(a, b); // same bundle/seed -> identical
  assert.equal(a.seed, 42);
  assert.ok(a.price.totalRounds === 1440);
  assert.ok(a.weather.totalRounds === 60);
  // Labelled log-odds comparison, not the paid probability-space aggregate.
  for (const agg of [...a.price.aggregates, ...a.weather.aggregates]) {
    assert.ok(typeof agg.logOddsBrierMean === 'number');
    assert.ok(typeof agg.logOddsClip === 'string');
  }
});
