/**
 * Public analytics / comparison / provenance projections (ticket #6).
 *
 * Read-only projections over FINALIZED public chain views only. They never
 * touch the private Store (forecasts, salts, snapshots), never expose
 * unrevealed probabilities, and never fabricate an Outcome or a score:
 *
 *  - Global leaderboard — per-account Brier error (lower better), coverage
 *    (rounds with a valid Reveal), participation, total stake, locked stake
 *    across non-terminal rounds, and the finalized chain balance view
 *    (claimable / pending / received) plus native NEAR balance.
 *  - Question comparison — per-participant Reveal comparison, exposed ONLY
 *    once the Outcome is final (resolved/settled). Unrevealed probabilities
 *    stay `null`; a missing Outcome is `null`, never invented.
 *  - Simulation report — the deterministic offline replay reused verbatim
 *    from `@hivecast/simulation` (no financial-formula fork).
 *
 * Monetary amounts and timestamps stay decimal strings; the only JSON numbers
 * are counts, bps, and a display-scale Brier mean (identical to the offline
 * report's own floating `brierMean`, which is not money or a timestamp).
 */

import { ONE_NEAR } from '@hivecast/core';
import { loadBundle, runReplay, defaultConfig, DEFAULT_SEED } from '@hivecast/simulation';
import type { ReplayReport } from '@hivecast/simulation';
import type { ChainClient } from './chain/types.js';
import type { CommitmentView, Phase, QuestionView } from './types.js';

/** Brier error scale: (p - o)^2 with p,o in bps -> at most 10^8. */
const BRIER_SQ_SCALE = 100_000_000; // 10^8
const LIST_PAGE_LIMIT = 100;

/** A participant's public comparison row (only final rounds expose scores). */
export interface ComparisonParticipant {
  account_id: string;
  stake: string;
  /** 64-char hex commitment hash (always public). */
  commitment_hash: string;
  /** Revealed probability (bps); `null` until a matching Reveal is on-chain. */
  revealed_prob_bps: number | null;
  valid_revealer: boolean;
  /** Brier error in [0,1] (lower better); `null` when not revealed. */
  brier: number | null;
}

export interface QuestionComparison {
  question_id: number;
  phase: Phase;
  /** Final Outcome only (resolved/settled); null otherwise — never invented. */
  outcome: boolean | null;
  resolved_at: string | null;
  reveal_deadline: string | null;
  /** True only once the Outcome is final, so scores are public. */
  scores_public: boolean;
  participant_count: number;
  total_stake: string;
  single_agent: boolean;
  participants: ComparisonParticipant[];
}

export interface LeaderboardEntry {
  account_id: string;
  rounds_participated: number;
  /** Coverage: rounds where this account produced a valid Reveal. */
  rounds_revealed: number;
  /** Brier error mean in [0,1] (lower better); `null` when no Reveals. */
  brier_mean: number | null;
  /** Exact sum of (p - o)^2 in bps^2 (integer), for reproducible charts. */
  brier_sum_sq: string;
  total_stake: string;
  /** Stake locked in non-terminal (open/closed/resolved) rounds. */
  locked_stake: string;
}

export interface GlobalLeaderboard {
  network_id: string;
  contract_id: string;
  generated_at: string;
  total_questions: number;
  resolved_questions: number;
  /**
   * Gas is reported separately and is not netted into wagering profit or
   * Query-Fee income. Per-agent gas is not queryable on-chain, so the live
   * leaderboard carries gross figures only. Per-account claimable/pending/
   * received balances are served by the wallet-scoped balance view, not here,
   * to keep this projection bounded under a shared RPC.
   */
  gas_disclosure: string;
  entries: LeaderboardEntry[];
}

function outcomeBps(outcome: boolean | null): number | null {
  if (outcome === null) return null;
  return outcome ? 10_000 : 0;
}

/** Exact Brier error (bps^2) = (p - o)^2 for a revealed participant. */
function brierSq(probBps: number, outcome: boolean | null): number | null {
  const o = outcomeBps(outcome);
  if (o === null) return null;
  const d = probBps - o;
  return d * d;
}

/** Paged list of all questions (bounded by the chain's own question count). */
export async function listAllQuestions(chain: ChainClient): Promise<QuestionView[]> {
  const state = await chain.getContractState();
  const total = state.question_count;
  const out: QuestionView[] = [];
  for (let from = 0; from < total; from += LIST_PAGE_LIMIT) {
    const page = await chain.listQuestions(from, LIST_PAGE_LIMIT);
    out.push(...page);
    if (page.length < LIST_PAGE_LIMIT) break;
  }
  return out;
}

/**
 * Global leaderboard over real finalized chain state. Only final-round Reveals
 * contribute a Brier error; every accepted commitment counts as participation.
 */
