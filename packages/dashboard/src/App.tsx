import { useEffect, useState } from 'react';
import { Shell } from './components/Shell';
import { TryOnTestnet } from './components/Intro';
import { GuidePage } from './components/Guide';
import { RationalePanel } from './components/Rationale';
import { QuestionList } from './components/QuestionList';
import { QuestionDetail } from './components/QuestionDetail';
import { BalancePanel } from './components/BalancePanel';
import { ComparisonPanel } from './components/Analytics';
import { SimulationPanel } from './components/Simulation';
import { useWallet } from './lib/useWallet';
import type { WalletState } from './lib/useWallet';
import { usePolling } from './lib/hooks';
import { api } from './lib/api';
import type { QuestionView } from './lib/types';
import { ArenaView } from './arena/ArenaView';
import { Hud, TABS, type Tab } from './arena/Hud';
import { SeasonRace } from './arena/SeasonReplay';
import { AgentsView } from './arena/AgentsView';
import { Tour, tourSeen } from './arena/Tour';
import './arena/arena.css';

function tabFromHash(): Tab {
  const h = window.location.hash.replace('#', '');
  return (TABS.find((t) => t.id === h)?.id ?? 'arena') as Tab;
}

/** App shell: pixel HUD + ARENA (default) / ROUNDS / AGENTS / REPLAY / GUIDE, and the first-visit tour. */
export function App() {
  const wallet = useWallet();
  const { state, connect, disconnect, login } = wallet;
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const [ledgerFocus, setLedgerFocus] = useState<number | null>(null);
  // The tour opens by itself once per browser; "How it works" reopens it.
  const [tourOpen, setTourOpen] = useState(() => !tourSeen());

  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const setTab = (t: Tab) => {
    setTabState(t);
    const url = new URL(window.location.href);
    url.hash = t === 'arena' ? '' : t;
    if (t !== 'arena') url.searchParams.delete('round');
    window.history.replaceState(null, '', url);
  };

  const walletProps = {
    accountId: state.accountId,
    authenticated: state.status === 'authenticated',
    connecting: state.status === 'connecting',
    onConnect: () => void connect(),
    onDisconnect: () => void disconnect(),
    onLogin: () => void login(),
    loginBusy: state.status === 'logging-in',
  };

  return (
    <div className="hive-surface">
      <Hud config={state.config} tab={tab} onTab={setTab} onTour={() => setTourOpen(true)} wallet={walletProps} />
      <Tour open={tourOpen} onClose={() => setTourOpen(false)} onTab={setTab} />
      {tab === 'arena' ? (
        <ArenaView
          config={state.config}
          onOpenRound={(id) => {
            setLedgerFocus(id);
            setTab('ledger');
          }}
          onTab={(t) => {
            if (t === 'ledger') setLedgerFocus(null);
            setTab(t);
          }}
          onTour={() => setTourOpen(true)}
        />
      ) : tab === 'simulation' ? (
        <SeasonReplayView />
      ) : tab === 'agents' ? (
        <AgentsView config={state.config} />
      ) : (
        // The ruled ledger keeps its own light paper theme, shown as a sheet
        // inside the night frame so every tab shares one surface.
        <div className="ledger-sheet">
          {tab === 'ledger' ? (
            <RoundsApp wallet={wallet} focusId={ledgerFocus} />
          ) : (
            <GuidePage onTour={() => setTourOpen(true)} onSimulation={() => setTab('simulation')} />
          )}
        </div>
      )}
    </div>
  );
}

/** REPLAY: the Season Replay race on the night stage, the replay's accuracy chart and table below. */
function SeasonReplayView() {
  const { data, error, loading } = usePolling(() => api.simulation(), 60_000, []);
  const [domain, setDomain] = useState<'price' | 'weather'>('price');
  return (
    <>
      <div className="arena season-wrap">
        {data ? (
          <SeasonRace report={data} domain={domain} />
        ) : (
          <p className="no-data">{loading ? 'Loading the offline replay…' : `NO DATA YET — ${error ?? 'replay report unavailable'}`}</p>
        )}
      </div>
      <div className="ledger-sheet">
        <main className="shell-main sheet-pad">
          <SimulationPanel domain={domain} onDomain={setDomain} hideBankroll />
        </main>
      </div>
    </>
  );
}

/** ROUNDS: the ruled-ledger Round list, detail and buy flow. */
function RoundsApp({ wallet, focusId }: { wallet: ReturnType<typeof useWallet>; focusId: number | null }) {
  const { state, connect, disconnect, login } = wallet;
  const [domain, setDomain] = useState<'all' | 'price' | 'weather'>('all');
  const [selectedId, setSelectedId] = useState<number | null>(focusId);
  const { data: questions } = usePolling(() => api.allQuestions(), 15_000, []);
  // Direct read of the selected Round keeps it fresh between list polls.
  const { data: focused } = usePolling(
    () => (selectedId === null ? Promise.resolve(null) : api.question(selectedId)),
    15_000,
    [selectedId],
  );

  const selected: QuestionView | null =
    questions?.find((q) => q.question_id === selectedId) ??
    (focused && focused.question_id === selectedId ? focused : null);

  return (
    <Shell
      config={state.config}
      accountId={state.accountId}
      authenticated={state.status === 'authenticated'}
      connecting={state.status === 'connecting'}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
      onLogin={() => void login()}
      loginBusy={state.status === 'logging-in'}
      error={state.error}
      embedded
    >
      <LiveView
        domain={domain}
        setDomain={setDomain}
        selected={selected}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
        walletState={state}
        onLogin={() => void login()}
      />
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
}: {
  domain: 'all' | 'price' | 'weather';
  setDomain: (d: 'all' | 'price' | 'weather') => void;
  selected: QuestionView | null;
  selectedId: number | null;
  setSelectedId: (id: number | null) => void;
  walletState: WalletState;
  onLogin: () => void;
}) {
  return (
    <>
      <div className="hero-line rule-b">
        <p className="hero-pitch">Every Round on the contract. Pick one to see its schedule, buy the forecast, or check the Reveals.</p>
        <p className="muted-line">
          A Round marked <span className="chip text-state-ok">on sale</span> can be bought now, until its event starts. Finished
          Rounds are free to read.
        </p>
      </div>
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
              <h2 className="ledger-heading empty-title">Select a Round</h2>
              <p className="muted-line">Its schedule, the buy button and every revealed forecast open here.</p>
              <div className="try-panel">
                <section>
                  <h2 className="ledger-heading">Buying a forecast, step by step</h2>
                  <TryOnTestnet />
                </section>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
