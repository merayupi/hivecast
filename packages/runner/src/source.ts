/**
 * Source fetchers (Binance NEARUSDT 1h candles, Open-Meteo IFS 9 km per-city daily
 * precipitation). No silent substitution: the instrument/model/grid/timezone is
 * pinned per Question (parsed from its on-chain `source_json`), never read from
 * mutable global config. Every fetch returns full evidence (request URL, model,
 * grid, timezone, units, timestamp, hash, raw response) so the resolution is
 * reproducible and provider revisions cannot silently change a final Outcome.
 */

import { createHash } from 'node:crypto';
import { compareDecimalStrings, gteDec } from '@hivecast/core';
import type { Candle } from '@hivecast/core';
import type { PriceSourceSpec, WeatherSourceSpec } from './schedule.js';
import { MS_PER_HOUR } from './schedule.js';

export interface FetchBases {
  binanceBaseUrl: string;
  openMeteoBaseUrl: string;
  archiveBaseUrl: string;
}

export interface Evidence {
  source: string; // full request URL
  model: string; // pinned model (weather) or '' for price
  instrument: string; // pinned instrument (price) or '' for weather
  latitude: string;
  longitude: string;
  timezone: string;
  units: string;
  fetchedAtMs: number;
  availability: 'observed' | 'inference';
  note: string;
  attribution: string;
  rawJson: string; // exact provider response body
  hash: string; // sha256 of rawJson
}

export interface FetchedCandles {
  candles: Candle[];
  evidence: Evidence;
}

export interface FetchedForecast {
  forecastPrecipMm: string | null;
  evidence: Evidence;
}

