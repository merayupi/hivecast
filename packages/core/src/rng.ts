/**
 * Deterministic seeded randomness for the seeded strategies (coinflip, yolo,
 * noisy-trend). No Math.random is used: a draw depends only on (seed, key).
 */

/** FNV-1a 32-bit string hash (deterministic across platforms). */
export function hashStringToUint32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, well-known 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic draw in [0, 1) derived from a seed and stable key parts. */
export function seededDraw(seed: number, keyParts: readonly string[]): number {
  const key = keyParts.join(':');
  const h = hashStringToUint32(`${seed}:${key}`);
  return mulberry32(h)();
}

/** Deterministic integer in [min, max] (inclusive). */
export function seededInt(
  seed: number,
  keyParts: readonly string[],
  min: number,
  max: number,
): number {
  const d = seededDraw(seed, keyParts);
  return min + Math.floor(d * (max - min + 1));
}
