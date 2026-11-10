/**
 * Plain-language guidance for a visitor: where a Round is in its five steps,
 * what is happening now, what the visitor can do, and when the next forecast
 * sale is. Pure: everything is derived from the Round's on-chain schedule and
 * phase, never invented.
 */

import type { QuestionView } from '../lib/types';
import { near, sourceTimeZone } from '../lib/format';
import { clockIn, type SceneKind } from './scene';

const NS_PER_MS = 1_000_000n;
const msOf = (ns: string): number => Number(BigInt(ns) / NS_PER_MS);

export type StepState = 'done' | 'current' | 'upcoming' | 'skipped';

export interface RoundStep {
  id: 'commit' | 'sale' | 'event' | 'reveal' | 'settle';
  label: string;
  hint: string;
  state: StepState;
}

export interface RoundGuide {
  steps: RoundStep[];
  /** What is happening in this Round right now. */
  now: string;
  /** What the visitor can do about it (null when there is nothing to do). */
  action: string | null;
  /** True while the swarm forecast of this Round can be bought. */
  canBuy: boolean;
}

const STEP_DEFS: ReadonlyArray<Pick<RoundStep, 'id' | 'label' | 'hint'>> = [
  { id: 'commit', label: 'Commit', hint: 'Agents stake NEAR on a sealed forecast. Only a hash goes on chain.' },
  { id: 'sale', label: 'Forecast on sale', hint: 'The stake-weighted forecast is frozen and sold until the event starts.' },
  { id: 'event', label: 'Event', hint: 'The real-world event is observed. Nothing can change now.' },
  { id: 'reveal', label: 'Reveal', hint: 'The Outcome is recorded; agents open their forecasts and are scored.' },
  { id: 'settle', label: 'Payout', hint: 'Accurate agents take stake from inaccurate ones.' },
];

/** Index of the step in progress; -1 = nothing started, 5 = everything done. */
function currentIndex(kind: SceneKind, q: QuestionView, nowMs: number): number {
  switch (kind) {
    case 'open':
      return nowMs < msOf(q.open_time) ? -1 : 0;
    case 'sealing':
    case 'snapshot-sale':
      return 1;
    case 'observing':
      return 2;
    case 'awaiting-outcome':
    case 'resolved':
      return 3;
    case 'settled':
      return 5;
    default:
      return -1;
  }
}

/** The five steps of a Round and the plain-language "now / you can" lines. */
export function roundGuide(q: QuestionView, kind: SceneKind, nowMs: number): RoundGuide {
  const tz = sourceTimeZone(q.source);
  const at = (ns: string) => clockIn(msOf(ns), tz);
  const cancelled = kind === 'cancelled';
  // GLOSSARY: a Round with one participant is a Single-agent Forecast, never a swarm forecast.
  const forecast = q.participant_count === 1 ? 'Single-agent Forecast' : 'swarm forecast';
  const cur = currentIndex(kind, q, nowMs);
  const steps: RoundStep[] = STEP_DEFS.map((d, i) => ({
    ...d,
    state: cancelled ? 'skipped' : i < cur ? 'done' : i === cur ? 'current' : 'upcoming',
  }));

  let now: string;
  let action: string | null = null;
  let canBuy = false;
  switch (kind) {
    case 'open':
      if (nowMs < msOf(q.open_time)) {
        now = `This Round is scheduled. Agents can start sealing forecasts at ${at(q.open_time)}.`;
        action = `Nothing to do yet. The forecast goes on sale after commitments close at ${at(q.close_time)}.`;
      } else {
        now = `Agents are sealing their forecasts until ${at(q.close_time)}. Only hashes are on chain, so nobody can read them yet.`;
        action = `Wait for ${at(q.close_time)}: then the forecast is frozen and goes on sale.`;
      }
      break;
    case 'sealing':
      if (q.participant_count === 0) {
        now = 'Commitments are closed and no agent joined, so this Round will be cancelled.';
      } else {
        now = `Commitments are closed. The ${forecast} is being frozen.`;
        action = `It goes on sale as soon as the snapshot is ready, until the event starts at ${at(q.observation_start)}.`;
      }
      break;
    case 'snapshot-sale':
      now = `The ${forecast} is on sale until the event starts at ${at(q.observation_start)}.`;
      action = `Buy it for ${near(q.access_price)} NEAR to read the forecast before the event happens.`;
      canBuy = true;
      break;
    case 'observing':
      now = `Sales are closed. The event is being observed until ${at(q.observation_end)}.`;
      action = 'Watch: the Outcome and every forecast become public after the event.';
      break;
    case 'awaiting-outcome':
      now = 'The event is over. Waiting for the Outcome to be recorded on chain.';
      break;
    case 'resolved':
      now = 'The Outcome is on chain. Agents are opening their sealed forecasts and getting scored.';
      action = 'Compare each revealed forecast with the Outcome below.';
      break;
    case 'settled':
      now = 'This Round is finished. Every forecast, score and payout is public.';
      action = 'See who gained and who lost stake in the table below.';
      break;
    case 'cancelled':
      now = q.participant_count === 0 ? 'This Round was cancelled: no agent committed a forecast.' : 'This Round was cancelled. Stakes and fees were refunded.';
      break;
    default:
      now = 'No Round to show yet.';
  }
  return { steps, now, action, canBuy };
}

export type NextSale =
  | { state: 'on-sale'; question: QuestionView; untilNs: string }
  | { state: 'upcoming'; question: QuestionView; fromNs: string; untilNs: string };

/**
 * The forecast sale a visitor should know about: a Round on sale right now,
 * else the Round whose commitments close soonest (its sale follows). Uses only
 * the on-chain schedule; null when no Round can still be sold.
 */
export function nextSale(questions: readonly QuestionView[], nowMs: number): NextSale | null {
  const live = questions.filter(
    (q) => (q.phase === 'open' || q.phase === 'closed') && nowMs < msOf(q.observation_start),
  );
  const onSale = live
    .filter((q) => q.phase === 'closed' && q.snapshot_ready)
    .sort((a, b) => msOf(a.observation_start) - msOf(b.observation_start))[0];
  if (onSale) return { state: 'on-sale', question: onSale, untilNs: onSale.observation_start };
  const upcoming = live
    .filter((q) => q.phase === 'open')
    .sort((a, b) => msOf(a.close_time) - msOf(b.close_time))[0];
  if (upcoming) return { state: 'upcoming', question: upcoming, fromNs: upcoming.close_time, untilNs: upcoming.observation_start };
  return null;
}
