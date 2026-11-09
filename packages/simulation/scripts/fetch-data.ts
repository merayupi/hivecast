/**
 * One-shot data fetcher + manifest generator for the offline replay bundle.
 *
 * Fetches real historical data from primary public sources and writes the
 * committed bundle under packages/simulation/data/, including manifest.json
 * with observed fetch time, checksums, and honest availability classification.
 * Run with network access; `npm run sim` itself reads only committed files.
 *
 *   price   : Binance Vision monthly kline archives (NEARUSDT 1h), CC BY-NC-SA
 *             4.0, each zip verified against its published .CHECKSUM file.
 *   weather : Open-Meteo archive ECMWF IFS daily precipitation_sum (outcomes +
 *             365-day warm-up), and Single Runs IFS hourly precipitation
 *             (meteo forecast input), summed over each target WIB day.
 */

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
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
// Replay location: Jakarta (Asia/Jakarta, WIB, same day boundaries as before).
const LOCATION = 'Jakarta, Indonesia';
const LAT = -6.2088;
const LON = 106.8456;

const HOUR_MS = 3600 * 1000;
const BINANCE_VISION_BASE = 'https://data.binance.vision/data/spot/monthly/klines';
const BINANCE_VISION_TERMS =
  'https://github.com/binance/binance-public-data/blob/master/TERMS_AND_CONDITIONS.md';

