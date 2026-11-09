/**
 * Canvas renderer for the 320×180 stage. Draws a `Scene` at a story time
 * (`storyMs`, since the story started) and a loop time (`loopMs`, for idle
 * breathing and pulses). It never decides WHAT happened, only HOW the scene
 * already derived from data is animated. Sprites fall back to procedural
 * placeholders drawn with palette colours only.
 */
import { HIVE, STAGE_H, STAGE_W } from './palette';
import type { Scene, SceneActor } from './scene';
import { rosterIndex } from './personas';
import { tagFrameAt, type CharacterSprite, type LoadedSheet } from './spriteSheet';

export interface SpriteBank {
  characters: Map<string, CharacterSprite>;
  props: LoadedSheet | null;
  background: HTMLImageElement | null;
  font: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Layout (pure)
// ---------------------------------------------------------------------------

export const LAYOUT = {
  banner: { x: 80, y: 0, w: 160, h: 40 },
  track: { x0: 40, x1: 280, y: 46 },
  icon: { x: 152, y: 52 },
  lockbox: { x: 144, y: 68, w: 32, h: 24 },
  envelopeY: 94,
  stone: { x: 250, y: 62 },
  observe: { x: 46, y: 60 },
  benchFeetY: 178,
} as const;

/** Feet position (centre x, baseline y) of participant i of n on the arc. */
export function actorAnchor(i: number, n: number): { x: number; y: number } {
  const spacing = n <= 1 ? 0 : Math.min(34, Math.floor(272 / (n - 1 || 1)));
  const d = i - (n - 1) / 2;
  // Baseline 142 keeps the labels above the heads (y ≥ 100) clear of the
  // envelope row under the Lockbox (y 94–100).
  return { x: Math.round(160 + d * spacing), y: Math.round(142 + 0.8 * d * d) };
}

export function benchAnchor(i: number): { x: number; y: number } {
  // Left edge first, then the right edge, 26 px apart.
  const left = i % 2 === 0;
  const k = Math.floor(i / 2);
  return { x: left ? 16 + k * 26 : STAGE_W - 16 - k * 26, y: LAYOUT.benchFeetY };
}

export const SLOTS = 9;

export interface SceneLayout {
  /** Feet anchor per participant (same order as scene.actors). */
  actors: { x: number; y: number }[];
  /** Feet anchor per benched agent (same order as scene.bench). */
  bench: { x: number; y: number }[];
  /** Slot index per participant (label stagger); -1 in the packed fallback. */
  actorSlots: number[];
  /** Pedestals to draw: one per slot in the fixed layout (lit = participant). */
  pedestals: { x: number; y: number; lit: boolean }[];
  fixed: boolean;
}

/**
 * Where everyone stands. Normally every roster agent owns one of the nine
 * pedestals of the background's arc (slot = roster order): participants on
 * a lit pedestal, agents sitting this Round out dimmed on their own dim one.
 * If an agent is unknown (no slot) the packed centre arc + side bench is used.
 */
export function layoutScene(scene: Pick<Scene, 'actors' | 'bench'>): SceneLayout {
  const slotOf = (id: string) => rosterIndex(id);
  const all = [...scene.actors.map((a) => slotOf(a.agentId)), ...scene.bench.map((b) => slotOf(b.agentId))];
  const fixed = all.every((s) => s >= 0 && s < SLOTS) && new Set(all).size === all.length;
  if (fixed) {
    const actorSlots = scene.actors.map((a) => slotOf(a.agentId));
    const lit = new Set(actorSlots);
    return {
      fixed,
      actorSlots,
      actors: actorSlots.map((s) => actorAnchor(s, SLOTS)),
      bench: scene.bench.map((b) => actorAnchor(slotOf(b.agentId), SLOTS)),
      pedestals: Array.from({ length: SLOTS }, (_, s) => ({ ...actorAnchor(s, SLOTS), lit: lit.has(s) })),
    };
  }
  const n = scene.actors.length;
  const actors = scene.actors.map((_, i) => actorAnchor(i, n));
  return {
    fixed,
    actorSlots: scene.actors.map(() => -1),
    actors,
    bench: scene.bench.map((_, i) => benchAnchor(i)),
    pedestals: actors.map((a) => ({ ...a, lit: true })),
  };
}

/** Envelope rects in the Lockbox row, one per participant (hover targets). */
export function envelopeRects(n: number): Rect[] {
  const w = 8;
  const gap = 2;
  const total = n * w + Math.max(0, n - 1) * gap;
  const x0 = Math.round(160 - total / 2);
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * (w + gap), y: LAYOUT.envelopeY, w, h: 6 }));
}

