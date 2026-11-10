/**
 * Scene state machine: a PURE function of (Round, comparison, roster,
 * rationale, economics, now). It decides what the stage shows; the renderer
 * only animates it. Nothing here invents a number: every probability, hash,
 * Outcome and payout is copied from the API, and missing inputs produce an
 * explicit `no-data` scene or `null` fields, never a placeholder value.
 */
import type {
  AccountEconomics,
  AgentRosterEntry,
  Domain,
  LlmRationale,
  QuestionComparison,
  QuestionView,
} from '../lib/types';
import { questionDomain, sourceCity, sourceTimeZone } from '../lib/format';
import { agentIdForAccount, personaFor, rosterIndex } from './personas';

export type SceneKind =
  | 'no-data'
  | 'open'
  | 'sealing'
  | 'snapshot-sale'
  | 'observing'
  | 'awaiting-outcome'
  | 'resolved'
  | 'settled'
  | 'cancelled';

export type Pose = 'idle' | 'seal' | 'reveal' | 'win' | 'lose' | 'bankrupt';

export interface SceneActor {
  agentId: string;
  accountId: string;
  name: string;
  color: string;
  onColor: string;
  initial: string;
  stake: string;
  commitmentHash: string;
  revealedBps: number | null;
  /** Brier error in [0,1]; only once scores are public. */
  brier: number | null;
  /** Status label shown above the agent (e.g. "73.00%", "NO REVEAL · score 0"). */
  label: string | null;
  basePayout: string | null;
  feePayout: string | null;
  /** base + fee − stake (yoctoNEAR), SETTLED only. */
  net: string | null;
  result: 'win' | 'lose' | 'even' | null;
  /** Final pose of the story. */
  pose: Pose;
}

export interface BenchActor {
  agentId: string;
  accountId: string;
  name: string;
  color: string;
  onColor: string;
  initial: string;
  reason: string;
}

/** A coin flight between two agents (or from the fee pot) with its real amount. */
export interface CoinFlow {
  from: string | 'fee-pool';
  to: string;
  amount: string;
}

export interface Scene {
  kind: SceneKind;
  /** Stable key: a story replays when this changes. */
  storyKey: string;
  questionId: number | null;
  domain: Domain | null;
  city: string | null;
  timeZone: string;
  banner: string;
  /** Sub-line under the banner (e.g. "OBSERVING UNTIL 14:00 UTC"). */
  subline: string | null;
  /** "SEALED n/m" (m = agents supporting this domain; null when roster unknown). */
  sealed: { n: number; m: number | null } | null;
  outcome: boolean | null;
  actors: SceneActor[];
  bench: BenchActor[];
  coins: CoinFlow[];
  /** Weather observing: the city's real local hour (0–23), else null. */
  localHour: number | null;
  /** The reason a `no-data` scene has no data. */
  noDataReason: string | null;
}

export interface SceneInput {
  question: QuestionView | null;
  comparison: QuestionComparison | null;
  roster: readonly AgentRosterEntry[] | null;
  rationale?: LlmRationale | null;
  economics?: readonly AccountEconomics[] | null;
  minStakeYocto?: string | null;
  nowMs: number;
}

const NS_PER_MS = 1_000_000n;
const msOf = (ns: string): number => Number(BigInt(ns) / NS_PER_MS);

export function pctLabel(bps: number): string {
  return `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;
}

/** hh:mm in a time zone, with its short zone name (e.g. "14:00 UTC"). */
export function clockIn(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('timeZoneName')}`.trim();
}

function localHourIn(ms: number, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone }).format(new Date(ms));
  return Number(h) % 24;
}

function noData(reason: string): Scene {
  return {
    kind: 'no-data',
    storyKey: `no-data:${reason}`,
    questionId: null,
    domain: null,
    city: null,
    timeZone: 'UTC',
    banner: 'NO DATA YET',
    subline: reason,
    sealed: null,
    outcome: null,
    actors: [],
    bench: [],
    coins: [],
    localHour: null,
    noDataReason: reason,
  };
}

