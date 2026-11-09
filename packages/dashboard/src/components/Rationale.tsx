import { usePolling } from '../lib/hooks';
import { api } from '../lib/api';
import { pct } from '../lib/format';
import { Panel, ErrorNote, Chip } from './ui';

/**
 * The LLM agent's headlines and rationale for one Round. The runner releases
 * it only after the agent's on-chain Reveal, so before that we say so instead
 * of showing anything that could leak the private forecast.
 */
export function RationalePanel({ questionId }: { questionId: number }) {
  const { data, error, loading } = usePolling(() => api.rationale(questionId), 20_000, [questionId]);

  if (loading) return null;
  if (error) return <ErrorNote message={error} />;
  if (!data || data.state === 'absent') return null;

  if (data.state === 'hidden') {
    return (
      <Panel title="LLM agent reasoning">
        <p className="muted-line">The LLM agent has not revealed yet. Its headlines and reasoning appear here after its Reveal.</p>
      </Panel>
    );
  }

  const r = data.data;
  return (
    <Panel title="LLM agent reasoning" action={<Chip tone="vermilion">llm-news · live only</Chip>}>
      <div className="rationale">
        <p className="rationale-prob">
          <span className="small-caps">Revealed forecast</span>
          <span className="num">{pct(r.revealed_prob_bps)} YES</span>
        </p>
        <blockquote className="rationale-text">{r.rationale}</blockquote>
        {r.headlines.length > 0 ? (
          <div>
            <p className="small-caps rationale-kicker">Headlines it read (published before cutoff)</p>
            <ul className="rationale-headlines">
              {r.headlines.map((h, i) => (
                <li key={`${h.published_at}-${i}`}>
                  <span className="num muted-line">{h.published_at.slice(11, 16)} UTC · {h.source}</span>
                  <span>{h.title}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted-line">No headlines were available in the window; it forecast from the candles alone.</p>
        )}
        <p className="muted-line">
          Model <span className="num">{r.model}</span> via {r.provider}. Prompt SHA-256{' '}
          <span className="num">{r.prompt_sha256.slice(0, 16)}…</span>
          {r.matches_reveal ? null : <> · <span className="text-state-bad">stored forecast does not match the Reveal</span></>}
        </p>
      </div>
    </Panel>
  );
}