export function hitEnvelope(px: number, py: number, n: number): number | null {
  const rects = envelopeRects(n);
  const i = rects.findIndex((r) => px >= r.x - 1 && px < r.x + r.w + 1 && py >= r.y - 2 && py < r.y + r.h + 2);
  return i === -1 ? null : i;
}

export function trackX(bps: number): number {
  return Math.round(LAYOUT.track.x0 + ((LAYOUT.track.x1 - LAYOUT.track.x0) * bps) / 10_000);
}

/** Coin size tier (1–3) of a flow relative to the largest flow in the Round. */
export function coinTier(amount: bigint, max: bigint): 1 | 2 | 3 {
  if (max <= 0n) return 1;
  const r = Number((amount * 1000n) / max) / 1000;
  return r > 0.5 ? 3 : r > 0.15 ? 2 : 1;
}

/**
 * Stage size for a container `cssWidth` wide on a `dpr` display: the largest
 * whole number of DEVICE pixels per logical pixel that fits (at most 4 CSS
 * px per logical px), and the CSS width that maps exactly onto them.
 */
export function stageScale(cssWidth: number, dpr: number): { deviceScale: number; cssWidth: number } {
  const maxDevice = Math.floor(4 * dpr + 1e-6);
  const deviceScale = Math.max(1, Math.min(maxDevice, Math.floor((cssWidth * dpr + 1e-6) / STAGE_W)));
  return { deviceScale, cssWidth: (STAGE_W * deviceScale) / dpr };
}

/** Total story length (ms) so the UI knows when the story has finished. */
export function storyDuration(scene: Scene): number {
  const n = scene.actors.length;
  switch (scene.kind) {
    case 'open':
      return n * 350 + 900;
    case 'resolved':
      return 700 + scene.actors.filter((a) => a.revealedBps !== null).length * 400 + 600;
    case 'settled':
      return 600 + scene.coins.length * 120 + 900;
    case 'cancelled':
      return 300 + n * 200 + 900;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) * (1 - t));
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const R = (n: number) => Math.round(n);

export function rect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  g.fillStyle = c;
  g.fillRect(R(x), R(y), w, h);
}

export function text(g: CanvasRenderingContext2D, bank: SpriteBank, s: string, x: number, y: number, color: string, align: CanvasTextAlign = 'center', size = 8, shadow = true) {
  g.font = bank.font.replace(/^\d+px/, `${size}px`);
  g.textAlign = align;
  g.textBaseline = 'top';
  g.fillStyle = HIVE.ink;
  if (shadow) g.fillText(s, R(x) + 1, R(y) + 1);
  g.fillStyle = color;
  g.fillText(s, R(x), R(y));
}

function wrap(g: CanvasRenderingContext2D, s: string, width: number, maxLines: number): string[] {
  const words = s.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
    return kept;
  }
  return lines;
}

/** Draw a props tag frame if the props sheet has it; returns false otherwise. */
function propFrame(g: CanvasRenderingContext2D, bank: SpriteBank, tag: string, x: number, y: number, t: number, loop = true): boolean {
  const p = bank.props;
  const tg = p?.sheet.tags[tag];
  if (!p || !tg) return false;
  const f = p.sheet.frames[tagFrameAt(p.sheet, tg, t, loop)]!;
  g.drawImage(p.image, f.x, f.y, f.w, f.h, R(x), R(y), f.w, f.h);
  return true;
}

