import { useEffect, useMemo, useRef, useState } from 'react';
import { near } from '../lib/format';
import type { DomainResult, ReplayReport } from '../lib/types';
import { HIVE, STAGE_H, STAGE_W } from './palette';
import { personaFor } from './personas';
import {
  advance,
  bankrollAt,
  buildRace,
  isBankruptAt,
  leaderAt,
  logX,
  sampleLabel,
  type RaceModel,
  type Speed,
} from './race';
import { drawCharacter, drawCrown, rect, text, type SpriteBank } from './renderer';
import { usePixelFit, usePrefersReducedMotion } from './Stage';
import { useSpriteBank } from './useSpriteBank';

const X0 = 46;
const X1 = 306;
const TOP = 30;

function drawRace(g: CanvasRenderingContext2D, bank: SpriteBank, m: RaceModel, t: number, loopMs: number, ended: boolean) {
  g.imageSmoothingEnabled = false;
  rect(g, 0, 0, STAGE_W, STAGE_H, HIVE.night);
  text(g, bank, 'OFFLINE REPLAY · not live chain activity', 4, 3, HIVE.honey, 'left');
  text(g, bank, sampleLabel(m.labels[Math.floor(t)] ?? ''), STAGE_W - 4, 3, HIVE.ash, 'right');

  // Log axis: one tick per decade.
  rect(g, X0, 22, X1 - X0, 1, HIVE.dusk);
  for (let d = m.lo; d <= m.hi; d += 1) {
    const x = Math.round(X0 + ((d - m.lo) / (m.hi - m.lo)) * (X1 - X0));
    rect(g, x, 20, 1, 4, HIVE.wax);
    const v = Math.pow(10, d);
    text(g, bank, v >= 1000 ? `${v / 1000}k` : v >= 1 ? String(v) : String(v), x, 12, HIVE.ash, 'center');
  }

  const n = m.agents.length;
  const laneH = Math.floor((STAGE_H - TOP) / Math.max(1, n));
  const leader = leaderAt(m, t);
  m.agents.forEach((agent, i) => {
    const y0 = TOP + i * laneH;
    rect(g, 0, y0, STAGE_W, laneH, i % 2 ? HIVE.night : HIVE.deep);
    rect(g, X0, y0 + laneH - 1, X1 - X0, 1, HIVE.violet);
    const persona = personaFor(agent);
    const my = y0 + Math.floor(laneH / 2) - 4;
    rect(g, 3, my + 1, 5, 5, HIVE.ink);
    rect(g, 4, my + 2, 3, 3, persona.color);
    text(g, bank, persona.name, 11, my, HIVE.cream, 'left');

    const x = Math.round(X0 + logX(m, bankrollAt(m, agent, t)) * (X1 - X0));
    const bankrupt = isBankruptAt(m, agent, t);
    const pose = bankrupt ? 'bankrupt' : ended && agent === leader ? 'win' : 'idle';
    drawCharacter(g, bank, agent, pose, x, y0 + laneH, 0, loopMs + i * 131, false);
    if (agent === leader && !bankrupt) drawCrown(g, x - 4, y0 + laneH - 30);
  });
}

