/**
 * Forecast Access authentication + delivery (ticket #5).
 *
 * Ownership is proven with a one-use, expiring NEP-413 challenge bound to the
 * account, service domain, network, contract, challenge identity, and expiry.
 * The FullAccess key and the purchase entitlement are both checked against
 * finalized RPC state. A public account id or transaction hash is never proof.
 *
 * Delivery serves the exact frozen Forecast Snapshot only after an
 * authenticated session AND a finalized `has_bought(questionId, accountId)`.
 * Lost private DB/snapshot/RPC failures are honest `snapshot_unavailable`
 * (503) — never fabricated data, never an automatic delivery refund.
 */

import { randomBytes } from 'node:crypto';
import type { ChainClient } from '../chain/types.js';
import type { RunnerConfig } from '../config.js';
import type { Store } from '../store.js';
import type { LocalQuestion, QuestionView } from '../types.js';
import { bytesToHex, hexToBytes, verifyNep413Signature } from './nep413.js';
import { AccessError, type ChallengeDto, type ForecastDeliveryDto, type SessionDto } from './types.js';

export interface AccessClock {
  nowMs(): number;
}

export interface VerifyChallengeInput {
  challengeId: string;
  accountId: string;
  publicKey: string;
  /** base64 NEP-413 signature (raw 64-byte Ed25519 encoded by the wallet). */
  signature: string;
}

/** Operator trust disclosure (public, static product text). */
export const TRUST_DISCLOSURE = {
  operator_powers: [
    'knows every private forecast before reveal',
    'records the final Outcome through the pinned resolver',
    'serves forecast delivery and holds the testnet full-access deploy key',
  ],
  delivery_limits: [
    'forecast access is earlier information, not exclusivity or permanent secrecy',
    'sales stop at observation start; buyers may redistribute what they receive',
    'there is no automatic endpoint-failure refund; automatic refunds cover Cancellation and zero Valid Revealer only',
    'a lost private snapshot or RPC failure returns unavailable, never fabricated data',
  ],
  claim_withdrawal: [
    'claim and withdraw remain buyer wallet signed contract calls; the service never impersonates a buyer',
  ],
};

export class AccessAuth {
  private readonly config: RunnerConfig;
  private readonly chain: ChainClient;
  private readonly store: Store;
  private readonly clock: AccessClock;

  constructor(config: RunnerConfig, chain: ChainClient, store: Store, clock: AccessClock = { nowMs: () => Date.now() }) {
    this.config = config;
    this.chain = chain;
    this.store = store;
    this.clock = clock;
  }

  getDisclosure(): typeof TRUST_DISCLOSURE {
    return TRUST_DISCLOSURE;
  }

  private buildMessage(accountId: string, challengeId: string, expiresAtMs: number): string {
    const iso = new Date(expiresAtMs).toISOString();
    return (
      `hivecast sign-in for ${accountId} on ${this.config.networkId} ` +
      `(contract ${this.config.contractId}, service ${this.config.access.serviceDomain}) ` +
      `challenge ${challengeId} expires ${iso}`
    );
  }

  /** Mint a one-use, expiring challenge for the asserted account. */
  mintChallenge(accountId: string): ChallengeDto {
    const trimmed = accountId.trim();
    if (!trimmed || trimmed.length > 64) {
      throw new AccessError('invalid_request', 400, 'account_id must be a non-empty account id');
    }
    const nonce = randomBytes(32);
    const challengeId = bytesToHex(nonce);
    const expiresAtMs = this.clock.nowMs() + this.config.access.challengeTtlMs;
    this.store.saveAccessChallenge({
      challengeId,
      nonceHex: challengeId,
      accountId: trimmed,
      networkId: this.config.networkId,
      contractId: this.config.contractId,
      serviceDomain: this.config.access.serviceDomain,
      expiresAtMs,
      createdAtMs: this.clock.nowMs(),
    });
    return {
      challenge_id: challengeId,
      nonce: Buffer.from(nonce).toString('base64'),
      message: this.buildMessage(trimmed, challengeId, expiresAtMs),
      recipient: this.config.operatorId,
      account_id: trimmed,
      network_id: this.config.networkId,
      contract_id: this.config.contractId,
      expires_at: new Date(expiresAtMs).toISOString(),
    };
  }

