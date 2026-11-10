/**
 * RPC failover: one object that answers like the primary RPC provider but moves
 * to the next endpoint when the current one is unavailable (rate limit, 5xx,
 * network error, timeout).
 *
 * Only availability failures fail over. A definitive answer from the chain
 * (stale nonce, expired transaction, unknown transaction, missing account …)
 * is rethrown untouched, because the runner branches on those exact errors.
 *
 * Re-sending the same signed transaction to another endpoint is safe: a NEAR
 * transaction is identified by its hash, so a second submission cannot execute
 * it twice.
 */

import { TypedError } from 'near-api-js';
import { InternalHandlerError, InternalRpcError, RpcError, RpcMethodNotFoundError } from 'near-api-js/rpc-errors';

const NETWORK_MESSAGE =
  /rate limit|too many requests|\b429\b|fetch failed|failed to fetch|FetchError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|bad gateway|unavailable|timed out/i;

/**
 * True when `err` says the endpoint could not serve the request, as opposed to
 * the chain answering it. Unknown error shapes are NOT treated as transport
 * failures, so they surface exactly as before.
 */
export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // The node itself failed while handling the request, or does not offer the method.
  if (err instanceof InternalRpcError || err instanceof InternalHandlerError || err instanceof RpcMethodNotFoundError) return true;
  // Any other typed RPC error is the chain's answer, unless it is a rate limit
  // reported inside a JSON-RPC error body.
  if (err instanceof RpcError) return /rate limit|too many requests|\b429\b/i.test(err.message);
  // near-api-js: every retry on this endpoint was used up.
  if (err instanceof TypedError && err.type === 'RetriesExceeded') return true;
  // near-api-js ProviderError: an HTTP 429 / 5xx / 408 answer, status in `cause`.
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === 'number' && [408, 429, 500, 502, 503, 504].includes(cause)) return true;
  // fetch() rejected (DNS, reset, refused) or the body was not JSON (an HTML error page).
  if (err instanceof TypeError || err instanceof SyntaxError) return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  return NETWORK_MESSAGE.test(err.message);
}

export interface FailoverOptions {
  /** Which errors move on to the next target. Default: {@link isTransportError}. */
  isTransport?: (err: unknown) => boolean;
  /** After this long on a fallback, try the primary first again. Default 5 min. */
  retryPrimaryAfterMs?: number;
  now?: () => number;
  /** Called when the active target changes (`err` is null when returning to the primary). */
  onSwitch?: (from: number, to: number, err: unknown) => void;
}

/**
 * A stand-in for `targets[0]` whose async methods fall through `targets` in
 * order on a transport failure. The target that last answered stays active
 * ("sticky"), so a rate-limited primary is not hit again on every call.
 * Non-function properties are read from the active target.
 */
export function failover<T extends object>(targets: readonly T[], options: FailoverOptions = {}): T {
  if (targets.length === 0) throw new Error('failover needs at least one target');
  const isTransport = options.isTransport ?? isTransportError;
  const retryPrimaryAfterMs = options.retryPrimaryAfterMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  let active = 0;
  let switchedAt = 0;

  const activate = (index: number, err: unknown) => {
    if (index === active) return;
    const from = active;
    active = index;
    switchedAt = now();
    options.onSwitch?.(from, index, err);
  };

  return new Proxy(targets[0]!, {
    get(_first, prop) {
      if (typeof Reflect.get(targets[0]!, prop) !== 'function') return Reflect.get(targets[active]!, prop);
      return (...args: unknown[]) => {
        // Give the primary another chance once the fallback has served for a while.
        const start = active !== 0 && now() - switchedAt >= retryPrimaryAfterMs ? 0 : active;
        const attempt = (offset: number, lastErr: unknown): unknown => {
          const index = (start + offset) % targets.length;
          const target = targets[index]!;
          const out = (Reflect.get(target, prop) as (...a: unknown[]) => unknown).apply(target, args);
          if (!(out instanceof Promise)) return out;
          return out.then(
            (value) => {
              activate(index, lastErr);
              return value;
            },
            (err: unknown) => {
              const transport = isTransport(err);
              // The primary was retried and is still down: stay on the fallback for another interval.
              if (transport && index === 0 && active !== 0) switchedAt = now();
              if (offset + 1 < targets.length && transport) return attempt(offset + 1, err);
              throw err;
            },
          );
        };
        return attempt(0, null);
      };
    },
  });
}

/** Host of an RPC URL, for logs and error messages: never the path or query, which may hold an API key. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-rpc-url';
  }
}
