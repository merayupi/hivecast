//! Canonical, versioned commitment encoding.
//!
//! An agent's Commitment is a SHA-256 over a length-framed (Borsh-style)
//! byte string binding the forecast to its exact context. Because every
//! variable-length field is explicitly length-prefixed and every numeric field
//! has a fixed little-endian width, the encoding is unambiguous: a commitment
//! produced for one contract/question/account/stake/probability/salt can never
//! collide with, or be replayed against, a different context.
//!
//! # Byte layout (serialized in this exact order)
//!
//! All multi-byte integers are little-endian. All length prefixes are
//! unsigned 32-bit little-endian counts of *bytes*.
//!
//! | field           | encoding                                    |
//! |-----------------|---------------------------------------------|
//! | `domain`        | u32 LE byte length + UTF-8 bytes             |
//! | `version`       | u32 LE                                      |
//! | `contract_id`   | u32 LE byte length + UTF-8 bytes             |
//! | `question_id`   | u64 LE                                      |
//! | `account_id`    | u32 LE byte length + UTF-8 bytes             |
//! | `stake_yocto`   | u128 LE (16 bytes)                          |
//! | `prob_bps`      | u32 LE                                       |
//! | `salt`          | u32 LE byte length + raw bytes               |
//!
//! `domain` is the ASCII string `"hivecast"` and `version` is `1`. The
//! TypeScript runner must produce byte-identical input (e.g. using the `borsh`
//! package or a hand-rolled writer) before SHA-256 hashing.

use near_sdk::borsh::BorshSerialize;

/// Domain tag binding every commitment to the HiveCast protocol.
pub const DOMAIN: &str = "hivecast";

/// Encoding version. Bump only on a deliberately incompatible preimage change.
pub const VERSION: u32 = 1;

/// Canonical preimage struct. Serialization order is significant and must not
/// be reordered without bumping [`VERSION`].
#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct CommitmentPreimage<'a> {
    pub domain: &'a str,
    pub version: u32,
    pub contract_id: &'a str,
    pub question_id: u64,
    pub account_id: &'a str,
    pub stake_yocto: u128,
    pub prob_bps: u32,
    pub salt: Vec<u8>,
}

/// Build the exact preimage bytes for a commitment.
pub fn commitment_preimage(
    contract_id: &str,
    question_id: u64,
    account_id: &str,
    stake_yocto: u128,
    prob_bps: u32,
    salt: &[u8],
) -> Vec<u8> {
    let img = CommitmentPreimage {
        domain: DOMAIN,
        version: VERSION,
        contract_id,
        question_id,
        account_id,
        stake_yocto,
        prob_bps,
        salt: salt.to_vec(),
    };
    near_sdk::borsh::to_vec(&img).expect("commitment preimage serialization is infallible")
}

/// Compute the SHA-256 commitment hash for a context and secret salt.
///
/// This uses the NEAR runtime's `sha256` host function and is therefore only
/// callable on-chain or under the `unit-testing` mock environment.
pub fn commitment_hash(
    contract_id: &str,
    question_id: u64,
    account_id: &str,
    stake_yocto: u128,
    prob_bps: u32,
    salt: &[u8],
) -> [u8; 32] {
    let img = commitment_preimage(contract_id, question_id, account_id, stake_yocto, prob_bps, salt);
    let digest = near_sdk::env::sha256(&img);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Encode bytes as lowercase hex.
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Decode lowercase/uppercase hex into bytes; returns `None` on malformed
/// input or an odd number of characters.
pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for chunk in bytes.chunks(2) {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
