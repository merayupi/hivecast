import { useEffect, useState } from 'react';
import { usePolling } from '../lib/hooks';
import { api } from '../lib/api';
import type { PublicConfig } from '../lib/types';
import { explorerAccountUrl, shortId } from '../lib/format';
import { walletConnector } from '../lib/wallet';
import { Chip, ErrorNote } from './ui';

type Mode = 'live' | 'simulation' | 'agents' | 'leaderboard' | 'disclosure';

const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'live', label: 'Live testnet' },
  { id: 'simulation', label: 'Simulation' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'agents', label: 'Agents' },
  { id: 'disclosure', label: 'Trust' },
];

/**
 * Top bar + mode strip. The network/contract chip binds the session to the
 * configured chain; the wallet control is a genuine connect/disconnect.
 */
export function Shell({
  config,
  mode,
  onMode,
  accountId,
  authenticated,
  connecting,
  onConnect,
  onDisconnect,
  onLogin,
  loginBusy,
  error,
  children,
}: {
  config: PublicConfig | null;
  mode: Mode;
  onMode: (m: Mode) => void;
  accountId: string | null;
  authenticated: boolean;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onLogin: () => void;
  loginBusy: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  const networkId = config?.networkId ?? 'testnet';
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">HC</span>
          <div className="brand-text">
            <h1 className="ledger-heading">HiveCast</h1>
            <span className="small-caps">forecast access · testnet</span>
          </div>
        </div>
        <div className="topbar-right">
          {config ? (
            <a className="chain-chip num" href={explorerAccountUrl(networkId, config.contractId)} target="_blank" rel="noreferrer" title={config.contractId}>
              {networkId} · {shortId(config.contractId, 22)}
            </a>
          ) : (
            <span className="chain-chip num">connecting…</span>
          )}
          <WalletControl
            accountId={accountId}
            authenticated={authenticated}
            connecting={connecting}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onLogin={onLogin}
            loginBusy={loginBusy}
          />
        </div>
      </header>

      <nav className="mode-strip" aria-label="Mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`mode-tab ${mode === m.id ? 'is-active' : ''}`}
            aria-current={mode === m.id ? 'page' : undefined}
            onClick={() => onMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </nav>

      {error ? (
        <div className="shell-error">
          <ErrorNote message={error} />
        </div>
      ) : null}

      <main className="shell-main">{children}</main>
    </div>
  );
}

function WalletControl({
  accountId,
  authenticated,
  connecting,
  onConnect,
  onDisconnect,
  onLogin,
  loginBusy,
}: {
  accountId: string | null;
  authenticated: boolean;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onLogin: () => void;
  loginBusy: boolean;
}) {
  if (!accountId) {
    return (
      <button type="button" className="btn" onClick={onConnect} disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>
    );
  }
  return (
    <div className="wallet-control">
      <span className="wallet-id num" title={accountId}>{shortId(accountId, 26)}</span>
      {authenticated ? (
        <Chip tone="ok">authenticated</Chip>
      ) : (
        <button type="button" className="btn btn-ghost" onClick={onLogin} disabled={loginBusy}>
          {loginBusy ? 'Signing…' : 'Login'}
        </button>
      )}
      <button type="button" className="btn btn-ghost" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}