/** Which phase of a CLOSED Round we are in, from its schedule and `now`. */
function closedKind(q: QuestionView, nowMs: number): SceneKind {
  if (nowMs < msOf(q.observation_start)) return q.snapshot_ready ? 'snapshot-sale' : 'sealing';
  if (nowMs < msOf(q.observation_end)) return 'observing';
  return 'awaiting-outcome';
}

export function deriveScene(input: SceneInput): Scene {
  const { question: q, comparison, roster, nowMs } = input;
  if (!q) return noData('No Round selected or the runner API is unreachable.');

  const domain = questionDomain(q.source);
  const timeZone = sourceTimeZone(q.source);
  const city = sourceCity(q.source);

  let kind: SceneKind;
  switch (q.phase) {
    case 'open':
      kind = 'open';
      break;
    case 'closed':
      kind = closedKind(q, nowMs);
      break;
    case 'resolved':
      kind = 'resolved';
      break;
    case 'settled':
      kind = 'settled';
      break;
    case 'cancelled':
      kind = 'cancelled';
      break;
    default:
      return noData(`Unknown phase "${String(q.phase)}".`);
  }

  const notOpenYet = kind === 'open' && nowMs < msOf(q.open_time);

  // Participants come only from the comparison (commitment hashes, stakes,
  // Reveals). Without it we still know the count, but show no fake agents.
  const comparisonMatches = comparison !== null && comparison.question_id === q.question_id;
  const participants = comparisonMatches ? comparison.participants : [];
  const scoresPublic = comparisonMatches && comparison.scores_public;
  const revealDeadlineMs = q.reveal_deadline ? msOf(q.reveal_deadline) : null;
  const revealWindowOver = revealDeadlineMs !== null && nowMs >= revealDeadlineMs;

  const actors: SceneActor[] = participants
    .map((p): SceneActor => {
      const agentId = agentIdForAccount(p.account_id, roster);
      const persona = personaFor(agentId);
      const revealed = p.revealed_prob_bps;
      const base = p.base_payout ?? null;
      const fee = p.fee_payout ?? null;
      const net = kind === 'settled' && base !== null && fee !== null ? (BigInt(base) + BigInt(fee) - BigInt(p.stake)).toString() : null;
      const result: SceneActor['result'] = net === null ? null : BigInt(net) > 0n ? 'win' : BigInt(net) < 0n ? 'lose' : 'even';

      let label: string | null = null;
      let pose: Pose = 'idle';
      if (kind === 'open' || kind === 'sealing' || kind === 'snapshot-sale' || kind === 'observing' || kind === 'awaiting-outcome') {
        pose = kind === 'open' ? 'seal' : 'idle';
        label = 'SEALED';
      } else if (kind === 'resolved') {
        if (revealed !== null) {
          pose = 'reveal';
          label = pctLabel(revealed);
        } else {
          label = revealWindowOver ? 'NO REVEAL · score 0' : 'NOT REVEALED YET';
        }
      } else if (kind === 'settled') {
        label = revealed !== null ? pctLabel(revealed) : 'NO REVEAL · score 0';
        pose = result === 'win' ? 'win' : result === 'lose' ? 'lose' : 'idle';
      } else if (kind === 'cancelled') {
        label = 'REFUNDED';
      }

      return {
        agentId,
        accountId: p.account_id,
        name: persona.name,
        color: persona.color,
        onColor: persona.onColor,
        initial: persona.initial,
        stake: p.stake,
        commitmentHash: p.commitment_hash,
        revealedBps: revealed,
        brier: scoresPublic ? p.brier : null,
        label,
        basePayout: kind === 'settled' ? base : null,
        feePayout: kind === 'settled' ? fee : null,
        net,
        result,
        pose,
      };
    })
    .sort((a, b) => rosterIndex(a.agentId) - rosterIndex(b.agentId) || (a.accountId < b.accountId ? -1 : 1));

  // Bench: roster agents that are not in this Round, with the reason we can
  // actually show from data.
  const inRound = new Set(actors.map((a) => a.accountId));
  const bench: BenchActor[] = [];
  for (const r of roster ?? []) {
    if (inRound.has(r.accountId)) continue;
    const persona = personaFor(r.agentId);
    let reason: string;
    if (!r.domains.includes(domain)) reason = 'domain not supported';
    else if (outOfCapital(r.accountId, input.economics, input.minStakeYocto)) reason = 'out of capital';
    else if (kind === 'open') reason = notOpenYet ? 'window not open yet' : 'not committed yet';
    else reason = 'abstained';
    bench.push({
      agentId: r.agentId,
      accountId: r.accountId,
      name: persona.name,
      color: persona.color,
      onColor: persona.onColor,
      initial: persona.initial,
      reason,
    });
  }
  bench.sort((a, b) => rosterIndex(a.agentId) - rosterIndex(b.agentId));

  const eligible = roster ? roster.filter((r) => r.domains.includes(domain)).length : null;
  const sealedN = comparisonMatches ? participants.length : q.participant_count;

  let banner: string;
  let subline: string | null = null;
  let localHour: number | null = null;
  switch (kind) {
    case 'open':
      // The contract reports OPEN from creation, but refuses commitments
      // before open_time: until then the window is only scheduled.
      if (notOpenYet) {
        banner = 'Scheduled — the commitment window has not opened yet';
        subline = `OPENS ${clockIn(msOf(q.open_time), timeZone)}`;
      } else {
        banner = 'Commitments open — forecasts are being sealed';
        subline = `CLOSES ${clockIn(msOf(q.close_time), timeZone)}`;
      }
      break;
    case 'sealing':
      banner = q.participant_count === 0 ? 'No commitments — this Round will be cancelled' : 'Commitments closed — freezing the swarm forecast';
      break;
    case 'snapshot-sale':
      banner = 'The swarm has spoken — read it before the event starts';
      subline = `ON SALE UNTIL ${clockIn(msOf(q.observation_start), timeZone)}`;
      break;
    case 'observing':
      banner = domain === 'price' ? 'Watching the candle' : `Watching the sky over ${city ?? 'the city'}`;
      subline = `OBSERVING UNTIL ${clockIn(msOf(q.observation_end), timeZone)}`;
      if (domain === 'weather') localHour = localHourIn(nowMs, timeZone);
      break;
    case 'awaiting-outcome':
      banner = 'Observation over — awaiting the resolver';
      subline = `RESOLVE BY ${clockIn(msOf(q.resolve_deadline), timeZone)}`;
      break;
    case 'resolved':
      banner = `Outcome: ${q.outcome === true ? 'YES' : q.outcome === false ? 'NO' : 'pending'} — reveals in progress`;
      subline = revealDeadlineMs !== null ? `REVEALS UNTIL ${clockIn(revealDeadlineMs, timeZone)}` : null;
      break;
    case 'settled':
      banner = `Settled — Outcome ${q.outcome === true ? 'YES' : q.outcome === false ? 'NO' : '—'}`;
      break;
    case 'cancelled':
      banner = q.participant_count === 0 ? 'Round cancelled — no commitments' : 'Round cancelled — stakes and fees refunded';
      break;
    default:
      banner = '';
  }

  return {
    kind,
    storyKey: `${q.question_id}:${kind}:${actors.length}:${actors.filter((a) => a.revealedBps !== null).length}`,
    questionId: q.question_id,
    domain,
    city,
    timeZone,
    banner,
    subline,
    sealed: kind === 'no-data' ? null : { n: sealedN, m: eligible },
    outcome: kind === 'resolved' || kind === 'settled' ? q.outcome : null,
    actors,
    bench,
    coins: kind === 'settled' ? coinFlows(actors) : [],
    localHour,
    noDataReason: null,
  };
}

