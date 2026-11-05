# NEAR Contract Resource & Payment Feasibility

Scope: feasibility of the HiveCast smart contract on NEAR, specifically `near-sdk = "5.5.0"` as pinned in `HIVECAST_PLAN.md`. Primary sources only; material claims are cited. Local toolchain figures below are *observed* command output (read-only), not inference.

## 1. Local toolchain (observed)

Ran read-only version probes (`rustc`, `cargo`, `rustup`, `node`, `npm`, `rustup target list --installed`). No build, install, or lint was run.

```
rustc 1.96.0 (ac68faa20 2026-05-25)
cargo 1.96.0 (30a34c682 2026-05-25)
rustup 1.29.0 (28d1352db 2026-03-05)   # toolchain-manager version, not compiler
node v24.14.1
npm 8.19.2
wasm32-unknown-unknown                  # present in `rustup target list --installed`
```

`cargo 1.96.0` and `wasm32-unknown-unknown` are both present, which is *consistent with* the plan's `cargo build --target wasm32-unknown-unknown --release` path (`cargo-near` not installed). This is a version-presence observation only — it does **not** prove the contract builds on this toolchain, because no build was run (out of scope). Note `npm 8.19.2` alongside Node 24 is an unusual pairing (npm 8 ships with Node 16/18) — reported as observed only, not diagnosed.

### SDK build requirement (not speculation)

