/**
 * Schedule + source definition tests: timezone-exact boundaries and the exact
 * instrument/model/grid pins (no silent substitution).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NS_PER_MS,
  computePriceSchedule,
  computeWeatherSchedule,
  hourFloorUtc,
  wibMidnightUtc,
  wibDateOfUtcMs,
  priceTargetKey,
  weatherTargetKey,
  questionText,
  sourceDefinition,
  PRICE_INSTRUMENT,
  PRICE_INTERVAL,
  WEATHER_MODEL,
  WEATHER_THRESHOLD_MM,
} from '../src/schedule.js';

test('price schedule: 15m open / 5m close / 1h observation / 15m resolve', () => {
  // A UTC hour boundary.
  const hourStart = Date.UTC(2026, 10, 5, 14, 0, 0);
  const s = computePriceSchedule(hourStart);
  assert.equal(s.openTimeNs, BigInt(hourStart - 15 * 60_000) * NS_PER_MS);
  assert.equal(s.closeTimeNs, BigInt(hourStart - 5 * 60_000) * NS_PER_MS);
  assert.equal(s.observationStartNs, BigInt(hourStart) * NS_PER_MS);
  assert.equal(s.observationEndNs, BigInt(hourStart + 3_600_000) * NS_PER_MS);
  assert.equal(s.resolveTimeNs, s.observationEndNs);
  assert.equal(s.resolveDeadlineNs, BigInt(hourStart + 3_600_000 + 15 * 60_000) * NS_PER_MS);
  assert.equal(s.revealWindowNs, BigInt(15 * 60_000) * NS_PER_MS);
  // Ordering invariant.
  assert.ok(s.openTimeNs < s.closeTimeNs);
  assert.ok(s.closeTimeNs < s.observationStartNs);
  assert.ok(s.observationStartNs < s.observationEndNs);
  assert.ok(s.observationEndNs <= s.resolveTimeNs);
  assert.ok(s.resolveTimeNs < s.resolveDeadlineNs);
});

test('weather schedule: 18:00 WIB open / 23:55 close / 24h observation / 48h resolve deadline', () => {
  const wibMidnight = Date.UTC(2026, 10, 5, 0, 0, 0) - 7 * 3_600_000; // 00:00 WIB
  const s = computeWeatherSchedule(wibMidnight);
  const prevDay = wibMidnight - 86_400_000;
  assert.equal(s.openTimeNs, BigInt(prevDay + 18 * 3_600_000) * NS_PER_MS);
  assert.equal(s.closeTimeNs, BigInt(prevDay + 23 * 3_600_000 + 55 * 60_000) * NS_PER_MS);
  assert.equal(s.observationStartNs, BigInt(wibMidnight) * NS_PER_MS);
  assert.equal(s.observationEndNs, BigInt(wibMidnight + 86_400_000) * NS_PER_MS);
  assert.equal(s.resolveDeadlineNs, BigInt(wibMidnight + 86_400_000 + 48 * 3_600_000) * NS_PER_MS);
});

test('WIB midnight conversion is exact (UTC+7, no DST)', () => {
  // 2026-11-05 00:30 UTC → still 2026-11-05 in WIB (00:30+7 = 07:30 WIB).
  const utc = Date.UTC(2026, 10, 5, 0, 30, 0);
  assert.equal(wibDateOfUtcMs(utc), '2026-11-05');
  // 2026-11-05 17:30 UTC → 2026-11-06 00:30 WIB.
  const utc2 = Date.UTC(2026, 10, 5, 17, 30, 0);
  assert.equal(wibDateOfUtcMs(utc2), '2026-11-06');
  // Midnight WIB for a UTC timestamp inside 2026-11-05 WIB is 2026-11-04 17:00 UTC.
  const m = wibMidnightUtc(Date.UTC(2026, 10, 5, 0, 0, 0));
  assert.equal(m, Date.UTC(2026, 10, 4, 17, 0, 0));
});

test('hour floor is a UTC hour boundary', () => {
  const t = Date.UTC(2026, 10, 5, 14, 37, 12);
  assert.equal(hourFloorUtc(t), Date.UTC(2026, 10, 5, 14, 0, 0));
});

test('price source pins Binance NEARUSDT 1h', () => {
  const def = sourceDefinition('price', '2026-11-05T14:00:00.000Z');
  const parsed = JSON.parse(def.json) as { instrument: string; interval: string };
  assert.equal(parsed.instrument, PRICE_INSTRUMENT);
  assert.equal(parsed.interval, PRICE_INTERVAL);
  assert.match(def.label, /Binance spot NEARUSDT 1h/);
});

test('weather source pins Open-Meteo IFS 9km Kudus with 1.0mm threshold', () => {
  const def = sourceDefinition('weather', '2026-11-05');
  const parsed = JSON.parse(def.json) as { model: string; latitude: string; longitude: string; timezone: string; threshold_mm: string };
  assert.equal(parsed.model, WEATHER_MODEL);
  assert.equal(parsed.latitude, '-6.8049');
  assert.equal(parsed.longitude, '110.8397');
  assert.equal(parsed.timezone, 'Asia/Jakarta');
  assert.equal(parsed.threshold_mm, WEATHER_THRESHOLD_MM);
  assert.match(def.label, /Open-Meteo ecmwf_ifs04/);
});

test('question text names the instrument and threshold', () => {
  assert.match(questionText('price', 'X'), /NEARUSDT close higher/);
  assert.match(questionText('weather', '2026-11-05'), /1\.0 mm/);
});

test('target keys are stable and domain-scoped', () => {
  assert.equal(priceTargetKey(123), 'price:123');
  assert.equal(weatherTargetKey('2026-11-05'), 'weather:2026-11-05');
});
