import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { BalanceView, PendingWithdrawalView } from '../lib/types';
import { near, explorerTxUrl } from '../lib/format';
import { Stat, Panel, ErrorNote } from './ui';
import { walletConnector } from '../lib/wallet';

const GAS = '30000000000000';

/**
 * Claimable / pending / received are distinct. Settlement is not proof of
 * received funds: withdraw moves claimable into a pending transfer that the
 * contract's private callback later confirms as delivered (or restores on
 * failure). The panel polls the finalized balance + pending list until the
 * transfer reaches a terminal state; it never reports "done" early.
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
  const [inFlight, setInFlight] = useState(false);
  /** Claimable balance captured immediately before a withdraw, to detect the
   * definitive claimable→pending/received transition after a void wallet call. */
  const prevClaimable = useRef<bigint | null>(null);

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
    setBalance(null);
    setPending([]);
    setError(null);
    setBusy(null);
    setTxHash(null);
    setInFlight(false);
    prevClaimable.current = null;
    void load();
  }, [load]);

  // While a withdrawal is in flight, poll until a definitive canonical
  // transition is observed. The in-flight flag is set BEFORE the wallet call
  // (a browser wallet may return void, so the outcome is unknown until the
  // chain is re-read), and only cleared by a definitive observation — never by
  // an empty pending list seen before any poll.
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => {
    if (!inFlight) return;
    pollRef.current = setInterval(() => {
      void load().catch(() => {});
    }, 5000);
    return () => clearInterval(pollRef.current);
  }, [inFlight, load]);

  // Reconciliation: stop only when the transfer reached a definitive state
  // (delivered/restored) or the claimable balance actually decreased — never
  // on a pre-observation empty list.
  useEffect(() => {
    if (!inFlight) return;
    const hasTerminalPending = pending.some((w) => w.status === 'delivered' || w.status === 'restored');
    const claimableDropped = balance !== null && prevClaimable.current !== null && BigInt(balance.claimable) < prevClaimable.current;
    if (hasTerminalPending || claimableDropped) {
      setInFlight(false);
    }
  }, [pending, balance, inFlight]);

  const call = async (methodName: string, args: Record<string, unknown>, deposit: string) => {
    setBusy(methodName);
    setError(null);
    if (balance) prevClaimable.current = BigInt(balance.claimable);
    // A wallet call whose outcome is unknown (browser wallet returns void) is
    // pending from the start; set the flag before the action.
    setInFlight(true);
    try {
      const confirmed = await walletConnector().call({
        accountId,
        contractId,
        methodName,
        args,
        gas: GAS,
        deposit,
      });
      setTxHash(confirmed.txHash);
      await load();
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message;
      // A user rejection is not a pending transfer: clear the flight flag and
      // surface the rejection. A non-finalized/pending outcome keeps polling.
      if (msg.startsWith('transaction not finalized') || msg.toLowerCase().includes('rejected')) {
        if (msg.toLowerCase().includes('rejected')) {
          setInFlight(false);
          setError('Transaction rejected by the wallet.');
        } else {
          setError('Withdrawal submitted — waiting for finalization and the transfer callback.');
        }
      } else {
        setInFlight(false);
        setError(msg);
        onAuthRequired();
      }
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
              <p className="small-caps">Withdrawals</p>
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
      {inFlight ? <p className="muted-line small-caps">Waiting for the transfer to finalize…</p> : null}
      {error ? <ErrorNote message={error} /> : null}
    </Panel>
  );
}
