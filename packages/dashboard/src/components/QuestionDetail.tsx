import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { ForecastDeliveryDto, QuestionView } from '../lib/types';
import { near, pct, nsDate, fmtDateTimeTz, domainTimeZone, questionDomain, sourceLabel, explorerTxUrl } from '../lib/format';
import { PhaseLadder } from './PhaseLadder';
import { Chip, DomainChip, SingleAgentMark, Stat, Panel, ErrorNote } from './ui';
import type { WalletState } from '../lib/useWallet';
import { walletConnector } from '../lib/wallet';

const BUY_GAS = '30000000000000';
const NS_PER_MS = 1_000_000n;

interface ReceiptState {
  refunded: boolean;
  price: string;
}

/** True only while the Question is actually for sale (closed AND before observation). */
function inSaleWindow(q: QuestionView, nowMs: number): boolean {
  if (q.phase !== 'closed') return false;
  if (!q.snapshot_ready || q.participant_count === 0) return false;
  const nowNs = BigInt(nowMs) * NS_PER_MS;
  return BigInt(q.close_time) <= nowNs && nowNs < BigInt(q.observation_start);
}

export function QuestionDetail({ q, wallet }: { q: QuestionView; wallet: WalletState }) {
  const [delivery, setDelivery] = useState<ForecastDeliveryDto | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);
  const [pendingTx, setPendingTx] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const accountId = wallet.accountId;
  const networkId = wallet.config?.networkId ?? 'testnet';

  // Reset all cached per-Question/per-identity state when either changes, so a
  // private delivery/receipt never leaks across a Question or an account switch.
  useEffect(() => {
    setDelivery(null);
    setReceipt(null);
    setTxHash(null);
    setFetchError(null);
    setPendingTx(false);
    setBusy(null);
  }, [q.question_id, accountId]);

  // Wall clock for the countdown + sale window.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const loadReceipt = useCallback(async () => {
    if (!accountId) return;
    const r = await api.receipt(q.question_id, accountId);
    setReceipt(r ? { refunded: r.refunded, price: r.price } : null);
  }, [q.question_id, accountId]);

  useEffect(() => {
    void loadReceipt();
  }, [loadReceipt]);

  // While a buy/claim is in flight (included but not yet finalized), poll the
  // receipt view until it lands or the window/identity changes. Never report
  // "complete" before the finalized receipt is observed.
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => {
    if (!pendingTx) return;
    pollRef.current = setInterval(() => {
      void loadReceipt().catch(() => {
        // transient read failure: keep polling
      });
    }, 4000);
    return () => clearInterval(pollRef.current);
  }, [pendingTx, loadReceipt]);

  // Stop polling once the receipt appears (purchase/refund observed finalized).
  useEffect(() => {
    if (receipt && pendingTx) setPendingTx(false);
  }, [receipt, pendingTx]);

  const saleOpen = inSaleWindow(q, nowMs);
  const canBuy = saleOpen && !receipt;

  const buy = async () => {
    if (!accountId || !wallet.config) return;
    setBusy('buy');
    setFetchError(null);
    try {
      const confirmed = await walletConnector().call({
        accountId,
        contractId: wallet.config.contractId,
        methodName: 'buy_forecast',
        args: { question_id: q.question_id },
        gas: BUY_GAS,
        deposit: q.access_price,
      });
      if (confirmed.txHash) setTxHash(confirmed.txHash);
      if (confirmed.pending) {
        // Browser wallet redirected for signing; poll the receipt until the
        // finalized entitlement is observed — never claim "complete" early.
        setPendingTx(true);
        setFetchError('Purchase submitted — waiting for finalization, then the receipt will appear.');
      }
      await loadReceipt();
    } catch (err) {
      setFetchError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const readForecast = async () => {
    setBusy('read');
    setFetchError(null);
    try {
      const dto = await api.forecast(q.question_id);
      setDelivery(dto);
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message;
      setFetchError(msg);
    } finally {
      setBusy(null);
    }
  };

  const claimRefund = async () => {
    if (!accountId || !wallet.config) return;
    setBusy('claim');
    setFetchError(null);
    try {
      const confirmed = await walletConnector().call({
        accountId,
        contractId: wallet.config.contractId,
        methodName: 'claim_buyer_refund',
        args: { question_id: q.question_id },
        gas: BUY_GAS,
        deposit: '0',
      });
      if (confirmed.txHash) setTxHash(confirmed.txHash);
      if (confirmed.pending) {
        setPendingTx(true);
        setFetchError('Claim submitted — waiting for finalization.');
      }
      await loadReceipt();
    } catch (err) {
      setFetchError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="detail">
      <div className="detail-head">
        <div className="detail-tags">
          <DomainChip domain={questionDomain(q.source)} />
          <Chip tone="ink">{q.phase}</Chip>
          <SingleAgentMark count={q.participant_count} />
        </div>
        <h2 className="detail-title ledger-heading">{q.text}</h2>
        <p className="detail-event">{q.event_definition}</p>
      </div>

      <PhaseLadder q={q} nowMs={nowMs} />

      <div className="detail-stats">
        <Stat label="Query fee" value={`${near(q.access_price)} Ⓝ`} hint="one fixed fee per Question" />
        <Stat label="Min stake" value={`${near(q.min_stake)} Ⓝ`} />
        <Stat label="Total stake" value={`${near(q.total_stake)} Ⓝ`} />
        <Stat label="Fee pool" value={`${near(q.fee_pool)} Ⓝ`} />
        <Stat label="Participants" value={String(q.participant_count)} />
        <Stat label="Buyers" value={String(q.buyer_count)} />
      </div>

      <dl className="detail-facts">
        <Fact k="Source" v={sourceLabel(q.source)} />
        <Fact k="Resolver" v={q.resolver} />
        <Fact k="Observation" v={`${fmtDateTimeTz(q.observation_start, domainTimeZone(questionDomain(q.source)))} → ${fmtDateTimeTz(q.observation_end, domainTimeZone(questionDomain(q.source)))}`} />
        <Fact k="Snapshot id" v={q.snapshot_id ?? 'not published'} />
        {q.outcome !== null ? (
          <Fact k="Outcome" v={q.outcome ? 'YES' : 'NO'} />
        ) : null}
      </dl>

      <Panel title="Forecast Access" action={txHash ? <a className="small-caps link" href={explorerTxUrl(networkId, txHash)} target="_blank" rel="noreferrer">view tx</a> : undefined}>
        {!accountId ? (
          <p className="muted-line">Connect a testnet wallet to buy or read this forecast.</p>
        ) : receipt ? (
          <div className="access-owned">
            <p>
              <span className="chip text-state-ok">Purchased</span>
              <span className="muted-line num"> paid {near(receipt.price)} Ⓝ · {receipt.refunded ? 'refunded' : 'not refunded'}</span>
            </p>
            {delivery ? (
              <div className="forecast-reveal">
                <Stat label="Aggregated forecast" value={pct(delivery.aggregate_bps)} hint={delivery.single_agent ? 'Single-agent Forecast' : `weighted across ${delivery.participant_count} participants`} />
                <Stat label="Frozen snapshot" value={shortSnapshot(delivery.snapshot_id)} hint="same for every buyer of this Round" />
              </div>
            ) : (
              <button type="button" className="btn" onClick={readForecast} disabled={busy !== null}>
                {busy === 'read' ? 'Reading…' : 'Read snapshot'}
              </button>
            )}
            {!receipt.refunded && (q.phase === 'cancelled' || q.phase === 'settled') ? (
              <div className="access-claim">
                <button type="button" className="btn btn-ghost" onClick={claimRefund} disabled={busy !== null}>
                  {busy === 'claim' ? 'Signing…' : 'Claim buyer refund'}
                </button>
                <p className="muted-line small-caps">Eligible when the Round is cancelled or settled with zero Valid Revealers; the contract enforces eligibility.</p>
              </div>
            ) : null}
            {wallet.status !== 'authenticated' ? (
              <p className="muted-line">Reading requires wallet login (NEP-413) to prove you own this account.</p>
            ) : null}
          </div>
        ) : saleOpen ? (
          <div className="access-buy">
            <p className="muted-line">
              Purchase is exact-once: {near(q.access_price)} Ⓝ for this frozen Forecast Snapshot. Wrong amount,
              duplicate, or out-of-window purchases are rejected on-chain. Sale closes at{' '}
              {fmtDateTimeTz(q.observation_start, domainTimeZone(questionDomain(q.source)))}.
            </p>
            <button type="button" className="btn btn-vermilion" onClick={buy} disabled={busy !== null || !canBuy}>
              {busy === 'buy' ? 'Signing…' : `Buy for ${near(q.access_price)} Ⓝ`}
            </button>
          </div>
        ) : (
          <p className="muted-line">
            {q.phase === 'open'
              ? 'Sales open after the commitment cutoff, once the snapshot is frozen and before observation.'
              : q.phase === 'closed' && nsDate(q.observation_start).getTime() <= nowMs
                ? 'Sales have closed: observation started.'
                : q.participant_count === 0
                  ? 'This Round has no participants; the forecast cannot be sold.'
                  : 'This forecast is not for sale (snapshot not ready or window passed).'}
          </p>
        )}
        {pendingTx ? <p className="muted-line small-caps">Waiting for the transaction to finalize…</p> : null}
        {fetchError ? <ErrorNote message={fetchError} /> : null}
      </Panel>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="fact">
      <dt className="small-caps">{k}</dt>
      <dd className="num">{v}</dd>
    </div>
  );
}

function shortSnapshot(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 9)}…${id.slice(-6)}`;
}
