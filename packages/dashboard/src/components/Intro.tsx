import { usePolling } from '../lib/hooks';
import { api } from '../lib/api';
import type { DomainResult } from '../lib/types';
import { brier } from '../lib/format';

/** Headline numbers from the offline replay: swarm vs best single agent vs baseline. */
function headline(d: DomainResult) {
  const swarm = d.aggregates.find((a) => a.kind === 'stake-weighted');
  const best = d.agents
    .filter((a) => a.brierMean !== null)
    .sort((a, b) => (a.brierMean ?? 1) - (b.brierMean ?? 1))[0];
  const c50 = d.baselines?.find((b) => b.kind === 'constant-50');
  const rate = d.baselines?.find((b) => b.kind === 'running-base-rate');
  return { swarm, best, c50, rate };
}

function ScoreLine({ title, d }: { title: string; d: DomainResult }) {
  const { swarm, best, c50, rate } = headline(d);
  return (
    <div className="score-line">
      <span className="small-caps">{title}</span>
      <dl className="score-grid num">
        <div><dt>Swarm</dt><dd className="is-accent">{brier(swarm?.brierMean ?? null)}</dd></div>
        <div><dt>Best agent{best ? ` · ${best.agentId}` : ''}</dt><dd>{brier(best?.brierMean ?? null)}</dd></div>
        <div><dt>Always 50%</dt><dd>{brier(c50?.brierMean ?? null)}</dd></div>
        <div><dt>Past YES rate</dt><dd>{brier(rate?.brierMean ?? null)}</dd></div>
      </dl>
    </div>
  );
}

/** The four moves of a Round, in plain language. */
export function HowItWorks() {
  return (
    <ol className="step-list">
      <li><b>Commit.</b> Each agent stakes NEAR on a hidden probability (only a hash goes on chain).</li>
      <li><b>Buy.</b> After cutoff, anyone can pay the access price to read the frozen swarm forecast before the event starts.</li>
      <li><b>Resolve &amp; reveal.</b> The Outcome is recorded from the pinned source; agents reveal and are scored by Brier. The LLM agent&rsquo;s headlines and reasoning are published at its Reveal.</li>
      <li><b>Settle.</b> Better-than-average agents gain stake, worse ones lose it; buyers&rsquo; fees go to agents who revealed.</li>
    </ol>
  );
}

/** Wallet steps for a first-time testnet visitor. */
export function TryOnTestnet() {
  return (
    <ol className="step-list">
      <li>
        Create a testnet wallet in{' '}
        <a className="link" href="https://wallet.meteorwallet.app" target="_blank" rel="noreferrer">Meteor Wallet</a>{' '}
        (switch the network to <span className="num">testnet</span>).
      </li>
      <li>
        Get free testnet NEAR from the{' '}
        <a className="link" href="https://near-faucet.io" target="_blank" rel="noreferrer">NEAR faucet</a>. It has no real value.
      </li>
      <li>Press <b>Connect wallet</b>, then pick a Round marked <span className="chip text-state-ok">on sale</span> and buy access.</li>
      <li>Sign the login message (free, no transaction) to read the forecast. Re-reading never charges again.</li>
    </ol>
  );
}

/** Honest replay scoreboard: swarm vs best single agent vs baselines. */
export function ReplayScore({ onSimulation }: { onSimulation: () => void }) {
  const { data } = usePolling(() => api.simulation(), 300_000, []);
  if (!data) return null;
  return (
    <section>
      <h2 className="ledger-heading">Does the swarm beat its agents?</h2>
      <p className="muted-line">Offline replay, Aug–Sep 2026, Brier score (lower is better).</p>
      <ScoreLine title={`Weather · rain at ${data.config.weatherLocation ?? 'one city'}, ${data.config.weatherRounds} days`} d={data.weather} />
      <ScoreLine title="Price · NEAR/USDT hourly, 1440 hours" d={data.price} />
      <button type="button" className="btn btn-ghost" onClick={onSimulation}>
        See the bankroll race
      </button>
    </section>
  );
}
