/**
 * Season Replay model (pure). Built only from the offline replay report's
 * sampled bankroll series (`report.<domain>.series`): x is bankroll on a
 * log scale, the leader is the richest agent at the sample, and an agent is
 * bankrupt once its bankroll can no longer fund the minimum stake
 * (stake = 1/10 of Available Balance, so bankroll < 10 × min stake).
 * Between samples only the drawn position is interpolated; every number
 * shown is a sampled value.
 */
import type { BankrollSeries } from '../lib/types';

const YOCTO_PER_MICRO = 10n ** 18n;

/** yoctoNEAR string → NEAR as a float, for plotting only (micro-NEAR precision). */
export function yoctoToNear(yocto: string): number {
  return Number(BigInt(yocto) / YOCTO_PER_MICRO) / 1e6;
}

export interface RaceModel {
  agents: string[];
  labels: string[];
  /** agent → bankroll per sample (NEAR floats, plotting only). */
  near: Record<string, number[]>;
  /** agent → bankroll per sample (exact yoctoNEAR strings). */
  yocto: Record<string, string[]>;
  /** log10 axis bounds (decades). */
  lo: number;
  hi: number;
  bankruptBelowYocto: bigint;
}

export function buildRace(series: BankrollSeries, minStakeNear: string): RaceModel {
  const agents = Object.keys(series.bankrolls);
  const near: Record<string, number[]> = {};
  let min = Infinity;
  let max = 0;
  for (const a of agents) {
    near[a] = series.bankrolls[a]!.map(yoctoToNear);
    for (const v of near[a]!) {
      if (v > 0) min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  const lo = Math.floor(Math.log10(Math.max(Number.isFinite(min) ? min : 0.1, 0.01)));
  const hi = Math.max(lo + 1, Math.ceil(Math.log10(Math.max(max, 1))));
  return {
    agents,
    labels: series.labels,
    near,
    yocto: series.bankrolls,
    lo,
    hi,
    bankruptBelowYocto: nearToYocto(minStakeNear) * 10n,
  };
}

/** Decimal NEAR string (e.g. "0.1") → yoctoNEAR, exactly. */
export function nearToYocto(n: string): bigint {
  const [whole = '0', frac = ''] = n.split('.');
  return BigInt(whole) * 10n ** 24n + BigInt((frac + '0'.repeat(24)).slice(0, 24) || '0');
}

export const sampleCount = (m: RaceModel) => m.labels.length;

/** Bankroll (NEAR float) at a fractional sample, interpolated in log space. */
export function bankrollAt(m: RaceModel, agent: string, t: number): number {
  const v = m.near[agent]!;
  const last = v.length - 1;
  const tt = Math.min(Math.max(t, 0), last);
  const i = Math.floor(tt);
  const f = tt - i;
  const a = v[i]!;
  const b = v[Math.min(i + 1, last)]!;
  if (f === 0 || a <= 0 || b <= 0) return f < 0.5 ? a : b;
  return Math.pow(10, Math.log10(a) + (Math.log10(b) - Math.log10(a)) * f);
}

/** x position (0..1) of a bankroll on the log axis. */
export function logX(m: RaceModel, nearValue: number): number {
  if (nearValue <= 0) return 0;
  const x = (Math.log10(nearValue) - m.lo) / (m.hi - m.lo);
  return Math.min(1, Math.max(0, x));
}

/** The richest agent at a sample (exact comparison; ties by agent id). */
export function leaderAt(m: RaceModel, sample: number): string | null {
  const i = Math.min(Math.max(Math.floor(sample), 0), m.labels.length - 1);
  let best: string | null = null;
  let bestV = -1n;
  for (const a of [...m.agents].sort()) {
    const v = BigInt(m.yocto[a]![i]!);
    if (v > bestV) [best, bestV] = [a, v];
  }
  return best;
}

export function isBankruptAt(m: RaceModel, agent: string, sample: number): boolean {
  const i = Math.min(Math.max(Math.floor(sample), 0), m.labels.length - 1);
  return BigInt(m.yocto[agent]![i]!) < m.bankruptBelowYocto;
}

/** Playback: 1× = 4 sampled rounds per second. */
export const SAMPLES_PER_SECOND = 4;
export type Speed = 1 | 4 | 16;

export function advance(t: number, dtMs: number, speed: Speed, last: number): { t: number; ended: boolean } {
  const next = t + (dtMs / 1000) * SAMPLES_PER_SECOND * speed;
  return next >= last ? { t: last, ended: true } : { t: next, ended: false };
}

/** Human label of a sample ("start", an hour, or a day). */
export function sampleLabel(label: string): string {
  if (label === 'start') return 'start';
  return label.length > 10 ? `${label.slice(0, 10)} ${label.slice(11, 16)} UTC` : label;
}
