import { useState } from 'react';
import { usePolling } from '../lib/hooks';
import { api } from '../lib/api';
import type { ReplayReport, AgentSummary, DomainResult } from '../lib/types';
import { near, brier, domainLabel } from '../lib/format';
import { Stat, Panel, ErrorNote, EmptyState, Chip } from './ui';
import { BankrollChart, BrierBars } from './SimCharts';

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
      <Verdict d={domain === 'price' ? data.price : data.weather} />
      <BankrollChart d={domain === 'price' ? data.price : data.weather} />
      <BrierBars d={domain === 'price' ? data.price : data.weather} />
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
        <Stat label="Initial capital" value={`${report.config.initialCapitalNear} NEAR / agent`} />
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
      <p className="muted-line">
        Simulation is offline, deterministic, and separate from live testnet.{' '}
        {domain === 'weather' ? `Weather · ${report.config.weatherLocation ?? 'Open-Meteo IFS 9km'}` : domainLabel(domain)}. Gas/storage are
        excluded from simulated wagering economics. The LLM agent is live only and never part of this replay.
      </p>
    </div>
  );
}

/**
 * One honest sentence above the charts: does the paid (stake-weighted) swarm
 * forecast beat its best agent and the naive baselines? Computed, never forced.
 */
function Verdict({ d }: { d: DomainResult }) {
  const swarm = d.aggregates.find((a) => a.kind === 'stake-weighted');
  const scored = d.agents.filter((a) => a.brierMean !== null);
  const best = scored.slice().sort((a, b) => (a.brierMean ?? 1) - (b.brierMean ?? 1))[0];
  const bestBaseline = (d.baselines ?? []).slice().sort((a, b) => a.brierMean - b.brierMean)[0];
  if (!swarm || !best) return null;
  const beatsBest = swarm.brierMean < (best.brierMean ?? 1);
  const beatsBaseline = bestBaseline ? swarm.brierMean < bestBaseline.brierMean : null;
  const beaten = scored.filter((a) => swarm.brierMean < (a.brierMean ?? 1)).length;
  return (
    <div className="verdict rule-t rule-b">
      <p>
        The swarm forecast scored <b className="num">{swarm.brierMean.toFixed(3)}</b> and beat{' '}
        <b>{beaten} of {scored.length}</b> agents{beatsBest ? ', including the best one' : ''}.{' '}
        {!beatsBest ? (
          <>The best single agent, <b>{best.agentId}</b>, scored <b className="num">{(best.brierMean ?? 0).toFixed(3)}</b>. </>
        ) : null}
        {beatsBaseline === false && bestBaseline ? (
          <>
            A naive baseline ({bestBaseline.kind === 'constant-50' ? 'always 50%' : 'past YES rate'}) scored{' '}
            <b className="num">{bestBaseline.brierMean.toFixed(3)}</b>, better than the swarm: the agents here do not
            yet add information beyond it.
          </>
        ) : beatsBaseline ? (
          <>It also beat both naive baselines.</>
        ) : null}
      </p>
    </div>
  );
}

function isOutOfCapital(a: AgentSummary): boolean {
  // Stake is 1/10 of Available Balance; below 10x the 0.1 NEAR minimum it can no longer join a Round.
  return BigInt(a.finalBankroll) < 10n ** 24n;
}

function DomainTable({ d }: { d: DomainResult }) {
  return (
    <div>
      <div className="comparison-head">
        <Stat label="Rounds" value={String(d.totalRounds)} />
        <Stat label="With participants" value={String(d.roundsWithParticipants)} />
        <Stat label="Peak locked" value={`${near(d.peakLockedStake)} NEAR`} />
      </div>
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th className="num">Brier · lower is better</th>
            <th className="num">Rounds joined</th>
            <th className="num">Bankroll</th>
            <th className="num">Wagering P&amp;L</th>
            <th className="num">Fee income</th>
          </tr>
        </thead>
        <tbody>
          {d.agents
            .slice()
            .sort((a, b) => (a.brierMean ?? 1) - (b.brierMean ?? 1))
            .map((a) => (
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
        {isOutOfCapital(a) ? <Chip tone="bad">out of capital</Chip> : null}
        {a.roundsParticipated < a.roundsForecast ? (
          <Chip tone="muted">
            joined {a.roundsParticipated}/{a.roundsForecast}
          </Chip>
        ) : null}
      </td>
      <td className="num">{brier(a.brierMean)}</td>
      <td className="num">{a.roundsParticipated}</td>
      <td className="num">{near(a.finalBankroll)} NEAR</td>
      <td className={`num ${BigInt(a.wageringPnl) < 0n ? 'text-vermilion-700' : ''}`}>{near(a.wageringPnl)} NEAR</td>
      <td className="num">{near(a.feeIncome)} NEAR</td>
    </tr>
  );
}

function AggregateRows({ d }: { d: DomainResult }) {
  return (
    <div className="aggregate-rows">
      {d.aggregates.map((agg) => (
        <div key={`${d.domain}-${agg.kind}`} className="aggregate-row rule-t">
          <span className="small-caps">{agg.kind} aggregate</span>
          <span className="num">brier {agg.brierMean.toFixed(4)}</span>
          <span className="num">log-odds brier {agg.logOddsBrierMean.toFixed(4)} (clip {agg.logOddsClip})</span>
        </div>
      ))}
      <p className="muted-line">
        Log-odds is a labelled simulation comparison (weighted logit pool, inverse-logit, probabilities clipped to
        1%–99%), never the paid probability-space aggregate.
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
