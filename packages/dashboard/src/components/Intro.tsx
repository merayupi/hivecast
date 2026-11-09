import { usePolling } from '../lib/hooks';
import { api } from '../lib/api';
import type { DomainResult } from '../lib/types';
import { brier } from '../lib/format';

/**
 * One-line pitch shown above the live view, so a first-time visitor knows what
 * the page is before reading a single Round.
 */
export function HeroLine() {
  return (
    <div className="hero-line rule-b">
      <p className="hero-pitch">
        Eight algorithmic agents and one LLM agent stake testnet NEAR on yes/no forecasts. Accurate agents take stake from inaccurate ones,
        and the swarm&rsquo;s stake-weighted forecast is sold for 0.01&nbsp;NEAR before the event starts.
      </p>
    </div>
  );
}

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

/**
 * Right-hand panel when no Round is selected: how it works, how to try it on
 * testnet, and the honest replay scoreboard.
 */
export function TryItPanel({ onSimulation }: { onSimulation: () => void }) {
  const { data } = usePolling(() => api.simulation(), 300_000, []);
  return (
    <div className="try-panel">
      <section>
        <h2 className="ledger-heading">How a Round works</h2>
        <ol className="step-list">
          <li><b>Commit.</b> Each agent stakes NEAR on a hidden probability (only a hash goes on chain).</li>
          <li><b>Buy.</b> After cutoff, anyone can pay 0.01 NEAR to read the frozen swarm forecast before the event starts.</li>
          <li><b>Resolve &amp; reveal.</b> The Outcome is recorded from the pinned source; agents reveal and are scored by Brier. The LLM agent&rsquo;s headlines and reasoning are published at its Reveal.</li>
          <li><b>Settle.</b> Better-than-average agents gain stake, worse ones lose it; buyers&rsquo; fees go to agents who revealed.</li>
        </ol>
      </section>

      <section>
        <h2 className="ledger-heading">Try it on testnet</h2>
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
          <li>Press <b>Connect wallet</b>, then pick a Round marked <span className="chip text-state-ok">snapshot ready</span> and buy access.</li>
          <li>Sign the login message (free, no transaction) to read the forecast. Re-reading never charges again.</li>
        </ol>
      </section>

      {data ? (
        <section>
          <h2 className="ledger-heading">Does the swarm beat its agents?</h2>
          <p className="muted-line">Offline replay, Aug–Sep 2026, Brier score (lower is better).</p>
          <ScoreLine title={`Weather · rain at ${data.config.weatherLocation ?? 'one city'}, ${data.config.weatherRounds} days`} d={data.weather} />
          <ScoreLine title="Price · NEAR/USDT hourly, 1440 hours" d={data.price} />
          <button type="button" className="btn btn-ghost" onClick={onSimulation}>
            See the bankroll race
          </button>
        </section>
      ) : null}
    </div>
  );
}
