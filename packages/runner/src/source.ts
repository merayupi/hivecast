/**
 * Source fetchers (Binance NEARUSDT 1h candles, Open-Meteo IFS Kudus daily
 * precipitation). No silent substitution: each fetcher pins the exact
 * instrument/model/grid/timezone and records availability evidence.
 *
 * All price/amount values are exact decimal strings; up/down and >=1.0mm are
 * decided with `compareDecimalStrings`/`gteDec`, never floating point.
 */

import { compareDecimalStrings, gteDec } from '@hivecast/core';
import type { Candle } from '@hivecast/core';
import type { RunnerConfig } from './config.js';
import type { SourceEvidence } from './types.js';
import { MS_PER_HOUR, PRICE_INSTRUMENT, PRICE_INTERVAL } from './schedule.js';

export interface FetchedCandles {
  candles: Candle[];
  evidence: SourceEvidence;
}

export interface FetchedForecast {
  /** Decimal string mm for the target day, or null when unavailable. */
  forecastPrecipMm: string | null;
  evidence: SourceEvidence;
}

export interface FetchedResolution {
  /** Decimal string mm for the target day. */
  precipitationMm: string;
  outcome: boolean;
  evidence: SourceEvidence;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  return (await res.json()) as unknown;
}

function evidenceOf(source: string, availability: SourceEvidence['availability'], note: string, attribution: string): SourceEvidence {
  return { source, fetchedAtMs: Date.now(), availability, note, attribution };
}

// ---------------------------------------------------------------------------
// Price (Binance spot klines)
// ---------------------------------------------------------------------------

/**
 * Fetch completed hourly candles with `closeTime < cutoffMs` (ascending).
 * The freshest returned candle is the last one whose period ended before the
 * cutoff; the in-flight candle is always excluded.
 */
export async function fetchCompletedCandles(
  config: RunnerConfig,
  cutoffMs: number,
  maxCandles = 48,
): Promise<FetchedCandles> {
  // Binance returns ascending klines ending at the requested range; fetch a
  // window that ends just before the cutoff.
  const endTime = cutoffMs - 1;
  const startTime = cutoffMs - maxCandles * MS_PER_HOUR;
  const url =
    `${config.binanceBaseUrl}/api/v3/klines?symbol=${PRICE_INSTRUMENT}` +
    `&interval=${PRICE_INTERVAL}&startTime=${startTime}&endTime=${endTime}&limit=${maxCandles}`;
  const raw = (await fetchJson(url)) as unknown[][];
  const candles: Candle[] = [];
  for (const row of raw) {
    const openTime = String(row[0]);
    const closeTime = String(row[6]);
    if (Number(closeTime) >= cutoffMs) continue; // belt-and-braces: only completed
    candles.push({
      openTime,
      open: String(row[1]),
      high: String(row[2]),
      low: String(row[3]),
      close: String(row[4]),
      closeTime,
      volume: String(row[5]),
      quoteVolume: String(row[7]),
      trades: String(row[8]),
      takerBaseVolume: String(row[9]),
      takerQuoteVolume: String(row[10]),
    });
  }
  const evidence = evidenceOf(
    url,
    'observed',
    `completed ${PRICE_INSTRUMENT} ${PRICE_INTERVAL} candles with closeTime < cutoff`,
    'Binance spot klines (NEARUSDT); see Binance Terms of Use for redistribution limits',
  );
  return { candles, evidence };
}