  /**
   * Verify a signed challenge and issue a session. Returns the session id
   * (for the HttpOnly cookie) and the owner-safe session DTO.
   */
  async verifyChallenge(input: VerifyChallengeInput): Promise<{ sessionId: string; dto: SessionDto }> {
    const now = this.clock.nowMs();
    const row = this.store.getAccessChallenge(input.challengeId);
    if (!row) throw new AccessError('challenge_not_found', 401, 'unknown or replayed challenge');
    if (row.consumedAtMs !== null) throw new AccessError('challenge_consumed', 401, 'challenge already used');
    if (row.expiresAtMs <= now) throw new AccessError('challenge_expired', 401, 'challenge expired');
    if (row.accountId !== input.accountId) {
      throw new AccessError('account_mismatch', 401, 'challenge belongs to a different account');
    }
    if (
      row.networkId !== this.config.networkId ||
      row.contractId !== this.config.contractId ||
      row.serviceDomain !== this.config.access.serviceDomain
    ) {
      throw new AccessError('account_mismatch', 401, 'challenge context does not match this service');
    }

    // Reconstruct the exact signed bytes from durable state + config (never
    // from the client), so a copied proof for another domain/recipient/
    // network/contract cannot verify here.
    const message = this.buildMessage(row.accountId, row.challengeId, row.expiresAtMs);
    const nonce = hexToBytes(row.nonceHex);
    let signature: Uint8Array;
    try {
      signature = new Uint8Array(Buffer.from(input.signature, 'base64'));
    } catch {
      throw new AccessError('invalid_signature', 401, 'malformed signature');
    }
    if (signature.length !== 64) {
      throw new AccessError('invalid_signature', 401, 'malformed signature length');
    }
    const valid = verifyNep413Signature({
      publicKey: input.publicKey,
      message,
      nonce,
      recipient: this.config.operatorId,
      signature,
    });
    if (!valid) throw new AccessError('invalid_signature', 401, 'signature verification failed');

    // The signing key must currently be a FullAccess key of the asserted
    // account on the configured network, on finalized state.
    const permission = await this.chain.viewAccessKeyPermission(input.accountId, input.publicKey);
    if (permission !== 'full-access') {
      throw new AccessError('not_full_access', 401, 'public key is not a finalized FullAccess key of the account');
    }

    // Atomic single-use consumption; concurrent verifiers race here and only
    // one wins. Expiry is part of the conditional so it is race-safe too.
    if (!this.store.consumeAccessChallenge(row.challengeId, now)) {
      throw new AccessError('challenge_consumed', 401, 'challenge already used');
    }

    const sessionId = randomBytes(32).toString('hex');
    const expiresAtMs = now + this.config.access.sessionTtlMs;
    this.store.saveAccessSession({
      sessionId,
      accountId: row.accountId,
      networkId: this.config.networkId,
      contractId: this.config.contractId,
      createdAtMs: now,
      expiresAtMs,
    });
    return {
      sessionId,
      dto: {
        account_id: row.accountId,
        network_id: this.config.networkId,
        contract_id: this.config.contractId,
        expires_at: new Date(expiresAtMs).toISOString(),
      },
    };
  }

  /** Resolve a session id to its owner account (fail-closed). */
  resolveSession(sessionId: string): string {
    const session = this.store.getAccessSession(sessionId);
    if (!session || session.expiresAtMs <= this.clock.nowMs()) {
      throw new AccessError('unauthenticated', 401, 'no valid session');
    }
    if (session.networkId !== this.config.networkId || session.contractId !== this.config.contractId) {
      throw new AccessError('unauthenticated', 401, 'session context does not match this service');
    }
    return session.accountId;
  }

  /**
   * Deliver the exact frozen Forecast Snapshot to an authenticated buyer.
   * Requires a valid session AND a finalized `has_bought` on the pinned
   * contract/network; the frozen snapshot identity must equal the finalized
   * on-chain `snapshot_id`.
   */
  async deliverForecast(questionId: number, sessionId: string): Promise<ForecastDeliveryDto> {
    const accountId = this.resolveSession(sessionId);

    let bought: boolean;
    try {
      bought = await this.chain.hasBought(questionId, accountId);
    } catch {
      throw new AccessError('snapshot_unavailable', 503, 'purchase entitlement view unavailable');
    }
    if (!bought) throw new AccessError('not_purchased', 403, 'account has not purchased this forecast');

    let view: QuestionView | null;
    try {
      view = await this.chain.getQuestion(questionId);
    } catch {
      throw new AccessError('snapshot_unavailable', 503, 'question view unavailable');
    }
    if (!view || !view.snapshot_ready || !view.snapshot_id) {
      throw new AccessError('snapshot_unavailable', 503, 'forecast snapshot not ready');
    }

    const snapshot = this.store.getSnapshot(questionId);
    if (!snapshot) throw new AccessError('snapshot_unavailable', 503, 'forecast snapshot unavailable');
    if (snapshot.snapshotId !== view.snapshot_id) {
      throw new AccessError('snapshot_unavailable', 503, 'forecast snapshot identity mismatch');
    }

    const local: LocalQuestion | null = this.store.getQuestion(questionId);
    if (!local) throw new AccessError('snapshot_unavailable', 503, 'forecast context unavailable');

    return {
      question_id: questionId,
      snapshot_id: snapshot.snapshotId,
      aggregate_bps: snapshot.aggregateBps,
      total_stake_yocto: snapshot.totalStakeYocto.toString(),
      participant_count: snapshot.participantCount,
      single_agent: snapshot.participantCount === 1,
      domain: local.domain,
      text: view.text,
      event_definition: view.event_definition,
      source: view.source,
      source_label: local.sourceLabel,
      observation_start: view.observation_start,
      observation_end: view.observation_end,
      access_price: view.access_price,
    };
  }
}