/** Lanes race on the night stage; the existing charts/table stay below. */
export function SeasonRace({ report, domain }: { report: ReplayReport; domain: 'price' | 'weather' }) {
  const d: DomainResult = domain === 'price' ? report.price : report.weather;
  const model = useMemo(() => (d.series ? buildRace(d.series, report.config.minStakeNear) : null), [d, report.config.minStakeNear]);
  const bank = useSpriteBank();
  const reduced = usePrefersReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fit = usePixelFit(wrapRef);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(4);
  const [sample, setSample] = useState(0);
  const tRef = useRef(0);
  const last = model ? model.labels.length - 1 : 0;

  // New domain → back to the start.
  useEffect(() => {
    tRef.current = 0;
    setSample(0);
    setPlaying(false);
  }, [model]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bank || !model) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    let raf = 0;
    let prev = performance.now();
    const start = prev;
    const frame = () => {
      const now = performance.now();
      if (playing) {
        const step = advance(tRef.current, now - prev, speed, last);
        tRef.current = step.t;
        const s = Math.floor(step.t);
        setSample((cur) => (cur === s ? cur : s));
        if (step.ended) setPlaying(false);
      }
      prev = now;
      g.setTransform(fit.deviceScale, 0, 0, fit.deviceScale, 0, 0);
      drawRace(g, bank, model, tRef.current, reduced ? 0 : now - start, tRef.current >= last);
      if (!reduced && document.visibilityState !== 'hidden') raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onVis = () => {
      cancelAnimationFrame(raf);
      prev = performance.now();
      if (document.visibilityState !== 'hidden') raf = requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [bank, model, playing, speed, last, fit, reduced, reduced ? sample : null]);

  if (!model) {
    return (
      <section className="hive-panel">
        <h2 className="px panel-title">Season Replay</h2>
        <p className="no-data">NO DATA YET — this replay report has no bankroll series.</p>
      </section>
    );
  }

  const play = () => {
    if (tRef.current >= last) {
      tRef.current = 0;
      setSample(0);
    }
    if (reduced) {
      // Instant transition: jump straight to the final standings.
      tRef.current = last;
      setSample(last);
      return;
    }
    setPlaying(true);
  };

  const leader = leaderAt(model, sample);
  const standings = [...model.agents].sort((a, b) => {
    const va = BigInt(model.yocto[a]![sample]!);
    const vb = BigInt(model.yocto[b]![sample]!);
    return va === vb ? (a < b ? -1 : 1) : vb > va ? 1 : -1;
  });

  return (
    <section className="season" aria-label="Season Replay">
      <div className="stage-head">
        <span className="env-chip env-offline">OFFLINE REPLAY · not live chain activity</span>
        <h2 className="px stage-title">Season Replay · {domain === 'price' ? 'Price' : 'Weather'}</h2>
      </div>
      <div ref={wrapRef} className="arena-stage-wrap">
        <canvas
          ref={canvasRef}
          width={STAGE_W * fit.deviceScale}
          height={STAGE_H * fit.deviceScale}
          aria-hidden="true"
          className="arena-canvas"
          style={{ width: fit.cssWidth, height: (fit.cssWidth * STAGE_H) / STAGE_W }}
        />
      </div>
      <div className="race-controls">
        <button type="button" className="hive-btn" onClick={() => (playing ? setPlaying(false) : play())}>
          {playing ? 'Pause' : sample >= last ? 'Replay' : 'Play'}
        </button>
        <div className="speed" role="group" aria-label="Speed">
          {([1, 4, 16] as const).map((s) => (
            <button key={s} type="button" className={`hive-btn ghost ${speed === s ? 'is-on' : ''}`} aria-pressed={speed === s} onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <input
          className="scrub"
          type="range"
          min={0}
          max={last}
          step={1}
          value={sample}
          aria-label="Scrub through the season"
          onChange={(e) => {
            const v = Number(e.target.value);
            tRef.current = v;
            setSample(v);
            setPlaying(false);
          }}
        />
        <span className="num subline">
          {sampleLabel(model.labels[sample] ?? '')} · sample {sample}/{last}
        </span>
      </div>
      <div className="hive-panel">
        <div className="scroll-x">
          <table className="hive-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th className="r">Bankroll at this sample</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((a, i) => {
                const persona = personaFor(a);
                const broke = isBankruptAt(model, a, sample);
                return (
                  <tr key={a}>
                    <td className="num">{i + 1}</td>
                    <td>
                      <span className="swatch" style={{ background: persona.color }} aria-hidden="true" /> {persona.name}{' '}
                      <span className="muted num">{a}</span>
                    </td>
                    <td className="r num">{near(model.yocto[a]![sample]!, 4)} NEAR</td>
                    <td className={broke ? 'loss' : ''}>
                      {a === leader ? '♛ leader' : ''}
                      {broke ? '☠ out of capital (cannot fund the 0.1 NEAR minimum stake)' : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="fine">
          x = bankroll on a log scale from the replay's sampled series (every {d.series?.sampleEvery ?? 1} Round
          {d.series?.sampleEvery === 1 ? '' : 's'}); positions glide between samples, numbers are the sampled values. Out of capital = bankroll
          below 10 × the minimum stake, since each stake is 1/10 of the available balance.
        </p>
      </div>
    </section>
  );
}