- `near-sdk` 5.5.0's own manifest (`Cargo.toml.orig`, docs.rs 5.5.0) declares `edition = "2021"` and **no `rust-version` / MSRV field**. The 5.5.0 workspace `Cargo.toml` likewise declares only `version = "5.5.0"` (no MSRV). Source: https://docs.rs/crate/near-sdk/5.5.0/source/Cargo.toml.orig and https://github.com/near/near-sdk-rs/blob/near-sdk-v5.5.0/Cargo.toml
- The 5.0.0 release notes state the then-minimum supported Rust was "1.68" (buildkite note, PR #1014).
- **Conclusion (inference, not build-verified):** the pin declares no explicit `rust-version`/MSRV, so there is no *documented* minimum that local `1.96.0` violates. Absence of an MSRV field is **not** proof that 5.5.0 compiles on a newer Rust (a newer toolchain can still break an old SDK), and no build was run. Treat "should compile" as inference only; confirm by building (out of scope here). `cargo-near` is not required by the SDK itself.

## 2. Storage staking obligation (hard, protocol-enforced)

- NEAR uses **storage staking**: "the account that owns a smart contract must stake (or lock) tokens according to the amount of data stored in that smart contract." A call that adds state fails if the contract account lacks the balance to cover the new storage. Source: https://docs.near.org/protocol/storage/storage-staking
- Protocol check (nearcore Economics spec): `requiredAmount = sizeOf(account) * storageAmountPerByte`; a transaction fails if `account.amount + account.locked < requiredAmount`. Source: https://github.com/near/nearcore/blob/master/docs/Economics/Economics.md
- Price: **`1E19` yoctoNEAR per byte = `1 Ⓝ` per 100 KB** (`100kb per NEAR`). The runtime constant in `near-sdk` 5.5.0 is exactly `NearToken::from_yoctonear(10_000_000_000_000_000_000)` (`env::storage_byte_cost()`). Sources: https://docs.near.org/protocol/storage/storage-staking ; near-sdk 5.5.0 `src/environment/env.rs` L998-999.
- Every key-value record carries a fixed **+40 bytes** overhead (`storage_num_extra_bytes_record`) on top of key+value bytes. Source: https://docs.near.org/protocol/storage/storage-staking

### Can attached deposit be 100% wager principal with no storage reserve?

**Not by default — it depends on who funds the contract.** The protocol does not force the deposit itself to be split; it forces the *contract account* to hold `storage_usage × 1E19 yocto` at all times. Two consistent designs:

1. **Pre-funded contract (operator capitalizes the contract).** The contract account always carries enough NEAR to cover all accrued commitment/ledger/question storage. Then every attached deposit can be treated as pure wager principal and paid out in full at settlement/cancellation.
2. **No pre-funding.** Each `commit`/`buy_forecast` adds a new key (commitment record, buyer record), raising `storage_usage`. The contract must then *carve out* a storage reserve from the attached deposit (NEP-145 `storage_deposit` pattern) that is **not** part of the stake and is refundable only when the data is removed. Otherwise the call reverts with insufficient-storage balance.

This is a product/policy fork (operator-funded vs user-funded storage), **not chosen here**. The hard constraint is: the contract balance must always cover its storage; the "all deposit = principal" plan is only valid under fork (1). Source: https://docs.near.org/smart-contracts/security/storage

## 3. Storage-cost accounting (buyers / agents / questions)

Rate: `1E19` yocto/byte + `40` bytes/record. (https://docs.near.org/protocol/storage/storage-staking)

Order-of-magnitude, computed from the cited rate (not a measured figure):

- **Per agent commitment** (map key ≈ prefix + `question_id` (8 B) + `AccountId` (≤64 B); value ≈ borsh Commit {hash 32 B, stake 16 B, version}). ~130–200 bytes → **~0.0013–0.002 Ⓝ**.
- **Per question** (key = `question_id`; value = Question struct with `text: String`). Dominated by the question text. `text` is stored in a *value*, which is allowed up to **4 MiB**, but a *key* is capped at **2 KiB** — keep the question key numeric (u64) and the text as a value, and bound text length. Source for key/value caps: https://docs.near.org/smart-contracts/security/cross-contract-calls/callback-failures
- **Per buyer record** (`has_bought` map): one small key → similar ~0.001–0.002 Ⓝ.

Reference point from the standard: a fungible-token balance entry costs `0.00235 Ⓝ` to register (NEP-145 worked example), i.e. `2350000000000000000000` yocto. Source: https://github.com/near/NEPs/blob/master/neps/nep-0145.md

Guidance: use Borsh (near-sdk default) rather than JSON strings for on-chain data to cut bytes/gas; use `env::storage_usage()` before/after a write to measure exact bytes and charge accordingly (the documented pattern). Source: https://docs.near.org/smart-contracts/security/storage

## 4. Gas limits & bounded settlement

- A single transaction may attach at most **1 PGas (1,000 TGas)** total across all its function-call actions; a chunk burns at most **1000 TGas**; per function call max is **1000 TGas**. Transferring NEAR costs **0.45 TGas**. Source: https://docs.near.org/protocol/transactions/gas
- Signed transaction size limit: **1.5 MiB** (includes args). Source: https://docs.near.org/protocol/transactions/transaction-anatomy
- `settle(question_id)` iterates all revealed agents to compute payouts. This loop must fit inside one function call's gas. Two concrete SDK facts make unbounded loops a real risk:
  - `near_sdk::store::UnorderedMap`/`UnorderedSet` are **deprecated** because "iteration over a collection of more than 2k elements runs out of gas" (5.0.0 release notes, PR #1139). Use `IterableMap`/`IterableSet` (added in 5.2.0, PR #1164) for large, iterated collections.
  - Source: https://github.com/near/near-sdk-rs/blob/master/CHANGELOG.md (5.0.0 and 5.2.0 entries)
- Bounded settlement strategies: cap agents per question, or split `settle` into paged steps. The plan describes 8 agent personas; whether participants are capped at all is an open product choice (see §9), so `settle` must be gas-bounded regardless of that choice.

## 5. Asynchronous transfers & pull-claim ledger

- Cross-contract/NEAR transfers are **asynchronous** (`Promise` receipts). A callback "always runs, but it can still fail"; a failed callback reverts *only its own* state changes, leaving earlier committed changes (e.g., a credited balance) in place. Out-of-gas in the callback, a deleted/insufficient target, or a panic all produce this half-done state. Source: https://docs.near.org/smart-contracts/security/cross-contract-calls/callback-failures
- **Implication for `settle`:** pushing one `Promise` transfer per agent inside `settle` makes payouts fragile — a single failed transfer (e.g., an agent account deleted) strands funds or leaves the ledger inconsistent.
- **Pull/claim ledger — design recommendation, not a protocol requirement.** On `settle`, write each agent's payout into a **claim ledger** (map `account_id → claimable yoctoNEAR`) and let agents call `claim()` to withdraw. This is the documented "provide a way to settle stuck operations later" approach (debit first, then transfer). The protocol itself does not mandate a ledger; it only exposes the callback-failure behavior above, so push-per-agent transfers in `settle` are legal but fragile. Source: https://docs.near.org/smart-contracts/security/cross-contract-calls/callback-failures
- Same pattern applies to **cancellation refunds** (stake + buyer fee). Note deleting records to free storage balance also costs gas and is bounded per transaction (an upper limit on how much data can be deleted in one transaction). Source: https://docs.near.org/protocol/storage/storage-staking

## 6. Integer ranges for yoctoNEAR × squared scores / totals

Units: `1 Ⓝ = 1e24` yoctoNEAR; balances are `u128` (`u128::MAX ≈ 3.4e38`). Plan scale: score `s ∈ [0, 10^8]`, `p, o ∈ [0, 10^4]` so `(p−o)² ≤ 10^8`. Source for units: https://github.com/near/nearcore/blob/master/docs/Economics/Economics.md

Notation: `w_i = stake_i`, `W = Σ w_j`, `A = Σ w_j·s_j`, `S = 10^8`.

**Base wagering payout — exact form (no rounded mean).** The budget-balanced weighted-score payout is:

`payout_i = w_i · (W·S + W·s_i − A) / (W·S)`

This is algebraically identical to `w_i · (S + s_i − s̄)/S` with `s̄ = A/W`; writing it in the exact form keeps `s̄` rational and avoids rounding the mean before the `(S + s_i − s̄)` term (which would break conservation). The dominant intermediate is the numerator `w_i · (W·S + W·s_i − A)`.

| Expression | Max magnitude (N≈100, w_i≈10^26) | Fits u128 (3.4e38)? |
|---|---|---|
| `W·S`, `W·s_i`, `A` | `~10^36` | ✅ |
| **base numerator `w_i·(W·S + W·s_i − A)`** | `10^26 × 10^36 = 10^62` | ❌ **overflows u128** |
| `w_i·s_i` | `10^26 × 10^8 = 10^34` | ✅ |
| **fee numerator `fee_pot·w_i`** | `10^25 × 10^26 = 10^51` | ❌ **overflows u128** |

**Fee share (agreed formula, supersedes the score-weighted one in the plan).** The agreed distribution is pro-rata stake among *valid revealers only*:

`fee_share_i = fee_pot · w_i / V`, where `V = Σ w_j` over valid revealers.

(The plan's earlier `fee_pot · (w_i·s_i) / Σ(w_j·s_j)` is **superseded** by the agreed pro-rata-stake form and is retained here only as a historical record.) The intermediate `fee_pot · w_i` overflows `u128` at essentially any realistic scale: even `1 Ⓝ` of stake (`10^24`) × `0.01 Ⓝ` of fee pot (`10^22`) is `10^46`, already above `3.4e38`. So the agreed formula requires 256-bit math regardless of the chosen bounds.

**`near-sdk` 5.5.0 has no `U256`.** `near_sdk::json_types` exports only `U128`, `U64`, `I128`, `I64`; there is no `U256`/`I256` in the crate. Source: near-sdk 5.5.0 `src/json_types/mod.rs` L10 and `src/json_types/integers.rs` (whole file). Implementation must either add a 256-bit integer dependency (e.g. `primitive-types::U256`) or do manual widening multiply / remainder-aware integer math. Do **not** reorder to `fee_pot / V` first — for realistic `fee_pot ≪ V` that truncates the share to 0.

**`U256` is not sufficient on its own — explicit input/total bounds are required.** A 256-bit intermediate only fits when the factors are bounded. With *unconstrained* `u128` stakes and participant counts, `w_i·(W·S + W·s_i − A)` (and `fee_pot·w_i` where `fee_pot` itself can grow) exceed even 256 bits. So: either (a) bound the inputs the contract accepts — max stake per commit, max agents per question, max fee pot — and then prove each product fits 256 bits, or (b) avoid the wide product entirely via scaling the stake and score into fixed-point sub-units. The bounded-input route is the simpler one; the bounds themselves are a product choice (§9), not a given.

**Exact conservation.** The agreed `Σ payout_i = Σ stake_i + fee_pot` requires distributing the integer-division remainder explicitly across accounts; naive per-agent floor division leaks or double-counts yocto. This remainder accounting sits on top of whichever 256-bit strategy is chosen above.


## 7. View methods & pagination

- View methods do not charge the caller for gas, but are still executed under a gas bound and a return-payload bound. Runtime limits that constrain views/returns: a contract can return up to **4 MiB**; at most **100 logs** and **16 KiB** of logs per call; storage keys ≤ **2 KiB**, values ≤ **4 MiB**. Source: https://docs.near.org/smart-contracts/security/cross-contract-calls/callback-failures
- `get_leaderboard() -> Vec<AgentLeaderboardView>` returning the full leaderboard in one view can exceed gas/return bounds as agent count grows. Use `from_index`/`limit` pagination, and back it with an **iterable** collection (`IterableMap`/`UnorderedMap`), since `LookupMap` is not iterable. Avoid the deprecated `store::UnorderedMap` for large sets (see §4).

## 8. near-sdk 5.x API deltas that touch the plan's pseudocode

From the 5.0.0 release notes (https://github.com/near/near-sdk-rs/blob/master/CHANGELOG.md):

- `env::attached_deposit()`, `env::account_balance()` return **`NearToken`**, not `u128`; `env::prepaid_gas()` returns **`Gas`**. `commit` should read `env::attached_deposit().as_yoctonear()` for the stake amount.
- `AccountId` is the `near-account-id` type (not a `String` alias).
- Borsh 1.0.0: derives need `#[borsh(crate = "near_sdk::borsh")]` (or the `#[near(serializers=[borsh])]` attribute macro).

These are API-shape changes, not build blockers.

## 9. Summary of hard constraints vs open choices

**Hard (protocol/SDK), must design around:**
1. Contract balance must cover `storage_usage × 1E19 yocto/byte`; enforced per-call (§2).
2. "All deposit = wager principal" only valid if the contract is pre-funded; otherwise a storage reserve/deposit is required (§2).
3. Both the base-payout numerator `w_i·(W·S + W·s_i − A)` (~10^62) and the agreed fee numerator `fee_pot·w_i` (~10^51) overflow u128; `near-sdk` 5.5.0 has no `U256`, and a 256-bit intermediate only suffices with explicit bounds on stake/count/fee-pot (§6).
4. `settle`/view loops must be gas-bounded; use `IterableMap`, avoid deprecated `UnorderedMap` for >2k elements (§4, §7).
5. Callbacks can fail and revert only their own state, so push-per-agent transfers in `settle` are fragile; the pull-claim ledger is a **design recommendation**, not a protocol requirement (§5).

**Open (product policy — deliberately not chosen here):**
- Operator pre-funds storage vs user-paid storage deposits (NEP-145).
- Fee pot size / minimum fee vs storage cost for `buy_forecast` records.
- Participant cap (and thus whether `settle` needs paging), plus any max stake / max fee-pot bounds needed to make §6's 256-bit math safe.
- Reveal-window length and cancellation-timeout policy (stated in plan/glossary; not re-derived here).