/** Microseconds → milliseconds (both as strings), via BigInt floor division. */
function usToMs(us: string): string {
  return (BigInt(us) / 1000n).toString();
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256Text(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

interface ArchiveFetch {
  month: string;
  url: string;
  zipSha256: string;
  publishedSha256: string;
  lastModified: string | null;
  bytes: number;
  lines: string[][];
}

async function fetchText(url: string, label: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${res.statusText} (${url})`);
  return await res.text();
}

async function fetchBuffer(url: string, label: string): Promise<{ buf: Buffer; lastModified: string | null }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${res.statusText} (${url})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, lastModified: res.headers.get('last-modified') };
}

async function fetchArchive(month: string): Promise<ArchiveFetch> {
  const zipName = `${PRICE_SYMBOL}-${PRICE_INTERVAL}-${month}.zip`;
  const url = `${BINANCE_VISION_BASE}/${PRICE_SYMBOL}/${PRICE_INTERVAL}/${zipName}`;
  const checksumUrl = `${url}.CHECKSUM`;

  const { buf, lastModified } = await fetchBuffer(url, `binance vision ${month}`);
  const published = (await fetchText(checksumUrl, `binance vision checksum ${month}`)).trim();
  const publishedSha256 = published.split(/\s+/)[0]!;
  const zipSha256 = sha256Buffer(buf);

  if (zipSha256 !== publishedSha256) {
    throw new Error(`${month}: archive checksum mismatch — fetched ${zipSha256}, published ${publishedSha256}`);
  }

  // Decompress the single-member zip: Binance zips are simple single-file
  // deflate archives; readZipCsv locates the local file header and inflates.
  const csvText = readZipCsv(buf, inflateRawSync);
  const lines = csvText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(','));
  return { month, url, zipSha256, publishedSha256, lastModified, bytes: buf.length, lines };
}

/**
 * Extract the single CSV member from a Binance Vision monthly zip. Binance
 * zips are simple single-file deflate archives; this reads the local file
 * header, locates the compressed bytes, and inflates them.
 */
function readZipCsv(buf: Buffer, inflateRawSync: (b: Buffer) => Buffer): string {
  // Central directory: scan for the local file header signature PK\x03\x04.
  const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let off = 0;
  while (off < buf.length - 4 && !buf.subarray(off, off + 4).equals(SIG)) off++;
  if (off >= buf.length - 4) throw new Error('zip: local file header not found');
  // local file header: 30 bytes fixed, then nameLen + extraLen, then data.
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const compMethod = buf.readUInt16LE(off + 8);
  const compSize = buf.readUInt32LE(off + 18);
  const compressed = buf.subarray(dataStart, dataStart + compSize);
  if (compMethod !== 8) throw new Error(`zip: unsupported compression method ${compMethod}`);
  const raw = inflateRawSync(compressed);
  return raw.toString('utf8');
}

function candleFromCsv(cols: string[]) {
  return {
    openTime: usToMs(cols[0]!),
    open: cols[1]!,
    high: cols[2]!,
    low: cols[3]!,
    close: cols[4]!,
    volume: cols[5]!,
    closeTime: usToMs(cols[6]!),
    quoteVolume: cols[7]!,
    trades: cols[8]!,
    takerBaseVolume: cols[9]!,
    takerQuoteVolume: cols[10]!,
  };
}

interface WeatherRun {
  error?: boolean;
  reason?: string;
  hourly?: { time: string[]; precipitation: (number | null)[] };
}

interface WeatherArchiveDoc {
  latitude: number;
  longitude: number;
  elevation: number;
  timezone: string;
  utc_offset_seconds: number;
  daily_units: { precipitation_sum: string };
  daily: { time: string[]; precipitation_sum: number[] };
}

function utcMs(dateStr: string, h = 0): number {
  return Date.parse(`${dateStr}T${String(h).padStart(2, '0')}:00:00Z`);
}

async function run(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  // ---- Price candles from Binance Vision archives -------------------------
  const archiveMonths = ['2026-07', '2026-08', '2026-09'];
  const archives: ArchiveFetch[] = [];
  for (const m of archiveMonths) {
    archives.push(await fetchArchive(m));
  }

  const allCandles = archives.flatMap((a) => a.lines.map(candleFromCsv));
  const warmupStartMs = utcMs(PRICE_WARMUP_START);
  const evalStartMs = utcMs(EVAL_START);
  const evalEndMs = utcMs(EVAL_END, 23);

  const candles = allCandles.filter((c) => {
    const t = Number(c.openTime);
    return t >= warmupStartMs && t <= evalEndMs;
  });

  const evalCandles = candles.filter((c) => Number(c.openTime) >= evalStartMs && Number(c.openTime) <= evalEndMs);
  const warmupCandles = candles.filter((c) => Number(c.openTime) < evalStartMs);

  // Completeness: exactly 168 warm-up + 1440 eval, contiguous hourly.
  if (warmupCandles.length !== 168) throw new Error(`expected 168 warm-up candles, got ${warmupCandles.length}`);
  if (evalCandles.length !== 1440) throw new Error(`expected 1440 eval candles, got ${evalCandles.length}`);
  for (let i = 1; i < candles.length; i++) {
    const gap = Number(candles[i]!.openTime) - Number(candles[i - 1]!.openTime);
    if (gap !== HOUR_MS) throw new Error(`non-contiguous hourly candles at index ${i} (gap ${gap}ms)`);
  }

  const priceDoc = {
    symbol: PRICE_SYMBOL,
    interval: PRICE_INTERVAL,
    source: 'Binance Vision monthly kline archives (NEARUSDT 1h)',
    evalStart: EVAL_START,
    evalEnd: EVAL_END,
    warmupStart: PRICE_WARMUP_START,
    candles,
  };

  // ---- Weather archive (outcomes + 365-day warm-up) ------------------------
  const archiveUrl =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${LAT}&longitude=${LON}&daily=precipitation_sum` +
    `&timezone=Asia%2FJakarta&start_date=${WEATHER_WARMUP_START}&end_date=${EVAL_END}` +
    `&models=ecmwf_ifs`;
  const archiveText = await fetchText(archiveUrl, 'open-meteo archive');
  const archive = JSON.parse(archiveText) as WeatherArchiveDoc;
  if (archive.daily.time.length !== 425) {
    throw new Error(`expected 425 archive days, got ${archive.daily.time.length}`);
  }
  if (archive.daily.time[0] !== WEATHER_WARMUP_START || archive.daily.time[424] !== EVAL_END) {
    throw new Error('archive date range mismatch');
  }
  for (const v of archive.daily.precipitation_sum) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error('archive contains invalid precipitation value');
    }
  }

  // ---- Weather forecast inputs (meteo): Single Runs IFS --------------------
  const evalDates = archive.daily.time.slice(-60);
  const forecasts: Record<string, { run: string; precipMm: number }> = {};
  for (const targetDate of evalDates) {
    const runDate = new Date(Date.parse(`${targetDate}T00:00:00Z`) - 24 * HOUR_MS).toISOString().slice(0, 10);
    const runUrl =
      `https://single-runs-api.open-meteo.com/v1/forecast` +
      `?latitude=${LAT}&longitude=${LON}&run=${runDate}T00:00` +
      `&hourly=precipitation&models=ecmwf_ifs&timezone=Asia%2FJakarta&forecast_hours=48`;
    const runText = await fetchText(runUrl, `single-runs ${targetDate}`);
    const run = JSON.parse(runText) as WeatherRun;
    if (run.error || !run.hourly) throw new Error(`single-runs failed for ${targetDate}: ${run.reason ?? 'no hourly'}`);
    const { time, precipitation } = run.hourly;
    let sum = 0;
    let found = 0;
    for (let i = 0; i < time.length; i++) {
      if (time[i]!.startsWith(targetDate)) {
        const v = precipitation[i];
        if (typeof v === 'number' && Number.isFinite(v)) {
          sum += v;
          found++;
        }
      }
    }
    if (found !== 24) throw new Error(`expected 24 hourly values for ${targetDate}, got ${found}`);
    forecasts[targetDate] = { run: `${runDate}T00:00Z`, precipMm: sum };
  }
  if (Object.keys(forecasts).length !== 60) {
    throw new Error(`expected 60 forecasts, got ${Object.keys(forecasts).length}`);
  }

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

  // ---- Write bundle + regenerate manifest ----------------------------------
  const priceJson = JSON.stringify(priceDoc, null, 2) + '\n';
  const weatherJson = JSON.stringify(weatherDoc, null, 2) + '\n';
  writeFileSync(path.join(DATA_DIR, 'price.json'), priceJson);
  writeFileSync(path.join(DATA_DIR, 'weather.json'), weatherJson);

  const manifest = buildManifest({
    generatedAt,
    priceSha256: sha256Text(priceJson),
    priceBytes: Buffer.byteLength(priceJson),
    weatherSha256: sha256Text(weatherJson),
    weatherBytes: Buffer.byteLength(weatherJson),
    archives,
  });
  writeFileSync(path.join(DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `bundle written: price ${candles.length} candles (${warmupCandles.length} warm-up + ${evalCandles.length} eval), ` +
      `weather ${archive.daily.time.length} days + ${Object.keys(forecasts).length} forecasts.`,
  );
}

interface ManifestInput {
  generatedAt: string;
  priceSha256: string;
  priceBytes: number;
  weatherSha256: string;
  weatherBytes: number;
  archives: ArchiveFetch[];
}

function buildManifest(input: ManifestInput) {
  return {
    bundleVersion: 2,
    generatedAt: input.generatedAt,
    weatherLocation: LOCATION,
    evalPeriod: {
      start: EVAL_START,
      end: EVAL_END,
      priceRounds: 1440,
      weatherRounds: 60,
      priceWarmup: { days: 7, candles: 168 },
      weatherWarmup: { days: 365 },
    },
    seed: 42,
    initialCapitalNear: '100',
    stakeFloor: '0.10',
    minStakeNear: '0.1',
    queryFeeNear: '0.01',
    files: {
      'price.json': {
        sha256: input.priceSha256,
        bytes: input.priceBytes,
        description:
          'Binance Vision NEARUSDT 1h klines: 168 warm-up (2026-07-25..2026-07-31) + 1440 eval (2026-08-01..2026-09-29).',
      },
      'weather.json': {
        sha256: input.weatherSha256,
        bytes: input.weatherBytes,
        description:
          'Open-Meteo ECMWF IFS daily precipitation_sum (425 days: 365 warm-up + 60 eval) plus 60 Single-Runs forecast inputs.',
      },
    },
    sourceArchives: input.archives.map((a) => ({
      month: a.month,
      url: a.url,
      publishedSha256: a.publishedSha256,
      fetchedSha256: a.zipSha256,
      bytes: a.bytes,
      lastModified: a.lastModified,
      terms: 'CC BY-NC-SA 4.0 (non-commercial only)',
      termsUrl: BINANCE_VISION_TERMS,
    })),
    sources: [
      {
        id: 'binance-nearusdt-1h',
        domain: 'price',
        kind: 'outcome-and-input',
        instrument: 'NEARUSDT',
        interval: '1h',
        source: 'Binance Vision monthly kline archives',
        url: 'https://data.binance.vision/data/spot/monthly/klines/NEARUSDT/1h/',
        attribution: 'Binance',
        license: 'CC BY-NC-SA 4.0 (non-commercial only); attribution required. Educational non-commercial use only.',
        licenseUrl: BINANCE_VISION_TERMS,
        availability: 'retrospective',
        availableAt: null,
        evidence: {
          archiveLastModified: input.archives.map((a) => ({ month: a.month, lastModified: a.lastModified })),
          archiveSha256Verified: true,
          fetchedAt: input.generatedAt,
        },
        note: 'The monthly archive bundle is published after each month ends (Last-Modified ~1 week later) and fetched post-evaluation, so no per-candle publication/availability timestamp is recorded. Completed Binance kline values are immutable (Binance does not revise finalized candles), which prevents future-data leakage into the close>open outcome, but strict point-in-time availability of each candle at its cutoff is NOT proven; the whole price experiment is a labelled retrospective benchmark.',
      },
      {
        id: 'open-meteo-ifs-archive',
        domain: 'weather',
        kind: 'outcome',
        instrument: 'precipitation_sum (mm)',
        model: 'ecmwf_ifs',
        grid: `9 km (O1280); cell nearest lat=${LAT} lon=${LON} (${LOCATION})`,
        source: 'Open-Meteo Historical Weather API (Archive)',
        url: 'https://open-meteo.com/en/docs/historical-weather-api',
        attribution: 'Open-Meteo (Weather data by Open-Meteo.com), ECMWF IFS',
        license: 'CC BY 4.0 (data); Open-Meteo free tier non-commercial only',
        licenseUrl: 'https://open-meteo.com/en/licence',
        availability: 'retrospective',
        availableAt: null,
        note: 'Resolution truth is the pinned model/grid + captured response, not a station observation. IFS analysis can be revised after the fact, so a value fetched today for a past date is not proven to equal the value available at resolution time; the weather Outcome is a labelled retrospective benchmark.',
      },
      {
        id: 'open-meteo-ifs-climatology-history',
        domain: 'weather',
        kind: 'strategy-input (climatology)',
        model: 'ecmwf_ifs',
        source: 'Open-Meteo Historical Weather API (Archive)',
        availability: 'retrospective',
        availableAt: null,
        note: 'Reanalysis for a past day can be revised after the fact; today\u2019s value for a past date is not proven to equal the value available at the replay cutoff.',
      },
      {
        id: 'open-meteo-ifs-single-runs',
        domain: 'weather',
        kind: 'strategy-input (meteo)',
        model: 'ecmwf_ifs',
        source: 'Open-Meteo Single Runs API',
        url: 'https://open-meteo.com/en/docs/single-runs-api',
        attribution: 'Open-Meteo (Weather data by Open-Meteo.com), ECMWF IFS',
        license: 'CC BY 4.0 (data); Open-Meteo free tier non-commercial only',
        licenseUrl: 'https://open-meteo.com/en/licence',
        availability: 'inference',
        availableAt: null,
        run: 'IFS run initialised 00:00 UTC on D-1 (the day before each target WIB day), hourly precipitation summed over the target WIB day.',
        note: 'Run initialisation time precedes cutoff, but Open-Meteo does not record a per-run publication timestamp. Documented global-model latency is typically 4-6 hours (00 UTC run available ~04-06 UTC, before the 16:55 UTC cutoff), but that is an INFERENCE, not strict proof. Never the target day\u2019s realized precipitation.',
      },
    ],
    licensingSummary:
      'Binance Vision archive data is CC BY-NC-SA 4.0 (non-commercial, attribution required); Open-Meteo data is CC BY 4.0 with attribution, free tier non-commercial only. This is a non-commercial educational hackathon demo; no commercial data licence is implied.',
  };
}

void run();
