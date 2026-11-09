/**
 * Scene state machine: phase → scene, missing data → NO DATA YET, bench
 * reasons, real-payout coins, default Round selection. Settled/cancelled
 * cases use API responses recorded from the live runner (test/fixtures);
 * phases that have no live Round on chain yet use synthetic Rounds built
 * from the recorded shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveScene, coinFlows, pickDefaultRound, scheduleBoard, nextMilestone } from '../src/arena/scene';
import { envelopeRects, hitEnvelope, coinTier, actorAnchor, storyDuration } from '../src/arena/renderer';
import type { AgentRosterEntry, QuestionComparison, QuestionView } from '../src/lib/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = <T>(name: string): T => JSON.parse(readFileSync(path.join(HERE, 'fixtures', `${name}.json`), 'utf8')) as T;

const roster = fx<{ agents: AgentRosterEntry[] }>('agents').agents;
const questions = fx<{ questions: QuestionView[] }>('questions').questions;
const q = (id: number) => questions.find((x) => x.question_id === id)!;
const cmp = (id: number) => fx<QuestionComparison>(`comparison-${id}`);

const NS = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const T0 = Date.parse('2026-11-10T13:00:00Z');

/** A synthetic Round in the recorded shape, with a schedule around T0. */
function synthetic(over: Partial<QuestionView>): QuestionView {
  return {
    ...q(4),
    question_id: 99,
    open_time: NS(T0 - 15 * 60_000),
    close_time: NS(T0 - 5 * 60_000),
    observation_start: NS(T0),
    observation_end: NS(T0 + 3_600_000),
    resolve_time: NS(T0 + 3_600_000),
    resolve_deadline: NS(T0 + 4_500_000),
    phase: 'closed',
    outcome: null,
    resolved_at: null,
    reveal_deadline: null,
    snapshot_ready: false,
    snapshot_id: null,
    buyer_count: 0,
    ...over,
  };
}

function syntheticComparison(question: QuestionView, revealed: (number | null)[]): QuestionComparison {
  const base = cmp(4);
  return {
    ...base,
    question_id: question.question_id,
    phase: question.phase,
    outcome: question.outcome,
    scores_public: question.phase === 'resolved' || question.phase === 'settled',
    payouts: null,
    participants: base.participants.map((p, i) => ({
      ...p,
      revealed_prob_bps: revealed[i] ?? null,
      valid_revealer: revealed[i] !== null && revealed[i] !== undefined,
      brier: null,
      base_payout: null,
      fee_payout: null,
    })),
  };
}

// ---- missing data ---------------------------------------------------------

test('no Round → NO DATA YET scene with no actors and no numbers', () => {
  const s = deriveScene({ question: null, comparison: null, roster, nowMs: T0 });
  assert.equal(s.kind, 'no-data');
  assert.equal(s.banner, 'NO DATA YET');
  assert.equal(s.actors.length, 0);
  assert.equal(s.sealed, null);
  assert.equal(s.outcome, null);
  assert.equal(s.coins.length, 0);
});

test('a Round without its comparison shows no invented agents, only the on-chain count', () => {
  const s = deriveScene({ question: q(4), comparison: null, roster, nowMs: T0 });
  assert.equal(s.kind, 'settled');
  assert.equal(s.actors.length, 0);
  assert.equal(s.sealed?.n, 6);
  assert.equal(s.coins.length, 0);
});

test('a stale comparison for another Round is ignored', () => {
  const s = deriveScene({ question: q(3), comparison: cmp(4), roster, nowMs: T0 });
  assert.equal(s.actors.length, 0);
});

test('settled comparison from an older runner (no payout fields) → net null, no coins', () => {
  const c = cmp(4);
  const old = { ...c, payouts: undefined, participants: c.participants.map(({ base_payout: _b, fee_payout: _f, ...p }) => p) };
  const s = deriveScene({ question: q(4), comparison: old, roster, nowMs: T0 });
  assert.ok(s.actors.every((a) => a.net === null && a.result === null));
  assert.equal(s.coins.length, 0);
});

// ---- phase → scene (recorded) ---------------------------------------------

