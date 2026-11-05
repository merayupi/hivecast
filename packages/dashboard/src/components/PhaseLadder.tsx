import type { QuestionView } from '../lib/types';
import { countdown, fmtDateTimeTz, domainTimeZone, questionDomain } from '../lib/format';

interface Milestone {
  key: string;
  label: string;
  ns: string | null;
}

function milestones(q: QuestionView): Milestone[] {
  return [
    { key: 'open', label: 'Opening', ns: q.open_time },
    { key: 'cutoff', label: 'Commitment cutoff', ns: q.close_time },
    { key: 'snapshot', label: 'Snapshot sale', ns: q.observation_start },
    { key: 'observe', label: 'Observation', ns: q.observation_end },
    { key: 'resolve', label: 'Resolution deadline', ns: q.resolve_deadline },
    { key: 'reveal', label: 'Reveal deadline', ns: q.reveal_deadline },
  ];
}

/** The Round lifecycle as a ruled detent track — the dashboard's signature move. */
export function PhaseLadder({ q }: { q: QuestionView }) {
  const nowMs = Date.now();
      const points = milestones(q);
  const revealed = q.reveal_deadline !== null;

  // Determine the active index (the detent "now" sits at/after).
  const nowNs = BigInt(nowMs) * 1_000_000n;
  let active = -1;
  for (let i = 0; i < points.length; i++) {
    const ns = points[i]!.ns;
    if (ns === null) continue;
    if (BigInt(ns) <= nowNs) active = i;
  }
  const terminal = q.phase === 'settled' || q.phase === 'cancelled';

  return (
    <div className="phase-ladder" role="img" aria-label={`Lifecycle phase: ${q.phase}`}>
      <div className="phase-track">
        {points.map((p, i) => {
          if (p.ns === null) return <div key={p.key} className="phase-detent is-null" />;
          const done = i <= active;
          return (
            <div key={p.key} className="phase-node">
              <span className={`phase-detent ${done ? 'is-done' : ''} ${i === active && !terminal ? 'is-now' : ''}`} />
              <span className="phase-label small-caps">{p.label}</span>
            </div>
          );
        })}
      </div>
      <div className="phase-times num">
        {points.map((p) => {
          const tz = domainTimeZone(questionDomain(q.source));
          return p.ns === null ? (
            <span key={p.key} className="phase-time is-null">—</span>
          ) : (
            <span key={p.key} className="phase-time" title={fmtDateTimeTz(p.ns, tz)}>{fmtDateTimeTz(p.ns, tz)}</span>
          );
        })}
      </div>
      <PhaseNow q={q} revealed={revealed} />
    </div>
  );
}

function PhaseNow({ q, revealed }: { q: QuestionView; revealed: boolean }) {
  const nextNs = nextDeadline(q);
  if (q.phase === 'settled' || q.phase === 'cancelled') {
    return (
      <p className="phase-now">
        <span className={`chip ${q.phase === 'settled' ? 'text-state-ok' : 'text-state-bad'}`}>
          {q.phase === 'settled' ? 'Settled' : 'Cancelled'}
        </span>
        <span className="small-caps">terminal</span>
      </p>
    );
  }
  if (q.phase === 'resolved') {
    const outcome = q.outcome === null ? 'pending outcome' : q.outcome ? 'YES' : 'NO';
    return (
      <p className="phase-now">
        <span className="chip text-vermilion-700">Resolved · {outcome}</span>
        {revealed && nextNs ? (
          <span className="small-caps">reveals close in {countdown(nextNs).label}</span>
        ) : null}
      </p>
    );
  }
  if (nextNs === null) return null;
  const cd = countdown(nextNs);
  const past = cd.totalMs < 0;
  return (
    <p className="phase-now">
      <span className="chip">{q.phase}</span>
      <span className="small-caps">
        {past ? 'window passed' : `next: ${q.phase === 'open' ? 'cutoff' : 'observation'} in ${cd.label}`}
      </span>
    </p>
  );
}

function nextDeadline(q: QuestionView): string | null {
  switch (q.phase) {
    case 'open':
      return q.close_time;
    case 'closed':
      return q.observation_start;
    case 'resolved':
      return q.reveal_deadline;
    default:
      return null;
  }
}