/** Fetch the exact target-hour candle and derive the outcome (close > open). */
export async function fetchPriceResolution(
  config: RunnerConfig,
  observationStartMs: number,
): Promise<FetchedResolution & { candle: Candle }> {
  const url =
    `${config.binanceBaseUrl}/api/v3/klines?symbol=${PRICE_INSTRUMENT}` +
    `&interval=${PRICE_INTERVAL}&startTime=${observationStartMs}&limit=1`;
  const raw = (await fetchJson(url)) as unknown[][];
  const row = raw[0];
  if (!row) throw new Error(`no ${PRICE_INSTRUMENT} candle at ${observationStartMs}`);
  const candle: Candle = {
    openTime: String(row[0]),
    open: String(row[1]),
    high: String(row[2]),
    low: String(row[3]),
    close: String(row[4]),
    closeTime: String(row[6]),
    volume: String(row[5]),
    quoteVolume: String(row[7]),
    trades: String(row[8]),
    takerBaseVolume: String(row[9]),
    takerQuoteVolume: String(row[10]),
  };
  const outcome = compareDecimalStrings(candle.close, candle.open) > 0;
  const evidence = evidenceOf(
    url,
    'observed',
    `target ${PRICE_INSTRUMENT} ${PRICE_INTERVAL} candle open=${candle.open} close=${candle.close}`,
    'Binance spot klines (NEARUSDT)',
  );
  return { candle, precipitationMm: '0', outcome, evidence };
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo, ECMWF IFS 9 km, Kudus)
// ---------------------------------------------------------------------------

function openMeteoDailyUrl(config: RunnerConfig, date: string): string {
  const lat = config.kudusLatitude;
  const lon = config.kudusLongitude;
  const tz = encodeURIComponent(config.kudusTimezone);
  return (
    `${config.openMeteoBaseUrl}/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}&daily=precipitation_sum` +
    `&models=${config.weatherModel}&timezone=${tz}&start_date=${date}&end_date=${date}`
  );
}

/**
 * Fetch the pre-cutoff forecast precipitation (mm) for the target WIB date.
 * Availability is `observed` (fetched before the cutoff by the caller); the
 * model run's own publication timestamp is not exposed by Open-Meteo, so the
 * exact as-of availability of that run is `inference` and is disclosed.
 */
export async function fetchWeatherForecast(
  config: RunnerConfig,
  targetDate: string,
): Promise<FetchedForecast> {
  const url = openMeteoDailyUrl(config, targetDate);
  const json = (await fetchJson(url)) as {
    daily?: { time?: string[]; precipitation_sum?: (number | null)[] };
  };
  const times = json.daily?.time ?? [];
  const values = json.daily?.precipitation_sum ?? [];
  const idx = times.indexOf(targetDate);
  const value = idx >= 0 ? values[idx] : undefined;
  const forecastPrecipMm = typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  const evidence = evidenceOf(
    url,
    'observed',
    `forecast run fetched before cutoff for ${targetDate}; per-run publication time is not documented by Open-Meteo (availability inference)`,
    'Weather data by Open-Meteo.com (CC BY 4.0)',
  );
  return { forecastPrecipMm, evidence };
}

/**
 * Fetch the resolution precipitation for the target WIB date from the archive
 * (pinned IFS 9 km grid cell). Outcome is `precipitation_sum >= 1.0 mm`.
 */
export async function fetchWeatherResolution(
  config: RunnerConfig,
  targetDate: string,
): Promise<FetchedResolution> {
  const lat = config.kudusLatitude;
  const lon = config.kudusLongitude;
  const tz = encodeURIComponent(config.kudusTimezone);
  const url =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${lat}&longitude=${lon}&daily=precipitation_sum` +
    `&models=${config.weatherModel}&timezone=${tz}&start_date=${targetDate}&end_date=${targetDate}`;
  const json = (await fetchJson(url)) as {
    daily?: { time?: string[]; precipitation_sum?: (number | null)[] };
  };
  const times = json.daily?.time ?? [];
  const values = json.daily?.precipitation_sum ?? [];
  const idx = times.indexOf(targetDate);
  const value = idx >= 0 ? values[idx] : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`no precipitation_sum for ${targetDate} in archive response`);
  }
  const precipitationMm = String(value);
  const outcome = gteDec(precipitationMm, '1.0');
  const evidence = evidenceOf(
    url,
    'observed',
    `archive ${config.weatherModel} daily precipitation_sum=${precipitationMm} mm for ${targetDate}`,
    'Weather data by Open-Meteo.com (CC BY 4.0)',
  );
  return { precipitationMm, outcome, evidence };
}
