import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { BalanceView, PendingWithdrawalView } from '../lib/types';
import { near, explorerTxUrl } from '../lib/format';
import { Stat, Panel, ErrorNote } from './ui';
import { walletConnector } from '../lib/wallet';

const GAS = '30000000000000';

/**
 * Claimable / pending / received are distinct. Settlement is not proof of
 * received funds: claim makes a buyer refund claimable, withdraw moves
 * claimable into a pending transfer that the contract's private callback
 * later confirms as received.
 */
export function BalancePanel({
  accountId,
  contractId,
  networkId,
  onAuthRequired,
}: {
  accountId: string;
  contractId: string;
  networkId: string;
  onAuthRequired: () => void;
}) {
  const [balance, setBalance] = useState<BalanceView | null>(null);
  const [pending, setPending] = useState<PendingWithdrawalView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, p] = await Promise.all([api.balance(accountId), api.pendingWithdrawals(accountId)]);
      setBalance(b);
      setPending(p);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const call = async (methodName: string, args: Record<string, unknown>, deposit: string) => {
    setBusy(methodName);
    setError(null);
    try {
      const hash = await walletConnector().call({
        accountId,
        contractId,
        methodName,
        args,
        gas: GAS,
        deposit,
      });
      setTxHash(hash);
      await load();
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message;
      setError(msg);
      onAuthRequired();
    } finally {
      setBusy(null);
    }
  };

  const claimable = balance ? BigInt(balance.claimable) : 0n;

  return (
    <Panel title="Your balances" action={txHash ? <a className="small-caps link" href={explorerTxUrl(networkId, txHash)} target="_blank" rel="noreferrer">view tx</a> : undefined}>
      {!balance ? (
        <p className="muted-line">Loading balances…</p>
      ) : (
        <>
          <div className="balance-stats">
            <Stat label="Claimable" value={`${near(balance.claimable)} Ⓝ`} hint="entitled, not yet withdrawn" />
            <Stat label="Pending" value={`${near(balance.pending)} Ⓝ`} hint="in-flight transfer" />
            <Stat label="Received" value={`${near(balance.received)} Ⓝ`} hint="delivered funds" />
          </div>

          <div className="balance-actions">
            <button
              type="button"
              className="btn"
              disabled={busy !== null || claimable === 0n}
              onClick={() => call('withdraw', { amount: balance.claimable }, '0')}
            >
              {busy === 'withdraw' ? 'Signing…' : 'Withdraw claimable'}
            </button>
            <p className="muted-line small-caps">Buyer refunds are claimed per Question (see the Round's access panel).</p>
          </div>

          {pending.length > 0 ? (
            <div className="pending-list">
              <p className="small-caps">Pending withdrawals</p>
              {pending.map((w) => (
                <div key={w.nonce} className="pending-row num">
                  <span>#{w.nonce}</span>
                  <span>{near(w.amount)} Ⓝ</span>
                  <span className={`chip ${w.status === 'delivered' ? 'text-state-ok' : w.status === 'restored' ? 'text-state-warn' : 'text-ink-500'}`}>
                    {w.status}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
      {error ? <ErrorNote message={error} /> : null}
    </Panel>
  );
}
