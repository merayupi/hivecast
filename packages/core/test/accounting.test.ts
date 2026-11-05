import test from 'node:test';
import assert from 'node:assert/strict';
import {
  settle,
  brierScore,
  SCORE_SCALE,
  ONE_NEAR,
  QUERY_FEE,
  MIN_STAKE,
} from '../src/accounting.js';
import { compareDecimalStrings, gteDec, scaleDecimal, formatScaled } from '../src/decimal.js';

// Independent worked examples from the spec's scoring section.

test('brierScore endpoints and exact match', () => {
  assert.equal(brierScore(0, 0), SCORE_SCALE);
  assert.equal(brierScore(10_000, 10_000), SCORE_SCALE);
  // 0 vs 10000 -> diff 10000 -> square = 1e8 = S -> score 0
  assert.equal(brierScore(0, 10_000), 0n);
  // 5000 vs 0 -> diff 5000 -> square 25_000_000
  assert.equal(brierScore(5000, 0), SCORE_SCALE - 25_000_000n);
});

test('two participants, equal stakes, both reveal: base pool conserved', () => {
  const W = 2n * ONE_NEAR;
  const outcome = 10_000;
  const s = settle(
    [
      { accountId: 'a', stake: ONE_NEAR, probabilityBps: 10_000, isValidRevealer: true },
      { accountId: 'b', stake: ONE_NEAR, probabilityBps: 0, isValidRevealer: true },
    ],
    outcome,
    QUERY_FEE,
  );
  assert.equal(s.totalStake, W);
  assert.equal(s.totalBasePayout, W);
  assert.equal(s.totalBasePayout + s.totalFeePayout + s.buyerFeeRefund, W + QUERY_FEE);
  // a scored S, b scored 0. A = w_a*S = S. W = 2, S = score scale.
  // base_a = w_a*(W*S + W*S - A)/(W*S) = 1*(2S+2S-S)/(2S) = 3S/2S = 1.5 NEAR
  // base_b = w_b*(W*S + W*0 - A)/(W*S) = 1*(2S-S)/(2S) = S/2S = 0.5 NEAR
  const rowA = s.rows.find((r) => r.accountId === 'a')!;
  const rowB = s.rows.find((r) => r.accountId === 'b')!;
  assert.equal(rowA.basePayout, (3n * ONE_NEAR) / 2n);
  assert.equal(rowB.basePayout, ONE_NEAR / 2n);
  // fee pool split by stake: 1/2 each
  assert.equal(rowA.feePayout, QUERY_FEE / 2n);
  assert.equal(rowB.feePayout, QUERY_FEE / 2n);
});

test('single participant: base stake returned, full fee pool', () => {
  const outcome = 0;
  const s = settle(
    [{ accountId: 'solo', stake: ONE_NEAR, probabilityBps: 0, isValidRevealer: true }],
    outcome,
    QUERY_FEE,
  );
  assert.equal(s.totalBasePayout, ONE_NEAR);
  assert.equal(s.totalFeePayout, QUERY_FEE);
  assert.equal(s.buyerFeeRefund, 0n);
});

test('no valid revealer: stakes returned, fee pool fully refunded', () => {
  const outcome = 0;
  const s = settle(
    [
      { accountId: 'a', stake: ONE_NEAR, probabilityBps: 7000, isValidRevealer: false },
      { accountId: 'b', stake: 2n * ONE_NEAR, probabilityBps: 3000, isValidRevealer: false },
    ],
    outcome,
    QUERY_FEE,
  );
  assert.equal(s.totalBasePayout, 3n * ONE_NEAR);
  assert.equal(s.totalFeePayout, 0n);
  assert.equal(s.buyerFeeRefund, QUERY_FEE);
});

test('valid revealer with score zero still receives fee share', () => {
  const outcome = 10_000;
  // p=0 vs outcome 10000 -> score 0, but a valid revealer.
  const s = settle(
    [
      { accountId: 'a', stake: ONE_NEAR, probabilityBps: 0, isValidRevealer: true },
      { accountId: 'b', stake: ONE_NEAR, probabilityBps: 10_000, isValidRevealer: true },
    ],
    outcome,
    QUERY_FEE,
  );
  const rowA = s.rows.find((r) => r.accountId === 'a')!;
  assert.equal(rowA.score, 0n);
  assert.equal(rowA.feePayout, QUERY_FEE / 2n);
});

test('remainder apportionment conserves every yocto (uneven stakes)', () => {
  // fee pot 3 yocto across stakes 1,1,1 -> remainder 0; use odd pot to force remainder.
  const feePool = 10n; // 10 yocto across 3 equal stakes -> floor 3 each = 9, remainder 1
  const s = settle(
    [
      { accountId: 'a', stake: 1n, probabilityBps: 5000, isValidRevealer: true },
      { accountId: 'b', stake: 1n, probabilityBps: 5000, isValidRevealer: true },
      { accountId: 'c', stake: 1n, probabilityBps: 5000, isValidRevealer: true },
    ],
    0,
    feePool,
  );
  assert.equal(s.totalFeePayout, feePool);
});

test('decimal comparison handles ties and sign correctly', () => {
  assert.equal(compareDecimalStrings('1.0', '1.000'), 0);
  assert.equal(compareDecimalStrings('0.10', '0.1'), 0);
  assert.equal(compareDecimalStrings('2.32100000', '2.30900000'), 1);
  assert.equal(compareDecimalStrings('-1.5', '0.5'), -1);
  assert.equal(gteDec('1.0', '1.0'), true);
  assert.equal(gteDec('0.9999', '1.0'), false);
});

test('scaleDecimal/formatScaled round-trip', () => {
  assert.equal(scaleDecimal('2.321', 8), 232_100_000n);
  assert.equal(scaleDecimal('0.00', 8), 0n);
  assert.equal(formatScaled(232_100_000n, 8), '2.321');
  assert.equal(formatScaled(0n, 8), '0');
  assert.equal(formatScaled(-500n, 8), '-0.000005');
});

test('MIN_STAKE and QUERY_FEE match spec defaults', () => {
  assert.equal(MIN_STAKE, ONE_NEAR / 10n); // 0.1 NEAR
  assert.equal(QUERY_FEE, ONE_NEAR / 100n); // 0.01 NEAR
});
