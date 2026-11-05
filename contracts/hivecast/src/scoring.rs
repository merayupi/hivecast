//! Pure scoring and exact pool-allocation arithmetic.
//!
//! This module is deliberately free of `near_sdk` host calls so the exact
//! arithmetic is exercised through the contract's public interface. Monetary
//! units are integer yoctoNEAR (`u128`), probability is basis points
//! (`u16`, `0..=10000`), and scores are on the scale `S = 100_000_000`.
//!
//! # Conservation contract
//!
//! `allocate` floors each exact share and then distributes the remaining
//! yoctoNEAR to the largest fractional remainders (tie-broken by canonical
//! account ID ascending), so the sum of allocated amounts is *exactly* the
//! pool total with no dust left for the operator.

use uint::construct_uint;

// A 256-bit unsigned integer sufficient for the bounded intermediates:
//   base numerator <= 2 * W^2 * S        <= 2 * 10^68  < 2^256
//   fee  numerator <= F * w_i             <= 10^60      < 2^256
construct_uint! {
    pub struct U256(4);
}

/// Score scale. `S = 100_000_000`.
pub const S: u128 = 100_000_000;

/// Maximum probability in basis points (100.00%).
pub const BPS_MAX: u16 = 10_000;

/// Brier-style score for a revealed probability against a binary outcome.
///
/// `s = S - (p - o)^2` where `p` is the forecast in bps and `o` is `0` or
/// `10000` bps. Valid-reveal scores therefore lie in `[0, S]`. A non-reveal
/// or invalid reveal is scored `0` by the caller (this function is only for
/// valid reveals).
pub fn score(prob_bps: u16, outcome: bool) -> u128 {
    let o: i64 = if outcome { BPS_MAX as i64 } else { 0 };
    let p = prob_bps as i64;
    let diff = p - o; // in [-10000, 10000]
    let sq = (diff * diff) as u128; // in [0, 100_000_000]
    S - sq
}

/// A proportional share of a pool, keyed by canonical account ID for the
/// deterministic largest-remainder tie-break.
pub struct Share {
    pub account: String,
    /// Numerator of the exact share `numerator / denom`.
    pub numerator: U256,
}

/// Allocate `total` yoctoNEAR exactly across `shares` proportional to
/// `numerator / denom`.
///
/// Returns `(account, amount)` pairs whose amounts sum to exactly `total`.
///
/// # Panics
///
/// Panics if `denom` is zero, or if any `numerator / denom` exceeds `total`
/// (which would mean the pool is under-funded), or on 256-bit overflow of a
/// numerator.
pub fn allocate(shares: &[Share], denom: U256, total: u128) -> Vec<(String, u128)> {
    assert!(!denom.is_zero(), "allocate: zero denominator");
    assert!(shares.len() <= 64, "allocate: too many shares");

    let denom_u256 = denom;

    // floor_i and remainder_i for every share.
    let mut entries: Vec<(String, u128, U256)> = Vec::with_capacity(shares.len());
    let mut floor_sum: u128 = 0u128;
    for s in shares {
        let (q, r) = s.numerator.div_mod(denom_u256);
        let q128 = q.as_u128();
        // Exact share cannot exceed the pool total by construction.
        assert!(q128 <= total, "allocate: share exceeds pool total");
        floor_sum = floor_sum
            .checked_add(q128)
            .expect("allocate: floor sum overflow");
        entries.push((s.account.clone(), q128, r));
    }

    assert!(
        floor_sum <= total,
        "allocate: floored shares exceed pool total"
    );
    let remainder = total - floor_sum;

    // Distribute `remainder` single yoctoNEAR to the largest fractional
    // remainders; ties broken by canonical account ID ascending.
    // Sort ascending by account first, then stable-sort descending by
    // remainder so equal remainders keep account-ascending order.
    entries.sort_by(|a, b| a.0.cmp(&b.0)); // account ascending first
    entries.sort_by(|a, b| b.2.cmp(&a.2)); // then remainder descending (stable)

    let mut result: Vec<(String, u128)> = Vec::with_capacity(entries.len());
    for (idx, (account, q128, _r)) in entries.iter().enumerate() {
        let mut amount = *q128;
        if (idx as u128) < remainder {
            amount += 1;
        }
        result.push((account.clone(), amount));
    }

    debug_assert_eq!(
        result.iter().map(|(_, a)| *a).sum::<u128>(),
        total,
        "allocate: conservation violated"
    );

    result
}

/// Compute base-wagering numerators from accepted participants.
///
/// `participants` is `(account, stake, score)` for every accepted commitment;
/// a participant without a valid reveal must be passed `score = 0`.
///
/// Returns `(W, A, shares)` where:
///   `W = sum(stake)`
///   `A = sum(stake * score)`
///   `share.numerator = stake_i * (W*S + W*score_i - A)`
///
/// # Panics
/// Panics if the total stake `W` overflows `u128` or exceeds the imposed
/// 1e30 cap, or if `A` overflows `u128`.
pub fn base_numerators(
    participants: &[(String, u128, u128)],
    max_total_stake: u128,
) -> (u128, u128, Vec<Share>) {
    let mut w: u128 = 0u128;
    let mut a: u128 = 0u128;
    for (_, stake, s) in participants {
        w = w.checked_add(*stake).expect("base: W overflow");
        let term = stake
            .checked_mul(*s)
            .expect("base: w*s overflow");
        a = a.checked_add(term).expect("base: A overflow");
    }
    assert!(w <= max_total_stake, "base: W exceeds cap");

    let ws = w.checked_mul(S).expect("base: W*S overflow");
    let mut shares: Vec<Share> = Vec::with_capacity(participants.len());
    for (account, stake, s) in participants {
        // (W*S + W*s_i - A) is in [0, 2e38] and fits u128; proven non-negative
        // because A <= W*S.
        let w_si = w.checked_mul(*s).expect("base: W*s overflow");
        let bracket = ws
            .checked_add(w_si)
            .and_then(|v| v.checked_sub(a))
            .expect("base: bracket underflow/overflow");
        let numerator = U256::from(*stake) * U256::from(bracket);
        shares.push(Share {
            account: account.clone(),
            numerator,
        });
    }
    (w, a, shares)
}

/// Compute Query-Fee numerators for valid revealers only.
///
/// `valid` is `(account, stake)` for each valid revealer. Returns `(V,
/// shares)` where `V = sum(stake)` over valid revealers and
/// `share.numerator = fee_pool * stake_i`.
///
/// If `V == 0` the fee pool is refundable to buyers instead (handled by the
/// caller); this function returns an empty share list in that case.
pub fn fee_numerators(valid: &[(String, u128)], fee_pool: u128) -> (u128, Vec<Share>) {
    let v: u128 = valid.iter().map(|(_, stake)| *stake).sum();
    if v == 0 {
        return (0, Vec::new());
    }
    let shares: Vec<Share> = valid
        .iter()
        .map(|(account, stake)| Share {
            account: account.clone(),
            numerator: U256::from(fee_pool) * U256::from(*stake),
        })
        .collect();
    (v, shares)
}
