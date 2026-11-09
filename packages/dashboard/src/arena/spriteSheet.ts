/**
 * Sprite sheets: Aseprite "array" JSON (+ PNG) from `/sprites/`, with a
 * generated placeholder whenever a file is missing or invalid. The Arena is
 * fully usable with placeholders only; dropping real sheets into
 * `public/sprites/` needs no code change.
 *
 * Conventions (Phase 4 exports follow these):
 *  - characters: `/sprites/<agentId>.png|json`, 24×24 untrimmed frames, tags
 *    `idle`, `seal`, `reveal`, `win`, `lose`, `bankrupt`;
 *  - props: `/sprites/props.png|json`, one tag per prop state, e.g.
 *    `envelope-sealed`, `envelope-open`, `coin-spin`, `dart`, `refund-token`,
 *    `skull`, `lock`, `lockbox-closed`, `lockbox-glow`, `oracle-stone-idle`,
 *    `pedestal-lit`, `pedestal-dim`, `candle-up`, `candle-down`,
 *    `rain-cloud`, `sun`;
 *  - background: `/sprites/arena-bg.png`, exactly 320×180.
 */

export const CHARACTER_FRAME = 24;

export interface SheetFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  duration: number;
}

export interface FrameTag {
  name: string;
  from: number;
  to: number;
  direction: 'forward' | 'reverse' | 'pingpong';
}

export interface ParsedSheet {
  frames: SheetFrame[];
  tags: Record<string, FrameTag>;
}

export class SheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Parse Aseprite JSON (array format). `frameSize` enforces fixed, untrimmed
 * frames (characters); props pass no size and may mix frame sizes.
 */
export function parseAsepriteSheet(json: unknown, frameSize?: number): ParsedSheet {
  if (!isObj(json)) throw new SheetError('sheet JSON must be an object');
  if (!Array.isArray(json.frames)) throw new SheetError('expected Aseprite "array" format (frames must be an array)');
  if (json.frames.length === 0) throw new SheetError('sheet has no frames');
  const frames: SheetFrame[] = json.frames.map((f, i) => {
    if (!isObj(f) || !isObj(f.frame)) throw new SheetError(`frame ${i}: missing "frame" rect`);
    const { x, y, w, h } = f.frame;
    if (!isInt(x) || !isInt(y) || !isInt(w) || !isInt(h) || w <= 0 || h <= 0 || x < 0 || y < 0) {
      throw new SheetError(`frame ${i}: invalid rect`);
    }
    if (frameSize !== undefined) {
      if (w !== frameSize || h !== frameSize) throw new SheetError(`frame ${i}: expected ${frameSize}×${frameSize}, got ${w}×${h}`);
      if (f.trimmed === true) throw new SheetError(`frame ${i}: trimmed frames are not allowed`);
    }
    const duration = isInt(f.duration) && f.duration > 0 ? f.duration : 100;
    return { x, y, w, h, duration };
  });

  const meta = isObj(json.meta) ? json.meta : {};
  const tags: Record<string, FrameTag> = {};
  const rawTags = Array.isArray(meta.frameTags) ? meta.frameTags : [];
  for (const t of rawTags) {
    if (!isObj(t) || typeof t.name !== 'string' || !isInt(t.from) || !isInt(t.to)) throw new SheetError('invalid frameTag');
    if (t.from < 0 || t.to >= frames.length || t.from > t.to) throw new SheetError(`frameTag "${t.name}" is out of range`);
    const direction = t.direction === 'reverse' || t.direction === 'pingpong' ? t.direction : 'forward';
    tags[t.name] = { name: t.name, from: t.from, to: t.to, direction };
  }
  return { frames, tags };
}

/** Frame index of a tag at `elapsedMs`; `loop: false` holds the last frame. */
export function tagFrameAt(sheet: ParsedSheet, tag: FrameTag, elapsedMs: number, loop: boolean): number {
  const seq: number[] = [];
  for (let i = tag.from; i <= tag.to; i += 1) seq.push(i);
  if (tag.direction === 'reverse') seq.reverse();
  if (tag.direction === 'pingpong' && seq.length > 2) seq.push(...seq.slice(1, -1).reverse());
  const total = seq.reduce((s, i) => s + (sheet.frames[i]?.duration ?? 100), 0);
  let t = Math.max(0, elapsedMs);
  if (loop) t %= Math.max(1, total);
  else if (t >= total) return seq[seq.length - 1]!;
  for (const i of seq) {
    t -= sheet.frames[i]?.duration ?? 100;
    if (t < 0) return i;
  }
  return seq[seq.length - 1]!;
}

