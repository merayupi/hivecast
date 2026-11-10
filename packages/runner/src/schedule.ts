/**
 * Schedule computation and source definitions.
 *
 * Timestamps are UTC nanoseconds (`bigint`). Timezone handling is explicit:
 *   - price  : UTC hour boundaries (Binance kline `closeTime`, ms UTC)
 *   - weather: each city's local calendar day (IANA time zone, DST-aware)
 *
 * The schedule parameters are the default timing table in RULES.md §2.
 */

import type { Domain } from '@hivecast/core';
import type { SourceDefinition } from './types.js';

export const NS_PER_MS = 1_000_000n;
export const NS_PER_SEC = 1_000_000_000n;
export const MS_PER_MIN = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

export const WIB_OFFSET_MS = 7 * MS_PER_HOUR; // UTC+7, no DST

export const PRICE_INSTRUMENT = 'NEARUSDT';
export const PRICE_INTERVAL = '1h';
export const WEATHER_MODEL = 'ecmwf_ifs'; // ECMWF IFS 9 km — the pinned resolution model
export const WEATHER_THRESHOLD_MM = '1.0';

/** A city whose daily rain the weather domain forecasts. */
export interface WeatherCity {
  /** Stable id used in target keys, e.g. `jakarta`. Lowercase letters, digits, dashes. */
  id: string;
  name: string;
  country: string;
  latitude: string;
  longitude: string;
  /** IANA time zone: the local day is the observation window. */
  timezone: string;
}

/**
 * Default cities: contrasting climates so weather skill is visible (Singapore
 * rains most days, Dubai almost never). Coordinates are city centres; the
 * Outcome is the ECMWF IFS 9 km grid cell nearest each point.
 */
export const DEFAULT_WEATHER_CITIES: readonly WeatherCity[] = [
  { id: 'jakarta', name: 'Jakarta', country: 'Indonesia', latitude: '-6.2088', longitude: '106.8456', timezone: 'Asia/Jakarta' },
  { id: 'singapore', name: 'Singapore', country: 'Singapore', latitude: '1.3521', longitude: '103.8198', timezone: 'Asia/Singapore' },
  { id: 'london', name: 'London', country: 'United Kingdom', latitude: '51.5074', longitude: '-0.1278', timezone: 'Europe/London' },
  { id: 'dubai', name: 'Dubai', country: 'United Arab Emirates', latitude: '25.2048', longitude: '55.2708', timezone: 'Asia/Dubai' },
  { id: 'tokyo', name: 'Tokyo', country: 'Japan', latitude: '35.6762', longitude: '139.6503', timezone: 'Asia/Tokyo' },
];

// ---------------------------------------------------------------------------
// Time-zone helpers (Intl, so DST is handled, e.g. Europe/London)
// ---------------------------------------------------------------------------

/** Local calendar date (YYYY-MM-DD) of a UTC instant in an IANA time zone. */
export function localDateOfUtcMs(utcMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utcMs));
}

/** Offset (ms) of `timeZone` from UTC at `utcMs` (positive east of UTC). */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC ms of 00:00 local time on `date` (YYYY-MM-DD) in `timeZone`. */
export function zonedMidnightUtc(date: string, timeZone: string): number {
  const naive = Date.parse(`${date}T00:00:00Z`);
  // Two passes settle the offset even across a DST change.
  let guess = naive - zoneOffsetMs(naive, timeZone);
  guess = naive - zoneOffsetMs(guess, timeZone);
  return guess;
}

/** The calendar date after `date` (YYYY-MM-DD). */
export function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + MS_PER_DAY).toISOString().slice(0, 10);
}

export const DEFAULT_MIN_STAKE = 100_000_000_000_000_000_000_000n; // 0.1 NEAR
export const DEFAULT_ACCESS_PRICE = 10_000_000_000_000_000_000_000n; // 0.01 NEAR

/** Convert a ms epoch to UTC nanoseconds. */
export function msToNs(ms: number | bigint): bigint {
  return BigInt(ms) * NS_PER_MS;
}

export function nsToMs(ns: bigint): number {
  return Number(ns / NS_PER_MS);
}

