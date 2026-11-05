/**
 * One-shot data fetcher for the offline replay bundle.
 *
 * Fetches real historical data from primary public sources and writes the
 * committed bundle under packages/simulation/data/. Run this with network
 * access; `npm run sim` itself reads only the committed files (offline).
 *
 *   price   : Binance spot NEARUSDT 1h klines (eval + 7-day warm-up)
 *   weather : Open-Meteo archive ECMWF IFS daily precipitation_sum (outcomes
 *             + 365-day warm-up), and Single Runs IFS hourly precipitation
 *             (meteo forecast input), summed over each target WIB day.
 *
 * Provenance is recorded in manifest.json, including checksums and the
 * availability classification per input (proven / inference / retrospective).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, '..', 'data');

const PRICE_SYMBOL = 'NEARUSDT';
const PRICE_INTERVAL = '1h';
const EVAL_START = '2026-08-01';
const EVAL_END = '2026-09-29'; // inclusive
const PRICE_WARMUP_START = '2026-07-25'; // 7 days before eval
const WEATHER_WARMUP_START = '2025-08-01'; // 365 days before eval
const LAT = -6.8049;
const LON = 110.8397;

function utcMs(dateStr: string, h = 0): number {
  return Date.parse(`${dateStr}T${String(h).padStart(2, '0')}:00:00Z`);
}

function wibDateToRun(dateStr: string): string {
  // For target WIB day D, use the IFS run initialised at 00:00 UTC on D-1.
  const prev = new Date(Date.parse(`${dateStr}T00:00:00Z`) - 24 * 3600 * 1000);
  return prev.toISOString().slice(0, 10);
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} ${res.statusText} (${url})`);
  }
  return (await res.json()) as unknown;
}

async function fetchKlines(startMs: number, limit: number): Promise<string[][]> {
  const url =
    `https://api.binance.com/api/v3/klines?symbol=${PRICE_SYMBOL}` +
    `&interval=${PRICE_INTERVAL}&startTime=${startMs}&limit=${limit}`;
  const rows = (await fetchJson(url, 'binance klines')) as string[][];
  return rows;
}

function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  return run();
}

async function run(): Promise<void> {
  // ---- Price candles -------------------------------------------------------
  const warmupStartMs = utcMs(PRICE_WARMUP_START);
  const evalEndMs = utcMs(EVAL_END, 23);
  const evalEndExclusiveMs = evalEndMs + 3600 * 1000; // after last eval candle

  const priceRows: string[][] = [];
  let cursor = warmupStartMs;
  while (cursor < evalEndExclusiveMs) {
    const batch = await fetchKlines(cursor, 1000);
    if (batch.length === 0) break;
    priceRows.push(...batch);
    const lastOpen = Number(batch[batch.length - 1]![0]);
    const lastClose = Number(batch[batch.length - 1]![6]);
    cursor = lastClose + 1;
    if (cursor <= lastOpen) cursor = lastOpen + 3600 * 1000;
  }

  const candles = priceRows
    .map((r) => ({
      openTime: String(r[0]!),
      open: String(r[1]!),
      high: String(r[2]!),
      low: String(r[3]!),
      close: String(r[4]!),
      volume: String(r[5]!),
      closeTime: String(r[6]!),
      quoteVolume: String(r[7]!),
      trades: String(r[8]!),
      takerBaseVolume: String(r[9]!),
      takerQuoteVolume: String(r[10]!),
    }))
    .filter((c) => Number(c.openTime) <= evalEndMs);

  const evalStartMs = utcMs(EVAL_START);
  const evalCandles = candles.filter((c) => Number(c.openTime) >= evalStartMs && Number(c.openTime) <= evalEndMs);
  const warmupCandles = candles.filter((c) => Number(c.openTime) < evalStartMs);

  console.log(`price: total=${candles.length} eval=${evalCandles.length} warmup=${warmupCandles.length}`);
  if (evalCandles.length !== 1440) throw new Error(`expected 1440 eval candles, got ${evalCandles.length}`);

  // ---- Weather archive (outcomes + 365-day warm-up) ------------------------
  const archiveUrl =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${LAT}&longitude=${LON}&daily=precipitation_sum` +
    `&timezone=Asia%2FJakarta&start_date=${WEATHER_WARMUP_START}&end_date=${EVAL_END}` +
    `&models=ecmwf_ifs`;
  const archive = (await fetchJson(archiveUrl, 'open-meteo archive')) as {
    daily: { time: string[]; precipitation_sum: number[] };
    latitude: number;
    longitude: number;
    elevation: number;
    timezone: string;
    utc_offset_seconds: number;
    daily_units: { precipitation_sum: string };
  };
  console.log(`weather archive: days=${archive.daily.time.length}`);
  if (archive.daily.time.length !== 425) {
    throw new Error(`expected 425 archive days, got ${archive.daily.time.length}`);
  }

  // ---- Weather forecast inputs (meteo): Single Runs IFS --------------------
  const evalDates = archive.daily.time.slice(-60);
  const forecasts: Record<string, { run: string; precipMm: number }> = {};
  for (const targetDate of evalDates) {
    const runDate = wibDateToRun(targetDate);
    const runUrl =
      `https://single-runs-api.open-meteo.com/v1/forecast` +
      `?latitude=${LAT}&longitude=${LON}&run=${runDate}T00:00` +
      `&hourly=precipitation&models=ecmwf_ifs&timezone=Asia%2FJakarta&forecast_hours=48`;
    const run = (await fetchJson(runUrl, `single-runs ${targetDate}`)) as {
      hourly?: { time: string[]; precipitation: (number | null)[] };
      error?: boolean;
      reason?: string;
    };
    if (run.error || !run.hourly) {
      throw new Error(`single-runs failed for ${targetDate}: ${run.reason ?? 'no hourly'}`);
    }
    const { time, precipitation } = run.hourly;
    let sum = 0;
    let found = 0;
    for (let i = 0; i < time.length; i++) {
      const t = time[i]!;
      if (t.startsWith(targetDate)) {
        const v = precipitation[i];
        if (typeof v === 'number' && Number.isFinite(v)) {
          sum += v;
          found++;
        }
      }
    }
    if (found !== 24) {
      throw new Error(`expected 24 hourly values for ${targetDate}, got ${found}`);
    }
    forecasts[targetDate] = { run: `${runDate}T00:00Z`, precipMm: sum };
  }
  console.log(`weather forecasts: days=${Object.keys(forecasts).length}`);

  // ---- Write bundle --------------------------------------------------------
  const priceDoc = {
    symbol: PRICE_SYMBOL,
    interval: PRICE_INTERVAL,
    source: 'Binance Spot REST /api/v3/klines',
    evalStart: EVAL_START,
    evalEnd: EVAL_END,
    warmupStart: PRICE_WARMUP_START,
    candles,
  };
  const weatherDoc = {
    source: 'Open-Meteo Archive (ECMWF IFS)',
    model: 'ecmwf_ifs',
    latitude: archive.latitude,
    longitude: archive.longitude,
    elevation: archive.elevation,
    timezone: archive.timezone,
    utc_offset_seconds: archive.utc_offset_seconds,
    daily_units: archive.daily_units,
    daily: archive.daily,
    forecasts,
  };

  writeFileSync(path.join(DATA_DIR, 'price.json'), JSON.stringify(priceDoc, null, 2) + '\n');
  writeFileSync(path.join(DATA_DIR, 'weather.json'), JSON.stringify(weatherDoc, null, 2) + '\n');
  console.log('bundle written.');
}

// Invoke (kept as a plain top-level call so `tsx scripts/fetch-data.ts` works).
void main();
