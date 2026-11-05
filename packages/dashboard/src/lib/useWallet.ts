import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from './api';
import type { PublicConfig, SessionDto } from './types';
import { walletConnector, type WalletAccount } from './wallet';

export type AuthStatus = 'idle' | 'connecting' | 'connected' | 'logging-in' | 'authenticated';

export interface WalletState {
  status: AuthStatus;
  accounts: WalletAccount[];
  accountId: string | null;
  session: SessionDto | null;
  error: string | null;
  config: PublicConfig | null;
}

const empty: WalletState = {
  status: 'idle',
  accounts: [],
  accountId: null,
  session: null,
  error: null,
  config: null,
};

/**
 * Wallet connect/restore + NEP-413 login, scoped to one account/network/contract.
 * On identity or network/contract switch every cached account/session binding is
 * cleared so no private panel leaks across identities.
 */
export function useWallet() {
  const [state, setState] = useState<WalletState>(empty);

  const clearAll = useCallback(() => {
    setState((s) => ({
      ...s,
      status: 'idle',
      accounts: [],
      accountId: null,
      session: null,
      error: null,
    }));
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const config = await api.config();
      setState((s) => ({ ...s, config }));
      return config;
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error).message }));
      return null;
    }
  }, []);

  // Restore a previously selected wallet on mount.
  useEffect(() => {
    void (async () => {
      await loadConfig();
      try {
        const accounts = await walletConnector().restore();
        if (accounts.length > 0) {
          setState((s) => ({ ...s, status: 'connected', accounts, accountId: accounts[0]?.accountId ?? null }));
        }
      } catch {
        // No stored selection — remain idle.
      }
    })();
  }, [loadConfig]);

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, status: 'connecting', error: null }));
    try {
      const config = state.config ?? (await loadConfig());
      if (!config) throw new Error('backend /config unavailable');
      const accounts = await walletConnector().connect(config.contractId);
      const accountId = accounts[0]?.accountId ?? null;
      setState((s) => ({ ...s, status: 'connected', accounts, accountId, session: null }));
    } catch (err) {
      setState((s) => ({ ...s, status: 'idle', error: (err as Error).message }));
    }
  }, [state.config, loadConfig]);

  const disconnect = useCallback(async () => {
    try {
      await walletConnector().disconnect();
    } catch {
      // ignore — local state clears regardless
    }
    try {
      await api.logout();
    } catch {
      // ignore — server cookie may already be gone
    }
    clearAll();
  }, [clearAll]);

  /** NEP-413 login: challenge → wallet sign → verify → HttpOnly session cookie. */
  const login = useCallback(async () => {
    const accountId = state.accountId;
    const config = state.config;
    if (!accountId || !config) {
      setState((s) => ({ ...s, error: 'connect a wallet first' }));
      return false;
    }
    setState((s) => ({ ...s, status: 'logging-in', error: null }));
    try {
      const challenge = await api.challenge(accountId);
      const signed = await walletConnector().signMessage({
        message: challenge.message,
        recipient: challenge.recipient,
        nonceBase64: challenge.nonce,
        accountId,
      });
      const session = await api.verify({
        challenge_id: challenge.challenge_id,
        account_id: accountId,
        public_key: signed.publicKey,
        signature: signed.signature,
      });
      setState((s) => ({ ...s, status: 'authenticated', session }));
      return true;
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message;
      setState((s) => ({ ...s, status: 'connected', error: msg }));
      return false;
    }
  }, [state.accountId, state.config]);

  /** Bind safety: if the connected identity differs, reset session state. */
  const setAccountId = useCallback((accountId: string) => {
    setState((s) => ({ ...s, accountId, session: null, status: 'connected' }));
  }, []);

  return { state, connect, disconnect, login, clearAll, setAccountId, loadConfig };
}