export interface Schedule {
  openTimeNs: bigint;
  closeTimeNs: bigint;
  observationStartNs: bigint;
  observationEndNs: bigint;
  resolveTimeNs: bigint;
  resolveDeadlineNs: bigint;
  revealWindowNs: bigint;
}

/**
 * Price commitments close this long before the observed hour starts. The
 * forecast is on sale from then until the hour starts, so this is also the
 * length of the sale window: half of every hour has a price forecast on sale.
 * Agents lose no input by committing this early: the last completed 1h candle
 * is the same 30 min and 5 min before the hour.
 */
export const PRICE_CLOSE_LEAD_MS = 30 * MS_PER_MIN;
/** Price commitments stay open this long before they close. */
export const PRICE_COMMIT_WINDOW_MS = 15 * MS_PER_MIN;

/**
 * Price schedule: observation is one full UTC hour, commitment opens 45 min
 * before and closes 30 min before, resolution deadline 15 min after the hour.
 * `targetHourStartMs` is the observation-start hour boundary (ms UTC).
 */
export function computePriceSchedule(targetHourStartMs: number): Schedule {
  const obsStart = targetHourStartMs;
  const obsEnd = obsStart + MS_PER_HOUR;
  return {
    openTimeNs: msToNs(obsStart - PRICE_CLOSE_LEAD_MS - PRICE_COMMIT_WINDOW_MS),
    closeTimeNs: msToNs(obsStart - PRICE_CLOSE_LEAD_MS),
    observationStartNs: msToNs(obsStart),
    observationEndNs: msToNs(obsEnd),
    resolveTimeNs: msToNs(obsEnd),
    resolveDeadlineNs: msToNs(obsEnd + 15 * MS_PER_MIN),
    revealWindowNs: msToNs(15 * MS_PER_MIN),
  };
}

/**
 * Weather schedule for one local day. Observation is local 00:00 → next local
 * 00:00 (`obsEndMs` defaults to 24 h later; pass it on DST-change days).
 * Commitment opens 6 h before (18:00 local the previous evening) and closes
 * 5 min before (23:55 local); resolution deadline is 48 h after observation end.
 */
export function computeWeatherSchedule(obsStartMs: number, obsEndMs?: number): Schedule {
  const obsStart = obsStartMs;
  const obsEnd = obsEndMs ?? obsStart + MS_PER_DAY;
  return {
    openTimeNs: msToNs(obsStart - 6 * MS_PER_HOUR),
    closeTimeNs: msToNs(obsStart - 5 * MS_PER_MIN),
    observationStartNs: msToNs(obsStart),
    observationEndNs: msToNs(obsEnd),
    resolveTimeNs: msToNs(obsEnd),
    resolveDeadlineNs: msToNs(obsEnd + 48 * MS_PER_HOUR),
    revealWindowNs: msToNs(15 * MS_PER_MIN),
  };
}

/** UTC ms of the most recent (or equal) hour boundary at or before `nowMs`. */
export function hourFloorUtc(nowMs: number): number {
  return nowMs - (nowMs % MS_PER_HOUR);
}

/**
 * UTC ms of 00:00 WIB on the WIB date that `nowMs` (UTC) falls within.
 * WIB date = floor((utcMs + offset) / day) * day - offset.
 */
export function wibMidnightUtc(nowMs: number): number {
  const wibNow = nowMs + WIB_OFFSET_MS;
  const wibDayStart = wibNow - (wibNow % MS_PER_DAY);
  return wibDayStart - WIB_OFFSET_MS;
}

/** Build the machine-readable `source` string stored on-chain. */
export function sourceDefinition(
  domain: Domain,
  targetLabel: string,
  city: WeatherCity = DEFAULT_WEATHER_CITIES[0]!,
): SourceDefinition {
  if (domain === 'price') {
    const json = JSON.stringify({
      kind: 'price',
      instrument: PRICE_INSTRUMENT,
      interval: PRICE_INTERVAL,
      outcome: 'close > open on the completed UTC hour candle (ties/lower = NO)',
    });
    return { kind: 'price', json, label: `Binance spot ${PRICE_INSTRUMENT} ${PRICE_INTERVAL} candle` };
  }
  const json = JSON.stringify({
    kind: 'weather',
    model: WEATHER_MODEL,
    city: city.name,
    city_id: city.id,
    country: city.country,
    latitude: city.latitude,
    longitude: city.longitude,
    timezone: city.timezone,
    threshold_mm: WEATHER_THRESHOLD_MM,
    outcome: `precipitation_sum >= ${WEATHER_THRESHOLD_MM} mm for ${targetLabel} (${city.timezone})`,
  });
  return {
    kind: 'weather',
    json,
    label: `Open-Meteo ${WEATHER_MODEL} daily precipitation_sum at ${city.name}, ${city.country} (${city.timezone})`,
  };
}