export interface FetchedResolution {
  precipitationMm: string;
  outcome: boolean;
  evidence: Evidence;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as unknown;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function buildEvidence(
  source: string,
  rawJson: string,
  opts: {
    model?: string;
    instrument?: string;
    latitude?: string;
    longitude?: string;
    timezone?: string;
    units: string;
    availability: 'observed' | 'inference';
    note: string;
    attribution: string;
  },
): Evidence {
  return {
    source,
    model: opts.model ?? '',
    instrument: opts.instrument ?? '',
    latitude: opts.latitude ?? '',
    longitude: opts.longitude ?? '',
    timezone: opts.timezone ?? '',
    units: opts.units,
    fetchedAtMs: Date.now(),
    availability: opts.availability,
    note: opts.note,
    attribution: opts.attribution,
    rawJson,
    hash: sha256Hex(rawJson),
  };
}

// ---------------------------------------------------------------------------
// Price (Binance spot klines)
// ---------------------------------------------------------------------------

export async function fetchCompletedCandles(
  bases: FetchBases,
  spec: PriceSourceSpec,
  cutoffMs: number,
  maxCandles = 48,
): Promise<FetchedCandles> {
  const endTime = cutoffMs - 1;
  const startTime = cutoffMs - maxCandles * MS_PER_HOUR;
  const url =
    `${bases.binanceBaseUrl}/api/v3/klines?symbol=${spec.instrument}` +
    `&interval=${spec.interval}&startTime=${startTime}&endTime=${endTime}&limit=${maxCandles}`;
  const raw = (await fetchJson(url)) as unknown[][];
  const candles: Candle[] = [];
  for (const row of raw) {
    const openTime = String(row[0]);
    const closeTime = String(row[6]);
    if (Number(closeTime) >= cutoffMs) continue; // only completed candles
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
  const evidence = buildEvidence(url, JSON.stringify(raw), {
    instrument: spec.instrument,
    units: 'candle open/close decimal strings (ms UTC)',
    availability: 'observed',
    note: `completed ${spec.instrument} ${spec.interval} candles with closeTime < cutoff`,
    attribution: 'Binance spot klines (NEARUSDT); see Binance Terms of Use for redistribution limits',
  });
  return { candles, evidence };
}

/** Fetch the exact target-hour candle and derive the outcome (close > open). */
export async function fetchPriceResolution(
  bases: FetchBases,
  spec: PriceSourceSpec,
  observationStartMs: number,
  nowMs: number,
): Promise<FetchedResolution & { candle: Candle }> {
  const url =
    `${bases.binanceBaseUrl}/api/v3/klines?symbol=${spec.instrument}` +
    `&interval=${spec.interval}&startTime=${observationStartMs}&limit=1`;
  const raw = (await fetchJson(url)) as unknown[][];
  const row = raw[0];
  if (!row) throw new Error(`no ${spec.instrument} candle at ${observationStartMs}`);
  const openTime = Number(row[0]);
  const closeTime = Number(row[6]);
  // Validate the exact target hour. Binance closeTime is the INCLUSIVE end of
  // the interval (openTime + interval - 1 ms), not an exclusive boundary.
  if (openTime !== observationStartMs) {
    throw new Error(`candle openTime ${openTime} != target ${observationStartMs}`);
  }
  if (closeTime !== openTime + MS_PER_HOUR - 1) {
    throw new Error(`candle closeTime ${closeTime} != ${openTime + MS_PER_HOUR - 1} (not a complete ${spec.interval} candle)`);
  }
  if (closeTime >= nowMs) {
    throw new Error(`target candle is not completed yet (inclusive closeTime ${closeTime} >= now ${nowMs})`);
  }
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
  const evidence = buildEvidence(url, JSON.stringify(raw), {
    instrument: spec.instrument,
    units: 'candle open/close decimal strings (ms UTC)',
    availability: 'observed',
    note: `target ${spec.instrument} ${spec.interval} candle open=${candle.open} close=${candle.close} (completed)`,
    attribution: 'Binance spot klines (NEARUSDT)',
  });
  return { candle, precipitationMm: '0', outcome, evidence };
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo, pinned model/grid)
// ---------------------------------------------------------------------------

function openMeteoForecastUrl(bases: FetchBases, spec: WeatherSourceSpec, date: string): string {
  const tz = encodeURIComponent(spec.timezone);
  return (
    `${bases.openMeteoBaseUrl}/v1/forecast` +
    `?latitude=${spec.latitude}&longitude=${spec.longitude}&daily=precipitation_sum` +
    `&models=${spec.model}&timezone=${tz}&start_date=${date}&end_date=${date}`
  );
}

function openMeteoArchiveUrl(bases: FetchBases, spec: WeatherSourceSpec, date: string): string {
  const tz = encodeURIComponent(spec.timezone);
  return (
    `${bases.archiveBaseUrl}/v1/archive` +
    `?latitude=${spec.latitude}&longitude=${spec.longitude}&daily=precipitation_sum` +
    `&models=${spec.model}&timezone=${tz}&start_date=${date}&end_date=${date}`
  );
}

/**
 * Fetch the pre-cutoff forecast precipitation (mm) for the target WIB date.
 * The model run's own publication timestamp is not exposed by Open-Meteo, so
 * exact as-of availability is `inference` and is disclosed.
 */
export async function fetchWeatherForecast(
  bases: FetchBases,
  spec: WeatherSourceSpec,
  targetDate: string,
): Promise<FetchedForecast> {
  const url = openMeteoForecastUrl(bases, spec, targetDate);
  const raw = (await fetchJson(url)) as {
    daily?: { time?: string[]; precipitation_sum?: (number | null)[] };
  };
  const times = raw.daily?.time ?? [];
  const values = raw.daily?.precipitation_sum ?? [];
  const idx = times.indexOf(targetDate);
  const value = idx >= 0 ? values[idx] : undefined;
  const forecastPrecipMm = typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  const evidence = buildEvidence(url, JSON.stringify(raw), {
    model: spec.model,
    latitude: spec.latitude,
    longitude: spec.longitude,
    timezone: spec.timezone,
    units: 'mm (daily precipitation_sum)',
    availability: 'observed',
    note: `forecast run fetched before cutoff for ${targetDate}; per-run publication time not documented by Open-Meteo (availability inference)`,
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  });
  return { forecastPrecipMm, evidence };
}

/** Fetch the resolution precipitation for the target WIB date from the archive. */
export async function fetchWeatherResolution(
  bases: FetchBases,
  spec: WeatherSourceSpec,
  targetDate: string,
): Promise<FetchedResolution> {
  const url = openMeteoArchiveUrl(bases, spec, targetDate);
  const raw = (await fetchJson(url)) as {
    daily?: { time?: string[]; precipitation_sum?: (number | null)[] };
  };
  const times = raw.daily?.time ?? [];
  const values = raw.daily?.precipitation_sum ?? [];
  const idx = times.indexOf(targetDate);
  const value = idx >= 0 ? values[idx] : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`no precipitation_sum for ${targetDate} in archive response (model=${spec.model})`);
  }
  const precipitationMm = String(value);
  const outcome = gteDec(precipitationMm, spec.thresholdMm);
  const evidence = buildEvidence(url, JSON.stringify(raw), {
    model: spec.model,
    latitude: spec.latitude,
    longitude: spec.longitude,
    timezone: spec.timezone,
    units: 'mm (daily precipitation_sum)',
    availability: 'observed',
    note: `archive ${spec.model} daily precipitation_sum=${precipitationMm} mm for ${targetDate} (threshold ${spec.thresholdMm} mm)`,
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  });
  return { precipitationMm, outcome, evidence };
}

/** Fetch the historical daily precipitation for one past WIB date. */
export async function fetchWeatherHistoryDay(
  bases: FetchBases,
  spec: WeatherSourceSpec,
  date: string,
): Promise<{ precipitationMm: string; evidence: Evidence }> {
  const url = openMeteoArchiveUrl(bases, spec, date);
  const raw = (await fetchJson(url)) as {
    daily?: { time?: string[]; precipitation_sum?: (number | null)[] };
  };
  const times = raw.daily?.time ?? [];
  const values = raw.daily?.precipitation_sum ?? [];
  const idx = times.indexOf(date);
  const value = idx >= 0 ? values[idx] : undefined;
  const precipitationMm = typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  if (precipitationMm === null) {
    throw new Error(`no precipitation_sum for ${date} in archive response (model=${spec.model})`);
  }
  const evidence = buildEvidence(url, JSON.stringify(raw), {
    model: spec.model,
    latitude: spec.latitude,
    longitude: spec.longitude,
    timezone: spec.timezone,
    units: 'mm (daily precipitation_sum)',
    availability: 'observed',
    note: `archive ${spec.model} daily precipitation_sum=${precipitationMm} mm for ${date}`,
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  });
  return { precipitationMm, evidence };
}
