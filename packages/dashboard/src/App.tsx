import { useState } from 'react';
import { Shell } from './components/Shell';
import { QuestionList } from './components/QuestionList';
import { QuestionDetail } from './components/QuestionDetail';
import { BalancePanel } from './components/BalancePanel';
import { ComparisonPanel, LeaderboardPanel } from './components/Analytics';
import { SimulationPanel } from './components/Simulation';
import { AgentsPanel, DisclosurePanel, AgentRoleNote } from './components/Disclosure';
import { useWallet } from './lib/useWallet';
import { usePolling } from './lib/hooks';
import { api } from './lib/api';
import type { QuestionView } from './lib/types';

type Mode = 'live' | 'simulation' | 'agents' | 'leaderboard' | 'disclosure';

export function App() {
  const { state, connect, disconnect, login } = useWallet();
  const [mode, setMode] = useState<Mode>('live');
  const [domain, setDomain] = useState<'all' | 'price' | 'weather'>('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: questions } = usePolling(() => api.questions(0, 100), 15_000, []);

  const selected: QuestionView | null =
    questions?.questions.find((q) => q.question_id === selectedId) ?? null;

  return (
    <Shell
      config={state.config}
      mode={mode}
      onMode={setMode}
      accountId={state.accountId}
      authenticated={state.status === 'authenticated'}
      connecting={state.status === 'connecting'}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
      onLogin={() => void login()}
      loginBusy={state.status === 'logging-in'}
      error={state.error}
    >
      {mode === 'live' ? (
        <LiveView
          domain={domain}
          setDomain={setDomain}
          selected={selected}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
        />
      ) : mode === 'simulation' ? (
        <SimulationPanel />
      ) : mode === 'leaderboard' ? (
        <section className="mode-page">
          <h2 className="ledger-heading">Global leaderboard</h2>
          <LeaderboardPanel />
        </section>
      ) : mode === 'agents' ? (
        <section className="mode-page">
          <h2 className="ledger-heading">The eight identities</h2>
          <AgentRoleNote />
          <AgentsPanel />
        </section>
      ) : (
        <section className="mode-page">
          <h2 className="ledger-heading">Trust boundary</h2>
          <DisclosurePanel />
        </section>
      )}
    </Shell>
  );
}

function LiveView({
  domain,
  setDomain,
  selected,
  selectedId,
  setSelectedId,
}: {
  domain: 'all' | 'price' | 'weather';
  setDomain: (d: 'all' | 'price' | 'weather') => void;
  selected: QuestionView | null;
  selectedId: number | null;
  setSelectedId: (id: number | null) => void;
}) {
  const { state, login } = useWallet();
  return (
    <div className="live-view">
      <div className="live-list">
        <div className="list-head">
          <h2 className="ledger-heading">Rounds</h2>
          <div className="domain-tabs" role="tablist" aria-label="Domain filter">
            {(['all', 'price', 'weather'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={domain === d}
                className={`btn ${domain === d ? '' : 'btn-ghost'}`}
                onClick={() => setDomain(d)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <QuestionList domain={domain} onSelect={setSelectedId} selectedId={selectedId} />
      </div>
      <div className="live-detail">
        {selected ? (
          <>
            <QuestionDetail q={selected} wallet={state} />
            {state.accountId && state.config ? (
              <BalancePanel
                accountId={state.accountId}
                contractId={state.config.contractId}
                networkId={state.config.networkId}
                onAuthRequired={() => void login()}
              />
            ) : null}
            {selected.phase === 'resolved' || selected.phase === 'settled' || selected.phase === 'cancelled' ? (
              <ComparisonPanel questionId={selected.question_id} />
            ) : null}
          </>
        ) : (
          <div className="detail-empty">
            <p className="empty-title ledger-heading">Select a Round</p>
            <p className="muted-line">
              Inspect the event, source, schedule, and price; buy Forecast Access; read the frozen snapshot;
              and compare Reveals once the Outcome is final.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
