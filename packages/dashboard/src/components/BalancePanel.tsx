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
  /** Canonical ledger snapshot captured immediately before a withdraw, so the
   * definitive delivered/restored transition can be distinguished from the
   * claimable→pending movement that happens before the private callback runs. */
  const prevReceived = useRef<bigint | null>(null);
  const prevPendingNonces = useRef<Set<number>>(new Set());
  const requestedAmount = useRef<bigint | null>(null);

  const clearFlightState = useCallback(() => {
    prevReceived.current = null;
    prevPendingNonces.current = new Set();
    requestedAmount.current = null;
  }, []);

  const load = useCallback(async () => {
    try {
      const [b, p] = await Promise.all([api.balance(accountId), api.pendingWithdrawals(accountId)]);
      setBalance(b);
      setPending(p);
      setError(null);
      return { balance: b, pending: p };
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, [accountId]);

  useEffect(() => {
    setBalance(null);
    setPending([]);
    setError(null);
    setBusy(null);
    setTxHash(null);
    setInFlight(false);
    clearFlightState();
    void load();
  }, [load, clearFlightState]);

  // While a withdrawal is in flight, poll the canonical ledger until a
  // definitive transition is observed. `inFlight` is set BEFORE the wallet
  // call (a browser wallet may return void, so the outcome is unknown until
  // the chain is re-read).
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => {
    if (!inFlight) return;
    pollRef.current = setInterval(() => {
      void load().catch(() => {});
    }, 5000);
    return () => clearInterval(pollRef.current);
  }, [inFlight, load]);

  // Reconciliation: stop ONLY on a definitive delivered/restored transition.
  //   - delivered: received >= prevReceived + requestedAmount (native private
  //     callback completed; never optimistic).
  //   - restored: a NEW withdrawal nonce (not present before the action) reached
  //     status "restored" and claimable was restored (the specific operation
  //     failed its callback).
  //   - pending > 0: the transfer is still in flight (claimable→pending happened
  //     but the callback has not yet delivered/restored) — keep waiting.
  // A historical pending row (delivered/restored before this action) must never
  // end a NEW flight; only newly-observed nonces count.
  useEffect(() => {
    if (!inFlight || balance === null) return;

    const received = BigInt(balance.received);
    const requested = requestedAmount.current;
    if (requested !== null && prevReceived.current !== null && received >= prevReceived.current + requested) {
      setInFlight(false);
      clearFlightState();
      return;
    }

    const newNonces = pending.filter((w) => !prevPendingNonces.current.has(w.nonce));
    const newRestored = newNonces.filter((w) => w.status === 'restored');
    if (newRestored.length > 0) {
      setInFlight(false);
      clearFlightState();
      return;
    }
    // Otherwise (pending > 0, or pending unknown while the tx finalizes) keep
    // polling the canonical ledger; never stop on a pre-observation empty list.
  }, [pending, balance, inFlight, clearFlightState]);

  const call = async (methodName: string, args: Record<string, unknown>, deposit: string) => {
    setBusy(methodName);
    setError(null);
    if (balance) {
      prevReceived.current = BigInt(balance.received);
      prevPendingNonces.current = new Set(pending.map((w) => w.nonce));
      requestedAmount.current = BigInt(typeof args.amount === 'string' ? args.amount : balance.claimable);
    }
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
      if (confirmed.txHash) setTxHash(confirmed.txHash);
      if (confirmed.pending) {
        // Browser wallet returned void: the tx was submitted but its outcome is
        // unknown; the reconciliation effect keeps polling the ledger.
        setError('Withdrawal submitted — waiting for finalization and the transfer callback.');
      }
      await load();
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message;
      // A user rejection is not a pending transfer: clear the flight state and
      // surface the rejection (no spurious onAuthRequired). A definitive
      // failure also clears flight; anything else stays pending on the ledger.
      if (msg.toLowerCase().includes('rejected') || msg.toLowerCase().includes('user rejected')) {
        setInFlight(false);
        clearFlightState();
        setError('Transaction rejected by the wallet.');
      } else {
        setInFlight(false);
        clearFlightState();
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
              disabled={busy !== null || inFlight || claimable === 0n}
              onClick={() => call('withdraw', { amount: balance.claimable }, '0')}
            >
              {busy === 'withdraw' ? 'Signing…' : inFlight ? 'Finalizing…' : 'Withdraw claimable'}
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
