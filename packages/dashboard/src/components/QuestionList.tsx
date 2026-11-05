import { usePolling, useClock } from '../lib/hooks';
import { api } from '../lib/api';
import type { QuestionView } from '../lib/types';
import { PhaseChip, DomainChip, SingleAgentMark, EmptyState, ErrorNote } from './ui';
import { countdown, domainLabel, questionDomain } from '../lib/format';

/** Real Question/Round browse with pagination + domain filter. */
export function QuestionList({
  domain,
  onSelect,
  selectedId,
}: {
  domain: 'all' | 'price' | 'weather';
  onSelect: (id: number) => void;
  selectedId: number | null;
}) {
  const { data, error, loading } = usePolling(() => api.questions(0, 100), 15_000, []);
  const now = useClock(); // re-render countdowns each second

  const questions = (data?.questions ?? [])
    .filter((q) => domain === 'all' || questionDomain(q.source) === domain)
    .slice()
    .sort((a, b) => b.question_id - a.question_id);

  if (loading) return <p className="muted-line">Loading rounds…</p>;
  if (error) return <ErrorNote message={error} />;
  if (questions.length === 0) {
    return (
      <EmptyState
        title="No rounds yet"
        detail="No Question exists for this filter on the live contract, or the backend is still starting."
      />
    );
  }

  return (
    <ul className="question-list" aria-label="Questions">
      {questions.map((q) => (
        <li key={q.question_id}>
          <button
            type="button"
            className={`question-row rule-b ${selectedId === q.question_id ? 'is-selected' : ''}`}
            onClick={() => onSelect(q.question_id)}
          >
            <div className="q-main">
              <div className="q-tags">
                <DomainChip domain={questionDomain(q.source)} />
                <PhaseChip phase={q.phase} />
                <SingleAgentMark count={q.participant_count} />
                {q.snapshot_ready ? <ChipOk label="snapshot ready" /> : null}
              </div>
              <span className="q-text">{q.text}</span>
              <span className="q-meta small-caps">{domainLabel(questionDomain(q.source))}</span>
            </div>
            <div className="q-right num">
              <span className="q-count">{q.participant_count} participant{q.participant_count === 1 ? '' : 's'}</span>
              <span className="q-deadline">{countdownLabel(q, now)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ChipOk({ label }: { label: string }) {
  return <span className="chip text-state-ok">{label}</span>;
}

function countdownLabel(q: QuestionView, nowMs: number): string {
  if (q.phase === 'settled' || q.phase === 'cancelled') return q.phase;
  if (q.phase === 'resolved') {
    return q.reveal_deadline ? `reveal ${countdown(q.reveal_deadline, nowMs).label}` : 'resolved';
  }
  if (q.phase === 'open') return `cutoff ${countdown(q.close_time, nowMs).label}`;
  if (q.phase === 'closed') return `obs ${countdown(q.observation_start, nowMs).label}`;
  return q.phase;
}
