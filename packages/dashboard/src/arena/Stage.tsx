import { useEffect, useRef, useState } from 'react';
import { STAGE_H, STAGE_W } from './palette';
import type { Scene } from './scene';
import { drawScene, hitEnvelope, type SpriteBank } from './renderer';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * The 320×180 stage, scaled by the largest whole number that fits its
 * container. Decorative: `aria-hidden`; every fact is repeated in the DOM.
 */
export function Stage({
  scene,
  bank,
  replayToken,
  highlightEnvelope,
  onEnvelope,
}: {
  scene: Scene;
  bank: SpriteBank | null;
  /** Changing this restarts the story (the Replay button). */
  replayToken: number;
  highlightEnvelope: number | null;
  onEnvelope: (index: number | null, commit: boolean) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const reduced = usePrefersReducedMotion();
  const storyStart = useRef(performance.now());
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const highlightRef = useRef(highlightEnvelope);
  highlightRef.current = highlightEnvelope;

  // Integer scale from the container width.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? STAGE_W;
      setScale(Math.max(1, Math.min(4, Math.floor(w / STAGE_W))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A story restarts when the scene's story changes or Replay is pressed.
  useEffect(() => {
    storyStart.current = performance.now();
  }, [scene.storyKey, replayToken]);

  // Draw loop: requestAnimationFrame while visible; one static frame when
  // reduced motion is requested.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bank) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    let raf = 0;
    const loopStart = performance.now();
    const frame = () => {
      const now = performance.now();
      drawScene(g, bank, sceneRef.current, {
        storyMs: now - storyStart.current,
        loopMs: now - loopStart,
        reducedMotion: reduced,
        highlightEnvelope: highlightRef.current,
      });
      if (!reduced && document.visibilityState !== 'hidden') raf = requestAnimationFrame(frame);
    };
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (document.visibilityState !== 'hidden') raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // The animated loop reads scene/highlight through refs; only the static
    // (reduced-motion) frame needs a redraw when they change.
  }, [bank, reduced, reduced ? scene : null, reduced ? highlightEnvelope : null]);

  const toLogical = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.floor((e.clientX - r.left) / scale), y: Math.floor((e.clientY - r.top) / scale) };
  };

  return (
    <div ref={wrapRef} className="arena-stage-wrap">
      <canvas
        ref={canvasRef}
        width={STAGE_W}
        height={STAGE_H}
        aria-hidden="true"
        className="arena-canvas"
        style={{ width: STAGE_W * scale, height: STAGE_H * scale, cursor: highlightEnvelope !== null ? 'pointer' : 'default' }}
        onMouseMove={(e) => {
          const p = toLogical(e);
          onEnvelope(hitEnvelope(p.x, p.y, scene.actors.length), false);
        }}
        onMouseLeave={() => onEnvelope(null, false)}
        onClick={(e) => {
          const p = toLogical(e);
          const i = hitEnvelope(p.x, p.y, scene.actors.length);
          if (i !== null) onEnvelope(i, true);
        }}
      />
    </div>
  );
}
