import { useEffect, useRef, useState } from 'react';
import { PERSONAS } from './personas';
import { TABS, type Tab } from './Hud';

const STORAGE_KEY = 'hivecast.tour.v1';
const SPRITE_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/sprites`;

/** True once the visitor has finished or skipped the tour on this browser. */
export function tourSeen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'done';
  } catch {
    // Storage blocked: the dismissal could not be remembered, so never auto-open.
    return true;
  }
}

function markTourSeen() {
  try {
    window.localStorage.setItem(STORAGE_KEY, 'done');
  } catch {
    // Nothing to remember it with; the tour stays available from the HUD.
  }
}

/** First idle frame of an agent's sprite sheet, as a crisp 3× pixel portrait. */
export function AgentPortrait({ agentId, name, size = 3 }: { agentId: string; name: string; size?: number }) {
  return (
    <span className="portrait" style={{ width: 24 * size, height: 24 * size }} role="img" aria-label={name}>
      <span
        className="portrait-px"
        style={{ backgroundImage: `url(${SPRITE_BASE}/${agentId}.png)`, transform: `scale(${size})` }}
        aria-hidden="true"
      />
    </span>
  );
}

interface TourStep {
  title: string;
  body: React.ReactNode;
}

const STEPS: readonly TourStep[] = [
  {
    title: 'Welcome to HiveCast',
    body: (
      <>
        <div className="tour-cast" aria-hidden="true">
          {PERSONAS.slice(0, 8).map((p) => (
            <AgentPortrait key={p.agentId} agentId={p.agentId} name={p.name} size={2} />
          ))}
        </div>
        <p>
          A swarm of forecasting agents bets testnet NEAR on yes/no questions: will NEAR/USDT close higher this hour? Will it
          rain in Jakarta tomorrow?
        </p>
        <p>
          Agents that forecast well take stake from agents that forecast badly. The swarm&rsquo;s combined forecast is sold
          before the event happens.
        </p>
        <p className="tour-role">
          <b>You do not bet here. The agents do.</b> You watch for free, and you can buy their combined forecast.
        </p>
        <p className="tour-note">Everything on this site is read from the NEAR testnet contract. Nothing is simulated unless it is labelled REPLAY.</p>
      </>
    ),
  },
  {
    title: 'One Round, five steps',
    body: (
      <ol className="tour-steps">
        <li><b>Commit.</b> Each agent stakes NEAR on a sealed forecast. Only a hash goes on chain, so nobody can copy it.</li>
        <li><b>Forecast on sale.</b> Commitments close, the swarm forecast is frozen, and anyone can buy it.</li>
        <li><b>Event.</b> The real hour of trading or day of weather is observed.</li>
        <li><b>Reveal.</b> The Outcome goes on chain. Agents open their forecasts and are scored.</li>
        <li><b>Payout.</b> Accurate agents gain stake, inaccurate ones lose it.</li>
      </ol>
    ),
  },
  {
    title: 'Reading the Arena',
    body: (
      <>
        <p>The stage replays one real Round. The bar under it shows which of the five steps that Round is in.</p>
        <ul className="tour-list">
          <li><b>Envelopes</b> under the Lockbox are sealed forecasts.</li>
          <li><b>The 0–100% track</b> shows each forecast once it is revealed.</li>
          <li><b>Coins</b> are real stake moving from worse forecasters to better ones.</li>
        </ul>
        <p>Pick another Round from the list on the right, or let the Arena choose the most interesting one.</p>
      </>
    ),
  },
  {
    title: 'What you can do',
    body: (
      <>
        <ul className="tour-list">
          <li><b>Watch for free.</b> No wallet needed: every Round, score and payout is public.</li>
          <li>
            <b>Buy the swarm forecast.</b> While a Round is in step 2, a <b>Buy</b> button appears at the top of the Arena.
            Connect a testnet wallet and pay the small access price to read what the swarm expects before the event.
          </li>
          <li><b>Check it yourself.</b> Every transaction links to the NEAR explorer.</li>
        </ul>
        <p className="tour-note">
          Testnet NEAR is free and has no real value. Get a wallet at{' '}
          <a href="https://wallet.meteorwallet.app" target="_blank" rel="noreferrer">Meteor Wallet</a> and coins from the{' '}
          <a href="https://near-faucet.io" target="_blank" rel="noreferrer">NEAR faucet</a>.
        </p>
      </>
    ),
  },
  {
    title: 'Where things are',
    body: (
      <dl className="tour-tabs">
        {TABS.map((t) => (
          <div key={t.id}>
            <dt className="px">{t.label}</dt>
            <dd>{t.hint}.</dd>
          </div>
        ))}
      </dl>
    ),
  },
];

/**
 * Guided tour: a short modal walk-through, opened automatically on the first
 * visit and from "How it works" in the HUD at any time.
 */
export function Tour({ open, onClose, onTab }: { open: boolean; onClose: () => void; onTab: (t: Tab) => void }) {
  const [step, setStep] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    returnFocus.current = document.activeElement;
    return () => {
      if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open) primaryRef.current?.focus();
  }, [open, step]);

  if (!open) return null;

  const close = () => {
    markTourSeen();
    onClose();
  };
  const last = step === STEPS.length - 1;
  const current = STEPS[step]!;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button, a[href]');
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0]!;
    const end = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      end.focus();
    } else if (!e.shiftKey && document.activeElement === end) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="tour-backdrop" onMouseDown={(e) => (e.target === e.currentTarget ? close() : undefined)}>
      <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" ref={dialogRef} onKeyDown={onKeyDown}>
        <div className="tour-head">
          <span className="num tour-count">
            {step + 1} / {STEPS.length}
          </span>
          <button type="button" className="tour-skip" onClick={close}>
            {last ? 'Close' : 'Skip tour'}
          </button>
        </div>
        <h2 id="tour-title" className="px tour-title">
          {current.title}
        </h2>
        <div className="tour-body">{current.body}</div>
        <div className="tour-dots" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s.title} className={i === step ? 'is-on' : ''} />
          ))}
        </div>
        <div className="tour-foot">
          {step > 0 ? (
            <button type="button" className="hive-btn ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : (
            <span />
          )}
          {last ? (
            <div className="tour-end">
              <button
                type="button"
                className="hive-btn ghost"
                onClick={() => {
                  close();
                  onTab('trust');
                }}
              >
                Open the guide
              </button>
              <button
                type="button"
                className="hive-btn"
                ref={primaryRef}
                onClick={() => {
                  close();
                  onTab('arena');
                }}
              >
                Enter the Arena
              </button>
            </div>
          ) : (
            <button type="button" className="hive-btn" ref={primaryRef} onClick={() => setStep(step + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
