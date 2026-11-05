/**
 * Exact formatting. Money is yoctoNEAR decimal strings (never `number`);
 * timestamps are UTC nanosecond decimal strings. Only display strings are
 * produced here; the data never becomes a float.
 */

import type { Domain } from './types';

const ONE_NEAR = 10n ** 24n;
const NS_PER_MS = 1_000_000n;
const BPS_PER_UNIT = 10_000;

/** Format yoctoNEAR as a NEAR decimal with 6 fractional digits (truncated). */
export function near(yocto: string, decimals = 6): string {
  const v = BigInt(yocto);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / ONE_NEAR;
  const frac = abs % ONE_NEAR;
  const scale = 10n ** BigInt(decimals);
  const fracScaled = (frac * scale) / ONE_NEAR;
  const body = decimals === 0 ? whole.toString() : `${whole}.${fracScaled.toString().padStart(decimals, '0')}`.replace(/0+$/, '').replace(/\.$/, '');
  return `${neg ? '-' : ''}${body}`;
}

/** Format a probability in bps as a percentage string (e.g. 5432 -> 54.32%). */
export function pct(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = (bps % 100).toString().padStart(2, '0');
  return `${whole}.${frac}%`;
}

/** Format a Brier error in [0,1] as a percentage with 1 decimal (lower better). */
export function brier(b: number | null): string {
  if (b === null) return '—';
  return `${(b * 100).toFixed(1)}%`;
}

/** UTC nanoseconds decimal string -> Date. */
export function nsDate(ns: string): Date {
  return new Date(Number(BigInt(ns) / NS_PER_MS));
}

/** Human date-time in a specific IANA timezone (price=UTC, weather=WIB). */
export function fmtDateTimeTz(ns: string, timeZone: 'UTC' | 'Asia/Jakarta'): string {
  return nsDate(ns).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
    timeZoneName: 'short',
  });
}

/** The event's declared timezone for a domain. */
export function domainTimeZone(domain: Domain): 'UTC' | 'Asia/Jakarta' {
  return domain === 'price' ? 'UTC' : 'Asia/Jakarta';
}

/**
 * Parse the on-chain `source` JSON into a stable domain. The contract stores
 * `{"kind":"price"|"weather", …}`; fall back to string matching on the raw
 * source only if the JSON is unparseable.
 */
export function questionDomain(source: string): Domain {
  try {
    const parsed = JSON.parse(source) as { kind?: string };
    if (parsed.kind === 'weather') return 'weather';
    if (parsed.kind === 'price') return 'price';
  } catch {
    // fall through
  }
  return source.startsWith('binance') || source.includes('NEARUSDT') ? 'price' : 'weather';
}

/** A clean human label for the on-chain source JSON (never the raw blob). */
export function sourceLabel(source: string): string {
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    if (typeof parsed.kind === 'string' && parsed.kind === 'price') {
      return `Binance spot ${String(parsed.instrument ?? 'NEARUSDT')} ${String(parsed.interval ?? '1h')} — ${String(parsed.outcome ?? 'close > open (ties/lower = NO)')}`;
    }
    if (typeof parsed.kind === 'string' && parsed.kind === 'weather') {
      const model = String(parsed.model ?? 'ecmwf_ifs');
      const lat = String(parsed.latitude ?? '-6.8049');
      const lon = String(parsed.longitude ?? '110.8397');
      return `Open-Meteo ${model} precipitation_sum at ${lat},${lon} (grid model, not a station)`;
    }
  } catch {
    // raw string
  }
  return source;
}

/** Countdown to a UTC-ns deadline (wall clock). */
export interface Countdown {
  totalMs: number;
  label: string;
}

export function countdown(ns: string, nowMs: number = Date.now()): Countdown {
  const targetMs = Number(BigInt(ns) / NS_PER_MS);
  const totalMs = targetMs - nowMs;
  const abs = Math.abs(totalMs);
  const sign = totalMs < 0 ? '-' : '';
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.floor((abs % 3_600_000) / 60_000);
  const secs = Math.floor((abs % 60_000) / 1000);
  let label: string;
  if (days > 0) label = `${sign}${days}d ${hours}h`;
  else if (hours > 0) label = `${sign}${hours}h ${mins}m`;
  else if (mins > 0) label = `${sign}${mins}m ${secs}s`;
  else label = `${sign}${secs}s`;
  return { totalMs, label };
}

/** Domain label for the two experiments. */
export function domainLabel(domain: Domain): string {
  return domain === 'price' ? 'Price · Binance NEARUSDT 1h' : 'Weather · Kudus IFS 9km';
}

/** Shorten an account id for tight columns; full id stays in a title/attr. */
export function shortId(accountId: string, max = 24): string {
  if (accountId.length <= max) return accountId;
  return `${accountId.slice(0, max - 1)}…`;
}

/** The transaction explorer URL for a tx hash on the configured network. */
export function explorerTxUrl(networkId: string, txHash: string): string {
  const base = networkId === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
  return `${base}/txns/${txHash}`;
}

/** The account explorer URL. */
export function explorerAccountUrl(networkId: string, accountId: string): string {
  const base = networkId === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
  return `${base}/address/${accountId}`;
}
