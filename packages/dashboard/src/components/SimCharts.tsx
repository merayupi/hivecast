import { useMemo, useState } from 'react';
import type { DomainResult } from '../lib/types';

/**
 * Two charts for the offline replay, drawn in the ledger's own ink:
 *  - BankrollChart: every agent's bankroll over the replay (log scale). The
 *    richest agent is the one vermilion line; agents that can no longer meet
 *    the minimum Stake are dashed. Identity is carried by direct end labels,
 *    never by colour, so six crossing lines stay readable.
 *  - BrierBars: mean Brier per agent vs the swarm vs two naive baselines.
 * Both are plain SVG (no chart dependency) and both have a hover readout.
 */

const MIN_STAKE_NEAR = 0.1;
const STAKE_FRACTION = 10; // stake = 1/10 of Available Balance

/** yoctoNEAR decimal string -> NEAR, rescaled to micro-NEAR precision for plotting only. */
function toNear(yocto: string): number {
  return Number(BigInt(yocto) / 10n ** 18n) / 1e6;
}

function fmtNear(n: number): string {
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function shortDate(label: string): string {
  if (label === 'start') return 'start';
  // ISO timestamp (price) or YYYY-MM-DD (weather)
  const d = label.slice(0, 10);
  return `${d.slice(8, 10)}/${d.slice(5, 7)}`;
}

const W = 760;
const H = 340;
const M = { top: 16, right: 118, bottom: 30, left: 52 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

export function BankrollChart({ d }: { d: DomainResult }) {
  const series = d.series;
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const model = useMemo(() => {
    if (!series) return null;
    const agents = Object.keys(series.bankrolls);
    const values: Record<string, number[]> = {};
    let min = Infinity;
    let max = 0;
    for (const a of agents) {
      values[a] = series.bankrolls[a]!.map(toNear);
      for (const v of values[a]!) {
        if (v > 0) min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    const lo = Math.pow(10, Math.floor(Math.log10(Math.max(min, 0.01))));
    const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(max, 1))));
    const n = series.labels.length;
    const x = (i: number) => M.left + (n <= 1 ? 0 : (i / (n - 1)) * PW);
    const y = (v: number) => {
      const c = Math.max(v, lo);
      return M.top + PH - ((Math.log10(c) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * PH;
    };
    const final = agents.map((a) => ({ a, v: values[a]![values[a]!.length - 1]! }));
    const winner = final.slice().sort((p, q) => q.v - p.v)[0]?.a ?? null;
    const broke = new Set(final.filter((f) => f.v / STAKE_FRACTION < MIN_STAKE_NEAR).map((f) => f.a));
    // End labels, nudged apart so they never overlap (min 13px gap).
    const labels = final
      .map((f) => ({ ...f, ly: y(f.v) }))
      .sort((p, q) => p.ly - q.ly);
    for (let i = 1; i < labels.length; i++) {
      if (labels[i]!.ly - labels[i - 1]!.ly < 13) labels[i]!.ly = labels[i - 1]!.ly + 13;
    }
    const overflow = labels.length ? labels[labels.length - 1]!.ly - (M.top + PH + 4) : 0;
    if (overflow > 0) for (const l of labels) l.ly -= overflow;
    const ticks: number[] = [];
    for (let t = lo; t <= hi * 1.0001; t *= 10) ticks.push(t);
    return { agents, values, x, y, lo, hi, n, winner, broke, labels, ticks };
  }, [series]);

  if (!series || !model) {
    return <p className="muted-line">Bankroll history is not in this report. Rebuild the runner to include it.</p>;
  }

  const { agents, values, x, y, n, winner, broke, labels, ticks } = model;
  const path = (a: string) =>
    values[a]!.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const xTicks = [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const start = toNear(d.initialCapital);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - M.left) / PW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const stroke = (a: string) =>
    focus === a ? 'var(--color-ink-900)' : a === winner ? 'var(--color-vermilion-600)' : broke.has(a) ? 'var(--color-ink-300)' : 'var(--color-ink-500)';

  const readout =
    hover === null
      ? null
      : agents
          .map((a) => ({ a, v: values[a]![hover]! }))
          .sort((p, q) => q.v - p.v);

  return (
    <figure className="chart">
      <figcaption className="chart-caption">
        <span className="ledger-heading">Bankroll race</span>
        <span className="muted-line">
          Each agent starts with {fmtNear(start)} NEAR and stakes 10% of its balance per Round. Log scale.{' '}
          <span className="legend-key"><i className="key-line is-winner" /> richest</span>{' '}
          <span className="legend-key"><i className="key-line is-broke" /> can no longer stake</span>
        </span>
      </figcaption>
      <div className="chart-frame">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bankroll of each agent over ${n - 1} sampled rounds`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + PW} y1={y(t)} y2={y(t)} className="grid" />
              <text x={M.left - 8} y={y(t) + 4} textAnchor="end" className="axis">
                {t >= 1 ? t.toFixed(0) : t}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={M.left + PW} y1={y(start)} y2={y(start)} className="ref-line" />
          <text x={M.left + PW - 4} y={y(start) - 5} textAnchor="end" className="axis">starting capital {fmtNear(start)}</text>
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="axis">
              {shortDate(series.labels[i]!)}
            </text>
          ))}
          {agents
            .slice()
            .sort((p, q) => (p === winner ? 1 : q === winner ? -1 : 0) + (p === focus ? 2 : q === focus ? -2 : 0))
            .map((a) => (
              <path
                key={a}
                d={path(a)}
                fill="none"
                stroke={stroke(a)}
                strokeWidth={a === winner || a === focus ? 2.25 : 1.5}
                strokeDasharray={broke.has(a) && a !== focus ? '4 3' : undefined}
                strokeLinejoin="round"
                opacity={focus && focus !== a ? 0.35 : 1}
              />
            ))}
          {labels.map((l) => (
            <g
              key={l.a}
              className="end-label"
              onPointerEnter={() => setFocus(l.a)}
              onPointerLeave={() => setFocus(null)}
            >
              <line x1={M.left + PW + 2} x2={M.left + PW + 8} y1={y(l.v)} y2={l.ly} stroke="var(--color-ink-300)" />
              <text x={M.left + PW + 11} y={l.ly + 4} className={`label ${l.a === winner ? 'is-winner' : ''}`}>
                {l.a} <tspan className="label-val">{fmtNear(l.v)}</tspan>
              </text>
            </g>
          ))}
          {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + PH} className="crosshair" /> : null}
          <rect
            x={M.left}
            y={M.top}
            width={PW}
            height={PH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {readout && hover !== null ? (
          <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
            <div className="tip-head num">{series.labels[hover] === 'start' ? 'start' : series.labels[hover]!.replace('T', ' ').slice(0, 16)}</div>
            {readout.map((r) => (
              <div key={r.a} className="tip-row num">
                <span>{r.a}</span>
                <span>{fmtNear(r.v)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </figure>
  );
}

interface Bar {
  key: string;
  label: string;
  value: number;
  kind: 'agent' | 'swarm' | 'baseline';
  note: string;
}

export function BrierBars({ d }: { d: DomainResult }) {
  const [hover, setHover] = useState<string | null>(null);
  const bars: Bar[] = [];
  for (const a of d.agents) {
    if (a.brierMean !== null) bars.push({ key: a.agentId, label: a.agentId, value: a.brierMean, kind: 'agent', note: `${a.brierRounds} scored rounds` });
  }
  const sw = d.aggregates.find((g) => g.kind === 'stake-weighted');
  const eq = d.aggregates.find((g) => g.kind === 'equal-weight');
  if (sw) bars.push({ key: 'swarm-sw', label: 'Swarm · stake-weighted', value: sw.brierMean, kind: 'swarm', note: 'the forecast buyers pay for' });
  if (eq) bars.push({ key: 'swarm-eq', label: 'Swarm · equal-weight', value: eq.brierMean, kind: 'swarm', note: 'comparison only' });
  for (const b of d.baselines ?? []) {
    bars.push({
      key: b.kind,
      label: b.kind === 'constant-50' ? 'Baseline · always 50%' : 'Baseline · past YES rate',
      value: b.brierMean,
      kind: 'baseline',
      note: b.kind === 'constant-50' ? 'a forecaster with no information' : 'frequency of YES so far, no look-ahead',
    });
  }
  bars.sort((p, q) => p.value - q.value);
  const max = Math.max(0.5, ...bars.map((b) => b.value));
  const rowH = 26;
  const LW = 196;
  const BW = W - LW - 60;
  const h = bars.length * rowH + 28;
  const x = (v: number) => LW + (v / max) * BW;

  return (
    <figure className="chart">
      <figcaption className="chart-caption">
        <span className="ledger-heading">Accuracy · mean Brier score</span>
        <span className="muted-line">Lower is better. 0 is perfect; 0.25 is what &ldquo;always 50%&rdquo; scores.</span>
      </figcaption>
      <div className="chart-frame">
        <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label="Mean Brier score per agent, swarm and baselines">
          {[0, 0.1, 0.2, 0.3, 0.4, 0.5].filter((t) => t <= max).map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={4} y2={h - 22} className="grid" />
              <text x={x(t)} y={h - 6} textAnchor="middle" className="axis">{t.toFixed(1)}</text>
            </g>
          ))}
          {bars.map((b, i) => {
            const yy = 6 + i * rowH;
            const cls = b.kind === 'swarm' ? (b.key === 'swarm-sw' ? 'bar is-swarm' : 'bar is-swarm-alt') : b.kind === 'baseline' ? 'bar is-baseline' : 'bar';
            return (
              <g key={b.key} onPointerEnter={() => setHover(b.key)} onPointerLeave={() => setHover(null)} className="bar-row">
                <rect x={0} y={yy - 2} width={W} height={rowH} fill="transparent" />
                <text x={LW - 10} y={yy + 13} textAnchor="end" className={`label ${b.kind === 'swarm' ? 'is-winner' : ''}`}>{b.label}</text>
                <rect x={LW} y={yy + 3} width={Math.max(1, x(b.value) - LW)} height={rowH - 10} className={cls} />
                <text x={x(b.value) + 6} y={yy + 13} className="label label-val">{b.value.toFixed(3)}</text>
                {hover === b.key ? (
                  <text x={x(b.value) + 52} y={yy + 13} className="axis">{b.note}</text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}
