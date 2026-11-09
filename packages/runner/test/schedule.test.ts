/**
 * Multi-city weather schedule: local-day boundaries per IANA time zone
 * (including DST), Question identity per (city, date), pinned source specs,
 * and config validation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';

import {
  DEFAULT_WEATHER_CITIES,
  computeWeatherSchedule,
  localDateOfUtcMs,
  nextDate,
  nsToMs,
  parseSourceSpec,
  questionText,
  sourceDefinition,
  weatherTargetKey,
  zonedMidnightUtc,
} from '../src/schedule.js';
import { loadConfig } from '../src/config.js';

test('default cities: Jakarta, Singapore, London, Dubai, Tokyo (no Kudus)', () => {
  assert.deepEqual(DEFAULT_WEATHER_CITIES.map((c) => c.id), ['jakarta', 'singapore', 'london', 'dubai', 'tokyo']);
});

test('zonedMidnightUtc gives local 00:00 for each zone, DST-aware for London', () => {
  assert.equal(new Date(zonedMidnightUtc('2026-11-10', 'Asia/Jakarta')).toISOString(), '2026-11-09T17:00:00.000Z');
  assert.equal(new Date(zonedMidnightUtc('2026-11-10', 'Asia/Tokyo')).toISOString(), '2026-11-09T15:00:00.000Z');
  assert.equal(new Date(zonedMidnightUtc('2026-11-10', 'Asia/Dubai')).toISOString(), '2026-11-09T20:00:00.000Z');
  assert.equal(new Date(zonedMidnightUtc('2026-11-10', 'Europe/London')).toISOString(), '2026-11-10T00:00:00.000Z');
  assert.equal(new Date(zonedMidnightUtc('2026-07-10', 'Europe/London')).toISOString(), '2026-07-09T23:00:00.000Z');
});

test('localDateOfUtcMs maps an instant to the right local calendar date', () => {
  const t = Date.parse('2026-11-09T18:30:00Z');
  assert.equal(localDateOfUtcMs(t, 'Asia/Jakarta'), '2026-11-10');
  assert.equal(localDateOfUtcMs(t, 'Europe/London'), '2026-11-09');
  assert.equal(nextDate('2026-12-31'), '2027-01-01');
});

test('weather schedule: commitments open 18:00 and close 23:55 local the evening before', () => {
  const tokyo = DEFAULT_WEATHER_CITIES.find((c) => c.id === 'tokyo')!;
  const start = zonedMidnightUtc('2026-11-10', tokyo.timezone);
  const end = zonedMidnightUtc(nextDate('2026-11-10'), tokyo.timezone);
  const s = computeWeatherSchedule(start, end);
  const fmt = (ns: bigint) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: tokyo.timezone, dateStyle: 'short', timeStyle: 'short' }).format(nsToMs(ns));
  assert.equal(fmt(s.openTimeNs), '09/11/2026, 18:00');
  assert.equal(fmt(s.closeTimeNs), '09/11/2026, 23:55');
  assert.equal(fmt(s.observationStartNs), '10/11/2026, 00:00');
  assert.equal(fmt(s.observationEndNs), '11/11/2026, 00:00');
});

test('each city gets its own Question identity and a pinned source', () => {
  const london = DEFAULT_WEATHER_CITIES.find((c) => c.id === 'london')!;
  assert.equal(weatherTargetKey('2026-11-10', 'london'), 'weather:london:2026-11-10');
  assert.notEqual(weatherTargetKey('2026-11-10', 'london'), weatherTargetKey('2026-11-10', 'dubai'));
  const src = sourceDefinition('weather', '2026-11-10', london);
  const spec = parseSourceSpec(src.json);
  assert.equal(spec.kind, 'weather');
  if (spec.kind === 'weather') {
    assert.equal(spec.city, 'London');
    assert.equal(spec.latitude, '51.5074');
    assert.equal(spec.timezone, 'Europe/London');
  }
  assert.match(questionText('weather', '2026-11-10', london), /^Will London \(United Kingdom\) receive at least 1\.0 mm of rain on 2026-11-10/);
});

test('a weather source without a pinned grid point is rejected (never a silent default)', () => {
  assert.throws(() => parseSourceSpec(JSON.stringify({ kind: 'weather', model: 'ecmwf_ifs' })), /pin latitude/);
});

function cfgFile(extra: Record<string, unknown>): string {
  const agentAccounts: Record<string, string> = {};
  for (const a of ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip']) agentAccounts[a] = `${a}.x.testnet`;
  const file = path.join(tmpdir(), `hivecast-cities-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({
    networkId: 'testnet', contractId: 'c.testnet', operatorId: 'o.testnet', resolverId: 'o.testnet',
    rpcUrl: 'https://unused.invalid', credentialDirectory: '/x', databasePath: ':memory:', agentAccounts, ...extra,
  }));
  return file;
}

test('config: weatherCities defaults to the five cities and validates custom lists', () => {
  const def = cfgFile({});
  assert.equal(loadConfig(def).weatherCities.length, 5);
  rmSync(def);

  const custom = cfgFile({ weatherCities: [{ id: 'paris', name: 'Paris', country: 'France', latitude: '48.8566', longitude: '2.3522', timezone: 'Europe/Paris' }] });
  assert.deepEqual(loadConfig(custom).weatherCities.map((c) => c.id), ['paris']);
  rmSync(custom);

  const badTz = cfgFile({ weatherCities: [{ id: 'x', name: 'X', country: 'X', latitude: '0', longitude: '0', timezone: 'Mars/Olympus' }] });
  assert.throws(() => loadConfig(badTz), /IANA/);
  rmSync(badTz);

  const dup = cfgFile({ weatherCities: [DEFAULT_WEATHER_CITIES[0], DEFAULT_WEATHER_CITIES[0]] });
  assert.throws(() => loadConfig(dup), /duplicate/);
  rmSync(dup);
});
