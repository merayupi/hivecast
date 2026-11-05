# HiveCast Contract Interface

Canonical wire contract for the `hivecast` NEAR contract (`near-sdk 5.5.0`,
Rust). This document is the single source of truth for the TypeScript runner,
dashboard, and any external consumer. It describes the exact commitment
encoding, every public call/view JSON contract, and every emitted event.

Every value in this document is in JSON form unless stated otherwise. All
timestamps are **UTC nanoseconds** and all monetary amounts are **yoctoNEAR**
(`1 Ⓝ = 1e24` yoctoNEAR). Per the spec, every monetary amount and every
timestamp crosses the JSON boundary as a **decimal string** — never a JSON
number — so TypeScript must not use `number` for them.

## Table of contents

1. [Protocol constants](#protocol-constants)
2. [Lifecycle phases](#lifecycle-phases)
3. [Commitment encoding](#commitment-encoding)
4. [Change methods](#change-methods)
5. [View methods](#view-methods)
6. [Events](#events)
7. [Authorization matrix](#authorization-matrix)
8. [Build and test](#build-and-test)

## Protocol constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `YOCTO_PER_NEAR` | `1_000_000_000_000_000_000_000_000` (1e24) | yoctoNEAR per NEAR |
| `MAX_TOTAL_STAKE` | `1_000_000_000_000_000_000_000_000_000_000` (1e30 = 1,000,000 Ⓝ) | per-Question cap on total Stake `W` |
| `MAX_FEE_POOL` | 1e30 (1,000,000 Ⓝ) | per-Question cap on Query Fee pool `F` |
| `MAX_PARTICIPANTS` | `64` | max accepted Commitments per Question |
| `DEFAULT_MIN_STAKE` | `100_000_000_000_000_000_000_000` (0.1 Ⓝ) | default minimum Stake |
| `DEFAULT_ACCESS_PRICE` | `10_000_000_000_000_000_000_000` (0.01 Ⓝ) | default Query Fee |
| `BPS_MAX` | `10_000` | max probability (100.00%, basis points) |
| `S` (score scale) | `100_000_000` | Brier score scale |
| `STORAGE_BYTE_COST` | `10_000_000_000_000_000_000` (1e19) | NEAR storage staking per byte |

The contract imposes no *global* minimum stake or access price; `create_question`
sets per-Question `min_stake` and `access_price` within the caps above.

## Lifecycle phases

The `phase` field on a Question is one of:

- `open` — before `close_time`; Commitments accepted only within
  `[open_time, close_time)`.
- `closed` — at/after `close_time` and not yet resolved/cancelled; snapshot
  sales may open.
- `resolved` — an Outcome is recorded; Reveals accepted until `reveal_deadline`.
- `settled` — terminal; payouts allocated.
- `cancelled` — terminal; refunds become claimable.

Schedule validation (`open_time < close_time < observation_start <
observation_end <= resolve_time < resolve_deadline`, `reveal_window > 0`) is
enforced at creation. Terminal/resolved states take precedence over
time-derived closing. All windows are half-open: the *start* boundary is
inclusive and the *end* boundary is exclusive for `commit`, `buy_forecast`,
`resolve`, and `reveal`; `settle` and timeout `cancel` accept their deadline
boundary.

## Commitment encoding

A Commitment is `SHA-256(preimage)`. The preimage is a **Borsh 1.x** encoding
(`#[borsh(crate = "near_sdk::borsh")]`), serialized field-by-field in this
exact order. Every variable-length field is length-framed with a **u32
little-endian byte count**; every integer is fixed-width little-endian.

| offset | field | encoding |
| --- | --- | --- |
| 0 | `domain` | u32 LE byte length + UTF-8 bytes (`"hivecast"`) |
| … | `version` | u32 LE (`1`) |
| … | `contract_id` | u32 LE byte length + UTF-8 bytes |
| … | `question_id` | u64 LE |
| … | `account_id` | u32 LE byte length + UTF-8 bytes |
| … | `stake_yocto` | u128 LE (16 bytes) |
| … | `prob_bps` | u32 LE |
| … | `salt` | u32 LE byte length + raw bytes |

Borsh's `String`/`&str` and `Vec<u8>` both use a u32 byte-length prefix; `u32`
and `u64` are little-endian; `u128` is 16 bytes little-endian. The TypeScript
runner must reproduce this byte-for-byte. Using the `@near-js/borsh` package
(or the `borsh` npm package) with a struct whose fields are
`('domain', 'string'), ('version', 'u32'), ('contract_id', 'string'),
('question_id', 'u64'), ('account_id', 'string'), ('stake_yocto', 'u128'),
('prob_bps', 'u32'), ('salt', Vec<u8>)` produces byte-identical output, then
hash with SHA-256.

The **salt is generated client-side with a CSPRNG before submitting the
commitment** and stored durably by the runner. The contract never learns the
salt or the probability until Reveal; it only stores the hash. The commit hash
is context-bound: a different contract ID, Question ID, account, stake,
probability, or salt produces a different hash, so a commitment copied to
another context cannot validate.

`commit` receives the hash as a **64-character lowercase hex** string.

## Change methods

All change methods are invoked by the signer account unless stated otherwise.
`#[payable]` methods accept an attached deposit; non-payable methods reject any
deposit.

### `new` (init)

```
args: { "operator": "<account_id>" }
```

Initializes the contract with the Operator account. Only callable once.

### `create_question` (Operator only)

```
args: {
  "text": string,             // 1..2048 bytes
  "event_definition": string, // 1..2048 bytes
  "source": string,           // 1..512 bytes
  "resolver": string,         // account id
  "open_time": string,        // ns
  "close_time": string,       // ns
  "observation_start": string,// ns
  "observation_end": string,  // ns
  "resolve_time": string|null,// ns; null defaults to observation_end
  "resolve_deadline": string, // ns
  "reveal_window": string,    // ns, > 0
  "access_price": string,     // yoctoNEAR
  "min_stake": string         // yoctoNEAR, > 0
}
returns: question_id (u64, JSON number)
```

Rules are immutable through the normal API after creation.

### `commit` (payable)

```
args: { "question_id": number, "hash": "64-char hex" }
attached deposit: stake in yoctoNEAR (must be >= min_stake)
```

One final Commitment per account per Question. Rejects duplicate, below-minimum
stake, wrong phase/window, participant cap (64), and total-stake cap.

### `publish_snapshot` (Operator only)

```
args: { "question_id": number, "snapshot_id": string }
```

Marks the Forecast Snapshot ready and publishes its stable identity. Requires
cutoff reached, observation not started, and a nonempty participant set. The
snapshot identity is public metadata, not proof of correct aggregation.

### `buy_forecast` (payable)

```
args: { "question_id": number }
attached deposit: access_price (must exactly equal the Question's price)
```

Exactly-once purchase. Rejects under/overpayment, duplicate purchase, missing
snapshot readiness, wrong phase/window, empty round, and fee-pool cap.

### `resolve` (resolver only)

```
args: { "question_id": number, "outcome": boolean }
```

Records the single final Outcome in `[resolve_time, resolve_deadline)`. Sets
`reveal_deadline = resolved_at + reveal_window`.

### `reveal`

```
args: { "question_id": number, "prob_bps": number, "salt": string }
```

`prob_bps` is an integer `0..=10000`. The signer must be the bound participant;
the recomputed commitment hash must match exactly; only accepted once and only
before `reveal_deadline`.

### `settle` (permissionless)

```
args: { "question_id": number }
```

Settles after `reveal_deadline`. Computes exact base (Brier/weighted-score)
and Query-Fee allocations with largest-remainder distribution, crediting each
owner's Claimable Balance. Never pushes per-account transfers.

### `cancel` (permissionless)

```
args: { "question_id": number }
```

Cancels a Round with zero commitments after `close_time`, or after
`resolve_deadline` without an Outcome. Credits stake refunds; makes buyer fee
refunds eligible (claimed per-receipt via `claim_buyer_refund`).

### `claim_buyer_refund`

```
args: { "question_id": number }
```

Per-owner, exactly-once refund of the buyer's Query Fee when the Round is
cancelled or settled with zero valid Revealers. Does not scan all buyers.

### `withdraw`

```
args: { "amount": string }   // yoctoNEAR, must be <= claimable balance
```

Debits claimable into pending, records a unique nonce, and issues an
asynchronous NEAR transfer. Returns no JSON value (fires a promise).

### `on_withdraw_callback` (private)

```
args: { "nonce": number }
```

Private callback confirming the transfer. On success marks `delivered`
(pending → received); on failure restores `claimable`. Runs in O(1).

## View methods

All view methods are read-only. `from_index`/`limit` are JSON numbers; `limit`
is clamped to `1..=100` (or `1..=64` for commitments).

### `get_contract_state`

```
returns: {
  "operator": string,
  "next_question_id": number,
  "next_nonce": number,
  "question_count": number
}
```

### `get_question`

```
args: { "question_id": number }
returns: Question | null
```

`Question`:

```json
{
  "question_id": number,
  "text": string,
  "event_definition": string,
  "source": string,
  "resolver": string,
  "open_time": string,
  "close_time": string,
  "observation_start": string,
  "observation_end": string,
  "resolve_time": string,
  "resolve_deadline": string,
  "reveal_window": string,
  "access_price": string,
  "min_stake": string,
  "phase": "open" | "closed" | "resolved" | "settled" | "cancelled",
  "outcome": boolean | null,
  "resolved_at": string | null,
  "reveal_deadline": string | null,
  "snapshot_ready": boolean,
  "snapshot_id": string | null,
  "total_stake": string,
  "fee_pool": string,
  "participant_count": number,
  "buyer_count": number
}
```

### `list_questions`

```
args: { "from_index": number, "limit": number }
returns: Question[]
```

Sorted ascending by `question_id`.

### `get_commitment`

```
args: { "question_id": number, "account_id": string }
returns: Commitment | null
```

```json
{
  "question_id": number,
  "account_id": string,
  "stake": string,
  "hash": string,          // 64-char hex
  "revealed": number | null // prob_bps, null if not revealed
}
```

Note: `revealed` exposes the *already revealed* public probability; an
unrevealed commitment is only represented by its hash (never the probability
or an unsalted low-entropy hash).

### `list_commitments`

```
args: { "question_id": number, "from_index": number, "limit": number }
returns: Commitment[]
```

### `has_bought`

```
args: { "question_id": number, "account_id": string }
returns: boolean
```

### `get_buyer_receipt`

```
args: { "question_id": number, "account_id": string }
returns: { "question_id": number, "account_id": string, "price": string, "refunded": boolean } | null
```

### `list_buyers`

```
args: { "question_id": number, "from_index": number, "limit": number }
returns: BuyerReceipt[]
```

### `get_balance`

```
args: { "account_id": string }
returns: {
  "account_id": string,
  "claimable": string,
  "pending": string,
  "received": string
}
```

`claimable` = entitlement not yet withdrawn; `pending` = in-flight transfer;
`received` = delivered. Settlement/cancellation is not proof of received funds.

### `get_pending_withdrawal`

```
args: { "nonce": number }
returns: { "nonce": number, "account_id": string, "amount": string, "status": "pending" | "delivered" | "restored" } | null
```

### `list_pending_withdrawals`

```
args: { "account_id": string, "from_index": number, "limit": number }
returns: PendingWithdrawal[]
```

## Events

NEP-297 JSON, standard `"hivecast"`, version `"1.0.0"`. The `event` field is the
event name and `data` is an array of one payload object.

| event | payload fields |
| --- | --- |
| `question_created` | `question_id`, `resolver`, `access_price`, `min_stake` |
| `commitment_made` | `question_id`, `account_id`, `stake`, `hash` |
| `snapshot_published` | `question_id`, `snapshot_id` |
| `forecast_bought` | `question_id`, `account_id`, `price` |
| `outcome_resolved` | `question_id`, `outcome` |
| `forecast_revealed` | `question_id`, `account_id`, `prob_bps` |
| `settled` | `question_id`, `zero_reveal` |
| `cancelled` | `question_id` |
| `refund_claimed` | `question_id`, `account_id`, `amount` |
| `withdrawal_requested` | `nonce`, `account_id`, `amount` |
| `withdrawal_delivered` | `nonce`, `account_id`, `amount` |
| `withdrawal_restored` | `nonce`, `account_id`, `amount` |

All `amount`/`price`/`stake`/`fee` fields are decimal strings.

## Authorization matrix

| Method | Who may call |
| --- | --- |
| `new` | initializer (once) |
| `create_question` | Operator |
| `commit` | any signer (in window) |
| `publish_snapshot` | Operator |
| `buy_forecast` | any signer (in window) |
| `resolve` | the Question's pinned `resolver` |
| `reveal` | the bound participant |
| `settle` | anyone (after reveal deadline) |
| `cancel` | anyone (when eligible) |
| `claim_buyer_refund` | the buyer (signer) |
| `withdraw` | the owner (signer) |
| `on_withdraw_callback` | private (contract itself) |

## Build and test

WASM (requires `wasm32-unknown-unknown` target):

```sh
RUSTFLAGS='-C link-arg=-s' cargo build --target wasm32-unknown-unknown --release
# artifact: target/wasm32-unknown-unknown/release/hivecast.wasm
```

Unit/integration tests (Linux; uses the `unit-testing` mock VM):

```sh
cargo test --manifest-path contracts/hivecast/Cargo.toml
```

Sandbox runtime smoke (Linux, `near-workspaces` or `near-sandbox`):

```sh
cargo test --manifest-path contracts/hivecast/Cargo.toml -- --ignored
```

> **Windows note.** The WASM build works on Windows. The host test/sandbox
> build does not: `near-sdk`'s `unit-testing` feature pulls `near-vm-runner`,
> which compiles C (`blst`/`secp256k1`/`zstd`) and links `getrandom` via
> `raw-dylib` (`bcryptprimitives.dll`); this requires a complete mingw-w64
> (`as.exe`/`ar.exe`) or MSVC Build Tools that are not present here. Run the
> tests and gas measurement on Linux (GitHub Actions on the integration
> branch).
