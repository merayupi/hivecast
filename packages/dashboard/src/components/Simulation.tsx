import { useState } from 'react';
import { usePolling } from '../lib/hooks';
import { api } from '../lib/api';
import type { ReplayReport, AgentSummary, DomainResult } from '../lib/types';
import { near, brier, domainLabel } from '../lib/format';
import { Stat, Panel, ErrorNote, EmptyState, Chip } from './ui';

/**
 * Offline simulation (real checksummed 60-day bundle, seed 42). Two separate
 * experiments (price / weather), honest cohorts/denominators, and a labelled
 * log-odds comparison — never presented as live chain activity.
 */
export function SimulationPanel() {
  const { data, error, loading } = usePolling(() => api.simulation(), 60_000, []);
  const [domain, setDomain] = useState<'price' | 'weather'>('price');

  if (loading) return <p className="muted-line">Loading simulation…</p>;
  if (error) return <ErrorNote message={error} />;
  if (!data) return <EmptyState title="No simulation" detail="The offline replay report is unavailable." />;

  return (
    <div className="simulation">
      <SimHead report={data} domain={domain} onDomain={setDomain} />
      <DomainTable d={domain === 'price' ? data.price : data.weather} />
      <Availability report={data} />
    </div>
  );
}

function SimHead({
  report,
  domain,
  onDomain,
}: {
  report: ReplayReport;
  domain: 'price' | 'weather';
  onDomain: (d: 'price' | 'weather') => void;
}) {
  return (
    <div>
      <div className="comparison-head">
        <Stat label="Seed" value={String(report.seed)} />
        <Stat label="Period" value={`${report.config.evalPeriod.start} → ${report.config.evalPeriod.end}`} />
        <Stat label="Initial capital" value={`${report.config.initialCapitalNear} Ⓝ / agent`} />
      </div>
      <div className="domain-tabs" role="tablist" aria-label="Simulation domain">
        <button
          type="button"
          role="tab"
          aria-selected={domain === 'price'}
          className={`btn ${domain === 'price' ? '' : 'btn-ghost'}`}
          onClick={() => onDomain('price')}
        >
          Price
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={domain === 'weather'}
          className={`btn ${domain === 'weather' ? '' : 'btn-ghost'}`}
          onClick={() => onDomain('weather')}
        >
          Weather
        </button>
      </div>
      <p className="muted-line small-caps">
        Simulation is offline, deterministic, and separate from live testnet. {domainLabel(domain)}. Gas/storage are
        excluded from simulated wagering economics.
      </p>
    </div>
  );
}

function DomainTable({ d }: { d: DomainResult }) {
  return (
    <div>
      <div className="comparison-head">
        <Stat label="Rounds" value={String(d.totalRounds)} />
        <Stat label="With participants" value={String(d.roundsWithParticipants)} />
        <Stat label="Peak locked" value={`${near(d.peakLockedStake)} Ⓝ`} />
      </div>
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th className="num">Brier</th>
            <th className="num">Rounds</th>
            <th className="num">Bankroll</th>
            <th className="num">Wagering P&amp;L</th>
            <th className="num">Fee income</th>
          </tr>
        </thead>
        <tbody>
          {d.agents.map((a) => (
            <AgentRow key={a.agentId} a={a} />
          ))}
        </tbody>
      </table>
      <AggregateRows d={d} />
    </div>
  );
}

function AgentRow({ a }: { a: AgentSummary }) {
  return (
    <tr>
      <td>
        <span className="num">{a.agentId}</span>{' '}
        <Chip tone={a.roundsParticipated === 0 ? 'muted' : 'ink'}>
          {a.roundsParticipated}/{a.roundsForecast} participated
        </Chip>
      </td>
      <td className="num">{brier(a.brierMean)}{a.brierRounds > 0 ? ` /${a.brierRounds}` : ''}</td>
      <td className="num">{a.roundsParticipated}</td>
      <td className="num">{near(a.finalBankroll)} Ⓝ</td>
      <td className={`num ${BigInt(a.wageringPnl) < 0n ? 'text-vermilion-700' : ''}`}>{near(a.wageringPnl)} Ⓝ</td>
      <td className="num">{near(a.feeIncome)} Ⓝ</td>
    </tr>
  );
}

function AggregateRows({ d }: { d: DomainResult }) {
  return (
    <div className="aggregate-rows">
      {d.aggregates.map((agg) => (
        <div key={`${d.domain}-${agg.kind}`} className="aggregate-row rule-t">
          <span className="small-caps">{agg.kind} aggregate</span>
          <span className="num">brier {agg.brierMean.toFixed(6)}</span>
          <span className="num">log-odds brier {agg.logOddsBrierMean.toFixed(6)} (clip {agg.logOddsClip})</span>
        </div>
      ))}
      <p className="muted-line small-caps">
        Log-odds is a labelled simulation comparison (weighted logit pool, inverse-logit, clipped at 0%/100%),
        never the paid probability-space aggregate.
      </p>
    </div>
  );
}

function Availability({ report }: { report: ReplayReport }) {
  return (
    <Panel title="Input availability">
      <ul className="availability-list">
        {report.availability.map((a) => (
          <li key={a.id} className="availability-row rule-b">
            <span className="num">{a.id}</span>
            <Chip tone={a.availability === 'proven' ? 'ok' : a.availability === 'inference' ? 'warn' : 'bad'}>
              {a.availability}
            </Chip>
            {a.availableAt ? <span className="muted-line num">available_at: {a.availableAt}</span> : null}
            <span className="muted-line">{a.note}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
