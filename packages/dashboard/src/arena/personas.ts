/**
 * Arena characters. Names, mottos and main colours are presentation only.
 * `how` is a plain-language summary of the declared strategy in
 * packages/core/src/strategy.ts (STRATEGY_DESCRIPTIONS); supported domains
 * come from `/agents`.
 */
import { HIVE } from './palette';

export interface Persona {
  agentId: string;
  name: string;
  motto: string;
  /** One sentence on how the agent forecasts (its declared strategy). */
  how: string;
  /** Main colour (placeholder fill, chips). */
  color: string;
  /** Text colour that reads on `color`. */
  onColor: string;
  initial: string;
  liveOnly?: boolean;
}

const P = (agentId: string, name: string, motto: string, how: string, color: string, onColor: string, liveOnly = false): Persona => ({
  agentId,
  name,
  motto,
  how,
  color,
  onColor,
  initial: name.charAt(0).toUpperCase(),
  ...(liveOnly ? { liveOnly } : {}),
});

/** Roster order is also the pedestal order. */
export const PERSONAS: readonly Persona[] = [
  P('meteo', 'Nimbus', 'The model says…', "Turns the weather model's rain forecast into a probability.", HIVE.sky, HIVE.ink),
  P('climatology', 'Almanac', 'History repeats, mostly.', "Uses how often it rained over the last 365 days.", HIVE.leaf, HIVE.wax),
  P('persistence', 'Echo', 'Same as yesterday.', "Bets the last Outcome repeats (80% repeat, 20% flip).", HIVE.honey, HIVE.ink),
  P('momentum', 'Rush', 'Up begets up.', "Follows the 24-hour price trend (75% up, 25% down).", HIVE.cream, HIVE.ink),
  P('meanrev', 'Pendulum', 'What rises, settles.', "Bets the price drifts back to its 24-hour average.", HIVE.dusk, HIVE.wax),
  P('noisy-trend', 'Static', 'Trend, plus a little chaos.', "Follows the trend, then adds seeded random noise.", HIVE.ash, HIVE.ink),
  P('yolo', 'Yolo', 'All in. Every time.', "Always exactly 0% or 100%, picked by a seeded coin.", HIVE.amber, HIVE.ink),
  P('coinflip', 'Toss', 'Heads, I guess.', "A seeded random probability between 0% and 100%.", HIVE.rain, HIVE.wax),
  P('llm-news', 'Herald', "I read the news so you don't.", "An LLM reads crypto headlines and recent candles before the cutoff. Live price Rounds only.", HIVE.wax, HIVE.ink, true),
];

const BY_ID = new Map(PERSONAS.map((p) => [p.agentId, p]));

/** Persona for an agent id; an unknown id gets a neutral ash persona (never dropped). */
export function personaFor(agentId: string): Persona {
  return BY_ID.get(agentId) ?? P(agentId, agentId, '', '', HIVE.ash, HIVE.ink);
}

/** `<id>.<operator>` sub-account → agent id, using the roster when available. */
export function agentIdForAccount(accountId: string, roster: readonly { agentId: string; accountId: string }[] | null): string {
  const hit = roster?.find((r) => r.accountId === accountId);
  if (hit) return hit.agentId;
  const head = accountId.split('.')[0] ?? accountId;
  return BY_ID.has(head) ? head : accountId;
}

export function rosterIndex(agentId: string): number {
  const i = PERSONAS.findIndex((p) => p.agentId === agentId);
  return i === -1 ? PERSONAS.length : i;
}
