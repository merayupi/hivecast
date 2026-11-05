/**
 * Deterministic offline replay engine.
 *
 * Runs two independent experiments (price and weather) with separate capital,
 * evaluates the six relevant strategies per domain, sizes stakes as
 * floor(10% of Available Balance), skips below the minimum Stake, resolves each
 * Round against the bundled Outcome, and settles exactly with the shared
 * accounting module. No network, no keys, no LLM.
 */

import {
  settle,
  STRATEGY_DOMAINS,
  AGENT_IDS,
  ONE_NEAR,
  MIN_STAKE,
  QUERY_FEE,
  compareDecimalStrings,
  formatScaled,
} from '@hivecast/core';
import type {
  AgentId,
  Domain,
  Candle,
  PriceInputs,
  WeatherInputs,
  StrategyContext,
} from '@hivecast/core';
import { getStrategy } from '@hivecast/core';
import type { Bundle } from './bundle.js';

export const DEFAULT_SEED = 42;
export const INITIAL_CAPITAL = 100n * ONE_NEAR; // 100 NEAR
export const STAKE_FLOOR_DENOM = 10n; // 10% of Available Balance

export interface ReplayConfig {
  seed: number;
  initialCapital: bigint;
  stakeFloorDenom: bigint;
  minStake: bigint;
  queryFee: bigint;
}

export function defaultConfig(seed = DEFAULT_SEED): ReplayConfig {
  return {
    seed,
    initialCapital: INITIAL_CAPITAL,
    stakeFloorDenom: STAKE_FLOOR_DENOM,
    minStake: MIN_STAKE,
    queryFee: QUERY_FEE,
  };
}

interface RoundSpec {
  domain: Domain;
  roundKey: string;
  targetTime: string;
  cutoffMs: number;
  outcome: 0 | 10_000; // bps
  inputs: PriceInputs | WeatherInputs;
}

export interface AgentRoundRecord {
  roundKey: string;
  probabilityBps: number;
  stake: string; // decimal yoctoNEAR
  basePayout: string;
  feePayout: string;
  outcome: 0 | 10_000;
  brier: number; // (p - o)^2 with p in [0,1]
}

export interface AgentSummary {
  agentId: AgentId;
  domain: Domain;
  roundsForecast: number;
  roundsParticipated: number;
  roundsAbstained: number;
  roundsSkippedBelowMin: number;
  finalBankroll: string; // decimal yoctoNEAR
  totalStaked: string;
  wageringPnl: string; // basePayout - stake, summed
  feeIncome: string;
  brierMean: number | null;
  brierRounds: number;
}

export interface AggregateSummary {
  domain: Domain;
  kind: 'equal-weight' | 'stake-weighted';
  rounds: number;
  brierMean: number;
  logOddsBrierMean: number;
  logOddsClip: string;
}

export interface DomainResult {
  domain: Domain;
  seed: number;
  totalRounds: number;
  roundsWithParticipants: number;
  initialCapital: string;
  peakLockedStake: string;
  agents: AgentSummary[];
  aggregates: AggregateSummary[];
  participants: AgentId[];
}

export interface ReplayReport {
  seed: number;
  config: {
    initialCapitalNear: string;
    stakeFloor: string;
    minStakeNear: string;
    queryFeeNear: string;
    evalPeriod: { start: string; end: string };
    priceRounds: number;
    weatherRounds: number;
  };
  availability: Array<{ id: string; availability: string; availableAt: string | null; note: string }>;
  price: DomainResult;
  weather: DomainResult;
}

// ---------------------------------------------------------------------------
// Round construction
// ---------------------------------------------------------------------------

const HOUR_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;
const PRICE_CUTOFF_LEAD_MS = 5 * MIN_MS;

function priceRounds(bundle: Bundle): RoundSpec[] {
  const { candles, evalStart, evalEnd } = bundle.price;
  const evalStartMs = Date.parse(`${evalStart}T00:00:00Z`);
  const evalEndMs = Date.parse(`${evalEnd}T23:00:00Z`);
  const byOpen = new Map<string, Candle>();
  for (const c of candles) byOpen.set(c.openTime, c);

  const rounds: RoundSpec[] = [];
  for (let h = evalStartMs; h <= evalEndMs; h += HOUR_MS) {
    const cutoffMs = h - PRICE_CUTOFF_LEAD_MS;
    const target = new Date(h).toISOString();
    const roundKey = `price:${target}`;
    const available: Candle[] = [];
    for (const c of candles) {
      if (Number(c.closeTime) < cutoffMs) available.push(c);
    }
    const targetCandle = byOpen.get(String(h));
    if (!targetCandle) {
      throw new Error(`missing target candle for ${target}`);
    }
    const outcome: 0 | 10_000 = compareDecimalStrings(targetCandle.close, targetCandle.open) > 0 ? 10_000 : 0;
    rounds.push({
      domain: 'price',
      roundKey,
      targetTime: target,
      cutoffMs,
      outcome,
      inputs: { kind: 'price', candles: available },
    });
  }
  return rounds;
}

