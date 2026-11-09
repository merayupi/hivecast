import type { QuestionView } from '../lib/types';
import { countdown, fmtDateParts, fmtDateTimeTz, sourceTimeZone, questionDomain } from '../lib/format';

interface Milestone {
  key: string;
  label: string;
  ns: string | null;
}

/**
 * The Round's real schedule milestones, labelled precisely (not a fake phase).
 * Snapshot sale is NOT a milestone on its own: it opens after the commitment
 * cutoff (once the snapshot is ready) and closes at observation start.
 */
function milestones(q: QuestionView): Milestone[] {
  return [
    { key: 'open', label: 'Opening', ns: q.open_time },
    { key: 'cutoff', label: 'Commitment cutoff', ns: q.close_time },
    { key: 'obs-start', label: 'Observation starts · sale closes', ns: q.observation_start },
    { key: 'obs-end', label: 'Observation ends', ns: q.observation_end },
    { key: 'resolve-deadline', label: 'Resolution deadline', ns: q.resolve_deadline },
    { key: 'reveal-deadline', label: 'Reveal deadline', ns: q.reveal_deadline },
  ];
}

/** The Round lifecycle as a ruled detent track — the dashboard's signature move. */
export function PhaseLadder({ q, nowMs }: { q: QuestionView; nowMs: number }) {
  const points = milestones(q);
  const revealed = q.reveal_deadline !== null;

  // The detent "now" sits at/after the latest passed milestone.
  const nowNs = BigInt(nowMs) * 1_000_000n;
  let active = -1;
  for (let i = 0; i < points.length; i++) {
    const ns = points[i]!.ns;
    if (ns === null) continue;
    if (BigInt(ns) <= nowNs) active = i;
  }
  const terminal = q.phase === 'settled' || q.phase === 'cancelled';
  const tz = sourceTimeZone(q.source);

  return (
    <div className="phase-ladder">
      <ol className="phase-track" aria-label={`Lifecycle for phase ${q.phase}`}>
        {points.map((p, i) => {
          if (p.ns === null) return <li key={p.key} className="phase-node" />;
          const done = i <= active;
          const parts = fmtDateParts(p.ns, tz);
          return (
            <li key={p.key} className="phase-node">
              <span
                className={`phase-detent ${done ? 'is-done' : ''} ${i === active && !terminal ? 'is-now' : ''}`}
                aria-hidden="true"
              />
              <span className="phase-label small-caps">{p.label}</span>
              <span className="phase-time num">
                <span className="phase-date">{parts.date}</span>
                <span className="phase-clock">{parts.time}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <PhaseNow q={q} revealed={revealed} nowMs={nowMs} tz={tz} />
    </div>
  );
}

function PhaseNow({
  q,
  revealed,
  nowMs,
  tz,
}: {
  q: QuestionView;
  revealed: boolean;
  nowMs: number;
  tz: string;
}) {
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
    const outcome = q.outcome === null ? 'outcome pending' : q.outcome ? 'YES' : 'NO';
    return (
      <p className="phase-now">
        <span className="chip text-vermilion-700">Resolved · {outcome}</span>
        {revealed && q.reveal_deadline ? (
          <span className="small-caps">
            reveals close {fmtDateTimeTz(q.reveal_deadline, tz)} ({countdown(q.reveal_deadline, nowMs).label})
          </span>
        ) : null}
      </p>
    );
  }

  if (q.phase === 'open') {
    const nowNs = BigInt(nowMs) * 1_000_000n;
    // Scheduled (before opening) vs accepting commitments.
    if (nowNs < BigInt(q.open_time)) {
      return (
        <p className="phase-now">
          <span className="chip text-ink-500">scheduled</span>
          <span className="small-caps">opens {fmtDateTimeTz(q.open_time, tz)} ({countdown(q.open_time, nowMs).label})</span>
        </p>
      );
    }
    return (
      <p className="phase-now">
        <span className="chip">open</span>
        <span className="small-caps">commitments close {fmtDateTimeTz(q.close_time, tz)} ({countdown(q.close_time, nowMs).label})</span>
      </p>
    );
  }

  if (q.phase === 'closed') {
    const nowNs = BigInt(nowMs) * 1_000_000n;
    if (nowNs < BigInt(q.observation_start)) {
      // Snapshot sale window (after cutoff, before observation).
      return (
        <p className="phase-now">
          <span className="chip">sale open</span>
          <span className="small-caps">closes at observation start {fmtDateTimeTz(q.observation_start, tz)} ({countdown(q.observation_start, nowMs).label})</span>
        </p>
      );
    }
    if (nowNs < BigInt(q.observation_end)) {
      return (
        <p className="phase-now">
          <span className="chip text-ink-500">observing</span>
          <span className="small-caps">ends {fmtDateTimeTz(q.observation_end, tz)} ({countdown(q.observation_end, nowMs).label})</span>
        </p>
      );
    }
    // Observation ended, outcome not yet resolved.
    return (
      <p className="phase-now">
        <span className="chip text-ink-500">awaiting outcome</span>
        <span className="small-caps">resolution deadline {fmtDateTimeTz(q.resolve_deadline, tz)} ({countdown(q.resolve_deadline, nowMs).label})</span>
      </p>
    );
  }

  return null;
}
