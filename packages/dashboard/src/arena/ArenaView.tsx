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
import { deriveScene, nextMilestone, pickDefaultRound, scheduleBoard, type Scene } from './scene';
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

export function ArenaView({ config, onBuy }: { config: PublicConfig | null; onBuy: (questionId: number) => void }) {
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

  return (
    <div className="arena">
      <div className="arena-main">
        <section className="arena-stage-col" aria-label="Round stage">
          <div className="stage-head">
            <span className="env-chip env-live">LIVE · NEAR {networkId.toUpperCase()}</span>
            <span className="px stage-title">
              {selected ? `Round Q${selected.question_id}` : 'The Hive Arena'}
            </span>
            <div className="stage-actions">
              {pinnedId !== null ? (
                <button type="button" className="hive-btn ghost" onClick={() => select(null)}>
                  Auto-pick
                </button>
              ) : null}
              <button type="button" className="hive-btn" onClick={() => setReplay((r) => r + 1)} disabled={scene.kind === 'no-data'}>
                Replay
              </button>
            </div>
          </div>
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
                <span className="px">Envelope</span> {envActor.name} · commitment <span title={envActor.commitmentHash}>{envActor.commitmentHash.slice(0, 10)}…{envActor.commitmentHash.slice(-6)}</span>
              </>
            ) : scene.actors.length > 0 ? (
              <span className="muted">Hover or click an envelope under the Lockbox to see its commitment hash.</span>
            ) : null}
          </div>
          <CastTable scene={scene} highlight={envIndex} onPick={(i) => setPinnedEnv(i)} />
        </section>

        <aside className="arena-rail" aria-label="Round card">
          <RoundCard q={selected} scene={scene} onBuy={onBuy} loading={data.questions.loading} />
          <ScheduleBoard questions={questions ?? []} selectedId={selectedId} onSelect={select} />
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
        />
        <HeraldScroll
          herald={data.herald.data}
          loading={data.herald.loading}
          error={data.herald.error ?? (apiDown ? data.questions.error : null)}
        />
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

function CastTable({ scene, highlight, onPick }: { scene: Scene; highlight: number | null; onPick: (i: number) => void }) {
  if (scene.kind === 'no-data') return null;
  const settled = scene.kind === 'settled';
  return (
    <div className="hive-panel">
      <h3 className="px panel-title">On stage</h3>
      {scene.actors.length === 0 ? (
        <p className="no-data">NO DATA YET — no commitments recorded for this Round.</p>
      ) : (
        <div className="scroll-x">
          <table className="hive-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="r">Stake</th>
                <th>Commitment</th>
                <th>Status</th>
                <th className="r">Brier</th>
                {settled ? <th className="r">Net payout</th> : null}
              </tr>
            </thead>
            <tbody>
              {scene.actors.map((a, i) => (
                <tr key={a.accountId} className={highlight === i ? 'is-hl' : ''}>
                  <td>
                    <span className="swatch" style={{ background: a.color }} aria-hidden="true" /> {a.name}{' '}
                    <span className="muted num">{a.agentId}</span>
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
        <p className="fine">Net = base payout + Query-Fee share − stake, recomputed from on-chain data with the shared core settle() (labelled computed by the runner).</p>
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

function RoundCard({ q, scene, onBuy, loading }: { q: QuestionView | null; scene: Scene; onBuy: (id: number) => void; loading: boolean }) {
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
  const onSale = q.phase === 'closed' && q.snapshot_ready && now < Number(BigInt(q.observation_start) / 1_000_000n);
  return (
    <div className="hive-panel round-card">
      <div className="round-card-head">
        <h3 className="px panel-title">Round Q{q.question_id}</h3>
        <span className={`phase-pill phase-${q.phase}`}>{PHASE_LABEL[q.phase] ?? q.phase}</span>
      </div>
      <p className="round-q">{q.text}</p>
      <dl className="round-facts">
        <dt>Domain</dt>
        <dd>{domain === 'price' ? 'Price · NEAR/USDT 1h' : `Weather · ${city ?? 'city unknown'}`}</dd>
        <dt>Time zone</dt>
        <dd className="num">{tz}</dd>
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
        <dt>Participants</dt>
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
        <dt>Buyers</dt>
        <dd className="num">{q.buyer_count}</dd>
      </dl>
      {onSale ? (
        <button type="button" className="hive-btn buy" onClick={() => onBuy(q.question_id)}>
          Buy the swarm forecast · {near(q.access_price)} NEAR →
        </button>
      ) : null}
      {onSale ? <p className="fine">Opens this Round in LEDGER, where the wallet purchase and NEP-413 read happen.</p> : null}
    </div>
  );
}

function ScheduleBoard({ questions, selectedId, onSelect }: { questions: readonly QuestionView[]; selectedId: number | null; onSelect: (id: number) => void }) {
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
      <h3 className="px panel-title">Schedule board</h3>
      <h4 className="px sub-title">Upcoming</h4>
      {upcoming.length ? <ul className="sched">{upcoming.map(row)}</ul> : <p className="no-data">NO DATA YET — no open or closed Rounds right now.</p>}
      <h4 className="px sub-title">Recent</h4>
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
}: {
  leaderboard: GlobalLeaderboard | null;
  economics: readonly AccountEconomics[] | null;
  economicsCoverage: 'complete' | 'partial' | null;
  roster: readonly AgentRosterEntry[] | null;
  minStake: string | null;
  error: string | null;
}) {
  const rows = leaderboard?.entries.filter((e) => e.rounds_participated > 0) ?? [];
  return (
    <section className="hive-panel" aria-label="Hall of Fame">
      <h3 className="px panel-title">Hall of Fame</h3>
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
                <th className="r">Brier ↓</th>
                <th className="r">Rounds</th>
                <th className="r">Bankroll</th>
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
        Brier error, lower is better (0.250 = always 50%).
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
  return (
    <section className="hive-panel" aria-label="On NEAR feed">
      <h3 className="px panel-title">On NEAR</h3>
      {items === null ? (
        <p className="no-data">{error ? `NO DATA YET — ${error}` : 'Loading…'}</p>
      ) : items.length === 0 ? (
        <p className="no-data">NO DATA YET — this runner has no finalized transactions recorded.</p>
      ) : (
        <ul className="feed">
          {items.map((it) => {
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
      {note ? <p className="fine">{note}</p> : null}
    </section>
  );
}