function weatherRounds(bundle: Bundle): RoundSpec[] {
  const { daily, forecasts } = bundle.weather;
  const evalDates = daily.time.slice(-60);
  const precipByDate = new Map<string, number>();
  daily.time.forEach((t, i) => precipByDate.set(t, daily.precipitation_sum[i]!));

  const rounds: RoundSpec[] = [];
  for (const d of evalDates) {
    const roundKey = `weather:${d}`;
    // Observation start = D 00:00 WIB = D-1 17:00 UTC. Cutoff = start - 5 min.
    const obsStartMs = Date.parse(`${d}T00:00:00Z`) - 24 * HOUR_MS + 17 * HOUR_MS;
    const cutoffMs = obsStartMs - 5 * MIN_MS;
    const history: string[] = [];
    for (const t of daily.time) {
      if (t < d) history.push(String(precipByDate.get(t)));
    }
    const forecast = forecasts[d];
    const forecastPrecipMm = forecast ? String(forecast.precipMm) : null;
    const precip = precipByDate.get(d);
    if (precip === undefined) throw new Error(`missing precipitation outcome for ${d}`);
    const outcome: 0 | 10_000 = precip >= 1.0 ? 10_000 : 0;
    rounds.push({
      domain: 'weather',
      roundKey,
      targetTime: d,
      cutoffMs,
      outcome,
      inputs: { kind: 'weather', forecastPrecipMm, historyPrecipMm: history },
    });
  }
  return rounds;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function brierFloat(probabilityBps: number, outcome: 0 | 10_000): number {
  const p = probabilityBps / 10_000;
  const o = outcome / 10_000;
  const d = p - o;
  return d * d;
}

function clampProbability(p: number): number {
  return Math.max(1e-9, Math.min(1 - 1e-9, p));
}

function logOdds(p: number): number {
  return Math.log(clampProbability(p) / (1 - clampProbability(p)));
}

function replayDomain(domain: Domain, rounds: RoundSpec[], config: ReplayConfig): DomainResult {
  const participants: AgentId[] = (AGENT_IDS as readonly AgentId[]).filter((a) =>
    STRATEGY_DOMAINS[a].includes(domain),
  );

  const bankroll = new Map<AgentId, bigint>();
  for (const a of participants) bankroll.set(a, config.initialCapital);

  const summary = new Map<AgentId, AgentSummary>();
  for (const a of participants) {
    summary.set(a, {
      agentId: a,
      domain,
      roundsForecast: 0,
      roundsParticipated: 0,
      roundsAbstained: 0,
      roundsSkippedBelowMin: 0,
      finalBankroll: '0',
      totalStaked: '0',
      wageringPnl: '0',
      feeIncome: '0',
      brierMean: null,
      brierRounds: 0,
    });
  }

  // Per-agent running totals (kept as bigint, stringified at the end).
  const totalStaked = new Map<AgentId, bigint>();
  const wageringPnl = new Map<AgentId, bigint>();
  const feeIncome = new Map<AgentId, bigint>();
  const brierSum = new Map<AgentId, number>();
  const brierCount = new Map<AgentId, number>();
  for (const a of participants) {
    totalStaked.set(a, 0n);
    wageringPnl.set(a, 0n);
    feeIncome.set(a, 0n);
    brierSum.set(a, 0);
    brierCount.set(a, 0);
  }

  // Aggregates per round.
  const aggRounds: Array<{ eqBrier: number; swBrier: number; eqLo: number; swLo: number }> = [];
  let roundsWithParticipants = 0;
  let peakLocked = 0n;

  for (const round of rounds) {
    const roundParticipants: Array<{
      accountId: AgentId;
      stake: bigint;
      probabilityBps: number;
      isValidRevealer: boolean;
    }> = [];

    const forecastsThisRound: Array<{ agentId: AgentId; probabilityBps: number }> = [];

    for (const agent of participants) {
      const ctx: StrategyContext = {
        agentId: agent,
        domain,
        targetTime: round.targetTime,
        roundKey: round.roundKey,
        inputs: round.inputs,
        seed: config.seed,
      };
      const result = getStrategy(agent)(ctx);
      const s = summary.get(agent)!;
      if (result.kind === 'abstain') {
        s.roundsAbstained += 1;
        continue;
      }
      s.roundsForecast += 1;
      const available = bankroll.get(agent)!;
      const stake = available / config.stakeFloorDenom; // floor(10%)
      if (stake < config.minStake) {
        s.roundsSkippedBelowMin += 1;
        continue;
      }
      s.roundsParticipated += 1;
      forecastsThisRound.push({ agentId: agent, probabilityBps: result.probabilityBps });
      roundParticipants.push({
        accountId: agent,
        stake,
        probabilityBps: result.probabilityBps,
        isValidRevealer: true, // algorithmic replay: every committed agent reveals
      });
    }

    const settlement = settle(roundParticipants, round.outcome, config.queryFee);

    for (const row of settlement.rows) {
      const agent = row.accountId as AgentId;
      const stake = row.stake;
      const base = row.basePayout;
      const fee = row.feePayout;
      const net = base - stake + fee;
      bankroll.set(agent, (bankroll.get(agent) ?? 0n) + net);
      totalStaked.set(agent, (totalStaked.get(agent) ?? 0n) + stake);
      wageringPnl.set(agent, (wageringPnl.get(agent) ?? 0n) + (base - stake));
      feeIncome.set(agent, (feeIncome.get(agent) ?? 0n) + fee);
      const probBps = roundParticipants.find((p) => p.accountId === agent)!.probabilityBps;
      brierSum.set(agent, (brierSum.get(agent) ?? 0) + brierFloat(probBps, round.outcome));
      brierCount.set(agent, (brierCount.get(agent) ?? 0) + 1);
    }

    if (roundParticipants.length > 0) {
      roundsWithParticipants += 1;
      const roundStake = roundParticipants.reduce((a, p) => a + p.stake, 0n);
      if (roundStake > peakLocked) peakLocked = roundStake;
      const probs = forecastsThisRound.map((f) => f.probabilityBps / 10_000);
      const eq = probs.reduce((a, b) => a + b, 0) / probs.length;
      const totalStake = roundParticipants.reduce((a, p) => a + p.stake, 0n);
      const swNum = roundParticipants.reduce((a, p) => a + p.stake * BigInt(p.probabilityBps), 0n);
      const sw = Number(swNum) / Number(totalStake) / 10_000;
      const o = round.outcome / 10_000;
      aggRounds.push({
        eqBrier: (eq - o) * (eq - o),
        swBrier: (sw - o) * (sw - o),
        eqLo: (logOdds(eq) - logOdds(o)) ** 2,
        swLo: (logOdds(sw) - logOdds(o)) ** 2,
      });
    }
  }

  // Finalize summaries.
  for (const a of participants) {
    const s = summary.get(a)!;
    s.finalBankroll = bankroll.get(a)!.toString();
    s.totalStaked = totalStaked.get(a)!.toString();
    s.wageringPnl = wageringPnl.get(a)!.toString();
    s.feeIncome = feeIncome.get(a)!.toString();
    s.brierRounds = brierCount.get(a)!;
    s.brierMean = s.brierRounds > 0 ? brierSum.get(a)! / s.brierRounds : null;
  }

  const aggregates: AggregateSummary[] = [];
  if (aggRounds.length > 0) {
    const n = aggRounds.length;
    const eqMean = aggRounds.reduce((a, r) => a + r.eqBrier, 0) / n;
    const swMean = aggRounds.reduce((a, r) => a + r.swBrier, 0) / n;
    const eqLoMean = aggRounds.reduce((a, r) => a + r.eqLo, 0) / n;
    const swLoMean = aggRounds.reduce((a, r) => a + r.swLo, 0) / n;
    aggregates.push(
      { domain, kind: 'equal-weight', rounds: n, brierMean: eqMean, logOddsBrierMean: eqLoMean, logOddsClip: '[1e-9, 1-1e-9]' },
      { domain, kind: 'stake-weighted', rounds: n, brierMean: swMean, logOddsBrierMean: swLoMean, logOddsClip: '[1e-9, 1-1e-9]' },
    );
  }

  return {
    domain,
    seed: config.seed,
    totalRounds: rounds.length,
    roundsWithParticipants,
    initialCapital: config.initialCapital.toString(),
    peakLockedStake: peakLocked.toString(),
    agents: [...summary.values()],
    aggregates,
    participants,
  };
}

export function runReplay(bundle: Bundle, config: ReplayConfig): ReplayReport {
  const priceRoundsList = priceRounds(bundle);
  const weatherRoundsList = weatherRounds(bundle);

  const price = replayDomain('price', priceRoundsList, config);
  const weather = replayDomain('weather', weatherRoundsList, config);

  return {
    seed: config.seed,
    config: {
      initialCapitalNear: formatScaled(config.initialCapital, 24),
      stakeFloor: `1/${config.stakeFloorDenom.toString()}`,
      minStakeNear: formatScaled(config.minStake, 24),
      queryFeeNear: formatScaled(config.queryFee, 24),
      evalPeriod: { start: bundle.manifest.evalPeriod.start, end: bundle.manifest.evalPeriod.end },
      priceRounds: priceRoundsList.length,
      weatherRounds: weatherRoundsList.length,
    },
    availability: bundle.manifest.sources.map((s) => ({
      id: s.id,
      availability: s.availability,
      availableAt: s.availableAt,
      note: s.note,
    })),
    price,
    weather,
  };
}
