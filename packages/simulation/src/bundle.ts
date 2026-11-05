/**
 * Offline bundle loader and validation.
 *
 * Loads the committed data files (price.json, weather.json) plus manifest.json,
 * verifies their checksums and shape, and exposes typed accessors used by the
 * replay engine. The replay never touches the network: everything here reads
 * local files only.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Candle } from '@hivecast/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(HERE, '..', 'data');

export interface PriceBundle {
  symbol: string;
  interval: string;
  source: string;
  evalStart: string;
  evalEnd: string;
  warmupStart: string;
  candles: Candle[];
}

export interface WeatherBundle {
  source: string;
  model: string;
  latitude: number;
  longitude: number;
  elevation: number;
  timezone: string;
  utc_offset_seconds: number;
  daily_units: { precipitation_sum: string };
  daily: { time: string[]; precipitation_sum: number[] };
  forecasts: Record<string, { run: string; precipMm: number }>;
}

export interface Manifest {
  bundleVersion: number;
  generatedAt: string;
  evalPeriod: {
    start: string;
    end: string;
    priceRounds: number;
    weatherRounds: number;
    priceWarmup: { days: number; candles: number };
    weatherWarmup: { days: number };
  };
  seed: number;
  initialCapitalNear: string;
  stakeFloor: string;
  minStakeNear: string;
  queryFeeNear: string;
  files: Record<string, { sha256: string; bytes: number; description: string }>;
  sources: Array<{
    id: string;
    domain: string;
    kind: string;
    availability: 'proven' | 'inference' | 'retrospective';
    availableAt: string | null;
    note: string;
    [k: string]: unknown;
  }>;
  sourceArchives?: Array<{
    month: string;
    url: string;
    publishedSha256: string;
    fetchedSha256: string;
    bytes: number;
    lastModified: string | null;
    terms: string;
    termsUrl: string;
  }>;
  licensingSummary: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf8')) as T;
}

/** Verify every manifest checksum and byte count; throws on mismatch. */
export function verifyChecksums(manifest: Manifest): void {
  for (const [file, meta] of Object.entries(manifest.files)) {
    const buf = readFileSync(path.join(DATA_DIR, file));
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== meta.sha256) {
      throw new Error(`checksum mismatch for ${file}: expected ${meta.sha256}, got ${actual}`);
    }
    if (buf.length !== meta.bytes) {
      throw new Error(`byte-count mismatch for ${file}: expected ${meta.bytes}, got ${buf.length}`);
    }
  }
}

export interface Bundle {
  manifest: Manifest;
  price: PriceBundle;
  weather: WeatherBundle;
}

/** Load and validate the full bundle from disk. */
export function loadBundle(): Bundle {
  const manifest = readJson<Manifest>('manifest.json');
  verifyChecksums(manifest);
  const price = readJson<PriceBundle>('price.json');
  const weather = readJson<WeatherBundle>('weather.json');

  if (price.candles.length !== manifest.evalPeriod.priceWarmup.candles + manifest.evalPeriod.priceRounds) {
    throw new Error(
      `expected ${manifest.evalPeriod.priceWarmup.candles + manifest.evalPeriod.priceRounds} price candles, got ${price.candles.length}`,
    );
  }
  if (weather.daily.time.length !== manifest.evalPeriod.weatherWarmup.days + manifest.evalPeriod.weatherRounds) {
    throw new Error(
      `expected ${manifest.evalPeriod.weatherWarmup.days + manifest.evalPeriod.weatherRounds} weather days, got ${weather.daily.time.length}`,
    );
  }
  if (Object.keys(weather.forecasts).length !== manifest.evalPeriod.weatherRounds) {
    throw new Error(`expected ${manifest.evalPeriod.weatherRounds} weather forecasts, got ${Object.keys(weather.forecasts).length}`);
  }
  return { manifest, price, weather };
}
