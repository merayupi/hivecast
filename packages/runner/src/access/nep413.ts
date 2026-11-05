/**
 * Canonical NEP-413 signed-payload reconstruction + Ed25519 verification.
 *
 * The signed bytes are exactly:
 *   SHA-256( Borsh.u32(2147484061) ++ Borsh(Payload) )
 * where Payload = { message: string, nonce: [u8;32], recipient: string,
 * callbackUrl: Option<string> }.
 *
 * The supported browser wallets (Meteor/Intear via @hot-labs/near-connect
 * 0.12.0) sign with `callbackUrl = None` — a single `0x00` option byte. The
 * server reconstructs this exact payload from its own durable challenge state
 * and configuration, so a signature copied from another service/network/
 * contract/recipient cannot verify here.
 */

import { createHash } from 'node:crypto';
import { PublicKey } from 'near-api-js';

export const NEP413_PREFIX = 2147484061; // 2**31 + 413
export const NEP413_NONCE_BYTES = 32;

function writeU32(out: number[], value: number): void {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function writeString(out: number[], value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  writeU32(out, bytes.length);
  out.push(...bytes);
}

/** Compute the canonical NEP-413 digest for the given payload fields. */
export function nep413Digest(params: { message: string; nonce: Uint8Array; recipient: string }): Uint8Array {
  if (params.nonce.length !== NEP413_NONCE_BYTES) {
    throw new Error(`nonce must be exactly ${NEP413_NONCE_BYTES} bytes`);
  }
  const out: number[] = [];
  writeU32(out, NEP413_PREFIX);
  writeString(out, params.message);
  out.push(...params.nonce); // fixed [u8;32], no length prefix
  writeString(out, params.recipient);
  out.push(0x00); // callbackUrl: Option<string> = None
  return new Uint8Array(createHash('sha256').update(Buffer.from(out)).digest());
}

/**
 * Verify an Ed25519 NEP-413 signature against the canonical digest.
 * `signature` is the raw 64-byte signature (base64-decoded from the wallet).
 */
export function verifyNep413Signature(params: {
  publicKey: string;
  message: string;
  nonce: Uint8Array;
  recipient: string;
  signature: Uint8Array;
}): boolean {
  const pk = PublicKey.from(params.publicKey);
  return pk.verify(
    nep413Digest({ message: params.message, nonce: params.nonce, recipient: params.recipient }),
    params.signature,
  );
}

/** Hex-encode/decoded helpers shared by the challenge store. */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`invalid hex string: ${hex}`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