test('SETTLED (recorded q4, Outcome YES): winners/losers from real payouts, coins conserve amounts', () => {
  const c = cmp(4);
  const s = deriveScene({ question: q(4), comparison: c, roster, nowMs: T0 });
  assert.equal(s.kind, 'settled');
  assert.equal(s.outcome, true);
  assert.equal(s.actors.length, 6);
  const yolo = s.actors.find((a) => a.agentId === 'yolo')!;
  assert.equal(yolo.revealedBps, 10_000);
  assert.equal(yolo.result, 'win');
  assert.equal(yolo.pose, 'win');
  const persistence = s.actors.find((a) => a.agentId === 'persistence')!;
  assert.equal(persistence.result, 'lose');
  assert.equal(persistence.pose, 'lose');
  // Every net equals base + fee − stake from the API, exactly.
  for (const a of s.actors) {
    const p = c.participants.find((x) => x.account_id === a.accountId)!;
    assert.equal(a.net, (BigInt(p.base_payout!) + BigInt(p.fee_payout!) - BigInt(p.stake)).toString());
  }
  // Loser→winner coins carry exactly the stake losses; fee coins exactly the fees.
  const losses = s.actors.reduce((sum, a) => {
    const d = BigInt(a.basePayout!) - BigInt(a.stake);
    return d < 0n ? sum - d : sum;
  }, 0n);
  const fromLosers = s.coins.filter((f) => f.from !== 'fee-pool').reduce((sum, f) => sum + BigInt(f.amount), 0n);
  const fromFees = s.coins.filter((f) => f.from === 'fee-pool').reduce((sum, f) => sum + BigInt(f.amount), 0n);
  assert.equal(fromLosers, losses);
  assert.equal(fromFees, BigInt(q(4).fee_pool));
  // Bench: price Round → weather specialists cannot play; Herald did not commit.
  const reasons = Object.fromEntries(s.bench.map((b) => [b.agentId, b.reason]));
  assert.equal(reasons.meteo, 'domain not supported');
  assert.equal(reasons.climatology, 'domain not supported');
  assert.equal(reasons['llm-news'], 'abstained');
  assert.equal(s.sealed?.m, 7, 'seven roster agents support price');
});

test('recorded q4 payouts sum to the on-chain received W+F (PRODUCT.md evidence)', () => {
  const total = cmp(4).participants.reduce((s, p) => s + BigInt(p.base_payout!) + BigInt(p.fee_payout!), 0n);
  assert.equal(total, 732563162558815544300000n);
});

test('CANCELLED with commitments (recorded q5) → refund story; with none (q0) → no actors', () => {
  const s5 = deriveScene({ question: q(5), comparison: cmp(5), roster, nowMs: T0 });
  assert.equal(s5.kind, 'cancelled');
  assert.equal(s5.banner, 'Round cancelled — stakes and fees refunded');
  assert.equal(s5.actors.length, 6);
  assert.ok(s5.actors.every((a) => a.label === 'REFUNDED' && a.net === null));
  assert.equal(s5.coins.length, 0);
  assert.equal(s5.outcome, null);

  const s0 = deriveScene({ question: q(0), comparison: cmp(0), roster, nowMs: T0 });
  assert.equal(s0.kind, 'cancelled');
  assert.equal(s0.banner, 'Round cancelled — no commitments');
  assert.equal(s0.actors.length, 0);
});

// ---- phase → scene (synthetic schedule) -----------------------------------

test('OPEN → seal story with SEALED n/m and hashes from the comparison', () => {
  const question = synthetic({ phase: 'open', participant_count: 6 });
  const s = deriveScene({ question, comparison: syntheticComparison(question, []), roster, nowMs: T0 - 10 * 60_000 });
  assert.equal(s.kind, 'open');
  assert.deepEqual(s.sealed, { n: 6, m: 7 });
  assert.ok(s.actors.every((a) => a.pose === 'seal' && a.revealedBps === null && /^[0-9a-f]{64}$/.test(a.commitmentHash)));
  assert.equal(s.bench.find((b) => b.agentId === 'llm-news')?.reason, 'not committed yet');
});

test('CLOSED splits into sealing → snapshot sale → observing → awaiting outcome by schedule', () => {
  const sealing = deriveScene({ question: synthetic({}), comparison: null, roster, nowMs: T0 - 60_000 });
  assert.equal(sealing.kind, 'sealing');
  const sale = deriveScene({ question: synthetic({ snapshot_ready: true }), comparison: null, roster, nowMs: T0 - 60_000 });
  assert.equal(sale.kind, 'snapshot-sale');
  assert.equal(sale.banner, 'The swarm has spoken — read it before the event starts');
  const observing = deriveScene({ question: synthetic({ snapshot_ready: true }), comparison: null, roster, nowMs: T0 + 60_000 });
  assert.equal(observing.kind, 'observing');
  assert.equal(observing.subline, 'OBSERVING UNTIL 14:00 UTC');
  assert.equal(observing.localHour, null, 'price shows a candle frame, not a sky');
  const after = deriveScene({ question: synthetic({ snapshot_ready: true }), comparison: null, roster, nowMs: T0 + 3_700_000 });
  assert.equal(after.kind, 'awaiting-outcome');
});

