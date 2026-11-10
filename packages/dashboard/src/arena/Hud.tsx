import { WalletControl } from '../components/Shell';
import { explorerAccountUrl } from '../lib/format';
import type { PublicConfig } from '../lib/types';

export type Tab = 'arena' | 'ledger' | 'agents' | 'simulation' | 'trust';

/**
 * Hash ids are kept stable for old links (`#ledger`, `#simulation`,
 * `#trust`); the labels say what a visitor finds there.
 */
export const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'arena', label: 'ARENA', hint: 'Watch the current Round live' },
  { id: 'ledger', label: 'ROUNDS', hint: 'Every Round: buy and read the swarm forecast' },
  { id: 'agents', label: 'AGENTS', hint: 'Who is in the swarm and how they rank' },
  { id: 'simulation', label: 'REPLAY', hint: 'Offline replay of a past season (not live)' },
  { id: 'trust', label: 'GUIDE', hint: 'How it works, glossary and trust boundary' },
];

/** Pixel HUD shared by every tab: wordmark, chain chip, tabs, wallet. */
export function Hud({
  config,
  tab,
  onTab,
  onTour,
  wallet,
}: {
  config: PublicConfig | null;
  tab: Tab;
  onTab: (t: Tab) => void;
  /** Opens the guided tour. */
  onTour: () => void;
  wallet: {
    accountId: string | null;
    authenticated: boolean;
    connecting: boolean;
    onConnect: () => void;
    onDisconnect: () => void;
    onLogin: () => void;
    loginBusy: boolean;
  };
}) {
  const networkId = config?.networkId ?? 'testnet';
  return (
    <header className="hud">
      <h1 className="hud-wordmark">HIVECAST</h1>
      {config ? (
        <a className="hud-chip" href={explorerAccountUrl(networkId, config.contractId)} target="_blank" rel="noreferrer" title={config.contractId}>
          {networkId.toUpperCase()} · {config.contractId}
        </a>
      ) : (
        <span className="hud-chip">{networkId.toUpperCase()} · connecting…</span>
      )}
      <nav className="hud-tabs" aria-label="Views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`hud-tab ${tab === t.id ? 'is-active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            title={t.hint}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="hud-wallet">
        <button type="button" className="hud-help" onClick={onTour}>
          ? How it works
        </button>
        <WalletControl {...wallet} />
      </div>
    </header>
  );
}