function outOfCapital(
  accountId: string,
  economics: readonly AccountEconomics[] | null | undefined,
  minStakeYocto: string | null | undefined,
): boolean {
  if (!economics || !minStakeYocto) return false;
  const e = economics.find((x) => x.account_id === accountId);
  if (!e || e.available === null) return false;
  return BigInt(e.available) < BigInt(minStakeYocto);
}

/**
 * Coins for a SETTLED Round, all from real payouts: each loser's stake loss
 * is split across winners in proportion to their stake-pot gain (exact
 * integer shares, remainder to the largest gain), and each fee share flies
 * from the fee pool. Nothing is drawn when payouts are missing.
 */
export function coinFlows(actors: readonly SceneActor[]): CoinFlow[] {
  const rows = actors
    .filter((a) => a.basePayout !== null && a.feePayout !== null)
    .map((a) => ({ id: a.accountId, baseNet: BigInt(a.basePayout!) - BigInt(a.stake), fee: BigInt(a.feePayout!) }));
  const winners = rows.filter((r) => r.baseNet > 0n).sort((x, y) => (y.baseNet > x.baseNet ? 1 : y.baseNet < x.baseNet ? -1 : 0));
  const losers = rows.filter((r) => r.baseNet < 0n);
  const totalGain = winners.reduce((s, w) => s + w.baseNet, 0n);
  const out: CoinFlow[] = [];
  if (totalGain > 0n) {
    for (const l of losers) {
      const loss = -l.baseNet;
      let given = 0n;
      winners.forEach((w, i) => {
        const share = i === winners.length - 1 ? loss - given : (loss * w.baseNet) / totalGain;
        given += share;
        if (share > 0n) out.push({ from: l.id, to: w.id, amount: share.toString() });
      });
    }
  }
  for (const r of rows) if (r.fee > 0n) out.push({ from: 'fee-pool', to: r.id, amount: r.fee.toString() });
  return out;
}