/** What a placeholder character looks like (pure; drawn by `drawPlaceholder`). */
export interface PlaceholderSpec {
  size: number;
  /** Square inset from the frame edge (px). */
  inset: number;
  /** Corner cut (px) for the pixel-rounded square. */
  corner: number;
  fill: string;
  outline: string;
  initial: string;
  textColor: string;
}

export function placeholderSpec(persona: { color: string; onColor: string; initial: string }, outline = '#0b0a10'): PlaceholderSpec {
  return {
    size: CHARACTER_FRAME,
    inset: 2,
    corner: 3,
    fill: persona.color,
    outline,
    initial: (persona.initial || '?').slice(0, 1).toUpperCase(),
    textColor: persona.onColor,
  };
}

// ---------------------------------------------------------------------------
// Browser loading (not used by unit tests)
// ---------------------------------------------------------------------------

export interface LoadedSheet {
  kind: 'sheet';
  image: CanvasImageSource;
  sheet: ParsedSheet;
}

export interface PlaceholderSheet {
  kind: 'placeholder';
  image: HTMLCanvasElement;
  spec: PlaceholderSpec;
  reason: string;
}

export type CharacterSprite = LoadedSheet | PlaceholderSheet;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new SheetError(`image failed to load: ${src}`));
    img.src = src;
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new SheetError(`${url}: HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  // Vite's SPA fallback answers missing files with index.html (200).
  if (!type.includes('json')) throw new SheetError(`${url}: not JSON (${type || 'no content-type'})`);
  return res.json();
}

/** Load `/sprites/<name>.json` + `.png`; throws SheetError when missing/invalid. */
export async function loadSheet(base: string, name: string, frameSize?: number): Promise<LoadedSheet> {
  const sheet = parseAsepriteSheet(await fetchJson(`${base}/${name}.json`), frameSize);
  const image = await loadImage(`${base}/${name}.png`);
  for (const f of sheet.frames) {
    if (f.x + f.w > image.naturalWidth || f.y + f.h > image.naturalHeight) throw new SheetError(`${name}: frame outside the image`);
  }
  return { kind: 'sheet', image, sheet };
}

export async function loadBackground(base: string): Promise<HTMLImageElement | null> {
  try {
    const img = await loadImage(`${base}/arena-bg.png`);
    return img.naturalWidth === 320 && img.naturalHeight === 180 ? img : null;
  } catch {
    return null;
  }
}

/** Draw a 24×24 placeholder: a pixel-rounded square in the main colour with the initial. */
export function drawPlaceholder(spec: PlaceholderSpec, font: string, withInitial = true): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = spec.size;
  c.height = spec.size;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  const a = spec.inset;
  const b = spec.size - spec.inset; // exclusive
  const k = spec.corner;
  // Outline: square with corners cut by k px, then fill one pixel inside.
  const rows = (inner: number, color: string) => {
    g.fillStyle = color;
    for (let y = a + inner; y < b - inner; y += 1) {
      const fromTop = y - (a + inner);
      const fromBottom = b - inner - 1 - y;
      const cut = Math.max(0, k - inner - Math.min(fromTop, fromBottom));
      g.fillRect(a + inner + cut, y, b - a - 2 * inner - 2 * cut, 1);
    }
  };
  rows(0, spec.outline);
  rows(1, spec.fill);
  if (!withInitial) return c;
  g.fillStyle = spec.textColor;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(spec.initial, spec.size / 2, spec.size / 2 + 1);
  // Snap anti-aliased text to the palette: keep only opaque-enough pixels.
  const img = g.getImageData(0, 0, spec.size, spec.size);
  const palette = [hexRgb(spec.outline), hexRgb(spec.fill), hexRgb(spec.textColor)];
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! < 128) {
      img.data[i + 3] = 0;
      continue;
    }
    let best = palette[0]!;
    let bestD = Infinity;
    for (const c of palette) {
      const d = Math.abs(img.data[i]! - c[0]) + Math.abs(img.data[i + 1]! - c[1]) + Math.abs(img.data[i + 2]! - c[2]);
      if (d < bestD) [best, bestD] = [c, d];
    }
    [img.data[i], img.data[i + 1], img.data[i + 2]] = best;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Character sprite with automatic placeholder fallback. */
export async function loadCharacter(
  base: string,
  persona: { agentId: string; color: string; onColor: string; initial: string },
  font: string,
): Promise<CharacterSprite> {
  try {
    return await loadSheet(base, persona.agentId, CHARACTER_FRAME);
  } catch (err) {
    const spec = placeholderSpec(persona);
    // The renderer draws the initial at full resolution on top.
    return { kind: 'placeholder', image: drawPlaceholder(spec, font, false), spec, reason: (err as Error).message };
  }
}
