import { useEffect, useMemo, useState } from 'react';
import './arena.css';
import { useClock } from '../lib/hooks';
import {
  brier as fmtBrier,
  explorerAccountUrl,
  explorerTxUrl,
  fmtDateTimeTz,
  countdown,
  near,
  nsDate,
  pct,
  questionDomain,
  sourceCity,
  sourceTimeZone,
} from '../lib/format';
import type {
  AccountEconomics,
  ActivityItem,
  AgentRosterEntry,
  GlobalLeaderboard,
  LlmRationale,
  PublicConfig,
  QuestionView,
} from '../lib/types';
import { agentIdForAccount, personaFor } from './personas';
import { clockIn, deriveScene, nextMilestone, pickDefaultRound, scheduleBoard, type Scene } from './scene';
import { nextSale, roundGuide } from './guide';
import type { Tab } from './Hud';
import { Stage } from './Stage';
import { useSpriteBank } from './useSpriteBank';
import { useArenaData, useRoundComparison } from './useArenaData';

function readRoundParam(): number | null {
  const raw = new URLSearchParams(window.location.search).get('round');
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

function writeRoundParam(id: number | null) {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete('round');
  else url.searchParams.set('round', String(id));
  window.history.replaceState(null, '', url);
}

const PHASE_LABEL: Record<string, string> = {
  open: 'OPEN',
  closed: 'CLOSED',
  resolved: 'RESOLVED',
  settled: 'SETTLED',
  cancelled: 'CANCELLED',
};

const NS_PER_MS = 1_000_000n;
const msOf = (ns: string): number => Number(BigInt(ns) / NS_PER_MS);

/** "Q12 · Price" / "Q7 · Jakarta rain": the short name of a Round. */
function roundName(q: QuestionView): string {
  return `Q${q.question_id} · ${questionDomain(q.source) === 'price' ? 'NEAR/USDT price' : `${sourceCity(q.source) ?? 'Weather'} rain`}`;
}

export function ArenaView({
  config,
  onOpenRound,
  onTab,
  onTour,
}: {
  config: PublicConfig | null;
  /** Opens a Round in ROUNDS, where the wallet purchase happens. */
  onOpenRound: (questionId: number) => void;
  onTab: (t: Tab) => void;
  /** Opens the guided tour. */
  onTour: () => void;
}) {
  const [pinnedId, setPinnedId] = useState<number | null>(readRoundParam);
  const data = useArenaData();
  const nowMs = useClock(10_000);
  const questions = data.questions.data;

  const selected: QuestionView | null = useMemo(() => {
    if (!questions) return null;
    if (pinnedId !== null) return questions.find((q) => q.question_id === pinnedId) ?? null;
    return pickDefaultRound(questions, nowMs);
  }, [questions, pinnedId, nowMs]);

  const selectedId = selected?.question_id ?? null;
  const roundData = useRoundComparison(selectedId);
  const roster = data.roster.data;

  const scene: Scene = useMemo(
    () =>
      deriveScene({
        question: selected,
        comparison: roundData.data,
        roster,
        economics: data.economics.data?.accounts ?? null,
        minStakeYocto: config?.minStakeYocto ?? null,
        nowMs,
      }),
    [selected, roundData.data, roster, data.economics.data, config?.minStakeYocto, nowMs],
  );

  const bank = useSpriteBank();
  const [replay, setReplay] = useState(0);
  const [hoverEnv, setHoverEnv] = useState<number | null>(null);
  const [pinnedEnv, setPinnedEnv] = useState<number | null>(null);
  useEffect(() => setPinnedEnv(null), [selectedId]);
  const envIndex = hoverEnv ?? pinnedEnv;
  const envActor = envIndex !== null ? scene.actors[envIndex] ?? null : null;

  const select = (id: number | null) => {
    setPinnedId(id);
    writeRoundParam(id);
  };

  const apiDown = data.questions.error !== null && !questions;
  const networkId = config?.networkId ?? 'testnet';

  const heraldInRoster = roster?.some((a) => a.agentId === 'llm-news') ?? false;

  return (
    <div className="arena">
      <p className="arena-lead">
        Forecasting agents bet testnet NEAR on yes/no questions. <b>You do not bet:</b> watch for free, or buy the agents&rsquo;
        combined forecast before the event.{' '}
        <button type="button" className="panel-link" onClick={onTour}>
          How it works
        </button>
      </p>
      {questions && questions.length > 0 ? (
        <SaleStrip questions={questions} selectedId={selectedId} onSelect={select} onBuy={onOpenRound} />
      ) : null}
      <div className="arena-main">
        <section className="arena-stage-col" aria-label="Round stage">
          <div className="stage-head">
            <span className="env-chip env-live">LIVE · NEAR {networkId.toUpperCase()}</span>
            <span className="px stage-title">{selected ? `Round ${roundName(selected)}` : 'The Hive Arena'}</span>
            <div className="stage-actions">
              {pinnedId !== null ? (
                <button type="button" className="hive-btn ghost" onClick={() => select(null)} title="Let the Arena pick the most interesting Round again">
                  ↩ Follow live
                </button>
              ) : null}
              <button
                type="button"
                className="hive-btn ghost"
                onClick={() => setReplay((r) => r + 1)}
                disabled={scene.kind === 'no-data'}
                title="Play this Round's animation again"
              >
                ▶ Play again
              </button>
            </div>
          </div>
          {/* The Round card carries the question beside the stage; stacked layouts need it above the stage. */}
          {selected ? <p className="stage-question">{selected.text}</p> : null}
          <Stage
            scene={scene}
            bank={bank}
            replayToken={replay}
            highlightEnvelope={envIndex}
            onEnvelope={(i, commit) => (commit ? setPinnedEnv(i) : setHoverEnv(i))}
          />
          <div className="stage-caption" aria-live="polite">
            <p className="px banner-text">{scene.banner}</p>
            {scene.subline ? <p className="num subline">{scene.subline}</p> : null}
            {scene.sealed && scene.kind !== 'no-data' ? (
              <p className="num subline">
                SEALED {scene.sealed.n}
                {scene.sealed.m !== null ? `/${scene.sealed.m}` : ''} · commitments on chain
              </p>
            ) : null}
            {apiDown ? <p className="no-data">NO DATA YET — runner API unreachable ({data.questions.error})</p> : null}
            {!apiDown && questions && questions.length === 0 ? <p className="no-data">NO DATA YET — no Rounds on chain</p> : null}
          </div>
          <div className="envelope-readout num" aria-live="polite">
            {envActor ? (
              <>
                <span className="px">Envelope</span> {envActor.name} · sealed forecast hash{' '}
                <span title={envActor.commitmentHash}>{envActor.commitmentHash.slice(0, 10)}…{envActor.commitmentHash.slice(-6)}</span>
              </>
            ) : null}
          </div>
          {selected ? <RoundGuidePanel q={selected} scene={scene} nowMs={nowMs} onOpenRound={onOpenRound} /> : null}
          <CastTable scene={scene} highlight={envIndex} onPick={(i) => setPinnedEnv(i)} />
        </section>

        <aside className="arena-rail" aria-label="Round card">
          <RoundCard q={selected} scene={scene} loading={data.questions.loading} />
          <ScheduleBoard questions={questions ?? []} selectedId={selectedId} onSelect={select} onAll={() => onTab('ledger')} />
        </aside>
      </div>

      <div className="arena-below">
        <HallOfFame
          leaderboard={data.leaderboard.data}
          economics={data.economics.data?.accounts ?? null}
          economicsCoverage={data.economics.data?.coverage ?? null}
          roster={roster}
          minStake={config?.minStakeYocto ?? null}
          error={data.leaderboard.error}
          onAll={() => onTab('agents')}
        />
        {/* Herald's panel only exists while Herald plays or has something revealed. */}
        {heraldInRoster || data.herald.data ? (
          <HeraldScroll
            herald={data.herald.data}
            loading={data.herald.loading}
            error={data.herald.error ?? (apiDown ? data.questions.error : null)}
          />
        ) : null}
        <NearFeed
          items={data.activity.data?.items ?? null}
          note={data.activity.data?.coverage_note ?? null}
          error={data.activity.error}
          roster={roster}
          networkId={networkId}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** One line above the stage: the forecast sale a visitor can still catch. */
function SaleStrip({
  questions,
  selectedId,
  onSelect,
  onBuy,
}: {
  questions: readonly QuestionView[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Opens the Round in ROUNDS, where the wallet purchase happens. */
  onBuy: (id: number) => void;
}) {
  const now = useClock(1000);
  const sale = nextSale(questions, now);
  if (!sale) {
    return (
      <p className="sale-strip is-idle">
        <span className="px sale-tag">Forecast sale</span>
        <span>No Round has a forecast sale ahead right now. Finished Rounds stay open to read.</span>
      </p>
    );
  }
  const q = sale.question;
  const tz = sourceTimeZone(q.source);
  const watching = selectedId === q.question_id;
  return (
    <p className={`sale-strip ${sale.state === 'on-sale' ? 'is-on' : ''}`}>
      <span className="px sale-tag">{sale.state === 'on-sale' ? 'On sale now' : 'Next forecast sale'}</span>
      <span>
        <b>{roundName(q)}</b>
        {sale.state === 'on-sale' ? (
          <>
            {' '}
            · closes {clockIn(msOf(sale.untilNs), tz)} <span className="countdown num">(in {countdown(sale.untilNs, now).label})</span>
          </>
        ) : (
          <>
            {' '}
            · starts after commitments close at {clockIn(msOf(sale.fromNs), tz)}{' '}
            <span className="countdown num">(in {countdown(sale.fromNs, now).label})</span>, ends {clockIn(msOf(sale.untilNs), tz)}
          </>
        )}
      </span>
      <span className="sale-actions">
        {watching ? (
          <span className="muted">Shown below</span>
        ) : (
          <button type="button" className="hive-btn ghost" onClick={() => onSelect(q.question_id)}>
            Show this Round
          </button>
        )}
        {sale.state === 'on-sale' ? (
          <button type="button" className="hive-btn" onClick={() => onBuy(q.question_id)}>
            Buy forecast · {near(q.access_price)} NEAR →
          </button>
        ) : null}
      </span>
    </p>
  );
}

/** Under the stage: the five steps of the Round, what is happening, what the visitor can do. */
function RoundGuidePanel({
  q,
  scene,
  nowMs,
  onOpenRound,
}: {
  q: QuestionView;
  scene: Scene;
  nowMs: number;
  onOpenRound: (id: number) => void;
}) {
  if (scene.kind === 'no-data') return null;
  const g = roundGuide(q, scene.kind, nowMs);
  return (
    <div className="hive-panel round-guide">
      <ol className="steps" aria-label="Round progress">
        {g.steps.map((s, i) => (
          <li
            key={s.id}
            className={`step is-${s.state}`}
            title={s.hint}
            aria-label={`Step ${i + 1}, ${s.label}: ${s.state}`}
            aria-current={s.state === 'current' ? 'step' : undefined}
          >
            <span className="step-dot num" aria-hidden="true">
              {s.state === 'done' ? '✓' : i + 1}
            </span>
            <span className="px step-label">{s.label}</span>
          </li>
        ))}
      </ol>
      <p className="guide-line">
        <span className="px guide-tag">Now</span>
        <span>{g.now}</span>
      </p>
      {g.action ? (
        <p className="guide-line">
          <span className="px guide-tag">You can</span>
          <span>{g.action}</span>
        </p>
      ) : null}
      {g.canBuy ? (
        <>
          <button type="button" className="hive-btn buy" onClick={() => onOpenRound(q.question_id)}>
            Buy the {q.participant_count === 1 ? 'Single-agent Forecast' : 'swarm forecast'} · {near(q.access_price)} NEAR →
          </button>
          <p className="fine">Opens this Round in ROUNDS, where you connect a testnet wallet and pay. Nothing is charged here.</p>
        </>
      ) : null}
    </div>
  );
}

function CastTable({ scene, highlight, onPick }: { scene: Scene; highlight: number | null; onPick: (i: number) => void }) {
  if (scene.kind === 'no-data') return null;
  const settled = scene.kind === 'settled';
  return (
    <div className="hive-panel">
      <h3 className="px panel-title">Agents in this Round</h3>
      {scene.actors.length === 0 ? (
        <p className="no-data">NO DATA YET — no commitments recorded for this Round.</p>
      ) : (
        <div className="scroll-x">
          <table className="hive-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="r" title="NEAR the agent locked on its forecast">Stake</th>
                <th title="Hash of the hidden forecast, stored on chain at commit time">Sealed hash</th>
                <th title="The probability of YES the agent committed to. Hidden until its Reveal.">Forecast</th>
                <th className="r" title="Brier error: squared distance from the Outcome. 0 is perfect, 0.250 is always saying 50%.">Error</th>
                {settled ? <th className="r" title="What the agent gained or lost in this Round">Won / lost</th> : null}
              </tr>
            </thead>
            <tbody>
              {scene.actors.map((a, i) => (
                <tr key={a.accountId} className={highlight === i ? 'is-hl' : ''}>
                  <td>
                    <span className="swatch" style={{ background: a.color }} aria-hidden="true" /> <span title={a.agentId}>{a.name}</span>
                  </td>
                  <td className="r num">{near(a.stake, 4)} NEAR</td>
                  <td className="num">
                    <button type="button" className="hash-btn" title={a.commitmentHash} onClick={() => onPick(i)}>
                      {a.commitmentHash.slice(0, 10)}…
                    </button>
                  </td>
                  <td className={`num ${a.result === 'win' ? 'gain' : a.result === 'lose' ? 'loss' : ''}`}>
                    {a.revealedBps !== null ? pct(a.revealedBps) : a.label ?? '—'}
                  </td>
                  <td className="r num">{fmtBrier(a.brier)}</td>
                  {settled ? (
                    <td className={`r num ${a.result === 'win' ? 'gain' : a.result === 'lose' ? 'loss' : ''}`}>
                      {a.net === null ? '—' : `${BigInt(a.net) > 0n ? '+' : ''}${near(a.net, 4)} NEAR`}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {settled && scene.actors.some((a) => a.net !== null) ? (
        <p className="fine">Won / lost = base payout + Query-Fee share − stake, recomputed from on-chain data with the shared core settle() (labelled computed by the runner).</p>
      ) : null}
      {scene.bench.length > 0 ? (
        <p className="bench-line">
          <span className="px">Sitting out:</span>{' '}
          {scene.bench.map((b, i) => (
            <span key={b.accountId} className="bench-item">
              {i > 0 ? ' · ' : ''}
              {b.name} <span className="muted">({b.reason})</span>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

function RoundCard({ q, scene, loading }: { q: QuestionView | null; scene: Scene; loading: boolean }) {
  const now = useClock(1000);
  if (!q) {
    return (
      <div className="hive-panel round-card">
        <h3 className="px panel-title">Round</h3>
        <p className="no-data">{loading ? 'Loading Rounds…' : 'NO DATA YET'}</p>
      </div>
    );
  }
  const domain = questionDomain(q.source);
  const tz = sourceTimeZone(q.source);
  const city = sourceCity(q.source);
  const ms = nextMilestone(q, now);
  return (
    <div className="hive-panel round-card">
      <div className="round-card-head">
        <h3 className="px panel-title">The question</h3>
        <span className={`phase-pill phase-${q.phase}`}>{PHASE_LABEL[q.phase] ?? q.phase}</span>
      </div>
      <p className="round-q">{q.text}</p>
      <dl className="round-facts">
        <dt>Topic</dt>
        <dd>{domain === 'price' ? 'Price · NEAR/USDT 1h' : `Weather · ${city ?? 'city unknown'}`}</dd>
        {ms ? (
          <>
            <dt>{ms.label}</dt>
            <dd className="num">
              {fmtDateTimeTz(ms.ns, tz)}
              <br />
              <span className="countdown">in {countdown(ms.ns, now).label}</span>
            </dd>
          </>
        ) : (
          <>
            <dt>Event</dt>
            <dd className="num">{fmtDateTimeTz(q.observation_start, tz)} → {fmtDateTimeTz(q.observation_end, tz)}</dd>
          </>
        )}
        <dt>Agents in</dt>
        <dd className="num">
          {q.participant_count}
          {q.participant_count === 1 ? ' · Single-agent Forecast' : ''}
        </dd>
        <dt>Total stake</dt>
        <dd className="num">{near(q.total_stake, 4)} NEAR</dd>
        {scene.outcome !== null ? (
          <>
            <dt>Outcome</dt>
            <dd className={`num ${scene.outcome ? 'gain' : ''}`}>{scene.outcome ? 'YES' : 'NO'}</dd>
          </>
        ) : null}
        <dt>Forecast buyers</dt>
        <dd className="num">{q.buyer_count}</dd>
      </dl>
    </div>
  );
}

function ScheduleBoard({
  questions,
  selectedId,
  onSelect,
  onAll,
}: {
  questions: readonly QuestionView[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onAll: () => void;
}) {
  const { upcoming, recent } = scheduleBoard(questions);
  const row = (q: QuestionView) => {
    const domain = questionDomain(q.source);
    const tz = sourceTimeZone(q.source);
    const when = nsDate(q.observation_start).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
    return (
      <li key={q.question_id}>
        <button type="button" className={`sched-row ${selectedId === q.question_id ? 'is-sel' : ''}`} onClick={() => onSelect(q.question_id)}>
          <span className="num">Q{q.question_id}</span>
          <span>{domain === 'price' ? 'Price' : sourceCity(q.source) ?? 'Weather'}</span>
          <span className="num muted">{when}</span>
          <span className={`phase-pill phase-${q.phase}`}>{PHASE_LABEL[q.phase]}</span>
        </button>
      </li>
    );
  };
  return (
    <div className="hive-panel">
      <div className="panel-head">
        <h3 className="px panel-title">Pick a Round</h3>
        <button type="button" className="panel-link" onClick={onAll}>
          All Rounds →
        </button>
      </div>
      <h4 className="px sub-title">Live and upcoming</h4>
      {upcoming.length ? <ul className="sched">{upcoming.map(row)}</ul> : <p className="no-data">NO DATA YET — no open or closed Rounds right now.</p>}
      <h4 className="px sub-title">Finished</h4>
      {recent.length ? <ul className="sched">{recent.map(row)}</ul> : <p className="no-data">NO DATA YET</p>}
    </div>
  );
}

function HallOfFame({
  leaderboard,
  economics,
  economicsCoverage,
  roster,
  minStake,
  error,
  onAll,
}: {
  leaderboard: GlobalLeaderboard | null;
  economics: readonly AccountEconomics[] | null;
  economicsCoverage: 'complete' | 'partial' | null;
  roster: readonly AgentRosterEntry[] | null;
  minStake: string | null;
  error: string | null;
  onAll: () => void;
}) {
  const rows = leaderboard?.entries.filter((e) => e.rounds_participated > 0) ?? [];
  return (
    <section className="hive-panel" aria-label="Hall of Fame">
      <div className="panel-head">
        <h3 className="px panel-title">Hall of Fame</h3>
        <button type="button" className="panel-link" onClick={onAll}>
          Meet the agents →
        </button>
      </div>
      {!leaderboard ? (
        <p className="no-data">{error ? `NO DATA YET — ${error}` : 'Loading…'}</p>
      ) : rows.length === 0 ? (
        <p className="no-data">NO DATA YET — no Rounds joined.</p>
      ) : (
        <div className="scroll-x">
          <table className="hive-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th className="r" title="Mean Brier error across revealed Rounds. Lower is better.">Error ↓</th>
                <th className="r" title="Rounds the agent committed to">Rounds</th>
                <th className="r" title="NEAR the agent holds, in the contract and in its account">Bankroll</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => {
                const agentId = agentIdForAccount(e.account_id, roster);
                const persona = personaFor(agentId);
                const econ = economics?.find((x) => x.account_id === e.account_id) ?? null;
                const broke = econ?.available != null && minStake !== null && BigInt(econ.available) < BigInt(minStake);
                return (
                  <tr key={e.account_id}>
                    <td className="num">{e.brier_mean === null ? '—' : i + 1}</td>
                    <td>
                      <span className="swatch" style={{ background: persona.color }} aria-hidden="true" /> {persona.name}
                      {broke ? (
                        <span className="skull loss" title="Available balance below the minimum stake">
                          {' '}
                          ☠ out of capital
                        </span>
                      ) : null}
                    </td>
                    <td className="r num">{fmtBrier(e.brier_mean)}</td>
                    <td className="r num">
                      {e.rounds_participated}
                      {e.rounds_revealed !== e.rounds_participated ? <span className="muted"> ({e.rounds_revealed} revealed)</span> : null}
                    </td>
                    <td className="r num">{econ?.bankroll ? `${near(econ.bankroll, 3)} NEAR` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine">
        Ranked by forecast error (Brier): lower is better, and always saying 50% scores 0.250.
        {economicsCoverage === 'partial' ? ' Bankroll shows — while the runner reports partial coverage (never a partial sum as a total).' : ''}
      </p>
    </section>
  );
}

function HeraldScroll({
  herald,
  loading,
  error,
}: {
  herald: { question: QuestionView; rationale: LlmRationale } | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <section className="hive-panel scroll" aria-label="Herald's Scroll">
      <h3 className="px panel-title">Herald's Scroll</h3>
      {herald ? (
        <>
          <p className="num subline">
            Q{herald.question.question_id} · revealed {pct(herald.rationale.revealed_prob_bps)}
            {herald.rationale.matches_reveal ? ' · matches on-chain Reveal' : ' · DOES NOT match the Reveal'}
          </p>
          <blockquote className="rationale">{herald.rationale.rationale}</blockquote>
          {herald.rationale.headlines.length ? (
            <ul className="headlines">
              {herald.rationale.headlines.map((h) => (
                <li key={`${h.source}-${h.published_at}-${h.title}`}>
                  {h.title} <span className="muted num">— {h.source}, {h.published_at.replace('T', ' ').slice(0, 16)} UTC</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No headlines were available before the cutoff.</p>
          )}
          <p className="fine">
            {herald.rationale.model} · {herald.rationale.provider}. Released only after Herald's on-chain Reveal.
          </p>
        </>
      ) : (
        <p className="no-data">{loading ? 'Loading…' : error ? `NO DATA YET — ${error}` : 'NO DATA YET — Herald has no revealed rationale yet (it joins live price Rounds only).'}</p>
      )}
    </section>
  );
}

const KIND_LABEL: Record<ActivityItem['kind'], string> = {
  create: 'CREATE',
  commit: 'COMMIT',
  snapshot: 'SNAPSHOT',
  buy: 'BUY',
  resolve: 'RESOLVE',
  reveal: 'REVEAL',
  settle: 'SETTLE',
  cancel: 'CANCEL',
  refund: 'REFUND',
  withdraw: 'WITHDRAW',
};

/** Rows of the feed shown before "Show all". */
const FEED_PREVIEW = 6;

function NearFeed({
  items,
  note,
  error,
  roster,
  networkId,
}: {
  items: ActivityItem[] | null;
  note: string | null;
  error: string | null;
  roster: readonly AgentRosterEntry[] | null;
  networkId: string;
}) {
  const [all, setAll] = useState(false);
  const shown = items === null ? [] : all ? items : items.slice(0, FEED_PREVIEW);
  return (
    <section className="hive-panel" aria-label="On NEAR feed">
      <h3 className="px panel-title">On NEAR</h3>
      <p className="fine feed-lead">Every step is a real testnet transaction. Each row links to the explorer.</p>
      {items === null ? (
        <p className="no-data">{error ? `NO DATA YET — ${error}` : 'Loading…'}</p>
      ) : items.length === 0 ? (
        <p className="no-data">NO DATA YET — this runner has no finalized transactions recorded.</p>
      ) : (
        <ul className="feed">
          {shown.map((it) => {
            const agentId = agentIdForAccount(it.account_id, roster);
            const persona = personaFor(agentId);
            return (
              <li key={it.tx_hash}>
                <span className={`kind kind-${it.kind}`}>{KIND_LABEL[it.kind]}</span>
                <span>{it.question_id !== null ? `Q${it.question_id}` : ''}</span>
                <a href={explorerAccountUrl(networkId, it.account_id)} target="_blank" rel="noreferrer">
                  {persona.name === it.account_id ? it.account_id : persona.name}
                </a>
                <span className="num muted">{it.finalized_at ? fmtDateTimeTz(it.finalized_at, 'UTC') : 'time unavailable'}</span>
                <a className="num" href={explorerTxUrl(networkId, it.tx_hash)} target="_blank" rel="noreferrer" title={it.tx_hash}>
                  {it.tx_hash.slice(0, 8)}… ↗
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {items !== null && items.length > FEED_PREVIEW ? (
        <button type="button" className="panel-link feed-more" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      ) : null}
      {note ? <p className="fine">{note}</p> : null}
    </section>
  );
}
