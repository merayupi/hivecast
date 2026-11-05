/**
 * Report rendering: deterministic terminal tables and JSON summary.
 */

import { ONE_NEAR } from '@hivecast/core';
import type { ReplayReport, DomainResult, AgentSummary } from './replay.js';

export function formatNear(yocto: string): string {
  const v = BigInt(yocto);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / ONE_NEAR;
  const frac = abs % ONE_NEAR;
  const frac6 = (frac * 1_000_000n) / ONE_NEAR;
  const body = `${whole}.${frac6.toString().padStart(6, '0')}`;
  return neg ? `-${body}` : body;
}

function pad(s: string, w: number): string {
  return (s + ' '.repeat(Math.max(0, w - s.length))) + ' ';
}

function padL(s: string, w: number): string {
  return ' '.repeat(Math.max(0, w - s.length)) + s + ' ';
}

function agentRow(a: AgentSummary): string {
  const brier = a.brierMean === null ? 'n/a' : `${a.brierMean.toFixed(4)}/${a.brierRounds}`;
  return (
    pad(a.agentId, 12) +
    padL(String(a.roundsForecast), 10) +
    padL(String(a.roundsParticipated), 13) +
    padL(String(a.roundsAbstained), 11) +
    padL(brier, 15) +
    padL(formatNear(a.finalBankroll), 14) +
    padL(formatNear(a.totalStaked), 12) +
    padL(formatNear(a.wageringPnl), 12) +
    padL(formatNear(a.feeIncome), 12)
  );
}

function domainTable(header: string, d: DomainResult): string {
  const lines: string[] = [];
  lines.push(`== ${header} ==`);
  lines.push(`rounds: ${d.totalRounds}  with participants: ${d.roundsWithParticipants}  peak locked: ${formatNear(d.peakLockedStake)} NEAR`);
  lines.push('');
  lines.push(
    pad('agent', 12) +
      padL('forecast', 10) +
      padL('participated', 13) +
      padL('abstained', 11) +
      padL('brier/n', 15) +
      padL('bankroll', 14) +
      padL('staked', 12) +
      padL('wagP&L', 12) +
      padL('fees', 12),
  );
  lines.push('-'.repeat(111));
  for (const a of d.agents) lines.push(agentRow(a));
  lines.push('-'.repeat(111));
  for (const agg of d.aggregates) {
    lines.push(
      `${agg.kind.padEnd(14)} brier=${agg.brierMean.toFixed(6)}  log-odds-brier=${agg.logOddsBrierMean.toFixed(6)} (clip ${agg.logOddsClip})`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function renderTable(report: ReplayReport): string {
  const lines: string[] = [];
  lines.push(`HiveCast offline replay — seed ${report.seed}`);
  lines.push(`eval period ${report.config.evalPeriod.start}..${report.config.evalPeriod.end}`);
  lines.push(`initial capital ${report.config.initialCapitalNear} NEAR / agent, stake floor ${report.config.stakeFloor} of Available Balance, min stake ${report.config.minStakeNear} NEAR, query fee ${report.config.queryFeeNear} NEAR`);
  lines.push('');
  lines.push(domainTable('PRICE (Binance NEARUSDT 1h)', report.price));
  lines.push(domainTable('WEATHER (Kudus IFS precipitation)', report.weather));
  lines.push('== INPUT AVAILABILITY DISCLOSURE ==');
  for (const a of report.availability) {
    lines.push(`- [${a.availability}] ${a.id}${a.availableAt ? ` (available_at: ${a.availableAt})` : ''}`);
  }
  lines.push('');
  lines.push('log-odds comparison is a labelled simulation metric with probability clipped to [1e-9, 1-1e-9]; it is not the paid probability-space aggregate.');
  return lines.join('\n');
}

export function toJson(report: ReplayReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}
