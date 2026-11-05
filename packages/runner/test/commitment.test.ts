/**
 * Commitment encoding tests — byte-exactness against the canonical wire layout.
 *
 * The expected values below are independent literals produced from the `borsh`
 * npm package (a spec-compliant reference implementation) for the struct layout
 * documented in contracts/hivecast/src/commitment.rs, not recomputed by this
 * module's own encoder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  writeU32,
  writeU64,
  writeU128,
  writeString,
  writeBytes,
  commitmentPreimageBytes,
} from '../src/borsh.js';
import { commitmentHash, generateSalt, MAX_SALT_LEN } from '../src/commitment.js';

test('u32/u64/u128 write little-endian fixed widths', () => {
  const u32: number[] = [];
  writeU32(u32, 0x01020304);
  assert.deepEqual(Buffer.from(u32).toString('hex'), '04030201');

  const u64: number[] = [];
  writeU64(u64, 7n);
  assert.deepEqual(Buffer.from(u64).toString('hex'), '0700000000000000');

  const u128: number[] = [];
  writeU128(u128, 100000000000000000000000n); // 0.1 NEAR
  assert.deepEqual(Buffer.from(u128).toString('hex'), '000080f64ae1c7022d15000000000000');
});

test('string and byte vector are u32-length-framed', () => {
  const s: number[] = [];
  writeString(s, 'hivecast');
  assert.deepEqual(Buffer.from(s).toString('hex'), '080000006869766563617374');

  const b: number[] = [];
  writeBytes(b, Uint8Array.from([1, 2, 3]));
  assert.deepEqual(Buffer.from(b).toString('hex'), '03000000010203');
});

test('commitment preimage is byte-identical to the canonical layout', () => {
  const preimage = commitmentPreimageBytes({
    contractId: 'hivecast.testnet',
    questionId: 7n,
    accountId: 'agent.testnet',
    stakeYocto: 100000000000000000000000n,
    probBps: 5000,
    salt: Buffer.from('deadbeefcafe', 'utf8'),
  });
  const hex = Buffer.from(preimage).toString('hex');
  assert.equal(
    hex,
    '080000006869766563617374' + // domain "hivecast"
      '01000000' + // version 1
      '1000000068697665636173742e746573746e6574' + // contract_id "hivecast.testnet"
      '0700000000000000' + // question_id 7
      '0d0000006167656e742e746573746e6574' + // account_id "agent.testnet"
      '000080f64ae1c7022d15000000000000' + // stake 0.1 NEAR
      '88130000' + // prob_bps 5000
      '0c000000646561646265656663616665', // salt "deadbeefcafe"
  );
});

test('commitment hash matches the reference SHA-256', () => {
  const preimageHex =
    '080000006869766563617374010000001000000068697665636173742e746573746e65740700000000000000' +
    '0d0000006167656e742e746573746e6574000080f64ae1c7022d1500000000000088130000' +
    '0c000000646561646265656663616665';
  const expected = createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');

  const got = commitmentHash({
    contractId: 'hivecast.testnet',
    questionId: 7,
    accountId: 'agent.testnet',
    stakeYocto: 100000000000000000000000n,
    probBps: 5000,
    salt: 'deadbeefcafe',
  });
  assert.equal(got, expected);
  assert.equal(got.length, 64);
});

test('salt generation is CSPRNG, hex, and within the contract length cap', () => {
  const a = generateSalt();
  const b = generateSalt();
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.ok(Buffer.byteLength(a, 'utf8') <= MAX_SALT_LEN);
});

test('commitment hash rejects an over-length salt', () => {
  const longSalt = 'a'.repeat(MAX_SALT_LEN + 1);
  assert.throws(
    () =>
      commitmentHash({
        contractId: 'c.testnet',
        questionId: 1,
        accountId: 'a.testnet',
        stakeYocto: 1n,
        probBps: 0,
        salt: longSalt,
      }),
    /salt too long/,
  );
});
