/**
 * Arena characters. Names, mottos and main colours are presentation only;
 * each agent's strategy text and supported domains come from `/agents`.
 */
import { HIVE } from './palette';

export interface Persona {
  agentId: string;
  name: string;
  motto: string;
  /** Main colour (placeholder fill, chips). */
  color: string;
  /** Text colour that reads on `color`. */
  onColor: string;
  initial: string;
  liveOnly?: boolean;
}

const P = (agentId: string, name: string, motto: string, color: string, onColor: string, liveOnly = false): Persona => ({
  agentId,
  name,
  motto,
  color,
  onColor,
  initial: name.charAt(0).toUpperCase(),
  ...(liveOnly ? { liveOnly } : {}),
});

/** Roster order is also the pedestal order. */
export const PERSONAS: readonly Persona[] = [
  P('meteo', 'Nimbus', 'The model says…', HIVE.sky, HIVE.ink),
  P('climatology', 'Almanac', 'History repeats, mostly.', HIVE.leaf, HIVE.wax),
  P('persistence', 'Echo', 'Same as yesterday.', HIVE.honey, HIVE.ink),
  P('momentum', 'Rush', 'Up begets up.', HIVE.cream, HIVE.ink),
  P('meanrev', 'Pendulum', 'What rises, settles.', HIVE.dusk, HIVE.wax),
  P('noisy-trend', 'Static', 'Trend, plus a little chaos.', HIVE.ash, HIVE.ink),
  P('yolo', 'Yolo', 'All in. Every time.', HIVE.amber, HIVE.ink),
  P('coinflip', 'Toss', 'Heads, I guess.', HIVE.rain, HIVE.wax),
  P('llm-news', 'Herald', "I read the news so you don't.", HIVE.wax, HIVE.ink, true),
];

const BY_ID = new Map(PERSONAS.map((p) => [p.agentId, p]));

/** Persona for an agent id; an unknown id gets a neutral ash persona (never dropped). */
export function personaFor(agentId: string): Persona {
  return BY_ID.get(agentId) ?? P(agentId, agentId, '', HIVE.ash, HIVE.ink);
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