test('weather observing shows the city’s real local hour in its own time zone', () => {
  const source = JSON.stringify({ kind: 'weather', city: 'Tokyo', timezone: 'Asia/Tokyo', latitude: 35.68, longitude: 139.69 });
  const s = deriveScene({ question: synthetic({ source, snapshot_ready: true }), comparison: null, roster, nowMs: T0 + 60_000 });
  assert.equal(s.kind, 'observing');
  assert.equal(s.city, 'Tokyo');
  assert.equal(s.localHour, 22, '13:01 UTC is 22h in Tokyo');
  assert.match(s.subline!, /OBSERVING UNTIL 23:00 GMT\+9/);
});

test('RESOLVED: revealed agents pop their probability; others wait, then show NO REVEAL · score 0', () => {
  const question = synthetic({
    phase: 'resolved',
    outcome: true,
    resolved_at: NS(T0 + 4_000_000),
    reveal_deadline: NS(T0 + 4_900_000),
  });
  const comparison = syntheticComparison(question, [7300, null, 2500, null, 10_000, 4100]);
  const during = deriveScene({ question, comparison, roster, nowMs: T0 + 4_100_000 });
  assert.equal(during.kind, 'resolved');
  assert.equal(during.outcome, true);
  const labels = during.actors.map((a) => a.label);
  assert.ok(labels.includes('73.00%'));
  assert.ok(labels.includes('NOT REVEALED YET'));
  assert.ok(!labels.includes('NO REVEAL · score 0'));
  const after = deriveScene({ question, comparison, roster, nowMs: T0 + 5_000_000 });
  assert.equal(after.actors.filter((a) => a.label === 'NO REVEAL · score 0').length, 2);
  assert.ok(after.actors.filter((a) => a.revealedBps !== null).every((a) => a.pose === 'reveal'));
});

test('scene derives from data: the same inputs give the same scene and story key', () => {
  const a = deriveScene({ question: q(4), comparison: cmp(4), roster, nowMs: T0 });
  const b = deriveScene({ question: q(4), comparison: cmp(4), roster, nowMs: T0 + 3_600_000 });
  assert.deepEqual(a, b);
});

test('out of capital comes from economics: available below the minimum stake', () => {
  const question = synthetic({ phase: 'open' });
  const s = deriveScene({
    question,
    comparison: { ...syntheticComparison(question, []), participants: [] },
    roster,
    economics: [{ account_id: roster.find((r) => r.agentId === 'yolo')!.accountId, available: '1' } as never],
    minStakeYocto: '100000000000000000000000',
    nowMs: T0 - 10 * 60_000,
  });
  assert.equal(s.bench.find((b) => b.agentId === 'yolo')?.reason, 'out of capital');
});

// ---- selection / board ----------------------------------------------------

test('default Round: reveal in progress → snapshot on sale → most recent settled', () => {
  assert.equal(pickDefaultRound(questions, T0)?.question_id, 4, 'recorded: newest settled');
  const sale = synthetic({ question_id: 50, snapshot_ready: true });
  assert.equal(pickDefaultRound([...questions, sale], T0 - 60_000)?.question_id, 50);
  const resolved = synthetic({ question_id: 40, phase: 'resolved', outcome: false });
  assert.equal(pickDefaultRound([...questions, sale, resolved], T0 - 60_000)?.question_id, 40);
  assert.equal(pickDefaultRound([], T0), null);
});

test('schedule board and next milestone', () => {
  const open = synthetic({ question_id: 60, phase: 'open' });
  const board = scheduleBoard([...questions, open]);
  assert.deepEqual(board.upcoming.map((x) => x.question_id), [60]);
  assert.deepEqual(board.recent.map((x) => x.question_id).slice(0, 3), [5, 4, 3]);
  assert.equal(nextMilestone(open, T0 - 10 * 60_000)?.label, 'Commitments close');
  assert.equal(nextMilestone(q(4), T0), null);
});

// ---- renderer helpers -----------------------------------------------------

test('envelope hit targets line up with the drawn envelopes', () => {
  const rects = envelopeRects(6);
  assert.equal(rects.length, 6);
  const r = rects[2]!;
  assert.equal(hitEnvelope(r.x + 3, r.y + 2, 6), 2);
  assert.equal(hitEnvelope(0, 0, 6), null);
  // All actors fit on the 320-px stage.
  for (let n = 1; n <= 9; n += 1) for (let i = 0; i < n; i += 1) {
    const a = actorAnchor(i, n);
    assert.ok(a.x - 12 >= 0 && a.x + 12 <= 320, `n=${n} i=${i}`);
  }
});

test('coin size tiers follow real amounts; story lengths are finite', () => {
  assert.equal(coinTier(100n, 100n), 3);
  assert.equal(coinTier(30n, 100n), 2);
  assert.equal(coinTier(1n, 100n), 1);
  const s = deriveScene({ question: q(4), comparison: cmp(4), roster, nowMs: T0 });
  assert.ok(storyDuration(s) > 0 && Number.isFinite(storyDuration(s)));
  assert.deepEqual(coinFlows([]), []);
});
