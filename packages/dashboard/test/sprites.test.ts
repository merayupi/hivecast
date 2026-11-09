/**
 * Sprite sheets: Aseprite JSON (array format) parsing, tag timing, and the
 * placeholder fallback when a sheet is missing or invalid.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAsepriteSheet,
  tagFrameAt,
  placeholderSpec,
  loadCharacter,
  loadSheet,
  SheetError,
} from '../src/arena/spriteSheet';
import { PERSONAS, personaFor, agentIdForAccount } from '../src/arena/personas';
import { HIVE_PALETTE } from '../src/arena/palette';

function frame(i: number, w = 24, h = 24, duration = 100, trimmed = false) {
  return { filename: `idle-${i}`, frame: { x: i * (w + 1), y: 0, w, h }, rotated: false, trimmed, duration };
}

const VALID = {
  frames: [frame(0, 24, 24, 160), frame(1, 24, 24, 160), frame(2, 24, 24, 160), frame(3, 24, 24, 160), frame(4), frame(5)],
  meta: {
    image: 'yolo.png',
    size: { w: 150, h: 24 },
    frameTags: [
      { name: 'idle', from: 0, to: 3, direction: 'forward' },
      { name: 'win', from: 4, to: 5, direction: 'pingpong' },
    ],
  },
};

test('parses Aseprite array JSON with frame tags', () => {
  const s = parseAsepriteSheet(VALID, 24);
  assert.equal(s.frames.length, 6);
  assert.deepEqual(s.frames[1], { x: 25, y: 0, w: 24, h: 24, duration: 160 });
  assert.deepEqual(s.tags.idle, { name: 'idle', from: 0, to: 3, direction: 'forward' });
  assert.equal(s.tags.win?.direction, 'pingpong');
});

test('rejects the hash format, wrong frame size, trimmed frames and bad tags', () => {
  assert.throws(() => parseAsepriteSheet({ frames: { 'a.png': frame(0) }, meta: {} }, 24), /array/);
  assert.throws(() => parseAsepriteSheet({ frames: [frame(0, 23, 24)], meta: {} }, 24), /24×24/);
  assert.throws(() => parseAsepriteSheet({ frames: [frame(0, 24, 24, 100, true)], meta: {} }, 24), /trimmed/);
  assert.throws(() => parseAsepriteSheet({ frames: [frame(0)], meta: { frameTags: [{ name: 'idle', from: 0, to: 3 }] } }, 24), /out of range/);
  assert.throws(() => parseAsepriteSheet({ frames: [] }, 24), /no frames/);
  assert.throws(() => parseAsepriteSheet('<!doctype html>', 24), SheetError);
});

test('props may mix frame sizes when no size is enforced', () => {
  const s = parseAsepriteSheet({ frames: [frame(0, 8, 8), frame(1, 32, 32)], meta: { frameTags: [{ name: 'lockbox-closed', from: 1, to: 1 }] } });
  assert.equal(s.frames[1]!.w, 32);
});

test('tag timing: looping idle and one-shot tags that hold their last frame', () => {
  const s = parseAsepriteSheet(VALID, 24);
  assert.equal(tagFrameAt(s, s.tags.idle!, 0, true), 0);
  assert.equal(tagFrameAt(s, s.tags.idle!, 170, true), 1);
  assert.equal(tagFrameAt(s, s.tags.idle!, 640 + 10, true), 0, 'loops after 4×160 ms');
  assert.equal(tagFrameAt(s, s.tags.idle!, 10_000, false), 3, 'one-shot holds the last frame');
});

test('placeholder spec: 24×24 square in the persona colour with its initial', () => {
  const yolo = personaFor('yolo');
  const spec = placeholderSpec(yolo);
  assert.equal(spec.size, 24);
  assert.equal(spec.fill, yolo.color);
  assert.equal(spec.initial, 'Y');
  assert.equal(spec.textColor, yolo.onColor);
  assert.ok(HIVE_PALETTE.includes(spec.fill) && HIVE_PALETTE.includes(spec.textColor) && HIVE_PALETTE.includes(spec.outline));
});

test('every persona uses palette colours and a distinct main colour', () => {
  const colors = PERSONAS.map((p) => p.color);
  assert.equal(new Set(colors).size, PERSONAS.length);
  for (const p of PERSONAS) assert.ok(HIVE_PALETTE.includes(p.color) && HIVE_PALETTE.includes(p.onColor), p.agentId);
  assert.equal(personaFor('llm-news').name, 'Herald');
  assert.equal(personaFor('unknown-agent').name, 'unknown-agent');
  assert.equal(agentIdForAccount('yolo.hivecast-1105-0548.testnet', null), 'yolo');
});

// ---- loader fallback (browser APIs stubbed) ---------------------------------

function fakeCanvas() {
  const data = new Uint8ClampedArray(24 * 24 * 4);
  const ctx = {
    imageSmoothingEnabled: true,
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect: () => {},
    fillText: () => {},
    getImageData: () => ({ data }),
    putImageData: () => {},
  };
  return { width: 0, height: 0, getContext: () => ctx };
}

test('missing sheet (Vite SPA fallback returns HTML) → generated placeholder', async (t) => {
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g.fetch, document: g.document };
  t.after(() => {
    g.fetch = saved.fetch;
    g.document = saved.document;
  });
  g.fetch = async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  g.document = { createElement: () => fakeCanvas() };

  await assert.rejects(loadSheet('/sprites', 'yolo', 24), /not JSON/);
  const sprite = await loadCharacter('/sprites', personaFor('yolo'), '10px monospace');
  assert.equal(sprite.kind, 'placeholder');
  if (sprite.kind === 'placeholder') {
    assert.equal(sprite.spec.initial, 'Y');
    assert.match(sprite.reason, /not JSON/);
  }
});

test('invalid sheet JSON (wrong frame size) → placeholder, never a broken sprite', async (t) => {
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g.fetch, document: g.document };
  t.after(() => {
    g.fetch = saved.fetch;
    g.document = saved.document;
  });
  g.fetch = async () =>
    new Response(JSON.stringify({ frames: [frame(0, 32, 32)], meta: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  g.document = { createElement: () => fakeCanvas() };
  const sprite = await loadCharacter('/sprites', personaFor('llm-news'), '10px monospace');
  assert.equal(sprite.kind, 'placeholder');
  if (sprite.kind === 'placeholder') assert.match(sprite.reason, /24×24/);
});
