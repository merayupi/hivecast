/**
 * The Hive Arena's 16-colour palette. The same values are CSS tokens
 * (`--hive-*` in arena.css) and the only colours the canvas draws with.
 * Green (`yes`) is reserved for YES / gains; red (`alert`) for losses /
 * out of capital.
 */
export const HIVE = {
  night: '#14101f',
  deep: '#241b3a',
  violet: '#3b2d5c',
  dusk: '#5a4a7a',
  honey: '#f2b134',
  amber: '#e07a1f',
  wax: '#fff1c1',
  cream: '#f7e9d0',
  yes: '#5bd16b',
  ash: '#8a8399',
  alert: '#e24b4b',
  sky: '#5fb3e8',
  rain: '#3a6fb0',
  leaf: '#2f8f5b',
  ink: '#0b0a10',
  white: '#ffffff',
} as const;

export type HiveColor = keyof typeof HIVE;

/** Palette as an ordered array (sprite tooling and palette checks). */
export const HIVE_PALETTE: readonly string[] = Object.values(HIVE);

/** Logical canvas size; scaled by the largest integer that fits. */
export const STAGE_W = 320;
export const STAGE_H = 180;
