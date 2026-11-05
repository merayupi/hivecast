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

import { ONE_NEAR, settle } from '@hivecast/core';
import { loadBundle, runReplay, defaultConfig, DEFAULT_SEED } from '@hivecast/simulation';
import type { ReplayReport } from '@hivecast/simulation';
import type { ChainClient } from './chain/types.js';
import type { PublicReadSource } from './public-cache.js';
import type { Phase, QuestionView } from './types.js';
import type { PublicJournalRow } from './store.js';

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
  source: PublicReadSource,
  networkId: string,
  contractId: string,
): Promise<GlobalLeaderboard> {
  const questions = await source.listAllQuestions();
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
    const commitments = await source.listAllCommitments(q.question_id);
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
  source: PublicReadSource,
  questionId: number,
): Promise<QuestionComparison | null> {
  const q = (await source.listAllQuestions()).find((x) => x.question_id === questionId);
  if (!q) return null;

  const scoresPublic = (q.phase === 'resolved' || q.phase === 'settled') && q.outcome !== null;
  const commitments = await source.listAllCommitments(questionId);

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

// ---------------------------------------------------------------------------
// Live account economics (spec stories 68 / 74): Bankroll, Available, locked,
// Claimable/pending/received, wagering P&L, Query-Fee income, and actual gas —
// all distinct, all reused from the shared core accounting (no formula fork).
// ---------------------------------------------------------------------------

export interface AccountEconomics {
  account_id: string;
  /** Bankroll = native NEAR balance (keyless view_account; `null` when the RPC
   * view is unavailable — never a fabricated zero). */
  bankroll: string | null;
  /** Available = bankroll − locked stake (`null` when bankroll is unavailable). */
  available: string | null;
  /** Stake locked in non-terminal (open/closed/resolved) rounds. */
  locked_stake: string;
  /** Finalized chain balance view (claimable/pending/received). */
  claimable: string;
  pending: string;
  received: string;
  /** Wagering P&L = Σ(basePayout − stake) over settled rounds (exact core settle). */
  wagering_pnl: string;
  /** Query-Fee income = Σ(feePayout) over settled rounds (exact core settle). */
  fee_income: string;
  /** Actual observed gas cost = Σ(tokens_burnt) over confirmed journal txs. */
  gas_burnt: string;
  /** Whether this account has participated in at least one Round. */
  participated: boolean;
}

export interface EconomicsReport {
  network_id: string;
  contract_id: string;
  generated_at: string;
  /**
   * Wagering P&L, Query-Fee income, and gas are reported separately. Gas is a
   * cost the Operator pays out of operational reserves, never netted into a
   * participant's wagering profit or fee income.
   */
  separation_note: string;
  accounts: AccountEconomics[];
}

/**
 * Exact live account economics. Wagering P&L and fee income are computed by
 * replaying each settled Round through the shared `settle` accounting (the
 * same module the contract mirrors); gas is summed from the public journal's
 * finalized transaction hashes via `tokens_burnt` (confirmed AND failed
 * finalized transactions — both burn gas). Only the caller-supplied account
 * set is fetched (bounded), never every on-chain account.
 */
export async function computeAccountEconomics(
  source: PublicReadSource,
  networkId: string,
  contractId: string,
  accounts: readonly string[],
  publicJournal: readonly PublicJournalRow[],
  operationalGasReserveYocto: bigint,
): Promise<EconomicsReport> {
  const questions = await source.listAllQuestions();

  interface Acc {
    accountId: string;
    lockedStake: bigint;
    wageringPnl: bigint;
    feeIncome: bigint;
    gasBurnt: bigint;
    participated: boolean;
    /** Finalized chain balance view (claimable/pending/received), or null. */
    balance: { claimable: string; pending: string; received: string } | null;
    /** Native total balance (view_account `amount`), or null when unavailable. */
    nativeTotal: bigint | null;
    /** Native spendable balance (view_account `amount − locked`), or null. */
    nativeAvailable: bigint | null;
  }
  const map = new Map<string, Acc>();
  const empty = (accountId: string): Acc => ({
    accountId,
    lockedStake: 0n,
    wageringPnl: 0n,
    feeIncome: 0n,
    gasBurnt: 0n,
    participated: false,
    balance: null,
    nativeTotal: null,
    nativeAvailable: null,
  });
  for (const id of accounts) map.set(id, empty(id));
  const ensure = (id: string): Acc => {
    let a = map.get(id);
    if (!a) {
      a = empty(id);
      map.set(id, a);
    }
    return a;
  };

  // Gas: sum tokens_burnt over CONFIRMED and FAILED finalized journal
  // transactions per account (a failed finalized tx still spent gas). An empty
  // observed journal means genuine zero gas — not an unknown.
  const finalizedByAccount = new Map<string, string[]>();
  for (const j of publicJournal) {
    if ((j.status !== 'confirmed' && j.status !== 'failed') || !j.txHash || !j.accountId) continue;
    const list = finalizedByAccount.get(j.accountId) ?? [];
    list.push(j.txHash);
    finalizedByAccount.set(j.accountId, list);
  }
  const gasByAccount = new Map<string, bigint>();
  for (const [accountId, hashes] of finalizedByAccount) {
    let sum = 0n;
    for (const h of hashes) {
      const burnt = await source.viewTxTokensBurnt(h, accountId);
      if (burnt !== null) sum += BigInt(burnt);
    }
    gasByAccount.set(accountId, sum);
  }

  for (const q of questions) {
    const commitments = await source.listAllCommitments(q.question_id);
    const terminal = q.phase === 'settled' || q.phase === 'cancelled';

    for (const c of commitments) {
      const a = ensure(c.account_id);
      a.participated = true;
      if (!terminal) a.lockedStake += BigInt(c.stake);
    }

    if (q.phase === 'settled' && (q.outcome === true || q.outcome === false)) {
      // Exact allocation via the shared core accounting (no fork).
      const participants = commitments.map((c) => ({
        accountId: c.account_id,
        stake: BigInt(c.stake),
        probabilityBps: c.revealed ?? 0,
        isValidRevealer: c.revealed !== null && c.revealed !== undefined,
      }));
      const feePool = BigInt(q.fee_pool);
      const outcomeBps = q.outcome ? 10_000 : 0;
      const s = settle(participants, outcomeBps, feePool);
      for (const row of s.rows) {
        const a = ensure(row.accountId);
        a.wageringPnl += row.basePayout - row.stake;
        a.feeIncome += row.feePayout;
      }
    }
    // Cancelled rounds return stakes (no P&L); refunds are buyer-side and not
    // part of an Agent's wagering economics, so nothing is added here.
  }

  // Native + final balance view per account (bounded set). Keyless
  // `view_account` reads (coalesced by the cache), so read-only projections
  // never need a signing key. Failures surface as null, never a fake zero.
  for (const id of accounts) {
    const a = map.get(id)!;
    a.nativeTotal = await source.viewNativeBalance(id);
    a.nativeAvailable = await source.viewNativeAvailable(id);
    const b = await source.getBalance(id);
    if (b) a.balance = { claimable: b.claimable, pending: b.pending, received: b.received };
  }

  const rows: AccountEconomics[] = [...map.values()]
    .filter((a) => a.participated || a.balance !== null || a.nativeTotal !== null || gasByAccount.has(a.accountId))
    .map((a) => {
      const claimable = a.balance ? BigInt(a.balance.claimable) : 0n;
      const pending = a.balance ? BigInt(a.balance.pending) : 0n;
      // Bankroll = native total + claimable + locked round stake. `received` is
      // already inside native total (delivered), and `pending` is excluded when
      // non-zero because an in-flight transfer may already be reflected in the
      // native balance (callback lag) — reporting null is honest, not a double
      // count. Null whenever the native view is unavailable.
      const bankroll =
        a.nativeTotal === null
          ? null
          : pending > 0n
            ? null
            : (a.nativeTotal + claimable + a.lockedStake).toString();
      // Available mirrors the runner's stake base: native spendable (amount −
      // locked storage) minus the operational gas reserve. Private capital
      // reservations are invisible to a keyless projection, so the true
      // spendable may be lower; that is disclosed in the separation note.
      const available =
        a.nativeAvailable === null
          ? null
          : (a.nativeAvailable - operationalGasReserveYocto < 0n
              ? 0n
              : a.nativeAvailable - operationalGasReserveYocto).toString();
      return {
        account_id: a.accountId,
        bankroll,
        available,
        locked_stake: a.lockedStake.toString(),
        claimable: a.balance?.claimable ?? '0',
        pending: a.balance?.pending ?? '0',
        received: a.balance?.received ?? '0',
        wagering_pnl: a.wageringPnl.toString(),
        fee_income: a.feeIncome.toString(),
        gas_burnt: (gasByAccount.get(a.accountId) ?? 0n).toString(),
        participated: a.participated,
      };
    })
    .sort((x, y) => (x.account_id < y.account_id ? -1 : 1));

  return {
    network_id: networkId,
    contract_id: contractId,
    generated_at: new Date().toISOString(),
    separation_note:
      'Wagering P&L, Query-Fee income, and gas are separate. Gas is an operational cost (paid by the Operator, summing tokens_burnt over confirmed and failed finalized transactions), never netted into a participant wagering profit or fee income. Available = native spendable (amount − storage-locked) minus the operational gas reserve; private capital reservations are invisible to this public projection, so the true spendable may be lower. Bankroll = native total + claimable + locked round stake, reported null while a withdrawal is in-flight (pending) because the transfer may already be reflected in the native balance.',
    accounts: rows,
  };
}
