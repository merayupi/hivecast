import { api } from '../lib/api';
import { usePolling } from '../lib/hooks';
import { questionDomain } from '../lib/format';
import type { LlmRationale, QuestionView } from '../lib/types';

/** Every Question on chain (the Arena needs the newest, not the first 100). */
export const fetchAllQuestions = (): Promise<QuestionView[]> => api.allQuestions();

/**
 * Latest revealed Herald rationale: walk the newest resolved/settled price
 * Rounds and take the first one whose rationale the API releases (it only
 * does so after the on-chain Reveal).
 */
export async function latestHeraldRationale(
  questions: readonly QuestionView[],
  maxTries = 6,
): Promise<{ question: QuestionView; rationale: LlmRationale } | null> {
  const candidates = questions
    .filter((q) => (q.phase === 'resolved' || q.phase === 'settled') && questionDomain(q.source) === 'price')
    .sort((a, b) => b.question_id - a.question_id)
    .slice(0, maxTries);
  for (const q of candidates) {
    const r = await api.rationale(q.question_id);
    if (r.state === 'ok') return { question: q, rationale: r.data };
  }
  return null;
}

/** Polling for everything the Arena shows except the selected Round's comparison. */
export function useArenaData() {
  const questions = usePolling(fetchAllQuestions, 15_000, []);
  const roster = usePolling(() => api.agents(), 60_000, []);
  const leaderboard = usePolling(() => api.leaderboard(), 30_000, []);
  const economics = usePolling(() => api.economics(), 30_000, []);
  const activity = usePolling(() => api.activity(30), 15_000, []);
  const terminalKey = (questions.data ?? [])
    .filter((q) => q.phase === 'resolved' || q.phase === 'settled')
    .map((q) => q.question_id)
    .join(',');
  const herald = usePolling(() => latestHeraldRationale(questions.data ?? []), 30_000, [terminalKey]);
  return { questions, roster, leaderboard, economics, activity, herald };
}

/** The selected Round's public comparison (re-created when the Round changes). */
export function useRoundComparison(selectedId: number | null) {
  return usePolling(() => (selectedId === null ? Promise.resolve(null) : api.comparison(selectedId)), 15_000, [selectedId]);
}
