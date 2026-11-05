import { usePolling } from '../lib/hooks';
import { api } from '../lib/api';
import type { QuestionComparison, GlobalLeaderboard, EconomicsReport } from '../lib/types';
import { near, pct, brier } from '../lib/format';
import { Stat, Panel, ErrorNote, EmptyState, Chip } from './ui';

/**
 * Per-Question comparison: probabilities are genuinely public only after
 * Reveal; scores exist only once the Outcome is final. Unrevealed participants
 * show their commitment hash, never a probability.
 */
export function ComparisonPanel({ questionId }: { questionId: number }) {
  const { data, error, loading } = usePolling(() => api.comparison(questionId), 20_000, [questionId]);

  if (loading) return <p className="muted-line">Loading comparison…</p>;
  if (error) return <ErrorNote message={error} />;
  if (!data) return <EmptyState title="No comparison" detail="This Question is not on the live contract." />;
  return <ComparisonTable c={data} />;
}

function ComparisonTable({ c }: { c: QuestionComparison }) {
  return (
    <div>
      <div className="comparison-head">
        <Stat label="Outcome" value={c.outcome === null ? (c.scores_public ? '—' : 'not final') : c.outcome ? 'YES' : 'NO'} />
        <Stat label="Total stake" value={`${near(c.total_stake)} Ⓝ`} />
        <Stat label="Participants" value={String(c.participant_count)} />
        {!c.scores_public ? (
          <p className="muted-line small-caps">Probabilities and scores are public only after the Outcome is final.</p>
        ) : null}
      </div>
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Participant</th>
            <th className="num">Stake</th>
            <th className="num">Revealed</th>
            <th className="num">Brier (lower better)</th>
          </tr>
        </thead>
        <tbody>
          {c.participants.map((p) => (
            <tr key={p.account_id}>
              <td>
                <span className="num">{p.account_id}</span>{' '}
                {p.valid_revealer ? <Chip tone="ok">valid revealer</Chip> : <Chip tone="muted">no reveal</Chip>}
              </td>
              <td className="num">{near(p.stake)} Ⓝ</td>
              <td className="num">{p.revealed_prob_bps === null ? '—' : pct(p.revealed_prob_bps)}</td>
              <td className="num">{brier(p.brier)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Global leaderboard: Brier lower better, coverage = valid Reveals. */
export function LeaderboardPanel() {
  const { data, error, loading } = usePolling(() => api.leaderboard(), 30_000, []);

  if (loading) return <p className="muted-line">Loading leaderboard…</p>;
  if (error) return <ErrorNote message={error} />;
  if (!data || data.entries.length === 0) {
    return <EmptyState title="No scored rounds yet" detail="Brier scores appear once a Round resolves with Reveals. Coverage is valid Reveals only." />;
  }
  return <LeaderboardTable board={data} />;
}

/**
 * Live account economics: Bankroll / Available / locked / Claimable / pending /
 * received, wagering P&L, Query-Fee income, and actual gas — each reported
 * separately (gas is never netted into profit or fee income).
 */
export function EconomicsPanel() {
  const { data, error, loading } = usePolling(() => api.economics(), 30_000, []);

  if (loading) return <p className="muted-line">Loading economics…</p>;
  if (error) return <ErrorNote message={error} />;
  if (!data || data.accounts.length === 0) {
    return <EmptyState title="No economics yet" detail="Agent economics appear once rounds exist and the Operator journal has finalized transactions." />;
  }
  return <EconomicsTable report={data} />;
}

function EconomicsTable({ report }: { report: EconomicsReport }) {
  return (
    <div>
      <p className="muted-line small-caps">{report.separation_note}</p>
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Bankroll</th>
            <th className="num">Available</th>
            <th className="num">Locked</th>
            <th className="num">Claimable</th>
            <th className="num">Pending</th>
            <th className="num">Received</th>
            <th className="num">Wagering P&amp;L</th>
            <th className="num">Fee income</th>
            <th className="num">Gas</th>
          </tr>
        </thead>
        <tbody>
          {report.accounts.map((a) => (
            <tr key={a.account_id}>
              <td className="num">{a.account_id}</td>
              <td className="num">{a.bankroll === null ? '—' : `${near(a.bankroll)} Ⓝ`}</td>
              <td className="num">{a.available === null ? '—' : `${near(a.available)} Ⓝ`}</td>
              <td className="num">{near(a.locked_stake)} Ⓝ</td>
              <td className="num">{near(a.claimable)} Ⓝ</td>
              <td className="num">{near(a.pending)} Ⓝ</td>
              <td className="num">{near(a.received)} Ⓝ</td>
              <td className={`num ${BigInt(a.wagering_pnl) < 0n ? 'text-vermilion-700' : ''}`}>{near(a.wagering_pnl)} Ⓝ</td>
              <td className="num">{near(a.fee_income)} Ⓝ</td>
              <td className="num">{near(a.gas_burnt)} Ⓝ</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeaderboardTable({ board }: { board: GlobalLeaderboard }) {
  return (
    <div>
      <div className="comparison-head">
        <Stat label="Questions" value={String(board.total_questions)} />
        <Stat label="Resolved" value={String(board.resolved_questions)} />
        <p className="muted-line small-caps">{board.gas_disclosure}</p>
      </div>
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Brier</th>
            <th className="num">Coverage</th>
            <th className="num">Total stake</th>
            <th className="num">Locked</th>
          </tr>
        </thead>
        <tbody>
          {board.entries.map((e) => (
            <tr key={e.account_id}>
              <td className="num">{e.account_id}</td>
              <td className="num">{brier(e.brier_mean)}</td>
              <td className="num">{e.rounds_revealed}/{e.rounds_participated}</td>
              <td className="num">{near(e.total_stake)} Ⓝ</td>
              <td className="num">{near(e.locked_stake)} Ⓝ</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