function drawBackground(g: CanvasRenderingContext2D, bank: SpriteBank) {
  if (bank.background) {
    g.drawImage(bank.background, 0, 0);
    return;
  }
  rect(g, 0, 0, STAGE_W, STAGE_H, HIVE.night);
  // Far honeycomb wall: hex outlines in deep, offset rows.
  g.fillStyle = HIVE.deep;
  for (let row = 0; row < 8; row += 1) {
    for (let col = -1; col < 18; col += 1) {
      const cx = col * 20 + (row % 2 ? 10 : 0);
      const cy = row * 14;
      g.fillRect(cx + 3, cy, 8, 1);
      g.fillRect(cx + 3, cy + 12, 8, 1);
      for (let k = 0; k < 6; k += 1) {
        g.fillRect(cx + 2 - (k < 3 ? k : 5 - k) + 0, cy + k * 2 + 1, 1, 2);
        g.fillRect(cx + 11 + (k < 3 ? k : 5 - k), cy + k * 2 + 1, 1, 2);
      }
    }
  }
  // Keep the banner area quiet.
  rect(g, LAYOUT.banner.x, 0, LAYOUT.banner.w, LAYOUT.banner.h, HIVE.night);
  // Hall floor.
  rect(g, 0, 112, STAGE_W, 68, HIVE.deep);
  rect(g, 0, 112, STAGE_W, 1, HIVE.violet);
  for (let x = 0; x < STAGE_W; x += 16) rect(g, x, 113, 1, 67, HIVE.night);
  // Lanterns.
  for (const lx of [24, 68, 252, 296]) {
    rect(g, lx, 0, 1, 18, HIVE.violet);
    rect(g, lx - 2, 18, 5, 6, HIVE.amber);
    rect(g, lx - 1, 19, 3, 4, HIVE.honey);
  }
}

function drawBanner(g: CanvasRenderingContext2D, bank: SpriteBank, scene: Scene) {
  const b = LAYOUT.banner;
  g.font = bank.font;
  const lines = wrap(g, scene.banner, b.w - 8, 2);
  const top = scene.subline ? 6 : 10;
  lines.forEach((l, i) => text(g, bank, l, 160, top + i * 10, HIVE.wax));
  if (scene.subline) {
    // One line inside the banner area; the DOM caption carries the full text.
    const sub = wrap(g, scene.subline, b.w - 8, 1)[0] ?? '';
    text(g, bank, sub, 160, top + lines.length * 10 + 2, HIVE.honey);
  }
  if (scene.sealed && (scene.kind === 'open' || scene.kind === 'sealing')) {
    text(g, bank, `SEALED ${scene.sealed.n}${scene.sealed.m !== null ? `/${scene.sealed.m}` : ''}`, 6, 4, HIVE.honey, 'left');
  }
  if (scene.questionId !== null) text(g, bank, `Q${scene.questionId}`, STAGE_W - 6, 4, HIVE.ash, 'right');
}

function drawPedestal(g: CanvasRenderingContext2D, bank: SpriteBank, x: number, y: number, lit: boolean) {
  if (propFrame(g, bank, lit ? 'pedestal-lit' : 'pedestal-dim', x - 16, y - 2, 0)) return;
  rect(g, x - 13, y, 26, 2, lit ? HIVE.honey : HIVE.dusk);
  rect(g, x - 14, y + 2, 28, 5, lit ? HIVE.amber : HIVE.violet);
  rect(g, x - 12, y + 7, 24, 1, HIVE.ink);
}

function drawLockbox(g: CanvasRenderingContext2D, bank: SpriteBank, glow: boolean) {
  const l = LAYOUT.lockbox;
  if (propFrame(g, bank, glow ? 'lockbox-glow' : 'lockbox-closed', l.x, l.y - 8, 0)) return;
  rect(g, l.x + 2, l.y + 2, l.w - 4, l.h - 2, HIVE.ink);
  rect(g, l.x + 3, l.y + 3, l.w - 6, l.h - 4, HIVE.violet);
  rect(g, l.x + 3, l.y + 8, l.w - 6, 2, glow ? HIVE.honey : HIVE.dusk);
  rect(g, l.x + 14, l.y + 11, 4, 5, HIVE.honey);
  rect(g, l.x + 15, l.y + 13, 2, 2, HIVE.ink);
}

function drawEnvelope(g: CanvasRenderingContext2D, bank: SpriteBank, x: number, y: number, open: boolean, highlight: boolean) {
  if (highlight) rect(g, x - 1, y - 1, 10, 8, HIVE.wax);
  if (propFrame(g, bank, open ? 'envelope-open' : 'envelope-sealed', x, y - 1, 0)) return;
  rect(g, x, y, 8, 6, HIVE.ink);
  rect(g, x + 1, y + 1, 6, 4, HIVE.cream);
  if (open) {
    rect(g, x + 1, y - 2, 6, 2, HIVE.cream);
  } else {
    rect(g, x + 3, y + 2, 2, 2, HIVE.amber);
  }
}

