/**
 * Forecast Access DTOs + error contract (ticket #5 → #6 API handoff).
 *
 * Monetary amounts and on-chain timestamps remain decimal strings; the only
 * numbers are challenge/session identity and TTL bookkeeping at the HTTP edge.
 */

import type { Domain } from '@hivecast/core';

/** A one-use NEP-413 challenge the browser wallet must sign. */
export interface ChallengeDto {
  /** Stable identity for /auth/verify (nonce hex). */
  challenge_id: string;
  /** 32-byte nonce, base64 — the frontend decodes to Uint8Array for the wallet. */
  nonce: string;
  /** Exact message string the wallet signs (binds account/network/contract/domain/expiry). */
  message: string;
  /** Exact NEP-413 recipient (the service identity). */
  recipient: string;
  account_id: string;
  network_id: string;
  contract_id: string;
  /** ISO 8601 UTC wall-clock deadline. */
  expires_at: string;
}

/** Successful /auth/verify result (session id is delivered as an HttpOnly cookie). */
export interface SessionDto {
  account_id: string;
  network_id: string;
  contract_id: string;
  /** ISO 8601 UTC session expiry. */
  expires_at: string;
}

/**
 * The exact frozen Forecast Snapshot a buyer retrieves (never per-agent
 * probabilities, salts, or keys). Public question context comes from the
 * finalized chain view; the aggregate/identity comes from the frozen snapshot.
 */
export interface ForecastDeliveryDto {
  question_id: number;
  snapshot_id: string;
  aggregate_bps: number;
  total_stake_yocto: string;
  participant_count: number;
  /** true when participant_count === 1 (Single-agent Forecast). */
  single_agent: boolean;
  domain: Domain;
  text: string;
  event_definition: string;
  source: string;
  source_label: string;
  observation_start: string;
  observation_end: string;
  access_price: string;
}

export type AccessErrorCode =
  | 'invalid_request'
  | 'challenge_not_found'
  | 'challenge_expired'
  | 'challenge_consumed'
  | 'account_mismatch'
  | 'invalid_signature'
  | 'not_full_access'
  | 'unauthenticated'
  | 'not_purchased'
  | 'snapshot_unavailable';

/** A fail-closed access error with a stable machine code + HTTP status. */
export class AccessError extends Error {
  readonly code: AccessErrorCode;
  readonly status: number;

  constructor(code: AccessErrorCode, status: number, message: string) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
    this.status = status;
  }
}

export const ACCESS_HTTP_STATUS: Record<AccessErrorCode, number> = {
  invalid_request: 400,
  challenge_not_found: 401,
  challenge_expired: 401,
  challenge_consumed: 401,
  account_mismatch: 401,
  invalid_signature: 401,
  not_full_access: 401,
  unauthenticated: 401,
  not_purchased: 403,
  snapshot_unavailable: 503,
};
