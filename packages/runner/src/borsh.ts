/**
 * Minimal Borsh 1.x writer for the canonical commitment preimage.
 *
 * Only the primitives required by the wire contract are implemented:
 *   - u32 / u64 / u128  — fixed-width little-endian integers
 *   - String           — u32 LE byte-length prefix + UTF-8 bytes
 *   - Vec<u8> (bytes)  — u32 LE byte-length prefix + raw bytes
 *
 * This matches the layout documented in `contracts/hivecast/src/commitment.rs`
 * and is byte-identical to the `borsh` npm package's `serialize` output for the
 * same struct (asserted in the test suite).
 */

export type U32 = number;
export type U64 = number | bigint;
export type U128 = bigint;

/** Append a fixed-width unsigned little-endian integer. */
export function writeU32(out: number[], value: U32): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`writeU32: value out of range: ${value}`);
  }
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/** Append a u64 little-endian integer. */
export function writeU64(out: number[], value: U64): void {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new Error(`writeU64: value out of range: ${v}`);
  }
  for (let i = 0; i < 8; i++) {
    out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  }
}

/** Append a u128 little-endian integer (16 bytes). */
export function writeU128(out: number[], value: U128): void {
  if (value < 0n || value > 0xffffffffffffffffffffffffffffffffn) {
    throw new Error(`writeU128: value out of range: ${value}`);
  }
  for (let i = 0; i < 16; i++) {
    out.push(Number((value >> BigInt(8 * i)) & 0xffn));
  }
}

/** UTF-8 encode a string to byte values. */
export function utf8Bytes(s: string): number[] {
  const buf = Buffer.from(s, 'utf8');
  return Array.from(buf);
}

/** Append a length-framed UTF-8 string (u32 LE byte length + bytes). */
export function writeString(out: number[], value: string): void {
  const bytes = utf8Bytes(value);
  writeU32(out, bytes.length);
  out.push(...bytes);
}

/** Append a length-framed byte vector (u32 LE byte length + raw bytes). */
export function writeBytes(out: number[], value: Uint8Array | number[]): void {
  writeU32(out, value.length);
  out.push(...value);
}

/** Build the canonical commitment preimage as a byte array. */
export function commitmentPreimageBytes(params: {
  contractId: string;
  questionId: U64;
  accountId: string;
  stakeYocto: U128;
  probBps: U32;
  salt: Uint8Array;
}): number[] {
  const out: number[] = [];
  writeString(out, 'hivecast'); // domain
  writeU32(out, 1); // version
  writeString(out, params.contractId);
  writeU64(out, params.questionId);
  writeString(out, params.accountId);
  writeU128(out, params.stakeYocto);
  writeU32(out, params.probBps);
  writeBytes(out, params.salt);
  return out;
}