function drawStone(g: CanvasRenderingContext2D, bank: SpriteBank, loopMs: number, pulse: boolean) {
  const s = LAYOUT.stone;
  if (propFrame(g, bank, 'oracle-stone-idle', s.x - 6, s.y - 4, pulse ? loopMs : 0)) return;
  const on = pulse && Math.floor(loopMs / 400) % 2 === 0;
  if (on) {
    rect(g, s.x - 2, s.y - 2, 24, 32, HIVE.honey);
    rect(g, s.x - 1, s.y - 1, 22, 30, HIVE.night);
  }
  rect(g, s.x + 2, s.y, 16, 28, HIVE.ink);
  rect(g, s.x + 3, s.y + 1, 14, 26, HIVE.dusk);
  rect(g, s.x + 3, s.y + 1, 3, 26, HIVE.ash);
  rect(g, s.x + 9, s.y + 8, 2, 10, on ? HIVE.wax : HIVE.honey);
  rect(g, s.x + 7, s.y + 12, 6, 2, on ? HIVE.wax : HIVE.honey);
}

export function drawOutcomeIcon(g: CanvasRenderingContext2D, bank: SpriteBank, domain: 'price' | 'weather', outcome: boolean, x: number, y: number) {
  const tag = domain === 'price' ? (outcome ? 'candle-up' : 'candle-down') : outcome ? 'rain-cloud' : 'sun';
  if (propFrame(g, bank, tag, x, y, 0)) return;
  if (domain === 'price') {
    const body = outcome ? HIVE.yes : HIVE.rain;
    rect(g, x + 7, y, 2, 16, HIVE.wax);
    rect(g, x + 4, y + 3, 8, 10, HIVE.ink);
    rect(g, x + 5, y + 4, 6, 8, body);
    if (outcome) rect(g, x + 5, y + 4, 2, 8, HIVE.white);
  } else if (outcome) {
    rect(g, x + 2, y + 3, 12, 6, HIVE.ash);
    rect(g, x + 4, y + 1, 7, 3, HIVE.ash);
    rect(g, x + 3, y + 11, 1, 3, HIVE.sky);
    rect(g, x + 7, y + 12, 1, 3, HIVE.sky);
    rect(g, x + 11, y + 11, 1, 3, HIVE.sky);
  } else {
    rect(g, x + 4, y + 4, 8, 8, HIVE.honey);
    rect(g, x + 7, y, 2, 3, HIVE.honey);
    rect(g, x + 7, y + 13, 2, 3, HIVE.honey);
    rect(g, x, y + 7, 3, 2, HIVE.honey);
    rect(g, x + 13, y + 7, 3, 2, HIVE.honey);
  }
}

function drawCoin(g: CanvasRenderingContext2D, bank: SpriteBank, x: number, y: number, tier: 1 | 2 | 3, t: number) {
  if (tier === 3 && propFrame(g, bank, 'coin-spin', x - 4, y - 4, t)) return;
  const r = tier + 1;
  rect(g, x - r, y - r + 1, 2 * r, 2 * r - 2, HIVE.amber);
  rect(g, x - r + 1, y - r, 2 * r - 2, 2 * r, HIVE.amber);
  rect(g, x - r + 1, y - r + 1, 2 * r - 2, 2 * r - 2, HIVE.honey);
}

function drawRefundToken(g: CanvasRenderingContext2D, bank: SpriteBank, x: number, y: number) {
  if (propFrame(g, bank, 'refund-token', x - 4, y - 4, 0)) return;
  rect(g, x - 3, y - 2, 6, 4, HIVE.sky);
  rect(g, x - 2, y - 3, 4, 6, HIVE.sky);
  rect(g, x - 1, y - 1, 2, 2, HIVE.wax);
}

function drawDart(g: CanvasRenderingContext2D, bank: SpriteBank, x: number, y: number, color: string) {
  if (propFrame(g, bank, 'dart', x - 4, y - 7, 0)) {
    rect(g, x, y - 8, 1, 1, color);
    return;
  }
  rect(g, x, y - 7, 1, 5, HIVE.wax);
  rect(g, x - 1, y - 8, 3, 2, color);
  rect(g, x, y - 2, 1, 2, HIVE.amber);
}