/** Human-readable question text for a domain/target. */
export function questionText(domain: Domain, targetLabel: string, city: WeatherCity = DEFAULT_WEATHER_CITIES[0]!): string {
  if (domain === 'price') {
    return `Will ${PRICE_INSTRUMENT} close higher than it opened for the ${targetLabel} UTC hour?`;
  }
  return `Will ${city.name} (${city.country}) receive at least ${WEATHER_THRESHOLD_MM} mm of rain on ${targetLabel} (local date, ${city.timezone})?`;
}

// ---------------------------------------------------------------------------
// Stable target keys (dedup identity for a Question)
// ---------------------------------------------------------------------------

export function priceTargetKey(hourStartMs: number): string {
  return `price:${hourStartMs}`;
}

/** One weather Question per (city, local date). */
export function weatherTargetKey(date: string, cityId: string): string {
  return `weather:${cityId}:${date}`;
}

/** WIB date (YYYY-MM-DD) of a UTC ms timestamp. */
export function wibDateOfUtcMs(utcMs: number): string {
  const wibMs = utcMs + WIB_OFFSET_MS;
  return new Date(wibMs).toISOString().slice(0, 10);
}

/** ISO hour label (UTC) for a price target. */
export function priceTargetLabel(hourStartMs: number): string {
  return new Date(hourStartMs).toISOString();
}

/** ISO date label (WIB) for a weather target. */
export function weatherTargetLabel(date: string): string {
  return date;
}

// ---------------------------------------------------------------------------
// Per-Question pinned source spec (parsed from the on-chain sourceJson)
// ---------------------------------------------------------------------------

export interface PriceSourceSpec {
  kind: 'price';
  instrument: string;
  interval: string;
}

export interface WeatherSourceSpec {
  kind: 'weather';
  model: string;
  /** Display name; absent on Questions created before multi-city support. */
  city: string | null;
  latitude: string;
  longitude: string;
  timezone: string;
  thresholdMm: string;
}

export type SourceSpec = PriceSourceSpec | WeatherSourceSpec;

/**
 * Parse the pinned sourceJson stored on-chain at creation. The runner resolves
 * from THIS, never from mutable global config — so a Question keeps its exact
 * instrument/model/grid after creation even if defaults change later.
 */
export function parseSourceSpec(sourceJson: string): SourceSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(sourceJson);
  } catch {
    throw new Error(`invalid sourceJson: ${sourceJson}`);
  }
  if (typeof raw !== 'object' || raw === null || !('kind' in raw)) {
    throw new Error('sourceJson missing kind');
  }
  const o = raw as Record<string, unknown>;
  if (o.kind === 'price') {
    return {
      kind: 'price',
      instrument: String(o.instrument ?? PRICE_INSTRUMENT),
      interval: String(o.interval ?? PRICE_INTERVAL),
    };
  }
  if (o.kind === 'weather') {
    // A weather Question always pins its own grid point and time zone; never
    // fall back to a global default (that would silently move the location).
    if (o.latitude === undefined || o.longitude === undefined || o.timezone === undefined) {
      throw new Error('weather sourceJson must pin latitude, longitude and timezone');
    }
    return {
      kind: 'weather',
      model: String(o.model ?? WEATHER_MODEL),
      city: typeof o.city === 'string' ? o.city : null,
      latitude: String(o.latitude),
      longitude: String(o.longitude),
      timezone: String(o.timezone),
      thresholdMm: String(o.threshold_mm ?? WEATHER_THRESHOLD_MM),
    };
  }
  throw new Error(`unknown source kind: ${String(o.kind)}`);
}
