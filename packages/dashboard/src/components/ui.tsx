import type { ReactNode } from 'react';
import type { Phase } from '../lib/types';

export function Chip({
  children,
  tone = 'ink',
}: {
  children: ReactNode;
  tone?: 'ink' | 'vermilion' | 'ok' | 'warn' | 'bad' | 'muted';
}) {
  const toneClass =
    tone === 'vermilion'
      ? 'text-vermilion-700'
      : tone === 'ok'
        ? 'text-state-ok'
        : tone === 'warn'
          ? 'text-state-warn'
          : tone === 'bad'
            ? 'text-state-bad'
            : tone === 'muted'
              ? 'text-ink-500'
              : 'text-ink-900';
  return <span className={`chip ${toneClass}`}>{children}</span>;
}

const PHASE_TONE: Record<Phase, 'muted' | 'ink' | 'vermilion' | 'ok' | 'bad'> = {
  open: 'ink',
  closed: 'muted',
  resolved: 'vermilion',
  settled: 'ok',
  cancelled: 'bad',
};

export function PhaseChip({ phase }: { phase: Phase }) {
  return <Chip tone={PHASE_TONE[phase]}>{phase}</Chip>;
}

export function DomainChip({ domain }: { domain: 'price' | 'weather' }) {
  return (
    <Chip tone={domain === 'price' ? 'vermilion' : 'ink'}>
      {domain === 'price' ? 'price' : 'weather'}
    </Chip>
  );
}

export function SingleAgentMark({ count }: { count: number }) {
  if (count !== 1) return null;
  return (
    <span className="chip text-vermilion-700" title="One participant: a Single-agent Forecast, not a swarm">
      Single-agent
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat-label small-caps">{label}</span>
      <span className="stat-value num">{value}</span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  );
}

export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="panel rule-t">
      <header className="panel-head rule-b">
        <h3 className="panel-title ledger-heading">{title}</h3>
        {action}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p className="error-note" role="alert">
      {message}
    </p>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <p className="empty-title ledger-heading">{title}</p>
      <p className="empty-detail">{detail}</p>
    </div>
  );
}