function drawTrack(g: CanvasRenderingContext2D, bank: SpriteBank) {
  const t = LAYOUT.track;
  rect(g, t.x0, t.y, t.x1 - t.x0 + 1, 1, HIVE.dusk);
  for (const bps of [0, 2500, 5000, 7500, 10_000]) rect(g, trackX(bps), t.y - 1, 1, 3, bps % 5000 === 0 ? HIVE.wax : HIVE.dusk);
  text(g, bank, '0%', t.x0 - 4, t.y - 4, HIVE.ash, 'right');
  text(g, bank, '100%', t.x1 + 4, t.y - 4, HIVE.ash, 'left');
}

export function drawCharacter(
  g: CanvasRenderingContext2D,
  bank: SpriteBank,
  agentId: string,
  pose: SceneActor['pose'],
  feetX: number,
  feetY: number,
  poseMs: number,
  loopMs: number,
  dim: boolean,
) {
  const sprite = bank.characters.get(agentId);
  const x = feetX - 12;
  let y = feetY - 24;
  if (dim) g.globalAlpha = 0.35;
  if (sprite?.kind === 'sheet') {
    const tag = sprite.sheet.tags[pose] ?? sprite.sheet.tags.idle;
    const loop = pose === 'idle' || pose === 'bankrupt';
    const idx = tag ? tagFrameAt(sprite.sheet, tag, loop ? loopMs : poseMs, loop) : 0;
    const f = sprite.sheet.frames[idx]!;
    g.drawImage(sprite.image, f.x, f.y, f.w, f.h, x, y, f.w, f.h);
  } else if (sprite) {
    // Placeholder poses: offsets only (whole pixels).
    if (pose === 'idle') y -= Math.floor(loopMs / 640) % 2;
    if (pose === 'seal' || pose === 'reveal') y -= poseMs > 0 && poseMs < 400 ? 2 : 0;
    if (pose === 'win') y -= Math.floor(loopMs / 220) % 2 === 0 ? 2 : 0;
    if (pose === 'lose' || pose === 'bankrupt') y += 1;
    g.drawImage(sprite.image, x, y, 24, 24);
    // The initial is drawn live so it stays sharp at any device scale.
    text(g, bank, sprite.spec.initial, x + 12, y + 7, sprite.spec.textColor, 'center', 11, false);
    if (pose === 'bankrupt') drawGhost(g, x, y);
  }
  g.globalAlpha = 1;
}

/** Bankrupt placeholder: 50% ash dither over the body and a tiny skull. */
function drawGhost(g: CanvasRenderingContext2D, x: number, y: number) {
  g.fillStyle = HIVE.night;
  for (let yy = 2; yy < 22; yy += 1) for (let xx = 2 + (yy % 2); xx < 22; xx += 2) g.fillRect(x + xx, y + yy, 1, 1);
  drawSkull(g, x + 9, y - 7);
}

export function drawSkull(g: CanvasRenderingContext2D, x: number, y: number) {
  rect(g, x, y, 6, 4, HIVE.wax);
  rect(g, x + 1, y + 4, 4, 2, HIVE.wax);
  rect(g, x + 1, y + 1, 1, 2, HIVE.ink);
  rect(g, x + 4, y + 1, 1, 2, HIVE.ink);
  rect(g, x + 2, y + 5, 1, 1, HIVE.ink);
}

export function drawCrown(g: CanvasRenderingContext2D, x: number, y: number) {
  rect(g, x, y + 2, 9, 3, HIVE.honey);
  rect(g, x, y, 1, 2, HIVE.honey);
  rect(g, x + 4, y - 1, 1, 3, HIVE.honey);
  rect(g, x + 8, y, 1, 2, HIVE.honey);
  rect(g, x + 2, y + 3, 1, 1, HIVE.amber);
  rect(g, x + 6, y + 3, 1, 1, HIVE.amber);
  rect(g, x, y + 5, 9, 1, HIVE.amber);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function arcPoint(from: { x: number; y: number }, to: { x: number; y: number }, t: number, lift = 24) {
  const e = ease(t);
  return { x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e) - Math.sin(Math.PI * e) * lift };
}

