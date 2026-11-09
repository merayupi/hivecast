import { WalletControl } from '../components/Shell';
import { explorerAccountUrl } from '../lib/format';
import type { PublicConfig } from '../lib/types';

export type Tab = 'arena' | 'ledger' | 'simulation' | 'trust';

export const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'arena', label: 'ARENA' },
  { id: 'ledger', label: 'LEDGER' },
  { id: 'simulation', label: 'SIMULATION' },
  { id: 'trust', label: 'TRUST' },
];

/** Pixel HUD shared by every tab: wordmark, chain chip, tabs, wallet. */
export function Hud({
  config,
  tab,
  onTab,
  wallet,
}: {
  config: PublicConfig | null;
  tab: Tab;
  onTab: (t: Tab) => void;
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
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="hud-wallet">
        <WalletControl {...wallet} />
      </div>
    </header>
  );
}
