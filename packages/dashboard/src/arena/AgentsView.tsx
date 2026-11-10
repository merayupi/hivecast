import { api } from '../lib/api';
import { usePolling } from '../lib/hooks';
import { brier as fmtBrier, explorerAccountUrl, near } from '../lib/format';
import type { PublicConfig } from '../lib/types';
import { LeaderboardPanel, EconomicsPanel } from '../components/Analytics';
import { AgentsPanel, AgentRoleNote } from '../components/Disclosure';
import { personaFor, rosterIndex } from './personas';
import { AgentPortrait } from './Tour';

/**
 * AGENTS: one card per agent in the runner's roster (`/agents`), with its
 * live record from the leaderboard and economics reports. The full tables
 * stay available below, closed by default.
 */
export function AgentsView({ config }: { config: PublicConfig | null }) {
  const roster = usePolling(() => api.agents(), 60_000, []);
  const leaderboard = usePolling(() => api.leaderboard(), 30_000, []);
  const economics = usePolling(() => api.economics(), 30_000, []);
  const networkId = config?.networkId ?? 'testnet';
  const minStake = config?.minStakeYocto ?? null;

  const agents = [...(roster.data ?? [])].sort((a, b) => rosterIndex(a.agentId) - rosterIndex(b.agentId));
  // Rank by live Brier error among agents that have a score (lower is better).
  const ranked = (leaderboard.data?.entries ?? [])
    .filter((e) => e.brier_mean !== null)
    .sort((a, b) => (a.brier_mean ?? 1) - (b.brier_mean ?? 1))
    .map((e) => e.account_id);

  return (
    <>
      <div className="arena agents-page">
        <header className="page-head">
          <span className="env-chip env-live">LIVE · NEAR {networkId.toUpperCase()}</span>
          <h2 className="px page-title">The swarm</h2>
          <p className="page-lead">
            Each agent is its own NEAR account with its own bankroll and one fixed strategy. They only join Rounds in a domain
            they support. Lower error is better: an agent that always says 50% scores 0.250.
          </p>
        </header>
        {roster.data === null ? (
          <p className="no-data">{roster.loading ? 'Loading the roster…' : `NO DATA YET — ${roster.error ?? 'roster unavailable'}`}</p>
        ) : agents.length === 0 ? (
          <p className="no-data">NO DATA YET — the runner reports no agents.</p>
        ) : (
          <ul className="agent-grid">
            {agents.map((a) => {
              const persona = personaFor(a.agentId);
              const entry = leaderboard.data?.entries.find((e) => e.account_id === a.accountId) ?? null;
              const econ = economics.data?.accounts.find((e) => e.account_id === a.accountId) ?? null;
              const rank = ranked.indexOf(a.accountId);
              const broke = econ?.available != null && minStake !== null && BigInt(econ.available) < BigInt(minStake);
              return (
                <li key={a.agentId} className="hive-panel agent-card">
                  <div className="agent-card-head">
                    <AgentPortrait agentId={a.agentId} name={persona.name} />
                    <div className="agent-id">
                      <h3 className="px agent-name">
                        {persona.name}
                        {rank >= 0 ? <span className="agent-rank num"> #{rank + 1}</span> : null}
                      </h3>
                      <a className="num agent-account" href={explorerAccountUrl(networkId, a.accountId)} target="_blank" rel="noreferrer" title={a.accountId}>
                        {a.agentId} ↗
                      </a>
                      <div className="agent-chips">
                        {a.domains.map((d) => (
                          <span key={d} className={`domain-chip domain-${d}`}>
                            {d}
                          </span>
                        ))}
                        {a.liveOnly ? <span className="domain-chip">LLM · live only</span> : null}
                      </div>
                    </div>
                  </div>
                  {persona.motto ? <p className="agent-motto">&ldquo;{persona.motto}&rdquo;</p> : null}
                  {persona.how ? <p className="agent-how">{persona.how}</p> : null}
                  <dl className="agent-stats">
                    <div>
                      <dt>Error (Brier)</dt>
                      <dd className="num">{entry ? fmtBrier(entry.brier_mean) : '—'}</dd>
                    </div>
                    <div>
                      <dt>Rounds joined</dt>
                      <dd className="num">{entry ? entry.rounds_participated : '—'}</dd>
                    </div>
                    <div>
                      <dt>Bankroll</dt>
                      <dd className="num">{econ?.bankroll ? `${near(econ.bankroll, 3)} NEAR` : '—'}</dd>
                    </div>
                  </dl>
                  {broke ? <p className="loss agent-broke">☠ Out of capital: available balance is below the minimum stake.</p> : null}
                </li>
              );
            })}
          </ul>
        )}
        <p className="fine">
          Names, portraits and mottos are presentation. Strategies are declared in code and fixed before any Round; error, Rounds
          and bankroll come from the runner&rsquo;s live reports. &ldquo;—&rdquo; means the runner has not reported that value
          {economics.data?.coverage === 'partial' ? ' (bankroll is hidden while coverage is partial)' : ''}.
        </p>
      </div>
      <div className="ledger-sheet">
        <main className="shell-main sheet-pad">
          <details className="fold">
            <summary className="ledger-heading">Full leaderboard</summary>
            <LeaderboardPanel />
          </details>
          <details className="fold">
            <summary className="ledger-heading">Agent economics (bankroll, P&amp;L, fees, gas)</summary>
            <EconomicsPanel />
          </details>
          <details className="fold">
            <summary className="ledger-heading">Accounts and roles</summary>
            <AgentRoleNote />
            <AgentsPanel />
          </details>
        </main>
      </div>
    </>
  );
}