export interface DrawOptions {
  storyMs: number;
  loopMs: number;
  reducedMotion: boolean;
  highlightEnvelope: number | null;
}

/** Draw one frame of the stage. */
export function drawScene(g: CanvasRenderingContext2D, bank: SpriteBank, scene: Scene, opts: DrawOptions) {
  g.imageSmoothingEnabled = false;
  const story = opts.reducedMotion ? Number.POSITIVE_INFINITY : opts.storyMs;
  const loop = opts.reducedMotion ? 0 : opts.loopMs;

  drawBackground(g, bank);
  drawBanner(g, bank, scene);

  if (scene.kind === 'no-data') {
    text(g, bank, 'NO DATA YET', 160, 96, HIVE.ash);
    return;
  }

  const n = scene.actors.length;
  const layout = layoutScene(scene);
  const anchors = layout.actors;
  const env = envelopeRects(n);
  const lockboxCenter = { x: 160, y: LAYOUT.lockbox.y + 10 };

  // Middle props by phase.
  const showTrack = scene.kind === 'resolved' || scene.kind === 'settled';
  if (showTrack) drawTrack(g, bank);
  drawLockbox(g, bank, scene.kind === 'snapshot-sale');
  if (scene.kind === 'sealing' || scene.kind === 'snapshot-sale' || scene.kind === 'observing' || scene.kind === 'awaiting-outcome') {
    drawStone(g, bank, loop, scene.kind === 'snapshot-sale');
  }
  if (scene.kind === 'observing' || scene.kind === 'awaiting-outcome') drawObserving(g, bank, scene);

  // Pedestals + bench.
  layout.pedestals.forEach((p) => drawPedestal(g, bank, p.x, p.y, p.lit));
  scene.bench.forEach((b, i) => {
    const a = layout.bench[i]!;
    drawCharacter(g, bank, b.agentId, 'idle', a.x, a.y, 0, 0, true);
  });

  // Envelopes: fly from each agent into the Lockbox row during OPEN; already
  // there in every later phase (open flap once that agent has revealed).
  scene.actors.forEach((a, i) => {
    const r = env[i]!;
    const opened = a.revealedBps !== null && (scene.kind === 'resolved' || scene.kind === 'settled');
    if (scene.kind === 'open') {
      const t0 = i * 350 + 250;
      const t = clamp01((story - t0) / 400);
      if (story < t0) return;
      const p = arcPoint({ x: anchors[i]!.x - 4, y: anchors[i]!.y - 26 }, { x: r.x, y: r.y }, t, 16);
      drawEnvelope(g, bank, R(p.x), R(p.y), false, t >= 1 && opts.highlightEnvelope === i);
    } else if (scene.kind !== 'cancelled' || story < 300) {
      drawEnvelope(g, bank, r.x, r.y, opened, opts.highlightEnvelope === i);
    } else {
      drawEnvelope(g, bank, r.x, r.y, true, opts.highlightEnvelope === i);
    }
  });

  // Outcome icon drops in.
  if ((scene.kind === 'resolved' || scene.kind === 'settled') && scene.outcome !== null && scene.domain) {
    const t = scene.kind === 'resolved' ? clamp01(story / 600) : 1;
    const y = lerp(-16, LAYOUT.icon.y, ease(t));
    drawOutcomeIcon(g, bank, scene.domain, scene.outcome, LAYOUT.icon.x, R(y));
  }

  // Characters + labels + darts.
  let revealOrder = 0;
  scene.actors.forEach((a, i) => {
    const anchor = anchors[i]!;
    let poseStart = 0;
    let pose = a.pose;
    if (scene.kind === 'open') poseStart = i * 350;
    if (scene.kind === 'resolved' && a.revealedBps !== null) {
      poseStart = 700 + revealOrder * 400;
      revealOrder += 1;
      if (story < poseStart) pose = 'idle';
    }
    if (scene.kind === 'settled') {
      poseStart = 300;
      if (story < poseStart) pose = 'idle';
    }
    const poseMs = story - poseStart;
    drawCharacter(g, bank, a.agentId, story < poseStart && scene.kind === 'open' ? 'idle' : pose, anchor.x, anchor.y, poseMs, loop + i * 97, false);

    // Label above the head (alternating heights so neighbours don't collide).
    const visible = scene.kind !== 'resolved' || a.revealedBps === null || story >= poseStart + 200;
    if (a.label && visible) {
      const short = a.revealedBps !== null ? `${Math.round(a.revealedBps / 100)}%` : a.label.startsWith('NO REVEAL') ? 'NO REVEAL' : a.label === 'NOT REVEALED YET' ? '…' : a.label === 'SEALED' ? '' : a.label === 'REFUNDED' ? '' : a.label;
      if (short) {
        const color = a.result === 'win' ? HIVE.yes : a.result === 'lose' ? HIVE.alert : a.revealedBps !== null ? HIVE.wax : HIVE.ash;
        const stagger = (layout.actorSlots[i]! >= 0 ? layout.actorSlots[i]! : i) % 2;
        text(g, bank, short, anchor.x, anchor.y - 34 - stagger * 8, color);
      }
    }

    // Dart from the agent onto the 0–100% track at its revealed value.
    if (showTrack && a.revealedBps !== null) {
      const tx = trackX(a.revealedBps);
      const t = scene.kind === 'resolved' ? clamp01((story - poseStart - 100) / 400) : 1;
      if (t > 0) {
        const p = arcPoint({ x: anchor.x, y: anchor.y - 26 }, { x: tx, y: LAYOUT.track.y }, t, 10);
        drawDart(g, bank, R(p.x), R(p.y), a.color);
      }
    }
  });

  // Settlement coins: loser → winner, fee pool → revealer, sized by amount.
  if (scene.kind === 'settled' && !opts.reducedMotion) {
    const max = scene.coins.reduce((m, c) => (BigInt(c.amount) > m ? BigInt(c.amount) : m), 0n);
    const pos = (id: string) => {
      const i = scene.actors.findIndex((a) => a.accountId === id);
      return i === -1 ? lockboxCenter : { x: anchors[i]!.x, y: anchors[i]!.y - 12 };
    };
    scene.coins.forEach((c, k) => {
      const t0 = 600 + k * 120;
      const t = clamp01((story - t0) / 700);
      if (t <= 0 || t >= 1) return;
      const from = c.from === 'fee-pool' ? lockboxCenter : pos(c.from);
      const p = arcPoint(from, pos(c.to), t, 30);
      drawCoin(g, bank, R(p.x), R(p.y), coinTier(BigInt(c.amount), max), story);
    });
  }

  // Cancellation: refund tokens float from the Lockbox back to each agent.
  if (scene.kind === 'cancelled' && !opts.reducedMotion) {
    scene.actors.forEach((_, i) => {
      const t0 = 300 + i * 200;
      const t = clamp01((story - t0) / 700);
      if (t <= 0 || t >= 1) return;
      const p = arcPoint(lockboxCenter, { x: anchors[i]!.x, y: anchors[i]!.y - 12 }, t, 20);
      drawRefundToken(g, bank, R(p.x), R(p.y));
    });
  }
}

function drawObserving(g: CanvasRenderingContext2D, bank: SpriteBank, scene: Scene) {
  const o = LAYOUT.observe;
  if (scene.domain === 'price') {
    // An empty candle frame: the live candle is not shown (no partial data).
    rect(g, o.x, o.y, 24, 30, HIVE.ink);
    rect(g, o.x + 1, o.y + 1, 22, 28, HIVE.violet);
    rect(g, o.x + 2, o.y + 2, 20, 26, HIVE.night);
    text(g, bank, '?', o.x + 12, o.y + 10, HIVE.honey);
  } else if (scene.localHour !== null) {
    // The city's real local day or night (no fake weather).
    const day = scene.localHour >= 6 && scene.localHour < 18;
    rect(g, o.x, o.y, 24, 24, day ? HIVE.sky : HIVE.deep);
    if (day) rect(g, o.x + 8, o.y + 8, 8, 8, HIVE.honey);
    else {
      rect(g, o.x + 9, o.y + 7, 7, 9, HIVE.wax);
      rect(g, o.x + 12, o.y + 6, 5, 9, HIVE.deep);
    }
    text(g, bank, `${String(scene.localHour).padStart(2, '0')}h`, o.x + 12, o.y + 26, HIVE.ash);
  }
}
