/**
 * Exact wagering accounting in yoctoNEAR.
 *
 * All monetary values are `bigint` yoctoNEAR (1 NEAR = 10^24 yoctoNEAR).
 * Probability is in bps (0..=10000) and outcomes are 0 or 10000 bps.
 *
 * Formulas mirror the spec (§ Scoring, fees, rounding):
 *   S = 100_000_000 (score scale)
 *   s_i = S - (p_i - o)^2          for a valid Revealer, else 0
 *   W   = sum of all accepted stakes
 *   A   = sum(w_i * s_i)
 *   base_i = w_i * (W*S + W*s_i - A) / (W*S)   (exact, then apportioned)
 *   fee_i  = F * w_i / V           for valid Revealers (V = their total stake)
 *
 * Each pool is floored per share and the remainder yoctoNEAR is distributed to
 * the largest fractional remainders, ties broken by account id ascending, so
 * every pool is conserved to the last yocto.
 */

export const SCORE_SCALE = 100_000_000n; // S
export const ONE_NEAR = 10n ** 24n;
/** Default minimum Stake: 0.1 NEAR. */
export const MIN_STAKE = ONE_NEAR / 10n;
/** Default Query Fee: 0.01 NEAR per Question. */
export const QUERY_FEE = ONE_NEAR / 100n;

export interface Participant {
  accountId: string;
  /** Accepted Stake in yoctoNEAR. */
  stake: bigint;
  /** Forecast probability in bps (0..=10000). */
  probabilityBps: number;
  /** Whether this participant produced a valid Reveal. */
  isValidRevealer: boolean;
}

export interface PayoutRow {
  accountId: string;
  stake: bigint;
  score: bigint;
  isValidRevealer: boolean;
  basePayout: bigint;
  feePayout: bigint;
}

export interface Settlement {
  rows: PayoutRow[];
  totalStake: bigint;
  totalBasePayout: bigint;
  totalFeePayout: bigint;
  buyerFeeRefund: bigint;
  validRevealerStake: bigint;
}

/**
 * Brier score for a valid Revealer: S - (p - o)^2. Range [0, S].
 * A non-Revealer's score is 0 (handled by the caller).
 */
export function brierScore(probabilityBps: number, outcomeBps: number): bigint {
  const p = BigInt(probabilityBps);
  const o = BigInt(outcomeBps);
  const diff = p - o; // in [-10000, 10000]
  const diffSq = diff * diff; // <= 10^8 = S
  return SCORE_SCALE - diffSq;
}

interface ShareRow {
  accountId: string;
  num: bigint;
  denom: bigint;
}

/**
 * Apportion `total` yocto across rows where row i's exact share is
 * num_i / denom_i and the exact shares sum to `total`. Floors each share, then
 * distributes the remaining units to the largest fractional remainders, ties
 * broken by account id ascending. Guarantees the result sums to `total`.
 */
export function apportion(rows: readonly ShareRow[], total: bigint): Map<string, bigint> {
  const floors = rows.map((r) => ({
    accountId: r.accountId,
    floor: r.num / r.denom,
    frac: r.num % r.denom,
    denom: r.denom,
  }));
  let allocated = 0n;
  for (const f of floors) allocated += f.floor;
  let remainder = total - allocated;
  if (remainder < 0n) throw new Error('apportion: exact shares sum below total');

  floors.sort((a, b) => {
    if (a.frac !== b.frac) return a.frac > b.frac ? -1 : 1;
    if (a.accountId === b.accountId) return 0;
    return a.accountId < b.accountId ? -1 : 1;
  });

  const result = new Map<string, bigint>();
  for (const f of floors) result.set(f.accountId, f.floor);

  let rem = Number(remainder); // remainder < number of rows (<= 64)
  for (let i = 0; i < rem; i++) {
    const f = floors[i];
    if (!f) break;
    result.set(f.accountId, (result.get(f.accountId) ?? 0n) + 1n);
  }
  return result;
}

/**
 * Compute the full Settlement for one Round.
 *
 * `feePool` is the Query Fee pot for the Round. When there are no valid
 * Revealers, the entire fee pot becomes a buyer refund and the base pool still
 * returns original stakes (all scores are zero, so each participant receives
 * exactly their stake back).
 */
export function settle(
  participants: readonly Participant[],
  outcomeBps: number,
  feePool: bigint,
): Settlement {
  const W = participants.reduce((s, p) => s + p.stake, 0n);
  if (W === 0n) {
    return {
      rows: [],
      totalStake: 0n,
      totalBasePayout: 0n,
      totalFeePayout: 0n,
      buyerFeeRefund: feePool,
      validRevealerStake: 0n,
    };
  }

  const scored = participants.map((p) => ({
    accountId: p.accountId,
    stake: p.stake,
    isValidRevealer: p.isValidRevealer,
    score: p.isValidRevealer ? brierScore(p.probabilityBps, outcomeBps) : 0n,
  }));

  const A = scored.reduce((s, p) => s + p.stake * p.score, 0n);
  const denom = W * SCORE_SCALE; // W*S

  const baseRows: ShareRow[] = scored.map((p) => ({
    accountId: p.accountId,
    num: p.stake * (W * SCORE_SCALE + W * p.score - A),
    denom,
  }));
  const basePayouts = apportion(baseRows, W);

  const revealers = scored.filter((p) => p.isValidRevealer);
  const V = revealers.reduce((s, p) => s + p.stake, 0n);

  let feePayouts = new Map<string, bigint>();
  let buyerFeeRefund = 0n;
  if (V > 0n) {
    const feeRows: ShareRow[] = revealers.map((p) => ({
      accountId: p.accountId,
      num: feePool * p.stake,
      denom: V,
    }));
    feePayouts = apportion(feeRows, feePool);
  } else {
    buyerFeeRefund = feePool;
  }

  const rows: PayoutRow[] = scored.map((p) => ({
    accountId: p.accountId,
    stake: p.stake,
    score: p.score,
    isValidRevealer: p.isValidRevealer,
    basePayout: basePayouts.get(p.accountId) ?? 0n,
    feePayout: feePayouts.get(p.accountId) ?? 0n,
  }));

  const totalBasePayout = rows.reduce((s, r) => s + r.basePayout, 0n);
  const totalFeePayout = rows.reduce((s, r) => s + r.feePayout, 0n);

  return {
    rows,
    totalStake: W,
    totalBasePayout,
    totalFeePayout,
    buyerFeeRefund,
    validRevealerStake: V,
  };
}
