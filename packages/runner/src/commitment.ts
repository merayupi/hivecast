/**
 * Canonical, versioned commitment encoding (see contracts/hivecast/src/commitment.rs).
 *
 * The Commitment is `SHA-256(preimage)` where the preimage binds the forecast to
 * its exact context (domain, version, contract, question, account, stake,
 * probability, salt). The salt is a CSPRNG-generated UTF-8 string persisted by
 * the runner *before* the commit transaction is sent, and passed verbatim at
 * reveal time (the contract re-hashes `salt.as_bytes()`).
 */

import { createHash, randomBytes } from 'node:crypto';
import { commitmentPreimageBytes } from './borsh.js';

export const DOMAIN = 'hivecast';
export const VERSION = 1;
/** Salt is a 32-byte CSPRNG value hex-encoded into a 64-character ASCII string. */
export const SALT_BYTES = 32;
/** Contract cap on salt length (UTF-8 bytes). A 64-char hex salt fits easily. */
export const MAX_SALT_LEN = 128;

/** Generate a fresh salt: 32 CSPRNG bytes as a lowercase hex string. */
export function generateSalt(): string {
  return randomBytes(SALT_BYTES).toString('hex');
}

/**
 * Compute the commitment hash (lowercase 64-char hex) for a forecast.
 * `salt` is the UTF-8 salt string (its bytes are what is framed in the preimage).
 */
export function commitmentHash(params: {
  contractId: string;
  questionId: number | bigint;
  accountId: string;
  stakeYocto: bigint;
  probBps: number;
  salt: string;
}): string {
  const saltBytes = Buffer.from(params.salt, 'utf8');
  if (saltBytes.length > MAX_SALT_LEN) {
    throw new Error(`salt too long: ${saltBytes.length} bytes (max ${MAX_SALT_LEN})`);
  }
  const preimage = commitmentPreimageBytes({
    contractId: params.contractId,
    questionId: params.questionId,
    accountId: params.accountId,
    stakeYocto: params.stakeYocto,
    probBps: params.probBps,
    salt: saltBytes,
  });
  const digest = createHash('sha256').update(Buffer.from(preimage)).digest('hex');
  return digest;
}