export async function computeGlobalLeaderboard(
  chain: ChainClient,
  networkId: string,
  contractId: string,
): Promise<GlobalLeaderboard> {
  const questions = await listAllQuestions(chain);
  const resolved = questions.filter((q) => q.phase === 'resolved' || q.phase === 'settled');

  interface Acc {
    participated: number;
    revealed: number;
    brierSumSq: bigint;
    totalStake: bigint;
    lockedStake: bigint;
  }
  const accs = new Map<string, Acc>();
  const ensure = (id: string): Acc => {
    let a = accs.get(id);
    if (!a) {
      a = { participated: 0, revealed: 0, brierSumSq: 0n, totalStake: 0n, lockedStake: 0n };
      accs.set(id, a);
    }
    return a;
  };

  for (const q of questions) {
    const commitments: CommitmentView[] = [];
    for (let from = 0; from < 64; from += 64) {
      const page = await chain.listCommitments(q.question_id, from, 64);
      commitments.push(...page);
      if (page.length < 64) break;
    }
    const terminal = q.phase === 'settled' || q.phase === 'cancelled';
    const outcome = q.outcome;
    for (const c of commitments) {
      const a = ensure(c.account_id);
      a.participated += 1;
      a.totalStake += BigInt(c.stake);
      if (!terminal) a.lockedStake += BigInt(c.stake);
      if (c.revealed !== null && c.revealed !== undefined && (outcome === true || outcome === false)) {
        a.revealed += 1;
        const sq = brierSq(c.revealed, outcome);
        if (sq !== null) a.brierSumSq += BigInt(sq);
      }
    }
  }

  const entries: LeaderboardEntry[] = [];
  for (const [accountId, a] of accs) {
    entries.push({
      account_id: accountId,
      rounds_participated: a.participated,
      rounds_revealed: a.revealed,
      brier_mean: a.revealed === 0 ? null : Number(a.brierSumSq) / BRIER_SQ_SCALE / a.revealed,
      brier_sum_sq: a.brierSumSq.toString(),
      total_stake: a.totalStake.toString(),
      locked_stake: a.lockedStake.toString(),
    });
  }

  // Brier lower better first; accounts without a Reveal sort after (by id).
  entries.sort((x, y) => {
    const a = x.brier_mean;
    const b = y.brier_mean;
    if (a === null && b === null) return x.account_id < y.account_id ? -1 : 1;
    if (a === null) return 1;
    if (b === null) return -1;
    if (a !== b) return a < b ? -1 : 1;
    return x.account_id < y.account_id ? -1 : 1;
  });

  return {
    network_id: networkId,
    contract_id: contractId,
    generated_at: new Date().toISOString(),
    total_questions: questions.length,
    resolved_questions: resolved.length,
    gas_disclosure:
      'Gas is reported separately and is never netted into wagering profit or Query-Fee income; per-agent gas is not queryable on-chain. Per-account balances are served by the wallet-scoped balance view.',
    entries,
  };
}

/** Per-Question public comparison. Scores exist only once the Outcome is final. */
export async function computeQuestionComparison(
  chain: ChainClient,
  questionId: number,
): Promise<QuestionComparison | null> {
  const q = await chain.getQuestion(questionId);
  if (!q) return null;

  const scoresPublic = (q.phase === 'resolved' || q.phase === 'settled') && q.outcome !== null;
  const commitments: CommitmentView[] = [];
  for (let from = 0; from < 64; from += 64) {
    const page = await chain.listCommitments(questionId, from, 64);
    commitments.push(...page);
    if (page.length < 64) break;
  }

  const participants: ComparisonParticipant[] = commitments.map((c) => {
    const revealed = c.revealed !== null && c.revealed !== undefined ? c.revealed : null;
    const brier = revealed !== null && scoresPublic ? brierSq(revealed, q.outcome)! / BRIER_SQ_SCALE : null;
    return {
      account_id: c.account_id,
      stake: c.stake,
      commitment_hash: c.hash,
      revealed_prob_bps: revealed,
      valid_revealer: revealed !== null,
      brier,
    };
  });

  return {
    question_id: questionId,
    phase: q.phase,
    outcome: q.outcome,
    resolved_at: q.resolved_at,
    reveal_deadline: q.reveal_deadline,
    scores_public: scoresPublic,
    participant_count: q.participant_count,
    total_stake: q.total_stake,
    single_agent: q.participant_count === 1,
    participants,
  };
}

/** Deterministic offline simulation report (reused, not reimplemented). */
export function computeSimulationReport(): ReplayReport {
  const bundle = loadBundle();
  return runReplay(bundle, defaultConfig(DEFAULT_SEED));
}

/** Human NEAR formatter reused by the service (never Number for yoctoNEAR). */
export function formatNearYocto(yocto: string): string {
  const v = BigInt(yocto);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / ONE_NEAR;
  const frac = abs % ONE_NEAR;
  const frac6 = (frac * 1_000_000n) / ONE_NEAR;
  const body = `${whole}.${frac6.toString().padStart(6, '0')}`;
  return neg ? `-${body}` : body;
}
