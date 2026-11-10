import { DisclosurePanel } from './Disclosure';
import { HowItWorks, ReplayScore, TryOnTestnet } from './Intro';

const GLOSSARY: ReadonlyArray<[term: string, meaning: string]> = [
  ['Round', 'One yes/no question with a fixed schedule: commit, sale, event, reveal, payout.'],
  ['Agent', 'A NEAR account that forecasts with one fixed strategy and stakes its own bankroll.'],
  ['Stake', 'The NEAR an agent locks on its forecast. It is what the agent can win or lose.'],
  ['Commitment', 'The hash of a hidden forecast, stored on chain so the forecast cannot be changed or copied.'],
  ['Swarm forecast', 'The stake-weighted average of all committed forecasts, frozen when commitments close.'],
  ['Forecast Access', 'What a buyer pays for: the right to read the swarm forecast before the event starts.'],
  ['Outcome', 'YES or NO, recorded on chain from the pinned data source after the event.'],
  ['Reveal', 'An agent opening its commitment so everyone can check the forecast against the Outcome.'],
  ['Brier error', 'The squared distance between a forecast and the Outcome. 0 is perfect; always saying 50% scores 0.250.'],
];

/**
 * GUIDE: what HiveCast is, what a visitor can do, how to try it, the words it
 * uses, and (last) the trust boundary of the demo.
 */
export function GuidePage({ onTour, onSimulation }: { onTour: () => void; onSimulation: () => void }) {
  return (
    <main className="shell-main sheet-pad">
      <section className="mode-page guide">
        <div className="guide-lead">
          <h2 className="ledger-heading">What is HiveCast?</h2>
          <p className="hero-pitch">
            A swarm of forecasting agents stakes testnet NEAR on yes/no questions about the NEAR price and the weather. Accurate
            agents take stake from inaccurate ones, and the swarm&rsquo;s stake-weighted forecast is sold before the event starts.
          </p>
          <button type="button" className="btn" onClick={onTour}>
            Take the 1-minute tour
          </button>
        </div>

        <div className="guide-grid">
          <section>
            <h2 className="ledger-heading">How a Round works</h2>
            <HowItWorks />
          </section>
          <section>
            <h2 className="ledger-heading">What you can do</h2>
            <ul className="step-list">
              <li><b>Watch.</b> ARENA shows the current Round as it happens. No wallet needed.</li>
              <li><b>Buy the forecast.</b> In ROUNDS, open a Round marked on sale and buy access before the event starts.</li>
              <li><b>Compare.</b> After the Reveal, every agent&rsquo;s forecast, score and payout is public.</li>
              <li><b>Get your money back.</b> If a Round is cancelled, buyers can claim a refund from the same page.</li>
            </ul>
          </section>
          <section>
            <h2 className="ledger-heading">Try it on testnet</h2>
            <TryOnTestnet />
          </section>
          <ReplayScore onSimulation={onSimulation} />
        </div>

        <h2 className="ledger-heading">Glossary</h2>
        <dl className="glossary">
          {GLOSSARY.map(([term, meaning]) => (
            <div key={term} className="rule-b">
              <dt>{term}</dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>

        <h2 className="ledger-heading">Trust boundary</h2>
        <p className="muted-line guide-trust-lead">What the Operator of this demo can and cannot do, stated by the runner itself.</p>
        <DisclosurePanel />
      </section>
    </main>
  );
}
