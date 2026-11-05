/**
 * Schedule computation and source definitions.
 *
 * Timestamps are UTC nanoseconds (`bigint`). Timezone handling is explicit:
 *   - price  : UTC hour boundaries (Binance kline `closeTime`, ms UTC)
 *   - weather: `Asia/Jakarta` (WIB, UTC+7, no DST) day boundaries
 *
 * The schedule parameters follow the plan's default table (HIVECAST_PLAN.md §2).
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
export const WEATHER_MODEL = 'ecmwf_ifs04'; // ECMWF IFS 9 km (~0.4°)
export const KUDUS_LAT = '-6.8049';
export const KUDUS_LON = '110.8397';
export const WEATHER_TIMEZONE = 'Asia/Jakarta';
export const WEATHER_THRESHOLD_MM = '1.0';

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
 * Price schedule: observation is one full UTC hour, commitment opens 15 min
 * before and closes 5 min before, resolution deadline 15 min after the hour.
 * `targetHourStartMs` is the observation-start hour boundary (ms UTC).
 */
export function computePriceSchedule(targetHourStartMs: number): Schedule {
  const obsStart = targetHourStartMs;
  const obsEnd = obsStart + MS_PER_HOUR;
  return {
    openTimeNs: msToNs(obsStart - 15 * MS_PER_MIN),
    closeTimeNs: msToNs(obsStart - 5 * MS_PER_MIN),
    observationStartNs: msToNs(obsStart),
    observationEndNs: msToNs(obsEnd),
    resolveTimeNs: msToNs(obsEnd),
    resolveDeadlineNs: msToNs(obsEnd + 15 * MS_PER_MIN),
    revealWindowNs: msToNs(15 * MS_PER_MIN),
  };
}

/**
 * Weather schedule for a WIB target date. Observation is the WIB day
 * (00:00 WIB → 00:00 WIB next day). Commitment opens 18:00 WIB the previous
 * day and closes 23:55 WIB; resolution deadline is 48 h after observation end.
 * `targetDateWibMs` is the UTC ms of 00:00 WIB on the target date.
 */
export function computeWeatherSchedule(targetDateWibMs: number): Schedule {
  const obsStart = targetDateWibMs;
  const obsEnd = obsStart + MS_PER_DAY;
  const prevDay = obsStart - MS_PER_DAY;
  return {
    openTimeNs: msToNs(prevDay + 18 * MS_PER_HOUR),
    closeTimeNs: msToNs(prevDay + 23 * MS_PER_HOUR + 55 * MS_PER_MIN),
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
export function sourceDefinition(domain: Domain, targetLabel: string): SourceDefinition {
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
    latitude: KUDUS_LAT,
    longitude: KUDUS_LON,
    timezone: WEATHER_TIMEZONE,
    threshold_mm: WEATHER_THRESHOLD_MM,
    outcome: `precipitation_sum >= ${WEATHER_THRESHOLD_MM} mm for ${targetLabel} (${WEATHER_TIMEZONE})`,
  });
  return {
    kind: 'weather',
    json,
    label: `Open-Meteo ${WEATHER_MODEL} daily precipitation_sum at Kudus (${WEATHER_TIMEZONE})`,
  };
}

/** Human-readable question text for a domain/target. */
export function questionText(domain: Domain, targetLabel: string): string {
  if (domain === 'price') {
    return `Will ${PRICE_INSTRUMENT} close higher than it opened for the ${targetLabel} UTC hour?`;
  }
  return `Will Kudus receive at least ${WEATHER_THRESHOLD_MM} mm of precipitation on ${targetLabel} (${WEATHER_TIMEZONE})?`;
}

// ---------------------------------------------------------------------------
// Stable target keys (dedup identity for a Question)
// ---------------------------------------------------------------------------

export function priceTargetKey(hourStartMs: number): string {
  return `price:${hourStartMs}`;
}

export function weatherTargetKey(date: string): string {
  return `weather:${date}`;
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
