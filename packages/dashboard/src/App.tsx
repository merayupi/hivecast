import { useState } from 'react';
import { Shell } from './components/Shell';
import { HeroLine, TryItPanel } from './components/Intro';
import { RationalePanel } from './components/Rationale';
import { QuestionList } from './components/QuestionList';
import { QuestionDetail } from './components/QuestionDetail';
import { BalancePanel } from './components/BalancePanel';
import { ComparisonPanel, LeaderboardPanel, EconomicsPanel } from './components/Analytics';
import { SimulationPanel } from './components/Simulation';
import { AgentsPanel, DisclosurePanel, AgentRoleNote } from './components/Disclosure';
import { useWallet } from './lib/useWallet';
import type { WalletState } from './lib/useWallet';
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
          walletState={state}
          onLogin={() => void login()}
          onSimulation={() => setMode('simulation')}
        />
      ) : mode === 'simulation' ? (
        <SimulationPanel />
      ) : mode === 'leaderboard' ? (
        <section className="mode-page">
          <h2 className="ledger-heading">Global leaderboard</h2>
          <LeaderboardPanel />
          <div className="economics-section">
            <h3 className="ledger-heading">Agent economics</h3>
            <EconomicsPanel />
          </div>
        </section>
      ) : mode === 'agents' ? (
        <section className="mode-page">
          <h2 className="ledger-heading">The agents</h2>
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
  walletState,
  onLogin,
  onSimulation,
}: {
  domain: 'all' | 'price' | 'weather';
  setDomain: (d: 'all' | 'price' | 'weather') => void;
  selected: QuestionView | null;
  selectedId: number | null;
  setSelectedId: (id: number | null) => void;
  walletState: WalletState;
  onLogin: () => void;
  onSimulation: () => void;
}) {
  return (
    <>
    <HeroLine />
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
            <QuestionDetail q={selected} wallet={walletState} />
            {walletState.accountId && walletState.config ? (
              <BalancePanel
                accountId={walletState.accountId}
                contractId={walletState.config.contractId}
                networkId={walletState.config.networkId}
                onAuthRequired={onLogin}
              />
            ) : null}
            {selected.phase === 'resolved' || selected.phase === 'settled' || selected.phase === 'cancelled' ? (
              <ComparisonPanel questionId={selected.question_id} />
            ) : null}
            {selected.phase === 'resolved' || selected.phase === 'settled' ? (
              <RationalePanel questionId={selected.question_id} />
            ) : null}
          </>
        ) : (
          <div className="detail-empty">
            <p className="muted-line">Select a Round on the left to see its schedule, buy access, or compare Reveals.</p>
            <TryItPanel onSimulation={onSimulation} />
          </div>
        )}
      </div>
    </div>
    </>
  );
}