/**
 * Default Round: a reveal in progress → the snapshot on sale → the most
 * recent settled Round → anything open → the newest Round at all.
 */
export function pickDefaultRound(questions: readonly QuestionView[], nowMs: number): QuestionView | null {
  const newest = [...questions].sort((a, b) => b.question_id - a.question_id);
  return (
    newest.find((q) => q.phase === 'resolved') ??
    newest.find((q) => q.phase === 'closed' && q.snapshot_ready && nowMs < msOf(q.observation_start)) ??
    newest.find((q) => q.phase === 'settled') ??
    newest.find((q) => q.phase === 'open' && nowMs >= msOf(q.open_time)) ??
    newest.find((q) => q.phase === 'open') ??
    newest[0] ??
    null
  );
}

/** Schedule board rows: upcoming (soonest first) and recent (newest first). */
export function scheduleBoard(
  questions: readonly QuestionView[],
  limit = 6,
): { upcoming: QuestionView[]; recent: QuestionView[] } {
  const upcoming = questions
    .filter((q) => q.phase === 'open' || q.phase === 'closed')
    .sort((a, b) => (BigInt(a.observation_start) < BigInt(b.observation_start) ? -1 : 1))
    .slice(0, limit);
  const recent = questions
    .filter((q) => q.phase === 'resolved' || q.phase === 'settled' || q.phase === 'cancelled')
    .sort((a, b) => b.question_id - a.question_id)
    .slice(0, limit);
  return { upcoming, recent };
}

/** The next milestone for the Round card countdown, or null once terminal. */
export function nextMilestone(q: QuestionView, nowMs: number): { label: string; ns: string } | null {
  switch (q.phase) {
    case 'open':
      if (nowMs < msOf(q.open_time)) return { label: 'Commitments open', ns: q.open_time };
      return { label: 'Commitments close', ns: q.close_time };
    case 'closed':
      if (nowMs < msOf(q.observation_start)) return { label: q.snapshot_ready ? 'Sales close · event starts' : 'Event starts', ns: q.observation_start };
      if (nowMs < msOf(q.observation_end)) return { label: 'Observation ends', ns: q.observation_end };
      return { label: 'Resolve deadline', ns: q.resolve_deadline };
    case 'resolved':
      return q.reveal_deadline ? { label: 'Reveal deadline', ns: q.reveal_deadline } : null;
    default:
      return null;
  }
}
